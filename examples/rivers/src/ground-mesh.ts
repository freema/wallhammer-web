// The island's ground as chunked meshes, built from a `Field` of the whole square: one piece per block of
// `CHUNK_CELLS` × `CHUNK_CELLS` grid cells, each with its own box for culling (`PieceLayer`). Normals come from the
// height grid, vertex colours from `groundColour`. Beyond the square a flat sea floor reaches toward the horizon,
// joined to the square's edge by a skirt. Pure data: nothing here touches the GPU.
//
// Vertex layout (`GROUND_LAYOUT` in ground-layout.ts, 32 bytes): the engine's `CELL_SURFACE_LAYOUT`
// (`wallhammer-web/gen-mesh`: position 3× f32 in world metres, normal 3× i16 (×32767) with the kind (0 surface,
// 1 skirt) as the fourth, colour 4× u8 normalized with the height over the water as its fourth) and after it the
// paths near the vertex:
//   a_path    4× i8  xy the vector from the vertex to the nearest point of a centreline of the paths of side 0 along
//                    x and z, in steps of 1 / `PATH_UNITS` m (at most `PATH_FAR_M` long); zw the same for side 1
//   a_pathOn  4× u8  normalized: x, y how much of a path there is on side 0 and 1 (none without a path near and in a
//                    ford); z, w how much trodden earth that path shows there (`PathKinds.wear`: a full tread on
//                    a trodden line, little between stepping stones and under boards)
// The vector, not the distance: across a centreline the distance has a crease that a mesh coarser than the path is
// wide cannot carry, while the vector runs through zero in a straight line. The material takes its length per pixel.
// One vector per side (`PathPlan.side`), not one to the nearest path of all: between two paths that meet the nearest
// one changes from vertex to vertex, and a vector interpolated between the two ways would run through zero where
// there is no path. A vertex farther than `PATH_OFF_M` from a path names none, for the same reason: inside a hairpin
// the nearest point of one path jumps too.

import type { MeshData } from 'wallhammer-web/base';
import { groundColour, mix, sat, type V3 } from './colours.ts';
import type { Field } from './field.ts';
import { GROUND_ATTRIBS, GROUND_LAYOUT, PATH_FAR_M, PATH_UNITS } from './ground-layout.ts';
import type { PathKinds } from './path-kinds.ts';
import { pathAt, type PathHit, type PathPlan } from './paths.ts';
import { coverAt, type Cover } from './trees.ts';

export { GROUND_ATTRIBS, GROUND_LAYOUT, PATH_FAR_M, PATH_UNITS };

/** Vertex spacing of the ground, metres: that of the finest ground cells of the larger examples. */
export const STEP_M = 2.5;
/** Grid cells along one edge of a chunk. 64 cells keep a chunk under 65 536 vertices (16-bit indices). */
export const CHUNK_CELLS = 64;
/** Height of the sea floor beyond the square, metres. */
export const SEA_FLOOR_M = -45;
/** How far beyond the square's edge the sea floor and the open sea reach, metres: well under the horizon haze. */
export const SEA_REACH_M = 40000;

/** One chunk: its mesh and the axis-aligned box that holds it. */
export interface GroundPiece {
  data: MeshData;
  min: [number, number, number];
  max: [number, number, number];
}

const STRIDE = GROUND_LAYOUT.stride;
/** A vertex names a path fully within the first distance from its centreline and not at all from the second, metres. */
const PATH_ON_M = 4;
const PATH_OFF_M = 5.5;

/** Grass near water, and the ground under trees (linear colours). */
export const LUSH: V3 = [0.2, 0.36, 0.11];
export const UNDER_WOOD: V3 = [0.17, 0.25, 0.1];

/** The colour's fourth byte: the height over the water that may stand at the vertex, `OVER_MIN_M` to `OVER_MAX_M`. */
export const OVER_MIN_M = -1;
export const OVER_MAX_M = 2;

/** How many vertices beyond a line's floor its level still measures the bank. */
const SHORE_ROUNDS = 3;
/** A bank is drawn only this near water, metres: in full up to the first, fading out by the second. */
const BANK_NEAR_M = 5;
const BANK_FAR_M = 11;

/** Per point of a field: the distance to the nearest wet point, metres, capped at `far` (a two-pass chamfer). */
function toWater(f: Field, far: number): Float32Array {
  const { n, step, ground, water } = f;
  const d = new Float32Array(n * n).fill(far);
  for (let k = 0; k < n * n; k++) if (water[k]! > ground[k]! + 0.03) d[k] = 0;
  const diag = step * Math.SQRT2;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      let v = d[k]!;
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, d[k - 1]! + step);
      if (j > 0) {
        v = Math.min(v, d[k - n]! + step);
        if (i > 0) v = Math.min(v, d[k - n - 1]! + diag);
        if (i < n - 1) v = Math.min(v, d[k - n + 1]! + diag);
      }
      d[k] = v;
    }
  for (let j = n - 1; j >= 0; j--)
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let v = d[k]!;
      if (v === 0) continue;
      if (i < n - 1) v = Math.min(v, d[k + 1]! + step);
      if (j < n - 1) {
        v = Math.min(v, d[k + n]! + step);
        if (i < n - 1) v = Math.min(v, d[k + n + 1]! + diag);
        if (i > 0) v = Math.min(v, d[k + n - 1]! + diag);
      }
      d[k] = v;
    }
  return d;
}

/**
 * Writes one vertex of `GROUND_LAYOUT`, with no path near it (`putPath` adds one). `over`: its height over the water
 * that may stand there, metres.
 */
export function putVertex(view: DataView, v: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: number, r: number, g: number, b: number, over = OVER_MAX_M): void {
  const o = v * STRIDE;
  view.setFloat32(o, x, true);
  view.setFloat32(o + 4, y, true);
  view.setFloat32(o + 8, z, true);
  view.setInt16(o + 12, Math.round(nx * 32767), true);
  view.setInt16(o + 14, Math.round(ny * 32767), true);
  view.setInt16(o + 16, Math.round(nz * 32767), true);
  view.setInt16(o + 18, kind, true);
  view.setUint8(o + 20, Math.round(Math.min(1, Math.max(0, r)) * 255));
  view.setUint8(o + 21, Math.round(Math.min(1, Math.max(0, g)) * 255));
  view.setUint8(o + 22, Math.round(Math.min(1, Math.max(0, b)) * 255));
  view.setUint8(o + 23, Math.round(Math.min(1, Math.max(0, (over - OVER_MIN_M) / (OVER_MAX_M - OVER_MIN_M))) * 255));
  view.setInt8(o + 24, 127);
  view.setInt8(o + 25, 0);
  view.setInt8(o + 26, 127);
  view.setInt8(o + 27, 0);
  view.setUint32(o + 28, 0, true);
}

/**
 * The height of the ground at a point exactly as its mesh draws it: every cell is two triangles, split from
 * (i + 1, j) to (i, j + 1). What stands or walks on the ground takes its height from here.
 */
export function groundHeightAt(f: Field, x: number, z: number): number {
  const fx = Math.min(f.n - 1.001, Math.max(0, (x - f.x0) / f.step));
  const fz = Math.min(f.n - 1.001, Math.max(0, (z - f.z0) / f.step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const w = fz - j;
  const k = j * f.n + i;
  const h10 = f.ground[k + 1]!;
  const h01 = f.ground[k + f.n]!;
  if (u + w <= 1) return f.ground[k]! + (h10 - f.ground[k]!) * u + (h01 - f.ground[k]!) * w;
  const h11 = f.ground[k + f.n + 1]!;
  return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - w);
}

/**
 * A path that ends on another (a junction) is drawn this much past its end, metres. A vertex beyond an end points at
 * the end itself, and between such a vertex and one beside the path the interpolated distance is too long: the tread
 * would thin to a point a cell short of the path it joins. Drawn a little longer, it runs into that path's tread.
 */
const JOIN_PAST_M = 0.35;

/** Moves a hit at the end of a path that joins another onto the path's line drawn `JOIN_PAST_M` past that end. */
function pastJunction(paths: PathPlan, hit: PathHit, x: number, z: number): void {
  const p = paths.paths[hit.path]!;
  const first = hit.i === 0 && hit.t <= 0;
  const last = hit.i >= p.n - 2 && hit.t >= 1;
  if (!first && !last) return;
  if (paths.places[first ? p.from : p.to]!.name !== 'junction') return;
  const e = first ? 0 : p.n - 1;
  const q = first ? 1 : p.n - 2;
  const dx = p.x[e]! - p.x[q]!;
  const dz = p.z[e]! - p.z[q]!;
  const l = Math.hypot(dx, dz) || 1;
  const along = Math.min(JOIN_PAST_M, Math.max(0, ((x - p.x[e]!) * dx + (z - p.z[e]!) * dz) / l));
  hit.ox = p.x[e]! + (dx / l) * along - x;
  hit.oz = p.z[e]! + (dz / l) * along - z;
  hit.d = Math.hypot(hit.ox, hit.oz);
}

/** Names the path of one side at a vertex: the hit of `pathAt` for that side. */
function putPath(view: DataView, v: number, side: number, hit: PathHit, wear: number): void {
  const o = v * STRIDE;
  // A vector longer than the layout carries keeps its direction.
  const s = Math.min(1, PATH_FAR_M / Math.max(hit.d, 1e-6)) * PATH_UNITS;
  view.setInt8(o + 24 + 2 * side, Math.round(Math.min(127, Math.max(-127, hit.ox * s))));
  view.setInt8(o + 25 + 2 * side, Math.round(Math.min(127, Math.max(-127, hit.oz * s))));
  const on = (1 - hit.ford) * (1 - sat((hit.d - PATH_ON_M) / (PATH_OFF_M - PATH_ON_M)));
  view.setUint8(o + 28 + side, Math.round(255 * sat(on)));
  view.setUint8(o + 30 + side, Math.round(255 * sat(wear)));
}

/**
 * Names the paths of both sides at a vertex at (x, z). The ground's own vertices get this, and so does whatever lies
 * flat on the ground and is to carry the trodden earth exactly as the ground under it does.
 */
export function putPaths(view: DataView, v: number, paths: PathPlan, kinds: PathKinds | undefined, x: number, z: number, hit: PathHit): void {
  for (let side = 0; side < 2; side++)
    if (pathAt(paths, x, z, hit, side)) {
      pastJunction(paths, hit, x, z);
      const w = kinds?.wear[hit.path];
      putPath(view, v, side, hit, w ? w[hit.i]! + (w[Math.min(w.length - 1, hit.i + 1)]! - w[hit.i]!) * hit.t : 1);
    }
}

/**
 * The ground of the square, in chunks of `CHUNK_CELLS` cells. With a cover the grass is lusher near water and darker
 * under the woods; with paths every vertex near one carries the way to its centreline.
 */
export function groundPieces(f: Field, cover?: Cover, paths?: PathPlan, kinds?: PathKinds): GroundPiece[] {
  const { n, step, x0, z0, ground, water } = f;
  const h = (i: number, j: number): number => ground[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))]!;
  const pieces: GroundPiece[] = [];
  // The level the bank is measured from. A point the field names (a lake's or a line's) has its own. The field names a
  // line only on its floor; a few vertices beyond it the nearest water is still that line's, so the level is carried
  // outward ring by ring. Without this the bank would end on the vertex grid where the field stops naming the line.
  const shore = Float32Array.from(water);
  const carried = new Uint8Array(n * n);
  let known = Uint8Array.from(f.body, (b) => (b !== 0 ? 1 : 0));
  for (let round = 0; round < SHORE_ROUNDS; round++) {
    const next = Uint8Array.from(known);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (known[k]) continue;
        let top = -Infinity;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const a = i + di;
            const b = j + dj;
            if (a >= 0 && b >= 0 && a < n && b < n && known[b * n + a] && shore[b * n + a]! > top) top = shore[b * n + a]!;
          }
        if (top > -Infinity) {
          shore[k] = top;
          next[k] = 1;
          carried[k] = 1;
        }
      }
    known = next;
  }
  // A bank belongs to water: ground that lies low over a level with no water near it (a spring's dry head) has none.
  const wetNear = toWater(f, BANK_FAR_M);
  const hit: PathHit = { d: 0, ox: 0, oz: 0, y: 0, ford: 0, path: 0, i: 0, t: 0 };
  for (let cj = 0; cj < n - 1; cj += CHUNK_CELLS)
    for (let ci = 0; ci < n - 1; ci += CHUNK_CELLS) {
      const ni = Math.min(CHUNK_CELLS, n - 1 - ci) + 1;
      const nj = Math.min(CHUNK_CELLS, n - 1 - cj) + 1;
      const view = new DataView(new ArrayBuffer(ni * nj * STRIDE));
      let minY = Infinity;
      let maxY = -Infinity;
      for (let b = 0; b < nj; b++)
        for (let a = 0; a < ni; a++) {
          const i = ci + a;
          const j = cj + b;
          const y = h(i, j);
          let nx = (h(i - 1, j) - h(i + 1, j)) / (2 * step);
          let nz = (h(i, j - 1) - h(i, j + 1)) / (2 * step);
          const l = Math.hypot(nx, 1, nz);
          nx /= l;
          nz /= l;
          const ny = 1 / l;
          // The colour without the bank: the material draws the bank from the height over the water, per pixel, so
          // its edge is a contour of the ground and not the saw of the vertex grid.
          let c = groundColour(y, 1 - ny, OVER_MAX_M);
          if (cover) {
            const px = x0 + i * step;
            const pz = z0 + j * step;
            const level = 1 - sat((1 - ny - 0.15) / 0.25);
            c = mix(c, LUSH, 0.55 * coverAt(cover, cover.damp, px, pz) * level);
            c = mix(c, UNDER_WOOD, 0.6 * coverAt(cover, cover.wood, px, pz) * level);
          }
          // Dry ground that lies under a level carried to it is no bank: it lies behind the bank, down a slope.
          const k = j * n + i;
          const bank = carried[k] && y < shore[k]! ? OVER_MAX_M : y - shore[k]!;
          const away = sat((wetNear[k]! - BANK_NEAR_M) / (BANK_FAR_M - BANK_NEAR_M));
          const over = bank + (OVER_MAX_M - bank) * away;
          putVertex(view, b * ni + a, x0 + i * step, y, z0 + j * step, nx, ny, nz, 0, c[0], c[1], c[2], over);
          if (paths) putPaths(view, b * ni + a, paths, kinds, x0 + i * step, z0 + j * step, hit);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      const idx = new Uint16Array((ni - 1) * (nj - 1) * 6);
      let m = 0;
      for (let b = 0; b < nj - 1; b++)
        for (let a = 0; a < ni - 1; a++) {
          const p = b * ni + a;
          idx[m++] = p;
          idx[m++] = p + ni;
          idx[m++] = p + 1;
          idx[m++] = p + 1;
          idx[m++] = p + ni;
          idx[m++] = p + ni + 1;
        }
      pieces.push({
        data: { layout: GROUND_LAYOUT, vertices: new Uint8Array(view.buffer), indices: idx, count: m },
        min: [x0 + ci * step, minY, z0 + cj * step],
        max: [x0 + (ci + ni - 1) * step, maxY, z0 + (cj + nj - 1) * step],
      });
    }
  return pieces;
}

/**
 * Beyond the square: the sea floor at `SEA_FLOOR_M` as four quads round the square out to `SEA_REACH_M`, and a skirt
 * from the square's edge down to it, so no gap shows where the edge of the field is not yet sea floor.
 */
export function seaFloorPiece(f: Field): GroundPiece {
  const { n, step, x0, z0, ground } = f;
  const verts: number[][] = [];
  const idx: number[] = [];
  const sand = groundColour(SEA_FLOOR_M, 0, SEA_FLOOR_M);
  const vertex = (x: number, y: number, z: number, nx: number, nz: number, kind: number): number => {
    verts.push([x, y, z, nx, nx === 0 && nz === 0 ? 1 : 0, nz, kind]);
    return verts.length - 1;
  };
  /** A quad a b c d (in order round it), its triangles turned to face along the normal (nx, ny, nz). */
  const quad = (a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void => {
    const p = verts[a]!;
    const q = verts[b]!;
    const r = verts[c]!;
    const e1 = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
    const e2 = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    if (cx * nx + cy * ny + cz * nz >= 0) idx.push(a, b, c, a, c, d);
    else idx.push(a, c, b, a, d, c);
  };
  // The floor: four quads round the square.
  const lo = x0;
  const hi = x0 + (n - 1) * step;
  const zl = z0;
  const zh = z0 + (n - 1) * step;
  const R = SEA_REACH_M;
  const floor = (xa: number, za: number, xb: number, zb: number): void => {
    const a = vertex(xa, SEA_FLOOR_M, za, 0, 0, 0);
    const b = vertex(xb, SEA_FLOOR_M, za, 0, 0, 0);
    const c = vertex(xb, SEA_FLOOR_M, zb, 0, 0, 0);
    const d = vertex(xa, SEA_FLOOR_M, zb, 0, 0, 0);
    quad(a, b, c, d, 0, 1, 0);
  };
  floor(lo - R, zl - R, hi + R, zl);
  floor(lo - R, zh, hi + R, zh + R);
  floor(lo - R, zl, lo, zh);
  floor(hi, zl, hi + R, zh);
  // The skirt along each edge, facing outward.
  const side = (at: (k: number) => [number, number], nx: number, nz: number): void => {
    for (let k = 0; k < n - 1; k++) {
      const [i0, j0] = at(k);
      const [i1, j1] = at(k + 1);
      const t0 = vertex(x0 + i0 * step, ground[j0 * n + i0]!, z0 + j0 * step, nx, nz, 1);
      const t1 = vertex(x0 + i1 * step, ground[j1 * n + i1]!, z0 + j1 * step, nx, nz, 1);
      const b1 = vertex(x0 + i1 * step, SEA_FLOOR_M, z0 + j1 * step, nx, nz, 1);
      const b0 = vertex(x0 + i0 * step, SEA_FLOOR_M, z0 + j0 * step, nx, nz, 1);
      quad(t0, t1, b1, b0, nx, 0, nz);
    }
  };
  side((k) => [k, 0], 0, -1);
  side((k) => [k, n - 1], 0, 1);
  side((k) => [0, k], -1, 0);
  side((k) => [n - 1, k], 1, 0);
  const view = new DataView(new ArrayBuffer(verts.length * STRIDE));
  let maxY = SEA_FLOOR_M;
  verts.forEach((v, k) => {
    putVertex(view, k, v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!, v[6]!, sand[0], sand[1], sand[2]);
    maxY = Math.max(maxY, v[1]!);
  });
  return {
    data: { layout: GROUND_LAYOUT, vertices: new Uint8Array(view.buffer), indices: new Uint32Array(idx), count: idx.length },
    min: [lo - R, SEA_FLOOR_M - 1, zl - R],
    max: [hi + R, maxY, zh + R],
  };
}
