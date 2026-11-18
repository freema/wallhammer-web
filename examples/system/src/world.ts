// The surfaces of the system example: one generator for every body. It is a pure function of a seed and a cell of
// the body's six quadtrees; the seed carries the seed of the system and the index of the body (`packSeed`), so one
// worker script serves all bodies and every body has noise of its own.
//
// Each body has a terrain for its look (bodies.ts): heights and colours are functions of the point on the base sphere
// (noise in space, no seam, no pole), never of the cell they are built in, so two cells agree on their shared border
// and a cell's bytes do not depend on which cells were built before it. Broad features scale with the radius of the
// body; small ones (hills, stones) keep their size in metres.
//
// Objects come from rules on fixed grids of the cube faces, as in the planet example: the anchor of an object is a
// grid point, the object belongs to the cell that contains its anchor, and it exists in the two finest levels only.
// Farther away the surface carries the trees as a cover baked into its vertices.

import type { InstanceData, MeshData, VertexLayout } from 'wallhammer-web/base';
import { cubeDirection, cubeGrid, fractalNoise3, hashInts, shapeHash, spherePatchMesh, spherePatchRadius, unit, valueNoise3 } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, CellInstances, LocalBounds, SpherePatchOptions } from 'wallhammer-web/gen-core';
import { SphereWorld } from 'wallhammer-web/world';
import { SURFACES } from './bodies.ts';
import type { SurfaceSpec } from './bodies.ts';

/** The seed of the system the page uses when the URL gives none. */
export const DEFAULT_SEED = 725;
/** Raise when the output of the generator changes on purpose (it is written into every cell). */
export const DOMAIN_VERSION = 1;
/** Quads along a cell edge, at every level. */
export const QUADS = 32;
/** Level 0 is a whole face of the cube. */
export const ROOT_LEVEL = 0;
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
/** Bodies a seed can name. */
const BODY_SLOTS = 16;

/** The seed a provider or a worker gets for one body: the seed of the system and the index of the body in `SURFACES`. */
export function packSeed(systemSeed: number, body: number): number {
  return (Math.abs(Math.round(systemSeed)) % 2 ** 27) * BODY_SLOTS + body;
}

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

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type RGB = readonly [number, number, number];
type RGBA = [number, number, number, number];
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const bytes = (c: RGB, v: number, a: number): RGBA => [Math.min(255, Math.max(0, Math.round(c[0] * v))), Math.min(255, Math.max(0, Math.round(c[1] * v))), Math.min(255, Math.max(0, Math.round(c[2] * v))), a];
const NO_COVER: RGBA = [0, 0, 0, 0];

/** The anchor a rule is asked about: the face and the indices of the anchor on the rule's grid. */
export interface RuleAnchor {
  face: number;
  i: number;
  j: number;
}

/** A scatter rule: objects on a grid of `2^gridLevel` intervals across a face, shown from the object level to the leaves. */
export interface Rule {
  id: number;
  /** Name of the archetype the instances are drawn with. */
  name: string;
  gridLevel: number;
  /**
   * Returns reach, height, turn, width, depth, r, g, b, variant; or null for no object. `h` is the ground height,
   * `at` the anchor (rules that share one draw per anchor read it).
   */
  place: (x: number, y: number, z: number, h: number, r: (k: number) => number, at: RuleAnchor) => readonly number[] | null;
}

/** The surface of one body: everything is a function of a point of its base sphere (metres from its centre). */
interface Terrain {
  /** Lowest height the visible surface has anywhere. */
  minHeight: number;
  /** Height of the ground above the base sphere; under a sea it is below 0. */
  ground: (x: number, y: number, z: number) => number;
  /** Height of the visible surface. */
  surface: (x: number, y: number, z: number) => number;
  /** RGBA bytes of the surface at its height `h`; alpha 255 marks a sea. */
  color: (x: number, y: number, z: number, h: number) => RGBA;
  /** What the objects on the surface look like from afar: rgb their mean colour, alpha the share they hide. */
  cover: (x: number, y: number, z: number, h: number) => RGBA;
  rules: readonly Rule[];
  /** Temperature 0–1 and moisture 0–1 at a point and its ground height `h`, where the look has a climate. */
  climate?: (x: number, y: number, z: number, h: number) => { t: number; m: number };
  /** Parts of a living look that a climate built on top of it reuses (climate.ts). */
  living?: LivingParts;
}

/** Parts of the living look: the fine tint of its colours (0–1 noise) and the share of mountain ranges (0–1). */
export interface LivingParts {
  tint: (x: number, y: number, z: number) => number;
  rangeShare: (x: number, y: number, z: number) => number;
}

/**
 * Round pits with raised rims, as a height in metres: at most one pit per cell of a grid in space, its middle anywhere
 * in the cell. A pit reaches less than half a cell from its middle, so the eight cells round a point hold every pit
 * that touches it. The middles are points of space, not of the sphere: the sphere cuts each pit in a circle.
 */
function pits(x: number, y: number, z: number, cellM: number, share: number, seed: number): number {
  const fx = x / cellM - 0.5;
  const fy = y / cellM - 0.5;
  const fz = z / cellM - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  let h = 0;
  for (let c = 0; c < 8; c++) {
    const cx = ix + (c & 1);
    const cy = iy + ((c >> 1) & 1);
    const cz = iz + ((c >> 2) & 1);
    const k = hashInts(seed, cx, cy, cz);
    if (unit(k) >= share) continue;
    const size = unit(hashInts(k, 4));
    // Radius of the pit; its rim ends at 1.6 radii, which stays under half a cell.
    const r = cellM * (0.1 + 0.2 * size * size);
    const dx = x - (cx + unit(hashInts(k, 1))) * cellM;
    const dy = y - (cy + unit(hashInts(k, 2))) * cellM;
    const dz = z - (cz + unit(hashInts(k, 3))) * cellM;
    const t = Math.sqrt(dx * dx + dy * dy + dz * dz) / r;
    if (t >= 1.6) continue;
    const depth = r * 0.22 * (0.6 + 0.4 * unit(hashInts(k, 5)));
    if (t < 1) h -= depth * (1 - t * t);
    // The rim: a smooth bump from 0.4 to 1.6 radii with its crest on the edge of the pit.
    const e = (t - 1) / 0.6;
    if (e > -1) {
      const w = 1 - e * e;
      h += r * 0.045 * w * w;
    }
  }
  return h;
}

// --- Living: sea, forests and snow (the terrain of the planet example, scaled to the radius) ---------------------------

function livingTerrain(seed: number, spec: SurfaceSpec): Terrain {
  const R = spec.radiusM;
  /** Broad features scale with the body. */
  const s = R / 100_000;
  const k = (i: number): number => hashInts(seed, 0x91a7e7, i);
  const S = { land: k(1), ridge: k(2), range: k(3), hills: k(4), bumps: k(5), moisture: k(6), tint: k(7) };
  const land = (x: number, y: number, z: number): number => (fractalNoise3(x, y, z, { cellM: 52000 * s, octaves: 4, lacunarity: 2.2, gain: 0.5 }, S.land) - 0.48) * 6400;
  const rangeShare = (x: number, y: number, z: number): number => smooth(0.46, 0.72, valueNoise3(x, y, z, 30000 * s, S.range));
  const ground = (x: number, y: number, z: number): number => {
    const l = land(x, y, z);
    // Mountains stand on land only: they fade out toward the shore, so the coast keeps the outline of the broad term.
    const range = rangeShare(x, y, z) * smooth(-150, 700, l);
    const r = 1 - Math.abs(2 * fractalNoise3(x, y, z, { cellM: 11000 * s, octaves: 3, lacunarity: 2.2, gain: 0.5 }, S.ridge) - 1);
    const hills = fractalNoise3(x, y, z, { cellM: 1300, octaves: 4, lacunarity: 2.6, gain: 0.45 }, S.hills) - 0.5;
    const bumps = fractalNoise3(x, y, z, { cellM: 24, octaves: 2, lacunarity: 2.3, gain: 0.5 }, S.bumps) - 0.5;
    return l + range * r * r * 3200 + hills * (120 + 460 * range) + bumps * 2.2;
  };
  /** Temperature 0–1 (falls toward the poles of the y axis and with height) and moisture 0–1. */
  const climate = (x: number, y: number, z: number, h: number): { t: number; m: number } => {
    const lat = Math.abs(y) / R;
    return { t: 1 - lat * lat * 0.9 - Math.max(0, h) / 4600, m: valueNoise3(x, y, z, 24000 * s, S.moisture) };
  };
  const SAND: RGB = [202, 188, 140];
  const GRASS: RGB = [104, 134, 62];
  const WOOD: RGB = [58, 90, 46];
  const DRY: RGB = [196, 152, 98];
  const HEATH: RGB = [130, 128, 100];
  const ROCK: RGB = [120, 112, 104];
  const SNOW: RGB = [238, 241, 245];
  const SHALLOW: RGB = [44, 104, 118];
  const DEEP: RGB = [12, 38, 72];
  /** Share of the anchors of the tree rule that hold a tree, 0–1, from the climate. */
  const forest = (t: number, m: number): number => smooth(0.42, 0.6, m) * smooth(0.25, 0.4, t);
  const treeChance = (t: number, m: number, h: number): number => (h < 4 || h > 1700 ? 0 : 0.8 * forest(t, m) + 0.03);
  /** Colour of a tree before its own brightness: darker and bluer where it is cold. */
  const treeColor = (cold: number): RGB => [0.2 - 0.06 * cold, 0.34 - 0.05 * cold, 0.15 + 0.03 * cold];
  /** Share of an anchor's square a tree hides from a slanted view, and how much darker a stand of trees is than a lit plane of their colour. */
  const COVER_PER_TREE = 0.45;
  const COVER_SHADE = 0.85;
  return {
    climate,
    living: { tint: (x, y, z) => valueNoise3(x, y, z, 420, S.tint), rangeShare },
    minHeight: 0,
    ground,
    surface: (x, y, z) => Math.max(0, ground(x, y, z)),
    color: (x, y, z, h) => {
      if (h <= 0) return bytes(mixRgb(SHALLOW, DEEP, smooth(0, 600, -land(x, y, z))), 1, 255);
      const { t, m } = climate(x, y, z, h);
      let c = mixRgb(GRASS, WOOD, forest(t, m) * 0.6);
      c = mixRgb(c, DRY, smooth(0.72, 0.86, t) * (1 - smooth(0.28, 0.44, m)));
      c = mixRgb(c, HEATH, 1 - smooth(0.2, 0.34, t));
      c = mixRgb(c, SAND, 1 - smooth(3, 26, h));
      c = mixRgb(c, ROCK, smooth(1000, 2100, h) * 0.85);
      c = mixRgb(c, SNOW, 1 - smooth(0.05, 0.16, t));
      return bytes(c, 0.9 + 0.2 * valueNoise3(x, y, z, 420, S.tint), 0);
    },
    // The tree rule itself taken as an expected value (the same chance per anchor, the same colours).
    cover: (x, y, z, h) => {
      const { t, m } = climate(x, y, z, h);
      const c = treeColor(1 - smooth(0.3, 0.5, t));
      // Mean of the rule's brightness term, 0.85 + 0.25 r.
      const v = 0.975 * COVER_SHADE * 255;
      return [Math.round(c[0] * v), Math.round(c[1] * v), Math.round(c[2] * v), Math.round(255 * (1 - Math.exp(-treeChance(t, m, h) * COVER_PER_TREE)))];
    },
    rules: [
      {
        id: 1,
        name: 'rock',
        gridLevel: spec.leafLevel + 1,
        place: (x, y, z, h, r) => {
          if (h < 2) return null;
          // More of them in the mountains and above the trees.
          if (r(3) > 0.06 + 0.4 * rangeShare(x, y, z) + 0.2 * smooth(1200, 2200, h)) return null;
          const size = 1.2 + 6 * r(4) * r(4);
          const tone = 0.8 + 0.3 * r(5);
          return [size, size * (0.5 + 0.4 * r(6)), r(7) * 6.2832, size, size * (0.7 + 0.5 * r(8)), 0.5 * tone, 0.47 * tone, 0.43 * tone, 0];
        },
      },
      {
        id: 2,
        name: 'tree',
        gridLevel: spec.leafLevel + 2,
        place: (x, y, z, h, r) => {
          const { t, m } = climate(x, y, z, h);
          if (r(3) >= treeChance(t, m, h)) return null;
          const height = 9 + 13 * r(4);
          const cold = 1 - smooth(0.3, 0.5, t);
          const c = treeColor(cold);
          const v = 0.85 + 0.25 * r(5);
          return [height * 0.35, height, r(6) * 6.2832, height * (0.28 + 0.08 * r(7)), 0, c[0] * v, c[1] * v, c[2] * v, cold > 0.5 ? 1 : 0];
        },
      },
    ],
  };
}

/** A rule for stones of one colour: `share` of the anchors hold one, more where `more` says so (0–1). */
function stoneRule(spec: SurfaceSpec, color: RGB, share: number, more: (x: number, y: number, z: number, h: number) => number): Rule {
  return {
    id: 1,
    name: 'rock',
    gridLevel: spec.leafLevel + 1,
    place: (x, y, z, h, r) => {
      if (r(3) > share + 0.4 * more(x, y, z, h)) return null;
      const size = 1.2 + 7 * r(4) * r(4);
      const tone = 0.8 + 0.3 * r(5);
      return [size, size * (0.45 + 0.45 * r(6)), r(7) * 6.2832, size, size * (0.7 + 0.5 * r(8)), color[0] * tone, color[1] * tone, color[2] * tone, 0];
    },
  };
}

// --- Desert: plateaus, table rocks, gorges and dunes ---------------------------------------------------------------

function desertTerrain(seed: number, spec: SurfaceSpec): Terrain {
  const R = spec.radiusM;
  const s = R / 100_000;
  const k = (i: number): number => hashInts(seed, 0xd35e27, i);
  const S = { broad: k(1), table: k(2), tableShare: k(3), gorge: k(4), gorgeShare: k(5), dunes: k(6), bumps: k(7), bands: k(8), tint: k(9) };
  const broad = (x: number, y: number, z: number): number => (fractalNoise3(x, y, z, { cellM: 60000 * s, octaves: 4, lacunarity: 2.1, gain: 0.5 }, S.broad) - 0.5) * 5200;
  /** Table rocks: a step of the ground where a noise crosses a level, in patches. */
  const table = (x: number, y: number, z: number): number =>
    smooth(0.52, 0.56, fractalNoise3(x, y, z, { cellM: 7000, octaves: 3, lacunarity: 2.3, gain: 0.5 }, S.table)) * smooth(0.45, 0.65, valueNoise3(x, y, z, 42000 * s, S.tableShare));
  /** Gorges: narrow cuts along the lines where a noise crosses its middle, in patches. */
  const gorge = (x: number, y: number, z: number): number => {
    const r = 1 - Math.abs(2 * fractalNoise3(x, y, z, { cellM: 16000 * s, octaves: 3, lacunarity: 2.2, gain: 0.5 }, S.gorge) - 1);
    return smooth(0.9, 0.985, r) * smooth(0.4, 0.62, valueNoise3(x, y, z, 50000 * s, S.gorgeShare));
  };
  const ground = (x: number, y: number, z: number): number => {
    const b = broad(x, y, z);
    // Dunes lie in the low country and thin out upward.
    const low = 1 - smooth(-300, 900, b);
    const d = 1 - Math.abs(2 * fractalNoise3(x, y, z, { cellM: 520, octaves: 2, lacunarity: 2.4, gain: 0.45 }, S.dunes) - 1);
    const bumps = fractalNoise3(x, y, z, { cellM: 28, octaves: 2, lacunarity: 2.3, gain: 0.5 }, S.bumps) - 0.5;
    return b + table(x, y, z) * 420 - gorge(x, y, z) * 900 + d * d * 55 * low + bumps * 2;
  };
  const SAND: RGB = [214, 170, 110];
  const RED: RGB = [168, 96, 62];
  const DARK: RGB = [112, 74, 58];
  const PALE: RGB = [228, 204, 166];
  const FROST: RGB = [236, 232, 226];
  return {
    // The broad term reaches −2600 m, a gorge 900 m below it.
    minHeight: -3600,
    ground,
    surface: ground,
    color: (x, y, z, h) => {
      const b = broad(x, y, z);
      let c = mixRgb(SAND, RED, smooth(200, 1500, b));
      // Salt in the deepest basins.
      c = mixRgb(c, PALE, 1 - smooth(-2000, -1100, b));
      // Layers of rock show where the ground was cut or stepped: bands by height.
      const cut = Math.max(table(x, y, z), gorge(x, y, z));
      const band = valueNoise3(h, 0, 0, 38, S.bands);
      c = mixRgb(c, mixRgb(DARK, RED, band), smooth(0.05, 0.6, cut) * 0.8);
      const lat = Math.abs(y) / R;
      c = mixRgb(c, FROST, smooth(0.86, 0.94, lat + 0.04 * (valueNoise3(x, y, z, 9000, S.tint) - 0.5)));
      return bytes(c, 0.9 + 0.2 * valueNoise3(x, y, z, 380, S.tint), 0);
    },
    cover: () => NO_COVER,
    rules: [stoneRule(spec, [0.52, 0.33, 0.24], 0.05, (x, y, z) => Math.max(table(x, y, z), gorge(x, y, z)))],
  };
}

// --- Cratered: grey dust, pits of every size -----------------------------------------------------------------------

function crateredTerrain(seed: number, spec: SurfaceSpec): Terrain {
  const R = spec.radiusM;
  const s = R / 100_000;
  const k = (i: number): number => hashInts(seed, 0xc7a7e5, i);
  const S = { broad: k(1), bumps: k(2), tint: k(3), pits: [k(4), k(5), k(6), k(7)] };
  /** Sizes of the pit grids in metres: the largest pits are a tenth of the radius across. */
  const GRIDS = [22000 * s, 7000 * s, 800, 260];
  const broad = (x: number, y: number, z: number): number => (fractalNoise3(x, y, z, { cellM: 50000 * s, octaves: 4, lacunarity: 2.2, gain: 0.5 }, S.broad) - 0.5) * 1800;
  const ground = (x: number, y: number, z: number): number => {
    let h = broad(x, y, z);
    for (let i = 0; i < GRIDS.length; i++) h += pits(x, y, z, GRIDS[i]!, 0.6, S.pits[i]!);
    return h + (fractalNoise3(x, y, z, { cellM: 20, octaves: 2, lacunarity: 2.3, gain: 0.5 }, S.bumps) - 0.5) * 1.2;
  };
  const LOW: RGB = [94, 92, 90];
  const HIGH: RGB = [156, 154, 150];
  // Deepest: the broad term (−900 m) and the deepest pit of every grid, taken two and a half times, as pits of
  // neighbouring cells of one grid may overlap.
  let deepest = -905;
  for (const g of GRIDS) deepest -= 2.5 * g * 0.3 * 0.22;
  return {
    minHeight: deepest,
    ground,
    surface: ground,
    color: (x, y, z, h) => {
      const b = broad(x, y, z);
      const c = mixRgb(LOW, HIGH, smooth(-500, 500, b));
      // Floors of pits are darker, rims brighter than the country they lie in.
      const shade = Math.min(1.2, Math.max(0.72, 1 + (h - b) / 1100));
      return bytes(c, shade * (0.9 + 0.2 * valueNoise3(x, y, z, 300, S.tint)), 0);
    },
    cover: () => NO_COVER,
    rules: [stoneRule(spec, [0.5, 0.5, 0.49], 0.07, (x, y, z, h) => smooth(40, 400, Math.abs(h - broad(x, y, z))) * 0.4)],
  };
}

// --- Ice: smooth plains, long cracks, broken fields -----------------------------------------------------------------

function iceTerrain(seed: number, spec: SurfaceSpec): Terrain {
  const R = spec.radiusM;
  const s = R / 100_000;
  const k = (i: number): number => hashInts(seed, 0x1ce1ce, i);
  const S = { broad: k(1), cracks: k(2), broken: k(3), blocks: k(4), bumps: k(5), tint: k(6), pits: k(7) };
  const broad = (x: number, y: number, z: number): number => (fractalNoise3(x, y, z, { cellM: 46000 * s, octaves: 3, lacunarity: 2.1, gain: 0.5 }, S.broad) - 0.5) * 900;
  /** 0–1 along the lines where a noise crosses its middle: long cracks round the whole body. */
  const crack = (x: number, y: number, z: number): number => 1 - Math.abs(2 * fractalNoise3(x, y, z, { cellM: 9000 * s, octaves: 2, lacunarity: 2.4, gain: 0.4 }, S.cracks) - 1);
  const broken = (x: number, y: number, z: number): number => smooth(0.58, 0.72, valueNoise3(x, y, z, 24000 * s, S.broken));
  const ground = (x: number, y: number, z: number): number => {
    const c = crack(x, y, z);
    // A crack is a pair of low ridges with a trough between them.
    const ridge = smooth(0.9, 0.975, c) * 70 - smooth(0.975, 1, c) * 120;
    const blocks = (valueNoise3(x, y, z, 260, S.blocks) - 0.5) * 150 * broken(x, y, z);
    const bumps = fractalNoise3(x, y, z, { cellM: 24, octaves: 2, lacunarity: 2.3, gain: 0.5 }, S.bumps) - 0.5;
    return broad(x, y, z) + ridge + blocks + pits(x, y, z, 5000 * s, 0.2, S.pits) + bumps * 1.4;
  };
  const SNOW: RGB = [228, 237, 246];
  const BLUE: RGB = [150, 190, 226];
  const RUST: RGB = [150, 106, 86];
  return {
    // The broad term reaches −450 m, a trough 50 m and broken ice 75 m below it, and overlapping pits 500 m more.
    minHeight: -1100,
    ground,
    surface: ground,
    color: (x, y, z) => {
      let c = mixRgb(SNOW, BLUE, broken(x, y, z) * 0.7);
      c = mixRgb(c, RUST, smooth(0.86, 0.97, crack(x, y, z)) * 0.75);
      return bytes(c, 0.92 + 0.16 * valueNoise3(x, y, z, 340, S.tint), 0);
    },
    cover: () => NO_COVER,
    rules: [stoneRule(spec, [0.62, 0.72, 0.8], 0.03, (x, y, z) => broken(x, y, z) * 0.5)],
  };
}

// --- Bodies -----------------------------------------------------------------------------------------------------------

interface BodyWorld {
  spec: SurfaceSpec;
  shape: SphereWorld;
  terrain: Terrain;
  /** Coarsest level whose cells hold objects. */
  objectLevel: number;
}
const worlds = new Map<number, BodyWorld>();

function worldOf(packed: number): BodyWorld {
  let w = worlds.get(packed);
  if (!w) {
    const body = packed % BODY_SLOTS;
    const spec = SURFACES[body];
    if (!spec) throw new Error(`system: the seed ${packed} names the body ${body}, which does not exist`);
    // Every body has noise of its own, from the seed of the system and its place in it.
    const seed = hashInts(Math.floor(packed / BODY_SLOTS), 0x5e1, body);
    const make = { living: livingTerrain, desert: desertTerrain, cratered: crateredTerrain, ice: iceTerrain }[spec.look];
    w = { spec, shape: bodyShape(body), terrain: make(seed, spec), objectLevel: spec.leafLevel - 1 };
    worlds.set(packed, w);
  }
  return w;
}

const shapes = new Map<number, SphereWorld>();
/** The world shape of a body (index in `SURFACES`): a sphere of its radius round the origin of its own frame. */
export function bodyShape(body: number): SphereWorld {
  let s = shapes.get(body);
  if (!s) {
    s = new SphereWorld(SURFACES[body]!.radiusM);
    shapes.set(body, s);
  }
  return s;
}

/** Coarsest level of a body whose cells hold objects. From there on the surface carries the trees as its cover. */
export function objectLevel(body: number): number {
  return SURFACES[body]!.leafLevel - 1;
}

/** Height of the visible surface of a body above its base sphere, at a point of the base sphere. */
export function surfaceHeight(packed: number, x: number, y: number, z: number): number {
  return worldOf(packed).terrain.surface(x, y, z);
}

/** Height of the ground (under a sea: its floor) above the base sphere. */
export function groundHeight(packed: number, x: number, y: number, z: number): number {
  return worldOf(packed).terrain.ground(x, y, z);
}

/** Index in `SURFACES` of the body a seed names (`packSeed`). */
export function bodyIndex(packed: number): number {
  return packed % BODY_SLOTS;
}

/**
 * Today's climate of a body at a point of its base sphere and a ground height `h` there: temperature 0–1 and moisture
 * 0–1, the very formula its colours and objects use. Null for a body whose look has no climate.
 */
export function bodyClimate(packed: number, x: number, y: number, z: number, h: number): { t: number; m: number } | null {
  const c = worldOf(packed).terrain.climate;
  return c ? c(x, y, z, h) : null;
}

/** The parts of the living look of the body the seed names, or null for another look. */
export function livingParts(packed: number): LivingParts | null {
  return worldOf(packed).terrain.living ?? null;
}

/**
 * Radius of the sphere that hides what lies behind the horizon of a body. It must lie under everything drawn: under
 * the lowest ground, and under the flat triangles of the coarsest level, which dip inside the sphere between their
 * vertices (taken twice, to be on the safe side).
 */
export function horizonRadiusM(packed: number): number {
  const w = worldOf(packed);
  return w.spec.radiusM + w.terrain.minHeight - 2 * w.shape.facetDropM(ROOT_LEVEL, QUADS);
}

/** What a caller (the planned cells of ground.ts) changes in a cell; without hooks the cell is today's. */
export interface BodyCellHooks {
  domainVersion: number;
  /** May replace heightAt, colorAt and coverAt (wrapping the terrain's own) and add extraAt, nothing else. */
  patch(own: SpherePatchOptions): SpherePatchOptions;
  /** The height an object stands on (the `h` its rule gets). */
  ground(x: number, y: number, z: number): number;
  keepObject(x: number, y: number, z: number, h: number): boolean;
  /** More meshes of the cell, relative to the patch origin; their bounds join the cell's. */
  extra(origin: readonly [number, number, number]): { material: string; mesh: MeshData; bounds: LocalBounds }[];
  /** Replaces the terrain's own scatter rules; absent: the terrain's. */
  rules?: readonly Rule[];
}

/** Generates one cell of the body the seed names. Pure: (seed, cell) → content. */
export function generateBodyCell(packed: number, cell: CellId): CellContent {
  return buildBodyCell(packed, cell, null);
}

/** The body of `generateBodyCell`, with hooks; with `null` every step runs in today's order on today's values. */
export function buildBodyCell(packed: number, cell: CellId, hooks: BodyCellHooks | null): CellContent {
  const w = worldOf(packed);
  const { shape, terrain } = w;
  const R = w.spec.radiusM;
  const edge = shape.edgeM(cell.level);
  const ownOptions: SpherePatchOptions = {
    radiusM: R,
    face: cell.face,
    level: cell.level,
    x: cell.x,
    y: cell.y,
    quads: QUADS,
    heightAt: terrain.surface,
    colorAt: terrain.color,
    coverAt: terrain.cover,
    skirtDepth: Math.max(0.5, edge * 0.004),
  };
  const patchOptions = hooks ? hooks.patch(ownOptions) : ownOptions;
  const patch = spherePatchMesh(patchOptions);
  const o = patch.origin;
  const min: [number, number, number] = [patch.bounds.min[0], patch.bounds.min[1], patch.bounds.min[2]];
  const max: [number, number, number] = [patch.bounds.max[0], patch.bounds.max[1], patch.bounds.max[2]];
  // A cell that is all sea holds no objects and is as flat at every level.
  const land = terrain.minHeight < 0 || patch.maxHeight >= 2;

  const instances: CellInstances[] = [];
  const at: RuleAnchor = { face: cell.face, i: 0, j: 0 };
  for (const rule of cell.level >= w.objectLevel ? (hooks?.rules ?? terrain.rules) : []) {
    // Every anchor of the rule's grid that lies inside the cell (the grids are finer than the cells that show them).
    const k = 2 ** (rule.gridLevel - cell.level);
    const n = 2 ** rule.gridLevel;
    const data: number[] = [];
    const ids: number[] = [];
    for (let j = cell.y * k; j < (cell.y + 1) * k; j++) {
      for (let i = cell.x * k; i < (cell.x + 1) * k; i++) {
        const r = (q: number): number => unit(hashInts(packed, rule.id, cell.face, i, j, q));
        // A point inside the anchor's square of the grid.
        const d = cubeDirection(cell.face, cubeGrid(i + 0.1 + 0.8 * r(1), n), cubeGrid(j + 0.1 + 0.8 * r(2), n));
        const x = d[0] * R;
        const y = d[1] * R;
        const z = d[2] * R;
        const h = hooks ? hooks.ground(x, y, z) : terrain.ground(x, y, z);
        at.i = i;
        at.j = j;
        const p = rule.place(x, y, z, h, r, at);
        if (!p) continue;
        if (hooks && !hooks.keepObject(x, y, z, h)) continue;
        // Base: on the mesh of this level and never above the surface itself, sunk a little.
        const ideal = R + Math.max(terrain.minHeight, h);
        const sink = 0.15 * p[0]!;
        const own = Math.min(spherePatchRadius(patchOptions, d, 1), ideal) - sink;
        const coarse = Math.min(spherePatchRadius(patchOptions, d, 2), ideal) - sink;
        const lx = d[0] * own - o[0];
        const ly = d[1] * own - o[1];
        const lz = d[2] * own - o[2];
        data.push(lx, ly, lz, ...p, coarse - own);
        ids.push(hashInts(packed, 0x1d, rule.id, cell.face, i, j), hashInts(packed, 0x2d, rule.id, cell.face, i, j));
        // The object reaches at most its height and its reach from the base, at either end of the blend.
        const reach = p[0]! + p[1]! + Math.abs(coarse - own);
        const local = [lx, ly, lz];
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c]!, local[c]! - reach);
          max[c] = Math.max(max[c]!, local[c]! + reach);
        }
      }
    }
    if (data.length === 0) continue;
    const inst: InstanceData = { layout: OBJECT_LAYOUT, data: Float32Array.from(data) };
    instances.push({ archetype: rule.name, data: inst, ids: Uint32Array.from(ids) });
  }
  const meshes: CellContent['meshes'] = [{ material: 'terrain', mesh: patch.mesh }];
  for (const m of hooks ? hooks.extra(o) : []) {
    meshes.push({ material: m.material, mesh: m.mesh });
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, m.bounds.min[c]!);
      max[c] = Math.max(max[c]!, m.bounds.max[c]!);
    }
  }
  const bounds: CellContent['bounds'] = { min: [Math.fround(min[0]), Math.fround(min[1]), Math.fround(min[2])], max: [Math.fround(max[0]), Math.fround(max[1]), Math.fround(max[2])] };
  // The measured error knows only the surface. Land that is still too coarse to show its objects counts with the full
  // error of its level, so the objects appear at the same distance on flat ground as on rough ground.
  const error = Math.fround(Math.max(patch.error, land && cell.level < w.objectLevel ? edge * SELECTION.errorPerEdge : 0));
  return { cell, domainVersion: hooks ? hooks.domainVersion : DOMAIN_VERSION, bounds, meshes, instances, shapeHash: shapeHash(shape), error };
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

/**
 * A place to land near a wanted direction (unit, in the body's own turning frame): the first point of a fixed spiral
 * round it that stands on dry, gentle ground. A pure function of the seed, the body and the direction. Falls back to
 * the wanted direction itself on a body without such a place within reach.
 */
export function findSite(packed: number, wanted: readonly [number, number, number]): [number, number, number] {
  const w = worldOf(packed);
  const R = w.spec.radiusM;
  const ground = (d: readonly [number, number, number]): number => w.terrain.ground(d[0] * R, d[1] * R, d[2] * R);
  // Two directions across the wanted one.
  const a: [number, number, number] = Math.abs(wanted[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1: [number, number, number] = [a[1] * wanted[2] - a[2] * wanted[1], a[2] * wanted[0] - a[0] * wanted[2], a[0] * wanted[1] - a[1] * wanted[0]];
  const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
  e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const e2: [number, number, number] = [wanted[1] * e1[2] - wanted[2] * e1[1], wanted[2] * e1[0] - wanted[0] * e1[2], wanted[0] * e1[1] - wanted[1] * e1[0]];
  const at = (angle: number, turn: number): [number, number, number] => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const ct = Math.cos(turn);
    const st = Math.sin(turn);
    return [wanted[0] * c + (e1[0] * ct + e2[0] * st) * s, wanted[1] * c + (e1[1] * ct + e2[1] * st) * s, wanted[2] * c + (e1[2] * ct + e2[2] * st) * s];
  };
  for (let k = 0; k < 400; k++) {
    // Outward to a third of a radian (19°), a golden angle further round with every step.
    const angle = 0.33 * Math.sqrt(k / 400);
    const d = at(angle, k * 2.39996323);
    const h = ground(d);
    // On a body with a sea: land a little above it. Everywhere: not on a steep slope.
    if (w.terrain.minHeight === 0 && (h < 30 || h > 900)) continue;
    let gentle = true;
    for (let q = 0; q < 4 && gentle; q++) {
      const n = at(60 / R, (q * Math.PI) / 2);
      // The same step round the candidate: the wanted direction stands in for it, turned by the candidate's offset.
      const p: [number, number, number] = [d[0] + n[0] - wanted[0], d[1] + n[1] - wanted[1], d[2] + n[2] - wanted[2]];
      const l = Math.hypot(p[0], p[1], p[2]);
      gentle = Math.abs(ground([p[0] / l, p[1] / l, p[2] / l]) - h) < 14;
    }
    if (gentle) return d;
  }
  return [wanted[0], wanted[1], wanted[2]];
}
