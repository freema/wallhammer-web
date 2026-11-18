// Low-level geometry shared by every plant generator: oriented triangles, ellipsoids with analytic normals, Bézier
// spines, twisted bark tubes with ridges as real geometry, and the two-sided leaf (a raised top over a flat
// underside, a closed shell, so back-face culling and the flipped-face check both stay honest).
//
// Plants are written in the builder's own coordinates (no `with` transforms): templates are built around the origin
// and placed later with `MeshBuilder.append(template, matrix, tint)`.

import { valueNoise3 } from 'wallhammer-web/gen-core';
import type { RGB, Vec3 } from '../kit/index.ts';
import { MeshBuilder, add3, clamp, cross3, curveFrames, dot3, gradient, len3, lerp, mixRgb, norm3, scale3, scaleRgb, smoothstep, sub3 } from '../kit/index.ts';

/** Writes one vertex with its own sway (0–1) and returns its index. */
export function vtx(b: MeshBuilder, p: readonly number[], n: readonly number[], c: readonly number[], sway = 0, ao = 1): number {
  const i = b.vertex(p, n, c, ao);
  b.flg[i * 4 + 1] = clamp(sway, 0, 1);
  return i;
}

/** A triangle of three existing vertices wound so that its face points along `n`. */
export function triFacing(b: MeshBuilder, i0: number, i1: number, i2: number, n: readonly number[]): void {
  const P = b.positionData;
  const ax = P[i0 * 3]!, ay = P[i0 * 3 + 1]!, az = P[i0 * 3 + 2]!;
  const e1x = P[i1 * 3]! - ax, e1y = P[i1 * 3 + 1]! - ay, e1z = P[i1 * 3 + 2]! - az;
  const e2x = P[i2 * 3]! - ax, e2y = P[i2 * 3 + 1]! - ay, e2z = P[i2 * 3 + 2]! - az;
  const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
  if (cx * n[0]! + cy * n[1]! + cz * n[2]! < 0) b.tri(i0, i2, i1);
  else b.tri(i0, i1, i2);
}

/** Sets the sway of vertices from `first` on from a function of their position. */
export function swayBy(b: MeshBuilder, first: number, fn: (x: number, y: number, z: number) => number): void {
  for (let v = first; v < b.vertexCount; v++) b.flg[v * 4 + 1] = clamp(fn(b.positionData[v * 3]!, b.positionData[v * 3 + 1]!, b.positionData[v * 3 + 2]!), 0, 1);
}

/** Cubic Bézier through four control points, `n` segments (n + 1 points). */
export function bezier(p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[], n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0]! + b * p1[0]! + c * p2[0]! + d * p3[0]!, a * p0[1]! + b * p1[1]! + c * p2[1]! + d * p3[1]!, a * p0[2]! + b * p1[2]! + c * p2[2]! + d * p3[2]!]);
  }
  return out;
}

/** Two unit vectors across a direction. */
export function tangents(n: readonly number[]): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(n[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(ref, n));
  const v = cross3(n, u);
  return [u, v];
}

export interface EllipsoidOptions {
  /** Segments around (default 10) and rings from pole to pole (default 7). */
  seg?: number;
  rings?: number;
  /** Radial noise amount (relative) and its seed. */
  noise?: number;
  seed?: number;
  /** Colour from the unit direction and the position. */
  paint: (d: Vec3, p: Vec3) => RGB;
  /** Sway from the unit direction (default 0). */
  sway?: (d: Vec3) => number;
  /** Flatten everything below this share of the y radius (−1 keeps the full shape). */
  floor?: number;
}

/**
 * A lumpy ellipsoid of radii `r` around `c`, smooth shaded with the normals of the clean ellipsoid (soft, painted
 * looking blobs). Closed, faces outward.
 */
export function ellipsoid(b: MeshBuilder, c: readonly number[], r: readonly number[], o: EllipsoidOptions): void {
  const S = o.seg ?? 10, R = o.rings ?? 7;
  const seed = o.seed ?? 1;
  const floor = o.floor ?? -1;
  const point = (d: Vec3): { p: Vec3; n: Vec3 } => {
    const k = o.noise ? 1 + o.noise * (valueNoise3(d[0] * 1.7 + 5, d[1] * 1.7 + 5, d[2] * 1.7 + 5, 1, seed) - 0.5) * 2 : 1;
    const y = Math.max(d[1] * k, floor);
    const p: Vec3 = [c[0]! + r[0]! * d[0] * k, c[1]! + r[1]! * y, c[2]! + r[2]! * d[2] * k];
    const floored = floor > -1 && y <= floor + 1e-6;
    const n: Vec3 = floored ? [0, -1, 0] : norm3([d[0] / r[0]!, d[1] / r[1]!, d[2] / r[2]!]);
    return { p, n };
  };
  const vert = (d: Vec3): number => {
    const { p, n } = point(d);
    return vtx(b, p, n, o.paint(d, p), o.sway ? o.sway(d) : 0);
  };
  const top = vert([0, 1, 0]);
  const rings: number[][] = [];
  const dirs: Vec3[][] = [];
  for (let j = 1; j < R; j++) {
    const th = (j / R) * Math.PI;
    const ring: number[] = [];
    const dr: Vec3[] = [];
    for (let i = 0; i < S; i++) {
      const ph = (i / S) * Math.PI * 2 + (j % 2) * (Math.PI / S);
      const d: Vec3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      ring.push(vert(d));
      dr.push(d);
    }
    rings.push(ring);
    dirs.push(dr);
  }
  const bottom = vert([0, -1, 0]);
  for (let i = 0; i < S; i++) {
    const i1 = (i + 1) % S;
    triFacing(b, top, rings[0]![i]!, rings[0]![i1]!, add3(dirs[0]![i]!, [0, 2, 0]));
    const last = rings.length - 1;
    triFacing(b, bottom, rings[last]![i1]!, rings[last]![i]!, add3(dirs[last]![i]!, [0, -2, 0]));
  }
  for (let j = 0; j < rings.length - 1; j++) {
    const A = rings[j]!, B = rings[j + 1]!;
    // Rings are staggered by half a segment: a strip of triangles between them.
    for (let i = 0; i < S; i++) {
      const i1 = (i + 1) % S;
      // Ring j sits at theta index j + 1; odd indices are turned by half a segment.
      const aHalf = (j + 1) % 2 === 1;
      const out = norm3(add3(dirs[j]![i]!, dirs[j + 1]![i]!));
      if (!aHalf) {
        triFacing(b, A[i]!, B[i]!, A[i1]!, out);
        triFacing(b, A[i1]!, B[i]!, B[i1]!, out);
      } else {
        triFacing(b, A[i]!, B[i]!, B[i1]!, out);
        triFacing(b, A[i]!, B[i1]!, A[i1]!, out);
      }
    }
  }
}

export interface BarkOptions {
  /** Sides around (default 12). */
  sides?: number;
  /** Radius at a share 0–1 of the length. */
  radius: (f: number) => number;
  /** Bark ridges around and their relative depth (default 9 and 0.08). */
  ridges?: number;
  ridgeDepth?: number;
  /** Turns of the ridges from end to end (radians, default 1.2): the twisted trunk. */
  twist?: number;
  /** Extra relative radius at (f, angle): root flare, buttress lobes. */
  flare?: (f: number, a: number) => number;
  /** Groove and ridge colours. */
  bark: RGB;
  barkLight: RGB;
  /** Green moss on the north and upper side of the lowest part (0–1). */
  moss?: number;
  /** Darken toward the start of the spine (the foot) over this share of the length (default 0.12). */
  foot?: number;
  /** Sway along the length (default none). */
  sway?: (f: number) => number;
  /** Noise seed (lumps and colour). */
  seed: number;
  /** Start angle, so neighbouring tubes do not line up their seams. */
  phase?: number;
}

const MOSS: RGB = [0.33, 0.42, 0.17];

/**
 * A twisted bark tube along a spine: ridges and grooves of the bark as real geometry (they catch the light), lumps
 * from 3D noise, an optional flare at the foot, groove-dark and ridge-light colours, moss low on the north side.
 * Open at both ends (trunk feet go under the ground, branch tips into the leaves).
 */
export function barkTube(b: MeshBuilder, spine: readonly Vec3[], o: BarkOptions): void {
  if (spine.length < 2) return;
  const sides = o.sides ?? 12;
  const ridges = o.ridges ?? 9;
  const depth = o.ridgeDepth ?? 0.08;
  const twist = o.twist ?? 1.2;
  const phase = o.phase ?? 0;
  const foot = o.foot ?? 0.12;
  const frames = curveFrames(spine);
  const L: number[] = [0];
  for (let i = 1; i < spine.length; i++) L.push(L[i - 1]! + len3(sub3(spine[i]!, spine[i - 1]!)));
  const total = L[L.length - 1]! || 1;
  const ridge: number[] = [];
  const pts: Vec3[] = [];
  const outs: Vec3[] = [];
  for (let j = 0; j < spine.length; j++) {
    const f = L[j]! / total;
    const { u, v } = frames[j]!;
    const r0 = o.radius(f);
    for (let i = 0; i < sides; i++) {
      const a = phase + (i / sides) * Math.PI * 2;
      const x = a * ridges + twist * f * 6 + 0.9 * Math.sin(a * 3 + f * 7 + o.seed);
      // Ridges are broad and rounded, grooves narrow: a sharpened cosine.
      const rs = Math.pow(0.5 + 0.5 * Math.cos(x), 0.6);
      const out = add3(scale3(u, Math.cos(a)), scale3(v, Math.sin(a)));
      const lump = 1 + 0.07 * (valueNoise3(spine[j]![0] + out[0] * 0.8, spine[j]![1] * 0.7, spine[j]![2] + out[2] * 0.8, 1.1, o.seed) - 0.5) * 2;
      const fl = o.flare ? o.flare(f, a) : 0;
      const r = r0 * lump * (1 + fl) * (1 - depth + 2 * depth * rs);
      ridge.push(rs);
      pts.push(add3(spine[j]!, scale3(out, r)));
      outs.push(out);
    }
  }
  const first = b.vertexCount;
  b.grid(sides, spine.length, (i, j) => pts[j * sides + (((i % sides) + sides) % sides)]!, (i, j, p) => {
    const k = j * sides + (((i % sides) + sides) % sides);
    const f = L[j]! / total;
    const rs = ridge[k]!;
    const out = outs[k]!;
    const nz = valueNoise3(p[0]! * 0.9, p[1]! * 0.45, p[2]! * 0.9, 1, o.seed + 7);
    let c = mixRgb(scaleRgb(o.bark, 0.55), o.barkLight, Math.pow(rs, 1.6) * (0.75 + 0.5 * nz));
    c = scaleRgb(c, lerp(0.62, 1, smoothstep(0, foot, f)) * (0.9 + 0.2 * nz));
    if (o.moss) {
      const side = clamp(-out[2] * 0.8 + out[1] * 0.6 + (nz - 0.5) * 0.9, 0, 1);
      c = mixRgb(c, scaleRgb(MOSS, 0.8 + 0.4 * nz), o.moss * smoothstep(0.15, 0.7, side) * (1 - smoothstep(0.08, 0.4, f)) * (1 - rs * 0.4));
    }
    return c;
  }, { wrapI: true });
  if (o.sway) {
    for (let j = 0; j < spine.length; j++) {
      const s = clamp(o.sway(L[j]! / total), 0, 1);
      for (let i = 0; i < sides; i++) b.flg[(first + j * sides + i) * 4 + 1] = s;
    }
  }
}

export interface LeafColors {
  base: RGB;
  tip: RGB;
  under: RGB;
}

/**
 * One leaf: a diamond with a raised midrib on top and a flat underside (6 triangles, closed). `shadeN` bends the top
 * normals toward the normal of the cluster it belongs to, so a crown shades as soft painted masses.
 */
export function leaf(b: MeshBuilder, base: readonly number[], tipDir: readonly number[], normal: readonly number[], len: number, width: number, col: LeafColors, sway: readonly [number, number], shadeN?: readonly number[]): void {
  const t = norm3(tipDir);
  let n = sub3(normal, scale3(t, dot3(normal, t)));
  if (len3(n) < 1e-4) n = tangents(t)[0];
  n = norm3(n);
  const s = norm3(cross3(n, t));
  const T = add3(base, scale3(t, len));
  const mid = add3(base, scale3(t, len * 0.4));
  const S1 = add3(mid, scale3(s, width / 2));
  const S2 = add3(mid, scale3(s, -width / 2));
  const M = add3(add3(base, scale3(t, len * 0.45)), scale3(n, len * 0.1));
  const B = [...base] as Vec3;
  const topN = shadeN ? norm3(add3(scale3(norm3(shadeN), 0.7), scale3(n, 0.3))) : n;
  const side = mixRgb(col.base, col.tip, 0.45);
  const m = vtx(b, M, topN, mixRgb(col.base, col.tip, 0.25), lerp(sway[0], sway[1], 0.45));
  const it = vtx(b, T, topN, col.tip, sway[1]);
  const i1 = vtx(b, S1, topN, side, lerp(sway[0], sway[1], 0.5));
  const ib = vtx(b, B, topN, scaleRgb(col.base, 0.85), sway[0]);
  const i2 = vtx(b, S2, topN, side, lerp(sway[0], sway[1], 0.5));
  triFacing(b, m, it, i1, n);
  triFacing(b, m, i1, ib, n);
  triFacing(b, m, ib, i2, n);
  triFacing(b, m, i2, it, n);
  const dn = scale3(n, -1);
  const ut = vtx(b, T, dn, col.under, sway[1]);
  const u1 = vtx(b, S1, dn, col.under, lerp(sway[0], sway[1], 0.5));
  const ub = vtx(b, B, dn, scaleRgb(col.under, 0.85), sway[0]);
  const u2 = vtx(b, S2, dn, col.under, lerp(sway[0], sway[1], 0.5));
  triFacing(b, ub, u1, ut, dn);
  triFacing(b, ub, ut, u2, dn);
}

/** A three-sided tapering blade from `base` along a bent path to its tip (grass, reeds, onion leaves). 9 triangles. */
export function blade(b: MeshBuilder, base: readonly number[], dir: readonly number[], bend: readonly number[], len: number, width: number, colBase: RGB, colTip: RGB, sway: readonly [number, number]): void {
  const d = norm3(dir);
  const [u0] = tangents(d);
  // Facing: the flat side faces the bend direction, so the blade curls like a leaf of grass.
  const bendN = norm3(sub3(bend, scale3(d, dot3(bend, d))));
  const across = len3(bendN) > 0.1 ? norm3(cross3(d, bendN)) : u0;
  const mid = add3(add3(base, scale3(d, len * 0.5)), scale3(bend, len * 0.12));
  const tip = add3(add3(base, scale3(d, len)), scale3(bend, len * 0.42));
  const back = len3(bendN) > 0.1 ? bendN : cross3(across, d);
  const ring = (c: Vec3, w: number): Vec3[] => [add3(c, scale3(across, w / 2)), add3(c, scale3(back, -w * 0.35)), add3(c, scale3(across, -w / 2))];
  const r0 = ring([...base] as Vec3, width);
  const r1 = ring(mid, width * 0.75);
  const center0 = add3(base, scale3(back, -width * 0.1));
  const center1 = add3(mid, scale3(back, -width * 0.08));
  const cm = mixRgb(colBase, colTip, 0.5);
  for (let k = 0; k < 3; k++) {
    const k1 = (k + 1) % 3;
    const out0 = norm3(sub3(scale3(add3(r0[k]!, r0[k1]!), 0.5), center0));
    const out1 = norm3(sub3(scale3(add3(r1[k]!, r1[k1]!), 0.5), center1));
    const lit0 = norm3(add3(out0, [0, 0.8, 0]));
    const lit1 = norm3(add3(out1, [0, 0.8, 0]));
    const a = vtx(b, r0[k]!, lit0, colBase, sway[0]);
    const c = vtx(b, r0[k1]!, lit0, colBase, sway[0]);
    const e = vtx(b, r1[k1]!, lit1, cm, lerp(sway[0], sway[1], 0.4));
    const f = vtx(b, r1[k]!, lit1, cm, lerp(sway[0], sway[1], 0.4));
    const g = vtx(b, tip, lit1, colTip, sway[1]);
    triFacing(b, a, c, e, out0);
    triFacing(b, a, e, f, out0);
    triFacing(b, f, e, g, out1);
  }
}

/** A colour from a three-stop ramp dark → mid → light at t 0–1. */
export const ramp3 = (dark: RGB, mid: RGB, light: RGB, t: number): RGB => gradient([[0, dark], [0.55, mid], [1, light]], clamp(t, 0, 1));
