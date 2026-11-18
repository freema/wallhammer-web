// The station's shapes: the engine's bare shapes (gen-mesh: polygon, revolve, extrude, gridSurface) with the
// outpost style given per vertex (kit/mesh.ts `style`): panel coordinates so that the toon shader draws the edges a
// comic artist would ink (box edges, cylinder rims, lathe panel seams, rock creases), and the current colour, tone and
// outline of the builder. Every shape stands on y = 0 of its local frame (or runs along an axis given in local
// coordinates).
//
// Winding: counter-clockwise seen from outside. Normals: per face on hard shapes, smooth on shells of revolution.

import { extrude, gridSurface, polygon as barePolygon, revolve } from 'wallhammer-web/gen-mesh';
import type { Vec3 } from 'wallhammer-web/base';
import type { ShapeVertex } from 'wallhammer-web/gen-mesh';
import type { MeshBuilder } from './mesh.ts';
import { NO_LINE } from './mesh.ts';
import { add, cross, dot, normalize, sub } from './math.ts';
import type { Mat, V3 } from './math.ts';
import type { Stream } from './rng.ts';

const TAU = Math.PI * 2;

function set3(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** Frame lines of a quad face, by corner in winding order. */
const QUAD_LINES: readonly V3[] = [[0, 0, 0.5], [1, 0, 0.5], [1, 1, 0.5], [0, 1, 0.5]];
/** Fan faces: the rim gets a line (radial coordinate 0 at the rim, 0.5 in the middle). */
const RIM_LINE: V3 = [0, 0.5, 0.5];

/** Style of a flat face: a quad gets a frame on its four edges, a fan a line round its rim. */
function faceLine(s: ShapeVertex, corners: number, lines: boolean): V3 {
  if (!lines) return NO_LINE;
  if (s.centre) return NO_LINE;
  return corners === 4 ? QUAD_LINES[s.corner]! : RIM_LINE;
}

/** A flat polygon (points counter-clockwise seen from the front). A quad gets a frame line on its four edges, other
 * polygons are a fan from their centre with a line round the rim. */
export function polygon(b: MeshBuilder, pts: readonly V3[], lines = true): void {
  if (pts.length < 3) return;
  const n = pts.length;
  barePolygon(b, pts, (s) => b.style(faceLine(s, n, lines)), { fan: n !== 4 });
}

/**
 * A frustum of a box: the bottom rectangle `bottom` [width x, depth z] at y = 0, the top rectangle `top` at y = `h`,
 * the top shifted by `shift` [x, z]. Six faces, each with its edge frame.
 */
export function frustumBox(b: MeshBuilder, bottom: readonly [number, number], top: readonly [number, number], h: number, o: { shift?: readonly [number, number]; lines?: boolean; bottomFace?: boolean } = {}): void {
  const [sx, sz] = o.shift ?? [0, 0];
  const lines = o.lines ?? true;
  const bw = bottom[0] / 2, bd = bottom[1] / 2, tw = top[0] / 2, td = top[1] / 2;
  const B: V3[] = [[-bw, 0, bd], [bw, 0, bd], [bw, 0, -bd], [-bw, 0, -bd]];
  const T: V3[] = [[sx - tw, h, sz + td], [sx + tw, h, sz + td], [sx + tw, h, sz - td], [sx - tw, h, sz - td]];
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    polygon(b, [B[k]!, B[k1]!, T[k1]!, T[k]!], lines);
  }
  polygon(b, [T[0]!, T[1]!, T[2]!, T[3]!], lines);
  if (o.bottomFace) polygon(b, [B[3]!, B[2]!, B[1]!, B[0]!], lines);
}

/** An axis-aligned box [x, y, z] standing on y = 0, centred on x and z. */
export function box(b: MeshBuilder, size: V3, o: { lines?: boolean; bottomFace?: boolean } = {}): void {
  frustumBox(b, [size[0], size[2]], [size[0], size[2]], size[1], o);
}

export interface LatheOptions {
  /** Segments around. Default 32. */
  segments?: number;
  /** Vertical panel seams: this many around (0 = none). Must divide `segments` for straight seams. */
  ribs?: number;
  /** Profile point indices that get a horizontal seam. */
  rings?: readonly number[];
  /** Angle range in radians (default the full turn); a partial lathe is open at its ends. */
  from?: number;
  to?: number;
}

/**
 * A surface of revolution about +y from a profile of [radius, y] points, bottom to top (the engine's `revolve`). The
 * angle θ runs from +z toward +x. Seams: `ribs` meridians and `rings` parallels.
 */
export function lathe(b: MeshBuilder, profile: readonly (readonly [number, number])[], o: LatheOptions = {}): void {
  const ribs = o.ribs ?? 0;
  const np = profile.length;
  // Panel coordinate along the profile: the m-th seam ring is at the integer m, between rings it runs linearly, and
  // before the first / after the last ring it stays within half a unit, so no other line appears.
  const marks = [...new Set(o.rings ?? [])].sort((x, y) => x - y);
  const vAt: number[] = [];
  for (let i = 0; i < np; i++) {
    if (!marks.length) {
      vAt.push(0.5);
      continue;
    }
    const f = marks[0]!, l = marks[marks.length - 1]!;
    if (i <= f) vAt.push(-0.5 * ((f - i) / Math.max(f, 1)));
    else if (i >= l) vAt.push(marks.length - 1 + 0.5 * ((i - l) / Math.max(np - 1 - l, 1)));
    else {
      let m = 0;
      while (marks[m + 1]! <= i) m++;
      vAt.push(m + (i - marks[m]!) / (marks[m + 1]! - marks[m]!));
    }
  }
  revolve(b, profile, (s) => b.style([ribs > 0 ? s.u * ribs : 0.5, vAt[s.j]!, 0.5]), { segments: o.segments ?? 32, from: o.from ?? 0, to: o.to ?? TAU });
}

export interface CylinderOptions {
  segments?: number;
  /** Radius at the top (default `r`: a cylinder; otherwise a cone frustum). */
  rTop?: number;
  /** Close the top / bottom with a disc. Default top only. */
  top?: boolean;
  bottom?: boolean;
  /** Vertical seams around. Default 0. */
  ribs?: number;
  /** Rim lines where the side meets the caps. Default true. */
  rims?: boolean;
}

/** A cylinder (or cone frustum) about +y from y = 0 to y = h. */
export function cylinder(b: MeshBuilder, r: number, h: number, o: CylinderOptions = {}): void {
  const seg = o.segments ?? 20;
  const rt = o.rTop ?? r;
  const rims = o.rims ?? true;
  lathe(b, [[r, 0], [rt, h]], { segments: seg, ribs: o.ribs ?? 0, rings: rims ? [0, 1] : [] });
  const disc = (y: number, rad: number, up: boolean): void => {
    const pts: V3[] = [];
    for (let j = 0; j < seg; j++) {
      const t = (TAU * j) / seg;
      pts.push([rad * Math.sin(t), y, rad * Math.cos(t)]);
    }
    if (!up) pts.reverse();
    polygon(b, pts, rims);
  };
  if (o.top ?? true) disc(h, rt, true);
  if (o.bottom) disc(0, r, false);
}

/** A local frame whose +y runs from `a` to `b`: the transform for a shape built along +y. */
function along(a: V3, c: V3): { x: V3; y: V3; z: V3; len: number } {
  const d = sub(c, a);
  const len = Math.hypot(d[0], d[1], d[2]);
  const y = normalize(d);
  const ref: V3 = Math.abs(y[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize(cross(y, ref));
  const z = cross(x, y);
  return { x, y, z, len };
}

/** The transform whose local +y runs from `a` to `c` (its length is |c − a|); for shapes built along +y. */
export function frameAlong(a: V3, c: V3): { m: Mat; len: number } {
  const f = along(a, c);
  return { m: [f.x[0], f.x[1], f.x[2], f.y[0], f.y[1], f.y[2], f.z[0], f.z[1], f.z[2], a[0], a[1], a[2]], len: f.len };
}

/** A cylinder from point `a` to point `c` (local coordinates) of radius `r`; open ends unless `caps`. */
export function tube(b: MeshBuilder, a: V3, c: V3, r: number, o: CylinderOptions = {}): void {
  const f = frameAlong(a, c);
  b.with(f.m, () => cylinder(b, r, f.len, { top: false, ...o }));
}

/**
 * A pipe along a polyline (local coordinates): straight runs of radius `r` with a slightly wider flange ring at every
 * corner and both ends, which also hides the open corner of the bend.
 */
export function pipeRun(b: MeshBuilder, pts: readonly V3[], r: number, o: { flange?: number; segments?: number } = {}): void {
  const seg = o.segments ?? 8;
  const fl = o.flange ?? r * 1.45;
  for (let k = 0; k + 1 < pts.length; k++) tube(b, pts[k]!, pts[k + 1]!, r, { segments: seg, rims: false, top: false });
  for (let k = 0; k < pts.length; k++) {
    // The flange follows the incoming run (the outgoing one at the start).
    const a = pts[Math.max(0, k - 1)]!, c = pts[k === 0 ? 1 : k]!;
    const d = normalize(sub(c, a));
    const h = fl * 0.7;
    tube(b, [pts[k]![0] - d[0] * h, pts[k]![1] - d[1] * h, pts[k]![2] - d[2] * h], [pts[k]![0] + d[0] * h, pts[k]![1] + d[1] * h, pts[k]![2] + d[2] * h], fl, { segments: seg, top: true, bottom: true });
  }
}

/**
 * A curved panel on the outside of a vertical cylinder of radius `r` (windows, hatches): from angle `a0` to `a1`
 * (radians, θ from +z toward +x), from y0 to y1, with `panes` vertical divisions and a frame line all round. With
 * `rTop` the radius changes linearly to `rTop` at y1: a panel on a cone band (a sloped window ring).
 */
export function curvedPanel(b: MeshBuilder, r: number, a0: number, a1: number, y0: number, y1: number, o: { panes?: number; segments?: number; rTop?: number } = {}): void {
  const panes = o.panes ?? 1;
  const seg = o.segments ?? Math.max(2, Math.ceil(((a1 - a0) / TAU) * 64));
  const rt = o.rTop ?? r;
  // Cone normal in the r–y plane.
  const ln = Math.hypot(y1 - y0, r - rt) || 1;
  const nr = (y1 - y0) / ln, ny = (r - rt) / ln;
  const angle = (i: number): number => a0 + ((a1 - a0) * i) / seg;
  gridSurface(
    b,
    seg + 1,
    2,
    (i, j, out) => {
      const t = angle(i), rr = j === 0 ? r : rt;
      out[0] = rr * Math.sin(t);
      out[1] = j === 0 ? y0 : y1;
      out[2] = rr * Math.cos(t);
      return out;
    },
    (s) => b.style([(s.i / seg) * panes, s.j, 0.5]),
    { normalAt: (i, _j, out) => set3(out, nr * Math.sin(angle(i)), ny, nr * Math.cos(angle(i))) },
  );
}

/**
 * A flat rectangle in the x–y plane facing +z, `w` wide (centred on x) from y = 0 to `h`, divided by panel lines into
 * `cols` × `rows` cells with a frame round it: solar cells, grilles (one row, many columns), drawers (one column).
 */
export function panelGrid(b: MeshBuilder, w: number, h: number, cols: number, rows: number): void {
  const x = w / 2;
  const i0 = b.ink([-x, 0, 0], [0, 0, 1], [0, 0, 0.5]);
  const i1 = b.ink([x, 0, 0], [0, 0, 1], [cols, 0, 0.5]);
  const i2 = b.ink([x, h, 0], [0, 0, 1], [cols, rows, 0.5]);
  const i3 = b.ink([-x, h, 0], [0, 0, 1], [0, rows, 0.5]);
  b.quad(i0, i1, i2, i3);
}

/**
 * A prism: the outline `pts` ([x, y], counter-clockwise seen from +z) extruded from z = z0 to z = z1 (z1 > z0). The
 * front (z1) and back caps are polygons with a rim line; every side face has its edge frame.
 */
export function prism(b: MeshBuilder, pts: readonly (readonly [number, number])[], z0: number, z1: number, o: { back?: boolean } = {}): void {
  const n = pts.length;
  // Side corners (p, z0) (q, z0) (q, z1) (p, z1) carry the frame as the polygon (p, z1) (p, z0) (q, z0) (q, z1) did.
  const side: readonly V3[] = [QUAD_LINES[1]!, QUAD_LINES[2]!, QUAD_LINES[3]!, QUAD_LINES[0]!];
  extrude(b, pts, z0, z1, (s) => b.style(s.part === 'side' ? side[s.corner]! : faceLine(s, n, true)), { capStart: o.back ?? true, capFan: n !== 4 });
}

/**
 * A flat band between two outlines with the same number of points (an outer and an inner one, both counter-clockwise
 * from +z) in the plane z: a door trim, a painted ring. Lines on both edges.
 */
export function band(b: MeshBuilder, outer: readonly (readonly [number, number])[], inner: readonly (readonly [number, number])[], z: number): void {
  const n = outer.length;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const ids = [
      b.ink([outer[k]![0], outer[k]![1], z], [0, 0, 1], [0.5, 0, 0.5]),
      b.ink([outer[k1]![0], outer[k1]![1], z], [0, 0, 1], [0.5, 0, 0.5]),
      b.ink([inner[k1]![0], inner[k1]![1], z], [0, 0, 1], [0.5, 1, 0.5]),
      b.ink([inner[k]![0], inner[k]![1], z], [0, 0, 1], [0.5, 1, 0.5]),
    ];
    b.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
  }
}

/**
 * A band of constant width over a cap of revolution (a stripe painted over a shell). The cap is given by its profile
 * `capAt(t)` → [radius, y] for t from 0 to 1, and the band runs along the meridian at angle `azimuth` (θ from +z toward
 * +x) from t0 to t1, `width` metres wide, lifted `lift` metres off the surface. Frame lines on its long edges.
 */
export function capBand(b: MeshBuilder, capAt: (t: number) => readonly [number, number], azimuth: number, width: number, t0: number, t1: number, o: { lift?: number; steps?: number; across?: number } = {}): void {
  const lift = o.lift ?? 0.03;
  const steps = o.steps ?? 24;
  const across = o.across ?? 4;
  // Per row along the meridian: radius, height and the outward normal in the r–y plane.
  const R: number[] = [], Y: number[] = [], NR: number[] = [], NY: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const [r, y] = capAt(t);
    const e = 1e-3;
    const [ra, ya] = capAt(Math.max(0, t - e)), [rb, yb] = capAt(Math.min(1, t + e));
    const dr = rb - ra, dy = yb - ya;
    const l = Math.hypot(dr, dy) || 1;
    R.push(r), Y.push(y), NR.push(dy / l), NY.push(-dr / l);
  }
  // Constant width across: an angle offset that gives `width` at this radius (capped near the apex).
  const angle = (k: number, i: number): number => azimuth + Math.asin(Math.max(-0.95, Math.min(0.95, ((k / across - 0.5) * width) / Math.max(R[i]!, 1e-3))));
  gridSurface(
    b,
    across + 1,
    steps + 1,
    (k, i, out) => {
      const t = angle(k, i), rr = R[i]! + NR[i]! * lift;
      return set3(out, rr * Math.sin(t), Y[i]! + NY[i]! * lift, rr * Math.cos(t));
    },
    (s) => b.style([s.i / across, 0.5, 0.5]),
    { normalAt: (k, i, out) => set3(out, NR[i]! * Math.sin(angle(k, i)), NY[i]!, NR[i]! * Math.cos(angle(k, i))) },
  );
}

// --- Rocks -------------------------------------------------------------------------------------------------------------

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V: V3[] = (
  [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ] as V3[]
).map((v) => normalize(v));
const ICO_F: [number, number, number][] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/**
 * An angular rock: an icosahedron with every corner pushed in or out (seeded by `keys`), squashed to `size`
 * [x, y, z] and standing with its lowest point `sink` metres below y = 0. Flat facets; edges where the facets bend by
 * more than `creaseDeg` get a line.
 */
export function rock(b: MeshBuilder, rng: Stream, keys: readonly number[], size: V3, o: { sink?: number; creaseDeg?: number; jitter?: number } = {}): void {
  const jitter = o.jitter ?? 0.32;
  const v = ICO_V.map((p, i) => {
    const s = 1 + jitter * rng.signed(...keys, i);
    return [p[0] * s * size[0] * 0.5, p[1] * s * size[1] * 0.5, p[2] * s * size[2] * 0.5] as V3;
  });
  let minY = Infinity;
  for (const p of v) minY = Math.min(minY, p[1]);
  const lift = -minY - (o.sink ?? size[1] * 0.25);
  const P = v.map((p) => add(p, [0, lift, 0]));
  const fn = ICO_F.map(([a, c, d]) => normalize(cross(sub(P[c]!, P[a]!), sub(P[d]!, P[a]!))));
  // Neighbour across each edge.
  const edgeFace = new Map<string, number>();
  ICO_F.forEach((f, i) => {
    for (let k = 0; k < 3; k++) edgeFace.set(`${f[k]},${f[(k + 1) % 3]}`, i);
  });
  const cosCrease = Math.cos(((o.creaseDeg ?? 28) * Math.PI) / 180);
  ICO_F.forEach((f, i) => {
    // Component k is 0 on the edge opposite corner k; an edge without a crease keeps its component off the integers.
    const crease = [0, 1, 2].map((k) => {
      const a = f[(k + 1) % 3]!, c = f[(k + 2) % 3]!;
      const nb = edgeFace.get(`${c},${a}`);
      return nb !== undefined && dot(fn[i]!, fn[nb]!) < cosCrease;
    });
    const corner = (k: number): V3 => {
      const L = [0, 1, 2].map((j) => (crease[j] ? (j === k ? 0.5 : 0) : j === k ? 0.5 : 0.25));
      return [L[0]!, L[1]!, L[2]!];
    };
    const ids = [0, 1, 2].map((k) => b.ink(P[f[k]!]!, fn[i]!, corner(k)));
    b.tri(ids[0]!, ids[1]!, ids[2]!);
  });
}

/** A shallow wedge ramp or step block: `w` wide (x), `d` deep (z), rising from 0 at +z to `h` at −z. */
export function wedge(b: MeshBuilder, w: number, d: number, h: number, lines = true): void {
  const x = w / 2, z = d / 2;
  polygon(b, [[-x, 0, z], [x, 0, z], [x, h, -z], [-x, h, -z]], lines);
  polygon(b, [[x, 0, -z], [-x, 0, -z], [-x, h, -z], [x, h, -z]], lines);
  polygon(b, [[x, 0, z], [x, 0, -z], [x, h, -z]], lines);
  polygon(b, [[-x, 0, -z], [-x, 0, z], [-x, h, -z]], lines);
}

/** Points of a regular polygon of `n` corners and circumradius `r` in the x–z plane at height y (counter-clockwise from above). */
export function ring(n: number, r: number, y = 0, phase = 0): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const t = phase + (TAU * k) / n;
    out.push([r * Math.sin(t), y, r * Math.cos(t)]);
  }
  return out;
}

