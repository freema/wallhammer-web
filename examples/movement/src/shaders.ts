// Materials of the test course. Every lit program starts with the engine's header and lighting, so sun, sky, shadows
// and fog come from the environment, and ends with `aerialPerspective`. Seven materials:
//   - ground: the base surface with a metre grid (every fifth line stronger), so gaps and heights can be read off; the
//     patches of loose ground (course.ts `LOOSE_PATCHES`) bare earth
//   - solid: the solids of the collision world, flat-shaded in the colour of their station
//   - figure: the box figure (`figure=boxes`), parts of the engine's instance set (`INSTANCE_SET_GLSL`), a moving
//     shadow caster
//   - pathfinder: the shared pathfinder figure (the default), its vertices with a colour and a material each (plain,
//     tinted by the part's colour slot, or a light: the lantern's glass)
//   - wire: the debugging wireframe of the solids, one colour per layer, pulled a little toward the eye
//   - car: the cars (examples/shared vehicles/compact.ts), the figure's vertex layout with the car's materials: paint
//     tinted per car with a sun highlight, glass that reflects the sky, lamps lit by a per-car number (braking,
//     reversing); drawn from both sides, the inside of the shell dark (seen through an open door)
//   - traces: the marks on the ground (the engine's contact trail, src/traces.ts), one look per kind of
//     trace-kinds.ts: dark tyre streaks, ruts, boot soles and hoof prints, faint on grass and deep on loose
//     ground (blended over the ground)

import type { MaterialDesc } from 'wallhammer-web/base';
import { DEPTH_FS, INSTANCE_SET_GLSL, contactTrailMaterial, instanceSetAttribs } from 'wallhammer-web/render';
import { COURSE_SIZE_M, LOOSE_PATCHES } from './course.ts';

/** The loose patches as GLSL: a function of how far inside one a point lies (negative outside). */
const LOOSE_GLSL = /* glsl */ `
float looseInside(vec2 p) {
  float best = -1e4;
${LOOSE_PATCHES.map((r) => `  best = max(best, -max(max(${r[0].toFixed(2)} - p.x, p.x - ${r[2].toFixed(2)}), max(${r[1].toFixed(2)} - p.y, p.y - ${r[3].toFixed(2)})));`).join('\n')}
  return best;
}`;

const GROUND_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec4 a_normal;
out vec3 v_world;
out vec3 v_normal;
void main() {
  v_world = a_pos;
  v_normal = a_normal.xyz;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const GROUND_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
out vec4 o_color;
${LOOSE_GLSL}
// Antialiased grid line every 'every' metres, 'width' in pixels.
float gridLine(vec2 p, float every, float width) {
  vec2 g = p / every;
  vec2 w = fwidth(g) * width;
  vec2 d = abs(fract(g - 0.5) - 0.5);
  vec2 l = 1.0 - smoothstep(w * 0.5, w, d);
  return max(l.x, l.y);
}
void main() {
  vec3 n = normalize(v_normal);
  float patchN = vnoise(v_world.xz / 7.0, 11u) * 0.6 + vnoise(v_world.xz / 1.9, 12u) * 0.4 * detailVisibleAt(1.9, v_world);
  vec3 meadow = mix(vec3(0.34, 0.42, 0.27), vec3(0.45, 0.5, 0.33), patchN);
  vec3 earth = mix(vec3(0.5, 0.42, 0.32), vec3(0.58, 0.5, 0.38), patchN);
  vec3 col = mix(earth, meadow, smoothstep(0.7, 0.85, n.y));
  // Loose ground: bare, grainy earth with a ragged edge.
  float rag = 0.35 * (vnoise(v_world.xz * 0.9, 13u) - 0.5) + 0.15 * (vnoise(v_world.xz * 3.1, 14u) - 0.5);
  float loose = smoothstep(-0.25, 0.25, looseInside(v_world.xz) + rag);
  vec3 bare = mix(vec3(0.5, 0.41, 0.3), vec3(0.6, 0.5, 0.37), patchN) * (0.9 + 0.2 * vnoise(v_world.xz * 7.0, 15u) * detailVisibleAt(0.15, v_world));
  col = mix(col, bare, loose);
  // The grid fades out where its lines would be thinner than a pixel apart; only on the course, not the land round it.
  float course = step(-0.01, min(min(v_world.x, v_world.z), ${COURSE_SIZE_M.toFixed(1)} - max(v_world.x, v_world.z)));
  float fine = gridLine(v_world.xz, 1.0, 1.2) * detailVisibleAt(1.0, v_world) * course;
  float coarse = gridLine(v_world.xz, 5.0, 1.6) * detailVisibleAt(5.0, v_world) * course;
  col = mix(col, col * 0.72, 0.55 * fine);
  col = mix(col, vec3(0.92, 0.9, 0.82), 0.45 * coarse);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const SOLID_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_color;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
void main() {
  v_world = a_pos;
  v_normal = a_normal;
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const SOLID_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float grain = vnoise(v_world.xz * 1.3 + v_world.y * 2.1, 21u) * detailVisibleAt(0.8, v_world);
  vec3 col = v_color * (0.9 + 0.16 * grain);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const FIGURE_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
${INSTANCE_SET_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
void main() {
  vec3 w = instancePoint(a_pos);
  v_world = w;
  v_normal = instanceNormal(a_normal);
  v_color = i_extra.rgb;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

const FIGURE_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
${INSTANCE_SET_GLSL}
void main() {
  gl_Position = u_lightRender * vec4(instancePoint(a_pos), 1.0);
}`;

const FIGURE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 0.6);
  // A soft rim toward the eye, so the figure reads against the ground.
  float rim = pow(1.0 - max(dot(n, skyToEye(v_world)), 0.0), 3.0) * 0.25;
  vec3 c = toDisplay(v_color * u_warmTint.rgb * lightOn(n, sun, 1.0)) + rim;
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const PATHFINDER_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec4 a_color; // rgb colour, w material: 0 plain, 1 times the instance's tint, 2 a light
${INSTANCE_SET_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_material;
void main() {
  vec3 w = instancePoint(a_pos);
  v_world = w;
  v_normal = instanceNormal(a_normal);
  v_color = a_color.w > 0.5 && a_color.w < 1.5 ? a_color.rgb * i_extra.rgb : a_color.rgb;
  v_material = a_color.w;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

const PATHFINDER_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_material;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 0.6);
  vec3 lit = v_color * u_warmTint.rgb * lightOn(n, sun, 1.0);
  // The lantern's glass glows.
  if (v_material > 1.5) lit = mix(lit, v_color * 2.2, 0.6);
  o_color = vec4(aerialPerspective(applyFog(toDisplay(lit), v_world), v_world), 1.0);
}`;

const CAR_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec4 a_color; // rgb colour, w material: 0 plain, 1 paint, 2 glass, 3 head lamp, 4 tail lamp, 5 reversing lamp
${INSTANCE_SET_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_material;
out vec4 v_extra;
void main() {
  vec3 w = instancePoint(a_pos);
  v_world = w;
  v_normal = instanceNormal(a_normal);
  v_color = a_color.rgb;
  v_material = a_color.w;
  v_extra = i_extra;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

const CAR_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_material;
in vec4 v_extra; // rgb the paint, w the lamps: brake 0-1, plus 2 while reversing
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  int m = int(v_material + 0.5);
  vec3 toEye = skyToEye(v_world);
  if (dot(n, toEye) < 0.0) {
    // The inside of the shell and of the doors (the faces are drawn from both sides; mirrored copies too): grey trim.
    vec3 lit = vec3(0.2, 0.19, 0.18) * u_warmTint.rgb * lightOn(-n, sunVisibility(v_world, -n, 0.6), 0.8);
    o_color = vec4(aerialPerspective(applyFog(toDisplay(lit), v_world), v_world), 1.0);
    return;
  }
  vec3 r = reflect(-toEye, n);
  float sun = sunVisibility(v_world, n, 0.6);
  float fres = pow(1.0 - max(dot(n, toEye), 0.0), 4.0);
  float spec = pow(max(dot(r, u_sunDir.xyz), 0.0), 60.0) * sun;
  vec3 base = m == 1 ? v_color * v_extra.rgb : v_color;
  vec3 lit = base * u_warmTint.rgb * lightOn(n, sun, 1.0);
  float reversing = step(1.5, v_extra.w);
  float brake = clamp(v_extra.w - 2.0 * reversing, 0.0, 1.0);
  if (m == 1) {
    // Paint: a glossy coat that mirrors a little of the sky at grazing angles and catches the sun.
    lit = mix(lit, skyColorDir(r) * 0.85, 0.08 + 0.3 * fres) + u_sunColor.rgb * spec * 0.5;
  } else if (m == 2) {
    // Glass: dark, the sky in it toward grazing angles, a sharp sun glint.
    vec3 inside = v_color * u_warmTint.rgb * lightOn(n, sun, 1.0) * 0.5;
    lit = mix(inside, skyColorDir(r) * 0.9, 0.18 + 0.55 * fres) + u_sunColor.rgb * pow(max(dot(r, u_sunDir.xyz), 0.0), 200.0) * sun * 2.0;
  } else if (m == 3) {
    lit = mix(lit, v_color * 1.3, 0.55) + u_sunColor.rgb * spec * 0.6;
  } else if (m == 4) {
    lit = mix(lit, v_color * (0.7 + 2.6 * brake), 0.45 + 0.45 * brake) + u_sunColor.rgb * spec * 0.4;
  } else if (m == 5) {
    lit = mix(lit, v_color * 2.2, 0.85 * reversing) + u_sunColor.rgb * spec * 0.4;
  }
  o_color = vec4(aerialPerspective(applyFog(toDisplay(lit), v_world), v_world), 1.0);
}`;

/** How each kind of trace-kinds.ts looks: `trailShade` for the engine's contact trail material. */
const TRACE_SHADE = /* glsl */ `
float traceOval(vec2 p, vec2 c, vec2 r) {
  return 1.0 - smoothstep(0.8, 1.0, length((p - c) / r));
}
vec4 trailShade(vec2 uv, float kind, float seed, vec3 world, vec3 n) {
  int k = int(kind + 0.5);
  float grain = vnoise(world.xz * 9.0, 31u);
  vec3 col;
  float a;
  if (k == 0) {
    // A sliding tyre: soft along the width, the rubber a little uneven.
    col = vec3(0.035);
    a = 0.62 * (1.0 - smoothstep(0.32, 0.5, abs(uv.x - 0.5))) * (0.75 + 0.25 * grain);
  } else if (k == 1) {
    // A rut in loose ground: darker, packed earth with a tread across.
    float tread = 0.82 + 0.18 * step(0.5, fract(uv.y * 3.0 + seed));
    col = vec3(0.28, 0.22, 0.15) * tread;
    a = 0.5 * (1.0 - smoothstep(0.3, 0.5, abs(uv.x - 0.5))) * (0.8 + 0.2 * grain);
  } else if (k <= 3) {
    // A boot sole: the ball and toes in front, the heel behind, a narrower waist between, lugs across.
    float sole = max(traceOval(uv, vec2(0.5, 0.66), vec2(0.46, 0.33)), traceOval(uv, vec2(0.5, 0.19), vec2(0.4, 0.19)));
    sole = max(sole, traceOval(uv, vec2(0.5, 0.42), vec2(0.3, 0.3)));
    float lug = 0.78 + 0.22 * step(0.5, fract(uv.y * 7.0));
    if (k == 2) {
      col = vec3(0.1, 0.14, 0.06) * lug;
      a = 0.45 * sole;
    } else {
      col = vec3(0.25, 0.19, 0.13) * lug;
      a = 0.78 * sole * (0.85 + 0.15 * grain);
    }
  } else {
    // A hoof: a rounded print, deeper at its wall, the frog a V open to the back.
    vec2 q = (uv - 0.5) * 2.0;
    float d = length(q);
    float fill = 1.0 - smoothstep(0.8, 1.0, d);
    float wall = smoothstep(0.45, 0.78, d);
    float frog = (1.0 - smoothstep(0.0, 0.08, abs(q.x) - 0.45 * (0.2 - q.y))) * step(q.y, 0.2);
    float deep = fill * mix(0.5, 1.0, wall) * (1.0 - 0.6 * frog);
    if (k == 4) {
      col = vec3(0.1, 0.14, 0.06);
      a = 0.45 * deep;
    } else {
      col = vec3(0.23, 0.17, 0.11);
      a = 0.85 * deep * (0.85 + 0.15 * grain);
    }
  }
  float sun = sunVisibility(world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  return vec4(aerialPerspective(applyFog(c, world), world), a);
}`;

const WIRE_VS = /* glsl */ `#include <header>
in vec3 a_pos;
void main() {
  // A few centimetres toward the eye, so the lines win over the faces they lie on.
  gl_Position = u_viewProj * vec4(a_pos - u_camForward.xyz * 0.04, 1.0);
}`;

const WIRE_FS = /* glsl */ `#include <header>
uniform vec3 u_color;
out vec4 o_color;
void main() {
  o_color = vec4(u_color, 1.0);
}`;

/** Ground: the engine's height field mesh (`HEIGHT_FIELD_ATTRIBS`). */
export const GROUND_MATERIAL: MaterialDesc = {
  name: 'ground',
  attribs: { a_pos: 0, a_normal: 1 },
  passes: { shadow: 'depth', color: { vs: GROUND_VS, fs: GROUND_FS } },
};

/** Solids: position, normal and colour per vertex (SOLID_LAYOUT in meshes.ts). Double-sided, so any winding works. */
export const SOLID_MATERIAL: MaterialDesc = {
  name: 'solid',
  attribs: { a_pos: 0, a_normal: 1, a_color: 2 },
  passes: { shadow: 'depth', color: { vs: SOLID_VS, fs: SOLID_FS } },
  state: { color: { cullBack: false }, shadow: { cullBack: false } },
};

/** Figure parts: position and normal per vertex, then the instance record of the engine's instance set. */
export const FIGURE_ATTRIBS = { a_pos: 0, a_normal: 1, ...instanceSetAttribs(2) } as const;
export const FIGURE_MATERIAL: MaterialDesc = {
  name: 'figure',
  attribs: FIGURE_ATTRIBS,
  passes: { shadow: { vs: FIGURE_DEPTH_VS, fs: DEPTH_FS }, color: { vs: FIGURE_VS, fs: FIGURE_FS } },
};

/** The pathfinder's parts: position, normal, colour and material per vertex (examples/shared mesh.ts), then the instance record. */
export const PATHFINDER_MATERIAL: MaterialDesc = {
  name: 'pathfinder',
  attribs: { a_pos: 0, a_normal: 1, a_color: 2, ...instanceSetAttribs(3) },
  passes: { shadow: { vs: FIGURE_DEPTH_VS, fs: DEPTH_FS }, color: { vs: PATHFINDER_VS, fs: PATHFINDER_FS } },
};

/** The cars: the figure's vertex layout (examples/shared mesh.ts) and the instance record (paint, lamps). Both sides. */
export const CAR_MATERIAL: MaterialDesc = {
  name: 'car',
  attribs: { a_pos: 0, a_normal: 1, a_color: 2, ...instanceSetAttribs(3) },
  passes: { shadow: { vs: FIGURE_DEPTH_VS, fs: DEPTH_FS }, color: { vs: CAR_VS, fs: CAR_FS } },
  state: { color: { cullBack: false }, shadow: { cullBack: false } },
};

/** The marks on the ground: the engine's contact trail material with the course's looks (`TRACE_SHADE`). */
export const TRACE_MATERIAL: MaterialDesc = contactTrailMaterial({ name: 'traces', shade: TRACE_SHADE, includes: ['noise', 'lighting', 'sky'] });

/** Wireframe: `LINE_LAYOUT` lines in one colour (`u_color`), drawn after the scene. */
export const WIRE_MATERIAL: MaterialDesc = {
  name: 'wire',
  attribs: { a_pos: 0 },
  passes: { color: { vs: WIRE_VS, fs: WIRE_FS } },
};
