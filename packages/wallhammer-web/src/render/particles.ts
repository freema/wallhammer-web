// Particles from looping sources. Each particle is one instance of a camera-facing quad whose whole life is computed
// in the vertex shader from the animation time (`u_time.x` of the Frame block): nothing is simulated or allocated per
// frame, the instance buffers are written once when the sources are set, and pausing the clock freezes them. A source
// owns `count` particles born one after the other over `life` seconds, looping forever.
//
// Two draws at most: the sources with `blend: 'blend'` (alpha over the scene), then those with `blend: 'add'`. Both
// test depth and write none. The total number of particles has a fixed budget; sources beyond it lose particles
// (`counts.dropped`).
//
// Two shapes: `'soft'` is a puff of noise, lit like a surface facing up and toward the eye, turned a little per
// particle; `'core'` is a bright core that fades to the rim, unlit, with a fast flicker.
//
// `TransientLayer` dust is kept apart: its puffs are one-shot events at absolute clock times that come and go with
// batches (the mesh is rebuilt then), while these sources loop with no start or end.

import type { MaterialDesc, MeshData, VertexLayout } from '../base/index.ts';
import type { InstanceBuffer, Mesh, Program } from '../gpu/index.ts';
import type { Layer } from './renderer.ts';
import { MeshLayer } from './renderer.ts';
import type { DrawContext, Renderer } from './renderer.ts';

/** A looping particle source. Plain data, read when the sources are set. */
export interface ParticleSource {
  /** Centre of the birth disc, in the coordinates the renderer draws in. */
  position: readonly [number, number, number];
  /** Particles alive at once (the source's share of the budget). */
  count: number;
  /** Seconds a particle lives. */
  life: number;
  /** Size in metres (quad edge) at birth and at death. */
  size: readonly [number, number];
  /** Initial upward speed, m/s. */
  rise: number;
  /** Radius of the birth disc (m) and the horizontal spread speed (m/s). */
  spread: readonly [number, number];
  /** Downward acceleration, m/s². Default 0. */
  gravity?: number;
  /** Share of the wind (`u_wind.xy`) that carries the particle, 0–1. Default 1. */
  wind?: number;
  /** Linear colour and opacity at birth and at death (rgb may exceed 1 for added light). */
  colorStart: readonly [number, number, number, number];
  colorEnd: readonly [number, number, number, number];
  /** `'blend'` (default): alpha over the scene. `'add'`: light added onto it. */
  blend?: 'blend' | 'add';
  /** `'soft'` (default): a lit noise puff. `'core'`: a bright core. */
  shape?: 'soft' | 'core';
  /** Gain group 0–3 (default 0): opacity is multiplied by `ParticleLayer.gains[group]` at draw time. */
  group?: number;
}

export interface ParticleCounts {
  sources: number;
  particles: number;
  /** Particles left out because the budget was full. */
  dropped: number;
}

export interface ParticleLayerOptions {
  /** Most particles over all sources. Default 4096. */
  budget?: number;
  /** Layer name for profiles and statistics. */
  name?: string;
}

/** Floats per particle record. */
const PARTICLE_FLOATS = 24;

const PARTICLE_ATTRIBS = { a_corner: 0, i_origin: 1, i_life: 2, i_motion: 3, i_c0: 4, i_c1: 5, i_kind: 6 } as const;

const PARTICLE_LAYOUT: VertexLayout = {
  stride: PARTICLE_FLOATS * 4,
  attribs: [
    { name: 'i_origin', size: 4, type: 'f32', offset: 0 },
    { name: 'i_life', size: 4, type: 'f32', offset: 16 },
    { name: 'i_motion', size: 4, type: 'f32', offset: 32 },
    { name: 'i_c0', size: 4, type: 'f32', offset: 48 },
    { name: 'i_c1', size: 4, type: 'f32', offset: 64 },
    { name: 'i_kind', size: 4, type: 'f32', offset: 80 },
  ],
};

const QUAD: MeshData = {
  layout: { stride: 8, attribs: [{ name: 'a_corner', size: 2, type: 'f32', offset: 0 }] },
  vertices: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  count: 6,
};

const PARTICLE_VS = /* glsl */ `#include <header>
#include <noise>
in vec2 a_corner;
in vec4 i_origin;  // xyz source, w phase 0–1
in vec4 i_life;    // x life s, y size at birth, z size at death, w rise m/s
in vec4 i_motion;  // x birth disc radius, y spread speed, z gravity, w wind share
in vec4 i_c0;      // colour and opacity at birth
in vec4 i_c1;      // at death
in vec4 i_kind;    // x shape (0 soft, 1 core), y seed, z gain group, w unused
uniform vec4 u_particleGain;
out vec4 v_color;
out vec2 v_uv;
out float v_shape;
out float v_seed;
float h1(float a, float b) { return hash2(ivec2(int(a), int(b)), 77u); }
void main() {
  float life = max(i_life.x, 0.05);
  float cyc = u_time.x / life + i_origin.w;
  float t = fract(cyc);
  float k = floor(cyc);
  float seed = i_kind.y;
  // Random per particle and per life: birth point and drift.
  float r1 = h1(seed, k), r2 = h1(seed + 101.0, k), r3 = h1(seed + 211.0, k), r4 = h1(seed + 307.0, k);
  float age = t * life;
  float ang = r1 * 6.2831853;
  float rad = sqrt(r2) * i_motion.x;
  vec3 p = i_origin.xyz + vec3(cos(ang) * rad, 0.0, sin(ang) * rad);
  float ang2 = r3 * 6.2831853;
  vec3 v = vec3(cos(ang2) * i_motion.y * (0.4 + 0.6 * r4), i_life.w * (0.75 + 0.5 * r4), sin(ang2) * i_motion.y * (0.4 + 0.6 * r4));
  p += v * age;
  p.y -= 0.5 * i_motion.z * age * age;
  // The wind carries a particle more the older it gets, with a slow curl.
  p.xz += u_wind.xy * i_motion.w * 1.6 * age * (0.3 + 0.7 * t);
  p.xz += vec2(sin(age * 1.3 + seed), cos(age * 1.1 + seed * 1.7)) * i_motion.w * 0.25 * t;
  float size = mix(i_life.y, i_life.z, t);
  float spin = (r1 - 0.5) * 2.0 + age * (r2 - 0.5);
  float cs = cos(spin), sn = sin(spin);
  vec2 c = a_corner;
  if (i_kind.x < 0.5) c = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  vec3 w = p + (u_camRight.xyz * c.x + u_camUp.xyz * c.y) * size * 0.5;
  float fade = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.65, 1.0, t));
  int g = int(i_kind.z);
  float gain = g == 0 ? u_particleGain.x : g == 1 ? u_particleGain.y : g == 2 ? u_particleGain.z : u_particleGain.w;
  vec4 col = mix(i_c0, i_c1, t);
  col.a *= fade * gain;
  v_color = col;
  v_uv = a_corner;
  v_shape = i_kind.x;
  v_seed = seed + k * 13.0;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

function particleFs(add: boolean): string {
  return /* glsl */ `#include <header>
#include <noise>
#include <lighting>
in vec4 v_color;
in vec2 v_uv;
in float v_shape;
in float v_seed;
out vec4 o_color;
void main() {
  float r = length(v_uv);
  if (r > 1.0) discard;
  vec4 c = v_color;
  vec3 rgb;
  float a;
  if (v_shape < 0.5) {
    // Soft puff lit by the sky and the sun, darker underneath.
    float puff = vnoise(v_uv * 2.2 + v_seed, 61u) * 0.6 + vnoise(v_uv * 5.0 + v_seed * 0.3, 62u) * 0.4;
    a = c.a * smoothstep(1.0, 0.25, r) * (0.55 + 0.6 * puff);
    rgb = toDisplay(c.rgb * u_warmTint.rgb * lightOn(normalize(vec3(v_uv.x, 0.6 + v_uv.y, 0.5)), 0.85, 1.0));
  } else {
    // Bright core with a fast flicker.
    float core = smoothstep(1.0, 0.0, r);
    rgb = c.rgb * (0.75 + 0.25 * vnoise(vec2(u_time.x * 9.0, v_seed), 63u));
    a = c.a * core * core;
  }
  ${add ? 'o_color = vec4(rgb * a, 1.0);' : 'o_color = vec4(rgb, clamp(a, 0.0, 1.0));'}
}`;
}

const PARTICLE_BLEND_MATERIAL: MaterialDesc = {
  name: 'particles-blend',
  attribs: PARTICLE_ATTRIBS,
  passes: { color: { vs: PARTICLE_VS, fs: particleFs(false) } },
  state: { color: { depthWrite: false, cullBack: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha', srcAlpha: 'one', dstAlpha: 'one-minus-src-alpha' } } },
};

const PARTICLE_ADD_MATERIAL: MaterialDesc = {
  name: 'particles-add',
  attribs: PARTICLE_ATTRIBS,
  passes: { color: { vs: PARTICLE_VS, fs: particleFs(true) } },
  state: { color: { depthWrite: false, cullBack: false, blend: { src: 'one', dst: 'one', srcAlpha: 'zero', dstAlpha: 'one' } } },
};

/**
 * Looping particle sources in two draws (blended, then added). Add it after the opaque layers. The materials read
 * `u_time`, `u_wind`, `u_warmTint` and the `lighting` include of the environment.
 */
export class ParticleLayer implements Layer {
  name?: string;
  readonly budget: number;
  /** Opacity gain per group (`ParticleSource.group`), 1 by default. Change at run time. */
  readonly gains = new Float32Array([1, 1, 1, 1]);
  /** What the last `setSources` packed. */
  counts: ParticleCounts = { sources: 0, particles: 0, dropped: 0 };

  private readonly renderer: Renderer;
  private readonly layers: [ParticleDraw, ParticleDraw];
  /** Instance buffer of each mesh the layer made, deleted with it. */
  private readonly owned = new Map<Mesh, InstanceBuffer>();

  constructor(renderer: Renderer, sources: readonly ParticleSource[] = [], o: ParticleLayerOptions = {}) {
    this.renderer = renderer;
    this.budget = Math.max(0, Math.floor(o.budget ?? 4096));
    if (o.name !== undefined) this.name = o.name;
    const bind = (program: Program): void => program.vec4v('u_particleGain', this.gains);
    this.layers = [
      new ParticleDraw({ material: renderer.material(PARTICLE_BLEND_MATERIAL), bind }),
      new ParticleDraw({ material: renderer.material(PARTICLE_ADD_MATERIAL), bind }),
    ];
    this.setSources(sources);
  }

  /** Replaces the sources: packs them within the budget and uploads the instance buffers. */
  setSources(sources: readonly ParticleSource[]): void {
    const blend: number[] = [];
    const add: number[] = [];
    let used = 0;
    let dropped = 0;
    let seed = 1;
    for (const s of sources) {
      const out = s.blend === 'add' ? add : blend;
      const shape = s.shape === 'core' ? 1 : 0;
      const n = Math.max(0, Math.floor(s.count));
      for (let i = 0; i < n; i++) {
        if (used >= this.budget) {
          dropped++;
          continue;
        }
        used++;
        seed++;
        out.push(
          s.position[0], s.position[1], s.position[2], i / n,
          s.life, s.size[0], s.size[1], s.rise,
          s.spread[0], s.spread[1], s.gravity ?? 0, s.wind ?? 1,
          s.colorStart[0], s.colorStart[1], s.colorStart[2], s.colorStart[3],
          s.colorEnd[0], s.colorEnd[1], s.colorEnd[2], s.colorEnd[3],
          shape, seed * 7 + 3, Math.max(0, Math.min(3, Math.floor(s.group ?? 0))), 0,
        );
      }
    }
    this.upload(this.layers[0], blend);
    this.upload(this.layers[1], add);
    this.counts = { sources: sources.length, particles: used, dropped };
  }

  private upload(layer: ParticleDraw, records: number[]): void {
    const old = layer.mesh;
    if (records.length === 0) layer.mesh = null;
    else {
      const instances = this.renderer.createInstances({ layout: PARTICLE_LAYOUT, data: new Float32Array(records) });
      const mesh = this.renderer.createMesh(QUAD, layer.material, instances);
      mesh.instances = records.length / PARTICLE_FLOATS;
      layer.mesh = mesh;
      this.owned.set(mesh, instances);
    }
    if (old) {
      this.renderer.device.deleteMesh(old);
      const inst = this.owned.get(old);
      if (inst) this.renderer.device.deleteInstances(inst);
      this.owned.delete(old);
    }
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color') return;
    this.layers[0].draw(ctx);
    this.layers[1].draw(ctx);
  }
}

/** One of the two draws: counts every particle's triangles. */
class ParticleDraw extends MeshLayer {
  override draw(ctx: DrawContext): void {
    const m = this.mesh;
    if (!m || m.instances <= 0 || !this.begin(ctx)) return;
    ctx.device.draw(m);
    ctx.count(m.triangles * m.instances);
  }
}
