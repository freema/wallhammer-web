// The light horizon of a surface: for every cell of a raster of surface heights, the height below which a point above
// that cell is hidden from a directional light by the rest of the surface. One number per cell answers "is this point
// lit" for the ground and for anything standing on it (a point is lit when it lies above the horizon), so a coarse
// raster over a whole scene can stand in for a shadow map where the shadow map does not reach.
//
// `SurfaceRaster` collects the heights (a base surface, raised under outlines and discs), `lightHorizon` sweeps it
// once along the light and `horizonTexture` packs the result into two bytes per cell for the renderer.

import type { TextureData } from '../base/data.ts';

/**
 * Surface heights in square cells over the x–z plane: cell (col, row) covers x from `col × step` and z from
 * `row × step`, and holds the height at its centre.
 */
export class SurfaceRaster {
  readonly cols: number;
  readonly rows: number;
  /** Cell size in metres. */
  readonly step: number;
  /** `cols × rows` heights, row 0 first. */
  readonly heights: Float32Array;

  /** `base(x, z)` gives the height of the bare surface at a cell centre; without it the raster starts at 0. */
  constructor(cols: number, rows: number, step: number, base?: (x: number, z: number) => number) {
    this.cols = cols;
    this.rows = rows;
    this.step = step;
    this.heights = new Float32Array(cols * rows);
    if (base) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) this.heights[r * cols + c] = base((c + 0.5) * step, (r + 0.5) * step);
    }
  }

  /**
   * Raises every cell whose centre lies inside a polygon to at least `top`. Rings of x, z pairs (not closed, either
   * winding), inside by the even-odd rule, so later rings cut holes. Returns the cells raised.
   */
  raisePolygon(rings: readonly ArrayLike<number>[], top: number): number {
    const { cols, rows, step } = this;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i += 2) {
        const z = ring[i]!;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    const r0 = Math.max(0, Math.ceil(minZ / step - 0.5));
    const r1 = Math.min(rows - 1, Math.ceil(maxZ / step - 0.5) - 1);
    const xs: number[] = [];
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const z = (r + 0.5) * step;
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
        // Cells whose centre lies between the two points where the outline cuts the row of centres.
        const c0 = Math.max(0, Math.ceil(xs[k]! / step - 0.5));
        const c1 = Math.min(cols - 1, Math.ceil(xs[k + 1]! / step - 0.5) - 1);
        for (let c = c0; c <= c1; c++) {
          const o = r * cols + c;
          if (this.heights[o]! < top) {
            this.heights[o] = top;
            n++;
          }
        }
      }
    }
    return n;
  }

  /** Raises every cell whose centre lies within `radius` of (x, z) to at least `top`. Returns the cells raised. */
  raiseDisc(x: number, z: number, radius: number, top: number): number {
    const { cols, rows, step } = this;
    const c0 = Math.max(0, Math.ceil((x - radius) / step - 0.5));
    const c1 = Math.min(cols - 1, Math.ceil((x + radius) / step - 0.5) - 1);
    const r0 = Math.max(0, Math.ceil((z - radius) / step - 0.5));
    const r1 = Math.min(rows - 1, Math.ceil((z + radius) / step - 0.5) - 1);
    const rr = radius * radius;
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const dz = (r + 0.5) * step - z;
      for (let c = c0; c <= c1; c++) {
        const dx = (c + 0.5) * step - x;
        if (dx * dx + dz * dz > rr) continue;
        const o = r * cols + c;
        if (this.heights[o]! < top) {
          this.heights[o] = top;
          n++;
        }
      }
    }
    return n;
  }
}

/** The light counts as at least this high above the horizontal (rise per metre): a lower one would shade everything. */
const MIN_RISE = 0.03;
/** Below this horizontal share of the direction the light comes from straight above and nothing shades anything. */
const MIN_RUN = 1e-4;

/**
 * The light horizon of a surface for a unit direction toward the light (`toLight`, y up): per cell the height below
 * which a point over the cell centre is hidden from the light by other cells. `-Infinity` where nothing stands between
 * the cell and the light.
 *
 * One sweep, row by row away from the light: a cell's horizon is the higher of surface and horizon one row closer
 * to the light, lowered by what the light gains in height over that step. The light rarely runs along the rows, so the
 * value one row closer is read between two cells; that widens and softens a shadow a little with its length, which
 * suits a term that is only used far away. The cost does not depend on the light's height.
 */
export function lightHorizon(surface: SurfaceRaster, toLight: readonly [number, number, number]): Float32Array {
  const { cols, rows, step, heights } = surface;
  const out = new Float32Array(cols * rows).fill(-Infinity);
  const run = Math.hypot(toLight[0], toLight[2]);
  if (!(run > MIN_RUN) || cols === 0 || rows === 0) return out;
  const rise = Math.max(toLight[1] / run, MIN_RISE);
  // Sweep along the axis the light direction follows more closely; `lines` are the rows of that sweep.
  const alongZ = Math.abs(toLight[2]) >= Math.abs(toLight[0]);
  const major = alongZ ? toLight[2] : toLight[0];
  const minor = alongZ ? toLight[0] : toLight[2];
  const lines = alongZ ? rows : cols;
  const width = alongZ ? cols : rows;
  const toward = major > 0 ? 1 : -1;
  // Per line toward the light the direction moves this many cells sideways.
  const shift = minor / Math.abs(major);
  const drop = step * Math.sqrt(1 + shift * shift) * rise;
  const at = (line: number, k: number): number => (alongZ ? line * cols + k : k * cols + line);
  // The higher of surface and horizon of the line closer to the light.
  const closer = new Float32Array(width);
  for (let n = 1; n < lines; n++) {
    const line = toward > 0 ? lines - 1 - n : n;
    const from = line + toward;
    for (let k = 0; k < width; k++) closer[k] = Math.max(heights[at(from, k)]!, out[at(from, k)]!);
    for (let k = 0; k < width; k++) {
      const s = k + shift;
      const k0 = Math.floor(s);
      const f = s - k0;
      const a = closer[Math.min(width - 1, Math.max(0, k0))]!;
      const b = closer[Math.min(width - 1, Math.max(0, k0 + 1))]!;
      out[at(line, k)] = a + (b - a) * f - drop;
    }
  }
  return out;
}

/** A light horizon packed for the renderer. */
export interface HorizonTexture {
  /** Two bytes per cell (`rg8`, high byte first), filtered linearly: `baseY + code / 65535 × rangeM`. */
  texture: TextureData;
  /** The height code 0 stands for: the lowest point of the surface, below which nothing needs an answer. */
  baseY: number;
  /** The span of heights the codes cover, metres. */
  rangeM: number;
}

/**
 * Packs a horizon (`lightHorizon`) of a surface into a texture. Heights below the lowest point of the surface
 * (and cells without a horizon) become code 0: every point of the surface is lit there.
 */
export function horizonTexture(horizon: Float32Array, surface: SurfaceRaster): HorizonTexture {
  const { cols, rows, heights } = surface;
  let baseY = Infinity;
  let top = -Infinity;
  for (let i = 0; i < heights.length; i++) if (heights[i]! < baseY) baseY = heights[i]!;
  for (let i = 0; i < horizon.length; i++) if (horizon[i]! > top) top = horizon[i]!;
  if (!Number.isFinite(baseY)) baseY = 0;
  const rangeM = Math.max(1, top - baseY);
  const data = new Uint8Array(cols * rows * 2);
  for (let i = 0; i < cols * rows; i++) {
    const h = horizon[i]!;
    const code = h > baseY ? Math.min(65535, Math.round(((h - baseY) / rangeM) * 65535)) : 0;
    data[i * 2] = code >> 8;
    data[i * 2 + 1] = code & 255;
  }
  return { texture: { width: cols, height: rows, format: 'rg8', data, filter: 'linear' }, baseY, rangeM };
}
