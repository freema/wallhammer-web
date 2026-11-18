// Reproducible screenshots of fixed views. Runs on the host, because the real GPU decides the image:
// opens the installed headless Chrome against a running page and saves PNGs. The default page is the campus page of
// the city model project (port 5280), an external app that uses the engine; the examples of this repository are
// served at http://127.0.0.1:5281/<name>/ (docker compose up -d).
// Its one dependency, puppeteer-core, lives in tools/shot/node_modules (outside git): run `npm ci` in tools/shot once
// before the first shot. Without it the script stops at the import with ERR_MODULE_NOT_FOUND.
// The view names (celek, ulice, …) name places of that app; the --pohyb flag and the values of --mode, --weather,
// --surface and --buildings are identifiers defined by that external app. All of them stay exactly as it spells them.
//
//   node shot.mjs                         all views into ./out
//   node shot.mjs --views celek,ulice     only the listed ones
//   node shot.mjs --out ./somewhere
//   node shot.mjs --url http://127.0.0.1:5280 --size 1600x900 --dpr 1 --bench
//   node shot.mjs --ui                    shot including the status line and controls
//   node shot.mjs --at corner:0:4:640:215 extra view: name:rotation:zoom:x:z
//   node shot.mjs --time 0,2,4            animation time in seconds (default 0); more values = more shots with suffix -t2
//   node shot.mjs --mode den --tod 6,13,20.5   light mode and hour of day; more hours = shots with suffix -h0600
//   node shot.mjs --hash 'x=640&z=215&zoom=5&rot=1' --name corner   view from a URL (the part after #) as a single shot
//   node shot.mjs --data                  data view (ground by class, footprints, axes)
//   node shot.mjs --weather zima          weather: a preset or the URL encoding (parameter w)
//   node shot.mjs --surface puvodni       surface: puvodni (raster before cleanup) or uklid (default)
//   node shot.mjs --buildings puvodni     building detail: puvodni (simple window grid) or novy (default)
//   node shot.mjs --pohyb                 with the moving figures and vehicles (off by default, so older shots stay valid)
//   node shot.mjs --url http://127.0.0.1:5281/minimal-3d/ --tod 13,21 --format jpeg   orbit page (examples/minimal-3d): its own
//                                         views, or --orbit name:yaw:pitch:distance[,…]; --weather clear|clouds|rain|snow|fog
//   node shot.mjs --url http://127.0.0.1:5281/minimal-3d/ --tick 0,600   orbit page: simulation frozen at these ticks (suffix -k600)
//
// Animation time is always frozen at the given value, so the same input always gives the same image.
// With --bench it measures a still scene, a scene with wind and clouds, and in day mode also sun movement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL_ = arg('url', 'http://127.0.0.1:5280/');
const OUT = path.resolve(arg('out', path.join(HERE, 'out')));
const [W, H] = arg('size', '1600x900').split('x').map(Number);
const DPR = Number(arg('dpr', '1'));
const ONLY = arg('views', '');
const ONLY_EXTRA = !ONLY && (arg('at', '') !== '' || arg('hash', '') !== '');
const BENCH = process.argv.includes('--bench');
const MODE = arg('mode', 'atelier');
const TIMES = arg('time', '0').split(',').map(Number);
const TODS = arg('tod', '').split(',').filter(Boolean).map(Number);
const WITH_UI = process.argv.includes('--ui');
const HASH = arg('hash', '').replace(/^#/, '');
const HASH_NAME = arg('name', 'adresa');
const DATA = process.argv.includes('--data');
const WEATHER = arg('weather', '');
const SURFACE = arg('surface', '');
const BUILDINGS = arg('buildings', '');
const POHYB = process.argv.includes('--pohyb');
// Orbit pages (examples/minimal-3d): views as name:yaw:pitch:distance, image format and JPEG quality.
const ORBIT = arg('orbit', '');
const FORMAT = arg('format', 'png') === 'jpeg' ? 'jpeg' : 'png';
const QUALITY = Number(arg('quality', '88'));
const SIM_TICKS = arg('tick', '').split(',').filter(Boolean).map(Number);
const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

// Fixed views. The centre is in local metres: x east, z south from the north-west corner of the extent.
const VIEWS = [
  { name: 'celek', rotation: 0, zoom: 1 },
  { name: 'celek-otoceni-1', rotation: 1, zoom: 1 },
  { name: 'celek-otoceni-2', rotation: 2, zoom: 1 },
  { name: 'celek-otoceni-3', rotation: 3, zoom: 1 },
  { name: 'stred', rotation: 0, zoom: 2, center: [690, 250] },
  { name: 'kampus', rotation: 0, zoom: 3, center: [860, 300] },
  { name: 'kampus-otoceni-2', rotation: 2, zoom: 3, center: [860, 300] },
  { name: 'radovky', rotation: 0, zoom: 3, center: [470, 130] },
  { name: 'radovky-otoceni-1', rotation: 1, zoom: 3, center: [470, 130] },
  { name: 'ulice', rotation: 0, zoom: 4, center: [640, 215] },
  { name: 'ulice-otoceni-3', rotation: 3, zoom: 4, center: [1010, 120] },
  { name: 'detail', rotation: 0, zoom: 5, center: [880, 265] },
  // Building edges next to trees in all four rotations: a crown must not be inside a wall.
  { name: 'zdi-0', rotation: 0, zoom: 4, center: [640, 215] },
  { name: 'zdi-1', rotation: 1, zoom: 4, center: [640, 215] },
  { name: 'zdi-2', rotation: 2, zoom: 4, center: [640, 215] },
  { name: 'zdi-3', rotation: 3, zoom: 4, center: [640, 215] },
  { name: 'zdi-blizko', rotation: 0, zoom: 5, center: [620, 200] },
  // Forest from above: no grid. Street: trees in a row.
  { name: 'les', rotation: 0, zoom: 3, center: [250, 330] },
  { name: 'les-blizko', rotation: 1, zoom: 4, center: [230, 300] },
  { name: 'stromoradi', rotation: 0, zoom: 4, center: [455, 235] },
  { name: 'daleko', rotation: 0, zoom: 0 },
  // The whole extent one zoom step closer. It does not fit a normal window, so the view has its own size.
  { name: 'prehled', rotation: 0, zoom: 2, size: [2200, 1150] },
  { name: 'prehled-otoceni-2', rotation: 2, zoom: 2, size: [2200, 1150] },
];

// Extra views from the command line: --at name:rotation:zoom:x:z (separate several with commas).
for (const spec of arg('at', '').split(',').filter(Boolean)) {
  const [name, rotation, zoom, x, z] = spec.split(':');
  VIEWS.push({ name, rotation: Number(rotation), zoom: Number(zoom), center: [Number(x), Number(z)], extra: true });
}

if (!CHROME) {
  console.error('Chrome not found. Set CHROME_PATH.');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    `--window-size=${W},${H}`,
    '--hide-scrollbars',
    // Headless Chrome otherwise renders in software. These switches enable the real GPU via ANGLE.
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
  ],
});

let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[exception] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[network] ${r.url()} ${r.failure()?.errorText ?? ''}`));

  // Markers from localStorage do not belong in shots: every run starts with empty page storage.
  await page.goto(HASH ? `${URL_}#${HASH}` : URL_, { waitUntil: 'load', timeout: 60000 });
  // On first load Vite pre-bundles dependencies and reloads the page itself. Hence a few attempts.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForFunction(() => window.__wh !== undefined, { timeout: 30000 });
      await page.evaluate(() => window.__wh.ready);
      break;
    } catch (e) {
      if (attempt >= 3 || !String(e).includes('context')) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // A page with an orbit view (for example examples/minimal-3d) has its own, smaller interface: named views,
  // hour of day, animation time and weather. The campus flow below does not apply to it.
  const kind = await page.evaluate(() => window.__wh.kind ?? 'campus');
  if (kind === 'orbit') {
    const views = ORBIT
      ? ORBIT.split(',').map((spec) => {
          const [name, yawDeg, pitchDeg, distance] = spec.split(':');
          return { name, yawDeg: Number(yawDeg), pitchDeg: Number(pitchDeg), distance: Number(distance) };
        })
      : await page.evaluate(() => window.__wh.presets());
    const info0 = await page.evaluate(() => window.__wh.stats());
    console.log(`graphics: ${info0.renderer}, seed ${info0.seed}`);
    if (WEATHER) await page.evaluate((w) => window.__wh.setWeather(w), WEATHER);
    const hours = TODS.length ? TODS : [null];
    const ticks = SIM_TICKS.length ? SIM_TICKS : [null];
    for (const v of views) {
      for (const tod of hours) {
        for (const time of TIMES) {
         for (const tick of ticks) {
          const info = await page.evaluate(
            (v, tod, time, bench, tick) => {
              const wh = window.__wh;
              if (tick !== null) wh.setTick(tick);
              if (tod !== null) wh.setTimeOfDay(tod);
              wh.setTime(time);
              wh.setView(v);
              const s = wh.stats();
              return { ...s, ms: bench ? wh.benchmark(30) : null };
            },
            v,
            tod,
            time,
            BENCH,
            tick,
          );
          // A streamed page completes its image over several frames: wait until it reports settled.
          if (await page.evaluate(() => typeof window.__wh.settled === 'function')) {
            Object.assign(info, await page.evaluate(async () => (await window.__wh.settled(), window.__wh.stats())));
          } else {
            // Without `settled` the stats above belong to the frame before the new view: read them two frames later.
            Object.assign(info, await page.evaluate(async () => {
              for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
              return window.__wh.stats();
            }));
          }
          let name = v.name;
          if (tod !== null && TODS.length > 1) name += `-h${String(Math.floor(tod)).padStart(2, '0')}${String(Math.round((tod % 1) * 60)).padStart(2, '0')}`;
          if (TIMES.length > 1) name += `-t${time}`;
          if (tick !== null) name += `-k${tick}`;
          const file = path.join(OUT, `${name}.${FORMAT === 'jpeg' ? 'jpg' : 'png'}`);
          await page.screenshot({ path: file, type: FORMAT, ...(FORMAT === 'jpeg' ? { quality: QUALITY } : {}) });
          // `instancesVisible` is the renderer's count of instances kept by the last view culling. Layers that do not
          // cull add nothing to it; before engine M3 that held for `InstanceSetLayer`, so pages drawing only instance
          // sets reported 0. The stats are read after `settled()` when the page has it, otherwise two frames after the view.
          console.log(
            `${name}: ${(info.triangles / 1e6).toFixed(2)} M triangles, ${info.drawCalls} draw calls, shadows ${(info.shadowTriangles / 1e6).toFixed(2)} M in ${info.shadowMapPx} px, ` +
              `${info.instancesVisible} instances${info.ms !== null ? `, ${info.ms.toFixed(2)} ms/frame` : ''} → ${file}`,
          );
         }
        }
      }
    }
  } else {
    const first = await page.evaluate(() => {
      const s = window.__wh.stats();
      const gl = document.createElement('canvas').getContext('webgl2');
      return { stats: s, home: window.__wh.getView().center, webgl2: !!gl, version: gl ? gl.getParameter(gl.VERSION) : null };
    });
    console.log(`WebGL2: ${first.webgl2 ? 'yes' : 'NO'} (${first.version})`);
    console.log(`graphics: ${first.stats.renderer}`);
    console.log(`scene: ${JSON.stringify(first.stats.scene)}`);
    if (!first.webgl2) failed = true;

    // Post-generation check (crowns in walls, floating objects). A finding is an error.
    const checks = await page.evaluate(() => (window.__wh.checks ? window.__wh.checks() : null));
    if (checks) {
      const { problems: found, ...numbers } = checks;
      console.log(`check: ${JSON.stringify(numbers)}`);
      if (!checks.ok) {
        failed = true;
        for (const p of found) console.log('  ' + p);
      }
    }

    // The surface is switched once for all shots. It rebuilds ground and trees, so it happens before the result check.
    if (SURFACE) {
      const st = await page.evaluate((s) => window.__wh.setSurface(s), SURFACE);
      const c = await page.evaluate(() => window.__wh.checks());
      console.log(`surface: ${st.surface}, check: ${c.ok ? 'no findings' : 'FINDINGS'}, ${c.trees} trees`);
      if (!c.ok) failed = true;
    }

    // Building detail is switched once for all shots; it rebuilds the building mesh, so the check runs again.
    if (BUILDINGS) {
      const st = await page.evaluate((b) => window.__wh.setBuildingDetail(b), BUILDINGS);
      const c = await page.evaluate(() => window.__wh.checks());
      console.log(`building detail: ${st.buildings}, check: ${c.ok ? 'no findings' : 'FINDINGS'}`);
      if (!c.ok) {
        failed = true;
        for (const p of c.problems) console.log('  ' + p);
      }
    }

    // View from the URL: the page restores it on load by itself, the shot is just taken.
    if (HASH) {
      const info = await page.evaluate(
        (withUi, data, weather, pohyb) => {
          if (!withUi) for (const id of ['hud', 'controls', 'timebar', 'debug']) document.getElementById(id).style.display = 'none';
          const wh = window.__wh;
          if (data) wh.setDataView(true);
          if (weather && wh.setWeather) wh.setWeather(weather);
          wh.setPopulation?.(pohyb);
          const pop = pohyb ? (wh.flushPopulation?.() ?? null) : null;
          const s = wh.stats();
          return { tris: s.triangles, calls: s.drawCalls, view: wh.getView(), url: location.hash, pop };
        },
        WITH_UI,
        DATA,
        WEATHER,
        POHYB,
      );
      const file = path.join(OUT, `${HASH_NAME}.png`);
      await page.screenshot({ path: file, type: 'png' });
      console.log(`${HASH_NAME}: ${info.url} · ${(info.tris / 1e6).toFixed(2)} M triangles, ${info.calls} draw calls → ${file}`);
      if (info.pop) console.log(`  moving population: ${JSON.stringify(info.pop)}`);
    }

    const wanted = ONLY ? ONLY.split(',') : null;
    for (const v of VIEWS) {
      // Views from --at are always taken; when only they are given, the fixed views are skipped.
      if (!v.extra && (wanted ? !wanted.includes(v.name) : ONLY_EXTRA)) continue;
      const [vw, vh] = v.size ?? [W, H];
      const now = page.viewport();
      if (now.width !== vw || now.height !== vh) {
        await page.setViewport({ width: vw, height: vh, deviceScaleFactor: DPR });
        // The canvas adapts only after a layout pass, so we wait two frames for it.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
      const hours = TODS.length ? TODS : [null];
      for (const tod of hours) {
        for (const time of TIMES) {
          const info = await page.evaluate(
            (view, bench, withUi, mode, tod, time, data, weather, pohyb) => {
              // Neither the status line nor the controls belong in the shot unless asked for (--ui).
              if (!withUi) for (const id of ['hud', 'controls', 'timebar', 'debug']) document.getElementById(id).style.display = 'none';
              const wh = window.__wh;
              wh.setDataView(data);
              if (weather && wh.setWeather) wh.setWeather(weather);
              wh.setMode(mode);
              if (tod !== null) wh.setTimeOfDay(tod);
              wh.setTime(time);
              wh.setView(view);
              wh.setPopulation?.(pohyb);
              if (pohyb) wh.flushPopulation?.();
              const s = wh.stats();
              const ms = bench ? wh.benchmark(30) : null;
              const msAnim = bench ? wh.benchmark(30, { dt: 1 / 60 }) : null;
              const msSun = bench && mode === 'den' ? wh.benchmark(30, { dt: 1 / 60, hoursPerSecond: 1 }) : null;
              return { tris: s.triangles, calls: s.drawCalls, shadowTris: s.shadowTriangles, shadowPx: s.shadowMapPx, trees: s.treesVisible, cpuMs: s.cpuMs, ms, msAnim, msSun };
            },
            // A view without a centre aims at the extent centre, not where the previous one ended.
            { rotation: v.rotation, zoom: v.zoom, center: v.center ?? first.home },
            BENCH,
            WITH_UI,
            MODE,
            tod,
            time,
            DATA,
            WEATHER,
            POHYB,
          );
          let name = v.name;
          if (tod !== null && TODS.length > 1) name += `-h${String(Math.floor(tod)).padStart(2, '0')}${String(Math.round((tod % 1) * 60)).padStart(2, '0')}`;
          if (TIMES.length > 1) name += `-t${time}`;
          const file = path.join(OUT, `${name}.png`);
          await page.screenshot({ path: file, type: 'png' });
          const bench =
            info.ms !== null
              ? `, ${info.ms.toFixed(2)} ms/frame still, ${info.msAnim.toFixed(2)} ms animated` + (info.msSun !== null ? `, ${info.msSun.toFixed(2)} ms with the sun moving` : '')
              : '';
          console.log(
            `${name}: ${(info.tris / 1e6).toFixed(2)} M triangles, ${info.calls} draw calls, shadows ${(info.shadowTris / 1e6).toFixed(2)} M in ${info.shadowPx} px, ` +
              `${info.trees} trees${bench} → ${file}`,
          );
        }
      }
    }
  }

  if (problems.length) {
    failed = true;
    console.log(`\nThe console reports ${problems.length} problems:`);
    for (const p of problems.slice(0, 30)) console.log('  ' + p);
  } else {
    console.log('\nThe console is clean.');
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
