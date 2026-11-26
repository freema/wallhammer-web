// The glider's body in a frame, from the state of a flying body (the engine's `FlyingBody`): on the ground its four
// paws (the wings' paws and the pelvic fins' paws) are stepped by `QuadGait` (the engine's `StepCycle` and a
// `TwoBoneReach` per leg), in the air the kind's `fly` poses the wings from the beat, the flare, the bank and the climb.
// Between them an eased weight blends the two poses (`blendPose`) and the root's attitude: level on the ground, pitched
// and banked as the body in the air. The tails and the lantern lag behind whatever moves them (`ChainLag`, kept here so
// they run on in the air too).
//
// Over that, the moments around leaving and meeting the ground, all from the body's state so they play the same in a
// scene and in live play:
//   - the crouch before a leap (`crouch`, the anticipation the caller holds the leap back for): the body sinks onto
//     its paws, no deeper than its belly clears the ground, the fins and points fold in;
//   - the launch (`sinceLift`): the body extends, the wings' paws pushing on the ground through the moment the body
//     leaves it (`PUSH_S`), the nose pitched up about the rear of the body, the first strokes thrown deep on the
//     body's own beat (the kind's `fly` reads `launch`);
//   - the approach (`flare`, or low and sinking): the nose pitched up, the wings spread and cupped as brakes, the
//     paws reaching forward and down (`land`);
//   - the touch-down (`sinceTouch`, `impact`): the flare's pitch carried through the first contact and eased out,
//     the paws put down one after another (the hind paws first, then the wings'), the body sinking onto them and
//     springing back up, the wings folding down into the ground's pose over about a second.
// Whenever the trunk is lowered or pitched on the ground or the air's pose is still blended in, the legs reach again
// for the step cycle's footholds (`reachTwoBone`) and the paws are laid flat on the ground under them, so planted
// paws stay where they stand.
//
// The face (`face`, the kind's `GliderFace`) is timed here from the same state and from the gait's own clock (simulation
// seconds), so it plays the same in every run: the mouth open and the tongue out, panting, in an effort (the first
// strokes after a leap, beats in a climb, a few seconds after a touch-down); the mouth open and the eyes narrowed in
// fast flight; standing still now and then a yawn, a lick of the lips or the tongue hung out, drawn from a named
// stream per period; and a blink every few seconds.
//
// The order in a frame: `update` (the body's drawn state, dt), then `solve` (the bones).

import { hashInts, unit } from 'wallhammer-web/gen-core';
import { ChainLag, Pose, blendPose, reachTwoBone, solvePose, solvePoseBelow } from 'wallhammer-web/motion';
import type { GliderFace, GliderFlight, GliderKind } from './glider.ts';
import { QuadGait } from './quad-gait.ts';

/** Seconds of the blend from the ground's pose to the air's (a take-off) and back (a touch-down: the wings fold down). */
export const GLIDER_LIFT_S = 0.22;
export const GLIDER_LAND_S = 0.9;
/** Seconds a paw takes to find the ground after a touch-down, and when each starts (wing left, wing right, hind left, hind right). */
const PLANT_S = 0.12;
const PLANT_AT_S = [0.14, 0.2, 0, 0.05] as const;
/** Seconds the wings' paws keep pushing on the ground after the body leaves it. */
const PUSH_S = 0.2;
/** How far round a paw the ground is sampled for its slope, m. */
const SLOPE_M = 0.3;
/** The pitch the nose is thrown up by in the launch and in the approach, radians. */
const LIFT_PITCH = 0.22;
const LAND_PITCH = 0.5;
/** Where the extra pitch turns about: the rear of the body (figure frame: up, forward), m. */
const PIVOT_UP = 0.9, PIVOT_FORWARD = -2.6;
/** How far the body sinks in the crouch and at a hard touch-down, m (the belly clears the ground by about 0.5 m). */
const CROUCH_SINK_M = 0.3;
const LAND_SINK_M = 0.36;
/** How fast a bank changes for a full `GliderFlight.roll`, rad/s, and how fast that follows, 1/s. */
const ROLL_FULL = 0.9;
const ROLL_RATE = 6;
/** Below this height and sinking the glider makes ready to land, m. */
const APPROACH_M = 5;
/** Speeds over which the wings sweep back for fast flight (`GliderFlight.fast` from 0 to 1), m/s, and its rate, 1/s. */
const FAST_FROM_MS = 13;
const FAST_TO_MS = 17.5;
const FAST_RATE = 1.2;

/** The face: seconds of a period at rest in which one thing may happen, of a blink's period and of a blink. */
const IDLE_PERIOD_S = 6.5;
const BLINK_PERIOD_S = 3.4;
const BLINK_S = 0.17;
/** Seconds the glider pants after a touch-down, and after a leap. */
const PANT_LAND_S = 3.2;
const PANT_LIFT_S = 1.6;
/** How fast the face follows what it is asked, 1/s. */
const FACE_RATE = 9;
/** Named streams of the face's chances. */
const FACE_STREAM = { idle: 0x47_46_49, blink: 0x47_46_42 } as const;

/** What `GliderGait.update` takes from the flying body: its drawn state. */
export interface GliderState {
  x: number;
  y: number;
  z: number;
  /** Heading, radians (0 faces −z). */
  yaw: number;
  /** Nose up (+), radians. */
  pitch: number;
  /** Right side down (+), radians. */
  bank: number;
  /** Velocity, m/s. */
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  beatPhase: number;
  beatEffort: number;
  flare: number;
  /** Height above the ground under it, m. */
  altitude: number;
  /** The crouch before a leap, 0–1 (1: about to leap). */
  crouch: number;
  /** Seconds since the last take-off and since the last touch-down (large: none yet). */
  sinceLift: number;
  sinceTouch: number;
  /** Speed down at the last touch-down, m/s. */
  impact: number;
}

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class GliderGait {
  readonly kind: GliderKind;
  /** The steps on the ground (its own lags off: the tails are this gait's). */
  readonly ground: QuadGait;
  readonly pose: Pose;
  readonly world: Float64Array;
  /** The root of the last `update`: columns left, up, forward, then the point under the middle of the body. */
  readonly root = new Float64Array(12);
  readonly lags: readonly ChainLag[];
  /** Weight of the air's pose, 0 on the ground, 1 in the air. */
  air = 0;
  /** The approach to a landing, 0–1 (eased). */
  land = 0;
  /** How far the trunk is lowered on its paws this frame, m. */
  sink = 0;
  /** The pitch added to the body's own this frame, radians. */
  pitchAdd = 0;
  /** The flight's drawn state for the kind's `fly`. */
  readonly flight: GliderFlight = { phase: 0, effort: 0, flare: 0, bank: 0, climb: 0, time: 0, launch: 1e9, land: 0, fast: 0, roll: 0 };
  /** The face of the frame (the kind's `face` poses it). */
  readonly face: GliderFace = { open: 0, tongue: 0, tongueSide: 0, tongueCurl: 0, lids: 0 };
  private readonly faceSeed: number;
  private readonly airPose: Pose;
  private readonly heightAt: (x: number, z: number) => number;
  private lagDt = 0;
  private wasGrounded = true;
  private started = false;
  private crouch = 0;
  private plant = 1;
  /** Seconds since the last touch-down and since the last take-off, as drawn. */
  private since = 1e9;
  private lifted = 1e9;
  private lastBank = 0;
  /** The weight each leg reaches for its foothold with this frame. */
  private readonly plants = new Float64Array(4);
  private readonly target = new Float64Array(3);
  private readonly pole = new Float64Array(3);
  private readonly M = new Float64Array(9);
  private readonly L = new Float64Array(9);
  private readonly Q = new Float64Array(4);
  private readonly G = new Float64Array(9);

  constructor(kind: GliderKind, heightAt: (x: number, z: number) => number, seed = 0.43) {
    this.kind = kind;
    this.heightAt = heightAt;
    this.faceSeed = Math.round(seed * 4096);
    this.ground = new QuadGait({ ...kind, lag: [] }, { seed });
    this.pose = new Pose(kind.skeleton);
    this.airPose = new Pose(kind.skeleton);
    this.world = new Float64Array(kind.skeleton.count * 12);
    this.lags = (kind.lag ?? []).map((c) => new ChainLag(kind.skeleton, c));
  }

  /** Starts over at the body's state (standing or flying as it is). */
  reset(s: GliderState): void {
    this.ground.reset(s.x, s.y, s.z, s.yaw, this.heightAt);
    this.air = s.grounded ? 0 : 1;
    this.plant = s.grounded ? 1 : 0;
    this.land = 0;
    this.wasGrounded = s.grounded;
    this.flight.time = 0;
    this.flight.fast = s.grounded ? 0 : this.fastOf(s);
    this.flight.roll = 0;
    this.lastBank = s.bank;
    this.since = s.grounded ? 1e9 : 0;
    this.lifted = s.grounded ? 1e9 : 0;
    this.lagDt = 0;
    const face = this.face;
    face.open = face.tongue = face.tongueSide = face.tongueCurl = face.lids = 0;
    for (const l of this.lags) l.reset();
    this.started = true;
    this.attitude(s);
    this.setRoot(s);
  }

  /** Advances by `dt` seconds to the body's drawn state `s`. */
  update(dt: number, s: GliderState): void {
    if (!this.started) this.reset(s);
    if (s.grounded && !this.wasGrounded) {
      // A touch-down: the steps start over where the paws come down.
      this.ground.reset(s.x, s.y, s.z, s.yaw, this.heightAt);
      this.since = 0;
    }
    if (!s.grounded && this.wasGrounded) this.lifted = 0;
    this.wasGrounded = s.grounded;
    if (dt > 0) {
      const to = s.grounded ? 0 : 1;
      const step = dt / (s.grounded ? GLIDER_LAND_S : GLIDER_LIFT_S);
      this.air = to > this.air ? Math.min(to, this.air + step) : Math.max(to, this.air - step);
      if (s.grounded) this.since += dt;
      else this.lifted += dt;
      this.plant = s.grounded ? 1 : Math.max(0, 1 - this.lifted / PUSH_S);
      // How fast the bank changes, smoothed.
      const rate = (s.bank - this.lastBank) / dt / ROLL_FULL;
      const want = s.grounded ? 0 : Math.max(-1, Math.min(1, rate));
      this.flight.roll += (want - this.flight.roll) * Math.min(1, dt * ROLL_RATE);
      // The approach: a flare, or low and sinking; eased in and out.
      const low = !s.grounded && s.vy < -0.3 ? smooth01((APPROACH_M - s.altitude) / (APPROACH_M - 1)) : 0;
      const approach = s.grounded ? 0 : Math.max(s.flare, low);
      this.land += Math.max(-dt * 2.5, Math.min(dt * 3, approach - this.land));
      // The sweep of fast flight, eased (the beats' pulse ripples the speed).
      const fast = s.grounded ? 0 : this.fastOf(s);
      this.flight.fast += Math.max(-dt * FAST_RATE, Math.min(dt * FAST_RATE, fast - this.flight.fast));
      this.flight.time += dt;
      this.lagDt += dt;
    }
    this.lastBank = s.bank;
    // The paws' weights: after a touch-down one after another, after a take-off the wings' paws pushing a moment.
    for (let i = 0; i < 4; i++) {
      this.plants[i] = s.grounded ? smooth01((this.since - PLANT_AT_S[i]!) / PLANT_S) : i < 2 ? smooth01(this.plant) : 0;
    }
    if (this.air < 1) this.ground.update(dt, s.x, s.y, s.z, s.yaw, s.grounded ? s.vx : 0, s.grounded ? s.vz : 0, this.heightAt);
    const f = this.flight;
    f.phase = s.beatPhase;
    f.effort = s.beatEffort;
    f.flare = s.flare;
    f.bank = s.bank;
    f.launch = s.grounded ? 1e9 : s.sinceLift;
    f.land = this.land;
    const v = Math.hypot(s.vx, s.vz);
    f.climb = v > 0.5 ? Math.max(-1, Math.min(1, s.vy / v)) : 0;
    this.crouch = s.grounded ? s.crouch : 0;
    if (dt > 0) this.expression(dt, s);
    this.attitude(s);
    this.setRoot(s);
  }

  /** The face of the frame: what is asked of it from the body's state and the clock, followed at `FACE_RATE`. */
  private expression(dt: number, s: GliderState): void {
    const t = this.flight.time;
    let open = 0, tongue = 0, side = 0, curl = 0, lids = 0;
    // An effort: the first strokes after a leap, beats in a climb, a while after a touch-down.
    const pant = s.grounded
      ? 1 - smooth01((this.since - (PANT_LAND_S - 0.8)) / 0.8)
      : Math.max(1 - smooth01((this.lifted - (PANT_LIFT_S - 0.6)) / 0.6), Math.min(1, s.beatEffort * 1.5) * smooth01((this.flight.climb - 0.05) / 0.2));
    if (pant > 0) {
      const breath = Math.sin(2 * Math.PI * 2.3 * t);
      open = pant * (0.36 + 0.07 * breath);
      tongue = pant * (0.72 + 0.1 * breath);
      curl = -0.5;
    }
    // Fast flight: the mouth open in the wind, the eyes narrowed.
    const glee = s.grounded ? 0 : this.flight.fast;
    open = Math.max(open, 0.3 * glee);
    lids = 0.3 * glee;
    // Standing still, now and then: a yawn, a lick of the lips, the tongue hung out.
    if (s.grounded && pant <= 0 && s.crouch <= 0 && this.ground.speed < 0.05) {
      const k = Math.floor(t / IDLE_PERIOD_S);
      const h = (i: number): number => unit(hashInts(FACE_STREAM.idle, this.faceSeed, k, i));
      const what = h(0);
      const len = what < 0.24 ? 2.8 : what < 0.46 ? 1.7 : what < 0.62 ? 2.6 : 0;
      const x = len > 0 ? (t - (k + 0.08 + 0.3 * h(1)) * IDLE_PERIOD_S) / len : -1;
      if (x >= 0 && x <= 1) {
        const inOut = smooth01(x / 0.3) * (1 - smooth01((x - 0.72) / 0.28));
        if (what < 0.24) {
          // A yawn: wide, the eyes shut, the tongue's tip curled up in the mouth.
          open = inOut;
          lids = smooth01((inOut - 0.25) / 0.4);
          tongue = 0.22 * inOut;
          curl = 0.8;
        } else if (what < 0.46) {
          // A lick: the tongue out and swept from one side to the other.
          open = 0.3 * inOut;
          tongue = 0.85 * inOut;
          side = (h(2) < 0.5 ? -1 : 1) * Math.cos(Math.PI * smooth01((x - 0.2) / 0.6));
          curl = 0.5;
        } else {
          // The tongue hung out a while.
          open = 0.24 * inOut;
          tongue = 0.9 * inOut;
          curl = -1;
        }
      }
    }
    // A blink.
    const kb = Math.floor(t / BLINK_PERIOD_S);
    const xb = (t - (kb + 0.1 + 0.7 * unit(hashInts(FACE_STREAM.blink, this.faceSeed, kb))) * BLINK_PERIOD_S) / BLINK_S;
    const blink = xb >= 0 && xb <= 1 ? Math.sin(Math.PI * xb) : 0;
    const f = this.face;
    const a = Math.min(1, dt * FACE_RATE);
    f.open += (open - f.open) * a;
    f.tongue += (tongue - f.tongue) * a;
    f.tongueSide += (side - f.tongueSide) * a;
    f.tongueCurl += (curl - f.tongueCurl) * a;
    f.lids = Math.max(f.lids + (lids - f.lids) * a, blink);
  }

  /** How fast the body flies, 0–1 between `FAST_FROM_MS` and `FAST_TO_MS`. */
  private fastOf(s: GliderState): number {
    return smooth01((Math.hypot(s.vx, s.vy, s.vz) - FAST_FROM_MS) / (FAST_TO_MS - FAST_FROM_MS));
  }

  /** The pitch thrown in and the trunk's sink, from the moments around the ground. */
  private attitude(s: GliderState): void {
    const t = s.sinceLift;
    // The launch: up fast as the paws push off, held through the first strokes, eased out into the cruise. The
    // approach's pitch is carried through the touch-down and eased out as `land` falls (the hind paws first).
    const lift = s.grounded ? 0 : smooth01(t / 0.25) * (1 - smooth01((t - 1.3) / 1.4));
    this.pitchAdd = LIFT_PITCH * lift + LAND_PITCH * this.land;
    // On the ground the crouch, and a damped spring after a touch-down (deep by the speed it came down at).
    const u = s.sinceTouch;
    const hard = Math.min(1, 0.35 + s.impact / 3);
    const spring = s.grounded && u < 2 ? LAND_SINK_M * hard * Math.exp(-u / 0.28) * Math.sin(Math.min(Math.PI * 1.75, (Math.PI * u) / 0.3)) : 0;
    this.sink = s.grounded ? CROUCH_SINK_M * smooth01(s.crouch) + Math.max(-0.12, spring) : 0;
  }

  /** The root at the body's place: its heading, and its pitch and bank by the air's weight (Ry · Rx · Rz(−bank)). */
  private setRoot(s: GliderState): void {
    const w = this.air * this.air * (3 - 2 * this.air);
    const r = this.root;
    this.frame(s.yaw, s.pitch * w + this.pitchAdd, s.bank * w, r);
    r[9] = s.x;
    r[10] = s.y;
    r[11] = s.z;
    if (this.pitchAdd !== 0) {
      // Turned about the rear of the body: where the pivot is without the extra pitch it stays.
      const a = this.level;
      this.frame(s.yaw, s.pitch * w, s.bank * w, a);
      for (let j = 0; j < 3; j++) r[9 + j] = r[9 + j]! + (a[3 + j]! - r[3 + j]!) * PIVOT_UP + (a[6 + j]! - r[6 + j]!) * PIVOT_FORWARD;
    }
  }

  /** The frame without the extra pitch (scratch). */
  private readonly level = new Float64Array(9);

  /** The figure's frame (+x left, +y up, +z forward) of a heading, a pitch and a bank, into the first 9 of `out`. */
  private frame(yaw: number, pitch: number, bank: number, out: Float64Array): void {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cb = Math.cos(bank), sb = Math.sin(bank);
    const tx = (x: number, y: number, z: number, k: number, sign: number): void => {
      // Rx(pitch), then Ry(yaw).
      const y1 = y * cp - z * sp, z1 = y * sp + z * cp;
      out[k] = sign * (x * cy + z1 * sy);
      out[k + 1] = sign * y1;
      out[k + 2] = sign * (-x * sy + z1 * cy);
    };
    // The body's right, up and back (Rz(−bank) applied to the axes), turned; left and forward are their negatives.
    tx(cb, -sb, 0, 0, -1);
    tx(sb, cb, 0, 3, 1);
    tx(0, 0, 1, 6, -1);
  }

  /** The bones of the frame (after `update`). */
  solve(): Float64Array {
    const sk = this.kind.skeleton;
    const w = this.air * this.air * (3 - 2 * this.air);
    if (w < 1) this.ground.solve();
    if (w > 0) {
      this.airPose.reset();
      this.kind.fly(this.airPose, this.flight);
    }
    if (w <= 0) this.pose.copy(this.ground.pose);
    else if (w >= 1) this.pose.copy(this.airPose);
    else blendPose(this.pose, this.ground.pose, this.airPose, w);
    const trunk = this.kind.steps.trunk;
    if (this.sink !== 0) this.pose.offset[trunk * 3 + 1] = this.pose.offset[trunk * 3 + 1]! - this.sink;
    if (this.crouch > 0) this.kind.crouch(this.pose, smooth01(this.crouch));
    this.kind.face(this.pose, this.face);
    solvePose(sk, this.pose, this.root, this.world);
    const pl = this.plants;
    if (w < 1 && (pl[0]! > 0 || pl[1]! > 0 || pl[2]! > 0 || pl[3]! > 0) && (this.sink !== 0 || w > 0 || this.crouch > 0 || this.pitchAdd !== 0)) {
      this.replant(pl);
    }
    const dt = this.lagDt;
    this.lagDt = 0;
    for (const l of this.lags) l.apply(dt, sk, this.pose, this.root, this.world);
    return this.world;
  }

  /** The legs reach again for the step cycle's footholds (weight `wts[leg]`), their paws flat on the ground there. */
  private replant(wts: Float64Array): void {
    const sk = this.kind.skeleton, legs = this.kind.steps.legs, c = this.ground.cycle;
    const root = this.root, world = this.world, pose = this.pose;
    const t = this.target, p = this.pole, M = this.M, L = this.L, Q = this.Q;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i]!;
      const wt = wts[i]!;
      if (wt <= 0) continue;
      t[0] = c.targets[i * 3]!;
      t[1] = c.targets[i * 3 + 1]!;
      t[2] = c.targets[i * 3 + 2]!;
      for (let j = 0; j < 3; j++) p[j] = root[j]! * l.pole[0] + root[3 + j]! * l.pole[1] + root[6 + j]! * l.pole[2] + root[9 + j]!;
      reachTwoBone(sk, pose, root, world, l.chain, t, wt, p);
      // The paw flat on the ground: local = cannon⁻¹ · G, G the ground's frame under the foothold (up its normal,
      // forward the body's forward laid along it).
      const G = this.G;
      const h = this.heightAt;
      const nx = h(t[0]! - SLOPE_M, t[2]!) - h(t[0]! + SLOPE_M, t[2]!), nz = h(t[0]!, t[2]! - SLOPE_M) - h(t[0]!, t[2]! + SLOPE_M), ny = 2 * SLOPE_M;
      const nl = Math.hypot(nx, ny, nz);
      G[3] = nx / nl;
      G[4] = ny / nl;
      G[5] = nz / nl;
      const fd = root[6]! * G[3] + root[7]! * G[4] + root[8]! * G[5];
      let fx = root[6]! - G[3] * fd, fy = root[7]! - G[4] * fd, fz = root[8]! - G[5] * fd;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl;
      fy /= fl;
      fz /= fl;
      G[6] = fx;
      G[7] = fy;
      G[8] = fz;
      // Left = up × forward.
      G[0] = G[4] * fz - G[5] * fy;
      G[1] = G[5] * fx - G[3] * fz;
      G[2] = G[3] * fy - G[4] * fx;
      const pu = l.cannon * 12;
      for (let col = 0; col < 3; col++) {
        const lx = Math.hypot(world[pu + col * 3]!, world[pu + col * 3 + 1]!, world[pu + col * 3 + 2]!) || 1;
        for (let row = 0; row < 3; row++) M[col * 3 + row] = world[pu + col * 3 + row]! / lx;
      }
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
          L[col * 3 + row] = M[row * 3]! * G[col * 3]! + M[row * 3 + 1]! * G[col * 3 + 1]! + M[row * 3 + 2]! * G[col * 3 + 2]!;
        }
      }
      quatOf(L, Q);
      const q = l.hoof * 4, r = pose.rot;
      // Blend toward the level paw by the weight (nlerp, the shorter way).
      const d = r[q]! * Q[0]! + r[q + 1]! * Q[1]! + r[q + 2]! * Q[2]! + r[q + 3]! * Q[3]!;
      const sgn = d < 0 ? -1 : 1;
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const v = r[q + k]! * (1 - wt) + sgn * Q[k]! * wt;
        r[q + k] = v;
        n += v * v;
      }
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < 4; k++) r[q + k] = r[q + k]! / n;
      solvePoseBelow(sk, pose, root, world, l.hoof);
    }
  }
}

/** The quaternion (x, y, z, w) of a rotation matrix (columns) into `q`. */
function quatOf(m: Float64Array, q: Float64Array): void {
  const m00 = m[0]!, m11 = m[4]!, m22 = m[8]!;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q[3] = 0.25 * s;
    q[0] = (m[5]! - m[7]!) / s;
    q[1] = (m[6]! - m[2]!) / s;
    q[2] = (m[1]! - m[3]!) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q[3] = (m[5]! - m[7]!) / s;
    q[0] = 0.25 * s;
    q[1] = (m[3]! + m[1]!) / s;
    q[2] = (m[6]! + m[2]!) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q[3] = (m[6]! - m[2]!) / s;
    q[0] = (m[3]! + m[1]!) / s;
    q[1] = 0.25 * s;
    q[2] = (m[7]! + m[5]!) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q[3] = (m[1]! - m[3]!) / s;
    q[0] = (m[6]! + m[2]!) / s;
    q[1] = (m[7]! + m[5]!) / s;
    q[2] = 0.25 * s;
  }
}
