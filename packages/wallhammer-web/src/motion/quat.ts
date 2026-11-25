// Small rotation helpers shared by the post steps (reach, aim, sockets): the rotation of a solved bone as a
// quaternion, a world axis carried into a bone's frame, a turn of a bone about a world axis, and products of rigid
// 3 × 4 transforms. Internal to the module (not exported from its index). Scratch at module level: the post steps run
// one at a time. Nothing allocates.

/** Scratch quaternion written by `globalRot`. */
export const Q = new Float64Array(4);
/** Scratch vector written by `toLocal`. */
export const V = new Float64Array(3);

/** Rotation of the 3 × 3 part of `m` at `u` (its columns normalised, so a uniform scale drops out) into `out`. */
export function matrixQuat(m: ArrayLike<number>, u: number, out: Float64Array | Float32Array, o = 0): void {
  const l0 = Math.hypot(m[u]!, m[u + 1]!, m[u + 2]!) || 1;
  const l1 = Math.hypot(m[u + 3]!, m[u + 4]!, m[u + 5]!) || 1;
  const l2 = Math.hypot(m[u + 6]!, m[u + 7]!, m[u + 8]!) || 1;
  const m00 = m[u]! / l0, m10 = m[u + 1]! / l0, m20 = m[u + 2]! / l0;
  const m01 = m[u + 3]! / l1, m11 = m[u + 4]! / l1, m21 = m[u + 5]! / l1;
  const m02 = m[u + 6]! / l2, m12 = m[u + 7]! / l2, m22 = m[u + 8]! / l2;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = w;
}

/** Global rotation of a solved bone (its matrix columns normalised) into Q. */
export function globalRot(world: ArrayLike<number>, u: number): void {
  matrixQuat(world, u, Q);
}

/** World axis into a bone's frame (conjugate of its global rotation in Q) into V. */
export function toLocal(nx: number, ny: number, nz: number): void {
  // v' = q* v q for unit q = (x, y, z, w): rotate by the conjugate.
  const x = -Q[0]!, y = -Q[1]!, z = -Q[2]!, w = Q[3]!;
  const ix = w * nx + y * nz - z * ny;
  const iy = w * ny + z * nx - x * nz;
  const iz = w * nz + x * ny - y * nx;
  const iw = -x * nx - y * ny - z * nz;
  V[0] = ix * w + iw * -x + iy * -z - iz * -y;
  V[1] = iy * w + iw * -y + iz * -x - ix * -z;
  V[2] = iz * w + iw * -z + ix * -y - iy * -x;
}

/** rot[q] = rot[q] · R(local axis of the world axis n, angle), with the bone's global rotation from `world`. */
export function rotateLocal(rot: Float32Array, q: number, world: ArrayLike<number>, u: number, nx: number, ny: number, nz: number, angle: number): void {
  if (angle === 0) return;
  globalRot(world, u);
  toLocal(nx, ny, nz);
  mulAxisAngle(rot, q, V[0]!, V[1]!, V[2]!, angle);
}

/** rot[q] = rot[q] · R(axis, angle) (the axis in the bone's own frame, normalised here). */
export function mulAxisAngle(rot: Float32Array, q: number, ax: number, ay: number, az: number, angle: number): void {
  const l = Math.hypot(ax, ay, az);
  if (l < 1e-12) return;
  const s = Math.sin(angle / 2) / l, c = Math.cos(angle / 2);
  const bx = ax * s, by = ay * s, bz = az * s;
  const x = rot[q]!, y = rot[q + 1]!, z = rot[q + 2]!, w = rot[q + 3]!;
  rot[q] = w * bx + x * c + y * bz - z * by;
  rot[q + 1] = w * by - x * bz + y * c + z * bx;
  rot[q + 2] = w * bz + x * by - y * bx + z * c;
  rot[q + 3] = w * c - x * bx - y * by - z * bz;
}

/** rot[q] = `from` blended toward rot[q] by w (normalised, shortest arc). */
export function nlerpFrom(rot: Float32Array, q: number, from: ArrayLike<number>, w: number): void {
  let bx = rot[q]!, by = rot[q + 1]!, bz = rot[q + 2]!, bw = rot[q + 3]!;
  if (from[0]! * bx + from[1]! * by + from[2]! * bz + from[3]! * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const x = from[0]! + (bx - from[0]!) * w, y = from[1]! + (by - from[1]!) * w, z = from[2]! + (bz - from[2]!) * w, ww = from[3]! + (bw - from[3]!) * w;
  const l = Math.hypot(x, y, z, ww) || 1;
  rot[q] = x / l;
  rot[q + 1] = y / l;
  rot[q + 2] = z / l;
  rot[q + 3] = ww / l;
}

/** `out` = `a` · `b` for 3 × 4 transforms (12 numbers each, column by column). `out` may not be `b`. */
export function mul34(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, out: Float64Array | Float32Array, oo: number): void {
  const a0 = a[ao]!, a1 = a[ao + 1]!, a2 = a[ao + 2]!, a3 = a[ao + 3]!, a4 = a[ao + 4]!, a5 = a[ao + 5]!;
  const a6 = a[ao + 6]!, a7 = a[ao + 7]!, a8 = a[ao + 8]!, a9 = a[ao + 9]!, a10 = a[ao + 10]!, a11 = a[ao + 11]!;
  for (let c = 0; c < 4; c++) {
    const x = b[bo + c * 3]!, y = b[bo + c * 3 + 1]!, z = b[bo + c * 3 + 2]!;
    const t = c === 3 ? 1 : 0;
    out[oo + c * 3] = a0 * x + a3 * y + a6 * z + a9 * t;
    out[oo + c * 3 + 1] = a1 * x + a4 * y + a7 * z + a10 * t;
    out[oo + c * 3 + 2] = a2 * x + a5 * y + a8 * z + a11 * t;
  }
}
