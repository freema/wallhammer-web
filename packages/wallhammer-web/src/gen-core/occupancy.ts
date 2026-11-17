// Occupied area: a grid of flags saying what already occupies each place on the ground (one bit per kind the project defines).
// Generation layers write into it and later layers avoid it accordingly. Sources can be combined:
// a class raster and also vectors (axes with width, areas), for places the raster does not see.

import { pointInRings } from './geometry.ts';
import type { Ring } from './geometry.ts';

export class Occupancy {
  readonly step: number;
  readonly cols: number;
  readonly rows: number;
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly data: Uint8Array;

  constructor(sizeX: number, sizeZ: number, step = 0.5) {
    this.sizeX = sizeX;
    this.sizeZ = sizeZ;
    this.step = step;
    this.cols = Math.ceil(sizeX / step);
    this.rows = Math.ceil(sizeZ / step);
    this.data = new Uint8Array(this.cols * this.rows);
  }

  /** Flags at a point. 0 outside the grid. */
  at(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return 0;
    return this.data[Math.floor(z / this.step) * this.cols + Math.floor(x / this.step)]!;
  }

  /**
   * Writes flags from the class raster: `flagsByCode[code]` says what each class occupies. A cell gets the union of
   * every raster pixel that overlaps it, including pixels that straddle the cell border.
   */
  stampRaster(codes: Uint8Array, codeCols: number, codeRows: number, codeStep: number, flagsByCode: Uint8Array): void {
    const per = this.step / codeStep;
    // Small tolerance so a border that falls exactly on a pixel edge does not pull in the next pixel.
    const eps = 1e-6;
    for (let j = 0; j < this.rows; j++) {
      const r0 = Math.min(codeRows - 1, Math.floor(j * per + eps));
      const r1 = Math.min(codeRows, Math.max(r0 + 1, Math.ceil((j + 1) * per - eps)));
      for (let i = 0; i < this.cols; i++) {
        const c0 = Math.min(codeCols - 1, Math.floor(i * per + eps));
        const c1 = Math.min(codeCols, Math.max(c0 + 1, Math.ceil((i + 1) * per - eps)));
        let f = 0;
        for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) f |= flagsByCode[codes[r * codeCols + c]!]!;
        if (f) this.data[j * this.cols + i]! |= f;
      }
    }
  }

  /** Writes a strip around a polyline (flat array x, z) of the given width. */
  stampPolyline(points: ArrayLike<number>, width: number, flag: number): void {
    const half = width / 2;
    const n = points.length / 2;
    for (let k = 0; k + 1 < n; k++) {
      const ax = points[k * 2]!;
      const az = points[k * 2 + 1]!;
      const bx = points[k * 2 + 2]!;
      const bz = points[k * 2 + 3]!;
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - half) / this.step));
      const c1 = Math.min(this.cols - 1, Math.floor((Math.max(ax, bx) + half) / this.step));
      const r0 = Math.max(0, Math.floor((Math.min(az, bz) - half) / this.step));
      const r1 = Math.min(this.rows - 1, Math.floor((Math.max(az, bz) + half) / this.step));
      for (let r = r0; r <= r1; r++) {
        const pz = (r + 0.5) * this.step;
        for (let c = c0; c <= c1; c++) {
          const px = (c + 0.5) * this.step;
          let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - ax - t * dx;
          const ez = pz - az - t * dz;
          if (ex * ex + ez * ez <= half * half) this.data[r * this.cols + c]! |= flag;
        }
      }
    }
  }

  /** Writes the interior of a polygon (outer boundary and holes). */
  stampPolygon(rings: Ring[], flag: number): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k += 2) {
        minX = Math.min(minX, ring[k]!);
        maxX = Math.max(maxX, ring[k]!);
        minZ = Math.min(minZ, ring[k + 1]!);
        maxZ = Math.max(maxZ, ring[k + 1]!);
      }
    }
    const c0 = Math.max(0, Math.floor(minX / this.step));
    const c1 = Math.min(this.cols - 1, Math.floor(maxX / this.step));
    const r0 = Math.max(0, Math.floor(minZ / this.step));
    const r1 = Math.min(this.rows - 1, Math.floor(maxZ / this.step));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (pointInRings((c + 0.5) * this.step, (r + 0.5) * this.step, rings)) this.data[r * this.cols + c]! |= flag;
      }
    }
  }
}
