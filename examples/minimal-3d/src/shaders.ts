// Materials of the example. Every program starts with the engine's header and lighting, so the sun, sky, fog and
// shadows come from the environment. The glow at night comes from the example's own environment slot (`u_glow`).
// Every colour ends with `aerialPerspective` from `<sky>`: distant geometry fades into the sky behind it.

import type { MaterialDesc } from 'wallhammer-web/base';
import { SOLID_ATTRIBS } from './scene.ts';

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
void main() {
  vec3 n = normalize(v_normal);
  // Meadow on the gentle slopes, ochre earth where it is steep, a darker rim below the waterline of the island.
  float patchN = vnoise(v_world.xz / 9.0, 11u) * 0.6 + vnoise(v_world.xz / 2.3, 12u) * 0.4 * detailVisibleAt(2.3, v_world);
  vec3 meadow = mix(vec3(0.36, 0.41, 0.26), vec3(0.48, 0.49, 0.33), patchN);
  vec3 earth = mix(vec3(0.48, 0.38, 0.26), vec3(0.56, 0.47, 0.33), patchN);
  vec3 col = mix(earth, meadow, smoothstep(0.78, 0.92, n.y));
  col = mix(vec3(0.3, 0.27, 0.24), col, smoothstep(-0.5, 1.5, v_world.y));
  col = mix(col, u_snow.rgb, u_weather.x * smoothstep(0.6, 0.9, n.y));
  float sun = sunVisibility(v_world, n, 1.2);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const STONE_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_base;   // xyz base point, w reach radius
in vec4 i_shape;  // x height, y yaw, z width, w depth
out vec3 v_world;
out vec3 v_normal;
out float v_up;   // 0 at the base, 1 at the top of the stone
void main() {
  vec3 s = vec3(i_shape.z, i_shape.x, i_shape.w);
  float c = cos(i_shape.y), sn = sin(i_shape.y);
  mat3 rot = mat3(c, 0.0, -sn, 0.0, 1.0, 0.0, sn, 0.0, c);
  v_world = i_base.xyz + rot * (a_pos * s);
  v_normal = rot * normalize(a_normal / s);
  v_up = a_pos.y;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const STONE_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
in vec4 i_base;
in vec4 i_shape;
void main() {
  vec3 s = vec3(i_shape.z, i_shape.x, i_shape.w);
  float c = cos(i_shape.y), sn = sin(i_shape.y);
  mat3 rot = mat3(c, 0.0, -sn, 0.0, 1.0, 0.0, sn, 0.0, c);
  gl_Position = u_lightRender * vec4(i_base.xyz + rot * (a_pos * s), 1.0);
}`;

const DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
void main() {}`;

const STONE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
uniform vec3 u_albedo;
uniform float u_glowBand; // 0 no glow, otherwise the stone's top band glows at night
in vec3 v_world;
in vec3 v_normal;
in float v_up;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float grain = vnoise(v_world.xz * 1.7 + v_world.y * 2.3, 21u) * detailVisibleAt(0.6, v_world);
  float lichen = smoothstep(0.55, 0.8, vnoise(v_world.xz / 1.4 + v_world.y, 22u)) * smoothstep(0.2, 0.8, n.y + 0.4);
  vec3 col = u_albedo * (0.86 + 0.24 * grain);
  col = mix(col, vec3(0.55, 0.56, 0.32), 0.45 * lichen);
  col = mix(col, u_snow.rgb, u_weather.x * smoothstep(0.55, 0.85, n.y));
  // Darker at the foot, where the stone meets the ground.
  float ao = mix(0.6, 1.0, smoothstep(-0.3, 0.25, v_up));
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, ao));
  float band = u_glowBand * smoothstep(0.78, 0.86, v_up) * (1.0 - smoothstep(0.93, 0.95, v_up));
  c += u_glow.rgb * band * u_glow.w;
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const SOLID_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
out vec3 v_world;
out vec3 v_normal;
void main() {
  v_world = a_pos;
  v_normal = a_normal;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const SOLID_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
uniform vec3 u_albedo;
uniform float u_water;     // 1: water that mirrors the sky; 0: polished stone
uniform float u_glowShare; // how much of the night glow the top faces pick up
in vec3 v_world;
in vec3 v_normal;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 toEye = skyToEye(v_world);
  vec3 c;
  if (u_water > 0.5) {
    // Water: slow ripples tilt the normal, Fresnel mirrors the sky (dark at night), a small glint of the sun or moon.
    // The ripples calm down with distance long before their cells reach a pixel, so the far sea is a clean mirror.
    vec2 w = v_world.xz / 6.0 + u_time.x * vec2(0.05, 0.03);
    vec2 tilt = (vec2(vnoise(w, 31u), vnoise(w + 13.0, 32u)) - 0.5) * 0.07 * detailVisibleAt(30.0, v_world)
      + (vec2(vnoise(w * 2.7 + 5.0, 33u), vnoise(w * 2.7 + 19.0, 34u)) - 0.5) * 0.04 * detailVisibleAt(12.0, v_world);
    vec3 nr = normalize(vec3(tilt.x, 1.0, tilt.y));
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(nr, toEye), 0.0), 5.0);
    c = toDisplay(u_albedo * u_warmTint.rgb * lightOn(n, sun, 1.0));
    c = mix(c, skyColorDir(reflect(-toEye, nr)), 0.9 * fres);
    float glint = pow(max(dot(reflect(-u_sunDir.xyz, nr), toEye), 0.0), 180.0) * sun;
    c += min(u_sunColor.rgb, vec3(1.0)) * glint * 0.7;
  } else {
    // A polished surface: a soft sheen toward the sun on top of the diffuse light.
    float sheen = pow(max(dot(reflect(-u_sunDir.xyz, n), toEye), 0.0), 24.0) * sun;
    c = toDisplay(u_albedo * u_warmTint.rgb * lightOn(n, sun, 1.0) + u_sunColor.rgb * sheen * 0.35);
  }
  c += u_glow.rgb * u_glow.w * u_glowShare * smoothstep(0.2, 0.9, n.y);
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

export const GROUND_MATERIAL: MaterialDesc = {
  name: 'ground',
  attribs: { a_pos: 0, a_normal: 1 },
  passes: { shadow: 'depth', color: { vs: GROUND_VS, fs: GROUND_FS } },
};

export const STONE_MATERIAL: MaterialDesc = {
  name: 'stone',
  attribs: SOLID_ATTRIBS,
  passes: { shadow: { vs: STONE_DEPTH_VS, fs: DEPTH_FS }, color: { vs: STONE_VS, fs: STONE_FS } },
};

export const SOLID_MATERIAL: MaterialDesc = {
  name: 'solid',
  attribs: { a_pos: 0, a_normal: 1 },
  passes: { shadow: 'depth', color: { vs: SOLID_VS, fs: SOLID_FS } },
};
