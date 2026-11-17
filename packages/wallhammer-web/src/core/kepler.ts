// Motion "on rails": where a body is and how it is turned are closed-form functions of time. A body goes round its
// parent on a Kepler ellipse and turns about a fixed, tilted axis. Nothing is integrated and nothing is carried from
// one call to the next, so stepping through time and jumping straight to a moment give the same bits, and the clock
// can run at any rate or backwards.
//
// The ellipse is solved with a fixed number of Newton steps and with the reproducible sine and cosine of
// `base/trig.ts`; the only other operations are + − × ÷ and `Math.sqrt`. The same input therefore gives the same
// 64-bit result on every machine.
//
// Axes: y is up, the reference plane of an orbit is the xz plane. Longitudes are measured in that plane from +x
// toward −z, which is anticlockwise seen from +y. A body with a positive period goes round and turns that way.

import type { Vec3 } from '../base/math.ts';
import { detSinCos, detSinCosTurns, RAD_PER_TURN } from '../base/trig.ts';
import { quatAxisTurns, quatMul } from '../base/frames.ts';
import type { Quat } from '../base/frames.ts';

/**
 * Newton steps of the ellipse solver. Always all of them: the result must not depend on a convergence test. Six
 * steps reach the last bit over the whole allowed range of eccentricity; two more are a reserve.
 */
export const ORBIT_SOLVER_STEPS = 8;
/** Largest eccentricity the fixed number of steps solves to full precision; `prepareOrbit` rejects more. */
export const ORBIT_MAX_ECCENTRICITY = 0.9;

/** A Kepler ellipse round the origin of the parent frame. Angles in degrees, lengths in metres, time in seconds. */
export interface OrbitElements {
  /** Half of the long axis of the ellipse. */
  semiMajorAxis: number;
  /** Time of one round. Negative goes round the other way. */
  periodS: number;
  /** 0 is a circle; at most `ORBIT_MAX_ECCENTRICITY`. Default 0. */
  eccentricity?: number;
  /** Tilt of the orbit plane against the reference plane. Default 0. */
  inclinationDeg?: number;
  /** Longitude at which the orbit rises through the reference plane. Default 0. */
  ascendingNodeDeg?: number;
  /** Angle in the orbit plane from the ascending node to the point nearest the parent. Default 0. */
  periapsisDeg?: number;
  /** Where on the round the body is at time 0, in turns of mean anomaly (0 = nearest the parent). Default 0. */
  phase?: number;
}

/** An orbit prepared for evaluation: the two axes of the ellipse as vectors and its timing. */
export interface Orbit {
  /** From the centre of attraction toward the nearest point, length = semi-major axis. */
  readonly major: Vec3;
  /** A quarter turn ahead in the orbit plane, length = semi-minor axis. */
  readonly minor: Vec3;
  readonly eccentricity: number;
  readonly periodS: number;
  readonly phase: number;
}

/** Checks the elements and works out the constant part of the orbit. */
export function prepareOrbit(el: OrbitElements): Orbit {
  const e = el.eccentricity ?? 0;
  if (!(el.semiMajorAxis > 0)) throw new Error('orbit: semiMajorAxis must be positive');
  if (el.periodS === 0 || el.periodS !== el.periodS) throw new Error('orbit: periodS must be a number other than 0');
  if (!(e >= 0 && e <= ORBIT_MAX_ECCENTRICITY)) throw new Error(`orbit: eccentricity must be 0 … ${ORBIT_MAX_ECCENTRICITY}`);
  const [sinI, cosI] = detSinCosTurns((el.inclinationDeg ?? 0) / 360);
  const [sinN, cosN] = detSinCosTurns((el.ascendingNodeDeg ?? 0) / 360);
  const [sinP, cosP] = detSinCosTurns((el.periapsisDeg ?? 0) / 360);
  // The usual perifocal axes for a reference plane XY with Z up, then (X, Y, Z) → (x, −z, y).
  const a = el.semiMajorAxis;
  const b = a * Math.sqrt((1 - e) * (1 + e));
  const major: Vec3 = [a * (cosN * cosP - sinN * sinP * cosI), a * (sinP * sinI), -a * (sinN * cosP + cosN * sinP * cosI)];
  const minor: Vec3 = [b * (-cosN * sinP - sinN * cosP * cosI), b * (cosP * sinI), -b * (-sinN * sinP + cosN * cosP * cosI)];
  return { major, minor, eccentricity: e, periodS: el.periodS, phase: el.phase ?? 0 };
}

/**
 * Solves Kepler's equation E − e·sin E = M for the mean anomaly given in turns, with exactly `ORBIT_SOLVER_STEPS`
 * Newton steps. Returns `[sin E, cos E, E]` (E in radians, −π … π).
 */
export function solveKepler(meanTurns: number, eccentricity: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const e = eccentricity;
  const f = meanTurns - Math.floor(meanTurns);
  // Half a round is solved, the other half is its mirror image.
  const mirrored = f > 0.5;
  const m = (mirrored ? 1 - f : f) * RAD_PER_TURN; // 0 … π
  // The function is convex on 0 … π and not negative at this start, so every step comes down toward the root.
  let E = m + e;
  if (E > Math.PI) E = Math.PI;
  const sc: [number, number] = [0, 0];
  for (let i = 0; i < ORBIT_SOLVER_STEPS; i++) {
    detSinCos(E, sc);
    E -= (E - e * sc[0] - m) / (1 - e * sc[1]);
  }
  detSinCos(E, sc);
  out[0] = mirrored ? -sc[0] : sc[0];
  out[1] = sc[1];
  out[2] = mirrored ? -E : E;
  return out;
}

/** Position on the orbit at time `t` (seconds), in the parent frame, relative to the centre of attraction. */
export function orbitPosition(o: Orbit, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const [sinE, cosE] = solveKepler(o.phase + t / o.periodS, o.eccentricity);
  const x = cosE - o.eccentricity;
  out[0] = o.major[0] * x + o.minor[0] * sinE;
  out[1] = o.major[1] * x + o.minor[1] * sinE;
  out[2] = o.major[2] * x + o.minor[2] * sinE;
  return out;
}

/** Velocity on the orbit at time `t` (m/s), the exact derivative of `orbitPosition`. */
export function orbitVelocity(o: Orbit, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const [sinE, cosE] = solveKepler(o.phase + t / o.periodS, o.eccentricity);
  const rate = RAD_PER_TURN / o.periodS / (1 - o.eccentricity * cosE); // dE/dt
  const vx = -sinE * rate;
  const vy = cosE * rate;
  out[0] = o.major[0] * vx + o.minor[0] * vy;
  out[1] = o.major[1] * vx + o.minor[1] * vy;
  out[2] = o.major[2] * vx + o.minor[2] * vy;
  return out;
}

/** Turning of a body about its own axis. Angles in degrees, time in seconds. */
export interface SpinElements {
  /** Time of one turn against the fixed directions of the parent. Negative turns the other way; omitted or 0 does not turn. */
  periodS?: number;
  /** Angle between the axis and the parent's +y. Default 0. */
  tiltDeg?: number;
  /** Longitude toward which the +y end of the axis leans. Default 0. */
  tiltLongitudeDeg?: number;
  /** Turn at time 0, in turns. Default 0. */
  phase?: number;
}

/** A spin prepared for evaluation. */
export interface Spin {
  /** Unit axis in the parent frame; the body's own +y. */
  readonly axis: Vec3;
  /** The rotation that tilts +y onto the axis. */
  readonly tilt: Quat;
  /** 0 when the body does not turn. */
  readonly periodS: number;
  readonly phase: number;
}

/** Works out the constant part of a spin. */
export function prepareSpin(el: SpinElements = {}): Spin {
  const periodS = el.periodS ?? 0;
  if (periodS !== periodS) throw new Error('spin: periodS is not a number');
  const [sinL, cosL] = detSinCosTurns((el.tiltLongitudeDeg ?? 0) / 360);
  const [sinT, cosT] = detSinCosTurns((el.tiltDeg ?? 0) / 360);
  // +y is tilted toward the horizontal direction (cos L, 0, −sin L) by turning about (+y) × (that direction).
  const tilt = quatAxisTurns([-sinL, 0, -cosL], (el.tiltDeg ?? 0) / 360);
  return { axis: [sinT * cosL, cosT, -sinT * sinL], tilt, periodS, phase: el.phase ?? 0 };
}

/** Rotation of the body in its parent at time `t` (seconds): the turn about its own +y, then the tilt. */
export function spinRotation(s: Spin, t: number): Quat {
  const turns = s.periodS === 0 ? s.phase : s.phase + t / s.periodS;
  return quatMul(s.tilt, quatAxisTurns([0, 1, 0], turns));
}

/** Angular velocity of the body in its parent (rad/s, along the axis). */
export function spinRate(s: Spin, out: Vec3 = [0, 0, 0]): Vec3 {
  const w = s.periodS === 0 ? 0 : RAD_PER_TURN / s.periodS;
  out[0] = s.axis[0] * w;
  out[1] = s.axis[1] * w;
  out[2] = s.axis[2] * w;
  return out;
}
