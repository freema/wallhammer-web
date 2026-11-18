// Shared helpers of the props: colours of wood, iron, rope and burlap with per-piece variation, small primitives
// (balls, flat polygons facing a side, closed rings), placement checks against the layout, and the cluster bake
// (a group of props built in world coordinates, its occlusion baked, then merged into the module's batch).

import type { BuildContext, MeshBuilder, RGB, Stream, Vec3 } from '../kit/index.ts';
import { MeshBuilder as Builder, PALETTE, VARY_RICH, VARY_SUBTLE, bakeAo, faceNormal, groundAo, hex, lathe, scaleRgb, sweep, vary } from '../kit/index.ts';
import { pathNear, riverNear, structureDist } from '../layout.ts';
import type { VillageLayout } from '../layout.ts';

/** Extra colours of the props (the shared palette has the rest). */
export const PROP = {
  burlap: hex('#b8955e'),
  burlapDark: hex('#8a6a40'),
  wicker: hex('#b88a4a'),
  wickerDark: hex('#7a5530'),
  rope: hex('#c8b082'),
  endGrain: hex('#d0a46a'),
  endGrainDark: hex('#9a6c3e'),
  coal: hex('#26201e'),
  ember: hex('#ff6a1e'),
  leather: hex('#6a3a22'),
  copper: hex('#b8683a'),
  carrot: hex('#e8782a'),
  turnip: hex('#e8dccc'),
  turnipTop: hex('#9a4a8a'),
  pear: hex('#c8c04a'),
  appleGreen: hex('#8ab83a'),
  greens: hex('#4f8a32'),
  bread: hex('#c8883e'),
  clay: hex('#b8603a'),
  clayLight: hex('#d89a68'),
  linen: hex('#efe6cf'),
  wool: hex('#c8b8a0'),
  waterDeep: hex('#1f4a58'),
} as const satisfies Record<string, RGB>;

/** A timber colour for piece `i` of a stream: one of the three wood tones, varied richly. */
export function woodColor(s: Stream, ...keys: number[]): RGB {
  const base = s.pick([PALETTE.timber, PALETTE.timberDark, PALETTE.plank, PALETTE.timber], ...keys, 11);
  return vary(base, VARY_RICH, s, ...keys, 12);
}

/** A lighter, weathered wood (rails, slats, planks of crates). */
export function lightWoodColor(s: Stream, ...keys: number[]): RGB {
  const base = s.pick([PALETTE.timberLight, PALETTE.plank, PALETTE.timberLight], ...keys, 21);
  return vary(base, VARY_RICH, s, ...keys, 22);
}

export function ironColor(s: Stream, ...keys: number[]): RGB {
  return vary(PALETTE.iron, VARY_SUBTLE, s, ...keys, 31);
}

/** Paint that darkens toward the foot of a piece standing at y = 0 and lightens toward `top`. */
export function rampPaint(c: RGB, top: number, dark = 0.3, light = 0.1): (p: Vec3) => RGB {
  return (p) => {
    const t = Math.max(0, Math.min(1, p[1] / Math.max(0.01, top)));
    return scaleRgb(c, 1 - dark + (dark + light) * t);
  };
}

/** A flat convex polygon wound so its normal points toward `toward` (a direction). */
export function facingFace(b: MeshBuilder, pts: Vec3[], toward: readonly number[], color: RGB | RGB[]): void {
  const n = faceNormal(pts);
  const ordered = n[0] * toward[0]! + n[1] * toward[1]! + n[2] * toward[2]! < 0 ? [...pts].reverse() : pts;
  const cols = Array.isArray(color[0]) ? (color as RGB[]) : null;
  const colsOrdered = cols && ordered !== pts ? [...cols].reverse() : cols;
  b.face(ordered, colsOrdered ?? undefined);
  if (!cols) {
    // b.face used the current paint colour: set it explicitly for this face.
    const first = b.vertexCount - ordered.length;
    for (let v = first; v < b.vertexCount; v++) {
      b.col[v * 4] = (color as RGB)[0];
      b.col[v * 4 + 1] = (color as RGB)[1];
      b.col[v * 4 + 2] = (color as RGB)[2];
    }
  }
}

/** A small ball (fruit, cabbage heart, knob): a lathe sphere, optionally squashed (y scale). */
export function ball(b: MeshBuilder, at: readonly number[], r: number, color: RGB | ((p: Vec3, n: Vec3) => RGB), o: { segments?: number; rows?: number; squash?: number; phase?: number } = {}): void {
  const rows = o.rows ?? 4;
  const sq = o.squash ?? 1;
  const profile: [number, number][] = [];
  for (let j = 0; j <= rows; j++) {
    const a = -Math.PI / 2 + (Math.PI * j) / rows;
    profile.push([Math.max(0.0001, Math.cos(a) * r), (Math.sin(a) + 1) * r * sq]);
  }
  profile[0]![0] = 0.0001;
  profile[rows]![0] = 0.0001;
  lathe(b, [at[0]!, at[1]! - r * sq, at[2]!], profile, color, { segments: o.segments ?? 6, phase: o.phase ?? 0 });
}

/** A closed ring (hoop, rim, rope coil) of a small round section around +y at height y. */
export function ring(b: MeshBuilder, at: readonly number[], radius: number, thick: number, color: RGB, segments = 14, sides = 4): void {
  const path: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    path.push([at[0]! + Math.cos(a) * radius, at[1]!, at[2]! - Math.sin(a) * radius]);
  }
  const profile: [number, number][] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2 + Math.PI / sides;
    profile.push([Math.cos(a) * thick, Math.sin(a) * thick]);
  }
  sweep(b, path, profile, color, { closed: true, up: [0, 1, 0] });
}

/** A thin rope or chain line along points (round, few sides). */
export function rope(b: MeshBuilder, path: readonly (readonly number[])[], radius: number, color: RGB, sides = 4): void {
  const profile: [number, number][] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2 + Math.PI / sides;
    profile.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  sweep(b, path, profile, color, { closed: true, caps: true });
}

/** A hanging curve (catenary-like parabola) between two points with `sag` metres at the middle, `n` segments. */
export function sagLine(a: readonly number[], c: readonly number[], sag: number, n = 10): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a[0]! + (c[0]! - a[0]!) * t, a[1]! + (c[1]! - a[1]!) * t - sag * 4 * t * (1 - t), a[2]! + (c[2]! - a[2]!) * t]);
  }
  return out;
}

/**
 * Free ground for a prop of radius `r` at (x, z): away from buildings, the paved paths (by `pathMargin`), the water,
 * the well, the stalls and the trunks of trees.
 */
export function freeSpot(layout: VillageLayout, x: number, z: number, r: number, pathMargin = 0.2, wall = r + 0.15): boolean {
  if (structureDist(layout.structures, x, z) < wall) return false;
  const p = pathNear(layout.paths, x, z);
  if (p.path && p.dist < p.path.width / 2 + r + pathMargin) return false;
  const rv = riverNear(layout.river, x, z);
  if (rv.dist < rv.at.width / 2 + r + 0.6) return false;
  if (Math.hypot(x - layout.well.x, z - layout.well.z) < 1.4 + r) return false;
  for (const t of layout.trees) {
    const trunk = t.kind === 'giant' ? 2.4 * t.scale : t.kind === 'bush' ? 0.8 : 0.7;
    if (Math.hypot(t.x - x, t.z - z) < trunk + r) return false;
  }
  return true;
}

/** Ground height under a prop of radius r: the lowest of five samples, so it never floats on a slope. */
export function groundUnder(ctx: BuildContext, x: number, z: number, r: number): number {
  const h = ctx.heightAt;
  return Math.min(h(x, z), h(x + r, z), h(x - r, z), h(x, z + r), h(x, z - r));
}

/** Bakes occlusion of a cluster (in world coordinates) and merges it into `into`. */
export function bakeInto(ctx: BuildContext, into: MeshBuilder, cluster: MeshBuilder, o: { reach?: number; cell?: number; rays?: number; strength?: number } = {}): void {
  if (cluster.vertexCount === 0) return;
  const reach = o.reach ?? 1.0;
  const ground = localGround(ctx, cluster, reach + 0.5);
  bakeAo(cluster, { ground, reach, cell: o.cell ?? 0.1, rays: o.rays ?? 10, strength: o.strength ?? 0.7 });
  groundAo(cluster, ground, 0.5, 0.4);
  into.append(cluster);
}

/**
 * The terrain under a cluster sampled once into a small grid (0.5 m) with bilinear lookup: the occlusion rays ask
 * for the ground at every step, and the full height field is far slower than this.
 */
function localGround(ctx: BuildContext, b: MeshBuilder, margin: number): (x: number, z: number) => number {
  const bb = b.bounds(0);
  const cell = 0.5;
  const x0 = bb.min[0] - margin, z0 = bb.min[2] - margin;
  const nx = Math.ceil((bb.max[0] + margin - x0) / cell) + 2, nz = Math.ceil((bb.max[2] + margin - z0) / cell) + 2;
  const h = new Float32Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) h[k * nx + i] = ctx.heightAt(x0 + i * cell, z0 + k * cell);
  return (x, z) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - x0) / cell)), fz = Math.min(nz - 1.001, Math.max(0, (z - z0) / cell));
    const i = Math.floor(fx), k = Math.floor(fz), u = fx - i, v = fz - k;
    const a = h[k * nx + i]!, c = h[k * nx + i + 1]!, d = h[(k + 1) * nx + i]!, e = h[(k + 1) * nx + i + 1]!;
    return (a * (1 - u) + c * u) * (1 - v) + (d * (1 - u) + e * u) * v;
  };
}

/** A new empty builder (shorthand). */
export const builder = (): MeshBuilder => new Builder();
