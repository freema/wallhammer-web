// A cycle of steps of several legs, driven by the distance a body travels: where the end of every leg should be in a
// frame, for a reach per leg (`reachTwoBone`, `TwoBoneReach`) to put it there. The body's own motion (its graph, the
// sway of its trunk) stays the game's; this only says where the ends go.
//
// One pass of the cycle is one step of every leg. A pattern is plain data: per leg the phase of the pass at which its
// end is put down, its duty (the share of the pass the end is on the ground), a stride (metres the body travels in one
// pass), a lift and the speed the pattern belongs to. Patterns are blended by speed as `speedWeights` blends motions:
// stride, duty and lift in a line, the phase offsets along the shorter way round the circle. The pass advances by the
// distance travelled over the blended stride, so a planted end never slides: it stays exactly where it was put down,
// also while the body turns, until its leg lifts it. An end is lifted at its turn (from its duty to half way through
// its swing time) and only if the lift leaves at least as many ends down as the blended pattern keeps. A swing goes
// from where the end was lifted (carried along with the body at first, less as it goes) to where it will land (the
// leg's home when its phase comes round, carried forward by the velocity and the turn over half a stance), on an arc
// of the lift height, landing on the ground of `heightAt`, with a smooth start and end. A body that stands (or turns
// on the spot) still runs the cycle, at least at `minRate` passes a second, while any end is in the air or farther
// than `tolerance` from where it would land; an end that is close enough is not lifted, so a still body stands still
// and a stopped one shuffles its ends home one at a time (in the order of the pattern at speed 0). When a planted end
// would be left farther than `reach` from its home before its stance ends (the body slows, turns or changes pattern),
// the cycle hastens so that its turn comes in time.
//
// Not in fixed steps: the pass advances by the mean of the rates at the two ends of a frame, and an end is put down
// where it would land at the moment within the frame its phase came round (the body's path taken straight between two
// frames), so the place of a step does not depend on how the time is cut into frames (a centimetre or two between 30
// and 144 frames a second). Hastening is judged once a frame, so while it acts the phase can drift a little between
// frame rates. A frame longer than an eighth of a pass is cut into parts of at most that. The same inputs give the
// same bits. Everything is in the frame the body is solved in, +y up: on a curved world the chart, unchanged; when the
// chart changes, `rebase` carries the kept points into the new one. Nothing allocates per frame.

import { speedWeights } from './graph.ts';

/** One way of stepping, at one speed. Per-leg arrays are in the order of `StepCycleDesc.homes`. */
export interface StepPattern {
  /** The speed this pattern belongs to, m/s (over the ground, a turn adding its ends' speed). */
  speed: number;
  /** Metres the body travels in one pass (every leg one step). */
  stride: number;
  /** Per leg, the phase of the pass (0–1) at which its end is put down. */
  offsets: readonly number[];
  /** Share of the pass an end is on the ground, 0–1, for every leg or per leg. Below 0.5 for all legs: a flight. */
  duty: number | readonly number[];
  /** Height of an end's arc above the straight line of its swing, metres, for every leg or per leg. */
  lift: number | readonly number[];
}

/** What a `StepCycle` steps with. */
export interface StepCycleDesc {
  /**
   * Per leg the home of its end: where it rests under its hip, in the root's frame (x across, z forward). Only x and
   * z are used: the end stands on the ground there. They are copied into `StepCycle.homes`, which may be changed.
   */
  homes: readonly (readonly [number, number, number])[];
  /** One or more patterns; their speeds need not be sorted. */
  patterns: readonly StepPattern[];
  /** An end within this distance (horizontal, metres) of where it should land is not lifted. Default 0.04. */
  tolerance?: number;
  /** Fewest passes a second while any end has to move or is in the air (a slow or standing body). Default 1. */
  minRate?: number;
  /** Height of a planted end's joint above the ground, metres, for every leg or per leg. Default 0. */
  endHeight?: number | readonly number[];
  /**
   * Farthest a planted end should be left from its home (horizontal, metres): when the body slows, turns or changes
   * pattern so that an end would be left farther before its stance ends, the cycle runs faster (up to three times its
   * rate) so that its turn to lift comes in time. Set it from the legs' length. Default 1.5 × the longest half stance
   * of the patterns (duty × stride / 2) plus the tolerance.
   */
  reach?: number;
  /** A root that moved farther than this between two updates (metres) resets the cycle. Default 4. */
  teleport?: number;
}

const FORMAT = 0x53544350; // a tag that `restore` checks
/** Longest part of a frame, in passes. */
const PART = 0.125;
/** Swings of two legs that overlap by less than this share of a pass do not lower the ends a pattern keeps down. */
const OVERLAP = 0.02;
/** Most a planted end that would be left beyond `reach` speeds the cycle up, times its usual rate. */
const MAX_HASTE = 3;
/** Most parts of a frame; more (a long stall) reset the cycle. */
const MAX_PARTS = 64;
// Header of the state.
const H_FORMAT = 0, H_LEGS = 1, H_PHASE = 2, H_RATE = 3, H_SUPPORT = 4, H_PITCH = 5, H_ROLL = 6, H_STARTED = 7, H_ORIGIN = 8, H_BASE = 11;
const HEADER = 12;

function frac(v: number): number {
  return v - Math.floor(v);
}

/**
 * The fewest ends a pattern of `offsets` and `duty` has on the ground at any phase: the count just after each lift
 * (where it is lowest), an overlap of swings shorter than `OVERLAP` of a pass not counted.
 */
function fewestDown(offsets: ArrayLike<number>, duty: ArrayLike<number>): number {
  const n = offsets.length;
  let fewest = n;
  for (let j = 0; j < n; j++) {
    const at = offsets[j]! + duty[j]! + OVERLAP;
    let c = 0;
    for (let i = 0; i < n; i++) if (frac(at - offsets[i]!) < duty[i]!) c++;
    if (c < fewest) fewest = c;
  }
  return fewest;
}

function perLeg(v: number | readonly number[], n: number, what: string): Float64Array {
  const out = new Float64Array(n);
  if (typeof v === 'number') out.fill(v);
  else {
    if (v.length !== n) throw new Error(`StepCycle: ${what} has ${v.length} values for ${n} legs`);
    out.set(v);
  }
  return out;
}

/**
 * The ends of several legs of one body over a cycle of steps. Per update, per leg: `targets` (where the end should
 * be), `planted` (1 on the ground), `swing` (0–1 through the swing), `landed` (1 when it was put down in this update),
 * `downs` (a count of puts down); and for the whole body `supportHeight`, `pitch`, `roll` (the ground under the ends).
 */
export class StepCycle {
  /** Number of legs. */
  readonly legs: number;
  /** Per leg the home of its end in the root's frame (x, y, z; y unused). May be changed between updates. */
  readonly homes: Float64Array;
  /** The whole state: `save` copies it. */
  readonly data: Float64Array;
  /** Per leg 1 while the end is on the ground, 0 in the air. */
  readonly planted: Float64Array;
  /** Per leg how far through its swing the end is, 0–1 (0 while planted). */
  readonly swing: Float64Array;
  /** Per leg 1 when the end was put down in the last update (cleared by the next): a footfall, for a sound or a mark. */
  readonly landed: Float64Array;
  /** Per leg the number of times the end was put down since `reset`. */
  readonly downs: Float64Array;
  /** Per leg the point the end should be at now, in the solve frame (3 numbers per leg). Feed it to a reach. */
  readonly targets: Float64Array;
  /** Per leg where the end is planted, or while it swings where it was lifted (3 numbers per leg). */
  readonly points: Float64Array;
  /** See `StepCycleDesc`; may be changed between updates. */
  tolerance: number;
  minRate: number;
  reach: number;
  teleport: number;
  private readonly phi: Float64Array;
  private readonly liftAt: Float64Array;
  private readonly prevHome: Float64Array;
  private readonly liftHome: Float64Array;
  private readonly ground: Float64Array;
  private readonly endHeight: Float64Array;
  // Patterns.
  private readonly ranges: [number, number, number][];
  private readonly pSpeed: Float64Array;
  private readonly pStride: Float64Array;
  private readonly pOffsets: Float64Array[];
  private readonly pDuty: Float64Array[];
  private readonly pLift: Float64Array[];
  // Scratch of one update.
  private readonly weights: Float64Array;
  private readonly duty: Float64Array;
  private readonly lift: Float64Array;
  private readonly offsets: Float64Array;
  private readonly homeNow: Float64Array;
  private readonly bytes: Uint8Array;
  private stride = 1;
  private vx = 0;
  private vz = 0;
  private turn = 0;
  private moving = 1;
  private minDown = 0;
  private readonly L = new Float64Array(2);

  constructor(desc: StepCycleDesc) {
    const n = desc.homes.length;
    if (n < 1) throw new Error('StepCycle: needs at least one leg');
    if (desc.patterns.length < 1) throw new Error('StepCycle: needs at least one pattern');
    this.legs = n;
    this.homes = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) this.homes.set(desc.homes[i]!, i * 3);
    this.tolerance = desc.tolerance ?? 0.04;
    this.minRate = desc.minRate ?? 1;
    this.teleport = desc.teleport ?? 4;
    this.endHeight = perLeg(desc.endHeight ?? 0, n, 'endHeight');
    const m = desc.patterns.length;
    this.ranges = [];
    this.pSpeed = new Float64Array(m);
    this.pStride = new Float64Array(m);
    this.pOffsets = [];
    this.pDuty = [];
    this.pLift = [];
    let halfStance = 0;
    for (let k = 0; k < m; k++) {
      const p = desc.patterns[k]!;
      if (!(p.stride > 0)) throw new Error(`StepCycle: pattern ${k} needs a positive stride`);
      if (p.offsets.length !== n) throw new Error(`StepCycle: pattern ${k} has ${p.offsets.length} offsets for ${n} legs`);
      this.ranges.push([p.speed, p.speed, p.speed]);
      this.pSpeed[k] = p.speed;
      this.pStride[k] = p.stride;
      const o = new Float64Array(n);
      for (let i = 0; i < n; i++) o[i] = frac(p.offsets[i]!);
      this.pOffsets.push(o);
      const d = perLeg(p.duty, n, 'duty');
      for (let i = 0; i < n; i++) d[i] = Math.min(0.98, Math.max(0.02, d[i]!));
      this.pDuty.push(d);
      this.pLift.push(perLeg(p.lift, n, 'lift'));
      for (let i = 0; i < n; i++) halfStance = Math.max(halfStance, (d[i]! * p.stride) / 2);
    }
    this.reach = desc.reach ?? 1.5 * halfStance + this.tolerance;
    // State: header, then per-leg blocks.
    this.data = new Float64Array(HEADER + n * 19);
    this.bytes = new Uint8Array(this.data.buffer);
    let at = HEADER;
    const block = (size: number): Float64Array => {
      const v = this.data.subarray(at, at + size);
      at += size;
      return v;
    };
    this.planted = block(n);
    this.swing = block(n);
    this.landed = block(n);
    this.downs = block(n);
    this.phi = block(n);
    this.liftAt = block(n);
    this.ground = block(n);
    this.targets = block(n * 3);
    this.points = block(n * 3);
    this.prevHome = block(n * 3);
    this.liftHome = block(n * 3);
    this.data[H_FORMAT] = FORMAT;
    this.data[H_LEGS] = n;
    this.weights = new Float64Array(m);
    this.duty = new Float64Array(n);
    this.lift = new Float64Array(n);
    this.offsets = new Float64Array(n);
    this.homeNow = new Float64Array(n * 3);
  }

  /** Phase of the pass now, 0–1. */
  get phase(): number {
    return this.data[H_PHASE]!;
  }

  /** Passes a second in the last update. */
  get rate(): number {
    return this.data[H_RATE]!;
  }

  /**
   * Height of the plane through the ground under the ends at the root's origin (least squares; the mean of their
   * heights when fewer than three ends or all in a line). For lowering the body onto uneven ground.
   */
  get supportHeight(): number {
    return this.data[H_SUPPORT]!;
  }

  /** The rise of that plane along the root's +z (its forward), radians: positive when the ground ahead is higher. */
  get pitch(): number {
    return this.data[H_PITCH]!;
  }

  /** The rise of that plane along the root's +x, radians: positive when the ground on the +x side is higher. */
  get roll(): number {
    return this.data[H_ROLL]!;
  }

  /** True after `reset` or the first `update`. */
  get started(): boolean {
    return this.data[H_STARTED] === 1;
  }

  /**
   * Puts every end on the ground at its home under `root` (all planted, phase 0), as after a teleport or for a body
   * that appears. `landed` and `downs` go back to 0.
   */
  reset(root: ArrayLike<number>, heightAt: (x: number, z: number) => number): void {
    const n = this.legs;
    const d = this.data;
    this.blend(0);
    this.homesOf(root);
    d[H_PHASE] = 0;
    d[H_RATE] = 0;
    d[H_BASE] = 0;
    d[H_STARTED] = 1;
    d[H_ORIGIN] = root[9]!;
    d[H_ORIGIN + 1] = root[10]!;
    d[H_ORIGIN + 2] = root[11]!;
    for (let i = 0; i < n; i++) {
      const x = this.homeNow[i * 3]!, z = this.homeNow[i * 3 + 2]!;
      const g = heightAt(x, z);
      this.planted[i] = 1;
      this.swing[i] = 0;
      this.landed[i] = 0;
      this.downs[i] = 0;
      this.phi[i] = frac(-this.offsets[i]!);
      this.liftAt[i] = 0;
      this.ground[i] = g;
      this.points[i * 3] = x;
      this.points[i * 3 + 1] = g + this.endHeight[i]!;
      this.points[i * 3 + 2] = z;
      this.targets.set(this.points.subarray(i * 3, i * 3 + 3), i * 3);
      this.prevHome.set(this.homeNow.subarray(i * 3, i * 3 + 3), i * 3);
    }
    this.support(root);
  }

  /**
   * Advances the cycle by `dt` seconds and writes the outputs. `root`: the body's root now (3 × 4, the solve frame);
   * `vx`, `vz`: its velocity over the ground, m/s; `turn`: its turn rate about +y, rad/s (the rate of `yaw` in a root
   * `[cos, 0, −sin, 0, 1, 0, sin, 0, cos, …]`); `heightAt`: the ground's height at a point. The first call resets.
   */
  update(dt: number, root: ArrayLike<number>, vx: number, vz: number, turn: number, heightAt: (x: number, z: number) => number): void {
    const n = this.legs;
    const d = this.data;
    if (d[H_STARTED] !== 1) this.reset(root, heightAt);
    const ox = root[9]!, oz = root[11]!;
    const moved = Math.hypot(ox - d[H_ORIGIN]!, oz - d[H_ORIGIN + 2]!);
    if (!(moved <= this.teleport) || !(dt >= 0) || !Number.isFinite(vx + vz + turn)) {
      this.reset(root, heightAt);
      return;
    }
    this.landed.fill(0);
    this.homesOf(root);
    const home = this.homeNow;
    // Speed of the ends: the body's over the ground and the turn's at the mean reach of the homes.
    let span = 0;
    for (let i = 0; i < n; i++) span += Math.hypot(home[i * 3]! - ox, home[i * 3 + 2]! - oz);
    span /= n;
    const speed = Math.hypot(vx, vz) + Math.abs(turn) * span;
    this.blend(speed);
    const nominal = speed / this.stride;
    const moving = Math.max(nominal, this.minRate);
    this.vx = vx;
    this.vz = vz;
    this.turn = turn;
    this.moving = moving;
    // Busy: an end in the air, or one farther than the tolerance from where it should land.
    let busy = false;
    let down = 0;
    for (let i = 0; i < n; i++) {
      if (this.planted[i] !== 1) busy = true;
      else {
        down++;
        if (!busy) {
          this.predict(i, 1, ox, oz, 0);
          if (Math.hypot(this.points[i * 3]! - this.L[0]!, this.points[i * 3 + 2]! - this.L[1]!) > this.tolerance) busy = true;
        }
      }
    }
    const base = busy ? moving : nominal;
    // The pass advances by the mean of the usual rates at the two ends of the frame (exact for a steady change of
    // speed), or faster when a planted end would otherwise be left farther than `reach` from its home before its
    // stance ends: at the rate at which its stance ends just as it gets there (at most `MAX_HASTE` times the usual).
    let haste = 0;
    if (this.reach < Infinity) {
      // Aimed a tenth inside `reach`: the rate is judged once a frame, and an end may go a little past its aim.
      const R = 0.9 * this.reach;
      for (let i = 0; i < n; i++) {
        if (this.planted[i] !== 1) continue;
        const left = this.duty[i]! - this.phi[i]!;
        if (!(left > 0)) continue;
        // The end relative to its home, and the home's velocity (the body's and the turn's).
        const px = this.points[i * 3]! - home[i * 3]!, pz = this.points[i * 3 + 2]! - home[i * 3 + 2]!;
        const ux = vx + turn * (home[i * 3 + 2]! - oz), uz = vz - turn * (home[i * 3]! - ox);
        const uu = ux * ux + uz * uz;
        if (uu < 1e-12) continue;
        const pu = px * ux + pz * uz;
        const pp = px * px + pz * pz;
        const disc = pu * pu - uu * (pp - R * R);
        // Seconds from now until it is `reach` away; the stance left is counted from the last update, `dt` before.
        const t = (pp >= R * R || disc <= 0 ? 0 : (pu + Math.sqrt(disc)) / uu) + dt;
        const need = t > 0 ? left / t : Infinity;
        if (need > haste) haste = need;
      }
      if (haste > MAX_HASTE * moving) haste = MAX_HASTE * moving;
    }
    let dP = 0.5 * (d[H_BASE]! + base) * dt;
    d[H_BASE] = base;
    if (haste * dt > dP) dP = haste * dt;
    d[H_RATE] = dt > 0 ? dP / dt : base;
    const parts = Math.max(1, Math.ceil(dP / PART));
    if (parts > MAX_PARTS) {
      this.reset(root, heightAt);
      return;
    }
    const step = dP / parts;
    let phase = d[H_PHASE]!;
    for (let s = 1; s <= parts; s++) {
      const t0 = (s - 1) / parts, t1 = s / parts;
      phase = frac(phase + step);
      for (let i = 0; i < n; i++) {
        const duty = this.duty[i]!;
        const was = this.phi[i]!;
        const now = frac(phase - this.offsets[i]!);
        const wrapped = now - was < -0.5;
        if (this.planted[i] === 1) {
          if (!wrapped && down - 1 >= this.minDown && now >= duty && now < duty + 0.5 * (1 - duty)) {
            // Its turn: lifted when it is farther than the tolerance from where it would land.
            let from = -1;
            this.predict(i, t1, ox, oz, 0);
            if (Math.hypot(this.points[i * 3]! - this.L[0]!, this.points[i * 3 + 2]! - this.L[1]!) > this.tolerance) from = was < duty && was <= now ? duty : now;
            if (from >= 0) {
              this.planted[i] = 0;
              this.liftAt[i] = from;
              this.swing[i] = from < 1 ? (now - from) / (1 - from) : 1;
              this.liftHome[i * 3] = this.prevHome[i * 3]! + (home[i * 3]! - this.prevHome[i * 3]!) * t1;
              this.liftHome[i * 3 + 2] = this.prevHome[i * 3 + 2]! + (home[i * 3 + 2]! - this.prevHome[i * 3 + 2]!) * t1;
              down--;
            }
          }
        } else if (wrapped) {
          // Put down where it lands when its phase comes round, at that moment of the frame.
          const f = (1 - was) / (now + 1 - was);
          this.predict(i, t0 + f * (t1 - t0), ox, oz, 0);
          const x = this.L[0]!, z = this.L[1]!;
          const g = heightAt(x, z);
          this.points[i * 3] = x;
          this.points[i * 3 + 1] = g + this.endHeight[i]!;
          this.points[i * 3 + 2] = z;
          this.ground[i] = g;
          this.planted[i] = 1;
          this.swing[i] = 0;
          this.landed[i] = 1;
          this.downs[i] = this.downs[i]! + 1;
          down++;
        } else {
          const from = this.liftAt[i]!;
          const p = from < 1 ? (now - from) / (1 - from) : 1;
          const prev = this.swing[i]!;
          this.swing[i] = p < prev ? prev : p > 1 ? 1 : p;
        }
        this.phi[i] = now;
      }
    }
    d[H_PHASE] = phase;
    // Targets: a planted end where it is; a swing from where it was lifted (carried along with the body, less as it
    // goes) to where it will land, on an arc.
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (this.planted[i] === 1) {
        this.targets[o] = this.points[o]!;
        this.targets[o + 1] = this.points[o + 1]!;
        this.targets[o + 2] = this.points[o + 2]!;
        continue;
      }
      this.predict(i, 1, ox, oz, (1 - this.phi[i]!) / moving);
      const s = this.swing[i]!;
      const e = s * s * (3 - 2 * s);
      const sx = this.points[o]! + (home[o]! - this.liftHome[o]!) * (1 - e);
      const sz = this.points[o + 2]! + (home[o + 2]! - this.liftHome[o + 2]!) * (1 - e);
      const sy = this.points[o + 1]!;
      const lx = this.L[0]!, lz = this.L[1]!;
      const x = sx + (lx - sx) * e, z = sz + (lz - sz) * e;
      const eh = this.endHeight[i]!;
      const ly = heightAt(lx, lz) + eh;
      const under = heightAt(x, z);
      const line = sy + (ly - sy) * e;
      const base = line > under + eh ? line : under + eh;
      this.ground[i] = under;
      this.targets[o] = x;
      this.targets[o + 1] = base + this.lift[i]! * Math.sin(Math.PI * s);
      this.targets[o + 2] = z;
    }
    this.prevHome.set(home);
    d[H_ORIGIN] = ox;
    d[H_ORIGIN + 1] = root[10]!;
    d[H_ORIGIN + 2] = oz;
    this.support(root);
  }

  /**
   * Carries every point the cycle keeps (planted ends, swing starts, targets, the last root) by the rigid 3 × 4
   * transform `m`: for a solve frame that changed under the body (a new chart of a curved world), `m` taking the old
   * frame's points to the new frame's near the body.
   */
  rebase(m: ArrayLike<number>): void {
    const move = (a: Float64Array, o: number): void => {
      const x = a[o]!, y = a[o + 1]!, z = a[o + 2]!;
      a[o] = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
      a[o + 1] = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
      a[o + 2] = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
    };
    for (let i = 0; i < this.legs; i++) {
      move(this.points, i * 3);
      move(this.targets, i * 3);
      move(this.prevHome, i * 3);
      move(this.liftHome, i * 3);
    }
    move(this.data, H_ORIGIN);
  }

  /** Bytes of the state (a copy, or written into `out` at `offset`). */
  save(out?: Uint8Array, offset = 0): Uint8Array {
    if (!out) return this.bytes.slice();
    out.set(this.bytes, offset);
    return out;
  }

  /** Brings back a state saved by `save` of a cycle with the same number of legs. */
  restore(bytes: Uint8Array, offset = 0): void {
    if (bytes.length - offset < this.bytes.length) throw new Error('StepCycle.restore: too few bytes');
    const v = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
    if (v.getFloat64(0, true) !== FORMAT || v.getFloat64(8, true) !== this.legs) throw new Error('StepCycle.restore: not a step cycle state of this many legs');
    this.bytes.set(bytes.subarray(offset, offset + this.bytes.length));
  }

  /** Bytes `save` writes. */
  get byteLength(): number {
    return this.bytes.length;
  }

  /** Blends the patterns at `speed` into stride, duty, lift and offsets. */
  private blend(speed: number): void {
    const n = this.legs;
    const m = this.pSpeed.length;
    const w = this.weights;
    speedWeights(this.ranges, speed, w);
    // The first pattern with a weight is the base; offsets of the others turn from it along the shorter way.
    let base = -1;
    for (let k = 0; k < m; k++) if (w[k]! > 0 && (base < 0 || this.pSpeed[k]! < this.pSpeed[base]!)) base = k;
    if (base < 0) base = 0;
    let stride = 0;
    this.duty.fill(0);
    this.lift.fill(0);
    this.offsets.set(this.pOffsets[base]!);

    for (let k = 0; k < m; k++) {
      const wk = w[k]!;
      if (!(wk > 0)) continue;
      stride += wk * this.pStride[k]!;
      const dk = this.pDuty[k]!, lk = this.pLift[k]!, ok = this.pOffsets[k]!, ob = this.pOffsets[base]!;
      for (let i = 0; i < n; i++) {
        this.duty[i] = this.duty[i]! + wk * dk[i]!;
        this.lift[i] = this.lift[i]! + wk * lk[i]!;
        if (k !== base) {
          let dd = ok[i]! - ob[i]!;
          dd -= Math.round(dd);
          this.offsets[i] = this.offsets[i]! + wk * dd;
        }
      }
    }
    for (let i = 0; i < n; i++) this.offsets[i] = frac(this.offsets[i]!);
    this.stride = stride > 0 ? stride : this.pStride[base]!;
    this.minDown = fewestDown(this.offsets, this.duty);
  }

  /** Every leg's home in the solve frame under `root`, into `homeNow`. */
  private homesOf(root: ArrayLike<number>): void {
    const h = this.homes, o = this.homeNow;
    for (let i = 0; i < this.legs; i++) {
      const x = h[i * 3]!, z = h[i * 3 + 2]!;
      o[i * 3] = root[0]! * x + root[6]! * z + root[9]!;
      o[i * 3 + 1] = root[1]! * x + root[7]! * z + root[10]!;
      o[i * 3 + 2] = root[2]! * x + root[8]! * z + root[11]!;
    }
  }

  /**
   * Where leg `i` lands if it lands at share `t` of this update (0: at the last update, 1: now) and `ahead` seconds
   * later: its home and the root's origin taken in a line between the two updates, turned about the origin by the turn
   * and moved by the velocity over half a stance and `ahead`. Into `L` (x, z).
   */
  private predict(i: number, t: number, ox: number, oz: number, ahead: number): void {
    const d = this.data;
    const hx = this.prevHome[i * 3]! + (this.homeNow[i * 3]! - this.prevHome[i * 3]!) * t;
    const hz = this.prevHome[i * 3 + 2]! + (this.homeNow[i * 3 + 2]! - this.prevHome[i * 3 + 2]!) * t;
    const cx = d[H_ORIGIN]! + (ox - d[H_ORIGIN]!) * t;
    const cz = d[H_ORIGIN + 2]! + (oz - d[H_ORIGIN + 2]!) * t;
    const time = this.duty[i]! / (2 * this.moving) + ahead;
    const a = this.turn * time;
    const c = Math.cos(a), s = Math.sin(a);
    const dx = hx - cx, dz = hz - cz;
    this.L[0] = cx + c * dx + s * dz + this.vx * time;
    this.L[1] = cz - s * dx + c * dz + this.vz * time;
  }

  /** The plane through the ground under the ends, in the root's frame: `supportHeight`, `pitch`, `roll`. */
  private support(root: ArrayLike<number>): void {
    const n = this.legs;
    const d = this.data;
    const ox = root[9]!, oz = root[11]!;
    let ax = root[0]!, az = root[2]!;
    let la = Math.hypot(ax, az) || 1;
    ax /= la;
    az /= la;
    let fx = root[6]!, fz = root[8]!;
    la = Math.hypot(fx, fz) || 1;
    fx /= la;
    fz /= la;
    let mu = 0, mw = 0, mg = 0;
    for (let i = 0; i < n; i++) {
      const g = this.planted[i] === 1 ? this.points[i * 3 + 1]! - this.endHeight[i]! : this.ground[i]!;
      const dx = this.targets[i * 3]! - ox, dz = this.targets[i * 3 + 2]! - oz;
      mu += dx * ax + dz * az;
      mw += dx * fx + dz * fz;
      mg += g;
    }
    mu /= n;
    mw /= n;
    mg /= n;
    let suu = 0, sww = 0, suw = 0, sug = 0, swg = 0;
    for (let i = 0; i < n; i++) {
      const g = (this.planted[i] === 1 ? this.points[i * 3 + 1]! - this.endHeight[i]! : this.ground[i]!) - mg;
      const dx = this.targets[i * 3]! - ox, dz = this.targets[i * 3 + 2]! - oz;
      const u = dx * ax + dz * az - mu, w = dx * fx + dz * fz - mw;
      suu += u * u;
      sww += w * w;
      suw += u * w;
      sug += u * g;
      swg += w * g;
    }
    const det = suu * sww - suw * suw;
    let b = 0, c = 0;
    if (n >= 3 && det > 1e-9 * (suu + sww) * (suu + sww) && det > 1e-12) {
      b = (sug * sww - swg * suw) / det;
      c = (swg * suu - sug * suw) / det;
    }
    d[H_SUPPORT] = mg - b * mu - c * mw;
    d[H_PITCH] = Math.atan(c);
    d[H_ROLL] = Math.atan(b);
  }
}
