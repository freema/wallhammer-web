// Cutting meshes into spatial chunks: every triangle goes to the cell of its centroid, the triangles of one cell from
// all meshes are merged into one mesh with its own box. A static scene built as many separate meshes then becomes
// one draw per visible cell (`PieceLayer`), culled per box against the view and the light.
//
// Any interleaved vertex layout works, as long as all meshes share it and positions are three floats; whole vertex
// records are copied byte for byte. A vertex used by triangles in two cells is copied into both.

import type { MeshData } from '../base/data.ts';

/** One chunk: the merged triangles of one cell and the box that holds them. */
export interface MeshChunk {
  /** The cell key (`ChunkOptions.cellKey`). */
  key: string;
  min: [number, number, number];
  max: [number, number, number];
  data: MeshData;
  triangles: number;
}

export interface ChunkOptions {
  /** Edge of the square cells on x and z, metres. Default 64. Ignored when `cellKey` is given. */
  cellM?: number;
  /** Cell of a triangle centroid, as a key; cells may differ in size (for example finer near the middle). */
  cellKey?: (x: number, y: number, z: number) => string;
  /** Name of the position attribute (three `f32`). Default `'a_pos'`. */
  position?: string;
  /** Margin added to every side of a chunk box, metres (for vertex motion in the shader, normal offsets). Default 0. */
  padM?: number;
}

/** A byte buffer that grows by doubling. */
class Bytes {
  buf = new Uint8Array(1024);
  length = 0;
  push(src: Uint8Array, at: number, n: number): void {
    if (this.length + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.length + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    this.buf.set(src.subarray(at, at + n), this.length);
    this.length += n;
  }
}

interface Acc {
  bytes: Bytes;
  idx: number[];
  vertices: number;
  min: [number, number, number];
  max: [number, number, number];
  /** Source vertex → chunk vertex, for the current source mesh only. */
  remap: Map<number, number>;
  source: MeshData | null;
}

/**
 * Cuts meshes into chunks by triangle centroid and merges each cell. All meshes must share one vertex layout (same
 * stride and attributes) and be triangle lists. Chunks come in the order their cells were first met.
 */
export function chunkMeshes(meshes: readonly MeshData[], o: ChunkOptions = {}): MeshChunk[] {
  const cellM = o.cellM ?? 64;
  const keyOf = o.cellKey ?? ((x: number, _y: number, z: number): string => `${Math.floor(x / cellM)},${Math.floor(z / cellM)}`);
  const posName = o.position ?? 'a_pos';
  const pad = o.padM ?? 0;
  const first = meshes.find((m) => m.count > 0);
  if (!first) return [];
  const layout = first.layout;
  const stride = layout.stride;
  const pos = layout.attribs.find((a) => a.name === posName);
  if (!pos || pos.type !== 'f32' || pos.size < 3) throw new Error(`chunkMeshes: position attribute ${posName} must be three f32`);
  const acc = new Map<string, Acc>();
  for (const m of meshes) {
    if (m.count === 0) continue;
    if (m.layout.stride !== stride || !sameAttribs(m, first)) throw new Error('chunkMeshes: all meshes must share one vertex layout');
    if ((m.primitive ?? 'triangles') !== 'triangles') throw new Error('chunkMeshes: only triangle lists can be chunked');
    const bytes = new Uint8Array(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
    const view = new DataView(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
    const px = (v: number, k: number): number => view.getFloat32(v * stride + pos.offset + k * 4, true);
    const ind = m.indices;
    const at = (t: number): number => (ind ? ind[t]! : t);
    for (let t = 0; t + 2 < m.count; t += 3) {
      const a = at(t), b = at(t + 1), c = at(t + 2);
      const cx = (px(a, 0) + px(b, 0) + px(c, 0)) / 3;
      const cy = (px(a, 1) + px(b, 1) + px(c, 1)) / 3;
      const cz = (px(a, 2) + px(b, 2) + px(c, 2)) / 3;
      const key = keyOf(cx, cy, cz);
      let ch = acc.get(key);
      if (!ch) {
        ch = { bytes: new Bytes(), idx: [], vertices: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], remap: new Map(), source: null };
        acc.set(key, ch);
      }
      if (ch.source !== m) {
        ch.source = m;
        ch.remap = new Map();
      }
      for (const v of [a, b, c]) {
        let i = ch.remap.get(v);
        if (i === undefined) {
          i = ch.vertices++;
          ch.remap.set(v, i);
          ch.bytes.push(bytes, v * stride, stride);
          for (let k = 0; k < 3; k++) {
            const p = px(v, k);
            if (p < ch.min[k]!) ch.min[k] = p;
            if (p > ch.max[k]!) ch.max[k] = p;
          }
        }
        ch.idx.push(i);
      }
    }
  }
  const out: MeshChunk[] = [];
  for (const [key, ch] of acc) {
    const vertices = ch.bytes.buf.slice(0, ch.bytes.length);
    const indices = ch.vertices <= 65536 ? new Uint16Array(ch.idx) : new Uint32Array(ch.idx);
    for (let k = 0; k < 3; k++) {
      ch.min[k] = ch.min[k]! - pad;
      ch.max[k] = ch.max[k]! + pad;
    }
    out.push({ key, min: ch.min, max: ch.max, data: { layout, vertices, indices, count: ch.idx.length }, triangles: ch.idx.length / 3 });
  }
  return out;
}

function sameAttribs(a: MeshData, b: MeshData): boolean {
  if (a.layout === b.layout) return true;
  const x = a.layout.attribs;
  const y = b.layout.attribs;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i]!, q = y[i]!;
    if (p.name !== q.name || p.size !== q.size || p.type !== q.type || p.offset !== q.offset || !!p.normalized !== !!q.normalized || !!p.integer !== !!q.integer) return false;
  }
  return true;
}
