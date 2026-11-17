// Shared GLSL pieces: the header with the uniform blocks every program sees, and noise from an integer hash.
// The Frame block holds what the renderer fills (view, light, shadow map) plus slots that the renderer's owner fills
// (`Renderer.frameSlots`), declared through `shaderHeader`. The slot positions inside the block are part of the layout.

import type { DepthMode } from '../base/view.ts';
import { PALETTE_CAPACITY } from '../core/palette.ts';

/** GLSL member declarations (vec4 only) of the owner's slots in the Frame block. */
export interface FrameSlotsGlsl {
  /** Right after the light direction. */
  afterLight: string;
  /** After the view axes, at the end of the block. */
  afterView: string;
}

/** Number of vec4 members in each slot. */
export interface FrameSlotSizes {
  afterLight: number;
  afterView: number;
}

/** Size of the Frame block in floats (std140, all vec4 and mat4). */
export function frameBlockFloats(slots: FrameSlotSizes): number {
  return 16 * 2 + 4 * (5 + slots.afterLight + slots.afterView);
}

/**
 * What a renderer option adds to the program header: `#define` lines right after the version line, and members
 * (vec4 and mat4 only) at the very end of the Frame block, after every slot. Both empty by default.
 */
export interface HeaderExtra {
  defines?: string;
  frameTail?: string;
}

/**
 * Program header: version, precision, the Frame block with the given slots and the Palette block. In a depth mode
 * other than `'standard'` it also defines `WH_DEPTH_REVERSED` or `WH_DEPTH_LOGARITHMIC` (to 1), for the rare shader
 * that reads depth values of the main target itself.
 */
export function shaderHeader(slots: FrameSlotsGlsl = { afterLight: '', afterView: '' }, depth: DepthMode = 'standard', extra: HeaderExtra = {}): string {
  const mode = depth === 'reversed' ? '#define WH_DEPTH_REVERSED 1\n' : depth === 'logarithmic' ? '#define WH_DEPTH_LOGARITHMIC 1\n' : '';
  return /* glsl */ `#version 300 es
${mode}${extra.defines ?? ''}precision highp float;
precision highp int;
precision highp sampler2DShadow;
precision highp usampler2D;

layout(std140) uniform Frame {
  mat4 u_viewProj;
  mat4 u_lightViewProj;
  vec4 u_sunDir;      // xyz direction to the main directional light, w used part of the shadow map (0–1)
${slots.afterLight}  vec4 u_view;        // x metres per screen pixel, y metres per shadow map texel, z shadow softening radius in texels, w 1/shadow map size
  vec4 u_camRight;    // xyz screen right, w pixel growth: metres per pixel gained per metre of depth (0 orthographic)
  vec4 u_camUp;       // xyz screen up, w logarithmic depth scale 1/log2(1 + far) (0: depth is not logarithmic)
  vec4 u_camForward;  // xyz view direction, w depth at which u_view.x applies
${slots.afterView}${extra.frameTail ?? ''}};

layout(std140) uniform Palette {
  vec4 u_palette[${PALETTE_CAPACITY}];
};
`;
}

/**
 * Local up, shader side. Appended to every program header, so any shader may ask which way is up at a point of render
 * space instead of assuming +y:
 *
 * - `localUp(p)`: unit up at `p`.
 * - `localHeight(p)`: height of `p` above the base surface.
 * - `localFrame(p)`: three axes at `p` as the columns of a matrix; the middle one is up, the other two span the
 *   horizon. A point given along x, up and z of an upright object is `p + localFrame(p) * q`.
 *
 * By default up is +y, the height is `p.y` and the frame is the identity. A renderer made with `radialUp` defines
 * `WH_LOCAL_UP` and fills `u_upCenter`, the last member of the Frame block: up then points away from that point, and
 * the frame is the world's axes turned by the shortest rotation that takes +y to up (`upFrame` of base is the same
 * frame on the CPU).
 */
export const LOCAL_UP_DEFINE = '#define WH_LOCAL_UP 1\n';
export const LOCAL_UP_MEMBER = '  vec4 u_upCenter;    // xyz the point up points away from, in render space, w radius of the base surface\n';
/** Floats `LOCAL_UP_MEMBER` adds to the end of the Frame block. */
export const LOCAL_UP_FLOATS = 4;
export const LOCAL_UP_GLSL = /* glsl */ `
#ifdef WH_LOCAL_UP
vec3 localUp(vec3 p) { return normalize(p - u_upCenter.xyz); }
float localHeight(vec3 p) { return length(p - u_upCenter.xyz) - u_upCenter.w; }
mat3 localFrame(vec3 p) {
  vec3 u = localUp(p);
  // Opposite to +y the shortest rotation is not defined: half a turn about x.
  if (u.y < -0.99999) return mat3(1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0);
  // k = 1 / (1 + u.y). Below the horizon it is taken as (1 - u.y) / (u.x * u.x + u.z * u.z), the same number for a
  // unit vector: 1 + u.y loses its digits near -y, and the frame would be sheared by a percent there.
  float h = u.x * u.x + u.z * u.z;
  float k = u.y > 0.0 || h == 0.0 ? 1.0 / (1.0 + u.y) : (1.0 - u.y) / h;
  return mat3(1.0 - u.x * u.x * k, -u.x, -u.x * u.z * k, u.x, u.y, u.z, -u.x * u.z * k, -u.z, 1.0 - u.z * u.z * k);
}
#else
vec3 localUp(vec3 p) { return vec3(0.0, 1.0, 0.0); }
float localHeight(vec3 p) { return p.y; }
mat3 localFrame(vec3 p) { return mat3(1.0); }
#endif
`;

/**
 * Logarithmic depth, fragment side. A fragment shader drawn into the main target gets the prelude right after the
 * header and the epilogue at its end (`Renderer.resolve` does both): the shader's own `main` becomes
 * `whMaterialMain`, and the real `main` calls it and then writes depth from the distance along the view, which the
 * rasteriser carries in `gl_FragCoord.w`. No varying is involved, so any vertex shader fits. The polygon offset of the
 * draw state arrives as `u_whDepthBias` (factor, units), because the pipeline's own offset does not reach a depth the
 * shader writes.
 */
export const LOG_DEPTH_PRELUDE = /* glsl */ `uniform vec2 u_whDepthBias;
#define main whMaterialMain
`;

export const LOG_DEPTH_EPILOGUE = /* glsl */ `
#undef main
void main() {
  whMaterialMain();
  // Orthographic views and programs outside the 3D scene (u_camUp.w = 0) keep the depth of the pipeline.
  float d = u_camUp.w > 0.0 ? log2(1.0 + max(1.0 / gl_FragCoord.w, 0.0)) * u_camUp.w : gl_FragCoord.z;
  float slope = max(abs(dFdx(d)), abs(dFdy(d)));
  // 1.2e-7: the smallest step a 32-bit float depth resolves near 1.
  gl_FragDepth = clamp(d + u_whDepthBias.x * slope + u_whDepthBias.y * 1.2e-7, 0.0, 1.0);
}
`;

export const NOISE = /* glsl */ `
// Noise from an integer hash. Never from the sine function: it gives different results on different GPUs.
uint hashU(uint x) {
  x ^= x >> 16; x *= 0x7feb352dU;
  x ^= x >> 15; x *= 0x846ca68bU;
  x ^= x >> 16;
  return x;
}
float hash1(uint x) { return float(hashU(x)) * (1.0 / 4294967296.0); }
float hash2(ivec2 p, uint seed) {
  return float(hashU(uint(p.x) * 0x9e3779b1U ^ hashU(uint(p.y) + seed * 0x85ebca6bU))) * (1.0 / 4294967296.0);
}
float hash3(ivec3 p, uint seed) {
  return float(hashU(uint(p.x) * 0x9e3779b1U ^ hashU(uint(p.y) * 0xc2b2ae35U ^ hashU(uint(p.z) + seed)))) * (1.0 / 4294967296.0);
}
// Smooth value noise, 0–1.
float vnoise(vec2 p, uint seed) {
  vec2 f = floor(p);
  ivec2 i = ivec2(f);
  vec2 t = p - f;
  t = t * t * (3.0 - 2.0 * t);
  float a = hash2(i, seed), b = hash2(i + ivec2(1, 0), seed);
  float c = hash2(i + ivec2(0, 1), seed), d = hash2(i + ivec2(1, 1), seed);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
float vnoise3(vec3 p, uint seed) {
  vec3 f = floor(p);
  ivec3 i = ivec3(f);
  vec3 t = p - f;
  t = t * t * (3.0 - 2.0 * t);
  float a = mix(hash3(i, seed), hash3(i + ivec3(1, 0, 0), seed), t.x);
  float b = mix(hash3(i + ivec3(0, 1, 0), seed), hash3(i + ivec3(1, 1, 0), seed), t.x);
  float c = mix(hash3(i + ivec3(0, 0, 1), seed), hash3(i + ivec3(1, 0, 1), seed), t.x);
  float d = mix(hash3(i + ivec3(0, 1, 1), seed), hash3(i + ivec3(1, 1, 1), seed), t.x);
  return mix(mix(a, b, t.y), mix(c, d, t.y), t.z);
}
// How visible a detail of size cellM metres still is: 1 = sharp, 0 = the pattern should vanish.
// Applies to smooth noise: fully visible from two pixels per cell, around one pixel not at all,
// because it would fight with the screen grid and flicker when panning. Patterns with a sharp edge
// (grids, stripes) have a stricter rule of their own.
float detailVisible(float cellM) {
  return 1.0 - smoothstep(0.5, 0.9, u_view.x / cellM);
}
// Size of one screen pixel at a world point, in metres. Constant for an orthographic view, grows with depth in perspective.
float metresPerPixelAt(vec3 worldPos) {
  return max(u_view.x + u_camRight.w * (dot(worldPos, u_camForward.xyz) - u_camForward.w), 1e-4);
}
// detailVisible at a world point: the same rule with the pixel size there, for perspective views.
float detailVisibleAt(float cellM, vec3 worldPos) {
  return 1.0 - smoothstep(0.5, 0.9, metresPerPixelAt(worldPos) / cellM);
}
`;
