// A body carried at a socket of another: the root of the carried body follows a socket of the carrying body by an
// eased weight. At weight 0 the carried root is the one the game gives it (its own walking or standing place), at
// weight 1 it is the socket's transform, and between them the two are blended (`blendTransform`: positions in a line,
// rotations along the shortest arc, handedness kept). A share of the socket's tilt (`tilt`) lets the carried body keep
// upright while it takes the socket's place and heading: at 0 it takes only the heading (turn about +y of the solve
// frame), at 1 the socket's whole turn.
//
// Order in a frame: the carrying body first, all of it (graph, `solvePose`, ground fit, its own post steps), then
// `write` gives the carried root from the carrier's bones, then the carried body is evaluated and solved on that root,
// then its reaches (hands and feet held at points of the carrier with `TwoBoneReach.setTargetSocket`). Both bodies must
// be solved in the same frame (the same chart on a curved world). Nothing allocates.

import { WeightFade } from './fade.ts';
import { blendTransform, det3, socketTransform } from './socket.ts';
import type { Socket } from './socket.ts';

export interface SocketSeatOptions {
  /**
   * Share of the socket's tilt the carried root takes, 0–1. 1: the socket's whole turn (carried rigidly). 0: only its
   * heading, the carried root kept upright along +y of the solve frame. Default 1.
   */
  tilt?: number;
}

const AT = new Float64Array(12);
const UP = new Float64Array(12);

/**
 * The upright form of a 3 × 4 transform: the same place and heading, its second axis along +y, each axis's length and
 * the handedness kept. The heading is the third axis laid flat; when that axis points almost straight up or down the
 * first axis laid flat gives it.
 */
export function uprightTransform<T extends Float32Array | Float64Array>(m: ArrayLike<number>, out: T): T {
  const flip = det3(m) < 0 ? -1 : 1;
  const l0 = Math.hypot(m[0]!, m[1]!, m[2]!), l1 = Math.hypot(m[3]!, m[4]!, m[5]!), l2 = Math.hypot(m[6]!, m[7]!, m[8]!);
  // The proper rotation's first axis is the first column times `flip`.
  let zx = m[6]! / (l2 || 1), zz = m[8]! / (l2 || 1);
  let lz = Math.hypot(zx, zz);
  if (lz < 1e-4) {
    // Third axis nearly vertical: the first axis laid flat, the third the first × up.
    const xx = (flip * m[0]!) / (l0 || 1), xz = (flip * m[2]!) / (l0 || 1);
    zx = -xz;
    zz = xx;
    lz = Math.hypot(zx, zz);
  }
  if (lz < 1e-12) {
    zx = 0;
    zz = 1;
    lz = 1;
  }
  zx /= lz;
  zz /= lz;
  // First axis = up × third: (zz, 0, −zx).
  out[0] = flip * zz * l0;
  out[1] = 0;
  out[2] = -flip * zx * l0;
  out[3] = 0;
  out[4] = l1;
  out[5] = 0;
  out[6] = zx * l2;
  out[7] = 0;
  out[8] = zz * l2;
  out[9] = m[9]!;
  out[10] = m[10]!;
  out[11] = m[11]!;
  return out;
}

/** The root of a body carried at a socket of another, by an eased weight and a share of the socket's tilt. */
export class SocketSeat {
  /** 0: the free root, 1: on the socket. */
  readonly fade = new WeightFade(0);
  /** Share of the socket's tilt the carried root takes, 0–1 (see `SocketSeatOptions.tilt`). */
  tilt: number;

  constructor(o: SocketSeatOptions = {}) {
    this.tilt = o.tilt ?? 1;
  }

  /** The weight now, 0–1. */
  get weight(): number {
    return this.fade.value;
  }

  /** Eases onto the socket over `seconds`. */
  on(seconds: number): void {
    this.fade.to(1, seconds);
  }

  /** Eases off the socket, back to the free root, over `seconds`. */
  off(seconds: number): void {
    this.fade.to(0, seconds);
  }

  /** Advances the weight by `dt` seconds. */
  update(dt: number): void {
    this.fade.update(dt);
  }

  /**
   * The carried body's root (3 × 4) into `out`: `freeRoot` at weight 0, the socket of the carrier (`carrierWorld`, its
   * solved bones) at weight 1 with `tilt` of its tilt, blended between. `out` may be `freeRoot`. Returns `out`.
   */
  write<T extends Float32Array | Float64Array>(freeRoot: ArrayLike<number>, carrierWorld: ArrayLike<number>, socket: Socket, out: T): T {
    const w = this.fade.value;
    if (w <= 0) {
      if (out !== freeRoot) for (let i = 0; i < 12; i++) out[i] = freeRoot[i]!;
      return out;
    }
    socketTransform(carrierWorld, socket, AT);
    const tilt = this.tilt < 0 ? 0 : this.tilt > 1 ? 1 : this.tilt;
    if (tilt < 1) {
      uprightTransform(AT, UP);
      if (tilt <= 0) AT.set(UP);
      else blendTransform(UP, AT, tilt, AT);
    }
    if (w >= 1) {
      for (let i = 0; i < 12; i++) out[i] = AT[i]!;
      return out;
    }
    return blendTransform(freeRoot, AT, w, out);
  }
}
