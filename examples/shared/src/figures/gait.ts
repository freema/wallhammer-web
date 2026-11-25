// A figure moved by a controller: the engine's `MotionGraph` over four motions of a kind (standing, walking, running and
// one in the air), driven by what the body did in the frame (metres moved over the ground, whether it stands, how fast
// it climbs), then the legs fitted to the ground under the feet.
//
//   stand  ↔  walk  ↔  run     cross-fades on the ground speed (smoothed), with a gap between the thresholds up and
//                              down so a speed on a threshold does not flicker between two states
//   any    →  air              after `AIR_AFTER_S` seconds off the ground, or at once when the body climbs fast (a jump)
//   air    →  stand/walk/run   on landing, by the speed
//
// Phase. Walk and run are driven by one parameter, `stride`: the passes made so far, grown every frame by the metres
// moved over the metres one pass covers at that speed (the walk's `strideM` at the walking speed, the run's at the
// running speed, in between by the speed). A pass of either motion is the same two steps, so a cross-fade between them
// keeps the feet in step, and a figure moved at any speed does not slide. Standing and the air run on the clock.
//
// The fit. `fitToGround` of the engine keeps the feet on the ground the game gives (`heightAt`, +y up), lowers the
// pelvis by the deepest drop, and tilts the soles with the slope; its weight fades out while the figure is in the air
// and back in on landing.
//
// Acts (`GaitOptions.acts`, for a kind with the motions named in `GaitActs`). Over the body, a layer per gesture, each
// masked to the arms it moves and faded in and out on its own: `wave` (the right arm; a trigger plays four waves, a
// held parameter keeps waving), `hand` (the right arm offering or taking), `read` (both arms). A state with no source
// passes the layers below through, so a layer at rest changes nothing: the legs keep walking under a waving arm. The
// body itself can sit: stand → sitDown → sit while `seated` is 1, and sit → standUp → stand once it is 0; the pelvis
// then goes down to the ground under the seat (on a slope it may lie lower or higher than the feet's plane) and the
// feet are fitted where they rest.
//
// Momentum (`GaitOptions.lean`, for a kind with the additive motions `push` and `brace`). The smoothed ground speed's
// rate of change is the body's acceleration along its way: two additive layers over everything lean the body into a
// start (`push`) and brace it against a stop (`brace`), weighted by that acceleration over `LEAN_FULL_MS2` times the
// lean. The steps of a run-up and of braking come from the phase alone: it follows the distance moved, so a body
// that speeds up or slows down takes shorter and slower steps and its feet do not slide.
//
// A lagging chain (`GaitOptions.lag`, for a kind with `lag`): `applyLag` after the post steps that move what the chain
// hangs on (the ground fit, the gaze) advances the engine's `ChainLag` of every chain by the time of the last
// `update`s and turns its bones in the pose.
//
// Everything is a function of the calls: the same `update`s give the same poses. Nothing is allocated per frame.

import { ChainLag, MotionGraph, MotionGraphDef, Pose, boneMask, fitToGround, solvePose } from 'wallhammer-web/motion';
import type { GroundFitOptions, MotionLayerDesc } from 'wallhammer-web/motion';
import type { FigureInput, FigureKind, FigureMotion } from './kind.ts';

/** Which motions of the kind play which part. */
export interface GaitMotions {
  stand: string;
  walk: string;
  run: string;
  air: string;
}

export interface GaitOptions {
  /** The walking and running speeds of the body, m/s: the walk's and the run's stride belong to them. */
  walkSpeed: number;
  runSpeed: number;
  /** Size of the figure against the kind's own (its strides grow with it). Default 1. */
  scale?: number;
  motions?: Partial<GaitMotions>;
  /** 0–1, shifts the idle rhythms (`FigureInput.seed`). Default 0. */
  seed?: number;
  /** Adds the layers of the acts and the seated states (the kind must have the motions of `GaitActs`). Default false. */
  acts?: boolean | Partial<GaitActs>;
  /** Length of a pass against the kind's own (on top of `scale`): above 1 a longer, slower step. Default 1. */
  strideScale?: number;
  /**
   * Weight of the lean into a start and back against a stop (the kind's additive motions `push` and `brace`) at an
   * acceleration of `LEAN_FULL_MS2`. 0 (default): no lean layers.
   */
  lean?: number;
  /** Lets the kind's `lag` chains lag behind the motion (`applyLag`). Default false. */
  lag?: boolean;
}

/** Acceleration along the way, m/s², at which the lean layers reach `GaitOptions.lean`. */
export const LEAN_FULL_MS2 = 8;
/** Time constant of the smoothed acceleration, s. */
const ACCEL_SMOOTH_S = 0.1;

/** Which motions of the kind play the acts, and the bones their layers move. */
export interface GaitActs {
  wave: string;
  offer: string;
  take: string;
  read: string;
  sitDown: string;
  sit: string;
  standUp: string;
  /** The bones (with what lies below them) of the one-arm layers and of the two-arm layer. */
  rightArm: string;
  leftArm: string;
  /** Passes of `wave` one trigger plays. */
  waves: number;
}

const DEFAULT_ACTS: GaitActs = { wave: 'wave', offer: 'offer', take: 'take', read: 'read', sitDown: 'sitDown', sit: 'sit', standUp: 'standUp', rightArm: 'armR', leftArm: 'armL', waves: 4 };

/** What the hand of the `hand` layer does. */
export const HAND = { none: 0, offer: 1, take: 2 } as const;

/** Seconds off the ground before a figure counts as in the air (a step down or a bump does not). */
export const AIR_AFTER_S = 0.15;
/** Climb speed, m/s, that counts as a jump at once. */
const JUMP_CLIMB = 1.5;
/** Time constant of the smoothed ground speed, s. */
const SPEED_SMOOTH_S = 0.12;
/** Seconds the fit takes to fade out after leaving the ground and back in after landing. */
const FIT_FADE_S = 0.12;
/** Largest shift of a seated pelvis to the ground under it, m. */
const SEAT_REACH_M = 0.4;

const DEFAULT_MOTIONS: GaitMotions = { stand: 'stand', walk: 'walk', run: 'run', air: 'leap' };

function motionOf(kind: FigureKind, name: string): FigureMotion {
  const m = kind.motions[name];
  if (!m) throw new Error(`figure ${kind.name}: no motion ${name}`);
  return m;
}

/** The graph's description for a kind and its speeds. */
function gaitGraph(kind: FigureKind, m: GaitMotions, walkSpeed: number, runSpeed: number, acts: GaitActs | null, lean: boolean): MotionGraphDef<FigureInput> {
  // The thresholds: moving at a fifth of the walking speed, running from the middle between the two speeds.
  const move = 0.2 * walkSpeed;
  const mid = 0.5 * (walkSpeed + runSpeed);
  const gap = 0.1 * (runSpeed - walkSpeed);
  const landed = { param: 'grounded', op: '>' as const, value: 0.5 };
  const body: MotionLayerDesc<FigureInput> = {
    name: 'body',
    states: [
      { name: 'stand', source: motionOf(kind, m.stand) },
      { name: 'walk', source: motionOf(kind, m.walk), drive: { param: 'stride', per: 1 } },
      { name: 'run', source: motionOf(kind, m.run), drive: { param: 'stride', per: 1 } },
      { name: 'air', source: motionOf(kind, m.air) },
      ...(acts
        ? [
            { name: 'sitDown', source: motionOf(kind, acts.sitDown) },
            { name: 'sit', source: motionOf(kind, acts.sit) },
            { name: 'standUp', source: motionOf(kind, acts.standUp) },
          ]
        : []),
    ],
    transitions: [
      { from: '*', to: 'air', seconds: 0.15, when: [{ param: 'air', op: '>=', value: AIR_AFTER_S }] },
      { from: '*', to: 'air', seconds: 0.1, when: [{ param: 'climb', op: '>', value: JUMP_CLIMB }, { param: 'grounded', op: '<', value: 0.5 }] },
      { from: 'air', to: 'run', seconds: 0.12, when: [landed, { param: 'speed', op: '>', value: mid }] },
      { from: 'air', to: 'walk', seconds: 0.12, when: [landed, { param: 'speed', op: '>', value: move }] },
      { from: 'air', to: 'stand', seconds: 0.15, when: [landed] },
      ...(acts
        ? [
            { from: 'stand', to: 'sitDown', seconds: 0.25, when: [{ param: 'seated', op: '>' as const, value: 0.5 }, { param: 'speed', op: '<' as const, value: 0.5 * move }] },
            { from: 'sitDown', to: 'standUp', seconds: 0.3, when: [{ param: 'seated', op: '<' as const, value: 0.5 }] },
            { from: 'sitDown', to: 'sit', seconds: 0.35, after: 1 },
            { from: 'sit', to: 'standUp', seconds: 0.3, when: [{ param: 'seated', op: '<' as const, value: 0.5 }] },
            { from: 'standUp', to: 'stand', seconds: 0.3, after: 1 },
          ]
        : []),
      { from: 'stand', to: 'walk', seconds: 0.2, when: [{ param: 'speed', op: '>', value: move }] },
      { from: 'walk', to: 'stand', seconds: 0.25, when: [{ param: 'speed', op: '<', value: 0.5 * move }] },
      { from: 'walk', to: 'run', seconds: 0.25, when: [{ param: 'speed', op: '>', value: mid + gap }] },
      { from: 'run', to: 'walk', seconds: 0.3, when: [{ param: 'speed', op: '<', value: mid - gap }] },
      { from: 'run', to: 'stand', seconds: 0.3, when: [{ param: 'speed', op: '<', value: 0.5 * move }] },
    ],
  };
  const layers: MotionLayerDesc<FigureInput>[] = [body];
  if (acts) {
    const sk = kind.skeleton;
    const right = boneMask(sk, [acts.rightArm]);
    const both = boneMask(sk, [acts.rightArm, acts.leftArm]);
    // Every gesture: a layer of its own over the arms, at rest in a state without a source (the layers below pass).
    layers.push({
      name: 'read',
      mask: both,
      states: [{ name: 'off' }, { name: 'read', source: motionOf(kind, acts.read) }],
      transitions: [
        { from: 'off', to: 'read', seconds: 0.5, when: [{ param: 'reading', op: '>', value: 0.5 }] },
        { from: 'read', to: 'off', seconds: 0.5, when: [{ param: 'reading', op: '<', value: 0.5 }] },
      ],
    });
    layers.push({
      name: 'hand',
      mask: right,
      states: [{ name: 'off' }, { name: 'offer', source: motionOf(kind, acts.offer) }, { name: 'take', source: motionOf(kind, acts.take) }],
      transitions: [
        { from: '*', to: 'offer', seconds: 0.45, when: [{ param: 'hand', op: '==', value: HAND.offer }] },
        { from: '*', to: 'take', seconds: 0.45, when: [{ param: 'hand', op: '==', value: HAND.take }] },
        { from: '*', to: 'off', seconds: 0.5, when: [{ param: 'hand', op: '==', value: HAND.none }] },
      ],
    });
    layers.push({
      name: 'wave',
      mask: right,
      states: [{ name: 'off' }, { name: 'wave', source: motionOf(kind, acts.wave) }],
      transitions: [
        { from: 'off', to: 'wave', seconds: 0.3, trigger: 'wave' },
        { from: 'off', to: 'wave', seconds: 0.3, when: [{ param: 'waving', op: '>', value: 0.5 }] },
        { from: 'wave', to: 'off', seconds: 0.35, after: acts.waves, when: [{ param: 'waving', op: '<', value: 0.5 }] },
      ],
    });
  }
  if (lean) {
    // Over everything: a lean forward into a start and back against a stop, each weighted by its parameter.
    layers.push({ name: 'push', mode: 'additive', weight: 'push', states: [{ name: 'push', source: motionOf(kind, 'push') }] });
    layers.push({ name: 'brace', mode: 'additive', weight: 'brace', states: [{ name: 'brace', source: motionOf(kind, 'brace') }] });
  }
  return new MotionGraphDef<FigureInput>({
    skeleton: kind.skeleton,
    params: { speed: 0, stride: 0, grounded: 1, air: 0, climb: 0, ...(acts ? { seated: 0, reading: 0, hand: 0, waving: 0 } : {}), ...(lean ? { push: 0, brace: 0 } : {}) },
    ...(acts ? { triggers: ['wave'] } : {}),
    layers,
  });
}

/** What `FigureGait.solve` needs of the ground. */
export interface GaitGround {
  /** Height of the ground (standable tops included) at (x, z) of the frame the figure is solved in, +y up. */
  heightAt(x: number, z: number): number;
}

/** The pose of one moving figure, frame by frame. */
export class FigureGait {
  readonly kind: FigureKind;
  readonly graph: MotionGraph<FigureInput>;
  readonly pose: Pose;
  /** The bones in the frame they were last solved in (12 numbers per bone, `solvePose`). */
  readonly world: Float64Array;
  /** Ground speed, smoothed, m/s. */
  speed = 0;
  /** Passes of the walk or run made so far (the `stride` parameter). */
  stride = 0;
  /** Seconds since the feet left the ground; 0 on it. */
  airSeconds = 0;
  /** Weight of the ground fit now, 0–1. */
  fit = 1;
  /** Acceleration along the way, smoothed, m/s² (the rate of change of `speed`). */
  accel = 0;
  /** The lagging chains (`GaitOptions.lag`), in the order of the kind's `lag`. */
  readonly lags: readonly ChainLag[];
  private readonly lean: number;
  /** Seconds of `update` not yet given to the lagging chains. */
  private lagDt = 0;
  private readonly input: FigureInput;
  private readonly walkStride: number;
  private readonly runStride: number;
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly fitOptions: GroundFitOptions;
  /** The acts' motions, or null when the gait has none. */
  readonly acts: GaitActs | null;

  constructor(kind: FigureKind, o: GaitOptions) {
    const m = { ...DEFAULT_MOTIONS, ...o.motions };
    const k = o.scale ?? 1;
    this.kind = kind;
    this.walkSpeed = o.walkSpeed;
    this.runSpeed = o.runSpeed;
    const ks = k * (o.strideScale ?? 1);
    this.walkStride = (motionOf(kind, m.walk).strideM ?? 1) * ks;
    this.runStride = (motionOf(kind, m.run).strideM ?? 2) * ks;
    this.input = { seed: o.seed ?? 0, param: 0 };
    this.acts = o.acts ? { ...DEFAULT_ACTS, ...(o.acts === true ? {} : o.acts) } : null;
    this.lean = Math.max(0, o.lean ?? 0);
    this.graph = new MotionGraph(gaitGraph(kind, m, o.walkSpeed, o.runSpeed, this.acts, this.lean > 0), this.input);
    this.lags = o.lag ? (kind.lag ?? []).map((c) => new ChainLag(kind.skeleton, c)) : [];
    this.pose = new Pose(kind.skeleton);
    this.world = new Float64Array(kind.skeleton.count * 12);
    this.fitOptions = { heightAt: () => 0, planeY: 0, maxLift: 0.35, maxDrop: 0.45, align: 1, maxAlign: 0.5, lower: kind.legs?.pelvis ?? -1, weight: 1 };
  }

  /** Metres one pass covers at ground speed `v`. */
  strideAt(v: number): number {
    const t = Math.min(1, Math.max(0, (v - this.walkSpeed) / (this.runSpeed - this.walkSpeed)));
    return this.walkStride + (this.runStride - this.walkStride) * t * t * (3 - 2 * t);
  }

  /** Starts over: standing, the stride at 0, on the ground. */
  reset(): void {
    this.graph.reset();
    this.speed = 0;
    this.stride = 0;
    this.airSeconds = 0;
    this.fit = 1;
    this.accel = 0;
    this.lagDt = 0;
    for (const l of this.lags) l.reset();
  }

  /**
   * Advances by `dt` seconds in which the body moved `moved` metres over the ground, stands (`grounded`) or not, and
   * climbs at `climb` m/s.
   */
  update(dt: number, moved: number, grounded: boolean, climb: number): void {
    if (!(dt > 0)) return;
    const g = this.graph;
    const was = this.speed;
    this.speed += (moved / dt - this.speed) * (1 - Math.exp(-dt / SPEED_SMOOTH_S));
    this.accel += ((this.speed - was) / dt - this.accel) * (1 - Math.exp(-dt / ACCEL_SMOOTH_S));
    this.lagDt += dt;
    this.stride += moved / this.strideAt(this.speed);
    this.airSeconds = grounded ? 0 : this.airSeconds + dt;
    const fade = dt / FIT_FADE_S;
    this.fit = grounded ? Math.min(1, this.fit + fade) : Math.max(0, this.fit - fade);
    g.setParam('speed', this.speed);
    g.setParam('stride', this.stride);
    g.setParam('grounded', grounded ? 1 : 0);
    g.setParam('air', this.airSeconds);
    g.setParam('climb', climb);
    if (this.lean > 0) {
      // No lean in the air or seated.
      const k = grounded ? this.lean / LEAN_FULL_MS2 : 0;
      g.setParam('push', Math.min(1, Math.max(0, this.accel * k)));
      g.setParam('brace', Math.min(1, Math.max(0, -this.accel * k)));
    }
    g.update(dt);
  }

  /**
   * Lets the lagging chains follow the motion since the last call, after `solve` and the post steps that move what
   * they hang on: their bones turn in `pose` and `world`. `root` is the matrix of the last `solve`; `motion` the same
   * root in a frame that does not jump (default `root`: see `ChainLag.apply`). Returns the largest angle of a link
   * from its posed direction, radians.
   */
  applyLag(root: ArrayLike<number>, motion: ArrayLike<number> = root): number {
    let most = 0;
    const dt = this.lagDt;
    this.lagDt = 0;
    for (const l of this.lags) most = Math.max(most, l.apply(dt, this.kind.skeleton, this.pose, root, this.world, motion));
    return most;
  }

  /** The active state of the graph (the newest one of a fade). */
  get state(): string {
    return this.graph.state('body');
  }

  /** Sits down (true; only from standing) or stands up (false). Needs the acts. */
  setSeated(on: boolean): void {
    if (this.acts) this.graph.setParam('seated', on ? 1 : 0);
  }

  /** Whether the body was asked to sit (`setSeated`). */
  getSeated(): boolean {
    return !!this.acts && this.graph.getParam('seated') > 0.5;
  }

  /** How far the body is in a seated state, 0–1 (the weights of sitting down, sitting and standing up). */
  get seatedWeight(): number {
    if (!this.acts) return 0;
    const g = this.graph;
    return g.weightOf('sitDown', 'body') + g.weightOf('sit', 'body') + g.weightOf('standUp', 'body');
  }

  /** Plays the wave once (`GaitActs.waves` passes). */
  wave(): void {
    this.graph.trigger('wave');
  }

  /** Keeps waving while true. */
  setWaving(on: boolean): void {
    this.graph.setParam('waving', on ? 1 : 0);
  }

  /** The right hand offers (`HAND.offer`), takes (`HAND.take`) or rests (`HAND.none`). */
  setHand(h: number): void {
    this.graph.setParam('hand', h);
  }

  /** Both arms hold something up to read. */
  setReading(on: boolean): void {
    this.graph.setParam('reading', on ? 1 : 0);
  }

  /**
   * Poses the figure at `root` (3 × 4, columns left, up, forward of the figure, then the feet; +y up in this frame)
   * into `world`, its feet fitted to `ground` (heights of the same frame) around the plane `planeY` it stands on.
   */
  solve(root: ArrayLike<number>, ground: GaitGround | null, planeY: number): Float64Array {
    const pose = this.pose;
    this.graph.evaluate(pose);
    const legs = this.kind.legs;
    const seated = this.seatedWeight;
    if (legs && ground && seated > 0) {
      // Seated: the pelvis goes to the ground under it (the root's x and z in this frame), in the kind's units.
      const k = Math.hypot(root[3]!, root[4]!, root[5]!) || 1;
      const d = Math.min(SEAT_REACH_M, Math.max(-SEAT_REACH_M, ground.heightAt(root[9]!, root[11]!) - planeY));
      pose.offset[legs.pelvis * 3 + 1] = pose.offset[legs.pelvis * 3 + 1]! + (d * Math.min(1, seated)) / k;
    }
    solvePose(this.kind.skeleton, pose, root, this.world);
    if (legs && ground && this.fit > 0) {
      const o = this.fitOptions;
      o.heightAt = ground.heightAt;
      o.planeY = planeY;
      o.weight = this.fit;
      // A seated pelvis rests on the ground: the feet reach for theirs without lowering it.
      o.lower = seated > 0.5 ? -1 : legs.pelvis;
      fitToGround(this.kind.skeleton, pose, root, this.world, legs.chains, o);
    }
    return this.world;
  }
}
