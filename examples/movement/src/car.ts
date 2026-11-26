// Driving: two compact cars (examples/shared vehicles/compact.ts) on the course, each the engine's `WheeledBody`, stepped
// together in a `WheeledGroup` so they push each other apart; the figure gets into one, drives it and gets out. Pure
// logic shared by the page (main.ts) and the headless check (tools/walk/car-scenarios.ts): no DOM, no graphics.
//
// Every car keeps its obstacle box in the collision world (`syncObstacle` after each step while it moves), so the
// figure's walker and the steed's walker are blocked by it; the cars' own hulls do not see the boxes, and they meet each
// other through the group. A car nobody drives holds its handbrake.
//
// Getting in (`enter` within `CAR_REACH_M` of the place beside the driver's door, the left one, when that place is
// free and the way to it is not blocked): the figure steps to the door, the door swings open, the figure ducks in and
// sits down, the door shuts and the figure is no longer drawn (the glass is dark). Getting out (`exit`, the car nearly
// stopped) runs the other way through the driver's door, or the right door when the left side is blocked (a solid or a
// drop beside it: the collision world's `firstStandSpot`), and the figure's walker is put there at once
// (`releaseToWalker`). The timeline is the engine's `SeatTransition` (`CAR_SEAT`), stepped with the cars; the doors are
// cues at its times. While the figure drives, its walker is parked.
//
// Tyre marks: where a grounded wheel slides faster than `SKID_SLIP_MS`, and wherever it rolls on loose ground, the
// engine's `ContactStreaks` lays marks from contact to contact into a `ContactTrail` (the page's, shared with the
// prints of feet and hooves), stamped with the cars' clock (`time`); the page's trail layer fades them by their age.
//
// Time is the group's fixed steps (`WheeledGroup.advance` with a hook after each step): the same inputs give the same
// states, bit for bit.

import { ContactStreaks, ContactTrail } from 'wallhammer-web/core';
import { IDENTITY_34, Pose, SeatTransition, blendPose, headingRoot, solvePose } from 'wallhammer-web/motion';
import type { SeatTransitionOptions, Socket } from 'wallhammer-web/motion';
import { WheeledBody, WheeledGroup, attachFromWalker, fourWheels, newSlideResult, newWheeledIntent, releaseToWalker } from 'wallhammer-web/world';
import type { CollisionWorld, StandSpotOptions, Walker, WheeledBodySetup, WheeledIntent } from 'wallhammer-web/world';
import { shift, turn } from '../../shared/src/figures/kind.ts';
import { COMPACT_CAR } from '../../shared/src/vehicles/compact.ts';
import type { PathfinderBody } from './body.ts';
import { SURFACE } from './course.ts';
import { TRACE_KIND, TRACE_LIFE_S } from './trace-kinds.ts';

/**
 * The cars' body: the hull box and the mass the compact car's mesh is drawn round (`COMPACT_CAR`: 1,200 kg, 4.2 ×
 * 1.8 m), with the centre of mass a little higher over the wheels and the hull box moved down to match
 * (`CAR_WHEELS`), so the body visibly rolls in a turn and pitches under the throttle and the brake without rocking on
 * afterwards. The forces, the tyres and the steering are the engine's reference values.
 */
export const CAR_SETUP: Partial<WheeledBodySetup> = {
  mass: COMPACT_CAR.mass,
  halfWidth: COMPACT_CAR.halfWidth,
  halfHeight: COMPACT_CAR.halfHeight,
  halfLength: COMPACT_CAR.halfLength,
  hullY: 0.22,
};
/**
 * The wheels' mounts, springs, dampers and grip (their places and radius are `COMPACT_CAR`'s): mounted 0.06 m below
 * the centre of mass, springs of 26,000 N/m and dampers of 3,200 N·s/m, 0.35 m long with 0.22 m of travel, the rear
 * wheels gripping a little more than the front ones, driven at the rear.
 */
export const CAR_WHEELS = { mountY: -0.06, restLength: 0.35, travel: 0.22, stiffness: 26000, damping: 3200, frontGrip: 1, rearGrip: 1.05, drive: 'rear' } as const;

/** Farthest the figure's feet may be from the place beside the driver's door to get in, m. */
export const CAR_REACH_M = 2;
/** Getting out only below this speed, m/s. */
export const CAR_EXIT_SPEED_MS = 1;
/** Seconds a door takes to open or shut. */
export const DOOR_S = 0.35;
/** Seconds the figure takes to duck in and sit (or to get up and step out). */
export const SLIDE_S = 0.8;
/** A grounded wheel sliding faster than this lays tyre marks, m/s. */
export const SKID_SLIP_MS = 2.5;
/** Width of a tyre mark, m. */
export const TYRE_MARK_WIDTH_M = 0.2;

/**
 * The timeline of getting in and out (after the walk to the door): in, 0.1 s after reaching the door the figure moves
 * across onto the seat over most of `SLIDE_S` while its feet's place rises half the way to the seat in the first half
 * (so the pelvis meets the cushion), then the door shuts (`DOOR_S`); out, after 0.3 s for the door the same backward.
 * The seat itself is upright at the car's heading (`seatRoot`), so the seat's tilt does not matter.
 */
export const CAR_SEAT: SeatTransitionOptions = {
  tilt: 1,
  attach: { seconds: 0.1 + SLIDE_S + DOOR_S, weightFrom: 0.1, weightSeconds: 0.85 * SLIDE_S, rise: 0.5, riseFrom: 0.1, riseTo: 0.1 + 0.5 * SLIDE_S },
  release: { seconds: 0.3 + SLIDE_S, weightFrom: 0.3 + 0.15 * SLIDE_S, weightSeconds: 0.85 * SLIDE_S, rise: 0.5, riseFrom: 0.3 + 0.5 * SLIDE_S, riseTo: 0.3 + SLIDE_S },
};
/** The seat as a socket of its own transform (`seatRoot`, a one-bone carrier). */
const SEAT_SOCKET: Socket = { bone: 0, local: IDENTITY_34 };

export type DriveMode = 'off' | 'entering' | 'on' | 'exiting';

/** A car's place: x, z and the heading in degrees (0 faces −z). */
export type CarPlace = readonly [number, number, number];

/** What `Cars.status` reports of one car. */
export interface CarStatus {
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  /** Speed along its forward axis, m/s (negative backward). */
  speed: number;
  /** Its up axis in the world. */
  up: [number, number, number];
  asleep: boolean;
  /** Steer angle of the front wheels, degrees (positive turns right). */
  steerDeg: number;
  /** Per wheel (front left, front right, rear left, rear right). */
  compression: number[];
  slip: number[];
  grounded: boolean[];
  /** Doors' opening, left and right, 0–1. */
  doors: [number, number];
  /** The lamps: braking, reversing. */
  brake: boolean;
  reversing: boolean;
}

export interface DriveStatus {
  mode: DriveMode;
  /** The car the figure is in or getting into, −1 none. */
  car: number;
  /** The side the figure gets in or out at: 1 left (the driver's), −1 right. */
  side: number;
  /** Weight of the car's camera, 0 on foot to 1 driving. */
  weight: number;
  cars: CarStatus[];
  /** Tyre marks laid so far (the trail keeps the last `capacity` of all its marks). */
  marks: number;
}

const DEG = Math.PI / 180;

export class Cars {
  readonly bodies: readonly WheeledBody[];
  readonly group: WheeledGroup;
  /** Opening of every car's doors, 0–1: car i's left door at 2i, its right door at 2i + 1. */
  readonly doors: Float64Array;
  /** The driver's wishes while driving (the page or a script fills it before `step`). */
  readonly drive: WheeledIntent = newWheeledIntent();
  /** The trail the tyre marks go into (shared with whatever else the page marks the ground with). */
  readonly trail: ContactTrail;
  /** Tyre marks laid so far. */
  marksLaid = 0;
  private readonly streaks: ContactStreaks;
  readonly rider: PathfinderBody;
  readonly riderWalker: Walker;
  /** Getting in, driving and getting out. */
  readonly transition = new SeatTransition(CAR_SEAT);
  /** The car the figure is in or getting into, −1 none. */
  car = -1;
  /** 1: the driver's (left) door, −1: the right one. */
  side = 1;
  /** Group steps since construction. */
  steps = 0;
  private readonly world: CollisionWorld;
  private readonly parked: WheeledIntent;
  private readonly intents: WheeledIntent[];
  private readonly prevDoors: Float64Array;
  private readonly doorTarget: Float64Array;
  private readonly synced: boolean[];
  private readonly stand: StandSpotOptions;
  private readonly spots = new Float64Array(8);
  /** The seat's transform at the drawn place (`figurePlace`), and the share of the step it was drawn at. */
  private readonly seatRoot = new Float64Array(12);
  private drawA = 1;
  private readonly seat: Pose;
  private readonly ids: { root: number; torso: number; head: number; legL: number; legR: number; shinL: number; shinR: number; armL: number; armR: number; foreL: number; foreR: number; cloak: number; lampL: number; lampR: number };
  private readonly slide = newSlideResult();
  private readonly m = new Float64Array(12);
  private readonly root = new Float64Array(12);
  private readonly p = new Float64Array(4);
  private readonly q = new Float64Array(4);

  constructor(world: CollisionWorld, rider: PathfinderBody, riderWalker: Walker, places: readonly CarPlace[], trail: ContactTrail = new ContactTrail(1024)) {
    this.world = world;
    this.rider = rider;
    this.riderWalker = riderWalker;
    const rs = riderWalker.setup;
    // Ground beside the car a little lower or higher than a step still counts (a car stands on its wheels' contacts).
    this.stand = { radius: rs.radius, height: rs.height, maxStepUp: rs.maxStepUp, maxRise: rs.maxStepUp + 0.05 };
    const bodies = places.map(() => new WheeledBody(world, { ...CAR_SETUP, wheels: carWheels() }));
    this.bodies = bodies;
    this.group = new WheeledGroup(bodies);
    this.doors = new Float64Array(bodies.length * 2);
    this.prevDoors = new Float64Array(bodies.length * 2);
    this.doorTarget = new Float64Array(bodies.length * 2);
    this.synced = bodies.map(() => false);
    this.parked = newWheeledIntent();
    this.parked.handbrake = true;
    this.intents = bodies.map(() => this.parked);
    this.trail = trail;
    this.streaks = new ContactStreaks(trail, bodies.length * 4);
    const sk = rider.kind.skeleton;
    const id = (n: string): number => {
      const i = sk.names.indexOf(n);
      if (i < 0) throw new Error(`Cars: the figure has no bone ${n}`);
      return i;
    };
    this.ids = { root: id('root'), torso: id('torso'), head: id('head'), legL: id('legL'), legR: id('legR'), shinL: id('shinL'), shinR: id('shinR'), armL: id('armL'), armR: id('armR'), foreL: id('foreL'), foreR: id('foreR'), cloak: id('cloak'), lampL: id('lampL'), lampR: id('lampR') };
    this.seat = new Pose(sk);
    places.forEach((pl, i) => this.put(i, pl[0], pl[1], pl[2] * DEG));
  }

  /** Seconds of one fixed step. */
  get stepSeconds(): number {
    return this.group.stepSeconds;
  }

  /** Where the figure is: on foot, getting in (the walk to the door included), driving, getting out. */
  get mode(): DriveMode {
    const p = this.transition.phase;
    return p === 'free' ? 'off' : p === 'held' ? 'on' : p === 'release' ? 'exiting' : 'entering';
  }

  /** The cars' clock: seconds of the group's steps since construction (the time tyre marks are stamped with). */
  get time(): number {
    return this.steps * this.stepSeconds;
  }

  /** True while the figure is in a car or getting in or out. */
  get active(): boolean {
    return this.mode !== 'off';
  }

  /** True while anything still moves: a car awake, a door swinging, the figure getting in or out. */
  get busy(): boolean {
    if (this.mode === 'entering' || this.mode === 'exiting') return true;
    for (const b of this.bodies) if (!b.asleep) return true;
    for (let k = 0; k < this.doors.length; k++) if (this.doors[k] !== this.doorTarget[k] || this.prevDoors[k] !== this.doors[k]) return true;
    return false;
  }

  /** Puts car `i` at rest on the ground at (x, z) with the heading `yaw` (radians); a driver stays in. */
  put(i: number, x: number, z: number, yaw: number): void {
    const b = this.bodies[i]!;
    const g = this.world.groundAt(x, z, 1e4, 0);
    b.teleport(x, g + b.restHeight, z, yaw);
    b.syncObstacle();
    this.synced[i] = true;
  }

  /** Takes every car's obstacle box out of the collision world (before the cars are dropped). */
  removeObstacles(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      this.bodies[i]!.removeObstacle();
      this.synced[i] = false;
    }
  }

  /** Car `i`'s place: x, z and the heading in degrees. */
  place(i: number): [number, number, number] {
    const b = this.bodies[i]!;
    return [b.position[0]!, b.position[2]!, b.yaw / DEG];
  }

  /** Ends any drive at once (the figure's walker stays where it is), shuts every door and ends the tyre marks' chains. */
  stopDriving(): void {
    this.transition.releaseNow();
    this.car = -1;
    this.doors.fill(0);
    this.prevDoors.fill(0);
    this.doorTarget.fill(0);
    this.drive.throttle = this.drive.brake = this.drive.steer = 0;
    this.drive.handbrake = false;
    this.streaks.reset();
  }

  /** A point of car `i`'s body frame in the world after its last step (`ly` from the centre of mass). */
  private toWorld(i: number, lx: number, ly: number, lz: number, out: Float64Array): Float64Array {
    const b = this.bodies[i]!, R = b.rotation, p = b.position;
    out[0] = p[0]! + R[0]! * lx + R[3]! * ly + R[6]! * lz;
    out[1] = p[1]! + R[1]! * lx + R[4]! * ly + R[7]! * lz;
    out[2] = p[2]! + R[2]! * lx + R[5]! * ly + R[8]! * lz;
    return out;
  }

  /** The place beside car `i`'s door on `side` (1 left, −1 right): x, ground y, z and the car's heading. */
  doorSpot(i: number, side: number, out: Float64Array = new Float64Array(4)): Float64Array {
    const b = this.bodies[i]!;
    this.toWorld(i, side * COMPACT_CAR.doorSpot[0], 0, COMPACT_CAR.doorSpot[1], out);
    out[1] = this.world.groundAt(out[0]!, out[2]!, b.position[1]! + 0.3, 0.6);
    out[3] = b.yaw;
    return out;
  }

  /** Whether the figure fits beside car `i` on `side`: no solid there (another car's box included), ground within a step. */
  sideFree(i: number, side: number): boolean {
    this.sideSpot(i, side, this.spots, 0);
    const sp = this.spots, b = this.bodies[i]!;
    return !Number.isNaN(this.world.standSpot(sp[0]!, sp[1]!, sp[2]!, sp[3]!, b.position[1]! - b.restHeight, this.stand));
  }

  /**
   * The way to the place beside car `i`'s door on `side` into `out` at `o`: from just outside the car's own box (a start
   * inside a solid is pushed out, so a wall beyond shows) to the place.
   */
  private sideSpot(i: number, side: number, out: Float64Array, o: number): void {
    const b = this.bodies[i]!, r = this.riderWalker.setup;
    const d = this.doorSpot(i, side, this.p);
    const s = this.toWorld(i, side * -(b.setup.halfWidth + r.radius + 0.03), 0, COMPACT_CAR.doorSpot[1], this.q);
    out[o] = s[0]!;
    out[o + 1] = s[2]!;
    out[o + 2] = d[0]!;
    out[o + 3] = d[2]!;
  }

  /** The side to get out of car `i` at: the driver's (1), or the right (−1) when only that one is free. */
  private freeSide(i: number): number {
    this.sideSpot(i, 1, this.spots, 0);
    this.sideSpot(i, -1, this.spots, 4);
    const b = this.bodies[i]!;
    return this.world.firstStandSpot(this.spots, b.position[1]! - b.restHeight, this.stand) === 1 ? -1 : 1;
  }

  /** Distance of the figure's feet from the place beside car `i`'s driver's door, m. */
  distance(i: number): number {
    const p = this.riderWalker.position;
    const d = this.doorSpot(i, 1, this.p);
    return Math.hypot(p[0]! - d[0]!, p[2]! - d[2]!);
  }

  /**
   * Whether the figure can get into car `i` now: on foot, within reach of the driver's door, the place there free and
   * the way to it open (no wall between).
   */
  near(i: number): boolean {
    if (this.mode !== 'off') return false;
    const w = this.riderWalker, p = w.position, r = w.setup;
    const d = this.doorSpot(i, 1, this.p);
    if (Math.hypot(p[0]! - d[0]!, p[2]! - d[2]!) > CAR_REACH_M || Math.abs(p[1]! - d[1]!) > 0.6) return false;
    if (!this.sideFree(i, 1)) return false;
    const d2 = this.doorSpot(i, 1, this.p);
    const y = p[1]!;
    // The way there: a slide that ends near the place (it may graze something on the way).
    const out = this.world.slide(p[0]!, p[2]!, r.radius, y + r.maxStepUp, y + r.height, d2[0]! - p[0]!, d2[2]! - p[2]!, this.slide);
    return Math.hypot(out.x - d2[0]!, out.z - d2[2]!) < 0.15;
  }

  /** The car the figure could get into now (the nearest), or −1. */
  nearest(): number {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.bodies.length; i++) {
      if (!this.near(i)) continue;
      const d = this.distance(i);
      if (d < bestD) (best = i), (bestD = d);
    }
    return best;
  }

  /** Gets into car `i` (it must be `near` unless `instant`). `instant`: at once, seated, the door shut. */
  enter(i: number, instant = false): boolean {
    if (this.mode !== 'off' || i < 0 || i >= this.bodies.length) return false;
    if (!instant && !this.near(i)) return false;
    const p = this.riderWalker.position;
    const d = this.doorSpot(i, 1, this.p);
    // The walk to the door at about 1.4 m/s, at least 0.3 s and at most 1.4 s.
    attachFromWalker(this.transition, this.riderWalker, Math.min(1.4, Math.max(0.3, Math.hypot(d[0]! - p[0]!, d[2]! - p[2]!) / 1.4)));
    if (instant) this.transition.attachNow();
    this.car = i;
    this.side = 1;
    this.drive.throttle = 0;
    this.drive.brake = 0;
    this.drive.steer = 0;
    this.drive.handbrake = false;
    return true;
  }

  /**
   * Gets out at the driver's door, or the right one when the left side is blocked; only when the car is nearly
   * stopped (`CAR_EXIT_SPEED_MS`). `instant`: at once, the figure standing beside the car.
   */
  exit(instant = false): boolean {
    if (this.mode !== 'on') return false;
    const b = this.bodies[this.car]!;
    if (Math.abs(b.forwardSpeed) > CAR_EXIT_SPEED_MS) return false;
    this.side = this.freeSide(this.car);
    // The figure's walker goes to the door now, not at the end: what follows the figure (the camera) blends from the
    // car toward that place, never toward the place it got in at.
    const d = this.besideDoor(this.p);
    releaseToWalker(this.transition, this.riderWalker, d[0]!, d[1]!, d[2]!, d[3]!);
    if (instant) this.finishExit();
    return true;
  }

  /** The figure stands beside the car on `side`, facing the car's way: its walker put there, the drive over. */
  private finishExit(): void {
    const d = this.besideDoor(this.p);
    this.riderWalker.teleport(d[0]!, d[1]!, d[2]!, d[3]!);
    this.doorTarget[this.car * 2 + (this.side === 1 ? 0 : 1)] = 0;
    this.transition.releaseNow();
    this.car = -1;
  }

  /** Where the figure stands beside the driven car's door on `side`: x, ground y, z and the car's heading. */
  private besideDoor(out: Float64Array): Float64Array {
    const d = this.doorSpot(this.car, this.side, out);
    d[1] = this.world.groundAt(d[0]!, d[2]!, d[1]! + 0.4, 0.4);
    return d;
  }

  /** Puts the driven car upright on its wheels where it is (after a roll), keeping its heading. */
  resetCar(): void {
    if (this.car < 0) return;
    this.bodies[this.car]!.setUpright();
    this.bodies[this.car]!.syncObstacle();
  }

  /**
   * One fixed step of every car (the driven one by `drive` while the figure drives, every other holding its
   * handbrake), the obstacle boxes, the doors, the getting in or out and the tyre marks.
   */
  step(): void {
    this.fillIntents();
    this.group.step(this.intents);
    this.afterStep();
  }

  /** Advances by `dt` seconds of frames in the group's fixed steps; returns the steps taken. */
  advance(dt: number): number {
    this.fillIntents();
    return this.group.advance(dt, this.intents, this.afterGroupStep);
  }

  /** Share of the way from the last step to the next one, 0–1: draw the cars, doors and the figure at it. */
  get alpha(): number {
    return this.group.alpha;
  }

  /** Who drives each car in the next step. */
  private fillIntents(): void {
    for (let i = 0; i < this.bodies.length; i++) this.intents[i] = i === this.car && this.mode === 'on' ? this.drive : this.parked;
  }

  /** The group's hook: what follows a step, then the drivers of the next one. */
  private readonly afterGroupStep = (): void => {
    this.afterStep();
    this.fillIntents();
  };

  /** What follows every step of the group: the obstacle boxes, the doors, the getting in or out, the tyre marks. */
  private afterStep(): void {
    const dt = this.stepSeconds;
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!;
      if (!b.asleep || !this.synced[i]) {
        b.syncObstacle();
        this.synced[i] = b.asleep;
      }
    }
    this.prevDoors.set(this.doors);
    this.timeline(dt);
    const rate = dt / DOOR_S;
    for (let k = 0; k < this.doors.length; k++) {
      const d = this.doors[k]!, t = this.doorTarget[k]!;
      this.doors[k] = d < t ? Math.min(t, d + rate) : Math.max(t, d - rate);
    }
    this.steps++;
    // Tyre marks: dark where a wheel slides, ruts where it rolls on loose ground.
    const now = this.time;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!;
      for (let w = 0; w < b.wheels.length; w++) {
        const ws = b.wheels[w]!;
        const skid = ws.grounded && ws.slip > SKID_SLIP_MS;
        const rut = ws.grounded && ws.surfaceTag === SURFACE.loose;
        const kind = skid ? TRACE_KIND.skid : TRACE_KIND.rut;
        const c = ws.contact, nm = ws.normal;
        if (this.streaks.touch(i * 4 + w, skid || rut, c[0]!, c[1]!, c[2]!, nm[0]!, nm[1]!, nm[2]!, TYRE_MARK_WIDTH_M, kind, now, TRACE_LIFE_S[kind]!)) this.marksLaid++;
      }
    }
  }

  /** Brings the getting in or out one step on: the door's cues and the figure's own gait (walking to the door, standing after). */
  private timeline(dt: number): void {
    const tr = this.transition;
    tr.advance(dt);
    if (this.car < 0) return;
    const door = this.car * 2 + (this.side === 1 ? 0 : 1);
    if (tr.gettingOn) {
      const A = tr.approachSeconds;
      if (tr.passed(A - 0.2)) this.doorTarget[door] = 1;
      if (tr.passed(A + 0.1 + SLIDE_S)) this.doorTarget[door] = 0;
      const d = this.doorSpot(this.car, 1, this.p), f = tr.from;
      this.rider.update(dt, tr.approachMoved(Math.hypot(d[0]! - f[0]!, d[2]! - f[2]!)), true, 0);
    } else if (tr.gettingOff) {
      if (tr.became('free')) {
        this.rider.update(dt, 0, true, 0);
        this.finishExit();
      } else {
        this.doorTarget[door] = 1;
        this.rider.update(dt, 0, true, 0);
      }
    }
  }

  /** Weight of the car's camera at `a` of the way between the last two steps: 0 on foot, 1 driving. */
  weight(a = 1): number {
    return this.car >= 0 ? this.transition.progress(a) : 0;
  }

  /** Door `k`'s opening (car i's left door at 2i, right at 2i + 1) at `a` of the way between the last two steps. */
  door(k: number, a = 1): number {
    return this.prevDoors[k]! + (this.doors[k]! - this.prevDoors[k]!) * a;
  }

  /**
   * Whether the figure is drawn: not once it sits (the figure is taller than the cabin, so it would show through the
   * roof; the glass is dark), from the moment it is seated until it starts to get up again.
   */
  get figureShown(): boolean {
    const m = this.mode, tr = this.transition;
    if (m === 'on') return false;
    if (m === 'off') return true;
    return m === 'entering' ? !tr.passed(tr.approachSeconds + 0.1 + SLIDE_S) : tr.passed(0.3);
  }

  /** Whether the figure's pose comes from here (getting in or out) rather than from its walker. */
  get posesFigure(): boolean {
    const m = this.mode;
    return m === 'entering' || m === 'exiting';
  }

  /**
   * Where the figure is drawn while getting in or out, at `a` of the way between the last two steps: x, y, z of its
   * feet and its heading into `out` (the free place: on the walk to the door, then beside it, raised toward the seat);
   * also returns how far it sits (0 standing, 1 seated). Keeps the seat's transform for `poseFigure`.
   */
  figurePlace(a: number, out: Float64Array): number {
    const b = this.bodies[this.car]!;
    b.renderMatrix(this.m, a);
    const m = this.m;
    const heading = b.renderYaw(a);
    const spotX = this.side * COMPACT_CAR.doorSpot[0], spotZ = COMPACT_CAR.doorSpot[1];
    const st = this.q;
    st[0] = m[0]! * spotX + m[6]! * spotZ + m[9]!;
    st[2] = m[2]! * spotX + m[8]! * spotZ + m[11]!;
    st[1] = this.world.groundAt(st[0], st[2], m[10]! + 0.3, 0.6);
    st[3] = heading;
    const seatX = COMPACT_CAR.seat[0], seatZ = COMPACT_CAR.seat[2];
    const seatLy = COMPACT_CAR.seat[1] - b.restHeight;
    const cx = m[0]! * seatX + m[3]! * seatLy + m[6]! * seatZ + m[9]!;
    const cy = m[1]! * seatX + m[4]! * seatLy + m[7]! * seatZ + m[10]!;
    const cz = m[2]! * seatX + m[5]! * seatLy + m[8]! * seatZ + m[11]!;
    headingRoot(cx, cy, cz, heading, this.rider.scale, this.seatRoot);
    this.drawA = a;
    this.transition.place(st, cy, out, a);
    return this.transition.weight(a);
  }

  /**
   * The figure's bones while getting in or out (after `figurePlace` told where): its standing gait at the free place
   * blended with the seat's transform and into a ducked seat by `sit`.
   */
  poseFigure(place: Float64Array, sit: number): Float64Array {
    const body = this.rider;
    if (sit <= 0) return body.pose(place[0]!, place[1]!, place[2]!, place[3]!);
    const g = body.gait;
    const r = this.root;
    headingRoot(place[0]!, place[1]!, place[2]!, place[3]!, body.scale, r);
    this.transition.write(r, this.seatRoot, SEAT_SOCKET, r, this.drawA);
    body.root.set(r);
    g.graph.evaluate(g.pose);
    this.seated(this.seat);
    blendPose(g.pose, g.pose, this.seat, sit);
    solvePose(body.kind.skeleton, g.pose, r, g.world);
    body.tailAngle = g.applyLag(r);
    return g.world;
  }

  /** Seated low and ducked under the roof: thighs forward, shins down, hands forward to the wheel. */
  private seated(pose: Pose): void {
    const id = this.ids;
    pose.reset();
    const lean = 0.6;
    shift(pose, id.root, 0, -0.46, 0);
    turn(pose, id.torso, lean);
    turn(pose, id.head, -0.55);
    for (const s of [1, -1]) {
      const L = s > 0;
      turn(pose, L ? id.legL : id.legR, -1.4, 0, 0.1 * s);
      turn(pose, L ? id.shinL : id.shinR, 1.35);
      turn(pose, L ? id.armL : id.armR, -0.5, 0, -0.05 * s);
      turn(pose, L ? id.foreL : id.foreR, -0.7);
    }
    turn(pose, id.cloak, -0.3);
    turn(pose, id.lampL, -lean);
    turn(pose, id.lampR, -lean);
  }

  /** The lamps of car `i`: brake 0–1 plus 2 while reversing (the car material's fourth number). */
  lamps(i: number): number {
    if (i !== this.car || this.mode !== 'on') return 0;
    const b = this.bodies[i]!, d = this.drive, v = b.forwardSpeed;
    const braking = d.brake > 0.05 || (d.throttle < -0.05 && v > CAR_EXIT_SPEED_MS) || (d.throttle > 0.05 && v < -CAR_EXIT_SPEED_MS) || (d.handbrake && Math.abs(v) > 0.3);
    const reversing = (d.throttle < -0.05 && v <= CAR_EXIT_SPEED_MS) || v < -0.5;
    return (braking ? 1 : 0) + (reversing ? 2 : 0);
  }

  /** The state for a script. */
  status(a = 1): DriveStatus {
    return {
      mode: this.mode,
      car: this.car,
      side: this.side,
      weight: this.weight(a),
      marks: this.marksLaid,
      cars: this.bodies.map((b, i): CarStatus => {
        const p = b.position, R = b.rotation, l = this.lamps(i);
        return {
          x: p[0]!,
          y: p[1]!,
          z: p[2]!,
          yawDeg: b.yaw / DEG,
          speed: b.forwardSpeed,
          up: [R[3]!, R[4]!, R[5]!],
          asleep: b.asleep,
          steerDeg: b.steerAngle / DEG,
          compression: b.wheels.map((w) => w.compression),
          slip: b.wheels.map((w) => w.slip),
          grounded: b.wheels.map((w) => w.grounded),
          doors: [this.doors[i * 2]!, this.doors[i * 2 + 1]!],
          brake: (l & 1) === 1,
          reversing: l >= 2,
        };
      }),
    };
  }
}

/** The wheels of `fourWheels` where the compact car's mesh has them, with the cars' mounts, springs and dampers. */
function carWheels() {
  return fourWheels({ halfTrack: COMPACT_CAR.halfTrack, frontZ: COMPACT_CAR.frontAxleZ, rearZ: COMPACT_CAR.rearAxleZ, radius: COMPACT_CAR.wheelRadius, ...CAR_WHEELS });
}
