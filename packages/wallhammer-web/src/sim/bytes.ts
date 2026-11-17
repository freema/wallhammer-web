// Byte streams for snapshots and the state hash. Every piece of simulation state writes itself into a `ByteWriter`
// in a fixed order and reads itself back from a `ByteReader`; the state hash is a hash of exactly those bytes, so two
// states with the same hash restore to the same simulation.

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Growable little-endian byte buffer. */
export class ByteWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private at = 0;

  private room(n: number): void {
    if (this.at + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.at + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.at));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  get length(): number {
    return this.at;
  }

  u8(v: number): void {
    this.room(1);
    this.view.setUint8(this.at, v);
    this.at += 1;
  }

  i32(v: number): void {
    this.room(4);
    this.view.setInt32(this.at, v, true);
    this.at += 4;
  }

  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.at, v, true);
    this.at += 4;
  }

  /** A 64-bit float; used for ids (integers below 2^53) and for app-supplied geometry. */
  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }

  str(s: string): void {
    const b = TEXT_ENCODER.encode(s);
    this.u32(b.length);
    this.bytes(b);
  }

  /** The raw bytes of a typed array (no length prefix). */
  bytes(a: ArrayBufferView): void {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    this.room(b.length);
    this.buf.set(b, this.at);
    this.at += b.length;
  }

  /** A copy of what was written. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.at);
  }
}

export class ByteReader {
  private readonly bytesIn: Uint8Array;
  private readonly view: DataView;
  private at = 0;

  constructor(bytes: Uint8Array) {
    this.bytesIn = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.at >= this.bytesIn.length;
  }

  u8(): number {
    const v = this.view.getUint8(this.at);
    this.at += 1;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }

  str(): string {
    const n = this.u32();
    const s = TEXT_DECODER.decode(this.bytesIn.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }

  /** Copies `target.byteLength` bytes into a typed array. */
  into(target: ArrayBufferView): void {
    const n = target.byteLength;
    new Uint8Array(target.buffer, target.byteOffset, n).set(this.bytesIn.subarray(this.at, this.at + n));
    this.at += n;
  }
}

/** 64-bit hash of bytes as 16 hex digits: two independent 32-bit FNV-1a lanes with a final avalanche. */
export function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193);
  }
  const fin = (h: number): string => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  return fin(a ^ bytes.length) + fin(b);
}
