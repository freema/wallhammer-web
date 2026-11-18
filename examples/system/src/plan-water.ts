// Stage 1 of the plan of the world: the water of Hearth. Heights of the terrain at every node of the plan's grid,
// hollows filled from the sea inward (the larger ones stay as lakes), flow gathered downstream from a supply that
// follows today's climate, and the rivers: one chain from spring to sea each, traced with the lakes hidden, so a lake
// is a stretch of its river. A chain runs on past its last node into the sea until the ground under it is deep, its
// mouth opening. Its grade never rises, equals the level of a lake wherever the lake's domain holds it (plan-lakes.ts)
// and never lies under a lake further down. Pure; called by `worldPlan`.

import { drainGrid, gridDirection, gridNeighbours, gridNodeArea, smoothLine, sphereGrid, traceChannels } from 'wallhammer-web/gen-plan';
import type { Channels, Drainage, LineTiles, SphereGrid } from 'wallhammer-web/gen-plan';
import { SURFACES } from './bodies.ts';
import { PLAN_BODY, PLAN_LEVEL, TILE_LEVEL, tileReachM } from './plan.ts';
import type { PlanLines } from './plan.ts';
import { inLakeDomain, lakeAt, lakeBendSeed, lakeHere, lakePremise } from './plan-lakes.ts';
import type { LakeSource } from './plan-lakes.ts';
import { planLineTiles } from './plan-tiles.ts';
import { bodyClimate, groundHeight } from './world.ts';

/** Nodes at or under this height are sea, also inland: what the terrain colours as sea. */
const SEA_LEVEL_M = 0;
/** A filled hollow is a lake from this many nodes on and this depth of its deepest node; smaller ones drain across. */
const MIN_POOL_NODES = 6;
const MIN_POOL_DEPTH_M = 2;
/** A node is part of a river from this flow on, m² of basin at full supply (4 km²). Doubled while the points are too many. */
const MIN_FLOW_M2 = 4e6;
/** At most this many points in all river lines. */
const MAX_POINTS = 200_000;
/** Half-width of a river, m: `HALF_WIDTH_PER_ROOT · sqrt(flow / WIDTH_FLOW_M2)`, at most `MAX_HALF_WIDTH_M`. */
const WIDTH_FLOW_M2 = 4e6;
const HALF_WIDTH_PER_ROOT = 2;
const MAX_HALF_WIDTH_M = 40;
/** Points per step between two grid nodes of a river (a point about every 100 m). */
const STEPS_PER_NODE = 3;
/** Rounds of smoothing of a river's points. */
const SMOOTH_ROUNDS = 8;
/** Depth of the water under the ground of the centre line: `WATER_DEPTH_M + WATER_DEPTH_PER_HALF_WIDTH · half-width`. */
const WATER_DEPTH_M = 0.5;
const WATER_DEPTH_PER_HALF_WIDTH = 0.06;
/** No two points of a line lie farther apart than this (m): longer segments get points in between. */
const MAX_SPACING_M = 150;
/** A river is cut into lines of equal length of at most this (m); with the spacing a line stays under 1300 m. */
const LINE_TARGET_M = 1100;
/** Run-out into the sea: at most this many grid nodes past the last one, until the ground has been this deep (m, plus
 *  the depth of the channel) for this many metres. Over it the half-width grows to `MOUTH_GROWTH` times its value. */
const RUN_OUT_NODES = 4;
const RUN_OUT_DEEP_M = 1.5;
const RUN_OUT_ALONG_M = 60;
const MOUTH_GROWTH = 2;
/** Classes by the half-width at the lower end of a line: ≥ the first limit class 0, ≥ the second 1, ≥ the third 2, else 3. */
const CLASS_LIMITS_M = [12, 5, 3] as const;
/** At most this length of class 0 in all; over it the first limit rises by 1 m until it fits. */
const MAX_CLASS0_M = 1_500_000;
/** Supply weight of a land node: `max(SUPPLY_MIN, (SUPPLY_BASE + SUPPLY_MOIST · m)(1 − DRY_CUT · dry)(1 − SNOW_CUT · snow))`. */
const SUPPLY_MIN = 0.1;
const SUPPLY_BASE = 0.25;
const SUPPLY_MOIST = 0.75;
const DRY_CUT = 0.8;
const SNOW_CUT = 0.7;
/** Profiles by class (brook 0, stream 1, river 2; this order is fixed for the cells). */
const PROFILE_OF_CLASS = [2, 2, 1, 0] as const;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** What the water stage puts into the plan. */
export interface PlanWater {
  grid: SphereGrid;
  relief: Int16Array;
  pool: Uint16Array;
  pools: Drainage['pools'];
  lines: PlanLines;
  tiles: LineTiles;
  /** Number of rivers (channels); `lines.owner` names them. */
  channels: number;
}

/** The grid of the plan on the body that has one. */
export function planGrid(): SphereGrid {
  return sphereGrid(SURFACES[PLAN_BODY]!.radiusM, PLAN_LEVEL);
}

/** Ground heights at the nodes of one face of the plan's grid, in node order. A pure function of the node: no seams. */
export function planFaceHeights(packed: number, face: number): Float32Array {
  const g = planGrid();
  const R = g.radiusM;
  const nn = g.n * g.n;
  const out = new Float32Array(nn);
  const d: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < nn; k++) {
    gridDirection(g, face * nn + k, d);
    out[k] = groundHeight(packed, d[0] * R, d[1] * R, d[2] * R);
  }
  return out;
}

/** Supply of every node: its area times a weight from today's climate on land, nothing on the sea. */
function supplyOf(packed: number, g: SphereGrid, heights: Float32Array): Float32Array {
  const R = g.radiusM;
  const out = new Float32Array(g.count);
  const d: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < g.count; i++) {
    const h = heights[i]!;
    if (h <= SEA_LEVEL_M) continue;
    gridDirection(g, i, d);
    const c = bodyClimate(packed, d[0] * R, d[1] * R, d[2] * R, h);
    let weight = 1;
    if (c) {
      const dry = smooth(0.72, 0.86, c.t) * (1 - smooth(0.28, 0.44, c.m));
      const snow = 1 - smooth(0.05, 0.16, c.t);
      weight = Math.max(SUPPLY_MIN, (SUPPLY_BASE + SUPPLY_MOIST * c.m) * (1 - DRY_CUT * dry) * (1 - SNOW_CUT * snow));
    }
    out[i] = gridNodeArea(g, i) * weight;
  }
  return out;
}

/** One river before it is cut into lines: its points, half-widths, ground, hold and grade. */
interface River {
  points: Float64Array;
  halfWidth: Float64Array;
  /** Half-width without the opening of the mouth (for the class). */
  baseWidth: Float64Array;
  ground: Float64Array;
  /** Level of the lake whose domain holds a point, NaN where none does. */
  hold: Float64Array;
  grade: Float64Array;
  /** Whether other rivers end at its first point. */
  confluence: boolean;
}

/**
 * The run-out of a channel that ends in the sea: up to `RUN_OUT_NODES` grid nodes past its last one by steepest descent
 * over the coarse heights (the lowest neighbour, the lower index on a tie), only while it falls.
 */
function runOut(g: SphereGrid, heights: Float32Array, ch: Channels, c: number): number[] {
  if (ch.into[c] !== -1) return [];
  const nb = new Int32Array(8);
  const out: number[] = [];
  let cur = ch.nodes[ch.start[c + 1]! - 1]!;
  for (let k = 0; k < RUN_OUT_NODES; k++) {
    const n = gridNeighbours(g, cur, nb);
    let best = -1;
    for (let j = 0; j < n; j++) {
      const q = nb[j]!;
      if (best < 0 || heights[q]! < heights[best]! || (heights[q] === heights[best] && q < best)) best = q;
    }
    if (best < 0 || !(heights[best]! < heights[cur]!)) break;
    out.push(best);
    cur = best;
  }
  return out;
}

/**
 * Points a set of channels gives in the line table, estimated: per channel 3 per step and one more, a tenth more for
 * the points put in for the spacing and the cuts of its lines.
 */
function pointsOf(ch: Channels, tails: readonly number[][]): number {
  let total = 0;
  for (let c = 0; c + 1 < ch.start.length; c++) {
    const P = STEPS_PER_NODE * (ch.start[c + 1]! - ch.start[c]! + tails[c]!.length - 1) + 1;
    total += Math.ceil(1.1 * P);
  }
  return total;
}

/** The water of the plan. */
export function planWater(packed: number, o: { heights?: Float32Array; mark: (phase: string) => void }): PlanWater {
  const g = planGrid();
  const R = g.radiusM;
  const count = g.count;

  // 1. Heights.
  let heights: Float32Array;
  if (o.heights) {
    if (o.heights.length !== count) throw new Error(`plan: ${o.heights.length} heights for ${count} nodes`);
    heights = o.heights;
  } else {
    heights = new Float32Array(count);
    const nn = g.n * g.n;
    for (let face = 0; face < 6; face++) heights.set(planFaceHeights(packed, face), face * nn);
  }
  const relief = new Int16Array(count);
  for (let i = 0; i < count; i++) relief[i] = Math.max(-32768, Math.min(32767, Math.round(2 * heights[i]!)));
  o.mark('heights');

  // 2. Drainage. Too many lakes: the least lake grows until they fit.
  const supply = supplyOf(packed, g, heights);
  let drained: Drainage | null = null;
  for (let minNodes = MIN_POOL_NODES; !drained; minNodes *= 2) {
    try {
      drained = drainGrid(g, heights, { baseLevel: SEA_LEVEL_M, supply, minPoolNodes: minNodes, minPoolDepth: MIN_POOL_DEPTH_M });
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('65 535'))) throw e;
    }
  }
  const d: Drainage = drained;
  const lakes: LakeSource = { seed: packed, grid: g, pool: d.pool, pools: d.pools, relief };
  // The lake rule rests on this; it follows from the fill over eight neighbours.
  const premise = lakePremise(lakes);
  if (premise.mixed > 0 || premise.low > 0) throw new Error(`plan: the premise of the lake rule fails (${premise.mixed} mixed, ${premise.low} low neighbours)`);
  o.mark('drainage');

  // 3. Channels, traced with the pools hidden: inside a pool `to` follows the flood parents to its sill (drain.ts), so
  //    a lake is a stretch of the river that crosses it, and every chain ends in the sea (or the one outlet).
  const hidden: Drainage = { ...d, pool: new Uint16Array(count) };
  let minFlow = MIN_FLOW_M2;
  let ch = traceChannels(g, hidden, { minFlow });
  const tailsOf = (c: Channels): number[][] => Array.from({ length: c.into.length }, (_, k) => runOut(g, heights, c, k));
  let tails = tailsOf(ch);
  while (pointsOf(ch, tails) > MAX_POINTS) {
    minFlow *= 2;
    ch = traceChannels(g, hidden, { minFlow });
    tails = tailsOf(ch);
  }
  const channels = ch.into.length;
  const halfWidthOf = (node: number): number => Math.min(MAX_HALF_WIDTH_M, HALF_WIDTH_PER_ROOT * Math.sqrt(d.flow[node]! / WIDTH_FLOW_M2));
  const depthOf = (hw: number): number => WATER_DEPTH_M + WATER_DEPTH_PER_HALF_WIDTH * hw;
  const ends = new Uint8Array(channels);
  for (let c = 0; c < channels; c++) if (ch.into[c]! >= 0) ends[ch.into[c]!] = 1;
  const bendSeed = lakeBendSeed(packed);
  const here = lakeHere();
  const rivers: River[] = [];
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < channels; c++) {
    const chain = Array.from(ch.nodes.subarray(ch.start[c]!, ch.start[c + 1]!));
    const tail = tails[c]!;
    const list = [...chain, ...tail];
    const N = list.length;
    const P0 = STEPS_PER_NODE * (N - 1) + 1;
    const raw = new Float64Array(3 * P0);
    const rawWidth = new Float64Array(P0);
    const rawTail = new Uint8Array(P0);
    const endWidth = halfWidthOf(chain[chain.length - 1]!);
    let p = 0;
    for (let k = 0; k < N; k++) {
      gridDirection(g, list[k]!, a);
      const wa = k < chain.length ? halfWidthOf(list[k]!) : endWidth;
      raw.set(a, 3 * p);
      rawTail[p] = k >= chain.length ? 1 : 0;
      rawWidth[p++] = wa;
      if (k + 1 === N) break;
      gridDirection(g, list[k + 1]!, b);
      const wb = k + 1 < chain.length ? halfWidthOf(list[k + 1]!) : endWidth;
      for (let s = 1; s < STEPS_PER_NODE; s++) {
        const f = s / STEPS_PER_NODE;
        const x = a[0] * (1 - f) + b[0] * f;
        const y = a[1] * (1 - f) + b[1] * f;
        const z = a[2] * (1 - f) + b[2] * f;
        const l = Math.sqrt(x * x + y * y + z * z);
        raw[3 * p] = x / l;
        raw[3 * p + 1] = y / l;
        raw[3 * p + 2] = z / l;
        rawTail[p] = k + 1 >= chain.length ? 1 : 0;
        rawWidth[p++] = wa * (1 - f) + wb * f;
      }
    }
    const smoothed = smoothLine(raw, SMOOTH_ROUNDS);
    // Points in between where a segment is longer than the spacing allows.
    const pts: number[] = [];
    const wid: number[] = [];
    const tl: number[] = [];
    for (let i = 0; i < P0; i++) {
      if (i > 0) {
        const dx = smoothed[3 * i]! - smoothed[3 * i - 3]!;
        const dy = smoothed[3 * i + 1]! - smoothed[3 * i - 2]!;
        const dz = smoothed[3 * i + 2]! - smoothed[3 * i - 1]!;
        const chord = Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
        const parts = Math.ceil(chord / MAX_SPACING_M);
        for (let s = 1; s < parts; s++) {
          const f = s / parts;
          const x = smoothed[3 * i - 3]! + dx * f;
          const y = smoothed[3 * i - 2]! + dy * f;
          const z = smoothed[3 * i - 1]! + dz * f;
          const l = Math.sqrt(x * x + y * y + z * z);
          pts.push(x / l, y / l, z / l);
          wid.push(rawWidth[i - 1]! * (1 - f) + rawWidth[i]! * f);
          tl.push(rawTail[i]!);
        }
      }
      pts.push(smoothed[3 * i]!, smoothed[3 * i + 1]!, smoothed[3 * i + 2]!);
      wid.push(rawWidth[i]!);
      tl.push(rawTail[i]!);
    }
    let P = wid.length;
    const ground = new Float64Array(P);
    for (let i = 0; i < P; i++) ground[i] = groundHeight(packed, pts[3 * i]! * R, pts[3 * i + 1]! * R, pts[3 * i + 2]! * R);
    // The run-out ends where the ground has been deep under the sea for `RUN_OUT_ALONG_M`; the mouth opens over it.
    let chainEnd = 0;
    for (let i = 0; i < P; i++) if (tl[i] === 0) chainEnd = i;
    const along = new Float64Array(P);
    for (let i = 1; i < P; i++) {
      const dx = pts[3 * i]! - pts[3 * i - 3]!;
      const dy = pts[3 * i + 1]! - pts[3 * i - 2]!;
      const dz = pts[3 * i + 2]! - pts[3 * i - 1]!;
      along[i] = along[i - 1]! + Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
    }
    if (tail.length > 0) {
      let deepFrom = -1;
      for (let i = chainEnd; i < P; i++) {
        if (ground[i]! <= -(RUN_OUT_DEEP_M + depthOf(wid[i]!))) {
          if (deepFrom < 0) deepFrom = i;
          if (along[i]! - along[deepFrom]! >= RUN_OUT_ALONG_M) {
            P = i + 1;
            break;
          }
        } else deepFrom = -1;
      }
    }
    const points = Float64Array.from(pts.slice(0, 3 * P));
    const baseWidth = Float64Array.from(wid.slice(0, P));
    const halfWidth = Float64Array.from(baseWidth);
    const span = along[P - 1]! - along[chainEnd]!;
    if (span > 0) for (let i = chainEnd + 1; i < P; i++) halfWidth[i] = baseWidth[i]! * (1 + (MOUTH_GROWTH - 1) * ((along[i]! - along[chainEnd]!) / span));
    const hold = new Float64Array(P);
    for (let i = 0; i < P; i++) {
      lakeAt(lakes, bendSeed, points[3 * i]! * R, points[3 * i + 1]! * R, points[3 * i + 2]! * R, here);
      hold[i] = inLakeDomain(here) ? here.level : NaN;
    }
    rivers.push({ points, halfWidth, baseWidth, ground: ground.slice(0, P), hold, grade: new Float64Array(P), confluence: ends[c] === 1 });
  }
  o.mark('channels');

  // 4. Grade. Backward: `need` is the highest hold at or below a point on its chain and the chains it runs into (the
  //    sea counts as 0). Forward: the running minimum of the ground less the depth of water, restarted at the level of
  //    every lake it crosses; the grade is the larger of the two, so the level never rises, reaches a lake at its level,
  //    crosses it level and leaves it at its level.
  const needFirst = new Float64Array(channels);
  const needs: Float64Array[] = new Array<Float64Array>(channels);
  for (let c = channels - 1; c >= 0; c--) {
    const r = rivers[c]!;
    const P = r.ground.length;
    const into = ch.into[c]!;
    let need = into >= 0 ? needFirst[into]! : into === -1 ? SEA_LEVEL_M : d.pools.level[-2 - into]!;
    const nd = new Float64Array(P);
    for (let i = P - 1; i >= 0; i--) {
      const h = r.hold[i]!;
      if (h === h && h > need) need = h;
      nd[i] = need;
    }
    needs[c] = nd;
    needFirst[c] = nd[0]!;
  }
  const arrive = new Float64Array(channels).fill(Infinity);
  const uppers: number[][] = Array.from({ length: channels }, () => []);
  /** Height of the node where a river starts below others (the confluence). */
  const joinHeight = new Float64Array(channels).fill(NaN);
  for (let c = 0; c < channels; c++) {
    const r = rivers[c]!;
    const nd = needs[c]!;
    const P = r.ground.length;
    const rawAt = (i: number): number => r.ground[i]! - depthOf(r.halfWidth[i]!);
    const h0 = r.hold[0]!;
    let running: number;
    if (r.confluence) {
      const H = Math.fround(Math.max(nd[0]!, h0 === h0 ? h0 : Math.min(arrive[c]!, rawAt(0))));
      joinHeight[c] = H;
      // Every river that ends here ends at this height (never higher than it arrived).
      for (const u of uppers[c]!) {
        const ug = rivers[u]!.grade;
        ug[ug.length - 1] = H;
      }
      running = H;
    } else running = h0 === h0 ? h0 : rawAt(0);
    for (let i = 0; i < P; i++) {
      const h = r.hold[i]!;
      if (i > 0) running = h === h ? h : Math.min(running, rawAt(i));
      r.grade[i] = Math.fround(Math.max(nd[i]!, running));
    }
    if (r.confluence) r.grade[0] = joinHeight[c]!;
    const into = ch.into[c]!;
    if (into >= 0) {
      arrive[into] = Math.min(arrive[into]!, r.grade[P - 1]!);
      uppers[into]!.push(c);
    }
  }

  // 5. Lines: every river cut into lines of equal length (at most `LINE_TARGET_M` plus one spacing); cuts and
  //    confluences are nodes.
  const lineStart: number[] = [0];
  const pts: number[] = [];
  const grade: number[] = [];
  const hw: number[] = [];
  const owner: number[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const nodes: number[] = [];
  const lengthM: number[] = [];
  const lowWidth: number[] = [];
  const maxWidth: number[] = [];
  /** Node of the confluence at the start of a channel, once it has one. */
  const joinNode = new Int32Array(channels).fill(-1);
  const addNode = (r: River, i: number, height: number): number => {
    nodes.push(r.points[3 * i]!, r.points[3 * i + 1]!, r.points[3 * i + 2]!, height);
    return nodes.length / 4 - 1;
  };
  const confluenceNode = (c: number): number => {
    if (joinNode[c]! < 0) joinNode[c] = addNode(rivers[c]!, 0, joinHeight[c]!);
    return joinNode[c]!;
  };
  for (let c = 0; c < channels; c++) {
    const r = rivers[c]!;
    const S = r.ground.length - 1;
    const cum = new Float64Array(S + 1);
    for (let i = 1; i <= S; i++) {
      const dx = r.points[3 * i]! - r.points[3 * i - 3]!;
      const dy = r.points[3 * i + 1]! - r.points[3 * i - 2]!;
      const dz = r.points[3 * i + 2]! - r.points[3 * i - 1]!;
      cum[i] = cum[i - 1]! + Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
    }
    const L = Math.max(1, Math.min(S, Math.ceil(cum[S]! / LINE_TARGET_M)));
    // Cut j at the first point at or past j / L of the length, each cut past the one before.
    const cuts: number[] = [0];
    for (let j = 1; j < L; j++) {
      const target = (j * cum[S]!) / L;
      let i = cuts[cuts.length - 1]! + 1;
      while (i < S && cum[i]! < target) i++;
      if (i < S) cuts.push(i);
    }
    cuts.push(S);
    let prevNode = r.confluence ? confluenceNode(c) : -1;
    for (let j = 0; j + 1 < cuts.length; j++) {
      const i0 = cuts[j]!;
      const i1 = cuts[j + 1]!;
      from.push(prevNode);
      let end: number;
      if (j + 2 < cuts.length) end = addNode(r, i1, r.grade[i1]!);
      else end = ch.into[c]! >= 0 ? confluenceNode(ch.into[c]!) : -1;
      to.push(end);
      prevNode = end;
      let widest = 0;
      for (let i = i0; i <= i1; i++) {
        pts.push(r.points[3 * i]!, r.points[3 * i + 1]!, r.points[3 * i + 2]!);
        grade.push(r.grade[i]!);
        hw.push(r.halfWidth[i]!);
        widest = Math.max(widest, r.halfWidth[i]!);
      }
      lineStart.push(pts.length / 3);
      owner.push(c);
      lengthM.push(cum[i1]! - cum[i0]!);
      lowWidth.push(r.baseWidth[i1]!);
      maxWidth.push(widest);
    }
  }
  const lineCount = owner.length;
  // Classes; the great rivers are kept under their length in all.
  let limit0: number = CLASS_LIMITS_M[0];
  for (;;) {
    let total = 0;
    for (let l = 0; l < lineCount; l++) if (lowWidth[l]! >= limit0) total += lengthM[l]!;
    if (total <= MAX_CLASS0_M) break;
    limit0 += 1;
  }
  const cls = new Uint8Array(lineCount);
  const profile = new Uint8Array(lineCount);
  for (let l = 0; l < lineCount; l++) {
    const w = lowWidth[l]!;
    const k = w >= limit0 ? 0 : w >= CLASS_LIMITS_M[1] ? 1 : w >= CLASS_LIMITS_M[2] ? 2 : 3;
    cls[l] = k;
    profile[l] = PROFILE_OF_CLASS[k]!;
  }
  const lines: PlanLines = {
    kindStart: Uint32Array.from([0, lineCount, lineCount, lineCount, lineCount]),
    start: Uint32Array.from(lineStart),
    points: Float32Array.from(pts),
    grade: Float32Array.from(grade),
    halfWidth: Float32Array.from(hw),
    profile,
    cls,
    owner: Uint32Array.from(owner),
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    nodes: Float32Array.from(nodes),
  };
  o.mark('lines');

  // 6. The index of the lines.
  // The reach of a line counts the widest line at its nodes too: the corners of a node reach that far into it.
  const nodeWidest = new Float64Array(nodes.length / 4);
  for (let l = 0; l < lineCount; l++) {
    if (from[l]! >= 0) nodeWidest[from[l]!] = Math.max(nodeWidest[from[l]!]!, hw[lineStart[l]!]!);
    if (to[l]! >= 0) nodeWidest[to[l]!] = Math.max(nodeWidest[to[l]!]!, hw[lineStart[l + 1]! - 1]!);
  }
  const reachM = maxWidth.map((w, l) => tileReachM(Math.max(w, from[l]! >= 0 ? nodeWidest[from[l]!]! : 0, to[l]! >= 0 ? nodeWidest[to[l]!]! : 0)));
  const tiles = planLineTiles({ level: TILE_LEVEL, radiusM: R, start: lines.start, points: lines.points, reachM });
  o.mark('tiles');
  return { grid: g, relief, pool: d.pool, pools: d.pools, lines, tiles, channels };
}
