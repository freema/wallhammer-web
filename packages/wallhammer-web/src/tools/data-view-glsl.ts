// Data view: ground coloured by surface class (nearest raster pixel, no filtering or light)
// and single-colour lines over it.

export const DATA_TERRAIN_FS = /* glsl */ `#include <header>
uniform usampler2D u_classes;
uniform sampler2D u_colors;
uniform float u_classStep;
uniform vec3 u_earth;
uniform usampler2D u_mask;
uniform int u_maskOn;
uniform vec3 u_maskColor;
uniform float u_hatchM;
uniform float u_maskOpacity;
in vec3 v_world;
in vec3 v_normal;
flat in float v_kind;
out vec4 o_color;
void main() {
  if (v_kind > 0.5) {
    o_color = vec4(u_earth * 0.6, 1.0);
    return;
  }
  ivec2 size = textureSize(u_classes, 0);
  ivec2 p = clamp(ivec2(floor(v_world.xz / u_classStep)), ivec2(0), size - 1);
  int c = int(texelFetch(u_classes, p, 0).r);
  vec3 col = texelFetch(u_colors, ivec2(c, 0), 0).rgb;
  if (u_maskOn > 0) {
    uint m = texelFetch(u_mask, p, 0).r;
    if (m > 0u) {
      // Hatch lines in world space, antialiased by their screen footprint.
      float a = (v_world.x + v_world.z) / u_hatchM;
      float w = max(fwidth(a), 1e-4);
      float d = abs(fract(a) - 0.5);
      float line = 1.0 - smoothstep(0.38 - w, 0.38 + w, 0.5 - d);
      if (m > 1u) {
        float b = (v_world.x - v_world.z) / u_hatchM;
        float wb = max(fwidth(b), 1e-4);
        float db = abs(fract(b) - 0.5);
        line = max(line, 1.0 - smoothstep(0.38 - wb, 0.38 + wb, 0.5 - db));
      }
      col = mix(col, u_maskColor, line * u_maskOpacity);
      // Outline: a neighbouring raster pixel outside the mask.
      ivec2 hi = size - 1;
      bool edge = texelFetch(u_mask, clamp(p + ivec2(1, 0), ivec2(0), hi), 0).r == 0u ||
                  texelFetch(u_mask, clamp(p - ivec2(1, 0), ivec2(0), hi), 0).r == 0u ||
                  texelFetch(u_mask, clamp(p + ivec2(0, 1), ivec2(0), hi), 0).r == 0u ||
                  texelFetch(u_mask, clamp(p - ivec2(0, 1), ivec2(0), hi), 0).r == 0u;
      if (edge) col = u_maskColor;
    }
  }
  o_color = vec4(col, 1.0);
}`;

export const LINE_VS = /* glsl */ `#include <header>
in vec3 a_pos;
void main() {
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

export const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_color;
out vec4 o_color;
void main() {
  o_color = vec4(u_color, 1.0);
}`;
