// Materials of the test course. Every lit program starts with the engine's header and lighting, so sun, sky, shadows
// and fog come from the environment, and ends with `aerialPerspective`. Five materials:
//   - ground: the base surface with a metre grid (every fifth line stronger), so gaps and heights can be read off
//   - solid: the solids of the collision world, flat-shaded in the colour of their station
//   - figure: the box figure (`figure=boxes`), parts of the engine's instance set (`INSTANCE_SET_GLSL`), a moving
//     shadow caster
//   - pathfinder: the shared pathfinder figure (the default), its vertices with a colour and a material each (plain,
//     tinted by the part's colour slot, or a light: the lantern's glass)
//   - wire: the debugging wireframe of the solids, one colour per layer, pulled a little toward the eye

import type { MaterialDesc } from 'wallhammer-web/base';
import { DEPTH_FS, INSTANCE_SET_GLSL, instanceSetAttribs } from 'wallhammer-web/render';

const GROUND_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec4 a_normal;
out vec3 v_world;
out vec3 v_normal;
void main() {
  v_world = a_pos;
  v_normal = a_normal.xyz;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const GROUND_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
out vec4 o_color;
// Antialiased grid line every 'every' metres, 'width' in pixels.
float gridLine(vec2 p, float every, float width) {
  vec2 g = p / every;
  vec2 w = fwidth(g) * width;
  vec2 d = abs(fract(g - 0.5) - 0.5);
  vec2 l = 1.0 - smoothstep(w * 0.5, w, d);
  return max(l.x, l.y);
}
void main() {
  vec3 n = normalize(v_normal);
  float patchN = vnoise(v_world.xz / 7.0, 11u) * 0.6 + vnoise(v_world.xz / 1.9, 12u) * 0.4 * detailVisibleAt(1.9, v_world);
  vec3 meadow = mix(vec3(0.34, 0.42, 0.27), vec3(0.45, 0.5, 0.33), patchN);
  vec3 earth = mix(vec3(0.5, 0.42, 0.32), vec3(0.58, 0.5, 0.38), patchN);
  vec3 col = mix(earth, meadow, smoothstep(0.7, 0.85, n.y));
  // The grid fades out where its lines would be thinner than a pixel apart.
  float fine = gridLine(v_world.xz, 1.0, 1.2) * detailVisibleAt(1.0, v_world);
  float coarse = gridLine(v_world.xz, 5.0, 1.6) * detailVisibleAt(5.0, v_world);
  col = mix(col, col * 0.72, 0.55 * fine);
  col = mix(col, vec3(0.92, 0.9, 0.82), 0.45 * coarse);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const SOLID_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_color;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
void main() {
  v_world = a_pos;
  v_normal = a_normal;
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const SOLID_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float grain = vnoise(v_world.xz * 1.3 + v_world.y * 2.1, 21u) * detailVisibleAt(0.8, v_world);
  vec3 col = v_color * (0.9 + 0.16 * grain);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const FIGURE_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
${INSTANCE_SET_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
void main() {
  vec3 w = instancePoint(a_pos);
  v_world = w;
  v_normal = instanceNormal(a_normal);
  v_color = i_extra.rgb;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

const FIGURE_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
${INSTANCE_SET_GLSL}
void main() {
  gl_Position = u_lightRender * vec4(instancePoint(a_pos), 1.0);
}`;

const FIGURE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 0.6);
  // A soft rim toward the eye, so the figure reads against the ground.
  float rim = pow(1.0 - max(dot(n, skyToEye(v_world)), 0.0), 3.0) * 0.25;
  vec3 c = toDisplay(v_color * u_warmTint.rgb * lightOn(n, sun, 1.0)) + rim;
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const PATHFINDER_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec4 a_color; // rgb colour, w material: 0 plain, 1 times the instance's tint, 2 a light
${INSTANCE_SET_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_material;
void main() {
  vec3 w = instancePoint(a_pos);
  v_world = w;
  v_normal = instanceNormal(a_normal);
  v_color = a_color.w > 0.5 && a_color.w < 1.5 ? a_color.rgb * i_extra.rgb : a_color.rgb;
  v_material = a_color.w;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

const PATHFINDER_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_material;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 0.6);
  vec3 lit = v_color * u_warmTint.rgb * lightOn(n, sun, 1.0);
  // The lantern's glass glows.
  if (v_material > 1.5) lit = mix(lit, v_color * 2.2, 0.6);
  o_color = vec4(aerialPerspective(applyFog(toDisplay(lit), v_world), v_world), 1.0);
}`;

const WIRE_VS = /* glsl */ `#include <header>
in vec3 a_pos;
void main() {
  // A few centimetres toward the eye, so the lines win over the faces they lie on.
  gl_Position = u_viewProj * vec4(a_pos - u_camForward.xyz * 0.04, 1.0);
}`;

const WIRE_FS = /* glsl */ `#include <header>
uniform vec3 u_color;
out vec4 o_color;
void main() {
  o_color = vec4(u_color, 1.0);
}`;

/** Ground: the engine's height field mesh (`HEIGHT_FIELD_ATTRIBS`). */
export const GROUND_MATERIAL: MaterialDesc = {
  name: 'ground',
  attribs: { a_pos: 0, a_normal: 1 },
  passes: { shadow: 'depth', color: { vs: GROUND_VS, fs: GROUND_FS } },
};

/** Solids: position, normal and colour per vertex (SOLID_LAYOUT in meshes.ts). Double-sided, so any winding works. */
export const SOLID_MATERIAL: MaterialDesc = {
  name: 'solid',
  attribs: { a_pos: 0, a_normal: 1, a_color: 2 },
  passes: { shadow: 'depth', color: { vs: SOLID_VS, fs: SOLID_FS } },
  state: { color: { cullBack: false }, shadow: { cullBack: false } },
};

/** Figure parts: position and normal per vertex, then the instance record of the engine's instance set. */
export const FIGURE_ATTRIBS = { a_pos: 0, a_normal: 1, ...instanceSetAttribs(2) } as const;
export const FIGURE_MATERIAL: MaterialDesc = {
  name: 'figure',
  attribs: FIGURE_ATTRIBS,
  passes: { shadow: { vs: FIGURE_DEPTH_VS, fs: DEPTH_FS }, color: { vs: FIGURE_VS, fs: FIGURE_FS } },
};

/** The pathfinder's parts: position, normal, colour and material per vertex (examples/shared mesh.ts), then the instance record. */
export const PATHFINDER_MATERIAL: MaterialDesc = {
  name: 'pathfinder',
  attribs: { a_pos: 0, a_normal: 1, a_color: 2, ...instanceSetAttribs(3) },
  passes: { shadow: { vs: FIGURE_DEPTH_VS, fs: DEPTH_FS }, color: { vs: PATHFINDER_VS, fs: PATHFINDER_FS } },
};

/** Wireframe: `LINE_LAYOUT` lines in one colour (`u_color`), drawn after the scene. */
export const WIRE_MATERIAL: MaterialDesc = {
  name: 'wire',
  attribs: { a_pos: 0 },
  passes: { color: { vs: WIRE_VS, fs: WIRE_FS } },
};
