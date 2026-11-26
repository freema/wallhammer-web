// A four-legged figure moved by a controller: the legs stepped by the engine's `StepCycle`, the rest of the body by a
// `MotionGraph` in step with it. The kind gives its legs and their patterns (`SteedKind.steps`, steed.ts).
//
// A frame: `update(dt, …)` advances the step cycle under the root (its place, heading and velocity on the ground) and
// the graph (stand on the clock; walk, trot and gallop blended by the ground speed and driven by the passes of the
// cycle, so the trunk's rhythm keeps step with the footfalls). `solve()` then poses the body:
//
//   1. the graph's pose (trunk, neck, head, feathers, tail)
//   2. the trunk lowered onto the ground under the hooves (`supportHeight`) and tilted with it (`pitch`, `roll`)
//   3. every swinging leg folded at the knee (hock), over its `swingFold` share of the swing; at a gallop (the
//      patterns' `stretch` share) only within its `foldIn` share, so the fore legs reach out straight and the hind legs
//      trail straight. A leg with a `pastern` folds the fetlock with it in the swing (the hoof following) and gives at
//      the fetlock under the weight in the stance, most when the hoof is under its pivot; a leg with a `blade` turns
//      its shoulder blade by a share of the leg's angle forward or back. Then `solvePose`
//   4. the trunk lowered further when a planted hoof would be left beyond its leg's reach (a natural dip at the ends
//      of a stance; it comes back up over `RISE_S`), solved again
//   5. a `TwoBoneReach` per leg puts the fetlock on the cycle's target, the elbow (stifle) turned toward its pole; a
//      swinging leg's target is moved by its `reach` lobes at a gallop (beyond the path, fullest at each lobe's `at`)
//   6. every hoof kept level with the ground's plane (flicked back in its swing; behind a pastern it follows the
//      pastern's fold instead, by as much as the leg is folded), its heel raised as the leg trails (`heel`)
//   7. the head turned toward a point (`look`, an eased `ChainAim`), the tail lagging behind the motion (`ChainLag`)
//
// A leg whose chain ends at a toe (a bone below its hoof: `chain.end` is not `hoof`) stands on that toe: the hoof's
// turn is chosen first (the ground's plane, the heel's rise), the hoof's joint is reached to the toe's target less
// the toe's place under that turn, then the hoof takes the turn, so the toe stays on its target while the heel lifts.
// For such a leg the dip, the reach and the swing's limit work on the hoof's joint.
//
// Everything is a function of the calls: the same calls give the same bits. Nothing is allocated per frame.

import { ChainAim, ChainLag, MotionGraph, MotionGraphDef, Pose, StepCycle, TwoBoneReach, solvePose, solvePoseBelow, speedWeights } from 'wallhammer-web/motion';
import type { FigureInput } from './kind.ts';
import type { SteedKind, SteedLeg, SteedLife } from './steed.ts';

/** Seconds over which the extra dip of the trunk (step 4) eases back up. */
const RISE_S = 0.12;
/** Share of a leg's length a planted hoof is kept within by the dip. */
const REACH_SHARE = 0.975;
/**
 * Share of a leg's length `reachBelow` plans a hoof below its pivot within: less than `REACH_SHARE`, so a leg whose
 * shoulder blade or fetlock moves within the frame still has the room.
 */
const BELOW_SHARE = 0.955;
/** Most the trunk dips for a planted hoof, m. */
const MAX_DIP_M = 0.3;
/** Time constant of the smoothed ground speed that blends the trunk's motions, s. */
const SPEED_SMOOTH_S = 0.2;
/** How fast the effort rises while the animal works and falls while it rests, s (time constants). */
const EFFORT_RISE_S = 3, EFFORT_FALL_S = 8;
/** Breaths a second rested and after a long gallop. */
const BREATH_REST_HZ = 0.3, BREATH_HARD_HZ = 2.4;
/** Share of a leg's rest length a swinging end is kept within. */
const SWING_REACH = 0.985;
/** Angle of a planted leg from under its pivot (rad) beyond which its fetlock no longer gives. */
const GIVE_SPAN = 0.46;
/** Share of a planted leg's rest length up to which its fetlock gives fully, and from which it does not give. */
const GIVE_FULL = 0.9;
const GIVE_STRAIGHT = 0.95;
/** The fetlock's give at a full stretch (the gallop) against the walk's. */
const GIVE_STRETCH = 1.5;

export interface QuadGaitOptions {
  /** 0–1, shifts the idle rhythms. Default 0. */
  seed?: number;
}

const M = new Float64Array(9);
const D = new Float64Array(9);
const L = new Float64Array(9);
const W = new Float64Array(9);
const Q = new Float64Array(4);

/** Sets bone `b`'s turn in `rot` to `a` radians about its x. */
function setTurnX(rot: Float32Array, b: number, a: number): void {
  const h = 0.5 * a, q = b * 4;
  rot[q] = Math.sin(h);
  rot[q + 1] = 0;
  rot[q + 2] = 0;
  rot[q + 3] = Math.cos(h);
}
const WEIGHTS: { [i: number]: number } = {};

/** How far a swing at `u` (0–1) is into a lobe from `from` to `to`, fullest at `at`: 0 outside, smooth. */
function lobe(u: number, from: number, at: number, to: number): number {
  if (!(u > from && u < to)) return 0;
  const x = u < at ? (0.5 * Math.PI * (u - from)) / (at - from) : (0.5 * Math.PI * (to - u)) / (to - at);
  const s = Math.sin(x);
  return s * s;
}

/** The heel's rise of a leg at the angle `a` from under its pivot (rad, + forward): 0 ahead of `from`, `lift` behind `to`. */
function heelOf(h: { readonly lift: number; readonly from: number; readonly to: number }, a: number): number {
  const x = (a - h.from) / (h.to - h.from);
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
  return h.lift * t;
}

/** Quaternion (x, y, z, w) of a 3 × 3 rotation (columns) into `Q`. */
function quatOf(m: Float64Array): void {
  const m00 = m[0]!, m11 = m[4]!, m22 = m[8]!;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    Q[3] = 0.25 * s;
    Q[0] = (m[5]! - m[7]!) / s;
    Q[1] = (m[6]! - m[2]!) / s;
    Q[2] = (m[1]! - m[3]!) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    Q[3] = (m[5]! - m[7]!) / s;
    Q[0] = 0.25 * s;
    Q[1] = (m[3]! + m[1]!) / s;
    Q[2] = (m[6]! + m[2]!) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    Q[3] = (m[6]! - m[2]!) / s;
    Q[0] = (m[3]! + m[1]!) / s;
    Q[1] = 0.25 * s;
    Q[2] = (m[7]! + m[5]!) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    Q[3] = (m[1]! - m[3]!) / s;
    Q[0] = (m[6]! + m[2]!) / s;
    Q[1] = (m[7]! + m[5]!) / s;
    Q[2] = 0.25 * s;
  }
}

/** The pose of one four-legged body, frame by frame. */
export class QuadGait {
  readonly kind: SteedKind;
  readonly graph: MotionGraph<FigureInput>;
  readonly pose: Pose;
  /** The bones as last solved (12 numbers per bone). */
  readonly world: Float64Array;
  /** The root of the last `update`: columns left, up, forward, then the ground under the middle of the body. */
  readonly root = new Float64Array(12);
  readonly cycle: StepCycle;
  readonly reaches: readonly TwoBoneReach[];
  /** The head's look at a point (`look`), eased in and out. */
  readonly gaze: ChainAim | null;
  readonly lags: readonly ChainLag[];
  /** Passes of the step cycle made so far (drives the moving motions). */
  passes = 0;
  /** Ground speed, smoothed, m/s. */
  speed = 0;
  /** Turn rate of the last update, rad/s (positive turns toward the left). */
  turn = 0;
  /** The extra dip of the trunk now (step 4), m. */
  dip = 0;
  /** Share of the legs' stretch and late fold of the last update (the patterns' `stretch` blended by speed), 0–1. */
  stretch = 0;
  /**
   * What the kind's `steps.life` reads (the face, the breath): the time since `reset`, the effort (it rises while the
   * animal goes faster than its trot, toward 1 at its gallop, and falls slowly afterwards), the breath's count (faster
   * with effort), the speed, the cycle's phase and the seed. Advanced by `update` only.
   */
  readonly life: SteedLife = { time: 0, effort: 0, breath: 0, speed: 0, phase: 0, seed: 0 };
  private readonly ranges: [number, number, number][];
  /** Per leg the end's target of this solve (the cycle's, moved by the reach lobes), 3 numbers per leg. */
  private readonly aims: Float64Array;
  /** Per leg the height of the pivot above the end in the rest pose, m. */
  private readonly heights: Float64Array;
  /** Per leg the chain's length (pivot → middle → end) in the rest pose, m. */
  private readonly lengths: Float64Array;
  /** Per leg the joint the reach puts on its aim: the chain's end, or the hoof of a leg that stands on a toe. */
  private readonly ends: Int32Array;
  /** Per leg standing on a toe: the toe's joint in the hoof's frame, m (3 numbers per leg). */
  private readonly toeOff: Float64Array;
  /** Per leg the angle from under its pivot toward its aim of this solve (`angleOf`), rad. */
  private readonly angles: Float64Array;
  /** Per leg the heel's rise of this solve (`SteedLeg.heel`), rad. */
  private readonly heels: Float64Array;
  /** Per leg standing on a toe: the toe's place from the hoof's joint under the hoof's turn of this solve, m (3 per leg). */
  private readonly toeVec: Float64Array;
  /** Share of the legs' fold of the last update (the patterns' `foldShare` blended by speed). */
  private foldScale = 1;
  /** The step cycle's own `reach` (from its homes), before `reachBelow` narrows it. */
  private readonly baseReach: number;
  private lastPhase = 0;
  private lastYaw = Number.NaN;
  private lagDt = 0;
  private dt = 0;
  private readonly heightAt: { fn: (x: number, z: number) => number };

  constructor(kind: SteedKind, o: QuadGaitOptions = {}) {
    this.kind = kind;
    const m = kind.motions;
    const def = new MotionGraphDef<FigureInput>({
      skeleton: kind.skeleton,
      params: { speed: 0, passes: 0 },
      layers: [
        {
          name: 'body',
          states: [
            { name: 'stand', source: m.stand! },
            { name: 'move', sources: [m.walk!, m.trot!, m.gallop!], by: 'speed', drive: { param: 'passes', per: 1 } },
          ],
          transitions: [
            { from: 'stand', to: 'move', seconds: 0.35, when: [{ param: 'speed', op: '>', value: 0.3 }] },
            { from: 'move', to: 'stand', seconds: 0.5, when: [{ param: 'speed', op: '<', value: 0.12 }] },
          ],
        },
      ],
    });
    this.graph = new MotionGraph(def, { seed: o.seed ?? 0, param: 0 });
    this.life.seed = o.seed ?? 0;
    this.pose = new Pose(kind.skeleton);
    this.world = new Float64Array(kind.skeleton.count * 12);
    const legs = kind.steps.legs;
    this.cycle = new StepCycle({ homes: legs.map((l) => l.home), patterns: kind.steps.patterns, endHeight: legs.map((l) => l.endHeight), tolerance: 0.05, minRate: kind.steps.minRate ?? 1.2 });
    this.ends = Int32Array.from(legs, (l) => (l.chain.end !== l.hoof ? l.hoof : l.chain.end));
    this.reaches = legs.map((l, i) => {
      const r = new TwoBoneReach(this.ends[i] === l.chain.end ? l.chain : { ...l.chain, end: this.ends[i]! }, { soft: 0.985 });
      r.usePole = true;
      r.fade.set(1);
      return r;
    });
    this.gaze = kind.gaze ? new ChainAim(kind.gaze) : null;
    this.lags = (kind.lag ?? []).map((c) => new ChainLag(kind.skeleton, c));
    this.ranges = kind.steps.patterns.map((p): [number, number, number] => [p.speed, p.speed, p.speed]);
    this.baseReach = this.cycle.reach;
    this.aims = new Float64Array(legs.length * 3);
    this.heights = new Float64Array(legs.length);
    this.lengths = new Float64Array(legs.length);
    this.toeOff = new Float64Array(legs.length * 3);
    this.angles = new Float64Array(legs.length);
    this.heels = new Float64Array(legs.length);
    this.toeVec = new Float64Array(legs.length * 3);
    {
      const rest = new Float64Array(kind.skeleton.count * 12);
      solvePose(kind.skeleton, new Pose(kind.skeleton), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], rest);
      const at = (b: number, c: number): number => Math.hypot(rest[b * 12 + 9]! - rest[c * 12 + 9]!, rest[b * 12 + 10]! - rest[c * 12 + 10]!, rest[b * 12 + 11]! - rest[c * 12 + 11]!);
      legs.forEach((l, i) => {
        this.heights[i] = rest[l.chain.upper * 12 + 10]! - rest[l.chain.end * 12 + 10]!;
        this.lengths[i] = at(l.chain.upper, l.chain.lower) + at(l.chain.lower, this.ends[i]!);
        if (this.ends[i] !== l.chain.end) for (let j = 0; j < 3; j++) this.toeOff[i * 3 + j] = rest[l.chain.end * 12 + 9 + j]! - rest[l.hoof * 12 + 9 + j]!;
      });
    }
    const flat = { fn: (_x: number, _z: number): number => 0 };
    this.heightAt = flat;
  }

  /** Starts over at the root's place: standing, every hoof at home on the ground of `heightAt`. */
  reset(x: number, y: number, z: number, yaw: number, heightAt: (x: number, z: number) => number): void {
    this.setRoot(x, y, z, yaw);
    this.graph.reset();
    this.cycle.reset(this.root, heightAt);
    this.heightAt.fn = heightAt;
    this.passes = 0;
    this.lastPhase = 0;
    this.speed = 0;
    this.turn = 0;
    this.dip = 0;
    this.stretch = 0;
    this.life.time = 0;
    this.life.effort = 0;
    this.life.breath = 0;
    this.life.speed = 0;
    this.life.phase = 0;
    this.foldScale = 1;
    this.lastYaw = yaw;
    this.lagDt = 0;
    this.dt = 0;
    for (const l of this.lags) l.reset();
  }

  /** The root at (x, y, z), heading `yaw` (it faces (−sin yaw, −cos yaw), as a walker's). */
  private setRoot(x: number, y: number, z: number, yaw: number): void {
    const c = Math.cos(yaw), s = Math.sin(yaw), r = this.root;
    r[0] = -c;
    r[1] = 0;
    r[2] = s;
    r[3] = 0;
    r[4] = 1;
    r[5] = 0;
    r[6] = -s;
    r[7] = 0;
    r[8] = -c;
    r[9] = x;
    r[10] = y;
    r[11] = z;
  }

  /**
   * Advances by `dt` seconds to the root at (x, y, z) heading `yaw`, moving at (vx, vz) m/s over the ground of
   * `heightAt`. The first call after `reset` (or a jump of the root) starts the cycle there.
   */
  update(dt: number, x: number, y: number, z: number, yaw: number, vx: number, vz: number, heightAt: (x: number, z: number) => number): void {
    this.setRoot(x, y, z, yaw);
    this.heightAt.fn = heightAt;
    if (!(dt > 0)) return;
    let dy = Number.isNaN(this.lastYaw) ? 0 : yaw - this.lastYaw;
    dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
    this.lastYaw = yaw;
    this.turn = dy / dt;
    this.dt = dt;
    const c = this.cycle;
    c.reach = this.reachBelow();
    c.update(dt, this.root, vx, vz, this.turn, heightAt);
    let d = c.phase - this.lastPhase;
    d -= Math.floor(d);
    this.lastPhase = c.phase;
    this.passes += d;
    const v = Math.hypot(vx, vz);
    this.speed += (v - this.speed) * (1 - Math.exp(-dt / SPEED_SMOOTH_S));
    // The stretch share as the cycle blends its patterns (at the ground speed, unsmoothed).
    speedWeights(this.ranges, v, WEIGHTS);
    let g = 0;
    const share = this.kind.steps.stretch;
    for (let i = 0; i < share.length; i++) g += (WEIGHTS[i] ?? 0) * share[i]!;
    this.stretch = g;
    const fs = this.kind.steps.foldShare;
    if (fs) {
      let h = 0;
      for (let i = 0; i < fs.length; i++) h += (WEIGHTS[i] ?? 0) * fs[i]!;
      this.foldScale = h;
    }
    const life = this.life, sp = this.kind.steps.speeds;
    const work = Math.min(1, Math.max(0, (this.speed - sp.trot) / (sp.gallop - sp.trot)));
    life.effort += (work - life.effort) * (1 - Math.exp(-dt / (work > life.effort ? EFFORT_RISE_S : EFFORT_FALL_S)));
    life.time += dt;
    life.breath += dt * (BREATH_REST_HZ + (BREATH_HARD_HZ - BREATH_REST_HZ) * life.effort);
    life.speed = this.speed;
    life.phase = c.phase;
    this.graph.setParam('speed', this.speed);
    this.graph.setParam('passes', this.passes);
    this.graph.update(dt);
    this.gaze?.update(dt);
    this.lagDt += dt;
  }

  /** Turns the head toward a point (eased in over `seconds`), or lets it go with null. */
  look(at: readonly [number, number, number] | null, seconds = 0.6): void {
    if (!this.gaze) return;
    if (at) {
      this.gaze.setTarget(at[0], at[1], at[2]);
      this.gaze.on(seconds);
    } else this.gaze.off(seconds);
  }

  /** Poses the body at the root of the last `update`; returns the bones. */
  solve(): Float64Array {
    const k = this.kind;
    const sk = k.skeleton;
    const pose = this.pose;
    const world = this.world;
    const root = this.root;
    const c = this.cycle;
    const legs = k.steps.legs;
    const trunk = k.steps.trunk;
    this.graph.evaluate(pose);
    k.steps.life?.(pose, this.life);
    // 2. The trunk onto the plane of the ground under the hooves.
    const pitch = c.started ? c.pitch : 0, roll = c.started ? c.roll : 0;
    const support = c.started ? c.supportHeight - root[10]! : 0;
    pose.offset[trunk * 3 + 1] = pose.offset[trunk * 3 + 1]! + support;
    {
      // Rx(−pitch) · Rz(roll) before the graph's turn of the trunk.
      const ha = -0.5 * pitch, hb = 0.5 * roll;
      const ax = Math.sin(ha), aw = Math.cos(ha), bz = Math.sin(hb), bw = Math.cos(hb);
      const sx = ax * bw, sy = -ax * bz, sz = aw * bz, sw = aw * bw;
      const r = pose.rot, q = trunk * 4;
      const gx = r[q]!, gy = r[q + 1]!, gz = r[q + 2]!, gw = r[q + 3]!;
      r[q] = sw * gx + sx * gw + sy * gz - sz * gy;
      r[q + 1] = sw * gy - sx * gz + sy * gw + sz * gx;
      r[q + 2] = sw * gz + sx * gy - sy * gx + sz * gw;
      r[q + 3] = sw * gw - sx * gx - sy * gy - sz * gz;
    }
    // The ends' targets: the cycle's, a swinging leg's moved beyond its path by its `reach` lobes at a gallop (forward
    // along the root's forward, up along the world's up).
    const g = this.stretch;
    const aims = this.aims;
    for (let i = 0; i < legs.length; i++) {
      aims[i * 3] = c.targets[i * 3]!;
      aims[i * 3 + 1] = c.targets[i * 3 + 1]!;
      aims[i * 3 + 2] = c.targets[i * 3 + 2]!;
      if (c.started && g > 0 && c.planted[i] !== 1) {
        const u = c.swing[i]!;
        for (const r of legs[i]!.reach) {
          const e = g * lobe(u, r.from, r.at, r.to);
          aims[i * 3] = aims[i * 3]! + e * r.d[0] * root[6]!;
          aims[i * 3 + 1] = aims[i * 3 + 1]! + e * r.d[1];
          aims[i * 3 + 2] = aims[i * 3 + 2]! + e * r.d[0] * root[8]!;
        }
      }
    }
    // Every leg's angle from under its pivot, its heel's rise; a leg standing on a toe aims its hoof's joint at the
    // toe's aim less the toe's place under the hoof's turn (the ground's plane and the heel's rise).
    const cp = Math.cos(-pitch), sp = Math.sin(-pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // Rx(−pitch) · Rz(roll) columns: (cr, cp·sr, sp·sr), (−sr, cp·cr, sp·cr), (0, −sp, cp).
    const P0 = cr, P1 = cp * sr, P2 = sp * sr, P3 = -sr, P4 = cp * cr, P5 = sp * cr, P6 = 0, P7 = -sp, P8 = cp;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i]!;
      const a = c.started ? this.angleOf(l, i) : 0;
      this.angles[i] = a;
      const h = l.heel && c.started ? heelOf(l.heel, a) : 0;
      this.heels[i] = h;
      if (this.ends[i] === l.chain.end) continue;
      // The toe's offset turned by Rx(h), by the plane, by the root.
      const ox = this.toeOff[i * 3]!, oy0 = this.toeOff[i * 3 + 1]!, oz0 = this.toeOff[i * 3 + 2]!;
      const ch = Math.cos(h), sh = Math.sin(h);
      const oy = oy0 * ch - oz0 * sh, oz = oy0 * sh + oz0 * ch;
      const px = P0 * ox + P3 * oy + P6 * oz, py = P1 * ox + P4 * oy + P7 * oz, pz = P2 * ox + P5 * oy + P8 * oz;
      for (let j = 0; j < 3; j++) {
        const v = root[j]! * px + root[3 + j]! * py + root[6 + j]! * pz;
        this.toeVec[i * 3 + j] = v;
        aims[i * 3 + j] = aims[i * 3 + j]! - v;
      }
    }
    // 3. Swinging legs fold at the knee (hock): over the swing, at a gallop only within `foldIn`. The fetlock folds
    // with it, or gives under the weight; the shoulder blade follows the leg.
    const walkSpeed = k.steps.speeds.walk;
    const load = (walkSpeed > 0 ? Math.min(1, this.speed / walkSpeed) : 1) * (1 + (GIVE_STRETCH - 1) * g);
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i]!;
      const swinging = c.started && c.planted[i] !== 1;
      const s = swinging ? this.foldOf(l, c.swing[i]!, g) : 0;
      const fs = this.foldScale;
      setTurnX(pose.rot, l.cannon, l.fold * s * fs);
      if (l.pastern === undefined && l.blade === undefined) continue;
      const a = this.angles[i]!;
      if (l.pastern !== undefined) {
        // The fetlock folds later than the carpus (by s²), so a leg reaching out is never longer than at rest.
        let f = l.flick * s * s * fs;
        if (!swinging && l.give !== undefined && Math.abs(a) < GIVE_SPAN) {
          // Less as the leg nears its full length (from the last solve: a giving fetlock shortens the leg).
          const p = l.chain.upper * 12;
          const dd = Math.hypot(aims[i * 3]! - world[p + 9]!, aims[i * 3 + 1]! - world[p + 10]!, aims[i * 3 + 2]! - world[p + 11]!) / this.lengths[i]!;
          const room = (GIVE_STRAIGHT - dd) / (GIVE_STRAIGHT - GIVE_FULL);
          const w = Math.cos((0.5 * Math.PI * a) / GIVE_SPAN) * (room > 1 ? 1 : room > 0 ? room : 0);
          f = -l.give * load * w * w;
        }
        setTurnX(pose.rot, l.pastern, f);
      }
      if (l.blade) setTurnX(pose.rot, l.blade.bone, -l.blade.share * a);
    }
    solvePose(sk, pose, root, world);
    // 4. The dip: how far the trunk must come down for every planted hoof to stay within its leg's reach.
    let need = 0;
    if (c.started) {
      for (let i = 0; i < legs.length; i++) {
        if (c.planted[i] !== 1) continue;
        const ch = legs[i]!.chain;
        // A leg standing on a toe: its hoof's joint and aim.
        const toe = this.ends[i] !== ch.end;
        const tg = toe ? aims : c.targets;
        const a = ch.upper * 12, b = ch.lower * 12, e = this.ends[i]! * 12;
        const len = Math.hypot(world[b + 9]! - world[a + 9]!, world[b + 10]! - world[a + 10]!, world[b + 11]! - world[a + 11]!) + Math.hypot(world[e + 9]! - world[b + 9]!, world[e + 10]! - world[b + 10]!, world[e + 11]! - world[b + 11]!);
        const R = REACH_SHARE * len;
        const hx = tg[i * 3]! - world[a + 9]!, hz = tg[i * 3 + 2]! - world[a + 11]!;
        const h2 = hx * hx + hz * hz;
        const v = world[a + 10]! - tg[i * 3 + 1]!;
        const n = h2 < R * R ? v - Math.sqrt(R * R - h2) : v;
        if (n > need) need = n;
      }
    }
    if (need > MAX_DIP_M) need = MAX_DIP_M;
    const eased = this.dip * Math.exp(-this.dt / RISE_S);
    this.dt = 0;
    this.dip = need > eased ? need : eased;
    if (this.dip > 1e-6) {
      pose.offset[trunk * 3 + 1] = pose.offset[trunk * 3 + 1]! - this.dip;
      solvePose(sk, pose, root, world);
    }
    // 5. The legs reach for the cycle's targets.
    if (c.started) {
      for (let i = 0; i < legs.length; i++) {
        const r = this.reaches[i]!, l = legs[i]!, p = l.pole;
        for (let j = 0; j < 3; j++) r.pole[j] = root[j]! * p[0] + root[3 + j]! * p[1] + root[6 + j]! * p[2] + root[9 + j]!;
        let tx = aims[i * 3]!, ty = aims[i * 3 + 1]!, tz = aims[i * 3 + 2]!;
        if (c.planted[i] !== 1 && l.liftClamp) {
          // A swinging end is not sent beyond the chain as it is folded now; one too far is raised toward the
          // pivot's height (the leg reaches out level rather than down), or at that height pulled in. A leg standing
          // on a toe is limited at its toe (the chain to the toe as posed, its aim the hoof's plus the toe's place).
          const a = l.chain.upper * 12, b = l.chain.lower * 12, e = l.chain.end * 12;
          const len = Math.hypot(world[b + 9]! - world[a + 9]!, world[b + 10]! - world[a + 10]!, world[b + 11]! - world[a + 11]!) + Math.hypot(world[e + 9]! - world[b + 9]!, world[e + 10]! - world[b + 10]!, world[e + 11]! - world[b + 11]!);
          const R = SWING_REACH * len;
          const toe = this.ends[i] !== l.chain.end;
          const vx = toe ? this.toeVec[i * 3]! : 0, vy = toe ? this.toeVec[i * 3 + 1]! : 0, vz = toe ? this.toeVec[i * 3 + 2]! : 0;
          tx += vx;
          ty += vy;
          tz += vz;
          const dx = tx - world[a + 9]!, dy = ty - world[a + 10]!, dz = tz - world[a + 11]!;
          if (Math.hypot(dx, dy, dz) > R) {
            const hh = Math.hypot(dx, dz);
            if (dy < 0 && hh < R) ty = world[a + 10]! - Math.sqrt(R * R - hh * hh);
            else {
              const f = R / Math.max(hh, 1e-9);
              tx = world[a + 9]! + dx * f;
              ty = world[a + 10]!;
              tz = world[a + 11]! + dz * f;
            }
          }
          tx -= vx;
          ty -= vy;
          tz -= vz;
        } else if (c.planted[i] !== 1) {
          // A swinging end is not sent beyond the leg's rest length (a folded fetlock may make the chain a little
          // longer than at rest; a straight leg stays as long as it is standing).
          const a = l.chain.upper * 12, R = SWING_REACH * this.lengths[i]!;
          const dx = tx - world[a + 9]!, dy = ty - world[a + 10]!, dz = tz - world[a + 11]!;
          const dd = Math.hypot(dx, dy, dz);
          if (dd > R) {
            const f = R / dd;
            tx = world[a + 9]! + dx * f;
            ty = world[a + 10]! + dy * f;
            tz = world[a + 11]! + dz * f;
          }
        }
        r.setTarget(tx, ty, tz);
        r.apply(sk, pose, root, world);
      }
    }
    // 6. Hooves level with the ground's plane, flicked back in the swing: local = parent⁻¹ · wanted.
    {
      // The ground's plane as a turn of the root (P0–P8 above, Rx(−pitch) · Rz(roll)), columns into D.
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i]!;
        const s = c.started && c.planted[i] !== 1 ? this.foldOf(l, c.swing[i]!, g) : 0;
        // Behind a pastern the hoof is level and follows the pastern's fold by `s`; else it is flicked by itself. The
        // heel's rise turns it the same way.
        const f = (l.pastern === undefined ? l.flick * s * this.foldScale : 0) + this.heels[i]!, cf = Math.cos(f), sf = Math.sin(f);
        // Plane · Rx(f), then the root's turn: wanted world axes into D.
        const A0 = P0, A1 = P1, A2 = P2;
        const B0 = P3 * cf + P6 * sf, B1 = P4 * cf + P7 * sf, B2 = P5 * cf + P8 * sf;
        const C0 = -P3 * sf + P6 * cf, C1 = -P4 * sf + P7 * cf, C2 = -P5 * sf + P8 * cf;
        W[0] = A0; W[1] = A1; W[2] = A2; W[3] = B0; W[4] = B1; W[5] = B2; W[6] = C0; W[7] = C1; W[8] = C2;
        for (let col = 0; col < 3; col++) {
          const x = W[col * 3]!, y = W[col * 3 + 1]!, z = W[col * 3 + 2]!;
          D[col * 3] = root[0]! * x + root[3]! * y + root[6]! * z;
          D[col * 3 + 1] = root[1]! * x + root[4]! * y + root[7]! * z;
          D[col * 3 + 2] = root[2]! * x + root[5]! * y + root[8]! * z;
        }
        const pu = (l.pastern ?? l.cannon) * 12;
        for (let col = 0; col < 3; col++) {
          const lx = Math.hypot(world[pu + col * 3]!, world[pu + col * 3 + 1]!, world[pu + col * 3 + 2]!) || 1;
          for (let row = 0; row < 3; row++) M[col * 3 + row] = world[pu + col * 3 + row]! / lx;
        }
        // L = Mᵀ · D.
        for (let col = 0; col < 3; col++)
          for (let row = 0; row < 3; row++) L[col * 3 + row] = M[row * 3]! * D[col * 3]! + M[row * 3 + 1]! * D[col * 3 + 1]! + M[row * 3 + 2]! * D[col * 3 + 2]!;
        quatOf(L);
        if (l.pastern !== undefined && s > 0) {
          // Toward no turn of its own (following the pastern), normalised.
          const k = Q[3]! < 0 ? s - 1 : 1 - s;
          const x = Q[0]! * k, y = Q[1]! * k, z = Q[2]! * k, w = Q[3]! * k + s;
          const n = Math.hypot(x, y, z, w) || 1;
          Q[0] = x / n;
          Q[1] = y / n;
          Q[2] = z / n;
          Q[3] = w / n;
        }
        const q = l.hoof * 4;
        pose.rot[q] = Q[0]!;
        pose.rot[q + 1] = Q[1]!;
        pose.rot[q + 2] = Q[2]!;
        pose.rot[q + 3] = Q[3]!;
        solvePoseBelow(sk, pose, root, world, l.hoof);
      }
    }
    // 7. The look and the tail.
    if (this.gaze && this.gaze.weight > 0) this.gaze.apply(sk, pose, root, world);
    const dt = this.lagDt;
    this.lagDt = 0;
    for (const l of this.lags) l.apply(dt, sk, pose, root, world);
    return world;
  }

  /**
   * The step cycle's `reach` narrowed for hooves standing below their pivots. The cycle hastens a planted hoof that
   * would be left too far from its home, but it measures along the ground only: a hoof a stair lower (or down a slope)
   * runs out of leg sooner. Per planted leg, from the last solved pose: how far the hoof may be from under its pivot
   * when the trunk has dipped all it may (`MAX_DIP_M`), less the pivot's own distance from the home.
   */
  private reachBelow(): number {
    const c = this.cycle, w = this.world, r = this.root, legs = this.kind.steps.legs;
    let reach = this.baseReach;
    if (!c.started) return reach;
    for (let i = 0; i < legs.length; i++) {
      if (c.planted[i] !== 1) continue;
      const l = legs[i]!, ch = l.chain;
      const a = ch.upper * 12, b = ch.lower * 12, e = ch.end * 12;
      const len = Math.hypot(w[b + 9]! - w[a + 9]!, w[b + 10]! - w[a + 10]!, w[b + 11]! - w[a + 11]!) + Math.hypot(w[e + 9]! - w[b + 9]!, w[e + 10]! - w[b + 10]!, w[e + 11]! - w[b + 11]!);
      if (!(len > 0)) continue;
      const R = BELOW_SHARE * len;
      const v = w[a + 10]! - (MAX_DIP_M - this.dip) - c.targets[i * 3 + 1]!;
      const across = v < R ? Math.sqrt(R * R - (v > 0 ? v * v : 0)) : 0;
      // The home in the solve frame, and the pivot's distance from it along the ground.
      const hx = r[0]! * l.home[0] + r[6]! * l.home[2] + r[9]!, hz = r[2]! * l.home[0] + r[8]! * l.home[2] + r[11]!;
      const off = Math.hypot(w[a + 9]! - hx, w[a + 11]! - hz);
      const own = across - off;
      if (own < reach) reach = own > 0.05 ? own : 0.05;
    }
    return reach;
  }

  /**
   * How far a leg is folded at `u` of its swing (0–1): over its `swingFold` share (fullest at its peak), at the share
   * `g` only within `foldIn`.
   */
  private foldOf(l: SteedLeg, u: number, g: number): number {
    let full: number;
    const sf = l.swingFold;
    if (!sf) full = Math.sin(Math.PI * u);
    else {
      const [a, m, b] = sf;
      const x = u <= m ? (u - a) / (m - a) : (b - u) / (b - m);
      const v = x > 0 ? (x < 1 ? Math.sin(0.5 * Math.PI * x) : 1) : 0;
      full = v * v;
    }
    if (!(g > 0)) return full;
    const within = l.foldIn;
    const x = (u - within[0]) / (within[1] - within[0]);
    const part = x > 0 && x < 1 ? Math.sin(Math.PI * x) : 0;
    return full + (part - full) * g;
  }

  /**
   * Leg `i`'s angle from under its pivot toward its end's target (radians, + forward): the target's distance ahead of
   * the leg's home along the root's forward over the pivot's height in the rest pose.
   */
  private angleOf(l: SteedLeg, i: number): number {
    const r = this.root, a = this.aims;
    const hx = r[0]! * l.home[0] + r[6]! * l.home[2] + r[9]!, hz = r[2]! * l.home[0] + r[8]! * l.home[2] + r[11]!;
    const d = (a[i * 3]! - hx) * r[6]! + (a[i * 3 + 2]! - hz) * r[8]!;
    return Math.atan2(d, this.heights[i]!);
  }

  /** Per leg the distance of the fetlock from its target after the last `solve`, m. */
  left(i: number): number {
    return this.reaches[i]!.left;
  }
}
