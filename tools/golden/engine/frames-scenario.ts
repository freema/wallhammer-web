// Golden scenarios of the reproducible trigonometry, the bodies on rails and the nested frames. Each returns the
// data that is hashed and throws when one of its own conditions does not hold, so a broken property fails the run
// even before the hash is compared.

import { detAcos, detAsin, detAtan2, detSinCos, detSinCosTurns, directionFromDeg, directionToDeg, quatAxisTurns, quatRotate, relativeMatrix, relativePoints, tangentPose } from '../../../packages/wallhammer-web/src/base/index.ts';
import type { FramePose, FrameState, Vec3 } from '../../../packages/wallhammer-web/src/base/index.ts';
import { BodySystem, ORBIT_MAX_ECCENTRICITY, orbitPosition, orbitVelocity, prepareOrbit, solveKepler } from '../../../packages/wallhammer-web/src/core/index.ts';
import type { BodyDef } from '../../../packages/wallhammer-web/src/core/index.ts';

const len = (v: readonly number[]): number => Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];

// --- Trigonometry ---------------------------------------------------------------------------------------------------

/**
 * A fixed table of the reproducible functions. The library functions are used only as a loose reference here (they
 * may differ in the last bit between machines, the bound is far above that); the hash is over the table alone.
 */
export function trigTable(): Float64Array {
  const out: number[] = [];
  const close = (what: string, got: number, want: number, tol: number): void => {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`trig: ${what} gives ${got}, the reference is ${want}`);
  };
  for (let i = 0; i <= 4000; i++) {
    const turns = i / 997 - 2 + (i % 7) * 1e-9;
    const [s, c] = detSinCosTurns(turns);
    close(`sin of ${turns} turns`, s, Math.sin(turns * 2 * Math.PI), 4e-15);
    close(`cos of ${turns} turns`, c, Math.cos(turns * 2 * Math.PI), 4e-15);
    out.push(s, c);
  }
  // Whole and quarter turns are exact, also far from zero.
  for (const whole of [0, 1, -3, 1e9, 123456789]) {
    const quarters = [0, 1, 0, -1, 1, 0, -1, 0];
    for (let q = 0; q < 4; q++) {
      const [s, c] = detSinCosTurns(whole + q / 4);
      if (s !== quarters[q]! || c !== quarters[q + 4]!) throw new Error(`trig: ${whole} + ${q}/4 turns is not exact (${s}, ${c})`);
    }
  }
  for (let i = 0; i <= 4000; i++) {
    const rad = (i - 2000) * 0.0251 + (i % 5) * 1e-7;
    const [s, c] = detSinCos(rad);
    close(`sin ${rad}`, s, Math.sin(rad), 2e-15);
    close(`cos ${rad}`, c, Math.cos(rad), 2e-15);
    out.push(s, c);
  }
  for (const rad of [1e5 + 0.37, -987654.321, 1.4e6, 3e9 + 0.5, -1e12]) {
    const [s, c] = detSinCos(rad);
    close(`sin ${rad}`, s, Math.sin(rad), 1e-3);
    close(`cos ${rad}`, c, Math.cos(rad), 1e-3);
    out.push(s, c);
  }
  for (let i = -20; i <= 20; i++) {
    for (let j = -20; j <= 20; j++) {
      const y = i * 0.37 + (i === 3 ? 1e-9 : 0);
      const x = j * 0.61;
      const a = detAtan2(y, x);
      close(`atan2(${y}, ${x})`, a, Math.atan2(y, x), 2e-15);
      out.push(a);
    }
  }
  for (let i = -500; i <= 500; i++) {
    const v = i / 500;
    const s = detAsin(v);
    const c = detAcos(v);
    close(`asin ${v}`, s, Math.asin(v), 4e-15);
    close(`acos ${v}`, c, Math.acos(v), 4e-15);
    out.push(s, c);
  }
  for (const y of [1e-300, 1e-9, 1e9, 1e300]) out.push(detAtan2(y, 1), detAtan2(-y, -1), detAtan2(1, y));
  // Latitude and longitude there and back.
  for (let lat = -90; lat <= 90; lat += 15) {
    for (let lon = -165; lon <= 180; lon += 15) {
      const d = directionFromDeg(lat, lon);
      const back = directionToDeg(d);
      close(`latitude ${lat}`, back.latitudeDeg, lat, 1e-10);
      if (Math.abs(lat) < 90) close(`longitude ${lon}`, back.longitudeDeg, lon, 1e-10);
      out.push(d[0], d[1], d[2], back.latitudeDeg);
    }
  }
  return Float64Array.from(out);
}

// --- Bodies on rails ------------------------------------------------------------------------------------------------

const HZ = 20;
const TILT_DEG = 23.5;
const SYSTEM: BodyDef[] = [
  { name: 'centre', radius: 300e3, spin: { periodS: 2400 } },
  { name: 'a', radius: 100e3, orbit: { semiMajorAxis: 2.0e7, periodS: 5400, eccentricity: 0.05 }, spin: { periodS: 600, tiltDeg: TILT_DEG, tiltLongitudeDeg: 40 } },
  { name: 'a1', parent: 'a', radius: 50e3, orbit: { semiMajorAxis: 1.2e6, periodS: 900, eccentricity: 0.2, inclinationDeg: 12, ascendingNodeDeg: 75, periapsisDeg: 200, phase: 0.3 }, spin: { periodS: 900 } },
  { name: 'b', radius: 250e3, orbit: { semiMajorAxis: 6.0e7, periodS: 21600, eccentricity: 0.6, inclinationDeg: 8, ascendingNodeDeg: 130, periapsisDeg: 310, phase: 0.62 }, spin: { periodS: -1500, tiltDeg: 97, tiltLongitudeDeg: 250, phase: 0.1 } },
  { name: 'c', radius: 80e3, orbit: { semiMajorAxis: 1.0e8, periodS: -43200, eccentricity: ORBIT_MAX_ECCENTRICITY, inclinationDeg: 30, phase: 0.98 } },
];

/** Every bit of every body frame of a system, as numbers. */
function snapshot(sys: BodySystem): number[] {
  const out: number[] = [sys.fingerprint()];
  for (const b of sys.bodies) {
    const carried = sys.frames.pose(b.carriedFrame);
    const turning = sys.frames.pose(b.turningFrame);
    out.push(...carried.origin, ...sys.frames.velocity(b.carriedFrame), ...turning.rotation, ...sys.frames.spin(b.turningFrame));
  }
  return out;
}

function sameBits(what: string, a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) throw new Error(`orbits: ${what}: different sizes`);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) throw new Error(`orbits: ${what}: value ${i} differs (${a[i]} against ${b[i]})`);
}

/**
 * Steps a system tick by tick and compares it at checkpoints with a new system that jumps straight there, with the
 * stepped system after a detour far into the future, and near the end of the tick range. Also the solver's residual
 * on a grid, the velocity against a difference of positions, and the day and the seasons of one body.
 */
export function orbitScript(): unknown[] {
  // The fixed number of Newton steps solves the whole allowed range.
  let worst = 0;
  for (let ei = 0; ei <= 18; ei++) {
    const e = (ei / 18) * ORBIT_MAX_ECCENTRICITY;
    const means = [1e-12, 1e-9, 1e-6, 1e-4, 0.5 - 1e-9, 0.5, 0.5 + 1e-9, 1 - 1e-6];
    for (let i = 0; i <= 2000; i++) means.push(i / 2000);
    for (const mean of means) {
      const [s, , E] = solveKepler(mean, e);
      const m = (mean > 0.5 ? mean - 1 : mean) * 2 * Math.PI;
      worst = Math.max(worst, Math.abs(E - e * s - m));
    }
  }
  if (!(worst < 1e-13)) throw new Error(`orbits: Kepler's equation is solved only to ${worst}`);

  // The velocity is the derivative of the position.
  for (const def of SYSTEM) {
    if (!def.orbit) continue;
    const o = prepareOrbit(def.orbit);
    for (const t of [0, 311.5, 4000.25, 20000]) {
      const h = 1e-3;
      const diff = sub(orbitPosition(o, t + h), orbitPosition(o, t - h)).map((d) => d / (2 * h));
      const v = orbitVelocity(o, t);
      if (!(len(sub(diff, v)) <= 1e-4 * len(v) + 1e-3)) throw new Error(`orbits: velocity of "${def.name}" at ${t} s is ${v}, positions give ${diff}`);
    }
  }

  const parts: unknown[] = [];
  const stepped = new BodySystem(SYSTEM);
  const check = (tick: number): void => {
    const jumped = new BodySystem(SYSTEM);
    jumped.setTick(tick, HZ);
    const a = snapshot(stepped);
    sameBits(`stepped and jumped to tick ${tick}`, a, snapshot(jumped));
    // A detour does not leave a trace either.
    stepped.setTick(tick + 987654321, HZ);
    stepped.setTick(tick, HZ);
    sameBits(`tick ${tick} after a detour`, a, snapshot(stepped));
    parts.push(Float64Array.from(a));
  };
  for (let tick = 0; tick <= 40000; tick++) {
    stepped.setTick(tick, HZ);
    if (tick % 2500 === 0) check(tick);
  }
  // The end of the 32-bit tick range of the simulation (3.4 years at 20 ticks per second).
  for (let tick = 2 ** 31 - 200; tick < 2 ** 31; tick++) stepped.setTick(tick, HZ);
  check(2 ** 31 - 1);

  // Day and seasons of body "a" under the light at the centre: the latitude under the light swings between plus and
  // minus the tilt over one round, and a point of the surface sees the light rise and set once per turn.
  const sys = new BodySystem(SYSTEM);
  const a = sys.body('a');
  const centre = sys.body('centre');
  const up = directionFromDeg(10, 25);
  let minLat = 90;
  let maxLat = -90;
  let rises = 0;
  let wasDay = false;
  const year = 5400;
  const day = 600;
  for (let tick = 0; tick <= year * HZ; tick += 10) {
    sys.setTick(tick, HZ);
    const under = sys.subPoint(a.index, centre.carriedFrame);
    minLat = Math.min(minLat, under.latitudeDeg);
    maxLat = Math.max(maxLat, under.latitudeDeg);
    const toLight = sys.frames.directionTo(centre.carriedFrame, a.turningFrame).direction;
    const isDay = toLight[0] * up[0] + toLight[1] * up[1] + toLight[2] * up[2] > 0;
    if (isDay && !wasDay && tick > 0) rises++;
    wasDay = isDay;
    if (tick % 6000 === 0) parts.push([under.latitudeDeg, under.longitudeDeg, under.distance, ...toLight]);
  }
  if (!(maxLat > TILT_DEG - 0.2 && maxLat < TILT_DEG + 1e-6 && minLat < -TILT_DEG + 0.2 && minLat > -TILT_DEG - 1e-6)) throw new Error(`orbits: the latitude under the light spans ${minLat} … ${maxLat}, the tilt is ${TILT_DEG}`);
  // Turns against the light in one round: one fewer than turns against the fixed directions.
  if (rises !== year / day - 1) throw new Error(`orbits: ${rises} risings of the light in one round, expected ${year / day - 1}`);
  parts.push([minLat, maxLat, rises]);
  return parts;
}

// --- Nested frames --------------------------------------------------------------------------------------------------

const f32 = Math.fround;

/** A point through a 4×4 matrix the way the GPU does it: every product and sum in 32 bits. */
function throughMatrix32(m: Float32Array, p: readonly number[]): Vec3 {
  const x = f32(p[0]!);
  const y = f32(p[1]!);
  const z = f32(p[2]!);
  const row = (i: number): number => f32(f32(f32(m[i]! * x) + f32(m[i + 4]! * y)) + f32(f32(m[i + 8]! * z) + m[i + 12]!));
  return [row(0), row(1), row(2)];
}

/**
 * An object on the surface of a turning body that goes round 100,000 km from the centre of the system, seen from an
 * eye a few metres away. Its position relative to the eye, as the GPU gets it, must stay within a millimetre of the
 * truth whichever frame the image is drawn in, while absolute 32-bit coordinates are off by metres. Then a frame is
 * moved between parents and must not move.
 */
export function farSurface(): unknown[] {
  const sys = new BodySystem([
    { name: 'centre', radius: 300e3 },
    { name: 'far', radius: 100e3, orbit: { semiMajorAxis: 1.0e8, periodS: 86400, inclinationDeg: 5 }, spin: { periodS: 1800, tiltDeg: 20, tiltLongitudeDeg: 70 } },
  ]);
  const frames = sys.frames;
  const far = sys.body('far');
  const patch = frames.add('patch', far.turningFrame, tangentPose(directionFromDeg(37, -122), far.radius));
  const neighbour = frames.add('neighbour', far.turningFrame, tangentPose(directionFromDeg(38.7, -122), far.radius));
  // Local coordinates of a patch: x east, y up, z south (metres).
  const object: Vec3 = [812.5, 1.75, -1340.25];
  const vertex: Vec3 = [0.4, 1.1, -0.3];
  const eye: Vec3 = [810, 1.7, -1335];
  const objectFrame = frames.add('object', patch, { origin: object, rotation: quatAxisTurns([0, 1, 0], 0.1) });

  const parts: unknown[] = [];
  let worst = 0;
  let worstNaive = 0;
  const drawIn = [patch, neighbour, far.turningFrame, far.carriedFrame, sys.root];
  for (const t of [0, 1234.5, 43210.05, 86400 * 365.25]) {
    sys.setTime(t);
    if (!(len(frames.convertPoint([0, 0, 0], objectFrame, sys.root)) > 0.99e8)) throw new Error('frames: the object is not 100,000 km from the centre');
    // The truth in the frame of the patch: small numbers, exact.
    const local = sub(frames.convertPoint(vertex, objectFrame, patch), eye);
    for (const frame of drawIn) {
      const eyeInFrame = frames.convertPoint(eye, patch, frame);
      const want = frames.convertDirection(local, patch, frame);
      const matrix = relativeMatrix(frames.relativePose(objectFrame, frame), eyeInFrame);
      const got = throughMatrix32(matrix, vertex);
      const batch = relativePoints(vertex, frames.relativePose(objectFrame, frame), eyeInFrame);
      worst = Math.max(worst, len(sub(got, want)), len(sub([batch[0]!, batch[1]!, batch[2]!], want)));
      parts.push(matrix, batch);
    }
    // The same in absolute 32-bit coordinates of the system: what the frames are there to avoid.
    const objectAbs = frames.convertPoint(vertex, objectFrame, sys.root).map(f32);
    const eyeAbs = frames.convertPoint(eye, patch, sys.root).map(f32);
    worstNaive = Math.max(worstNaive, len(sub(sub(objectAbs, eyeAbs), frames.convertDirection(local, patch, sys.root))));
  }
  if (!(worst < 1e-3)) throw new Error(`frames: the position relative to the eye is off by ${worst} m`);
  if (!(worstNaive > 0.5)) throw new Error(`frames: absolute 32-bit coordinates are off by only ${worstNaive} m, the scenario proves nothing`);

  // No shake: the eye moves by a millimetre a step, the image of the object moves by a millimetre a step.
  sys.setTime(5000);
  let previous: Vec3 | null = null;
  for (let step = 0; step <= 200; step++) {
    const moving: Vec3 = [eye[0] + step * 0.0006, eye[1] + step * 0.0003, eye[2] - step * 0.00074];
    const eyeInRoot = frames.convertPoint(moving, patch, sys.root);
    const got = throughMatrix32(relativeMatrix(frames.relativePose(objectFrame, sys.root), eyeInRoot), vertex);
    if (previous) {
      const moved = len(sub(got, previous));
      if (!(moved > 0.9e-3 && moved < 1.1e-3)) throw new Error(`frames: a 1 mm move of the eye moved the object by ${moved * 1000} mm`);
    }
    previous = got;
  }

  // A moving frame is handed from parent to parent. Seen from the top, neither it nor a point riding on it moves.
  const craft = frames.add('craft', sys.root, { origin: frames.convertPoint([0, 2000, 0], patch, sys.root), rotation: quatAxisTurns([0.6, 0, 0.8], 0.31) });
  frames.setMotion(craft, [120, -40, 300], [0, 0.02, 0.01]);
  const rider: Vec3 = [3, -2, 5];
  const riderVelocity: Vec3 = [0.5, 0, -1];
  const seen = (): { pose: FramePose; state: FrameState } => ({
    pose: frames.relativePose(craft, sys.root),
    state: frames.convertState(rider, riderVelocity, craft, sys.root),
  });
  const before = seen();
  for (const parent of [far.carriedFrame, far.turningFrame, patch, neighbour, sys.root]) {
    frames.reparent(craft, parent);
    const now = seen();
    const moved = len(sub(now.pose.origin, before.pose.origin));
    const turned = Math.abs(Math.abs(now.pose.rotation.reduce((s, v, i) => s + v * before.pose.rotation[i]!, 0)) - 1);
    const riderMoved = len(sub(now.state.position, before.state.position));
    const riderSped = len(sub(now.state.velocity, before.state.velocity));
    if (!(moved < 1e-6 && turned < 1e-12 && riderMoved < 1e-6 && riderSped < 1e-6)) {
      throw new Error(`frames: under "${frames.name(parent)}" the frame moved by ${moved} m, turned by ${turned}, its rider moved by ${riderMoved} m and changed speed by ${riderSped} m/s`);
    }
    const pose = frames.pose(craft);
    if (parent === patch && !(len(pose.origin) < 2001 && len(pose.origin) > 1999)) throw new Error(`frames: in the patch the frame is ${len(pose.origin)} m from its origin, expected 2000 m`);
    parts.push(pose.origin, pose.rotation, frames.velocity(craft), frames.spin(craft));
  }
  if (frames.commonAncestor(patch, neighbour) !== far.turningFrame) throw new Error('frames: two patches of one body must meet in its turning frame');
  const turnedPoint = quatRotate(frames.pose(patch).rotation, [0, 1, 0]);
  const upOfPatch = directionFromDeg(37, -122);
  if (!(len(sub(turnedPoint, upOfPatch)) < 1e-12)) throw new Error('frames: +y of a tangent frame is not the local up');
  parts.push([worst, worstNaive]);
  return parts;
}

// --- One digest for comparing machines ------------------------------------------------------------------------------

/**
 * A short digest of everything the three scenarios return, bit for bit, computed without any Node API. Node and a
 * browser must print the same text:
 *   node --input-type=module -e "import('/app/tools/golden/frames-scenario.ts').then((m) => console.log(m.framesDigest()))"
 *   (await import('/@fs/app/tools/golden/frames-scenario.ts')).framesDigest()      in the console of a dev server page
 */
export function framesDigest(): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const bits = new DataView(new ArrayBuffer(8));
  const feed = (p: unknown): void => {
    if (typeof p === 'number') {
      bits.setFloat64(0, p, true);
      for (const at of [0, 4]) {
        const w = bits.getUint32(at, true);
        h1 = Math.imul(h1 ^ w, 0x01000193);
        h2 = Math.imul((h2 + w) | 0, 0x85ebca6b) ^ (h2 >>> 13);
      }
    } else if (Array.isArray(p) || p instanceof Float64Array || p instanceof Float32Array) {
      for (const v of p as Iterable<unknown>) feed(v);
    } else throw new Error('digest: unexpected value');
  };
  feed(trigTable());
  feed(orbitScript());
  feed(farSurface());
  const hex = (h: number): string => (h >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
}
