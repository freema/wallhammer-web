// Named random streams over the engine's stateless hash (`wallhammer-web/gen-core`). No Math.random anywhere in the
// example: every number is a pure function of the world seed, the stream name and the keys asked with.
//
// Two ways to use a stream:
//  - keyed:      `s.float(i, 3)` is the same number whenever it is asked with the same keys, in any order of calls.
//                Prefer this for anything placed in the world (key by the object's index, not by a running counter).
//  - sequential: `s.next()` walks a counter. Handy inside one shape generator, where the order of calls is fixed by code.
// `s.child('name')` gives an independent sub-stream, so adding numbers to one part does not move another.

import { hashInts, hashString, streamSeed, unit } from 'wallhammer-web/gen-core';

export class Stream {
  /** The 32-bit seed of this stream. */
  readonly seed: number;
  private counter = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** A stream for the world seed and a subsystem name: `Stream.of(7, 'inn')`. */
  static of(worldSeed: number | string, name: string): Stream {
    return new Stream(streamSeed(String(worldSeed), name));
  }

  /** An independent sub-stream. */
  child(name: string | number): Stream {
    return new Stream(hashInts(this.seed, typeof name === 'number' ? name : hashString(name)));
  }

  /** 0 ≤ x < 1 from keys. */
  float(...keys: number[]): number {
    return unit(hashInts(this.seed, ...keys));
  }

  /** lo ≤ x < hi from keys. */
  range(lo: number, hi: number, ...keys: number[]): number {
    return lo + (hi - lo) * this.float(...keys);
  }

  /** Integer lo ≤ n ≤ hi from keys. */
  int(lo: number, hi: number, ...keys: number[]): number {
    return lo + Math.min(hi - lo, Math.floor(this.float(...keys) * (hi - lo + 1)));
  }

  /** −1 or +1 from keys. */
  sign(...keys: number[]): number {
    return this.float(...keys) < 0.5 ? -1 : 1;
  }

  /** True with probability p. */
  chance(p: number, ...keys: number[]): boolean {
    return this.float(...keys) < p;
  }

  /** One of the items. */
  pick<T>(items: readonly T[], ...keys: number[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.float(...keys) * items.length))]!;
  }

  /** Symmetric jitter in −amount … +amount. */
  jitter(amount: number, ...keys: number[]): number {
    return (this.float(...keys) * 2 - 1) * amount;
  }

  /** A roughly normal number (sum of three uniforms), mean 0, about unit spread. */
  gauss(...keys: number[]): number {
    return (this.float(...keys, 0) + this.float(...keys, 1) + this.float(...keys, 2) - 1.5) * 2;
  }

  // Sequential forms: the n-th call returns the n-th number of the stream.
  next(): number {
    return unit(hashInts(this.seed, 0x5eed, this.counter++));
  }
  nextRange(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  nextJitter(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }
  nextInt(lo: number, hi: number): number {
    return lo + Math.min(hi - lo, Math.floor(this.next() * (hi - lo + 1)));
  }
  nextPick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))]!;
  }
}
