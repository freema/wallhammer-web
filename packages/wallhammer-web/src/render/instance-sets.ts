// Instance sets: one mesh drawn many times, each copy with its own affine transform (3 × 4) and four free numbers
// (typically a tint and one more value), in one instanced draw per set. They cast shadows. For anything that moves
// in its own way (parts posed by the owner's code, spinning or swinging pieces) or for repeated props; `RigLayer`
// covers the fixed set of rig motions, `InstancedLayer` many static copies with culling.
//
// The owner writes a set's `data` (`writeInstance`, `pushInstance`) and `count`, and sets `dirty`; the layer uploads
// dirty sets at the start of the next frame (`Renderer.beforeFrame`) with `Device.writeBuffer` over the set's own
// array, so nothing is allocated per frame. The layer is a dynamic shadow caster: `shadowDirty()` tells the renderer
// whether a set that casts shadows changed since the layer was last drawn into the shadow map.
//
// Record layout (`INSTANCE_SET_FLOATS` = 16 floats): the 3 × 4 matrix as its four columns (linear part column by
// column, then the translation: 12 floats), then the four free numbers. The vertex include `INSTANCE_SET_GLSL`
// declares the attributes `i_m0`, `i_m1`, `i_m2`, `i_extra` and gives `instanceLinear()`, `instancePoint(p)`,
// `instanceNormal(n)`.

import type { MeshData, VertexLayout } from '../base/data.ts';
import type { Device, InstanceBuffer, Mesh } from '../gpu/index.ts';
import type { PointLightSet } from './point-lights.ts';
import { MeshLayer } from './renderer.ts';
import type { DrawContext, MeshLayerOptions, Renderer } from './renderer.ts';

/** Floats per instance record. */
export const INSTANCE_SET_FLOATS = 16;

/** Per-instance layout: three vec4 of matrix columns, then the free vec4. */
export const INSTANCE_SET_LAYOUT: VertexLayout = {
  stride: INSTANCE_SET_FLOATS * 4,
  attribs: [
    { name: 'i_m0', size: 4, type: 'f32', offset: 0 },
    { name: 'i_m1', size: 4, type: 'f32', offset: 16 },
    { name: 'i_m2', size: 4, type: 'f32', offset: 32 },
    { name: 'i_extra', size: 4, type: 'f32', offset: 48 },
  ],
};

/**
 * Attribute locations of the instance record, starting at `first` (after the mesh's own attributes), for the
 * material's `attribs`.
 */
export function instanceSetAttribs(first: number): Record<'i_m0' | 'i_m1' | 'i_m2' | 'i_extra', number> {
  return { i_m0: first, i_m1: first + 1, i_m2: first + 2, i_extra: first + 3 };
}

/** Vertex shader include: the instance attributes and the transform of a point and a normal. */
export const INSTANCE_SET_GLSL = /* glsl */ `
in vec4 i_m0;
in vec4 i_m1;
in vec4 i_m2;
in vec4 i_extra;
mat3 instanceLinear() { return mat3(i_m0.xyz, vec3(i_m0.w, i_m1.xy), vec3(i_m1.zw, i_m2.x)); }
vec3 instancePoint(vec3 p) { return instanceLinear() * p + i_m2.yzw; }
vec3 instanceNormal(vec3 n) {
  mat3 m = instanceLinear();
  // Cofactor matrix: the inverse transpose up to the determinant (normalised here, sign kept for mirrored copies).
  mat3 c = mat3(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1]));
  return normalize(c * n) * sign(dot(m[0], cross(m[1], m[2])));
}
`;

/**
 * One mesh and its instance records. Plain data owned by the caller; the layer reads it. Use few sets: each is a
 * draw call.
 */
export interface InstanceSet {
  /** For statistics and debugging. */
  readonly name?: string;
  /** The mesh in its own local coordinates. */
  readonly mesh: MeshData;
  readonly capacity: number;
  /** capacity × `INSTANCE_SET_FLOATS`. */
  readonly data: Float32Array;
  /** Records in use (the first `count`). */
  count: number;
  /** Set after changing `data` or `count`; the layer uploads the set and clears it. */
  dirty: boolean;
  /** Drawn into the shadow map. */
  castShadow: boolean;
  /** Drawn at all. A change counts as a change of the shadow. */
  visible: boolean;
}

/** A new, empty instance set. */
export function instanceSet(mesh: MeshData, capacity: number, o: { name?: string; castShadow?: boolean; visible?: boolean } = {}): InstanceSet {
  const cap = Math.max(0, Math.floor(capacity));
  const set: InstanceSet = {
    mesh,
    capacity: cap,
    data: new Float32Array(cap * INSTANCE_SET_FLOATS),
    count: 0,
    dirty: true,
    castShadow: o.castShadow ?? true,
    visible: o.visible ?? true,
  };
  return o.name === undefined ? set : { ...set, name: o.name };
}

/**
 * Writes record `index`: `m` holds 12 numbers, the linear part column by column (9) then the translation (3); then the
 * four free numbers. Does not change `count` or `dirty`.
 */
export function writeInstance(set: InstanceSet, index: number, m: ArrayLike<number>, a = 1, b = 1, c = 1, d = 0): void {
  const o = index * INSTANCE_SET_FLOATS;
  const out = set.data;
  for (let k = 0; k < 12; k++) out[o + k] = m[k]!;
  out[o + 12] = a;
  out[o + 13] = b;
  out[o + 14] = c;
  out[o + 15] = d;
}

/** Appends a record (`count` grows, `dirty` is set); returns its index, or −1 when the set is full. */
export function pushInstance(set: InstanceSet, m: ArrayLike<number>, a = 1, b = 1, c = 1, d = 0): number {
  if (set.count >= set.capacity) return -1;
  const i = set.count++;
  writeInstance(set, i, m, a, b, c, d);
  set.dirty = true;
  return i;
}

export interface InstanceSetLayerOptions extends Omit<MeshLayerOptions, 'mesh'> {
  /** Point lights: every draw sees the whole selection of the set (`PointLightSet.bindAll`). Default none. */
  lights?: PointLightSet | null;
}

interface Entry {
  set: InstanceSet;
  mesh: Mesh;
  instances: InstanceBuffer;
  /** `visible` at the last upload. */
  shown: boolean;
}

/**
 * Instance sets drawn with one material: one instanced draw per visible set in the colour pass and, for sets that
 * cast shadows, in the shadow pass. Not culled (sets are few). The material declares the instance attributes
 * (`INSTANCE_SET_GLSL`, `instanceSetAttribs`).
 */
export class InstanceSetLayer extends MeshLayer {
  /** Its casters move: drawn over the kept static shadow map. */
  readonly shadowCasters = 'dynamic' as const;
  /** Point lights for the colour pass. */
  lights: PointLightSet | null;
  /** Triangles of all visible instances after the last upload. */
  triangles = 0;

  private readonly entries: Entry[] = [];
  private readonly renderer: Renderer;
  private readonly device: Device;
  private shadowChanged = true;
  private readonly hook: () => void;

  constructor(renderer: Renderer, o: InstanceSetLayerOptions) {
    super(o);
    this.renderer = renderer;
    this.device = renderer.device;
    this.lights = o.lights ?? null;
    this.hook = () => this.upload();
    renderer.beforeFrame.push(this.hook);
  }

  /** The sets in the order they were added. */
  get sets(): readonly InstanceSet[] {
    const out: InstanceSet[] = [];
    for (const e of this.entries) out.push(e.set);
    return out;
  }

  /** Adds a set (uploads its buffer). Empty meshes and sets without capacity are ignored. */
  add(set: InstanceSet): void {
    if (set.mesh.count === 0 || set.capacity === 0) return;
    const instances = this.renderer.createInstances({ layout: INSTANCE_SET_LAYOUT, data: set.data });
    const mesh = this.renderer.createMesh(set.mesh, this.material, instances);
    mesh.instances = Math.min(set.count, set.capacity);
    set.dirty = false;
    this.entries.push({ set, mesh, instances, shown: set.visible });
    if (set.castShadow) this.shadowChanged = true;
  }

  /** Takes a set out and deletes its GPU objects. Returns whether it was there. */
  remove(set: InstanceSet): boolean {
    const i = this.entries.findIndex((e) => e.set === set);
    if (i < 0) return false;
    const e = this.entries[i]!;
    this.entries.splice(i, 1);
    this.device.deleteMesh(e.mesh);
    this.device.deleteInstances(e.instances);
    if (set.castShadow) this.shadowChanged = true;
    return true;
  }

  /** Stops the per-frame upload hook (call when the layer is dropped for good). */
  dispose(): void {
    const i = this.renderer.beforeFrame.indexOf(this.hook);
    if (i >= 0) this.renderer.beforeFrame.splice(i, 1);
  }

  /** Uploads the dirty sets. Runs at the start of every frame; call it yourself only to upload earlier. */
  upload(): void {
    let tris = 0;
    for (const e of this.entries) {
      const s = e.set;
      if (s.dirty) {
        const n = Math.min(s.count, s.capacity);
        this.device.writeBuffer(e.instances.buffer, s.data, n * INSTANCE_SET_FLOATS);
        e.mesh.instances = n;
        s.dirty = false;
        if (s.castShadow && s.visible) this.shadowChanged = true;
      }
      if (s.visible !== e.shown) {
        e.shown = s.visible;
        if (s.castShadow) this.shadowChanged = true;
      }
      if (s.visible) tris += e.mesh.triangles * e.mesh.instances;
    }
    this.triangles = tris;
  }

  /** True when a shadow-casting set changed since the layer was last drawn into the shadow map. */
  shadowDirty(): boolean {
    return this.shadowChanged;
  }

  override draw(ctx: DrawContext): void {
    const shadow = ctx.pass === 'shadow';
    if (shadow) this.shadowChanged = false;
    let program = null;
    for (const e of this.entries) {
      const s = e.set;
      // A mesh with 0 instances would be drawn once without instancing: skip empty sets.
      if (!s.visible || e.mesh.instances <= 0 || (shadow && !s.castShadow)) continue;
      if (!program) {
        program = this.begin(ctx);
        if (!program) return;
        if (ctx.pass === 'color' && this.lights) this.lights.bindAll(program);
      }
      ctx.device.draw(e.mesh);
      ctx.count(e.mesh.triangles * e.mesh.instances);
    }
  }
}
