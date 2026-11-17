// Dense entity table for mass entities (Wallhammer Zero, "Three classes of objects"): one typed array per column,
// rows packed without holes, and an id per row that the table assigns itself. The id is the identity; a row index
// is only where the entity sits right now and changes when another entity is removed (swap with the last row).
//
// Ids are integers below 2^53: `namespace * 2^32 + serial`. The serial counts up from 1 and is never reused, the
// namespace comes from the table name, so ids of different tables do not collide and 0 means "none".

import { hashString } from '../gen-core/hash.ts';
import type { ByteReader, ByteWriter } from './bytes.ts';
import type { SimState } from './simulation.ts';

export type ColumnType = 'i32' | 'u32' | 'i16' | 'u8' | 'f64';
export type ColumnSpec = Readonly<Record<string, ColumnType>>;

interface ArrayOf {
  i32: Int32Array;
  u32: Uint32Array;
  i16: Int16Array;
  u8: Uint8Array;
  f64: Float64Array;
}
export type Columns<S extends ColumnSpec> = { [K in keyof S]: ArrayOf[S[K]] };

const CTOR = { i32: Int32Array, u32: Uint32Array, i16: Int16Array, u8: Uint8Array, f64: Float64Array } as const;
const SERIAL_SPAN = 2 ** 32;
/** Namespaces stay below 2^21, so every id is a safe integer. */
const NAMESPACE_MASK = 0x1fffff;

export class EntityTable<S extends ColumnSpec> implements SimState {
  readonly name: string;
  readonly spec: S;
  /** The id space of this table; the high part of every id. */
  readonly namespace: number;
  private cols: Columns<S>;
  private idCol: Float64Array;
  private rows = new Map<number, number>();
  private n = 0;
  private serial = 0;

  constructor(name: string, spec: S, options: { namespace?: number; capacity?: number } = {}) {
    this.name = name;
    this.spec = spec;
    this.namespace = (options.namespace ?? hashString(name)) & NAMESPACE_MASK;
    const cap = Math.max(4, options.capacity ?? 64);
    this.idCol = new Float64Array(cap);
    this.cols = this.alloc(cap);
  }

  private alloc(cap: number): Columns<S> {
    const out: Record<string, ArrayBufferView> = {};
    for (const k in this.spec) out[k] = new CTOR[this.spec[k]!](cap);
    return out as Columns<S>;
  }

  private grow(): void {
    const cap = this.idCol.length * 2;
    const next = this.alloc(cap);
    for (const k in this.spec) (next[k] as Int32Array).set(this.cols[k] as Int32Array);
    const ids = new Float64Array(cap);
    ids.set(this.idCol);
    this.cols = next;
    this.idCol = ids;
  }

  /** The column arrays. They are replaced when the table grows, so read them again after `create`. */
  get col(): Columns<S> {
    return this.cols;
  }

  /** Ids by row; only the first `count` are valid. */
  get ids(): Float64Array {
    return this.idCol;
  }

  get count(): number {
    return this.n;
  }

  /** Adds an entity with every column 0 and returns its id. */
  create(): number {
    if (this.n === this.idCol.length) this.grow();
    const id = this.namespace * SERIAL_SPAN + ++this.serial;
    const row = this.n++;
    this.idCol[row] = id;
    for (const k in this.spec) (this.cols[k] as Int32Array)[row] = 0;
    this.rows.set(id, row);
    return id;
  }

  /** Row of an entity, or -1. */
  rowOf(id: number): number {
    return this.rows.get(id) ?? -1;
  }

  has(id: number): boolean {
    return this.rows.has(id);
  }

  idAt(row: number): number {
    return this.idCol[row]!;
  }

  /** The id's serial (the low 32 bits): handy as an integer key for hashing. */
  static serialOf(id: number): number {
    return id % SERIAL_SPAN;
  }

  /** Removes an entity; the last row moves into its place. */
  remove(id: number): boolean {
    const row = this.rows.get(id);
    if (row === undefined) return false;
    const last = --this.n;
    this.rows.delete(id);
    if (row !== last) {
      const moved = this.idCol[last]!;
      this.idCol[row] = moved;
      for (const k in this.spec) {
        const a = this.cols[k] as Int32Array;
        a[row] = a[last]!;
      }
      this.rows.set(moved, row);
    }
    return true;
  }

  save(w: ByteWriter): void {
    w.u32(this.n);
    w.f64(this.serial);
    w.bytes(this.idCol.subarray(0, this.n));
    for (const k in this.spec) w.bytes((this.cols[k] as Int32Array).subarray(0, this.n));
  }

  load(r: ByteReader): void {
    const n = r.u32();
    this.serial = r.f64();
    let cap = this.idCol.length;
    while (cap < n) cap *= 2;
    if (cap !== this.idCol.length) {
      this.idCol = new Float64Array(cap);
      this.cols = this.alloc(cap);
    }
    this.n = n;
    r.into(this.idCol.subarray(0, n));
    for (const k in this.spec) r.into((this.cols[k] as Int32Array).subarray(0, n));
    this.rows.clear();
    for (let i = 0; i < n; i++) this.rows.set(this.idCol[i]!, i);
  }
}
