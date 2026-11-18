// Affine 3 × 4 matrices: a linear part and a translation, stored column by column in 12 numbers
// [c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z, tx, ty, tz]. This is exactly the first 12 floats of an instance
// record (`writeInstance` in render), so a matrix built here is written into a record as it is.
//
// Every function takes its output as the last argument `out` and returns it; without `out` a new Float64Array
// (or a new [x, y, z] for points and directions) is made, which is meant for setup, not for every frame. `out`
// may be the same array as an input everywhere. Angles are radians; rotations are right-handed (counter-clockwise
// looking down the axis toward the origin). The quaternion layout is [x, y, z, w], as `Quat` of frames.

import type { Vec3 } from './math.ts';

/** A 3 × 4 affine matrix, 12 numbers column by column (see the file comment). */
export type Mat34 = Float32Array | Float64Array;

/** Something three numbers can be written into: a `Vec3`, a typed array, a plain array. */
export type Vec3Out = { [index: number]: number };

/** Floats of one matrix. */
export const MAT34_FLOATS = 12;

function target<T extends Mat34>(out: T | undefined): T {
  return out ?? (new Float64Array(12) as T);
}

function setAll<T extends Mat34>(o: T, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, x: number, y: number, z: number): T {
  o[0] = a;
  o[1] = b;
  o[2] = c;
  o[3] = d;
  o[4] = e;
  o[5] = f;
  o[6] = g;
  o[7] = h;
  o[8] = i;
  o[9] = x;
  o[10] = y;
  o[11] = z;
  return o;
}

/** The identity. */
export function mat34Identity<T extends Mat34 = Float64Array>(out?: T): T {
  return setAll(target(out), 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
}

/** Copy of `m`. */
export function mat34Copy<T extends Mat34 = Float64Array>(m: ArrayLike<number>, out?: T): T {
  const o = target(out);
  for (let k = 0; k < 12; k++) o[k] = m[k]!;
  return o;
}

/** A move by (x, y, z). */
export function mat34Translation<T extends Mat34 = Float64Array>(x: number, y: number, z: number, out?: T): T {
  return setAll(target(out), 1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z);
}

/** Scaling along the axes; a negative factor mirrors (the determinant turns negative). */
export function mat34Scaling<T extends Mat34 = Float64Array>(sx: number, sy: number, sz: number, out?: T): T {
  return setAll(target(out), sx, 0, 0, 0, sy, 0, 0, 0, sz, 0, 0, 0);
}

/** Rotation about +x. */
export function mat34RotationX<T extends Mat34 = Float64Array>(rad: number, out?: T): T {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return setAll(target(out), 1, 0, 0, 0, c, s, 0, -s, c, 0, 0, 0);
}

/** Rotation about +y. */
export function mat34RotationY<T extends Mat34 = Float64Array>(rad: number, out?: T): T {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return setAll(target(out), c, 0, -s, 0, 1, 0, s, 0, c, 0, 0, 0);
}

/** Rotation about +z. */
export function mat34RotationZ<T extends Mat34 = Float64Array>(rad: number, out?: T): T {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return setAll(target(out), c, s, 0, -s, c, 0, 0, 0, 1, 0, 0, 0);
}

/** Rotation about the axis (ax, ay, az) through the origin; the axis need not be unit. A zero axis gives the identity. */
export function mat34RotationAxis<T extends Mat34 = Float64Array>(ax: number, ay: number, az: number, rad: number, out?: T): T {
  const l = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(l > 0)) return mat34Identity(out);
  const x = ax / l;
  const y = ay / l;
  const z = az / l;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  return setAll(
    target(out),
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
  );
}

/** Rotation of the unit quaternion `q` = [x, y, z, w], then a move by (tx, ty, tz) (default none). */
export function mat34FromQuat<T extends Mat34 = Float64Array>(q: ArrayLike<number>, out?: T, tx = 0, ty = 0, tz = 0): T {
  const x = q[0]!;
  const y = q[1]!;
  const z = q[2]!;
  const w = q[3]!;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return setAll(target(out), 1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), tx, ty, tz);
}

/**
 * `a` after `b`: the matrix that first applies `b`, then `a` (a · b). `out` may be `a` or `b`. A transform stack
 * pushes with `mat34Multiply(parent, local, out)`.
 */
export function mat34Multiply<T extends Mat34 = Float64Array>(a: ArrayLike<number>, b: ArrayLike<number>, out?: T): T {
  const a0 = a[0]!, a1 = a[1]!, a2 = a[2]!, a3 = a[3]!, a4 = a[4]!, a5 = a[5]!, a6 = a[6]!, a7 = a[7]!, a8 = a[8]!, a9 = a[9]!, a10 = a[10]!, a11 = a[11]!;
  const b0 = b[0]!, b1 = b[1]!, b2 = b[2]!, b3 = b[3]!, b4 = b[4]!, b5 = b[5]!, b6 = b[6]!, b7 = b[7]!, b8 = b[8]!, b9 = b[9]!, b10 = b[10]!, b11 = b[11]!;
  return setAll(
    target(out),
    a0 * b0 + a3 * b1 + a6 * b2,
    a1 * b0 + a4 * b1 + a7 * b2,
    a2 * b0 + a5 * b1 + a8 * b2,
    a0 * b3 + a3 * b4 + a6 * b5,
    a1 * b3 + a4 * b4 + a7 * b5,
    a2 * b3 + a5 * b4 + a8 * b5,
    a0 * b6 + a3 * b7 + a6 * b8,
    a1 * b6 + a4 * b7 + a7 * b8,
    a2 * b6 + a5 * b7 + a8 * b8,
    a0 * b9 + a3 * b10 + a6 * b11 + a9,
    a1 * b9 + a4 * b10 + a7 * b11 + a10,
    a2 * b9 + a5 * b10 + a8 * b11 + a11,
  );
}

/** Determinant of the linear part: negative for a mirroring matrix (the winding of its triangles flips), 0 when flat. */
export function mat34Determinant(m: ArrayLike<number>): number {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[3]!, e = m[4]!, f = m[5]!, g = m[6]!, h = m[7]!, i = m[8]!;
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

/** The inverse of `m`, or null (and `out` untouched) when the linear part is singular. */
export function mat34Invert<T extends Mat34 = Float64Array>(m: ArrayLike<number>, out?: T): T | null {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[3]!, e = m[4]!, f = m[5]!, g = m[6]!, h = m[7]!, i = m[8]!;
  const x = m[9]!, y = m[10]!, z = m[11]!;
  const c00 = e * i - f * h;
  const c01 = c * h - b * i;
  const c02 = b * f - c * e;
  const det = a * c00 + d * c01 + g * c02;
  if (det === 0 || !Number.isFinite(det)) return null;
  const k = 1 / det;
  const r0 = c00 * k, r1 = c01 * k, r2 = c02 * k;
  const r3 = (f * g - d * i) * k, r4 = (a * i - c * g) * k, r5 = (c * d - a * f) * k;
  const r6 = (d * h - e * g) * k, r7 = (b * g - a * h) * k, r8 = (a * e - b * d) * k;
  return setAll(target(out), r0, r1, r2, r3, r4, r5, r6, r7, r8, -(r0 * x + r3 * y + r6 * z), -(r1 * x + r4 * y + r7 * z), -(r2 * x + r5 * y + r8 * z));
}

/** The point (x, y, z) moved by `m` (linear part and translation). */
export function mat34Point<O extends Vec3Out = Vec3>(m: ArrayLike<number>, x: number, y: number, z: number, out?: O): O {
  const o = out ?? ([0, 0, 0] as unknown as O);
  const px = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
  const py = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
  const pz = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
  o[0] = px;
  o[1] = py;
  o[2] = pz;
  return o;
}

/** The direction (x, y, z) turned by the linear part only (no translation, not normalised). */
export function mat34Direction<O extends Vec3Out = Vec3>(m: ArrayLike<number>, x: number, y: number, z: number, out?: O): O {
  const o = out ?? ([0, 0, 0] as unknown as O);
  const px = m[0]! * x + m[3]! * y + m[6]! * z;
  const py = m[1]! * x + m[4]! * y + m[7]! * z;
  const pz = m[2]! * x + m[5]! * y + m[8]! * z;
  o[0] = px;
  o[1] = py;
  o[2] = pz;
  return o;
}

/**
 * The surface normal (x, y, z) carried by `m`: the cofactor matrix (the inverse transpose up to the determinant) times
 * the normal, unit length, its sign kept for a mirroring matrix so the normal still points out of the mirrored
 * surface. The same rule as `instanceNormal` in `INSTANCE_SET_GLSL`. A zero result stays zero.
 */
export function mat34Normal<O extends Vec3Out = Vec3>(m: ArrayLike<number>, x: number, y: number, z: number, out?: O): O {
  const o = out ?? ([0, 0, 0] as unknown as O);
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[3]!, e = m[4]!, f = m[5]!, g = m[6]!, h = m[7]!, i = m[8]!;
  // Columns of the cofactor matrix: cross(c1, c2), cross(c2, c0), cross(c0, c1).
  const k0x = e * i - f * h, k0y = f * g - d * i, k0z = d * h - e * g;
  const k1x = h * c - i * b, k1y = i * a - g * c, k1z = g * b - h * a;
  const k2x = b * f - c * e, k2y = c * d - a * f, k2z = a * e - b * d;
  let nx = k0x * x + k1x * y + k2x * z;
  let ny = k0y * x + k1y * y + k2y * z;
  let nz = k0z * x + k1z * y + k2z * z;
  const det = a * k0x + b * k0y + c * k0z;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const s = l > 0 ? (det < 0 ? -1 : 1) / l : 0;
  nx *= s;
  ny *= s;
  nz *= s;
  o[0] = nx;
  o[1] = ny;
  o[2] = nz;
  return o;
}
