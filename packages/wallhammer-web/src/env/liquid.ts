// A liquid below the level of a radial world (the base sphere), with a moving surface of waves on it: the CPU side
// and the GLSL its materials and layers share. The layers that draw it are in `runtime` (`LiquidNearLayer`,
// `LiquidBackdropLayer`, `LiquidShaftsLayer`, `LiquidLensLayer`).
//
// The waves are a sum of trochoidal trains raised by a wind (`waveTrains` of gen-core). They live in a plane: a chart
// of the sphere, the face of a cube seen from the centre (the face under the eye), whose coordinates are the angles
// along its two axes times the radius, so they are metres along the axes and stretch little across the face. A
// point's place in it is a pure function of the point; the shaders compute it from differences to the eye's foot
// (`liquidPlane`) and the phases of the trains at the foot come from the CPU in double, so the surface is the same
// function of position and time wherever the eye is. The north of each face is fixed (the pole's axis projected on
// it, or a fixed axis on the polar faces), so the wind's direction in the plane is fixed per face; only when the eye
// crosses from one face to the next does the pattern change.
//
// `LiquidSurface.uniforms` gives every material the eye's height above the moving surface (computed here on the CPU
// with the same trains, so the switch between above and below never disagrees with the picture), the chart and, for
// the surface's own materials, the trains and the ripples (octaves of noise for the fine detail of the normal,
// `liquidRipplesGlsl`). The look (extinction, the liquid's own colour, the light lost with depth) is the caller's
// (`LiquidLook`); `liquidGlsl` writes it into the GLSL with the functions that use it.
//
// Everything here is a pure function of the options, the seed, the eye and the time. The only state is the cache of
// the trains and `state`, what the last `uniforms` call computed (for the layers and the page).

import type { Uniforms } from '../base/material.ts';
import type { Vec3 } from '../base/math.ts';
import { mediumClearDistance } from '../core/index.ts';
import { WAVE_GRAVITY, hashInts, unit, waveHeight, waveTrains, waveUniforms } from '../gen-core/index.ts';
import type { WaveTrain } from '../gen-core/index.ts';

type V3 = readonly [number, number, number];
type V4 = [number, number, number, number];

/** The optical properties of the liquid for an eye on one side of its surface. */
export interface LiquidOptics {
  /** Extinction per metre (red, green, blue). */
  extinction: V3;
  /** Colour of the open liquid seen across it from inside, as a multiple of the light at the surface. */
  body: V3;
  /** Share of the light from above lost per metre of depth (red, green, blue). */
  lightLoss: V3;
}

/** How the liquid looks: written into the GLSL by `liquidGlsl`. */
export interface LiquidLook extends LiquidOptics {
  /** The colours of the open liquid from high above, over a shallow floor and over a deep one (to 600 m). */
  farShallow: V3;
  farDeep: V3;
  /**
   * Other optics for an eye below the surface (default: the same). The GLSL then names the three by the side the eye
   * is on; the clear distance (`clearM`) stays the one of the optics above.
   */
  under?: LiquidOptics;
  /**
   * Caustics that repeat with a looping clock (`LiquidSurface.setLoop`): the uniform `u_liquidLoop` is declared and
   * the caustics fade over to the pattern of one pass earlier while the pass runs. Default false.
   */
  loop?: boolean;
  /** Extra GLSL declared after the built-in uniforms (the caller's own uniforms). */
  uniforms?: string;
  /** Extra GLSL after the built-in constants (the caller's own constants). */
  constants?: string;
}

/**
 * The ripples on the waves: octaves of simplex noise, the first with cells of `largestM` (its ripples about as
 * long), each next one `step` times as large and turned by `turn` radians, each of the same mean square slope
 * (`slope` squared over all of them), the lattice repeating after `period` cells (a power of two up to 4096).
 */
export interface LiquidRipples {
  octaves: number;
  largestM: number;
  step: number;
  turn: number;
  period: number;
  slope: number;
}

/** Default ripples: four octaves from 0.8 m down to a few centimetres. */
export const LIQUID_RIPPLES: Readonly<LiquidRipples> = { octaves: 4, largestM: 0.8, step: 0.45, turn: 2.4, period: 4096, slope: 0.11 };
/** The skew of the simplex lattice: a point's lattice coordinates are its own plus their sum times this. */
export const LIQUID_SIMPLEX_SKEW = (Math.sqrt(3) - 1) / 2;
const SIMPLEX_UNSKEW = (3 - Math.sqrt(3)) / 6;
/** The mean square of the gradient of `liquidSimplex` (per cell). */
const SIMPLEX_GRADIENT_MEAN_SQUARE = 4.4;

const vec3 = (v: readonly number[]): string => `vec3(${v.map((x) => x.toFixed(4)).join(', ')})`;

/** Distance in metres at which the liquid hides everything behind it to within 1 %, for an eye above it. */
export function liquidClearDistance(look: LiquidLook): number {
  return mediumClearDistance(look.extinction, 0.01);
}

/**
 * GLSL the materials and the layers of the liquid share: its colours, its light at a depth, the light of the surface
 * above a point, the plane of the waves, the caustics. Any stage; needs `<noise>`, `<lighting>`, `<atmosphere>` and
 * `MEDIUM_GLSL` before it. Uniforms (`LiquidSurface.uniforms`): `u_liquid` x the height of the eye above the moving
 * surface (m, negative under it), y its height above the level, z the radius round the eye's foot inside which the
 * near surface (`LiquidNearLayer`) draws the surface (0: none), w the factor on the waves' heights; `u_liquidFoot`
 * xyz the eye's foot on the level in render space, w the radius of the level; `u_liquidAxisA`, `u_liquidAxisB`,
 * `u_liquidAxisN` the axes of the chart of the waves' plane, each with the foot's coordinate along it (from the
 * centre) in w; with `loop`, `u_liquidLoop` x the seconds of the clock in one pass (0: none), y the share of the pass
 * played.
 *
 * Gives the constants `LIQUID_EXTINCTION`, `LIQUID_BODY`, `LIQUID_LIGHT_LOSS`, `LIQUID_FAR_SHALLOW`,
 * `LIQUID_FAR_DEEP` and the functions `liquidLightAt`, `liquidSunDir`, `liquidSun`, `liquidSurfaceLight`,
 * `liquidDisplay`, `liquidInscatter`, `liquidPlane`, `liquidTangents`, `liquidSunIn`, `liquidSunTop`,
 * `liquidCaustic` (and `liquidCausticAt` with `loop`).
 */
export function liquidGlsl(look: LiquidLook): string {
  const optics = look.under
    ? `const vec3 LIQUID_EXTINCTION_ABOVE = ${vec3(look.extinction)};
const vec3 LIQUID_BODY_ABOVE = ${vec3(look.body)};
const vec3 LIQUID_LIGHT_LOSS_ABOVE = ${vec3(look.lightLoss)};
const vec3 LIQUID_EXTINCTION_UNDER = ${vec3(look.under.extinction)};
const vec3 LIQUID_BODY_UNDER = ${vec3(look.under.body)};
const vec3 LIQUID_LIGHT_LOSS_UNDER = ${vec3(look.under.lightLoss)};
// By the side of the surface the eye is on.
#define LIQUID_EXTINCTION (u_liquid.x < 0.0 ? LIQUID_EXTINCTION_UNDER : LIQUID_EXTINCTION_ABOVE)
#define LIQUID_BODY (u_liquid.x < 0.0 ? LIQUID_BODY_UNDER : LIQUID_BODY_ABOVE)
#define LIQUID_LIGHT_LOSS (u_liquid.x < 0.0 ? LIQUID_LIGHT_LOSS_UNDER : LIQUID_LIGHT_LOSS_ABOVE)`
    : `const vec3 LIQUID_EXTINCTION = ${vec3(look.extinction)};
const vec3 LIQUID_BODY = ${vec3(look.body)};
const vec3 LIQUID_LIGHT_LOSS = ${vec3(look.lightLoss)};`;
  const causticBody = `  float blur = smoothstep(0.2, 7.0, depth);
  vec2 q = plane * (1.0 / 2.7);
  vec2 w = vec2(vnoise(q * 0.37 + vec2(0.0, 0.09 * t), 91u), vnoise(q * 0.37 + vec2(7.3, -0.08 * t), 92u)) - 0.5;
  q += w * 2.2;
  float a = vnoise(q + vec2(0.23 * t, 0.07 * t), 93u);
  float b = vnoise(q * vec2(1.21, 0.83) + vec2(-0.11 * t, 0.21 * t) + 3.7, 94u);
  float width = mix(0.06, 0.22, blur);
  float ra = 1.0 - smoothstep(0.0, width, abs(a - 0.5));
  float rb = 1.0 - smoothstep(0.0, width * 1.4, abs(b - 0.5));
  // Bright patches and dim ones, on a larger scale.
  float patchy = smoothstep(0.2, 0.8, vnoise(plane * (1.0 / 13.0) + vec2(0.03 * t, -0.02 * t), 95u));
  float c = 0.55 * ra + 0.35 * rb + 1.1 * ra * rb;
  return mix(c, 0.45, blur * 0.6) * (0.3 + 0.9 * patchy);
}`;
  const caustic = look.loop
    ? `float liquidCausticAt(vec2 plane, float depth, float t) {
${causticBody}
// The caustics now. Their pattern drifts on and never repeats, so a clock that plays in a circle fades it over to
// the pattern of one pass earlier while the pass runs: where the pass ends the picture is the one it began with.
float liquidCaustic(vec2 plane, float depth) {
  float c = liquidCausticAt(plane, depth, u_time.x);
  if (u_liquidLoop.x > 0.0) c = mix(c, liquidCausticAt(plane, depth, u_time.x - u_liquidLoop.x), u_liquidLoop.y);
  return c;
}`
    : `float liquidCaustic(vec2 plane, float depth) {
  float t = u_time.x;
${causticBody}`;
  return /* glsl */ `
uniform vec4 u_liquid;
uniform vec4 u_liquidFoot;
uniform vec4 u_liquidAxisA;
uniform vec4 u_liquidAxisB;
uniform vec4 u_liquidAxisN;
${look.uniforms ? `${look.uniforms}\n` : ''}${look.loop ? 'uniform vec4 u_liquidLoop; // x seconds of the clock in one pass (0: none), y the share of the pass played\n' : ''}${optics}
const vec3 LIQUID_FAR_SHALLOW = ${vec3(look.farShallow)};
const vec3 LIQUID_FAR_DEEP = ${vec3(look.farDeep)};
${look.constants ? `${look.constants}\n` : ''}// Share of the light from above that is left at a depth (m).
vec3 liquidLightAt(float depth) {
  return mediumThrough(LIQUID_LIGHT_LOSS, depth);
}
// Direction to the sun and its light as a multiple of a colour, at p.
vec3 liquidSunDir() {
#ifdef WH_ATMOSPHERE
  return u_atmSun.xyz;
#else
  return u_sunDir.xyz;
#endif
}
vec3 liquidSun(vec3 p) {
#ifdef WH_ATMOSPHERE
  return atmosphereSun(p) * u_cloudFieldLight.y;
#else
  return u_sunColor.rgb;
#endif
}
// The light at the top of the liquid over p, as a multiple of a colour: the sun (under the clouds) and the sky there.
vec3 liquidSurfaceLight(vec3 p) {
  vec3 up = localUp(p);
  vec3 top = p - up * localHeight(p);
#ifdef WH_ATMOSPHERE
  return atmosphereLight(top, up, u_cloudFieldLight.y, 1.0);
#else
  return u_warmTint.rgb * lightOnAt(top, up, 1.0, 1.0);
#endif
}
// Light on the screen's scale for an eye under the surface, which grows used to the dimmer light down there: the
// light left at the eye's depth is made up for in part (all of it would leave no darkening with depth). 1 at the top.
vec3 liquidDisplay(vec3 light) {
  vec3 left = liquidLightAt(max(-u_liquid.x, 0.0));
  return toDisplay(light * pow(max(dot(left, vec3(0.2, 0.7, 0.1)), 1e-4), -0.8));
}
// The light the liquid itself sends toward the eye where nothing shows through it, for a view ray that ends depth
// metres down (the eye's depth from u_liquid) with the cosine mu between it and up: light comes from above and is
// scattered mostly forward, so a ray looking down sees the dimmest liquid, one looking up the brightest. From high
// above the liquid takes the far colours by that depth.
vec3 liquidInscatter(float depth, vec3 light, float mu) {
  float eyeDepth = max(-u_liquid.x, 0.0);
  float far = smoothstep(5.0, 150.0, u_liquid.x);
  float phase = mix(0.32, 1.0, smoothstep(-1.0, 0.0, mu)) + 0.7 * max(mu, 0.0);
  vec3 body = mix(LIQUID_BODY * phase, mix(LIQUID_FAR_SHALLOW, LIQUID_FAR_DEEP, smoothstep(0.0, 600.0, depth)), far);
  float d = mix(0.5 * (eyeDepth + min(depth, eyeDepth + 40.0)), 0.0, far);
  return body * light * liquidLightAt(d);
}
// Coordinates in metres of a point (render space) in the plane of the waves, relative to the eye's foot: the chart is
// the face of the cube under the eye seen from the centre, its coordinates the angles along its two axes times the
// radius. Computed from differences, so it keeps its precision far from the face's centre.
vec2 liquidPlane(vec3 p) {
  vec3 r = p - u_liquidFoot.xyz;
  float ra = dot(r, u_liquidAxisA.xyz);
  float rb = dot(r, u_liquidAxisB.xyz);
  float rn = dot(r, u_liquidAxisN.xyz);
  float n0 = u_liquidAxisN.w;
  float k = 1.0 / (n0 * max(n0 + rn, 1.0));
  float du = (ra * n0 - u_liquidAxisA.w * rn) * k;
  float dv = (rb * n0 - u_liquidAxisB.w * rn) * k;
  float u0 = u_liquidAxisA.w / n0;
  float v0 = u_liquidAxisB.w / n0;
  return u_liquidFoot.w * vec2(atan(du, 1.0 + u0 * (u0 + du)), atan(dv, 1.0 + v0 * (v0 + dv)));
}
// The plane's axes in the horizon of a point with the local up.
void liquidTangents(vec3 up, out vec3 ta, out vec3 tb) {
  ta = normalize(u_liquidAxisA.xyz - up * dot(u_liquidAxisA.xyz, up));
  tb = normalize(u_liquidAxisB.xyz - up * dot(u_liquidAxisB.xyz, up));
}
// Direction the sun's light runs in the liquid (down), refracted at a calm surface with this up.
vec3 liquidSunIn(vec3 up) {
  vec3 s = liquidSunDir();
  vec3 t = refract(-s, up, 1.0 / 1.33);
  return dot(t, t) > 0.5 ? normalize(t) : -up;
}
// The point of the surface above p (depth metres down) from which the sun's light reaches p.
vec3 liquidSunTop(vec3 p, vec3 up, float depth) {
  vec3 sunIn = liquidSunIn(up);
  return p - sunIn * (depth / max(-dot(sunIn, up), 0.25));
}
// Caustics: the light the moving surface focuses at a depth, about 0.5 on average and up to 2, as a function of the
// point of the surface the light came through. Soft, wandering bands that break up into patches; they spread and
// blur with depth.
${caustic}
`;
}

/** Options of `liquidShaftsGlsl`. */
export interface LiquidShaftsOptions {
  /** Samples along each view ray (default 6). */
  samples?: number;
  /**
   * How the samples are spread per pixel: `'lattice'` (default) a pattern of lines, `'grain'` a hash of the pixel
   * without a direction (a pattern of lines can show as a hatch over open liquid with more samples).
   */
  jitter?: 'lattice' | 'grain';
}

/**
 * The light shafts, fragment stage only (`gl_FragCoord`); needs `liquidGlsl` before it. Gives `liquidShafts(eye, dir,
 * len, sun)`: for an eye under the surface, the sunlight scattered toward the eye along the view ray (from eye,
 * direction dir, len metres) where the surface above focused it, the caustics' pattern carried down along the
 * refracted sun, drifting with it; to be added to what the ray sees; 0 above the surface.
 */
export function liquidShaftsGlsl(options: LiquidShaftsOptions = {}): string {
  const jitter =
    options.jitter === 'grain'
      ? `  // A fixed grain per pixel spreads the samples (no time in it: the same frame for the same pose; no direction in
  // it either: a pattern of lines would show as a hatch over the open liquid).
  float j = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);`
      : `  // A fixed pattern per pixel spreads the samples (no time in it: the same frame for the same pose).
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));`;
  return /* glsl */ `
// Light shafts for an eye under the surface: the sunlight scattered toward the eye along the view ray (from eye,
// direction dir, len metres) where the surface above focused it: the caustics' pattern carried down along the
// refracted sun, drifting with it. Added to what the ray sees; 0 above the surface.
vec3 liquidShafts(vec3 eye, vec3 dir, float len, vec3 sun) {
  if (u_liquid.x >= 0.0) return vec3(0.0);
  vec3 up = localUp(eye);
  vec3 sunIn = liquidSunIn(up);
  float span = min(len, 30.0);
  const int N = ${Math.max(1, Math.round(options.samples ?? 6))};
  float stepM = span / float(N);
${jitter}
  float eyeDepth = -u_liquid.x;
  float rise = dot(dir, up);
  float down = max(-dot(sunIn, up), 0.25);
  float t = u_time.x;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float s = stepM * (float(i) + j);
    float depth = max(eyeDepth - rise * s, 0.0);
    vec2 plane = liquidPlane(eye + dir * s - sunIn * (depth / down));
    vec2 q = plane * (1.0 / 2.6);
    float c = smoothstep(0.55, 0.85, vnoise(q + vec2(0.21 * t, 0.06 * t), 93u));
    sum += c * liquidLightAt(depth) * mediumThrough(LIQUID_EXTINCTION, s);
  }
  float g = max(dot(dir, -sunIn), 0.0);
  float phase = 0.1 + 1.8 * pow(g, 8.0) + 0.5 * pow(g, 2.0);
  return sun * LIQUID_BODY * (sum * stepM * 0.3 * phase);
}
`;
}

/** The octaves of `liquidRipples`, written out: each with its cell, its turn and its share of the slope as constants. */
function rippleOctavesGlsl(r: LiquidRipples): string {
  const { octaves, largestM, step, turn, slope } = r;
  const k = (slope / Math.sqrt(octaves * SIMPLEX_GRADIENT_MEAN_SQUARE)).toFixed(5);
  const share = ((slope * slope) / octaves).toFixed(6);
  const lines: string[] = [];
  for (let o = 0; o < octaves; o++) {
    const cell = largestM * step ** o;
    const c = Math.cos(turn * o);
    const s = Math.sin(turn * o);
    // The lattice coordinates of the plane's point: turned, scaled to the cell, skewed.
    const m = [c, -s, s, c].map((v) => v / cell);
    const sk = (a: number, b: number): string => (a + (a + b) * LIQUID_SIMPLEX_SKEW).toFixed(5);
    const at = `u_liquidRipple${o >> 1}.${o % 2 === 0 ? 'xy' : 'zw'}`;
    lines.push(
      `  f = waveFade(${cell.toFixed(5)}, 2.5 * foot);`,
      '  if (f > 0.0) {',
      `    n = liquidSimplex(vec2(${sk(m[0]!, m[2]!)} * xz.x + ${sk(m[1]!, m[3]!)} * xz.y, ${sk(m[2]!, m[0]!)} * xz.x + ${sk(m[3]!, m[1]!)} * xz.y) + ${at}, ${o}u);`,
      `    g += (${k} * gust * f) * vec2(${c.toFixed(5)} * n.x + ${s.toFixed(5)} * n.y, ${c.toFixed(5)} * n.y - ${s.toFixed(5)} * n.x);`,
      ...(o === 0 ? ['    gust = clamp(1.0 + 1.2 * n.z, 0.4, 1.6);'] : []),
      '  }',
      `  unresolved += ${share} * (1.0 - f);`,
    );
  }
  return lines.join('\n');
}

/**
 * The ripples on the waves, any stage: the uniforms `u_liquidRipple0`… (where each octave's lattice lies under the
 * eye's foot, from `LiquidSurface.uniforms`), `liquidSimplex(ps, octave)` (simplex noise with its derivatives) and
 * `liquidRipples(xz, foot, out unresolved)`: the slope of the ripples at the plane's point xz, each octave faded where
 * a pixel covers too much of it (foot: the pixel's larger side on the plane, m), the finer ones stronger where the
 * largest rises (gusts); unresolved is the mean square slope of what has faded. Needs `<noise>` (`hashU`) and
 * `WAVES_GLSL` (`waveFade`) before it.
 */
export function liquidRipplesGlsl(r: LiquidRipples = LIQUID_RIPPLES): string {
  return /* glsl */ `
${Array.from({ length: Math.ceil(r.octaves / 2) }, (_, i) => `uniform vec4 u_liquidRipple${i};`).join('\n')}
// Simplex noise at the lattice coordinates ps (cells of 1, the lattice repeating after the ripples' period) with its
// derivatives: xy the gradient along the unskewed axes, z the value (within about ±0.9).
vec3 liquidSimplex(vec2 ps, uint octave) {
  vec2 s = floor(ps);
  vec2 f = ps - s;
  vec2 x0 = f - (f.x + f.y) * ${SIMPLEX_UNSKEW.toFixed(8)};
  vec2 e = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 x1 = x0 - e + ${SIMPLEX_UNSKEW.toFixed(8)};
  vec2 x2 = x0 - ${(1 - 2 * SIMPLEX_UNSKEW).toFixed(8)};
  uvec2 i = uvec2(ivec2(s) & ${r.period - 1});
  uvec2 ie = (i + uvec2(e)) & ${r.period - 1}u;
  uvec2 i1 = (i + 1u) & ${r.period - 1}u;
  uint o = octave << 24;
  uvec3 h = uvec3(hashU(i.x | i.y << 12 | o), hashU(ie.x | ie.y << 12 | o), hashU(i1.x | i1.y << 12 | o));
  vec3 gx = vec3(h & 0xffffu) * (2.0 / 65535.0) - 1.0;
  vec3 gy = vec3(h >> 16) * (2.0 / 65535.0) - 1.0;
  vec3 px = vec3(x0.x, x1.x, x2.x);
  vec3 py = vec3(x0.y, x1.y, x2.y);
  vec3 t = max(0.5 - px * px - py * py, 0.0);
  vec3 t2 = t * t;
  vec3 t4 = t2 * t2;
  vec3 gd = gx * px + gy * py;
  vec3 w = -8.0 * t2 * t * gd;
  return vec3(dot(t4, gx) + dot(w, px), dot(t4, gy) + dot(w, py), dot(t4, gd)) * 70.0;
}
// The slope of the ripples at xz: the derivatives of their height along the plane's axes. Each octave fades where a
// pixel covers too much of it (foot: the pixel's larger side on the plane, m); the finer ones are stronger where the
// largest rises (gusts). unresolved: the mean square slope of what has faded.
vec2 liquidRipples(vec2 xz, float foot, out float unresolved) {
  vec2 g = vec2(0.0);
  unresolved = 0.0;
  float gust = 1.0;
  float f;
  vec3 n;
${rippleOctavesGlsl(r)}
  return g;
}
`;
}

// --- The CPU side ------------------------------------------------------------------------------------------------

/** Options of a `LiquidSurface`. */
export interface LiquidSurfaceOptions {
  /** Radius of the level (the base sphere) in metres. */
  radiusM: number;
  /** The wind that raises the waves: its speed and the direction it blows from (degrees from north, clockwise). */
  wind: { speedMs: number; fromDeg: number };
  /** Factor on the heights of the wind's waves (default 1). */
  heightScale?: number;
  /** Radius in metres round the eye's foot that the near surface covers while the eye is low (default 500). */
  nearM?: number;
  /** The waves' heights fade out between these heights of the eye (m); above the upper one the near surface is off (default [60, 120]). */
  nearFadeM?: readonly [number, number];
  /** The look, for `glsl` and `clearM`. */
  look: LiquidLook;
  /** The ripples (default `LIQUID_RIPPLES`). */
  ripples?: LiquidRipples;
  /** Streams of the waves' and the ripples' random numbers (defaults 0x5ea7, 0x5ea8). */
  waveStream?: number;
  rippleStream?: number;
}

/** What the last `LiquidSurface.uniforms` computed. */
export interface LiquidState {
  /** Height of the eye above the moving surface (m, negative under it). */
  aboveSurfaceM: number;
  /** Height of the eye above the level. */
  aboveLevelM: number;
  /** Radius the near surface draws round the eye's foot, 0 while it is off. */
  nearM: number;
}

/** Axes of a face of the chart: n the face's normal, a and b its two axes (b the face's north). */
interface ChartFace {
  index: number;
  n: Vec3;
  a: Vec3;
  b: Vec3;
}
const cross = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const FACES: ChartFace[] = (
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
function faceOf(p: Vec3): ChartFace {
  const ax = Math.abs(p[0]);
  const ay = Math.abs(p[1]);
  const az = Math.abs(p[2]);
  if (ax >= ay && ax >= az) return FACES[p[0] >= 0 ? 0 : 1]!;
  if (ay >= az) return FACES[p[1] >= 0 ? 2 : 3]!;
  return FACES[p[2] >= 0 ? 4 : 5]!;
}

/** Coordinates in metres of a point (from the centre) in the plane of a face on a sphere of `radiusM`. */
function planeOf(face: ChartFace, p: Vec3, radiusM: number): [number, number] {
  const n = dot(p, face.n);
  return [radiusM * Math.atan(dot(p, face.a) / n), radiusM * Math.atan(dot(p, face.b) / n)];
}

/** The train with its length moved so that it passes a whole number of times in `loopS` seconds (deep water: ω² = g k). */
function loopedTrain(t: WaveTrain, loopS: number): WaveTrain {
  const omega = Math.sqrt((WAVE_GRAVITY * 2 * Math.PI) / t.lengthM);
  const turns = Math.max(1, Math.round((omega * loopS) / (2 * Math.PI)));
  const looped = (2 * Math.PI * turns) / loopS;
  return { ...t, lengthM: (2 * Math.PI * WAVE_GRAVITY) / (looped * looped) };
}

// The ripples drift: each octave at the speed of ripples of its size, round the wind. Where each octave's lattice
// lies under the eye's foot comes from the CPU in double (the lattice repeats after `period` cells), so the ripples
// stay put on the surface however far the eye has gone and however long the clock has run.

/** Surface tension over the density of water (m³/s²): the shortest ripples run faster than gravity alone moves them. */
const CAPILLARITY = 7.4e-5;
/** Angle between the drift of one octave and the wind, alternately to either side (radians). */
const RIPPLE_DRIFT_SPREAD = 0.35;

const v4 = (): { vec4: V4 } => ({ vec4: [0, 0, 0, 0] });

/**
 * A liquid below the level of a radial world with a moving surface (see the head of the file): the waves of a wind
 * per face of the chart, the height of the surface on the CPU and the uniforms of a frame for `liquidGlsl`,
 * `liquidRipplesGlsl`, `WAVES_GLSL` and the layers of `runtime`.
 */
export class LiquidSurface {
  readonly radiusM: number;
  readonly nearM: number;
  readonly nearFadeM: readonly [number, number];
  readonly look: LiquidLook;
  readonly ripples: LiquidRipples;
  /** Distance in metres at which the liquid hides everything behind it (`liquidClearDistance`). */
  readonly clearM: number;
  /** What `uniforms` computed last. */
  readonly state: LiquidState = { aboveSurfaceM: 1, aboveLevelM: 1, nearM: 0 };
  private readonly wind: { speedMs: number; fromDeg: number };
  private readonly heightScale: number;
  private readonly waveStream: number;
  private readonly rippleStream: number;
  private readonly trainCache = new Map<string, WaveTrain[]>();
  private glslMemo: string | null = null;
  private loopS = 0;
  private loopClockS = 0;
  private readonly common = { u_liquid: v4(), u_liquidFoot: v4(), u_liquidAxisA: v4(), u_liquidAxisB: v4(), u_liquidAxisN: v4(), u_liquidSlope: v4() } as Record<string, { vec4: V4 }>;
  private readonly waves: Record<string, { vec4: V4 }> = {};
  private readonly water: Uniforms = {};
  private readonly rippleAt: number[] = [];

  constructor(o: LiquidSurfaceOptions) {
    this.radiusM = o.radiusM;
    this.wind = { ...o.wind };
    this.heightScale = o.heightScale ?? 1;
    this.nearM = o.nearM ?? 500;
    this.nearFadeM = o.nearFadeM ?? [60, 120];
    this.look = o.look;
    this.ripples = o.ripples ?? LIQUID_RIPPLES;
    this.waveStream = o.waveStream ?? 0x5ea7;
    this.rippleStream = o.rippleStream ?? 0x5ea8;
    this.clearM = liquidClearDistance(o.look);
    if (o.look.loop) this.common.u_liquidLoop = v4();
  }

  /** `liquidGlsl` of the look. */
  get glsl(): string {
    return (this.glslMemo ??= liquidGlsl(this.look));
  }

  /**
   * Makes the surface repeat itself every `seconds` (0: free again): every train's length is moved to the nearest one
   * whose period divides that time (a few percent; the amplitudes stay). The time given to `uniforms` is then a time
   * of the loop. `clockS`: the seconds the animation clock (`u_time.x`) runs in one pass before it starts again; with
   * the look's `loop` the caustics, which drift by that clock, fade over to their start along the pass.
   */
  setLoop(seconds: number, clockS = 0): void {
    this.loopClockS = seconds > 0 ? clockS : 0;
    if (seconds === this.loopS) return;
    this.loopS = seconds;
    this.trainCache.clear();
  }

  /** The trains of a face of the chart (0–5) for a seed: the wind, its direction taken against the face's north. */
  trains(seed: number, face: number): WaveTrain[] {
    const key = `${seed}:${face}`;
    let t = this.trainCache.get(key);
    if (!t) {
      const toward = ((this.wind.fromDeg + 180) * Math.PI) / 180;
      t = waveTrains({ windSpeedMs: this.wind.speedMs, towardX: Math.sin(toward), towardZ: Math.cos(toward), seed: (seed ^ Math.imul(this.waveStream, face + 1)) >>> 0, heightScale: this.heightScale });
      const loopS = this.loopS;
      if (loopS > 0) t = t.map((train) => loopedTrain(train, loopS));
      this.trainCache.set(key, t);
    }
    return t;
  }

  /** Factor on the waves' heights for an eye `heightM` above the level: 1 low down, 0 from the upper fade height up. */
  waveFactor(heightM: number): number {
    const x = Math.min(1, Math.max(0, (heightM - this.nearFadeM[0]) / (this.nearFadeM[1] - this.nearFadeM[0])));
    return 1 - x * x * (3 - 2 * x);
  }

  /**
   * Height in metres of the moving surface above the level over the point `p` (world metres from the centre) at
   * `timeS`, with the waves as tall as an eye at `eyeHeightM` sees them (default: full). A pure function.
   */
  surfaceHeight(seed: number, p: Vec3, timeS: number, eyeHeightM = 0): number {
    const f = this.waveFactor(eyeHeightM);
    if (f <= 0) return 0;
    const face = faceOf(p);
    const [x, z] = planeOf(face, p, this.radiusM);
    return f * waveHeight(this.trains(seed, face.index), x, z, timeS);
  }

  /**
   * The uniforms of a frame: `common` for every material and layer that uses `liquidGlsl` (with `u_liquidSlope`, xy
   * the slope of the surface at the eye's foot along the plane's axes), `water` for the surface's own materials
   * (common, the trains of `waveUniforms` and the ripples' `u_liquidRipple0`…). `eye` and `origin` are world positions
   * (the render origin) from the sphere's centre, the time the animation time. The same objects are rewritten every
   * call, so a frame allocates nothing; a caller may add uniforms of its own to them.
   */
  uniforms(seed: number, eye: Vec3, origin: Vec3, timeS: number): { common: Uniforms; water: Uniforms } {
    const radiusM = this.radiusM;
    const r = Math.hypot(eye[0], eye[1], eye[2]) || 1;
    const aboveLevel = r - radiusM;
    const foot: Vec3 = [(eye[0] / r) * radiusM, (eye[1] / r) * radiusM, (eye[2] / r) * radiusM];
    const face = faceOf(foot);
    const f = this.waveFactor(aboveLevel);
    const trains = this.trains(seed, face.index);
    const [x0, z0] = planeOf(face, foot, radiusM);
    const surface = f > 0 ? f * waveHeight(trains, x0, z0, timeS) : 0;
    // The slope of the surface at the eye's foot, for the line across the lens.
    const e = 0.05;
    const slopeA = f > 0 && aboveLevel < 3 ? (f * (waveHeight(trains, x0 + e, z0, timeS) - waveHeight(trains, x0 - e, z0, timeS))) / (2 * e) : 0;
    const slopeB = f > 0 && aboveLevel < 3 ? (f * (waveHeight(trains, x0, z0 + e, timeS) - waveHeight(trains, x0, z0 - e, timeS))) / (2 * e) : 0;
    const near = aboveLevel < this.nearFadeM[1] ? this.nearM : 0;
    this.state.aboveSurfaceM = aboveLevel - surface;
    this.state.aboveLevelM = aboveLevel;
    this.state.nearM = near;
    const c = this.common;
    c.u_liquid!.vec4 = [aboveLevel - surface, aboveLevel, near, f];
    c.u_liquidFoot!.vec4 = [foot[0] - origin[0], foot[1] - origin[1], foot[2] - origin[2], radiusM];
    c.u_liquidAxisA!.vec4 = [face.a[0], face.a[1], face.a[2], dot(foot, face.a)];
    c.u_liquidAxisB!.vec4 = [face.b[0], face.b[1], face.b[2], dot(foot, face.b)];
    c.u_liquidAxisN!.vec4 = [face.n[0], face.n[1], face.n[2], dot(foot, face.n)];
    c.u_liquidSlope!.vec4 = [slopeA, slopeB, 0, 0];
    if (c.u_liquidLoop) c.u_liquidLoop.vec4 = [this.loopClockS, this.loopS > 0 ? timeS / this.loopS - Math.floor(timeS / this.loopS) : 0, 0, 0];
    waveUniforms(trains, timeS, x0, z0, this.waves);
    this.rippleOffsets(seed, x0, z0, timeS);
    const n = Math.ceil(this.ripples.octaves / 2);
    for (let i = 0; i < n; i++) {
      const v = (this.waves[`u_liquidRipple${i}`] ??= v4()).vec4;
      for (let j = 0; j < 4; j++) v[j] = this.rippleAt[4 * i + j] ?? 0;
    }
    Object.assign(this.water, c, this.waves);
    return { common: c, water: this.water };
  }

  /**
   * Where each ripple octave's lattice lies at the plane's point (x0, z0) at `timeS`: two numbers per octave, in its
   * cells, within one period.
   */
  private rippleOffsets(seed: number, x0: number, z0: number, timeS: number): void {
    const toward = ((this.wind.fromDeg + 180) * Math.PI) / 180;
    const { octaves, largestM, step, turn, period } = this.ripples;
    const out = this.rippleAt;
    for (let o = 0; o < octaves; o++) {
      const cell = largestM * step ** o;
      // Ripples about a cell long: their speed on the surface.
      const k = (2 * Math.PI) / cell;
      const speed = Math.sqrt(WAVE_GRAVITY / k + CAPILLARITY * k);
      const dir = toward + (o % 2 === 0 ? 1 : -1) * RIPPLE_DRIFT_SPREAD;
      const x = x0 - Math.sin(dir) * speed * timeS;
      const z = z0 - Math.cos(dir) * speed * timeS;
      // Turned and scaled to the cell, then skewed onto the simplex lattice (as `liquidRipplesGlsl`).
      const c = Math.cos(turn * o);
      const s = Math.sin(turn * o);
      const u = (c * x - s * z) / cell;
      const v = (s * x + c * z) / cell;
      for (let j = 0; j < 2; j++) {
        const q = (j === 0 ? u : v) + (u + v) * LIQUID_SIMPLEX_SKEW + period * unit(hashInts(seed, this.rippleStream, o, j));
        out[2 * o + j] = q - period * Math.floor(q / period);
      }
    }
  }
}
