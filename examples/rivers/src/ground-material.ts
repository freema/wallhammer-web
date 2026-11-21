// The ground's material: the vertex colour with a little grain, lit by the environment's sun and sky, shadowed by the
// engine's shadow map, faded into the sky with distance. The bank is drawn here, per pixel: the mesh gives every
// vertex its height over the water that may stand there (the colour's fourth component), and the material lays wet
// gravel at the water, drying sand above it and silt under it. So the bank's edge is a contour of the ground.
//
// A path's trodden earth is drawn here too, per pixel: every vertex carries the vector to the nearest point of a
// path's centreline (one per side of the path plan) and how much earth that path shows there, and the pixel's
// distance from the centreline is the length of that vector. So a tread is as wide as the material says, never as
// wide as a cell of the mesh. The stones, steps and boards of a path are shapes of their own (path-props.ts).
// Vertex layout: `GROUND_LAYOUT` (ground-mesh.ts).

import type { MaterialDesc } from 'wallhammer-web/base';
import { GROUND_ATTRIBS, OVER_MAX_M, OVER_MIN_M, PATH_UNITS } from './ground-mesh.ts';

/** Half the width of a full tread, metres, and of the faintest one (between stepping stones); how much it varies. */
const PATH_HALF_M = 0.5;
const PATH_HALF_FAINT_M = 0.24;
const PATH_HALF_VARY = 0.3;

const VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec4 a_normal;
in vec4 a_color;
in vec4 a_path;
in vec4 a_pathOn;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_over;
out vec4 v_path;
out vec4 v_pathOn;
void main() {
  v_path = a_path / ${PATH_UNITS.toFixed(1)};
  v_pathOn = a_pathOn;
  v_world = a_pos;
  v_normal = a_normal.xyz;
  v_color = a_color.rgb;
  v_over = mix(${OVER_MIN_M.toFixed(1)}, ${OVER_MAX_M.toFixed(1)}, a_color.a);
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_over;
in vec4 v_path;
in vec4 v_pathOn;
out vec4 o_color;

void main() {
  vec3 n = normalize(v_normal);
  // Grain: patches of lighter and darker growth, each scale gone before its cells reach a pixel.
  float grain = 0.5 * vnoise(v_world.xz / 13.0, 11u) + 0.3 * vnoise(v_world.xz / 3.1, 12u) * detailVisibleAt(3.1, v_world)
    + 0.2 * vnoise(v_world.xz / 0.7, 13u) * detailVisibleAt(0.7, v_world);
  vec3 col = v_color * (0.84 + 0.36 * grain);
  // The bank. Its upper edge wanders, so it is no band of one width.
  float top = 0.06 + 0.13 * vnoise(v_world.xz / 5.0, 15u);
  float bank = (1.0 - smoothstep(top - 0.05, top + 0.05, v_over)) * (1.0 - smoothstep(0.3, 0.6, 1.0 - n.y));
  vec3 gravel = mix(vec3(0.33, 0.3, 0.24), vec3(0.58, 0.54, 0.42), smoothstep(0.0, 0.1, v_over));
  gravel = mix(vec3(0.2, 0.23, 0.17), gravel, smoothstep(-0.9, -0.05, v_over)) * (0.9 + 0.2 * grain);
  col = mix(col, gravel, bank);
  // The path: the nearer of the two sides' paths. Only its trodden earth is drawn here; what stands on it is built
  // as shapes (path-props.ts). The edge of the tread is as soft as a pixel is wide there, so from far away it thins
  // into a faint line instead of flickering.
  vec2 reach = vec2(length(v_path.xy), length(v_path.zw));
  bool other = reach.y + 9.0 * (1.0 - v_pathOn.y) < reach.x + 9.0 * (1.0 - v_pathOn.x);
  vec2 toPath = other ? v_path.zw : v_path.xy;
  float pd = other ? reach.y : reach.x;
  float there = (other ? v_pathOn.y : v_pathOn.x) * (1.0 - bank);
  float wear = other ? v_pathOn.w : v_pathOn.z;
  float halfW = mix(${PATH_HALF_FAINT_M.toFixed(2)}, ${PATH_HALF_M.toFixed(2)}, wear) * (1.0 + ${PATH_HALF_VARY.toFixed(2)} * (vnoise(v_world.xz / 4.3, 21u) - 0.5) * 2.0);
  // The grass grows into the tread in tongues and tufts.
  float ragged = 0.34 * (vnoise(v_world.xz / 0.8, 22u) - 0.5) * detailVisibleAt(0.8, v_world)
    + 0.16 * (vnoise(v_world.xz / 0.17, 25u) - 0.5) * detailVisibleAt(0.17, v_world);
  float soft = max(0.06, 1.2 * fwidth(pd));
  float tread = (1.0 - smoothstep(halfW - soft, halfW + soft, pd + ragged)) * there * mix(0.5, 1.0, wear);
  // Beside the tread the grass is worn: shorter and drier.
  float worn = (1.0 - smoothstep(halfW, halfW + 0.9, pd + 1.6 * ragged)) * there;
  col = mix(col, col * vec3(1.08, 1.02, 0.84), 0.35 * worn);
  if (tread > 0.004) {
    float inside = 1.0 - smoothstep(0.1 * halfW, halfW, pd + ragged);
    // Trodden earth: pale and dusty along the middle, darker and damper under the grass at its edge.
    float grit = vnoise(v_world.xz / 0.07, 23u) * detailVisibleAt(0.07, v_world)
      + 0.6 * vnoise(v_world.xz / 0.021, 24u) * detailVisibleAt(0.021, v_world);
    vec3 earth = mix(vec3(0.2, 0.165, 0.11), vec3(0.4, 0.34, 0.25), inside) * (0.82 + 0.24 * grain + 0.18 * grit);
    col = mix(col, earth, tread);
    // The tread is a shallow groove: its two sides lean toward the middle, so the sun lights one and not the other.
    float side = (1.0 - inside) * tread * detailVisibleAt(0.5, v_world);
    n = normalize(n + vec3(toPath.x, 0.0, toPath.y) / max(pd, 1e-4) * 0.38 * side);
  }
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

export const GROUND_MATERIAL: MaterialDesc = {
  name: 'ground',
  attribs: GROUND_ATTRIBS,
  passes: { shadow: 'depth', color: { vs: VS, fs: FS } },
};
