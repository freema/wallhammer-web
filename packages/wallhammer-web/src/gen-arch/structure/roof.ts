// Roofs in three levels according to the research:
//   1. footprint close to a rectangle: ridge on a rotated bounding rectangle (gable or hip),
//   2. other footprints: height grows with distance from the eave, so the ridge comes out in the middle of the wings,
//   3. flat roof as a fallback and for large and flat buildings.
// All three return triangles and a function of the wall's top edge height, by which the walls are closed up.

import earcut, { deviation } from 'earcut';
import { distToSegment } from '../../gen-core/index.ts';
import type { OrientedBox, Ring } from '../../gen-core/index.ts';

/** A line in the footprint: points where nx·x + nz·z = off. The roof plane breaks on it. */
export interface CreaseLine {
  nx: number;
  nz: number;
  off: number;
}

export interface RoofGeometry {
  /** Roof triangles: x, y, z for each vertex, 9 numbers per triangle, facing up. */
  tris: number[];
  /** Roof height above a footprint point. Walls get their top edge from it (gables). */
  topAt: (x: number, z: number) => number;
  /** Lines on which the wall's top edge breaks. Footprint edges must be split on them. */
  creases: CreaseLine[];
  /** Eave height the roof finally sits on. Pitched roofs derive it from the ridge and the allowed slope. */
  eaveY: number;
  /** The level that was finally used. */
  tier: 1 | 2 | 3;
}

/** Input heights of a pitched roof. The ridge keeps the lidar height, the eave is derived so the slope stays within limits. */
export interface PitchSpec {
  ridgeY: number;
  /** Eave according to lidar. Used when it yields an allowed slope. */
  eaveWanted: number;
  /** The eave must not drop lower (smallest wall height). */
  minEaveY: number;
  /** Smallest and largest allowed slope (tangent). */
  minSlope: number;
  maxSlope: number;
}

/** Roof height above the eave for a given footprint span, with the slope within limits and the eave above the minimum. */
function resolvePitch(p: PitchSpec, run: number): { eaveY: number; roofHeight: number } {
  const slope = Math.min(p.maxSlope, Math.max(p.minSlope, (p.ridgeY - p.eaveWanted) / run));
  const eaveY = Math.max(p.minEaveY, p.ridgeY - slope * run);
  return { eaveY, roofHeight: slope * run };
}

/** Largest allowed deviation of the triangulation area from the footprint area. */
const MAX_DEVIATION = 0.01;
/** Longest edge of the level 2 auxiliary mesh in metres. */
const FIELD_EDGE_M = 1.5;
/** Shorter footprint edges (teeth and projections) are collapsed to a single point for the roof shape, otherwise each tooth would get its own hip. */
const FIELD_MIN_EDGE_M = 1.7;
/** How far beyond the wall a point still counts as "on the eave" (after outline simplification some vertices lie just outside). */
const FIELD_OUTSIDE_M = 1.2;
const EPS = 1e-4;

interface Flat {
  coords: number[];
  holes: number[];
}

function flatten(rings: Ring[]): Flat {
  const coords: number[] = [];
  const holes: number[] = [];
  rings.forEach((r, k) => {
    if (k > 0) holes.push(coords.length / 2);
    for (const v of r) coords.push(v);
  });
  return { coords, holes };
}

/** Footprint triangulation. Returns null when the area check fails. */
function triangulate(rings: Ring[]): { coords: number[]; indices: number[] } | null {
  const { coords, holes } = flatten(rings);
  const indices = earcut(coords, holes, 2);
  if (indices.length === 0) return null;
  if (deviation(coords, holes, 2, indices) > MAX_DEVIATION) return null;
  return { coords, indices };
}

/** Splits planar triangles (6 numbers per triangle) by a line. Each resulting one lies entirely on one side. */
function splitByLine(tris: number[], line: CreaseLine): number[] {
  const out: number[] = [];
  const side = (x: number, z: number): number => line.nx * x + line.nz * z - line.off;
  for (let t = 0; t < tris.length; t += 6) {
    const p = [tris[t]!, tris[t + 1]!, tris[t + 2]!, tris[t + 3]!, tris[t + 4]!, tris[t + 5]!];
    const s = [side(p[0]!, p[1]!), side(p[2]!, p[3]!), side(p[4]!, p[5]!)];
    const pos = s.filter((v) => v > EPS).length;
    const neg = s.filter((v) => v < -EPS).length;
    if (pos === 0 || neg === 0) {
      out.push(...p);
      continue;
    }
    // Find the vertex that is alone on its side and rotate the triangle so it comes first.
    let lone = 0;
    for (let k = 0; k < 3; k++) {
      const a = s[k]!;
      const b = s[(k + 1) % 3]!;
      const c = s[(k + 2) % 3]!;
      if ((a > EPS && b <= EPS && c <= EPS) || (a < -EPS && b >= -EPS && c >= -EPS)) lone = k;
    }
    const ax = p[lone * 2]!;
    const az = p[lone * 2 + 1]!;
    const bx = p[((lone + 1) % 3) * 2]!;
    const bz = p[((lone + 1) % 3) * 2 + 1]!;
    const cx = p[((lone + 2) % 3) * 2]!;
    const cz = p[((lone + 2) % 3) * 2 + 1]!;
    const sa = s[lone]!;
    const sb = s[(lone + 1) % 3]!;
    const sc = s[(lone + 2) % 3]!;
    const tb = sa / (sa - sb);
    const tc = sa / (sa - sc);
    const mbx = ax + (bx - ax) * tb;
    const mbz = az + (bz - az) * tb;
    const mcx = ax + (cx - ax) * tc;
    const mcz = az + (cz - az) * tc;
    out.push(ax, az, mbx, mbz, mcx, mcz);
    if (Math.abs(sb) > EPS) out.push(mbx, mbz, bx, bz, cx, cz);
    if (Math.abs(sc) > EPS) out.push(mbx, mbz, cx, cz, mcx, mcz);
  }
  return out;
}

/** Lifts planar triangles to a height and flips them facing up. Discards degenerate ones. */
function lift(tris2: number[], topAt: (x: number, z: number) => number): number[] {
  const out: number[] = [];
  for (let t = 0; t < tris2.length; t += 6) {
    const ax = tris2[t]!;
    const az = tris2[t + 1]!;
    let bx = tris2[t + 2]!;
    let bz = tris2[t + 3]!;
    let cx = tris2[t + 4]!;
    let cz = tris2[t + 5]!;
    // Facing up means negative orientation in the footprint (x, z).
    const area2 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area2) < 1e-5) continue;
    if (area2 > 0) {
      [bx, cx] = [cx, bx];
      [bz, cz] = [cz, bz];
    }
    out.push(ax, topAt(ax, az), az, bx, topAt(bx, bz), bz, cx, topAt(cx, cz), cz);
  }
  return out;
}

/** Level 3: flat roof at height y. Also used when the triangulation fails the check. */
export function flatRoof(rings: Ring[], y: number): RoofGeometry {
  const { coords, holes } = flatten(rings);
  const indices = earcut(coords, holes, 2);
  const tris2: number[] = [];
  for (const i of indices) tris2.push(coords[i * 2]!, coords[i * 2 + 1]!);
  const topAt = (): number => y;
  return { tris: lift(tris2, topAt), topAt, creases: [], eaveY: y, tier: 3 };
}

/**
 * Height profile of a roof: breakpoints `[k, h]`, both 0..1, `k` strictly rising from `[0, 0]` to `[1, 1]` and `h`
 * never falling. `k` is 0 at the eave and 1 at the top; the height between breakpoints is linear.
 */
export type RoofProfile = readonly (readonly [number, number])[];

/** Ready-made profiles: straight faces, a quarter circle (dome) and a two-slope face (steep below, flat above). */
export const ROOF_PROFILE: { readonly straight: RoofProfile; readonly dome: RoofProfile; readonly mansard: RoofProfile } = {
  straight: [
    [0, 0],
    [1, 1],
  ],
  // h = sqrt(1 - (1 - k)^2), rounded to 3 places.
  dome: [
    [0, 0],
    [0.1, 0.436],
    [0.25, 0.661],
    [0.45, 0.835],
    [0.7, 0.954],
    [1, 1],
  ],
  mansard: [
    [0, 0],
    [0.22, 0.62],
    [1, 1],
  ],
};

/** Profile height at k (clamped to 0..1), linear between breakpoints. */
function profileAt(p: RoofProfile, k: number): number {
  if (k <= 0) return 0;
  if (k >= 1) return 1;
  for (let i = 1; i < p.length; i++) {
    const [k1, h1] = p[i]!;
    if (k <= k1) {
      const [k0, h0] = p[i - 1]!;
      return h0 + ((h1 - h0) * (k - k0)) / (k1 - k0);
    }
  }
  return 1;
}

export interface ApexRoofOptions {
  /** Top point in the footprint. Must lie strictly inside the ring. */
  cx: number;
  cz: number;
  eaveY: number;
  topY: number;
  profile: RoofProfile;
}

/**
 * A radial roof that rises from every edge of a convex footprint to one top point: with the straight profile a pyramid
 * (or a tall pointed roof), with a round profile a dome. The level lines are the ring shrunk about the top point.
 * Returns null for more than one ring, a ring that is not convex, a top point not strictly inside, or a top lower
 * than 0.1 above the eave. The eave is taken as given (no slope limits).
 */
export function apexRoof(rings: Ring[], o: ApexRoofOptions): RoofGeometry | null {
  if (rings.length !== 1 || o.topY < o.eaveY + 0.1) return null;
  const ring = rings[0]!;
  const n = ring.length / 2;
  if (n < 3) return null;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!;
  }
  if (Math.abs(area2) < 1e-6) return null;
  const orient = Math.sign(area2);
  // Per edge: inward unit normal, offset, and the top point's distance to the edge line.
  const enx: number[] = [];
  const enz: number[] = [];
  const eoff: number[] = [];
  const ed: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const h = (i + 2) % n;
    const ax = ring[i * 2]!;
    const az = ring[i * 2 + 1]!;
    const ex = ring[j * 2]! - ax;
    const ez = ring[j * 2 + 1]! - az;
    const fx = ring[h * 2]! - ring[j * 2]!;
    const fz = ring[h * 2 + 1]! - ring[j * 2 + 1]!;
    if ((ex * fz - ez * fx) * orient < -1e-6) return null;
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) return null;
    // Inward normal: to the left of the edge for a positive ring, to the right for a negative one.
    const nx = (-ez / len) * orient;
    const nz = (ex / len) * orient;
    const d = (o.cx - ax) * nx + (o.cz - az) * nz;
    if (d < 1e-3) return null;
    enx.push(nx);
    enz.push(nz);
    eoff.push(ax * nx + az * nz);
    ed.push(d);
  }
  const rise = o.topY - o.eaveY;
  const kAt = (x: number, z: number): number => {
    let k = 1;
    for (let i = 0; i < n; i++) k = Math.min(k, (x * enx[i]! + z * enz[i]! - eoff[i]!) / ed[i]!);
    return Math.max(0, k);
  };
  const topAt = (x: number, z: number): number => o.eaveY + rise * profileAt(o.profile, kAt(x, z));
  const tris: number[] = [];
  const at = (i: number, s: number): [number, number] => [o.cx + (ring[i * 2]! - o.cx) * s, o.cz + (ring[i * 2 + 1]! - o.cz) * s];
  const tri = (a: [number, number], ya: number, b: [number, number], yb: number, c: [number, number], yc: number): void => {
    const t2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(t2) < 1e-5) return;
    // Facing up means negative orientation in the footprint (x, z).
    if (t2 > 0) tris.push(a[0], ya, a[1], c[0], yc, c[1], b[0], yb, b[1]);
    else tris.push(a[0], ya, a[1], b[0], yb, b[1], c[0], yc, c[1]);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let s = 1; s < o.profile.length; s++) {
      const [k0, h0] = o.profile[s - 1]!;
      const [k1, h1] = o.profile[s]!;
      const y0 = o.eaveY + rise * h0;
      const y1 = o.eaveY + rise * h1;
      const a0 = at(i, 1 - k0);
      const b0 = at(j, 1 - k0);
      const a1 = at(i, 1 - k1);
      const b1 = at(j, 1 - k1);
      tri(a0, y0, b0, y0, b1, y1);
      if (k1 < 1) tri(a0, y0, b1, y1, a1, y1);
    }
  }
  return { tris, topAt, creases: [], eaveY: o.eaveY, tier: 1 };
}

export interface RidgeRoofOptions {
  box: OrientedBox;
  /** The ridge runs along the shorter axis of the rectangle instead of the longer one. */
  ridgeAcross: boolean;
  /** Hip roof: shortened ridge, sloped faces at the ends instead of gables. */
  hipped: boolean;
  pitch: PitchSpec;
  /** Height profile across the faces (eave to ridge). Without it the faces are straight. */
  profile?: RoofProfile;
}

/** Level 1: ridge on the axis of a rotated rectangle. Height is a linear function of the distance from the ridge. */
export function ridgeRoof(rings: Ring[], o: RidgeRoofOptions): RoofGeometry | null {
  const tri = triangulate(rings);
  if (!tri) return null;
  const { box, profile } = o;
  // Ridge axis (a) and fall axis (b).
  const ax = o.ridgeAcross ? -box.uz : box.ux;
  const az = o.ridgeAcross ? box.ux : box.uz;
  const bx = -az;
  const bz = ax;
  // Actual footprint extent in both axes, measured from the rectangle centre.
  let halfV = 0;
  let halfU = 0;
  for (let i = 0; i < tri.coords.length; i += 2) {
    const dx = tri.coords[i]! - box.cx;
    const dz = tri.coords[i + 1]! - box.cz;
    halfV = Math.max(halfV, Math.abs(dx * bx + dz * bz));
    halfU = Math.max(halfU, Math.abs(dx * ax + dz * az));
  }
  if (halfV < 0.5) return null;
  const { eaveY, roofHeight } = resolvePitch(o.pitch, halfV);
  const run = Math.min(halfV, halfU * 0.8);
  const topAt = (x: number, z: number): number => {
    const dx = x - box.cx;
    const dz = z - box.cz;
    const v = Math.abs(dx * bx + dz * bz);
    let k = 1 - v / halfV;
    if (o.hipped) k = Math.min(k, (halfU - Math.abs(dx * ax + dz * az)) / run);
    if (profile) return eaveY + roofHeight * profileAt(profile, k);
    return eaveY + roofHeight * Math.max(0, k);
  };
  const c0 = box.cx * bx + box.cz * bz;
  const creases: CreaseLine[] = [{ nx: bx, nz: bz, off: c0 }];
  if (o.hipped) {
    // Four hips: places where the height from the side equals the height from the end.
    const cu = box.cx * ax + box.cz * az;
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const nx = (su * ax) / run + (sv * bx) / halfV;
        const nz = (su * az) / run + (sv * bz) / halfV;
        creases.push({ nx, nz, off: halfU / run - 1 + (su * cu) / run + (sv * c0) / halfV });
      }
    }
  }
  if (profile) {
    // The faces break where the profile does: level lines at every inner breakpoint, on the sides and, hipped, at the ends.
    const cu = box.cx * ax + box.cz * az;
    for (let i = 1; i + 1 < profile.length; i++) {
      const ki = profile[i]![0];
      for (const s of [-1, 1]) creases.push({ nx: bx, nz: bz, off: c0 + s * (1 - ki) * halfV });
      if (o.hipped) for (const s of [-1, 1]) creases.push({ nx: ax, nz: az, off: cu + s * (halfU - ki * run) });
    }
  }
  let tris2: number[] = [];
  for (const i of tri.indices) tris2.push(tri.coords[i * 2]!, tri.coords[i * 2 + 1]!);
  for (const line of creases) tris2 = splitByLine(tris2, line);
  return { tris: lift(tris2, topAt), topAt, creases, eaveY, tier: 1 };
}


/** Collapses short edges of a ring to their midpoint. Returns a new ring, does not change the original. */
function collapseShortEdges(ring: Ring, minEdge: number): number[] {
  let pts: number[] = Array.from(ring);
  for (let guard = 0; guard < 200 && pts.length > 8; guard++) {
    const n = pts.length / 2;
    let shortest = minEdge;
    let at = -1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const l = Math.hypot(pts[j * 2]! - pts[i * 2]!, pts[j * 2 + 1]! - pts[i * 2 + 1]!);
      if (l < shortest) {
        shortest = l;
        at = i;
      }
    }
    if (at < 0) break;
    const j = (at + 1) % n;
    const mx = (pts[at * 2]! + pts[j * 2]!) / 2;
    const mz = (pts[at * 2 + 1]! + pts[j * 2 + 1]!) / 2;
    const next: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      if (i === at) next.push(mx, mz);
      else next.push(pts[i * 2]!, pts[i * 2 + 1]!);
    }
    pts = next;
  }
  return pts;
}

/**
 * Level 2: a plane rises from every footprint edge and the roof is their intersection. The ridge comes out in the middle of each wing
 * and also follows curved and closed footprints. The eave is at the same height everywhere, so the walls have no gables.
 * The mesh breaks exactly where the nearest edge changes, so hips and ridges are sharp.
 */
export function fieldRoof(rings: Ring[], pitch: PitchSpec, maxTriangles = Infinity): RoofGeometry | null {
  const tri = triangulate(rings);
  if (!tri) return null;

  // Footprint edges as roof planes: point, unit direction, length, normal into the building mass.
  // A convex corner splits two planes by a hip (the height is the smaller of the two), a concave corner by a valley (the larger of the two).
  interface Edge {
    ax: number;
    az: number;
    dx: number;
    dz: number;
    len: number;
    /** Index of the next edge in the ring and whether the corner between them is concave. */
    next: number;
    reflexEnd: boolean;
  }
  const edges: Edge[] = [];
  for (const full of rings) {
    const r = collapseShortEdges(full, FIELD_MIN_EDGE_M);
    const n = r.length / 2;
    const first = edges.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[i * 2]!;
      const az = r[i * 2 + 1]!;
      const ex = r[j * 2]! - ax;
      const ez = r[j * 2 + 1]! - az;
      const len = Math.hypot(ex, ez) || 1e-6;
      edges.push({ ax, az, dx: ex / len, dz: ez / len, len, next: first + j, reflexEnd: false });
    }
    for (let i = 0; i < n; i++) {
      const e = edges[first + i]!;
      const f = edges[e.next]!;
      e.reflexEnd = e.dx * f.dz - e.dz * f.dx < -1e-3;
    }
  }
  /** Perpendicular distance from the edge line, positive inside the building. Linear along each segment. */
  const planeDist = (s: number, x: number, z: number): number => {
    const e = edges[s]!;
    return -(x - e.ax) * e.dz + (z - e.az) * e.dx;
  };
  const SLAB_TOLERANCE = 0.02;
  /** Roof height in distance units and the plane that determines it at a point. */
  const nearest = (x: number, z: number): [number, number] => {
    let best = Infinity;
    let label = 0;
    for (let s = 0; s < edges.length; s++) {
      const e = edges[s]!;
      const t = (x - e.ax) * e.dx + (z - e.az) * e.dz;
      if (t >= -SLAB_TOLERANCE && t <= e.len + SLAB_TOLERANCE) {
        // Just beyond the wall the point is at the eave, far beyond the wall it is a different, opposite wall and the plain distance applies.
        const signed = planeDist(s, x, z);
        const d = signed >= -FIELD_OUTSIDE_M ? Math.max(signed, 0) : -signed;
        if (d < best - 1e-7) {
          best = d;
          label = s;
        }
      } else if (t > e.len && e.reflexEnd) {
        // Wedge beyond a concave corner: both neighbouring planes continue and meet in the valley.
        const f = edges[e.next]!;
        if ((x - f.ax) * f.dx + (z - f.az) * f.dz < 0) {
          const d0 = planeDist(s, x, z);
          const d1 = planeDist(e.next, x, z);
          const d = Math.max(d0, d1, 0);
          if (d < best - 1e-7) {
            best = d;
            label = d0 >= d1 ? s : e.next;
          }
        }
      }
    }
    if (best === Infinity) {
      // The point fell into no strip (numerical bad luck at an almost straight corner): plain distance to the edges.
      for (let s = 0; s < edges.length; s++) {
        const e = edges[s]!;
        const d = distToSegment(x, z, e.ax, e.az, e.ax + e.dx * e.len, e.az + e.dz * e.len);
        if (d < best) {
          best = d;
          label = s;
        }
      }
    }
    return [best, label];
  };

  // Shared vertices so the edge splitting connects between neighbouring triangles.
  const vx: number[] = [];
  const vz: number[] = [];
  for (let i = 0; i < tri.coords.length; i += 2) {
    vx.push(tri.coords[i]!);
    vz.push(tri.coords[i + 1]!);
  }
  let idx = tri.indices.slice();
  const edgeKey = (a: number, b: number): number => (a < b ? a * 1048576 + b : b * 1048576 + a);

  // 1. Refinement: every edge longer than the limit is halved, while any remain. A round that would leave more
  // triangles than the budget is dropped (its new vertices too) and refinement stops there.
  for (let iter = 0; iter < 10; iter++) {
    const verticesBefore = vx.length;
    const mids = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      if (Math.hypot(vx[a]! - vx[b]!, vz[a]! - vz[b]!) <= FIELD_EDGE_M) return -1;
      const k = edgeKey(a, b);
      let m = mids.get(k);
      if (m === undefined) {
        m = vx.length;
        vx.push((vx[a]! + vx[b]!) / 2);
        vz.push((vz[a]! + vz[b]!) / 2);
        mids.set(k, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      const v = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
      const m = [mid(v[0]!, v[1]!), mid(v[1]!, v[2]!), mid(v[2]!, v[0]!)];
      const count = m.filter((x) => x >= 0).length;
      if (count === 0) next.push(v[0]!, v[1]!, v[2]!);
      else if (count === 3) {
        next.push(v[0]!, m[0]!, m[2]!, m[0]!, v[1]!, m[1]!, m[2]!, m[1]!, v[2]!, m[0]!, m[1]!, m[2]!);
      } else if (count === 1) {
        const k = m.findIndex((x) => x >= 0);
        const a = v[k]!;
        const b = v[(k + 1) % 3]!;
        const c = v[(k + 2) % 3]!;
        next.push(a, m[k]!, c, m[k]!, b, c);
      } else {
        // Two split edges: k is the unsplit one, the opposite vertex is between two midpoints.
        const k = m.findIndex((x) => x < 0);
        const a = v[k]!;
        const b = v[(k + 1) % 3]!;
        const c = v[(k + 2) % 3]!;
        const mbc = m[(k + 1) % 3]!;
        const mca = m[(k + 2) % 3]!;
        next.push(mca, mbc, c, a, b, mbc, a, mbc, mca);
      }
    }
    if (next.length / 3 > maxTriangles) {
      vx.length = verticesBefore;
      vz.length = verticesBefore;
      break;
    }
    idx = next;
    if (mids.size === 0) break;
  }

  // 2. Distance and nearest edge for each vertex.
  const dist: number[] = [];
  const label: number[] = [];
  for (let i = 0; i < vx.length; i++) {
    const [d, l] = nearest(vx[i]!, vz[i]!);
    dist.push(d);
    label.push(l);
  }
  const addVertex = (x: number, z: number): number => {
    const [d, l] = nearest(x, z);
    vx.push(x);
    vz.push(z);
    dist.push(d);
    label.push(l);
    return vx.length - 1;
  };

  // 3. Break: on an edge whose ends are determined by different planes, find the point where both planes are at the same height.
  const cuts = new Map<number, number>();
  const cut = (a: number, b: number): number => {
    const k = edgeKey(a, b);
    const known = cuts.get(k);
    if (known !== undefined) return known;
    const [p, q] = a < b ? [a, b] : [b, a];
    // The difference of distances from both planes is linear along the edge, so the intersection can be computed directly.
    const g0 = planeDist(label[p]!, vx[p]!, vz[p]!) - planeDist(label[q]!, vx[p]!, vz[p]!);
    const g1 = planeDist(label[p]!, vx[q]!, vz[q]!) - planeDist(label[q]!, vx[q]!, vz[q]!);
    const t = g0 * g1 < 0 ? g0 / (g0 - g1) : 0.5;
    const m = addVertex(vx[p]! + (vx[q]! - vx[p]!) * t, vz[p]! + (vz[q]! - vz[p]!) * t);
    cuts.set(k, m);
    return m;
  };
  const out: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    const la = label[a]!;
    const lb = label[b]!;
    const lc = label[c]!;
    if (la === lb && lb === lc) {
      out.push(a, b, c);
    } else if (la !== lb && lb !== lc && la !== lc) {
      const mab = cut(a, b);
      const mbc = cut(b, c);
      const mca = cut(c, a);
      const m = addVertex((vx[mab]! + vx[mbc]! + vx[mca]!) / 3, (vz[mab]! + vz[mbc]! + vz[mca]!) / 3);
      out.push(a, mab, m, mab, b, m, b, mbc, m, mbc, c, m, c, mca, m, mca, a, m);
    } else {
      // One vertex has a different nearest edge than the other two. Rotate so it comes first.
      const [p, q, r] = la !== lb && la !== lc ? [a, b, c] : lb !== la && lb !== lc ? [b, c, a] : [c, a, b];
      const mpq = cut(p, q);
      const mrp = cut(r, p);
      out.push(p, mpq, mrp, mpq, q, r, mpq, r, mrp);
    }
  }

  let dMax = 0;
  for (const d of dist) dMax = Math.max(dMax, d);
  if (dMax < 0.5) return null;
  const { eaveY, roofHeight } = resolvePitch(pitch, dMax);
  const slope = roofHeight / dMax;
  const tris: number[] = [];
  for (let t = 0; t < out.length; t += 3) {
    const a = out[t]!;
    let b = out[t + 1]!;
    let c = out[t + 2]!;
    const area2 = (vx[b]! - vx[a]!) * (vz[c]! - vz[a]!) - (vz[b]! - vz[a]!) * (vx[c]! - vx[a]!);
    if (Math.abs(area2) < 1e-5) continue;
    if (area2 > 0) [b, c] = [c, b];
    for (const i of [a, b, c]) tris.push(vx[i]!, eaveY + slope * dist[i]!, vz[i]!);
  }
  // Walls are closed up to the roof height above the outline: after outline simplification it is not exactly at the eave everywhere.
  return { tris, topAt: (x, z) => eaveY + slope * nearest(x, z)[0], creases: [], eaveY, tier: 2 };
}
