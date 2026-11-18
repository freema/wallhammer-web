// Leaf clusters: the building block of every broadleaf crown, bush and ivy patch. A cluster is a lumpy core blob
// (the mass, dark below and sunlit above) with a fringe of visible leaves standing out of its surface, so its
// outline is made of leaves, not of a sphere. Many clusters of different sizes make a crown.

import type { RGB, Stream, Vec3 } from '../kit/index.ts';
import { MeshBuilder, PALETTE, add3, clamp, dot3, hex, lerp, mixRgb, norm3, scale3, scaleRgb, shiftHsv, sub3 } from '../kit/index.ts';
import { ellipsoid, leaf, ramp3, tangents } from './common.ts';

/** The look of a kind of foliage. */
export interface FoliageStyle {
  dark: RGB;
  mid: RGB;
  light: RGB;
  /** Colour leaf tips lean toward (sunlit edges). */
  tip: RGB;
  /** Leaf length and width in metres. */
  leafLen: number;
  leafWidth: number;
  /** Leaves per square metre of cluster surface, and the most per cluster. */
  density: number;
  maxLeaves: number;
  /** How far leaves stand out of the surface (0 lie flat, 1 stick straight out). */
  bristle: number;
  /** Core resolution. */
  coreSeg: number;
  coreRings: number;
  /** Sway of the leaf tips (cores sway a third of it). */
  sway: number;
  /** Hue / value spread between leaves. */
  spread: number;
}

/** The warm, saturated greens of the concept's big trees. */
export const OAK: FoliageStyle = {
  dark: hex('#1f4a26'),
  mid: PALETTE.foliage,
  light: hex('#b4c84e'),
  tip: hex('#d6dc6a'),
  leafLen: 1.0,
  leafWidth: 0.62,
  density: 0.85,
  maxLeaves: 60,
  bristle: 0.55,
  coreSeg: 11,
  coreRings: 8,
  sway: 0.85,
  spread: 0.1,
};

/** Smaller trees: the same family, smaller leaves. */
export const BROADLEAF: FoliageStyle = {
  ...OAK,
  dark: hex('#24502a'),
  light: hex('#a9c650'),
  leafLen: 0.55,
  leafWidth: 0.36,
  density: 1.6,
  maxLeaves: 22,
  coreSeg: 7,
  coreRings: 5,
  sway: 0.8,
};

/** Bushes: darker, denser, small leaves. */
export const BUSH: FoliageStyle = {
  ...OAK,
  dark: hex('#1b3f22'),
  mid: hex('#3f7a2e'),
  light: hex('#8fb444'),
  tip: hex('#b8cc5a'),
  leafLen: 0.34,
  leafWidth: 0.24,
  density: 3.2,
  maxLeaves: 9,
  bristle: 0.45,
  coreSeg: 7,
  coreRings: 5,
  sway: 0.55,
};

/** Ivy: dark glossy green, many small leaves lying flat. */
export const IVY: FoliageStyle = {
  ...OAK,
  dark: hex('#163a1e'),
  mid: hex('#2f6a2c'),
  light: hex('#6f9e3a'),
  tip: hex('#8fb24a'),
  leafLen: 0.22,
  leafWidth: 0.2,
  density: 9,
  maxLeaves: 18,
  bristle: 0.25,
  coreSeg: 7,
  coreRings: 5,
  sway: 0.25,
  spread: 0.08,
};

export interface ClusterOptions {
  /** Global brightness of this cluster (crown depth: inner and lower clusters darker). Default 1. */
  shade?: number;
  /** Leaves on the lower half are kept with this probability (default 0.4): the underside reads as a dark mass. */
  underLeaves?: number;
  /** Squash of the core inside the leaf shell (default 0.86). */
  core?: number;
  /** A colour shift of this cluster (hue turns, value), for crowns that are not one flat green. */
  hue?: number;
  /** Flatten the core below this share (bushes sitting on the ground). */
  floor?: number;
}

/**
 * A leaf cluster at `c` with radii `r`: a lumpy core and a fringe of leaves. Sequential use of the stream (the order
 * of calls fixes the shape).
 */
export function leafCluster(b: MeshBuilder, c: Vec3, r: Vec3, st: FoliageStyle, s: Stream, o: ClusterOptions = {}): void {
  const shade = o.shade ?? 1;
  const hue = o.hue ?? s.nextJitter(st.spread * 0.25);
  const tone = (col: RGB): RGB => scaleRgb(shiftHsv(col, hue, 0, 0), shade);
  const dark = tone(st.dark), mid = tone(st.mid), light = tone(st.light), tip = tone(st.tip);
  const coreK = o.core ?? 0.86;
  const seed = Math.floor(s.next() * 1e6);
  ellipsoid(b, c, scale3(r, coreK), {
    seg: st.coreSeg,
    rings: st.coreRings,
    noise: 0.14,
    seed,
    ...(o.floor !== undefined ? { floor: o.floor } : {}),
    paint: (d) => scaleRgb(ramp3(dark, mid, light, Math.pow(d[1] * 0.5 + 0.5, 1.15)), 0.92),
    sway: (d) => st.sway * 0.3 * (0.6 + 0.4 * d[1]),
  });
  // Leaves: a Fibonacci spiral over the cluster, jittered; the lower half thinned out.
  const area = 4 * Math.PI * ((r[0] * r[1] + r[1] * r[2] + r[0] * r[2]) / 3);
  const N = Math.min(st.maxLeaves, Math.max(6, Math.round(area * st.density)));
  const under = o.underLeaves ?? 0.4;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rot = s.next() * Math.PI * 2;
  for (let k = 0; k < N; k++) {
    let y = 1 - (2 * (k + 0.5)) / N + s.nextJitter(0.6 / N);
    y = clamp(y, -0.98, 0.98);
    const keep = s.next();
    if (y < -0.25 && keep > under) continue;
    if (o.floor !== undefined && y < o.floor + 0.15) continue;
    const rad = Math.sqrt(1 - y * y);
    const ph = k * golden + rot + s.nextJitter(0.4);
    const d: Vec3 = [rad * Math.cos(ph), y, rad * Math.sin(ph)];
    const ne = norm3([d[0] / r[0], d[1] / r[1], d[2] / r[2]]);
    const depth = s.nextRange(0.86, 1.0);
    const p: Vec3 = [c[0] + r[0] * d[0] * depth, c[1] + r[1] * d[1] * depth, c[2] + r[2] * d[2] * depth];
    // The tip points along the surface in a random direction, tilted out and a little down.
    const [tu, tv] = tangents(ne);
    const a = s.next() * Math.PI * 2;
    let t = add3(scale3(tu, Math.cos(a)), scale3(tv, Math.sin(a)));
    t = norm3(add3(add3(t, scale3(ne, st.bristle)), [0, -0.22, 0]));
    // The leaf faces out of the cluster, turned a little at random.
    let n = add3(ne, [s.nextJitter(0.45), s.nextJitter(0.3) + 0.15, s.nextJitter(0.45)]);
    if (dot3(n, ne) < 0.3) n = ne;
    n = norm3(sub3(n, scale3(t, dot3(n, t))));
    const len = st.leafLen * s.nextRange(0.75, 1.2);
    const base = sub3(p, scale3(t, len * 0.3));
    const tv01 = clamp(d[1] * 0.5 + 0.5, 0, 1);
    let col = ramp3(dark, mid, light, Math.pow(tv01, 0.9) * 0.85 + 0.15);
    col = shiftHsv(col, s.nextJitter(st.spread * 0.3), s.nextJitter(st.spread), s.nextJitter(st.spread * 1.4));
    const tipCol = mixRgb(col, tip, lerp(0.15, 0.55, tv01));
    leaf(b, base, t, n, len, st.leafWidth * (len / st.leafLen), { base: col, tip: tipCol, under: scaleRgb(dark, 0.75) }, [st.sway * 0.45, st.sway], ne);
  }
}

/** Small round fruits (apples) hanging in a cluster's lower half. */
export function fruits(b: MeshBuilder, c: Vec3, r: Vec3, count: number, color: RGB, s: Stream): void {
  for (let k = 0; k < count; k++) {
    const ph = s.next() * Math.PI * 2;
    const y = s.nextRange(-0.75, 0.25);
    const rad = Math.sqrt(1 - y * y);
    const p: Vec3 = [c[0] + r[0] * rad * Math.cos(ph) * 0.98, c[1] + r[1] * y * 0.98 - 0.05, c[2] + r[2] * rad * Math.sin(ph) * 0.98];
    const size = s.nextRange(0.09, 0.13);
    const col = shiftHsv(color, s.nextJitter(0.02), s.nextJitter(0.1), s.nextJitter(0.12));
    ellipsoid(b, p, [size, size * 0.92, size], { seg: 6, rings: 4, paint: (d) => scaleRgb(col, lerp(0.7, 1.15, d[1] * 0.5 + 0.5)), sway: () => 0.6 });
  }
}
