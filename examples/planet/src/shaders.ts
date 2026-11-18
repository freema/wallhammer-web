// Materials of the planet example. Cell data are relative to the cell origin with the world's axes; every program adds
// `u_cellOffset` (cell origin − render origin, computed in double on the CPU). Nothing here assumes that up is +y:
// up, the height and the frame of an upright object come from the header's `localUp`, `localHeight` and `localFrame`
// (the renderer is made with `radialUp`), and the blend between levels from `SPHERE_PATCH_GLSL`.
//
// The surface mixes in the cover baked into its vertices where the objects are no longer drawn, and the objects leave
// one by one over the blend band of the coarsest level that has them (`coverFade`, `coverKeep` of core), so nothing
// appears or vanishes at once on the way up or down.
//
// With the engine's atmosphere the include `<atmosphere>` defines WH_ATMOSPHERE: the light on a surface then comes
// from `atmosphereLight`, and the air in front of it is taken at the vertices (`atmosphereAir`) and applied to the
// fragments (`atmosphereApply`). Without it (`atm=0`) the include holds only stand-ins of those two that change
// nothing, and the light comes from `<lighting>`.

import type { MaterialDesc } from 'wallhammer-web/base';
import { COVER_FADE_GLSL } from 'wallhammer-web/core';
import { SPHERE_PATCH_COVER_ATTRIBS, SPHERE_PATCH_GLSL } from 'wallhammer-web/gen-core';
import { STRIP_ATTRIBS, STRIP_GLSL } from 'wallhammer-web/gen-mesh';

export const OBJECT_ATTRIBS = { a_pos: 0, a_normal: 1, i_base: 2, i_shape: 3, i_color: 4, i_coarseShift: 5 } as const;

const COMMON_FS = /* glsl */ `
// Position for patterns fixed to the world: relative to the centre of the sphere, so it does not move with the
// render origin.
vec3 patternPos(vec3 worldPos) {
#ifdef WH_LOCAL_UP
  return worldPos - u_upCenter.xyz;
#else
  return worldPos;
#endif
}
// Tint by quadtree level, for the level view (key L).
vec3 levelTint(float level) {
  float k = mod(level, 6.0);
  return k < 1.0 ? vec3(1.0, 0.45, 0.4) : k < 2.0 ? vec3(1.0, 0.8, 0.35) : k < 3.0 ? vec3(0.5, 0.95, 0.45)
       : k < 4.0 ? vec3(0.4, 0.85, 1.0) : k < 5.0 ? vec3(0.6, 0.55, 1.0) : vec3(1.0, 0.5, 0.95);
}
`;

const TERRAIN_VS = /* glsl */ `#include <header>
#include <atmosphere>
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${COVER_FADE_GLSL}
uniform float u_cellLevel;
uniform float u_coverLevel; // coarsest level whose cells hold the objects the cover stands for
in vec3 a_pos;
in vec4 a_normal; // xyz normal (int16), w: 0 surface, 1 skirt
in vec4 a_color;  // rgb colour, a: 1 sea
in float a_coarseShift;  // metres along up to the surface of the coarser level
in vec4 a_coarseNormal;  // its normal there (int16)
in vec4 a_coarseColor;   // its colour there
in vec4 a_cover;         // rgb what the objects on the surface look like from afar, a the share they hide
in vec4 a_coarseCover;   // the same on the coarser level
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
out vec4 v_cover; // rgb the cover, a its share at this distance
out vec3 v_air;        // light the air between the eye and the vertex scatters toward the eye
out vec3 v_airThrough; // share of the surface's colour that passes that air
void main() {
  vec3 p = a_pos + u_cellOffset;
  float m = spherePatchMorph(p);
  p += localUp(p) * (a_coarseShift * m);
  v_world = p;
  v_air = atmosphereAir(p, v_airThrough);
  v_normal = mix(a_normal.xyz, a_coarseNormal.xyz, m);
  v_color = mix(a_color, a_coarseColor, m);
  v_cover = mix(a_cover, a_coarseCover, m);
  v_cover.a *= coverFade(u_coverLevel, u_cellLevel, m);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const TERRAIN_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec3 v_normal;
in vec4 v_color;
in vec4 v_cover;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 up = localUp(v_world);
  float sea = step(0.5, v_color.a);
  // The far look of the objects that stand on the land.
  vec3 col = mix(v_color.rgb, v_cover.rgb, v_cover.a * (1.0 - sea));
  // Fine grain on land: two octaves of noise in space, faded out where a pixel covers more than the grain.
  vec3 q = patternPos(v_world);
  float g = vnoise3(q / 8.0, 31u) * 0.6 + vnoise3(q / 2.0, 32u) * 0.4 * detailVisibleAt(2.0, v_world);
  col *= mix(0.88 + 0.24 * g * detailVisibleAt(8.0, v_world), 1.0, sea);
  col = mix(col, u_snow.rgb, (1.0 - sea) * u_weather.x * smoothstep(0.6, 0.9, dot(n, up)));
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, n, 1.2);
#ifdef WH_ATMOSPHERE
  // The light of the place: the sun through the air above it and the sky there, so the far side of the sphere is dark.
  vec3 lit = col * atmosphereLight(v_world, n, sun, 1.0);
  vec3 h = normalize(u_atmSun.xyz - u_camForward.xyz);
  // The glint on the sea; the sun's colour there is looked up only where there is a glint.
  float glint = sea * sun * 0.3 * pow(max(dot(up, h), 0.0), 90.0);
  if (glint > 0.0) lit += atmosphereSun(v_world) * glint;
#else
  vec3 lit = col * u_warmTint.rgb * lightOnAt(v_world, n, sun, 1.0);
  // The sea: a soft glint of the light.
  vec3 h = normalize(u_sunDir.xyz - u_camForward.xyz);
  lit += u_sunColor.rgb * (sea * sun * 0.3 * pow(max(dot(up, h), 0.0), 90.0));
#endif
  o_color = vec4(atmosphereApply(applyFog(toDisplay(lit), v_world), v_world, v_air, v_airThrough), 1.0);
}`;

const TERRAIN_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
in vec3 a_pos;
in float a_coarseShift;
void main() {
  vec3 p = a_pos + u_cellOffset;
  p += localUp(p) * (a_coarseShift * spherePatchMorph(p));
  gl_Position = u_lightRender * vec4(p, 1.0);
}`;

const DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
void main() {}`;

/**
 * Instance transform shared by the colour and the depth program: the object stands along the local up of its base and
 * shrinks to nothing where the surface takes its look over (its place in the order is its turn, a number fixed per
 * object).
 */
const OBJECT_TRANSFORM = /* glsl */ `
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${COVER_FADE_GLSL}
uniform float u_cellLevel;
uniform float u_coverLevel; // coarsest level whose cells hold these objects
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_base;   // xyz base point (cell-local), w reach radius
in vec4 i_shape;  // x height, y turn about up, z width, w depth (0 = width)
in vec4 i_color;  // rgb colour, w variant
in float i_coarseShift; // metres along up to the base point on the coarser level
vec3 objectScale() {
  vec3 s = vec3(i_shape.z, i_shape.x, i_shape.w > 0.0 ? i_shape.w : i_shape.z);
  float fade = coverFade(u_coverLevel, u_cellLevel, spherePatchMorph(i_base.xyz + u_cellOffset));
  return s * coverKeep(fade, fract(i_shape.y * 0.1591549));
}
// Base point at the current blend between levels.
vec3 objectBase() {
  vec3 base = i_base.xyz + u_cellOffset;
  return base + localUp(base) * (i_coarseShift * spherePatchMorph(base));
}
// Axes of the object in the world: the local frame of the base, turned about its up.
mat3 objectAxes(vec3 base) {
  float c = cos(i_shape.y), s = sin(i_shape.y);
  return localFrame(base) * mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
`;

const OBJECT_VS = /* glsl */ `#include <header>
#include <atmosphere>
${OBJECT_TRANSFORM}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_up;
out float v_variant;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 base = objectBase();
  mat3 axes = objectAxes(base);
  vec3 scale = objectScale();
  v_world = base + axes * (a_pos * scale);
  v_air = atmosphereAir(v_world, v_airThrough);
  // An object shrunk to nothing has no shape to take a normal from.
  v_normal = axes * normalize(a_normal / max(scale, vec3(1e-6)));
  v_color = i_color.rgb;
  v_up = a_pos.y;
  v_variant = i_color.w;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const OBJECT_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_up;
in float v_variant;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 up = localUp(v_world);
  float grain = vnoise3(patternPos(v_world) * 2.0, 51u) * detailVisibleAt(0.7, v_world);
  vec3 col = v_color * (0.86 + 0.24 * grain);
  col = mix(col, u_snow.rgb, max(u_weather.x, step(0.5, v_variant) * 0.35) * smoothstep(0.45, 0.85, dot(n, up)));
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.3, v_up));
  float sun = sunVisibility(v_world, n, 1.0);
#ifdef WH_ATMOSPHERE
  vec3 c = toDisplay(col * atmosphereLight(v_world, n, sun, ao));
#else
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOnAt(v_world, n, sun, ao));
#endif
  o_color = vec4(atmosphereApply(applyFog(c, v_world), v_world, v_air, v_airThrough), 1.0);
}`;

const OBJECT_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
${OBJECT_TRANSFORM}
void main() {
  vec3 base = objectBase();
  gl_Position = u_lightRender * vec4(base + objectAxes(base) * (a_pos * objectScale()), 1.0);
}`;

/** The surface of a cell made with the cover (`generatePlanetCell`); needs the uniforms `u_coverLevel` and `u_showLevels`. */
export const TERRAIN_MATERIAL: MaterialDesc = {
  name: 'planet-terrain',
  attribs: SPHERE_PATCH_COVER_ATTRIBS,
  passes: { color: { vs: TERRAIN_VS, fs: TERRAIN_FS }, shadow: { vs: TERRAIN_DEPTH_VS, fs: DEPTH_FS } },
};

/** Objects standing on the surface; they leave one by one toward the far end of their level. Needs `u_coverLevel` and `u_showLevels`. */
export const OBJECT_MATERIAL: MaterialDesc = {
  name: 'planet-object',
  attribs: OBJECT_ATTRIBS,
  passes: { color: { vs: OBJECT_VS, fs: OBJECT_FS }, shadow: { vs: OBJECT_DEPTH_VS, fs: DEPTH_FS } },
};

// --- Strips (strips.ts) ---------------------------------------------------------------------------------------------
// The strip of a cell blends between levels like the surface (`spherePatchMorph`), then `stripWiden` keeps it at least
// STRIP_MIN_PX pixels wide. Lit with the local up, the sun, the fog and the air as the surface; coloured by line.

/** Least width of a strip on the screen, in pixels. */
export const STRIP_MIN_PX = 1.6;

const STRIP_VS = /* glsl */ `#include <header>
#include <noise>
#include <atmosphere>
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${STRIP_GLSL}
in vec3 a_pos;
in float a_coarseShift;
in vec3 a_side;
in vec4 a_strip; // across, metres along, half-width, line
out vec3 v_world;
out vec4 v_strip;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 p = a_pos + u_cellOffset;
  p += localUp(p) * (a_coarseShift * spherePatchMorph(p));
  float grow;
  p = stripWiden(p, a_side, a_strip, ${STRIP_MIN_PX.toFixed(2)}, grow);
  v_world = p;
  v_strip = a_strip;
  v_air = atmosphereAir(p, v_airThrough);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const STRIP_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec4 v_strip;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  vec3 up = localUp(v_world);
  float line = floor(v_strip.w + 0.5);
  vec3 col = line < 0.5 ? vec3(0.32, 0.31, 0.30) : line < 1.5 ? vec3(0.52, 0.42, 0.30) : vec3(0.44, 0.40, 0.36);
  // The hem beyond the edge is the bare side of the bank.
  col = mix(col, vec3(0.36, 0.30, 0.22), step(1.0001, abs(v_strip.x)));
  // A faint grain along the strip, faded out where a pixel covers more than it.
  float g = vnoise3(patternPos(v_world) / 1.5, 61u);
  col *= 0.92 + 0.16 * g * detailVisibleAt(1.5, v_world);
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, up, 1.0);
#ifdef WH_ATMOSPHERE
  vec3 lit = col * atmosphereLight(v_world, up, sun, 1.0);
#else
  vec3 lit = col * u_warmTint.rgb * lightOnAt(v_world, up, sun, 1.0);
#endif
  o_color = vec4(atmosphereApply(applyFog(toDisplay(lit), v_world), v_world, v_air, v_airThrough), 1.0);
}`;

/** The strips of a cell made by `generatePlanetStripCell`, colour pass only; needs `u_showLevels`. */
export const STRIP_MATERIAL: MaterialDesc = {
  name: 'planet-strip',
  attribs: STRIP_ATTRIBS,
  passes: { color: { vs: STRIP_VS, fs: STRIP_FS } },
};
