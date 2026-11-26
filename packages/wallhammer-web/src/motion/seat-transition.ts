// Getting onto a seat on another body and off it again, as a timeline: the carried body walks to a place beside the
// carrier (the approach), climbs onto the seat (attach), is held there, and climbs off to a place beside the carrier
// (release). The timeline owns a `SocketSeat` and its weight, and gives the carried body's free root while it moves:
// on the approach a smooth walk from where it started to the place it climbs from (which may move with the carrier),
// then that place raised toward the seat's height by a share of the way (an arc, so a root that blends straight from
// the ground to the seat does not pass through the carrier), on the way off the place it gets off at, lowered again.
// Every number (the approach's seconds, each phase's length, when the weight moves and for how long, the rise and when
// it happens) is the caller's; cues of its own (a hand that takes hold, a cover that opens) are read as times of the
// timeline (`passed`, `crossed`).
//
// The rule of getting off: the body's own free root (its walker) is put where it will stand at the moment the release
// starts, never at the end, so whatever blends from the seat toward the free root (the root, the camera's point) moves
// toward that place and never back to where the body got on. `releaseToWalker` in `world` does both in one call.
//
// Time is given by `advance(dt)` (a fixed step or a frame); reads take `a`, the share of the way from the last advance's
// start to its end, so a timeline advanced in fixed steps is read between them. Pure state, nothing allocates; the same
// calls give the same numbers. `save` and `restore` keep it (as for `MotionGraph`).

import { SocketSeat } from './seat.ts';
import type { Socket } from './socket.ts';

/** One way of the timeline: getting on (after the approach) or getting off. Seconds count from the phase's start. */
export interface SeatTransitionPhase {
  /** Seconds of the phase: getting on, from the end of the approach until the body is held; getting off, until it is free. */
  seconds: number;
  /** When the seat's weight starts to move (0 to 1 on, 1 to 0 off), eased. Default 0. */
  weightFrom?: number;
  /** How long the weight takes to move. Default the rest of the phase. */
  weightSeconds?: number;
  /** Share 0–1 of the way from the free place's height to the seat's height the free root rises by. Default 0. */
  rise?: number;
  /** When the rise moves (getting on it grows to `rise`, getting off it falls from `rise` to 0), eased. Default 0. */
  riseFrom?: number;
  /** When it has moved. Default the end of the weight's move. */
  riseTo?: number;
}

export interface SeatTransitionOptions {
  /** Getting on, after the approach. */
  attach: SeatTransitionPhase;
  /** Getting off. */
  release: SeatTransitionPhase;
  /** Share of the socket's tilt the carried root takes (`SocketSeatOptions.tilt`). Default 1. */
  tilt?: number;
}

/** Where the timeline is: `free` on its own, `approach` walking to the carrier, `attach` getting on, `held` on the seat, `release` getting off. */
export type SeatPhase = 'free' | 'approach' | 'attach' | 'held' | 'release';

/** Bytes of a `SeatTransition`'s state (`save`, `byteLength`). */
export const SEAT_TRANSITION_STATE_BYTES = 88;

const FREE = 0, ATTACHING = 1, HELD = 2, RELEASING = 3;
const PHASES: readonly SeatPhase[] = ['free', 'approach', 'attach', 'held', 'release'];
const STATE_VERSION = 1;
const TWO_PI = 2 * Math.PI;

/** A phase with its defaults filled in. */
interface Phase {
  seconds: number;
  weightFrom: number;
  weightSeconds: number;
  rise: number;
  riseFrom: number;
  riseTo: number;
}

function phaseOf(p: SeatTransitionPhase, name: string): Phase {
  const seconds = p.seconds;
  if (!(seconds >= 0)) throw new Error(`SeatTransition: ${name}.seconds must not be negative`);
  const weightFrom = p.weightFrom ?? 0;
  const weightSeconds = p.weightSeconds ?? Math.max(0, seconds - weightFrom);
  const riseFrom = p.riseFrom ?? 0;
  return { seconds, weightFrom, weightSeconds, rise: p.rise ?? 0, riseFrom, riseTo: p.riseTo ?? weightFrom + weightSeconds };
}

/** Smoothstep of `t` over the span [from, from + seconds]; a span of no length is a step at `from`. */
function ease(t: number, from: number, seconds: number): number {
  if (!(seconds > 0)) return t >= from ? 1 : 0;
  const x = (t - from) / seconds;
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
}

/**
 * A root at (x, y, z) standing upright along +y, its +z turned to the heading `yaw` (radians about +y; yaw 0 faces −z,
 * as a `Walker`'s), every axis scaled by `scale`, into `out` (3 × 4). The root of a body whose skeleton faces +z.
 */
export function headingRoot<T extends Float32Array | Float64Array>(x: number, y: number, z: number, yaw: number, scale: number, out: T): T {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[0] = -c * scale;
  out[1] = 0;
  out[2] = s * scale;
  out[3] = 0;
  out[4] = scale;
  out[5] = 0;
  out[6] = -s * scale;
  out[7] = 0;
  out[8] = -c * scale;
  out[9] = x;
  out[10] = y;
  out[11] = z;
  return out;
}

/** The timeline of a body getting onto a seat of another, being held there and getting off. */
export class SeatTransition {
  /** The seat: its weight is the timeline's (set at every `advance` and `write`). */
  readonly seat: SocketSeat;
  /** Where the body stood and its heading when it began to get on: x, y, z, yaw. */
  readonly from = new Float64Array(4);
  private readonly on: Phase;
  private readonly off: Phase;
  private mode = FREE;
  /** Seconds since getting on or off began (the approach included), after and before the last advance. */
  private t = 0;
  private t0 = 0;
  /** Lower end of the span the last advance crossed (−Infinity for the first advance after a start, so a cue at 0 fires). */
  private crossFrom = 0;
  /** True from a start until the first advance. */
  private fresh = false;
  private approach = 0;
  private before = 0;
  private readonly f = new Float64Array(SEAT_TRANSITION_STATE_BYTES / 8);
  private readonly bytes = new Uint8Array(this.f.buffer);

  constructor(o: SeatTransitionOptions) {
    this.on = phaseOf(o.attach, 'attach');
    this.off = phaseOf(o.release, 'release');
    this.seat = new SocketSeat({ tilt: o.tilt ?? 1 });
  }

  /** Where the timeline is now. */
  get phase(): SeatPhase {
    return PHASES[this.code()]!;
  }

  private code(): number {
    if (this.mode === ATTACHING) return this.t < this.approach ? 1 : 2;
    return this.mode === HELD ? 3 : this.mode === RELEASING ? 4 : 0;
  }

  /** True while the body gets on or off (the approach included). */
  get moving(): boolean {
    return this.mode === ATTACHING || this.mode === RELEASING;
  }

  /** True while the body gets on (the approach included), and in the advance that brought it onto the seat. */
  get gettingOn(): boolean {
    return this.mode === ATTACHING || (this.mode === HELD && (this.before === 1 || this.before === 2));
  }

  /** True while the body gets off, and in the advance that set it free. */
  get gettingOff(): boolean {
    return this.mode === RELEASING || (this.mode === FREE && this.before === 4);
  }

  /** Seconds since getting on or off began, the approach included (after the last advance). */
  get elapsed(): number {
    return this.t;
  }

  /** Seconds of the approach of the getting on now (or last). */
  get approachSeconds(): number {
    return this.approach;
  }

  /** Seconds from the start of getting on until the body is held: the approach and the attach phase. */
  get attachSeconds(): number {
    return this.approach + this.on.seconds;
  }

  /** Seconds of getting off. */
  get releaseSeconds(): number {
    return this.off.seconds;
  }

  /** The time of the timeline at `a` of the way through the last advance. */
  time(a = 1): number {
    return this.t0 + (this.t - this.t0) * a;
  }

  /** Whether the timeline has reached `t` seconds of the getting on or off now (at `a` of the last advance). */
  passed(t: number, a = 1): boolean {
    return this.moving && this.time(a) >= t;
  }

  /** Whether the last advance crossed `t` seconds of the getting on or off (a cue that fires once). */
  crossed(t: number): boolean {
    return this.crossFrom < t && t <= this.t;
  }

  /** Whether the last advance (or start) brought the timeline into `phase`. */
  became(phase: SeatPhase): boolean {
    const c = this.code();
    return c !== this.before && PHASES[c] === phase;
  }

  /**
   * Begins getting on: the body stands at (x, y, z) with heading `yaw` and walks to the place it climbs from over
   * `approachSeconds` (0: it climbs from where it stands). Ignored unless free.
   */
  attach(x: number, y: number, z: number, yaw: number, approachSeconds: number): boolean {
    if (this.mode !== FREE) return false;
    const f = this.from;
    f[0] = x;
    f[1] = y;
    f[2] = z;
    f[3] = yaw;
    this.approach = approachSeconds > 0 ? approachSeconds : 0;
    this.start(ATTACHING);
    return true;
  }

  /** On the seat at once (a script's fixed scene). */
  attachNow(): void {
    this.start(HELD);
  }

  /**
   * Begins getting off. Put the body's own free root (its walker) where it will stand now, not at the end
   * (`releaseToWalker` in `world` does both). Ignored unless held.
   */
  release(): boolean {
    if (this.mode !== HELD) return false;
    this.start(RELEASING);
    return true;
  }

  /** Free at once (a script's fixed scene, or a game that ends the carrying). */
  releaseNow(): void {
    this.start(FREE);
  }

  private start(mode: number): void {
    this.mode = mode;
    this.t = 0;
    this.t0 = 0;
    this.crossFrom = 0;
    this.fresh = mode === ATTACHING || mode === RELEASING;
    this.before = this.code();
    this.seat.fade.set(this.weight());
  }

  /** Advances the timeline by `dt` seconds (a fixed step or a frame). */
  advance(dt: number): void {
    this.before = this.code();
    this.t0 = this.t;
    if (!(dt > 0)) {
      this.crossFrom = this.t;
      return;
    }
    if (this.mode === ATTACHING || this.mode === RELEASING) {
      this.crossFrom = this.fresh ? -Infinity : this.t;
      this.fresh = false;
      this.t += dt;
      if (this.mode === ATTACHING && this.t >= this.approach + this.on.seconds) this.mode = HELD;
      else if (this.mode === RELEASING && this.t >= this.off.seconds) this.mode = FREE;
    } else this.crossFrom = this.t;
    this.seat.fade.set(this.weight());
  }

  /** The seat's weight at `a` of the last advance: 0 on the free root, 1 on the seat. */
  weight(a = 1): number {
    if (this.mode === HELD) return 1;
    if (this.mode === FREE) return 0;
    if (this.mode === ATTACHING) return ease(this.time(a) - this.approach, this.on.weightFrom, this.on.weightSeconds);
    return 1 - ease(this.time(a), this.off.weightFrom, this.off.weightSeconds);
  }

  /** The whole way eased, 0 free to 1 held (from the start of the approach; getting off back to 0): for a camera. */
  progress(a = 1): number {
    if (this.mode === HELD) return 1;
    if (this.mode === FREE) return 0;
    if (this.mode === ATTACHING) return ease(this.time(a), 0, this.approach + this.on.seconds);
    return 1 - ease(this.time(a), 0, this.off.seconds);
  }

  /** Share of the approach walked, 0–1 (1 once it is over; 0 while free or getting off). */
  approachShare(a = 1): number {
    if (this.mode === HELD) return 1;
    if (this.mode !== ATTACHING) return 0;
    return ease(this.time(a), 0, this.approach);
  }

  /** Metres of an approach `length` m long walked in the last advance (for the body's own gait while it walks). */
  approachMoved(length: number): number {
    if (this.mode !== ATTACHING && this.mode !== HELD) return 0;
    if (this.t0 >= this.approach) return 0;
    return (ease(this.t, 0, this.approach) - ease(this.t0, 0, this.approach)) * length;
  }

  /** Share of the way from the free place's height to the seat's height the free root is raised by now. */
  rise(a = 1): number {
    if (this.mode === FREE) return 0;
    const t = this.time(a);
    if (this.mode === ATTACHING) {
      const p = this.on;
      return p.rise * ease(t - this.approach, p.riseFrom, p.riseTo - p.riseFrom);
    }
    const p = this.off;
    if (this.mode === HELD) return p.rise;
    return p.rise * (1 - ease(t, p.riseFrom, p.riseTo - p.riseFrom));
  }

  /**
   * The carried body's free place at `a` of the last advance, x, y, z and heading into `out`: `stand` (x, y, z, yaw)
   * is where the body stands beside the carrier now (getting on, the place it climbs from; getting off, the place it
   * gets off at; free, its own place), `seatY` the seat's height. On the approach it walks from `from` to `stand`; then
   * it stands at `stand` raised toward `seatY` by `rise`. Returns `out`.
   */
  place(stand: ArrayLike<number>, seatY: number, out: { [i: number]: number }, a = 1): { [i: number]: number } {
    let x = stand[0]!, y = stand[1]!, z = stand[2]!, yaw = stand[3]!;
    if (this.mode === ATTACHING) {
      const k = this.approachShare(a);
      const f = this.from;
      x = f[0]! + (x - f[0]!) * k;
      y = f[1]! + (y - f[1]!) * k;
      z = f[2]! + (z - f[2]!) * k;
      let d = yaw - f[3]!;
      d -= Math.round(d / TWO_PI) * TWO_PI;
      yaw = f[3]! + d * k;
    }
    out[0] = x;
    out[1] = y + (seatY - y) * this.rise(a);
    out[2] = z;
    out[3] = yaw;
    return out;
  }

  /**
   * The carried body's root (3 × 4) into `out` at `a` of the last advance: `freeRoot` blended with the socket of the
   * carrier (`carrierWorld`, its solved bones) by the weight (`SocketSeat.write`). `out` may be `freeRoot`.
   */
  write<T extends Float32Array | Float64Array>(freeRoot: ArrayLike<number>, carrierWorld: ArrayLike<number>, socket: Socket, out: T, a = 1): T {
    this.seat.fade.set(this.weight(a));
    return this.seat.write(freeRoot, carrierWorld, socket, out);
  }

  /** Bytes of the state (a copy, or written into `out` at `offset`; `SEAT_TRANSITION_STATE_BYTES` of them). */
  save(out?: Uint8Array, offset = 0): Uint8Array {
    const f = this.f;
    f[0] = STATE_VERSION;
    f[1] = this.mode;
    f[2] = this.t;
    f[3] = this.t0;
    f[4] = this.crossFrom;
    f[5] = this.approach;
    f[6] = this.from[0]!;
    f[7] = this.from[1]!;
    f[8] = this.from[2]!;
    f[9] = this.from[3]!;
    f[10] = this.fresh ? 1 : 0;
    if (!out) return this.bytes.slice();
    if (out.length < offset + SEAT_TRANSITION_STATE_BYTES) throw new Error('SeatTransition.save: the output is too short');
    out.set(this.bytes, offset);
    return out;
  }

  /** Bytes `save` writes (`SEAT_TRANSITION_STATE_BYTES`). */
  get byteLength(): number {
    return SEAT_TRANSITION_STATE_BYTES;
  }

  /** Brings back a state saved by `save` of a timeline with the same options. */
  restore(bytes: Uint8Array, offset = 0): void {
    if (bytes.length < offset + SEAT_TRANSITION_STATE_BYTES) throw new Error('SeatTransition.restore: too few bytes');
    const f = this.f;
    this.bytes.set(bytes.subarray(offset, offset + SEAT_TRANSITION_STATE_BYTES));
    const mode = f[1]!;
    if (f[0] !== STATE_VERSION || !(mode === FREE || mode === ATTACHING || mode === HELD || mode === RELEASING)) throw new Error('SeatTransition.restore: not a seat transition state');
    this.mode = mode;
    this.t = f[2]!;
    this.t0 = f[3]!;
    this.crossFrom = f[4]!;
    this.approach = f[5]!;
    this.from[0] = f[6]!;
    this.from[1] = f[7]!;
    this.from[2] = f[8]!;
    this.from[3] = f[9]!;
    this.fresh = f[10] === 1;
    this.before = this.code();
    this.seat.fade.set(this.weight());
  }
}
