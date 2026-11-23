#!/usr/bin/env node
// Re-takes the picture of marks after a repair: opens each mark's page at its saved view (its page, its hash, its
// canvas size and pixel ratio) in the host's headless Chrome on the real GPU, lets the view settle and copies the canvas
// the way the page copies a mark's picture (`__wh.marks.snapshot()`: the canvas alone, no pins, no panels, no circle),
// into <store>/<id>-after-<n>.png (n: the next free number). With --attach the picture is added to the mark's log
// through tools/marks/set.mjs. Runs on the host; needs the example server (docker compose up -d) and puppeteer-core in
// tools/shot/node_modules (outside git, as for the other host picture tools). One browser at a time; it closes its
// browser on every path out.
//
//   node tools/marks/shoot.mjs m0007 m0009                          pictures only
//   node tools/marks/shoot.mjs m0007 --attach --by agent:clouds --status fixed --text "the edge fades over 200 m"
//   node tools/marks/shoot.mjs m0007 --dry                          print what would be done, take nothing
//   options: --url http://127.0.0.1:5281   --wait 180 (seconds for the page to load and settle)
//            --warm 32 (frames rendered at the view's animation time before the copy, for effects that gather over
//            frames; the page must have `__wh.setTime`)
//
// The page opens with `marks=1` added to the hash: a page driven by a script has no marks otherwise. The id may be given
// as m0007, 7 or #7.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DIR, REPO, SERVER, markId, readMarks } from './common.mjs';

const CHROME = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const SET = join(REPO, 'tools', 'marks', 'set.mjs');

function fail(text) {
  console.error(`shoot.mjs: ${text}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = {};
const flags = new Set();
const ids = [];
const FLAGS = new Set(['attach', 'dry']);
const VALUES = new Set(['by', 'status', 'text', 'url', 'wait', 'warm']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) {
    const id = markId(a);
    if (!id) fail(`not a mark id: ${a}`);
    ids.push(id);
  } else if (FLAGS.has(a.slice(2))) flags.add(a.slice(2));
  else if (VALUES.has(a.slice(2))) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
    opts[a.slice(2)] = v;
    i++;
  } else fail(`unknown option ${a}`);
}
if (!ids.length) fail('usage: shoot.mjs <id>… [--attach --by <label> [--status fixed|working|seen] [--text "…"]] [--dry] [--url …] [--wait s] [--warm n]');
if (flags.has('attach') && !opts.by) fail('--attach needs --by <label>');
if (!flags.has('attach') && (opts.by || opts.status || opts.text)) fail('--by, --status and --text go with --attach');
const marks = new Map((readMarks() ?? []).map((m) => [m.id, m]));
if (!marks.size) fail(`no marks in ${DIR}`);
const server = (opts.url ?? SERVER).replace(/\/+$/, '');
const waitMs = Math.max(10, Number(opts.wait ?? 180)) * 1000;
const warm = Math.max(0, Math.round(Number(opts.warm ?? 32)));

/** The next free after-picture number of a mark (files in the folder and pictures named in its log). */
function nextAfter(m) {
  const re = new RegExp(`^${m.id}-after-(\\d{1,6})\\.png$`);
  const taken = (existsSync(DIR) ? readdirSync(DIR) : []).flatMap((n) => {
    const k = re.exec(n);
    return k ? [Number(k[1])] : [];
  });
  for (const e of Array.isArray(m.log) ? m.log : []) {
    const k = e.picture ? re.exec(e.picture.slice(e.picture.lastIndexOf('/') + 1)) : null;
    if (k) taken.push(Number(k[1]));
  }
  let n = Math.max(0, ...taken) + 1;
  while (existsSync(join(DIR, `${m.id}-after-${n}.png`))) n++;
  return n;
}

/** What to do for each mark: the page's address, the viewport and the file, or why not. */
const jobs = ids.map((id) => {
  const m = marks.get(id);
  if (!m) return { id, error: 'no such mark' };
  if (typeof m.view?.hash !== 'string' || !m.view.hash) return { id, error: 'the mark has no view hash' };
  if (typeof m.page !== 'string' || !m.page.startsWith('/')) return { id, error: 'the mark has no page' };
  const c = m.canvas ?? {};
  const cssW = Math.round(c.cssWidth || 1600);
  const cssH = Math.round(c.cssHeight || 900);
  const dpr = c.width && c.cssWidth ? Math.round((c.width / c.cssWidth) * 100) / 100 : 1;
  const file = join(DIR, `${id}-after-${nextAfter(m)}.png`);
  return { id, m, url: `${server}${m.page}#${m.view.hash}&marks=1`, cssW, cssH, dpr, file };
});

if (flags.has('dry')) {
  for (const j of jobs) console.log(j.error ? `${j.id}: ${j.error}` : `${j.id}: would open ${j.url} at ${j.cssW}x${j.cssH} @${j.dpr} and write ${j.file}`);
  process.exit(jobs.some((j) => j.error) ? 1 : 0);
}
if (!CHROME) fail('no Chrome found (set CHROME_PATH)');
let puppeteer;
try {
  puppeteer = createRequire(join(REPO, 'tools', 'shot', 'package.json'))('puppeteer-core');
} catch {
  fail('puppeteer-core is missing in tools/shot/node_modules (run `npm ci` in tools/shot once, or ask the developer)');
}

let failed = false;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--hide-scrollbars'] });
try {
  for (const j of jobs) {
    if (j.error) {
      console.error(`${j.id}: ${j.error}`);
      failed = true;
      continue;
    }
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    try {
      await page.setViewport({ width: j.cssW, height: j.cssH, deviceScaleFactor: j.dpr });
      await page.goto(j.url, { waitUntil: 'load', timeout: waitMs });
      // The first open of an example may bundle dependencies and reload the page: wait for the marks to be there.
      await page.waitForFunction(() => window.__wh?.marks !== undefined, { timeout: waitMs, polling: 250 });
      const shot = await page.evaluate(
        async (timeS, warmFrames) => {
          const wh = window.__wh;
          await wh.ready;
          const settled = wh.settled ? await wh.settled() : true;
          if (typeof timeS === 'number' && typeof wh.setTime === 'function') for (let i = 0; i < warmFrames; i++) wh.setTime(timeS);
          const c = await wh.marks.snapshot();
          return { ...c, settled, renderer: wh.stats?.().renderer ?? 'unknown' };
        },
        typeof j.m.view.timeS === 'number' ? j.m.view.timeS : null,
        warm,
      );
      if (!shot.png) {
        console.error(`${j.id}: no picture (${shot.note})`);
        failed = true;
        continue;
      }
      writeFileSync(j.file, Buffer.from(shot.png, 'base64'));
      console.log(`${j.id}: ${j.file} (${shot.settled ? 'settled' : 'NOT settled'}, ${shot.renderer})`);
      // A page error does not stop the picture, but such a picture is not attached blindly.
      if (errors.length) {
        console.error(`${j.id}: the page reported ${errors.length} error(s), the picture is kept but not attached; look at it first:\n  ${errors.slice(0, 5).join('\n  ')}`);
        failed = true;
        continue;
      }
      if (flags.has('attach')) {
        const setArgs = [SET, j.id, '--by', opts.by, '--after', j.file, '--url', server, '--text', opts.text ?? 'after-picture of the saved view'];
        if (opts.status) setArgs.push('--status', opts.status);
        if (spawnSync(process.execPath, setArgs, { stdio: 'inherit' }).status !== 0) failed = true;
      }
    } catch (e) {
      console.error(`${j.id}: ${e instanceof Error ? e.message : String(e)}`);
      failed = true;
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
