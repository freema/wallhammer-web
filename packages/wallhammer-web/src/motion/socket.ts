// Sockets: a named point on a bone with its own turn (a 3 × 4 transform in the bone's frame), whose transform in the
// solved frame is the bone's matrix times it. A thing held at a socket is drawn with that transform. A blend moves a
// held thing from one socket to another over set seconds: positions along a straight line, rotations along the
// shortest arc, scales in between; a mirrored transform (determinant below 0) stays mirrored.
//
// Read sockets last in a frame, after the ground fit, aims and reaches have moved the bones.

import { WeightFade } from './fade.ts';
import { matrixQuat, mul34 } from './quat.ts';

/** A point on a bone: the bone and a 3 × 4 transform in its frame (12 numbers, column by column). */
export interface Socket {
  bone: number;
  local: ArrayLike<number>;
}

/** The identity as a 3 × 4 transform. */
export const IDENTITY_34: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/**
 * A socket's transform from solved bones (`solvePose`, 12 numbers per bone): `world[bone] · local`, into `out` at
 * `o` (12 numbers). Returns `out`.
 */
export function socketTransform<T extends Float32Array | Float64Array>(world: ArrayLike<number>, socket: Socket, out: T, o = 0): T {
  mul34(world, socket.bone * 12, socket.local, 0, out, o);
  return out;
}

const QA = new Float64Array(4);
const QB = new Float64Array(4);
const FLIP = new Float64Array(9);

/** Determinant of the 3 × 3 part of a 3 × 4 transform. */
function det3(m: ArrayLike<number>): number {
  return m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[3]! * (m[1]! * m[8]! - m[2]! * m[7]!) + m[6]! * (m[1]! * m[5]! - m[2]! * m[4]!);
}

/** The rotation of `m` into `q`; with `flip` −1 that of `m` with its first axis reversed (a mirrored `m` made proper). */
function rotationOf(m: ArrayLike<number>, flip: number, q: Float64Array): void {
  if (flip > 0) {
    matrixQuat(m, 0, q);
    return;
  }
  for (let i = 0; i < 9; i++) FLIP[i] = i < 3 ? -m[i]! : m[i]!;
  matrixQuat(FLIP, 0, q);
}

/**
 * Blends two 3 × 4 transforms by `t` 0–1 into `out` (which may be either input): the positions in a line, the
 * rotations along the shortest arc (normalised), each axis's length in a line. Handedness is kept: a mirrored
 * transform (determinant below 0) is taken as a rotation times a reversed first axis, so two mirrored ends give a
 * mirrored blend all the way. Ends of different handedness cannot be joined without passing through a flat transform:
 * the blend then has the first end's handedness for `t` below 0.5 and the second's from 0.5 on, and its first axis
 * turns over there in one step. Returns `out`.
 */
export function blendTransform<T extends Float32Array | Float64Array>(a: ArrayLike<number>, b: ArrayLike<number>, t: number, out: T): T {
  const fa = det3(a) < 0 ? -1 : 1;
  const fb = det3(b) < 0 ? -1 : 1;
  rotationOf(a, fa, QA);
  rotationOf(b, fb, QB);
  let bx = QB[0]!, by = QB[1]!, bz = QB[2]!, bw = QB[3]!;
  if (QA[0]! * bx + QA[1]! * by + QA[2]! * bz + QA[3]! * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let x = QA[0]! + (bx - QA[0]!) * t, y = QA[1]! + (by - QA[1]!) * t, z = QA[2]! + (bz - QA[2]!) * t, w = QA[3]! + (bw - QA[3]!) * t;
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l;
  y /= l;
  z /= l;
  w /= l;
  const s0 = lerp(Math.hypot(a[0]!, a[1]!, a[2]!), Math.hypot(b[0]!, b[1]!, b[2]!), t) * (fa === fb ? fa : t < 0.5 ? fa : fb);
  const s1 = lerp(Math.hypot(a[3]!, a[4]!, a[5]!), Math.hypot(b[3]!, b[4]!, b[5]!), t);
  const s2 = lerp(Math.hypot(a[6]!, a[7]!, a[8]!), Math.hypot(b[6]!, b[7]!, b[8]!), t);
  const px = lerp(a[9]!, b[9]!, t), py = lerp(a[10]!, b[10]!, t), pz = lerp(a[11]!, b[11]!, t);
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  out[0] = (1 - 2 * (yy + zz)) * s0;
  out[1] = 2 * (xy + wz) * s0;
  out[2] = 2 * (xz - wy) * s0;
  out[3] = 2 * (xy - wz) * s1;
  out[4] = (1 - 2 * (xx + zz)) * s1;
  out[5] = 2 * (yz + wx) * s1;
  out[6] = 2 * (xz + wy) * s2;
  out[7] = 2 * (yz - wx) * s2;
  out[8] = (1 - 2 * (xx + yy)) * s2;
  out[9] = px;
  out[10] = py;
  out[11] = pz;
  return out;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const FROM = new Float64Array(12);
const TO = new Float64Array(12);

/**
 * A held thing passed between two sockets (of one figure or of two): `at` 0 holds it at the first, 1 at the second,
 * eased between them over set seconds.
 */
export class SocketBlend {
  /** 0: at the first socket, 1: at the second. */
  readonly fade = new WeightFade(0);

  /** Where the blend is now, 0–1. */
  get at(): number {
    return this.fade.value;
  }

  /** Moves the thing to the first (0) or the second (1) socket over `seconds`. */
  to(goal: number, seconds: number): void {
    this.fade.to(goal, seconds);
  }

  update(dt: number): void {
    this.fade.update(dt);
  }

  /**
   * The thing's transform now, from the bones of the figure holding the first socket (`worldA`) and of the one
   * holding the second (`worldB`, the same array when one figure holds both), into `out`. Returns `out`.
   */
  write<T extends Float32Array | Float64Array>(worldA: ArrayLike<number>, a: Socket, worldB: ArrayLike<number>, b: Socket, out: T): T {
    const t = this.fade.value;
    if (t <= 0) return socketTransform(worldA, a, out);
    if (t >= 1) return socketTransform(worldB, b, out);
    socketTransform(worldA, a, FROM);
    socketTransform(worldB, b, TO);
    return blendTransform(FROM, TO, t, out);
  }
}
