// What a path is made of, stretch by stretch: a pure function of the path plan, the field and the cover. A path is
// not one surface from end to end. Where it climbs it becomes stone steps, across a narrow water a footbridge, across
// a wide one stepping stones, over damp level ground by the water a walk of boards, at the places it joins a few
// metres of laid flags, in a meadow now a trodden line and now stones a stride apart.
//
// The kinds decide two things: what `pathProps` builds along the stretch (path-props.ts) and how much bare earth the
// ground's material shows there (`wear`, carried by the ground's vertices).

import { hashInts } from 'wallhammer-web/gen-core';
import type { Field } from './field.ts';
import { groundHeightAt } from './ground-mesh.ts';
import { PATH_STATION_M, type PathHit, type PathPlan } from './paths.ts';
import { coverAt, type Cover } from './trees.ts';

export const KIND = { earth: 0, stones: 1, flags: 2, steps: 3, boards: 4, ford: 5, bridge: 6 } as const;
export const KIND_NAMES = ['earth', 'stones', 'flags', 'steps', 'boards', 'ford', 'bridge'] as const;

export interface PathKinds {
  /** Per path, per station: one of `KIND`. */
  kind: Uint8Array[];
  /** Per path, per station, 0–1: how much trodden earth shows on the ground (0 none, 1 a full tread). */
  wear: Float32Array[];
  /** Per path, per station: the height of what is walked on over the ground, metres (stones, flags, boards). */
  lift: Float32Array[];
  /** Per path, per station: the height of a bridge's deck there, metres; NaN off a bridge. */
  deck: Float32Array[];
  bridges: Bridge[];
}

/** A footbridge: straight from station `a` to station `b` of a path, its deck arched between the two banks. */
export interface Bridge {
  path: number;
  a: number;
  b: number;
  /** The first end, the unit direction to the other and the length, metres. */
  x: number;
  z: number;
  tx: number;
  tz: number;
  lengthM: number;
  /** Deck height at the two ends and the rise of the arch in the middle, metres. */
  ya: number;
  yb: number;
  arch: number;
}

/** Height of a bridge's deck `d` metres from its first end. */
export const deckAt = (b: Bridge, d: number): number => b.ya + ((b.yb - b.ya) * d) / b.lengthM + b.arch * 4 * (d / b.lengthM) * (1 - d / b.lengthM);

/** A ford's stones stand this far over the water, metres (path-props.ts builds them, the walkers step on them). */
export const FORD_TOP_M = 0.13;

/**
 * Height of what is walked on at a point of a path (`hit` names the stretch, from `pathAt`): a bridge's deck, the
 * tops of a ford's stones, or the ground with what lies on it.
 */
export function treadAt(k: PathKinds, f: Field, hit: PathHit, x: number, z: number): number {
  const kind = k.kind[hit.path]!;
  const hi = Math.min(kind.length - 1, hit.i + 1);
  const at = hit.t < 0.5 ? hit.i : hi;
  const ground = groundHeightAt(f, x, z);
  if (kind[at] === KIND.bridge) {
    const deck = k.deck[hit.path]!;
    const a = Number.isNaN(deck[hit.i]!) ? ground : deck[hit.i]!;
    const b = Number.isNaN(deck[hi]!) ? ground : deck[hi]!;
    return a + (b - a) * hit.t;
  }
  if (kind[at] === KIND.ford) {
    const i = Math.min(f.n - 1, Math.max(0, Math.round((x - f.x0) / f.step)));
    const j = Math.min(f.n - 1, Math.max(0, Math.round((z - f.z0) / f.step)));
    const level = f.water[j * f.n + i]!;
    return level > ground - FORD_TOP_M + 0.09 ? level + FORD_TOP_M : ground + 0.09;
  }
  const lift = k.lift[hit.path]!;
  return ground + lift[hit.i]! + (lift[hi]! - lift[hit.i]!) * hit.t;
}

/** A water no wider than this (and wider than 2 m) gets a footbridge, any other stepping stones, metres. */
const BRIDGE_MAX_M = 19;
/** A stretch steeper than this is stepped. */
const STEP_GRADE = 0.2;
/** Boards lie where the water is this near (cover's `damp`) and the ground this level. */
const BOARD_DAMP = 0.8;
const BOARD_GRADE = 0.06;
/** Top of the boards over the ground, metres, and the length of the ramp at each end of a walk of boards. */
export const BOARD_LIFT_M = 0.16;
const BOARD_RAMP_M = 3;
/** Flags are laid this far from a named place, metres. */
const FLAGS_M = 14;
/** Bare earth shown per kind, and the height of its stones over the ground, metres. */
const WEAR = [1, 0.3, 0.75, 0.85, 0.12, 0, 0.5];
const STONE_LIFT_M = [0, 0.05, 0.045, 0, 0, 0, 0];

/** A number in 0–1 from integers. */
export const unit = (...keys: number[]): number => hashInts(0x5eed, ...keys) / 4294967296;

/** Smooth noise along a line: 0–1, one value every unit of `t`. */
export function noise1(t: number, key: number): number {
  const i = Math.floor(t);
  const u = t - i;
  const a = unit(key, i);
  const b = unit(key, i + 1);
  return a + (b - a) * u * u * (3 - 2 * u);
}

/** Runs of `k` shorter than `least` stations go back to earth; gaps of earth up to `gap` stations inside it are filled first. */
function tidy(kind: Uint8Array, k: number, least: number, gap: number): void {
  const n = kind.length;
  for (let i = 0; i < n; ) {
    if (kind[i] !== KIND.earth) {
      i++;
      continue;
    }
    let e = i;
    while (e + 1 < n && kind[e + 1] === KIND.earth) e++;
    if (i > 0 && e < n - 1 && kind[i - 1] === k && kind[e + 1] === k && e - i + 1 <= gap) kind.fill(k, i, e + 1);
    i = e + 1;
  }
  for (let i = 0; i < n; ) {
    if (kind[i] !== k) {
      i++;
      continue;
    }
    let e = i;
    while (e + 1 < n && kind[e + 1] === k) e++;
    if (e - i + 1 < least) kind.fill(KIND.earth, i, e + 1);
    i = e + 1;
  }
}

export function pathKinds(pp: PathPlan, f: Field, cover: Cover, seed: number): PathKinds {
  const out: PathKinds = { kind: [], wear: [], lift: [], deck: [], bridges: [] };
  const groundAt = (x: number, z: number): number => {
    const i = Math.min(f.n - 1, Math.max(0, Math.round((x - f.x0) / f.step)));
    const j = Math.min(f.n - 1, Math.max(0, Math.round((z - f.z0) / f.step)));
    return f.ground[j * f.n + i]!;
  };
  pp.paths.forEach((p, id) => {
    const n = p.n;
    const kind = new Uint8Array(n);
    const key = hashInts(seed, 0x9a7, id);
    const grade = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2);
      const b = Math.min(n - 1, i + 2);
      grade[i] = Math.abs(p.y[b]! - p.y[a]!) / Math.max(1, (b - a) * PATH_STATION_M);
    }
    // Steps where it climbs.
    for (let i = 0; i < n; i++) if (grade[i]! > STEP_GRADE) kind[i] = KIND.steps;
    tidy(kind, KIND.steps, 3, 3);
    // Boards over damp level ground, in stretches.
    for (let i = 0; i < n; i++) {
      if (kind[i] !== KIND.earth || grade[i]! > BOARD_GRADE) continue;
      const damp = coverAt(cover, cover.damp, p.x[i]!, p.z[i]!);
      if (damp > BOARD_DAMP && noise1((i * PATH_STATION_M) / 70, key + 1) > 0.52) kind[i] = KIND.boards;
    }
    tidy(kind, KIND.boards, 7, 2);
    // Stones a stride apart in the open, in stretches; under trees the line stays earth.
    for (let i = 0; i < n; i++) {
      if (kind[i] !== KIND.earth) continue;
      const wood = coverAt(cover, cover.wood, p.x[i]!, p.z[i]!);
      if (wood < 0.35 && noise1((i * PATH_STATION_M) / 46, key + 2) > 0.5) kind[i] = KIND.stones;
    }
    tidy(kind, KIND.stones, 6, 2);
    // Laid flags at the named places.
    const flags = Math.round(FLAGS_M / PATH_STATION_M);
    const named = (place: number): boolean => pp.places[place]!.name !== 'junction';
    for (let i = 0; i < Math.min(flags, n); i++) {
      if (named(p.from) && (kind[i] === KIND.earth || kind[i] === KIND.stones)) kind[i] = KIND.flags;
      if (named(p.to) && (kind[n - 1 - i] === KIND.earth || kind[n - 1 - i] === KIND.stones)) kind[n - 1 - i] = KIND.flags;
    }
    // The crossings last, over whatever lies there: each run of ford stations with a station of bank either side.
    for (let i = 0; i < n; ) {
      if (!p.ford[i]) {
        i++;
        continue;
      }
      let e = i;
      while (e + 1 < n && p.ford[e + 1]) e++;
      let level = -Infinity;
      for (let q = i; q <= e; q++) {
        const fi = Math.min(f.n - 1, Math.max(0, Math.round((p.x[q]! - f.x0) / f.step)));
        const fj = Math.min(f.n - 1, Math.max(0, Math.round((p.z[q]! - f.z0) / f.step)));
        level = Math.max(level, f.water[fj * f.n + fi]!);
      }
      // Out to ground that stands clear of the water.
      let a = Math.max(0, i - 1);
      let b = Math.min(n - 1, e + 1);
      for (let more = 0; more < 3 && a > 0 && groundAt(p.x[a]!, p.z[a]!) < level + 0.3; more++) a--;
      for (let more = 0; more < 3 && b < n - 1 && groundAt(p.x[b]!, p.z[b]!) < level + 0.3; more++) b++;
      const wide = Math.hypot(p.x[b]! - p.x[a]!, p.z[b]! - p.z[a]!);
      const bridged = wide <= BRIDGE_MAX_M && wide > 2;
      kind.fill(bridged ? KIND.bridge : KIND.ford, a, b + 1);
      if (bridged) {
        const ya = groundHeightAt(f, p.x[a]!, p.z[a]!) + 0.05;
        const yb = groundHeightAt(f, p.x[b]!, p.z[b]!) + 0.05;
        // Arched just enough to carry its beams over the water.
        const arch = Math.max(0.16 + 0.014 * wide, level + 0.6 - (ya + yb) / 2);
        out.bridges.push({ path: id, a, b, x: p.x[a]!, z: p.z[a]!, tx: (p.x[b]! - p.x[a]!) / wide, tz: (p.z[b]! - p.z[a]!) / wide, lengthM: wide, ya, yb, arch });
      }
      i = e + 1;
    }
    const deck = new Float32Array(n).fill(NaN);
    for (const br of out.bridges) {
      if (br.path !== id) continue;
      for (let q = br.a; q <= br.b; q++) deck[q] = deckAt(br, Math.min(br.lengthM, Math.max(0, (p.x[q]! - br.x) * br.tx + (p.z[q]! - br.z) * br.tz)));
    }
    // The earth shown and the lift, eased along the path so no kind begins on a line.
    const wear = new Float32Array(n);
    const lift = new Float32Array(n);
    const ramp = Math.max(1, Math.round(BOARD_RAMP_M / PATH_STATION_M));
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let q = Math.max(0, i - 2); q <= Math.min(n - 1, i + 2); q++) {
        sum += WEAR[kind[q]!]!;
        count++;
      }
      wear[i] = sum / count;
      lift[i] = STONE_LIFT_M[kind[i]!]!;
      if (kind[i] !== KIND.boards) continue;
      let inside = ramp;
      for (let q = 1; q <= ramp; q++) if (i - q < 0 || i + q >= n || kind[i - q] !== KIND.boards || kind[i + q] !== KIND.boards) inside = Math.min(inside, q);
      lift[i] = (BOARD_LIFT_M * inside) / ramp;
    }
    out.kind.push(kind);
    out.wear.push(wear);
    out.lift.push(lift);
    out.deck.push(deck);
  });
  return out;
}

/** Metres of every kind over all paths, by the kinds' names. */
export function kindStats(k: PathKinds): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of KIND_NAMES) out[name] = 0;
  for (const kind of k.kind) for (const v of kind) out[KIND_NAMES[v]!]! += PATH_STATION_M;
  return out;
}
