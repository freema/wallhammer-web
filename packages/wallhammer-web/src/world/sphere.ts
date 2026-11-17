// A world wrapped round a point: the sphere implementation of the world shape port, and the test that hides what
// lies behind the sphere's own horizon.
//
// The sphere is a cube blown up (gen-core, cube-sphere): six faces, each the root of a quadtree of cells. A cell id
// carries the face (0–5), the level, and the cell's indices on the face, both from 0 to 2^level − 1. Streaming,
// tickets and budgets work on it unchanged, because they ask the shape for every fact of place.
//
// - Cell-local axes are the world's axes. A cell's origin is the middle of its footprint on the base sphere; content
//   is relative to it, so numbers stay small at any level, and nothing has to be rotated between a cell and the world.
// - "Up" points away from the centre. Heights are measured from the base sphere of `radiusM`.
// - Distances are measured along the base sphere, as the port asks.
//
// Everything here is reproducible arithmetic (the trigonometry of base), so the same camera path asks for the same
// cells on every machine.

import type { Vec3 } from '../base/math.ts';
import { detAsin, detAtan2 } from '../base/trig.ts';
import type { RadialUp } from '../base/up.ts';
import type { CellId, WorldPos, WorldShape } from '../gen-core/cell.ts';
import { cellId, cellKey } from '../gen-core/cell.ts';
import { CUBE_FACE_AXES, cubeDirection, cubeDirectionWarped, cubeFaceOf, cubeGrid, cubeNeighbour, cubeWarp } from '../gen-core/cube-sphere.ts';

const HALF_PI = 1.5707963267948966;
/** Cells whose corner directions are remembered between calls. */
const CORNER_CACHE = 4096;

/** Footprint of a cell: its range on the face in warped coordinates and the unit directions of its four corners. */
interface Footprint {
  wu0: number;
  wu1: number;
  wv0: number;
  wv1: number;
  /** Corners in the order (x, y), (x+1, y), (x+1, y+1), (x, y+1): anticlockwise seen from outside. */
  corners: Float64Array;
}

/** A sphere of six quadtrees. Faces: 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z. */
export class SphereWorld implements WorldShape {
  readonly name = 'sphere';
  /** Radius of the base sphere in metres. */
  readonly radiusM: number;
  /** Centre of the sphere in world metres. */
  readonly centerM: WorldPos;
  /** The same as a description of "up" for a renderer (`RendererOptions.radialUp`). */
  readonly radial: RadialUp;
  readonly hashKey: string;
  private readonly footprints = new Map<string, Footprint>();

  constructor(radiusM: number, center: WorldPos = [0, 0, 0]) {
    if (!(radiusM > 0)) throw new Error(`SphereWorld: radius must be positive, got ${radiusM}`);
    this.radiusM = radiusM;
    this.centerM = [center[0], center[1], center[2]];
    this.radial = { center: this.centerM, radiusM };
    this.hashKey = `sphere:tan:${radiusM}:${center[0]},${center[1]},${center[2]}`;
  }

  /**
   * Edge of a cell of this level along the base sphere: a quarter of the circumference for a whole face. It is the
   * longest edge a cell of the level has (the edges through the face's middle); toward the corners edges shrink to
   * about three quarters of it.
   */
  edgeM(level: number): number {
    return (HALF_PI * this.radiusM) / 2 ** level;
  }

  /** Unit direction from the centre to a world position (+y at the centre itself). */
  directionOf(p: WorldPos): Vec3 {
    const x = p[0] - this.centerM[0];
    const y = p[1] - this.centerM[1];
    const z = p[2] - this.centerM[2];
    const l = Math.sqrt(x * x + y * y + z * z);
    return l > 0 ? [x / l, y / l, z / l] : [0, 1, 0];
  }

  /** Height of a world position above the base sphere. */
  altitude(p: WorldPos): number {
    const x = p[0] - this.centerM[0];
    const y = p[1] - this.centerM[1];
    const z = p[2] - this.centerM[2];
    return Math.sqrt(x * x + y * y + z * z) - this.radiusM;
  }

  /** World position `heightM` above the base sphere, on the line from the centre through `p`. */
  atHeight(p: WorldPos, heightM: number = 0): WorldPos {
    const d = this.directionOf(p);
    const r = this.radiusM + heightM;
    return [this.centerM[0] + d[0] * r, this.centerM[1] + d[1] * r, this.centerM[2] + d[2] * r];
  }

  /**
   * How far under the sphere the flat triangles of a grid can dip: a cell of `level` drawn with `quads` intervals
   * along its edge has its vertices on the sphere and its triangles a little inside it. Lower the radius of a horizon
   * occluder by the drop of the coarsest level that is drawn (see `horizonHidden`).
   */
  facetDropM(level: number, quads: number): number {
    // Half the diagonal of a quad, as an angle; 1 − cos a is at most a² / 2.
    const a = (HALF_PI / 2 ** level / quads) * Math.SQRT1_2;
    return (this.radiusM * a * a) / 2;
  }

  cellAt(p: WorldPos, level: number): CellId {
    const n = 2 ** level;
    const { face, s, t } = cubeFaceOf(this.directionOf(p));
    const x = Math.min(n - 1, Math.max(0, Math.floor(((s + 1) / 2) * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(((t + 1) / 2) * n)));
    return cellId(face, level, x, y);
  }

  origin(c: CellId): WorldPos {
    return this.center(c);
  }

  toLocal(c: CellId, p: WorldPos): Vec3 {
    const o = this.center(c);
    return [Math.fround(p[0] - o[0]), Math.fround(p[1] - o[1]), Math.fround(p[2] - o[2])];
  }

  toWorld(c: CellId, local: readonly [number, number, number]): WorldPos {
    const o = this.center(c);
    return [o[0] + local[0], o[1] + local[1], o[2] + local[2]];
  }

  distanceM(c: CellId, p: WorldPos): number {
    const f = this.footprint(c);
    const d = this.directionOf(p);
    const a = CUBE_FACE_AXES[c.face]!;
    const along = d[0] * a.n[0] + d[1] * a.n[1] + d[2] * a.n[2];
    if (along > 0) {
      const pu = (d[0] * a.u[0] + d[1] * a.u[1] + d[2] * a.u[2]) / along;
      const pv = (d[0] * a.v[0] + d[1] * a.v[1] + d[2] * a.v[2]) / along;
      if (pu >= f.wu0 && pu <= f.wu1 && pv >= f.wv0 && pv <= f.wv1) return 0;
    }
    // Outside: the nearest point lies on one of the four edges, each an arc of a great circle.
    const k = f.corners;
    let best = Infinity;
    for (let e = 0; e < 4; e++) {
      const i = e * 3;
      const j = ((e + 1) % 4) * 3;
      const angle = arcDistance(d[0], d[1], d[2], k[i]!, k[i + 1]!, k[i + 2]!, k[j]!, k[j + 1]!, k[j + 2]!);
      if (angle < best) best = angle;
    }
    return best * this.radiusM;
  }

  center(c: CellId): WorldPos {
    const n = 2 * 2 ** c.level;
    const d = cubeDirection(c.face, cubeGrid(2 * c.x + 1, n), cubeGrid(2 * c.y + 1, n));
    const r = this.radiusM;
    return [this.centerM[0] + d[0] * r, this.centerM[1] + d[1] * r, this.centerM[2] + d[2] * r];
  }

  /** Cells of `level` within `reachM`, face by face, each face in the order of its quadtree. `Infinity` gives them all. */
  cellsNear(p: WorldPos, reachM: number, level: number): CellId[] {
    const out: CellId[] = [];
    // A cell's footprint lies inside its parent's, so a parent out of reach has no child in reach.
    const slack = this.radiusM * 1e-9;
    const visit = (c: CellId): void => {
      if (reachM < Infinity && this.distanceM(c, p) > reachM + slack) return;
      if (c.level === level) {
        out.push(c);
        return;
      }
      for (const child of this.children(c)) visit(child);
    };
    for (let face = 0; face < 6; face++) visit(cellId(face, 0, 0, 0));
    return out;
  }

  /**
   * Cells sharing an edge or a corner. A cell at a corner of the cube has seven: three faces meet there, and no cell
   * lies diagonally across the corner.
   */
  neighbours(c: CellId): CellId[] {
    const out: CellId[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const n = cubeNeighbour(c.face, c.level, c.x, c.y, dx, dy);
        if (n) out.push(cellId(n.face, c.level, n.x, n.y));
      }
    }
    return out;
  }

  parent(c: CellId): CellId | null {
    if (c.level === 0) return null;
    return cellId(c.face, c.level - 1, Math.floor(c.x / 2), Math.floor(c.y / 2));
  }

  children(c: CellId): CellId[] {
    const l = c.level + 1;
    const x = c.x * 2;
    const y = c.y * 2;
    return [cellId(c.face, l, x, y), cellId(c.face, l, x + 1, y), cellId(c.face, l, x, y + 1), cellId(c.face, l, x + 1, y + 1)];
  }

  upAt(p: WorldPos): Vec3 {
    return this.directionOf(p);
  }

  /** The point of the base sphere under `p`, in metres from the centre: what 3D noise is evaluated at. */
  noiseDomain(p: WorldPos): [number, number, number] {
    const d = this.directionOf(p);
    return [d[0] * this.radiusM, d[1] * this.radiusM, d[2] * this.radiusM];
  }

  private footprint(c: CellId): Footprint {
    const key = cellKey(c);
    let f = this.footprints.get(key);
    if (f) return f;
    const n = 2 ** c.level;
    const wu0 = cubeWarp(cubeGrid(c.x, n));
    const wu1 = cubeWarp(cubeGrid(c.x + 1, n));
    const wv0 = cubeWarp(cubeGrid(c.y, n));
    const wv1 = cubeWarp(cubeGrid(c.y + 1, n));
    const corners = new Float64Array(12);
    const d: Vec3 = [0, 0, 0];
    const put = (i: number, wu: number, wv: number): void => {
      cubeDirectionWarped(c.face, wu, wv, d);
      corners.set(d, i * 3);
    };
    put(0, wu0, wv0);
    put(1, wu1, wv0);
    put(2, wu1, wv1);
    put(3, wu0, wv1);
    f = { wu0, wu1, wv0, wv1, corners };
    // The cache only saves work; what it returns does not depend on what it holds.
    if (this.footprints.size >= CORNER_CACHE) this.footprints.clear();
    this.footprints.set(key, f);
    return f;
  }
}

/** Angle between two unit vectors, exact for small angles too. */
function angleBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return detAtan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
}

/** Angle from unit direction p to the nearest point of the arc of a great circle from a to b (unit, less than half a turn apart). */
function arcDistance(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  // Normal of the arc's plane.
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nl > 0) {
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const off = px * nx + py * ny + pz * nz;
    // p dropped onto the plane; it lies over the arc when it is on b's side of a and on a's side of b.
    const qx = px - off * nx;
    const qy = py - off * ny;
    const qz = pz - off * nz;
    const fromA = (ay * qz - az * qy) * nx + (az * qx - ax * qz) * ny + (ax * qy - ay * qx) * nz;
    const toB = (qy * bz - qz * by) * nx + (qz * bx - qx * bz) * ny + (qx * by - qy * bx) * nz;
    if (fromA >= 0 && toB >= 0) return detAsin(Math.min(1, Math.abs(off)));
  }
  return Math.min(angleBetween(px, py, pz, ax, ay, az), angleBetween(px, py, pz, bx, by, bz));
}

/**
 * True when nothing of a body can be seen because the sphere's own bulge is in the way: the test for culling by the
 * horizon. All it needs is distances, so it is cheap and never hides something that shows.
 *
 * - `eye`: the viewer relative to the sphere's centre.
 * - `occluderRadiusM`: radius of the sphere that hides things. It must lie under everything that is drawn, so use the
 *   base radius plus the lowest height the content can have; a larger one cuts holes at the horizon.
 * - `nearestM`: distance from the viewer to the nearest point of the body (to its bounding box, say).
 * - `maxRadiusM`: the largest distance from the centre any point of the body has (its highest point).
 *
 * A point at radius r can be seen at most `√(|eye|² − R²) + √(r² − R²)` away: the viewer's distance to the horizon
 * plus the point's own. A body whose nearest point is farther than that for its highest point is hidden as a whole.
 */
export function horizonHidden(eye: readonly [number, number, number], occluderRadiusM: number, nearestM: number, maxRadiusM: number): boolean {
  const r2 = occluderRadiusM * occluderRadiusM;
  const e2 = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2];
  // A viewer inside the hiding sphere sees through it: hide nothing.
  if (!(e2 > r2)) return false;
  const far = Math.sqrt(e2 - r2) + Math.sqrt(Math.max(0, maxRadiusM * maxRadiusM - r2));
  return nearestM > far;
}

/** The largest distance from a centre that any point of an axis-aligned box has (it is always at a corner). */
export function boxMaxRadius(min: readonly [number, number, number], max: readonly [number, number, number], center: readonly [number, number, number]): number {
  let r2 = 0;
  for (let i = 0; i < 3; i++) {
    const a = Math.abs(min[i]! - center[i]!);
    const b = Math.abs(max[i]! - center[i]!);
    const m = a > b ? a : b;
    r2 += m * m;
  }
  return Math.sqrt(r2);
}
