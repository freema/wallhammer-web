// The water's material: one shader for the sea, the lakes and the running water, because they are one surface.
//
// What the picture is made of, all of it in the fragment shader of a single blended draw:
//   - the water's own colour, more of it the longer the sight runs through the water to the bed (so a shallow shows
//     its bed and a deep is dark), lit by the sun and the sky and shadowed by the shadow map;
//   - the mirror of the sky by Fresnel and a glint of the sun, on small waves: slow ones where the water stands,
//     waves carried along the stream where it runs. The stream is two layers of the same waves, each carried for a
//     few seconds and faded out before it is set back, so nothing stretches and nothing jumps;
//   - white water from the slope of the sheet itself: a veil with falling streaks where the sheet hangs (a fall),
//     clumps of foam carried by the stream where it runs steeply (rapids) and under a fall;
//   - a breathing line of foam where the sea meets its shore.
//
// Vertex layout (`WATER_LAYOUT` in water-mesh.ts, locations `WATER_ATTRIBS`):
//   a_pos    vec3  world position, metres
//   a_water  vec3  x depth (level − ground, metres; ≤ −0.01 on a dry vertex of a drawn cell, so it crosses 0 near the
//                  shoreline), y, z the unit direction the water runs (0, 0 in standing water)
//   a_kind   vec4  x body (0 sea, 1 lake, 2 line), y 1 on a fall, z 0–255 how near the foot of a fall the water is
//
// Uniforms: none of its own. The Frame block has the rest, among it `u_time.x`, the animation time in seconds
// (frozen by `__wh.setTime(s)`).
//
// Draw state: blended over what is behind, no depth write, both faces, no shadow pass. The layer is added after the
// ground, so the ground is in the depth buffer when the water draws and cuts the shoreline.

import type { MaterialDesc } from 'wallhammer-web/base';
import { WATER_ATTRIBS } from './water-mesh.ts';

const VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_water;
in vec4 a_kind;
out vec3 v_world;
out float v_depth;
out vec2 v_flow;
out vec3 v_kind;
void main() {
  v_world = a_pos;
  v_depth = a_water.x;
  v_flow = a_water.yz;
  v_kind = vec3(a_kind.xy, a_kind.z / 255.0);
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in float v_depth;
in vec2 v_flow;
in vec3 v_kind;
out vec4 o_color;

// Seconds one layer of the stream's waves is carried before it is set back.
const float CARRY_S = 2.4;

// The tilt of small waves over a point of the plane: two values around 0.
vec2 tilt(vec2 p, float cellM, uint seed) {
  vec2 q = p / cellM;
  return vec2(vnoise(q, seed), vnoise(q + 37.3, seed + 1u)) - 0.5;
}

void main() {
  float t = u_time.x;
  vec3 toEye = skyToEye(v_world);
  float d = max(v_depth, 0.0);

  // The slope of the sheet itself: level where the water stands, a few per cent where it runs, steep on a fall.
  vec3 gn = normalize(cross(dFdx(v_world), dFdy(v_world)));
  if (gn.y < 0.0) gn = -gn;
  float grade = length(gn.xz) / max(gn.y, 0.05);
  // Only a declared fall hangs as a veil; a small step in the sheet anywhere else is fast water.
  float sheet = smoothstep(0.6, 1.6, grade) * smoothstep(0.15, 0.6, v_kind.y);

  // How much the water runs here, and where to.
  float running = min(length(v_flow), 1.0);
  vec2 dir = v_flow / max(length(v_flow), 1e-4);
  float sea = 1.0 - smoothstep(0.0, 0.6, v_kind.x);
  float speed = running * (0.9 + 6.0 * min(grade, 0.5));
  float ph0 = fract(t / CARRY_S);
  float ph1 = fract(t / CARRY_S + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 p0 = v_world.xz - dir * speed * CARRY_S * (ph0 - 0.5);
  vec2 p1 = v_world.xz - dir * speed * CARRY_S * (ph1 - 0.5) + 23.7;

  // Small waves. Each scale fades out before its cells reach a pixel, so far water is a clean mirror.
  vec2 still = tilt(v_world.xz + t * vec2(0.35, 0.2), 1.7, 41u) * 0.05 * detailVisibleAt(4.0, v_world)
    + tilt(v_world.xz - t * vec2(0.22, 0.31), 5.5, 43u) * 0.06 * detailVisibleAt(11.0, v_world)
    + tilt(v_world.xz + t * vec2(0.9, 0.5), 24.0, 45u) * 0.08 * sea * detailVisibleAt(24.0, v_world);
  vec2 stream = mix(tilt(p1, 0.9, 47u), tilt(p0, 0.9, 47u), w0) * 0.15 * detailVisibleAt(2.2, v_world)
    + mix(tilt(p1, 2.8, 49u), tilt(p0, 2.8, 49u), w0) * 0.12 * detailVisibleAt(5.6, v_world);
  vec2 rip = still * (1.0 - 0.7 * running) + stream * running * (1.0 + 2.0 * min(grade, 0.3));
  // Seen along the surface a wave hides its far side, so the waves flatten toward the horizon.
  rip *= 0.3 + 0.7 * smoothstep(0.0, 0.5, toEye.y);
  vec3 n = normalize(gn + vec3(rip.x, 0.0, rip.y));

  // The water's own colour, by the length of the sight through it down to the bed (the sight bends at the surface).
  float cosIn = sqrt(1.0 - (1.0 - toEye.y * toEye.y) / 1.77);
  float path = d / max(cosIn, 0.3);
  vec3 body = mix(vec3(0.07, 0.22, 0.2), vec3(0.03, 0.14, 0.24), smoothstep(0.3, 4.0, d));
  body = mix(body, vec3(0.02, 0.12, 0.27), sea * smoothstep(2.0, 18.0, d));
  float sun = sunVisibility(v_world, vec3(0.0, 1.0, 0.0), 1.0);
  vec3 c = toDisplay(body * u_warmTint.rgb * lightOn(vec3(0.0, 1.0, 0.0), sun, 1.0));
  float alpha = 1.0 - exp(-path * 1.5);

  // The mirror of the sky and the glint of the sun.
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, toEye), 0.0), 5.0);
  vec3 up = reflect(-toEye, n);
  up.y = abs(up.y);
  c = mix(c, skyColorDir(up), fres);
  alpha = 1.0 - (1.0 - alpha) * (1.0 - fres);
  float glint = pow(max(dot(reflect(-u_sunDir.xyz, n), toEye), 0.0), 140.0) * sun;
  c += min(u_sunColor.rgb, vec3(1.0)) * glint * 0.55;
  alpha = max(alpha, min(glint, 1.0));

  // White water. The veil of a fall: streaks that fall, finer ones over broader ones.
  float broad = vnoise3(vec3(v_world.x / 0.9, (v_world.y + t * 6.0) / 9.0, v_world.z / 0.9), 51u);
  float mid = vnoise3(vec3(v_world.x / 0.33, (v_world.y + t * 7.5) / 4.5, v_world.z / 0.33), 53u);
  float fine = vnoise3(vec3(v_world.x / 0.12, (v_world.y + t * 9.5) / 2.2, v_world.z / 0.12), 54u);
  float streaks = 0.4 * broad + 0.35 * mid + 0.25 * fine;
  // A full veil where the water over the lip is deep; toward its sides it thins into separate strings.
  float full = smoothstep(0.0, 0.45, v_depth);
  float veil = sheet * mix(smoothstep(0.42, 0.7, streaks), 0.5 + 0.5 * smoothstep(0.2, 0.8, streaks), full);
  // Foam carried by the stream: on steep running water and in the pool under a fall.
  float churn = v_kind.z;
  float rough = max(running * smoothstep(0.03, 0.24, grade), churn);
  float clumps = 0.4 * mix(vnoise(p1 / 0.45, 55u), vnoise(p0 / 0.45, 55u), w0)
    + 0.35 * mix(vnoise(p1 / 1.3, 56u), vnoise(p0 / 1.3, 56u), w0)
    + 0.25 * mix(vnoise(p1 / 3.4, 57u), vnoise(p0 / 3.4, 57u), w0);
  float limit = mix(0.95, 0.28, rough);
  float foam = smoothstep(limit, limit + 0.3, clumps);
  // Right under the fall the water boils white; the boil breaks into the clumps as it leaves.
  foam = max(foam, smoothstep(0.5, 0.85, churn + 0.5 * (clumps - 0.5))) * (1.0 - sheet);
  // The sea's edge: a line of foam that comes and goes.
  float swash = 0.5 + 0.5 * sin(t * 0.7 + vnoise(v_world.xz / 18.0, 59u) * 6.2832);
  float lace = 0.6 + 0.4 * vnoise(v_world.xz / 0.9 + t * 0.2, 61u);
  float edge = sea * (1.0 - smoothstep(0.0, 0.1 + 0.32 * swash, d)) * lace;
  float white = max(veil, max(foam, 0.85 * edge));
  // White water is full of air and passes light on: in a shadow it is still lit a little from behind.
  vec3 whiteLit = toDisplay(vec3(0.84, 0.88, 0.9) * lightOn(normalize(gn + vec3(0.0, 0.6, 0.0)), max(sun, 0.3), 1.0));
  c = mix(c, whiteLit, white);
  alpha = max(alpha, 0.96 * white);

  // A dry vertex of a drawn cell lies under the bank; where the bank is missing (beside a fall) the sheet ends.
  alpha *= smoothstep(-0.012, 0.0, v_depth);
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), alpha);
}`;

export const WATER_MATERIAL: MaterialDesc = {
  name: 'water',
  attribs: WATER_ATTRIBS,
  passes: { color: { vs: VS, fs: FS } },
  state: { color: { blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, depthWrite: false, cullBack: false } },
};
