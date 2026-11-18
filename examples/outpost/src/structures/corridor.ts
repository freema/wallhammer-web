// A tubular corridor between two domes: a straight tube with ring seams, raised on tapered concrete legs, with orange
// rings (instanced, see `corridorRingMesh`). The tube ends inside both shells: `shellJoint` finds, from the shell
// profile of a dome, how far from the dome axis the tube end must stop so that its whole end circle is inside the
// shell (no gap), and where the tube first touches the shell from outside (the visible joint, where a ring sits).
//
// Coordinates: the corridor is built in world space from its plan (`CorridorPlan`), because each end belongs to a
// different dome.

import type { MeshBuilder } from '../kit/mesh.ts';
import { compose, place, rotateX } from '../kit/math.ts';
import type { Mat, V3 } from '../kit/math.ts';
import { cylinder, frameAlong, frustumBox, lathe } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';
import { shellRadiusAt } from './dome.ts';
import type { DomeShape } from './dome.ts';

/** Samples round the end circle in the joint search and in the check. */
const CIRCLE = 64;

export interface ShellJoint {
  /** Distance from the dome axis at which the tube end circle lies wholly inside the shell (`margin` inside). */
  inside: number;
  /** Distance from the dome axis at which the tube surface first meets the shell from outside. */
  touch: number;
}

/**
 * Where a horizontal tube of radius `r`, axis `axisY` over the dome's ground, meets the shell of `s`. Every point of the
 * end circle (lateral offset q, height y) is inside the shell while its horizontal distance from the axis,
 * √(d² + q²), is below the shell radius at y. Throws when the tube is too big for the shell.
 */
export function shellJoint(s: DomeShape, axisY: number, r: number, margin = 0.06): ShellJoint {
  let inside = Infinity, touch = 0;
  for (let k = 0; k < CIRCLE; k++) {
    const a = (k / CIRCLE) * Math.PI * 2;
    const q = r * Math.cos(a), y = axisY + r * Math.sin(a);
    const R = shellRadiusAt(s, y);
    if (R - margin <= Math.abs(q)) throw new Error(`corridor tube (r ${r}, axis ${axisY}) does not fit the shell`);
    inside = Math.min(inside, Math.sqrt((R - margin) ** 2 - q * q));
    touch = Math.max(touch, Math.sqrt(R * R - q * q));
  }
  return { inside, touch };
}

/**
 * Largest gap between a tube end circle and the shell: for every point of the circle, how far its horizontal distance
 * from the dome axis exceeds the shell radius at its height (positive: outside the shell, a visible gap).
 */
export function endGap(s: DomeShape, axisY: number, r: number, d: number): number {
  let worst = -Infinity;
  for (let k = 0; k < CIRCLE * 2; k++) {
    const a = (k / (CIRCLE * 2)) * Math.PI * 2;
    const q = r * Math.cos(a), y = axisY + r * Math.sin(a);
    worst = Math.max(worst, Math.hypot(d, q) - shellRadiusAt(s, y));
  }
  return worst;
}

export interface CorridorEndPlan {
  /** The dome centre on the ground (x, ground y, z) and its shape. */
  at: V3;
  shape: DomeShape;
  joint: ShellJoint;
  /** Azimuth of the corridor seen from this dome (θ from +z toward +x). */
  azimuth: number;
}

export interface CorridorPlan {
  name: string;
  a: CorridorEndPlan;
  c: CorridorEndPlan;
  axisY: number;
  radius: number;
  /** Unit direction from a to c (horizontal). */
  dir: V3;
  /** Distance between the dome axes. */
  span: number;
  /** World points where the tube starts and ends (inside the shells), on the axis. */
  start: V3;
  end: V3;
  /** Distances along the axis from `a` of the rings and of the legs. */
  rings: number[];
  legs: number[];
}

export function planCorridor(name: string, a: { at: V3; shape: DomeShape }, c: { at: V3; shape: DomeShape }, axisY: number, radius: number): CorridorPlan {
  const dx = c.at[0] - a.at[0], dz = c.at[2] - a.at[2];
  const span = Math.hypot(dx, dz);
  const dir: V3 = [dx / span, 0, dz / span];
  const ja = shellJoint(a.shape, axisY, radius), jc = shellJoint(c.shape, axisY, radius);
  // The tube runs level at the axis height over the lower of the two dome grounds (domes stand on flattened pads).
  const y = Math.min(a.at[1], c.at[1]) + axisY;
  const start: V3 = [a.at[0] + dir[0] * ja.inside, y, a.at[2] + dir[2] * ja.inside];
  const end: V3 = [a.at[0] + dir[0] * (span - jc.inside), y, a.at[2] + dir[2] * (span - jc.inside)];
  // Rings: one next to each joint and one every ~5.5 m between; legs between the rings, clear of the joints.
  const r0 = ja.touch + 0.55, r1 = span - jc.touch - 0.55;
  const rings = [r0];
  const nMid = Math.max(0, Math.round((r1 - r0) / 5.5) - 1);
  for (let k = 1; k <= nMid; k++) rings.push(r0 + ((r1 - r0) * k) / (nMid + 1));
  if (r1 - r0 > 1.2) rings.push(r1);
  const legs: number[] = [];
  for (let k = 0; k + 1 < rings.length; k++) {
    const gap = rings[k + 1]! - rings[k]!;
    if (gap > 2.6) legs.push((rings[k]! + rings[k + 1]!) / 2);
  }
  if (!legs.length && r1 - r0 > 0) legs.push((r0 + r1) / 2);
  return {
    name,
    a: { ...a, joint: ja, azimuth: Math.atan2(dx, dz) },
    c: { ...c, joint: jc, azimuth: Math.atan2(-dx, -dz) },
    axisY: y,
    radius,
    dir,
    span,
    start,
    end,
    rings,
    legs,
  };
}

/** Point on the corridor axis `s` metres from dome a's axis. */
export function corridorPoint(p: CorridorPlan, s: number): V3 {
  return [p.a.at[0] + p.dir[0] * s, p.axisY, p.a.at[2] + p.dir[2] * s];
}

/**
 * The tube and its legs, in world coordinates. `groundAt` gives the ground under each leg (legs reach a little into
 * it, and up into the tube).
 */
export function corridor(b: MeshBuilder, p: CorridorPlan, groundAt: (x: number, z: number) => number): void {
  const f = frameAlong(p.start, p.end);
  const len = f.len;
  // Ring seams every ~2.4 m along the tube.
  const n = Math.max(2, Math.round(len / 2.4));
  const profile: [number, number][] = [];
  for (let k = 0; k <= n; k++) profile.push([p.radius, (len * k) / n]);
  b.paint(rgb('shell'));
  b.with(f.m, () => lathe(b, profile, { segments: 28, rings: profile.map((_, k) => k) }));

  // Legs: a tapered concrete pier across the tube with a dark saddle under it.
  const yaw = Math.atan2(p.dir[0], p.dir[2]);
  for (const s of p.legs) {
    const [x, , z] = corridorPoint(p, s);
    const g = Math.min(groundAt(x - p.dir[2] * 1.0, z + p.dir[0] * 1.0), groundAt(x + p.dir[2] * 1.0, z - p.dir[0] * 1.0), groundAt(x, z)) - 0.15;
    const top = p.axisY - p.radius * 0.72;
    b.paint(rgb('concrete'));
    b.with(place(x, g, z, yaw), () => frustumBox(b, [2.3, 0.9], [1.55, 0.6], top - g, { shift: [0, 0] }));
    b.paint(rgb('metalMid'));
    b.with(place(x, top - 0.1, z, yaw), () => frustumBox(b, [1.9, 0.75], [1.9, 0.75], 0.32));
  }
}

/** One orange ring round a corridor tube, built about the local +z axis (centred, `len` long). */
export function corridorRing(b: MeshBuilder, r: number, len = 0.6): void {
  b.paint(rgb('orange'));
  b.with(compose(rotateX(Math.PI / 2), place(0, -len / 2, 0)), () => cylinder(b, r + 0.08, len, { segments: 28, top: true, bottom: true }));
}

/** The record transform of a ring at `s` metres along the corridor (local +z along the tube). */
export function ringTransform(p: CorridorPlan, s: number): Mat {
  const [x, y, z] = corridorPoint(p, s);
  return place(x, y, z, Math.atan2(p.dir[0], p.dir[2]));
}
