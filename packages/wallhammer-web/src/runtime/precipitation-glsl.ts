// Precipitation over the whole image: rain as slanted streaks, snow as flakes. Drawn with a single triangle across
// the screen after the scene and blended transparently. The pattern is a pure function of animation time and pixel position,
// so the same time gives the same image and stopped clocks stop the rain too.

export const PRECIP_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const PRECIP_FS = /* glsl */ `#include <header>
#include <noise>
uniform float u_slant;   // horizontal shift per pixel of fall (wind across the screen)
uniform vec2 u_fall;     // screen direction of the fall, (0, -1) when it runs straight down the screen
uniform float u_pxScale; // physical pixels per CSS pixel
out vec4 o_color;

// One layer of rain streaks. Grid cells have at most one drop, the grid falls and is sheared by the wind.
float rainLayer(vec2 p, vec2 cellSize, float speed, float len, uint seed, float density) {
  vec2 q = p;
  q.y += u_time.x * speed;
  q.x += q.y * u_slant;
  vec2 cell = floor(q / cellSize);
  ivec2 ic = ivec2(cell);
  if (hash2(ic, seed) > density) return 0.0;
  vec2 f = q - cell * cellSize;
  float x0 = (0.15 + 0.7 * hash2(ic, seed + 1u)) * cellSize.x;
  float y0 = hash2(ic, seed + 2u) * (cellSize.y - len);
  float a = 1.0 - smoothstep(0.3, 1.0, abs(f.x - x0) / u_pxScale);
  float along = (f.y - y0) / len;
  // The bottom end (earlier in time) is the strongest, the streak fades upward.
  return a * step(0.0, along) * step(along, 1.0) * (1.0 - 0.7 * along);
}

float snowLayer(vec2 p, float cell, float speed, float radius, uint seed, float density) {
  vec2 q = p;
  q.y += u_time.x * speed;
  q.x += u_time.x * speed * u_slant;
  vec2 c = floor(q / cell);
  ivec2 ic = ivec2(c);
  if (hash2(ic, seed) > density) return 0.0;
  float ph = hash2(ic, seed + 3u) * 6.2831853;
  vec2 center = vec2(0.2 + 0.6 * hash2(ic, seed + 1u), 0.2 + 0.6 * hash2(ic, seed + 2u)) * cell;
  center.x += sin(u_time.x * (0.9 + 0.6 * hash2(ic, seed + 4u)) + ph) * cell * 0.16;
  float d = length(q - c * cell - center);
  return 1.0 - smoothstep(radius * 0.45, radius, d);
}

void main() {
  float k = u_weather.w;
  // Rotate the screen so the fall runs along −y.
  vec2 p = vec2(-u_fall.y * gl_FragCoord.x + u_fall.x * gl_FragCoord.y, -u_fall.x * gl_FragCoord.x - u_fall.y * gl_FragCoord.y);
  float s = u_pxScale;
  float a;
  vec3 col;
  if (u_fogColor.w < 0.5) {
    float d = 0.15 + 0.6 * k;
    a = 0.34 * rainLayer(p, vec2(7.0, 70.0) * s, 1500.0 * s, 26.0 * s, 101u, d)
      + 0.26 * rainLayer(p + 31.0, vec2(5.0, 52.0) * s, 1150.0 * s, 18.0 * s, 102u, d)
      + 0.18 * rainLayer(p + 57.0, vec2(4.0, 40.0) * s, 850.0 * s, 12.0 * s, 103u, d * 0.8);
    a *= 0.55 + 0.45 * k;
    col = min(u_fogColor.rgb * 1.25 + 0.08, vec3(1.0));
  } else {
    float d = 0.12 + 0.5 * k;
    a = 0.9 * snowLayer(p, 30.0 * s, 95.0 * s, 2.6 * s, 111u, d)
      + 0.75 * snowLayer(p + 13.0, 22.0 * s, 70.0 * s, 2.0 * s, 112u, d)
      + 0.55 * snowLayer(p + 29.0, 16.0 * s, 48.0 * s, 1.5 * s, 113u, d);
    col = mix(u_fogColor.rgb, vec3(0.93, 0.93, 0.91), 0.75);
  }
  a = clamp(a, 0.0, 0.9);
  o_color = vec4(col * a, a);
}`;
