// Templates of the repeated trees, built once around the origin (ground at y = 0, the foot reaching 0.4 m below) and
// drawn as instanced part sets: two broadleaf trees (a crooked oak-like one and a round apple tree), two stylised
// conifers (a tall fir of drooping star-shaped tiers and a ragged crooked pine), a bush, and light versions of a
// broadleaf and a conifer for the hills far out.
//
// Conifers are never cones: every tier is a star of drooping branch tips of different lengths with notches between
// them, needle tufts hanging off the tips, a darker underside, and the tiers do not shrink evenly.

import type { RGB, Stream, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, add3, bakeAo, clamp, cross3, dot3, hex, lerp, mixRgb, norm3, scale3, scaleRgb, sub3 } from '../kit/index.ts';
import { barkTube, bezier, ellipsoid, triFacing, vtx } from './common.ts';
import type { FoliageStyle } from './foliage.ts';
import { BROADLEAF, BUSH, fruits, leafCluster } from './foliage.ts';

const BARK = hex('#5e3d26');
const BARK_LIGHT = hex('#9a6c44');
const PINE_BARK = hex('#7a4a2e');
const PINE_BARK_LIGHT = hex('#b07a4e');

export type TreeTemplate = 'oak' | 'apple' | 'fir' | 'pine' | 'bush' | 'oak-far' | 'fir-far';

interface BroadleafSpec {
  forkH: number;
  r0: number;
  crownY: number;
  rh: number;
  rv: number;
  limbs: number;
  perLimb: [number, number];
  clusterR: [number, number];
  style: FoliageStyle;
  sides: number;
  roots: number;
  apples: boolean;
  lean: number;
}

const SPECS: Record<'oak' | 'apple' | 'oak-far', BroadleafSpec> = {
  oak: { forkH: 2.9, r0: 0.32, crownY: 5.2, rh: 3.3, rv: 2.2, limbs: 3, perLimb: [2, 2], clusterR: [1.2, 1.75], style: BROADLEAF, sides: 14, roots: 4, apples: false, lean: 0.5 },
  apple: { forkH: 1.7, r0: 0.25, crownY: 3.6, rh: 2.9, rv: 1.7, limbs: 3, perLimb: [2, 2], clusterR: [1.05, 1.45], style: { ...BROADLEAF, mid: hex('#5f9a36'), light: hex('#b8d058'), leafLen: 0.45, leafWidth: 0.3 }, sides: 12, roots: 3, apples: true, lean: 0.35 },
  'oak-far': { forkH: 2.9, r0: 0.32, crownY: 5.2, rh: 3.2, rv: 2.3, limbs: 3, perLimb: [1, 1], clusterR: [1.7, 2.2], style: { ...BROADLEAF, leafLen: 0.9, leafWidth: 0.6, density: 0.3, maxLeaves: 5, coreSeg: 5, coreRings: 3 }, sides: 6, roots: 0, apples: false, lean: 0.5 },
};

/** A broadleaf tree template: a twisted trunk with a few limbs and a crown of leaf clusters. */
function broadleaf(kind: 'oak' | 'apple' | 'oak-far', s: Stream): MeshBuilder {
  const sp = SPECS[kind];
  const b = new MeshBuilder();
  const far = kind === 'oak-far';
  const leanA = s.range(0, Math.PI * 2);
  const lean: Vec3 = [Math.sin(leanA) * sp.lean, 0, Math.cos(leanA) * sp.lean];
  const top: Vec3 = [lean[0], sp.forkH + 0.4, lean[2]];
  const trunk = bezier([0, -0.4, 0], [s.range(-0.25, 0.25), sp.forkH * 0.35, s.range(-0.25, 0.25)], [lean[0] * 0.3 + s.range(-0.2, 0.2), sp.forkH * 0.7, lean[2] * 0.3], top, far ? 4 : 9);
  const gs = 0.4 / (sp.forkH + 0.8);
  const trunkR = (f: number): number => {
    const above = Math.max(0, f - gs) / (1 - gs);
    return sp.r0 * lerp(1, 0.68, above) * (1 + 0.45 * (1 - clamp(above / 0.18, 0, 1)));
  };
  b.set({ cls: MAT.bark });
  barkTube(b, trunk, { sides: sp.sides, radius: trunkR, ridges: far ? 0 : 7, ridgeDepth: far ? 0 : 0.1, twist: 1.3, bark: BARK, barkLight: BARK_LIGHT, moss: far ? 0 : 0.5, foot: gs + 0.08, seed: Math.floor(s.next() * 1e6), flare: (f, a) => (far ? 0 : 0.35 * Math.pow(0.5 + 0.5 * Math.cos(4 * a), 3) * (1 - clamp((f - gs) / 0.15, 0, 1))) });
  for (let k = 0; k < sp.roots; k++) {
    const a = (k / sp.roots) * Math.PI * 2 + s.range(-0.3, 0.3);
    const L = s.range(0.9, 1.5);
    const pts: Vec3[] = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const d = lerp(sp.r0 * 0.4, L, t);
      pts.push([Math.sin(a) * d, lerp(0.35, -0.02, Math.min(1, t * 1.6)), Math.cos(a) * d]);
    }
    barkTube(b, pts, { sides: 6, radius: (f) => lerp(sp.r0 * 0.45, 0.04, f), ridges: 0, ridgeDepth: 0, twist: 0, bark: BARK, barkLight: BARK_LIGHT, moss: 0.4, foot: 0, seed: k + 11 });
  }
  const C: Vec3 = [lean[0] * 1.6, sp.crownY, lean[2] * 1.6];
  const fork = trunk[trunk.length - 2]!;
  const ends: Vec3[] = [];
  const az0 = s.range(0, Math.PI * 2);
  for (let k = 0; k <= sp.limbs; k++) {
    const leader = k === sp.limbs;
    const az = az0 + (k / sp.limbs) * Math.PI * 2 + s.range(-0.4, 0.4);
    const end: Vec3 = leader ? add3(C, [s.range(-0.4, 0.4), sp.rv * 0.5, s.range(-0.4, 0.4)]) : add3(C, [Math.sin(az) * sp.rh * 0.6, s.range(-0.9, 0.5), Math.cos(az) * sp.rh * 0.6]);
    ends.push(end);
    const path = bezier(add3(fork, [0, -0.3, 0]), add3(fork, [Math.sin(az) * 0.3, 0.9, Math.cos(az) * 0.3]), add3(scale3(add3(fork, end), 0.5), [0, 0.6, 0]), end, far ? 3 : 5);
    barkTube(b, path, { sides: far ? 5 : 7, radius: (f) => lerp(sp.r0 * 0.55, 0.05, f), ridges: far ? 0 : 4, ridgeDepth: far ? 0 : 0.08, twist: 0.6, bark: BARK, barkLight: BARK_LIGHT, foot: 0, sway: (f) => 0.15 * f, seed: Math.floor(s.next() * 1e6), phase: az });
  }
  b.set({ cls: MAT.foliage });
  const lo = C[1] - sp.rv, hi = C[1] + sp.rv * 1.3;
  ends.forEach((e, li) => {
    const n = s.int(sp.perLimb[0], sp.perLimb[1]);
    for (let k = 0; k < n; k++) {
      const rr = s.range(sp.clusterR[0], sp.clusterR[1]);
      const c = add3(e, [s.range(-1, 1), s.range(-0.3, 0.8), s.range(-1, 1)]);
      const shade = lerp(0.78, 1.08, clamp((c[1] - lo) / (hi - lo), 0, 1));
      const r: Vec3 = [rr * s.range(0.9, 1.15), rr * s.range(0.72, 0.85), rr * s.range(0.9, 1.15)];
      leafCluster(b, c, r, sp.style, s, { shade });
      if (sp.apples && li < ends.length - 1) {
        b.set({ cls: MAT.generic });
        fruits(b, c, r, 4, hex('#c8342a'), s);
        b.set({ cls: MAT.foliage });
      }
    }
  });
  // A dark inner filler so the crown has no holes through it.
  leafCluster(b, add3(C, [0, -0.2, 0]), [sp.rh * 0.6, sp.rv * 0.65, sp.rh * 0.6], sp.style, s, { shade: 0.72, underLeaves: 0.2 });
  b.set({ cls: MAT.generic, sway: 0 });
  bakeAo(b, { ground: () => 0, rays: far ? 6 : 10, reach: 1.6, cell: 0.18, strength: 0.7 });
  return b;
}

interface ConiferColors {
  dark: RGB;
  mid: RGB;
  tip: RGB;
}

const FIR: ConiferColors = { dark: hex('#163a2c'), mid: hex('#2e5a40'), tip: hex('#6f9a58') };
const PINE: ConiferColors = { dark: hex('#1d4028'), mid: hex('#3a6838'), tip: hex('#8aaa58') };

/**
 * One tier of a conifer: a star of `K` drooping branch tips (with notches between them) round an inner ring and an
 * apex, closed underneath, with needle tufts hanging off the tips. `gaps` thins out some tips (a broken side).
 */
function tier(b: MeshBuilder, cx: number, cy: number, cz: number, R: number, K: number, droop: number, col: ConiferColors, shade: number, s: Stream, fringe: boolean, gaps: number): void {
  const n = K * 2;
  const tone = (c: RGB): RGB => scaleRgb(c, shade);
  const outer: Vec3[] = [];
  const inner: Vec3[] = [];
  const isTip: boolean[] = [];
  const a0 = s.next() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + s.nextJitter((0.3 * Math.PI) / n);
    const tip = i % 2 === 0;
    let r = tip ? R * s.nextRange(0.78, 1.18) : R * s.nextRange(0.48, 0.64);
    if (tip && s.next() < gaps) r *= 0.55;
    const y = tip ? cy - droop * r * s.nextRange(0.8, 1.25) : cy - droop * R * 0.4;
    outer.push([cx + Math.sin(a) * r, y, cz + Math.cos(a) * r]);
    inner.push([cx + Math.sin(a) * R * 0.42, cy + R * 0.12, cz + Math.cos(a) * R * 0.42]);
    isTip.push(tip);
  }
  const up: Vec3 = [0, 1, 0];
  const radial = (p: Vec3): Vec3 => norm3([p[0] - cx, 0, p[2] - cz]);
  const apex = vtx(b, [cx, cy + R * 0.5, cz], up, tone(col.dark), 0.1);
  const iv = inner.map((p) => vtx(b, p, norm3(add3(scale3(radial(p), 0.5), [0, 0.9, 0])), tone(mixRgb(col.dark, col.mid, 0.4)), 0.2));
  const ov = outer.map((p, i) => vtx(b, p, norm3(add3(scale3(radial(p), 0.8), [0, 0.55, 0])), tone(isTip[i] ? mixRgb(col.mid, col.tip, s.nextRange(0.45, 0.8)) : col.mid), isTip[i] ? 0.75 : 0.45));
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    triFacing(b, apex, iv[i]!, iv[i1]!, up);
    const out = norm3(add3(radial(outer[i]!), [0, 1.2, 0]));
    triFacing(b, iv[i]!, ov[i]!, ov[i1]!, out);
    triFacing(b, iv[i]!, ov[i1]!, iv[i1]!, out);
  }
  // Underside: from the rim up to a point under the inner ring.
  const uc = vtx(b, [cx, cy - droop * R * 0.45 + 0.05, cz], [0, -1, 0], tone(scaleRgb(col.dark, 0.55)), 0.1);
  const uv = outer.map((p, i) => vtx(b, p, norm3(add3(scale3(radial(p), 0.35), [0, -1, 0])), tone(scaleRgb(col.dark, isTip[i] ? 0.8 : 0.65)), isTip[i] ? 0.75 : 0.45));
  for (let i = 0; i < n; i++) triFacing(b, uc, uv[(i + 1) % n]!, uv[i]!, [0, -1, 0]);
  if (!fringe) return;
  // Needle tufts hanging off the tips: small three-sided points.
  for (let i = 0; i < n; i += 2) {
    const p = outer[i]!;
    const rd = radial(p);
    const tipP: Vec3 = add3(add3(p, scale3(rd, R * 0.16)), [0, -R * 0.22 - 0.12, 0]);
    const w = R * 0.11;
    const side: Vec3 = [-rd[2], 0, rd[0]];
    const c0 = add3(add3(p, scale3(rd, -w)), [0, 0.04, 0]);
    const c1 = add3(p, scale3(side, w));
    const c2 = add3(p, scale3(side, -w));
    const tc = tone(mixRgb(col.mid, col.tip, 0.7));
    const base = [c0, c1, c2];
    // Centre of the little pyramid: each side faces away from it.
    const mid = scale3(add3(add3(c0, c1), add3(c2, tipP)), 0.25);
    for (let k = 0; k < 3; k++) {
      const a = base[k]!, c = base[(k + 1) % 3]!;
      let fn = norm3(cross3(sub3(c, a), sub3(tipP, a)));
      const away = sub3(scale3(add3(add3(a, c), tipP), 1 / 3), mid);
      if (dot3(fn, away) < 0) fn = scale3(fn, -1);
      const ia = vtx(b, a, fn, tone(col.mid), 0.7);
      const ic = vtx(b, c, fn, tone(col.mid), 0.7);
      const it = vtx(b, tipP, fn, tc, 0.9);
      triFacing(b, ia, ic, it, fn);
    }
  }
}

interface ConiferSpec {
  height: number;
  tiers: number;
  baseR: number;
  K: [number, number];
  droop: number;
  colors: ConiferColors;
  crooked: number;
  fringe: boolean;
  gaps: number;
  bareTrunk: number;
  sides: number;
  /** Tier radius over the share of the height (not a straight taper). */
  profile: (t: number, s: Stream) => number;
  bark: [RGB, RGB];
}

const CONIFERS: Record<'fir' | 'pine' | 'fir-far', ConiferSpec> = {
  fir: { height: 11.5, tiers: 8, baseR: 2.7, K: [7, 9], droop: 0.42, colors: FIR, crooked: 0.12, fringe: true, gaps: 0.12, bareTrunk: 1.5, sides: 8, profile: (t, s) => Math.pow(1 - t, 0.85) * s.nextRange(0.85, 1.12) + 0.12, bark: [BARK, BARK_LIGHT] },
  pine: { height: 9.5, tiers: 6, baseR: 2.5, K: [6, 8], droop: 0.28, colors: PINE, crooked: 0.55, fringe: true, gaps: 0.28, bareTrunk: 3.0, sides: 9, profile: (t, s) => (0.75 + 0.35 * Math.sin(t * 2.6 + 0.4)) * (1 - t * 0.55) * s.nextRange(0.8, 1.15), bark: [PINE_BARK, PINE_BARK_LIGHT] },
  'fir-far': { height: 11.5, tiers: 4, baseR: 2.8, K: [5, 5], droop: 0.42, colors: FIR, crooked: 0.12, fringe: false, gaps: 0.1, bareTrunk: 1.6, sides: 5, profile: (t, s) => Math.pow(1 - t, 0.85) * s.nextRange(0.9, 1.1) + 0.12, bark: [BARK, BARK_LIGHT] },
};

function conifer(kind: 'fir' | 'pine' | 'fir-far', s: Stream): MeshBuilder {
  const sp = CONIFERS[kind];
  const b = new MeshBuilder();
  const far = kind === 'fir-far';
  // A slightly crooked stem: tiers follow it.
  const bendA = s.range(0, Math.PI * 2);
  const stemAt = (y: number): Vec3 => {
    const t = clamp(y / sp.height, 0, 1);
    const off = sp.crooked * Math.sin(t * 2.4 + bendA) * t * 1.6;
    return [Math.sin(bendA) * off, y, Math.cos(bendA) * off];
  };
  const stem: Vec3[] = [];
  for (let i = 0; i <= (far ? 3 : 8); i++) stem.push(stemAt(-0.4 + (i / (far ? 3 : 8)) * (sp.height * 0.93)));
  b.set({ cls: MAT.bark });
  barkTube(b, stem, { sides: sp.sides, radius: (f) => lerp(0.34, 0.06, f) * (1 + 0.4 * (1 - clamp(f / 0.08, 0, 1))), ridges: far ? 0 : 5, ridgeDepth: far ? 0 : 0.1, twist: 0.5, bark: sp.bark[0], barkLight: sp.bark[1], moss: far ? 0 : 0.3, foot: 0.06, seed: Math.floor(s.next() * 1e6) });
  b.set({ cls: MAT.foliage });
  const y0 = sp.bareTrunk;
  const y1 = sp.height * 0.9;
  for (let k = 0; k < sp.tiers; k++) {
    const t = k / (sp.tiers - 1);
    const y = lerp(y0, y1, Math.pow(t, 0.92)) + s.range(-0.2, 0.2);
    const c = stemAt(y);
    const jitter = sp.crooked * 0.6;
    const R = Math.max(0.45, sp.baseR * sp.profile(t, s));
    const K = s.int(sp.K[0], sp.K[1]) - (t > 0.7 ? 1 : 0);
    const shade = lerp(0.72, 1.08, t);
    tier(b, c[0] + s.range(-jitter, jitter), c[1], c[2] + s.range(-jitter, jitter), R, K, sp.droop, sp.colors, shade, s, sp.fringe, sp.gaps);
  }
  // The leader: a thin spire of two small tiers.
  const tipY = sp.height * 0.9;
  const tc = stemAt(tipY + 0.6);
  tier(b, tc[0], tc[1], tc[2], 0.45, 5, 0.5, sp.colors, 1.12, s, false, 0);
  const top = stemAt(sp.height);
  b.set({ sway: 0 });
  ellipsoid(b, add3(top, [0, -0.35, 0]), [0.14, 0.55, 0.14], { seg: 5, rings: 4, paint: (d) => scaleRgb(mixRgb(sp.colors.mid, sp.colors.tip, 0.5), lerp(0.75, 1.1, d[1] * 0.5 + 0.5)), sway: () => 0.6 });
  b.set({ cls: MAT.generic, sway: 0 });
  bakeAo(b, { ground: () => 0, rays: far ? 6 : 10, reach: 1.8, cell: 0.2, strength: 0.65 });
  return b;
}

/** A bush: a mound of a few leaf clusters sitting on the ground. */
function bush(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  const n = 4;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + s.range(-0.4, 0.4);
    const d = k === 0 ? 0 : s.range(0.45, 0.7);
    const rr = k === 0 ? 0.85 : s.range(0.55, 0.75);
    const c: Vec3 = [Math.sin(a) * d, rr * 0.55 + (k === 0 ? 0.2 : 0), Math.cos(a) * d];
    leafCluster(b, c, [rr * 1.1, rr * 0.85, rr * 1.1], BUSH, s, { shade: k === 0 ? 1.04 : 0.95, floor: -0.55, underLeaves: 0.2 });
  }
  b.set({ cls: MAT.generic, sway: 0 });
  bakeAo(b, { ground: () => 0, rays: 10, reach: 0.9, cell: 0.1, strength: 0.6 });
  return b;
}

/** Builds a tree template by name. */
export function treeTemplate(kind: TreeTemplate, s: Stream): MeshBuilder {
  switch (kind) {
    case 'oak':
    case 'apple':
    case 'oak-far':
      return broadleaf(kind, s);
    case 'fir':
    case 'pine':
    case 'fir-far':
      return conifer(kind, s);
    case 'bush':
      return bush(s);
  }
}

/** Typical trunk radius of a template at the ground (for clearances), metres at scale 1. */
export const TRUNK_RADIUS: Record<TreeTemplate, number> = { oak: 0.45, apple: 0.35, fir: 0.45, pine: 0.45, bush: 1.0, 'oak-far': 0.45, 'fir-far': 0.45 };

/** A colour tint per instance: a little hue and value drift so repeated trees do not look stamped. */
export function treeTint(s: Stream, i: number, amount = 1): RGB {
  // Warmer (more yellow) or cooler (more blue) greens, and a little lighter or darker.
  const warm = s.jitter(1, i, 1) * amount;
  const v = 1 + s.jitter(0.1, i, 2) * amount;
  return [v * (1 + 0.07 * warm), v * (1 + 0.025 * warm), v * (1 - 0.08 * warm)];
}
