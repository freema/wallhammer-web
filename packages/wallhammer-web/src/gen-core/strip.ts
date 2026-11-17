// A strip laid along a broken line on the base surface (a plane, or a sphere seen from its centre): data and the
// height function a cell generator calls to cut or fill the ground under it. The mesh of the strip is gen-mesh's
// `stripMesh`; what it stands for is up to the content.
//
// - A line is a list of points on the base surface with a grade per point (the height of the section's zero above
//   the base surface) and a half-width per point. A profile gives the section across the line: pairs (across, up)
//   from left to right, across in half-widths. Points beyond ±1 are a hem hanging from the edge point.
// - `stripNet` turns the input into stations: centre, left edge and right edge of the strip at every point, with the
//   grade, a camber factor and the metres along the line. Between two stations the centre and both edges are straight
//   ways (a segment on the plane, a great arc on the sphere), so every station pair is one piece of the strip.
// - At an inner point the edges are mitred: on the bisector of the two segments, at `w / max(cos, 0.5)` from the
//   centre. A free end, and a node that holds one line only, ends square.
// - Lines that meet at a node are ordered around it by a pseudo-angle; neighbours meet at one corner each, where
//   their edges cross (at most three times the larger half-width from the node). A line's last station there is flat
//   at the node's height and reaches from the node to its two corners, and one more station stands where the line is
//   as far from the node as its farther corner: the camber returns between the two.
// - The height function inverts the stations: for a point it finds the share t along each piece and the share a
//   across it, and blends the ground toward the section over the shoulder.
//
// Everything is arithmetic and `Math.sqrt` (with the reproducible arc tangent of base for lengths on the sphere): no
// seed, no clock, no shared state. The output is a function of the input alone.

import { detAtan } from '../base/trig.ts';
import { directionTangents } from './cube-sphere.ts';

type P3 = readonly [number, number, number];

/** The section across a line and how the ground meets it. */
export interface StripProfile {
  /**
   * Left to right, pairs (across, upM): across in half-widths, non-decreasing, holding −1 and 1; upM metres above the
   * grade. Points beyond ±1 are a hem hanging from the edge point.
   */
  section: readonly number[];
  /** Metres beyond ±1 over which the ground returns to its own height. */
  shoulderM: number;
  /** Metres the ground lies below the section between −1 and 1. */
  bedM: number;
}

/** A point where lines end together. */
export interface StripNode {
  point: P3;
  heightM: number;
}

export interface StripLine {
  /** Centre line on the base surface, x y z per point (plane: y = 0; sphere: the direction counts). */
  points: ArrayLike<number>;
  /** Grade per point: height of the section's zero above the base surface. */
  heights: ArrayLike<number>;
  /** Half-width in metres, per point or one for all. */
  halfWidths: ArrayLike<number> | number;
  /** Index into `StripInput.profiles`. */
  profile: number;
  /** Node indices of the two ends; absent = a free end. The end point and its height are taken from the node. */
  from?: number;
  to?: number;
}

export interface StripInput {
  /** Radius of the base sphere in metres; 0 = the plane y = 0, up +y. */
  radiusM: number;
  profiles: StripProfile[];
  nodes?: StripNode[];
  lines: StripLine[];
}

/** Numbers per station: centre xyz, left edge xyz, right edge xyz, grade, camber factor, metres along the line. */
export const STRIP_STATION_FLOATS = 12;

/** One line of a net, as the mesher reads it. */
export interface StripNetLine {
  /** Index into `StripNet.profiles`. */
  readonly profile: number;
  /** Number of stations; station k and k + 1 bound piece k. */
  readonly count: number;
  /** `STRIP_STATION_FLOATS` numbers per station, in order along the line. */
  readonly stations: Float64Array;
  /** Whether the first and the last station end the strip square (a free end or a node of one line). */
  readonly startSquare: boolean;
  readonly endSquare: boolean;
  /** Box that holds everything the line changes or draws: min xyz, max xyz. */
  readonly box: Float64Array;
  /** Per piece a ball that holds everything the piece changes or draws: centre xyz, radius. */
  readonly balls: Float64Array;
}

export interface StripNet {
  /** 0 = plane. */
  readonly radiusM: number;
  readonly lineCount: number;
  /** Farthest distance from a centre line at which a line changes the ground or puts a vertex. */
  readonly reachM: number;
  readonly profiles: readonly StripProfile[];
  readonly lines: readonly StripNetLine[];
}

/** What a point of the base surface has to do with the nearest line. */
export interface StripHit {
  line: number;
  /** Metres along the line (beyond a square end: negative, or past the length). */
  alongM: number;
  /** Signed metres across, positive to the right looking along the line (`tangent × up`). */
  acrossM: number;
  /** Half-width of the strip there. */
  halfWidthM: number;
  /** Grade there. */
  gradeM: number;
  /** 1 on the strip, falling to 0 at `shoulderM` past its edge. */
  share: number;
}

/** Height of a section above the grade at across `a` (half-widths), linear between its points, the hem excluded. */
export function stripUp(profile: StripProfile, a: number): number {
  const s = profile.section;
  const x = a < -1 ? -1 : a > 1 ? 1 : a;
  let prevA = NaN;
  let prevU = NaN;
  for (let i = 0; i < s.length; i += 2) {
    const sa = s[i]!;
    const su = s[i + 1]!;
    if (sa < -1) continue;
    if (sa >= x) {
      if (sa === x || prevA !== prevA) return su;
      return prevU + ((su - prevU) * (x - prevA)) / (sa - prevA);
    }
    prevA = sa;
    prevU = su;
  }
  return prevU;
}

/** Length of a line in metres (along the centre, the same measure as `alongM`). */
export function stripLength(net: StripNet, line: number): number {
  const l = net.lines[line];
  if (!l) throw new Error(`stripLength: no line ${line}`);
  return l.stations[(l.count - 1) * STRIP_STATION_FLOATS + 11]!;
}

// --- Making the net -------------------------------------------------------------------------------------------------

function norm3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Pseudo-angle 0 … 4 of (p, q), growing with the angle from (1, 0) toward (0, 1). */
function pseudoAngle(p: number, q: number): number {
  const s = Math.abs(p) + Math.abs(q);
  return q >= 0 ? 1 - p / s : 3 + p / s;
}

interface Builder {
  sphere: boolean;
  R: number;
}

/** A point put on the base surface. */
function onSurface(b: Builder, x: number, y: number, z: number, out: number[], at: number): void {
  if (b.sphere) {
    const l = norm3(x, y, z);
    out[at] = (x / l) * b.R;
    out[at + 1] = (y / l) * b.R;
    out[at + 2] = (z / l) * b.R;
  } else {
    out[at] = x;
    out[at + 1] = 0;
    out[at + 2] = z;
  }
}

/** Unit up at a point of the base surface. */
function upOf(b: Builder, p: ArrayLike<number>, at: number): [number, number, number] {
  if (!b.sphere) return [0, 1, 0];
  const l = norm3(p[at]!, p[at + 1]!, p[at + 2]!);
  return [p[at]! / l, p[at + 1]! / l, p[at + 2]! / l];
}

/** Unit direction along the surface at point `a` toward point `c` (offsets into `p`). */
function towards(b: Builder, p: ArrayLike<number>, a: number, c: number): [number, number, number] {
  let x = p[c]! - p[a]!;
  let y = p[c + 1]! - p[a + 1]!;
  let z = p[c + 2]! - p[a + 2]!;
  const u = upOf(b, p, a);
  const d = x * u[0] + y * u[1] + z * u[2];
  x -= d * u[0];
  y -= d * u[1];
  z -= d * u[2];
  const l = norm3(x, y, z);
  if (!(l > 0)) throw new Error('stripNet: two points of a line coincide');
  return [x / l, y / l, z / l];
}

/** Length of the straight way between two points of the base surface. */
function wayLength(b: Builder, p: ArrayLike<number>, a: number, c: number): number {
  const chord = norm3(p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!);
  if (!b.sphere) return chord;
  const h = chord / 2;
  return 2 * b.R * detAtan(h / Math.sqrt(Math.max(0, b.R * b.R - h * h)));
}

interface Incidence {
  line: number;
  /** 0 = the line starts at the node, 1 = it ends there. */
  end: number;
  angle: number;
  /** Unit direction from the node into the line, in the node's tangent frame. */
  p: number;
  q: number;
  w: number;
}

export function stripNet(input: StripInput): StripNet {
  const R = input.radiusM;
  if (!(R >= 0) || !Number.isFinite(R)) throw new Error(`stripNet: radiusM must be 0 or positive, got ${R}`);
  const b: Builder = { sphere: R > 0, R };
  const profiles = input.profiles.map((pr, i) => {
    const s = pr.section;
    if (s.length < 4 || s.length % 2 !== 0) throw new Error(`stripNet: profile ${i}: section needs pairs, at least two`);
    let hasL = false;
    let hasR = false;
    for (let k = 0; k < s.length; k += 2) {
      if (!Number.isFinite(s[k]!) || !Number.isFinite(s[k + 1]!)) throw new Error(`stripNet: profile ${i}: section holds a number that is not finite`);
      if (k > 0 && s[k]! < s[k - 2]!) throw new Error(`stripNet: profile ${i}: across must not decrease`);
      if (s[k] === -1) hasL = true;
      if (s[k] === 1) hasR = true;
    }
    if (!hasL || !hasR) throw new Error(`stripNet: profile ${i}: section must hold across −1 and 1`);
    if (!(pr.shoulderM >= 0) || !Number.isFinite(pr.shoulderM)) throw new Error(`stripNet: profile ${i}: shoulderM must be 0 or positive`);
    if (!Number.isFinite(pr.bedM)) throw new Error(`stripNet: profile ${i}: bedM must be finite`);
    return { section: Array.from(s), shoulderM: pr.shoulderM, bedM: pr.bedM };
  });
  const nodes = (input.nodes ?? []).map((n, i) => {
    if (!n.point.every(Number.isFinite) || !Number.isFinite(n.heightM)) throw new Error(`stripNet: node ${i} is not finite`);
    const p: number[] = [0, 0, 0];
    onSurface(b, n.point[0], n.point[1], n.point[2], p, 0);
    return { p, h: n.heightM };
  });

  // Points, grades and half-widths per line, the ends taken from their nodes.
  const pts: number[][] = [];
  const grades: number[][] = [];
  const widths: number[][] = [];
  input.lines.forEach((ln, li) => {
    const n = ln.points.length / 3;
    if (!Number.isInteger(n) || n < 2) throw new Error(`stripNet: line ${li} needs at least two points, x y z each`);
    if (ln.heights.length !== n) throw new Error(`stripNet: line ${li}: one height per point`);
    if (typeof ln.halfWidths !== 'number' && ln.halfWidths.length !== n) throw new Error(`stripNet: line ${li}: one half-width per point`);
    if (!profiles[ln.profile]) throw new Error(`stripNet: line ${li}: no profile ${ln.profile}`);
    for (const end of [ln.from, ln.to]) if (end !== undefined && !nodes[end]) throw new Error(`stripNet: line ${li}: no node ${end}`);
    if (ln.from !== undefined && ln.from === ln.to) throw new Error(`stripNet: line ${li} starts and ends at one node`);
    const p: number[] = new Array(n * 3);
    const g: number[] = new Array(n);
    const w: number[] = new Array(n);
    for (let k = 0; k < n; k++) {
      onSurface(b, ln.points[k * 3]!, ln.points[k * 3 + 1]!, ln.points[k * 3 + 2]!, p, k * 3);
      g[k] = ln.heights[k]!;
      w[k] = typeof ln.halfWidths === 'number' ? ln.halfWidths : ln.halfWidths[k]!;
      if (!Number.isFinite(p[k * 3]!) || !Number.isFinite(p[k * 3 + 1]!) || !Number.isFinite(p[k * 3 + 2]!) || !Number.isFinite(g[k]!)) throw new Error(`stripNet: line ${li}: point ${k} is not finite`);
      if (!(w[k]! > 0) || !Number.isFinite(w[k]!)) throw new Error(`stripNet: line ${li}: half-width ${k} must be positive`);
    }
    if (ln.from !== undefined) {
      const nd = nodes[ln.from]!;
      p[0] = nd.p[0]!;
      p[1] = nd.p[1]!;
      p[2] = nd.p[2]!;
      g[0] = nd.h;
    }
    if (ln.to !== undefined) {
      const nd = nodes[ln.to]!;
      p[(n - 1) * 3] = nd.p[0]!;
      p[(n - 1) * 3 + 1] = nd.p[1]!;
      p[(n - 1) * 3 + 2] = nd.p[2]!;
      g[n - 1] = nd.h;
    }
    for (let k = 0; k + 1 < n; k++) if (p[k * 3] === p[k * 3 + 3] && p[k * 3 + 1] === p[k * 3 + 4] && p[k * 3 + 2] === p[k * 3 + 5]) throw new Error(`stripNet: line ${li}: points ${k} and ${k + 1} coincide`);
    pts.push(p);
    grades.push(g);
    widths.push(w);
  });

  // Corners of the nodes: per line end that sits at a node of two lines or more, its left and right corner.
  const endCorner: ({ left: number[]; right: number[] } | null)[][] = input.lines.map(() => [null, null]);
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni]!;
    const inc: Incidence[] = [];
    let e1: readonly number[] = [0, 0, 1];
    let e2: readonly number[] = [1, 0, 0];
    if (b.sphere) {
      const u = upOf(b, nd.p, 0);
      const t = directionTangents(u);
      e1 = t.t1;
      e2 = t.t2;
    }
    input.lines.forEach((ln, li) => {
      for (const end of [0, 1]) {
        if ((end === 0 ? ln.from : ln.to) !== ni) continue;
        const p = pts[li]!;
        const n = p.length / 3;
        const at = end === 0 ? 0 : (n - 1) * 3;
        const next = end === 0 ? 3 : (n - 2) * 3;
        const d = towards(b, p, at, next);
        const pp = d[0] * e1[0]! + d[1] * e1[1]! + d[2] * e1[2]!;
        const qq = d[0] * e2[0]! + d[1] * e2[1]! + d[2] * e2[2]!;
        const l = Math.sqrt(pp * pp + qq * qq);
        inc.push({ line: li, end, angle: pseudoAngle(pp / l, qq / l), p: pp / l, q: qq / l, w: widths[li]![end === 0 ? 0 : n - 1]! });
      }
    });
    if (inc.length < 2) continue;
    inc.sort((x, y) => x.angle - y.angle || x.line - y.line || x.end - y.end);
    const corners: number[][] = [];
    for (let k = 0; k < inc.length; k++) {
      const i = inc[k]!;
      const j = inc[(k + 1) % inc.length]!;
      // Line i's left edge (toward j) and line j's right edge (toward i), in the node's tangent frame.
      const lp = -i.q;
      const lq = i.p;
      const rp = j.q;
      const rq = -j.p;
      const wMax = Math.max(i.w, j.w);
      const sin = i.p * j.q - i.q * j.p;
      let cp: number;
      let cq: number;
      if (sin > 1e-9) {
        const hp = j.w * rp - i.w * lp;
        const hq = j.w * rq - i.w * lq;
        const s = (hp * j.q - hq * j.p) / sin;
        cp = i.w * lp + s * i.p;
        cq = i.w * lq + s * i.q;
        const d = Math.sqrt(cp * cp + cq * cq);
        if (d > 3 * wMax) {
          cp *= (3 * wMax) / d;
          cq *= (3 * wMax) / d;
        }
      } else {
        // Opposite lines or a wedge wider than a half turn: the plain edge point on the bisector of the two edges.
        const sp = lp + rp;
        const sq = lq + rq;
        const l = Math.sqrt(sp * sp + sq * sq);
        if (!(l > 1e-9)) throw new Error(`stripNet: two lines leave node ${ni} in one direction`);
        cp = (wMax * sp) / l;
        cq = (wMax * sq) / l;
      }
      const c: number[] = [0, 0, 0];
      onSurface(b, nd.p[0]! + cp * e1[0]! + cq * e2[0]!, nd.p[1]! + cp * e1[1]! + cq * e2[1]!, nd.p[2]! + cp * e1[2]! + cq * e2[2]!, c, 0);
      corners.push(c);
    }
    for (let k = 0; k < inc.length; k++) {
      const i = inc[k]!;
      const left = corners[k]!;
      const right = corners[(k + inc.length - 1) % inc.length]!;
      // Left and right as seen from the node into the line; a line that ends at the node looks the other way.
      endCorner[i.line]![i.end] = i.end === 0 ? { left, right } : { left: right, right: left };
    }
  }

  // Stations.
  let reachM = 0;
  const lines: StripNetLine[] = input.lines.map((ln, li) => {
    const p = pts[li]!;
    const g = grades[li]!;
    const w = widths[li]!;
    const n = p.length / 3;
    const pr = profiles[ln.profile]!;
    let hem = 1;
    for (let k = 0; k < pr.section.length; k += 2) hem = Math.max(hem, Math.abs(pr.section[k]!));
    const segLen: number[] = [];
    const along: number[] = [0];
    for (let k = 0; k + 1 < n; k++) {
      segLen.push(wayLength(b, p, k * 3, k * 3 + 3));
      along.push(along[k]! + segLen[k]!);
    }
    const st: number[] = [];
    const push = (c: readonly number[], l: readonly number[], r: readonly number[], grade: number, camber: number, al: number): void => {
      st.push(c[0]!, c[1]!, c[2]!, l[0]!, l[1]!, l[2]!, r[0]!, r[1]!, r[2]!, grade, camber, al);
    };
    /** Station square to the way from point a toward point c, at point `at` of `src`. */
    const square = (src: number[], at: number, dir: readonly number[], half: number, grade: number, al: number): void => {
      const u = upOf(b, src, at);
      // Right = tangent × up.
      const rx = dir[1]! * u[2] - dir[2]! * u[1];
      const ry = dir[2]! * u[0] - dir[0]! * u[2];
      const rz = dir[0]! * u[1] - dir[1]! * u[0];
      const L: number[] = [0, 0, 0];
      const Rr: number[] = [0, 0, 0];
      onSurface(b, src[at]! - rx * half, src[at + 1]! - ry * half, src[at + 2]! - rz * half, L, 0);
      onSurface(b, src[at]! + rx * half, src[at + 1]! + ry * half, src[at + 2]! + rz * half, Rr, 0);
      push([src[at]!, src[at + 1]!, src[at + 2]!], L, Rr, grade, 1, al);
    };
    /** A point of the way from point i toward point i + 1 at share t, with its grade and half-width. */
    const onWay = (i: number, t: number): { at: number[]; g: number; w: number } => {
      const at: number[] = [0, 0, 0];
      onSurface(b, p[i * 3]! + (p[i * 3 + 3]! - p[i * 3]!) * t, p[i * 3 + 1]! + (p[i * 3 + 4]! - p[i * 3 + 1]!) * t, p[i * 3 + 2]! + (p[i * 3 + 5]! - p[i * 3 + 2]!) * t, at, 0);
      return { at, g: g[i]! + (g[i + 1]! - g[i]!) * t, w: w[i]! + (w[i + 1]! - w[i]!) * t };
    };
    const startC = endCorner[li]![0];
    const endC = endCorner[li]![1];
    const nodeReach = (c: { left: number[]; right: number[] }, at: number): number =>
      Math.max(norm3(c.left[0]! - p[at]!, c.left[1]! - p[at + 1]!, c.left[2]! - p[at + 2]!), norm3(c.right[0]! - p[at]!, c.right[1]! - p[at + 1]!, c.right[2]! - p[at + 2]!));
    const tStart = startC ? nodeReach(startC, 0) / segLen[0]! : 0;
    const tEnd = endC ? nodeReach(endC, (n - 1) * 3) / segLen[n - 2]! : 0;
    if (tStart >= 1 || tEnd >= 1 || (n === 2 && tStart + tEnd >= 1)) throw new Error(`stripNet: line ${li}: a segment at a node is shorter than the node's corners reach`);

    // First station(s).
    if (startC) {
      push([p[0]!, p[1]!, p[2]!], startC.left, startC.right, g[0]!, 0, 0);
      const d = onWay(0, tStart);
      square(d.at, 0, towards(b, [...d.at, p[3]!, p[4]!, p[5]!], 0, 3), d.w, d.g, tStart * segLen[0]!);
    } else {
      square(p, 0, towards(b, p, 0, 3), w[0]!, g[0]!, 0);
    }
    // Inner points, mitred.
    for (let k = 1; k + 1 < n; k++) {
      const back = towards(b, p, k * 3, (k - 1) * 3);
      const fwd = towards(b, p, k * 3, (k + 1) * 3);
      const u = upOf(b, p, k * 3);
      // Rights of the arriving direction (−back) and the leaving one.
      const r0x = -(back[1] * u[2] - back[2] * u[1]);
      const r0y = -(back[2] * u[0] - back[0] * u[2]);
      const r0z = -(back[0] * u[1] - back[1] * u[0]);
      const r1x = fwd[1] * u[2] - fwd[2] * u[1];
      const r1y = fwd[2] * u[0] - fwd[0] * u[2];
      const r1z = fwd[0] * u[1] - fwd[1] * u[0];
      let mx = r0x + r1x;
      let my = r0y + r1y;
      let mz = r0z + r1z;
      const ml = norm3(mx, my, mz);
      if (!(ml > 1e-9)) throw new Error(`stripNet: line ${li} turns back at point ${k}`);
      mx /= ml;
      my /= ml;
      mz /= ml;
      const cos = mx * r0x + my * r0y + mz * r0z;
      const half = w[k]! / Math.max(cos, 0.5);
      const L: number[] = [0, 0, 0];
      const Rr: number[] = [0, 0, 0];
      onSurface(b, p[k * 3]! - mx * half, p[k * 3 + 1]! - my * half, p[k * 3 + 2]! - mz * half, L, 0);
      onSurface(b, p[k * 3]! + mx * half, p[k * 3 + 1]! + my * half, p[k * 3 + 2]! + mz * half, Rr, 0);
      push([p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!], L, Rr, g[k]!, 1, along[k]!);
    }
    // Last station(s).
    const last = (n - 1) * 3;
    if (endC) {
      const d = onWay(n - 2, 1 - tEnd);
      // Square to the segment, looking along the line.
      const ahead = towards(b, [...d.at, p[last]!, p[last + 1]!, p[last + 2]!], 0, 3);
      square(d.at, 0, ahead, d.w, d.g, along[n - 1]! - tEnd * segLen[n - 2]!);
      push([p[last]!, p[last + 1]!, p[last + 2]!], endC.left, endC.right, g[n - 1]!, 0, along[n - 1]!);
    } else {
      const back = towards(b, p, last, last - 3);
      square(p, last, [-back[0], -back[1], -back[2]], w[n - 1]!, g[n - 1]!, along[n - 1]!);
    }

    const stations = Float64Array.from(st);
    const count = stations.length / STRIP_STATION_FLOATS;
    const balls = new Float64Array((count - 1) * 4);
    const box = Float64Array.from([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let k = 0; k + 1 < count; k++) {
      const s0 = k * STRIP_STATION_FLOATS;
      const s1 = s0 + STRIP_STATION_FLOATS;
      const cx = (stations[s0]! + stations[s1]!) / 2;
      const cy = (stations[s0 + 1]! + stations[s1 + 1]!) / 2;
      const cz = (stations[s0 + 2]! + stations[s1 + 2]!) / 2;
      let r = 0;
      for (const s of [s0, s1]) {
        const toC = norm3(stations[s]! - cx, stations[s + 1]! - cy, stations[s + 2]! - cz);
        for (const e of [3, 6]) {
          const hw = norm3(stations[s + e]! - stations[s]!, stations[s + e + 1]! - stations[s + 1]!, stations[s + e + 2]! - stations[s + 2]!);
          reachM = Math.max(reachM, hem * hw + pr.shoulderM);
          r = Math.max(r, toC + hem * hw);
        }
      }
      // The shoulder, a millimetre for rounding.
      r += pr.shoulderM + 1e-3;
      balls[k * 4] = cx;
      balls[k * 4 + 1] = cy;
      balls[k * 4 + 2] = cz;
      balls[k * 4 + 3] = r;
      box[0] = Math.min(box[0]!, cx - r);
      box[1] = Math.min(box[1]!, cy - r);
      box[2] = Math.min(box[2]!, cz - r);
      box[3] = Math.max(box[3]!, cx + r);
      box[4] = Math.max(box[4]!, cy + r);
      box[5] = Math.max(box[5]!, cz + r);
    }
    return { profile: ln.profile, count, stations, startSquare: !startC, endSquare: !endC, box, balls };
  });
  return { radiusM: R, lineCount: lines.length, reachM, profiles, lines };
}

// --- The height function --------------------------------------------------------------------------------------------
//
// Every piece is two halves, (C0, E0, E1, C1) with E the right or the left edge. A point inside a half lies on exactly
// one section of it: a share t along and a share s across, found from a quadratic, and the target there is exact.
// Outside the strip a line's share falls with the distance to the nearest half, and its target is the targets at the
// nearest points of the halves within the shoulder weighed by inverse squared distance: it tends to the edge's own
// target at the edge, so the height is continuous everywhere, round bends and nodes as well.

const scratchQ = [0, 0, 0];
const roots = [0, 0];

function det3(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  return ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
}

/** Roots of A t² + B t + C = 0 into `roots`; returns how many. */
function solveQuadratic(A: number, B: number, C: number): number {
  const scale = Math.abs(A) + Math.abs(B) + Math.abs(C);
  if (scale === 0) return 0;
  if (Math.abs(A) <= 1e-12 * scale) {
    if (B === 0) return 0;
    roots[0] = -C / B;
    return 1;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) {
    if (disc < -1e-12 * B * B) return 0;
    roots[0] = -B / (2 * A);
    return 1;
  }
  const sq = Math.sqrt(disc);
  const q = -0.5 * (B + (B >= 0 ? sq : -sq));
  roots[0] = q / A;
  if (q === 0) return 1;
  roots[1] = C / q;
  return 2;
}

/** What one line makes of the query point. */
interface LineEval {
  /** Inside the strip: t, a of the section through the point. */
  inside: boolean;
  piece: number;
  t: number;
  a: number;
  hw: number;
  /** Outside: distance to the strip, and the target and weight sums of the halves within the shoulder. */
  dist: number;
  sumW: number;
  sumWT: number;
  /** The nearest point outside: piece, t, a, half-width, and how far it lies beyond a section (not an edge). */
  nPiece: number;
  nT: number;
  nA: number;
  nHw: number;
  nOnEdge: boolean;
}

const ev: LineEval = { inside: false, piece: 0, t: 0, a: 0, hw: 0, dist: Infinity, sumW: 0, sumWT: 0, nPiece: 0, nT: 0, nA: 0, nHw: 0, nOnEdge: false };

/** Point of the query in metres (on the base surface). */
const qm = [0, 0, 0];

function smoothstep01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Target height of the ground at share t of piece k, across a. */
function targetAt(line: StripNetLine, profile: StripProfile, k: number, t: number, a: number): number {
  const s0 = k * STRIP_STATION_FLOATS;
  const s1 = s0 + STRIP_STATION_FLOATS;
  const st = line.stations;
  const grade = st[s0 + 9]! + (st[s1 + 9]! - st[s0 + 9]!) * t;
  const camber = st[s0 + 10]! + (st[s1 + 10]! - st[s0 + 10]!) * t;
  return grade + camber * stripUp(profile, a < -1 ? -1 : a > 1 ? 1 : a) - profile.bedM;
}

/** The section through the query inside half (k, side): sets `ev` and returns true when it lies on one. */
function sectionThrough(net: StripNet, line: StripNetLine, k: number, side: number): boolean {
  const st = line.stations;
  const s0 = k * STRIP_STATION_FLOATS;
  const s1 = s0 + STRIP_STATION_FLOATS;
  const e = side > 0 ? 6 : 3;
  const sphere = net.radiusM > 0;
  const R = net.radiusM;
  const qx = scratchQ[0]!;
  const qy = scratchQ[1]!;
  const qz = scratchQ[2]!;
  // Lifted vectors: on the plane (x, 1, z) relative to q, on the sphere unit vectors; c and e relative to q.
  const lx = sphere ? qx : 0;
  const ly = sphere ? qy : 1;
  const lz = sphere ? qz : 0;
  const k0 = sphere ? 1 / R : 1;
  const c0x = st[s0]! * k0 - (sphere ? qx : qm[0]!);
  const c0y = sphere ? st[s0 + 1]! * k0 - qy : 0;
  const c0z = st[s0 + 2]! * k0 - (sphere ? qz : qm[2]!);
  const e0x = st[s0 + e]! * k0 - (sphere ? qx : qm[0]!);
  const e0y = sphere ? st[s0 + e + 1]! * k0 - qy : 0;
  const e0z = st[s0 + e + 2]! * k0 - (sphere ? qz : qm[2]!);
  const dcx = (st[s1]! - st[s0]!) * k0;
  const dcy = sphere ? (st[s1 + 1]! - st[s0 + 1]!) * k0 : 0;
  const dcz = (st[s1 + 2]! - st[s0 + 2]!) * k0;
  const dex = (st[s1 + e]! - st[s0 + e]!) * k0;
  const dey = sphere ? (st[s1 + e + 1]! - st[s0 + e + 1]!) * k0 : 0;
  const dez = (st[s1 + e + 2]! - st[s0 + e + 2]!) * k0;
  // q lies on the section at share t when q, C(t) and E(t) lie in one plane through the centre (the plane: on one
  // line): det(q, C(t) − q, E(t) − q) = 0, a quadratic in t.
  const C = det3(lx, ly, lz, c0x, c0y, c0z, e0x, e0y, e0z);
  const B = det3(lx, ly, lz, dcx, dcy, dcz, e0x, e0y, e0z) + det3(lx, ly, lz, c0x, c0y, c0z, dex, dey, dez);
  const A = det3(lx, ly, lz, dcx, dcy, dcz, dex, dey, dez);
  const nr = solveQuadratic(A, B, C);
  for (let r = 0; r < nr; r++) {
    let t = roots[r]!;
    if (!(t >= -1e-9 && t <= 1 + 1e-9)) continue;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let cx = c0x + dcx * t;
    let cy = c0y + dcy * t;
    let cz = c0z + dcz * t;
    let ex = e0x + dex * t;
    let ey = e0y + dey * t;
    let ez = e0z + dez * t;
    let s: number;
    let hw: number;
    if (sphere) {
      // Back to unit vectors on the sphere; q = λ (C + s D) with D = E − C.
      cx += qx;
      cy += qy;
      cz += qz;
      ex += qx;
      ey += qy;
      ez += qz;
      const cl = norm3(cx, cy, cz);
      const el = norm3(ex, ey, ez);
      cx /= cl;
      cy /= cl;
      cz /= cl;
      ex /= el;
      ey /= el;
      ez /= el;
      const dx = ex - cx;
      const dy = ey - cy;
      const dz = ez - cz;
      const ax = cy * qz - cz * qy;
      const ay = cz * qx - cx * qz;
      const az = cx * qy - cy * qx;
      const bx = dy * qz - dz * qy;
      const by = dz * qx - dx * qz;
      const bz = dx * qy - dy * qx;
      const bb = bx * bx + by * by + bz * bz;
      if (!(bb > 0)) continue;
      s = -(ax * bx + ay * by + az * bz) / bb;
      hw = norm3(dx, dy, dz) * R;
    } else {
      const dx = ex - cx;
      const dz = ez - cz;
      const dd = dx * dx + dz * dz;
      if (!(dd > 0)) continue;
      s = (-cx * dx - cz * dz) / dd;
      hw = Math.sqrt(dd);
    }
    if (s < -1e-9 || s > 1 + 1e-9) continue;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    ev.inside = true;
    ev.piece = k;
    ev.t = t;
    ev.a = side * s;
    ev.hw = hw;
    ev.dist = 0;
    return true;
  }
  return false;
}

/** Nearest point to the query on segment (a, b) of points in metres: its share and the squared distance. */
function nearestOnSegment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: number[]): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dd = dx * dx + dy * dy + dz * dz;
  let u = dd > 0 ? ((qm[0]! - ax) * dx + (qm[1]! - ay) * dy + (qm[2]! - az) * dz) / dd : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const x = ax + dx * u - qm[0]!;
  const y = ay + dy * u - qm[1]!;
  const z = az + dz * u - qm[2]!;
  out[0] = u;
  out[1] = x * x + y * y + z * z;
}

const seg = [0, 0];

/**
 * Half (k, side) for a query outside it: the nearest point of its outline (the two sections, the centre and the
 * edge), added to the line's weighted target when within the shoulder. Returns false when the query lies inside.
 */
function halfOutside(line: StripNetLine, profile: StripProfile, k: number, side: number): boolean {
  const st = line.stations;
  const s0 = k * STRIP_STATION_FLOATS;
  const s1 = s0 + STRIP_STATION_FLOATS;
  const e = side > 0 ? 6 : 3;
  // Corners in order C0, E0, E1, C1; their (t, s) on the half.
  const P = [s0, s0 + e, s1 + e, s1];
  const T = [0, 0, 1, 1];
  const S = [0, 1, 1, 0];
  // Inside: on the same side of all four sides, seen along local up.
  const ux = net0.radiusM > 0 ? scratchQ[0]! : 0;
  const uy = net0.radiusM > 0 ? scratchQ[1]! : 1;
  const uz = net0.radiusM > 0 ? scratchQ[2]! : 0;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < 4; i++) {
    const a = P[i]!;
    const b = P[(i + 1) % 4]!;
    const ex = st[b]! - st[a]!;
    const ey = st[b + 1]! - st[a + 1]!;
    const ez = st[b + 2]! - st[a + 2]!;
    const vx = qm[0]! - st[a]!;
    const vy = qm[1]! - st[a + 1]!;
    const vz = qm[2]! - st[a + 2]!;
    const o = (ey * vz - ez * vy) * ux + (ez * vx - ex * vz) * uy + (ex * vy - ey * vx) * uz;
    if (o > 0) pos++;
    else if (o < 0) neg++;
  }
  if (pos === 0 || neg === 0) return false;
  let best = Infinity;
  let bt = 0;
  let bs = 0;
  let edge = false;
  for (let i = 0; i < 4; i++) {
    const a = P[i]!;
    const b = P[(i + 1) % 4]!;
    nearestOnSegment(st[a]!, st[a + 1]!, st[a + 2]!, st[b]!, st[b + 1]!, st[b + 2]!, seg);
    if (seg[1]! < best) {
      best = seg[1]!;
      const u = seg[0]!;
      bt = T[i]! + (T[(i + 1) % 4]! - T[i]!) * u;
      bs = S[i]! + (S[(i + 1) % 4]! - S[i]!) * u;
      edge = i === 1;
    }
  }
  const d = Math.sqrt(best);
  if (d < ev.dist) {
    ev.dist = d;
    ev.nPiece = k;
    ev.nT = bt;
    ev.nA = side * bs;
    ev.nOnEdge = edge;
    const hx = st[s0 + e]! + (st[s1 + e]! - st[s0 + e]!) * bt - (st[s0]! + (st[s1]! - st[s0]!) * bt);
    const hy = st[s0 + e + 1]! + (st[s1 + e + 1]! - st[s0 + e + 1]!) * bt - (st[s0 + 1]! + (st[s1 + 1]! - st[s0 + 1]!) * bt);
    const hz = st[s0 + e + 2]! + (st[s1 + e + 2]! - st[s0 + e + 2]!) * bt - (st[s0 + 2]! + (st[s1 + 2]! - st[s0 + 2]!) * bt);
    ev.nHw = norm3(hx, hy, hz);
  }
  const shoulder = profile.shoulderM;
  if (shoulder > 0 && d < shoulder) {
    const fall = 1 - smoothstep01(d / shoulder);
    // Inverse squared distance, a millimetre at least: the nearest half dominates near the edge.
    const w = fall / Math.max(d * d, 1e-12);
    ev.sumW += w;
    ev.sumWT += w * targetAt(line, profile, k, bt, side * bs);
  }
  return true;
}

/** The net being evaluated (for the up of the inside test). */
let net0: StripNet;

/** Puts the query point into `scratchQ` (unit vector on the sphere, the point on the plane) and `qm` (metres). */
function setQuery(net: StripNet, x: number, y: number, z: number): boolean {
  net0 = net;
  if (net.radiusM > 0) {
    const l = norm3(x, y, z);
    if (!(l > 0)) return false;
    scratchQ[0] = x / l;
    scratchQ[1] = y / l;
    scratchQ[2] = z / l;
    qm[0] = scratchQ[0]! * net.radiusM;
    qm[1] = scratchQ[1]! * net.radiusM;
    qm[2] = scratchQ[2]! * net.radiusM;
  } else {
    scratchQ[0] = x;
    scratchQ[1] = 0;
    scratchQ[2] = z;
    qm[0] = x;
    qm[1] = 0;
    qm[2] = z;
  }
  return Number.isFinite(qm[0]!) && Number.isFinite(qm[1]!) && Number.isFinite(qm[2]!);
}

/** Evaluates one line at the query into `ev`; false when nothing of it is near enough to matter. */
function evalLine(net: StripNet, li: number): boolean {
  const line = net.lines[li]!;
  const profile = net.profiles[line.profile]!;
  const bx = line.box;
  const px = qm[0]!;
  const py = qm[1]!;
  const pz = qm[2]!;
  if (px < bx[0]! || py < bx[1]! || pz < bx[2]! || px > bx[3]! || py > bx[4]! || pz > bx[5]!) return false;
  ev.inside = false;
  ev.dist = Infinity;
  ev.sumW = 0;
  ev.sumWT = 0;
  let any = false;
  const bl = line.balls;
  for (let k = 0; k + 1 < line.count; k++) {
    const dx = px - bl[k * 4]!;
    const dy = py - bl[k * 4 + 1]!;
    const dz = pz - bl[k * 4 + 2]!;
    const r = bl[k * 4 + 3]!;
    if (dx * dx + dy * dy + dz * dz > r * r) continue;
    any = true;
    for (const side of [1, -1]) {
      if (!halfOutside(line, profile, k, side) && sectionThrough(net, line, k, side)) return true;
    }
  }
  return any && ev.dist < Infinity;
}

/** Share of the line evaluated last: 1 on the strip, a smoothstep to 0 at `shoulderM` past its edge. */
function shareOf(profile: StripProfile): number {
  if (ev.inside) return 1;
  if (!(profile.shoulderM > 0) || ev.dist >= profile.shoulderM) return 0;
  return 1 - smoothstep01(ev.dist / profile.shoulderM);
}

/** Target of the line evaluated last (its share must be above 0). */
function targetOf(line: StripNetLine, profile: StripProfile): number {
  if (ev.inside) return targetAt(line, profile, ev.piece, ev.t, ev.a);
  return ev.sumWT / ev.sumW;
}

/**
 * The line whose strip or shoulder holds a point of the base surface most (the largest share; ties: the lower
 * index), with where the point lies on it; null when no share is above 0. Outside the strip the numbers are those of
 * the nearest point of the strip, `acrossM` and `alongM` carried on by the distance to it.
 */
export function stripNearest(net: StripNet, x: number, y: number, z: number, out?: StripHit): StripHit | null {
  if (!setQuery(net, x, y, z)) return null;
  let bestK = 0;
  let hit: StripHit | null = null;
  for (let li = 0; li < net.lineCount; li++) {
    if (!evalLine(net, li)) continue;
    const line = net.lines[li]!;
    const profile = net.profiles[line.profile]!;
    const k = shareOf(profile);
    if (!(k > bestK)) continue;
    bestK = k;
    hit = out ?? { line: 0, alongM: 0, acrossM: 0, halfWidthM: 0, gradeM: 0, share: 0 };
    const piece = ev.inside ? ev.piece : ev.nPiece;
    const t = ev.inside ? ev.t : ev.nT;
    const a = ev.inside ? ev.a : ev.nA;
    const hw = ev.inside ? ev.hw : ev.nHw;
    const s0 = piece * STRIP_STATION_FLOATS;
    const st = line.stations;
    hit.line = li;
    hit.alongM = st[s0 + 11]! + (st[s0 + STRIP_STATION_FLOATS + 11]! - st[s0 + 11]!) * t;
    hit.acrossM = a * hw;
    if (!ev.inside) {
      if (ev.nOnEdge) hit.acrossM += a < 0 ? -ev.dist : ev.dist;
      else if (t === 0 && piece === 0) hit.alongM -= ev.dist;
      else if (t === 1 && piece === line.count - 2) hit.alongM += ev.dist;
    }
    hit.halfWidthM = hw;
    hit.gradeM = st[s0 + 9]! + (st[s0 + STRIP_STATION_FLOATS + 9]! - st[s0 + 9]!) * t;
    hit.share = k;
  }
  return hit;
}

/**
 * Height of the ground at a point of the base surface with the strips cut and filled in: the section less its bed on
 * the strip, blended back to `ownHeightM` over the shoulder. Where lines meet, the shares weigh their targets, so the
 * result is continuous everywhere. Exactly `ownHeightM` where no line has a share.
 */
export function stripCarve(net: StripNet, x: number, y: number, z: number, ownHeightM: number): number {
  if (!setQuery(net, x, y, z)) return ownHeightM;
  let sumK = 0;
  let sumKT = 0;
  let maxK = 0;
  for (let li = 0; li < net.lineCount; li++) {
    if (!evalLine(net, li)) continue;
    const line = net.lines[li]!;
    const profile = net.profiles[line.profile]!;
    const k = shareOf(profile);
    if (!(k > 0)) continue;
    sumK += k;
    sumKT += k * targetOf(line, profile);
    if (k > maxK) maxK = k;
  }
  if (maxK === 0) return ownHeightM;
  return ownHeightM + (sumKT / sumK - ownHeightM) * maxK;
}

/**
 * False only when no line can change the ground or put a vertex within `radiusM` of a point of the base surface: a
 * test against bounding balls, for skipping a cell before any height is asked for.
 */
export function stripTouches(net: StripNet, x: number, y: number, z: number, radiusM: number): boolean {
  if (!setQuery(net, x, y, z)) return true;
  const px = qm[0]!;
  const py = qm[1]!;
  const pz = qm[2]!;
  for (const line of net.lines) {
    const bx = line.box;
    if (px < bx[0]! - radiusM || py < bx[1]! - radiusM || pz < bx[2]! - radiusM || px > bx[3]! + radiusM || py > bx[4]! + radiusM || pz > bx[5]! + radiusM) continue;
    for (let k = 0; k + 1 < line.count; k++) {
      const bl = line.balls;
      const dx = px - bl[k * 4]!;
      const dy = py - bl[k * 4 + 1]!;
      const dz = pz - bl[k * 4 + 2]!;
      const r = bl[k * 4 + 3]! + radiusM;
      if (dx * dx + dy * dy + dz * dz <= r * r) return true;
    }
  }
  return false;
}
