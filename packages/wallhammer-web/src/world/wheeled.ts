// Wheeled body: one rigid body (a box of mass with a box inertia) carried on wheel rays over a collision world, in
// fixed steps. Each step casts one ray per wheel down the body's own down axis (`CollisionWorld.raycast`: the base
// surface and the tops of solids that block sight), pushes with a spring and a damper along the ground's normal at the
// contact, and then solves the tyres' forces in the contact plane: a drive force, a friction that opposes rolling
// (brake, rolling resistance, engine braking) and a lateral grip bounded by a saturating curve of the slip angle, all
// inside a friction circle of grip × load. The hull is a set of spheres along the box plus one at each wheel's bump
// stop (`CollisionWorld.sphereContacts`): it is pushed out of the base surface and the solids with a restitution and a
// friction, with the angular response, in sub-steps; each sphere is queried larger by what it can travel in the
// sub-step, so a gap that would close is found before it does and no wall is passed through, however thin. A body that
// has stood still for a while sleeps (no drift, no jitter) until the intent or the ground under its wheels changes.
// Other wheeled bodies are met through sphere-pair impulses (`collideWheeledBodies`, `WheeledGroup`); walkers meet a
// box kept round the hull (`syncObstacle`).
//
// Only + − × ÷, Math.sqrt and the reproducible detAtan2 and detSinCos run in a step, so the same inputs give the same
// bits; a step allocates nothing.
//
// Frames: the body's frame has its origin at the centre of mass, +x to the right, +y up and −z forward (yaw 0 faces
// −z, as for a view and the walker). Scope: a flat world with +y up; gravity is along −y. A curved world would wrap this
// in a moving chart the way `ChartWalker` wraps `Walker` (see the guide); the places where a local up would replace y
// are marked "UP:" below.

import type { Mat34 } from '../base/mat34.ts';
import { detAtan2, detSinCos } from '../base/trig.ts';
import { FixedSteps } from '../core/fixed-steps.ts';
import { newRayHit, newSphereContacts } from './collide.ts';
import type { CollisionWorld } from './collide.ts';
import type { WalkerSimState } from './walker.ts';

/** One wheel: a ray from a mount point down the body's down axis, a spring and damper, and a tyre at the contact. */
export interface WheelSpec {
  /** Mount point in the body's frame (origin the centre of mass, +x right, +y up, −z forward), metres. */
  x: number;
  y: number;
  z: number;
  /** Radius of the wheel, metres. */
  radius: number;
  /** Spring length with no load: the wheel's centre this far below the mount at full droop, metres. */
  restLength: number;
  /** How far the spring compresses from `restLength` before the bump stop, metres. */
  travel: number;
  /** Spring stiffness, N/m. */
  stiffness: number;
  /** Damping of the spring, N·s/m. */
  damping: number;
  /** Turned by the steering. */
  steers: boolean;
  /** Takes a share of the drive force (the force is split evenly among the driven wheels). */
  driven: boolean;
  /** Locked by the handbrake. */
  handbrake: boolean;
  /** Factor on the body's `grip` for this wheel (less on the steered wheels than on the others makes the body turn wider than steered as the tyres saturate). */
  grip: number;
}

export interface WheeledBodySetup {
  /** Mass, kg. */
  mass: number;
  /** Half the width, height and length of the hull box, metres (the box also gives the inertia). */
  halfWidth: number;
  halfHeight: number;
  halfLength: number;
  /** Height of the hull box's centre above the centre of mass, metres. */
  hullY: number;
  /** Radius of the hull's spheres, metres; 0 (default): 0.75 × the smaller of `halfWidth` and `halfHeight`. */
  hullRadius: number;
  /** Factor on the box inertia (above 1: slower to turn and to roll). */
  inertiaScale: number;
  /** The wheels; `fourWheels(options)` makes a usual set. */
  wheels: readonly WheelSpec[];
  /** Downward acceleration, m/s². */
  gravity: number;
  /** Fixed steps per second. */
  stepHz: number;
  /** Most fixed steps one `advance` takes; the rest of a longer pause is dropped. */
  maxStepsPerAdvance: number;
  /** Drive force at a standstill, N, split among the driven wheels; it falls as 1 − (speed / topSpeed)². */
  driveForce: number;
  /** Speed at which the drive force has fallen to 0, m/s (drag and rolling keep the real top speed a little lower). */
  topSpeed: number;
  /** Drive force backward at a standstill, N. */
  reverseForce: number;
  /** Speed backward at which the reverse force has fallen to 0, m/s. */
  reverseSpeed: number;
  /** Brake force of all wheels together at `brake` 1, N (each wheel's share is limited by its grip). */
  brakeForce: number;
  /** Force of the engine against rolling while there is no throttle, N, on the driven wheels. */
  engineBrake: number;
  /** Rolling resistance, a share of each wheel's load. */
  rollingResistance: number;
  /** Air drag, N per (m/s)² (the force is drag × speed²). */
  drag: number;
  /** Friction coefficient of the tyres at the peak of their curve. */
  grip: number;
  /** Slip angle at which the lateral grip peaks, radians. */
  peakSlip: number;
  /** Share of the peak grip left when sliding (at 3 × `peakSlip` and beyond); below 1, a slide holds less than the peak. */
  slideGrip: number;
  /** Share of the grip a wheel locked by the handbrake keeps sideways (it keeps the whole grip along its rolling). */
  handbrakeGrip: number;
  /** How much the grip falls per extra share of load: μ × (1 − this × (load / static load − 1)). */
  loadSensitivity: number;
  /** Below this speed at a wheel, m/s, its lateral grip blends into a full static hold (no creeping, no slip-angle noise). */
  lowSpeed: number;
  /** Steer angle at full steer at a standstill, radians. */
  maxSteer: number;
  /** Fastest change of the steer angle, radians per second. */
  steerRate: number;
  /** Speed at which the steer angle at full steer is halved, m/s (it is maxSteer / (1 + (speed / this)²)); 0: never reduced. */
  steerFallSpeed: number;
  /** Restitution of the hull against solids and the ground (0–1), for impacts faster than `bounceSpeed`. */
  restitution: number;
  /** Impacts of the hull slower than this do not bounce, m/s (between two bodies the larger of their two). Default 1. */
  bounceSpeed: number;
  /** Friction coefficient of the hull against solids and the ground. */
  hullFriction: number;
  /** Stiffness of the bump stop past a spring's `travel`, as a multiple of the spring's stiffness. Default 10. */
  bumpStopFactor: number;
  /** Radius of the hull sphere at each wheel's bump stop, as a share of the wheel's radius. Default 0.8. */
  wheelSphereShare: number;
  /**
   * Forward speed below which a throttle against the motion reverses (or drives forward again) rather than brakes,
   * m/s. Default 1.
   */
  reverseEngageSpeed: number;
  /** Height above the centre of mass that `setUpright` looks down for the ground from, metres. Default 1. */
  uprightProbeHeight: number;
  /** Below this speed (m/s and rad/s) for `sleepSeconds` without throttle, the body sleeps. */
  sleepSpeed: number;
  sleepSeconds: number;
  /**
   * Tag of the solids this body's hull does not touch: its own obstacle box (`syncObstacle`) and those of other
   * wheeled bodies with the same tag (they meet through `collideWheeledBodies` or a `WheeledGroup` instead).
   */
  obstacleTag: number;
}

/** The numbers of a setup that may change while a body lives (`WheeledBody.retune`). */
export type WheeledTuning = Pick<WheeledBodySetup, 'driveForce' | 'topSpeed' | 'reverseForce' | 'reverseSpeed' | 'brakeForce' | 'engineBrake' | 'rollingResistance' | 'drag' | 'grip' | 'peakSlip' | 'slideGrip' | 'handbrakeGrip' | 'loadSensitivity' | 'lowSpeed' | 'maxSteer' | 'steerRate' | 'steerFallSpeed' | 'restitution' | 'hullFriction'>;

/** The fields of `WheeledTuning`. */
export const WHEELED_TUNING_KEYS: readonly (keyof WheeledTuning)[] = ['driveForce', 'topSpeed', 'reverseForce', 'reverseSpeed', 'brakeForce', 'engineBrake', 'rollingResistance', 'drag', 'grip', 'peakSlip', 'slideGrip', 'handbrakeGrip', 'loadSensitivity', 'lowSpeed', 'maxSteer', 'steerRate', 'steerFallSpeed', 'restitution', 'hullFriction'];

/** Default `obstacleTag`: the tag of the obstacle boxes of wheeled bodies. */
export const WHEELED_OBSTACLE_TAG = -7;

export interface FourWheelsOptions {
  /** Half the distance between the left and the right wheel, metres. */
  halfTrack: number;
  /** Mount z of the front and the rear axle in the body's frame (front negative), metres. */
  frontZ: number;
  rearZ: number;
  /** Mount height in the body's frame, metres. */
  mountY: number;
  radius: number;
  restLength: number;
  travel: number;
  stiffness: number;
  damping: number;
  /** Grip factors of the front and the rear wheels. */
  frontGrip: number;
  rearGrip: number;
  /** Which axle is driven. */
  drive: 'front' | 'rear' | 'all';
}

const DEFAULT_FOUR: Readonly<FourWheelsOptions> = Object.freeze({
  halfTrack: 0.78,
  frontZ: -1.3,
  rearZ: 1.3,
  mountY: 0.03,
  radius: 0.33,
  restLength: 0.35,
  travel: 0.22,
  stiffness: 30000,
  damping: 2200,
  frontGrip: 1,
  rearGrip: 1.05,
  drive: 'rear',
});

/**
 * Four wheels on two axles: front left, front right, rear left, rear right. The front wheels steer, the rear ones
 * hold the handbrake; `drive` picks the driven axle. Options left out take the defaults of `DEFAULT_WHEELED_BODY`.
 */
export function fourWheels(options: Partial<FourWheelsOptions> = {}): WheelSpec[] {
  const o = { ...DEFAULT_FOUR, ...options };
  const out: WheelSpec[] = [];
  for (let k = 0; k < 4; k++) {
    const front = k < 2;
    const left = k % 2 === 0;
    out.push({
      x: left ? -o.halfTrack : o.halfTrack,
      y: o.mountY,
      z: front ? o.frontZ : o.rearZ,
      radius: o.radius,
      restLength: o.restLength,
      travel: o.travel,
      stiffness: o.stiffness,
      damping: o.damping,
      steers: front,
      driven: o.drive === 'all' || (o.drive === 'front') === front,
      handbrake: !front,
      grip: front ? o.frontGrip : o.rearGrip,
    });
  }
  return out;
}

export const DEFAULT_WHEELED_BODY: Readonly<WheeledBodySetup> = Object.freeze({
  mass: 1200,
  halfWidth: 0.9,
  halfHeight: 0.6,
  halfLength: 2.1,
  hullY: 0.3,
  hullRadius: 0,
  inertiaScale: 1,
  wheels: Object.freeze(fourWheels().map((w) => Object.freeze(w))),
  gravity: 9.81,
  stepHz: 60,
  maxStepsPerAdvance: 15,
  driveForce: 4600,
  topSpeed: 52,
  reverseForce: 3000,
  reverseSpeed: 9,
  brakeForce: 11000,
  engineBrake: 500,
  rollingResistance: 0.015,
  drag: 0.42,
  grip: 1,
  peakSlip: 0.15,
  slideGrip: 0.8,
  handbrakeGrip: 0.4,
  loadSensitivity: 0.1,
  lowSpeed: 2,
  maxSteer: 0.45,
  steerRate: 2.5,
  steerFallSpeed: 14,
  restitution: 0.2,
  bounceSpeed: 1,
  hullFriction: 0.4,
  bumpStopFactor: 10,
  wheelSphereShare: 0.8,
  reverseEngageSpeed: 1,
  uprightProbeHeight: 1,
  sleepSpeed: 0.03,
  sleepSeconds: 0.5,
  obstacleTag: WHEELED_OBSTACLE_TAG,
});

/** What the driver asks for in a step. */
export interface WheeledIntent {
  /**
   * −1..1. Forward: drives forward; while rolling backward faster than 1 m/s it brakes instead. Backward: brakes while
   * rolling forward faster than 1 m/s, otherwise drives backward.
   */
  throttle: number;
  /** 0..1, the share of `brakeForce`. */
  brake: number;
  /** −1..1, positive turns right. The angle eases at `steerRate` and is reduced with speed. */
  steer: number;
  /** Locks the wheels marked `handbrake`. */
  handbrake: boolean;
}

/** A fresh, idle `WheeledIntent` (allocate once, reuse). */
export function newWheeledIntent(): WheeledIntent {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false };
}

/** The state of one wheel after the last step, for drawing, marks and sound. Read only. */
export class WheelState {
  readonly spec: WheelSpec;
  /** The ray found ground within the spring's reach. */
  grounded = false;
  /** How far the spring is compressed from `restLength`, metres (above `travel`: on the bump stop). */
  compression = 0;
  /** Distance from the mount down to the wheel's centre, metres. */
  length: number;
  /** Contact point and the ground's unit normal there (world), valid while `grounded`. */
  readonly contact = new Float64Array(3);
  readonly normal = new Float64Array([0, 1, 0]);
  /** Normal force at the contact, N. */
  load = 0;
  /** Speed of sliding at the contact, m/s: sideways, plus along the rolling for a locked wheel. */
  slip = 0;
  /** Angle rolled, radians; grows while rolling forward. */
  spin = 0;
  /** Steer angle, radians; positive turns right. */
  steer = 0;
  /** What the ray hit: −1 the base surface, a solid's id, −2 nothing. */
  surface = -2;
  /** Surface tag of what the ray hit (the solid's tag, or the base surface's `baseTagAt`), −1 when nothing. */
  surfaceTag = -1;

  constructor(spec: WheelSpec) {
    this.spec = spec;
    this.length = spec.restLength;
  }
}

/** Contacts of the hull solved in one sub-step at most; more are dropped. */
const MAX_CONTACTS = 64;
/** Contacts read per hull sphere at most. */
const PER_SPHERE = 4;
/** Velocity iterations of the hull contacts and of the tyres. */
const CONTACT_ITERATIONS = 6;
const POSITION_ITERATIONS = 3;
const TYRE_ITERATIONS = 4;
/** Penetration left alone, and the share of the rest pushed out per sub-step. */
const SLOP = 0.005;
const PUSH_SHARE = 0.4;
/** Fastest push out of a penetration, m/s (applied to the position only). */
const MAX_PUSH = 4;
/** Most hull sub-steps per step; a sub-step moves at most half a sphere's radius. */
const MAX_SUBSTEPS = 8;
/** Speed at which a wheel in the air drops to full droop, m/s (for drawing). */
const DROOP_SPEED = 2;
/** Below this, a ray's normal counts as a side and the strut's axis is used instead. */
const MIN_NORMAL_UP = 0.3;
/** Change of a sleeping wheel's compression that wakes the body, metres. */
const WAKE_COMPRESSION = 0.01;
/** Most wheels of one body. */
const MAX_WHEELS = 64;
const STATE_VERSION = 1;
const HEADER = 30;
const PER_WHEEL = 20;

/**
 * A rigid body carried on wheel rays over a `CollisionWorld` (see the file comment). `position` is the centre of mass,
 * `orientation` a unit quaternion [x, y, z, w]. Call `advance(dt, intent)` once per frame (or `step` from a script)
 * and draw at `renderMatrix` / `wheelMatrix`.
 */
export class WheeledBody {
  readonly setup: WheeledBodySetup;
  readonly world: CollisionWorld;
  /** Centre of mass, metres. */
  readonly position = new Float64Array(3);
  /** Unit quaternion [x, y, z, w] from the body's frame to the world. */
  readonly orientation = new Float64Array([0, 0, 0, 1]);
  readonly velocity = new Float64Array(3);
  /** Angular velocity in the world, rad/s. */
  readonly angularVelocity = new Float64Array(3);
  /** The body's axes in the world, column by column: +x (right), +y (up), +z (back). Updated in each step. */
  readonly rotation = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  readonly wheels: readonly WheelState[];
  /**
   * The hull as spheres in the body's frame, four numbers each (x, y, z, radius): a grid along the box with
   * `hullRadius`, then one per wheel at the wheel's highest place (the bump stop) with 0.8 of its radius, which the
   * ground meets only when a spring is through its travel or the body lies on its side.
   */
  readonly hullSpheres: Float64Array;
  /** Radius of the box's spheres, metres. */
  readonly hullRadius: number;
  /** Steer angle of a steering wheel, radians; positive turns right. */
  steerAngle = 0;
  /** True while sleeping (still, not integrated). */
  asleep = false;
  /** Fixed steps since construction or the last `teleport`. */
  steps = 0;
  /** Wheels on the ground and hull contacts in the last step. */
  groundedWheels = 0;
  hullContacts = 0;

  private readonly dt: number;
  private readonly invMass: number;
  private readonly invI = new Float64Array(3);
  private readonly hullReach: number;
  private readonly sleepSteps: number;
  private readonly nDriven: number;
  private readonly prevP = new Float64Array(3);
  private readonly prevQ = new Float64Array([0, 0, 0, 1]);
  private readonly fixed: FixedSteps;
  /** The intent of the steps `advance` runs. */
  private dueIntent: WheeledIntent | null = null;
  private sleepCount = 0;
  private heldAsleep = false;
  private obstacle = -1;
  private readonly hit = newRayHit();
  private readonly touch = newSphereContacts(PER_SPHERE);
  // Per wheel: the previous step for drawing, the spin rate, the compression when falling asleep, tyre scratch.
  private readonly prevLen: Float64Array;
  private readonly prevSpin: Float64Array;
  private readonly prevSteerW: Float64Array;
  private readonly spinRate: Float64Array;
  private readonly sleepComp: Float64Array;
  private readonly tw: Float64Array; // 16 numbers per wheel, see solveTyres
  // Hull contacts of a sub-step.
  private readonly cs = new Float64Array(MAX_CONTACTS * 16);
  private nc = 0;
  private readonly pv = new Float64Array(3);
  private readonly pw = new Float64Array(3);
  // Scratch of the small vector helpers.
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private readonly sc: [number, number] = [0, 0];
  private readonly stateScratch: Float64Array;
  private readonly stateView: Uint8Array;
  /** World centres of the hull's spheres (for `collideWheeledBodies`). */
  private readonly worldSpheres: Float64Array;

  constructor(world: CollisionWorld, setup?: Partial<WheeledBodySetup>) {
    this.world = world;
    this.setup = { ...DEFAULT_WHEELED_BODY, ...setup };
    const s = this.setup;
    if (!(s.stepHz > 0)) throw new Error('WheeledBody: stepHz must be positive');
    if (!(s.mass > 0)) throw new Error('WheeledBody: mass must be positive');
    if (!(s.halfWidth > 0) || !(s.halfHeight > 0) || !(s.halfLength > 0)) throw new Error('WheeledBody: the hull needs positive half extents');
    if (s.wheels.length === 0 || s.wheels.length > MAX_WHEELS) throw new Error(`WheeledBody: 1 to ${MAX_WHEELS} wheels`);
    for (const w of s.wheels) {
      if (!(w.radius > 0) || !(w.restLength > 0) || !(w.travel >= 0) || !(w.stiffness > 0) || !(w.damping >= 0)) {
        throw new Error('WheeledBody: a wheel needs a positive radius, rest length and stiffness');
      }
    }
    this.dt = 1 / s.stepHz;
    this.fixed = new FixedSteps(this.dt, s.maxStepsPerAdvance);
    this.invMass = 1 / s.mass;
    // Box inertia from the hull's full sizes.
    const w2 = 4 * s.halfWidth * s.halfWidth;
    const h2 = 4 * s.halfHeight * s.halfHeight;
    const l2 = 4 * s.halfLength * s.halfLength;
    const k = (s.mass / 12) * (s.inertiaScale > 0 ? s.inertiaScale : 1);
    this.invI[0] = 1 / (k * (h2 + l2));
    this.invI[1] = 1 / (k * (w2 + l2));
    this.invI[2] = 1 / (k * (w2 + h2));
    this.wheels = s.wheels.map((w) => new WheelState(w));
    const n = s.wheels.length;
    this.prevLen = new Float64Array(n);
    this.prevSpin = new Float64Array(n);
    this.prevSteerW = new Float64Array(n);
    this.spinRate = new Float64Array(n);
    this.sleepComp = new Float64Array(n);
    this.tw = new Float64Array(n * 16);
    for (let i = 0; i < n; i++) this.prevLen[i] = s.wheels[i]!.restLength;
    let nd = 0;
    for (const w of s.wheels) if (w.driven) nd++;
    this.nDriven = nd;
    this.sleepSteps = Math.max(1, Math.round(s.sleepSeconds * s.stepHz));
    // Hull spheres: a grid of columns, rows and a line along the length, no farther apart than 1.5 radii.
    const r = s.hullRadius > 0 ? s.hullRadius : 0.75 * Math.min(s.halfWidth, s.halfHeight);
    this.hullRadius = r;
    const ex = s.halfWidth - r;
    const ey = s.halfHeight - r;
    const ez = s.halfLength - r;
    const nx = ex > 1e-6 ? 2 : 1;
    const ny = ey > 1e-6 ? 2 : 1;
    const nz = ez > 1e-6 ? Math.max(2, Math.ceil((2 * ez) / (1.5 * r)) + 1) : 1;
    const nWheels = s.wheels.length;
    const spheres = new Float64Array((nx * ny * nz + nWheels) * 4);
    let reach = 0;
    let at = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const x = nx === 1 ? 0 : ix === 0 ? -ex : ex;
          const y = s.hullY + (ny === 1 ? 0 : iy === 0 ? -ey : ey);
          const z = nz === 1 ? 0 : -ez + (2 * ez * iz) / (nz - 1);
          spheres[at++] = x;
          spheres[at++] = y;
          spheres[at++] = z;
          spheres[at++] = r;
          const d = Math.sqrt(x * x + y * y + z * z) + r;
          if (d > reach) reach = d;
        }
      }
    }
    for (const w of s.wheels) {
      const y = w.y - (w.restLength - w.travel);
      const wr = s.wheelSphereShare * w.radius;
      spheres[at++] = w.x;
      spheres[at++] = y;
      spheres[at++] = w.z;
      spheres[at++] = wr;
      const d = Math.sqrt(w.x * w.x + y * y + w.z * w.z) + wr;
      if (d > reach) reach = d;
    }
    this.hullSpheres = spheres;
    this.hullReach = reach;
    this.worldSpheres = new Float64Array(spheres.length);
    this.stateScratch = new Float64Array(HEADER + PER_WHEEL * n);
    this.stateView = new Uint8Array(this.stateScratch.buffer);
  }

  /** Seconds of one fixed step. */
  get stepSeconds(): number {
    return this.dt;
  }

  /**
   * Share of the way from the last step to the next one, 0–1: of the body's own steps, or of its `WheeledGroup`'s
   * when it is in one (whose steps it takes).
   */
  get alpha(): number {
    const g = GROUP_OF.get(this);
    return g ? g.alpha : this.fixed.alpha;
  }

  /** Speed along the body's forward axis, m/s (negative backward). */
  get forwardSpeed(): number {
    const R = this.rotation;
    const v = this.velocity;
    return -(v[0]! * R[6]! + v[1]! * R[7]! + v[2]! * R[8]!);
  }

  /** Length of the velocity, m/s. */
  get speed(): number {
    const v = this.velocity;
    return Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
  }

  /** Heading of the body's forward axis in the horizontal plane, radians (yaw 0 faces −z, as a view's yaw). */
  get yaw(): number {
    const R = this.rotation;
    return detAtan2(R[6]!, R[8]!);
  }

  /** Kinetic energy (linear and angular), J. */
  get kineticEnergy(): number {
    const v = this.velocity;
    const w = this.angularVelocity;
    const R = this.rotation;
    let e = 0.5 * this.setup.mass * (v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
    for (let k = 0; k < 3; k++) {
      const b = w[0]! * R[k * 3]! + w[1]! * R[k * 3 + 1]! + w[2]! * R[k * 3 + 2]!;
      e += (0.5 * b * b) / this.invI[k]!;
    }
    return e;
  }

  /** Height of the centre of mass above flat ground when the body rests on its wheels, metres (for `teleport`). */
  get restHeight(): number {
    const s = this.setup;
    const load = (s.mass * s.gravity) / s.wheels.length;
    let sum = 0;
    for (const w of s.wheels) {
      let c = load / w.stiffness;
      if (c > w.travel) c = w.travel;
      sum += w.radius + w.restLength - c - w.y;
    }
    return sum / s.wheels.length;
  }

  /** Solid id of the obstacle box kept by `syncObstacle`, or −1. */
  get obstacleId(): number {
    return this.obstacle;
  }

  /** Changes the forces, grip and steering of the setup from the next step on; a field left out keeps its value. */
  retune(o: Partial<WheeledTuning>): void {
    const s = this.setup as WheeledBodySetup;
    for (const k of WHEELED_TUNING_KEYS) {
      const v = o[k];
      if (v !== undefined) s[k] = v;
    }
  }

  /**
   * Puts the centre of mass at a point, upright and turned to `yaw` (view convention; left out, the heading it has),
   * with no velocity; the wheels hang at full droop and the body settles on them in the next steps. `y` = ground +
   * `restHeight` sets it down at rest. As `Walker.teleport`.
   */
  teleport(x: number, y: number, z: number, yaw?: number): void {
    if (yaw === undefined) yaw = this.yaw;
    const p = this.position;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    const sc = detSinCos(yaw * 0.5, this.sc);
    const q = this.orientation;
    q[0] = 0;
    q[1] = sc[0];
    q[2] = 0;
    q[3] = sc[1];
    this.prevP.set(p);
    this.prevQ.set(q);
    this.velocity.fill(0);
    this.angularVelocity.fill(0);
    this.fixed.reset();
    this.steps = 0;
    this.steerAngle = 0;
    this.asleep = false;
    this.sleepCount = 0;
    this.heldAsleep = false;
    this.groundedWheels = 0;
    this.hullContacts = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      w.grounded = false;
      w.compression = 0;
      w.length = w.spec.restLength;
      w.load = 0;
      w.slip = 0;
      w.steer = 0;
      w.surface = -2;
      w.surfaceTag = -1;
      this.prevLen[i] = w.length;
      this.prevSpin[i] = w.spin;
      this.prevSteerW[i] = 0;
      this.spinRate[i] = 0;
    }
    this.updateRotation();
  }

  /**
   * Sets the body upright on its wheels where it is, keeping its heading (after a roll onto the side or upside down): the
   * ground under the centre of mass (`groundAt` from `uprightProbeHeight` above it) plus `restHeight`.
   */
  setUpright(): void {
    const p = this.position;
    const g = this.world.groundAt(p[0]!, p[2]!, p[1]! + this.setup.uprightProbeHeight, 0);
    this.teleport(p[0]!, g + this.restHeight, p[2]!);
  }

  /** Ends sleep: the next step integrates again. */
  wake(): void {
    this.asleep = false;
    this.sleepCount = 0;
  }

  /** Adds an impulse (N·s, world) at a world point: a push, a blow, an explosion. Wakes the body. */
  applyImpulse(px: number, py: number, pz: number, jx: number, jy: number, jz: number): void {
    this.wake();
    const p = this.position;
    this.push(this.velocity, this.angularVelocity, px - p[0]!, py - p[1]!, pz - p[2]!, jx, jy, jz);
  }

  /**
   * Advances by real seconds in fixed steps; returns the number of steps taken. Leftover time carries to the next call,
   * so one call of 1/30 s and two of 1/60 s end in the same place.
   */
  advance(dt: number, intent: WheeledIntent): number {
    if (GROUP_OF.has(this)) throw new Error('WheeledBody.advance: the body is in a WheeledGroup; advance the group');
    if (!(dt > 0)) return 0;
    this.dueIntent = intent;
    const n = this.fixed.advance(dt, this.stepDue, this.setup.maxStepsPerAdvance);
    this.dueIntent = null;
    return n;
  }

  /** One step due in `advance`. */
  private readonly stepDue = (): void => {
    this.step(this.dueIntent!);
  };

  /** One fixed step (for scripts, tests and `WheeledGroup`). */
  step(intent: WheeledIntent): void {
    const s = this.setup;
    const h = this.dt;
    const p = this.position;
    const v = this.velocity;
    const w = this.angularVelocity;
    const R = this.rotation;
    const nw = this.wheels.length;
    this.prevP.set(p);
    this.prevQ.set(this.orientation);
    for (let i = 0; i < nw; i++) {
      const ws = this.wheels[i]!;
      this.prevLen[i] = ws.length;
      this.prevSpin[i] = ws.spin;
      this.prevSteerW[i] = ws.steer;
    }
    this.steps++;

    const throttle = clampTo(intent.throttle, -1, 1);
    const brake = clampTo(intent.brake, 0, 1);
    const steer = clampTo(intent.steer, -1, 1);
    const hand = intent.handbrake === true;

    // The steer angle eases toward the wanted one, which shrinks with speed.
    this.updateRotation();
    const fwdSpeed = this.forwardSpeed;
    const absFwd = fwdSpeed < 0 ? -fwdSpeed : fwdSpeed;
    const fall = s.steerFallSpeed > 0 ? absFwd / s.steerFallSpeed : 0;
    const want = (steer * s.maxSteer) / (1 + fall * fall);
    const lim = s.steerRate * h;
    const ds = want - this.steerAngle;
    this.steerAngle += ds > lim ? lim : ds < -lim ? -lim : ds;
    for (const ws of this.wheels) ws.steer = ws.spec.steers ? this.steerAngle : 0;

    if (this.asleep) {
      const held = brake > 0 || hand;
      if (throttle !== 0 || (this.heldAsleep && !held)) this.wake();
      else {
        this.castWheels(h);
        for (let i = 0; i < nw; i++) {
          const ws = this.wheels[i]!;
          const d = ws.compression - this.sleepComp[i]!;
          if (!ws.grounded && this.sleepComp[i]! > 0) this.wake();
          else if (d > WAKE_COMPRESSION || d < -WAKE_COMPRESSION) this.wake();
        }
        if (this.asleep) {
          for (let i = 0; i < nw; i++) {
            const ws = this.wheels[i]!;
            ws.length = this.prevLen[i]!;
            ws.compression = this.sleepComp[i]!;
          }
          return;
        }
      }
    }

    // Drive and brake from the throttle (see `WheeledIntent.throttle`).
    let drive = 0;
    let brakeIn = brake;
    if (throttle > 0) {
      if (fwdSpeed < -s.reverseEngageSpeed) brakeIn = brakeIn > throttle ? brakeIn : throttle;
      else drive = throttle * driveCurve(fwdSpeed > 0 ? fwdSpeed : 0, s.driveForce, s.topSpeed);
    } else if (throttle < 0) {
      if (fwdSpeed > s.reverseEngageSpeed) brakeIn = brakeIn > -throttle ? brakeIn : -throttle;
      else drive = throttle * driveCurve(fwdSpeed < 0 ? -fwdSpeed : 0, s.reverseForce, s.reverseSpeed);
    }

    // Phase A: gravity, drag and the springs, as forces over the step.
    this.castWheels(h);
    let fx = 0;
    let fy = -s.gravity * s.mass; // UP: gravity would be along the local down.
    let fz = 0;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    if (s.drag > 0) {
      const sp = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
      fx -= s.drag * sp * v[0]!;
      fy -= s.drag * sp * v[1]!;
      fz -= s.drag * sp * v[2]!;
    }
    let grounded = 0;
    for (let i = 0; i < nw; i++) {
      const ws = this.wheels[i]!;
      if (!ws.grounded) continue;
      grounded++;
      const sp = ws.spec;
      const n = ws.normal;
      // Velocity of the mount; the rate of compression is its approach to the ground along the ray.
      this.local(sp.x, sp.y, sp.z);
      const ax = this.ox;
      const ay = this.oy;
      const az = this.oz;
      const vmx = v[0]! + w[1]! * az - w[2]! * ay;
      const vmy = v[1]! + w[2]! * ax - w[0]! * az;
      const vmz = v[2]! + w[0]! * ay - w[1]! * ax;
      const dn = -(R[3]! * n[0]! + R[4]! * n[1]! + R[5]! * n[2]!);
      const rate = dn < -0.1 ? (vmx * n[0]! + vmy * n[1]! + vmz * n[2]!) / dn : 0;
      const c = ws.compression;
      let force = sp.stiffness * (c < sp.travel ? c : sp.travel) + sp.damping * rate;
      if (c > sp.travel) force += s.bumpStopFactor * sp.stiffness * (c - sp.travel);
      if (force < 0) force = 0;
      ws.load = force;
      const rx = ws.contact[0]! - p[0]!;
      const ry = ws.contact[1]! - p[1]!;
      const rz = ws.contact[2]! - p[2]!;
      const nfx = force * n[0]!;
      const nfy = force * n[1]!;
      const nfz = force * n[2]!;
      fx += nfx;
      fy += nfy;
      fz += nfz;
      tx += ry * nfz - rz * nfy;
      ty += rz * nfx - rx * nfz;
      tz += rx * nfy - ry * nfx;
    }
    this.groundedWheels = grounded;
    v[0] = v[0]! + fx * this.invMass * h;
    v[1] = v[1]! + fy * this.invMass * h;
    v[2] = v[2]! + fz * this.invMass * h;
    this.worldInvI(tx, ty, tz);
    w[0] = w[0]! + this.ox * h;
    w[1] = w[1]! + this.oy * h;
    w[2] = w[2]! + this.oz * h;

    // Phase B: the tyres, as impulses that hold or slide.
    if (grounded > 0) this.solveTyres(h, drive, brakeIn, hand);

    // Phase C: the hull against the world, and the motion, in sub-steps.
    const ws2 = w[0]! * w[0]! + w[1]! * w[1]! + w[2]! * w[2]!;
    const reachSpeed = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!) + Math.sqrt(ws2) * this.hullReach;
    let subs = Math.ceil((reachSpeed * h) / (0.5 * this.hullRadius));
    if (!(subs >= 1)) subs = 1;
    if (subs > MAX_SUBSTEPS) subs = MAX_SUBSTEPS;
    const hs = h / subs;
    let contacts = 0;
    for (let k = 0; k < subs; k++) {
      if (k > 0) this.updateRotation();
      this.gatherHull(reachSpeed * hs);
      if (this.nc > 0) {
        let touching = 0;
        for (let q = 0; q < this.nc; q++) if (this.cs[q * 16 + 6]! >= 0) touching++;
        if (touching > contacts) contacts = touching;
        this.solveHull(hs);
      } else {
        this.pv.fill(0);
        this.pw.fill(0);
      }
      this.integrate(hs);
    }
    this.hullContacts = contacts;
    this.updateRotation();

    // Wheels: spin and droop.
    for (let i = 0; i < nw; i++) {
      const ws = this.wheels[i]!;
      if (!ws.grounded) {
        // A known constant of the step: 1 % of the spin lost per step, so the decay per second depends on `stepHz`.
        this.spinRate[i] = this.spinRate[i]! * 0.99;
        ws.slip = 0;
        ws.load = 0;
      }
      ws.spin += this.spinRate[i]! * h;
    }

    // Sleep after standing still for a while without throttle.
    const ss = s.sleepSpeed;
    const lin2 = v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!;
    const ang2 = w[0]! * w[0]! + w[1]! * w[1]! + w[2]! * w[2]!;
    if (lin2 < ss * ss && ang2 < ss * ss && throttle === 0 && (grounded > 0 || contacts > 0)) this.sleepCount++;
    else this.sleepCount = 0;
    if (this.sleepCount >= this.sleepSteps) {
      this.asleep = true;
      this.heldAsleep = brake > 0 || hand;
      v.fill(0);
      w.fill(0);
      for (let i = 0; i < nw; i++) {
        this.sleepComp[i] = this.wheels[i]!.grounded ? this.wheels[i]!.compression : 0;
        this.spinRate[i] = 0;
      }
    }
  }

  /**
   * Pose between the last two steps for drawing: position (x, y, z) then the orientation quaternion (x, y, z, w), 7
   * numbers into `out`. `alpha` as for the walker: default the body's own (from `advance`).
   */
  renderTransform(out: Float64Array | number[], alpha?: number): void {
    const a = this.alphaOf(alpha);
    const p = this.position;
    const q = this.prevP;
    out[0] = q[0]! + (p[0]! - q[0]!) * a;
    out[1] = q[1]! + (p[1]! - q[1]!) * a;
    out[2] = q[2]! + (p[2]! - q[2]!) * a;
    this.lerpQuat(a);
    out[3] = this.qx;
    out[4] = this.qy;
    out[5] = this.qz;
    out[6] = this.qw;
  }

  /** Pose between the last two steps for drawing as a 3 × 4 matrix (body frame to world; origin the centre of mass). */
  renderMatrix(out: Mat34, alpha?: number): Mat34 {
    const a = this.alphaOf(alpha);
    const p = this.position;
    const q = this.prevP;
    this.lerpQuat(a);
    quatColumns(this.qx, this.qy, this.qz, this.qw, out);
    out[9] = q[0]! + (p[0]! - q[0]!) * a;
    out[10] = q[1]! + (p[1]! - q[1]!) * a;
    out[11] = q[2]! + (p[2]! - q[2]!) * a;
    return out;
  }

  /**
   * Wheel `i` for drawing as a 3 × 4 matrix: at its centre (the mount moved down its spring), turned by its steer
   * and rolled by its spin about its axle (the wheel's local +x); a wheel modelled round its centre with the axle
   * along x is drawn with it.
   */
  wheelMatrix(i: number, out: Mat34, alpha?: number): Mat34 {
    const ws = this.wheels[i];
    if (!ws) throw new Error('WheeledBody.wheelMatrix: no such wheel');
    const a = this.alphaOf(alpha);
    const sp = ws.spec;
    this.renderMatrix(out, a);
    const len = this.prevLen[i]! + (ws.length - this.prevLen[i]!) * a;
    const steer = this.prevSteerW[i]! + (ws.steer - this.prevSteerW[i]!) * a;
    const spin = this.prevSpin[i]! + (ws.spin - this.prevSpin[i]!) * a;
    // Centre in the body frame, then to the world.
    const lx = sp.x;
    const ly = sp.y - len;
    const lz = sp.z;
    const cx = out[0]! * lx + out[3]! * ly + out[6]! * lz + out[9]!;
    const cy = out[1]! * lx + out[4]! * ly + out[7]! * lz + out[10]!;
    const cz = out[2]! * lx + out[5]! * ly + out[8]! * lz + out[11]!;
    // Local rotation: about y by −steer (a right turn), then about x by −spin (rolling forward toward −z).
    const st = detSinCos(-steer, this.sc);
    const sy = st[0];
    const cyw = st[1];
    const sr = detSinCos(-spin, this.sc);
    const sx = sr[0];
    const cxs = sr[1];
    // M = Ry · Rx, columns.
    const m0 = cyw, m1 = 0, m2 = -sy;
    const m3 = sy * sx, m4 = cxs, m5 = cyw * sx;
    const m6 = sy * cxs, m7 = -sx, m8 = cyw * cxs;
    const b0 = out[0]!, b1 = out[1]!, b2 = out[2]!, b3 = out[3]!, b4 = out[4]!, b5 = out[5]!, b6 = out[6]!, b7 = out[7]!, b8 = out[8]!;
    out[0] = b0 * m0 + b3 * m1 + b6 * m2;
    out[1] = b1 * m0 + b4 * m1 + b7 * m2;
    out[2] = b2 * m0 + b5 * m1 + b8 * m2;
    out[3] = b0 * m3 + b3 * m4 + b6 * m5;
    out[4] = b1 * m3 + b4 * m4 + b7 * m5;
    out[5] = b2 * m3 + b5 * m4 + b8 * m5;
    out[6] = b0 * m6 + b3 * m7 + b6 * m8;
    out[7] = b1 * m6 + b4 * m7 + b7 * m8;
    out[8] = b2 * m6 + b5 * m7 + b8 * m8;
    out[9] = cx;
    out[10] = cy;
    out[11] = cz;
    return out;
  }

  /** Heading between the last two steps for drawing (a follow camera's yaw), radians. */
  renderYaw(alpha?: number): number {
    const a = this.alphaOf(alpha);
    this.lerpQuat(a);
    // Column 2 (+z) of the interpolated rotation; the heading faces −z.
    const x = this.qx, y = this.qy, z = this.qz, w = this.qw;
    return detAtan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
  }

  /**
   * Keeps an obstacle box of the hull in the world, for walkers and rays of other movers: an upright box round the
   * hull, turned with the heading, `standable: false`, `blocksSight: false`, tagged `obstacleTag` (this body's hull
   * does not touch it). Added on the first call and moved in place (`CollisionWorld.setBox`) on the next ones; call it
   * after the steps of a frame, or once when the body is parked. Returns the solid's id.
   */
  syncObstacle(): number {
    const s = this.setup;
    const R = this.rotation;
    const p = this.position;
    const cx = p[0]! + R[3]! * s.hullY;
    const cy = p[1]! + R[4]! * s.hullY;
    const cz = p[2]! + R[5]! * s.hullY;
    const yaw = this.yaw;
    const sc = detSinCos(yaw, this.sc);
    // Horizontal axes of the box: right (cos, −sin) and back (sin, cos) in x, z.
    const rx = sc[1], rz = -sc[0];
    const bx = sc[0], bz = sc[1];
    const hw = s.halfWidth, hh = s.halfHeight, hl = s.halfLength;
    const halfX = abs(R[0]! * rx + R[2]! * rz) * hw + abs(R[3]! * rx + R[5]! * rz) * hh + abs(R[6]! * rx + R[8]! * rz) * hl;
    const halfZ = abs(R[0]! * bx + R[2]! * bz) * hw + abs(R[3]! * bx + R[5]! * bz) * hh + abs(R[6]! * bx + R[8]! * bz) * hl;
    const halfY = abs(R[1]!) * hw + abs(R[4]!) * hh + abs(R[7]!) * hl;
    if (this.obstacle >= 0 && this.world.has(this.obstacle)) {
      this.world.setBox(this.obstacle, cx, cz, halfX, halfZ, yaw, cy - halfY, cy + halfY);
    } else {
      this.obstacle = this.world.addBox(cx, cz, halfX, halfZ, yaw, cy - halfY, cy + halfY, { standable: false, blocksSight: false, tag: s.obstacleTag });
    }
    return this.obstacle;
  }

  /** Takes the obstacle box of `syncObstacle` out of the world. */
  removeObstacle(): void {
    if (this.obstacle >= 0) this.world.remove(this.obstacle);
    this.obstacle = -1;
  }

  /** Bytes of one saved state of this body (it depends on the number of wheels). */
  get stateBytes(): number {
    return this.stateScratch.byteLength;
  }

  /**
   * Writes the whole moving state (pose, velocities, the previous pose for drawing, leftover time, steering, sleep,
   * every wheel's outputs) into `out` (at least `stateBytes` from `offset`; default a new array) and returns it.
   */
  saveState(out?: Uint8Array, offset = 0): Uint8Array {
    const f = this.stateScratch;
    f[0] = STATE_VERSION;
    f.set(this.position, 1);
    f.set(this.orientation, 4);
    f.set(this.velocity, 8);
    f.set(this.angularVelocity, 11);
    f.set(this.prevP, 14);
    f.set(this.prevQ, 17);
    f[21] = this.fixed.leftover;
    f[22] = this.steerAngle;
    f[23] = (this.asleep ? 1 : 0) + (this.heldAsleep ? 2 : 0);
    f[24] = this.sleepCount;
    f[25] = this.steps;
    f[26] = this.wheels.length;
    f[27] = this.groundedWheels;
    f[28] = this.hullContacts;
    f[29] = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const ws = this.wheels[i]!;
      const b = HEADER + i * PER_WHEEL;
      f[b] = ws.grounded ? 1 : 0;
      f[b + 1] = ws.compression;
      f[b + 2] = ws.length;
      f[b + 3] = this.prevLen[i]!;
      f.set(ws.contact, b + 4);
      f.set(ws.normal, b + 7);
      f[b + 10] = ws.load;
      f[b + 11] = ws.slip;
      f[b + 12] = ws.spin;
      f[b + 13] = this.prevSpin[i]!;
      f[b + 14] = ws.steer;
      f[b + 15] = this.prevSteerW[i]!;
      f[b + 16] = this.spinRate[i]!;
      f[b + 17] = this.sleepComp[i]!;
      f[b + 18] = ws.surface;
      f[b + 19] = ws.surfaceTag;
    }
    const o = out ?? new Uint8Array(this.stateBytes);
    if (o.length < offset + this.stateBytes) throw new Error('WheeledBody.saveState: the output is too short');
    o.set(this.stateView, offset);
    return o;
  }

  /** Restores a state written by `saveState` of a body with the same setup. */
  loadState(bytes: Uint8Array, offset = 0): void {
    const nb = this.stateBytes;
    if (bytes.length < offset + nb) throw new Error('WheeledBody.loadState: too few bytes');
    const f = this.stateScratch;
    this.stateView.set(bytes.subarray(offset, offset + nb));
    if (f[0] !== STATE_VERSION || f[26] !== this.wheels.length) throw new Error('WheeledBody.loadState: not a state of this body');
    this.position.set(f.subarray(1, 4));
    this.orientation.set(f.subarray(4, 8));
    this.velocity.set(f.subarray(8, 11));
    this.angularVelocity.set(f.subarray(11, 14));
    this.prevP.set(f.subarray(14, 17));
    this.prevQ.set(f.subarray(17, 21));
    this.fixed.leftover = f[21]!;
    this.steerAngle = f[22]!;
    const flags = f[23]!;
    this.asleep = (flags & 1) !== 0;
    this.heldAsleep = (flags & 2) !== 0;
    this.sleepCount = f[24]!;
    this.steps = f[25]!;
    this.groundedWheels = f[27]!;
    this.hullContacts = f[28]!;
    for (let i = 0; i < this.wheels.length; i++) {
      const ws = this.wheels[i]!;
      const b = HEADER + i * PER_WHEEL;
      ws.grounded = f[b] === 1;
      ws.compression = f[b + 1]!;
      ws.length = f[b + 2]!;
      this.prevLen[i] = f[b + 3]!;
      ws.contact.set(f.subarray(b + 4, b + 7));
      ws.normal.set(f.subarray(b + 7, b + 10));
      ws.load = f[b + 10]!;
      ws.slip = f[b + 11]!;
      ws.spin = f[b + 12]!;
      this.prevSpin[i] = f[b + 13]!;
      ws.steer = f[b + 14]!;
      this.prevSteerW[i] = f[b + 15]!;
      this.spinRate[i] = f[b + 16]!;
      this.sleepComp[i] = f[b + 17]!;
      ws.surface = f[b + 18]!;
      ws.surfaceTag = f[b + 19]!;
    }
    this.updateRotation();
  }

  /** This body as a part of a simulation's state (`Simulation.addState`), like `Walker.simState`. */
  simState(name: string): WalkerSimState {
    const buf = new Uint8Array(this.stateBytes);
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
   * Pushes this body and `other` apart where their hulls' spheres overlap: equal and opposite impulses with the
   * restitution and the hull friction (the smaller of the two bodies' values), and the overlap taken out of their
   * positions in the ratio of their masses. Call it after both took the same step (`collideWheeledBodies`,
   * `WheeledGroup`). Returns whether they touched; wakes both when they did.
   */
  collide(other: WheeledBody): boolean {
    if (other === this) return false;
    const pa = this.position;
    const pb = other.position;
    const dx = pb[0]! - pa[0]!;
    const dy = pb[1]! - pa[1]!;
    const dz = pb[2]! - pa[2]!;
    const reach = this.hullReach + other.hullReach;
    if (dx * dx + dy * dy + dz * dz >= reach * reach) return false;
    this.updateRotation();
    other.updateRotation();
    this.placeSpheres();
    other.placeSpheres();
    const A = this.worldSpheres;
    const B = other.worldSpheres;
    const c = PAIR;
    let n = 0;
    let deepest = 0;
    let dnx = 0, dny = 0, dnz = 0;
    for (let i = 0; i < A.length && n < PAIR_MAX; i += 4) {
      const ra = A[i + 3]!;
      for (let j = 0; j < B.length && n < PAIR_MAX; j += 4) {
        const rb = B[j + 3]!;
        const rr = ra + rb;
        const ex = A[i]! - B[j]!;
        const ey = A[i + 1]! - B[j + 1]!;
        const ez = A[i + 2]! - B[j + 2]!;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 >= rr * rr || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = ex / d, ny = ey / d, nz = ez / d;
        const depth = rr - d;
        // The contact point halfway between the two surfaces.
        const mx = (A[i]! - nx * ra + B[j]! + nx * rb) * 0.5;
        const my = (A[i + 1]! - ny * ra + B[j + 1]! + ny * rb) * 0.5;
        const mz = (A[i + 2]! - nz * ra + B[j + 2]! + nz * rb) * 0.5;
        const b = n * 12;
        c[b] = mx - pa[0]!;
        c[b + 1] = my - pa[1]!;
        c[b + 2] = mz - pa[2]!;
        c[b + 3] = mx - pb[0]!;
        c[b + 4] = my - pb[1]!;
        c[b + 5] = mz - pb[2]!;
        c[b + 6] = nx;
        c[b + 7] = ny;
        c[b + 8] = nz;
        c[b + 9] = 0; // normal impulse
        c[b + 10] = 0; // approach speed at the start
        c[b + 11] = 0;
        if (depth > deepest) {
          deepest = depth;
          dnx = nx;
          dny = ny;
          dnz = nz;
        }
        n++;
      }
    }
    if (n === 0) return false;
    this.wake();
    other.wake();
    const e = this.setup.restitution < other.setup.restitution ? this.setup.restitution : other.setup.restitution;
    const mu = this.setup.hullFriction < other.setup.hullFriction ? this.setup.hullFriction : other.setup.hullFriction;
    const bounceMin = this.setup.bounceSpeed > other.setup.bounceSpeed ? this.setup.bounceSpeed : other.setup.bounceSpeed;
    for (let k = 0; k < n; k++) {
      const b = k * 12;
      c[b + 10] = this.relNormal(other, c, b);
    }
    for (let it = 0; it < CONTACT_ITERATIONS; it++) {
      for (let k = 0; k < n; k++) {
        const b = k * 12;
        const nx = c[b + 6]!, ny = c[b + 7]!, nz = c[b + 8]!;
        const vn = this.relNormal(other, c, b);
        const v0 = c[b + 10]!;
        const target = v0 < -bounceMin ? -e * v0 : 0;
        const kn = this.pairMass(other, c, b, nx, ny, nz);
        const old = c[b + 9]!;
        let j = old + (target - vn) / kn;
        if (j < 0) j = 0;
        c[b + 9] = j;
        const dj = j - old;
        this.push(this.velocity, this.angularVelocity, c[b]!, c[b + 1]!, c[b + 2]!, nx * dj, ny * dj, nz * dj);
        other.push(other.velocity, other.angularVelocity, c[b + 3]!, c[b + 4]!, c[b + 5]!, -nx * dj, -ny * dj, -nz * dj);
        // Friction: the sliding velocity at the point taken away, at most mu × the normal impulse of this iteration.
        this.relVelocity(other, c, b);
        let tx = this.ox, ty = this.oy, tz = this.oz;
        const un = tx * nx + ty * ny + tz * nz;
        tx -= un * nx;
        ty -= un * ny;
        tz -= un * nz;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tl > 1e-9 && dj > 0) {
          tx /= tl;
          ty /= tl;
          tz /= tl;
          const kt = this.pairMass(other, c, b, tx, ty, tz);
          let jt = tl / kt;
          const cap = mu * dj;
          if (jt > cap) jt = cap;
          this.push(this.velocity, this.angularVelocity, c[b]!, c[b + 1]!, c[b + 2]!, -tx * jt, -ty * jt, -tz * jt);
          other.push(other.velocity, other.angularVelocity, c[b + 3]!, c[b + 4]!, c[b + 5]!, tx * jt, ty * jt, tz * jt);
        }
      }
    }
    // The deepest overlap out of the positions, shared by the inverse masses.
    const out = deepest - SLOP;
    if (out > 0) {
      const ia = this.invMass;
      const ib = other.invMass;
      const sa = (out * ia) / (ia + ib);
      const sb = (out * ib) / (ia + ib);
      pa[0] = pa[0]! + dnx * sa;
      pa[1] = pa[1]! + dny * sa;
      pa[2] = pa[2]! + dnz * sa;
      pb[0] = pb[0]! - dnx * sb;
      pb[1] = pb[1]! - dny * sb;
      pb[2] = pb[2]! - dnz * sb;
    }
    return true;
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  private qx = 0;
  private qy = 0;
  private qz = 0;
  private qw = 1;

  private alphaOf(alpha: number | undefined): number {
    return alpha === undefined ? this.alpha : alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  }

  /** Normalised blend of the previous and the current orientation into qx…qw. */
  private lerpQuat(a: number): void {
    const p = this.prevQ;
    const q = this.orientation;
    const sign = p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]! + p[3]! * q[3]! < 0 ? -1 : 1;
    const x = p[0]! + (sign * q[0]! - p[0]!) * a;
    const y = p[1]! + (sign * q[1]! - p[1]!) * a;
    const z = p[2]! + (sign * q[2]! - p[2]!) * a;
    const w = p[3]! + (sign * q[3]! - p[3]!) * a;
    const l = Math.sqrt(x * x + y * y + z * z + w * w);
    this.qx = x / l;
    this.qy = y / l;
    this.qz = z / l;
    this.qw = w / l;
  }

  private updateRotation(): void {
    const q = this.orientation;
    quatColumns(q[0]!, q[1]!, q[2]!, q[3]!, this.rotation);
  }

  /** A body-frame vector in the world, into ox, oy, oz. */
  private local(x: number, y: number, z: number): void {
    const R = this.rotation;
    this.ox = R[0]! * x + R[3]! * y + R[6]! * z;
    this.oy = R[1]! * x + R[4]! * y + R[7]! * z;
    this.oz = R[2]! * x + R[5]! * y + R[8]! * z;
  }

  /** The world inverse inertia times a world vector, into ox, oy, oz. */
  private worldInvI(x: number, y: number, z: number): void {
    const R = this.rotation;
    const I = this.invI;
    const b0 = (R[0]! * x + R[1]! * y + R[2]! * z) * I[0]!;
    const b1 = (R[3]! * x + R[4]! * y + R[5]! * z) * I[1]!;
    const b2 = (R[6]! * x + R[7]! * y + R[8]! * z) * I[2]!;
    this.local(b0, b1, b2);
  }

  /** (r × u) · I⁻¹ (r × u): the angular part of the inverse mass at arm r along u. */
  private angularMass(rx: number, ry: number, rz: number, ux: number, uy: number, uz: number): number {
    const cx = ry * uz - rz * uy;
    const cy = rz * ux - rx * uz;
    const cz = rx * uy - ry * ux;
    const R = this.rotation;
    const I = this.invI;
    const b0 = R[0]! * cx + R[1]! * cy + R[2]! * cz;
    const b1 = R[3]! * cx + R[4]! * cy + R[5]! * cz;
    const b2 = R[6]! * cx + R[7]! * cy + R[8]! * cz;
    return b0 * b0 * I[0]! + b1 * b1 * I[1]! + b2 * b2 * I[2]!;
  }

  /** Effective mass at arm r along the unit u. */
  private effMass(rx: number, ry: number, rz: number, ux: number, uy: number, uz: number): number {
    return 1 / (this.invMass + this.angularMass(rx, ry, rz, ux, uy, uz));
  }

  /** An impulse j at arm r applied to the velocities (lin, ang). */
  private push(lin: Float64Array, ang: Float64Array, rx: number, ry: number, rz: number, jx: number, jy: number, jz: number): void {
    lin[0] = lin[0]! + jx * this.invMass;
    lin[1] = lin[1]! + jy * this.invMass;
    lin[2] = lin[2]! + jz * this.invMass;
    this.worldInvI(ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx);
    ang[0] = ang[0]! + this.ox;
    ang[1] = ang[1]! + this.oy;
    ang[2] = ang[2]! + this.oz;
  }

  /** Casts every wheel's ray and fills its contact, normal, compression and length. */
  private castWheels(h: number): void {
    const p = this.position;
    const R = this.rotation;
    const world = this.world;
    const hit = this.hit;
    // UP: the rays run down the body's own down axis, whatever the world's up.
    const dx = -R[3]!;
    const dy = -R[4]!;
    const dz = -R[5]!;
    for (let i = 0; i < this.wheels.length; i++) {
      const ws = this.wheels[i]!;
      const sp = ws.spec;
      this.local(sp.x, sp.y, sp.z);
      const mx = p[0]! + this.ox;
      const my = p[1]! + this.oy;
      const mz = p[2]! + this.oz;
      const reach = sp.restLength + sp.radius;
      if (world.raycast(mx, my, mz, dx, dy, dz, reach, hit)) {
        let nx = hit.nx;
        let ny = hit.ny;
        let nz = hit.nz;
        if (-(nx * dx + ny * dy + nz * dz) < MIN_NORMAL_UP) {
          nx = -dx;
          ny = -dy;
          nz = -dz;
        }
        const len = hit.t - sp.radius;
        ws.grounded = true;
        ws.compression = sp.restLength - len;
        const minLen = sp.restLength - sp.travel;
        ws.length = len > minLen ? len : minLen;
        ws.contact[0] = hit.x;
        ws.contact[1] = hit.y;
        ws.contact[2] = hit.z;
        ws.normal[0] = nx;
        ws.normal[1] = ny;
        ws.normal[2] = nz;
        ws.surface = hit.solid;
        ws.surfaceTag = hit.tag;
      } else {
        ws.grounded = false;
        const len = this.prevLen[i]! + DROOP_SPEED * h;
        ws.length = len < sp.restLength ? len : sp.restLength;
        ws.compression = 0;
        ws.surface = -2;
        ws.surfaceTag = -1;
      }
    }
  }

  /**
   * The tyres' impulses over the step, solved a few times round the wheels: each wheel's impulse in its contact plane
   * is accumulated and clamped, so a wheel holds the body still where its grip allows and slides where it does not.
   * Along the rolling: the drive, plus a friction against rolling bounded by the brake, the rolling resistance and the
   * engine braking. Sideways: a hold bounded by the slip curve × grip (a full static hold below `lowSpeed`). Both
   * inside the circle of grip × load. A wheel locked by the handbrake holds along its rolling with its whole grip and
   * sideways with `handbrakeGrip` of it (an ellipse).
   */
  private solveTyres(h: number, drive: number, brakeIn: number, hand: boolean): void {
    const s = this.setup;
    const p = this.position;
    const v = this.velocity;
    const w = this.angularVelocity;
    const R = this.rotation;
    const t = this.tw;
    const nw = this.wheels.length;
    const staticLoad = (s.mass * s.gravity) / nw;
    for (let i = 0; i < nw; i++) {
      const ws = this.wheels[i]!;
      if (!ws.grounded) continue;
      const sp = ws.spec;
      const n = ws.normal;
      const nx = n[0]!, ny = n[1]!, nz = n[2]!;
      // The wheel's forward in the world: the body's forward turned right by the steer, laid into the contact plane.
      const sc = detSinCos(ws.steer, this.sc);
      let fx = R[0]! * sc[0] - R[6]! * sc[1];
      let fy = R[1]! * sc[0] - R[7]! * sc[1];
      let fz = R[2]! * sc[0] - R[8]! * sc[1];
      const fn = fx * nx + fy * ny + fz * nz;
      fx -= fn * nx;
      fy -= fn * ny;
      fz -= fn * nz;
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (!(fl > 1e-9)) {
        ws.grounded = false;
        continue;
      }
      fx /= fl;
      fy /= fl;
      fz /= fl;
      // Sideways (right) = forward × normal.
      const sx = fy * nz - fz * ny;
      const sy = fz * nx - fx * nz;
      const sz = fx * ny - fy * nx;
      const rx = ws.contact[0]! - p[0]!;
      const ry = ws.contact[1]! - p[1]!;
      const rz = ws.contact[2]! - p[2]!;
      const ux = v[0]! + w[1]! * rz - w[2]! * ry;
      const uy = v[1]! + w[2]! * rx - w[0]! * rz;
      const uz = v[2]! + w[0]! * ry - w[1]! * rx;
      const vl = ux * fx + uy * fy + uz * fz;
      const vs = ux * sx + uy * sy + uz * sz;
      let lf = 1 - s.loadSensitivity * (ws.load / staticLoad - 1);
      lf = lf < 0.3 ? 0.3 : lf > 1.5 ? 1.5 : lf;
      const bmax = h * s.grip * sp.grip * ws.load * lf;
      // Sideways bound from the slip angle, blended into a full hold at low speed.
      const absL = vl < 0 ? -vl : vl;
      const absS = vs < 0 ? -vs : vs;
      const alpha = detAtan2(absS, absL > s.lowSpeed ? absL : s.lowSpeed);
      const x = s.peakSlip > 0 ? alpha / s.peakSlip : 1;
      let curve = x < 1 ? x * (2 - x) : 1 - (1 - s.slideGrip) * (x - 1 < 2 ? (x - 1) / 2 : 1);
      if (absL < s.lowSpeed && s.lowSpeed > 0) curve += (1 - curve) * (1 - absL / s.lowSpeed);
      const b = i * 16;
      t[b] = fx;
      t[b + 1] = fy;
      t[b + 2] = fz;
      t[b + 3] = sx;
      t[b + 4] = sy;
      t[b + 5] = sz;
      t[b + 6] = rx;
      t[b + 7] = ry;
      t[b + 8] = rz;
      t[b + 9] = this.effMass(rx, ry, rz, fx, fy, fz);
      t[b + 10] = this.effMass(rx, ry, rz, sx, sy, sz);
      t[b + 11] = h * (brakeIn * s.brakeForce / nw + s.rollingResistance * ws.load + (drive === 0 && sp.driven && this.nDriven > 0 ? s.engineBrake / this.nDriven : 0));
      t[b + 12] = bmax * curve;
      t[b + 13] = sp.driven && this.nDriven > 0 ? (h * drive) / this.nDriven : 0;
      t[b + 14] = 0; // accumulated along the rolling (drive + friction)
      t[b + 15] = 0; // accumulated sideways
      this.tyreBmax[i] = bmax;
      this.tyreLf[i] = 0;
      this.tyreLocked[i] = hand && sp.handbrake ? 1 : 0;
    }
    const hg = s.handbrakeGrip > 0 ? s.handbrakeGrip : 1e-6;
    for (let it = 0; it < TYRE_ITERATIONS; it++) {
      for (let i = 0; i < nw; i++) {
        const ws = this.wheels[i]!;
        if (!ws.grounded) continue;
        const b = i * 16;
        const fx = t[b]!, fy = t[b + 1]!, fz = t[b + 2]!;
        const sx = t[b + 3]!, sy = t[b + 4]!, sz = t[b + 5]!;
        const rx = t[b + 6]!, ry = t[b + 7]!, rz = t[b + 8]!;
        const ux = v[0]! + w[1]! * rz - w[2]! * ry;
        const uy = v[1]! + w[2]! * rx - w[0]! * rz;
        const uz = v[2]! + w[0]! * ry - w[1]! * rx;
        const vl = ux * fx + uy * fy + uz * fz;
        const vs = ux * sx + uy * sy + uz * sz;
        const oldL = t[b + 14]!;
        const oldS = t[b + 15]!;
        const bmax = this.tyreBmax[i]!;
        let L: number;
        let S: number;
        if (this.tyreLocked[i] === 1) {
          L = oldL - vl * t[b + 9]!;
          S = oldS - vs * t[b + 10]!;
          // Inside the ellipse of the whole grip along and handbrakeGrip of it across.
          const ex = L / bmax;
          const ey = S / (bmax * hg);
          const e2 = ex * ex + ey * ey;
          if (e2 > 1) {
            const k = 1 / Math.sqrt(e2);
            L *= k;
            S *= k;
          }
        } else {
          const bl = t[b + 11]!;
          let lf = this.tyreLf[i]! - vl * t[b + 9]!;
          lf = lf > bl ? bl : lf < -bl ? -bl : lf;
          const d = t[b + 13]!;
          L = d + lf;
          const bs = t[b + 12]!;
          S = oldS - vs * t[b + 10]!;
          S = S > bs ? bs : S < -bs ? -bs : S;
          const m2 = L * L + S * S;
          if (m2 > bmax * bmax) {
            const k = bmax / Math.sqrt(m2);
            L *= k;
            S *= k;
          }
          this.tyreLf[i] = L - d;
        }
        t[b + 14] = L;
        t[b + 15] = S;
        const dL = L - oldL;
        const dS = S - oldS;
        if (dL !== 0 || dS !== 0) this.push(v, w, rx, ry, rz, fx * dL + sx * dS, fy * dL + sy * dS, fz * dL + sz * dS);
      }
    }
    // Outputs: the sliding speed and the spin rate after the solve.
    for (let i = 0; i < nw; i++) {
      const ws = this.wheels[i]!;
      if (!ws.grounded) continue;
      const b = i * 16;
      const rx = t[b + 6]!, ry = t[b + 7]!, rz = t[b + 8]!;
      const ux = v[0]! + w[1]! * rz - w[2]! * ry;
      const uy = v[1]! + w[2]! * rx - w[0]! * rz;
      const uz = v[2]! + w[0]! * ry - w[1]! * rx;
      const vl = ux * t[b]! + uy * t[b + 1]! + uz * t[b + 2]!;
      const vs = ux * t[b + 3]! + uy * t[b + 4]! + uz * t[b + 5]!;
      const locked = this.tyreLocked[i] === 1;
      ws.slip = locked ? Math.sqrt(vl * vl + vs * vs) : vs < 0 ? -vs : vs;
      this.spinRate[i] = locked ? 0 : vl / ws.spec.radius;
    }
  }

  private readonly tyreBmax = new Float64Array(MAX_WHEELS);
  private readonly tyreLf = new Float64Array(MAX_WHEELS);
  private readonly tyreLocked = new Uint8Array(MAX_WHEELS);

  /** World centres of the hull's spheres into `worldSpheres`. */
  private placeSpheres(): void {
    const S = this.hullSpheres;
    const o = this.worldSpheres;
    const p = this.position;
    for (let i = 0; i < S.length; i += 4) {
      this.local(S[i]!, S[i + 1]!, S[i + 2]!);
      o[i] = p[0]! + this.ox;
      o[i + 1] = p[1]! + this.oy;
      o[i + 2] = p[2]! + this.oz;
      o[i + 3] = S[i + 3]!;
    }
  }

  /**
   * The hull's contacts with the world at the current pose, into `cs` (16 numbers each). Each sphere is queried
   * `margin` larger (the most any point moves in the sub-step), so a gap that would close in the sub-step is found
   * before it does: its depth is negative, and the solver lets the body approach it only as fast as closes it.
   */
  private gatherHull(margin: number): void {
    const S = this.hullSpheres;
    const p = this.position;
    const tc = this.touch;
    const c = this.cs;
    const tag = this.setup.obstacleTag;
    let n = 0;
    for (let i = 0; i < S.length && n < MAX_CONTACTS; i += 4) {
      const r = S[i + 3]!;
      this.local(S[i]!, S[i + 1]!, S[i + 2]!);
      const cx = p[0]! + this.ox;
      const cy = p[1]! + this.oy;
      const cz = p[2]! + this.oz;
      const m = this.world.sphereContacts(cx, cy, cz, r + margin, tc, tag);
      for (let k = 0; k < m && n < MAX_CONTACTS; k++) {
        const nx = tc.nx[k]!, ny = tc.ny[k]!, nz = tc.nz[k]!;
        const b = n * 16;
        // The contact point on the sphere's surface, as an arm from the centre of mass.
        c[b] = cx - nx * r - p[0]!;
        c[b + 1] = cy - ny * r - p[1]!;
        c[b + 2] = cz - nz * r - p[2]!;
        c[b + 3] = nx;
        c[b + 4] = ny;
        c[b + 5] = nz;
        c[b + 6] = tc.depth[k]! - margin;
        n++;
      }
    }
    this.nc = n;
  }

  /** Normal velocity of the body at a hull contact (b: its offset in `cs`) with velocities (lin, ang). */
  private normalSpeed(lin: Float64Array, ang: Float64Array, b: number): number {
    const c = this.cs;
    const rx = c[b]!, ry = c[b + 1]!, rz = c[b + 2]!;
    const ux = lin[0]! + ang[1]! * rz - ang[2]! * ry;
    const uy = lin[1]! + ang[2]! * rx - ang[0]! * rz;
    const uz = lin[2]! + ang[0]! * ry - ang[1]! * rx;
    return ux * c[b + 3]! + uy * c[b + 4]! + uz * c[b + 5]!;
  }

  /**
   * Hull contacts of a sub-step: velocity impulses (no approach, a bounce for fast impacts, friction up to
   * `hullFriction` × the normal impulse), then the overlap pushed out through a separate velocity that moves the
   * position only (it adds no energy).
   */
  private solveHull(hs: number): void {
    const s = this.setup;
    const c = this.cs;
    const v = this.velocity;
    const w = this.angularVelocity;
    const n = this.nc;
    const mu = s.hullFriction;
    for (let k = 0; k < n; k++) {
      const b = k * 16;
      c[b + 7] = this.effMass(c[b]!, c[b + 1]!, c[b + 2]!, c[b + 3]!, c[b + 4]!, c[b + 5]!);
      c[b + 8] = 0; // normal impulse
      const v0 = this.normalSpeed(v, w, b);
      // Target normal speed: a fast impact that touches within the sub-step bounces (across a gap of at most the
      // sub-step's travel); otherwise across a gap, at most closing it; in touch, none.
      const depth = c[b + 6]!;
      const bounce = v0 < -s.bounceSpeed && (depth >= 0 || v0 * hs < depth);
      c[b + 9] = bounce ? -s.restitution * v0 : depth < 0 ? depth / hs : 0;
      c[b + 10] = 0; // friction impulse x, y, z
      c[b + 11] = 0;
      c[b + 12] = 0;
      c[b + 13] = 0; // pseudo impulse
      let push = (PUSH_SHARE * (c[b + 6]! - SLOP)) / hs;
      if (push < 0) push = 0;
      if (push > MAX_PUSH) push = MAX_PUSH;
      c[b + 14] = push;
    }
    for (let it = 0; it < CONTACT_ITERATIONS; it++) {
      for (let k = 0; k < n; k++) {
        const b = k * 16;
        const rx = c[b]!, ry = c[b + 1]!, rz = c[b + 2]!;
        const nx = c[b + 3]!, ny = c[b + 4]!, nz = c[b + 5]!;
        const vn = this.normalSpeed(v, w, b);
        const old = c[b + 8]!;
        let j = old + (c[b + 9]! - vn) * c[b + 7]!;
        if (j < 0) j = 0;
        c[b + 8] = j;
        const dj = j - old;
        if (dj !== 0) this.push(v, w, rx, ry, rz, nx * dj, ny * dj, nz * dj);
        // Friction against the sliding at the point, the accumulated vector within mu × j.
        const ux = v[0]! + w[1]! * rz - w[2]! * ry;
        const uy = v[1]! + w[2]! * rx - w[0]! * rz;
        const uz = v[2]! + w[0]! * ry - w[1]! * rx;
        const un = ux * nx + uy * ny + uz * nz;
        let tx = ux - un * nx;
        let ty = uy - un * ny;
        let tz = uz - un * nz;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const ox = c[b + 10]!, oy = c[b + 11]!, oz = c[b + 12]!;
        let ax = ox, ay = oy, az = oz;
        if (tl > 1e-9) {
          tx /= tl;
          ty /= tl;
          tz /= tl;
          const mt = this.effMass(rx, ry, rz, tx, ty, tz);
          ax -= tx * tl * mt;
          ay -= ty * tl * mt;
          az -= tz * tl * mt;
        }
        const cap = mu * j;
        const al = Math.sqrt(ax * ax + ay * ay + az * az);
        if (al > cap) {
          const k2 = al > 0 ? cap / al : 0;
          ax *= k2;
          ay *= k2;
          az *= k2;
        }
        c[b + 10] = ax;
        c[b + 11] = ay;
        c[b + 12] = az;
        const fx = ax - ox, fy = ay - oy, fz = az - oz;
        if (fx !== 0 || fy !== 0 || fz !== 0) this.push(v, w, rx, ry, rz, fx, fy, fz);
      }
    }
    // Push out of the overlap through a velocity of the position only.
    const pv = this.pv;
    const pw = this.pw;
    pv.fill(0);
    pw.fill(0);
    for (let it = 0; it < POSITION_ITERATIONS; it++) {
      for (let k = 0; k < n; k++) {
        const b = k * 16;
        const vn = this.normalSpeed(pv, pw, b);
        const old = c[b + 13]!;
        let j = old + (c[b + 14]! - vn) * c[b + 7]!;
        if (j < 0) j = 0;
        c[b + 13] = j;
        const dj = j - old;
        if (dj !== 0) this.push(pv, pw, c[b]!, c[b + 1]!, c[b + 2]!, c[b + 3]! * dj, c[b + 4]! * dj, c[b + 5]! * dj);
      }
    }
  }

  /** Position and orientation forward by `hs` with the velocities plus the push-out velocities. */
  private integrate(hs: number): void {
    const p = this.position;
    const v = this.velocity;
    const w = this.angularVelocity;
    const pv = this.pv;
    const pw = this.pw;
    p[0] = p[0]! + (v[0]! + pv[0]!) * hs;
    p[1] = p[1]! + (v[1]! + pv[1]!) * hs;
    p[2] = p[2]! + (v[2]! + pv[2]!) * hs;
    const wx = w[0]! + pw[0]!;
    const wy = w[1]! + pw[1]!;
    const wz = w[2]! + pw[2]!;
    const q = this.orientation;
    const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!;
    const k = 0.5 * hs;
    let nx = qx + k * (wx * qw + wy * qz - wz * qy);
    let ny = qy + k * (-wx * qz + wy * qw + wz * qx);
    let nz = qz + k * (wx * qy - wy * qx + wz * qw);
    let nw = qw + k * (-wx * qx - wy * qy - wz * qz);
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    nx /= l;
    ny /= l;
    nz /= l;
    nw /= l;
    q[0] = nx;
    q[1] = ny;
    q[2] = nz;
    q[3] = nw;
  }

  /** Relative velocity of this body against `o` at a pair contact (b: offset in PAIR), into ox, oy, oz. */
  private relVelocity(o: WheeledBody, c: Float64Array, b: number): void {
    const va = this.velocity, wa = this.angularVelocity, vb = o.velocity, wb = o.angularVelocity;
    const ax = c[b]!, ay = c[b + 1]!, az = c[b + 2]!;
    const bx = c[b + 3]!, by = c[b + 4]!, bz = c[b + 5]!;
    this.ox = va[0]! + wa[1]! * az - wa[2]! * ay - (vb[0]! + wb[1]! * bz - wb[2]! * by);
    this.oy = va[1]! + wa[2]! * ax - wa[0]! * az - (vb[1]! + wb[2]! * bx - wb[0]! * bz);
    this.oz = va[2]! + wa[0]! * ay - wa[1]! * ax - (vb[2]! + wb[0]! * by - wb[1]! * bx);
  }

  private relNormal(o: WheeledBody, c: Float64Array, b: number): number {
    this.relVelocity(o, c, b);
    return this.ox * c[b + 6]! + this.oy * c[b + 7]! + this.oz * c[b + 8]!;
  }

  /** Inverse effective mass of the pair along the unit u at a contact. */
  private pairMass(o: WheeledBody, c: Float64Array, b: number, ux: number, uy: number, uz: number): number {
    return this.invMass + o.invMass + this.angularMass(c[b]!, c[b + 1]!, c[b + 2]!, ux, uy, uz) + o.angularMass(c[b + 3]!, c[b + 4]!, c[b + 5]!, ux, uy, uz);
  }
}

/** The group a body was given to (`WheeledGroup`): its steps and its `alpha` are the group's. */
const GROUP_OF = new WeakMap<WheeledBody, WheeledGroup>();

/** Pair contacts at most, and their scratch (shared: one pair is solved at a time). */
const PAIR_MAX = 32;
const PAIR = new Float64Array(PAIR_MAX * 12);

/**
 * Pushes two wheeled bodies apart where their hulls overlap (`WheeledBody.collide`): equal and opposite impulses,
 * the overlap shared by mass. Call it after both took the same fixed step; `WheeledGroup` does it for a set.
 */
export function collideWheeledBodies(a: WheeledBody, b: WheeledBody): boolean {
  return a.collide(b);
}

/**
 * Several wheeled bodies stepped together: each fixed step steps every body in order, then pushes apart every pair
 * that touches, in the order (0, 1), (0, 2), …, (1, 2), …, so the result does not depend on anything but the inputs.
 * The bodies must share `stepHz`, and a body belongs to one group: its own `advance` throws from then on, and its
 * `alpha` (the default of its `render*` calls) is the group's.
 */
export class WheeledGroup {
  readonly bodies: readonly WheeledBody[];
  /** The group's fixed steps (one clock for all its bodies). */
  readonly fixed: FixedSteps;
  private readonly idle = newWheeledIntent();
  private dueIntents: readonly (WheeledIntent | null | undefined)[] = [];
  private dueAfter: ((touching: number) => void) | null = null;

  constructor(bodies: readonly WheeledBody[]) {
    if (bodies.length === 0) throw new Error('WheeledGroup: at least one body');
    const hz = bodies[0]!.setup.stepHz;
    for (const b of bodies) if (b.setup.stepHz !== hz) throw new Error('WheeledGroup: the bodies must share stepHz');
    for (const b of bodies) if (GROUP_OF.has(b) || bodies.indexOf(b) !== bodies.lastIndexOf(b)) throw new Error('WheeledGroup: a body is already in a group');
    this.bodies = bodies;
    for (const b of bodies) GROUP_OF.set(b, this);
    this.fixed = new FixedSteps(1 / hz, bodies[0]!.setup.maxStepsPerAdvance);
  }

  /** Seconds of one fixed step. */
  get stepSeconds(): number {
    return this.fixed.stepSeconds;
  }

  /** Share of the way from the last step to the next one, 0–1 (also each body's `alpha`). */
  get alpha(): number {
    return this.fixed.alpha;
  }

  /**
   * Runs the fixed steps due in `dt` real seconds (as `WheeledBody.advance`); `intents[i]` drives body i (null: idle).
   * `afterStep`, when given, is called after every step with the number of touching pairs: the place for what has to
   * follow each step (obstacles in the collision world, timelines, marks on the ground). It may change `intents` for
   * the next step.
   */
  advance(dt: number, intents: readonly (WheeledIntent | null | undefined)[], afterStep?: (touching: number) => void): number {
    if (!(dt > 0)) return 0;
    this.dueIntents = intents;
    this.dueAfter = afterStep ?? null;
    const n = this.fixed.advance(dt, this.stepDue);
    this.dueIntents = [];
    this.dueAfter = null;
    return n;
  }

  /** One step due in `advance`, then its hook. */
  private readonly stepDue = (): void => {
    const touching = this.step(this.dueIntents);
    if (this.dueAfter) this.dueAfter(touching);
  };

  /** One fixed step of every body, then the pairs. Returns the number of touching pairs. */
  step(intents: readonly (WheeledIntent | null | undefined)[]): number {
    const bs = this.bodies;
    for (let i = 0; i < bs.length; i++) bs[i]!.step(intents[i] ?? this.idle);
    let touching = 0;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) if (bs[i]!.collide(bs[j]!)) touching++;
    }
    return touching;
  }
}

function driveCurve(speed: number, force: number, top: number): number {
  if (!(top > 0) || speed >= top) return 0;
  const r = speed / top;
  return force * (1 - r * r);
}

function clampTo(x: number, lo: number, hi: number): number {
  if (!(x === x)) return 0;
  return x < lo ? lo : x > hi ? hi : x;
}

function abs(x: number): number {
  return x < 0 ? -x : x;
}

/** The rotation of a unit quaternion as three columns into out[0..8]. */
function quatColumns(x: number, y: number, z: number, w: number, out: Mat34 | Float64Array): void {
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y + w * z);
  out[2] = 2 * (x * z - w * y);
  out[3] = 2 * (x * y - w * z);
  out[4] = 1 - 2 * (x * x + z * z);
  out[5] = 2 * (y * z + w * x);
  out[6] = 2 * (x * z + w * y);
  out[7] = 2 * (y * z - w * x);
  out[8] = 1 - 2 * (x * x + y * y);
}
