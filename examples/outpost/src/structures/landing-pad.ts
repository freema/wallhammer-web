// The octagonal landing pad: a raised concrete deck with a sloped skirt, a dark top inside a light rim with orange
// edge segments, a ramp down from the front edge, painted markings (an orange ring, white corner brackets and a cross
// in the middle) and a light post on every corner (instanced). Built at the local origin, ground at y = 0, one flat
// side facing +z (where the ramp is).

import type { MeshBuilder } from '../kit/mesh.ts';
import { compose, place, rotateX } from '../kit/math.ts';
import type { V3 } from '../kit/math.ts';
import { box, cylinder, panelGrid, polygon, ring, wedge } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

export interface PadOptions {
  /** Circumradius of the deck octagon. */
  radius: number;
  /** Deck height above the ground. */
  height: number;
  /** Ramp width and run. */
  rampW: number;
  rampRun: number;
}

export const PAD: Omit<PadOptions, 'radius'> = { height: 0.7, rampW: 5, rampRun: 3.6 };

const PHASE = Math.PI / 8;

/** Apothem of the deck (distance from the centre to a flat side). */
export function padApothem(o: PadOptions): number {
  return o.radius * Math.cos(PHASE);
}

/** Deck, skirt, rim and ramp (solid). */
export function landingPad(b: MeshBuilder, o: PadOptions): void {
  const H = o.height;
  const foot = ring(8, o.radius + 0.55, -0.25, PHASE);
  const edge = ring(8, o.radius, H, PHASE);
  const inner = ring(8, o.radius - 0.6, H, PHASE);
  // Sloped skirt.
  b.paint(rgb('concrete'));
  for (let k = 0; k < 8; k++) {
    const k1 = (k + 1) % 8;
    polygon(b, [foot[k]!, foot[k1]!, edge[k1]!, edge[k]!]);
  }
  // Light rim and the dark deck.
  b.paint(rgb('shellPanel'));
  for (let k = 0; k < 8; k++) {
    const k1 = (k + 1) % 8;
    polygon(b, [edge[k]!, edge[k1]!, inner[k1]!, inner[k]!]);
  }
  b.paint(rgb('padAsphalt'));
  polygon(b, inner);
  // Ramp down from the front side (+z).
  const a = padApothem(o);
  b.paint(rgb('concrete'));
  b.with(place(0, -0.25, a + o.rampRun / 2 + 0.2), () => wedge(b, o.rampW, o.rampRun + 0.4, H + 0.25));
  // Tread lines across the ramp: a lined sheet just over its slope.
  const run = o.rampRun + 0.4, rise = H + 0.25, slope = Math.atan2(rise, run);
  const outline = b.outline;
  b.outline = false;
  b.with(compose(place(0, -0.25, a + run), rotateX(-(Math.PI / 2 - slope)), place(0, 0, 0.02)), () => panelGrid(b, o.rampW - 0.1, Math.hypot(rise, run), 1, 9));
  b.paint(rgb('orange'));
  for (const s of [-1, 1]) b.with(compose(place(s * (o.rampW / 2 - 0.25), -0.25, a + run), rotateX(-(Math.PI / 2 - slope)), place(0, 0, 0.025)), () => panelGrid(b, 0.22, Math.hypot(rise, run), 1, 1));
  b.outline = outline;
  b.paint(rgb('concreteDark'));
  for (const s of [-1, 1]) b.with(place((s * (o.rampW + 0.3)) / 2, -0.25, a + o.rampRun / 2 + 0.2), () => wedge(b, 0.3, o.rampRun + 0.4, H + 0.25 + 0.12));
}

/** Painted markings and the orange edge segments (a decal over the deck top). */
export function padMarkings(b: MeshBuilder, o: PadOptions): void {
  const y = o.height + 0.012;
  const flat = (pts: [number, number][]): V3[] => pts.map(([x, z]) => [x, y, z] as V3);
  // Orange segments in the middle of every rim side.
  b.paint(rgb('orange'));
  const edge = ring(8, o.radius - 0.05, y, PHASE), inner = ring(8, o.radius - 0.55, y, PHASE);
  for (let k = 0; k < 8; k++) {
    const k1 = (k + 1) % 8;
    const lerp = (p: V3, q: V3, t: number): V3 => [p[0] + (q[0] - p[0]) * t, y, p[2] + (q[2] - p[2]) * t];
    polygon(b, [lerp(edge[k]!, edge[k1]!, 0.3), lerp(edge[k]!, edge[k1]!, 0.7), lerp(inner[k]!, inner[k1]!, 0.7), lerp(inner[k]!, inner[k1]!, 0.3)]);
  }
  // The orange ring: a band of quads.
  const n = 48, r0 = o.radius * 0.5, r1 = o.radius * 0.57;
  for (let k = 0; k < n; k++) {
    const t0 = (k / n) * Math.PI * 2, t1 = ((k + 1) / n) * Math.PI * 2;
    const P = (r: number, t: number): V3 => [r * Math.sin(t), y, r * Math.cos(t)];
    polygon(b, [P(r1, t0), P(r1, t1), P(r0, t1), P(r0, t0)], false);
  }
  // White corner brackets round a square, and a cross in the middle.
  b.paint(rgb('marking'));
  const s = o.radius * 0.3, t = 0.24, l = o.radius * 0.13;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * s, cz = sz * s;
      // An L: one arm along x and one along z from the corner, pointing inward.
      polygon(b, flat(sqr(cx - (sx * l) / 2, cz, l, t)), false);
      polygon(b, flat(sqr(cx, cz - (sz * l) / 2, t, l)), false);
    }
  }
  polygon(b, flat(sqr(0, 0, o.radius * 0.26, 0.26)), false);
  polygon(b, flat(sqr(0, 0, 0.26, o.radius * 0.26)), false);
}

/** A rectangle centred at (cx, cz), `w` along x, `d` along z, counter-clockwise seen from above. */
function sqr(cx: number, cz: number, w: number, d: number): [number, number][] {
  return [[cx - w / 2, cz + d / 2], [cx + w / 2, cz + d / 2], [cx + w / 2, cz - d / 2], [cx - w / 2, cz - d / 2]];
}

/** Corner points of the deck where the light posts stand (local, on the rim). */
export function padLightSpots(o: PadOptions): V3[] {
  return ring(8, o.radius - 0.3, o.height, PHASE);
}

/** One edge light post: a dark post and an orange beacon. */
export function padLight(b: MeshBuilder): void {
  b.paint(rgb('metal'));
  box(b, [0.16, 0.55, 0.16]);
  b.paint(rgb('orange'));
  b.with(place(0, 0.55, 0), () => cylinder(b, 0.16, 0.22, { segments: 10, rTop: 0.12 }));
}
