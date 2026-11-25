// Compiles the shaders of the example pages without a graphics card: headless Chromium of the `wallhammer-web-shot:1`
// image on the software renderer, against the running `dev` service. Runs as the `shaders` service
// (docker-compose.yml, profile tools):
//
//   docker compose run --rm shaders                               every example page
//   docker compose run --rm shaders --pages planet,walk           only these
//   docker compose run --rm shaders --pages 'planet#strip=1'      a page with a hash (another set of programs)
//   docker compose run --rm shaders --url http://host:port/page/  any page, not only an example
//
// --base      the server of the examples (default http://dev:5281)
// --pages     example names, comma separated, each optionally with `#hash`; default: every example the server lists
// --url       one page by its whole address instead of --pages
// --timeout   how long a page may take to load, in ms (default 300000)
// --wait      how long to wait after the page is ready (or failed) before the programs are checked, in ms (default
//             1500): programs made in the first frames are then included
//
// The engine checks a program only on its first use, so a broken shader of a program that a page makes but does not
// draw stays silent in the browser. This tool does not rely on the page: before the page's scripts run it wraps the
// WebGL2 calls that make programs, and after the load it asks the context for the compile and link status of every
// program made, used or not. It therefore works for any page, and also when the page itself throws on the way.
//
// Limits: only the programs a page makes with the options it starts with are seen (a program made later, by a key or
// a mode, needs a `#hash` that turns it on); contexts made in workers are not seen; the translator that validates GLSL
// is the one of every Chromium, but a fault of one graphics driver's own compiler cannot show here.
// Last line: `shaders: N programs on M pages, K failed, E page errors`; exit code 1 when K or E is not 0.

import dns from 'node:dns/promises';
import net from 'node:net';
import { chromium } from 'playwright-core';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const BASE = arg('base', 'http://dev:5281');
const PAGES = arg('pages', '');
const URL_ARG = arg('url', '');
const TIMEOUT = Number(arg('timeout', '300000'));
const WAIT = Number(arg('wait', '1500'));

/** The address with the host name replaced by its IPv4 address (the dev server answers only to plain addresses). */
async function resolveUrl(text) {
  const url = new URL(text);
  if (url.hostname !== 'localhost' && net.isIP(url.hostname) === 0) {
    const { address } = await dns.lookup(url.hostname, { family: 4 });
    url.hostname = address;
  }
  return url;
}

/**
 * Runs in the page before its scripts. Keeps every program a WebGL2 context links, with its shaders and their
 * sources, and offers `__whShaderAudit()`, which reads the status of them all.
 */
function installAudit() {
  const P = WebGL2RenderingContext.prototype;
  const sources = new WeakMap();
  const attached = new WeakMap();
  const linked = [];
  const { shaderSource, attachShader, linkProgram } = P;
  P.shaderSource = function (shader, source) {
    sources.set(shader, String(source));
    return shaderSource.call(this, shader, source);
  };
  P.attachShader = function (program, shader) {
    const list = attached.get(program) ?? [];
    list.push(shader);
    attached.set(program, list);
    return attachShader.call(this, program, shader);
  };
  P.linkProgram = function (program) {
    // A program linked again (a restored context) is checked once, in its last state.
    if (!linked.some((l) => l.program === program)) linked.push({ gl: this, program });
    return linkProgram.call(this, program);
  };
  window.__whShaderAudit = () => {
    const out = [];
    for (const { gl, program } of linked) {
      if (gl.isContextLost() || !gl.isProgram(program)) continue;
      const entry = { ok: true, stages: [], link: '' };
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        entry.ok = false;
        entry.link = gl.getProgramInfoLog(program) ?? '';
        for (const shader of attached.get(program) ?? []) {
          if (!gl.isShader(shader) || gl.getShaderParameter(shader, gl.COMPILE_STATUS)) continue;
          entry.stages.push({
            stage: gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.VERTEX_SHADER ? 'vertex' : 'fragment',
            log: gl.getShaderInfoLog(shader) ?? '',
            source: sources.get(shader) ?? '',
          });
        }
      }
      out.push(entry);
    }
    return out;
  };
}

/** The lines of a source that a compile log names (`ERROR: 0:LINE: …`), each with two lines around it. */
function excerpt(source, log) {
  const lines = source.split('\n');
  const named = [...log.matchAll(/^ERROR: \d+:(\d+):/gm)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= lines.length);
  const show = new Set();
  for (const n of named.slice(0, 4)) for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 2); i++) show.add(i);
  return [...show]
    .sort((a, b) => a - b)
    .map((i) => `      ${named.includes(i) ? '>' : ' '}${String(i).padStart(5)}: ${lines[i - 1]}`)
    .join('\n');
}

let targets;
try {
  if (URL_ARG) {
    targets = [{ name: URL_ARG, url: await resolveUrl(URL_ARG) }];
  } else {
    const base = await resolveUrl(BASE);
    let names = PAGES.split(',').filter(Boolean);
    if (names.length === 0) {
      const r = await fetch(base, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      names = [...new Set([...(await r.text()).matchAll(/href="\/?([a-z0-9-]+)\/"/g)].map((m) => m[1]))];
      if (names.length === 0) throw new Error('the index lists no example');
    }
    targets = names.map((n) => {
      const [page, hash] = n.split('#');
      const url = new URL(`/${page}/`, base);
      if (hash) url.hash = hash;
      return { name: n, url };
    });
  }
} catch (e) {
  console.error(`shaders: the server does not answer (${e instanceof Error ? e.message : String(e)}).`);
  console.log('shaders: 0 programs on 0 pages, 0 failed, 1 page errors');
  process.exit(1);
}

const origins = [...new Set(targets.map((t) => t.url.origin))];
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
    `--unsafely-treat-insecure-origin-as-secure=${origins.join(',')}`,
  ],
});

let programs = 0;
let failed = 0;
let pageErrors = 0;
try {
  for (const target of targets) {
    const t0 = Date.now();
    const errors = [];
    // A small view: the pages need not draw much, only make their programs.
    const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript(installAudit);
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[console] ${m.text().split('\n')[0]}`);
    });
    page.on('pageerror', (e) => errors.push(`[exception] ${e.message.split('\n')[0]}`));
    let audit = [];
    try {
      await page.goto(target.url.href, { waitUntil: 'load', timeout: TIMEOUT });
      // On its first load the dev server may bundle dependencies and reload the page by itself. Hence a few attempts.
      for (let attempt = 0; ; attempt++) {
        try {
          // A page that throws while it starts never sets `__wh` or resolves `ready`: its error then ends the wait.
          await Promise.race([
            (async () => {
              await page.waitForFunction(() => window.__wh !== undefined, undefined, { timeout: TIMEOUT });
              await page.evaluate(() => Promise.race([window.__wh.ready, new Promise((r) => setTimeout(r, 120000))]).catch(() => null));
            })(),
            new Promise((r) => {
              const poll = setInterval(() => {
                if (errors.length > 0) {
                  clearInterval(poll);
                  setTimeout(r, 3000);
                }
              }, 500);
              page.once('close', () => clearInterval(poll));
            }),
          ]);
          await new Promise((r) => setTimeout(r, WAIT));
          audit = await page.evaluate(() => window.__whShaderAudit());
          break;
        } catch (e) {
          if (attempt >= 3 || !/context|navigat/i.test(String(e))) throw e;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } catch (e) {
      errors.push(`[shaders] ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
    await context.close();

    const bad = audit.filter((p) => !p.ok);
    programs += audit.length;
    failed += bad.length;
    // A page's own report of a broken shader repeats what is printed below; other errors count.
    const other = errors.filter((e) => !/failed to (compile|link)/.test(e));
    if (audit.length === 0 && other.length === 0) other.push('[shaders] the page made no program');
    pageErrors += other.length;
    console.log(`${target.name}: ${audit.length} programs, ${bad.length} failed, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    for (const p of bad) {
      if (p.stages.length === 0) console.log(`  FAILED to link: ${p.link.trim()}`);
      for (const s of p.stages) {
        console.log(`  FAILED ${s.stage} shader (the page's own error below names the program when it uses it):`);
        for (const l of s.log.trim().split('\n').slice(0, 8)) console.log(`    ${l}`);
        const ex = excerpt(s.source, s.log);
        if (ex) console.log(ex);
      }
    }
    for (const e of errors) console.log(`  ${e}`);
  }
} finally {
  await browser.close();
}
console.log(`shaders: ${programs} programs on ${targets.length} pages, ${failed} failed, ${pageErrors} page errors`);
process.exit(failed || pageErrors ? 1 : 0);
