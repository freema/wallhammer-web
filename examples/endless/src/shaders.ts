// Materials of the endless world. Cell data are relative to the cell origin; every program adds `u_cellOffset`
// (cell origin − render origin, computed in double on the CPU), so the GPU only ever sees small numbers.
// Surface detail uses value noise that repeats every 1,024 m: the render origin moves in whole 1,024 m steps, so the
// pattern stays fixed to the world when the origin moves, and the numbers fed to it stay small far from the origin.

import type { MaterialDesc } from 'wallhammer-web/base';
import { CELL_MORPH_ATTRIBS, CELL_MORPH_GLSL, CELL_SURFACE_ATTRIBS, STRIP_ATTRIBS, STRIP_GLSL } from 'wallhammer-web/gen-mesh';

export const PROP_ATTRIBS = { a_pos: 0, a_normal: 1, i_base: 2, i_shape: 3, i_color: 4 } as const;
export const PROP_MORPH_ATTRIBS = { ...PROP_ATTRIBS, i_coarseShift: 5, i_coarseSize: 6 } as const;

/** Periodic value noise: `p` in lattice units, the lattice wraps every `mask + 1` cells. */
const PERIODIC = /* glsl */ `
float pnoise(vec2 p, int mask, uint seed) {
  vec2 f = floor(p);
  ivec2 i = ivec2(f);
  vec2 t = p - f;
  t = t * t * (3.0 - 2.0 * t);
  float a = hash2(i & mask, seed), b = hash2((i + ivec2(1, 0)) & mask, seed);
  float c = hash2((i + ivec2(0, 1)) & mask, seed), d = hash2((i + ivec2(1, 1)) & mask, seed);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
// Tint by quadtree level, for the level view (key L).
vec3 levelTint(float level) {
  float k = mod(level, 6.0);
  return k < 1.0 ? vec3(1.0, 0.45, 0.4) : k < 2.0 ? vec3(1.0, 0.8, 0.35) : k < 3.0 ? vec3(0.5, 0.95, 0.45)
       : k < 4.0 ? vec3(0.4, 0.85, 1.0) : k < 5.0 ? vec3(0.6, 0.55, 1.0) : vec3(1.0, 0.5, 0.95);
}
`;

const TERRAIN_VS = /* glsl */ `#include <header>
uniform vec3 u_cellOffset;
in vec3 a_pos;
in vec4 a_normal; // xyz normal (int16), w: 0 surface, 1 skirt
in vec4 a_color;  // rgb colour, a: 1 water
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
void main() {
  v_world = a_pos + u_cellOffset;
  v_normal = a_normal.xyz;
  v_color = a_color;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const TERRAIN_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
${PERIODIC}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec3 v_normal;
in vec4 v_color;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 col = v_color.rgb;
  float water = step(0.5, v_color.a);
  // Fine grain on land: two octaves of periodic noise, faded out where a pixel covers more than the grain.
  float g = pnoise(v_world.xz / 8.0, 127, 31u) * 0.6 + pnoise(v_world.xz / 2.0, 511, 32u) * 0.4 * detailVisibleAt(2.0, v_world);
  col *= mix(0.88 + 0.24 * g * detailVisibleAt(8.0, v_world), 1.0, water);
  col = mix(col, u_snow.rgb, (1.0 - water) * u_weather.x * smoothstep(0.6, 0.9, n.y));
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, n, 1.2);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  if (water > 0.5) {
    // Water: slow ripples tilt the normal, Fresnel mirrors the sky.
    vec3 toEye = skyToEye(v_world);
    vec2 r = vec2(pnoise(v_world.xz / 4.0, 255, 41u), pnoise(v_world.xz / 4.0 + 17.0, 255, 42u)) - 0.5;
    vec3 nr = normalize(vec3(r.x * 0.12, 1.0, r.y * 0.12));
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(nr, toEye), 0.0), 5.0);
    c = mix(c, skyColorDir(reflect(-toEye, nr)), 0.85 * fres);
  }
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const TERRAIN_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
uniform vec3 u_cellOffset;
in vec3 a_pos;
void main() {
  gl_Position = u_lightRender * vec4(a_pos + u_cellOffset, 1.0);
}`;

const DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
void main() {}`;

/** Instance transform shared by the colour and the depth program. */
const PROP_TRANSFORM = /* glsl */ `
uniform vec3 u_cellOffset;
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_base;   // xyz base point (cell-local), w reach radius
in vec4 i_shape;  // x height, y yaw, z width, w depth (0 = width)
in vec4 i_color;  // rgb colour, w variant
vec3 propScale() { return vec3(i_shape.z, i_shape.x, i_shape.w > 0.0 ? i_shape.w : i_shape.z); }
mat3 propTurn() {
  float c = cos(i_shape.y), s = sin(i_shape.y);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
vec3 propWorld() { return i_base.xyz + u_cellOffset + propTurn() * (a_pos * propScale()); }
`;

const PROP_VS = /* glsl */ `#include <header>
${PROP_TRANSFORM}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_up;
out float v_variant;
void main() {
  v_world = propWorld();
  v_normal = propTurn() * normalize(a_normal / propScale());
  v_color = i_color.rgb;
  v_up = a_pos.y;
  v_variant = i_color.w;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const PROP_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
${PERIODIC}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_up;
in float v_variant;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float grain = pnoise(v_world.xz * 2.0 + v_world.y * 2.0, 2047, 51u) * detailVisibleAt(0.7, v_world);
  vec3 col = v_color * (0.86 + 0.24 * grain);
  // Strata on tall rock: bands by height.
  col *= 0.92 + 0.08 * sin(v_world.y * 0.9 + grain * 2.0);
  col = mix(col, u_snow.rgb, max(u_weather.x, step(0.5, v_variant) * 0.35) * smoothstep(0.45, 0.85, n.y));
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.3, v_up));
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, ao));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const PROP_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
${PROP_TRANSFORM}
void main() {
  gl_Position = u_lightRender * vec4(propWorld(), 1.0);
}`;

// --- Smooth levels (lod=smooth) --------------------------------------------------------------------------------------
// The same materials for cells of `generateSmoothCell`: the vertex shaders move every vertex (and every instance)
// between its own place and its place on the level one coarser, by the distance from the viewer. The fragment shaders
// are the ones above. The streamed world sets the uniforms of `CELL_MORPH_GLSL` when its `morph` option is on.

const TERRAIN_MORPH_VS = /* glsl */ `#include <header>
uniform vec3 u_cellOffset;
${CELL_MORPH_GLSL}
in vec3 a_pos;
in vec4 a_normal; // xyz normal (int16), w: 0 surface, 1 skirt
in vec4 a_color;  // rgb colour, a: 1 water
in float a_coarseShift;  // metres up to the surface of the coarser level
in vec4 a_coarseNormal;  // its normal there (int16)
in vec4 a_coarseColor;   // its colour there
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
void main() {
  vec3 p = a_pos + u_cellOffset;
  float m = cellMorph(p);
  p += u_morphUp * (a_coarseShift * m);
  v_world = p;
  v_normal = mix(a_normal.xyz, a_coarseNormal.xyz, m);
  v_color = mix(a_color, a_coarseColor, m);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const TERRAIN_MORPH_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
uniform vec3 u_cellOffset;
${CELL_MORPH_GLSL}
in vec3 a_pos;
in float a_coarseShift;
void main() {
  vec3 p = a_pos + u_cellOffset;
  p += u_morphUp * (a_coarseShift * cellMorph(p));
  gl_Position = u_lightRender * vec4(p, 1.0);
}`;

/**
 * `PROP_TRANSFORM` with the base point moved to where the instance stands at the current blend, and the instance
 * scaled to its size there: one that the coarser level does not hold grows from nothing as its cell takes its own shape.
 */
const PROP_MORPH_TRANSFORM = /* glsl */ `
uniform vec3 u_cellOffset;
${CELL_MORPH_GLSL}
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_base;   // xyz base point (cell-local), w reach radius
in vec4 i_shape;  // x height, y yaw, z width, w depth (0 = width)
in vec4 i_color;  // rgb colour, w variant
in float i_coarseShift; // metres up to the base point on the coarser level
in float i_coarseSize;  // size on the coarser level: 1 the same, 0 not there
vec3 propScale() { return vec3(i_shape.z, i_shape.x, i_shape.w > 0.0 ? i_shape.w : i_shape.z); }
mat3 propTurn() {
  float c = cos(i_shape.y), s = sin(i_shape.y);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
vec3 propWorld() {
  vec3 base = i_base.xyz + u_cellOffset;
  float m = cellMorph(base);
  base += u_morphUp * (i_coarseShift * m);
  return base + propTurn() * (a_pos * propScale() * mix(1.0, i_coarseSize, m));
}
`;

const PROP_MORPH_VS = /* glsl */ `#include <header>
${PROP_MORPH_TRANSFORM}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_up;
out float v_variant;
void main() {
  v_world = propWorld();
  v_normal = propTurn() * normalize(a_normal / propScale());
  v_color = i_color.rgb;
  v_up = a_pos.y;
  v_variant = i_color.w;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const PROP_MORPH_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
${PROP_MORPH_TRANSFORM}
void main() {
  gl_Position = u_lightRender * vec4(propWorld(), 1.0);
}`;

export const TERRAIN_MORPH_MATERIAL: MaterialDesc = {
  name: 'terrain-morph',
  attribs: CELL_MORPH_ATTRIBS,
  passes: { color: { vs: TERRAIN_MORPH_VS, fs: TERRAIN_FS }, shadow: { vs: TERRAIN_MORPH_DEPTH_VS, fs: DEPTH_FS } },
};

export const PROP_MORPH_MATERIAL: MaterialDesc = {
  name: 'prop-morph',
  attribs: PROP_MORPH_ATTRIBS,
  passes: { color: { vs: PROP_MORPH_VS, fs: PROP_FS }, shadow: { vs: PROP_MORPH_DEPTH_VS, fs: DEPTH_FS } },
};

export const TERRAIN_MATERIAL: MaterialDesc = {
  name: 'terrain',
  attribs: CELL_SURFACE_ATTRIBS,
  passes: { color: { vs: TERRAIN_VS, fs: TERRAIN_FS }, shadow: { vs: TERRAIN_DEPTH_VS, fs: DEPTH_FS } },
};

export const PROP_MATERIAL: MaterialDesc = {
  name: 'prop',
  attribs: PROP_ATTRIBS,
  passes: { color: { vs: PROP_VS, fs: PROP_FS }, shadow: { vs: PROP_DEPTH_VS, fs: DEPTH_FS } },
};

// --- Strips (strip=1, strips.ts) -------------------------------------------------------------------------------------
// The strip of a cell of `generateStripCell` blends between levels like the surface (`cellMorph`), then `stripWiden`
// keeps it at least STRIP_MIN_PX pixels wide. Lit with up, the sun and the fog as the surface; coloured by line.

/** Least width of a strip on the screen, in pixels. */
export const STRIP_MIN_PX = 1.6;

const STRIP_VS = /* glsl */ `#include <header>
#include <noise>
uniform vec3 u_cellOffset;
${CELL_MORPH_GLSL}
${STRIP_GLSL}
in vec3 a_pos;
in float a_coarseShift;
in vec3 a_side;
in vec4 a_strip; // across, metres along, half-width, line
out vec3 v_world;
out vec4 v_strip;
void main() {
  vec3 p = a_pos + u_cellOffset;
  p += u_morphUp * (a_coarseShift * cellMorph(p));
  float grow;
  p = stripWiden(p, a_side, a_strip, ${STRIP_MIN_PX.toFixed(2)}, grow);
  v_world = p;
  v_strip = a_strip;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const STRIP_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
${PERIODIC}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec4 v_strip;
out vec4 o_color;
void main() {
  vec3 n = vec3(0.0, 1.0, 0.0);
  float line = floor(v_strip.w + 0.5);
  vec3 col = line < 0.5 ? vec3(0.32, 0.31, 0.30) : line < 1.5 ? vec3(0.52, 0.42, 0.30) : vec3(0.44, 0.40, 0.36);
  // The hem beyond the edge is the bare side of the bank.
  col = mix(col, vec3(0.36, 0.30, 0.22), step(1.0001, abs(v_strip.x)));
  float g = pnoise(v_world.xz / 1.5, 1023, 61u);
  col *= 0.92 + 0.16 * g * detailVisibleAt(1.5, v_world);
  col = mix(col, u_snow.rgb, u_weather.x);
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

/** The strips of a cell made by `generateStripCell`, colour pass only; needs `u_showLevels`. */
export const STRIP_MATERIAL: MaterialDesc = {
  name: 'strip',
  attribs: STRIP_ATTRIBS,
  passes: { color: { vs: STRIP_VS, fs: STRIP_FS } },
};

// --- Structures of the damage demo (dmg=1, structures.ts) ------------------------------------------------------------
// Flat shaded blocks and rubble heaps of `STRUCTURE_LAYOUT`: a position relative to the cell, one normal per face and a
// colour per part (alpha 1 for rubble, which gets a coarser grain). They do not blend between levels: they appear at
// level 7 at once.

export const STRUCTURE_ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2 } as const;

const STRUCTURE_VS = /* glsl */ `#include <header>
uniform vec3 u_cellOffset;
in vec3 a_pos;
in vec4 a_normal;
in vec4 a_color;
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
void main() {
  v_world = a_pos + u_cellOffset;
  v_normal = a_normal.xyz;
  v_color = a_color;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const STRUCTURE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
${PERIODIC}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec3 v_normal;
in vec4 v_color;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float scale = mix(0.5, 0.25, v_color.a);
  float g = pnoise(v_world.xz / scale + v_world.y / scale, 2047, 71u) * detailVisibleAt(scale, v_world);
  vec3 col = v_color.rgb * (0.9 + 0.18 * g);
  col = mix(col, u_snow.rgb, u_weather.x * smoothstep(0.6, 0.9, n.y));
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, n, 0.6);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const STRUCTURE_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
uniform vec3 u_cellOffset;
in vec3 a_pos;
void main() {
  gl_Position = u_lightRender * vec4(a_pos + u_cellOffset, 1.0);
}`;

/** The structures of cells made by `generateDamageCell`; needs `u_showLevels`. */
export const STRUCTURE_MATERIAL: MaterialDesc = {
  name: 'structure',
  attribs: STRUCTURE_ATTRIBS,
  passes: { color: { vs: STRUCTURE_VS, fs: STRUCTURE_FS }, shadow: { vs: STRUCTURE_DEPTH_VS, fs: DEPTH_FS } },
};
