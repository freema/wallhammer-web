// Nested reference frames. A frame is an origin and a rotation given in its parent frame; frames form a hierarchy
// (a whole system at the top, a moving body below it, a patch of the body's surface below that). Every position is
// kept in the frame it is naturally small or exact in, as 64-bit numbers on the CPU. Only a difference to the eye,
// taken in 64 bits, ever becomes a 32-bit float for the GPU (`relativeMatrix`, `relativePoints`), so an object next
// to the eye keeps its precision however far the frames are from the top origin.
//
// A conversion between two frames walks up to their lowest common frame and down again, so numbers of the far
// levels never enter a conversion between neighbours. Frames may move: a frame can carry the velocity of its origin
// and its angular velocity, and `convertState` and `reparent` account for both.
//
// All arithmetic is + − × ÷ and `Math.sqrt`, rotations come from the reproducible sine and cosine of `trig.ts`, so
// the same inputs give the same bits on every machine.

import type { Vec3 } from './math.ts';
import { detAsin, detAtan2, detSinCosTurns, RAD_PER_TURN } from './trig.ts';

type V3 = readonly [number, number, number];

/** Rotation as a unit quaternion `[x, y, z, w]`. */
export type Quat = [number, number, number, number];
type Q4 = readonly [number, number, number, number];

export function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}

/** Rotation by `turns` (1 = 360°) about a unit axis, right-handed. */
export function quatAxisTurns(axis: V3, turns: number): Quat {
  const [s, c] = detSinCosTurns((turns - Math.floor(turns)) * 0.5);
  return [axis[0] * s, axis[1] * s, axis[2] * s, c];
}

/** The rotation "first `b`, then `a`". */
export function quatMul(a: Q4, b: Q4): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** The opposite rotation of a unit quaternion. */
export function quatConj(q: Q4): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Q4): Quat {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Turns a vector by a unit quaternion. `out` may be the same array as `v`. */
export function quatRotate(q: Q4, v: V3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const vx = v[0];
  const vy = v[1];
  const vz = v[2];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** Rotation whose turned x, y and z axes are the given unit, mutually perpendicular, right-handed vectors. */
export function quatFromAxes(x: V3, y: V3, z: V3): Quat {
  const m00 = x[0];
  const m10 = x[1];
  const m20 = x[2];
  const m01 = y[0];
  const m11 = y[1];
  const m21 = y[2];
  const m02 = z[0];
  const m12 = z[1];
  const m22 = z[2];
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/** Where a frame sits in another frame: a local point p is at `origin + rotation · p` there. All 64-bit. */
export interface FramePose {
  origin: Vec3;
  rotation: Quat;
}

/** A point with its velocity, both in the coordinates of one frame and relative to that frame. */
export interface FrameState {
  position: Vec3;
  velocity: Vec3;
}

/** Unit direction and distance from a point to the origin of a frame. */
export interface FrameBearing {
  direction: Vec3;
  distance: number;
}

/** Parent of a top frame. */
export const FRAME_NONE = -1;

// Record of one frame: origin 3, rotation 4, velocity of the origin 3, angular velocity 3 (all in the parent).
const STRIDE = 13;
const AT_ROT = 3;
const AT_VEL = 7;
const AT_SPIN = 10;

/** A point carried between frames with everything that changes on the way. */
interface Carried {
  p: Vec3;
  v: Vec3;
  q: Quat;
  w: Vec3;
}

/**
 * A hierarchy of frames. A frame is a small integer id; ids are given out in order and never reused. A top frame
 * (parent `FRAME_NONE`) has no pose. Frames under different top frames cannot be converted to each other.
 */
export class FrameSet {
  private readonly parents: number[] = [];
  private readonly names: string[] = [];
  private data = new Float64Array(8 * STRIDE);

  get count(): number {
    return this.parents.length;
  }

  /** Adds a frame under `parent` (a top frame when omitted) and returns its id. */
  add(name: string, parent: number = FRAME_NONE, pose?: Partial<FramePose>): number {
    if (parent !== FRAME_NONE) this.check(parent);
    const id = this.parents.length;
    if ((id + 1) * STRIDE > this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.parents.push(parent);
    this.names.push(name);
    this.data[id * STRIDE + AT_ROT + 3] = 1;
    if (pose?.origin) this.setOrigin(id, pose.origin);
    if (pose?.rotation) this.setRotation(id, pose.rotation);
    return id;
  }

  private check(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= this.parents.length) throw new Error(`frames: no frame ${id}`);
  }

  name(id: number): string {
    this.check(id);
    return this.names[id]!;
  }

  /** Id of the first frame with this name, or `FRAME_NONE`. */
  find(name: string): number {
    return this.names.indexOf(name);
  }

  /** Parent of a frame, `FRAME_NONE` for a top frame. */
  parent(id: number): number {
    this.check(id);
    return this.parents[id]!;
  }

  /** Number of frames above this one (0 for a top frame). */
  depth(id: number): number {
    this.check(id);
    let d = 0;
    for (let f = this.parents[id]!; f !== FRAME_NONE; f = this.parents[f]!) d++;
    return d;
  }

  /** Origin of the frame in its parent (metres, 64-bit). */
  setOrigin(id: number, origin: V3): void {
    this.check(id);
    const at = id * STRIDE;
    this.data[at] = origin[0];
    this.data[at + 1] = origin[1];
    this.data[at + 2] = origin[2];
  }

  /** Rotation of the frame in its parent (a unit quaternion). */
  setRotation(id: number, rotation: Q4): void {
    this.check(id);
    const at = id * STRIDE + AT_ROT;
    this.data[at] = rotation[0];
    this.data[at + 1] = rotation[1];
    this.data[at + 2] = rotation[2];
    this.data[at + 3] = rotation[3];
  }

  setPose(id: number, pose: FramePose): void {
    this.setOrigin(id, pose.origin);
    this.setRotation(id, pose.rotation);
  }

  /**
   * How the frame moves in its parent: velocity of its origin (m/s) and its angular velocity (rad/s, the vector along
   * the turning axis), both in parent coordinates. Only `convertState` and `reparent` read it; a frame that is moved
   * by `setOrigin` alone counts as standing.
   */
  setMotion(id: number, velocity: V3, spin: V3 = [0, 0, 0]): void {
    this.check(id);
    const at = id * STRIDE;
    for (let k = 0; k < 3; k++) {
      this.data[at + AT_VEL + k] = velocity[k]!;
      this.data[at + AT_SPIN + k] = spin[k]!;
    }
  }

  /** Pose of the frame in its parent (a copy). */
  pose(id: number): FramePose {
    this.check(id);
    const d = this.data;
    const at = id * STRIDE;
    return { origin: [d[at]!, d[at + 1]!, d[at + 2]!], rotation: [d[at + 3]!, d[at + 4]!, d[at + 5]!, d[at + 6]!] };
  }

  /** Velocity of the frame's origin in its parent. */
  velocity(id: number): Vec3 {
    this.check(id);
    const at = id * STRIDE + AT_VEL;
    return [this.data[at]!, this.data[at + 1]!, this.data[at + 2]!];
  }

  /** Angular velocity of the frame in its parent. */
  spin(id: number): Vec3 {
    this.check(id);
    const at = id * STRIDE + AT_SPIN;
    return [this.data[at]!, this.data[at + 1]!, this.data[at + 2]!];
  }

  /** The deepest frame that both frames lie in or under (either of them when one is above the other). */
  commonAncestor(a: number, b: number): number {
    let da = this.depth(a);
    let db = this.depth(b);
    let fa = a;
    let fb = b;
    for (; da > db; da--) fa = this.parents[fa]!;
    for (; db > da; db--) fb = this.parents[fb]!;
    while (fa !== fb) {
      fa = this.parents[fa]!;
      fb = this.parents[fb]!;
      if (fa === FRAME_NONE || fb === FRAME_NONE) return FRAME_NONE;
    }
    return fa;
  }

  /** One level up: from the coordinates of frame `f` to those of its parent. */
  private up(f: number, s: Carried): void {
    const d = this.data;
    const at = f * STRIDE;
    const r: Q4 = [d[at + 3]!, d[at + 4]!, d[at + 5]!, d[at + 6]!];
    const wx = d[at + AT_SPIN]!;
    const wy = d[at + AT_SPIN + 1]!;
    const wz = d[at + AT_SPIN + 2]!;
    quatRotate(r, s.p, s.p);
    quatRotate(r, s.v, s.v);
    quatRotate(r, s.w, s.w);
    const px = s.p[0];
    const py = s.p[1];
    const pz = s.p[2];
    s.v[0] += d[at + AT_VEL]! + (wy * pz - wz * py);
    s.v[1] += d[at + AT_VEL + 1]! + (wz * px - wx * pz);
    s.v[2] += d[at + AT_VEL + 2]! + (wx * py - wy * px);
    s.p[0] = d[at]! + px;
    s.p[1] = d[at + 1]! + py;
    s.p[2] = d[at + 2]! + pz;
    s.w[0] += wx;
    s.w[1] += wy;
    s.w[2] += wz;
    s.q = quatMul(r, s.q);
  }

  /** One level down: from the coordinates of the parent of frame `f` to those of `f`. */
  private down(f: number, s: Carried): void {
    const d = this.data;
    const at = f * STRIDE;
    const inv: Q4 = [-d[at + 3]!, -d[at + 4]!, -d[at + 5]!, d[at + 6]!];
    const wx = d[at + AT_SPIN]!;
    const wy = d[at + AT_SPIN + 1]!;
    const wz = d[at + AT_SPIN + 2]!;
    const px = s.p[0] - d[at]!;
    const py = s.p[1] - d[at + 1]!;
    const pz = s.p[2] - d[at + 2]!;
    s.v[0] -= d[at + AT_VEL]! + (wy * pz - wz * py);
    s.v[1] -= d[at + AT_VEL + 1]! + (wz * px - wx * pz);
    s.v[2] -= d[at + AT_VEL + 2]! + (wx * py - wy * px);
    s.p[0] = px;
    s.p[1] = py;
    s.p[2] = pz;
    s.w[0] -= wx;
    s.w[1] -= wy;
    s.w[2] -= wz;
    quatRotate(inv, s.p, s.p);
    quatRotate(inv, s.v, s.v);
    quatRotate(inv, s.w, s.w);
    s.q = quatMul(inv, s.q);
  }

  /** Carries a point with its velocity, orientation and angular velocity from frame `from` to frame `to`. */
  private carry(s: Carried, from: number, to: number): void {
    const top = this.commonAncestor(from, to);
    if (top === FRAME_NONE) throw new Error(`frames: "${this.names[from]}" and "${this.names[to]}" have no common frame`);
    for (let f = from; f !== top; f = this.parents[f]!) this.up(f, s);
    const chain: number[] = [];
    for (let f = to; f !== top; f = this.parents[f]!) chain.push(f);
    for (let i = chain.length - 1; i >= 0; i--) this.down(chain[i]!, s);
  }

  /** A point given in frame `from`, in the coordinates of frame `to` (64-bit). */
  convertPoint(p: V3, from: number, to: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const s: Carried = { p: [p[0], p[1], p[2]], v: [0, 0, 0], q: [0, 0, 0, 1], w: [0, 0, 0] };
    this.carry(s, from, to);
    out[0] = s.p[0];
    out[1] = s.p[1];
    out[2] = s.p[2];
    return out;
  }

  /** A direction (or any difference of two points) given in frame `from`, in the coordinates of frame `to`. */
  convertDirection(d: V3, from: number, to: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return quatRotate(this.convertRotation([0, 0, 0, 1], from, to), d, out);
  }

  /** An orientation given in frame `from`, in the coordinates of frame `to`. */
  convertRotation(q: Q4, from: number, to: number): Quat {
    const s: Carried = { p: [0, 0, 0], v: [0, 0, 0], q: [q[0], q[1], q[2], q[3]], w: [0, 0, 0] };
    this.carry(s, from, to);
    return quatNormalize(s.q);
  }

  /**
   * A point and its velocity given in (and relative to) frame `from`, in and relative to frame `to`. Uses the motion
   * of the frames on the way (`setMotion`): a point standing on a turning frame moves when seen from its parent.
   */
  convertState(position: V3, velocity: V3, from: number, to: number): FrameState {
    const s: Carried = { p: [position[0], position[1], position[2]], v: [velocity[0], velocity[1], velocity[2]], q: [0, 0, 0, 1], w: [0, 0, 0] };
    this.carry(s, from, to);
    return { position: s.p, velocity: s.v };
  }

  /** Pose of frame `from` in frame `to`: a point p of `from` is at `origin + rotation · p` in `to`. */
  relativePose(from: number, to: number): FramePose {
    const s: Carried = { p: [0, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], w: [0, 0, 0] };
    this.carry(s, from, to);
    return { origin: s.p, rotation: quatNormalize(s.q) };
  }

  /**
   * Unit direction and distance from the point `at` of frame `frame` to the origin of frame `target`, in the
   * coordinates of `frame`. With a light at the origin of `target` this is the direction toward the light.
   */
  directionTo(target: number, frame: number, at: V3 = [0, 0, 0]): FrameBearing {
    const p = this.convertPoint([0, 0, 0], target, frame);
    const x = p[0] - at[0];
    const y = p[1] - at[1];
    const z = p[2] - at[2];
    const distance = Math.sqrt(x * x + y * y + z * z);
    return { direction: distance > 0 ? [x / distance, y / distance, z / distance] : [0, 1, 0], distance };
  }

  /**
   * Moves a frame under another parent without moving it: its pose, velocity and angular velocity are rewritten so
   * that everything in it stays where it was. Both parents must lie under the same top frame, and the new parent
   * must not be the frame itself or one of the frames below it. Do it on a simulation step, never between steps.
   */
  reparent(id: number, parent: number): void {
    this.check(id);
    this.check(parent);
    const old = this.parents[id]!;
    if (old === parent) return;
    if (old === FRAME_NONE) throw new Error(`frames: "${this.names[id]}" is a top frame and cannot get a parent`);
    for (let f = parent; f !== FRAME_NONE; f = this.parents[f]!) {
      if (f === id) throw new Error(`frames: "${this.names[parent]}" lies under "${this.names[id]}"`);
    }
    const pose = this.pose(id);
    const s: Carried = { p: pose.origin, v: this.velocity(id), q: pose.rotation, w: this.spin(id) };
    this.carry(s, old, parent);
    this.parents[id] = parent;
    this.setOrigin(id, s.p);
    this.setRotation(id, quatNormalize(s.q));
    this.setMotion(id, s.v, s.w);
  }

  /**
   * 32-bit digest of every bit of every frame (parents, poses, motion). Two runs that agree here agree exactly; use
   * it to compare a stepped run with a jump in time, or one machine with another.
   */
  fingerprint(): number {
    const n = this.parents.length;
    const view = new DataView(this.data.buffer, this.data.byteOffset, n * STRIDE * 8);
    let h = 0x811c9dc5 ^ n;
    for (let i = 0; i < n; i++) h = Math.imul(h ^ (this.parents[i]! + 1), 0x01000193);
    for (let i = 0; i < view.byteLength; i += 4) {
      h = Math.imul(h ^ view.getUint32(i, true), 0x01000193);
      h ^= h >>> 15;
    }
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
}

/**
 * Model matrix for the GPU (4×4, column-major, 32-bit): takes the local coordinates of a frame to coordinates
 * relative to the eye. `pose` is the frame in the frame the image is drawn in (`FrameSet.relativePose`), `eye` a
 * point of that drawing frame (the camera or a render origin near it). The translation is the 64-bit difference
 * `pose.origin − eye` and only then rounded, so it is small and exact near the eye.
 */
export function relativeMatrix(pose: FramePose, eye: V3, out: Float32Array = new Float32Array(16)): Float32Array {
  const [x, y, z, w] = pose.rotation;
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y + w * z);
  out[2] = 2 * (x * z - w * y);
  out[3] = 0;
  out[4] = 2 * (x * y - w * z);
  out[5] = 1 - 2 * (x * x + z * z);
  out[6] = 2 * (y * z + w * x);
  out[7] = 0;
  out[8] = 2 * (x * z + w * y);
  out[9] = 2 * (y * z - w * x);
  out[10] = 1 - 2 * (x * x + y * y);
  out[11] = 0;
  out[12] = pose.origin[0] - eye[0];
  out[13] = pose.origin[1] - eye[1];
  out[14] = pose.origin[2] - eye[2];
  out[15] = 1;
  return out;
}

/**
 * 64-bit points (x, y, z triples) to 32-bit positions relative to the eye. With a `pose` the points are local to that
 * frame and are first placed by it; with `null` they already are in the frame of the eye. The whole sum is done in
 * 64 bits and rounded once.
 */
export function relativePoints(points: ArrayLike<number>, pose: FramePose | null, eye: V3, out: Float32Array = new Float32Array(points.length)): Float32Array {
  const p: Vec3 = [0, 0, 0];
  const ox = (pose ? pose.origin[0] : 0) - eye[0];
  const oy = (pose ? pose.origin[1] : 0) - eye[1];
  const oz = (pose ? pose.origin[2] : 0) - eye[2];
  for (let i = 0; i + 2 < points.length; i += 3) {
    p[0] = points[i]!;
    p[1] = points[i + 1]!;
    p[2] = points[i + 2]!;
    if (pose) quatRotate(pose.rotation, p, p);
    out[i] = p[0] + ox;
    out[i + 1] = p[1] + oy;
    out[i + 2] = p[2] + oz;
  }
  return out;
}

const DEG_PER_RAD = 360 / RAD_PER_TURN;

/**
 * Unit direction of a point of a sphere from latitude and longitude in degrees. +y is the pole of positive latitude;
 * longitude 0 is +x and grows toward −z, which is the way a frame with a positive rotation about +y turns (east).
 */
export function directionFromDeg(latitudeDeg: number, longitudeDeg: number): Vec3 {
  const [sinLat, cosLat] = detSinCosTurns(latitudeDeg / 360);
  const [sinLon, cosLon] = detSinCosTurns(longitudeDeg / 360);
  return [cosLat * cosLon, sinLat, -cosLat * sinLon];
}

/** Latitude (−90 … 90) and longitude (−180 … 180) in degrees of a direction; the inverse of `directionFromDeg`. */
export function directionToDeg(dir: V3): { latitudeDeg: number; longitudeDeg: number } {
  const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
  return { latitudeDeg: detAsin(dir[1] / l) * DEG_PER_RAD, longitudeDeg: detAtan2(-dir[2] / l, dir[0] / l) * DEG_PER_RAD };
}

/**
 * Pose of a frame that touches a sphere around the parent's origin: its origin is `distance` along `up`, its +y is
 * `up`, its +x points east (about the parent's +y) and its +z south, the axes of a flat map. At the pole of the
 * parent's +y the axes are those of the parent.
 */
export function tangentPose(up: V3, distance: number): FramePose {
  const l = Math.sqrt(up[0] * up[0] + up[1] * up[1] + up[2] * up[2]) || 1;
  const u: Vec3 = [up[0] / l, up[1] / l, up[2] / l];
  // East = (parent +y) × up; at either pole it is undefined and +x is taken.
  let ex = u[2];
  let ez = -u[0];
  const el = Math.sqrt(ex * ex + ez * ez);
  if (el < 1e-12) {
    ex = 1;
    ez = 0;
  } else {
    ex /= el;
    ez /= el;
  }
  // South = east × up.
  const south: Vec3 = [-ez * u[1], ez * u[0] - ex * u[2], ex * u[1]];
  return { origin: [u[0] * distance, u[1] * distance, u[2] * distance], rotation: quatFromAxes([ex, 0, ez], u, south) };
}
