// The layer that draws a contact trail (`ContactTrail` of `core`): every mark of the ring is one instance of a quad
// laid in the surface at its centre, turned to its heading and sized by its width and length, in one draw. The ring's
// numbers are the instance buffer as they are; only the span changed since the last frame is uploaded, before the
// frame. The vertex shader fades a mark by its age against `time` (`contactTrailFade`, the GLSL twin of `core`) and
// drops faded marks, so nothing is written per frame for marks that only grow older.
//
// How a mark looks is the game's: `contactTrailMaterial({ shade })` takes a GLSL function `trailShade` that returns the
// display colour and the coverage of a point of a mark (its place in the mark, its kind, a number of its own, the
// world point and the surface normal); the layer multiplies the coverage by the fade and blends it over what is
// below without writing depth. The default shade is a soft dark oval lit by the environment.

import type { MaterialDesc, MeshData, VertexLayout } from '../base/index.ts';
import { CONTACT_TRAIL_FLOATS, CONTACT_TRAIL_GLSL } from '../core/index.ts';
import type { ContactTrail } from '../core/index.ts';
import type { InstanceBuffer, Program } from '../gpu/index.ts';
import { MeshLayer } from './renderer.ts';
import type { DrawContext, Material, Renderer } from './renderer.ts';

/** Attribute locations of a contact trail material: the quad's corner, then the mark's three instance vectors. */
export const CONTACT_TRAIL_ATTRIBS = { a_corner: 0, i_place: 1, i_normal: 2, i_size: 3 } as const;

const TRAIL_LAYOUT: VertexLayout = {
  stride: CONTACT_TRAIL_FLOATS * 4,
  attribs: [
    { name: 'i_place', size: 4, type: 'f32', offset: 0 },
    { name: 'i_normal', size: 4, type: 'f32', offset: 16 },
    { name: 'i_size', size: 4, type: 'f32', offset: 32 },
  ],
};

const QUAD: MeshData = {
  layout: { stride: 8, attribs: [{ name: 'a_corner', size: 2, type: 'f32', offset: 0 }] },
  vertices: new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  count: 6,
};

const TRAIL_VS = /* glsl */ `#include <header>
${CONTACT_TRAIL_GLSL}
in vec2 a_corner;
in vec4 i_place;   // centre, time laid
in vec4 i_normal;  // surface normal, heading (radians, 0 toward -z)
in vec4 i_size;    // width, length, kind, life
uniform float u_trailTime;
uniform float u_trailLift;
out vec3 v_world;
out vec2 v_uv;
out vec3 v_normal;
flat out float v_kind;
flat out float v_seed;
flat out float v_fade;
void main() {
  float fade = contactTrailFade(u_trailTime - i_place.w, i_size.w);
  v_uv = a_corner + 0.5;
  v_kind = i_size.z;
  v_seed = fract(float(gl_InstanceID) * 0.6180339 + 0.37);
  v_fade = fade;
  v_normal = vec3(0.0, 1.0, 0.0);
  v_world = i_place.xyz;
  if (fade <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec3 n = normalize(i_normal.xyz);
  // The heading's direction laid into the surface; across is to its right.
  vec3 d = vec3(-sin(i_normal.w), 0.0, -cos(i_normal.w));
  vec3 f = d - n * dot(d, n);
  float fl = length(f);
  f = fl > 1e-4 ? f / fl : normalize(cross(vec3(1.0, 0.0, 0.0), n));
  vec3 r = cross(f, n);
  vec3 w = i_place.xyz + n * u_trailLift + r * (a_corner.x * i_size.x) + f * (a_corner.y * i_size.y);
  v_world = w;
  v_normal = n;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

/** The default look of a mark: a soft dark oval, lit by the environment. */
export const CONTACT_TRAIL_DEFAULT_SHADE = /* glsl */ `
vec4 trailShade(vec2 uv, float kind, float seed, vec3 world, vec3 n) {
  float a = 1.0 - smoothstep(0.6, 1.0, length(uv * 2.0 - 1.0));
  vec3 lit = vec3(0.05, 0.045, 0.04) * u_warmTint.rgb * lightOn(n, 1.0, 1.0);
  return vec4(applyFog(toDisplay(lit), world), 0.55 * a);
}
`;

/** Options of `contactTrailMaterial`. */
export interface ContactTrailMaterialOptions {
  /** Name of the material (programs are cached by it). Default `'contact-trail'`. */
  name?: string;
  /**
   * GLSL defining `vec4 trailShade(vec2 uv, float kind, float seed, vec3 world, vec3 n)`: the display colour and the
   * coverage 0–1 of a point of a mark. `uv` is 0–1 across (left to right) and along (back to front), `kind` the
   * mark's kind, `seed` a number 0–1 of the mark's own, `world` the point and `n` the surface's normal. Default
   * `CONTACT_TRAIL_DEFAULT_SHADE`.
   */
  shade?: string;
  /** Shader includes the shade needs, in order, after the header. Default `['noise', 'lighting']`. */
  includes?: readonly string[];
}

/** A material for `ContactTrailLayer` with the game's look of a mark. Blended, no depth written, no shadow pass. */
export function contactTrailMaterial(o: ContactTrailMaterialOptions = {}): MaterialDesc {
  const includes = (o.includes ?? ['noise', 'lighting']).map((n) => `#include <${n}>`).join('\n');
  const fs = /* glsl */ `#include <header>
${includes}
in vec3 v_world;
in vec2 v_uv;
in vec3 v_normal;
flat in float v_kind;
flat in float v_seed;
flat in float v_fade;
out vec4 o_color;
${o.shade ?? CONTACT_TRAIL_DEFAULT_SHADE}
void main() {
  vec4 c = trailShade(v_uv, v_kind, v_seed, v_world, normalize(v_normal));
  float a = clamp(c.a, 0.0, 1.0) * v_fade;
  if (a < 0.004) discard;
  o_color = vec4(c.rgb, a);
}`;
  return {
    name: o.name ?? 'contact-trail',
    attribs: CONTACT_TRAIL_ATTRIBS,
    passes: { color: { vs: TRAIL_VS, fs } },
    state: { color: { cullBack: false, depthWrite: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha', srcAlpha: 'zero', dstAlpha: 'one' }, polygonOffset: [-1, -4] } },
  };
}

/** Options of `ContactTrailLayer`. */
export interface ContactTrailLayerOptions {
  /** A material made by `contactTrailMaterial` (default: one with the default shade). */
  material?: Material;
  /** Name for profiles and statistics. */
  name?: string;
  /** How far above the surface the marks lie, metres (against flicker; the material also offsets its depth). Default 0.01. */
  lift?: number;
}

/** Draws a `ContactTrail` in one instanced draw, fading the marks by their age against `time`. Add it after the ground. */
export class ContactTrailLayer extends MeshLayer {
  readonly trail: ContactTrail;
  /** The time the marks are drawn at, in the clock they were laid in (seconds). The game sets it every frame. */
  time = 0;
  /** How far above the surface the marks lie, metres. */
  lift: number;
  private readonly renderer: Renderer;
  private readonly instances: InstanceBuffer;
  private readonly hook: () => void;

  constructor(renderer: Renderer, trail: ContactTrail, o: ContactTrailLayerOptions = {}) {
    const material = o.material ?? renderer.material(contactTrailMaterial());
    // The draw's uniforms come from the layer, which exists only after `super`.
    const self: { layer: ContactTrailLayer | null } = { layer: null };
    super({
      material,
      ...(o.name !== undefined ? { name: o.name } : {}),
      bind: (program: Program) => {
        program.float('u_trailTime', self.layer!.time);
        program.float('u_trailLift', self.layer!.lift);
      },
    });
    self.layer = this;
    this.renderer = renderer;
    this.trail = trail;
    this.lift = o.lift ?? 0.01;
    this.instances = renderer.createInstances({ layout: TRAIL_LAYOUT, data: trail.data });
    trail.clean();
    this.mesh = renderer.createMesh(QUAD, material, this.instances);
    this.mesh.instances = trail.count;
    this.hook = () => this.upload();
    renderer.beforeFrame.push(this.hook);
  }

  /** Uploads the marks laid since the last frame. Runs at the start of every frame. */
  upload(): void {
    const t = this.trail;
    if (t.dirtyFrom !== t.dirtyTo) {
      this.renderer.device.writeBuffer(this.instances.buffer, t.data, (t.dirtyTo - t.dirtyFrom) * CONTACT_TRAIL_FLOATS, t.dirtyFrom * CONTACT_TRAIL_FLOATS * 4, t.dirtyFrom * CONTACT_TRAIL_FLOATS);
      t.clean();
    }
    if (this.mesh) this.mesh.instances = t.count;
  }

  override draw(ctx: DrawContext): void {
    const m = this.mesh;
    if (!m || m.instances <= 0 || !this.begin(ctx)) return;
    ctx.device.draw(m);
    ctx.count(m.triangles * m.instances);
  }

  /** Stops the per-frame upload and deletes the GPU objects (call when the layer is dropped for good). */
  dispose(): void {
    const i = this.renderer.beforeFrame.indexOf(this.hook);
    if (i >= 0) this.renderer.beforeFrame.splice(i, 1);
    if (this.mesh) this.renderer.device.deleteMesh(this.mesh);
    this.renderer.device.deleteInstances(this.instances);
    this.mesh = null;
  }
}
