// Chickens, a dog and a cat: their skeletons, looks and poses. They share the four part sets of the villagers and
// the same simulation (sim.ts): chickens wander their yard pecking and scratching, the dog follows the child and
// sits wagging its tail when the child stops, the cat grooms by the inn's barrels and now and then walks to the well.

import { hex, scaleRgb } from '../kit/index.ts';
import type { RGB } from '../kit/index.ts';
import { FigureBuilder } from './looks.ts';
import type { PartDef } from './looks.ts';
import { ease } from './vmath.ts';
import { skeleton } from './rig.ts';
import type { Skeleton } from './rig.ts';
import { AACT } from './sim.ts';

export interface Animal {
  name: string;
  kind: 'chicken' | 'dog' | 'cat';
  skel: Skeleton;
  parts: PartDef[];
  channels: number;
  speed: number;
  stride: number;
  /** Height of the legs (for the walk cycle). */
  legH: number;
}

// --- Chicken ---------------------------------------------------------------------------------------------------

/** Chicken pose channels. */
const CP = { dy: 0, dz: 1, bodyPitch: 2, bodyRoll: 3, headYaw: 4, headPitch: 5, lLeg: 6, rLeg: 7, tail: 8, lWing: 9, rWing: 10 } as const;
const CB = { body: 0, neck: 1, lLeg: 2, rLeg: 3, tail: 4, lWing: 5, rWing: 6 } as const;

export function chicken(name: string, feathers: RGB, tail: RGB, scale: number): Animal {
  const s = scale;
  const legH = 0.09 * s;
  const sk = skeleton([
    { parent: -1, at: [0, legH + 0.02 * s, 0], ch: [-1, CP.bodyPitch, CP.bodyRoll] },
    { parent: CB.body, at: [0, 0.04 * s, 0.07 * s], ch: [CP.headYaw, CP.headPitch, -1] },
    { parent: CB.body, at: [0.03 * s, -0.02 * s, 0], ch: [-1, CP.lLeg, -1] },
    { parent: CB.body, at: [-0.03 * s, -0.02 * s, 0], ch: [-1, CP.rLeg, -1] },
    { parent: CB.body, at: [0, 0.03 * s, -0.09 * s], ch: [-1, CP.tail, -1] },
    { parent: CB.body, at: [0.07 * s, 0.025 * s, 0], ch: [-1, -1, CP.lWing] },
    { parent: CB.body, at: [-0.07 * s, 0.025 * s, 0], ch: [-1, -1, CP.rWing] },
  ]);
  const f = new FigureBuilder();
  const v = (x: number, y: number, z: number): number[] => [x * s, y * s, z * s];
  const yellow = hex('#e0a83a');
  const red = hex('#c8282a');
  f.blob(CB.body, v(0, 0, 0), v(0.085, 0.08, 0.12), feathers);
  f.blob(CB.body, v(0, -0.012, 0.06), v(0.072, 0.07, 0.07), scaleRgb(feathers, 1.04));
  for (const side of [1, -1]) f.blob(side > 0 ? CB.lWing : CB.rWing, v(0, -0.01, -0.01), v(0.022, 0.055, 0.095), scaleRgb(feathers, 0.9), 0, 0.15, 0);
  f.blob(CB.tail, v(0, 0.045, -0.02), v(0.026, 0.075, 0.05), tail, 0, -0.45, 0);
  f.seg(CB.neck, v(0, -0.045, -0.015), v(0, 0.065, 0.018), 0.034 * s, 0.034 * s, feathers);
  f.blob(CB.neck, v(0, 0.085, 0.026), v(0.04, 0.043, 0.046), feathers);
  f.block(CB.neck, v(0, 0.13, 0.02), v(0.012, 0.036, 0.058), red);
  f.block(CB.neck, v(0, 0.08, 0.077), v(0.02, 0.015, 0.036), yellow, 0, 0.3, 0);
  f.blob(CB.neck, v(0, 0.052, 0.062), v(0.011, 0.02, 0.012), red);
  for (const side of [1, -1]) f.blob(CB.neck, v(side * 0.037, 0.095, 0.047), v(0.009, 0.009, 0.009), hex('#1a1414'));
  for (const side of [1, -1]) {
    const b = side > 0 ? CB.lLeg : CB.rLeg;
    f.blob(b, v(0, -0.008, 0), v(0.03, 0.035, 0.036), scaleRgb(feathers, 0.95));
    f.seg(b, v(0, -0.09, 0), v(0, -0.01, 0), 0.008 * s, 0.008 * s, yellow);
    f.block(b, v(0, -0.088, 0.02), v(0.036, 0.008, 0.052), yellow);
  }
  return { name, kind: 'chicken', skel: sk, parts: f.parts, channels: 11, speed: 0.5, stride: 0.16 * s, legH };
}

/** A small hash of an integer to 0–1 (pose variety without a stream). */
const h01 = (k: number): number => {
  const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export function chickenPose(o: Float64Array, act: number, tA: number, t: number, ph: number, walk: number, gait: number): void {
  o.fill(0);
  const tt = t + ph * 9;
  // Jerky head turns: a new direction every 0.4–0.9 s.
  const slot = Math.floor(tt / 0.6);
  o[CP.headYaw] = (h01(slot + ph * 100) - 0.5) * 1.4;
  o[CP.headPitch] = (h01(slot * 3 + 1) - 0.5) * 0.4;
  o[CP.tail] = 0.05 * Math.sin(tt * 1.3);
  o[CP.lWing] = 0.04;
  o[CP.rWing] = -0.04;
  switch (act) {
    case AACT.peck: {
      const k = Math.max(0, Math.sin(tA * 8)) ** 3;
      o[CP.bodyPitch] = 0.5;
      o[CP.headPitch] = 0.7 + 0.55 * k;
      o[CP.headYaw] = 0.1 * Math.sin(tA * 1.7);
      o[CP.tail] = -0.25;
      break;
    }
    case AACT.scratch: {
      const k = Math.sin(tA * 6.5);
      o[CP.bodyPitch] = 0.28;
      o[CP.headPitch] = 0.55;
      o[CP.lLeg] = 0.7 * Math.max(0, k);
      o[CP.rLeg] = 0.7 * Math.max(0, -k);
      o[CP.dy] = -0.006;
      // A flutter now and then.
      const fl = Math.max(0, Math.sin(tA * 0.9) - 0.85) * 6;
      o[CP.lWing] = 0.04 + 0.7 * fl * Math.abs(Math.sin(tA * 22));
      o[CP.rWing] = -o[CP.lWing]!;
      break;
    }
    default:
      break;
  }
  if (walk > 0.01) {
    const sn = Math.sin(gait);
    o[CP.lLeg] = o[CP.lLeg]! - 0.6 * walk * sn;
    o[CP.rLeg] = o[CP.rLeg]! + 0.6 * walk * sn;
    o[CP.bodyRoll] = 0.07 * walk * Math.cos(gait);
    o[CP.headPitch] = o[CP.headPitch]! * (1 - walk) + walk * 0.25 * Math.sin(gait * 2);
    o[CP.dy] = -0.006 * walk * Math.abs(sn);
  }
}

// --- Dog and cat ------------------------------------------------------------------------------------------------

/** Quadruped pose channels. */
const QP = {
  dy: 0, dz: 1, bodyPitch: 2, bodyRoll: 3, headYaw: 4, headPitch: 5,
  flHip: 6, frHip: 7, blHip: 8, brHip: 9, flKnee: 10, frKnee: 11, blKnee: 12, brKnee: 13,
  tailYaw: 14, tailPitch: 15, headRoll: 16,
} as const;
const QB = { hips: 0, head: 1, fl: 2, fr: 3, bl: 4, br: 5, flLow: 6, frLow: 7, blLow: 8, brLow: 9, tail: 10 } as const;

interface QuadSpec {
  len: number;
  legH: number;
  bodyR: number;
  fur: RGB;
  belly: RGB;
  ears: 'floppy' | 'pointy';
  tailLen: number;
  headR: number;
  snout: number;
}

function quadruped(name: string, kind: 'dog' | 'cat', q: QuadSpec, speed: number): Animal {
  const { len, legH, bodyR } = q;
  const w = bodyR * 0.62;
  const half = legH * 0.5;
  const sk = skeleton([
    { parent: -1, at: [0, legH, -len / 2], ch: [-1, QP.bodyPitch, QP.bodyRoll] },
    { parent: QB.hips, at: [0, bodyR * 0.75, len + q.headR * 0.4], ch: [QP.headYaw, QP.headPitch, QP.headRoll] },
    { parent: QB.hips, at: [w, 0, len * 0.9], ch: [-1, QP.flHip, -1] },
    { parent: QB.hips, at: [-w, 0, len * 0.9], ch: [-1, QP.frHip, -1] },
    { parent: QB.hips, at: [w, 0, 0.02], ch: [-1, QP.blHip, -1] },
    { parent: QB.hips, at: [-w, 0, 0.02], ch: [-1, QP.brHip, -1] },
    { parent: QB.fl, at: [0, -half, 0], ch: [-1, QP.flKnee, -1] },
    { parent: QB.fr, at: [0, -half, 0], ch: [-1, QP.frKnee, -1] },
    { parent: QB.bl, at: [0, -half, 0], ch: [-1, QP.blKnee, -1] },
    { parent: QB.br, at: [0, -half, 0], ch: [-1, QP.brKnee, -1] },
    { parent: QB.hips, at: [0, bodyR * 0.45, -bodyR * 0.6], ch: [QP.tailYaw, QP.tailPitch, -1] },
  ]);
  const f = new FigureBuilder();
  const dark = hex('#1a1412');
  // Body: rump, barrel and chest.
  f.seg(QB.hips, [0, 0.0, -bodyR * 0.3], [0, bodyR * 0.1, len * 0.92], bodyR * 0.92, bodyR * 0.98, q.fur);
  f.blob(QB.hips, [0, bodyR * 0.05, 0], [bodyR * 0.95, bodyR * 0.95, bodyR * 1.0], q.fur);
  f.blob(QB.hips, [0, -bodyR * 0.08, len * 0.86], [bodyR * 0.95, bodyR * 1.05, bodyR * 0.95], q.belly);
  // Neck to the head.
  f.seg(QB.hips, [0, bodyR * 0.1, len * 0.75], [0, bodyR * 0.75, len + q.headR * 0.3], bodyR * 0.62, bodyR * 0.62, q.fur);
  // Head.
  const r = q.headR;
  f.blob(QB.head, [0, r * 0.6, r * 0.2], [r, r * 0.92, r * 1.02], q.fur);
  f.blob(QB.head, [0, r * 0.3, r * (0.9 + q.snout * 0.5)], [r * 0.55, r * 0.48, r * (0.4 + q.snout * 0.6)], q.belly);
  f.blob(QB.head, [0, r * 0.45, r * (1.3 + q.snout * 1.0)], [r * 0.2, r * 0.16, r * 0.15], dark);
  for (const side of [1, -1]) {
    f.blob(QB.head, [side * r * 0.42, r * 0.8, r * 0.85], [r * 0.15, r * 0.15, r * 0.12], dark);
    if (q.ears === 'floppy') f.blob(QB.head, [side * r * 0.85, r * 0.75, r * 0.05], [r * 0.25, r * 0.7, r * 0.45], scaleRgb(q.fur, 0.75), 0, 0.1, side * 0.35);
    else f.blob(QB.head, [side * r * 0.55, r * 1.45, r * 0.05], [r * 0.3, r * 0.5, r * 0.12], q.fur, 0, 0, -side * 0.3);
  }
  // Legs and paws.
  for (const [up, low] of [[QB.fl, QB.flLow], [QB.fr, QB.frLow], [QB.bl, QB.blLow], [QB.br, QB.brLow]] as const) {
    const back = up === QB.bl || up === QB.br;
    f.seg(up, [0, -half - 0.01, 0], [0, bodyR * 0.3, 0], bodyR * (back ? 0.42 : 0.34), bodyR * (back ? 0.55 : 0.4), q.fur);
    f.seg(low, [0, -half + 0.012, 0], [0, 0.01, 0], bodyR * 0.24, bodyR * 0.26, q.fur);
    f.blob(low, [0, -half + 0.015, bodyR * 0.15], [bodyR * 0.3, bodyR * 0.2, bodyR * 0.4], q.belly);
  }
  // Tail: thick at the root.
  f.seg(QB.tail, [0, q.tailLen * 0.35, -q.tailLen], [0, 0, 0], bodyR * (kind === 'dog' ? 0.22 : 0.16), bodyR * (kind === 'dog' ? 0.22 : 0.16), q.fur);
  f.blob(QB.tail, [0, q.tailLen * 0.35, -q.tailLen], [bodyR * 0.16, bodyR * 0.16, bodyR * 0.2], kind === 'dog' ? q.belly : q.fur);
  return { name, kind, skel: sk, parts: f.parts, channels: 17, speed, stride: legH * 2.6, legH };
}

export function dog(): Animal {
  return quadruped('dog', 'dog', { len: 0.46, legH: 0.34, bodyR: 0.12, fur: hex('#a86a3a'), belly: hex('#e8d8b8'), ears: 'floppy', tailLen: 0.26, headR: 0.085, snout: 0.6 }, 2.8);
}

export function cat(): Animal {
  return quadruped('cat', 'cat', { len: 0.27, legH: 0.17, bodyR: 0.07, fur: hex('#5a5a62'), belly: hex('#c8c4bc'), ears: 'pointy', tailLen: 0.3, headR: 0.058, snout: 0.15 }, 0.9);
}

/** Pose of a dog or cat. */
export function quadPose(o: Float64Array, a: Animal, act: number, tA: number, t: number, ph: number, walk: number, run: number, gait: number): void {
  o.fill(0);
  const tt = t + ph * 11;
  const dog = a.kind === 'dog';
  o[QP.headYaw] = 0.3 * Math.sin(tt * 0.31) + 0.12 * Math.sin(tt * 0.9);
  o[QP.headPitch] = -0.1 + 0.06 * Math.sin(tt * 0.5);
  o[QP.bodyRoll] = 0.012 * Math.sin(tt * 1.7);
  // Tail: a dog wags, a cat's tail sways slowly and curls up.
  if (dog) {
    o[QP.tailYaw] = 0.55 * Math.sin(tt * 11);
    o[QP.tailPitch] = -0.7;
  } else {
    o[QP.tailYaw] = 0.35 * Math.sin(tt * 0.9);
    o[QP.tailPitch] = -0.5 + 0.15 * Math.sin(tt * 0.6);
  }
  const sitK = act === AACT.sit || act === AACT.groom ? ease(Math.min(1, tA / 0.6)) : 0;
  if (sitK > 0) {
    const p = 0.75 * sitK;
    o[QP.bodyPitch] = -p;
    o[QP.dy] = -Math.sin(p) * a.skel.bones.joint[2 * 3 + 2]! * sitK * 0.95;
    o[QP.flHip] = p;
    o[QP.frHip] = p;
    o[QP.blHip] = -1.0 * sitK;
    o[QP.brHip] = -1.0 * sitK;
    o[QP.blKnee] = 2.2 * sitK;
    o[QP.brKnee] = 2.2 * sitK;
    o[QP.headPitch] = o[QP.headPitch]! + 0.5 * sitK;
    if (!dog) {
      o[QP.tailPitch] = 0.9 * sitK;
      o[QP.tailYaw] = 1.1 * sitK + 0.15 * Math.sin(tt * 0.7);
    }
  }
  if (act === AACT.groom) {
    // Lick a raised paw, then rub the face with it.
    const k = sitK;
    const lick = Math.sin(tA * 9);
    o[QP.flHip] = o[QP.flHip]! - 1.25 * k;
    o[QP.flKnee] = -1.5 * k;
    o[QP.headPitch] = o[QP.headPitch]! + 0.35 * k + 0.08 * lick * k;
    o[QP.headYaw] = 0.35 * k + 0.1 * Math.sin(tA * 0.8);
    o[QP.headRoll] = 0.2 * k;
  }
  if (walk > 0.01) {
    const sn = Math.sin(gait), cs = Math.cos(gait);
    const A = (0.42 + 0.25 * run) * walk;
    // Diagonal pairs: front left with back right.
    o[QP.flHip] = o[QP.flHip]! - A * sn;
    o[QP.brHip] = o[QP.brHip]! - A * sn;
    o[QP.frHip] = o[QP.frHip]! + A * sn;
    o[QP.blHip] = o[QP.blHip]! + A * sn;
    const kf = 0.6 * walk;
    o[QP.flKnee] = o[QP.flKnee]! - kf * Math.max(0, cs);
    o[QP.frKnee] = o[QP.frKnee]! - kf * Math.max(0, -cs);
    o[QP.brKnee] = o[QP.brKnee]! + kf * Math.max(0, cs);
    o[QP.blKnee] = o[QP.blKnee]! + kf * Math.max(0, -cs);
    o[QP.dy] = o[QP.dy]! - 0.012 * walk * Math.abs(sn);
    o[QP.headPitch] = o[QP.headPitch]! + 0.06 * walk * Math.sin(gait * 2);
    o[QP.bodyRoll] = o[QP.bodyRoll]! + 0.03 * walk * cs;
  }
}

/** Chicken colours: white, brown, speckled black, golden, and a red rooster. */
export const CHICKEN_LOOKS: readonly [string, RGB, RGB, number][] = [
  ['white hen', hex('#f2ece0'), hex('#e8e0d0'), 1],
  ['brown hen', hex('#a8642e'), hex('#3a2a20'), 0.95],
  ['black hen', hex('#2e2a2e'), hex('#1e3a3a'), 1.0],
  ['golden hen', hex('#d89a4a'), hex('#8a4a22'), 0.9],
  ['rooster', hex('#b0402a'), hex('#1e4a3a'), 1.22],
];

