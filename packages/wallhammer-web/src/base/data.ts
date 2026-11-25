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

/**
 * The solid an instance stands for, read from its record: where the base point, the size and the turn sit, as float
 * offsets inside one instance, or constants. Plain data, one per archetype; an index of solids (`SolidIndex` of world)
 * reads instance records with it. The solid is an upright cylinder round the axis from `belowM` under the base point
 * to `height` above it, or with `box` an upright turned box.
 */
export interface InstanceSolid {
  /** Base point x, y, z (three consecutive floats), relative to the cell origin like every instance position. */
  position: number;
  /** Float offset of the radius. Without it the radius is `radiusM`. */
  radius?: number;
  /** Radius in metres when there is no `radius` offset. Default 0 (no solid, unless `box` gives the size). */
  radiusM?: number;
  /** Factor on the radius (a narrow solid core inside a wider shape whose reach the record keeps). Default 1. */
  radiusScale?: number;
  /** Float offset of the height above the base point. Without it the height is `heightM`. */
  height?: number;
  /** Height in metres when there is no `height` offset. Default 0 (no solid). */
  heightM?: number;
  /** Factor on the height. Default 1. */
  heightScale?: number;
  /** How far the solid reaches under its base point, metres (a base on a slope, a base sunk into the ground). Default 0. */
  belowM?: number;
  /**
   * Which way the solid stands: `'y'` along +y (a flat world), `'radial'` away from the centre the index is given (a
   * sphere). Default `'y'`.
   */
  up?: 'y' | 'radial';
  /** An upright turned box instead of a cylinder. */
  box?: InstanceSolidBox;
  /** Instances whose radius (a box: its smaller half extent) is below this are skipped, metres. Default 0: only a radius of 0 is. */
  minRadiusM?: number;
  /** Its top can be stood on. Default true. */
  standable?: boolean;
  /** It stops rays and a camera boom. Default true. */
  blocksSight?: boolean;
}

/**
 * An upright box read from an instance record. Its own +x axis is turned by `turn` about up the way a view's yaw turns
 * (`CollisionWorld.addBox`): to (cos turn, −sin turn) in the x, z of the local frame of up (`upFrame` of base, the
 * shaders' `localFrame`; the world's own axes for +y up). Within 1e-5 of −y, where that frame's axes are fixed, the
 * axis is that direction made square to up.
 */
export interface InstanceSolidBox {
  /** Float offset of the turn about up, radians. */
  turn: number;
  /** Float offset of the size along the box's own x. */
  sizeX: number;
  /** Float offset of the size along its own z; a value of 0 (or no offset) takes the size along x. */
  sizeZ?: number;
  /** Half extent = size × scale. Default 0.5 (the sizes are full widths). */
  scale?: number;
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
