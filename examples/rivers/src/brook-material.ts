// The brooks' two materials, for the strips of brook-mesh.ts (`STRIP_LAYOUT`, locations `STRIP_ATTRIBS`).
//
//   - The bed: silt and gravel under the water; on the banks damp grass reaching down to a ragged line of its own on
//     each bank, earth only in patches, a darker cut on the outside of a bend and a bar of pale gravel on the inside
//     (the bend comes in `a_strip.w`, brook-mesh.ts). Above the grass line the strip fades out and the ground's own
//     grass shows. Lit by the sun and the sky, shadowed by the shadow map; blended, and it writes depth.
//   - The water: clear and shallow, of the lines' colour, so the bed shows through it; tinted deeper only in the middle
//     of a wide level stretch (a pool), and over the last metres before a mouth it takes the look of the water it runs
//     into. The mirror of the sky, the glint of the sun and small ripples drawn out along the flow, carried down
//     the brook along the strip's metres, two layers each faded out before it is set back (the lines' trick); short
//     white streaks only where it runs steeply (a riffle). Far away, where a strip is about a pixel wide, it takes
//     plain up for its normal, so no glints come and go along it. Its edge is ragged. Blended, no depth write.
//   - Both fade out past a mouth, under the water of the line, the lake or the sea they run into, and past where a
//     tributary reaches its stem's water (the fade comes in `a_coarseShift`, brook-mesh.ts), so no end of a brook is
//     ever seen.
//
// Both widen a strip that would be narrower than about a pixel (`stripWiden` of the engine), so a far brook stays an
// unbroken thin line. Uniforms: none of their own; `u_time.x` is the animation time (frozen by `__wh.setTime(s)`).

import type { MaterialDesc } from 'wallhammer-web/base';
import { STRIP_ATTRIBS, STRIP_GLSL } from 'wallhammer-web/gen-mesh';

const VS = (minPx: number): string => /* glsl */ `#include <header>
#include <noise>
${STRIP_GLSL}
in vec3 a_pos;
in float a_coarseShift;
in vec3 a_side;
in vec4 a_strip;
out vec3 v_world;
out vec4 v_strip;
out float v_fade;
out float v_grade;
void main() {
  float grow;
  // brook-mesh.ts keeps the grade of the water along the brook in the side's up component: the side itself is level.
  vec3 p = stripWiden(a_pos, vec3(a_side.x, 0.0, a_side.z), a_strip, ${minPx.toFixed(1)}, grow);
  v_grade = a_side.y;
  v_world = p;
  v_strip = a_strip;
  // brook-mesh.ts writes, where the engine's layout keeps its coarse shift, how far the strip has faded out past a mouth
  // or a tributary's entry (0 to 1), and before a mouth how far its water has taken the colour of the water it runs
  // into (−1 none, 0 all). A tributary's runs 2 to 3: it fades out under its stem's water with its own look.
  v_fade = a_coarseShift;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const BED_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec4 v_strip;
in float v_fade;
out vec4 o_color;

// The ground's damp grass (LUSH of ground-mesh.ts), and what the bank and the bed are made of.
const vec3 GRASS = vec3(0.2, 0.36, 0.11);
const vec3 EARTH = vec3(0.34, 0.26, 0.16);
const vec3 CUT = vec3(0.22, 0.165, 0.1);
const vec3 SILT = vec3(0.3, 0.27, 0.2);
const vec3 GRAVEL = vec3(0.5, 0.46, 0.38);

void main() {
  vec3 n = normalize(cross(dFdx(v_world), dFdy(v_world)));
  if (n.y < 0.0) n = -n;
  float a = abs(v_strip.x);
  // The strip lies on the ground's triangles; under the water they would show as lit facets, so the bed there is
  // lit as level. The banks keep the ground's own facets.
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, smoothstep(0.4, 0.6, a)));
  float along = v_strip.y;
  // Each bank on its own: the side's sign shifts the noise.
  float bankKey = v_strip.x < 0.0 ? 0.0 : 57.0;
  float inner = smoothstep(0.015, 0.09, v_strip.w);
  float outer = smoothstep(0.015, 0.09, -v_strip.w);
  float g1 = vnoise(vec2(along / 2.6, bankKey), 91u);
  float g2 = vnoise(vec2(along / 0.55, bankKey + 13.0), 92u) * detailVisibleAt(0.4, v_world);
  float grain = 0.5 * vnoise(v_world.xz / 1.9, 71u) + 0.3 * vnoise(v_world.xz / 0.5, 72u) * detailVisibleAt(0.5, v_world)
    + 0.2 * vnoise(v_world.xz / 0.13, 73u) * detailVisibleAt(0.13, v_world);

  // How far down the bank the grass reaches, in half-widths: a ragged line, lower where it is not cut, higher on the
  // outside of a bend, held back by a bar of gravel on the inside.
  float grassLine = 0.6 + 0.24 * (g1 - 0.5) + 0.1 * (g2 - 0.5) + 0.08 * outer + 0.12 * inner;
  // Bare earth only in patches, more of it on the outside of a bend, with a sharp edge.
  float patches = smoothstep(0.62, 0.66, vnoise(vec2(along / 1.3, bankKey + a * 3.0), 93u) + 0.25 * outer);

  // The bed: silt and gravel, pebbles lighter; seen through the water, so soft.
  float stones = smoothstep(0.5, 0.8, vnoise(v_world.xz / 0.06, 74u)) * detailVisibleAt(0.06, v_world);
  vec3 bed = mix(SILT, GRAVEL, 0.25 * grain + 0.3 * stones);
  // A bar of pale gravel on the inside of a bend, from the water up.
  float bar = inner * (1.0 - smoothstep(grassLine - 0.05, grassLine + 0.05, a)) * smoothstep(0.35, 0.5, a);
  // Before a mouth the banks come down to the water: no earth, no bar of gravel stands out there.
  float toRiver = v_fade > 1.5 ? 0.0 : clamp(v_fade + 1.0, 0.0, 1.0);
  patches *= 1.0 - toRiver;
  bar *= 1.0 - toRiver;
  // The bank under the grass line: damp grass, earth in patches, a darker cut on the outside of a bend, the bar.
  float bankSide = smoothstep(0.5, 0.6, a);
  vec3 bank = mix(mix(GRASS * 0.85, mix(EARTH, CUT, outer), patches), GRAVEL * (0.9 + 0.2 * grain), bar);
  vec3 col = mix(bed, bank, bankSide);
  col *= mix(0.92 + 0.16 * grain, 0.85 + 0.3 * grain, bankSide);
  // Above the grass line the bank is the ground's own grass: this strip fades out there, raggedly but sharply.
  float alpha = 1.0 - smoothstep(grassLine - 0.02, grassLine + 0.03, a);
  // Where earth or gravel shows, it reaches a little higher.
  alpha = max(alpha, (patches * 0.8 + bar) * (1.0 - smoothstep(grassLine + 0.03, grassLine + 0.07, a)));
  col = mix(col, GRASS, smoothstep(grassLine - 0.06, grassLine + 0.02, a) * (1.0 - max(patches, bar)));
  // Past a mouth, under the water it runs into, the bed fades out; what is gone writes no depth.
  alpha *= 1.0 - (v_fade > 1.5 ? v_fade - 2.0 : max(v_fade, 0.0));
  if (alpha < 0.01) discard;
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), alpha);
}`;

const WATER_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec4 v_strip;
in float v_fade;
in float v_grade;
out vec4 o_color;

// Seconds one layer of the waves is carried before it is set back.
const float CARRY_S = 1.4;

vec2 tilt(vec2 p, float cellM, uint seed) {
  vec2 q = p / cellM;
  return vec2(vnoise(q, seed), vnoise(q + 37.3, seed + 1u)) - 0.5;
}

void main() {
  float t = u_time.x;
  vec3 toEye = skyToEye(v_world);
  // The strip lies on the ground's triangles, which would show as facets in the mirror: the water is level but for
  // its ripples. Its grade along the brook comes smooth between its stations (brook-mesh.ts). Far away, where a
  // strip is a pixel or two wide, no ripples (no glints that come and go along a far brook).
  float near = detailVisibleAt(0.6, v_world);
  vec3 gn = vec3(0.0, 1.0, 0.0);
  float grade = v_grade;
  // Before a mouth it takes the look of the water it runs into: calm, deeper, the mirror of the sky.
  float toRiver = v_fade > 1.5 ? 0.0 : clamp(v_fade + 1.0, 0.0, 1.0);
  float riffle = smoothstep(0.04, 0.14, grade) * (1.0 - toRiver);
  float a = abs(v_strip.x);
  float hw = v_strip.z;
  float along = v_strip.y;
  // Across in metres from the middle, along in metres downstream.
  vec2 q = vec2(v_strip.x * hw, along);
  float speed = 0.6 + 6.0 * min(grade, 0.4);
  float ph0 = fract(t / CARRY_S);
  float ph1 = fract(t / CARRY_S + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 p0 = q - vec2(0.0, speed * CARRY_S * (ph0 - 0.5));
  vec2 p1 = q - vec2(0.0, speed * CARRY_S * (ph1 - 0.5)) + 23.7;
  // Small soft ripples, drawn out along the flow (the lines' waves, finer).
  vec2 s = vec2(1.0, 0.4);
  vec2 rip = mix(tilt(p1 * s, 0.35, 81u), tilt(p0 * s, 0.35, 81u), w0) * 0.07 * detailVisibleAt(0.5, v_world)
    + mix(tilt(p1 * s, 0.9, 83u), tilt(p0 * s, 0.9, 83u), w0) * 0.06 * detailVisibleAt(1.2, v_world);
  rip *= 1.0 + 2.0 * riffle;
  // Seen along the surface a wave hides its far side, so the ripples flatten toward the horizon.
  rip *= 0.3 + 0.7 * smoothstep(0.0, 0.5, toEye.y);
  vec3 n = normalize(gn + vec3(rip.x, 0.0, rip.y));

  // Depth: shallow over most of the bed, deeper in the middle of a wide level stretch (a pool), little on a riffle.
  float pool = max((1.0 - riffle) * smoothstep(0.7, 1.6, hw), toRiver);
  float d = (0.05 + 0.1 * pool) * (1.0 - smoothstep(0.15, 1.0, a)) + 0.015 + 0.25 * toRiver;
  float cosIn = sqrt(1.0 - (1.0 - toEye.y * toEye.y) / 1.77);
  float path = d / max(cosIn, 0.25);
  // Clear water of the lines' colour (water-material.ts, its shallows): the bed shows through; a pool's depth tints it.
  vec3 body = vec3(0.07, 0.22, 0.2);
  float sun = sunVisibility(v_world, vec3(0.0, 1.0, 0.0), 1.0);
  vec3 c = toDisplay(body * u_warmTint.rgb * lightOn(vec3(0.0, 1.0, 0.0), sun, 1.0));
  float alpha = 1.0 - exp(-path * mix(3.0, 1.5, toRiver));

  // The mirror of the sky, a little weaker than the lines' (the bed shows even at a low angle), all of it at a mouth.
  float fres = 0.02 + mix(0.8, 0.98, toRiver) * pow(1.0 - max(dot(n, toEye), 0.0), 5.0);
  vec3 up = reflect(-toEye, n);
  up.y = abs(up.y);
  // The body's colour over its own share, the sky's mirror over the rest: composed, then divided by the alpha.
  float a2 = 1.0 - (1.0 - alpha) * (1.0 - fres);
  c = (c * alpha * (1.0 - fres) + skyColorDir(up) * fres) / max(a2, 1e-3);
  alpha = a2;
  float glint = pow(max(dot(reflect(-u_sunDir.xyz, n), toEye), 0.0), 160.0) * sun * near;
  c += min(u_sunColor.rgb, vec3(1.0)) * glint * 0.5;
  alpha = max(alpha, min(glint, 1.0));

  // White streaks only on a riffle: short, drawn out along the flow, carried down it.
  float streak = 0.5 * mix(vnoise(vec2(p1.x / 0.07, p1.y / 0.6), 85u), vnoise(vec2(p0.x / 0.07, p0.y / 0.6), 85u), w0)
    + 0.5 * mix(vnoise(vec2(p1.x / 0.15, p1.y / 1.1), 86u), vnoise(vec2(p0.x / 0.15, p0.y / 1.1), 86u), w0);
  float foam = riffle * smoothstep(0.66, 0.8, streak) * (1.0 - smoothstep(0.5, 0.85, a)) * detailVisibleAt(0.3, v_world);
  vec3 whiteLit = toDisplay(vec3(0.82, 0.86, 0.88) * lightOn(normalize(gn + vec3(0.0, 0.6, 0.0)), max(sun, 0.3), 1.0));
  c = mix(c, whiteLit, foam);
  alpha = max(alpha, 0.85 * foam);

  // A ragged edge, where the water runs out under the grass and over the gravel.
  float edge = 0.9 - 0.14 * vnoise(vec2(along / 1.1, v_strip.x < 0.0 ? 0.0 : 31.0), 87u);
  alpha *= 1.0 - smoothstep(edge - 0.1, edge, a);
  // Past a mouth, under the water it runs into, it fades out.
  alpha *= 1.0 - (v_fade > 1.5 ? v_fade - 2.0 : max(v_fade, 0.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), alpha);
}`;

export const BROOK_BED_MATERIAL: MaterialDesc = {
  name: 'brook-bed',
  attribs: STRIP_ATTRIBS,
  passes: { color: { vs: VS(1.0), fs: BED_FS } },
  state: { color: { blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, depthWrite: true, cullBack: false } },
};

export const BROOK_WATER_MATERIAL: MaterialDesc = {
  name: 'brook-water',
  attribs: STRIP_ATTRIBS,
  passes: { color: { vs: VS(1.2), fs: WATER_FS } },
  state: { color: { blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, depthWrite: false, cullBack: false } },
};
