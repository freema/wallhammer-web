// A habitat dome: a short cylindrical wall on a concrete plinth, optionally a sloped shoulder ring above it (the
// two-tier central dome: the window band sits on the shoulder), a segmented cap with meridian seams and one ring seam,
// a hatch ring on top (or a flat cut for a roof platform), a band of teal windows, orange stripes painted over the cap
// and concrete footings round the base. Built at the local origin (ground at y = 0, axis +y); place it with
// `b.with(place(x, y, z, yaw), ...)`.
//
// `capPoint` and `shellRadiusAt` give the shell's shape to other builders (a corridor that meets the shell, a door
// frame that sits on it, a roof platform on the cut top).

import type { MeshBuilder } from '../kit/mesh.ts';
import { place } from '../kit/math.ts';
import { capBand, curvedPanel, cylinder, frustumBox, lathe } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

export interface DomeShape {
  /** Radius of the wall. */
  radius: number;
  /** Height of the wall (above the ground). */
  wallH: number;
  /** Height of the cap above the wall (above the shoulder when there is one). */
  capH: number;
  /** A sloped ring between the wall and the cap: `h` high, its top `inset` metres in from the wall. */
  shoulder?: { h: number; inset: number };
}

export interface DomeStripe {
  /** Meridian angle (θ from +z toward +x). */
  angle: number;
  /** Share of the cap meridian the stripe covers (0 at the cap foot, 1 at the top). Default 0.02..0.985. */
  from?: number;
  to?: number;
}

export interface DomeOptions extends DomeShape {
  /** Meridian seams of the cap. Default 12. */
  ribs?: number;
  /**
   * Window band: centre angles (radians, θ from +z toward +x), each window `width` m wide, from y0 to y1. On the wall
   * by default; `on: 'shoulder'` puts them on the sloped shoulder (y0, y1 then within it).
   */
  windows?: { angles: readonly number[]; width: number; y0: number; y1: number; panes?: number; on?: 'wall' | 'shoulder' };
  /** Orange stripes over the cap; `stripeWidth` metres wide (default 0.13 × radius). */
  stripes?: readonly (number | DomeStripe)[];
  stripeWidth?: number;
  /** Orange bars along a parallel of the cap (the cross bar of a stripe): at cap share `t`, from angle `from` to `to`. */
  bars?: readonly { t: number; from: number; to: number }[];
  /** Concrete footings round the base. Default 8. */
  footings?: number;
  /** Radius of the top opening as a share of the radius. Default 0.17. */
  hatch?: number;
  /** 'hatch' (a raised ring with a lid, the default) or 'flat' (a flat lid at the cut: a platform stands on it). */
  top?: 'hatch' | 'flat';
  /** Shoulder seams (vertical lines on the sloped ring). Default 2 × ribs. */
  shoulderRibs?: number;
  /** Angle ranges kept free of footings (where a corridor or a door meets the wall): centre and half width, radians. */
  keepFree?: readonly { angle: number; half: number }[];
}

/** Angular distance of two angles, 0..π. */
export function angleGap(a: number, c: number): number {
  const d = Math.abs((((a - c) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  return d;
}

/** Height of the concrete plinth under the wall. */
const PLINTH = 0.32;

/** Radius and height where the cap starts (the top of the shoulder, or of the wall). */
function capBase(s: DomeShape): [number, number] {
  return s.shoulder ? [s.radius - s.shoulder.inset, s.wallH + s.shoulder.h] : [s.radius, s.wallH];
}

/** A point of the cap profile, t from 0 (the cap foot) to 1 (the apex): [radius, y]. */
export function capPoint(s: DomeShape, t: number): [number, number] {
  const a = t * (Math.PI / 2);
  const [r0, y0] = capBase(s);
  return [r0 * Math.cos(a), y0 + s.capH * Math.sin(a)];
}

/** Horizontal radius of the shell at height y (wall, shoulder, cap; 0 above the apex). */
export function shellRadiusAt(s: DomeShape, y: number): number {
  if (y <= s.wallH) return s.radius;
  const [r0, y0] = capBase(s);
  if (s.shoulder && y <= y0) return s.radius - (s.shoulder.inset * (y - s.wallH)) / s.shoulder.h;
  const q = (y - y0) / s.capH;
  return q >= 1 ? 0 : r0 * Math.sqrt(1 - q * q);
}

/** Height of the cut top of the cap (where the hatch ring or the roof platform sits). */
export function domeTop(s: DomeShape, hatch = 0.17): number {
  const [r0, y0] = capBase(s);
  const q = Math.min(0.999, (hatch * s.radius) / r0);
  return y0 + s.capH * Math.sqrt(1 - q * q);
}

export function dome(b: MeshBuilder, o: DomeOptions): void {
  const R = o.radius;
  const ribs = o.ribs ?? 12;
  const seg = ribs * 4;
  const hatchR = (o.hatch ?? 0.17) * R;
  const [r0, y0] = capBase(o);

  // Plinth, wall and shoulder.
  b.paint(rgb('concrete'));
  cylinder(b, R + 0.1, PLINTH, { segments: seg, top: true });
  b.paint(rgb('shell'));
  lathe(b, [[R, PLINTH], [R, o.wallH]], { segments: seg, rings: [0, 1] });
  if (o.shoulder) lathe(b, [[R, o.wallH], [r0, y0]], { segments: seg, rings: [0, 1], ribs: o.shoulderRibs ?? ribs * 2 });

  // Cap up to the top opening, seams at the start and halfway up.
  const tEnd = Math.acos(Math.min(0.999, hatchR / r0)) / (Math.PI / 2);
  const steps = 14;
  const profile: [number, number][] = [];
  for (let i = 0; i <= steps; i++) profile.push(capPoint(o, (tEnd * i) / steps));
  lathe(b, profile, { segments: seg, ribs, rings: [0, Math.round(steps * 0.45)] });

  const top = profile[steps]![1];
  if ((o.top ?? 'hatch') === 'hatch') {
    b.paint(rgb('shellPanel'));
    b.with(place(0, top - 0.05, 0), () => cylinder(b, hatchR, 0.32, { segments: 20, ribs: 0 }));
    b.paint(rgb('metalMid'));
    b.with(place(0, top + 0.27, 0), () => cylinder(b, hatchR * 0.55, 0.12, { segments: 16 }));
  } else {
    b.paint(rgb('shellPanel'));
    b.with(place(0, top - 0.02, 0), () => cylinder(b, hatchR, 0.04, { segments: seg }));
  }

  // Painted stripes and windows: decals on the shell, no hull of their own.
  const outline = b.outline;
  b.outline = false;
  b.paint(rgb('orange'));
  for (const s of o.stripes ?? []) {
    const st: DomeStripe = typeof s === 'number' ? { angle: s } : s;
    capBand(b, (t) => capPoint(o, t * tEnd), st.angle, o.stripeWidth ?? 0.13 * R, st.from ?? 0.02, st.to ?? 0.985, { lift: 0.025 });
  }
  for (const bar of o.bars ?? []) {
    // Two profile points `width` apart along the meridian, lifted off the shell along its normal.
    const width = o.stripeWidth ?? 0.13 * R;
    const e = 1e-3;
    const [ra, ya] = capPoint(o, bar.t - e), [rb, yb] = capPoint(o, bar.t + e);
    const l = Math.hypot(rb - ra, yb - ya);
    const tr = (rb - ra) / l, ty = (yb - ya) / l;
    const [rc, yc] = capPoint(o, bar.t);
    const lift = 0.03;
    const p0: [number, number] = [rc - (tr * width) / 2 + ty * lift, yc - (ty * width) / 2 - tr * lift];
    const p1: [number, number] = [rc + (tr * width) / 2 + ty * lift, yc + (ty * width) / 2 - tr * lift];
    lathe(b, [p0, p1], { from: bar.from, to: bar.to, segments: Math.max(4, Math.ceil(((bar.to - bar.from) * rc) / 0.4)), rings: [0, 1] });
  }
  if (o.windows) {
    const w = o.windows;
    const onShoulder = w.on === 'shoulder' && o.shoulder;
    // Radius at a height: the wall, or the sloped shoulder.
    const rAt = (y: number): number => (onShoulder ? shellRadiusAt(o, y) : R);
    const fy0 = w.y0 - 0.12, fy1 = w.y1 + 0.12;
    for (const a of w.angles) {
      const rm = rAt((w.y0 + w.y1) / 2);
      const half = w.width / 2 / rm;
      b.paint(rgb('shellPanel'));
      curvedPanel(b, rAt(fy0) + 0.015, a - half - 0.12 / rm, a + half + 0.12 / rm, fy0, fy1, { panes: 1, rTop: rAt(fy1) + 0.015 });
      b.paint(rgb('teal'));
      curvedPanel(b, rAt(w.y0) + 0.03, a - half, a + half, w.y0, w.y1, { panes: w.panes ?? 2, rTop: rAt(w.y1) + 0.03 });
    }
  }
  b.outline = outline;

  // Footings: tapered concrete blocks against the plinth, facing out.
  const n = o.footings ?? 8;
  b.paint(rgb('concrete'));
  for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) / n) * Math.PI * 2;
    if ((o.keepFree ?? []).some((f) => angleGap(a, f.angle) < f.half + 0.08)) continue;
    b.with(place(Math.sin(a) * (R + 0.35), 0, Math.cos(a) * (R + 0.35), a), () => frustumBox(b, [0.9, 1.1], [0.55, 0.5], 0.85, { shift: [0, -0.22] }));
  }
}
