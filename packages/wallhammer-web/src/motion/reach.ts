// Post steps over a solved pose, for the game to call when it wants them: a two-bone reach (the end of a chain of
// two bones put on a target by turning the two bones, analytic, no iteration) and its use for keeping chain ends on
// the ground (the height comes from a function of the game). Both change the pose and re-solve the bones below the
// chain, so the world matrices stay in step with the pose. Up is +y; a curved world is not covered.
//
// The reach follows the two-joint method of D. Holden ("Simple Two Joint IK", 2017): the angle at the middle joint
// gives the right distance, then the chain swings onto the target; an optional pole point turns the chain about the
// line to the target so that the middle joint points toward it.

import { solvePoseBelow } from './pose-ops.ts';
import { nlerpFrom as nlerp, rotateLocal } from './quat.ts';
import type { Pose, Skeleton } from './skeleton.ts';

/** Three bones of a chain: `upper` holds `lower`, which holds `end` (the joint that should reach the target). */
export interface TwoBoneChain {
  upper: number;
  lower: number;
  end: number;
  /**
   * Axis in the lower bone's frame that the middle joint bends about when the chain is straight (a positive turn
   * about it is the way the joint bends). Default [1, 0, 0].
   */
  bend?: readonly [number, number, number];
}

const EPS = 1e-5;
// Scratch (module level: the post steps run one at a time).
const QA = new Float64Array(4);
const QB = new Float64Array(4);

/**
 * Turns the upper and lower bone of `chain` so that the end joint reaches `target` (world), as far as the chain's
 * length allows, blended with the pose as it was by `weight` 0–1. `world` must hold the solved pose (`solvePose`)
 * and is updated for the chain and everything below it. `pole` (world point, optional): the middle joint turns toward
 * it. Returns the distance from the end joint to the target afterwards (0 when reached). Allocates nothing.
 */
export function reachTwoBone(
  skeleton: Skeleton,
  pose: Pose,
  root: ArrayLike<number>,
  world: Float32Array | Float64Array,
  chain: TwoBoneChain,
  target: ArrayLike<number>,
  weight = 1,
  pole: ArrayLike<number> | null = null,
): number {
  const { upper, lower, end } = chain;
  const tx = target[0]!, ty = target[1]!, tz = target[2]!;
  if (weight <= 0) return dist(world, end, tx, ty, tz);
  const ua = upper * 12, ub = lower * 12, uc = end * 12;
  const ax = world[ua + 9]!, ay = world[ua + 10]!, az = world[ua + 11]!;
  const bx = world[ub + 9]!, by = world[ub + 10]!, bz = world[ub + 11]!;
  const cx = world[uc + 9]!, cy = world[uc + 10]!, cz = world[uc + 11]!;
  const lab = Math.hypot(bx - ax, by - ay, bz - az);
  const lcb = Math.hypot(cx - bx, cy - by, cz - bz);
  if (lab < EPS || lcb < EPS) return dist(world, end, tx, ty, tz);
  const lat = clamp(Math.hypot(tx - ax, ty - ay, tz - az), Math.abs(lab - lcb) + EPS, lab + lcb - EPS);
  // Unit directions a→c, a→b, b→a, b→c, a→t.
  let acx = cx - ax, acy = cy - ay, acz = cz - az;
  const lac = Math.hypot(acx, acy, acz) || 1;
  acx /= lac;
  acy /= lac;
  acz /= lac;
  const abx = (bx - ax) / lab, aby = (by - ay) / lab, abz = (bz - az) / lab;
  const bcx = (cx - bx) / lcb, bcy = (cy - by) / lcb, bcz = (cz - bz) / lcb;
  let atx = tx - ax, aty = ty - ay, atz = tz - az;
  const lt = Math.hypot(atx, aty, atz) || 1;
  atx /= lt;
  aty /= lt;
  atz /= lt;
  const acAb0 = Math.acos(clamp(acx * abx + acy * aby + acz * abz, -1, 1));
  const baBc0 = Math.acos(clamp(-(abx * bcx + aby * bcy + abz * bcz), -1, 1));
  const acAt0 = Math.acos(clamp(acx * atx + acy * aty + acz * atz, -1, 1));
  const acAb1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const baBc1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));
  // The bend plane's normal: from the chain's own bend, or from the bend axis when it is straight.
  let n0x = acy * abz - acz * aby, n0y = acz * abx - acx * abz, n0z = acx * aby - acy * abx;
  let ln = Math.hypot(n0x, n0y, n0z);
  if (ln < 1e-6) {
    const k = chain.bend ?? DEFAULT_BEND;
    // Lower bone's frame to world, negated: the geometric normal c×b of a joint bent the positive way.
    n0x = -(world[ub]! * k[0] + world[ub + 3]! * k[1] + world[ub + 6]! * k[2]);
    n0y = -(world[ub + 1]! * k[0] + world[ub + 4]! * k[1] + world[ub + 7]! * k[2]);
    n0z = -(world[ub + 2]! * k[0] + world[ub + 5]! * k[1] + world[ub + 8]! * k[2]);
    ln = Math.hypot(n0x, n0y, n0z) || 1;
  }
  n0x /= ln;
  n0y /= ln;
  n0z /= ln;
  let n1x = acy * atz - acz * aty, n1y = acz * atx - acx * atz, n1z = acx * aty - acy * atx;
  const l1 = Math.hypot(n1x, n1y, n1z);
  if (l1 > 1e-9) {
    n1x /= l1;
    n1y /= l1;
    n1z /= l1;
  }
  // Keep the old rotations for the weight.
  const rot = pose.rot;
  const qa = upper * 4, qb = lower * 4;
  for (let k = 0; k < 4; k++) {
    QA[k] = rot[qa + k]!;
    QB[k] = rot[qb + k]!;
  }
  // Upper: in world terms first the bend about n0 (with the lower bone's turn it keeps the direction a→c and sets
  // its length), then the swing of a→c onto a→t. Both axes go into the frame of the bone as it was solved, so the
  // local product is swing · bend (rot · r2 · r0 = R2 · R0 · global).
  if (l1 > 1e-9) rotateLocal(rot, qa, world, ua, n1x, n1y, n1z, acAt0);
  rotateLocal(rot, qa, world, ua, n0x, n0y, n0z, acAb1 - acAb0);
  rotateLocal(rot, qb, world, ub, n0x, n0y, n0z, baBc1 - baBc0);
  solvePoseBelow(skeleton, pose, root, world, upper);
  if (pole) {
    // Turn the chain about the line a→end so that the middle joint lies toward the pole.
    let ux = world[uc + 9]! - ax, uy = world[uc + 10]! - ay, uz = world[uc + 11]! - az;
    const lu = Math.hypot(ux, uy, uz);
    if (lu > EPS) {
      ux /= lu;
      uy /= lu;
      uz /= lu;
      const px = pole[0]! - ax, py = pole[1]! - ay, pz = pole[2]! - az;
      const mx = world[ub + 9]! - ax, my = world[ub + 10]! - ay, mz = world[ub + 11]! - az;
      // Both projected on the plane across u.
      const dp = px * ux + py * uy + pz * uz, dm = mx * ux + my * uy + mz * uz;
      const ppx = px - ux * dp, ppy = py - uy * dp, ppz = pz - uz * dp;
      const pmx = mx - ux * dm, pmy = my - uy * dm, pmz = mz - uz * dm;
      if (Math.hypot(ppx, ppy, ppz) > EPS && Math.hypot(pmx, pmy, pmz) > EPS) {
        const cs = pmx * ppx + pmy * ppy + pmz * ppz;
        const sn = ux * (pmy * ppz - pmz * ppy) + uy * (pmz * ppx - pmx * ppz) + uz * (pmx * ppy - pmy * ppx);
        rotateLocal(rot, qa, world, ua, ux, uy, uz, Math.atan2(sn, cs));
        solvePoseBelow(skeleton, pose, root, world, upper);
      }
    }
  }
  if (weight < 1) {
    nlerp(rot, qa, QA, weight);
    nlerp(rot, qb, QB, weight);
    solvePoseBelow(skeleton, pose, root, world, upper);
  }
  return dist(world, end, tx, ty, tz);
}

/** What `fitToGround` needs besides the chains. */
export interface GroundFitOptions {
  /** Ground height at a world point (x, z). */
  heightAt(x: number, z: number): number;
  /** Height of the plane the figure is posed on (where the chain ends stand in the unchanged pose). */
  planeY: number;
  /** Largest raise of a chain end, metres. Default 0.5. */
  maxLift?: number;
  /** Largest drop of a chain end, metres. Default 0.5. */
  maxDrop?: number;
  /**
   * A bone lowered (along its parent's y) by the deepest drop, so that chains can reach down without stretching;
   * −1 or unset: none.
   */
  lower?: number;
  /** Blend with the unchanged pose, 0–1. Default 1. */
  weight?: number;
  /** World points the middle joints turn toward, 3 numbers per chain (optional). */
  poles?: ArrayLike<number> | null;
  /**
   * Turns every chain's end bone by the tilt of the ground under it, 0–1 (times `weight`). Default 0: the ends keep
   * their turn. The tilt is the rotation that takes +y to the ground's normal, which comes from `heightAt` at
   * `alignStep` on either side of the end along x and z; the end turns about its own joint.
   */
  align?: number;
  /** Half the spacing of the heights the normal is taken from, metres. Default 0.1. */
  alignStep?: number;
  /** Largest tilt given to an end, radians (a step or an edge under it reads as a wall). Default 0.6. */
  maxAlign?: number;
}

const TARGET = new Float64Array(3);
const POLE = new Float64Array(3);
const DELTA = new Float64Array(64);
const ENDS = new Float64Array(64 * 3);

/**
 * Keeps the ends of `chains` on the ground: every end is moved up or down by the ground height under it minus
 * `planeY` (within the limits) and reached with `reachTwoBone`; with `align` the end bone then tilts with the ground.
 * `world` must hold the solved pose and is updated. At most 64 chains. Allocates nothing.
 */
export function fitToGround(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, world: Float32Array | Float64Array, chains: readonly TwoBoneChain[], o: GroundFitOptions): void {
  const n = Math.min(chains.length, 64);
  const lift = o.maxLift ?? 0.5;
  const drop = o.maxDrop ?? 0.5;
  const w = o.weight ?? 1;
  if (w <= 0 || n === 0) return;
  const align = (o.align ?? 0) * w;
  const step = o.alignStep ?? 0.1;
  const maxAlign = o.maxAlign ?? 0.6;
  let deepest = 0;
  for (let i = 0; i < n; i++) {
    const u = chains[i]!.end * 12;
    const x = world[u + 9]!, y = world[u + 10]!, z = world[u + 11]!;
    ENDS[i * 3] = x;
    ENDS[i * 3 + 1] = y;
    ENDS[i * 3 + 2] = z;
    const d = clamp(o.heightAt(x, z) - o.planeY, -drop, lift);
    DELTA[i] = d;
    if (d < deepest) deepest = d;
  }
  const low = o.lower ?? -1;
  if (low >= 0 && deepest < 0) {
    pose.offset[low * 3 + 1] = pose.offset[low * 3 + 1]! + deepest * w;
    solvePoseBelow(skeleton, pose, root, world, low);
  }
  for (let i = 0; i < n; i++) {
    TARGET[0] = ENDS[i * 3]!;
    TARGET[1] = ENDS[i * 3 + 1]! + DELTA[i]!;
    TARGET[2] = ENDS[i * 3 + 2]!;
    let pole: Float64Array | null = null;
    if (o.poles) {
      POLE[0] = o.poles[i * 3]!;
      POLE[1] = o.poles[i * 3 + 1]!;
      POLE[2] = o.poles[i * 3 + 2]!;
      pole = POLE;
    }
    reachTwoBone(skeleton, pose, root, world, chains[i]!, TARGET, w, pole);
    if (align > 0) alignEnd(skeleton, pose, root, world, chains[i]!.end, o.heightAt, step, maxAlign, align);
  }
}

/** Turns the solved bone `end` about its joint by the ground's tilt under it, `weight` of it, at most `maxAngle`. */
function alignEnd(skeleton: Skeleton, pose: Pose, root: ArrayLike<number>, world: Float32Array | Float64Array, end: number, heightAt: (x: number, z: number) => number, e: number, maxAngle: number, weight: number): void {
  const u = end * 12;
  const x = world[u + 9]!, z = world[u + 11]!;
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  const s = Math.hypot(gx, gz);
  if (!(s > 1e-9)) return;
  // The normal is (−gx, 1, −gz); +y turns onto it about up × normal, by the slope's angle.
  rotateLocal(pose.rot, end * 4, world, u, -gz / s, 0, gx / s, Math.min(maxAngle, Math.atan(s)) * weight);
  solvePoseBelow(skeleton, pose, root, world, end);
}

const DEFAULT_BEND: readonly [number, number, number] = [1, 0, 0];

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function dist(world: ArrayLike<number>, bone: number, x: number, y: number, z: number): number {
  const u = bone * 12;
  return Math.hypot(world[u + 9]! - x, world[u + 10]! - y, world[u + 11]! - z);
}
