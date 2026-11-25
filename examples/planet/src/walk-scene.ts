// The figures of the walk mode without the GPU (walk.ts draws them; scripts/verify.ts drives them in Node).
//
// `WalkBody`: one figure of the shared pathfinder kind posed in the walker's chart, where +y is up. Its gait
// (`FigureGait` of examples/shared) is the engine's `MotionGraph` over the figure's own motions; `fitToGround` puts the
// feet on the chart's collision world (`groundAt`: the drawn ground and the tops of rocks), lowers the pelvis by the
// deepest drop and tilts the soles with the slope. Then its gaze and arms (`FigureActs`: the engine's `ChainAim` and
// `TwoBoneReach`) and its sockets. The solved bones are stood on the sphere with the chart's frame at the feet
// (`frameAt`, relative to the render origin).
//
// `WalkScene`: the walker's figure, a second figure of the same kind standing near the start, and the things they hold
// (a box, a book). Everything is a function of the frames it is given (fixed `dt`), so a script's drive gives the
// same bones and props every time. The acts:
//
//   greet   both turn to face each other (the walker steps to 0.95 m from the other first), both wave
//   give    both face each other; the one holding the box offers it, the other takes: both right arms reach for one
//           meeting point between them, at the mark the box passes from hand to hand in a quarter second, the arms
//           go back. The key E greets the first time and gives right after; later it gives (back and forth).
//   wave    the walker waves once (four passes), also while walking or running: the layer moves the right arm only
//   read    the walker takes the book from the pocket on the side of the pack with its right hand (a box in that hand
//           goes to the belt first), lifts it in front of the chest, the left hand takes the other edge, the book
//           opens and the head looks at it; again: it closes, goes back to the pocket and the box back to the hand.
//           Walking keeps reading; running or a jump puts the book away.
//   sit     the walker sits down where it stands (the pelvis on the ground under it, the feet fitted to the slope);
//           again, or a key that moves, stands it up; it walks on once it stands.
//
// While nobody acts, the standing figure's head follows the walker within 8 m and the walker glances back at it (the
// gaze's limits fade the turn out when the other is behind).

import type { SurfaceChart, Vec3 } from 'wallhammer-web/base';
import { SocketBlend, WeightFade, aimAngles } from 'wallhammer-web/motion';
import type { AimAngles, Socket } from 'wallhammer-web/motion';
import { ChartWalker } from 'wallhammer-web/world';
import type { CollisionWorld, WalkIntent, WalkerSetup } from 'wallhammer-web/world';
import { FigureActs } from '../../shared/src/figures/acts.ts';
import { FigureGait, HAND } from '../../shared/src/figures/gait.ts';
import type { FigureKind } from '../../shared/src/figures/kind.ts';
import { BOOK_HINGE_Z, PATHFINDERS, WAVE_S } from '../../shared/src/figures/pathfinder.ts';
import { MOVE_PROFILES } from '../../shared/src/figures/profiles.ts';
import type { MoveProfile } from '../../shared/src/figures/profiles.ts';
import { Pose, solvePose } from 'wallhammer-web/motion';

/**
 * The setup of the walker: the default movement profile (profiles.ts of examples/shared: speeds that match the
 * figure's gait, a walk of 1.0 m and a run of 2.3 m a pass, a run-up, braking and a running turn in an arc) at the
 * figures' height. `PlanetWalk.setProfile` retunes it.
 */
export const WALK_SETUP: Partial<WalkerSetup> = { height: 1.75, ...MOVE_PROFILES.default.walker };
/** Height of the figures, m. */
const FIGURE_HEIGHT_M = 1.75;
/** Height of the eyes over the feet, m. */
const EYES_M = 1.45;
/** The second figure: within this the acts with it start, m. */
export const MEET_RANGE_M = 4;
/** Feet to feet when the box passes, m. */
const MEET_M = 0.95;
/** Height of the meeting point of the hands over the feet, m. */
const MEET_HANDS_M = 1.0;
/** The heads follow each other within this, m. */
const GAZE_RANGE_M = 8;
/** Radius of the second figure as a solid, m. */
const OTHER_SOLID_M = 0.35;
/** How far the front half of the book turns open, radians. */
const BOOK_OPEN = 2.9;

/** One figure of the walk in the walker's chart: gait, gaze and arms, bones for drawing. */
export class WalkBody {
  readonly kind: FigureKind;
  /** The gait of the current profile (`setProfile` makes a new one). */
  gait: FigureGait;
  /** The movement profile of the gait. */
  profile: MoveProfile;
  /** Largest angle of the ponytail's links from their posed directions after the last `reach`, radians. */
  lagAngle = 0;
  private readonly seed: number;
  private readonly motion = new Float64Array(12);
  readonly acts: FigureActs;
  readonly scale: number;
  /** The bones for drawing (12 numbers each, less the render origin), after `solve` or `toRender`. */
  readonly bones: Float64Array;
  /** The root of the last pose in the chart (columns left, up, forward, then the feet). */
  readonly root = new Float64Array(12);
  /** Height of the lower sole above the ground under it in the last pose, m (the stance foot's gap). */
  footGap = 0;
  /** Turns the figure from its walker's heading to `faceYaw` (a chart heading), eased. */
  readonly face = new WeightFade(0);
  faceYaw = 0;
  private lastTravelled = 0;
  private readonly at = new Float64Array(3);
  private readonly frame = new Float64Array(12);
  private readonly restAnkle: number;
  private walker: ChartWalker | null = null;
  readonly ground = {
    heightAt: (x: number, z: number): number => {
      const w = this.walker!;
      return w.world.groundAt(x, z, this.at[1]!, w.setup.maxStepUp);
    },
  };

  constructor(seed = 0.37, profile: MoveProfile = MOVE_PROFILES.default) {
    this.kind = PATHFINDERS.pathfinder();
    this.scale = FIGURE_HEIGHT_M / this.kind.heightM;
    this.seed = seed;
    this.profile = profile;
    this.gait = this.makeGait(profile);
    this.acts = new FigureActs(this.kind);
    this.bones = new Float64Array(this.kind.skeleton.count * 12);
    // Height of the ankle joint over the sole in the rest pose (the chain's end).
    const legs = this.kind.legs!;
    const rest = new Float64Array(this.kind.skeleton.count * 12);
    solvePose(this.kind.skeleton, new Pose(this.kind.skeleton), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], rest);
    this.restAnkle = rest[legs.chains[0]!.end * 12 + 10]! * this.scale;
  }

  private makeGait(p: MoveProfile): FigureGait {
    const w = p.walker;
    return new FigureGait(this.kind, { walkSpeed: w.walkSpeed, runSpeed: w.runSpeed, scale: this.scale, seed: this.seed, acts: true, strideScale: p.gait.strideScale, lean: p.gait.lean, lag: true });
  }

  /** A new gait for another movement profile; it starts standing (the page retunes the walker). */
  setProfile(p: MoveProfile): void {
    this.profile = p;
    this.gait = this.makeGait(p);
  }

  /** The bones in the chart after the last pose. */
  get chartBones(): Float64Array {
    return this.gait.world;
  }

  /** Starts over at the walker's place (after a teleport): standing, nothing travelled. */
  reset(w: ChartWalker): void {
    this.walker = w;
    this.gait.reset();
    this.face.set(0);
    this.lastTravelled = w.renderTravelled();
  }

  /** One frame of `dt` seconds after the walker has advanced. */
  update(dt: number, w: ChartWalker): void {
    this.walker = w;
    const t = w.renderTravelled();
    const moved = Math.max(0, t - this.lastTravelled);
    this.lastTravelled = t;
    this.gait.update(dt, moved, w.grounded, w.walker.velocity[1]!);
    this.acts.update(dt);
    this.face.update(dt);
  }

  /** One frame of `dt` seconds of a figure that stands where it is. */
  updateStanding(dt: number): void {
    this.gait.update(dt, 0, true, 0);
    this.acts.update(dt);
    this.face.update(dt);
  }

  /**
   * Poses the figure in the chart of `w` with its feet at `p` (chart) facing the chart heading `yaw` (it faces
   * (−sin yaw, −cos yaw)), turned toward `faceYaw` by the weight of `face`; runs the gait's solve and the gaze. The
   * arms reach in `reach` (after the caller has set their targets from the posed trunk).
   */
  pose(w: ChartWalker, p: ArrayLike<number>, yaw: number): Float64Array {
    this.walker = w;
    this.at[0] = p[0]!;
    this.at[1] = p[1]!;
    this.at[2] = p[2]!;
    const fw = this.face.value;
    if (fw > 0) {
      let d = this.faceYaw - yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yaw += d * fw;
    }
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const k = this.scale;
    // Columns: the figure's left, up and forward in the chart, then the feet.
    const r = this.root;
    r[0] = -c * k;
    r[1] = 0;
    r[2] = s * k;
    r[3] = 0;
    r[4] = k;
    r[5] = 0;
    r[6] = -s * k;
    r[7] = 0;
    r[8] = -c * k;
    r[9] = p[0]!;
    r[10] = p[1]!;
    r[11] = p[2]!;
    const chart = this.gait.solve(r, this.ground, p[1]!);
    // The lower sole's gap to the ground under it (before the arms: they do not touch the legs).
    let gap = Infinity;
    for (const ch of this.kind.legs!.chains) {
      const u = ch.end * 12;
      gap = Math.min(gap, chart[u + 10]! - this.restAnkle - this.ground.heightAt(chart[u + 9]!, chart[u + 11]!));
    }
    this.footGap = gap;
    this.acts.aim(this.gait, r);
    return chart;
  }

  /**
   * The arms' reaches, after `pose` (their targets set from the posed trunk), then the ponytail lagging behind the
   * motion. Its motion is kept in the world's frame (the chart's frame at the feet times the root), which does not
   * jump when the walker moves to a new chart.
   */
  reach(): void {
    this.acts.reach(this.gait, this.root);
    const w = this.walker;
    if (!w) return;
    const p = this.at;
    const f = w.chart.frameAt(p[0]!, p[1]!, p[2]!, this.frame);
    const r = this.root, m = this.motion;
    for (let col = 0; col < 3; col++) {
      const x = r[col * 3]!, y = r[col * 3 + 1]!, z = r[col * 3 + 2]!;
      for (let i = 0; i < 3; i++) m[col * 3 + i] = f[i]! * x + f[3 + i]! * y + f[6 + i]! * z;
    }
    m[9] = f[9]!;
    m[10] = f[10]!;
    m[11] = f[11]!;
    this.lagAngle = this.gait.applyLag(r, m);
  }

  /** The chart bones stood on the sphere with the chart's frame at the feet, for the render origin `origin`. */
  toRender(w: ChartWalker, origin: readonly [number, number, number]): Float64Array {
    const p = this.at;
    const f = w.chart.frameAt(p[0]!, p[1]!, p[2]!, this.frame, origin);
    toRender(this.gait.world, this.kind.skeleton.count, p, f, this.bones);
    return this.bones;
  }

  /** Poses the figure where the walker is drawn and writes its bones for the render origin `origin`. */
  solve(w: ChartWalker, origin: readonly [number, number, number]): Float64Array {
    w.renderChartPosition(this.at);
    this.pose(w, this.at, w.renderYaw());
    this.reach();
    return this.toRender(w, origin);
  }
}

/** Chart transforms (12 numbers each) → render: the frame `f` at the chart point `p` times the transform less `p`. */
function toRender(chart: ArrayLike<number>, n: number, p: ArrayLike<number>, f: ArrayLike<number>, out: Float64Array): void {
  for (let b = 0; b < n; b++) {
    const o = b * 12;
    for (let col = 0; col < 4; col++) {
      const x = chart[o + col * 3]! - (col === 3 ? p[0]! : 0);
      const y = chart[o + col * 3 + 1]! - (col === 3 ? p[1]! : 0);
      const z = chart[o + col * 3 + 2]! - (col === 3 ? p[2]! : 0);
      for (let i = 0; i < 3; i++) out[o + col * 3 + i] = f[i]! * x + f[3 + i]! * y + f[6 + i]! * z + (col === 3 ? f[9 + i]! : 0);
    }
  }
}

/** Who holds a thing and at which socket. */
interface Hold {
  body: WalkBody;
  socket: string;
}

/** A thing held at a socket of a figure, moved to another socket (of the same figure or the other) over a time window. */
class Held {
  from: Hold;
  to: Hold;
  readonly blend = new SocketBlend();

  constructor(at: Hold) {
    this.from = at;
    this.to = at;
    this.blend.fade.set(1);
  }

  /** Moves to `socket` of `body` over `seconds`, from where it is held now. */
  move(body: WalkBody, socket: string, seconds: number): void {
    // A move asked before the last one ended starts from the last one's end.
    this.from = this.to;
    this.to = { body, socket };
    this.blend.fade.set(0);
    this.blend.to(1, seconds);
  }

  get settled(): boolean {
    return this.blend.fade.done;
  }

  update(dt: number): void {
    this.blend.update(dt);
  }

  write(out: Float64Array): Float64Array {
    const a = this.from, b = this.to;
    return this.blend.write(a.body.chartBones, socketOf(a), b.body.chartBones, socketOf(b), out);
  }
}

function socketOf(h: Hold): Socket {
  const s = h.body.kind.sockets?.[h.socket];
  if (!s) throw new Error(`figure: no socket ${h.socket}`);
  return s;
}

/** Where the second figure stands: from the start's feet and the way the walker faces there (both world). */
export function meetPlace(feet: readonly number[], toward: readonly number[], center: readonly number[]): { dir: [number, number, number]; facing: [number, number, number] } {
  // Up at the start, and the facing and the right in its horizon.
  const ux = feet[0]! - center[0]!, uy = feet[1]! - center[1]!, uz = feet[2]! - center[2]!;
  const ul = Math.hypot(ux, uy, uz);
  const up = [ux / ul, uy / ul, uz / ul];
  const k = toward[0]! * up[0]! + toward[1]! * up[1]! + toward[2]! * up[2]!;
  let fx = toward[0]! - up[0]! * k, fy = toward[1]! - up[1]! * k, fz = toward[2]! - up[2]! * k;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // Right = forward × up.
  const rx = fy * up[2]! - fz * up[1]!, ry = fz * up[0]! - fx * up[2]!, rz = fx * up[1]! - fy * up[0]!;
  // 3.2 m ahead, 0.9 m to the right: in reach of the acts from the start, beside the way ahead.
  const px = feet[0]! + fx * 3.2 + rx * 0.9 - center[0]!, py = feet[1]! + fy * 3.2 + ry * 0.9 - center[1]!, pz = feet[2]! + fz * 3.2 + rz * 0.9 - center[2]!;
  const pl = Math.hypot(px, py, pz);
  // It faces back toward the start, a little to the side.
  return { dir: [px / pl, py / pl, pz / pl], facing: [-fx * 0.9 - rx * 0.44, -fy * 0.9 - ry * 0.44, -fz * 0.9 - rz * 0.44] };
}

/** A step of the meeting. */
type MeetPhase = 'approach' | 'face' | 'wave' | 'reach' | 'hold' | 'release';
/** A step of the reading. */
type ReadPhase = 'fetch' | 'lift' | 'open' | 'reading' | 'close' | 'lower' | 'stow';
/** The acts a page or a script asks for. */
export type WalkActName = 'wave' | 'greet' | 'give' | 'read' | 'sit';

const MEET_SECONDS: Record<MeetPhase, number> = { approach: 4, face: 0.7, wave: 4 * WAVE_S + 0.3, reach: 1.0, hold: 0.35, release: 0.9 };
const READ_SECONDS: Record<ReadPhase, number> = { fetch: 0.55, lift: 0.75, open: 0.6, reading: Infinity, close: 0.45, lower: 0.65, stow: 0.45 };

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Points in a transform's frame: x, y, z → the transform's frame. */
function point(m: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array): Float64Array {
  for (let i = 0; i < 3; i++) out[i] = m[i]! * x + m[3 + i]! * y + m[6 + i]! * z + m[9 + i]!;
  return out;
}

/** The two figures of the walk, the things they hold and the acts. */
export class WalkScene {
  readonly hero: WalkBody;
  readonly other: WalkBody;
  /** Where the second figure stands (a unit direction from the centre) and the way it faces (a world direction). */
  readonly otherDir: [number, number, number];
  readonly otherFacing: [number, number, number];
  /** The box, the book. */
  readonly box: Held;
  readonly book: Held;
  /** How far the book is open, radians. */
  hinge = 0;
  /** The box, the book's back half and front half in the chart after `pose` (12 numbers each). */
  readonly props = new Float64Array(36);
  /** The same for drawing (less the render origin), after `toRender`. */
  readonly propsRender = new Float64Array(36);
  /** Whether the props are drawn: the book only out of its pocket. */
  bookOut = false;
  meet: { phase: MeetPhase; t: number; greet: boolean; give: boolean } | null = null;
  read: { phase: ReadPhase; t: number } | null = null;
  /** The figures have greeted. */
  greeted = false;
  /** The last act's answer (shown in the HUD). */
  note = '';
  private readonly center: readonly [number, number, number];
  private readonly radiusAt: (x: number, y: number, z: number) => number;
  private readonly otherAt = new Float64Array(3);
  private readonly heroAt = new Float64Array(3);
  private otherYaw = 0;
  private readonly otherTurn = new WeightFade(0);
  private readonly meetPoint = new Float64Array(3);
  private readonly t3 = new Float64Array(3);
  private readonly m12 = new Float64Array(12);
  private readonly frame = new Float64Array(12);
  private readonly a: AimAngles = { yaw: 0, pitch: 0, goalYaw: 0, goalPitch: 0, faceYaw: 0, facePitch: 0 };
  /** Largest turn of either gaze past its limits seen so far, radians (0: always within). */
  gazeOver = 0;

  constructor(o: { center: readonly [number, number, number]; radiusAt: (x: number, y: number, z: number) => number; place: { dir: [number, number, number]; facing: [number, number, number] }; profile?: MoveProfile }) {
    this.center = o.center;
    this.radiusAt = o.radiusAt;
    this.hero = new WalkBody(0.37, o.profile ?? MOVE_PROFILES.default);
    // The other is of a heavier build: a deeper lean, a slower ponytail.
    this.other = new WalkBody(0.71, MOVE_PROFILES.heavy);
    this.otherDir = o.place.dir;
    this.otherFacing = o.place.facing;
    this.box = new Held({ body: this.hero, socket: 'handR' });
    this.book = new Held({ body: this.hero, socket: 'pocket' });
  }

  /** The second figure's feet in the world. */
  otherFeet(out: Vec3 = [0, 0, 0]): Vec3 {
    const d = this.otherDir;
    const r = this.radiusAt(d[0], d[1], d[2]);
    const c = this.center;
    out[0] = c[0] + d[0] * r;
    out[1] = c[1] + d[1] * r;
    out[2] = c[2] + d[2] * r;
    return out;
  }

  /** Adds the second figure to a new chart's collision world (the walker's `onRechart`; the walker may still be in its constructor). */
  attach(chart: SurfaceChart, world: CollisionWorld): void {
    const p = this.t3;
    const f = this.otherFeet();
    chart.fromWorld(f[0], f[1], f[2], p);
    if (Math.hypot(p[0]!, p[2]!) > 1024) return;
    world.addCylinder(p[0]!, p[2]!, OTHER_SOLID_M, p[1]! - 0.2, p[1]! + FIGURE_HEIGHT_M, { standable: false });
  }

  /** Starts over at the walker's place (after a teleport). */
  reset(w: ChartWalker): void {
    this.hero.reset(w);
    this.other.reset(w);
    this.meet = null;
    this.read = null;
    this.hero.gait.setSeated(false);
    this.otherTurn.set(0);
  }

  /** Distance from the walker's feet to the second figure's along the ground, m. */
  distance(w: ChartWalker): number {
    const p = this.t3;
    w.toChart(this.otherFeet(), p, Infinity);
    w.renderChartPosition(this.heroAt);
    return Math.hypot(p[0]! - this.heroAt[0]!, p[2]! - this.heroAt[2]!);
  }

  /** Asks for an act; returns what came of it (also kept in `note`). */
  act(name: WalkActName, w: ChartWalker): string {
    const g = this.hero.gait;
    const seated = g.seatedWeight > 0 || g.getSeated();
    let r: string;
    if (name === 'wave') {
      g.wave();
      r = 'waving';
    } else if (name === 'sit') {
      if (g.getSeated()) (g.setSeated(false), (r = 'standing up'));
      else if (this.meet) r = 'not now: meeting';
      else if (g.state !== 'stand' || g.speed > 0.2) r = 'stand still to sit';
      else (g.setSeated(true), (r = 'sitting down'));
    } else if (name === 'read') {
      if (this.read && (this.read.phase === 'close' || this.read.phase === 'lower' || this.read.phase === 'stow')) r = 'putting the book away';
      else if (this.read) (this.putAway(), (r = 'putting the book away'));
      else if (this.meet) r = 'not now: meeting';
      else (this.startRead(), (r = 'taking the book out'));
    } else {
      const d = this.distance(w);
      if (this.meet) r = 'already meeting';
      else if (this.read) r = 'hands busy: put the book away first';
      else if (seated) r = 'stand up first';
      else if (d > MEET_RANGE_M) r = `too far (${d.toFixed(1)} m; within ${MEET_RANGE_M} m)`;
      else {
        const greet = name === 'greet';
        this.meet = { phase: 'approach', t: 0, greet, give: !greet };
        r = greet ? 'greeting' : this.box.to.body === this.hero ? 'giving the box' : 'asking for the box back';
      }
    }
    this.note = r;
    return r;
  }

  /** The key E: greets and gives the first time, gives (back) later. */
  meetKey(w: ChartWalker): string {
    const r = this.act(this.greeted ? 'give' : 'greet', w);
    if (this.meet && !this.greeted) this.meet.give = true;
    return r;
  }

  private startRead(): void {
    this.read = { phase: 'fetch', t: 0 };
    const h = this.hero;
    if (this.box.to.body === h && this.box.to.socket === 'handR') this.box.move(h, 'belt', 0.35);
    h.acts.right!.on(0.45);
    this.bookOut = true;
  }

  private putAway(): void {
    if (!this.read) return;
    this.read = { phase: 'close', t: 0 };
  }

  /**
   * Before the walker's step: changes the intent from the keys (`moving`: a key that moves is held) while an act
   * needs it: walks the walker to the other figure, holds it still while seated or meeting, stands it up on a key.
   */
  steer(w: ChartWalker, intent: WalkIntent, moving: boolean, running: boolean, jumping: boolean): void {
    const g = this.hero.gait;
    if (moving && g.getSeated()) g.setSeated(false);
    if (this.read && (running || jumping) && this.read.phase !== 'close' && this.read.phase !== 'lower' && this.read.phase !== 'stow') this.putAway();
    if (this.meet && moving) this.endMeet();
    if (this.meet) {
      intent.moveX = 0;
      intent.moveZ = 0;
      intent.run = false;
      intent.jump = false;
      if (this.meet.phase === 'approach') {
        const p = this.t3;
        w.toChart(this.otherFeet(), p, Infinity);
        w.renderChartPosition(this.heroAt);
        const dx = p[0]! - this.heroAt[0]!, dz = p[2]! - this.heroAt[2]!;
        const d = Math.hypot(dx, dz);
        const left = d - MEET_M;
        if (Math.abs(left) > 0.04 && d > 1e-6) {
          const s = Math.min(1, Math.max(0.25, Math.abs(left))) * Math.sign(left);
          intent.moveX = (dx / d) * s;
          intent.moveZ = (dz / d) * s;
        }
      }
    } else if (g.seatedWeight > 0 || g.getSeated()) {
      intent.moveX = 0;
      intent.moveZ = 0;
      intent.run = false;
      intent.jump = false;
    }
  }

  private endMeet(): void {
    for (const b of [this.hero, this.other]) {
      b.acts.right!.off(0.4);
      b.gait.setHand(HAND.none);
      b.gait.setWaving(false);
    }
    this.hero.face.to(0, 0.4);
    if (this.box.to.socket === 'handL') this.box.move(this.box.to.body, 'handR', 0.35);
    this.meet = null;
  }

  /** After the walker's step: the figures' motion and the acts advance by `dt`. */
  update(dt: number, w: ChartWalker): void {
    const h = this.hero, o = this.other;
    h.update(dt, w);
    o.updateStanding(dt);
    this.otherTurn.update(dt);
    this.box.update(dt);
    this.book.update(dt);
    const d = this.distance(w);
    if (this.meet) this.stepMeet(dt, w);
    if (this.read) this.stepRead(dt);
    // The gazes: at each other within range (the book or the hands take over).
    const near = d < GAZE_RANGE_M;
    const heroLooks = near || !!this.meet || (!!this.read && this.read.phase !== 'stow');
    if (heroLooks) h.acts.gaze!.on(0.6);
    else h.acts.gaze!.off(0.8);
    if (near || this.meet) o.acts.gaze!.on(0.6);
    else o.acts.gaze!.off(0.8);
    // A walker that walks off turns back to its own heading.
    if (!this.meet && h.face.goal > 0 && this.hero.gait.speed > 0.3) h.face.to(0, 0.4);
  }

  private stepMeet(dt: number, w: ChartWalker): void {
    const m = this.meet!;
    const h = this.hero, o = this.other;
    m.t += dt;
    const next = (p: MeetPhase): void => {
      m.phase = p;
      m.t = 0;
    };
    switch (m.phase) {
      case 'approach': {
        const left = this.distance(w) - MEET_M;
        const still = h.gait.speed < 0.05 && m.t > 0.3;
        if (Math.abs(left) <= 0.05 || m.t >= MEET_SECONDS.approach || (still && Math.abs(left) < 0.4)) {
          next('face');
          h.face.to(1, 0.5);
          this.otherTurn.set(0);
          this.otherTurn.to(1, 0.6);
        }
        break;
      }
      case 'face':
        if (m.t >= MEET_SECONDS.face) {
          if (m.greet) {
            next('wave');
            h.gait.wave();
            o.gait.wave();
            // The waving hand is the right one: the box goes to the left for the greeting.
            if (this.box.to.socket === 'handR') this.box.move(this.box.to.body, 'handL', 0.4);
          } else {
            this.startGive();
            next('reach');
          }
        }
        break;
      case 'wave':
        if (m.t >= MEET_SECONDS.wave) {
          this.greeted = true;
          if (m.give) {
            this.startGive();
            next('reach');
          } else {
            if (this.box.to.socket === 'handL') this.box.move(this.box.to.body, 'handR', 0.35);
            this.meet = null;
          }
        }
        break;
      case 'reach':
        if (m.t >= MEET_SECONDS.reach) {
          // The mark: both hands at the meeting point; the box passes.
          const to = this.box.to.body === h ? o : h;
          this.box.move(to, 'handR', 0.25);
          next('hold');
        }
        break;
      case 'hold':
        if (m.t >= MEET_SECONDS.hold) {
          for (const b of [h, o]) {
            b.acts.right!.off(0.7);
            b.gait.setHand(HAND.none);
          }
          next('release');
        }
        break;
      case 'release':
        if (m.t >= MEET_SECONDS.release) this.meet = null;
        break;
    }
  }

  private startGive(): void {
    const h = this.hero, o = this.other;
    const giver = this.box.to.body === h ? h : o;
    const taker = giver === h ? o : h;
    if (this.box.to.socket === 'handL') this.box.move(giver, 'handR', 0.35);
    giver.gait.setHand(HAND.offer);
    taker.gait.setHand(HAND.take);
    h.acts.right!.on(0.8);
    o.acts.right!.on(0.8);
  }

  private stepRead(dt: number): void {
    const r = this.read!;
    const h = this.hero;
    r.t += dt;
    const done = r.t >= READ_SECONDS[r.phase];
    const next = (p: ReadPhase): void => {
      r.phase = p;
      r.t = 0;
    };
    switch (r.phase) {
      case 'fetch':
        if (done) {
          this.book.move(h, 'handR', 0.15);
          h.gait.setReading(true);
          h.acts.left!.on(0.6);
          next('lift');
        }
        break;
      case 'lift':
        if (done) {
          this.book.move(h, 'read', 0.3);
          next('open');
        }
        break;
      case 'open':
        this.hinge = BOOK_OPEN * smooth(r.t / READ_SECONDS.open);
        if (done) next('reading');
        break;
      case 'reading':
        this.hinge = BOOK_OPEN;
        break;
      case 'close':
        this.hinge = BOOK_OPEN * (1 - smooth(r.t / READ_SECONDS.close));
        if (done) {
          this.hinge = 0;
          this.book.move(h, 'handR', 0.25);
          h.acts.left!.off(0.45);
          h.gait.setReading(false);
          next('lower');
        }
        break;
      case 'lower':
        if (done) {
          this.book.move(h, 'pocket', 0.15);
          h.acts.right!.off(0.45);
          if (this.box.to.body === h && this.box.to.socket === 'belt') this.box.move(h, 'handR', 0.35);
          next('stow');
        }
        break;
      case 'stow':
        if (done) {
          this.read = null;
          this.bookOut = false;
        }
        break;
    }
  }

  /**
   * Poses both figures in the walker's chart (the walker's where it is drawn), the gazes and reaches on their targets,
   * and the props at their sockets. Then `toRender`.
   */
  pose(w: ChartWalker): void {
    const h = this.hero, o = this.other;
    const hp = w.renderChartPosition(this.heroAt);
    const op = this.otherAt;
    w.toChart(this.otherFeet(), op, Infinity);
    op[1] = w.world.groundAt(op[0]!, op[2]!, op[1]! + 0.5, w.setup.maxStepUp);
    // The second figure's heading: its own facing, or (meeting) toward the walker.
    const f = w.chart.vectorFromWorld(op[0]!, op[2]!, this.otherFacing[0], this.otherFacing[1], this.otherFacing[2], this.t3);
    this.otherYaw = Math.atan2(-f[0]!, -f[2]!);
    const dx = hp[0]! - op[0]!, dz = hp[2]! - op[2]!;
    // A figure faces (−sin yaw, −cos yaw): the second one toward the walker, the walker toward it.
    o.faceYaw = Math.atan2(-dx, -dz);
    o.face.set(this.otherTurn.value);
    h.faceYaw = Math.atan2(dx, dz);
    // The meeting point: halfway, at chest height.
    const mp = this.meetPoint;
    mp[0] = (hp[0]! + op[0]!) / 2;
    mp[1] = (hp[1]! + op[1]!) / 2 + MEET_HANDS_M;
    mp[2] = (hp[2]! + op[2]!) / 2;
    // The gazes' targets: the other's eyes, or the hands, or the book (set after the trunk is posed).
    const m = this.meet;
    const atHands = !!m && (m.phase === 'reach' || m.phase === 'hold');
    if (atHands) {
      // Halfway between the hands and the other's eyes: a glance down at the box, not a bow.
      h.acts.gaze!.setTarget((mp[0]! + op[0]!) / 2, (mp[1]! + op[1]! + EYES_M) / 2, (mp[2]! + op[2]!) / 2);
      o.acts.gaze!.setTarget((mp[0]! + hp[0]!) / 2, (mp[1]! + hp[1]! + EYES_M) / 2, (mp[2]! + hp[2]!) / 2);
    } else {
      h.acts.gaze!.setTarget(op[0]!, op[1]! + EYES_M, op[2]!);
      o.acts.gaze!.setTarget(hp[0]!, hp[1]! + EYES_M, hp[2]!);
    }
    const reading = this.read && this.read.phase !== 'fetch' && this.read.phase !== 'stow';
    if (reading) {
      // The book's place from the trunk as the last frame posed it: the gaze moves the trunk, the book moves with it.
      h.acts.socket(h.chartBones, 'read', this.m12);
      h.acts.gaze!.setTarget(this.m12[9]!, this.m12[10]!, this.m12[11]!);
    }
    h.pose(w, hp, w.renderYaw());
    o.pose(w, op, this.otherYaw);
    // The arms' targets from the posed trunks.
    for (const b of [h, o]) b.acts.right!.setTarget(mp[0]!, mp[1]!, mp[2]!);
    if (this.read) {
      const r = this.read;
      const pocket = h.acts.socket(h.chartBones, 'pocket', this.m12);
      const px = pocket[9]!, py = pocket[10]!, pz = pocket[11]!;
      const read = h.acts.socket(h.chartBones, 'read', this.m12);
      const left = point(read, 0.15, -0.02, 0.0, new Float64Array(3));
      const right = point(read, -0.15, -0.02, 0.0, this.t3);
      h.acts.left!.setTarget(left[0]!, left[1]!, left[2]!);
      // The right hand: to the pocket, up to the book's edge, back down to the pocket.
      const k = r.phase === 'fetch' ? 0 : r.phase === 'lift' ? smooth(r.t / READ_SECONDS.lift) : r.phase === 'lower' ? 1 - smooth(r.t / READ_SECONDS.lower) : r.phase === 'stow' ? 0 : 1;
      h.acts.right!.setTarget(px + (right[0]! - px) * k, py + (right[1]! - py) * k, pz + (right[2]! - pz) * k);
    }
    h.reach();
    o.reach();
    // The gazes within their limits (for the checks).
    for (const b of [h, o]) {
      if (b.acts.gaze!.weight <= 0) continue;
      const c = b.kind.gaze!;
      aimAngles(b.chartBones, b.root, c, b.acts.gaze!.target, this.a);
      const over = Math.max(Math.abs(this.a.faceYaw) - c.maxYaw, this.a.facePitch - c.maxUp, -this.a.facePitch - c.maxDown);
      this.gazeOver = Math.max(this.gazeOver, over);
    }
    // The props.
    const props = this.props;
    const box = this.box.write(this.m12);
    props.set(box, 0);
    const book = this.book.write(this.m12);
    props.set(book, 12);
    // The front half turns about the spine's line on the reader's side.
    const a = this.hinge, c = Math.cos(a), s = Math.sin(a);
    // H = T(0, 0, zh) · Ry(a) · T(0, 0, −zh) with zh = −BOOK_HINGE_Z; front = book · H.
    const zh = -BOOK_HINGE_Z;
    const hm = [c, 0, -s, 0, 1, 0, s, 0, c, -s * zh, 0, zh - c * zh];
    for (let col = 0; col < 4; col++) {
      for (let i = 0; i < 3; i++) {
        props[24 + col * 3 + i] = book[i]! * hm[col * 3]! + book[3 + i]! * hm[col * 3 + 1]! + book[6 + i]! * hm[col * 3 + 2]! + (col === 3 ? book[9 + i]! : 0);
      }
    }
  }

  /** The figures and the props for the render origin `origin` (the props stood with the walker's frame). */
  toRender(w: ChartWalker, origin: readonly [number, number, number]): void {
    this.hero.toRender(w, origin);
    this.other.toRender(w, origin);
    const p = this.heroAt;
    const f = w.chart.frameAt(p[0]!, p[1]!, p[2]!, this.frame, origin);
    toRender(this.props, 3, p, f, this.propsRender);
  }

  /** The state of the acts for a script. */
  report(w: ChartWalker): Record<string, unknown> {
    const h = this.hero, o = this.other;
    const g = h.gait.graph;
    const holder = (x: Held): string => `${x.to.body === h ? 'walker' : 'other'}.${x.to.socket}`;
    return {
      meet: this.meet ? { phase: this.meet.phase, t: this.meet.t } : null,
      read: this.read ? { phase: this.read.phase, t: this.read.t } : null,
      greeted: this.greeted,
      seated: h.gait.getSeated(),
      body: h.gait.state,
      layers: { read: g.state('read'), hand: g.state('hand'), wave: g.state('wave') },
      box: holder(this.box),
      book: holder(this.book),
      hinge: this.hinge,
      otherM: this.distance(w),
      gaze: { walker: h.acts.gaze!.weight, other: o.acts.gaze!.weight, overDeg: (this.gazeOver * 180) / Math.PI },
      reach: { walkerRight: h.acts.right!.weight, walkerLeft: h.acts.left!.weight, otherRight: o.acts.right!.weight, leftM: { walker: h.acts.right!.left, other: o.acts.right!.left } },
      note: this.note,
    };
  }

  /** True while an act plays or a weight, a turn or a held thing is still moving. */
  get busy(): boolean {
    const h = this.hero, o = this.other;
    const fades = [h.face, h.acts.gaze!.fade, o.acts.gaze!.fade, h.acts.right!.fade, h.acts.left!.fade, o.acts.right!.fade, this.otherTurn, this.box.blend.fade, this.book.blend.fade];
    const layers = ['read', 'hand', 'wave'].some((l) => h.gait.graph.state(l) !== 'off' || o.gait.graph.state(l) !== 'off');
    return !!this.meet || !!this.read || h.gait.seatedWeight > 0 || layers || fades.some((f) => !f.done);
  }

  /** The point the hands meet at, in the chart (after `pose`). */
  get meetingPoint(): Float64Array {
    return this.meetPoint;
  }
}
