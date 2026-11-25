// Brooks: the small watercourses that feed the lines, narrower than the ground's grid can draw. A pure function of
// the plan, the field and a threshold of basin.
//
// The lines take only the nodes of the plan's grid with a basin of `MIN_FLOW` nodes or more, and their water is the
// one sheet over the ground (water-mesh.ts), which cannot be narrower than a few cells of the ground. A brook is
// different on both counts:
//   1. Where: the engine traces the channels of the plan's drainage from the brooks' threshold on (`traceChannels`),
//      orders them (`channelOrder`), reads the flow along them (`channelFlow`) and sorts them into classes by their
//      flow (`classifyByThresholds`): brook, stream, and river, which is the lines' and is left to them. A brook runs
//      from its spring down its channel into another brook (a tributary into its stem), or on to the water of a line,
//      a lake or the sea, which it ends a little inside.
//   2. Its course: the chain of nodes smoothed, slid into the lowest ground beside it, given a small wander on level
//      ground, and cut where it first reaches standing or running water.
//   3. Its height: the top of its banks follows the lowest ground across it, falling from spring to mouth and never
//      rising; a tributary's banks come down to its stem's where it enters. The water lies a few centimetres under the
//      banks.
//   4. Its shape: two strips of the engine (`stripNet`) along the course, one for the bed with its banks and one for
//      the water, with no nodes: a tributary's strips end on its stem's middle, faded out. The ground is cut under the bed
//      (`stripCarve`, never raising it, never under water that may stand there, and not across a path's tread, where
//      the brook runs over the path as a ford), and the strips are meshed over the ground as it is drawn
//      (brook-mesh.ts), so they lie on it and never under it.

import { hashInts, stripCarve, stripNet, valueNoise3 } from 'wallhammer-web/gen-core';
import type { StripLine, StripNet, StripProfile } from 'wallhammer-web/gen-core';
import { channelFlow, channelOrder, classifyByThresholds, traceChannels } from 'wallhammer-web/gen-plan';
import type { Field } from './field.ts';
import { HALF_M, smooth } from './land.ts';
import { GRID_M, GRID_N, MIN_FLOW, average, nearestOn, normals, relax, resample, type Plan } from './plan.ts';
import { pathAt, type PathHit, type PathPlan } from './paths.ts';

/** A brook starts from this basin by default, in nodes of the plan's grid (`GRID_M` squared each): 1.6 ha. */
export const DEFAULT_BROOK_FLOW = 40;
/** The least and the largest threshold the page accepts: below it every hollow has a brook, above it are the lines. */
export const MIN_BROOK_FLOW = 8;
export const MAX_BROOK_FLOW = MIN_FLOW - 1;
/** From this basin on a brook is a stream: wider and deeper. */
const STREAM_FLOW = 110;
/** Spacing of the points of a brook, metres. */
export const STEP_M = 1.25;

/** A class of watercourse: the depth of its bed and how far its water lies under its banks, metres. */
interface BrookClass {
  name: string;
  depthM: number;
  underM: number;
}
/** The classes the page draws, by `classifyByThresholds` over [threshold, `STREAM_FLOW`, `MIN_FLOW`] less one. */
export const BROOK_CLASSES: readonly BrookClass[] = [
  { name: 'brook', depthM: 0.4, underM: 0.15 },
  { name: 'stream', depthM: 0.55, underM: 0.2 },
];
/** The strip's half-width from the least basin to the largest, metres. The water is about 1.5 times as wide. */
const HALF_MIN_M = 0.55;
const HALF_SPAN_M = 1.05;
/** The water reaches this share of the strip's half-width: a little under the bank, so its edge is hidden. */
export const WATER_SHARE = 0.7;
/** The width wanders by up to this share, over about this many metres: wider on level stretches (pools), narrower on
 * steeper ones (riffles). The water's share of the bed wanders on its own by `SHARE_WANDER`, so the edges of the
 * water and of the bank are never parallel. */
const WIDTH_WANDER = 0.35;
const WIDTH_WAVE_M = 18;
const SHARE_WANDER = 0.12;
const SHARE_WAVE_M = 7;
/** Near a mouth and where a tributary enters its stem the water covers this share of the bed. */
const FULL_SHARE = 0.97;
/** A spring widens to the full brook over this many metres, from this share of it. */
const SPRING_M = 30;
const SPRING_SHARE = 0.45;
/** The ground is cut this far under the bed, and returns to its own height over this many metres beyond the bank. */
const BED_M = 0.06;
export const SHOULDER_M = 3;
/** Over this many metres before its shore a brook's water comes down to the level of the water it runs into. */
const MOUTH_FADE_M = 6;
/** A brook's water lies this far over the water it runs into, at the least, until its mouth, metres. */
const MOUTH_OVER_M = 0.01;
/** The ground beside a line, a lake or the sea is never cut lower than this over its water, metres. */
const DRY_CUT_M = 0.04;
/**
 * A brook that reaches the water of a line, a lake or the sea goes on this many metres past its shore, under that
 * water: its own water sinks `DIVE_M` under the level there and fades out (brook-mesh.ts), so its end is never seen.
 */
const MOUTH_IN_M = 6;
const DIVE_M = 0.06;
/**
 * Beside the last metres of a brook before its shore no shoulder is cut, only the cells its strip touches, and the
 * shoulder returns over `MOUTH_EASE_M` above them: a shoulder there would flatten the bank round the mouth to the level
 * of the water, a shelf wider than the brook.
 */
const MOUTH_FREE_M = 3;
const MOUTH_EASE_M = 6;
/**
 * Brooks that run together merge: where the end of one comes within `MERGE_WIDTHS` widths (and at least
 * `MERGE_MIN_M`) of another, for `MERGE_RUN_M` or more, or ends against its flank, it joins it at a junction where it
 * first came that near. It meets it at a slant, `JOIN_APPROACH_M` or more downstream of that place; the junction stands
 * at least `MIN_DOWN_M` before the end of the brook it joins.
 */
const MERGE_WIDTHS = 3;
const MERGE_MIN_M = 6;
const MERGE_RUN_M = 3;
const JOIN_APPROACH_M = 4;
const MIN_DOWN_M = 14;
/** `brookCrowding`: mouths nearer each other than this are crowded; brooks side by side for longer are twins. */
const CROWDED_M = 15;
const TWIN_M = 6;
/** Two brooks that end at one junction are joined further up when they run together for more than this, metres. */
const JOINT_RUN_M = 6;
/**
 * A tributary enters its stem at this angle to it (45°), pointing downstream, radians; at least `ENTRY_GAP_WIDTHS` of the
 * stem's widths (and `ENTRY_GAP_MIN_M`) from another tributary's entry and at least `ENTRY_END_M` before the stem's
 * end or shore. The stem's basin grows by the tributary's over `ENTRY_GROW_M` below its entry, and so does its width.
 */
const ENTRY_ANGLE = 0.79;
const ENTRY_GAP_WIDTHS = 4;
const ENTRY_GAP_MIN_M = 8;
const ENTRY_END_M = 6;
const ENTRY_GROW_M = 10;
/** Below an entry the stem is at most this many times as wide as above it, for twice `ENTRY_GROW_M`; then the bound
 * grows by `JOIN_WIDEN_EASE` per metre. */
const JOIN_WIDEN = 1.3;
const JOIN_WIDEN_EASE = 0.02;
/** About how many metres before its shore a brook's water takes the look of the water it runs into (brook-mesh.ts): a
 * tributary enters a stem above that and the stem's `MOUTH_FADE_M` where it can. */
const TO_RIVER_M = 8.5;

/** A strip is never wider than this share of the radius of its bend, so its inner edge never folds over. */
const BEND_SHARE = 0.8;
/** A joined course leaves out a point where it turns by more than this, radians. */
const SHARP_TURN = 1.6;
/** A brook shorter than this is left out, metres. */
const MIN_LENGTH_M = 24;
/** How far a brook's middle slides into lower ground, metres. */
const SLIDE_M = 6;
/** The meander on level ground: a whole bend's length and its depth, in widths of the water; the tightest bend's
 * radius in widths; the grade over which it fades out (full under the first, none over the second); metres over
 * which it eases in from either end. */
const MEANDER_WAVE: readonly [number, number] = [8, 15];
const MEANDER_DEPTH: readonly [number, number] = [1, 2.5];
const MIN_RADIUS = 2.2;
const MEANDER_GRADE: readonly [number, number] = [0.045, 0.13];
const MEANDER_EASE_M = 6;
/** A tributary's banks come down to its stem's at most this steeply. */
const JOIN_GRADE = 0.06;
/** The ground at such a point lies at least this far under the brook's water, metres. */
const UNDER_WATER_M = 0.08;
/** How far beyond a strip's edge the field's distance to it is measured, metres. */
const EDGE_REACH_M = 6;

/** One half of the bed's section: across in half-widths, down in depths of the bed, from the bank to the middle. */
const SECTION = [1, 0, 0.84, -0.12, 0.6, -0.62, 0, -1];

/** The bed's height against the top of its banks (0 or less) at `a` half-widths across, for a bed `d` metres deep. */
export function bedBelow(a: number, d: number): number {
  const x = Math.min(1, Math.abs(a));
  for (let k = 0; k + 3 < SECTION.length; k += 2) {
    const x0 = SECTION[k]!;
    const x1 = SECTION[k + 2]!;
    if (x <= x0 && x >= x1) return d * (SECTION[k + 3]! + ((SECTION[k + 1]! - SECTION[k + 3]!) * (x - x1)) / (x0 - x1));
  }
  return -d;
}

/** The bed's section across, in half-widths of the strip, for a bed `d` metres deep: a cut bank, a dished bed. */
const bedSection = (d: number): number[] => {
  const half = SECTION.map((v, k) => (k % 2 ? v * d : v));
  const out: number[] = [];
  for (let k = 0; k < half.length; k += 2) out.push(-half[k]!, half[k + 1]!);
  for (let k = half.length - 4; k >= 0; k -= 2) out.push(half[k]!, half[k + 1]!);
  return out;
};

export interface Brook {
  n: number;
  x: Float64Array;
  z: Float64Array;
  /** Height of the top of its banks per point, metres. Never rises along the brook. */
  bank: Float64Array;
  /** Height of its water per point, metres: `underM` of its class under the banks, level with them at a mouth. */
  water: Float64Array;
  /** Half-width of its strip (the bed and its banks) per point, metres. */
  half: Float64Array;
  /** The share of that half-width its water covers, per point. */
  share: Float64Array;
  /** Per point the bend: x and z of the change of direction per metre (toward the inside of the bend, 1/radius). */
  bend: Float32Array;
  /** Index into `BROOK_CLASSES`. */
  kind: number;
  /** Strahler order of its channel. */
  order: number;
  /** Basin at its end, nodes. */
  flow: number;
  /** A tributary: the place it enters its stem (an index into `BrookPlan.nodes`); −1 for a brook that ends free or in
   * the water of a line, a lake or the sea. */
  to: number;
  /** A tributary: metres along it to where it leaves its own course and curves into its stem; Infinity otherwise. */
  leaveM: number;
  /** 1 when it ends in the water of a line, a lake or the sea. */
  intoWater: number;
  /**
   * Metres along it to its shore, where it reaches that water (Infinity when it does not); it ends `MOUTH_IN_M` on. For
   * a tributary, where it reaches its stem's edge (the stem's strip covers it on); it ends on the stem's middle.
   */
  shoreM: number;
}

export interface BrookPlan {
  threshold: number;
  brooks: Brook[];
  /**
   * Junctions: where a tributary enters its stem, a point of the stem's middle, with the height of the stem's banks
   * there, the stem (an index into `brooks`) and the tributary's basin.
   */
  nodes: { x: number; z: number; bank: number; stem: number; flow: number }[];
  /** The strips of the beds and of the water (one line per brook, in the same order). */
  bed: StripNet;
  water: StripNet;
  /** Per line of the strips: metres along its brook to the line's first point (the strips' `along` starts there). */
  starts: Float64Array;
  /**
   * Per point of the field: metres from the edge of the nearest brook's strip (negative inside it), up to
   * `EDGE_REACH_M`; `EDGE_REACH_M` farther away.
   */
  edge: Float32Array;
  /** Per point of the field within `EDGE_REACH_M` of a brook: the height of that brook's water there; NaN elsewhere. */
  level: Float32Array;
  /** Per point of the field: 1 near the last metres of a brook before its shore, where no shoulder is cut beside it. */
  mouth: Float32Array;
}

/** A value of the field at a point, bilinear (clamped to the square). */
function fieldAt(f: Field, v: Float32Array, x: number, z: number): number {
  const fx = Math.min(f.n - 1.0001, Math.max(0, (x - f.x0) / f.step));
  const fz = Math.min(f.n - 1.0001, Math.max(0, (z - f.z0) / f.step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const w = fz - j;
  const k = j * f.n + i;
  return (v[k]! * (1 - u) + v[k + 1]! * u) * (1 - w) + (v[k + f.n]! * (1 - u) + v[k + f.n + 1]! * u) * w;
}

/** The highest level of a line, a lake or the sea named at the corners of a point's field cell; −∞ for none. */
function levelNear(f: Field, x: number, z: number): number {
  const i = Math.min(f.n - 2, Math.max(0, Math.floor((x - f.x0) / f.step)));
  const j = Math.min(f.n - 2, Math.max(0, Math.floor((z - f.z0) / f.step)));
  let level = -Infinity;
  for (const k of [j * f.n + i, j * f.n + i + 1, (j + 1) * f.n + i, (j + 1) * f.n + i + 1]) if (f.body[k] !== 0) level = Math.max(level, f.water[k]!);
  return level;
}

/** Whether water stands at a point: any corner of the field's cell around it is wet. */
function wetAt(f: Field, x: number, z: number): boolean {
  const i = Math.min(f.n - 2, Math.max(0, Math.floor((x - f.x0) / f.step)));
  const j = Math.min(f.n - 2, Math.max(0, Math.floor((z - f.z0) / f.step)));
  for (const k of [j * f.n + i, j * f.n + i + 1, (j + 1) * f.n + i, (j + 1) * f.n + i + 1]) if (f.water[k]! > f.ground[k]! + 0.02) return true;
  return false;
}

/** The highest level of the water standing at the corners of a point's field cell; −∞ for none. */
function wetLevel(f: Field, x: number, z: number): number {
  const i = Math.min(f.n - 2, Math.max(0, Math.floor((x - f.x0) / f.step)));
  const j = Math.min(f.n - 2, Math.max(0, Math.floor((z - f.z0) / f.step)));
  let level = -Infinity;
  for (const k of [j * f.n + i, j * f.n + i + 1, (j + 1) * f.n + i, (j + 1) * f.n + i + 1]) if (f.water[k]! > f.ground[k]! + 0.02) level = Math.max(level, f.water[k]!);
  return level;
}

/** Per point of a course, its bend:the change of its direction per metre, as x z pairs, over ±2 points, eased. */
function bendOf(x: Float64Array, z: Float64Array): Float32Array {
  const n = x.length;
  const raw = new Float64Array(2 * n);
  for (let i = 2; i < n - 2; i++) {
    const ax = x[i]! - x[i - 2]!;
    const az = z[i]! - z[i - 2]!;
    const bx = x[i + 2]! - x[i]!;
    const bz = z[i + 2]! - z[i]!;
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    const ds = 0.5 * (la + lb);
    raw[2 * i] = (bx / lb - ax / la) / ds;
    raw[2 * i + 1] = (bz / lb - az / la) / ds;
  }
  const out = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sz = 0;
    let w = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) {
      sx += raw[2 * k]!;
      sz += raw[2 * k + 1]!;
      w++;
    }
    out[2 * i] = sx / w;
    out[2 * i + 1] = sz / w;
  }
  return out;
}

/** The width of a brook's water for a basin of `flow` nodes, metres (before its wander along). */
function waterWidth(flow: number, threshold: number): number {
  const share = Math.pow(Math.min(1, Math.max(0, (flow - threshold) / Math.max(1, MIN_FLOW - threshold))), 0.6);
  return 2 * WATER_SHARE * (HALF_MIN_M + HALF_SPAN_M * share);
}

/**
 * The small meander of a brook on level ground: a chain of half-bends, each to the other side than the last (now and
 * then two to one side), each with its own length (`MEANDER_WAVE` times the water's width, the whole bend) and depth
 * (`MEANDER_DEPTH` times it), from the brook's own stream of hashes, so it never repeats like a wave. A bend is never
 * tighter than `MIN_RADIUS` widths. It fades out as the ground grows steeper and toward both ends, so junctions and
 * mouths stay where they are. Returns the course on 1 m.
 */
function meander(c: { x: Float64Array; z: Float64Array; v: Float64Array }, id: number, seed: number, threshold: number, ground: (x: number, z: number) => number): { x: Float64Array; z: Float64Array; v: Float64Array } {
  const base = resample(c.x, c.z, c.v, 1);
  const m = base.x.length;
  if (m < 8) return base;
  const raw = normals(base.x, base.z);
  // Normals of a polyline jump at its corners: averaged over a few metres.
  const ax = average(raw.nx, 3);
  const az = average(raw.nz, 3);
  const r = (k: number, q: number): number => hashInts(seed, 0xb7e, id, k, q) / 4294967296;
  const off = new Float64Array(m);
  let side = r(0, 0) < 0.5 ? 1 : -1;
  for (let at = 0, k = 1; at < m; k++) {
    const w = waterWidth(base.v[Math.min(m - 1, at)]!, threshold);
    const wave = w * (MEANDER_WAVE[0] + (MEANDER_WAVE[1] - MEANDER_WAVE[0]) * r(k, 1));
    const len = Math.max(2, Math.round(wave / 2));
    // A half-sine of depth A over L metres bends at most A·π²/L²: kept at or under 1 / (MIN_RADIUS · w).
    const most = (len * len) / (Math.PI * Math.PI * MIN_RADIUS * w);
    const depth = Math.min(most, w * (MEANDER_DEPTH[0] + (MEANDER_DEPTH[1] - MEANDER_DEPTH[0]) * r(k, 2)));
    for (let i = 0; i < len && at + i < m; i++) off[at + i] = side * depth * Math.sin((Math.PI * (i + 0.5)) / len);
    at += len;
    side = r(k, 3) < 0.15 ? side : -side;
  }
  // How level the ground is along the course, over ±4 m.
  const level = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 4);
    const b = Math.min(m - 1, i + 4);
    const grade = Math.abs(ground(base.x[a]!, base.z[a]!) - ground(base.x[b]!, base.z[b]!)) / Math.max(1, b - a);
    level[i] = smooth(MEANDER_GRADE[1], MEANDER_GRADE[0], grade);
  }
  const lv = average(level, 6);
  const x = new Float64Array(m);
  const z = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const l = Math.hypot(ax[i]!, az[i]!) || 1;
    const o = off[i]! * lv[i]! * smooth(0, MEANDER_EASE_M, i) * smooth(0, MEANDER_EASE_M, m - 1 - i);
    x[i] = base.x[i]! + (ax[i]! / l) * o;
    z[i] = base.z[i]! + (az[i]! / l) * o;
  }
  relax(x, z, 1);
  return { x, z, v: base.v };
}

/**
 * A course joined from pieces, tidied: points where it turns back on itself (more than `SHARP_TURN` radians) are left
 * out, it is spaced every `STEP_M` again and its corners are eased; its ends stay.
 */
function tidy(x: Float64Array, z: Float64Array, v: Float64Array): { x: Float64Array; z: Float64Array; v: Float64Array } {
  const keep: number[] = [0];
  for (let i = 1; i < x.length - 1; i++) {
    const p = keep[keep.length - 1]!;
    const ax = x[i]! - x[p]!;
    const az = z[i]! - z[p]!;
    const bx = x[i + 1]! - x[i]!;
    const bz = z[i + 1]! - z[i]!;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 0.3 * STEP_M || (lb > 1e-9 && (ax * bx + az * bz) / (la * lb) < Math.cos(SHARP_TURN))) continue;
    keep.push(i);
  }
  keep.push(x.length - 1);
  const r = resample(Float64Array.from(keep, (i) => x[i]!), Float64Array.from(keep, (i) => z[i]!), Float64Array.from(keep, (i) => v[i]!), STEP_M);
  relax(r.x, r.z, 2);
  return r;
}

/** The brooks of a plan over its field, from a basin of `threshold` nodes on. */
export function brookPlan(plan: Plan, f: Field, threshold: number): BrookPlan {
  const seed = plan.seed;
  const { to, flow, order } = plan.drain;
  const count = to.length;
  const nodeX = (i: number): number => -HALF_M + (i % GRID_N) * GRID_M;
  const nodeZ = (i: number): number => -HALF_M + Math.floor(i / GRID_N) * GRID_M;
  const ground = (x: number, z: number): number => fieldAt(f, f.ground, x, z);
  /** The first point of a course whose ground lies under the water's level, −1 for none. */
  const shoreOf = (x: Float64Array, z: Float64Array): number => {
    for (let i = 0; i < x.length; i++) if (wetAt(f, x[i]!, z[i]!)) {
      for (let k = i; k < Math.min(x.length, i + 4); k++) if (fieldAt(f, f.water, x[k]!, z[k]!) > fieldAt(f, f.ground, x[k]!, z[k]!)) return k;
      return i;
    }
    return -1;
  };

  const ch = traceChannels({ count }, { to, flow, pool: new Uint16Array(count), order }, { minFlow: threshold });
  const channels = ch.into.length;
  const strahler = channelOrder(ch);
  const along = channelFlow(ch, flow);
  // 1 brook, 2 stream, 3 the lines' (a channel is classed by the flow it hands on).
  const kindOf = classifyByThresholds(along.out, [threshold, Math.max(threshold, STREAM_FLOW), MIN_FLOW]);
  // How many brook channels end where each channel starts: two or more make a junction.
  const inflows = new Uint8Array(channels);
  for (let c = 0; c < channels; c++) if (ch.into[c]! >= 0) inflows[ch.into[c]!] = Math.min(255, inflows[ch.into[c]!]! + 1);

  interface Draft {
    x: Float64Array;
    z: Float64Array;
    f: Float64Array;
    kind: number;
    order: number;
    flow: number;
    /** Grid node of the junction at either end, −1 for none. */
    fromNode: number;
    toNode: number;
    intoWater: number;
    /** The first point in the water it runs into, −1 for none. */
    shore: number;
    /** A tributary: its number (it ended at a junction where another brook in runs on). */
    trib?: number | undefined;
    /** Once led into it: its stem, the point of the stem it enters at and its own point where it leaves its course. */
    stem?: Draft;
    entry?: number;
    leave?: number;
  }
  const drafts: Draft[] = [];
  for (let c = 0; c < channels; c++) {
    const a = ch.start[c]!;
    const b = ch.start[c + 1]!;
    if (flow[ch.nodes[a]!]! >= MIN_FLOW) continue;
    let last = b - 1;
    for (let k = a; k < b; k++)
      if (flow[ch.nodes[k]!]! >= MIN_FLOW) {
        last = k;
        break;
      }
    const px: number[] = [];
    const pz: number[] = [];
    const pf: number[] = [];
    for (let k = a; k <= last; k++) {
      const n = ch.nodes[k]!;
      px.push(nodeX(n));
      pz.push(nodeZ(n));
      pf.push(Math.min(flow[n]!, MIN_FLOW));
    }
    const endNode = ch.nodes[last]!;
    let toNode = -1;
    if (flow[endNode]! >= MIN_FLOW) {
      // It reaches a line: on to the nearest point of the channel of the line that passes nearest.
      let best = 80;
      let bx = 0;
      let bz = 0;
      for (const l of plan.lines) {
        const hit = nearestOn(l.cx, l.cz, nodeX(endNode), nodeZ(endNode));
        if (hit.d < best) {
          best = hit.d;
          bx = l.cx[hit.i]! + (l.cx[hit.i + 1]! - l.cx[hit.i]!) * hit.t;
          bz = l.cz[hit.i]! + (l.cz[hit.i + 1]! - l.cz[hit.i]!) * hit.t;
        }
      }
      if (best < 80 && Math.hypot(bx - px[px.length - 1]!, bz - pz[pz.length - 1]!) > 1) {
        px.push(bx);
        pz.push(bz);
        pf.push(pf[pf.length - 1]!);
      } else {
        // No line near: on down the drainage a little; the water cuts it off where it starts.
        for (let k = 0, n = endNode; k < 3 && to[n]! >= 0; k++) {
          n = to[n]!;
          px.push(nodeX(n));
          pz.push(nodeZ(n));
          pf.push(pf[pf.length - 1]!);
        }
      }
    } else if (ch.into[c]! >= 0 && inflows[ch.into[c]!]! >= 2) toNode = endNode;
    const fromNode = inflows[c]! >= 2 ? ch.nodes[a]! : -1;
    if (px.length < 2) continue;
    // A channel that becomes a line on the way is classed by its brook part: a stream.
    const kind = Math.min(BROOK_CLASSES.length, Math.max(1, kindOf[c]!)) - 1;
    drafts.push({ x: Float64Array.from(px), z: Float64Array.from(pz), f: Float64Array.from(pf), kind, order: strahler[c]!, flow: Math.min(along.out[c]!, pf[pf.length - 1]!), fromNode, toNode, intoWater: 0, shore: -1 });
  }

  // --- 2. The courses ------------------------------------------------------------------------------------------------
  const courses: Draft[] = [];
  for (let id = 0; id < drafts.length; id++) {
    const d = drafts[id]!;
    const rx = Float64Array.from(d.x);
    const rz = Float64Array.from(d.z);
    relax(rx, rz, 2);
    let mid = resample(rx, rz, d.f, 4);
    relax(mid.x, mid.z, 3);
    for (let round = 0; round < 2; round++) {
      const m = mid.x.length;
      const { nx, nz } = normals(mid.x, mid.z);
      const shift = new Float64Array(m);
      for (let i = 1; i < m - 1; i++) {
        let best = Infinity;
        for (let o = -SLIDE_M; o <= SLIDE_M; o += 1) {
          const h = ground(mid.x[i]! + nx[i]! * o, mid.z[i]! + nz[i]! * o) + 0.04 * Math.abs(o);
          if (h < best) {
            best = h;
            shift[i] = o;
          }
        }
      }
      const eased = average(shift, 2);
      for (let i = 1; i < m - 1; i++) {
        const hold = smooth(0, 3, i) * smooth(0, 3, m - 1 - i);
        mid.x[i] = mid.x[i]! + nx[i]! * eased[i]! * 0.7 * hold;
        mid.z[i] = mid.z[i]! + nz[i]! * eased[i]! * 0.7 * hold;
      }
      relax(mid.x, mid.z, 1);
    }
    mid = meander(mid, id, seed, threshold, ground);
    mid = resample(mid.x, mid.z, mid.v, STEP_M);
    let n = mid.x.length;
    if (wetAt(f, mid.x[0]!, mid.z[0]!)) continue;
    // Cut where it reaches water: its shore is the first point whose ground lies under the water's level, and it goes
    // on `MOUTH_IN_M` past it, straight on where the course ends sooner.
    let toNode = d.toNode;
    let intoWater = 0;
    let shore = -1;
    let x = mid.x;
    let z = mid.z;
    let v = mid.v;
    for (let i = 1; i < n; i++) {
      if (!wetAt(f, x[i]!, z[i]!)) continue;
      shore = i;
      for (let k = i; k < Math.min(n, i + 4); k++)
        if (fieldAt(f, f.water, x[k]!, z[k]!) > fieldAt(f, f.ground, x[k]!, z[k]!)) {
          shore = k;
          break;
        }
      const end = shore + Math.ceil(MOUTH_IN_M / STEP_M);
      if (end < n - 1 || toNode >= 0) toNode = -1;
      if (end >= n) {
        const dx = x[n - 1]! - x[n - 2]!;
        const dz = z[n - 1]! - z[n - 2]!;
        const l = Math.hypot(dx, dz) || 1;
        const gx = new Float64Array(end + 1);
        const gz = new Float64Array(end + 1);
        const gv = new Float64Array(end + 1);
        for (let k = 0; k <= end; k++) {
          const o = Math.max(0, k - n + 1) * STEP_M;
          const at = Math.min(k, n - 1);
          gx[k] = x[at]! + (dx / l) * o;
          gz[k] = z[at]! + (dz / l) * o;
          gv[k] = v[at]!;
        }
        x = gx;
        z = gz;
        v = gv;
      }
      n = end + 1;
      intoWater = 1;
      break;
    }
    if (n < 2) continue;
    courses.push({ x: x.slice(0, n), z: z.slice(0, n), f: v.slice(0, n), kind: d.kind, order: d.order, flow: d.flow, fromNode: d.fromNode, toNode, intoWater, shore });
  }

  // --- 2b. Brooks that run together merge ----------------------------------------------------------------------------
  // Two brooks led into one hollow (two channels of the grid that meet only at a line's head, or a bend of one slid or
  // wandering toward the other) would run side by side, each with its own banks. Where the end of one runs within a
  // few widths of another, it joins that one at a junction instead: the other is split there, its lower part carries
  // both. Junctions made so are numbered from the grid's count on and keep their own place.
  const placeOf = new Map<number, [number, number]>();
  let nextNode = count;
  /** The widest a brook's strip may be for a basin of `flow` nodes, metres (half). */
  const widest = (flow: number): number => (waterWidth(flow, threshold) / (2 * WATER_SHARE)) * (1 + WIDTH_WANDER);
  const runOf = (a: Draft, b: Draft): { m: number; runM: number } | null => {
    const n = a.x.length;
    let m = n;
    for (let k = n - 1; k >= 0; k--) {
      const h = nearestOn(b.x, b.z, a.x[k]!, a.z[k]!);
      if (h.d >= Math.max(MERGE_MIN_M, MERGE_WIDTHS * 2 * Math.max(widest(a.f[k]!), widest(b.f[h.i]!)))) break;
      m = k;
    }
    return m < n ? { m, runM: (n - 1 - m) * STEP_M } : null;
  };
  const boxOf = (c: Draft): [number, number, number, number] => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < c.x.length; i++) {
      x0 = Math.min(x0, c.x[i]!);
      x1 = Math.max(x1, c.x[i]!);
      z0 = Math.min(z0, c.z[i]!);
      z1 = Math.max(z1, c.z[i]!);
    }
    return [x0, x1, z0, z1];
  };
  const downMin = Math.ceil(MIN_DOWN_M / STEP_M);
  const headMin = Math.ceil(10 / STEP_M);
  /** Brooks that come near another but cannot join it there. */
  const apart = new Set<Draft>();
  /** Brooks already led into another: they are not led again (each time a little further up). */
  const led = new Set<Draft>();
  /** Whether the water of course `b` reaches course `a` through junctions (then `a` cannot be led into `b`). */
  const feeds = (b: Draft, a: Draft): boolean => {
    for (let node = b.toNode, hops = 0; node >= 0 && hops < courses.length; hops++) {
      const next = courses.find((c) => c.fromNode === node);
      if (!next) return false;
      if (next === a) return true;
      node = next.toNode;
    }
    return false;
  };
  for (let round = 0; round < 4 * courses.length; round++) {
    const boxes = courses.map(boxOf);
    let best: { a: number; b: number; m: number; runM: number } | null = null;
    for (let a = 0; a < courses.length; a++) {
      const A = courses[a]!;
      // A brook with a free end, in water or on land, is led into another; one that ends at a junction only into
      // another that ends there too, when they run together for longer than they take to meet.
      if (A.x.length < 3 || apart.has(A)) continue;
      const ex = A.x[A.x.length - 1]!;
      const ez = A.z[A.x.length - 1]!;
      for (let b = 0; b < courses.length; b++) {
        if (b === a) continue;
        const B = courses[b]!;
        const box = boxes[b]!;
        const reach = 3 * MERGE_MIN_M + MERGE_WIDTHS * 2 * widest(MIN_FLOW);
        if (ex < box[0] - reach || ex > box[1] + reach || ez < box[2] - reach || ez > box[3] + reach) continue;
        if (A.toNode >= 0 && (B.toNode !== A.toNode || led.has(A))) continue;
        if (feeds(B, A)) continue;
        const run = runOf(A, B);
        if (!run) continue;
        if (A.toNode >= 0) {
          if (run.runM < JOINT_RUN_M || A.flow > B.flow || (A.flow === B.flow && a < b)) continue;
          if (!best || run.runM > best.runM) best = { a, b, ...run };
          continue;
        }
        const flank = nearestOn(B.x, B.z, ex, ez).i < B.x.length - 1 - downMin;
        if (run.runM < MERGE_RUN_M && !(flank && !A.intoWater)) continue;
        // Two ends that run together: the smaller joins the larger.
        if (B.toNode < 0 && runOf(B, A) && (A.flow > B.flow || (A.flow === B.flow && a < b))) continue;
        if (!best || run.runM > best.runM) best = { a, b, ...run };
      }
    }
    if (!best) break;
    const A = courses[best.a]!;
    const B = courses[best.b]!;
    const nb = B.x.length;
    const hm = nearestOn(B.x, B.z, A.x[best.m]!, A.z[best.m]!);
    const approach = Math.max(JOIN_APPROACH_M, 3 * widest(A.f[best.m]!));
    let jP = Math.max(0, Math.min(hm.i + Math.round(approach / STEP_M), nb - 1 - downMin));
    // Where it would meet the other too near that one's spring, the other's head is dropped and this one carries on
    // down its course; too near a junction the other starts at, it joins at that junction.
    const headless = jP < headMin && B.fromNode < 0;
    const atStart = jP < headMin && B.fromNode >= 0;
    if (atStart) jP = 0;
    const px = B.x[jP]!;
    const pz = B.z[jP]!;
    // It leaves its course where it is far enough from the junction to meet it at a slant; one that starts at a
    // junction itself and runs near the other all along goes straight from that junction to this one.
    let cut = -1;
    for (let k = Math.min(best.m, A.x.length - 1) - 1; k >= 1; k--)
      if (Math.hypot(A.x[k]! - px, A.z[k]! - pz) >= 0.9 * approach) {
        cut = k;
        break;
      }
    if (cut < 1 && A.fromNode >= 0 && Math.hypot(A.x[0]! - px, A.z[0]! - pz) >= 0.5 * approach) cut = 0;
    if (cut < 0 || (cut === 0 && A.fromNode < 0)) {
      // Not to be joined: it is cut back to where it first came near the other, so they do not run together.
      apart.add(A);
      continue;
    }
    const lead = tidy(Float64Array.from([...A.x.slice(0, cut + 1), px]), Float64Array.from([...A.z.slice(0, cut + 1), pz]), Float64Array.from([...A.f.slice(0, cut + 1), A.f[cut]!]));
    const lower: Draft = {
      x: B.x.slice(jP),
      z: B.z.slice(jP),
      f: B.f.map((q) => Math.min(MIN_FLOW, q + A.flow)).slice(jP),
      kind: Math.max(A.kind, B.kind),
      order: A.order === B.order ? B.order + 1 : Math.max(A.order, B.order),
      flow: Math.min(MIN_FLOW, A.flow + B.flow),
      fromNode: -1,
      toNode: B.toNode,
      intoWater: B.intoWater,
      shore: B.shore >= 0 ? B.shore - jP : -1,
    };
    if (headless) {
      // One course: this one's head, then the other's lower part.
      const one = tidy(Float64Array.from([...lead.x, ...lower.x.slice(1)]), Float64Array.from([...lead.z, ...lower.z.slice(1)]), Float64Array.from([...lead.v, ...lower.f.slice(1)]));
      courses[best.a] = { ...lower, x: one.x, z: one.z, f: one.v, fromNode: A.fromNode, shore: shoreOf(one.x, one.z) };
      courses.splice(best.b, 1);
      continue;
    }
    if (atStart && A.fromNode === B.fromNode) {
      apart.add(A);
      continue;
    }
    if (atStart) {
      courses[best.a] = { ...A, x: lead.x, z: lead.z, f: lead.v, toNode: B.fromNode, intoWater: 0, shore: -1 };
      led.add(courses[best.a]!);
      courses[best.b] = { ...B, f: lower.f, kind: lower.kind, order: lower.order, flow: lower.flow };
      continue;
    }
    const node = nextNode++;
    placeOf.set(node, [px, pz]);
    courses[best.a] = { ...A, x: lead.x, z: lead.z, f: lead.v, toNode: node, intoWater: 0, shore: -1 };
    led.add(courses[best.a]!);
    courses[best.b] = { ...B, x: B.x.slice(0, jP + 1), z: B.z.slice(0, jP + 1), f: B.f.slice(0, jP + 1), flow: B.f[jP]!, toNode: node, intoWater: 0, shore: -1 };
    courses.push({ ...lower, fromNode: node });
  }
  // Brooks that were not to be joined: cut back to where they first came near the other.
  for (let a = courses.length - 1; a >= 0; a--) {
    const A = courses[a]!;
    if (!apart.has(A)) continue;
    let near = A.x.length;
    for (const B of courses) {
      if (B === A) continue;
      const run = runOf(A, B);
      if (run) near = Math.min(near, run.m);
    }
    // One that starts at a junction stays as it is: without it the brooks that end there would end side by side.
    if (A.fromNode >= 0 || A.toNode >= 0) continue;
    if (near < 2 || (near - 1) * STEP_M < MIN_LENGTH_M) courses.splice(a, 1);
    else courses[a] = { ...A, x: A.x.slice(0, near), z: A.z.slice(0, near), f: A.f.slice(0, near), toNode: -1, intoWater: 0, shore: -1 };
  }
  // --- 2c. No brook ends at a junction --------------------------------------------------------------------------------
  // A junction of strips is a patch of its own, wider than the brooks and hard to round. Instead the largest brook in
  // (by basin, then length) runs on through it with the brook out as one course, its stem; every other brook in is a
  // tributary: it enters the stem a little downstream, at a slant, and fades out under its water like a mouth.
  for (const c of courses) if (c.toNode >= 0 && c.toNode === c.fromNode) c.toNode = -1;
  /** Per tributary (by `trib`): the point of the junction it ended at. */
  const joinAt: [number, number][] = [];
  for (let again = true; again; ) {
    again = false;
    const ins = new Map<number, Draft[]>();
    const outs = new Map<number, Draft[]>();
    for (const c of courses) {
      if (c.toNode >= 0) (ins.get(c.toNode) ?? ins.set(c.toNode, []).get(c.toNode)!).push(c);
      if (c.fromNode >= 0) (outs.get(c.fromNode) ?? outs.set(c.fromNode, []).get(c.fromNode)!).push(c);
    }
    for (const node of [...new Set([...ins.keys(), ...outs.keys()])].sort((p, q) => p - q)) {
      const list = ins.get(node) ?? [];
      const o = outs.get(node) ?? [];
      again = true;
      if (list.length === 0 || o.length === 0) {
        for (const c of list) c.toNode = -1;
        for (const c of o) c.fromNode = -1;
        break;
      }
      for (const c of o.slice(1)) c.fromNode = -1;
      const out = o[0]!;
      const main = list.reduce((p, q) => (q.flow > p.flow || (q.flow === p.flow && q.x.length > p.x.length) ? q : p));
      const others = list.filter((c) => c !== main);
      // The stem's basin below the junction leaves out the tributaries: each adds its own where it enters.
      const extra = others.reduce((t, c) => t + c.flow, 0);
      const base = main.f[main.f.length - 1]!;
      const cat = (p: Float64Array, q: Float64Array): Float64Array => Float64Array.from([...p, ...q.slice(1)]);
      const one = tidy(cat(main.x, out.x), cat(main.z, out.z), Float64Array.from([...main.f, ...Array.from(out.f.slice(1), (q) => Math.max(base, q - extra))]));
      const joined: Draft = { ...out, x: one.x, z: one.z, f: one.v, fromNode: main.fromNode, kind: Math.max(main.kind, out.kind), order: Math.max(main.order, out.order), shore: out.shore >= 0 ? shoreOf(one.x, one.z) : -1 };
      if (joined.toNode >= 0 && joined.toNode === joined.fromNode) joined.toNode = -1;
      courses[courses.indexOf(main)] = joined;
      courses.splice(courses.indexOf(out), 1);
      for (const c of others) {
        c.toNode = -1;
        c.trib = joinAt.length;
        joinAt.push([main.x[main.x.length - 1]!, main.z[main.z.length - 1]!]);
      }
      break;
    }
  }
  // Each tributary is led into its stem: it leaves its course where it first comes within `MERGE_WIDTHS` widths of
  // the stem and curves to meet it at `ENTRY_ANGLE` pointing downstream, at a point of the stem's middle at least
  // `ENTRY_GAP_WIDTHS` widths from another tributary's; the stem's basin grows by the tributary's over `ENTRY_GROW_M`
  // from there. A stem is laid before the tributaries that enter it.
  const entries = new Map<Draft, number[]>();
  const stemFor = (T: Draft): Draft | null => {
    const [jx, jz] = joinAt[T.trib!]!;
    let best: Draft | null = null;
    let bestD = 4;
    for (const S of courses) {
      if (S === T) continue;
      const m = S.x.length;
      if (Math.hypot(S.x[m - 1]! - jx, S.z[m - 1]! - jz) < 2 || Math.hypot(S.x[0]! - jx, S.z[0]! - jz) < 2) continue;
      const h = nearestOn(S.x, S.z, jx, jz);
      if (h.d < bestD) {
        bestD = h.d;
        best = S;
      }
    }
    return best;
  };
  /** The first point of `T` within `MERGE_WIDTHS` widths of the wider of `T` and `S` (at least `MERGE_MIN_M`) of `S`. */
  const nearFrom = (T: Draft, S: Draft): number => {
    for (let k = 0; k < T.x.length; k++) {
      const h = nearestOn(S.x, S.z, T.x[k]!, T.z[k]!);
      if (h.d < Math.max(MERGE_MIN_M, MERGE_WIDTHS * 2 * Math.max(widest(T.f[k]!), widest(S.f[h.i]!))) + 1) return k;
    }
    return -1;
  };
  const leadInto = (T: Draft, S: Draft): Draft | null => {
    const m = S.x.length;
    const c = nearFrom(T, S);
    if (c < 2) return null;
    const px = T.x[c]!;
    const pz = T.z[c]!;
    const h = nearestOn(S.x, S.z, px, pz);
    const gap = Math.max(ENTRY_GAP_MIN_M, ENTRY_GAP_WIDTHS * 2 * widest(S.f[h.i]!));
    // Along the stem about as far as it lies off it, so the curve meets the stem at the angle it enters at.
    const ideal = h.i + Math.round(Math.max(h.d / Math.tan(ENTRY_ANGLE), 3) / STEP_M);
    const used = entries.get(S) ?? [];
    // The nearest free point to that, downstream first, clear of the stem's mouth if it can be; none, and it is not
    // led in.
    let e = -1;
    for (const endM of [ENTRY_END_M + MOUTH_FADE_M + TO_RIVER_M, ENTRY_END_M]) {
      const last = S.shore >= 0 ? S.shore - Math.ceil(endM / STEP_M) : m - 1 - Math.ceil(ENTRY_END_M / STEP_M);
      for (let d = 0; d < m && e < 0; d++)
        for (const at of [ideal + d, ideal - d])
          if (at > h.i && at >= 2 && at <= last && !used.some((u) => Math.abs(u - at) * STEP_M < gap)) {
            e = at;
            break;
          }
      if (e >= 0) break;
    }
    if (e < 0) return null;
    const ex = S.x[e]!;
    const ez = S.z[e]!;
    let tx = S.x[e + 1]! - S.x[e - 1]!;
    let tz = S.z[e + 1]! - S.z[e - 1]!;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const side = (px - ex) * -tz + (pz - ez) * tx < 0 ? -1 : 1;
    // The direction it enters in: downstream, turned toward the stem from its own side.
    const ux = Math.cos(ENTRY_ANGLE) * tx - side * Math.sin(ENTRY_ANGLE) * -tz;
    const uz = Math.cos(ENTRY_ANGLE) * tz - side * Math.sin(ENTRY_ANGLE) * tx;
    let dx = px - T.x[c - 1]!;
    let dz = pz - T.z[c - 1]!;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const L = Math.hypot(ex - px, ez - pz);
    const q = Math.max(4, Math.ceil(L / 0.25));
    const cx: number[] = [...T.x.slice(0, c + 1)];
    const cz: number[] = [...T.z.slice(0, c + 1)];
    for (let k = 1; k <= q; k++) {
      const t = k / q;
      const b0 = (1 - t) ** 3;
      const b1 = 3 * (1 - t) ** 2 * t;
      const b2 = 3 * (1 - t) * t * t;
      const b3 = t ** 3;
      cx.push(b0 * px + b1 * (px + (dx * L) / 6) + b2 * (ex - (ux * L) / 3) + b3 * ex);
      cz.push(b0 * pz + b1 * (pz + (dz * L) / 6) + b2 * (ez - (uz * L) / 3) + b3 * ez);
    }
    const fc = T.f[c]!;
    const r = resample(Float64Array.from(cx), Float64Array.from(cz), Float64Array.from(cx, (_, k) => (k <= c ? T.f[k]! : fc)), STEP_M);
    used.push(e);
    entries.set(S, used);
    const grow = ENTRY_GROW_M / STEP_M;
    for (let i = e; i < m; i++) S.f[i] = Math.min(MIN_FLOW, S.f[i]! + T.flow * smooth(e, e + grow, i));
    return { ...T, x: r.x, z: r.z, f: r.v, toNode: -1, intoWater: 0, shore: -1, stem: S, entry: e, leave: c };
  };
  for (let moved = true; moved; ) {
    moved = false;
    for (let k = 0; k < courses.length; k++) {
      const T = courses[k]!;
      if (T.trib === undefined || T.stem) continue;
      const S = stemFor(T);
      if (S && S.trib !== undefined && !S.stem && S !== T) continue;
      moved = true;
      const led = S ? leadInto(T, S) : null;
      if (led) {
        courses[k] = led;
        continue;
      }
      // One that cannot be led in ends free where it first came near its stem, or is left out when that leaves little.
      const c = S ? nearFrom(T, S) : -1;
      const keep = c < 0 ? T.x.length : c;
      if ((keep - 1) * STEP_M < MIN_LENGTH_M) {
        courses.splice(k, 1);
        k--;
      } else courses[k] = { ...T, x: T.x.slice(0, keep), z: T.z.slice(0, keep), f: T.f.slice(0, keep), trib: undefined };
    }
  }
  // Stems before the tributaries that enter them.
  {
    const done = new Set<Draft>();
    const sorted: Draft[] = [];
    for (let moved = true; moved; ) {
      moved = false;
      for (const c of courses) {
        if (done.has(c) || (c.stem && courses.includes(c.stem) && !done.has(c.stem))) continue;
        done.add(c);
        sorted.push(c);
        moved = true;
      }
    }
    for (const c of courses) if (!done.has(c)) sorted.push(c);
    courses.splice(0, courses.length, ...sorted);
  }

  // --- 3. Heights and widths -----------------------------------------------------------------------------------------
  const nodes: BrookPlan['nodes'] = [];
  const brooks: Brook[] = [];
  const indexOf = new Map<Draft, number>();
  /** The tributaries, in the order of `nodes`: the brook, its stem, its point of entry, its rim and its shore. */
  const entering: { id: number; stem: number; e: number; rim: number; wetM: number }[] = [];
  for (const c of courses) {
    const n = c.x.length;
    const stem = c.stem ? indexOf.get(c.stem) : undefined;
    const lengthM = (n - 1) * STEP_M;
    if (lengthM < MIN_LENGTH_M && stem === undefined) continue;
    const { nx, nz } = normals(c.x, c.z);
    const bend = bendOf(c.x, c.z);
    // The sharpest bend within a point either way (1/radius), from the course's own corners.
    const bendNear = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let k = Math.max(1, i - 1); k <= Math.min(n - 2, i + 1); k++) {
        const ax = c.x[k]! - c.x[k - 1]!;
        const az = c.z[k]! - c.z[k - 1]!;
        const bx = c.x[k + 1]! - c.x[k]!;
        const bz = c.z[k + 1]! - c.z[k]!;
        const la = Math.hypot(ax, az) || 1;
        const lb = Math.hypot(bx, bz) || 1;
        const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
        bendNear[i] = Math.max(bendNear[i]!, turn / (0.5 * (la + lb)), Math.hypot(bend[2 * i]!, bend[2 * i + 1]!));
      }
    }
    const half = new Float64Array(n);
    const bank = new Float64Array(n);
    const share = new Float64Array(n);
    const key = brooks.length * 11.7;
    // Below a tributary's entry the stem is never more than `JOIN_WIDEN` times as wide as above it; the bound eases off
    // downstream.
    const entries = courses.filter((t) => t.stem === c && t.entry !== undefined).map((t) => t.entry!);
    for (let i = 0; i < n; i++) {
      const base = waterWidth(c.f[i]!, threshold) / (2 * WATER_SHARE);
      const a = Math.max(0, i - 4);
      const b = Math.min(n - 1, i + 4);
      const grade = Math.abs(ground(c.x[a]!, c.z[a]!) - ground(c.x[b]!, c.z[b]!)) / Math.max(1, (b - a) * STEP_M);
      const pool = 2 * smooth(0.1, 0.02, grade) - 1;
      const wave = 2 * valueNoise3(i * STEP_M, key, 5, WIDTH_WAVE_M, seed + 0xb9) - 1;
      const wander = 1 + WIDTH_WANDER * Math.max(-1, Math.min(1, 0.6 * wave + 0.5 * pool));
      half[i] = base * wander * (SPRING_SHARE + (1 - SPRING_SHARE) * smooth(0, SPRING_M, i * STEP_M));
      // Never wider than the bend allows: on the inside of a tight bend the strip's edge would fold over itself.
      half[i] = Math.min(half[i]!, BEND_SHARE / Math.max(1e-6, bendNear[i]!));
      for (const e of entries)
        if (i >= e && e >= 2) half[i] = Math.min(half[i]!, JOIN_WIDEN * half[e - 2]! * (1 + JOIN_WIDEN_EASE * Math.max(0, (i - e) * STEP_M - 2 * ENTRY_GROW_M)));
      share[i] = WATER_SHARE * (1 + SHARE_WANDER * (2 * valueNoise3(i * STEP_M, key, 9, SHARE_WAVE_M, seed + 0xba) - 1));
      let low = Infinity;
      for (let o = -1; o <= 1; o += 0.5) low = Math.min(low, ground(c.x[i]! + nx[i]! * half[i]! * o, c.z[i]! + nz[i]! * half[i]! * o));
      bank[i] = i === 0 ? low : Math.min(low, bank[i - 1]!);
    }
    // Beside water, and into it: the ground is never cut under the level of a line, a lake or the sea next to it
    // (`carveBrooks`), so the brook's own water stays over that level, and meets the water it runs into flush. The
    // level is taken as the highest from each point down, so the banks still never rise.
    let floor = -Infinity;
    for (let i = n - 1; i >= 0; i--) {
      floor = Math.max(floor, levelNear(f, c.x[i]!, c.z[i]!));
      if (floor > -Infinity) bank[i] = Math.max(bank[i]!, floor + DRY_CUT_M + BROOK_CLASSES[c.kind]!.underM + MOUTH_OVER_M);
    }
    const under = BROOK_CLASSES[c.kind]!.underM;
    const water = Float64Array.from(bank, (h) => h - under);
    // The mouth: over the last `MOUTH_FADE_M` before its shore the brook's water comes down to the level of the water
    // it runs into and spreads over its whole bed; past the shore it sinks under that level, and its banks with it, so
    // nothing of it stands over that water, and it fades out there (brook-mesh.ts).
    let shoreM = Infinity;
    if (c.intoWater && c.shore >= 0) {
      let level = -Infinity;
      for (let i = c.shore; i < n && level === -Infinity; i++) level = wetLevel(f, c.x[i]!, c.z[i]!);
      if (level === -Infinity) level = levelNear(f, c.x[n - 1]!, c.z[n - 1]!);
      if (level > -Infinity) {
        shoreM = c.shore * STEP_M;
        const s = c.shore;
        for (let i = 0; i < n; i++) {
          const t = smooth(s - MOUTH_FADE_M / STEP_M, s, i);
          if (t <= 0) continue;
          const target = i <= s ? level : level - DIVE_M * smooth(s, n - 1, i);
          water[i] = Math.min(water[i]!, water[i]! + (target - water[i]!) * t);
          bank[i] = Math.min(bank[i]!, water[i]! + under * (1 - smooth(s - 2, s, i)));
          share[i] = share[i]! + (FULL_SHARE - share[i]!) * t;
        }
      }
    }
    // A tributary: where it reaches the stem's edge (`rim`, a point) and its water (metres along), laid below.
    let to = -1;
    if (stem !== undefined) {
      const S = brooks[stem]!;
      const e = Math.min(S.n - 1, c.entry!);
      const across = new Float64Array(n).fill(Infinity);
      for (let i = Math.max(0, n - 1 - Math.ceil(30 / STEP_M)); i < n; i++) {
        const h = nearestOn(S.x, S.z, c.x[i]!, c.z[i]!);
        const hs = S.half[h.i]! + (S.half[Math.min(S.n - 1, h.i + 1)]! - S.half[h.i]!) * h.t;
        across[i] = h.d / Math.max(0.1, hs);
      }
      let rim = n - 1;
      while (rim > 0 && across[rim - 1]! <= 1) rim--;
      // Where it reaches the stem's water, between its points.
      const sh = S.share[e]!;
      let wetM = rim * STEP_M;
      for (let i = rim; i + 1 < n; i++)
        if (across[i]! > sh && across[i + 1]! <= sh) {
          wetM = (i + (across[i]! - sh) / (across[i]! - across[i + 1]!)) * STEP_M;
          break;
        }
      to = entering.length;
      entering.push({ id: brooks.length, stem, e, rim, wetM });
    }
    indexOf.set(c, brooks.length);
    brooks.push({ n, x: c.x, z: c.z, bank, water, half, share, bend, kind: c.kind, order: c.order, flow: c.flow, to, leaveM: to >= 0 ? c.leave! * STEP_M : Infinity, intoWater: c.intoWater, shoreM });
  }
  // A junction lies at the height of the lower brook in: where a tributary's banks lie lower than its stem's where it
  // enters, the stem's come down to them, at most `JOIN_GRADE` steep above it and never rising below it. The deepest
  // tributaries first, so a stem lowered so lowers its own stem in turn.
  for (let k = entering.length - 1; k >= 0; k--) {
    const { id, stem, e, rim } = entering[k]!;
    const low = brooks[id]!.bank[rim]!;
    const S = brooks[stem]!;
    const under = BROOK_CLASSES[S.kind]!.underM;
    if (low >= S.bank[e]!) continue;
    for (let i = 0; i < S.n; i++) {
      const cap = low + JOIN_GRADE * STEP_M * Math.max(0, e - i);
      if (cap >= S.bank[i]!) continue;
      S.bank[i] = cap;
      S.water[i] = Math.min(S.water[i]!, cap - under);
    }
  }
  // Then each tributary's banks come down to its stem's at the stem's edge, so its water meets the stem's flush there
  // (the stem's strip is clear of grass beyond its water, and the ground under both is cut), and to its own water
  // there; past where it reaches the stem's water it sinks `DIVE_M` under it, and fades out (brook-mesh.ts).
  for (const { id, stem, e, rim, wetM } of entering) {
    const T = brooks[id]!;
    const S = brooks[stem]!;
    const { n, bank, water, share } = T;
    const under = BROOK_CLASSES[T.kind]!.underM;
    const sBank = S.bank[e]!;
    const sWater = S.water[e]!;
    for (let i = rim; i >= 0; i--) {
      const cap = sBank + JOIN_GRADE * STEP_M * (rim - i);
      if (bank[i]! <= cap) break;
      bank[i] = cap;
    }
    for (let i = 0; i < n; i++) {
      water[i] = Math.min(water[i]!, bank[i]! - under);
      if (i >= rim) water[i] = Math.min(water[i]!, i > rim ? water[i - 1]! : Infinity, sWater - DIVE_M * smooth(wetM / STEP_M - 0.5, Math.max(wetM / STEP_M, n - 1), i));
      const t = smooth(rim - MOUTH_FADE_M / STEP_M, rim, i);
      bank[i] = Math.min(bank[i]!, water[i]! + under * (1 - smooth(rim - 2 / STEP_M, rim, i)));
      share[i] = share[i]! + (FULL_SHARE - share[i]!) * t;
    }
    T.shoreM = rim * STEP_M;
    nodes.push({ x: S.x[e]!, z: S.z[e]!, bank: sBank, stem, flow: T.flow });
  }

  // --- 4. The strips -------------------------------------------------------------------------------------------------
  // Every line ends square: a tributary's end lies under its stem's water and is faded out.
  const bedProfiles: StripProfile[] = BROOK_CLASSES.map((k) => ({ section: bedSection(k.depthM), shoulderM: SHOULDER_M, bedM: BED_M }));
  const bedLines: StripLine[] = [];
  const waterLines: StripLine[] = [];
  for (const b of brooks) {
    const keep: number[] = [];
    for (let i = 0; i < b.n; i++) {
      // Never a point where the kept line would turn back on itself (at the last point, the one before goes).
      const back = (): boolean => {
        const p = keep[keep.length - 1];
        const q = keep[keep.length - 2];
        if (p === undefined || q === undefined) return false;
        const ax = b.x[p]! - b.x[q]!;
        const az = b.z[p]! - b.z[q]!;
        const bx = b.x[i]! - b.x[p]!;
        const bz = b.z[i]! - b.z[p]!;
        return ax * bx + az * bz < -0.5 * Math.hypot(ax, az) * Math.hypot(bx, bz);
      };
      const last = keep[keep.length - 1];
      if (last !== undefined && Math.hypot(b.x[i]! - b.x[last]!, b.z[i]! - b.z[last]!) < 1e-6) continue;
      if (i < b.n - 1 && back()) continue;
      while (i === b.n - 1 && keep.length > 1 && back()) keep.pop();
      keep.push(i);
    }
    const points = new Float64Array(keep.length * 3);
    keep.forEach((i, k) => {
      points[k * 3] = b.x[i]!;
      points[k * 3 + 2] = b.z[i]!;
    });
    const half = Float64Array.from(keep, (i) => b.half[i]!);
    bedLines.push({ points, heights: Float64Array.from(keep, (i) => b.bank[i]!), halfWidths: half, profile: b.kind });
    waterLines.push({ points, heights: Float64Array.from(keep, (i) => b.water[i]!), halfWidths: Float64Array.from(keep, (i) => b.half[i]! * b.share[i]!), profile: 0 });
  }
  const bed = stripNet({ radiusM: 0, profiles: bedProfiles, nodes: [], lines: bedLines });
  const water = stripNet({ radiusM: 0, profiles: [{ section: [-1, 0, 1, 0], shoulderM: 0, bedM: 0 }], nodes: [], lines: waterLines });
  const starts = new Float64Array(brooks.length);

  // --- The field's distance to the strips ----------------------------------------------------------------------------
  const edge = new Float32Array(f.n * f.n).fill(EDGE_REACH_M);
  const level = new Float32Array(f.n * f.n).fill(NaN);
  const mouth = new Float32Array(f.n * f.n);
  for (const b of brooks) {
    for (let i = 0; i + 1 < b.n; i++) {
      const ax = b.x[i]!;
      const az = b.z[i]!;
      const dx = b.x[i + 1]! - ax;
      const dz = b.z[i + 1]! - az;
      const len2 = dx * dx + dz * dz || 1;
      const reach = Math.max(b.half[i]!, b.half[i + 1]!) + EDGE_REACH_M;
      const i0 = Math.max(0, Math.floor((Math.min(ax, ax + dx) - reach - f.x0) / f.step));
      const i1 = Math.min(f.n - 1, Math.ceil((Math.max(ax, ax + dx) + reach - f.x0) / f.step));
      const j0 = Math.max(0, Math.floor((Math.min(az, az + dz) - reach - f.z0) / f.step));
      const j1 = Math.min(f.n - 1, Math.ceil((Math.max(az, az + dz) + reach - f.z0) / f.step));
      for (let j = j0; j <= j1; j++)
        for (let k = i0; k <= i1; k++) {
          const px = f.x0 + k * f.step - ax;
          const pz = f.z0 + j * f.step - az;
          const t = Math.min(1, Math.max(0, (px * dx + pz * dz) / len2));
          const d = Math.hypot(px - dx * t, pz - dz * t) - (b.half[i]! + (b.half[i + 1]! - b.half[i]!) * t);
          const q = j * f.n + k;
          if (d < edge[q]!) {
            edge[q] = d;
            level[q] = b.water[i]! + (b.water[i + 1]! - b.water[i]!) * t;
            mouth[q] = b.intoWater && b.shoreM < Infinity ? smooth(b.shoreM - MOUTH_FREE_M - MOUTH_EASE_M, b.shoreM - MOUTH_FREE_M, (i + t) * STEP_M) : 0;
          }
        }
    }
  }
  return { threshold, brooks, nodes, bed, water, starts, edge, level, mouth };
}

/**
 * Cuts the ground of the field under the brooks' beds, in place: never raised, never cut under the water that may
 * stand at a dry point, and not across a path's tread (there the brook runs over the path). A brook is narrower than
 * the field's cells, so the points of the field rarely fall on its bed: every point of a cell the strip touches is
 * also cut under the brook's water (`UNDER_WATER_M`), so the ground drawn between them never rises through it.
 * Returns the ground as it was before: a brook's channel cut down near the water of a line, a lake or the sea is no
 * bank of that water, so the bank is drawn from the ground as it was (`groundPieces`).
 */
export function carveBrooks(f: Field, bp: BrookPlan, paths?: PathPlan): Float32Array {
  const hit: PathHit = { d: 0, ox: 0, oz: 0, y: 0, ford: 0, path: 0, i: 0, t: 0 };
  const { n, step, x0, z0, ground, water } = f;
  const uncut = Float32Array.from(ground);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (bp.edge[k]! >= SHOULDER_M) continue;
      const own = ground[k]!;
      if (water[k]! > own) continue;
      // On the floor of a line, a lake or the sea only the cells the strip touches are cut: a shoulder there would
      // lower the floor round a mouth to just over the water, a pale shelf wider than the brook.
      if (f.body[k] !== 0 && bp.edge[k]! >= step * Math.SQRT2) continue;
      const x = x0 + i * step;
      const z = z0 + j * step;
      let cut = Math.min(own, stripCarve(bp.bed, x, 0, z, own));
      if (bp.edge[k]! < step * Math.SQRT2) cut = Math.min(cut, bp.level[k]! - UNDER_WATER_M);
      // Never under the water that may stand there (of a line, a lake or the sea): a dry point cut under it would
      // flood, and the water of the line would spread up the brook's channel as a sheet. The brook's own water runs
      // over that ground (its strips never lie under the ground drawn) and sinks under the line's at its shore.
      cut = Math.max(cut, Math.min(own, water[k]! + DRY_CUT_M));
      // Beside the last metres before a mouth only the cells the brook's strip touches are cut, no shoulder: the bank
      // of the water it runs into is notched, not flattened round it.
      if (bp.edge[k]! >= step * Math.SQRT2) cut += (own - cut) * bp.mouth[k]!;
      if (paths && pathAt(paths, x, z, hit)) cut += (own - cut) * (1 - smooth(1.2, 3.2, hit.d)) * (1 - hit.ford);
      ground[k] = cut;
    }
  return uncut;
}

/**
 * How crowded the brooks lie, for the checks: mouths within `CROWDED_M` of another mouth, and pairs of brooks that run
 * side by side (closer than three of the wider one's widths for more than `TWIN_M` metres, leaving out a tributary's
 * last stretch, where it curves into its stem), with the longest such run. Neither is wanted: two brooks that near each other are one brook.
 */
export function brookCrowding(bp: BrookPlan): { crowdedMouths: number; twins: number; longestTwinM: number } {
  const B = bp.brooks;
  let crowdedMouths = 0;
  for (let a = 0; a < B.length; a++)
    for (let c = a + 1; c < B.length; c++) {
      const A = B[a]!;
      const C = B[c]!;
      if (A.intoWater && C.intoWater && Math.hypot(A.x[A.n - 1]! - C.x[C.n - 1]!, A.z[A.n - 1]! - C.z[C.n - 1]!) < CROWDED_M) crowdedMouths++;
    }
  const boxes = B.map((b) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let w = 0;
    for (let i = 0; i < b.n; i++) {
      x0 = Math.min(x0, b.x[i]!);
      x1 = Math.max(x1, b.x[i]!);
      z0 = Math.min(z0, b.z[i]!);
      z1 = Math.max(z1, b.z[i]!);
      w = Math.max(w, b.half[i]!);
    }
    return { x0, x1, z0, z1, w };
  });
  let twins = 0;
  let longestTwinM = 0;
  for (let a = 0; a < B.length; a++)
    for (let c = 0; c < B.length; c++) {
      if (c === a) continue;
      const ba = boxes[a]!;
      const bc = boxes[c]!;
      const reach = 6 * Math.max(ba.w, bc.w);
      if (ba.x0 > bc.x1 + reach || bc.x0 > ba.x1 + reach || ba.z0 > bc.z1 + reach || bc.z0 > ba.z1 + reach) continue;
      const best = twinRun(B, a, c);
      // Each pair once.
      if (best > TWIN_M && (a < c || !(twinRun(B, c, a) > TWIN_M))) twins++;
      longestTwinM = Math.max(longestTwinM, best > TWIN_M ? best : 0);
    }
  return { crowdedMouths, twins, longestTwinM };
}

/** Metres brook `a` runs beside brook `c` at most (as `brookCrowding` measures it). */
function twinRun(B: Brook[], a: number, c: number): number {
  const A = B[a]!;
  const C = B[c]!;
  // A tributary curving into its stem comes near it, and near another that enters the same stem close by: its points
  // past where it leaves its own course, and the other's, do not count.
  let run = 0;
  let best = 0;
  for (let i = 0; i < A.n; i++) {
    const h = nearestOn(C.x, C.z, A.x[i]!, A.z[i]!);
    const leading = (A.to >= 0 && i * STEP_M >= A.leaveM) || (C.to >= 0 && h.i * STEP_M >= C.leaveM - STEP_M);
    run = !leading && h.d < 3 * 2 * Math.max(A.half[i]!, C.half[h.i]!) ? run + STEP_M : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Numbers for the panel and the checks: brooks by class and by order, their length, junctions and mouths. */
export function brookStats(bp: BrookPlan): { brooks: number; streams: number; highestOrder: number; lengthKm: number; junctions: number; intoWater: number } {
  let len = 0;
  let streams = 0;
  let top = 0;
  let into = 0;
  for (const b of bp.brooks) {
    len += (b.n - 1) * STEP_M;
    if (b.kind === 1) streams++;
    top = Math.max(top, b.order);
    into += b.intoWater;
  }
  return { brooks: bp.brooks.length - streams, streams, highestOrder: top, lengthKm: Math.round(len / 100) / 10, junctions: bp.nodes.length, intoWater: into };
}
