// Stamps outlines and discs into a byte raster of class codes, for shapes that are about as small as a raster cell.
// A cell takes the stamped code with a probability equal to the share of the cell the shape covers (ordered samples
// inside the cell against a hash of the cell), so many small shapes keep their total area in the raster and shapes
// that overlap add up. The hash depends only on the seed, the cell and the shape's salt, never on the part of the
// raster being worked on: a raster stamped part by part (per tile, in workers) equals one stamped at once.

import { hashInts, unit } from '../gen-core/index.ts';

/**
 * A rectangle of cells of a raster laid over the x–z plane: cell (col, row) covers x from `col × step` and z from
 * `row × step`, one step wide. `col0`, `row0` are the first cell of the rectangle in the whole raster.
 */
export interface CodeRegion {
  col0: number;
  row0: number;
  cols: number;
  rows: number;
  /** Cell size in metres. */
  step: number;
}

/** Samples per cell side that measure the covered share. */
const SUB = 4;
const FULL = SUB * SUB;

export class CodeStamp {
  /** Cells stamped so far (a cell stamped twice counts twice). */
  stamped = 0;
  readonly region: CodeRegion;
  /** The cells of the region, `cols × rows` bytes, row `row0` first. Fill it with what lies under the stamps. */
  readonly codes: Uint8Array;
  private readonly seed: number;
  private counts = new Uint8Array(64);

  constructor(region: CodeRegion, codes: Uint8Array, seed: number) {
    if (codes.length !== region.cols * region.rows) throw new Error('CodeStamp: the raster does not match the region');
    this.region = region;
    this.codes = codes;
    this.seed = seed;
  }

  /** Whether a cell with `hits` covered samples takes the code. */
  private take(col: number, row: number, salt: number, hits: number): boolean {
    if (hits <= 0) return false;
    return hits >= FULL || hits / FULL > unit(hashInts(this.seed, col, row, salt));
  }

  /**
   * Stamps a polygon: rings of x, z pairs (not closed, either winding), inside by the even-odd rule, so later rings
   * cut holes. `salt` tells shapes apart (two shapes on one cell decide independently). Returns the cells stamped.
   */
  polygon(rings: readonly ArrayLike<number>[], code: number, salt: number): number {
    const { col0, row0, cols, rows, step } = this.region;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i + 1 < ring.length; i += 2) {
        const x = ring[i]!;
        const z = ring[i + 1]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    const c0 = Math.max(col0, Math.floor(minX / step));
    const c1 = Math.min(col0 + cols - 1, Math.floor(maxX / step));
    const r0 = Math.max(row0, Math.floor(minZ / step));
    const r1 = Math.min(row0 + rows - 1, Math.floor(maxZ / step));
    if (!(c0 <= c1) || !(r0 <= r1)) return 0;
    const width = c1 - c0 + 1;
    if (this.counts.length < width) this.counts = new Uint8Array(width * 2);
    const counts = this.counts;
    const sub = step / SUB;
    const first = c0 * SUB;
    const last = (c1 + 1) * SUB - 1;
    const xs: number[] = [];
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      counts.fill(0, 0, width);
      for (let s = 0; s < SUB; s++) {
        const z = (r * SUB + s + 0.5) * sub;
        xs.length = 0;
        for (const ring of rings) {
          const m = ring.length >> 1;
          for (let i = 0, j = m - 1; i < m; j = i++) {
            const az = ring[j * 2 + 1]!;
            const bz = ring[i * 2 + 1]!;
            if (az > z !== bz > z) xs.push(ring[j * 2]! + ((z - az) / (bz - az)) * (ring[i * 2]! - ring[j * 2]!));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          // Samples whose centre lies between the two points where the outline cuts the sample row.
          const q0 = Math.max(first, Math.ceil(xs[k]! / sub - 0.5));
          const q1 = Math.min(last, Math.ceil(xs[k + 1]! / sub - 0.5) - 1);
          for (let q = q0; q <= q1; q++) counts[Math.floor(q / SUB) - c0]!++;
        }
      }
      const row = (r - row0) * cols - col0;
      for (let c = c0; c <= c1; c++) {
        if (!this.take(c, r, salt, counts[c - c0]!)) continue;
        this.codes[row + c] = code;
        n++;
      }
    }
    this.stamped += n;
    return n;
  }

  /** Stamps a disc around (x, z). Returns the cells stamped. */
  disc(x: number, z: number, radius: number, code: number, salt: number): number {
    const { col0, row0, cols, rows, step } = this.region;
    const c0 = Math.max(col0, Math.floor((x - radius) / step));
    const c1 = Math.min(col0 + cols - 1, Math.floor((x + radius) / step));
    const r0 = Math.max(row0, Math.floor((z - radius) / step));
    const r1 = Math.min(row0 + rows - 1, Math.floor((z + radius) / step));
    if (!(c0 <= c1) || !(r0 <= r1)) return 0;
    const sub = step / SUB;
    const rr = radius * radius;
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const row = (r - row0) * cols - col0;
      for (let c = c0; c <= c1; c++) {
        let hits = 0;
        for (let j = 0; j < SUB; j++) {
          const dz = (r * SUB + j + 0.5) * sub - z;
          for (let i = 0; i < SUB; i++) {
            const dx = (c * SUB + i + 0.5) * sub - x;
            if (dx * dx + dz * dz <= rr) hits++;
          }
        }
        if (!this.take(c, r, salt, hits)) continue;
        this.codes[row + c] = code;
        n++;
      }
    }
    this.stamped += n;
    return n;
  }
}
