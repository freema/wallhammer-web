// Tools for choosing nodes of a sphere grid by a score: steps over the grid to the nearest marked node, the steepest
// slope at a node, and a best-first pick of nodes with a least straight distance between them. The caller gives the
// score and decides what a picked node stands for. Arithmetic and `Math.sqrt/floor/abs/min/max` only, so the same
// input gives the same picks in every runtime.

import type { Vec3 } from '../base/math.ts';
import { gridDirection, gridNeighbours } from './grid.ts';
import type { SphereGrid } from './grid.ts';

/**
 * Per node: the steps over the 8-neighbourhood (`gridNeighbours`, across the edges of the cube too) to the nearest
 * node with `marks[node] ≠ 0`, capped at `maxSteps` (at most 255). A marked node has 0; a node farther than the cap,
 * or with no marked node at all, has `maxSteps`.
 */
export function gridSteps(g: SphereGrid, marks: ArrayLike<number>, maxSteps: number): Uint8Array {
  if (!(maxSteps >= 0 && maxSteps <= 255 && Number.isInteger(maxSteps))) throw new Error(`gridSteps: maxSteps ${maxSteps} out of 0…255`);
  const count = g.count;
  if (marks.length !== count) throw new Error(`gridSteps: ${marks.length} marks for ${count} nodes`);
  const out = new Uint8Array(count).fill(255);
  const queue = new Int32Array(count);
  let end = 0;
  for (let i = 0; i < count; i++) {
    if (marks[i] !== 0) {
      out[i] = 0;
      queue[end++] = i;
    }
  }
  const nb = new Int32Array(8);
  // Breadth first: every node is queued once, when its step is first known (the least one).
  for (let head = 0; head < end; head++) {
    const u = queue[head]!;
    const next = out[u]! + 1;
    if (next > maxSteps) break;
    const k = gridNeighbours(g, u, nb);
    for (let j = 0; j < k; j++) {
      const v = nb[j]!;
      if (out[v] !== 255) continue;
      out[v] = next;
      queue[end++] = v;
    }
  }
  if (maxSteps < 255) for (let i = 0; i < count; i++) if (out[i]! > maxSteps) out[i] = maxSteps;
  return out;
}

const slopeNb = new Int32Array(8);
const slopeA: Vec3 = [0, 0, 0];
const slopeB: Vec3 = [0, 0, 0];

/**
 * The steepest rise or fall from a node to one of its neighbours: `|Δheight| · unitM` over the straight distance
 * between the two node middles on the sphere of `g.radiusM`. `heights` holds one value per node in units of `unitM`.
 */
export function gridSlopeAt(g: SphereGrid, heights: ArrayLike<number>, unitM: number, node: number): number {
  const k = gridNeighbours(g, node, slopeNb);
  gridDirection(g, node, slopeA);
  const h = heights[node]!;
  let best = 0;
  for (let j = 0; j < k; j++) {
    const v = slopeNb[j]!;
    gridDirection(g, v, slopeB);
    const dx = slopeB[0] - slopeA[0];
    const dy = slopeB[1] - slopeA[1];
    const dz = slopeB[2] - slopeA[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * g.radiusM;
    if (!(d > 0)) continue;
    const s = (Math.abs(heights[v]! - h) * unitM) / d;
    if (s > best) best = s;
  }
  return best;
}

/** Options of `pickSites`. */
export interface PickOptions {
  /** At most this many nodes are returned. */
  count: number;
  /** Least straight (chord) distance between two taken nodes, metres; 0 or less: none. */
  spacingM: number;
  /** Nodes with a lower score are never candidates. */
  minScore: number;
  /** Nodes taken before the call: they keep their spacing and are not returned. */
  taken?: ArrayLike<number>;
  /** Asked once per node that would be taken; false skips it for good. */
  accept?: (node: number) => boolean;
}

/** Buckets of the first ordering pass of `pickSites`. */
const PICK_BUCKETS = 65536;

/**
 * Picks nodes best first. Candidates are the nodes with `score ≥ minScore`, visited by descending score, ties by
 * ascending node index (the exact order of the given numbers). A candidate is taken when its chord distance to every
 * taken node is at least `spacingM` and `accept`, if given, returns true. Stops at `count`. Returns the nodes in the
 * order taken.
 */
export function pickSites(g: SphereGrid, score: ArrayLike<number>, o: PickOptions): Uint32Array {
  const count = g.count;
  if (score.length !== count) throw new Error(`pickSites: ${score.length} scores for ${count} nodes`);
  const want = Math.max(0, Math.floor(o.count));
  const picked: number[] = [];
  if (want === 0) return new Uint32Array(0);

  // Candidates, and the range of their scores.
  let m = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i++) {
    const s = score[i]!;
    if (!(s >= o.minScore)) continue;
    m++;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  if (m === 0) return new Uint32Array(0);

  // Buckets by a key that never falls as the score rises (rounding is monotone), so a higher bucket never holds a
  // lower score and equal scores share one bucket. Counting sort by bucket, nodes ascending inside it.
  const span = hi - lo;
  const top = PICK_BUCKETS - 1;
  const bucketOf = (s: number): number => (span > 0 ? Math.min(top, Math.floor(((s - lo) / span) * top)) : 0);
  const starts = new Uint32Array(PICK_BUCKETS + 1);
  for (let i = 0; i < count; i++) {
    const s = score[i]!;
    if (s >= o.minScore) starts[bucketOf(s) + 1]!++;
  }
  for (let b = 0; b < PICK_BUCKETS; b++) starts[b + 1]! += starts[b]!;
  const order = new Uint32Array(m);
  const fill = starts.slice(0, PICK_BUCKETS);
  for (let i = 0; i < count; i++) {
    const s = score[i]!;
    if (s >= o.minScore) order[fill[bucketOf(s)]!++] = i;
  }

  // Taken nodes in a hash of cubes of the spacing, in metres.
  const R = g.radiusM;
  const spacing = o.spacingM;
  const cellM = spacing > 0 ? spacing : 1;
  const cells = new Map<string, number[]>();
  const pos: number[] = [];
  const d: Vec3 = [0, 0, 0];
  const keyOf = (x: number, y: number, z: number): string => `${Math.floor(x / cellM)},${Math.floor(y / cellM)},${Math.floor(z / cellM)}`;
  const put = (node: number): void => {
    gridDirection(g, node, d);
    const x = d[0] * R;
    const y = d[1] * R;
    const z = d[2] * R;
    const k = pos.length / 3;
    pos.push(x, y, z);
    const key = keyOf(x, y, z);
    const list = cells.get(key);
    if (list) list.push(k);
    else cells.set(key, [k]);
  };
  const free = (x: number, y: number, z: number): boolean => {
    if (!(spacing > 0)) return true;
    const cx = Math.floor(x / cellM);
    const cy = Math.floor(y / cellM);
    const cz = Math.floor(z / cellM);
    const s2 = spacing * spacing;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const list = cells.get(`${cx + a},${cy + b},${cz + c}`);
          if (!list) continue;
          for (const k of list) {
            const dx = pos[3 * k]! - x;
            const dy = pos[3 * k + 1]! - y;
            const dz = pos[3 * k + 2]! - z;
            if (dx * dx + dy * dy + dz * dz < s2) return false;
          }
        }
      }
    }
    return true;
  };
  const before = new Set<number>();
  if (o.taken) {
    for (let i = 0; i < o.taken.length; i++) {
      const node = o.taken[i]!;
      before.add(node);
      put(node);
    }
  }

  // Best first: the buckets from the top, each sorted exactly when it is reached.
  const bucket: number[] = [];
  for (let b = top; b >= 0 && picked.length < want; b--) {
    const a = starts[b]!;
    const e = starts[b + 1]!;
    if (a === e) continue;
    bucket.length = 0;
    for (let k = a; k < e; k++) bucket.push(order[k]!);
    if (bucket.length > 1) bucket.sort((p, q) => score[q]! - score[p]! || p - q);
    for (const node of bucket) {
      if (before.has(node)) continue;
      gridDirection(g, node, d);
      if (!free(d[0] * R, d[1] * R, d[2] * R)) continue;
      if (o.accept && !o.accept(node)) continue;
      picked.push(node);
      put(node);
      if (picked.length >= want) break;
    }
  }
  return Uint32Array.from(picked);
}
