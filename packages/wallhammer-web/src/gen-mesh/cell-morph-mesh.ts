// Surface mesh of one cell that can blend into the shape of its parent (the cell one level coarser). It is the cell
// surface mesh (same positions, normals, colours and vertex order) with three more attributes per vertex: how far the
// parent's surface lies from this one at the vertex, and the parent's normal and colour there. A vertex shader mixes
// the two by distance, so a cell that has just replaced its parent starts in exactly the parent's shape and grows its
// own detail as the viewer comes closer; nothing jumps when the level of detail changes.
//
// The parent's surface is not sampled again. The parent's vertices are every second vertex of this cell, and heights
// are a pure function of the world point, so the parent's mesh is this cell's own grid thinned by two
// (`HeightField.coarseSurface`). Along a cell border the coarse values depend only on the border's own vertices, so
// neighbouring cells agree there exactly, whatever their parents are.
//
// The skirt is as deep as the cell needs: at least `skirtDepth`, and at least twice the largest step this border can
// show against a neighbour of another level: the distance to the parent's surface, the estimated distance to the
// children's surface, and the distance from the parent's surface to the surface two levels coarser. The last one is
// the step of a cell loaded away from the viewer (around a predicted point): it shows its parent's shape there, beside
// cells of the parent's level that already blend into theirs.

import type { MeshData, VertexLayout } from '../base/data.ts';
import { HeightField } from '../gen-core/height-field.ts';
import type { CellSurfaceOptions } from './cell-surface-mesh.ts';

/** Locations a material should give the attributes. The first three are those of the plain cell surface. */
export const CELL_MORPH_ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2, a_coarseShift: 3, a_coarseNormal: 4, a_coarseColor: 5 } as const;

/**
 * The cell surface layout (position 3× float, normal 3× int16 with the kind 0 surface / 1 skirt, colour 4× u8) and
 * then: `a_coarseShift`, metres along "up" from this vertex to the parent's surface; `a_coarseNormal`, the parent's
 * normal there (3× int16 ×32767, the fourth is 0); `a_coarseColor`, the parent's colour there (4× u8 normalized).
 */
export const CELL_MORPH_LAYOUT: VertexLayout = {
  stride: 40,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i16', offset: 12 },
    { name: 'a_color', size: 4, type: 'u8', normalized: true, offset: 20 },
    { name: 'a_coarseShift', size: 1, type: 'f32', offset: 24 },
    { name: 'a_coarseNormal', size: 4, type: 'i16', offset: 28 },
    { name: 'a_coarseColor', size: 4, type: 'u8', normalized: true, offset: 36 },
  ],
};

/**
 * GLSL for a vertex shader (paste it after the includes; it declares its own uniforms). `cellMorph(p)` is the blend
 * factor at a render-space point: 0 = the cell's own shape, 1 = the parent's shape. The distance is measured as the
 * streaming manager measures it for tickets: along the surface, combined with the viewer's height above it.
 *
 *   vec3 p = a_pos + u_cellOffset;
 *   float m = cellMorph(p);
 *   p += u_morphUp * (a_coarseShift * m);
 *   vec3 n = mix(a_normal.xyz, a_coarseNormal.xyz, m);
 *   vec4 c = mix(a_color, a_coarseColor, m);
 *
 * The streamed world sets `u_morphEye`, `u_morphUp` (per frame) and `u_cellMorph` (per cell) when its `morph` option
 * is on. Without them every factor is 0 and the mesh draws as the plain cell surface.
 */
export const CELL_MORPH_GLSL = /* glsl */ `
uniform vec4 u_morphEye;  // xyz: the viewer in render space, w: its height above the surface
uniform vec3 u_morphUp;   // unit "up" at the viewer
uniform vec2 u_cellMorph; // x: distance where the blend starts, y: 1 / length of the blend (0 = no blend)
float cellMorph(vec3 p) {
  vec3 d = p - u_morphEye.xyz;
  d -= u_morphUp * dot(d, u_morphUp);
  float dist = sqrt(dot(d, d) + u_morphEye.w * u_morphEye.w);
  return clamp((dist - u_cellMorph.x) * u_cellMorph.y, 0.0, 1.0);
}
`;

/**
 * Options of the cell surface. `quads` must be even. `colorAt` must give a vertex the same colour at every level
 * (it may use the position and height, not the normal of this level): the parent's colour at a shared vertex is taken
 * from this cell. `skirtDepth` is the least depth of the skirt (0 = no skirt).
 */
export type CellMorphOptions = CellSurfaceOptions;

export interface CellMorphSurface {
  mesh: MeshData;
  /** Lowest and highest point the mesh can show at any blend factor (the skirt included). */
  minY: number;
  maxY: number;
  /**
   * Estimated largest distance in metres between this surface and the one its children would show: from the second
   * differences of the height grid. Use it as `CellContent.error`.
   */
  error: number;
  /** Depth the skirt was given. */
  skirtDepth: number;
}

const KIND_TOP = 0;
const KIND_SKIRT = 1;
const MARGIN = 2;

export function cellMorphMesh(o: CellMorphOptions): CellMorphSurface {
  const q = o.quads;
  if (q < 2 || q % 2 !== 0) throw new Error(`cellMorphMesh: quads must be even, got ${q}`);
  const n = q + 1;
  const step = o.size / q;
  // Heights with two samples of margin on each side: the parent's normals are central differences over twice the step.
  const m = n + 2 * MARGIN;
  const h = new Float64Array(m * m);
  for (let j = 0; j < m; j++) {
    const z = o.originZ + (j - MARGIN) * step;
    for (let i = 0; i < m; i++) h[j * m + i] = o.heightAt(o.originX + (i - MARGIN) * step, z);
  }
  const H = (i: number, j: number): number => h[(j + MARGIN) * m + (i + MARGIN)]!;

  // Own surface: heights, normals and colours exactly as the plain cell surface computes them.
  const own = new Float64Array(n * n);
  const normals = new Int16Array(n * n * 3);
  const colors = new Uint8Array(n * n * 4);
  // The parent's normal at its own vertices (every second vertex of this cell); the rest is filled by thinning.
  const cnx = new Float64Array(n * n);
  const cny = new Float64Array(n * n);
  const cnz = new Float64Array(n * n);
  let error = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const y = H(i, j);
      own[k] = y;
      const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
      const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
      // Square root is exact in IEEE 754; no transcendental function enters the output.
      const l = Math.sqrt(dx * dx + 1 + dz * dz);
      const nx = -dx / l;
      const ny = 1 / l;
      const nz = -dz / l;
      normals[k * 3] = Math.round(nx * 32767);
      normals[k * 3 + 1] = Math.round(ny * 32767);
      normals[k * 3 + 2] = Math.round(nz * 32767);
      const c = o.colorAt ? o.colorAt(o.originX + i * step, o.originZ + j * step, y, nx, ny, nz) : [128, 128, 128, 255];
      for (let ch = 0; ch < 4; ch++) colors[k * 4 + ch] = c[ch]!;
      if (i % 2 === 0 && j % 2 === 0) {
        const pdx = (H(i + 2, j) - H(i - 2, j)) / (4 * step);
        const pdz = (H(i, j + 2) - H(i, j - 2)) / (4 * step);
        const pl = Math.sqrt(pdx * pdx + 1 + pdz * pdz);
        cnx[k] = -pdx / pl;
        cny[k] = 1 / pl;
        cnz[k] = -pdz / pl;
      }
      // A straight edge between two vertices misses the middle of a curve by an eighth of the second difference.
      const bend = Math.max(Math.abs(H(i - 1, j) - 2 * y + H(i + 1, j)), Math.abs(H(i, j - 1) - 2 * y + H(i, j + 1))) / 8;
      if (bend > error) error = bend;
    }
  }
  // The middle of a quad lies on its diagonal; a twisted quad misses the mean of its four corners by a quarter of the twist.
  for (let j = 0; j < q; j++) {
    for (let i = 0; i < q; i++) {
      const twist = Math.abs(H(i, j) + H(i + 1, j + 1) - H(i + 1, j) - H(i, j + 1)) / 4;
      if (twist > error) error = twist;
    }
  }

  const coarseY = HeightField.coarseSurface(n, n, own, 2);
  const coarseNx = HeightField.coarseSurface(n, n, cnx, 2);
  const coarseNy = HeightField.coarseSurface(n, n, cny, 2);
  const coarseNz = HeightField.coarseSurface(n, n, cnz, 2);
  const channel = new Float64Array(n * n);
  const coarseColors = new Uint8Array(n * n * 4);
  for (let ch = 0; ch < 4; ch++) {
    for (let k = 0; k < n * n; k++) channel[k] = colors[k * 4 + ch]!;
    const thin = HeightField.coarseSurface(n, n, channel, 2);
    for (let k = 0; k < n * n; k++) coarseColors[k * 4 + ch] = Math.round(thin[k]!);
  }

  // Skirt depth: the largest step this border can show against another level, doubled, and never under the least depth.
  // The surface two levels coarser is this grid thinned by four (the cell's origin lies on that grid too); a cell whose
  // quads are not a multiple of four goes without that term.
  const coarserY = q % 4 === 0 ? HeightField.coarseSurface(n, n, own, 4) : null;
  let borderGap = 0;
  const gapAt = (i: number, j: number, along: number): void => {
    const k = j * n + i;
    const g = Math.max(Math.abs(coarseY[k]! - own[k]!), along / 8, coarserY ? Math.abs(coarserY[k]! - coarseY[k]!) : 0);
    if (g > borderGap) borderGap = g;
  };
  for (let k = 0; k < n; k++) {
    const bendI = (j: number): number => Math.abs(H(k - 1, j) - 2 * H(k, j) + H(k + 1, j));
    const bendJ = (i: number): number => Math.abs(H(i, k - 1) - 2 * H(i, k) + H(i, k + 1));
    gapAt(k, 0, bendI(0));
    gapAt(k, q, bendI(q));
    gapAt(0, k, bendJ(0));
    gapAt(q, k, bendJ(q));
  }
  const skirt = o.skirtDepth > 0;
  const skirtDepth = skirt ? Math.max(o.skirtDepth, 2 * borderGap) : 0;

  const vertCount = n * n + (skirt ? 8 * n : 0);
  const STRIDE = CELL_MORPH_LAYOUT.stride;
  const buf = new ArrayBuffer(vertCount * STRIDE);
  const view = new DataView(buf);
  let minY = Infinity;
  let maxY = -Infinity;
  const put = (v: number, i: number, j: number, drop: number, kind: number): void => {
    const k = j * n + i;
    const off = v * STRIDE;
    const y = own[k]! - drop;
    const shift = coarseY[k]! - own[k]!;
    view.setFloat32(off, i * step, true);
    view.setFloat32(off + 4, y, true);
    view.setFloat32(off + 8, j * step, true);
    view.setInt16(off + 12, normals[k * 3]!, true);
    view.setInt16(off + 14, normals[k * 3 + 1]!, true);
    view.setInt16(off + 16, normals[k * 3 + 2]!, true);
    view.setInt16(off + 18, kind, true);
    for (let c = 0; c < 4; c++) view.setUint8(off + 20 + c, colors[k * 4 + c]!);
    view.setFloat32(off + 24, shift, true);
    const cl = Math.sqrt(coarseNx[k]! * coarseNx[k]! + coarseNy[k]! * coarseNy[k]! + coarseNz[k]! * coarseNz[k]!);
    view.setInt16(off + 28, Math.round((coarseNx[k]! / cl) * 32767), true);
    view.setInt16(off + 30, Math.round((coarseNy[k]! / cl) * 32767), true);
    view.setInt16(off + 32, Math.round((coarseNz[k]! / cl) * 32767), true);
    view.setInt16(off + 34, 0, true);
    for (let c = 0; c < 4; c++) view.setUint8(off + 36 + c, coarseColors[k * 4 + c]!);
    const lo = Math.fround(Math.min(y, y + shift));
    const hi = Math.fround(Math.max(y, y + shift));
    if (lo < minY) minY = lo;
    if (hi > maxY) maxY = hi;
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(j * n + i, i, j, 0, KIND_TOP);

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
    // Four sides, each a strip of vertex pairs: the border vertex and one below it. Both carry the border vertex's
    // blend attributes, so the skirt follows the border at every blend factor.
    let v = n * n;
    const side = (at: (k: number) => [number, number], flip: boolean): void => {
      const start = v;
      for (let k = 0; k < n; k++) {
        const [i, j] = at(k);
        put(v++, i, j, 0, KIND_SKIRT);
        put(v++, i, j, skirtDepth, KIND_SKIRT);
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
  }
  return { mesh: { layout: CELL_MORPH_LAYOUT, vertices: new Uint8Array(buf), indices: idx, count: w }, minY, maxY, error, skirtDepth };
}
