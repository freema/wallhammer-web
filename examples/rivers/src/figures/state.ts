// One figure in one frame, and the kinds there are: a record that says everything a figure shows (its kind, its look,
// where it stands and which way it faces, a motion and the seconds into it), so the page can pose its figures as a
// pure function of the time and show any frame again exactly. Plain data and pure functions: this file runs in Node
// too (the walkers and their checks read it); the layer that draws the records is cast.ts.

import type { Vec3 } from 'wallhammer-web/base';
import type { FigureKind } from '../../../shared/src/figures/kind.ts';
import { PATHFINDERS } from '../../../shared/src/figures/pathfinder.ts';

const BUILDERS = { ...PATHFINDERS } as const;
export type FigureKindName = keyof typeof BUILDERS;
export const FIGURE_KINDS = Object.keys(BUILDERS) as FigureKindName[];

const built = new Map<FigureKindName, FigureKind>();
/** The description of a kind (built once: skeleton, meshes, motions, anchors). */
export function figureKind(name: FigureKindName): FigureKind {
  let k = built.get(name);
  if (!k) built.set(name, (k = BUILDERS[name]()));
  return k;
}

/** One figure in one frame. */
export interface FigureState {
  kind: FigureKindName;
  /** The look (`figureKind(kind).look(variant)`). Default 0. */
  variant?: number;
  /** World position of the figure's place: the ground under it. */
  position: Vec3;
  /** Where it faces; need not be exactly square to `up`. */
  forward: Vec3;
  up: Vec3;
  /** A motion of the kind (`figureKind(kind).motions`) and the seconds into it. */
  motion: string;
  time: number;
  /** A second motion laid over the first by `weight` 0–1. */
  blend?: { motion: string; time: number; weight: number };
  /** 0–1, fixed per figure: shifts idle rhythms. Default 0. */
  seed?: number;
  /** The motion's free number (see the motion). Default 0. */
  param?: number;
  /** Size against the kind's own. Default 1. */
  scale?: number;
  /** Brightness of the figure's lights (lantern, torch). Default 1. */
  glow?: number;
}
