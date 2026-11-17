// Stateless randomness. Every number is a pure function of its key: world seed → subsystem → cell → index.
// Subsystems have their own streams, so changing one subsystem does not move another, and an object has a seed from its own ID.

/** FNV-1a over the characters of a string, the result is an unsigned 32-bit number. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Full avalanche mixing of 32 bits (finalizer from MurmurHash3). */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combines a seed with another integer. */
export function hashInt(seed: number, k: number): number {
  return mix32((seed ^ Math.imul(k | 0, 0x9e3779b1)) + 0x7f4a7c15);
}

/** Combines a seed with any number of integers. The order of keys matters. */
export function hashInts(seed: number, ...keys: number[]): number {
  let h = seed >>> 0;
  for (const k of keys) h = hashInt(h, k);
  return h;
}

/** Seed of one subsystem's stream. */
export function streamSeed(worldSeed: string, subsystem: string): number {
  return hashInt(hashString(worldSeed), hashString(subsystem));
}

/** Number in the range 0 to 1 (excluding 1) from a hash. */
export function unit(h: number): number {
  return (h >>> 0) / 4294967296;
}

/** Number 0 to 1 for a given seed and keys. */
export function rand(seed: number, ...keys: number[]): number {
  return unit(hashInts(seed, ...keys));
}

/** Number in the range lo to hi. */
export function randRange(lo: number, hi: number, seed: number, ...keys: number[]): number {
  return lo + (hi - lo) * rand(seed, ...keys);
}

/** Choice among options with weights according to a number 0–1. */
export function pickWeighted<T>(options: readonly (readonly [T, number])[], r: number): T {
  const total = options.reduce((s, o) => s + o[1], 0);
  let acc = 0;
  for (const [v, w] of options) {
    acc += w / total;
    if (r < acc) return v;
  }
  return options[options.length - 1]![0];
}
