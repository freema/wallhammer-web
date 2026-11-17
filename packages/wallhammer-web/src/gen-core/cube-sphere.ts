// A cube blown up into a sphere: the geometry behind a sphere made of six quadtrees. Every face of the cube carries a
// square grid; a grid point is pushed out along its direction from the centre until it lies on the sphere. Before
// that the grid is warped by the tangent of an angle, so grid lines are equal angles apart and the cells of one level
// differ in edge length by at most about a third (a plain cube grid gives a factor of three).
//
// Faces: 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z. Each has two grid axes u and v with u × v = the outward axis, so a cell's
// `x` index runs along u and its `y` index along v, and a triangle (u, v) winds anticlockwise seen from outside.
//
// Everything is a pure function built from arithmetic, `Math.sqrt` and the reproducible trigonometry of base, and a
// direction is always normalised from its world components in the order x, y, z. A point on an edge shared by two
// faces therefore gets the same bits from either face: content sampled at it has no seam.

import type { Vec3 } from '../base/math.ts';
import { detAtan, detSinCos } from '../base/trig.ts';

type V3 = readonly [number, number, number];

/** Grid axes `u`, `v` and the outward axis `n` of each face of the cube. */
export const CUBE_FACE_AXES: readonly { readonly u: V3; readonly v: V3; readonly n: V3 }[] = [
  { u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
  { u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0] },
  { u: [0, 0, 1], v: [1, 0, 0], n: [0, 1, 0] },
  { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  { u: [0, 1, 0], v: [1, 0, 0], n: [0, 0, -1] },
];

const QUARTER_PI = 0.7853981633974483;
const scratch: [number, number] = [0, 0];

/**
 * Face coordinate (−1 … 1, equal angles) of grid line `g` out of `count` intervals across the face. Line `count − g`
 * gives exactly the negated value, and a line of a finer grid that coincides with this one gives the same bits.
 */
export function cubeGrid(g: number, count: number): number {
  return (2 * g - count) / count;
}

/**
 * The warp: face coordinate (−1 … 1, proportional to the angle from the face's middle) → position on the face of the
 * cube (−1 … 1), `tan(s · π/4)`. Odd, and exactly ±1 at ±1. Defined a little beyond the face as well.
 */
export function cubeWarp(s: number): number {
  const a = Math.abs(s);
  if (a === 1 || a === 0) return s;
  const [sin, cos] = detSinCos(a * QUARTER_PI, scratch);
  let t = sin / cos;
  if (a < 1 && t > 1) t = 1;
  return s < 0 ? -t : t;
}

/** Inverse of `cubeWarp`. */
export function cubeUnwarp(t: number): number {
  return detAtan(t) / QUARTER_PI;
}

/** Unit direction from the centre to the point of `face` at warped coordinates (`cubeWarp` of the face coordinates). */
export function cubeDirectionWarped(face: number, wu: number, wv: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const a = CUBE_FACE_AXES[face]!;
  // Per component exactly one term is not zero, so the sums are exact and the same from every face.
  const x = a.n[0] + a.u[0] * wu + a.v[0] * wv;
  const y = a.n[1] + a.u[1] * wu + a.v[1] * wv;
  const z = a.n[2] + a.u[2] * wu + a.v[2] * wv;
  const l = Math.sqrt(x * x + y * y + z * z);
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

/** Unit direction from the centre to the point of `face` at face coordinates `s`, `t` (−1 … 1). */
export function cubeDirection(face: number, s: number, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  return cubeDirectionWarped(face, cubeWarp(s), cubeWarp(t), out);
}

/** The face a direction points at (the first of x, y, z among equals) and its face coordinates there (−1 … 1). */
export function cubeFaceOf(dir: V3): { face: number; s: number; t: number } {
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  const face = ax >= ay && ax >= az ? (dir[0] >= 0 ? 0 : 1) : ay >= az ? (dir[1] >= 0 ? 2 : 3) : dir[2] >= 0 ? 4 : 5;
  const [s, t] = cubeFaceCoords(face, dir);
  return { face, s: Math.max(-1, Math.min(1, s)), t: Math.max(-1, Math.min(1, t)) };
}

/**
 * Face coordinates of a direction on a given face, not clamped: beyond ±1 the direction points past the face's edge.
 * Only directions on the face's side of the centre have coordinates; for the others the result is [NaN, NaN].
 */
export function cubeFaceCoords(face: number, dir: V3): [number, number] {
  const a = CUBE_FACE_AXES[face]!;
  const along = dir[0] * a.n[0] + dir[1] * a.n[1] + dir[2] * a.n[2];
  if (!(along > 0)) return [NaN, NaN];
  const pu = (dir[0] * a.u[0] + dir[1] * a.u[1] + dir[2] * a.u[2]) / along;
  const pv = (dir[0] * a.v[0] + dir[1] * a.v[1] + dir[2] * a.v[2]) / along;
  return [cubeUnwarp(pu), cubeUnwarp(pv)];
}

/**
 * The cell `dx`, `dy` cells away from cell (`x`, `y`) of `face` at `level`, across an edge of the face if need be.
 * Null when the step leaves the face over a corner of the cube: three faces meet there and no cell lies diagonally.
 *
 * Exact integer geometry: the cell's middle is taken on the cube in half-cell units, the part that sticks out past
 * the face's edge is folded round the edge onto the next face, and that face's indices are read back.
 */
export function cubeNeighbour(face: number, level: number, x: number, y: number, dx: number, dy: number): { face: number; x: number; y: number } | null {
  const n = 2 ** level;
  const nx = x + dx;
  const ny = y + dy;
  const outX = nx < 0 || nx >= n;
  const outY = ny < 0 || ny >= n;
  if (!outX && !outY) return { face, x: nx, y: ny };
  if (outX && outY) return null;
  // Half-cell units: the face spans −n … n along u and v and lies at n along its outward axis.
  let cu = 2 * nx + 1 - n;
  let cv = 2 * ny + 1 - n;
  let cn: number;
  if (outX) {
    cn = 2 * n - Math.abs(cu);
    cu = cu < 0 ? -n : n;
  } else {
    cn = 2 * n - Math.abs(cv);
    cv = cv < 0 ? -n : n;
  }
  // Farther than one whole face away: not a neighbour in any sense.
  if (cn <= -n) return null;
  const a = CUBE_FACE_AXES[face]!;
  const px = a.n[0] * cn + a.u[0] * cu + a.v[0] * cv;
  const py = a.n[1] * cn + a.u[1] * cu + a.v[1] * cv;
  const pz = a.n[2] * cn + a.u[2] * cu + a.v[2] * cv;
  for (let f = 0; f < 6; f++) {
    const b = CUBE_FACE_AXES[f]!;
    if (f === face || px * b.n[0] + py * b.n[1] + pz * b.n[2] !== n) continue;
    return {
      face: f,
      x: (px * b.u[0] + py * b.u[1] + pz * b.u[2] + n - 1) / 2,
      y: (px * b.v[0] + py * b.v[1] + pz * b.v[2] + n - 1) / 2,
    };
  }
  return null;
}

/**
 * Two unit directions across `dir` that depend on `dir` alone (not on a face or a grid): `t1` is square to `dir` and
 * to the world axis `dir` leans on least, `t2 = dir × t1`, so `t1 × t2 = dir`. Differences taken along them give the
 * same result wherever the point is reached from.
 */
export function directionTangents(dir: V3): { t1: Vec3; t2: Vec3 } {
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  let t1: Vec3;
  // axis × dir for the axis with the smallest component.
  if (ax <= ay && ax <= az) t1 = [0, -dir[2], dir[1]];
  else if (ay <= az) t1 = [dir[2], 0, -dir[0]];
  else t1 = [-dir[1], dir[0], 0];
  const l = Math.sqrt(t1[0] * t1[0] + t1[1] * t1[1] + t1[2] * t1[2]);
  t1[0] /= l;
  t1[1] /= l;
  t1[2] /= l;
  const t2: Vec3 = [dir[1] * t1[2] - dir[2] * t1[1], dir[2] * t1[0] - dir[0] * t1[2], dir[0] * t1[1] - dir[1] * t1[0]];
  return { t1, t2 };
}
