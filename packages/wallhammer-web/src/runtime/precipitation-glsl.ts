// The shaders of the precipitation layer.
// - PRECIP_DROP_VS, PRECIP_DROP_FS: drops and flakes in the world round the eye, one quad each, built in the vertex
//   shader from gl_VertexID with the model of env (PRECIPITATION_GLSL): a rain drop is a thin streak along its motion
//   during a short exposure, a flake a soft round sprite; neither gets thinner than about a pixel (the alpha falls
//   instead). Depth tested against the scene, not written.
// - PRECIP_IMPACT_FS: the landing marks, one triangle over the screen that reads the scene's depth: splashes and
//   rings of rain, specks of snow, on surfaces that face up near the eye.
// - PRECIP_VS, PRECIP_FS: the pattern over the whole image (orthographic views and the look 'screen'): rain as slanted
//   streaks, snow as flakes, a pure function of the animation time and the pixel.

import { PRECIPITATION_GLSL, PRECIPITATION_MAX_TILES } from '../env/index.ts';

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
uniform float u_precipShare; // share of the frame's precipitation that falls at the eye
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
  float k = u_weather.w * u_precipShare;
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


export const PRECIP_DROP_VS = /* glsl */ `#include <header>
#include <noise>
${PRECIPITATION_GLSL}
uniform vec3 u_pcEye;       // the eye in render space
uniform vec4 u_pcTiles[${PRECIPITATION_MAX_TILES}]; // the tiles drawn: xyz corner relative to the eye, w seed
uniform vec4 u_pcShell;     // x tile edge, y life in seconds, z sway in metres, w sways per life
uniform vec4 u_pcRange;     // fade in from x to y, fade out from z to w (metres from the eye)
uniform vec3 u_pcVelocity;  // the fall in m/s
uniform vec2 u_pcClock;     // x share of the life, y whole lives
uniform float u_pcCount;    // drops per tile (fractional)
uniform int u_pcPerTile;    // drops per tile drawn (the count rounded up)
uniform vec4 u_pcSize;      // x width of a streak or radius of a flake (m), y exposure (s), z smallest size in pixels, w 0 rain 1 snow
out vec2 v_uv;
out float v_alpha;

void main() {
  int n = gl_VertexID / 6;
  int k = gl_VertexID - n * 6;
  int t = n / u_pcPerTile;
  int i = n - t * u_pcPerTile;
  vec4 tile = u_pcTiles[t];
  // Two triangles: corners 0 1 2, 2 1 3; x across, y along.
  int cc = k < 3 ? k : (k == 3 ? 2 : (k == 4 ? 1 : 3));
  vec2 c = vec2(float(cc & 1), float(cc >> 1));
  vec4 drop = precipitationDrop(i, tile, u_pcShell, u_pcVelocity, u_pcClock);
  vec3 p = drop.xyz;
  float a = precipitationDropFade(length(p), drop.w, u_pcRange) * clamp(u_pcCount - float(i), 0.0, 1.0);
  float depth = dot(p, u_camForward.xyz);
  if (a < 0.002 || depth < 0.05) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_uv = vec2(0.0);
    v_alpha = 0.0;
    return;
  }
  // Sizes differ a little from drop to drop.
  float size = u_pcSize.x * (0.7 + 0.6 * hash3(ivec3(i, 0, 5), uint(tile.w)));
  float mpp = max(u_camRight.w * depth, 1e-5);
  vec3 pos;
  if (u_pcSize.w < 0.5) {
    vec3 tail = p - u_pcVelocity * u_pcSize.y;
    vec3 axis = p - tail;
    vec3 dir = normalize(axis);
    vec3 side = cross(dir, normalize(p + tail));
    side = dot(side, side) > 1e-6 ? normalize(side) : u_camRight.xyz;
    float hw = max(0.5 * size, 0.5 * u_pcSize.z * mpp);
    a *= size / (2.0 * hw);
    pos = mix(tail - dir * hw, p + dir * hw, c.y) + side * (hw * (c.x * 2.0 - 1.0));
    v_uv = vec2(c.x * 2.0 - 1.0, c.y);
  } else {
    float r = max(size, u_pcSize.z * mpp);
    a *= (size / r) * (size / r);
    vec2 q = (c * 2.0 - 1.0) * 1.5;
    pos = p + (u_camRight.xyz * q.x + u_camUp.xyz * q.y) * r;
    v_uv = q;
  }
  v_alpha = a;
  gl_Position = u_viewProj * vec4(u_pcEye + pos, 1.0);
}`;

export const PRECIP_DROP_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
uniform vec3 u_pcEye;
uniform vec4 u_pcSize;
uniform vec4 u_pcLook;      // x opacity, y the share of the light that reaches the drops (0–1)
in vec2 v_uv;
in float v_alpha;
out vec4 o_color;

void main() {
  float a;
  vec3 col;
  if (u_pcSize.w < 0.5) {
    // Across: soft; along: strongest at the head (now), weaker toward the tail (the start of the exposure).
    float across = 1.0 - v_uv.x * v_uv.x;
    a = across * mix(0.35, 1.0, v_uv.y) * smoothstep(0.0, 0.12, v_uv.y) * smoothstep(1.0, 0.9, v_uv.y);
    col = min(u_fogColor.rgb * 1.3 + 0.04 * dot(u_fogColor.rgb, vec3(0.33)), vec3(1.0));
  } else {
    float r = length(v_uv);
    a = 1.0 - smoothstep(0.55, 1.45, r);
    vec3 up = localUp(u_pcEye);
    col = toDisplay(u_snow.rgb * lightOnAt(u_pcEye, up, u_pcLook.y, 1.0) * 1.3);
    col = mix(col, u_fogColor.rgb, 0.35 * u_weather.z);
  }
  a *= v_alpha * u_pcLook.x;
  if (a < 0.002) discard;
  o_color = vec4(col * a, a);
}`;

export const PRECIP_IMPACT_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
${PRECIPITATION_GLSL}
uniform sampler2D u_pcDepth;
uniform vec4 u_pcDepthMap;  // depth → distance along the view (cloudVolumeDepthMap)
uniform vec2 u_pcScreen;    // drawing surface in pixels
uniform vec3 u_pcRayCenter; // the view ray through the centre, scaled to depth 1, and the steps to the edges
uniform vec3 u_pcRayRight;
uniform vec3 u_pcRayUp;
uniform vec3 u_pcEye;       // the eye in render space
uniform vec3 u_pcImpactOffset; // the eye in the world, wrapped into the marks' period
uniform int u_pcAxis;       // the up axis the cells lie across: 0 x, 1 y, 2 z
uniform vec2 u_pcRangeM;    // marks fade out from x to y metres
uniform vec4 u_pcSpecA;     // first kind: cell, life over slot, radius, rate times strength
uniform vec4 u_pcSpecB;     // second kind (rain only)
uniform vec4 u_pcClocks;    // xy the first kind's slot and share of the slot, zw the second's
uniform int u_pcSeedA;
uniform int u_pcSeedB;
uniform vec4 u_pcLook;      // x 0 rain 1 snow, y opacity, z the share of the light that reaches the ground, w ring share
out vec4 o_color;

float sceneDistance(ivec2 px) {
  return precipitationDepthDistance(texelFetch(u_pcDepth, px, 0).r, u_pcDepthMap);
}
vec3 sceneAt(ivec2 px, float z) {
  vec2 ndc = (vec2(px) + 0.5) / u_pcScreen * 2.0 - 1.0;
  return (u_pcRayCenter + u_pcRayRight * ndc.x + u_pcRayUp * ndc.y) * z;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float z = sceneDistance(px);
  if (z > u_pcRangeM.y) discard;
  vec3 p = sceneAt(px, z);
  // The normal from the neighbours, on each axis from the side nearer in depth (no false slopes at edges).
  ivec2 size = ivec2(u_pcScreen) - 1;
  ivec2 xl = ivec2(max(px.x - 1, 0), px.y), xr = ivec2(min(px.x + 1, size.x), px.y);
  ivec2 yd = ivec2(px.x, max(px.y - 1, 0)), yu = ivec2(px.x, min(px.y + 1, size.y));
  float zl = sceneDistance(xl), zr = sceneDistance(xr), zd = sceneDistance(yd), zu = sceneDistance(yu);
  vec3 dx = abs(zr - z) < abs(z - zl) ? sceneAt(xr, zr) - p : p - sceneAt(xl, zl);
  vec3 dy = abs(zu - z) < abs(z - zd) ? sceneAt(yu, zu) - p : p - sceneAt(yd, zd);
  vec3 n = cross(dx, dy);
  float nl = length(n);
  if (!(nl > 0.0)) discard;
  n /= nl;
  if (dot(n, p) > 0.0) n = -n;
  vec3 world = u_pcEye + p;
  vec3 up = localUp(world);
  float facing = smoothstep(0.8, 0.94, dot(n, up));
  if (facing <= 0.0) discard;
  float fade = facing * (1.0 - smoothstep(u_pcRangeM.x, u_pcRangeM.y, z));
  float fp = max(u_camRight.w * z, 1e-5); // metres per pixel there
  vec3 q = p + u_pcImpactOffset;
  vec2 ab;
  vec3 nn;
  if (u_pcAxis == 0) { ab = q.yz; nn = n.yzx; }
  else if (u_pcAxis == 1) { ab = q.xz; nn = n.xzy; }
  else { ab = q.xy; nn = n.xyz; }
  float a = 0.0;
  vec3 col;
  if (u_pcLook.x < 0.5) {
    // Spray and rings catch the sky's light: brighter than the fog, never brighter than the light there is.
    vec3 rain = min(max(u_fogColor.rgb * 1.35, toDisplay((u_ambient.rgb + u_skyFill.rgb) * 1.8)), vec3(1.0));
    // A splash: a small bright fleck of spray that opens and is gone in a fraction of a second.
    vec3 m = precipitationImpact(ab, nn, u_pcSpecA, uint(u_pcSeedA), u_pcClocks.xy);
    if (m.x >= 0.0) {
      float R = u_pcSpecA.z * (0.35 + 0.65 * sqrt(m.x));
      float soft = max(0.5 * R, 0.7 * fp);
      float fleck = (1.0 - smoothstep(0.2 * R, R + soft * 0.5, m.y)) * min(1.0, R / max(R, 1.2 * fp));
      a += m.z * (1.0 - m.x) * (1.0 - m.x) * fleck * smoothstep(0.4, 1.2, R / fp);
    }
    // A ring on the water standing on the ground: it widens and fades.
    vec3 r = precipitationImpact(ab, nn, u_pcSpecB, uint(u_pcSeedB), u_pcClocks.zw);
    if (r.x >= 0.0 && u_pcLook.w > 0.0) {
      float R = u_pcSpecB.z * (0.15 + 0.85 * sqrt(r.x));
      float w = max(0.005, 1.0 * fp);
      float line = (1.0 - smoothstep(0.0, w, abs(r.y - R))) * min(1.0, 0.005 / w * 1.5);
      a += u_pcLook.w * r.z * (1.0 - r.x) * (1.0 - r.x) * line * smoothstep(2.0, 5.0, R / fp) * 0.3;
    }
    col = rain;
  } else {
    // A speck of snow where a flake landed: there at once, fading over its life.
    vec3 m = precipitationImpact(ab, nn, u_pcSpecA, uint(u_pcSeedA), u_pcClocks.xy);
    if (m.x >= 0.0) {
      float r = max(u_pcSpecA.z, 0.9 * fp);
      float disc = (1.0 - smoothstep(0.35 * r, r, m.y)) * min(1.0, (u_pcSpecA.z / r) * (u_pcSpecA.z / r));
      a += m.z * smoothstep(0.0, 0.04, m.x) * pow(1.0 - m.x, 1.3) * disc * (1.0 - 0.7 * u_weather.x);
    }
    col = toDisplay(u_snow.rgb * lightOnAt(world, up, u_pcLook.z, 1.0));
  }
  a = clamp(a * fade * u_pcLook.y, 0.0, 0.95);
  if (a < 0.002) discard;
  o_color = vec4(col * a, a);
}`;
