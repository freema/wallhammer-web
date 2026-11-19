// Checks the planet example without a browser:
//   - the generator: a cell's bytes do not depend on which cells were generated before it, they survive a round trip
//     through the cell format, and every object of a cell (the thinned trees of levels 7 to 9 too) is found again in
//     exactly one of its children;
//   - the flight: it starts and ends at the same pose, climbs without a step and reaches a height from which the
//     whole sphere with its air fits the view;
//   - the streaming along the flight with the real cells: the sphere is covered at every step, nothing is drawn
//     twice, the plan stays inside its budget of cells, and the bytes held at the worst moment fit the GPU budget;
//   - the movie (movie.ts): every shot keeps above the ground (with the strips; under the sea above its floor and
//     under the troughs) and moves without a jump inside it.
//
//   node scripts/verify.ts [--seed 2611] [--height 1080] [--width 1920]
//
// --height and --width are the size of the drawing surface in physical pixels the flight is checked for.

import { cellKey } from 'wallhammer-web/gen-core';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { decodeCell, encodeCell, pixelsPerRadian } from 'wallhammer-web/world';
import { DEFAULT_FLIGHT, flightDuration, flightPose, wholeSphereHeight } from '../src/flight.ts';
import { checkFlight } from '../src/flight-check.ts';
import { planMovie } from '../src/movie.ts';
import { stripGroundHeight } from '../src/strips.ts';
import { planetWeatherAt } from '../src/weather.ts';
import { AIR_HEIGHT_M, DEFAULT_SEED, LEAF_LEVEL, MIN_SPLIT_EDGES, OBJECT_LEVEL, RADIUS_M, SELECTION, SHAPE, directionAt, findStart, generatePlanetCell, surfaceHeight } from '../src/world.ts';

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && Number.isFinite(Number(process.argv[i + 1])) ? Number(process.argv[i + 1]) : d;
};
const seed = arg('seed', DEFAULT_SEED);
const viewH = arg('height', 1080);
const viewW = arg('width', 1920);
const FOV_DEG = 50;
const MB = 1048576;
const problems: string[] = [];
const fail = (m: string): void => void problems.push(m);
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

// --- The generator ---------------------------------------------------------------------------------------------------
const start = findStart(seed);
const dir = directionAt(start.latDeg, start.lonDeg);
const at: [number, number, number] = [dir[0] * RADIUS_M, dir[1] * RADIUS_M, dir[2] * RADIUS_M];
const cells: CellId[] = [{ face: 0, level: 0, x: 0, y: 0 }, { face: 3, level: 4, x: 15, y: 0 }, SHAPE.cellAt(at, 7), SHAPE.cellAt(at, OBJECT_LEVEL), SHAPE.cellAt(at, LEAF_LEVEL)];
for (const c of cells) {
  const alone = encodeCell(generatePlanetCell(seed, c));
  for (const o of [...SHAPE.neighbours(c), ...SHAPE.children(c)]) generatePlanetCell(seed, o);
  if (!eq(encodeCell(generatePlanetCell(seed, c)), alone)) fail(`cell ${cellKey(c)} differs after other cells were generated`);
  if (!eq(encodeCell(decodeCell(alone)), alone)) fail(`cell ${cellKey(c)} does not survive a round trip through the cell format`);
}
// Objects: the cells of the coarsest level with every object round the start, and their children; and the cells of
// the three levels above it, whose thinned trees are each one of a child's (the same id), in exactly one child.
let objects = 0;
for (const c of [7, 8, 9].map((l) => SHAPE.cellAt(at, l)).concat([SHAPE.cellAt(at, OBJECT_LEVEL), ...SHAPE.neighbours(SHAPE.cellAt(at, OBJECT_LEVEL))])) {
  if (c.level >= LEAF_LEVEL) break;
  const kids = SHAPE.children(c).map((k) => generatePlanetCell(seed, k));
  for (const set of generatePlanetCell(seed, c).instances) {
    const ids = set.ids!;
    for (let t = 0; t < ids.length; t += 2) {
      let owners = 0;
      for (const kid of kids) {
        const ks = kid.instances.find((s) => s.archetype === set.archetype)?.ids;
        for (let u = 0; ks && u < ks.length; u += 2) if (ks[u] === ids[t] && ks[u + 1] === ids[t + 1]) owners++;
      }
      if (owners !== 1) fail(`object ${ids[t]}:${ids[t + 1]} of ${cellKey(c)} is in ${owners} of its children`);
      objects++;
    }
  }
}
console.log(`generator: ${cells.length} cells are independent of the order and survive the cell format; ${objects} objects round the start each have one owner a level below`);

// --- The flight ------------------------------------------------------------------------------------------------------
const needM = wholeSphereHeight(RADIUS_M, AIR_HEIGHT_M, FOV_DEG);
const plan = { ...DEFAULT_FLIGHT, highM: 1.25 * needM };
const total = flightDuration(plan);
const first = flightPose(plan, RADIUS_M, 0);
const last = flightPose(plan, RADIUS_M, total);
const top = flightPose(plan, RADIUS_M, plan.climbS + plan.holdS / 2);
if (first.heightM !== plan.lowM || last.heightM !== plan.lowM || first.pitchDeg !== last.pitchDeg || last.turnDeg !== 0) fail('the flight does not end where it starts');
if (Math.abs(top.heightM - plan.highM) > 1e-6 * plan.highM || top.pitchDeg !== 90) fail(`the top of the flight is at ${top.heightM} m looking ${top.pitchDeg}° down`);
if (top.heightM < needM) fail(`the top of the flight (${top.heightM} m) does not show the whole sphere (needs ${needM} m)`);
// Sixty poses a second: the height never changes by more than a few per cent between two of them, and the way down
// is the way up backwards.
let worstRatio = 1;
let worstTurn = 0;
let topSpeed = 0;
for (let i = 1; i <= total * 60; i++) {
  const a = flightPose(plan, RADIUS_M, (i - 1) / 60);
  const b = flightPose(plan, RADIUS_M, i / 60);
  worstRatio = Math.max(worstRatio, b.heightM / a.heightM, a.heightM / b.heightM);
  worstTurn = Math.max(worstTurn, Math.abs(b.pitchDeg - a.pitchDeg));
  topSpeed = Math.max(topSpeed, Math.abs(b.climbMs));
  const mirror = flightPose(plan, RADIUS_M, total - i / 60);
  if (Math.abs(mirror.heightM - b.heightM) > 1e-9 * b.heightM) fail(`the way down differs from the way up at ${i / 60} s`);
}
if (worstRatio > 1.02) fail(`the height changes by a factor of ${worstRatio} in one frame`);
if (worstTurn > 0.5) fail(`the view pitches by ${worstTurn}° in one frame`);
console.log(`flight: ${total} s, from ${plan.lowM} m to ${(plan.highM / 1000).toFixed(1)} km (the whole sphere with its air needs ${(needM / 1000).toFixed(1)} km); per frame at 60 Hz the height changes by at most ${((worstRatio - 1) * 100).toFixed(2)} % and the pitch by ${worstTurn.toFixed(3)}°; top speed ${(topSpeed / 1000).toFixed(1)} km/s`);

// --- Streaming along the flight --------------------------------------------------------------------------------------
const cache = new Map<string, CellContent>();
const gpuBytesOf = (c: CellContent): number => {
  let b = 0;
  for (const m of c.meshes) b += m.mesh.vertices.byteLength + (m.mesh.indices?.byteLength ?? 0);
  for (const i of c.instances) b += i.data.data.byteLength;
  return b;
};
const px = Math.max(pixelsPerRadian(viewH, (FOV_DEG * Math.PI) / 180), (MIN_SPLIT_EDGES * SELECTION.maxErrorPx) / SELECTION.errorPerEdge);
const t0 = performance.now();
let generated = 0;
try {
  const r = checkFlight({
    plan,
    dir,
    groundM: surfaceHeight(seed, at[0], at[1], at[2]),
    stepS: 0.1,
    pixelsPerRadian: px,
    maxCells: SELECTION.maxCells,
    // A cautious stand-in for the workers and the upload budget: 60 cells a second.
    jobsPerStep: 6,
    uploadsPerStep: 6,
    costOf: (cell) => {
      const key = cellKey(cell);
      let c = cache.get(key);
      if (!c) {
        c = generatePlanetCell(seed, cell);
        cache.set(key, c);
        generated++;
      }
      return { cpuBytes: encodeCell(c).byteLength, gpuBytes: gpuBytesOf(c), errorM: c.error ?? 0 };
    },
  });
  // What the page holds besides the cells: the shadow map (4096², 32-bit depth), the drawing surface's own colour
  // and depth target of the reversed depth mode, and the unit meshes and tables (under a megabyte).
  const fixedMb = (4096 * 4096 * 4 + viewW * viewH * 8) / MB + 1;
  const gpuMb = r.peakGpuBytes / MB + fixedMb;
  console.log(
    `streaming: ${r.steps} steps (${r.flightSteps} of the flight), ${generated} cells generated in ${((performance.now() - t0) / 1000).toFixed(1)} s; the sphere stayed covered, nothing was drawn twice`,
  );
  console.log(`  cells: at most ${r.peakWanted} wanted of ${SELECTION.maxCells}, ${r.peakDrawn} drawn, ${r.peakResident} on the GPU; finest level ${r.finestLevel}; detail never below ${(r.lowestDetail * 100).toFixed(0)} %`);
  console.log(`  behind: at ${r.stepsBehind} of ${r.flightSteps} steps a parent stood in for cells still on their way; settled ${r.stepsToSettle} steps after the landing`);
  console.log(`  memory: cells ${(r.peakGpuBytes / MB).toFixed(1)} MB on the GPU and ${(r.peakCpuBytes / MB).toFixed(1)} MB beside it at the worst step; with ${fixedMb.toFixed(0)} MB of targets at ${viewW}×${viewH} about ${gpuMb.toFixed(0)} MB of 600 MB`);
  if (gpuMb >= 600) fail(`the GPU memory at the worst step (${gpuMb.toFixed(0)} MB) is over the budget of 600 MB`);
} catch (e) {
  fail((e as Error).message);
}

// --- The movie --------------------------------------------------------------------------------------------------------
{
  const ground = (d: readonly number[]): number => stripGroundHeight(seed, d[0]! * RADIUS_M, d[1]! * RADIUS_M, d[2]! * RADIUS_M);
  const movie = planMovie({ seed, radiusM: RADIUS_M, topM: needM * 1.25, dayOfYear: 172, groundAt: (d) => Math.max(0, ground(d)), floorAt: ground, weatherAt: (d, g, t) => planetWeatherAt(seed, d, g, t) });
  let lowest = Infinity;
  for (const shot of movie.shots) {
    let prev: readonly number[] | null = null;
    for (let i = 0; i <= shot.seconds * 60; i++) {
      const p = shot.pose(i / 60);
      const r = Math.hypot(p.eye[0], p.eye[1], p.eye[2]);
      // Under the sea's level the eye is measured to the floor, and it keeps under the troughs of the waves.
      const level = r - RADIUS_M;
      const floor = ground([p.eye[0] / r, p.eye[1] / r, p.eye[2] / r]);
      const clear = level < 0 ? level - floor : level - Math.max(0, floor);
      lowest = Math.min(lowest, clear);
      if (level < 0 ? clear < 1 : clear < 3) fail(`movie shot ${shot.key} is ${clear.toFixed(1)} m above the ground at ${(i / 60).toFixed(2)} s`);
      if (level < 0 && level > -1.5) fail(`movie shot ${shot.key} is only ${(-level).toFixed(1)} m under the sea's level at ${(i / 60).toFixed(2)} s`);
      // No jump: a frame at 60 Hz moves the eye by less than a tenth of its height above the ground (and 2 km).
      if (prev && Math.hypot(p.eye[0] - prev[0]!, p.eye[1] - prev[1]!, p.eye[2] - prev[2]!) > Math.min(2000, Math.max(1, 0.1 * clear))) fail(`movie shot ${shot.key} jumps at ${(i / 60).toFixed(2)} s`);
      prev = p.eye;
    }
  }
  console.log(`movie: ${movie.shots.length} shots, ${movie.seconds} s (${movie.shots.map((s) => `${s.key} ${s.seconds}`).join(', ')}); the eye never lower than ${lowest.toFixed(1)} m above the ground`);
}

for (const p of problems) console.log(`FAILED: ${p}`);
console.log(problems.length ? `planet: ${problems.length} checks failed` : 'planet: all checks passed');
process.exit(problems.length ? 1 : 0);
