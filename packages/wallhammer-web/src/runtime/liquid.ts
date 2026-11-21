// The layers of a liquid below the level of a radial world (`LiquidSurface` of env): the near surface round the eye,
// the backdrop under the surface, the light shafts and the line across the lens.
//
// The near surface (`LiquidNearLayer`) is a grid of rings round the eye's foot, moved by the waves in its vertex
// shader (the caller's material) and drawn from its outer ring inward, so a near crest lies over the surface behind
// it; the caller's far surface leaves out its disc (`u_liquid.z`). The backdrop (`LiquidBackdropLayer`) stands at the
// distance where the liquid hides everything while the eye is under the surface, the light shafts
// (`LiquidShaftsLayer`) are added along every view ray then, and the line across the lens (`LiquidLensLayer`) splits
// the picture where the surface passes through the front of the lens. Every layer reads `surface.state`, so the page
// calls `surface.uniforms` before the frame and hands the result to the layers' `uniforms`.

import type { MaterialDesc, MeshData, Uniforms } from '../base/index.ts';
import type { Mesh } from '../gpu/index.ts';
import type { DrawContext, Layer, Material, Renderer } from '../render/index.ts';
import { MEDIUM_GLSL } from '../core/index.ts';
import { cloudVolumeDepthMap, liquidShaftsGlsl } from '../env/index.ts';
import type { LiquidShaftsOptions, LiquidSurface } from '../env/index.ts';

type V4 = [number, number, number, number];

/** Sets every uniform of a set on a program. */
function setAll(program: { set(name: string, v: Uniforms[string]): void }, u: Uniforms): void {
  for (const k in u) program.set(k, u[k]!);
}

/** Texture unit of the scene's depth (one the clouds' layers bind again for themselves). */
export const LIQUID_SCENE_UNIT = 11;

// --- The near surface ----------------------------------------------------------------------------------------------

/** Spokes of the grid of rings; the rings grow by the same share, so its cells stay about square. */
const SPOKES = 128;
const GROWTH = Math.exp((2 * Math.PI) / SPOKES);
/** Radius of the first ring in metres. */
const FIRST_RING_M = 0.3;

/** Options of a liquid layer. */
export interface LiquidLayerOptions {
  /** The layer's name (defaults `liquid-near`, `liquid-backdrop`, `liquid-shafts`, `liquid-lens`). */
  name?: string;
}

/**
 * The near surface (see the head of the file): drawn in the colour pass while `surface.state.nearM` is above 0.
 * `material` draws the grid: attribute `a_grid` (x the ring, y the spoke); the layer sets `u_liquidNear` (x the first
 * ring's radius, y the log of the rings' growth, z the spokes' angle), `u_morphEye` (xyz the eye in render space),
 * `u_liquidForward` (the view's forward axis), `u_liquidScene` and `u_liquidSceneMap` (the depth of the scene drawn so
 * far and its `cloudVolumeDepthMap`, while the eye is above the surface; map x 0 without it) and `uniforms`.
 */
export class LiquidNearLayer implements Layer {
  readonly name: string;
  /** The liquid's uniforms of the frame (`water` of `LiquidSurface.uniforms`); the page sets them every frame. */
  uniforms: Uniforms = {};
  /** False hides it. */
  enabled = true;
  private readonly material: Material;
  private readonly mesh: Mesh;
  private readonly triangles: number;
  private readonly renderer: Renderer;
  private readonly surface: LiquidSurface;

  constructor(renderer: Renderer, surface: LiquidSurface, material: MaterialDesc, options: LiquidLayerOptions = {}) {
    this.name = options.name ?? 'liquid-near';
    this.renderer = renderer;
    this.surface = surface;
    this.material = renderer.material(material);
    // Rings to a little beyond the near radius.
    const rings = Math.ceil(Math.log((1.05 * surface.nearM) / FIRST_RING_M) / Math.log(GROWTH)) + 1;
    const cols = SPOKES + 1;
    const verts = new Float32Array((rings + 1) * cols * 2);
    for (let j = 0; j <= rings; j++) {
      for (let i = 0; i < cols; i++) {
        verts[(j * cols + i) * 2] = j;
        verts[(j * cols + i) * 2 + 1] = i;
      }
    }
    // From the outermost ring inward: the eye stands over the grid's centre, so along every view ray a nearer ring is
    // a nearer part of the surface, and drawn later it lies over the farther parts (the grid writes no depth).
    const idx = new Uint16Array(rings * SPOKES * 6);
    let k = 0;
    for (let j = rings - 1; j >= 0; j--) {
      for (let i = 0; i < SPOKES; i++) {
        const a = j * cols + i;
        const b = a + cols;
        idx.set([a, b, a + 1, a + 1, b, b + 1], k);
        k += 6;
      }
    }
    const data: MeshData = { layout: { stride: 8, attribs: [{ name: 'a_grid', size: 2, type: 'f32', offset: 0 }] }, vertices: verts, indices: idx, count: idx.length };
    this.mesh = renderer.device.createMesh(data, { a_grid: 0 });
    this.triangles = idx.length / 3;
  }

  draw(ctx: DrawContext): void {
    const state = this.surface.state;
    if (!this.enabled || ctx.pass !== 'color' || state.nearM <= 0) return;
    const program = this.material.program('color');
    if (!program) return;
    const device = ctx.device;
    // The depth of the scene drawn so far, for the depth of the floor under the surface.
    const scene = state.aboveSurfaceM >= 0 ? device.sceneDepth() : null;
    const p = this.renderer.projection;
    const map = scene ? cloudVolumeDepthMap(device.depthMode, p.viewProj, p.logScale) : ([0, 0, 0, 0] as V4);
    device.setState(this.material.state.color!);
    device.use(program);
    device.texture(LIQUID_SCENE_UNIT, scene);
    program.set('u_liquidScene', { int: LIQUID_SCENE_UNIT });
    program.set('u_liquidSceneMap', { vec4: [map[0], map[1], map[2], map[3]] });
    const f = ctx.view.axes().forward;
    program.vec3('u_liquidForward', f[0], f[1], f[2]);
    const eye = ctx.view.cornerRays()[0]!.origin;
    program.set('u_morphEye', { vec4: [eye[0], eye[1], eye[2], 0] });
    program.set('u_liquidNear', { vec4: [FIRST_RING_M, Math.log(GROWTH), (2 * Math.PI) / SPOKES, 0] });
    setAll(program, this.uniforms);
    device.draw(this.mesh);
    ctx.count(this.triangles);
  }
}

// --- The backdrop under the surface --------------------------------------------------------------------------------

const BACKDROP_VS = /* glsl */ `#include <header>
in vec2 a_pos;
uniform vec3 u_cornerLB;
uniform vec3 u_cornerLT;
uniform vec3 u_cornerRB;
uniform vec3 u_cornerRT;
out vec3 v_world;
void main() {
  vec3 p = mix(mix(u_cornerLB, u_cornerRB, a_pos.x), mix(u_cornerLT, u_cornerRT, a_pos.x), a_pos.y);
  v_world = p;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const backdropFs = (surface: LiquidSurface): string => /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${MEDIUM_GLSL}
${surface.glsl}
uniform vec3 u_eye;
in vec3 v_world;
out vec4 o_color;
void main() {
  vec3 d = normalize(v_world - u_eye);
  vec3 up = localUp(u_eye);
  float eyeDepth = -u_liquid.x;
  // Where a view ray would end ${surface.clearM.toFixed(0)} m away: higher up the liquid is lighter, lower down darker.
  float depth = max(eyeDepth - dot(d, up) * ${surface.clearM.toFixed(1)}, 0.0);
  vec3 light = liquidSurfaceLight(u_eye);
  vec3 c = liquidInscatter(depth, light, dot(d, up));
  // The light from the sun scattered forward toward the eye, round the sun's refracted direction.
  vec3 s = liquidSunDir();
  vec3 sunIn = liquidSunIn(up);
  float g = max(dot(d, -sunIn), 0.0);
  vec3 sun = liquidSun(u_eye);
  c += sun * LIQUID_BODY * liquidLightAt(eyeDepth) * (0.6 * pow(g, 8.0) + 0.25 * pow(g, 2.0)) * max(dot(s, up), 0.0);
  o_color = vec4(liquidDisplay(max(c, vec3(0.0))), 1.0);
}`;

const QUAD: MeshData = {
  layout: { stride: 8, attribs: [{ name: 'a_pos', size: 2, type: 'f32', offset: 0 }] },
  vertices: Float32Array.of(0, 0, 0, 1, 1, 0, 1, 1),
  indices: Uint16Array.of(0, 2, 1, 1, 2, 3),
  count: 6,
};

/**
 * The backdrop under the surface (see the head of the file): a quad at the clear distance ahead, drawn with depth
 * while the eye is under the surface, in the liquid's own light. Add it before the opaque world.
 */
export class LiquidBackdropLayer implements Layer {
  readonly name: string;
  /** The liquid's common uniforms of the frame; the page sets them every frame. */
  uniforms: Uniforms = {};
  private readonly material: Material;
  private readonly mesh: Mesh;
  private readonly surface: LiquidSurface;

  constructor(renderer: Renderer, surface: LiquidSurface, options: LiquidLayerOptions = {}) {
    this.name = options.name ?? 'liquid-backdrop';
    this.surface = surface;
    this.material = renderer.material({
      name: this.name,
      attribs: { a_pos: 0 },
      passes: { color: { vs: BACKDROP_VS, fs: backdropFs(surface) } },
      state: { color: { depthTest: true, depthWrite: true, cull: 'none', blend: null } },
    });
    this.mesh = renderer.device.createMesh(QUAD, { a_pos: 0 });
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color' || this.surface.state.aboveSurfaceM >= 0) return;
    const program = this.material.program('color');
    if (!program) return;
    const rays = ctx.view.cornerRays();
    const f = ctx.view.axes().forward;
    const eye = rays[0]!.origin;
    const clearM = this.surface.clearM;
    // The corners on the plane at the clear distance ahead, a little beyond the screen's edge.
    const corner = (i: number): [number, number, number] => {
      const d = rays[i]!.dir;
      const k = (clearM / Math.max(1e-6, d[0] * f[0] + d[1] * f[1] + d[2] * f[2])) * 1.02;
      return [eye[0] + (d[0] - f[0]) * k + f[0] * (k / 1.02), eye[1] + (d[1] - f[1]) * k + f[1] * (k / 1.02), eye[2] + (d[2] - f[2]) * k + f[2] * (k / 1.02)];
    };
    ctx.device.setState(this.material.state.color!);
    ctx.device.use(program);
    program.vec3('u_cornerLB', ...corner(0));
    program.vec3('u_cornerLT', ...corner(1));
    program.vec3('u_cornerRB', ...corner(2));
    program.vec3('u_cornerRT', ...corner(3));
    program.vec3('u_eye', eye[0], eye[1], eye[2]);
    setAll(program, this.uniforms);
    ctx.device.draw(this.mesh);
    ctx.count(2);
  }
}

// --- Full-screen passes along the view rays ------------------------------------------------------------------------

const RAYS_VS = /* glsl */ `#include <header>
in vec2 a_pos;
uniform vec3 u_cornerLB;
uniform vec3 u_cornerLT;
uniform vec3 u_cornerRB;
uniform vec3 u_cornerRT;
out vec3 v_dir;
void main() {
  v_dir = mix(mix(u_cornerLB, u_cornerRB, a_pos.x), mix(u_cornerLT, u_cornerRT, a_pos.x), a_pos.y);
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

// --- The light shafts ----------------------------------------------------------------------------------------------

const shaftsFs = (surface: LiquidSurface, options: LiquidShaftsOptions): string => /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${MEDIUM_GLSL}
${surface.glsl}
${liquidShaftsGlsl(options)}
uniform vec3 u_eye;
uniform highp sampler2D u_liquidScene;
uniform vec4 u_liquidSceneMap;
uniform vec3 u_liquidForward;
in vec3 v_dir;
out vec4 o_color;
float sceneDistance(float depth, vec4 map) {
  if (map.x > 2.5) return depth >= 0.999999 ? 1e30 : exp2(depth / map.w) - 1.0;
  if (map.x < 0.5 || (map.x < 1.5 ? depth <= 0.0 : depth >= 0.9999999)) return 1e30;
  float ndc = map.x > 1.5 ? depth * 2.0 - 1.0 : depth;
  return map.z / (ndc - map.y) * map.w;
}
void main() {
  vec3 d = normalize(v_dir);
  vec3 up = localUp(u_eye);
  // The ray ends at what the scene drew there, or where it rises through the surface.
  float len = ${surface.clearM.toFixed(1)};
  if (u_liquidSceneMap.x > 0.5) len = min(len, sceneDistance(texelFetch(u_liquidScene, ivec2(gl_FragCoord.xy), 0).r, u_liquidSceneMap) / max(dot(d, u_liquidForward), 1e-3));
  float rise = dot(d, up);
  if (rise > 1e-3) len = min(len, -u_liquid.x / rise);
  vec3 s = liquidShafts(u_eye, d, len, liquidSun(u_eye));
  o_color = vec4(liquidDisplay(s) - liquidDisplay(vec3(0.0)), 0.0);
}`;

/** Options of a `LiquidShaftsLayer`: its name and the shafts' samples (`liquidShaftsGlsl`). */
export interface LiquidShaftsLayerOptions extends LiquidLayerOptions, LiquidShaftsOptions {}

/**
 * The light shafts while the eye is under the surface: one full-screen pass, adding the sunlight the liquid scatters
 * toward the eye along each view ray (`liquidShaftsGlsl`), up to what the scene drew there or the surface. Add it
 * after the surface's materials.
 */
export class LiquidShaftsLayer implements Layer {
  readonly name: string;
  /** The liquid's common uniforms of the frame; the page sets them every frame. */
  uniforms: Uniforms = {};
  /** False hides it. */
  enabled = true;
  private readonly material: Material;
  private readonly mesh: Mesh;
  private readonly renderer: Renderer;
  private readonly surface: LiquidSurface;

  constructor(renderer: Renderer, surface: LiquidSurface, options: LiquidShaftsLayerOptions = {}) {
    this.name = options.name ?? 'liquid-shafts';
    this.renderer = renderer;
    this.surface = surface;
    this.material = renderer.material({
      name: this.name,
      attribs: { a_pos: 0 },
      passes: { color: { vs: RAYS_VS, fs: shaftsFs(surface, options) } },
      state: { color: { depthTest: false, depthWrite: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } } },
    });
    this.mesh = renderer.device.createMesh(QUAD, { a_pos: 0 });
  }

  draw(ctx: DrawContext): void {
    if (!this.enabled || ctx.pass !== 'color' || this.surface.state.aboveSurfaceM >= 0) return;
    const program = this.material.program('color');
    if (!program) return;
    const device = ctx.device;
    const scene = device.sceneDepth();
    const p = this.renderer.projection;
    const map = scene ? cloudVolumeDepthMap(device.depthMode, p.viewProj, p.logScale) : ([0, 0, 0, 0] as V4);
    const rays = ctx.view.cornerRays();
    const eye = rays[0]!.origin;
    const f = ctx.view.axes().forward;
    device.setState(this.material.state.color!);
    device.use(program);
    device.texture(LIQUID_SCENE_UNIT, scene);
    program.set('u_liquidScene', { int: LIQUID_SCENE_UNIT });
    program.set('u_liquidSceneMap', { vec4: [map[0], map[1], map[2], map[3]] });
    program.vec3('u_liquidForward', f[0], f[1], f[2]);
    const d = (i: number): [number, number, number] => [rays[i]!.dir[0], rays[i]!.dir[1], rays[i]!.dir[2]];
    program.vec3('u_cornerLB', ...d(0));
    program.vec3('u_cornerLT', ...d(1));
    program.vec3('u_cornerRB', ...d(2));
    program.vec3('u_cornerRT', ...d(3));
    program.vec3('u_eye', eye[0], eye[1], eye[2]);
    setAll(program, this.uniforms);
    device.draw(this.mesh);
    ctx.count(2);
  }
}

// --- The line across the lens --------------------------------------------------------------------------------------

/** GLSL of a colour: a number as a grey factor, three as a vec3. */
const glslColor = (c: number | readonly [number, number, number]): string => {
  const f = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
  return typeof c === 'number' ? f(c) : `vec3(${c.map(f).join(', ')})`;
};

const lensFs = (surface: LiquidSurface, skyTint: number | readonly [number, number, number]): string => /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${MEDIUM_GLSL}
${surface.glsl}
uniform vec4 u_lens;     // xyz the eye in render space, w the distance of the lens in front of it (m)
uniform vec4 u_liquidSlope; // xy the slope of the surface at the eye along the plane's axes
in vec3 v_dir;
out vec4 o_color;
void main() {
  vec3 d = normalize(v_dir);
  vec3 eye = u_lens.xyz;
  vec3 up = localUp(eye);
  vec3 ta;
  vec3 tb;
  liquidTangents(up, ta, tb);
  // The point of the lens this pixel looks through, and its height above the surface (a plane through the eye's
  // foot with the surface's slope there: the lens is a hand's width across).
  vec3 r = d * u_lens.w;
  float h = u_liquid.x + dot(r, up) - u_liquidSlope.x * dot(r, ta) - u_liquidSlope.y * dot(r, tb);
  bool eyeBelow = u_liquid.x < 0.0;
  float side = eyeBelow ? h : -h; // > 0: this part of the lens is on the other side of the surface than the eye
  float fw = max(fwidth(h), 1e-5);
  float other = smoothstep(-fw, fw, side);
  // A thin dark line where the surface meets the lens, a film of the liquid just beside it.
  float line = exp(-abs(h) / (3.0 * fw)) * 0.6;
  vec3 light = liquidSurfaceLight(eye);
  vec4 c;
  if (eyeBelow) {
    // The part above the surface: the bright sky, blurred by the drops on the lens.
    c = vec4(toDisplay(light * ${glslColor(skyTint)}), 1.0) * (other * 0.85);
  } else {
    // The part under the surface: the liquid itself, lighter just under the surface.
    float down = max(-dot(d, up), 0.0);
    vec3 water = liquidDisplay(liquidInscatter(0.5 + 6.0 * down, light, -down));
    c = vec4(water, 1.0) * (other * 0.94);
  }
  o_color = c * (1.0 - line) + vec4(vec3(0.0), line);
}`;

/** Options of a `LiquidLensLayer`. */
export interface LiquidLensOptions extends LiquidLayerOptions {
  /** The sky above the surface seen from below as a share of the surface's light: one factor or one per channel (default 0.22). */
  skyTint?: number | readonly [number, number, number];
}

/**
 * The line across the lens: while the eye is within a few decimetres of the moving surface, the part of the lens on
 * the other side of the surface than the eye shows that side (the liquid's colour under it, the bright sky over it),
 * with a dark line where the surface meets the lens. Add it last, over everything.
 */
export class LiquidLensLayer implements Layer {
  readonly name: string;
  /** The liquid's common uniforms of the frame (with `u_liquidSlope`); the page sets them every frame. */
  uniforms: Uniforms = {};
  /** Distance of the lens in front of the eye, in metres. */
  lensM = 0.25;
  /** False hides it. */
  enabled = true;
  private readonly material: Material;
  private readonly mesh: Mesh;
  private readonly surface: LiquidSurface;

  constructor(renderer: Renderer, surface: LiquidSurface, options: LiquidLensOptions = {}) {
    this.name = options.name ?? 'liquid-lens';
    this.surface = surface;
    this.material = renderer.material({
      name: this.name,
      attribs: { a_pos: 0 },
      passes: { color: { vs: RAYS_VS, fs: lensFs(surface, options.skyTint ?? 0.22) } },
      state: { color: { depthTest: false, depthWrite: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } } },
    });
    this.mesh = renderer.device.createMesh(QUAD, { a_pos: 0 });
  }

  draw(ctx: DrawContext): void {
    const state = this.surface.state;
    if (!this.enabled || ctx.pass !== 'color' || Math.abs(state.aboveSurfaceM) > 1.5 || state.aboveLevelM > 3) return;
    const program = this.material.program('color');
    if (!program) return;
    const rays = ctx.view.cornerRays();
    const eye = rays[0]!.origin;
    ctx.device.setState(this.material.state.color!);
    ctx.device.use(program);
    const d = (i: number): [number, number, number] => [rays[i]!.dir[0], rays[i]!.dir[1], rays[i]!.dir[2]];
    program.vec3('u_cornerLB', ...d(0));
    program.vec3('u_cornerLT', ...d(1));
    program.vec3('u_cornerRB', ...d(2));
    program.vec3('u_cornerRT', ...d(3));
    program.set('u_lens', { vec4: [eye[0], eye[1], eye[2], this.lensM] });
    setAll(program, this.uniforms);
    ctx.device.draw(this.mesh);
    ctx.count(2);
  }
}
