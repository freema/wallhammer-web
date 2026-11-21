// The ground after the water plan and the level of water over it, at one point.
//
// The ground is the natural ground cut down, never raised: under a line's floor to just above the line's level, in its
// channel to a bed below the level, beside the floor along a wall that climbs until it meets the natural ground, and
// at a lake's shore to a bed and a bank.
// The water has no shape of its own: a point is wet when the ground there lies under the level that holds there
// (the sea's, a lake's, a line's). So the shore is always the real contour of the ground.

import { valueNoise3 } from 'wallhammer-web/gen-core';
import { naturalHeight, HALF_M, smooth } from './land.ts';
import { BUCKET_M, BUCKET_N, FINE_M, FINE_N, GRID_M, GRID_N, WALL_REACH_M, lakeGround, levelAt, type Plan } from './plan.ts';

/** The floor lies this far above the level, metres, and its own unevenness on top of that. */
const BANK_M = 0.45;
const FLOOR_RELIEF_M = 0.5;
/** Width of the bank between the channel's edge and the floor, metres. */
const BANK_WIDTH_M = 3;
/** In a lake's hollow the ground is kept this far above the lake's level against the walls of a lower line, metres. */
const DAM_M = 0.3;
/** Reach of the rounding where a wall meets the natural ground, metres of height. A quarter of it is the most the
 * rounding lowers the ground: kept under the margin every level keeps below its natural ground (`FREE_M` of plan.ts),
 * so the rounding of one line never puts ground under the water of another. */
const SHOULDER_M = 0.9;

export interface Sample {
  /** Height of the ground, metres. */
  ground: number;
  /** Level of the water that may stand here, metres: the point is wet when the ground is lower. */
  water: number;
  /** 0 the sea, 1 a lake, 2 a line. */
  body: number;
  /** 1 when the nearest stretch of a line steps down here (a fall). */
  fall: number;
  /** The direction the water of a line runs here, a unit vector; 0, 0 in standing water. */
  flowX: number;
  flowZ: number;
}

/** Height of the wall `e` metres beyond the floor's edge, over the floor. */
function wall(e: number): number {
  if (e <= 0) return 0;
  const r = e / WALL_REACH_M;
  return (e * (0.1 + 0.65 * smooth(0, 14, e))) / (1 - r * r);
}

/** The lower of two heights, rounded where they meet: within `k` of each other it lies up to `k / 4` under both. */
function softMin(a: number, b: number, k: number): number {
  const m = Math.min(a, b);
  if (k <= 0) return m;
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return m - 0.25 * h * h * k;
}

/** Squared distance from a point to a stretch, and the share along it, into `near`. */
const near = { d: 0, t: 0 };
function toStretch(x: number, z: number, ax: number, az: number, bx: number, bz: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  const ex = ax + dx * t - x;
  const ez = az + dz * t - z;
  near.d = ex * ex + ez * ez;
  near.t = t;
}

/** The ground and the water at a point. */
export function sampleAt(plan: Plan, x: number, z: number, out: Sample): void {
  let g = naturalHeight(plan.seed, x, z);
  let water = 0;
  let body = 0;
  let fall = 0;
  let flowX = 0;
  let flowZ = 0;
  let dam = -Infinity;
  // A lake: any corner of the fine cell around the point is its water or its shore. Its bed and bank are cut there.
  const fx = Math.min(FINE_N - 2, Math.max(0, Math.floor((x + HALF_M) / FINE_M)));
  const fz = Math.min(FINE_N - 2, Math.max(0, Math.floor((z + HALF_M) / FINE_M)));
  const fat = fz * FINE_N + fx;
  const lake = plan.lakeFine[fat]! || plan.lakeFine[fat + 1]! || plan.lakeFine[fat + FINE_N]! || plan.lakeFine[fat + FINE_N + 1]!;
  if (lake) {
    water = plan.lakes[lake - 1]!.level;
    body = 1;
    g = water + lakeGround(g - water);
  }
  // Its hollow, water and dry rim: there the walls of a lower line leave the ground above the lake.
  const gx = Math.min(GRID_N - 2, Math.max(0, Math.floor((x + HALF_M) / GRID_M)));
  const gz = Math.min(GRID_N - 2, Math.max(0, Math.floor((z + HALF_M) / GRID_M)));
  const at = gz * GRID_N + gx;
  const hollow = lake || plan.hollowOf[at]! || plan.hollowOf[at + 1]! || plan.hollowOf[at + GRID_N]! || plan.hollowOf[at + GRID_N + 1]!;
  if (hollow) dam = plan.lakes[hollow - 1]!.level + DAM_M;
  // The lines whose floor or wall can reach the point.
  const bx = Math.floor((x + HALF_M) / BUCKET_M);
  const bz = Math.floor((z + HALF_M) / BUCKET_M);
  if (bx >= 0 && bz >= 0 && bx < BUCKET_N && bz < BUCKET_N) {
    const b = bz * BUCKET_N + bx;
    const end = plan.bucketStart[b + 1]!;
    let lineLevel = Infinity;
    let k = plan.bucketStart[b]!;
    while (k < end) {
      const li = plan.segs[k]! >>> 16;
      const l = plan.lines[li]!;
      let da = Infinity;
      let ia = 0;
      let ta = 0;
      let dc = Infinity;
      let ic = 0;
      let tc = 0;
      for (; k < end && plan.segs[k]! >>> 16 === li; k++) {
        const i = plan.segs[k]! & 0xffff;
        toStretch(x, z, l.ax[i]!, l.az[i]!, l.ax[i + 1]!, l.az[i + 1]!);
        if (near.d < da) {
          da = near.d;
          ia = i;
          ta = near.t;
        }
        toStretch(x, z, l.cx[i]!, l.cz[i]!, l.cx[i + 1]!, l.cz[i + 1]!);
        if (near.d < dc) {
          dc = near.d;
          ic = i;
          tc = near.t;
        }
      }
      da = Math.sqrt(da);
      const floor = l.floor[ia]! + (l.floor[ia + 1]! - l.floor[ia]!) * ta;
      const e = da - floor;
      if (e >= WALL_REACH_M) continue;
      const level = levelAt(l, ia, ta);
      // Beside the floor the wall stands on the eased level, so a fall's cliff dies out along the valley.
      const rim = Math.max(level, l.rim[ia]! + (l.rim[ia + 1]! - l.rim[ia]!) * ta);
      const relief = FLOOR_RELIEF_M * valueNoise3(x, 0, z, 14, plan.seed + 0x91);
      // A line that runs lower than a lake beside it (the lake's own outlet below its sill) cuts only its floor
      // through the lake's rim: beside the floor the rim stays above the lake, so the lake leaves through the
      // channel alone and never stands over the valley of its outlet.
      const held = e > 0 && level < dam - 2 * DAM_M ? dam : -Infinity;
      const rise = wall(e);
      const cut = level + (rim - level) * smooth(0, 8, e) + BANK_M + relief + rise;
      // The wall meets the natural ground in a rounded shoulder, not along an edge. The rounding only ever lowers,
      // and by a quarter of its reach at most: tied to the wall's own height, it cannot reach down to the level.
      g = held > -Infinity ? Math.min(g, Math.max(held, cut)) : softMin(g, cut, Math.min(SHOULDER_M, 3 * rise));
      dc = Math.sqrt(dc);
      const reach = 1.25 * (l.half[ic]! + (l.half[ic + 1]! - l.half[ic]!) * tc) + BANK_WIDTH_M;
      const depth = l.depth[ic]! + (l.depth[ic + 1]! - l.depth[ic]!) * tc;
      if (dc < reach && depth > 0.02 && held === -Infinity) {
        // The bed: a bowl whose rim meets the floor without an edge, so a coarse mesh can still draw the bank.
        const s = 1 - (dc / reach) ** 2;
        g = Math.min(g, level + BANK_M - (depth + BANK_M) * Math.min(1, depth / 0.3) * s * s);
      }
      if (e <= 1 && level < lineLevel) {
        lineLevel = level;
        fall = l.fall[ia]!;
        const fx = l.cx[ic + 1]! - l.cx[ic]!;
        const fz = l.cz[ic + 1]! - l.cz[ic]!;
        const fl = Math.hypot(fx, fz) || 1;
        flowX = fx / fl;
        flowZ = fz / fl;
      }
    }
    if (lineLevel < Infinity) {
      water = Math.max(0, lineLevel);
      body = 2;
    }
  }
  out.ground = g;
  out.water = water;
  out.body = body;
  out.fall = fall;
  out.flowX = body === 2 ? flowX : 0;
  out.flowZ = body === 2 ? flowZ : 0;
}
