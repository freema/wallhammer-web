// "Up" that depends on the place. A flat world has one up, +y. A world wrapped round a point has an up that points
// away from that point (`RadialUp`); the renderer then hands the point to every shader, which asks `localUp(p)` and
// `localFrame(p)` instead of assuming +y. The functions here are the CPU side of the same definitions, so a position
// or a heading computed on the CPU and one computed in a shader agree.

import type { Vec3 } from './math.ts';

/** Up points away from `center` (world metres, double); `radiusM` is the radius of the base surface around it. */
export interface RadialUp {
  readonly center: readonly [number, number, number];
  readonly radiusM: number;
}

/** Three unit axes of a local frame, as world directions: `y` is up, `x` and `z` span the horizon. */
export interface UpFrame {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** Unit direction from `center` to `p` (+y when the two coincide). */
export function radialUpAt(center: readonly [number, number, number], p: readonly [number, number, number]): Vec3 {
  const x = p[0] - center[0];
  const y = p[1] - center[1];
  const z = p[2] - center[2];
  const l = Math.sqrt(x * x + y * y + z * z);
  return l > 0 ? [x / l, y / l, z / l] : [0, 1, 0];
}

/** Height of `p` above the base surface of a radial up. */
export function radialHeight(up: RadialUp, p: readonly [number, number, number]): number {
  const x = p[0] - up.center[0];
  const y = p[1] - up.center[1];
  const z = p[2] - up.center[2];
  return Math.sqrt(x * x + y * y + z * z) - up.radiusM;
}

/**
 * The local frame for a unit up direction: the world axes turned by the shortest rotation that takes +y to `up`, so
 * for up = +y it is the world's own axes. Exactly the shader's `localFrame`. Opposite to +y (within 1e-5 of the
 * cosine) the shortest rotation is not defined and the frame is the world turned half round about x.
 *
 * A heading stored as two numbers (x, z), as instance records do, means `x · frame.x + z · frame.z` here.
 */
export function upFrame(up: readonly [number, number, number]): UpFrame {
  const [ux, uy, uz] = up;
  if (uy < -0.99999) return { x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] };
  // k = 1 / (1 + uy). Below the horizon it is taken as (1 − uy) / (ux² + uz²), the same number for a unit vector:
  // 1 + uy loses its digits near −y (an up that went through 32-bit floats would shear the frame by a percent).
  const h = ux * ux + uz * uz;
  const k = uy > 0 || h === 0 ? 1 / (1 + uy) : (1 - uy) / h;
  return { x: [1 - ux * ux * k, -ux, -ux * uz * k], y: [ux, uy, uz], z: [-ux * uz * k, -uz, 1 - uz * uz * k] };
}

/** A world direction as the (x, z) pair of a local frame (its part along up is dropped): the inverse of the note above. */
export function toFramePlane(frame: UpFrame, dir: readonly [number, number, number]): [number, number] {
  return [frame.x[0] * dir[0] + frame.x[1] * dir[1] + frame.x[2] * dir[2], frame.z[0] * dir[0] + frame.z[1] * dir[1] + frame.z[2] * dir[2]];
}
