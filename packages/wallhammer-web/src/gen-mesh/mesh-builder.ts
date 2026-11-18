// The core of mesh construction: triangles, a transform stack, mirroring, appending and bounds, over a vertex format that
// the caller supplies. The builder knows only the position, the normal, the transforms and the indices of a vertex;
// everything else a vertex carries (colours, flags, texture or panel coordinates, …) is a payload `V` that the
// builder stores by reference and hands back to the format's `write` when the mesh is packed. What the payload means
// and how it is encoded is the caller's business: the builder never looks inside.
//
// Positions and normals are kept as doubles until `build`; a mirroring transform (negative determinant) flips the
// winding of the triangles written under it, so faces stay counter-clockwise seen from outside. Everything here is
// meant for setup, not for every frame: it allocates freely.

import type { MeshData, VertexLayout } from '../base/data.ts';
import { mat34Determinant, mat34Multiply, mat34Normal, mat34Point } from '../base/mat34.ts';
import type { Vec3 } from '../base/math.ts';

/** What the caller stores per vertex besides position and normal. The engine never looks inside. */
export interface VertexFormat<V> {
  /** Attributes, including position and normal. `layout.stride` must equal `stride`. */
  readonly layout: VertexLayout;
  /** Bytes per vertex. */
  readonly stride: number;
  /**
   * Writes one vertex at byte `offset` of `view`; `p` and `n` are already in mesh space (`n` unit length or zero).
   * `index` is the vertex number, for formats that keep per-vertex data of their own beside the payload.
   */
  write(view: DataView, offset: number, p: ArrayLike<number>, n: ArrayLike<number>, v: V, index: number): void;
}

/** Axis-aligned bounds. */
export interface MeshBounds {
  min: Vec3;
  max: Vec3;
}

/** Options of `MeshBuilder.build` and `MeshBuilder.indices`. */
export interface MeshBuildOptions {
  /** Index width: 16 bits (only up to 65,536 vertices), 32 bits, or 'auto' (default: 16 bits when it fits). */
  index?: 16 | 32 | 'auto';
}

/** Called by `MeshBuilder.edit` per vertex: `p` and `n` may be changed in place; a returned payload replaces the old. */
export type VertexEdit<V> = (p: Vec3, n: Vec3, v: V, index: number) => V | void;

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/**
 * Collects vertices and triangles in a vertex format supplied by the caller. Vertices go through the current
 * transform (`push`/`pop`/`with`); a mirroring transform flips the winding of `tri`, `quad` and `append`.
 */
export class MeshBuilder<V> {
  readonly format: VertexFormat<V>;
  /** Positions in mesh space, three per vertex. */
  private readonly pos: number[] = [];
  /** Unit normals in mesh space, three per vertex. */
  private readonly nrm: number[] = [];
  private readonly data: V[] = [];
  private readonly idx: number[] = [];
  /** Current transform and the saved ones (each a 12-number column-major 3 × 4 matrix). */
  private m: Float64Array = Float64Array.from(IDENTITY);
  private readonly stack: Float64Array[] = [];
  private identity = true;
  private flip = false;
  private readonly sp: Vec3 = [0, 0, 0];
  private readonly sn: Vec3 = [0, 0, 0];

  constructor(format: VertexFormat<V>) {
    if (format.layout.stride !== format.stride) throw new Error(`MeshBuilder: layout stride ${format.layout.stride} differs from format stride ${format.stride}`);
    this.format = format;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get indexCount(): number {
    return this.idx.length;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** The current transform (12 numbers, column-major 3 × 4). Read only; change it with `push`/`pop`. */
  get transform(): Readonly<Float64Array> {
    return this.m;
  }

  /** Whether the current transform mirrors (negative determinant): `tri` then writes the reversed winding. */
  get mirrored(): boolean {
    return this.flip;
  }

  /** Multiplies the current transform by `m` (`m` applies first, to everything written until the matching `pop`). */
  push(m: ArrayLike<number>): this {
    this.stack.push(this.m);
    this.m = mat34Multiply(this.m, m, new Float64Array(12));
    this.update();
    return this;
  }

  /** Restores the transform saved by the matching `push`. */
  pop(): this {
    const m = this.stack.pop();
    if (!m) throw new Error('MeshBuilder: pop without push');
    this.m = m;
    this.update();
    return this;
  }

  /** Runs `fn` with `m` pushed, and pops it again even when `fn` throws. */
  with(m: ArrayLike<number>, fn: (b: this) => void): this {
    this.push(m);
    try {
      fn(this);
    } finally {
      this.pop();
    }
    return this;
  }

  private update(): void {
    const m = this.m;
    let id = true;
    for (let k = 0; k < 12; k++) if (m[k] !== IDENTITY[k]) id = false;
    this.identity = id;
    this.flip = mat34Determinant(m) < 0;
  }

  /** Adds a vertex: `p` and `n` in the current local frame, `v` its payload (stored by reference). Returns its index. */
  vertex(p: ArrayLike<number>, n: ArrayLike<number>, v: V): number {
    const i = this.pos.length / 3;
    if (this.identity) {
      const l = Math.sqrt(n[0]! * n[0]! + n[1]! * n[1]! + n[2]! * n[2]!);
      const s = l > 0 ? 1 / l : 0;
      this.pos.push(p[0]!, p[1]!, p[2]!);
      this.nrm.push(n[0]! * s, n[1]! * s, n[2]! * s);
    } else {
      const q = mat34Point(this.m, p[0]!, p[1]!, p[2]!, this.sp);
      const k = mat34Normal(this.m, n[0]!, n[1]!, n[2]!, this.sn);
      this.pos.push(q[0], q[1], q[2]);
      this.nrm.push(k[0], k[1], k[2]);
    }
    this.data.push(v);
    return i;
  }

  /** A triangle of existing vertices, counter-clockwise seen from outside (reversed under a mirroring transform). */
  tri(a: number, b: number, c: number): this {
    if (this.flip) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
    return this;
  }

  /** A quad a-b-c-d, counter-clockwise from outside: triangles a-b-c and a-c-d. */
  quad(a: number, b: number, c: number, d: number): this {
    return this.tri(a, b, c).tri(a, c, d);
  }

  /**
   * Appends another builder's vertices and triangles, through the current transform and then `m` (when given).
   * Payloads are kept (the same references); a mirroring result flips the winding.
   */
  append(other: MeshBuilder<V>, m?: ArrayLike<number>): this {
    const full = m ? mat34Multiply(this.m, m, new Float64Array(12)) : this.m;
    let id = true;
    for (let k = 0; k < 12; k++) if (full[k] !== IDENTITY[k]) id = false;
    const mirror = mat34Determinant(full) < 0;
    const base = this.vertexCount;
    const P = other.pos, N = other.nrm;
    const p = this.sp, q = this.sn;
    for (let v = 0; v < P.length; v += 3) {
      if (id) {
        this.pos.push(P[v]!, P[v + 1]!, P[v + 2]!);
        this.nrm.push(N[v]!, N[v + 1]!, N[v + 2]!);
      } else {
        mat34Point(full, P[v]!, P[v + 1]!, P[v + 2]!, p);
        mat34Normal(full, N[v]!, N[v + 1]!, N[v + 2]!, q);
        this.pos.push(p[0], p[1], p[2]);
        this.nrm.push(q[0], q[1], q[2]);
      }
    }
    for (const d of other.data) this.data.push(d);
    const I = other.idx;
    for (let t = 0; t < I.length; t += 3) {
      const a = base + I[t]!, b = base + I[t + 1]!, c = base + I[t + 2]!;
      if (mirror) this.idx.push(a, c, b);
      else this.idx.push(a, b, c);
    }
    return this;
  }

  /** Bounds of the vertices from `first` on, in mesh space. Empty: min +∞, max −∞. */
  bounds(first = 0): MeshBounds {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const P = this.pos;
    for (let i = first * 3; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const x = P[i + k]!;
        if (x < min[k]!) min[k] = x;
        if (x > max[k]!) max[k] = x;
      }
    }
    return { min, max };
  }

  /** Position of vertex `i` in mesh space (into `out` when given). */
  position(i: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = this.pos[i * 3]!;
    out[1] = this.pos[i * 3 + 1]!;
    out[2] = this.pos[i * 3 + 2]!;
    return out;
  }

  /** Normal of vertex `i` in mesh space (into `out` when given). */
  normal(i: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = this.nrm[i * 3]!;
    out[1] = this.nrm[i * 3 + 1]!;
    out[2] = this.nrm[i * 3 + 2]!;
    return out;
  }

  /** Payload of vertex `i`. */
  payload(i: number): V {
    if (i < 0 || i >= this.data.length) throw new RangeError(`MeshBuilder: no vertex ${i}`);
    return this.data[i]!;
  }

  /** Replaces the payload of vertex `i`. */
  setPayload(i: number, v: V): this {
    if (i < 0 || i >= this.data.length) throw new RangeError(`MeshBuilder: no vertex ${i}`);
    this.data[i] = v;
    return this;
  }

  /**
   * Visits the vertices from `first` up to (not including) `end` in mesh space: `fn` may move the position, change the
   * normal (renormalised afterwards) and return a new payload.
   */
  edit(fn: VertexEdit<V>, first = 0, end = this.vertexCount): this {
    const p: Vec3 = [0, 0, 0];
    const n: Vec3 = [0, 0, 0];
    for (let i = first; i < end; i++) {
      for (let k = 0; k < 3; k++) {
        p[k] = this.pos[i * 3 + k]!;
        n[k] = this.nrm[i * 3 + k]!;
      }
      const r = fn(p, n, this.data[i]!, i);
      if (r !== undefined) this.data[i] = r as V;
      const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      const s = l > 0 ? 1 / l : 0;
      for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] = p[k]!;
        this.nrm[i * 3 + k] = n[k]! * s;
      }
    }
    return this;
  }

  /**
   * The positions in mesh space, three per vertex, without a copy: read only and live (they grow with the builder).
   * For passes over a large mesh (occlusion, checks) where a copy per pass or `position(i)` per vertex would be slow.
   */
  get positionData(): ArrayLike<number> {
    return this.pos;
  }

  /** The unit normals, three per vertex, without a copy: read only and live. */
  get normalData(): ArrayLike<number> {
    return this.nrm;
  }

  /** The indices, three per triangle, without a copy: read only and live. Change a triangle with `setTriangle`. */
  get indexData(): ArrayLike<number> {
    return this.idx;
  }

  /**
   * Replaces the vertices of triangle `t` exactly as given (the current transform's mirroring is not applied): to turn
   * the winding of a triangle after the fact, for example so that it faces the way its vertex normals point.
   */
  setTriangle(t: number, a: number, b: number, c: number): this {
    if (!Number.isInteger(t) || t < 0 || t * 3 >= this.idx.length) throw new RangeError(`MeshBuilder: no triangle ${t}`);
    const n = this.pos.length / 3;
    if (!(a >= 0 && a < n && b >= 0 && b < n && c >= 0 && c < n) || !Number.isInteger(a + b + c)) {
      throw new RangeError(`MeshBuilder: triangle ${t} names a vertex outside 0..${n - 1}`);
    }
    const o = t * 3;
    this.idx[o] = a;
    this.idx[o + 1] = b;
    this.idx[o + 2] = c;
    return this;
  }

  /** Positions as floats, three per vertex (a new array): for collisions, checks, bounds. */
  positions(): Float32Array {
    return Float32Array.from(this.pos);
  }

  /** Normals as floats, three per vertex (a new array). */
  normals(): Float32Array {
    return Float32Array.from(this.nrm);
  }

  /** The indices (a new array): for collisions, checks, or a second index order over the same vertices. */
  indices(o: MeshBuildOptions = {}): Uint32Array | Uint16Array {
    const wide = o.index === 32 || ((o.index ?? 'auto') === 'auto' && this.vertexCount > 65536);
    if (!wide && this.vertexCount > 65536) throw new RangeError(`MeshBuilder: ${this.vertexCount} vertices do not fit 16-bit indices`);
    return wide ? Uint32Array.from(this.idx) : Uint16Array.from(this.idx);
  }

  /** The vertex bytes in the format: `format.write` once per vertex, in order. */
  vertices(): Uint8Array {
    const n = this.vertexCount;
    const stride = this.format.stride;
    const bytes = new Uint8Array(n * stride);
    const view = new DataView(bytes.buffer);
    const p = this.sp, q = this.sn;
    for (let i = 0; i < n; i++) {
      this.position(i, p);
      this.normal(i, q);
      this.format.write(view, i * stride, p, q, this.data[i]!, i);
    }
    return bytes;
  }

  /** The mesh: the vertex bytes in the format's layout and the indices. */
  build(o: MeshBuildOptions = {}): MeshData {
    const indices = this.indices(o);
    return { layout: this.format.layout, vertices: this.vertices(), indices, count: indices.length };
  }

  /** Removes all vertices and triangles; the transform stack stays. */
  clear(): this {
    this.pos.length = 0;
    this.nrm.length = 0;
    this.data.length = 0;
    this.idx.length = 0;
    return this;
  }
}

/** Unit normal of a flat polygon given counter-clockwise seen from its front (Newell's method). Zero when degenerate. */
export function faceNormal(points: readonly ArrayLike<number>[], out: Vec3 = [0, 0, 0]): Vec3 {
  let x = 0, y = 0, z = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    x += (a[1]! - b[1]!) * (a[2]! + b[2]!);
    y += (a[2]! - b[2]!) * (a[0]! + b[0]!);
    z += (a[0]! - b[0]!) * (a[1]! + b[1]!);
  }
  const l = Math.sqrt(x * x + y * y + z * z);
  const s = l > 0 ? 1 / l : 0;
  out[0] = x * s;
  out[1] = y * s;
  out[2] = z * s;
  return out;
}
