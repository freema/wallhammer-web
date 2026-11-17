// Smooth value noise on the CPU, from the same integer hash as the rest of the generators.
// Used for properties that should change smoothly across groups (hue, variant), not item by item.

import { hashInt, hashInts, unit } from './hash.ts';

/** Noise 0–1 at a point. `cellM` is the blob size in metres. */
export function valueNoise2(x: number, z: number, cellM: number, seed: number): number {
  const gx = x / cellM;
  const gz = z / cellM;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  let tx = gx - i;
  let tz = gz - j;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = unit(hashInts(seed, i, j));
  const b = unit(hashInts(seed, i + 1, j));
  const c = unit(hashInts(seed, i, j + 1));
  const d = unit(hashInts(seed, i + 1, j + 1));
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/**
 * Noise 0–1 at a point in space. `cellM` is the blob size in metres. Sampled at points of a curved surface it has no
 * seam and no pole: the value depends only on the point, not on how the surface is laid out. Built from the integer
 * hash, `Math.floor` and arithmetic, so the same input gives the same bits everywhere.
 */
export function valueNoise3(x: number, y: number, z: number, cellM: number, seed: number): number {
  const gx = x / cellM;
  const gy = y / cellM;
  const gz = z / cellM;
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const k = Math.floor(gz);
  let tx = gx - i;
  let ty = gy - j;
  let tz = gz - k;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  tz = tz * tz * (3 - 2 * tz);
  const a = unit(hashInts(seed, i, j, k));
  const b = unit(hashInts(seed, i + 1, j, k));
  const c = unit(hashInts(seed, i, j + 1, k));
  const d = unit(hashInts(seed, i + 1, j + 1, k));
  const e = unit(hashInts(seed, i, j, k + 1));
  const f = unit(hashInts(seed, i + 1, j, k + 1));
  const g = unit(hashInts(seed, i, j + 1, k + 1));
  const h = unit(hashInts(seed, i + 1, j + 1, k + 1));
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  const ef = e + (f - e) * tx;
  const gh = g + (h - g) * tx;
  const lo = ab + (cd - ab) * ty;
  const hi = ef + (gh - ef) * ty;
  return lo + (hi - lo) * tz;
}

export interface FractalNoise3 {
  /** Blob size of the first octave in metres. */
  cellM: number;
  /** Number of octaves; each is `lacunarity` times finer and `gain` times weaker than the one before. */
  octaves: number;
  /** Default 2. */
  lacunarity?: number;
  /** Default 0.5. */
  gain?: number;
}

/**
 * Sum of octaves of `valueNoise3`, 0–1 (the weights are normalised). Every octave has its own seed and an offset, so
 * the lattices do not line up.
 */
export function fractalNoise3(x: number, y: number, z: number, o: FractalNoise3, seed: number): number {
  const lacunarity = o.lacunarity ?? 2;
  const gain = o.gain ?? 0.5;
  let cell = o.cellM;
  let weight = 1;
  let sum = 0;
  let total = 0;
  for (let k = 0; k < o.octaves; k++) {
    sum += weight * valueNoise3(x + k * 131.7, y + k * 71.3, z + k * 197.1, cell, hashInt(seed, k));
    total += weight;
    cell /= lacunarity;
    weight *= gain;
  }
  return total > 0 ? sum / total : 0;
}
