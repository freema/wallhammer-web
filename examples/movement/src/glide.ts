// The glider: the pathfinder gets on a large flying animal (examples/shared glider.ts), crawls it over the course,
// takes off, flies, lands and gets off. Pure logic shared by the page (main.ts) and the headless check
// (tools/walk/glide-scenarios.ts): no DOM, no graphics.
//
// The glider is the engine's `FlyingBody` (`GLIDER_BODY`: its numbers are this file's): on the ground a crawl along its
// heading, steered by turning (no view-relative steering: a body this wide turns before it goes); a leap and beats
// take it off; in the air the pitch, the bank, the beats and a flare. By default the rider flies it through the
// engine's `FlightAssist` (`GLIDER_ASSIST`): a wanted speed, a climb or descent and a turn, the assist working the
// pitch, the beats and the flare; `assisted = false` gives the raw controls. Its paws are stepped on the ground by
// `GliderGait` (the shared quad-gait.ts: the engine's `StepCycle`, a `TwoBoneReach` per leg), its wings posed in the
// air by the kind's `fly`.
//
// The rider is posed as on the steed (ride.ts; the same `SeatTransition` timeline `RIDE_SEAT`, the riding graph, the
// hands on the reins' grips, the feet in the rope loops), with two differences: the figure climbs on and gets off
// behind the left wing (or the right), not beside the body under the wing; and in the air the seat takes the whole
// tilt of the body (it banks and pitches with it), on the ground the steed's share.
//
// Time is the flying body's: the same steps give the same poses.

import { MotionGraph, MotionGraphDef, Pose, SeatTransition, TwoBoneReach, WeightFade, blendPose, headingRoot, solvePose } from 'wallhammer-web/motion';
import type { Socket, SocketSeat } from 'wallhammer-web/motion';
import { FlightAssist, FlyingBody, newFlightAssistInput, newFlyingIntent, releaseToWalker } from 'wallhammer-web/world';
import type { CollisionWorld, FlightAssistInput, FlightAssistSetup, FlyingBodySetup, FlyingIntent, StandSpotOptions, Walker } from 'wallhammer-web/world';
import { FigureActs } from '../../shared/src/figures/acts.ts';
import { GLIDERS } from '../../shared/src/figures/glider.ts';
import type { GliderKind } from '../../shared/src/figures/glider.ts';
import { GliderGait } from '../../shared/src/figures/glider-gait.ts';
import type { GliderState } from '../../shared/src/figures/glider-gait.ts';
import type { FigureInput } from '../../shared/src/figures/kind.ts';
import { MOUNT_S } from '../../shared/src/figures/pathfinder.ts';
import { gaitBands } from '../../shared/src/figures/steed.ts';
import type { PathfinderBody } from './body.ts';
import { APPROACH_S, RIDE_SEAT, SEAT_TILT } from './ride.ts';

/** Farthest the figure's feet may be from the glider's centre to get on, m. */
export const GLIDE_REACH_M = 4.8;
/** The rider's lean forward on the glider, radians: sitting, and more in the air. */
const RIDER_LEAN = 0.18;
const RIDER_AIR_LEAN = 0.14;
/** Where the figure climbs on and gets off: beside the body behind the wing (sideways, back from the centre), m. */
const SIDE_M = 1.7;
const BACK_M = 3.3;
/** Seconds of the crouch before a leap, and of the full beats after it. */
const CROUCH_S = 0.45;
const LAUNCH_S = 1.6;
/** With a flight range, the figure gets off only at a spot this far inside its home area, m. */
const DISMOUNT_MARGIN_M = 1.5;

/**
 * The glider's flying body: a crawl of 2.3 m/s, a leap of 6.5 m/s up and 4 m/s forward; a glide of 9 at 11 m/s,
 * stalling below 7.5 m/s, drag rising fast above the trim speed (`fastDrag`); beats of 0.8 a second when light up to
 * 1.5 at full effort that push 7 m/s² along the path and 3 m/s² up, mostly on the down stroke; banks of up to 0.95
 * rad (54°) for tight turns at speed. The hull: the trunk
 * from the head to the rump with its flanks, and three spheres along each wing (in the air only).
 */
const GLIDER_TRUNK = [
  0, 1.05, -3.1, 0.5, 0, 1.0, -2.0, 0.6, 0, 1.12, -0.9, 0.72, 0, 1.15, 0.3, 0.77, 0, 1.1, 1.3, 0.68, 0, 1.0, 2.1, 0.55,
  0.75, 1.0, -0.8, 0.55, -0.75, 1.0, -0.8, 0.55, 0.7, 1.0, 0.5, 0.5, -0.7, 1.0, 0.5, 0.5,
];
export const GLIDER_BODY: Partial<FlyingBodySetup> = {
  hull: [
    ...GLIDER_TRUNK,
    2.2, 1.2, 0.6, 0.45, -2.2, 1.2, 0.6, 0.45, 4.2, 1.2, 0.9, 0.4, -4.2, 1.2, 0.9, 0.4, 6.4, 1.2, 1.1, 0.3, -6.4, 1.2, 1.1, 0.3,
  ],
  groundHull: GLIDER_TRUNK,
  groundSpeed: 2.3,
  groundBackSpeed: 0.8,
  groundAcceleration: 2,
  groundDeceleration: 3,
  landingDeceleration: 6,
  groundTurnSpeed: 1.1,
  maxStepUp: 0.5,
  maxStepDown: 0.7,
  leapSpeed: 6.5,
  leapForwardSpeed: 4,
  trimSpeed: 11,
  glideRatio: 9,
  minLift: 0.15,
  maxLift: 2.3,
  maxLoad: 2.6,
  stallSpeed: 7.5,
  stallBand: 1.5,
  stallLift: 0.35,
  pathDamping: 0.4,
  maxBank: 0.95,
  bankRate: 1.5,
  noseAngle: 0.22,
  beatRate: 1.5,
  softBeatRate: 0.8,
  beatThrust: 7,
  beatLift: 3,
  beatPulse: 0.7,
  beatEase: 0.35,
  flareDrag: 4,
  flareLift: 0.8,
  fastDrag: 0.5,
  restitution: 0.1,
  scrapeFriction: 0.4,
};

/**
 * The assist the rider flies the glider with: a wanted speed from 8.7 m/s (the stall guard's floor: 1.2 m/s over the
 * stall) through a cruise of 13 m/s to 20 m/s, moved by the throttle at 8 m/s a second; climbs and descents of 3.5 m/s;
 * a descent near the ground easing to 0.8 m/s with the wings levelling, so coming down slowly lands.
 */
export const GLIDER_ASSIST: Partial<FlightAssistSetup> = {
  minSpeed: 8.7,
  maxSpeed: 20,
  cruiseSpeed: 13,
  speedChange: 8,
  speedTime: 0.6,
  maxDeceleration: 8,
  maxBrake: 1,
  climbRate: 3.5,
  descentRate: 3.5,
  climbTime: 0.5,
  maxVerticalAcceleration: 4,
  holdGain: 1,
  stallMargin: 1.2,
  stallDive: 1.5,
  departHeight: 4,
  landingHeight: 5,
  landingSink: 0.8,
};

/**
 * Where the glider flies: it lands and is left only on `home` (minX, minZ, maxX, maxZ); in the air, flown through the
 * assist, solids tagged `fenceTag` (the home's invisible fence) do not stop it; `soft` m beyond `home` the assist
 * starts turning it back toward the middle, fully `band` m farther; outside `home` it keeps at least `floor` m over the
 * ground (a descent stops there), so it comes back to land.
 */
export interface FlightArea {
  home: readonly [number, number, number, number];
  fenceTag: number;
  soft: number;
  band: number;
  floor: number;
}

export type GlideMode = 'off' | 'mounting' | 'on' | 'dismounting';

/**
 * Why the figure cannot get off the glider now: it is in the air, it still moves, or the spots behind both wings are
 * too near the edge of the flight range's home area (`DISMOUNT_MARGIN_M`).
 */
export type GlideOffRefusal = 'air' | 'moving' | 'edge';

/** What `Glide.status` reports. */
export interface GlideStatus {
  mode: GlideMode;
  /** While the figure is on it: why it cannot get off now (null when it can, or when it is not on it). */
  offRefused: GlideOffRefusal | null;
  seat: number;
  holds: [number, number, number, number];
  grounded: boolean;
  /** Weight of the air's pose (0 on the ground, 1 in the air). */
  air: number;
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  pitchDeg: number;
  bankDeg: number;
  /** Flown through the assist (true) or by the raw controls. */
  assisted: boolean;
  /** The assist's wanted speed (m/s) and asked vertical speed (m/s, + up). */
  wantedSpeed: number;
  askedClimb: number;
  /** Speed (m/s), climb (m/s, + up), height above the ground under it (m). */
  speed: number;
  climb: number;
  altitude: number;
  beat: number;
  flare: number;
  load: number;
  stalled: boolean;
  takeOffs: number;
  touchDowns: number;
  /** The step cycle on the ground: phase, footfalls and planted paws per leg (left wing, right wing, hind left, hind right). */
  phase: number;
  downs: [number, number, number, number];
  planted: [number, number, number, number];
  /** The face: how far the mouth is open, the tongue out and the lids shut, each 0–1. */
  face: [number, number, number];
}

const DEG = Math.PI / 180;

export class Glide {
  readonly kind: GliderKind;
  readonly body: FlyingBody;
  /** The engine's flight assist over `body` (`GLIDER_ASSIST`). */
  readonly assist: FlightAssist;
  /** Flown through the assist when an assist input is given (default), or by the raw intent alone. */
  assisted = true;
  /** The flight range (null: anywhere, every solid stops it). */
  area: FlightArea | null = null;
  /** In the last step the assist turned it back toward the home area or kept it off the ground outside. */
  keptIn = false;
  readonly gait: GliderGait;
  readonly rider: PathfinderBody;
  readonly riderWalker: Walker;
  readonly transition = new SeatTransition(RIDE_SEAT);
  readonly acts: FigureActs;
  readonly feet: readonly [TwoBoneReach, TwoBoneReach];
  readonly graph: MotionGraph<FigureInput>;
  readonly poseWeight = new WeightFade(0);
  /** The side the figure got off at last: 1 left, −1 right. */
  side = 1;
  /** The body's drawn state of the last `update`. */
  readonly drawn: GliderState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0, vx: 0, vy: 0, vz: 0, grounded: true, beatPhase: 0, beatEffort: 0, flare: 0, altitude: 0, crouch: 0, sinceLift: 1e9, sinceTouch: 1e9, impact: 0 };
  /** Seconds into the crouch before a leap (−1: none). */
  private crouching = -1;
  /** The body's step at the last take-off and touch-down (−1: none), and how many it had seen. */
  private liftStep = -1;
  private touchStep = -1;
  private takeOffsSeen = 0;
  private touchDownsSeen = 0;
  private impact = 0;
  private readonly world: CollisionWorld;
  private readonly riderPose: Pose;
  /** The rider's torso bone (−1: the kind has none), leant forward on the glider. */
  private readonly torso: number;
  private readonly seatSocket: Socket;
  private readonly gripL: Socket;
  private readonly gripR: Socket;
  private readonly stirrupL: Socket;
  private readonly stirrupR: Socket;
  private readonly free = new Float64Array(12);
  private readonly at = new Float64Array(3);
  private readonly to = new Float64Array(4);
  private readonly place = new Float64Array(4);
  private readonly spots = new Float64Array(8);
  private readonly stand: StandSpotOptions;
  private readonly steer: FlyingIntent = newFlyingIntent();
  /** The assist's input of the current `step` or `advance` (null: the raw intent). */
  private assistIn: FlightAssistInput | null = null;
  /** The assist's input as the flight range changes it. */
  private readonly areaIn: FlightAssistInput = newFlightAssistInput();
  private clock = 0;
  private stepped = false;

  /** `ceilingY`: the height at which its lift has faded out (world y; the flying body's `ceilingY`). */
  constructor(world: CollisionWorld, rider: PathfinderBody, riderWalker: Walker, x: number, z: number, yaw: number, ceilingY = Infinity, kind: GliderKind = GLIDERS.glider()) {
    this.world = world;
    this.kind = kind;
    this.body = new FlyingBody(world, { ...GLIDER_BODY, ceilingY });
    this.assist = new FlightAssist(this.body, GLIDER_ASSIST);
    const heightAt = (hx: number, hz: number): number => this.world.groundAt(hx, hz, this.body.position[1]! + 0.6, 0);
    this.gait = new GliderGait(kind, heightAt);
    this.rider = rider;
    this.riderWalker = riderWalker;
    const rs = riderWalker.setup;
    this.stand = { radius: rs.radius, height: rs.height, maxStepUp: rs.maxStepUp };
    const rk = rider.kind;
    this.acts = new FigureActs(rk);
    for (const a of [this.acts.left!, this.acts.right!]) (a.useEndRotation = true), (a.soft = 0.995);
    const legs = rk.legs!.chains;
    this.feet = [new TwoBoneReach(legs[0]!, { soft: 0.995 }), new TwoBoneReach(legs[1]!, { soft: 0.995 })];
    for (const f of this.feet) (f.usePole = true), (f.useEndRotation = true);
    const m = rk.motions;
    const band = gaitBands(kind.steps.speeds);
    this.graph = new MotionGraph(
      new MotionGraphDef<FigureInput>({
        skeleton: rk.skeleton,
        params: { speed: 0, passes: 0 },
        triggers: ['mount', 'dismount'],
        layers: [
          {
            name: 'ride',
            states: [
              { name: 'off' },
              { name: 'mount', source: m.mount! },
              { name: 'seat', sources: [{ ...m.saddle!, speed: band.still }, { ...m.saddleWalk!, speed: band.walk }, { ...m.saddleTrot!, speed: band.trot }], by: 'speed', drive: { param: 'passes', per: 1 } },
              { name: 'dismount', source: m.dismount! },
            ],
            transitions: [
              { from: '*', to: 'mount', seconds: 0.15, trigger: 'mount' },
              { from: 'mount', to: 'seat', seconds: 0.3, after: 1 },
              { from: '*', to: 'dismount', seconds: 0.25, trigger: 'dismount' },
            ],
          },
        ],
      }),
      { seed: 0.53, param: 0 },
    );
    this.riderPose = new Pose(rk.skeleton);
    this.torso = rk.skeleton.names.indexOf('torso');
    const s = kind.sockets!;
    const k = rider.scale;
    const seat = s.seat!;
    this.seatSocket = { bone: seat.bone, local: Array.from(seat.local, (v, i) => (i < 9 ? v * k : v)) };
    this.gripL = s.gripL!;
    this.gripR = s.gripR!;
    this.stirrupL = s.stirrupL!;
    this.stirrupR = s.stirrupR!;
    this.put(x, z, yaw);
  }

  /** Puts the glider standing at (x, z) with the heading `yaw`; a rider stays on. */
  put(x: number, z: number, yaw: number): void {
    const y = this.world.groundAt(x, z, 1e4, 0);
    this.body.teleport(x, y, z, yaw);
    this.forget();
    this.assist.reset();
    this.read(1);
    this.gait.reset(this.drawn);
    this.clock = this.time(1);
    this.stepped = false;
  }

  /** Puts the glider in the air at (x, y, z), heading `yaw`, at `speed` m/s level (for a script's fixed scenes). */
  launch(x: number, y: number, z: number, yaw: number, speed: number): void {
    const b = this.body;
    b.teleport(x, y, z, yaw);
    this.forget();
    b.velocity[0] = -Math.sin(yaw) * speed;
    b.velocity[2] = -Math.cos(yaw) * speed;
    this.assist.reset(speed);
    this.read(1);
    this.gait.reset(this.drawn);
    this.clock = this.time(1);
    this.stepped = false;
  }

  /** Forgets the crouch and the last take-off and touch-down (after a teleport). */
  private forget(): void {
    const b = this.body;
    this.crouching = -1;
    this.liftStep = this.touchStep = -1;
    this.takeOffsSeen = b.takeOffs;
    this.touchDownsSeen = b.touchDowns;
    this.impact = 0;
  }

  private time(a: number): number {
    return (this.body.steps - 1 + a) * this.body.stepSeconds;
  }

  get seat(): SocketSeat {
    return this.transition.seat;
  }

  get mode(): GlideMode {
    const p = this.transition.phase;
    return p === 'free' ? 'off' : p === 'held' ? 'on' : p === 'release' ? 'dismounting' : 'mounting';
  }

  get riding(): boolean {
    return this.mode !== 'off';
  }

  /** Whether the figure's feet are near enough to get on (the glider on the ground). */
  near(): boolean {
    const p = this.riderWalker.position, q = this.body.position;
    return this.mode === 'off' && this.body.grounded && Math.hypot(p[0]! - q[0]!, p[2]! - q[2]!) <= GLIDE_REACH_M && Math.abs(p[1]! - q[1]!) < 0.6;
  }

  toggle(instant = false): boolean {
    if (this.mode === 'off') return this.mount(instant);
    if (this.mode === 'on') return this.dismount(instant);
    return false;
  }

  mount(instant = false): boolean {
    if (this.mode !== 'off' || (!instant && !this.near())) return false;
    const p = this.riderWalker.position;
    this.transition.attach(p[0]!, p[1]!, p[2]!, this.riderWalker.yaw, APPROACH_S);
    this.graph.setParam('speed', 0);
    if (instant) {
      this.transition.attachNow();
      this.graph.reset();
      this.graph.trigger('mount');
      this.graph.update(MOUNT_S + 1);
      this.poseWeight.set(1);
      for (const r of [this.acts.left!, this.acts.right!, ...this.feet]) r.fade.set(1);
      this.acts.gaze?.fade.set(1);
    }
    return true;
  }

  /** Gets off (on the ground, nearly stopped) behind the left wing, or the right when the left is blocked. */
  dismount(instant = false): boolean {
    if (this.mode !== 'on' || (!instant && !this.canDismount())) return false;
    this.side = this.freeSide();
    for (const r of [this.acts.left!, this.acts.right!, ...this.feet]) r.off(0.25);
    this.acts.gaze?.off(0.4);
    this.graph.trigger('dismount');
    this.offSpot(this.to, this.side);
    releaseToWalker(this.transition, this.riderWalker, this.to[0]!, this.to[1]!, this.to[2]!, this.to[3]!);
    if (instant) this.finishDismount();
    return true;
  }

  /** On the ground and crawling slower than 0.8 m/s (and with a flight range, a spot to get off at in its home area). */
  canDismount(): boolean {
    return this.offRefusal() === null;
  }

  /** Why getting off is refused now (`GlideOffRefusal`), or null when the figure can get off. */
  offRefusal(): GlideOffRefusal | null {
    if (!this.body.grounded) return 'air';
    const v = this.body.velocity;
    if (Math.hypot(v[0]!, v[2]!) >= 0.8) return 'moving';
    return this.spotHome(1) || this.spotHome(-1) ? null : 'edge';
  }

  /** Whether the spot to get off at on side `s` is in the flight range's home area (always without a range). */
  private spotHome(s: number): boolean {
    const h = this.area?.home;
    if (!h) return true;
    this.offSpot(this.to, s);
    const x = this.to[0]!, z = this.to[2]!, m = DISMOUNT_MARGIN_M;
    return x > h[0] + m && x < h[2] - m && z > h[1] + m && z < h[3] - m;
  }

  /** The spot behind the wing on side `s` (x, ground y, z, the glider's heading). */
  private offSpot(out: Float64Array, s: number): void {
    const p = this.body.position, yaw = this.body.yaw;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    // Left (−cos, sin), back (sin, cos).
    const x = p[0]! - c * s * SIDE_M + sn * BACK_M, z = p[2]! + sn * s * SIDE_M + c * BACK_M;
    out[0] = x;
    out[1] = this.world.groundAt(x, z, p[1]! + 0.4, 0.4);
    out[2] = z;
    out[3] = yaw;
  }

  private freeSide(): number {
    const p = this.body.position, sp = this.spots;
    for (let k = 0; k < 2; k++) {
      this.offSpot(this.to, k === 0 ? 1 : -1);
      sp[k * 4] = p[0]!;
      sp[k * 4 + 1] = p[2]!;
      sp[k * 4 + 2] = this.to[0]!;
      sp[k * 4 + 3] = this.to[2]!;
    }
    const s = this.world.firstStandSpot(sp, p[1]!, this.stand) === 1 ? -1 : 1;
    return this.spotHome(s) ? s : -s;
  }

  private finishDismount(): void {
    this.offSpot(this.to, this.side);
    this.riderWalker.teleport(this.to[0]!, this.to[1]!, this.to[2]!, this.to[3]!);
    this.transition.releaseNow();
    this.poseWeight.to(0, 0.3);
    for (const r of [this.acts.left!, this.acts.right!, ...this.feet]) r.fade.set(0);
  }

  /** The intent of a step: the rider's while it sits on, idle otherwise. */
  /**
   * The intent of `dt` seconds: the rider's while it sits on, idle otherwise. A take-off asked for on the ground is
   * held back for the crouch (`CROUCH_S`) and then sent once; for `LAUNCH_S` after the paws leave the ground the
   * wings beat in full.
   */
  private intentOf(intent: FlyingIntent | null, dt: number): FlyingIntent {
    const s = this.steer, b = this.body;
    const on = this.mode === 'on' && intent !== null;
    s.forward = on ? intent.forward : 0;
    s.turn = on ? intent.turn : 0;
    s.pitch = on ? intent.pitch : 0;
    s.beat = on ? intent.beat : 0;
    s.brake = on ? intent.brake : 0;
    s.takeOff = false;
    if (on && intent.takeOff && b.grounded && this.crouching < 0) this.crouching = 0;
    if (this.crouching >= 0) {
      if (!on || !b.grounded) this.crouching = -1;
      else {
        this.crouching += dt;
        if (this.crouching >= CROUCH_S) (s.takeOff = true), (this.crouching = -1);
      }
    }
    if (on && !b.grounded && this.sinceLift < LAUNCH_S) s.beat = 1;
    return s;
  }

  /**
   * Before every fixed step: with an assist input (and `assisted`), the assist writes the step's pitch, beats, flare
   * and turn (on the ground the turn only; the crawl and the leap stay the rider's); the launch's full beats stay.
   */
  private readonly prepareStep = (it: FlyingIntent): void => {
    const b = this.body, area = this.area;
    const flown = this.assistIn !== null && this.assisted && this.mode === 'on';
    // In the air, flown through the assist, the home's fence does not stop it.
    b.setup.skipTag = area && flown && !b.grounded ? area.fenceTag : Number.NaN;
    this.keptIn = false;
    if (!flown) return;
    const input = area && !b.grounded ? this.keepInArea(this.assistIn!, area) : this.assistIn!;
    const forward = it.forward;
    this.assist.steer(input, it);
    it.forward = forward;
    if (!this.body.grounded && this.sinceLift < LAUNCH_S) it.beat = 1;
  };

  /**
   * The assist's input in the flight range: beyond `soft` the turn blends toward the way home (all of it `band`
   * farther); outside `home` no descent under `floor` m over the ground, and a climb back to it.
   */
  private keepInArea(input: FlightAssistInput, area: FlightArea): FlightAssistInput {
    const o = this.areaIn, b = this.body, p = b.position, v = b.velocity, h = area.home;
    o.throttle = input.throttle;
    o.climb = input.climb;
    o.turn = input.turn;
    const out = Math.max(h[0] - p[0]!, p[0]! - h[2], h[1] - p[2]!, p[2]! - h[3], 0);
    if (out > area.soft) {
      const t = Math.min(1, (out - area.soft) / area.band);
      const k = t * t * (3 - 2 * t);
      const sp = Math.hypot(v[0]!, v[2]!);
      let tx = (h[0] + h[2]) / 2 - p[0]!, tz = (h[1] + h[3]) / 2 - p[2]!;
      const tl = Math.hypot(tx, tz);
      if (sp > 0.5 && tl > 1e-6) {
        tx /= tl;
        tz /= tl;
        const fx = v[0]! / sp, fz = v[2]! / sp;
        // Right of the path is (−fz, fx); home ahead within a cone, the turn eases off as the path points at it.
        const side = tx * -fz + tz * fx, ahead = tx * fx + tz * fz;
        const home = ahead > 0.3 ? Math.max(-1, Math.min(1, 3 * side)) : side >= 0 ? 1 : -1;
        o.turn = input.turn + (home - input.turn) * k;
        this.keptIn = k > 0.05;
      }
    }
    if (out > 0) {
      // Above `floor` + 5.5 m as asked; nearer, the descent fades out 1.5 m over the floor (the vertical loop
      // overshoots by about a metre), and below that it climbs back.
      const room = (b.altitude - area.floor - 1.5) / 4;
      if (-room > o.climb) {
        o.climb = Math.min(1, -room);
        this.keptIn = true;
      }
    }
    return o;
  }

  /** Whether the glider is flown through the assist now (`assisted`, ridden). */
  get flownByAssist(): boolean {
    return this.assisted && this.mode === 'on';
  }

  /**
   * One fixed step of the flying body. `input`: the rider's meaning for the assist (speed, climb, turn); null, or
   * `assisted` false, flies by `intent` alone.
   */
  step(intent: FlyingIntent | null, input: FlightAssistInput | null = null): void {
    const it = this.intentOf(intent, this.body.stepSeconds);
    this.assistIn = intent ? input : null;
    this.prepareStep(it);
    this.body.step(it);
    this.assistIn = null;
    this.noteLanding();
  }

  /** Advances the flying body by `dt` seconds of frames. A `takeOff` of `intent` is used once. `input` as for `step`. */
  advance(dt: number, intent: FlyingIntent | null, input: FlightAssistInput | null = null): void {
    const it = this.intentOf(intent, dt);
    this.assistIn = intent ? input : null;
    this.body.advance(dt, it, this.prepareStep);
    this.assistIn = null;
    if (intent) intent.takeOff = false;
    this.noteLanding();
  }

  /** Notes the step of the last take-off and touch-down. */
  private noteLanding(): void {
    const b = this.body;
    if (b.takeOffs !== this.takeOffsSeen) (this.takeOffsSeen = b.takeOffs), (this.liftStep = b.steps);
    if (b.touchDowns !== this.touchDownsSeen) (this.touchDownsSeen = b.touchDowns), (this.touchStep = b.steps), (this.impact = b.touchDownSpeed);
  }

  /** Seconds since the last take-off (large: none). */
  get sinceLift(): number {
    return this.liftStep < 0 ? 1e9 : (this.body.steps - this.liftStep) * this.body.stepSeconds;
  }

  /** The crouch before a leap, 0–1. */
  get crouch(): number {
    return this.crouching < 0 ? 0 : Math.min(1, this.crouching / CROUCH_S);
  }

  /** The body's drawn state at `a` of the way between its last two steps. */
  private read(a: number): void {
    const b = this.body, d = this.drawn;
    b.renderPosition(this.at, a);
    d.x = this.at[0]!;
    d.y = this.at[1]!;
    d.z = this.at[2]!;
    d.yaw = b.renderYaw(a);
    d.pitch = b.renderPitch(a);
    d.bank = b.renderBank(a);
    d.vx = b.velocity[0]!;
    d.vy = b.velocity[1]!;
    d.vz = b.velocity[2]!;
    d.grounded = b.grounded;
    d.beatPhase = b.renderBeatPhase(a);
    d.beatEffort = b.beatEffort;
    d.flare = b.flare;
    d.altitude = b.altitude;
    d.crouch = this.crouch;
    const at = (step: number): number => (step < 0 ? 1e9 : (b.steps - 1 + a - step) * b.stepSeconds);
    d.sinceLift = at(this.liftStep);
    d.sinceTouch = at(this.touchStep);
    d.impact = this.impact;
  }

  /** Brings the glider and the rider's timeline to `a` of the body's last step. Call once a frame before `pose`. */
  update(a: number): void {
    const t = this.time(a);
    let dt = t - this.clock;
    this.clock = t;
    if (dt < 0 || dt > 1) dt = 0;
    this.read(a);
    if (!this.stepped) {
      this.gait.reset(this.drawn);
      this.stepped = true;
    }
    this.gait.update(dt, this.drawn);
    // In the air the rider takes the whole tilt of the seat.
    this.seat.tilt = SEAT_TILT + (1 - SEAT_TILT) * this.gait.air;
    if (!(dt > 0)) return;
    const tr = this.transition;
    tr.advance(dt);
    this.acts.update(dt);
    for (const f of this.feet) f.update(dt);
    this.poseWeight.update(dt);
    const g = this.gait.ground;
    this.graph.setParam('speed', this.body.grounded ? g.speed : 0);
    this.graph.setParam('passes', g.passes);
    this.graph.update(dt);
    const A = tr.approachSeconds;
    if (tr.gettingOn) {
      if (tr.crossed(A)) {
        this.graph.trigger('mount');
        this.poseWeight.to(1, 0.2);
      }
      if (tr.passed(A + 0.2 * MOUNT_S)) {
        this.acts.left!.on(0.3);
        this.acts.right!.on(0.3);
      }
      if (tr.passed(A + 0.3 * MOUNT_S)) this.feet[0].on(0.3);
      if (tr.passed(A + 0.72 * MOUNT_S)) this.feet[1].on(0.3);
      if (tr.passed(A + 0.5 * MOUNT_S)) this.acts.gaze?.on(0.5);
    } else if (tr.became('free')) this.finishDismount();
    const moved = tr.gettingOn ? tr.approachMoved(this.approachLength()) : 0;
    if (this.mode !== 'off') this.rider.update(dt, moved, true, 0);
  }

  private approachLength(): number {
    this.mountSpot(this.to);
    const f = this.transition.from;
    return Math.hypot(this.to[0]! - f[0]!, this.to[2]! - f[2]!);
  }

  /** Where the figure stands to climb on: behind the left wing, facing along the glider. */
  private mountSpot(out: Float64Array): void {
    const r = this.gait.root;
    out[0] = r[9]! + r[0]! * SIDE_M - r[6]! * BACK_M;
    out[2] = r[11]! + r[2]! * SIDE_M - r[8]! * BACK_M;
    out[1] = this.world.groundAt(out[0], out[2], r[10]! + 0.4, 0.4);
    out[3] = this.drawn.yaw;
  }

  /** The glider's bones for the frame (after `update`). */
  pose(): Float64Array {
    return this.gait.solve();
  }

  /** Turns the head toward a point when the figure is near and not riding; lets it go otherwise. */
  watch(x: number, y: number, z: number): void {
    const p = this.gait.root;
    const near = this.mode === 'off' && this.body.grounded && Math.hypot(x - p[9]!, z - p[11]!) < 7 && this.gait.ground.speed < 0.2;
    this.gait.ground.look(near ? [x, y, z] : null, 0.8);
  }

  get posesRider(): boolean {
    return this.mode !== 'off' || this.poseWeight.value > 0 || this.seat.weight > 0;
  }

  /** The rider's bones for the frame, after `pose`: `g*` is the figure's own drawn place and heading. */
  poseRider(gx: number, gy: number, gz: number, gyaw: number): Float64Array {
    const body = this.rider;
    const g = body.gait;
    const sk = body.kind.skeleton;
    const mount = this.gait.world;
    const k = body.scale;
    const tr = this.transition;
    const seatY = mount[this.kind.steps.trunk * 12 + 10]! + this.seatSocket.local[10]!;
    const at = this.to;
    const phase = tr.phase;
    if (phase === 'approach' || phase === 'attach') this.mountSpot(at);
    else if (phase === 'held' || phase === 'release') this.offSpot(at, this.side);
    else (at[0] = gx), (at[1] = gy), (at[2] = gz), (at[3] = gyaw);
    const pl = tr.place(at, seatY, this.place);
    headingRoot(pl[0]!, pl[1]!, pl[2]!, pl[3]!, k, this.free);
    const root = body.root;
    g.graph.evaluate(g.pose);
    this.graph.evaluate(this.riderPose);
    blendPose(g.pose, g.pose, this.riderPose, this.poseWeight.value);
    this.lean(g.pose, this.poseWeight.value * (RIDER_LEAN + RIDER_AIR_LEAN * this.gait.air));
    tr.write(this.free, mount, this.seatSocket, root);
    solvePose(sk, g.pose, root, g.world);
    const gz2 = this.acts.gaze;
    if (gz2 && gz2.weight > 0) {
      // Ahead along the glider, toward where it turns and where it climbs.
      const r = this.gait.root;
      const ahead = 10, bend = Math.max(-0.7, Math.min(0.7, -this.drawn.bank * 0.8 + this.gait.ground.turn * 0.6 * (1 - this.gait.air)));
      const cb = Math.cos(bend), sb = Math.sin(bend);
      const fx = r[6]! * cb + r[0]! * sb, fy = r[7]!, fz = r[8]! * cb + r[2]! * sb;
      gz2.setTarget(root[9]! + fx * ahead, root[10]! + 1.0 + fy * ahead, root[11]! + fz * ahead);
    }
    this.acts.aim(g, root);
    this.acts.left!.setTargetSocket(mount, this.gripL);
    this.acts.right!.setTargetSocket(mount, this.gripR);
    this.acts.reach(g, root);
    this.feet[0].setTargetSocket(mount, this.stirrupL);
    this.feet[1].setTargetSocket(mount, this.stirrupR);
    for (let i = 0; i < 2; i++) {
      const r = this.feet[i]!;
      if (r.weight <= 0) continue;
      const px = i === 0 ? 0.5 : -0.5, py = 0.1, pz = 1.2;
      for (let j = 0; j < 3; j++) r.pole[j] = root[j]! * px + root[3 + j]! * py + root[6 + j]! * pz + root[9 + j]!;
      r.apply(sk, g.pose, root, g.world);
    }
    body.tailAngle = g.applyLag(root);
    return g.world;
  }

  /** Tips the rider's torso forward by `angle` radians (on top of its pose: a turn about its own x). */
  private lean(pose: Pose, angle: number): void {
    if (angle === 0 || this.torso < 0) return;
    const r = pose.rot, o = this.torso * 4;
    const h = angle / 2, sx = Math.sin(h), cw = Math.cos(h);
    const x = r[o]!, y = r[o + 1]!, z = r[o + 2]!, w = r[o + 3]!;
    // q · (sin h, 0, 0, cos h)
    r[o] = w * sx + x * cw;
    r[o + 1] = y * cw + z * sx;
    r[o + 2] = z * cw - y * sx;
    r[o + 3] = w * cw - x * sx;
  }

  status(): GlideStatus {
    const b = this.body, c = this.gait.ground.cycle;
    const p = b.position, v = b.velocity;
    const four = (a: ArrayLike<number>): [number, number, number, number] => [a[0]!, a[1]!, a[2]!, a[3]!];
    return {
      mode: this.mode,
      offRefused: this.mode === 'on' ? this.offRefusal() : null,
      seat: this.seat.weight,
      holds: [this.acts.left!.weight, this.acts.right!.weight, this.feet[0].weight, this.feet[1].weight],
      grounded: b.grounded,
      air: this.gait.air,
      assisted: this.assisted,
      wantedSpeed: this.assist.wantedSpeed,
      askedClimb: this.assist.askedClimb,
      x: p[0]!,
      y: p[1]!,
      z: p[2]!,
      yawDeg: b.yaw / DEG,
      pitchDeg: b.pitch / DEG,
      bankDeg: b.bank / DEG,
      speed: b.speed,
      climb: v[1]!,
      altitude: b.altitude,
      beat: b.beatEffort,
      flare: b.flare,
      load: b.load,
      stalled: b.stalled,
      takeOffs: b.takeOffs,
      touchDowns: b.touchDowns,
      phase: c.phase,
      downs: four(c.downs),
      planted: four(c.planted),
      face: [this.gait.face.open, this.gait.face.tongue, this.gait.face.lids],
    };
  }
}
