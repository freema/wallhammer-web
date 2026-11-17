// Packed positions: a mesh whose positions are 16-bit steps from the origin of the cell it belongs to, and the
// material rewrite that reads them. A cell of a streamed world is small against the world, so 16 bits per axis give
// centimetres where a float position spends 32 bits on the distance from the world origin. A mesh without indices
// also gets an index: equal vertices are stored once.
//
// The horizontal step halves with every quadtree level (`PACK_STEPS_PER_EDGE` steps per cell edge, so a position may
// reach two edges past the cell on either side); the vertical step and the height origin are the same on every
// level. The vertex shader gets them as `u_pack` (see `packUniform`) and takes the level and the cell origin from
// what the streamed world sets per cell (`u_cellLevel`, `u_cellOffset`).

import type { MeshData, VertexAttrib, VertexLayout } from '../base/data.ts';
import type { MaterialDesc, PassName, ShaderSource, UniformValue } from '../base/material.ts';

/** Name of the packed position attribute: four int16, x y z in steps and one spare. */
export const PACKED_POSITION = 'a_packed';

/** Horizontal position steps per cell edge. */
export const PACK_STEPS_PER_EDGE = 16384;

const POSITION = 'a_pos';
const I16_MIN = -32768;
const I16_MAX = 32767;

/** How positions turn into steps. */
export interface PackFrame {
  /** Metres per step on x and z (for a cell: its edge / `PACK_STEPS_PER_EDGE`). */
  stepXZ: number;
  /** Metres per step on y. */
  stepY: number;
  /** Subtracted from a position before it is divided into steps: the cell origin on x and z, the height origin on y. */
  origin: readonly [number, number, number];
}

/** The frame of a cell: `edgeM` is its edge, `origin` its corner, `heightOrigin` and `stepY` are the world's. */
export function packFrame(edgeM: number, origin: readonly [number, number, number], heightOrigin: number, stepY: number): PackFrame {
  return { stepXZ: edgeM / PACK_STEPS_PER_EDGE, stepY, origin: [origin[0], origin[1] + heightOrigin, origin[2]] };
}

/**
 * Value of the uniform `u_pack` for materials made by `packedMaterial`: `rootEdgeM` is the edge of a level 0 cell,
 * `stepY` and `heightOrigin` as given to `packFrame`.
 */
export function packUniform(rootEdgeM: number, stepY: number, heightOrigin: number): UniformValue {
  return { vec4: [rootEdgeM / PACK_STEPS_PER_EDGE, stepY, heightOrigin, 0] };
}

export interface PackOptions {
  /**
   * Vertex ranges that are indexed on their own, as ascending boundaries (first vertex of each range, then the vertex
   * count): equal vertices are merged only inside a range, so each range stays one run of vertices that can be
   * rewritten alone. Without it the whole mesh is one range.
   */
  spans?: ArrayLike<number>;
}

export interface PackedMesh {
  mesh: MeshData;
  /** The boundaries of `PackOptions.spans` in the packed vertices (`[0, vertex count]` without spans). */
  spans: Uint32Array;
  /** Positions that lay outside the 16-bit range and were moved to its border. */
  clamped: number;
}

/** The layout `packMesh` gives a mesh of `layout`: the float position becomes `PACKED_POSITION`, the rest moves up. */
export function packedLayout(layout: VertexLayout): VertexLayout {
  const pos = positionOf(layout);
  const attribs = layout.attribs.map((a): VertexAttrib => {
    if (a === pos) return { name: PACKED_POSITION, size: 4, type: 'i16', offset: a.offset };
    return a.offset > pos.offset ? { ...a, offset: a.offset - 4 } : a;
  });
  return { stride: layout.stride - 4, attribs };
}

function positionOf(layout: VertexLayout): VertexAttrib {
  const pos = layout.attribs.find((a) => a.name === POSITION);
  if (!pos || pos.type !== 'f32' || pos.size !== 3) throw new Error(`packMesh: the layout needs "${POSITION}" as three floats`);
  return pos;
}

/**
 * Packs a mesh: positions as 16-bit steps of `frame`, every other attribute byte for byte. A mesh without indices is
 * indexed (equal packed vertices once, in the order of their first use); a mesh with indices keeps its vertices and
 * their order. Indices are 16-bit when the vertices allow it. The result depends only on the input bytes and the
 * frame, so one range packed alone gives the bytes it has inside the whole mesh.
 */
export function packMesh(mesh: MeshData, frame: PackFrame, options: PackOptions = {}): PackedMesh {
  const layout = mesh.layout;
  const pos = positionOf(layout);
  const inStride = layout.stride;
  const outStride = inStride - 4;
  const src = new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  const inCount = Math.floor(src.length / inStride);
  const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const out = new Uint8Array(inCount * outStride);
  const outView = new DataView(out.buffer);
  const head = pos.offset;
  const tail = inStride - head - 12;
  let clamped = 0;
  const q = (v: number, origin: number, step: number): number => {
    const s = Math.round((v - origin) / step);
    if (s < I16_MIN || s > I16_MAX) {
      clamped++;
      return s < I16_MIN ? I16_MIN : I16_MAX;
    }
    return s;
  };
  /** Writes input vertex `v` packed as output vertex `at`. */
  const write = (v: number, at: number): void => {
    const i = v * inStride;
    const o = at * outStride;
    if (head > 0) out.set(src.subarray(i, i + head), o);
    outView.setInt16(o + head, q(srcView.getFloat32(i + head, true), frame.origin[0], frame.stepXZ), true);
    outView.setInt16(o + head + 2, q(srcView.getFloat32(i + head + 4, true), frame.origin[1], frame.stepY), true);
    outView.setInt16(o + head + 4, q(srcView.getFloat32(i + head + 8, true), frame.origin[2], frame.stepXZ), true);
    outView.setInt16(o + head + 6, 0, true);
    if (tail > 0) out.set(src.subarray(i + head + 12, i + inStride), o + head + 8);
  };
  const bounds = options.spans ? Array.from(options.spans as ArrayLike<number>) : [0, inCount];
  const outSpans = new Uint32Array(bounds.length);
  const packedLayoutOut = packedLayout(layout);

  if (mesh.indices) {
    for (let v = 0; v < inCount; v++) write(v, v);
    outSpans.set(bounds);
    const indices = inCount <= 65536 && !(mesh.indices instanceof Uint16Array) ? Uint16Array.from(mesh.indices) : mesh.indices;
    return { mesh: { layout: packedLayoutOut, vertices: out, indices, count: mesh.count, ...(mesh.primitive ? { primitive: mesh.primitive } : {}) }, spans: outSpans, clamped };
  }

  // Without indices: every vertex is packed at the end of the output, then looked up among the vertices its range
  // already has (an open hash table over the packed bytes); a new one stays, a known one is dropped again.
  const index = new Uint32Array(inCount);
  let size = 16;
  while (size < inCount * 2) size *= 2;
  const table = new Int32Array(size).fill(-1);
  const mask = size - 1;
  let outCount = 0;
  let spanStart = 0;
  const same = (a: number, b: number): boolean => {
    const oa = a * outStride;
    const ob = b * outStride;
    for (let k = 0; k < outStride; k++) if (out[oa + k] !== out[ob + k]) return false;
    return true;
  };
  for (let s = 0; s + 1 < bounds.length; s++) {
    outSpans[s] = outCount;
    spanStart = outCount;
    const end = Math.min(inCount, bounds[s + 1]!);
    for (let v = Math.max(0, bounds[s]!); v < end; v++) {
      write(v, outCount);
      // FNV-1a over the packed vertex.
      let h = 2166136261;
      const o = outCount * outStride;
      for (let k = 0; k < outStride; k++) h = Math.imul(h ^ out[o + k]!, 16777619);
      let slot = (h >>> 0) & mask;
      let found = -1;
      for (;;) {
        const t = table[slot]!;
        if (t < 0) break;
        // Entries of earlier ranges stay in the table and are passed over.
        if (t >= spanStart && same(t, outCount)) {
          found = t;
          break;
        }
        slot = (slot + 1) & mask;
      }
      if (found < 0) {
        table[slot] = outCount;
        found = outCount++;
      }
      index[v] = found;
    }
  }
  outSpans[bounds.length - 1] = outCount;
  const vertices = out.slice(0, outCount * outStride);
  // The index covers the vertices inside the spans, in order; a mesh without spans is all of it.
  const first = Math.max(0, bounds[0]!);
  const last = Math.min(inCount, bounds[bounds.length - 1]!);
  const used = index.subarray(first, last);
  const indices = outCount <= 65536 ? Uint16Array.from(used) : Uint32Array.from(used);
  return { mesh: { layout: packedLayoutOut, vertices, indices, count: indices.length, ...(mesh.primitive ? { primitive: mesh.primitive } : {}) }, spans: outSpans, clamped };
}

const POSITION_INPUT = `in vec3 ${POSITION};\n`;
const OFFSET_UNIFORM = 'uniform vec3 u_cellOffset;';
const LEVEL_UNIFORM = 'uniform float u_cellLevel;';

/** The vertex shader of one pass, reading the position from the packed attribute. */
function packedVs(vs: string, label: string): string {
  if (!vs.includes(POSITION_INPUT)) throw new Error(`packedMaterial: ${label} has no line "${POSITION_INPUT.trim()}"`);
  // A shader that adds the cell offset itself keeps doing so; any other gets it added here.
  const own = vs.includes(OFFSET_UNIFORM);
  const lines = [
    `in vec4 ${PACKED_POSITION};`,
    'uniform vec4 u_pack;',
    ...(own ? [] : [OFFSET_UNIFORM]),
    ...(vs.includes(LEVEL_UNIFORM) ? [] : [LEVEL_UNIFORM]),
    'vec3 whUnpackPosition() {',
    '  // A power of two: the division is exact.',
    '  float s = u_pack.x / float(1 << int(u_cellLevel));',
    `  vec3 p = vec3(${PACKED_POSITION}.x * s, ${PACKED_POSITION}.y * u_pack.y + u_pack.z, ${PACKED_POSITION}.z * s);`,
    own ? '  return p;' : '  return p + u_cellOffset;',
    '}',
    `#define ${POSITION} whUnpackPosition()`,
    '',
  ];
  return vs.replace(POSITION_INPUT, lines.join('\n'));
}

const PLAIN_DEPTH_VS = `#include <header>
uniform mat4 u_lightRender;
in vec3 ${POSITION};
void main() {
  gl_Position = u_lightRender * vec4(${POSITION}, 1.0);
}`;
const PLAIN_DEPTH_FS = `#version 300 es
precision highp float;
void main() {}`;

/**
 * The material for meshes made by `packMesh`: every vertex shader reads `PACKED_POSITION` where it read `a_pos`
 * (a line `in vec3 a_pos;` of its own is required), a `'depth'` pass becomes a depth program that does the same.
 * Uniforms: `u_pack` (`packUniform`), and per cell `u_cellLevel` and `u_cellOffset` as the streamed world sets them.
 * A shader that declares `u_cellOffset` itself is taken to add it itself: its `a_pos` stays relative to the cell.
 */
export function packedMaterial(desc: MaterialDesc): MaterialDesc {
  const passes: Partial<Record<PassName, ShaderSource | 'depth'>> = {};
  for (const name of Object.keys(desc.passes) as PassName[]) {
    const p = desc.passes[name]!;
    if (p === 'depth') passes[name] = { vs: packedVs(PLAIN_DEPTH_VS, `${desc.name} (${name})`), fs: PLAIN_DEPTH_FS };
    else passes[name] = { vs: packedVs(p.vs, `${desc.name} (${name})`), fs: p.fs };
  }
  const attribs: Record<string, number> = {};
  for (const [name, loc] of Object.entries(desc.attribs)) attribs[name === POSITION ? PACKED_POSITION : name] = loc;
  return { ...desc, name: `${desc.name}+packed`, attribs, passes };
}
