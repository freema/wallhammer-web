// What a kind of figure is: a skeleton of the engine's motion module, one rigid mesh per bone (or none), motions that
// are pure functions of a time in seconds, named anchors on bones (a lantern, a saddle, a wisp of smoke) and the
// looks of its variants. A kind may also name its arms and its gaze as chains of the engine's post steps, sockets on
// its bones where held things sit, and the meshes of such things (props), which are drawn apart from its parts.
//
// The motions are `MotionSource`s of `wallhammer-web/motion` driven by the clock (`unit` seconds): the page gives each
// figure a motion name and a motion time, and the pose follows from them alone. A walk also names the metres one pass
// covers (`strideM`): a figure moved at `strideM / duration` metres a second does not slide.

import type { MeshData } from 'wallhammer-web/base';
import { Skeleton, setBoneEuler } from 'wallhammer-web/motion';
import type { AimChain, BoneSpec, LagChain, MotionSource, Pose, Socket, TwoBoneChain } from 'wallhammer-web/motion';
import { FigureMesh } from './mesh.ts';
import type { P, RGB } from './mesh.ts';

/** What a motion reads besides its time. */
export interface FigureInput {
  /** 0–1, fixed per figure: shifts rhythms so two figures do not move together. */
  seed: number;
  /** A free number of the motion, −1 to 1 (the side of a bank, the end of a carried log). */
  param: number;
}

export interface FigureMotion extends MotionSource<FigureInput> {
  /** Metres travelled in one pass of a walk. */
  readonly strideM?: number;
  /** Bones whose parts are not drawn in this motion. */
  readonly hide?: readonly number[];
}

export interface FigureAnchor {
  bone: number;
  /** In the bone's frame. */
  at: P;
}

export interface FigureKind {
  readonly name: string;
  readonly skeleton: Skeleton;
  /** The rigid parts: each a mesh in the frame of its bone. A bone may carry several (one per colour slot and feature). */
  readonly parts: readonly FigurePart[];
  readonly motions: Readonly<Record<string, FigureMotion>>;
  readonly anchors: Readonly<Record<string, FigureAnchor>>;
  /** The look of a variant (any integer): the colour of every slot and the features shown. Pure. */
  look(variant: number): FigureLook;
  /** Height of the standing figure, m. */
  readonly heightM: number;
  /** Records kept for the kind (the most figures of it in one frame). */
  readonly capacity: number;
  /** A figure of the kind casts a shadow while one of them is nearer to the eye than this, m. 0: never. */
  readonly shadowRangeM: number;
  /**
   * The legs as chains of the engine's reach (hip, knee, ankle), for keeping the feet on uneven ground
   * (`fitToGround`); `pelvis` is the bone lowered when a foot must reach down. Absent: the kind has no such legs.
   */
  readonly legs?: { chains: readonly TwoBoneChain[]; pelvis: number };
  /**
   * The arms as chains of the engine's reach (shoulder, elbow, wrist), each with a point in the figure's frame the
   * elbow turns toward (`TwoBoneReach.pole`). Absent: the arms do not reach.
   */
  readonly arms?: { left: FigureArm; right: FigureArm };
  /** Trunk and head as a chain that turns to look at a point (`aimChain`). */
  readonly gaze?: AimChain;
  /** Chains of bones that may lag behind the figure's motion (a ponytail, a scarf's end): `ChainLag` of the engine. */
  readonly lag?: readonly LagChain[];
  /** Places on bones where held things sit: a 3 × 4 transform in the bone's frame each (`socketTransform`). */
  readonly sockets?: Readonly<Record<string, Socket>>;
  /** Things a figure of the kind can hold: a mesh each, in the frame of the socket that holds it. Not in `parts`. */
  readonly props?: Readonly<Record<string, MeshData>>;
}

/** One arm of a kind. */
export interface FigureArm {
  chain: TwoBoneChain;
  /** In the figure's frame (at the kind's size): the elbow turns toward it. */
  pole: P;
}

/** One rigid part of a kind. */
export interface FigurePart {
  bone: number;
  mesh: MeshData;
  /** Which colour of the look multiplies the vertices painted with `MAT.tint`. */
  slot: number;
  /** 0: always drawn; otherwise drawn when the look has one of these feature bits. */
  feature: number;
}

/** What tells two figures of a kind apart: a colour per slot and a set of feature bits (a hood, a kind of hair). */
export interface FigureLook {
  colors: readonly RGB[];
  features: number;
}

/** The looks of a kind whose variants differ by one tint only. */
export const tints = (list: readonly RGB[]): ((variant: number) => FigureLook) => {
  const looks = list.map((c): FigureLook => ({ colors: [c], features: 0 }));
  return (v) => looks[((Math.trunc(v) % looks.length) + looks.length) % looks.length]!;
};

/** Bones by name with their rest joints in the figure's frame, for the meshes and the motions of one kind. */
export class Bones<N extends string> {
  readonly skeleton: Skeleton;
  readonly id: Readonly<Record<N, number>>;
  /** Rest position of every joint in the figure's frame. */
  readonly rest: readonly P[];
  private readonly made = new Map<string, { bone: number; slot: number; feature: number; mesh: FigureMesh }>();
  private readonly seed: number;
  private readonly size: number;

  /**
   * `[name, parent or null, joint in the figure's rest frame]`, parents first. `size` enlarges the whole figure: joints,
   * parts and anchors are written at the authored size and come out `size` times as big.
   */
  constructor(seed: number, bones: readonly (readonly [N, N | null, P])[], size = 1) {
    this.size = size;
    const id = {} as Record<N, number>;
    const rest: P[] = [];
    const specs: BoneSpec[] = bones.map(([name, parent, at], i) => {
      id[name] = i;
      rest.push(at);
      const p = parent === null ? -1 : id[parent];
      const from: P = p < 0 ? [0, 0, 0] : rest[p]!;
      return { name, parent: p, joint: [(at[0] - from[0]) * size, (at[1] - from[1]) * size, (at[2] - from[2]) * size] };
    });
    this.skeleton = new Skeleton(specs);
    this.id = id;
    this.rest = rest;
    this.seed = seed;
  }

  /**
   * The mesh of a part on a bone, written in the figure's rest frame. `slot` is the colour of the look its tinted
   * vertices take, `feature` the bits of the look that show it (0: always).
   */
  part(name: N, slot = 0, feature = 0): FigureMesh {
    const i = this.id[name];
    const key = `${i}:${slot}:${feature}`;
    let p = this.made.get(key);
    if (!p) this.made.set(key, (p = { bone: i, slot, feature, mesh: new FigureMesh(this.seed * 131 + i + 17 * slot + 29 * feature) }));
    return p.mesh.origin(this.rest[i]!);
  }

  parts(): FigurePart[] {
    return [...this.made.values()].filter((p) => !p.mesh.empty).map((p) => ({ bone: p.bone, slot: p.slot, feature: p.feature, mesh: p.mesh.mesh(this.size) }));
  }

  /** A point of the rest frame in the frame of a bone. */
  local(name: N, at: P): FigureAnchor {
    const i = this.id[name];
    const r = this.rest[i]!;
    const k = this.size;
    return { bone: i, at: [(at[0] - r[0]) * k, (at[1] - r[1]) * k, (at[2] - r[2]) * k] };
  }
}

/** Turns a bone about its x, then y, then z (Rx · Ry · Rz). About +x a negative angle swings a hanging limb forward. */
export const turn = (pose: Pose, bone: number, x: number, y = 0, z = 0): void => setBoneEuler(pose, bone, x, y, z, 'xyz');
/** Moves a bone's joint. */
export const shift = (pose: Pose, bone: number, x: number, y: number, z: number): void => {
  pose.offset[bone * 3] = x;
  pose.offset[bone * 3 + 1] = y;
  pose.offset[bone * 3 + 2] = z;
};

export const TAU = Math.PI * 2;
export const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
