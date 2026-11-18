// Shared helpers of the terrain modules (ground, water, paving, bridge, weir, rocks): frames along polylines, the
// bridge's local frame and deck profile, the placement of stones in the river (rocks builds them, water foams around
// them), a rounded cobble stone, grass tufts, a pillowed masonry block, and winding repair against vertex normals.
//
// Everything here is a pure function of the layout, the height field and named streams of the seed.

import type { MeshBuilder, RGB, Stream, Vec2, Vec3 } from '../kit/index.ts';
import { clamp, cross3, norm3, scaleRgb, smoothstep } from '../kit/index.ts';
import type { BuildContext } from '../kit/index.ts';
import type { PathLine, VillageLayout } from '../layout.ts';
import { riverNear, structureDist } from '../layout.ts';

// --- Frames along polylines --------------------------------------------------------------------------------------------

/** A point on a polyline and its unit direction (x, z). The side vector (left of the direction) is (dz, −dx). */
export interface LineFrame {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** The frame at a distance along a polyline of (x, z, …) points with cumulative lengths. */
export function frameAt(points: readonly (readonly number[])[], lengths: readonly number[], a: number, out: LineFrame = { x: 0, z: 0, dx: 0, dz: 1 }): LineFrame {
  let i = 0;
  const last = lengths.length - 1;
  // Binary search for the segment.
  let lo = 0, hi = last - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lengths[mid]! <= a) lo = mid;
    else hi = mid - 1;
  }
  i = clamp(lo, 0, Math.max(0, last - 1));
  const A = points[i]!, B = points[Math.min(last, i + 1)]!;
  const seg = lengths[Math.min(last, i + 1)]! - lengths[i]! || 1;
  const t = (a - lengths[i]!) / seg;
  out.x = A[0]! + (B[0]! - A[0]!) * t;
  out.z = A[1]! + (B[1]! - A[1]!) * t;
  // Direction smoothed over the neighbouring segments, so the frame turns gently at the polyline's corners.
  const P = points[Math.max(0, i - 1)]!, Q = points[Math.min(last, i + 2)]!;
  let dx = (B[0]! - A[0]!) * 2 + (Q[0]! - P[0]!) * 0.5 * (1 - Math.abs(t - 0.5));
  let dz = (B[1]! - A[1]!) * 2 + (Q[1]! - P[1]!) * 0.5 * (1 - Math.abs(t - 0.5));
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  out.dx = dx;
  out.dz = dz;
  return out;
}

/** World point at distance `a` along and `v` to the left of a polyline. */
export function lineWorld(points: readonly (readonly number[])[], lengths: readonly number[], a: number, v: number): Vec2 {
  const f = frameAt(points, lengths, a);
  return [f.x + f.dz * v, f.z - f.dx * v];
}

/** Total length of a path. */
export const pathLength = (p: PathLine): number => p.lengths[p.lengths.length - 1]!;

// --- The bridge ---------------------------------------------------------------------------------------------------------

/**
 * The bridge in its own frame: `s` along the deck (toward the bridge's yaw, south), `t` across (toward local +x,
 * which is world (cos yaw, −sin yaw)), y is world height. Shared by the bridge (deck, arch, walls) and the paving
 * (which leaves the deck to the bridge and runs its cobbles onto it).
 */
export interface BridgeFrame {
  x: number;
  z: number;
  yaw: number;
  /** Unit vectors in world x, z: along the deck and across it. */
  along: Vec2;
  across: Vec2;
  halfLength: number;
  halfWidth: number;
  /** Walking surface height at `s` (a gentle hump from the banks up to the deck height in the middle). */
  deckY(s: number): number;
  /** World point of a local point. */
  world(s: number, t: number): Vec2;
  /** Local (s, t) of a world point. */
  local(x: number, z: number): Vec2;
  /** Inside the deck's footprint (grown by `margin`). */
  onDeck(x: number, z: number, margin?: number): boolean;
  /** The arch: half span (along s), springing height, crown height of the intrados, radius, centre height. */
  arch: { half: number; spring: number; crown: number; radius: number; centerY: number };
}

const bridgeCache = new WeakMap<VillageLayout, BridgeFrame>();

export function bridgeFrame(ctx: Pick<BuildContext, 'layout' | 'heightAt'>): BridgeFrame {
  const cached = bridgeCache.get(ctx.layout);
  if (cached) return cached;
  const br = ctx.layout.bridge;
  const along: Vec2 = [Math.sin(br.yaw), Math.cos(br.yaw)];
  const across: Vec2 = [Math.cos(br.yaw), -Math.sin(br.yaw)];
  const halfLength = br.length / 2;
  const world = (s: number, t: number): Vec2 => [br.x + along[0] * s + across[0] * t, br.z + along[1] * s + across[1] * t];
  const local = (x: number, z: number): Vec2 => {
    const dx = x - br.x, dz = z - br.z;
    return [dx * along[0] + dz * along[1], dx * across[0] + dz * across[1]];
  };
  // Deck: the ends lie on the ground of the street, the middle at deckY, a soft parabola in between; never below the
  // ground under the centre line (the bank slopes) plus a little.
  const endS = ctx.heightAt(...world(halfLength, 0));
  const endN = ctx.heightAt(...world(-halfLength, 0));
  const deckY = (s: number): number => {
    const u = clamp(Math.abs(s) / halfLength, 0, 1);
    const end = s >= 0 ? endS : endN;
    const y = br.deckY + (end - br.deckY) * u * u;
    return y;
  };
  // The water crosses the axis at a slant; the span covers the wetted width along the axis with room for the banks.
  let wetLo = 0, wetHi = 0;
  for (let s = -halfLength; s <= halfLength; s += 0.1) {
    const [x, z] = world(s, 0);
    const rv = riverNear(ctx.layout.river, x, z);
    if (rv.dist < rv.at.width / 2) {
      wetLo = Math.min(wetLo, s);
      wetHi = Math.max(wetHi, s);
    }
  }
  const half = Math.min(halfLength - 2.2, Math.max(-wetLo, wetHi) + 0.75);
  const spring = br.waterY - 0.3;
  const crown = br.deckY - 0.95;
  const h = crown - spring;
  const radius = (h * h + half * half) / (2 * h);
  const frame: BridgeFrame = {
    x: br.x,
    z: br.z,
    yaw: br.yaw,
    along,
    across,
    halfLength,
    halfWidth: br.width / 2,
    deckY,
    world,
    local,
    onDeck: (x, z, margin = 0) => {
      const [s, t] = local(x, z);
      return Math.abs(s) < halfLength + margin && Math.abs(t) < br.width / 2 + margin;
    },
    arch: { half, spring, crown, radius, centerY: crown - radius },
  };
  bridgeCache.set(ctx.layout, frame);
  return frame;
}

// --- Stones in the river (rocks builds them, the water foams around them) --------------------------------------------

export interface RiverStone {
  x: number;
  z: number;
  /** Footprint radius and height above the bed. */
  r: number;
  h: number;
  /** Bed height under it. */
  y: number;
  yaw: number;
}

const stoneCache = new WeakMap<VillageLayout, RiverStone[]>();

/**
 * Boulders standing in the water: in the plunge pool below the weir, along the rocky reaches by the mill and the
 * bridge, and a few further downstream. They break the surface (the water foams around them) but keep clear of the
 * mill wheel, the bridge arch and the weir crest.
 */
export function riverStones(ctx: Pick<BuildContext, 'layout' | 'heightAt' | 'stream'>): RiverStone[] {
  const cached = stoneCache.get(ctx.layout);
  if (cached) return cached;
  const { layout } = ctx;
  const s = ctx.stream('terrain-river-stones');
  const river = layout.river;
  const out: RiverStone[] = [];
  const wheel = layout.millWheel;
  const bf = bridgeFrame(ctx);
  const total = river.lengths[river.lengths.length - 1]!;
  const tryAdd = (along: number, side: number, r: number, k: number): void => {
    const f = frameAt(river.line, river.lengths, along);
    const rv = riverNear(river, f.x, f.z);
    const half = rv.at.width / 2;
    const off = side * half;
    const x = f.x + f.dz * off, z = f.z - f.dx * off;
    if (Math.abs(x) > 105 || Math.abs(z) > 105) return;
    if (Math.hypot(x - wheel.x, z - wheel.z) < wheel.radius + r + 1.2) return;
    if (bf.onDeck(x, z, 1.5)) return;
    if (Math.abs(along - layout.weir.along) < 1.6 + r) return;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + r + 0.3)) return;
    const y = ctx.heightAt(x, z);
    // Tall enough to break the surface by 0.15–0.6 m.
    const h = Math.max(0.4, rv.at.y - y + s.range(0.15, 0.6, k, 3));
    out.push({ x, z, r, h, y, yaw: s.range(0, Math.PI * 2, k, 4) });
  };
  // Plunge pool and the reach past the mill: several stones, both sides and a couple mid-stream.
  for (let k = 0; k < 9; k++) tryAdd(layout.weir.along + s.range(2.2, 16, k, 1), s.range(-0.85, 0.85, k, 2), s.range(0.45, 0.95, k, 5), k);
  // Along the bridge reach, near the banks.
  const bAlong = riverNear(river, bf.x, bf.z).at.along;
  for (let k = 0; k < 6; k++) tryAdd(bAlong + s.range(-12, 12, 20 + k, 1), s.sign(20 + k, 2) * s.range(0.55, 0.9, 20 + k, 6), s.range(0.4, 0.8, 20 + k, 5), 20 + k);
  // Scattered downstream and upstream.
  for (let k = 0; k < 14; k++) tryAdd(s.range(5, total - 5, 40 + k, 1), s.sign(40 + k, 2) * s.range(0.5, 0.9, 40 + k, 6), s.range(0.35, 0.7, 40 + k, 5), 40 + k);
  stoneCache.set(layout, out);
  return out;
}

// --- Shapes -------------------------------------------------------------------------------------------------------------

/**
 * Turns triangles from `firstIndex` (an index into `b.indexData`) so each winds counter-clockwise around the average of
 * its vertex normals: generators that compute normals analytically use it instead of tracking winding by hand.
 */
export function orientToNormals(b: MeshBuilder, firstIndex: number): void {
  const P = b.positionData, N = b.normalData, I = b.indexData;
  for (let t = firstIndex; t < I.length; t += 3) {
    const a = I[t]! * 3, c = I[t + 1]! * 3, d = I[t + 2]! * 3;
    const e1x = P[c]! - P[a]!, e1y = P[c + 1]! - P[a + 1]!, e1z = P[c + 2]! - P[a + 2]!;
    const e2x = P[d]! - P[a]!, e2y = P[d + 1]! - P[a + 1]!, e2z = P[d + 2]! - P[a + 2]!;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const vx = N[a]! + N[c]! + N[d]!, vy = N[a + 1]! + N[c + 1]! + N[d + 1]!, vz = N[a + 2]! + N[c + 2]! + N[d + 2]!;
    if (nx * vx + ny * vy + nz * vz < 0) b.setTriangle(t / 3, I[t]!, I[t + 2]!, I[t + 1]!);
  }
}

/**
 * A rounded cobble: a flat-topped dome over an outline (world x, z points around its centre), sunk a little into
 * the ground so its foot never floats. Rings: the outline at the ground, a shoulder at 78 % size and a top. The top
 * is lighter, the foot darker with occlusion: read from above, every stone is a separate painted pebble.
 */
export function cobble(b: MeshBuilder, outline: readonly Vec2[], height: (x: number, z: number) => number, dome: number, sink: number, color: RGB, tilt: Vec2 = [0, 0]): void {
  const n = outline.length;
  let cx = 0, cz = 0;
  for (const [x, z] of outline) (cx += x), (cz += z);
  cx /= n;
  cz /= n;
  const hc = height(cx, cz);
  const firstIdx = b.indexCount;
  const top = b.vertex([cx, hc + dome - sink, cz], [tilt[0] * 0.5, 1, tilt[1] * 0.5], scaleRgb(color, 1.12), 1);
  const shoulder: number[] = [];
  const foot: number[] = [];
  for (let k = 0; k < n; k++) {
    const [x, z] = outline[k]!;
    const rx = x - cx, rz = z - cz;
    const rl = Math.hypot(rx, rz) || 1;
    const ux = rx / rl, uz = rz / rl;
    const hx = cx + rx * 0.78, hz = cz + rz * 0.78;
    const hs = hc + (height(hx, hz) - hc) * 0.5;
    // Tilt lifts one side of the stone (a stone pushed up by roots or frost).
    const lift = (tilt[0] * rx + tilt[1] * rz) * 0.5;
    shoulder.push(b.vertex([hx, hs + dome * 0.72 - sink + lift, hz], norm3([ux * 0.6, 1, uz * 0.6]), color, 0.95));
    foot.push(b.vertex([x, height(x, z) - sink - 0.035 + lift * 0.4, z], norm3([ux * 1.4, 1, uz * 1.4]), scaleRgb(color, 0.72), 0.62));
  }
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    b.tri(top, shoulder[k]!, shoulder[k1]!);
    b.quad(shoulder[k]!, foot[k]!, foot[k1]!, shoulder[k1]!);
  }
  orientToNormals(b, firstIdx);
}

/**
 * A rounded-rectangle outline in a local frame (u along, v across) with chamfered and jittered corners, mapped to
 * the world by `map`. The building block of the paving: rows of these make an irregular setts pattern.
 */
export function settOutline(u0: number, u1: number, v0: number, v1: number, s: Stream, keys: readonly number[], map: (u: number, v: number) => Vec2): Vec2[] {
  const cu = Math.min(0.32, (u1 - u0) * 0.28), cv = Math.min(0.32, (v1 - v0) * 0.28);
  const j = 0.035;
  const pts: [number, number][] = [
    [u0 + cu, v0], [u1 - cu, v0], [u1, v0 + cv], [u1, v1 - cv], [u1 - cu, v1], [u0 + cu, v1], [u0, v1 - cv], [u0, v0 + cv],
  ];
  return pts.map(([u, v], k) => map(u + s.jitter(j, ...keys, k, 1), v + s.jitter(j, ...keys, k, 2)));
}

/**
 * A grass tuft: a handful of bent blades, each a thin triangle with both sides written (own vertices, opposite
 * normals tilted up so they light like the ground), swaying at the tips.
 */
export function grassTuft(b: MeshBuilder, x: number, y: number, z: number, size: number, s: Stream, key: number, colors: readonly RGB[]): void {
  const blades = 5 + Math.floor(s.float(key, 1) * 4);
  const keep = b.flags;
  for (let k = 0; k < blades; k++) {
    const a = s.range(0, Math.PI * 2, key, k, 2);
    const r = s.range(0, 0.12, key, k, 3) * size;
    const bx = x + Math.cos(a) * r, bz = z + Math.sin(a) * r;
    const h = size * s.range(0.55, 1.1, key, k, 4);
    const lean = s.range(0.15, 0.45, key, k, 5) * h;
    const w = size * s.range(0.07, 0.12, key, k, 6);
    // Blade plane across the lean direction.
    const tx = Math.cos(a + Math.PI / 2), tz = Math.sin(a + Math.PI / 2);
    const tip: Vec3 = [bx + Math.cos(a) * lean, y + h, bz + Math.sin(a) * lean];
    const l: Vec3 = [bx - tx * w, y - 0.03, bz - tz * w];
    const rr: Vec3 = [bx + tx * w, y - 0.03, bz + tz * w];
    const fn = norm3(cross3([rr[0] - l[0], rr[1] - l[1], rr[2] - l[2]], [tip[0] - l[0], tip[1] - l[1], tip[2] - l[2]]));
    const c0 = colors[Math.floor(s.float(key, k, 7) * colors.length) % colors.length]!;
    const base = scaleRgb(c0, 0.62), top = scaleRgb(c0, 1.18);
    for (const side of [1, -1]) {
      const n = norm3([fn[0] * side * 0.45, 0.85, fn[2] * side * 0.45]);
      b.flags = { ...keep, sway: 0 };
      const i0 = b.vertex(l, n, base, 0.7);
      const i1 = b.vertex(rr, n, base, 0.7);
      b.flags = { ...keep, sway: 0.75 };
      const i2 = b.vertex(tip, n, top, 1);
      const first = b.indexCount;
      b.tri(i0, i1, i2);
      orientToNormals(b, first);
    }
  }
  b.flags = keep;
}

/**
 * One rough masonry block on a wall face: the face lies in the plane spanned by `uDir` (along the wall) and up, at
 * the origin `o`, the outside along `out`. The block covers u ∈ [u0, u1] and, at each u, y from `bottom(u)` to
 * `top(u)` (clipped blocks follow an arch or a slope). The face is a pillow (bulging up to `bulge` in the middle),
 * with a top, a bottom and two end faces going `depth` into the wall. Returns false when nothing was left after
 * clipping.
 */
export function pillowBlock(
  b: MeshBuilder,
  o: Vec3,
  uDir: Vec2,
  out: Vec2,
  u0: number,
  u1: number,
  bottom: (u: number) => number,
  top: (u: number) => number,
  depth: number,
  bulge: number,
  color: RGB,
): boolean {
  const ns = Math.max(2, Math.ceil((u1 - u0) / 0.3) + 1);
  const us: number[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  let any = false;
  for (let i = 0; i < ns; i++) {
    const u = u0 + ((u1 - u0) * i) / (ns - 1);
    const y0 = bottom(u), y1 = top(u);
    us.push(u);
    lo.push(Math.min(y0, y1));
    hi.push(y1);
    if (y1 - y0 > 0.1) any = true;
  }
  if (!any) return false;
  const P = (u: number, y: number, d: number): Vec3 => [o[0] + uDir[0] * u + out[0] * d, y, o[2] + uDir[1] * u + out[1] * d];
  const firstIdx = b.indexCount;
  const rows = 3;
  // Front face: a grid ns × rows, bulging out in the middle.
  const grid: number[] = [];
  const pos: Vec3[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < ns; i++) {
      const fv = j / (rows - 1);
      const fu = i / (ns - 1);
      const y = lo[i]! + (hi[i]! - lo[i]!) * fv;
      const bul = bulge * Math.sin(Math.PI * fu) * Math.sin(Math.PI * fv);
      pos.push(P(us[i]!, y, bul));
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < ns; i++) {
      const p = pos[j * ns + i]!;
      const pu = pos[j * ns + Math.min(ns - 1, i + 1)]!, mu = pos[j * ns + Math.max(0, i - 1)]!;
      const pv = pos[Math.min(rows - 1, j + 1) * ns + i]!, mv = pos[Math.max(0, j - 1) * ns + i]!;
      let n = norm3(cross3([pu[0] - mu[0], pu[1] - mu[1], pu[2] - mu[2]], [pv[0] - mv[0], pv[1] - mv[1], pv[2] - mv[2]]));
      if (n[0] * out[0] + n[2] * out[1] < 0) n = [-n[0], -n[1], -n[2]];
      // Pull the normal toward the face direction at the rim, so the light reads the pillow but not the clipping.
      const fv = j / (rows - 1);
      const shade = 0.82 + 0.3 * fv;
      grid.push(b.vertex(p, n, scaleRgb(color, shade), j === 0 ? 0.72 : 1));
    }
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < ns - 1; i++) b.quad(grid[j * ns + i]!, grid[j * ns + i + 1]!, grid[(j + 1) * ns + i + 1]!, grid[(j + 1) * ns + i]!);
  // Top and bottom strips, and the two ends, going into the wall.
  const strip = (ys: number[], up: boolean): void => {
    for (let i = 0; i < ns - 1; i++) {
      const a = P(us[i]!, ys[i]!, 0), c = P(us[i + 1]!, ys[i + 1]!, 0), a2 = P(us[i]!, ys[i]!, -depth), c2 = P(us[i + 1]!, ys[i + 1]!, -depth);
      const pts = [a, c, c2, a2];
      const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const e2 = [a2[0] - a[0], a2[1] - a[1], a2[2] - a[2]];
      let n = norm3(cross3(e1, e2));
      if ((n[1] > 0) !== up) n = [-n[0], -n[1], -n[2]];
      const f = b.vertexCount;
      for (const q of pts) b.vertex(q, n, scaleRgb(color, up ? 1.12 : 0.6), up ? 1 : 0.55);
      b.quad(f, f + 1, f + 2, f + 3);
    }
  };
  strip(hi, true);
  strip(lo, false);
  for (const [i, sgn] of [[0, -1], [ns - 1, 1]] as const) {
    const n: Vec3 = [uDir[0] * sgn, 0, uDir[1] * sgn];
    const f = b.vertexCount;
    for (const q of [P(us[i]!, lo[i]!, 0), P(us[i]!, hi[i]!, 0), P(us[i]!, hi[i]!, -depth), P(us[i]!, lo[i]!, -depth)]) b.vertex(q, n, scaleRgb(color, 0.75), 0.6);
    b.quad(f, f + 1, f + 2, f + 3);
  }
  orientToNormals(b, firstIdx);
  return true;
}

/** Signed distance outside every structure footprint (negative inside). */
export const clearOfStructures = (layout: VillageLayout, x: number, z: number): number => structureDist(layout.structures, x, z);

/** Smooth 0–1 mask that is 1 inside `r0` and 0 beyond `r1`. */
export const within = (d: number, r0: number, r1: number): number => 1 - smoothstep(r0, r1, d);

const groundCache = new WeakMap<object, (x: number, z: number) => number>();

/**
 * The ground height as a lazily filled 0.5 m grid with bilinear lookup over ±160 m (exact `heightAt` outside):
 * occlusion baking asks for the ground at every ray step, and `heightAt` is too slow for that.
 */
export function cachedGround(ctx: Pick<BuildContext, 'layout' | 'heightAt'>): (x: number, z: number) => number {
  const hit = groundCache.get(ctx.layout);
  if (hit) return hit;
  const cell = 0.5, half = 160;
  const n = Math.round((2 * half) / cell) + 1;
  const H = new Float32Array(n * n).fill(Number.NaN);
  const heightAt = ctx.heightAt;
  const at = (i: number, j: number): number => {
    const k = j * n + i;
    let y = H[k]!;
    if (Number.isNaN(y)) {
      y = heightAt(-half + i * cell, -half + j * cell);
      H[k] = y;
    }
    return y;
  };
  const fn = (x: number, z: number): number => {
    const fx = (x + half) / cell, fz = (z + half) / cell;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return heightAt(x, z);
    const u = fx - i, v = fz - j;
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
  groundCache.set(ctx.layout, fn);
  return fn;
}
