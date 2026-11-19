// The moving sea of the planet example: the waves, the near surface round the eye, the backdrop under the water and
// the waterline across the lens.
//
// The waves are a sum of trochoidal trains raised by the page's wind (`waveTrains` of gen-core, `PLANET_WIND`). They
// live in a plane: a chart of the sphere, the face of a cube seen from the centre (the face under the eye), whose
// coordinates are the angles along its two axes times the radius, so they are metres along the axes and stretch
// little across the face. A point's place in it is a pure function of the point; the shaders compute it from
// differences to the eye's foot (`seaPlane`, shaders.ts) and the phases of the trains at the foot come from the CPU in
// double, so the surface is the same function of position and time wherever the eye is. The north of each face is
// fixed (the pole's axis projected on it, or a fixed axis on the polar faces), so the wind's direction in the plane
// is fixed per face; only when the eye crosses from one face to the next does the pattern change.
//
// `seaUniforms` gives every material of the cells (shaders.ts) the eye's height above the moving surface (computed
// here on the CPU with the same trains, so the switch between above and below never disagrees with the picture), the
// chart and, for the water, the trains and the ripples (short trains for the fine detail of the normal). The near
// surface (`SeaSurfaceLayer`) is a grid of rings round the eye's foot, moved by the waves in its vertex shader and
// drawn from its outer ring inward, so a near crest lies over the water behind it; the water of the cells leaves out
// its disc. The backdrop (`SeaBackdrop`)
// stands at the distance where the water hides everything while the eye is under it, the light shafts
// (`SeaShaftsLayer`) are added along every view ray then, and the waterline (`SeaLensLayer`) splits the picture where
// the surface passes through the front of the lens.

import type { MeshData, Uniforms, Vec3 } from 'wallhammer-web/base';
import { MEDIUM_GLSL } from 'wallhammer-web/core';
import { cloudVolumeDepthMap } from 'wallhammer-web/env';
import { WAVE_GRAVITY, hashInts, unit, waveHeight, waveTrains, waveUniforms } from 'wallhammer-web/gen-core';
import type { WaveTrain } from 'wallhammer-web/gen-core';
import type { Mesh } from 'wallhammer-web/gpu';
import type { DrawContext, Layer, Material, Renderer } from 'wallhammer-web/render';
import { NEAR_WATER_MATERIAL, SEA_CLEAR_M, SEA_COMMON_GLSL, SEA_RIPPLES, SEA_SHAFTS_GLSL, SIMPLEX_SKEW } from './shaders.ts';
import { PLANET_WIND } from './weather.ts';

/** Radius in metres round the eye's foot that the near surface covers while the eye is low. */
export const SEA_NEAR_M = 500;
/** The waves' heights fade out between these heights of the eye (m); above the upper one the near surface is off. */
export const SEA_NEAR_FADE_M = [60, 120] as const;
/** Factor on the heights of the wind's sea (Pierson–Moskowitz), for a livelier surface than 6 m/s alone raises. */
const SEA_HEIGHT_SCALE = 1.3;
/** Stream of the waves' random numbers. */
const WAVE_STREAM = 0x5ea7;

// --- The plane of the waves ----------------------------------------------------------------------------------------

/** Axes of a face of the chart: n the face's normal, a and b its two axes (b the face's north). */
interface SeaFace {
  index: number;
  n: Vec3;
  a: Vec3;
  b: Vec3;
}
const cross = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const FACES: SeaFace[] = (
  [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as Vec3[]
).map((n, index) => {
  const b: Vec3 = Math.abs(n[1]) > 0.5 ? [0, 0, -n[1]] : [0, 1, 0];
  return { index, n, a: cross(n, b), b };
});

/** The face of the chart for a point (any length; from the centre). */
function faceOf(p: Vec3): SeaFace {
  const ax = Math.abs(p[0]);
  const ay = Math.abs(p[1]);
  const az = Math.abs(p[2]);
  if (ax >= ay && ax >= az) return FACES[p[0] >= 0 ? 0 : 1]!;
  if (ay >= az) return FACES[p[1] >= 0 ? 2 : 3]!;
  return FACES[p[2] >= 0 ? 4 : 5]!;
}

/** Coordinates in metres of a point (from the centre) in the plane of a face on a sphere of `radiusM`. */
function planeOf(face: SeaFace, p: Vec3, radiusM: number): [number, number] {
  const n = dot(p, face.n);
  return [radiusM * Math.atan(dot(p, face.a) / n), radiusM * Math.atan(dot(p, face.b) / n)];
}

const trainCache = new Map<string, WaveTrain[]>();
/** The trains of a face for a seed: the page's wind, its direction taken against the face's north. */
export function seaTrains(seed: number, face: number): WaveTrain[] {
  const key = `${seed}:${face}`;
  let t = trainCache.get(key);
  if (!t) {
    const toward = ((PLANET_WIND.fromDeg + 180) * Math.PI) / 180;
    t = waveTrains({ windSpeedMs: PLANET_WIND.speedMs, towardX: Math.sin(toward), towardZ: Math.cos(toward), seed: (seed ^ Math.imul(WAVE_STREAM, face + 1)) >>> 0, heightScale: SEA_HEIGHT_SCALE });
    trainCache.set(key, t);
  }
  return t;
}

// --- The ripples ---------------------------------------------------------------------------------------------------
// Octaves of gradient noise under the trains of the wind's sea, for the fine detail of the surface's normal seen close
// up, from above or from below (`SEA_RIPPLES`, shaders.ts). Each octave drifts at the speed of ripples of its size,
// round the wind; the shader fades it where a pixel covers too much of it. Where each octave's lattice lies under
// the eye's foot comes from the CPU in double (the lattice repeats after `SEA_RIPPLES.period` cells), so the ripples
// stay put on the water however far the eye has gone and however long the clock has run.

/** Surface tension over the density of water (m³/s²): the shortest ripples run faster than gravity alone moves them. */
const CAPILLARITY = 7.4e-5;
/** Angle between the drift of one octave and the wind, alternately to either side (radians). */
const RIPPLE_DRIFT_SPREAD = 0.35;
/** Stream of the ripples' random numbers. */
const RIPPLE_STREAM = 0x5ea8;

/**
 * Where each ripple octave's lattice lies at the plane's point (x0, z0) at `timeS`: two numbers per octave, in its
 * cells, within one period, into `out`.
 */
function rippleOffsets(seed: number, x0: number, z0: number, timeS: number, out: number[]): void {
  const toward = ((PLANET_WIND.fromDeg + 180) * Math.PI) / 180;
  const { octaves, largestM, step, turn, period } = SEA_RIPPLES;
  for (let o = 0; o < octaves; o++) {
    const cell = largestM * step ** o;
    // Ripples about a cell long: their speed on the water.
    const k = (2 * Math.PI) / cell;
    const speed = Math.sqrt(WAVE_GRAVITY / k + CAPILLARITY * k);
    const dir = toward + (o % 2 === 0 ? 1 : -1) * RIPPLE_DRIFT_SPREAD;
    const x = x0 - Math.sin(dir) * speed * timeS;
    const z = z0 - Math.cos(dir) * speed * timeS;
    // Turned and scaled to the cell, then skewed onto the simplex lattice (as `rippleOctavesGlsl`, shaders.ts).
    const c = Math.cos(turn * o);
    const s = Math.sin(turn * o);
    const u = (c * x - s * z) / cell;
    const v = (s * x + c * z) / cell;
    for (let j = 0; j < 2; j++) {
      const q = (j === 0 ? u : v) + (u + v) * SIMPLEX_SKEW + period * unit(hashInts(seed, RIPPLE_STREAM, o, j));
      out[2 * o + j] = q - period * Math.floor(q / period);
    }
  }
}

/** Factor on the waves' heights for an eye `heightM` above the level: 1 low down, 0 from the upper fade height up. */
export function seaWaveFactor(heightM: number): number {
  const x = Math.min(1, Math.max(0, (heightM - SEA_NEAR_FADE_M[0]) / (SEA_NEAR_FADE_M[1] - SEA_NEAR_FADE_M[0])));
  return 1 - x * x * (3 - 2 * x);
}

/**
 * Height in metres of the moving surface above the level over the point `p` (world metres from the centre) at
 * `timeS`, with the waves as tall as an eye at `eyeHeightM` sees them (default: full). A pure function.
 */
export function seaSurfaceHeight(seed: number, p: Vec3, radiusM: number, timeS: number, eyeHeightM = 0): number {
  const f = seaWaveFactor(eyeHeightM);
  if (f <= 0) return 0;
  const face = faceOf(p);
  const [x, z] = planeOf(face, p, radiusM);
  return f * waveHeight(seaTrains(seed, face.index), x, z, timeS);
}

// --- Uniforms ------------------------------------------------------------------------------------------------------

type V4 = [number, number, number, number];
const v4 = (): { vec4: V4 } => ({ vec4: [0, 0, 0, 0] });
const COMMON = { u_sea: v4(), u_seaFoot: v4(), u_seaAxisA: v4(), u_seaAxisB: v4(), u_seaAxisN: v4(), u_seaSlope: v4() };
const WAVES: Record<string, { vec4: V4 }> = {};
const WATER: Uniforms = {};
/** The ripple octaves' offsets, two to an octave, four to a uniform. */
const RIPPLE_UNIFORMS = Math.ceil(SEA_RIPPLES.octaves / 2);
const rippleAt: number[] = [];
/** What `seaUniforms` computed last: the eye's height above the moving surface and above the level. */
export const seaState = { aboveSurfaceM: 1, aboveLevelM: 1, nearM: 0 };

/**
 * The sea's uniforms for a frame (see the head of the file): `common` for every material of the cells and the
 * layers, `water` for the water (common and the trains). `eye` and `origin` are world positions (the render origin),
 * the time the animation time. The same objects are rewritten every call, so a frame allocates nothing.
 */
export function seaUniforms(seed: number, eye: Vec3, origin: Vec3, radiusM: number, timeS: number): { common: Uniforms; water: Uniforms } {
  const r = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  const aboveLevel = r - radiusM;
  const foot: Vec3 = [(eye[0] / r) * radiusM, (eye[1] / r) * radiusM, (eye[2] / r) * radiusM];
  const face = faceOf(foot);
  const f = seaWaveFactor(aboveLevel);
  const trains = seaTrains(seed, face.index);
  const [x0, z0] = planeOf(face, foot, radiusM);
  const surface = f > 0 ? f * waveHeight(trains, x0, z0, timeS) : 0;
  // The slope of the surface at the eye's foot, for the waterline across the lens.
  const e = 0.05;
  const slopeA = f > 0 && aboveLevel < 3 ? (f * (waveHeight(trains, x0 + e, z0, timeS) - waveHeight(trains, x0 - e, z0, timeS))) / (2 * e) : 0;
  const slopeB = f > 0 && aboveLevel < 3 ? (f * (waveHeight(trains, x0, z0 + e, timeS) - waveHeight(trains, x0, z0 - e, timeS))) / (2 * e) : 0;
  const near = aboveLevel < SEA_NEAR_FADE_M[1] ? SEA_NEAR_M : 0;
  seaState.aboveSurfaceM = aboveLevel - surface;
  seaState.aboveLevelM = aboveLevel;
  seaState.nearM = near;
  COMMON.u_sea.vec4 = [aboveLevel - surface, aboveLevel, near, f];
  COMMON.u_seaFoot.vec4 = [foot[0] - origin[0], foot[1] - origin[1], foot[2] - origin[2], radiusM];
  COMMON.u_seaAxisA.vec4 = [face.a[0], face.a[1], face.a[2], dot(foot, face.a)];
  COMMON.u_seaAxisB.vec4 = [face.b[0], face.b[1], face.b[2], dot(foot, face.b)];
  COMMON.u_seaAxisN.vec4 = [face.n[0], face.n[1], face.n[2], dot(foot, face.n)];
  COMMON.u_seaSlope.vec4 = [slopeA, slopeB, 0, 0];
  waveUniforms(trains, timeS, x0, z0, WAVES);
  rippleOffsets(seed, x0, z0, timeS, rippleAt);
  for (let i = 0; i < RIPPLE_UNIFORMS; i++) {
    const v = (WAVES[`u_seaRipple${i}`] ??= v4()).vec4;
    for (let j = 0; j < 4; j++) v[j] = rippleAt[4 * i + j] ?? 0;
  }
  Object.assign(WATER, COMMON, WAVES);
  return { common: COMMON, water: WATER };
}

/** Sets every uniform of a set on a program. */
function setAll(program: { set(name: string, v: Uniforms[string]): void }, u: Uniforms): void {
  for (const k in u) program.set(k, u[k]!);
}

// --- The near surface ----------------------------------------------------------------------------------------------

/** Spokes of the grid of rings; the rings grow by the same share, so its cells stay about square. */
const SPOKES = 128;
const GROWTH = Math.exp((2 * Math.PI) / SPOKES);
/** Radius of the first ring in metres. */
const FIRST_RING_M = 0.3;
/** Rings to a little beyond `SEA_NEAR_M`. */
const RINGS = Math.ceil(Math.log((1.05 * SEA_NEAR_M) / FIRST_RING_M) / Math.log(GROWTH)) + 1;
/** Texture unit of the scene's depth (one the clouds' layers bind again for themselves). */
const SCENE_UNIT = 11;

/** The near surface (see the head of the file): drawn after the cells while `seaUniforms` says the eye is low. */
export class SeaSurfaceLayer implements Layer {
  readonly name = 'sea-near';
  /** The sea's uniforms of the frame; the page sets them every frame. */
  uniforms: Uniforms = {};
  /** False hides it. */
  enabled = true;
  private readonly material: Material;
  private readonly mesh: Mesh;
  private readonly triangles: number;
  private readonly renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.material = renderer.material(NEAR_WATER_MATERIAL);
    const cols = SPOKES + 1;
    const verts = new Float32Array((RINGS + 1) * cols * 2);
    for (let j = 0; j <= RINGS; j++) {
      for (let i = 0; i < cols; i++) {
        verts[(j * cols + i) * 2] = j;
        verts[(j * cols + i) * 2 + 1] = i;
      }
    }
    // From the outermost ring inward: the eye stands over the grid's centre, so along every view ray a nearer ring is
    // a nearer part of the surface, and drawn later it lies over the farther parts (the grid writes no depth).
    const idx = new Uint16Array(RINGS * SPOKES * 6);
    let k = 0;
    for (let j = RINGS - 1; j >= 0; j--) {
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
    if (!this.enabled || ctx.pass !== 'color' || seaState.nearM <= 0) return;
    const program = this.material.program('color');
    if (!program) return;
    const device = ctx.device;
    // The depth of the scene drawn so far, for the depth of the floor under the surface (the shore's foam).
    const scene = seaState.aboveSurfaceM >= 0 ? device.sceneDepth() : null;
    const p = this.renderer.projection;
    const map = scene ? cloudVolumeDepthMap(device.depthMode, p.viewProj, p.logScale) : ([0, 0, 0, 0] as V4);
    device.setState(this.material.state.color!);
    device.use(program);
    device.texture(SCENE_UNIT, scene);
    program.set('u_seaScene', { int: SCENE_UNIT });
    program.set('u_seaSceneMap', { vec4: [map[0], map[1], map[2], map[3]] });
    const f = ctx.view.axes().forward;
    program.vec3('u_seaForward', f[0], f[1], f[2]);
    const eye = ctx.view.cornerRays()[0]!.origin;
    program.set('u_morphEye', { vec4: [eye[0], eye[1], eye[2], 0] });
    program.set('u_seaNear', { vec4: [FIRST_RING_M, Math.log(GROWTH), (2 * Math.PI) / SPOKES, 0] });
    setAll(program, this.uniforms);
    device.draw(this.mesh);
    ctx.count(this.triangles);
  }
}

// --- The backdrop under the water ----------------------------------------------------------------------------------

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

const BACKDROP_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
uniform vec3 u_eye;
in vec3 v_world;
out vec4 o_color;
void main() {
  vec3 d = normalize(v_world - u_eye);
  vec3 up = localUp(u_eye);
  float eyeDepth = -u_sea.x;
  // Where a view ray would end ${SEA_CLEAR_M.toFixed(0)} m away: higher up the water is lighter, lower down darker.
  float depth = max(eyeDepth - dot(d, up) * ${SEA_CLEAR_M.toFixed(1)}, 0.0);
  vec3 light = seaSurfaceLight(u_eye);
  vec3 c = seaInscatter(depth, light, dot(d, up));
  // The light from the sun scattered forward toward the eye, round the sun's refracted direction.
  vec3 s = seaSunDir();
  vec3 sunIn = seaSunIn(up);
  float g = max(dot(d, -sunIn), 0.0);
  vec3 sun = seaSun(u_eye);
  c += sun * SEA_BODY * seaLightAt(eyeDepth) * (0.6 * pow(g, 8.0) + 0.25 * pow(g, 2.0)) * max(dot(s, up), 0.0);
  o_color = vec4(seaDisplay(max(c, vec3(0.0))), 1.0);
}`;

/** The backdrop under the water (see the head of the file). Add it before the streamed world. */
export class SeaBackdrop implements Layer {
  readonly name = 'sea-backdrop';
  /** The sea's common uniforms of the frame; the page sets them every frame. */
  uniforms: Uniforms = {};
  private readonly material: Material;
  private readonly mesh: Mesh;

  constructor(renderer: Renderer) {
    this.material = renderer.material({
      name: 'planet-sea-backdrop',
      attribs: { a_pos: 0 },
      passes: { color: { vs: BACKDROP_VS, fs: BACKDROP_FS } },
      state: { color: { depthTest: true, depthWrite: true, cull: 'none', blend: null } },
    });
    this.mesh = renderer.device.createMesh(QUAD, { a_pos: 0 });
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color' || seaState.aboveSurfaceM >= 0) return;
    const program = this.material.program('color');
    if (!program) return;
    const rays = ctx.view.cornerRays();
    const f = ctx.view.axes().forward;
    const eye = rays[0]!.origin;
    // The corners on the plane SEA_CLEAR_M ahead, a little beyond the screen's edge.
    const corner = (i: number): [number, number, number] => {
      const d = rays[i]!.dir;
      const k = (SEA_CLEAR_M / Math.max(1e-6, d[0] * f[0] + d[1] * f[1] + d[2] * f[2])) * 1.02;
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

const QUAD: MeshData = {
  layout: { stride: 8, attribs: [{ name: 'a_pos', size: 2, type: 'f32', offset: 0 }] },
  vertices: Float32Array.of(0, 0, 0, 1, 1, 0, 1, 1),
  indices: Uint16Array.of(0, 2, 1, 1, 2, 3),
  count: 6,
};

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

const SHAFTS_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${SEA_SHAFTS_GLSL}
uniform vec3 u_eye;
uniform highp sampler2D u_seaScene;
uniform vec4 u_seaSceneMap;
uniform vec3 u_seaForward;
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
  float len = ${SEA_CLEAR_M.toFixed(1)};
  if (u_seaSceneMap.x > 0.5) len = min(len, sceneDistance(texelFetch(u_seaScene, ivec2(gl_FragCoord.xy), 0).r, u_seaSceneMap) / max(dot(d, u_seaForward), 1e-3));
  float rise = dot(d, up);
  if (rise > 1e-3) len = min(len, -u_sea.x / rise);
  vec3 s = seaShafts(u_eye, d, len, seaSun(u_eye));
  o_color = vec4(seaDisplay(s) - seaDisplay(vec3(0.0)), 0.0);
}`;

/**
 * The light shafts while the eye is under the water: one full-screen pass after the water, adding the sunlight the
 * water scatters toward the eye along each view ray (`SEA_SHAFTS_GLSL`, shaders.ts), up to what the scene drew there
 * or the surface.
 */
export class SeaShaftsLayer implements Layer {
  readonly name = 'sea-shafts';
  /** The sea's common uniforms of the frame; the page sets them every frame. */
  uniforms: Uniforms = {};
  /** False hides it. */
  enabled = true;
  private readonly material: Material;
  private readonly mesh: Mesh;
  private readonly renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.material = renderer.material({
      name: 'planet-sea-shafts',
      attribs: { a_pos: 0 },
      passes: { color: { vs: RAYS_VS, fs: SHAFTS_FS } },
      state: { color: { depthTest: false, depthWrite: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } } },
    });
    this.mesh = renderer.device.createMesh(QUAD, { a_pos: 0 });
  }

  draw(ctx: DrawContext): void {
    if (!this.enabled || ctx.pass !== 'color' || seaState.aboveSurfaceM >= 0) return;
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
    device.texture(SCENE_UNIT, scene);
    program.set('u_seaScene', { int: SCENE_UNIT });
    program.set('u_seaSceneMap', { vec4: [map[0], map[1], map[2], map[3]] });
    program.vec3('u_seaForward', f[0], f[1], f[2]);
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

// --- The waterline across the lens ---------------------------------------------------------------------------------

const LENS_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
uniform vec4 u_lens;     // xyz the eye in render space, w the distance of the lens in front of it (m)
uniform vec4 u_seaSlope; // xy the slope of the surface at the eye along the plane's axes
in vec3 v_dir;
out vec4 o_color;
void main() {
  vec3 d = normalize(v_dir);
  vec3 eye = u_lens.xyz;
  vec3 up = localUp(eye);
  vec3 ta;
  vec3 tb;
  seaTangents(up, ta, tb);
  // The point of the lens this pixel looks through, and its height above the surface (a plane through the eye's
  // foot with the surface's slope there: the lens is a hand's width across).
  vec3 r = d * u_lens.w;
  float h = u_sea.x + dot(r, up) - u_seaSlope.x * dot(r, ta) - u_seaSlope.y * dot(r, tb);
  bool eyeBelow = u_sea.x < 0.0;
  float side = eyeBelow ? h : -h; // > 0: this part of the lens is on the other side of the surface than the eye
  float fw = max(fwidth(h), 1e-5);
  float other = smoothstep(-fw, fw, side);
  // A thin dark line where the surface meets the lens, a film of water just beside it.
  float line = exp(-abs(h) / (3.0 * fw)) * 0.6;
  vec3 light = seaSurfaceLight(eye);
  vec4 c;
  if (eyeBelow) {
    // The part above the water: the bright sky, blurred by the drops on the lens.
    c = vec4(toDisplay(light * 0.22), 1.0) * (other * 0.85);
  } else {
    // The part under the water: the water itself, lighter just under the surface.
    float down = max(-dot(d, up), 0.0);
    vec3 water = seaDisplay(seaInscatter(0.5 + 6.0 * down, light, -down));
    c = vec4(water, 1.0) * (other * 0.94);
  }
  o_color = c * (1.0 - line) + vec4(vec3(0.0), line);
}`;

/**
 * The waterline: while the eye is within a few decimetres of the moving surface, the part of the lens on the other
 * side of the surface than the eye shows that side (the water's colour under it, the bright sky over it), with a
 * dark line where the surface meets the lens. Drawn last, over everything.
 */
export class SeaLensLayer implements Layer {
  readonly name = 'sea-lens';
  /** The sea's water uniforms of the frame; the page sets them every frame. */
  uniforms: Uniforms = {};
  /** Distance of the lens in front of the eye, in metres. */
  lensM = 0.25;
  /** False hides it. */
  enabled = true;
  private readonly material: Material;
  private readonly mesh: Mesh;

  constructor(renderer: Renderer) {
    this.material = renderer.material({
      name: 'planet-sea-lens',
      attribs: { a_pos: 0 },
      passes: { color: { vs: RAYS_VS, fs: LENS_FS } },
      state: { color: { depthTest: false, depthWrite: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } } },
    });
    this.mesh = renderer.device.createMesh(QUAD, { a_pos: 0 });
  }

  draw(ctx: DrawContext): void {
    if (!this.enabled || ctx.pass !== 'color' || Math.abs(seaState.aboveSurfaceM) > 1.5 || seaState.aboveLevelM > 3) return;
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
