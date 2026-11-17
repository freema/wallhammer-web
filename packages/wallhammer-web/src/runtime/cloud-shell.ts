// The clouds of a cloud cover by place (`cloudFieldSlot`) seen from outside or from below: a sphere shell above the
// base sphere, drawn from the same field as the cloud shadows. A fragment looks the field up where the light's ray
// through it meets the base sphere, so a cloud stands over its own shadow. One draw in the `color` pass, both sides,
// with the depth test and without depth writes: peaks and the body hide it in every depth mode.

import type { Vec3 } from '../base/math.ts';
import type { MeshData, VertexLayout } from '../base/data.ts';
import type { Mesh, Program } from '../gpu/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import { CLOUD_FIELD_SLOT, CLOUD_OCTAVES } from '../env/index.ts';
import type { EnvironmentLink } from './environment-link.ts';

const POSITION_LAYOUT: VertexLayout = { stride: 12, attribs: [{ name: 'a_pos', size: 3, type: 'f32', offset: 0 }] };
const ATTRIBS = { a_pos: 0 } as const;

export const CLOUD_SHELL_VS = /* glsl */ `#include <header>
uniform vec4 u_shellCenter; // xyz centre in render space, w radius of the shell
in vec3 a_pos;              // unit direction from the centre
out vec3 v_world;
void main() {
  vec3 p = u_shellCenter.xyz + a_pos * u_shellCenter.w;
  v_world = p;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

/** The cloud pattern with octaves under about two pixels replaced by their mean, as a GLSL expression of `q` and `fw`. */
const CLOUD_NOISE_AA = CLOUD_OCTAVES.map(
  ([w, f, o, seed], i) => `${w} * mix(0.5, vnoise3(${i === 0 ? 'q' : `q * ${f} + ${o}`}, ${seed}u), 1.0 - smoothstep(0.3, 0.7, fw * ${f}))`,
).join(' + ');

export const CLOUD_SHELL_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
uniform vec4 u_shellCenter; // xyz centre in render space, w radius of the shell
uniform vec4 u_shellBase;   // x radius of the base sphere, y opacity
uniform vec3 u_shellEye;    // the eye in render space
uniform vec3 u_shellLight;  // unit direction to the light, render space
uniform vec3 u_toField0;    // rows of render → field directions
uniform vec3 u_toField1;
uniform vec3 u_toField2;
in vec3 v_world;
out vec4 o_color;
vec3 toField(vec3 d) { return normalize(vec3(dot(u_toField0, d), dot(u_toField1, d), dot(u_toField2, d))); }
void main() {
#ifdef WH_LOCAL_UP
  vec3 rel = v_world - u_shellCenter.xyz;
  float rb = u_shellBase.x;
  vec3 L = u_shellLight;
  // Where the ray from the fragment away from the light meets the base sphere; the radial point where it misses.
  float b = dot(rel, L);
  float disc = b * b - (dot(rel, rel) - rb * rb);
  vec3 hit = disc > 0.0 ? rel - L * (b - sqrt(disc)) : normalize(rel) * rb;
  if (disc > 0.0 && b - sqrt(disc) < 0.0) hit = normalize(rel) * rb;
  vec3 upHere = normalize(rel);
  vec3 up = toField(normalize(hit));
  float c = cloudFieldCover(up, rb);
  vec3 q = (up * rb - vec3(u_cloud.x, 0.0, u_cloud.y)) * u_cloud.w;
  float fw = metresPerPixelAt(v_world) * u_cloud.w;
  float n = ${CLOUD_NOISE_AA};
  vec2 s = cloudFieldShade(c, n);
  float a = s.y * u_shellBase.y;
  if (a <= 0.003) discard;
  // Lit by the sun of the place (the frame's sun over its overcast dimming) on the day side, darker where thick and
  // from below.
  float mu = dot(upHere, L);
  float day = smoothstep(-0.12, 0.2, mu);
  float below = step(length(u_shellEye - u_shellCenter.xyz), u_shellCenter.w);
  float shade = mix(1.0, 0.62, c) * mix(1.0, 0.7, below * c);
  vec3 sun = u_sunColor.rgb / max(u_cloudFieldLight.y, 1e-3);
  vec3 col = 0.92 * (sun * (0.55 + 0.45 * max(mu, 0.0)) * day * shade + (u_ambient.rgb + u_skyFill.rgb) * mix(0.15, 1.0, day));
  o_color = vec4(atmosphereApply(toDisplay(col), v_world), a);
#else
  discard;
#endif
}`;

/** A cube sphere: `segments` quads along each face edge, unit radius. */
function cubeSphere(segments: number): MeshData {
  const n = Math.max(1, Math.floor(segments));
  const side = n + 1;
  const vertices = new Float32Array(6 * side * side * 3);
  const indices = new Uint32Array(6 * n * n * 6);
  const faces: readonly (readonly [Vec3, Vec3, Vec3])[] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  let v = 0;
  let k = 0;
  faces.forEach(([nrm, u, w], f) => {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        // Equal angles along the face edge keep the quads near the same size.
        const a = Math.tan(((i / n) * 2 - 1) * (Math.PI / 4));
        const b = Math.tan(((j / n) * 2 - 1) * (Math.PI / 4));
        const x = nrm[0] + u[0] * a + w[0] * b;
        const y = nrm[1] + u[1] * a + w[1] * b;
        const z = nrm[2] + u[2] * a + w[2] * b;
        const len = Math.hypot(x, y, z);
        vertices[v++] = x / len;
        vertices[v++] = y / len;
        vertices[v++] = z / len;
      }
    }
    const base = f * side * side;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p = base + j * side + i;
        indices[k++] = p;
        indices[k++] = p + 1;
        indices[k++] = p + side + 1;
        indices[k++] = p;
        indices[k++] = p + side + 1;
        indices[k++] = p + side;
      }
    }
  });
  return { layout: POSITION_LAYOUT, vertices, indices, count: indices.length };
}

export class CloudShellLayer implements Layer {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'cloud-shell';
  /** Centre of the base sphere, render space. */
  center: Vec3 = [0, 0, 0];
  /** Radius of the sphere the field lies on (the shadows' sphere). */
  baseRadiusM = 1;
  /** Height of the shell above the base sphere. */
  heightM = 3000;
  /** 3 × 3, row-major: render directions → the frame the field is fixed in. Identity by default. */
  toField: Float32Array = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** Unit direction to the light, render space. */
  light: Vec3 = [0, 1, 0];
  /** 0 = nothing drawn. */
  opacity = 1;
  private readonly program: Program;
  private readonly mesh: Mesh;
  private readonly renderer: Renderer;

  constructor(renderer: Renderer, link: EnvironmentLink, o: { segments?: number } = {}) {
    if (!link.block.slots.some((s) => s.name === CLOUD_FIELD_SLOT)) {
      throw new Error(`CloudShellLayer needs the environment slot "${CLOUD_FIELD_SLOT}" (cloudFieldSlot) in the frame block`);
    }
    this.renderer = renderer;
    this.program = renderer.device.program('cloud shell', renderer.resolve(CLOUD_SHELL_VS), renderer.resolve(CLOUD_SHELL_FS), ATTRIBS);
    this.mesh = renderer.device.createMesh(cubeSphere(o.segments ?? 48), ATTRIBS);
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color' || this.opacity <= 0) return;
    const device = ctx.device;
    const p = this.program;
    const t = this.toField;
    device.setState({ depthTest: true, depthWrite: false, cullBack: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' } });
    device.use(p);
    p.set('u_shellCenter', { vec4: [this.center[0], this.center[1], this.center[2], this.baseRadiusM + this.heightM] });
    p.set('u_shellBase', { vec4: [this.baseRadiusM, this.opacity, 0, 0] });
    p.vec3v('u_shellEye', ctx.view.cornerRays()[0]!.origin);
    p.vec3v('u_shellLight', this.light);
    p.set('u_toField0', { vec3: [t[0]!, t[1]!, t[2]!] });
    p.set('u_toField1', { vec3: [t[3]!, t[4]!, t[5]!] });
    p.set('u_toField2', { vec3: [t[6]!, t[7]!, t[8]!] });
    device.draw(this.mesh);
    ctx.count(this.mesh.triangles);
  }

  dispose(): void {
    this.renderer.device.deleteMesh(this.mesh);
  }
}
