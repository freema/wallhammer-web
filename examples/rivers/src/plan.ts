// The plan of the water: where it stands and where it runs, a pure function of the seed, computed once.
//
// The rule the whole example rests on: water is never drawn onto the ground. The plan gives a level of water along
// every line, the ground is only ever cut down to it (ground.ts), and water is wherever the ground lies under the
// level, exactly as in the sea. So a stream cannot be raised over its banks and cannot run uphill.
//
//   1. Heights of the natural ground on a coarse grid, hollows filled from the sea inward, every node draining to a
//      neighbour, the flow summed downstream. Filled hollows that are large and deep enough are lakes: the shore
//      of each is found on a finer grid, its level is the highest that leaves a narrow shore, and that shore is
//      cut a little steeper (`lakeGround`). A lake that a line would reach from under its level is lowered to
//      that line, or is no lake at all when too little of it is left.
//   2. Lines: the nodes with enough flow, as chains from spring to mouth; a tributary ends on its parent.
//   3. The middle of the valley: the chain smoothed and slid sideways into the lowest ground beside it, measured on
//      the real ground and not on the grid. The grid only says roughly where the valley is.
//   4. The channel. Where the ground is nearly level it winds: its heading swings as a sine along its own length,
//      which is the shape river bends have, as far as the level ground beside the line allows. Where it is steep
//      the channel is straight.
//   5. The level, station by station along the channel: the lowest natural ground across the whole floor, made to
//      fall from spring to mouth, to stand at the level of every lake it runs through and to arrive at the level
//      of what it joins. Water may run down a slope only so steeply; a steeper stretch becomes stairs: treads cut
//      into the slope, each beginning under a fall. The courses of all lines are laid first and the levels after:
//      a line whose valley lies lower than the line it joins lowers that line, so its water is not backed up.

import { hashInts, valueNoise3 } from 'wallhammer-web/gen-core';
import { HALF_M, SIZE_M, naturalHeight, smooth } from './land.ts';

/** Spacing of the plan's grid, metres. */
export const GRID_M = 20;
export const GRID_N = SIZE_M / GRID_M + 1;
/** A node carries a line from this many nodes of basin on. */
export const MIN_FLOW = 220;
/** A filled hollow is a lake from this many nodes and this depth on; smaller ones are cut through. */
const MIN_LAKE_NODES = 10;
const MIN_LAKE_DEPTH_M = 1.5;
/** The lake stands at least this far under its rim, metres. */
const LAKE_FREEBOARD_M = 0.4;
/** Spacing of the fine grid a lake's rim and shore are found on, metres: a quarter of the plan's. */
export const FINE_M = 5;
const FINE_PER = GRID_M / FINE_M;
export const FINE_N = (GRID_N - 1) * FINE_PER + 1;
/** A lake covers at least this much, square metres. */
const MIN_LAKE_M2 = 3000;
/**
 * The shore of a lake is cut: ground that lies naturally less than `SHORE_CUT_M` over the lake's level is lowered,
 * `SHORE_STEEP` times as steeply as it rises and by `SHORE_DEEPER_M` at most. So a lake on nearly level ground has a
 * bed and a bank, and is no film over a flat.
 */
const SHORE_CUT_M = 0.25;
const SHORE_STEEP = 8;
const SHORE_DEEPER_M = 0.8;
/**
 * A level is taken for a lake only where its shore, the cut ground from `SHORE_UNDER_M` under the level to
 * `SHORE_OVER_M` over it, is on average no wider than `SHORE_WIDTH_M`.
 */
const SHORE_UNDER_M = 0.15;
const SHORE_OVER_M = 0.2;
const SHORE_WIDTH_M = 9;
/** How many times the plan is built at most while lakes are lowered to the lines that reach them. */
const LAKE_PASSES = 4;
/** A pool of a lake smaller than this many fine points and shallower than this is left dry. */
const MIN_POOL_POINTS = 12;
const MIN_POOL_DEPTH_M = 0.3;
/** A chain shorter than this many nodes is no line. */
const MIN_LINE_NODES = 6;
/** Spacing of the stations of a line, metres. */
export const STATION_M = 6;
/** The level lies this far under the lowest natural ground across the floor. */
const FREE_M = 0.25;
/** Stations a line runs on into the sea. */
const RUN_OUT = 10;
/** The floor reaches this far beyond the channel's swing and bank, metres. */
const FLOOR_MARGIN_M = 3.5;
/** The channel winds below the second grade and is straight above the first. */
const STRAIGHT_GRADE = 0.04;
const WINDING_GRADE = 0.015;
/** Largest swing of the channel's heading, radians, and the length of one bend in channel widths. */
const MAX_SWING = 1.3;
const BEND_WIDTHS = 11;
/** A line that reaches the sea with at least this basin splits into branches before the coast. */
const DELTA_FLOW = 700;
/** The level runs as stairs where it falls more steeply than the first; a tread of the stairs falls by the second. */
const STAIR_GRADE = 0.25;
const TREAD_GRADE = 0.1;
/** How far past the last node of a pool the lake's sill is looked for, stations. */
const SILL_STATIONS = 6;
/** How far beyond the floor the ground still decides the level, metres. */
const SIDE_M = 5;
/** Depth of the bed a line keeps across a lake, metres. */
const LAKE_BED_M = 0.4;
/**
 * A line that would arrive under the level of the line it joins lowers that line to its own: by `JOIN_CUT_M` at most,
 * the cut easing in upstream of the meeting at `JOIN_GRADE`.
 */
const JOIN_CUT_M = 2.5;
const JOIN_GRADE = 0.03;
/** How far the middle of a line wanders to either side on level ground, metres. */
const WANDER_M = 16;

/** One line of running water, spring to mouth. Arrays of one entry per station; the stations follow the channel. */
export interface Line {
  n: number;
  /** The channel's middle. */
  cx: Float64Array;
  cz: Float64Array;
  /** The point of the valley's middle the station lies across from. */
  ax: Float64Array;
  az: Float64Array;
  /** Level of the water, metres. Never rises along the line. */
  level: Float64Array;
  /** The level the valley's walls stand on: the level, but easing down after a fall instead of stepping. */
  rim: Float64Array;
  /** Half-width and depth of the channel, half-width of the floor. */
  half: Float64Array;
  depth: Float64Array;
  floor: Float64Array;
  /** 1 where the level steps down between this station and the next. */
  fall: Uint8Array;
  /** Lowest natural ground across the floor, for the profile picture. */
  natural: Float64Array;
  /** 1 where the station lies in standing water (a lake or the sea). */
  standing: Uint8Array;
  /** The line this one ends on, −1 for the sea. */
  into: number;
  /** Basin of the last station before the mouth, in nodes. */
  flow: number;
}

export interface Lake {
  level: number;
  /** Its water in nodes of the plan's grid (`GRID_M` squared each). */
  nodes: number;
  /** The middle of its largest pool, metres. */
  x: number;
  z: number;
}

export interface Plan {
  seed: number;
  /** Per point of the fine grid (`FINE_N` a side, every `FINE_M`): 0, or 1 + the lake whose water and shore lie there. */
  lakeFine: Uint16Array;
  /** Per node of the grid: 0, or 1 + the lake whose hollow the node lies in (its water and the dry rim round it). */
  hollowOf: Uint16Array;
  lakes: Lake[];
  lines: Line[];
  /** Buckets of `BUCKET_M`: per bucket + 1 its first entry in `segs`; an entry is line · 65536 + station. */
  bucketStart: Uint32Array;
  segs: Uint32Array;
  /**
   * The drainage of the grid (`GRID_N` nodes a side, every `GRID_M`), as the engine's `traceChannels` reads one: per
   * node the node it drains to (−1 in the sea and on the square's edge), the basin in nodes, and all nodes upstream
   * first. The lines are drawn from it; so are the brooks (brooks.ts).
   */
  drain: { to: Int32Array; flow: Float32Array; order: Uint32Array };
}

export const BUCKET_M = 40;
export const BUCKET_N = SIZE_M / BUCKET_M;
/** How far from a floor's edge the ground may still be cut, metres. */
export const WALL_REACH_M = 60;

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];

/** A heap of nodes ordered by (key, node index): the same order on every runtime. */
export class NodeHeap {
  private readonly items: number[] = [];
  private readonly key: Float64Array;
  constructor(key: Float64Array) {
    this.key = key;
  }
  get size(): number {
    return this.items.length;
  }
  private less(a: number, b: number): boolean {
    return this.key[a]! < this.key[b]! || (this.key[a] === this.key[b] && a < b);
  }
  push(v: number): void {
    const it = this.items;
    let i = it.length;
    it.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(v, it[p]!)) break;
      it[i] = it[p]!;
      i = p;
    }
    it[i] = v;
  }
  pop(): number {
    const it = this.items;
    const top = it[0]!;
    const v = it.pop()!;
    const n = it.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.less(it[c + 1]!, it[c]!)) c++;
        if (!this.less(it[c]!, v)) break;
        it[i] = it[c]!;
        i = c;
      }
      it[i] = v;
    }
    return top;
  }
}

/** Rounds of averaging of the inner points of a broken line with their neighbours; the ends stay. */
export function relax(x: Float64Array, z: Float64Array, rounds: number): void {
  const n = x.length;
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  for (let r = 0; r < rounds; r++) {
    tx.set(x);
    tz.set(z);
    for (let i = 1; i < n - 1; i++) {
      x[i] = 0.25 * tx[i - 1]! + 0.5 * tx[i]! + 0.25 * tx[i + 1]!;
      z[i] = 0.25 * tz[i - 1]! + 0.5 * tz[i]! + 0.25 * tz[i + 1]!;
    }
  }
}

/** Points every `step` metres along a broken line (the last point kept), with one value carried along. */
export function resample(x: ArrayLike<number>, z: ArrayLike<number>, v: ArrayLike<number>, step: number): { x: Float64Array; z: Float64Array; v: Float64Array } {
  const ox: number[] = [x[0]!];
  const oz: number[] = [z[0]!];
  const ov: number[] = [v[0]!];
  let need = step;
  for (let i = 0; i + 1 < x.length; i++) {
    const dx = x[i + 1]! - x[i]!;
    const dz = z[i + 1]! - z[i]!;
    const len = Math.sqrt(dx * dx + dz * dz);
    let at = 0;
    while (len - at >= need) {
      at += need;
      const t = at / len;
      ox.push(x[i]! + dx * t);
      oz.push(z[i]! + dz * t);
      ov.push(v[i]! + (v[i + 1]! - v[i]!) * t);
      need = step;
    }
    need -= len - at;
  }
  const last = x.length - 1;
  if (Math.hypot(ox[ox.length - 1]! - x[last]!, oz[oz.length - 1]! - z[last]!) > 0.3 * step) {
    ox.push(x[last]!);
    oz.push(z[last]!);
    ov.push(v[last]!);
  } else {
    ox[ox.length - 1] = x[last]!;
    oz[oz.length - 1] = z[last]!;
    ov[ov.length - 1] = v[last]!;
  }
  return { x: Float64Array.from(ox), z: Float64Array.from(oz), v: Float64Array.from(ov) };
}

/** Unit normals of a broken line (to the left of its direction), per point. */
export function normals(x: Float64Array, z: Float64Array): { nx: Float64Array; nz: Float64Array } {
  const n = x.length;
  const nx = new Float64Array(n);
  const nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = x[b]! - x[a]!;
    const dz = z[b]! - z[a]!;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    nx[i] = -dz / l;
    nz[i] = dx / l;
  }
  return { nx, nz };
}

export function average(v: Float64Array, half: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) {
      s += v[k]!;
      c++;
    }
    out[i] = s / c;
  }
  return out;
}

/** Per station 1 around the place where a course leaves a lake (`lake` per station: 0 or the lake), sill included. */
function outlets(lake: ArrayLike<number>): Uint8Array {
  const n = lake.length;
  const held = new Uint8Array(n);
  for (let i = 0; i + 1 < n; i++) if (lake[i]! > 0 && lake[i + 1] === 0) held.fill(1, Math.max(0, i - 8), Math.min(n, i + SILL_STATIONS + 4));
  return held;
}

/** The value of a per-station array at a place between stations (`f` in stations). */
function at(v: ArrayLike<number>, f: number): number {
  const i = Math.min(v.length - 2, Math.max(0, Math.floor(f)));
  const t = Math.min(1, Math.max(0, f - i));
  return v[i]! + (v[i + 1]! - v[i]!) * t;
}

/** The point of a broken line nearest to (x, z): its stretch, the share along it and the distance. */
export function nearestOn(xs: Float64Array, zs: Float64Array, x: number, z: number): { i: number; t: number; d: number } {
  let best = Infinity;
  let bi = 0;
  let bt = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const dx = xs[i + 1]! - xs[i]!;
    const dz = zs[i + 1]! - zs[i]!;
    const t = Math.min(1, Math.max(0, ((x - xs[i]!) * dx + (z - zs[i]!) * dz) / (dx * dx + dz * dz || 1)));
    const ex = xs[i]! + dx * t - x;
    const ez = zs[i]! + dz * t - z;
    const d = ex * ex + ez * ez;
    if (d < best) {
      best = d;
      bi = i;
      bt = t;
    }
  }
  return { i: bi, t: bt, d: Math.sqrt(best) };
}

/**
 * The ground of a lake over its level, from the natural ground's height over it (`d`, metres): the natural ground,
 * cut down near and under the level (`SHORE_CUT_M`).
 */
export function lakeGround(d: number): number {
  return d - Math.min(SHORE_DEEPER_M, Math.max(0, (SHORE_STEEP - 1) * (SHORE_CUT_M - d)));
}

/** Level of a line at a station and a share to the next: a fall steps, the rest falls evenly. */
export function levelAt(l: Line, i: number, t: number): number {
  return l.fall[i] ? (t < 0.5 ? l.level[i]! : l.level[i + 1]!) : l.level[i]! + (l.level[i + 1]! - l.level[i]!) * t;
}

// A channel whose heading swings as `swing · sin` along its own length: the share of its straight length it keeps
// (Bessel J0 of the swing) and its sideways reach as a share of the straight length of one bend.
const keptLength = (w: number): number => 1 - (w * w) / 4 + w ** 4 / 64 - w ** 6 / 2304;
const reachShare = (w: number): number => (2 * w - (2 / 9) * w ** 3 + (2 / 225) * w ** 5 - (32 / 176400) * w ** 7) / (4 * Math.PI * keptLength(w));

/**
 * Builds the plan of a seed. A lake under which a line would arrive (its valley dips under the lake's level before
 * it reaches the lake) is lowered to that line and the plan built again, a few times at most.
 */
export function waterPlan(seed: number): Plan {
  const tops = new Map<number, number>();
  for (let pass = 0; ; pass++) {
    const { plan, lower } = planUnder(seed, tops);
    if (lower.size === 0 || pass === LAKE_PASSES - 1) return plan;
    for (const [key, top] of lower) tops.set(key, Math.min(tops.get(key) ?? Infinity, top));
  }
}

/**
 * The plan of a seed with some lakes held under a level (`tops`: the first node of the lake's hollow → the level),
 * and the lakes that are still to be lowered (`lower`, the same keys).
 */
function planUnder(seed: number, tops: Map<number, number>): { plan: Plan; lower: Map<number, number> } {
  const N = GRID_N;
  const count = N * N;
  const nodeX = (i: number): number => -HALF_M + (i % N) * GRID_M;
  const nodeZ = (i: number): number => -HALF_M + Math.floor(i / N) * GRID_M;
  const ground = (x: number, z: number): number => naturalHeight(seed, x, z);

  // --- 1. Heights, the fill, drainage and flow ---------------------------------------------------------------------
  const H = new Float64Array(count);
  for (let i = 0; i < count; i++) H[i] = ground(nodeX(i), nodeZ(i));
  const F = new Float64Array(count);
  const seen = new Uint8Array(count);
  const parent = new Int32Array(count).fill(-1);
  const order = new Int32Array(count);
  const heap = new NodeHeap(F);
  const sea = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const gx = i % N;
    const gz = Math.floor(i / N);
    if (H[i]! <= 0 || gx === 0 || gz === 0 || gx === N - 1 || gz === N - 1) {
      sea[i] = 1;
      F[i] = Math.min(H[i]!, 0);
      seen[i] = 1;
      heap.push(i);
    }
  }
  let popped = 0;
  while (heap.size > 0) {
    const i = heap.pop();
    order[popped++] = i;
    const gx = i % N;
    const gz = Math.floor(i / N);
    for (let k = 0; k < 8; k++) {
      const jx = gx + DX[k]!;
      const jz = gz + DZ[k]!;
      if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
      const j = jz * N + jx;
      if (seen[j]) continue;
      seen[j] = 1;
      F[j] = Math.max(H[j]!, F[i]!);
      parent[j] = i;
      heap.push(j);
    }
  }
  const to = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    if (sea[i]) continue;
    const gx = i % N;
    const gz = Math.floor(i / N);
    let best = 0;
    let bj = -1;
    for (let k = 0; k < 8; k++) {
      const j = (gz + DZ[k]!) * N + gx + DX[k]!;
      const drop = (F[i]! - F[j]!) / (k % 2 === 0 ? 1 : Math.SQRT2);
      if (drop > best) {
        best = drop;
        bj = j;
      }
    }
    to[i] = bj >= 0 ? bj : parent[i]!;
  }
  const flow = new Float64Array(count);
  for (let i = 0; i < count; i++) flow[i] = sea[i] ? 0 : 1;
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k]!;
    if (to[i]! >= 0) flow[to[i]!] = flow[to[i]!]! + flow[i]!;
  }

  // --- Lakes: filled hollows, large and deep enough, with a shore --------------------------------------------------
  // The plan's grid finds the hollow; its rim, its level and its shore are found on a fine grid over the hollow, which
  // sees the ground between the nodes. The level is the highest under the rim at which the lake has a shore: a hollow
  // that is mostly a flat pan gets its lake in the deeper part of the pan, or none.
  const hollowOf = new Uint16Array(count);
  const lakeFine = new Uint16Array(FINE_N * FINE_N);
  const lakes: Lake[] = [];
  const mark = new Uint8Array(count);
  const queue: number[] = [];
  const lakeKey: number[] = [];
  const fineLake = (hollow: number[], rim: number): void => {
    const key = hollow[0]!;
    let ax = N;
    let bx = 0;
    let az = N;
    let bz = 0;
    for (const i of hollow) {
      ax = Math.min(ax, i % N);
      bx = Math.max(bx, i % N);
      az = Math.min(az, Math.floor(i / N));
      bz = Math.max(bz, Math.floor(i / N));
    }
    ax = Math.max(0, ax - 2);
    bx = Math.min(N - 1, bx + 2);
    az = Math.max(0, az - 2);
    bz = Math.min(N - 1, bz + 2);
    const w = (bx - ax) * FINE_PER + 1;
    const h = (bz - az) * FINE_PER + 1;
    const total = w * h;
    const hf = new Float64Array(total);
    for (let q = 0; q < total; q++) hf[q] = ground(-HALF_M + (ax * FINE_PER + (q % w)) * FINE_M, -HALF_M + (az * FINE_PER + Math.floor(q / w)) * FINE_M);
    // Filled from the box's edge inward: per point the level at which water there would leave the box.
    const ff = new Float64Array(total);
    const open = new Uint8Array(total);
    const fineHeap = new NodeHeap(ff);
    for (let q = 0; q < total; q++) {
      const i = q % w;
      const j = Math.floor(q / w);
      if (i === 0 || j === 0 || i === w - 1 || j === h - 1) {
        ff[q] = hf[q]!;
        open[q] = 1;
        fineHeap.push(q);
      }
    }
    while (fineHeap.size > 0) {
      const q = fineHeap.pop();
      const i = q % w;
      const j = Math.floor(q / w);
      for (let k = 0; k < 8; k++) {
        const a = i + DX[k]!;
        const b = j + DZ[k]!;
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        const p = b * w + a;
        if (open[p]) continue;
        open[p] = 1;
        ff[p] = Math.max(hf[p]!, ff[q]!);
        fineHeap.push(p);
      }
    }
    // The basin: the points joined to the hollow's deepest node over which the filled level is that node's.
    let deep = -1;
    for (const i of hollow) {
      const q = (Math.floor(i / N) - az) * FINE_PER * w + ((i % N) - ax) * FINE_PER;
      if (deep < 0 || hf[q]! < hf[deep]!) deep = q;
    }
    const spill = ff[deep]!;
    const inBasin = new Uint8Array(total);
    const basin: number[] = [deep];
    inBasin[deep] = 1;
    let low = Infinity;
    for (let at = 0; at < basin.length; at++) {
      const q = basin[at]!;
      low = Math.min(low, hf[q]!);
      const i = q % w;
      const j = Math.floor(q / w);
      for (let k = 0; k < 8; k++) {
        const a = i + DX[k]!;
        const b = j + DZ[k]!;
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        const p = b * w + a;
        if (inBasin[p] || ff[p] !== spill || hf[p]! >= spill) continue;
        inBasin[p] = 1;
        basin.push(p);
      }
    }
    // The level: from the rim down, the first at which the shore is narrow enough.
    let level = NaN;
    const wetAt = (q: number, l: number): boolean => lakeGround(hf[q]! - l) < -SHORE_UNDER_M;
    for (let l = Math.min(Math.min(spill, rim) - LAKE_FREEBOARD_M, tops.get(key) ?? Infinity); l - low >= MIN_LAKE_DEPTH_M; l -= 0.1) {
      let wet = 0;
      let band = 0;
      let edge = 0;
      for (const q of basin) {
        if (wetAt(q, l)) {
          wet++;
          const i = q % w;
          const j = Math.floor(q / w);
          if ((i > 0 && !wetAt(q - 1, l)) || (i < w - 1 && !wetAt(q + 1, l)) || (j > 0 && !wetAt(q - w, l)) || (j < h - 1 && !wetAt(q + w, l))) edge++;
        } else if (lakeGround(hf[q]! - l) < SHORE_OVER_M) band++;
      }
      if (wet * FINE_M * FINE_M < MIN_LAKE_M2) break;
      if (band * FINE_M <= SHORE_WIDTH_M * edge) {
        level = l;
        break;
      }
    }
    if (Number.isNaN(level)) return;
    // Its pools: the points whose ground the lake cuts, in joined groups. A puddle beside the lake is left dry.
    const top = level + SHORE_CUT_M;
    const pool = new Int32Array(total).fill(-1);
    const kept: number[] = [];
    let best = 0;
    let bestX = 0;
    let bestZ = 0;
    const group: number[] = [];
    for (const start of basin) {
      if (pool[start]! >= 0 || hf[start]! >= top) continue;
      group.length = 0;
      group.push(start);
      pool[start] = start;
      let deepest = 0;
      let sx = 0;
      let sz = 0;
      for (let at = 0; at < group.length; at++) {
        const q = group[at]!;
        deepest = Math.max(deepest, -lakeGround(hf[q]! - level));
        const i = q % w;
        const j = Math.floor(q / w);
        sx += i;
        sz += j;
        for (let k = 0; k < 8; k++) {
          const a = i + DX[k]!;
          const b = j + DZ[k]!;
          if (a < 0 || b < 0 || a >= w || b >= h) continue;
          const p = b * w + a;
          if (!inBasin[p] || pool[p]! >= 0 || hf[p]! >= top) continue;
          pool[p] = start;
          group.push(p);
        }
      }
      if (group.length < MIN_POOL_POINTS && deepest < MIN_POOL_DEPTH_M) continue;
      for (const q of group) kept.push(q);
      if (group.length > best) {
        best = group.length;
        bestX = -HALF_M + (ax * FINE_PER + sx / group.length) * FINE_M;
        bestZ = -HALF_M + (az * FINE_PER + sz / group.length) * FINE_M;
      }
    }
    const global = (q: number): number => (az * FINE_PER + Math.floor(q / w)) * FINE_N + ax * FINE_PER + (q % w);
    // Two hollows of the plan's grid that are one basin on the fine grid: the first lake keeps it.
    for (const q of kept) if (lakeFine[global(q)]) return;
    lakes.push({ level, nodes: Math.round(kept.length / (FINE_PER * FINE_PER)), x: bestX, z: bestZ });
    lakeKey.push(key);
    const id = lakes.length;
    for (const q of kept) lakeFine[global(q)] = id;
    for (const i of hollow) hollowOf[i] = id;
  };
  for (let s = 0; s < count; s++) {
    if (mark[s] || sea[s] || F[s]! - H[s]! <= 0.05) continue;
    queue.length = 0;
    queue.push(s);
    mark[s] = 1;
    let deepest = 0;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!;
      deepest = Math.max(deepest, F[i]! - H[i]!);
      const gx = i % N;
      const gz = Math.floor(i / N);
      for (let k = 0; k < 8; k++) {
        const j = (gz + DZ[k]!) * N + gx + DX[k]!;
        if (mark[j] || sea[j] || F[j] !== F[s] || F[j]! - H[j]! <= 0.05) continue;
        mark[j] = 1;
        queue.push(j);
      }
    }
    if (queue.length < MIN_LAKE_NODES || deepest < MIN_LAKE_DEPTH_M) continue;
    fineLake(queue, F[s]!);
  }
  /** The lake at a point, as the ground has it (ground.ts): any corner of the fine cell around it. */
  const lakeAt = (x: number, z: number): number => {
    const fx = Math.min(FINE_N - 2, Math.max(0, Math.floor((x + HALF_M) / FINE_M)));
    const fz = Math.min(FINE_N - 2, Math.max(0, Math.floor((z + HALF_M) / FINE_M)));
    const q = fz * FINE_N + fx;
    return lakeFine[q]! || lakeFine[q + 1]! || lakeFine[q + FINE_N]! || lakeFine[q + FINE_N + 1]!;
  };

  // --- 2. Chains of nodes with enough flow -------------------------------------------------------------------------
  const carries = (i: number): boolean => !sea[i] && flow[i]! >= MIN_FLOW;
  const donors: number[][] = [];
  for (let i = 0; i < count; i++) {
    if (!carries(i)) continue;
    const t = to[i]!;
    (donors[t] ??= []).push(i);
  }
  for (const d of donors) d?.sort((a, b) => flow[b]! - flow[a]! || a - b);
  interface Start {
    node: number;
    into: number;
    end: number;
  }
  const starts: Start[] = [];
  for (let i = 0; i < count; i++) if (carries(i) && sea[to[i]!]) starts.push({ node: i, into: -1, end: to[i]! });
  starts.sort((a, b) => flow[b.node]! - flow[a.node]! || a.node - b.node);
  const lines: Line[] = [];
  /**
   * Per line, between the laying of its course and of its level: the level it would take at each station if nothing
   * downstream held it up, its lakes, the station of the line it joins at which it arrives (−1 without one), and the
   * laying of its level under the caps the lines that join it set (per station, ∞ without one).
   */
  interface Job {
    free: Float64Array;
    /** Per station: 0, or 1 + the lake it lies in. */
    lake: Uint16Array;
    joins: number;
    settle: (cap: Float64Array) => void;
  }
  const jobs: Job[] = [];

  /**
   * Lays one line along a course of points: `into` is the line it ends on (−1 the sea); a branch instead leaves
   * that line and ends in the sea.
   */
  const lay = (px: number[], pz: number[], pf: number[], into: number, branch: boolean, flowOut: number): number => {
    const id = lines.length;
    const parentLine = into >= 0 ? lines[into]! : null;
    const toSea = branch || !parentLine;
    const rx = Float64Array.from(px);
    const rz = Float64Array.from(pz);
    relax(rx, rz, 6);
    let mid = resample(rx, rz, pf, STATION_M);
    relax(mid.x, mid.z, 4);
    // The last stations stay where they are: they lead to the parent or into the sea.
    const keep = branch ? Infinity : parentLine ? 6 : RUN_OUT + 2;
    for (let round = 0; round < 3; round++) {
      const m = mid.x.length;
      const { nx, nz } = normals(mid.x, mid.z);
      const shift = new Float64Array(m);
      for (let i = 1; i < m - keep; i++) {
        if (lakeAt(mid.x[i]!, mid.z[i]!) > 0) continue;
        let best = Infinity;
        for (let o = -18; o <= 18; o += 3) {
          const h = ground(mid.x[i]! + nx[i]! * o, mid.z[i]! + nz[i]! * o) + 0.03 * Math.abs(o);
          if (h < best) {
            best = h;
            shift[i] = o;
          }
        }
      }
      const eased = average(shift, 3);
      for (let i = 1; i < m - keep; i++) {
        mid.x[i] = mid.x[i]! + nx[i]! * eased[i]! * 0.8;
        mid.z[i] = mid.z[i]! + nz[i]! * eased[i]! * 0.8;
      }
      relax(mid.x, mid.z, 2);
    }
    if (!branch) {
      // On level ground nothing holds a small stream to a ruled line: the middle itself wanders a little there.
      const m = mid.x.length;
      const { nx, nz } = normals(mid.x, mid.z);
      const last = m - 1 - (parentLine ? 6 : RUN_OUT + 2);
      const hs = Float64Array.from(mid.x, (x, i) => ground(x, mid.z[i]!));
      const held = outlets(Uint16Array.from(mid.x, (x, i) => lakeAt(x, mid.z[i]!)));
      const shift = new Float64Array(m);
      for (let i = 1; i < last; i++) {
        if (held[i]) continue;
        const a = Math.max(0, i - 8);
        const b = Math.min(m - 1, i + 8);
        const level = smooth(STRAIGHT_GRADE, WINDING_GRADE, Math.abs(hs[a]! - hs[b]!) / ((b - a) * STATION_M));
        let o = 2 * WANDER_M * (valueNoise3(i * STATION_M, id * 13.1, 3, 150, seed + 0x54) - 0.5) * level * smooth(0, 6, i) * smooth(0, 10, last - i);
        // Only along the contour: a line that wandered onto lower or higher ground would no longer meet what it joins.
        while (Math.abs(o) > 1 && Math.abs(ground(mid.x[i]! + nx[i]! * o, mid.z[i]! + nz[i]! * o) - hs[i]!) > 0.08) o *= 0.5;
        shift[i] = Math.abs(o) > 1 ? o : 0;
      }
      const eased = average(shift, 3);
      for (let i = 1; i < last; i++) {
        mid.x[i] = mid.x[i]! + nx[i]! * eased[i]!;
        mid.z[i] = mid.z[i]! + nz[i]! * eased[i]!;
      }
    }
    mid = resample(mid.x, mid.z, mid.v, STATION_M);
    const mx = mid.x;
    const mz = mid.z;
    const m = mx.length;
    const mn = normals(mx, mz);
    const total = (m - 1) * STATION_M;

    // Per station of the middle: standing water, width and depth from the basin, the grade of the ground.
    const mStanding = new Uint8Array(m);
    const mLake = new Uint16Array(m);
    const mHalf = new Float64Array(m);
    const mDepth = new Float64Array(m);
    const rough = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const h = ground(mx[i]!, mz[i]!);
      mLake[i] = lakeAt(mx[i]!, mz[i]!);
      // Standing water is where the ground really lies under it; the dry margin of a lake's hollow is land, and the
      // line winds across it like anywhere else.
      mStanding[i] = (mLake[i]! > 0 && h < lakes[mLake[i]! - 1]!.level) || h <= 0 ? 1 : 0;
      // The first stations are the spring: the channel grows from nothing, its bed from no depth at all.
      const grown = branch ? 1 : 0.25 + 0.75 * smooth(0, 12, i);
      mHalf[i] = Math.min(12, 3.5 * Math.pow(Math.max(1, mid.v[i]! / MIN_FLOW), 0.38)) * grown;
      mDepth[i] = (0.6 + 0.12 * mHalf[i]!) * (0.5 + 0.5 * grown) * (branch ? 1 : smooth(-0.5, 6, i));
      rough[i] = i === 0 ? h : Math.min(h, rough[i - 1]!);
    }
    if (toSea) {
      // The mouth opens toward the sea.
      let coast = m - 1;
      while (coast > 0 && mStanding[coast]) coast--;
      for (let i = 0; i < m; i++) mHalf[i] = mHalf[i]! * (1 + 0.8 * smooth(coast - 16, coast + 2, i));
    }

    // Out of a lake the line runs straight over the sill: there the level is the lake's, and a channel that swung
    // aside would carry it over ground that lies lower.
    const mHeld = outlets(mLake);

    // --- 4. The channel: how far its heading may swing at each station, then the swing walked along its length ------
    const swing = new Float64Array(m);
    const bend = new Float64Array(m);
    const roomLeft = new Float64Array(m);
    const roomRight = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      bend[i] = BEND_WIDTHS * 2 * mHalf[i]! * (0.8 + 0.5 * valueNoise3(i * STATION_M, id * 97.3, 0, 240, seed + 0x51));
      if (mStanding[i]) continue;
      const a = Math.max(0, i - 12);
      const b = Math.min(m - 1, i + 12);
      const grade = (rough[a]! - rough[b]!) / ((b - a) * STATION_M);
      // It dies out toward both ends and toward standing water, so the line still meets what it joins: over fewer
      // stations on a short line, which would otherwise have no length left to wind along.
      const ramp = Math.min(14, Math.max(5, (m - 1) / 6));
      let ends = Math.min(1, (i - (branch ? 8 : 4)) / (branch ? 10 : ramp), (m - 1 - i - (toSea ? RUN_OUT : 3)) / ramp);
      for (let k = Math.max(0, i - 7); k <= Math.min(m - 1, i + 7); k++) if (mStanding[k] || mHeld[k]) ends = Math.min(ends, (Math.abs(k - i) - 1) / 6);
      let w = MAX_SWING * (0.75 + 0.25 * valueNoise3(i * STATION_M, id * 97.3, 7, 400, seed + 0x52)) * smooth(STRAIGHT_GRADE, WINDING_GRADE, grade) * Math.max(0, ends);
      // Room: how far to either side the ground stays within 2.5 m of the line's own.
      const most = reachShare(MAX_SWING) * bend[i]! + mHalf[i]!;
      const room = [0, 0];
      for (let side = 0; side < 2; side++) {
        const dir = side === 0 ? 1 : -1;
        let r = 0;
        while (r < most && ground(mx[i]! + mn.nx[i]! * dir * (r + 4), mz[i]! + mn.nz[i]! * dir * (r + 4)) - rough[i]! < 2.5) r += 4;
        room[side] = Math.max(0, 0.9 * r - mHalf[i]!);
      }
      roomLeft[i] = room[0]!;
      roomRight[i] = room[1]!;
      const fits = Math.min(room[0]!, room[1]!);
      if (reachShare(w) * bend[i]! > fits) {
        let lo = 0;
        let hi = w;
        for (let k = 0; k < 12; k++) {
          const half = 0.5 * (lo + hi);
          if (reachShare(half) * bend[i]! > fits) hi = half;
          else lo = half;
        }
        w = lo < 0.3 ? 0 : lo;
      }
      swing[i] = w;
    }
    const swingEased = average(swing, 5);
    const leftEased = average(roomLeft, 3);
    const rightEased = average(roomRight, 3);
    const STEP = 1.5;
    const us: number[] = [0];
    const offs: number[] = [0];
    let phase = (hashInts(seed, 0x3a7, id) % 6283) / 1000;
    let meanBend = 0;
    for (let u = 0, off = 0; u < total; ) {
      const f = u / STATION_M;
      const w = at(swingEased, f);
      const length = at(bend, f) / keptLength(w);
      meanBend += length;
      phase += (2 * Math.PI * STEP) / length;
      const heading = w * Math.sin(phase);
      u = Math.min(total, u + Math.cos(heading) * STEP);
      off += Math.sin(heading) * STEP;
      us.push(u);
      offs.push(off);
    }
    const steps = us.length;
    meanBend /= Math.max(1, steps - 1);
    // Take the slow drift out of the swing (the heading's mean is not exactly zero while its size changes).
    {
      const win = Math.max(4, Math.round((0.5 * meanBend) / STEP));
      const sum = new Float64Array(steps + 1);
      for (let k = 0; k < steps; k++) sum[k + 1] = sum[k]! + offs[k]!;
      const raw = Float64Array.from(offs);
      for (let k = 0; k < steps; k++) {
        const a = Math.max(0, k - win);
        const b = Math.min(steps, k + win + 1);
        const f = us[k]! / STATION_M;
        const live = smooth(0.05, 0.3, at(swingEased, f));
        let o = (raw[k]! - (sum[b]! - sum[a]!) / (b - a)) * live;
        const room = o > 0 ? at(leftEased, f) : at(rightEased, f);
        o = room > 0.5 ? room * Math.tanh(o / room) : 0;
        offs[k] = o;
      }
    }
    // How far the channel reaches from the middle around each station of the middle.
    const reach = new Float64Array(m);
    for (let k = 0; k < steps; k++) {
      const f = us[k]! / STATION_M;
      const span = Math.ceil((0.5 * at(bend, f)) / STATION_M);
      const o = Math.abs(offs[k]!);
      for (let i = Math.max(0, Math.floor(f) - span); i <= Math.min(m - 1, Math.ceil(f) + span); i++) if (o > reach[i]!) reach[i] = o;
    }
    const reachEased = average(reach, 4);
    const wx = new Float64Array(steps);
    const wz = new Float64Array(steps);
    for (let k = 0; k < steps; k++) {
      const f = us[k]! / STATION_M;
      const nx = at(mn.nx, f);
      const nz = at(mn.nz, f);
      const nl = Math.hypot(nx, nz) || 1;
      wx[k] = at(mx, f) + (nx / nl) * offs[k]!;
      wz[k] = at(mz, f) + (nz / nl) * offs[k]!;
    }
    const ch = resample(wx, wz, us, STATION_M);
    const cx = ch.x;
    const cz = ch.z;
    const n = cx.length;
    const ax = new Float64Array(n);
    const az = new Float64Array(n);
    const nx = new Float64Array(n);
    const nz = new Float64Array(n);
    const half = new Float64Array(n);
    const depth = new Float64Array(n);
    const floor = new Float64Array(n);
    const standing = new Uint8Array(n);
    const lakeId = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const f = ch.v[i]! / STATION_M;
      ax[i] = at(mx, f);
      az[i] = at(mz, f);
      const ux = at(mn.nx, f);
      const uz = at(mn.nz, f);
      const ul = Math.hypot(ux, uz) || 1;
      nx[i] = ux / ul;
      nz[i] = uz / ul;
      half[i] = at(mHalf, f);
      depth[i] = at(mDepth, f);
      floor[i] = half[i]! + at(reachEased, f) * 1.05 + FLOOR_MARGIN_M;
      const near = Math.min(m - 1, Math.round(f));
      standing[i] = mStanding[near]!;
      lakeId[i] = mLake[near]!;
    }
    // A lake reaches as far as its sill: the highest ground of the course within a few stations of the pool's last
    // node. Up to there the water is the lake's, so the level starts to fall only beyond the rim.
    for (let i = 0; i + 1 < n; i++) {
      const id = lakeId[i]!;
      if (id === 0 || lakeId[i + 1] !== 0) continue;
      let sill = i;
      let top = -Infinity;
      for (let k = i + 1; k <= Math.min(n - 1, i + SILL_STATIONS) && lakeId[k] === 0; k++) {
        const h = ground(cx[k]!, cz[k]!);
        if (h > top) {
          top = h;
          sill = k;
        }
      }
      if (top < lakes[id - 1]!.level - LAKE_FREEBOARD_M) continue;
      for (let k = i + 1; k <= sill; k++) lakeId[k] = id;
      i = sill;
    }
    // Across a lake only a shallow bed is dug: enough to carry the water over the dry rim of the pool to the lake's
    // own water, too little to leave a trench in the lake's floor. The bed of a mouth dies out under the sea.
    {
      let coast = n - 1;
      while (coast > 0 && standing[coast]) coast--;
      const dug = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        dug[i] = lakeId[i]! > 0 ? Math.min(1, LAKE_BED_M / depth[i]!) : toSea ? 1 - smooth(coast + 2, coast + RUN_OUT - 1, i) : 1;
      }
      const eased = average(dug, 2);
      for (let i = 0; i < n; i++) depth[i] = depth[i]! * eased[i]!;
    }

    // --- 5. The level ----------------------------------------------------------------------------------------------
    const natural = new Float64Array(n);
    const fixed = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let low = ground(cx[i]!, cz[i]!);
      // A little beyond the floor too: on a side slope the ground just outside it must not lie under the water.
      const span = floor[i]! + SIDE_M;
      for (let o = -span; o <= span; o += 3) low = Math.min(low, ground(ax[i]! + nx[i]! * o, az[i]! + nz[i]! * o));
      // The floor ends in a round head behind the first station: the ground there decides too.
      if (i === 0 && !branch) for (let r = 3; r <= span; r += 3) for (let a = 0; a < 8; a++) low = Math.min(low, ground(ax[0]! + r * Math.cos((a * Math.PI) / 4), az[0]! + r * Math.sin((a * Math.PI) / 4)));
      natural[i] = low;
      if (lakeId[i]! > 0) fixed[i] = lakes[lakeId[i]! - 1]!.level;
      else if (standing[i]) fixed[i] = 0;
    }
    if (toSea) fixed[n - 1] = 0;
    const level = new Float64Array(n);
    const rim = new Float64Array(n);
    const fall = new Uint8Array(n);
    // Where a line that joins another arrives on it: the first station of that line its last stations lie across from.
    let joins = -1;
    if (parentLine && !branch) {
      joins = parentLine.n - 1;
      for (let k = 0; k < Math.min(n, 60); k++) {
        const i = n - 1 - k;
        const hit = nearestOn(parentLine.ax, parentLine.az, cx[i]!, cz[i]!);
        const reachOf = parentLine.floor[hit.i]! + (parentLine.floor[hit.i + 1]! - parentLine.floor[hit.i]!) * hit.t;
        if (k > 0 && hit.d > reachOf + half[i]! + 2) break;
        joins = Math.min(joins, hit.i);
      }
      joins = Math.max(0, joins - 1);
    }
    const settleLevel = (cap: Float64Array): void => {
      if (parentLine) {
        // Inside the parent's floor the water is the parent's: at the end of a tributary, at the start of a branch.
        for (let k = 0; k < Math.min(n, 60); k++) {
          const i = branch ? k : n - 1 - k;
          const hit = nearestOn(parentLine.ax, parentLine.az, cx[i]!, cz[i]!);
          const reachOf = parentLine.floor[hit.i]! + (parentLine.floor[hit.i + 1]! - parentLine.floor[hit.i]!) * hit.t;
          if (k > 0 && hit.d > reachOf + half[i]! + 2) break;
          fixed[i] = levelAt(parentLine, hit.i, hit.t);
        }
      }
      const bound = new Float64Array(n);
      let lb = -Infinity;
      for (let i = n - 1; i >= 0; i--) {
        if (!Number.isNaN(fixed[i]!)) lb = Math.max(lb, fixed[i]!);
        bound[i] = lb;
      }
      const want = Float64Array.from(natural, (v) => v - FREE_M);
      // A line that joins lower than this one would stand there: this one is lowered to it, easing in from upstream.
      for (let i = 0; i < n; i++) {
        if (cap[i] === Infinity) continue;
        const from = want[i]!;
        const to = Math.max(cap[i]!, from - JOIN_CUT_M);
        for (let k = i; k >= 0; k--) {
          const top = to + JOIN_GRADE * STATION_M * (i - k);
          if (top >= from) break;
          want[k] = Math.min(want[k]!, top);
        }
      }
      const settle = (): void => {
        for (let i = 0; i < n; i++) {
          const w = Number.isNaN(fixed[i]!) ? want[i]! : fixed[i]!;
          level[i] = Math.max(bound[i]!, i === 0 ? w : Math.min(w, level[i - 1]!));
        }
      };
      settle();
      // Ease the small steps the bumps of the ground leave, then make it fall again.
      for (let round = 0; round < 3; round++) {
        const prev = Float64Array.from(level);
        for (let i = 1; i < n - 1; i++) want[i] = Math.min(want[i]!, 0.25 * prev[i - 1]! + 0.5 * prev[i]! + 0.25 * prev[i + 1]!);
        settle();
      }
      // Stairs: a steep stretch is cut into treads, each as low as its own lower end, with a fall at its head.
      const steep = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 2);
        const b = Math.min(n - 1, i + 2);
        steep[i] = Number.isNaN(fixed[i]!) && (level[a]! - level[b]!) / ((b - a) * STATION_M) > STAIR_GRADE ? 1 : 0;
      }
      const target = Float64Array.from(level);
      for (let a = 0; a < n; a++) {
        if (!steep[a]) continue;
        let b = a;
        while (b + 1 < n && steep[b + 1]) b++;
        for (let p = a; p <= b; ) {
          let q = p + 5 + (hashInts(seed, 0x57a1, id * 4096 + p) % 5);
          if (q > b - 3) q = b + 1;
          else {
            // End the tread where the ground itself drops most.
            let best = q;
            for (let k = q - 2; k <= q + 2; k++) if (target[k - 1]! - target[k]! > target[best - 1]! - target[best]!) best = k;
            q = best;
          }
          for (let k = p; k < q; k++) level[k] = Math.min(target[k]!, target[q - 1]! + TREAD_GRADE * STATION_M * (q - 1 - k));
          if (p > 0 && level[p - 1]! - level[p]! > 0.4) fall[p - 1] = 1;
          p = q;
        }
        if (b + 1 < n && level[b]! - level[b + 1]! > 1) fall[b] = 1;
        a = b;
      }
      // A line that meets standing water or its parent a little above it comes down to it evenly, not over a step.
      for (let i = n - 2; i >= 0; i--) {
        if (!Number.isNaN(fixed[i]!) || Number.isNaN(fixed[i + 1]!) || fall[i] || level[i]! - level[i + 1]! > 1.5) continue;
        for (let k = i; k >= 0 && !fall[k] && Number.isNaN(fixed[k]!); k--) {
          const top = level[k + 1]! + 0.02 * STATION_M;
          if (level[k]! <= top) break;
          level[k] = top;
        }
      }
      // Under a fall the pool is wider and deeper.
      for (let i = 0; i < n; i++) {
        if (!fall[i]) continue;
        const height = level[i]! - level[i + 1]!;
        const more = smooth(0.5, 6, height);
        for (let k = 1; k <= 3 && i + k < n; k++) {
          const share = more * (1 - (k - 1) / 3);
          half[i + k] = half[i + k]! * (1 + 0.35 * share);
          depth[i + k] = depth[i + k]! * (1 + 1.2 * share);
          floor[i + k] = floor[i + k]! + half[i + k]! * 0.35 * share;
        }
      }
      // The walls' level: the level, but easing down after a fall, so the cliff is a notch and not a wall across the valley.
      let eased: Float64Array = Float64Array.from(level);
      for (let round = 0; round < 3; round++) eased = average(eased, 4);
      for (let i = 0; i < n; i++) rim[i] = Math.max(eased[i]!, level[i]!);

    };
    jobs.push({ free: Float64Array.from(natural, (v, i) => (Number.isNaN(fixed[i]!) ? v - FREE_M : fixed[i]!)), lake: lakeId, joins, settle: settleLevel });

    lines.push({ n, cx, cz, ax, az, level, rim, half, depth, floor, fall, natural, standing, into, flow: flowOut });
    return id;
  };

  /** The mouth of a large line: one or two branches leave it before the coast and reach the sea beside it. */
  const fork = (id: number): void => {
    const l = lines[id]!;
    if (l.flow < DELTA_FLOW) return;
    let coast = l.n - 1;
    while (coast > 0 && l.standing[coast]) coast--;
    const pick = hashInts(seed, 0xde17a, id);
    const from = coast - 16 - (pick % 10);
    if (from < 20) return;
    const sides = l.flow >= 2 * DELTA_FLOW ? [1, -1] : [pick & 16 ? 1 : -1];
    for (const side of sides) {
      const j = from - (side > 0 ? 0 : 6);
      let dx = l.cx[j + 2]! - l.cx[j - 2]!;
      let dz = l.cz[j + 2]! - l.cz[j - 2]!;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      const angle = 0.4 + 0.3 * ((hashInts(seed, 0xde17b, id * 2 + (side > 0 ? 1 : 0)) % 1000) / 1000);
      const px = [l.cx[j]!];
      const pz = [l.cz[j]!];
      let x = l.cx[j]!;
      let z = l.cz[j]!;
      let inSea = 0;
      let lake = false;
      for (let k = 1; k <= 70 && inSea < RUN_OUT; k++) {
        // It turns away from the line, then wanders: a branch of a mouth is no ruled line.
        const a = side * angle * smooth(0, 10, k) + 1.1 * (valueNoise3(k * STATION_M, id * 31.7, side, 110, seed + 0x53) - 0.5) * smooth(4, 16, k);
        x += (dx * Math.cos(a) - dz * Math.sin(a)) * STATION_M;
        z += (dz * Math.cos(a) + dx * Math.sin(a)) * STATION_M;
        px.push(x);
        pz.push(z);
        inSea = ground(x, z) <= 0 ? inSea + 1 : 0;
        lake ||= lakeAt(x, z) > 0;
      }
      if (inSea < RUN_OUT || lake) continue;
      lay(px, pz, px.map(() => l.flow * 0.35), id, true, l.flow * 0.35);
    }
  };

  for (let s = 0; s < starts.length; s++) {
    const st = starts[s]!;
    const chain: number[] = [];
    const side: Start[] = [];
    for (let cur = st.node; ; ) {
      chain.push(cur);
      const d = donors[cur];
      if (!d || d.length === 0) break;
      for (let k = 1; k < d.length; k++) side.push({ node: d[k]!, into: lines.length, end: cur });
      cur = d[0]!;
    }
    if (chain.length < MIN_LINE_NODES) continue;
    for (const t of side) starts.push(t);
    chain.reverse();
    const parentLine = st.into >= 0 ? lines[st.into]! : null;

    // --- 3. The valley's middle: through the nodes, smoothed, then slid into the lowest real ground beside it -------
    const px: number[] = chain.map(nodeX);
    const pz: number[] = chain.map(nodeZ);
    const pf: number[] = chain.map((i) => flow[i]!);
    if (parentLine) {
      const hit = nearestOn(parentLine.cx, parentLine.cz, nodeX(st.end), nodeZ(st.end));
      px.push(parentLine.cx[hit.i]! + (parentLine.cx[hit.i + 1]! - parentLine.cx[hit.i]!) * hit.t);
      pz.push(parentLine.cz[hit.i]! + (parentLine.cz[hit.i + 1]! - parentLine.cz[hit.i]!) * hit.t);
    } else {
      // On into the sea, straight ahead.
      const k = chain.length - 1;
      const ex = nodeX(st.end) - px[Math.max(0, k - 2)]!;
      const ez = nodeZ(st.end) - pz[Math.max(0, k - 2)]!;
      const el = Math.hypot(ex, ez) || 1;
      px.push(nodeX(st.end), nodeX(st.end) + (ex / el) * RUN_OUT * STATION_M);
      pz.push(nodeZ(st.end), nodeZ(st.end) + (ez / el) * RUN_OUT * STATION_M);
      pf.push(pf[k]!);
    }
    pf.push(pf[pf.length - 1]!);
    const id = lay(px, pz, pf, st.into, false, pf[chain.length - 1]!);
    if (st.into < 0) fork(id);
  }

  // --- The levels. A line that joins another has a higher number than it, so from the last line to the first every
  // line knows the caps of those that join it before it sets its own; then from the first to the last every line
  // finds the level of the line it joins already laid.
  const caps = lines.map((l) => new Float64Array(l.n).fill(Infinity));
  for (let id = lines.length - 1; id >= 0; id--) {
    const job = jobs[id]!;
    if (job.joins < 0) continue;
    let arrives = Infinity;
    for (let i = 0; i < job.free.length; i++) arrives = Math.min(arrives, job.free[i]!, caps[id]![i]!);
    const cap = caps[lines[id]!.into]!;
    cap[job.joins] = Math.min(cap[job.joins]!, arrives);
  }
  // A lake a line reaches from under its level is to stand lower.
  const lower = new Map<number, number>();
  for (let id = 0; id < lines.length; id++) {
    const job = jobs[id]!;
    let arrives = Infinity;
    for (let i = 0; i < job.free.length; i++) {
      const cap = caps[id]![i]!;
      const k = job.lake[i]!;
      const reached = Math.min(arrives, cap);
      if (k > 0 && reached < lakes[k - 1]!.level - 0.02) lower.set(lakeKey[k - 1]!, Math.min(lower.get(lakeKey[k - 1]!) ?? Infinity, reached));
      arrives = Math.min(reached, job.free[i]!);
    }
  }
  for (let id = 0; id < lines.length; id++) jobs[id]!.settle(caps[id]!);

  // --- Buckets: which stretches of which line can reach a point -----------------------------------------------------
  const lists: number[][] = [];
  for (let l = 0; l < lines.length; l++) {
    const li = lines[l]!;
    for (let i = 0; i + 1 < li.n; i++) {
      const reach = Math.max(li.floor[i]!, li.floor[i + 1]!) + WALL_REACH_M;
      const x0 = Math.min(li.ax[i]!, li.ax[i + 1]!, li.cx[i]!, li.cx[i + 1]!) - reach;
      const x1 = Math.max(li.ax[i]!, li.ax[i + 1]!, li.cx[i]!, li.cx[i + 1]!) + reach;
      const z0 = Math.min(li.az[i]!, li.az[i + 1]!, li.cz[i]!, li.cz[i + 1]!) - reach;
      const z1 = Math.max(li.az[i]!, li.az[i + 1]!, li.cz[i]!, li.cz[i + 1]!) + reach;
      const bx0 = Math.max(0, Math.floor((x0 + HALF_M) / BUCKET_M));
      const bx1 = Math.min(BUCKET_N - 1, Math.floor((x1 + HALF_M) / BUCKET_M));
      const bz0 = Math.max(0, Math.floor((z0 + HALF_M) / BUCKET_M));
      const bz1 = Math.min(BUCKET_N - 1, Math.floor((z1 + HALF_M) / BUCKET_M));
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) (lists[bz * BUCKET_N + bx] ??= []).push(l * 65536 + i);
    }
  }
  const bucketStart = new Uint32Array(BUCKET_N * BUCKET_N + 1);
  let all = 0;
  for (let b = 0; b < BUCKET_N * BUCKET_N; b++) {
    bucketStart[b] = all;
    all += lists[b]?.length ?? 0;
  }
  bucketStart[BUCKET_N * BUCKET_N] = all;
  const segs = new Uint32Array(all);
  for (let b = 0; b < BUCKET_N * BUCKET_N; b++) if (lists[b]) segs.set(lists[b]!, bucketStart[b]!);

  const upstream = new Uint32Array(count);
  for (let k = 0; k < count; k++) upstream[k] = order[count - 1 - k]!;
  const drain = { to, flow: Float32Array.from(flow), order: upstream };
  return { plan: { seed, lakeFine, hollowOf, lakes, lines, bucketStart, segs, drain }, lower };
}
