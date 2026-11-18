// Golden scenarios of the planet example (examples/planet): its generator and its scripted flight. Each check throws
// on a violation; the returned values go into the golden hash.
//   - cells: bytes independent of the order of generation, a round trip through the cell format, every object of a
//     cell in exactly one of its children; the start place found from the seed;
//   - flight: the pose as a function of time ends where it starts, its top shows the whole sphere with its air, the
//     way down mirrors the way up; flown through the streaming manager (with a stand-in for the generator's cost and
//     error) the sphere stays covered at every step, nothing is drawn twice and the budget of cells holds.

import type { CellId } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { cellKey, hashInts, unit } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { decodeCell, encodeCell } from '../../packages/wallhammer-web/src/world/index.ts';
import { DEFAULT_FLIGHT, flightDuration, flightPose, wholeSphereHeight } from '../../examples/planet/src/flight.ts';
import { checkFlight } from '../../examples/planet/src/flight-check.ts';
import { AIR_HEIGHT_M, DEFAULT_SEED, LEAF_LEVEL, OBJECT_LEVEL, RADIUS_M, SELECTION, SHAPE, directionAt, findStart, generatePlanetCell, surfaceHeight } from '../../examples/planet/src/world.ts';

const SEED = DEFAULT_SEED;
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

/** (a) Cells of the generator and the start place. */
export function planetCells(): (Uint8Array | number | string)[] {
  const out: (Uint8Array | number | string)[] = [];
  const start = findStart(SEED);
  const dir = directionAt(start.latDeg, start.lonDeg);
  const at: [number, number, number] = [dir[0] * RADIUS_M, dir[1] * RADIUS_M, dir[2] * RADIUS_M];
  const ground = surfaceHeight(SEED, at[0], at[1], at[2]);
  if (!(ground > 0)) throw new Error(`planet cells: the start place stands on the sea (${ground} m)`);
  out.push(Math.round(start.latDeg * 1e6), Math.round(start.lonDeg * 1e6), Math.round(ground * 1e3), ...start.toward.map((v) => Math.round(v * 1e9)));

  const cells: CellId[] = [{ face: 0, level: 0, x: 0, y: 0 }, { face: 3, level: 4, x: 15, y: 0 }, SHAPE.cellAt(at, OBJECT_LEVEL), SHAPE.cellAt(at, LEAF_LEVEL)];
  for (const c of cells) {
    const alone = encodeCell(generatePlanetCell(SEED, c));
    for (const o of [...SHAPE.neighbours(c), ...SHAPE.children(c)]) generatePlanetCell(SEED, o);
    if (!eq(encodeCell(generatePlanetCell(SEED, c)), alone)) throw new Error(`planet cells: ${cellKey(c)} differs after other cells were generated`);
    const back = decodeCell(alone);
    if (!eq(encodeCell(back), alone)) throw new Error(`planet cells: ${cellKey(c)} does not survive a round trip through the cell format`);
    if (back.error === undefined || !(back.error > 0)) throw new Error(`planet cells: ${cellKey(c)} states no error`);
    out.push(alone);
  }

  // Every object of a cell of the coarsest level with objects is in exactly one of its children.
  const parent = SHAPE.cellAt(at, OBJECT_LEVEL);
  const kids = SHAPE.children(parent).map((k) => generatePlanetCell(SEED, k));
  let objects = 0;
  for (const set of generatePlanetCell(SEED, parent).instances) {
    const ids = set.ids!;
    for (let t = 0; t < ids.length; t += 2) {
      let owners = 0;
      for (const kid of kids) {
        const ks = kid.instances.find((s) => s.archetype === set.archetype)?.ids;
        for (let u = 0; ks && u < ks.length; u += 2) if (ks[u] === ids[t] && ks[u + 1] === ids[t + 1]) owners++;
      }
      if (owners !== 1) throw new Error(`planet cells: object ${ids[t]}:${ids[t + 1]} of ${cellKey(parent)} is in ${owners} of its children`);
      objects++;
    }
  }
  out.push(objects);
  return out;
}

/** (b) The flight: its poses, and the cover of the sphere along it. */
export function planetFlight(): (number | string)[] {
  const out: (number | string)[] = [];
  const needM = wholeSphereHeight(RADIUS_M, AIR_HEIGHT_M, 50);
  const plan = { ...DEFAULT_FLIGHT, highM: 1.25 * needM };
  const total = flightDuration(plan);
  const first = flightPose(plan, RADIUS_M, 0);
  const last = flightPose(plan, RADIUS_M, total);
  const top = flightPose(plan, RADIUS_M, plan.climbS + plan.holdS / 2);
  if (first.heightM !== plan.lowM || last.heightM !== plan.lowM || first.pitchDeg !== last.pitchDeg || last.turnDeg !== 0 || !last.done) throw new Error('planet flight: the flight does not end where it starts');
  if (top.pitchDeg !== 90 || top.heightM < needM || top.climbMs !== 0) throw new Error(`planet flight: the top is at ${top.heightM} m looking ${top.pitchDeg}° down`);
  for (let i = 0; i <= total * 4; i++) {
    const t = i / 4;
    const p = flightPose(plan, RADIUS_M, t);
    const mirror = flightPose(plan, RADIUS_M, total - t);
    if (Math.abs(mirror.heightM - p.heightM) > 1e-9 * p.heightM) throw new Error(`planet flight: the way down differs from the way up at ${t} s`);
    if (p.pitchDeg < 0 || p.pitchDeg > 90 || p.heightM < plan.lowM || p.heightM > plan.highM * (1 + 1e-9)) throw new Error(`planet flight: pose out of range at ${t} s`);
    out.push(Math.round(p.heightM * 1e3), Math.round(p.climbMs * 1e3), Math.round(p.pitchDeg * 1e6), Math.round(p.turnDeg * 1e6));
  }

  const start = findStart(SEED);
  const dir = directionAt(start.latDeg, start.lonDeg);
  const r = checkFlight({
    plan,
    dir,
    groundM: surfaceHeight(SEED, dir[0] * RADIUS_M, dir[1] * RADIUS_M, dir[2] * RADIUS_M),
    stepS: 0.25,
    pixelsPerRadian: SELECTION.pixelsPerRadian,
    maxCells: SELECTION.maxCells,
    jobsPerStep: 12,
    uploadsPerStep: 12,
    // A stand-in for the generator: a fixed size and an error scattered round the full error of the level.
    costOf: (c) => ({ cpuBytes: 90_000, gpuBytes: 80_000, errorM: SHAPE.edgeM(c.level) * SELECTION.errorPerEdge * (0.4 + 1.1 * unit(hashInts(SEED, 0xf119, c.face, c.level, c.x, c.y))) }),
  });
  if (r.finestLevel !== LEAF_LEVEL) throw new Error(`planet flight: the finest level drawn is ${r.finestLevel}, expected ${LEAF_LEVEL}`);
  const { steps, flightSteps, requested, completed, cancelled, evicted, peakWanted, peakDrawn, peakResident, lowestDetail, stepsBehind, stepsToSettle } = r;
  out.push(...r.trace, JSON.stringify({ steps, flightSteps, requested, completed, cancelled, evicted, peakWanted, peakDrawn, peakResident, lowestDetail, stepsBehind, stepsToSettle }));
  return out;
}
