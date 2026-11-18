// Shape generators of the kit. They write into a MeshBuilder (in its current transform and flags) and never make a
// box with sharp edges: every shape has chamfered edges, a little irregularity from a stream, and colours painted
// per vertex. Generators of the content modules (arch, buildings, props, …) are built from these.
//
//   bevelBox      a box with chamfered edges and corners, optional taper, lean and corner jitter
//   crookedBeam   a timber between two points with an irregular chamfered section, sag, wobble and twist
//   lathe         a body of revolution from a profile (barrels, posts, chimney pots, trunks), optional radial noise
//   sweep         a profile pulled along a curve (ridges, ropes, arches, branches, curbs)
//   rock          an irregular faceted stone: a rounded block cut by random planes, flat shaded
//   tube          a closed round tube along a curve with varying radius (branches, roots)
//
// Every function takes a colour as an RGB or as a paint function `(p, n) => RGB` evaluated per vertex (in the
// builder's local coordinates, before its transform), so gradients by height or by direction come for free.

import type { Vec3 } from './math.ts';
import { add3, clamp, cross3, dot3, lerp, len3, norm3, scale3, sub3 } from './math.ts';
import type { MeshBuilder } from './mesh.ts';
import { faceNormal } from './mesh.ts';
import type { RGB } from './color.ts';
import { scaleRgb } from './color.ts';
import type { Stream } from './rng.ts';

/** A colour, or a function giving one per vertex from its local position and normal. */
export type Paint = RGB | ((p: Vec3, n: Vec3) => RGB);

export const paintAt = (paint: Paint, p: Vec3, n: Vec3): RGB => (typeof paint === 'function' ? paint(p, n) : paint);

/** Writes a flat convex polygon whose winding is fixed so that its normal points away from `inside`. */
function convexFace(b: MeshBuilder, pts: Vec3[], inside: Vec3, paint: Paint, light = 1): void {
  let n = faceNormal(pts);
  const c = pts.reduce((a, p) => add3(a, p), [0, 0, 0] as Vec3).map((v) => v / pts.length) as Vec3;
  if (dot3(n, sub3(c, inside)) < 0) {
    pts = [...pts].reverse();
    n = [-n[0], -n[1], -n[2]];
  }
  const first = b.vertexCount;
  for (const p of pts) b.vertex(p, n, light === 1 ? paintAt(paint, p, n) : scaleRgb(paintAt(paint, p, n), light));
  for (let k = 1; k < pts.length - 1; k++) b.tri(first, first + k, first + k + 1);
}

export interface BevelBoxOptions {
  /** Chamfer width in metres (clamped to a third of the smallest half size). Default 0.06. */
  bevel?: number;
  /** Where the box sits: 'base' puts y = 0 at its bottom (default), 'center' at its middle. */
  anchor?: 'base' | 'center';
  /** Scale of the top face against the bottom (x, z); 1 keeps it straight. */
  taper?: number | readonly [number, number];
  /** Shift of the top face against the bottom (x, z) in metres: a leaning block. */
  lean?: readonly [number, number];
  /** Random displacement of every corner in metres (needs `stream`). Keep it below the bevel for clean faces. */
  jitter?: number;
  stream?: Stream;
  /** Brightness of the chamfer faces against the main faces (painted edge highlight). Default 1.12. */
  edgeLight?: number;
  /** Leave out the bottom face (blocks that stand on something). */
  noBottom?: boolean;
}

/**
 * A box of `size` (x, y, z) at `at` with chamfered edges and corners: 6 main faces, 12 edge strips, 8 corner
 * triangles, flat shaded. The shape of every timber end, stone block and plank of the village.
 */
export function bevelBox(b: MeshBuilder, at: readonly number[], size: readonly number[], paint: Paint, o: BevelBoxOptions = {}): void {
  const hx = size[0]! / 2, hy = size[1]! / 2, hz = size[2]! / 2;
  const bev = clamp(o.bevel ?? 0.06, 0.001, Math.min(hx, hy, hz) / 1.5);
  const taper = typeof o.taper === 'number' ? [o.taper, o.taper] : (o.taper ?? [1, 1]);
  const lean = o.lean ?? [0, 0];
  const yBase = o.anchor === 'center' ? -hy : 0;
  const h = [hx, hy, hz];
  const jit = new Map<number, Vec3>();
  const cornerJitter = (sx: number, sy: number, sz: number): Vec3 => {
    const key = (sx + 1) * 9 + (sy + 1) * 3 + (sz + 1);
    let j = jit.get(key);
    if (!j) {
      j = o.jitter && o.stream ? [o.stream.nextJitter(o.jitter), o.stream.nextJitter(o.jitter), o.stream.nextJitter(o.jitter)] : [0, 0, 0];
      jit.set(key, j);
    }
    return j;
  };
  // Point of corner (sx, sy, sz) on the face of `axis`: full extent on the axis, inset by the chamfer on the others.
  const P = (sx: number, sy: number, sz: number, axis: number): Vec3 => {
    const s = [sx, sy, sz];
    const q = [0, 0, 0];
    for (let k = 0; k < 3; k++) q[k] = s[k]! * (k === axis ? h[k]! : h[k]! - bev);
    // Local y from 0 (bottom) to 1 (top): taper and lean grow with it.
    const t = (q[1]! + hy) / (2 * hy);
    const tx = lerp(1, taper[0]!, t), tz = lerp(1, taper[1]!, t);
    const j = cornerJitter(sx, sy, sz);
    return [at[0]! + q[0]! * tx + lean[0]! * t + j[0], at[1]! + yBase + hy + q[1]! + j[1], at[2]! + q[2]! * tz + lean[1]! * t + j[2]];
  };
  const center: Vec3 = [at[0]! + lean[0]! * 0.5, at[1]! + yBase + hy, at[2]! + lean[1]! * 0.5];
  const edge = o.edgeLight ?? 1.12;
  // Main faces.
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [-1, 1]) {
      if (o.noBottom && axis === 1 && s === -1) continue;
      const a = (axis + 1) % 3, c = (axis + 2) % 3;
      const pts: Vec3[] = [];
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const sv = [0, 0, 0];
        sv[axis] = s;
        sv[a] = u;
        sv[c] = v;
        pts.push(P(sv[0]!, sv[1]!, sv[2]!, axis));
      }
      convexFace(b, pts, center, paint);
    }
  }
  // Edge strips: between the faces of two axes, along the third.
  for (let a = 0; a < 3; a++) {
    for (let c = a + 1; c < 3; c++) {
      const along = 3 - a - c;
      for (const sa of [-1, 1]) {
        for (const sc of [-1, 1]) {
          if (o.noBottom && ((a === 1 && sa === -1) || (c === 1 && sc === -1))) continue;
          const pts: Vec3[] = [];
          for (const [s, axis] of [[-1, a], [1, a], [1, c], [-1, c]] as const) {
            const sv = [0, 0, 0];
            sv[a] = sa;
            sv[c] = sc;
            sv[along] = s;
            pts.push(P(sv[0]!, sv[1]!, sv[2]!, axis));
          }
          convexFace(b, pts, center, paint, edge);
        }
      }
    }
  }
  // Corner triangles.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      if (o.noBottom && sy === -1) continue;
      for (const sz of [-1, 1]) convexFace(b, [P(sx, sy, sz, 0), P(sx, sy, sz, 1), P(sx, sy, sz, 2)], center, paint, edge);
    }
  }
}

/** A frame (u, v) across a direction t; v leans toward `up` when possible. */
export function frameAcross(t: readonly number[], up: readonly number[] = [0, 1, 0]): { u: Vec3; v: Vec3 } {
  let ref = up;
  if (Math.abs(dot3(norm3(t), norm3(up))) > 0.97) ref = Math.abs(t[0]!) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm3(cross3(ref, t));
  const v = norm3(cross3(t, u));
  return { u, v };
}

export interface BeamOptions {
  /** Width across (along u, horizontal for a horizontal beam) and depth (along v). Defaults 0.4 and the width. */
  width?: number;
  depth?: number;
  /** Chamfer of the section corners as a share of the smaller half size. Default 0.28. */
  chamfer?: number;
  /** Rings along the beam. Default from the length, at least 3. */
  segments?: number;
  /** Sag in the middle (metres, along −v: a horizontal beam sags down). */
  sag?: number;
  /** Lateral wobble of the inner rings (metres). */
  wobble?: number;
  /** Irregularity of the section: each corner of each ring moves by up to this share. Default 0.1. */
  irregular?: number;
  /** Twist from end to end (radians). */
  twist?: number;
  /** Reference up for orienting the section. */
  up?: readonly number[];
  /** Darker, end-grain colour of the cut ends (default the paint darkened). */
  endPaint?: Paint;
  /** Extra length beyond each end (overhanging timber ends). */
  overhang?: number;
  stream?: Stream;
}

/**
 * A hewn timber from `a` to `b`: an octagonal (chamfered rectangle) section that varies ring by ring, a sag, a
 * wobble and a twist, sides shaded flat across and smooth along. The thick irregular beams of the concept.
 */
export function crookedBeam(b: MeshBuilder, a: readonly number[], bEnd: readonly number[], paint: Paint, o: BeamOptions = {}): void {
  const s = o.stream;
  const dir0 = sub3(bEnd, a);
  const L0 = len3(dir0);
  if (L0 < 1e-4) return;
  const t = scale3(dir0, 1 / L0);
  const over = o.overhang ?? 0;
  const A = sub3(a, scale3(t, over));
  const L = L0 + 2 * over;
  const { u, v } = frameAcross(t, o.up ?? [0, 1, 0]);
  const hw = (o.width ?? 0.4) / 2;
  const hd = (o.depth ?? o.width ?? 0.4) / 2;
  const ch = (o.chamfer ?? 0.28) * Math.min(hw, hd);
  const irr = o.irregular ?? 0.1;
  const segs = Math.max(3, o.segments ?? Math.ceil(L / 0.9) + 1);
  const section: [number, number][] = [
    [hw, hd - ch], [hw - ch, hd], [-hw + ch, hd], [-hw, hd - ch],
    [-hw, -hd + ch], [-hw + ch, -hd], [hw - ch, -hd], [hw, -hd + ch],
  ];
  // Ring points.
  const rings: Vec3[][] = [];
  for (let j = 0; j <= segs; j++) {
    const f = j / segs;
    const mid = Math.sin(Math.PI * f);
    const c0 = add3(A, scale3(t, L * f));
    const sag = (o.sag ?? 0) * mid;
    const wob = o.wobble && s ? [s.nextJitter(o.wobble) * mid, s.nextJitter(o.wobble) * mid] : [0, 0];
    const center = add3(add3(c0, scale3(v, -sag + wob[1]!)), scale3(u, wob[0]!));
    const rot = (o.twist ?? 0) * f;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const ring: Vec3[] = [];
    for (const [x, y] of section) {
      const k = s && irr > 0 ? 1 + s.nextJitter(irr) : 1;
      const xx = x * k, yy = y * k;
      const rx = cr * xx - sr * yy, ry = sr * xx + cr * yy;
      ring.push(add3(add3(center, scale3(u, rx)), scale3(v, ry)));
    }
    rings.push(ring);
  }
  // Sides: one strip per section edge; normals across from the edge, along from the ring tangent.
  const n8 = section.length;
  for (let k = 0; k < n8; k++) {
    const k1 = (k + 1) % n8;
    const first = b.vertexCount;
    for (let j = 0; j <= segs; j++) {
      const r = rings[j]!;
      const prev = rings[Math.max(0, j - 1)]!, next = rings[Math.min(segs, j + 1)]!;
      const along = sub3(add3(next[k]!, next[k1]!), add3(prev[k]!, prev[k1]!));
      const across = sub3(r[k1]!, r[k]!);
      let n = norm3(cross3(across, along));
      // Outward: away from the ring centre.
      const rc = r.reduce((acc, p) => add3(acc, p), [0, 0, 0] as Vec3).map((x) => x / n8) as Vec3;
      const mid = scale3(add3(r[k]!, r[k1]!), 0.5);
      if (dot3(n, sub3(mid, rc)) < 0) n = [-n[0], -n[1], -n[2]];
      b.vertex(r[k]!, n, paintAt(paint, r[k]!, n));
      b.vertex(r[k1]!, n, paintAt(paint, r[k1]!, n));
    }
    for (let j = 0; j < segs; j++) {
      const p0 = first + j * 2, p1 = p0 + 1, q0 = p0 + 2, q1 = p0 + 3;
      // Orientation check against the outward normal of this quad.
      const P0 = rings[j]![k]!, P1 = rings[j]![k1]!, Q1 = rings[j + 1]![k1]!;
      const nn = cross3(sub3(P1, P0), sub3(Q1, P0));
      const rc = rings[j]!.reduce((acc, p) => add3(acc, p), [0, 0, 0] as Vec3).map((x) => x / n8) as Vec3;
      if (dot3(nn, sub3(P0, rc)) >= 0) b.quad(p0, p1, q1, q0);
      else b.quad(p0, q0, q1, p1);
    }
  }
  // End caps (end grain, a little darker).
  const endPaint = o.endPaint ?? ((p: Vec3, n: Vec3): RGB => scaleRgb(paintAt(paint, p, n), 0.82));
  const ends: [Vec3[], Vec3][] = [
    [rings[0]!, add3(rings[0]![0]!, scale3(t, 1))],
    [rings[segs]!, sub3(rings[segs]![0]!, scale3(t, 1))],
  ];
  for (const [ring] of ends) {
    const rc = ring.reduce((acc, p) => add3(acc, p), [0, 0, 0] as Vec3).map((x) => x / n8) as Vec3;
    const inside = ring === rings[0] ? add3(rc, scale3(t, 0.1)) : sub3(rc, scale3(t, 0.1));
    convexFace(b, [...ring], inside, endPaint);
  }
}

export interface LatheOptions {
  /** Segments around. Default 12. */
  segments?: number;
  /** Close the bottom / top with a flat cap. */
  capBottom?: boolean;
  capTop?: boolean;
  /** Radial noise: radius × (1 ± noise), varying around and along (needs `stream`). */
  noise?: number;
  /** Start angle (radians), so repeated bodies do not line up their seams. */
  phase?: number;
  /** Flat shading around (faceted, carved look) instead of smooth. */
  faceted?: boolean;
  stream?: Stream;
}

/**
 * A body of revolution about local +y from a profile of [radius, y] pairs, bottom to top. Smooth shaded (or faceted
 * with `faceted`). Barrels, posts, chimney pots, lantern bodies, wheels' hubs, trunks.
 */
export function lathe(b: MeshBuilder, at: readonly number[], profile: readonly (readonly [number, number])[], paint: Paint, o: LatheOptions = {}): void {
  const segs = o.segments ?? 12;
  const phase = o.phase ?? 0;
  const s = o.stream;
  const noise: number[] = [];
  for (let j = 0; j < profile.length; j++) for (let i = 0; i < segs; i++) noise.push(o.noise && s ? 1 + s.nextJitter(o.noise) : 1);
  const point = (i: number, j: number): Vec3 => {
    const a = phase + (((i % segs) + segs) % segs) * ((Math.PI * 2) / segs);
    const [r, y] = profile[j]!;
    const k = noise[j * segs + (((i % segs) + segs) % segs)]!;
    // x = r cos a, z = −r sin a: with i growing around and j growing up, d/di × d/dj points outward.
    return [at[0]! + r * k * Math.cos(a), at[1]! + y, at[2]! - r * k * Math.sin(a)];
  };
  if (o.faceted) {
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < profile.length - 1; j++) {
        const p0 = point(i, j), p1 = point(i + 1, j), p2 = point(i + 1, j + 1), p3 = point(i, j + 1);
        const axis: Vec3 = [at[0]!, (p0[1] + p2[1]) / 2, at[2]!];
        convexFace(b, [p0, p1, p2, p3], axis, paint);
      }
    }
  } else {
    b.grid(segs, profile.length, point, (_i, _j, p) => {
      const n = norm3([p[0]! - at[0]!, 0, p[2]! - at[2]!]);
      return paintAt(paint, p as Vec3, n);
    }, { wrapI: true });
  }
  const cap = (j: number, up: boolean): void => {
    const [r, y] = profile[j]!;
    if (r <= 1e-4) return;
    const c: Vec3 = [at[0]!, at[1]! + y, at[2]!];
    const n: Vec3 = up ? [0, 1, 0] : [0, -1, 0];
    const center = b.vertex(c, n, paintAt(paint, c, n));
    const ring: number[] = [];
    for (let i = 0; i < segs; i++) {
      const p = point(i, j);
      ring.push(b.vertex(p, n, paintAt(paint, p, n)));
    }
    for (let i = 0; i < segs; i++) {
      const a = ring[i]!, d = ring[(i + 1) % segs]!;
      // Points go around clockwise seen from above (x = cos, z = −sin), so the top fan is (center, a, d).
      if (up) b.tri(center, a, d);
      else b.tri(center, d, a);
    }
  };
  if (o.capBottom) cap(0, false);
  if (o.capTop) cap(profile.length - 1, true);
}

/** Parallel-transport frames along a polyline: tangent, u and v per point. */
export function curveFrames(path: readonly (readonly number[])[], up: readonly number[] = [0, 1, 0]): { t: Vec3; u: Vec3; v: Vec3 }[] {
  const out: { t: Vec3; u: Vec3; v: Vec3 }[] = [];
  let prevU: Vec3 | null = null;
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)]!, c = path[Math.min(path.length - 1, i + 1)]!;
    const t = norm3(sub3(c, a));
    let u: Vec3;
    if (!prevU) u = frameAcross(t, up).u;
    else {
      // Remove the tangent part of the previous u: smallest rotation, no flips.
      u = norm3(sub3(prevU, scale3(t, dot3(prevU, t))));
      if (len3(u) < 1e-6) u = frameAcross(t, up).u;
    }
    const v = norm3(cross3(t, u));
    out.push({ t, u, v });
    prevU = u;
  }
  return out;
}

export interface SweepOptions {
  /** Scale of the profile at a share 0–1 of the length (taper). */
  scale?: (f: number) => number;
  /** Twist at a share of the length, radians. */
  twist?: (f: number) => number;
  /** The profile is a closed loop (default true). */
  closed?: boolean;
  /** Cap the ends (closed profiles only). */
  caps?: boolean;
  /** Up hint for the first frame. */
  up?: readonly number[];
  /** Flat shading across the profile (each profile edge its own strip). Default false (smooth). */
  faceted?: boolean;
}

/**
 * Pulls a 2D profile ([x, y] in the frame u, v across the path; counter-clockwise for an outward-facing closed
 * profile) along a path of 3D points. Ridges, ropes, arches, rails, curbs, branches.
 */
export function sweep(b: MeshBuilder, path: readonly (readonly number[])[], profile: readonly (readonly [number, number])[], paint: Paint, o: SweepOptions = {}): void {
  if (path.length < 2 || profile.length < 2) return;
  const frames = curveFrames(path, o.up);
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1]! + len3(sub3(path[i]!, path[i - 1]!)));
  const total = lengths[lengths.length - 1]! || 1;
  const closed = o.closed ?? true;
  const np = profile.length;
  const ring = (i: number): Vec3[] => {
    const f = lengths[i]! / total;
    const sc = o.scale ? o.scale(f) : 1;
    const tw = o.twist ? o.twist(f) : 0;
    const { u, v } = frames[i]!;
    const c = Math.cos(tw), s = Math.sin(tw);
    return profile.map(([x, y]) => {
      const rx = (c * x - s * y) * sc, ry = (s * x + c * y) * sc;
      return add3(add3(path[i] as Vec3, scale3(u, rx)), scale3(v, ry));
    });
  };
  const rings = path.map((_, i) => ring(i));
  const centerOf = (i: number): Vec3 => path[i] as Vec3;
  if (o.faceted) {
    const edges = closed ? np : np - 1;
    for (let k = 0; k < edges; k++) {
      const k1 = (k + 1) % np;
      for (let i = 0; i < path.length - 1; i++) {
        const pts = [rings[i]![k]!, rings[i]![k1]!, rings[i + 1]![k1]!, rings[i + 1]![k]!];
        const inside = scale3(add3(centerOf(i), centerOf(i + 1)), 0.5);
        if (closed) convexFace(b, pts, inside, paint);
        else b.face(pts, pts.map((p) => paintAt(paint, p, faceNormal(pts))));
      }
    }
  } else {
    // Grid: i around the profile, j along the path. Orientation decided from the first quad against the centre.
    const P0 = rings[0]![0]!, P1 = rings[0]![1]!, Q0 = rings[1]![0]!;
    const out = sub3(scale3(add3(P0, P1), 0.5), centerOf(0));
    const flip = closed && dot3(cross3(sub3(P1, P0), sub3(Q0, P0)), out) < 0;
    b.grid(np, path.length, (i, j) => rings[j]![i]!, (_i, _j, p) => {
      const n = norm3(sub3(p, centerOf(_j)));
      return paintAt(paint, p as Vec3, n);
    }, { wrapI: closed, flip });
  }
  if (closed && o.caps) {
    convexFace(b, rings[0]!, add3(centerOf(0), frames[0]!.t), paint);
    convexFace(b, rings[path.length - 1]!, sub3(centerOf(path.length - 1), frames[path.length - 1]!.t), paint);
  }
}

/**
 * A round tube along a path with a radius per point (branches, roots, ropes, hoops). `sides` around (default 7).
 * Ends are capped when `caps` is set.
 */
export function tube(b: MeshBuilder, path: readonly (readonly number[])[], radius: (f: number) => number, paint: Paint, o: { sides?: number; caps?: boolean; up?: readonly number[]; phase?: number } = {}): void {
  const sides = o.sides ?? 7;
  const phase = o.phase ?? 0;
  const profile: [number, number][] = [];
  for (let k = 0; k < sides; k++) {
    const a = phase + (k / sides) * Math.PI * 2;
    profile.push([Math.cos(a), Math.sin(a)]);
  }
  sweep(b, path, profile, paint, { scale: radius, closed: true, caps: o.caps ?? false, ...(o.up ? { up: o.up } : {}) });
}

export interface RockOptions {
  /** Subdivisions of each cube face (default 3). */
  detail?: number;
  /** Number of flat cuts (default 7): more cuts, more angular. */
  cuts?: number;
  /** How deep the cuts go: plane offset as a share of the radius, lower is deeper (default 0.72–0.92). */
  cutDepth?: readonly [number, number];
  /** Flatten the bottom below this share of the height (default −0.35), so the stone sits. */
  flatBottom?: number;
  /** Lumpiness before cutting (default 0.12). */
  lumps?: number;
  /** Darker toward the bottom and lighter on top faces by this much (default 0.25). */
  shade?: number;
  stream: Stream;
}

/**
 * An irregular faceted stone of `size` (x, y, z) standing at `at` (its lowest point near y = at.y): a subdivided cube
 * rounded into a lump, then cut by random planes into flat facets. Flat shaded, darker below, lighter on top.
 * Boulders, cliff blocks, foundation stones, cobbles.
 */
export function rock(b: MeshBuilder, at: readonly number[], size: readonly number[], paint: Paint, o: RockOptions): void {
  const s = o.stream;
  const N = o.detail ?? 3;
  const cuts = o.cuts ?? 7;
  const [cutLo, cutHi] = o.cutDepth ?? [0.72, 0.92];
  const flat = o.flatBottom ?? -0.35;
  const lumps = o.lumps ?? 0.12;
  const shade = o.shade ?? 0.25;
  const planes: [Vec3, number][] = [];
  for (let k = 0; k < cuts; k++) {
    const nx = s.nextJitter(1), ny = s.nextJitter(1) * 0.7 + 0.25, nz = s.nextJitter(1);
    planes.push([norm3([nx, ny, nz]), s.nextRange(cutLo, cutHi)]);
  }
  const lumpSeed = [s.nextJitter(3), s.nextJitter(3), s.nextJitter(3)];
  const shape = (d: Vec3): Vec3 => {
    const u = norm3(d);
    // Rounded block between a cube and a sphere.
    const m = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
    const box = scale3(d, 1 / m);
    let p = norm3(add3(scale3(u, 0.55), scale3(box, 0.45)));
    p = scale3(p, len3(add3(scale3(u, 0.55), scale3(box, 0.45))));
    const l = 1 + lumps * Math.sin(u[0] * 3.1 + lumpSeed[0]!) * Math.sin(u[1] * 2.7 + lumpSeed[1]!) * Math.sin(u[2] * 3.3 + lumpSeed[2]!) * 2;
    p = scale3(p, l);
    for (const [n, off] of planes) {
      const dd = dot3(p, n);
      if (dd > off) p = sub3(p, scale3(n, dd - off));
    }
    if (p[1] < flat) p[1] = flat;
    return p;
  };
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const sx = size[0]! / 2, sy = size[1]! / (1 - flat), sz = size[2]! / 2;
  const world = (p: Vec3): Vec3 => [at[0]! + p[0] * sx, at[1]! + (p[1] - flat) * sy, at[2]! + p[2] * sz];
  const center: Vec3 = [at[0]!, at[1]! + (0 - flat) * sy, at[2]!];
  const yTop = at[1]! + size[1]!;
  for (const [nrm, a, c] of faces) {
    const grid: Vec3[] = [];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const fa = (i / N) * 2 - 1, fb = (j / N) * 2 - 1;
        grid.push(world(shape([nrm[0] + a[0] * fa + c[0] * fb, nrm[1] + a[1] * fa + c[1] * fb, nrm[2] + a[2] * fa + c[2] * fb])));
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const q = j * (N + 1) + i;
        for (const tri of [[q, q + 1, q + N + 2], [q, q + N + 2, q + N + 1]]) {
          const pts = tri.map((k) => grid[k]!) as Vec3[];
          // Skip degenerate triangles (corners squashed by the same cut).
          const area = len3(cross3(sub3(pts[1]!, pts[0]!), sub3(pts[2]!, pts[0]!)));
          if (area < 1e-6) continue;
          const shaded: Paint = (p, n) => {
            const t = clamp((p[1] - at[1]!) / Math.max(0.01, yTop - at[1]!), 0, 1);
            return scaleRgb(paintAt(paint, p, n), lerp(1 - shade, 1 + shade * 0.5, t) * (1 + 0.12 * Math.max(0, n[1])));
          };
          convexFace(b, pts, center, shaded);
        }
      }
    }
  }
}
