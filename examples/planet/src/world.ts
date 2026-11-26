// The world of the planet example: a sphere of 100 km radius and a generator that is a pure function of the world
// seed and a cell of the sphere's six quadtrees.
//
// Heights and colours are functions of the point on the base sphere (noise in space, so there is no seam and no
// pole), never of the face or the cell they are built in: two cells agree on their shared border, across the edges of
// the cube as well, and a cell's bytes do not depend on which cells were built before it.
//
// Plants and rocks come from rules on fixed grids of the cube faces. The anchor of an object is a grid point; the
// object belongs to the cell that contains its anchor and its id is a hash of (seed, rule, face, anchor). An object
// stands along the local up of its base point: the instance record holds only the base and a turn about that up.
// Every object stands in the cells of `OBJECT_LEVEL` and finer; the tallest trees also stand, thinned by a rank, in
// the three levels above it (`THIN_RANK`). Farther away the surface carries the plants as a cover baked into its
// vertices (`surfaceCover`), so a wood keeps its colour and its outline at any distance; the materials lift it into a
// canopy (shaders.ts).
//
// The climate (`climate`, `landWeights`) gives six biomes of land from latitude, height and a moisture noise of the
// seed: tundra, taiga, broadleaf forest, meadow, dry land and rock, and ice where it is coldest. They colour the
// ground and set the chances of four plants: conifers, broadleaf trees, trees with a flat crown and shrubs.
//
// The sea fills everything below the base sphere. Its floor is the ground itself (sand near the shore, rock in
// patches, darker silt deeper down); the water is a second mesh of every cell that reaches below sea level, at the
// base sphere (`waterPatch`), drawn translucent over the floor (shaders.ts).

import type { InstanceData, InstanceSolid, MeshData, VertexLayout } from 'wallhammer-web/base';
import { cubeDirection, cubeFaceOf, cubeGrid, directionTangents, fractalNoise3, hashInts, shapeHash, spherePatchMesh, spherePatchRadius, spherePatchSplitsAD, unit, valueNoise3 } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, CellInstances, LocalBounds, SpherePatchOptions, SpherePatchSplit } from 'wallhammer-web/gen-core';
import { SphereWorld } from 'wallhammer-web/world';

/** Radius of the base sphere: sea level. */
export const RADIUS_M = 100_000;
export const SHAPE = new SphereWorld(RADIUS_M);
/** The seed the page uses when the URL gives none. */
export const DEFAULT_SEED = 2611;
/** Raise when the output of the generator changes on purpose (it is written into every cell). */
export const DOMAIN_VERSION = 6;
/** Quads along a cell edge, at every level. */
export const QUADS = 32;
/** Level 0 is a whole face of the cube (157 km along its middle); level 11 cells are 77 m with a vertex every 2.4 m. */
export const ROOT_LEVEL = 0;
export const LEAF_LEVEL = 11;
/**
 * Coarsest level whose cells hold every object. The three levels above it hold the tallest trees, thinned
 * (`THIN_RANK`); from there on the surface carries the plants as its cover.
 */
export const OBJECT_LEVEL = 10;
/** Selection of levels by screen-space error. */
export const SELECTION = {
  errorPerEdge: 1 / (8 * QUADS),
  minErrorPerEdge: 1 / (32 * QUADS),
  maxErrorPx: 2,
  maxCells: 900,
  pixelsPerRadian: 1158,
} as const;
/** The blend between levels is free of jumps while a cell is split at more than 2.02 edges. */
export const MIN_SPLIT_EDGES = 2.05;
/** Height of the water: the sea fills everything below the base sphere. */
export const MIN_HEIGHT_M = 0;
/**
 * Radius of the sphere that hides what lies behind the horizon, for an eye above the sea: under the water, which hides
 * the sea floor beyond its own horizon (seen that far it lets nothing through), and under the flat triangles of the
 * coarsest level, which dip inside the sphere between their vertices (taken twice, to be on the safe side). An eye
 * under the water is inside the sphere and hides nothing.
 */
export const HORIZON_RADIUS_M = RADIUS_M + MIN_HEIGHT_M - 2 * SHAPE.facetDropM(ROOT_LEVEL, QUADS);
/** Thickness of the shell of air. The highest ground is about 6 km. */
export const AIR_HEIGHT_M = 30_000;

/** One instance: base x, y, z (cell-local), reach | height, turn about up, width, depth | r, g, b, variant | shift to the coarser level. */
export const OBJECT_LAYOUT: VertexLayout = {
  stride: 52,
  attribs: [
    { name: 'i_base', size: 4, type: 'f32', offset: 0 },
    { name: 'i_shape', size: 4, type: 'f32', offset: 16 },
    { name: 'i_color', size: 4, type: 'f32', offset: 32 },
    { name: 'i_coarseShift', size: 1, type: 'f32', offset: 48 },
  ],
};

/**
 * The solids a walker meets (walk.ts): where the records of `OBJECT_LAYOUT` keep them (base 0, reach 3, height 4, turn 5,
 * width 6, depth 7). The trees are their trunks, a share of the reach of the crown (the trunks of shapes.ts are 0.05,
 * 0.05 and 0.04 of the width), not to be stood on; a rock is a box turned with it, its half extents 0.45 of the width
 * and the depth (the mesh is a lumpy ball of 0.4 to 0.56), to be stood on. Shrubs are not solid. All stand along the
 * sphere's up and reach a metre under their base, which is sunk into the ground and taken from a coarser mesh.
 */
export const OBJECT_SOLIDS: Readonly<Record<string, InstanceSolid>> = {
  tree: { position: 0, radius: 3, radiusScale: 0.07, height: 4, belowM: 1, up: 'radial', standable: false },
  broadleaf: { position: 0, radius: 3, radiusScale: 0.12, height: 4, belowM: 1, up: 'radial', standable: false },
  'flat-crown': { position: 0, radius: 3, radiusScale: 0.1, height: 4, belowM: 1, up: 'radial', standable: false },
  rock: { position: 0, height: 4, heightScale: 0.95, belowM: 1, up: 'radial', box: { turn: 5, sizeX: 6, sizeZ: 7, scale: 0.45 } },
};

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Seeds {
  land: number;
  ridge: number;
  range: number;
  hills: number;
  bumps: number;
  moisture: number;
  tint: number;
  warmth: number;
  damp: number;
}
const seedCache = new Map<number, Seeds>();
function seeds(seed: number): Seeds {
  let s = seedCache.get(seed);
  if (!s) {
    const k = (i: number): number => hashInts(seed, 0x91a7e7, i);
    s = { land: k(1), ridge: k(2), range: k(3), hills: k(4), bumps: k(5), moisture: k(6), tint: k(7), warmth: k(8), damp: k(9) };
    seedCache.set(seed, s);
  }
  return s;
}

/** Land and sea: the broadest term of the height, in metres. Below 0 is sea floor, apart from the smaller terms. */
function landHeight(seed: number, x: number, y: number, z: number): number {
  return (fractalNoise3(x, y, z, { cellM: 52000, octaves: 4, lacunarity: 2.2, gain: 0.5 }, seeds(seed).land) - 0.48) * 6400;
}

/** How much of the mountain term a point gets, 0–1: mountain ranges are patches of the sphere. */
function rangeShare(seed: number, x: number, y: number, z: number): number {
  return smooth(0.46, 0.72, valueNoise3(x, y, z, 30000, seeds(seed).range));
}

/** Height of the ground above the base sphere at a point of it (metres from the centre). Below 0 is under the sea. */
export function groundHeight(seed: number, x: number, y: number, z: number): number {
  const s = seeds(seed);
  const land = landHeight(seed, x, y, z);
  // Mountains stand on land only: they fade out toward the shore, so the coast keeps the outline of the broad term.
  const range = rangeShare(seed, x, y, z) * smooth(-150, 700, land);
  const r = 1 - Math.abs(2 * fractalNoise3(x, y, z, { cellM: 11000, octaves: 3, lacunarity: 2.2, gain: 0.5 }, s.ridge) - 1);
  const hills = fractalNoise3(x, y, z, { cellM: 1300, octaves: 4, lacunarity: 2.6, gain: 0.45 }, s.hills) - 0.5;
  const bumps = fractalNoise3(x, y, z, { cellM: 24, octaves: 2, lacunarity: 2.3, gain: 0.5 }, s.bumps) - 0.5;
  return land + range * r * r * 3200 + hills * (120 + 460 * range) + bumps * 2.2;
}

/** Height of the top of land or water: the sea stays at the base sphere. The terrain mesh shows the ground itself. */
export function surfaceHeight(seed: number, x: number, y: number, z: number): number {
  return Math.max(MIN_HEIGHT_M, groundHeight(seed, x, y, z));
}

// --- Climate and biomes ----------------------------------------------------------------------------------------------
// Temperature falls toward the poles of the y axis and with height; moisture is two octaves of value noise of the seed
// with a drier belt round the 25th parallels. Six biomes of land come from the two and the height (`landWeights`):
// tundra, taiga, broadleaf forest, meadow, dry land and rock, with ice where it is coldest. Every colour and chance is
// taken from continuous weights round the thresholds, never from a hard biome id, so the levels agree and nothing steps.

/** Thresholds of the biomes in temperature, moisture and height, and the half-widths of the blend round them. */
const T_ICE = 0.16;
const T_TUNDRA = 0.3;
const T_TAIGA = 0.46;
const T_DRY = 0.62;
const M_TAIGA = 0.3;
const M_FOREST = 0.54;
const M_DRY = 0.34;
const H_ROCK = 1900;
const T_BLEND = 0.03;
const M_BLEND = 0.05;
const H_BLEND = 100;
/** No plant above this height (metres), none on the beach below the second. */
export const PLANT_TOP_M = 1700;
const PLANT_BOTTOM_M = 4;

/** Index of each land biome in the weights of `landWeights`. */
export const BIOME = { ice: 0, tundra: 1, taiga: 2, forest: 3, meadow: 4, dry: 5, rock: 6 } as const;
const BIOMES = 7;

const above = (x: number, th: number, w: number): number => smooth(th - w, th + w, x);

/** Temperature 0–1 (falls toward the poles of the y axis and with height) and moisture 0–1. */
export function climate(seed: number, x: number, y: number, z: number, h: number): { t: number; m: number } {
  const s = seeds(seed);
  const lat = Math.abs(y) / RADIUS_M;
  const t = 1 - lat * lat * 0.9 - Math.max(0, h) / 4600 + 0.08 * (valueNoise3(x, y, z, 18000, s.warmth) - 0.5);
  // The sine of 25 degrees is 0.42: the dry belts of the subtropics.
  const belt = 1 - smooth(0, 0.2, Math.abs(lat - 0.42));
  const raw = 0.72 * valueNoise3(x, y, z, 24000, s.moisture) + 0.28 * valueNoise3(x, y, z, 5200, s.damp);
  const m = Math.min(1, Math.max(0, 0.5 + (raw - 0.5) * 1.6 - 0.14 * belt + 0.04));
  return { t, m };
}

/** Continuous weights of the land biomes (index by BIOME), summing to 1. */
export function landWeights(t: number, m: number, h: number, out: Float64Array = new Float64Array(BIOMES)): Float64Array {
  const ice = 1 - above(t, T_ICE, T_BLEND);
  const rest = 1 - ice;
  const rock = rest * above(h, H_ROCK, H_BLEND);
  const L = rest - rock;
  const a = above(t, T_TUNDRA, T_BLEND);
  const b = above(t, T_TAIGA, T_BLEND);
  const warm = above(t, T_DRY, T_BLEND);
  const mT = above(m, M_TAIGA, M_BLEND);
  const mF = above(m, M_FOREST, M_BLEND);
  const mD = 1 - above(m, M_DRY, M_BLEND);
  out[BIOME.ice] = ice;
  out[BIOME.rock] = rock;
  out[BIOME.tundra] = L * (1 - a + a * (1 - b) * (1 - mT));
  out[BIOME.taiga] = L * a * (1 - b) * mT;
  out[BIOME.forest] = L * b * mF;
  out[BIOME.dry] = L * b * (1 - mF) * warm * mD;
  out[BIOME.meadow] = L * b * (1 - mF) * (1 - warm * mD);
  return out;
}

type RGB = readonly [number, number, number];
const SAND: RGB = [202, 188, 140];
const TUNDRA: RGB = [130, 128, 100];
const TAIGA: RGB = [80, 100, 60];
const FOREST: RGB = [74, 112, 50];
const MEADOW: RGB = [104, 134, 62];
const DRY: RGB = [196, 152, 98];
const ROCK: RGB = [120, 112, 104];
const SNOW: RGB = [238, 241, 245];
/** The sea floor: wet sand near the shore, rock in patches, silt further down. */
const SEA_SAND: RGB = [184, 168, 122];
const SEA_ROCK: RGB = [112, 108, 100];
const SEA_SILT: RGB = [128, 130, 120];
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Scratch weights; every caller fills them before it reads them. */
const weights = new Float64Array(BIOMES);

/**
 * RGBA bytes of the ground; alpha 255 marks the sea floor (ground under the water). A function of the point alone, so
 * every level agrees. `h` is the height of the ground.
 */
export function surfaceColor(seed: number, x: number, y: number, z: number, h: number): [number, number, number, number] {
  if (h < 0) {
    const s = seeds(seed);
    // Rock in patches about 100 m across; silt and a little darkness with depth.
    const rock = smooth(0.56, 0.7, valueNoise3(x, y, z, 110, s.tint) * 0.8 + 0.2 * valueNoise3(x, y, z, 23, s.bumps));
    let c = mixRgb(SEA_SAND, SEA_SILT, smooth(6, 120, -h));
    c = mixRgb(c, SEA_ROCK, rock * 0.85);
    const v = (0.9 + 0.2 * valueNoise3(x, y, z, 37, s.damp)) * (1 - 0.3 * smooth(60, 600, -h));
    return [Math.round(c[0] * v), Math.round(c[1] * v), Math.round(c[2] * v), 255];
  }
  const { t, m } = climate(seed, x, y, z, h);
  const w = landWeights(t, m, h, weights);
  const ice = w[BIOME.ice]!;
  const rest = 1 - ice;
  let c: RGB = [0, 0, 0];
  if (rest > 0) {
    const k = (b: number): number => w[b]! / rest;
    const add = (col: RGB, f: number): RGB => [c[0] + col[0] * f, c[1] + col[1] * f, c[2] + col[2] * f];
    c = add(TUNDRA, k(BIOME.tundra));
    c = add(TAIGA, k(BIOME.taiga));
    c = add(FOREST, k(BIOME.forest));
    c = add(MEADOW, k(BIOME.meadow));
    c = add(DRY, k(BIOME.dry));
    c = add(ROCK, k(BIOME.rock));
  }
  c = mixRgb(c, SAND, (1 - smooth(3, 26, h)) * rest);
  c = mixRgb(c, ROCK, smooth(1000, 2100, h) * 0.85 * rest);
  c = mixRgb(c, SNOW, 1 - smooth(0.05, T_ICE, t));
  const v = 0.9 + 0.2 * valueNoise3(x, y, z, 420, seeds(seed).tint);
  return [Math.min(255, Math.round(c[0] * v)), Math.min(255, Math.round(c[1] * v)), Math.min(255, Math.round(c[2] * v)), 0];
}

// --- Plants ----------------------------------------------------------------------------------------------------------
// One grid of anchors (`PLANT_GRID`, about 19 m apart) carries every plant: one draw per anchor picks at most one of
// four kinds by their chances (a conifer, a broadleaf tree, a tree with a flat crown, a shrub), so they never stand on
// each other. The far cover is the expected value of the same rule.

/** Chances per anchor of the four plants, from the biome weights. */
function plantChances(t: number, h: number, w: Float64Array): [conifer: number, broadleaf: number, flat: number, shrub: number] {
  if (h > PLANT_TOP_M || h < PLANT_BOTTOM_M) return [0, 0, 0, 0];
  const conifer = 0.78 * w[BIOME.taiga]! + 0.16 * w[BIOME.forest]! + 0.04 * w[BIOME.tundra]! + 0.02 * w[BIOME.meadow]!;
  const broadleaf = 0.7 * w[BIOME.forest]! + 0.05 * w[BIOME.meadow]!;
  const flat = 0.06 * w[BIOME.dry]! + 0.025 * w[BIOME.meadow]! * smooth(0.7, 0.8, t);
  const shrub = 0.14 * w[BIOME.meadow]! + 0.12 * w[BIOME.tundra]! + 0.1 * w[BIOME.forest]! + 0.08 * w[BIOME.dry]! + 0.05 * w[BIOME.taiga]!;
  return [conifer, broadleaf, flat, shrub];
}

/** Colours of the plants before their own brightness. */
const coniferColor = (cold: number): RGB => [0.2 - 0.06 * cold, 0.34 - 0.05 * cold, 0.15 + 0.03 * cold];
const broadleafColor = (warm: number): RGB => [0.24 - 0.04 * warm, 0.38 + 0.02 * warm, 0.14 - 0.02 * warm];
const FLAT_COLOR: RGB = [0.3, 0.36, 0.13];
const shrubColor = (dry: number): RGB => [0.3 + 0.12 * dry, 0.36 + 0.02 * dry, 0.16];
/** How cold a conifer is (0–1: darker, bluer, a little snow), how warm a broadleaf tree, how dry a shrub. */
const coldOf = (t: number): number => 1 - smooth(0.3, 0.5, t);
const warmOf = (t: number): number => smooth(0.7, 0.95, t);
const dryOf = (t: number, m: number): number => smooth(0.5, 0.75, t) * (1 - smooth(0.3, 0.5, m));

/** Share of an anchor's square each plant hides from a slanted view, and how much darker a stand is than a lit plane. */
const COVER_CONIFER = 0.45;
const COVER_BROADLEAF = 0.55;
const COVER_FLAT = 0.4;
const COVER_SHRUB = 0.15;
const COVER_SHADE = 0.85;

/**
 * What the plants look like from afar, as RGBA bytes: rgb their chance-weighted mean colour, alpha the share of the
 * ground they hide. It is the plant rule itself taken as an expected value (the same chances, the same colours), a
 * function of the point alone, so the far look has the borders of the woods and every level agrees.
 */
export function surfaceCover(seed: number, x: number, y: number, z: number, h: number): [number, number, number, number] {
  const { t, m } = climate(seed, x, y, z, h);
  const [cc, cb, cf, cs] = plantChances(t, h, landWeights(t, m, h, weights));
  const kc = cc * COVER_CONIFER;
  const kb = cb * COVER_BROADLEAF;
  const kf = cf * COVER_FLAT;
  const ks = cs * COVER_SHRUB;
  const sum = kc + kb + kf + ks;
  if (sum <= 0) return [0, 0, 0, 0];
  const conifer = coniferColor(coldOf(t));
  const broadleaf = broadleafColor(warmOf(t));
  const shrub = shrubColor(dryOf(t, m));
  // Mean of the rule's brightness term, 0.85 + 0.25 r.
  const v = (0.975 * COVER_SHADE * 255) / sum;
  const ch = (k: 0 | 1 | 2): number => Math.round((conifer[k] * kc + broadleaf[k] * kb + FLAT_COLOR[k] * kf + shrub[k] * ks) * v);
  return [ch(0), ch(1), ch(2), Math.round(255 * (1 - Math.exp(-sum)))];
}

/**
 * The trees from afar. Every anchor of the plant grid has a rank (0–1, in steps of 1/1024 plus half a step, so it
 * never lies on a threshold, from a stream of its own); a tree's height and turn grow with it. A cell `d` levels
 * coarser than `OBJECT_LEVEL` holds the trees ranked from `THIN_RANK[d]` up: the tallest quarter one level up, the
 * tallest sixteenth two levels up, the tallest 64th three levels up. So the trees of a coarse cell are some of its
 * children's, at the same places with the same sizes, and the trees of a level leave in the order of their rank
 * toward its far end (`THIN_GLSL` in shaders.ts holds the same thresholds). Shrubs and rocks stay at the object level.
 */
export const THIN_RANK = [0, 768 / 1024, 960 / 1024, 1008 / 1024] as const;
const RANK_STEPS = 1024;

/** Values of one object: reach, height, turn, width, depth, r, g, b, variant. */
type Placed = readonly number[];

/** A scatter rule: objects on a grid of `2^gridLevel` intervals across a face, shown from `OBJECT_LEVEL` to the leaves. */
interface Rule {
  id: number;
  /** Names of the archetypes the instances are drawn with; `place` answers with an index into them. */
  names: readonly string[];
  gridLevel: number;
  /** Which of `names` also stand, thinned by rank, in the cells of the `THIN_RANK.length - 1` levels above `OBJECT_LEVEL`. */
  thinned: readonly boolean[];
  /** Rank of the anchor (i, j) of the rule's grid on a face, 0–1, for the thinned names. */
  rank?: (seed: number, face: number, i: number, j: number) => number;
  /** The kind (index into `names`) and the values of the object at an anchor, or null for none. `h` is the ground height. */
  place: (seed: number, x: number, y: number, z: number, h: number, r: (k: number) => number, rank: number) => { kind: number; p: Placed } | null;
}

/** Grid level of the plant rule: anchors about 19 m apart. */
const PLANT_GRID = 13;

export const RULES: readonly Rule[] = [
  {
    id: 1,
    names: ['rock'],
    thinned: [false],
    gridLevel: 12,
    place: (seed, x, y, z, h, r) => {
      if (h < 2) return null;
      // More of them in the mountains and above the trees.
      if (r(3) > 0.06 + 0.4 * rangeShare(seed, x, y, z) + 0.2 * smooth(1200, 2200, h)) return null;
      const size = 1.2 + 6 * r(4) * r(4);
      const tone = 0.8 + 0.3 * r(5);
      return { kind: 0, p: [size, size * (0.5 + 0.4 * r(6)), r(7) * 6.2832, size, size * (0.7 + 0.5 * r(8)), 0.5 * tone, 0.47 * tone, 0.43 * tone, 0] };
    },
  },
  {
    id: 2,
    names: ['tree', 'broadleaf', 'flat-crown', 'shrub'],
    thinned: [true, true, true, false],
    gridLevel: PLANT_GRID,
    rank: (seed, face, i, j) => (Math.floor(unit(hashInts(seed, 0x716, face, i, j)) * RANK_STEPS) + 0.5) / RANK_STEPS,
    place: (seed, x, y, z, h, r, rank) => {
      const { t, m } = climate(seed, x, y, z, h);
      const chances = plantChances(t, h, landWeights(t, m, h, weights));
      // One draw picks the kind: the slices of the chances one after the other.
      const u = r(3);
      let kind = 0;
      let from = 0;
      while (kind < 4 && u >= from + chances[kind]!) from += chances[kind++]!;
      if (kind === 4) return null;
      const v = 0.85 + 0.25 * r(5);
      const turn = rank * 2 * Math.PI;
      if (kind === 0) {
        const height = 9 + 13 * rank;
        const cold = coldOf(t);
        const c = coniferColor(cold);
        return { kind, p: [height * 0.35, height, turn, height * (0.28 + 0.08 * r(7)), 0, c[0] * v, c[1] * v, c[2] * v, cold > 0.5 ? 1 : 0] };
      }
      if (kind === 1) {
        const height = 10 + 10 * rank;
        const width = height * (0.55 + 0.15 * r(7));
        const c = broadleafColor(warmOf(t));
        // A few crowns a little yellower or redder than the rest.
        const hue = 0.06 * (r(9) - 0.5);
        return { kind, p: [width * 0.5, height, turn, width, width * (0.85 + 0.3 * r(8)), (c[0] + hue) * v, c[1] * v, c[2] * v, 0] };
      }
      if (kind === 2) {
        const height = 6 + 6 * rank;
        const width = height * (0.9 + 0.4 * r(7));
        return { kind, p: [width * 0.5, height, turn, width, width * (0.8 + 0.4 * r(8)), FLAT_COLOR[0] * v, FLAT_COLOR[1] * v, FLAT_COLOR[2] * v, 0] };
      }
      const height = 0.8 + 1.6 * r(4);
      const width = height * (1.3 + 0.6 * r(7));
      const c = shrubColor(dryOf(t, m));
      return { kind, p: [width * 0.5, height, r(6) * 6.2832, width, width * (0.8 + 0.4 * r(8)), c[0] * v, c[1] * v, c[2] * v, t < 0.3 ? 1 : 0] };
    },
  },
];

/** The options of the surface mesh of one cell. */
function patchOptionsOf(seed: number, cell: CellId): SpherePatchOptions {
  return {
    radiusM: RADIUS_M,
    face: cell.face,
    level: cell.level,
    x: cell.x,
    y: cell.y,
    quads: QUADS,
    heightAt: (x, y, z) => groundHeight(seed, x, y, z),
    colorAt: (x, y, z, h) => surfaceColor(seed, x, y, z, h),
    coverAt: (x, y, z, h) => surfaceCover(seed, x, y, z, h),
    skirtDepth: Math.max(0.5, SHAPE.edgeM(cell.level) * 0.004),
  };
}

/** Byte of the colour of a water vertex that holds the depth of the floor under it: 64 m · (byte / 255)², fine near 0. */
export function waterDepthByte(depthM: number): number {
  return Math.round(Math.sqrt(Math.min(1, Math.max(0, depthM / 64))) * 255);
}

/**
 * The water of a cell: a patch on the base sphere over the whole cell (the ground hides it where it rises above the
 * sea), with the cell's skirt. Its colour holds the depth of the floor under it (`waterDepthByte`, red), for the foam
 * of the shore; the rest of its look is the material's.
 */
function waterPatch(o: SpherePatchOptions): ReturnType<typeof spherePatchMesh> {
  const floor = o.heightAt;
  return spherePatchMesh({
    radiusM: o.radiusM,
    face: o.face,
    level: o.level,
    x: o.x,
    y: o.y,
    quads: o.quads,
    heightAt: () => 0,
    colorAt: (x, y, z) => [waterDepthByte(-floor(x, y, z)), 0, 0, 255],
    skirtDepth: o.skirtDepth,
  });
}

/**
 * Optional changes to the body of `generatePlanetCell`, for generators built on it (strips.ts). Without them the body
 * gives exactly the bytes of `generatePlanetCell`.
 */
export interface PlanetCellHooks {
  /** Changes the options of the surface mesh (heights, colours, cover). */
  patch?: (o: SpherePatchOptions) => SpherePatchOptions;
  /** False drops an object whose anchor lies at this point of the base sphere. */
  keepObject?: (x: number, y: number, z: number) => boolean;
  /** More meshes of the cell, relative to the patch origin, with their extent. */
  extra?: (patchOptions: SpherePatchOptions, origin: readonly [number, number, number]) => { material: string; mesh: MeshData; bounds: LocalBounds }[];
  domainVersion?: number;
}

/**
 * Options of the page's cells beyond the seed, from the URL hash (main.ts). `split`: how the quads of the surface are
 * cut into triangles (`split=shorter`, `SpherePatchOptions.split`). `extra`: the slope of the ground in the extra
 * channel of the surface (`extra=slope` tints steep ground, `extra=lift` also raises the cliffs by the vertex hook of
 * the ground's shaders; the cells are the same for both). The defaults give the plain cells, byte for byte.
 */
export interface PlanetCellOptions {
  split: SpherePatchSplit;
  extra: 'none' | 'slope' | 'lift';
}

/** The cells of the page without options. */
export const PLAIN_CELLS: PlanetCellOptions = { split: 'fixed', extra: 'none' };

/** The options of the cells from URL parameters (the page's hash, or a worker's own URL). */
export function planetCellOptions(params: URLSearchParams): PlanetCellOptions {
  const extra = params.get('extra');
  return { split: params.get('split') === 'shorter' ? 'shorter' : 'fixed', extra: extra === 'slope' || extra === 'lift' ? extra : 'none' };
}

/** The URL parameters that carry the options to a cell worker; '' for the plain cells. */
export function planetCellQuery(o: PlanetCellOptions): string {
  const parts: string[] = [];
  if (o.split !== 'fixed') parts.push(`split=${o.split}`);
  if (o.extra !== 'none') parts.push(`extra=${o.extra}`);
  return parts.join('&');
}

/** Spacing in metres of the samples the slope is taken from: the same at every level, so the bytes depend on the point alone. */
const SLOPE_STEP_M = 4;
/** Slope (rise over run) from which the ground counts as a cliff: about 40 degrees. */
export const CLIFF_SLOPE = 0.84;

/**
 * The extra bytes of the surface with `extra`: r the slope (rise over run, 0–2 over 0–255), g 255 on a cliff (a
 * category: the coarser level takes it from the nearest parent vertex, `coarseExtra: 'nearest'`), b and a 0. A pure
 * function of the point, from four heights of the same function the surface is made of.
 */
function slopeExtra(heightAt: (x: number, y: number, z: number) => number): NonNullable<SpherePatchOptions['extraAt']> {
  return (x, y, z) => {
    const l = Math.sqrt(x * x + y * y + z * z);
    const d: [number, number, number] = [x / l, y / l, z / l];
    const { t1, t2 } = directionTangents(d);
    const e = SLOPE_STEP_M / RADIUS_M;
    const h = (t: readonly number[], s: number): number => {
      const px = d[0] + t[0]! * s;
      const py = d[1] + t[1]! * s;
      const pz = d[2] + t[2]! * s;
      const k = RADIUS_M / Math.sqrt(px * px + py * py + pz * pz);
      return heightAt(px * k, py * k, pz * k);
    };
    const gu = (h(t1, e) - h(t1, -e)) / (2 * SLOPE_STEP_M);
    const gv = (h(t2, e) - h(t2, -e)) / (2 * SLOPE_STEP_M);
    const slope = Math.sqrt(gu * gu + gv * gv);
    return [Math.min(255, Math.round(slope * 127.5)), slope >= CLIFF_SLOPE ? 255 : 0, 0, 0];
  };
}

/** The surface options with the page's cell options; the very same object for the plain cells. */
function withCellOptions(o: SpherePatchOptions, options: PlanetCellOptions): SpherePatchOptions {
  if (options.split === 'fixed' && options.extra === 'none') return o;
  return {
    ...o,
    ...(options.split !== 'fixed' ? { split: options.split } : {}),
    ...(options.extra !== 'none' ? { extraAt: slopeExtra(o.heightAt), coarseExtra: 'nearest' as const } : {}),
  };
}

/** Generates one cell. Pure: (seed, cell) → content. */
export function generatePlanetCell(seed: number, cell: CellId): CellContent {
  return buildPlanetCell(seed, cell, null);
}

/** The generator of the cells with options; `generatePlanetCell` for the plain cells. */
export function planetCellGenerator(options: PlanetCellOptions): (seed: number, cell: CellId) => CellContent {
  return (seed, cell) => buildPlanetCell(seed, cell, null, options);
}

/** The body of `generatePlanetCell`, with hooks and options. Pure: (seed, cell, hooks, options) → content. */
export function buildPlanetCell(seed: number, cell: CellId, hooks: PlanetCellHooks | null, options: PlanetCellOptions = PLAIN_CELLS): CellContent {
  const edge = SHAPE.edgeM(cell.level);
  const patchOptions = withCellOptions(hooks?.patch ? hooks.patch(patchOptionsOf(seed, cell)) : patchOptionsOf(seed, cell), options);
  const patch = spherePatchMesh(patchOptions);
  const o = patch.origin;
  const min: [number, number, number] = [patch.bounds.min[0], patch.bounds.min[1], patch.bounds.min[2]];
  const max: [number, number, number] = [patch.bounds.max[0], patch.bounds.max[1], patch.bounds.max[2]];
  const land = patch.maxHeight >= 2;

  const instances: CellInstances[] = [];
  // Levels above the object level: only the thinned kinds, from the rank of that level up.
  const up = OBJECT_LEVEL - cell.level;
  const fromRank = up <= 0 ? 0 : up < THIN_RANK.length ? THIN_RANK[up]! : 2;
  for (const rule of fromRank <= 1 ? RULES : []) {
    if (up > 0 && !rule.thinned.includes(true)) continue;
    // Every anchor of the rule's grid that lies inside the cell (the grids are finer than the cells that show them).
    const k = 2 ** (rule.gridLevel - cell.level);
    const n = 2 ** rule.gridLevel;
    const data: number[][] = rule.names.map(() => []);
    const ids: number[][] = rule.names.map(() => []);
    for (let j = cell.y * k; j < (cell.y + 1) * k; j++) {
      for (let i = cell.x * k; i < (cell.x + 1) * k; i++) {
        const rank = rule.rank ? rule.rank(seed, cell.face, i, j) : 0;
        if (rank < fromRank) continue;
        const r = (q: number): number => unit(hashInts(seed, rule.id, cell.face, i, j, q));
        // A point inside the anchor's square of the grid.
        const d = cubeDirection(cell.face, cubeGrid(i + 0.1 + 0.8 * r(1), n), cubeGrid(j + 0.1 + 0.8 * r(2), n));
        const x = d[0] * RADIUS_M;
        const y = d[1] * RADIUS_M;
        const z = d[2] * RADIUS_M;
        const h = groundHeight(seed, x, y, z);
        const placed = rule.place(seed, x, y, z, h, r, rank);
        if (!placed || (up > 0 && !rule.thinned[placed.kind])) continue;
        if (hooks?.keepObject && !hooks.keepObject(x, y, z)) continue;
        const p = placed.p;
        // Base: on the mesh of this level and never above the ground itself, sunk a little.
        const ideal = RADIUS_M + Math.max(MIN_HEIGHT_M, h);
        const sink = 0.15 * p[0]!;
        const own = Math.min(spherePatchRadius(patchOptions, d, 1), ideal) - sink;
        const coarse = Math.min(spherePatchRadius(patchOptions, d, 2), ideal) - sink;
        const lx = d[0] * own - o[0];
        const ly = d[1] * own - o[1];
        const lz = d[2] * own - o[2];
        data[placed.kind]!.push(lx, ly, lz, ...p, coarse - own);
        ids[placed.kind]!.push(hashInts(seed, 0x1d, rule.id, cell.face, i, j), hashInts(seed, 0x2d, rule.id, cell.face, i, j));
        // The object reaches at most its height and its reach from the base, at either end of the blend.
        const reach = p[0]! + p[1]! + Math.abs(coarse - own);
        const local = [lx, ly, lz];
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c]!, local[c]! - reach);
          max[c] = Math.max(max[c]!, local[c]! + reach);
        }
      }
    }
    rule.names.forEach((name, kind) => {
      if (data[kind]!.length === 0) return;
      const inst: InstanceData = { layout: OBJECT_LAYOUT, data: Float32Array.from(data[kind]!) };
      instances.push({ archetype: name, data: inst, ids: Uint32Array.from(ids[kind]!) });
    });
  }
  const meshes: CellContent['meshes'] = [{ material: 'terrain', mesh: patch.mesh }];
  // The water, where the ground of the cell reaches below the sea.
  if (patch.minHeight < 0) {
    const water = waterPatch(patchOptions);
    meshes.push({ material: 'water', mesh: water.mesh });
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, water.bounds.min[c]!);
      max[c] = Math.max(max[c]!, water.bounds.max[c]!);
    }
  }
  for (const m of hooks?.extra ? hooks.extra(patchOptions, o) : []) {
    meshes.push({ material: m.material, mesh: m.mesh });
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, m.bounds.min[c]!);
      max[c] = Math.max(max[c]!, m.bounds.max[c]!);
    }
  }
  const bounds: CellContent['bounds'] = { min: [Math.fround(min[0]), Math.fround(min[1]), Math.fround(min[2])], max: [Math.fround(max[0]), Math.fround(max[1]), Math.fround(max[2])] };
  // The measured error knows only the surface. Land that is still too coarse to show its objects counts with the full
  // error of its level, so the objects appear at the same distance on flat ground as on rough ground.
  const error = Math.fround(Math.max(patch.error, land && cell.level < OBJECT_LEVEL ? edge * SELECTION.errorPerEdge : 0));
  return { cell, domainVersion: hooks?.domainVersion ?? DOMAIN_VERSION, bounds, meshes, instances, shapeHash: shapeHash(SHAPE), error };
}

/** Unit direction of a latitude and longitude in degrees (the poles are on the y axis, longitude 0 along +x). */
export function directionAt(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
}

/** Latitude and longitude in degrees of a direction. */
export function latLonOf(d: readonly [number, number, number]): [number, number] {
  return [(Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI, (Math.atan2(d[2], d[0]) * 180) / Math.PI];
}

export interface StartPlace {
  latDeg: number;
  lonDeg: number;
  /** A direction from the centre toward something worth facing from there: high ground or the sea. */
  toward: [number, number, number];
}

/**
 * A place to start a flight from, a pure function of the seed: the first point of a fixed sequence over the warm
 * latitudes of the northern half that stands on low land with land around it and has high ground or the sea a few
 * kilometres away. Falls back to the first point of the sequence on a world without such a place.
 */
export function findStart(seed: number): StartPlace {
  const ground = (d: readonly [number, number, number]): number => groundHeight(seed, d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M);
  /** The direction `m` metres from `d` along the bearing `a` (radians from the direction of growing latitude). */
  const step = (d: readonly [number, number, number], a: number, m: number): [number, number, number] => {
    const [lat, lon] = latLonOf(d);
    const north = directionAt(lat + 90, lon);
    const east: [number, number, number] = [d[1] * north[2] - d[2] * north[1], d[2] * north[0] - d[0] * north[2], d[0] * north[1] - d[1] * north[0]];
    const c = Math.cos(m / RADIUS_M);
    const s = Math.sin(m / RADIUS_M);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    return [d[0] * c + (north[0] * ca + east[0] * sa) * s, d[1] * c + (north[1] * ca + east[1] * sa) * s, d[2] * c + (north[2] * ca + east[2] * sa) * s];
  };
  const candidate = (k: number): [number, number] => [12 + 34 * ((k * 0.6180339887) % 1), ((k * 137.50776) % 360) - 180];
  for (let k = 0; k < 3000; k++) {
    const [latDeg, lonDeg] = candidate(k);
    const d = directionAt(latDeg, lonDeg);
    const h = ground(d);
    if (h < 60 || h > 500) continue;
    let dry = true;
    for (let q = 0; q < 4 && dry; q++) dry = ground(step(d, (q * Math.PI) / 2, 400)) > 8;
    if (!dry) continue;
    // The most striking of eight points 8 km away: the highest ground, or the sea.
    let best = -1;
    let score = 0;
    for (let q = 0; q < 8; q++) {
      const g = ground(step(d, (q * Math.PI) / 4, 8000));
      const s = g < 0 ? 450 : g - h;
      if (s > score) {
        score = s;
        best = q;
      }
    }
    if (score >= 400) return { latDeg, lonDeg, toward: step(d, (best * Math.PI) / 4, 8000) };
  }
  const [latDeg, lonDeg] = candidate(0);
  return { latDeg, lonDeg, toward: step(directionAt(latDeg, lonDeg), 0, 8000) };
}

/**
 * The objects of `RULES` whose anchors lie within `radiusM` of the direction `d`, as the cells place them (the same
 * anchors, draws and kinds; on the base sphere): the archetype's name, the distance from `d` along the sphere and the
 * object's reach. Pure.
 */
export function objectsNear(seed: number, d: readonly [number, number, number], radiusM: number, visit: (name: string, distanceM: number, reachM: number, at: [number, number, number]) => void): void {
  const f = cubeFaceOf(d);
  for (const rule of RULES) {
    const n = 2 ** rule.gridLevel;
    // Anchors are about (π/2 · R) / n apart at the middle of a face, more near its edges; one more each way is safe.
    const span = Math.ceil(radiusM / ((Math.PI / 2) * RADIUS_M / n)) + 1;
    const ci = Math.floor(((f.s + 1) / 2) * n);
    const cj = Math.floor(((f.t + 1) / 2) * n);
    for (let j = Math.max(0, cj - span); j <= Math.min(n - 1, cj + span); j++) {
      for (let i = Math.max(0, ci - span); i <= Math.min(n - 1, ci + span); i++) {
        const rank = rule.rank ? rule.rank(seed, f.face, i, j) : 0;
        const r = (q: number): number => unit(hashInts(seed, rule.id, f.face, i, j, q));
        const a = cubeDirection(f.face, cubeGrid(i + 0.1 + 0.8 * r(1), n), cubeGrid(j + 0.1 + 0.8 * r(2), n));
        const m = Math.acos(Math.min(1, a[0] * d[0] + a[1] * d[1] + a[2] * d[2])) * RADIUS_M;
        if (m > radiusM) continue;
        const x = a[0] * RADIUS_M;
        const y = a[1] * RADIUS_M;
        const z = a[2] * RADIUS_M;
        const placed = rule.place(seed, x, y, z, groundHeight(seed, x, y, z), r, rank);
        if (placed) visit(rule.names[placed.kind]!, m, placed.p[0]!, [a[0], a[1], a[2]]);
      }
    }
  }
}

export interface WalkStart {
  latDeg: number;
  lonDeg: number;
  /** A direction from the centre 1 km away along the way the walker faces: toward the highest ground in view. */
  toward: [number, number, number];
}

/**
 * A place to start walking from, a pure function of the seed: the first point of a fixed sequence over the latitudes
 * 18–42° of the northern half (a high sun in the page's season) that stands on gentle land well above the sea, with
 * relief round it, some trees and at least one rock within 50 m and none within 2 m, facing the bearing where the
 * ground rises most within 3 km with no object in the first 10 m of the view. `keep` may refuse a direction (the page
 * keeps the places of its strips out). Falls back to `findStart`.
 */
export function findWalkStart(seed: number, keep?: (d: readonly [number, number, number]) => boolean): WalkStart {
  const ground = (d: readonly [number, number, number]): number => groundHeight(seed, d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M);
  const step = (d: readonly [number, number, number], a: number, m: number): [number, number, number] => {
    const [lat, lon] = latLonOf(d);
    const north = directionAt(lat + 90, lon);
    const east: [number, number, number] = [d[1] * north[2] - d[2] * north[1], d[2] * north[0] - d[0] * north[2], d[0] * north[1] - d[1] * north[0]];
    const c = Math.cos(m / RADIUS_M);
    const s = Math.sin(m / RADIUS_M);
    return [d[0] * c + (north[0] * Math.cos(a) + east[0] * Math.sin(a)) * s, d[1] * c + (north[1] * Math.cos(a) + east[1] * Math.sin(a)) * s, d[2] * c + (north[2] * Math.cos(a) + east[2] * Math.sin(a)) * s];
  };
  const TREES = new Set(['tree', 'broadleaf', 'flat-crown']);
  for (let k = 0; k < 6000; k++) {
    const latDeg = 18 + 24 * ((k * 0.6180339887) % 1);
    const lonDeg = ((k * 137.50776) % 360) - 180;
    const d = directionAt(latDeg, lonDeg);
    const h = ground(d);
    if (h < 30 || h > 800) continue;
    if (keep && !keep(d)) continue;
    // Gentle under the feet: less than 1 in 5 over 3 m.
    let gentle = true;
    for (let q = 0; q < 4 && gentle; q++) gentle = Math.abs(ground(step(d, (q * Math.PI) / 2, 3)) - h) < 0.6;
    if (!gentle) continue;
    // Relief: 20–200 m between the lowest and the highest of eight points 250 m away, none of them sea or refused.
    let lo = Infinity;
    let hi = -Infinity;
    let land = true;
    for (let q = 0; q < 8 && land; q++) {
      const e = step(d, (q * Math.PI) / 4, 250);
      const g = ground(e);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
      land = g > 5 && (!keep || keep(e));
    }
    if (!land || hi - lo < 20 || hi - lo > 200) continue;
    // Trees and rocks near, none on the spot.
    let trees = 0;
    let rocks = 0;
    let clear = true;
    const near: { at: [number, number, number]; reach: number }[] = [];
    objectsNear(seed, d, 50, (name, m, reach, at) => {
      if (TREES.has(name)) trees++;
      if (name === 'rock') rocks++;
      if (m - reach < 2) clear = false;
      near.push({ at, reach });
    });
    if (!clear || trees < 3 || trees > 24 || rocks < 1) continue;
    // The view: the bearing (of sixteen) where the ground rises most, seen as an angle over 0.8–3 km.
    let best = -1;
    let rise = -Infinity;
    for (let q = 0; q < 16; q++) {
      const a = (q * Math.PI) / 8;
      // Nothing within 10 m ahead, ±25°.
      const ahead = step(d, a, 1);
      const fx = ahead[0] - d[0], fy = ahead[1] - d[1], fz = ahead[2] - d[2];
      const fl = Math.hypot(fx, fy, fz) || 1;
      const blocked = near.some((o) => {
        const ox = o.at[0] - d[0], oy = o.at[1] - d[1], oz = o.at[2] - d[2];
        const ol = Math.hypot(ox, oy, oz);
        const m = ol * RADIUS_M;
        return m - o.reach < 10 && (ox * fx + oy * fy + oz * fz) / (ol * fl) > Math.cos((25 * Math.PI) / 180);
      });
      if (blocked) continue;
      let r = -Infinity;
      for (const m of [800, 1600, 3000]) r = Math.max(r, (ground(step(d, a, m)) - h) / m);
      if (r > rise) (rise = r), (best = q);
    }
    if (best < 0 || rise < 0.03) continue;
    return { latDeg, lonDeg, toward: step(d, (best * Math.PI) / 8, 1000) };
  }
  const s = findStart(seed);
  return { latDeg: s.latDeg, lonDeg: s.lonDeg, toward: s.toward };
}

export interface SeaPlace {
  latDeg: number;
  lonDeg: number;
  /** Height of the floor there (negative). */
  groundM: number;
  /** A direction from the centre toward the rising floor nearby: something to look at. */
  toward: [number, number, number];
}

/**
 * Two places under the sea, a pure function of the seed: a shallow one (the floor 5–10 m down in warm water, the
 * floor rising toward the shore close by) and a deep one (70–120 m down, on a slope). The first points of a fixed
 * sequence over the latitudes below 50 degrees that qualify; null where the world has none.
 */
export function findSeaPlaces(seed: number): { shallow: SeaPlace | null; deep: SeaPlace | null } {
  const ground = (d: readonly [number, number, number]): number => groundHeight(seed, d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M);
  const step = (d: readonly [number, number, number], a: number, m: number): [number, number, number] => {
    const [lat, lon] = latLonOf(d);
    const north = directionAt(lat + 90, lon);
    const east: [number, number, number] = [d[1] * north[2] - d[2] * north[1], d[2] * north[0] - d[0] * north[2], d[0] * north[1] - d[1] * north[0]];
    const c = Math.cos(m / RADIUS_M);
    const s = Math.sin(m / RADIUS_M);
    return [d[0] * c + (north[0] * Math.cos(a) + east[0] * Math.sin(a)) * s, d[1] * c + (north[1] * Math.cos(a) + east[1] * Math.sin(a)) * s, d[2] * c + (north[2] * Math.cos(a) + east[2] * Math.sin(a)) * s];
  };
  /** The direction of the eight at `m` metres where the floor rises most, and how much. */
  const rising = (d: readonly [number, number, number], h: number, m: number): { toward: [number, number, number]; rise: number } => {
    let best: [number, number, number] = step(d, 0, m);
    let rise = -Infinity;
    for (let q = 0; q < 8; q++) {
      const e = step(d, (q * Math.PI) / 4, m);
      const r = ground(e) - h;
      if (r > rise) (rise = r), (best = e);
    }
    return { toward: best, rise };
  };
  let shallow: SeaPlace | null = null;
  let deep: SeaPlace | null = null;
  for (let k = 0; k < 20000 && !(shallow && deep); k++) {
    const latDeg = 50 * (2 * ((k * 0.6180339887) % 1) - 1);
    const lonDeg = ((k * 137.50776) % 360) - 180;
    const d = directionAt(latDeg, lonDeg);
    const h = ground(d);
    if (!shallow && h > -10 && h < -5) {
      const x = d[0] * RADIUS_M;
      const y = d[1] * RADIUS_M;
      const z = d[2] * RADIUS_M;
      // Warm water, and the floor rising by at least 3 m within 150 m.
      const r = rising(d, h, 150);
      if (climate(seed, x, y, z, 0).t > 0.62 && r.rise > 3) shallow = { latDeg, lonDeg, groundM: h, toward: r.toward };
    }
    if (!deep && h > -120 && h < -70) {
      const r = rising(d, h, 300);
      if (r.rise > 15) deep = { latDeg, lonDeg, groundM: h, toward: r.toward };
    }
  }
  return { shallow, deep };
}

export interface SplitCrest {
  /** The middle of the quad of the finest level where the two splits differ most. */
  target: [number, number, number];
  /** Where to stand: on the lower flank, `CREST_VIEW_M` across the crest from the target. */
  eye: [number, number, number];
  /** The largest difference there between the two splits of a quad: half the twist of its corners, metres. */
  foldM: number;
}

/** Metres from the crest to the eye of `findSplitCrest`. */
const CREST_VIEW_M = 10;

/**
 * A place where the split of the surface's quads (`split=shorter`, `SpherePatchOptions.split`) changes the most, a
 * pure function of the seed: a crest of the finest level whose quads `'shorter'` cuts along the other diagonal than
 * `'fixed'`, where the two triangles of a quad then miss each other's middle by the most. Of the 200 steepest points
 * of a fixed lattice on land, the window of 64 × 64 finest quads round each with the largest sum of such differences
 * over 0.2 m wins, and its largest one is the target. The eye stands on the lower flank across the crest, looking up
 * at it, so the crest is the line against the sky: notched by one split where the other keeps it whole. Null on a
 * world without land.
 */
export function findSplitCrest(seed: number): SplitCrest | null {
  const n = 2 ** LEAF_LEVEL * QUADS;
  const ground = (d: readonly [number, number, number]): number => groundHeight(seed, d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M);
  const vertex = (face: number, gi: number, gj: number): [number, number, number] => cubeDirection(face, cubeGrid(gi, n), cubeGrid(gj, n));
  const radius = (face: number, gi: number, gj: number): number => RADIUS_M + ground(vertex(face, gi, gj));
  const step = (d: readonly [number, number, number], a: number, m: number): [number, number, number] => {
    const [lat, lon] = latLonOf(d);
    const north = directionAt(lat + 90, lon);
    const east: [number, number, number] = [d[1] * north[2] - d[2] * north[1], d[2] * north[0] - d[0] * north[2], d[0] * north[1] - d[1] * north[0]];
    const c = Math.cos(m / RADIUS_M);
    const s = Math.sin(m / RADIUS_M);
    return [d[0] * c + (north[0] * Math.cos(a) + east[0] * Math.sin(a)) * s, d[1] * c + (north[1] * Math.cos(a) + east[1] * Math.sin(a)) * s, d[2] * c + (north[2] * Math.cos(a) + east[2] * Math.sin(a)) * s];
  };
  // The steepest points of the lattice, by the finest grid round each.
  const LATTICE = 12000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const steep: { face: number; gi: number; gj: number; slope: number }[] = [];
  for (let k = 0; k < LATTICE; k++) {
    const y = 1 - (2 * (k + 0.5)) / LATTICE;
    // Away from the poles, where the sun stands low the whole day.
    if (Math.abs(y) > 0.7) continue;
    const r = Math.sqrt(1 - y * y);
    const f = cubeFaceOf([Math.cos(golden * k) * r, y, Math.sin(golden * k) * r]);
    const gi = Math.round(((f.s + 1) / 2) * n);
    const gj = Math.round(((f.t + 1) / 2) * n);
    if (gi < 40 || gj < 40 || gi > n - 40 || gj > n - 40) continue;
    if (radius(f.face, gi, gj) - RADIUS_M < 50) continue;
    const du = radius(f.face, gi + 2, gj) - radius(f.face, gi - 2, gj);
    const dv = radius(f.face, gi, gj + 2) - radius(f.face, gi, gj - 2);
    steep.push({ face: f.face, gi, gj, slope: Math.hypot(du, dv) });
  }
  steep.sort((a, b) => b.slope - a.slope || a.face - b.face || a.gi - b.gi || a.gj - b.gj);
  const W = 64;
  let best: { sum: number; face: number; gi: number; gj: number; fold: number } | null = null;
  const rad = new Float64Array((W + 1) * (W + 1));
  for (const c of steep.slice(0, 200)) {
    const i0 = c.gi - W / 2;
    const j0 = c.gj - W / 2;
    for (let b = 0; b <= W; b++) for (let a = 0; a <= W; a++) rad[b * (W + 1) + a] = radius(c.face, i0 + a, j0 + b);
    let sum = 0;
    let fold = 0;
    let at = [0, 0];
    for (let b = 0; b < W; b++) {
      for (let a = 0; a < W; a++) {
        const ra = rad[b * (W + 1) + a]!;
        const rb = rad[b * (W + 1) + a + 1]!;
        const rc = rad[(b + 1) * (W + 1) + a]!;
        const rd = rad[(b + 1) * (W + 1) + a + 1]!;
        if (!spherePatchSplitsAD('shorter', ra, rb, rc, rd)) continue;
        const e = Math.abs(ra + rd - rb - rc) / 2;
        if (e > 0.2) sum += e;
        if (e > fold) (fold = e), (at = [i0 + a, j0 + b]);
      }
    }
    if (!best || sum > best.sum) best = { sum, face: c.face, gi: at[0]!, gj: at[1]!, fold };
  }
  if (!best) return null;
  const target = cubeDirection(best.face, cubeGrid(2 * best.gi + 1, 2 * n), cubeGrid(2 * best.gj + 1, 2 * n));
  const h = ground(target);
  // The crest runs along the bearing (of 36 over a half turn) where the ground changes least over 10 m both ways.
  let along = 0;
  let change = Infinity;
  for (let q = 0; q < 36; q++) {
    const a = (q * Math.PI) / 36;
    const v = Math.abs(ground(step(target, a, 10)) - h) + Math.abs(ground(step(target, a + Math.PI, 10)) - h);
    if (v < change) (change = v), (along = a);
  }
  const left = step(target, along + Math.PI / 2, CREST_VIEW_M);
  const right = step(target, along - Math.PI / 2, CREST_VIEW_M);
  return { target, eye: ground(left) <= ground(right) ? left : right, foldM: best.fold };
}
