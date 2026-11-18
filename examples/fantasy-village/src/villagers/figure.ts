// How a person is posed and drawn, shared by the villagers (index.ts) and the walker of the walk mode
// (walk/player.ts). One motion graph description (the engine's `MotionGraph`) serves every person: the game's pose
// functions of rig.ts are its sources, and every person's own skeleton places the bones.
//
//   action   override   one state per action (ACT); a change of action fades over BLEND seconds (smooth). Hammer and
//                       hoe loop once per work cycle (rate = 1 / cycle); the hammer's pass has the mark 'strike'
//   gait     additive   the walk cycle on the body without the arms, weighted by the walking share
//   gaitL/R  additive   the arm swing of the walk cycle, weighted by walk × how free that arm is in the actions
//   holdL/R  override   a held staff, cane, basket or shield over one arm, weighted by how far the actions allow it
//   look     additive   the look of the head and the stoop of the back
//
// After the graph the cloth bones follow the finished hips (they depend on the whole pose, so they are no layer).
// The parts are instances written by the engine's `BoneInstances`; parts not shown in the current prop mode or
// action are collapsed. Nothing is allocated per frame.

import { MotionGraph, MotionGraphDef, Pose, boneMask, setBoneEuler, solvePose } from 'wallhammer-web/motion';
import type { BoneMask, MotionEventKind, MotionSource } from 'wallhammer-web/motion';
import { BoneInstances } from 'wallhammer-web/render';
import { PART_FLOATS } from '../kit/index.ts';
import type { PartSet } from '../kit/index.ts';
import type { PartDef, Person } from './looks.ts';
import { ACT, BLEND, HB, HOLD, HP, HUMAN_BONES, HUMAN_CHANNELS, actionPose, addGait, armsFree, body, channelsToPose, clothChannels, figureRoot, holdAllowed, holdArm, humanSkeleton, lookChannels } from './rig.ts';
import type { PoseIn } from './rig.ts';
import { M, collapse } from './vmath.ts';

/** Share of the hammer's pass at which it hits the anvil (rig.ts `actionPose`). */
export const STRIKE = 0.66;

/** State names of the action layer by action id. */
const ACT_NAMES = Object.keys(ACT);
const ACT_COUNT = ACT_NAMES.length;

/** Channel layout of every human (the bones are the same for all, only their joints differ). */
const TEMPLATE = humanSkeleton(body(1.7, 1, 0, 1, 1));
const CH = new Float64Array(HUMAN_CHANNELS);

const toPose = (out: Pose): void => channelsToPose(TEMPLATE, CH, out);

function actionSource(act: number): MotionSource<PoseIn> {
  if (act === ACT.hammer || act === ACT.hoe) {
    return {
      duration: 1,
      unit: 'phase',
      ...(act === ACT.hammer ? { marks: [{ name: 'strike', at: STRIKE }] } : {}),
      sample(out, t, s) {
        actionPose(CH, act, t * s.cycle, s);
        toPose(out);
      },
    };
  }
  return {
    sample(out, t, s) {
      actionPose(CH, act, t, s);
      toPose(out);
    },
  };
}

/** The walk cycle at full stride (the layers weight it), both arms swinging. */
const gait: MotionSource<PoseIn> = {
  sample(out, _t, s) {
    CH.fill(0);
    addGait(CH, s, 1, 1, 1);
    toPose(out);
  },
};

const hold = (side: number): MotionSource<PoseIn> => ({
  sample(out, _t, s) {
    CH.fill(0);
    holdArm(CH, s, side, side > 0 ? s.holdL : s.holdR, 1);
    toPose(out);
  },
});

const look: MotionSource<PoseIn> = {
  sample(out, _t, s) {
    CH.fill(0);
    lookChannels(CH, s);
    toPose(out);
  },
};

let DEF: MotionGraphDef<PoseIn> | null = null;

/** The one graph description of all people (built on first use). */
function humanGraph(): MotionGraphDef<PoseIn> {
  if (DEF) return DEF;
  const sk = TEMPLATE.bones;
  const armL = boneMask(sk, ['lUpper']);
  const armR = boneMask(sk, ['rUpper']);
  const torso: BoneMask = boneMask(sk, ['pelvis']);
  for (let b = 0; b < sk.count; b++) if (armL[b]! > 0 || armR[b]! > 0) torso[b] = 0;
  DEF = new MotionGraphDef<PoseIn>({
    skeleton: sk,
    params: { act: 0, walk: 0, freeL: 0, freeR: 0, holdL: 0, holdR: 0, cycleRate: 1 },
    layers: [
      {
        name: 'action',
        states: ACT_NAMES.map((name, id) => ({ name, source: actionSource(id), ...(id === ACT.hammer || id === ACT.hoe ? { rate: 'cycleRate' } : {}) })),
        transitions: ACT_NAMES.map((name, id) => ({ from: '*', to: name, seconds: BLEND, ease: 'smooth' as const, when: [{ param: 'act', op: '==' as const, value: id }] })),
      },
      { name: 'gait', mode: 'additive', mask: torso, weight: 'walk', states: [{ name: 'gait', source: gait }] },
      { name: 'gaitL', mode: 'additive', mask: armL, weight: 'freeL', states: [{ name: 'swing', source: gait }] },
      { name: 'gaitR', mode: 'additive', mask: armR, weight: 'freeR', states: [{ name: 'swing', source: gait }] },
      { name: 'holdL', mask: armL, weight: 'holdL', states: [{ name: 'hold', source: hold(1) }] },
      { name: 'holdR', mask: armR, weight: 'holdR', states: [{ name: 'hold', source: hold(-1) }] },
      { name: 'look', mode: 'additive', states: [{ name: 'look', source: look }] },
    ],
  });
  return DEF;
}

/** Pitch of a bone turned by Rx(pitch) · Rz(roll) (a thigh), read back from its quaternion. */
function pitchOf(pose: Pose, bone: number): number {
  const r = pose.rot, q = bone * 4;
  const x = r[q]!, y = r[q + 1]!, z = r[q + 2]!, w = r[q + 3]!;
  // Image of the local y axis: (2(xy − wz), 1 − 2(x² + z²), 2(yz + wx)) = (−sin roll, cos roll cos pitch, cos roll sin pitch).
  return Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z));
}

/**
 * The parts of one figure in shared part sets: records taken from `next` (per set), tints written once, matrices
 * written from the bones by the engine's `BoneInstances`; parts not shown in a prop mode or action collapse.
 */
export class FigureParts {
  readonly count: number;
  private readonly bones: BoneInstances;
  private readonly sets: PartSet[];
  private readonly setOf: Int8Array;
  private readonly record: Int32Array;
  private readonly show: Int32Array;
  private readonly acts: Int32Array;

  constructor(parts: readonly PartDef[], sets: PartSet[], next: number[]) {
    const n = (this.count = parts.length);
    this.sets = sets;
    this.setOf = new Int8Array(n);
    this.record = new Int32Array(n);
    this.show = new Int32Array(n);
    this.acts = new Int32Array(n);
    parts.forEach((p, k) => {
      const r = next[p.set]!++;
      this.setOf[k] = p.set;
      this.record[k] = r;
      this.show[k] = p.show;
      this.acts[k] = p.acts;
      const d = sets[p.set]!.data, o = r * PART_FLOATS;
      d[o + 12] = p.color[0];
      d[o + 13] = p.color[1];
      d[o + 14] = p.color[2];
      d[o + 15] = p.glow;
    });
    this.bones = new BoneInstances(parts.map((p, k) => ({ bone: p.bone, set: sets[p.set]!, record: this.record[k]!, local: p.m })));
  }

  /** Writes every part from the bone matrices (12 per bone); parts not shown in prop mode `prop` or action `act` collapse. */
  write(world: Float64Array, prop: number, act: number): void {
    this.bones.write(world);
    for (let k = 0; k < this.count; k++) {
      const sh = this.show[k]!, ac = this.acts[k]!;
      if ((sh !== 0 && (sh & (1 << prop)) === 0) || (ac !== 0 && (ac & (1 << act)) === 0)) collapse(this.sets[this.setOf[k]!]!.data, this.record[k]! * PART_FLOATS);
    }
  }

  /** Collapses every part (a figure indoors). */
  hide(): void {
    for (let k = 0; k < this.count; k++) collapse(this.sets[this.setOf[k]!]!.data, this.record[k]! * PART_FLOATS);
    for (const s of this.sets) s.dirty = true;
  }
}

/** One person: the motion graph over the person's input, the posed bones and the parts. */
export class HumanFigure {
  readonly person: Person;
  readonly parts: FigureParts;
  /** Input of the pose functions; the owner sets the per-frame fields (t, walk, run, gait, look, speak) before `pose`. */
  readonly input: PoseIn;
  readonly graph: MotionGraph<PoseIn>;
  /** Clock time of the last hammer strike (the mark 'strike'), −Infinity before the first one. */
  strikeAt = -Infinity;
  private readonly local: Pose;
  private readonly world = new Float64Array(HUMAN_BONES * M);
  private clock = 0;
  private live = false;
  private readonly onEvent = (kind: MotionEventKind, name: string): void => {
    if (kind !== 'mark' || name !== 'strike') return;
    // The mark was crossed during the last update: how far past it the pass is now, in seconds.
    const ph = this.graph.phase('action');
    let over = ph - Math.floor(ph) - STRIKE;
    if (over < 0) over += 1;
    this.strikeAt = this.clock - over * this.input.cycle;
  };

  constructor(person: Person, parts: FigureParts, input: PoseIn) {
    this.person = person;
    this.parts = parts;
    this.input = input;
    this.graph = new MotionGraph(humanGraph(), input);
    this.local = new Pose(TEMPLATE.bones);
    this.graph.setParam('cycleRate', 1 / input.cycle);
  }

  /**
   * Poses and writes the figure: feet at (x, y, z), village heading `yaw`, action `act` (`tA` seconds into it, read
   * only when the figure starts or comes back into view), `clock` the animation time in seconds, `prop` the prop mode.
   */
  pose(x: number, y: number, z: number, yaw: number, act: number, tA: number, clock: number, prop: number): void {
    const g = this.graph;
    const s = this.input;
    g.setParam('act', act);
    if (!this.live) {
      g.setState(ACT_NAMES[act]!, 'action', tA > 0 ? tA : 0);
      this.live = true;
      this.strikeAt = -Infinity;
    } else g.update(clock > this.clock ? clock - this.clock : 0);
    this.clock = clock;
    g.drainEvents(this.onEvent);
    // Arm swing and held things by the share of every action in the fade.
    let free = 0, allowed = 0;
    for (let k = 0; k < ACT_COUNT; k++) {
      const w = g.weightOf(ACT_NAMES[k]!, 'action');
      if (w > 0) (free += w * armsFree(k)), (allowed += w * holdAllowed(k));
    }
    g.setParam('walk', s.walk);
    g.setParam('freeL', s.walk * (s.holdL !== HOLD.none ? free * 0.2 : free));
    g.setParam('freeR', s.walk * (s.holdR !== HOLD.none ? free * 0.2 : free));
    g.setParam('holdL', s.holdL !== HOLD.none ? allowed : 0);
    g.setParam('holdR', s.holdR !== HOLD.none ? allowed : 0);
    const pose = this.local;
    g.evaluate(pose);
    clothChannels(CH, s, pitchOf(pose, HB.lThigh), pitchOf(pose, HB.rThigh));
    setBoneEuler(pose, HB.clothFront, CH[HP.clothF]!, 0, 0);
    setBoneEuler(pose, HB.clothBack, CH[HP.clothB]!, 0, 0);
    setBoneEuler(pose, HB.cloak, CH[HP.cloak]!, 0, 0);
    solvePose(this.person.skel.bones, pose, figureRoot(x, y, z, yaw), this.world);
    this.parts.write(this.world, prop, act);
  }

  /** Collapses the figure; it starts afresh (no fade) when it is posed again. */
  hide(): void {
    this.parts.hide();
    this.live = false;
  }
}
