// Trees: instances of several lumpy shapes. The canopy is dark and voluminous, the lit side has lighter tufts of foliage.


/** Shared transform of an instance vertex into the world, also used by the shadow pass. */
export const TREE_TRANSFORM = /* glsl */ `
in vec3 a_pos;     // canopy and trunk at unit height 0–1, horizontally in canopy radii
in vec3 a_normal;
in vec4 a_shade;   // x vertex shading 0–1, y kind: 0 canopy, 1 trunk, z wind flutter 0–1, w phase 0–1
in vec4 i_base;    // xyz tree base, w canopy radius
in vec4 i_shape;   // x height, y cos of rotation, z sin of rotation, w hue 0–1
in vec4 i_extra;   // x canopy start (share of height), y flexibility in wind, z phase 0–1, w reserve
uniform float u_trunkReach; // how far the trunk reaches into the canopy (share of the canopy): a part in summer, almost to the top for a bare tree
// Share of the tree height at which the vertex lies. The canopy occupies the span from its start upward, the trunk reaches a bit into it.
float treeHeightFraction() {
  float cb = i_extra.x;
  return mix(cb + a_pos.y * (1.0 - cb), a_pos.y * (cb + u_trunkReach * (1.0 - cb)), a_shade.y);
}
vec3 treeLocal() {
  return vec3(a_pos.x * i_base.w, treeHeightFraction() * i_shape.x, a_pos.z * i_base.w);
}
vec3 treeRotate(vec3 v) {
#ifdef WH_LOCAL_UP
  // Up is radial: the instance stands in the local frame of its base.
  return localFrame(i_base.xyz) * vec3(v.x * i_shape.y - v.z * i_shape.z, v.y, v.x * i_shape.z + v.z * i_shape.y);
#else
  return vec3(v.x * i_shape.y - v.z * i_shape.z, v.y, v.x * i_shape.z + v.z * i_shape.y);
#endif
}
// Position in tree space for noise: every tree has its pattern shifted by its hue.
vec3 treeObj(vec3 local) {
  return local + vec3(i_shape.w * 37.0, 0.0, i_shape.w * 11.0);
}
`;

/**
 * Foliage by season: leafiness, autumn colour and freshness of one tree. Every tree has its own offset
 * (leafs out, changes colour and sheds slightly at a different time). A bare canopy is a sparse lace of branches. Returns coverage by foliage and branches
 * for alpha-to-coverage; outside winter it is 1 everywhere and nothing turns transparent.
 */
export const TREE_SEASON = /* glsl */ `
uniform int u_evergreen;
const float TWIG_COVER = 0.55;
float treeHashA(float tint, float phase) { return fract(tint * 7.31 + phase * 3.73); }
float treeHashB(float tint, float phase) { return fract(tint * 13.7 + phase * 5.11); }
float treeDensity(float tint, float phase) {
  if (u_evergreen != 0) return 1.0;
  float h = treeHashA(tint, phase);
  return smoothstep(h * 0.4, h * 0.4 + 0.6, u_season.x);
}
// x foliage coverage, y total coverage (foliage or branches). visC and visF: how sharply the coarse (tufts around a metre)
// and the fine canopy detail are visible. What is not visible turns into average coverage, which alpha-to-coverage spreads over the samples.
vec2 crownCover(vec3 obj, float dens, float visC, float visF) {
  if (dens >= 0.999) return vec2(1.0);
  float coarse = vnoise3(obj * 0.9, 44u);
  float fine = vnoise3(obj * 2.6, 45u);
  float nz = smoothstep(0.2, 0.8, mix(coarse, 0.55 * coarse + 0.45 * fine, visF));
  float edge = mix(0.22, 0.05, visF);
  float leafA = mix(dens, 1.0 - smoothstep(dens - edge, dens + edge, nz), visC);
  // Branches up close as sharp clusters (no sieve), from afar average coverage.
  float tw = smoothstep(0.5, 0.56, vnoise3(obj * 3.4 + 7.0, 46u));
  float twigA = mix(TWIG_COVER * 0.6, tw * 0.95, visF);
  return vec2(leafA, max(leafA, twigA));
}
`;

/**
 * Wind in the canopies. A tree is anchored at the ground and bends more the higher the top is. Gusts travel across the landscape
 * with the wind, every tree sways to them at its own rhythm and the canopy surface flutters slightly.
 * The largest horizontal deflection is 1.03 × deflection × flexibility + 1.46 × flutter, the check of
 * canopy setback from walls relies on it (see environment.ts).
 */
export const TREE_WIND = /* glsl */ `
vec3 treeWind(float heightFraction) {
  if (u_wind.z <= 0.0) return vec3(0.0);
  const float TAU = 6.2831853;
  vec2 dir = u_wind.xy;
  vec2 side = vec2(-dir.y, dir.x);
  float t = u_time.x;
  float own = i_extra.z * TAU;
  // Gust: a wave travelling with the wind. It is undulated across so its front is not ruler-straight.
#ifdef WH_LOCAL_UP
  // Up is radial: gusts are placed by the position relative to the centre, and the bend lies in the local horizon.
  vec2 at = (i_base.xyz - u_upCenter.xyz).xz;
#else
  vec2 at = i_base.xz;
#endif
  float across = dot(at, side);
  float along = dot(at, dir) - u_gust.y * t;
  float gust = 0.5 + 0.5 * sin(along * u_gust.x + 1.4 * sin(across * 0.023) + across * u_gust.x * 0.31);
  float lean = 0.4 + 0.45 * gust + 0.15 * sin(t * 1.9 + own);
  float sway = 0.25 * sin(t * 1.3 + own * 1.7);
  vec2 bend = (dir * lean + side * sway) * (u_wind.z * i_extra.y * heightFraction * heightFraction);
  float ph = a_shade.w * TAU + own;
  vec3 flutter = vec3(sin(t * 5.3 + ph), 0.5 * sin(t * 4.1 + ph * 1.7), sin(t * 4.7 + ph * 2.3));
#ifdef WH_LOCAL_UP
  return localFrame(i_base.xyz) * (vec3(bend.x, 0.0, bend.y) + flutter * (u_wind.w * a_shade.z * (0.6 + 0.4 * gust)));
#else
  return vec3(bend.x, 0.0, bend.y) + flutter * (u_wind.w * a_shade.z * (0.6 + 0.4 * gust));
#endif
}
`;

export const TREE_VS = /* glsl */ `#include <header>
${TREE_TRANSFORM}${TREE_WIND}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_obj;
out vec2 v_shade;
flat out float v_tint;
flat out float v_phase;
void main() {
  vec3 local = treeLocal();
  // Light and shadows are computed from the rest position, wind moves only the outline. The shadow map is thus independent of time.
  v_world = i_base.xyz + treeRotate(local);
  // Normal under non-uniform scale: divided by the axis scale.
  v_normal = treeRotate(vec3(a_normal.x / i_base.w, a_normal.y / (i_shape.x * (1.0 - i_extra.x)), a_normal.z / i_base.w));
  v_obj = treeObj(local);
  v_shade = a_shade.xy;
  v_tint = i_shape.w;
  v_phase = i_extra.z;
  gl_Position = u_viewProj * vec4(v_world + treeWind(local.y / i_shape.x), 1.0);
}`;

export const TREE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <snow>
${TREE_SEASON}
uniform ivec4 u_rows;  // palette rows: dark canopy, middle, light foliage, trunk
uniform int u_rowAlt;  // second hue of light foliage
uniform ivec4 u_seasonRows; // palette rows: autumn yellow, orange, rust, bare branches
uniform int u_springRow;    // spring foliage
in vec3 v_world;
in vec3 v_normal;
in vec3 v_obj;
in vec2 v_shade;
flat in float v_tint;
flat in float v_phase;
out vec4 o_color;

void main() {
  vec3 n = normalize(v_normal);
  if (v_shade.y > 0.5) {
    float sunT = sunVisibility(v_world, n, 2.0);
    vec3 bark = u_palette[u_rows.w].rgb * (1.0 - 0.15 * u_weather.y);
    bark = mix(bark, u_snow.rgb, snowOn(v_world, n, 0.0));
    o_color = vec4(applyFog(toDisplay(bark * u_warmTint.rgb * lightOn(n, sunT, 0.6)), v_world), 1.0);
    return;
  }
  // Season: foliage density and autumn colour of this tree.
  float dens = treeDensity(v_tint, v_phase);
  vec2 cover = crownCover(v_obj, dens, detailVisible(1.1), detailVisible(0.35));
  if (cover.y < 0.03) discard;
  float leafShare = cover.x / cover.y;
  float aut = 0.0;
  vec3 autCol = vec3(0.0);
  if (u_evergreen == 0) {
    float hb = treeHashB(v_tint, v_phase);
    // Every tree changes colour at a different time, the latest ones stay half green even at the peak of autumn.
    aut = smoothstep(hb * 0.75, hb * 0.75 + 0.45, u_season.y);
    vec3 y = u_palette[u_seasonRows.x].rgb, o = u_palette[u_seasonRows.y].rgb, r = u_palette[u_seasonRows.z].rgb;
    autCol = hb < 0.45 ? mix(y, o, smoothstep(0.3, 0.45, hb)) : mix(o, r, smoothstep(0.6, 0.85, hb));
  }
  // Foliage tufts: noise in tree space. From afar it turns into the average.
  float clump = 0.6 * vnoise3(v_obj * 0.9, 41u) + 0.4 * vnoise3(v_obj * 2.6, 42u);
  clump = mix(0.5, clump, detailVisible(0.7));
  float fine = (vnoise3(v_obj * 9.0, 43u) - 0.5) * detailVisible(0.25);

  float sun = sunVisibility(v_world, n, 3.0);
  // Foliage lets light through, hence a softer transition than at a wall.
  float ndl = clamp((dot(n, u_sunDir.xyz) + 0.3) / 1.3, 0.0, 1.0);
  float lit = ndl * sun;
  float shade = v_shade.x * (0.7 + 0.6 * clump);

  vec3 deep = u_palette[u_rows.x].rgb;
  vec3 mid = u_palette[u_rows.y].rgb;
  vec3 leaf = mix(u_palette[u_rows.z].rgb, u_palette[u_rowAlt].rgb, v_tint * 0.6);
  if (u_evergreen == 0) {
    vec3 spring = u_palette[u_springRow].rgb;
    leaf = mix(leaf, spring, u_season.z * 0.45);
    mid = mix(mid, spring * 0.72, u_season.z * 0.25);
    deep = mix(deep, autCol * 0.38, aut * 0.55);
    mid = mix(mid, autCol * 0.66, aut);
    leaf = mix(leaf, autCol, aut);
  }
  // Canopy colour goes from almost black in the notches through dark green to lighter foliage only on lit bumps.
  vec3 col = mix(deep, mid, smoothstep(0.1, 0.8, shade));
  col = mix(col, leaf, smoothstep(0.22, 0.9, lit * (0.55 + clump)) * 0.85);
  col *= 1.0 + 0.5 * fine;
  col *= 0.96 + 0.24 * v_tint;
  // Bare branches: grey-brown lace, darker inside the canopy.
  vec3 twig = u_palette[u_seasonRows.w].rgb * (0.7 + 0.3 * clump) * mix(0.75, 1.05, v_shade.x);
  col = mix(twig, col, leafShare);
  col *= 1.0 - 0.12 * u_weather.y;
  // Snow on the upper side of the canopy. Needles and branches hold it, dense foliage less.
  float snow = snowOn(v_world, n, 0.08) * mix(0.9, 0.6, leafShare * float(u_evergreen == 0)) * smoothstep(0.35, 0.75, clump + 0.25);
  col = mix(col, u_snow.rgb * (0.92 + 0.12 * clump), snow);

#ifdef WH_LOCAL_UP
  float nUp = dot(n, localUp(v_world));
#else
  float nUp = n.y;
#endif
  vec3 fill = (u_ambient.rgb + u_skyFill.rgb * (nUp * 0.5 + 0.5)) * mix(0.45, 1.0, v_shade.x);
  vec3 light = u_sunColor.rgb * lit * mix(0.6, 1.0, v_shade.x) + fill;
  o_color = vec4(applyFog(toDisplay(col * u_warmTint.rgb * light), v_world), cover.y);
}`;

// --- Shadow pass of the trees ---------------------------------------------------------------------------

export const DEPTH_TREE_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
${TREE_TRANSFORM}
out vec3 v_obj;
flat out vec3 v_tree; // hue, phase, trunk
void main() {
  vec3 local = treeLocal();
  v_obj = treeObj(local);
  v_tree = vec3(i_shape.w, i_extra.z, a_shade.y);
  gl_Position = u_lightRender * vec4(i_base.xyz + treeRotate(local), 1.0);
}`;

/**
 * Shadow of a sparse canopy: the fragment is discarded with a probability given by foliage and branch coverage. The threshold is a hash
 * of the texel position, so the shadow is stable and soft shading turns it into a penumbra.
 */
export const DEPTH_TREE_FS = /* glsl */ `#include <header>
#include <noise>
${TREE_SEASON}
in vec3 v_obj;
flat in vec3 v_tree;
void main() {
  if (v_tree.z > 0.5) return;
  float dens = treeDensity(v_tree.x, v_tree.y);
  if (dens >= 0.999) return;
  float a = crownCover(v_obj, dens, 1.0, 1.0).y;
  if (a < hash2(ivec2(gl_FragCoord.xy), 17u)) discard;
}`;
