// Performance measurement of the Wallhammer Web pages. Runs on the host (the real GPU decides), like tools/shot, and
// reuses its installed puppeteer-core and Chrome; installs nothing. Changes nothing in the pages: inject.js wraps
// WebGL calls and the renderer prototypes from outside.
//
//   node bench.mjs frames  --page campus [--reps 3] [--n 40] [--size 1600x900] [--dpr 1]   cost per frame by pass/layer
//   (campus: --pohyb 0|1 switches the moving population off or on after load; default as the page loads)
//   node bench.mjs counts  --page campus                                                     draws, triangles, state changes
//   node bench.mjs startup --page campus [--reps 3]                                          navigation → first frame
//   node bench.mjs hitches --page campus [--reps 3]                                          rotation, zoom, a hit
//   node bench.mjs memory  --page campus|endless                                             GPU bytes by owner, heap growth
//   node bench.mjs scale   [--reps 3]                                                        campus: DPR, canvas size, passes off
//   node bench.mjs shadow  [--reps 3]                                                        campus: shadow map cost, redraw rate
//   node bench.mjs hit     [--reps 3]                                                        campus: largest-building hit profile
//   node bench.mjs flight  [--reps 3]                                                        endless: cell arrival, flight
//   node bench.mjs profile --page village [--view overview] [--n 20]                         the page's own __wh.profile():
//                                                                                            frame and per-layer cost (engine profileFrame)
//
// Pages: campus http://127.0.0.1:5280/ (the app of the city model project, an external app that uses the engine), and
// the examples of this repository served by `docker compose up -d`: destruction http://127.0.0.1:5281/destruction/,
// endless http://127.0.0.1:5281/endless/, village http://127.0.0.1:5281/fantasy-village/.
// The --pohyb flag and the values the campus scenarios pass to `window.__wh` (modes atelier and den, weathers leto and
// dest) are identifiers defined by that external app; they stay exactly as it spells them.
// Every result is also written as JSON into --out (default ./out). Headless Chrome caps presentation at 30 fps, so all
// numbers are cost per frame from synchronous renders, never fps.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '../shot/package.json'));
const puppeteer = require('puppeteer-core');
const INJECT = fs.readFileSync(path.join(HERE, 'inject.js'), 'utf8');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CMD = process.argv[2] ?? 'frames';
const PAGE = arg('page', 'campus');
const REPS = Number(arg('reps', '3'));
const N = Number(arg('n', '40'));
const [W, H] = arg('size', '1600x900').split('x').map(Number);
const DPR = Number(arg('dpr', '1'));
const REST_S = Number(arg('rest', '20'));
const OUT = path.resolve(arg('out', path.join(HERE, 'out')));
const ONLY = arg('only', '');
const POHYB = arg('pohyb', '');
const URLS = {
  campus: 'http://127.0.0.1:5280/',
  destruction: 'http://127.0.0.1:5281/destruction/',
  endless: 'http://127.0.0.1:5281/endless/',
  village: 'http://127.0.0.1:5281/fantasy-village/',
};
const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Median and spread ((max - min) / median) of repeated values; spread over 20 % marks the number unreliable. */
function summary(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { median: NaN, min: NaN, max: NaN, spread: NaN, n: 0 };
  const m = median(v);
  const min = Math.min(...v);
  const max = Math.max(...v);
  return { median: m, min, max, spread: m ? (max - min) / m : 0, n: v.length, unreliable: m ? (max - min) / m > 0.2 : false };
}
const fmt = (s, d = 2) => `${s.median.toFixed(d)} [${s.min.toFixed(d)}–${s.max.toFixed(d)}]${s.unreliable ? ' !' : ''}`;
function save(name, data) {
  const file = path.join(OUT, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  console.log(`→ ${file}`);
}

async function launch({ w = W, h = H, dpr = DPR, hooks = false } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 600000,
    args: [`--window-size=${w},${h}`, '--hide-scrollbars', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[console] ${m.text()}`);
  });
  await page.evaluateOnNewDocument(`${INJECT}\n__benchInstall(${JSON.stringify({ hooks })});`);
  return { browser, page };
}

async function open(page, pageName, hash = '') {
  const t0 = Date.now();
  // A hash-only change would not reload the page; scenarios given by hash need a fresh document.
  if (hash) await page.goto('about:blank');
  await page.goto(URLS[pageName] + (hash ? `#${hash}` : ''), { waitUntil: 'load', timeout: 120000 });
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForFunction(() => window.__wh !== undefined, { timeout: 60000 });
      await page.evaluate(() => window.__wh.ready);
      break;
    } catch (e) {
      if (attempt >= 3 || !String(e).includes('context')) throw e;
      await sleep(1.5);
    }
  }
  if (pageName === 'endless') await page.evaluate(() => window.__wh.settled());
  await page.evaluate(() => window.__benchAttach());
  if (POHYB !== '') await page.evaluate((on) => window.__wh.setPopulation?.(on), POHYB !== '0');
  // A render so the patched prototype sees the renderer and view.
  await page.evaluate(() => {
    const wh = window.__wh;
    // Campus: freeze the animation clock where it is (no loop frames between measurements). Orbit pages: just redraw.
    if (wh.getState) wh.setTime(wh.getState().time);
    else wh.setView({});
  });
  return Date.now() - t0;
}

/** Runs __benchFrames in the page. */
async function frames(page, opts) {
  return page.evaluate((o) => window.__benchFrames(o), opts);
}

// --- Scenarios ---------------------------------------------------------------------------------------------------------
const SCENARIOS = {
  campus: [
    { name: 'default', setup: (wh) => (wh.setMode('atelier'), wh.setWeather('leto'), wh.setTime(0), wh.goTo({ ...window.__home })) },
    { name: 'zoom0', setup: (wh) => wh.setView({ rotation: 0, zoom: 0 }) },
    { name: 'zoom5', setup: (wh) => wh.setView({ rotation: 0, zoom: 5, center: [880, 265] }) },
    { name: 'night', setup: (wh) => (wh.goTo({ ...window.__home }), wh.setMode('den'), wh.setTimeOfDay(22)) },
    // The campus trolleybus stop at the closest zoom with the clock running: figures and vehicles in motion.
    { name: 'stop-z5', step: 1 / 60, setup: (wh) => (wh.setMode('den'), wh.setWeather('leto'), wh.setTimeOfDay(13.1), wh.setView({ rotation: 0, zoom: 5, center: [1131, 126] })) },
    { name: 'rain', step: 1 / 60, setup: (wh) => (wh.setMode('atelier'), wh.goTo({ ...window.__home }), wh.setWeather('dest')) },
    // The largest building (17670578) hit with r 14 m, e 1600, viewed at zoom 3: mid-collapse (clock stepping, pieces
    // in flight, shadow redrawn every frame by the transient layer) and settled (6 s later, clock stopped).
    {
      name: 'building-z3',
      setup: (wh) => {
        wh.setWeather('leto');
        wh.setMode('atelier');
        const b = wh.buildingTypes().list.find((x) => x.id === 17670578);
        wh.goTo({ x: b.x, z: b.z, zoom: 3, rot: 0 });
      },
    },
    {
      name: 'hit-mid',
      step: 1 / 60,
      setup: async (wh) => {
        wh.setWeather('leto');
        wh.resetDestruction();
        const b = wh.buildingTypes().list.find((x) => x.id === 17670578);
        wh.goTo({ x: b.x, z: b.z, zoom: 3, rot: 0 });
        wh.setAnimation(true);
        wh.destroy(b.x, b.z, 14, 1600);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        wh.collapseAt(0.8);
      },
    },
    {
      name: 'hit-settled',
      setup: (wh) => wh.collapseAt(8),
    },
  ],
  destruction: [
    { name: 'settled', hash: 's=fall&at=6' },
    { name: 'mid', hash: 's=fall&at=1.2' },
    { name: 'mid-running', hash: 's=fall&at=0.5', step: 1 / 60, forceShadowNote: 'clock runs: shadow redrawn while pieces move' },
  ],
  endless: [
    { name: 'origin', setup: (wh) => wh.setView({ x: 0, z: 0, yawDeg: 160, pitchDeg: 12, distance: 900 }), settle: true },
    { name: 'far', setup: (wh) => wh.setView({ x: 10_000_000, z: 0, yawDeg: 30, pitchDeg: 14, distance: 260 }), settle: true },
  ],
};

async function prepareScenario(page, pageName, sc) {
  if (sc.hash) {
    await open(page, pageName, sc.hash);
    return;
  }
  await page.evaluate(`(${sc.setup.toString()})(window.__wh)`);
  if (sc.settle) await page.evaluate(() => window.__wh.settled());
}

async function cmdFrames() {
  const all = [];
  for (let rep = 0; rep < REPS; rep++) {
    const { browser, page } = await launch();
    try {
      await open(page, PAGE);
      if (PAGE === 'campus') await page.evaluate(() => {
        const v = window.__wh.getView();
        window.__home = { x: v.center.x, z: v.center.z, zoom: v.zoom, rot: v.rotation };
      });
      for (const sc of SCENARIOS[PAGE]) {
        if (ONLY && !ONLY.split(',').includes(sc.name)) continue;
        await prepareScenario(page, PAGE, sc);
        const step = sc.step ?? 0;
        const still = await frames(page, { n: N, step });
        const shadow = await frames(page, { n: N, step, forceShadow: true });
        const pipelined = await frames(page, { n: N, step, finishEach: false });
        const gpuPass = await frames(page, { n: N, step, query: 'pass', forceShadow: true });
        // Per-layer timer queries split Metal render passes and inflate the result; kept only behind a flag.
        const gpuLayer = process.argv.includes('--layer-queries') ? await frames(page, { n: N, step, query: 'layer', forceShadow: true }) : { gpu: null };
        // Per-layer cost by subtraction: the frame with one layer skipped in one pass (colour: still frame; shadow: forced).
        const off = {};
        if (!process.argv.includes('--no-off')) {
          const names = await page.evaluate(() => window.__bench.renderer.layers.map((l) => l.__benchName));
          const drawn = new Set([...Object.keys(still.drew), ...Object.keys(shadow.drew)]);
          for (const name of names) {
            for (const pass of ['color', 'shadow', 'overlay']) {
              if (!drawn.has(`${pass}|${name}`)) continue;
              await page.evaluate((k) => window.__bench.skip.add(k), `${pass}:${name}`);
              const f = await frames(page, { n: N, step, forceShadow: pass === 'shadow' });
              await page.evaluate(() => window.__bench.skip.clear());
              off[`${pass}|${name}`] = { wall: median(f.wall), cpu: f.renderCpuMs, pipelined: f.totalMsPerFrame };
            }
          }
        }
        const gpuPassStill = await frames(page, { n: N, step, query: 'pass' });
        // The page's own measurement (renderer.benchmark: n renders, one finish) for comparison with earlier notes.
        const own = await page.evaluate((n) => window.__wh.benchmark(n), N);
        all.push({ rep, scenario: sc.name, still, shadow, pipelined, gpuPass, gpuLayer, gpuPassStill, own, off });
        console.log(
          `rep ${rep} ${sc.name}: canvas ${still.canvas.join('×')}  still wall ${median(still.wall).toFixed(2)} cpu ${median(still.cpu).toFixed(2)} | ` +
            `+shadow wall ${median(shadow.wall).toFixed(2)} cpu ${median(shadow.cpu).toFixed(2)} | pipelined ${still.totalMsPerFrame.toFixed(2)}/${pipelined.totalMsPerFrame.toFixed(2)} | ` +
            `gpu pass ${gpuPass.gpu ? Object.entries(gpuPass.gpu.by).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') : 'n/a'} (shadow frames ${still.shadowFrames}/${N}) own benchmark ${own?.toFixed?.(2)}`,
        );
      }
    } finally {
      await browser.close();
    }
    if (rep < REPS - 1) await sleep(REST_S);
  }
  save(`frames-${PAGE}-${W}x${H}@${DPR}${ONLY ? `-${ONLY}` : ''}`, { size: [W, H], dpr: DPR, n: N, runs: all });
  report(all);
}

function report(all) {
  const by = new Map();
  for (const r of all) {
    if (!by.has(r.scenario)) by.set(r.scenario, []);
    by.get(r.scenario).push(r);
  }
  for (const [name, runs] of by) {
    const s = (f) => summary(runs.map(f));
    console.log(`\n== ${name} (${runs.length} runs, canvas ${runs[0].still.canvas.join('×')})`);
    console.log(`  still frame wall (finish each)  ${fmt(s((r) => median(r.still.wall)))} ms   cpu render ${fmt(s((r) => median(r.still.cpu)))} ms`);
    console.log(`  frame + shadow redraw wall      ${fmt(s((r) => median(r.shadow.wall)))} ms   cpu render ${fmt(s((r) => median(r.shadow.cpu)))} ms`);
    console.log(`  pipelined (one finish / n)      still ${fmt(s((r) => r.still.totalMsPerFrame))}  no-finish ${fmt(s((r) => r.pipelined.totalMsPerFrame))}`);
    const keys = new Set(runs.flatMap((r) => Object.keys(r.gpuPass.gpu?.by ?? {})));
    for (const k of keys) console.log(`  GPU ${k.padEnd(28)} ${fmt(s((r) => r.gpuPass.gpu?.by[k] ?? NaN))} ms (timer query, shadow forced)`);
    const keysS = new Set(runs.flatMap((r) => Object.keys(r.gpuPassStill.gpu?.by ?? {})));
    for (const k of keysS) console.log(`  GPU still ${k.padEnd(22)} ${fmt(s((r) => r.gpuPassStill.gpu?.by[k] ?? NaN))} ms`);
    console.log(`  own __wh.benchmark               ${fmt(s((r) => r.own ?? NaN))} ms   sync read ${fmt(s((r) => r.still.syncMs))} ms   cpu render mean ${fmt(s((r) => r.still.renderCpuMs), 3)} / shadow ${fmt(s((r) => r.shadow.renderCpuMs), 3)}`);
    const ok = new Set(runs.flatMap((r) => Object.keys(r.off ?? {})));
    for (const k of [...ok].sort()) {
      const base = (r) => (k.startsWith('shadow') ? median(r.shadow.wall) : median(r.still.wall));
      console.log(`  layer off ${k.padEnd(50)} saves ${fmt(s((r) => base(r) - (r.off[k]?.wall ?? NaN)), 2)} ms wall`);
    }
    const lk = new Set(runs.flatMap((r) => Object.keys(r.gpuLayer.gpu?.by ?? {})));
    for (const k of [...lk].sort()) console.log(`  GPU layer ${k.padEnd(50)} ${fmt(s((r) => r.gpuLayer.gpu?.by[k] ?? NaN), 3)}`);
    const ck = new Set(runs.flatMap((r) => Object.keys(r.shadow.layers)));
    for (const k of [...ck].sort()) if (runs.some((r) => (r.shadow.layers[k] ?? 0) > 0.002)) console.log(`  CPU ${k.padEnd(56)} ${fmt(s((r) => r.shadow.layers[k] ?? NaN), 3)}`);
    const pk = new Set(runs.flatMap((r) => Object.keys(r.shadow.passes)));
    for (const k of [...pk].sort()) console.log(`  CPU pass ${k.padEnd(20)} ${fmt(s((r) => r.shadow.passes[k] ?? NaN), 3)} (shadow forced)  still ${fmt(s((r) => r.still.passes[k] ?? NaN), 3)}`);
  }
}

// --- Counts (hooks on) -------------------------------------------------------------------------------------------------
async function cmdCounts() {
  const { browser, page } = await launch({ hooks: true });
  const out = [];
  try {
    await open(page, PAGE);
    if (PAGE === 'campus') await page.evaluate(() => {
      const v = window.__wh.getView();
      window.__home = { x: v.center.x, z: v.center.z, zoom: v.zoom, rot: v.rotation };
    });
    for (const sc of SCENARIOS[PAGE]) {
      await prepareScenario(page, PAGE, sc);
      const r = await frames(page, { n: 5, step: sc.step ?? 0, forceShadow: true });
      const st = await frames(page, { n: 5, step: sc.step ?? 0 });
      out.push({ scenario: sc.name, shadowForced: r.counts, still: st.counts, stats: r.stats });
      console.log(`\n== ${sc.name}`);
      for (const [pass, c] of Object.entries(r.counts)) {
        console.log(
          `  ${pass.padEnd(8)} draws ${c.draws.toFixed(0)}  tris ${(c.tris / 1e6).toFixed(3)} M  instances ${c.instances.toFixed(0)}  state ${c.state.toFixed(0)}  programs ${c.programs.toFixed(0)}  vao ${c.vaos.toFixed(0)}  tex binds ${c.textures.toFixed(0)}  uniforms ${c.uniforms.toFixed(0)}  bufferSubData ${(c.subBytes / 1024).toFixed(1)} KB`,
        );
        for (const [l, v] of Object.entries(c.byLayer)) console.log(`      ${l.padEnd(50)} draws ${v.draws.toFixed(0)} tris ${(v.tris / 1e3).toFixed(1)} k inst ${v.instances.toFixed(0)}`);
      }
      for (const [pass, c] of Object.entries(st.counts)) console.log(`  still ${pass.padEnd(8)} draws ${c.draws.toFixed(0)} tris ${(c.tris / 1e6).toFixed(3)} M state ${c.state.toFixed(0)} uniforms ${c.uniforms.toFixed(0)} sub ${(c.subBytes / 1024).toFixed(1)} KB`);
    }
  } finally {
    await browser.close();
  }
  save(`counts-${PAGE}`, out);
}

// --- CPU profile helpers -----------------------------------------------------------------------------------------------
async function startProfile(cdp, intervalUs = 200) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs });
  await cdp.send('Profiler.start');
}
async function stopProfile(cdp) {
  const { profile } = await cdp.send('Profiler.stop');
  return profile;
}
/** Inclusive and self ms per function (name@file:line); recursion counted once per path. */
function aggregate(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000);
  }
  const key = (n) => `${n.callFrame.functionName || '(anon)'}@${(n.callFrame.url || '').split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`;
  const incl = new Map();
  const selfBy = new Map();
  const rootId = profile.nodes[0].id;
  // Iterative DFS with an "active keys" multiset so recursion is not counted twice.
  const total = new Map();
  const order = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    order.push(id);
    for (const c of nodes.get(id).children ?? []) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = nodes.get(order[i]);
    let t = self.get(n.id) ?? 0;
    for (const c of n.children ?? []) t += total.get(c) ?? 0;
    total.set(n.id, t);
  }
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  for (const n of profile.nodes) {
    const k = key(n);
    selfBy.set(k, (selfBy.get(k) ?? 0) + (self.get(n.id) ?? 0));
    // Count inclusive only if no ancestor has the same key.
    let p = parent.get(n.id);
    let dup = false;
    while (p !== undefined) {
      if (key(nodes.get(p)) === k) {
        dup = true;
        break;
      }
      p = parent.get(p);
    }
    if (!dup) incl.set(k, (incl.get(k) ?? 0) + (total.get(n.id) ?? 0));
  }
  const top = (m, k = 40) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, ms]) => ({ name, ms }));
  return { inclusive: top(incl, 80), self: top(selfBy, 40), totalMs: (profile.endTime - profile.startTime) / 1000 };
}

// --- Startup -----------------------------------------------------------------------------------------------------------
async function cmdStartup() {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const { browser, page } = await launch({ hooks: true });
    try {
      const cdp = await page.createCDPSession();
      await startProfile(cdp, 100);
      const t0 = Date.now();
      await page.goto(URLS[PAGE], { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction(() => window.__wh !== undefined, { timeout: 60000 });
      const readyAt = await page.evaluate(async () => {
        await window.__wh.ready;
        return performance.now();
      });
      let settledAt = null;
      if (PAGE === 'endless') settledAt = await page.evaluate(async () => (await window.__wh.settled(), performance.now()));
      const profile = await stopProfile(cdp);
      const wall = Date.now() - t0;
      const info = await page.evaluate(() => {
        const B = window.__bench;
        const nav = performance.getEntriesByType('navigation')[0];
        const res = performance.getEntriesByType('resource');
        const data = res.filter((r) => /\/data\/|\.bin|\.json|\.whc/.test(r.name)).map((r) => ({ name: r.name.split('/').slice(-2).join('/'), start: r.startTime, end: r.responseEnd, bytes: r.transferSize || r.encodedBodySize, decoded: r.decodedBodySize }));
        const modules = res.filter((r) => /\.ts|\.js|@vite|@fs|node_modules/.test(r.name));
        return {
          contextAt: B.contextAt,
          domContentLoaded: nav?.domContentLoadedEventEnd,
          loadEvent: nav?.loadEventEnd,
          modules: { count: modules.length, lastEnd: Math.max(0, ...modules.map((m) => m.responseEnd)) },
          data,
          shader: B.shader,
          upload: B.upload,
          tasks: B.tasks,
          mem: B.memory ? B.memory().total : null,
          sceneInfo: window.__wh.stats?.().scene ?? null,
        };
      });
      const agg = aggregate(profile);
      runs.push({ rep, wall, readyAt, settledAt, info, profile: agg });
      const longest = [...info.tasks].sort((a, b) => b.ms - a.ms).slice(0, 5);
      console.log(
        `rep ${rep}: ready ${readyAt.toFixed(0)} ms after navigation${settledAt ? `, settled ${settledAt.toFixed(0)}` : ''}; modules done ${info.modules.lastEnd.toFixed(0)} (${info.modules.count}); ` +
          `data ${info.data.length} files done ${Math.max(0, ...info.data.map((d) => d.end)).toFixed(0)}; shaders compile ${info.shader.compileMs.toFixed(0)} link ${info.shader.linkMs.toFixed(0)} status ${info.shader.statusMs.toFixed(0)} ms (${info.shader.programs} programs); ` +
          `uploads buffers ${info.upload.bufferMs.toFixed(0)} ms / ${(info.upload.bufferBytes / 1048576).toFixed(1)} MB, textures ${info.upload.textureMs.toFixed(0)} ms; longest tasks ${longest.map((t) => `${t.ms.toFixed(0)}@${t.start.toFixed(0)}`).join(', ')}`,
      );
    } finally {
      await browser.close();
    }
    if (rep < REPS - 1) await sleep(REST_S / 2);
  }
  save(`startup-${PAGE}`, runs);
  // Phases by inclusive profile time.
  const names = new Set(runs.flatMap((r) => r.profile.inclusive.map((x) => x.name)));
  const rows = [];
  for (const n of names) {
    const v = runs.map((r) => r.profile.inclusive.find((x) => x.name === n)?.ms ?? 0);
    rows.push({ n, s: summary(v) });
  }
  rows.sort((a, b) => b.s.median - a.s.median);
  console.log('\ninclusive CPU by function (median [min–max] ms):');
  for (const r of rows.slice(0, 60)) console.log(`  ${r.n.padEnd(70)} ${fmt(r.s, 1)}`);
  console.log(`ready: ${fmt(summary(runs.map((r) => r.readyAt)), 0)} ms`);
}

// --- Hitches (campus) --------------------------------------------------------------------------------------------------
async function cmdHitches() {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const { browser, page } = await launch();
    try {
      await open(page, 'campus');
      const r = await page.evaluate(async () => {
        const B = window.__bench;
        const g = B.gl;
        const px = new Uint8Array(4);
        const finish = () => g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
        const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === 'q' ? 'KeyQ' : k === 'e' ? 'KeyE' : k, bubbles: true }));
        const out = { rotate: [], zoomIn: [], zoomOut: [], pan: [], bareRenderAfterIdle: [], bareRenderBackToBack: [] };
        const measure = async (list, fn) => {
          await new Promise((res) => setTimeout(res, 50));
          finish();
          const t0 = performance.now();
          fn();
          const cpu = performance.now() - t0;
          finish();
          list.push({ cpu, wall: performance.now() - t0, shadowCalls: window.__wh.stats().shadowDrawCalls });
        };
        const wh = window.__wh;
        // Rotation by the camera panel path (same as Q/E: camera.setRotation + viewChanged).
        for (let i = 0; i < 8; i++) await measure(out.rotate, () => key(i % 2 ? 'e' : 'q'));
        const v0 = wh.getView();
        for (let i = 0; i < 6; i++) await measure(out.zoomIn, () => wh.goTo({ zoom: Math.min(5, i) }));
        for (let i = 5; i >= 0; i--) await measure(out.zoomOut, () => wh.goTo({ zoom: i }));
        wh.goTo({ zoom: v0.zoom, rot: v0.rotation });
        for (let i = 0; i < 8; i++) await measure(out.pan, () => wh.goTo({ x: 700 + i * 13.7, z: 260 }));
        // Control: the renderer alone (shadow redraw forced, no app code, no DOM) after the same 50 ms idle gap, and
        // back to back. The difference shows what the idle gap itself costs (GPU clocking down between frames).
        const bare = () => (B.renderer.invalidateShadows(), B.renderer.render(B.view));
        for (let i = 0; i < 8; i++) await measure(out.bareRenderAfterIdle, bare);
        for (let i = 0; i < 8; i++) {
          finish();
          const t0 = performance.now();
          bare();
          const cpu = performance.now() - t0;
          finish();
          out.bareRenderBackToBack.push({ cpu, wall: performance.now() - t0, shadowCalls: 0 });
        }
        return { out, tasks: B.tasks };
      });
      runs.push({ rep, ...r });
      for (const [k, list] of Object.entries(r.out)) console.log(`rep ${rep} ${k}: cpu ${list.map((x) => x.cpu.toFixed(1)).join(' ')} | wall ${list.map((x) => x.wall.toFixed(1)).join(' ')}`);
    } finally {
      await browser.close();
    }
    if (rep < REPS - 1) await sleep(REST_S / 2);
  }
  save('hitches-campus', runs);
  for (const k of ['rotate', 'zoomIn', 'zoomOut', 'pan', 'bareRenderAfterIdle', 'bareRenderBackToBack']) {
    console.log(`${k}: per-event wall median over runs ${fmt(summary(runs.map((r) => median(r.out[k].map((x) => x.wall)))), 1)} ms, max ${fmt(summary(runs.map((r) => Math.max(...r.out[k].map((x) => x.wall)))), 1)}; cpu ${fmt(summary(runs.map((r) => median(r.out[k].map((x) => x.cpu)))), 1)}`);
  }
}

// --- Hit on the largest campus building --------------------------------------------------------------------------------
async function cmdHit() {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const { browser, page } = await launch();
    try {
      await open(page, 'campus');
      const cdp = await page.createCDPSession();
      const target = await page.evaluate(() => {
        const b = window.__wh.buildingTypes().list.find((x) => x.id === 17670578);
        window.__wh.goTo({ x: b.x, z: b.z, zoom: 3 });
        window.__wh.setAnimation(true);
        return b;
      });
      await startProfile(cdp, 100);
      const r = await page.evaluate(async (b) => {
        const B = window.__bench;
        const g = B.gl;
        const px = new Uint8Array(4);
        const wh = window.__wh;
        await new Promise((res) => setTimeout(res, 100));
        const tasks0 = performance.now();
        const t0 = performance.now();
        let info = wh.destroy(b.x, b.z, 14, 1600);
        const cpu = performance.now() - t0;
        // The campus prepares the picture of a hit over a few tasks after it; wait until it shows.
        if (wh.destructionSettled) info = await wh.destructionSettled();
        g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
        const wall = performance.now() - t0;
        const fall = wh.falling();
        // Let the collapse run for 3 s of real frames and record frame cost from the loop's render.
        const frameTimes = [];
        const end = performance.now() + 3000;
        while (performance.now() < end) {
          const f0 = performance.now();
          await new Promise((res) => requestAnimationFrame(() => res()));
          frameTimes.push(performance.now() - f0);
        }
        return { cpu, wall, cost: info.cost, changed: info.changed, structures: info.structures, fall, tasks: B.longTasks(tasks0), frameTimes };
      }, target);
      const profile = aggregate(await stopProfile(cdp));
      runs.push({ rep, ...r, profile });
      console.log(`rep ${rep}: hit cpu ${r.cpu.toFixed(1)} wall (to picture shown) ${r.wall.toFixed(1)} ms; longest task ${Math.max(0, ...r.tasks.map((t) => t.ms)).toFixed(0)} ms; cost ${JSON.stringify(r.cost)}; pieces ${r.fall.pieces} (fall prep ${r.fall.ms?.toFixed?.(1)}); long tasks ${r.tasks.map((t) => t.ms.toFixed(0)).join(', ')}`);
    } finally {
      await browser.close();
    }
    if (rep < REPS - 1) await sleep(REST_S / 2);
  }
  save('hit-campus', runs);
  console.log(`hit total cpu ${fmt(summary(runs.map((r) => r.cpu)), 1)} ms, wall ${fmt(summary(runs.map((r) => r.wall)), 1)}, longest task ${fmt(summary(runs.map((r) => Math.max(0, ...r.tasks.map((t) => t.ms)))), 0)}`);
  for (const k of ['regenMs', 'uploadMs', 'rubbleMs', 'eventMs', 'totalMs']) console.log(`  ${k} ${fmt(summary(runs.map((r) => r.cost?.[k] ?? NaN)), 1)}`);
  console.log(`  fall prep ${fmt(summary(runs.map((r) => r.fall.ms ?? NaN)), 1)}`);
  const names = new Set(runs.flatMap((r) => r.profile.inclusive.map((x) => x.name)));
  const rows = [...names].map((n) => ({ n, s: summary(runs.map((r) => r.profile.inclusive.find((x) => x.name === n)?.ms ?? 0)) })).sort((a, b) => b.s.median - a.s.median);
  for (const r of rows.slice(0, 45)) console.log(`  ${r.n.padEnd(70)} ${fmt(r.s, 1)}`);
}

// --- Memory ------------------------------------------------------------------------------------------------------------
async function heap(cdp) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const h = await cdp.send('Runtime.getHeapUsage');
  // usedSize is the V8 heap; typed-array backing stores live outside it (backingStorageSize where Chrome reports it).
  return h;
}
async function cmdMemory() {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const { browser, page } = await launch({ hooks: true });
    try {
      await open(page, PAGE);
      const cdp = await page.createCDPSession();
      const snap = async (label) => {
        const h = await heap(cdp);
        const used = h.usedSize;
        const gpu = await page.evaluate(() => window.__bench.memory());
        const extra = await page.evaluate(() => (window.__wh.stats().streaming ? { gpuBytes: window.__wh.stats().streaming.gpuBytes, cpuBytes: window.__wh.stats().streaming.cpuBytes } : null));
        // The engine's own count (Device.memory), once the bench has seen the renderer.
        const engine = await page.evaluate(() => window.__bench.renderer?.device.memory?.() ?? null);
        console.log(`rep ${rep} ${label}: JS heap ${(used / 1048576).toFixed(1)} MB (backing stores ${((h.backingStorageSize ?? NaN) / 1048576).toFixed(1)} MB), GPU tracked ${(gpu.total / 1048576).toFixed(1)} MB in ${gpu.objects} objects${engine ? `, engine counts ${(engine.total / 1048576).toFixed(1)} MB` : ''}${extra ? `, streaming says gpu ${(extra.gpuBytes / 1048576).toFixed(1)} cpu ${(extra.cpuBytes / 1048576).toFixed(1)} MB` : ''}`);
        return { label, heap: used, heapUsage: h, gpu, engine, extra };
      };
      const snaps = [await snap('loaded')];
      if (PAGE === 'campus') {
        const list = await page.evaluate(() => window.__wh.buildingTypes().list);
        const pick = list.filter((b, i) => i % Math.floor(list.length / 20) === 0).slice(0, 20);
        await page.evaluate(() => window.__wh.setAnimation(true));
        for (const b of pick) {
          await page.evaluate((b) => window.__wh.destroy(b.x, b.z, 6, 450), b);
          await sleep(0.3);
        }
        await sleep(4);
        snaps.push(await snap('after 20 hits'));
        await page.evaluate(() => window.__wh.resetDestruction());
        await sleep(1);
        snaps.push(await snap('after reset'));
        // The same 20 hits again: growth here (not in the first round) would be a leak.
        for (const b of pick) {
          await page.evaluate((b) => window.__wh.destroy(b.x, b.z, 6, 450), b);
          await sleep(0.3);
        }
        await sleep(32);
        snaps.push(await snap('after 20 more hits + 32 s'));
        await page.evaluate(() => window.__wh.resetDestruction());
        await sleep(1);
        snaps.push(await snap('after second reset'));
      } else if (PAGE === 'endless') {
        // A long flight: 8 legs of 40 km, then back to the origin.
        const legs = [[40000, 0], [40000, 40000], [0, 40000], [-40000, 40000], [-40000, 0], [-40000, -40000], [0, -40000], [0, 0]];
        for (const [x, z] of legs) {
          await page.evaluate(({ x, z }) => {
            const v = window.__wh.getView();
            window.__wh.setView({ x: v.x, z: v.z, yawDeg: 30, pitchDeg: 18, distance: 600, flight: { toX: x, toZ: z, frames: 120 } });
          }, { x, z });
          await page.evaluate(() => window.__wh.settled());
        }
        await page.evaluate(() => window.__wh.setView({ x: 0, z: 0, yawDeg: 160, pitchDeg: 12, distance: 900 }));
        await page.evaluate(() => window.__wh.settled());
        snaps.push(await snap('after 320 km flight, back at origin'));
        for (const [x, z] of legs) {
          await page.evaluate(({ x, z }) => {
            const v = window.__wh.getView();
            window.__wh.setView({ x: v.x, z: v.z, yawDeg: 30, pitchDeg: 18, distance: 600, flight: { toX: x, toZ: z, frames: 120 } });
          }, { x, z });
          await page.evaluate(() => window.__wh.settled());
        }
        await page.evaluate(() => window.__wh.setView({ x: 0, z: 0, yawDeg: 160, pitchDeg: 12, distance: 900 }));
        await page.evaluate(() => window.__wh.settled());
        snaps.push(await snap('after second 320 km flight'));
      }
      runs.push({ rep, snaps });
    } finally {
      await browser.close();
    }
    if (rep < REPS - 1) await sleep(REST_S / 2);
  }
  save(`memory-${PAGE}`, runs);
  const first = runs[0].snaps[0].gpu.byOwner.slice(0, 40);
  console.log('\nGPU bytes by owner after load (rep 0):');
  for (const o of first) console.log(`  ${(o.bytes / 1048576).toFixed(2).padStart(8)} MB  ${String(o.objects).padStart(4)}×  ${o.kind.padEnd(8)} ${o.owner}`);
}

// --- Resolution scaling and passes off (campus) -----------------------------------------------------------------------
async function cmdScale() {
  // The same world on screen in every config (same CSS size and zoom), only the pixel count changes: 0.36, 1.44,
  // 3.24 and 5.76 Mpx. A cost that grows with pixels is fill/fragment bound, a flat one is vertex/CPU bound.
  const configs = [
    { size: [1600, 900], dpr: 0.5 },
    { size: [1600, 900], dpr: 1 },
    { size: [1600, 900], dpr: 1.5 },
    { size: [1600, 900], dpr: 2 },
  ];
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    for (const c of configs) {
      const { browser, page } = await launch({ w: c.size[0], h: c.size[1], dpr: c.dpr });
      try {
        await open(page, 'campus');
        // Same world view in every config: zoom level 1 at the home centre (the fitted zoom depends on the size).
        await page.evaluate(() => window.__wh.goTo({ zoom: 1, rot: 0, x: 690, z: 250 }));
        const names = await page.evaluate(() => window.__bench.renderer.layers.map((l) => l.__benchName));
        const base = await frames(page, { n: N });
        const gpu = await frames(page, { n: N, query: 'pass' });
        const res = { rep, size: c.size, dpr: c.dpr, canvas: base.canvas, still: summary(base.wall), cpu: summary(base.cpu), pipelined: base.totalMsPerFrame, gpu: gpu.gpu, off: {} };
        if (c.dpr === 2 || c.dpr === 1) {
          for (const name of names) {
            await page.evaluate((n) => window.__bench.skip.add(`color:${n}`), name);
            const f = await frames(page, { n: N });
            await page.evaluate((n) => window.__bench.skip.clear(), name);
            res.off[name] = { wall: median(f.wall), pipelined: f.totalMsPerFrame };
          }
        }
        runs.push(res);
        console.log(
          `rep ${rep} ${c.size.join('×')}@${c.dpr} canvas ${base.canvas.join('×')}: wall ${res.still.median.toFixed(2)} cpu ${res.cpu.median.toFixed(2)} pipelined ${res.pipelined.toFixed(2)} gpu ${gpu.gpu ? Object.entries(gpu.gpu.by).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' ') : 'n/a'}` +
            (Object.keys(res.off).length ? `\n   color layer off → wall: ${Object.entries(res.off).map(([k, v]) => `${k} ${v.wall.toFixed(2)}`).join(', ')}` : ''),
        );
      } finally {
        await browser.close();
      }
      await sleep(REST_S / 2);
    }
  }
  save('scale-campus', runs);
}

// --- Shadow map --------------------------------------------------------------------------------------------------------
async function cmdShadow() {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const { browser, page } = await launch();
    try {
      await open(page, 'campus');
      const r = {};
      for (const [name, setup] of [
        ['home', () => {}],
        ['zoom0', () => window.__wh.goTo({ zoom: 0 })],
        ['zoom5', () => window.__wh.goTo({ zoom: 5, x: 880, z: 265 })],
      ]) {
        await page.evaluate(`(${setup.toString()})()`);
        const still = await frames(page, { n: N, query: 'pass' });
        const forced = await frames(page, { n: N, query: 'pass', forceShadow: true });
        r[name] = { shadowPx: forced.stats.shadowMapPx, shadowTris: forced.stats.shadowTriangles, shadowCalls: forced.stats.shadowDrawCalls, stillWall: median(still.wall), forcedWall: median(forced.wall), stillCpu: median(still.cpu), forcedCpu: median(forced.cpu), gpuShadow: forced.gpu?.by['shadow|all'], gpuColorForced: forced.gpu?.by['color|all'], gpuColorStill: still.gpu?.by['color|all'], passes: forced.passes, layers: forced.layers };
        console.log(`rep ${rep} ${name}: map ${r[name].shadowPx}px tris ${(r[name].shadowTris / 1e6).toFixed(2)}M; wall still ${r[name].stillWall.toFixed(2)} vs redraw ${r[name].forcedWall.toFixed(2)}; cpu ${r[name].stillCpu.toFixed(2)} vs ${r[name].forcedCpu.toFixed(2)}; GPU shadow ${r[name].gpuShadow?.toFixed(2)} color ${r[name].gpuColorStill?.toFixed(2)}/${r[name].gpuColorForced?.toFixed(2)}`);
      }
      // How often is it redrawn? Count shadow redraws over real frames in typical modes.
      await page.evaluate(() => window.__wh.goTo({ zoom: 1 }));
      const rate = await page.evaluate(async () => {
        const wh = window.__wh;
        const count = async (ms) => {
          let frames = 0;
          let shadows = 0;
          const B = window.__bench;
          const r = B.renderer;
          const orig = r.render;
          r.render = function (v) {
            const s = orig.call(this, v);
            frames++;
            if (s.shadowDrawCalls > 0) shadows++;
            return s;
          };
          await new Promise((res) => setTimeout(res, ms));
          delete r.render;
          return { frames, shadows };
        };
        const out = {};
        wh.setAnimation(false);
        out.idle = await count(2000);
        wh.setAnimation(true);
        out.animation = await count(3000);
        wh.setWeather('dest');
        out.rain = await count(3000);
        wh.setWeather('leto');
        wh.setMode('den');
        const st = wh.getState();
        // Day running at the default speed (the panel's play button does env.day.toggle()).
        const day = window.__bench.link.env.day;
        day.play();
        out.dayRunning = await count(3000);
        day.pause();
        wh.setMode('atelier');
        wh.setAnimation(false);
        return { ...out, dayRate: window.__bench.link.env.day.rate ?? null };
      });
      r.rate = rate;
      console.log(`rep ${rep} redraws: ${JSON.stringify(rate)}`);
      runs.push(r);
    } finally {
      await browser.close();
    }
    if (rep < REPS - 1) await sleep(REST_S / 2);
  }
  save('shadow-campus', runs);
}

// --- Endless: flight and cell arrival ----------------------------------------------------------------------------------
async function cmdFlight() {
  const runs = [];
  const src = arg('src', 'workers');
  for (let rep = 0; rep < REPS; rep++) {
    const { browser, page } = await launch();
    try {
      await open(page, 'endless', src !== 'workers' ? `src=${src}` : '');
      await page.evaluate(() => window.__wh.setView({ x: 0, z: 0, yawDeg: 30, pitchDeg: 18, distance: 600 }));
      await page.evaluate(() => window.__wh.settled());
      const r = await page.evaluate(async () => {
        const B = window.__bench;
        const wh = window.__wh;
        const t0 = performance.now();
        // Fast flight: 9 km × 15.6 km in 120 frames, each a real browser frame (rAF), like the preset.
        wh.setView({ x: 0, z: 0, yawDeg: 30, pitchDeg: 18, distance: 600, flight: { toX: -9000, toZ: -15600, frames: 120 } });
        await wh.settled();
        const st = wh.stats();
        return { flight: st.flight, streaming: st.streaming, generation: st.generation, tasks: B.longTasks(t0), ms: performance.now() - t0 };
      });
      // Settling after the flight: how long until every wanted cell is drawn.
      const settle = await page.evaluate(async () => {
        const t0 = performance.now();
        window.__wh.setView({});
        await window.__wh.settled();
        return performance.now() - t0;
      });
      const still = await frames(page, { n: N, query: 'pass' });
      runs.push({ rep, ...r, settleMs: settle, still: { wall: median(still.wall), cpu: median(still.cpu), gpu: still.gpu, passes: still.passes, layers: still.layers } });
      console.log(`rep ${rep} (${src}): flight ${JSON.stringify(r.flight)} gen ${JSON.stringify(r.generation)} longest tasks ${r.tasks.map((t) => t.ms.toFixed(0)).sort((a, b) => b - a).slice(0, 6).join(', ')}; settle after ${settle.toFixed(0)} ms; frame at end wall ${median(still.wall).toFixed(2)}`);
    } finally {
      await browser.close();
    }
    if (rep < REPS - 1) await sleep(REST_S / 2);
  }
  save(`flight-endless-${src}`, runs);
  for (const k of ['cpuMsAvg', 'cpuMsMax', 'uploadMsAvg', 'uploadMsMax']) console.log(`${k} ${fmt(summary(runs.map((r) => r.flight[k])))}`);
  console.log(`longest task ${fmt(summary(runs.map((r) => Math.max(0, ...r.tasks.map((t) => t.ms)))), 0)}`);
}

/**
 * The engine's frame profile (`profileFrame` from wallhammer-web/tools) as the page exposes it: `__wh.profile(n)`.
 * Unlike the other commands it patches nothing (no attach): the page measures itself. `--view` names a preset.
 */
async function cmdProfile() {
  const { browser, page } = await launch();
  try {
    await page.goto(URLS[PAGE], { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__wh !== undefined, { timeout: 60000 });
    await page.evaluate(() => window.__wh.ready);
    if (!(await page.evaluate(() => typeof window.__wh.profile === 'function'))) throw new Error(`${PAGE} has no __wh.profile()`);
    const view = arg('view', '');
    if (view) {
      await page.evaluate((name) => {
        const p = window.__wh.presets?.().find((x) => x.name === name);
        if (!p) throw new Error(`no preset ${name}`);
        window.__wh.setView(p);
      }, view);
    }
    await page.evaluate(() => window.__wh.settled?.());
    const p = await page.evaluate((n) => window.__wh.profile(n), N);
    save(`profile-${PAGE}${view ? `-${view}` : ''}`, p);
    const t = (x) => (x === null ? '-' : x.toFixed(2));
    console.log(`${p.gpu}  ${p.width}x${p.height} dpr ${p.dpr}, ${p.samples} samples, shadow map ${p.shadowMapEdgePx} (used ${p.shadowMapPx})`);
    console.log(`empty ${t(p.empty.ms)}  kept ${t(p.kept.ms)} ±${t(p.kept.spreadMs)}  shadow every frame ${t(p.shadow.ms)}${p.running ? `  running ${t(p.running.ms)}` : ''} ms`);
    for (const l of p.layers) console.log(`  ${`${l.index} ${l.name}`.padEnd(32)} color ${t(l.color.ms).padStart(7)}  shadow ${t(l.shadow.ms).padStart(7)} ms`);
  } finally {
    await browser.close();
  }
}

const COMMANDS = { profile: cmdProfile, frames: cmdFrames, counts: cmdCounts, startup: cmdStartup, hitches: cmdHitches, hit: cmdHit, memory: cmdMemory, scale: cmdScale, shadow: cmdShadow, flight: cmdFlight };
if (!COMMANDS[CMD]) {
  console.error(`Unknown command ${CMD}. One of: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(2);
}
await COMMANDS[CMD]();
