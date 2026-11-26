// Riding: the pathfinder gets on the steed (examples/shared steed.ts), rides it over the course and gets off. Pure
// logic shared by the page (main.ts) and the headless check (tools/walk/ride-scenarios.ts): no DOM, no graphics.
//
// Two walkers. The steed is a second `Walker` of its own setup (a wider body, its own speeds, a slow run-up and
// braking, a turn rate that falls with speed, so it rides in arcs; no jump); its legs are stepped by `QuadGait`
// (the engine's `StepCycle`, a `TwoBoneReach` per leg). While the figure rides, its own walker is parked and the input
// steers the steed; on the way off the figure's walker is put beside the steed.
//
// The rider's pose in a frame (after the steed's): its gait's pose (standing) blended with the riding graph (`mount`,
// then the seat motions by the steed's speed on the steed's step phase, `dismount`) by an eased weight; its root from
// a `SocketSeat` on the steed's `seat` socket (a share `SEAT_TILT` of the saddle's tilt; the free root a path from the
// ground beside the steed that rises before it crosses, so the figure does not pass through the trunk); then the
// gaze (toward where the steed turns), the hands on the grips and the feet in the stirrups (`TwoBoneReach` with
// `setTargetSocket` and the sockets' turn), and the ponytail lagging behind (its motion frame the world).
//
// Getting on and off (`toggle` within `RIDE_REACH_M`) is the engine's `SeatTransition` (`RIDE_SEAT`: its numbers are
// this file's): the figure steps to the steed's left side (`APPROACH_S`), climbs on over `MOUNT_S` (the seat weight
// eases in), the hands and then the feet take hold (cues at times of the timeline). Getting off: the hands and feet
// let go, the figure climbs down over `DISMOUNT_S` to the left side, or to the right when the left is blocked (a solid
// or a drop: the collision world's `firstStandSpot`), and its walker is put there at once (`releaseToWalker`).
//
// Time is the steed's walker's: the same steps give the same poses.

import { MotionGraph, MotionGraphDef, Pose, SeatTransition, TwoBoneReach, WeightFade, blendPose, headingRoot, solvePose, speedWeights } from 'wallhammer-web/motion';
import type { SeatTransitionOptions, Socket, SocketSeat } from 'wallhammer-web/motion';
import { Walker, newWalkIntent, releaseToWalker } from 'wallhammer-web/world';
import type { CollisionWorld, StandSpotOptions, WalkIntent, WalkerSetup } from 'wallhammer-web/world';
import { FigureActs } from '../../shared/src/figures/acts.ts';
import type { FigureInput } from '../../shared/src/figures/kind.ts';
import { DISMOUNT_S, MOUNT_S } from '../../shared/src/figures/pathfinder.ts';
import { QuadGait } from '../../shared/src/figures/quad-gait.ts';
import { STEEDS, gaitBands } from '../../shared/src/figures/steed.ts';
import type { SteedKind, SteedSpeeds } from '../../shared/src/figures/steed.ts';
import type { PathfinderBody } from './body.ts';

/** Farthest the figure's feet may be from the steed's centre to get on, m. */
export const RIDE_REACH_M = 3.2;
/** Seconds the figure takes to step to the steed's side before it climbs. */
export const APPROACH_S = 0.45;
/** Share of the saddle's tilt the rider's root takes: upright on slopes, but with the trunk's rock at a gallop. */
export const SEAT_TILT = 0.45;
/** Distance of the place the figure climbs on from (beside the left stirrup) from the steed's centre, sideways, m. */
const MOUNT_SIDE_M = 0.85;
/** Distance of the place the figure gets off at from the steed's centre, sideways, m. */
const SIDE_M = 1.25;

/**
 * The timeline of getting on and off: on, the seat weight eases in over most of the climb while the free root rises
 * 0.85 of the way to the seat in its first 0.45 (up first, across after), held 0.15 s after the climb; off, after
 * 0.12 s the weight eases out over most of the climb down while the free root stays raised and drops from 0.35 to 0.9
 * of it (across first, down after).
 */
export const RIDE_SEAT: SeatTransitionOptions = {
  tilt: SEAT_TILT,
  attach: { seconds: MOUNT_S + 0.15, weightSeconds: 0.78 * MOUNT_S, rise: 0.85, riseTo: 0.45 * MOUNT_S },
  release: { seconds: DISMOUNT_S + 0.12, weightFrom: 0.12, weightSeconds: 0.85 * DISMOUNT_S, rise: 0.85, riseFrom: 0.35 * DISMOUNT_S, riseTo: 0.9 * DISMOUNT_S },
};

/** The walker of a steed of the speeds `s` (its walk, its gallop as the run). */
export function steedWalker(s: Readonly<SteedSpeeds>): Partial<WalkerSetup> {
  return { ...STEED_WALKER, walkSpeed: s.walk, runSpeed: s.gallop };
}

/** The steed's walker, without its speeds (`steedWalker` adds them from the kind). */
export const STEED_WALKER: Partial<WalkerSetup> = {
  radius: 0.75,
  height: 3.1,
  acceleration: 2.6,
  runAcceleration: 2.8,
  deceleration: 4.5,
  turnSpeed: 1.4,
  turnSpeedAtRun: 0.5,
  jumpSpeed: 0,
  maxStepUp: 0.35,
  maxSlopeDeg: 38,
  // Four legs lose less uphill than two; steep descents are taken carefully.
  uphillSpeedLoss: 0.5,
  downhillSpeedGain: 0.3,
  downhillSpeedLoss: 1.2,
  slopeSpeedFloor: 0.4,
};

export type RideMode = 'off' | 'mounting' | 'on' | 'dismounting';

/** What `Ride.status` reports. */
export interface RideStatus {
  mode: RideMode;
  /** Seat weight 0–1 (0 standing on the ground, 1 in the saddle). */
  seat: number;
  /** The rider's hands and feet on their holds, 0–1 each: left hand, right hand, left foot, right foot. */
  holds: [number, number, number, number];
  trot: boolean;
  /** The steed's place and heading (degrees; 0 faces −z). */
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  speed: number;
  /** The step cycle: phase 0–1, passes a second, the patterns' weights (walk, trot, gallop) at the speed now. */
  phase: number;
  rate: number;
  patterns: [number, number, number];
  /** Footfalls per leg since the steed was put down: front left, front right, hind left, hind right. */
  downs: [number, number, number, number];
  /** Per leg 1 when the hoof stands. */
  planted: [number, number, number, number];
  /** The trunk's extra dip for a far hoof, m. */
  dip: number;
  /** The steed's own clock (s since it was put down) and its effort 0–1, which drive its face and its breath. */
  time: number;
  effort: number;
}

const DEG = Math.PI / 180;

export class Ride {
  readonly kind: SteedKind;
  readonly walker: Walker;
  readonly gait: QuadGait;
  readonly rider: PathfinderBody;
  readonly riderWalker: Walker;
  /** Getting on, riding and getting off. */
  readonly transition = new SeatTransition(RIDE_SEAT);
  /** The rider's gaze and hands. */
  readonly acts: FigureActs;
  readonly feet: readonly [TwoBoneReach, TwoBoneReach];
  readonly graph: MotionGraph<FigureInput>;
  /** Weight of the riding graph over the rider's own gait. */
  readonly poseWeight = new WeightFade(0);
  trot = false;
  /** The side the figure got off at last: 1 left, −1 right. */
  side = 1;
  private readonly world: CollisionWorld;
  private readonly riderPose: Pose;
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
  private clock = 0;
  private readonly steer: WalkIntent = newWalkIntent();
  private readonly heightAt: (x: number, z: number) => number;
  private stepped = false;

  /** The steed's speeds of walk, trot and gallop (its kind's). */
  readonly speeds: Readonly<SteedSpeeds>;
  private readonly patternSpeeds: [number, number, number][];
  private readonly weights: { [i: number]: number } = {};

  /** `kind`: the mount (default the steed); its `steps` give its legs, patterns and speeds. */
  constructor(world: CollisionWorld, rider: PathfinderBody, riderWalker: Walker, x: number, z: number, yaw: number, kind: SteedKind = STEEDS.steed()) {
    this.world = world;
    this.kind = kind;
    this.speeds = kind.steps.speeds;
    this.patternSpeeds = kind.steps.patterns.map((p): [number, number, number] => [p.speed, p.speed, p.speed]);
    this.walker = new Walker(world, steedWalker(this.speeds));
    this.gait = new QuadGait(this.kind, { seed: 0.61 });
    this.rider = rider;
    this.riderWalker = riderWalker;
    const rs = riderWalker.setup;
    this.stand = { radius: rs.radius, height: rs.height, maxStepUp: rs.maxStepUp };
    const rk = rider.kind;
    this.acts = new FigureActs(rk);
    // The grips are near the arms' full length: pulled in late, so the hands close on them.
    for (const a of [this.acts.left!, this.acts.right!]) (a.useEndRotation = true), (a.soft = 0.995);
    const legs = rk.legs!.chains;
    this.feet = [new TwoBoneReach(legs[0]!, { soft: 0.995 }), new TwoBoneReach(legs[1]!, { soft: 0.995 })];
    for (const f of this.feet) (f.usePole = true), (f.useEndRotation = true);
    const m = rk.motions;
    // The seat motions in the bands of the mount's speeds.
    const band = gaitBands(this.speeds);
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
              { name: 'seat', sources: [{ ...m.saddle!, speed: band.still }, { ...m.saddleWalk!, speed: band.walk }, { ...m.saddleTrot!, speed: band.trot }, { ...m.saddleGallop!, speed: band.gallop }], by: 'speed', drive: { param: 'passes', per: 1 } },
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
      { seed: 0.37, param: 0 },
    );
    this.riderPose = new Pose(rk.skeleton);
    // The rider's sockets on the steed, the seat at the rider's size (its root is scaled).
    const s = this.kind.sockets!;
    const k = rider.scale;
    const seat = s.seat!;
    this.seatSocket = { bone: seat.bone, local: Array.from(seat.local, (v, i) => (i < 9 ? v * k : v)) };
    this.gripL = s.gripL!;
    this.gripR = s.gripR!;
    this.stirrupL = s.stirrupL!;
    this.stirrupR = s.stirrupR!;
    this.heightAt = (hx, hz) => this.world.groundAt(hx, hz, this.walker.position[1]! + 0.6, 0);
    this.put(x, z, yaw);
  }

  /** Puts the steed standing at (x, z) with the heading `yaw`; a rider stays on. */
  put(x: number, z: number, yaw: number): void {
    const y = this.world.groundAt(x, z, 1e4, 0);
    this.walker.teleport(x, y, z, yaw);
    this.gait.reset(x, y, z, yaw, this.heightAt);
    this.clock = this.time(1);
    this.stepped = false;
  }

  /** The steed walker's time at `a` of the way between its last two steps. */
  private time(a: number): number {
    return (this.walker.steps - 1 + a) * this.walker.stepSeconds;
  }

  /** The seat on the steed's `seat` socket (its weight is the timeline's). */
  get seat(): SocketSeat {
    return this.transition.seat;
  }

  /** Where the ride is: off, getting on (the step to the side included), on, getting off. */
  get mode(): RideMode {
    const p = this.transition.phase;
    return p === 'free' ? 'off' : p === 'held' ? 'on' : p === 'release' ? 'dismounting' : 'mounting';
  }

  /** True while the figure is on the steed or getting on or off. */
  get riding(): boolean {
    return this.mode !== 'off';
  }

  /** Whether the figure's feet are near enough to get on. */
  near(): boolean {
    const p = this.riderWalker.position, q = this.walker.position;
    return this.mode === 'off' && Math.hypot(p[0]! - q[0]!, p[2]! - q[2]!) <= RIDE_REACH_M && Math.abs(p[1]! - q[1]!) < 0.6;
  }

  /** Walk or trot as the steed's slower gait (Shift gallops). */
  setTrot(on: boolean): void {
    this.trot = on;
    this.walker.retune({ walkSpeed: on ? this.speeds.trot : this.speeds.walk });
  }

  /**
   * Gets on (when near) or off (when riding). `instant`: at once, without the climb (for a script's fixed scenes).
   * Returns whether anything changed.
   */
  toggle(instant = false): boolean {
    if (this.mode === 'off') return this.mount(instant);
    if (this.mode === 'on') return this.dismount(instant);
    return false;
  }

  /** Gets on. Without `instant` the figure must be near (`near`). */
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

  /** Gets off to the left side, or the right when the left is blocked. */
  dismount(instant = false): boolean {
    if (this.mode !== 'on') return false;
    this.side = this.freeSide();
    for (const r of [this.acts.left!, this.acts.right!, ...this.feet]) r.off(0.25);
    this.acts.gaze?.off(0.4);
    this.graph.trigger('dismount');
    // The figure's walker goes to where it will stand now, not at the end: what follows the figure (the camera)
    // blends from the saddle toward that place, never toward the place it got on at.
    this.besideSteed(this.to);
    releaseToWalker(this.transition, this.riderWalker, this.to[0]!, this.to[1]!, this.to[2]!, this.to[3]!);
    if (instant) this.finishDismount();
    return true;
  }

  /** The place beside the steed on `side` where the figure gets off: x, ground y, z and the steed's heading. */
  private besideSteed(out: Float64Array): void {
    const w = this.walker;
    const p = w.position, yaw = w.yaw;
    const x = p[0]! - Math.cos(yaw) * this.side * SIDE_M, z = p[2]! + Math.sin(yaw) * this.side * SIDE_M;
    out[0] = x;
    out[1] = this.world.groundAt(x, z, p[1]! + 0.4, 0.4);
    out[2] = z;
    out[3] = yaw;
  }

  /** 1 when the left side of the steed has free ground for the figure, otherwise −1 when the right has, otherwise 1. */
  private freeSide(): number {
    const w = this.walker, p = w.position, yaw = w.yaw, sp = this.spots;
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 1 : -1;
      sp[k * 4] = p[0]!;
      sp[k * 4 + 1] = p[2]!;
      sp[k * 4 + 2] = p[0]! - Math.cos(yaw) * s * SIDE_M;
      sp[k * 4 + 3] = p[2]! + Math.sin(yaw) * s * SIDE_M;
    }
    return this.world.firstStandSpot(sp, p[1]!, this.stand) === 1 ? -1 : 1;
  }

  /** Whether the figure fits beside the steed on side `s`: no solid between, ground within a step of the steed's. */
  sideFree(s: number): boolean {
    const w = this.walker;
    const p = w.position, yaw = w.yaw;
    const tx = p[0]! - Math.cos(yaw) * s * SIDE_M, tz = p[2]! + Math.sin(yaw) * s * SIDE_M;
    return !Number.isNaN(this.world.standSpot(p[0]!, p[2]!, tx, tz, p[1]!, this.stand));
  }

  /** The figure is put down beside the steed on `side`: its walker there (the steed may have moved), the ride over. */
  private finishDismount(): void {
    this.besideSteed(this.to);
    this.riderWalker.teleport(this.to[0]!, this.to[1]!, this.to[2]!, this.to[3]!);
    this.transition.releaseNow();
    this.poseWeight.to(0, 0.3);
    for (const r of [this.acts.left!, this.acts.right!, ...this.feet]) r.fade.set(0);
  }

  /**
   * One fixed step of the steed's walker: steered by `intent` (a world direction and Shift) while the figure rides,
   * standing otherwise.
   */
  step(intent: WalkIntent | null): void {
    const s = this.steer;
    const on = this.mode === 'on' && intent !== null;
    s.moveX = on ? intent.moveX : 0;
    s.moveZ = on ? intent.moveZ : 0;
    s.run = on ? intent.run : false;
    s.jump = false;
    this.walker.step(s);
  }

  /** Advances the steed's walker by `dt` seconds of frames (as `Walker.advance`). */
  advance(dt: number, intent: WalkIntent | null): void {
    const s = this.steer;
    const on = this.mode === 'on' && intent !== null;
    s.moveX = on ? intent.moveX : 0;
    s.moveZ = on ? intent.moveZ : 0;
    s.run = on ? intent.run : false;
    s.jump = false;
    this.walker.advance(dt, s);
  }

  /**
   * Brings the steed and the rider's timeline to the steed walker's state at `a` of the way between its last two steps
   * (1 for the step just taken). Call once a frame (or after every scripted step) before `pose`.
   */
  update(a: number): void {
    const w = this.walker;
    const t = this.time(a);
    let dt = t - this.clock;
    this.clock = t;
    if (dt < 0 || dt > 1) dt = 0;
    w.renderPosition(this.at, a);
    const yaw = w.renderYaw(a);
    const v = w.velocity;
    if (!this.stepped) {
      this.gait.reset(this.at[0]!, this.at[1]!, this.at[2]!, yaw, this.heightAt);
      this.stepped = true;
    }
    this.gait.update(dt, this.at[0]!, this.at[1]!, this.at[2]!, yaw, v[0]!, v[2]!, this.heightAt);
    if (!(dt > 0)) return;
    const tr = this.transition;
    tr.advance(dt);
    this.acts.update(dt);
    for (const f of this.feet) f.update(dt);
    this.poseWeight.update(dt);
    const g = this.gait;
    this.graph.setParam('speed', g.speed);
    this.graph.setParam('passes', g.passes);
    this.graph.update(dt);
    // The cues of getting on: the riding graph at the end of the step to the side, then the hands, the feet, the gaze.
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
    // The figure's own gait: standing while it rides (its clock keeps the ponytail going), stepping on the approach.
    const moved = tr.gettingOn ? tr.approachMoved(this.approachLength()) : 0;
    if (this.mode !== 'off') this.rider.update(dt, moved, true, 0);
  }

  /** Length of the step to the steed's side, m. */
  private approachLength(): number {
    this.mountSpot(this.to);
    const f = this.transition.from;
    return Math.hypot(this.to[0]! - f[0]!, this.to[2]! - f[2]!);
  }

  /** Where the figure stands to climb on: beside the left stirrup (x, y, z, yaw). */
  private mountSpot(out: Float64Array): void {
    const r = this.gait.root;
    out[0] = r[9]! + r[0]! * MOUNT_SIDE_M - r[6]! * 0.02;
    out[2] = r[11]! + r[2]! * MOUNT_SIDE_M - r[8]! * 0.02;
    out[1] = r[10]!;
    out[3] = this.walker.renderYaw(1);
  }

  /** The steed's bones for the frame (after `update`). */
  poseSteed(): Float64Array {
    return this.gait.solve();
  }

  /** Turns the steed's head toward a point when the figure is near and not riding; lets it go otherwise. */
  watch(x: number, y: number, z: number): void {
    const p = this.gait.root;
    const near = this.mode === 'off' && Math.hypot(x - p[9]!, z - p[11]!) < 6 && this.gait.speed < 0.2;
    this.gait.look(near ? [x, y, z] : null, 0.8);
  }

  /** Whether the rider's pose comes from the ride (otherwise the page poses the figure by its walker). */
  get posesRider(): boolean {
    return this.mode !== 'off' || this.poseWeight.value > 0 || this.seat.weight > 0;
  }

  /**
   * The rider's bones for the frame, after `poseSteed`: `ground` is the figure's own drawn place and heading (used
   * while it is not in the saddle).
   */
  poseRider(gx: number, gy: number, gz: number, gyaw: number): Float64Array {
    const body = this.rider;
    const g = body.gait;
    const sk = body.kind.skeleton;
    const steed = this.gait.world;
    const k = body.scale;
    // The free root: on the ground (stepping to the side on the way on), rising beside the steed as the figure climbs;
    // beside the steed where it gets off while it rides and climbs down.
    const tr = this.transition;
    const seatY = steed[this.kind.steps.trunk * 12 + 10]! + this.seatSocket.local[10]!;
    const at = this.to;
    const phase = tr.phase;
    if (phase === 'approach' || phase === 'attach') this.mountSpot(at);
    else if (phase === 'held' || phase === 'release') {
      const r = this.gait.root;
      const s = this.side;
      at[0] = r[9]! + r[0]! * s * SIDE_M;
      at[2] = r[11]! + r[2]! * s * SIDE_M;
      at[1] = this.world.groundAt(at[0], at[2], r[10]! + 0.4, 0.4);
      at[3] = this.walker.renderYaw(1);
    } else (at[0] = gx), (at[1] = gy), (at[2] = gz), (at[3] = gyaw);
    const pl = tr.place(at, seatY, this.place);
    headingRoot(pl[0]!, pl[1]!, pl[2]!, pl[3]!, k, this.free);
    const root = body.root;
    // The pose: the figure's own gait under the riding graph.
    g.graph.evaluate(g.pose);
    this.graph.evaluate(this.riderPose);
    blendPose(g.pose, g.pose, this.riderPose, this.poseWeight.value);
    tr.write(this.free, steed, this.seatSocket, root);
    solvePose(sk, g.pose, root, g.world);
    // The gaze: ahead, toward where the steed turns.
    const gz2 = this.acts.gaze;
    if (gz2 && gz2.weight > 0) {
      const r = this.gait.root;
      const ahead = 8, bend = Math.max(-0.7, Math.min(0.7, this.gait.turn * 0.6));
      const cb = Math.cos(bend), sb = Math.sin(bend);
      // Forward turned toward the left by `bend` (left is the root's first column).
      const fx = r[6]! * cb + r[0]! * sb, fz = r[8]! * cb + r[2]! * sb;
      gz2.setTarget(root[9]! + fx * ahead, root[10]! + 1.0, root[11]! + fz * ahead);
    }
    this.acts.aim(g, root);
    this.acts.left!.setTargetSocket(steed, this.gripL);
    this.acts.right!.setTargetSocket(steed, this.gripR);
    this.acts.reach(g, root);
    this.feet[0].setTargetSocket(steed, this.stirrupL);
    this.feet[1].setTargetSocket(steed, this.stirrupR);
    for (let i = 0; i < 2; i++) {
      const r = this.feet[i]!;
      if (r.weight <= 0) continue;
      // The knee forward and out.
      const px = i === 0 ? 0.5 : -0.5, py = 0.1, pz = 1.2;
      for (let j = 0; j < 3; j++) r.pole[j] = root[j]! * px + root[3 + j]! * py + root[6 + j]! * pz + root[9 + j]!;
      r.apply(sk, g.pose, root, g.world);
    }
    body.tailAngle = g.applyLag(root);
    return g.world;
  }

  /** Weights of the patterns at a speed, as the step cycle blends them (walk, trot, gallop). */
  private patternWeights(v: number): [number, number, number] {
    speedWeights(this.patternSpeeds, v, this.weights);
    const w = this.weights;
    return [w[0] ?? 0, w[1] ?? 0, w[2] ?? 0];
  }

  /** The state for a script. */
  status(): RideStatus {
    const w = this.walker, g = this.gait, c = g.cycle;
    const p = w.position;
    const four = (a: ArrayLike<number>): [number, number, number, number] => [a[0]!, a[1]!, a[2]!, a[3]!];
    const pw = this.patternWeights(g.speed);
    return {
      mode: this.mode,
      seat: this.seat.weight,
      holds: [this.acts.left!.weight, this.acts.right!.weight, this.feet[0].weight, this.feet[1].weight],
      trot: this.trot,
      x: p[0]!,
      y: p[1]!,
      z: p[2]!,
      yawDeg: w.yaw / DEG,
      speed: Math.hypot(w.velocity[0]!, w.velocity[2]!),
      phase: c.phase,
      rate: c.rate,
      patterns: pw,
      downs: four(c.downs),
      planted: four(c.planted),
      dip: g.dip,
      time: g.life.time,
      effort: g.life.effort,
    };
  }
}

