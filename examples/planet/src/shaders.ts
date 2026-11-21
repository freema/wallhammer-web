// Materials of the planet example. Cell data are relative to the cell origin with the world's axes; every program adds
// `u_cellOffset` (cell origin − render origin, computed in double on the CPU). Nothing here assumes that up is +y:
// up, the height and the frame of an upright object come from the header's `localUp`, `localHeight` and `localFrame`
// (the renderer is made with `radialUp`), and the blend between levels from `SPHERE_PATCH_GLSL`.
//
// The surface mixes in the cover baked into its vertices where the objects are no longer drawn. Shrubs and rocks leave
// one by one over the blend band of the coarsest level that has them (`coverFade`, `coverKeep` of core); the trees
// also stand, thinned, in the three levels above it and leave in the order of their rank (`THIN_GLSL`), while the
// cover takes over exactly the share that has left, as a canopy: lifted, darker from the side, with a ragged edge
// (`CANOPY_VS`, `CANOPY_FS`). Nothing appears or vanishes at once on the way up or down.
//
// With the engine's atmosphere the include `<atmosphere>` defines WH_ATMOSPHERE: the light on a surface then comes
// from `atmosphereLight`, and the air in front of it is taken at the vertices (`atmosphereAir`) and applied to the
// fragments (`atmosphereApply`). Without it (`atm=0`) the include holds only stand-ins of those two that change
// nothing, and the light comes from `<lighting>`.
//
// The page always has the engine's cloud cover by place (`cloudFieldSlot`, weather.ts): `sunVisibility` then gives the
// sun share under the clouds of the place over the frame's dimming by the cover under the eye, so with the atmosphere,
// whose light is not dimmed, it is multiplied by that dimming (`u_cloudFieldLight.y`).
//
// The sea (`SEA_FS`, `WATER_MATERIAL`, `NEAR_WATER_MATERIAL`): the ground under the base sphere is the sea floor, lit
// by the light that is left at its depth and, in the top metres, by soft moving caustics. Everything seen through
// water, from above or from below, is dimmed and tinted by the length of its view ray in the water (`MEDIUM_GLSL` of
// core); from high above the open water keeps the old colours (shelf and deep sea). The surface moves: a sum of
// trochoidal waves raised by the page's wind (`WAVES_GLSL` of gen-core, sea.ts), with the eye's foot as the origin of
// their plane. It is drawn translucent after the opaque cells, flat by the water of the cells and moved by the near
// surface round the eye (see "The water" below). With the eye under the water the air and the fog are not applied,
// light shafts are added along every view ray, and the backdrop (sea.ts) stands where the water hides everything.

import type { MaterialDesc } from 'wallhammer-web/base';
import { COVER_FADE_GLSL, MEDIUM_GLSL } from 'wallhammer-web/core';
import { liquidClearDistance, liquidGlsl, liquidRipplesGlsl } from 'wallhammer-web/env';
import { DEPTH_ONLY_FS, sphereCoverThinGlsl, sphereGroundDepthVs, sphereGroundVs } from 'wallhammer-web/env';
import type { LiquidLook } from 'wallhammer-web/env';
import { SPHERE_PATCH_ATTRIBS, SPHERE_PATCH_COVER_ATTRIBS, SPHERE_PATCH_GLSL, WAVES_GLSL } from 'wallhammer-web/gen-core';
import { STRIP_ATTRIBS, STRIP_GLSL } from 'wallhammer-web/gen-mesh';
import { PLANT_TOP_M, THIN_RANK } from './world.ts';

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

// --- The sea ------------------------------------------------------------------------------------------------------------

/** Extinction of the water per metre (red, green, blue): clear coastal water, red lost first, green and blue last; about 85 m of sight. */
export const SEA_EXTINCTION = [0.32, 0.055, 0.06] as const;
/** Colour of the open water seen across it from inside, as a multiple of the light at the surface. */
export const SEA_BODY = [0.03, 0.24, 0.34] as const;
/** Share of the light from above lost per metre of depth (red, green, blue): it goes deeper than one sees across. */
export const SEA_LIGHT_LOSS = [0.3, 0.05, 0.03] as const;
/** The old colours of the sea from high above: over the shelf and over the deep sea (by the floor's depth to 600 m). */
const SEA_SHELF = [36 / 255, 104 / 255, 124 / 255] as const;
const SEA_DEEP = [8 / 255, 30 / 255, 70 / 255] as const;
/** The look of the sea for the engine's liquid (`liquidGlsl` of env, `LiquidSurface` in sea.ts). */
export const SEA_LOOK: LiquidLook = { extinction: SEA_EXTINCTION, body: SEA_BODY, lightLoss: SEA_LIGHT_LOSS, farShallow: SEA_SHELF, farDeep: SEA_DEEP };
/** Distance in metres at which the water hides everything behind it to within 1 %. */
export const SEA_CLEAR_M = liquidClearDistance(SEA_LOOK);

/**
 * GLSL the materials and the layers of the sea share (`liquidGlsl` of env): the sea's colours, its light at a depth,
 * the light of the surface above a point, the plane of the waves, the caustics. Needs `<noise>`, `<lighting>`,
 * `<atmosphere>` and `MEDIUM_GLSL` before it; its uniforms come from `seaUniforms` (sea.ts).
 */
export const SEA_COMMON_GLSL = liquidGlsl(SEA_LOOK);

/** Fragment side of the sea for the materials: needs `SEA_COMMON_GLSL` and `COMMON_FS` before it. */
const SEA_FS = /* glsl */ `
uniform vec4 u_morphEye; // xyz: the eye in render space (set by the streamed world)
// The light on the floor at a depth: what is left of the sun and the sky there, and the caustics, strong in the top
// metre or two and fading below.
vec3 seaFloorLight(vec3 lit, vec3 col, vec3 p, vec3 n, float depth, float sun) {
  vec3 left = liquidLightAt(depth);
  vec3 up = localUp(p);
  // The light is the one at the top of the water above (the air's light is not defined under the sea's level).
  vec3 top = p + up * depth;
#ifdef WH_ATMOSPHERE
  lit = col * atmosphereLight(top, n, sun, 1.0);
#endif
  float fade = detailVisibleAt(1.6, p);
  float amount = (1.4 * exp(-depth / 2.0) + 0.7 * exp(-depth / 10.0)) * fade * sun * max(dot(n, liquidSunDir()), 0.0);
  float c = amount > 0.002 ? liquidCaustic(liquidPlane(liquidSunTop(p, up, depth)), depth) : 0.0;
  return (lit + col * liquidSun(top) * (amount * c)) * left;
}
// A point's light (before toDisplay) as the eye sees it: through the water on the way (from above or from below),
// with the light shafts under the water, then, with the eye above the water, the fog and the air.
vec3 seaView(vec3 lit, vec3 world, vec3 air, vec3 through) {
  float h = localHeight(world);
  vec3 ray = world - u_morphEye.xyz;
  float len = length(ray);
  // The water's path against the flat level, with the eye on the side of the moving surface it is on.
  float path = mediumPath(u_liquid.x < 0.0 ? min(u_liquid.y, -1e-3) : max(u_liquid.y, 1e-3), h, len);
  if (path > 0.0) lit = mediumApply(lit, liquidInscatter(max(-h, 0.0), liquidSurfaceLight(world), dot(ray, localUp(world)) / max(len, 1e-3)), LIQUID_EXTINCTION, path);
  if (u_liquid.x < 0.0) return liquidDisplay(lit);
  return atmosphereApply(applyFog(toDisplay(lit), world), world, air, through);
}
`;

// --- Woods from afar -------------------------------------------------------------------------------------------------
// The trees of a cell `d` levels coarser than the object level are the ones ranked from THIN_RANK[d] up (world.ts);
// across the far part of a level's range, from THIN_FROM of the distance where its cells blend into their parent to
// that distance, the ones ranked under the next threshold shrink away in their order, so a level hands its parent
// exactly the trees the parent holds. The canopy (the far look of the cover) takes over the share of the trees that
// have left: none where every tree stands, all of it past the coarsest level with trees.
//
// The canopy stands in for the bulk of the trees as well as their colour. The vertices of a wood rise by the height of
// the canopy times that share, in the colour and the shadow pass, so a distant wood keeps the outline its trees had on
// a ridge and casts its shadow; water and the bare ground stay flat. The share of the cover is the gap fraction of the
// layer of crowns along the line of sight: the baked one from about 45 degrees above the ground, more of the ground
// hidden under a lower view, and the crowns are darker from the side. The edge of a wood is drawn per pixel with value
// noise, and the tree line follows the height of the ground. Nothing of it is in the cells' bytes.

/** Height of the canopy, m: about the mean crown height of the woods (world.ts: conifers 9–22 m, broadleaves 10–20 m). */
export const CANOPY_M = 13;
/** Where the band of each level starts, as a share of the distance where its cells blend into their parent. */
const THIN_FROM = [0.75, 0.6, 0.55, 0.5] as const;
/** Brightness of the canopy against its baked mean seen from the side and from above. */
const THIN_SHADE = [0.57, 0.85] as const;
/** The path through the layer of crowns: offset and factor of the cotangent of the view's angle. */
const CANOPY_PATH = [0.45, 0.53] as const;

/** Thinning of the trees by rank. Needs `SPHERE_PATCH_GLSL`, `COVER_FADE_GLSL`, `u_cellLevel` and `u_coverLevel` before it. */
const THIN_GLSL = sphereCoverThinGlsl(THIN_RANK, THIN_FROM);

/** Vertex side of the canopy. Needs `localUp`, `localHeight` (the header) and `SPHERE_PATCH_GLSL` before it. */
const CANOPY_VS = /* glsl */ `
const float CANOPY_M = ${CANOPY_M.toFixed(1)};
const float CANOPY_TOP = ${PLANT_TOP_M.toFixed(1)};
// How much of a wood the cover is: 1 from the baked share 0.26 up, 0 under 0.04 (meadow, tundra).
float coverLiftShare(float coverA) {
  return clamp((coverA - 0.04) / 0.22, 0.0, 1.0);
}
// Metres the canopy of a whole wood lifts the surface: its height times the share of the far look, none on the sea
// (the colour's alpha), and down to none toward the height above which nothing grows (ground: height of the ground),
// so the vertices along the tree line do not stand up as teeth; the fragment side draws that line by the height.
float coverLift(float sea, float share, float ground) {
  return CANOPY_M * share * (1.0 - step(0.5, sea)) * (1.0 - smoothstep(CANOPY_TOP - 150.0, CANOPY_TOP - 30.0, ground));
}
// Sine of the angle at which the eye sees a point above the layer of crowns: halfway between the ground's normal and up.
float coverElevation(vec3 p, vec3 n) {
  vec3 e = u_morphEye.xyz - p;
  return dot(normalize(n + localUp(p)), e) / max(length(e), 1e-3);
}
// Brightness of the cover seen at that angle: from above the lit tops of the crowns, from the side their shaded flanks.
vec3 coverShade(float sinE) {
  return mix(${THIN_SHADE[0].toFixed(3)}, ${THIN_SHADE[1].toFixed(3)}, smoothstep(0.15, 0.85, sinE)) * vec3(0.98, 0.98, 1.07);
}
// A point of a mesh drawn on the surface (a strip) moved along the line of sight toward the eye, so it stays in front
// of the canopy over it where the eye looks down on it; the picture of it does not move.
vec3 canopyPull(vec3 p, float share) {
  vec3 e = u_morphEye.xyz - p;
  float len = max(length(e), 1e-3);
  float s = dot(localUp(p), e) / len;
  float d = CANOPY_M * share * min(1.0 / max(s, 1e-3), 3.0);
  return p + e * (min(d, 0.5 * len) / len);
}
`;

/**
 * Fragment side of the canopy: the share it hides at a pixel, its ragged edge, the normal bent by the lift and by the
 * crowns, and the colour of the crowns. Needs `<noise>` before it.
 */
const CANOPY_FS = /* glsl */ `
const float CANOPY_TOP = ${PLANT_TOP_M.toFixed(1)};
in vec4 v_lift; // x: metres the canopy of a whole wood lifts the surface, y: sine of the view's angle above the
                  // ground, z: share of the far look (the trees that have left), w: height of the ground (m)
// The share the crowns of the trees that have left hide seen at that angle: the gap fraction of their layer to the
// power of the path through it, the sides of the crowns counted (the baked share holds from about 40 degrees up).
float canopyShare(float coverA, float sinE) {
  float s = max(sinE, 0.01);
  float k = clamp(${CANOPY_PATH[0].toFixed(2)} + ${CANOPY_PATH[1].toFixed(2)} * sqrt(1.0 - s * s) / s, 1.0, 10.0);
  return 1.0 - pow(1.0 - min(coverA, 0.999), k * v_lift.z);
}
// The normal under the canopy: tilted by the slope of its lift across the wood's edge (extent) and of the crowns
// (grain g, 0–1, over the share of the canopy), no more than about 30 degrees.
vec3 canopyNormal(vec3 n, vec3 world, float g, float share, float extent) {
  float crowns = (g - 0.5) * 7.0 * share * detailVisibleAt(8.0, world);
  vec3 dx = dFdx(world);
  vec3 dy = dFdy(world);
  vec3 r1 = cross(dy, n);
  vec3 r2 = cross(n, dx);
  float det = dot(dx, r1);
  vec3 grad = sign(det) * ((v_lift.x * dFdx(extent) + dFdx(crowns)) * r1 + (v_lift.x * dFdy(extent) + dFdy(crowns)) * r2);
  float slope = length(grad) / max(abs(det), 1e-12);
  if (abs(det) < 1e-12 || slope < 1e-6) return n;
  return normalize(abs(det) * n - grad * min(1.0, 0.6 / slope));
}
// The share of the canopy at a pixel from the baked share a and the view, and the wood's extent there (0–1). Where a
// wood ends (the baked share between a meadow's and a wood's) its line wanders with three octaves of noise fixed to the
// planet (q: patternPos), so it does not follow the triangles of the cells. Close under the height above which
// nothing grows the line is that height's on the ground. The extent holds also where the trees stand.
float canopyAt(float a, vec3 q, vec3 world, out float extent) {
  float wood = clamp((a - 0.04) / 0.22, 0.0, 1.0); // coverLiftShare
  // How sharply the wood ends here: its change per metre, taken before any branch. A band of thin cover (as where
  // the tundra meets the taiga) changes slowly; a ragged line there would break it into dark islands of wood.
  float perM = max(abs(dFdx(wood)), abs(dFdy(wood))) / max(max(length(dFdx(world)), length(dFdy(world))), 1e-3);
  float sharp = smoothstep(0.3, 1.0, perM * 500.0);
  extent = 0.0;
  if (a <= 0.001) return 0.0;
  float edge = wood > 0.0 && wood < 1.0 ? 1.0 : 0.0;
  float near = smoothstep(CANOPY_TOP - 150.0, CANOPY_TOP - 80.0, v_lift.w);
  extent = wood;
  float below = 1.0;
  if (edge > 0.0 || near > 0.0) {
    // The finer octaves only where a pixel is smaller than their grain (none of them from far up).
    float r = (vnoise3(q / 320.0, 65u) - 0.5) * 0.6;
    float d80 = detailVisibleAt(80.0, world);
    if (d80 > 0.0) {
      r += (vnoise3(q / 80.0, 64u) - 0.5) * 0.45 * d80;
      float d24 = detailVisibleAt(24.0, world);
      if (d24 > 0.0) r += (vnoise3(q / 24.0, 63u) - 0.5) * 0.3 * d24;
    }
    float line = 1.0 - smoothstep(-6.0, 6.0, v_lift.w - CANOPY_TOP + 60.0 * r);
    below = mix(1.0, line, near);
    float rag = 2.2 * r * sqrt(4.0 * wood * (1.0 - wood)) * sharp;
    extent = edge > 0.0 ? mix(smoothstep(0.3, 0.7, wood + rag), line, near) : min(wood, below);
  }
  return mix(canopyShare(min(a, 0.04), v_lift.y) * below, canopyShare(max(a, 0.26), v_lift.y), extent);
}
// The colour of the cover: the crowns' mean, darker toward the gaps between them.
vec3 canopyColor(vec3 cover, float g, vec3 world) {
  return cover * (1.0 + 0.5 * (g - 0.5) * detailVisibleAt(8.0, world));
}
// The ground under a wood: in the shade of the crowns, litter and moss in patches.
vec3 forestFloor(vec3 ground, float g) {
  vec3 litter = mix(vec3(0.15, 0.22, 0.08), vec3(0.2, 0.17, 0.1), smoothstep(0.3, 0.7, g));
  return mix(ground, litter, 0.45) * 0.8;
}
`;

const TERRAIN_VS = sphereGroundVs({ thinRank: THIN_RANK, thinFrom: THIN_FROM, lift: CANOPY_VS });

const TERRAIN_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${SEA_FS}
uniform float u_cellLevel;
uniform float u_showLevels;
${CANOPY_FS}
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
  // Fine grain on land: two octaves of noise in space, faded out where a pixel covers more than the grain.
  vec3 q = patternPos(v_world);
  float g8 = vnoise3(q / 8.0, 31u);
  float g = g8 * 0.6 + vnoise3(q / 2.0, 32u) * 0.4 * detailVisibleAt(2.0, v_world);
  // The far look of the plants that stand on the land, and their bulk, over the floor of the wood.
  float extent;
  float canopy = canopyAt(v_cover.a, q, v_world, extent) * (1.0 - sea);
  vec3 ground = mix(v_color.rgb, forestFloor(v_color.rgb, g8), extent * (1.0 - sea));
  vec3 col = mix(ground, canopyColor(v_cover.rgb, g8, v_world), canopy);
  n = canopyNormal(n, v_world, g8, canopy, extent);
  col *= 0.88 + 0.24 * g * detailVisibleAt(8.0, v_world);
  col = mix(col, u_snow.rgb, (1.0 - sea) * u_weather.x * smoothstep(0.6, 0.9, dot(n, up)));
  if (u_showLevels > 0.5) col = mix(col, levelTint(u_cellLevel), 0.55);
  float sun = sunVisibility(v_world, n, 1.2);
#ifdef WH_ATMOSPHERE
  // The air's light carries no dimming by the frame's cloud cover: the share under the clouds of this place is the
  // sun visibility times that dimming (u_cloudFieldLight.y, 1 without clouds).
  sun *= u_cloudFieldLight.y;
  // The light of the place: the sun through the air above it and the sky there, so the far side of the sphere is dark.
  vec3 lit = col * atmosphereLight(v_world, n, sun, 1.0);
#else
  vec3 lit = col * u_warmTint.rgb * lightOnAt(v_world, n, sun, 1.0);
#endif
  // The sea floor: the light left at its depth, caustics near the top.
  float depth = -localHeight(v_world);
  if (depth > 0.0) lit = seaFloorLight(lit, col, v_world, n, depth, sun);
  o_color = vec4(seaView(lit, v_world, v_air, v_airThrough), 1.0);
}`;

const TERRAIN_DEPTH_VS = sphereGroundDepthVs({ thinRank: THIN_RANK, thinFrom: THIN_FROM, lift: CANOPY_VS });

const DEPTH_FS = DEPTH_ONLY_FS;

/**
 * Instance transform shared by the colour and the depth program: the object stands along the local up of its base and
 * shrinks to nothing where the surface takes its look over (its place in the order is its turn, a number fixed per
 * object; the turn of a tree is its rank). `thin`: the trees, which also stand in coarser cells (`thinKeep`).
 */
const objectTransform = (thin: boolean): string => /* glsl */ `
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${COVER_FADE_GLSL}
uniform float u_cellLevel;
uniform float u_coverLevel; // coarsest level whose cells hold every object
${thin ? THIN_GLSL : ''}
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_base;   // xyz base point (cell-local), w reach radius
in vec4 i_shape;  // x height, y turn about up, z width, w depth (0 = width)
in vec4 i_color;  // rgb colour, w variant
in float i_coarseShift; // metres along up to the base point on the coarser level
vec3 objectScale() {
  vec3 s = vec3(i_shape.z, i_shape.x, i_shape.w > 0.0 ? i_shape.w : i_shape.z);
${
  thin
    ? '  return s * thinKeep(i_base.xyz + u_cellOffset, fract(i_shape.y * 0.1591549));'
    : '  float fade = coverFade(u_coverLevel, u_cellLevel, spherePatchMorph(i_base.xyz + u_cellOffset));\n  return s * coverKeep(fade, fract(i_shape.y * 0.1591549));'
}
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

const objectVs = (thin: boolean): string => /* glsl */ `#include <header>
#include <atmosphere>
${objectTransform(thin)}
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
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${SEA_FS}
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
  sun *= u_cloudFieldLight.y;
  vec3 lit = col * atmosphereLight(v_world, n, sun, ao);
#else
  vec3 lit = col * u_warmTint.rgb * lightOnAt(v_world, n, sun, ao);
#endif
  o_color = vec4(seaView(lit, v_world, v_air, v_airThrough), 1.0);
}`;

const objectDepthVs = (thin: boolean): string => /* glsl */ `#include <header>
uniform mat4 u_lightRender;
${objectTransform(thin)}
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
  passes: { color: { vs: objectVs(false), fs: OBJECT_FS }, shadow: { vs: objectDepthVs(false), fs: DEPTH_FS } },
};

/** The trees, which also stand thinned in the three levels above `u_coverLevel` and leave by rank. Same uniforms. */
export const TREE_MATERIAL: MaterialDesc = {
  name: 'planet-tree',
  attribs: OBJECT_ATTRIBS,
  passes: { color: { vs: objectVs(true), fs: OBJECT_FS }, shadow: { vs: objectDepthVs(true), fs: DEPTH_FS } },
};

// --- Strips (strips.ts) ---------------------------------------------------------------------------------------------
// The strip of a cell blends between levels like the surface (`spherePatchMorph`), then `stripWiden` keeps it at least
// STRIP_MIN_PX pixels wide, and `canopyPull` keeps it in front of the canopy of a wood beside it. Lit with the local up, the sun, the fog and the air as the surface; coloured by line.

/** Least width of a strip on the screen, in pixels. */
export const STRIP_MIN_PX = 1.6;

const STRIP_VS = /* glsl */ `#include <header>
#include <noise>
#include <atmosphere>
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${COVER_FADE_GLSL}
uniform float u_cellLevel;
uniform float u_coverLevel;
${THIN_GLSL}
${CANOPY_VS}
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
  // In front of the canopy of a wood beside it.
  gl_Position = u_viewProj * vec4(canopyPull(p, coverShareAt(p)), 1.0);
}`;

const STRIP_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${SEA_FS}
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
  sun *= u_cloudFieldLight.y;
  vec3 lit = col * atmosphereLight(v_world, up, sun, 1.0);
#else
  vec3 lit = col * u_warmTint.rgb * lightOnAt(v_world, up, sun, 1.0);
#endif
  o_color = vec4(seaView(lit, v_world, v_air, v_airThrough), 1.0);
}`;

/** The strips of a cell made by `generatePlanetStripCell`, colour pass only; needs `u_showLevels`. */
export const STRIP_MATERIAL: MaterialDesc = {
  name: 'planet-strip',
  attribs: STRIP_ATTRIBS,
  passes: { color: { vs: STRIP_VS, fs: STRIP_FS } },
};

// --- The water ---------------------------------------------------------------------------------------------------------
// Two meshes draw the surface, both after the opaque cells without writing depth, both sides, premultiplied (their
// colour is added, what lies behind keeps 1 − alpha):
// - the water of the cells (world.ts, `waterPatch`): a patch on the base sphere, blended between levels like the
//   surface, flat, with the depth of the floor under it in its colour (`waterDepthByte`, world.ts); it leaves out the disc round
//   the eye's foot that the near surface covers (`u_liquid.z`);
// - the near surface (sea.ts, `SeaSurfaceLayer`): a grid of rings round the eye's foot, moved by the waves in its
//   vertex shader, each train faded where the rings are too far apart for it, drawn from its outer ring inward; the
//   floor's depth comes from the depth of the scene drawn so far, and where the land or the sky lies behind a wave
//   the wave is opaque water.
// Both shade the same way (`SEA_SURFACE_GLSL`): the normal of the waves at the pixel (each train faded where a pixel
// covers too much of it, plus ripples down to a few centimetres, `SEA_RIPPLES`), the sky by the share the surface
// reflects, the sun's glint widened by the slopes too small to see, foam on the sharpest crests and on the shore. Where
// the view ray rises into the surface (a crest above the eye) the light through it is the water's own. From below:
// the sky inside the window of refraction, its edge soft over the spread of the facets in a pixel, the sun as the
// glitter of the facets that bend it toward the eye, the water mirrored beyond, then the water on the way down and
// its light shafts.

const SEA_SURFACE_GLSL = /* glsl */ `${liquidRipplesGlsl()}// The surface seen from eye at world (moved by the waves), whose undisplaced point is xz in the plane of the waves
// (dxz: its change across a pixel, as for liquidRipples); floorDepth: the floor's depth under the level there (m, below
// 0 not known); open: 1 where the caller knows that nothing under the water lies behind the surface along the view
// ray (a wave standing in front of the land or the sky); skyCalm: the sky along the calm surface's reflection (above)
// or refraction (below), on the screen's scale. Premultiplied colour and alpha.
vec4 seaSurface(vec3 world, vec2 xz, vec4 dxz, float floorDepth, float open, vec3 skyCalm, vec3 air, vec3 airThrough, vec3 eye) {
  vec3 up = localUp(world);
  vec3 ta;
  vec3 tb;
  liquidTangents(up, ta, tb);
  vec3 toEye = eye - world;
  float len = max(length(toEye), 1e-3);
  vec3 v = toEye / len;
  float px = metresPerPixelAt(world);
  float sampleM = 2.5 * px;
  float jac;
  vec3 np = waveNormal(xz, sampleM, jac);
  float t = u_time.x;
  // The ripples on the waves, down to a few centimetres, each octave faded by the pixel's footprint.
  vec2 wind = normalize(u_waveTrain0.xy + vec2(1e-6, 0.0));
  float rippleRough;
  vec2 g = liquidRipples(xz, max(length(dxz.xy), length(dxz.zw)), rippleRough);
  vec3 n = normalize(ta * (np.x - g.x) + up * np.y + tb * (np.z - g.y));
  // Slope variance of what is too small to see: the faded trains and the ripples beyond the pixel.
  float rough = waveUnresolved(sampleM) + rippleRough;
  vec3 s = liquidSunDir();
  vec3 light = liquidSurfaceLight(world);
  // Foam: on crests squeezed together, broken by a grain; on the shore a band where the water is shallow, with
  // swashes running up it.
  float crest = smoothstep(0.8, 0.5, jac);
  float wd = floorDepth >= 0.0 ? floorDepth + localHeight(world) : 1e9;
  float grain = 0.55;
  if ((crest > 0.0 || wd < 2.2) && px < 0.8) {
    grain = vnoise(xz / 1.1 + wind * (0.4 * t), 83u) * 0.6 + vnoise(xz / 0.37 - wind * (0.2 * t), 84u) * 0.4;
    grain = mix(grain, 0.55, smoothstep(0.2, 0.8, px));
  }
  float foam = crest * smoothstep(0.3, 0.75, grain);
  if (wd < 2.2) {
    float swash = 0.5 + 0.5 * sin(wd * 7.0 - t * 1.4 + grain * 4.0);
    float shore = (1.0 - smoothstep(0.05, 0.6, wd)) * smoothstep(0.2, 0.6, grain + 0.25);
    shore = max(shore, smoothstep(0.75, 0.95, swash) * (1.0 - smoothstep(0.3, 2.2, wd)) * smoothstep(0.35, 0.7, grain));
    foam = max(foam, shore);
  }
  foam = clamp(foam, 0.0, 1.0) * 0.9;
  vec3 zenith = toDisplay(light * 0.18);
  if (u_liquid.x >= 0.0) {
    float cosV = max(dot(n, v), 0.03);
    float F = mediumFresnel(cosV, 1.0 / 1.33);
    // The sky along the reflection: the calm one, lighter toward the zenith, darker where the ray dips under the
    // horizon (it would meet the next wave).
    vec3 r = reflect(-v, n);
    float e = dot(r, up);
    float eCalm = max(dot(v, up), 0.0);
    vec3 sky = e > eCalm ? mix(skyCalm, zenith, smoothstep(eCalm, 1.0, e) * 0.6) : skyCalm * mix(0.55, 1.0, smoothstep(-0.15, eCalm, e));
    sky = applyFog(sky, world);
    // The glint: a Beckmann lobe of the slopes, widened by what is unresolved.
    vec3 h = normalize(s + v);
    float nh = max(dot(n, h), 1e-3);
    float m2 = 0.0012 + rough;
    float nh2 = nh * nh;
    float D = exp(-(1.0 - nh2) / (nh2 * m2)) / (3.14159 * m2 * nh2 * nh2);
    float glint = min(D * mediumFresnel(max(dot(h, v), 0.0), 1.0 / 1.33) / (4.0 * cosV), 60.0) * smoothstep(-0.02, 0.05, dot(n, s));
    vec3 shine = glint > 0.001 ? toDisplay(liquidSun(world) * glint) : vec3(0.0);
    vec3 a0 = atmosphereApply(vec3(0.0), world, air, airThrough);
    vec3 a1 = atmosphereApply(vec3(1.0), world, air, airThrough) - a0;
    vec4 c = vec4((sky * F + shine) * a1 + a0 * F, F);
    // Where the view ray rises into the surface (a wave standing above it) or the caller knows that nothing under the
    // water lies behind (open), what the scene drew behind is not seen through water: the light through the surface
    // is the water's own, as along the rest of the sea's view rays.
    float o = max(open, step(0.0, -dot(v, up)));
    if (o > 0.0) {
      vec3 body = applyFog(liquidDisplay(liquidInscatter(2.0, light, -dot(v, up))), world);
      c = mix(c, vec4(c.rgb + (body * a1 + a0) * (1.0 - F), 1.0), o);
    }
    vec3 foamColor = atmosphereApply(applyFog(toDisplay(light * 0.8), world), world, air, airThrough);
    return mix(c, vec4(foamColor, 1.0), foam);
  }
  // From below: inside the window of refraction the sky and the sun's glitter, beyond it the total reflection of the
  // water under the surface; the waves and the ripples bend and break the window's edge. Then the water on the way
  // down, with its shafts. The facets inside a pixel spread the angle of incidence by what is unresolved and by the
  // change of the normal across the pixel; over that spread the window's edge and the glitter are soft.
  float eyeDepth = -u_liquid.x;
  vec3 dnx = dFdx(n);
  vec3 dny = dFdy(n);
  float spread = sqrt(rough + 0.25 * (dot(dnx, dnx) + dot(dny, dny))) + 0.01;
  float cosI = max(dot(-n, v), 0.0);
  // The squared cosine on the air's side: 0 at the critical angle, below 0 beyond it; taken through 0 smoothly over
  // the spread (its change with the angle there is 1.75 per radian), so the light that crosses fades out over it.
  float x = 1.0 - 1.7689 * (1.0 - cosI * cosI);
  float wx = 1.75 * spread;
  float xs = x >= wx ? x : (x <= -wx ? 0.0 : (x + wx) * (x + wx) / (4.0 * wx));
  float kk = sqrt(xs);
  float F = 0.02 + 0.98 * pow(1.0 - kk, 5.0);
  vec3 m = reflect(-v, -n);
  float mu = min(dot(m, up), 0.0);
  // In shallow water the mirrored ray soon meets the floor: the mirror is lighter than the open water's depth.
  vec3 deep = liquidDisplay(liquidInscatter(eyeDepth + min(-mu * ${SEA_CLEAR_M.toFixed(1)}, 10.0), light, mu));
  vec3 c = deep;
  if (F < 1.0) {
    vec3 tr = normalize(kk * n - 1.33 * (v + cosI * n));
    float e = max(dot(tr, up), 0.0);
    vec3 sky = mix(skyCalm, zenith, smoothstep(0.0, 1.0, e) * 0.5);
    // The sun: the glitter of the facets that bend its light toward the eye (a Beckmann lobe of the facet normal that
    // does it, widened by the spread, times the share that crosses and the narrowing of the beam), on a soft glow.
    vec3 sv = s + 1.33 * v;
    vec3 ht = -normalize(sv);
    float nh = max(dot(n, ht), 1e-3);
    float m2 = 0.0015 + 2.0 * spread * spread;
    float nh2 = nh * nh;
    float D = exp(-(1.0 - nh2) / (nh2 * m2)) / (3.14159 * m2 * nh2 * nh2);
    float sh = max(dot(s, ht), 0.0);
    float glitter = D * sh * max(-dot(v, ht), 0.0) * 1.7689 * (1.0 - mediumFresnel(sh, 1.0 / 1.33)) / (max(cosI, 0.05) * dot(sv, sv));
    float sd = max(dot(tr, s), 0.0);
    vec3 sun = liquidDisplay(liquidSun(world) * (min(0.05 * glitter, 40.0) * step(0.0, dot(s, up)) + 0.3 * pow(sd, 300.0) + 0.1 * pow(sd, 30.0)));
    // The window's rim is lighter: light from near the horizon, bent toward the eye.
    float rim = smoothstep(0.55, 1.0, F) * (1.0 - F);
    c = mix(deep, sky + sun + rim * 0.8 * sky, 1.0 - F);
  }
  // The underside of the foam: grey, lit through.
  c = mix(c, liquidDisplay(light * 0.35), foam * 0.8);
  vec3 water = liquidDisplay(liquidInscatter(eyeDepth, light, -dot(v, up)));
  return vec4(mediumApply(c, water, LIQUID_EXTINCTION, len), 1.0);
}
`;

// The sky along the calm surface's reflection (eye above) or refraction (eye below), on the screen's scale.
const SEA_SKY_VS = /* glsl */ `
vec3 seaCalmSky(vec3 p, vec3 up, vec3 eye) {
  vec3 v = normalize(eye - p);
  vec3 dir = u_liquid.x >= 0.0 ? reflect(-v, up) : refract(-v, -up, 1.33);
  if (dot(dir, dir) < 0.5) dir = reflect(-v, -up);
  dir = normalize(dir + up * max(0.0, 0.03 - dot(dir, up)));
#ifdef WH_ATMOSPHERE
  vec3 through;
  float ground;
  return atmDisplay(atmUnderCloud(atmosphereSky(dir, through, ground)));
#else
  return u_fogColor.rgb;
#endif
}
`;

const WATER_VS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
uniform vec3 u_cellOffset;
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${SPHERE_PATCH_GLSL}
${SEA_SKY_VS}
in vec3 a_pos;
in vec4 a_normal; // w: 0 surface, 1 skirt
in vec4 a_color;  // r: the floor's depth (waterDepthByte)
in float a_coarseShift;
in vec4 a_coarseColor;
out vec3 v_world;
out float v_skirt;
out float v_depth;
out vec3 v_sky;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 p = a_pos + u_cellOffset;
  vec3 up = localUp(p);
  float m = spherePatchMorph(p);
  p += up * (a_coarseShift * m);
  v_world = p;
  v_skirt = a_normal.w;
  float b = mix(a_color.r, a_coarseColor.r, m);
  v_depth = 64.0 * b * b;
  v_air = atmosphereAir(p, v_airThrough);
  v_sky = seaCalmSky(p, up, u_morphEye.xyz);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const WATER_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${WAVES_GLSL}
${SEA_SURFACE_GLSL}
uniform vec4 u_morphEye;
in vec3 v_world;
in float v_skirt;
in float v_depth;
in vec3 v_sky;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  vec2 xz = liquidPlane(v_world);
  vec4 dxz = vec4(dFdx(xz), dFdy(xz));
  // The skirt hangs under the water: it would add a second surface along the cells' borders. The floor behind a
  // crack between levels is drawn through the water already.
  if (v_skirt > 0.001) discard;
  // The near surface draws the disc round the eye's foot.
  if (u_liquid.z > 0.0) {
    vec3 upF = localUp(u_liquidFoot.xyz);
    vec3 q = v_world - u_liquidFoot.xyz;
    if (length(q - upF * dot(q, upF)) < u_liquid.z) discard;
  }
  o_color = seaSurface(v_world, xz, dxz, v_depth, 0.0, v_sky, v_air, v_airThrough, u_morphEye.xyz);
}`;

/** The water of a cell made by `generatePlanetCell` (material name `water`, drawn after the others); needs `seaUniforms`. */
export const WATER_MATERIAL: MaterialDesc = {
  name: 'planet-water',
  attribs: SPHERE_PATCH_ATTRIBS,
  passes: { color: { vs: WATER_VS, fs: WATER_FS } },
  state: { color: { depthWrite: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } } },
};

const NEAR_WATER_VS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
uniform vec4 u_morphEye;
uniform vec4 u_liquidNear; // x radius of the first ring, y log of the growth from ring to ring, z angle between spokes
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${WAVES_GLSL}
${SEA_SKY_VS}
in vec2 a_grid; // ring (0 the centre), spoke
out vec3 v_world;
out vec3 v_flat;
out vec2 v_plane;
out vec3 v_sky;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 upF = localUp(u_liquidFoot.xyz);
  vec3 ta;
  vec3 tb;
  liquidTangents(upF, ta, tb);
  tb = normalize(tb - ta * dot(tb, ta));
  float rho = a_grid.x < 0.5 ? 0.0 : u_liquidNear.x * exp(u_liquidNear.y * (a_grid.x - 1.0));
  float th = a_grid.y * u_liquidNear.z;
  float R = u_liquidFoot.w;
  // On the sphere: the drop under the foot's horizon at that distance, without the large numbers.
  float drop = rho * rho / (R + sqrt(max(R * R - rho * rho, 0.0)));
  vec3 p = u_liquidFoot.xyz + (ta * cos(th) + tb * sin(th)) * rho - upF * drop;
  v_flat = p;
  vec2 xz = liquidPlane(p);
  v_plane = xz;
  vec3 up = localUp(p);
  vec3 a;
  vec3 b;
  liquidTangents(up, a, b);
  // Each train fades where the rings are too far apart for it.
  vec3 d = waveDisplace(xz, max(rho * u_liquidNear.z, u_liquidNear.x)) * u_liquid.w;
  p += a * d.x + up * d.y + b * d.z;
  v_world = p;
  v_air = atmosphereAir(p, v_airThrough);
  v_sky = seaCalmSky(p, up, u_morphEye.xyz);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const NEAR_WATER_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
${COMMON_FS}
${MEDIUM_GLSL}
${SEA_COMMON_GLSL}
${WAVES_GLSL}
${SEA_SURFACE_GLSL}
uniform vec4 u_morphEye;
uniform highp sampler2D u_liquidScene; // depth of the scene drawn so far
uniform vec4 u_liquidSceneMap;         // its depth to distance along the view (cloudVolumeDepthMap of env); x 0: none
uniform vec3 u_liquidForward;          // the view's forward axis
in vec3 v_world;
in vec3 v_flat;
in vec2 v_plane;
in vec3 v_sky;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
float sceneDistance(float depth, vec4 map) {
  if (map.x > 2.5) return depth >= 0.999999 ? 1e30 : exp2(depth / map.w) - 1.0;
  if (map.x < 0.5 || (map.x < 1.5 ? depth <= 0.0 : depth >= 0.9999999)) return 1e30;
  float ndc = map.x > 1.5 ? depth * 2.0 - 1.0 : depth;
  return map.z / (ndc - map.y) * map.w;
}
void main() {
  vec4 dxz = vec4(dFdx(v_plane), dFdy(v_plane));
  vec3 upF = localUp(u_liquidFoot.xyz);
  vec3 q = v_flat - u_liquidFoot.xyz;
  if (length(q - upF * dot(q, upF)) >= u_liquid.z) discard;
  vec3 eye = u_morphEye.xyz;
  // What the scene drew behind this point of the surface, along the same ray: the floor under the water, or the land
  // or the sky, which a wave in front of them hides (open). The floor's depth stands for the depth under this point
  // (for the foam of the shore) only where the ray meets the floor near it: at a grazing ray it is far off.
  float floorDepth = -1.0;
  float open = 0.0;
  if (u_liquid.x >= 0.0 && u_liquidSceneMap.x > 0.5) {
    float z = sceneDistance(texelFetch(u_liquidScene, ivec2(gl_FragCoord.xy), 0).r, u_liquidSceneMap);
    float here = dot(v_world - eye, u_liquidForward);
    if (here > 0.0) {
      vec3 at = eye + (v_world - eye) * (min(z, 1e9) / here);
      float behind = z < 1e29 ? localHeight(at) : 1e9;
      if (behind > 0.02) open = 1.0;
      else if (length(at - v_world) < 4.0 - 8.0 * behind) floorDepth = max(-behind, 0.0);
    }
  }
  o_color = seaSurface(v_world, v_plane, dxz, floorDepth, open, v_sky, v_air, v_airThrough, eye);
}`;

/** The near surface of the sea (sea.ts, `SeaSurfaceLayer`): a grid of rings, attribute `a_grid`. */
export const NEAR_WATER_MATERIAL: MaterialDesc = {
  name: 'planet-near-water',
  attribs: { a_grid: 0 },
  passes: { color: { vs: NEAR_WATER_VS, fs: NEAR_WATER_FS } },
  state: { color: { depthTest: true, depthWrite: false, cull: 'none', blend: { src: 'one', dst: 'one-minus-src-alpha' } } },
};
