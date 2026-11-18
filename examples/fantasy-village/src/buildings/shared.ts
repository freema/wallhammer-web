// Shared helpers of the buildings beyond the inn (owner: buildings): what the architecture kit (src/arch) does not have
// and the cottages, the forge, the mill and the windmill need. Everything writes into a `Site` of the kit, so lights,
// particles and transforms work the same way as there.
//
//   leanToRoof    a single-slope shingle roof (annexes, porches, the forge's lean-to): deck, underside, rafters,
//                 a sagging eave with a fascia, staggered rows of single shingles (the kit's `shingle`)
//   thatchRoof    a thatch covering over any `RoofShape` of the kit: thick courses of straw with ragged butt edges,
//                 a heavy rounded eave, bundles of varied straw, moss patches, a ridge roll held by liggers and spars
//   gableInfill   plaster and gable timbers under a roof shape (for bodies whose roof is not built by `buildHouse`)
//   stoneWall     a wall of big coursed blocks in a wall frame with openings (lintels, sills, arch cut-outs) and an
//                 optional ground line under it (blocks buried in the ground are left out)
//   plankWall     vertical plank cladding with gaps for openings
//   spin34        an allocation-free rotation matrix for the turning parts (wheel, sails)
//   finish        bakes the ambient occlusion of a finished building over a cached ground
//   structureSolids  the walls a walking figure bumps into (walk mode): one prism per footprint ring

import { valueNoise2 } from 'wallhammer-web/gen-core';
import type { BuildContext, Mat34, RGB, SolidDef, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, add3, meshTop, ringSolid, bakeAo, clamp, cross3, groundAo, lerp, mixRgb, norm3, scale3, scaleRgb, sub3, sweep, tube } from '../kit/index.ts';
import type { Opening, Rect, RoofHole, RoofShape, Side, Site, Wall } from '../arch/index.ts';
import { buildRoof, cachedGround, faceOut, plasterPanel, planks, rectWalls, shingle, stoneBlock, timber, wallPoint } from '../arch/index.ts';
import type { WindowOptions } from '../arch/index.ts';
import { windowAt, windowOpening } from '../arch/index.ts';
import type { Structure } from '../layout.ts';
import { toWorld } from '../layout.ts';

// --- Finishing ---------------------------------------------------------------------------------------------------------

/** Bakes the occlusion of a finished building (voxel AO with the terrain, then contact darkening at the ground). */
export function finish(ctx: BuildContext, s: Structure, b: MeshBuilder, half = 16, rays = 12, cell = 0.2, reach = 2.2): void {
  const ground = cachedGround(ctx.heightAt, s.x - half, s.z - half, s.x + half, s.z + half, 0.5);
  bakeAo(b, { ground, cell, rays, reach });
  groundAo(b, ground, 1.0, 0.35);
}

/**
 * Solids of a closed structure for the walk mode: a prism over every footprint ring (body and wings), from 3 m below
 * the pad up to the highest vertex of its mesh, so neither a body nor the camera gets inside.
 */
export function structureSolids(ctx: BuildContext, s: Structure, b: MeshBuilder): SolidDef[] {
  const pad = ctx.field.padY(s.id);
  const top = Math.max(pad + 3, meshTop(b));
  return s.footprints.map((ring) => ringSolid(s.id, ring, pad - 3, top, { standable: false }));
}

// --- Small geometry ----------------------------------------------------------------------------------------------------

/** A quad of four points with per-vertex normals and colours, wound so its face agrees with the normals. */
export function smoothQuad(b: MeshBuilder, p: readonly Vec3[], n: readonly Vec3[], c: readonly RGB[]): void {
  const g = cross3(sub3(p[1]!, p[0]!), sub3(p[2]!, p[0]!));
  const avg = add3(add3(n[0]!, n[1]!), add3(n[2]!, n[3]!));
  const i0 = b.vertex(p[0]!, n[0]!, c[0]!);
  const i1 = b.vertex(p[1]!, n[1]!, c[1]!);
  const i2 = b.vertex(p[2]!, n[2]!, c[2]!);
  const i3 = b.vertex(p[3]!, n[3]!, c[3]!);
  if (g[0] * avg[0] + g[1] * avg[1] + g[2] * avg[2] >= 0) {
    b.tri(i0, i1, i2);
    b.tri(i0, i2, i3);
  } else {
    b.tri(i0, i2, i1);
    b.tri(i0, i3, i2);
  }
}

/** A thin flat sheet seen from both sides (cloth, water sheets): the quad and its mirror with flipped normals. */
export function twoSided(b: MeshBuilder, p: readonly Vec3[], n: Vec3, c: RGB | readonly RGB[], back?: RGB): void {
  const cols = Array.isArray(c[0]) ? (c as readonly RGB[]) : [c as RGB, c as RGB, c as RGB, c as RGB];
  smoothQuad(b, p, [n, n, n, n], cols);
  const m: Vec3 = [-n[0], -n[1], -n[2]];
  const bc = back ? [back, back, back, back] : cols;
  smoothQuad(b, p, [m, m, m, m], bc);
}

/**
 * Allocation-free transform for spinning parts: translation `t`, then yaw, pitch and roll exactly as `compose34`
 * (roll first, about the part's local z). Written into `out`.
 */
export function spin34(out: Mat34, tx: number, ty: number, tz: number, yaw: number, pitch: number, roll: number): Mat34 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  out[0] = cy * cr + sy * sp * sr;
  out[1] = cp * sr;
  out[2] = -sy * cr + cy * sp * sr;
  out[3] = -cy * sr + sy * sp * cr;
  out[4] = cp * cr;
  out[5] = sy * sr + cy * sp * cr;
  out[6] = sy * cp;
  out[7] = -sp;
  out[8] = cy * cp;
  out[9] = tx;
  out[10] = ty;
  out[11] = tz;
  return out;
}

// --- Lean-to roof ------------------------------------------------------------------------------------------------------

export interface LeanToOptions {
  /** Extent along the site x (eave direction), overhangs included. */
  x0: number;
  x1: number;
  /** The high edge (against a wall) and the low edge (the eave), site z and y. */
  zHigh: number;
  yHigh: number;
  zLow: number;
  yLow: number;
  /** Sag of the eave in the middle (default 0.08). */
  sag?: number;
  /** Shingle colour and accents (default the palette's roof). */
  color?: RGB;
  accents?: readonly RGB[];
  /** Shingle width range, exposure and thickness (defaults [0.5, 0.68], 0.4, 0.08). */
  width?: readonly [number, number];
  exposure?: number;
  thick?: number;
  /** Parts (default true). */
  rafters?: boolean;
  fascia?: boolean;
  ledger?: boolean;
}

/** A single-slope shingle roof in the current frame (the slope runs along z, the eave along x). */
export function leanToRoof(site: Site, o: LeanToOptions): void {
  const b = site.b, s = site.s, pal = site.pal;
  const sag = o.sag ?? 0.08;
  const len = o.x1 - o.x0;
  const dy = o.yHigh - o.yLow, dz = o.zHigh - o.zLow;
  const slopeLen = Math.hypot(dy, dz);
  const P = (x: number, t: number): Vec3 => {
    const f = clamp((x - o.x0) / len, 0, 1);
    const dip = sag * Math.sin(Math.PI * f) * (1 - 0.7 * clamp(t, 0, 1));
    return [x, o.yLow + dy * t - dip, o.zLow + dz * t];
  };
  // Outward (up) normal of the plane; the downslope direction on the ground.
  const N0: Vec3 = norm3(dz < 0 ? [0, -dz, dy] : [0, dz, -dy]);
  const down: Vec3 = [0, 0, -Math.sign(dz) || 1];
  const off = (p: Vec3, k: number): Vec3 => [p[0] + N0[0] * k, p[1] + N0[1] * k, p[2] + N0[2] * k];
  const T = 0.13;
  // --- Deck and underside ---
  const nx = Math.max(2, Math.ceil(len / 0.6));
  const nt = 3;
  const xs = (i: number): number => o.x0 + (len * i) / nx;
  b.withFlags({ cls: MAT.wood }, () => {
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nt; j++) {
        const t0 = j / nt, t1 = (j + 1) / nt;
        const q = [P(xs(i), t0), P(xs(i + 1), t0), P(xs(i + 1), t1), P(xs(i), t1)];
        faceOut(b, q.map((p) => off(p, -0.02)), N0, pal.roofDeck);
        faceOut(b, q.map((p) => off(p, -T)), scale3(N0, -1), scaleRgb(pal.roofUnder, lerp(0.75, 1.0, t0)));
      }
      // Eave edge.
      const e = [P(xs(i), 0), P(xs(i + 1), 0)];
      faceOut(b, [off(e[0]!, -0.02), off(e[1]!, -0.02), off(e[1]!, -T), off(e[0]!, -T)], down, scaleRgb(pal.roofUnder, 0.85));
    }
    // Verges.
    for (const [x, sx] of [[o.x0, -1], [o.x1, 1]] as const) {
      for (let j = 0; j < nt; j++) {
        const a = P(x, j / nt), c = P(x, (j + 1) / nt);
        faceOut(b, [off(a, -0.02), off(c, -0.02), off(c, -T), off(a, -T)], [sx, 0, 0], scaleRgb(pal.roofUnder, 0.85));
      }
    }
  });
  // --- Rafters, ledger, fascia ---
  const under = T + 0.08;
  if (o.rafters !== false) {
    const n = Math.max(2, Math.round(len / 0.9));
    for (let k = 0; k <= n; k++) {
      const x = lerp(o.x0 + 0.18, o.x1 - 0.18, k / n);
      timber(site, off(P(x, 1.0), -under), off(P(x, -0.02), -under), { width: 0.13, depth: 0.15, sag: 0, wobble: 0.01, color: pal.timberDark, up: N0 });
    }
  }
  if (o.ledger !== false) timber(site, off(P(o.x0, 0.97), -under - 0.1), off(P(o.x1, 0.97), -under - 0.1), { width: 0.2, depth: 0.2, sag: 0, color: pal.timberDark });
  if (o.fascia !== false) timber(site, off(P(o.x0 - 0.05, 0), -0.12), off(P(o.x1 + 0.05, 0), -0.12), { width: 0.1, depth: 0.22, sag: sag * 0.9, wobble: 0.01, color: pal.timber, up: N0 });
  // --- Shingles ---
  const [w0, w1] = o.width ?? [0.5, 0.68];
  const expo = o.exposure ?? 0.4;
  const thick = o.thick ?? 0.08;
  const base = o.color ?? pal.roof;
  const accents = o.accents ?? pal.roofAccents;
  const seed = (s.next() * 1e6) | 0;
  b.withFlags({ cls: MAT.roof }, () => {
    for (let row = 0; ; row++) {
      const aBase = row * expo - 0.06;
      if (aBase > slopeLen - 0.12) break;
      let sa = o.x0 - 0.04 - (row % 2 === 1 ? (w0 + w1) / 4 : 0) - s.nextRange(0, 0.1);
      while (sa < o.x1 + 0.03) {
        let width = s.nextRange(w0, w1);
        if (o.x1 + 0.04 - (sa + width) < 0.2) width = o.x1 + 0.04 - sa;
        const a = Math.max(sa, o.x0 - 0.04), c = Math.min(sa + width, o.x1 + 0.04);
        sa += width;
        if (c - a < 0.15) continue;
        const sc = (a + c) / 2;
        const aBot = aBase + s.nextJitter(row === 0 ? 0.06 : 0.03);
        const aTop = Math.min(slopeLen + 0.05, aBot + expo * s.nextRange(1.75, 2.0));
        const tb = aBot / slopeLen, tt = aTop / slopeLen;
        const Pb = P(sc, tb), Pt = P(sc, tt);
        let U = norm3(sub3(Pt, Pb));
        let R = norm3(sub3(P(sc + 0.1, tb), P(sc - 0.1, tb)));
        let N = norm3(cross3(R, U));
        if (N[1] < 0) {
          N = scale3(N, -1);
          R = scale3(R, -1);
        }
        U = cross3(N, R);
        const rot = s.next() < 0.07 ? s.nextRange(0.08, 0.2) * (s.next() < 0.5 ? -1 : 1) : s.nextJitter(0.03);
        const R2 = add3(scale3(R, Math.cos(rot)), scale3(U, Math.sin(rot)));
        const U2 = sub3(scale3(U, Math.cos(rot)), scale3(R, Math.sin(rot)));
        let col: RGB = s.next() < 0.22 && accents.length ? accents[s.nextInt(0, accents.length - 1)]! : base;
        col = site.tone(col, { hue: 0.012, sat: 0.12, val: 0.14 });
        col = scaleRgb(col, 0.88 + 0.24 * valueNoise2(sc, aBot, 2.4, seed));
        const L = Math.hypot(Pt[0] - Pb[0], Pt[1] - Pb[1], Pt[2] - Pb[2]);
        shingle(b, Pb, R2, U2, N, c - a - 0.03, L, thick, (row === 0 ? 0.6 : 0.95) * thick, col);
      }
    }
  });
}

// --- Thatch ------------------------------------------------------------------------------------------------------------

export interface ThatchOptions {
  /** Regions without thatch (chimneys), in the roof frame (see `roofHoleFor`). */
  holes?: readonly RoofHole[];
  /** Base thickness above the deck (default 0.16) and the extra thickness of each course's butt (default 0.16). */
  thick?: number;
  butt?: number;
  /** Course length along the slope (default 0.4). */
  course?: number;
  /** Straw colour (default the palette's roof) and its accents (default the palette's accents). */
  color?: RGB;
  accents?: readonly RGB[];
}

/**
 * A thatch covering over a roof shape: the kit's deck, underside and rafters (no shingles, caps or bargeboards),
 * then the straw in courses from the eave up, a ridge roll with liggers and spars.
 */
export function thatchRoof(site: Site, shape: RoofShape, o: ThatchOptions = {}): void {
  const all: RoofHole = { s0: shape.s0 - 2, s1: shape.s1 + 2, q0: -shape.qMax - 2, q1: shape.qMax + 2 };
  buildRoof(site.child('deck'), shape, { holes: [all], ridgeCaps: false, bargeboards: false });
  site.at(shape.m, (r) => thatchInFrame(r.child('thatch'), shape, o));
}

const MOSS: RGB = [0.36, 0.38, 0.2];

function thatchInFrame(site: Site, shape: RoofShape, o: ThatchOptions): void {
  const b = site.b, st = site.s, pal = site.pal;
  const { s0, s1, qMax } = shape;
  const y = shape.y;
  const T0 = o.thick ?? 0.16, D = o.butt ?? 0.16, Deave = D + 0.12;
  const course = o.course ?? 0.4;
  const holes = o.holes ?? [];
  const base = o.color ?? pal.roof;
  const accents = o.accents ?? pal.roofAccents;
  const seed = (st.next() * 1e6) | 0;
  // Arc length from the eave inward along a slope (at s = 0), and back to q (beyond the eave and over the ridge too).
  const steps = 160;
  const arc: number[] = [0];
  for (let k = 1; k <= steps; k++) {
    const qa = qMax * (1 - (k - 1) / steps), qb = qMax * (1 - k / steps);
    arc.push(arc[k - 1]! + Math.hypot(qa - qb, y(0, qa) - y(0, qb)));
  }
  const total = arc[steps]!;
  const qOfArc = (a: number): number => {
    if (a <= 0) return qMax - a;
    if (a >= total) return -(a - total);
    let lo = 0, hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arc[mid]! < a) lo = mid;
      else hi = mid;
    }
    const t = (a - arc[lo]!) / (arc[hi]! - arc[lo]! || 1);
    return qMax * (1 - (lo + t) / steps);
  };
  const nrm = (ss: number, q: number): Vec3 => {
    const e = 0.04;
    const dys = (y(ss + e, q) - y(ss - e, q)) / (2 * e);
    const dyq = (y(ss, q + e) - y(ss, q - e)) / (2 * e);
    return norm3([-dys, 1, -dyq]);
  };
  const pt = (ss: number, q: number, t: number): Vec3 => {
    const n = nrm(ss, q);
    return [ss + n[0] * t, y(ss, q) + n[1] * t, q + n[2] * t];
  };
  const inHole = (ss: number, q: number): boolean => holes.some((h) => ss > h.s0 && ss < h.s1 && q > h.q0 && q < h.q1);
  // Columns along the ridge, a little past the deck at both gables.
  const S0 = s0 - 0.12, S1 = s1 + 0.12;
  const ns = Math.max(4, Math.ceil((S1 - S0) / 0.26));
  const sAt = (i: number): number => S0 + ((S1 - S0) * i) / ns;
  const nC = Math.max(2, Math.ceil(total / course));
  const FS = [0, 0.45, 1];
  b.withFlags({ cls: MAT.roof }, () => {
    for (const sg of [-1, 1] as const) {
      // Course edges (arc), ragged per column; shared by the top of one course and the butt of the next.
      const edge = (c: number, i: number): number => {
        if (c <= 0) return -0.16 + st.jitter(0.07, sg + 3, 0, i);
        if (c >= nC) return total + 0.1;
        return (c * total) / nC + st.jitter(0.05, sg + 3, c, i);
      };
      const qAt = (c: number, f: number, i: number): number => sg * qOfArc(lerp(edge(c, i), edge(c + 1, i), f));
      const thick = (c: number, f: number, i: number): number => {
        const bump = (valueNoise2(sAt(i) * 1.3, c * 1.7 + sg * 9, 1.0, seed) - 0.5) * 0.07;
        const top = c >= nC - 1 ? 0.6 : 1;
        return T0 + (c === 0 ? Deave : D * top) * Math.pow(1 - f, 0.8) + bump;
      };
      // Colour of a bundle (course c, column i) at share f up the course.
      const bundle = (c: number, i: number): RGB => {
        const accent = st.float(sg + 3, c, i, 1) < 0.24 && accents.length ? accents[st.int(0, accents.length - 1, sg + 3, c, i, 2)]! : base;
        const streak = 0.93 + 0.14 * st.float(sg + 3, i, 3);
        let col = scaleRgb(accent, streak * (0.86 + 0.26 * valueNoise2(sAt(i), c * course, 1.8, seed + 1)));
        const moss = Math.max(0, valueNoise2(sAt(i), c * course, 2.6, seed + 2) - 0.55) * 2.2 * (c <= 1 ? 1 : 0.5);
        col = mixRgb(col, MOSS, clamp(moss, 0, 0.55));
        return col;
      };
      const shade = (col: RGB, f: number): RGB => scaleRgb(col, lerp(1.1, 0.8, f));
      for (let c = 0; c < nC; c++) {
        for (let i = 0; i < ns; i++) {
          const sa = sAt(i), sb = sAt(i + 1);
          const qc = qAt(c, 0.5, i);
          if (inHole((sa + sb) / 2, qc)) continue;
          const colA = bundle(c, i), colB = bundle(c, i + 1);
          // Surface strips of the course.
          for (let k = 0; k < FS.length - 1; k++) {
            const f0 = FS[k]!, f1 = FS[k + 1]!;
            const qa0 = qAt(c, f0, i), qb0 = qAt(c, f0, i + 1), qb1 = qAt(c, f1, i + 1), qa1 = qAt(c, f1, i);
            const p = [pt(sa, qa0, thick(c, f0, i)), pt(sb, qb0, thick(c, f0, i + 1)), pt(sb, qb1, thick(c, f1, i + 1)), pt(sa, qa1, thick(c, f1, i))];
            // Normals tip down-slope at the butt (a rounded course).
            const tip = (ss: number, q: number, f: number): Vec3 => {
              const n = nrm(ss, q);
              const dn = (1 - f) * 0.45;
              return norm3([n[0], n[1] - dn * 0.3, n[2] + sg * dn]);
            };
            const n = [tip(sa, qa0, f0), tip(sb, qb0, f0), tip(sb, qb1, f1), tip(sa, qa1, f1)];
            smoothQuad(b, p, n, [shade(colA, f0), shade(colB, f0), shade(colB, f1), shade(colA, f1)]);
          }
          // The butt: from the course below (or the deck at the eave) out to this course's thick lower edge.
          const qa = qAt(c, 0, i), qb = qAt(c, 0, i + 1);
          const innerA = c === 0 ? -0.05 : thick(c - 1, 1, i) - 0.02;
          const innerB = c === 0 ? -0.05 : thick(c - 1, 1, i + 1) - 0.02;
          const bp = [pt(sa, qa, innerA), pt(sb, qb, innerB), pt(sb, qb, thick(c, 0, i + 1)), pt(sa, qa, thick(c, 0, i))];
          const downA = norm3(add3(scale3(nrm(sa, qa), 0.35), [0, -0.25, sg]));
          const downB = norm3(add3(scale3(nrm(sb, qb), 0.35), [0, -0.25, sg]));
          const dark = (col: RGB, k: number): RGB => scaleRgb(mixRgb(col, [0.45, 0.33, 0.18], 0.35), k);
          smoothQuad(b, bp, [downA, downB, downB, downA], [dark(colA, 0.62), dark(colB, 0.62), dark(colB, 0.9), dark(colA, 0.9)]);
          // Under the eave: from the deck's eave edge to the bottom of the first butt.
          if (c === 0) {
            const qe = sg * qMax;
            const up: Vec3 = scale3(nrm(sa, qe), -1);
            const ub: Vec3 = scale3(nrm(sb, qe), -1);
            smoothQuad(b, [pt(sa, qe, -shape.deck), pt(sb, qe, -shape.deck), bp[1]!, bp[0]!], [up, ub, ub, up], [dark(colA, 0.45), dark(colB, 0.45), dark(colB, 0.55), dark(colA, 0.55)]);
          }
        }
        // Gable edges of the course: the cut straw seen from the gable side.
        for (const [i, sx] of [[0, -1], [ns, 1]] as const) {
          const ss = sAt(i);
          const col = scaleRgb(bundle(c, i), 0.7);
          for (let k = 0; k < FS.length - 1; k++) {
            const f0 = FS[k]!, f1 = FS[k + 1]!;
            const q0 = qAt(c, f0, i), q1 = qAt(c, f1, i);
            const lo = c === 0 ? -shape.deck : -0.04;
            faceOut(b, [pt(ss, q0, lo), pt(ss, q1, lo), pt(ss, q1, thick(c, f1, i)), pt(ss, q0, thick(c, f0, i))], [sx, 0, 0], col);
          }
        }
      }
    }
    // Ridge roll: a thick rounded bundle along the ridge.
    const path: Vec3[] = [];
    for (let k = 0; k <= 20; k++) {
      const ss = lerp(S0 - 0.05, S1 + 0.05, k / 20);
      path.push([ss, y(ss, 0) + T0 + 0.05, 0]);
    }
    const prof: [number, number][] = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      prof.push([Math.cos(a) * 0.5, Math.sin(a) * 0.3]);
    }
    const rollCol = scaleRgb(mixRgb(base, [0.55, 0.42, 0.24], 0.3), 0.95);
    sweep(b, path, prof, (p, n) => scaleRgb(rollCol, (0.82 + 0.22 * Math.max(0, n[1])) * (0.9 + 0.2 * valueNoise2(p[0], p[2], 0.7, seed + 5))), { closed: true, caps: true, up: [0, 1, 0] });
  });
  // Liggers along the roll's flanks and spars crossing between them (hazel rods).
  const rod: RGB = [0.5, 0.38, 0.24];
  const surf = (ss: number, q: number, lift: number): Vec3 => [ss, y(ss, q) + T0 + lift, q];
  b.withFlags({ cls: MAT.wood }, () => {
    for (const sg of [-1, 1]) {
      for (const [q, lift] of [[0.5, 0.16], [0.9, 0.1]] as const) {
        const path: Vec3[] = [];
        for (let k = 0; k <= 16; k++) path.push(surf(lerp(S0 + 0.05, S1 - 0.05, k / 16), sg * q, lift));
        tube(b, path, () => 0.03, scaleRgb(rod, 0.9 + 0.1 * sg), { sides: 4, caps: true });
      }
      const n = Math.max(2, Math.round((S1 - S0) / 0.42));
      for (let k = 0; k < n; k++) {
        const sa = lerp(S0 + 0.1, S1 - 0.1, k / n), sb = lerp(S0 + 0.1, S1 - 0.1, (k + 1) / n);
        const [a, c] = k % 2 === 0 ? [surf(sa, sg * 0.5, 0.17), surf(sb, sg * 0.9, 0.11)] : [surf(sa, sg * 0.9, 0.11), surf(sb, sg * 0.5, 0.17)];
        tube(b, [a, c], () => 0.022, rod, { sides: 4, caps: false });
      }
    }
  });
}

// --- Gable infill ------------------------------------------------------------------------------------------------------

/** Plaster up to a roof's underside on a gable wall, a king post, collar and struts, and gable windows. */
export function gableInfill(site: Site, shape: RoofShape, rect: Rect, eaveY: number, side: Side, windows: readonly (Omit<WindowOptions, 'u' | 'v'> & { at: number; v?: number })[] = [], bottom = 0): void {
  const wall = rectWalls(rect, eaveY)[side];
  const L = wall.length;
  const topAt = (u: number): number => {
    const p = wallPoint(wall, Math.min(L, Math.max(0, u)), 0);
    return shape.underside(p[0], p[2]) - eaveY;
  };
  const ws: WindowOptions[] = windows.map((w) => ({ ...w, u: L / 2 + w.at, v: w.v ?? 0.5 }));
  const ops = ws.map(windowOpening);
  const rise = topAt(L / 2);
  site.onWall(wall, (w) => {
    plasterPanel(w, { height: rise + 0.2, top: topAt, breaks: [L / 2], to: L, openings: ops, footDark: 0, cell: 0.55, bottom });
    const wc = -0.04;
    const free = (u: number, v: number): boolean => !ops.some((q) => u > q.u0 - 0.3 && u < q.u1 + 0.3 && v > q.v0 - 0.3 && v < q.v1 + 0.3);
    if (free(L / 2, rise * 0.5)) timber(w, [L / 2, 0.1, wc], [L / 2, rise - 0.05, wc], { width: 0.34, depth: 0.28, sag: 0 });
    const cv = rise * 0.45;
    let ua = 0;
    while (ua < L / 2 && topAt(ua) < cv + 0.2) ua += 0.05;
    if (L / 2 - ua > 0.6 && !ops.some((q) => q.v0 < cv + 0.2 && q.v1 > cv - 0.2)) timber(w, [ua - 0.1, cv, wc + 0.01], [L - ua + 0.1, cv, wc + 0.01], { width: 0.3, depth: 0.28, sag: 0.03 });
    for (const sx of [-1, 1]) {
      const ub = L / 2 + sx * (L / 2 - ua) * 0.85;
      if (free(lerp(ub, L / 2, 0.5), cv * 0.5)) timber(w, [ub, 0.15, wc - 0.01], [L / 2 + sx * 0.25, cv - 0.1, wc - 0.01], { width: 0.26, depth: 0.26, sag: 0 });
    }
    for (const [u0, u1] of [[0.05, L / 2], [L - 0.05, L / 2]] as const) timber(w, [u0, topAt(u0) - 0.18, wc], [u1, topAt(u1) - 0.2, wc], { width: 0.26, depth: 0.26, sag: 0.02 });
    for (const q of ws) windowAt(w.child('gwin'), q);
  });
}

// --- Stone walls -------------------------------------------------------------------------------------------------------

/** An opening of a stone wall; `arch` cuts the blocks round a semicircular head (doors with a stone arch). */
export interface StoneOpening extends Opening {
  arch?: { u: number; spring: number; r: number };
  /** Lintel stone over a square opening (default true without an arch) and a sill stone under it (default false). */
  lintel?: boolean;
  sill?: boolean;
}

export interface StoneWallOptions {
  /** Range along the wall (default 0 to the wall length). */
  from?: number;
  to?: number;
  /** Bottom and top of the masonry (v), or shared course boundaries from the bottom up (corners line up). */
  bottom: number;
  top: number;
  courses?: readonly number[];
  openings?: readonly StoneOpening[];
  /** Block thickness (default 0.62) and how far the blocks stand out of the wall line (default 0.14). */
  depth?: number;
  proud?: number;
  /** Block length range (default [0.6, 1.05]). */
  block?: readonly [number, number];
  /** Index of the wall in its outline: alternates the corner bonding (quoins) with the neighbours. */
  edge?: number;
  /** Bond into a corner at the start / end (default true). */
  cornerStart?: boolean;
  cornerEnd?: boolean;
  /** Ground height (v) along the wall: blocks entirely below it (by 0.3 m) are left out. */
  ground?: (u: number) => number;
  /** Base colour of the blocks (default the palette's stones per block). */
  color?: RGB;
}

/** Course boundaries from `bottom` to `top` (shared between the walls of one outline so the corners line up). */
export function stoneCourses(site: Site, bottom: number, top: number, range: readonly [number, number] = [0.38, 0.56]): number[] {
  const total = top - bottom;
  const n = Math.max(1, Math.round(total / ((range[0] + range[1]) / 2)));
  const ys = [bottom];
  for (let k = 1; k < n; k++) ys.push(bottom + (total * k) / n + site.s.nextJitter(0.05));
  ys.push(top);
  return ys;
}

/** A coursed wall of big blocks in the current wall frame (u along, v up, w out). */
export function stoneWall(site: Site, o: StoneWallOptions): void {
  const from = o.from ?? 0, to = o.to ?? 0;
  const depth = o.depth ?? 0.62, proud = o.proud ?? 0.14;
  const [l0, l1] = o.block ?? [0.6, 1.05];
  const ys = o.courses ? o.courses.filter((v) => v >= o.bottom - 1e-6 && v <= o.top + 1e-6) : stoneCourses(site, o.bottom, o.top);
  if (ys[0]! > o.bottom + 1e-6) ys.unshift(o.bottom);
  if (ys[ys.length - 1]! < o.top - 1e-6) ys.push(o.top);
  const ops = o.openings ?? [];
  const e = o.edge ?? 0;
  // Intervals of [a, b] left free by the openings in the course y0..y1.
  const cut = (a: number, b: number, y0: number, y1: number): [number, number][] => {
    let free: [number, number][] = [[a, b]];
    const remove = (c0: number, c1: number): void => {
      const next: [number, number][] = [];
      for (const [p, q] of free) {
        if (c1 <= p || c0 >= q) next.push([p, q]);
        else {
          if (c0 > p) next.push([p, c0]);
          if (c1 < q) next.push([c1, q]);
        }
      }
      free = next;
    };
    const ym = (y0 + y1) / 2;
    for (const op of ops) {
      if (op.arch) {
        const { u, spring, r } = op.arch;
        const rr = r + 0.36;
        if (y1 > op.v0 && y0 < spring) remove(op.u0 - 0.38, op.u1 + 0.38);
        else if (y1 > spring && ym < spring + rr) {
          const dyc = Math.max(0, y0 - spring);
          const hw = Math.sqrt(Math.max(0, rr * rr - dyc * dyc));
          remove(u - hw, u + hw);
        }
        continue;
      }
      const lin = op.lintel !== false;
      const sill = op.sill === true;
      if (y1 > op.v0 - (sill ? 0.14 : 0) && y0 < op.v1) remove(op.u0 - 0.02, op.u1 + 0.02);
      if (lin && y1 > op.v1 && y0 < op.v1 + 0.3) remove(op.u0 - 0.3, op.u1 + 0.3);
      if (sill && y1 > op.v0 - 0.14 && y0 < op.v0) remove(op.u0 - 0.16, op.u1 + 0.16);
    }
    return free;
  };
  for (let k = 0; k < ys.length - 1; k++) {
    const y0 = ys[k]!, y1 = ys[k + 1]!;
    const long = (k + e) % 2 === 0;
    const start = from - (o.cornerStart === false ? 0 : long ? proud : proud - depth);
    const end = to + (o.cornerEnd === false ? 0 : long ? proud : proud - depth);
    let u = start;
    let first = k % 2 === 1 ? site.s.nextRange(l0 * 0.45, l0 * 0.8) : site.s.nextRange(l0, l1);
    while (u < end - 0.05) {
      let len = first;
      first = site.s.nextRange(l0, l1);
      if (end - (u + len) < l0 * 0.5) len = end - u;
      const a = u, b = u + len;
      u = b;
      const d = depth * site.s.nextRange(0.85, 1.05);
      const out = proud + site.s.nextJitter(0.04);
      for (const [p, q] of cut(a, b, y0, y1)) {
        if (q - p < 0.14) continue;
        const uc = (p + q) / 2;
        if (o.ground && y1 < o.ground(uc) - 0.3) continue;
        stoneBlock(site, [uc, y0 + 0.012, out - d / 2], [q - p - 0.035, y1 - y0 - 0.025, d], o.color ? { color: o.color } : {});
      }
    }
  }
  // Lintels and sills.
  for (const op of ops) {
    if (op.arch) continue;
    if (op.lintel !== false) stoneBlock(site, [(op.u0 + op.u1) / 2, op.v1 + 0.01, proud + 0.04 - depth * 0.45], [op.u1 - op.u0 + 0.58, 0.28, depth * 0.9], { bevel: 0.05 });
    if (op.sill) stoneBlock(site, [(op.u0 + op.u1) / 2, op.v0 - 0.13, proud + 0.1 - depth * 0.45], [op.u1 - op.u0 + 0.3, 0.12, depth * 0.9 + 0.12], { bevel: 0.03 });
  }
}

// --- Plank walls -------------------------------------------------------------------------------------------------------

/** Vertical plank cladding in a wall frame from `from` to `to`, `bottom` to `top(u)`, with gaps for openings. */
export function plankWall(site: Site, o: { from: number; to: number; bottom: number; top: (u: number) => number; openings?: readonly Opening[]; color?: RGB; width?: number }): void {
  const ops = o.openings ?? [];
  const cuts = [o.from, o.to, ...ops.flatMap((q) => [q.u0, q.u1])].filter((u) => u >= o.from && u <= o.to).sort((a, b) => a - b);
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k]!, c = cuts[k + 1]!;
    if (c - a < 0.05) continue;
    const mid = (a + c) / 2;
    const over = ops.filter((q) => mid > q.u0 && mid < q.u1);
    const extra = { ...(o.color ? { color: o.color } : {}), ...(o.width ? { width: o.width } : {}) };
    if (!over.length) {
      planks(site, { from: a, to: c, bottom: o.bottom, top: o.top, ...extra });
      continue;
    }
    // Below the lowest and above the highest opening over this strip.
    const v0 = Math.min(...over.map((q) => q.v0)), v1 = Math.max(...over.map((q) => q.v1));
    if (v0 - o.bottom > 0.1) planks(site, { from: a, to: c, bottom: o.bottom, top: () => v0, ...extra });
    planks(site, { from: a, to: c, bottom: v1, top: o.top, ...extra });
  }
}

/** A timber post on a stone pad from the ground to `top` (site coordinates of its foot x, z). */
export function postOnPad(site: Site, x: number, z: number, top: number, o: { width?: number; pad?: number; ground?: number } = {}): void {
  const pad = o.pad ?? 0.32;
  const g = o.ground ?? 0;
  stoneBlock(site, [x, g - 0.25, z], [0.5, pad + 0.25, 0.5], { bevel: 0.06 });
  timber(site, [x, g + pad - 0.02, z], [x + site.s.nextJitter(0.03), top, z + site.s.nextJitter(0.03)], { width: o.width ?? 0.3, depth: o.width ?? 0.3, sag: 0 });
}

/** World point of a wall's (u, v, w) under a site transform. */
export function wallWorld(site: Site, wall: Wall, u: number, v: number, w = 0): Vec3 {
  const p = wallPoint(wall, u, v, w);
  return site.world(p[0], p[1], p[2]);
}

// --- Ground ------------------------------------------------------------------------------------------------------------

/** Ground height relative to the pad at a structure-local point. */
export function localGround(ctx: BuildContext, s: Structure, padY: number): (lx: number, lz: number) => number {
  return (lx, lz) => {
    const [x, z] = toWorld(s, lx, lz);
    return ctx.heightAt(x, z) - padY;
  };
}

/** How deep the foundation of a rectangle has to reach below the pad: the lowest ground just outside it, plus a margin. */
export function foundationDepth(ground: (lx: number, lz: number) => number, r: Rect, out = 0.35, margin = 0.4): number {
  let lo = 0;
  const x0 = r.x - r.w / 2 - out, x1 = r.x + r.w / 2 + out, z0 = r.z - r.d / 2 - out, z1 = r.z + r.d / 2 + out;
  for (let k = 0; k <= 12; k++) {
    const f = k / 12;
    lo = Math.min(lo, ground(lerp(x0, x1, f), z0), ground(lerp(x0, x1, f), z1), ground(x0, lerp(z0, z1, f)), ground(x1, lerp(z0, z1, f)));
  }
  return Math.max(0.45, -lo + margin);
}
