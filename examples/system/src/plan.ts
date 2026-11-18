// The plan of the inhabited world: one coarse plan of the whole of Hearth, a pure function of its seed. It is computed
// once (in one worker), sent to every thread as bytes, and read by everything that must know what lies beyond the cell
// it builds: where the sea and the lakes are, and where the rivers run from their springs to their mouths.
//
// Stages switch its parts on one by one (`STAGE`); a stage is cumulative, and code a lower stage runs is never edited
// by a later one. The plan is little-endian bytes with a table of sections (`encodePlan`, `decodePlan`), and every part
// has a fingerprint of its own (`planHash`), computed in plain integer arithmetic so Node and every browser agree.

import { sphereGrid } from 'wallhammer-web/gen-plan';
import type { LineTiles, SphereGrid } from 'wallhammer-web/gen-plan';
import { SURFACES } from './bodies.ts';
import { planMoisture } from './plan-climate.ts';
import { planRoutes } from './plan-routes.ts';
import { planSites } from './plan-sites.ts';
import { planWater } from './plan-water.ts';
import { bodyIndex } from './world.ts';

/** The stages of the plan; each adds sections and kinds of lines, and what cells gain from them. */
export const STAGE = { none: 0, water: 1, climate: 2, sites: 3, routes: 4, shade: 5 } as const;
/** Highest stage built so far; each task that adds a stage raises this constant. */
export const STAGE_MAX = 5;
/** Index of Hearth in `SURFACES`; no other body has a plan. */
export const PLAN_BODY = 0;
/** Grid of the plan: the cells of quadtree level 9 (about 300 m). */
export const PLAN_LEVEL = 9;
/** Index of the lines: tiles of level 8 (614 m). */
export const TILE_LEVEL = 8;
export const PLAN_VERSION = 1;

/** Kinds of lines, in the order they are grouped in `PlanLines`. A deck never changes the ground. */
export const LINE_KIND = { river: 0, lane: 1, road: 2, deck: 3 } as const;
export const SITE_KIND = { village: 0, town: 1 } as const;

/** All lines of the plan in one table. */
export interface PlanLines {
  /** 5 entries: lines are grouped by kind in the order of `LINE_KIND`. */
  kindStart: Uint32Array;
  /** Per line + 1: its first point. */
  start: Uint32Array;
  /** Per point: unit direction x y z. */
  points: Float32Array;
  /** Per point: height of the section's zero above the base sphere, m. */
  grade: Float32Array;
  /** Per point: half-width, m. */
  halfWidth: Float32Array;
  /** Per line: index into the profiles (brook 0, stream 1, river 2 for the kind `river`). */
  profile: Uint8Array;
  /** Per line: class 0…3 (0 the great rivers). */
  cls: Uint8Array;
  /** Per line: river id (the channel it belongs to), site or route. */
  owner: Uint32Array;
  /** Per line: index into `nodes`, −1 for a free end. */
  from: Int32Array;
  to: Int32Array;
  /** Per node: unit direction x y z and height m; grouped by the stage that made them. */
  nodes: Float32Array;
}

/** Sites of settlements (stage ≥ 3). */
export interface SiteTable {
  /** At most 128; site 0 is the town. */
  count: number;
  dir: Float32Array;
  heightM: Float32Array;
  tilt: Float32Array;
  radiusM: Float32Array;
  kind: Uint8Array;
  biome: Uint8Array;
  node: Uint32Array;
  gates: Uint32Array;
  gateNodes: Uint32Array;
}

/** Routes between sites (stage ≥ 4). */
export interface RouteTable {
  count: number;
  a: Uint16Array;
  b: Uint16Array;
  lengthM: Float32Array;
  lineStart: Uint32Array;
  lineOf: Uint32Array;
  spans: { route: Uint16Array; deck: Uint32Array; river: Uint32Array; ends: Float32Array; widthM: Float32Array };
}

/** The decoded plan; every array is a view into one buffer (no copy). */
export interface WorldPlan {
  /** Packed seed of the body (`packSeed`). */
  seed: number;
  /** 1…4: which sections are present. */
  stage: number;
  grid: SphereGrid;
  /** Per node: the terrain's own ground height at the node, in units of 0.5 m. */
  relief: Int16Array;
  /** Per node: 0, or 1 + index of the lake the node lies in. */
  pool: Uint16Array;
  /** Per lake: surface m, number of nodes, the node it spills at. */
  pools: { level: Float32Array; nodes: Uint32Array; outlet: Int32Array };
  lines: PlanLines;
  /** Derived from `lines`, not part of any fingerprint. */
  tiles: LineTiles;
  wet: Uint8Array | null;
  sites: SiteTable | null;
  routes: RouteTable | null;
}

/**
 * How far the index of tiles lets a line reach, from the widest half-width of the line and of the lines at its nodes:
 * at least the reach of its strip in the cells (`lineReachM` of plan-lines.ts: three such widths, a shoulder of at most
 * 220 m and a metre), with 40 m for the points the cells drop next to a node.
 */
export function tileReachM(widestAtLineM: number): number {
  return 3 * widestAtLineM + 261;
}

/**
 * The plan of the body `packed` names, up to `stage`. Pure. `o.heights` replaces the heights of the grid (computed
 * elsewhere from the same terrain); `o.mark` is called at the end of each phase (heights, drainage, channels, lines,
 * tiles, bytes) so a caller can read its clock. The result is the decoded form of its own bytes.
 */
export function worldPlan(packed: number, stage: number, o: { heights?: Float32Array; mark?: (phase: string) => void } = {}): WorldPlan {
  if (bodyIndex(packed) !== PLAN_BODY) throw new Error(`plan: the seed ${packed} names body ${bodyIndex(packed)}, only body ${PLAN_BODY} has a plan`);
  if (!(Number.isInteger(stage) && stage >= 1 && stage <= STAGE_MAX)) throw new Error(`plan: stage ${stage} is not built (1…${STAGE_MAX})`);
  const mark = o.mark ?? ((): void => {});
  const water = planWater(packed, { ...(o.heights ? { heights: o.heights } : {}), mark });
  const plan: WorldPlan = { seed: packed, stage, grid: water.grid, relief: water.relief, pool: water.pool, pools: water.pools, lines: water.lines, tiles: water.tiles, wet: null, sites: null, routes: null };
  if (stage >= STAGE.climate) {
    plan.wet = planMoisture(plan, packed);
    mark('moisture');
  }
  if (stage >= STAGE.sites) {
    const s = planSites(plan, packed);
    plan.sites = s.sites;
    plan.lines = s.lines;
    plan.tiles = s.tiles;
    mark('sites');
  }
  if (stage >= STAGE.routes) {
    // The routes read the plan as stage 3 left it (its nets, its ground); they append roads and decks to its lines.
    const r = planRoutes({ ...plan, stage: STAGE.sites });
    plan.routes = r.routes;
    plan.lines = r.lines;
    plan.tiles = r.tiles;
    mark('routes');
  }
  const bytes = encodePlan(plan);
  mark('bytes');
  return decodePlan(bytes.buffer);
}

// --- Format --------------------------------------------------------------------------------------------------------

type Section = Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Uint8Array;
type SectionType = Int16ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor | Float32ArrayConstructor | Uint8ArrayConstructor;

/** Sections of stage 1, with their ids and element types. */
const WATER_SECTIONS: readonly { id: number; type: SectionType; get: (p: WorldPlan) => Section }[] = [
  { id: 1, type: Int16Array, get: (p) => p.relief },
  { id: 2, type: Uint16Array, get: (p) => p.pool },
  { id: 3, type: Float32Array, get: (p) => p.pools.level },
  { id: 4, type: Uint32Array, get: (p) => p.pools.nodes },
  { id: 5, type: Int32Array, get: (p) => p.pools.outlet },
  { id: 6, type: Uint32Array, get: (p) => p.lines.kindStart },
  { id: 7, type: Uint32Array, get: (p) => p.lines.start },
  { id: 8, type: Float32Array, get: (p) => p.lines.points },
  { id: 9, type: Float32Array, get: (p) => p.lines.grade },
  { id: 10, type: Float32Array, get: (p) => p.lines.halfWidth },
  { id: 11, type: Uint8Array, get: (p) => p.lines.profile },
  { id: 12, type: Uint8Array, get: (p) => p.lines.cls },
  { id: 13, type: Uint32Array, get: (p) => p.lines.owner },
  { id: 14, type: Int32Array, get: (p) => p.lines.from },
  { id: 15, type: Int32Array, get: (p) => p.lines.to },
  { id: 16, type: Float32Array, get: (p) => p.lines.nodes },
  { id: 17, type: Uint32Array, get: (p) => p.tiles.keys },
  { id: 18, type: Uint32Array, get: (p) => p.tiles.start },
  { id: 19, type: Uint32Array, get: (p) => p.tiles.lines },
];
/** The section of stage 2: moisture per node, 0–255. */
const WET_SECTION = 20;
/** Sections of stage 3: the site table (its lane lines live with the other lines in sections 6–19). */
const SITE_SECTIONS: readonly { id: number; type: SectionType; get: (s: SiteTable) => Section }[] = [
  { id: 21, type: Float32Array, get: (s) => s.dir },
  { id: 22, type: Float32Array, get: (s) => s.heightM },
  { id: 23, type: Float32Array, get: (s) => s.tilt },
  { id: 24, type: Float32Array, get: (s) => s.radiusM },
  { id: 25, type: Uint8Array, get: (s) => s.kind },
  { id: 26, type: Uint8Array, get: (s) => s.biome },
  { id: 27, type: Uint32Array, get: (s) => s.node },
  { id: 28, type: Uint32Array, get: (s) => s.gates },
  { id: 29, type: Uint32Array, get: (s) => s.gateNodes },
];
/** Sections of stage 4: the route table (its road and deck lines live with the other lines in sections 6–19). */
const ROUTE_SECTIONS: readonly { id: number; type: SectionType; get: (r: RouteTable) => Section }[] = [
  { id: 30, type: Uint16Array, get: (r) => r.a },
  { id: 31, type: Uint16Array, get: (r) => r.b },
  { id: 32, type: Float32Array, get: (r) => r.lengthM },
  { id: 33, type: Uint32Array, get: (r) => r.lineStart },
  { id: 34, type: Uint32Array, get: (r) => r.lineOf },
  { id: 35, type: Uint16Array, get: (r) => r.spans.route },
  { id: 36, type: Uint32Array, get: (r) => r.spans.deck },
  { id: 37, type: Uint32Array, get: (r) => r.spans.river },
  { id: 38, type: Float32Array, get: (r) => r.spans.ends },
  { id: 39, type: Float32Array, get: (r) => r.spans.widthM },
];
const MAGIC = [0x57, 0x48, 0x50, 0x31]; // "WHP1"
const HEADER_BYTES = 40;
const ENTRY_BYTES = 12;
const align8 = (n: number): number => Math.ceil(n / 8) * 8;

function checkLittleEndian(): void {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('plan: a big-endian machine cannot read or write the plan');
}

/**
 * The plan as bytes: magic `WHP1`, version, seed, stage, grid level, tile level, radius, a table of sections (id,
 * offset, byte length), the sections aligned to 8 bytes; little-endian. The same plan gives the same bytes.
 */
export function encodePlan(plan: WorldPlan): Uint8Array {
  checkLittleEndian();
  const parts: { id: number; data: Section }[] = WATER_SECTIONS.map((s) => ({ id: s.id, data: s.get(plan) }));
  if (plan.stage >= STAGE.climate) {
    if (!plan.wet) throw new Error(`plan: stage ${plan.stage} without its moisture`);
    parts.push({ id: WET_SECTION, data: plan.wet });
  }
  if (plan.stage >= STAGE.sites) {
    const sites = plan.sites;
    if (!sites) throw new Error(`plan: stage ${plan.stage} without its sites`);
    for (const s of SITE_SECTIONS) parts.push({ id: s.id, data: s.get(sites) });
  }
  if (plan.stage >= STAGE.routes) {
    const routes = plan.routes;
    if (!routes) throw new Error(`plan: stage ${plan.stage} without its routes`);
    for (const s of ROUTE_SECTIONS) parts.push({ id: s.id, data: s.get(routes) });
  }
  let offset = align8(HEADER_BYTES + ENTRY_BYTES * parts.length);
  const placed = parts.map((p) => {
    const at = offset;
    offset = align8(offset + p.data.byteLength);
    return { ...p, at };
  });
  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint32(4, PLAN_VERSION, true);
  view.setUint32(8, plan.seed, true);
  view.setUint32(12, plan.stage, true);
  view.setUint32(16, plan.grid.level, true);
  view.setUint32(20, plan.tiles.level, true);
  view.setFloat64(24, plan.grid.radiusM, true);
  view.setUint32(32, placed.length, true);
  view.setUint32(36, 0, true);
  placed.forEach((p, i) => {
    const e = HEADER_BYTES + ENTRY_BYTES * i;
    view.setUint32(e, p.id, true);
    view.setUint32(e + 4, p.at, true);
    view.setUint32(e + 8, p.data.byteLength, true);
    bytes.set(new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength), p.at);
  });
  return bytes;
}

/** Reads a plan from its bytes. Every array is a view into `buffer`. Unknown sections are skipped. */
export function decodePlan(buffer: ArrayBufferLike): WorldPlan {
  checkLittleEndian();
  const bytes = new Uint8Array(buffer);
  if (bytes.length < HEADER_BYTES || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('plan: not a plan (no WHP1)');
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== PLAN_VERSION) throw new Error(`plan: version ${version}, this page reads ${PLAN_VERSION}`);
  const seed = view.getUint32(8, true);
  const stage = view.getUint32(12, true);
  const level = view.getUint32(16, true);
  const tileLevel = view.getUint32(20, true);
  const radiusM = view.getFloat64(24, true);
  const count = view.getUint32(32, true);
  const found = new Map<number, { at: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const e = HEADER_BYTES + ENTRY_BYTES * i;
    found.set(view.getUint32(e, true), { at: view.getUint32(e + 4, true), length: view.getUint32(e + 8, true) });
  }
  const arrays = new Map<number, Section>();
  if (stage >= STAGE.water) {
    for (const s of WATER_SECTIONS) {
      const f = found.get(s.id);
      if (!f) throw new Error(`plan: section ${s.id} of stage ${STAGE.water} is missing`);
      if (f.at % 8 !== 0 || f.at + f.length > bytes.length || f.length % s.type.BYTES_PER_ELEMENT !== 0) throw new Error(`plan: section ${s.id} is damaged`);
      arrays.set(s.id, new s.type(buffer as ArrayBuffer, f.at, f.length / s.type.BYTES_PER_ELEMENT));
    }
  }
  let wet: Uint8Array | null = null;
  if (stage >= STAGE.climate) {
    const f = found.get(WET_SECTION);
    if (!f) throw new Error(`plan: section ${WET_SECTION} of stage ${STAGE.climate} is missing`);
    if (f.at % 8 !== 0 || f.at + f.length > bytes.length) throw new Error(`plan: section ${WET_SECTION} is damaged`);
    wet = new Uint8Array(buffer as ArrayBuffer, f.at, f.length);
  }
  let sites: SiteTable | null = null;
  if (stage >= STAGE.sites) {
    const got = new Map<number, Section>();
    for (const s of SITE_SECTIONS) {
      const f = found.get(s.id);
      if (!f) throw new Error(`plan: section ${s.id} of stage ${STAGE.sites} is missing`);
      if (f.at % 8 !== 0 || f.at + f.length > bytes.length || f.length % s.type.BYTES_PER_ELEMENT !== 0) throw new Error(`plan: section ${s.id} is damaged`);
      got.set(s.id, new s.type(buffer as ArrayBuffer, f.at, f.length / s.type.BYTES_PER_ELEMENT));
    }
    const g = <T extends Section>(id: number): T => got.get(id) as T;
    sites = {
      count: g<Float32Array>(22).length,
      dir: g<Float32Array>(21),
      heightM: g<Float32Array>(22),
      tilt: g<Float32Array>(23),
      radiusM: g<Float32Array>(24),
      kind: g<Uint8Array>(25),
      biome: g<Uint8Array>(26),
      node: g<Uint32Array>(27),
      gates: g<Uint32Array>(28),
      gateNodes: g<Uint32Array>(29),
    };
  }
  let routes: RouteTable | null = null;
  if (stage >= STAGE.routes) {
    const got = new Map<number, Section>();
    for (const s of ROUTE_SECTIONS) {
      const f = found.get(s.id);
      if (!f) throw new Error(`plan: section ${s.id} of stage ${STAGE.routes} is missing`);
      if (f.at % 8 !== 0 || f.at + f.length > bytes.length || f.length % s.type.BYTES_PER_ELEMENT !== 0) throw new Error(`plan: section ${s.id} is damaged`);
      got.set(s.id, new s.type(buffer as ArrayBuffer, f.at, f.length / s.type.BYTES_PER_ELEMENT));
    }
    const g = <T extends Section>(id: number): T => got.get(id) as T;
    routes = {
      count: g<Uint16Array>(30).length,
      a: g<Uint16Array>(30),
      b: g<Uint16Array>(31),
      lengthM: g<Float32Array>(32),
      lineStart: g<Uint32Array>(33),
      lineOf: g<Uint32Array>(34),
      spans: { route: g<Uint16Array>(35), deck: g<Uint32Array>(36), river: g<Uint32Array>(37), ends: g<Float32Array>(38), widthM: g<Float32Array>(39) },
    };
  }
  const a =<T extends Section>(id: number): T => arrays.get(id) as T;
  return {
    seed,
    stage,
    grid: sphereGrid(radiusM, level),
    relief: a<Int16Array>(1),
    pool: a<Uint16Array>(2),
    pools: { level: a<Float32Array>(3), nodes: a<Uint32Array>(4), outlet: a<Int32Array>(5) },
    lines: {
      kindStart: a<Uint32Array>(6),
      start: a<Uint32Array>(7),
      points: a<Float32Array>(8),
      grade: a<Float32Array>(9),
      halfWidth: a<Float32Array>(10),
      profile: a<Uint8Array>(11),
      cls: a<Uint8Array>(12),
      owner: a<Uint32Array>(13),
      from: a<Int32Array>(14),
      to: a<Int32Array>(15),
      nodes: a<Float32Array>(16),
    },
    tiles: { level: tileLevel, keys: a<Uint32Array>(17), start: a<Uint32Array>(18), lines: a<Uint32Array>(19) },
    wet,
    sites,
    routes,
  };
}

// --- Fingerprint ---------------------------------------------------------------------------------------------------

/** A 64-bit hash in two 32-bit lanes of integer mixing, fed 32-bit words read from bytes. */
class Hash64 {
  private a = 0x6a09e667 | 0;
  private b = 0xbb67ae85 | 0;
  word(w: number): void {
    let a = Math.imul(this.a ^ w, 0x9e3779b1);
    a = (a << 13) | (a >>> 19);
    this.a = (Math.imul(a, 5) + 0xe6546b64) | 0;
    let b = Math.imul((this.b + w) | 0, 0x85ebca77);
    b = (b << 17) | (b >>> 15);
    this.b = (Math.imul(b ^ this.a, 0xc2b2ae3d) + 0x27d4eb2f) | 0;
  }
  /** An array: its tag, its length, then its bytes, four by four (the last word padded with zeros). */
  array(tag: number, data: Section): void {
    this.word(tag);
    this.word(data.length);
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const n = u8.length;
    let i = 0;
    for (; i + 4 <= n; i += 4) this.word(u8[i]! | (u8[i + 1]! << 8) | (u8[i + 2]! << 16) | (u8[i + 3]! << 24));
    if (i < n) {
      let w = 0;
      for (let k = 0; i + k < n; k++) w |= u8[i + k]! << (8 * k);
      this.word(w);
    }
  }
  hex(): string {
    const fmix = (h: number): number => {
      h ^= h >>> 16;
      h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      return (h ^ (h >>> 16)) >>> 0;
    };
    const a = fmix(this.a ^ Math.imul(this.b, 0x27d4eb2d));
    const b = fmix(this.b ^ a);
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
}

/**
 * Fingerprint of one part of the plan, 16 hex digits. `water` covers the relief, the pools and, of the lines, only
 * the kind `river` with their nodes; the tiles enter no fingerprint. Parts of stages not built throw.
 */
export function planHash(plan: WorldPlan, part: 'water' | 'climate' | 'sites' | 'routes'): string {
  if (part === 'climate') {
    if (!plan.wet) throw new Error(`plan: the part "climate" needs stage ${STAGE.climate}, the plan has ${plan.stage}`);
    const c = new Hash64();
    c.word(PLAN_VERSION);
    c.word(plan.seed);
    c.word(plan.grid.level);
    c.array(WET_SECTION, plan.wet);
    return c.hex();
  }
  if (part === 'sites') {
    const sites = plan.sites;
    if (!sites) throw new Error(`plan: the part "sites" needs stage ${STAGE.sites}, the plan has ${plan.stage}`);
    const c = new Hash64();
    c.word(PLAN_VERSION);
    c.word(plan.seed);
    c.word(plan.grid.level);
    for (const s of SITE_SECTIONS) c.array(s.id, s.get(sites));
    // The lane lines, with their points numbered from their first, and the nodes after the rivers' nodes.
    const L = plan.lines;
    const l0 = L.kindStart[LINE_KIND.lane]!;
    const l1 = L.kindStart[LINE_KIND.lane + 1]!;
    const p0 = L.start[l0]!;
    const p1 = L.start[l1]!;
    const start = new Uint32Array(l1 - l0 + 1);
    for (let i = 0; i < start.length; i++) start[i] = L.start[l0 + i]! - p0;
    let n0 = L.nodes.length / 4;
    for (let i = l0; i < l1; i++) for (const n of [L.from[i]!, L.to[i]!]) if (n >= 0) n0 = Math.min(n0, n);
    // From stage 4 the nodes of the roads follow: only those the lanes name (stage 3 makes no other node).
    let n1 = L.nodes.length / 4;
    if (plan.stage >= STAGE.routes) {
      n1 = n0;
      for (let i = l0; i < l1; i++) n1 = Math.max(n1, L.from[i]! + 1, L.to[i]! + 1);
    }
    c.array(7, start);
    c.array(8, L.points.subarray(3 * p0, 3 * p1));
    c.array(9, L.grade.subarray(p0, p1));
    c.array(10, L.halfWidth.subarray(p0, p1));
    c.array(11, L.profile.subarray(l0, l1));
    c.array(12, L.cls.subarray(l0, l1));
    c.array(13, L.owner.subarray(l0, l1));
    c.array(14, L.from.subarray(l0, l1));
    c.array(15, L.to.subarray(l0, l1));
    c.array(16, L.nodes.subarray(4 * n0, 4 * n1));
    return c.hex();
  }
  if (part === 'routes') {
    const routes = plan.routes;
    if (!routes) throw new Error(`plan: the part "routes" needs stage ${STAGE.routes}, the plan has ${plan.stage}`);
    const c = new Hash64();
    c.word(PLAN_VERSION);
    c.word(plan.seed);
    c.word(plan.grid.level);
    for (const s of ROUTE_SECTIONS) c.array(s.id, s.get(routes));
    // The road and deck lines, their points numbered from their first, and the nodes after those of stage 3.
    const L = plan.lines;
    const l0 = L.kindStart[LINE_KIND.road]!;
    const l1 = L.kindStart[LINE_KIND.deck + 1]!;
    const p0 = L.start[l0]!;
    const p1 = L.start[l1]!;
    const start = new Uint32Array(l1 - l0 + 1);
    for (let i = 0; i < start.length; i++) start[i] = L.start[l0 + i]! - p0;
    let n0 = 0;
    for (let i = 0; i < l0; i++) n0 = Math.max(n0, L.from[i]! + 1, L.to[i]! + 1);
    c.array(6, L.kindStart);
    c.array(7, start);
    c.array(8, L.points.subarray(3 * p0, 3 * p1));
    c.array(9, L.grade.subarray(p0, p1));
    c.array(10, L.halfWidth.subarray(p0, p1));
    c.array(11, L.profile.subarray(l0, l1));
    c.array(12, L.cls.subarray(l0, l1));
    c.array(13, L.owner.subarray(l0, l1));
    c.array(14, L.from.subarray(l0, l1));
    c.array(15, L.to.subarray(l0, l1));
    c.array(16, L.nodes.subarray(4 * n0));
    return c.hex();
  }
  if (part !== 'water') throw new Error(`plan: the part "${part}" is not built`);
  const h = new Hash64();
  h.word(PLAN_VERSION);
  h.word(plan.seed);
  h.word(plan.grid.level);
  h.array(1, plan.relief);
  h.array(2, plan.pool);
  h.array(3, plan.pools.level);
  h.array(4, plan.pools.nodes);
  h.array(5, plan.pools.outlet);
  const L = plan.lines;
  const l0 = L.kindStart[LINE_KIND.river]!;
  const l1 = L.kindStart[LINE_KIND.river + 1]!;
  const p0 = L.start[l0]!;
  const p1 = L.start[l1]!;
  const start = new Uint32Array(l1 - l0 + 1);
  for (let i = 0; i < start.length; i++) start[i] = L.start[l0 + i]! - p0;
  let w = 0;
  for (let i = l0; i < l1; i++) w = Math.max(w, L.from[i]! + 1, L.to[i]! + 1);
  if (plan.stage === STAGE.water && w * 4 !== L.nodes.length) throw new Error(`plan: river lines name ${w} nodes, the plan has ${L.nodes.length / 4}`);
  h.array(7, start);
  h.array(8, L.points.subarray(3 * p0, 3 * p1));
  h.array(9, L.grade.subarray(p0, p1));
  h.array(10, L.halfWidth.subarray(p0, p1));
  h.array(11, L.profile.subarray(l0, l1));
  h.array(12, L.cls.subarray(l0, l1));
  h.array(13, L.owner.subarray(l0, l1));
  h.array(14, L.from.subarray(l0, l1));
  h.array(15, L.to.subarray(l0, l1));
  h.array(16, L.nodes.subarray(0, 4 * w));
  return h.hex();
}

/** The radius of the body that has a plan. */
export const PLAN_RADIUS_M = SURFACES[PLAN_BODY]!.radiusM;
