// The footpaths of the island: a few places worth walking to, chosen from the water plan, and the paths between them.
// A pure function of the plan and of the field of its whole square.
//
//   1. Places: beside the mouth of the main line, beside its widest bend, below the highest fall, on the shore of the
//      largest lake and beside the mouth of another line that reaches the sea. Each is the point of the field nearest
//      to where it is wanted that is dry, well above any water that may stand there, clear of the wet and not steep.
//   2. A leg between two places is the cheapest route over a grid of every fourth point of the field (10 m), with
//      moves to the 8 neighbours and the 8 knight moves. A move costs its length, more the steeper it is, and a
//      little more or less by a slow noise, so a route over a plain bends instead of running ruled. It may not touch
//      the sea or a lake; each wet point of a line it crosses costs as much as a long detour, more the deeper the
//      water, so a path fords a brook where it likes and a river rarely and squarely. Legs laid later pay little for
//      ground an earlier leg already took, so they join it and fork from it. The route found is searched for again
//      near itself with its turns limited, so a switchback up a slope has room for its bend.
//   3. Where a leg runs on an earlier path it is cut: each stretch of ground belongs to one path, and a path that
//      leaves another starts on one of its stations (a junction). The rest is rounded, kept out of water it did not
//      enter before, and resampled into stations every `PATH_STATION_M`, each with the height of its tread.

import { hashInts, valueNoise3 } from 'wallhammer-web/gen-core';
import type { Field } from './field.ts';
import { HALF_M } from './land.ts';
import { BUCKET_M, BUCKET_N, average, resample, type Line, type Plan } from './plan.ts';
import { highestFall, widestSwing } from './views.ts';

/** Spacing of a path's stations, metres. */
export const PATH_STATION_M = 2;
/** `pathAt` knows nothing farther than this from every centreline, metres. */
export const PATH_REACH_M = 10;

export interface Place {
  name: string;
  x: number;
  z: number;
}

export interface Path {
  /** The places it joins (indexes into `PathPlan.places`). */
  from: number;
  to: number;
  /** Stations every `PATH_STATION_M` along the centreline. */
  n: number;
  x: Float64Array;
  z: Float64Array;
  /** Height of the tread at each station, metres. */
  y: Float64Array;
  /** 1 where the station lies in the water of a line (a ford), else 0. */
  ford: Uint8Array;
}

export interface PathPlan {
  places: Place[];
  paths: Path[];
  /** Spatial index like the water plan's: per bucket of `BUCKET_M` the stretches (path << 16 | station) within `PATH_REACH_M`. */
  bucketStart: Uint32Array;
  segs: Uint32Array;
  /**
   * Per path one of two sides (0 or 1), given so that two paths that come within `PATH_REACH_M` of each other are on
   * different sides wherever that can be done. Whoever interpolates the way to a path between points (a mesh) keeps
   * one way per side, so the ways to two paths that meet are never mixed.
   */
  side: Uint8Array;
}

export interface PathHit {
  /** Distance to the nearest centreline, metres. */
  d: number;
  /** The vector from the point to the nearest point of that centreline, metres (its length is `d`). */
  ox: number;
  oz: number;
  /** Tread height and ford share (0–1) there, interpolated along the stretch. */
  y: number;
  ford: number;
  path: number;
  i: number;
  t: number;
}

/** A node of the route grid is every this many points of the field. */
const NODE_PER = 4;
/** A place stands at least this far above the water that may stand there, this far outside the wet, and on ground
 * less steep than this. */
const PLACE_ABOVE_M = 1.2;
const PLACE_CLEAR_M = 6;
const PLACE_SLOPE = 0.2;
/** A move steeper than this between any two of its dry points is no move; its cost grows with the square of its grade
 * over the second. */
const MAX_GRADE = 0.45;
const GRADE_UNIT = 0.1;
/** Ground lower than this is no ground for a path, metres. */
const MIN_GROUND_M = 0.6;
/** A path keeps this many points of the field (5 m) away from the sea and from a lake. */
const KEEP_OFF = 2;
/** Cost of a wet point of a line, metres of walking, per metre of depth plus one. */
const FORD_COST_M = 90;
/** Dry ground less than this above the water of a line beside it is its wet edge; a move over it costs this many times. */
const EDGE_M = 0.5;
const EDGE_FACTOR = 3;
/** Wavelength of the noise that bends routes over a plain, metres. */
const BEND_NOISE_M = 120;
/** Share of the cost a later leg pays on a move between two nodes an earlier leg took. */
const SHARED = 0.35;
/** A point of a leg nearer than this to an earlier path lies on it, metres. */
const ON_PATH_M = 5;
/** A route turns by at most this much at a node, degrees, and is searched for so within this many nodes of the
 * first route found. Turns of up to 63.4° at 10 m keep a bend's radius near 10 m. */
const MAX_TURN_DEG = 65;
const CORRIDOR = 10;
/**
 * On a slope steeper than about `MAX_GRADE` no turn-limited route can turn back on itself without climbing the fall
 * line: there a route may be this steep, and the steep stretches it takes are its hairpins.
 */
const HAIRPIN_GRADE = 0.7;
/** Rounds of rounding of a route at stations of `PATH_STATION_M`. */
const ROUNDING = 24;
/** A crossing of a line's water runs straight for this many stations beyond the wet on either side. */
const STRAIGHT = 3;
/** A stretch that leaves a path and returns to it is left out unless the path between its ends is longer than this
 * many times its own length (plus `MIN_PATH_M`). */
const DETOUR = 2;
/** A stretch shorter than this is no path, metres. */
const MIN_PATH_M = 10;
/** How far a path wanders from its rounded line on gentle ground, metres, and over what length it eases in. */
const WANDER_M = 3.2;
const WANDER_EASE_M = 26;

// Flags of a point of the field.
const WET = 1;
/** The water of the sea or of a lake. */
const STAND = 2;
/** Too near standing water or too low: no path. */
const BLOCK = 4;
/** The water of a line. */
const LINE = 8;
/** The wet edge of a line (`EDGE_M`). */
const EDGE = 16;

// The 16 moves of the route grid, in pairs of opposites (move k ^ 1 is the way back of move k).
const MI = [1, -1, 0, 0, 1, -1, 1, -1, 1, -1, 2, -2, 1, -1, 2, -2];
const MJ = [0, 0, 1, -1, 1, -1, -1, 1, 2, -2, 1, -1, -2, 2, -1, 1];

/**
 * A binary heap of nodes ordered by (key, node index), each entry keeping the key it was pushed with: the search
 * lowers a node's cost while the node waits in the heap, which `NodeHeap` of plan.ts, reading its keys live, cannot
 * take.
 */
class KeyHeap {
  private readonly keys: number[] = [];
  private readonly nodes: number[] = [];
  key = 0;
  get size(): number {
    return this.nodes.length;
  }
  private less(ka: number, a: number, kb: number, b: number): boolean {
    return ka < kb || (ka === kb && a < b);
  }
  push(k: number, v: number): void {
    const ks = this.keys;
    const ns = this.nodes;
    let i = ns.length;
    ks.push(k);
    ns.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(k, v, ks[p]!, ns[p]!)) break;
      ks[i] = ks[p]!;
      ns[i] = ns[p]!;
      i = p;
    }
    ks[i] = k;
    ns[i] = v;
  }
  /** The first node; its key is left in `key`. */
  pop(): number {
    const ks = this.keys;
    const ns = this.nodes;
    const top = ns[0]!;
    this.key = ks[0]!;
    const k = ks.pop()!;
    const v = ns.pop()!;
    const n = ns.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.less(ks[c + 1]!, ns[c + 1]!, ks[c]!, ns[c]!)) c++;
        if (!this.less(ks[c]!, ns[c]!, k, v)) break;
        ks[i] = ks[c]!;
        ns[i] = ns[c]!;
        i = c;
      }
      ks[i] = k;
      ns[i] = v;
    }
    return top;
  }
}

/** What the routing knows of the field: its points' flags, the grid of nodes and the costs of moves found so far. */
interface Ground {
  f: Field;
  flag: Uint8Array;
  /** Nodes along one edge of the route grid, and their count. */
  nn: number;
  count: number;
  /** Per node and move its cost whatever its grade, NaN until asked for, and its grade. */
  cost: Float32Array;
  grade: Float32Array;
  /** The bending noise on a grid of half a node (where the middles of all moves lie), NaN until asked for. */
  noise: Float32Array;
  noiseSeed: number;
}

function groundOf(plan: Plan, f: Field): Ground {
  const n = f.n;
  const flag = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const g = f.ground[k]!;
    const w = f.water[k]!;
    let fl = 0;
    if (w > g + 0.01) fl = f.body[k] === 2 ? WET | LINE : WET | STAND | BLOCK;
    else if (f.body[k] === 2 && g - w < EDGE_M) fl = EDGE;
    if (g < MIN_GROUND_M) fl |= BLOCK;
    flag[k] = fl;
  }
  // The margin round standing water, from the points of its edge.
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!(flag[k]! & STAND)) continue;
      const edge = (i > 0 && !(flag[k - 1]! & STAND)) || (i < n - 1 && !(flag[k + 1]! & STAND)) || (j > 0 && !(flag[k - n]! & STAND)) || (j < n - 1 && !(flag[k + n]! & STAND));
      if (!edge) continue;
      for (let dj = -KEEP_OFF; dj <= KEEP_OFF; dj++)
        for (let di = -KEEP_OFF; di <= KEEP_OFF; di++) {
          if (di * di + dj * dj > KEEP_OFF * KEEP_OFF) continue;
          const a = i + di;
          const b = j + dj;
          if (a >= 0 && b >= 0 && a < n && b < n) flag[b * n + a]! |= BLOCK;
        }
    }
  const nn = Math.floor((n - 1) / NODE_PER) + 1;
  const half = 2 * (nn - 1) + 1;
  return {
    f,
    flag,
    nn,
    count: nn * nn,
    cost: new Float32Array(nn * nn * 16).fill(NaN),
    grade: new Float32Array(nn * nn * 16),
    noise: new Float32Array(half * half).fill(NaN),
    noiseSeed: hashInts(plan.seed, 0x9a7f),
  };
}

/** The bending noise at a point of the half-node grid, 0 to 1. */
function bendNoise(g: Ground, hi: number, hj: number): number {
  const half = 2 * (g.nn - 1) + 1;
  const k = hj * half + hi;
  let v = g.noise[k]!;
  if (Number.isNaN(v)) {
    const s = (g.f.step * NODE_PER) / 2;
    v = valueNoise3(g.f.x0 + hi * s, 0, g.f.z0 + hj * s, BEND_NOISE_M, g.noiseSeed);
    g.noise[k] = v;
  }
  return v;
}

/** The grade of the walk `walkCost` measured last. */
let walkGrade = 0;

/** Points of the field along a walk, filled by its caller. */
const walkPoints = new Int32Array(64);

/**
 * Cost of a walk over the first `count` points of `walkPoints`, each `sub` metres from the next, with the bending
 * noise `noise`: infinite where it touches standing water; its steepest grade is left in `walkGrade`. The end points
 * count half for the water, so a chain of walks counts every point once. The grade is measured between dry points:
 * across the water of a line from the dry point before it to the dry point after it, so the bed of a brook in its cut
 * channel is no wall to a ford, while a climb up a line's falls still counts.
 */
function walkCost(g: Ground, count: number, sub: number, noise: number): number {
  const { flag, f } = g;
  let rise = 0;
  let wet = 0;
  let edge = false;
  let dryH = 0;
  let dryAt = -1;
  for (let s = 0; s < count; s++) {
    const k = walkPoints[s]!;
    const fl = flag[k]!;
    if (fl & BLOCK) return Infinity;
    if (fl & EDGE) edge = true;
    const h = f.ground[k]!;
    if (fl & LINE) {
      wet += (s === 0 || s === count - 1 ? 0.5 : 1) * (1 + f.water[k]! - h);
      continue;
    }
    if (dryAt >= 0) rise = Math.max(rise, Math.abs(h - dryH) / (s - dryAt));
    dryH = h;
    dryAt = s;
  }
  const grade = rise / sub;
  walkGrade = grade;
  const q = grade / GRADE_UNIT;
  return (count - 1) * sub * (1 + 1.5 * q * q) * (0.8 + 0.5 * noise) * (edge ? EDGE_FACTOR : 1) + FORD_COST_M * wet;
}

/**
 * Cost of move `m` from node `u`, infinite when it is steeper than `limit` anywhere. Every move passes exactly
 * through points of the field at its quarters: a quarter of a move of (a, b) nodes is (a, b) points.
 */
function moveCost(g: Ground, u: number, m: number, limit: number): number {
  const at = u * 16 + m;
  const known = g.cost[at]!;
  if (!Number.isNaN(known)) return g.grade[at]! > limit ? Infinity : known;
  const nn = g.nn;
  const I = u % nn;
  const J = (u - I) / nn;
  const a = MI[m]!;
  const b = MJ[m]!;
  let c = Infinity;
  if (I + a >= 0 && J + b >= 0 && I + a < nn && J + b < nn) {
    const n = g.f.n;
    const k0 = J * NODE_PER * n + I * NODE_PER;
    for (let q = 0; q <= NODE_PER; q++) walkPoints[q] = k0 + q * (b * n + a);
    c = walkCost(g, NODE_PER + 1, g.f.step * Math.hypot(a, b), bendNoise(g, 2 * I + a, 2 * J + b));
    const back = ((J + b) * nn + I + a) * 16 + (m ^ 1);
    g.cost[back] = c;
    g.grade[back] = walkGrade;
    g.grade[at] = walkGrade;
  }
  g.cost[at] = c;
  return g.grade[at]! > limit ? Infinity : c;
}

/** Index of the field's point nearest to (x, z), or −1 outside it. */
function pointAt(f: Field, x: number, z: number): number {
  const i = Math.round((x - f.x0) / f.step);
  const j = Math.round((z - f.z0) / f.step);
  if (i < 0 || j < 0 || i >= f.n || j >= f.n) return -1;
  return j * f.n + i;
}

/** The ground of the field at (x, z), bilinear between its points. */
function groundAt(f: Field, x: number, z: number): number {
  const u = Math.min(f.n - 1.000001, Math.max(0, (x - f.x0) / f.step));
  const v = Math.min(f.n - 1.000001, Math.max(0, (z - f.z0) / f.step));
  const i = Math.floor(u);
  const j = Math.floor(v);
  const s = u - i;
  const t = v - j;
  const k = j * f.n + i;
  const g = f.ground;
  return (g[k]! * (1 - s) + g[k + 1]! * s) * (1 - t) + (g[k + f.n]! * (1 - s) + g[k + f.n + 1]! * s) * t;
}

/** Cost of the straight way between a place and a node, over the field's points nearest to it. */
function tailCost(g: Ground, px: number, pz: number, u: number): number {
  const f = g.f;
  const nn = g.nn;
  const I = u % nn;
  const J = (u - I) / nn;
  const nx = f.x0 + I * NODE_PER * f.step;
  const nz = f.z0 + J * NODE_PER * f.step;
  const len = Math.hypot(nx - px, nz - pz);
  const steps = Math.max(1, Math.ceil(len / f.step));
  for (let s = 0; s <= steps; s++) {
    const k = pointAt(f, px + ((nx - px) * s) / steps, pz + ((nz - pz) * s) / steps);
    if (k < 0) return Infinity;
    walkPoints[s] = k;
  }
  const noise = bendNoise(g, Math.round((px - f.x0) / ((f.step * NODE_PER) / 2)), Math.round((pz - f.z0) / ((f.step * NODE_PER) / 2)));
  const c = walkCost(g, steps + 1, Math.max(len / steps, 1e-6), noise);
  return walkGrade > MAX_GRADE ? Infinity : c;
}

/** The nodes within 15 m of a place, with the cost of the way to each (finite ones only). */
function tails(g: Ground, px: number, pz: number): { node: number[]; cost: number[] } {
  const f = g.f;
  const cell = f.step * NODE_PER;
  const ci = Math.round((px - f.x0) / cell);
  const cj = Math.round((pz - f.z0) / cell);
  const node: number[] = [];
  const cost: number[] = [];
  for (let dj = -2; dj <= 2; dj++)
    for (let di = -2; di <= 2; di++) {
      const I = ci + di;
      const J = cj + dj;
      if (I < 0 || J < 0 || I >= g.nn || J >= g.nn) continue;
      if (Math.hypot(f.x0 + I * cell - px, f.z0 + J * cell - pz) > 1.5 * cell) continue;
      const u = J * g.nn + I;
      const c = tailCost(g, px, pz, u);
      if (c < Infinity) {
        node.push(u);
        cost.push(c);
      }
    }
  return { node, cost };
}

/** Cosine of the angle between two moves (16: no move yet, which turns nowhere). */
function turnCos(a: number, b: number): number {
  if (a === 16 || b === 16) return 1;
  return (MI[a]! * MI[b]! + MJ[a]! * MJ[b]!) / (Math.hypot(MI[a]!, MJ[a]!) * Math.hypot(MI[b]!, MJ[b]!));
}

/** The move closest in heading to a direction, or 16 for a direction too short to have one. */
function headingOf(dx: number, dz: number): number {
  const len = Math.hypot(dx, dz);
  if (len < 3) return 16;
  let best = 16;
  let bc = -2;
  for (let m = 0; m < 16; m++) {
    const c = (MI[m]! * dx + MJ[m]! * dz) / (Math.hypot(MI[m]!, MJ[m]!) * len);
    if (c > bc) {
      bc = c;
      best = m;
    }
  }
  return best;
}

/** Per incoming move (16: none) and outgoing move, 1 where the turn between them is allowed (`MAX_TURN_DEG`). */
const TURN_OK = (() => {
  const t = new Uint8Array(17 * 16);
  const limit = Math.cos((MAX_TURN_DEG * Math.PI) / 180) - 1e-9;
  for (let a = 0; a <= 16; a++) for (let b = 0; b < 16; b++) t[a * 16 + b] = turnCos(a, b) >= limit ? 1 : 0;
  return t;
})();

/**
 * The cheapest route that turns by at most `MAX_TURN_DEG` at a node and is nowhere steeper than `limit`, within
 * `CORRIDOR` nodes of a first route: the search runs over pairs of node and the move that reached it. Null when there
 * is none.
 */
function gentle(
  g: Ground,
  first: number[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  start: { node: number[]; cost: number[] },
  endCost: Map<number, number>,
  taken: Uint8Array,
  limit: number,
): number[] | null {
  const nn = g.nn;
  const cell = g.f.step * NODE_PER;
  const inside = new Uint8Array(g.count);
  for (const u of first) {
    const I = u % nn;
    const J = (u - I) / nn;
    for (let b = Math.max(0, J - CORRIDOR); b <= Math.min(nn - 1, J + CORRIDOR); b++) inside.fill(1, b * nn + Math.max(0, I - CORRIDOR), b * nn + Math.min(nn - 1, I + CORRIDOR) + 1);
  }
  const local = new Int32Array(g.count).fill(-1);
  const nodes: number[] = [];
  for (let u = 0; u < g.count; u++)
    if (inside[u]) {
      local[u] = nodes.length;
      nodes.push(u);
    }
  const states = nodes.length * 17;
  const dist = new Float64Array(states).fill(Infinity);
  const prev = new Int32Array(states).fill(-1);
  const done = new Uint8Array(states);
  const heap = new KeyHeap();
  const nodeX = (u: number): number => g.f.x0 + (u % nn) * cell;
  const nodeZ = (u: number): number => g.f.z0 + Math.floor(u / nn) * cell;
  start.node.forEach((u, q) => {
    const lu = local[u]!;
    if (lu < 0) return;
    const s = lu * 17 + headingOf(nodeX(u) - ax, nodeZ(u) - az);
    if (start.cost[q]! < dist[s]!) {
      dist[s] = start.cost[q]!;
      heap.push(dist[s]!, s);
    }
  });
  let best = Infinity;
  let last = -1;
  while (heap.size > 0) {
    const s = heap.pop();
    const d = heap.key;
    if (done[s] || d > dist[s]!) continue;
    if (d >= best) break;
    done[s] = 1;
    const into = s % 17;
    const u = nodes[(s - into) / 17]!;
    const tail = endCost.get(u);
    if (tail !== undefined && d + tail < best && turnCos(into, headingOf(bx - nodeX(u), bz - nodeZ(u))) >= 0) {
      best = d + tail;
      last = s;
    }
    const I = u % nn;
    const J = (u - I) / nn;
    for (let m = 0; m < 16; m++) {
      if (!TURN_OK[into * 16 + m]) continue;
      const i = I + MI[m]!;
      const j = J + MJ[m]!;
      if (i < 0 || j < 0 || i >= nn || j >= nn) continue;
      const v = j * nn + i;
      const lv = local[v]!;
      if (lv < 0) continue;
      const t = lv * 17 + m;
      if (done[t]) continue;
      let c = moveCost(g, u, m, limit);
      if (c === Infinity) continue;
      if (taken[u] && taken[v]) c *= SHARED;
      const nd = d + c;
      if (nd < dist[t]!) {
        dist[t] = nd;
        prev[t] = s;
        heap.push(nd, t);
      }
    }
  }
  if (last < 0) return null;
  const chain: number[] = [];
  for (let s = last; s >= 0; s = prev[s]!) chain.push(nodes[Math.floor(s / 17)]!);
  return chain.reverse();
}

/**
 * The cheapest route from place a to place b over the node grid: the places and the nodes between them, or null
 * when b cannot be reached. A move between two nodes in `taken` costs `SHARED` of its price. The route found first
 * may turn sharply (a switchback up a slope); it is searched again near itself with its turns limited.
 */
function route(g: Ground, ax: number, az: number, bx: number, bz: number, taken: Uint8Array): { x: number[]; z: number[]; node: number[] } | null {
  const start = tails(g, ax, az);
  const end = tails(g, bx, bz);
  if (start.node.length === 0 || end.node.length === 0) return null;
  const endCost = new Map<number, number>();
  end.node.forEach((u, q) => endCost.set(u, end.cost[q]!));
  const dist = new Float64Array(g.count).fill(Infinity);
  const prev = new Int32Array(g.count).fill(-1);
  const done = new Uint8Array(g.count);
  const heap = new KeyHeap();
  start.node.forEach((u, q) => {
    dist[u] = start.cost[q]!;
    heap.push(dist[u]!, u);
  });
  let best = Infinity;
  let last = -1;
  while (heap.size > 0) {
    const u = heap.pop();
    const d = heap.key;
    if (done[u] || d > dist[u]!) continue;
    if (d >= best) break;
    done[u] = 1;
    const tail = endCost.get(u);
    if (tail !== undefined && d + tail < best) {
      best = d + tail;
      last = u;
    }
    const I = u % g.nn;
    const J = (u - I) / g.nn;
    for (let m = 0; m < 16; m++) {
      const v = (J + MJ[m]!) * g.nn + I + MI[m]!;
      if (v < 0 || v >= g.count || done[v]) continue;
      let c = moveCost(g, u, m, MAX_GRADE);
      if (c === Infinity) continue;
      if (taken[u] && taken[v]) c *= SHARED;
      const nd = d + c;
      if (nd < dist[v]!) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  if (last < 0) return null;
  const first: number[] = [];
  for (let u = last; u >= 0; u = prev[u]!) first.push(u);
  first.reverse();
  const chain = gentle(g, first, ax, az, bx, bz, start, endCost, taken, MAX_GRADE) ?? gentle(g, first, ax, az, bx, bz, start, endCost, taken, HAIRPIN_GRADE) ?? first;
  const cell = g.f.step * NODE_PER;
  const x = [ax];
  const z = [az];
  for (const u of chain) {
    x.push(g.f.x0 + (u % g.nn) * cell);
    z.push(g.f.z0 + Math.floor(u / g.nn) * cell);
  }
  x.push(bx);
  z.push(bz);
  return { x, z, node: chain };
}

/** Whether a point of the field is good for a place: see `PLACE_ABOVE_M`. */
function placeFits(g: Ground, x: number, z: number): boolean {
  const f = g.f;
  const i = Math.round((x - f.x0) / f.step);
  const j = Math.round((z - f.z0) / f.step);
  const r = Math.ceil(PLACE_CLEAR_M / f.step);
  if (i < r || j < r || i >= f.n - r || j >= f.n - r) return false;
  const k = j * f.n + i;
  if (g.flag[k]! & (WET | BLOCK)) return false;
  if (f.ground[k]! - f.water[k]! < PLACE_ABOVE_M) return false;
  const gx = (f.ground[k + 1]! - f.ground[k - 1]!) / (2 * f.step);
  const gz = (f.ground[k + f.n]! - f.ground[k - f.n]!) / (2 * f.step);
  if (Math.hypot(gx, gz) >= PLACE_SLOPE) return false;
  const clear = (PLACE_CLEAR_M / f.step) ** 2;
  for (let dj = -r; dj <= r; dj++)
    for (let di = -r; di <= r; di++) if (di * di + dj * dj <= clear && g.flag[k + dj * f.n + di]! & WET) return false;
  return true;
}

/**
 * The point good for a place nearest to (x, z) within `reach` metres, searched on rings of growing radius, each
 * walked from the same angle: the field's point itself, or null.
 */
function placeNear(g: Ground, x: number, z: number, reach: number): { x: number; z: number } | null {
  const f = g.f;
  for (let r = 0; r <= reach; r += f.step) {
    const count = Math.max(1, Math.ceil((2 * Math.PI * r) / f.step));
    for (let q = 0; q < count; q++) {
      const a = (2 * Math.PI * q) / count;
      const px = f.x0 + Math.round((x + r * Math.cos(a) - f.x0) / f.step) * f.step;
      const pz = f.z0 + Math.round((z + r * Math.sin(a) - f.z0) / f.step) * f.step;
      if (placeFits(g, px, pz)) return { x: px, z: pz };
    }
  }
  return null;
}

/** Unit direction of a line's valley around station `i`, and its normal to the left. */
function across(l: Line, i: number): { dx: number; dz: number; nx: number; nz: number } {
  const a = Math.max(0, i - 4);
  const b = Math.min(l.n - 1, i + 4);
  const dx = l.ax[b]! - l.ax[a]!;
  const dz = l.az[b]! - l.az[a]!;
  const d = Math.hypot(dx, dz) || 1;
  return { dx: dx / d, dz: dz / d, nx: -dz / d, nz: dx / d };
}

/** A place beside a line's mouth: 110 m across the valley from the station 14 before its end, left side first. */
function besideMouth(g: Ground, l: Line): { x: number; z: number; side: number } | null {
  const i = Math.max(0, l.n - 15);
  const c = across(l, i);
  for (const side of [1, -1]) {
    const p = placeNear(g, l.ax[i]! + side * 110 * c.nx, l.az[i]! + side * 110 * c.nz, 50);
    if (p) return { ...p, side };
  }
  return null;
}

/** The places of a plan, by name, in the order `mouth`, `bends`, `fall`, `lake`, `shore`; a missing one is left out. */
function placesOf(plan: Plan, g: Ground): Place[] {
  const out: Place[] = [];
  const main = plan.lines[0];
  if (!main) return out;
  const mouth = besideMouth(g, main);
  if (mouth) out.push({ name: 'mouth', x: mouth.x, z: mouth.z });
  // Across the valley from the widest swing, on the side of the mouth's place if it can be.
  const mi = widestSwing(main);
  const mc = across(main, mi);
  const side = mouth?.side ?? 1;
  let bends: { x: number; z: number } | null = null;
  for (const s of [side, -side]) {
    const d = main.floor[mi]! + 25;
    bends = placeNear(g, main.ax[mi]! + s * d * mc.nx, main.az[mi]! + s * d * mc.nz, 30);
    if (bends) break;
  }
  if (bends) out.push({ name: 'bends', x: bends.x, z: bends.z });
  // Below the highest fall: 25 m down the channel from its foot and aside of the floor, toward the bends if it can be.
  const top = highestFall(plan);
  if (top) {
    const l = top.line;
    let k = top.i + 1;
    let run = 0;
    while (k + 1 < l.n && run < 25) {
      run += Math.hypot(l.cx[k + 1]! - l.cx[k]!, l.cz[k + 1]! - l.cz[k]!);
      k++;
    }
    const c = across(l, k);
    const d = l.floor[k]! + 12;
    const toward = bends ? Math.sign((bends.x - l.cx[k]!) * c.nx + (bends.z - l.cz[k]!) * c.nz) || 1 : 1;
    for (const s of [toward, -toward]) {
      const p = placeNear(g, l.cx[k]! + s * d * c.nx, l.cz[k]! + s * d * c.nz, 25);
      if (p) {
        out.push({ name: 'fall', x: p.x, z: p.z });
        break;
      }
    }
  }
  // On the shore of the largest lake: from its middle toward the bends, the first good point.
  let lake = -1;
  plan.lakes.forEach((k, id) => {
    if (lake < 0 || k.nodes > plan.lakes[lake]!.nodes) lake = id;
  });
  if (lake >= 0) {
    const k = plan.lakes[lake]!;
    const tx = bends ? bends.x : mouth ? mouth.x : 0;
    const tz = bends ? bends.z : mouth ? mouth.z : 0;
    const d = Math.hypot(tx - k.x, tz - k.z) || 1;
    for (let r = 0; r < Math.min(800, d); r += g.f.step) {
      const px = g.f.x0 + Math.round((k.x + ((tx - k.x) * r) / d - g.f.x0) / g.f.step) * g.f.step;
      const pz = g.f.z0 + Math.round((k.z + ((tz - k.z) * r) / d - g.f.z0) / g.f.step) * g.f.step;
      if (placeFits(g, px, pz)) {
        out.push({ name: 'lake', x: px, z: pz });
        break;
      }
    }
  }
  // Beside the mouth of the largest other line that reaches the sea far from the main mouth (no arm of its delta).
  const mx = main.ax[main.n - 1]!;
  const mz = main.az[main.n - 1]!;
  let shore = -1;
  plan.lines.forEach((l, id) => {
    if (id === 0 || l.into !== -1) return;
    if (Math.hypot(l.ax[0]! - mx, l.az[0]! - mz) <= 400) return;
    if (Math.hypot(l.ax[l.n - 1]! - mx, l.az[l.n - 1]! - mz) < 900) return;
    if (shore < 0 || l.flow > plan.lines[shore]!.flow) shore = id;
  });
  if (shore >= 0) {
    const p = besideMouth(g, plan.lines[shore]!);
    if (p) out.push({ name: 'shore', x: p.x, z: p.z });
  }
  return out;
}

/** Rounds of averaging of the points of a broken line that are not held, with their neighbours. */
function relaxHeld(x: Float64Array, z: Float64Array, held: Uint8Array, rounds: number): void {
  const n = x.length;
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  for (let r = 0; r < rounds; r++) {
    tx.set(x);
    tz.set(z);
    for (let i = 1; i < n - 1; i++) {
      if (held[i]) continue;
      x[i] = 0.25 * tx[i - 1]! + 0.5 * tx[i]! + 0.25 * tx[i + 1]!;
      z[i] = 0.25 * tz[i - 1]! + 0.5 * tz[i]! + 0.25 * tz[i + 1]!;
    }
  }
}

/** Points at equal steps of about `PATH_STATION_M` along a broken line, both ends kept. */
function evenly(x: Float64Array, z: Float64Array): { x: Float64Array; z: Float64Array } {
  const n = x.length;
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) at[i] = at[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, z[i]! - z[i - 1]!);
  const total = at[n - 1]!;
  const m = Math.max(1, Math.round(total / PATH_STATION_M));
  const ox = new Float64Array(m + 1);
  const oz = new Float64Array(m + 1);
  let s = 0;
  for (let q = 0; q <= m; q++) {
    const want = (total * q) / m;
    while (s + 2 < n && at[s + 1]! < want) s++;
    const len = at[s + 1]! - at[s]!;
    const t = len > 0 ? Math.min(1, Math.max(0, (want - at[s]!) / len)) : 0;
    ox[q] = x[s]! + (x[s + 1]! - x[s]!) * t;
    oz[q] = z[s]! + (z[s + 1]! - z[s]!) * t;
  }
  ox[0] = x[0]!;
  oz[0] = z[0]!;
  ox[m] = x[n - 1]!;
  oz[m] = z[n - 1]!;
  return { x: ox, z: oz };
}

/** Lays the points a … b of a line straight, unless the straight line would touch standing water. */
function straighten(g: Ground, x: Float64Array, z: Float64Array, a: number, b: number): void {
  const ax = x[a]!;
  const az = z[a]!;
  const dx = x[b]! - ax;
  const dz = z[b]! - az;
  for (let q = a; q <= b; q++) {
    const k = pointAt(g.f, ax + (dx * (q - a)) / Math.max(1, b - a), az + (dz * (q - a)) / Math.max(1, b - a));
    if (k < 0 || g.flag[k]! & STAND) return;
  }
  for (let q = a; q <= b; q++) {
    x[q] = ax + (dx * (q - a)) / Math.max(1, b - a);
    z[q] = az + (dz * (q - a)) / Math.max(1, b - a);
  }
}

/**
 * The stations of a stretch of route given as a broken line: rounded, straight across the water of a line, and pulled
 * back toward the route wherever the rounding would put it into water the route did not enter.
 */
function stationsOf(g: Ground, vx: number[], vz: number[]): { x: Float64Array; z: Float64Array } {
  const f = g.f;
  const dense = resample(vx, vz, new Float64Array(vx.length), PATH_STATION_M);
  const n = dense.x.length;
  const wetAt = (x: number, z: number): boolean => {
    const k = pointAt(f, x, z);
    return k >= 0 && (g.flag[k]! & WET) !== 0;
  };
  // The crossings: runs of wet points of the route, joined where they nearly meet, widened by `STRAIGHT`.
  const crossings: [number, number][] = [];
  const allowed = new Uint8Array(n);
  for (let i = 0; i < n; ) {
    if (!wetAt(dense.x[i]!, dense.z[i]!)) {
      i++;
      continue;
    }
    let e = i;
    for (;;) {
      while (e + 1 < n && wetAt(dense.x[e + 1]!, dense.z[e + 1]!)) e++;
      let next = e + 1;
      while (next < n && !wetAt(dense.x[next]!, dense.z[next]!)) next++;
      if (next < n && next - e <= 2 * STRAIGHT + 1) e = next;
      else break;
    }
    const a = Math.max(0, i - STRAIGHT);
    const b = Math.min(n - 1, e + STRAIGHT);
    crossings.push([a, b]);
    allowed.fill(1, a, b + 1);
    i = e + 1;
  }
  // The route itself, straight across its crossings: what the rounded line is pulled back to.
  const lx = Float64Array.from(dense.x);
  const lz = Float64Array.from(dense.z);
  for (const [a, b] of crossings) straighten(g, lx, lz, a, b);
  // Rounded as a whole first, then laid straight across each crossing and rounded again with the crossings held,
  // so a crossing follows the heading of the rounded line and meets it without a kink.
  const sx = Float64Array.from(dense.x);
  const sz = Float64Array.from(dense.z);
  const held = new Uint8Array(n);
  held[0] = 1;
  held[n - 1] = 1;
  relaxHeld(sx, sz, held, ROUNDING);
  for (const [a, b] of crossings) {
    straighten(g, sx, sz, a, b);
    held.fill(1, a, b + 1);
  }
  relaxHeld(sx, sz, held, ROUNDING / 4);
  // A walked line is never ruled. Where the ground is gentle it wanders to either side in two long waves; it runs
  // true into its ends and its crossings, and on a slope it keeps to the grade the route found.
  const wave = (t: number, key: number): number => {
    const i = Math.floor(t);
    const u = t - i;
    const a = hashInts(key, i) / 4294967296;
    const b = hashInts(key, i + 1) / 4294967296;
    return (a + (b - a) * u * u * (3 - 2 * u) - 0.5) * 2;
  };
  const key = hashInts(Math.round(vx[0]! * 8), Math.round(vz[0]! * 8), n);
  const wx = Float64Array.from(sx);
  const wz = Float64Array.from(sz);
  for (let i = 1; i < n - 1; i++) {
    if (held[i]) continue;
    let room = Math.min(i, n - 1 - i);
    for (const [a, b] of crossings) room = Math.min(room, i < a ? a - i : i > b ? i - b : 0);
    const ease = Math.min(1, (room * PATH_STATION_M) / WANDER_EASE_M);
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    const run = Math.hypot(sx[b]! - sx[a]!, sz[b]! - sz[a]!) || 1;
    const grade = Math.abs(groundAt(f, sx[b]!, sz[b]!) - groundAt(f, sx[a]!, sz[a]!)) / run;
    const calm = 1 - Math.min(1, Math.max(0, (grade - 0.06) / 0.1));
    const s = i * PATH_STATION_M;
    const off = ease * ease * (3 - 2 * ease) * calm * WANDER_M * (wave(s / 74, key) + 0.45 * wave(s / 23, key + 1));
    wx[i] = sx[i]! - ((sz[b]! - sz[a]!) / run) * off;
    wz[i] = sz[i]! + ((sx[b]! - sx[a]!) / run) * off;
  }
  sx.set(wx);
  sz.set(wz);
  relaxHeld(sx, sz, held, 2);
  // Where the rounded line enters water the route kept out of, it is pulled back to the route there, easing out
  // over a few points either side.
  const w = new Float64Array(n).fill(1);
  const bx = new Float64Array(n);
  const bz = new Float64Array(n);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < n; i++) {
      bx[i] = lx[i]! + (sx[i]! - lx[i]!) * w[i]!;
      bz[i] = lz[i]! + (sz[i]! - lz[i]!) * w[i]!;
    }
    let bad = false;
    for (let i = 0; i < n; i++) {
      if (allowed[i] || w[i] === 0 || !wetAt(bx[i]!, bz[i]!)) continue;
      bad = true;
      for (let q = Math.max(0, i - 6); q <= Math.min(n - 1, i + 6); q++) w[q] = Math.min(w[q]!, Math.abs(q - i) / 6);
    }
    if (!bad) break;
  }
  return evenly(bx, bz);
}

/** A path from its stations: fords and the height of the tread. */
function pathOf(f: Field, flag: Uint8Array, from: number, to: number, x: Float64Array, z: Float64Array): Path {
  const n = x.length;
  const ford = new Uint8Array(n);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = pointAt(f, x[i]!, z[i]!);
    ford[i] = k >= 0 && flag[k]! & LINE ? 1 : 0;
    raw[i] = groundAt(f, x[i]!, z[i]!);
  }
  const y = average(raw, 3);
  for (let i = 0; i < n; i++) {
    let near = false;
    for (let q = Math.max(0, i - 2); q <= Math.min(n - 1, i + 2); q++) near ||= ford[q] === 1;
    if (near) y[i] = raw[i]!;
  }
  return { from, to, n, x, z, y, ford };
}

/** The nearest station of the paths to a point: its path, station and distance. */
function nearestStation(paths: Path[], x: number, z: number): { p: number; i: number; d: number } {
  let best = Infinity;
  let bp = -1;
  let bi = 0;
  paths.forEach((p, id) => {
    for (let i = 0; i < p.n; i++) {
      const d = (p.x[i]! - x) ** 2 + (p.z[i]! - z) ** 2;
      if (d < best) {
        best = d;
        bp = id;
        bi = i;
      }
    }
  });
  return { p: bp, i: bi, d: Math.sqrt(best) };
}

/** The distance from a point to the nearest centreline of the paths. */
function nearestLine(paths: Path[], x: number, z: number): number {
  let best = Infinity;
  for (const p of paths)
    for (let i = 0; i + 1 < p.n; i++) {
      const dx = p.x[i + 1]! - p.x[i]!;
      const dz = p.z[i + 1]! - p.z[i]!;
      const t = Math.min(1, Math.max(0, ((x - p.x[i]!) * dx + (z - p.z[i]!) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, (p.x[i]! + dx * t - x) ** 2 + (p.z[i]! + dz * t - z) ** 2);
    }
  return Math.sqrt(best);
}

/** Where the stretch a–b crosses a centreline of the paths first, as a share along a–b, or −1. */
function crossing(paths: Path[], ax: number, az: number, bx: number, bz: number): number {
  let first = -1;
  const ux = bx - ax;
  const uz = bz - az;
  for (const p of paths)
    for (let i = 0; i + 1 < p.n; i++) {
      const vx = p.x[i + 1]! - p.x[i]!;
      const vz = p.z[i + 1]! - p.z[i]!;
      const den = ux * vz - uz * vx;
      if (den === 0) continue;
      const wx = p.x[i]! - ax;
      const wz = p.z[i]! - az;
      const s = (wx * vz - wz * vx) / den;
      const t = (wx * uz - wz * ux) / den;
      if (s >= 0 && s <= 1 && t >= 0 && t <= 1 && (first < 0 || s < first)) first = s;
    }
  return first;
}

/** The paths of a plan: a pure function of the plan and of the field of its whole square at 2.5 m. */
export function pathPlan(plan: Plan, f: Field): PathPlan {
  const g = groundOf(plan, f);
  const places = placesOf(plan, g);
  const paths: Path[] = [];
  const named = (name: string): number => places.findIndex((p) => p.name === name);
  const legs: [number, number][] = [];
  const mouth = named('mouth');
  const bends = named('bends');
  const fall = named('fall');
  const lake = named('lake');
  const shore = named('shore');
  legs.push([mouth, bends], [bends, fall], [fall >= 0 ? fall : bends, lake], [bends, shore]);
  const taken = new Uint8Array(g.count);
  const junctions = new Map<number, number>();
  // The place at a station of an earlier path: an end's own place or a junction.
  const snap = (s: { p: number; i: number }): number => {
    const p = paths[s.p]!;
    if (s.i === 0) return p.from;
    if (s.i === p.n - 1) return p.to;
    const key = s.p * 65536 + s.i;
    let id = junctions.get(key);
    if (id === undefined) {
      id = places.length;
      places.push({ name: 'junction', x: p.x[s.i]!, z: p.z[s.i]! });
      junctions.set(key, id);
    }
    return id;
  };
  for (const [a, b] of legs) {
    if (a < 0 || b < 0) continue;
    const pa = places[a]!;
    const pb = places[b]!;
    const r = route(g, pa.x, pa.z, pb.x, pb.z, taken);
    if (!r) continue;
    // Which points of the route lie on earlier paths; a stretch that crosses one gets the crossing as a point.
    const vx: number[] = [];
    const vz: number[] = [];
    const on: boolean[] = [];
    const last = r.x.length - 1;
    for (let q = 0; q <= last; q++) {
      const node = q > 0 && q < last ? r.node[q - 1]! : -1;
      const here = paths.length > 0 && ((node >= 0 && taken[node] === 1) || nearestLine(paths, r.x[q]!, r.z[q]!) < ON_PATH_M);
      if (q > 0 && !here && !on[on.length - 1] && paths.length > 0) {
        const s = crossing(paths, vx[vx.length - 1]!, vz[vz.length - 1]!, r.x[q]!, r.z[q]!);
        if (s >= 0) {
          vx.push(vx[vx.length - 1]! + (r.x[q]! - vx[vx.length - 1]!) * s);
          vz.push(vz[vz.length - 1]! + (r.z[q]! - vz[vz.length - 1]!) * s);
          on.push(true);
        }
      }
      vx.push(r.x[q]!);
      vz.push(r.z[q]!);
      on.push(here);
    }
    // Each run of points off the earlier paths, with the point on a path before and after it, is a new path.
    const laid: Path[] = [];
    for (let q = 0; q < vx.length; ) {
      if (on[q]) {
        q++;
        continue;
      }
      let e = q;
      while (e + 1 < vx.length && !on[e + 1]) e++;
      const s0 = q > 0 ? q - 1 : q;
      const s1 = e < vx.length - 1 ? e + 1 : e;
      const px = vx.slice(s0, s1 + 1);
      const pz = vz.slice(s0, s1 + 1);
      const head = s0 < q ? nearestStation(paths, px[0]!, pz[0]!) : null;
      const foot = s1 > e ? nearestStation(paths, px[px.length - 1]!, pz[pz.length - 1]!) : null;
      q = e + 1;
      if (head) {
        px[0] = paths[head.p]!.x[head.i]!;
        pz[0] = paths[head.p]!.z[head.i]!;
      }
      if (foot) {
        px[px.length - 1] = paths[foot.p]!.x[foot.i]!;
        pz[pz.length - 1] = paths[foot.p]!.z[foot.i]!;
      }
      let len = 0;
      for (let i = 1; i < px.length; i++) len += Math.hypot(px[i]! - px[i - 1]!, pz[i]! - pz[i - 1]!);
      if (len < MIN_PATH_M) continue;
      // A detour that leaves a path and comes back to it soon is no path of its own: the path is already there.
      if (head && foot && head.p === foot.p && Math.abs(head.i - foot.i) * PATH_STATION_M <= DETOUR * len + MIN_PATH_M) continue;
      const from = head ? snap(head) : a;
      const to = foot ? snap(foot) : b;
      if (from === to) continue;
      const st = stationsOf(g, px, pz);
      const path = pathOf(f, g.flag, from, to, st.x, st.z);
      // At a junction the tread meets the one of the path it leaves.
      const meet = (end: number, step: number, place: number): void => {
        const s = nearestStation(paths, places[place]!.x, places[place]!.z);
        if (s.p < 0 || s.d > 1e-6) return;
        const want = paths[s.p]!.y[s.i]!;
        const off = want - path.y[end]!;
        for (let k = 0; k < 4 && end + k * step >= 0 && end + k * step < path.n; k++) path.y[end + k * step]! += off * (1 - k / 4);
      };
      if (paths.length > 0) {
        meet(0, 1, from);
        meet(path.n - 1, -1, to);
      }
      laid.push(path);
    }
    paths.push(...laid);
    for (const u of r.node) taken[u] = 1;
  }
  const { bucketStart, segs } = bucketsOf(paths);
  return { places, paths, bucketStart, segs, side: sidesOf(paths, bucketStart, segs) };
}

/**
 * The side of every path (`PathPlan.side`): paths are joined when one comes within `PATH_REACH_M` of the other, and
 * the sides alternate along those joins from the first path on. Paths fork from one another like a tree, so the two
 * ends of a join nearly always differ; where three paths all come near each other two of them share a side.
 */
function sidesOf(paths: Path[], bucketStart: Uint32Array, segs: Uint32Array): Uint8Array {
  const n = paths.length;
  const near = new Uint8Array(n * n);
  paths.forEach((p, id) => {
    for (let i = 0; i < p.n; i++) {
      const x = p.x[i]!;
      const z = p.z[i]!;
      const bx = Math.floor((x + HALF_M) / BUCKET_M);
      const bz = Math.floor((z + HALF_M) / BUCKET_M);
      if (bx < 0 || bz < 0 || bx >= BUCKET_N || bz >= BUCKET_N) continue;
      const b = bz * BUCKET_N + bx;
      for (let k = bucketStart[b]!; k < bucketStart[b + 1]!; k++) {
        const e = segs[k]!;
        const other = e >>> 16;
        if (other === id || near[id * n + other]) continue;
        const q = paths[other]!;
        const j = e & 0xffff;
        const dx = q.x[j + 1]! - q.x[j]!;
        const dz = q.z[j + 1]! - q.z[j]!;
        const t = Math.min(1, Math.max(0, ((x - q.x[j]!) * dx + (z - q.z[j]!) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(q.x[j]! + dx * t - x, q.z[j]! + dz * t - z) >= PATH_REACH_M) continue;
        near[id * n + other] = 1;
        near[other * n + id] = 1;
      }
    }
  });
  const NONE = 2;
  const side = new Uint8Array(n).fill(NONE);
  for (let first = 0; first < n; first++) {
    if (side[first] !== NONE) continue;
    side[first] = 0;
    const queue = [first];
    for (let at = 0; at < queue.length; at++) {
      const u = queue[at]!;
      for (let v = 0; v < n; v++) {
        if (!near[u * n + v] || side[v] !== NONE) continue;
        side[v] = 1 - side[u]!;
        queue.push(v);
      }
    }
  }
  return side;
}

/** The bucket index: every stretch of every path listed in each bucket its reach touches. */
function bucketsOf(paths: Path[]): { bucketStart: Uint32Array; segs: Uint32Array } {
  const count = new Uint32Array(BUCKET_N * BUCKET_N + 1);
  const each = (fn: (b: number, entry: number) => void): void => {
    paths.forEach((p, id) => {
      for (let i = 0; i + 1 < p.n; i++) {
        const lo = (v: number): number => Math.max(0, Math.floor((v - PATH_REACH_M + HALF_M) / BUCKET_M));
        const hi = (v: number): number => Math.min(BUCKET_N - 1, Math.floor((v + PATH_REACH_M + HALF_M) / BUCKET_M));
        const x0 = lo(Math.min(p.x[i]!, p.x[i + 1]!));
        const x1 = hi(Math.max(p.x[i]!, p.x[i + 1]!));
        const z0 = lo(Math.min(p.z[i]!, p.z[i + 1]!));
        const z1 = hi(Math.max(p.z[i]!, p.z[i + 1]!));
        for (let bz = z0; bz <= z1; bz++) for (let bx = x0; bx <= x1; bx++) fn(bz * BUCKET_N + bx, (id << 16) | i);
      }
    });
  };
  each((b) => count[b + 1]!++);
  for (let b = 0; b < BUCKET_N * BUCKET_N; b++) count[b + 1]! += count[b]!;
  const segs = new Uint32Array(count[BUCKET_N * BUCKET_N]!);
  const fill = count.slice();
  each((b, entry) => {
    segs[fill[b]!++] = entry;
  });
  return { bucketStart: count, segs };
}

/**
 * The nearest centreline within `PATH_REACH_M` of a point into `out`; false when there is none. With a `side` only
 * the paths of that side (`PathPlan.side`) are looked at.
 */
export function pathAt(pp: PathPlan, x: number, z: number, out: PathHit, side = -1): boolean {
  const bx = Math.floor((x + HALF_M) / BUCKET_M);
  const bz = Math.floor((z + HALF_M) / BUCKET_M);
  if (bx < 0 || bz < 0 || bx >= BUCKET_N || bz >= BUCKET_N) return false;
  const b = bz * BUCKET_N + bx;
  const end = pp.bucketStart[b + 1]!;
  let k = pp.bucketStart[b]!;
  if (k === end) return false;
  let best = PATH_REACH_M * PATH_REACH_M;
  let found = false;
  let bp = 0;
  let bi = 0;
  let bt = 0;
  for (; k < end; k++) {
    const e = pp.segs[k]!;
    if (side >= 0 && pp.side[e >>> 16] !== side) continue;
    const p = pp.paths[e >>> 16]!;
    const i = e & 0xffff;
    const ax = p.x[i]!;
    const az = p.z[i]!;
    const dx = p.x[i + 1]! - ax;
    const dz = p.z[i + 1]! - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const ex = ax + dx * t - x;
    const ez = az + dz * t - z;
    const d = ex * ex + ez * ez;
    if (d < best || (!found && d === best)) {
      best = d;
      found = true;
      bp = e >>> 16;
      bi = i;
      bt = t;
    }
  }
  if (!found) return false;
  const p = pp.paths[bp]!;
  const dx = p.x[bi + 1]! - p.x[bi]!;
  const dz = p.z[bi + 1]! - p.z[bi]!;
  out.ox = p.x[bi]! + dx * bt - x;
  out.oz = p.z[bi]! + dz * bt - z;
  out.d = Math.sqrt(best);
  out.y = p.y[bi]! + (p.y[bi + 1]! - p.y[bi]!) * bt;
  out.ford = p.ford[bi]! + (p.ford[bi + 1]! - p.ford[bi]!) * bt;
  out.path = bp;
  out.i = bi;
  out.t = bt;
  return true;
}

/** Numbers for the checks: per path its length (m), steepest grade over 10 m, number of fords and the widest ford (m). */
export function pathStats(pp: PathPlan): { from: string; to: string; lengthM: number; maxGrade: number; fords: number; widestFordM: number }[] {
  return pp.paths.map((p) => {
    let lengthM = 0;
    for (let i = 0; i + 1 < p.n; i++) lengthM += Math.hypot(p.x[i + 1]! - p.x[i]!, p.z[i + 1]! - p.z[i]!);
    const span = Math.min(p.n - 1, Math.round(10 / PATH_STATION_M));
    let maxGrade = 0;
    for (let i = 0; i + span < p.n; i++) {
      let run = 0;
      for (let k = i; k < i + span; k++) run += Math.hypot(p.x[k + 1]! - p.x[k]!, p.z[k + 1]! - p.z[k]!);
      if (run > 0) maxGrade = Math.max(maxGrade, Math.abs(p.y[i + span]! - p.y[i]!) / run);
    }
    let fords = 0;
    let widest = 0;
    for (let i = 0; i < p.n; ) {
      if (!p.ford[i]) {
        i++;
        continue;
      }
      let e = i;
      while (e + 1 < p.n && p.ford[e + 1]) e++;
      fords++;
      widest = Math.max(widest, (e - i + 1) * PATH_STATION_M);
      i = e + 1;
    }
    return { from: pp.places[p.from]!.name, to: pp.places[p.to]!.name, lengthM, maxGrade, fords, widestFordM: widest };
  });
}
