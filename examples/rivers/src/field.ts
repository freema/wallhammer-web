// A square grid of samples of the ground and the water (`sampleAt`), shared by the page's meshes and the picture
// script. A pure function of the plan and the square.

import { sampleAt, type Sample } from './ground.ts';
import type { Plan } from './plan.ts';

export interface Field {
  /** World position of the first point (x, z), metres, the spacing of the points and their count along one edge. */
  x0: number;
  z0: number;
  step: number;
  n: number;
  /** Per point, row by row (index j · n + i, x grows with i, z with j): see `Sample`. */
  ground: Float32Array;
  water: Float32Array;
  body: Uint8Array;
  fall: Uint8Array;
  flowX: Float32Array;
  flowZ: Float32Array;
}

/** Samples the square of edge `size` from (x0, z0) every `step` metres, both edges included. */
export function fieldOf(plan: Plan, x0: number, z0: number, size: number, step: number): Field {
  const n = Math.round(size / step) + 1;
  const count = n * n;
  const f: Field = {
    x0,
    z0,
    step,
    n,
    ground: new Float32Array(count),
    water: new Float32Array(count),
    body: new Uint8Array(count),
    fall: new Uint8Array(count),
    flowX: new Float32Array(count),
    flowZ: new Float32Array(count),
  };
  const s: Sample = { ground: 0, water: 0, body: 0, fall: 0, flowX: 0, flowZ: 0 };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      sampleAt(plan, x0 + i * step, z0 + j * step, s);
      const k = j * n + i;
      f.ground[k] = s.ground;
      f.water[k] = s.water;
      f.body[k] = s.body;
      f.fall[k] = s.fall;
      f.flowX[k] = s.flowX;
      f.flowZ[k] = s.flowZ;
    }
  return f;
}

/**
 * The same field as `fieldOf`, sampled one row of points at a time: yields the number of rows done after each row
 * (of `n`) and returns the field. For a caller that spreads the work over several tasks, such as the page with its
 * loading bar; every point is sampled exactly as `fieldOf` samples it, so the result does not depend on where the
 * caller pauses.
 */
export function* fieldRows(plan: Plan, x0: number, z0: number, size: number, step: number): Generator<number, Field, void> {
  const n = Math.round(size / step) + 1;
  const count = n * n;
  const f: Field = {
    x0,
    z0,
    step,
    n,
    ground: new Float32Array(count),
    water: new Float32Array(count),
    body: new Uint8Array(count),
    fall: new Uint8Array(count),
    flowX: new Float32Array(count),
    flowZ: new Float32Array(count),
  };
  const s: Sample = { ground: 0, water: 0, body: 0, fall: 0, flowX: 0, flowZ: 0 };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      sampleAt(plan, x0 + i * step, z0 + j * step, s);
      const k = j * n + i;
      f.ground[k] = s.ground;
      f.water[k] = s.water;
      f.body[k] = s.body;
      f.fall[k] = s.fall;
      f.flowX[k] = s.flowX;
      f.flowZ[k] = s.flowZ;
    }
    yield j + 1;
  }
  return f;
}

/** Number of rows (and of points along one edge) of the field `fieldOf` and `fieldRows` make for the same square. */
export function fieldSize(size: number, step: number): number {
  return Math.round(size / step) + 1;
}
