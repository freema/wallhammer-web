// What the strip mesher needs from the surface the streamed cells draw: which cell holds a point, what a cell's meshes
// are relative to, where a straight way between two points of the base surface meets the edges of the triangles a
// level draws, and the height of those triangles at any point. Two surfaces: the plane of a `FlatWorld` drawn by the
// cell morph mesh of gen-mesh, and the sphere drawn by `spherePatchMesh`.
//
// A straight way a → b is the segment on the plane and the great arc on the sphere; the point at share t is
// `(1 − t)·a + t·b` on the plane and `normalise((1 − t)·a + t·b) · radiusM` on the sphere. The shares where it meets a
// line of a grid are computed from that line alone, so two cells that share the line get the same bits, across an
// edge of the cube as well (its plane is the same from both faces, up to the sign of its normal).

import { CUBE_FACE_AXES, cubeDirection, cubeFaceCoords, cubeFaceOf, cubeGrid, cubeWarp } from './cube-sphere.ts';
import { cellId, FACE_FLAT } from './cell.ts';
import type { CellId, FlatWorld } from './cell.ts';
import { spherePatchRadius, spherePatchSplitsAD } from './sphere-patch.ts';
import type { SpherePatchSplit } from './sphere-patch.ts';

type P3 = readonly [number, number, number];

export interface StripSurface {
  /** Radius of the base sphere; 0 = the plane. */
  readonly radiusM: number;
  /** The cell of `level` that holds the base point p. */
  cellAt(level: number, p: P3): CellId;
  /** What the cell's meshes are relative to (the bits the surface mesh uses). */
  origin(cell: CellId): [number, number, number];
  /** Nominal vertex spacing of a level in metres. */
  spacingM(level: number): number;
  /**
   * Ascending shares t ∈ [0, 1] of the straight way a → b: where it enters and leaves `cell` (first and last) and,
   * between them, where it meets an edge of the triangles the cell's level draws (both families of grid lines and the
   * diagonal each quad is split by). Empty when the way misses the cell. Every piece between two shares belongs to
   * the cell: a piece on a border belongs to the cell `cellAt` gives for its middle.
   */
  cuts(cell: CellId, a: P3, b: P3): number[];
  /** Height above the base surface of the flat triangles `level` draws over base point p, in whichever cell holds it. */
  heightOn(level: number, p: P3): number;
}

/** Shares closer than this to the one before are dropped. */
const SHARE_EPS = 1e-9;
const HALF_PI = 1.5707963267948966;

/** Sorts, drops near duplicates and keeps the pieces whose middle the cell holds. */
function ownPieces(shares: number[], cell: CellId, middleCell: (t: number) => CellId): number[] {
  shares.sort((x, y) => x - y);
  const clean: number[] = [];
  for (const t of shares) if (clean.length === 0 || t - clean[clean.length - 1]! >= SHARE_EPS) clean.push(t);
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i++) {
    const c = middleCell((clean[i]! + clean[i + 1]!) / 2);
    if (c.face !== cell.face || c.level !== cell.level || c.x !== cell.x || c.y !== cell.y) continue;
    if (out.length === 0 || out[out.length - 1] !== clean[i]) out.push(clean[i]!);
    out.push(clean[i + 1]!);
  }
  return out;
}

/** The plane of a flat world whose cells are drawn with `quads` intervals along their edge (`cellMorphMesh`). */
export function flatStripSurface(o: { shape: FlatWorld; quads: number; heightAt: (x: number, z: number) => number }): StripSurface {
  const { shape, quads: q, heightAt } = o;
  const cellAt = (level: number, p: P3): CellId => shape.cellAt([p[0], 0, p[2]], level);
  return {
    radiusM: 0,
    cellAt,
    origin: (cell) => {
      const g = shape.origin(cell);
      return [g[0], g[1], g[2]];
    },
    spacingM: (level) => shape.edgeM(level) / q,
    cuts: (cell, a, b) => {
      if (cell.face !== FACE_FLAT) return [];
      const step = shape.edgeM(cell.level) / q;
      const gx0 = cell.x * q;
      const gz0 = cell.y * q;
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const ds = dx + dz;
      const tx = (k: number): number => (k * step - a[0]) / dx;
      const tz = (k: number): number => (k * step - a[2]) / dz;
      const td = (k: number): number => (k * step - (a[0] + a[2])) / ds;
      // Clip to the cell, borders included.
      let lo = 0;
      let hi = 1;
      if (dx === 0) {
        if (a[0] < gx0 * step || a[0] > (gx0 + q) * step) return [];
      } else {
        const t0 = tx(gx0);
        const t1 = tx(gx0 + q);
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
      if (dz === 0) {
        if (a[2] < gz0 * step || a[2] > (gz0 + q) * step) return [];
      } else {
        const t0 = tz(gz0);
        const t1 = tz(gz0 + q);
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
      if (!(hi > lo)) return [];
      const shares = [lo, hi];
      const add = (t: number): void => {
        if (t > lo && t < hi) shares.push(t);
      };
      if (dx !== 0) for (let k = gx0 + 1; k < gx0 + q; k++) add(tx(k));
      if (dz !== 0) for (let k = gz0 + 1; k < gz0 + q; k++) add(tz(k));
      // Diagonals: the quad (i, j) is split from (i + 1, j) to (i, j + 1), so all of them lie on lines x + z = k·step.
      if (ds !== 0) for (let k = gx0 + gz0 + 1; k < gx0 + gz0 + 2 * q; k++) add(td(k));
      return ownPieces(shares, cell, (t) => cellAt(cell.level, [a[0] + dx * t, 0, a[2] + dz * t]));
    },
    heightOn: (level, p) => {
      const e = shape.edgeM(level);
      const step = e / q;
      const c = cellAt(level, p);
      const ox = c.x * e;
      const oz = c.y * e;
      const u = (p[0] - ox) / step;
      const v = (p[2] - oz) / step;
      const i = Math.min(q - 1, Math.max(0, Math.floor(u)));
      const j = Math.min(q - 1, Math.max(0, Math.floor(v)));
      const fu = u - i;
      const fv = v - j;
      const at = (s: number, t: number): number => heightAt(ox + s * step, oz + t * step);
      // The split of `cellMorphMesh`: along the diagonal from (i + 1, j) to (i, j + 1).
      if (fu + fv <= 1) {
        const h = at(i, j);
        return h + (at(i + 1, j) - h) * fu + (at(i, j + 1) - h) * fv;
      }
      const h = at(i + 1, j + 1);
      return h + (at(i, j + 1) - h) * (1 - fu) + (at(i + 1, j) - h) * (1 - fv);
    },
  };
}

/**
 * The sphere of six quadtrees whose cells are drawn by `spherePatchMesh` with `quads` intervals along their edge. Pass
 * the `split` the cells are made with (default `'fixed'`), so the diagonals the ways are cut at are the drawn ones.
 */
export function sphereStripSurface(o: { radiusM: number; quads: number; heightAt: (x: number, y: number, z: number) => number; split?: SpherePatchSplit }): StripSurface {
  const R = o.radiusM;
  const q = o.quads;
  const split: SpherePatchSplit = o.split ?? 'fixed';
  /** Distance from the centre of grid vertex (i, j) of a face, the bits `spherePatchMesh` decides its split by. */
  const vertexR = (face: number, i: number, j: number, N: number): number => {
    const d = cubeDirection(face, cubeGrid(i, N), cubeGrid(j, N));
    return R + o.heightAt(d[0] * R, d[1] * R, d[2] * R);
  };
  if (!(R > 0)) throw new Error(`sphereStripSurface: radiusM must be positive, got ${R}`);
  const unit = (p: P3): [number, number, number] => {
    const l = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    return l > 0 ? [p[0] / l, p[1] / l, p[2] / l] : [0, 1, 0];
  };
  // As SphereWorld.cellAt.
  const cellOfDir = (level: number, d: P3): CellId => {
    const n = 2 ** level;
    const { face, s, t } = cubeFaceOf(d);
    const x = Math.min(n - 1, Math.max(0, Math.floor(((s + 1) / 2) * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(((t + 1) / 2) * n)));
    return cellId(face, level, x, y);
  };
  /** Normal of the plane through the centre that holds grid line g of a face (u-lines: along v, at u = w(g)). */
  const lineNormal = (face: number, alongU: boolean, g: number, N: number): [number, number, number] => {
    const ax = CUBE_FACE_AXES[face]!;
    const w = cubeWarp(cubeGrid(g, N));
    const e = alongU ? ax.u : ax.v;
    return [w * ax.n[0] - e[0], w * ax.n[1] - e[1], w * ax.n[2] - e[2]];
  };
  /** Unnormalised direction of grid vertex (i, j) of a face, as `cubeDirectionWarped` builds it. */
  const vertexDir = (face: number, i: number, j: number, N: number): [number, number, number] => {
    const ax = CUBE_FACE_AXES[face]!;
    const wu = cubeWarp(cubeGrid(i, N));
    const wv = cubeWarp(cubeGrid(j, N));
    return [ax.n[0] + ax.u[0] * wu + ax.v[0] * wv, ax.n[1] + ax.u[1] * wu + ax.v[1] * wv, ax.n[2] + ax.u[2] * wu + ax.v[2] * wv];
  };
  return {
    radiusM: R,
    cellAt: (level, p) => cellOfDir(level, unit(p)),
    origin: (cell) => {
      const d = cubeDirection(cell.face, cubeGrid(2 * cell.x + 1, 2 * 2 ** cell.level), cubeGrid(2 * cell.y + 1, 2 * 2 ** cell.level));
      return [d[0] * R, d[1] * R, d[2] * R];
    },
    spacingM: (level) => (HALF_PI * R) / 2 ** level / q,
    cuts: (cell, a, b) => {
      const ax = CUBE_FACE_AXES[cell.face];
      if (!ax) return [];
      const N = q * 2 ** cell.level;
      const gx0 = cell.x * q;
      const gy0 = cell.y * q;
      const dot = (n: readonly number[], p: P3): number => n[0]! * p[0] + n[1]! * p[1] + n[2]! * p[2];
      /** Share where the way meets the plane through the centre with normal n. */
      const meet = (n: readonly number[]): number => {
        const na = dot(n, a);
        return na / (na - dot(n, b));
      };
      // Clip by the near half of the face and the four borders, as half-spaces through the centre.
      let lo = 0;
      let hi = 1;
      const clip = (n: readonly number[], sign: number): boolean => {
        const fa = sign * dot(n, a);
        const fb = sign * dot(n, b);
        if (fa < 0 && fb < 0) return false;
        if (fa >= 0 && fb >= 0) return true;
        const t = meet(n);
        if (fa < 0) lo = Math.max(lo, t);
        else hi = Math.min(hi, t);
        return true;
      };
      if (!clip(ax.n, 1)) return [];
      // Inside: u ≥ w(g0)·n, u ≤ w(g1)·n; the line normal is w·n − u.
      if (!clip(lineNormal(cell.face, true, gx0, N), -1)) return [];
      if (!clip(lineNormal(cell.face, true, gx0 + q, N), 1)) return [];
      if (!clip(lineNormal(cell.face, false, gy0, N), -1)) return [];
      if (!clip(lineNormal(cell.face, false, gy0 + q, N), 1)) return [];
      if (!(hi > lo)) return [];
      const grid = [lo, hi];
      for (let g = gx0 + 1; g < gx0 + q; g++) {
        const t = meet(lineNormal(cell.face, true, g, N));
        if (t > lo && t < hi) grid.push(t);
      }
      for (let g = gy0 + 1; g < gy0 + q; g++) {
        const t = meet(lineNormal(cell.face, false, g, N));
        if (t > lo && t < hi) grid.push(t);
      }
      grid.sort((x, y) => x - y);
      const at = (t: number): [number, number, number] => unit([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      // Between two lines of the grid the way stays in one quad; add where it meets that quad's diagonal.
      const shares = grid.slice();
      for (let k = 0; k + 1 < grid.length; k++) {
        const t0 = grid[k]!;
        const t1 = grid[k + 1]!;
        if (!(t1 > t0)) continue;
        const [s, t] = cubeFaceCoords(cell.face, at((t0 + t1) / 2));
        if (s !== s || t !== t) continue;
        const i = Math.min(gx0 + q - 1, Math.max(gx0, Math.floor(((s + 1) / 2) * N)));
        const j = Math.min(gy0 + q - 1, Math.max(gy0, Math.floor(((t + 1) / 2) * N)));
        // The diagonal the quad is cut along: b–c, or a–d where the split rule says so.
        const ad = split !== 'fixed' && spherePatchSplitsAD(split, vertexR(cell.face, i, j, N), vertexR(cell.face, i + 1, j, N), vertexR(cell.face, i, j + 1, N), vertexR(cell.face, i + 1, j + 1, N));
        const p = ad ? vertexDir(cell.face, i, j, N) : vertexDir(cell.face, i + 1, j, N);
        const r = ad ? vertexDir(cell.face, i + 1, j + 1, N) : vertexDir(cell.face, i, j + 1, N);
        const n = [p[1] * r[2] - p[2] * r[1], p[2] * r[0] - p[0] * r[2], p[0] * r[1] - p[1] * r[0]];
        const td = meet(n);
        if (td > t0 && td < t1) shares.push(td);
      }
      return ownPieces(shares, cell, (t) => cellOfDir(cell.level, at(t)));
    },
    heightOn: (level, p) => {
      const d = unit(p);
      const c = cellOfDir(level, d);
      return spherePatchRadius({ radiusM: R, face: c.face, level, x: c.x, y: c.y, quads: q, heightAt: o.heightAt, split }, d, 1) - R;
    },
  };
}
