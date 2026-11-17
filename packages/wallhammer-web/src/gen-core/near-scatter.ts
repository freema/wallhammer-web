// Small instances near the viewer: records made per square of a fixed fine grid, and the fade that lets them leave one
// by one with distance.
//
// A square is named by integers (its `key`); every number of a record is a hash of the seed, that key, the kind and
// the candidate's index, so a square gives the same bytes whatever else is made, in any order and on any thread.
// Candidates of a kind sit one in each cell of a g × g grid over the square, jittered inside their cell; a density
// callback keeps a share of them, so a higher density only adds instances. Each record carries an order 0–1: within
// a kind the records are sorted by it, highest first, and the fade by distance removes the lowest first. What can
// still be seen from a distance is then a prefix of the records (`nearCount`), and a drawing layer copies only that.
//
// Pure: arithmetic, Math.sqrt / floor / ceil / min / max and the hashes. The fade exists here and, with the same
// formula, as GLSL (`NEAR_FADE_GLSL`).

import type { VertexLayout } from '../base/data.ts';
import { hashInt, hashInts, unit } from './hash.ts';

/**
 * Floats of one record: x y z relative to the anchor of its set (m), order 0–1 | width m, height m, turn about up
 * (rad), bend 0–1 | r g b, variant.
 */
export const NEAR_FLOATS = 12;

/** Instance layout of a record: `i_base` (xyz, order), `i_shape` (width, height, turn, bend), `i_color` (rgb, variant). */
export const NEAR_LAYOUT: VertexLayout = {
  stride: 48,
  attribs: [
    { name: 'i_base', size: 4, type: 'f32', offset: 0 },
    { name: 'i_shape', size: 4, type: 'f32', offset: 16 },
    { name: 'i_color', size: 4, type: 'f32', offset: 32 },
  ],
};

export interface NearScatterOptions {
  seed: number;
  /** Integers naming the square (for example space, column, row); part of every hash, their order matters. */
  key: readonly number[];
  /** Per kind: places tried, rounded up to a square number g², one in each cell of a g × g grid over the square. */
  candidates: readonly number[];
  /** Bit k: make kind k. Default all. */
  mask?: number;
  /** Share of the candidates kept at (u, v) ∈ [0, 1)² of the square, 0–1. */
  densityAt(kind: number, u: number, v: number): number;
  /**
   * Only for a kept candidate: writes its record at `out[at …]` except the order slot (`at + 3`), which the tool owns.
   * `roll(q)` is the candidate's own hash number 0–1 for any integer `q`.
   */
  fill(kind: number, u: number, v: number, roll: (q: number) => number, out: Float32Array, at: number): void;
}

/** Records of one square: `start` has kinds + 1 entries, in records; a kind outside the mask is empty. */
export interface NearRecords {
  data: Float32Array;
  start: Uint32Array;
}

/**
 * The records of one square. Candidate `c` of kind `k` lies in grid cell `(c % g, floor(c / g))`, jittered by
 * `unit(hashInts(seed, ...key, k, c, 1 | 2))`; it is kept when `unit(hashInts(seed, ...key, k, c, 3)) < densityAt`;
 * its order is `unit(hashInts(seed, ...key, k, c, 4))`, and `roll(q)` is `unit(hashInts(seed, ...key, k, c, 16 + q))`.
 * Within a kind the records are sorted by order, highest first, ties by candidate ascending.
 */
export function nearScatter(o: NearScatterOptions): NearRecords {
  const kinds = o.candidates.length;
  const mask = o.mask ?? -1;
  const keyed = hashInts(o.seed, ...o.key);
  const parts: { data: Float32Array; count: number }[] = [];
  let total = 0;
  let h = 0;
  const roll = (q: number): number => unit(hashInt(h, 16 + q));
  for (let k = 0; k < kinds; k++) {
    if (((mask >>> k) & 1) === 0) {
      parts.push({ data: new Float32Array(0), count: 0 });
      continue;
    }
    const g = Math.ceil(Math.sqrt(Math.max(0, o.candidates[k]!)));
    const n = g * g;
    const hk = hashInt(keyed, k);
    const kept: number[] = [];
    const orders: number[] = [];
    const tmp = new Float32Array(n * NEAR_FLOATS);
    let count = 0;
    for (let c = 0; c < n; c++) {
      const hc = hashInt(hk, c);
      const u = ((c % g) + unit(hashInt(hc, 1))) / g;
      const v = (Math.floor(c / g) + unit(hashInt(hc, 2))) / g;
      if (!(unit(hashInt(hc, 3)) < o.densityAt(k, u, v))) continue;
      h = hc;
      const at = count * NEAR_FLOATS;
      o.fill(k, u, v, roll, tmp, at);
      const order = unit(hashInt(hc, 4));
      tmp[at + 3] = order;
      kept.push(c);
      orders.push(order);
      count++;
    }
    // Highest order first, ties by candidate ascending (the candidates are already ascending).
    const idx = Array.from({ length: count }, (_, i) => i);
    idx.sort((a, b) => orders[b]! - orders[a]! || kept[a]! - kept[b]!);
    const data = new Float32Array(count * NEAR_FLOATS);
    for (let i = 0; i < count; i++) data.set(tmp.subarray(idx[i]! * NEAR_FLOATS, (idx[i]! + 1) * NEAR_FLOATS), i * NEAR_FLOATS);
    parts.push({ data, count });
    total += count;
  }
  const data = new Float32Array(total * NEAR_FLOATS);
  const start = new Uint32Array(kinds + 1);
  let at = 0;
  for (let k = 0; k < kinds; k++) {
    start[k] = at;
    data.set(parts[k]!.data, at * NEAR_FLOATS);
    at += parts[k]!.count;
  }
  start[kinds] = at;
  return { data, start };
}

/**
 * Fade of a kind by distance: nothing beyond `reachM`; the instances leave one by one over the outer `band` share of
 * the reach (lowest order first), each shrinking to nothing over `softM`.
 */
export interface NearFade {
  reachM: number;
  band: number;
  softM: number;
}

/** Distance at which an instance of this order has left: `gain · reachM · (1 − band · (1 − order))`. */
export function nearLeaveM(f: NearFade, gain: number, order: number): number {
  return gain * f.reachM * (1 - f.band * (1 - order));
}

/** Scale 0–1 of an instance of this order at `distM`: `smoothstep(0, 1, (leave − dist) / softM)`. */
export function nearKeep(f: NearFade, gain: number, order: number, distM: number): number {
  const t = Math.min(1, Math.max(0, (nearLeaveM(f, gain, order) - distM) / f.softM));
  return t * t * (3 - 2 * t);
}

/**
 * How many leading records of `[from, to)` (indices of records in `data`, sorted by order, highest first) can have a
 * scale above 0 at `distM` or farther: a binary search over the order.
 */
export function nearCount(data: Float32Array, from: number, to: number, f: NearFade, gain: number, distM: number): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nearLeaveM(f, gain, data[mid * NEAR_FLOATS + 3]!) > distM) lo = mid + 1;
    else hi = mid;
  }
  return lo - from;
}

/** GLSL of the fade, `float nearKeep(vec3 fade, float order, float dist)` with `fade` = (gain · reach, band, soft). Any stage. */
export const NEAR_FADE_GLSL = /* glsl */ `
float nearKeep(vec3 fade, float order, float dist) {
  float leave = fade.x * (1.0 - fade.y * (1.0 - order));
  return smoothstep(0.0, 1.0, (leave - dist) / fade.z);
}
`;
