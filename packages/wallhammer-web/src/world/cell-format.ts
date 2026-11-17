// Binary format of one MESHED cell. A generator running in a worker and a pre-baked file served over HTTP hand over
// exactly these bytes, so "from a generator" and "from a file" cannot drift apart. Decoding makes no copies: the
// typed arrays of the result are views into the one buffer, which a worker can transfer instead of copying.
//
// Layout (little endian, every section starts on a 4-byte boundary):
//   u32 magic 'WHC1'   u32 format version   u32 domain version   u32 cell id high   u32 cell id low
//   f32 × 6 bounds (min xyz, max xyz, cell-local)   u32 mesh count   u32 instance batch count
//   mesh:      str material, layout, u32 primitive (0 triangles, 1 lines), u32 count,
//              u32 vertex bytes + bytes, u32 index width (0 none, 2, 4) + u32 index count + indices
//   instances: str archetype, layout, u32 float count + f32 data, u32 id words + u32 ids ([high, low] per instance)
//   layout:    u32 stride, u32 attribute count, per attribute: str name, u8 size, u8 type, u8 flags, u8 0, u32 offset
//   str:       u32 byte length + UTF-8 bytes
//
// Format 2 (shaped cells) adds two fields after the cell id: `u32 shape hash` (0 = not stated) and `f32 error` in
// metres (negative = not measured). A cell is written in format 2 only when it states `shapeHash` or `error`; every
// other cell keeps format 1 and its bytes. The reader takes both.

import type { MeshData, ScalarType, VertexLayout } from '../base/data.ts';
import type { CellContent, CellInstances, CellMesh } from '../gen-core/cell.ts';
import { cellBits, cellFromBits } from '../gen-core/cell.ts';

export const CELL_MAGIC = 0x31434857; // 'WHC1'
export const CELL_FORMAT_VERSION = 1;
/** Format version of a cell that states the hash of its world shape or its error. */
export const CELL_FORMAT_VERSION_SHAPED = 2;
/** File extension of a baked cell. */
export const CELL_FILE_EXT = '.whc';

const TYPES: readonly ScalarType[] = ['f32', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32'];
const pad4 = (n: number): number => (n + 3) & ~3;

class Writer {
  private buf = new ArrayBuffer(1 << 16);
  private view = new DataView(this.buf);
  private bytes = new Uint8Array(this.buf);
  at = 0;

  private room(n: number): void {
    if (this.at + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.at + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.at));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
  }

  f32(v: number): void {
    this.room(4);
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }

  u8x4(a: number, b: number, c: number, d: number): void {
    this.room(4);
    this.bytes[this.at] = a;
    this.bytes[this.at + 1] = b;
    this.bytes[this.at + 2] = c;
    this.bytes[this.at + 3] = d;
    this.at += 4;
  }

  /** Raw bytes, zero-padded to four. */
  raw(src: ArrayBufferView): void {
    const n = src.byteLength;
    const p = pad4(n);
    this.room(p);
    this.bytes.set(new Uint8Array(src.buffer, src.byteOffset, n), this.at);
    this.bytes.fill(0, this.at + n, this.at + p);
    this.at += p;
  }

  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.u32(b.byteLength);
    this.raw(b);
  }

  layout(l: VertexLayout): void {
    this.u32(l.stride);
    this.u32(l.attribs.length);
    for (const a of l.attribs) {
      this.str(a.name);
      this.u8x4(a.size, TYPES.indexOf(a.type), (a.normalized ? 1 : 0) | (a.integer ? 2 : 0), 0);
      this.u32(a.offset);
    }
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.at);
  }
}

/** Encodes a cell. The same content always gives the same bytes. */
export function encodeCell(c: CellContent): Uint8Array {
  const w = new Writer();
  const [hi, lo] = cellBits(c.cell);
  const shaped = c.shapeHash !== undefined || c.error !== undefined;
  w.u32(CELL_MAGIC);
  w.u32(shaped ? CELL_FORMAT_VERSION_SHAPED : CELL_FORMAT_VERSION);
  w.u32(c.domainVersion);
  w.u32(hi);
  w.u32(lo);
  if (shaped) {
    w.u32(c.shapeHash ?? 0);
    w.f32(c.error !== undefined && c.error >= 0 ? c.error : -1);
  }
  for (const v of [...c.bounds.min, ...c.bounds.max]) w.f32(v);
  w.u32(c.meshes.length);
  w.u32(c.instances.length);
  for (const m of c.meshes) {
    w.str(m.material);
    w.layout(m.mesh.layout);
    w.u32(m.mesh.primitive === 'lines' ? 1 : 0);
    w.u32(m.mesh.count);
    w.u32(m.mesh.vertices.byteLength);
    w.raw(m.mesh.vertices);
    const ix = m.mesh.indices;
    w.u32(ix ? ix.BYTES_PER_ELEMENT : 0);
    w.u32(ix ? ix.length : 0);
    if (ix) w.raw(ix);
  }
  for (const b of c.instances) {
    w.str(b.archetype);
    w.layout(b.data.layout);
    w.u32(b.data.data.length);
    w.raw(b.data.data);
    w.u32(b.ids.length);
    w.raw(b.ids);
  }
  return w.result();
}

/**
 * Decodes a cell of format 1 or 2. The typed arrays of the result are views into `bytes` (which must start on a
 * 4-byte boundary). A format 2 cell comes back with `shapeHash` and `error` where the file states them.
 */
export function decodeCell(bytes: Uint8Array): CellContent {
  if (bytes.byteOffset % 4 !== 0) bytes = bytes.slice();
  const buf = bytes.buffer;
  const base = bytes.byteOffset;
  const view = new DataView(buf, base, bytes.byteLength);
  let at = 0;
  const u32 = (): number => {
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const f32 = (): number => {
    const v = view.getFloat32(at, true);
    at += 4;
    return v;
  };
  const take = (n: number): number => {
    const start = at;
    at += pad4(n);
    if (at > bytes.byteLength) throw new Error('cell file is truncated');
    return base + start;
  };
  const str = (): string => {
    const n = u32();
    return new TextDecoder().decode(new Uint8Array(buf, take(n), n));
  };
  const layout = (): VertexLayout => {
    const stride = u32();
    const count = u32();
    const attribs = [];
    for (let i = 0; i < count; i++) {
      const name = str();
      const size = view.getUint8(at) as 1 | 2 | 3 | 4;
      const type = TYPES[view.getUint8(at + 1)]!;
      const flags = view.getUint8(at + 2);
      at += 4;
      const offset = u32();
      attribs.push({ name, size, type, offset, ...(flags & 1 ? { normalized: true } : {}), ...(flags & 2 ? { integer: true } : {}) });
    }
    return { stride, attribs };
  };

  if (u32() !== CELL_MAGIC) throw new Error('not a cell file (bad magic)');
  const version = u32();
  if (version !== CELL_FORMAT_VERSION && version !== CELL_FORMAT_VERSION_SHAPED) throw new Error(`cell file format ${version}, expected ${CELL_FORMAT_VERSION} or ${CELL_FORMAT_VERSION_SHAPED}`);
  const domainVersion = u32();
  const hi = u32();
  const lo = u32();
  const shaped = version === CELL_FORMAT_VERSION_SHAPED;
  const shape = shaped ? u32() : 0;
  const error = shaped ? f32() : -1;
  const b = [f32(), f32(), f32(), f32(), f32(), f32()];
  const meshCount = u32();
  const instCount = u32();
  const meshes: CellMesh[] = [];
  for (let i = 0; i < meshCount; i++) {
    const material = str();
    const l = layout();
    const primitive = u32() === 1 ? 'lines' : 'triangles';
    const count = u32();
    const vb = u32();
    const vertices = new Uint8Array(buf, take(vb), vb);
    const width = u32();
    const n = u32();
    const indices = width === 0 ? null : width === 2 ? new Uint16Array(buf, take(n * 2), n) : new Uint32Array(buf, take(n * 4), n);
    const mesh: MeshData = { layout: l, vertices, indices, count, ...(primitive === 'lines' ? { primitive } : {}) };
    meshes.push({ material, mesh });
  }
  const instances: CellInstances[] = [];
  for (let i = 0; i < instCount; i++) {
    const archetype = str();
    const l = layout();
    const nf = u32();
    const data = new Float32Array(buf, take(nf * 4), nf);
    const ni = u32();
    const ids = new Uint32Array(buf, take(ni * 4), ni);
    instances.push({ archetype, data: { layout: l, data }, ids });
  }
  return {
    cell: cellFromBits(hi, lo),
    domainVersion,
    bounds: { min: [b[0]!, b[1]!, b[2]!], max: [b[3]!, b[4]!, b[5]!] },
    meshes,
    instances,
    ...(shape !== 0 ? { shapeHash: shape } : {}),
    ...(error >= 0 ? { error } : {}),
  };
}

/**
 * Relative path of a baked cell: `<face>/<level>/<x>/<y>.whc` (coordinates without the offset). With the hash of a
 * world shape (`shapeHash` of gen-core) the path starts with it, as `s<8 hex digits>/`, so cells baked for different
 * shapes never share a file.
 */
export function cellFilePath(c: { face: number; level: number; x: number; y: number }, shape?: number): string {
  const dir = shape === undefined ? '' : `s${(shape >>> 0).toString(16).padStart(8, '0')}/`;
  return `${dir}${c.face}/${c.level}/${c.x}/${c.y}${CELL_FILE_EXT}`;
}
