// Shader parts of the ground of a sphere drawn from streamed patch cells (`SPHERE_PATCH_ATTRIBS` and
// `SPHERE_PATCH_COVER_ATTRIBS` of gen-core): the vertex shader of the colour pass and of the shadow pass, the share
// of the far look by level (`sphereCoverThinGlsl`), and the parts that find where the ground goes under a level.
//
// The content keeps its look: the vertex shader calls four functions the caller defines (the `lift` block), and the
// fragment shader is the caller's own, reading the varyings documented on `sphereGroundVs`. With `extra` the vertex
// shaders also read the patch's extra channel (`extraAt` of gen-core), hand it on as `v_extra` and may move the vertex
// by a hook of the caller's (`groundVertex`), the same in the colour and the shadow pass.
//
// A vertex's colour alpha marks the ground under the level (0.5 or more) and holds a number of the caller's on the
// rest. Interpolated over a triangle that crosses the level, a test of that alpha makes teeth along the line, and the
// number of the ground above is mixed with the marks of the vertices below. With `waterline` the vertex shader also
// hands over the land's share and its alpha weighted by it (`v_landMark`); `SPHERE_GROUND_WATERLINE_GLSL` then
// decides the level per fragment from the fragment's own height and gives the alpha of the ground above alone.

import { COVER_FADE_GLSL } from '../core/index.ts';
import { SPHERE_PATCH_GLSL } from '../gen-core/index.ts';

/**
 * The share of the far look by level (`coverShareAt`, `thinKeep`, `thinBand`, `thinRank`): `rank[d]` is the share of
 * the objects a cell `d` levels finer than the coarsest that holds them all still keeps, `from[d]` where in its band
 * the next share starts to fade in. Needs `u_cellLevel`, `u_coverLevel`, `u_cellMorph`, `u_morphEye`, `coverKeep`.
 */
export function sphereCoverThinGlsl(rank: readonly number[], from: readonly number[]): string {
  return /* glsl */ `
const vec4 THIN_RANK = vec4(${rank.map((r) => r.toFixed(6)).join(', ')});
const vec4 THIN_FROM = vec4(${from.map((f) => f.toFixed(3)).join(', ')});
float thinRank(float d) {
  return d < 0.5 ? THIN_RANK.x : d < 1.5 ? THIN_RANK.y : d < 2.5 ? THIN_RANK.z : d < 3.5 ? THIN_RANK.w : 1.0;
}
// Where a point lies in the band of its cell's level: 0 at its start, 1 where the cell blends into its parent.
float thinBand(vec3 p) {
  if (u_cellMorph.y <= 0.0) return 0.0;
  vec3 d = p - u_morphEye.xyz;
#ifdef WH_LOCAL_UP
  vec3 e = u_morphEye.xyz - u_upCenter.xyz;
  float along = u_upCenter.w * atan(length(cross(e, d)), dot(e, e + d));
#else
  float along = length(d.xz);
#endif
  float dist = sqrt(along * along + u_morphEye.w * u_morphEye.w);
  float endM = u_cellMorph.x + 1.0 / u_cellMorph.y;
  float up = u_coverLevel - u_cellLevel;
  float from = up < 0.5 ? THIN_FROM.x : up < 1.5 ? THIN_FROM.y : up < 2.5 ? THIN_FROM.z : THIN_FROM.w;
  float startM = min(u_cellMorph.x, from * endM);
  return clamp((dist - startM) / (endM - startM), 0.0, 1.0);
}
// The share of the far look at a point of the cell: the objects that have left.
float coverShareAt(vec3 p) {
  float d = u_coverLevel - u_cellLevel;
  if (d < -0.5) return 0.0;
  if (d > 3.5) return 1.0;
  return mix(thinRank(d), thinRank(d + 1.0), clamp((thinBand(p) - 0.05) / 0.9, 0.0, 1.0));
}
// Size of an object with this rank standing at p.
float thinKeep(vec3 p, float rank) {
  float d = u_coverLevel - u_cellLevel;
  if (d < -0.5) return 1.0;
  float lo = thinRank(d);
  float hi = thinRank(d + 1.0);
  return rank >= hi ? 1.0 : coverKeep(thinBand(p), (rank - lo) / (hi - lo));
}
`;
}

export interface SphereGroundOptions {
  /** `rank` and `from` of `sphereCoverThinGlsl`. */
  thinRank: readonly number[];
  thinFrom: readonly number[];
  /**
   * GLSL defining the hooks of the cover's lift: `float coverLift(float mark, float share, float ground)` (metres the
   * cover lifts the surface, from the colour's alpha, the share of the far look and the ground's height),
   * `float coverLiftShare(float hidden)` (the share of that lift where the cover hides `hidden` of the ground),
   * `float coverElevation(vec3 p, vec3 n)` (sine of the view's angle above the ground) and
   * `vec3 coverShade(float sinE)` (the factor on the cover's colour at that angle). It may read the thin functions.
   */
  lift: string;
  /**
   * The patch's extra channel (made with `extraAt`; the material binds `SPHERE_PATCH_COVER_EXTRA_ATTRIBS`, or
   * `SPHERE_PATCH_EXTRA_ATTRIBS` for a patch without `coverAt`). Default: none, and both programs are unchanged byte
   * for byte. Give both shaders the same value, so the colour and the shadow pass move the ground alike.
   */
  extra?: SphereGroundExtra;
}

/** The extra channel of the ground: see `SphereGroundOptions.extra`. */
export interface SphereGroundExtra {
  /**
   * GLSL defining `vec3 groundVertex(vec3 p, vec4 extra)`: the vertex in render space after the blend between levels
   * and the extra blended with the same factor (`mix(a_extra, a_coarseExtra, m)`, 0–1 per byte); returns the point
   * to draw. Called before the cover's lift, so the lift, `v_world`, `v_lift.w` and the air see the moved point; the
   * normal is not changed. Pasted after `lift` at global scope: it may declare its own uniforms and read the header
   * (`localUp`, `localHeight`), `spherePatchMorph`, the thin functions and the lift's hooks. Default: none, the
   * channel is only handed on (`v_extra`) and the shadow pass does not read it.
   */
  vertex?: string;
}

export interface SphereGroundVsOptions extends SphereGroundOptions {
  /** Hand over `v_landMark` for `SPHERE_GROUND_WATERLINE_GLSL` (default false: the program is unchanged). */
  waterline?: boolean;
}

/**
 * The vertex shader of the ground's colour pass. Varyings: `v_world` (render position), `v_normal`, `v_color` (rgb the
 * colour, alpha the mark), `v_cover` (rgb the cover at this angle, a the share it hides), `v_lift` (x metres the cover
 * lifts the surface, y the sine of the view's angle above the ground, z the share of the far look, w the height of the
 * ground), `v_air` and `v_airThrough` (the air to the vertex), with `waterline` `v_landMark`, and with `extra`
 * `v_extra` (the extra channel blended between levels like the colour, 0–1 per byte).
 */
export function sphereGroundVs(o: SphereGroundVsOptions): string {
  const w = o.waterline === true;
  const x = extraParts(o.extra, true);
  return /* glsl */ `#include <header>
#include <atmosphere>
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${COVER_FADE_GLSL}
uniform float u_cellLevel;
uniform float u_coverLevel; // coarsest level whose cells hold every object the cover stands for
${sphereCoverThinGlsl(o.thinRank, o.thinFrom)}
${o.lift}
${x.globals}in vec3 a_pos;
in vec4 a_normal; // xyz normal (int16), w: 0 surface, 1 skirt
in vec4 a_color;  // rgb colour, a: 0.5 or more under the level
in float a_coarseShift;  // metres along up to the surface of the coarser level
in vec4 a_coarseNormal;  // its normal there (int16)
in vec4 a_coarseColor;   // its colour there
in vec4 a_cover;         // rgb what the objects on the surface look like from afar, a the share they hide
in vec4 a_coarseCover;   // the same on the coarser level
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
out vec4 v_cover;  // rgb the cover at this angle, a the share it hides
out vec4 v_lift; // x: metres the cover lifts the surface, y: sine of the view's angle above the ground, z: share of
                 // the far look, w: height of the ground
out vec3 v_air;        // light the air between the eye and the vertex scatters toward the eye
out vec3 v_airThrough; // share of the surface's colour that passes that air
${w ? 'out vec2 v_landMark; // x: share of the vertices above the level, y: their alpha weighted by it\n' : ''}void main() {
  vec3 p = a_pos + u_cellOffset;
  float m = spherePatchMorph(p);
  p += localUp(p) * (a_coarseShift * m);
${x.main}  vec4 cover = mix(a_cover, a_coarseCover, m);
  v_color = mix(a_color, a_coarseColor, m);
${w ? '  float landFine = 1.0 - step(0.5, a_color.a);\n  float landCoarse = 1.0 - step(0.5, a_coarseColor.a);\n  v_landMark = mix(vec2(landFine, landFine * a_color.a), vec2(landCoarse, landCoarse * a_coarseColor.a), m);\n' : ''}  float share = coverShareAt(p);
  float ground = localHeight(p);
  float whole = coverLift(v_color.a, share, ground);
  p += localUp(p) * (whole * coverLiftShare(cover.a));
  v_world = p;
  v_air = atmosphereAir(p, v_airThrough);
  v_normal = mix(a_normal.xyz, a_coarseNormal.xyz, m);
  float sinE = coverElevation(p, normalize(v_normal));
  v_cover = vec4(cover.rgb * coverShade(sinE), cover.a);
  v_lift = vec4(whole, sinE, share, ground);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;
}

/** The vertex shader of the ground's shadow pass: the surface lifted by the cover as the colour pass lifts it. */
export function sphereGroundDepthVs(o: SphereGroundOptions): string {
  // The shadow pass reads the channel only to move the vertex as the colour pass does.
  const x = extraParts(o.extra?.vertex === undefined ? undefined : o.extra, false);
  return /* glsl */ `#include <header>
uniform mat4 u_lightRender;
uniform vec3 u_cellOffset;
${SPHERE_PATCH_GLSL}
${COVER_FADE_GLSL}
uniform float u_cellLevel;
uniform float u_coverLevel;
${sphereCoverThinGlsl(o.thinRank, o.thinFrom)}
${o.lift}
${x.globals}in vec3 a_pos;
in float a_coarseShift;
in vec4 a_color;
in vec4 a_coarseColor;
in vec4 a_cover;
in vec4 a_coarseCover;
void main() {
  vec3 p = a_pos + u_cellOffset;
  float m = spherePatchMorph(p);
  p += localUp(p) * (a_coarseShift * m);
${x.main}  // The cover casts its shadow as the colour pass lifts it.
  float lift = coverLift(mix(a_color.a, a_coarseColor.a, m), coverShareAt(p), localHeight(p)) * coverLiftShare(mix(a_cover.a, a_coarseCover.a, m));
  p += localUp(p) * lift;
  gl_Position = u_lightRender * vec4(p, 1.0);
}`;
}

/**
 * The text the extra channel adds to a vertex shader: at global scope the hook and the attributes (and, `varying`,
 * `v_extra`), in `main` after the blend between levels the blended channel and the hook's call. Empty without it.
 */
function extraParts(extra: SphereGroundExtra | undefined, varying: boolean): { globals: string; main: string } {
  if (!extra) return { globals: '', main: '' };
  const hook = extra.vertex !== undefined;
  return {
    globals: `${hook ? `${extra.vertex}\n` : ''}in vec4 a_extra;       // the extra channel of the patch (extraAt)
in vec4 a_coarseExtra; // the same on the coarser level
${varying ? 'out vec4 v_extra;      // the extra channel blended between levels, 0 to 1 per byte\n' : ''}`,
    main: `  vec4 extra = mix(a_extra, a_coarseExtra, m);
${varying ? '  v_extra = extra;\n' : ''}${hook ? '  p = groundVertex(p, extra);\n' : ''}`,
  };
}

/** A fragment shader that writes nothing: depth only. */
export const DEPTH_ONLY_FS = /* glsl */ `#version 300 es
precision highp float;
void main() {}`;

/**
 * Fragment side of `waterline` (needs the header's `localHeight`): `groundUnder(p, blendM)`, the share 0–1 of the
 * fragment under the level by its own height, over ± `blendM` widened to a pixel; `groundLandAlpha()`, the colour
 * alpha of the vertices above the level alone (0 where every vertex is under it).
 */
export const SPHERE_GROUND_WATERLINE_GLSL = /* glsl */ `
in vec2 v_landMark;
float groundUnder(vec3 p, float blendM) {
  float h = localHeight(p);
  float w = max(blendM, fwidth(h));
  return 1.0 - smoothstep(-w, w, h);
}
float groundLandAlpha() {
  return v_landMark.x > 1e-4 ? v_landMark.y / v_landMark.x : 0.0;
}
`;
