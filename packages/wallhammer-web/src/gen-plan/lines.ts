// Lines over a sphere as unit directions: smoothing that keeps the ends, a profile that never rises, lengths along
// great arcs, a profile with a limited grade and the point at a distance along a line.

import type { Vec3 } from '../base/math.ts';
import { detAtan } from '../base/trig.ts';

/**
 * Smooths a line of unit directions (x, y, z per point). Per round every inner point becomes the normalised mix of a
 * quarter of the point before, half of its own and a quarter of the point after, all from the previous round. The
 * two ends keep their bits. Returns a new array.
 */
export function smoothLine(points: Float64Array, rounds: number): Float64Array {
  const count = Math.floor(points.length / 3);
  let a = Float64Array.from(points);
  if (count < 3) return a;
  let b = Float64Array.from(points);
  for (let r = 0; r < rounds; r++) {
    for (let i = 1; i < count - 1; i++) {
      const p = 3 * i;
      const x = 0.25 * a[p - 3]! + 0.5 * a[p]! + 0.25 * a[p + 3]!;
      const y = 0.25 * a[p - 2]! + 0.5 * a[p + 1]! + 0.25 * a[p + 4]!;
      const z = 0.25 * a[p - 1]! + 0.5 * a[p + 2]! + 0.25 * a[p + 5]!;
      const l = Math.sqrt(x * x + y * y + z * z);
      b[p] = x / l;
      b[p + 1] = y / l;
      b[p + 2] = z / l;
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

/** A profile that never rises along the line: `out[0] = heights[0]`, `out[i] = min(heights[i], out[i − 1] − minDrop)`. */
export function fallingGrade(heights: ArrayLike<number>, minDrop: number): Float64Array {
  const out = new Float64Array(heights.length);
  if (heights.length === 0) return out;
  out[0] = heights[0]!;
  for (let i = 1; i < heights.length; i++) out[i] = Math.min(heights[i]!, out[i - 1]! - minDrop);
  return out;
}

/**
 * Metres along a line of unit directions (x, y, z per point) up to each point, along great arcs of a sphere of
 * `radiusM`; `[0] = 0`. Each arc is `2 R · atan(h / √(R² − h²))` of the half chord h (reproducible arc tangent).
 */
export function lineLengths(points: ArrayLike<number>, radiusM: number): Float64Array {
  const count = Math.floor(points.length / 3);
  const out = new Float64Array(count);
  const R = radiusM;
  for (let i = 1; i < count; i++) {
    const dx = (points[3 * i]! - points[3 * i - 3]!) * R;
    const dy = (points[3 * i + 1]! - points[3 * i - 2]!) * R;
    const dz = (points[3 * i + 2]! - points[3 * i - 1]!) * R;
    const h = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
    out[i] = out[i - 1]! + 2 * R * detAtan(h / Math.sqrt(Math.max(0, R * R - h * h)));
  }
  return out;
}

/**
 * Heights along a line (at `lengthsM`, non-decreasing) changed so that no step rises or falls faster than `maxGrade`:
 * `|g[i+1] − g[i]| ≤ maxGrade · (lengthsM[i+1] − lengthsM[i])`, both ends kept. The middle of the highest profile
 * under the heights' upper cone and the lowest over their lower cone (`up[i] = max_j(h[j] − G·|s_i − s_j|)`,
 * `lo[i] = min_j(h[j] + G·|s_i − s_j|)`), clamped into the cones of the two ends. A profile within the limit comes back
 * unchanged; when the ends alone break the limit, the result is the straight ramp between them.
 */
export function limitGrade(lengthsM: ArrayLike<number>, heights: ArrayLike<number>, maxGrade: number): Float64Array {
  const n = heights.length;
  if (lengthsM.length !== n) throw new Error(`limitGrade: ${lengthsM.length} lengths for ${n} heights`);
  const out = new Float64Array(n);
  if (n === 0) return out;
  const G = maxGrade;
  const s = lengthsM;
  const h0 = heights[0]!;
  const hn = heights[n - 1]!;
  const S = s[n - 1]! - s[0]!;
  if (Math.abs(hn - h0) > G * S) {
    for (let i = 0; i < n; i++) out[i] = S > 0 ? h0 + ((hn - h0) * (s[i]! - s[0]!)) / S : i === n - 1 ? hn : h0;
    return out;
  }
  const up = new Float64Array(n);
  const lo = new Float64Array(n);
  up[0] = heights[0]!;
  lo[0] = heights[0]!;
  for (let i = 1; i < n; i++) {
    const d = G * (s[i]! - s[i - 1]!);
    up[i] = Math.max(heights[i]!, up[i - 1]! - d);
    lo[i] = Math.min(heights[i]!, lo[i - 1]! + d);
  }
  for (let i = n - 2; i >= 0; i--) {
    const d = G * (s[i + 1]! - s[i]!);
    up[i] = Math.max(up[i]!, up[i + 1]! - d);
    lo[i] = Math.min(lo[i]!, lo[i + 1]! + d);
  }
  for (let i = 0; i < n; i++) {
    const a = s[i]! - s[0]!;
    const b = s[n - 1]! - s[i]!;
    const floor = Math.max(h0 - G * a, hn - G * b);
    const ceil = Math.min(h0 + G * a, hn + G * b);
    const m = (up[i]! + lo[i]!) / 2;
    out[i] = m < floor ? floor : m > ceil ? ceil : m;
  }
  out[0] = h0;
  out[n - 1] = hn;
  return out;
}

/**
 * The point at `alongM` metres (clamped to the line) of a line of unit directions with lengths from `lineLengths`:
 * `dir = normalise((1 − t)·p[i] + t·p[i+1])`, t linear in metres along piece i; `heading` the unit tangent toward the
 * end, square to `dir`. Writes `out.dir` and `out.heading`.
 */
export function lineAt(points: ArrayLike<number>, lengthsM: ArrayLike<number>, alongM: number, out: { dir: Vec3; heading: Vec3 }): void {
  const n = lengthsM.length;
  if (n === 0 || points.length < 3 * n) throw new Error(`lineAt: ${n} lengths for ${Math.floor(points.length / 3)} points`);
  const s0 = lengthsM[0]!;
  const s1 = lengthsM[n - 1]!;
  const s = alongM < s0 ? s0 : alongM > s1 ? s1 : alongM;
  // The piece that holds s: the last i with lengths[i] ≤ s, at most n − 2.
  let lo = 0;
  let hi = Math.max(0, n - 2);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lengthsM[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const j = Math.min(n - 1, i + 1);
  const len = lengthsM[j]! - lengthsM[i]!;
  const t = len > 0 ? (s - lengthsM[i]!) / len : 0;
  const x = (1 - t) * points[3 * i]! + t * points[3 * j]!;
  const y = (1 - t) * points[3 * i + 1]! + t * points[3 * j + 1]!;
  const z = (1 - t) * points[3 * i + 2]! + t * points[3 * j + 2]!;
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  const d = out.dir;
  d[0] = x / l;
  d[1] = y / l;
  d[2] = z / l;
  // Tangent: the nearest piece with a length, toward the end, made square to dir.
  let a = i;
  let b = j;
  if (!(len > 0)) {
    for (let k = i; k + 1 < n; k++) {
      if (lengthsM[k + 1]! > lengthsM[k]!) {
        a = k;
        b = k + 1;
        break;
      }
    }
    if (!(lengthsM[b]! > lengthsM[a]!)) {
      for (let k = i; k > 0; k--) {
        if (lengthsM[k]! > lengthsM[k - 1]!) {
          a = k - 1;
          b = k;
          break;
        }
      }
    }
  }
  let ex = points[3 * b]! - points[3 * a]!;
  let ey = points[3 * b + 1]! - points[3 * a + 1]!;
  let ez = points[3 * b + 2]! - points[3 * a + 2]!;
  const dot = ex * d[0] + ey * d[1] + ez * d[2];
  ex -= dot * d[0];
  ey -= dot * d[1];
  ez -= dot * d[2];
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const h = out.heading;
  if (el > 0) {
    h[0] = ex / el;
    h[1] = ey / el;
    h[2] = ez / el;
  } else {
    h[0] = 0;
    h[1] = 0;
    h[2] = 0;
  }
}
