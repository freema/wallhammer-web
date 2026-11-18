// The mesh builder of the village: the engine's `MeshBuilder` (gen-mesh) in the village's vertex format. The engine
// keeps the positions, normals, triangles and the transform stack (mirroring included); the village adds per-vertex
// colours with baked occlusion and flags (glow, sway in the wind, material class, glow channel), kept in its own flat
// arrays beside the engine's and packed by the format's `write` through the vertex number. Every solid thing of the
// example, static or instanced, is written in this one format, so one material draws all of it
// (src/render/materials.ts).
//
// Vertex format (24 bytes, VERTEX_LAYOUT):
//   a_pos    3 × f32           position in metres
//   a_normal 4 × i8 normalised unit normal (w unused)
//   a_color  4 × u8 normalised rgb albedo; a = ambient occlusion (1 open, 0 fully occluded)
//   a_flags  4 × u8 normalised x glow 0–1, y sway 0–1, z material class (MAT, as code / 255), w glow channel (GLOW)
//
// Winding: triangles are counter-clockwise seen from the side their normal points to (outside). Back faces are
// culled by the material, so a face wound the wrong way disappears: check with `inspect()` (kit/inspect.ts).

import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import { MeshBuilder as EngineMeshBuilder, faceNormal } from 'wallhammer-web/gen-mesh';
import type { MeshBounds, MeshBuildOptions, VertexFormat } from 'wallhammer-web/gen-mesh';
import type { Mat34, Vec3 } from './math.ts';
import { cross3, norm3, sub3 } from './math.ts';
import type { RGB } from './color.ts';

export { faceNormal };

export const VERTEX_STRIDE = 24;

export const VERTEX_LAYOUT: VertexLayout = {
  stride: VERTEX_STRIDE,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i8', normalized: true, offset: 12 },
    { name: 'a_color', size: 4, type: 'u8', normalized: true, offset: 16 },
    { name: 'a_flags', size: 4, type: 'u8', normalized: true, offset: 20 },
  ],
};

/**
 * Material classes (a_flags.z). The shader varies its painted breakup by class: grain along wood, blotches on stone,
 * soft mottling on plaster, leaf clusters on foliage, weave on fabric, sheen on metal.
 */
export const MAT = {
  generic: 0,
  wood: 1,
  stone: 2,
  plaster: 3,
  foliage: 4,
  fabric: 5,
  metal: 6,
  ground: 7,
  roof: 8,
  glass: 9,
  bark: 10,
  skin: 11,
  hair: 12,
} as const;
export type MatClass = (typeof MAT)[keyof typeof MAT];

/**
 * Glow channels (a_flags.w). The strength of each channel comes from the environment every frame (src/env.ts):
 * `evening` follows dusk (windows, lanterns), `fire` is always on and flickers (forge, hearth, torches), `steady` is
 * always on without flicker (magic, signs).
 */
export const GLOW = { evening: 0, fire: 1, steady: 2 } as const;
export type GlowChannel = (typeof GLOW)[keyof typeof GLOW];

/** Per-vertex flags as plain numbers. */
export interface VertexFlags {
  /** Emission 0–1: the vertex colour shines with this share when its channel is on. */
  glow: number;
  /** Sway 0–1: how far the vertex moves in the wind (0 for anything rigid; leaf tips and grass 1). */
  sway: number;
  /** Material class (MAT; water meshes store the flow direction x here, see kit/types.ts). */
  cls: MatClass | number;
  /** Glow channel (GLOW; water meshes store the flow direction z here). */
  channel: GlowChannel | number;
}

export const DEFAULT_FLAGS: VertexFlags = { glow: 0, sway: 0, cls: MAT.generic, channel: GLOW.evening };

/** Axis-aligned bounds. */
export type Bounds = MeshBounds;

const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const toSigned = (v: number): number => Math.max(-127, Math.min(127, Math.round(v * 127)));
const toCode = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** The village format over colour and flag arrays of one builder (4 numbers per vertex each, read by vertex number). */
function villageFormat(col: number[], flg: number[]): VertexFormat<unknown> {
  return {
    layout: VERTEX_LAYOUT,
    stride: VERTEX_STRIDE,
    write(view, o, p, n, _v, i) {
      view.setFloat32(o, p[0]!, true);
      view.setFloat32(o + 4, p[1]!, true);
      view.setFloat32(o + 8, p[2]!, true);
      view.setInt8(o + 12, toSigned(n[0]!));
      view.setInt8(o + 13, toSigned(n[1]!));
      view.setInt8(o + 14, toSigned(n[2]!));
      view.setInt8(o + 15, 0);
      const c = i * 4;
      view.setUint8(o + 16, toByte(col[c]!));
      view.setUint8(o + 17, toByte(col[c + 1]!));
      view.setUint8(o + 18, toByte(col[c + 2]!));
      view.setUint8(o + 19, toByte(col[c + 3]!));
      view.setUint8(o + 20, toByte(flg[c]!));
      view.setUint8(o + 21, toByte(flg[c + 1]!));
      view.setUint8(o + 22, toCode(flg[c + 2]!));
      view.setUint8(o + 23, toCode(flg[c + 3]!));
    },
  };
}

/**
 * The engine builder with the village's colour and flags per vertex. Positions, normals and indices are the engine's
 * (`positionData`, `normalData`, `indexData`, read only; change them with `displace`/`edit` and `setTriangle`); `col`
 * and `flg` are the village's own and may be written directly.
 */
export class MeshBuilder extends EngineMeshBuilder<unknown> {
  /** Colours, 4 per vertex: rgb and ambient occlusion. */
  readonly col: number[];
  /** Flags, 4 per vertex: glow, sway, class code, channel code. */
  readonly flg: number[];
  /** Colour used when a vertex is written without one. */
  color: RGB = [0.8, 0.8, 0.8];
  /** Flags used for every vertex written from now on. */
  flags: VertexFlags = { ...DEFAULT_FLAGS };

  constructor() {
    const col: number[] = [];
    const flg: number[] = [];
    super(villageFormat(col, flg));
    this.col = col;
    this.flg = flg;
  }

  /** Sets the current colour; returns this for chaining. */
  paint(c: RGB): this {
    this.color = [c[0], c[1], c[2]];
    return this;
  }

  /** Changes some of the current flags; returns this. */
  set(f: Partial<VertexFlags>): this {
    this.flags = { ...this.flags, ...f };
    return this;
  }

  /** Runs `fn` with other flags (restored afterwards). */
  withFlags(f: Partial<VertexFlags>, fn: (b: this) => void): this {
    const keep = this.flags;
    const keepColor = this.color;
    this.flags = { ...this.flags, ...f };
    try {
      fn(this);
    } finally {
      this.flags = keep;
      this.color = keepColor;
    }
    return this;
  }

  /** Writes one vertex (in the current transform) and returns its index. `ao` is 1 unless given. */
  override vertex(p: ArrayLike<number>, n: ArrayLike<number>, c: ArrayLike<number> = this.color, ao = 1): number {
    this.col.push(c[0]!, c[1]!, c[2]!, ao);
    const f = this.flags;
    this.flg.push(f.glow, f.sway, f.cls, f.channel);
    return super.vertex(p, n, null);
  }

  /**
   * A flat convex polygon (counter-clockwise from outside) with its own vertices and one face normal. `colors` may
   * give a colour per corner. Returns the index of the first vertex.
   */
  face(points: readonly (readonly number[])[], colors?: readonly (readonly number[])[], ao?: readonly number[]): number {
    const n = faceNormal(points);
    const first = this.vertexCount;
    points.forEach((p, k) => this.vertex(p, n, colors?.[k] ?? this.color, ao?.[k] ?? 1));
    for (let k = 1; k < points.length - 1; k++) this.tri(first, first + k, first + k + 1);
    return first;
  }

  /**
   * A grid of vertices `rows × cols` from a function, with smooth normals from the grid itself, stitched into quads.
   * `at(i, j)` returns the position; row j runs along the second parameter. Winding: quads (i,j) (i+1,j) (i+1,j+1)
   * (i,j+1) must be counter-clockwise from outside, i.e. the cross product d/di × d/dj points out. With `flip` the
   * other way round. `wrapI` joins the last column to the first (closed tubes).
   */
  grid(cols: number, rows: number, at: (i: number, j: number) => readonly number[], color: (i: number, j: number, p: readonly number[]) => readonly number[], o: { flip?: boolean; wrapI?: boolean } = {}): number {
    const P: (readonly number[])[] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) P.push(at(i, j));
    const get = (i: number, j: number): readonly number[] => {
      if (o.wrapI) i = ((i % cols) + cols) % cols;
      else i = Math.max(0, Math.min(cols - 1, i));
      j = Math.max(0, Math.min(rows - 1, j));
      return P[j * cols + i]!;
    };
    const first = this.vertexCount;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const di = sub3(get(i + 1, j), get(i - 1, j));
        const dj = sub3(get(i, j + 1), get(i, j - 1));
        let n = cross3(di, dj);
        if (o.flip) n = [-n[0], -n[1], -n[2]];
        if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = [0, 1, 0];
        this.vertex(P[j * cols + i]!, norm3(n), color(i, j, P[j * cols + i]!));
      }
    }
    const lastI = o.wrapI ? cols : cols - 1;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < lastI; i++) {
        const i1 = (i + 1) % cols;
        const a = first + j * cols + i, b = first + j * cols + i1, c = first + (j + 1) * cols + i1, d = first + (j + 1) * cols + i;
        if (o.flip) this.quad(a, d, c, b);
        else this.quad(a, b, c, d);
      }
    }
    return first;
  }

  /**
   * Appends another builder (its colours and flags kept), through an optional transform and colour tint. Use it to
   * slice parts built once into many places (merging), e.g. one shutter design on every window of a house.
   */
  override append(other: MeshBuilder, m?: Mat34, tint?: readonly number[]): this {
    const t0 = tint ? tint[0]! : 1, t1 = tint ? tint[1]! : 1, t2 = tint ? tint[2]! : 1;
    const C = other.col, F = other.flg;
    for (let k = 0; k < C.length; k += 4) {
      this.col.push(C[k]! * t0, C[k + 1]! * t1, C[k + 2]! * t2, C[k + 3]!);
      this.flg.push(F[k]!, F[k + 1]!, F[k + 2]!, F[k + 3]!);
    }
    return super.append(other, m);
  }

  /** Changes vertex colours from `first` on: `fn` gets the position, normal and the colour (rgb + ao) to edit in place. */
  recolor(fn: (p: Vec3, n: Vec3, c: number[], index: number) => void, first = 0): this {
    const p: Vec3 = [0, 0, 0];
    const n: Vec3 = [0, 0, 0];
    const c = [0, 0, 0, 0];
    for (let v = first; v < this.vertexCount; v++) {
      this.position(v, p);
      this.normal(v, n);
      for (let k = 0; k < 4; k++) c[k] = this.col[v * 4 + k]!;
      fn(p, n, c, v);
      for (let k = 0; k < 4; k++) this.col[v * 4 + k] = c[k]!;
    }
    return this;
  }

  /** Moves vertices from `first` on (positions only; normals are kept, so keep displacements small or rebuild). */
  displace(fn: (p: Vec3, index: number) => void, first = 0): this {
    return this.edit((p, _n, _v, i) => fn(p, i), first);
  }

  /** Sets flags of vertices from `first` on. */
  reflag(f: Partial<VertexFlags>, first = 0): this {
    for (let v = first; v < this.vertexCount; v++) {
      if (f.glow !== undefined) this.flg[v * 4] = f.glow;
      if (f.sway !== undefined) this.flg[v * 4 + 1] = f.sway;
      if (f.cls !== undefined) this.flg[v * 4 + 2] = f.cls;
      if (f.channel !== undefined) this.flg[v * 4 + 3] = f.channel;
    }
    return this;
  }

  /** Packs the mesh into the GPU vertex format (VERTEX_LAYOUT), with 32-bit indices unless told otherwise. */
  override build(o: MeshBuildOptions = { index: 32 }): MeshData {
    return super.build(o);
  }

  /** Removes everything (the current colour, flags and transform stay). */
  override clear(): this {
    this.col.length = 0;
    this.flg.length = 0;
    return super.clear();
  }
}
