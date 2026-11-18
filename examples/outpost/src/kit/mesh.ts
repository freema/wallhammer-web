// The one vertex format of the outpost, on the engine's `MeshBuilder` (gen-mesh): the engine keeps positions, normals,
// triangles and the transform stack; the outpost adds its style per vertex (colour, tone, panel coordinate, outline)
// and computes the outline direction when the bytes are written. Every opaque thing is drawn twice from the same
// vertices: with the toon material (flat colour, light steps, panel lines) and as an outline hull (the vertices pushed
// out along a_hull and drawn with front faces culled, render/scene.ts).
//
// Vertex record (52 bytes):
//   a_pos    3 × f32  position
//   a_normal 3 × f32  shading normal (smooth on curved shells, per face on hard edges)
//   a_hull   3 × f32  outline direction: the welded normal of all faces that meet at this position, scaled so the
//                     hull stands off every face by the same width; zero on vertices drawn without an outline (the
//                     outline pass collapses their triangles)
//   a_line   3 × f32  panel coordinates: the toon shader draws a dark line wherever a component crosses an integer
//                     (a face with u, v from 0 to 1 gets a frame on its four edges; 0.5 everywhere = no line)
//   a_color  4 × u8   flat palette colour (display values); alpha carries the tone

import type { VertexLayout } from 'wallhammer-web/base';
import { MeshBuilder as EngineMeshBuilder } from 'wallhammer-web/gen-mesh';
import type { VertexFormat } from 'wallhammer-web/gen-mesh';
import type { RGB } from '../style/palette.ts';
import type { V3 } from './math.ts';

export const VERTEX_STRIDE = 52;

export const VERTEX_LAYOUT: VertexLayout = {
  stride: VERTEX_STRIDE,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
    { name: 'a_hull', size: 3, type: 'f32', offset: 24 },
    { name: 'a_line', size: 3, type: 'f32', offset: 36 },
    { name: 'a_color', size: 4, type: 'u8', offset: 48, normalized: true },
  ],
};

/** Panel coordinates that draw no line. */
export const NO_LINE: V3 = [0.5, 0.5, 0.5];

/** The style of one vertex. */
export interface Ink {
  /** Colour and tone as bytes. */
  rgba: readonly [number, number, number, number];
  line: V3;
  /** Its triangles take part in the outline hull. */
  outline: boolean;
}

/**
 * The engine's builder in the outpost format. State for the following vertices: `color` (palette RGB), `tone`,
 * `outline`; `ink(p, n, line)` adds a vertex with it, `style(line)` gives the payload for the engine's shapes.
 */
export class MeshBuilder extends EngineMeshBuilder<Ink> {
  /** Current colour of new vertices. */
  color: RGB = [1, 0, 1];
  /** Whether new vertices (and so their triangles) get an outline hull. */
  outline = true;
  /**
   * Tone of new vertices, 0–1, interpolated across triangles (the colour is flat). The toon pass cuts it at two
   * levels into hard-edged darker and lighter areas (STYLE.toneDark / toneLight): smooth contours of flat patches on a
   * coarse mesh. 0.5 = the plain colour.
   */
  tone = 0.5;
  /** Outline directions of the last `vertices()`, three per vertex. */
  private hull: Float32Array = new Float32Array(0);

  constructor() {
    let self: MeshBuilder | null = null;
    const format: VertexFormat<Ink> = {
      layout: VERTEX_LAYOUT,
      stride: VERTEX_STRIDE,
      write(view, o, p, n, v, index) {
        const h = self!.hull;
        for (let k = 0; k < 3; k++) {
          view.setFloat32(o + k * 4, p[k]!, true);
          view.setFloat32(o + 12 + k * 4, n[k]!, true);
          view.setFloat32(o + 24 + k * 4, v.outline ? h[index * 3 + k]! : 0, true);
          view.setFloat32(o + 36 + k * 4, v.line[k]!, true);
        }
        for (let k = 0; k < 4; k++) view.setUint8(o + 48 + k, v.rgba[k]!);
      },
    };
    super(format);
    self = this;
  }

  /** Paints the following vertices (and returns this for chaining). */
  paint(c: RGB): this {
    this.color = c;
    return this;
  }

  /** The payload of a new vertex with panel coordinates `line` and the current colour, tone and outline. */
  style(line: V3 = NO_LINE): Ink {
    const c = this.color;
    return { rgba: [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), Math.round(Math.min(1, Math.max(0, this.tone)) * 255)], line, outline: this.outline };
  }

  /** Adds a vertex in local coordinates with the current style; returns its index. */
  ink(p: V3, n: V3, line: V3 = NO_LINE): number {
    return this.vertex(p, n, this.style(line));
  }

  /** The interleaved vertex bytes, with the outline directions welded by position. */
  override vertices(): Uint8Array {
    this.hull = weldedHull(this);
    return super.vertices();
  }
}

/**
 * Outline directions: vertices at the same place (1 mm) share one direction, the normalised sum of the distinct face
 * normals there, lengthened so that the hull stands off each of those faces by one unit (at most 2.5 units, for sharp
 * corners). Shells with smooth normals get their normal back; a box corner gets the diagonal. Meshes without an
 * outlined vertex skip it.
 */
function weldedHull(b: MeshBuilder): Float32Array {
  const n = b.vertexCount;
  const out = new Float32Array(n * 3);
  let any = false;
  for (let i = 0; i < n && !any; i++) any = b.payload(i).outline;
  if (!any) return out;
  const P = b.positions(), N = b.normals();
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(P[i * 3]! * 1000)},${Math.round(P[i * 3 + 1]! * 1000)},${Math.round(P[i * 3 + 2]! * 1000)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  }
  for (const g of groups.values()) {
    const seen = new Set<string>();
    const normals: V3[] = [];
    let sx = 0, sy = 0, sz = 0;
    for (const i of g) {
      const nx = N[i * 3]!, ny = N[i * 3 + 1]!, nz = N[i * 3 + 2]!;
      const k = `${Math.round(nx * 100)},${Math.round(ny * 100)},${Math.round(nz * 100)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      normals.push([nx, ny, nz]);
      sx += nx;
      sy += ny;
      sz += nz;
    }
    let l = Math.hypot(sx, sy, sz);
    if (l < 1e-6) {
      // Opposite faces meet (a thin sheet): fall back on the first normal.
      [sx, sy, sz] = normals[0] ?? [0, 1, 0];
      l = 1;
    }
    sx /= l;
    sy /= l;
    sz /= l;
    let minDot = 1;
    for (const q of normals) minDot = Math.min(minDot, sx * q[0] + sy * q[1] + sz * q[2]);
    const s = Math.min(2.5, 1 / Math.max(0.4, minDot));
    for (const i of g) {
      out[i * 3] = sx * s;
      out[i * 3 + 1] = sy * s;
      out[i * 3 + 2] = sz * s;
    }
  }
  return out;
}
