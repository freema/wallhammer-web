// Stage 5 of Hearth: the shade of the relief. Every point of the surface carries four bytes that tell how high the
// skyline round it stands toward four directions (the engine's `horizonField` over the plan's `relief`, the sea as its
// floor), so a shader knows without any work per frame whether the sun is hidden there. A pure function of the plan
// and the point: no seed of its own, no cell, level, thread or order, so a vertex gets the same bytes from every cell
// and at every level. Works on any thread; one field (with its table of node codes) per plan and thread.

import { horizonCodeAt, horizonField } from 'wallhammer-web/gen-plan';
import type { HorizonField } from 'wallhammer-web/gen-plan';
import type { WorldPlan } from './plan.ts';

/**
 * Reach of the skyline (m), samples along each of its four directions, the floor of the heights (m: the sea) and the
 * half-width of the edge of the shade in units of the sun's sine (for `horizonLit` in the shaders).
 */
export const SHADE = { reachM: 20_000, steps: 32, floorM: 0, soft: 0.02 } as const;

/** Metres per unit of `relief`. */
const RELIEF_UNIT_M = 0.5;

const fields = new WeakMap<WorldPlan, HorizonField>();

/** The horizon field of a plan in this thread (made on first use). */
export function shadeField(plan: WorldPlan): HorizonField {
  let f = fields.get(plan);
  if (!f) {
    f = horizonField(plan.grid, plan.relief, RELIEF_UNIT_M, { reachM: SHADE.reachM, steps: SHADE.steps, floorM: SHADE.floorM });
    fields.set(plan, f);
  }
  return f;
}

/** The four skyline codes of the point (x, y, z) (any length, not zero), written to `out`. */
export function shadeCodeAt(plan: WorldPlan, x: number, y: number, z: number, out: Uint8Array): void {
  horizonCodeAt(shadeField(plan), x, y, z, out);
}
