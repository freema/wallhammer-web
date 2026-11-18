// Seeded randomness for placement: a named stream of the world seed, read by integer keys (an item index, a cell), so
// a result does not depend on the order things are generated in. Thin over the engine's hash (gen-core).

import { rand, streamSeed } from 'wallhammer-web/gen-core';

export class Stream {
  readonly seed: number;

  constructor(worldSeed: number | string, name: string) {
    this.seed = streamSeed(String(worldSeed), name);
  }

  /** 0–1 for the keys. */
  at(...keys: number[]): number {
    return rand(this.seed, ...keys);
  }

  /** lo–hi for the keys. */
  range(lo: number, hi: number, ...keys: number[]): number {
    return lo + (hi - lo) * rand(this.seed, ...keys);
  }

  /** An integer lo..hi (both included). */
  int(lo: number, hi: number, ...keys: number[]): number {
    return Math.min(hi, lo + Math.floor((hi - lo + 1) * rand(this.seed, ...keys)));
  }

  /** −1..1. */
  signed(...keys: number[]): number {
    return rand(this.seed, ...keys) * 2 - 1;
  }
}
