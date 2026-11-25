// Pictures of the water plan and the paths without a browser: a map from above, the profile of the largest line and
// a few oblique views, drawn on the CPU from the same functions the page uses. They judge the shape (does the water
// lie in the ground, does it fall, does it reach the sea; where do the paths run), not the final look.
//
// The ground is built as on the page: the field of the whole square, then the path plan on it (`pathPlan`) and the
// paths' treads cut into it (`layPaths`). The checks of the water read the field before the treads are cut. The map
// draws each path's centreline (yellow, its fords magenta) and its places (white squares edged black, junctions small
// black squares); the oblique views tint the ground within `PATH_TINT_M` of a centreline with the colour of earth, and
// include the `path` and `path-above` views. The close-up maps are sampled afresh, without the paths.
//
//   node examples/rivers/scripts/pictures.ts [seed] [outDir]
//   node examples/rivers/scripts/pictures.ts --stats     (the numbers of the first seeds' plans, no pictures)
//   node examples/rivers/scripts/pictures.ts --brooks    (the brooks of seeds 1 to 4 at the default flow: junctions,
//                                                         mouths, crowded mouths and twins; fails on a twin longer
//                                                         than 8 m or more than two crowded mouths)
//
// The pictures go to tools/shot/out/rivers/ (ignored by git) unless another folder is given.

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { groundColour, mix, sat, type V3 } from '../src/colours.ts';
import { fieldOf, type Field } from '../src/field.ts';
import { STEP_M } from '../src/ground-mesh.ts';
import { DEFAULT_BROOK_FLOW, brookCrowding, brookPlan, brookStats } from '../src/brooks.ts';
import { HALF_M, SIZE_M } from '../src/land.ts';
import { layPaths } from '../src/path-ground.ts';
import { pathAt, pathPlan, pathStats, type PathHit, type PathPlan } from '../src/paths.ts';
import { STATION_M, waterPlan, type Line } from '../src/plan.ts';
import { highestFall, viewsOf, widestSwing } from '../src/views.ts';

if (process.argv[2] === '--stats') {
  // Only the numbers of the first seeds: what the plan holds, without pictures.
  for (let s = 1; s <= 8; s++) {
    const p = waterPlan(s);
    let falls = 0;
    let top = 0;
    for (const l of p.lines) for (let i = 0; i + 1 < l.n; i++) if (l.fall[i]) (falls++, (top = Math.max(top, l.level[i]! - l.level[i + 1]!)));
    const lakes = p.lakes.map((l) => `${l.nodes}@${l.level.toFixed(0)}m`).join(' ');
    console.log(`seed ${s}: ${p.lines.length} lines, ${p.lines.filter((l) => l.into >= 0).length} joining another, ${falls} falls (highest ${top.toFixed(0)} m), lakes: ${lakes || 'none'}`);
  }
  process.exit(0);
}
if (process.argv[2] === '--brooks') {
  let bad = 0;
  for (let s = 1; s <= 4; s++) {
    const p = waterPlan(s);
    const bp = brookPlan(p, fieldOf(p, -HALF_M, -HALF_M, SIZE_M, STEP_M), DEFAULT_BROOK_FLOW);
    const st = brookStats(bp);
    const cr = brookCrowding(bp);
    const fail = cr.longestTwinM > 8 || cr.crowdedMouths > 2;
    if (fail) bad++;
    console.log(`seed ${s}: ${st.brooks + st.streams} brooks, ${st.junctions} junctions, ${st.intoWater} mouths; crowded mouths ${cr.crowdedMouths}, twins ${cr.twins} (longest ${cr.longestTwinM.toFixed(1)} m)${fail ? ' FAIL' : ''}`);
  }
  process.exit(bad ? 1 : 0);
}
const seed = Number(process.argv[2] ?? 1);
const outDir = process.argv[3] ?? new URL('../../../tools/shot/out/rivers/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

// --- PNG ----------------------------------------------------------------------------------------------------------
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  b.set(data, 8);
  b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
function savePng(name: string, w: number, h: number, rgb: Uint8Array): void {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  writeFileSync(`${outDir}/${name}`, Buffer.concat([sig, chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));
  console.log(`  ${outDir}/${name}`);
}

// --- The plan and the grids ---------------------------------------------------------------------------------------
let t0 = performance.now();
const plan = waterPlan(seed);
console.log(`plan: seed ${seed}, ${plan.lines.length} lines, ${plan.lakes.length} lakes, ${(performance.now() - t0).toFixed(0)} ms`);

t0 = performance.now();
const world = fieldOf(plan, -HALF_M, -HALF_M, SIZE_M, STEP_M);
console.log(`grid: ${world.n}² points, ${(((performance.now() - t0) * 1000) / (world.n * world.n)).toFixed(2)} µs a point`);

// --- Checks -------------------------------------------------------------------------------------------------------
// Raised water: a wet point beside a point whose own level is lower and whose ground lies under this point's water,
// away from a declared fall. The water would have to stand there as a wall.
const raised = new Uint8Array(world.n * world.n);
let raisedCount = 0;
let wetLine = 0;
{
  const n = world.n;
  for (let j = 1; j < n - 1; j++)
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      const w = world.water[k]!;
      if (w <= world.ground[k]! + 0.02) continue;
      if (world.body[k] === 2) wetLine++;
      if (world.fall[k]) continue;
      for (const q of [k - 1, k + 1, k - n, k + n]) {
        if (world.fall[q]) continue;
        // Along a line the level may slope; against anything else it may not differ.
        const slack = world.body[k] === 2 && world.body[q] === 2 ? 0.25 + 1.2 * STEP_M : 0.25;
        if (world.water[q]! < w - slack && world.ground[q]! < w - 0.05) {
          raised[k] = 1;
          raisedCount++;
          break;
        }
      }
    }
}
let uphill = 0;
let falls = 0;
for (const l of plan.lines) {
  for (let i = 0; i + 1 < l.n; i++) {
    if (l.level[i + 1]! > l.level[i]! + 1e-9) uphill++;
    falls += l.fall[i]!;
  }
}
const lengthOf = (x: Float64Array, z: Float64Array): number => {
  let s = 0;
  for (let i = 0; i + 1 < x.length; i++) s += Math.hypot(x[i + 1]! - x[i]!, z[i + 1]! - z[i]!);
  return s;
};
console.log(`checks: ${uphill} stretches uphill, ${raisedCount} raised points of ${wetLine} wet points of lines, ${falls} falls`);
plan.lines.forEach((l, i) => {
  const drop = l.level[0]! - l.level[l.n - 1]!;
  let top = 0;
  for (let k = 0; k + 1 < l.n; k++) if (l.fall[k]) top = Math.max(top, l.level[k]! - l.level[k + 1]!);
  console.log(
    `  line ${i}: into ${l.into}, ${(lengthOf(l.ax, l.az) / 1000).toFixed(2)} km, winding ${(lengthOf(l.cx, l.cz) / lengthOf(l.ax, l.az)).toFixed(2)}, drop ${drop.toFixed(0)} m, basin ${l.flow}, highest fall ${top.toFixed(1)} m`,
  );
});
plan.lakes.forEach((l, i) => console.log(`  lake ${i}: level ${l.level.toFixed(1)} m, ${l.nodes} nodes at ${l.x.toFixed(0)}, ${l.z.toFixed(0)}`));

// --- The paths ----------------------------------------------------------------------------------------------------
// As on the page: planned on the finished field, then cut into it. The checks above read the field before this.
t0 = performance.now();
const paths = pathPlan(plan, world);
const pathMs = performance.now() - t0;
layPaths(world, paths);
console.log(`paths: ${paths.paths.length} paths, ${paths.places.length} places, ${pathMs.toFixed(0)} ms`);
pathStats(paths).forEach((s, i) =>
  console.log(
    `  path ${i}: ${s.from} → ${s.to}, ${s.lengthM.toFixed(0)} m, steepest ${(s.maxGrade * 100).toFixed(0)} %, ${s.fords} ford${s.fords === 1 ? '' : 's'}${s.fords ? ` (widest ${s.widestFordM.toFixed(0)} m)` : ''}`,
  ),
);

// --- Sampling of a grid -------------------------------------------------------------------------------------------
const hit = { ground: 0, water: -Infinity, bodyLevel: 0, fall: 0 };
/** Ground and water surface at a point of a grid; `water` is −∞ where the point is dry. */
function probe(g: Field, x: number, z: number): void {
  const fx = (x - g.x0) / g.step;
  const fz = (z - g.z0) / g.step;
  if (fx < 0 || fz < 0 || fx >= g.n - 1 || fz >= g.n - 1) {
    hit.ground = -45;
    hit.water = 0;
    hit.bodyLevel = 0;
    hit.fall = 0;
    return;
  }
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * g.n + i;
  const w00 = (1 - u) * (1 - v);
  const w10 = u * (1 - v);
  const w01 = (1 - u) * v;
  const w11 = u * v;
  const g00 = g.ground[k]!;
  const g10 = g.ground[k + 1]!;
  const g01 = g.ground[k + g.n]!;
  const g11 = g.ground[k + g.n + 1]!;
  hit.ground = g00 * w00 + g10 * w10 + g01 * w01 + g11 * w11;
  const d00 = g.water[k]! - g00;
  const d10 = g.water[k + 1]! - g10;
  const d01 = g.water[k + g.n]! - g01;
  const d11 = g.water[k + g.n + 1]! - g11;
  hit.bodyLevel = Math.max(g.water[k]!, g.water[k + 1]!, g.water[k + g.n]!, g.water[k + g.n + 1]!);
  hit.water = -Infinity;
  hit.fall = 0;
  if (d00 <= 0 && d10 <= 0 && d01 <= 0 && d11 <= 0) return;
  const depth = Math.max(d00, -0.7) * w00 + Math.max(d10, -0.7) * w10 + Math.max(d01, -0.7) * w01 + Math.max(d11, -0.7) * w11;
  if (depth <= 0) return;
  let s = 0;
  let ws = 0;
  if (d00 > 0) (s += g.water[k]! * w00), (ws += w00);
  if (d10 > 0) (s += g.water[k + 1]! * w10), (ws += w10);
  if (d01 > 0) (s += g.water[k + g.n]! * w01), (ws += w01);
  if (d11 > 0) (s += g.water[k + g.n + 1]! * w11), (ws += w11);
  hit.water = ws > 0 ? s / ws : -Infinity;
  hit.fall = g.fall[k]! | g.fall[k + 1]! | g.fall[k + g.n]! | g.fall[k + g.n + 1]!;
}
const surface = (g: Field, x: number, z: number): number => {
  probe(g, x, z);
  return Math.max(hit.ground, hit.water);
};

// --- Colours ------------------------------------------------------------------------------------------------------
const SUN: V3 = (() => {
  const v: V3 = [-0.55, 0.62, -0.45];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();
const SKY: V3 = [0.62, 0.74, 0.88];

function waterColour(depth: number, under: V3): V3 {
  const body = mix([0.2, 0.47, 0.47], [0.04, 0.17, 0.3], 1 - Math.exp(-depth / 2.2));
  return mix(under, body, 1 - Math.exp(-depth * 2.5));
}
/** Normal of the ground of a grid at a point. */
function groundNormal(g: Field, x: number, z: number): V3 {
  const e = g.step * 0.5;
  probe(g, x - e, z);
  const a = hit.ground;
  probe(g, x + e, z);
  const b = hit.ground;
  probe(g, x, z - e);
  const c = hit.ground;
  probe(g, x, z + e);
  const d = hit.ground;
  const nx = (a - b) / (2 * e);
  const nz = (c - d) / (2 * e);
  const l = Math.hypot(nx, 1, nz);
  return [nx / l, 1 / l, nz / l];
}

// --- The map ------------------------------------------------------------------------------------------------------
function map(name: string, g: Field, flags: Uint8Array | null, pp: PathPlan | null = null): void {
  const n = g.n;
  const rgb = new Uint8Array(n * n * 3);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = g.x0 + i * g.step;
      const z = g.z0 + j * g.step;
      const h = g.ground[k]!;
      const nrm = groundNormal(g, Math.min(Math.max(x, g.x0 + g.step), g.x0 + (n - 2) * g.step), Math.min(Math.max(z, g.z0 + g.step), g.z0 + (n - 2) * g.step));
      const light = 0.35 + 0.85 * sat(nrm[0] * SUN[0] + nrm[1] * SUN[1] + nrm[2] * SUN[2]);
      let c = groundColour(h, 1 - nrm[1], h - g.water[k]!);
      c = [c[0] * light, c[1] * light, c[2] * light];
      const depth = g.water[k]! - h;
      if (depth > 0) {
        c = waterColour(depth, c);
        if (g.body[k] !== 0) c = mix(c, [0.3, 0.62, 0.85], 0.35);
        if (g.fall[k]) c = mix(c, [1, 1, 1], 0.85);
        else if (g.body[k] === 2 && i > 0 && j > 0 && i < n - 1 && j < n - 1) {
          // White water where the level slopes.
          const sl = Math.hypot(g.water[k + 1]! - g.water[k - 1]!, g.water[k + n]! - g.water[k - n]!) / (2 * g.step);
          c = mix(c, [1, 1, 1], 0.7 * sat((sl - 0.05) / 0.3));
        }
      }
      if (flags?.[k]) c = [1, 0.1, 0.1];
      rgb[k * 3] = 255 * sat(c[0]) ** 0.8;
      rgb[k * 3 + 1] = 255 * sat(c[1]) ** 0.8;
      rgb[k * 3 + 2] = 255 * sat(c[2]) ** 0.8;
    }
  if (pp) drawPaths(rgb, g, pp);
  savePng(name, n, n, rgb);
}

/** The paths over a map of a grid: each centreline a line of pixels, each place a small mark. */
function drawPaths(rgb: Uint8Array, g: Field, pp: PathPlan): void {
  const n = g.n;
  const dot = (i: number, j: number, c: readonly number[]): void => {
    if (i < 0 || j < 0 || i >= n || j >= n) return;
    rgb.set(c, (j * n + i) * 3);
  };
  for (const p of pp.paths) {
    for (let s = 0; s + 1 < p.n; s++) {
      // Two pixels wide; a ford three, so it shows on the water.
      const ford = p.ford[s] || p.ford[s + 1];
      const c = ford ? [240, 40, 230] : [255, 220, 0];
      const wide = ford ? 2 : 1;
      const i0 = (p.x[s]! - g.x0) / g.step;
      const j0 = (p.z[s]! - g.z0) / g.step;
      const i1 = (p.x[s + 1]! - g.x0) / g.step;
      const j1 = (p.z[s + 1]! - g.z0) / g.step;
      const steps = Math.max(1, Math.ceil(2 * Math.hypot(i1 - i0, j1 - j0)));
      for (let t = 0; t <= steps; t++) {
        const i = Math.round(i0 + ((i1 - i0) * t) / steps);
        const j = Math.round(j0 + ((j1 - j0) * t) / steps);
        for (let dj = 0; dj <= wide; dj++) for (let di = 0; di <= wide; di++) if (di + dj <= wide) dot(i + di - (wide >> 1), j + dj - (wide >> 1), c);
      }
    }
  }
  for (const place of pp.places) {
    const ci = Math.round((place.x - g.x0) / g.step);
    const cj = Math.round((place.z - g.z0) / g.step);
    const r = place.name === 'junction' ? 2 : 4;
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const edge = Math.max(Math.abs(di), Math.abs(dj)) >= r - 1;
        dot(ci + di, cj + dj, edge ? [10, 10, 10] : [255, 255, 255]);
      }
  }
}

// --- The profile of a line ----------------------------------------------------------------------------------------
function profile(name: string, l: Line): void {
  const w = 1400;
  const h = 480;
  const rgb = new Uint8Array(w * h * 3).fill(250);
  const top = Math.max(...l.natural) + 5;
  const px = (i: number): number => Math.round(20 + ((w - 40) * i) / (l.n - 1));
  const py = (v: number): number => Math.round(h - 20 - ((h - 40) * (v + 5)) / (top + 5));
  const dot = (x: number, y: number, c: V3): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    rgb.set([c[0], c[1], c[2]], (y * w + x) * 3);
  };
  const stroke = (v: (i: number) => number, c: V3): void => {
    for (let i = 0; i + 1 < l.n; i++) {
      const x0 = px(i);
      const x1 = px(i + 1);
      const y0 = py(v(i));
      const y1 = py(v(i + 1));
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const y = Math.round(y0 + ((y1 - y0) * s) / steps);
        dot(x, y, c);
        dot(x, y + 1, c);
      }
    }
  };
  for (let x = 20; x < w - 20; x++) dot(x, py(0), [150, 170, 220]);
  for (let i = 0; i < l.n; i++) if (l.fall[i]) for (let y = py(l.level[i]!); y <= py(l.level[i + 1]!); y++) dot(px(i), y, [230, 60, 60]);
  stroke((i) => l.natural[i]!, [120, 120, 120]);
  stroke((i) => l.level[i]! - l.depth[i]!, [150, 100, 50]);
  stroke((i) => l.level[i]!, [30, 90, 220]);
  // The swing of the channel, along the bottom: how far the channel leaves the floor's middle.
  for (let i = 0; i < l.n; i++) dot(px(i), h - 4 - Math.round(Math.hypot(l.cx[i]! - l.ax[i]!, l.cz[i]! - l.az[i]!) / 4), [40, 160, 80]);
  savePng(name, w, h, rgb);
}

// --- An oblique view ----------------------------------------------------------------------------------------------
/** In an oblique view the ground this near a path's centreline takes the colour of earth, metres. */
const PATH_TINT_M = 0.6;
const EARTH: V3 = [0.44, 0.38, 0.28];
const pathHit: PathHit = { d: 0, ox: 0, oz: 0, y: 0, ford: 0, path: 0, i: 0, t: 0 };

function view(name: string, g: Field, eye: V3, target: V3, fovDeg = 58, pp: PathPlan | null = null, w = 1120, h = 630): void {
  const start = performance.now();
  const f: V3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const fl = Math.hypot(f[0], f[1], f[2]);
  f[0] /= fl;
  f[1] /= fl;
  f[2] /= fl;
  const r: V3 = [-f[2], 0, f[0]];
  const rl = Math.hypot(r[0], r[2]);
  r[0] /= rl;
  r[2] /= rl;
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const tan = Math.tan((fovDeg * Math.PI) / 360);
  const rgb = new Uint8Array(w * h * 3);
  const TOP = 460;
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      const sx = ((2 * (px + 0.5)) / w - 1) * tan * (w / h);
      const sy = (1 - (2 * (py + 0.5)) / h) * tan;
      let dx = f[0] + r[0] * sx + u[0] * sy;
      let dy = f[1] + r[1] * sx + u[1] * sy;
      let dz = f[2] + r[2] * sx + u[2] * sy;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl;
      dy /= dl;
      dz /= dl;
      let c: V3 = mix([0.78, 0.85, 0.93], SKY, sat(dy * 3 + 0.1));
      let t = 0.5;
      let found = -1;
      let prev = 0;
      if (eye[1] > TOP && dy < 0) t = (eye[1] - TOP) / -dy;
      for (let step = 0; step < 4000 && t < 9000; step++) {
        const y = eye[1] + dy * t;
        if (y > TOP && dy >= 0) break;
        if (y <= surface(g, eye[0] + dx * t, eye[2] + dz * t)) {
          found = t;
          break;
        }
        prev = t;
        t += Math.max(0.6, t * 0.004);
      }
      if (found >= 0) {
        let a = prev;
        let b = found;
        for (let k = 0; k < 10; k++) {
          const m = 0.5 * (a + b);
          if (eye[1] + dy * m <= surface(g, eye[0] + dx * m, eye[2] + dz * m)) b = m;
          else a = m;
        }
        t = b;
        const x = eye[0] + dx * t;
        const z = eye[2] + dz * t;
        probe(g, x, z);
        const ground = hit.ground;
        const water = hit.water;
        const fall = hit.fall;
        const bodyLevel = hit.bodyLevel;
        const nrm = groundNormal(g, x, z);
        // Shadow of the ground on the point.
        let lit = 1;
        const y0 = Math.max(ground, water) + 0.3;
        for (let s = 2; s < 500; s += Math.max(2, s * 0.08)) {
          const yy = y0 + SUN[1] * s;
          if (yy > TOP) break;
          probe(g, x + SUN[0] * s, z + SUN[2] * s);
          if (hit.ground > yy) {
            lit = 0.25;
            break;
          }
        }
        const diffuse = sat(nrm[0] * SUN[0] + nrm[1] * SUN[1] + nrm[2] * SUN[2]) * lit;
        const light = 0.33 + 0.9 * diffuse;
        let col = groundColour(ground, 1 - nrm[1], ground - bodyLevel);
        if (pp && water <= ground && pathAt(pp, x, z, pathHit) && pathHit.d < PATH_TINT_M) col = mix(col, EARTH, 1 - pathHit.ford);
        col = [col[0] * light, col[1] * light, col[2] * light];
        if (water > ground) {
          // The water's own slope tells a fall from flat water.
          const e = g.step;
          const wx = surface(g, x + e, z) - surface(g, x - e, z);
          const wz = surface(g, x, z + e) - surface(g, x, z - e);
          const steep = Math.hypot(wx, wz) / (2 * e);
          col = waterColour(water - ground, col);
          const wn: V3 = steep > 0.02 ? [-wx / (2 * e), 1, -wz / (2 * e)] : [0, 1, 0];
          const wl = Math.hypot(wn[0], wn[1], wn[2]);
          const cos = sat(-(dx * wn[0] + dy * wn[1] + dz * wn[2]) / wl);
          const fresnel = 0.03 + 0.97 * (1 - cos) ** 5;
          col = mix(col, [SKY[0] * 0.95, SKY[1] * 0.95, SKY[2] * 0.95], fresnel * 0.8);
          col = [col[0] * (0.55 + 0.45 * lit), col[1] * (0.55 + 0.45 * lit), col[2] * (0.55 + 0.45 * lit)];
          // White water: on a fall, and a little where the water runs steeply.
          const streak = 0.75 + 0.25 * Math.sin(x * 2.1 + z * 1.7) * Math.sin(x * 0.63 - z * 0.9);
          const white = Math.max(fall ? sat((steep - 0.3) / 0.5) * streak : 0, sat((steep - 0.05) / 0.3) * 0.75 * streak);
          col = mix(col, [0.93, 0.95, 0.96], white);
        }
        c = mix(col, [0.74, 0.81, 0.9], 1 - Math.exp(-t / 5000));
      }
      const k = (py * w + px) * 3;
      rgb[k] = 255 * sat(c[0]) ** 0.8;
      rgb[k + 1] = 255 * sat(c[1]) ** 0.8;
      rgb[k + 2] = 255 * sat(c[2]) ** 0.8;
    }
  savePng(name, w, h, rgb);
  console.log(`    ${((performance.now() - start) / 1000).toFixed(1)} s`);
}

// --- What to look at ----------------------------------------------------------------------------------------------
console.log('pictures:');
map(`map-${seed}.png`, world, raised, paths);
const main = plan.lines[0];
if (main) profile(`profile-${seed}.png`, main);
for (const v of viewsOf(plan, paths)) view(`${v.name}-${seed}.png`, world, v.eye, v.target, v.fov, paths);
// Close-up maps of the highest fall and of the widest swing of the largest line.
const top = highestFall(plan);
if (top) {
  const size = 400;
  map(`map-fall-${seed}.png`, fieldOf(plan, top.line.cx[top.i]! - size / 2, top.line.cz[top.i]! - size / 2, size, 0.5), null);
}
if (main) {
  const mi = widestSwing(main);
  const size = 600;
  map(`map-bends-${seed}.png`, fieldOf(plan, main.ax[mi]! - size / 2, main.az[mi]! - size / 2, size, 0.75), null);
}
console.log(`stations every ${STATION_M} m, ground every ${STEP_M} m`);
