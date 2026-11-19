// Golden scenarios of the planet example (examples/planet): its generator, its scripted flight, its weather, its
// places under the sea and its movie (the last three at the end of the file). Each check throws
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
import { MOVIE_SHOTS, movieFrame, planMovie } from '../../examples/planet/src/movie.ts';
import { stripGroundHeight } from '../../examples/planet/src/strips.ts';
import { planetCloudField, planetWeatherAt } from '../../examples/planet/src/weather.ts';
import { AIR_HEIGHT_M, DEFAULT_SEED, LEAF_LEVEL, OBJECT_LEVEL, RADIUS_M, SELECTION, SHAPE, directionAt, findSeaPlaces, findStart, generatePlanetCell, groundHeight, surfaceHeight } from '../../examples/planet/src/world.ts';

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

/** (c) The weather: the cloud cover by place over time and the weather at places (examples/planet/src/weather.ts). */
export function planetWeather(): (number | string)[] {
  const out: (number | string)[] = [];
  const TIMES = [0, 600, 3600];
  let prevOffset: readonly number[] | null = null;
  for (const t of TIMES) {
    const f = planetCloudField(SEED, t);
    if (f.zonal.length !== 8 || f.zonal.some((z) => !(z >= 0 && z <= 1))) throw new Error('planet weather: a zonal cover outside 0–1');
    if (JSON.stringify(planetCloudField(SEED, t)) !== JSON.stringify(f)) throw new Error('planet weather: the same time gives another field');
    // The patches drift along the wind only (no change along the axis of the poles).
    if (prevOffset && (f.patchOffset[1] !== prevOffset[1] || (f.patchOffset[0] === prevOffset[0] && f.patchOffset[2] === prevOffset[2]))) throw new Error('planet weather: the patches do not drift with the wind');
    prevOffset = f.patchOffset;
    out.push(...f.zonal.map((z) => Math.round(z * 1e6)), ...f.patchOffset.map((v) => Math.round(v * 1e3)), Math.round(f.patchAmount * 1e6), Math.round(f.patchSizeM), Math.round(f.patchWarp * 1e6), Math.round(f.darkness * 1e6));
    const forced = planetCloudField(SEED, t, 0.8);
    if (forced.zonal.some((z) => z !== 0.8) || forced.patchAmount !== 0) throw new Error('planet weather: a forced cover is not the same everywhere');
  }
  if (JSON.stringify(planetCloudField(SEED + 1, 0).zonal) === JSON.stringify(planetCloudField(SEED, 0).zonal)) throw new Error('planet weather: another seed gives the same profile');
  let rain = 0;
  let snow = 0;
  for (let i = 0; i < 400; i++) {
    const y = 2 * unit(hashInts(41, i, 0)) - 1;
    const a = 2 * Math.PI * unit(hashInts(41, i, 1));
    const r = Math.sqrt(1 - y * y);
    const dir: [number, number, number] = [r * Math.cos(a), y, r * Math.sin(a)];
    const groundM = Math.max(0, surfaceHeight(SEED, dir[0] * RADIUS_M, dir[1] * RADIUS_M, dir[2] * RADIUS_M));
    const w = planetWeatherAt(SEED, dir, groundM, TIMES[i % 3]!);
    for (const v of [w.cloudCover, w.precipitation, w.snowCover, w.wetness, w.fog]) if (!(v >= 0 && v <= 1)) throw new Error(`planet weather: a value outside 0–1 at place ${i}`);
    if (w.precipitation > 0 && w.cloudCover <= 0.6) throw new Error('planet weather: precipitation under a cover of 0.6 or less');
    if (w.precipitationKind === 'snow' ? w.wetness !== 0 || w.snowCover !== w.precipitation : w.snowCover !== 0) throw new Error('planet weather: snow and wetness disagree with the kind of precipitation');
    if (planetWeatherAt(SEED, dir, groundM, TIMES[i % 3]!, 1).precipitation !== 0.9) throw new Error('planet weather: a forced cover of 1 does not give the full precipitation');
    if (w.precipitation > 0) w.precipitationKind === 'snow' ? snow++ : rain++;
    out.push(Math.round(w.cloudCover * 1e6), Math.round(w.precipitation * 1e6), w.precipitationKind, Math.round(w.wetness * 1e6), Math.round(w.fog * 1e6));
  }
  if (rain === 0 || snow === 0) throw new Error(`planet weather: ${rain} places with rain and ${snow} with snow of 400`);
  out.push(rain, snow);
  return out;
}

/** (d) The places under the sea found from the seed (`findSeaPlaces`), for three seeds. */
export function planetSeaPlaces(): (number | string)[] {
  const out: (number | string)[] = [];
  let found = 0;
  for (const seed of [SEED, 7, 725]) {
    const places = findSeaPlaces(seed);
    if (JSON.stringify(findSeaPlaces(seed)) !== JSON.stringify(places)) throw new Error('planet sea places: the same seed gives other places');
    for (const [kind, p, from, to] of [['shallow', places.shallow, -10, -5], ['deep', places.deep, -120, -70]] as const) {
      if (!p) {
        out.push(kind, 'none');
        continue;
      }
      found++;
      const d = directionAt(p.latDeg, p.lonDeg);
      const floor = groundHeight(seed, d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M);
      if (floor !== p.groundM) throw new Error(`planet sea places: the ${kind} place of seed ${seed} says ${p.groundM} m, the ground is at ${floor} m`);
      if (!(floor >= from && floor <= to)) throw new Error(`planet sea places: the floor of the ${kind} place of seed ${seed} is at ${floor} m`);
      if (Math.abs(p.latDeg) > 50) throw new Error(`planet sea places: the ${kind} place of seed ${seed} lies at latitude ${p.latDeg}`);
      if (Math.abs(Math.hypot(p.toward[0], p.toward[1], p.toward[2]) - 1) > 1e-9) throw new Error('planet sea places: toward is not a unit direction');
      out.push(kind, Math.round(p.latDeg * 1e6), Math.round(p.lonDeg * 1e6), Math.round(p.groundM * 1e3), ...p.toward.map((v) => Math.round(v * 1e9)));
    }
  }
  if (!findSeaPlaces(SEED).shallow) throw new Error('planet sea places: the default seed has no shallow place (the page\'s sea views and the movie need it)');
  out.push(found);
  return out;
}

/**
 * (e) The movie (examples/planet/src/movie.ts): the plan from the seed and the poses of every shot twice a second.
 * The world is the one the example's own check uses (the ground with the strips). A pose is a pure function of the
 * time; the fades stay within 0–1 and the movie loops.
 */
export function planetMovie(): (number | string)[] {
  const out: (number | string)[] = [];
  const ground = (d: readonly number[]): number => stripGroundHeight(SEED, d[0]! * RADIUS_M, d[1]! * RADIUS_M, d[2]! * RADIUS_M);
  const world = { seed: SEED, radiusM: RADIUS_M, topM: 1.25 * wholeSphereHeight(RADIUS_M, AIR_HEIGHT_M, 50), dayOfYear: 172, groundAt: (d: readonly number[]) => Math.max(0, ground(d)), floorAt: ground, weatherAt: (d: [number, number, number], g: number, t: number) => planetWeatherAt(SEED, d, g, t) };
  const movie = planMovie(world);
  if (movie.shots.length !== MOVIE_SHOTS.length) throw new Error(`planet movie: ${movie.shots.length} shots planned of ${MOVIE_SHOTS.length}`);
  if (movie.seconds !== MOVIE_SHOTS.reduce((s, x) => s + x.seconds, 0)) throw new Error('planet movie: its length is not the sum of its shots');
  const again = planMovie(world);
  let start = 0;
  for (let k = 0; k < movie.shots.length; k++) {
    const shot = movie.shots[k]!;
    out.push(shot.key, shot.seconds, Math.round(shot.place[0] * 1e6), Math.round(shot.place[1] * 1e6));
    for (let i = 0; i <= shot.seconds * 2; i++) {
      const u = i / 2;
      const p = shot.pose(u);
      if (JSON.stringify(again.shots[k]!.pose(u)) !== JSON.stringify(p)) throw new Error(`planet movie: shot ${shot.key} gives another pose from a second plan`);
      if (Math.abs(Math.hypot(p.look[0], p.look[1], p.look[2]) - 1) > 1e-6) throw new Error(`planet movie: the view of shot ${shot.key} is not a unit direction`);
      if (![...p.eye, p.hour, p.timeS].every(Number.isFinite)) throw new Error(`planet movie: shot ${shot.key} has a pose that is not a number`);
      const f = movieFrame(movie, start + u);
      if (!(f.dark >= 0 && f.dark <= 1)) throw new Error('planet movie: a fade outside 0–1');
      // Inside a shot the frame is the shot's pose; at a cut the frame belongs to the next shot.
      if (i < shot.seconds * 2 && (f.shot !== k || f.u !== u || JSON.stringify(f.eye) !== JSON.stringify(p.eye))) throw new Error(`planet movie: the frame at ${start + u} s is not shot ${shot.key} at ${u} s`);
      out.push(...p.eye.map((v) => Math.round(v * 1e3)), ...p.look.map((v) => Math.round(v * 1e6)), Math.round(p.hour * 1e6), Math.round(p.timeS * 1e3), Math.round(f.dark * 1e6));
    }
    if (JSON.stringify(shot.pose(-1)) !== JSON.stringify(shot.pose(0)) || JSON.stringify(shot.pose(shot.seconds + 1)) !== JSON.stringify(shot.pose(shot.seconds))) throw new Error(`planet movie: shot ${shot.key} is not clamped to its length`);
    start += shot.seconds;
  }
  const a = movieFrame(movie, 12.25);
  const b = movieFrame(movie, 12.25 + movie.seconds);
  if (a.shot !== b.shot || JSON.stringify(a.eye) !== JSON.stringify(b.eye)) throw new Error('planet movie: the movie does not loop');
  out.push(movie.seconds);
  return out;
}
