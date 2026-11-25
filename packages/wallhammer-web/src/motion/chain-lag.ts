// A chain of bones that lags behind the motion of what it hangs on (secondary motion): a point at the end of every
// bone keeps its own velocity in a frame that does not move with the figure, a spring pulls it back toward where the
// posed bone points, damping takes away its speed against its joint, a share of gravity pulls it down the root's −y,
// and it stays within an angle of the posed direction. A figure that stops, turns or jumps leaves the chain behind
// for a moment, and the chain swings and settles.
//
// Fixed steps (`stepHz`), like a walker: the time of a frame is cut into steps, the rest carries to the next frame, at
// most `maxSteps` run per frame: a longer frame (a stall) puts the chain on the posed shape, moving with its joint, and
// runs the last `maxSteps` steps. The joint the chain hangs from moves in a line from where it was at the last frame
// that ran a step to where it is now over the steps of a frame. A frame shorter than a step runs none: the chain is
// drawn carried along with its joint (each link's direction as at the last step, held within `maxAngle` of the pose
// now), and the joint's motion in that frame is taken up by the next step. A joint that moved faster than
// `resetSpeedMs` (a teleport) puts the chain back on the posed shape. The bones are turned in the pose (their local
// rotations) and re-solved with what lies below them, as the other post steps do. Nothing allocates per frame.

import { rotateLocal } from './quat.ts';
import { solvePoseBelow } from './pose-ops.ts';
import type { Pose, Skeleton } from './skeleton.ts';

/** A chain of bones and how it lags. */
export interface LagChain {
  /** The bones from the one hung on the rest of the skeleton outward; each is the child of the one before. */
  bones: readonly number[];
  /** The free end of the last bone in its own frame (every other bone ends at the next one's joint). */
  end: readonly [number, number, number];
  /** Pull back toward the posed shape, 1/s² (about the square of the swing's angular frequency). */
  stiffness: number;
  /** Loss of the swing's speed against its joint, 1/s. */
  damping: number;
  /** Share of gravity the chain feels, 0–1: it sags below the posed shape by this. */
  gravity: number;
  /** Largest angle of a bone from its posed direction, radians. */
  maxAngle: number;
}

export interface ChainLagOptions {
  /** Fixed steps per second. Default 60. */
  stepHz?: number;
  /** Most steps one `apply` takes; a longer frame puts the chain on the posed shape, moving with its joint, and runs the last ones. Default 8. */
  maxSteps?: number;
  /** Gravity, m/s², along the root's −y. Default 9.81. */
  gravityMs2?: number;
  /** The joint the chain hangs from moving faster than this between two frames puts the chain back on the posed shape, m/s. Default 30. */
  resetSpeedMs?: number;
}

/** Stiffness × step² and damping × step are held at most at this, so a step never overshoots (explicit steps stay stable). */
const MAX_STEP_GAIN = 1;

/**
 * A lagging chain on one figure. `apply` after the post steps that move what the chain hangs on (the ground fit, an
 * aim), every frame: it advances the chain by the frame's seconds, turns its bones in `pose` and re-solves them in
 * `world`.
 */
export class ChainLag {
  readonly chain: LagChain;
  /** Angle of every bone from its posed direction after the last `apply`, radians. */
  readonly angles: Float64Array;
  private readonly n: number;
  private readonly h: number;
  private readonly maxSteps: number;
  private readonly gravityMs2: number;
  private readonly resetSpeed: number;
  private readonly k: number;
  private readonly c: number;
  /** Ends of the bones in the frame of `motion` (metres), now and one step before. */
  private readonly p: Float64Array;
  private readonly q: Float64Array;
  /** Posed directions of the bones (to their ends) in the frame of `motion`, and their lengths. */
  private readonly dir: Float64Array;
  private readonly len: Float64Array;
  /** The joint at the last frame that ran a step (or put the chain on the posed shape). */
  private readonly anchorPrev = new Float64Array(3);
  /** Seconds of frames since then that ran no step. */
  private idle = 0;
  private readonly anchorNow = new Float64Array(3);
  private readonly t3 = new Float64Array(3);
  private readonly u3 = new Float64Array(3);
  private started = false;
  /** Put on the posed shape at the last `apply`: the first steps after give it its joint's velocity. */
  private fresh = false;
  private acc = 0;

  constructor(skeleton: Skeleton, chain: LagChain, o: ChainLagOptions = {}) {
    const n = chain.bones.length;
    if (n < 1) throw new Error('ChainLag: the chain needs a bone');
    for (let i = 1; i < n; i++) {
      if (skeleton.parent[chain.bones[i]!] !== chain.bones[i - 1]) throw new Error(`ChainLag: bone ${skeleton.names[chain.bones[i]!]} is not the child of ${skeleton.names[chain.bones[i - 1]!]}`);
    }
    const hz = o.stepHz ?? 60;
    if (!(hz > 0)) throw new Error('ChainLag: stepHz must be positive');
    this.chain = chain;
    this.n = n;
    this.h = 1 / hz;
    this.maxSteps = Math.max(1, Math.floor(o.maxSteps ?? 8));
    this.gravityMs2 = o.gravityMs2 ?? 9.81;
    this.resetSpeed = o.resetSpeedMs ?? 30;
    const h2 = this.h * this.h;
    this.k = Math.min(Math.max(0, chain.stiffness) * h2, MAX_STEP_GAIN) / h2;
    this.c = Math.min(Math.max(0, chain.damping) * this.h, MAX_STEP_GAIN) / this.h;
    this.angles = new Float64Array(n);
    this.p = new Float64Array(n * 3);
    this.q = new Float64Array(n * 3);
    this.dir = new Float64Array(n * 3);
    this.len = new Float64Array(n);
  }

  /** The next `apply` puts the chain on the posed shape, at rest (after a teleport or a cut). */
  reset(): void {
    this.started = false;
    this.acc = 0;
    this.idle = 0;
  }

  /**
   * Advances the chain by `dt` seconds and turns its bones. `root` is the matrix the pose was solved with into `world`;
   * `motion` is the same root in a frame that does not move with the figure (the world; default `root` itself), with
   * the same axes and scale: the chain keeps its velocity in that frame, so where `root`'s own frame jumps (a new chart
   * of a sphere) pass a steady one here. Returns the largest angle of a bone from its posed direction, radians.
   */
  apply(dt: number, skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, world: Float32Array | Float64Array, motion: ArrayLike<number> = root): number {
    const n = this.n;
    const bones = this.chain.bones;
    const p = this.p, q = this.q, dir = this.dir, len = this.len;
    const t = this.t3;
    // The posed chain in the frame of `motion`: the joint it hangs from, and every bone's direction and length.
    this.toMotion(world, bones[0]! * 12 + 9, root, motion, this.anchorNow);
    const A = this.anchorNow;
    for (let i = 0; i < n; i++) {
      this.tipSolved(world, i, t);
      this.pointToMotion(t, root, motion, this.u3);
      dir[i * 3] = this.u3[0]!;
      dir[i * 3 + 1] = this.u3[1]!;
      dir[i * 3 + 2] = this.u3[2]!;
    }
    // Tips → directions: tip i less the joint (the anchor, or tip i − 1).
    for (let i = n - 1; i >= 0; i--) {
      const jx = i === 0 ? A[0]! : dir[(i - 1) * 3]!;
      const jy = i === 0 ? A[1]! : dir[(i - 1) * 3 + 1]!;
      const jz = i === 0 ? A[2]! : dir[(i - 1) * 3 + 2]!;
      const dx = dir[i * 3]! - jx, dy = dir[i * 3 + 1]! - jy, dz = dir[i * 3 + 2]! - jz;
      dir[i * 3] = dx;
      dir[i * 3 + 1] = dy;
      dir[i * 3 + 2] = dz;
      len[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    let ax = A[0]! - this.anchorPrev[0]!, ay = A[1]! - this.anchorPrev[1]!, az = A[2]! - this.anchorPrev[2]!;
    const jump = Math.sqrt(ax * ax + ay * ay + az * az);
    let healthy = true;
    for (let i = 0; i < n * 3; i++) if (!(p[i]! === p[i]!) || !(q[i]! === q[i]!)) healthy = false;
    let stepped = true;
    if (!this.started || !healthy || !(dt >= 0) || jump > this.resetSpeed * Math.max(dt + this.idle, this.h)) this.settle();
    else {
      // The steps due, the joint moving in a line over them.
      this.acc += dt;
      const due = Math.floor((this.acc + 1e-9 * this.h) / this.h);
      this.acc -= due * this.h;
      if (this.acc < 0) this.acc = 0;
      const steps = due < this.maxSteps ? due : this.maxSteps;
      if (due > steps) {
        // A stall: the chain's last shape says nothing of the pose now. It starts on the posed shape, moving with its
        // joint over the last steps, so the joint's speed in them is its real speed.
        const share = steps / due;
        const rest = this.acc;
        this.settle();
        this.acc = rest;
        ax *= share;
        ay *= share;
        az *= share;
        this.anchorPrev[0] = A[0]! - ax;
        this.anchorPrev[1] = A[1]! - ay;
        this.anchorPrev[2] = A[2]! - az;
        for (let i = 0; i < n; i++) {
          p[i * 3] = p[i * 3]! - ax;
          p[i * 3 + 1] = p[i * 3 + 1]! - ay;
          p[i * 3 + 2] = p[i * 3 + 2]! - az;
        }
      }
      // Gravity along the root's −y (unit), in the frame of `motion`.
      const ly = Math.hypot(motion[3]!, motion[4]!, motion[5]!) || 1;
      const gs = this.chain.gravity * this.gravityMs2;
      const gx = (-motion[3]! / ly) * gs, gy = (-motion[4]! / ly) * gs, gz = (-motion[5]! / ly) * gs;
      if (this.fresh && steps > 0) {
        // Moving with its joint from the start, so a figure already in motion does not jerk its chain.
        const q = this.q;
        for (let i = 0; i < n; i++) {
          q[i * 3] = p[i * 3]! - ax / steps;
          q[i * 3 + 1] = p[i * 3 + 1]! - ay / steps;
          q[i * 3 + 2] = p[i * 3 + 2]! - az / steps;
        }
        this.fresh = false;
      }
      for (let s = 0; s < steps; s++) this.step((s + 1) / steps, s / steps, ax, ay, az, gx, gy, gz);
      stepped = steps > 0;
    }
    // A frame without a step keeps the joint of the last step, so the next step takes up all of its motion.
    if (stepped) {
      this.anchorPrev.set(A);
      this.idle = 0;
    } else this.idle += dt;
    this.started = true;
    return this.turn(skeleton, pose, root, world, motion, !stepped);
  }

  /** The chain on the posed shape, at rest. */
  private settle(): void {
    this.idle = 0;
    const p = this.p, dir = this.dir, A = this.anchorNow;
    let x = A[0]!, y = A[1]!, z = A[2]!;
    for (let i = 0; i < this.n; i++) {
      x += dir[i * 3]!;
      y += dir[i * 3 + 1]!;
      z += dir[i * 3 + 2]!;
      p[i * 3] = x;
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = z;
    }
    this.q.set(p);
    this.acc = 0;
    this.fresh = true;
  }

  /** One fixed step; the joint at `share` of the way from the last frame's place to this one's (`from` before the step). */
  private step(share: number, from: number, ax: number, ay: number, az: number, gx: number, gy: number, gz: number): void {
    const p = this.p, q = this.q, dir = this.dir, len = this.len;
    const h = this.h, h2 = h * h, k = this.k, keep = 1 - this.c * h, max = this.chain.maxAngle;
    const P = this.anchorPrev;
    // The joint of the bone before and after this step.
    let jx0 = P[0]! + ax * from, jy0 = P[1]! + ay * from, jz0 = P[2]! + az * from;
    let jx = P[0]! + ax * share, jy = P[1]! + ay * share, jz = P[2]! + az * share;
    // The joint's velocity (per step): the anchor's over this frame, then each end's over its last step.
    let vjx = ax * (share - from), vjy = ay * (share - from), vjz = az * (share - from);
    const loss = 1 - keep;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const px = p[o]!, py = p[o + 1]!, pz = p[o + 2]!;
      const ux0 = px - q[o]!, uy0 = py - q[o + 1]!, uz0 = pz - q[o + 2]!;
      // Its own velocity, less a share of its speed against the joint; the spring toward the posed direction from the
      // joint (both where they were at the start of the step); gravity.
      const fx = k * (jx0 + dir[o]! - px) + gx, fy = k * (jy0 + dir[o + 1]! - py) + gy, fz = k * (jz0 + dir[o + 2]! - pz) + gz;
      let nx = px + ux0 - (ux0 - vjx) * loss + fx * h2;
      let ny = py + uy0 - (uy0 - vjy) * loss + fy * h2;
      let nz = pz + uz0 - (uz0 - vjz) * loss + fz * h2;
      // Back to the bone's length from the joint, and within the angle of the posed direction.
      const L = len[i]!;
      let ex = nx - jx, ey = ny - jy, ez = nz - jz;
      let el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const ux = L > 0 ? dir[o]! / L : 0, uy = L > 0 ? dir[o + 1]! / L : 1, uz = L > 0 ? dir[o + 2]! / L : 0;
      if (!(el > 1e-12)) {
        ex = ux;
        ey = uy;
        ez = uz;
        el = 1;
      }
      ex /= el;
      ey /= el;
      ez /= el;
      const cos = ex * ux + ey * uy + ez * uz;
      let clamped = false;
      if (cos < Math.cos(max)) {
        // Turned back to the limit in the plane of the two directions.
        let wx = ex - ux * cos, wy = ey - uy * cos, wz = ez - uz * cos;
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (wl > 1e-12) {
          wx /= wl;
          wy /= wl;
          wz /= wl;
          const c = Math.cos(max), s = Math.sin(max);
          ex = ux * c + wx * s;
          ey = uy * c + wy * s;
          ez = uz * c + wz * s;
        } else {
          ex = ux;
          ey = uy;
          ez = uz;
        }
        clamped = true;
      }
      nx = jx + ex * L;
      ny = jy + ey * L;
      nz = jz + ez * L;
      // A bone held at its limit stops there: it keeps its joint's speed and no speed of its own against it.
      const dx = jx - jx0, dy = jy - jy0, dz = jz - jz0;
      if (clamped) {
        q[o] = nx - dx;
        q[o + 1] = ny - dy;
        q[o + 2] = nz - dz;
      } else {
        q[o] = px;
        q[o + 1] = py;
        q[o + 2] = pz;
      }
      p[o] = nx;
      p[o + 1] = ny;
      p[o + 2] = nz;
      // The next bone hangs from this end: before and after this step, and its velocity over its last step.
      vjx = ux0;
      vjy = uy0;
      vjz = uz0;
      jx0 = px;
      jy0 = py;
      jz0 = pz;
      jx = nx;
      jy = ny;
      jz = nz;
    }
  }

  /**
   * Turns every bone of the chain from where it points in `world` to its simulated direction; returns the largest angle
   * from the posed directions. `between` (a frame that ran no step): the first link hangs from the joint of the last
   * step, so the chain is carried along with its joint, and every direction is held within `maxAngle` of the pose now.
   */
  private turn(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, world: Float32Array | Float64Array, motion: ArrayLike<number>, between: boolean): number {
    const bones = this.chain.bones;
    const p = this.p, dir = this.dir, len = this.len;
    const t = this.t3, u = this.u3;
    const A = between ? this.anchorPrev : this.anchorNow;
    const max = this.chain.maxAngle;
    let most = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const jx = i === 0 ? A[0]! : p[o - 3]!, jy = i === 0 ? A[1]! : p[o - 2]!, jz = i === 0 ? A[2]! : p[o - 1]!;
      // The simulated direction in the frame of `motion`, its angle from the posed one, then into the frame of `world`.
      let ex = p[o]! - jx, ey = p[o + 1]! - jy, ez = p[o + 2]! - jz;
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const L = len[i]!;
      const cos = el > 0 && L > 0 ? (ex * dir[o]! + ey * dir[o + 1]! + ez * dir[o + 2]!) / (el * L) : 1;
      let a = Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos);
      if (between && a > max && L > 0) {
        // Turned back to the limit in the plane of the two directions (the pose may have turned since the step).
        const ux = dir[o]! / L, uy = dir[o + 1]! / L, uz = dir[o + 2]! / L;
        let wx = ex / el - ux * cos, wy = ey / el - uy * cos, wz = ez / el - uz * cos;
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
        // Straight against the posed direction there is no plane: the posed direction itself.
        const c = wl > 1e-12 ? Math.cos(max) : 1, s = wl > 1e-12 ? Math.sin(max) / wl : 0;
        wx *= s;
        wy *= s;
        wz *= s;
        ex = (ux * c + wx) * el;
        ey = (uy * c + wy) * el;
        ez = (uz * c + wz) * el;
        a = max;
      }
      this.angles[i] = a;
      if (a > most) most = a;
      u[0] = ex;
      u[1] = ey;
      u[2] = ez;
      vectorBetween(motion, root, u);
      // Where the bone points now in `world` (after the bones before it turned).
      const b = bones[i]! * 12;
      this.tipSolved(world, i, t);
      const cx = t[0]! - world[b + 9]!, cy = t[1]! - world[b + 10]!, cz = t[2]! - world[b + 11]!;
      const wx = u[0]!, wy = u[1]!, wz = u[2]!;
      const sx = cy * wz - cz * wy, sy = cz * wx - cx * wz, sz = cx * wy - cy * wx;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const angle = Math.atan2(sl, cx * wx + cy * wy + cz * wz);
      if (sl > 1e-12 && angle > 1e-7) {
        rotateLocal(pose.rot, bones[i]! * 4, world, b, sx / sl, sy / sl, sz / sl, angle);
        solvePoseBelow(skeleton, pose, root, world, bones[i]!);
      }
    }
    return most;
  }

  /** The end of bone `i` of the chain as solved in `world`, into `out`. */
  private tipSolved(world: ArrayLike<number>, i: number, out: Float64Array): void {
    const bones = this.chain.bones;
    if (i + 1 < this.n) {
      const c = bones[i + 1]! * 12;
      out[0] = world[c + 9]!;
      out[1] = world[c + 10]!;
      out[2] = world[c + 11]!;
      return;
    }
    const b = bones[i]! * 12;
    const e = this.chain.end;
    for (let r = 0; r < 3; r++) out[r] = world[b + r]! * e[0] + world[b + 3 + r]! * e[1] + world[b + 6 + r]! * e[2] + world[b + 9 + r]!;
  }

  /** A point of the frame of `world` at `at` into the frame of `motion`. */
  private toMotion(world: ArrayLike<number>, at: number, root: ArrayLike<number>, motion: ArrayLike<number>, out: Float64Array): void {
    const t = this.t3;
    t[0] = world[at]!;
    t[1] = world[at + 1]!;
    t[2] = world[at + 2]!;
    this.pointToMotion(t, root, motion, out);
  }

  /** A point of the frame `root` is given in into the frame of `motion`: motion · root⁻¹. */
  private pointToMotion(x: ArrayLike<number>, root: ArrayLike<number>, motion: ArrayLike<number>, out: Float64Array): void {
    const dx = x[0]! - root[9]!, dy = x[1]! - root[10]!, dz = x[2]! - root[11]!;
    let m0 = 0, m1 = 0, m2 = 0;
    for (let c = 0; c < 3; c++) {
      const cx = root[c * 3]!, cy = root[c * 3 + 1]!, cz = root[c * 3 + 2]!;
      const l2 = cx * cx + cy * cy + cz * cz || 1;
      const m = (cx * dx + cy * dy + cz * dz) / l2;
      if (c === 0) m0 = m;
      else if (c === 1) m1 = m;
      else m2 = m;
    }
    for (let r = 0; r < 3; r++) out[r] = motion[r]! * m0 + motion[3 + r]! * m1 + motion[6 + r]! * m2 + motion[9 + r]!;
  }
}

/** A direction of the frame of `from` into the frame of `to` (two placements of one root): to · from⁻¹, in place. */
function vectorBetween(from: ArrayLike<number>, to: ArrayLike<number>, v: Float64Array): void {
  const x = v[0]!, y = v[1]!, z = v[2]!;
  let m0 = 0, m1 = 0, m2 = 0;
  for (let c = 0; c < 3; c++) {
    const cx = from[c * 3]!, cy = from[c * 3 + 1]!, cz = from[c * 3 + 2]!;
    const l2 = cx * cx + cy * cy + cz * cz || 1;
    const m = (cx * x + cy * y + cz * z) / l2;
    if (c === 0) m0 = m;
    else if (c === 1) m1 = m;
    else m2 = m;
  }
  for (let r = 0; r < 3; r++) v[r] = to[r]! * m0 + to[3 + r]! * m1 + to[6 + r]! * m2;
}
