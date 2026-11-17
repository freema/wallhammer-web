// Surface mesh of one cell, sampled from a function of world coordinates. Content is a function of the world, not of
// the cell it is generated in: heights are sampled at world points computed in double, and normals come from a grid
// with a one-sample margin around the cell, so the border vertices of two neighbouring cells carry identical
// heights, normals and colours. A skirt hangs from the perimeter and hides the cracks against a coarser neighbour.

import type { MeshData, VertexLayout } from '../base/data.ts';

/** Locations a material should give the attributes. */
export const CELL_SURFACE_ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2 } as const;

/**
 * Position 3× float relative to the cell origin; normal 3× int16 (×32767) and the kind (0 surface, 1 skirt) as the
 * fourth int16; colour 4× u8 normalized (the alpha channel is free for the content: a surface class or a flag).
 */
export const CELL_SURFACE_LAYOUT: VertexLayout = {
  stride: 24,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i16', offset: 12 },
    { name: 'a_color', size: 4, type: 'u8', normalized: true, offset: 20 },
  ],
};

export interface CellSurfaceOptions {
  /** World position of the cell origin (double). The mesh is relative to it. */
  originX: number;
  originZ: number;
  /** Edge of the cell in metres and the number of quads along it. */
  size: number;
  quads: number;
  /** Height at a world point (double in, any number out). Must be a pure function of the point. */
  heightAt: (x: number, z: number) => number;
  /** RGBA bytes of a surface point from its world position, height and unit normal. Default mid grey. */
  colorAt?: (x: number, z: number, y: number, nx: number, ny: number, nz: number) => readonly [number, number, number, number];
  /** How far the skirt hangs below the perimeter, in metres. 0 = no skirt. */
  skirtDepth: number;
}

export interface CellSurface {
  mesh: MeshData;
  minY: number;
  maxY: number;
}

const KIND_TOP = 0;
const KIND_SKIRT = 1;

export function cellSurfaceMesh(o: CellSurfaceOptions): CellSurface {
  const q = o.quads;
  const n = q + 1;
  const step = o.size / q;
  // Heights on (n + 2)² samples: one sample of margin on each side for the central differences of the normals.
  const m = n + 2;
  const h = new Float64Array(m * m);
  for (let j = 0; j < m; j++) {
    const z = o.originZ + (j - 1) * step;
    for (let i = 0; i < m; i++) h[j * m + i] = o.heightAt(o.originX + (i - 1) * step, z);
  }
  const H = (i: number, j: number): number => h[(j + 1) * m + (i + 1)]!;

  const skirt = o.skirtDepth > 0;
  const vertCount = n * n + (skirt ? 8 * n : 0);
  const STRIDE = CELL_SURFACE_LAYOUT.stride;
  const buf = new ArrayBuffer(vertCount * STRIDE);
  const view = new DataView(buf);
  const normals = new Int16Array(n * n * 3);
  const colors = new Uint8Array(n * n * 4);
  let minY = Infinity;
  let maxY = -Infinity;
  const put = (v: number, x: number, y: number, z: number, k: number, kind: number): void => {
    const off = v * STRIDE;
    view.setFloat32(off, x, true);
    view.setFloat32(off + 4, y, true);
    view.setFloat32(off + 8, z, true);
    view.setInt16(off + 12, normals[k * 3]!, true);
    view.setInt16(off + 14, normals[k * 3 + 1]!, true);
    view.setInt16(off + 16, normals[k * 3 + 2]!, true);
    view.setInt16(off + 18, kind, true);
    for (let c = 0; c < 4; c++) view.setUint8(off + 20 + c, colors[k * 4 + c]!);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const y = H(i, j);
      const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
      const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
      // Square root is exact in IEEE 754; no transcendental function enters the output.
      const l = Math.sqrt(dx * dx + 1 + dz * dz);
      const nx = -dx / l;
      const ny = 1 / l;
      const nz = -dz / l;
      const k = j * n + i;
      normals[k * 3] = Math.round(nx * 32767);
      normals[k * 3 + 1] = Math.round(ny * 32767);
      normals[k * 3 + 2] = Math.round(nz * 32767);
      const c = o.colorAt ? o.colorAt(o.originX + i * step, o.originZ + j * step, y, nx, ny, nz) : [128, 128, 128, 255];
      for (let ch = 0; ch < 4; ch++) colors[k * 4 + ch] = c[ch]!;
      put(k, i * step, y, j * step, k, KIND_TOP);
      const yf = Math.fround(y);
      if (yf < minY) minY = yf;
      if (yf > maxY) maxY = yf;
    }
  }

  const quadCount = q * q + (skirt ? 4 * q : 0);
  const big = vertCount > 65535;
  const idx = big ? new Uint32Array(quadCount * 6) : new Uint16Array(quadCount * 6);
  let w = 0;
  for (let j = 0; j < q; j++) {
    for (let i = 0; i < q; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[w++] = a;
      idx[w++] = c;
      idx[w++] = b;
      idx[w++] = b;
      idx[w++] = c;
      idx[w++] = d;
    }
  }
  if (skirt) {
    // Four sides, each a strip of vertex pairs: the border vertex (same normal and colour) and one below it.
    let v = n * n;
    const side = (at: (k: number) => [number, number], flip: boolean): void => {
      const start = v;
      for (let k = 0; k < n; k++) {
        const [i, j] = at(k);
        const kk = j * n + i;
        const y = H(i, j);
        put(v++, i * step, y, j * step, kk, KIND_SKIRT);
        put(v++, i * step, y - o.skirtDepth, j * step, kk, KIND_SKIRT);
      }
      for (let k = 0; k < q; k++) {
        const t0 = start + k * 2;
        const b0 = t0 + 1;
        const t1 = t0 + 2;
        const b1 = t0 + 3;
        if (flip) {
          idx[w++] = t0;
          idx[w++] = t1;
          idx[w++] = b0;
          idx[w++] = t1;
          idx[w++] = b1;
          idx[w++] = b0;
        } else {
          idx[w++] = t0;
          idx[w++] = b0;
          idx[w++] = t1;
          idx[w++] = t1;
          idx[w++] = b0;
          idx[w++] = b1;
        }
      }
    };
    side((k) => [k, 0], true); // north
    side((k) => [k, q], false); // south
    side((k) => [0, k], false); // west
    side((k) => [q, k], true); // east
    minY -= o.skirtDepth;
  }
  return { mesh: { layout: CELL_SURFACE_LAYOUT, vertices: new Uint8Array(buf), indices: idx, count: w }, minY, maxY };
}
