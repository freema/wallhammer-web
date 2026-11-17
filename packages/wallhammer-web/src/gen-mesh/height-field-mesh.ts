// Mesh of a height field: the surface plus a vertical skirt along its perimeter down to a base level, so the field
// reads as a solid block when seen from the side.

import type { MeshData, VertexLayout } from '../base/data.ts';
import type { HeightField } from '../gen-core/height-field.ts';

/** Attribute names and the locations a material should give them. */
export const HEIGHT_FIELD_ATTRIBS = { a_pos: 0, a_normal: 1 } as const;

/** Position 3× float; normal 3× int16 (not normalized, ×32767) and the kind (0 surface, 1 skirt) as the fourth int16. */
export const HEIGHT_FIELD_LAYOUT: VertexLayout = {
  stride: 20,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i16', offset: 12 },
  ],
};

/** Kind of surface, stored in the fourth component of the normal. */
const KIND_TOP = 0;
const KIND_SKIRT = 1;

/**
 * Mesh of the surface and of the vertical cut down to level baseY. The normal has 16 bits: with eight, the slope of
 * gentle hills changes in visible jumps.
 */
export function heightFieldMesh(field: HeightField, baseY: number): MeshData {
  const { cols, rows, step, heights } = field;
  const skirtVerts = 2 * (2 * cols + 2 * rows);
  const vertCount = cols * rows + skirtVerts;
  const STRIDE = HEIGHT_FIELD_LAYOUT.stride;
  const buf = new ArrayBuffer(vertCount * STRIDE);
  const view = new DataView(buf);
  const put = (v: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: number): void => {
    const o = v * STRIDE;
    view.setFloat32(o, x, true);
    view.setFloat32(o + 4, y, true);
    view.setFloat32(o + 8, z, true);
    view.setInt16(o + 12, Math.round(nx * 32767), true);
    view.setInt16(o + 14, Math.round(ny * 32767), true);
    view.setInt16(o + 16, Math.round(nz * 32767), true);
    view.setInt16(o + 18, kind, true);
  };
  const h = (i: number, j: number): number => heights[Math.min(rows - 1, Math.max(0, j)) * cols + Math.min(cols - 1, Math.max(0, i))]!;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const [nx, ny, nz] = field.vertexNormal(i, j);
      put(j * cols + i, i * step, h(i, j), j * step, nx, ny, nz, KIND_TOP);
    }
  }
  const quadCount = (cols - 1) * (rows - 1) + 2 * (cols - 1) + 2 * (rows - 1);
  const idx = new Uint32Array(quadCount * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx[n++] = a;
      idx[n++] = c;
      idx[n++] = b;
      idx[n++] = b;
      idx[n++] = c;
      idx[n++] = d;
    }
  }
  // Perimeter cut: four sides, each as a strip of vertex pairs (terrain on top, base at the bottom).
  let v = cols * rows;
  const side = (count: number, at: (k: number) => [number, number], nx: number, nz: number, flip: boolean): void => {
    const start = v;
    for (let k = 0; k < count; k++) {
      const [i, j] = at(k);
      put(v++, i * step, h(i, j), j * step, nx, 0, nz, KIND_SKIRT);
      put(v++, i * step, baseY, j * step, nx, 0, nz, KIND_SKIRT);
    }
    for (let k = 0; k < count - 1; k++) {
      const t0 = start + k * 2;
      const b0 = t0 + 1;
      const t1 = t0 + 2;
      const b1 = t0 + 3;
      if (flip) {
        idx[n++] = t0;
        idx[n++] = t1;
        idx[n++] = b0;
        idx[n++] = t1;
        idx[n++] = b1;
        idx[n++] = b0;
      } else {
        idx[n++] = t0;
        idx[n++] = b0;
        idx[n++] = t1;
        idx[n++] = t1;
        idx[n++] = b0;
        idx[n++] = b1;
      }
    }
  };
  side(cols, (k) => [k, 0], 0, -1, true); // north
  side(cols, (k) => [k, rows - 1], 0, 1, false); // south
  side(rows, (k) => [0, k], -1, 0, false); // west
  side(rows, (k) => [cols - 1, k], 1, 0, true); // east
  return { layout: HEIGHT_FIELD_LAYOUT, vertices: new Uint8Array(buf), indices: idx, count: n };
}
