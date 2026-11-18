// The lines of the plan of the world as strip nets (gen-core/strip.ts), one per tile of `TILE_LEVEL`, for the cells
// and the ground of Hearth (ground.ts, planned-cell.ts). Pure: no DOM, no worker, no clock; arithmetic, Math.sqrt,
// base/trig and the engine's tools only, so the page, every worker and Node build the same bits.
//
// Rules of a net, each needed for "the same bits from any net":
//   - Stage 1 holds the lines of `LINE_KIND.river` only, by index range, so a net is the same from a plan of any stage.
//   - The lines of a tile are those the plan's index lists for it plus every line of the stage that shares a node with
//     one of them (one ring), ascending by plan index, whole, never clipped; their nodes renumbered ascending.
//   - A line is conditioned by a rule that reads only it and the lines at its two nodes: inner points nearer to an end
//     at a node than `NODE_CLEAR` times the widest half-width at that node are dropped (the corners of a node reach
//     at most three times that width; a segment shorter than them is refused by `stripNet`).
//   - Derived data (lengths, runs, balls, node widths) is computed once per thread and plan object.

import { detAtan } from 'wallhammer-web/base';
import { cellId, sphereStripSurface, stripNet } from 'wallhammer-web/gen-core';
import type { CellId, StripLine, StripNet, StripNode, StripProfile, StripSurface } from 'wallhammer-web/gen-core';
import { gridNodeAt, sphereGrid, tileLinesOfCell } from 'wallhammer-web/gen-plan';
import { LINE_KIND, STAGE, TILE_LEVEL } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { QUADS } from './world.ts';

/** Carve sections by profile index: brook, stream, river (later tasks append lane, road, deck). Zero is the water level. */
export const PROFILES: readonly StripProfile[] = [
  { section: [-1, 0, -0.55, -0.5, 0.55, -0.5, 1, 0], shoulderM: 30, bedM: 0 },
  { section: [-1, 0, -0.6, -1.1, 0.6, -1.1, 1, 0], shoulderM: 90, bedM: 0 },
  { section: [-1, 0, -0.7, -2.4, 0.7, -2.4, 1, 0], shoulderM: 220, bedM: 0 },
  // Lane (stage 3): the ground a hand's breadth under the grade of its pad, a short shoulder.
  { section: [-1, -0.08, -0.5, -0.08, 0.5, -0.08, 1, -0.08], shoulderM: 2, bedM: 0 },
  // Road (stage 4): a low crown on a bed, the ground cut and filled over a shoulder.
  { section: [-1, 0, 0, 0.08, 1, 0], shoulderM: 5, bedM: 0.15 },
  // Deck (stage 4): never carved; the section the deck mesh draws, a skirt under each edge.
  { section: [-1.001, -1.2, -1, 0, 1, 0, 1.001, -1.2], shoulderM: 0, bedM: 0 },
];
/** Profile indices of the roads and decks (stage 4); the skirt under a deck's edge, metres. */
export const ROAD_PROFILE = 4;
export const DECK_PROFILE = 5;
export const DECK_SKIRT_M = 1.2;
/** Per profile, the section the water mesh (and the way mesh of a lane) draws: flat at the level, hems under the banks. */
export const SURFACE_SECTIONS: readonly (readonly number[])[] = [
  [-1.15, -0.6, -1, 0, 1, 0, 1.15, -0.6],
  [-1.15, -0.6, -1, 0, 1, 0, 1.15, -0.6],
  [-1.15, -0.6, -1, 0, 1, 0, 1.15, -0.6],
  [-1.1, -0.4, -1, 0, 1, 0, 1.1, -0.4],
  [-1.1, -0.4, -1, 0, 0, 0.08, 1, 0, 1.1, -0.4],
  [-1.001, -1.2, -1, 0, 1, 0, 1.001, -1.2],
];
/** The coarsest level whose cells mesh a line of class `c` (0 the great rivers). */
export const CLASS_FROM_LEVEL = [0, 4, 7, 9] as const;
/** Tile nets a thread keeps, the least recently used out. */
export const LINE_NET_CACHE = 512;
/** Inner points nearer to an end at a node than this many widest half-widths at that node are dropped. */
const NODE_CLEAR = 3.2;
/** Shoulder of the view that tells whether a point is clear of every strip (planClear), metres. */
const CLEAR_SHOULDER_M = 2;

/** What a thread derives once from a plan. */
interface Derived {
  /** End of the line kinds a stage holds (stage 1: rivers only). */
  kindEnd: number;
  /** Per node: the widest half-width of the lines that end there. */
  nodeWidth: Float64Array;
  /** Per line: its points after conditioning (unit directions), grades and half-widths. */
  points: Float64Array[];
  grades: Float64Array[];
  widths: Float64Array[];
  /** Per line: reach (lineReachM) and its ball on the base sphere (centre xyz in metres, radius). */
  reach: Float64Array;
  balls: Float64Array;
  /** Per line: length of the conditioned centre line, metres. */
  lengthM: Float64Array;
  /** Per node: the lines that end or start there, ascending. */
  nodeLines: number[][];
  /** Tile nets and coarse nets, by key; insertion order is the order of use. */
  nets: Map<string, StripNet | null>;
  runM: Float32Array | null;
}

/** Per plan, per end of the kinds (the nodes of a later kind change the widths at shared nodes): the derived data. */
const derivedOf = new WeakMap<WorldPlan, Map<number, Derived>>();
/** The plan line of every line of a net made here. */
const linesOfNet = new WeakMap<StripNet, Uint32Array>();
/** Per net: the view with a narrow shoulder that tells a clear point. */
const clearOf = new WeakMap<StripNet, StripNet>();
/** Every plan that has nets in this thread, for `clearLineNets`. */
const plansWithNets = new Set<WorldPlan>();

/** End of the line indices of the kinds stage `stage` holds. */
function kindEndOf(plan: WorldPlan, stage: number): number {
  const ks = plan.lines.kindStart;
  // Rivers from stage 1, lanes from stage 3, roads from stage 4; decks are never carved (`deckNetOfCell`).
  if (stage >= STAGE.routes && plan.stage >= STAGE.routes) return ks[LINE_KIND.road + 1]!;
  if (stage >= STAGE.sites && plan.stage >= STAGE.sites) return ks[LINE_KIND.lane + 1]!;
  return stage >= STAGE.water ? ks[LINE_KIND.river + 1]! : ks[LINE_KIND.river]!;
}

/**
 * The derived data a stage reads: stages 1–3 share the data of all kinds up to the lanes (a lane never shares a node
 * with a river), stage 4 has its own (a road widens the gates of the lanes it meets).
 */
function derive(plan: WorldPlan, stage: number = plan.stage): Derived {
  const kindEnd = kindEndOf(plan, stage >= STAGE.routes ? stage : Math.min(plan.stage, STAGE.sites));
  let byEnd = derivedOf.get(plan);
  if (!byEnd) {
    byEnd = new Map();
    derivedOf.set(plan, byEnd);
  }
  let d = byEnd.get(kindEnd);
  if (d) return d;
  const L = plan.lines;
  const R = plan.grid.radiusM;
  const first = L.kindStart[LINE_KIND.river]!;
  const nodeCount = L.nodes.length / 4;
  const nodeWidth = new Float64Array(nodeCount);
  const nodeLines: number[][] = [];
  for (let n = 0; n < nodeCount; n++) nodeLines.push([]);
  for (let l = first; l < kindEnd; l++) {
    const a = L.start[l]!;
    const b = L.start[l + 1]! - 1;
    const f = L.from[l]!;
    const t = L.to[l]!;
    if (f >= 0) {
      nodeWidth[f] = Math.max(nodeWidth[f]!, L.halfWidth[a]!);
      nodeLines[f]!.push(l);
    }
    if (t >= 0) {
      nodeWidth[t] = Math.max(nodeWidth[t]!, L.halfWidth[b]!);
      nodeLines[t]!.push(l);
    }
  }
  const points: Float64Array[] = [];
  const grades: Float64Array[] = [];
  const widths: Float64Array[] = [];
  const reach = new Float64Array(L.from.length);
  const balls = new Float64Array(L.from.length * 4);
  const lengthM = new Float64Array(L.from.length);
  for (let l = 0; l < L.from.length; l++) {
    if (l < first || l >= kindEnd) {
      points.push(new Float64Array(0));
      grades.push(new Float64Array(0));
      widths.push(new Float64Array(0));
      continue;
    }
    const a = L.start[l]!;
    const n = L.start[l + 1]! - a;
    const keep: number[] = [];
    for (let k = 0; k < n; k++) keep.push(a + k);
    const chordM = (i: number, j: number): number => {
      const dx = L.points[3 * i]! - L.points[3 * j]!;
      const dy = L.points[3 * i + 1]! - L.points[3 * j + 1]!;
      const dz = L.points[3 * i + 2]! - L.points[3 * j + 2]!;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
    };
    // The conditioning rule: clear the segment at each end that lies at a node.
    const f = L.from[l]!;
    const t = L.to[l]!;
    if (f >= 0) {
      const clear = NODE_CLEAR * nodeWidth[f]!;
      while (keep.length > 2 && chordM(keep[0]!, keep[1]!) < clear) keep.splice(1, 1);
    }
    if (t >= 0) {
      const clear = NODE_CLEAR * nodeWidth[t]!;
      while (keep.length > 2 && chordM(keep[keep.length - 1]!, keep[keep.length - 2]!) < clear) keep.splice(keep.length - 2, 1);
    }
    const m = keep.length;
    const p = new Float64Array(m * 3);
    const g = new Float64Array(m);
    const w = new Float64Array(m);
    let widest = 0;
    for (let k = 0; k < m; k++) {
      const i = keep[k]!;
      p[3 * k] = L.points[3 * i]!;
      p[3 * k + 1] = L.points[3 * i + 1]!;
      p[3 * k + 2] = L.points[3 * i + 2]!;
      g[k] = L.grade[i]!;
      w[k] = L.halfWidth[i]!;
      widest = Math.max(widest, w[k]!);
    }
    points.push(p);
    grades.push(g);
    widths.push(w);
    if (f >= 0) widest = Math.max(widest, nodeWidth[f]!);
    if (t >= 0) widest = Math.max(widest, nodeWidth[t]!);
    reach[l] = 3 * widest + PROFILES[L.profile[l]!]!.shoulderM + 1;
    // Length along the centre, as the strip tool measures it (arc of each chord on the sphere).
    let len = 0;
    let longest = 0;
    for (let k = 0; k + 1 < m; k++) {
      const dx = (p[3 * k + 3]! - p[3 * k]!) * R;
      const dy = (p[3 * k + 4]! - p[3 * k + 1]!) * R;
      const dz = (p[3 * k + 5]! - p[3 * k + 2]!) * R;
      const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const h = chord / 2;
      len += 2 * R * detAtan(h / Math.sqrt(Math.max(0, R * R - h * h)));
      longest = Math.max(longest, chord);
    }
    lengthM[l] = len;
    // Ball: the mean direction, the farthest point, half the longest segment, the reach and a metre.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < m; k++) {
      cx += p[3 * k]!;
      cy += p[3 * k + 1]!;
      cz += p[3 * k + 2]!;
    }
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
    cx = (cx / cl) * R;
    cy = (cy / cl) * R;
    cz = (cz / cl) * R;
    let far = 0;
    for (let k = 0; k < m; k++) {
      const dx = p[3 * k]! * R - cx;
      const dy = p[3 * k + 1]! * R - cy;
      const dz = p[3 * k + 2]! * R - cz;
      far = Math.max(far, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    balls[4 * l] = cx;
    balls[4 * l + 1] = cy;
    balls[4 * l + 2] = cz;
    balls[4 * l + 3] = far + longest / 2 + reach[l]! + 1;
  }
  d = { kindEnd, nodeWidth, points, grades, widths, reach, balls, lengthM, nodeLines, nets: new Map(), runM: null };
  byEnd.set(kindEnd, d);
  return d;
}

/**
 * How far line `line` reaches from its centre: 3 × the widest half-width of the line and of the lines at its nodes
 * (the corners of a node), its shoulder and a metre.
 */
export function lineReachM(plan: WorldPlan, line: number, stage: number = plan.stage): number {
  return derive(plan, stage).reach[line]!;
}

/** Whether a point of the base sphere (metres) lies in the ball of plan line `line` as stage `stage` conditions it. */
export function inLineBall(plan: WorldPlan, line: number, x: number, y: number, z: number, stage: number = plan.stage): boolean {
  const b = derive(plan, stage).balls;
  const dx = x - b[4 * line]!;
  const dy = y - b[4 * line + 1]!;
  const dz = z - b[4 * line + 2]!;
  const r = b[4 * line + 3]!;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** Length of the conditioned centre line of plan line `line`, metres (the strip tool's measure). */
export function lineLengthM(plan: WorldPlan, line: number, stage: number = plan.stage): number {
  return derive(plan, stage).lengthM[line]!;
}

/** The net of a list of plan lines (ascending, each once) and their ring, or null without lines. */
function buildNet(plan: WorldPlan, d: Derived, core: readonly number[]): StripNet | null {
  const L = plan.lines;
  const R = plan.grid.radiusM;
  const set = new Set<number>(core);
  for (const l of core) {
    for (const n of [L.from[l]!, L.to[l]!]) if (n >= 0) for (const o of d.nodeLines[n]!) set.add(o);
  }
  if (set.size === 0) return null;
  const lines = [...set].sort((a, b) => a - b);
  const nodeIds: number[] = [];
  for (const l of lines) for (const n of [L.from[l]!, L.to[l]!]) if (n >= 0) nodeIds.push(n);
  const nodeList = [...new Set(nodeIds)].sort((a, b) => a - b);
  const nodeIndex = new Map<number, number>();
  nodeList.forEach((n, i) => nodeIndex.set(n, i));
  const nodes: StripNode[] = nodeList.map((n) => ({ point: [L.nodes[4 * n]! * R, L.nodes[4 * n + 1]! * R, L.nodes[4 * n + 2]! * R], heightM: L.nodes[4 * n + 3]! }));
  const input: StripLine[] = lines.map((l) => {
    const p = d.points[l]!;
    const scaled = new Float64Array(p.length);
    for (let k = 0; k < p.length; k++) scaled[k] = p[k]! * R;
    const f = L.from[l]!;
    const t = L.to[l]!;
    return {
      points: scaled,
      heights: d.grades[l]!,
      halfWidths: d.widths[l]!,
      profile: L.profile[l]!,
      ...(f >= 0 ? { from: nodeIndex.get(f)! } : {}),
      ...(t >= 0 ? { to: nodeIndex.get(t)! } : {}),
    };
  });
  const net = stripNet({ radiusM: R, profiles: PROFILES.map((p) => ({ section: [...p.section], shoulderM: p.shoulderM, bedM: p.bedM })), nodes, lines: input });
  linesOfNet.set(net, Uint32Array.from(lines));
  plansWithNets.add(plan);
  return net;
}

/** A net from the cache, or built and put there; the least recently used leave over `LINE_NET_CACHE`. */
function cachedNet(plan: WorldPlan, d: Derived, key: string, lines: () => number[]): StripNet | null {
  const nets = d.nets;
  if (nets.has(key)) {
    const net = nets.get(key)!;
    nets.delete(key);
    nets.set(key, net);
    return net;
  }
  const net = buildNet(plan, d, lines());
  nets.set(key, net);
  while (nets.size > LINE_NET_CACHE) nets.delete(nets.keys().next().value!);
  return net;
}

const scratch: number[] = [];

/** The lines the plan's index lists for a tile, within the kinds of the stage. */
function tileCore(plan: WorldPlan, kindEnd: number, face: number, x: number, y: number): number[] {
  const first = plan.lines.kindStart[LINE_KIND.river]!;
  tileLinesOfCell(plan.tiles, cellId(face, TILE_LEVEL, x, y), scratch);
  return scratch.filter((l) => l >= first && l < kindEnd);
}

/** The net of the tile of `TILE_LEVEL` that holds face cell (face, x, y), cached. */
function tileNet(plan: WorldPlan, stage: number, face: number, x: number, y: number): StripNet | null {
  const d = derive(plan, stage);
  const kindEnd = kindEndOf(plan, stage);
  return cachedNet(plan, d, `t${kindEnd}:${face}:${x}:${y}`, () => tileCore(plan, kindEnd, face, x, y));
}

// Made when first asked: plan.ts reaches this module through plan-sites.ts before its own constants exist.
let tileGridMemo: ReturnType<typeof sphereGrid> | null = null;
const tileGridOf = (): ReturnType<typeof sphereGrid> => (tileGridMemo ??= sphereGrid(1, TILE_LEVEL));

/** The plan lines (of the stage) the index lists for the tile that holds a point, ascending. */
export function tileLinesAtPoint(plan: WorldPlan, stage: number, x: number, y: number, z: number): number[] {
  const tileGrid = tileGridOf();
  const key = gridNodeAt(tileGrid, x, y, z);
  const n = tileGrid.n;
  const face = Math.floor(key / (n * n));
  const r = key - face * n * n;
  return tileCore(plan, kindEndOf(plan, stage), face, r % n, Math.floor(r / n));
}

/** The net of the tile that holds a point (any length of the direction), cached; null where no line reaches. */
export function lineNetAt(plan: WorldPlan, stage: number, x: number, y: number, z: number): StripNet | null {
  const tileGrid = tileGridOf();
  const key = gridNodeAt(tileGrid, x, y, z);
  const n = tileGrid.n;
  const face = Math.floor(key / (n * n));
  const r = key - face * n * n;
  return tileNet(plan, stage, face, r % n, Math.floor(r / n));
}

/**
 * The net a cell meshes from: at `TILE_LEVEL` or finer the net of its tile (the same cached object); coarser the lines
 * under it whose class is meshed at its level, with their ring.
 */
export function lineNetOfCell(plan: WorldPlan, stage: number, cell: CellId): StripNet | null {
  if (cell.level >= TILE_LEVEL) {
    const shift = 2 ** (cell.level - TILE_LEVEL);
    return tileNet(plan, stage, cell.face, Math.floor(cell.x / shift), Math.floor(cell.y / shift));
  }
  const d = derive(plan, stage);
  const kindEnd = kindEndOf(plan, stage);
  const first = plan.lines.kindStart[LINE_KIND.river]!;
  return cachedNet(plan, d, `c${kindEnd}:${cell.face}:${cell.level}:${cell.x}:${cell.y}`, () => {
    tileLinesOfCell(plan.tiles, cell, scratch);
    return scratch.filter((l) => l >= first && l < kindEnd && CLASS_FROM_LEVEL[Math.min(3, plan.lines.cls[l]!)]! <= cell.level);
  });
}

/** The plan line of every line of a net made here (or a view of one). */
export function netLines(net: StripNet): Uint32Array {
  const l = linesOfNet.get(net);
  if (!l) throw new Error('netLines: not a net of plan-lines.ts');
  return l;
}

/**
 * The view of a net the water mesh is made from: the same station arrays, only the lines of `kind` whose class is
 * meshed at `level`, and profiles whose section is `SURFACE_SECTIONS`. Null when no line is left.
 */
export function meshNet(net: StripNet, plan: WorldPlan, kind: number, level: number, kindEnd: number = kind + 1): StripNet | null {
  const all = netLines(net);
  const ks = plan.lines.kindStart;
  const keep: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i < net.lineCount; i++) {
    const l = all[i]!;
    if (l < ks[kind]! || l >= ks[kindEnd]!) continue;
    if (CLASS_FROM_LEVEL[Math.min(3, plan.lines.cls[l]!)]! > level) continue;
    keep.push(i);
    kept.push(l);
  }
  if (keep.length === 0) return null;
  const view: StripNet = {
    radiusM: net.radiusM,
    lineCount: keep.length,
    reachM: net.reachM,
    profiles: net.profiles.map((p, i) => ({ section: SURFACE_SECTIONS[i] ?? p.section, shoulderM: p.shoulderM, bedM: p.bedM })),
    lines: keep.map((i) => net.lines[i]!),
  };
  linesOfNet.set(view, Uint32Array.from(kept));
  return view;
}

/** The view of a net whose shoulders are `CLEAR_SHOULDER_M`: a share above 0 means nearer to a strip than that. */
export function clearNet(net: StripNet): StripNet {
  let v = clearOf.get(net);
  if (!v) {
    v = { radiusM: net.radiusM, lineCount: net.lineCount, reachM: net.reachM, profiles: net.profiles.map((p) => ({ section: p.section, shoulderM: CLEAR_SHOULDER_M, bedM: p.bedM })), lines: net.lines };
    clearOf.set(net, v);
    linesOfNet.set(v, netLines(net));
  }
  return v;
}

/** The surface a water mesh stands on: the sphere of the cells (`QUADS`) over the given ground. */
export function planStripSurface(plan: WorldPlan, heightAt: (x: number, y: number, z: number) => number): StripSurface {
  return sphereStripSurface({ radiusM: plan.grid.radiusM, quads: QUADS, heightAt });
}

/**
 * Per line (rivers): metres from its end down to the end of its water, the sea or the lake it runs into. Downstream
 * lines have higher indices, so one pass from the last line to the first finds them all.
 */
export function riverRunM(plan: WorldPlan): Float32Array {
  const d = derive(plan);
  if (d.runM) return d.runM;
  const L = plan.lines;
  const first = L.kindStart[LINE_KIND.river]!;
  const end = L.kindStart[LINE_KIND.river + 1]!;
  const startsAt = new Int32Array(L.nodes.length / 4).fill(-1);
  for (let l = first; l < end; l++) if (L.from[l]! >= 0 && startsAt[L.from[l]!]! < 0) startsAt[L.from[l]!] = l;
  const run = new Float64Array(L.from.length);
  for (let l = end - 1; l >= first; l--) {
    const t = L.to[l]!;
    const next = t >= 0 ? startsAt[t]! : -1;
    run[l] = next > l ? run[next]! + d.lengthM[next]! : 0;
  }
  d.runM = Float32Array.from(run);
  return d.runM;
}

/** Forgets every net this thread built (for the golden recipe: the bytes must not depend on the cache). */
export function clearLineNets(): void {
  for (const p of plansWithNets) {
    const byEnd = derivedOf.get(p);
    if (byEnd) for (const d of byEnd.values()) d.nets.clear();
    deckNetsOf.get(p)?.clear();
  }
  plansWithNets.clear();
}

// --- Decks (stage 4) ------------------------------------------------------------------------------------------------

/** Per plan: deck nets by key (insertion order the order of use). */
const deckNetsOf = new WeakMap<WorldPlan, Map<string, StripNet | null>>();

/** The deck lines (stage 4) the index lists for a tile or cell, ascending, whose class is meshed at `level`. */
function deckCore(plan: WorldPlan, cell: CellId, level: number): number[] {
  const ks = plan.lines.kindStart;
  tileLinesOfCell(plan.tiles, cell, scratch);
  return scratch.filter((l) => l >= ks[LINE_KIND.deck]! && l < ks[LINE_KIND.deck + 1]! && CLASS_FROM_LEVEL[Math.min(3, plan.lines.cls[l]!)]! <= level);
}

/**
 * The net of the decks over a cell (free ends, grades as planned, never carved into the ground): only to mesh them and
 * to keep the ground under them clear. Null below stage 4 or without a deck.
 */
export function deckNetOfCell(plan: WorldPlan, cell: CellId): StripNet | null {
  if (plan.stage < STAGE.routes) return null;
  const tile = cell.level >= TILE_LEVEL ? cellId(cell.face, TILE_LEVEL, Math.floor(cell.x / 2 ** (cell.level - TILE_LEVEL)), Math.floor(cell.y / 2 ** (cell.level - TILE_LEVEL))) : cell;
  const level = Math.min(cell.level, TILE_LEVEL);
  const key = `${tile.face}:${tile.level}:${tile.x}:${tile.y}:${level}`;
  let nets = deckNetsOf.get(plan);
  if (!nets) {
    nets = new Map();
    deckNetsOf.set(plan, nets);
  }
  if (nets.has(key)) {
    const net = nets.get(key)!;
    nets.delete(key);
    nets.set(key, net);
    return net;
  }
  const lines = deckCore(plan, tile, cell.level >= TILE_LEVEL ? 99 : level);
  let net: StripNet | null = null;
  if (lines.length > 0) {
    const L = plan.lines;
    const R = plan.grid.radiusM;
    const input: StripLine[] = lines.map((l) => {
      const a = L.start[l]!;
      const b = L.start[l + 1]!;
      const pts = new Float64Array(3 * (b - a));
      for (let k = 0; k < pts.length; k++) pts[k] = L.points[3 * a + k]! * R;
      return { points: pts, heights: Float64Array.from(L.grade.subarray(a, b)), halfWidths: Float64Array.from(L.halfWidth.subarray(a, b)), profile: L.profile[l]! };
    });
    net = stripNet({ radiusM: R, profiles: PROFILES.map((p) => ({ section: [...p.section], shoulderM: p.shoulderM, bedM: p.bedM })), lines: input });
    linesOfNet.set(net, Uint32Array.from(lines));
    plansWithNets.add(plan);
  }
  nets.set(key, net);
  while (nets.size > LINE_NET_CACHE) nets.delete(nets.keys().next().value!);
  return net;
}

/** Whether a point (metres, any length) lies under a deck or within `marginM` of its edge: the ground there stays clear. */
export function nearDeck(plan: WorldPlan, x: number, y: number, z: number, marginM: number): boolean {
  if (plan.stage < STAGE.routes) return false;
  const L = plan.lines;
  const ks = L.kindStart;
  const R = plan.grid.radiusM;
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  const px = (x / l) * R;
  const py = (y / l) * R;
  const pz = (z / l) * R;
  for (const line of deckLinesAt(plan, x, y, z)) {
    if (line < ks[LINE_KIND.deck]! || line >= ks[LINE_KIND.deck + 1]!) continue;
    for (let p = L.start[line]!; p + 1 < L.start[line + 1]!; p++) {
      const ax = L.points[3 * p]! * R;
      const ay = L.points[3 * p + 1]! * R;
      const az = L.points[3 * p + 2]! * R;
      const ex = L.points[3 * p + 3]! * R - ax;
      const ey = L.points[3 * p + 4]! * R - ay;
      const ez = L.points[3 * p + 5]! * R - az;
      const e2 = ex * ex + ey * ey + ez * ez;
      const t = e2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / e2)) : 0;
      const d = Math.sqrt((ax + ex * t - px) ** 2 + (ay + ey * t - py) ** 2 + (az + ez * t - pz) ** 2);
      if (d <= L.halfWidth[p]! + marginM) return true;
    }
  }
  return false;
}

/** The lines the index lists for the tile that holds a point, all kinds. */
function deckLinesAt(plan: WorldPlan, x: number, y: number, z: number): number[] {
  const tileGrid = tileGridOf();
  const key = gridNodeAt(tileGrid, x, y, z);
  const n = tileGrid.n;
  const face = Math.floor(key / (n * n));
  const r = key - face * n * n;
  tileLinesOfCell(plan.tiles, cellId(face, TILE_LEVEL, r % n, Math.floor(r / n)), scratch);
  return scratch.slice();
}
