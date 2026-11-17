// Navigation graph: nodes in metres, directed edges with an integer length (mm) and cost, an optional speed limit and
// a blocked flag. A* over integer costs with a fixed tie-break (f, then h, then node index), so the same graph and
// query always give the same route on every machine. Routes are cached; changing a cost or blocking an edge clears
// the cache. Costs and blocked flags may change at run time, so the graph is simulation state.

import { ByteReader, ByteWriter } from './bytes.ts';
import { lengthMm, snapMm } from './fixed.ts';
import type { PathDef, PathStop } from './paths.ts';
import type { SimState } from './simulation.ts';

export interface NavEdgeInput {
  from: number;
  to: number;
  /** Integer cost; default the length in mm. */
  cost?: number;
  /** Speed limit in m/s, 0 or missing = none. */
  speed?: number;
  /** Also add the edge in the opposite direction (same cost and limit). */
  both?: boolean;
}

export interface NavGraphInput {
  /** Node positions as x, z pairs in metres. */
  nodes: readonly number[];
  edges: readonly NavEdgeInput[];
}

export interface RouteOptions {
  /** The route returns to its start and repeats. */
  loop?: boolean;
  /** Shift to the right of the direction of travel in metres, so opposite directions use separate lanes. */
  rightOffset?: number;
  /** Stops at route vertices (vertex i is where edge i starts; the last vertex of an open route is edges.length). */
  stops?: readonly PathStop[];
}

const CACHE_LIMIT = 4096;

export class NavGraph implements SimState {
  readonly name: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Node positions in metres and in whole millimetres (A* works on the millimetres). */
  readonly nodeX: Float64Array;
  readonly nodeZ: Float64Array;
  private readonly mmX: Int32Array;
  private readonly mmZ: Int32Array;
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLength: Int32Array;
  readonly edgeCost: Int32Array;
  readonly edgeSpeed: Float64Array;
  readonly blocked: Uint8Array;
  /** Outgoing edges of node n: `outEdges[outStart[n] … outStart[n + 1]]`, in input order. */
  private readonly outStart: Int32Array;
  private readonly outEdges: Int32Array;
  private readonly cache = new Map<number, readonly number[] | null>();
  /** Lowest cost per mm of length, keeps the heuristic admissible. */
  private costPerMm = 1;
  /** Number of A* searches run (cache misses). */
  searches = 0;

  constructor(name: string, input: NavGraphInput) {
    this.name = name;
    const n = input.nodes.length / 2;
    this.nodeCount = n;
    this.nodeX = new Float64Array(n);
    this.nodeZ = new Float64Array(n);
    this.mmX = new Int32Array(n);
    this.mmZ = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      // Everything that enters the simulation is quantised at the boundary: whole millimetres, so a graph built with
      // Math.cos/sin gives the same simulation on every machine.
      this.mmX[i] = Math.round(input.nodes[i * 2]! * 1000);
      this.mmZ[i] = Math.round(input.nodes[i * 2 + 1]! * 1000);
      this.nodeX[i] = this.mmX[i]! / 1000;
      this.nodeZ[i] = this.mmZ[i]! / 1000;
    }
    const list: { from: number; to: number; cost?: number; speed: number }[] = [];
    for (const e of input.edges) {
      if (e.from < 0 || e.from >= n || e.to < 0 || e.to >= n || e.from === e.to) throw new Error(`NavGraph: bad edge ${e.from} → ${e.to}`);
      list.push({ from: e.from, to: e.to, ...(e.cost !== undefined ? { cost: e.cost } : {}), speed: e.speed ?? 0 });
      if (e.both) list.push({ from: e.to, to: e.from, ...(e.cost !== undefined ? { cost: e.cost } : {}), speed: e.speed ?? 0 });
    }
    const m = list.length;
    this.edgeCount = m;
    this.edgeFrom = new Int32Array(m);
    this.edgeTo = new Int32Array(m);
    this.edgeLength = new Int32Array(m);
    this.edgeCost = new Int32Array(m);
    this.edgeSpeed = new Float64Array(m);
    this.blocked = new Uint8Array(m);
    const degree = new Int32Array(n + 1);
    list.forEach((e, i) => {
      this.edgeFrom[i] = e.from;
      this.edgeTo[i] = e.to;
      const len = Math.max(1, lengthMm(this.mmX[e.to]! - this.mmX[e.from]!, this.mmZ[e.to]! - this.mmZ[e.from]!));
      this.edgeLength[i] = len;
      this.edgeCost[i] = Math.max(0, Math.round(e.cost ?? len));
      this.edgeSpeed[i] = snapMm(e.speed);
      degree[e.from + 1]!++;
    });
    this.outStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.outStart[i + 1] = this.outStart[i]! + degree[i + 1]!;
    this.outEdges = new Int32Array(m);
    const fill = this.outStart.slice(0, n);
    for (let i = 0; i < m; i++) this.outEdges[fill[this.edgeFrom[i]!]!++] = i;
    this.updateHeuristic();
  }

  private updateHeuristic(): void {
    let r = Infinity;
    for (let i = 0; i < this.edgeCount; i++) r = Math.min(r, this.edgeCost[i]! / this.edgeLength[i]!);
    this.costPerMm = Number.isFinite(r) ? r : 1;
  }

  private invalidate(): void {
    this.cache.clear();
    this.updateHeuristic();
  }

  /** The first edge from one node to another, or -1. */
  findEdge(from: number, to: number): number {
    for (let k = this.outStart[from]!; k < this.outStart[from + 1]!; k++) if (this.edgeTo[this.outEdges[k]!] === to) return this.outEdges[k]!;
    return -1;
  }

  /** Outgoing edges of a node, in input order. */
  edgesFrom(node: number): Int32Array {
    return this.outEdges.subarray(this.outStart[node]!, this.outStart[node + 1]!);
  }

  setCost(edge: number, cost: number): void {
    this.edgeCost[edge] = Math.max(0, Math.round(cost));
    this.invalidate();
  }

  setBlocked(edge: number, blocked: boolean): void {
    this.blocked[edge] = blocked ? 1 : 0;
    this.invalidate();
  }

  private heuristic(a: number, b: number): number {
    return Math.floor(lengthMm(this.mmX[b]! - this.mmX[a]!, this.mmZ[b]! - this.mmZ[a]!) * this.costPerMm);
  }

  /** Lowest-cost route as a list of edges (empty when from = to), or null when the goal cannot be reached. Cached. */
  findPath(from: number, to: number): readonly number[] | null {
    const key = from * this.nodeCount + to;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const route = this.search(from, to);
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(key, route);
    return route;
  }

  private search(from: number, to: number): readonly number[] | null {
    this.searches++;
    if (from === to) return [];
    const n = this.nodeCount;
    const g = new Float64Array(n).fill(Infinity);
    const via = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    // Binary heap of (f, h, node), ordered by f, then h, then node index.
    const hf: number[] = [];
    const hh: number[] = [];
    const hn: number[] = [];
    const less = (i: number, j: number): boolean => hf[i]! < hf[j]! || (hf[i] === hf[j] && (hh[i]! < hh[j]! || (hh[i] === hh[j] && hn[i]! < hn[j]!)));
    const swap = (i: number, j: number): void => {
      [hf[i], hf[j]] = [hf[j]!, hf[i]!];
      [hh[i], hh[j]] = [hh[j]!, hh[i]!];
      [hn[i], hn[j]] = [hn[j]!, hn[i]!];
    };
    const push = (f: number, h: number, node: number): void => {
      hf.push(f);
      hh.push(h);
      hn.push(node);
      let i = hf.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(i, p)) break;
        swap(i, p);
        i = p;
      }
    };
    const pop = (): number => {
      const top = hn[0]!;
      const last = hf.length - 1;
      swap(0, last);
      hf.pop();
      hh.pop();
      hn.pop();
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < hf.length && less(l, m)) m = l;
        if (r < hf.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
      return top;
    };
    g[from] = 0;
    const h0 = this.heuristic(from, to);
    push(h0, h0, from);
    while (hf.length > 0) {
      const u = pop();
      if (closed[u]) continue;
      if (u === to) break;
      closed[u] = 1;
      for (let k = this.outStart[u]!; k < this.outStart[u + 1]!; k++) {
        const e = this.outEdges[k]!;
        if (this.blocked[e]) continue;
        const v = this.edgeTo[e]!;
        if (closed[v]) continue;
        const gv = g[u]! + this.edgeCost[e]!;
        if (gv < g[v]!) {
          g[v] = gv;
          via[v] = e;
          const h = this.heuristic(v, to);
          push(gv + h, h, v);
        }
      }
    }
    if (via[to] === -1) return null;
    const edges: number[] = [];
    for (let v = to; v !== from; v = this.edgeFrom[via[v]!]!) edges.push(via[v]!);
    return edges.reverse();
  }

  /** Nodes visited by a route of edges, from the first edge's start. */
  routeNodes(edges: readonly number[]): number[] {
    if (edges.length === 0) return [];
    return [this.edgeFrom[edges[0]!]!, ...edges.map((e) => this.edgeTo[e]!)];
  }

  /**
   * A path along a route of edges: one segment per edge with the edge as its lane and the edge's speed limit.
   * With `rightOffset` the path runs that far to the right of the edges (mitred at the vertices).
   */
  path(edges: readonly number[], options: RouteOptions = {}): PathDef {
    if (edges.length === 0) throw new Error('NavGraph: an empty route has no path');
    const loop = options.loop ?? false;
    for (let i = 1; i < edges.length; i++) {
      if (this.edgeFrom[edges[i]!] !== this.edgeTo[edges[i - 1]!]) throw new Error(`NavGraph: edges ${edges[i - 1]} and ${edges[i]} are not connected`);
    }
    if (loop && this.edgeTo[edges[edges.length - 1]!] !== this.edgeFrom[edges[0]!]) throw new Error('NavGraph: a loop route must end where it starts');
    const nodes = this.routeNodes(edges);
    if (loop) nodes.pop();
    const off = options.rightOffset ?? 0;
    // Right-hand normal of each edge: (−dz, dx) for a direction (dx, dz), with x east and z south.
    const normal = (e: number): [number, number] => {
      const a = this.edgeFrom[e]!;
      const b = this.edgeTo[e]!;
      const dx = this.nodeX[b]! - this.nodeX[a]!;
      const dz = this.nodeZ[b]! - this.nodeZ[a]!;
      const l = Math.sqrt(dx * dx + dz * dz) || 1;
      return [-dz / l, dx / l];
    };
    const points: number[] = [];
    const count = nodes.length;
    for (let i = 0; i < count; i++) {
      const node = nodes[i]!;
      let nx = 0;
      let nz = 0;
      if (off !== 0) {
        const inE = i > 0 ? edges[i - 1] : loop ? edges[edges.length - 1] : undefined;
        const outE = i < edges.length ? edges[i] : undefined;
        const a = inE !== undefined ? normal(inE) : null;
        const b = outE !== undefined ? normal(outE) : null;
        if (a && b) {
          const d = 1 + a[0] * b[0] + a[1] * b[1];
          // Mitre: the offset point lies on both offset lines. Near a U-turn it would run away, so it stays plain.
          const k = d > 0.3 ? off / d : off / 2;
          nx = (a[0] + b[0]) * k;
          nz = (a[1] + b[1]) * k;
        } else {
          const c = (a ?? b)!;
          nx = c[0] * off;
          nz = c[1] * off;
        }
      }
      points.push(this.nodeX[node]! + nx, this.nodeZ[node]! + nz);
    }
    return {
      points,
      loop,
      speeds: edges.map((e) => this.edgeSpeed[e]!),
      lanes: [...edges],
      ...(options.stops ? { stops: options.stops } : {}),
    };
  }

  save(w: ByteWriter): void {
    w.u32(this.edgeCount);
    w.bytes(this.edgeCost);
    w.bytes(this.blocked);
  }

  load(r: ByteReader): void {
    if (r.u32() !== this.edgeCount) throw new Error('NavGraph: snapshot of another graph');
    r.into(this.edgeCost);
    r.into(this.blocked);
    this.invalidate();
  }
}
