// Integer geometry for decisions: square roots, distances from a point to a convex prism, octants. Every result is an
// exact function of integer input (centimetres), so it is the same on every machine. The one division that could
// leave the exactly representable range runs on BigInt.

import type { ConvexPiece } from '../../base/destructible.ts';

/** Floor of the square root of a non-negative integer below 2^53. Exact: the float estimate is corrected with integers. */
export function isqrt(n: number): number {
  if (n < 2) return n < 0 ? 0 : n;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/** Integer division rounded toward zero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Squared distance from point p to the segment a–b in the x, z plane (all integers, result floored). */
function segmentDistSq(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const rx = ax - px;
  const rz = az - pz;
  const ex = bx - ax;
  const ez = bz - az;
  const tNum = -(rx * ex + rz * ez);
  const len2 = ex * ex + ez * ez;
  if (tNum <= 0 || len2 === 0) return rx * rx + rz * rz;
  if (tNum >= len2) {
    const sx = bx - px;
    const sz = bz - pz;
    return sx * sx + sz * sz;
  }
  const cross = BigInt(rx * ez - rz * ex);
  return Number((cross * cross) / BigInt(len2));
}

/** Squared distance from a point to a convex prism, 0 inside. Centimetres in, cm² out. */
export function pieceDistSq(piece: ConvexPiece, px: number, py: number, pz: number): number {
  const dy = py < piece.y0 ? piece.y0 - py : py > piece.y1 ? py - piece.y1 : 0;
  const c = piece.xz;
  const n = c.length / 2;
  let inside = true;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = c[i * 2]!;
    const az = c[i * 2 + 1]!;
    const cross = (c[j * 2]! - ax) * (pz - az) - (c[j * 2 + 1]! - az) * (px - ax);
    if (cross < 0) {
      inside = false;
      break;
    }
  }
  let dxz = 0;
  if (!inside) {
    dxz = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const d = segmentDistSq(c[i * 2]!, c[i * 2 + 1]!, c[j * 2]!, c[j * 2 + 1]!, px, pz);
      if (d < dxz) dxz = d;
    }
  }
  return dxz + dy * dy;
}

/** Centroid of the corners (x, z) and the middle height, integers. */
export function pieceCentre(piece: ConvexPiece): [number, number, number] {
  const c = piece.xz;
  const n = c.length / 2;
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += c[i * 2]!;
    sz += c[i * 2 + 1]!;
  }
  return [idiv(sx, n), idiv(piece.y0 + piece.y1, 2), idiv(sz, n)];
}

/** Longest edge of the polygon as an integer vector. */
export function longestEdge(xz: Int32Array): [number, number] {
  const n = xz.length / 2;
  let best = -1;
  let bx = 1;
  let bz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = xz[j * 2]! - xz[i * 2]!;
    const dz = xz[j * 2 + 1]! - xz[i * 2 + 1]!;
    const l = dx * dx + dz * dz;
    if (l > best) {
      best = l;
      bx = dx;
      bz = dz;
    }
  }
  return [bx, bz];
}

/** Unit vector scaled by 1024, from an integer vector. (1024, 0) for a zero vector. */
export function unit1024(dx: number, dz: number): [number, number] {
  const l = isqrt(dx * dx + dz * dz);
  if (l === 0) return [1024, 0];
  return [idiv(dx * 1024, l), idiv(dz * 1024, l)];
}

/** Compass octant of a direction (0 = +x, counted toward +z), or 8 when the vector is shorter than `minLen`. */
export function octant(dx: number, dz: number, minLen: number): number {
  if (dx * dx + dz * dz < minLen * minLen) return 8;
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  // tan(22.5°) ≈ 0.4142: 2416 / 5832 = 0.41427 (exact integer comparison).
  let o: number;
  if (az * 5832 <= ax * 2416) o = dx >= 0 ? 0 : 4;
  else if (ax * 5832 <= az * 2416) o = dz >= 0 ? 2 : 6;
  else if (dx >= 0) o = dz >= 0 ? 1 : 7;
  else o = dz >= 0 ? 3 : 5;
  return o;
}

/** Octant directions scaled by 1024 (724 ≈ 1024 / √2). */
export const OCTANT_DIRS: readonly (readonly [number, number])[] = [
  [1024, 0],
  [724, 724],
  [0, 1024],
  [-724, 724],
  [-1024, 0],
  [-724, -724],
  [0, -1024],
  [724, -724],
];
