// Small plants and stones on the ground, built once as templates and batched into static meshes by the scatter
// (src/vegetation/index.ts): grass tufts, flowers of seven kinds and colours, ferns, reeds with cattails, small mossy
// stones and mushrooms. Each template stands at the origin on y = 0 and reaches a few centimetres into the ground.
// Also the plants of a window box, for the builders of houses (`windowBoxPlants`).

import type { RGB, Stream, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, add3, compose34, cross3, hex, lerp, mixRgb, norm3, rock, scale3, scaleRgb, shiftHsv, sub3 } from '../kit/index.ts';
import { blade, ellipsoid, leaf, triFacing, vtx } from './common.ts';
import { IVY } from './foliage.ts';

export type FlowerKind = 'daisy' | 'buttercup' | 'poppy' | 'bluebell' | 'pink' | 'lavender' | 'forgetmenot';
export const FLOWER_KINDS: readonly FlowerKind[] = ['daisy', 'buttercup', 'poppy', 'bluebell', 'pink', 'lavender', 'forgetmenot'];

interface FlowerSpec {
  petal: RGB;
  center: RGB;
  /** Petals, head radius, cup (+ opens up, − hangs as a bell). */
  K: number;
  R: number;
  cup: number;
  stems: [number, number];
  height: [number, number];
  /** Heads per stem. */
  heads: number;
  /** Spike flowers (lavender) instead of open heads. */
  spike?: boolean;
}

const FLOWERS: Record<FlowerKind, FlowerSpec> = {
  daisy: { petal: hex('#f4f0e2'), center: hex('#f2c23a'), K: 8, R: 0.065, cup: 0.12, stems: [3, 5], height: [0.2, 0.38], heads: 1 },
  buttercup: { petal: hex('#f6cc2c'), center: hex('#e09a1a'), K: 5, R: 0.05, cup: 0.45, stems: [3, 5], height: [0.22, 0.42], heads: 1 },
  poppy: { petal: hex('#d8362a'), center: hex('#2a1a14'), K: 4, R: 0.085, cup: 0.55, stems: [3, 5], height: [0.32, 0.55], heads: 1 },
  bluebell: { petal: hex('#6a68d4'), center: hex('#4a46a8'), K: 5, R: 0.045, cup: -0.95, stems: [3, 4], height: [0.2, 0.34], heads: 2 },
  pink: { petal: hex('#e86a9a'), center: hex('#f6b0cc'), K: 7, R: 0.08, cup: 0.3, stems: [3, 4], height: [0.3, 0.5], heads: 1 },
  lavender: { petal: hex('#8a5ac8'), center: hex('#b896e8'), K: 0, R: 0, cup: 0, stems: [5, 7], height: [0.35, 0.6], heads: 1, spike: true },
  forgetmenot: { petal: hex('#79aee8'), center: hex('#f4e266'), K: 5, R: 0.038, cup: 0.1, stems: [4, 5], height: [0.14, 0.26], heads: 2 },
};

const STEM: RGB = hex('#3f6e2a');
const STEM_LIGHT: RGB = hex('#7aa042');

/** A flower head: a star of petals with a raised centre, closed underneath. Faces `up`. */
function star(b: MeshBuilder, c: Vec3, R: number, K: number, cup: number, center: RGB, petal: RGB, s: Stream, sway: number): void {
  const n = K * 2;
  const up: Vec3 = [0, 1, 0];
  const a0 = s.next() * Math.PI * 2;
  const ring: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    const tip = i % 2 === 0;
    const r = tip ? R * s.nextRange(0.9, 1.1) : R * 0.42;
    ring.push([c[0] + Math.sin(a) * r, c[1] + cup * r * (tip ? 1 : 0.5), c[2] + Math.cos(a) * r]);
  }
  const ci = vtx(b, add3(c, [0, R * 0.25, 0]), up, center, sway);
  const top = ring.map((p, i) => vtx(b, p, norm3(add3(sub3(p, c), [0, R * 1.5, 0])), i % 2 === 0 ? petal : mixRgb(petal, center, 0.25), sway));
  for (let i = 0; i < n; i++) triFacing(b, ci, top[i]!, top[(i + 1) % n]!, up);
  const down: Vec3 = [0, -1, 0];
  const cu = vtx(b, add3(c, [0, -R * 0.12, 0]), down, scaleRgb(petal, 0.55), sway);
  const bot = ring.map((p) => vtx(b, p, norm3(add3(sub3(p, c), [0, -R * 1.5, 0])), scaleRgb(petal, 0.7), sway));
  for (let i = 0; i < n; i++) triFacing(b, cu, bot[(i + 1) % n]!, bot[i]!, down);
}

/** A clump of one kind of flower: leaves at the foot, stems, heads. */
function flowerClump(kind: FlowerKind, s: Stream): MeshBuilder {
  const sp = FLOWERS[kind];
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  const leaves = s.int(3, 5);
  for (let k = 0; k < leaves; k++) {
    const a = s.next() * Math.PI * 2;
    const dir: Vec3 = norm3([Math.sin(a) * 0.9, 1, Math.cos(a) * 0.9]);
    blade(b, [Math.sin(a) * 0.03, -0.03, Math.cos(a) * 0.03], dir, [Math.sin(a), -0.3, Math.cos(a)], s.nextRange(0.12, 0.2), 0.07, scaleRgb(STEM, 0.75), STEM_LIGHT, [0, 0.4]);
  }
  const stems = s.int(sp.stems[0], sp.stems[1]);
  for (let k = 0; k < stems; k++) {
    const a = s.next() * Math.PI * 2;
    const r = s.nextRange(0, 0.1);
    const base: Vec3 = [Math.sin(a) * r, -0.03, Math.cos(a) * r];
    const h = s.nextRange(sp.height[0], sp.height[1]);
    const dir = norm3([Math.sin(a) * 0.25 + s.nextJitter(0.1), 1, Math.cos(a) * 0.25 + s.nextJitter(0.1)]);
    const bend: Vec3 = [Math.sin(a) * 0.4, 0, Math.cos(a) * 0.4];
    b.set({ cls: MAT.foliage });
    if (sp.spike) {
      // Lavender: a green stem, then a long violet spike of buds.
      blade(b, base, dir, bend, h * 0.6, 0.022, STEM, STEM_LIGHT, [0, 0.6]);
      const at = add3(add3(base, scale3(dir, h * 0.6)), scale3(bend, h * 0.25));
      b.set({ cls: MAT.generic });
      const col = shiftHsv(sp.petal, s.nextJitter(0.02), s.nextJitter(0.1), s.nextJitter(0.12));
      blade(b, at, dir, bend, h * 0.45, 0.06, scaleRgb(col, 0.8), sp.center, [0.6, 1]);
      continue;
    }
    blade(b, base, dir, bend, h, 0.02, STEM, STEM_LIGHT, [0, 0.7]);
    const tip = add3(add3(base, scale3(dir, h)), scale3(bend, h * 0.42));
    b.set({ cls: MAT.generic });
    for (let hd = 0; hd < sp.heads; hd++) {
      const at = hd === 0 ? tip : add3(tip, [s.nextJitter(0.06), -s.nextRange(0.04, 0.09), s.nextJitter(0.06)]);
      const petal = shiftHsv(sp.petal, s.nextJitter(0.015), s.nextJitter(0.1), s.nextJitter(0.1));
      star(b, at, sp.R * s.nextRange(0.85, 1.15), sp.K, sp.cup, sp.center, petal, s, 0.85);
    }
  }
  b.set({ cls: MAT.generic });
  return b;
}

/** A grass tuft: blades fanning out of one point, dark at the foot, light and sometimes dry at the tips. */
function grassTuft(variant: number, s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  const n = [7, 10, 8][variant]!;
  const hMax = [0.42, 0.7, 0.55][variant]!;
  const dry = [0, 0.1, 0.45][variant]!;
  const foot = hex('#355f26');
  const lush = hex('#9cc24c');
  const straw = hex('#c8b45a');
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + s.nextJitter(0.5);
    const lean = s.nextRange(0.15, 0.6);
    const dir = norm3([Math.sin(a) * lean, 1, Math.cos(a) * lean]);
    const tipCol = s.next() < dry ? mixRgb(lush, straw, s.nextRange(0.5, 1)) : shiftHsv(lush, s.nextJitter(0.03), s.nextJitter(0.1), s.nextJitter(0.12));
    blade(b, [Math.sin(a) * 0.05, -0.04, Math.cos(a) * 0.05], dir, [Math.sin(a), -0.15, Math.cos(a)], hMax * s.nextRange(0.55, 1), s.nextRange(0.07, 0.11), foot, tipCol, [0, 1]);
  }
  b.set({ cls: MAT.generic });
  return b;
}

/** A fern: a rosette of arching fronds with zigzag leaflets, two-sided (top and underside). */
function fern(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  const fronds = s.int(6, 7);
  const dark = hex('#24502a');
  const fresh = hex('#7fb046');
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + s.nextJitter(0.3);
    const L = s.nextRange(0.7, 1.1);
    const rise = s.nextRange(0.5, 0.8);
    const hd: Vec3 = [Math.sin(a), 0, Math.cos(a)];
    const side: Vec3 = [-hd[2], 0, hd[0]];
    const seg = 5;
    const pts: Vec3[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      // Up, then arching out and down.
      pts.push([hd[0] * L * t, rise * Math.sin(t * Math.PI * 0.8) * (1 - 0.35 * t) - 0.02, hd[2] * L * t]);
    }
    for (let i = 0; i < seg; i++) {
      const p = pts[i]!, q = pts[i + 1]!;
      const t = i / seg;
      const along = norm3(sub3(q, p));
      // The frond's face: across the curve, turned to the sky.
      const nrm = norm3(cross3(along, side));
      const upN: Vec3 = nrm[1] < 0 ? scale3(nrm, -1) : nrm;
      const w = L * 0.17 * Math.sin(Math.PI * (0.15 + 0.85 * t)) + 0.02;
      const l1 = add3(add3(p, scale3(side, w)), scale3(along, w * 0.6));
      const r1 = add3(add3(p, scale3(side, -w)), scale3(along, w * 0.6));
      const col = mixRgb(dark, fresh, 0.3 + 0.6 * t);
      const sw = 0.15 + 0.7 * t;
      // Top.
      const ip = vtx(b, p, upN, col, sw), iq = vtx(b, q, upN, mixRgb(col, fresh, 0.2), sw + 0.1);
      const il = vtx(b, l1, upN, scaleRgb(col, 1.08), sw + 0.05), ir = vtx(b, r1, upN, scaleRgb(col, 1.08), sw + 0.05);
      triFacing(b, ip, il, iq, upN);
      triFacing(b, ip, iq, ir, upN);
      // Underside.
      const dn = scale3(upN, -1);
      const under = scaleRgb(col, 0.6);
      const jp = vtx(b, p, dn, under, sw), jq = vtx(b, q, dn, under, sw + 0.1);
      const jl = vtx(b, l1, dn, under, sw + 0.05), jr = vtx(b, r1, dn, under, sw + 0.05);
      triFacing(b, jp, jl, jq, dn);
      triFacing(b, jp, jq, jr, dn);
    }
  }
  b.set({ cls: MAT.generic });
  return b;
}

/** Reeds: a clump of tall blades and a few cattails. Built for a foot 0.5 m below the water line. */
function reeds(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  const n = s.int(8, 11);
  const foot = hex('#3c5a2a');
  const tip = hex('#a8b45a');
  for (let k = 0; k < n; k++) {
    const a = s.next() * Math.PI * 2;
    const r = s.nextRange(0, 0.25);
    const lean = s.nextRange(0.05, 0.3);
    const dir = norm3([Math.sin(a) * lean, 1, Math.cos(a) * lean]);
    blade(b, [Math.sin(a) * r, -0.05, Math.cos(a) * r], dir, [Math.sin(a), -0.2, Math.cos(a)], s.nextRange(1.2, 2.0), s.nextRange(0.05, 0.08), foot, shiftHsv(tip, s.nextJitter(0.03), 0, s.nextJitter(0.12)), [0, 1]);
  }
  const cattails = s.int(2, 4);
  for (let k = 0; k < cattails; k++) {
    const a = s.next() * Math.PI * 2;
    const r = s.nextRange(0.05, 0.2);
    const h = s.nextRange(1.3, 1.8);
    const base: Vec3 = [Math.sin(a) * r, -0.05, Math.cos(a) * r];
    const dir = norm3([Math.sin(a) * 0.08, 1, Math.cos(a) * 0.08]);
    b.set({ cls: MAT.foliage });
    blade(b, base, dir, [0, 0, 0], h, 0.03, foot, hex('#6a7a3a'), [0, 0.8]);
    b.set({ cls: MAT.generic });
    const head = add3(base, scale3(dir, h - 0.12));
    ellipsoid(b, head, [0.045, 0.16, 0.045], { seg: 6, rings: 4, paint: (d) => scaleRgb(hex('#6a3e22'), lerp(0.7, 1.1, d[1] * 0.5 + 0.5)), sway: () => 0.85 });
  }
  b.set({ cls: MAT.generic });
  return b;
}

/** A small stone, sunk a little, its upper faces mossy. */
function stone(s: Stream, mossy: number): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.stone });
  const base = s.nextPick([hex('#8d8790'), hex('#a49582'), hex('#7a7480')]);
  const moss = hex('#5a7a2a');
  const w = s.nextRange(0.35, 0.7);
  rock(b, [0, -0.12, 0], [w, w * s.nextRange(0.45, 0.75), w * s.nextRange(0.7, 1)], (p, n) => mixRgb(base, moss, mossy * Math.max(0, Math.min(1, (n[1] - 0.45) * 2.2 + Math.sin(p[0] * 9 + p[2] * 7) * 0.25))), { stream: s, detail: 2, cuts: 6 });
  b.set({ cls: MAT.generic });
  return b;
}

/** A small group of mushrooms with brown or red caps. */
function mushrooms(s: Stream, red: boolean): MeshBuilder {
  const b = new MeshBuilder();
  const n = s.int(3, 5);
  const capCol = red ? hex('#c03a2a') : hex('#9a6a3a');
  for (let k = 0; k < n; k++) {
    const a = s.next() * Math.PI * 2;
    const r = k === 0 ? 0 : s.nextRange(0.08, 0.2);
    const h = s.nextRange(0.08, 0.18) * (k === 0 ? 1.3 : 1);
    const p: Vec3 = [Math.sin(a) * r, 0, Math.cos(a) * r];
    b.set({ cls: MAT.generic });
    ellipsoid(b, add3(p, [0, h * 0.45 - 0.03, 0]), [0.025, h * 0.5, 0.025], { seg: 4, rings: 2, paint: () => hex('#e8dcc0') });
    const cr = h * s.nextRange(0.45, 0.65);
    const col = shiftHsv(capCol, s.nextJitter(0.02), 0, s.nextJitter(0.1));
    ellipsoid(b, add3(p, [0, h, 0]), [cr, cr * 0.55, cr], { seg: 6, rings: 3, floor: -0.1, paint: (d) => (d[1] < 0 ? hex('#d8c8a0') : scaleRgb(col, lerp(0.8, 1.15, d[1]))) });
  }
  return b;
}

export interface GroundTemplates {
  grass: MeshBuilder[];
  flowers: Record<FlowerKind, MeshBuilder[]>;
  ferns: MeshBuilder[];
  reeds: MeshBuilder[];
  stones: MeshBuilder[];
  mushrooms: MeshBuilder[];
}

/** Builds every small-plant template once. */
export function groundTemplates(s: Stream): GroundTemplates {
  const flowers = {} as Record<FlowerKind, MeshBuilder[]>;
  FLOWER_KINDS.forEach((k, i) => (flowers[k] = [flowerClump(k, s.child(100 + i)), flowerClump(k, s.child(200 + i))]));
  return {
    grass: [0, 1, 2].map((v) => grassTuft(v, s.child(10 + v))),
    flowers,
    ferns: [fern(s.child(30)), fern(s.child(31))],
    reeds: [reeds(s.child(40)), reeds(s.child(41))],
    stones: [stone(s.child(50), 0.9), stone(s.child(51), 0.6), stone(s.child(52), 0.2), stone(s.child(53), 1)],
    mushrooms: [mushrooms(s.child(60), false), mushrooms(s.child(61), true)],
  };
}

/**
 * The plants of a window box (for the builders of houses): flower clumps along local x from −length/2 to +length/2
 * at `at` (the top of the soil), facing `yaw` (local +z, the street side), with ivy trailing over the front edge.
 * Written into `b` in world coordinates. Pink, red and white by default.
 */
export function windowBoxPlants(b: MeshBuilder, t: GroundTemplates, at: readonly number[], yaw: number, length: number, s: Stream, kinds: readonly FlowerKind[] = ['pink', 'poppy', 'daisy']): void {
  const n = Math.max(2, Math.round(length / 0.22));
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const world = (lx: number, ly: number, lz: number): Vec3 => [at[0]! + cs * lx + sn * lz, at[1]! + ly, at[2]! - sn * lx + cs * lz];
  for (let i = 0; i < n; i++) {
    const lx = -length / 2 + (i + 0.5) * (length / n);
    const kind = kinds[s.int(0, kinds.length - 1, i, 1)]!;
    const tpl = t.flowers[kind][s.int(0, 1, i, 2)]!;
    const sc = s.range(0.55, 0.75, i, 3);
    b.append(tpl, compose34(world(lx, 0, s.range(-0.05, 0.05, i, 4)), s.range(0, 6.28, i, 5), 0, 0, [sc, sc, sc]));
  }
  // Trailing ivy over the front edge.
  const prev = b.flags;
  b.set({ cls: MAT.foliage });
  const m = Math.round(length / 0.12);
  for (let i = 0; i < m; i++) {
    const lx = -length / 2 + (i + 0.5) * (length / m);
    const hang = s.range(0.05, 0.35, i, 7);
    const p = world(lx + s.jitter(0.05, i, 8), -hang, 0.12 + s.range(0, 0.05, i, 9));
    const outN = world(0, 0, 1);
    const n0: Vec3 = [outN[0] - at[0]!, 0.2, outN[2] - at[2]!];
    leaf(b, p, [s.jitter(0.5, i, 10), -1, s.jitter(0.5, i, 11)], n0, IVY.leafLen * 0.8, IVY.leafWidth * 0.8, { base: shiftHsv(IVY.mid, 0, 0, s.jitter(0.15, i, 12)), tip: IVY.light, under: IVY.dark }, [0.2, 0.5], n0);
  }
  b.flags = prev;
}
