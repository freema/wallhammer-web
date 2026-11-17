// Horizontal markings on the ground: crossings, later lane lines and parking spaces.
// The app passes shapes (a rectangle along an axis with a pattern and colour) and the core builds a mesh from them that follows
// the terrain cells. It is drawn with the same shader as the ground, so markings get the same light, shadow, snow,
// wetness and fog. Edges and stripes are smoothed by the pixel footprint: sharp up close, blending into the average from afar.

import type { MeshData, RGB, VertexLayout } from '../base/index.ts';
import type { HeightField } from '../gen-core/index.ts';

export const MARKING_ATTRIBS = { a_pos: 0, a_normal: 1, a_uv: 2, a_size: 3, a_paint: 4, a_pattern: 5 } as const;

/** Vertex layout of the marking mesh. */
export const MARKING_LAYOUT: VertexLayout = {
  stride: 68,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i16', offset: 12 },
    { name: 'a_uv', size: 2, type: 'f32', offset: 20 },
    { name: 'a_size', size: 4, type: 'f32', offset: 28 },
    { name: 'a_paint', size: 4, type: 'f32', offset: 44 },
    { name: 'a_pattern', size: 2, type: 'f32', offset: 60 },
  ],
};

/**
 * Pattern inside the rectangle.
 * - solid: full area (arrow, parking space area).
 * - stripes: stripes across the axis, repeated along it with period `periodM`; the colour takes `duty` of the period from its
 *   start. A zebra crossing is an axis across the road and 0.5/0.5 m stripes, a dashed line is an axis along the road and a long period.
 * - outline: only an outline with line width `lineM` (parking space).
 */
export type MarkingPattern = { kind: 'solid' } | { kind: 'stripes'; periodM: number; duty: number } | { kind: 'outline'; lineM: number };

/** One marking shape: a rectangle from point a to point b (local metres [x, z]) with a cross width. */
export interface GroundMarking {
  a: readonly [number, number];
  b: readonly [number, number];
  width: number;
  pattern: MarkingPattern;
  /** Paint colour, 0–1 in display space. */
  color: RGB;
  /** Wear 0–1: how much paint is worn off. */
  wear?: number;
}

const STRIDE = 68;
const PATTERN_CODE = { solid: 0, stripes: 1, outline: 2 } as const;

/**
 * Builds the marking mesh above the terrain. Each shape gets the terrain cells that cover it, with the same vertices
 * and normals as the terrain mesh (hence no offset above the surface). `albedoScale` as for the ground colour.
 * Returns null when there is nothing to draw.
 */
export function buildGroundMarkings(terrain: HeightField, marks: readonly GroundMarking[], albedoScale = 1): MeshData | null {
  const { step, cols, rows, heights } = terrain;
  const cells: { i: number; j: number; m: number }[] = [];
  marks.forEach((mk, m) => {
    const dx = mk.b[0] - mk.a[0];
    const dz = mk.b[1] - mk.a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3 || mk.width <= 0) return;
    const ux = dx / len;
    const uz = dz / len;
    const hw = mk.width / 2;
    const corners = [
      [mk.a[0] - uz * hw, mk.a[1] + ux * hw],
      [mk.a[0] + uz * hw, mk.a[1] - ux * hw],
      [mk.b[0] - uz * hw, mk.b[1] + ux * hw],
      [mk.b[0] + uz * hw, mk.b[1] - ux * hw],
    ];
    const i0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]!)) / step));
    const i1 = Math.min(cols - 2, Math.floor(Math.max(...corners.map((c) => c[0]!)) / step));
    const j0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]!)) / step));
    const j1 = Math.min(rows - 2, Math.floor(Math.max(...corners.map((c) => c[1]!)) / step));
    const reach = step * Math.SQRT1_2;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        // A cell whose centre is farther from the rectangle than half a diagonal cannot touch it.
        const cx = (i + 0.5) * step - mk.a[0];
        const cz = (j + 0.5) * step - mk.a[1];
        const u = cx * ux + cz * uz;
        const v = -cx * uz + cz * ux;
        if (u < -reach || u > len + reach || Math.abs(v) > hw + reach) continue;
        cells.push({ i, j, m });
      }
    }
  });
  if (cells.length === 0) return null;

  const buf = new ArrayBuffer(cells.length * 6 * STRIDE);
  const view = new DataView(buf);
  let o = 0;
  const normals = new Map<number, [number, number, number]>();
  const normalAt = (i: number, j: number): [number, number, number] => {
    const k = j * cols + i;
    let n = normals.get(k);
    if (!n) {
      n = terrain.vertexNormal(i, j);
      normals.set(k, n);
    }
    return n;
  };
  for (const { i, j, m } of cells) {
    const mk = marks[m]!;
    const len = Math.hypot(mk.b[0] - mk.a[0], mk.b[1] - mk.a[1]);
    const ux = (mk.b[0] - mk.a[0]) / len;
    const uz = (mk.b[1] - mk.a[1]) / len;
    const col = mk.color;
    const p = mk.pattern;
    const period = p.kind === 'stripes' ? p.periodM : 1;
    const duty = p.kind === 'stripes' ? p.duty : 1;
    const line = p.kind === 'outline' ? p.lineM : 0;
    // The same diagonal split of a cell as in the terrain mesh: (a, c, b) and (b, c, d).
    const corner = [
      [i, j],
      [i, j + 1],
      [i + 1, j],
      [i + 1, j],
      [i, j + 1],
      [i + 1, j + 1],
    ] as const;
    for (const [ci, cj] of corner) {
      const x = ci * step;
      const z = cj * step;
      const n = normalAt(ci, cj);
      view.setFloat32(o, x, true);
      view.setFloat32(o + 4, heights[cj * cols + ci]!, true);
      view.setFloat32(o + 8, z, true);
      view.setInt16(o + 12, Math.round(n[0] * 32767), true);
      view.setInt16(o + 14, Math.round(n[1] * 32767), true);
      view.setInt16(o + 16, Math.round(n[2] * 32767), true);
      view.setInt16(o + 18, 0, true);
      const rx = x - mk.a[0];
      const rz = z - mk.a[1];
      view.setFloat32(o + 20, rx * ux + rz * uz, true);
      view.setFloat32(o + 24, -rx * uz + rz * ux, true);
      view.setFloat32(o + 28, len, true);
      view.setFloat32(o + 32, mk.width, true);
      view.setFloat32(o + 36, period, true);
      view.setFloat32(o + 40, duty, true);
      view.setFloat32(o + 44, col[0] * albedoScale, true);
      view.setFloat32(o + 48, col[1] * albedoScale, true);
      view.setFloat32(o + 52, col[2] * albedoScale, true);
      view.setFloat32(o + 56, mk.wear ?? 0, true);
      view.setFloat32(o + 60, PATTERN_CODE[p.kind], true);
      view.setFloat32(o + 64, line, true);
      o += STRIDE;
    }
  }

  return { layout: MARKING_LAYOUT, vertices: new Uint8Array(buf), indices: null, count: cells.length * 6 };
}
