// Shaders of the system example.
//
// A body is drawn in one of two ways. The body the camera is at is streamed: its cells are relative to their origin
// with the axes of the body's own turning frame, which is then the frame of the picture, and every program adds
// `u_cellOffset` (`TERRAIN_MATERIAL`, `OBJECT_MATERIAL`; up comes from the header's `localUp`, the renderer is made
// with `radialUp`). Every other body is drawn from afar: the six coarsest cells of the same generator, placed by a
// matrix from the body's frame to the picture's (`FAR_BODY_VS`).
//
// Both ways share one look (`SURFACE_LOOK`): the light is the sun where it stands above the place's own horizon, in
// the direction `u_toSun` given per body. Round the body the camera is at, the engine's atmosphere takes over by the
// share `u_airNear`: its light on the surface and its air in front of it, also in front of the other bodies. Where
// `u_airNear` is 0 the streamed surface and the far one give the same colour, so one can replace the other.
//
// Air of a body seen from afar is a shell with a thickness worked out per pixel (`SHELL_FS`); it stands in for the
// engine's atmosphere beyond the distance where that one is switched on.

import type { MaterialDesc } from 'wallhammer-web/base';
import { COVER_FADE_GLSL } from 'wallhammer-web/core';
import { SPHERE_PATCH_COVER_ATTRIBS, SPHERE_PATCH_COVER_EXTRA_ATTRIBS, SPHERE_PATCH_GLSL } from 'wallhammer-web/gen-core';
import { HORIZON_GLSL } from 'wallhammer-web/gen-plan';
import { STRIP_ATTRIBS, STRIP_GLSL } from 'wallhammer-web/gen-mesh';
import { NEAR_INSTANCE_GLSL } from 'wallhammer-web/render';
import { SHADE } from './shade.ts';

export const OBJECT_ATTRIBS = { a_pos: 0, a_normal: 1, i_base: 2, i_shape: 3, i_color: 4, i_coarseShift: 5 } as const;
/** Attributes of the cells drawn from afar: the cover layout of the sphere patch. */
export const FAR_BODY_ATTRIBS = SPHERE_PATCH_COVER_ATTRIBS;
/** Attribute of the meshes that hold positions only (the shell, the paths). */
export const POSITION_ATTRIBS = { a_pos: 0 } as const;
/** Attribute of the square the sun is drawn on. */
export const CORNER_ATTRIBS = { a_corner: 0 } as const;

/**
 * Vertex side of everything far away. A logarithmic depth buffer has a far end, and what lies beyond it is not drawn:
 * distances past nine tenths of the far end are squeezed into the rest, in their order. The other depth modes have
 * no far end and get the point back unchanged.
 */
const WITHIN_DEPTH = /* glsl */ `
uniform vec3 u_eyePos; // the eye in render space
vec3 withinDepth(vec3 p) {
  if (u_camUp.w <= 0.0) return p;
  float farEnd = exp2(1.0 / u_camUp.w) - 1.0;
  float start = 0.9 * farEnd;
  vec3 d = p - u_eyePos;
  float len = length(d);
  if (len <= start) return p;
  return u_eyePos + d * ((start + 0.095 * farEnd * (1.0 - start / len)) / len);
}
`;

/** Fragment side shared by the streamed surface and the far one. Needs `<lighting>` and `<atmosphere>` before it. */
const SURFACE_LOOK = /* glsl */ `
uniform vec3 u_toSun;    // unit direction from the body to the sun, in render space
uniform float u_airNear; // 0–1: share of the engine's atmosphere in the picture (0: far from the body it belongs to)
// Light on a surface where no air is computed, as a multiple of its colour: the sun where it stands above the
// place's own horizon, a little of it thrown back by the lit ground around, and what remains without it.
vec3 bareLight(vec3 n, vec3 up, float sun) {
  float above = smoothstep(-0.03, 0.05, dot(up, u_toSun));
  return u_atmLight.rgb * (max(dot(n, u_toSun), 0.0) * above * sun + 0.04 * above) + u_atmNight.rgb;
}
// Glint of the sun on a sea.
vec3 bareGlint(vec3 up, float amount) {
  vec3 h = normalize(u_toSun - u_camForward.xyz);
  float above = smoothstep(-0.03, 0.05, dot(up, u_toSun));
  return u_atmLight.rgb * (amount * above * 0.3 * pow(max(dot(up, h), 0.0), 90.0));
}
`;

/**
 * The depth code of a planned body's terrain colour (planned-cell.ts, `depthCode`): the alpha is `32 + 8 · depth` in
 * metres, land included. Water stands on the zero line of the interpolated depth, antialiased over a pixel. No
 * dependencies, so the far body reads it too.
 */
const WATER_CODE = /* glsl */ `
const vec3 WATER_DEEP = vec3(0.03, 0.10, 0.16);
const float WATER_CLEAR_M = 2.2;
// Signed depth of the standing water (m) from the alpha of a terrain colour.
float waterDepthOf(float alpha) { return (alpha * 255.0 - 32.0) / 8.0; }
// Share of water at a pixel: smooth over the width of a pixel round the zero line of the depth.
float waterWet(float d) {
  float w = max(fwidth(d), 0.02);
  return smoothstep(-w, w, d);
}
// Land within 0.25 m above the level is wet and darker (the bed under the water as well).
float waterDamp(float d) { return 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.25, -d)); }
// The colour of water over a bed at a depth: the bed shows through the shallows, one deep colour beyond.
vec3 waterColor(vec3 bed, float d) { return mix(bed * vec3(0.78, 0.9, 0.92), WATER_DEEP, 1.0 - exp(-max(d, 0.0) / WATER_CLEAR_M)); }
`;

/**
 * One look of every water of Hearth (sea, lakes, rivers): `WATER_CODE`, ripples as a normal bent per pixel by moving
 * noise whose octaves fade once their length is under two pixels, the sky mirrored by Fresnel (0.02 at normal
 * incidence; the engine's sky along the mirrored ray, kept above the horizon, where the air is computed) and the sun's
 * glint. Needs `<noise>`, `<lighting>`, `<atmosphere>`, `COMMON_FS` and `SURFACE_LOOK` before it.
 */
const WATER_LOOK = /* glsl */ `${WATER_CODE}
// The normal of water at a point: up bent by three octaves of moving noise.
vec3 waterNormal(vec3 worldPos, vec3 up, float t) {
  vec3 q = patternPos(worldPos);
  float mpp = metresPerPixelAt(worldPos);
  vec3 bend = vec3(0.0);
  float len = 9.0;
  float amp = 0.32;
  for (int k = 0; k < 3; k++) {
    float see = smoothstep(2.0, 4.0, len / mpp);
    if (see > 0.0) {
      uint s = 41u + 3u * uint(k);
      vec3 r = q / len + vec3(0.31, 0.0, 0.17) * (t * 3.0 / len);
      bend += (vec3(vnoise3(r, s), vnoise3(r + 17.0, s + 1u), vnoise3(r + 31.0, s + 2u)) - 0.5) * (amp * see);
    }
    len *= 0.38;
    amp *= 0.7;
  }
  return normalize(up + (bend - up * dot(bend, up)));
}
// Unit direction from a point to the eye: exact where the air is computed, the view axis elsewhere.
vec3 waterView(vec3 worldPos) { return u_airNear > 0.0 ? normalize(u_atmEye.xyz - worldPos) : -u_camForward.xyz; }
float waterFresnel(vec3 n, vec3 view) {
  float c = 1.0 - clamp(dot(n, view), 0.0, 1.0);
  return 0.02 + 0.98 * c * c * c * c * c;
}
// Display colour of water before the air in front of it: its colour lit as the land, the sky mirrored by Fresnel and
// the sun's glint. Returns the look without air; airLook is the look with the engine's air (valid where u_airNear > 0).
vec3 waterShade(vec3 worldPos, vec3 n, vec3 up, vec3 col, float sun, out vec3 airLook) {
  vec3 view = waterView(worldPos);
  float fr = waterFresnel(n, view);
  float above = smoothstep(-0.03, 0.05, dot(up, u_toSun));
  float glint = 0.3 * pow(max(dot(n, normalize(u_toSun + view)), 0.0), 90.0) * sun * above;
  vec3 sky = u_atmLight.rgb * vec3(0.16, 0.26, 0.45) * above;
  vec3 c = mix(toDisplay(col * bareLight(n, up, sun)), toDisplay(sky), fr) + toDisplay(u_atmLight.rgb * glint);
  airLook = c;
  if (u_airNear > 0.0) {
    vec3 r = reflect(-view, n);
    r = normalize(r + up * max(0.0, 0.03 - dot(r, up)));
    vec3 through;
    float ground;
    vec3 mirrored = atmDisplay(atmosphereSky(r, through, ground));
    airLook = mix(toDisplay(col * atmosphereLight(worldPos, n, sun, 1.0)), mirrored, fr) + toDisplay(atmosphereSun(worldPos) * glint);
  }
  return c;
}
`;

const COMMON_FS = /* glsl */ `
// Position for patterns fixed to the body: relative to its centre, so it does not move with the render origin.
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
${SURFACE_LOOK}
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
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, n, 1.2);
  vec3 c = toDisplay(col * bareLight(n, up, sun) + bareGlint(up, sea * sun));
  if (u_airNear > 0.0) {
    // The light of the place: the sun through the air above it and the sky there; then the air in front of it.
    vec3 lit = col * atmosphereLight(v_world, n, sun, 1.0);
    vec3 h = normalize(u_atmSun.xyz - u_camForward.xyz);
    lit += atmosphereSun(v_world) * (sea * sun * 0.3 * pow(max(dot(up, h), 0.0), 90.0));
    c = mix(c, atmosphereApply(toDisplay(lit), v_world, v_air, v_airThrough), u_airNear);
  }
  o_color = vec4(c, 1.0);
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
${SURFACE_LOOK}
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
  vec3 c = toDisplay(col * bareLight(n, up, sun) * ao);
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(toDisplay(col * atmosphereLight(v_world, n, sun, ao)), v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, 1.0);
}`;

const OBJECT_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
${OBJECT_TRANSFORM}
void main() {
  vec3 base = objectBase();
  gl_Position = u_lightRender * vec4(base + objectAxes(base) * (a_pos * objectScale()), 1.0);
}`;

/** The streamed surface of a body. Needs the uniforms `u_coverLevel`, `u_showLevels`, `u_toSun` and `u_airNear`. */
export const TERRAIN_MATERIAL: MaterialDesc = {
  name: 'system-terrain',
  attribs: SPHERE_PATCH_COVER_ATTRIBS,
  passes: { color: { vs: TERRAIN_VS, fs: TERRAIN_FS }, shadow: { vs: TERRAIN_DEPTH_VS, fs: DEPTH_FS } },
};

/** Objects standing on the streamed surface; they leave one by one toward the far end of their level. Same uniforms. */
export const OBJECT_MATERIAL: MaterialDesc = {
  name: 'system-object',
  attribs: OBJECT_ATTRIBS,
  passes: { color: { vs: OBJECT_VS, fs: OBJECT_FS }, shadow: { vs: OBJECT_DEPTH_VS, fs: DEPTH_FS } },
};

// --- A body from afar ------------------------------------------------------------------------------------------------

/**
 * One coarsest cell of a body, placed from the body's own frame. The body may be drawn larger than it is (`u_body.w`),
 * so that it stays a visible dot from the far end of the system.
 */
export const FAR_BODY_VS = /* glsl */ `#include <header>
${WITHIN_DEPTH}
uniform mat4 u_model;      // the body's turning frame → render space
uniform vec3 u_cellOrigin; // origin of the cell in the body's frame, from its centre
uniform vec4 u_body;       // xyz centre of the body in render space, w the size it is drawn at (1 = its own)
in vec3 a_pos;
in vec4 a_normal; // xyz normal (int16), w: 0 surface, 1 skirt
in vec4 a_color;  // rgb colour, a: 1 sea
in vec4 a_cover;  // rgb what the objects on the surface look like from afar, a the share they hide
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
out vec4 v_cover;
void main() {
  mat3 turn = mat3(u_model);
  vec3 p = u_body.xyz + turn * (a_pos + u_cellOrigin) * u_body.w;
  v_world = p;
  v_normal = turn * a_normal.xyz;
  v_color = a_color;
  v_cover = a_cover;
  gl_Position = u_viewProj * vec4(withinDepth(p), 1.0);
}`;

/** The look of the streamed surface where its grain is too fine to see and no shadow map reaches. */
export const FAR_BODY_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${SURFACE_LOOK}
${WATER_CODE}
uniform vec4 u_body;
uniform float u_depthCode; // 1: the alpha of the colour is the depth code of a planned body (else 0 land, 1 sea)
in vec3 v_world;
in vec3 v_normal;
in vec4 v_color;
in vec4 v_cover;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 up = normalize(v_world - u_body.xyz);
  float sea = step(0.5, v_color.a);
  vec3 base = v_color.rgb;
  if (u_depthCode > 0.5) {
    // A planned body: the bed's colour and the depth; the water's colour where it stands.
    float d = waterDepthOf(v_color.a);
    sea = waterWet(d);
    base = mix(base, waterColor(base, d), sea);
  }
  vec3 col = mix(base, v_cover.rgb, v_cover.a * (1.0 - sea));
  // The mean of the grain of the streamed surface.
  col *= mix(0.88, 1.0, sea);
  vec3 c = toDisplay(col * bareLight(n, up, 1.0) + bareGlint(up, sea));
  // The air of the body the camera is at lies in front of every other body.
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(c, v_world), u_airNear);
  o_color = vec4(c, 1.0);
}`;

/** A sphere of the radius of the top of a body's air, round its centre. */
export const SHELL_VS = /* glsl */ `#include <header>
${WITHIN_DEPTH}
uniform vec4 u_body;  // xyz centre of the body in render space, w the size it is drawn at
uniform vec4 u_shell; // x radius of the ground, y radius of the top of the air, z opacity, w share of the engine's atmosphere in front
in vec3 a_pos; // on the unit sphere
out vec3 v_world;
void main() {
  vec3 p = u_body.xyz + a_pos * (u_shell.y * u_body.w);
  v_world = p;
  gl_Position = u_viewProj * vec4(withinDepth(p), 1.0);
}`;

/**
 * Air of a body seen from outside, without a walk along the ray: the amount of air on the way follows from how
 * close the ray passes to the centre. A ray that ends on the ground crosses the air once, the more slanted the
 * longer; a ray that misses the ground crosses it twice at its lowest point, where the air thins out with height.
 * The colour is the lit air at that place: blue by day, warm along the edge of the night, dark beyond it.
 */
export const SHELL_FS = /* glsl */ `#include <header>
#include <noise>
#include <atmosphere>
uniform vec3 u_eyePos;
uniform vec4 u_body;
uniform vec4 u_shell;
uniform vec3 u_toSun;    // unit direction from the body to the sun, in render space
uniform vec3 u_airColor; // the lit air seen from afar
in vec3 v_world;
out vec4 o_color;
void main() {
  // The point of the shell the ray enters at, from the centre, at the body's own size.
  vec3 q = (v_world - u_body.xyz) / u_body.w;
  vec3 rd = normalize(v_world - u_eyePos);
  // Where the ray passes closest to the centre, and how close.
  vec3 m = q - rd * dot(q, rd);
  float p2 = dot(m, m);
  float rg = u_shell.x;
  float rt = u_shell.y;
  float halfChord = sqrt(max(rt * rt - p2, 0.0));
  float mass;
  vec3 at;
  if (p2 < rg * rg) {
    at = q + rd * (halfChord - sqrt(rg * rg - p2));
    mass = 1.0 / (sqrt(1.0 - p2 / (rg * rg)) + 0.12);
  } else {
    at = m;
    mass = (2.0 / 0.12) * exp(-(sqrt(p2) - rg) / (0.12 * (rt - rg)));
  }
  float mu = dot(normalize(at), u_toSun);
  float day = smoothstep(-0.18, 0.3, mu);
  vec3 col = mix(vec3(1.0, 0.5, 0.25), u_airColor, smoothstep(-0.05, 0.3, mu)) * day;
  float a = (1.0 - exp(-0.16 * mass)) * u_shell.z;
  if (u_shell.w > 0.0) col = mix(col, atmosphereApply(col, v_world), u_shell.w);
  o_color = vec4(col, a);
}`;

// --- The sun, the paths, the stars -----------------------------------------------------------------------------------

/** A square that faces the camera, round the centre of the sun. */
export const SUN_VS = /* glsl */ `#include <header>
${WITHIN_DEPTH}
uniform vec4 u_disc; // xyz centre in render space, w half the edge of the square in metres
in vec2 a_corner;    // −1…1
out vec2 v_at;
out vec3 v_world;
void main() {
  v_at = a_corner;
  vec3 p = u_disc.xyz + (u_camRight.xyz * a_corner.x + u_camUp.xyz * a_corner.y) * u_disc.w;
  v_world = p;
  gl_Position = u_viewProj * vec4(withinDepth(p), 1.0);
}`;

/**
 * The disc of the sun and the glow round it, added to what is behind. Seen through the engine's atmosphere it loses
 * what the air takes on the way: `atmSunAt` of the include is that share for a ray that leaves the air at a place.
 */
export const SUN_FS = /* glsl */ `#include <header>
#include <noise>
#include <atmosphere>
uniform vec3 u_eyePos;
uniform vec4 u_glow; // x share of the square's half edge the disc takes, y share of the engine's atmosphere in front
in vec2 v_at;
in vec3 v_world;
out vec4 o_color;
// Share of a far light that reaches the eye along dir through the air of the engine's ground sphere.
vec3 airThrough(vec3 dir) {
  if (u_atmSun.w <= 0.0) return vec3(1.0);
  vec3 ro = u_atmEye.xyz - atmCenter();
  float rt = u_atmShell.y;
  float b = dot(ro, dir);
  float c = dot(ro, ro) - rt * rt;
  vec3 at = ro;
  if (c > 0.0) {
    // The eye is above the air: the ray enters it, or passes it by.
    float disc = b * b - c;
    if (b >= 0.0 || disc <= 0.0) return vec3(1.0);
    at = ro + dir * (-b - sqrt(disc));
  }
  float r = max(length(at), 1.0);
  return atmSunAt(r, dot(at, dir) / r);
}
void main() {
  float r = length(v_at) / u_glow.x; // 1 on the edge of the disc
  float edge = max(fwidth(r), 1e-4);
  float disc = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
  // The disc is a little darker toward its edge.
  float mu = sqrt(max(1.0 - r * r, 0.0));
  vec3 c = vec3(1.0, 0.96, 0.88) * ((1.5 + 1.0 * mu) * disc);
  // The glow fades with the distance from the edge and ends before the border of the square.
  float g = max(r - 1.0, 0.0);
  float fade = 1.0 - smoothstep(0.55, 1.0, length(v_at));
  c += vec3(1.0, 0.8, 0.52) * ((0.5 * exp(-g * 3.0) + 0.1 / (1.0 + g * g * 5.0)) * fade * (1.0 - disc));
  if (u_glow.y > 0.0) c *= mix(vec3(1.0), airThrough(normalize(v_world - u_eyePos)), u_glow.y);
  o_color = vec4(c, 1.0);
}`;

/** A path: points in the frame of the body it goes round. */
export const PATH_VS = /* glsl */ `#include <header>
${WITHIN_DEPTH}
uniform mat4 u_model; // the frame of the path → render space
in vec3 a_pos;
void main() {
  vec3 p = (u_model * vec4(a_pos, 1.0)).xyz;
  gl_Position = u_viewProj * vec4(withinDepth(p), 1.0);
}`;

export const PATH_FS = /* glsl */ `#include <header>
uniform vec4 u_color;
out vec4 o_color;
void main() {
  o_color = u_color;
}`;

/**
 * Vertex side of the marks of the plan drawn over a body (with `PATH_FS`): the path's vertex, moved toward the eye by a
 * share of its distance. The point stays where it is on the screen, only nearer in depth, so it clears the facets of
 * the surface under it at any distance and is still hidden by the body in front of it.
 */
export const PLAN_MARK_VS = /* glsl */ `#include <header>
${WITHIN_DEPTH}
uniform mat4 u_model; // the frame of the body → render space
uniform float u_lift; // share of the distance to the eye the vertex moves toward it
in vec3 a_pos;
void main() {
  vec3 p = (u_model * vec4(a_pos, 1.0)).xyz;
  p = u_eyePos + (p - u_eyePos) * (1.0 - u_lift);
  gl_Position = u_viewProj * vec4(withinDepth(p), 1.0);
}`;

/**
 * Stars behind everything, added to the sky the engine has drawn: at most one per cell of a cube-map grid over the
 * directions, from an integer hash, never narrower than a pixel. The engine's own stars are fixed to the axes of the
 * picture, which change when the camera goes over to another body; these are fixed to the axes of the whole system
 * (`u_toFixed` turns a direction of the picture into them), so the sky does not jump.
 */
export const STARS_FS = /* glsl */ `#include <header>
#include <noise>
uniform vec3 u_rayCenter; // view ray through the screen centre, scaled so that its depth along the view is 1
uniform vec3 u_rayRight;  // change of the ray from the centre to the right edge
uniform vec3 u_rayUp;     // change of the ray from the centre to the top edge
uniform vec2 u_screen;    // drawing surface in physical pixels
uniform mat4 u_toFixed;   // directions of render space → directions of the frame the stars are fixed in
uniform float u_gain;     // 0–1: how much of the stars shows (they are lost in a bright sky)
out vec4 o_color;
vec3 stars(vec3 dir, float pixelAngle) {
  vec3 a = abs(dir);
  vec2 uv;
  uint face;
  float major;
  if (a.x >= a.y && a.x >= a.z) { uv = dir.zy / a.x; face = dir.x > 0.0 ? 0u : 1u; major = a.x; }
  else if (a.y >= a.z) { uv = dir.xz / a.y; face = dir.y > 0.0 ? 2u : 3u; major = a.y; }
  else { uv = dir.xy / a.z; face = dir.z > 0.0 ? 4u : 5u; major = a.z; }
  const float CELLS = 160.0;
  vec2 g = (uv * 0.5 + 0.5) * CELLS;
  vec2 cf = floor(g);
  ivec2 cell = ivec2(cf);
  uint seed = 400u + face * 8u;
  if (hash2(cell, seed) > 0.3) return vec3(0.0);
  vec2 at = 0.2 + 0.6 * vec2(hash2(cell, seed + 1u), hash2(cell, seed + 2u));
  float m = hash2(cell, seed + 3u);
  float bright = 0.12 + 0.88 * m * m * m * m;
  float px = pixelAngle * CELLS * 0.5 / major;
  float r = max(0.8 * px, 0.01);
  vec2 off = g - cf - at;
  // Most stars are white; a few are warm or blue.
  vec3 tint = mix(vec3(1.0, 0.84, 0.7), vec3(0.78, 0.86, 1.0), hash2(cell, seed + 4u));
  return tint * (bright * exp(-dot(off, off) / (r * r)));
}
void main() {
  vec2 s = gl_FragCoord.xy / u_screen * 2.0 - 1.0;
  vec3 dir = normalize(u_rayCenter + u_rayRight * s.x + u_rayUp * s.y);
  float pa = max(length(fwidth(dir)), 1e-5);
  o_color = vec4(stars(mat3(u_toFixed) * dir, pa) * u_gain, 1.0);
}`;

// --- The planned surface of Hearth (planned-cell.ts) -----------------------------------------------------------------
// Stage ≥ 1 draws Hearth with these two; every other body and stage 0 keep the materials above. The terrain is the
// one above with ripples on standing water near the eye (sea and lakes: colour alpha 255). The rivers are strips:
// `a_strip.y` is metres to the end of the water, `a_strip.w` the class of the line, plus 4 on the coarsest level that
// meshes it, where the strip fades out as the cell blends into its parent (which has no strip of that line).
// `u_flowTime` is the clock of the flow, in seconds.

const PLANNED_TERRAIN_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${SURFACE_LOOK}
uniform float u_cellLevel;
uniform float u_showLevels;
uniform float u_flowTime;
${WATER_LOOK}
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
  // The colour is the bed's, its alpha the depth code: water stands on the zero line of the depth, per pixel.
  float d = waterDepthOf(v_color.a);
  float sea = waterWet(d);
  vec3 col = mix(v_color.rgb, v_cover.rgb, v_cover.a * (1.0 - sea));
  vec3 q = patternPos(v_world);
  float g = vnoise3(q / 8.0, 31u) * 0.6 + vnoise3(q / 2.0, 32u) * 0.4 * detailVisibleAt(2.0, v_world);
  col *= (0.88 + 0.24 * g * detailVisibleAt(8.0, v_world)) * waterDamp(d);
  vec3 wcol = waterColor(col, d);
  if (u_showLevels > 0.5) {
    col = mix(col, levelTint(u_cellLevel), 0.55);
    wcol = mix(wcol, levelTint(u_cellLevel), 0.55);
  }
  float sun = sunVisibility(v_world, n, 1.2);
  vec3 c = toDisplay(col * bareLight(n, up, sun));
  vec3 airC = c;
  if (u_airNear > 0.0) airC = toDisplay(col * atmosphereLight(v_world, n, sun, 1.0));
  if (sea > 0.0) {
    vec3 waterAir;
    c = mix(c, waterShade(v_world, waterNormal(v_world, up, u_flowTime), up, wcol, sun, waterAir), sea);
    airC = mix(airC, waterAir, sea);
  }
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(airC, v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, 1.0);
}`;

/** The streamed surface of Hearth with its plan. Needs the uniforms of `TERRAIN_MATERIAL` and `u_flowTime`. */
export const PLANNED_TERRAIN_MATERIAL: MaterialDesc = {
  name: 'system-planned-terrain',
  attribs: SPHERE_PATCH_COVER_ATTRIBS,
  passes: { color: { vs: TERRAIN_VS, fs: PLANNED_TERRAIN_FS }, shadow: { vs: TERRAIN_DEPTH_VS, fs: DEPTH_FS } },
};

/** Least width of a river of class 0 and 1 on the screen, in pixels; the finer classes fade out instead. */
export const WATER_MIN_PX = 1.6;

const WATER_VS = /* glsl */ `#include <header>
#include <noise>
#include <atmosphere>
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${STRIP_GLSL}
in vec3 a_pos;
in float a_coarseShift;
in vec3 a_side;
in vec4 a_strip; // across, metres to the end of the water, half-width, class (+4: the coarsest level that meshes it) + 0.9 × fade
out vec3 v_world;
out vec4 v_strip;
out float v_alpha;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 p = a_pos + u_cellOffset;
  float m = spherePatchMorph(p);
  p += localUp(p) * (a_coarseShift * m);
  // The whole part is the code, the rest 0.9 × how far the strip has dissolved into standing water.
  float code = floor(a_strip.w);
  float fade = min(1.0, (a_strip.w - code) / 0.9);
  float flag = step(3.5, code);
  float cls = code - 4.0 * flag;
  float wide = step(cls, 1.5);
  float grow;
  p = stripWiden(p, a_side, a_strip, ${WATER_MIN_PX.toFixed(2)} * wide, grow);
  float px = 2.0 * (a_strip.z + grow) / metresPerPixelAt(p);
  v_alpha = mix(smoothstep(0.35, 1.0, px), 1.0, wide) * (1.0 - flag * m) * (1.0 - fade);
  v_world = p;
  v_strip = vec4(a_strip.xyz, cls);
  v_air = atmosphereAir(p, v_airThrough);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const WATER_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${SURFACE_LOOK}
uniform float u_cellLevel;
uniform float u_showLevels;
uniform float u_flowTime;
${WATER_LOOK}
in vec3 v_world;
in vec4 v_strip;
in float v_alpha;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
// The gravel of a river's bed (planned-cell.ts, GRAVEL).
const vec3 RIVER_BED = vec3(0.588, 0.549, 0.478);
void main() {
  if (v_alpha <= 0.002) discard;
  vec3 up = localUp(v_world);
  // The depth of the profile across the strip (plan-lines.ts, PROFILES by class): full in the middle, none at the banks.
  float a = clamp(abs(v_strip.x), 0.0, 1.0);
  float cls = v_strip.w;
  float full = cls < 1.5 ? 2.4 : cls < 2.5 ? 1.1 : 0.5;
  float inner = cls < 1.5 ? 0.7 : cls < 2.5 ? 0.6 : 0.55;
  float depth = full * clamp((1.0 - a) / (1.0 - inner), 0.0, 1.0);
  vec3 col = waterColor(RIVER_BED * waterDamp(depth), depth);
  // The flow: a pattern moving along the line toward the end of the water.
  vec2 f = vec2((v_strip.y + 1.1 * u_flowTime) / 7.0, v_strip.x * 1.6);
  float flow = vnoise3(vec3(f, 0.0), 51u) * 0.6 + vnoise3(vec3(f * 2.3, 1.0), 52u) * 0.4;
  float see = detailVisibleAt(2.5, v_world);
  col *= 1.0 + 0.16 * see * (flow - 0.5);
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, up, 1.2);
  vec3 airC;
  vec3 c = waterShade(v_world, waterNormal(v_world, up, u_flowTime), up, col, sun, airC);
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(airC, v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, v_alpha);
}`;

/** The rivers of a planned cell (material 'water'): blended, drawn after the terrain. Same uniforms as the terrain. */
export const WATER_MATERIAL: MaterialDesc = {
  name: 'system-water',
  attribs: STRIP_ATTRIBS,
  passes: { color: { vs: WATER_VS, fs: WATER_FS } },
  state: { color: { blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, depthWrite: false } },
};

// --- Stage 3 of Hearth: lanes and the massing of settlements ---------------------------------------------------------

// The vertices of a way: as the water's, with the kind packed above the class (w = class + 4·coarsest + 8·kind; kind 0
// lane, 1 road, 2 deck). Passes w = class + 8·kind on.
const WAY_VS = /* glsl */ `#include <header>
#include <noise>
#include <atmosphere>
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${STRIP_GLSL}
in vec3 a_pos;
in float a_coarseShift;
in vec3 a_side;
in vec4 a_strip; // across, metres along, half-width, class (+4: the coarsest level that meshes it, +8 per kind)
out vec3 v_world;
out vec4 v_strip;
out float v_alpha;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 p = a_pos + u_cellOffset;
  float m = spherePatchMorph(p);
  p += localUp(p) * (a_coarseShift * m);
  float kind = floor(a_strip.w / 8.0 + 0.01);
  float rest = a_strip.w - 8.0 * kind;
  float flag = step(3.5, rest);
  float cls = rest - 4.0 * flag;
  float wide = step(cls, 1.5);
  float grow;
  p = stripWiden(p, a_side, a_strip, ${WATER_MIN_PX.toFixed(2)} * wide, grow);
  float px = 2.0 * (a_strip.z + grow) / metresPerPixelAt(p);
  v_alpha = mix(smoothstep(0.35, 1.0, px), 1.0, wide) * (1.0 - flag * m);
  v_world = p;
  v_strip = vec4(a_strip.xyz, cls + 8.0 * kind);
  v_air = atmosphereAir(p, v_airThrough);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const WAY_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${SURFACE_LOOK}
uniform float u_cellLevel;
uniform float u_showLevels;
in vec3 v_world;
in vec4 v_strip;
in float v_alpha;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  if (v_alpha <= 0.002) discard;
  vec3 up = localUp(v_world);
  float kind = floor(v_strip.w / 8.0 + 0.01);
  float cls = v_strip.w - 8.0 * kind;
  // Packed earth; the streets of the town (class 2) paler, as if laid with stone. Darker ruts toward the edges.
  vec3 col = cls < 2.5 ? vec3(0.60, 0.57, 0.50) : vec3(0.45, 0.38, 0.29);
  float a = clamp(abs(v_strip.x), 0.0, 1.0);
  col *= 1.0 - 0.18 * smoothstep(0.55, 1.0, a);
  // A road: paler gravel, a dark edge on each side.
  if (kind > 0.5 && kind < 1.5) col = mix(vec3(0.66, 0.62, 0.54), vec3(0.36, 0.32, 0.26), smoothstep(0.82, 0.98, a));
  // A deck: boards across, kerbs along the edges, the skirt under them dark.
  if (kind > 1.5) {
    float board = fract(v_strip.y / 0.6);
    col = vec3(0.48, 0.36, 0.24) * (0.86 + 0.14 * smoothstep(0.0, 0.12, board) * smoothstep(1.0, 0.88, board));
    if (abs(v_strip.x) > 0.85) col = vec3(0.40, 0.38, 0.35);
    if (abs(v_strip.x) > 1.0) col = vec3(0.18, 0.15, 0.12);
  }
  float see = detailVisibleAt(0.8, v_world);
  col *= 1.0 + 0.14 * see * (vnoise3(patternPos(v_world) * 0.9, 61u) - 0.5);
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, up, 1.0);
  vec3 c = toDisplay(col * bareLight(up, up, sun));
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(toDisplay(col * atmosphereLight(v_world, up, sun, 1.0)), v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, kind > 1.5 ? v_alpha : v_alpha * (1.0 - 0.25 * smoothstep(0.85, 1.0, a)));
}`;

/** The lanes, roads and decks of a planned cell (material 'way'): the water's strip widening, blended. Same uniforms. */
export const WAY_MATERIAL: MaterialDesc = {
  name: 'system-way',
  attribs: STRIP_ATTRIBS,
  passes: { color: { vs: WAY_VS, fs: WAY_FS } },
  state: { color: { blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, depthWrite: false } },
};

/** Attributes of the massing of a settlement: position relative to its centre, normal, colour. */
export const MASS_ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2 } as const;

const MASS_VS = /* glsl */ `#include <header>
#include <atmosphere>
uniform vec3 u_offset; // the centre of the settlement in render space
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_color;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  v_world = a_pos + u_offset;
  v_normal = a_normal;
  v_color = a_color;
  v_air = atmosphereAir(v_world, v_airThrough);
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const MASS_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${SURFACE_LOOK}
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 up = localUp(v_world);
  float grain = vnoise3(patternPos(v_world) * 1.3, 71u) * detailVisibleAt(0.6, v_world);
  vec3 col = v_color * (0.9 + 0.18 * grain);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * bareLight(n, up, sun));
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(toDisplay(col * atmosphereLight(v_world, n, sun, 1.0)), v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, 1.0);
}`;

/** The massing of a settlement (settlement-layer.ts): one block with a pitched top per lot. Uniforms `u_offset`, `u_toSun`, `u_airNear`. */
export const MASS_MATERIAL: MaterialDesc = {
  name: 'system-mass',
  attribs: MASS_ATTRIBS,
  passes: { color: { vs: MASS_VS, fs: MASS_FS } },
};

// --- Stage 2 of Hearth: the weather at the eye and cloud cover by place ----------------------------------------------
// From stage 2 Hearth is drawn with these two instead of the planned terrain and the objects above (whose texts stay).
// The engine's lighting include then carries the cloud cover by place: `sunVisibility` gives the sun share over the
// frame's dimming (S / G), and the light of the air (`u_atmLight`) is not dimmed by the cloud cover, so the share is
// taken times `G` (`u_cloudFieldLight.y`). Wet ground and fresh snow are the weather at the eye (`u_weather`), so they
// fade out between 8 and 20 km from it. `u_eyePos` is the eye in render space.

const WEATHER_NEAR = /* glsl */ `
uniform vec3 u_eyePos;
// 1 within 8 km of the eye, 0 beyond 20 km: how much of the weather at the eye holds here.
float weatherNear(vec3 worldPos) {
  return 1.0 - smoothstep(8000.0, 20000.0, length(worldPos - u_eyePos));
}
`;

const CLIMATE_TERRAIN_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${SURFACE_LOOK}
${WEATHER_NEAR}
uniform float u_cellLevel;
uniform float u_showLevels;
uniform float u_flowTime;
${WATER_LOOK}
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
  // The colour is the bed's, its alpha the depth code: water stands on the zero line of the depth, per pixel.
  float d = waterDepthOf(v_color.a);
  float sea = waterWet(d);
  vec3 col = mix(v_color.rgb, v_cover.rgb, v_cover.a * (1.0 - sea));
  vec3 q = patternPos(v_world);
  float g = vnoise3(q / 8.0, 31u) * 0.6 + vnoise3(q / 2.0, 32u) * 0.4 * detailVisibleAt(2.0, v_world);
  col *= (0.88 + 0.24 * g * detailVisibleAt(8.0, v_world)) * waterDamp(d);
  vec3 wcol = waterColor(col, d);
  // The weather at the eye: fresh snow on flat land, wet land darker with a glint of its own.
  float w = weatherNear(v_world) * (1.0 - sea);
  float level = smoothstep(0.72, 0.9, dot(n, up));
  float snow = u_weather.x * w * level * mix(0.75, 1.0, g);
  float wet = u_weather.y * w * (1.0 - snow);
  col *= mix(1.0, 0.62, wet);
  col = mix(col, u_snow.rgb, snow);
  float gloss = 0.45 * wet;
  if (u_showLevels > 0.5) {
    col = mix(col, levelTint(u_cellLevel), 0.55);
    wcol = mix(wcol, levelTint(u_cellLevel), 0.55);
  }
  float sun = sunVisibility(v_world, n, 1.2) * u_cloudFieldLight.y;
  vec3 c = toDisplay(col * bareLight(n, up, sun) + bareGlint(up, gloss * sun));
  vec3 airC = c;
  if (u_airNear > 0.0) {
    vec3 h = normalize(u_atmSun.xyz - u_camForward.xyz);
    airC = toDisplay(col * atmosphereLight(v_world, n, sun, 1.0) + atmosphereSun(v_world) * (gloss * sun * 0.3 * pow(max(dot(up, h), 0.0), 90.0)));
  }
  if (sea > 0.0) {
    vec3 waterAir;
    c = mix(c, waterShade(v_world, waterNormal(v_world, up, u_flowTime), up, wcol, sun, waterAir), sea);
    airC = mix(airC, waterAir, sea);
  }
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(airC, v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, 1.0);
}`;

/** The streamed surface of Hearth from stage 2. Needs the uniforms of `PLANNED_TERRAIN_MATERIAL` and `u_eyePos`. */
export const CLIMATE_TERRAIN_MATERIAL: MaterialDesc = {
  name: 'system-climate-terrain',
  attribs: SPHERE_PATCH_COVER_ATTRIBS,
  passes: { color: { vs: TERRAIN_VS, fs: CLIMATE_TERRAIN_FS }, shadow: { vs: TERRAIN_DEPTH_VS, fs: DEPTH_FS } },
};

const CLIMATE_OBJECT_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${SURFACE_LOOK}
${WEATHER_NEAR}
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
  float w = weatherNear(v_world);
  col *= mix(1.0, 0.75, u_weather.y * w);
  col = mix(col, u_snow.rgb, max(u_weather.x * w, step(0.5, v_variant) * 0.35) * smoothstep(0.45, 0.85, dot(n, up)));
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.3, v_up));
  float sun = sunVisibility(v_world, n, 1.0) * u_cloudFieldLight.y;
  vec3 c = toDisplay(col * bareLight(n, up, sun) * ao);
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(toDisplay(col * atmosphereLight(v_world, n, sun, ao)), v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, 1.0);
}`;

/** Objects on Hearth from stage 2. Needs the uniforms of `OBJECT_MATERIAL` and `u_eyePos`. */
export const CLIMATE_OBJECT_MATERIAL: MaterialDesc = {
  name: 'system-climate-object',
  attribs: OBJECT_ATTRIBS,
  passes: { color: { vs: OBJECT_VS, fs: CLIMATE_OBJECT_FS }, shadow: { vs: OBJECT_DEPTH_VS, fs: DEPTH_FS } },
};

// --- Details near the camera on Hearth (details.ts) ------------------------------------------------------------------
// Tufts, stones and flowers drawn by the engine's `NearInstanceLayer`: the vertex include places and bends them, the
// light is that of the objects of stage 2. Tufts and flowers are lit with the up of the ground, not their own flat
// faces, so a thin blade does not flash from light to dark as it turns; their foot takes the shade of the ground
// round it. The integer part of the variant is the kind (0 tuft, 1 stone, 2 flower).

/** Attributes of the details: the shape layout of the example and the records of `nearScatter`. */
export const DETAIL_ATTRIBS = { a_pos: 0, a_normal: 1, i_base: 2, i_shape: 3, i_color: 4 } as const;

const DETAIL_VS = /* glsl */ `#include <header>
#include <atmosphere>
${NEAR_INSTANCE_GLSL}
in vec3 a_pos;
in vec3 a_normal;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_up;
out float v_variant;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 base = nearBase();
  mat3 axes = nearAxes(base);
  v_world = nearPoint(a_pos);
  v_air = atmosphereAir(v_world, v_airThrough);
  vec3 scale = vec3(i_shape.x, i_shape.y, i_shape.x);
  v_normal = axes * normalize(a_normal / max(scale, vec3(1e-6)));
  v_color = i_color.rgb;
  v_up = a_pos.y;
  v_variant = i_color.w;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const DETAIL_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${SURFACE_LOOK}
${WEATHER_NEAR}
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_up;
in float v_variant;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  float kind = floor(v_variant + 0.0005);
  vec3 up = localUp(v_world);
  vec3 n = normalize(v_normal);
  vec3 col = v_color;
  float ao = 1.0;
  if (kind < 0.5) {
    // A tuft: the ground's colour, lighter and a little yellower toward the tips.
    float tip = clamp(v_up, 0.0, 1.0);
    col *= mix(0.7, 1.25, tip);
    col = mix(col, col * vec3(1.08, 1.06, 0.8), tip * 0.5);
    n = normalize(mix(up, n, 0.25));
    ao = mix(0.6, 1.0, smoothstep(0.0, 0.5, v_up));
  } else if (kind > 1.5) {
    // A flower: a green stem under the head.
    if (v_up < 0.8) col = vec3(0.24, 0.42, 0.16) * mix(0.7, 1.0, clamp(v_up, 0.0, 1.0));
    n = normalize(mix(up, n, 0.3));
    ao = mix(0.65, 1.0, smoothstep(0.0, 0.6, v_up));
  } else {
    float grain = vnoise3(patternPos(v_world) * 6.0, 52u);
    col *= 0.84 + 0.3 * grain;
    ao = mix(0.6, 1.0, smoothstep(0.0, 0.4, v_up));
  }
  float w = weatherNear(v_world);
  col *= mix(1.0, 0.75, u_weather.y * w);
  col = mix(col, u_snow.rgb, u_weather.x * w * smoothstep(0.45, 0.85, dot(n, up)));
  float sun = sunVisibility(v_world, n, 1.0) * u_cloudFieldLight.y;
  vec3 c = toDisplay(col * bareLight(n, up, sun) * ao);
  if (u_airNear > 0.0) c = mix(c, atmosphereApply(toDisplay(col * atmosphereLight(v_world, n, sun, ao)), v_world, v_air, v_airThrough), u_airNear);
  o_color = vec4(c, 1.0);
}`;

/** Details near the camera on Hearth, colour pass only, both faces. Needs `u_toSun`, `u_airNear` and `u_eyePos`. */
export const DETAIL_MATERIAL: MaterialDesc = {
  name: 'system-detail',
  attribs: DETAIL_ATTRIBS,
  passes: { color: { vs: DETAIL_VS, fs: DETAIL_FS } },
  state: { color: { cullBack: false } },
};

// --- Stage 5 of Hearth: the shade of the relief (shade.ts) -----------------------------------------------------------
// The same texts as the materials of stages 2–4 with one more factor on the sun: `horizonLit` of the engine (gen-plan)
// from the skyline codes the vertices carry (`a_extra`, blended between levels like the colour; per instance `i_extra`),
// the place's up and the direction to the sun, both in the body's turning frame. The streamed surface is drawn in that
// frame (render space differs from it only by the origin); the far body turns them back by `u_model`. With
// `u_shadeView` set (key H) the surface shows the lit factor alone, in grey. The texts above stay as they are.

/** Applies exact replacements to a shader text; throws when one does not find its anchor. */
function edited(name: string, src: string, edits: readonly (readonly [string | RegExp, (match: string, ...groups: string[]) => string])[]): string {
  let out = src;
  for (const [anchor, to] of edits) {
    const found = typeof anchor === 'string' ? out.includes(anchor) : anchor.test(out);
    if (!found) throw new Error(`shaders: the shade variant of ${name} found no ${String(anchor)}`);
    out = out.replace(anchor, to);
  }
  return out;
}

const SHADE_SOFT = SHADE.soft.toFixed(4);

/** Fragment side: the codes, the view switch and `horizonLit`, after the declarations; the sun times the lit factor. */
function shadeFs(name: string, src: string): string {
  return edited(name, src, [
    ['out vec4 o_color;\n', (m) => `${m}in vec4 v_extra;\nuniform float u_shadeView;\n${HORIZON_GLSL}`],
    [/ {2}float sun = (sunVisibility\([^;]*);/, (_m, rest) => `  float lit = horizonLit(v_extra, up, u_toSun, ${SHADE_SOFT});\n  float sun = ${rest} * lit;`],
    ['\n  o_color = ', (m) => `\n  if (u_shadeView > 0.5) c = vec3(lit);${m}`],
  ]);
}

/** Vertex side of a mesh with `a_extra` (and, for the terrain, `a_coarseExtra` blended by the morph factor `m`). */
function shadeVs(name: string, src: string, coarse: boolean): string {
  return edited(name, src, [
    ['void main() {', (m) => `in vec4 a_extra;\n${coarse ? 'in vec4 a_coarseExtra;\n' : ''}out vec4 v_extra;\n${m}`],
    ['  v_world = p;', (m) => `${m}\n  v_extra = ${coarse ? 'mix(a_extra, a_coarseExtra, m)' : 'a_extra'};`],
  ]);
}

const SHADE_TERRAIN_VS = shadeVs('terrain', TERRAIN_VS, true);
const SHADE_TERRAIN_FS = shadeFs('terrain', CLIMATE_TERRAIN_FS);
const SHADE_OBJECT_VS = edited('object', OBJECT_VS, [
  ['out vec3 v_world;', (m) => `in vec4 i_extra;\nout vec4 v_extra;\n${m}`],
  ['  v_variant = i_color.w;', (m) => `${m}\n  v_extra = i_extra;`],
]);
const SHADE_OBJECT_FS = shadeFs('object', CLIMATE_OBJECT_FS);

/** Attributes of the objects of stage 5: those of the objects and `i_extra` (planned-cell.ts, `OBJECT_EXTRA_LAYOUT`). */
export const SHADE_OBJECT_ATTRIBS = { ...OBJECT_ATTRIBS, i_extra: 6 } as const;
/** Attributes of the strips of stage 5: those of the strip tool and `a_extra` (planned-cell.ts, `STRIP_EXTRA_LAYOUT`). */
export const SHADE_STRIP_ATTRIBS = { ...STRIP_ATTRIBS, a_extra: 4 } as const;

/** The streamed surface of Hearth at stage 5. Uniforms of `CLIMATE_TERRAIN_MATERIAL` and `u_shadeView`. */
export const SHADE_TERRAIN_MATERIAL: MaterialDesc = {
  name: 'system-shade-terrain',
  attribs: SPHERE_PATCH_COVER_EXTRA_ATTRIBS,
  passes: { color: { vs: SHADE_TERRAIN_VS, fs: SHADE_TERRAIN_FS }, shadow: { vs: TERRAIN_DEPTH_VS, fs: DEPTH_FS } },
};

/** Objects on Hearth at stage 5. Uniforms of `CLIMATE_OBJECT_MATERIAL` and `u_shadeView`. */
export const SHADE_OBJECT_MATERIAL: MaterialDesc = {
  name: 'system-shade-object',
  attribs: SHADE_OBJECT_ATTRIBS,
  passes: { color: { vs: SHADE_OBJECT_VS, fs: SHADE_OBJECT_FS }, shadow: { vs: OBJECT_DEPTH_VS, fs: DEPTH_FS } },
};

/** The rivers at stage 5. Uniforms of `WATER_MATERIAL` and `u_shadeView`. */
export const SHADE_WATER_MATERIAL: MaterialDesc = {
  name: 'system-shade-water',
  attribs: SHADE_STRIP_ATTRIBS,
  passes: { color: { vs: shadeVs('water', WATER_VS, false), fs: shadeFs('water', WATER_FS) } },
  state: WATER_MATERIAL.state!,
};

/** The lanes, roads and decks at stage 5. Uniforms of `WAY_MATERIAL` and `u_shadeView`. */
export const SHADE_WAY_MATERIAL: MaterialDesc = {
  name: 'system-shade-way',
  attribs: SHADE_STRIP_ATTRIBS,
  passes: { color: { vs: shadeVs('way', WAY_VS, false), fs: shadeFs('way', WAY_FS) } },
  state: WAY_MATERIAL.state!,
};

/** Attributes of the cells drawn from afar at stage 5: the cover layout with the extra channel. */
export const FAR_BODY_SHADE_ATTRIBS = SPHERE_PATCH_COVER_EXTRA_ATTRIBS;

/** `FAR_BODY_VS` with the codes passed on (a cell without the channel gives the attribute's default, unread). */
export const FAR_BODY_SHADE_VS = edited('far body', FAR_BODY_VS, [
  ['out vec3 v_world;', (m) => `in vec4 a_extra;\nout vec4 v_extra;\n${m}`],
  ['  v_cover = a_cover;', (m) => `${m}\n  v_extra = a_extra;`],
]);

/**
 * `FAR_BODY_FS` with the shade: read only where `u_shade` is 1 (a body whose cells carry the channel), so a missing
 * attribute never shades. Up and the sun are turned back into the body's frame by `u_model`.
 */
export const FAR_BODY_SHADE_FS = edited('far body', FAR_BODY_FS, [
  ['out vec4 o_color;\n', (m) => `${m}uniform mat4 u_model;\nuniform float u_shade;\nuniform float u_shadeView;\nin vec4 v_extra;\n${HORIZON_GLSL}`],
  [
    '  vec3 c = toDisplay(col * bareLight(n, up, 1.0) + bareGlint(up, sea));',
    () =>
      `  mat3 back = transpose(mat3(u_model));\n  float lit = u_shade > 0.5 ? horizonLit(v_extra, back * up, back * u_toSun, ${SHADE_SOFT}) : 1.0;\n  vec3 c = toDisplay(col * bareLight(n, up, lit) + bareGlint(up, sea * lit));`,
  ],
  ['\n  o_color = ', (m) => `\n  if (u_shadeView > 0.5 && u_shade > 0.5) c = vec3(lit);${m}`],
]);

// --- Stage 5 of Hearth: the lights of the settlements at night (lights.ts) -------------------------------------------
// One additive draw of round soft sprites, four corners per light. The points are in the body's own frame and placed
// as the far body places its cells (`u_model`, `u_body`), so they sit on the surface under them in both ways of
// drawing the body. A light is on by the sun's height over its own up, staggered by its phase; a far point (one per
// site) gives way to the near ones (one per lit structure) between 10 and 5 km from the eye.

/** Attributes of a corner of a light sprite (`LightsLayer`). */
export const LIGHT_ATTRIBS = { a_pos: 0, a_size: 1, a_color: 2, a_corner: 3 } as const;

export const LIGHT_VS = /* glsl */ `#include <header>
#include <noise>
${WITHIN_DEPTH}
uniform mat4 u_model;       // the body's turning frame → render space
uniform vec4 u_body;        // xyz centre of the body in render space, w the size it is drawn at
uniform vec3 u_toSun;       // unit direction to the sun, render axes
uniform float u_bodyRadius; // radius of the body, m
in vec3 a_pos;    // metres from the body's centre, its own axes
in float a_size;  // metres
in vec4 a_color;  // rgb colour, a the phase
in vec3 a_corner; // xy corner of the sprite (±1), z: 0 near, 1 far, 2 far of the town
out vec2 v_corner;
out vec3 v_color;
void main() {
  mat3 turn = mat3(u_model);
  vec3 up = normalize(turn * a_pos);
  vec3 p = u_body.xyz + turn * a_pos * u_body.w;
  float far = step(0.5, a_corner.z);
  float town = step(1.5, a_corner.z);
  // On one by one from sunset to about 6 degrees under the horizon (lightGain of lights.ts).
  float gain = clamp((0.02 - 0.12 * a_color.a - dot(up, u_toSun)) / 0.03, 0.0, 1.0);
  vec3 toEye = u_eyePos - p;
  float dist = max(length(toEye), 1e-3);
  // A far point gives way to the near ones of its site between 10 and 5 km; far points leave as the body shrinks.
  float span = smoothstep(5000.0, 10000.0, dist);
  float bodyPx = u_bodyRadius * u_body.w / metresPerPixelAt(u_body.xyz);
  gain *= mix(1.0 - span, span * smoothstep(30.0, 60.0, bodyPx), far);
  // Hidden where the eye is under the tangent plane of the ground under the light.
  vec3 ground = p - up * (mix(3.0, 20.0, far) * u_body.w);
  gain *= smoothstep(0.0, 0.01 * dist, dot(u_eyePos - ground, up));
  // Pulled toward the eye, clear of the facets of the surface under it.
  p += toEye * (min(0.004 * dist + 2.0, 0.5 * dist) / dist);
  float rw = a_size * mix(1.0, 0.7, far) * u_body.w;
  float mpp = metresPerPixelAt(p);
  float least = mix(1.2, 1.8, town);
  float px = rw / mpp;
  if (px < least) {
    // Never under the least size; the brightness falls with the true area instead, not under 0.35.
    gain *= max(0.35, (px * px) / (least * least));
    rw = least * mpp;
  }
  p += (u_camRight.xyz * a_corner.x + u_camUp.xyz * a_corner.y) * rw;
  v_corner = a_corner.xy;
  v_color = a_color.rgb * gain;
  gl_Position = gain > 0.0 ? u_viewProj * vec4(withinDepth(p), 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

export const LIGHT_FS = /* glsl */ `#include <header>
in vec2 v_corner;
in vec3 v_color;
out vec4 o_color;
void main() {
  float r2 = dot(v_corner, v_corner);
  if (r2 >= 1.0) discard;
  float a = 1.0 - r2;
  o_color = vec4(v_color * (1.6 * a * a), 1.0);
}`;
