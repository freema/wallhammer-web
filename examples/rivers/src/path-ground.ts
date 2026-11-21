// The tread of the paths in the ground: where a path runs, the ground beside its centreline is brought to the height
// of the path, so a path across a slope lies on a narrow bench and not on the tilted hillside. A step on the field of
// the whole square, before the meshes are made from it.
//
// The change is small by construction: a path's height is the ground under its own centreline, eased along the path.
// Near water nothing is moved: a point under the level named there, or within `DRY_M` over it, keeps its ground, and
// no point is brought nearer to it than that, so a path never makes or drains water. In a ford the path has no tread at all.

import type { Field } from './field.ts';
import { smooth } from './land.ts';
import { pathAt, type PathHit, type PathPlan } from './paths.ts';

/** The ground is at the path's height up to this far from the centreline and its own again from the second, metres. */
const TREAD_M = 1.2;
const SHOULDER_M = 4.2;
/** The ground of a point with a named level is moved only while it stays this far over that level, metres. */
const DRY_M = 0.5;

/** Brings the ground of the field to the paths' treads, in place. */
export function layPaths(f: Field, paths: PathPlan): void {
  const { n, step, x0, z0, ground, water } = f;
  const hit: PathHit = { d: 0, ox: 0, oz: 0, y: 0, ford: 0, path: 0, i: 0, t: 0 };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      if (!pathAt(paths, x0 + i * step, z0 + j * step, hit) || hit.d >= SHOULDER_M) continue;
      const k = j * n + i;
      const g = ground[k]!;
      // The level named at the point: the sea's where the field names none.
      const level = water[k]!;
      if (g < level + DRY_M) continue;
      const w = (1 - smooth(TREAD_M, SHOULDER_M, hit.d)) * (1 - hit.ford);
      const to = Math.max(g + (hit.y - g) * w, level + DRY_M);
      ground[k] = to;
    }
}
