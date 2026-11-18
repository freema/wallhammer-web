// Containers and produce: barrels with iron hoops, slatted crates, lumpy sacks, wicker baskets, and what fills them
// (apples, pears, cabbages, carrots, turnips, cloth bolts, pots). Every generator builds at the local origin, standing
// on y = 0, front toward +z, into the builder's current transform, so callers place it with `b.with(matrix, …)`.

import type { MeshBuilder, RGB, Stream, Vec3 } from '../kit/index.ts';
import { MAT, PALETTE, VARY_RICH, VARY_SUBTLE, basis34, bevelBox, cross3, crookedBeam, lathe, norm3, mixRgb, scaleRgb, vary, varyNext } from '../kit/index.ts';
import { PROP, ball, facingFace, ironColor, lightWoodColor, ring } from './common.ts';

// --- Barrel --------------------------------------------------------------------------------------------------------------

export interface BarrelOptions {
  height?: number;
  /** Radius at the ends; the belly is ~22 % wider. */
  radius?: number;
  /** Lid on top (default true); false shows water or apples flush with the rim. */
  lid?: boolean;
  fill?: RGB;
}

/**
 * A coopered barrel: 16 flat staves (each its own shade), a belly, darker toward both ends, three or four iron hoops
 * standing proud of the wood, a lid of planks.
 */
export function barrel(b: MeshBuilder, s: Stream, o: BarrelOptions = {}): void {
  const h = o.height ?? s.nextRange(0.85, 1.0);
  const r0 = o.radius ?? s.nextRange(0.28, 0.33);
  const rm = r0 * 1.22;
  const staves = 16;
  const shades: RGB[] = [];
  const base = s.nextPick([PALETTE.timber, PALETTE.plank, PALETTE.timberLight]);
  for (let k = 0; k < staves; k++) shades.push(varyNext(base, VARY_RICH, s));
  const rows = 8;
  const profile: [number, number][] = [];
  for (let j = 0; j <= rows; j++) profile.push([r0 + (rm - r0) * Math.sin((Math.PI * j) / rows), (h * j) / rows]);
  const phase = s.nextRange(0, 1);
  b.withFlags({ cls: MAT.wood }, () => {
    lathe(b, [0, 0, 0], profile, (p, n) => {
      // Stave by the face normal (faceted: one normal per stave face).
      const a = Math.atan2(-n[2], n[0]) - phase;
      const k = ((Math.floor((a / (Math.PI * 2)) * staves) % staves) + staves) % staves;
      const ends = Math.abs(p[1] / h - 0.5) * 2;
      return scaleRgb(shades[k]!, 1.06 - 0.3 * ends * ends);
    }, { segments: staves, faceted: true, capBottom: true, phase });
    // Lid: planks across, inset.
    const lr = r0 - 0.006;
    const planks = 4;
    for (let k = 0; k < planks; k++) {
      const x0 = -lr + (2 * lr * k) / planks + 0.004, x1 = -lr + (2 * lr * (k + 1)) / planks - 0.004;
      if (o.lid === false) break;
      const pts: Vec3[] = [];
      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const x = x0 + ((x1 - x0) * i) / steps;
        pts.push([x, h + 0.004, Math.sqrt(Math.max(0, lr * lr - x * x))]);
      }
      for (let i = steps; i >= 0; i--) {
        const x = x0 + ((x1 - x0) * i) / steps;
        pts.push([x, h + 0.004, -Math.sqrt(Math.max(0, lr * lr - x * x))]);
      }
      facingFace(b, pts, [0, 1, 0], scaleRgb(vary(PALETTE.plank, VARY_RICH, s, k, 7), 0.92));
    }
    if (o.lid === false) {
      // Open: a dark surface of water or a heap of fruit just under the rim.
      lathe(b, [0, h - 0.005, 0], [[lr, 0], [lr * 0.7, 0.04], [0.0001, 0.06]], o.fill ?? PROP.waterDeep, { segments: 10, capBottom: false });
    }
  });
  // Hoops.
  const iron = ironColor(s, 1);
  b.withFlags({ cls: MAT.metal }, () => {
    for (const f of [0.1, 0.3, 0.7, 0.9]) {
      const y = h * f;
      const r = r0 + (rm - r0) * Math.sin(Math.PI * f) + 0.012;
      const w = 0.032;
      lathe(b, [0, 0, 0], [[r - 0.012, y - w], [r, y - w * 0.8], [r, y + w * 0.8], [r - 0.012, y + w]], scaleRgb(iron, 0.9 + 0.2 * f), { segments: staves, faceted: true, phase });
    }
  });
}

// --- Crate ---------------------------------------------------------------------------------------------------------------

export interface CrateOptions {
  size?: readonly [number, number, number];
  /** Open crates show their content (apples, cabbages, …); closed ones get lid slats. */
  open?: boolean;
  content?: Produce;
}

/** A slatted crate: four corner posts, three horizontal slats per side with gaps, a bottom, lid slats or content. */
export function crate(b: MeshBuilder, s: Stream, o: CrateOptions = {}): void {
  const [w, h, d] = o.size ?? [s.nextRange(0.62, 0.78), s.nextRange(0.45, 0.58), s.nextRange(0.5, 0.6)];
  const base = lightWoodColor(s, 1);
  b.withFlags({ cls: MAT.wood }, () => {
    const post = 0.075;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      bevelBox(b, [sx * (w / 2 - post / 2 - 0.02), 0, sz * (d / 2 - post / 2 - 0.02)], [post, h, post], scaleRgb(varyNext(base, VARY_RICH, s), 0.8), { bevel: 0.015 });
    }
    const slats = 3;
    const gap = 0.035;
    const sh = (h - gap * (slats - 1)) / slats;
    const t = 0.028;
    for (let k = 0; k < slats; k++) {
      const y = k * (sh + gap);
      // Front and back slats run along x, side slats along z.
      for (const sz of [-1, 1]) bevelBox(b, [0, y, sz * (d / 2 - t / 2)], [w, sh, t], varyNext(base, VARY_RICH, s), { bevel: 0.01, jitter: 0.006, stream: s });
      for (const sx of [-1, 1]) bevelBox(b, [sx * (w / 2 - t / 2), y, 0], [t, sh, d - 2 * t], varyNext(base, VARY_RICH, s), { bevel: 0.01, jitter: 0.006, stream: s });
    }
    // A diagonal brace on the front.
    crookedBeam(b, [-w / 2 + 0.06, 0.06, d / 2 + 0.012], [w / 2 - 0.06, h - 0.06, d / 2 + 0.012], scaleRgb(base, 0.85), { width: 0.06, depth: 0.022, segments: 3, irregular: 0.05, up: [0, 0, 1] });
    bevelBox(b, [0, 0.01, 0], [w - 0.04, 0.03, d - 0.04], scaleRgb(base, 0.6), { bevel: 0.008 });
    if (!o.open) {
      const lids = 4;
      for (let k = 0; k < lids; k++) {
        const x = -w / 2 + (w * (k + 0.5)) / lids;
        bevelBox(b, [x, h, 0], [w / lids - 0.025, 0.025, d], varyNext(base, VARY_RICH, s), { bevel: 0.008, jitter: 0.005, stream: s });
      }
    }
  });
  if (o.open && o.content) produceHeap(b, s, o.content, w - 0.1, d - 0.1, h - 0.12);
}

// --- Sack ----------------------------------------------------------------------------------------------------------------

/** A lumpy burlap sack, tied at the neck with a tuft above; `full` 0.6–1 changes how round it sits. */
export function sack(b: MeshBuilder, s: Stream, o: { height?: number; full?: number; color?: RGB } = {}): void {
  const h = o.height ?? s.nextRange(0.62, 0.78);
  const full = o.full ?? s.nextRange(0.7, 1);
  const r = 0.27 * (0.8 + 0.25 * full);
  const c = o.color ?? varyNext(PROP.burlap, VARY_RICH, s);
  const neck = h * 0.78;
  const profile: [number, number][] = [
    [0.0001, 0], [r * 0.85, 0.01], [r * 1.05, h * 0.12], [r * 1.12, h * 0.3], [r * (1.0 + 0.08 * full), h * 0.5],
    [r * 0.8, h * 0.65], [r * 0.42, neck - 0.04], [0.06, neck], [0.07, neck + 0.04], [0.11, neck + 0.1], [0.09, neck + 0.14], [0.0001, neck + 0.15],
  ];
  b.withFlags({ cls: MAT.fabric }, () => {
    lathe(b, [0, 0, 0], profile, (p) => {
      const t = p[1] / h;
      return scaleRgb(c, 0.72 + 0.38 * Math.min(1, t * 1.6));
    }, { segments: 9, noise: 0.07, stream: s, phase: s.nextRange(0, 1) });
    // The cord.
    ring(b, [0, neck + 0.01, 0], 0.07, 0.016, PROP.rope, 8, 4);
  });
}

// --- Basket and produce ----------------------------------------------------------------------------------------------

export type Produce = 'apples' | 'greenApples' | 'pears' | 'cabbages' | 'carrots' | 'turnips' | 'bread' | 'cloth' | 'pots';

/** A wicker basket with banded weave, a thick rim, optionally a handle arc, filled with produce. */
export function basket(b: MeshBuilder, s: Stream, o: { radius?: number; height?: number; handle?: boolean; content?: Produce } = {}): void {
  const r = o.radius ?? s.nextRange(0.22, 0.3);
  const h = o.height ?? s.nextRange(0.2, 0.3);
  const rows = 7;
  const profile: [number, number][] = [];
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    profile.push([r * (0.72 + 0.28 * Math.sin(t * Math.PI * 0.5)), h * t]);
  }
  const light = varyNext(PROP.wicker, VARY_SUBTLE, s);
  const dark = varyNext(PROP.wickerDark, VARY_SUBTLE, s);
  b.withFlags({ cls: MAT.wood }, () => {
    lathe(b, [0, 0, 0], profile, (p, n) => {
      // Woven bands: alternating rows, with a slant around.
      const band = Math.floor(p[1] / (h / rows) + 0.5) % 2;
      const a = Math.atan2(n[2], n[0]);
      return band ? mixRgb(light, dark, 0.15 + 0.1 * Math.sin(a * 6)) : mixRgb(dark, light, 0.35 + 0.1 * Math.cos(a * 6));
    }, { segments: 10, capBottom: true, phase: s.nextRange(0, 1) });
    ring(b, [0, h, 0], r, 0.026, scaleRgb(dark, 1.1), 14, 5);
    if (o.handle) {
      const arc: Vec3[] = [];
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI;
        arc.push([Math.cos(a) * r * 0.95, h + Math.sin(a) * r * 1.1, 0]);
      }
      crookedArc(b, arc, 0.022, dark);
    }
  });
  if (o.content) produceHeap(b, s, o.content, r * 1.6, r * 1.6, h - 0.05, true);
}

function crookedArc(b: MeshBuilder, path: Vec3[], radius: number, color: RGB): void {
  for (let i = 0; i < path.length - 1; i++) crookedBeam(b, path[i]!, path[i + 1]!, color, { width: radius * 2, segments: 1, irregular: 0 });
}

/** One piece of produce at a point (its bottom on `at`). Returns its height. */
export function producePiece(b: MeshBuilder, s: Stream, kind: Produce, at: readonly number[]): number {
  switch (kind) {
    case 'apples':
    case 'greenApples': {
      const base = kind === 'apples' ? (s.next() < 0.75 ? PALETTE.apple : PROP.appleGreen) : (s.next() < 0.8 ? PROP.appleGreen : PALETTE.apple);
      const c = varyNext(base, VARY_RICH, s);
      const r = s.nextRange(0.045, 0.06);
      b.withFlags({ cls: MAT.generic }, () => ball(b, [at[0]!, at[1]! + r, at[2]!], r, (p) => (p[1] > r * 1.5 ? scaleRgb(c, 1.15) : c), { segments: 5, rows: 3, squash: 0.92, phase: s.next() }));
      return r * 1.85;
    }
    case 'pears': {
      const c = varyNext(PROP.pear, VARY_RICH, s);
      b.withFlags({ cls: MAT.generic }, () => lathe(b, [at[0]!, at[1]!, at[2]!], [[0.0001, 0], [0.045, 0.012], [0.055, 0.04], [0.04, 0.08], [0.025, 0.11], [0.0001, 0.125]], c, { segments: 5, phase: s.next() }));
      return 0.12;
    }
    case 'cabbages': {
      const c = varyNext(PALETTE.cabbage, VARY_RICH, s);
      const r = s.nextRange(0.09, 0.12);
      b.withFlags({ cls: MAT.foliage }, () => {
        ball(b, [at[0]!, at[1]! + r, at[2]!], r, (p) => scaleRgb(mixRgb(c, PROP.greens, 0.3), 0.85 + 0.4 * Math.min(1, p[1] / (2 * r))), { segments: 7, rows: 4, squash: 0.95 });
        // Outer leaves: four cupped petals.
        const ph = s.nextRange(0, Math.PI);
        for (let k = 0; k < 4; k++) {
          const a = ph + (k * Math.PI) / 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          const P = (u: number, v: number): Vec3 => [at[0]! + ca * (r * 0.5 + u * r * 0.9) - sa * v * r * 0.8, at[1]! + 0.02 + u * r * 1.2 - u * u * r * 0.4, at[2]! + sa * (r * 0.5 + u * r * 0.9) + ca * v * r * 0.8];
          const leaf = scaleRgb(c, 0.75);
          facingFace(b, [P(0, -0.6), P(1, -0.9), P(1.15, 0), P(1, 0.9), P(0, 0.6)], [ca, 0.5, sa], leaf);
          facingFace(b, [P(0, -0.6), P(1, -0.9), P(1.15, 0), P(1, 0.9), P(0, 0.6)], [-ca, -0.5, -sa], scaleRgb(leaf, 0.7));
        }
      });
      return r * 1.9;
    }
    case 'carrots': {
      // A bunch of three: orange roots lying side by side, green tops.
      const yaw = s.nextRange(0, Math.PI * 2);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      for (let k = 0; k < 3; k++) {
        const off = (k - 1) * 0.045;
        const x0 = at[0]! - sy * off, z0 = at[2]! + cy * off;
        const tip: Vec3 = [x0 + cy * 0.18, at[1]! + 0.03, z0 + sy * 0.18];
        const head: Vec3 = [x0 - cy * 0.04, at[1]! + 0.035, z0 - sy * 0.04];
        const c = varyNext(PROP.carrot, VARY_SUBTLE, s);
        // The root: a five-sided taper from the head to the tip (many of them lie in heaps, so they stay cheap).
        const dir = norm3([tip[0] - head[0], tip[1] - head[1], tip[2] - head[2]]);
        const side = norm3(cross3(dir, [0, 1, 0]));
        b.withFlags({ cls: MAT.generic }, () =>
          b.with(basis34(side, dir, cross3(side, dir), head), () =>
            lathe(b, [0, 0, 0], [[0.0001, -0.005], [0.024, 0.01], [0.018, 0.08], [0.0001, 0.22]], (p) => scaleRgb(c, 0.85 + 0.25 * Math.max(0, 1 - p[1] / 0.2)), { segments: 5, phase: s.next(), faceted: true }),
          ),
        );
        // The leafy top: two crossed blades, both faces.
        b.withFlags({ cls: MAT.foliage, sway: 0.3 }, () => {
          const top: Vec3 = [head[0] - cy * 0.13, head[1] + 0.05 + s.nextRange(0, 0.04), head[2] - sy * 0.13];
          const g = varyNext(PROP.greens, VARY_RICH, s);
          for (const [ox, oz, oy] of [[-sy * 0.04, cy * 0.04, 0], [0, 0, 0.035]] as const) {
            const blade: Vec3[] = [[head[0] - ox * 0.3, head[1] - oy * 0.3, head[2] - oz * 0.3], [head[0] + ox * 0.3, head[1] + oy * 0.3, head[2] + oz * 0.3], [top[0] + ox, top[1] + oy, top[2] + oz], [top[0] - ox, top[1] - oy, top[2] - oz]];
            facingFace(b, blade, [0, 1, 0.01], g);
            facingFace(b, blade, [0, -1, -0.01], scaleRgb(g, 0.75));
          }
        });
      }
      return 0.07;
    }
    case 'turnips': {
      const r = s.nextRange(0.05, 0.065);
      b.withFlags({ cls: MAT.generic }, () => {
        lathe(b, [at[0]!, at[1]!, at[2]!], [[0.0001, 0], [r * 0.4, r * 0.25], [r, r * 0.9], [r * 0.9, r * 1.4], [r * 0.3, r * 1.75], [0.0001, r * 1.8]], (p) => mixRgb(PROP.turnip, PROP.turnipTop, Math.min(1, Math.max(0, (p[1] - at[1]! - r * 0.9) / (r * 0.8)))), { segments: 6, phase: s.next() });
      });
      b.withFlags({ cls: MAT.foliage, sway: 0.4 }, () => crookedBeam(b, [at[0]!, at[1]! + r * 1.7, at[2]!], [at[0]! + s.nextJitter(0.05), at[1]! + r * 1.7 + 0.08, at[2]! + s.nextJitter(0.05)], PROP.greens, { width: 0.03, depth: 0.012, segments: 2 }));
      return r * 1.8;
    }
    case 'bread': {
      const c = varyNext(PROP.bread, VARY_RICH, s);
      b.withFlags({ cls: MAT.generic }, () => ball(b, [at[0]!, at[1]! + 0.06, at[2]!], 0.08, (p) => (p[1] > at[1]! + 0.07 ? scaleRgb(c, 1.1) : scaleRgb(c, 0.8)), { segments: 7, rows: 4, squash: 0.6 }));
      return 0.07;
    }
    case 'cloth': {
      // A folded bolt of cloth: a rounded slab, folds as lighter edges.
      const c = varyNext(s.nextPick([PALETTE.fabricRed, PALETTE.fabricBlue, PALETTE.fabricGreen, PROP.linen, PALETTE.gold, PROP.wool]), VARY_SUBTLE, s);
      const th = s.nextRange(0.06, 0.09);
      b.withFlags({ cls: MAT.fabric }, () => bevelBox(b, at, [0.36, th, 0.26], c, { bevel: 0.025, edgeLight: 1.2, jitter: 0.01, stream: s }));
      return th;
    }
    case 'pots': {
      const c = varyNext(s.next() < 0.6 ? PROP.clay : PROP.clayLight, VARY_RICH, s);
      const k = s.nextRange(0.8, 1.2);
      b.withFlags({ cls: MAT.generic }, () => lathe(b, [at[0]!, at[1]!, at[2]!], [[0.0001, 0], [0.06 * k, 0], [0.1 * k, 0.07 * k], [0.09 * k, 0.15 * k], [0.05 * k, 0.2 * k], [0.06 * k, 0.24 * k], [0.04 * k, 0.24 * k], [0.035 * k, 0.21 * k]], (p) => (p[1] - at[1]! > 0.2 * k ? scaleRgb(c, 0.6) : c), { segments: 9, phase: s.next() }));
      return 0.24 * k;
    }
  }
}

/**
 * A heap of produce filling a w × d area at height y0 (a dome of pieces, higher in the middle). `round` fills a disc.
 */
export function produceHeap(b: MeshBuilder, s: Stream, kind: Produce, w: number, d: number, y0: number, round = false): void {
  const step = kind === 'cabbages' ? 0.2 : kind === 'cloth' ? 0.28 : kind === 'carrots' ? 0.16 : kind === 'pots' ? 0.2 : 0.1;
  // A base fill (dark, under the pieces) so no gaps show.
  const fillColor = kind === 'cabbages' || kind === 'carrots' ? scaleRgb(PROP.greens, 0.6) : kind === 'cloth' || kind === 'pots' ? scaleRgb(PALETTE.plank, 0.6) : scaleRgb(kind === 'pears' ? PROP.pear : kind === 'turnips' ? PROP.turnip : kind === 'bread' ? PROP.bread : PALETTE.apple, 0.55);
  if (kind !== 'cloth' && kind !== 'pots') {
    b.withFlags({ cls: kind === 'cabbages' ? MAT.foliage : MAT.generic }, () => {
      if (round) lathe(b, [0, y0 - 0.02, 0], [[w / 2, 0], [w * 0.35, 0.04], [0.0001, 0.06]], fillColor, { segments: 10 });
      else bevelBox(b, [0, y0 - 0.03, 0], [w, 0.06, d], fillColor, { bevel: 0.02, taper: 0.8 });
    });
  }
  const nx = Math.max(1, Math.floor(w / step)), nz = Math.max(1, Math.floor(d / step));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const u = (i + 0.5) / nx - 0.5, v = (j + 0.5) / nz - 0.5;
      if (round && u * u + v * v > 0.25) continue;
      const x = u * w + s.nextJitter(step * 0.15), z = v * d + s.nextJitter(step * 0.15);
      const dome = (1 - Math.min(1, (u * u + v * v) * 4)) * step * 0.6;
      producePiece(b, s, kind, [x, y0 + dome * (kind === 'cloth' ? 0 : 1), z]);
    }
  }
  // A second layer for stackable goods.
  if (kind === 'apples' || kind === 'greenApples' || kind === 'turnips' || kind === 'pears') {
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < nz - 1; j++) {
        const u = (i + 1) / nx - 0.5, v = (j + 1) / nz - 0.5;
        if (u * u + v * v > 0.12) continue;
        producePiece(b, s, kind, [u * w, y0 + step * 0.55 + (1 - (u * u + v * v) * 8) * step * 0.25, v * d]);
      }
    }
  }
  if (kind === 'cloth') {
    // Stacks of bolts: a second and third on top, turned a little.
    for (let k = 1; k < 3; k++) producePiece(b, s, 'cloth', [s.nextJitter(0.04), y0 + k * 0.075, s.nextJitter(0.04)]);
  }
}
