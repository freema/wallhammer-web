// The fine grid of squares near instances are made in on a sphere, and the ground of one square as a small lattice.
//
// A square is a cell of the cube-sphere grid at one level (`cubeGrid` over each face): its key names it for
// `nearScatter`, its distance from a direction decides whether it is wanted, and `near` lists every square a reach
// round a direction touches, across the edges of the cube. The ground of a square is held by the caller as a lattice of
// (sub + 1)² points with fields beside it (positions, densities, colours); `nearLatticeValue` reads a field between the
// points and `nearPatch` gives the point and the outward normal of the ground there, so the slope of the ground at a
// candidate (`nearSlopeDeg`) can keep instances off steep faces.
//
// Pure: arithmetic, Math.sqrt / hypot / floor / min / max / acos and the cube grid.

import type { Vec3 } from '../base/math.ts';
import { cubeDirection, cubeFaceOf, cubeGrid, cubeNeighbour } from './cube-sphere.ts';

/** One square of the grid: a face of the cube and its column and row at the grid's level. */
export interface NearSquare {
  face: number;
  i: number;
  j: number;
}

export interface NearSquareGridOptions {
  /** Level of the cube grid: 2^level squares along a face's edge. */
  level: number;
  /** Radius of the base sphere, m. */
  radiusM: number;
  /** Half the diagonal of the largest square, m: the distance to a square is that to its middle less this. */
  halfDiagM: number;
  /**
   * Take the square under the direction whatever its distance, and walk on from it while nothing is in reach yet
   * (default false). On a grid warped by the cube the estimate of the square under a direction is not exact, and a
   * square in reach can lie one step beyond a start that is not.
   */
  keepStart?: boolean;
}

/** The squares of one level of the cube-sphere grid, with their distances from a direction. */
export class NearSquareGrid {
  readonly level: number;
  readonly radiusM: number;
  readonly halfDiagM: number;
  readonly keepStart: boolean;
  /** Squares along a face's edge. */
  readonly size: number;

  constructor(o: NearSquareGridOptions) {
    this.level = o.level;
    this.radiusM = o.radiusM;
    this.halfDiagM = o.halfDiagM;
    this.keepStart = o.keepStart ?? false;
    this.size = 2 ** o.level;
  }

  /** A text naming the square, `face:i:j`. */
  key(s: NearSquare): string {
    return `${s.face}:${s.i}:${s.j}`;
  }

  /** Unit direction of the middle of a square. */
  centre(s: NearSquare): Vec3 {
    return cubeDirection(s.face, cubeGrid(2 * s.i + 1, 2 * this.size), cubeGrid(2 * s.j + 1, 2 * this.size));
  }

  /**
   * Metres from the point under the unit direction `dir` (on the base sphere) to the nearest point a square can have:
   * the distance to its middle less half the diagonal, never below 0.
   */
  distanceM(dir: Vec3, s: NearSquare): number {
    const c = this.centre(s);
    const dx = c[0] - dir[0];
    const dy = c[1] - dir[1];
    const dz = c[2] - dir[2];
    return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) * this.radiusM - this.halfDiagM);
  }

  /** Every square the reach round `dir` touches, nearest first (ties by face, j, i), into `out`, which is returned. */
  near(dir: Vec3, reachM: number, out: NearSquare[]): NearSquare[] {
    out.length = 0;
    const ns = this.size;
    const keepStart = this.keepStart;
    const f = cubeFaceOf(dir);
    const i0 = Math.min(ns - 1, Math.max(0, Math.floor(((f.s + 1) / 2) * ns)));
    const j0 = Math.min(ns - 1, Math.max(0, Math.floor(((f.t + 1) / 2) * ns)));
    const seen = new Set<string>();
    const dist = new Map<string, number>();
    const todo: NearSquare[] = [{ face: f.face, i: i0, j: j0 }];
    seen.add(this.key(todo[0]!));
    while (todo.length > 0) {
      const s = todo.pop()!;
      const d = this.distanceM(dir, s);
      if (keepStart) {
        if (d > reachM && out.length > 0) continue;
        if (d <= reachM) {
          out.push(s);
          dist.set(this.key(s), d);
        }
      } else {
        if (d > reachM) continue;
        out.push(s);
        dist.set(this.key(s), d);
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = cubeNeighbour(s.face, this.level, s.i, s.j, dx, dy);
        if (!n) continue;
        const q = { face: n.face, i: n.x, j: n.y };
        const k = this.key(q);
        if (seen.has(k)) continue;
        seen.add(k);
        // From a start out of reach, walk on only toward the direction.
        if (keepStart && d > reachM && this.distanceM(dir, q) > d) continue;
        todo.push(q);
      }
    }
    out.sort((a, b) => dist.get(this.key(a))! - dist.get(this.key(b))! || a.face - b.face || a.j - b.j || a.i - b.i);
    return out;
  }
}

/**
 * A field of a lattice of (sub + 1)² points read at (u, v) ∈ [0, 1]² of the square, bilinear between the points.
 * The field holds `width` numbers per point, point (i, j) at `((j · (sub + 1) + i) · width)`; `c` picks one of them.
 */
export function nearLatticeValue(field: ArrayLike<number>, sub: number, width: number, c: number, u: number, v: number): number {
  const lat = sub + 1;
  const fu = u * sub;
  const fv = v * sub;
  const qi = Math.min(sub - 1, Math.floor(fu));
  const qj = Math.min(sub - 1, Math.floor(fv));
  const tu = fu - qi;
  const tv = fv - qj;
  const at = (i: number, j: number): number => field[(j * lat + i) * width + c]!;
  const a = at(qi, qj) + (at(qi + 1, qj) - at(qi, qj)) * tu;
  const b = at(qi, qj + 1) + (at(qi + 1, qj + 1) - at(qi, qj + 1)) * tu;
  return a + (b - a) * tv;
}

/** The ground at a point of a square: the point and the outward unit normal. */
export interface NearPatchPoint {
  p: [number, number, number];
  n: [number, number, number];
}

/** A fresh `NearPatchPoint` to write into. */
export function newNearPatchPoint(): NearPatchPoint {
  return { p: [0, 0, 0], n: [0, 0, 1] };
}

/**
 * The ground at (u, v) ∈ [0, 1]² of a square whose lattice positions (x y z per point, from the sphere's centre) are
 * `pos`: the quad of the lattice it lies in as a bilinear patch, the point on it and the patch's normal there, turned
 * away from the centre. Writes into `out` and returns it.
 */
export function nearPatch(pos: ArrayLike<number>, sub: number, u: number, v: number, out: NearPatchPoint): NearPatchPoint {
  const lat = sub + 1;
  const fu = u * sub;
  const fv = v * sub;
  const qi = Math.min(sub - 1, Math.floor(fu));
  const qj = Math.min(sub - 1, Math.floor(fv));
  const tu = fu - qi;
  const tv = fv - qj;
  const i00 = (qj * lat + qi) * 3;
  const i10 = i00 + 3;
  const i01 = i00 + lat * 3;
  const i11 = i01 + 3;
  const p = out.p;
  const du: number[] = [0, 0, 0];
  const dv: number[] = [0, 0, 0];
  for (let q = 0; q < 3; q++) {
    const a = pos[i00 + q]! + (pos[i10 + q]! - pos[i00 + q]!) * tu;
    const c = pos[i01 + q]! + (pos[i11 + q]! - pos[i01 + q]!) * tu;
    p[q] = a + (c - a) * tv;
    du[q] = pos[i10 + q]! - pos[i00 + q]! + (pos[i11 + q]! - pos[i01 + q]! - pos[i10 + q]! + pos[i00 + q]!) * tv;
    dv[q] = c - a;
  }
  let nx = du[1]! * dv[2]! - du[2]! * dv[1]!;
  let ny = du[2]! * dv[0]! - du[0]! * dv[2]!;
  let nz = du[0]! * dv[1]! - du[1]! * dv[0]!;
  if (nx * p[0] + ny * p[1] + nz * p[2] < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  out.n[0] = nx / nl;
  out.n[1] = ny / nl;
  out.n[2] = nz / nl;
  return out;
}

/** Degrees between the ground's normal at a patch point and the up of its place (away from the sphere's centre). */
export function nearSlopeDeg(at: NearPatchPoint): number {
  const p = at.p;
  const pl = Math.hypot(p[0], p[1], p[2]) || 1;
  const c = (at.n[0] * p[0] + at.n[1] * p[1] + at.n[2] * p[2]) / pl;
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}
