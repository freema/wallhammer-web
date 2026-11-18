// Golden scenarios of the system example (examples/system): the generator of its bodies and its flights. Each check
// throws on a violation; the returned values go into the golden hash.
//   - cells: every body has a surface of its own from the one generator; bytes independent of the order of
//     generation, a round trip through the cell format, an error stated; a place to land found from the seed;
//   - flights: the reaches of the bodies are nested or apart; a flight from the surface of one body to the surface of
//     its neighbour and a descent from the view of the whole system, flown while the system runs: no step longer
//     than its share of the distance, the camera straight above its place while low, the two legs meet in one point
//     at one speed, and the flight ends at the height and the place it was planned for with the neighbour in the sky.

import type { CellId } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { cellKey } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { BodySystem } from '../../packages/wallhammer-web/src/core/index.ts';
import type { Body } from '../../packages/wallhammer-web/src/core/index.ts';
import { decodeCell, encodeCell } from '../../packages/wallhammer-web/src/world/index.ts';
import { CLOCK_HZ, SUN, SURFACES, bodyDefs } from '../../examples/system/src/bodies.ts';
import { anchor, between, finishLeg, flightPoint, flightSeconds, landingDirection, landingView, matchedSeconds, skyOf } from '../../examples/system/src/flight.ts';
import type { Leg, MovingPoint, OpenLeg, SurfaceLeg } from '../../examples/system/src/flight.ts';
import { DEFAULT_SEED, bodyShape, directionAt, findSite, generateBodyCell, objectLevel, packSeed, surfaceHeight } from '../../examples/system/src/world.ts';

const SEED = DEFAULT_SEED;
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const len = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** (a) Cells of every body and a place to land on each. */
export function systemCells(): (Uint8Array | number | string)[] {
  const out: (Uint8Array | number | string)[] = [];
  const roots: Uint8Array[] = [];
  SURFACES.forEach((spec, body) => {
    const packed = packSeed(SEED, body);
    const shape = bodyShape(body);
    const R = spec.radiusM;
    const site = findSite(packed, directionAt(20, 30));
    const at: [number, number, number] = [site[0] * R, site[1] * R, site[2] * R];
    out.push(spec.name, ...site.map((v) => Math.round(v * 1e9)), Math.round(surfaceHeight(packed, at[0], at[1], at[2]) * 1e3));

    const cells: CellId[] = [{ face: body % 6, level: 0, x: 0, y: 0 }, { face: (body + 3) % 6, level: 4, x: 15, y: 0 }, shape.cellAt(at, objectLevel(body)), shape.cellAt(at, spec.leafLevel)];
    for (const c of cells) {
      const alone = encodeCell(generateBodyCell(packed, c));
      for (const o of [...shape.neighbours(c), ...shape.children(c)]) generateBodyCell(packed, o);
      // Cells of another body in between must not leave a trace either: the generator keeps one world per seed.
      generateBodyCell(packSeed(SEED, (body + 1) % SURFACES.length), c);
      if (!eq(encodeCell(generateBodyCell(packed, c)), alone)) throw new Error(`system cells: ${spec.name} ${cellKey(c)} differs after other cells were generated`);
      const back = decodeCell(alone);
      if (!eq(encodeCell(back), alone)) throw new Error(`system cells: ${spec.name} ${cellKey(c)} does not survive a round trip through the cell format`);
      if (back.error === undefined || !(back.error > 0)) throw new Error(`system cells: ${spec.name} ${cellKey(c)} states no error`);
      if (back.meshes.length !== 1 || back.meshes[0]!.material !== 'terrain') throw new Error(`system cells: ${spec.name} ${cellKey(c)} has no surface`);
      out.push(alone);
    }
    // The same cell of every body, for the comparison below.
    roots.push(encodeCell(generateBodyCell(packed, { face: 0, level: 0, x: 0, y: 0 })));
  });
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) if (eq(roots[i]!, roots[j]!)) throw new Error(`system cells: ${SURFACES[i]!.name} and ${SURFACES[j]!.name} have the same surface`);
  }
  // Another seed of the system gives every body another surface.
  if (eq(encodeCell(generateBodyCell(packSeed(SEED + 1, 0), { face: 0, level: 0, x: 0, y: 0 })), roots[0]!)) throw new Error('system cells: the seed of the system does not reach the surface');
  return out;
}

const STEP_HZ = 60;
const LAND_M = 3;

/**
 * Flies legs while the system runs at real time, 60 steps per second, and checks every step in the turning frame
 * of the body the leg belongs to. Returns samples of the way.
 */
function fly(name: string, system: BodySystem, legs: Leg[], tick0: number): number[] {
  const out: number[] = [];
  const total = flightSeconds(legs);
  const steps = Math.ceil(total * STEP_HZ);
  let previous: { leg: Leg; p: number[] } | null = null;
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(total, i / STEP_HZ);
    system.setTick(tick0 + Math.round(t * CLOCK_HZ), CLOCK_HZ);
    const first = flightPoint(system, legs, t, 0);
    const leg = first.leg;
    if (leg.kind === 'surface') {
      const p = flightPoint(system, legs, t, leg.body.turningFrame).position;
      const d = len(p);
      const h = d - leg.body.radius - leg.groundM;
      if (!(h >= leg.lowM * (1 - 1e-9))) throw new Error(`system flights: ${name} is ${h} m above the surface at ${t} s, under its low end`);
      const x = leg.rising ? first.done : 1 - first.done;
      // Straight above its place while low.
      if (x < leg.turnFrom && dist([p[0]! / d, p[1]! / d, p[2]! / d], leg.site) > 1e-9) throw new Error(`system flights: ${name} leaves its place at ${t} s, ${h} m up`);
      if (previous && previous.leg === leg) {
        const moved = dist(p, previous.p);
        // The height changes by at most a hundredth per step; round the body the camera goes at most as fast.
        const most = x < leg.turnFrom ? 0.011 * h + 1e-6 : 0.03 * d;
        if (moved > most) throw new Error(`system flights: ${name} moves ${moved} m in one step at ${t} s, ${h} m up`);
      }
      previous = { leg, p };
      if (i % 30 === 0 || i === steps) out.push(Math.round(h * 10), ...p.map((v) => Math.round(v * 10)));
    } else {
      const p = first.position;
      if (previous && previous.leg === leg && dist(p, previous.p) > 0.03 * dist(leg.from(0), leg.to(0))) throw new Error(`system flights: ${name} jumps at ${t} s`);
      previous = { leg, p };
      if (i % 30 === 0 || i === steps) out.push(...p.map((v) => Math.round(v * 10)));
    }
  }
  return out;
}

/** (b) The system and two flights through it. */
export function systemFlights(): (number | string)[] {
  const out: (number | string)[] = [];
  const system = new BodySystem(bodyDefs());
  const sun = system.bodies[0]!;

  // Reaches: a body that goes round another stays inside its reach; bodies round the same one never share a place.
  const range = (b: Body): [number, number] => {
    const o = b.orbit!;
    // The length of `major` is the semi-major axis.
    const a = len(o.major);
    return [a * (1 - o.eccentricity) - b.influence, a * (1 + o.eccentricity) + b.influence];
  };
  for (const b of system.bodies.slice(1)) {
    const parent = system.bodies[b.parent]!;
    // Ten radii: within them the camera is taken along with the turning of a body (`DRAG_NONE` of the page).
    if (b.influence < 10 * b.radius) throw new Error(`system flights: the reach of ${b.name} ends where the camera still turns with it`);
    if (parent !== sun && range(b)[1] > parent.influence) throw new Error(`system flights: ${b.name} leaves the reach of ${parent.name}`);
    if (range(b)[0] < 10 * parent.radius) throw new Error(`system flights: the reach of ${b.name} comes to where the camera turns with ${parent.name}`);
    for (const o of system.bodies.slice(1)) {
      if (o.index <= b.index || o.parent !== b.parent) continue;
      if (range(b)[0] < range(o)[1] && range(o)[0] < range(b)[1]) throw new Error(`system flights: the reaches of ${b.name} and ${o.name} can meet`);
    }
  }
  for (const tick of [0, 600 * CLOCK_HZ, 86_400 * CLOCK_HZ]) {
    system.setTick(tick, CLOCK_HZ);
    out.push(system.fingerprint());
  }

  const surface = (name: string): { body: Body; index: number; packed: number; companion: Body | null } => {
    const index = SURFACES.findIndex((s) => s.name === name);
    const companion = SURFACES[index]!.companion;
    return { body: system.body(name), index, packed: packSeed(SEED, index), companion: companion ? system.body(companion) : null };
  };
  const groundAt = (packed: number, R: number, d: readonly [number, number, number]): number => surfaceHeight(packed, d[0] * R, d[1] * R, d[2] * R);
  /** The leg down to a body from a far end, landing at a time of the system, as the page plans it. */
  const down = (to: ReturnType<typeof surface>, far: MovingPoint, rest: boolean, arriveS: number, tick0: number, seconds?: (leg: OpenLeg) => number): { leg: SurfaceLeg; view: number[] } => {
    system.setTime(arriveS);
    const sky = skyOf(system, to.body, to.companion);
    system.setTick(tick0, CLOCK_HZ);
    const site = findSite(to.packed, landingDirection(sky));
    const open: OpenLeg = { kind: 'surface', body: to.body, site, groundM: groundAt(to.packed, to.body.radius, site), lowM: LAND_M, far, rest, rising: false };
    return { leg: finishLeg(open, 1, seconds?.(open)), view: landingView(sky, site) };
  };
  /** After a flight: the camera stands at the low end of its last leg; returns the elevations of the sky there. */
  const landed = (name: string, legs: Leg[], tick0: number, to: ReturnType<typeof surface>, view: number[]): number[] => {
    const leg = legs[legs.length - 1] as SurfaceLeg;
    const total = flightSeconds(legs);
    system.setTick(tick0 + Math.round(total * CLOCK_HZ), CLOCK_HZ);
    const p = flightPoint(system, legs, total, to.body.turningFrame).position;
    const want = leg.body.radius + leg.groundM + LAND_M;
    if (dist(p, [leg.site[0] * want, leg.site[1] * want, leg.site[2] * want]) > 1e-6) throw new Error(`system flights: ${name} ends ${dist(p, [leg.site[0] * want, leg.site[1] * want, leg.site[2] * want])} m from its place`);
    const sky = skyOf(system, to.body, to.companion);
    const elevation = (d: readonly number[]): number => (Math.asin(d[0]! * leg.site[0] + d[1]! * leg.site[1] + d[2]! * leg.site[2]) * 180) / Math.PI;
    const result = [elevation(sky.sun), sky.companion ? elevation(sky.companion) : 0, elevation(view)];
    if (sky.companion && !(result[1]! > 4 && result[1]! < 60)) throw new Error(`system flights: after ${name} the neighbour stands ${result[1]}° above the horizon`);
    if (Math.abs(len(view) - 1) > 1e-9 || !(result[2]! > -5 && result[2]! < 40)) throw new Error(`system flights: after ${name} the view points ${result[2]}° up`);
    return result.map((v) => Math.round(v * 1e6));
  };

  // (1) From the surface of Hearth to the surface of Pale: up to the point between them, and down from there.
  {
    const tick0 = 120 * CLOCK_HZ;
    system.setTick(tick0, CLOCK_HZ);
    const from = surface('Hearth');
    const to = surface('Pale');
    const site = findSite(from.packed, directionAt(20, 30));
    const meet = between(system, from.body, to.body, 10 * SUN.radiusM);
    const up = finishLeg({ kind: 'surface', body: from.body, site, groundM: groundAt(from.packed, from.body.radius, site), lowM: LAND_M, far: meet, rest: false, rising: true }, 1);
    const guess: OpenLeg = { kind: 'surface', body: to.body, site: [0, 1, 0], groundM: 0, lowM: LAND_M, far: meet, rest: false, rising: false };
    const d = down(to, meet, false, tick0 / CLOCK_HZ + up.seconds + matchedSeconds(guess, up), tick0, (open) => matchedSeconds(open, up));
    const legs: Leg[] = [up, d.leg];
    out.push(Math.round(up.seconds * 1e6), Math.round(d.leg.seconds * 1e6), Math.round(up.turnFrom * 1e9), Math.round(d.leg.turnFrom * 1e9));
    out.push(...fly('Hearth to Pale', system, legs, tick0));

    // Where the legs meet: one point, passed at one speed (measured in a frame that does not turn).
    const at = (t: number): number[] => {
      system.setTick(tick0 + Math.round(up.seconds * CLOCK_HZ), CLOCK_HZ);
      return flightPoint(system, legs, t, sun.carriedFrame).position;
    };
    const eps = 1e-3;
    const [a, b, c] = [at(up.seconds - eps), at(up.seconds), at(up.seconds + eps)];
    const before = dist(a!, b!) / eps;
    const after = dist(b!, c!) / eps;
    const bend = dist([b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!], [c![0]! - b![0]!, c![1]! - b![1]!, c![2]! - b![2]!]) / eps;
    if (!(before > 1000) || Math.abs(before - after) > 0.02 * before || bend > 0.03 * before) throw new Error(`system flights: the legs of Hearth to Pale meet at ${before} and ${after} m/s, ${bend} m/s apart`);
    out.push(...landed('Hearth to Pale', legs, tick0, to, d.view));
  }

  // (2) From the view of the whole system down to Rime: one leg, at rest at both ends.
  {
    const tick0 = 0;
    system.setTick(tick0, CLOCK_HZ);
    const to = surface('Rime');
    const far = anchor(system, sun.carriedFrame, [0, 75_000_000, 115_000_000]);
    const guess = finishLeg({ kind: 'surface', body: to.body, site: [0, 1, 0], groundM: 0, lowM: LAND_M, far, rest: true, rising: false }, 1);
    const d = down(to, far, true, tick0 / CLOCK_HZ + guess.seconds, tick0);
    out.push(Math.round(d.leg.seconds * 1e6), Math.round(d.leg.turnFrom * 1e9));
    out.push(...fly('the whole system to Rime', system, [d.leg], tick0));
    out.push(...landed('the whole system to Rime', [d.leg], tick0, to, d.view));
    // The leg starts where the camera was: at its far end.
    system.setTick(tick0, CLOCK_HZ);
    const start = flightPoint(system, [d.leg], 0, sun.carriedFrame).position;
    if (dist(start, [0, 75_000_000, 115_000_000]) > 1e-3) throw new Error(`system flights: the descent to Rime starts ${dist(start, [0, 75_000_000, 115_000_000])} m from where the camera was`);
  }
  return out;
}
