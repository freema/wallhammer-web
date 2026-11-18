// The world of the planet example: a sphere of 100 km radius and a generator that is a pure function of the world
// seed and a cell of the sphere's six quadtrees.
//
// Heights and colours are functions of the point on the base sphere (noise in space, so there is no seam and no
// pole), never of the face or the cell they are built in: two cells agree on their shared border, across the edges of
// the cube as well, and a cell's bytes do not depend on which cells were built before it.
//
// Trees and rocks come from rules on fixed grids of the cube faces. The anchor of an object is a grid point; the object
// belongs to the cell that contains its anchor and its id is a hash of (seed, rule, face, anchor). An object stands
// along the local up of its base point: the instance record holds only the base and a turn about that up. Objects
// exist in the two finest levels only. Farther away the surface carries the trees as a cover baked into its
// vertices (`surfaceCover`), so a forest keeps its colour and its outline at any distance.

import type { InstanceData, MeshData, VertexLayout } from 'wallhammer-web/base';
import { cubeDirection, cubeGrid, fractalNoise3, hashInts, shapeHash, spherePatchMesh, spherePatchRadius, unit, valueNoise3 } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, CellInstances, LocalBounds, SpherePatchOptions } from 'wallhammer-web/gen-core';
import { SphereWorld } from 'wallhammer-web/world';

/** Radius of the base sphere: sea level. */
export const RADIUS_M = 100_000;
export const SHAPE = new SphereWorld(RADIUS_M);
/** The seed the page uses when the URL gives none. */
export const DEFAULT_SEED = 2611;
/** Raise when the output of the generator changes on purpose (it is written into every cell). */
export const DOMAIN_VERSION = 1;
/** Quads along a cell edge, at every level. */
export const QUADS = 32;
/** Level 0 is a whole face of the cube (157 km along its middle); level 11 cells are 77 m with a vertex every 2.4 m. */
export const ROOT_LEVEL = 0;
export const LEAF_LEVEL = 11;
/** Coarsest level whose cells hold objects. From there on the surface carries the trees as its cover. */
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
/** Lowest height the surface has: the sea. */
export const MIN_HEIGHT_M = 0;
/**
 * Radius of the sphere that hides what lies behind the horizon. It must lie under everything drawn: under the sea,
 * and under the flat triangles of the coarsest level, which dip inside the sphere between their vertices (taken
 * twice, to be on the safe side).
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
}
const seedCache = new Map<number, Seeds>();
function seeds(seed: number): Seeds {
  let s = seedCache.get(seed);
  if (!s) {
    const k = (i: number): number => hashInts(seed, 0x91a7e7, i);
    s = { land: k(1), ridge: k(2), range: k(3), hills: k(4), bumps: k(5), moisture: k(6), tint: k(7) };
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

/** Height of the visible surface: the sea stays at the base sphere. */
export function surfaceHeight(seed: number, x: number, y: number, z: number): number {
  return Math.max(MIN_HEIGHT_M, groundHeight(seed, x, y, z));
}

/** Temperature 0–1 (falls toward the poles of the y axis and with height) and moisture 0–1. */
function climate(seed: number, x: number, y: number, z: number, h: number): { t: number; m: number } {
  const lat = Math.abs(y) / RADIUS_M;
  return { t: 1 - lat * lat * 0.9 - Math.max(0, h) / 4600, m: valueNoise3(x, y, z, 24000, seeds(seed).moisture) };
}

type RGB = readonly [number, number, number];
const SAND: RGB = [202, 188, 140];
const GRASS: RGB = [104, 134, 62];
const WOOD: RGB = [58, 90, 46];
const DRY: RGB = [196, 152, 98];
const HEATH: RGB = [130, 128, 100];
const ROCK: RGB = [120, 112, 104];
const SNOW: RGB = [238, 241, 245];
const SHALLOW: RGB = [44, 104, 118];
const DEEP: RGB = [12, 38, 72];
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Share of the anchors of the tree rule that hold a tree, 0–1, from the climate. */
function forest(t: number, m: number): number {
  return smooth(0.42, 0.6, m) * smooth(0.25, 0.4, t);
}

/** Chance of a tree at an anchor on ground of height `h`. */
function treeChance(t: number, m: number, h: number): number {
  return h < 4 || h > 1700 ? 0 : 0.8 * forest(t, m) + 0.03;
}

/**
 * RGBA bytes of the surface; alpha 255 marks the sea. A function of the point alone, so every level agrees. `h` is the
 * height of the visible surface: 0 is the sea, whose colour follows the depth of the broad term under it.
 */
export function surfaceColor(seed: number, x: number, y: number, z: number, h: number): [number, number, number, number] {
  if (h <= 0) {
    const c = mixRgb(SHALLOW, DEEP, smooth(0, 600, -landHeight(seed, x, y, z)));
    return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255];
  }
  const { t, m } = climate(seed, x, y, z, h);
  let c = mixRgb(GRASS, WOOD, forest(t, m) * 0.6);
  c = mixRgb(c, DRY, smooth(0.72, 0.86, t) * (1 - smooth(0.28, 0.44, m)));
  c = mixRgb(c, HEATH, 1 - smooth(0.2, 0.34, t));
  c = mixRgb(c, SAND, 1 - smooth(3, 26, h));
  c = mixRgb(c, ROCK, smooth(1000, 2100, h) * 0.85);
  c = mixRgb(c, SNOW, 1 - smooth(0.05, 0.16, t));
  const v = 0.9 + 0.2 * valueNoise3(x, y, z, 420, seeds(seed).tint);
  return [Math.min(255, Math.round(c[0] * v)), Math.min(255, Math.round(c[1] * v)), Math.min(255, Math.round(c[2] * v)), 0];
}

/** Share of an anchor's square a tree hides from a slanted view, and how much darker a stand of trees is than a lit plane of their colour. */
const COVER_PER_TREE = 0.45;
const COVER_SHADE = 0.85;

/** Colour of a tree before its own brightness: darker and bluer where it is cold. */
function treeColor(cold: number): RGB {
  return [0.2 - 0.06 * cold, 0.34 - 0.05 * cold, 0.15 + 0.03 * cold];
}

/**
 * What the trees look like from afar, as RGBA bytes: rgb their mean colour, alpha the share of the ground they hide.
 * It is the tree rule itself taken as an expected value (the same chance per anchor, the same colours), a function of
 * the point alone, so the far look has the borders of the forest and every level agrees.
 */
export function surfaceCover(seed: number, x: number, y: number, z: number, h: number): [number, number, number, number] {
  const { t, m } = climate(seed, x, y, z, h);
  const c = treeColor(1 - smooth(0.3, 0.5, t));
  // Mean of the rule's brightness term, 0.85 + 0.25 r.
  const v = 0.975 * COVER_SHADE * 255;
  return [Math.round(c[0] * v), Math.round(c[1] * v), Math.round(c[2] * v), Math.round(255 * (1 - Math.exp(-treeChance(t, m, h) * COVER_PER_TREE)))];
}

/** A scatter rule: objects on a grid of `2^gridLevel` intervals across a face, shown from `OBJECT_LEVEL` to the leaves. */
interface Rule {
  id: number;
  /** Name of the archetype the instances are drawn with. */
  name: string;
  gridLevel: number;
  /** Returns reach, height, turn, width, depth, r, g, b, variant; or null for no object. `h` is the ground height. */
  place: (seed: number, x: number, y: number, z: number, h: number, r: (k: number) => number) => readonly number[] | null;
}

export const RULES: readonly Rule[] = [
  {
    id: 1,
    name: 'rock',
    gridLevel: 12,
    place: (seed, x, y, z, h, r) => {
      if (h < 2) return null;
      // More of them in the mountains and above the trees.
      if (r(3) > 0.06 + 0.4 * rangeShare(seed, x, y, z) + 0.2 * smooth(1200, 2200, h)) return null;
      const size = 1.2 + 6 * r(4) * r(4);
      const tone = 0.8 + 0.3 * r(5);
      return [size, size * (0.5 + 0.4 * r(6)), r(7) * 6.2832, size, size * (0.7 + 0.5 * r(8)), 0.5 * tone, 0.47 * tone, 0.43 * tone, 0];
    },
  },
  {
    id: 2,
    name: 'tree',
    gridLevel: 13,
    place: (seed, x, y, z, h, r) => {
      const { t, m } = climate(seed, x, y, z, h);
      if (r(3) >= treeChance(t, m, h)) return null;
      const height = 9 + 13 * r(4);
      const cold = 1 - smooth(0.3, 0.5, t);
      const c = treeColor(cold);
      const v = 0.85 + 0.25 * r(5);
      return [height * 0.35, height, r(6) * 6.2832, height * (0.28 + 0.08 * r(7)), 0, c[0] * v, c[1] * v, c[2] * v, cold > 0.5 ? 1 : 0];
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
    heightAt: (x, y, z) => surfaceHeight(seed, x, y, z),
    colorAt: (x, y, z, h) => surfaceColor(seed, x, y, z, h),
    coverAt: (x, y, z, h) => surfaceCover(seed, x, y, z, h),
    skirtDepth: Math.max(0.5, SHAPE.edgeM(cell.level) * 0.004),
  };
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

/** Generates one cell. Pure: (seed, cell) → content. */
export function generatePlanetCell(seed: number, cell: CellId): CellContent {
  return buildPlanetCell(seed, cell, null);
}

/** The body of `generatePlanetCell`, with hooks. Pure: (seed, cell, hooks) → content. */
export function buildPlanetCell(seed: number, cell: CellId, hooks: PlanetCellHooks | null): CellContent {
  const edge = SHAPE.edgeM(cell.level);
  const patchOptions = hooks?.patch ? hooks.patch(patchOptionsOf(seed, cell)) : patchOptionsOf(seed, cell);
  const patch = spherePatchMesh(patchOptions);
  const o = patch.origin;
  const min: [number, number, number] = [patch.bounds.min[0], patch.bounds.min[1], patch.bounds.min[2]];
  const max: [number, number, number] = [patch.bounds.max[0], patch.bounds.max[1], patch.bounds.max[2]];
  const land = patch.maxHeight >= 2;

  const instances: CellInstances[] = [];
  for (const rule of cell.level >= OBJECT_LEVEL ? RULES : []) {
    // Every anchor of the rule's grid that lies inside the cell (the grids are finer than the cells that show them).
    const k = 2 ** (rule.gridLevel - cell.level);
    const n = 2 ** rule.gridLevel;
    const data: number[] = [];
    const ids: number[] = [];
    for (let j = cell.y * k; j < (cell.y + 1) * k; j++) {
      for (let i = cell.x * k; i < (cell.x + 1) * k; i++) {
        const r = (q: number): number => unit(hashInts(seed, rule.id, cell.face, i, j, q));
        // A point inside the anchor's square of the grid.
        const d = cubeDirection(cell.face, cubeGrid(i + 0.1 + 0.8 * r(1), n), cubeGrid(j + 0.1 + 0.8 * r(2), n));
        const x = d[0] * RADIUS_M;
        const y = d[1] * RADIUS_M;
        const z = d[2] * RADIUS_M;
        const h = groundHeight(seed, x, y, z);
        const p = rule.place(seed, x, y, z, h, r);
        if (!p) continue;
        if (hooks?.keepObject && !hooks.keepObject(x, y, z)) continue;
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
      }
    }
    if (data.length === 0) continue;
    const inst: InstanceData = { layout: OBJECT_LAYOUT, data: Float32Array.from(data) };
    instances.push({ archetype: rule.name, data: inst, ids: Uint32Array.from(ids) });
  }
  const meshes: CellContent['meshes'] = [{ material: 'terrain', mesh: patch.mesh }];
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
