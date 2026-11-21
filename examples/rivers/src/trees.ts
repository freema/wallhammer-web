// Woods: where trees stand on the island and the trees themselves, as chunked meshes for the ground's material. A pure
// function of the field and the seed.
//
// Where: on a coarse grid, a share of wood per point (`coverOf`). Wood grows in patches set by a slow noise and in a
// belt along the water (a point is damp when water lies within a few tens of metres), not on steep ground, not on the
// beach and not above the tree line. A tree then stands at a point of a jittered grid with the chance the cover gives,
// and never where it would stand in the water.
//
// The trees: two kinds, each a trunk and a crown of a few triangles (a broad crown of three uneven rings and two
// poles; a pointed crown of two cones), with a size, a turn and a tint of their own. Their vertices use the ground's layout,
// so the ground's material draws them and they cast shadows like the ground does.

import { hashInts, valueNoise3 } from 'wallhammer-web/gen-core';
import type { V3 } from './colours.ts';
import type { Field } from './field.ts';
import { GROUND_LAYOUT } from './ground-layout.ts';
import { CHUNK_CELLS, putVertex, type GroundPiece } from './ground-mesh.ts';
import { pathAt, type PathHit, type PathPlan } from './paths.ts';
import { smooth } from './land.ts';

/** Field points per point of the cover's grid, and the reach of the damp belt along water, in cover points. */
const COVER_EVERY = 4;
const DAMP_NEAR = 1.5;
const DAMP_FAR = 7;
/** Spacing of the grid a tree may stand on, metres. */
const SPACING_M = 8;
/** No tree stands lower than this over the water beside it, metres. */
const DRY_M = 0.7;

export interface Cover {
  /** Points along one edge, their spacing in metres and the first point's position. */
  n: number;
  step: number;
  x0: number;
  z0: number;
  /** Per point 0–1: the share of the ground under trees, and how near water lies. */
  wood: Float32Array;
  damp: Float32Array;
}

/** The cover of the field's square. */
export function coverOf(f: Field, seed: number): Cover {
  const n = Math.floor((f.n - 1) / COVER_EVERY) + 1;
  const step = f.step * COVER_EVERY;
  // Distance to the nearest fresh water, in cover points (two sweeps of a chamfer distance).
  const dist = new Float32Array(n * n).fill(1e9);
  for (let j = 0; j < f.n; j++)
    for (let i = 0; i < f.n; i++) {
      const k = j * f.n + i;
      if (f.body[k] !== 0 && f.water[k]! > f.ground[k]! + 0.05) dist[Math.min(n - 1, Math.round(j / COVER_EVERY)) * n + Math.min(n - 1, Math.round(i / COVER_EVERY))] = 0;
    }
  const pull = (k: number, q: number, d: number): void => {
    if (dist[q]! + d < dist[k]!) dist[k] = dist[q]! + d;
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (i > 0) pull(k, k - 1, 1);
      if (j > 0) pull(k, k - n, 1);
      if (i > 0 && j > 0) pull(k, k - n - 1, Math.SQRT2);
      if (i < n - 1 && j > 0) pull(k, k - n + 1, Math.SQRT2);
    }
  for (let j = n - 1; j >= 0; j--)
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      if (i < n - 1) pull(k, k + 1, 1);
      if (j < n - 1) pull(k, k + n, 1);
      if (i < n - 1 && j < n - 1) pull(k, k + n + 1, Math.SQRT2);
      if (i > 0 && j < n - 1) pull(k, k + n - 1, Math.SQRT2);
    }
  const h = (i: number, j: number): number => f.ground[Math.min(f.n - 1, Math.max(0, j * COVER_EVERY)) * f.n + Math.min(f.n - 1, Math.max(0, i * COVER_EVERY))]!;
  const wood = new Float32Array(n * n);
  const damp = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = f.x0 + i * step;
      const z = f.z0 + j * step;
      const y = h(i, j);
      const grade = Math.hypot(h(i + 1, j) - h(i - 1, j), h(i, j + 1) - h(i, j - 1)) / (2 * step);
      const near = 1 - smooth(DAMP_NEAR, DAMP_FAR, dist[k]!);
      const patch = smooth(0.5, 0.62, 0.65 * valueNoise3(x, 0, z, 340, seed + 0x77) + 0.35 * valueNoise3(x, 0, z, 90, seed + 0x78));
      // The belt along the water has gaps of its own.
      const belt = near * smooth(0.25, 0.5, valueNoise3(x, 0, z, 120, seed + 0x79));
      damp[k] = near;
      wood[k] = Math.max(patch, 0.9 * belt) * (1 - smooth(0.35, 0.6, grade)) * (1 - smooth(150, 215, y)) * smooth(1.5, 4, y);
    }
  return { n, step, x0: f.x0, z0: f.z0, wood, damp };
}

/** A value of the cover at a point of the plane (bilinear). */
export function coverAt(c: Cover, v: Float32Array, x: number, z: number): number {
  const fx = Math.min(c.n - 1.001, Math.max(0, (x - c.x0) / c.step));
  const fz = Math.min(c.n - 1.001, Math.max(0, (z - c.z0) / c.step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const w = fz - j;
  const k = j * c.n + i;
  return (v[k]! * (1 - u) + v[k + 1]! * u) * (1 - w) + (v[k + c.n]! * (1 - u) + v[k + c.n + 1]! * u) * w;
}

const STRIDE = GROUND_LAYOUT.stride;
/** Sides of a pointed crown and of a broad one. */
const SIDES = 6;
const ROUND = 8;
/** Vertices of one tree at most: a trunk of four sides and a broad crown. */
const TREE_VERTICES = 8 + 3 * ROUND + 2;

const unit = (seed: number, a: number, b: number): number => (hashInts(seed, a, b) % 10000) / 10000;

/** No tree stands nearer to a path's centreline than this, metres. */
const PATH_CLEAR_M = 2.6;

/** The trees of the square, in chunks of the ground's size. With paths, none stands on one. */
export function treePieces(f: Field, cover: Cover, seed: number, paths?: PathPlan): GroundPiece[] {
  const hit: PathHit = { d: 0, ox: 0, oz: 0, y: 0, ford: 0, path: 0, i: 0, t: 0 };
  const size = (f.n - 1) * f.step;
  const chunkM = CHUNK_CELLS * f.step;
  const across = Math.ceil(size / chunkM);
  const lists: number[][] = [];
  const groundAt = (x: number, z: number): number => {
    const fx = Math.min(f.n - 1.001, Math.max(0, (x - f.x0) / f.step));
    const fz = Math.min(f.n - 1.001, Math.max(0, (z - f.z0) / f.step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const w = fz - j;
    const k = j * f.n + i;
    return (f.ground[k]! * (1 - u) + f.ground[k + 1]! * u) * (1 - w) + (f.ground[k + f.n]! * (1 - u) + f.ground[k + f.n + 1]! * u) * w;
  };
  // Trees as x, y, z, the grid point's number: bucketed by chunk.
  const m = Math.floor(size / SPACING_M);
  for (let gj = 1; gj < m; gj++)
    for (let gi = 1; gi < m; gi++) {
      const id = gj * 4096 + gi;
      const x = f.x0 + (gi + unit(seed, 0x7e1, id) - 0.5) * SPACING_M;
      const z = f.z0 + (gj + unit(seed, 0x7e2, id) - 0.5) * SPACING_M;
      if (unit(seed, 0x7e3, id) >= 0.92 * coverAt(cover, cover.wood, x, z)) continue;
      if (paths && pathAt(paths, x, z, hit) && hit.d < PATH_CLEAR_M) continue;
      const y = groundAt(x, z);
      // Not in the water and not on its very edge: against every level named around the tree.
      const i = Math.round((x - f.x0) / f.step);
      const j = Math.round((z - f.z0) / f.step);
      let dry = true;
      for (let dj = -1; dj <= 1 && dry; dj++)
        for (let di = -1; di <= 1 && dry; di++) {
          const k = Math.min(f.n - 1, Math.max(0, j + dj)) * f.n + Math.min(f.n - 1, Math.max(0, i + di));
          if (f.body[k] !== 0 && f.ground[k]! < f.water[k]! + DRY_M) dry = false;
        }
      if (!dry) continue;
      const c = Math.min(across - 1, Math.floor((z - f.z0) / chunkM)) * across + Math.min(across - 1, Math.floor((x - f.x0) / chunkM));
      (lists[c] ??= []).push(x, y, z, id);
    }
  const pieces: GroundPiece[] = [];
  for (const list of lists) {
    if (!list) continue;
    const trees = list.length / 4;
    const view = new DataView(new ArrayBuffer(trees * TREE_VERTICES * STRIDE));
    const idx: number[] = [];
    let v = 0;
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: V3, shade: number): number => {
      const l = Math.hypot(nx, ny, nz) || 1;
      putVertex(view, v, x, y, z, nx / l, ny / l, nz / l, 0, c[0] * shade, c[1] * shade, c[2] * shade);
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
      max[2] = Math.max(max[2], z);
      return v++;
    };
    /** A ring of `SIDES` vertices round (x, z) at height y; `lump` makes its radius uneven. Returns its first vertex. */
    const ring = (x: number, y: number, z: number, r: number, turn: number, up: number, c: V3, shade: number, lump: number, id: number, sides = SIDES): number => {
      const first = v;
      for (let s = 0; s < sides; s++) {
        const a = turn + (s / sides) * 2 * Math.PI;
        const rr = r * (1 - lump + 2 * lump * unit(seed, 0x7e8 + s, id + Math.round(y * 16)));
        vertex(x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, Math.cos(a), up, Math.sin(a), c, shade);
      }
      return first;
    };
    /** Triangles between two rings, or from a ring to one point (`b` < 0: the point `tip`). */
    const band = (a: number, b: number, tip: number, upward: boolean, sides = SIDES): void => {
      for (let s = 0; s < sides; s++) {
        const t = (s + 1) % sides;
        if (b >= 0) idx.push(a + s, b + s, a + t, a + t, b + s, b + t);
        else if (upward) idx.push(a + s, tip, a + t);
        else idx.push(a + t, tip, a + s);
      }
    };
    for (let t = 0; t < trees; t++) {
      const x = list[t * 4]!;
      const y = list[t * 4 + 1]!;
      const z = list[t * 4 + 2]!;
      const id = list[t * 4 + 3]!;
      const grow = 0.7 + 0.65 * unit(seed, 0x7e4, id);
      const turn = unit(seed, 0x7e5, id) * 6.2832;
      const tint = unit(seed, 0x7e6, id);
      // Pointed crowns take over with height; near water the broad ones stay.
      const pointed = unit(seed, 0x7e7, id) < smooth(30, 120, y) * (1 - 0.7 * coverAt(cover, cover.damp, x, z)) + 0.08;
      const bark: V3 = [0.2, 0.15, 0.1];
      const foot = y - 0.4;
      if (pointed) {
        const H = 13 * grow;
        const R = 2.5 * grow;
        const leaf: V3 = [0.055 + 0.03 * tint, 0.13 + 0.05 * tint, 0.065];
        const t0 = ring(x, foot, z, 0.28, turn, 0, bark, 0.8, 0, id, 4);
        const t1 = ring(x, y + 0.2 * H, z, 0.2, turn, 0, bark, 0.8, 0, id, 4);
        band(t0, t1, -1, true, 4);
        const a = ring(x, y + 0.14 * H, z, R, turn, 0.55, leaf, 0.55, 0.12, id);
        band(a, -1, vertex(x, y + 0.72 * H, z, 0, 1, 0, leaf, 1), true);
        const b = ring(x, y + 0.46 * H, z, 0.66 * R, turn + 0.5, 0.55, leaf, 0.7, 0.12, id);
        band(b, -1, vertex(x, y + H, z, 0, 1, 0, leaf, 1.1), true);
      } else {
        const H = 9.5 * grow;
        const R = 3.4 * grow * (0.85 + 0.3 * unit(seed, 0x7e9, id));
        const leaf: V3 = [0.1 + 0.06 * tint, 0.2 + 0.07 * tint, 0.055 + 0.02 * tint];
        const t0 = ring(x, foot, z, 0.34, turn, 0, bark, 0.8, 0, id, 4);
        const t1 = ring(x, y + 0.45 * H, z, 0.24, turn, 0, bark, 0.8, 0, id, 4);
        band(t0, t1, -1, true, 4);
        const low = ring(x, y + 0.43 * H, z, 0.66 * R, turn, -0.6, leaf, 0.5, 0.16, id, ROUND);
        const mid = ring(x, y + 0.62 * H, z, R, turn + 0.4, 0.1, leaf, 0.74, 0.16, id, ROUND);
        const high = ring(x, y + 0.84 * H, z, 0.7 * R, turn + 0.8, 0.9, leaf, 0.98, 0.16, id, ROUND);
        band(low, -1, vertex(x, y + 0.32 * H, z, 0, -1, 0, leaf, 0.4), false, ROUND);
        band(low, mid, -1, true, ROUND);
        band(mid, high, -1, true, ROUND);
        band(high, -1, vertex(x, y + (0.97 + 0.06 * tint) * H, z, 0, 1, 0, leaf, 1.08), true, ROUND);
      }
    }
    pieces.push({
      data: { layout: GROUND_LAYOUT, vertices: new Uint8Array(view.buffer, 0, v * STRIDE), indices: v > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), count: idx.length },
      min,
      max,
    });
  }
  return pieces;
}
