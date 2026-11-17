// Shaders of the value layers: numbers shown over a scene through a colour ramp. A value lives in a two-byte texel
// as a 16-bit word (0 = no value, 1–65535 across the value range, see `quantizeValues`); two time steps are bound at
// once and blended. Three shapes read the same words: a grid laid on the ground (one word per cell, or a cell that
// names a table row), discs (table row = instance number) and prisms (table row from a vertex attribute).
// Colours are shown exactly as the ramp gives them, without light or haze, so they can be read against a legend.

import type { MaterialDesc } from '../base/material.ts';
import type { BlendSpec, DrawState } from '../base/material.ts';
import { DRAPE_ATTRIBS, PRISM_ATTRIBS } from '../gen-mesh/index.ts';

/**
 * GLSL helpers for reading value words; put it right after `#include <header>`. The helpers take fetched texels,
 * never samplers.
 */
export const VALUE_GLSL = /* glsl */ `
precision highp sampler2D;
// The 16-bit word of a two-byte texel (red = low byte, green = high byte). 0 means "no value".
float valueWord(vec4 texel) {
  return floor(texel.r * 255.0 + 0.5) + floor(texel.g * 255.0 + 0.5) * 256.0;
}
// Texel of row i in a table texture that is w texels wide.
ivec2 tableCell(int i, int w) {
  return ivec2(i % w, i / w);
}
// x: the value as 0–1 across its range, y: 1 when there is a value, else 0.
vec2 valueOf(float word) {
  return vec2(max(word - 1.0, 0.0) / 65534.0, step(0.5, word));
}
// Two time steps blended by t. Where only one of them has a value, that value fades in or out.
vec2 blendSteps(vec2 a, vec2 b, float t) {
  float k = b.y * (a.y > 0.5 ? t : 1.0);
  return vec2(mix(a.x, b.x, k), mix(a.y, b.y, t));
}
// Position on the ramp of value v when the ramp spans the part range.x–range.y of the value range.
float rampPosition(vec2 range, float v) {
  return clamp((v - range.x) / max(range.y - range.x, 1e-6), 0.0, 1.0);
}
// Texture coordinate in a 256-texel ramp for position t (texel centres at both ends).
float rampCoord(float t) {
  return t * (255.0 / 256.0) + 0.5 / 256.0;
}
`;

const BLEND: BlendSpec = { src: 'src-alpha', dst: 'one-minus-src-alpha', srcAlpha: 'one', dstAlpha: 'one-minus-src-alpha' };

const RASTER_VS = /* glsl */ `#include <header>
in vec3 a_pos;
out vec3 v_world;
void main() {
  v_world = a_pos;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const RASTER_FS = /* glsl */ `#include <header>
${VALUE_GLSL}
uniform sampler2D u_valuesA;
uniform sampler2D u_valuesB;
uniform sampler2D u_ramp;
uniform sampler2D u_cells;
uniform vec4 u_grid;   // xy position of the grid's corner, zw cells per metre
uniform vec4 u_size;   // xy cells of the grid, z width of the value table in texels
uniform vec4 u_style;  // x blend of the two steps, y opacity, z 1 = smooth between cells, w 1 = cells name table rows
uniform vec4 u_range;  // xy part of the value range the ramp spans, z darkening of the outline between rows
in vec3 v_world;
out vec4 o_color;

vec2 valueAt(ivec2 p) {
  return blendSteps(valueOf(valueWord(texelFetch(u_valuesA, p, 0))), valueOf(valueWord(texelFetch(u_valuesB, p, 0))), u_style.x);
}

void main() {
  vec2 g = (v_world.xz - u_grid.xy) * u_grid.zw;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= u_size.x || g.y >= u_size.y) discard;
  ivec2 last = ivec2(u_size.xy) - 1;
  vec2 v = vec2(0.0);
  float edge = 0.0;
  if (u_style.w > 0.5) {
    // Each cell names a table row (row + 1, 0 = nothing here); the value comes from the table.
    ivec2 p = min(ivec2(g), last);
    float row = valueWord(texelFetch(u_cells, p, 0));
    if (row < 0.5) discard;
    v = valueAt(tableCell(int(row) - 1, int(u_size.z)));
    float rx = valueWord(texelFetch(u_cells, min(p + ivec2(1, 0), last), 0));
    float rz = valueWord(texelFetch(u_cells, min(p + ivec2(0, 1), last), 0));
    edge = (rx != row || rz != row) ? u_range.z : 0.0;
  } else if (u_style.z > 0.5) {
    // Bilinear between cell centres; cells without a value take no part, and the sheet ends half-way to them.
    vec2 q = g - 0.5;
    ivec2 p0 = clamp(ivec2(floor(q)), ivec2(0), last);
    ivec2 p1 = min(p0 + ivec2(1), last);
    vec2 f = clamp(q - vec2(p0), 0.0, 1.0);
    vec2 v00 = valueAt(p0);
    vec2 v10 = valueAt(ivec2(p1.x, p0.y));
    vec2 v01 = valueAt(ivec2(p0.x, p1.y));
    vec2 v11 = valueAt(p1);
    vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y) * vec4(v00.y, v10.y, v01.y, v11.y);
    float sum = w.x + w.y + w.z + w.w;
    if (sum < 1e-4) discard;
    v = vec2(dot(w, vec4(v00.x, v10.x, v01.x, v11.x)) / sum, smoothstep(0.4, 0.6, sum));
  } else {
    v = valueAt(min(ivec2(g), last));
  }
  if (v.y <= 0.0) discard;
  vec3 col = texture(u_ramp, vec2(rampCoord(rampPosition(u_range.xy, v.x)), 0.5)).rgb;
  o_color = vec4(col * (1.0 - edge), v.y * u_style.y);
}`;

const RASTER_STATE: DrawState = { depthWrite: false, depthFunc: 'lequal', cullBack: false, blend: BLEND, polygonOffset: [-1, -2] };

/** A grid of values laid on a sheet over the ground (`drapeTiles`). */
export const RASTER_VALUE_MATERIAL: MaterialDesc = {
  name: 'value-raster',
  attribs: DRAPE_ATTRIBS,
  passes: { color: { vs: RASTER_VS, fs: RASTER_FS } },
  state: { color: RASTER_STATE, data: RASTER_STATE },
};

/** Attribute locations of the disc material: the quad corner and one instance (centre and radius). */
export const POINT_VALUE_ATTRIBS = { a_corner: 0, a_point: 1 } as const;

const POINT_VS = /* glsl */ `#include <header>
${VALUE_GLSL}
in vec2 a_corner;
in vec4 a_point;       // xyz centre, w radius in metres
uniform sampler2D u_valuesA;
uniform sampler2D u_valuesB;
uniform vec4 u_style;  // x blend of the two steps, y opacity, z width of the value table in texels, w how much the value sets the size (0–1)
uniform vec4 u_range;  // xy part of the value range the ramp spans, z smallest radius in pixels, w radius scale
out vec2 v_corner;
flat out vec2 v_value;
flat out float v_px;
void main() {
  ivec2 c = tableCell(gl_InstanceID, int(u_style.z));
  vec2 v = blendSteps(valueOf(valueWord(texelFetch(u_valuesA, c, 0))), valueOf(valueWord(texelFetch(u_valuesB, c, 0))), u_style.x);
  float t = rampPosition(u_range.xy, v.x);
  vec3 p = a_point.xyz;
  // Metres per screen pixel at the point (grows with depth in a perspective view).
  float mpp = max(u_view.x + u_camRight.w * (dot(p, u_camForward.xyz) - u_camForward.w), 1e-4);
  // Area, not radius, follows the value.
  float r = a_point.w * u_range.w * mix(1.0, 0.35 + 0.65 * sqrt(t), u_style.w);
  r = max(r, u_range.z * mpp);
  v_corner = a_corner;
  v_value = vec2(t, v.y);
  v_px = r / mpp;
  vec3 world = p + (u_camRight.xyz * a_corner.x + u_camUp.xyz * a_corner.y) * r;
  gl_Position = v.y > 0.0 ? u_viewProj * vec4(world, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}`;

const POINT_FS = /* glsl */ `#include <header>
${VALUE_GLSL}
uniform sampler2D u_ramp;
uniform vec4 u_style;
in vec2 v_corner;
flat in vec2 v_value;
flat in float v_px;
out vec4 o_color;
void main() {
  float d = length(v_corner);
  // One screen pixel in units of the radius.
  float aa = 1.0 / max(v_px, 1.0);
  float a = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (a <= 0.0) discard;
  vec3 col = texture(u_ramp, vec2(rampCoord(v_value.x), 0.5)).rgb;
  // A darker rim keeps overlapping discs apart.
  float rimAt = 1.0 - max(0.14, 1.5 * aa);
  col *= 1.0 - 0.45 * smoothstep(rimAt - aa, rimAt, d);
  o_color = vec4(col, a * v_value.y * u_style.y);
}`;

const POINT_STATE: DrawState = { depthTest: false, depthWrite: false, cullBack: false, blend: BLEND };

/** Discs that face the view, one per instance, coloured and sized by the value of their table row. */
export const POINT_VALUE_MATERIAL: MaterialDesc = {
  name: 'value-points',
  attribs: POINT_VALUE_ATTRIBS,
  passes: { color: { vs: POINT_VS, fs: POINT_FS } },
  state: { color: POINT_STATE, data: POINT_STATE },
};

const SHAPE_VS = /* glsl */ `#include <header>
${VALUE_GLSL}
in vec3 a_pos;
in float a_ref;        // table row
uniform sampler2D u_valuesA;
uniform sampler2D u_valuesB;
uniform vec4 u_style;  // x blend of the two steps, y opacity, z width of the value table in texels, w 1 = rows without a value are drawn too
uniform vec4 u_range;  // xy part of the value range the ramp spans
out vec3 v_world;
flat out vec2 v_value;
void main() {
  ivec2 c = tableCell(int(a_ref + 0.5), int(u_style.z));
  vec2 v = blendSteps(valueOf(valueWord(texelFetch(u_valuesA, c, 0))), valueOf(valueWord(texelFetch(u_valuesB, c, 0))), u_style.x);
  v_value = vec2(rampPosition(u_range.xy, v.x), v.y);
  v_world = a_pos;
  bool shown = v.y > 0.0 || u_style.w > 0.5;
  gl_Position = shown ? u_viewProj * vec4(a_pos, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}`;

const SHAPE_FS = /* glsl */ `#include <header>
${VALUE_GLSL}
uniform sampler2D u_ramp;
uniform vec4 u_style;
uniform vec4 u_neutral; // rgb colour of rows without a value
in vec3 v_world;
flat in vec2 v_value;
out vec4 o_color;
void main() {
  // Face direction from the surface itself: the mesh carries no normals.
  vec3 n = cross(dFdx(v_world), dFdy(v_world));
  float len = length(n);
  n = len > 1e-12 ? n / len : vec3(0.0, 1.0, 0.0);
  // Faces that look up show the ramp colour itself; upright faces a little darker, so the shape reads as a solid.
  float shade = 0.8 + 0.2 * abs(n.y) - 0.06 * abs(n.z);
  vec3 col = mix(u_neutral.rgb, texture(u_ramp, vec2(rampCoord(v_value.x), 0.5)).rgb, v_value.y);
  o_color = vec4(col * shade, u_style.y * max(v_value.y, u_style.w));
}`;

const SHAPE_STATE: DrawState = { depthFunc: 'lequal', blend: BLEND, polygonOffset: [-1, -2] };

/** Prisms (`prismMesh`) coloured by the value of the table row each of them carries. */
export const SHAPE_VALUE_MATERIAL: MaterialDesc = {
  name: 'value-shapes',
  attribs: PRISM_ATTRIBS,
  passes: { color: { vs: SHAPE_VS, fs: SHAPE_FS } },
  state: { color: SHAPE_STATE, data: SHAPE_STATE },
};
