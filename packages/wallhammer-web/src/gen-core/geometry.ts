// Planar polygon geometry. A ring is a flat array x0, z0, x1, z1, … without repeating the first point.
// An outer boundary has positive area according to `ringSignedArea`, holes negative.

export type Ring = Float32Array;

export function ringSignedArea(r: ArrayLike<number>): number {
  let s = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += r[j * 2]! * r[i * 2 + 1]! - r[i * 2]! * r[j * 2 + 1]!;
  return s / 2;
}

/** Area of a ring set: outer boundaries minus holes. */
export function ringsArea(rings: Ring[]): number {
  let s = 0;
  for (const r of rings) s += ringSignedArea(r);
  return Math.abs(s);
}

export function pointInRings(x: number, z: number, rings: Ring[]): boolean {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[i * 2]!;
      const zi = r[i * 2 + 1]!;
      const xj = r[j * 2]!;
      const zj = r[j * 2 + 1]!;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance from a point to a segment. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

/** Rotated bounding rectangle: centre, unit direction of the longer axis and half extents. */
export interface OrientedBox {
  cx: number;
  cz: number;
  /** Unit direction of the longer axis. */
  ux: number;
  uz: number;
  halfL: number;
  halfW: number;
}

function convexHull(r: ArrayLike<number>): number[] {
  const n = r.length / 2;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => r[a * 2]! - r[b * 2]! || r[a * 2 + 1]! - r[b * 2 + 1]!);
  const crossAt = (o: number, a: number, b: number): number =>
    (r[a * 2]! - r[o * 2]!) * (r[b * 2 + 1]! - r[o * 2 + 1]!) - (r[a * 2 + 1]! - r[o * 2 + 1]!) * (r[b * 2]! - r[o * 2]!);
  const hull: number[] = [];
  for (const i of order) {
    while (hull.length >= 2 && crossAt(hull[hull.length - 2]!, hull[hull.length - 1]!, i) <= 0) hull.pop();
    hull.push(i);
  }
  const lower = hull.length + 1;
  for (let k = order.length - 2; k >= 0; k--) {
    const i = order[k]!;
    while (hull.length >= lower && crossAt(hull[hull.length - 2]!, hull[hull.length - 1]!, i) <= 0) hull.pop();
    hull.push(i);
  }
  hull.pop();
  return hull;
}

/** Minimum-area bounding rectangle. One of its sides always lies on an edge of the convex hull. */
export function orientedBox(r: ArrayLike<number>): OrientedBox {
  const hull = convexHull(r);
  let best: OrientedBox | null = null;
  let bestArea = Infinity;
  for (let k = 0; k < hull.length; k++) {
    const a = hull[k]!;
    const b = hull[(k + 1) % hull.length]!;
    let ex = r[b * 2]! - r[a * 2]!;
    let ez = r[b * 2 + 1]! - r[a * 2 + 1]!;
    const el = Math.hypot(ex, ez);
    if (el < 1e-6) continue;
    ex /= el;
    ez /= el;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const i of hull) {
      const u = r[i * 2]! * ex + r[i * 2 + 1]! * ez;
      const v = -r[i * 2]! * ez + r[i * 2 + 1]! * ex;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const hu = (maxU - minU) / 2;
      const hv = (maxV - minV) / 2;
      const cx = cu * ex - cv * ez;
      const cz = cu * ez + cv * ex;
      best = hu >= hv ? { cx, cz, ux: ex, uz: ez, halfL: hu, halfW: hv } : { cx, cz, ux: -ez, uz: ex, halfL: hv, halfW: hu };
    }
  }
  if (!best) throw new Error('The ring has no area');
  return best;
}

/**
 * One ring round an open line: `points` are x, z pairs of at least two points, the ring lies `halfWidth` on both sides
 * of it with butt ends and mitred joins, wound like an outer boundary (positive area). Null when the line has fewer
 * than two points, a segment is shorter than `halfWidth`, or a mitre would be longer than 3 × `halfWidth` (the limit
 * of `insetRing`).
 */
export function lineRing(points: ArrayLike<number>, halfWidth: number): Ring | null {
  const n = Math.floor(points.length / 2);
  if (n < 2 || !(halfWidth > 0)) return null;
  const MITRE_LIMIT = 3;
  // Unit direction of every segment.
  const dir = new Float64Array(2 * (n - 1));
  for (let i = 0; i + 1 < n; i++) {
    const dx = points[2 * i + 2]! - points[2 * i]!;
    const dz = points[2 * i + 3]! - points[2 * i + 1]!;
    const l = Math.hypot(dx, dz);
    if (!(l >= halfWidth)) return null;
    dir[2 * i] = dx / l;
    dir[2 * i + 1] = dz / l;
  }
  const left = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    // Left normals of the segment before and after the point (the same one at an end).
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 2, i);
    const n0x = -dir[2 * a + 1]!;
    const n0z = dir[2 * a]!;
    const n1x = -dir[2 * b + 1]!;
    const n1z = dir[2 * b]!;
    const k = 1 + n0x * n1x + n0z * n1z;
    if (k < 1e-6) return null;
    const mx = (n0x + n1x) / k;
    const mz = (n0z + n1z) / k;
    if (Math.hypot(mx, mz) > MITRE_LIMIT) return null;
    left[2 * i] = mx * halfWidth;
    left[2 * i + 1] = mz * halfWidth;
  }
  // Left side forward, right side back.
  const out = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    out[2 * i] = points[2 * i]! + left[2 * i]!;
    out[2 * i + 1] = points[2 * i + 1]! + left[2 * i + 1]!;
    const j = n - 1 - i;
    out[2 * (n + i)] = points[2 * j]! - left[2 * j]!;
    out[2 * (n + i) + 1] = points[2 * j + 1]! - left[2 * j + 1]!;
  }
  if (ringSignedArea(out) < 0) {
    for (let i = 0, j = 2 * n - 1; i < j; i++, j--) {
      const x = out[2 * i]!;
      const z = out[2 * i + 1]!;
      out[2 * i] = out[2 * j]!;
      out[2 * i + 1] = out[2 * j + 1]!;
      out[2 * j] = x;
      out[2 * j + 1] = z;
    }
  }
  return out;
}

/**
 * Offsets a ring by d metres into the solid (outer boundary inward, hole away from the hole).
 * Returns null when the offset shape would flip, in which case the simpler shape without offset should be used.
 */
export function insetRing(r: Ring, d: number): Ring | null {
  const n = r.length / 2;
  const out = new Float32Array(r.length);
  /** Longest allowed miter in multiples of d, sharp spikes are cut off. */
  const MITRE_LIMIT = 3;
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    const q = (i + 1) % n;
    let ax = r[i * 2]! - r[p * 2]!;
    let az = r[i * 2 + 1]! - r[p * 2 + 1]!;
    let bx = r[q * 2]! - r[i * 2]!;
    let bz = r[q * 2 + 1]! - r[i * 2 + 1]!;
    const al = Math.hypot(ax, az) || 1;
    const bl = Math.hypot(bx, bz) || 1;
    ax /= al;
    az /= al;
    bx /= bl;
    bz /= bl;
    // The left normal of an edge points inward for a positively oriented outer boundary.
    const n0x = -az;
    const n0z = ax;
    const n1x = -bz;
    const n1z = bx;
    const k = 1 + n0x * n1x + n0z * n1z;
    let mx: number;
    let mz: number;
    if (k < 1e-3) {
      mx = n0x;
      mz = n0z;
    } else {
      mx = (n0x + n1x) / k;
      mz = (n0z + n1z) / k;
      const ml = Math.hypot(mx, mz);
      if (ml > MITRE_LIMIT) {
        mx *= MITRE_LIMIT / ml;
        mz *= MITRE_LIMIT / ml;
      }
    }
    out[i * 2] = r[i * 2]! + mx * d;
    out[i * 2 + 1] = r[i * 2 + 1]! + mz * d;
  }
  // Check: no edge may flip and the area must not collapse.
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ex = r[q * 2]! - r[i * 2]!;
    const ez = r[q * 2 + 1]! - r[i * 2 + 1]!;
    const fx = out[q * 2]! - out[i * 2]!;
    const fz = out[q * 2 + 1]! - out[i * 2 + 1]!;
    if (ex * fx + ez * fz <= 0 && Math.hypot(ex, ez) > 2 * d) return null;
  }
  const a0 = ringSignedArea(r);
  const a1 = ringSignedArea(out);
  if (a0 > 0 ? a1 <= 0.2 * a0 : a1 >= 0) return null;
  return out;
}
