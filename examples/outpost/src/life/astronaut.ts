// Astronauts: a suit of rigid parts on a skeleton of the engine's motion module, every part an instance set shared by
// all figures, and two motions written here: a walk cycle whose phase follows the distance walked and an idle stance
// driven by time, blended by a motion graph. The figure is 1.8 m tall to the top of the helmet, feet on y = 0, facing +z; its left is +x.
//
// Bones (joint positions in the parent's frame):
//   body       pelvis at 0.91 m: hips, torso, chest unit, backpack, collar
//   helmet     on the body at the collar
//   arm.l/r    upper arms at the shoulders,  hand.l/r forearm and glove at the elbows
//   leg.l/r    thighs at the hips,           foot.l/r shin and boot at the knees

import { MeshBuilder } from '../kit/mesh.ts';
import { IDENTITY, place } from '../kit/math.ts';
import type { Mat, V3 } from '../kit/math.ts';
import { box, cylinder, frustumBox, lathe, tube } from '../kit/shapes.ts';
import { Skeleton, compileMotionGraph, setBoneEuler } from 'wallhammer-web/motion';
import type { MotionSource, Pose } from 'wallhammer-web/motion';
import { BoneInstances, instanceSet, pushInstance } from 'wallhammer-web/render';
import type { InstanceSet } from 'wallhammer-web/render';
import { rgb } from '../style/palette.ts';

/** Body proportions, metres. */
export const SUIT = {
  hip: 0.91,
  thigh: 0.44,
  shin: 0.35,
  upperArm: 0.3,
  forearm: 0.25,
  shoulderX: 0.29,
  shoulderY: 0.47,
  hipX: 0.11,
  collarY: 0.55,
  /** Metres walked per full cycle (two steps). */
  stride: 1.25,
} as const;

/** A sphere of radius `r` about (0, cy, 0) as a lathe (seams off). */
function sphere(b: MeshBuilder, r: number, cy: number, seg = 14, rows = 8): void {
  const prof: [number, number][] = [];
  for (let k = 0; k <= rows; k++) {
    const t = -Math.PI / 2 + (Math.PI * k) / rows;
    prof.push([Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  prof[0]![0] = 0;
  prof[rows]![0] = 0;
  lathe(b, prof, { segments: seg });
}

function bodyMesh(): MeshBuilder {
  const b = new MeshBuilder();
  // Hips and the torso, a little wider at the chest.
  b.paint(rgb('shell'));
  b.with(place(0, -0.16, 0), () => frustumBox(b, [0.36, 0.25], [0.4, 0.27], 0.2));
  b.with(place(0, 0.04, 0), () => frustumBox(b, [0.4, 0.27], [0.5, 0.31], 0.44));
  // Orange belt.
  b.paint(rgb('orange'));
  b.with(place(0, -0.01, 0), () => box(b, [0.43, 0.07, 0.3]));
  // Chest unit with an orange key and a teal display.
  b.paint(rgb('shellPanel'));
  b.with(place(0, 0.17, 0.15), () => box(b, [0.24, 0.16, 0.07]));
  b.outline = false;
  b.paint(rgb('orange'));
  b.with(place(-0.06, 0.21, 0.186), () => box(b, [0.07, 0.07, 0.01], { lines: false }));
  b.paint(rgb('teal'));
  b.with(place(0.05, 0.21, 0.186), () => box(b, [0.08, 0.06, 0.01], { lines: false }));
  b.outline = true;
  // Backpack: the main box, a lid and an orange stripe.
  b.paint(rgb('shellPanel'));
  b.with(place(0, -0.02, -0.27), () => box(b, [0.44, 0.58, 0.22]));
  b.paint(rgb('shell'));
  b.with(place(0, 0.56, -0.27), () => box(b, [0.46, 0.06, 0.24]));
  b.paint(rgb('orange'));
  b.outline = false;
  b.with(place(0.15, 0.08, -0.155), () => box(b, [0.06, 0.34, 0.01], { lines: false }));
  b.outline = true;
  // Collar ring.
  b.paint(rgb('metalLight'));
  b.with(place(0, 0.48, 0), () => cylinder(b, 0.15, 0.07, { segments: 14 }));
  return b;
}

function helmetMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.paint(rgb('shell'));
  sphere(b, 0.18, 0.15, 16, 8);
  // The visor: a teal cap over the front of the shell, standing a little proud of it.
  b.paint(rgb('teal'));
  const prof: [number, number][] = [];
  for (let k = 0; k <= 6; k++) {
    const t = -0.7 + (1.45 * k) / 6;
    prof.push([Math.cos(t) * 0.187, 0.15 + Math.sin(t) * 0.187]);
  }
  lathe(b, prof, { segments: 10, from: -1.15, to: 1.15, rings: [0, 6] });
  // A small orange lamp on the side.
  b.paint(rgb('orange'));
  b.with(place(0.175, 0.2, -0.04), () => box(b, [0.04, 0.06, 0.08]));
  return b;
}

function upperArmMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.paint(rgb('shell'));
  sphere(b, 0.085, -0.02, 10, 5);
  tube(b, [0, 0, 0], [0, -SUIT.upperArm, 0], 0.07, { segments: 10, rims: false });
  b.paint(rgb('orange'));
  tube(b, [0, -SUIT.upperArm + 0.07, 0], [0, -SUIT.upperArm + 0.01, 0], 0.075, { segments: 10, top: true });
  return b;
}

function forearmMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.paint(rgb('shell'));
  sphere(b, 0.068, 0, 10, 5);
  tube(b, [0, 0, 0], [0, -SUIT.forearm, 0], 0.064, { segments: 10, rims: false });
  // Glove.
  b.paint(rgb('metalLight'));
  b.with(place(0, -SUIT.forearm - 0.13, 0.01), () => box(b, [0.09, 0.14, 0.1]));
  return b;
}

function thighMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.paint(rgb('shell'));
  sphere(b, 0.1, -0.03, 10, 5);
  tube(b, [0, 0, 0], [0, -SUIT.thigh, 0], 0.095, { segments: 10, rims: false });
  // Orange knee pad.
  b.paint(rgb('orange'));
  b.with(place(0, -SUIT.thigh + 0.02, 0.07), () => box(b, [0.13, 0.12, 0.06]));
  return b;
}

function shinMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.paint(rgb('shell'));
  sphere(b, 0.088, 0, 10, 5);
  tube(b, [0, 0, 0], [0, -SUIT.shin, 0], 0.085, { segments: 10, rims: false });
  // Boot and a dark sole: the sole touches y = 0 of the figure when the leg is straight.
  const footY = -(SUIT.hip - SUIT.thigh);
  b.paint(rgb('metalLight'));
  b.with(place(0, footY + 0.03, 0.04), () => box(b, [0.15, 0.11, 0.28]));
  b.paint(rgb('metal'));
  b.with(place(0, footY, 0.04), () => box(b, [0.16, 0.03, 0.3]));
  return b;
}

/** The skeleton of a suit (joint positions in the parent's frame). */
export const SUIT_SKELETON = new Skeleton([
  { name: 'body', parent: -1, joint: [0, SUIT.hip, 0] },
  { name: 'helmet', parent: 0, joint: [0, SUIT.collarY, 0] },
  { name: 'arm.l', parent: 0, joint: [SUIT.shoulderX, SUIT.shoulderY, 0] },
  { name: 'hand.l', parent: 2, joint: [0, -SUIT.upperArm, 0] },
  { name: 'arm.r', parent: 0, joint: [-SUIT.shoulderX, SUIT.shoulderY, 0] },
  { name: 'hand.r', parent: 4, joint: [0, -SUIT.upperArm, 0] },
  { name: 'leg.l', parent: 0, joint: [SUIT.hipX, 0, 0] },
  { name: 'foot.l', parent: 6, joint: [0, -SUIT.thigh, 0] },
  { name: 'leg.r', parent: 0, joint: [-SUIT.hipX, 0, 0] },
  { name: 'foot.r', parent: 8, joint: [0, -SUIT.thigh, 0] },
]);
const BODY = 0, HELMET = 1, ARM_L = 2, HAND_L = 3, ARM_R = 4, HAND_R = 5, LEG_L = 6, FOOT_L = 7, LEG_R = 8, FOOT_R = 9;

/** The part sets of `count` astronauts (one record per figure and bone) and the table bone → record per figure. */
export interface AstronautParts {
  sets: InstanceSet[];
  figures: BoneInstances[];
}

export function astronauts(count: number): AstronautParts {
  const set = (name: string, mesh: MeshBuilder, per: number): InstanceSet => {
    const s = instanceSet(mesh.build(), count * per, { name });
    // Every record with a white tint; `BoneInstances` writes only the transforms.
    for (let i = 0; i < s.capacity; i++) pushInstance(s, IDENTITY);
    return s;
  };
  const body = set('suit body', bodyMesh(), 1);
  const helmet = set('suit helmet', helmetMesh(), 1);
  const arm = set('suit arm', upperArmMesh(), 2);
  const hand = set('suit forearm', forearmMesh(), 2);
  const leg = set('suit thigh', thighMesh(), 2);
  const foot = set('suit shin', shinMesh(), 2);
  const figures: BoneInstances[] = [];
  for (let i = 0; i < count; i++) {
    figures.push(
      new BoneInstances([
        { bone: BODY, set: body, record: i },
        { bone: HELMET, set: helmet, record: i },
        { bone: ARM_L, set: arm, record: i * 2 },
        { bone: HAND_L, set: hand, record: i * 2 },
        { bone: ARM_R, set: arm, record: i * 2 + 1 },
        { bone: HAND_R, set: hand, record: i * 2 + 1 },
        { bone: LEG_L, set: leg, record: i * 2 },
        { bone: FOOT_L, set: foot, record: i * 2 },
        { bone: LEG_R, set: leg, record: i * 2 + 1 },
        { bone: FOOT_R, set: foot, record: i * 2 + 1 },
      ]),
    );
  }
  return { sets: [body, helmet, arm, hand, leg, foot], figures };
}

/** What the motions of a figure read besides their phase: the animation time and the idle stance's rhythm. */
export interface FigureInput {
  time: number;
  /** Shifts the idle rhythm so two figures do not breathe together. */
  seed: number;
  /** 0–1: the right arm raised toward something in front (a hand held out while talking). */
  gesture: number;
}

/** A bone turned about x, then y, then z at its joint (the local rotation Rx · Ry · Rz). */
const turn = (out: Pose, bone: number, x: number, y = 0, z = 0): void => setBoneEuler(out, bone, x, y, z, 'xyz');

/**
 * The walk cycle, one pass per stride (two steps; `t` the share of it): legs swing from the hips, the knee bends while
 * its leg swings forward, arms swing against the legs, the body sinks a little while both legs are spread (so the feet
 * stay down) and twists with the step. Rotation about +x by a negative angle swings a hanging limb forward. Marks: a
 * foot touching down when its leg is furthest forward.
 */
export const walkMotion: MotionSource<FigureInput> = {
  unit: 'phase',
  marks: [
    { name: 'step.l', at: 0.25 },
    { name: 'step.r', at: 0.75 },
  ],
  sample(out, t) {
    const phase = t * Math.PI * 2;
    const s = Math.sin(phase), c = Math.cos(phase);
    const A = 0.42;
    out.offset[BODY * 3 + 1] = -0.075 * Math.abs(s);
    turn(out, BODY, 0.06, 0.07 * s);
    turn(out, HELMET, -0.06, -0.06 * s);
    turn(out, LEG_L, -A * s);
    turn(out, FOOT_L, 0.08 + 0.75 * Math.max(0, c));
    turn(out, LEG_R, A * s);
    turn(out, FOOT_R, 0.08 + 0.75 * Math.max(0, -c));
    turn(out, ARM_L, 0.36 * s, 0, 0.12);
    turn(out, HAND_L, -0.35);
    turn(out, ARM_R, -0.36 * s, 0, -0.12);
    turn(out, HAND_R, -0.35);
  },
};

/**
 * Standing at the animation time: breathing, a slow weight shift, the head looking round and, with `gesture`, the
 * right arm raised toward something in front.
 */
export const idleMotion: MotionSource<FigureInput> = {
  sample(out, _t, f) {
    const t = f.time, seed = f.seed, g = f.gesture;
    out.offset[BODY * 3 + 1] = -0.006 * (1 + Math.sin(t * 1.7 + seed));
    turn(out, BODY, 0, 0.05 * Math.sin(t * 0.21 + seed * 2), 0.025 * Math.sin(t * 0.45 + seed));
    turn(out, HELMET, -0.05 + 0.05 * Math.sin(t * 0.31 + seed), 0.45 * Math.sin(t * 0.17 + seed) * (1 - 0.6 * g));
    turn(out, LEG_L, -0.04, 0, 0.03);
    turn(out, FOOT_L, 0.06);
    turn(out, LEG_R, 0.05, 0, -0.03);
    turn(out, FOOT_R, 0.06);
    turn(out, ARM_L, 0.05, 0, 0.14 + 0.02 * Math.sin(t * 1.7 + seed));
    turn(out, HAND_L, -0.3);
    turn(out, ARM_R, 0.05 - 1.25 * g, 0, -0.14 - 0.35 * g);
    turn(out, HAND_R, -0.3 - 0.45 * g);
  },
};

/**
 * The motion of a suit: the idle stance, and over it the walk cycle with the weight `walk` (0–1, from the speed),
 * its phase following `distance` (metres walked) so the feet never slide.
 */
export const SUIT_MOTION = compileMotionGraph<FigureInput>({
  skeleton: SUIT_SKELETON,
  params: { distance: 0, walk: 0 },
  layers: [
    { name: 'stand', states: [{ name: 'idle', source: idleMotion }] },
    { name: 'walk', weight: 'walk', states: [{ name: 'walk', source: walkMotion, drive: { param: 'distance', per: SUIT.stride } }] },
  ],
});

/** The placement of a figure: feet at `at`, facing `heading` radians (0: +z). */
export function figureRoot(at: V3, heading: number): Mat {
  return place(at[0], at[1], at[2], heading);
}
