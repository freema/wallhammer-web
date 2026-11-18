// Shadow map pass: depth only, seen from the directional light.

import { shaderHeader } from './glsl.ts';

export const DEPTH_VS = /* glsl */ `${shaderHeader()}
uniform mat4 u_lightRender;
in vec3 a_pos;
void main() {
  gl_Position = u_lightRender * vec4(a_pos, 1.0);
}`;

export const DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
void main() {}`;

// --- Shadow areas -----------------------------------------------------------------------------------------------------
// The shadow modes other than the default one (`RendererOptions.shadows`) keep one or several square areas of the
// light's plane in the shadow map, each fixed to the world's texel grid and redrawn only when it moves. What follows is
// their part of the program header: `#define WH_SHADOW_AREAS n`, the members at the end of the Frame block and the
// lookup functions. `sunVisibility` of `<lighting>` calls `whShadow` when the define is there.

/** The most areas one shadow map holds (a 2 × 2 grid of parts). */
export const SHADOW_AREAS_MAX = 4;

/** Texture unit of the light horizon texture (`Renderer.shadowHorizon`), far above the units layers bind. */
export const SHADOW_HORIZON_UNIT = 15;

/** Floats the shadow areas add to the end of the Frame block. */
export function shadowAreaFloats(areas: number): number {
  return areas * 24 + 20;
}

/** Members the shadow areas add to the end of the Frame block, in upload order. */
export function shadowAreaMembers(areas: number): string {
  return /* glsl */ `  mat4 u_shadowArea[${areas}];   // render space to an area: xy 0–1 across the area, z depth 0–1 from the light
  vec4 u_shadowPart[${areas}];   // xy where the area starts in the map (uv), z its share of the map edge, w filter radius (uv)
  vec4 u_shadowReach[${areas}];  // x reach from the focus (m), y 1 / width of the blend band (1/m), z metres per texel
  vec4 u_shadowFocus;       // xy the focus in the light's plane (along u_shadowRight and u_shadowUp)
  vec4 u_shadowRight;       // xyz the light plane's first axis
  vec4 u_shadowUp;          // xyz the light plane's second axis
  vec4 u_shadowHorizon;     // light horizon texture: uv = xz * zw + xy
  vec4 u_shadowHorizonY;    // x height of code 0, y height span of the codes, z 1 / blend height, w 1 when a texture is set
`;
}

/** Lookup functions of the shadow areas; follows the header (the Frame block) in every program of such a mode. */
export const SHADOW_AREAS_GLSL = /* glsl */ `
uniform highp sampler2D u_shadowHorizonMap;

// Share of the light that reaches a point according to area i of the map: 0 shadow, 1 lit.
float whShadowArea(sampler2DShadow map, int i, vec3 worldPos, vec3 n, float normalOffsetTexels) {
  vec4 part = u_shadowPart[i];
  vec3 p = worldPos + n * (u_shadowReach[i].z * normalOffsetTexels);
  vec3 s = (u_shadowArea[i] * vec4(p, 1.0)).xyz;
  if (s.z >= 1.0) return 1.0;
#if WH_SHADOW_AREAS == 1
  // A single area fills the map and wraps around in it; the map repeats, so the filter may cross the seam.
  vec2 uv = s.xy + part.xy;
#else
  // Keep the filter inside this area's part of the map.
  float edge = (1.5 * part.w + u_view.w) / part.z;
  vec2 uv = part.xy + clamp(s.xy, vec2(edge), vec2(1.0 - edge)) * part.z;
#endif
  float sum = 0.0;
  // 4 × 4 queries, each bilinearly compares four texels by itself.
  for (int j = 0; j < 4; j++) {
    for (int k = 0; k < 4; k++) {
      vec2 o = (vec2(float(k), float(j)) - 1.5) * part.w;
      sum += texture(map, vec3(uv + o, s.z));
    }
  }
  return sum * (1.0 / 16.0);
}

// Beyond the reach of the map: what the material knows itself (baked, 1 = lit) times the scene's light horizon, a
// coarse texture of the height below which a point is hidden from the light. Without that texture just baked.
float whShadowFar(vec3 worldPos, float baked) {
  vec4 y = u_shadowHorizonY;
  if (y.w <= 0.0) return baked;
  vec2 uv = worldPos.xz * u_shadowHorizon.zw + u_shadowHorizon.xy;
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return baked;
  vec2 e = textureLod(u_shadowHorizonMap, uv, 0.0).rg;
  // Code 0: nothing stands between this place and the light, whatever the height of the point (it may lie a little
  // below the lowest height the texture can state).
  if (e.r + e.g <= 0.0) return baked;
  float top =y.x + (e.r * 65280.0 + e.g * 255.0) * (1.0 / 65535.0) * y.y;
  // Lit from the horizon up, fully hidden one blend height below it.
  float t = clamp((worldPos.y - top) * y.z + 1.0, 0.0, 1.0);
  return baked * t * t * (3.0 - 2.0 * t);
}

// whShadowArea with a hard edge: one depth comparison at the centre of the map texel under the point, no softening.
float whShadowAreaSharp(sampler2DShadow map, int i, vec3 worldPos, vec3 n, float normalOffsetTexels) {
  vec4 part = u_shadowPart[i];
  vec3 p = worldPos + n * (u_shadowReach[i].z * normalOffsetTexels);
  vec3 s = (u_shadowArea[i] * vec4(p, 1.0)).xyz;
  if (s.z >= 1.0) return 1.0;
#if WH_SHADOW_AREAS == 1
  vec2 uv = s.xy + part.xy;
#else
  float edge = u_view.w / part.z;
  vec2 uv = part.xy + clamp(s.xy, vec2(edge), vec2(1.0 - edge)) * part.z;
#endif
  uv = (floor(uv / u_view.w) + 0.5) * u_view.w;
  return texture(map, vec3(uv, s.z));
}

// Share of the light that reaches a point, 0–1. The finest area whose reach around the focus holds the point answers;
// in the outer band of its reach it blends into the next area, the last one into the far term. The reach is measured
// from the focus of the frame, not from where the area happens to lie, so nothing jumps when an area moves.
float whShadow(sampler2DShadow map, vec3 worldPos, vec3 n, float normalOffsetTexels, float baked) {
  vec2 lp = vec2(dot(u_shadowRight.xyz, worldPos), dot(u_shadowUp.xyz, worldPos)) - u_shadowFocus.xy;
  float d = max(abs(lp.x), abs(lp.y));
  for (int i = 0; i < WH_SHADOW_AREAS; i++) {
    vec4 reach = u_shadowReach[i];
    if (d >= reach.x) continue;
    float lit = whShadowArea(map, i, worldPos, n, normalOffsetTexels);
    // 0 well inside the reach, 1 at its end.
    float t = clamp(1.0 - (reach.x - d) * reach.y, 0.0, 1.0);
    if (t <= 0.0) return lit;
    t = t * t * (3.0 - 2.0 * t);
    float next;
#if WH_SHADOW_AREAS > 1
    // The index stays inside the arrays also in the branch that is never taken (a compiler may unroll the loop).
    if (i + 1 < WH_SHADOW_AREAS) next = whShadowArea(map, min(i + 1, WH_SHADOW_AREAS - 1), worldPos, n, normalOffsetTexels);
    else
#endif
    next = whShadowFar(worldPos, baked);
    return mix(lit, next, t);
  }
  return whShadowFar(worldPos, baked);
}

// whShadow with a hard edge: the same choice and blending of areas, each area asked by whShadowAreaSharp.
float whShadowSharp(sampler2DShadow map, vec3 worldPos, vec3 n, float normalOffsetTexels, float baked) {
  vec2 lp = vec2(dot(u_shadowRight.xyz, worldPos), dot(u_shadowUp.xyz, worldPos)) - u_shadowFocus.xy;
  float d = max(abs(lp.x), abs(lp.y));
  for (int i = 0; i < WH_SHADOW_AREAS; i++) {
    vec4 reach = u_shadowReach[i];
    if (d >= reach.x) continue;
    float lit = whShadowAreaSharp(map, i, worldPos, n, normalOffsetTexels);
    float t = clamp(1.0 - (reach.x - d) * reach.y, 0.0, 1.0);
    if (t <= 0.0) return lit;
    t = t * t * (3.0 - 2.0 * t);
    float next;
#if WH_SHADOW_AREAS > 1
    if (i + 1 < WH_SHADOW_AREAS) next = whShadowAreaSharp(map, min(i + 1, WH_SHADOW_AREAS - 1), worldPos, n, normalOffsetTexels);
    else
#endif
    next = whShadowFar(worldPos, baked);
    return mix(lit, next, t);
  }
  return whShadowFar(worldPos, baked);
}
`;
