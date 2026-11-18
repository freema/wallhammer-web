// Collision solids from a mesh: the outline of a mesh seen from above, as an upright prism (the convex hull of its
// vertices in x, z) or an upright cylinder (around the centre of that hull), from its lowest to its highest vertex.
// For compact things whose solid is roughly their footprint. Build time only: these functions allocate.
//
// The mesh is plain numbers: positions (x, y, z per vertex, or `stride` numbers per vertex with the position first),
// optional indices (only the vertices they name count) and an optional 3 × 4 transform (`Mat34` of base) into the
// world. `below` leaves out what stands higher than that over the lowest vertex (an overhang the body may pass under).

import type { CollisionWorld, SolidOptions } from './collide.ts';

export interface MeshFootprintOptions {
  /** Numbers per vertex in `positions`, the position being the first three. Default 3. */
  stride?: number;
  /** Only these vertices count (a triangle list or any list of vertex indices). Default every vertex. */
  indices?: ArrayLike<number> | null;
  /** First and end vertex to take (a group in a shared buffer). Default the whole buffer. Ignored with `indices`. */
  from?: number;
  to?: number;
  /** Mesh space → world: 12 numbers, linear part column by column then the translation. Default none. */
  transform?: ArrayLike<number> | null;
  /** Only vertices at most this far above the lowest one shape the outline (overhangs left out). Default all. */
  below?: number;
  /** Grows (positive) or shrinks (negative) the outline, metres. Default 0. */
  grow?: number;
  /** Outline points are rounded to this grid before the hull, metres (0: exact). Default 0.05. */
  snap?: number;
}

/** An upright prism over a convex outline (x, z pairs, counter-clockwise in the x, z plane), from `minY` to `maxY`. */
export interface MeshPrismFootprint {
  outline: number[];
  minY: number;
  maxY: number;
}

/** An upright cylinder around (x, z), from `minY` to `maxY`. */
export interface MeshCylinderFootprint {
  x: number;
  z: number;
  radius: number;
  minY: number;
  maxY: number;
}

/** The world points of the mesh, the lowest and highest y and the x, z pairs of the outline candidates. */
function gather(positions: ArrayLike<number>, o: MeshFootprintOptions): { xz: number[]; minY: number; maxY: number } | null {
  const stride = o.stride ?? 3;
  const n = Math.floor(positions.length / stride);
  const m = o.transform ?? null;
  const pts: number[] = [];
  const visit = (i: number): void => {
    if (i < 0 || i >= n) return;
    const k = i * stride;
    const x = positions[k]!;
    const y = positions[k + 1]!;
    const z = positions[k + 2]!;
    if (m) pts.push(m[0]! * x + m[3]! * y + m[6]! * z + m[9]!, m[1]! * x + m[4]! * y + m[7]! * z + m[10]!, m[2]! * x + m[5]! * y + m[8]! * z + m[11]!);
    else pts.push(x, y, z);
  };
  if (o.indices) {
    const seen = new Set<number>();
    for (let k = 0; k < o.indices.length; k++) {
      const i = o.indices[k]!;
      if (seen.has(i)) continue;
      seen.add(i);
      visit(i);
    }
  } else {
    const to = Math.min(o.to ?? n, n);
    for (let i = Math.max(0, o.from ?? 0); i < to; i++) visit(i);
  }
  if (pts.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 1; k < pts.length; k += 3) {
    lo = Math.min(lo, pts[k]!);
    hi = Math.max(hi, pts[k]!);
  }
  const cut = o.below !== undefined ? lo + o.below : Infinity;
  const snap = o.snap ?? 0.05;
  const seen = new Set<string>();
  const xz: number[] = [];
  for (let k = 0; k < pts.length; k += 3) {
    if (pts[k + 1]! > cut) continue;
    const x = snap > 0 ? Math.round(pts[k]! / snap) * snap : pts[k]!;
    const z = snap > 0 ? Math.round(pts[k + 2]! / snap) * snap : pts[k + 2]!;
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    xz.push(x, z);
  }
  return { xz, minY: lo, maxY: hi };
}

/** Convex hull of x, z pairs (monotone chain), counter-clockwise in the x, z plane (x the first axis, z the second), without collinear points. */
export function convexHullXZ(points: ArrayLike<number>): number[] {
  const idx: number[] = [];
  for (let i = 0; i * 2 + 1 < points.length; i++) idx.push(i);
  const X = (i: number): number => points[i * 2]!;
  const Z = (i: number): number => points[i * 2 + 1]!;
  idx.sort((a, b) => X(a) - X(b) || Z(a) - Z(b));
  if (idx.length < 3) return idx.flatMap((i) => [X(i), Z(i)]);
  const cross = (o: number, a: number, b: number): number => (X(a) - X(o)) * (Z(b) - Z(o)) - (Z(a) - Z(o)) * (X(b) - X(o));
  const lower: number[] = [];
  for (const q of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const q = idx[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower
    .slice(0, -1)
    .concat(upper.slice(0, -1))
    .flatMap((i) => [X(i), Z(i)]);
}

/** Moves every corner of a convex outline outward from its centroid by `d` (a cheap offset for small d). */
function growConvex(hull: number[], d: number): number[] {
  const n = hull.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += hull[i * 2]!;
    cz += hull[i * 2 + 1]!;
  }
  cx /= n;
  cz /= n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ex = hull[i * 2]! - cx;
    const ez = hull[i * 2 + 1]! - cz;
    const l = Math.hypot(ex, ez) || 1;
    out.push(hull[i * 2]! + (ex / l) * d, hull[i * 2 + 1]! + (ez / l) * d);
  }
  return out;
}

/** The mesh's footprint as a prism over the convex hull of its vertices; null when it has fewer than three outline points. */
export function meshPrismFootprint(positions: ArrayLike<number>, o: MeshFootprintOptions = {}): MeshPrismFootprint | null {
  const g = gather(positions, o);
  if (!g) return null;
  const hull = convexHullXZ(g.xz);
  if (hull.length < 6) return null;
  return { outline: o.grow ? growConvex(hull, o.grow) : hull, minY: g.minY, maxY: g.maxY };
}

/**
 * The mesh's footprint as a cylinder: centred on the centroid of the hull's corners, its radius reaching the farthest
 * outline point (plus `grow`). Null for an empty mesh.
 */
export function meshCylinderFootprint(positions: ArrayLike<number>, o: MeshFootprintOptions = {}): MeshCylinderFootprint | null {
  const g = gather(positions, o);
  if (!g) return null;
  const hull = convexHullXZ(g.xz);
  const n = hull.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += hull[i * 2]!;
    cz += hull[i * 2 + 1]!;
  }
  cx /= n;
  cz /= n;
  let r = 0;
  for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(hull[i * 2]! - cx, hull[i * 2 + 1]! - cz));
  r += o.grow ?? 0;
  if (!(r > 0)) return null;
  return { x: cx, z: cz, radius: r, minY: g.minY, maxY: g.maxY };
}

/**
 * Adds the mesh's footprint to a collision world as a prism (default) or a cylinder. Returns the solid's id, or −1
 * when the mesh gives no footprint.
 */
export function addMeshSolid(world: CollisionWorld, positions: ArrayLike<number>, o: MeshFootprintOptions & SolidOptions & { shape?: 'prism' | 'cylinder' } = {}): number {
  const solid: SolidOptions = {};
  if (o.standable !== undefined) solid.standable = o.standable;
  if (o.blocksSight !== undefined) solid.blocksSight = o.blocksSight;
  if (o.tag !== undefined) solid.tag = o.tag;
  if (o.shape === 'cylinder') {
    const c = meshCylinderFootprint(positions, o);
    return c ? world.addCylinder(c.x, c.z, c.radius, c.minY, c.maxY, solid) : -1;
  }
  const p = meshPrismFootprint(positions, o);
  return p ? world.addPrism(p.outline, p.minY, p.maxY, solid) : -1;
}
