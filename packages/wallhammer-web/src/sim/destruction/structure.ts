// A structure prepared for decisions: parts in key order, neighbour lists, bounding boxes, and the support solver.
//
// Support is connectivity from the ground anchors with a heuristic load path on top: a part is supported when it is
// an anchor, rests on a supported part (bearing bond), or hangs on a supported part through lateral bonds, at most
// `maxSpan` lateral bonds away from a part that rests on something (resting on a hanging part inherits its hang;
// hanging under a part costs two lateral hops).
// A plain connectivity test is `maxSpan = 255`.
// The solver is a bucket queue (small-integer shortest paths) seeded from the anchors in key order; the result (the smallest hang of
// every part) does not depend on the visiting order. A stress solver can replace it later without changing the data.

import { PART_FLAG } from '../../base/destructible.ts';
import type { StructureDesc } from '../../base/destructible.ts';
import { pieceCentre } from './int-geometry.ts';

/** A part with no supported path. */
export const UNSUPPORTED = 0xffff;

export interface CompiledStructure {
  readonly desc: StructureDesc;
  /** Part index by key. Parts keep the order of `desc.parts` (sorted by key). */
  readonly index: ReadonlyMap<number, number>;
  /** Neighbours by part index, each list sorted by index: parts resting on it, parts it rests on, lateral ties. */
  readonly above: readonly number[][];
  readonly below: readonly number[][];
  readonly lateral: readonly number[][];
  /** Allowed hang per part: the larger of `maxSpan` and the hang it already has when intact. */
  readonly span: Uint16Array;
  /** Bounding boxes (cm): min x, max x, min y, max y, min z, max z per part. */
  readonly box: Int32Array;
  /** Integer centre of each part's piece. */
  readonly centre: Int32Array;
  /** Bounding box of the whole structure. */
  readonly bounds: readonly [number, number, number, number, number, number];
  /** Parts that are not connected to any anchor even when intact (a generator fault); they are treated as anchors. */
  readonly floating: number;
}

const cache = new WeakMap<StructureDesc, CompiledStructure>();

/** Prepares a structure description (cached per description object). Throws on unsorted or dangling data. */
export function compileStructure(desc: StructureDesc): CompiledStructure {
  const hit = cache.get(desc);
  if (hit) return hit;
  const n = desc.parts.length;
  const index = new Map<number, number>();
  desc.parts.forEach((p, i) => {
    if (i > 0 && desc.parts[i - 1]!.key >= p.key) throw new Error(`structure ${desc.id}: parts are not sorted by key (${p.key})`);
    index.set(p.key, i);
  });
  const above: number[][] = Array.from({ length: n }, () => []);
  const below: number[][] = Array.from({ length: n }, () => []);
  const lateral: number[][] = Array.from({ length: n }, () => []);
  for (const b of desc.bonds) {
    const ia = index.get(b.a);
    const ib = index.get(b.b);
    if (ia === undefined || ib === undefined) throw new Error(`structure ${desc.id}: bond ${b.a}–${b.b} names a missing part`);
    if (b.bearing) {
      above[ia]!.push(ib);
      below[ib]!.push(ia);
    } else {
      lateral[ia]!.push(ib);
      lateral[ib]!.push(ia);
    }
  }
  const byIndex = (p: number, q: number): number => p - q;
  for (const l of [above, below, lateral]) for (const x of l) x.sort(byIndex);

  const box = new Int32Array(n * 6);
  const centre = new Int32Array(n * 3);
  const bounds: [number, number, number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  desc.parts.forEach((p, i) => {
    const c = p.piece.xz;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let k = 0; k < c.length; k += 2) {
      x0 = Math.min(x0, c[k]!);
      x1 = Math.max(x1, c[k]!);
      z0 = Math.min(z0, c[k + 1]!);
      z1 = Math.max(z1, c[k + 1]!);
    }
    box.set([x0, x1, p.piece.y0, p.piece.y1, z0, z1], i * 6);
    centre.set(pieceCentre(p.piece), i * 3);
    bounds[0] = Math.min(bounds[0], x0);
    bounds[1] = Math.max(bounds[1], x1);
    bounds[2] = Math.min(bounds[2], p.piece.y0);
    bounds[3] = Math.max(bounds[3], p.piece.y1);
    bounds[4] = Math.min(bounds[4], z0);
    bounds[5] = Math.max(bounds[5], z1);
  });

  const span = new Uint16Array(n).fill(UNSUPPORTED);
  const alive = new Uint8Array(n).fill(1);
  const partial: CompiledStructure = { desc, index, above, below, lateral, span, box, centre, bounds, floating: 0 };
  // Intact hangs with no limit: what the structure already needs to stand.
  const intact = solveSupport(partial, alive, null);
  let floating = 0;
  desc.parts.forEach((p, i) => {
    if (intact[i] === UNSUPPORTED) floating++;
    span[i] = intact[i] === UNSUPPORTED ? UNSUPPORTED : Math.max(p.maxSpan, intact[i]!);
  });
  const compiled: CompiledStructure = { ...partial, floating };
  cache.set(desc, compiled);
  return compiled;
}

/**
 * Smallest hang of every part (0 = rests on something, UNSUPPORTED = no path to an anchor) for the parts marked in
 * `alive`. `limits` caps the hang per part (the compiled spans); `null` means no cap. Parts that are floating even when
 * intact count as anchors.
 */
export function solveSupport(s: CompiledStructure, alive: Uint8Array, limits: Uint16Array | null): Uint16Array {
  const parts = s.desc.parts;
  const n = parts.length;
  const hang = new Uint16Array(n).fill(UNSUPPORTED);
  // Bucket queue by hang: a part resting on another inherits its hang (weight 0), a lateral bond adds one.
  const buckets: number[][] = [[]];
  for (let i = 0; i < n; i++) {
    const anchor = (parts[i]!.flags & PART_FLAG.anchor) !== 0 || (limits !== null && limits[i] === UNSUPPORTED);
    if (alive[i] && anchor) {
      hang[i] = 0;
      buckets[0]!.push(i);
    }
  }
  for (let h = 0; h < buckets.length; h++) {
    const bucket = buckets[h];
    if (!bucket) continue;
    for (let k = 0; k < bucket.length; k++) {
      const i = bucket[k]!;
      if (hang[i] !== h) continue;
      for (const j of s.above[i]!) {
        if (alive[j] && hang[j]! > h) {
          hang[j] = h;
          bucket.push(j);
        }
      }
      const next = h + 1;
      if (next >= UNSUPPORTED) continue;
      const relax = (j: number, to: number): void => {
        if (!alive[j] || hang[j]! <= to) return;
        if (limits !== null && to > limits[j]!) return;
        hang[j] = to;
        (buckets[to] ??= []).push(j);
      };
      for (const j of s.lateral[i]!) relax(j, next);
      // Hanging under a supported part is a weaker path: it counts as two lateral hops.
      if (next + 1 < UNSUPPORTED) for (const j of s.below[i]!) relax(j, next + 1);
    }
  }
  return hang;
}
