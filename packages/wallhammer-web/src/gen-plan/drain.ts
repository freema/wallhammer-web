// Drainage of a height field over a sphere grid: hollows are filled from the base level inward, every node gets the
// node it drains to, flow is gathered downstream, filled hollows that are large and deep enough become pools, and the
// nodes that carry enough flow are traced as channels. Exact and order-fixed: a heap ordered by (filled height, node
// index), neighbours in the fixed order of `gridNeighbours`, no tilt by an epsilon, so every runtime gives the same bits.

import { gridDirection, gridNeighbours } from './grid.ts';
import type { SphereGrid } from './grid.ts';

/** What `drainGrid` returns. Arrays of one entry per node unless named otherwise. */
export interface Drainage {
  /** Height after the hollows are filled: the level water stands at. */
  filled: Float32Array;
  /** The node this one drains to; −1 at a base node (and at the one outlet of a grid without base nodes). */
  to: Int32Array;
  /** All nodes, each before the node it drains to. */
  order: Uint32Array;
  /** Supply of the node plus the flow of every node that drains to it. */
  flow: Float32Array;
  /** 0, or 1 + the index of the pool the node lies in. */
  pool: Uint16Array;
  /** Per pool: the common filled height, the number of its nodes, and its sill (the node outside it that it spills to). */
  pools: { level: Float32Array; nodes: Uint32Array; outlet: Int32Array };
}

/** Options of `drainGrid`. */
export interface DrainOptions {
  /** Nodes at or under this height are base nodes: they drain nowhere. */
  baseLevel: number;
  /** Per node, what it adds to the flow (default 1 everywhere). Not negative. */
  supply?: ArrayLike<number>;
  /** A filled hollow is a pool from this many nodes on … */
  minPoolNodes: number;
  /** … and when its deepest node lies at least this far under the filled height. */
  minPoolDepth: number;
}

/** A binary heap of node indices ordered by (key, node). */
class NodeHeap {
  private readonly items: Uint32Array;
  private readonly key: Float32Array;
  size = 0;
  constructor(capacity: number, key: Float32Array) {
    this.items = new Uint32Array(capacity);
    this.key = key;
  }
  private less(a: number, b: number): boolean {
    const ka = this.key[a]!;
    const kb = this.key[b]!;
    return ka < kb || (ka === kb && a < b);
  }
  push(node: number): void {
    const items = this.items;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = items[parent]!;
      if (!this.less(node, p)) break;
      items[i] = p;
      i = parent;
    }
    items[i] = node;
  }
  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items[--this.size]!;
    const size = this.size;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      const r = l + 1;
      const c = r < size && this.less(items[r]!, items[l]!) ? r : l;
      if (!this.less(items[c]!, last)) break;
      items[i] = items[c]!;
      i = c;
    }
    if (size > 0) items[i] = last;
    return top;
  }
}

/**
 * Fills the hollows of `heights` (one per node) from the base nodes inward and drains every node.
 *
 * A node taken from the heap visits its unvisited neighbours in `gridNeighbours` order; each gets the larger of its
 * own height and the filled height of the node that reached it, which is its flood parent. A node drains to the
 * neighbour with the steepest fall of the filled height (drop over the chord between the node middles, the earlier
 * neighbour on a tie) when one is strictly lower, else to its flood parent. Without a base node the lowest node (the
 * lowest index on a tie) is the only outlet. Pools are numbered by their lowest node; more than 65 535 throws.
 */
export function drainGrid(g: SphereGrid, heights: ArrayLike<number>, o: DrainOptions): Drainage {
  const count = g.count;
  if (heights.length !== count) throw new Error(`gen-plan: ${heights.length} heights for ${count} nodes`);
  const filled = new Float32Array(count);
  const to = new Int32Array(count).fill(-2);
  const order = new Uint32Array(count);
  const heap = new NodeHeap(count, filled);
  const nb = new Int32Array(8);

  // The base nodes, or the lowest node.
  let bases = 0;
  for (let i = 0; i < count; i++) {
    const h = Math.fround(heights[i]!);
    filled[i] = h;
    if (h <= o.baseLevel) {
      to[i] = -1;
      heap.push(i);
      bases++;
    }
  }
  if (bases === 0) {
    let low = 0;
    for (let i = 1; i < count; i++) if (filled[i]! < filled[low]!) low = i;
    to[low] = -1;
    heap.push(low);
  }

  // The flood. `to` holds the flood parent for now; `order` is filled from the back, so it ends upstream first.
  let taken = count;
  while (heap.size > 0) {
    const p = heap.pop();
    order[--taken] = p;
    const fp = filled[p]!;
    const k = gridNeighbours(g, p, nb);
    for (let j = 0; j < k; j++) {
      const q = nb[j]!;
      if (to[q] !== -2) continue;
      if (filled[q]! < fp) filled[q] = fp;
      to[q] = p;
      heap.push(q);
    }
  }
  if (taken !== 0) throw new Error('gen-plan: the grid is not connected');

  // The steepest strictly lower neighbour wins over the flood parent.
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    if (to[i] === -1) continue;
    const fi = filled[i]!;
    const k = gridNeighbours(g, i, nb);
    let best = -1;
    let bestFall = 0;
    let haveA = false;
    for (let j = 0; j < k; j++) {
      const q = nb[j]!;
      const drop = fi - filled[q]!;
      if (!(drop > 0)) continue;
      if (!haveA) {
        gridDirection(g, i, a);
        haveA = true;
      }
      gridDirection(g, q, b);
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      const fall = drop / Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (fall > bestFall) {
        bestFall = fall;
        best = q;
      }
    }
    if (best >= 0) to[i] = best;
  }

  const flow = gatherFlow(count, to, order, o.supply);

  // Pools: nodes under water joined through neighbours at the same filled height, numbered by their lowest node.
  const pool = new Uint16Array(count);
  const levels: number[] = [];
  const sizes: number[] = [];
  // A set is walked to its end before the next one starts, so one flag per node is enough.
  const mark = new Uint8Array(count);
  const stack: number[] = [];
  const members: number[] = [];
  for (let i = 0; i < count; i++) {
    if (mark[i] !== 0 || !(filled[i]! > Math.fround(heights[i]!))) continue;
    const level = filled[i]!;
    members.length = 0;
    stack.length = 0;
    stack.push(i);
    mark[i] = 1;
    let deepest = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      members.push(p);
      const depth = level - Math.fround(heights[p]!);
      if (depth > deepest) deepest = depth;
      const k = gridNeighbours(g, p, nb);
      for (let j = 0; j < k; j++) {
        const q = nb[j]!;
        if (mark[q] !== 0 || filled[q] !== level || !(level > Math.fround(heights[q]!))) continue;
        mark[q] = 1;
        stack.push(q);
      }
    }
    if (members.length < o.minPoolNodes || deepest < o.minPoolDepth) continue;
    if (levels.length >= 65535) throw new Error('gen-plan: more than 65 535 pools');
    levels.push(level);
    sizes.push(members.length);
    const id = levels.length;
    for (const m of members) pool[m] = id;
  }

  // The sill of a pool: where its first flooded node drains to (that node is the last of the pool in `order`).
  const outlet = new Int32Array(levels.length).fill(-1);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k]!;
    const p = pool[i]!;
    if (p > 0 && outlet[p - 1] === -1) outlet[p - 1] = to[i]!;
  }
  return { filled, to, order, flow, pool, pools: { level: Float32Array.from(levels), nodes: Uint32Array.from(sizes), outlet } };
}

/** Flow per node: its supply (default 1) plus the flow of every node draining to it, summed upstream first in doubles. */
function gatherFlow(count: number, to: Int32Array, order: Uint32Array, supply: ArrayLike<number> | undefined): Float32Array {
  if (supply && supply.length !== count) throw new Error(`gen-plan: ${supply.length} supply values for ${count} nodes`);
  const sum = new Float64Array(count);
  for (let i = 0; i < count; i++) sum[i] = supply ? supply[i]! : 1;
  for (let k = 0; k < count; k++) {
    const i = order[k]!;
    const t = to[i]!;
    if (t >= 0) sum[t] = sum[t]! + sum[i]!;
  }
  return Float32Array.from(sum);
}

/** Channels: chains of nodes along `to`, from `traceChannels`. */
export interface Channels {
  /** Per channel + 1: its first entry in `nodes`. */
  start: Uint32Array;
  nodes: Uint32Array;
  /** Per channel: −1 when it ends in a base node, −2 − pool index in a pool, else the channel it runs into. */
  into: Int32Array;
}

/**
 * The channels of a drainage: the nodes outside base and pools with at least `minFlow`, as chains along `to`. A
 * channel starts where no channel node drains in, or where two or more do, and ends with the first node that is a base
 * node, a pool node or the start of another channel; that end node belongs to the chain. Channels are ordered by the
 * place of their first node in `d.order`, so a channel comes before the ones below it.
 *
 * Only the node count of the grid and `to`, `flow`, `pool` and `order` of the drainage are read, so a drainage made
 * elsewhere (over a plane grid, say) can be traced too: `to` −1 at a base node, `order` upstream first, `pool` 0
 * outside pools.
 */
export function traceChannels(g: Pick<SphereGrid, 'count'>, d: Pick<Drainage, 'to' | 'flow' | 'pool' | 'order'>, o: { minFlow: number }): Channels {
  const count = g.count;
  const { to, flow, pool, order } = d;
  const isChannel = (i: number): boolean => to[i]! >= 0 && pool[i] === 0 && flow[i]! >= o.minFlow;
  // Channel nodes draining into each node, capped at 2.
  const inflow = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (!isChannel(i)) continue;
    const t = to[i]!;
    if (inflow[t]! < 2) inflow[t] = inflow[t]! + 1;
  }
  const startOf = new Map<number, number>();
  const firsts: number[] = [];
  for (let k = 0; k < count; k++) {
    const i = order[k]!;
    if (!isChannel(i) || inflow[i] === 1) continue;
    startOf.set(i, firsts.length);
    firsts.push(i);
  }
  const start = new Uint32Array(firsts.length + 1);
  const into = new Int32Array(firsts.length);
  const nodes: number[] = [];
  for (let c = 0; c < firsts.length; c++) {
    start[c] = nodes.length;
    let i = firsts[c]!;
    nodes.push(i);
    for (;;) {
      const t = to[i]!;
      nodes.push(t);
      if (to[t] === -1) {
        into[c] = -1;
        break;
      }
      if (pool[t] !== 0) {
        into[c] = -2 - (pool[t]! - 1);
        break;
      }
      const s = startOf.get(t);
      if (s !== undefined) {
        into[c] = s;
        break;
      }
      if (!isChannel(t)) throw new Error('gen-plan: a channel runs into a node with less flow (negative supply?)');
      i = t;
    }
  }
  start[firsts.length] = nodes.length;
  return { start, nodes: Uint32Array.from(nodes), into };
}
