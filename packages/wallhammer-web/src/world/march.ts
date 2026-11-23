// A ray marched against a signed gap function: `gap(p)` is the distance from a point to a surface, positive on the
// eye's side, zero or below behind it. Unlike `raycastHeightField`, which walks a sampled grid, this asks a function,
// so it works for any surface a caller can measure (a height function over a sphere, a level, the lower of two).
// The step is a share of the gap (safe for slopes up to about atan(1 / share)) and never shorter than a floor that
// grows with the distance, so a far surface costs a bounded number of steps; the first step that crosses the surface
// is halved down to a tolerance. Pure: no DOM, no GPU, no allocation per step beyond the point it hands to `gap`.

import type { Ray, Vec3 } from '../base/index.ts';

/** Options of `marchRay`. */
export interface RayMarchOptions {
  /** Farthest distance along the ray that is looked at, in metres. */
  maxDistanceM: number;
  /** Share of the gap taken as one step (default 0.35). Smaller is safer on steep surfaces and costs more steps. */
  gapShare?: number;
  /** Least step in metres (default 0.05). */
  minStepM?: number;
  /** Least step per metre of distance (default 2e-4): a feature thinner than this share of its distance can be stepped over. */
  stepPerM?: number;
  /** The halving stops when the bracket is shorter than this, in metres (default 0.005). */
  toleranceM?: number;
  /** Most evaluations of `gap` before giving up (default 50 000). */
  maxSteps?: number;
  /** True when the ray can no longer meet the surface from `p` at distance `t` on (it climbs away above everything). */
  escaped?(p: Vec3, t: number): boolean;
}

/** Where `marchRay` met the surface. */
export interface RayMarchHit {
  /** Distance along the ray in metres. */
  distanceM: number;
  /** The point at that distance. */
  point: Vec3;
  /** Evaluations of `gap`, the halving included. */
  steps: number;
  /** Length of the last step before the halving, in metres: how coarse the search was where it found the surface. */
  lastStepM: number;
}

function along(r: Ray, t: number): Vec3 {
  return [r.origin[0] + r.dir[0] * t, r.origin[1] + r.dir[1] * t, r.origin[2] + r.dir[2] * t];
}

/**
 * The first point of `ray` (its `dir` a unit vector) where `gap` reaches 0 or below, or null when there is none within
 * `maxDistanceM`, when `escaped` says so or when the steps run out. A ray that starts at or behind the surface hits at
 * distance 0. A part of the surface thinner than one step (a thin wall, a narrow ridge) can be missed.
 */
export function marchRay(ray: Ray, gap: (p: Vec3) => number, options: RayMarchOptions): RayMarchHit | null {
  const share = options.gapShare ?? 0.35;
  const minStep = options.minStepM ?? 0.05;
  const perM = options.stepPerM ?? 2e-4;
  const tol = options.toleranceM ?? 0.005;
  const maxSteps = options.maxSteps ?? 50_000;
  let t = 0;
  let g = gap(along(ray, 0));
  let steps = 1;
  if (!(g > 0)) return { distanceM: 0, point: along(ray, 0), steps, lastStepM: 0 };
  while (steps < maxSteps && t < options.maxDistanceM) {
    const tn = Math.min(options.maxDistanceM, t + Math.max(minStep, perM * t, share * g));
    const p = along(ray, tn);
    const gn = gap(p);
    steps++;
    if (!(gn > 0)) {
      // The surface lies in [t, tn]: the gap is positive at t and not at tn.
      let lo = t;
      let hi = tn;
      while (hi - lo > tol && steps < maxSteps + 64) {
        const mid = 0.5 * (lo + hi);
        if (gap(along(ray, mid)) > 0) lo = mid;
        else hi = mid;
        steps++;
      }
      return { distanceM: hi, point: along(ray, hi), steps, lastStepM: tn - t };
    }
    if (options.escaped?.(p, tn)) return null;
    t = tn;
    g = gn;
  }
  return null;
}
