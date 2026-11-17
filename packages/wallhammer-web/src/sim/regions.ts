// Route search on two levels over a navigation graph (in the spirit of HPA*).
//
// The nodes are split into regions (a square grid, or any partition the caller gives). A node with an edge to or from
// another region is a gate. For every gate the cheapest ways inside its region are precomputed as two tables of ways: from the
// gate to every node of the region and from every node to the gate. A query then searches only the small graph of
// gates (edges between regions, plus gate to gate inside a region at the precomputed cost) and stitches the route
// together from the tables. Routes are kept in a cache.
//
// A route is a pure function of the graph and the two nodes: integer costs, a fixed tie-break (cost, then index), and
// regions built on demand give the same tables as regions built ahead. So preparing ahead in pieces (`prepare`) only
// moves the work, it never changes a route. Every way between two regions passes gates and the ways between the
// gates of a region are exact, so a route costs what the plain A* of the graph finds; among equally cheap routes it
// may pick another one.
//
// Not simulation state: it only reads the graph. After costs or blocked flags of the graph change, call `rebuild`.

import { lengthMm, mm } from './fixed.ts';
import type { NavGraph } from './nav.ts';

export interface RegionNavOptions {
  /** Side of the square regions, metres. Default 400. */
  cell?: number;
  /** A region per node instead of the grid: any non-negative integers, equal for nodes of one region. */
  regionOf?: ArrayLike<number>;
  /** Most routes kept in the cache; when it is full it starts over. Default 65536. */
  cacheLimit?: number;
}

/** Binary heap of (key, id) pairs ordered by key, then id: the same pops on every machine. */
class Heap {
  private readonly key: number[] = [];
  private readonly id: number[] = [];

  get size(): number {
    return this.key.length;
  }

  /** The smallest key (only when `size` > 0). */
  get min(): number {
    return this.key[0]!;
  }

  clear(): void {
    this.key.length = 0;
    this.id.length = 0;
  }

  private less(i: number, j: number): boolean {
    return this.key[i]! < this.key[j]! || (this.key[i] === this.key[j] && this.id[i]! < this.id[j]!);
  }

  private swap(i: number, j: number): void {
    const k = this.key[i]!;
    this.key[i] = this.key[j]!;
    this.key[j] = k;
    const d = this.id[i]!;
    this.id[i] = this.id[j]!;
    this.id[j] = d;
  }

  push(key: number, id: number): void {
    this.key.push(key);
    this.id.push(id);
    let i = this.key.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Removes the smallest pair and returns its id; its key is in `popped`. */
  popped = 0;
  pop(): number {
    const top = this.id[0]!;
    this.popped = this.key[0]!;
    const last = this.key.length - 1;
    this.swap(0, last);
    this.key.pop();
    this.id.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < last && this.less(l, m)) m = l;
      if (r < last && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

const EMPTY = new Int32Array(0);
/** `viaGate` of a gate reached straight from the start node. */
const FROM_START = -1;

export class RegionNav {
  readonly nav: NavGraph;
  readonly regionCount: number;
  readonly gateCount: number;
  /** Region of each node. */
  readonly region: Int32Array;
  /** Index of each node inside its region. */
  private readonly local: Int32Array;
  /** Gates of region r: the gate indices `gateStart[r] … gateStart[r + 1]`, ascending by node. */
  private readonly gateStart: Int32Array;
  private readonly gateNode: Int32Array;
  /** Gate index of a node, or -1. */
  private readonly gateOf: Int32Array;
  private readonly regionSize: Int32Array;
  private readonly mmX: Int32Array;
  private readonly mmZ: Int32Array;
  /** Outgoing and incoming edges per node, by edge index. */
  private readonly outStart: Int32Array;
  private readonly outEdges: Int32Array;
  private readonly inStart: Int32Array;
  private readonly inEdges: Int32Array;
  /** Tables per gate: cost and edge per node of the region, away from the gate (`fwd`) and towards it (`rev`). */
  private readonly fwdCost: (Float64Array | undefined)[];
  private readonly fwdVia: (Int32Array | undefined)[];
  private readonly revCost: (Float64Array | undefined)[];
  private readonly revVia: (Int32Array | undefined)[];
  private readonly built: Uint8Array;
  private unbuilt: number;
  private nextUnbuilt = 0;
  private costPerMm = 1;
  private readonly cache = new Map<number, Int32Array | null>();
  private readonly cacheLimit: number;
  /** Search over the gates: cost, where it came from, and which query the values belong to. */
  private readonly gCost: Float64Array;
  private readonly viaGate: Int32Array;
  private readonly viaEdge: Int32Array;
  private readonly seen: Int32Array;
  private readonly closed: Int32Array;
  private query = 0;
  private readonly heap = new Heap();
  private readonly wayHeap = new Heap();
  /** Routes searched (cache misses) and routes answered from the cache. */
  searches = 0;
  hits = 0;

  constructor(nav: NavGraph, options: RegionNavOptions = {}) {
    this.nav = nav;
    this.cacheLimit = Math.max(1, options.cacheLimit ?? 65536);
    const n = nav.nodeCount;
    const m = nav.edgeCount;
    this.mmX = new Int32Array(n);
    this.mmZ = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this.mmX[i] = mm(nav.nodeX[i]!);
      this.mmZ[i] = mm(nav.nodeZ[i]!);
    }
    // Regions: the caller's partition or grid squares, numbered in the order nodes first name them.
    const raw = new Float64Array(n);
    if (options.regionOf) {
      if (options.regionOf.length !== n) throw new Error('RegionNav: regionOf needs one entry per node');
      for (let i = 0; i < n; i++) raw[i] = options.regionOf[i]!;
    } else {
      const cell = Math.max(1, mm(options.cell ?? 400));
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < n; i++) {
        minX = Math.min(minX, this.mmX[i]!);
        maxX = Math.max(maxX, this.mmX[i]!);
        minZ = Math.min(minZ, this.mmZ[i]!);
      }
      const cols = n > 0 ? Math.floor((maxX - minX) / cell) + 1 : 1;
      for (let i = 0; i < n; i++) raw[i] = Math.floor((this.mmZ[i]! - minZ) / cell) * cols + Math.floor((this.mmX[i]! - minX) / cell);
    }
    const ids = new Map<number, number>();
    this.region = new Int32Array(n);
    this.local = new Int32Array(n);
    const sizes: number[] = [];
    for (let i = 0; i < n; i++) {
      let r = ids.get(raw[i]!);
      if (r === undefined) {
        r = sizes.length;
        ids.set(raw[i]!, r);
        sizes.push(0);
      }
      this.region[i] = r;
      this.local[i] = sizes[r]!;
      sizes[r] = sizes[r]! + 1;
    }
    const regions = sizes.length;
    this.regionCount = regions;
    this.regionSize = Int32Array.from(sizes);
    // Adjacency in both directions.
    this.outStart = new Int32Array(n + 1);
    this.inStart = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      this.outStart[nav.edgeFrom[e]! + 1]!++;
      this.inStart[nav.edgeTo[e]! + 1]!++;
    }
    for (let i = 0; i < n; i++) {
      this.outStart[i + 1] = this.outStart[i + 1]! + this.outStart[i]!;
      this.inStart[i + 1] = this.inStart[i + 1]! + this.inStart[i]!;
    }
    this.outEdges = new Int32Array(m);
    this.inEdges = new Int32Array(m);
    const outFill = this.outStart.slice(0, n);
    const inFill = this.inStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      const a = nav.edgeFrom[e]!;
      const b = nav.edgeTo[e]!;
      this.outEdges[outFill[a]!] = e;
      outFill[a] = outFill[a]! + 1;
      this.inEdges[inFill[b]!] = e;
      inFill[b] = inFill[b]! + 1;
    }
    // Gates: nodes on an edge between two regions. Numbered region by region, ascending by node.
    const isGate = new Uint8Array(n);
    for (let e = 0; e < m; e++) {
      const a = nav.edgeFrom[e]!;
      const b = nav.edgeTo[e]!;
      if (this.region[a] !== this.region[b]) {
        isGate[a] = 1;
        isGate[b] = 1;
      }
    }
    this.gateStart = new Int32Array(regions + 1);
    for (let i = 0; i < n; i++) if (isGate[i]) this.gateStart[this.region[i]! + 1]!++;
    for (let r = 0; r < regions; r++) this.gateStart[r + 1] = this.gateStart[r + 1]! + this.gateStart[r]!;
    const gates = this.gateStart[regions]!;
    this.gateCount = gates;
    this.gateNode = new Int32Array(gates);
    this.gateOf = new Int32Array(n).fill(-1);
    const gateFill = this.gateStart.slice(0, regions);
    for (let i = 0; i < n; i++) {
      if (!isGate[i]) continue;
      const r = this.region[i]!;
      const g = gateFill[r]!;
      gateFill[r] = g + 1;
      this.gateNode[g] = i;
      this.gateOf[i] = g;
    }
    this.fwdCost = new Array<Float64Array | undefined>(gates);
    this.fwdVia = new Array<Int32Array | undefined>(gates);
    this.revCost = new Array<Float64Array | undefined>(gates);
    this.revVia = new Array<Int32Array | undefined>(gates);
    this.built = new Uint8Array(regions);
    this.unbuilt = regions;
    this.gCost = new Float64Array(gates);
    this.viaGate = new Int32Array(gates);
    this.viaEdge = new Int32Array(gates);
    this.seen = new Int32Array(gates);
    this.closed = new Int32Array(gates);
    this.updateHeuristic();
  }

  private updateHeuristic(): void {
    const nav = this.nav;
    let r = Infinity;
    for (let e = 0; e < nav.edgeCount; e++) r = Math.min(r, nav.edgeCost[e]! / nav.edgeLength[e]!);
    this.costPerMm = Number.isFinite(r) ? r : 1;
  }

  // --- Preparation -----------------------------------------------------------------------------------------------

  /** Regions whose tables are not built yet. */
  get pending(): number {
    return this.unbuilt;
  }

  /** Are all regions built (no query has to build one)? */
  get ready(): boolean {
    return this.unbuilt === 0;
  }

  /**
   * Builds the tables of up to `maxRegions` regions and returns how many are still missing. Call it with a small
   * number from every frame to spread the work; queries build the regions they need themselves, so the routes are the
   * same whether this was called or not.
   */
  prepare(maxRegions = Infinity): number {
    let done = 0;
    while (this.unbuilt > 0 && done < maxRegions && this.nextUnbuilt < this.regionCount) {
      const r = this.nextUnbuilt++;
      if (this.built[r]) continue;
      this.buildRegion(r);
      done++;
    }
    return this.unbuilt;
  }

  /** Forgets every table and cached route: call after costs or blocked flags of the graph changed. */
  rebuild(): void {
    this.built.fill(0);
    this.unbuilt = this.regionCount;
    this.nextUnbuilt = 0;
    for (let g = 0; g < this.gateCount; g++) {
      this.fwdCost[g] = undefined;
      this.fwdVia[g] = undefined;
      this.revCost[g] = undefined;
      this.revVia[g] = undefined;
    }
    this.cache.clear();
    this.updateHeuristic();
  }

  private buildRegion(r: number): void {
    for (let g = this.gateStart[r]!; g < this.gateStart[r + 1]!; g++) {
      const node = this.gateNode[g]!;
      const fwd = this.ways(r, node, false);
      this.fwdCost[g] = fwd.cost;
      this.fwdVia[g] = fwd.via;
      const rev = this.ways(r, node, true);
      this.revCost[g] = rev.cost;
      this.revVia[g] = rev.via;
    }
    this.built[r] = 1;
    this.unbuilt--;
  }

  private ensure(r: number): void {
    if (!this.built[r]) this.buildRegion(r);
  }

  /**
   * Cheapest ways inside region `r` from `root` to every node (or, reversed, from every node to `root`): the cost per
   * local node and the edge that reaches it (reversed: the edge that leaves it towards the root). `goal` ends the
   * search early.
   */
  private ways(r: number, root: number, reverse: boolean, goal = -1): { cost: Float64Array; via: Int32Array } {
    const nav = this.nav;
    const size = this.regionSize[r]!;
    const cost = new Float64Array(size).fill(Infinity);
    const via = new Int32Array(size).fill(-1);
    const start = reverse ? this.inStart : this.outStart;
    const list = reverse ? this.inEdges : this.outEdges;
    const far = reverse ? nav.edgeFrom : nav.edgeTo;
    const heap = this.wayHeap;
    heap.clear();
    cost[this.local[root]!] = 0;
    heap.push(0, root);
    while (heap.size > 0) {
      const u = heap.pop();
      const cu = heap.popped;
      if (cu > cost[this.local[u]!]!) continue;
      if (u === goal) break;
      for (let k = start[u]!; k < start[u + 1]!; k++) {
        const e = list[k]!;
        if (nav.blocked[e]) continue;
        const v = far[e]!;
        if (this.region[v] !== r) continue;
        const cv = cu + nav.edgeCost[e]!;
        const lv = this.local[v]!;
        if (cv < cost[lv]!) {
          cost[lv] = cv;
          via[lv] = e;
          heap.push(cv, v);
        }
      }
    }
    heap.clear();
    return { cost, via };
  }

  // --- Queries ---------------------------------------------------------------------------------------------------

  /**
   * A route as a list of edges (empty when from = to), or null when the goal cannot be reached. Cached; do not change
   * the returned array.
   */
  find(from: number, to: number): Int32Array | null {
    if (from === to) return EMPTY;
    const key = from * this.nav.nodeCount + to;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.hits++;
      return hit;
    }
    this.searches++;
    const route = this.search(from, to);
    if (this.cache.size >= this.cacheLimit) this.cache.clear();
    this.cache.set(key, route);
    return route;
  }

  private heuristic(node: number, to: number): number {
    return Math.floor(lengthMm(this.mmX[to]! - this.mmX[node]!, this.mmZ[to]! - this.mmZ[node]!) * this.costPerMm);
  }

  private search(from: number, to: number): Int32Array | null {
    const nav = this.nav;
    const rs = this.region[from]!;
    const rt = this.region[to]!;
    this.ensure(rs);
    this.ensure(rt);
    const q = ++this.query;
    const lFrom = this.local[from]!;
    const lTo = this.local[to]!;
    // The cheapest known way to the goal: through the gate `goalGate`, or (-1) the way that stays inside the region.
    let best = Infinity;
    let goalGate = -1;
    let direct: { cost: Float64Array; via: Int32Array } | null = null;
    if (rs === rt) {
      direct = this.ways(rs, from, false, to);
      best = direct.cost[lTo]!;
    }
    const heap = this.heap;
    heap.clear();
    for (let g = this.gateStart[rs]!; g < this.gateStart[rs + 1]!; g++) {
      const c = this.revCost[g]![lFrom]!;
      if (c === Infinity) continue;
      this.seen[g] = q;
      this.gCost[g] = c;
      this.viaGate[g] = FROM_START;
      this.viaEdge[g] = -1;
      heap.push(c + this.heuristic(this.gateNode[g]!, to), g);
    }
    while (heap.size > 0 && heap.min < best) {
      const g = heap.pop();
      if (this.closed[g] === q) continue;
      this.closed[g] = q;
      const c = this.gCost[g]!;
      const node = this.gateNode[g]!;
      const r = this.region[node]!;
      this.ensure(r);
      const fc = this.fwdCost[g]!;
      if (r === rt) {
        const t = c + fc[lTo]!;
        if (t < best) {
          best = t;
          goalGate = g;
        }
      }
      // Edges into other regions.
      for (let k = this.outStart[node]!; k < this.outStart[node + 1]!; k++) {
        const e = this.outEdges[k]!;
        if (nav.blocked[e]) continue;
        const v = nav.edgeTo[e]!;
        if (this.region[v] === r) continue;
        const g2 = this.gateOf[v]!;
        if (this.closed[g2] === q) continue;
        const c2 = c + nav.edgeCost[e]!;
        if (this.seen[g2] !== q || c2 < this.gCost[g2]!) {
          this.seen[g2] = q;
          this.gCost[g2] = c2;
          this.viaGate[g2] = g;
          this.viaEdge[g2] = e;
          heap.push(c2 + this.heuristic(v, to), g2);
        }
      }
      // The other gates of this region, at the precomputed cost.
      for (let g2 = this.gateStart[r]!; g2 < this.gateStart[r + 1]!; g2++) {
        if (g2 === g || this.closed[g2] === q) continue;
        const v = this.gateNode[g2]!;
        const w = fc[this.local[v]!]!;
        if (w === Infinity) continue;
        const c2 = c + w;
        if (this.seen[g2] !== q || c2 < this.gCost[g2]!) {
          this.seen[g2] = q;
          this.gCost[g2] = c2;
          this.viaGate[g2] = g;
          this.viaEdge[g2] = -1;
          heap.push(c2 + this.heuristic(v, to), g2);
        }
      }
    }
    heap.clear();
    if (best === Infinity) return null;
    // Stitch the route, goal first.
    const back: number[] = [];
    const walkBack = (gate: number, node: number): void => {
      const via = this.fwdVia[gate]!;
      const root = this.gateNode[gate]!;
      for (let v = node; v !== root; ) {
        const e = via[this.local[v]!]!;
        back.push(e);
        v = nav.edgeFrom[e]!;
      }
    };
    if (goalGate < 0) {
      for (let v = to; v !== from; ) {
        const e = direct!.via[this.local[v]!]!;
        back.push(e);
        v = nav.edgeFrom[e]!;
      }
      return Int32Array.from(back.reverse());
    }
    walkBack(goalGate, to);
    let g = goalGate;
    while (this.viaGate[g] !== FROM_START) {
      const p = this.viaGate[g]!;
      if (this.viaEdge[g]! >= 0) back.push(this.viaEdge[g]!);
      else walkBack(p, this.gateNode[g]!);
      g = p;
    }
    // From the start node to the first gate along that gate's table of ways towards it.
    const head: number[] = [];
    const first = this.gateNode[g]!;
    const toGate = this.revVia[g]!;
    for (let v = from; v !== first; ) {
      const e = toGate[this.local[v]!]!;
      head.push(e);
      v = nav.edgeTo[e]!;
    }
    const out = new Int32Array(head.length + back.length);
    out.set(head);
    for (let i = 0; i < back.length; i++) out[head.length + i] = back[back.length - 1 - i]!;
    return out;
  }

  /** Summed cost of a route's edges. */
  cost(route: ArrayLike<number>): number {
    let c = 0;
    for (let i = 0; i < route.length; i++) c += this.nav.edgeCost[route[i]!]!;
    return c;
  }

  /** Routes in the cache now. */
  get cached(): number {
    return this.cache.size;
  }
}
