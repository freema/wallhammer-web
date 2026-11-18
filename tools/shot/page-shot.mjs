// Pictures of an example page in Docker: headless Chromium of the `wallhammer-web-shot:1` image (Dockerfile
// next to this file) against the running `dev` service. Runs as the `shot` service (docker-compose.yml, profile tools):
//
//   docker compose run --rm shot --url http://dev:5281/planet/ --hash 'strip=1' --presets strip-orbit,strip-900m
//   docker compose run --rm shot --url http://dev:5281/endless/ --hash 'strip=1&...' --presets @hash --size 1280x720
//
// --url       the page, http://dev:5281/<example>/ (the compose service name is resolved to its address: the dev
//             server answers only to localhost and to plain addresses)
// --hash      the part of the address after #
// --presets   names of `__wh.presets()`, comma separated; `@hash` takes the view the page started in from its hash
// --size      picture size, default 1600x900
// --name      prefix of the file names (default: none); files are <prefix><preset>.png in /out
// --timeout   how long the page may take to load and each view to settle, in ms (default 600000); a view that does
//             not settle in time is shot as it is and marked `NOT settled`
//
// The page must provide `window.__wh` with `ready`, `presets()` and `setView(view)`; `settled()` is awaited when the
// page has it, otherwise two frames are. Every console error and exception of the page is printed. WebGL2 runs on the
// software renderer (SwiftShader): slow, and independent of the host's graphics card. Frame times measured here say
// nothing about a real graphics card.
// Last line: `shot: N pictures, M page errors`.

import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const URL_ARG = arg('url', 'http://dev:5281/planet/');
const HASH = arg('hash', '');
const PRESETS = arg('presets', '@hash').split(',').filter(Boolean);
const [W, H] = arg('size', '1600x900').split('x').map(Number);
const PREFIX = arg('name', '');
const OUT = process.env.SHOT_OUT ?? '/out';
/** How long the page may take to load and to settle a view, in ms. The software renderer is slow. */
const TIMEOUT = Number(arg('timeout', '600000'));

if (!(W > 0 && H > 0)) {
  console.error(`shot: bad --size ${arg('size', '')}`);
  process.exit(1);
}

/** The address with the host name replaced by its IPv4 address. */
async function resolveUrl(text) {
  const url = new URL(text);
  if (url.hostname !== 'localhost' && net.isIP(url.hostname) === 0) {
    const { address } = await dns.lookup(url.hostname, { family: 4 });
    url.hostname = address;
  }
  return url;
}

let url;
try {
  url = await resolveUrl(URL_ARG);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`shot: the page ${URL_ARG} does not answer (${e instanceof Error ? e.message : String(e)}).`);
  console.log('shot: 0 pictures, 1 page errors');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--disable-dev-shm-usage',
    `--unsafely-treat-insecure-origin-as-secure=${url.origin}`,
  ],
});

const errors = [];
let pictures = 0;
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[exception] ${e.message}`));
  await page.goto(HASH ? `${url.href}#${HASH}` : url.href, { waitUntil: 'load', timeout: TIMEOUT });
  // On its first load the dev server may bundle dependencies and reload the page by itself. Hence a few attempts.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForFunction(() => window.__wh !== undefined, undefined, { timeout: TIMEOUT });
      await page.evaluate(
        (ms) => Promise.race([window.__wh.ready, new Promise((_, no) => setTimeout(() => no(new Error(`__wh.ready not resolved in ${ms} ms`)), ms))]),
        TIMEOUT,
      );
      break;
    } catch (e) {
      if (attempt >= 3 || !/context|navigat/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas#view { visibility: visible !important; }' });
  const names = await page.evaluate(() => window.__wh.presets().map((v) => v.name));
  for (const name of PRESETS) {
    const t0 = Date.now();
    if (name !== '@hash' && !names.includes(name)) {
      errors.push(`[shot] no preset ${name} (the page has ${names.join(', ')})`);
      continue;
    }
    const info = await page.evaluate(
      async ([n, ms]) => {
        const wh = window.__wh;
        if (n !== '@hash') wh.setView(wh.presets().find((v) => v.name === n));
        const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
        const late = new Promise((r) => setTimeout(() => r(false), ms));
        const settled = await Promise.race([typeof wh.settled === 'function' ? wh.settled() : frames(), late]);
        return { settled, hash: typeof wh.hash === 'function' ? wh.hash() : location.hash.slice(1), hud: typeof wh.hud === 'function' ? wh.hud() : '' };
      },
      [name, TIMEOUT],
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
    const file = path.join(OUT, `${PREFIX}${name === '@hash' ? 'hash' : name}.png`);
    fs.writeFileSync(file, await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: TIMEOUT }));
    pictures++;
    console.log(`${path.basename(file)}: ${info.settled ? 'settled' : 'NOT settled'}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.log(`  #${info.hash}`);
    if (info.hud) console.log(`  ${info.hud}`);
  }
  await context.close();
} catch (e) {
  errors.push(`[shot] ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
} finally {
  await browser.close();
}
for (const e of errors) console.log(e.split('\n')[0]);
console.log(`shot: ${pictures} pictures, ${errors.length} page errors`);
process.exit(errors.length ? 1 : 0);
