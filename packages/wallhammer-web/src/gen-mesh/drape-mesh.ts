// A sheet laid on a height field, in tiles: the surface of the field again, lifted a little, with positions only.
// A layer that shows something on the ground (a raster of values, a mask) draws it over the scene. At full density
// the sheet has the field's own vertices and triangles, so it follows the drawn surface exactly; a thinned sheet
// takes the highest height around each vertex, so it never sinks below the surface.

import type { MeshData, VertexLayout } from '../base/data.ts';
import type { Vec3 } from '../base/math.ts';
import type { HeightField } from '../gen-core/height-field.ts';

/** Position 3× float, attribute `a_pos`. */
export const DRAPE_LAYOUT: VertexLayout = { stride: 12, attribs: [{ name: 'a_pos', size: 3, type: 'f32', offset: 0 }] };
/** Attribute location a material should give the sheet. */
export const DRAPE_ATTRIBS = { a_pos: 0 } as const;

export interface DrapeOptions {
  /** Rectangle to cover, in the field's own coordinates (x from 0 east, z from 0 south). Clipped to the field. Default: all of it. */
  rect?: { x0: number; z0: number; x1: number; z1: number };
  /** Lift above the surface in metres. Default 0.15. */
  liftM?: number;
  /** Quads per tile edge, at most 255 (a tile's indices are 16-bit). Default 64. */
  tileQuads?: number;
  /** Use every n-th vertex of the field. Default 1 (the field's own density). */
  every?: number;
  /** Where the field's origin lies in the coordinates the sheet is drawn in. Default [0, 0]. */
  origin?: readonly [number, number];
}

/** One tile of the sheet and the box that holds it. */
export interface DrapeTile {
  mesh: MeshData;
  min: Vec3;
  max: Vec3;
}

/** The smallest `every` with which a sheet over `rect` (default the whole field) has at most `maxVertices` vertices. */
export function drapeEvery(field: HeightField, maxVertices: number, rect?: DrapeOptions['rect']): number {
  const w = rect ? Math.min(field.sizeX, rect.x1) - Math.max(0, rect.x0) : field.sizeX;
  const d = rect ? Math.min(field.sizeZ, rect.z1) - Math.max(0, rect.z0) : field.sizeZ;
  const full = (Math.max(0, w) / field.step + 1) * (Math.max(0, d) / field.step + 1);
  return Math.max(1, Math.ceil(Math.sqrt(full / Math.max(1, maxVertices))));
}

/** Tiles of a sheet over the field. An empty list when the rectangle misses the field. */
export function drapeTiles(field: HeightField, o: DrapeOptions = {}): DrapeTile[] {
  const { cols, rows, step, heights } = field;
  const every = Math.max(1, Math.floor(o.every ?? 1));
  const lift = o.liftM ?? 0.15;
  const tileQuads = Math.max(1, Math.min(255, Math.floor(o.tileQuads ?? 64)));
  const ox = o.origin?.[0] ?? 0;
  const oz = o.origin?.[1] ?? 0;
  const rect = o.rect ?? { x0: 0, z0: 0, x1: field.sizeX, z1: field.sizeZ };
  // The sheet's own grid: vertex (ci, cj) stands on field vertex (ci · every, cj · every), the last one on the edge.
  const lastCi = Math.ceil((cols - 1) / every);
  const lastCj = Math.ceil((rows - 1) / every);
  const cell = step * every;
  const ci0 = Math.max(0, Math.min(lastCi, Math.floor(rect.x0 / cell)));
  const cj0 = Math.max(0, Math.min(lastCj, Math.floor(rect.z0 / cell)));
  const ci1 = Math.max(0, Math.min(lastCi, Math.ceil(rect.x1 / cell)));
  const cj1 = Math.max(0, Math.min(lastCj, Math.ceil(rect.z1 / cell)));
  if (ci1 <= ci0 || cj1 <= cj0 || rect.x1 <= 0 || rect.z1 <= 0 || rect.x0 >= field.sizeX || rect.z0 >= field.sizeZ) return [];
  const fi = (ci: number): number => Math.min(cols - 1, ci * every);
  const fj = (cj: number): number => Math.min(rows - 1, cj * every);
  const heightOf = (ci: number, cj: number): number => {
    const i = fi(ci);
    const j = fj(cj);
    if (every === 1) return heights[j * cols + i]!;
    // The highest field vertex this sheet vertex stands for (one sheet cell to every side).
    let h = -Infinity;
    for (let jj = Math.max(0, j - every); jj <= Math.min(rows - 1, j + every); jj++) {
      for (let ii = Math.max(0, i - every); ii <= Math.min(cols - 1, i + every); ii++) h = Math.max(h, heights[jj * cols + ii]!);
    }
    return h;
  };

  const tiles: DrapeTile[] = [];
  for (let tj = cj0; tj < cj1; tj += tileQuads) {
    for (let ti = ci0; ti < ci1; ti += tileQuads) {
      const i1 = Math.min(ci1, ti + tileQuads);
      const j1 = Math.min(cj1, tj + tileQuads);
      const w = i1 - ti + 1;
      const h = j1 - tj + 1;
      const v = new Float32Array(w * h * 3);
      let minY = Infinity;
      let maxY = -Infinity;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const y = heightOf(ti + i, tj + j) + lift;
          const k = (j * w + i) * 3;
          v[k] = fi(ti + i) * step + ox;
          v[k + 1] = y;
          v[k + 2] = fj(tj + j) * step + oz;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      // The same split of a cell as `heightFieldMesh` (the b–c diagonal), so the two surfaces agree.
      const idx = new Uint16Array((w - 1) * (h - 1) * 6);
      let n = 0;
      for (let j = 0; j < h - 1; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i;
          const b = a + 1;
          const c = a + w;
          const d = c + 1;
          idx[n++] = a;
          idx[n++] = c;
          idx[n++] = b;
          idx[n++] = b;
          idx[n++] = c;
          idx[n++] = d;
        }
      }
      tiles.push({
        mesh: { layout: DRAPE_LAYOUT, vertices: v, indices: idx, count: n },
        min: [fi(ti) * step + ox, minY, fj(tj) * step + oz],
        max: [fi(i1) * step + ox, maxY, fj(j1) * step + oz],
      });
    }
  }
  return tiles;
}
