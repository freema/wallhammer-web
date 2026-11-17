// GLSL lighting functions over the environment's Frame members (see `ENV_CORE_SLOT`). They also read the renderer's
// members (light matrix, shadow map, view) by name. Registered as the shader include `lighting`.
// With a shadow mode that keeps shadow areas the renderer's header defines `WH_SHADOW_AREAS` and brings `whShadow`.
// With radial up (`WH_LOCAL_UP`, see the renderer's `radialUp`) the sky is over the local horizon: fill light, cloud
// shadows and fog follow `localUp` and `localHeight`, and the side turned away from the light gets neither sun nor sky.

import { CLOUD_TERMS_GLSL } from './environment.ts';

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

/** Body of `cloudLight` as it has always been: one cloud cover for the whole world. */
const CLOUD_LIGHT_GLOBAL = /* glsl */ `#ifdef WH_LOCAL_UP
  whUpHere = localUp(worldPos);
  if (u_cloud.z <= 0.0) return 1.0;
  vec3 q = (whUpHere * u_upCenter.w - vec3(u_cloud.x, 0.0, u_cloud.y)) * u_cloud.w;
  float n = ${CLOUD_NOISE_RADIAL};
#else
  if (u_cloud.z <= 0.0) return 1.0;
  vec2 q = (worldPos.xz - u_cloud.xy) * u_cloud.w;
  float n = ${CLOUD_NOISE};
#endif
  return 1.0 - u_cloud.z * smoothstep(u_cloudEdge.x, u_cloudEdge.y, n);`;

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

/** Body of `cloudLight` with the cover by place: radial up reads the field, the planar code is today's. */
const CLOUD_LIGHT_FIELD = /* glsl */ `#ifdef WH_LOCAL_UP
  whUpHere = localUp(worldPos);
  return cloudFieldAt(whUpHere, u_upCenter.w).x;
#else
  if (u_cloud.z <= 0.0) return 1.0;
  vec2 q = (worldPos.xz - u_cloud.xy) * u_cloud.w;
  float n = ${CLOUD_NOISE};
  return 1.0 - u_cloud.z * smoothstep(u_cloudEdge.x, u_cloudEdge.y, n);
#endif`;

/**
 * The lighting include. Without options it is `LIGHTING`. With `cloudField` (the block holds the slot
 * `CLOUD_FIELD_SLOT`) radial up gains `cloudFieldCover` and `cloudFieldAt`, and `cloudLight` reads the cover by place.
 */
export function lightingGlsl(o: { cloudField?: boolean } = {}): string {
  const field = o.cloudField === true;
  return /* glsl */ `
uniform sampler2DShadow u_shadowMap;

#ifdef WH_LOCAL_UP
// Up at the point the lighting functions were last asked about. cloudLight, sunVisibility and sunVisibilityBaked set
// it from their position, so lightOn, called after one of them, lights for the same place; lightOnAt states the place.
vec3 whUpHere = vec3(0.0, 1.0, 0.0);
#endif
${field ? CLOUD_FIELD_FUNCTIONS : ''}
// Cloud shadow: 1 = full sun, less under a cloud. The pattern is anchored in the world and drifts with the wind.
// Three layers of smooth noise, the smallest is tens of metres, so there is nothing to fight with even from afar.
float cloudLight(vec3 worldPos) {
${field ? CLOUD_LIGHT_FIELD : CLOUD_LIGHT_GLOBAL}
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
