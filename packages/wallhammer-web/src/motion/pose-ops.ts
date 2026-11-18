// Operations on poses: override blend, additive layer, the difference of two poses, writing a bone's rotation from
// angles, and solving a pose into world matrices (3 × 4, 12 numbers per bone, the instance record layout of `base`).
// Everything writes into arrays it is given and allocates nothing; `out` may be the same pose as an input.
//
// Rotations blend by normalised linear interpolation along the shortest arc (the sign of one quaternion is flipped
// when the two lie more than half a turn apart). An additive pose is a change from the rest pose: its rotation is
// applied after the base rotation in the bone's own frame (base · add), its offset is added.

import type { BoneMask, Pose, Skeleton } from './skeleton.ts';

/** `out` = `a` blended toward `b` by `w` (0 = a, 1 = b), per bone times `mask` when given. */
export function blendPose(out: Pose, a: Pose, b: Pose, w: number, mask?: BoneMask | null): void {
  const n = out.skeleton.count;
  const ra = a.rot, rb = b.rot, ro = out.rot;
  const oa = a.offset, ob = b.offset, oo = out.offset;
  for (let i = 0; i < n; i++) {
    const t = mask ? w * mask[i]! : w;
    const q = i * 4;
    const p = i * 3;
    if (t <= 0) {
      if (out !== a) {
        ro[q] = ra[q]!;
        ro[q + 1] = ra[q + 1]!;
        ro[q + 2] = ra[q + 2]!;
        ro[q + 3] = ra[q + 3]!;
        oo[p] = oa[p]!;
        oo[p + 1] = oa[p + 1]!;
        oo[p + 2] = oa[p + 2]!;
      }
      continue;
    }
    if (t >= 1) {
      ro[q] = rb[q]!;
      ro[q + 1] = rb[q + 1]!;
      ro[q + 2] = rb[q + 2]!;
      ro[q + 3] = rb[q + 3]!;
      oo[p] = ob[p]!;
      oo[p + 1] = ob[p + 1]!;
      oo[p + 2] = ob[p + 2]!;
      continue;
    }
    nlerpInto(ro, q, ra[q]!, ra[q + 1]!, ra[q + 2]!, ra[q + 3]!, rb[q]!, rb[q + 1]!, rb[q + 2]!, rb[q + 3]!, t);
    oo[p] = oa[p]! + (ob[p]! - oa[p]!) * t;
    oo[p + 1] = oa[p + 1]! + (ob[p + 1]! - oa[p + 1]!) * t;
    oo[p + 2] = oa[p + 2]! + (ob[p + 2]! - oa[p + 2]!) * t;
  }
}

/** `out` = `base` with the additive pose `add` applied by `w`, per bone times `mask` when given. */
export function addPose(out: Pose, base: Pose, add: Pose, w: number, mask?: BoneMask | null): void {
  const n = out.skeleton.count;
  const rb = base.rot, ra = add.rot, ro = out.rot;
  const ob = base.offset, oa = add.offset, oo = out.offset;
  for (let i = 0; i < n; i++) {
    const t = mask ? w * mask[i]! : w;
    const q = i * 4;
    const p = i * 3;
    const bx = rb[q]!, by = rb[q + 1]!, bz = rb[q + 2]!, bw = rb[q + 3]!;
    if (t === 0) {
      ro[q] = bx;
      ro[q + 1] = by;
      ro[q + 2] = bz;
      ro[q + 3] = bw;
      oo[p] = ob[p]!;
      oo[p + 1] = ob[p + 1]!;
      oo[p + 2] = ob[p + 2]!;
      continue;
    }
    // The change scaled toward identity by t (nlerp from [0, 0, 0, 1]).
    let x = ra[q]!, y = ra[q + 1]!, z = ra[q + 2]!, s = ra[q + 3]!;
    if (t !== 1) {
      if (s < 0) {
        x = -x;
        y = -y;
        z = -z;
        s = -s;
      }
      x *= t;
      y *= t;
      z *= t;
      s = 1 - t + s * t;
      const l = Math.sqrt(x * x + y * y + z * z + s * s) || 1;
      x /= l;
      y /= l;
      z /= l;
      s /= l;
    }
    ro[q] = bw * x + bx * s + by * z - bz * y;
    ro[q + 1] = bw * y - bx * z + by * s + bz * x;
    ro[q + 2] = bw * z + bx * y - by * x + bz * s;
    ro[q + 3] = bw * s - bx * x - by * y - bz * z;
    oo[p] = ob[p]! + oa[p]! * t;
    oo[p + 1] = ob[p + 1]! + oa[p + 1]! * t;
    oo[p + 2] = ob[p + 2]! + oa[p + 2]! * t;
  }
}

/** `out` = the additive pose that turns `ref` into `a` (ref⁻¹ · a per bone, offsets a − ref). */
export function subtractPose(out: Pose, a: Pose, ref: Pose): void {
  const n = out.skeleton.count;
  const ra = a.rot, rr = ref.rot, ro = out.rot;
  for (let i = 0; i < n; i++) {
    const q = i * 4;
    const cx = -rr[q]!, cy = -rr[q + 1]!, cz = -rr[q + 2]!, cw = rr[q + 3]!;
    const x = ra[q]!, y = ra[q + 1]!, z = ra[q + 2]!, w = ra[q + 3]!;
    ro[q] = cw * x + cx * w + cy * z - cz * y;
    ro[q + 1] = cw * y - cx * z + cy * w + cz * x;
    ro[q + 2] = cw * z + cx * y - cy * x + cz * w;
    ro[q + 3] = cw * w - cx * x - cy * y - cz * z;
  }
  const oa = a.offset, or = ref.offset, oo = out.offset;
  for (let k = 0; k < n * 3; k++) oo[k] = oa[k]! - or[k]!;
}

/** Sets a bone's rotation to the quaternion (x, y, z, w), normalised. */
export function setBoneRotation(pose: Pose, bone: number, x: number, y: number, z: number, w: number): void {
  const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  const r = pose.rot;
  const q = bone * 4;
  r[q] = x / l;
  r[q + 1] = y / l;
  r[q + 2] = z / l;
  r[q + 3] = w / l;
}

/** Sets a bone's rotation to `rad` radians about the axis (ax, ay, az) (normalised; a zero axis gives identity). */
export function setBoneAxisAngle(pose: Pose, bone: number, ax: number, ay: number, az: number, rad: number): void {
  const l = Math.sqrt(ax * ax + ay * ay + az * az);
  const r = pose.rot;
  const q = bone * 4;
  if (l === 0) {
    r[q] = 0;
    r[q + 1] = 0;
    r[q + 2] = 0;
    r[q + 3] = 1;
    return;
  }
  const s = Math.sin(rad / 2) / l;
  r[q] = ax * s;
  r[q + 1] = ay * s;
  r[q + 2] = az * s;
  r[q + 3] = Math.cos(rad / 2);
}

/** Order of the three factors of `setBoneEuler`, left to right in the product (`'yxz'`: Ry · Rx · Rz). */
export type EulerOrder = 'xyz' | 'xzy' | 'yxz' | 'yzx' | 'zxy' | 'zyx';

/**
 * Sets a bone's rotation from angles about its local x, y and z (radians, right-handed), multiplied in `order`
 * from left to right: `'xyz'` (default) is Rx · Ry · Rz, so z is applied to a point first.
 */
export function setBoneEuler(pose: Pose, bone: number, rx: number, ry: number, rz: number, order: EulerOrder = 'xyz'): void {
  const hx = rx / 2, hy = ry / 2, hz = rz / 2;
  const sx = Math.sin(hx), cx = Math.cos(hx);
  const sy = Math.sin(hy), cy = Math.cos(hy);
  const sz = Math.sin(hz), cz = Math.cos(hz);
  // Start with the first factor, multiply the next two on the right.
  let x = 0, y = 0, z = 0, w = 1;
  for (let k = 0; k < 3; k++) {
    const axis = order.charCodeAt(k) - 120; // 0 x, 1 y, 2 z
    const s = axis === 0 ? sx : axis === 1 ? sy : sz;
    const c = axis === 0 ? cx : axis === 1 ? cy : cz;
    const bx = axis === 0 ? s : 0, by = axis === 1 ? s : 0, bz = axis === 2 ? s : 0;
    const nx = w * bx + x * c + y * bz - z * by;
    const ny = w * by - x * bz + y * c + z * bx;
    const nz = w * bz + x * by - y * bx + z * c;
    const nw = w * c - x * bx - y * by - z * bz;
    x = nx;
    y = ny;
    z = nz;
    w = nw;
  }
  const r = pose.rot;
  const q = bone * 4;
  r[q] = x;
  r[q + 1] = y;
  r[q + 2] = z;
  r[q + 3] = w;
}

/**
 * World 3 × 4 matrix of every bone into `outWorld` (12 numbers per bone, column by column): a root bone is placed
 * by `root` (a 3 × 4 matrix), every other one by its parent; local = translate(joint + offset) · rotate(rot).
 */
export function solvePose(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, outWorld: Float32Array | Float64Array): void {
  solveRange(skeleton, pose, root, outWorld, -1);
}

/**
 * Like `solvePose`, but only `bone` and the bones below it, from the parent matrices already in `outWorld`: after a
 * change of the pose of that bone (a reach), the rest of the skeleton stays as it was solved.
 */
export function solvePoseBelow(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, outWorld: Float32Array | Float64Array, bone: number): void {
  solveRange(skeleton, pose, root, outWorld, bone);
}

function solveRange(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, out: Float32Array | Float64Array, from: number): void {
  const n = skeleton.count;
  const par = skeleton.parent, jt = skeleton.joint, rot = pose.rot, off = pose.offset;
  for (let b = from < 0 ? 0 : from; b < n; b++) {
    if (from >= 0 && b !== from && !skeleton.isBelow(b, from)) continue;
    const q = b * 4;
    const x = rot[q]!, y = rot[q + 1]!, z = rot[q + 2]!, w = rot[q + 3]!;
    // Local rotation columns.
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    const l0 = 1 - 2 * (yy + zz), l1 = 2 * (xy + wz), l2 = 2 * (xz - wy);
    const l3 = 2 * (xy - wz), l4 = 1 - 2 * (xx + zz), l5 = 2 * (yz + wx);
    const l6 = 2 * (xz + wy), l7 = 2 * (yz - wx), l8 = 1 - 2 * (xx + yy);
    const tx = jt[b * 3]! + off[b * 3]!, ty = jt[b * 3 + 1]! + off[b * 3 + 1]!, tz = jt[b * 3 + 2]! + off[b * 3 + 2]!;
    const p = par[b]!;
    const P: ArrayLike<number> = p < 0 ? root : out;
    const o = p < 0 ? 0 : p * 12;
    const a0 = P[o]!, a1 = P[o + 1]!, a2 = P[o + 2]!, a3 = P[o + 3]!, a4 = P[o + 4]!, a5 = P[o + 5]!;
    const a6 = P[o + 6]!, a7 = P[o + 7]!, a8 = P[o + 8]!, a9 = P[o + 9]!, a10 = P[o + 10]!, a11 = P[o + 11]!;
    const d = b * 12;
    out[d] = a0 * l0 + a3 * l1 + a6 * l2;
    out[d + 1] = a1 * l0 + a4 * l1 + a7 * l2;
    out[d + 2] = a2 * l0 + a5 * l1 + a8 * l2;
    out[d + 3] = a0 * l3 + a3 * l4 + a6 * l5;
    out[d + 4] = a1 * l3 + a4 * l4 + a7 * l5;
    out[d + 5] = a2 * l3 + a5 * l4 + a8 * l5;
    out[d + 6] = a0 * l6 + a3 * l7 + a6 * l8;
    out[d + 7] = a1 * l6 + a4 * l7 + a7 * l8;
    out[d + 8] = a2 * l6 + a5 * l7 + a8 * l8;
    out[d + 9] = a0 * tx + a3 * ty + a6 * tz + a9;
    out[d + 10] = a1 * tx + a4 * ty + a7 * tz + a10;
    out[d + 11] = a2 * tx + a5 * ty + a8 * tz + a11;
  }
}

/** Normalised linear interpolation of two quaternions along the shortest arc into `o` at `q`. */
export function nlerpInto(o: Float32Array | Float64Array, q: number, ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, t: number): void {
  if (ax * bx + ay * by + az * bz + aw * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, w = aw + (bw - aw) * t;
  const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  o[q] = x / l;
  o[q + 1] = y / l;
  o[q + 2] = z / l;
  o[q + 3] = w / l;
}
