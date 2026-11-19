// Tileable noise volumes for volumetric media: a Perlin-Worley shape volume and a Worley detail volume. The GPU makes
// them (render: `NoiseVolumes`, one fragment shader per layer, from the same integer hash as every other shader);
// this file holds what both sides share: the recipe (cell counts, octave weights, seeds) and the same texel function
// on the CPU, so the volume can be checked without a graphics card.
//
// Every lattice is periodic over the volume, so the volume tiles in all three axes. Cell features come from the
// integer hash: a feature point is 10 bits per axis of one hash word, a gradient one of 12 cube edges; both are exact
// in single and double precision. What follows (distances, fades, sums) is arithmetic that a GPU does in single
// precision and this file in double, so a texel can differ by one step of 8 bits where its value lies on a rounding
// boundary. Nothing else differs.

/** One octave set of a tileable noise: cells across the volume of the first octave, then doubled per octave. */
export interface NoiseVolumeRecipe {
  /** Texels along each edge (a power of two). */
  readonly size: number;
  /** Cells of the cellular (Worley) noise across the volume in its first octave. */
  readonly worleyCells: number;
  /** Cells of the gradient (Perlin) noise across the volume in its first octave; 0 = none (the detail volume). */
  readonly perlinCells: number;
  /** Octaves of the gradient noise (each twice the cells, half the weight). */
  readonly perlinOctaves: number;
  /**
   * The raw Perlin-Worley value that becomes 0 (the shape volume): raw values lie between about 0.56 and 1, so they
   * are stretched from `low` … 1 to 0 … 1 to fill the eight bits. 0 for the detail volume.
   */
  readonly low: number;
}

/** The shape volume: Perlin-Worley, 128³, one channel. */
export const NOISE_VOLUME_SHAPE: NoiseVolumeRecipe = { size: 128, worleyCells: 4, perlinCells: 4, perlinOctaves: 4, low: 0.6 };
/** The detail volume: Worley octaves, 32³, one channel. */
export const NOISE_VOLUME_DETAIL: NoiseVolumeRecipe = { size: 32, worleyCells: 2, perlinCells: 0, perlinOctaves: 0, low: 0 };

/** Weights of three Worley octaves (cells × 1, × 2, × 4) summed into one value. */
export const WORLEY_WEIGHTS: readonly [number, number, number] = [0.625, 0.25, 0.125];

/** Offset of the octave seeds of each noise kind (`octaveSeed(seed, offset + octave)`). */
export const NOISE_SEED_WORLEY = 0;
export const NOISE_SEED_PERLIN = 16;
export const NOISE_SEED_DETAIL = 32;

/**
 * The 12 gradients of the gradient noise: the edges of a cube. The shader repeats the table in the same order
 * (`noiseVolumeGlsl` in render).
 */
export const PERLIN_GRADIENTS: readonly (readonly [number, number, number])[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

// --- The shader's integer hash (`hashU` of the include `noise`), repeated -------------------------------------------

function hashU(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** The hash word of one lattice cell (as `hash3` of the include `noise`, before it is turned into a float). */
function cellHash(x: number, y: number, z: number, seed: number): number {
  const hz = hashU(((z >>> 0) + seed) >>> 0);
  const hy = hashU((Math.imul(y >>> 0, 0xc2b2ae35) ^ hz) >>> 0);
  return hashU((Math.imul(x >>> 0, 0x9e3779b1) ^ hy) >>> 0);
}

/** Seed of octave `k` of a volume made from `seed`. */
export function octaveSeed(seed: number, k: number): number {
  return hashU(((seed >>> 0) + Math.imul(k, 0x68e31da4)) >>> 0);
}

/**
 * Cellular noise at `p` (in cells, 0 … period), periodic over `period` cells: 1 at a feature point, falling to 0 one
 * cell away (one minus the distance to the nearest feature point).
 */
export function worleyTile(px: number, py: number, pz: number, period: number, seed: number): number {
  const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
  const fx = px - cx, fy = py - cy, fz = pz - cz;
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const h = cellHash((cx + dx + period) % period, (cy + dy + period) % period, (cz + dz + period) % period, seed);
        const ex = dx + (h & 1023) / 1024 - fx;
        const ey = dy + ((h >>> 10) & 1023) / 1024 - fy;
        const ez = dz + ((h >>> 20) & 1023) / 1024 - fz;
        const d = ex * ex + ey * ey + ez * ez;
        if (d < best) best = d;
      }
    }
  }
  return 1 - Math.min(Math.sqrt(best), 1);
}

/** Three Worley octaves (cells × 1, × 2, × 4) weighted by `WORLEY_WEIGHTS`, at `u` in volume units (0 … 1). */
export function worleyOctaves(ux: number, uy: number, uz: number, cells: number, seed: number, seedOffset: number): number {
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const c = cells << k;
    sum += WORLEY_WEIGHTS[k]! * worleyTile(ux * c, uy * c, uz * c, c, octaveSeed(seed, seedOffset + k));
  }
  return sum;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradDot(ix: number, iy: number, iz: number, x: number, y: number, z: number, period: number, seed: number): number {
  const g = PERLIN_GRADIENTS[cellHash(ix % period, iy % period, iz % period, seed) % 12]!;
  return g[0] * x + g[1] * y + g[2] * z;
}

/** Gradient noise at `p` (in cells, 0 … period), periodic over `period` cells; about −1 … 1. */
export function perlinTile(px: number, py: number, pz: number, period: number, seed: number): number {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  const x = px - ix, y = py - iy, z = pz - iz;
  const u = fade(x), v = fade(y), w = fade(z);
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  const x0 = mix(gradDot(ix, iy, iz, x, y, z, period, seed), gradDot(ix + 1, iy, iz, x - 1, y, z, period, seed), u);
  const x1 = mix(gradDot(ix, iy + 1, iz, x, y - 1, z, period, seed), gradDot(ix + 1, iy + 1, iz, x - 1, y - 1, z, period, seed), u);
  const x2 = mix(gradDot(ix, iy, iz + 1, x, y, z - 1, period, seed), gradDot(ix + 1, iy, iz + 1, x - 1, y, z - 1, period, seed), u);
  const x3 = mix(gradDot(ix, iy + 1, iz + 1, x, y - 1, z - 1, period, seed), gradDot(ix + 1, iy + 1, iz + 1, x - 1, y - 1, z - 1, period, seed), u);
  return mix(mix(x0, x1, v), mix(x2, x3, v), w);
}

/**
 * The shape volume's value at `u` in volume units (0 … 1, periodic): gradient octaves made billowy by the first
 * Worley octaves (Perlin-Worley), then eroded by the next Worley octaves, stretched from `recipe.low` … 1 to 0–1
 * (median about 0.58).
 */
export function shapeNoiseAt(ux: number, uy: number, uz: number, recipe: NoiseVolumeRecipe, seed: number): number {
  let n = 0;
  let total = 0;
  let amp = 1;
  for (let k = 0; k < recipe.perlinOctaves; k++) {
    const c = recipe.perlinCells << k;
    n += amp * perlinTile(ux * c, uy * c, uz * c, c, octaveSeed(seed, NOISE_SEED_PERLIN + k));
    total += amp;
    amp *= 0.5;
  }
  const perlin = Math.min(Math.max(0.5 + 0.9 * (total > 0 ? n / total : 0), 0), 1);
  const cells = recipe.worleyCells;
  // Worley at cells × 1, × 2, × 4 and × 8: the first three dilate the gradient noise, the last three erode it.
  const w0 = worleyTile(ux * cells, uy * cells, uz * cells, cells, octaveSeed(seed, NOISE_SEED_WORLEY));
  const w1 = worleyTile(ux * cells * 2, uy * cells * 2, uz * cells * 2, cells * 2, octaveSeed(seed, NOISE_SEED_WORLEY + 1));
  const w2 = worleyTile(ux * cells * 4, uy * cells * 4, uz * cells * 4, cells * 4, octaveSeed(seed, NOISE_SEED_WORLEY + 2));
  const w3 = worleyTile(ux * cells * 8, uy * cells * 8, uz * cells * 8, cells * 8, octaveSeed(seed, NOISE_SEED_WORLEY + 3));
  const [a, b, c] = WORLEY_WEIGHTS;
  const dilate = a * w0 + b * w1 + c * w2;
  const erode = a * w1 + b * w2 + c * w3;
  const pw = dilate + perlin * (1 - dilate);
  const raw = (pw + 1 - erode) / (2 - erode);
  return Math.min(Math.max((raw - recipe.low) / (1 - recipe.low), 0), 1);
}

/** The detail volume's value at `u` in volume units (0 … 1, periodic): three Worley octaves. 0–1. */
export function detailNoiseAt(ux: number, uy: number, uz: number, recipe: NoiseVolumeRecipe, seed: number): number {
  return worleyOctaves(ux, uy, uz, recipe.worleyCells, seed, NOISE_SEED_DETAIL);
}

/**
 * A whole volume on the CPU, as the GPU makes it: one byte per texel, x fastest, then y, then z, the value at the
 * texel's centre times 255, rounded. `size` overrides the recipe's edge (a smaller volume of the same noise, for tests).
 */
export function noiseVolumeData(kind: 'shape' | 'detail', seed: number, size?: number): Uint8Array {
  const recipe = kind === 'shape' ? NOISE_VOLUME_SHAPE : NOISE_VOLUME_DETAIL;
  const n = size ?? recipe.size;
  const out = new Uint8Array(n * n * n);
  let i = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const ux = (x + 0.5) / n, uy = (y + 0.5) / n, uz = (z + 0.5) / n;
        const v = kind === 'shape' ? shapeNoiseAt(ux, uy, uz, recipe, seed) : detailNoiseAt(ux, uy, uz, recipe, seed);
        out[i++] = Math.round(v * 255);
      }
    }
  }
  return out;
}
