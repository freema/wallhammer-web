// The comic look of the outpost, as materials over the engine's shader includes. Nothing here uses the engine's
// light model (`lightOn`, sky fill, fog, aerial perspective, `toDisplay`): only the sun direction of the Frame block
// (a fixed light, main.ts) and the shadow map (`sunVisibility` of the `<shadow>` include, cut into a hard edge). Every surface shows its palette colour in one of three hard steps:
//
//   lit      the sun reaches it and it faces the sun by more than STYLE.midBelow   → colour × 1
//   mid      lit, but at a grazing angle (the terminator band of a curved shell)     → colour × STYLE.mid
//   shadow   facing away, or in a cast shadow                                       → colour × STYLE.shadow × tint
//
// The step edges are antialiased over one pixel (fwidth), nothing else is smooth. Ink comes from two places:
//   panel lines  the toon pass draws dark lines where a panel coordinate (a_line) crosses an integer, a fixed number
//                of pixels wide (STYLE.linePx)
//   outlines     the hull pass draws the same triangles pushed out along a_hull by STYLE.outlinePx pixels at the
//                vertex's depth (`metresPerPixelAt` of the engine's header) with front faces culled, so silhouettes
//                keep about the same width on the screen at any distance
// Widths are given for a 1080-pixel-high image and scaled with the canvas height (render/scene.ts).

import type { MaterialDesc } from 'wallhammer-web/base';
import { DEPTH_FS, INSTANCE_SET_GLSL, instanceSetAttribs } from 'wallhammer-web/render';
import { glslColor } from './palette.ts';

export const STYLE = {
  /** Light steps (multiples of the palette colour). */
  lit: 1.0,
  mid: 0.86,
  shadow: 0.68,
  /** Below this cosine to the sun a lit surface takes the mid step. */
  midBelow: 0.2,
  /** Colour cast of the shadow step (slightly cool). */
  shadowTint: [0.93, 0.95, 1.02] as const,
  /** Silhouette outline and panel line width, pixels at 1080 lines. */
  outlinePx: 2.1,
  /**
   * Far outlines thin out to this share of the width, between these sizes of a pixel on the object (metres at 1080
   * lines: about 35 m and 150 m away at the default field of view), so distant small rocks do not turn into ink blots.
   */
  outlineFar: { k: 0.5, fromMpp: 0.03, toMpp: 0.13 },
  linePx: 1.3,
  /** How far panel lines go toward the outline colour (1 = fully). */
  lineInk: 0.88,
  /** Tone areas (kit/mesh.ts `tone`): below `toneDark.at` the colour × `toneDark.k`, above `toneLight.at` × `toneLight.k`. */
  toneDark: { at: 0.32, k: 0.9 },
  toneLight: { at: 0.68, k: 1.09 },
} as const;

/** Attribute locations of the mesh layout (kit/mesh.ts), then the instance record of the engine's instance sets. */
export const ATTRIBS = { a_pos: 0, a_normal: 1, a_hull: 2, a_line: 3, a_color: 4, ...instanceSetAttribs(5) } as const;

const f = (v: number): string => v.toFixed(4);

// --- Toon ---------------------------------------------------------------------------------------------------------------

function toonVs(instanced: boolean): string {
  return /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_line;
in vec4 a_color;
${instanced ? INSTANCE_SET_GLSL : ''}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_line;
out float v_tone;
flat out vec3 v_color;
void main() {
${
  instanced
    ? `  vec3 w = instancePoint(a_pos);
  v_normal = instanceNormal(a_normal);
  v_color = a_color.rgb * i_extra.rgb;`
    : `  vec3 w = a_pos;
  v_normal = a_normal;
  v_color = a_color.rgb;`
}
  v_world = w;
  v_line = a_line;
  v_tone = a_color.a;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;
}

const TOON_FS = /* glsl */ `#include <header>
#include <noise>
#include <shadow>
uniform vec4 u_ink; // x panel line width (px), y outline width (px)
in vec3 v_world;
in vec3 v_normal;
in vec3 v_line;
in float v_tone;
flat in vec3 v_color;
out vec4 o_color;

// 1 on a panel line: where a component of the panel coordinate is within half the line width of an integer.
float panelLine(vec3 l, float px) {
  vec3 w = max(fwidth(l), vec3(1e-6));
  vec3 d = abs(fract(l + 0.5) - 0.5) / w;
  float e = min(d.x, min(d.y, d.z));
  return 1.0 - smoothstep(px * 0.5 - 0.5, px * 0.5 + 0.5, e);
}

// A hard step of x at the edge e, antialiased over one pixel of x.
float hardStep(float e, float x) {
  float w = max(fwidth(x), 1e-4);
  return smoothstep(e - w * 0.5, e + w * 0.5, x);
}

void main() {
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, u_sunDir.xyz);
  // The softened query cut at one half: a hard edge that follows the outline of the shadow, not the texels of the
  // map (sunVisibilitySharp shows the texels as steps at this map's density).
  float sun = ndl > 0.0 ? sunVisibility(v_world, n, 1.5) : 0.0;
  float lit = hardStep(0.0, ndl) * hardStep(0.5, sun);
  float tone = mix(${f(STYLE.mid)}, ${f(STYLE.lit)}, hardStep(${f(STYLE.midBelow)}, ndl));
  vec3 shade = vec3(${f(STYLE.shadow * STYLE.shadowTint[0])}, ${f(STYLE.shadow * STYLE.shadowTint[1])}, ${f(STYLE.shadow * STYLE.shadowTint[2])});
  float area = mix(1.0, ${f(STYLE.toneDark.k)}, 1.0 - hardStep(${f(STYLE.toneDark.at)}, v_tone)) * mix(1.0, ${f(STYLE.toneLight.k)}, hardStep(${f(STYLE.toneLight.at)}, v_tone));
  vec3 c = v_color * area * mix(shade, vec3(tone), lit);
  c = mix(c, ${glslColor('outline')}, panelLine(v_line, u_ink.x) * ${f(STYLE.lineInk)});
  o_color = vec4(c, 1.0);
}`;

const PARTS_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
${INSTANCE_SET_GLSL}
void main() {
  gl_Position = u_lightRender * vec4(instancePoint(a_pos), 1.0);
}`;

/** Static pieces (merged chunks). */
export const TOON_MATERIAL: MaterialDesc = {
  name: 'outpost-toon',
  attribs: ATTRIBS,
  passes: { shadow: 'depth', color: { vs: toonVs(false), fs: TOON_FS } },
};

/** Instanced parts: the same look, a transform and a tint per record. */
export const TOON_PARTS_MATERIAL: MaterialDesc = {
  name: 'outpost-toon-parts',
  attribs: ATTRIBS,
  passes: { shadow: { vs: PARTS_DEPTH_VS, fs: DEPTH_FS }, color: { vs: toonVs(true), fs: TOON_FS } },
};

// --- Outline hull -------------------------------------------------------------------------------------------------------

function outlineVs(instanced: boolean): string {
  return /* glsl */ `#include <header>
uniform vec4 u_ink; // x panel line width (px), y outline width (px)
in vec3 a_pos;
in vec3 a_hull;
${instanced ? INSTANCE_SET_GLSL : ''}
void main() {
  // A vertex without an outline (kit/mesh.ts: a_hull zero): its triangles are moved off the screen.
  if (dot(a_hull, a_hull) == 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
${
  instanced
    ? `  vec3 base = instancePoint(a_pos);
  float k = length(a_hull);
  vec3 h = k > 0.0 ? instanceNormal(a_hull / k) * k : vec3(0.0);`
    : `  vec3 base = a_pos;
  vec3 h = a_hull;`
}
  // Push out by the outline width at this point's depth: the same number of pixels near and far (thinner far away).
  float mpp = metresPerPixelAt(base);
  float far = smoothstep(${f(STYLE.outlineFar.fromMpp)}, ${f(STYLE.outlineFar.toMpp)}, mpp * u_ink.y / ${f(STYLE.outlinePx)});
  vec3 w = base + h * (u_ink.y * mix(1.0, ${f(STYLE.outlineFar.k)}, far) * mpp);
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;
}

const OUTLINE_FS = /* glsl */ `#include <header>
out vec4 o_color;
void main() {
  o_color = vec4(${glslColor('outline')}, 1.0);
}`;

/** The hull of static pieces: the toon mesh with front faces culled, so the far side shows. Colour pass only. */
export const OUTLINE_MATERIAL: MaterialDesc = {
  name: 'outpost-outline',
  attribs: ATTRIBS,
  passes: { color: { vs: outlineVs(false), fs: OUTLINE_FS } },
  state: { color: { cull: 'front' } },
};

export const OUTLINE_PARTS_MATERIAL: MaterialDesc = {
  name: 'outpost-outline-parts',
  attribs: ATTRIBS,
  passes: { color: { vs: outlineVs(true), fs: OUTLINE_FS } },
  state: { color: { cull: 'front' } },
};
