// The working frame of the architecture kit. Every generator of src/arch writes into a `Site`: a mesh builder plus
// the transform from the site's local coordinates to the world, a random stream, a palette and the list of lights and
// particle emitters the building produces. Sub-frames (a wall, a roof, a window) are entered with `site.at(matrix)`,
// which keeps the builder's transform and the world transform in step, so a lantern placed on a wall knows where its
// light shines in the world.
//
// Wall frames: a wall from point `a` to point `b` (local x, z) has the coordinates
//   u  along the wall from a to b (to the right, seen from outside)
//   v  up from the wall's base height
//   w  out of the wall (outward normal)
// Openings, timbers, signs and lanterns are all placed in (u, v, w).

import { valueNoise2 } from 'wallhammer-web/gen-core';
import type { Mat34, ParticleSource, PointLight, RGB, Vec2, Vec3 } from '../kit/index.ts';
import { MeshBuilder, Stream, applyPoint34, basis34, clamp, faceNormal, mul34, scaleRgb, varyNext, VARY_RICH } from '../kit/index.ts';
import type { Paint, Variation } from '../kit/index.ts';
import type { ArchPalette } from './palette.ts';

/** What a building gives off besides geometry: point lights and particle emitters, in world coordinates. */
export interface Emitters {
  lights: PointLight[];
  particles: ParticleSource[];
}

export class Site {
  /** The builder every generator writes into (its transform equals `m`). */
  readonly b: MeshBuilder;
  /** Local → world transform of this site. */
  readonly m: Mat34;
  /** Random stream of this site (sequential use inside generators; use `child` for independent parts). */
  readonly s: Stream;
  readonly pal: ArchPalette;
  readonly out: Emitters;

  constructor(b: MeshBuilder, m: Mat34, s: Stream, pal: ArchPalette, out: Emitters) {
    this.b = b;
    this.m = m;
    this.s = s;
    this.pal = pal;
    this.out = out;
  }

  /**
   * Runs `fn` in a sub-frame given by `local` (relative to this site). Geometry, lights and particles placed in the
   * callback land where they should. An optional stream or palette replaces this site's for the callback.
   */
  at(local: Mat34, fn: (site: Site) => void, o: { stream?: Stream; pal?: ArchPalette } = {}): void {
    this.b.with(local, () => fn(new Site(this.b, mul34(this.m, local), o.stream ?? this.s, o.pal ?? this.pal, this.out)));
  }

  /** Runs `fn` in the frame of a wall (u along, v up, w out). */
  onWall(wall: Wall, fn: (site: Site) => void): void {
    this.at(wall.m, fn);
  }

  /** The same site with another stream (for independent parts) or palette. */
  with(o: { stream?: Stream; pal?: ArchPalette }): Site {
    return new Site(this.b, this.m, o.stream ?? this.s, o.pal ?? this.pal, this.out);
  }

  /** An independent sub-stream by name: adding numbers to one part does not move another. */
  child(name: string | number): Site {
    return this.with({ stream: this.s.child(name) });
  }

  /** World position of a local point. */
  world(x: number, y: number, z: number): Vec3 {
    return applyPoint34(this.m, x, y, z, [0, 0, 0]);
  }

  /** Adds a point light at a local position. */
  light(at: readonly number[], color: RGB, radius: number, intensity: number, flicker: number, when: PointLight['when'] = 'evening'): PointLight {
    const l: PointLight = { position: this.world(at[0]!, at[1]!, at[2]!), color, radius, intensity, when, flicker };
    this.out.lights.push(l);
    return l;
  }

  /** Adds a particle emitter at a local position. */
  emit(at: readonly number[], src: Omit<ParticleSource, 'position'>): ParticleSource {
    const p: ParticleSource = { ...src, position: this.world(at[0]!, at[1]!, at[2]!) };
    this.out.particles.push(p);
    return p;
  }

  /** A variant of a colour from the next numbers of this site's stream. */
  tone(c: readonly number[], v: Variation = VARY_RICH): RGB {
    return varyNext(c, v, this.s);
  }
}

/** A new site over a builder that has no transform of its own yet: `m` is the site's local → world transform. */
export function openSite(b: MeshBuilder, m: Mat34, s: Stream, pal: ArchPalette, out: Emitters, fn: (site: Site) => void): void {
  b.with(m, () => fn(new Site(b, m.slice(), s, pal, out)));
}

/** Empty emitter lists. */
export const emitters = (): Emitters => ({ lights: [], particles: [] });

// --- Walls -------------------------------------------------------------------------------------------------------------

export type Side = 'front' | 'right' | 'back' | 'left';
export const SIDES: readonly Side[] = ['front', 'right', 'back', 'left'];

/** A straight wall line in a site's local x, z with its frame (u along, v up, w out). */
export interface Wall {
  a: Vec2;
  b: Vec2;
  /** Base height (local y) of the wall frame. */
  y: number;
  length: number;
  /** Unit direction a → b and outward normal, in local x, z. */
  dir: Vec2;
  normal: Vec2;
  /** Wall frame → site local. */
  m: Mat34;
}

/**
 * The wall from `a` to `b` at base height `y`. The outward side is to the left of a → b seen from above with x east and
 * z south, i.e. walls go around a footprint the way `rectWalls` lists them.
 */
export function wallFrame(a: Vec2, b: Vec2, y = 0): Wall {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz) || 1e-6;
  const dir: Vec2 = [dx / length, dz / length];
  const normal: Vec2 = [-dir[1], dir[0]];
  return { a, b, y, length, dir, normal, m: basis34([dir[0], 0, dir[1]], [0, 1, 0], [normal[0], 0, normal[1]], [a[0], y, a[1]]) };
}

/** A rectangle in a site's local frame: centre, width along x, depth along z (the front is +z). */
export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** The four walls of a rectangle, each running to the right seen from outside: front (+z), right (+x), back, left. */
export function rectWalls(r: Rect, y = 0): Record<Side, Wall> {
  const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, z0 = r.z - r.d / 2, z1 = r.z + r.d / 2;
  return {
    front: wallFrame([x0, z1], [x1, z1], y),
    right: wallFrame([x1, z1], [x1, z0], y),
    back: wallFrame([x1, z0], [x0, z0], y),
    left: wallFrame([x0, z0], [x0, z1], y),
  };
}

/** The corners of a rectangle in wall order (front-left, front-right, back-right, back-left). */
export function rectRing(r: Rect): Vec2[] {
  const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, z0 = r.z - r.d / 2, z1 = r.z + r.d / 2;
  return [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
}

/** A point of a wall frame in its site's local coordinates. */
export function wallPoint(wall: Wall, u: number, v: number, w = 0): Vec3 {
  return applyPoint34(wall.m, u, v, w, [0, 0, 0]);
}

/** An opening in a wall frame (u0..u1 along, v0..v1 up). Plaster and timbers keep out of it. */
export interface Opening {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export const insideOpening = (o: readonly Opening[], u: number, v: number, grow = 0): boolean =>
  o.some((q) => u > q.u0 - grow && u < q.u1 + grow && v > q.v0 - grow && v < q.v1 + grow);

// --- Paints ------------------------------------------------------------------------------------------------------------

/** Wood: lighter where it faces up, darker underneath (the painted top light of the concept). */
export function woodPaint(base: RGB): Paint {
  return (_p, n) => scaleRgb(base, 0.9 + 0.16 * Math.max(0, n[1]) - 0.12 * Math.max(0, -n[1]));
}

/** Stone: lighter on top faces, darker below, with a slow blotch from the position (`seed` keeps blocks apart). */
export function stonePaint(base: RGB, seed: number): Paint {
  return (p, n) => {
    const blot = valueNoise2(p[0] + p[1] * 0.7, p[2] - p[1] * 0.4, 0.9, seed) - 0.5;
    return scaleRgb(base, 0.92 + 0.18 * Math.max(0, n[1]) - 0.16 * Math.max(0, -n[1]) + 0.16 * blot);
  };
}

/**
 * Plaster: mottled warm and cream patches, darker and dirtier toward the foot of the wall (`v` is the height in the
 * wall frame).
 */
export function plasterColor(pal: ArchPalette, u: number, v: number, seed: number, footDark = 0.22): RGB {
  const a = valueNoise2(u, v, 1.7, seed);
  const bl = valueNoise2(u + 31, v * 1.6, 0.6, seed + 1);
  const c: RGB = [
    pal.plaster[0] + (pal.plasterWarm[0] - pal.plaster[0]) * clamp(a * 1.4 - 0.2, 0, 1),
    pal.plaster[1] + (pal.plasterWarm[1] - pal.plaster[1]) * clamp(a * 1.4 - 0.2, 0, 1),
    pal.plaster[2] + (pal.plasterWarm[2] - pal.plaster[2]) * clamp(a * 1.4 - 0.2, 0, 1),
  ];
  const foot = 1 - footDark * (1 - clamp(v / 1.3, 0, 1)) ** 2;
  return scaleRgb(c, (0.93 + 0.1 * bl) * foot);
}

// --- Small geometry helpers ------------------------------------------------------------------------------------------

/** A flat polygon whose winding is fixed so that its normal points along `out` (any vector on the outer side). */
export function faceOut(b: MeshBuilder, pts: readonly (readonly number[])[], out: readonly number[], colors?: readonly (readonly number[])[] | RGB): void {
  const n = faceNormal(pts);
  const flip = n[0] * out[0]! + n[1] * out[1]! + n[2] * out[2]! < 0;
  const p = flip ? [...pts].reverse() : pts;
  const cols = colors && Array.isArray(colors[0]) ? (flip ? [...(colors as (readonly number[])[])].reverse() : (colors as (readonly number[])[])) : undefined;
  if (cols) b.face(p, cols);
  else if (colors) {
    const keep = b.color;
    b.paint(colors as RGB);
    b.face(p);
    b.paint(keep);
  } else b.face(p);
}

/**
 * The flat ring between an outer and an inner outline (same number of points, matched in order, both closed) in the
 * plane z = `z` of the current frame, facing +z. Fills the corners between a square hole and a round or arched
 * window, or the spandrels of an arched door.
 */
export function ringFace(b: MeshBuilder, outer: readonly Vec2[], inner: readonly Vec2[], z: number, color: (x: number, y: number) => RGB): void {
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pts = [
      [outer[i]![0], outer[i]![1], z],
      [outer[j]![0], outer[j]![1], z],
      [inner[j]![0], inner[j]![1], z],
      [inner[i]![0], inner[i]![1], z],
    ];
    // Skip degenerate pieces (outer and inner meeting).
    const area = Math.abs((pts[1]![0]! - pts[0]![0]!) * (pts[3]![1]! - pts[0]![1]!) - (pts[3]![0]! - pts[0]![0]!) * (pts[1]![1]! - pts[0]![1]!))
      + Math.abs((pts[2]![0]! - pts[1]![0]!) * (pts[3]![1]! - pts[1]![1]!) - (pts[3]![0]! - pts[1]![0]!) * (pts[2]![1]! - pts[1]![1]!));
    if (area < 1e-5) continue;
    faceOut(b, pts, [0, 0, 1], pts.map((p) => color(p[0]!, p[1]!)));
  }
}

/** Points on the outline of a rectangle, matched by angle to `count` points around its centre (for `ringFace`). */
export function rectOutline(cx: number, cy: number, hw: number, hh: number, count: number, phase = Math.PI / 2): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < count; k++) {
    const a = phase + (k / count) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    const t = Math.min(hw / Math.max(1e-6, Math.abs(dx)), hh / Math.max(1e-6, Math.abs(dy)));
    out.push([cx + dx * t, cy + dy * t]);
  }
  return out;
}

/** A local stream for code that has no site (keeps generator signatures small). */
export const streamOf = (seed: number, name: string): Stream => new Stream(seed).child(name);

/**
 * A ground height function sampled once on a grid over a box (world x0..x1, z0..z1) and read back bilinearly; outside
 * the box it asks `f`. For AO baking, which asks the ground millions of times (the terrain function is not cheap).
 */
export function cachedGround(f: (x: number, z: number) => number, x0: number, z0: number, x1: number, z1: number, cell = 0.5): (x: number, z: number) => number {
  const nx = Math.max(2, Math.ceil((x1 - x0) / cell) + 1), nz = Math.max(2, Math.ceil((z1 - z0) / cell) + 1);
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = f(x0 + i * cell, z0 + j * cell);
  return (x, z) => {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    if (fx < 0 || fz < 0 || fx >= nx - 1 || fz >= nz - 1) return f(x, z);
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const a = h[j * nx + i]!, b = h[j * nx + i + 1]!, c = h[(j + 1) * nx + i]!, d = h[(j + 1) * nx + i + 1]!;
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}
