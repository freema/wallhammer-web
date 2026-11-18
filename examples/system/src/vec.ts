// Small vector helpers of the system example. Pure; used by the page and by the flights.

import type { Vec3 } from 'wallhammer-web/base';

export type V3 = readonly [number, number, number];
export const ZERO: V3 = [0, 0, 0];
export const UP_Y: V3 = [0, 1, 0];

export const sub = (a: V3, b: V3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: V3, b: V3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** The unit direction of `a`, or `fallback` where `a` has no length. */
export const unit = (a: V3, fallback: V3 = UP_Y): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [fallback[0], fallback[1], fallback[2]];
};
/** 0 below 0, 1 above 1, smooth between. */
export const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
/** The unit direction a share `w` of the way from `a` to `b`. */
export const blend = (a: V3, b: V3, w: number): Vec3 => unit([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w], a);
/** A unit direction across `a`. */
export const across = (a: V3): Vec3 => unit(cross3(a, Math.abs(a[1]) < 0.9 ? UP_Y : [1, 0, 0]));
/** The part of `a` across the unit direction `n`. */
export const reject = (a: V3, n: V3): Vec3 => {
  const d = dot3(a, n);
  return [a[0] - n[0] * d, a[1] - n[1] * d, a[2] - n[2] * d];
};
/** The unit direction `a` turned by an angle toward the unit direction `side` across it. */
export const turned = (a: V3, side: V3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a[0] * c + side[0] * s, a[1] * c + side[1] * s, a[2] * c + side[2] * s];
};
/** The unit direction the share `t` of the angle round from `a` to `b` (both unit). */
export function slerp(a: V3, b: V3, t: number): Vec3 {
  if (t <= 0) return [a[0], a[1], a[2]];
  if (t >= 1) return [b[0], b[1], b[2]];
  const angle = Math.acos(Math.min(1, Math.max(-1, dot3(a, b))));
  if (angle < 1e-6) return [a[0], a[1], a[2]];
  if (Math.PI - angle < 1e-3) {
    // Opposite directions have no shortest way between them: by way of a direction across.
    const side = across(a);
    return t < 0.5 ? slerp(a, side, t * 2) : slerp(side, b, t * 2 - 1);
  }
  const s = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / s;
  const wb = Math.sin(t * angle) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}
