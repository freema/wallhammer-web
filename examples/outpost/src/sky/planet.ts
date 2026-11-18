// The planet over the horizon: a disc at infinity in a fixed world direction, drawn by one screen-covering triangle
// before everything else (no depth test, no depth write), so the scene covers it and the black background shows
// around it. The disc is shaded as a sphere in flat colours: ocean, continents, polar ice and a few cloud streaks,
// a narrow shaded crescent away from the sun, and an ink outline of constant pixel width at the limb.
//
// The ray of each pixel comes from the view's four corner rays (`View.cornerRays`), scaled to a common depth so they
// interpolate linearly across the screen.

import type { MaterialDesc, MeshData, View } from 'wallhammer-web/base';
import { newCornerRays } from 'wallhammer-web/base';
import { MeshLayer } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';
import { cross, normalize } from '../kit/math.ts';
import type { V3 } from '../kit/math.ts';
import { STYLE } from '../style/materials.ts';
import { glslColor } from '../style/palette.ts';

const PLANET_VS = /* glsl */ `#include <header>
in vec3 a_pos;
uniform vec3 u_rayLB;
uniform vec3 u_rayLT;
uniform vec3 u_rayRB;
out vec3 v_dir;
void main() {
  vec2 s = a_pos.xy * 0.5 + 0.5;
  v_dir = u_rayLB + (u_rayRB - u_rayLB) * s.x + (u_rayLT - u_rayLB) * s.y;
  gl_Position = vec4(a_pos.xy, 0.0, 1.0);
}`;

const PLANET_FS = /* glsl */ `#include <header>
#include <noise>
uniform vec4 u_planet;      // xyz direction to the centre, w sine of the angular radius
uniform vec3 u_planetRight;
uniform vec3 u_planetUp;
uniform vec4 u_ink;         // y outline width (px)
in vec3 v_dir;
out vec4 o_color;

float band(float e, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(e - w * 0.5, e + w * 0.5, x);
}

void main() {
  vec3 d = normalize(v_dir);
  vec3 P = u_planet.xyz;
  if (dot(d, P) <= 0.0) discard;
  vec2 q = vec2(dot(d, u_planetRight), dot(d, u_planetUp)) / u_planet.w;
  float r = length(q);
  float px = max(fwidth(r), 1e-5);
  float rim = 1.0 + u_ink.y * px;
  if (r > rim + px) discard;
  // The visible hemisphere: its normal points back toward the eye.
  float z = sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0)));
  vec3 N = q.x * u_planetRight + q.y * u_planetUp - z * P;
  // Fixed tilt of the globe, then continents from layered noise, ice at the poles, a few clouds.
  vec3 g = vec3(N.x * 0.94 + N.y * 0.34, N.y * 0.94 - N.x * 0.34, N.z) * 1.9 + vec3(3.1, 1.7, 5.3);
  float landN = 0.55 * vnoise3(g, 11u) + 0.3 * vnoise3(g * 2.3, 12u) + 0.15 * vnoise3(g * 5.1, 13u);
  float land = band(0.53, landN);
  float deep = band(0.6, 1.0 - landN) * (1.0 - land);
  vec3 c = mix(mix(${glslColor('ocean')}, ${glslColor('oceanDeep')}, deep), mix(${glslColor('land')}, ${glslColor('landDark')}, band(0.66, landN)), land);
  float pole = abs(N.y * 0.94 - N.x * 0.34);
  float cloudN = vnoise3(g * vec3(1.2, 4.5, 1.2) + 7.0, 14u);
  c = mix(c, ${glslColor('ice')}, max(band(0.9, pole), band(0.8, cloudN)));
  // A narrow crescent turned away from the sun.
  c *= mix(${(STYLE.shadow + 0.12).toFixed(3)}, 1.0, band(-0.25, dot(N, u_sunDir.xyz)));
  // Ink at the limb, then the edge against the black sky.
  c = mix(c, ${glslColor('outline')}, band(1.0, r));
  c *= 1.0 - band(rim, r);
  o_color = vec4(c, 1.0);
}`;

const PLANET_MATERIAL: MaterialDesc = {
  name: 'outpost-planet',
  attribs: { a_pos: 0 },
  passes: { color: { vs: PLANET_VS, fs: PLANET_FS } },
  state: { color: { depthTest: false, depthWrite: false, cullBack: false } },
};

/** One triangle that covers the screen, in clip coordinates. */
const SCREEN_TRIANGLE: MeshData = {
  layout: { stride: 12, attribs: [{ name: 'a_pos', size: 3, type: 'f32', offset: 0 }] },
  vertices: new Uint8Array(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]).buffer),
  indices: null,
  count: 3,
};

export class PlanetLayer extends MeshLayer {
  private readonly rays = newCornerRays();
  private readonly dir: V3;
  private readonly right: V3;
  private readonly up: V3;
  private readonly sinR: number;
  /** Outline width in pixels, set by the scene. */
  outlinePx = 2;

  constructor(renderer: Renderer, dir: V3, radiusDeg: number) {
    const material = renderer.material(PLANET_MATERIAL);
    super({ material, mesh: renderer.createMesh(SCREEN_TRIANGLE, material), name: 'planet' });
    this.dir = normalize(dir);
    this.right = normalize(cross(this.dir, [0, 1, 0]));
    this.up = cross(this.right, this.dir);
    this.sinR = Math.sin((radiusDeg * Math.PI) / 180);
    renderer.beforeFrame.push((view) => this.aim(view));
  }

  /** Corner rays of the view, scaled to a common depth along the view direction. */
  private aim(view: View): void {
    const r = view.cornerRays(this.rays);
    const f = normalize([r[0]!.dir[0] + r[1]!.dir[0] + r[2]!.dir[0] + r[3]!.dir[0], r[0]!.dir[1] + r[1]!.dir[1] + r[2]!.dir[1] + r[3]!.dir[1], r[0]!.dir[2] + r[1]!.dir[2] + r[2]!.dir[2] + r[3]!.dir[2]]);
    const at = (k: number): [number, number, number] => {
      const d = r[k]!.dir;
      const s = 1 / (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]);
      return [d[0] * s, d[1] * s, d[2] * s];
    };
    this.uniforms = {
      u_rayLB: { vec3: at(0) },
      u_rayLT: { vec3: at(1) },
      u_rayRB: { vec3: at(2) },
      u_planet: { vec4: [this.dir[0], this.dir[1], this.dir[2], this.sinR] },
      u_planetRight: { vec3: [this.right[0], this.right[1], this.right[2]] },
      u_planetUp: { vec3: [this.up[0], this.up[1], this.up[2]] },
      u_ink: { vec4: [0, this.outlinePx, 0, 0] },
    };
  }
}
