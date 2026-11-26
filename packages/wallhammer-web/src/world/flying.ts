// Flying body: a body that crawls on the ground and flies through the air over a collision world, in fixed steps. A
// point mass with a heading, a drawn attitude (pitch and bank) and a hull of spheres turned with that attitude.
//
// On the ground it moves along its heading at a crawl (its own speed, run-up, braking and turn rate), follows the
// ground under it (steps up to `maxStepUp`, leaves the ground over a drop deeper than `maxStepDown`), is held back by
// solids (the hull's spheres, sideways only) and leaves the ground with a leap (`takeOff`): an upward speed and a
// forward speed added to its own.
//
// In the air it is a glider with a polar of one parameter (the lift coefficient, 1 at trim):
//   lift  = g · (V / trimSpeed)² · cl, along the path's up turned by the bank (lift equals the weight at trimSpeed, cl 1)
//   drag  = g / glideRatio · (V / trimSpeed)² · (1 + cl²) / 2, plus the flare's share, against the velocity (so L/D is
//           glideRatio at cl 1, the best glide; a steeper or a flatter attitude costs height)
// The pitch input moves cl between `minLift` and `maxLift`; a bank asks extra lift to hold the turn level
// (`turnLift`), the most is `maxLoad` × the weight; below `stallSpeed` the lift falls to `stallLift` of itself (a stall)
// and the drag stays. The lift's horizontal share in a bank turns the path (r = V² / (g tan φ) in a level turn), and
// the heading follows the path. Beats of the body (`beat`) push along the path and up, eased in and out, in a cycle of
// `beatRate` a second (`beatPhase`; `beatPulse` makes the push follow the down stroke; with `softBeatRate` light beats
// are slower). A flare (`brake`) raises the drag and the lift; `fastDrag` adds drag above the trim speed.
// `pathDamping` damps the slow swing of a glider between climbing and diving. Over `ceilingY` the lift fades out (thin
// air), so the body cannot climb past it. Height and speed are traded honestly: no speed is set,
// only forces act.
//
// Collision: every step moves in sub-steps no longer than half the smallest sphere's radius and pushes the hull's
// spheres out of the base surface and every solid (`CollisionWorld.sphereContacts`), taking the velocity into the
// contact away (with `restitution` and `scrapeFriction`), so no wall or floor is passed, however thin. A body in the
// air touches down when its position comes to the ground under it while it does not rise; it then keeps the speed
// along its heading and brakes it at `landingDeceleration` down to its crawl. A body that comes to rest in the air held
// up by a sphere of its hull (on top of a solid that is not ground, or on the ground at a slant) is put down there too
// (`perched`): it levels out, sinking with the levelling so the hull stays on the hold (or comes down on the ground),
// and stands on that hold until the hold is gone from under its hull.
//
// Only + − × ÷, Math.sqrt and the reproducible detAtan2, detAsin and detSinCos run in a step, so the same inputs give
// the same bits; a step allocates nothing. Scope: a flat world with +y up and gravity along −y (the places where a
// local up would replace y are marked "UP:").
//
// Frames: `position` is the point under the middle of the body (on the ground while grounded). The body's frame has
// its origin there, +x to the right, +y up and −z forward; yaw 0 faces −z, as for a view and the walker. Pitch turns
// the nose up (+), bank rolls the right side down (+, a right turn).

import type { Mat34 } from '../base/mat34.ts';
import { detAtan2, detSinCos, detSinCosTurns } from '../base/trig.ts';
import { FixedSteps } from '../core/fixed-steps.ts';
import { newSphereContacts } from './collide.ts';
import type { CollisionWorld } from './collide.ts';
import type { WalkerSimState } from './walker.ts';

export interface FlyingBodySetup {
  /**
   * The hull as spheres in the body's frame, four numbers each (x, y, z, radius; origin `position`, +x right, +y up,
   * −z forward), turned with the attitude. Keep the lowest sphere's bottom at y 0 or a little above.
   */
  hull: readonly number[];
  /** The hull while on the ground (a body that folds itself to crawl); null: `hull`. */
  groundHull: readonly number[] | null;
  /** Downward acceleration, m/s². */
  gravity: number;
  /** Fixed steps per second. */
  stepHz: number;
  /** Most fixed steps one `advance` takes; the rest of a longer pause is dropped. */
  maxStepsPerAdvance: number;

  // --- On the ground ---
  /** Top speed of the crawl forward and backward, m/s. */
  groundSpeed: number;
  groundBackSpeed: number;
  /** Speeding up and braking of the crawl, m/s². */
  groundAcceleration: number;
  groundDeceleration: number;
  /** Braking of a speed above the crawl's (after a touch-down), m/s². */
  landingDeceleration: number;
  /** Turn rate of the heading at full `turn` on the ground, rad/s. */
  groundTurnSpeed: number;
  /** The highest step it crawls up, m. */
  maxStepUp: number;
  /** A drop deeper than this under it ends the ground: it is in the air, m. */
  maxStepDown: number;
  /** Upward speed of a leap off the ground, m/s. */
  leapSpeed: number;
  /** Forward speed a leap adds, m/s. */
  leapForwardSpeed: number;

  // --- In the air ---
  /** Speed at which the lift equals the weight at cl 1 (the trim of a level glide), m/s. */
  trimSpeed: number;
  /** Lift over drag at cl 1, the best glide: metres forward per metre of height lost. */
  glideRatio: number;
  /** The lift coefficient at full pitch down (−1) and full pitch up (+1); 1 at pitch 0. */
  minLift: number;
  maxLift: number;
  /** Most lift, as a multiple of the weight. */
  maxLoad: number;
  /**
   * Share of the extra lift that holds a banked turn level (cl × 1 / cos bank) asked by itself: 1 a level turn, 0 the
   * body sinks in a turn unless it is pitched up.
   */
  turnLift: number;
  /** Below this speed the lift falls (a stall), m/s. */
  stallSpeed: number;
  /** Width of the fall of the lift about `stallSpeed`, m/s. */
  stallBand: number;
  /** Share of the lift left in a full stall. */
  stallLift: number;
  /**
   * Damping of the path's swing between climb and dive: the lift changes by this share of the speed's gain along the
   * path from gravity and drag, per g (less lift while a climb bleeds speed, more in a dive; 0: none, the swing of a
   * free glider). The beats' push is not counted, so beating gains speed more than it steepens a climb.
   */
  pathDamping: number;
  /** Most bank, radians, and its fastest change, rad/s. */
  maxBank: number;
  bankRate: number;
  /** The drawn nose's pitch above the path per unit of cl above 1, radians (an angle of attack). */
  noseAngle: number;
  /** Rate at which the drawn pitch follows the path, 1/s. */
  attitudeRate: number;
  /** Beat cycles a second while beating (at full effort when `softBeatRate` is set). */
  beatRate: number;
  /**
   * Beat cycles a second at the lightest effort: the rate then grows with the effort up to `beatRate` at full effort,
   * so harder beats are also faster. NaN (default): always `beatRate`.
   */
  softBeatRate: number;
  /** Push along the path and up at full `beat`, m/s². */
  beatThrust: number;
  beatLift: number;
  /** Share of the push that follows the down stroke (0: a steady push; 1: none on the up stroke). */
  beatPulse: number;
  /** Seconds over which the beat's effort and the flare ease in and out. */
  beatEase: number;
  /** Drag added at full `brake` in the air, as a multiple of the drag at cl 1. */
  flareDrag: number;
  /** Lift coefficient added at full `brake` in the air. */
  flareLift: number;
  /**
   * Drag that rises above the trim speed, as a body not built for speed: g / glideRatio · fastDrag · (q − 1)² with
   * q = (V / trimSpeed)², added while q > 1 (it grows with the fourth power of the speed, a soft top speed). 0
   * (default): none.
   */
  fastDrag: number;
  /** Height (world y) at which the lift has faded out, and the height over which it fades, m. */
  ceilingY: number;
  ceilingBand: number;

  // --- Contacts ---
  /** Share of the speed into a contact given back (0–1). */
  restitution: number;
  /** Friction of the hull scraping along a solid or the ground (a Coulomb coefficient). */
  scrapeFriction: number;
  /** Tag of solids the hull does not touch; NaN (default): none. */
  skipTag: number;
}

/** What is asked of the body in a step. */
export interface FlyingIntent {
  /** −1..1: on the ground the crawl forward (+) or backward. */
  forward: number;
  /** −1..1, positive to the right: on the ground the turn of the heading, in the air the bank. */
  turn: number;
  /** −1..1, positive nose up: in the air the lift coefficient between `minLift` and `maxLift`. */
  pitch: number;
  /** 0..1: the effort of the beats (in the air they push; on the ground their cycle runs). */
  beat: number;
  /** 0..1: in the air a flare (drag and lift); on the ground a stop. */
  brake: number;
  /** True in the step in which a leap off the ground is asked. */
  takeOff: boolean;
}

/** A fresh, idle `FlyingIntent` (allocate once, reuse). */
export function newFlyingIntent(): FlyingIntent {
  return { forward: 0, turn: 0, pitch: 0, beat: 0, brake: 0, takeOff: false };
}

/** A reference set of numbers: a body of about a person's mass with a glide of 8 at 10 m/s. A game passes its own. */
export const DEFAULT_FLYING_BODY: Readonly<FlyingBodySetup> = Object.freeze({
  hull: Object.freeze([0, 0.5, 0, 0.5]),
  groundHull: null,
  gravity: 9.81,
  stepHz: 60,
  maxStepsPerAdvance: 15,
  groundSpeed: 1.5,
  groundBackSpeed: 0.6,
  groundAcceleration: 3,
  groundDeceleration: 5,
  landingDeceleration: 6,
  groundTurnSpeed: 1.5,
  maxStepUp: 0.3,
  maxStepDown: 0.4,
  leapSpeed: 4,
  leapForwardSpeed: 2,
  trimSpeed: 10,
  glideRatio: 8,
  minLift: 0.3,
  maxLift: 1.8,
  maxLoad: 3,
  turnLift: 1,
  stallSpeed: 6,
  stallBand: 1,
  stallLift: 0.3,
  pathDamping: 1,
  maxBank: 0.8,
  bankRate: 1.5,
  noseAngle: 0.25,
  attitudeRate: 4,
  beatRate: 2,
  softBeatRate: Number.NaN,
  beatThrust: 5,
  beatLift: 4,
  beatPulse: 0,
  beatEase: 0.25,
  flareDrag: 3,
  flareLift: 0.6,
  fastDrag: 0,
  ceilingY: Infinity,
  ceilingBand: 10,
  restitution: 0,
  scrapeFriction: 0.3,
  skipTag: Number.NaN,
});

/** Numbers of one saved state (`FlyingBody.saveState`). */
const STATE_FLOATS = 40;
/** Bytes of one saved state (`FlyingBody.saveState`). */
export const FLYING_BODY_STATE_BYTES = STATE_FLOATS * 8;
const STATE_VERSION = 1;
/** Contacts read per hull sphere at most. */
const PER_SPHERE = 6;
/** Push-out passes per sub-step. */
const PASSES = 2;
/** Most sub-steps per step. */
const MAX_SUBSTEPS = 24;
/** Below this speed in the air the path has no direction: no lift, the heading stays, m/s. */
const MIN_AIR_SPEED = 0.5;
/** A contact normal steeper than this up counts as a floor (the ground holds a grounded body), not a side. */
const FLOOR_NY = 0.7;
/** The position within this above the ground under it, not rising faster than `LAND_RISE`, touches down, m and m/s. */
const LAND_GAP = 0.03;
const LAND_RISE = 0.5;
/** Slower than this in the air the drawn pitch no longer follows the path but levels out, m/s. */
const PITCH_SPEED = 2;
/** Slower than this in the air, held up by a contact from below, the body is put down there (perched), m/s. */
const PERCH_SPEED = 1;
/** How far below the hull a perched body looks for its hold, m. */
const PERCH_PROBE = 0.05;
/** Farthest a perched body that levels out sinks in one step to stay on its hold, m. */
const PERCH_SETTLE = 0.3;
/** Less levelling than this in a step (pitch and bank, rad) leaves a perched body's hold as it is. */
const PERCH_LEVELLED = 1e-6;
const PI = Math.PI;
const TWO_PI = 2 * Math.PI;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * A body that crawls and flies over a `CollisionWorld` (see the file comment). Call `advance(dt, intent)` once per
 * frame (or `step` from a script) and draw at `renderPosition`, `renderYaw`, `renderPitch`, `renderBank` or
 * `renderMatrix`.
 */
export class FlyingBody {
  readonly setup: FlyingBodySetup;
  readonly world: CollisionWorld;
  /** The point under the middle of the body, metres. */
  readonly position = new Float64Array(3);
  readonly velocity = new Float64Array(3);
  /** Heading, radians (0 faces −z); in the air it follows the path. */
  yaw = 0;
  /** Drawn pitch (nose up +) and bank (right side down +), radians. */
  pitch = 0;
  bank = 0;
  /** On the ground (crawling) rather than in the air. */
  grounded = true;
  /** Grounded on a hold of its hull (a solid that is not ground, or the ground under a sphere off the middle) rather than on the ground under its position. */
  perched = false;
  /** The beats' cycle, 0–1 (0 the top of the stroke, 0.5 the bottom), and the eased effort of the beats, 0–1. */
  beatPhase = 0;
  beatEffort = 0;
  /** The eased flare, 0–1. */
  flare = 0;
  /** The lift coefficient and the lift as a multiple of the weight in the last step (0 on the ground). */
  liftCoefficient = 0;
  load = 0;
  /** Below the stall speed in the air in the last step. */
  stalled = false;
  /** Height of the ground under the body in the last step (the highest standable surface below it), m. */
  groundY = 0;
  /** Leaps off the ground and touch-downs so far; the downward speed of the last touch-down, m/s. */
  takeOffs = 0;
  touchDowns = 0;
  touchDownSpeed = 0;
  /** Contacts of the hull with solids or the ground in the last step (the ground under a crawling body not counted). */
  contacts = 0;
  /** Fastest speed into a contact in the last step, m/s. */
  impactSpeed = 0;
  /** Fixed steps since construction or the last `teleport`. */
  steps = 0;

  private readonly dt: number;
  private readonly fixed: FixedSteps;
  private dueIntent: FlyingIntent | null = null;
  private duePrepare: ((intent: FlyingIntent) => void) | null = null;
  /** A solid held the hull up from below in the last move through the air. */
  private held = false;
  private readonly prev = new Float64Array(3);
  private prevYaw = 0;
  private prevPitch = 0;
  private prevBank = 0;
  private prevPhase = 0;
  /** Columns of the attitude: right, up, back. */
  private readonly R = new Float64Array(9);
  private readonly touch = newSphereContacts(PER_SPHERE);
  private readonly minRadius: number;
  private readonly sc: [number, number] = [0, 0];
  private readonly stateScratch = new Float64Array(STATE_FLOATS);
  private readonly stateView = new Uint8Array(this.stateScratch.buffer);

  constructor(world: CollisionWorld, setup?: Partial<FlyingBodySetup>) {
    this.world = world;
    this.setup = { ...DEFAULT_FLYING_BODY, ...setup };
    const s = this.setup;
    if (!(s.stepHz > 0)) throw new Error('FlyingBody: stepHz must be positive');
    if (!(s.trimSpeed > 0) || !(s.glideRatio > 0)) throw new Error('FlyingBody: trimSpeed and glideRatio must be positive');
    let rmin = Infinity;
    for (const hull of [s.hull, s.groundHull ?? s.hull]) {
      if (hull.length < 4 || hull.length % 4 !== 0) throw new Error('FlyingBody: a hull is spheres of four numbers each');
      for (let i = 3; i < hull.length; i += 4) {
        if (!(hull[i]! > 0)) throw new Error('FlyingBody: a hull sphere needs a positive radius');
        if (hull[i]! < rmin) rmin = hull[i]!;
      }
    }
    this.minRadius = rmin;
    this.dt = 1 / s.stepHz;
    this.fixed = new FixedSteps(this.dt, s.maxStepsPerAdvance);
    this.updateAttitude();
  }

  /** Seconds of one fixed step. */
  get stepSeconds(): number {
    return this.dt;
  }

  /** Share of the way from the last step to the next one, 0–1. */
  get alpha(): number {
    return this.fixed.alpha;
  }

  /** Length of the velocity, m/s. */
  get speed(): number {
    const v = this.velocity;
    return Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
  }

  /** Speed along the heading, m/s (negative backward). */
  get forwardSpeed(): number {
    const sc = detSinCos(this.yaw, this.sc);
    return -(this.velocity[0]! * sc[0] + this.velocity[2]! * sc[1]);
  }

  /** Height of the position above the ground under it, m (0 on the ground). */
  get altitude(): number {
    return this.position[1]! - this.groundY;
  }

  /**
   * Puts the body at a point with heading `yaw` (left out: it keeps its heading, as `Walker.teleport`), still, on the ground when the ground there is within `maxStepUp`
   * below `y` (it is set onto it), otherwise in the air.
   */
  teleport(x: number, y: number, z: number, yaw?: number): void {
    if (yaw === undefined) yaw = this.yaw;
    const p = this.position;
    const g = this.world.groundAt(x, z, y, this.setup.maxStepUp);
    this.grounded = y - g <= this.setup.maxStepUp;
    this.perched = false;
    this.held = false;
    p[0] = x;
    p[1] = this.grounded ? g : y;
    p[2] = z;
    this.groundY = g;
    this.velocity.fill(0);
    this.yaw = wrap(yaw);
    this.pitch = 0;
    this.bank = 0;
    this.beatEffort = 0;
    this.flare = 0;
    this.liftCoefficient = 0;
    this.load = 0;
    this.stalled = false;
    this.contacts = 0;
    this.impactSpeed = 0;
    this.steps = 0;
    this.fixed.reset();
    this.prev.set(p);
    this.prevYaw = this.yaw;
    this.prevPitch = 0;
    this.prevBank = 0;
    this.prevPhase = this.beatPhase;
    this.updateAttitude();
  }

  /**
   * Advances by real seconds in fixed steps; returns the number of steps taken. Leftover time carries to the next call,
   * so one call of 1/30 s and two of 1/60 s end in the same place. A `takeOff` is seen by the first step only.
   * `prepare`, when given, is called with `intent` before every step, so a controller can write the intent from the
   * state of that step (`FlightAssist.advance` does); make it once, not per call.
   */
  advance(dt: number, intent: FlyingIntent, prepare?: (intent: FlyingIntent) => void): number {
    if (!(dt > 0)) return 0;
    this.dueIntent = intent;
    this.duePrepare = prepare ?? null;
    const n = this.fixed.advance(dt, this.stepDue, this.setup.maxStepsPerAdvance);
    this.dueIntent = null;
    this.duePrepare = null;
    return n;
  }

  private readonly stepDue = (): void => {
    const i = this.dueIntent!;
    if (this.duePrepare) this.duePrepare(i);
    this.step(i);
    i.takeOff = false;
  };

  /** One fixed step (for scripts and tests). */
  step(intent: FlyingIntent): void {
    const s = this.setup;
    const dt = this.dt;
    const p = this.position;
    this.prev.set(p);
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.prevBank = this.bank;
    this.prevPhase = this.beatPhase;
    this.contacts = 0;
    this.impactSpeed = 0;
    // The beats' effort and the flare, eased; the cycle runs while there is effort.
    const ease = s.beatEase > 0 ? dt / s.beatEase : 1;
    this.beatEffort += clamp(clamp(intent.beat, 0, 1) - this.beatEffort, -ease, ease);
    this.flare += clamp((this.grounded ? 0 : clamp(intent.brake, 0, 1)) - this.flare, -ease, ease);
    if (this.beatEffort > 1e-3) {
      this.beatPhase += (!Number.isNaN(s.softBeatRate) ? s.softBeatRate + (s.beatRate - s.softBeatRate) * this.beatEffort : s.beatRate) * dt;
      this.beatPhase -= Math.floor(this.beatPhase);
    }
    if (this.grounded) this.groundStep(intent);
    else this.airStep(intent);
    this.steps++;
  }

  // --- The ground -------------------------------------------------------------------------------------------------------

  private groundStep(intent: FlyingIntent): void {
    const s = this.setup;
    const dt = this.dt;
    const p = this.position;
    const v = this.velocity;
    this.held = false;
    // The heading: turned at the crawl's rate (positive turn to the right, which lowers the yaw).
    this.yaw = wrap(this.yaw - clamp(intent.turn, -1, 1) * s.groundTurnSpeed * dt);
    const sc = detSinCos(this.yaw, this.sc);
    const fx = -sc[0], fz = -sc[1];
    // The speed along the heading, toward the wanted one.
    let u = v[0]! * fx + v[2]! * fz;
    const ask = clamp(intent.forward, -1, 1) * (1 - clamp(intent.brake, 0, 1));
    const want = ask >= 0 ? ask * s.groundSpeed : ask * s.groundBackSpeed;
    const over = u > s.groundSpeed || u < -s.groundBackSpeed;
    const rate = over ? s.landingDeceleration : (want > 0 ? u < want : u > want) && Math.abs(want) > Math.abs(u) - 1e-9 ? s.groundAcceleration : s.groundDeceleration;
    u += clamp(want - u, -rate * dt, rate * dt);
    v[0] = fx * u;
    v[1] = 0;
    v[2] = fz * u;
    // Pitch and bank level out.
    const k = clamp(s.attitudeRate * dt, 0, 1);
    const levelled = Math.abs(this.pitch * k) + Math.abs(this.bank * k);
    this.pitch -= this.pitch * k;
    this.bank -= this.bank * k;
    this.updateAttitude();
    // Move, held back sideways by solids.
    this.move(dt, true);
    // The ground under it: stepped onto, or left over a drop.
    const g = this.world.groundAt(p[0]!, p[2]!, p[1]!, s.maxStepUp);
    this.groundY = g;
    if (this.perched) {
      // On a hold: onto the ground when it is near, into the air when the hold is gone.
      if (g >= p[1]! - s.maxStepDown) {
        this.perched = false;
        p[1] = g;
      } else if (levelled > PERCH_LEVELLED && this.settle(g)) {
        // Put down at a slant, levelling out lifts the hull off its hold: it settles down onto it (or the ground).
      } else if (this.holdBelow() > 0) this.groundY = p[1]!;
      else {
        this.perched = false;
        this.grounded = false;
      }
    } else if (g < p[1]! - s.maxStepDown) {
      this.grounded = false;
    } else p[1] = g;
    this.liftCoefficient = 0;
    this.load = 0;
    this.stalled = false;
    if (intent.takeOff && this.grounded) {
      // UP: the leap is along the world's up.
      v[0] = v[0]! + fx * s.leapForwardSpeed;
      v[1] = v[1]! + s.leapSpeed;
      v[2] = v[2]! + fz * s.leapForwardSpeed;
      this.grounded = false;
      this.takeOffs++;
    }
  }

  // --- The air ----------------------------------------------------------------------------------------------------------

  private airStep(intent: FlyingIntent): void {
    const s = this.setup;
    const dt = this.dt;
    const p = this.position;
    const v = this.velocity;
    // The bank toward the asked one at its rate.
    const wantBank = clamp(intent.turn, -1, 1) * s.maxBank;
    this.bank += clamp(wantBank - this.bank, -s.bankRate * dt, s.bankRate * dt);
    const V = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
    // The path's direction (the heading's when there is too little speed).
    let tx: number, ty: number, tz: number;
    if (V > MIN_AIR_SPEED) {
      tx = v[0]! / V;
      ty = v[1]! / V;
      tz = v[2]! / V;
    } else {
      const sc = detSinCos(this.yaw, this.sc);
      tx = -sc[0];
      ty = 0;
      tz = -sc[1];
    }
    // The lift coefficient: pitch, flare and the share that holds a banked turn level.
    const pitchIn = clamp(intent.pitch, -1, 1);
    let cl = 1 + (pitchIn >= 0 ? pitchIn * (s.maxLift - 1) : pitchIn * (1 - s.minLift)) + this.flare * s.flareLift;
    const cb = detSinCos(this.bank, this.sc)[1];
    if (cb > 0.05) cl *= 1 + s.turnLift * (1 / cb - 1);
    const q = (V * V) / (s.trimSpeed * s.trimSpeed);
    // Stall: the lift falls over the band about the stall speed.
    const x = s.stallBand > 0 ? clamp((V - s.stallSpeed) / s.stallBand + 0.5, 0, 1) : V >= s.stallSpeed ? 1 : 0;
    const share = s.stallLift + (1 - s.stallLift) * x * x * (3 - 2 * x);
    this.stalled = V < s.stallSpeed;
    // Thin air under the ceiling.
    const ceil = s.ceilingBand > 0 ? clamp((s.ceilingY - p[1]!) / s.ceilingBand, 0, 1) : p[1]! < s.ceilingY ? 1 : 0;
    // The beats' push, pulsing with the stroke when `beatPulse` asks it.
    const pulse = 1 + s.beatPulse * detSinCosTurns(this.beatPhase - 0.25, this.sc)[1];
    const push = this.beatEffort * (pulse > 0 ? pulse : 0) * ceil;
    let drag = (s.gravity / s.glideRatio) * q * ((1 + cl * cl) / 2 + this.flare * s.flareDrag);
    if (s.fastDrag > 0 && q > 1) drag += (s.gravity / s.glideRatio) * s.fastDrag * (q - 1) * (q - 1);
    // Path damping: the lift eases off while the speed along the path falls (a climb that bleeds speed) and grows while
    // it rises (a dive), which damps the slow swing between them. UP: gravity's share along the path.
    const along = -drag - s.gravity * ty;
    const damp = 1 + (s.pathDamping * along) / s.gravity;
    let lift = s.gravity * q * cl * share * ceil * (damp > 0 ? damp : 0);
    lift = clamp(lift, 0, s.maxLoad * s.gravity);
    if (!(V > MIN_AIR_SPEED)) lift = 0;
    this.liftCoefficient = cl * share;
    this.load = lift / s.gravity;
    // The lift's direction: the path's up turned by the bank about the path. Right = level right of the heading.
    const sc = detSinCos(this.yaw, this.sc);
    const rx = sc[1], rz = -sc[0];
    // Path's up = right × path; the path's right = path × up.
    let ux = -rz * ty, uy = rz * tx - rx * tz, uz = rx * ty;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const px = ty * uz - tz * uy, py = tz * ux - tx * uz, pz = tx * uy - ty * ux;
    const bsc = detSinCos(this.bank, this.sc);
    const sb = bsc[0], cbk = bsc[1];
    const lx = ux * cbk + px * sb, ly = uy * cbk + py * sb, lz = uz * cbk + pz * sb;
    // UP: gravity and the beats' lift along the world's up.
    v[0] = v[0]! + (lift * lx - drag * tx + push * s.beatThrust * tx) * dt;
    v[1] = v[1]! + (lift * ly - drag * ty + push * s.beatThrust * ty + push * s.beatLift - s.gravity) * dt;
    v[2] = v[2]! + (lift * lz - drag * tz + push * s.beatThrust * tz) * dt;
    // The heading follows the path.
    // The heading follows the path, but never round through a stall: only while the path goes forward of it.
    const hx = v[0]!, hz = v[2]!;
    const hf = detSinCos(this.yaw, this.sc);
    if (hx * hx + hz * hz > MIN_AIR_SPEED * MIN_AIR_SPEED && -(hx * hf[0] + hz * hf[1]) > 0) this.yaw = detAtan2(-hx, -hz);
    // The drawn pitch: the path's angle plus the nose above it; nearly without a path (at the top of a stall, dropping
    // off a hold) or while held up from below the body levels out.
    const k = clamp(s.attitudeRate * dt, 0, 1);
    if (V > PITCH_SPEED && !this.held) {
      const h = Math.sqrt(hx * hx + hz * hz);
      const nose = clamp(detAtan2(v[1]!, h) + s.noseAngle * (cl - 1), -1.2, 1.2);
      this.pitch += (nose - this.pitch) * k;
    } else {
      this.pitch -= this.pitch * k;
      this.bank -= this.bank * k;
    }
    this.updateAttitude();
    this.move(dt, false);
    // Touch-down: the position at the ground under it, not rising.
    const g = this.world.groundAt(p[0]!, p[2]!, p[1]! + LAND_GAP, 0);
    this.groundY = g;
    if (p[1]! <= g + LAND_GAP && v[1]! <= LAND_RISE) {
      this.touchDownSpeed = v[1]! < 0 ? -v[1]! : 0;
      p[1] = g;
      v[1] = 0;
      // The speed along the heading is kept; the rest is lost in the touch-down.
      const f = detSinCos(this.yaw, this.sc);
      const u = -(v[0]! * f[0] + v[2]! * f[1]);
      v[0] = -f[0] * u;
      v[2] = -f[1] * u;
      this.grounded = true;
      this.touchDowns++;
    } else if (this.held && v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]! < PERCH_SPEED * PERCH_SPEED) {
      // At rest on a hold that is not ground: put down there.
      this.touchDownSpeed = 0;
      v[0] = 0;
      v[1] = 0;
      v[2] = 0;
      this.grounded = true;
      this.perched = true;
      this.touchDowns++;
    }
  }

  /**
   * A perched body levelling out sinks with it, by at most `PERCH_SETTLE` in this step, so the hull rests on its hold
   * (perched there, touching) or the ground under the middle is within `maxStepDown` (down on it). Returns false, the
   * position unchanged, when neither is in reach.
   */
  private settle(g: number): boolean {
    const p = this.position, top = p[1]!;
    for (let d = 0; d <= PERCH_SETTLE + 1e-9; d += PERCH_PROBE) {
      p[1] = top - d;
      if (g >= p[1]! - this.setup.maxStepDown) {
        p[1] = g;
        this.perched = false;
        return true;
      }
      const depth = this.holdBelow();
      if (depth > 0) {
        // Down onto the hold itself (the probe reaches PERCH_PROBE lower than the hull).
        if (depth < PERCH_PROBE) p[1] = p[1]! - (PERCH_PROBE - depth);
        this.groundY = p[1]!;
        return true;
      }
    }
    p[1] = top;
    return false;
  }

  /**
   * How deep the hull, `PERCH_PROBE` lower, sinks into a solid or the ground from above (a perched body's hold), m; 0
   * when it rests on nothing.
   */
  private holdBelow(): number {
    const s = this.setup;
    const p = this.position, R = this.R, c = this.touch, hull = s.hull;
    let deepest = 0;
    for (let i = 0; i + 3 < hull.length; i += 4) {
      const lx = hull[i]!, ly = hull[i + 1]!, lz = hull[i + 2]!, r = hull[i + 3]!;
      const cx = p[0]! + R[0]! * lx + R[3]! * ly + R[6]! * lz;
      const cy = p[1]! + R[1]! * lx + R[4]! * ly + R[7]! * lz - PERCH_PROBE;
      const cz = p[2]! + R[2]! * lx + R[5]! * ly + R[8]! * lz;
      const m = this.world.sphereContacts(cx, cy, cz, r, c, s.skipTag);
      for (let j = 0; j < m; j++) if (c.depth[j]! > deepest && c.ny[j]! > FLOOR_NY) deepest = c.depth[j]!;
    }
    return deepest;
  }

  // --- Moving with the hull ---------------------------------------------------------------------------------------------

  /**
   * Moves by the velocity over `dt` in sub-steps, the hull's spheres pushed out of what they overlap after each. On the
   * ground only sides push (sideways) and the ground holds the body.
   */
  private move(dt: number, onGround: boolean): void {
    const s = this.setup;
    const p = this.position;
    const v = this.velocity;
    const hull = onGround && s.groundHull && !this.perched ? s.groundHull : s.hull;
    if (!onGround) this.held = false;
    const V = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
    let n = Math.ceil((V * dt) / (0.5 * this.minRadius));
    if (n < 1) n = 1;
    if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
    const h = dt / n;
    const R = this.R;
    const c = this.touch;
    for (let k = 0; k < n; k++) {
      p[0] = p[0]! + v[0]! * h;
      p[1] = p[1]! + v[1]! * h;
      p[2] = p[2]! + v[2]! * h;
      for (let pass = 0; pass < PASSES; pass++) {
        let moved = false;
        for (let i = 0; i + 3 < hull.length; i += 4) {
          const lx = hull[i]!, ly = hull[i + 1]!, lz = hull[i + 2]!, r = hull[i + 3]!;
          const cx = p[0]! + R[0]! * lx + R[3]! * ly + R[6]! * lz;
          const cy = p[1]! + R[1]! * lx + R[4]! * ly + R[7]! * lz;
          const cz = p[2]! + R[2]! * lx + R[5]! * ly + R[8]! * lz;
          const m = this.world.sphereContacts(cx, cy, cz, r, c, s.skipTag);
          for (let j = 0; j < m; j++) {
            let nx = c.nx[j]!, ny = c.ny[j]!, nz = c.nz[j]!;
            let d = c.depth[j]!;
            if (!(d > 0)) continue;
            if (onGround) {
              // The ground under a crawling body is its footing, not a contact: only sides push, sideways.
              if (c.solid[j]! < 0 || ny > FLOOR_NY) continue;
              const l = Math.sqrt(nx * nx + nz * nz);
              if (!(l > 1e-6)) continue;
              d *= l;
              nx /= l;
              nz /= l;
              ny = 0;
            }
            p[0] = p[0]! + nx * d;
            p[1] = p[1]! + ny * d;
            p[2] = p[2]! + nz * d;
            moved = true;
            if (!onGround && ny > FLOOR_NY) this.held = true;
            if (pass === 0) this.contacts++;
            const vn = v[0]! * nx + v[1]! * ny + v[2]! * nz;
            if (vn < 0) {
              if (-vn > this.impactSpeed) this.impactSpeed = -vn;
              const back = (1 + s.restitution) * vn;
              v[0] = v[0]! - nx * back;
              v[1] = v[1]! - ny * back;
              v[2] = v[2]! - nz * back;
              // Friction along the contact, at most stopping the sliding.
              const tx = v[0]! - nx * (v[0]! * nx + v[1]! * ny + v[2]! * nz);
              const ty = v[1]! - ny * (v[0]! * nx + v[1]! * ny + v[2]! * nz);
              const tz = v[2]! - nz * (v[0]! * nx + v[1]! * ny + v[2]! * nz);
              const t = Math.sqrt(tx * tx + ty * ty + tz * tz);
              if (t > 1e-9) {
                const cut = s.scrapeFriction * -vn;
                const f = cut >= t ? 1 : cut / t;
                v[0] = v[0]! - tx * f;
                v[1] = v[1]! - ty * f;
                v[2] = v[2]! - tz * f;
              }
            }
          }
        }
        if (!moved) break;
      }
    }
  }

  /** The attitude's columns (right, up, back) from yaw, pitch and bank: Ry(yaw) · Rx(pitch) · Rz(−bank). */
  private updateAttitude(): void {
    attitudeColumns(this.yaw, this.pitch, this.bank, this.R, this.sc);
  }

  // --- Drawing ----------------------------------------------------------------------------------------------------------

  /** Position between the last two steps for drawing. `alpha`: default the body's own (from `advance`). */
  renderPosition(out: Float64Array | number[], alpha?: number): void {
    const a = this.alphaOf(alpha);
    const p = this.position, q = this.prev;
    out[0] = q[0]! + (p[0]! - q[0]!) * a;
    out[1] = q[1]! + (p[1]! - q[1]!) * a;
    out[2] = q[2]! + (p[2]! - q[2]!) * a;
  }

  /** Heading between the last two steps for drawing, radians. */
  renderYaw(alpha?: number): number {
    return lerpAngle(this.prevYaw, this.yaw, this.alphaOf(alpha));
  }

  /** Pitch between the last two steps for drawing, radians. */
  renderPitch(alpha?: number): number {
    const a = this.alphaOf(alpha);
    return this.prevPitch + (this.pitch - this.prevPitch) * a;
  }

  /** Bank between the last two steps for drawing, radians. */
  renderBank(alpha?: number): number {
    const a = this.alphaOf(alpha);
    return this.prevBank + (this.bank - this.prevBank) * a;
  }

  /** The beats' cycle between the last two steps for drawing, 0–1. */
  renderBeatPhase(alpha?: number): number {
    const a = this.alphaOf(alpha);
    let d = this.beatPhase - this.prevPhase;
    if (d < 0) d += 1;
    const ph = this.prevPhase + d * a;
    return ph - Math.floor(ph);
  }

  /**
   * Pose between the last two steps for drawing as a 3 × 4 matrix: the body's frame (+x right, +y up, +z back, origin
   * the position) to the world.
   */
  renderMatrix(out: Mat34, alpha?: number): Mat34 {
    const a = this.alphaOf(alpha);
    attitudeColumns(lerpAngle(this.prevYaw, this.yaw, a), this.prevPitch + (this.pitch - this.prevPitch) * a, this.prevBank + (this.bank - this.prevBank) * a, out, this.sc);
    const p = this.position, q = this.prev;
    out[9] = q[0]! + (p[0]! - q[0]!) * a;
    out[10] = q[1]! + (p[1]! - q[1]!) * a;
    out[11] = q[2]! + (p[2]! - q[2]!) * a;
    return out;
  }

  private alphaOf(alpha: number | undefined): number {
    return alpha === undefined ? this.fixed.alpha : alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  }

  // --- State ------------------------------------------------------------------------------------------------------------

  /**
   * Writes the whole moving state (position, velocity, attitude, ground contact, the beats, the previous step for
   * drawing, leftover time, the counters) into `out` (at least `FLYING_BODY_STATE_BYTES` from `offset`; default a new
   * array) and returns it. The setup and the collision world are not state.
   */
  saveState(out?: Uint8Array, offset = 0): Uint8Array {
    const f = this.stateScratch;
    f[0] = STATE_VERSION;
    f.set(this.position, 1);
    f.set(this.velocity, 4);
    f[7] = this.yaw;
    f[8] = this.pitch;
    f[9] = this.bank;
    f[10] = this.grounded ? 1 : 0;
    f[11] = this.beatPhase;
    f[12] = this.beatEffort;
    f[13] = this.flare;
    f[14] = this.liftCoefficient;
    f[15] = this.load;
    f[16] = this.stalled ? 1 : 0;
    f[17] = this.groundY;
    f[18] = this.takeOffs;
    f[19] = this.touchDowns;
    f[20] = this.touchDownSpeed;
    f[21] = this.contacts;
    f[22] = this.impactSpeed;
    f[23] = this.steps;
    f.set(this.prev, 24);
    f[27] = this.prevYaw;
    f[28] = this.prevPitch;
    f[29] = this.prevBank;
    f[30] = this.prevPhase;
    f[31] = this.fixed.leftover;
    f[32] = this.perched ? 1 : 0;
    f[33] = this.held ? 1 : 0;
    for (let i = 34; i < STATE_FLOATS; i++) f[i] = 0;
    const o = out ?? new Uint8Array(FLYING_BODY_STATE_BYTES);
    if (o.length < offset + FLYING_BODY_STATE_BYTES) throw new Error('FlyingBody.saveState: the output is too short');
    o.set(this.stateView, offset);
    return o;
  }

  /** Restores a state written by `saveState` (of a body with the same setup). */
  loadState(bytes: Uint8Array, offset = 0): void {
    if (bytes.length < offset + FLYING_BODY_STATE_BYTES) throw new Error('FlyingBody.loadState: too few bytes');
    const f = this.stateScratch;
    this.stateView.set(bytes.subarray(offset, offset + FLYING_BODY_STATE_BYTES));
    if (f[0] !== STATE_VERSION) throw new Error('FlyingBody.loadState: not a flying body state');
    this.position.set(f.subarray(1, 4));
    this.velocity.set(f.subarray(4, 7));
    this.yaw = f[7]!;
    this.pitch = f[8]!;
    this.bank = f[9]!;
    this.grounded = f[10] === 1;
    this.beatPhase = f[11]!;
    this.beatEffort = f[12]!;
    this.flare = f[13]!;
    this.liftCoefficient = f[14]!;
    this.load = f[15]!;
    this.stalled = f[16] === 1;
    this.groundY = f[17]!;
    this.takeOffs = f[18]!;
    this.touchDowns = f[19]!;
    this.touchDownSpeed = f[20]!;
    this.contacts = f[21]!;
    this.impactSpeed = f[22]!;
    this.steps = f[23]!;
    this.prev.set(f.subarray(24, 27));
    this.prevYaw = f[27]!;
    this.prevPitch = f[28]!;
    this.prevBank = f[29]!;
    this.prevPhase = f[30]!;
    this.fixed.leftover = f[31]!;
    this.perched = f[32] === 1;
    this.held = f[33] === 1;
    this.updateAttitude();
  }

  /** This body as a part of a simulation's state (`Simulation.addState`), like `Walker.simState`. */
  simState(name: string): WalkerSimState {
    const buf = new Uint8Array(FLYING_BODY_STATE_BYTES);
    return {
      name,
      save: (w) => w.bytes(this.saveState(buf)),
      load: (r) => {
        r.into(buf);
        this.loadState(buf);
      },
    };
  }
}

function wrap(a: number): number {
  let y = a;
  while (y > PI) y -= TWO_PI;
  while (y <= -PI) y += TWO_PI;
  return y;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > PI) d -= TWO_PI;
  else if (d < -PI) d += TWO_PI;
  return a + d * t;
}

/** Columns right, up, back of Ry(yaw) · Rx(pitch) · Rz(−bank) into `out[0..8]`. */
function attitudeColumns(yaw: number, pitch: number, bank: number, out: Mat34 | Float64Array, sc: [number, number]): void {
  const y = detSinCos(yaw, sc);
  const sy = y[0], cy = y[1];
  const p = detSinCos(pitch, sc);
  const sp = p[0], cp = p[1];
  const b = detSinCos(-bank, sc);
  const sb = b[0], cb = b[1];
  // Rx(p) · Rz(b): columns (cb, cp·sb, sp·sb), (−sb, cp·cb, sp·cb), (0, −sp, cp).
  const a0 = cb, a1 = cp * sb, a2 = sp * sb;
  const b0 = -sb, b1 = cp * cb, b2 = sp * cb;
  const c0 = 0, c1 = -sp, c2 = cp;
  // Ry(y) applied: (x, y, z) → (x cy + z sy, y, −x sy + z cy).
  out[0] = a0 * cy + a2 * sy;
  out[1] = a1;
  out[2] = -a0 * sy + a2 * cy;
  out[3] = b0 * cy + b2 * sy;
  out[4] = b1;
  out[5] = -b0 * sy + b2 * cy;
  out[6] = c0 * cy + c2 * sy;
  out[7] = c1;
  out[8] = -c0 * sy + c2 * cy;
}
