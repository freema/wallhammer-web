// The endless world's generator: a pure function of the world seed and a cell. Heights, colours and the scattered
// objects are functions of world coordinates (doubles), never of the cell they are built in, so two cells agree on
// their shared border and a cell's bytes do not depend on which cells were built before it. Only `Math.sqrt`,
// `Math.floor` and arithmetic enter the output: no transcendental function, no clock, no shared state.
//
// Objects come from rules on fixed world grids. The anchor of an object is a grid point; the object belongs to the
// cell that contains its anchor and its id is a hash of (seed, rule, anchor), so it keeps the same id at every level of
// detail that shows it and in every order of generation.

import type { InstanceData, MeshData, VertexLayout } from 'wallhammer-web/base';
import { FlatWorld, FACE_FLAT, hashInts, shapeHash, unit, valueNoise2 } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, CellInstances, LocalBounds } from 'wallhammer-web/gen-core';
import { cellMorphMesh, cellSurfaceMesh } from 'wallhammer-web/gen-mesh';

export const SHAPE = new FlatWorld();
export const FACE = FACE_FLAT;
/** Raise when the output of the generator changes on purpose (it is written into every cell). */
export const DOMAIN_VERSION = 1;
/** Quads along a cell edge, at every level: a coarse cell has the same vertex count on four times the area. */
export const QUADS = 32;
export const ROOT_LEVEL = 4;
export const LEAF_LEVEL = 9;

/** One instance: base x, y, z (cell-local), reach radius | height, yaw, width, depth | r, g, b, variant. */
export const PROP_LAYOUT: VertexLayout = {
  stride: 48,
  attribs: [
    { name: 'i_base', size: 4, type: 'f32', offset: 0 },
    { name: 'i_shape', size: 4, type: 'f32', offset: 16 },
    { name: 'i_color', size: 4, type: 'f32', offset: 32 },
  ],
};
export const PROP_FLOATS = PROP_LAYOUT.stride / 4;

// --- Smooth levels (URL hash lod=smooth; off by default) -------------------------------------------------------------
// The second generator, `generateSmoothCell`, builds the same world with what a blend between levels needs: every
// surface vertex and every instance also carries the distance to the surface of the cell one level coarser (an instance
// also whether that level holds it at all), and the cell states the hash of the world shape and its own error. Such cells are written in cell format 2; the cells of
// `generateCell` keep format 1 and their bytes.

/** Raise when the output of `generateSmoothCell` changes on purpose. */
export const SMOOTH_DOMAIN_VERSION = 1;
/**
 * `PROP_LAYOUT` and then: metres along "up" from the instance's base to where it stands on the coarser level, and its
 * size there (1, or 0 when the coarser level does not hold it: the instance then grows with the blend instead of
 * appearing at once).
 */
export const PROP_MORPH_LAYOUT: VertexLayout = {
  stride: 56,
  attribs: [...PROP_LAYOUT.attribs, { name: 'i_coarseShift', size: 1, type: 'f32', offset: 48 }, { name: 'i_coarseSize', size: 1, type: 'f32', offset: 52 }],
};
/**
 * Selection of levels by screen-space error for the smooth generator. A cell's error is taken as an eighth of its
 * vertex spacing unless the cell measured less; `maxErrorPx` and `maxCells` are the defaults of the example.
 */
export const SMOOTH_SELECTION = {
  errorPerEdge: 1 / (8 * QUADS),
  minErrorPerEdge: 1 / (32 * QUADS),
  maxErrorPx: 2,
  maxCells: 800,
  /** A 1080 pixel high view with a 50° field of view; tickets of the running example state their own. */
  pixelsPerRadian: 1158,
} as const;
/**
 * The blend between levels is free of jumps while a cell is split at more than 2.02 edges (see
 * `StreamingManager.morphRange`); the example keeps the split distance at or above this.
 */
export const SMOOTH_MIN_SPLIT_EDGES = 2.05;
/** Streaming settings that go with it: a narrow prefetch ring, because the split distance is already wide. */
export const SMOOTH_STREAMING = { prefetch: 0.2, hysteresis: 0.3 } as const;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Seeds of the noise streams, derived once per world seed. */
interface Seeds {
  continent: number[];
  ridge: number[];
  mask: number;
  hills: number[];
  temperature: number;
  moisture: number;
  tint: number;
}

const seedCache = new Map<number, Seeds>();
function seeds(seed: number): Seeds {
  let s = seedCache.get(seed);
  if (!s) {
    const k = (i: number): number => hashInts(seed, 0x7e44a1, i);
    s = { continent: [k(1), k(2), k(3)], ridge: [k(4), k(5)], mask: k(6), hills: [k(7), k(8), k(9)], temperature: k(10), moisture: k(11), tint: k(12) };
    seedCache.set(seed, s);
  }
  return s;
}

/** Height of the ground at a world point (below 0 is under water). */
export function groundHeight(seed: number, x: number, z: number): number {
  const s = seeds(seed);
  const c = 0.5 * valueNoise2(x, z, 9000, s.continent[0]!) + 0.32 * valueNoise2(x, z, 4100, s.continent[1]!) + 0.18 * valueNoise2(x, z, 1900, s.continent[2]!);
  const continent = (c - 0.42) * 700;
  const r1 = 1 - Math.abs(2 * valueNoise2(x, z, 1400, s.ridge[0]!) - 1);
  const r2 = 1 - Math.abs(2 * valueNoise2(x, z, 610, s.ridge[1]!) - 1);
  const ridged = 0.65 * r1 * r1 + 0.35 * r2 * r2;
  const mountains = smooth(0.48, 0.78, valueNoise2(x, z, 7000, s.mask));
  const hills = 0.6 * valueNoise2(x, z, 260, s.hills[0]!) + 0.3 * valueNoise2(x, z, 95, s.hills[1]!) + 0.1 * valueNoise2(x, z, 31, s.hills[2]!);
  return continent + mountains * ridged * 950 + hills * (36 + 70 * mountains);
}

/** Height of the visible surface: water stays flat at 0. */
export function surfaceHeight(seed: number, x: number, z: number): number {
  return Math.max(0, groundHeight(seed, x, z));
}

/** Climate at a point: temperature and moisture 0–1 (temperature falls with height). */
export function climate(seed: number, x: number, z: number, y: number): { t: number; m: number } {
  const s = seeds(seed);
  return { t: valueNoise2(x, z, 12000, s.temperature) - Math.max(0, y) / 1500, m: valueNoise2(x, z, 8000, s.moisture) };
}

type RGB = readonly [number, number, number];
const SAND: RGB = [196, 181, 132];
const GRASS: RGB = [98, 128, 58];
const FOREST: RGB = [56, 86, 42];
const DESERT: RGB = [201, 158, 102];
const TUNDRA: RGB = [128, 124, 98];
const ROCK: RGB = [116, 108, 100];
const SNOW: RGB = [238, 241, 245];
const SHALLOW: RGB = [52, 104, 108];
const DEEP: RGB = [18, 46, 66];

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Forest density 0–1 at a point. */
function forest(t: number, m: number): number {
  return smooth(0.5, 0.65, m) * smooth(0.22, 0.32, t) * (1 - smooth(0.62, 0.72, t) * (1 - smooth(0.6, 0.75, m)));
}

/**
 * RGBA bytes of the surface; alpha 255 marks water. The slope comes from a fixed 12 m difference, not from the mesh,
 * so a coarse cell gets the same colours as the fine cells it stands for.
 */
export function surfaceColor(seed: number, x: number, z: number, y: number): [number, number, number, number] {
  const g = groundHeight(seed, x, z);
  if (g < 0) {
    const c = mixRgb(SHALLOW, DEEP, smooth(0, 60, -g));
    return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255];
  }
  const { t, m } = climate(seed, x, z, y);
  const ny = slopeY(seed, x, z, 12);
  let c = mixRgb(GRASS, FOREST, forest(t, m));
  c = mixRgb(c, DESERT, smooth(0.52, 0.62, t) * (1 - smooth(0.3, 0.42, m)));
  c = mixRgb(c, TUNDRA, 1 - smooth(0.16, 0.28, t));
  c = mixRgb(c, SAND, 1 - smooth(2, 7, y));
  c = mixRgb(c, ROCK, 1 - smooth(0.68, 0.8, ny));
  c = mixRgb(c, SNOW, (1 - smooth(0.02, 0.12, t)) * smooth(0.6, 0.75, ny));
  const v = 0.9 + 0.2 * valueNoise2(x, z, 70, seeds(seed).tint);
  return [Math.min(255, Math.round(c[0] * v)), Math.min(255, Math.round(c[1] * v)), Math.min(255, Math.round(c[2] * v)), 0];
}

/** A scatter rule: objects on a world grid, shown from `minLevel` to the leaves. */
interface Rule {
  id: number;
  name: string;
  gridM: number;
  minLevel: number;
  /** Returns the instance (11 floats after the cell-local position) or null; `h` is the ground height. */
  place: (seed: number, x: number, z: number, h: number, r: (k: number) => number) => readonly number[] | null;
}

/** Unit slope (normal y) of the ground at a point, from a central difference over ±d metres. */
function slopeY(seed: number, x: number, z: number, d = 2): number {
  const dx = (surfaceHeight(seed, x + d, z) - surfaceHeight(seed, x - d, z)) / (2 * d);
  const dz = (surfaceHeight(seed, x, z + d) - surfaceHeight(seed, x, z - d)) / (2 * d);
  return 1 / Math.sqrt(dx * dx + 1 + dz * dz);
}

export const RULES: readonly Rule[] = [
  {
    id: 1,
    name: 'pillar',
    gridM: 512,
    minLevel: 5,
    place: (seed, x, z, h, r) => {
      if (h < 3) return null;
      const { t, m } = climate(seed, x, z, h);
      const dry = smooth(0.45, 0.25, m) + 0.6 * smooth(0.5, 0.65, t);
      if (r(3) > 0.08 + 0.5 * Math.min(1, dry)) return null;
      const height = 40 + 110 * r(4) * r(4);
      const width = 20 + 22 * r(5);
      const tone = 0.85 + 0.25 * r(6);
      const desert = Math.min(1, dry);
      return [width * 1.3, height, r(7) * 6.2832, width, width * (0.7 + 0.4 * r(8)), (0.5 + 0.18 * desert) * tone, (0.45 + 0.08 * desert) * tone, (0.42 - 0.05 * desert) * tone, Math.floor(r(9) * 4)];
    },
  },
  {
    id: 2,
    name: 'rock',
    gridM: 32,
    minLevel: 8,
    place: (seed, x, z, h, r) => {
      if (h < 1) return null;
      const ny = slopeY(seed, x, z);
      if (r(3) > 0.06 + 0.5 * smooth(0.95, 0.75, ny)) return null;
      const size = 1.2 + 3.5 * r(4) * r(4);
      const tone = 0.8 + 0.3 * r(5);
      return [size * 1.2, size * (0.6 + 0.5 * r(6)), r(7) * 6.2832, size, size * (0.7 + 0.5 * r(8)), 0.47 * tone, 0.45 * tone, 0.43 * tone, Math.floor(r(9) * 4)];
    },
  },
  {
    id: 3,
    name: 'tree',
    gridM: 16,
    minLevel: 8,
    place: (seed, x, z, h, r) => {
      if (h < 3) return null;
      const { t, m } = climate(seed, x, z, h);
      const f = forest(t, m);
      if (r(3) > 0.85 * f + 0.03 * smooth(0.35, 0.5, m)) return null;
      if (slopeY(seed, x, z) < 0.8) return null;
      const height = 9 + 13 * r(4);
      const cold = 1 - smooth(0.25, 0.45, t);
      const v = 0.85 + 0.25 * r(5);
      return [height * 0.35, height, r(6) * 6.2832, height * (0.28 + 0.08 * r(7)), 0, (0.2 - 0.06 * cold) * v, (0.33 - 0.04 * cold) * v, (0.16 + 0.02 * cold) * v, cold > 0.5 ? 1 : 0];
    },
  },
];

/** Height of the cell's mesh at a world point: the same triangle the mesh draws there (exact for this level). */
function meshHeightAt(seed: number, ox: number, oz: number, step: number, x: number, z: number, heightAt: ((x: number, z: number) => number) | null = null): number {
  const u = (x - ox) / step;
  const v = (z - oz) / step;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const at = (a: number, b: number): number => (heightAt ? heightAt(ox + a * step, oz + b * step) : surfaceHeight(seed, ox + a * step, oz + b * step));
  // The mesh splits a quad along the diagonal from (i + 1, j) to (i, j + 1).
  if (fu + fv <= 1) {
    const a = at(i, j);
    return a + (at(i + 1, j) - a) * fu + (at(i, j + 1) - a) * fv;
  }
  const d = at(i + 1, j + 1);
  return d + (at(i, j + 1) - d) * (1 - fu) + (at(i + 1, j) - d) * (1 - fv);
}

/** Generates one cell. Pure: (seed, cell) → content. */
export function generateCell(seed: number, cell: CellId): CellContent {
  return buildCell(seed, cell, false);
}

/**
 * Generates one cell for smooth levels (lod=smooth): the surface and the instances can blend into the shape of the
 * cell one level coarser, and the cell states its world shape and its error. Pure: (seed, cell) → content.
 */
export function generateSmoothCell(seed: number, cell: CellId): CellContent {
  return buildCell(seed, cell, true, null);
}

/**
 * Optional changes to the body of `generateSmoothCell`, for generators built on it (strips.ts). Without them the body
 * gives exactly the bytes of `generateSmoothCell`.
 */
export interface SmoothCellHooks {
  /** Height of the visible surface at a world point, in place of `surfaceHeight`. */
  heightAt?: (x: number, z: number) => number;
  /** RGBA bytes of the surface, in place of `surfaceColor`; `y` is the height of the surface. */
  colorAt?: (x: number, z: number, y: number) => [number, number, number, number];
  /** False drops an object whose anchor lies at this point. */
  keepObject?: (x: number, z: number) => boolean;
  /** More meshes of the cell, relative to the cell origin, with their extent. */
  extra?: () => { material: string; mesh: MeshData; bounds: LocalBounds }[];
  domainVersion?: number;
}

/** The body of `generateSmoothCell`, with hooks. Pure: (seed, cell, hooks) → content. */
export function buildSmoothCell(seed: number, cell: CellId, hooks: SmoothCellHooks | null): CellContent {
  return buildCell(seed, cell, true, hooks);
}

function buildCell(seed: number, cell: CellId, smooth: boolean, hooks: SmoothCellHooks | null = null): CellContent {
  const size = SHAPE.edgeM(cell.level);
  const o = SHAPE.origin(cell);
  const ox = o[0];
  const oz = o[2];
  const step = size / QUADS;
  const heightHook = hooks?.heightAt ?? null;
  const options = {
    originX: ox,
    originZ: oz,
    size,
    quads: QUADS,
    heightAt: heightHook ?? ((x: number, z: number): number => surfaceHeight(seed, x, z)),
    colorAt: hooks?.colorAt ?? ((x: number, z: number, y: number): [number, number, number, number] => surfaceColor(seed, x, z, y)),
  };
  // Smooth levels leave no step between levels where the blend is exact, so the skirt only has to cover the rest; the
  // mesh deepens it itself where the border needs more.
  const morph = smooth ? cellMorphMesh({ ...options, skirtDepth: Math.max(0.5, size * 0.004) }) : null;
  const surface = morph ?? cellSurfaceMesh({ ...options, skirtDepth: Math.max(2, size * 0.04) });
  // The morph mesh reports its extent with the skirt and at every blend factor.
  let minY = morph ? morph.minY : surface.minY - Math.max(2, size * 0.04);
  let maxY = surface.maxY;
  let minX = 0;
  let minZ = 0;
  let maxX = size;
  let maxZ = size;

  const instances: CellInstances[] = [];
  for (const rule of RULES) {
    if (cell.level < rule.minLevel) continue;
    const g = rule.gridM;
    // Anchors (i·g, j·g) inside the cell [o, o + size). Grids and cell edges are powers of two, so this is exact; a
    // grid coarser than the cell gives most cells no anchor at all.
    const i0 = Math.ceil(ox / g);
    const j0 = Math.ceil(oz / g);
    const data: number[] = [];
    const ids: number[] = [];
    for (let j = j0; j * g < oz + size; j++) {
      for (let i = i0; i * g < ox + size; i++) {
        const r = (k: number): number => unit(hashInts(seed, rule.id, i, j, k));
        const x = (i + 0.1 + 0.8 * r(1)) * g;
        const z = (j + 0.1 + 0.8 * r(2)) * g;
        const h = groundHeight(seed, x, z);
        const p = rule.place(seed, x, z, h, r);
        if (!p) continue;
        if (hooks?.keepObject && !hooks.keepObject(x, z)) continue;
        // Base: the mesh of this level, sunk a little so that a coarse level does not leave it floating.
        const y = Math.min(meshHeightAt(seed, ox, oz, step, x, z, heightHook), Math.max(0, h)) - 0.15 * p[0]!;
        const lx = x - ox;
        const lz = z - oz;
        data.push(lx, y, lz, ...p);
        if (smooth) {
          // Where the same rule puts the base on the coarser level's mesh: its vertices are every second one of this
          // cell, and the cell origin lies on its grid.
          const shift = Math.min(meshHeightAt(seed, ox, oz, step * 2, x, z, heightHook), Math.max(0, h)) - 0.15 * p[0]! - y;
          data.push(shift, cell.level > rule.minLevel ? 1 : 0);
          minY = Math.min(minY, y + shift);
          maxY = Math.max(maxY, y + shift + p[1]!);
        }
        ids.push(hashInts(seed, 0x1d, rule.id, i, j), hashInts(seed, 0x2d, rule.id, i, j));
        const reach = p[0]!;
        minX = Math.min(minX, lx - reach);
        maxX = Math.max(maxX, lx + reach);
        minZ = Math.min(minZ, lz - reach);
        maxZ = Math.max(maxZ, lz + reach);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + p[1]!);
      }
    }
    if (data.length === 0) continue;
    const inst: InstanceData = { layout: smooth ? PROP_MORPH_LAYOUT : PROP_LAYOUT, data: Float32Array.from(data) };
    instances.push({ archetype: rule.name, data: inst, ids: Uint32Array.from(ids) });
  }
  const meshes: CellContent['meshes'] = [{ material: 'terrain', mesh: surface.mesh }];
  for (const m of hooks?.extra ? hooks.extra() : []) {
    meshes.push({ material: m.material, mesh: m.mesh });
    minX = Math.min(minX, m.bounds.min[0]);
    minY = Math.min(minY, m.bounds.min[1]);
    minZ = Math.min(minZ, m.bounds.min[2]);
    maxX = Math.max(maxX, m.bounds.max[0]);
    maxY = Math.max(maxY, m.bounds.max[1]);
    maxZ = Math.max(maxZ, m.bounds.max[2]);
  }
  const bounds: CellContent['bounds'] = { min: [Math.fround(minX), Math.fround(minY), Math.fround(minZ)], max: [Math.fround(maxX), Math.fround(maxY), Math.fround(maxZ)] };
  if (!morph) return { cell, domainVersion: DOMAIN_VERSION, bounds, meshes: [{ material: 'terrain', mesh: surface.mesh }], instances };
  // A cell with any land counts with the full error of its level, whatever it measured. The blend between levels
  // ends where a cell with the full error is split; a cell split later (a smaller measured error) would be replaced by
  // children already in their own shape, a jump of up to the tolerance on the screen. It also makes the instances
  // appear at the same distance on flat ground as on rough ground. Open water is flat at every level, so it keeps its
  // measured error and is split late: nothing can jump there.
  const land = cell.level < LEAF_LEVEL && surface.maxY > 0;
  const error = Math.fround(Math.max(morph.error, land ? size * SMOOTH_SELECTION.errorPerEdge : 0));
  return { cell, domainVersion: hooks?.domainVersion ?? SMOOTH_DOMAIN_VERSION, bounds, meshes, instances, shapeHash: shapeHash(SHAPE), error };
}
