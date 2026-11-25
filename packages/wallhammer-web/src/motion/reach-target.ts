// A two-bone reach that keeps its own state: a target the game moves every frame (in the frame the pose is solved
// in), a weight eased in and out over set seconds, an optional pole and an optional rotation for the end bone. A
// target out of the chain's reach is pulled in softly (the chain straightens toward it without a pop as the target
// crosses its length). It calls `reachTwoBone` once a frame.
//
// Order in a frame: evaluate the graph, `solvePose`, the ground fit (`fitToGround`), aims (`aimChain`), then reaches,
// then the transforms of sockets (`socketTransform`), which read the bones the reaches moved.

import { WeightFade } from './fade.ts';
import { solvePoseBelow } from './pose-ops.ts';
import { matrixQuat, nlerpFrom } from './quat.ts';
import { reachTwoBone } from './reach.ts';
import type { TwoBoneChain } from './reach.ts';
import type { Pose, Skeleton } from './skeleton.ts';

export interface TwoBoneReachOptions {
  /**
   * Share of the chain's length from which a far target is pulled in softly, 0–1. 1: none (the chain straightens
   * exactly at its length). Default 0.92.
   */
  soft?: number;
  /** World point the middle joint turns toward; null: none. It can be changed later (`pole`). */
  pole?: readonly [number, number, number] | null;
}

const SOFT_TARGET = new Float64Array(3);
const OLD = new Float64Array(4);
const PARENT = new Float64Array(4);

/** A two-bone chain reaching for a moving target, its weight eased in and out. */
export class TwoBoneReach {
  readonly chain: TwoBoneChain;
  /** The point the end joint reaches for, in the frame the pose is solved in. Write it every frame. */
  readonly target = new Float64Array(3);
  /** World point the middle joint turns toward (used while `usePole` is true). */
  readonly pole = new Float64Array(3);
  usePole: boolean;
  /** Rotation of the end bone in the solved frame (quaternion x, y, z, w; used while `useEndRotation` is true). */
  readonly endRotation = new Float64Array([0, 0, 0, 1]);
  useEndRotation = false;
  /** The eased weight. */
  readonly fade = new WeightFade(0);
  soft: number;
  /** Distance from the end joint to the target after the last `apply`. */
  left = 0;

  constructor(chain: TwoBoneChain, o: TwoBoneReachOptions = {}) {
    this.chain = chain;
    this.soft = o.soft ?? 0.92;
    this.usePole = !!o.pole;
    if (o.pole) this.pole.set(o.pole);
  }

  /** The weight now, 0–1. */
  get weight(): number {
    return this.fade.value;
  }

  /** Eases the reach in over `seconds`. */
  on(seconds: number): void {
    this.fade.to(1, seconds);
  }

  /** Eases the reach out over `seconds`. */
  off(seconds: number): void {
    this.fade.to(0, seconds);
  }

  setTarget(x: number, y: number, z: number): void {
    this.target[0] = x;
    this.target[1] = y;
    this.target[2] = z;
  }

  /** Advances the weight by `dt` seconds. */
  update(dt: number): void {
    this.fade.update(dt);
  }

  /**
   * Reaches the end joint toward the target by the weight now (nothing at weight 0). `world` holds the solved pose
   * and is updated for the chain and below. Returns the distance left from the end joint to the target.
   */
  apply(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, world: Float32Array | Float64Array): number {
    const w = this.fade.value;
    const { upper, lower, end } = this.chain;
    const t = this.target;
    if (w <= 0) return (this.left = Math.hypot(world[end * 12 + 9]! - t[0]!, world[end * 12 + 10]! - t[1]!, world[end * 12 + 11]! - t[2]!));
    // Soft reach: a target farther than `soft` of the length moves in along the line from the upper joint, so that
    // its distance approaches the length but never gets there.
    const ua = upper * 12, ub = lower * 12, uc = end * 12;
    const ax = world[ua + 9]!, ay = world[ua + 10]!, az = world[ua + 11]!;
    const len = Math.hypot(world[ub + 9]! - ax, world[ub + 10]! - ay, world[ub + 11]! - az) + Math.hypot(world[uc + 9]! - world[ub + 9]!, world[uc + 10]! - world[ub + 10]!, world[uc + 11]! - world[ub + 11]!);
    const dx = t[0]! - ax, dy = t[1]! - ay, dz = t[2]! - az;
    const d = Math.hypot(dx, dy, dz);
    const ds = Math.min(1, Math.max(0, this.soft)) * len;
    let k = 1;
    if (d > ds && len - ds > 1e-9 && d > 1e-9) {
      const span = len - ds;
      k = (ds + span * (1 - Math.exp(-(d - ds) / span))) / d;
    }
    SOFT_TARGET[0] = ax + dx * k;
    SOFT_TARGET[1] = ay + dy * k;
    SOFT_TARGET[2] = az + dz * k;
    reachTwoBone(skeleton, pose, root, world, this.chain, SOFT_TARGET, w, this.usePole ? this.pole : null);
    if (this.useEndRotation) {
      // The end bone's local rotation that gives the wanted rotation under its parent as solved now.
      const q = end * 4;
      const rot = pose.rot;
      for (let i = 0; i < 4; i++) OLD[i] = rot[q + i]!;
      matrixQuat(world, ub, PARENT);
      const px = -PARENT[0]!, py = -PARENT[1]!, pz = -PARENT[2]!, pw = PARENT[3]!;
      const e = this.endRotation;
      const ex = e[0]!, ey = e[1]!, ez = e[2]!, ew = e[3]!;
      rot[q] = pw * ex + px * ew + py * ez - pz * ey;
      rot[q + 1] = pw * ey - px * ez + py * ew + pz * ex;
      rot[q + 2] = pw * ez + px * ey - py * ex + pz * ew;
      rot[q + 3] = pw * ew - px * ex - py * ey - pz * ez;
      if (w < 1) nlerpFrom(rot, q, OLD, w);
      solvePoseBelow(skeleton, pose, root, world, end);
    }
    return (this.left = Math.hypot(world[uc + 9]! - t[0]!, world[uc + 10]! - t[1]!, world[uc + 11]! - t[2]!));
  }
}
