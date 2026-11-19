// GLSL lighting functions over the environment's Frame members (see `ENV_CORE_SLOT`). They also read the renderer's
// members (light matrix, shadow map, view) by name. Registered as the shader include `lighting`; its first part, the
// shadow query without the light model, is also the include `shadow` (`shadowGlsl`).
// With a shadow mode that keeps shadow areas the renderer's header defines `WH_SHADOW_AREAS` and brings `whShadow`.
// With radial up (`WH_LOCAL_UP`, see the renderer's `radialUp`) the sky is over the local horizon: fill light, cloud
// shadows and fog follow `localUp` and `localHeight`, and the side turned away from the light gets neither sun nor sky.

import { CLOUD_DECK_GLSL, CLOUD_TERMS_GLSL } from './environment.ts';

/**
 * Octaves of the cloud field over the world: weight, frequency, offset and noise seed. Cloud shadows on the ground
 * (`cloudLight`) and the clouds in the sky (`<sky>`) are both built from this table, so they agree.
 */
export const CLOUD_OCTAVES: readonly (readonly [weight: string, frequency: string, offset: string, seed: number])[] = [
  ['0.55', '1.0', '0.0', 61],
  ['0.3', '2.3', '17.0', 62],
  ['0.15', '5.1', '41.0', 63],
];

/** The cloud field, 0–1, as a GLSL expression of `q` (world xz minus the drift, times 1 / cloud size). */
export const CLOUD_NOISE = CLOUD_OCTAVES.map(([w, f, o, seed], i) => `${w} * vnoise(${i === 0 ? 'q' : `q * ${f} + ${o}`}, ${seed}u)`).join(' + ');

/**
 * The cloud field for radial up, as a GLSL expression of a vec3 `q`: the point of the base surface, relative to the
 * centre, minus the drift, times 1 / cloud size. The same octaves in space instead of on a plane, so the field has no
 * seam and no pole.
 */
export const CLOUD_NOISE_RADIAL = CLOUD_OCTAVES.map(([w, f, o, seed], i) => `${w} * vnoise3(${i === 0 ? 'q' : `q * ${f} + ${o}`}, ${seed}u)`).join(' + ');

/**
 * `cloudShareAt`: the share of the sun the clouds leave at a point of the base surface, before the frame's overcast
 * dimming is divided out. Radial up: at unit up `up` of the base sphere of radius `radiusM`; flat: at world `xz`.
 * With `field` the cover is the cover by place (`cloudFieldCover`, which must come before), otherwise the one cover
 * of the frame. Under a closing deck (`cloudDeckClosed`) the pattern's gaps close; under a closed one the pattern's
 * octaves are left out.
 */
function cloudShareFunctions(field: boolean): string {
  const radial = field
    ? /* glsl */ `  float c = cloudFieldCover(up, radiusM);
  vec4 t = cloudCoverTerms(c, u_cloudFieldLight.x);
  if (t.z <= 0.0) return t.w;
  float k = cloudDeckClosed(c);
  if (k >= 1.0) return (1.0 - t.z) * t.w;
  vec3 q = (up * radiusM - vec3(u_cloud.x, 0.0, u_cloud.y)) * u_cloud.w;
  float n = ${CLOUD_NOISE_RADIAL};
  return (1.0 - t.z * mix(smoothstep(t.x, t.y, n), 1.0, k)) * t.w;`
    : /* glsl */ `  if (u_cloud.z <= 0.0) return 1.0;
  float k = cloudDeckClosed(u_snow.w);
  if (k >= 1.0) return 1.0 - u_cloud.z;
  vec3 q = (up * radiusM - vec3(u_cloud.x, 0.0, u_cloud.y)) * u_cloud.w;
  float n = ${CLOUD_NOISE_RADIAL};
  return 1.0 - u_cloud.z * mix(smoothstep(u_cloudEdge.x, u_cloudEdge.y, n), 1.0, k);`;
  return /* glsl */ `${CLOUD_DECK_GLSL}
#ifdef WH_LOCAL_UP
float cloudShareAt(vec3 up, float radiusM) {
${radial}
}
#else
float cloudShareAt(vec2 xz) {
  if (u_cloud.z <= 0.0) return 1.0;
  float k = cloudDeckClosed(u_snow.w);
  if (k >= 1.0) return 1.0 - u_cloud.z;
  vec2 q = (xz - u_cloud.xy) * u_cloud.w;
  float n = ${CLOUD_NOISE};
  return 1.0 - u_cloud.z * mix(smoothstep(u_cloudEdge.x, u_cloudEdge.y, n), 1.0, k);
}
#endif
`;
}

/** Body of `cloudLight` as it has always been: one cloud cover for the whole world. */
const CLOUD_LIGHT_GLOBAL = /* glsl */ `#ifdef WH_LOCAL_UP
  whUpHere = localUp(worldPos);
  return cloudShareAt(whUpHere, u_upCenter.w);
#else
  return cloudShareAt(worldPos.xz);
#endif`;

/**
 * Functions of the cloud cover by place (the slot `CLOUD_FIELD_SLOT`), for radial up only. The cover is a profile by
 * the angle to an axis plus drifting patches; the shadow pattern over it is the engine's cloud field.
 */
const CLOUD_FIELD_FUNCTIONS = /* glsl */ `
#ifdef WH_LOCAL_UP
${CLOUD_TERMS_GLSL}
// Cloud cover 0–1 above the place with unit up \`up\` on a sphere of radius \`radiusM\` (the frame of the field).
float cloudFieldCover(vec3 up, float radiusM) {
  float a = abs(dot(up, u_cloudFieldAxis.xyz)) * 7.0;
  float c = dot(u_cloudFieldZonalA, max(1.0 - abs(a - vec4(0.0, 1.0, 2.0, 3.0)), 0.0))
          + dot(u_cloudFieldZonalB, max(1.0 - abs(a - vec4(4.0, 5.0, 6.0, 7.0)), 0.0));
  if (u_cloudFieldAxis.w > 0.0) {
    vec3 q = (up * radiusM - u_cloudFieldPatch.xyz) * u_cloudFieldPatch.w;
    if (u_cloudFieldLight.z > 0.0) q += u_cloudFieldLight.z * (vnoise3(q * 0.6 + 31.0, 73u) - 0.5);
    float p = 0.65 * vnoise3(q, 71u) + 0.35 * vnoise3(q * 2.3 + 17.0, 72u);
    c += u_cloudFieldAxis.w * (2.0 * p - 1.0);
  }
  return clamp(c, 0.0, 1.0);
}

// From a cover and the shadow pattern's value there: x = sun share over the frame's dimming (S / G), y = how much
// cloud stands over the place (1 under a closed deck).
vec2 cloudFieldShade(float cover, float n) {
  vec4 t = cloudCoverTerms(cover, u_cloudFieldLight.x);
  float s = smoothstep(t.x, t.y, n);
  float sun = (1.0 - t.z * s) * t.w;
  return vec2(sun / max(u_cloudFieldLight.y, 1e-3), max(s * smoothstep(0.0, 0.04, cover), cloudOvercast(cover)));
}

// The cloud by place at unit up \`up\`: (S / G, cloud standing over it). Without any cover: (1, 0) and no lookup.
vec2 cloudFieldAt(vec3 up, float radiusM) {
  if (u_cloudFieldLight.w <= 0.0) return vec2(1.0, 0.0);
  float c = cloudFieldCover(up, radiusM);
  vec3 q = (up * radiusM - vec3(u_cloud.x, 0.0, u_cloud.y)) * u_cloud.w;
  return cloudFieldShade(c, ${CLOUD_NOISE_RADIAL});
}
#endif
`;

/**
 * Body of `cloudLight` with the cover by place: radial up reads the field (divided by the frame's dimming), the
 * planar code is today's. Under a clear sky and under a closed deck the pattern's octaves are left out.
 */
const CLOUD_LIGHT_FIELD = /* glsl */ `#ifdef WH_LOCAL_UP
  whUpHere = localUp(worldPos);
  if (u_cloudFieldLight.w <= 0.0) return 1.0;
  return cloudShareAt(whUpHere, u_upCenter.w) * (1.0 / max(u_cloudFieldLight.y, 1e-3));
#else
  return cloudShareAt(worldPos.xz);
#endif`;

/**
 * Body of `cloudLight` with the cloud shadow texture (the slot `CLOUD_SHADOW_SLOT`): one lookup where the texture
 * reaches, the share computed at the point where the light's line through the point meets the base surface beyond
 * it, and a blend between the two near the texture's edge. The texture is drawn the same way (`cloudShadowFillFs`), so
 * both agree; the drift of the pattern since the texture was drawn moves the lookup.
 */
function cloudLightTexture(field: boolean): string {
  return /* glsl */ `#ifdef WH_LOCAL_UP
  whUpHere = localUp(worldPos);
${field ? '  if (u_cloudFieldLight.w <= 0.0) return 1.0;\n  float g = 1.0 / max(u_cloudFieldLight.y, 1e-3);' : '  if (u_cloud.z <= 0.0) return 1.0;\n  float g = 1.0;'}
#else
  if (u_cloud.z <= 0.0) return 1.0;
  float g = 1.0;
#endif
  float k = 0.0;
  float tex = 1.0;
  if (u_cloudShadowV.w > 0.0) {
    vec3 dw = worldPos - u_cloudShadowO.xyz;
    vec3 dd = vec3(u_cloud.x - u_cloudShadowDU.w, 0.0, u_cloud.y - u_cloudShadowDV.w);
    vec2 uv = (vec2(dot(dw, u_cloudShadowU.xyz), dot(dw, u_cloudShadowV.xyz)) - vec2(dot(dd, u_cloudShadowDU.xyz), dot(dd, u_cloudShadowDV.xyz))) * u_cloudShadowU.w;
    k = 1.0 - smoothstep(0.4, 0.48, max(abs(uv.x), abs(uv.y)));
    if (k > 0.0) tex = textureLod(u_cloudShadow, uv + 0.5, 0.0).r;
    if (k >= 1.0) return tex * g;
  }
  // Beyond the texture: the share where the light's line through the point meets the base surface.
  vec3 L = u_sunDir.xyz;
#ifdef WH_LOCAL_UP
  vec3 rel = worldPos - u_upCenter.xyz;
  float h = length(rel) - u_upCenter.w;
  float a = cloudShareAt(normalize(rel - L * (h / max(dot(whUpHere, L), 0.05))), u_upCenter.w);
#else
  float a = cloudShareAt((worldPos - L * ((worldPos.y - u_cloudShadowO.w) / max(L.y, 0.05))).xz);
#endif
  return mix(a, tex, k) * g;`;
}

/** `cloudShareRange`: the share under a clear sky (x) and under a cloud that lets no sun through (y) at a place. */
function cloudShareRange(field: boolean): string {
  const radial = field
    ? `  vec4 t = cloudCoverTerms(cloudFieldCover(up, radiusM), u_cloudFieldLight.x);
  return vec2(t.w, (1.0 - max(t.z, 0.0)) * t.w);`
    : '  return vec2(1.0, 1.0 - max(u_cloud.z, 0.0));';
  return /* glsl */ `#ifdef WH_LOCAL_UP
vec2 cloudShareRange(vec3 up, float radiusM) {
${radial}
}
#else
vec2 cloudShareRange(vec2 xz) {
  return vec2(1.0, 1.0 - max(u_cloud.z, 0.0));
}
#endif`;
}

/**
 * Fragment shader that draws the cloud shadow texture (see `CLOUD_SHADOW_SLOT`), for the renderer's `resolve`
 * (`'other'`). A texel is a line along the light through the plane of the texture; its value is `cloudShareAt` where
 * that line meets the base surface on the light's side (radial up: the base sphere; flat: the plane at
 * `u_cloudShadowO.w`). R: the share; G, B, A: 0, 0, 1. `cloudField` as for `lightingGlsl`.
 *
 * `depth`: GLSL that defines `vec2 cloudShadowDepth(vec3 point, vec3 L)`, the optical depth of the clouds along the
 * light from `point` (render space, on the base surface) toward the light (x) and how much it replaces the pattern
 * there, 0–1 (y). The share is then that of the pattern blended toward the share the depth lets through, between
 * the share under a clear sky and under a cloud that lets no sun through (volumetric clouds, `CloudShadowSource`).
 */
export function cloudShadowFillFs(o: { cloudField?: boolean; depth?: string } = {}): string {
  const field = o.cloudField === true;
  return /* glsl */ `#include <header>
#include <noise>
${field ? CLOUD_FIELD_FUNCTIONS : ''}${cloudShareFunctions(field)}
${o.depth ? `${o.depth}
#define WH_CLOUD_SHADOW_DEPTH 1
${cloudShareRange(field)}` : ''}
// The share at a point of the base surface: the pattern's, or blended toward what the clouds' depth lets through.
#ifdef WH_LOCAL_UP
float cloudShadowShare(vec3 point, vec3 up, float radiusM, vec3 L) {
  float share = cloudShareAt(up, radiusM);
#ifdef WH_CLOUD_SHADOW_DEPTH
  vec2 dw = cloudShadowDepth(point, L);
  if (dw.y > 0.0) {
    vec2 r = cloudShareRange(up, radiusM);
    share = mix(share, mix(r.x, r.y, 1.0 - exp(-dw.x)), dw.y);
  }
#endif
  return share;
}
#else
float cloudShadowShare(vec3 point, vec3 L) {
  float share = cloudShareAt(point.xz);
#ifdef WH_CLOUD_SHADOW_DEPTH
  vec2 dw = cloudShadowDepth(point, L);
  if (dw.y > 0.0) {
    vec2 r = cloudShareRange(point.xz);
    share = mix(share, mix(r.x, r.y, 1.0 - exp(-dw.x)), dw.y);
  }
#endif
  return share;
}
#endif
uniform float u_cloudShadowTexels;
out vec4 o_color;
void main() {
  vec2 uv = gl_FragCoord.xy / u_cloudShadowTexels - 0.5;
  vec3 e1 = u_cloudShadowU.xyz;
  vec3 e2 = u_cloudShadowV.xyz;
  vec3 L = cross(e1, e2);
  vec3 d = (e1 * uv.x + e2 * uv.y) / u_cloudShadowU.w;
  float share = 1.0;
#ifdef WH_LOCAL_UP
  // The line origin + d + L t meets the sphere where |rel + d + L t| = R; d is across L. The root on the light's
  // side, in the form that keeps its digits when t is small against the radius.
  vec3 rel = u_cloudShadowO.xyz - u_upCenter.xyz;
  float R = u_upCenter.w;
  float r0 = length(rel);
  float c = (r0 - R) * (r0 + R) + 2.0 * dot(rel, d) + dot(d, d);
  float b = dot(rel, L);
  float disc = b * b - c;
  if (disc > 0.0) {
    float sq = sqrt(disc);
    float t = b > 0.0 ? -c / (b + sq) : sq - b;
    vec3 at = rel + d + L * t;
    share = cloudShadowShare(u_upCenter.xyz + at, normalize(at), R, L);
  }
#else
  vec3 p = u_cloudShadowO.xyz + d;
  if (L.y > 0.01) share = cloudShadowShare(p - L * ((p.y - u_cloudShadowO.w) / L.y), L);
#endif
  o_color = vec4(share, 0.0, 0.0, 1.0);
}`;
}

/**
 * Fragment shader that draws the cloud weather map (`'other'`). Radial up: one face of a cube map indexed by unit up
 * in render space (the frame `cloudLight` uses), `u_weatherFace` 0–5 in the order of `Device.fillLayer`; texel centres
 * on the face, so neighbouring faces meet without a seam and no place is a pole. Flat: a square tile, `u_weatherTile`
 * = (centre x, centre z in render space, edge in metres, 0). R: cloud cover (by place with `cloudField`, otherwise the
 * frame's cover); G: the deck share of the clouds (0 heaped, 1 a flat deck) and B: the precipitation, both from the
 * cover by `u_weatherRules` (x, y the cover over which the clouds flatten into a deck, z, w the cover over which they
 * start to rain up to the heaviest) and `u_weatherConvection` (the share of the rain that falls from tall clouds), as
 * `cloudWeatherKind` on the CPU; A: 1. `u_weatherTexels`: texels per edge.
 */
export function cloudWeatherFillFs(o: { cloudField?: boolean } = {}): string {
  const field = o.cloudField === true;
  return /* glsl */ `#include <header>
#include <noise>
${field ? CLOUD_FIELD_FUNCTIONS : ''}
uniform float u_weatherTexels;
uniform int u_weatherFace;
uniform vec4 u_weatherTile;
uniform vec4 u_weatherRules;
uniform float u_weatherConvection;
out vec4 o_color;
void main() {
  vec2 st = gl_FragCoord.xy / u_weatherTexels * 2.0 - 1.0;
#ifdef WH_LOCAL_UP
  vec3 d;
  if (u_weatherFace == 0) d = vec3(1.0, -st.y, -st.x);
  else if (u_weatherFace == 1) d = vec3(-1.0, -st.y, st.x);
  else if (u_weatherFace == 2) d = vec3(st.x, 1.0, st.y);
  else if (u_weatherFace == 3) d = vec3(st.x, -1.0, -st.y);
  else if (u_weatherFace == 4) d = vec3(st.x, -st.y, 1.0);
  else d = vec3(-st.x, -st.y, -1.0);
  vec3 up = normalize(d);
  float cover = ${field ? 'cloudFieldCover(up, u_upCenter.w)' : 'u_snow.w'};
#else
  // A flat world has one cover; the place of the texel, u_weatherTile.xy + st * u_weatherTile.z / 2, is for covers by
  // place to come.
  float cover = u_snow.w;
#endif
  float rain = smoothstep(u_weatherRules.z, u_weatherRules.w, cover);
  float deck = smoothstep(u_weatherRules.x, u_weatherRules.y, cover) * (1.0 - clamp(u_weatherConvection, 0.0, 1.0) * rain);
  o_color = vec4(cover, deck, rain, 1.0);
}`;
}

/**
 * Readers of the cloud weather map (`CloudWeatherMap` in runtime), for any program: `cloudWeatherCube(map, up)` at
 * unit up in render space (radial up), `cloudWeatherTile(map, tile, xz)` at a render-space place of a flat world
 * (`tile` as `CloudWeatherMap.tile`). Both return (cover, deck share, precipitation, 1).
 */
export const CLOUD_WEATHER_GLSL = /* glsl */ `
vec4 cloudWeatherCube(samplerCube map, vec3 up) { return textureLod(map, up, 0.0); }
vec4 cloudWeatherTile(sampler2D map, vec4 tile, vec2 xz) { return textureLod(map, (xz - tile.xy) / tile.z + 0.5, 0.0); }
`;

/**
 * The shadow query include `<shadow>`: how much sun reaches a point (scene shadows from the shadow map times cloud
 * shadows) and nothing of the light model. `cloudLight`, `sunVisibility` and `sunVisibilityBaked` (soft edge, as
 * `<lighting>` always had them) and `sunVisibilitySharp` and `sunVisibilityBakedSharp` (one depth comparison at the
 * centre of the shadow map texel: a hard, unsoftened edge). `<lighting>` contains the same text; both are guarded by
 * `WH_SHADOW_QUERY`, so a material may include `<shadow>`, `<lighting>` or both in any order. `cloudField` and
 * `cloudShadow` as for `lightingGlsl`.
 */
export function shadowGlsl(o: { cloudField?: boolean; cloudShadow?: boolean } = {}): string {
  const field = o.cloudField === true;
  const shadow = o.cloudShadow === true;
  return /* glsl */ `
#ifndef WH_SHADOW_QUERY
#define WH_SHADOW_QUERY 1
uniform sampler2DShadow u_shadowMap;

#ifdef WH_LOCAL_UP
// Up at the point the lighting functions were last asked about. cloudLight, sunVisibility and sunVisibilityBaked set
// it from their position, so lightOn, called after one of them, lights for the same place; lightOnAt states the place.
vec3 whUpHere = vec3(0.0, 1.0, 0.0);
#endif
${field ? CLOUD_FIELD_FUNCTIONS : ''}${cloudShareFunctions(field)}${shadow ? 'uniform sampler2D u_cloudShadow;\n' : ''}
// Cloud shadow: 1 = full sun, less under a cloud. The pattern is anchored in the world and drifts with the wind.
// Three layers of smooth noise, the smallest is tens of metres, so there is nothing to fight with even from afar.
float cloudLight(vec3 worldPos) {
${shadow ? cloudLightTexture(field) : field ? CLOUD_LIGHT_FIELD : CLOUD_LIGHT_GLOBAL}
}

// Share of sun that reaches a point: 0 = full shadow, 1 = full sun. Computes scene shadows and cloud shadows.
// The point is shifted along the normal before the query so a surface does not shadow itself.
float sunVisibility(vec3 worldPos, vec3 n, float normalOffsetTexels) {
  float cloud = cloudLight(worldPos);
#ifdef WH_SHADOW_AREAS
  // The renderer keeps shadow areas (its shadow mode is not the single map): its header brings the lookup.
  return whShadow(u_shadowMap, worldPos, n, normalOffsetTexels, 1.0) * cloud;
#else
  vec3 p = worldPos + n * (u_view.y * normalOffsetTexels);
  vec3 sc = (u_lightViewProj * vec4(p, 1.0)).xyz * 0.5 + 0.5;
  float lim = u_sunDir.w;
  if (sc.x <= 0.0 || sc.x >= lim || sc.y <= 0.0 || sc.y >= lim || sc.z >= 1.0) return cloud;
  float r = u_view.z * u_view.w;
  float sum = 0.0;
  // 4 × 4 queries, each bilinearly compares four texels by itself. Gives a smooth penumbra without graininess.
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * r;
      sum += texture(u_shadowMap, vec3(sc.xy + o, sc.z));
    }
  }
  return sum * (1.0 / 16.0) * cloud;
#endif
}

// sunVisibility for a material that carries a shadow term of its own (baked: 0 = shadow, 1 = sun; from a vertex
// attribute or a texture of its piece of the scene). The term stands in where the shadow map does not reach: outside
// the single map, and beyond the reach of the shadow areas, into which it is blended.
float sunVisibilityBaked(vec3 worldPos, vec3 n, float normalOffsetTexels, float baked) {
  float cloud = cloudLight(worldPos);
#ifdef WH_SHADOW_AREAS
  return whShadow(u_shadowMap, worldPos, n, normalOffsetTexels, baked) * cloud;
#else
  vec3 p = worldPos + n * (u_view.y * normalOffsetTexels);
  vec3 sc = (u_lightViewProj * vec4(p, 1.0)).xyz * 0.5 + 0.5;
  float lim = u_sunDir.w;
  if (sc.x <= 0.0 || sc.x >= lim || sc.y <= 0.0 || sc.y >= lim || sc.z >= 1.0) return baked * cloud;
  float r = u_view.z * u_view.w;
  float sum = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * r;
      sum += texture(u_shadowMap, vec3(sc.xy + o, sc.z));
    }
  }
  return sum * (1.0 / 16.0) * cloud;
#endif
}

// sunVisibilityBaked with a hard edge: one depth comparison at the centre of the shadow map texel under the point
// (with linear filtering a lookup there weighs that texel alone), no softening.
float sunVisibilityBakedSharp(vec3 worldPos, vec3 n, float normalOffsetTexels, float baked) {
  float cloud = cloudLight(worldPos);
#ifdef WH_SHADOW_AREAS
  return whShadowSharp(u_shadowMap, worldPos, n, normalOffsetTexels, baked) * cloud;
#else
  vec3 p = worldPos + n * (u_view.y * normalOffsetTexels);
  vec3 sc = (u_lightViewProj * vec4(p, 1.0)).xyz * 0.5 + 0.5;
  float lim = u_sunDir.w;
  if (sc.x <= 0.0 || sc.x >= lim || sc.y <= 0.0 || sc.y >= lim || sc.z >= 1.0) return baked * cloud;
  vec2 uv = (floor(sc.xy / u_view.w) + 0.5) * u_view.w;
  return texture(u_shadowMap, vec3(uv, sc.z)) * cloud;
#endif
}

// sunVisibility with a hard edge (see sunVisibilityBakedSharp).
float sunVisibilitySharp(vec3 worldPos, vec3 n, float normalOffsetTexels) {
  return sunVisibilityBakedSharp(worldPos, n, normalOffsetTexels, 1.0);
}
#endif
`;
}

/** `<shadow>` without the cloud cover by place (see `shadowGlsl`). */
export const SHADOW_QUERY = shadowGlsl();

/**
 * The lighting include. Without options it is `LIGHTING`. With `cloudField` (the block holds the slot
 * `CLOUD_FIELD_SLOT`) radial up gains `cloudFieldCover` and `cloudFieldAt`, and `cloudLight` reads the cover by place.
 * With `cloudShadow` (the block holds the slot `CLOUD_SHADOW_SLOT`) `cloudLight` reads the cloud shadow texture
 * (`u_cloudShadow`) where it reaches. Both also bring `cloudShareAt`, the share at a point of the base surface. It
 * begins with the shadow query (`shadowGlsl`, guarded so `<shadow>` may be included as well).
 */
export function lightingGlsl(o: { cloudField?: boolean; cloudShadow?: boolean } = {}): string {
  return /* glsl */ `${shadowGlsl(o)}
// Light as a multiple of the surface colour: warm sun, cool shadow.
vec3 lightOn(vec3 n, float sun, float ao) {
  float ndl = max(dot(n, u_sunDir.xyz), 0.0);
#ifdef WH_LOCAL_UP
  // The sky is over the local horizon. Where the light stands under it the body itself is in the way: no sun, and
  // only a rest of the sky's light.
  float nu = dot(n, whUpHere);
  float day = dot(whUpHere, u_sunDir.xyz);
  vec3 fill = (u_ambient.rgb + u_skyFill.rgb * (nu * 0.5 + 0.5) + u_bounce.rgb * (1.0 - nu)) * mix(0.06, 1.0, smoothstep(-0.25, 0.15, day));
  sun *= smoothstep(-0.05, 0.03, day);
#else
  vec3 fill = u_ambient.rgb + u_skyFill.rgb * (n.y * 0.5 + 0.5) + u_bounce.rgb * (1.0 - n.y);
#endif
  return u_sunColor.rgb * (ndl * sun) + fill * ao;
}

// lightOn for a stated place: the same without radial up, and with it independent of which function ran before.
vec3 lightOnAt(vec3 worldPos, vec3 n, float sun, float ao) {
#ifdef WH_LOCAL_UP
  whUpHere = localUp(worldPos);
#endif
  return lightOn(n, sun, ao);
}

// Fog and haze applied after the output curve. More at the valley floor, slow wisps drift with the clouds.
// Under an overcast sky the colours also fade a little.
vec3 applyFog(vec3 display, vec3 worldPos) {
  float cc = u_snow.w;
  display = mix(display, vec3(dot(display, vec3(0.3, 0.55, 0.15))), 0.28 * cc * cc);
  float f = u_weather.z;
  if (f <= 0.0) return display;
#ifdef WH_LOCAL_UP
  // Heights of the fog layer are heights above the base surface; the wisps are a field in space.
  float valley = 1.0 - clamp((localHeight(worldPos) - u_fogShape.x) * u_fogShape.y, 0.0, 1.0);
  float drift = vnoise3((localUp(worldPos) * u_upCenter.w - vec3(u_cloud.x, 0.0, u_cloud.y) * 0.4) / 140.0, 81u);
#else
  float valley = 1.0 - clamp((worldPos.y - u_fogShape.x) * u_fogShape.y, 0.0, 1.0);
  float drift = vnoise((worldPos.xz - u_cloud.xy * 0.4) / 140.0, 81u);
#endif
  float a = f * (0.5 + 0.38 * valley + 0.24 * (drift - 0.5));
  return mix(display, u_fogColor.rgb, clamp(a, 0.0, 0.94));
}

// Output curve: unchanged up to the knee, above it brightness bends softly toward one so light surfaces do not blow out.
vec3 toDisplay(vec3 c) {
  c *= u_warmTint.a;
  const float knee = 0.8;
  vec3 over = max(c - knee, 0.0) / (1.0 - knee);
  return mix(c, knee + (1.0 - knee) * (1.0 - exp(-over)), step(knee, c));
}
`;
}

export const LIGHTING = lightingGlsl();
