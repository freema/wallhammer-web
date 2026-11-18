// Small vector helpers and short names for the engine's 3 × 4 transforms (`mat34*` in base: column-major, the linear
// part column by column, then the translation; the record the engine's instance sets use, so a builder transform can
// be written into an instance record as it is).

import { mat34Multiply, mat34Normal, mat34Point, mat34RotationX, mat34RotationY, mat34RotationZ, mat34Scaling, mat34Translation } from 'wallhammer-web/base';

export type V3 = readonly [number, number, number];
/** A 3 × 4 transform (12 numbers). */
export type Mat = ArrayLike<number>;

export const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export const translate = (x: number, y: number, z: number): Mat => mat34Translation(x, y, z);
/** Rotation about +y by `a` radians (x turns toward −z). */
export const rotateY = (a: number): Mat => mat34RotationY(a);
export const rotateX = (a: number): Mat => mat34RotationX(a);
export const rotateZ = (a: number): Mat => mat34RotationZ(a);
export const scale = (x: number, y = x, z = x): Mat => mat34Scaling(x, y, z);

/** `a` then `b` applied to a point is `compose(b, a)`; reads left to right as world ← local. */
export function compose(...ms: Mat[]): Mat {
  let r: Mat = IDENTITY;
  for (const m of ms) r = mat34Multiply(r, m);
  return r;
}

/** Placement on the ground: at (x, y, z), turned by `yaw` radians about +y. */
export function place(x: number, y: number, z: number, yaw = 0): Mat {
  return compose(translate(x, y, z), rotateY(yaw));
}

export const transformPoint = (m: Mat, p: V3): [number, number, number] => mat34Point(m, p[0], p[1], p[2], [0, 0, 0]);

/** A normal through the inverse transpose, normalised; mirrored transforms keep the outward side. */
export const transformNormal = (m: Mat, n: V3): [number, number, number] => mat34Normal(m, n[0], n[1], n[2], [0, 0, 0]);

export function cross(a: V3, b: V3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function sub(a: V3, b: V3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: V3, b: V3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function mulS(a: V3, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function normalize(a: V3): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
