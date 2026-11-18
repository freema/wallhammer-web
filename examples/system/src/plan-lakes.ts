// The lake rule of Hearth: where a lake of the plan stands, how its bed lies and how deep its water is at a point.
// A lake is a filled hollow of the plan's grid (drainGrid); its shore is the contour of the real ground at its level,
// not the outline of its nodes. Pure: no DOM, no worker, no clock; arithmetic, Math.sqrt and the engine's noise only.
// Used by plan-water.ts (the hold of a river in a lake) and ground.ts (the ground and the water of every point).
//
// Per point, from the nodes and weights `gridWeights` blends there (exact fast exit: no pool node among them):
//   - q: the summed weight of the nodes of the lake with the largest sum (lower index on a tie), bent by noise that is
//     zero at q = 0 and q = 1; c: the same blend of `relief / 2`, the coarse ground; L: the lake's level.
//   - Sediment: the own ground eased toward c by `SED · smooth(0.5, 3.5, L − c)`, so a shallow lake is open water.
//   - Dam, only where the real ground would let the lake leak: toward `T = L + RISE_M` around q = Q0, never lowering.
//   - The lake's domain is q > Q0; its signed depth at a point with ground g is `min(L − g, 300 · (q − Q0))`.
// The premise (`lakePremise`): no blended cell holds nodes of two lakes, and every node next to a lake that is not in
// it lies at least `L − 0.26` high. It follows from the fill over eight neighbours; the rule is continuous only with it.

import { gridNeighbours, gridWeights } from 'wallhammer-web/gen-plan';
import type { SphereGrid } from 'wallhammer-web/gen-plan';
import { hashInts, valueNoise3 } from 'wallhammer-web/gen-core';

/** Share of the way the own ground is eased toward the coarse ground under a lake. */
export const LAKE_SED = 0.75;
/** The dam rises to this height above the level (m). */
export const LAKE_RISE_M = 0.8;
/** The domain of a lake starts at share Q0; the dam is gone at share Q1. */
export const LAKE_Q0 = 0.2;
export const LAKE_Q1 = 0.7;
/** Depth of the water at most this many metres per unit of share past Q0 (the edge of the domain is dry). */
const DEPTH_PER_SHARE_M = 300;
/** Bend of the share by noise: amplitude (of q·(1 − q)) and cell in metres. */
const BEND = 0.8;
const BEND_M = 180;
/** A node next to a lake lies at least this far under its level, at most (relief is in half metres). */
const PREMISE_SLACK_M = 0.26;

/** What the lake rule reads of a plan (a `WorldPlan` is one). */
export interface LakeSource {
  readonly seed: number;
  readonly grid: SphereGrid;
  readonly pool: Uint16Array;
  readonly pools: { readonly level: ArrayLike<number> };
  readonly relief: Int16Array;
}

/** The lake at a point: index (−1: no pool node blended here), share q (bent), level L and coarse ground c. */
export interface LakeHere {
  lake: number;
  q: number;
  level: number;
  coarse: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const nodes = new Int32Array(4);
const weights = new Float64Array(4);

/** Seed of the bend of the share (the shore noise of the first pass). */
export function lakeBendSeed(seed: number): number {
  return hashInts(seed, 0x716, 1);
}

/** A new, empty `LakeHere`. */
export function lakeHere(): LakeHere {
  return { lake: -1, q: 0, level: 0, coarse: 0 };
}

/**
 * The lake at a point (any length of the direction) into `out`. `bendSeed` is `lakeBendSeed(src.seed)`; a caller
 * passes it so it is hashed once.
 */
export function lakeAt(src: LakeSource, bendSeed: number, x: number, y: number, z: number, out: LakeHere): LakeHere {
  out.lake = -1;
  out.q = 0;
  out.level = 0;
  out.coarse = 0;
  const count = gridWeights(src.grid, x, y, z, nodes, weights);
  const pool = src.pool;
  let any = false;
  for (let k = 0; k < count; k++) if (pool[nodes[k]!] !== 0) any = true;
  if (!any) return out;
  let best = -1;
  let bestSum = 0;
  let c = 0;
  for (let k = 0; k < count; k++) {
    c += weights[k]! * (src.relief[nodes[k]!]! / 2);
    const p = pool[nodes[k]!]!;
    if (p === 0) continue;
    let s = 0;
    for (let j = 0; j < count; j++) if (pool[nodes[j]!] === p) s += weights[j]!;
    if (best < 0 || s > bestSum || (s === bestSum && p - 1 < best)) {
      best = p - 1;
      bestSum = s;
    }
  }
  const q = Math.min(1, Math.max(0, bestSum));
  const n = valueNoise3(x, y, z, BEND_M, bendSeed);
  out.lake = best;
  out.q = q + BEND * (2 * n - 1) * q * (1 - q);
  out.level = src.pools.level[best]!;
  out.coarse = c;
  return out;
}

/** The ground after the lake rule at a point whose own ground is `own` (equal to `own` where no lake is blended). */
export function lakeBed(h: LakeHere, own: number): number {
  if (h.lake < 0) return own;
  const L = h.level;
  const k = LAKE_SED * smooth(0.5, 3.5, L - h.coarse);
  const bed1 = own + k * (h.coarse - own);
  const lift = Math.max(0, L + LAKE_RISE_M - bed1);
  if (h.q >= LAKE_Q0) {
    const r = 1 - smooth(LAKE_Q0, LAKE_Q1, h.q);
    return bed1 + r * r * lift;
  }
  return bed1 + smooth(0, LAKE_Q0, h.q) * lift;
}

/** Whether a point lies in the domain of its lake (q > Q0). */
export function inLakeDomain(h: LakeHere): boolean {
  return h.lake >= 0 && h.q > LAKE_Q0;
}

/** Signed depth of the lake's water over ground `g` (−Infinity outside the domain); water stands where it is > 0. */
export function lakeDepth(h: LakeHere, g: number): number {
  if (!inLakeDomain(h)) return -Infinity;
  return Math.min(h.level - g, DEPTH_PER_SHARE_M * (h.q - LAKE_Q0));
}

/**
 * The premise of the rule over the whole plan: cells whose nodes hold two lakes (`mixed`) and nodes next to a lake,
 * not in it, lower than its level less 0.26 m (`low`). Neighbours over eight directions: every blended cell is a set
 * of mutual neighbours.
 */
export function lakePremise(src: LakeSource): { mixed: number; low: number } {
  const g = src.grid;
  const nb = new Int32Array(8);
  let mixed = 0;
  let low = 0;
  for (let i = 0; i < g.count; i++) {
    const p = src.pool[i]!;
    if (p === 0) continue;
    const L = src.pools.level[p - 1]!;
    const k = gridNeighbours(g, i, nb);
    for (let j = 0; j < k; j++) {
      const o = src.pool[nb[j]!]!;
      if (o === p) continue;
      if (o !== 0) mixed++;
      else if (src.relief[nb[j]!]! / 2 < L - PREMISE_SLACK_M) low++;
    }
  }
  return { mixed, low };
}
