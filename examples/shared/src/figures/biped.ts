// What the pathfinder shares with any two-legged figure: the two sides, the bones of a biped, the walk cycle and its
// step marks, and a kite (a lock of hair, a fringe).
// Shapes in metres in the rest pose: x to the figure's left, y up, z forward.

import type { Pose } from 'wallhammer-web/motion';
import { TAU, shift, turn } from './kind.ts';
import type { FigureMesh, P } from './mesh.ts';

/** The two sides of a figure: +1 its left, −1 its right. */
export const SIDES = [1, -1] as const;

/** The bones every two-legged figure has, by index. */
export interface Biped {
  root: number;
  torso: number;
  head: number;
  armL: number;
  foreL: number;
  armR: number;
  foreR: number;
  legL: number;
  shinL: number;
  legR: number;
  shinR: number;
}
interface Gait {
  swing: number;
  knee: number;
  arm: number;
  elbow: number;
  bob: number;
  lean: number;
  twist: number;
}
/**
 * A walk cycle at the share `ph` of one pass (two steps): the legs swing from the hips, a knee bends while its leg
 * comes forward, the arms swing against the legs, the body sinks while the legs are spread and twists with the step.
 */
export function stride(pose: Pose, b: Biped, ph: number, g: Gait): void {
  const s = Math.sin(ph * TAU), c = Math.cos(ph * TAU);
  shift(pose, b.root, 0, -g.bob * Math.abs(s), 0);
  turn(pose, b.torso, g.lean, g.twist * s);
  turn(pose, b.head, -g.lean * 0.7, -g.twist * s);
  turn(pose, b.legL, -g.swing * s);
  turn(pose, b.shinL, 0.08 + g.knee * Math.max(0, c));
  turn(pose, b.legR, g.swing * s);
  turn(pose, b.shinR, 0.08 + g.knee * Math.max(0, -c));
  turn(pose, b.armL, g.arm * s, 0, 0.1);
  turn(pose, b.foreL, -g.elbow);
  turn(pose, b.armR, -g.arm * s, 0, -0.1);
  turn(pose, b.foreR, -g.elbow);
}
export const STEPS = [
  { name: 'step.l', at: 0.25 },
  { name: 'step.r', at: 0.75 },
] as const;

/** A leaf or a rag: a kite from `a` to `b`, `w` wide at the share `at` of its length, bulged by `out` along `n`. */
export function kite(m: FigureMesh, a: P, b: P, w: number, n: P, at = 0.4, out = 0.02): void {
  const d: P = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const side: P = [(d[1] * n[2] - d[2] * n[1]) / l, (d[2] * n[0] - d[0] * n[2]) / l, (d[0] * n[1] - d[1] * n[0]) / l];
  const mid: P = [a[0] + d[0] * at + n[0] * out, a[1] + d[1] * at + n[1] * out, a[2] + d[2] * at + n[2] * out];
  const l1: P = [mid[0] + side[0] * w * 0.5, mid[1] + side[1] * w * 0.5, mid[2] + side[2] * w * 0.5];
  const r1: P = [mid[0] - side[0] * w * 0.5, mid[1] - side[1] * w * 0.5, mid[2] - side[2] * w * 0.5];
  m.both(a, l1, mid);
  m.both(a, mid, r1);
  m.both(l1, b, mid);
  m.both(mid, b, r1);
}
