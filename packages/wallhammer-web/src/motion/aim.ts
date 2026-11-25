// Aiming a short chain of bones at a point: the last bone's forward axis turns toward the point by a turn about the
// root's up (yaw) and one about the side across the facing (pitch), shared out along the chain (for example a little
// in the trunk, most in the head). The angles are measured in the frame of the `root` matrix, so up is the root's up
// and a curved world needs nothing more. Limits hold the turn within a yaw to either side and a pitch up and down; a
// point behind fades the turn back to none on its way round (the turn shrinks smoothly from the yaw limit to straight
// behind), so a point passing behind the figure never makes the chain flip from one side to the other.
//
// Order in a frame: after `solvePose` and the ground fit, before reaches (an arm that reaches then hangs off the
// turned trunk).

import { WeightFade } from './fade.ts';
import { solvePoseBelow } from './pose-ops.ts';
import { rotateLocal } from './quat.ts';
import type { Pose, Skeleton } from './skeleton.ts';

/** A chain that aims: its bones from the top (nearest the root) down, and how far it may turn. */
export interface AimChain {
  /** Bones that turn, from the nearest to the root to the last (whose forward axis aims). At most 16. */
  bones: readonly number[];
  /** Share of the turn each bone takes (same order); they usually add up to 1. */
  shares: readonly number[];
  /** Axis of the last bone, in its own frame, that should point at the target. Default [0, 0, 1]. */
  forward?: readonly [number, number, number];
  /** Point in the last bone's frame the aim is measured from (the eyes). Default [0, 0, 0]. */
  eye?: readonly [number, number, number];
  /** Largest turn to either side of the root's forward, radians. */
  maxYaw: number;
  /** Largest pitch above and below the root's level, radians. */
  maxUp: number;
  maxDown: number;
}

const ROOT = new Float64Array(9);
const FACE = new Float64Array(3);

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Root's axes normalised into ROOT (x, y, z columns). */
function rootAxes(root: ArrayLike<number>): void {
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(root[c * 3]!, root[c * 3 + 1]!, root[c * 3 + 2]!) || 1;
    ROOT[c * 3] = root[c * 3]! / l;
    ROOT[c * 3 + 1] = root[c * 3 + 1]! / l;
    ROOT[c * 3 + 2] = root[c * 3 + 2]! / l;
  }
}

/** The last bone's facing in the root's frame into FACE (unit). */
function facing(world: ArrayLike<number>, u: number, f: readonly [number, number, number]): void {
  const wx = world[u]! * f[0] + world[u + 3]! * f[1] + world[u + 6]! * f[2];
  const wy = world[u + 1]! * f[0] + world[u + 4]! * f[1] + world[u + 7]! * f[2];
  const wz = world[u + 2]! * f[0] + world[u + 5]! * f[1] + world[u + 8]! * f[2];
  const x = wx * ROOT[0]! + wy * ROOT[1]! + wz * ROOT[2]!;
  const y = wx * ROOT[3]! + wy * ROOT[4]! + wz * ROOT[5]!;
  const z = wx * ROOT[6]! + wy * ROOT[7]! + wz * ROOT[8]!;
  const l = Math.hypot(x, y, z) || 1;
  FACE[0] = x / l;
  FACE[1] = y / l;
  FACE[2] = z / l;
}

const DEFAULT_FORWARD: readonly [number, number, number] = [0, 0, 1];
const ZERO: readonly [number, number, number] = [0, 0, 0];

/** Where an aim would turn to: the target's yaw and pitch in the root's frame, and the share that is kept. */
export interface AimAngles {
  /** Yaw and pitch of the target from the eye, in the root's frame (yaw toward +x positive, pitch up positive). */
  yaw: number;
  pitch: number;
  /** The goal after the limits and the fade behind, radians. */
  goalYaw: number;
  goalPitch: number;
  /** Yaw and pitch of the last bone's forward axis, in the root's frame. */
  faceYaw: number;
  facePitch: number;
}

/**
 * Measures, without changing the pose, the target's angles and the facing of the chain's last bone in the root's
 * frame (`world` solved). Writes into `out` and returns it.
 */
export function aimAngles(world: ArrayLike<number>, root: ArrayLike<number>, chain: AimChain, target: ArrayLike<number>, out: AimAngles): AimAngles {
  rootAxes(root);
  const last = chain.bones[chain.bones.length - 1]!;
  const u = last * 12;
  const e = chain.eye ?? ZERO;
  const ex = world[u]! * e[0] + world[u + 3]! * e[1] + world[u + 6]! * e[2] + world[u + 9]!;
  const ey = world[u + 1]! * e[0] + world[u + 4]! * e[1] + world[u + 7]! * e[2] + world[u + 10]!;
  const ez = world[u + 2]! * e[0] + world[u + 5]! * e[1] + world[u + 8]! * e[2] + world[u + 11]!;
  const dx = target[0]! - ex, dy = target[1]! - ey, dz = target[2]! - ez;
  const tx = dx * ROOT[0]! + dy * ROOT[1]! + dz * ROOT[2]!;
  const ty = dx * ROOT[3]! + dy * ROOT[4]! + dz * ROOT[5]!;
  const tz = dx * ROOT[6]! + dy * ROOT[7]! + dz * ROOT[8]!;
  out.yaw = Math.atan2(tx, tz);
  out.pitch = Math.atan2(ty, Math.hypot(tx, tz));
  // Behind: the turn fades from the yaw limit to none straight behind.
  const a = Math.abs(out.yaw);
  let k = 1;
  if (a > chain.maxYaw) {
    const s = clamp((a - chain.maxYaw) / Math.max(1e-6, Math.PI - chain.maxYaw), 0, 1);
    k = 1 - s * s * (3 - 2 * s);
  }
  out.goalYaw = clamp(out.yaw, -chain.maxYaw, chain.maxYaw) * k;
  out.goalPitch = clamp(out.pitch, -chain.maxDown, chain.maxUp) * k;
  facing(world, u, chain.forward ?? DEFAULT_FORWARD);
  out.faceYaw = Math.atan2(FACE[0]!, FACE[2]!);
  out.facePitch = Math.atan2(FACE[1]!, Math.hypot(FACE[0]!, FACE[2]!));
  return out;
}

const ANGLES: AimAngles = { yaw: 0, pitch: 0, goalYaw: 0, goalPitch: 0, faceYaw: 0, facePitch: 0 };

/**
 * Turns the bones of `chain` so that the last one's forward axis moves toward `target` (a point in the frame the pose
 * is solved in), within the chain's limits, by `weight` 0–1 of the way from the pose as it was. The turn is measured
 * in the frame of `root`. `world` holds the solved pose and is updated. Returns the angle left between the facing and
 * the goal after the limits (radians). Allocates nothing.
 */
export function aimChain(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, world: Float32Array | Float64Array, chain: AimChain, target: ArrayLike<number>, weight = 1): number {
  const n = Math.min(chain.bones.length, 16);
  const fwd = chain.forward ?? DEFAULT_FORWARD;
  const g = aimAngles(world, root, chain, target, ANGLES);
  if (weight > 0 && n > 0) {
    const w = Math.min(1, weight);
    const dYaw = wrap(g.goalYaw - g.faceYaw) * w;
    const dPitch = (g.goalPitch - g.facePitch) * w;
    const last = chain.bones[n - 1]! * 12;
    for (let i = 0; i < n; i++) {
      const b = chain.bones[i]!;
      const s = chain.shares[i] ?? 0;
      if (s === 0) continue;
      // The pitch axis is the side across the facing now (after the bones above turned it).
      facing(world, last, fwd);
      const cy = Math.atan2(FACE[0]!, FACE[2]!);
      const c = Math.cos(cy), sn = Math.sin(cy);
      const sx = c * ROOT[0]! - sn * ROOT[6]!, sy = c * ROOT[1]! - sn * ROOT[7]!, sz = c * ROOT[2]! - sn * ROOT[8]!;
      // Both turns use the bone's matrix as solved: global' = yaw · pitch · global (pitch about the side first).
      const u = b * 12, q = b * 4;
      rotateLocal(pose.rot, q, world, u, ROOT[3]!, ROOT[4]!, ROOT[5]!, dYaw * s);
      rotateLocal(pose.rot, q, world, u, sx, sy, sz, -dPitch * s);
      solvePoseBelow(skeleton, pose, root, world, b);
    }
  }
  facing(world, chain.bones[n - 1]! * 12, fwd);
  // Angle left to the goal direction.
  const gy = g.goalYaw, gp = g.goalPitch;
  const gx = Math.sin(gy) * Math.cos(gp), gyy = Math.sin(gp), gz = Math.cos(gy) * Math.cos(gp);
  return Math.acos(clamp(gx * FACE[0]! + gyy * FACE[1]! + gz * FACE[2]!, -1, 1));
}

function wrap(a: number): number {
  return a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a;
}

/** An aiming chain that keeps its own state: the target the game moves every frame and an eased weight. */
export class ChainAim {
  readonly chain: AimChain;
  /** The point to aim at, in the frame the pose is solved in. Write it every frame. */
  readonly target = new Float64Array(3);
  readonly fade = new WeightFade(0);
  /** Angle left to the goal after the last `apply`, radians (at weight 0 the whole angle from the facing to the goal). */
  left = 0;

  constructor(chain: AimChain) {
    this.chain = chain;
  }

  get weight(): number {
    return this.fade.value;
  }

  on(seconds: number): void {
    this.fade.to(1, seconds);
  }

  off(seconds: number): void {
    this.fade.to(0, seconds);
  }

  setTarget(x: number, y: number, z: number): void {
    this.target[0] = x;
    this.target[1] = y;
    this.target[2] = z;
  }

  update(dt: number): void {
    this.fade.update(dt);
  }

  /**
   * `aimChain` at the eased weight; returns (and keeps in `left`) the angle left to the goal. At weight 0 nothing turns
   * and the whole angle from the facing to the goal is reported, as `aimChain(…, 0)` does.
   */
  apply(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, world: Float32Array | Float64Array): number {
    return (this.left = aimChain(skeleton, pose, root, world, this.chain, this.target, this.fade.value));
  }
}

