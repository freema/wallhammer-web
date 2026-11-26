// Flight assist: a controller between what a player means and a `FlyingBody`'s intent. The body stays the honest
// glider of world/flying.ts (the same forces, collisions and bits); the assist only writes its `FlyingIntent` (pitch,
// beat, brake, turn) once per fixed step, from the body's state of that step, so that:
//   - the body flies at a wanted speed, which a throttle moves and which stays when the throttle is let go;
//   - with no climb asked it holds its height, beating by itself as much as that needs;
//   - a climb or a descent is held as a vertical speed, with beats in the climb and a flare in the descent, so the
//     speed does not run away;
//   - a turn is the bank asked, held level, the speed held through it (no more bank than the lift can hold at the
//     speed);
//   - it never lets the body stall: the wanted speed stays at or above `safeSpeed` (`stallMargin` over the stall speed,
//     and fast enough to hold level), and well below that it stops climbing and lowers the nose to dive back to speed;
//   - near the ground a descent eases to `landingSink` and the wings level out, so coming down at low speed lands (the
//     body's touch-down);
//   - against a solid (touching it, far under the wanted speed) it stops pushing after `blockTime`, so the body slides
//     off or settles down instead of beating against it.
//
// How: two loops ask accelerations, along the path (the speed toward the wanted one over `speedTime`) and vertical
// (the vertical speed toward the asked one over `climbTime`; the asked one is the climb, the descent or the held
// height's error times `holdGain`). The assist then inverts the body's own model of the coming step (the same lift,
// drag, path damping, stall, ceiling, bank, beat easing and pulse as `FlyingBody`, read from its setup): the push along
// the path the beats must give for the along-path acceleration (or the flare, when drag must be added), then the lift
// for the vertical acceleration, and from the lift the lift coefficient and so the pitch. A few passes settle the
// coupling (the lift coefficient sets the drag, the drag the path damping). What the body cannot give (a climb beyond
// its beats, a lift beyond `maxLift`) saturates; the loops catch the rest.
//
// Only + − × ÷, Math.sqrt and the reproducible detSinCos, detSinCosTurns and detAtan2 run in a step, so the same inputs give the
// same bits; a step allocates nothing. The assist's own state (`wantedSpeed`, `holdY`) is plain numbers a game may save
// beside the body's state. Scope: as the flying body's, a flat world with +y up.

import { detAtan2, detSinCos, detSinCosTurns } from '../base/trig.ts';
import type { FlyingBody, FlyingIntent } from './flying.ts';

export interface FlightAssistSetup {
  /** The range of the wanted speed, m/s (the lowest is raised to `safeSpeed` when that is higher). */
  minSpeed: number;
  maxSpeed: number;
  /** The wanted speed `reset` starts at, m/s. */
  cruiseSpeed: number;
  /** How fast a full throttle moves the wanted speed, m/s per second. */
  speedChange: number;
  /** Time constant of the speed's approach to the wanted one, s. */
  speedTime: number;
  /** Most deceleration asked (by drag and a flare), m/s². */
  maxDeceleration: number;
  /** Most flare used, 0–1. */
  maxBrake: number;
  /** Vertical speed at full climb and at full descent, m/s. */
  climbRate: number;
  descentRate: number;
  /** Time constant of the vertical speed's approach to the asked one, s; most vertical acceleration asked, m/s². */
  climbTime: number;
  maxVerticalAcceleration: number;
  /** Vertical speed asked per metre off the held height, 1/s. */
  holdGain: number;
  /**
   * The wanted speed is kept this far over the body's `stallSpeed`, m/s; more than half of it under that, no climb and
   * a dive back to speed.
   */
  stallMargin: number;
  /** Vertical speed asked per m/s under the guard's speed (`safeSpeed` − `stallMargin` / 2), as a descent, 1/s. */
  stallDive: number;
  /**
   * Share of the lift's margin over the weight at `maxLift` kept back from a turn (the bank is limited to what the rest
   * holds level at the speed), 0–1.
   */
  turnReserve: number;
  /** After leaving the ground the held height is at least this far over the ground, m. */
  departHeight: number;
  /**
   * Below this height over the ground a descent eases, down to `landingSink` at the ground, and the turn eases out
   * (the wings level for the touch-down), m and m/s.
   */
  landingHeight: number;
  landingSink: number;
  /**
   * Against a solid: touching something with the speed under `blockShare` of the wanted one for `blockTime` seconds,
   * the assist stops pushing (no beats, no flare) and lets the body slide off or settle down; it flies on once free of
   * contacts for `blockTime`. Share 0–1, seconds.
   */
  blockShare: number;
  blockTime: number;
}

/**
 * A reference set for `DEFAULT_FLYING_BODY` (trim 10 m/s, stall 6 m/s; it flies from about 8.3 m/s, its `safeSpeed`,
 * to 16 m/s). A game passes its own.
 */
export const DEFAULT_FLIGHT_ASSIST: Readonly<FlightAssistSetup> = Object.freeze({
  minSpeed: 8,
  maxSpeed: 16,
  cruiseSpeed: 10,
  speedChange: 5,
  speedTime: 0.6,
  maxDeceleration: 4,
  maxBrake: 0.7,
  climbRate: 3,
  descentRate: 3,
  climbTime: 0.5,
  maxVerticalAcceleration: 4,
  holdGain: 1,
  stallMargin: 1,
  stallDive: 1.5,
  turnReserve: 0.25,
  departHeight: 3,
  landingHeight: 4,
  landingSink: 0.8,
  blockShare: 0.5,
  blockTime: 0.4,
});

/** What the player means in a step. */
export interface FlightAssistInput {
  /** −1..1: moves the wanted speed up (+) or down at `speedChange`; 0 keeps it. */
  throttle: number;
  /** −1..1: a climb (+) at up to `climbRate` or a descent at up to `descentRate`; 0 holds the height. */
  climb: number;
  /** −1..1, positive to the right: the bank (a level turn). */
  turn: number;
}

/** A fresh, idle `FlightAssistInput` (allocate once, reuse). */
export function newFlightAssistInput(): FlightAssistInput {
  return { throttle: 0, climb: 0, turn: 0 };
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** Passes of the inversion per step. */
const PASSES = 3;
/** Share of the lift at `maxLift` the slowest wanted speed needs at most to hold the weight (the rest is a reserve). */
const LEVEL_SHARE = 0.8;
/** Below this speed the path has no direction (the body's own threshold), m/s. */
const MIN_AIR_SPEED = 0.5;

/**
 * Flies a `FlyingBody` from a player's speed, climb and turn (see the file comment). Call `advance(dt, input, intent)`
 * once per frame in place of the body's own `advance`, or `steer` and then the body's `step` from a script. On the
 * ground it writes `turn` only (and pitch, beat and brake 0): the crawl (`forward`) and the leap (`takeOff`) stay the
 * caller's.
 */
export class FlightAssist {
  readonly body: FlyingBody;
  readonly setup: FlightAssistSetup;
  /** The wanted speed, m/s (moved by the throttle; may be set). */
  wantedSpeed: number;
  /** The held height (world y), m, while no climb or descent is asked (may be set). */
  holdY: number;
  /** The vertical speed and the acceleration along the path asked in the last step, m/s and m/s². */
  askedClimb = 0;
  askedAcceleration = 0;
  /** In the last step the speed was more than half of `stallMargin` under `safeSpeed` (diving back to speed). */
  guarding = false;
  /** Against a solid and not pushing (see `blockShare`). */
  blocked = false;
  private blockedFor = 0;
  private freeFor = 0;
  private wasGrounded: boolean;
  private lastCl = 1;
  private readonly sc: [number, number] = [0, 0];
  private dueInput: FlightAssistInput | null = null;

  constructor(body: FlyingBody, setup?: Partial<FlightAssistSetup>) {
    this.body = body;
    this.setup = { ...DEFAULT_FLIGHT_ASSIST, ...setup };
    const a = this.setup;
    if (!(a.maxSpeed >= a.minSpeed)) throw new Error('FlightAssist: maxSpeed must not be below minSpeed');
    if (!(a.speedTime > 0) || !(a.climbTime > 0)) throw new Error('FlightAssist: speedTime and climbTime must be positive');
    this.wantedSpeed = clamp(a.cruiseSpeed, a.minSpeed, a.maxSpeed);
    this.holdY = body.position[1]!;
    this.wasGrounded = body.grounded;
  }

  /**
   * The lowest speed the assist flies at, m/s: the highest of `minSpeed`, the body's stall speed plus `stallMargin`, and
   * the speed at which `LEVEL_SHARE` of the lift at `maxLift` still holds the weight (slower, it could not hold level).
   */
  get safeSpeed(): number {
    const s = this.body.setup;
    let v = s.stallSpeed + this.setup.stallMargin;
    if (this.setup.minSpeed > v) v = this.setup.minSpeed;
    const level = s.maxLift > 0 ? s.trimSpeed / Math.sqrt(s.maxLift * LEVEL_SHARE) : Infinity;
    return level > v ? level : v;
  }

  /** The wanted speed back to `cruiseSpeed` (or `speed`), the held height to where the body is now. */
  reset(speed = this.setup.cruiseSpeed): void {
    this.wantedSpeed = clamp(speed, this.setup.minSpeed, this.setup.maxSpeed);
    this.holdY = this.body.position[1]!;
    this.wasGrounded = this.body.grounded;
    this.lastCl = 1;
    this.askedClimb = 0;
    this.askedAcceleration = 0;
    this.guarding = false;
    this.blocked = false;
    this.blockedFor = 0;
    this.freeFor = 0;
  }

  /** Advances the body by `dt` seconds of frames, the intent written by `steer` before every fixed step. */
  advance(dt: number, input: FlightAssistInput, intent: FlyingIntent): number {
    this.dueInput = input;
    const n = this.body.advance(dt, intent, this.prepare);
    this.dueInput = null;
    return n;
  }

  private readonly prepare = (intent: FlyingIntent): void => {
    this.steer(this.dueInput!, intent);
  };

  /** One fixed step: `steer`, then the body's `step` (for scripts and tests). */
  step(input: FlightAssistInput, intent: FlyingIntent): void {
    this.steer(input, intent);
    this.body.step(intent);
    intent.takeOff = false;
  }

  /** Writes the intent of the body's next fixed step from `input` and the body's state now; returns `out`. */
  steer(input: FlightAssistInput, out: FlyingIntent): FlyingIntent {
    const b = this.body, s = b.setup, a = this.setup;
    const dt = b.stepSeconds;
    const g = s.gravity;
    let turn = clamp(input.turn, -1, 1);
    const p = b.position, v = b.velocity;
    if (!b.grounded) {
      // Coming down near the ground the wings level out, so the hull meets the ground with its middle.
      if (input.climb < 0 && b.altitude < a.landingHeight) turn *= b.altitude > 0 ? b.altitude / a.landingHeight : 0;
      // No more bank than the lift can hold level at this speed (`turnReserve` of its margin over the weight kept).
      const V2 = v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!;
      let n = 1 + ((V2 / (s.trimSpeed * s.trimSpeed)) * s.maxLift - 1) * (1 - a.turnReserve);
      if (n > s.maxLoad) n = s.maxLoad;
      const most = n > 1 ? detAtan2(Math.sqrt(n * n - 1), 1) : 0;
      if (s.maxBank > 0 && most < s.maxBank) {
        const k = most / s.maxBank;
        turn = clamp(turn, -k, k);
      }
    }
    out.turn = turn;
    if (b.grounded) {
      out.pitch = 0;
      out.beat = 0;
      out.brake = 0;
      this.holdY = p[1]!;
      this.wasGrounded = true;
      this.askedClimb = 0;
      this.askedAcceleration = 0;
      this.guarding = false;
      this.blocked = false;
      this.blockedFor = 0;
      this.freeFor = 0;
      return out;
    }
    const y = p[1]!;
    if (this.wasGrounded) {
      // Just off the ground: hold at least `departHeight` over it.
      const lift = b.groundY + a.departHeight;
      this.holdY = y > lift ? y : lift;
      this.wasGrounded = false;
    }
    // The wanted speed, moved by the throttle; never under the safe speed.
    this.wantedSpeed = clamp(this.wantedSpeed + clamp(input.throttle, -1, 1) * a.speedChange * dt, a.minSpeed, a.maxSpeed);
    const safe = this.safeSpeed;
    const want = this.wantedSpeed > safe ? this.wantedSpeed : safe;
    const V = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
    // Against a solid: far under the wanted speed while touching, for `blockTime`, it stops pushing.
    if (b.contacts > 0) {
      this.freeFor = 0;
      if (V < a.blockShare * want) this.blockedFor += dt;
    } else {
      this.freeFor += dt;
      if (this.freeFor >= a.blockTime) this.blockedFor = 0;
    }
    this.blocked = this.blockedFor >= a.blockTime;
    // The vertical speed asked: the climb, the descent or the held height.
    const climb = clamp(input.climb, -1, 1);
    let vy: number;
    if (climb !== 0) {
      vy = climb > 0 ? climb * a.climbRate : climb * a.descentRate;
      this.holdY = y;
    } else vy = clamp((this.holdY - y) * a.holdGain, -a.descentRate, a.climbRate);
    // No climb into the thin air under the ceiling.
    const top = s.ceilingY - s.ceilingBand;
    if (this.holdY > top) this.holdY = top;
    if (y + vy / a.holdGain > top) vy = (top - y) * a.holdGain;
    // Near the ground a descent eases toward `landingSink`.
    const alt = b.altitude;
    if (vy < -a.landingSink && alt < a.landingHeight) {
      const k = alt > 0 ? alt / a.landingHeight : 0;
      vy = -(a.landingSink + (-vy - a.landingSink) * k);
    }
    // The stall guard: half the margin under the safe speed no climb, and a dive back to speed.
    const guard = safe - 0.5 * a.stallMargin;
    this.guarding = V < guard;
    if (this.guarding) {
      const dive = -(guard - V) * a.stallDive;
      if (vy > dive) vy = dive;
      this.holdY = y;
    }
    this.askedClimb = vy;
    const at = clamp((want - V) / a.speedTime, -a.maxDeceleration, Infinity);
    this.askedAcceleration = at;
    const ay = clamp((vy - v[1]!) / a.climbTime, -a.maxVerticalAcceleration, a.maxVerticalAcceleration);

    // --- The body's coming step, as flying.ts computes it -------------------------------------------------------------
    const bank = b.bank + clamp(turn * s.maxBank - b.bank, -s.bankRate * dt, s.bankRate * dt);
    let tx: number, ty: number, tz: number;
    if (V > MIN_AIR_SPEED) {
      tx = v[0]! / V;
      ty = v[1]! / V;
      tz = v[2]! / V;
    } else {
      const hs = detSinCos(b.yaw, this.sc);
      tx = -hs[0];
      ty = 0;
      tz = -hs[1];
    }
    const bs = detSinCos(bank, this.sc);
    const sb = bs[0], cb = bs[1];
    const tf = cb > 0.05 ? 1 + s.turnLift * (1 / cb - 1) : 1;
    const q = (V * V) / (s.trimSpeed * s.trimSpeed);
    const x = s.stallBand > 0 ? clamp((V - s.stallSpeed) / s.stallBand + 0.5, 0, 1) : V >= s.stallSpeed ? 1 : 0;
    const share = s.stallLift + (1 - s.stallLift) * x * x * (3 - 2 * x);
    const ceil = s.ceilingBand > 0 ? clamp((s.ceilingY - y) / s.ceilingBand, 0, 1) : y < s.ceilingY ? 1 : 0;
    // The lift's up component: the path's up turned by the bank (right = level right of the heading).
    const hs = detSinCos(b.yaw, this.sc);
    const rx = hs[1], rz = -hs[0];
    let ux = -rz * ty, uy = rz * tx - rx * tz, uz = rx * ty;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const py = tz * ux - tx * uz;
    let ly = uy * cb + py * sb;
    if (ly < 0.2) ly = 0.2;
    // The beats' pulse in the coming step (the phase runs on at the current effort's rate).
    const rate = !Number.isNaN(s.softBeatRate) ? s.softBeatRate + (s.beatRate - s.softBeatRate) * b.beatEffort : s.beatRate;
    let phase = b.beatPhase + (b.beatEffort > 1e-3 ? rate * dt : 0);
    phase -= Math.floor(phase);
    const pl = 1 + s.beatPulse * detSinCosTurns(phase - 0.25, this.sc)[1];
    const pulse = pl > 0 ? pl : 0;
    const ease = s.beatEase > 0 ? dt / s.beatEase : 1;
    const dragUnit = (g / s.glideRatio) * q;
    const fast = s.fastDrag > 0 && q > 1 ? (g / s.glideRatio) * s.fastDrag * (q - 1) * (q - 1) : 0;
    const push1 = s.beatThrust + s.beatLift * ty;

    // --- The inversion: the push (or the flare) for the speed, the lift for the climb -------------------------------
    let cl = this.lastCl;
    let beat = 0, brake = 0, effort = b.beatEffort, flare = b.flare;
    for (let pass = 0; pass < PASSES; pass++) {
      // The mean push along the path that gives `at` without a flare (the pulse averages out over a cycle); a
      // negative one is drag the flare adds.
      const plain = dragUnit * (1 + cl * cl) / 2 + fast;
      const need = push1 > 0.1 ? (at + plain + g * ty) / push1 : 0;
      if (need >= 0) {
        beat = ceil > 0.05 ? clamp(need / ceil, 0, 1) : 1;
        brake = 0;
      } else {
        beat = 0;
        const per = dragUnit * s.flareDrag;
        brake = per > 1e-9 ? clamp((-need * push1) / per, 0, a.maxBrake) : 0;
      }
      effort = b.beatEffort + clamp(beat - b.beatEffort, -ease, ease);
      flare = b.flare + clamp(brake - b.flare, -ease, ease);
      const push = effort * pulse * ceil;
      const drag = plain + dragUnit * flare * s.flareDrag;
      // The lift for the vertical acceleration, then the lift coefficient that gives it.
      let lift = (ay - (push * s.beatThrust - drag) * ty - push * s.beatLift + g) / ly;
      if (lift < 0) lift = 0;
      if (lift > s.maxLoad * g) lift = s.maxLoad * g;
      const d = 1 + (s.pathDamping * (-drag - g * ty)) / g;
      const per = g * q * share * ceil * (d > 0 ? d : 0);
      const hi = (s.maxLift + flare * s.flareLift) * tf;
      cl = per > 1e-9 ? clamp(lift / per, 0, hi) : hi;
    }
    this.lastCl = cl;
    // The pitch that gives that lift coefficient (the flare's share and the turn's taken off).
    const base = cl / tf - flare * s.flareLift;
    out.pitch = clamp(base >= 1 ? (s.maxLift > 1 ? (base - 1) / (s.maxLift - 1) : 1) : s.minLift < 1 ? (base - 1) / (1 - s.minLift) : -1, -1, 1);
    out.beat = beat;
    out.brake = brake;
    if (this.blocked) {
      // No push against the solid: it slides off it or settles down, and the held height follows.
      out.beat = 0;
      out.brake = 0;
      this.holdY = y;
    }
    return out;
  }
}
