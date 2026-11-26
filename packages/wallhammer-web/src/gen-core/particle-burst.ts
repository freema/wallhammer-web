// One-shot bursts of particles: the game fires a burst at a place and a time, and its particles fly out once, each on
// a closed-form path (a start point, a velocity, gravity and a share of the wind) that the vertex shader evaluates
// from the burst's time, as the looping particle sources are (`ParticleLayer` in `render`). Every random choice of a
// particle (where in the birth disc, which way, how fast, how long it lives) comes from the burst's seed through
// `hashInt`, so the same bursts give the same numbers bit for bit, whatever the frame rate.
//
// The particles are kept in a ring of fixed capacity, packed as the particle layer's instance records
// (`PARTICLE_FLOATS` floats each, the layout below): a burst that does not fit takes the places of the oldest
// particles. The ring keeps the span changed since the last `clean`, so a layer uploads only what was fired. Nothing
// is allocated after construction.
//
// Record of a particle fired once (the looping sources use the same layout with a phase in place of the time):
//   0–3   birth point x, y, z; the time it is fired
//   4–7   life (s); size at birth and at death (m); upward speed (m/s)
//   8–11  velocity along x and z (m/s); gravity (m/s²); share of the wind
//   12–15 colour and opacity at birth; 16–19 at death
//   20–23 shape (0 soft, 1 core); its seed; gain group; 1 (fired once)

import { hashInt, unit } from './hash.ts';

/** Floats per particle record (`ParticleLayer`'s instance layout). */
export const PARTICLE_FLOATS = 24;

/** Streams of a burst particle's random choices. */
const S_ANGLE = 1;
const S_RADIUS = 2;
const S_DIR = 3;
const S_SPEED = 4;
const S_LIFE = 5;
const S_SEED = 6;

/** A burst fired once. Plain data, read when it is fired. */
export interface ParticleBurst {
  /** Centre of the birth disc, in the coordinates the renderer draws in. */
  position: readonly [number, number, number];
  /** Time it is fired, in the clock the layer is given (`ParticleLayer.burstTime`), seconds. */
  time: number;
  /** Particles. */
  count: number;
  /** Seconds a particle lives (each lives 80 % to 120 % of it). */
  life: number;
  /** Size in metres (quad edge) at birth and at death. */
  size: readonly [number, number];
  /** Upward speed, m/s (each 75 % to 125 % of it). */
  rise: number;
  /** Radius of the birth disc (m) and the outward speed (m/s; each 40 % to 100 % of it, in a direction of its own). */
  spread: readonly [number, number];
  /** Velocity every particle starts with besides its own, m/s (a source that moves, a kick one way). Default none. */
  velocity?: readonly [number, number, number];
  /** Downward acceleration, m/s². Default 0. */
  gravity?: number;
  /** Share of the wind that carries the particle, 0–1. Default 1. */
  wind?: number;
  /** Linear colour and opacity at birth and at death. */
  colorStart: readonly [number, number, number, number];
  colorEnd: readonly [number, number, number, number];
  /** `'soft'` (default): a lit noise puff. `'core'`: a bright core. */
  shape?: 'soft' | 'core';
  /** Gain group 0–3 (default 0), as for the looping sources. */
  group?: number;
  /** `'blend'` (default): alpha over the scene. `'add'`: light added onto it. Read by the layer, which keeps a ring per mode. */
  blend?: 'blend' | 'add';
  /** Seed of the burst's random choices: the same seed gives the same particles. */
  seed: number;
}

/** Particles of fired bursts in a ring of fixed capacity, packed as instance records. */
export class ParticleBurstRing {
  readonly capacity: number;
  /** `PARTICLE_FLOATS` per particle; a renderer uploads it as it is. */
  readonly data: Float32Array;
  /** Particles fired in all. */
  fired = 0;
  /** Bursts fired in all. */
  bursts = 0;
  /** Slots changed since the last `clean`: `dirtyFrom` to `dirtyTo` (exclusive); equal when nothing changed. */
  dirtyFrom = 0;
  dirtyTo = 0;
  /** Latest end (time plus the longest life) of a particle fired, −Infinity before the first. */
  lastEnd = -Infinity;

  constructor(capacity: number) {
    const n = Math.floor(capacity);
    if (!(n >= 1)) throw new Error(`ParticleBurstRing: capacity must be 1 or more, got ${capacity}`);
    this.capacity = n;
    this.data = new Float32Array(n * PARTICLE_FLOATS);
  }

  /** Particles the ring holds now (at most `capacity`, whether alive or not). */
  get count(): number {
    return this.fired < this.capacity ? this.fired : this.capacity;
  }

  /** Fires a burst: writes its particles over the oldest ones. Returns how many it wrote (at most `capacity`). */
  fire(b: ParticleBurst): number {
    const n = Math.min(this.capacity, Math.max(0, Math.floor(b.count)));
    if (n === 0) return 0;
    const d = this.data;
    const seed = b.seed | 0;
    const px = b.position[0], py = b.position[1], pz = b.position[2];
    const vel = b.velocity;
    const vx0 = vel ? vel[0] : 0, vy0 = vel ? vel[1] : 0, vz0 = vel ? vel[2] : 0;
    const radius = b.spread[0], speed = b.spread[1];
    const shape = b.shape === 'core' ? 1 : 0;
    const group = Math.max(0, Math.min(3, Math.floor(b.group ?? 0)));
    const gravity = b.gravity ?? 0;
    const wind = b.wind ?? 1;
    const c0 = b.colorStart, c1 = b.colorEnd;
    let longest = 0;
    for (let i = 0; i < n; i++) {
      const h = hashInt(seed, i);
      const ang = unit(hashInt(h, S_ANGLE)) * 2 * Math.PI;
      const rad = Math.sqrt(unit(hashInt(h, S_RADIUS))) * radius;
      const dir = unit(hashInt(h, S_DIR)) * 2 * Math.PI;
      const r = unit(hashInt(h, S_SPEED));
      const life = b.life * (0.8 + 0.4 * unit(hashInt(h, S_LIFE)));
      const out = speed * (0.4 + 0.6 * r);
      if (life > longest) longest = life;
      const slot = (this.fired + i) % this.capacity;
      const o = slot * PARTICLE_FLOATS;
      d[o] = px + Math.cos(ang) * rad;
      d[o + 1] = py;
      d[o + 2] = pz + Math.sin(ang) * rad;
      d[o + 3] = b.time;
      d[o + 4] = life;
      d[o + 5] = b.size[0];
      d[o + 6] = b.size[1];
      d[o + 7] = vy0 + b.rise * (0.75 + 0.5 * r);
      d[o + 8] = vx0 + Math.cos(dir) * out;
      d[o + 9] = vz0 + Math.sin(dir) * out;
      d[o + 10] = gravity;
      d[o + 11] = wind;
      d[o + 12] = c0[0];
      d[o + 13] = c0[1];
      d[o + 14] = c0[2];
      d[o + 15] = c0[3];
      d[o + 16] = c1[0];
      d[o + 17] = c1[1];
      d[o + 18] = c1[2];
      d[o + 19] = c1[3];
      d[o + 20] = shape;
      // A seed small enough to stay exact in a float, for the shader's own noise (spin, the puff's look).
      d[o + 21] = hashInt(h, S_SEED) & 0xffff;
      d[o + 22] = group;
      d[o + 23] = 1;
    }
    const first = this.fired % this.capacity;
    const end = first + n;
    if (end > this.capacity || this.dirtyFrom !== this.dirtyTo && first !== this.dirtyTo) {
      // Wrapped past the end, or not next to the span already changed: the whole ring.
      this.dirtyFrom = 0;
      this.dirtyTo = this.capacity;
    } else if (this.dirtyFrom === this.dirtyTo) {
      this.dirtyFrom = first;
      this.dirtyTo = end;
    } else this.dirtyTo = end;
    this.fired += n;
    this.bursts++;
    if (b.time + longest > this.lastEnd) this.lastEnd = b.time + longest;
    return n;
  }

  /** Particles alive at `now` (counted over the ring; for statistics and checks). */
  alive(now: number): number {
    let k = 0;
    const d = this.data;
    for (let s = 0; s < this.count; s++) {
      const o = s * PARTICLE_FLOATS;
      const age = now - d[o + 3]!;
      if (age >= 0 && age < d[o + 4]!) k++;
    }
    return k;
  }

  /** Whether any particle may still be alive at `now` (cheap: by the latest end). */
  busy(now: number): boolean {
    return now < this.lastEnd;
  }

  /**
   * Where particle `slot` is at `now` without the wind (the shader adds the wind's drift): the birth point moved by
   * its velocity and gravity. Writes x, y, z into `out` and returns whether it is alive then.
   */
  positionAt(slot: number, now: number, out: Float64Array | number[]): boolean {
    const d = this.data, o = slot * PARTICLE_FLOATS;
    const age = now - d[o + 3]!;
    out[0] = d[o]! + d[o + 8]! * age;
    out[1] = d[o + 1]! + d[o + 7]! * age - 0.5 * d[o + 10]! * age * age;
    out[2] = d[o + 2]! + d[o + 9]! * age;
    return slot < this.count && age >= 0 && age < d[o + 4]!;
  }

  /** Forgets the changed span (a layer calls it after uploading). */
  clean(): void {
    this.dirtyFrom = this.dirtyTo = 0;
  }

  /** Forgets every particle (the whole ring counts as changed). */
  clear(): void {
    this.data.fill(0);
    this.fired = 0;
    this.bursts = 0;
    this.lastEnd = -Infinity;
    this.dirtyFrom = 0;
    this.dirtyTo = this.capacity;
  }
}
