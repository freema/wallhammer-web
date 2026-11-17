// Least-cost ways over a sphere grid: the cheapest chain of neighbour steps between two nodes, the regions of many
// sources (which source reaches each node most cheaply), and the cheapest step between every two regions that touch.
// The caller gives the cost of a step and decides what a way stands for.
//
// One shared core: a binary heap ordered by (cost, source index, node index), neighbours in the order of
// `gridNeighbours` (over the edges and corners of the cube), a predecessor replaced only by a strictly lower cost. No
// estimate of the rest of the way, so the result is exact for any cost. Arithmetic only: the same input gives the same
// nodes in every runtime.

import { gridNeighbours } from './grid.ts';
import type { SphereGrid } from './grid.ts';

/** Cost of the step from node a to its neighbour b: finite and > 0, or Infinity = the step is closed. */
export type StepCost = (a: number, b: number) => number;

/**
 * Per-node arrays of one grid, reused between calls of `routeGrid` (a stamp per call, no clearing). Opaque: make it
 * with `routeScratch` and pass it back.
 */
export interface RouteScratch {
  /** Nodes of the grid it was made for. */
  readonly count: number;
}

/** What a `RouteScratch` holds. */
interface Scratch extends RouteScratch {
  /** Per node: 2 · stamp while open, 2 · stamp + 1 once settled; older stamps mean "not seen in this call". */
  readonly mark: Uint32Array;
  readonly cost: Float64Array;
  readonly prev: Int32Array;
  stamp: number;
  readonly heap: Heap;
}

/** A binary min-heap of (cost, source, node) triples with lazy deletion. */
class Heap {
  cost = new Float64Array(1024);
  src = new Int32Array(1024);
  node = new Int32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  private less(i: number, j: number): boolean {
    const a = this.cost[i]!;
    const b = this.cost[j]!;
    if (a !== b) return a < b;
    const s = this.src[i]! - this.src[j]!;
    if (s !== 0) return s < 0;
    return this.node[i]! < this.node[j]!;
  }

  private swap(i: number, j: number): void {
    const c = this.cost[i]!;
    this.cost[i] = this.cost[j]!;
    this.cost[j] = c;
    const s = this.src[i]!;
    this.src[i] = this.src[j]!;
    this.src[j] = s;
    const n = this.node[i]!;
    this.node[i] = this.node[j]!;
    this.node[j] = n;
  }

  push(cost: number, src: number, node: number): void {
    if (this.size === this.cost.length) {
      const grow = this.size * 2;
      const c = new Float64Array(grow);
      c.set(this.cost);
      this.cost = c;
      const s = new Int32Array(grow);
      s.set(this.src);
      this.src = s;
      const n = new Int32Array(grow);
      n.set(this.node);
      this.node = n;
    }
    let i = this.size++;
    this.cost[i] = cost;
    this.src[i] = src;
    this.node[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Removes the least triple; read it from index `size` afterwards (cost, src, node). */
  pop(): void {
    const last = --this.size;
    this.swap(0, last);
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= last) break;
      const r = l + 1;
      const m = r < last && this.less(r, l) ? r : l;
      if (!this.less(m, i)) break;
      this.swap(i, m);
      i = m;
    }
  }
}

/** Scratch arrays for `routeGrid` on grid `g` (about 20 bytes per node). */
export function routeScratch(g: SphereGrid): RouteScratch {
  return makeScratch(g);
}

function makeScratch(g: SphereGrid): Scratch {
  return { count: g.count, mark: new Uint32Array(g.count), cost: new Float64Array(g.count), prev: new Int32Array(g.count), stamp: 0, heap: new Heap() };
}

function checkCost(c: number, a: number, b: number): void {
  if (!(c > 0)) throw new Error(`route: the step ${a} → ${b} costs ${c} (must be > 0 or Infinity)`);
}

const nb = new Int32Array(8);

/**
 * Nodes from `from` to `to` inclusive along the least total cost; null if `to` is unreachable or not settled within
 * `maxNodes` settled nodes. `from === to` gives `[from]`.
 */
export function routeGrid(g: SphereGrid, o: { from: number; to: number; cost: StepCost; maxNodes: number; scratch?: RouteScratch }): Uint32Array | null {
  const { from, to, cost } = o;
  if (!(from >= 0 && from < g.count && to >= 0 && to < g.count)) throw new Error(`routeGrid: node ${from} or ${to} is not on the grid`);
  if (from === to) return Uint32Array.of(from);
  const s = (o.scratch as Scratch | undefined) ?? makeScratch(g);
  if (s.count !== g.count) throw new Error(`routeGrid: the scratch is of a grid of ${s.count} nodes, not ${g.count}`);
  // A new stamp; when the marks would overflow, clear them once.
  if (s.stamp >= 0x7ffffffe) {
    s.mark.fill(0);
    s.stamp = 0;
  }
  const stamp = ++s.stamp;
  const open = 2 * stamp;
  const done = open + 1;
  const { mark, prev } = s;
  const best = s.cost;
  const heap = s.heap;
  heap.clear();
  mark[from] = open;
  best[from] = 0;
  prev[from] = -1;
  heap.push(0, 0, from);
  let settled = 0;
  while (heap.size > 0) {
    heap.pop();
    const c = heap.cost[heap.size]!;
    const u = heap.node[heap.size]!;
    if (mark[u] === done || c > best[u]!) continue;
    mark[u] = done;
    if (u === to) break;
    if (++settled >= o.maxNodes) return null;
    const k = gridNeighbours(g, u, nb);
    for (let j = 0; j < k; j++) {
      const v = nb[j]!;
      if (mark[v] === done) continue;
      const step = cost(u, v);
      if (step === Infinity) continue;
      checkCost(step, u, v);
      const nc = c + step;
      if (mark[v] !== open) {
        mark[v] = open;
        best[v] = nc;
        prev[v] = u;
        heap.push(nc, 0, v);
      } else if (nc < best[v]!) {
        best[v] = nc;
        prev[v] = u;
        heap.push(nc, 0, v);
      }
    }
  }
  if (mark[to] !== done) return null;
  let n = 1;
  for (let v = to; v !== from; v = prev[v]!) n++;
  const out = new Uint32Array(n);
  let i = n - 1;
  for (let v = to; ; v = prev[v]!) {
    out[i--] = v;
    if (v === from) break;
  }
  return out;
}

/** Per node: index into `sources` of the source that reaches it most cheaply (−1 none), that cost, the node it came from (−1 at a source). */
export interface RouteRegions {
  owner: Int32Array;
  cost: Float64Array;
  prev: Int32Array;
}

/**
 * The regions of many sources: one search from all of them at once. A node no source reaches within `maxNodes`
 * settled nodes has owner −1, cost Infinity and prev −1. A node listed twice as a source belongs to its first entry.
 */
export function routeRegions(g: SphereGrid, o: { sources: ArrayLike<number>; cost: StepCost; maxNodes: number }): RouteRegions {
  const count = g.count;
  const owner = new Int32Array(count).fill(-1);
  const best = new Float64Array(count).fill(Infinity);
  const prev = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  const heap = new Heap();
  const { cost } = o;
  for (let i = 0; i < o.sources.length; i++) {
    const s = o.sources[i]!;
    if (!(s >= 0 && s < count)) throw new Error(`routeRegions: source ${i} (node ${s}) is not on the grid`);
    if (owner[s] !== -1) continue;
    owner[s] = i;
    best[s] = 0;
    heap.push(0, i, s);
  }
  let settled = 0;
  while (heap.size > 0 && settled < o.maxNodes) {
    heap.pop();
    const c = heap.cost[heap.size]!;
    const src = heap.src[heap.size]!;
    const u = heap.node[heap.size]!;
    if (done[u] === 1 || c > best[u]!) continue;
    done[u] = 1;
    settled++;
    const k = gridNeighbours(g, u, nb);
    for (let j = 0; j < k; j++) {
      const v = nb[j]!;
      if (done[v] === 1) continue;
      const step = cost(u, v);
      if (step === Infinity) continue;
      checkCost(step, u, v);
      const nc = c + step;
      if (nc < best[v]!) {
        best[v] = nc;
        owner[v] = src;
        prev[v] = u;
        heap.push(nc, src, v);
      }
    }
  }
  // Nodes seen but not settled before the cap belong to no one.
  if (heap.size > 0) {
    for (let i = 0; i < count; i++) {
      if (done[i] === 1) continue;
      owner[i] = -1;
      best[i] = Infinity;
      prev[i] = -1;
    }
  }
  return { owner, cost: best, prev };
}

/**
 * Per pair of sources whose regions touch (a < b, sorted by a then b) the cheapest step between the two regions:
 * cost = r.cost[nodeA] + cost(nodeA, nodeB) + r.cost[nodeB], nodeA in the region of a, nodeB in that of b.
 */
export interface RegionLinks {
  a: Uint32Array;
  b: Uint32Array;
  cost: Float64Array;
  nodeA: Uint32Array;
  nodeB: Uint32Array;
}

/**
 * The links between the regions of `routeRegions`: every step from a node of region a to a neighbour of region b
 * (a < b) is a candidate; per pair the least cost wins, ties the first in node order and then neighbour order.
 */
export function regionLinks(g: SphereGrid, r: RouteRegions, cost: StepCost): RegionLinks {
  const count = g.count;
  if (r.owner.length !== count) throw new Error(`regionLinks: regions of ${r.owner.length} nodes for a grid of ${count}`);
  let sources = 0;
  for (let i = 0; i < count; i++) if (r.owner[i]! >= sources) sources = r.owner[i]! + 1;
  // Per pair (key a · sources + b): index into the lists below. The map is only looked up, never iterated.
  const index = new Map<number, number>();
  const la: number[] = [];
  const lb: number[] = [];
  const lc: number[] = [];
  const na: number[] = [];
  const nbs: number[] = [];
  for (let u = 0; u < count; u++) {
    const a = r.owner[u]!;
    if (a < 0) continue;
    const k = gridNeighbours(g, u, nb);
    for (let j = 0; j < k; j++) {
      const v = nb[j]!;
      const b = r.owner[v]!;
      if (b <= a) continue;
      const step = cost(u, v);
      if (step === Infinity) continue;
      checkCost(step, u, v);
      const c = r.cost[u]! + step + r.cost[v]!;
      const key = a * sources + b;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, la.length);
        la.push(a);
        lb.push(b);
        lc.push(c);
        na.push(u);
        nbs.push(v);
      } else if (c < lc[at]!) {
        lc[at] = c;
        na[at] = u;
        nbs[at] = v;
      }
    }
  }
  const order = la.map((_, i) => i).sort((p, q) => la[p]! - la[q]! || lb[p]! - lb[q]!);
  const n = order.length;
  const out: RegionLinks = { a: new Uint32Array(n), b: new Uint32Array(n), cost: new Float64Array(n), nodeA: new Uint32Array(n), nodeB: new Uint32Array(n) };
  order.forEach((i, k) => {
    out.a[k] = la[i]!;
    out.b[k] = lb[i]!;
    out.cost[k] = lc[i]!;
    out.nodeA[k] = na[i]!;
    out.nodeB[k] = nbs[i]!;
  });
  return out;
}
