// Plain data a generator hands over: vertex streams, meshes and textures as typed arrays with a description.
// Nothing here touches the GPU; the gpu module turns these into GPU objects.

/** Component type of a vertex attribute or texture channel. */
export type ScalarType = 'f32' | 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32';

/** One attribute inside an interleaved vertex stream. */
export interface VertexAttrib {
  /** Attribute name in the shader. The material fixes its location. */
  name: string;
  size: 1 | 2 | 3 | 4;
  type: ScalarType;
  /** Integer types mapped to 0–1 (or −1–1) floats. */
  normalized?: boolean;
  /** Read as an integer vector (ivec/uvec) in the shader. */
  integer?: boolean;
  /** Byte offset inside one vertex. */
  offset: number;
}

/** Layout of an interleaved stream. */
export interface VertexLayout {
  /** Bytes per vertex (or per instance). */
  stride: number;
  attribs: readonly VertexAttrib[];
}

export type Primitive = 'triangles' | 'lines';

/** A mesh as data: one interleaved vertex stream, optional indices. */
export interface MeshData {
  layout: VertexLayout;
  vertices: ArrayBufferView;
  /** `null` draws the vertices in order. */
  indices: Uint16Array | Uint32Array | null;
  /** Index count, or vertex count without indices. */
  count: number;
  /** Default `'triangles'`. */
  primitive?: Primitive;
}

/** Per-instance stream shared by several meshes (levels of detail of one shape). Floats only, rewritten when culling. */
export interface InstanceData {
  layout: VertexLayout;
  data: Float32Array;
}

/** Where an instance stores what culling needs, as float offsets inside one instance. */
export interface InstanceBounds {
  /** Base point x, y, z (three consecutive floats). */
  position: number;
  /** Horizontal reach around the upright segment. */
  radius: number;
  /** Height of the upright segment above the base point. */
  height: number;
}

export type TextureFormat = 'r8' | 'r8ui' | 'rg8' | 'rgba8';

/**
 * Sampling of a texture. `nearest` and `linear` without mipmaps; `mipmap` = trilinear with mipmaps generated
 * after upload or bake, optionally with anisotropic filtering up to `anisotropy`.
 */
export interface TextureSampling {
  filter?: 'nearest' | 'linear' | 'mipmap';
  anisotropy?: number;
}

/** A 2D texture as data. Rows go from texture coordinate 0 upward; one byte per channel. */
export interface TextureData extends TextureSampling {
  width: number;
  height: number;
  format: TextureFormat;
  data: Uint8Array;
}

/** Bytes per pixel of a format. */
export function texelBytes(format: TextureFormat): number {
  return format === 'rgba8' ? 4 : format === 'rg8' ? 2 : 1;
}

/** Number of primitives in a mesh. */
export function primitiveCount(m: MeshData): number {
  return m.primitive === 'lines' ? m.count / 2 : m.count / 3;
}
