// Walker: a kinematic body (an upright cylinder) that moves over a collision world in fixed steps. It speeds up and
// brakes, slides along sides and out of corners, climbs steps up to a height, falls off edges, does not climb a base
// surface steeper than a limit (and slides down one), jumps from the ground and keeps the velocity and the heading of
// take-off in the air (a share of control and a turn rate in the air are options, both 0 by default), stops its head
// under undersides and turns smoothly toward where it is asked to go. Between steps it gives a position for
// drawing. Plain Node, no DOM; only + − × ÷ and Math.sqrt in a step (detAtan2 for the heading), so the same inputs
// give the same path bit for bit.
//
// State: everything a step reads or writes, also the drawing state between steps, saves to a fixed number of bytes
// (`saveState`, `loadState`). `simState` wraps that as a part of a fixed-step simulation's state (the `SimState`
// shape of sim, matched structurally, since world does not import sim), so a snapshot, `restore` and `rebase` bring the
// walker back with everything else. A walker stepped by such a simulation draws with the simulation's `alpha`.
//
// Scope: a flat world with +y up. A curved world is not built; the places where a local up would replace y are
// marked "UP:" below (gravity, the vertical span, the slope of the base and the heading plane).

import { detAtan2, detSinCos } from '../base/trig.ts';
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
  /** Acceleration and braking on the ground, m/s². */
  acceleration: number;
  /**
   * Share of the acceleration available in the air, 0–1. 0 (default): the horizontal velocity of take-off is kept until
   * landing, so the body cannot be steered or braked in the air. A small share (0.05–0.1) allows a slight correction.
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
   * Seconds over which a step up or down is eased out in the drawn position (`renderPosition`), so a body climbing
   * stairs does not jump; the simulated position is not affected. 0 draws the steps as they are.
   */
  stepSmoothing: number;
  /** Most fixed steps one `advance` takes; the rest of a longer pause is dropped (no catching up after a stall). */
  maxStepsPerAdvance: number;
}

export const DEFAULT_WALKER: Readonly<WalkerSetup> = Object.freeze({
  radius: 0.3,
  height: 1.7,
  walkSpeed: 1.6,
  runSpeed: 4.5,
  acceleration: 20,
  airControl: 0,
  airTurnSpeed: 0,
  jumpSpeed: 4.2,
  gravity: 9.81,
  maxStepUp: 0.35,
  maxSlopeDeg: 45,
  stepHz: 60,
  turnSpeed: 12,
  stepSmoothing: 0.1,
  maxStepsPerAdvance: 15,
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
  private readonly prev = new Float64Array(3);
  private prevYaw = 0;
  /** `travelled` before the last step (drawing interpolates between the two). */
  private prevTravelled = 0;
  private acc = 0;
  private pendingJump = false;
  private stepOffset = 0;
  private prevStepOffset = 0;
  private readonly slid = newSlideResult();
  private readonly grad = new Float64Array(2);
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
    const sc = detSinCos((s.maxSlopeDeg * PI) / 180);
    this.tanMax = sc[1] > 0 ? sc[0] / sc[1] : Infinity;
    // Share of the step offset kept per step: exp(−3 dt / stepSmoothing) (95 % gone after stepSmoothing seconds).
    this.smoothKeep = s.stepSmoothing > 0 ? Math.exp((-3 * this.dt) / s.stepSmoothing) : 0;
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
    this.acc = 0;
    this.pendingJump = false;
    this.stepOffset = 0;
    this.prevStepOffset = 0;
    this.steps = 0;
  }

  /**
   * Advances by real seconds in fixed steps; returns the number of steps taken. Leftover time carries to the next call,
   * so one call of 1/30 s and two of 1/60 s end in the same place. A jump asked while no step is due is kept for the
   * next step; it applies to the first step of the call only.
   */
  advance(dt: number, intent: WalkIntent): number {
    if (intent.jump) this.pendingJump = true;
    if (!(dt > 0)) return 0;
    this.acc += dt;
    const h = this.dt;
    const max = this.setup.maxStepsPerAdvance;
    const sc = this.scratch;
    sc.moveX = intent.moveX;
    sc.moveZ = intent.moveZ;
    sc.run = intent.run;
    let n = 0;
    // The tolerance keeps a sum of equal frame times from falling a rounding short of a whole step.
    while (this.acc + 1e-9 * h >= h) {
      if (n >= max) {
        this.acc = 0;
        break;
      }
      sc.jump = this.pendingJump;
      this.pendingJump = false;
      this.step(sc);
      this.acc -= h;
      n++;
    }
    if (this.acc < 0) this.acc = 0;
    return n;
  }

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
    const speed = intent.run ? s.runSpeed : s.walkSpeed;
    let wantX = mx * speed;
    let wantZ = mz * speed;
    const y = p[1]!;

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
    const accel = s.acceleration * (onGround ? 1 : s.airControl) * h;
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

    // Heading: toward the wanted direction (or, without one, the direction moved), at most turnSpeed on the ground and
    // airTurnSpeed in the air.
    const lim = (onGround ? s.turnSpeed : s.airTurnSpeed) * h;
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
    const a = this.acc / this.dt;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /**
   * Writes the whole state (position, velocity, heading, ground contact, distance, steps, the previous step for
   * drawing, leftover time, a pending jump, the step easing) into `out` (at least `WALKER_STATE_BYTES` bytes from
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
    f[15] = this.acc;
    f[16] = this.stepOffset;
    f[17] = this.prevStepOffset;
    f[18] = this.prevTravelled;
    f[19] = 0;
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
    this.acc = f[15]!;
    this.stepOffset = f[16]!;
    this.prevStepOffset = f[17]!;
    this.prevTravelled = f[18]!;
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

  /** Horizontal metres moved in the last step (divide by `stepSeconds` for the speed); 0 after a `teleport`. */
  get lastStepDistance(): number {
    return this.travelled - this.prevTravelled;
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
