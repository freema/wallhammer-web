// The natural ground of the rivers example, before any water touches it: one island of 3.2 km with mountains, foothills,
// a low plain and patches of benches with cliffs. A pure function of the seed and a point of the plane (metres, the
// island's middle at 0, 0). It is the same kind of ground the larger examples make from noise, on purpose: noise knows
// nothing about drainage, so it is full of hollows and of slopes no stream would have shaped, and the water has to cope.

import { fractalNoise3, hashInts, valueNoise3 } from 'wallhammer-web/gen-core';

/** Edge of the square the island lies in, metres. */
export const SIZE_M = 3200;
export const HALF_M = SIZE_M / 2;
/** Radius of the island's mean coast, metres. */
const COAST_M = 0.42 * SIZE_M;
/** Height of one bench of the cliff country, metres. */
const BENCH_M = 22;

export const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const stream = (seed: number, i: number): number => hashInts(seed, 0x71e5, i);

/** Noise of sharp crests and broad valleys, 0 to 1. */
function crests(x: number, z: number, cellM: number, octaves: number, seed: number): number {
  let sum = 0;
  let weight = 0;
  let amp = 1;
  let cell = cellM;
  for (let o = 0; o < octaves; o++) {
    const r = 1 - Math.abs(2 * valueNoise3(x, o * 37.5, z, cell, seed + o * 131) - 1);
    sum += amp * r * r;
    weight += amp;
    amp *= 0.5;
    cell /= 2.1;
  }
  return sum / weight;
}

/** Height of the natural ground at a point, metres above the sea. Below 0 is sea floor. */
export function naturalHeight(seed: number, x: number, z: number): number {
  const warp = fractalNoise3(x, 0, z, { cellM: 900, octaves: 3, lacunarity: 2.1, gain: 0.5 }, stream(seed, 1)) - 0.5;
  // 1 on the coast, 0 in the middle.
  const d = (Math.hypot(x, z) / COAST_M) * (1 + 0.5 * warp);
  if (d >= 1) return -45 * smooth(1, 1.3, d) - 0.4;
  const inland = 1 - d;
  // The low country: a plain of one or two per cent with slow swells, which leave shallow hollows.
  const swell = fractalNoise3(x, 0, z, { cellM: 560, octaves: 2, lacunarity: 2.2, gain: 0.5 }, stream(seed, 2)) - 0.5;
  const plain = 2.5 + 13 * Math.pow(inland, 1.1) + 11 * swell * smooth(0.04, 0.25, inland);
  // The mountains: one massif off the island's middle, its outline bent by a slow noise. Crests with valleys between.
  const allow = fractalNoise3(x, 0, z, { cellM: 1000, octaves: 2, lacunarity: 2, gain: 0.5 }, stream(seed, 3));
  const high = smooth(1, 0.2, (Math.hypot(x + 380, z + 300) / 880) * (0.65 + 0.7 * allow)) * smooth(0.04, 0.3, inland);
  const crest = crests(x, z, 460, 4, stream(seed, 4));
  const hills = fractalNoise3(x, 0, z, { cellM: 230, octaves: 3, lacunarity: 2.3, gain: 0.5 }, stream(seed, 5)) - 0.5;
  let h = plain + Math.pow(high, 1.35) * (40 + 250 * crest) + hills * (5 + 40 * high) * smooth(0, 0.14, inland);
  // Benches and cliffs in patches: each step of height is squeezed into a flat and a wall, around its own middle.
  const benches = smooth(0.56, 0.68, valueNoise3(x, 0, z, 420, stream(seed, 6))) * smooth(14, 34, h);
  if (benches > 0) {
    // The steps do not follow the contours all the way round: a slow noise lifts and lowers them, so a ledge climbs,
    // sinks and ends, as beds of rock do, and the country is no stack of rings.
    const lift = h + 26 * (valueNoise3(x, 0, z, 300, stream(seed, 8)) - 0.5);
    const q = lift / BENCH_M;
    const f = q - Math.floor(q);
    h += ((Math.floor(q) + 0.14 * f + 0.86 * smooth(0.4, 0.6, f)) * BENCH_M - lift) * benches;
  }
  // Bumps finer than the plan's grid: what a coarse plan cannot see.
  const bumps = fractalNoise3(x, 0, z, { cellM: 28, octaves: 2, lacunarity: 2.3, gain: 0.5 }, stream(seed, 7)) - 0.5;
  return Math.max(0.3, h + bumps * 2 * smooth(2, 8, h)) * smooth(0, 0.035, inland) + 0.02;
}
