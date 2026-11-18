// The figures as an image: a robed shape with a hood and a lantern, drawn instanced, plus a soft contact shadow.
// The simulation decides where they are; every frame the extraction hook packs the interpolated transforms into the
// instance buffer and this layer uploads it once. Figures do not cast into the shadow map (it is cached), they
// receive the shadows of the stones and stand on a contact shadow of their own.

import type { InstanceData, MaterialDesc, MeshData, VertexLayout } from 'wallhammer-web/base';
import type { HeightField } from 'wallhammer-web/gen-core';
import type { InstanceBuffer, Mesh } from 'wallhammer-web/gpu';
import type { DrawContext, Layer, Material, Renderer } from 'wallhammer-web/render';
import { TRANSFORM_STRIDE } from 'wallhammer-web/sim';
import type { Movers } from 'wallhammer-web/sim';

const FIGURE_LAYOUT: VertexLayout = {
  stride: 28,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
    { name: 'a_part', size: 1, type: 'f32', offset: 24 },
  ],
};
/** One figure: x, y, z, walk phase | direction x, direction z, robe colour row, speed. */
const INSTANCE_LAYOUT: VertexLayout = {
  stride: 32,
  attribs: [
    { name: 'i_pos', size: 4, type: 'f32', offset: 0 },
    { name: 'i_dir', size: 4, type: 'f32', offset: 16 },
  ],
};
const ATTRIBS = { a_pos: 0, a_normal: 1, a_part: 2, i_pos: 3, i_dir: 4 } as const;
const MAX_FIGURES = 256;

/** Robe, hood and a lantern held out to the right. Local axes: x right, y up, z forward; feet at the origin. */
function figureMesh(): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const quad = (p: number[][], part: number): void => {
    const [a, b, , d] = p as [number[], number[], number[], number[]];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    const base = v.length / 7;
    for (const q of p) v.push(q[0]!, q[1]!, q[2]!, n[0]! / l, n[1]! / l, n[2]! / l, part);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // A frustum of `sides` faces between two rings (radius, height), optionally squashed front to back.
  const frustum = (r0: number, y0: number, r1: number, y1: number, sides: number, part: number, depth = 1, cap = false): void => {
    const ring = (r: number, y: number): number[][] =>
      Array.from({ length: sides }, (_, i) => {
        const a = ((i + 0.5) / sides) * Math.PI * 2;
        return [Math.cos(a) * r, y, Math.sin(a) * r * depth];
      });
    const lo = ring(r0, y0);
    const hi = ring(r1, y1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      quad([lo[j]!, lo[i]!, hi[i]!, hi[j]!], part);
    }
    if (cap) for (let i = 1; i + 1 < sides; i += 2) quad([hi[0]!, hi[i]!, hi[i + 1]!, hi[Math.min(i + 2, sides - 1)]!], part);
  };
  frustum(0.34, 0, 0.27, 0.7, 8, 0, 0.8);
  frustum(0.27, 0.7, 0.2, 1.4, 8, 0, 0.75);
  frustum(0.2, 1.4, 0.15, 1.5, 8, 0, 0.8);
  // Hood: a short tapered cap.
  frustum(0.15, 1.5, 0.17, 1.62, 8, 1, 1);
  frustum(0.17, 1.62, 0.04, 1.86, 8, 1, 1, true);
  // Lantern on a short pole in the right hand.
  const box = (cx: number, cy: number, cz: number, h: number, part: number): void => {
    const x0 = cx - h, x1 = cx + h, y0 = cy - h, y1 = cy + h, z0 = cz - h, z1 = cz + h;
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], part);
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], part);
    quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], part);
    quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], part);
    quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], part);
  };
  box(0.36, 0.95, 0.22, 0.09, 2);
  return { layout: FIGURE_LAYOUT, vertices: new Float32Array(v), indices: new Uint32Array(idx), count: idx.length };
}

/** A flat square under each figure; the shader turns it into a soft round shadow. */
function shadowMesh(): MeshData {
  const s = 0.75;
  const v = [-s, 0.03, -s, 0, 1, 0, 3, s, 0.03, -s, 0, 1, 0, 3, s, 0.03, s, 0, 1, 0, 3, -s, 0.03, s, 0, 1, 0, 3];
  return { layout: FIGURE_LAYOUT, vertices: new Float32Array(v), indices: new Uint32Array([0, 2, 1, 0, 3, 2]), count: 6 };
}

const PLACE = /* glsl */ `
in vec3 a_pos;
in vec3 a_normal;
in float a_part;
in vec4 i_pos;  // xyz feet, w walk phase (metres along the path)
in vec4 i_dir;  // xz heading, z robe colour row, w speed m/s
vec3 place(vec3 p, out vec3 n) {
  vec3 fwd = vec3(i_dir.x, 0.0, i_dir.y);
  vec3 right = vec3(-i_dir.y, 0.0, i_dir.x);
  float walk = min(i_dir.w, 1.2);
  // A slight sway and bob while walking, still when standing.
  float ph = i_pos.w * 4.4;
  float bob = abs(sin(ph)) * 0.035 * walk;
  float lean = sin(ph) * 0.025 * walk * a_pos.y;
  n = right * a_normal.x + vec3(0.0, a_normal.y, 0.0) + fwd * a_normal.z;
  return i_pos.xyz + right * (p.x + lean) + vec3(0.0, p.y + bob * step(0.5, p.y), 0.0) + fwd * p.z;
}`;

const FIGURE_VS = /* glsl */ `#include <header>
${PLACE}
out vec3 v_world;
out vec3 v_normal;
out float v_part;
out float v_row;
out float v_up;
void main() {
  vec3 n;
  v_world = place(a_pos, n);
  v_normal = n;
  v_part = a_part;
  v_row = i_dir.z;
  v_up = a_pos.y;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const FIGURE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
// Muted robe colours; the procession wears the first.
const vec3 ROBES[6] = vec3[6](vec3(0.6, 0.56, 0.48), vec3(0.55, 0.24, 0.18), vec3(0.25, 0.3, 0.45), vec3(0.58, 0.47, 0.3), vec3(0.33, 0.4, 0.3), vec3(0.62, 0.5, 0.36));
in vec3 v_world;
in vec3 v_normal;
in float v_part;
in float v_row;
in float v_up;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 0.6);
  vec3 robe = ROBES[int(v_row + 0.5)];
  vec3 col = v_part < 0.5 ? robe * mix(0.7, 1.0, smoothstep(0.0, 0.5, v_up)) : v_part < 1.5 ? robe * 0.78 : vec3(0.32, 0.27, 0.2);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  // The lantern burns: faintly by day, brightly once the glow of dusk wakes up.
  if (v_part > 1.5) c = mix(c, vec3(1.0, 0.78, 0.42) * (1.1 + 0.6 * u_glow.w), 0.35 + 0.65 * u_glow.w);
  // The lantern's warm light on the robe at night.
  else c += u_glow.rgb * u_glow.w * 0.22 * smoothstep(1.4, 0.7, v_up);
  o_color = vec4(applyFog(c, v_world), 1.0);
}`;

const SHADOW_VS = /* glsl */ `#include <header>
${PLACE}
out vec2 v_local;
out vec3 v_world;
void main() {
  vec3 n;
  v_local = a_pos.xz / 0.75;
  v_world = place(a_pos, n);
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const SHADOW_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
in vec2 v_local;
in vec3 v_world;
out vec4 o_color;
void main() {
  float d = length(v_local * vec2(1.0, 1.15));
  float a = 0.42 * (1.0 - smoothstep(0.35, 1.0, d));
  o_color = vec4(0.0, 0.0, 0.0, a);
}`;

const FIGURE_MATERIAL: MaterialDesc = { name: 'figure', attribs: ATTRIBS, passes: { color: { vs: FIGURE_VS, fs: FIGURE_FS } } };
const CONTACT_MATERIAL: MaterialDesc = {
  name: 'figure-contact',
  attribs: ATTRIBS,
  passes: { color: { vs: SHADOW_VS, fs: SHADOW_FS } },
  state: { color: { depthWrite: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, polygonOffset: [-1, -2] } },
};

export class FigureLayer implements Layer {
  private readonly data = new Float32Array(MAX_FIGURES * 8);
  private readonly transforms = new Float32Array(MAX_FIGURES * TRANSFORM_STRIDE);
  private readonly instances: InstanceBuffer;
  private readonly body: Mesh;
  private readonly contact: Mesh;
  private readonly bodyMaterial: Material;
  private readonly contactMaterial: Material;
  private count = 0;
  private uploaded = false;

  constructor(renderer: Renderer) {
    this.bodyMaterial = renderer.material(FIGURE_MATERIAL);
    this.contactMaterial = renderer.material(CONTACT_MATERIAL);
    const empty: InstanceData = { layout: INSTANCE_LAYOUT, data: this.data };
    this.instances = renderer.createInstances(empty);
    this.body = renderer.createMesh(figureMesh(), this.bodyMaterial, this.instances);
    this.contact = renderer.createMesh(shadowMesh(), this.contactMaterial, this.instances);
  }

  /** Extraction: interpolated transforms from the movers, feet on the ground, a robe colour row (0–5) per row. */
  update(movers: Movers, alpha: number, ground: HeightField, robeOf: (row: number) => number): void {
    const n = Math.min(MAX_FIGURES, movers.extract(alpha, this.transforms));
    for (let i = 0; i < n; i++) {
      const t = i * TRANSFORM_STRIDE;
      const o = i * 8;
      const x = this.transforms[t]!;
      const z = this.transforms[t + 1]!;
      this.data[o] = x;
      this.data[o + 1] = ground.heightAt(x, z);
      this.data[o + 2] = z;
      this.data[o + 3] = this.transforms[t + 4]!;
      this.data[o + 4] = this.transforms[t + 2]!;
      this.data[o + 5] = this.transforms[t + 3]!;
      this.data[o + 6] = robeOf(i);
      this.data[o + 7] = this.transforms[t + 5]!;
    }
    this.count = n;
    this.uploaded = false;
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color' || this.count === 0) return;
    if (!this.uploaded) {
      ctx.device.writeBuffer(this.instances.buffer, this.data, this.count * 8);
      this.body.instances = this.count;
      this.contact.instances = this.count;
      this.uploaded = true;
    }
    for (const [material, mesh] of [[this.contactMaterial, this.contact], [this.bodyMaterial, this.body]] as const) {
      const program = material.program('color')!;
      ctx.device.setState(material.state.color ?? {});
      ctx.device.use(program);
      ctx.device.draw(mesh);
      ctx.count(mesh.triangles * mesh.instances);
    }
  }
}
