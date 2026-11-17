// Splits a stream of instances into square cells on the ground plane, each with thinned copies for distance.
// A cell is culled as one box and picks its own level of detail; far away it draws a thinned tier: one instance in
// `keep`, its radius widened by `widen`, so a dense group keeps roughly its covered area with a fraction of the draws.
// Pure: the same instances, cell size, tiers and seed give the same bytes. Runs in workers.

import type { InstanceBounds } from '../base/data.ts';
import type { Vec3 } from '../base/math.ts';
import { hashInt } from './hash.ts';

/** One thinning tier: keep one instance in `keep` (chosen by hash), scale its radius by `widen`. */
export interface InstanceTier {
  keep: number;
  widen: number;
}

/** Tier 0 is every instance unchanged; the next ones keep one in 4 and one in 12. */
export const DEFAULT_INSTANCE_TIERS: readonly InstanceTier[] = [
  { keep: 1, widen: 1 },
  { keep: 4, widen: 1.7 },
  { keep: 12, widen: 2.6 },
];

/** One square cell: its box (holding every tier, widened) and the instance data per tier. */
export interface InstanceCell {
  /** Column and row: the cell covers x in [i·size, (i+1)·size), z likewise with j. */
  i: number;
  j: number;
  min: Vec3;
  max: Vec3;
  /** Instance data per tier, in the stream's layout. An empty array when a tier keeps nothing in this cell. */
  tiers: Float32Array[];
}

export interface InstanceCellOptions {
  /** Floats per instance. */
  stride: number;
  /** Where position, radius and height sit inside an instance. */
  bounds: InstanceBounds;
  /** Cell edge in metres. */
  cellM: number;
  /** Thinning tiers, tier 0 first. Default `DEFAULT_INSTANCE_TIERS`. A tier keeps a subset of the tier before it when each `keep` divides the next. */
  tiers?: readonly InstanceTier[];
  /** Seed of the thinning choice. Default 0. */
  seed?: number;
}

/**
 * Sorts instances into cells by their base point (x, z), cells ordered by row then column. Within a cell and tier the
 * instances keep their input order. An instance is kept in tier t when `hash(seed, index) % keep === 0`, so the
 * choice depends only on its index in the input, not on the cell size.
 */
export function splitInstanceCells(instances: Float32Array, o: InstanceCellOptions): InstanceCell[] {
  const { stride, bounds, cellM } = o;
  const tiers = o.tiers ?? DEFAULT_INSTANCE_TIERS;
  const seed = o.seed ?? 0;
  const P = bounds.position;
  const R = bounds.radius;
  const H = bounds.height;
  const n = Math.floor(instances.length / stride);
  const widest = tiers.reduce((w, t) => Math.max(w, t.widen), 1);

  // Cell of each instance, and the instances of each cell in input order.
  const byCell = new Map<string, { i: number; j: number; members: number[] }>();
  for (let k = 0; k < n; k++) {
    const i = Math.floor(instances[k * stride + P]! / cellM);
    const j = Math.floor(instances[k * stride + P + 2]! / cellM);
    const key = `${i},${j}`;
    let c = byCell.get(key);
    if (!c) byCell.set(key, (c = { i, j, members: [] }));
    c.members.push(k);
  }
  const cells = [...byCell.values()].sort((a, b) => a.j - b.j || a.i - b.i);

  return cells.map(({ i, j, members }) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const lists = tiers.map(() => [] as number[]);
    for (const k of members) {
      const at = k * stride;
      const x = instances[at + P]!;
      const y = instances[at + P + 1]!;
      const z = instances[at + P + 2]!;
      const r = instances[at + R]! * widest;
      min[0] = Math.min(min[0], x - r);
      min[1] = Math.min(min[1], y);
      min[2] = Math.min(min[2], z - r);
      max[0] = Math.max(max[0], x + r);
      max[1] = Math.max(max[1], y + instances[at + H]!);
      max[2] = Math.max(max[2], z + r);
      const h = hashInt(seed, k);
      tiers.forEach((t, ti) => {
        if (h % t.keep === 0) lists[ti]!.push(k);
      });
    }
    const data = lists.map((list, ti) => {
      const out = new Float32Array(list.length * stride);
      const widen = tiers[ti]!.widen;
      list.forEach((k, m) => {
        out.set(instances.subarray(k * stride, (k + 1) * stride), m * stride);
        if (widen !== 1) out[m * stride + R] = out[m * stride + R]! * widen;
      });
      return out;
    });
    return { i, j, min, max, tiers: data };
  });
}
