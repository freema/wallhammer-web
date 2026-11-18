// The village's angle convention for its skeletons and part matrices (the engine's motion multiplies, blends and
// solves; see rig.ts). A matrix is 12 floats, in the column layout of the engine's Mat34: the images of the local x,
// y and z axes, then the translation. Rotation order and conventions follow `compose34` (kit/math.ts):
//   R = Ry(yaw) · Rx(pitch) · Rz(roll)
//   yaw   about +y, local +z turns toward +x (the village heading convention)
//   pitch about the local x, positive tips +y toward +z (a hanging limb, −y, swings backward; forward is negative)
//   roll  about the local z, positive tips +y toward −x (a hanging limb swings toward +x)
// A figure faces +z, so its left side is +x and its right side is −x.

/** Floats per matrix. */
export const M = 12;

type F = Float32Array | Float64Array;

/** out[o…] = T(t) · Ry(yaw) · Rx(pitch) · Rz(roll) · S(s). */
export function trs(out: F, o: number, tx: number, ty: number, tz: number, yaw: number, pitch: number, roll: number, sx: number, sy: number, sz: number): void {
  const cy = Math.cos(yaw), sy0 = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  out[o] = (cy * cr + sy0 * sp * sr) * sx;
  out[o + 1] = cp * sr * sx;
  out[o + 2] = (-sy0 * cr + cy * sp * sr) * sx;
  out[o + 3] = (-cy * sr + sy0 * sp * cr) * sy;
  out[o + 4] = cp * cr * sy;
  out[o + 5] = (sy0 * sr + cy * sp * cr) * sy;
  out[o + 6] = sy0 * cp * sz;
  out[o + 7] = -sp * sz;
  out[o + 8] = cy * cp * sz;
  out[o + 9] = tx;
  out[o + 10] = ty;
  out[o + 11] = tz;
}

/** A matrix that collapses everything to one point far below the world (a hidden instance draws nothing). */
export function collapse(out: F, o: number): void {
  for (let k = 0; k < 9; k++) out[o + k] = 0;
  out[o + 9] = 0;
  out[o + 10] = -1000;
  out[o + 11] = 0;
}

/**
 * A part matrix (build time) that maps the unit segment of `villagerSegment` (axis +y from 0 to 1, radius 1 at
 * the thick end y = 1) onto the line `from` → `to` with radii `rx` (across, along the bone's x where possible) and
 * `rz` (the third axis). The thick end lands on `to`. The result is right-handed (no mirroring).
 */
export function segmentMatrix(from: readonly number[], to: readonly number[], rx: number, rz: number, twist = 0): Float32Array {
  const yx = to[0]! - from[0]!, yy = to[1]! - from[1]!, yz = to[2]! - from[2]!;
  const L = Math.hypot(yx, yy, yz) || 1e-6;
  const ux = yx / L, uy = yy / L, uz = yz / L;
  // Reference for the x axis: the bone's x, unless the segment runs along it.
  let rxv = 1, ryv = 0, rzv = 0;
  if (Math.abs(ux) > 0.9) (rxv = 0), (rzv = 1);
  // z = x_ref × y, then x = y × z: right-handed (x × y = z).
  let zx = ryv * uz - rzv * uy, zy = rzv * ux - rxv * uz, zz = rxv * uy - ryv * ux;
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  if (twist !== 0) {
    const c = Math.cos(twist), s = Math.sin(twist);
    const nx = xx * c + zx * s, ny = xy * c + zy * s, nz = xz * c + zz * s;
    zx = zx * c - xx * s; zy = zy * c - xy * s; zz = zz * c - xz * s;
    xx = nx; xy = ny; xz = nz;
  }
  const m = new Float32Array(M);
  m[0] = xx * rx; m[1] = xy * rx; m[2] = xz * rx;
  m[3] = yx; m[4] = yy; m[5] = yz;
  m[6] = zx * rz; m[7] = zy * rz; m[8] = zz * rz;
  m[9] = from[0]!; m[10] = from[1]!; m[11] = from[2]!;
  return m;
}

/** A part matrix (build time): translation, rotation and scale. */
export function partMatrix(t: readonly number[], s: readonly number[], yaw = 0, pitch = 0, roll = 0): Float32Array {
  const m = new Float32Array(M);
  trs(m, 0, t[0]!, t[1]!, t[2]!, yaw, pitch, roll, s[0]!, s[1]!, s[2]!);
  return m;
}

/** Shortest signed angle from a to b. */
export function angleTo(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 0–1 ease in and out. */
export const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
