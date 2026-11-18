// The village's poses as channels over the engine's skeletons (wallhammer-web/motion). Every bone of a figure reads up
// to three angles from a pose vector (yaw, pitch and roll, see vmath.ts); `channelsToPose` turns such a vector into
// the engine's `Pose` (R = Ry(yaw) · Rx(pitch) · Rz(roll), the order `'yxz'`), and the engine's `solvePose` places the
// bones. The body parts of a figure are instances placed by bone world × a fixed part matrix (looks.ts, figure.ts).
//
// The human pose has 32 channels (HP). The pose functions here are the game's motions: `actionPose` is the absolute
// pose of one action, `addGait` the walk cycle, `holdArm` a held tool, `lookChannels` the look and the stoop. The
// motion graph of figure.ts plays them as sources: actions as states blending over BLEND seconds, the walk cycle and
// the held tools as layers masked to the body or one arm, weighted by the walking speed and the action.

import { Pose, Skeleton as BoneTree, setBoneEuler, solvePose } from 'wallhammer-web/motion';
import { M, ease, trs } from './vmath.ts';

/**
 * A village skeleton: the engine's bones and the pose channels each bone reads (yaw, pitch, roll per bone; −1 none),
 * with a scratch pose for `solve`.
 */
export interface Skeleton {
  readonly bones: BoneTree;
  readonly count: number;
  readonly ch: Int8Array;
  readonly scratch: Pose;
}
/** Seconds over which one action pose blends into the next. */
export const BLEND = 0.45;

const ROOT = new Float64Array(M);

/** Builds a skeleton from a list of bones (parents first); bones without a name are called b0, b1, … */
export function skeleton(bones: readonly { name?: string; parent: number; at: readonly number[]; ch?: readonly number[] }[]): Skeleton {
  const n = bones.length;
  const ch = new Int8Array(n * 3).fill(-1);
  bones.forEach((b, i) => {
    if (b.ch) for (let k = 0; k < 3; k++) ch[i * 3 + k] = b.ch[k] ?? -1;
  });
  const tree = new BoneTree(bones.map((b, i) => ({ name: b.name ?? `b${i}`, parent: b.parent, joint: [b.at[0]!, b.at[1]!, b.at[2]!] as const })));
  return { bones: tree, count: n, ch, scratch: new Pose(tree) };
}

/**
 * Writes a pose vector as the engine's pose: every bone's rotation from its channels, and channels 0 and 1 (dy, dz)
 * as the offset of the root bones. Bones of the other skeletons with the same bone count read the same channels.
 */
export function channelsToPose(sk: Skeleton, o: ArrayLike<number>, out: Pose): void {
  const ch = sk.ch, par = sk.bones.parent, off = out.offset;
  for (let b = 0; b < sk.count; b++) {
    const c0 = ch[b * 3]!, c1 = ch[b * 3 + 1]!, c2 = ch[b * 3 + 2]!;
    setBoneEuler(out, b, c1 >= 0 ? o[c1]! : 0, c0 >= 0 ? o[c0]! : 0, c2 >= 0 ? o[c2]! : 0, 'yxz');
    const root = par[b]! < 0;
    off[b * 3] = 0;
    off[b * 3 + 1] = root ? o[0]! : 0;
    off[b * 3 + 2] = root ? o[1]! : 0;
  }
}

/** The figure's place: feet at (x, y, z), turned by the village heading `yaw` (0 faces +z), into `out`. */
export function figureRoot(x: number, y: number, z: number, yaw: number, out: Float64Array = ROOT): Float64Array {
  trs(out, 0, x, y, z, yaw, 0, 0, 1, 1, 1);
  return out;
}

/** World matrices of all bones into `out` (12 per bone) from a pose vector: `channelsToPose`, then `solvePose`. */
export function solve(sk: Skeleton, x: number, y: number, z: number, yaw: number, pose: ArrayLike<number>, out: Float64Array): void {
  channelsToPose(sk, pose, sk.scratch);
  solvePose(sk.bones, sk.scratch, figureRoot(x, y, z, yaw), out);
}

// --- The human ----------------------------------------------------------------------------------------------------

/** Bones of a human. */
export const HB = {
  pelvis: 0, spine: 1, head: 2,
  lUpper: 3, lFore: 4, lHand: 5, rUpper: 6, rFore: 7, rHand: 8,
  lThigh: 9, lShin: 10, lFoot: 11, rThigh: 12, rShin: 13, rFoot: 14,
  back: 15, clothFront: 16, clothBack: 17, cloak: 18,
} as const;
export const HUMAN_BONES = 19;
/** Bone names of a human (the keys of HB, in bone order). */
export const HUMAN_BONE_NAMES: readonly string[] = Object.keys(HB);

/** Pose channels of a human. Forward swings of limbs are negative pitches; knees bend positive. */
export const HP = {
  dy: 0, dz: 1, pelvisYaw: 2, pelvisPitch: 3, pelvisRoll: 4, spineYaw: 5, spinePitch: 6, spineRoll: 7,
  headYaw: 8, headPitch: 9, headRoll: 10,
  lShPitch: 11, lShRoll: 12, lShYaw: 13, lElbow: 14, lWrist: 15,
  rShPitch: 16, rShRoll: 17, rShYaw: 18, rElbow: 19, rWrist: 20,
  lHip: 21, lHipRoll: 22, lKnee: 23, lAnkle: 24, rHip: 25, rHipRoll: 26, rKnee: 27, rAnkle: 28,
  clothF: 29, clothB: 30, cloak: 31,
} as const;
export const HUMAN_CHANNELS = 32;

/** Body measures of one person (metres), derived from height and build. */
export interface Body {
  H: number;
  /** Width factor (0.85 slim … 1.35 broad). */
  W: number;
  /** 0 flat … 1 big belly. */
  belly: number;
  footH: number;
  thigh: number;
  shin: number;
  hipY: number;
  headH: number;
  neckLen: number;
  torsoLen: number;
  /** Spine pivot above the hip joints (the waist). */
  waist: number;
  shoulderW: number;
  shoulderY: number;
  hipW: number;
  upper: number;
  fore: number;
  armR: number;
  legR: number;
  torsoRx: number;
  torsoRz: number;
  /** Default outward angle of the hanging arms so they clear the body. */
  armOut: number;
}

export function body(H: number, W: number, belly: number, headK: number, legK: number): Body {
  const footH = 0.068 * H;
  const legLen = 0.4 * H * legK;
  const hipY = footH + legLen;
  const headH = 0.2 * H * headK;
  const neckLen = 0.035 * H;
  const torsoLen = H - hipY - neckLen - headH * 0.97;
  const torsoRx = 0.118 * H * W;
  const torsoRz = 0.078 * H * (0.85 + 0.15 * W) * (1 + 0.25 * belly);
  const armR = 0.027 * H * Math.sqrt(W);
  const shoulderW = torsoRx * 0.98;
  const waist = 0.18 * torsoLen;
  const bellyX = torsoRx * (0.9 + 0.25 * belly);
  return {
    H, W, belly, footH,
    thigh: legLen * 0.52,
    shin: legLen * 0.48,
    hipY, headH, neckLen, torsoLen, waist,
    shoulderW,
    shoulderY: waist + torsoLen * 0.8 - 0.04 * H,
    hipW: 0.052 * H * W,
    upper: 0.168 * H,
    fore: 0.148 * H,
    armR,
    legR: 0.035 * H * Math.sqrt(W),
    torsoRx, torsoRz,
    armOut: Math.max(0.07, Math.atan2(bellyX + armR * 1.1 - shoulderW, 0.168 * H * 1.4)),
  };
}

/** The skeleton of one person. */
export function humanSkeleton(b: Body): Skeleton {
  const top = b.waist + b.torsoLen * 0.82;
  const P = HP;
  const bones = [
    { parent: -1, at: [0, b.hipY, 0], ch: [P.pelvisYaw, P.pelvisPitch, P.pelvisRoll] },
    { parent: HB.pelvis, at: [0, b.waist, 0], ch: [P.spineYaw, P.spinePitch, P.spineRoll] },
    { parent: HB.spine, at: [0, top - b.waist + b.neckLen, 0.012 * b.H], ch: [P.headYaw, P.headPitch, P.headRoll] },
    { parent: HB.spine, at: [b.shoulderW, b.shoulderY - b.waist, 0], ch: [P.lShYaw, P.lShPitch, P.lShRoll] },
    { parent: HB.lUpper, at: [0, -b.upper, 0], ch: [-1, P.lElbow, -1] },
    { parent: HB.lFore, at: [0, -b.fore, 0], ch: [-1, P.lWrist, -1] },
    { parent: HB.spine, at: [-b.shoulderW, b.shoulderY - b.waist, 0], ch: [P.rShYaw, P.rShPitch, P.rShRoll] },
    { parent: HB.rUpper, at: [0, -b.upper, 0], ch: [-1, P.rElbow, -1] },
    { parent: HB.rFore, at: [0, -b.fore, 0], ch: [-1, P.rWrist, -1] },
    { parent: HB.pelvis, at: [b.hipW, 0, 0], ch: [-1, P.lHip, P.lHipRoll] },
    { parent: HB.lThigh, at: [0, -b.thigh, 0], ch: [-1, P.lKnee, -1] },
    { parent: HB.lShin, at: [0, -b.shin, 0], ch: [-1, P.lAnkle, -1] },
    { parent: HB.pelvis, at: [-b.hipW, 0, 0], ch: [-1, P.rHip, P.rHipRoll] },
    { parent: HB.rThigh, at: [0, -b.thigh, 0], ch: [-1, P.rKnee, -1] },
    { parent: HB.rShin, at: [0, -b.shin, 0], ch: [-1, P.rAnkle, -1] },
    { parent: HB.spine, at: [0, b.torsoLen * 0.5, -b.torsoRz * 0.95], ch: [] },
    { parent: HB.pelvis, at: [0, b.waist * 0.6, 0], ch: [-1, P.clothF, -1] },
    { parent: HB.pelvis, at: [0, b.waist * 0.6, 0], ch: [-1, P.clothB, -1] },
    { parent: HB.spine, at: [0, b.shoulderY - b.waist + 0.02 * b.H, -b.torsoRz * 0.8], ch: [-1, P.cloak, -1] },
  ];
  return skeleton(bones.map((q, i) => ({ ...q, name: HUMAN_BONE_NAMES[i]! })));
}

// --- Actions ----------------------------------------------------------------------------------------------------

/** Actions (the same ids are used by the simulation). Animals use their own ids from 20 on. */
export const ACT = {
  stand: 0, walk: 1, carry: 2, hammer: 3, tend: 4, sweep: 5, offer: 6, talk: 7, hoe: 8, sit: 9, guard: 10, run: 11,
  give: 12, drink: 13,
} as const;

/** What a hand holds while the arm is otherwise free (looks.ts sets it per person). */
export const HOLD = { none: 0, staff: 1, cane: 2, basket: 3, shield: 4 } as const;

/** Talking style while listening. */
export const LISTEN = { relaxed: 0, crossed: 1, hips: 2, clasped: 3 } as const;

/** Per-frame input of the pose functions (one object, reused). */
export interface PoseIn {
  /** Animation time (seconds). */
  t: number;
  /** Walk weight 0–1 (speed against the person's walking speed) and run share 0–1. */
  walk: number;
  run: number;
  /** Gait phase (radians, grows with the distance walked). */
  gait: number;
  /** Look direction relative to the body (radians) and pitch. */
  lookYaw: number;
  lookPitch: number;
  /** Speaking share 0–1 while talking. */
  speak: number;
  /** Personal phase so people do not move in step. */
  ph: number;
  /** Gesture liveliness 0.5–1.5. */
  energy: number;
  holdL: number;
  holdR: number;
  listen: number;
  armOut: number;
  /** Root drop when sitting (negative metres). */
  seatDrop: number;
  /** Period of the work cycle (hammer, hoe) in seconds. */
  cycle: number;
  /** Extra forward bend of the back (the old man). */
  stoop: number;
}

export function poseIn(): PoseIn {
  return { t: 0, walk: 0, run: 0, gait: 0, lookYaw: 0, lookPitch: 0, speak: 0, ph: 0, energy: 1, holdL: 0, holdR: 0, listen: 0, armOut: 0.1, seatDrop: -0.4, cycle: 1.2, stoop: 0 };
}

const P = HP;

/** Writes one arm: side +1 left, −1 right; `out` is the outward swing, `inward` brings the hand across. */
function arm(o: Float64Array, side: number, pitch: number, out: number, inward: number, elbow: number, wrist: number): void {
  if (side > 0) {
    o[P.lShPitch] = pitch; o[P.lShRoll] = out; o[P.lShYaw] = -inward; o[P.lElbow] = elbow; o[P.lWrist] = wrist;
  } else {
    o[P.rShPitch] = pitch; o[P.rShRoll] = -out; o[P.rShYaw] = inward; o[P.rElbow] = elbow; o[P.rWrist] = wrist;
  }
}

/** Breathing, a little weight shift, idle looking about and relaxed arms. */
function base(o: Float64Array, s: PoseIn): void {
  o.fill(0);
  const t = s.t + s.ph * 7;
  const br = Math.sin(t * 1.55);
  o[P.spinePitch] = 0.03 + 0.012 * br;
  o[P.headPitch] = -0.04 - 0.01 * br + 0.04 * Math.sin(t * 0.37);
  o[P.headYaw] = 0.32 * Math.sin(t * 0.21) + 0.14 * Math.sin(t * 0.57 + 1);
  o[P.headRoll] = 0.04 * Math.sin(t * 0.29);
  const shift = Math.sin(t * 0.31);
  o[P.pelvisRoll] = 0.035 * shift;
  o[P.spineRoll] = -0.03 * shift;
  o[P.lKnee] = 0.06 + 0.06 * Math.max(0, -shift);
  o[P.rKnee] = 0.06 + 0.06 * Math.max(0, shift);
  o[P.lHip] = -0.03 - 0.04 * Math.max(0, -shift);
  o[P.rHip] = -0.03 - 0.04 * Math.max(0, shift);
  o[P.lAnkle] = 0.01;
  o[P.rAnkle] = 0.01;
  const sw = 0.03 * Math.sin(t * 0.8);
  arm(o, 1, 0.04 + sw, s.armOut + 0.012 * br, 0, -0.2, 0.1);
  arm(o, -1, 0.04 - sw, s.armOut + 0.012 * br, 0, -0.2, 0.1);
}

/** Arms while listening in one's own style. */
function listenArms(o: Float64Array, s: PoseIn): void {
  const b = 0.02 * Math.sin(s.t * 1.55 + s.ph);
  switch (s.listen) {
    case LISTEN.crossed:
      arm(o, 1, -0.42 + b, s.armOut + 0.1, 0.55, -1.95, 0);
      arm(o, -1, -0.38 + b, s.armOut + 0.1, 0.6, -1.9, 0);
      break;
    case LISTEN.hips:
      arm(o, 1, 0.2, s.armOut + 0.55, -0.35, -1.55, 0.3);
      arm(o, -1, 0.2, s.armOut + 0.55, -0.35, -1.55, 0.3);
      break;
    case LISTEN.clasped:
      arm(o, 1, -0.2 + b, s.armOut, 0.45, -1.0, 0);
      arm(o, -1, -0.2 + b, s.armOut, 0.45, -1.0, 0);
      break;
    default:
      break;
  }
}

/** Absolute pose of one action, `tA` seconds into it. */
export function actionPose(o: Float64Array, act: number, tA: number, s: PoseIn): void {
  base(o, s);
  const t = s.t + s.ph * 5;
  const e = s.energy;
  switch (act) {
    case ACT.stand:
    case ACT.walk:
    case ACT.run:
      break;
    case ACT.guard: {
      o[P.headYaw] = 0.65 * Math.sin(t * 0.17) + 0.15 * Math.sin(t * 0.6);
      o[P.lHipRoll] = 0.06;
      o[P.rHipRoll] = -0.06;
      o[P.spinePitch] = -0.02;
      break;
    }
    case ACT.carry:
      arm(o, 1, -0.5, 0.12, 0.25, -1.25, 0.25);
      arm(o, -1, -0.5, 0.12, 0.25, -1.25, 0.25);
      o[P.spinePitch] = -0.04;
      o[P.headPitch] = 0.05;
      break;
    case ACT.drink:
      // Leaning over the well, a hand scooping to the mouth now and then.
      o[P.spinePitch] = 0.35 + 0.05 * Math.sin(t * 0.6);
      o[P.headPitch] = 0.25;
      arm(o, 1, -0.9, 0.2, 0.2, -0.6, 0);
      arm(o, -1, -0.9 - 0.6 * Math.max(0, Math.sin(tA * 0.9)), 0.2, 0.2, -0.6 - 0.9 * Math.max(0, Math.sin(tA * 0.9)), 0);
      break;
    case ACT.hammer: {
      const c = s.cycle;
      const p = (tA % c) / c;
      let sh: number, el: number, wr: number, lean: number;
      if (p < 0.55) {
        const k = ease(p / 0.55);
        sh = -0.55 - 1.95 * k; el = -0.55 - 0.85 * k; wr = -0.2 * k; lean = 0.12 - 0.06 * k;
      } else if (p < 0.66) {
        const k = (p - 0.55) / 0.11;
        const k2 = k * k;
        sh = -2.5 + 1.95 * k2; el = -1.4 + 0.85 * k2; wr = -0.2 + 0.5 * k2; lean = 0.06 + 0.16 * k2;
      } else {
        const k = ease((p - 0.66) / 0.34);
        sh = -0.55; el = -0.55; wr = 0.3 - 0.3 * k; lean = 0.22 - 0.1 * k;
      }
      arm(o, -1, sh, 0.18, 0.12, el, wr);
      // The left hand holds the work on the anvil with tongs.
      arm(o, 1, -0.75, 0.15, 0.35, -0.75, 0.25);
      o[P.spinePitch] = lean;
      o[P.headPitch] = 0.3;
      o[P.headYaw] = 0.05 * Math.sin(t * 0.3);
      o[P.lHip] = -0.25; o[P.lKnee] = 0.25; o[P.rHip] = 0.08; o[P.rKnee] = 0.1;
      break;
    }
    case ACT.tend: {
      // Working the bellows and poking the coals.
      const k = Math.sin(tA * 2.3);
      o[P.spinePitch] = 0.28 + 0.06 * k;
      o[P.headPitch] = 0.22;
      arm(o, 1, -0.95 + 0.25 * k, 0.15, 0.2, -0.55 - 0.2 * k, 0);
      arm(o, -1, -1.0 - 0.15 * k, 0.15, 0.25, -0.5, 0.2);
      o[P.lHip] = -0.3; o[P.lKnee] = 0.3;
      break;
    }
    case ACT.sweep: {
      const w = Math.sin(tA * 2.6);
      o[P.spinePitch] = 0.2;
      o[P.spineYaw] = 0.3 * w;
      o[P.pelvisYaw] = 0.1 * w;
      o[P.headPitch] = 0.3;
      o[P.headYaw] = -0.2 * w;
      arm(o, -1, -0.5 + 0.12 * w, 0.15, 0.15, -0.55, 0.15);
      arm(o, 1, -1.05 - 0.1 * w, 0.05, 0.55, -0.95, 0.3);
      o[P.lHip] = -0.2; o[P.lKnee] = 0.2; o[P.rKnee] = 0.12;
      break;
    }
    case ACT.offer:
    case ACT.give: {
      // Reach out with the goods, hold, take the hand back, then a small inviting gesture.
      const c = act === ACT.give ? 4 : 6;
      const p = tA % c;
      const out = p < 1.2 ? ease(p / 1.2) : p < 3 ? 1 : p < 4 ? 1 - ease(p - 3) : 0;
      arm(o, -1, -0.15 - 1.15 * out, 0.12, 0.15 * out, -0.25 - 0.4 * (1 - out), -0.25 * out);
      if (act === ACT.give) arm(o, 1, -0.15 - 1.05 * out, 0.12, 0.15 * out, -0.3 - 0.4 * (1 - out), -0.2 * out);
      else arm(o, 1, -0.55, 0.1, 0.3, -0.85, 0.2);
      o[P.spinePitch] = 0.04 + 0.14 * out;
      o[P.headPitch] = 0.05 + 0.1 * out;
      if (p >= 4 && act === ACT.offer) {
        const g = Math.sin(((p - 4) / 2) * Math.PI);
        arm(o, -1, -0.6 * g, 0.25 + 0.3 * g * e, 0, -0.6 - 0.5 * g, -0.3 * g);
      }
      break;
    }
    case ACT.talk: {
      const sp = s.speak;
      // Listening arms, then the speaking gestures blended over them.
      listenArms(o, s);
      if (sp > 0) {
        const ga = e * sp;
        const l = Math.sin(t * 2.1) * 0.5 + 0.5, r = Math.sin(t * 1.7 + 1.9) * 0.5 + 0.5;
        const lp = -0.35 - 0.55 * l * ga, rp = -0.3 - 0.6 * r * ga;
        blendArm(o, 1, lp, s.armOut + 0.25 * l * ga, 0, -0.7 - 0.6 * l * ga, -0.3 * l, sp);
        blendArm(o, -1, rp, s.armOut + 0.3 * r * ga, 0, -0.65 - 0.7 * r * ga, -0.35 * r, sp);
        o[P.headPitch] = o[P.headPitch]! + 0.07 * Math.sin(t * 3.1) * sp;
        o[P.spineYaw] = 0.06 * Math.sin(t * 0.9) * sp;
      } else {
        o[P.headPitch] = o[P.headPitch]! + 0.04 * Math.max(0, Math.sin(t * 1.3));
      }
      // While talking the eyes stay with the partner: the idle look-around is damped (index.ts adds the look).
      o[P.headYaw] = o[P.headYaw]! * 0.15;
      break;
    }
    case ACT.hoe: {
      const c = s.cycle;
      const p = (tA % c) / c;
      let sh: number, el: number, wr: number, lean: number;
      if (p < 0.55) {
        const k = ease(p / 0.55);
        sh = -0.5 - 2.2 * k; el = -0.6 + 0.3 * k; wr = -0.3 * k; lean = 0.18 - 0.22 * k;
      } else if (p < 0.68) {
        const k = (p - 0.55) / 0.13;
        const k2 = k * k;
        sh = -2.7 + 2.05 * k2; el = -0.3 + 0.05 * k2; wr = -0.3 + 1.6 * k2; lean = -0.04 + 0.46 * k2;
      } else {
        const k = ease((p - 0.68) / 0.32);
        sh = -0.65 + 0.15 * k; el = -0.25 - 0.35 * k; wr = 1.3 - 1.3 * k; lean = 0.42 - 0.24 * k;
      }
      arm(o, -1, sh, 0.05, 0.3, el, wr);
      arm(o, 1, sh + 0.15, 0.05, 0.45, el - 0.25, wr);
      o[P.spinePitch] = lean;
      o[P.headPitch] = 0.2 + 0.2 * lean;
      o[P.lHip] = -0.35; o[P.lKnee] = 0.35; o[P.rHip] = 0.1; o[P.rKnee] = 0.15;
      break;
    }
    case ACT.sit: {
      o[P.dy] = s.seatDrop;
      o[P.dz] = -0.03;
      o[P.lHip] = -1.5; o[P.rHip] = -1.5;
      o[P.lKnee] = 1.45; o[P.rKnee] = 1.45;
      o[P.lHipRoll] = 0.08; o[P.rHipRoll] = -0.08;
      o[P.lAnkle] = 0.05; o[P.rAnkle] = 0.05;
      o[P.spinePitch] = 0.1 + 0.012 * Math.sin(t * 1.4);
      arm(o, 1, -0.45, s.armOut, 0.1, -0.75, 0.2);
      arm(o, -1, -0.45, s.armOut, 0.1, -0.75, 0.2);
      break;
    }
    default:
      break;
  }
}

/** Share of each arm that swings freely while walking in an action (0 when the arms work). */
export function armsFree(act: number): number {
  return act === ACT.stand || act === ACT.walk || act === ACT.run || act === ACT.guard ? 1 : act === ACT.talk ? 0.3 : 0;
}

/** May a held tool or shield stay in its holding pose during the action? */
export function holdAllowed(act: number): number {
  return act === ACT.stand || act === ACT.walk || act === ACT.run || act === ACT.guard || act === ACT.talk || act === ACT.sit || act === ACT.drink ? 1 : 0;
}

/** Adds the walk cycle, scaled by `a` (default `s.walk`): legs, hips, counter-twist, swinging arms. */
export function addGait(o: Float64Array, s: PoseIn, freeL: number, freeR: number, a = s.walk): void {
  if (a <= 1e-3) return;
  const r = s.run;
  const sn = Math.sin(s.gait), cs = Math.cos(s.gait);
  const hipA = (0.4 + 0.32 * r) * a, kneeA = (0.7 + 0.55 * r) * a;
  const lk = kneeA * Math.max(0, cs) * Math.max(0, cs), rk = kneeA * Math.max(0, -cs) * Math.max(0, -cs);
  o[P.lHip] = o[P.lHip]! - hipA * sn;
  o[P.rHip] = o[P.rHip]! + hipA * sn;
  o[P.lKnee] = o[P.lKnee]! + 0.08 * a + lk;
  o[P.rKnee] = o[P.rKnee]! + 0.08 * a + rk;
  o[P.lAnkle] = o[P.lAnkle]! - 0.45 * lk + 0.18 * a * Math.max(0, -sn);
  o[P.rAnkle] = o[P.rAnkle]! - 0.45 * rk + 0.18 * a * Math.max(0, sn);
  o[P.dy] = o[P.dy]! - a * (0.025 + 0.04 * r) * Math.abs(sn) + 0.03 * r * a * Math.abs(cs);
  o[P.pelvisYaw] = o[P.pelvisYaw]! + 0.1 * a * sn;
  o[P.spineYaw] = o[P.spineYaw]! - 0.14 * a * sn;
  o[P.pelvisRoll] = o[P.pelvisRoll]! + 0.04 * a * cs;
  o[P.spinePitch] = o[P.spinePitch]! + 0.05 * a + 0.2 * r * a;
  o[P.headPitch] = o[P.headPitch]! - 0.03 * a - 0.1 * r * a;
  const armA = (0.36 + 0.35 * r) * a;
  o[P.lShPitch] = o[P.lShPitch]! + freeL * armA * sn;
  o[P.rShPitch] = o[P.rShPitch]! - freeR * armA * sn;
  o[P.lElbow] = o[P.lElbow]! - freeL * a * (0.12 + 1.1 * r + 0.15 * Math.max(0, -sn));
  o[P.rElbow] = o[P.rElbow]! - freeR * a * (0.12 + 1.1 * r + 0.15 * Math.max(0, sn));
}

/** Moves one arm (side +1 left, −1 right) toward the pose of what it holds by weight `w` (0–1); nothing for none. */
export function holdArm(o: Float64Array, s: PoseIn, side: number, kind: number, w: number): void {
  if (kind === HOLD.none || w <= 0) return;
  const g = Math.sin(s.gait) * s.walk;
  switch (kind) {
    case HOLD.staff: blendArm(o, side, -0.1 + 0.08 * g * side, s.armOut + 0.08, 0.05, -1.42, 0.02, w); break;
    case HOLD.cane: blendArm(o, side, -0.25 - 0.18 * g * side, s.armOut + 0.06, 0, -1.0, -0.3, w); break;
    case HOLD.basket: blendArm(o, side, 0.08, s.armOut + 0.18, -0.05, -1.5, 0.4, w); break;
    case HOLD.shield: blendArm(o, side, -0.3, s.armOut + 0.12, 0.45, -1.25, 0, w); break;
    default: break;
  }
}

/** Moves one arm toward a pose by weight w (side +1 left, −1 right; `out` outward, `inward` across the body). */
function blendArm(o: Float64Array, side: number, pitch: number, out: number, inward: number, elbow: number, wrist: number, w: number): void {
  const ip = side > 0 ? P.lShPitch : P.rShPitch;
  const ir = side > 0 ? P.lShRoll : P.rShRoll;
  const iy = side > 0 ? P.lShYaw : P.rShYaw;
  const ie = side > 0 ? P.lElbow : P.rElbow;
  const iw = side > 0 ? P.lWrist : P.rWrist;
  o[ip] = o[ip]! + (pitch - o[ip]!) * w;
  o[ir] = o[ir]! + (side * out - o[ir]!) * w;
  o[iy] = o[iy]! + (-side * inward - o[iy]!) * w;
  o[ie] = o[ie]! + (elbow - o[ie]!) * w;
  o[iw] = o[iw]! + (wrist - o[iw]!) * w;
}

/** The look of the head (shared by head and spine) and the stoop of the back, as channels to add on top. */
export function lookChannels(o: Float64Array, s: PoseIn): void {
  o[P.headYaw] = o[P.headYaw]! + s.lookYaw * 0.72;
  o[P.spineYaw] = o[P.spineYaw]! + s.lookYaw * 0.28;
  o[P.headPitch] = o[P.headPitch]! + s.lookPitch - s.stoop * 0.7;
  o[P.spinePitch] = o[P.spinePitch]! + s.stoop;
}

/** The cloth bones: skirts follow the hip pitches `lh`, `rh` of the finished pose, the cloak the walk and the run. */
export function clothChannels(o: Float64Array, s: PoseIn, lh: number, rh: number): void {
  o[P.clothF] = Math.min(0, Math.min(lh, rh)) * 0.85 - 0.03;
  o[P.clothB] = Math.max(0, Math.max(lh, rh)) * 0.85 + 0.03 + 0.06 * s.walk;
  o[P.cloak] = 0.06 + 0.22 * s.walk + 0.3 * s.run + 0.03 * Math.sin(s.t * 1.1 + s.ph);
}
