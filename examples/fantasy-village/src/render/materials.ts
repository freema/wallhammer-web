// Materials of the village. One painted solid material draws every opaque thing (static chunks and instanced parts,
// the same vertex format, kit/mesh.ts) and a water material draws the river. Smoke, steam, dust, fire and sparks are
// the engine's `ParticleLayer`. Every program starts from the engine's header, so sun, sky, shadows and fog come from
// the environment; the point lights come from the engine's `<point-lights>` include (a `PointLightSet` must exist
// before these materials are compiled); `u_villageGlow` and `u_villageHaze` come from the example's slot (src/env.ts).
//
// The hand-painted look comes from:
//   - vertex colours with baked occlusion (generators paint, kit/ao.ts darkens corners)
//   - painted breakup per material class (soft 3D noise at two scales, moss on stone and roofs, stains on plaster,
//     lighter tops on foliage), faded out before it would shimmer (`detailVisibleAt`)
//   - a soft top light, a sky rim on silhouettes and a little extra saturation
//   - up to 32 warm point lights (windows, lanterns, the forge), with flicker; each chunk visits only the lights that
//     reach its box (engine `PieceLayer` with `lights`)
//   - glow by channel: evening (windows, lanterns), fire (forge, hearths), steady
//   - a distance haze that tints toward warm peach in the afternoon and violet in the evening, then the engine's
//     aerial perspective

import type { MaterialDesc } from 'wallhammer-web/base';
import { DEPTH_FS, INSTANCE_SET_GLSL, instanceSetAttribs } from 'wallhammer-web/render';

/** Most point lights selected per frame (the engine's `PointLightSet` is made with this). */
export const MAX_LIGHTS = 32;

/**
 * Attribute locations shared by the solid programs and meshes; the part instance record (engine instance set: matrix
 * columns `i_m0`–`i_m2`, then tint rgb and glow in `i_extra`) follows the vertex attributes.
 */
export const SOLID_ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2, a_flags: 3, ...instanceSetAttribs(4) } as const;

// --- Shared GLSL -------------------------------------------------------------------------------------------------------

/** Wind sway of a world point (vertex shaders): leaves and grass move with the wind, more in gusts. */
const SWAY_GLSL = /* glsl */ `
vec3 swayed(vec3 w, float amount) {
  if (amount <= 0.0) return w;
  float t = u_time.x;
  float ph = dot(w.xz, vec2(0.21, 0.17));
  float gust = 0.55 + 0.45 * sin(t * 0.63 + w.x * 0.045 - w.z * 0.031);
  float main = sin(t * 1.55 + ph) * 0.5 + 0.5;
  float flutter = sin(t * 4.7 + ph * 3.3) * sin(t * 3.1 + ph * 1.7);
  vec2 dir = u_wind.xy;
  vec2 side = vec2(-dir.y, dir.x);
  vec2 off = (dir * (main * gust * 0.9 + 0.1) + side * flutter * 0.25) * 0.17 * amount;
  return w + vec3(off.x, -0.03 * amount * main * gust, off.y);
}
`;

function solidVs(instanced: boolean): string {
  return /* glsl */ `#include <header>
in vec3 a_pos;
in vec4 a_normal;
in vec4 a_color;
in vec4 a_flags;
${instanced ? INSTANCE_SET_GLSL : ''}
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
out vec4 v_flags;
out float v_extraGlow;
${SWAY_GLSL}
void main() {
${
  instanced
    ? `  vec3 w = instancePoint(a_pos);
  v_normal = instanceNormal(a_normal.xyz);
  v_color = vec4(a_color.rgb * i_extra.rgb, a_color.a);
  v_extraGlow = i_extra.w;`
    : `  vec3 w = a_pos;
  v_normal = a_normal.xyz;
  v_color = a_color;
  v_extraGlow = 0.0;`
}
  w = swayed(w, a_flags.y);
  v_world = w;
  v_flags = a_flags;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;
}

function solidDepthVs(instanced: boolean): string {
  return /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
in vec4 a_flags;
${instanced ? INSTANCE_SET_GLSL : ''}
${SWAY_GLSL}
void main() {
  vec3 w = ${instanced ? 'instancePoint(a_pos)' : 'a_pos'};
  w = swayed(w, a_flags.y);
  gl_Position = u_lightRender * vec4(w, 1.0);
}`;
}

/** Glow strength of a channel (GLOW in kit/mesh.ts): 0 evening, 1 fire (flickering), 2 steady. */
const GLOW_GLSL = /* glsl */ `
float glowChannel(float code, vec3 w) {
  if (code < 0.5) return u_villageGlow.x;
  if (code < 1.5) {
    float f = 0.78 + 0.22 * vnoise(vec2(u_time.x * 7.0, dot(w, vec3(0.7, 1.3, 0.9))), 91u);
    return u_villageGlow.y * f;
  }
  return u_villageGlow.z;
}
vec3 villageHaze(vec3 c, vec3 w) {
  float dist = length(w - u_skyEye.xyz);
  float h = smoothstep(55.0, 520.0, dist) * u_villageGlow.w;
  vec3 haze = u_villageHaze.rgb * mix(1.0, 0.62, u_villageHaze.w);
  return mix(c, haze, h);
}
`;

const SOLID_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
#include <point-lights>
in vec3 v_world;
in vec3 v_normal;
in vec4 v_color;
in vec4 v_flags;
in float v_extraGlow;
out vec4 o_color;
${GLOW_GLSL}

// Painted breakup by material class (MAT in kit/mesh.ts). Noise that detailVisibleAt fades to exactly 0 is not
// computed at all (the same result: it would be multiplied by 0).
vec3 painted(vec3 albedo, float cls, vec3 w, vec3 n) {
  float fine = detailVisibleAt(0.25, w);
  float mid = detailVisibleAt(0.9, w);
  float big = vnoise3(w / 2.6, 3u);
  float m = mid > 0.0 ? vnoise3(w / 0.9, 4u) * mid : 0.0;
  float f = fine > 0.0 ? vnoise3(w / 0.24, 5u) * fine : 0.0;
  float amp = 0.18;
  vec3 c = albedo;
  if (cls == 1.0 || cls == 10.0) {
    // Wood and bark: streaky, darker knots.
    float streak = fine > 0.0 ? vnoise3(w * vec3(1.0, 5.5, 1.0) / 0.6, 6u) * fine : 0.0;
    c *= 0.86 + 0.2 * streak + 0.12 * m - 0.1 * smoothstep(0.78, 0.86, f);
    amp = 0.0;
  } else if (cls == 2.0 || cls == 8.0) {
    // Stone and roofs: blotches and moss on what faces up.
    c *= 0.82 + 0.28 * m + 0.12 * f;
    float moss = smoothstep(0.55, 0.85, big + 0.25 * m) * smoothstep(0.2, 0.75, n.y);
    c = mix(c, vec3(0.36, 0.43, 0.2) * (0.8 + 0.4 * f), moss * (cls == 8.0 ? 0.42 : 0.55));
    amp = 0.0;
  } else if (cls == 3.0) {
    // Plaster: soft mottling and vertical stains.
    float stain = vnoise3(vec3(w.x * 2.2, w.y * 0.35, w.z * 2.2), 7u);
    c *= 0.9 + 0.12 * big + 0.08 * m - 0.1 * smoothstep(0.6, 0.9, stain);
    amp = 0.0;
  } else if (cls == 4.0) {
    // Foliage: leaf clusters, warmer and lighter toward the sky.
    c *= 0.72 + 0.4 * m + 0.18 * f;
    c = mix(c, c * vec3(1.25, 1.2, 0.8), smoothstep(0.2, 1.0, n.y) * 0.6);
    amp = 0.0;
  } else if (cls == 7.0) {
    amp = 0.26;
  } else if (cls == 5.0 || cls == 11.0 || cls == 12.0) {
    amp = 0.06;
  } else if (cls == 6.0 || cls == 9.0) {
    amp = 0.05;
  }
  return c * (1.0 - amp * 0.5 + amp * (0.6 * m + 0.4 * f + 0.3 * (big - 0.5)));
}

void main() {
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  float cls = floor(v_flags.z * 255.0 + 0.5);
  float channel = floor(v_flags.w * 255.0 + 0.5);
  vec3 albedo = painted(v_color.rgb, cls, v_world, n);
  // A little extra saturation and a soft painted top light.
  float lum = dot(albedo, vec3(0.3, 0.55, 0.15));
  albedo = max(mix(vec3(lum), albedo, 1.14), 0.0) * (0.94 + 0.12 * max(n.y, 0.0));
  float ao = v_color.a;
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 toEye = skyToEye(v_world);
  vec3 light = lightOn(n, sun, ao) + pointLights(v_world, n, 0.35) * mix(0.55, 1.0, ao);
  // Metal and glass get a sheen toward the sun.
  float shiny = (cls == 6.0 || cls == 9.0) ? 1.0 : 0.0;
  vec3 spec = u_sunColor.rgb * pow(max(dot(reflect(-u_sunDir.xyz, n), toEye), 0.0), 28.0) * sun * 0.45 * shiny;
  vec3 c = toDisplay(albedo * u_warmTint.rgb * light + spec);
  // Sky rim on silhouettes.
  float rim = pow(1.0 - max(dot(n, toEye), 0.0), 3.0) * (0.5 + 0.5 * ao);
  c += u_skyFill.rgb * rim * 0.22;
  // Glow: the vertex colour shines by its channel; instances add evening glow.
  // Instance glow 0–1 follows the evening; above 1 it shines always with (glow − 1) (sparks in daylight).
  float eg = v_extraGlow > 1.0 ? v_extraGlow - 1.0 : v_extraGlow * u_villageGlow.x;
  float g = v_flags.x * glowChannel(channel, v_world) + eg;
  c += v_color.rgb * g * 1.6;
  c = villageHaze(c, v_world);
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

/** Static solid chunks (vertex format of kit/mesh.ts). */
export const SOLID_MATERIAL: MaterialDesc = {
  name: 'village-solid',
  attribs: SOLID_ATTRIBS,
  passes: { shadow: { vs: solidDepthVs(false), fs: DEPTH_FS }, color: { vs: solidVs(false), fs: SOLID_FS } },
};

/** Instanced parts: the same shading, per-instance transform and tint. */
export const PART_MATERIAL: MaterialDesc = {
  name: 'village-parts',
  attribs: SOLID_ATTRIBS,
  passes: { shadow: { vs: solidDepthVs(true), fs: DEPTH_FS }, color: { vs: solidVs(true), fs: SOLID_FS } },
};

// --- Water ---------------------------------------------------------------------------------------------------------------

const WATER_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec4 a_normal;
in vec4 a_color;
in vec4 a_flags;
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
out vec4 v_flags;
void main() {
  v_world = a_pos;
  v_normal = a_normal.xyz;
  v_color = a_color;
  v_flags = a_flags;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const WATER_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
#include <point-lights>
in vec3 v_world;
in vec3 v_normal;
in vec4 v_color;
in vec4 v_flags;
out vec4 o_color;
${GLOW_GLSL}
void main() {
  vec3 n0 = normalize(v_normal);
  float foamShare = v_flags.x;
  float speed = v_flags.y * 4.0;
  vec2 dir = v_flags.zw * 2.0 - 1.0;
  float dl = length(dir);
  dir = dl > 0.01 ? dir / dl : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);
  // Flow coordinates: across, and along minus the distance the water has travelled.
  vec2 q = vec2(dot(v_world.xz, side), dot(v_world.xz, dir) - u_time.x * speed);
  float d1 = detailVisibleAt(1.2, v_world);
  float d2 = detailVisibleAt(0.35, v_world);
  // Ripples that detailVisibleAt fades to exactly 0 are not computed (the same sum, in the same order).
  vec2 tilt = vec2(0.0);
  if (d1 > 0.0) tilt = (vec2(vnoise(q / 1.6, 41u), vnoise(q / 1.6 + 17.0, 42u)) - 0.5) * 0.22 * d1;
  if (d2 > 0.0) tilt += (vec2(vnoise(q * vec2(2.8, 1.4) + 3.0, 43u), vnoise(q * vec2(2.8, 1.4) + 9.0, 44u)) - 0.5) * 0.12 * d2;
  tilt += (vec2(vnoise(v_world.xz / 4.0 + u_time.x * 0.07, 45u), vnoise(v_world.xz / 4.0 - u_time.x * 0.05, 46u)) - 0.5) * 0.08;
  // Tilt from flow coordinates back to world x, z.
  vec3 tiltW = vec3(tilt.x * side.x + tilt.y * dir.x, 0.0, tilt.x * side.y + tilt.y * dir.y);
  vec3 n = normalize(n0 + tiltW);
  vec3 toEye = skyToEye(v_world);
  float sun = sunVisibility(v_world, n0, 1.0);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, toEye), 0.0), 5.0);
  vec3 body = toDisplay(v_color.rgb * u_warmTint.rgb * (lightOn(n0, sun, 1.0) + pointLights(v_world, n0, 1.0) * 0.6));
  vec3 refl = skyColorDir(reflect(-toEye, n));
  vec3 c = mix(body, refl, clamp(fres * 0.85, 0.0, 0.85));
  float glint = pow(max(dot(reflect(-u_sunDir.xyz, n), toEye), 0.0), 140.0) * sun;
  c += min(u_sunColor.rgb, vec3(1.2)) * glint * 0.8;
  // Lantern and window light shimmering on the water.
  c += pointLights(v_world + vec3(0.0, 0.4, 0.0), vec3(0.0, 1.0, 0.0), 1.0) * (0.25 + 0.75 * fres) * 0.35;
  // Foam: banks, stones, the foot of the weir; drawn in streaks along the flow.
  float foamN = vnoise(q * vec2(1.6, 0.55), 47u) * 0.6 + (d2 > 0.0 ? vnoise(q * vec2(4.0, 1.5), 48u) * 0.4 * d2 : 0.0);
  float foam = clamp(smoothstep(1.0 - foamShare, 1.05 - foamShare * 0.6, foamN) * (0.4 + foamShare), 0.0, 1.0);
  vec3 foamC = toDisplay(vec3(0.92, 0.94, 0.95) * u_warmTint.rgb * lightOn(vec3(0.0, 1.0, 0.0), sun, 1.0));
  c = mix(c, foamC, foam);
  c = villageHaze(c, v_world);
  float alpha = clamp(v_color.a + fres * 0.35 + foam * 0.6, 0.0, 1.0);
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), alpha);
}`;

/** The river (and any other water piece), blended over the bed, no depth writes, drawn after the solids. */
export const WATER_MATERIAL: MaterialDesc = {
  name: 'village-water',
  attribs: SOLID_ATTRIBS,
  passes: { color: { vs: WATER_VS, fs: WATER_FS } },
  state: { color: { depthWrite: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha', srcAlpha: 'one', dstAlpha: 'one-minus-src-alpha' } } },
};
