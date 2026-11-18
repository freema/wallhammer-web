// Bare shapes for `MeshBuilder<V>`: plain geometry that asks the caller for the payload of every vertex. Nothing here
// carries a look: no colour, no seams, no bevels, no irregularity. A caller adds all of that through the payload
// callback (which gets the geometric facts of the vertex) and, for irregular shapes, through the `warp` hook that may
// move grid points before the normals are taken.
//
//   gridSurface   a parametric grid of points, stitched into quads (the base of the others)
//   revolve       a surface of revolution about +y from a profile of [radius, y] points
//   sweep         a section pulled along a path, with rotation-minimising frames
//   extrude       an outline in the x–y plane pushed along +z, with optional caps
//   polygon       a flat simple polygon (convex: a fan from the first corner; otherwise ear clipping)
//   box, cylinder special cases of extrude and revolve
//
// Winding: counter-clockwise seen from outside, so a closed shape has a positive volume. Normals are smooth (shared
// vertices) or flat (every face its own vertices), by the `smooth` option of each shape.

import type { Vec3 } from '../base/math.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { faceNormal } from './mesh-builder.ts';
import { triangulateRing } from './prism-mesh.ts';

const TAU = Math.PI * 2;

/**
 * Which surface of a shape a vertex belongs to: the main surface, the cap at its start or end, or a cut plane (the two
 * meridian planes that close a partial revolution; `j` 0 at `from`, 1 at `to`).
 */
export type ShapePart = 'side' | 'start' | 'end' | 'cut';

/**
 * The geometric facts of one vertex, handed to the payload callback. One object is reused for every vertex of a
 * call: read it inside the callback, do not keep it.
 */
export interface ShapeVertex {
  /** Position in the shape's own frame (before the builder's transform). */
  readonly p: Vec3;
  /** Unit normal in the same frame. */
  readonly n: Vec3;
  part: ShapePart;
  /**
   * Grid indices. On a side: `i` across (around a revolution, along a section or an outline), `j` along (profile
   * point, path point, 0/1 for the two ends of an extrusion). On a cap: `i` the outline corner, `j` 0.
   */
  i: number;
  j: number;
  /**
   * Shares 0–1 that match `i` and `j` (by arc length for profiles, sections, paths and outlines; by angle around a
   * revolution). On a cap: `u` the share around the outline, `v` 1 on the rim and 0 at a fan centre.
   */
  u: number;
  v: number;
  /** Number of the flat face within this call (−1 on smooth surfaces). */
  face: number;
  /** Corner within the flat face, from 0 in winding order (−1 on smooth surfaces and at a fan centre). */
  corner: number;
  /** True for the extra centre vertex of a fan. */
  centre: boolean;
}

/** Normals of a grid: smooth everywhere, flat per cell (false), or flat across and smooth along ('along'). */
export type GridSmooth = boolean | 'along';

/** Gives the payload of one vertex from its geometric facts. */
export type ShapePayload<V> = (s: ShapeVertex) => V;

/** Moves a grid point (in the shape's frame) before normals are computed; `i`, `j` as in `ShapeVertex`. */
export type ShapeWarp = (p: Vec3, i: number, j: number) => void;

class Facts implements ShapeVertex {
  readonly p: Vec3 = [0, 0, 0];
  readonly n: Vec3 = [0, 0, 0];
  part: ShapePart = 'side';
  i = 0;
  j = 0;
  u = 0;
  v = 0;
  face = -1;
  corner = -1;
  centre = false;
  set(p: ArrayLike<number>, n: ArrayLike<number>, part: ShapePart, i: number, j: number, u: number, v: number, face: number, corner: number, centre = false): this {
    this.p[0] = p[0]!;
    this.p[1] = p[1]!;
    this.p[2] = p[2]!;
    this.n[0] = n[0]!;
    this.n[1] = n[1]!;
    this.n[2] = n[2]!;
    this.part = part;
    this.i = i;
    this.j = j;
    this.u = u;
    this.v = v;
    this.face = face;
    this.corner = corner;
    this.centre = centre;
    return this;
  }
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
function unit(a: Vec3): Vec3 {
  const l = Math.sqrt(dot(a, a));
  if (l > 0) {
    a[0] /= l;
    a[1] /= l;
    a[2] /= l;
  }
  return a;
}

/** Shares 0–1 by cumulative distance between consecutive points (`closed` adds the closing edge; n + 1 values then). */
function arcShares(pts: readonly ArrayLike<number>[], dims: 2 | 3, closed: boolean): number[] {
  const out = [0];
  const n = pts.length;
  const edges = closed ? n : n - 1;
  for (let k = 0; k < edges; k++) {
    const a = pts[k]!, b = pts[(k + 1) % n]!;
    let d = 0;
    for (let c = 0; c < dims; c++) d += (b[c]! - a[c]!) ** 2;
    out.push(out[k]! + Math.sqrt(d));
  }
  const total = out[out.length - 1]!;
  return out.map((x, k) => (total > 0 ? x / total : edges > 0 ? k / edges : 0));
}

// --- Flat polygon -----------------------------------------------------------------------------------------------------

export interface PolygonOptions {
  /** Triangulate as a fan from an extra centre vertex (the mean of the corners) instead of from the corners alone. */
  fan?: boolean;
  /** Which part the vertices report (default 'side'). */
  part?: ShapePart;
  /** Face number reported to the callback (default 0). */
  face?: number;
}

/**
 * A flat simple polygon (corners counter-clockwise seen from the front) with one normal (Newell's). A convex polygon
 * is a fan from its first corner; a concave one is ear-clipped (corners on a straight line may be left out of the
 * triangles). Returns the index of the first vertex written.
 */
export function polygon<V>(b: MeshBuilder<V>, points: readonly ArrayLike<number>[], payload: ShapePayload<V>, o: PolygonOptions = {}): number {
  const s = new Facts();
  return writePolygon(b, points, payload, s, o.part ?? 'side', o.face ?? 0, o.fan ?? false, 0, null);
}

/**
 * Writes one flat polygon. `iBase` and `rowJ` let shapes report their own grid indices for the corners (`rowJ` null:
 * `i` = corner, `j` = 0).
 */
function writePolygon<V>(b: MeshBuilder<V>, pts: readonly ArrayLike<number>[], payload: ShapePayload<V>, s: Facts, part: ShapePart, face: number, fan: boolean, iBase: number, rowJ: number | null): number {
  const n = pts.length;
  const first = b.vertexCount;
  if (n < 3) return first;
  const nrm = faceNormal(pts);
  const shares = arcShares(pts, 3, true);
  if (fan) {
    const c: Vec3 = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[k]! / n;
    const ic = b.vertex(c, nrm, payload(s.set(c, nrm, part, iBase, rowJ ?? 0, 0, 0, face, -1, true)));
    const rim: number[] = [];
    for (let k = 0; k < n; k++) rim.push(b.vertex(pts[k]!, nrm, payload(s.set(pts[k]!, nrm, part, iBase + k, rowJ ?? 0, shares[k]!, 1, face, k))));
    for (let k = 0; k < n; k++) b.tri(ic, rim[k]!, rim[(k + 1) % n]!);
    return first;
  }
  for (let k = 0; k < n; k++) b.vertex(pts[k]!, nrm, payload(s.set(pts[k]!, nrm, part, iBase + k, rowJ ?? 0, shares[k]!, 1, face, k)));
  // Project onto the plane: e1 × e2 = normal, so the polygon is counter-clockwise in (e1, e2).
  const ref: Vec3 = Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(ref, nrm));
  const e2 = cross(nrm, e1);
  const flat: number[] = [];
  for (const p of pts) flat.push(dot(p, e1), dot(p, e2));
  let convex = true;
  for (let k = 0; k < n && convex; k++) {
    const a = k * 2, c = ((k + 1) % n) * 2, d = ((k + 2) % n) * 2;
    const t = (flat[c]! - flat[a]!) * (flat[d + 1]! - flat[a + 1]!) - (flat[c + 1]! - flat[a + 1]!) * (flat[d]! - flat[a]!);
    if (t < -1e-12) convex = false;
  }
  if (convex) {
    for (let k = 1; k + 1 < n; k++) b.tri(first, first + k, first + k + 1);
  } else {
    // Ear clipping in (e1, e2): its triangles have a positive area there, i.e. they wind counter-clockwise about the normal.
    const t = triangulateRing(flat);
    for (let k = 0; k < t.length; k += 3) b.tri(first + t[k]!, first + t[k + 1]!, first + t[k + 2]!);
  }
  return first;
}

// --- Parametric grid ------------------------------------------------------------------------------------------------

export interface GridOptions {
  /**
   * Smooth normals from the grid (default), one flat face per cell (false), or 'along': hard edges between columns
   * and smooth along each column strip (a section with sharp corners bent along a path).
   */
  smooth?: GridSmooth;
  /** The last column joins the first (a closed loop across). The seam vertices are written twice (u 0 and 1). */
  wrapI?: boolean;
  /** The last row joins the first (a closed loop along). */
  wrapJ?: boolean;
  /** Reverse the winding (the cross product d/di × d/dj then points inward). */
  flip?: boolean;
  /** Shares per column / row reported as `u` / `v` (default i / (cols − 1) and j / (rows − 1); with wrap / cols). */
  u?: readonly number[];
  v?: readonly number[];
  /** Normal per grid point instead of the one from differences (smooth only). */
  normalAt?: (i: number, j: number, out: Vec3) => Vec3;
  /** Which part the vertices report. Default 'side'. */
  part?: ShapePart;
  /** First face number for flat cells. Default 0. Returns are the face numbers used. */
  faceBase?: number;
}

/**
 * A grid of `cols` × `rows` points `at(i, j)` stitched into quads (i, j) (i+1, j) (i+1, j+1) (i, j+1), which face
 * the side d/di × d/dj points to. Smooth normals come from central differences of neighbouring points (wrapping
 * where the grid wraps). A cell whose two points on one edge coincide (an apex) becomes a triangle. With 'along'
 * every column strip has its own vertices, normals across from the strip's edge and along from central differences
 * (face and corner −1). Returns the number of flat faces written (0 unless flat).
 */
export function gridSurface<V>(b: MeshBuilder<V>, cols: number, rows: number, at: (i: number, j: number, out: Vec3) => Vec3, payload: ShapePayload<V>, o: GridOptions = {}): number {
  if (cols < 2 && !o.wrapI) return 0;
  if (rows < 2 && !o.wrapJ) return 0;
  const P: Vec3[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) P.push(at(i, j, [0, 0, 0]));
  const s = new Facts();
  const wi = !!o.wrapI, wj = !!o.wrapJ;
  const cellsI = wi ? cols : cols - 1;
  const cellsJ = wj ? rows : rows - 1;
  const U = o.u ?? Array.from({ length: cols + 1 }, (_, i) => (wi ? i / cols : i / Math.max(1, cols - 1)));
  const Vs = o.v ?? Array.from({ length: rows + 1 }, (_, j) => (wj ? j / rows : j / Math.max(1, rows - 1)));
  const part = o.part ?? 'side';
  const flip = !!o.flip;
  const get = (i: number, j: number): Vec3 => {
    i = wi ? ((i % cols) + cols) % cols : Math.max(0, Math.min(cols - 1, i));
    j = wj ? ((j % rows) + rows) % rows : Math.max(0, Math.min(rows - 1, j));
    return P[j * cols + i]!;
  };
  const same = (a: Vec3, c: Vec3): boolean => Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]) < 1e-9;
  if (o.smooth === false) {
    let face = o.faceBase ?? 0;
    const corner: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let j = 0; j < cellsJ; j++) {
      for (let i = 0; i < cellsI; i++) {
        const pts: Vec3[] = [];
        const ids: [number, number][] = [];
        for (const [di, dj] of flip ? [corner[0]!, corner[3]!, corner[2]!, corner[1]!] : corner) {
          const p = get(i + di, j + dj);
          if (pts.length && same(pts[pts.length - 1]!, p)) continue;
          if (pts.length === 3 && same(pts[0]!, p)) continue;
          pts.push(p);
          ids.push([i + di, j + dj]);
        }
        if (pts.length > 1 && same(pts[0]!, pts[pts.length - 1]!)) (pts.pop(), ids.pop());
        if (pts.length < 3) continue;
        const nrm = faceNormal(pts);
        const firstV = b.vertexCount;
        pts.forEach((p, k) => {
          const [ii, jj] = ids[k]!;
          b.vertex(p, nrm, payload(s.set(p, nrm, part, ii, jj, U[ii]!, Vs[jj]!, face, k)));
        });
        for (let k = 1; k + 1 < pts.length; k++) b.tri(firstV, firstV + k, firstV + k + 1);
        face++;
      }
    }
    return face - (o.faceBase ?? 0);
  }
  if (o.smooth === 'along') {
    const vr = wj ? rows + 1 : rows;
    const nrm: Vec3 = [0, 0, 0];
    for (let i = 0; i < cellsI; i++) {
      const firstV = b.vertexCount;
      for (let j = 0; j < vr; j++) {
        const p0 = get(i, j), p1 = get(i + 1, j);
        let across = sub(p1, p0);
        // At an apex the strip's edge collapses: take it from the neighbouring row.
        if (dot(across, across) < 1e-24) across = sub(get(i + 1, j + 1), get(i, j + 1));
        if (dot(across, across) < 1e-24) across = sub(get(i + 1, j - 1), get(i, j - 1));
        const ahead = sub(get(i, j + 1), get(i, j - 1));
        const ahead1 = sub(get(i + 1, j + 1), get(i + 1, j - 1));
        const c = cross(across, [ahead[0] + ahead1[0], ahead[1] + ahead1[1], ahead[2] + ahead1[2]]);
        nrm[0] = flip ? -c[0] : c[0];
        nrm[1] = flip ? -c[1] : c[1];
        nrm[2] = flip ? -c[2] : c[2];
        unit(nrm);
        b.vertex(p0, nrm, payload(s.set(p0, nrm, part, i, j, U[i]!, Vs[j]!, -1, -1)));
        b.vertex(p1, nrm, payload(s.set(p1, nrm, part, i + 1, j, U[i + 1]!, Vs[j]!, -1, -1)));
      }
      for (let j = 0; j < cellsJ; j++) {
        const a = firstV + j * 2, c = a + 1, d = a + 3, e = a + 2;
        if (flip) b.quad(a, e, d, c);
        else b.quad(a, c, d, e);
      }
    }
    return 0;
  }
  // Smooth: one vertex per grid point (plus the seam column / row again when wrapping, for u / v continuity).
  const vc = wi ? cols + 1 : cols;
  const vr = wj ? rows + 1 : rows;
  const first = b.vertexCount;
  const nrm: Vec3 = [0, 0, 0];
  for (let j = 0; j < vr; j++) {
    for (let i = 0; i < vc; i++) {
      const p = get(i, j);
      if (o.normalAt) o.normalAt(i % cols, j % rows, nrm);
      else {
        const di = sub(get(i + 1, j), get(i - 1, j));
        const dj = sub(get(i, j + 1), get(i, j - 1));
        const c = cross(di, dj);
        nrm[0] = c[0];
        nrm[1] = c[1];
        nrm[2] = c[2];
        if (dot(nrm, nrm) < 1e-24) {
          // A collapsed row (an apex): the mean of the neighbouring cells' normals along j.
          const k = cross(sub(get(i + 1, j + 1), get(i - 1, j + 1)), sub(get(i, j + 1), p));
          const l = cross(sub(get(i + 1, j - 1), get(i - 1, j - 1)), sub(p, get(i, j - 1)));
          nrm[0] = k[0] + l[0];
          nrm[1] = k[1] + l[1];
          nrm[2] = k[2] + l[2];
        }
        if (flip) (nrm[0] = -nrm[0], nrm[1] = -nrm[1], nrm[2] = -nrm[2]);
      }
      unit(nrm);
      b.vertex(p, nrm, payload(s.set(p, nrm, part, i, j, U[i]!, Vs[j]!, -1, -1)));
    }
  }
  for (let j = 0; j < cellsJ; j++) {
    for (let i = 0; i < cellsI; i++) {
      const a = first + j * vc + i, c = a + 1, d = a + vc + 1, e = a + vc;
      const pa = get(i, j), pc = get(i + 1, j), pd = get(i + 1, j + 1), pe = get(i, j + 1);
      const q = flip ? [a, e, d, c] : [a, c, d, e];
      const qp = flip ? [pa, pe, pd, pc] : [pa, pc, pd, pe];
      // Drop a collapsed edge: the cell is a triangle.
      let k = 0;
      for (; k < 4; k++) if (same(qp[k]!, qp[(k + 1) % 4]!)) break;
      if (k === 4) b.quad(q[0]!, q[1]!, q[2]!, q[3]!);
      else {
        // Keep the first vertex of the collapsed edge (the apex vertex of this column), drop the second.
        const r = [q[k]!, q[(k + 2) % 4]!, q[(k + 3) % 4]!];
        const rp = [qp[k]!, qp[(k + 2) % 4]!, qp[(k + 3) % 4]!];
        if (!same(rp[0]!, rp[1]!) && !same(rp[1]!, rp[2]!) && !same(rp[2]!, rp[0]!)) b.tri(r[0]!, r[1]!, r[2]!);
      }
    }
  }
  return 0;
}

// --- Revolution -------------------------------------------------------------------------------------------------------

export interface RevolveOptions {
  /** Segments around. Default 24. */
  segments?: number;
  /**
   * Angle range in radians, θ measured from +z toward +x (a point is (r sin θ, y, r cos θ)). Default the full turn.
   * A partial range is open at its two meridians unless `sides`.
   */
  from?: number;
  to?: number;
  /** Smooth normals (default), one flat face per cell (false), or flat around and smooth along the profile ('along'). */
  smooth?: GridSmooth;
  /** Close the profile's first / last point with a flat disc (when its radius is above zero). */
  capStart?: boolean;
  capEnd?: boolean;
  /** Cap discs as fans from a centre vertex (default true) or from their first rim corner. */
  capFan?: boolean;
  /** For a partial range: close the two meridian planes (the profile and the axis), reported as part 'cut'. */
  sides?: boolean;
  /** Moves grid points (i around, j along the profile) before normals are taken. */
  warp?: ShapeWarp;
}

/**
 * A surface of revolution about +y from a profile of [radius, y] points. Faces point to the right of the profile's
 * direction in the r–y plane: a profile from bottom to top faces outward. A point of radius 0 is an apex (the cells
 * next to it are triangles). Side vertices report `i` around (0…segments), `j` the profile point, `u` the angle
 * share, `v` the arc-length share along the profile. Returns the vertex index of the first vertex written.
 */
export function revolve<V>(b: MeshBuilder<V>, profile: readonly (readonly [number, number])[], payload: ShapePayload<V>, o: RevolveOptions = {}): number {
  const first = b.vertexCount;
  const np = profile.length;
  if (np < 2) return first;
  const seg = Math.max(1, o.segments ?? 24);
  const from = o.from ?? 0;
  const to = o.to ?? TAU;
  const full = Math.abs(Math.abs(to - from) - TAU) < 1e-9;
  const angle = (i: number): number => from + ((to - from) * i) / seg;
  // Outward profile normals in the r–y plane from the neighbours (one-sided at the ends).
  const pn: [number, number][] = [];
  for (let k = 0; k < np; k++) {
    const a = profile[Math.max(0, k - 1)]!, c = profile[Math.min(np - 1, k + 1)]!;
    const dr = c[0] - a[0], dy = c[1] - a[1];
    const l = Math.hypot(dr, dy) || 1;
    pn.push([dy / l, -dr / l]);
  }
  const vShares = arcShares(profile, 2, false);
  const uShares = Array.from({ length: seg + 1 }, (_, i) => i / seg);
  const at = (i: number, j: number, out: Vec3): Vec3 => {
    const t = angle(i);
    const [r, y] = profile[j]!;
    out[0] = r * Math.sin(t);
    out[1] = y;
    out[2] = r * Math.cos(t);
    if (o.warp) o.warp(out, i, j);
    return out;
  };
  const analytic = (i: number, j: number, out: Vec3): Vec3 => {
    const t = angle(i);
    out[0] = pn[j]![0] * Math.sin(t);
    out[1] = pn[j]![1];
    out[2] = pn[j]![0] * Math.cos(t);
    return out;
  };
  // A full turn wraps around (the seam vertices written twice, u 0 and 1); a partial range has seg + 1 columns.
  let faces = gridSurface(b, full ? seg : seg + 1, np, at, payload, {
    smooth: o.smooth ?? true,
    wrapI: full,
    u: uShares,
    v: vShares,
    ...(o.warp ? {} : { normalAt: analytic }),
  });
  const s = new Facts();
  const fan = o.capFan ?? true;
  const cap = (j: number, part: ShapePart): void => {
    const [r, y] = profile[j]!;
    if (r <= 1e-12) return;
    // The disc faces away from the profile's neighbouring point along y.
    const other = profile[j === 0 ? 1 : np - 2]!;
    const down = other[1] > y || (other[1] === y && j === 0);
    const pts: Vec3[] = [];
    const count = full ? seg : seg + 1;
    for (let i = 0; i < count; i++) pts.push(at(i, j, [0, 0, 0]));
    if (!full) pts.push([0, y, 0]);
    const ordered = faceNormal(pts)[1] * (down ? -1 : 1) >= 0 ? pts : [...pts].reverse();
    writePolygon(b, ordered, payload, s, part, faces++, fan, 0, j);
  };
  if (o.capStart) cap(0, 'start');
  if (o.capEnd) cap(np - 1, 'end');
  if (!full && o.sides) {
    for (const i of [0, seg]) {
      const pts: Vec3[] = [];
      for (let j = 0; j < np; j++) pts.push(at(i, j, [0, 0, 0]));
      const yTop = profile[np - 1]![1], yBottom = profile[0]![1];
      if (profile[np - 1]![0] > 1e-12) pts.push([0, yTop, 0]);
      if (profile[0]![0] > 1e-12) pts.push([0, yBottom, 0]);
      // The meridian at `from` faces −θ, the one at `to` faces +θ: order the polygon to match.
      const nrm = faceNormal(pts);
      const t = angle(i);
      const want: Vec3 = i === 0 ? [-Math.cos(t), 0, Math.sin(t)] : [Math.cos(t), 0, -Math.sin(t)];
      writePolygon(b, dot(nrm, want) * (to > from ? 1 : -1) >= 0 ? pts : [...pts].reverse(), payload, s, 'cut', faces++, false, 0, i === 0 ? 0 : 1);
    }
  }
  return first;
}

// --- Sweep ------------------------------------------------------------------------------------------------------------

/** A frame along a path: tangent `t`, and `u`, `v` across it (v = t × u). */
export interface PathFrame {
  t: Vec3;
  u: Vec3;
  v: Vec3;
}

/**
 * Rotation-minimising frames along a polyline (parallel transport): the first `u` is the direction across the
 * tangent closest to perpendicular to `up` (u = up × t), then each next `u` is the previous one with its tangent part
 * removed, so the frame does not twist. With `closed` the path's ends are neighbours for the tangents.
 */
export function pathFrames(path: readonly ArrayLike<number>[], up: ArrayLike<number> = [0, 1, 0], closed = false): PathFrame[] {
  const out: PathFrame[] = [];
  const n = path.length;
  let prev: Vec3 | null = null;
  const across = (t: Vec3): Vec3 => {
    let ref: ArrayLike<number> = up;
    const ul = Math.sqrt(dot(up, up)) || 1;
    if (Math.abs(dot(t, up) / ul) > 0.97) ref = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    return unit(cross(ref, t));
  };
  for (let k = 0; k < n; k++) {
    const a = closed ? path[(k - 1 + n) % n]! : path[Math.max(0, k - 1)]!;
    const c = closed ? path[(k + 1) % n]! : path[Math.min(n - 1, k + 1)]!;
    const t = unit(sub(c, a));
    let u: Vec3;
    if (!prev) u = across(t);
    else {
      const d = dot(prev, t);
      u = [prev[0] - t[0] * d, prev[1] - t[1] * d, prev[2] - t[2] * d];
      if (dot(u, u) < 1e-12) u = across(t);
      unit(u);
    }
    out.push({ t, u, v: cross(t, u) });
    prev = u;
  }
  return out;
}

/**
 * A smooth curve through `points` (centripetal Catmull–Rom): `steps` samples per segment, the given points kept. With
 * `closed` the curve returns to its start (the first point is not repeated at the end).
 */
export function smoothPath(points: readonly ArrayLike<number>[], steps: number, closed = false): Vec3[] {
  const n = points.length;
  const out: Vec3[] = [];
  if (n < 2 || steps <= 1) {
    for (const p of points) out.push([p[0]!, p[1]!, p[2]!]);
    return out;
  }
  const P = (k: number): ArrayLike<number> => {
    if (closed) return points[((k % n) + n) % n]!;
    if (k < 0) {
      const a = points[0]!, b = points[1]!;
      return [2 * a[0]! - b[0]!, 2 * a[1]! - b[1]!, 2 * a[2]! - b[2]!];
    }
    if (k >= n) {
      const a = points[n - 1]!, b = points[n - 2]!;
      return [2 * a[0]! - b[0]!, 2 * a[1]! - b[1]!, 2 * a[2]! - b[2]!];
    }
    return points[k]!;
  };
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2);
    const knot = (a: ArrayLike<number>, c: ArrayLike<number>): number => Math.max(1e-9, Math.sqrt(Math.sqrt(dot(sub(c, a), sub(c, a)))));
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let s = 0; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const q: Vec3 = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const a1 = ((t1 - t) * p0[c]! + (t - t0) * p1[c]!) / (t1 - t0);
        const a2 = ((t2 - t) * p1[c]! + (t - t1) * p2[c]!) / (t2 - t1);
        const a3 = ((t3 - t) * p2[c]! + (t - t2) * p3[c]!) / (t3 - t2);
        const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
        const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
        q[c] = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
      }
      out.push(q);
    }
  }
  if (!closed) {
    const l = points[n - 1]!;
    out.push([l[0]!, l[1]!, l[2]!]);
  }
  return out;
}

export interface SweepOptions {
  /** The section is a closed loop (default true). */
  closed?: boolean;
  /** The path is a closed loop (a ring); its first point is not repeated at the end. */
  loop?: boolean;
  /** Close both ends with the section as a flat polygon (closed sections on open paths only). */
  caps?: boolean;
  /** Cap polygons as fans from a centre vertex instead of from their first corner. */
  capFan?: boolean;
  /** Scale of the section at a share 0–1 of the path length. */
  scale?: (f: number) => number;
  /** Turn of the section at a share 0–1 of the path length, radians (counter-clockwise in u–v). */
  twist?: (f: number) => number;
  /** Up hint of the first frame. Default +y. */
  up?: ArrayLike<number>;
  /** Smooth normals (default), one flat face per cell (false), or hard section corners smooth along the path ('along'). */
  smooth?: GridSmooth;
  /** Smooth the path first: this many samples per segment (centripetal Catmull–Rom through the points). */
  subdivide?: number;
  /** Moves grid points (i along the section, j along the path) before normals are taken. */
  warp?: ShapeWarp;
}

/**
 * Pulls a section ([x, y] in the frame u–v across the path) along a path of 3D points with rotation-minimising
 * frames. A closed section given counter-clockwise in u–v faces outward; a clockwise one is turned around, so the
 * faces always point away from the path. Side vertices report `i` the section point, `j` the path point, `u` the
 * share along the section, `v` the share of the path length. Returns the index of the first vertex written.
 */
export function sweep<V>(b: MeshBuilder<V>, path: readonly ArrayLike<number>[], section: readonly (readonly [number, number])[], payload: ShapePayload<V>, o: SweepOptions = {}): number {
  const first = b.vertexCount;
  const pts = o.subdivide && o.subdivide > 1 ? smoothPath(path, o.subdivide, !!o.loop) : path.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3);
  const np = section.length;
  if (pts.length < 2 || np < 2) return first;
  const closed = o.closed ?? true;
  const loop = !!o.loop;
  const frames = pathFrames(pts, o.up ?? [0, 1, 0], loop);
  const along = arcShares(pts, 3, loop);
  let area = 0;
  for (let k = 0; k < np; k++) {
    const a = section[k]!, c = section[(k + 1) % np]!;
    area += a[0] * c[1] - c[0] * a[1];
  }
  const flip = closed && area < 0;
  const at = (i: number, j: number, out: Vec3): Vec3 => {
    const f = along[j]!;
    const sc = o.scale ? o.scale(f) : 1;
    const tw = o.twist ? o.twist(f) : 0;
    const c = Math.cos(tw), s = Math.sin(tw);
    const [x, y] = section[i]!;
    const rx = (c * x - s * y) * sc, ry = (s * x + c * y) * sc;
    const { u, v } = frames[j]!;
    const p = pts[j]!;
    for (let k = 0; k < 3; k++) out[k] = p[k]! + u[k]! * rx + v[k]! * ry;
    if (o.warp) o.warp(out, i, j);
    return out;
  };
  let faces = gridSurface(b, np, pts.length, at, payload, {
    smooth: o.smooth ?? true,
    wrapI: closed,
    wrapJ: loop,
    flip,
    u: arcShares(section, 2, closed),
    v: along,
  });
  if (closed && !loop && o.caps) {
    const s = new Facts();
    for (const [j, part] of [[0, 'start'], [pts.length - 1, 'end']] as const) {
      const ring: Vec3[] = [];
      for (let i = 0; i < np; i++) ring.push(at(i, j, [0, 0, 0]));
      // The start cap faces back along the path (−t), the end cap forward.
      const want = frames[j]!.t;
      const nrm = faceNormal(ring);
      const forward = dot(nrm, want) >= 0;
      const ordered = forward === (part === 'end') ? ring : ring.reverse();
      writePolygon(b, ordered, payload, s, part, faces++, !!o.capFan, 0, j);
    }
  }
  return first;
}

// --- Extrusion --------------------------------------------------------------------------------------------------------

export interface ExtrudeOptions {
  /** Close the start (z0, facing −z) / end (z1, facing +z). Default both. */
  capStart?: boolean;
  capEnd?: boolean;
  /** Cap polygons as fans from a centre vertex instead of from their first corner (concave caps are ear-clipped). */
  capFan?: boolean;
  /** Smooth normals around the outline (a rounded outline) instead of one flat face per edge (default). */
  smooth?: boolean;
}

/**
 * An outline ([x, y] points, counter-clockwise seen from +z; a clockwise one is turned around) pushed from z = z0 to
 * z = z1. Each side face is a flat quad with corners (p, z0) (q, z0) (q, z1) (p, z1) for the edge p → q, reported as
 * `corner` 0–3, with `i` the outline point, `j` 0 at z0 and 1 at z1, `u` the share along the outline and `v` 0 or 1.
 * To extrude upward from a ground outline, push a rotation (+z onto +y) first. Returns the first vertex index.
 */
export function extrude<V>(b: MeshBuilder<V>, outline: readonly (readonly [number, number])[], z0: number, z1: number, payload: ShapePayload<V>, o: ExtrudeOptions = {}): number {
  const first = b.vertexCount;
  let pts = outline;
  if (pts.length < 3) return first;
  let area = 0;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]!, c = pts[(k + 1) % pts.length]!;
    area += a[0] * c[1] - c[0] * a[1];
  }
  if (area < 0) pts = [...pts].reverse();
  const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
  const n = pts.length;
  const s = new Facts();
  let faces = 0;
  const shares = arcShares(pts, 2, true);
  if (o.smooth) {
    faces = gridSurface(b, n, 2, (i, j, out) => {
      const p = pts[i]!;
      out[0] = p[0];
      out[1] = p[1];
      out[2] = j === 0 ? lo : hi;
      return out;
    }, payload, { wrapI: true, u: shares, v: [0, 1] });
  } else {
    for (let k = 0; k < n; k++) {
      const p = pts[k]!, q = pts[(k + 1) % n]!;
      const quad: Vec3[] = [[p[0], p[1], lo], [q[0], q[1], lo], [q[0], q[1], hi], [p[0], p[1], hi]];
      const nrm = faceNormal(quad);
      const firstV = b.vertexCount;
      const corners: [number, number][] = [[k, 0], [k + 1, 0], [k + 1, 1], [k, 1]];
      quad.forEach((c, m) => {
        const [i, j] = corners[m]!;
        b.vertex(c, nrm, payload(s.set(c, nrm, 'side', i, j, shares[i]!, j, faces, m)));
      });
      b.quad(firstV, firstV + 1, firstV + 2, firstV + 3);
      faces++;
    }
  }
  const fan = !!o.capFan;
  if (o.capEnd ?? true) writePolygon(b, pts.map((p) => [p[0], p[1], hi] as Vec3), payload, s, 'end', faces++, fan, 0, 1);
  if (o.capStart ?? true) writePolygon(b, pts.map((p) => [p[0], p[1], lo] as Vec3).reverse(), payload, s, 'start', faces++, fan, 0, 0);
  return first;
}

// --- Special cases ----------------------------------------------------------------------------------------------------

/**
 * An axis-aligned box from `min` to `max`: an extrusion of the x–y rectangle along z, six flat faces (sides first,
 * then +z, then −z). Returns the first vertex index.
 */
export function box<V>(b: MeshBuilder<V>, min: ArrayLike<number>, max: ArrayLike<number>, payload: ShapePayload<V>): number {
  const x0 = min[0]!, y0 = min[1]!, x1 = max[0]!, y1 = max[1]!;
  return extrude(b, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], min[2]!, max[2]!, payload);
}

export interface CylinderOptions {
  /** Segments around. Default 24. */
  segments?: number;
  /** Radius at y1 (default the same: a cylinder; otherwise a cone frustum, 0 an apex). */
  radiusTop?: number;
  /** Close the bottom / top disc. Default both. */
  capStart?: boolean;
  capEnd?: boolean;
  /** Smooth sides (default) or flat. */
  smooth?: boolean;
}

/** A cylinder (or cone frustum) about +y from y0 to y1: a revolution of a two-point profile. */
export function cylinder<V>(b: MeshBuilder<V>, radius: number, y0: number, y1: number, payload: ShapePayload<V>, o: CylinderOptions = {}): number {
  return revolve(b, [[radius, y0], [o.radiusTop ?? radius, y1]], payload, {
    segments: o.segments ?? 24,
    smooth: o.smooth ?? true,
    capStart: o.capStart ?? true,
    capEnd: o.capEnd ?? true,
  });
}
