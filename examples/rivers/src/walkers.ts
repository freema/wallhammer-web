// Walkers on the footpaths: a few pathfinder figures (shared/src/figures/pathfinder.ts) walking the island's paths. A pure function
// of the path plan, the field (after `layPaths`) and the seed; where a walker is at a time is a pure function of that
// time, so freezing the page's animation time freezes them.
//
// Routes. A walker walks what the path is made of: the trodden line, the stones, the boards, the steps, a bridge's
// deck and the stones of a ford. Every path is cut where it comes near an earlier path (a junction, `CROWD_M`), and
// only stretches at least `MIN_STRETCH_M` long take walkers. A walker's route is a closed loop over one stretch: out
// along the middle of the path, a little to its right, round at its end in a turn it swings out for, back along the
// middle, round at its start. Everybody walks at the
// same speed, so nobody overtakes anybody and nobody ever appears or vanishes. Two walkers that meet step aside, each
// to its right (`ASIDE_M`, from `PASS_M` away), and come back to the middle behind each other; on boards, a bridge or
// a ford there is less room to do so (`room`). Every walker carries its pole on the right, the outer side, so the
// lanterns of two walkers passing do not meet.
//
// The step. A walker moves at the walk motion's own speed, `strideM / duration` metres a second, and the motion's
// time is the metres it has walked over `strideM` times `duration`: the feet do not slide. The motion's time is never
// wrapped (it keeps counting round the loop), so the loop need not be a whole number of strides long and there is no
// seam where the loop closes.
//
// Height. What is walked on under the walker (`treadAt`, path-kinds.ts), sampled every `HEIGHT_STEP_M` along the loop
// and smoothed along it, so a figure does not jitter on the 2.5 m grid. Up is the world's up: the figures walk upright.

import type { Vec3 } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';
import type { Field } from './field.ts';
import { groundHeightAt } from './ground-mesh.ts';
import { PATHFINDER_MIRROR, PATHFINDER_TORCH } from '../../shared/src/figures/pathfinder.ts';
import { figureKind, type FigureState } from './figures/state.ts';
import { KIND, treadAt, type PathKinds } from './path-kinds.ts';
import { PATH_STATION_M, pathAt, type PathHit, type PathPlan } from './paths.ts';

/**
 * A station of a path this near a station of an earlier path is not walked, metres: where a later path leaves an
 * earlier one (a junction), its walkers turn back before they reach the earlier path's walkers.
 */
const CROWD_M = 3.5;
/** The shortest stretch that takes walkers, metres. */
const MIN_STRETCH_M = 80;
/** A walker walks this far right of the centreline, metres. */
export const SIDE_M = 0.12;
/** At the ends of its stretch it swings out to this, the radius of its turn, over `END_EASE_M` of path. */
const END_SIDE_M = 0.58;
const END_EASE_M = 9;
/** Two walkers meeting step this much farther to their right, from `PASS_M` apart and fully from `PASS_NEAR_M`. */
export const ASIDE_M = 0.46;
const PASS_M = 7;
const PASS_NEAR_M = 2.6;
/** The share of `ASIDE_M` there is room for on each kind of path. */
const ROOM = [1, 1, 1, 0.9, 0.75, 0.6, 0.55];

/** How far behind its leader the second walker of a pair walks, metres. */
const PAIR_BACK_M = 3.5;
/** Spacing of the height table along a loop, and the half width of its smoothing window (applied twice), metres. */
const HEIGHT_STEP_M = 0.5;
const SMOOTH_M = 1;
/** Points of a half-circle at a turn. */
const TURN_POINTS = 10;

const WALK = figureKind('pathfinder').motions.walk!;
const WALK_S = WALK.duration!;
const STRIDE_M = WALK.strideM!;
/** Walking speed, metres a second. */
export const WALK_SPEED = STRIDE_M / WALK_S;

/** A closed loop over a stretch of a path. */
export interface Loop {
  /** The path and its first and last station of the stretch. */
  path: number;
  from: number;
  to: number;
  /** Length of the loop, metres. */
  lengthM: number;
  /** Points of the loop (closed: the last joins the first) and the metres along it at each point. */
  x: Float64Array;
  z: Float64Array;
  at: Float64Array;
  /** Height of what is walked on every `HEIGHT_STEP_M`-ish metres along the loop, smoothed (`heights.length` samples spread evenly). */
  heights: Float64Array;
  /** The room to step aside at the same samples, 0–1. */
  room: Float64Array;
}

/** One walker: a loop, where on it it is at time 0, its look and motion. */
export interface Walker {
  loop: number;
  /** Metres walked at time 0 (its place on the loop is this modulo the loop's length). */
  startM: number;
  variant: number;
  motion: 'walk' | 'bear';
  seed: number;
  /** The walker it follows in a pair, or −1. */
  leader: number;
}

export interface Walkers {
  loops: Loop[];
  walkers: Walker[];
}

/** The stretches of every path that are long enough and clear of earlier paths: [path, first station, last station]. */
function stretchesOf(paths: PathPlan): [number, number, number][] {
  const out: [number, number, number][] = [];
  const min = Math.ceil(MIN_STRETCH_M / PATH_STATION_M);
  // The stations of every path in cells of CROWD_M, for finding the ones near a station.
  const cell = (x: number, z: number): number => Math.floor(x / CROWD_M + 4096) * 8192 + Math.floor(z / CROWD_M + 4096);
  const grid = new Map<number, number[]>();
  paths.paths.forEach((p, k) => {
    for (let i = 0; i < p.n; i++) {
      const c = cell(p.x[i]!, p.z[i]!);
      let list = grid.get(c);
      if (!list) grid.set(c, (list = []));
      list.push(k, i);
    }
  });
  const crowded = (k: number, x: number, z: number): boolean => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(cell(x, z) + dx * 8192 + dz);
        if (!list) continue;
        for (let m = 0; m < list.length; m += 2) {
          const q = paths.paths[list[m]!]!;
          const j = list[m + 1]!;
          if (list[m]! < k && Math.hypot(q.x[j]! - x, q.z[j]! - z) < CROWD_M) return true;
        }
      }
    return false;
  };
  paths.paths.forEach((p, k) => {
    const taken = new Uint8Array(p.n);
    for (let i = 0; i < p.n; i++) if (crowded(k, p.x[i]!, p.z[i]!)) taken[i] = 1;
    let a = -1;
    for (let i = 0; i <= p.n; i++) {
      const free = i < p.n && !taken[i];
      if (free && a < 0) a = i;
      if (!free && a >= 0) {
        if (i - 1 - a >= min) out.push([k, a, i - 1]);
        a = -1;
      }
    }
  });
  return out;
}

/** The loop over stations `a`–`b` of a path, with its heights. */
function loopOf(paths: PathPlan, kinds: PathKinds, f: Field, path: number, a: number, b: number): Loop {
  const p = paths.paths[path]!;
  const xs: number[] = [];
  const zs: number[] = [];
  /** Unit direction of the path at station i (one-sided at the stretch's ends). */
  const dir = (i: number): [number, number] => {
    const i0 = Math.max(a, i - 1);
    const i1 = Math.min(b, i + 1);
    const dx = p.x[i1]! - p.x[i0]!;
    const dz = p.z[i1]! - p.z[i0]!;
    const d = Math.hypot(dx, dz) || 1;
    return [dx / d, dz / d];
  };
  // Right of a heading (dx, dz) with y up: (−dz, dx).
  /** How much of the swing out at the ends station i has, 0–1. */
  const endness = (i: number): number => {
    const u = Math.max(0, 1 - (Math.min(i - a, b - i) * PATH_STATION_M) / END_EASE_M);
    return u * u * (3 - 2 * u);
  };
  const side = (i: number, s: number): void => {
    const [dx, dz] = dir(i);
    const m = SIDE_M + (END_SIDE_M - SIDE_M) * endness(i);
    xs.push(p.x[i]! - dz * m * s);
    zs.push(p.z[i]! + dx * m * s);
  };
  /** A half-circle round station i from its right side (s = 1 going out) through the point ahead of it. */
  const turn = (i: number, ahead: number): void => {
    const [dx, dz] = dir(i);
    const fx = dx * ahead, fz = dz * ahead;
    // Right of the heading of travel at this end.
    const rx = -fz, rz = fx;
    for (let k = 1; k < TURN_POINTS; k++) {
      const t = (k / TURN_POINTS) * Math.PI;
      xs.push(p.x[i]! + END_SIDE_M * (rx * Math.cos(t) + fx * Math.sin(t)));
      zs.push(p.z[i]! + END_SIDE_M * (rz * Math.cos(t) + fz * Math.sin(t)));
    }
  };
  for (let i = a; i <= b; i++) side(i, 1);
  turn(b, 1);
  for (let i = b; i >= a; i--) side(i, -1);
  turn(a, -1);
  const n = xs.length;
  const x = Float64Array.from(xs);
  const z = Float64Array.from(zs);
  const at = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) at[i + 1] = at[i]! + Math.hypot(x[(i + 1) % n]! - x[i]!, z[(i + 1) % n]! - z[i]!);
  const lengthM = at[n]!;
  const loop: Loop = { path, from: a, to: b, lengthM, x, z, at, heights: new Float64Array(0), room: new Float64Array(0) };
  // The heights: raw samples, then a box of ±SMOOTH_M along the loop, twice.
  const m = Math.max(8, Math.round(lengthM / HEIGHT_STEP_M));
  const h = new Float64Array(m);
  const room = new Float64Array(m);
  const q: [number, number] = [0, 0];
  const hit: PathHit = { d: 0, ox: 0, oz: 0, y: 0, ford: 0, path: 0, i: 0, t: 0 };
  for (let k = 0; k < m; k++) {
    placeOn(loop, (k / m) * lengthM, q);
    if (pathAt(paths, q[0], q[1], hit)) {
      h[k] = treadAt(kinds, f, hit, q[0], q[1]);
      // No stepping aside where the walker has swung out for its turn already.
      const st = hit.path === path ? hit.i + hit.t : a;
      const end = Math.min(1, Math.max(0, (Math.min(st - a, b - st) * PATH_STATION_M) / END_EASE_M));
      room[k] = ROOM[kinds.kind[hit.path]![hit.t < 0.5 ? hit.i : hit.i + 1] ?? KIND.earth]! * end;
    } else {
      h[k] = groundHeightAt(f, q[0], q[1]);
      room[k] = 1;
    }
  }
  const r = Math.max(1, Math.round(SMOOTH_M / (lengthM / m)));
  const smooth = (v: Float64Array, passes: number): Float64Array => {
    for (let pass = 0; pass < passes; pass++) {
      const out = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        let s = 0;
        for (let j = -r; j <= r; j++) s += v[(((k + j) % m) + m) % m]!;
        out[k] = s / (2 * r + 1);
      }
      v = out;
    }
    return v;
  };
  loop.heights = smooth(h, 2);
  loop.room = smooth(room, 3);
  return loop;
}

/** The point `s` metres along a loop (taken modulo its length). */
function placeOn(l: Loop, s: number, out: [number, number]): void {
  const L = l.lengthM;
  const u = ((s % L) + L) % L;
  const n = l.x.length;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (l.at[mid]! <= u) lo = mid;
    else hi = mid;
  }
  const seg = l.at[lo + 1]! - l.at[lo]!;
  const t = seg > 0 ? (u - l.at[lo]!) / seg : 0;
  const j = (lo + 1) % n;
  out[0] = l.x[lo]! + (l.x[j]! - l.x[lo]!) * t;
  out[1] = l.z[lo]! + (l.z[j]! - l.z[lo]!) * t;
}

/** A smoothed sample (`heights`, `room`) `s` metres along a loop. */
function sampleOn(l: Loop, v: Float64Array, s: number): number {
  const L = l.lengthM;
  const m = v.length;
  const u = ((((s % L) + L) % L) / L) * m;
  const k = Math.floor(u) % m;
  const t = u - Math.floor(u);
  return v[k]! * (1 - t) + v[(k + 1) % m]! * t;
}

/** The walkers of a seed: 7 to 10, mostly alone, one or two pairs, spread over the long stretches. */
export function walkersOf(paths: PathPlan, kinds: PathKinds, f: Field, seed: number): Walkers {
  const stretches = stretchesOf(paths);
  if (stretches.length === 0) return { loops: [], walkers: [] };
  const lengthOf = (s: [number, number, number]): number => (s[2] - s[1]) * PATH_STATION_M;
  const r = (...k: number[]): number => unit(hashInts(seed, 0x3a1c, ...k));
  // Groups: 6–8, one or two of them pairs; the first walks alone (the page's view `walker` looks at it from behind).
  const groups = 6 + Math.floor(r(1) * 3);
  const pairs = 1 + Math.floor(r(2) * 2);
  const pairAt = new Set<number>();
  for (let k = 0; pairAt.size < pairs && k < 64; k++) pairAt.add(1 + Math.floor(r(3, k) * (groups - 1)));
  // Each group takes the stretch that is longest for the groups already on it, give or take a little.
  const taken = new Array<number>(stretches.length).fill(0);
  const placed: number[][] = stretches.map(() => []);
  for (let g = 0; g < groups; g++) {
    let best = 0, score = -1;
    for (let s = 0; s < stretches.length; s++) {
      const v = (lengthOf(stretches[s]!) / Math.pow(1 + taken[s]!, 1.5)) * (0.7 + 0.6 * r(4, g, s));
      if (v > score) (score = v), (best = s);
    }
    taken[best]!++;
    placed[best]!.push(g);
  }
  const loops: Loop[] = [];
  const loopOfStretch = new Map<number, number>();
  const startOf = new Array<number>(groups).fill(0);
  const loopOfGroup = new Array<number>(groups).fill(0);
  placed.forEach((gs, s) => {
    if (gs.length === 0) return;
    const [path, a, b] = stretches[s]!;
    loopOfStretch.set(s, loops.length);
    const loop = loopOf(paths, kinds, f, path, a, b);
    loops.push(loop);
    // Spread along the loop: evenly, then each moved by up to a fifth of its share.
    const share = loop.lengthM / gs.length;
    const first = r(5, s) * loop.lengthM;
    gs.forEach((g, k) => {
      startOf[g] = first + share * (k + 0.2 * r(6, g));
      loopOfGroup[g] = loops.length - 1;
    });
  });
  // The torch: the last group that walks alone.
  let torch = -1;
  for (let g = groups - 1; g >= 0 && torch < 0; g--) if (!pairAt.has(g)) torch = g;
  const walkers: Walker[] = [];
  const shift = Math.floor(r(7) * 4);
  const variantOf = (j: number): number => (j < 4 ? (j + shift) % 4 : 4 + Math.floor(r(8, j) * (PATHFINDER_TORCH - 8)));
  for (let g = 0; g < groups; g++) {
    const members = pairAt.has(g) ? 2 : 1;
    let leader = -1;
    for (let k = 0; k < members; k++) {
      const j = walkers.length;
      const lit = g === torch;
      walkers.push({
        loop: loopOfGroup[g]!,
        startM: startOf[g]! - k * PAIR_BACK_M,
        variant: variantOf(j) + PATHFINDER_MIRROR + (lit ? PATHFINDER_TORCH : 0),
        motion: lit ? 'bear' : 'walk',
        seed: r(9, j),
        leader,
      });
      if (k === 0) leader = j;
    }
  }
  return { loops, walkers };
}

/** A walker's place on its loop at time `t` before it steps aside for anybody: x, z and its heading into `out`. */
function onLoop(w: Walkers, i: number, t: number, out: Float64Array): void {
  const k = w.walkers[i]!;
  const l = w.loops[k.loop]!;
  const m = k.startM + WALK_SPEED * t;
  const p: [number, number] = [0, 0];
  const a: [number, number] = [0, 0];
  const b: [number, number] = [0, 0];
  placeOn(l, m, p);
  // The heading over a little more than a metre round the place: smooth through the turns at the ends.
  placeOn(l, m - 0.4, a);
  placeOn(l, m + 0.4, b);
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const d = Math.hypot(dx, dz) || 1;
  out[0] = p[0];
  out[1] = p[1];
  out[2] = dx / d;
  out[3] = dz / d;
}

/** Where a walker is at time `t`: its place on the ground, its heading (unit x, z) and the metres along its loop. */
export function walkerPlace(w: Walkers, i: number, t: number): { position: Vec3; forward: Vec3; alongM: number } {
  const k = w.walkers[i]!;
  const l = w.loops[k.loop]!;
  const m = k.startM + WALK_SPEED * t;
  const me = new Float64Array(4);
  const other = new Float64Array(4);
  onLoop(w, i, t, me);
  // Aside for whoever comes the other way: by how near they are and how squarely they face this walker.
  let aside = 0;
  for (let j = 0; j < w.walkers.length; j++) {
    if (j === i || w.walkers[j]!.loop !== k.loop) continue;
    onLoop(w, j, t, other);
    const gap = Math.hypot(other[0]! - me[0]!, other[1]! - me[1]!);
    if (gap >= PASS_M) continue;
    const facing = Math.max(0, -(me[2]! * other[2]! + me[3]! * other[3]!));
    const near = Math.min(1, (PASS_M - gap) / (PASS_M - PASS_NEAR_M));
    aside = Math.max(aside, near * near * (3 - 2 * near) * facing);
  }
  aside *= ASIDE_M * sampleOn(l, l.room, m);
  // Right of a heading (dx, dz) with y up: (−dz, dx).
  return {
    position: [me[0]! - me[3]! * aside, sampleOn(l, l.heights, m), me[1]! + me[2]! * aside],
    forward: [me[2]!, 0, me[3]!],
    alongM: ((m % l.lengthM) + l.lengthM) % l.lengthM,
  };
}

/** The figure of a walker at time `t`. */
export function walkerState(w: Walkers, i: number, t: number): FigureState {
  const k = w.walkers[i]!;
  const { position, forward } = walkerPlace(w, i, t);
  return {
    kind: 'pathfinder',
    variant: k.variant,
    position,
    forward,
    up: [0, 1, 0],
    motion: k.motion,
    // The metres walked, as passes of the motion: the feet keep their place on the ground.
    time: ((k.startM + WALK_SPEED * t) / STRIDE_M) * WALK_S,
    seed: k.seed,
  };
}

/** Every walker's figure at time `t`. */
export function walkerStates(w: Walkers, t: number): FigureState[] {
  return w.walkers.map((_, i) => walkerState(w, i, t));
}
