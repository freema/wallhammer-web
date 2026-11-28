// Compiles the shaders of the example pages without a graphics card: headless Chromium of the `wallhammer-web-shot:1`
// image on the software renderer, against the running `dev` service. Runs as the `shaders` service
// (docker-compose.yml, profile tools):
//
//   docker compose run --rm shaders                               every example page
//   docker compose run --rm shaders --pages planet,movement           only these
//   docker compose run --rm shaders --pages 'planet#strip=1'      a page with a hash (another set of programs)
//   docker compose run --rm shaders --pages endless/sphere.html   another page of an example
//   docker compose run --rm shaders --variants                    every example page, then the listed variants
//   docker compose run --rm shaders --more 'endless#cam=free'     every example page, then these
//   docker compose run --rm shaders --url http://host:port/page/  any page, not only an example
//
// --base      the server of the examples (default http://dev:5281)
// --pages     pages, comma separated: an example's name (`planet`) or a page file of one (`endless/sphere.html`),
//             each optionally with `#hash`; default: every example the server lists
// --variants  also the variants of shader-variants.mjs (pages and hashes that make programs the default pages do
//             not), after the pages of --pages or of the default list; this is what the CI job runs
// --more      pages in the same form as --pages, checked after them (and after --variants): for trying a variant
// --url       one page by its whole address instead of --pages
// --timeout   how long one attempt at a page may take, from the start of its browser to the check of its programs,
//             in ms (default 180000); a page that fails or takes longer is tried once more in a fresh browser
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
// Every page runs in a browser of its own (see `attempt`) and prints its programs, how many of them are new (their
// sources made by no earlier page of the run: a variant with 0 new adds nothing), its time and phases (`load`: the
// page's load event, `ready`: `__wh.ready` resolved, `checked`: programs read). A page that fails for any reason other than a
// broken shader (an exception, a console error, no program, over the time limit) is tried once more in a fresh
// browser and counts as a page error only when that fails too.
// Last line: `shaders: N programs on M pages, K failed, E page errors (T s[, R page(s) retried])`; exit code 1 when K
// or E is not 0.

import dns from 'node:dns/promises';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { SHADER_VARIANTS } from './shader-variants.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const BASE = arg('base', 'http://dev:5281');
const PAGES = arg('pages', '');
const MORE = arg('more', '');
const VARIANTS = process.argv.includes('--variants');
const URL_ARG = arg('url', '');
const PAGE_TIMEOUT = Number(arg('timeout', '180000'));
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
  // A program's name for telling programs of different pages apart: a hash (FNV-1a) of its shaders' sources.
  const nameOf = (program) => {
    let h = 0x811c9dc5;
    for (const shader of attached.get(program) ?? []) {
      const text = sources.get(shader) ?? '';
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 0xff, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  window.__whShaderAudit = () => {
    const out = [];
    for (const { gl, program } of linked) {
      if (gl.isContextLost() || !gl.isProgram(program)) continue;
      const entry = { ok: true, stages: [], link: '', id: nameOf(program) };
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
    if (VARIANTS) names.push(...SHADER_VARIANTS);
    names.push(...MORE.split(',').filter(Boolean));
    targets = names.map((n) => {
      const cut = n.indexOf('#');
      const page = cut < 0 ? n : n.slice(0, cut);
      // A name is an example's folder (its index page); a name ending in `.html` is a page file inside one.
      const url = new URL(page.endsWith('.html') ? `/${page}` : `/${page}/`, base);
      if (cut >= 0) url.hash = n.slice(cut + 1);
      return { name: n, url };
    });
  }
} catch (e) {
  console.error(`shaders: the server does not answer (${e instanceof Error ? e.message : String(e)}).`);
  console.log('shaders: 0 programs on 0 pages, 0 failed, 1 page errors');
  process.exit(1);
}

const origins = [...new Set(targets.map((t) => t.url.origin))];
const LAUNCH = {
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
    `--unsafely-treat-insecure-origin-as-secure=${origins.join(',')}`,
  ],
};

/** How long to wait for `__wh.ready` before the programs are read anyway. */
const READY_LIMIT = Math.min(120000, Math.round(PAGE_TIMEOUT / 2));
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** Resolves after `ms`; `unref`, so a pending timer never holds the process. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
/** Rejects with `what` when `promise` has not settled after `ms`. */
function limit(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took over ${seconds(ms)}`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One attempt at a page in a browser of its own. A browser per attempt, not a context per page: the software
 * renderer's GPU process is shared by every page of a browser, and a page that draws more than it can render leaves a
 * backlog there that it keeps working through after the page is closed. The next page of the same browser then waits
 * for it (measured: 70–85 s after `rivers`, whichever page came next), and so does closing the browser. Killing the
 * browser drops the backlog.
 *
 * Returns `{ audit, errors, phases }`; `errors` lists what went wrong with the page itself (not a failed shader).
 */
async function attempt(target) {
  const t0 = Date.now();
  const phases = [];
  const mark = (name) => phases.push(`${name} ${seconds(Date.now() - t0)}`);
  const errors = [];
  let audit = [];
  // A server, not `launch`: its `kill` ends the browser at once, also while its GPU process works through a backlog
  // (a plain close waits for that).
  const server = await chromium.launchServer(LAUNCH);
  const browser = await chromium.connect(server.wsEndpoint());
  try {
    // A small view: the pages need not draw much, only make their programs.
    const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript(installAudit);
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[console] ${m.text().split('\n')[0]}`);
    });
    page.on('pageerror', (e) => errors.push(`[exception] ${e.message.split('\n')[0]}`));
    // Loads of the page: a reload between `ready` and the check (the dev server reloads its pages when a source file
    // changes) would leave the check with the new document's first programs only.
    let loads = 0;
    page.on('load', () => loads++);
    const run = async () => {
      await page.goto(target.url.href, { waitUntil: 'load', timeout: PAGE_TIMEOUT });
      mark('load');
      // On its first load the dev server may bundle dependencies and reload the page by itself. Hence a few attempts.
      for (let n = 0; ; n++) {
        try {
          const loaded = loads;
          // A page that throws while it starts never sets `__wh` or resolves `ready`: its error then ends the wait.
          await Promise.race([
            (async () => {
              await page.waitForFunction(() => window.__wh !== undefined, undefined, { timeout: PAGE_TIMEOUT });
              // A page whose `ready` never resolves is still checked, with the programs it has made by then.
              const done = await page.evaluate(
                (ms) => Promise.race([Promise.resolve(window.__wh.ready).then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]),
                READY_LIMIT,
              );
              mark(done ? 'ready' : 'ready not resolved');
            })(),
            new Promise((r) => {
              const poll = setInterval(() => {
                if (errors.length > 0) {
                  clearInterval(poll);
                  mark('error');
                  setTimeout(r, 3000);
                }
              }, 500);
              page.once('close', () => clearInterval(poll));
            }),
          ]);
          await sleep(WAIT);
          audit = await page.evaluate(() => window.__whShaderAudit());
          if (loads !== loaded) throw new Error('the page navigated before its programs were read');
          mark('checked');
          return;
        } catch (e) {
          if (n >= 3 || !/context|navigat/i.test(String(e))) throw e;
          mark('reloaded');
          await sleep(1500);
        }
      }
    };
    const running = run();
    running.catch(() => {}); // settled late when the limit has struck; its error is the limit's
    await limit(running, PAGE_TIMEOUT, 'the page');
  } catch (e) {
    errors.push(`[shaders] ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  } finally {
    await server.kill();
  }
  return { audit, errors, phases };
}

let programs = 0;
let failed = 0;
let pageErrors = 0;
let retried = 0;
const tAll = Date.now();
/** The programs seen so far in the run, by the hash of their sources. */
const seen = new Set();
for (const target of targets) {
  const t0 = Date.now();
  let result = await attempt(target);
  // A page's own report of a broken shader repeats what is printed below; other errors count.
  const otherErrors = (r) => {
    const other = r.errors.filter((e) => !/failed to (compile|link)/.test(e));
    if (r.audit.length === 0 && other.length === 0) other.push('[shaders] the page made no program');
    return other;
  };
  let other = otherErrors(result);
  // A page that failed (not a shader: those fail the same way every time) gets one more try in a fresh browser.
  if (other.length > 0 && result.audit.every((p) => p.ok)) {
    console.log(`${target.name}: first attempt failed after ${seconds(Date.now() - t0)} (${result.phases.join(', ')}), trying once more`);
    for (const e of other) console.log(`  ${e}`);
    retried++;
    result = await attempt(target);
    other = otherErrors(result);
  }
  const { audit, errors, phases } = result;
  const bad = audit.filter((p) => !p.ok);
  // Programs whose sources no earlier page of this run made: what the page adds to the run.
  let fresh = 0;
  for (const p of audit) {
    if (!seen.has(p.id)) fresh++;
    seen.add(p.id);
  }
  programs += audit.length;
  failed += bad.length;
  pageErrors += other.length;
  console.log(`${target.name}: ${audit.length} programs (${fresh} new), ${bad.length} failed, ${seconds(Date.now() - t0)} (${phases.join(', ')})`);
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
console.log(
  `shaders: ${programs} programs on ${targets.length} pages, ${failed} failed, ${pageErrors} page errors` +
    ` (${seconds(Date.now() - tAll)}${retried ? `, ${retried} page(s) retried` : ''})`,
);
process.exit(failed || pageErrors ? 1 : 0);
