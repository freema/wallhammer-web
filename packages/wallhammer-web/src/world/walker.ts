// Walker: a kinematic body (an upright cylinder) that moves over a collision world in fixed steps. It speeds up and
// brakes (with its own braking rate and a slower run-up as options), turns in an arc at speed (an option), slides along sides and out of corners, climbs steps up to a height, falls off edges, does not climb a base
// surface steeper than a limit (and slides down one), jumps from the ground and keeps the velocity and the heading of
// take-off in the air (a share of control and a turn rate in the air are options, both 0 by default), stops its head
// under undersides and turns smoothly toward where it is asked to go. As an option it is slower uphill and a little
// faster on gentle descents (the grade of the ground along the wanted direction scales the wanted speed). Between steps it gives a position for
// drawing. Plain Node, no DOM; only + − × ÷ and Math.sqrt in a step (detAtan2 and detSinCos for the heading and an arc), so the same inputs
// give the same path bit for bit.
//
// State: everything a step reads or writes, also the drawing state between steps, saves to a fixed number of bytes
// (`saveState`, `loadState`). `simState` wraps that as a part of a fixed-step simulation's state (the `SimState`
// shape of sim, matched structurally, since world does not import sim), so a snapshot, `restore` and `rebase` bring the
// walker back with everything else. A walker stepped by such a simulation draws with the simulation's `alpha`.
//
// Scope: a flat world with +y up. A curved world is not built; the places where a local up would replace y are
// marked "UP:" below (gravity, the vertical span, the slope of the base, the grade probe and the heading plane).

import { detAtan2, detSinCos } from '../base/trig.ts';
import { FixedSteps } from '../core/fixed-steps.ts';
import { newSlideResult } from './collide.ts';
import type { CollisionWorld } from './collide.ts';

export interface WalkerSetup {
  /** Radius of the body, metres. */
  radius: number;
  /** Height of the body from the feet to the top of the head, metres. */
  height: number;
  /** Speed when walking, m/s. */
  walkSpeed: number;
  /** Speed when running, m/s. */
  runSpeed: number;
  /** Acceleration on the ground, m/s²; also the braking unless `deceleration` is set. */
  acceleration: number;
  /**
   * Braking on the ground, m/s²: used when the wanted speed is lower than the current one (no input, or a slower
   * gait). 0 (default): `acceleration`. A body that runs at `runSpeed` v stops in v² / (2 deceleration) metres in the
   * continuous limit; in fixed steps of dt (a step brakes before it moves) a little sooner, in v² / (2 deceleration) −
   * v · dt / 2 metres (exactly when v / (deceleration · dt) is a whole number of steps, otherwise at most deceleration ·
   * dt² / 8 more): 1.988 m instead of 2.025 m from 4.5 m/s with deceleration 5 at 60 steps a second. Not used in the
   * air (see `airControl`).
   */
  deceleration: number;
  /** Acceleration on the ground while running, m/s² (a slower run-up than a walk's start). 0 (default): `acceleration`. Not used in the air. */
  runAcceleration: number;
  /**
   * Share of the acceleration available in the air, 0–1. 0 (default): the horizontal velocity of take-off is kept until
   * landing, so the body cannot be steered or braked in the air. A small share (0.05–0.1) allows a slight correction.
   * In the air every change of the velocity (speeding up, braking, turning) is at most `acceleration` × this per
   * second: `deceleration` and `runAcceleration` are the grip of the feet and apply only on the ground.
   */
  airControl: number;
  /**
   * Fastest turn of `yaw` in the air, radians per second. 0 (default): the heading of take-off is kept until landing,
   * whatever is asked in the air.
   */
  airTurnSpeed: number;
  /** Upward speed of a jump, m/s; 0 disables jumping. */
  jumpSpeed: number;
  /** Downward acceleration, m/s². */
  gravity: number;
  /** Highest step the body walks up without stopping, metres. */
  maxStepUp: number;
  /** A base surface steeper than this is not climbed and is slid down, degrees. */
  maxSlopeDeg: number;
  /** Fixed steps per second. */
  stepHz: number;
  /** Fastest turn of `yaw` toward the wanted direction on the ground, radians per second (in the air: `airTurnSpeed`). */
  turnSpeed: number;
  /**
   * Fastest turn on the ground at `runSpeed`, radians per second. 0 (default): `turnSpeed` at every speed, and the
   * velocity moves straight toward the wanted one (a body turns on the spot). Set: the turn rate falls linearly from
   * `turnSpeed` at `walkSpeed` (and below) to this at `runSpeed` (and above), and the direction of the velocity turns no
   * faster than that rate, so a runner turns in an arc of radius speed / rate instead of on the spot. The velocity
   * still changes by at most the acceleration (in a turn at the same speed the larger of `acceleration` and
   * `deceleration`), so the arc is no tighter than speed² / that.
   */
  turnSpeedAtRun: number;
  /**
   * Seconds over which a step up or down is eased out in the drawn position (`renderPosition`), so a body climbing
   * stairs does not jump; the simulated position is not affected. 0 draws the steps as they are.
   */
  stepSmoothing: number;
  /** Most fixed steps one `advance` takes; the rest of a longer pause is dropped (no catching up after a stall). */
  maxStepsPerAdvance: number;
  /**
   * Share of the wanted speed on the ground lost per unit of uphill grade (rise over run along the wanted direction):
   * 0.8 walks a 20° slope (grade 0.36) about 29 % slower. 0 (default), with `downhillSpeedGain` and `downhillSpeedLoss`
   * also 0: no slope effect, the speed is the same uphill, downhill and on the flat. The grade is that of the ground
   * the body stands on, base or solid tops (a flight of stairs counts as its mean slope), averaged over `gradeProbe`
   * ahead and as much behind along the wanted direction and eased over `gradeSmoothing`; a drop or a rise of more than `maxStepUp` (a ledge,
   * a side) counts as one step, not as a slope. Only the wanted speed is scaled: `acceleration` and `deceleration` ease the change. Not
   * used in the air.
   */
  uphillSpeedLoss: number;
  /** Share of the wanted speed gained per unit of downhill grade on gentle descents (with `downhillSpeedLoss`): the speed is scaled by 1 + d·(gain − loss·d) at downhill grade d. 0 (default). */
  downhillSpeedGain: number;
  /**
   * Share lost per unit of downhill grade squared: steep descents are taken slower. With gain 0.5 and loss 1.8 a
   * descent is fastest at grade 0.14 (+3.5 %), as fast as the flat at 0.28 and 18 % slower at 0.5. 0 (default).
   */
  downhillSpeedLoss: number;
  /** Least share of the wanted speed a slope leaves, 0–1, so a body never stalls on a slope it may stand on. Default 0.25. */
  slopeSpeedFloor: number;
  /**
   * Length of ground the grade probe averages ahead of the feet and again behind them, metres (four points on each
   * side). Default 1: 2 m of ground in all, fitting a body of the default size; a longer body (four legs) may take more.
   * Used only while the slope effect is on. Fixed at construction.
   */
  gradeProbe?: number;
  /** Seconds over which the probed grade is eased (the share kept per step is exp(−step / this)); 0: not eased. Default 0.3. Fixed at construction. */
  gradeSmoothing?: number;
}

/** The numbers of a setup that may change while a walker lives (`Walker.retune`): speeds, rates and the jump. */
export type WalkerTuning = Pick<WalkerSetup, 'walkSpeed' | 'runSpeed' | 'acceleration' | 'deceleration' | 'runAcceleration' | 'turnSpeed' | 'turnSpeedAtRun' | 'airControl' | 'airTurnSpeed' | 'jumpSpeed' | 'uphillSpeedLoss' | 'downhillSpeedGain' | 'downhillSpeedLoss' | 'slopeSpeedFloor'>;

/** The fields of `WalkerTuning`. */
export const WALKER_TUNING_KEYS: readonly (keyof WalkerTuning)[] = ['walkSpeed', 'runSpeed', 'acceleration', 'deceleration', 'runAcceleration', 'turnSpeed', 'turnSpeedAtRun', 'airControl', 'airTurnSpeed', 'jumpSpeed', 'uphillSpeedLoss', 'downhillSpeedGain', 'downhillSpeedLoss', 'slopeSpeedFloor'];

export const DEFAULT_WALKER: Readonly<WalkerSetup> = Object.freeze({
  radius: 0.3,
  height: 1.7,
  walkSpeed: 1.6,
  runSpeed: 4.5,
  acceleration: 20,
  deceleration: 0,
  runAcceleration: 0,
  airControl: 0,
  airTurnSpeed: 0,
  jumpSpeed: 4.2,
  gravity: 9.81,
  maxStepUp: 0.35,
  maxSlopeDeg: 45,
  stepHz: 60,
  turnSpeed: 12,
  turnSpeedAtRun: 0,
  stepSmoothing: 0.1,
  maxStepsPerAdvance: 15,
  uphillSpeedLoss: 0,
  downhillSpeedGain: 0,
  downhillSpeedLoss: 0,
  slopeSpeedFloor: 0.25,
  gradeProbe: 1,
  gradeSmoothing: 0.3,
});

export interface WalkIntent {
  /** Wanted direction in the world, length at most 1 (longer is clamped). */
  moveX: number;
  moveZ: number;
  run: boolean;
  /** True in the step in which a jump is asked. */
  jump: boolean;
}

/** Bytes of one saved walker state (`Walker.saveState`). */
export const WALKER_STATE_BYTES = 20 * 8;
/** First number of a saved state; another one is not a walker state of this layout. */
const STATE_VERSION = 1;

/** Where a state part writes its bytes (the `bytes` method of sim's `ByteWriter` fits). */
export interface ByteSink {
  bytes(a: ArrayBufferView): void;
}

/** Where a state part reads its bytes from (the `into` method of sim's `ByteReader` fits). */
export interface ByteSource {
  into(target: ArrayBufferView): void;
}

/** A walker as one part of a simulation's state: matches `SimState` of sim (`Simulation.addState`). */
export interface WalkerSimState {
  readonly name: string;
  save(w: ByteSink): void;
  load(r: ByteSource): void;
}

/** A fresh, idle `WalkIntent` (allocate once, reuse). */
export function newWalkIntent(): WalkIntent {
  return { moveX: 0, moveZ: 0, run: false, jump: false };
}

/** Feet within this of the base surface stand on the base (and its slope applies). */
const ON_BASE_EPS = 1e-6;
/** Horizontal speed below which a body counts as standing, m/s. */
const STILL_SPEED = 1e-4;
/** Undersides are found a hair inside the radius, so a side the body only touches is not a ceiling. */
const CEILING_INSET = 1e-3;
/** A change of ground height smaller than this (beyond what the slope explains) is not eased as a step, metres. */
const STEP_EASE_MIN = 0.02;
/**
 * Reach of the one-sided slope test, metres. A point on a kink of the base (the lip or the foot of a slope too steep)
 * counts as steep only when the base is too steep on both sides of it along the gradient, so a body can walk away from
 * the lip of a cliff instead of being held there by a gradient that straddles the kink.
 */
const KINK_REACH = 0.05;
/** Points of the grade probe on each side (evenly spaced, so a flight of stairs reads as its mean slope). */
const GRADE_SAMPLES = 4;
/** Steepest grade the probe measures when `maxSlopeDeg` allows steeper ground. */
const GRADE_CAP = 2;
const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;

/**
 * A kinematic body over a `CollisionWorld`. `position` is the feet (x, y, z). `yaw` is the heading with the same
 * convention as a view's yaw: yaw 0 faces −z, and the facing direction is (−sin yaw, −cos yaw) in x, z, so a
 * `FollowRig` with `yawDeg = yaw` in degrees looks the same way. Call `advance(dt, intent)` once per frame (or `step`
 * from a script) and draw at `renderPosition`.
 */
export class Walker {
  readonly setup: WalkerSetup;
  /** Feet position, metres. */
  readonly position = new Float64Array(3);
  readonly velocity = new Float64Array(3);
  /** Heading of the last movement, radians (see the class comment for the convention). */
  yaw = 0;
  grounded = false;
  /** True while standing on a base surface steeper than `maxSlopeDeg` (sliding down it). */
  steep = false;
  /** Horizontal distance moved so far, metres (for animating a stride). */
  travelled = 0;
  /** Fixed steps taken since construction or the last `teleport`. */
  steps = 0;

  private readonly world: CollisionWorld;
  private readonly dt: number;
  private readonly tanMax: number;
  private readonly smoothKeep: number;
  /** Share of the eased grade kept per step, and the steepest grade measured (the tangent of `maxSlopeDeg`, at most GRADE_CAP). */
  private readonly gradeKeep: number;
  private readonly gradeMax: number;
  /** `gradeProbe` of the setup, metres (checked positive). */
  private readonly gradeProbe: number;
  /** Eased grade of the ground along the wanted direction (rise over run, + uphill); 0 while the slope effect is off. */
  private easedGrade = 0;
  private readonly prev = new Float64Array(3);
  private prevYaw = 0;
  /** `travelled` before the last step (drawing interpolates between the two). */
  private prevTravelled = 0;
  private readonly fixed: FixedSteps;
  private pendingJump = false;
  private stepOffset = 0;
  private prevStepOffset = 0;
  private readonly slid = newSlideResult();
  private readonly grad = new Float64Array(2);
  private readonly turnSc: [number, number] = [0, 0];
  private readonly scratch: WalkIntent = newWalkIntent();
  private readonly stateScratch = new Float64Array(WALKER_STATE_BYTES / 8);
  private readonly stateBytes = new Uint8Array(this.stateScratch.buffer);

  constructor(world: CollisionWorld, setup?: Partial<WalkerSetup>) {
    this.world = world;
    this.setup = { ...DEFAULT_WALKER, ...setup };
    const s = this.setup;
    if (!(s.stepHz > 0)) throw new Error('Walker: stepHz must be positive');
    if (!(s.radius > 0) || !(s.height > s.maxStepUp)) throw new Error('Walker: radius must be positive and height above maxStepUp');
    this.dt = 1 / s.stepHz;
    this.fixed = new FixedSteps(this.dt, s.maxStepsPerAdvance);
    const sc = detSinCos((s.maxSlopeDeg * PI) / 180);
    this.tanMax = sc[1] > 0 ? sc[0] / sc[1] : Infinity;
    // Share of the step offset kept per step: exp(−3 dt / stepSmoothing) (95 % gone after stepSmoothing seconds).
    this.smoothKeep = s.stepSmoothing > 0 ? Math.exp((-3 * this.dt) / s.stepSmoothing) : 0;
    const gp = s.gradeProbe ?? 1;
    if (!(gp > 0)) throw new Error('Walker: gradeProbe must be positive');
    this.gradeProbe = gp;
    const gs = s.gradeSmoothing ?? 0.3;
    this.gradeKeep = gs > 0 ? Math.exp(-this.dt / gs) : 0;
    this.gradeMax = this.tanMax < GRADE_CAP ? this.tanMax : GRADE_CAP;
  }

  /**
   * Changes the speeds, rates and jump of the setup from the next step on (a heavier or lighter body); a field left
   * out keeps its value. The state (position, velocity, heading) is kept. The size, the step rate and the limits of the
   * ground are fixed at construction.
   */
  retune(o: Partial<WalkerTuning>): void {
    const s = this.setup as WalkerSetup;
    for (const k of WALKER_TUNING_KEYS) {
      const v = o[k];
      if (v !== undefined) s[k] = v;
    }
  }

  /** Seconds of one fixed step. */
  get stepSeconds(): number {
    return this.dt;
  }

  /** Puts the body at a point with no velocity; it settles onto the ground in the next step. */
  teleport(x: number, y: number, z: number, yaw?: number): void {
    const p = this.position;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    this.prev.set(p);
    this.velocity.fill(0);
    if (yaw !== undefined) this.yaw = yaw;
    this.prevYaw = this.yaw;
    this.prevTravelled = this.travelled;
    this.grounded = false;
    this.steep = false;
    this.fixed.reset();
    this.pendingJump = false;
    this.stepOffset = 0;
    this.prevStepOffset = 0;
    this.steps = 0;
    this.easedGrade = 0;
  }

  /**
   * Advances by real seconds in fixed steps; returns the number of steps taken. Leftover time carries to the next call,
   * so one call of 1/30 s and two of 1/60 s end in the same place. A jump asked while no step is due is kept for the
   * next step; it applies to the first step of the call only.
   */
  advance(dt: number, intent: WalkIntent): number {
    if (intent.jump) this.pendingJump = true;
    if (!(dt > 0)) return 0;
    const sc = this.scratch;
    sc.moveX = intent.moveX;
    sc.moveZ = intent.moveZ;
    sc.run = intent.run;
    return this.fixed.advance(dt, this.stepDue, this.setup.maxStepsPerAdvance);
  }

  /** One step due in `advance`: the intent in the scratch, a pending jump on its first step. */
  private readonly stepDue = (): void => {
    const sc = this.scratch;
    sc.jump = this.pendingJump;
    this.pendingJump = false;
    this.step(sc);
  };

  /** One fixed step (for scripts and tests). */
  step(intent: WalkIntent): void {
    const s = this.setup;
    const w = this.world;
    const h = this.dt;
    const p = this.position;
    const v = this.velocity;
    const g = this.grad;
    this.prev.set(p);
    this.prevYaw = this.yaw;
    this.prevTravelled = this.travelled;
    this.prevStepOffset = this.stepOffset;
    this.stepOffset *= this.smoothKeep;
    this.steps++;
    // A step that starts on the ground steers and turns as on the ground (also the step of a take-off, and the first
    // step after a teleport onto the ground); a step that starts in the air (also the step of a landing) only as much as
    // airControl and airTurnSpeed allow.
    const onGround = this.grounded || p[1]! <= w.groundAt(p[0]!, p[2]!, p[1]!, 0, s.radius) + ON_BASE_EPS;

    // Wanted horizontal velocity.
    let mx = intent.moveX;
    let mz = intent.moveZ;
    if (!(mx === mx) || !(mz === mz)) {
      mx = 0;
      mz = 0;
    }
    const m2 = mx * mx + mz * mz;
    if (m2 > 1) {
      const k = 1 / Math.sqrt(m2);
      mx *= k;
      mz *= k;
    }
    let speed = intent.run ? s.runSpeed : s.walkSpeed;
    const y = p[1]!;

    // Slope (off by default: the grade is then never probed and stays 0). On the ground the grade along the wanted
    // direction (`probeGrade`) is eased over `gradeSmoothing`, and the wanted speed is scaled by 1 − uphillSpeedLoss·grade
    // uphill and by 1 + d·(downhillSpeedGain − downhillSpeedLoss·d) at downhill grade d, never below slopeSpeedFloor.
    if (onGround && (s.uphillSpeedLoss !== 0 || s.downhillSpeedGain !== 0 || s.downhillSpeedLoss !== 0)) {
      // A direction too short to normalise keeps the last grade.
      if (m2 > 1e-12) {
        const k = 1 / Math.sqrt(mx * mx + mz * mz);
        const raw = this.probeGrade(p[0]!, p[2]!, y, mx * k, mz * k);
        this.easedGrade = raw + (this.easedGrade - raw) * this.gradeKeep;
      }
      const gr = this.easedGrade;
      let f = gr > 0 ? 1 - s.uphillSpeedLoss * gr : 1 - gr * (s.downhillSpeedGain + s.downhillSpeedLoss * gr);
      if (f < s.slopeSpeedFloor) f = s.slopeSpeedFloor;
      speed *= f;
    }
    let wantX = mx * speed;
    let wantZ = mz * speed;

    // Momentum (all off by default, so the default setup steps exactly as without these options). The turn rate at
    // the current speed and, on the ground, the wanted direction turned no farther from the velocity's than that
    // rate allows in a step (an arc); braking or the run's acceleration as the rate of change of the velocity.
    let turnRate = s.turnSpeed;
    let rate = s.acceleration;
    if (s.turnSpeedAtRun > 0 || s.deceleration > 0 || s.runAcceleration > 0) {
      const vx0 = v[0]!;
      const vz0 = v[2]!;
      const cur2 = vx0 * vx0 + vz0 * vz0;
      const cur = Math.sqrt(cur2);
      if (s.turnSpeedAtRun > 0) {
        const span = s.runSpeed - s.walkSpeed;
        let k = span > 0 ? (cur - s.walkSpeed) / span : cur > s.walkSpeed ? 1 : 0;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        turnRate = s.turnSpeed + (s.turnSpeedAtRun - s.turnSpeed) * k;
        if (onGround && cur > STILL_SPEED && (wantX !== 0 || wantZ !== 0)) {
          // UP: the plane of the turn would be the local horizon.
          const ang = detAtan2(vx0 * wantZ - vz0 * wantX, vx0 * wantX + vz0 * wantZ);
          const lim = turnRate * h;
          if (ang > lim || ang < -lim) {
            const sc = detSinCos(ang > 0 ? lim : -lim, this.turnSc);
            const wl = Math.sqrt(wantX * wantX + wantZ * wantZ);
            const ux = vx0 / cur;
            const uz = vz0 / cur;
            wantX = (ux * sc[1] - uz * sc[0]) * wl;
            wantZ = (ux * sc[0] + uz * sc[1]) * wl;
          }
        }
      }
      // On the ground, slower than now: braking. Faster: the run-up's rate (running) or the acceleration. The same speed
      // (a turn): the larger of the acceleration and the braking, the grip of the feet. In the air there are no feet:
      // the rate is the acceleration (times airControl below) whatever the wanted speed.
      if (onGround) {
        const want2 = wantX * wantX + wantZ * wantZ;
        const decel = s.deceleration > 0 ? s.deceleration : s.acceleration;
        if (want2 < cur2 * (1 - 1e-9)) rate = decel;
        else if (want2 > cur2 * (1 + 1e-9)) {
          if (intent.run && s.runAcceleration > 0) rate = s.runAcceleration;
        } else rate = decel > s.acceleration ? decel : s.acceleration;
      }
    }

    // UP: the slope of the base and the split into downhill and across would use the local up.
    let steep = false;
    let downX = 0;
    let downZ = 0;
    let slope = 0;
    if (this.grounded && y <= w.baseHeightAt(p[0]!, p[2]!) + ON_BASE_EPS) {
      slope = w.baseSlopeAt(p[0]!, p[2]!, g);
      if (slope > this.tanMax && this.steepBothSides(p[0]!, p[2]!, g[0]! / slope, g[1]! / slope)) {
        steep = true;
        downX = -g[0]! / slope;
        downZ = -g[1]! / slope;
      }
    }
    this.steep = steep;
    const accel = rate * (onGround ? 1 : s.airControl) * h;
    if (steep) {
      // Across the slope the body is steered as usual; down the slope it slides (the horizontal part of gravity along
      // the incline, g·sinθ·cosθ = g·tanθ / (1 + tan²θ)) and the intent may only add speed downhill, never brake or climb.
      const vd0 = v[0]! * downX + v[2]! * downZ;
      const wd = wantX * downX + wantZ * downZ;
      const latX = v[0]! - vd0 * downX;
      const latZ = v[2]! - vd0 * downZ;
      const wLatX = wantX - wd * downX;
      const wLatZ = wantZ - wd * downZ;
      approach(latX, latZ, wLatX, wLatZ, accel, g);
      let vd = (vd0 > 0 ? vd0 : 0) + ((s.gravity * slope) / (1 + slope * slope)) * h;
      if (wd > vd) vd = vd + accel < wd ? vd + accel : wd;
      v[0] = g[0]! + vd * downX;
      v[2] = g[1]! + vd * downZ;
    } else {
      approach(v[0]!, v[2]!, wantX, wantZ, accel, g);
      v[0] = g[0]!;
      v[2] = g[1]!;
    }

    // A jump leaves only from the ground, and not from a slope too steep to stand on.
    if (intent.jump && this.grounded && !steep && s.jumpSpeed > 0) {
      v[1] = s.jumpSpeed;
      this.grounded = false;
    }

    // Horizontal move against the sides above the step height. The slide always runs, even standing still, so a
    // solid that appears over the body pushes it out.
    // UP: the span would be measured along the local up.
    const out = this.slid;
    const lo = y + s.maxStepUp;
    const hi = y + s.height;
    let hx = v[0]! * h;
    let hz = v[2]! * h;
    w.slide(p[0]!, p[2]!, s.radius, lo, hi, hx, hz, out);
    if (this.grounded && (hx !== 0 || hz !== 0)) {
      // Walking onto a base surface that is too steep and rising: the uphill part of the move is taken away.
      const bx = out.x;
      const bz = out.z;
      const base = w.baseHeightAt(bx, bz);
      if (base > y + ON_BASE_EPS && w.groundAt(bx, bz, y, s.maxStepUp, s.radius) <= base) {
        const sl = w.baseSlopeAt(bx, bz, g);
        if (sl > this.tanMax) {
          const ux = g[0]! / sl;
          const uz = g[1]! / sl;
          const along = hx * ux + hz * uz;
          if (along > 0) {
            hx -= along * ux;
            hz -= along * uz;
            const va = v[0]! * ux + v[2]! * uz;
            if (va > 0) {
              v[0] = v[0]! - va * ux;
              v[2] = v[2]! - va * uz;
            }
            w.slide(p[0]!, p[2]!, s.radius, lo, hi, hx, hz, out);
          }
        }
      }
    }
    if (out.hit) {
      // Velocity into the touched side is dropped, so the body slides along it and does not press on.
      const vn = v[0]! * out.nx + v[2]! * out.nz;
      if (vn < 0) {
        v[0] = v[0]! - vn * out.nx;
        v[2] = v[2]! - vn * out.nz;
      }
    }
    const movedX = out.x - p[0]!;
    const movedZ = out.z - p[2]!;
    const moved = Math.sqrt(movedX * movedX + movedZ * movedZ);
    p[0] = out.x;
    p[2] = out.z;
    this.travelled += moved;

    // Vertical. UP: gravity and heights would be along the local up.
    const x = p[0]!;
    const z = p[2]!;
    if (this.grounded) {
      const ground = w.groundAt(x, z, y, s.maxStepUp, s.radius);
      // How far below the feet the ground may be and still be followed: a step down, plus the drop of the base over
      // this move on a slope (so the body runs down a steep slope instead of hopping).
      let snap = s.maxStepUp;
      if (ground <= w.baseHeightAt(x, z) + ON_BASE_EPS) snap += moved * w.baseSlopeAt(x, z, g);
      if (ground >= y - snap) {
        // Only a step (a change the slope of this move does not explain) is eased in the drawn position.
        const rise = ground - y;
        if ((rise > 0 ? rise : -rise) > moved * this.tanMax + STEP_EASE_MIN) this.stepOffset += rise;
        p[1] = ground;
        v[1] = 0;
      } else {
        // Off an edge: falling starts from rest this step.
        this.grounded = false;
        v[1] = -s.gravity * h;
        p[1] = y - 0.5 * s.gravity * h * h;
        if (p[1] < ground) p[1] = ground;
      }
    } else {
      // Exact for constant gravity, so the top of a jump is jumpSpeed² / (2 gravity) at any step rate.
      let ny = y + v[1]! * h - 0.5 * s.gravity * h * h;
      v[1] = v[1]! - s.gravity * h;
      if (ny > y) {
        const ceiling = w.ceilingAt(x, z, y + s.height, s.radius - CEILING_INSET);
        if (ny + s.height > ceiling) {
          ny = ceiling - s.height;
          if (ny < y) ny = y;
          if (v[1]! > 0) v[1] = 0;
        }
      }
      const ground = w.groundAt(x, z, y, s.maxStepUp, s.radius);
      if (ny <= ground) {
        ny = ground;
        v[1] = 0;
        this.grounded = true;
      }
      p[1] = ny;
    }

    // Heading: toward the wanted direction (or, without one, the direction moved), at most turnSpeed (or the rate at
    // this speed, with turnSpeedAtRun) on the ground and airTurnSpeed in the air.
    const lim = (onGround ? turnRate : s.airTurnSpeed) * h;
    let fx = wantX;
    let fz = wantZ;
    if (fx * fx + fz * fz < STILL_SPEED * STILL_SPEED) {
      fx = moved > STILL_SPEED * h ? movedX : 0;
      fz = moved > STILL_SPEED * h ? movedZ : 0;
    }
    if (lim > 0 && (fx !== 0 || fz !== 0)) {
      // UP: the heading plane would be the local horizon.
      const target = detAtan2(-fx, -fz);
      let d = target - this.yaw;
      while (d > PI) d -= TWO_PI;
      while (d <= -PI) d += TWO_PI;
      this.yaw += d > lim ? lim : d < -lim ? -lim : d;
      if (this.yaw > PI) this.yaw -= TWO_PI;
      else if (this.yaw <= -PI) this.yaw += TWO_PI;
    }
  }

  /** Share of the way from the last step to the next one, 0–1. */
  get alpha(): number {
    return this.fixed.alpha;
  }

  /**
   * Writes the whole state (position, velocity, heading, ground contact, distance, steps, the previous step for
   * drawing, leftover time, a pending jump, the step easing, the eased grade) into `out` (at least `WALKER_STATE_BYTES` bytes from
   * `offset`; default a new array) and returns it. The setup and the collision world are not state.
   */
  saveState(out?: Uint8Array, offset = 0): Uint8Array {
    const f = this.stateScratch;
    const p = this.position;
    const v = this.velocity;
    f[0] = STATE_VERSION;
    f[1] = p[0]!;
    f[2] = p[1]!;
    f[3] = p[2]!;
    f[4] = v[0]!;
    f[5] = v[1]!;
    f[6] = v[2]!;
    f[7] = this.yaw;
    f[8] = (this.grounded ? 1 : 0) + (this.steep ? 2 : 0) + (this.pendingJump ? 4 : 0);
    f[9] = this.travelled;
    f[10] = this.steps;
    f[11] = this.prev[0]!;
    f[12] = this.prev[1]!;
    f[13] = this.prev[2]!;
    f[14] = this.prevYaw;
    f[15] = this.fixed.leftover;
    f[16] = this.stepOffset;
    f[17] = this.prevStepOffset;
    f[18] = this.prevTravelled;
    f[19] = this.easedGrade;
    const o = out ?? new Uint8Array(WALKER_STATE_BYTES);
    if (o.length < offset + WALKER_STATE_BYTES) throw new Error('Walker.saveState: the output is too short');
    o.set(this.stateBytes, offset);
    return o;
  }

  /** Restores a state written by `saveState` (of a walker with the same setup). */
  loadState(bytes: Uint8Array, offset = 0): void {
    if (bytes.length < offset + WALKER_STATE_BYTES) throw new Error('Walker.loadState: too few bytes');
    const f = this.stateScratch;
    this.stateBytes.set(bytes.subarray(offset, offset + WALKER_STATE_BYTES));
    if (f[0] !== STATE_VERSION) throw new Error('Walker.loadState: not a walker state');
    this.position[0] = f[1]!;
    this.position[1] = f[2]!;
    this.position[2] = f[3]!;
    this.velocity[0] = f[4]!;
    this.velocity[1] = f[5]!;
    this.velocity[2] = f[6]!;
    this.yaw = f[7]!;
    const flags = f[8]!;
    this.grounded = (flags & 1) !== 0;
    this.steep = (flags & 2) !== 0;
    this.pendingJump = (flags & 4) !== 0;
    this.travelled = f[9]!;
    this.steps = f[10]!;
    this.prev[0] = f[11]!;
    this.prev[1] = f[12]!;
    this.prev[2] = f[13]!;
    this.prevYaw = f[14]!;
    this.fixed.leftover = f[15]!;
    this.stepOffset = f[16]!;
    this.prevStepOffset = f[17]!;
    this.prevTravelled = f[18]!;
    this.easedGrade = f[19]!;
  }

  /**
   * This walker as a part of a simulation's state, for `Simulation.addState(walker.simState('walker'))`. Step it from a
   * system of that simulation (`step` once per tick, with `stepHz` equal to the simulation's `hz`) and draw it with
   * the simulation's `alpha`; snapshots, `restore`, `seek` and `rebase` then bring it back with everything else.
   */
  simState(name: string): WalkerSimState {
    const buf = new Uint8Array(WALKER_STATE_BYTES);
    return {
      name,
      save: (w) => w.bytes(this.saveState(buf)),
      load: (r) => {
        r.into(buf);
        this.loadState(buf);
      },
    };
  }

  /**
   * Position between the last two steps for drawing, written to `out`. A step up or down is eased out over
   * `stepSmoothing` seconds in y. `alpha` is the share of the way to the next step; default the walker's own (from
   * `advance`), a walker stepped by a simulation passes the simulation's `alpha`.
   */
  renderPosition(out: Float64Array | number[], alpha?: number): void {
    const a = alpha === undefined ? this.alpha : alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const p = this.position;
    const q = this.prev;
    out[0] = q[0]! + (p[0]! - q[0]!) * a;
    out[1] = q[1]! + (p[1]! - q[1]!) * a - (this.prevStepOffset + (this.stepOffset - this.prevStepOffset) * a);
    out[2] = q[2]! + (p[2]! - q[2]!) * a;
  }

  /** Heading between the last two steps for drawing, radians. `alpha` as for `renderPosition`. */
  renderYaw(alpha?: number): number {
    let d = this.yaw - this.prevYaw;
    if (d > PI) d -= TWO_PI;
    else if (d < -PI) d += TWO_PI;
    const a = alpha === undefined ? this.alpha : alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    return this.prevYaw + d * a;
  }

  /**
   * `travelled` between the last two steps for drawing (a stride kept in step with the drawn position). `alpha` as for
   * `renderPosition`.
   */
  renderTravelled(alpha?: number): number {
    const a = alpha === undefined ? this.alpha : alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    return this.prevTravelled + (this.travelled - this.prevTravelled) * a;
  }

  /**
   * The eased grade of the ground along the wanted direction (rise over run, positive uphill) that scales the wanted
   * speed: probed over `gradeProbe` and eased over `gradeSmoothing`, at most the tangent of `maxSlopeDeg` (and 2).
   * Read-only. 0 while the slope effect is off and after a `teleport`; kept as it was in the air and while no direction
   * is wanted. Part of the saved state.
   */
  get grade(): number {
    return this.easedGrade;
  }

  /** Horizontal metres moved in the last step (divide by `stepSeconds` for the speed); 0 after a `teleport`. */
  get lastStepDistance(): number {
    return this.travelled - this.prevTravelled;
  }

  /**
   * Grade of the ground along the unit (ux, uz) at the feet (x, y, z): the mean height of GRADE_SAMPLES points over
   * `gradeProbe` ahead less that of as many points behind, over the distance between the two means' centres, clamped to
   * the steepest grade measured. Each point takes the ground (base or a standable top) the body could step to from the
   * point before it, so a flight of stairs reads as its mean slope; a rise or a drop of more than `maxStepUp` between
   * two points (a side, a ledge) counts as one step, so a body neither slows down nor speeds up much before a ledge it
   * may jump from or a wall it walks into.
   */
  private probeGrade(x: number, z: number, y: number, ux: number, uz: number): number {
    const raw = (this.probeSide(x, z, y, ux, uz) - this.probeSide(x, z, y, -ux, -uz)) / this.gradeProbe;
    const m = this.gradeMax;
    return raw > m ? m : raw < -m ? -m : raw;
  }

  /** Mean height above `y` of the probe points on one side (see `probeGrade`). */
  private probeSide(x: number, z: number, y: number, ux: number, uz: number): number {
    // UP: the points would lie on the local horizon and the heights be measured along the local up.
    const w = this.world;
    const step = this.setup.maxStepUp;
    const d = this.gradeProbe / GRADE_SAMPLES;
    let h = y;
    let sum = 0;
    for (let i = 0; i < GRADE_SAMPLES; i++) {
      const t = (i + 0.5) * d;
      const g = w.groundAt(x + ux * t, z + uz * t, h, step);
      h = g > h + step ? h + step : g < h - step ? h - step : g;
      sum += h;
    }
    return sum / GRADE_SAMPLES - y;
  }

  /** Whether the base rises more steeply than the limit on both sides of (x, z) along the uphill unit (ux, uz). */
  private steepBothSides(x: number, z: number, ux: number, uz: number): boolean {
    const w = this.world;
    const e = KINK_REACH;
    const h = w.baseHeightAt(x, z);
    const up = w.baseHeightAt(x + ux * e, z + uz * e) - h;
    const down = h - w.baseHeightAt(x - ux * e, z - uz * e);
    const limit = this.tanMax * e;
    return up > limit && down > limit;
  }
}

/** Moves (vx, vz) toward (tx, tz) by at most `maxDelta`; writes the result to `out[0]`, `out[1]`. */
function approach(vx: number, vz: number, tx: number, tz: number, maxDelta: number, out: Float64Array): void {
  const ex = tx - vx;
  const ez = tz - vz;
  const e2 = ex * ex + ez * ez;
  if (e2 <= maxDelta * maxDelta) {
    out[0] = tx;
    out[1] = tz;
    return;
  }
  const k = maxDelta / Math.sqrt(e2);
  out[0] = vx + ex * k;
  out[1] = vz + ez * k;
}
