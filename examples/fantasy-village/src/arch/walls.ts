// Plastered walls of the architecture kit: the infill between the timbers, as a grid on the wall plane with holes for
// the openings. The surface is not flat: it bulges and sinks a little (hand-laid plaster), its colour drifts between
// cream and warm patches and darkens toward the foot. A `top` profile lets the same generator fill a gable under a
// curved roof. Plank cladding (for gables of sheds, dormer cheeks) is here as well.

import type { RGB } from '../kit/index.ts';
import { MAT, bevelBox, clamp } from '../kit/index.ts';
import { valueNoise2 } from 'wallhammer-web/gen-core';
import type { Opening, Site, Wall } from './site.ts';
import { insideOpening, plasterColor, woodPaint } from './site.ts';

export interface PlasterOptions {
  /** Height of the wall (or the most it reaches when `top` is given). */
  height: number;
  /** Top of the wall at a position along it (gables). Should be piecewise linear between `breaks`. */
  top?: (u: number) => number;
  /** Extra grid columns (u) where `top` bends (the ridge of a gable). */
  breaks?: readonly number[];
  /** Range along the wall (default 0 to the wall length). */
  from?: number;
  to?: number;
  /** Start height (default 0). */
  bottom?: number;
  openings?: readonly Opening[];
  /** Grid cell (default 0.5 m) and the most the surface moves in and out (default 0.035 m). */
  cell?: number;
  bulge?: number;
  /** Seed of the mottling (default from the stream). */
  seed?: number;
  /** How much darker the foot is (default 0.22). */
  footDark?: number;
}

/** A plastered wall in its wall frame (see `plasterPanel`). */
export function plasterWall(site: Site, wall: Wall, o: PlasterOptions): void {
  site.onWall(wall, (w) => plasterPanel(w, { to: wall.length, ...o }));
}

/** Plaster in the current wall frame: a grid on w ≈ 0 facing +w, holes at the openings. */
export function plasterPanel(site: Site, o: PlasterOptions & { to: number }): void {
  const b = site.b;
  const cell = o.cell ?? 0.5;
  const bulge = o.bulge ?? 0.035;
  const seed = o.seed ?? ((site.s.next() * 1e6) | 0);
  const from = o.from ?? 0, to = o.to;
  const bottom = o.bottom ?? 0;
  const openings = o.openings ?? [];
  const top = o.top ?? (() => o.height);
  // Grid lines: regular steps plus every opening edge and every break, so holes are cut exactly.
  const lines = (a: number, z: number, extra: number[]): number[] => {
    const out = [a, z, ...extra.filter((x) => x > a + 1e-3 && x < z - 1e-3)];
    const n = Math.max(1, Math.round((z - a) / cell));
    for (let k = 1; k < n; k++) out.push(a + ((z - a) * k) / n);
    out.sort((p, q) => p - q);
    return out.filter((x, i) => i === 0 || x - out[i - 1]! > 0.02);
  };
  const us = lines(from, to, [...openings.flatMap((q) => [q.u0, q.u1]), ...(o.breaks ?? [])]);
  const vs = lines(bottom, o.height, openings.flatMap((q) => [q.v0, q.v1]));
  // The surface: a slow bulge, pinned near the wall ends and the openings so timbers and frames sit tight.
  const w = (u: number, v: number): number => {
    const pin = clamp(Math.min(u - from, to - u, v - bottom + 0.3) / 0.6, 0, 1);
    return (valueNoise2(u, v, 1.4, seed + 7) - 0.5) * 2 * bulge * pin - 0.01;
  };
  const color = (u: number, v: number): RGB => plasterColor(site.pal, u, v, seed, o.footDark);
  b.withFlags({ cls: MAT.plaster }, () => {
    for (let i = 0; i < us.length - 1; i++) {
      const u0 = us[i]!, u1 = us[i + 1]!;
      const t0 = top(u0), t1 = top(u1);
      for (let j = 0; j < vs.length - 1; j++) {
        const v0 = vs[j]!, v1 = vs[j + 1]!;
        if (v0 >= Math.max(t0, t1) - 1e-3) break;
        if (insideOpening(openings, (u0 + u1) / 2, (v0 + v1) / 2)) continue;
        const a0 = Math.max(v0, Math.min(v1, t0)), a1 = Math.max(v0, Math.min(v1, t1));
        const pts: number[][] = [[u0, v0, w(u0, v0)], [u1, v0, w(u1, v0)]];
        if (a1 > v0 + 1e-3) pts.push([u1, a1, w(u1, a1)]);
        if (a0 > v0 + 1e-3) pts.push([u0, a0, w(u0, a0)]);
        if (pts.length < 3) continue;
        b.face(pts, pts.map((p) => color(p[0]!, p[1]!)));
      }
    }
  });
}

export interface PlankOptions {
  /** Range along the wall, bottom and top height (top may follow a profile like the plaster's). */
  from: number;
  to: number;
  bottom: number;
  top: (u: number) => number;
  /** Plank width (default 0.28) and thickness (default 0.07). */
  width?: number;
  thick?: number;
  /** Colour (default the palette's plank). */
  color?: RGB;
}

/** Vertical plank cladding in a wall frame (gables of sheds, dormer cheeks, lean-tos): planks of varied colour and length. */
export function planks(site: Site, o: PlankOptions): void {
  const width = o.width ?? 0.28, thick = o.thick ?? 0.07;
  const n = Math.max(1, Math.round((o.to - o.from) / width));
  const pw = (o.to - o.from) / n;
  site.b.withFlags({ cls: MAT.wood }, () => {
    for (let k = 0; k < n; k++) {
      const uc = o.from + pw * (k + 0.5);
      const t = Math.min(o.top(uc - pw / 2), o.top(uc + pw / 2));
      const h = t - o.bottom + site.s.nextJitter(0.04);
      if (h < 0.1) continue;
      const c = site.tone(o.color ?? site.pal.plank, { hue: 0.02, sat: 0.14, val: 0.2 });
      bevelBox(site.b, [uc, o.bottom - 0.02, thick / 2 - 0.02 + site.s.nextJitter(0.01)], [pw - 0.02, h, thick], woodPaint(c), {
        bevel: 0.015,
        jitter: 0.012,
        stream: site.s,
        noBottom: true,
      });
    }
  });
}
