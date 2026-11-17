// Stable keys of the destructible parts of a structure: rule id in the top four bits, the part's path in the recipe
// below (never the order in which geometry is written). Shared by the description, the damaged emission and the
// interior.

import { DAMAGE, entryRung } from '../../base/index.ts';
import type { StructureState } from '../../base/index.ts';

/** Immutable rule ids of the parts (never renumbered; a new rule takes a new id). */
export const PART_RULE = { foundation: 1, wall: 2, roof: 3, balcony: 4, canopy: 5, chimney: 6, roofTop: 7, slab: 8, partition: 9, stair: 10 } as const;

const ruleKey = (rule: number, payload: number): number => ((rule << 28) | payload) >>> 0;

/** Key of a wall bay or balcony: ring (4 bits), edge vertex index (10), column (8), storey (6). -1 when out of range. */
export function bayKey(rule: number, ring: number, edge: number, column: number, storey: number): number {
  if (ring > 15 || edge > 1023 || column > 255 || storey > 63) return -1;
  return ruleKey(rule, (ring << 24) | (edge << 14) | (column << 6) | storey);
}
export const foundationKey = (): number => ruleKey(PART_RULE.foundation, 0);
export const roofKey = (s: number, t: number): number => ruleKey(PART_RULE.roof, (s << 8) | t);
export const canopyKey = (k: number): number => ruleKey(PART_RULE.canopy, k & 0xff);
export const chimneyKey = (k: number): number => ruleKey(PART_RULE.chimney, k & 0xff);
export const roofTopKey = (k: number): number => ruleKey(PART_RULE.roofTop, k & 0xfff);

/** Floor slab of storey `f` (0 is the ground slab, `floors` the slab under the roof space) over interior cell (i, j). */
export function slabKey(f: number, i: number, j: number): number {
  if (f > 63 || i > 1023 || j > 1023) return -1;
  return ruleKey(PART_RULE.slab, (f << 20) | (i << 10) | j);
}
/** Partition wall in storey `f`: direction (0 across, 1 along the long axis) and grid line (i, j). */
export function partitionKey(f: number, dir: number, i: number, j: number): number {
  if (f > 127 || i > 1023 || j > 1023) return -1;
  return ruleKey(PART_RULE.partition, (f << 21) | (dir << 20) | (i << 10) | j);
}
/** Stair flights from storey `f` up to `f + 1`. */
export const stairKey = (f: number): number => ruleKey(PART_RULE.stair, f & 0xff);

/** The rule id and path of a key, for debugging and reports. */
export function describeKey(key: number): string {
  const rule = key >>> 28;
  const p = key & 0x0fffffff;
  switch (rule) {
    case PART_RULE.wall:
    case PART_RULE.balcony:
      return `${rule === PART_RULE.wall ? 'wall' : 'balcony'} ring ${p >>> 24} edge ${(p >>> 14) & 1023} column ${(p >>> 6) & 255} storey ${p & 63}`;
    case PART_RULE.roof:
      return `roof cell ${p >>> 8},${p & 255}`;
    case PART_RULE.foundation:
      return 'foundation';
    case PART_RULE.canopy:
      return `canopy ${p}`;
    case PART_RULE.chimney:
      return `chimney ${p}`;
    case PART_RULE.roofTop:
      return `roof top ${p}`;
    case PART_RULE.slab:
      return `slab storey ${p >>> 20} cell ${(p >>> 10) & 1023},${p & 1023}`;
    case PART_RULE.partition:
      return `partition storey ${p >>> 21} ${(p >>> 20) & 1 ? 'along' : 'across'} ${(p >>> 10) & 1023},${p & 1023}`;
    case PART_RULE.stair:
      return `stair storey ${p}`;
    default:
      return `rule ${rule} path ${p}`;
  }
}

/** Is the part gone in this state (a ruin counts everything as gone)? */
export function partGone(state: StructureState | undefined, key: number): boolean {
  if (!state) return false;
  if (state.ruin) return true;
  const e = state.parts.get(key);
  return e !== undefined && entryRung(e) === DAMAGE.gone;
}
