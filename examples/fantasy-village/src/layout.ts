// The layout of the village: the single source of truth for where everything is. Pure 2D data (x east, z south,
// metres; the village square is at the origin) plus derived geometry: smoothed paths and river, lanterns, fences,
// gardens, trees, points of interest and the walking graph. Heights come from src/terrain/height.ts, which reads
// this file (never the other way round).
//
// Yaw convention (kit/math.ts): yaw 0 faces +z (south), +π/2 faces +x (east); a structure's front (door side) is
// its local +z. Every value here is deterministic: scattered things (trees) use the stream 'layout' of the seed.

import type { NavEdgeInput, NavGraphInput } from 'wallhammer-web/sim';
import type { Vec2 } from './kit/math.ts';
import { nearestOnPolyline, pointInRing, polylineLengths, rotateY, signedDistToRing, smoothPolyline, yawOf } from './kit/math.ts';
import { Stream } from './kit/rng.ts';

// --- Types -------------------------------------------------------------------------------------------------------------

/** A rectangle in a structure's local frame: centre, width along local x, depth along local z. */
export interface LocalRect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export type StructureKind = 'inn' | 'cottage' | 'forge' | 'mill' | 'windmill' | 'castle';

/** Plan variants of cottages: each one has a different silhouette (B2). */
export type CottagePlan = 'L' | 'annex' | 'dormer' | 'chimney' | 'long' | 'crooked';

export interface Structure {
  /** Unique id, e.g. 'inn', 'cottage-2', 'forge'. */
  id: string;
  kind: StructureKind;
  /** Index within its kind. */
  index: number;
  /** Centre of the main body in world x, z. */
  x: number;
  z: number;
  /** Heading of the front (door side). */
  yaw: number;
  /** Main body in the local frame. */
  body: LocalRect;
  /** Further parts (wings, annexes, sheds) in the local frame. */
  wings: LocalRect[];
  /** World outlines (flat x, z pairs, counter-clockwise seen from above) of the body and of each wing. */
  footprints: number[][];
  /** The levelled pad under the structure: a world ring (body and wings with a margin) and the falloff width. */
  pad: { ring: number[]; falloff: number };
  /** Front door: world point on the outer wall face and the outward heading. */
  door: { x: number; z: number; yaw: number };
  /** Number of floors of the main body. */
  stories: number;
  /** Cottage plan (cottages only). */
  plan?: CottagePlan;
  /** Roof covering. */
  roof: 'slate' | 'red' | 'rust' | 'thatch' | 'none';
  /** Seed variant for the builders (0–1). */
  variant: number;
  /** The pad stands this much above the natural ground (a terrace with a retaining wall, B3). */
  raise: number;
}

export interface PathLine {
  id: string;
  /** 'cobble' for the main streets and the square, 'dirt' for spurs and tracks. */
  kind: 'cobble' | 'dirt';
  /** Paved width in metres (grass edges come on top). */
  width: number;
  /** Control points (x, z). */
  control: Vec2[];
  /** Smoothed centre line, about 1 m apart. */
  dense: Vec2[];
  /** Cumulative length along `dense`. */
  lengths: number[];
}

export interface RiverPoint {
  x: number;
  z: number;
  /** Water width at this point. */
  width: number;
  /** Water surface height. */
  y: number;
  /** Distance along the river from its upstream end. */
  along: number;
}

export interface River {
  /** Control points: x, z, width. */
  control: [number, number, number][];
  /** Smoothed, about 1 m apart, with the surface height of each point. */
  dense: RiverPoint[];
  /** The same as (x, z) pairs, for distance queries. */
  line: Vec2[];
  lengths: number[];
  /** Depth of the bed under the surface in the middle. */
  depth: number;
}

export interface Weir {
  x: number;
  z: number;
  /** Heading of the flow over it (the crest runs across it). */
  yaw: number;
  width: number;
  /** Surface height above and below. */
  top: number;
  bottom: number;
  /** Distance along the river. */
  along: number;
}

export interface Bridge {
  x: number;
  z: number;
  /** Heading along the deck (the path direction). */
  yaw: number;
  length: number;
  width: number;
  /** Height of the walking surface at the middle (the arch rises to it). */
  deckY: number;
  /** Water surface under it. */
  waterY: number;
}

export interface MillWheel {
  x: number;
  z: number;
  /** Height of the axle. */
  y: number;
  /** Heading of the axle: along the mill's local z, square to its river wall, so the shaft runs into the mill. */
  yaw: number;
  radius: number;
  width: number;
}

export type TreeKind = 'giant' | 'broadleaf' | 'conifer' | 'bush';

export interface TreeSpot {
  x: number;
  z: number;
  kind: TreeKind;
  /** Scale against the kind's typical size (0.7–1.4). */
  scale: number;
  /** Per-tree seed (0–1). */
  variant: number;
}

export interface Lantern {
  x: number;
  z: number;
  /** Heading the arm points to (over the path). */
  yaw: number;
}

export interface Fence {
  /** Posts along these points (x, z). */
  points: Vec2[];
  kind: 'rail' | 'picket';
  closed: boolean;
}

export interface Garden {
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  crop: 'cabbage' | 'pumpkin' | 'flowers' | 'herbs';
}

export interface Stall {
  x: number;
  z: number;
  /** Heading the counter faces (toward the customers). */
  yaw: number;
  canopy: 'red' | 'cream' | 'stripes';
  goods: 'vegetables' | 'apples' | 'cloth' | 'pottery';
}

export type PoiKind =
  | 'anvil' | 'forge-fire' | 'stall' | 'inn-door' | 'inn-bench' | 'garden' | 'bridge-guard' | 'well' | 'bench'
  | 'mill-door' | 'cottage-door' | 'square' | 'market' | 'chickens' | 'road-end' | 'barrels' | 'riverside';

/** A place where villagers do something. */
export interface Poi {
  id: string;
  kind: PoiKind;
  x: number;
  z: number;
  /** Heading a villager faces while there. */
  yaw: number;
  /** Node of the walking graph that serves it. */
  node: number;
}

export interface VillageLayout {
  /** The village square (paved disc). */
  square: { x: number; z: number; radius: number };
  structures: Structure[];
  paths: PathLine[];
  river: River;
  weir: Weir;
  bridge: Bridge;
  millWheel: MillWheel;
  trees: TreeSpot[];
  lanterns: Lantern[];
  fences: Fence[];
  gardens: Garden[];
  stalls: Stall[];
  well: { x: number; z: number };
  benches: { x: number; z: number; yaw: number }[];
  pois: Poi[];
  /** Walking graph for `NavGraph` (wallhammer-web/sim): nodes as x, z pairs, edges both ways. */
  nav: NavGraphInput;
  /** Terrain extent: detailed ground up to `inner` from the origin, backdrop hills up to `outer`. */
  terrain: { inner: number; outer: number };
  /** Hill ring: the village lies in a bowl, hills rise between these radii. */
  hills: { from: number; to: number; height: number };
}

// --- Fixed composition (B3) ----------------------------------------------------------------------------------------------

/** World ring of a local rectangle of a structure placed at (x, z, yaw). */
function rectRing(x: number, z: number, yaw: number, r: LocalRect, grow = 0): number[] {
  const out: number[] = [];
  // Counter-clockwise seen from above (+y): with x east and z south that is x−,z− → x−,z+ → x+,z+ → x+,z−.
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const) {
    const [dx, dz] = rotateY(r.x + sx * (r.w / 2 + grow), r.z + sz * (r.d / 2 + grow), yaw);
    out.push(x + dx, z + dz);
  }
  return out;
}

/** World point of a local point of a structure. */
export function toWorld(s: Pick<Structure, 'x' | 'z' | 'yaw'>, lx: number, lz: number): Vec2 {
  const [dx, dz] = rotateY(lx, lz, s.yaw);
  return [s.x + dx, s.z + dz];
}

/** Local point of a world point. */
export function toLocal(s: Pick<Structure, 'x' | 'z' | 'yaw'>, wx: number, wz: number): Vec2 {
  return rotateY(wx - s.x, wz - s.z, -s.yaw);
}

interface StructureSeed {
  id: string;
  kind: StructureKind;
  index: number;
  x: number;
  z: number;
  /** A fixed heading, or a point the front should face. */
  facing: number | Vec2;
  body: LocalRect;
  wings?: LocalRect[];
  stories: number;
  plan?: CottagePlan;
  roof: Structure['roof'];
  /** Door in local x along the front (default the body centre). */
  doorX?: number;
  margin?: number;
  raise?: number;
}

const SEEDS: StructureSeed[] = [
  // The inn: two floors, main body with a wing to its east side, front to the square (south-west).
  { id: 'inn', kind: 'inn', index: 0, x: 6, z: -12, facing: [0, 1], body: { x: -1.5, z: 0, w: 11, d: 8.5 }, wings: [{ x: 5.5, z: -1.2, w: 5, d: 7 }], stories: 2, roof: 'slate', doorX: -1.5, margin: 1.8 },
  { id: 'forge', kind: 'forge', index: 0, x: 20, z: 9, facing: -Math.PI / 2, body: { x: 0, z: 0, w: 7, d: 5.5 }, wings: [{ x: -2.2, z: -3.8, w: 2.6, d: 2.2 }], stories: 1, roof: 'red', margin: 1.5 },
  { id: 'mill', kind: 'mill', index: 0, x: 33, z: -24, facing: -Math.PI / 2, body: { x: 0, z: 0, w: 6.5, d: 6.5 }, stories: 2, roof: 'slate', margin: 1.2 },
  { id: 'cottage-0', kind: 'cottage', index: 0, x: -26, z: -10, facing: [-17, -14], body: { x: 0, z: 0, w: 7.5, d: 5.5 }, wings: [{ x: 2.6, z: -4.3, w: 3.6, d: 3.6 }], stories: 1, plan: 'L', roof: 'red' },
  { id: 'cottage-1', kind: 'cottage', index: 1, x: -36, z: -26, facing: [-28, -29], body: { x: 0, z: 0, w: 7, d: 5.5 }, stories: 2, plan: 'chimney', roof: 'rust', raise: 1.6, margin: 2.2 },
  { id: 'cottage-2', kind: 'cottage', index: 2, x: -12, z: -30, facing: [-16, -21], body: { x: 0, z: 0, w: 6.5, d: 5 }, wings: [{ x: -4.6, z: -0.6, w: 2.8, d: 3.8 }], stories: 1, plan: 'annex', roof: 'red' },
  { id: 'cottage-3', kind: 'cottage', index: 3, x: -30, z: 16, facing: [-20, 15], body: { x: 0, z: 0, w: 8, d: 5.5 }, stories: 1, plan: 'dormer', roof: 'red' },
  { id: 'cottage-4', kind: 'cottage', index: 4, x: 26, z: -36, facing: [27, -26], body: { x: 0, z: 0, w: 9, d: 5 }, stories: 1, plan: 'long', roof: 'thatch' },
  { id: 'cottage-5', kind: 'cottage', index: 5, x: -4, z: 42, facing: [8, 40], body: { x: 0, z: 0, w: 6.5, d: 5.5 }, wings: [{ x: -3.9, z: 1.2, w: 2.2, d: 3 }], stories: 1, plan: 'crooked', roof: 'red' },
  // Far landmarks.
  { id: 'windmill', kind: 'windmill', index: 0, x: -75, z: -70, facing: [0, 0], body: { x: 0, z: 0, w: 5, d: 5 }, stories: 3, roof: 'thatch', margin: 2 },
  { id: 'castle', kind: 'castle', index: 0, x: 0, z: -150, facing: [0, 0], body: { x: 0, z: 0, w: 34, d: 22 }, stories: 4, roof: 'slate', margin: 3 },
];

/** River control points (x, z, width), upstream (north-east) to downstream (west). Leaves the terrain on both ends. */
const RIVER_CONTROL: [number, number, number][] = [
  [95, -72, 6], [65, -45, 6], [52, -35, 6.5], [41, -23, 7.5], [36, -6, 7], [33, 6, 7], [24, 19, 7], [14, 26.5, 7],
  [0, 31, 7], [-20, 33, 7], [-45, 31, 6.5], [-70, 30, 6], [-120, 25, 6],
];
/** Surface heights: upstream end, just above the weir, just below it, at the bridge, downstream end. */
const RIVER_Y = { start: 4.2, aboveWeir: 3.1, belowWeir: 1.1, bridge: 0.7, end: -0.3 };
const RIVER_DEPTH = 1.0;
/** Where the weir sits (nearest river point) and where the mill wheel turns. */
const WEIR_AT: Vec2 = [42, -27.5];
const WHEEL_AT: Vec2 = [38.4, -24];

const PATHS: Omit<PathLine, 'dense' | 'lengths'>[] = [
  // North-west street: from the hills past the cottages to the square.
  { id: 'north-west', kind: 'cobble', width: 3.4, control: [[-62, -80], [-45, -55], [-40, -42], [-31, -33], [-23, -21], [-15, -11], [-7, -3], [-1, 1]] },
  // South street: from the square past the forge, over the bridge, on to the south.
  { id: 'south', kind: 'cobble', width: 3.6, control: [[1, 3], [6, 9], [10, 15], [12.4, 20.5], [14, 26], [15.6, 31.5], [17, 38], [19, 50], [22, 65], [27, 95]] },
  // To the mill along the inn.
  { id: 'mill', kind: 'cobble', width: 3, control: [[4, 0], [10, 1], [19, -5], [25.5, -15], [28.5, -23.4]] },
  // West to the cottage behind the market.
  { id: 'west', kind: 'cobble', width: 3, control: [[-4, 7], [-9, 10], [-16, 15], [-25.5, 16.5]] },
  // Dirt spurs to the cottages that do not stand on a street.
  { id: 'spur-cottage-2', kind: 'dirt', width: 2.2, control: [[-19, -16], [-16, -21], [-14, -25.5]] },
  { id: 'spur-cottage-4', kind: 'dirt', width: 2.2, control: [[25.5, -15], [27, -22], [26.8, -29.5]] },
  { id: 'spur-cottage-5', kind: 'dirt', width: 2.2, control: [[16.5, 36], [10, 39], [3.5, 41]] },
  // A track up to the windmill.
  { id: 'windmill', kind: 'dirt', width: 2.2, control: [[-46, -57], [-56, -62], [-66, -67], [-71.5, -69]] },
];

const GIANT_TREES: Vec2[] = [[17, -22], [-3, -23], [-9, 24], [-44, 2]];

const STALLS: Stall[] = [
  { x: -13, z: -3, yaw: Math.PI / 2 - 0.25, canopy: 'red', goods: 'vegetables' },
  { x: -15, z: 2.5, yaw: Math.PI / 2, canopy: 'cream', goods: 'apples' },
  { x: -14, z: 8, yaw: Math.PI / 2 + 0.3, canopy: 'stripes', goods: 'cloth' },
];

const GARDENS: Garden[] = [
  { x: -19.5, z: -3.5, yaw: 0.65, w: 6, d: 4, crop: 'cabbage' },
  { x: -23, z: 23.5, yaw: 0.1, w: 6.5, d: 4.2, crop: 'cabbage' },
  { x: -4.5, z: -34.5, yaw: -0.4, w: 5.5, d: 3.6, crop: 'pumpkin' },
  { x: 4, z: 46.5, yaw: 0.25, w: 5, d: 3.5, crop: 'herbs' },
  { x: -42, z: -21, yaw: 0.6, w: 4.5, d: 3.2, crop: 'flowers' },
];

const SQUARE = { x: 0, z: 2, radius: 11 };
const WELL = { x: -3.2, z: 1.2 };

// --- Derived geometry --------------------------------------------------------------------------------------------------

function buildStructure(s: StructureSeed, variant: number): Structure {
  const yaw = typeof s.facing === 'number' ? s.facing : s.facing[0] === 0 && s.facing[1] === 0 ? 0 : yawOf(s.facing[0] - s.x, s.facing[1] - s.z);
  const wings = s.wings ?? [];
  const footprints = [s.body, ...wings].map((r) => rectRing(s.x, s.z, yaw, r));
  // The pad: the bounding rectangle (local) of all parts, grown by the margin.
  const parts = [s.body, ...wings];
  const x0 = Math.min(...parts.map((r) => r.x - r.w / 2)), x1 = Math.max(...parts.map((r) => r.x + r.w / 2));
  const z0 = Math.min(...parts.map((r) => r.z - r.d / 2)), z1 = Math.max(...parts.map((r) => r.z + r.d / 2));
  const margin = s.margin ?? 1.4;
  const padRect: LocalRect = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
  const doorLocal: Vec2 = [s.doorX ?? s.body.x, s.body.z + s.body.d / 2];
  const [dx, dz] = toWorld({ x: s.x, z: s.z, yaw }, doorLocal[0], doorLocal[1]);
  return {
    id: s.id,
    kind: s.kind,
    index: s.index,
    x: s.x,
    z: s.z,
    yaw,
    body: s.body,
    wings,
    footprints,
    pad: { ring: rectRing(s.x, s.z, yaw, padRect, margin), falloff: s.kind === 'castle' ? 14 : s.raise ? 1.2 : 4 },
    door: { x: dx, z: dz, yaw },
    stories: s.stories,
    ...(s.plan ? { plan: s.plan } : {}),
    roof: s.roof,
    variant,
    raise: s.raise ?? 0,
  };
}

function buildRiver(): River {
  const dense3 = smoothPolyline(RIVER_CONTROL, 1);
  const line: Vec2[] = dense3.map((p) => [p[0]!, p[1]!]);
  const lengths = polylineLengths(line);
  const total = lengths[lengths.length - 1]!;
  const weirAlong = nearestOnPolyline(line, lengths, WEIR_AT[0], WEIR_AT[1]).along;
  const bridgeAlong = nearestOnPolyline(line, lengths, 14, 26.5).along;
  // Surface: gentle fall, a 2 m step over 1.2 m at the weir, gentle again.
  const yAt = (a: number): number => {
    if (a <= weirAlong) return RIVER_Y.start + (RIVER_Y.aboveWeir - RIVER_Y.start) * (a / weirAlong);
    if (a <= weirAlong + 1.2) {
      const t = (a - weirAlong) / 1.2;
      return RIVER_Y.aboveWeir + (RIVER_Y.belowWeir - RIVER_Y.aboveWeir) * t * t;
    }
    if (a <= bridgeAlong) return RIVER_Y.belowWeir + (RIVER_Y.bridge - RIVER_Y.belowWeir) * ((a - weirAlong - 1.2) / (bridgeAlong - weirAlong - 1.2));
    return RIVER_Y.bridge + (RIVER_Y.end - RIVER_Y.bridge) * ((a - bridgeAlong) / (total - bridgeAlong));
  };
  // Resample densely around the weir so the step is a clean edge.
  const dense: RiverPoint[] = dense3.map((p, i) => ({ x: p[0]!, z: p[1]!, width: p[2]!, y: yAt(lengths[i]!), along: lengths[i]! }));
  return { control: RIVER_CONTROL, dense, line, lengths, depth: RIVER_DEPTH };
}

/** The river at a distance along it (interpolated). */
export function riverAt(river: River, along: number): RiverPoint {
  const L = river.lengths;
  let i = 0;
  while (i < L.length - 2 && L[i + 1]! < along) i++;
  const a = river.dense[i]!, b = river.dense[i + 1]!;
  const t = Math.max(0, Math.min(1, (along - L[i]!) / (L[i + 1]! - L[i]! || 1)));
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, width: a.width + (b.width - a.width) * t, y: a.y + (b.y - a.y) * t, along };
}

/** Nearest point of the river to (x, z): distance from the centre line, the river point there, and the flow heading. */
export function riverNear(river: River, x: number, z: number): { dist: number; at: RiverPoint; flowYaw: number } {
  const hit = nearestOnPolyline(river.line, river.lengths, x, z);
  const at = riverAt(river, hit.along);
  const a = river.line[hit.seg]!, b = river.line[hit.seg + 1]!;
  return { dist: hit.dist, at, flowYaw: yawOf(b[0] - a[0], b[1] - a[1]) };
}

function buildPath(p: Omit<PathLine, 'dense' | 'lengths'>): PathLine {
  const dense = smoothPolyline(p.control, 1).map((q) => [q[0]!, q[1]!] as Vec2);
  return { ...p, dense, lengths: polylineLengths(dense) };
}

/** Distance from (x, z) to the nearest path centre line, and that path. */
export function pathNear(paths: readonly PathLine[], x: number, z: number): { dist: number; path: PathLine | null; along: number } {
  let best = { dist: Infinity, path: null as PathLine | null, along: 0 };
  for (const p of paths) {
    const h = nearestOnPolyline(p.dense, p.lengths, x, z);
    if (h.dist < best.dist) best = { dist: h.dist, path: p, along: h.along };
  }
  return best;
}

/** Signed distance to the nearest structure footprint (negative inside), over all structures. */
export function structureDist(structures: readonly Structure[], x: number, z: number): number {
  let d = Infinity;
  for (const s of structures) for (const f of s.footprints) d = Math.min(d, signedDistToRing(f, x, z));
  return d;
}

function inAnyPad(structures: readonly Structure[], x: number, z: number, grow: number): boolean {
  for (const s of structures) if (signedDistToRing(s.pad.ring, x, z) < grow) return true;
  return false;
}

function scatterTrees(stream: Stream, structures: Structure[], paths: PathLine[], river: River): TreeSpot[] {
  const out: TreeSpot[] = GIANT_TREES.map(([x, z], i) => ({ x, z, kind: 'giant' as const, scale: [1.15, 1.0, 0.95, 1.05][i]!, variant: stream.float(900, i) }));
  const near = (x: number, z: number, r: number): boolean => out.some((t) => Math.hypot(t.x - x, t.z - z) < r);
  const cell = 8.5;
  for (let j = -18; j <= 18; j++) {
    for (let i = -18; i <= 18; i++) {
      const x = (i + 0.5 + stream.jitter(0.42, i, j, 1)) * cell;
      const z = (j + 0.5 + stream.jitter(0.42, i, j, 2)) * cell;
      const r = Math.hypot(x, z);
      if (r > 150) continue;
      // Few trees inside the village, more toward the hills, thinning again far out.
      const density = r < 34 ? 0.05 : r < 60 ? 0.3 : r < 110 ? 0.55 : 0.35;
      if (stream.float(i, j, 3) > density) continue;
      if (pathNear(paths, x, z).dist < 5.5) continue;
      const rv = riverNear(river, x, z);
      if (rv.dist < rv.at.width / 2 + 4) continue;
      if (inAnyPad(structures, x, z, 5)) continue;
      if (Math.hypot(x - SQUARE.x, z - SQUARE.z) < SQUARE.radius + 5) continue;
      if (GARDENS.some((g) => Math.hypot(g.x - x, g.z - z) < Math.max(g.w, g.d) / 2 + 3)) continue;
      if (near(x, z, 6)) continue;
      // Conifers on the hills and in the north, broadleaf trees and bushes nearer the village.
      const north = z < -40 ? 0.25 : 0;
      const k = stream.float(i, j, 4);
      const kind: TreeKind = r > 70 && k < 0.55 + north ? 'conifer' : k < 0.22 ? 'bush' : 'broadleaf';
      out.push({ x, z, kind, scale: stream.range(0.75, 1.3, i, j, 5), variant: stream.float(i, j, 6) });
    }
  }
  return out;
}

function placeLanterns(paths: PathLine[], structures: Structure[], river: River, bridge: Bridge): Lantern[] {
  const out: Lantern[] = [];
  // The bridge carries its own lanterns on its end posts (terrain/bridge.ts): keep the street lanterns off its ends.
  const offBridge = (x: number, z: number): boolean => {
    const dx = x - bridge.x, dz = z - bridge.z;
    const along = dx * Math.sin(bridge.yaw) + dz * Math.cos(bridge.yaw);
    const across = dx * Math.cos(bridge.yaw) - dz * Math.sin(bridge.yaw);
    return Math.abs(along) > bridge.length / 2 + 4 || Math.abs(across) > bridge.width / 2 + 3;
  };
  const free = (x: number, z: number): boolean =>
    offBridge(x, z) &&
    structureDist(structures, x, z) > 1.5 &&
    !out.some((l) => Math.hypot(l.x - x, l.z - z) < 9) &&
    riverNear(river, x, z).dist > riverNear(river, x, z).at.width / 2 + 1.2 &&
    Math.hypot(x - WELL.x, z - WELL.z) > 3;
  for (const p of paths) {
    if (p.kind !== 'cobble') continue;
    const total = p.lengths[p.lengths.length - 1]!;
    let side = 1;
    for (let a = 6; a < total - 2; a += 13) {
      // Point and direction along the path.
      let i = 0;
      while (i < p.lengths.length - 2 && p.lengths[i + 1]! < a) i++;
      const A = p.dense[i]!, B = p.dense[i + 1]!;
      const t = (a - p.lengths[i]!) / (p.lengths[i + 1]! - p.lengths[i]! || 1);
      const cx = A[0] + (B[0] - A[0]) * t, cz = A[1] + (B[1] - A[1]) * t;
      const dir = yawOf(B[0] - A[0], B[1] - A[1]);
      // To the side: the side direction is the path direction turned by ±90°.
      const sideYaw = dir + (side * Math.PI) / 2;
      const off = p.width / 2 + 0.9;
      const x = cx + Math.sin(sideYaw) * off, z = cz + Math.cos(sideYaw) * off;
      if (Math.hypot(x - SQUARE.x, z - SQUARE.z) < SQUARE.radius - 1) continue;
      if (free(x, z) && pathNear(paths, x, z).dist > p.width / 2 + 0.4) {
        // The arm reaches back over the path.
        out.push({ x, z, yaw: sideYaw + Math.PI });
        side = -side;
      }
    }
  }
  // Round the square: four lanterns on its rim, between the streets.
  for (const a of [0.35, 1.9, 3.6, 5.0]) {
    const x = SQUARE.x + Math.sin(a) * (SQUARE.radius + 0.6), z = SQUARE.z + Math.cos(a) * (SQUARE.radius + 0.6);
    if (free(x, z) && pathNear(paths, x, z).dist > 2.2) out.push({ x, z, yaw: a + Math.PI });
  }
  return out;
}

function gardenFence(g: Garden): Fence {
  const pts: Vec2[] = [];
  const hw = g.w / 2 + 0.5, hd = g.d / 2 + 0.5;
  // Around the bed with a gap (gate) in the middle of the front side.
  const ring: Vec2[] = [[0.9, hd], [hw, hd], [hw, -hd], [-hw, -hd], [-hw, hd], [-0.9, hd]];
  for (const [lx, lz] of ring) {
    const [dx, dz] = rotateY(lx, lz, g.yaw);
    pts.push([g.x + dx, g.z + dz]);
  }
  return { points: pts, kind: 'picket', closed: false };
}

/** Rail fences along a path between two distances along it, at an offset to one side. */
function fenceAlong(p: PathLine, from: number, to: number, side: number): Fence {
  const pts: Vec2[] = [];
  for (let a = from; a <= to; a += 2.4) {
    let i = 0;
    while (i < p.lengths.length - 2 && p.lengths[i + 1]! < a) i++;
    const A = p.dense[i]!, B = p.dense[i + 1]!;
    const t = (a - p.lengths[i]!) / (p.lengths[i + 1]! - p.lengths[i]! || 1);
    const dir = yawOf(B[0] - A[0], B[1] - A[1]) + (side * Math.PI) / 2;
    const off = p.width / 2 + 1.1;
    pts.push([A[0] + (B[0] - A[0]) * t + Math.sin(dir) * off, A[1] + (B[1] - A[1]) * t + Math.cos(dir) * off]);
  }
  return { points: pts, kind: 'rail', closed: false };
}

// --- Walking graph -------------------------------------------------------------------------------------------------------

class NavBuilder {
  readonly nodes: number[] = [];
  readonly edges: NavEdgeInput[] = [];
  private readonly keys = new Set<string>();

  /** Adds a node, or returns an existing one within `merge` metres. */
  node(x: number, z: number, merge = 1.4): number {
    for (let i = 0; i < this.nodes.length; i += 2) if (Math.hypot(this.nodes[i]! - x, this.nodes[i + 1]! - z) < merge) return i / 2;
    this.nodes.push(Math.round(x * 100) / 100, Math.round(z * 100) / 100);
    return this.nodes.length / 2 - 1;
  }

  edge(a: number, b: number): void {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.edges.push({ from: a, to: b, both: true });
  }

  nearest(x: number, z: number, ok: (i: number) => boolean = () => true): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nodes.length; i += 2) {
      const d = Math.hypot(this.nodes[i]! - x, this.nodes[i + 1]! - z);
      if (d < bd && ok(i / 2)) (bd = d), (best = i / 2);
    }
    return best;
  }

  at(i: number): Vec2 {
    return [this.nodes[i * 2]!, this.nodes[i * 2 + 1]!];
  }
}

/** True when the straight walk from a to b stays out of every footprint (with a clearance). */
function clearWalk(structures: readonly Structure[], a: Vec2, b: Vec2, clearance = 0.4): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
  for (let k = 0; k <= n; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / n, z = a[1] + ((b[1] - a[1]) * k) / n;
    if (structureDist(structures, x, z) < clearance) return false;
  }
  return true;
}

function buildNav(structures: Structure[], paths: PathLine[], stalls: Stall[], river: River, bridge: Bridge): { nav: NavBuilder } {
  const nav = new NavBuilder();
  // Path centre lines, a node every ~3.5 m; branches merge with the street they start on.
  for (const p of paths) {
    const total = p.lengths[p.lengths.length - 1]!;
    const steps = Math.max(1, Math.round(total / 3.5));
    let prev = -1;
    for (let k = 0; k <= steps; k++) {
      const a = (total * k) / steps;
      let i = 0;
      while (i < p.lengths.length - 2 && p.lengths[i + 1]! < a) i++;
      const A = p.dense[i]!, B = p.dense[i + 1]!;
      const t = (a - p.lengths[i]!) / (p.lengths[i + 1]! - p.lengths[i]! || 1);
      const x = A[0] + (B[0] - A[0]) * t, z = A[1] + (B[1] - A[1]) * t;
      // The river is crossed only on the bridge (the street over it is fine: it is in the path itself).
      const cur = nav.node(x, z, k === 0 || k === steps ? 2.2 : 1.4);
      if (prev >= 0) nav.edge(prev, cur);
      prev = cur;
    }
  }
  // The square: a grid of nodes inside its disc, away from the well and the stalls.
  const blocked = (x: number, z: number): boolean =>
    Math.hypot(x - WELL.x, z - WELL.z) < 1.8 || stalls.some((s) => Math.hypot(s.x - x, s.z - z) < 2.2) || structureDist(structures, x, z) < 0.8;
  const grid = new Map<string, number>();
  const G = 3.2;
  for (let j = -4; j <= 4; j++) {
    for (let i = -4; i <= 4; i++) {
      const x = SQUARE.x + i * G, z = SQUARE.z + j * G;
      if (Math.hypot(x - SQUARE.x, z - SQUARE.z) > SQUARE.radius - 0.8 || blocked(x, z)) continue;
      grid.set(`${i},${j}`, nav.node(x, z, 1.2));
    }
  }
  for (const [key, n] of grid) {
    const [i, j] = key.split(',').map(Number) as [number, number];
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
      const m = grid.get(`${i + di},${j + dj}`);
      if (m !== undefined && clearWalk(structures, nav.at(n), nav.at(m))) nav.edge(n, m);
    }
  }
  // Tie every street node near the square to its nearest square nodes.
  const squareNodes = [...grid.values()];
  for (let n = 0; n < nav.nodes.length / 2; n++) {
    const [x, z] = nav.at(n);
    if (squareNodes.includes(n)) continue;
    const d = Math.hypot(x - SQUARE.x, z - SQUARE.z);
    if (d > SQUARE.radius + 2.5) continue;
    for (const m of squareNodes) {
      const [mx, mz] = nav.at(m);
      if (Math.hypot(mx - x, mz - z) < 4.6 && clearWalk(structures, [x, z], [mx, mz])) nav.edge(n, m);
    }
  }
  void river;
  void bridge;
  return { nav };
}

// --- Assembly ------------------------------------------------------------------------------------------------------------

function buildLayout(seed: number): VillageLayout {
  const stream = Stream.of(seed, 'layout');
  const structures = SEEDS.map((s, i) => buildStructure(s, stream.float(100, i)));
  const paths = PATHS.map(buildPath);
  const river = buildRiver();
  // Weir across the river at its point.
  const weirHit = riverNear(river, WEIR_AT[0], WEIR_AT[1]);
  const weir: Weir = {
    x: weirHit.at.x,
    z: weirHit.at.z,
    yaw: weirHit.flowYaw,
    width: weirHit.at.width + 1.5,
    top: riverAt(river, weirHit.at.along - 0.1).y,
    bottom: riverAt(river, weirHit.at.along + 1.4).y,
    along: weirHit.at.along,
  };
  // Bridge on the south street where it crosses the river.
  const south = paths.find((p) => p.id === 'south')!;
  const bridgeAt = riverNear(river, 14, 26.5);
  const bridgeYaw = yawOf(15.6 - 12.4, 31.5 - 20.5);
  const bridge: Bridge = { x: bridgeAt.at.x, z: bridgeAt.at.z, yaw: bridgeYaw, length: 15, width: 3.8, deckY: bridgeAt.at.y + 2.6, waterY: bridgeAt.at.y };
  // Mill wheel beside the mill, in the water just below the weir.
  const mill = structures.find((s) => s.id === 'mill')!;
  const wheelRiver = riverNear(river, WHEEL_AT[0], WHEEL_AT[1]);
  const millWheel: MillWheel = { x: WHEEL_AT[0], z: WHEEL_AT[1], y: wheelRiver.at.y + 1.6, yaw: mill.yaw, radius: 2.3, width: 1.0 };
  const trees = scatterTrees(stream.child('trees'), structures, paths, river);
  const lanterns = placeLanterns(paths, structures, river, bridge);
  // Fences: round the gardens, along the north-west street by the cottages, at the south street before the bridge.
  const nw = paths.find((p) => p.id === 'north-west')!;
  const fences: Fence[] = [
    ...GARDENS.map(gardenFence),
    fenceAlong(nw, 12, 30, 1),
    fenceAlong(nw, 38, 52, -1),
    fenceAlong(south, 9, 15, -1),
    fenceAlong(south, 33, 44, 1),
  ];
  // Chicken yard by cottage 3: a small rail fence ring.
  const chickens: Vec2 = [-36, 21];
  const yard: Vec2[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI * 2 * 0.85 + 0.6;
    yard.push([chickens[0] + Math.sin(a) * 3.2, chickens[1] + Math.cos(a) * 2.6]);
  }
  fences.push({ points: yard, kind: 'rail', closed: false });
  const benches = [
    { x: -1.5, z: -6.5, yaw: Math.PI - 0.4 },
    { x: 7.5, z: 6.5, yaw: -2.1 },
    { x: -7.2, z: -1.5, yaw: Math.PI / 2 },
  ];
  const { nav } = buildNav(structures, paths, STALLS, river, bridge);
  // Points of interest, each tied to the walking graph with a short spur if needed.
  const pois: Poi[] = [];
  const addPoi = (id: string, kind: PoiKind, x: number, z: number, yaw: number): void => {
    let node = nav.nearest(x, z, (i) => clearWalk(structures, nav.at(i), [x, z], 0.2));
    if (node < 0) node = nav.nearest(x, z);
    const [nx, nz] = nav.at(node);
    if (Math.hypot(nx - x, nz - z) > 1.2) {
      const spur = nav.node(x, z, 0.6);
      nav.edge(node, spur);
      node = spur;
    }
    pois.push({ id, kind, x, z, yaw, node });
  };
  const inn = structures.find((s) => s.id === 'inn')!;
  const forge = structures.find((s) => s.id === 'forge')!;
  const out = (s: Structure, d: number): Vec2 => [s.door.x + Math.sin(s.door.yaw) * d, s.door.z + Math.cos(s.door.yaw) * d];
  addPoi('inn-door', 'inn-door', ...out(inn, 1.4), inn.yaw + Math.PI);
  addPoi('inn-barrels', 'barrels', ...toWorld(inn, 2.6, inn.body.d / 2 + 1.3), inn.yaw);
  addPoi('inn-bench', 'inn-bench', benches[0]!.x + 0.8, benches[0]!.z + 0.6, benches[0]!.yaw);
  // The anvil stands inside the open forge, the blacksmith faces it from the road side.
  const anvil = toWorld(forge, 0.6, 0.6);
  addPoi('anvil', 'anvil', ...toWorld(forge, 0.6, 1.8), forge.yaw + Math.PI);
  addPoi('forge-fire', 'forge-fire', ...toWorld(forge, -1.8, 1.4), forge.yaw + Math.PI);
  STALLS.forEach((s, i) => {
    const front: Vec2 = [s.x + Math.sin(s.yaw) * 1.9, s.z + Math.cos(s.yaw) * 1.9];
    const behind: Vec2 = [s.x - Math.sin(s.yaw) * 1.2, s.z - Math.cos(s.yaw) * 1.2];
    addPoi(`stall-${i}`, 'stall', behind[0], behind[1], s.yaw);
    addPoi(`stall-${i}-front`, 'market', front[0], front[1], s.yaw + Math.PI);
  });
  GARDENS.forEach((g, i) => addPoi(`garden-${i}`, 'garden', g.x + Math.sin(g.yaw) * (g.d / 2 + 0.9), g.z + Math.cos(g.yaw) * (g.d / 2 + 0.9), g.yaw + Math.PI));
  addPoi('well', 'well', WELL.x + 1.3, WELL.z + 0.4, -Math.PI / 2);
  addPoi('square', 'square', SQUARE.x + 2, SQUARE.z + 1, 0);
  const bridgeEnd: Vec2 = [bridge.x + Math.sin(bridge.yaw) * (bridge.length / 2 + 1.5), bridge.z + Math.cos(bridge.yaw) * (bridge.length / 2 + 1.5)];
  addPoi('bridge-guard', 'bridge-guard', bridgeEnd[0] + 1.8, bridgeEnd[1], bridge.yaw + Math.PI);
  addPoi('mill-door', 'mill-door', ...out(mill, 1.3), mill.yaw + Math.PI);
  for (const s of structures) if (s.kind === 'cottage') addPoi(`${s.id}-door`, 'cottage-door', ...out(s, 1.2), s.yaw + Math.PI);
  addPoi('chickens', 'chickens', chickens[0], chickens[1], 0);
  benches.slice(1).forEach((b, i) => addPoi(`bench-${i + 1}`, 'bench', b.x + Math.sin(b.yaw) * 0.7, b.z + Math.cos(b.yaw) * 0.7, b.yaw + Math.PI));
  addPoi('road-end-north-west', 'road-end', -58, -74, Math.PI * 0.8);
  addPoi('road-end-south', 'road-end', 24, 78, 0);
  const rv = riverNear(river, -22, 27);
  addPoi('riverside', 'riverside', rv.at.x + 0.5, rv.at.z - rv.at.width / 2 - 1.6, Math.PI);
  void anvil;
  return {
    square: SQUARE,
    structures,
    paths,
    river,
    weir,
    bridge,
    millWheel,
    trees,
    lanterns,
    fences,
    gardens: GARDENS,
    stalls: STALLS,
    well: WELL,
    benches,
    pois,
    nav: { nodes: nav.nodes, edges: nav.edges },
    terrain: { inner: 112, outer: 384 },
    hills: { from: 62, to: 112, height: 11 },
  };
}

const cache = new Map<number, VillageLayout>();

/** The layout for a seed (cached: the same object for the same seed). Only the scattered trees depend on the seed. */
export function villageLayout(seed: number): VillageLayout {
  let l = cache.get(seed);
  if (!l) {
    l = buildLayout(seed);
    cache.set(seed, l);
  }
  return l;
}

/** Is (x, z) inside any structure footprint? */
export function insideStructure(layout: VillageLayout, x: number, z: number): boolean {
  for (const s of layout.structures) for (const f of s.footprints) if (pointInRing(f, x, z)) return true;
  return false;
}

/** A point of interest by id. */
export function poi(layout: VillageLayout, id: string): Poi {
  const p = layout.pois.find((q) => q.id === id);
  if (!p) throw new Error(`layout: no point of interest ${id}`);
  return p;
}

/** A structure by id. */
export function structure(layout: VillageLayout, id: string): Structure {
  const s = layout.structures.find((q) => q.id === id);
  if (!s) throw new Error(`layout: no structure ${id}`);
  return s;
}
