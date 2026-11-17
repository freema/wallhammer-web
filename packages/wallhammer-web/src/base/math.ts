// The smallest necessary vector math. Matrices are 4×4 column-major, as WebGL wants them.

export type Vec3 = [number, number, number];

/** Colour as three numbers 0–1. */
export type RGB = readonly [number, number, number];

export const DEG = Math.PI / 180;

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** `cross` written into `out` (which may not be `a` or `b`); returns `out`. */
export function crossInto(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  return out;
}

export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Orthographic camera with no perspective, given by three axes. */
export interface OrthoFrame {
  right: Vec3;
  up: Vec3;
  /** View direction, from the camera into the scene. */
  forward: Vec3;
}

/**
 * World → clip space matrix for orthographic projection.
 * Point p lands at x = (right·p − cx) / halfW, y = (up·p − cy) / halfH, z = (forward·p − cz) / halfD.
 * With `out` (16 floats) the matrix is written there and `out` is returned.
 */
export function orthoMatrix(f: OrthoFrame, cx: number, cy: number, cz: number, halfW: number, halfH: number, halfD: number, out?: Float32Array): Float32Array {
  const m = out ?? new Float32Array(16);
  if (out) m.fill(0);
  const { right: r, up: u, forward: w } = f;
  m[0] = r[0] / halfW;
  m[4] = r[1] / halfW;
  m[8] = r[2] / halfW;
  m[12] = -cx / halfW;
  m[1] = u[0] / halfH;
  m[5] = u[1] / halfH;
  m[9] = u[2] / halfH;
  m[13] = -cy / halfH;
  m[2] = w[0] / halfD;
  m[6] = w[1] / halfD;
  m[10] = w[2] / halfD;
  m[14] = -cz / halfD;
  m[15] = 1;
  return m;
}
