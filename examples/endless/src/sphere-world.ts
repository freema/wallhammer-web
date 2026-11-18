// The generator of the sphere page (sphere.html): a pure function of the world seed and a cell of a sphere of six
// quadtrees. Heights and colours are functions of the point on the base sphere (3D noise, so there is no seam and no
// pole), never of the face or the cell they are built in: two cells agree on their shared border, across the edges of
// the cube as well, and a cell's bytes do not depend on which cells were built before it.
//
// Objects come from rules on fixed grids of the cube faces. The anchor of an object is a grid point; the object
// belongs to the cell that contains its anchor and its id is a hash of (seed, rule, face, anchor). Every object stands
// along the local up of its base point: the instance record holds only the base and a turn about that up, and the
// shader builds the frame from the position (`localFrame`).

import type { InstanceData, VertexLayout } from 'wallhammer-web/base';
import { cubeDirection, cubeGrid, fractalNoise3, hashInts, shapeHash, spherePatchMesh, spherePatchRadius, unit, valueNoise3 } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, CellInstances } from 'wallhammer-web/gen-core';
import { SphereWorld } from 'wallhammer-web/world';

/** Radius of the base sphere: sea level. */
export const RADIUS_M = 100_000;
export const SHAPE = new SphereWorld(RADIUS_M);
/** Raise when the output of the generator changes on purpose (it is written into every cell). */
export const DOMAIN_VERSION = 1;
/** Version of the cells made with the baked cover (`generateSphereCell(seed, cell, true)`): another vertex layout. */
export const COVER_DOMAIN_VERSION = 101;
/** Quads along a cell edge, at every level. */
export const QUADS = 32;
/** Level 0 is a whole face of the cube (157 km along its middle); level 11 cells are 77 m with a vertex every 2.4 m. */
export const ROOT_LEVEL = 0;
export const LEAF_LEVEL = 11;
/** Selection of levels by screen-space error, as for the smooth levels of the flat world. */
export const SELECTION = {
  errorPerEdge: 1 / (8 * QUADS),
  minErrorPerEdge: 1 / (32 * QUADS),
  maxErrorPx: 2,
  maxCells: 900,
  pixelsPerRadian: 1158,
} as const;
/** The blend between levels is free of jumps while a cell is split at more than 2.02 edges. */
export const MIN_SPLIT_EDGES = 2.05;
/** Lowest height the surface has: the sea. */
export const MIN_HEIGHT_M = 0;
/**
 * Radius of the sphere that hides what lies behind the horizon. It must lie under everything drawn: under the sea,
 * and under the flat triangles of the coarsest level, which dip inside the sphere between their vertices (taken
 * twice, to be on the safe side).
 */
export const HORIZON_RADIUS_M = RADIUS_M + MIN_HEIGHT_M - 2 * SHAPE.facetDropM(ROOT_LEVEL, QUADS);

/** One instance: base x, y, z (cell-local), reach | height, turn about up, width, depth | r, g, b, variant | shift to the coarser level. */
export const PROP_LAYOUT: VertexLayout = {
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

interface Seeds {
  continent: number;
  ridge: number;
  mask: number;
  hills: number;
  moisture: number;
  tint: number;
}
const seedCache = new Map<number, Seeds>();
function seeds(seed: number): Seeds {
  let s = seedCache.get(seed);
  if (!s) {
    const k = (i: number): number => hashInts(seed, 0x5b0e21, i);
    s = { continent: k(1), ridge: k(2), mask: k(3), hills: k(4), moisture: k(5), tint: k(6) };
    seedCache.set(seed, s);
  }
  return s;
}

/** How much of the mountain term a point gets, 0–1. */
function mountainMask(seed: number, x: number, y: number, z: number): number {
  return smooth(0.48, 0.74, valueNoise3(x, y, z, 26000, seeds(seed).mask));
}

/** Height of the ground above the base sphere at a point of it (metres from the centre). Below 0 is under the sea. */
export function groundHeight(seed: number, x: number, y: number, z: number): number {
  const s = seeds(seed);
  const continent = (fractalNoise3(x, y, z, { cellM: 46000, octaves: 3, lacunarity: 2.1, gain: 0.5 }, s.continent) - 0.47) * 5200;
  const r = 1 - Math.abs(2 * fractalNoise3(x, y, z, { cellM: 9000, octaves: 2, lacunarity: 2.3, gain: 0.45 }, s.ridge) - 1);
  const mountains = mountainMask(seed, x, y, z);
  const hills = fractalNoise3(x, y, z, { cellM: 1100, octaves: 4, lacunarity: 2.7, gain: 0.45 }, s.hills);
  return continent + mountains * r * r * 2600 + (hills - 0.5) * (140 + 420 * mountains);
}

/** Height of the visible surface: the sea stays at the base sphere. */
export function surfaceHeight(seed: number, x: number, y: number, z: number): number {
  return Math.max(MIN_HEIGHT_M, groundHeight(seed, x, y, z));
}

/** Temperature 0–1 (falls toward the poles of the y axis and with height) and moisture 0–1. */
function climate(seed: number, x: number, y: number, z: number, h: number): { t: number; m: number } {
  const lat = Math.abs(y) / RADIUS_M;
  return { t: 1 - lat * lat * 0.95 - Math.max(0, h) / 4200, m: valueNoise3(x, y, z, 21000, seeds(seed).moisture) };
}

type RGB = readonly [number, number, number];
const SAND: RGB = [196, 181, 132];
const GRASS: RGB = [98, 128, 58];
const FOREST: RGB = [56, 86, 42];
const DESERT: RGB = [201, 158, 102];
const TUNDRA: RGB = [128, 124, 98];
const ROCK: RGB = [116, 108, 100];
const SNOW: RGB = [238, 241, 245];
const SHALLOW: RGB = [42, 98, 112];
const DEEP: RGB = [14, 40, 70];
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function forest(t: number, m: number): number {
  return smooth(0.45, 0.62, m) * smooth(0.25, 0.4, t);
}

/** RGBA bytes of the surface; alpha 255 marks the sea. A function of the point alone, so every level agrees. */
export function surfaceColor(seed: number, x: number, y: number, z: number, h: number): [number, number, number, number] {
  const g = groundHeight(seed, x, y, z);
  if (g < 0) {
    const c = mixRgb(SHALLOW, DEEP, smooth(0, 500, -g));
    return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255];
  }
  const { t, m } = climate(seed, x, y, z, h);
  let c = mixRgb(GRASS, FOREST, forest(t, m));
  c = mixRgb(c, DESERT, smooth(0.7, 0.85, t) * (1 - smooth(0.3, 0.45, m)));
  c = mixRgb(c, TUNDRA, 1 - smooth(0.2, 0.34, t));
  c = mixRgb(c, SAND, 1 - smooth(4, 30, h));
  c = mixRgb(c, ROCK, smooth(900, 1900, h) * 0.85);
  c = mixRgb(c, SNOW, 1 - smooth(0.05, 0.16, t));
  const v = 0.9 + 0.2 * valueNoise3(x, y, z, 400, seeds(seed).tint);
  return [Math.min(255, Math.round(c[0] * v)), Math.min(255, Math.round(c[1] * v)), Math.min(255, Math.round(c[2] * v)), 0];
}

/** Share of an anchor's square a tree hides from a slanted view, and how much darker a stand of trees is than a lit plane of their colour. */
const COVER_PER_TREE = 0.45;
const COVER_SHADE = 0.85;

/**
 * What the trees look like from afar, as RGBA bytes: rgb their mean colour, alpha the share of the ground they hide.
 * It is the tree rule itself taken as an expected value (the same chance per anchor, the same colours), a function of
 * the point alone, so the far look has the borders of the forest and every level agrees.
 */
export function surfaceCover(seed: number, x: number, y: number, z: number, h: number): [number, number, number, number] {
  const { t, m } = climate(seed, x, y, z, h);
  const cold = 1 - smooth(0.3, 0.5, t);
  const chance = h < 4 || h > 1500 ? 0 : 0.8 * forest(t, m) + 0.04;
  // Mean of the rule's brightness term, 0.85 + 0.25 r.
  const v = 0.975 * COVER_SHADE * 255;
  return [Math.round((0.2 - 0.06 * cold) * v), Math.round((0.33 - 0.04 * cold) * v), Math.round((0.16 + 0.02 * cold) * v), Math.round(255 * (1 - Math.exp(-chance * COVER_PER_TREE)))];
}

/** A scatter rule: objects on a grid of `2^gridLevel` intervals across a face, shown from `minLevel` to the leaves. */
interface Rule {
  id: number;
  name: string;
  gridLevel: number;
  minLevel: number;
  /** Returns reach, height, turn, width, depth, r, g, b, variant; or null for no object. `h` is the ground height. */
  place: (seed: number, x: number, y: number, z: number, h: number, r: (k: number) => number) => readonly number[] | null;
}

export const RULES: readonly Rule[] = [
  {
    id: 1,
    name: 'pillar',
    gridLevel: 8,
    minLevel: 5,
    place: (seed, x, y, z, h, r) => {
      if (h < 20) return null;
      if (r(3) > 0.1 + 0.5 * mountainMask(seed, x, y, z)) return null;
      const height = 60 + 160 * r(4) * r(4);
      const width = 26 + 30 * r(5);
      const tone = 0.85 + 0.25 * r(6);
      return [width * 1.3, height, r(7) * 6.2832, width, width * (0.7 + 0.4 * r(8)), 0.52 * tone, 0.47 * tone, 0.42 * tone, Math.floor(r(9) * 4)];
    },
  },
  {
    id: 2,
    name: 'tree',
    gridLevel: 13,
    minLevel: 10,
    place: (seed, x, y, z, h, r) => {
      if (h < 4 || h > 1500) return null;
      const { t, m } = climate(seed, x, y, z, h);
      if (r(3) > 0.8 * forest(t, m) + 0.04) return null;
      const height = 9 + 13 * r(4);
      const cold = 1 - smooth(0.3, 0.5, t);
      const v = 0.85 + 0.25 * r(5);
      return [height * 0.35, height, r(6) * 6.2832, height * (0.28 + 0.08 * r(7)), 0, (0.2 - 0.06 * cold) * v, (0.33 - 0.04 * cold) * v, (0.16 + 0.02 * cold) * v, cold > 0.5 ? 1 : 0];
    },
  },
];

/** Coarsest level whose cells hold trees: from there on the surface carries them as its cover. */
export const COVER_LEVEL = RULES.find((r) => r.name === 'tree')!.minLevel;

/**
 * Generates one cell. Pure: (seed, cell) → content. With `cover` the surface also carries what the trees look like
 * from afar (`surfaceCover`, the cover layout of the sphere patch); everything else is the same.
 */
export function generateSphereCell(seed: number, cell: CellId, cover = false): CellContent {
  const edge = SHAPE.edgeM(cell.level);
  const patchOptions = {
    radiusM: RADIUS_M,
    face: cell.face,
    level: cell.level,
    x: cell.x,
    y: cell.y,
    quads: QUADS,
    heightAt: (x: number, y: number, z: number): number => surfaceHeight(seed, x, y, z),
    colorAt: (x: number, y: number, z: number, h: number): [number, number, number, number] => surfaceColor(seed, x, y, z, h),
    skirtDepth: Math.max(0.5, edge * 0.004),
    ...(cover ? { coverAt: (x: number, y: number, z: number, h: number): [number, number, number, number] => surfaceCover(seed, x, y, z, h) } : {}),
  };
  const patch = spherePatchMesh(patchOptions);
  const o = patch.origin;
  const min: [number, number, number] = [patch.bounds.min[0], patch.bounds.min[1], patch.bounds.min[2]];
  const max: [number, number, number] = [patch.bounds.max[0], patch.bounds.max[1], patch.bounds.max[2]];
  let land = patch.maxHeight >= 4;

  const instances: CellInstances[] = [];
  for (const rule of RULES) {
    if (cell.level < rule.minLevel) continue;
    // Anchors of the rule's grid that can hold an object of this cell: every anchor inside the cell, or, for a grid
    // coarser than the cell, the one anchor whose square the cell lies in.
    const shift = rule.gridLevel - cell.level;
    const k = 2 ** Math.abs(shift);
    const i0 = shift >= 0 ? cell.x * k : Math.floor(cell.x / k);
    const j0 = shift >= 0 ? cell.y * k : Math.floor(cell.y / k);
    const count = shift >= 0 ? k : 1;
    const n = 2 ** rule.gridLevel;
    const data: number[] = [];
    const ids: number[] = [];
    for (let j = j0; j < j0 + count; j++) {
      for (let i = i0; i < i0 + count; i++) {
        const r = (q: number): number => unit(hashInts(seed, rule.id, cell.face, i, j, q));
        // A point inside the anchor's square of the grid. The object belongs to the one cell that contains the point.
        const u = i + 0.1 + 0.8 * r(1);
        const v = j + 0.1 + 0.8 * r(2);
        if (shift < 0 && (Math.floor(u * k) !== cell.x || Math.floor(v * k) !== cell.y)) continue;
        const d = cubeDirection(cell.face, cubeGrid(u, n), cubeGrid(v, n));
        const x = d[0] * RADIUS_M;
        const y = d[1] * RADIUS_M;
        const z = d[2] * RADIUS_M;
        const h = groundHeight(seed, x, y, z);
        const p = rule.place(seed, x, y, z, h, r);
        if (!p) continue;
        // Base: on the mesh of this level and never above the ground itself, sunk a little.
        const ideal = RADIUS_M + Math.max(MIN_HEIGHT_M, h);
        const sink = 0.15 * p[0]!;
        const own = Math.min(spherePatchRadius(patchOptions, d, 1), ideal) - sink;
        const coarse = Math.min(spherePatchRadius(patchOptions, d, 2), ideal) - sink;
        const lx = d[0] * own - o[0];
        const ly = d[1] * own - o[1];
        const lz = d[2] * own - o[2];
        data.push(lx, ly, lz, ...p, coarse - own);
        ids.push(hashInts(seed, 0x1d, rule.id, cell.face, i, j), hashInts(seed, 0x2d, rule.id, cell.face, i, j));
        // The object reaches at most its height and its reach from the base, at either end of the blend.
        const reach = p[0]! + p[1]! + Math.abs(coarse - own);
        const local = [lx, ly, lz];
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c]!, local[c]! - reach);
          max[c] = Math.max(max[c]!, local[c]! + reach);
        }
        land = true;
      }
    }
    if (data.length === 0) continue;
    const inst: InstanceData = { layout: PROP_LAYOUT, data: Float32Array.from(data) };
    instances.push({ archetype: rule.name, data: inst, ids: Uint32Array.from(ids) });
  }
  const bounds: CellContent['bounds'] = { min: [Math.fround(min[0]), Math.fround(min[1]), Math.fround(min[2])], max: [Math.fround(max[0]), Math.fround(max[1]), Math.fround(max[2])] };
  // The measured error knows only the surface. Land that is still too coarse to show every kind of instance counts
  // with the full error of its level, so the instances appear at the same distance on flat ground as on rough ground.
  const coarseLand = land && cell.level < RULES[RULES.length - 1]!.minLevel;
  const error = Math.fround(Math.max(patch.error, coarseLand ? edge * SELECTION.errorPerEdge : 0));
  return { cell, domainVersion: cover ? COVER_DOMAIN_VERSION : DOMAIN_VERSION, bounds, meshes: [{ material: 'terrain', mesh: patch.mesh }], instances, shapeHash: shapeHash(SHAPE), error };
}
