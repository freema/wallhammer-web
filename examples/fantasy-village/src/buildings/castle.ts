// The castle on the northern ridge (B3): a distant silhouette seen through the haze, so large forms over small detail.
//
//   curtain wall   a 34 × 22 m ring with a battered foot, a wall walk with crenellations and a string course
//   towers         four round corner towers, two flanking the gatehouse to the village, all with a corbelled
//                  parapet ring and tall conical slate roofs with finials
//   gatehouse      a block between the gate towers with a dark arched gate and a portcullis
//   keep           a tall square keep with corner turrets (small cones), a steep pyramid roof and a red banner
//   hall           a long hall against the back wall with a steep gabled roof, tall lit windows and a chimney
//
// Colours are desaturated and mixed toward the blue-grey of the haze, slits and windows glow in the evening.
// No shadows (it is 150 m away) and no lights; walls reach a metre into the ridge so no gap shows.
// Owner: buildings.

import type { ContentModule, RGB, SolidDef, StaticPiece, Vec3 } from '../kit/index.ts';
import { GLOW, MAT, MeshBuilder, PALETTE, bevelBox, boxSolid, compose34, cylinderSolid, hex, lathe, lerp, mixRgb, rotateY, scaleRgb, segmentSolid } from '../kit/index.ts';
import type { Stream } from '../kit/index.ts';
import { finish, localGround, smoothQuad } from './shared.ts';

/** Haze-side grey blue the far castle fades toward. */
const HAZE: RGB = hex('#9da2b6');
const fade = (c: RGB, k = 0.38): RGB => mixRgb(c, HAZE, k);
const STONE = fade(mixRgb(PALETTE.stone, PALETTE.stoneWarm, 0.3));
const STONE_DARK = fade(PALETTE.stoneDark, 0.3);
const SLATE = fade(PALETTE.slate, 0.3);
const SLATE_DARK = fade(PALETTE.slateViolet, 0.28);
const GLOW_COL: RGB = hex('#ffbe6a');
const HOLE: RGB = hex('#2a2632');

/** Wall height (wall walk) of the curtain, above the pad. */
const WALL = 9;

/** Stone paint: course banding and blotches, so large faces do not read flat even from afar. */
function stonePaint(base: RGB, seed: number) {
  return (p: Vec3): RGB => {
    const band = Math.sin(p[1] * 2.1 + seed) * 0.5 + 0.5;
    const blot = Math.sin(p[0] * 0.37 + p[2] * 0.53 + seed * 1.7) * Math.sin(p[1] * 0.29 - p[0] * 0.21 + seed);
    const k = 0.9 + 0.07 * band + 0.08 * blot;
    // Darker, damper foot.
    const foot = Math.min(1, Math.max(0, (p[1] + 0.5) / 3));
    return scaleRgb(base, k * lerp(0.82, 1, foot));
  };
}

class Castle {
  readonly b = new MeshBuilder();
  readonly s: Stream;
  readonly g: (x: number, z: number) => number;
  constructor(s: Stream, g: (x: number, z: number) => number) {
    this.s = s;
    this.g = g;
  }

  /** Lowest ground under a footprint (x0..x1, z0..z1), one metre deeper. */
  foot(x0: number, x1: number, z0: number, z1: number): number {
    let m = Infinity;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) m = Math.min(m, this.g(lerp(x0, x1, i / 4), lerp(z0, z1, j / 4)));
    return m - 1;
  }

  /** A straight run of curtain wall between two points (along x or z), crenellated, with a battered foot. */
  wall(a: [number, number], c: [number, number], thick: number, top: number, slits: number): void {
    const b = this.b;
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const seg = 4;
    const n = Math.max(1, Math.round(len / seg));
    b.with(compose34([a[0], 0, a[1]], yaw), () => {
      // In this frame the wall runs along +z; walked round as in `build`, its outside is toward −x.
      for (let k = 0; k < n; k++) {
        const z0 = (len * k) / n, z1 = (len * (k + 1)) / n;
        const w0 = this.footAlong(a, c, k / n, (k + 1) / n, thick);
        const seed = this.s.next() * 10;
        b.withFlags({ cls: MAT.stone }, () => {
          // Battered foot, then the wall itself, then a string course.
          bevelBox(b, [0, w0, (z0 + z1) / 2], [thick + 1.0, 1.6 - w0, z1 - z0 + 0.02], stonePaint(STONE_DARK, seed), { bevel: 0.12, taper: [0.72, 1] });
          bevelBox(b, [0, 1.2, (z0 + z1) / 2], [thick, top - 1.2, z1 - z0 + 0.01], stonePaint(STONE, seed), { bevel: 0.08 });
          bevelBox(b, [0, top - 0.25, (z0 + z1) / 2], [thick + 0.35, 0.3, z1 - z0 + 0.02], stonePaint(STONE_DARK, seed + 1), { bevel: 0.06 });
        });
      }
      // Crenellations along both edges: merlons every 1.7 m (outer taller, inner a low parapet).
      b.withFlags({ cls: MAT.stone }, () => {
        const m = Math.floor((len - 1.6) / 1.7);
        for (let k = 0; k <= m; k++) {
          const z = 0.8 + ((len - 1.6) * k) / Math.max(1, m);
          bevelBox(b, [-thick / 2 + 0.3, top, z], [0.6, 1.3, 0.95], stonePaint(STONE, k), { bevel: 0.06 });
        }
        bevelBox(b, [thick / 2 - 0.25, top, len / 2], [0.5, 0.6, len], stonePaint(STONE, 3), { bevel: 0.05 });
      });
      // Arrow slits on the outer face (−x side of the frame), glowing in the evening.
      for (let k = 0; k < slits; k++) {
        const z = ((k + 0.5) / slits) * len;
        this.slit([-thick / 2 - 0.02, top * 0.55, z], [0.06, 1.3, 0.22]);
      }
    });
  }

  /** Lowest ground (as a local y) under a stretch of a wall from fraction t0 to t1 of a→c. */
  footAlong(a: [number, number], c: [number, number], t0: number, t1: number, thick: number): number {
    const x0 = lerp(a[0], c[0], t0), z0 = lerp(a[1], c[1], t0), x1 = lerp(a[0], c[0], t1), z1 = lerp(a[1], c[1], t1);
    return Math.min(0, this.foot(Math.min(x0, x1) - thick / 2, Math.max(x0, x1) + thick / 2, Math.min(z0, z1) - thick / 2, Math.max(z0, z1) + thick / 2));
  }

  /** A glowing window slit (or a dark one when `glow` is 0): a thin box proud of the face. */
  slit(at: Vec3, size: Vec3, glow = 1): void {
    this.b.withFlags({ cls: MAT.glass, glow, channel: GLOW.evening }, () => bevelBox(this.b, at, size, glow > 0 ? GLOW_COL : HOLE, { anchor: 'center', bevel: 0.01 }));
  }

  /** A round tower: battered foot, shaft, corbelled parapet with merlons, conical roof with a finial; slits round it. */
  tower(x: number, z: number, r: number, h: number, roof: number, slitRows: number): void {
    const b = this.b;
    const y0 = Math.min(0, this.foot(x - r, x + r, z - r, z + r));
    const seed = this.s.next() * 10;
    const seg = 14;
    const phase = this.s.next() * 3;
    b.withFlags({ cls: MAT.stone }, () => {
      lathe(b, [x, y0, z], [[r + 0.7, 0], [r + 0.55, 1.2 - y0], [r, 2.6 - y0], [r, h - 1.2 - y0], [r + 0.45, h - 0.6 - y0], [r + 0.45, h - y0]], stonePaint(STONE, seed), { segments: seg, capTop: true, phase, faceted: false });
      // Corbel brackets under the parapet ring.
      for (let k = 0; k < seg; k++) {
        const a = phase + ((k + 0.5) / seg) * Math.PI * 2;
        b.with(compose34([x + Math.sin(a) * (r + 0.1), h - 1.6, z + Math.cos(a) * (r + 0.1)], a), () =>
          bevelBox(b, [0, 0, 0], [0.4, 1.0, 0.5], stonePaint(STONE_DARK, seed), { bevel: 0.05, taper: [1, 1.6] }),
        );
      }
      // Merlons round the parapet.
      const nm = Math.max(8, Math.round((2 * Math.PI * (r + 0.3)) / 1.5));
      for (let k = 0; k < nm; k++) {
        const a = phase + (k / nm) * Math.PI * 2;
        b.with(compose34([x + Math.sin(a) * (r + 0.2), h, z + Math.cos(a) * (r + 0.2)], a), () => bevelBox(b, [0, 0, 0], [0.75, 1.0, 0.45], stonePaint(STONE, seed + k), { bevel: 0.05 }));
      }
    });
    // Conical roof rising from inside the parapet, slightly bell-cast, with a finial.
    if (roof > 0) {
      b.withFlags({ cls: MAT.roof }, () =>
        lathe(b, [x, h - 0.2, z], [[r + 0.15, 0], [r - 0.05, 0.35], [r * 0.62, roof * 0.35], [r * 0.25, roof * 0.75], [0.06, roof]], (p) => scaleRgb(mixRgb(SLATE, SLATE_DARK, 0.5 + 0.5 * Math.sin(p[1] * 3.5)), 0.92 + 0.08 * Math.sin(p[1] * 9)), { segments: seg + 2, capBottom: true, phase }),
      );
      b.withFlags({ cls: MAT.metal }, () => lathe(b, [x, h - 0.2 + roof - 0.05, z], [[0.05, 0], [0.16, 0.3], [0.05, 0.6], [0.03, 1.4]], fade(PALETTE.iron, 0.2), { segments: 6, capTop: true }));
    }
    // Slits staggered round the shaft.
    for (let row = 0; row < slitRows; row++) {
      const y = 3.2 + ((h - 5) * (row + 0.5)) / slitRows;
      for (let k = 0; k < 3; k++) {
        const a = phase + row * 1.1 + (k / 3) * Math.PI * 2;
        b.with(compose34([x + Math.sin(a) * (r + 0.02), y, z + Math.cos(a) * (r + 0.02)], a), () => this.slit([0, 0, 0], [0.22, 1.1, 0.08], this.s.next() < 0.6 ? 1 : 0));
      }
    }
  }

  /** A square tower body (keep or gatehouse) with a string course and battlements on top. */
  block(x: number, z: number, w: number, d: number, h: number, merlons: boolean): void {
    const b = this.b;
    const y0 = Math.min(0, this.foot(x - w / 2, x + w / 2, z - d / 2, z + d / 2));
    const seed = this.s.next() * 10;
    b.withFlags({ cls: MAT.stone }, () => {
      bevelBox(b, [x, y0, z], [w + 1.0, 2.2 - y0, d + 1.0], stonePaint(STONE_DARK, seed), { bevel: 0.12, taper: [w / (w + 1.0), d / (d + 1.0)] });
      bevelBox(b, [x, 1.5, z], [w, h - 1.5, d], stonePaint(STONE, seed), { bevel: 0.1 });
      bevelBox(b, [x, h - 0.7, z], [w + 0.5, 0.35, d + 0.5], stonePaint(STONE_DARK, seed + 2), { bevel: 0.06 });
      bevelBox(b, [x, h - 0.4, z], [w + 0.4, 0.5, d + 0.4], stonePaint(STONE, seed + 3), { bevel: 0.06 });
      if (merlons) {
        for (const [sx, sz, len, alongX] of [[0, d / 2, w, true], [0, -d / 2, w, true], [w / 2, 0, d, false], [-w / 2, 0, d, false]] as const) {
          const m = Math.max(2, Math.round(len / 1.6));
          for (let k = 0; k <= m; k++) {
            const t = -len / 2 + (len * k) / m;
            const px = alongX ? x + t : x + sx, pz = alongX ? z + sz : z + t;
            bevelBox(b, [px, h + 0.1, pz], [alongX ? 0.85 : 0.5, 1.15, alongX ? 0.5 : 0.85], stonePaint(STONE, seed + k), { bevel: 0.05 });
          }
        }
      }
    });
  }

  /** A steep gabled roof over a rectangle (ridge along x), with gable walls of stone below its ends. */
  gableRoof(x: number, z: number, w: number, d: number, y: number, rise: number): void {
    const b = this.b;
    const hx = w / 2 + 0.3, hz = d / 2 + 0.45, t = 0.2;
    const col = (p: Vec3): RGB => scaleRgb(mixRgb(SLATE, SLATE_DARK, 0.5 + 0.5 * Math.sin(p[1] * 4.2 + p[0] * 0.3)), 0.9 + 0.1 * Math.sin(p[1] * 11));
    const ridge = y + rise;
    b.withFlags({ cls: MAT.roof }, () => {
      for (const sz of [-1, 1]) {
        const n: Vec3 = [0, hz, sz * rise];
        const l = Math.hypot(hz, rise);
        const nn: Vec3 = [0, n[1] / l, n[2] / l];
        const q: Vec3[] = [[x - hx, y, z + sz * hz], [x + hx, y, z + sz * hz], [x + hx, ridge, z], [x - hx, ridge, z]];
        smoothQuad(b, q, [nn, nn, nn, nn], q.map(col));
        // The underside and the thickness at the eave.
        const dn: Vec3 = [-nn[0], -nn[1], -nn[2]];
        const qu = q.map((p) => [p[0], p[1] - t, p[2]] as Vec3);
        smoothQuad(b, qu, [dn, dn, dn, dn], qu.map(() => scaleRgb(SLATE_DARK, 0.6)));
        const e: Vec3 = [0, 0, sz];
        const qe: Vec3[] = [q[0]!, q[1]!, qu[1]!, qu[0]!];
        smoothQuad(b, qe, [e, e, e, e], qe.map(() => SLATE_DARK));
      }
      // Ridge roll.
      bevelBox(b, [x, ridge - 0.15, z], [2 * hx + 0.1, 0.3, 0.35], SLATE_DARK, { anchor: 'base', bevel: 0.06 });
    });
    // Gable triangles of stone.
    b.withFlags({ cls: MAT.stone }, () => {
      for (const sx of [-1, 1]) {
        const px = x + sx * (w / 2 - 0.1);
        const tri: Vec3[] = [[px, y - 0.05, z - d / 2], [px, y - 0.05, z + d / 2], [px, ridge - 0.25, z]];
        const n: Vec3 = [sx, 0, 0];
        const c = stonePaint(STONE, 5);
        const first = b.vertexCount;
        for (const p of sx > 0 ? tri : [tri[1]!, tri[0]!, tri[2]!]) b.vertex(p, n, c(p), 1);
        b.tri(first, first + 1, first + 2);
        const m: Vec3 = [-sx, 0, 0];
        const back = b.vertexCount;
        for (const p of sx > 0 ? [tri[1]!, tri[0]!, tri[2]!] : tri) b.vertex(p, m, c(p), 1);
        b.tri(back, back + 1, back + 2);
      }
    });
  }

  /** A steep pyramid roof over a square (four-sided lathe turned 45 degrees), with a finial. */
  pyramid(x: number, z: number, half: number, y: number, rise: number): void {
    const r = half * Math.SQRT2;
    this.b.withFlags({ cls: MAT.roof }, () =>
      lathe(this.b, [x, y, z], [[r + 0.25, 0], [r * 0.92, 0.5], [r * 0.4, rise * 0.6], [0.05, rise]], (p) => scaleRgb(mixRgb(SLATE, SLATE_DARK, 0.5 + 0.5 * Math.sin(p[1] * 3.1)), 0.92 + 0.08 * Math.sin(p[1] * 10)), { segments: 4, phase: Math.PI / 4, capBottom: true, faceted: true }),
    );
    this.b.withFlags({ cls: MAT.metal }, () => lathe(this.b, [x, y + rise - 0.05, z], [[0.06, 0], [0.18, 0.3], [0.05, 0.6], [0.03, 1.6]], fade(PALETTE.iron, 0.2), { segments: 6, capTop: true }));
  }

  /** A banner on a pole: two-sided cloth that sways. */
  banner(x: number, y: number, z: number): void {
    const b = this.b;
    b.withFlags({ cls: MAT.wood }, () => lathe(b, [x, y, z], [[0.07, 0], [0.05, 4.2], [0.09, 4.3], [0.03, 4.5]], fade(hex('#4a3a2e'), 0.25), { segments: 6, capTop: true }));
    const red = fade(hex('#a8322c'), 0.22);
    const cols = 5, rows = 3, len = 2.6, hgt = 1.3;
    const pt = (i: number, j: number): Vec3 => {
      const f = i / cols;
      // Hanging off the pole toward +x, with a little ripple and a swallowtail.
      const tail = j === 1 && i === cols ? -0.5 : 0;
      return [x + 0.08 + f * len + tail, y + 4.15 - (j / rows) * hgt - f * 0.25, z + 0.18 * Math.sin(f * 5)];
    };
    b.withFlags({ cls: MAT.fabric, sway: 0.9 }, () => {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const q = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
          const c = scaleRgb(red, 0.9 + 0.12 * Math.sin(i * 1.7 + j));
          smoothQuad(b, q, [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]], [c, c, c, c]);
          smoothQuad(b, q, [[0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1]], [c, c, c, c].map((v) => scaleRgb(v, 0.8)));
        }
      }
    });
  }
}

export const castle: ContentModule = {
  name: 'castle',
  build(ctx) {
    const statics: StaticPiece[] = [];
    const solids: SolidDef[] = [];
    const t0 = performance.now();
    for (const s of ctx.layout.structures) {
      if (s.kind !== 'castle') continue;
      const padY = ctx.field.padY(s.id);
      const c = new Castle(ctx.stream(`castle:${s.id}`), localGround(ctx, s, padY));
      const hw = s.body.w / 2, hd = s.body.d / 2;
      const x0 = s.body.x - hw, x1 = s.body.x + hw, z0 = s.body.z - hd, z1 = s.body.z + hd;
      const T = 2.4;
      c.b.with(compose34([s.x, padY, s.z], s.yaw), () => {
      // Curtain walls between the towers; the front (+z, toward the village) is split by the gatehouse.
      const gate = 4.6;
      c.wall([x1, z0], [x0, z0], T, WALL, 4);
      c.wall([x0, z0], [x0, z1], T, WALL, 3);
      c.wall([x1, z1], [x1, z0], T, WALL, 3);
      c.wall([x0, z1], [s.body.x - gate, z1], T, WALL, 2);
      c.wall([s.body.x + gate, z1], [x1, z1], T, WALL, 2);
      // Corner towers (the back ones taller, standing higher on the ridge) and the gate towers.
      c.tower(x0, z0, 3.3, 15.5, 7.5, 3);
      c.tower(x1, z0, 3.0, 14.0, 6.8, 3);
      c.tower(x0, z1, 3.0, 12.5, 6.2, 2);
      c.tower(x1, z1, 3.1, 13.0, 6.4, 2);
      c.tower(s.body.x - gate, z1 + 0.6, 2.5, 13.5, 5.6, 2);
      c.tower(s.body.x + gate, z1 + 0.6, 2.5, 13.5, 5.6, 2);
      // Gatehouse with a dark arched gate and a portcullis.
      c.block(s.body.x, z1 + 0.2, 2 * gate - 2.4, 4.2, 11.5, true);
      const gz = z1 + 0.2 + 2.12;
      c.b.withFlags({ cls: MAT.stone }, () => {
        bevelBox(c.b, [s.body.x, 0, gz], [3.2, 4.0, 0.12], HOLE, { bevel: 0.02 });
        lathe(c.b, [s.body.x, 4.0, gz], [[1.6, 0], [1.6, 0.1]], HOLE, { segments: 12 });
        // Voussoirs of the arch and its jambs.
        for (let k = 0; k <= 8; k++) {
          const a = -Math.PI / 2 + (k / 8) * Math.PI;
          c.b.with(compose34([s.body.x + Math.sin(a) * 1.85, 4.0 + Math.cos(a) * 1.85, gz + 0.05], 0, 0, -a), () => bevelBox(c.b, [0, 0, 0], [0.55, 0.5, 0.3], stonePaint(STONE_DARK, k), { anchor: 'center', bevel: 0.04 }));
        }
        for (const sx of [-1, 1]) bevelBox(c.b, [s.body.x + sx * 1.85, 0, gz + 0.05], [0.55, 4.0, 0.3], stonePaint(STONE_DARK, sx), { bevel: 0.04 });
      });
      c.b.withFlags({ cls: MAT.metal }, () => {
        for (let k = -3; k <= 3; k++) bevelBox(c.b, [s.body.x + k * 0.42, 1.6, gz + 0.1], [0.08, 3.6, 0.08], fade(PALETTE.iron, 0.2), { bevel: 0.01 });
        for (let k = 0; k < 5; k++) bevelBox(c.b, [s.body.x, 1.8 + k * 0.7, gz + 0.15], [3.0, 0.08, 0.08], fade(PALETTE.iron, 0.2), { bevel: 0.01 });
      });
      c.slit([s.body.x - 1.4, 8.0, gz + 0.03], [0.5, 1.1, 0.06]);
      c.slit([s.body.x + 1.4, 8.0, gz + 0.03], [0.5, 1.1, 0.06]);
      // Keep: tall, toward the back left, corner turrets with small cones, a pyramid roof and a banner.
      const kx = s.body.x - 5.5, kz = s.body.z - 2.5, kw = 9.5, kh = 23;
      c.block(kx, kz, kw, kw, kh, true);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const tx = kx + sx * (kw / 2 + 0.2), tz = kz + sz * (kw / 2 + 0.2);
        c.b.withFlags({ cls: MAT.stone }, () => {
          lathe(c.b, [tx, kh - 3.5, tz], [[0.05, 0], [1.1, 1.4], [1.2, 1.6], [1.2, 5.2], [1.4, 5.5], [1.4, 6.0]], stonePaint(STONE, sx + sz * 3), { segments: 10, capTop: true });
        });
        c.b.withFlags({ cls: MAT.roof }, () => lathe(c.b, [tx, kh + 2.4, tz], [[1.55, 0], [1.0, 1.0], [0.3, 2.6], [0.04, 3.6]], SLATE, { segments: 10, capBottom: true }));
      }
      c.pyramid(kx, kz, kw / 2 - 0.4, kh + 0.6, 8.5);
      c.banner(kx + 1.2, kh + 7.0, kz + 0.9);
      // Keep windows: pairs of lit windows up the front and the side toward the village.
      for (let row = 0; row < 4; row++) {
        const y = 6 + row * 4.2;
        for (const off of [-2.1, 2.1]) {
          c.slit([kx + off, y, kz + kw / 2 + 0.02], [0.55, row === 3 ? 1.6 : 1.2, 0.06], row > 0 && (row + off) % 2 !== 0 ? 1 : 0.6);
          c.slit([kx + kw / 2 + 0.02, y + 0.6, kz + off], [0.06, 1.2, 0.5], row % 2 ? 1 : 0);
        }
      }
      // Hall against the back wall, to the right: walls, tall lit windows and a steep slate roof with a chimney.
      const hx = s.body.x + 7.5, hz = z0 + T / 2 + 3.2, hw2 = 13, hd2 = 6.2, hh = 12;
      c.block(hx, hz, hw2, hd2, hh, false);
      c.gableRoof(hx, hz, hw2, hd2, hh, 6.2);
      for (let k = 0; k < 4; k++) {
        const x = hx - hw2 / 2 + 1.8 + k * ((hw2 - 3.6) / 3);
        c.slit([x, 7.5, hz + hd2 / 2 + 0.02], [0.75, 2.4, 0.06], k === 2 ? 0.5 : 1);
        c.b.withFlags({ cls: MAT.stone }, () => lathe(c.b, [x, 8.7, hz + hd2 / 2 + 0.02], [[0.375, 0], [0.375, 0.04]], HOLE, { segments: 8 }));
      }
      c.b.withFlags({ cls: MAT.stone }, () => bevelBox(c.b, [hx + 3.5, hh + 2.0, hz - 1.2], [1.3, 6.5, 1.0], stonePaint(STONE_DARK, 9), { bevel: 0.06 }));
      // A small chapel turret at the hall's free gable.
      c.tower(hx + hw2 / 2 + 1.0, hz + 1.5, 1.4, hh + 4.5, 4.5, 2);
      });
      castleSolids(solids, s.x, s.z, s.yaw, padY, { x0, x1, z0, z1, T, gate: 4.6, bx: s.body.x, bz: s.body.z });
      // Coarse AO: the castle is only ever seen from far away.
      finish(ctx, s, c.b, 30, 8, 0.6, 4);
      statics.push({ material: 'solid', mesh: c.b, name: s.id, castShadow: false });
    }
    return { statics, solids, stats: { castleTriangles: statics.reduce((n, p) => n + p.mesh.triangleCount, 0), castleMs: Math.round(performance.now() - t0) } };
  },
};

/**
 * The castle's solids for the walk mode, mirroring the geometry above (site-local frame, turned by `yaw`): the curtain
 * walls, the round towers, the gatehouse, the keep and the hall. The gate itself is closed (the portcullis is down).
 */
function castleSolids(out: SolidDef[], ox: number, oz: number, yaw: number, padY: number, g: { x0: number; x1: number; z0: number; z1: number; T: number; gate: number; bx: number; bz: number }): void {
  const w = (lx: number, lz: number): [number, number] => {
    const [dx, dz] = rotateY(lx, lz, yaw);
    return [ox + dx, oz + dz];
  };
  const lo = padY - 3;
  const wall = (a: [number, number], b: [number, number]): void => {
    const [ax, az] = w(a[0], a[1]), [bx, bz] = w(b[0], b[1]);
    const sd = segmentSolid('castle-wall', ax, az, bx, bz, g.T, lo, padY + WALL + 1.5, { standable: false });
    if (sd) out.push(sd);
  };
  wall([g.x1, g.z0], [g.x0, g.z0]);
  wall([g.x0, g.z0], [g.x0, g.z1]);
  wall([g.x1, g.z1], [g.x1, g.z0]);
  wall([g.x0, g.z1], [g.bx - g.gate, g.z1]);
  wall([g.bx + g.gate, g.z1], [g.x1, g.z1]);
  const tower = (lx: number, lz: number, r: number, h: number): void => {
    const [x, z] = w(lx, lz);
    out.push(cylinderSolid('castle-tower', x, z, r, lo, padY + h, { standable: false }));
  };
  tower(g.x0, g.z0, 3.3, 15.5);
  tower(g.x1, g.z0, 3.0, 14.0);
  tower(g.x0, g.z1, 3.0, 12.5);
  tower(g.x1, g.z1, 3.1, 13.0);
  tower(g.bx - g.gate, g.z1 + 0.6, 2.5, 13.5);
  tower(g.bx + g.gate, g.z1 + 0.6, 2.5, 13.5);
  const block = (lx: number, lz: number, bw: number, bd: number, h: number): void => {
    const [x, z] = w(lx, lz);
    out.push(boxSolid('castle', x, z, yaw, bw, bd, lo, padY + h, { standable: false }));
  };
  block(g.bx, g.z1 + 0.2, 2 * g.gate - 2.4, 4.2, 11.5);
  block(g.bx - 5.5, g.bz - 2.5, 9.5, 9.5, 23);
  const hz = g.z0 + g.T / 2 + 3.2;
  block(g.bx + 7.5, hz, 13, 6.2, 18);
  tower(g.bx + 7.5 + 6.5 + 1.0, hz + 1.5, 1.4, 16.5);
}
