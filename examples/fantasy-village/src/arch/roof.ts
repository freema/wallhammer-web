// Roofs of the architecture kit: curved gable roofs covered with rows of single shingles (B2).
//
// The shape (`roofShape`) is pure math in a roof frame: s along the ridge, q across it (signed, + toward the frame's
// +z), y up from the wall plate. The ridge sags in the middle, the slopes are bell-cast (steeper at the ridge,
// flattening toward the eaves) and dip a little, the corners of the eaves lift and the gable ends of the ridge rise
// (the "overdrawn" gables of the concept). `buildRoof` lays the covering: a deck and an underside with rafter tails,
// staggered rows of shingles 0.5–0.7 m wide, each its own bevelled slab with its own colour, a ragged lower edge,
// some shingles skewed and a few missing, ridge caps and bargeboards whose tops cross above the ridge as horns.
// Everything is written into one builder (merged), never one mesh per shingle.
//
// Dormers sit on a slope: `dormerHole` tells the main roof where to leave out shingles, `dormer` builds the front
// wall with its window, the cheeks and a small roof of its own that runs back into the main roof.

import type { Mat34, RGB, Vec3 } from '../kit/index.ts';
import { MAT, add3, applyPoint34, basis34, bevelBox, clamp, compose34, cross3, lerp, norm3, rotateY, scale3, scaleRgb, smoothstep, sub3, mixRgb } from '../kit/index.ts';
import { valueNoise2 } from 'wallhammer-web/gen-core';
import type { Site } from './site.ts';
import { faceOut, wallFrame } from './site.ts';
import { timber } from './timber.ts';
import type { WindowOptions } from './openings.ts';
import { windowAt, windowOpening } from './openings.ts';
import { plasterPanel } from './walls.ts';
import { frameInWall } from './timber.ts';

export type RoofEnd = 'gable' | 'open';

export interface RoofSpec {
  /** Centre of the wall rectangle under the roof (site x, z) and the height of the wall plate (eaves). */
  x: number;
  z: number;
  y: number;
  /** Direction of the ridge in the site: along x or along z. */
  axis: 'x' | 'z';
  /** Wall span along the ridge and across it; rise of the ridge above the plate at the gables. */
  length: number;
  span: number;
  rise: number;
  /** Overhang at the eaves (default 0.6) and beyond the gables, per end (default 0.7). */
  eave?: number;
  gable?: number | readonly [number, number];
  /** 'gable' ends get bargeboards, horns and lifted corners; 'open' ends run into another roof or wall. */
  ends?: readonly [RoofEnd, RoofEnd];
  /** Ridge sag in the middle (default 0.28), bell-cast share (0.35), corner lift (0.38), slope dip (0.08). */
  sag?: number;
  flare?: number;
  curl?: number;
  dip?: number;
}

export interface RoofShape {
  readonly spec: RoofSpec;
  /** Roof frame (s, y, q) → site. */
  readonly m: Mat34;
  readonly halfL: number;
  readonly halfD: number;
  /** Extent of the covering: s from s0 to s1, |q| up to qMax. */
  readonly s0: number;
  readonly s1: number;
  readonly qMax: number;
  /** Thickness of the covering above the surface (shingles) and of the deck below it. */
  readonly cover: number;
  readonly deck: number;
  /** Surface height (roof frame, above the plate) at s, q. */
  y(s: number, q: number): number;
  /** Site point of the surface at s, q. */
  point(s: number, q: number): Vec3;
  /** Site x, z → roof s, q. */
  toRoof(x: number, z: number): [number, number];
  /** Roof s, q → site x, z. */
  toSite(s: number, q: number): [number, number];
  /** Site y of the top of the covering above site x, z (−Infinity outside the roof). */
  heightAt(x: number, z: number): number;
  /** Site y of the underside of the deck above site x, z (−Infinity outside). */
  underside(x: number, z: number): number;
  /** Highest point of the ridge (site y). */
  readonly ridgeY: number;
}

/** The pure shape of a roof (no geometry): build the covering with `buildRoof`. */
export function roofShape(spec: RoofSpec): RoofShape {
  const Lh = spec.length / 2, Dh = spec.span / 2;
  const eave = spec.eave ?? 0.6;
  const g = typeof spec.gable === 'number' ? [spec.gable, spec.gable] : (spec.gable ?? [0.7, 0.7]);
  const ends = spec.ends ?? ['gable', 'gable'];
  const sag = spec.sag ?? 0.28, k = spec.flare ?? 0.35, curl = spec.curl ?? 0.38, dip = spec.dip ?? 0.08;
  const s0 = -Lh - g[0]!, s1 = Lh + g[1]!, qMax = Dh + eave;
  const tMax = qMax / Dh;
  const yaw = spec.axis === 'x' ? 0 : -Math.PI / 2;
  const m = compose34([spec.x, spec.y, spec.z], yaw);
  const f = (t: number): number => (t <= 1 ? (1 - k) * t + k * (1 - (1 - t) * (1 - t)) : 1 + (1 - k) * (t - 1));
  const y = (s: number, q: number): number => {
    const t = Math.abs(q) / Dh;
    const sl = clamp(Math.abs(s) / Lh, 0, 1);
    const sagF = 1 - sl * sl;
    const end = s < 0 ? 0 : 1;
    const gableEnd = ends[end] === 'gable';
    const sEnd = s < 0 ? -s0 : s1;
    const beyond = Math.abs(s) - Lh;
    let R = spec.rise - sag * sagF;
    if (beyond > 0 && gableEnd) R += curl * 0.4 * (beyond / Math.max(0.1, sEnd - Lh)) ** 2;
    const e = gableEnd ? smoothstep(Lh - 1.4, sEnd, Math.abs(s)) : 0;
    const lift = (curl * e * e + curl * 0.22) * smoothstep(1, tMax, t);
    return R * (1 - f(t)) + lift - dip * Math.sin(Math.PI * Math.min(t, 1)) * sagF;
  };
  const point = (s: number, q: number): Vec3 => applyPoint34(m, s, y(s, q), q, [0, 0, 0]);
  const toRoof = (x: number, z: number): [number, number] => rotateY(x - spec.x, z - spec.z, -yaw);
  const toSite = (s: number, q: number): [number, number] => {
    const [dx, dz] = rotateY(s, q, yaw);
    return [spec.x + dx, spec.z + dz];
  };
  const cover = 0.1, deck = 0.16;
  const inside = (s: number, q: number): boolean => s >= s0 && s <= s1 && Math.abs(q) <= qMax;
  return {
    spec,
    m,
    halfL: Lh,
    halfD: Dh,
    s0,
    s1,
    qMax,
    cover,
    deck,
    y,
    point,
    toRoof,
    toSite,
    heightAt: (x, z) => {
      const [s, q] = toRoof(x, z);
      return inside(s, q) ? spec.y + y(s, q) + cover : -Infinity;
    },
    underside: (x, z) => {
      const [s, q] = toRoof(x, z);
      return inside(s, q) ? spec.y + y(s, q) - deck - 0.03 : -Infinity;
    },
    ridgeY: spec.y + Math.max(y(0, 0), y(s0, 0), y(s1, 0)),
  };
}

/** A region of a roof (roof frame: s range, signed q range) left without shingles (dormers, chimneys). */
export interface RoofHole {
  s0: number;
  s1: number;
  q0: number;
  q1: number;
}

/** The hole a site-local rectangle (centre, size along x and z) makes in a roof, with a margin. */
export function roofHoleFor(shape: RoofShape, x: number, z: number, w: number, d: number, margin = 0.12): RoofHole {
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => shape.toRoof(x + (a! * w) / 2, z + (c! * d) / 2));
  return {
    s0: Math.min(...pts.map((p) => p[0])) - margin,
    s1: Math.max(...pts.map((p) => p[0])) + margin,
    q0: Math.min(...pts.map((p) => p[1])) - margin,
    q1: Math.max(...pts.map((p) => p[1])) + margin,
  };
}

export interface ShingleOptions {
  /** Width range (default [0.5, 0.7], B2), exposed length per row (0.44), thickness (0.085). */
  width?: readonly [number, number];
  exposure?: number;
  thick?: number;
  /** Share of missing shingles (0.022) and of visibly skewed ones (0.07). */
  missing?: number;
  skewed?: number;
  /** Share of shingles in an accent colour of the palette (0.22). */
  accents?: number;
}

export interface RoofOptions {
  shingles?: ShingleOptions;
  holes?: readonly RoofHole[];
  /** Parts to build (all default true). */
  ridgeCaps?: boolean;
  bargeboards?: boolean;
  rafters?: boolean;
  /** Covering colour instead of the palette's roof. */
  color?: RGB;
}

/** Builds the covering of a roof shape into the site (deck, underside, rafters, shingles, ridge caps, bargeboards). */
export function buildRoof(site: Site, shape: RoofShape, o: RoofOptions = {}): void {
  site.at(shape.m, (r) => roofInFrame(r, shape, o));
}

function roofInFrame(site: Site, shape: RoofShape, o: RoofOptions): void {
  const b = site.b;
  const pal = site.pal;
  const s = site.s;
  const { s0, s1, qMax, halfD: Dh, halfL: Lh } = shape;
  const y = shape.y;
  const ends = shape.spec.ends ?? ['gable', 'gable'];
  const P = (ss: number, q: number): Vec3 => [ss, y(ss, q), q];
  const T = shape.deck;
  const seed = (s.next() * 1e6) | 0;
  // --- Deck, underside and edges ---
  const ns = Math.max(2, Math.ceil((s1 - s0) / 0.5));
  const nq = Math.max(2, Math.ceil(qMax / 0.35));
  const sAt = (i: number): number => s0 + ((s1 - s0) * i) / ns;
  const qAt = (j: number): number => (qMax * j) / nq;
  for (const sg of [-1, 1]) {
    b.withFlags({ cls: MAT.roof }, () =>
      b.grid(ns + 1, nq + 1, (i, j) => [sAt(i), y(sAt(i), sg * qAt(j)) - 0.02, sg * qAt(j)], () => pal.roofDeck, { flip: sg > 0 }),
    );
    b.withFlags({ cls: MAT.wood }, () =>
      b.grid(ns + 1, nq + 1, (i, j) => [sAt(i), y(sAt(i), sg * qAt(j)) - T, sg * qAt(j)], (_i, j) => scaleRgb(pal.roofUnder, lerp(0.75, 1.05, j / nq)), { flip: sg < 0 }),
    );
    // Eave edge.
    b.withFlags({ cls: MAT.wood }, () => {
      const q = sg * qMax;
      for (let i = 0; i < ns; i++) {
        const a = sAt(i), c = sAt(i + 1);
        faceOut(b, [[a, y(a, q) - 0.02, q], [c, y(c, q) - 0.02, q], [c, y(c, q) - T, q], [a, y(a, q) - T, q]], [0, -0.2, sg], scaleRgb(pal.roofUnder, 0.9));
      }
      // Gable edges.
      for (const [ss, dir] of [[s0, -1], [s1, 1]] as const) {
        for (let j = 0; j < nq; j++) {
          const q0 = sg * qAt(j), q1 = sg * qAt(j + 1);
          faceOut(b, [[ss, y(ss, q0) - 0.02, q0], [ss, y(ss, q1) - 0.02, q1], [ss, y(ss, q1) - T, q1], [ss, y(ss, q0) - T, q0]], [dir, 0, 0], scaleRgb(pal.roofUnder, 0.9));
        }
      }
    });
    // Rafter tails under the eaves.
    if (o.rafters !== false) {
      const n = Math.max(2, Math.round((2 * Lh) / 0.95));
      for (let k = 0; k <= n; k++) {
        const ss = -Lh + 0.15 + ((2 * Lh - 0.3) * k) / n;
        const qa = sg * (Dh - 0.15), qb = sg * (qMax - 0.06);
        timber(site, [ss, y(ss, qa) - T - 0.08, qa], [ss, y(ss, qb) - T - 0.06, qb], { width: 0.15, depth: 0.17, sag: 0, wobble: 0.01, color: pal.timberDark, up: [0, 1, 0] });
      }
    }
  }
  // --- Shingles ---
  const so = o.shingles ?? {};
  const [w0, w1] = so.width ?? [0.5, 0.7];
  const expo = so.exposure ?? 0.44;
  const thick = so.thick ?? 0.085;
  const missing = so.missing ?? 0.022;
  const skewed = so.skewed ?? 0.07;
  const accents = so.accents ?? 0.22;
  const base = o.color ?? pal.roof;
  const holes = o.holes ?? [];
  // Arc length along a slope from the eave edge inward (at s = 0), and back to q.
  const steps = 200;
  const arc: number[] = [0];
  for (let k = 1; k <= steps; k++) {
    const qa = qMax * (1 - (k - 1) / steps), qb = qMax * (1 - k / steps);
    arc.push(arc[k - 1]! + Math.hypot(qa - qb, y(0, qa) - y(0, qb)));
  }
  const total = arc[steps]!;
  const qOfArc = (a: number): number => {
    if (a <= 0) return qMax - a;
    if (a >= total) return 0;
    let lo = 0, hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arc[mid]! < a) lo = mid;
      else hi = mid;
    }
    const t = (a - arc[lo]!) / (arc[hi]! - arc[lo]! || 1);
    return qMax * (1 - (lo + t) / steps);
  };
  b.withFlags({ cls: MAT.roof }, () => {
    for (const sg of [-1, 1]) {
      for (let row = 0; ; row++) {
        const aBase = row * expo - 0.06;
        if (qOfArc(aBase) < 0.14) break;
        const odd = row % 2 === 1;
        let sa = s0 - 0.04 - (odd ? (w0 + w1) / 4 : 0) - s.nextRange(0, 0.12);
        while (sa < s1 + 0.03) {
          let width = s.nextRange(w0, w1);
          if (s1 + 0.04 - (sa + width) < 0.22) width = s1 + 0.04 - sa;
          const a = Math.max(sa, s0 - 0.05), c = Math.min(sa + width, s1 + 0.05);
          sa += width;
          if (c - a < 0.16) continue;
          const sc = (a + c) / 2;
          // Ragged lower edge: every shingle a little longer or shorter, the first row more so.
          const aBot = aBase + s.nextJitter(row === 0 ? 0.07 : 0.035);
          const aTop = aBot + expo * s.nextRange(1.75, 2.0);
          const qb = sg * qOfArc(aBot), qt = sg * Math.max(0, qOfArc(aTop));
          const qc = (qb + qt) / 2;
          const roll = s.next();
          const skewRoll = s.next();
          const colRoll = s.next();
          const accent = s.nextInt(0, Math.max(0, pal.roofAccents.length - 1));
          const tone: [number, number, number] = [s.nextJitter(0.025), s.nextJitter(0.15), s.nextJitter(0.16)];
          if (holes.some((h) => sc > h.s0 && sc < h.s1 && qc > h.q0 && qc < h.q1)) continue;
          if (roll < missing && row > 0) continue;
          // Frame of the shingle: R along the ridge, U up the slope, N out of the roof.
          const Pb = P(sc, qb), Pt = P(sc, qt);
          let U = norm3(sub3(Pt, Pb));
          let R = norm3(sub3(P(sc + 0.1, qc), P(sc - 0.1, qc)));
          let N = norm3(cross3(R, U));
          if (N[1] < 0) {
            N = scale3(N, -1);
            R = scale3(R, -1);
          }
          U = cross3(N, R);
          const rot = skewRoll < skewed ? s.nextRange(0.1, 0.22) * (s.next() < 0.5 ? -1 : 1) : s.nextJitter(0.03);
          const cr = Math.cos(rot), sr = Math.sin(rot);
          const R2 = add3(scale3(R, cr), scale3(U, sr));
          const U2 = sub3(scale3(U, cr), scale3(R, sr));
          const L = Math.hypot(Pt[0] - Pb[0], Pt[1] - Pb[1], Pt[2] - Pb[2]);
          const W = c - a - 0.03;
          const lift = (row === 0 ? 0.6 : 0.95) * thick;
          let col = colRoll < accents && pal.roofAccents.length ? pal.roofAccents[accent]! : base;
          col = shiftTone(col, tone);
          // Slow weathering over the roof: patches lighter and darker.
          col = scaleRgb(col, 0.88 + 0.24 * valueNoise2(sc, qc, 2.6, seed));
          shingle(b, Pb, R2, U2, N, W, L, thick, lift, col);
        }
      }
    }
  });
  // --- Ridge: a ridge roll and caps ---
  if (o.ridgeCaps !== false) {
    const top = (ss: number): Vec3 => [ss, y(ss, 0) + thick * 1.2, 0];
    const path: Vec3[] = [];
    for (let k = 0; k <= 16; k++) path.push(top(lerp(s0 - 0.05, s1 + 0.05, k / 16)));
    // Caps: two slabs per step forming an inverted V, overlapping along the ridge.
    const step = 0.4;
    const n = Math.ceil((s1 - s0 + 0.1) / step);
    b.withFlags({ cls: MAT.roof }, () => {
      for (let k = 0; k <= n; k++) {
        const ss = s0 - 0.05 + k * step + s.nextJitter(0.03);
        const col = shiftTone(pal.ridge, [s.nextJitter(0.02), s.nextJitter(0.12), s.nextJitter(0.14)]);
        for (const sg of [-1, 1]) {
          const Pa = P(ss, 0), Pc = P(ss, sg * 0.36);
          let U = norm3(sub3(Pa, Pc));
          let R = norm3(sub3(P(ss + 0.1, 0), P(ss - 0.1, 0)));
          let N = norm3(cross3(R, U));
          if (N[1] < 0) {
            N = scale3(N, -1);
            R = scale3(R, -1);
          }
          U = cross3(N, R);
          const rot = s.nextJitter(0.05);
          const R2 = add3(scale3(R, Math.cos(rot)), scale3(U, Math.sin(rot)));
          const U2 = sub3(scale3(U, Math.cos(rot)), scale3(R, Math.sin(rot)));
          b.with(basis34(R2, U2, N, add3(Pa, scale3(N, thick * 1.3))), () =>
            bevelBox(b, [0, -0.4, 0], [0.5, 0.48, 0.075], (_p, n2) => scaleRgb(col, 0.9 + 0.2 * Math.max(0, n2[1])), { bevel: 0.025 }),
          );
        }
      }
    });
  }
  // --- Bargeboards with horns ---
  if (o.bargeboards !== false) {
    for (const end of [0, 1] as const) {
      if (ends[end] !== 'gable') continue;
      const sE = end === 0 ? s0 : s1;
      const out = end === 0 ? -1 : 1;
      for (const sg of [-1, 1]) {
        const tops: Vec3[] = [];
        const bots: Vec3[] = [];
        const n = 14;
        // From a little beyond the eave up to the ridge, then on past it as a horn.
        const slope0 = (y(sE, 0.05) - y(sE, 0)) / 0.05;
        for (let k = 0; k <= n + 2; k++) {
          let q: number, yy: number;
          if (k <= n) {
            q = sg * lerp(qMax + 0.1, 0, k / n);
            yy = y(sE, q);
          } else {
            const d = (k - n) * 0.28;
            q = -sg * d;
            yy = y(sE, 0) - slope0 * d + (k - n) * 0.04;
          }
          tops.push([sE + out * 0.02, yy + thick + 0.08, q]);
          bots.push([sE + out * 0.02, yy - 0.34, q]);
        }
        board(site, tops, bots, [out, 0, 0], 0.15, site.tone(pal.timberDark));
      }
    }
  }
  void Lh;
}

/** Shifts a colour by hue / saturation / value offsets (cheap HSV-free tint for many shingles). */
function shiftTone(c: readonly number[], t: readonly [number, number, number]): RGB {
  const lum = (c[0]! + c[1]! + c[2]!) / 3;
  const sat = 1 + t[1];
  const val = 1 + t[2];
  const hue = t[0] * 4;
  // Hue shift approximated as a small rotation toward the neighbouring channel.
  const r = c[0]! + (c[2]! - c[0]!) * Math.max(0, hue) + (c[1]! - c[0]!) * Math.max(0, -hue);
  const g = c[1]! + (c[0]! - c[1]!) * Math.max(0, hue) + (c[2]! - c[1]!) * Math.max(0, -hue);
  const bl = c[2]! + (c[1]! - c[2]!) * Math.max(0, hue) + (c[0]! - c[2]!) * Math.max(0, -hue);
  return [Math.max(0, (lum + (r - lum) * sat) * val), Math.max(0, (lum + (g - lum) * sat) * val), Math.max(0, (lum + (bl - lum) * sat) * val)];
}

/**
 * One shingle: a slab of width W along R and length L along U from the bottom edge point `Pb`, thickness `thick`
 * along N, its bottom edge lifted by `lift` (it rests on the row below). The lower corners are cut, the bottom edge and
 * the corners bevelled; the exposed lower part is lighter, the overlapped upper part darker. 16 triangles.
 */
export function shingle(b: import('../kit/index.ts').MeshBuilder, Pb: Vec3, R: Vec3, U: Vec3, N: Vec3, W: number, L: number, thick: number, lift: number, col: RGB): void {
  const c = Math.min(0.1, W * 0.18);
  const e = Math.min(0.025, thick * 0.35);
  const hw = W / 2;
  // Outline (counter-clockwise seen from N): bottom edge first, the top edge is index 3 → 4.
  const O: [number, number][] = [[-hw + c, 0], [hw - c, 0], [hw, c], [hw, L], [-hw, L], [-hw, c]];
  // The inner outline of the top face: inset along the bottom edge and the cut corners only (the long sides lie
  // against the neighbours and need no bevel).
  const I: [number, number][] = [[-hw + c + e * 0.4, e], [hw - c - e * 0.4, e], [hw, c + e * 0.4], [hw, L], [-hw, L], [-hw, c + e * 0.4]];
  const at = (x: number, yv: number, z: number): Vec3 => {
    const zz = z + lift * (1 - yv / L);
    return [Pb[0] + R[0] * x + U[0] * yv + N[0] * zz, Pb[1] + R[1] * x + U[1] * yv + N[1] * zz, Pb[2] + R[2] * x + U[2] * yv + N[2] * zz];
  };
  const shade = (yv: number, k: number): RGB => scaleRgb(col, k * lerp(1.12, 0.78, clamp(yv / L, 0, 1)));
  // Top.
  const top = I.map(([x, yv]) => at(x, yv, thick));
  b.face(top, I.map(([, yv]) => shade(yv, 1)));
  // Bevels and sides (not along the hidden top edge).
  for (let k = 0; k < 6; k++) {
    if (k === 3 || k === 2 || k === 4) continue;
    const k1 = (k + 1) % 6;
    const o0 = O[k]!, o1 = O[k1]!, i0 = I[k]!, i1 = I[k1]!;
    const bev = [at(o0[0], o0[1], thick - e), at(o1[0], o1[1], thick - e), at(i1[0], i1[1], thick), at(i0[0], i0[1], thick)];
    const bright = k === 0 ? 1.22 : 1.1;
    b.face(bev, [shade(o0[1], bright), shade(o1[1], bright), shade(i1[1], bright), shade(i0[1], bright)]);
    const side = [at(o0[0], o0[1], 0), at(o1[0], o1[1], 0), at(o1[0], o1[1], thick - e), at(o0[0], o0[1], thick - e)];
    b.face(side, [shade(o0[1], 0.7), shade(o1[1], 0.7), shade(o1[1], 0.85), shade(o0[1], 0.85)]);
  }
}

/**
 * A board along a line given by its top and bottom edge points, `thick` along `out` (outward face), as a closed
 * strip with capped ends: bargeboards, fascias, sign boards.
 */
export function board(site: Site, tops: readonly Vec3[], bots: readonly Vec3[], out: Vec3, thick: number, col: RGB): void {
  const b = site.b;
  const inner = (p: Vec3): Vec3 => sub3(p, scale3(out, thick * 0.4));
  const outer = (p: Vec3): Vec3 => add3(p, scale3(out, thick * 0.6));
  // Wood shading: lighter on faces turned up, darker below.
  const paint = (n: Vec3): RGB => scaleRgb(col, 0.9 + 0.16 * Math.max(0, n[1]) - 0.12 * Math.max(0, -n[1]));
  b.withFlags({ cls: MAT.wood }, () => {
    for (let k = 0; k < tops.length - 1; k++) {
      const t0 = tops[k]!, t1 = tops[k + 1]!, b0 = bots[k]!, b1 = bots[k + 1]!;
      const up = norm3(sub3(add3(t0, t1), add3(b0, b1)));
      const c = paint([0, 0, 0]);
      const cTop = paint(up);
      faceOut(b, [outer(t0), outer(t1), outer(b1), outer(b0)], out, c);
      faceOut(b, [inner(t0), inner(t1), inner(b1), inner(b0)], scale3(out, -1), scaleRgb(c, 0.8));
      faceOut(b, [inner(t0), inner(t1), outer(t1), outer(t0)], up, cTop);
      faceOut(b, [inner(b0), inner(b1), outer(b1), outer(b0)], scale3(up, -1), scaleRgb(c, 0.7));
    }
    for (const [k, dirSign] of [[0, -1], [tops.length - 1, 1]] as const) {
      const t = tops[k]!, bb = bots[k]!;
      const nb = tops[k - dirSign] ?? t;
      const along = norm3(sub3(t, nb));
      faceOut(b, [outer(t), inner(t), inner(bb), outer(bb)], along, scaleRgb(col, 0.68));
    }
  });
}

// --- Dormers -----------------------------------------------------------------------------------------------------------

export interface DormerSpec {
  /** Position along the ridge (roof frame s) and the slope: +1 the slope toward the frame's +z, −1 the other. */
  s: number;
  side: 1 | -1;
  /** Distance of the front wall from the ridge (default 0.8 of the half span). */
  q?: number;
  /** Width of the front wall (default 2.0), its height above the roof at the front (default 1.55). */
  width?: number;
  height?: number;
  /** Pitch of the dormer roof as rise per half span (default 1.05). */
  pitch?: number;
  /** The window (default a square window with a cross, glowing). */
  window?: Partial<WindowOptions> | false;
  /** Shingle options of the dormer roof. */
  shingles?: ShingleOptions;
}

interface DormerGeom {
  qf: number;
  yb: number;
  yt: number;
  width: number;
  rise: number;
  qBack: number;
}

function dormerGeom(shape: RoofShape, d: DormerSpec): DormerGeom {
  const width = d.width ?? 2.0;
  const qf = d.side * (d.q ?? shape.halfD * 0.8);
  const ys = [-0.5, 0, 0.5].map((k) => shape.y(d.s + k * width, qf));
  const yb = Math.min(...ys) - 0.15;
  const yt = Math.max(...ys) + (d.height ?? 1.55);
  const rise = (d.pitch ?? 1.05) * (width / 2 + 0.12);
  // Where the main roof reaches the dormer's ridge.
  let qBack = 0;
  for (let k = 0; k <= 60; k++) {
    const q = qf * (1 - k / 60);
    if (shape.y(d.s, q) + shape.cover >= yt + rise + 0.15) {
      qBack = q;
      break;
    }
  }
  return { qf, yb, yt, width, rise, qBack };
}

/** The region of the main roof a dormer covers (pass it to `buildRoof` as a hole). */
export function dormerHole(shape: RoofShape, d: DormerSpec): RoofHole {
  const g = dormerGeom(shape, d);
  const qa = Math.min(g.qf, g.qBack), qb = Math.max(g.qf, g.qBack);
  return { s0: d.s - g.width / 2 - 0.08, s1: d.s + g.width / 2 + 0.08, q0: qa - 0.02, q1: qb + 0.02 };
}

/** Builds a dormer on a roof shape (call `buildRoof` with its `dormerHole`). */
export function dormer(site: Site, shape: RoofShape, d: DormerSpec): void {
  const g = dormerGeom(shape, d);
  site.at(shape.m, (r) => {
    const W = g.width;
    // The dormer's roof: ridge along q, the front end a gable, the back end runs into the main roof.
    const length = Math.abs(g.qf - g.qBack);
    const zc = (g.qf + g.qBack) / 2;
    const front = d.side > 0 ? 1 : 0;
    const ds = roofShape({
      x: d.s,
      z: zc,
      y: g.yt,
      axis: 'z',
      length,
      span: W + 0.2,
      rise: g.rise,
      eave: 0.32,
      gable: front === 1 ? [0, 0.35] : [0.35, 0],
      ends: front === 1 ? ['open', 'gable'] : ['gable', 'open'],
      sag: 0.06,
      flare: 0.25,
      curl: 0.2,
      dip: 0.03,
    });
    buildRoof(r, ds, { shingles: { exposure: 0.36, width: [0.42, 0.58], ...d.shingles }, rafters: false });
    // Front wall: plaster up into the gable, a timber frame and the window.
    const a: [number, number] = d.side > 0 ? [d.s - W / 2, g.qf] : [d.s + W / 2, g.qf];
    const bb: [number, number] = d.side > 0 ? [d.s + W / 2, g.qf] : [d.s - W / 2, g.qf];
    const wall = wallFrame(a, bb, g.yb);
    const xOf = (u: number): number => a[0] + (bb[0] - a[0]) * (u / W);
    const top = (u: number): number => ds.underside(...([xOf(u), g.qf + d.side * 0.01] as const)) - g.yb;
    const hWall = g.yt - g.yb;
    const roofFront = Math.max(...[0, W / 2, W].map((u) => shape.y(xOf(u), g.qf))) - g.yb;
    const winH = Math.max(0.6, Math.min(1.15, hWall - roofFront - 0.5));
    const wo: WindowOptions = { shape: 'square', u: W / 2, v: roofFront + 0.22, w: Math.min(1.0, W - 0.9), h: winH, sill: true, ...(d.window || {}) };
    const opening = d.window === false ? [] : [windowOpening(wo)];
    r.onWall(wall, (w) => {
      plasterPanel(w, { height: hWall + g.rise + 0.5, top, breaks: [W / 2], to: W, openings: opening, cell: 0.4, footDark: 0 });
      frameInWall(w, W, { height: hWall, openings: opening, width: 0.3, corner: 0.36, rail: false, braces: 'none', cornerEnd: true, sill: false, plateOverhang: [0.2, 0.2] });
      // King post in the gable.
      timber(w, [W / 2, hWall - 0.05, -0.04], [W / 2, top(W / 2) - 0.05, -0.04], { width: 0.26, depth: 0.24, sag: 0 });
      if (d.window !== false) windowAt(w, wo);
    });
    // Cheeks: triangles from the front wall back to where the main roof meets the dormer's eaves.
    for (const sx of [-1, 1]) {
      const x = d.s + sx * (W / 2);
      let qc = g.qf;
      for (let k = 0; k <= 40; k++) {
        const q = g.qf * (1 - k / 40);
        if (shape.y(x, q) >= g.yt) {
          qc = q;
          break;
        }
        qc = q;
      }
      const yf = shape.y(x, g.qf) - 0.05;
      const pts: Vec3[] = [[x, yf, g.qf], [x, g.yt, g.qf], [x, g.yt, qc]];
      const col = (p: Vec3): RGB => mixRgb(site.pal.plaster, site.pal.plasterWarm, 0.3 + 0.3 * Math.sin(p[1] * 3 + p[2]));
      r.b.withFlags({ cls: MAT.plaster }, () => faceOut(r.b, pts, [sx, 0, 0], pts.map(col)));
      // Edge timber along the top of the cheek.
      timber(r, [x, g.yt - 0.1, g.qf + d.side * 0.05], [x, g.yt - 0.1, qc], { width: 0.24, depth: 0.22, sag: 0 });
    }
  });
}

/** The site y of a roof's top covering under every corner of a rectangle (lowest), for things that rise through it. */
export function roofLowAt(shape: RoofShape, x: number, z: number, w: number, d: number): number {
  let lo = Infinity;
  for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]] as const) lo = Math.min(lo, shape.heightAt(x + (a * w) / 2, z + (c * d) / 2));
  return lo;
}

