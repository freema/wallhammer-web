// Small math for the village generators: vectors as plain tuples, curves, and the village's own composition of an
// affine matrix (`compose34`: translation, the village heading, pitch, roll, scale). Matrices are the engine's `Mat34`
// (base): 12 numbers column by column [xx, xy, xz, yx, yy, yz, zx, zy, zz, tx, ty, tz], multiplied and applied by the
// engine's functions, re-exported here under the short names the generators use. Generators run once at start, so
// clarity wins over raw speed, but the matrix helpers also write into caller-owned arrays so per-frame code (wheels,
// sails) can avoid garbage.

import { clamp, lerp, mat34Determinant, mat34Identity, mat34Multiply, mat34Normal, mat34Point, smoothstep } from 'wallhammer-web/base';
import type { Mat34, Vec3 } from 'wallhammer-web/base';

export type { Mat34, Vec3 };
export type Vec2 = [number, number];

export { clamp, lerp, smoothstep };
export const TAU = Math.PI * 2;

/** The identity (into `out` when given). */
export const identity34 = mat34Identity;
/** out = a · b: apply b first, then a (`out` may be either input). */
export const mul34 = mat34Multiply;
/** A point moved by the matrix. */
export const applyPoint34 = mat34Point;
/** A normal carried by the matrix: cofactor matrix, unit length, still outward under a mirror. */
export const applyNormal34 = mat34Normal;
/** Determinant of the linear part; negative means the transform mirrors (winding must flip). */
export const det34 = mat34Determinant;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add3 = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const sub3 = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const scale3 = (a: readonly number[], s: number): Vec3 => [a[0]! * s, a[1]! * s, a[2]! * s];
export const dot3 = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const cross3 = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
export const len3 = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
export const norm3 = (a: readonly number[]): Vec3 => {
  const l = len3(a) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};
export const lerp3 = (a: readonly number[], b: readonly number[], t: number): Vec3 => [lerp(a[0]!, b[0]!, t), lerp(a[1]!, b[1]!, t), lerp(a[2]!, b[2]!, t)];

/** Rotates the vector (x, z) by `yaw` about +y with the village convention (see `yawDir`). */
export function rotateY(x: number, z: number, yaw: number): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * x + s * z, -s * x + c * z];
}

/**
 * The world direction (x, z) of local +z for a heading `yaw`. Convention of the whole example: yaw 0 faces +z
 * (south), yaw +π/2 faces +x (east). `yawOf(dx, dz)` is the inverse.
 */
export const yawDir = (yaw: number): Vec2 => [Math.sin(yaw), Math.cos(yaw)];
export const yawOf = (dx: number, dz: number): number => Math.atan2(dx, dz);

// --- Affine matrices (Mat34) -------------------------------------------------------------------------------------------

/**
 * Translation, then rotation yaw about y, pitch about the local x, roll about the local z (in that order applied to
 * the object: roll first), then non-uniform scale. Writes into `out` (no allocation when given).
 */
export function compose34(
  t: readonly number[],
  yaw = 0,
  pitch = 0,
  roll = 0,
  s: readonly number[] = [1, 1, 1],
  out: Mat34 = new Float64Array(12),
): Mat34 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll); columns are the rotated axes.
  // Rz columns: x=(cr, sr, 0) y=(-sr, cr, 0) z=(0,0,1). Rx: y,z rotate. Ry: x,z rotate (village yaw convention).
  const rot = (x: number, y: number, z: number): Vec3 => {
    // roll about z
    const x1 = cr * x - sr * y, y1 = sr * x + cr * y, z1 = z;
    // pitch about x (positive tips +z down toward -y... standard right-handed)
    const y2 = cp * y1 - sp * z1, z2 = sp * y1 + cp * z1;
    // yaw about y in the village convention: local +z -> (sin yaw, cos yaw)
    return [cy * x1 + sy * z2, y2, -sy * x1 + cy * z2];
  };
  const ax = rot(s[0]!, 0, 0), ay = rot(0, s[1]!, 0), az = rot(0, 0, s[2]!);
  out[0] = ax[0]; out[1] = ax[1]; out[2] = ax[2];
  out[3] = ay[0]; out[4] = ay[1]; out[5] = ay[2];
  out[6] = az[0]; out[7] = az[1]; out[8] = az[2];
  out[9] = t[0]!; out[10] = t[1]!; out[11] = t[2]!;
  return out;
}

/** A matrix from three axis columns and an origin (axes are not normalised: their lengths scale). */
export function basis34(x: readonly number[], y: readonly number[], z: readonly number[], t: readonly number[], out: Mat34 = new Float64Array(12)): Mat34 {
  out[0] = x[0]!; out[1] = x[1]!; out[2] = x[2]!;
  out[3] = y[0]!; out[4] = y[1]!; out[5] = y[2]!;
  out[6] = z[0]!; out[7] = z[1]!; out[8] = z[2]!;
  out[9] = t[0]!; out[10] = t[1]!; out[11] = t[2]!;
  return out;
}

// --- Curves ------------------------------------------------------------------------------------------------------------

/** Catmull-Rom point between p1 and p2 at t (0–1), centripetal-free uniform form. Works for 2 or 3 components. */
export function catmull(p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[], t: number): number[] {
  const t2 = t * t, t3 = t2 * t;
  const out: number[] = [];
  for (let k = 0; k < p1.length; k++) {
    const a = p0[k]!, b = p1[k]!, c = p2[k]!, d = p3[k]!;
    out.push(0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3));
  }
  return out;
}

/**
 * A smooth curve through control points, resampled at roughly `step` metres. The ends are kept. Each point keeps
 * all components (for example x, z and a width), interpolated with the same spline.
 */
export function smoothPolyline(points: readonly (readonly number[])[], step: number): number[][] {
  if (points.length < 2) return points.map((p) => [...p]);
  const out: number[][] = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!, p1 = points[i]!, p2 = points[i + 1]!, p3 = points[Math.min(n - 1, i + 2)]!;
    const seg = Math.hypot(p2[0]! - p1[0]!, p2[1]! - p1[1]!);
    const k = Math.max(1, Math.ceil(seg / step));
    for (let j = 0; j < k; j++) out.push(catmull(p0, p1, p2, p3, j / k));
  }
  out.push([...points[n - 1]!]);
  return out;
}

/** Cumulative lengths along a polyline of (x, z, …) points. */
export function polylineLengths(points: readonly (readonly number[])[]): number[] {
  const acc = [0];
  for (let i = 1; i < points.length; i++) acc.push(acc[i - 1]! + Math.hypot(points[i]![0]! - points[i - 1]![0]!, points[i]![1]! - points[i - 1]![1]!));
  return acc;
}

/** Nearest point of a polyline of (x, z, …) points: distance, segment index, share along that segment, distance along. */
export interface PolylineHit {
  dist: number;
  seg: number;
  t: number;
  along: number;
}

export function nearestOnPolyline(points: readonly (readonly number[])[], lengths: readonly number[], x: number, z: number): PolylineHit {
  let best: PolylineHit = { dist: Infinity, seg: 0, t: 0, along: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i]![0]!, az = points[i]![1]!;
    const bx = points[i + 1]![0]!, bz = points[i + 1]![1]!;
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1e-9;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best.dist) best = { dist: d, seg: i, t, along: lengths[i]! + t * Math.sqrt(l2) };
  }
  return best;
}

/** Point in a polygon given as flat x, z pairs (even-odd rule). */
export function pointInRing(ring: readonly number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!, zi = ring[i + 1]!, xj = ring[j]!, zj = ring[j + 1]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to the outline of a ring (flat x, z pairs); negative inside. */
export function signedDistToRing(ring: readonly number[], x: number, z: number): number {
  let d = Infinity;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j]!, az = ring[j + 1]!, bx = ring[i]!, bz = ring[i + 1]!;
    const dx = bx - ax, dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9), 0, 1);
    d = Math.min(d, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return pointInRing(ring, x, z) ? -d : d;
}
