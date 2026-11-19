// The clouds of a cloud cover by place (`cloudFieldSlot`) seen from outside or from below: a sphere shell above the
// base sphere, drawn from the same field as the cloud shadows. A point of the shell looks the field up where the
// light's ray through it meets the base sphere, so a cloud stands over its own shadow. One draw in the `color` pass,
// both sides, with the depth test and without depth writes: peaks and the body hide it in every depth mode.
// The shell covers the whole picture from inside the air, so a fragment does only what has to be sharp: the cloud
// pattern. The cover (patches tens of kilometres across) and the air between the eye and the shell are taken per
// vertex and carried across the triangles. The air is carried per metre of the view ray and multiplied by the
// fragment's own distance, so it stays right under a deck a few hundred metres overhead, where a triangle spans far
// more than its distance from the eye.
//
// With a volume (`volume`, set by `CloudVolumeLayer` when the shell is its far layer) the shell draws the volume's own
// clouds instead of the pattern: the same weather map, the same shape noise at the same places, lit the same way, so
// handing over from the volume to the shell changes the detail and not the clouds. The mesh is drawn at the layer's
// top (and with the eye inside the layer also at its base); of the points where a view ray meets those spheres the one
// where the ray first enters the layer (from inside: where it first leaves it) integrates the ray's whole span in the
// layer with five samples of the shape spread evenly over it, each weighted by the shell's share of the
// clouds at its distance (1 − `cloudVolumeNearShare`). Where the samples lie far apart across the view, or a pixel
// covers several of the noise's texels, the shape gives way to its mean (as in the volume), and such a sample lets the
// light through the gaps between the clouds it stands for, so the limb and the far horizon are soft bands that still
// follow the cover and a low cover stays broken. The light toward the sun is taken from the sample's own density
// and the height above it, without samples toward the light.

import type { Vec3 } from '../base/math.ts';
import type { MeshData, VertexLayout } from '../base/data.ts';
import type { Mesh, Program } from '../gpu/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import { CLOUD_FIELD_SLOT, CLOUD_OCTAVES, CLOUD_RAIN_DENSITY, CLOUD_VOLUME_GLSL } from '../env/index.ts';
import { NOISE_VOLUME_SHAPE } from '../gen-tex/index.ts';
import type { EnvironmentLink } from './environment-link.ts';
import { VOLUME_DENSITY_GLSL, VOLUME_LIGHT_GLSL } from './cloud-volume.ts';
import type { CloudFarLayer, CloudVolumeLayer } from './cloud-volume.ts';

const POSITION_LAYOUT: VertexLayout = { stride: 12, attribs: [{ name: 'a_pos', size: 3, type: 'f32', offset: 0 }] };
const ATTRIBS = { a_pos: 0 } as const;

/** Uniforms and functions both stages of the shell share. */
const SHELL_COMMON = /* glsl */ `
uniform vec4 u_shellCenter; // xyz centre in render space, w radius of the shell
uniform vec4 u_shellBase;   // x radius of the base sphere, y opacity
uniform vec3 u_shellLight;  // unit direction to the light, render space
uniform vec3 u_shellEye;    // the eye in render space
uniform vec3 u_toField0;    // rows of render → field directions
uniform vec3 u_toField1;
uniform vec3 u_toField2;
vec3 toField(vec3 d) { return normalize(vec3(dot(u_toField0, d), dot(u_toField1, d), dot(u_toField2, d))); }
// Unit up in the field's frame where the ray from a point of the shell (rel: relative to the centre) away from the
// light meets the base sphere; the point straight under it where the ray misses.
vec3 shellFieldUp(vec3 rel) {
  float rb = u_shellBase.x;
  vec3 L = u_shellLight;
  float b = dot(rel, L);
  float disc = b * b - (dot(rel, rel) - rb * rb);
  vec3 hit = disc > 0.0 ? rel - L * (b - sqrt(disc)) : rel;
  if (disc > 0.0 && b - sqrt(disc) < 0.0) hit = rel;
  return toField(normalize(hit));
}`;

export const CLOUD_SHELL_VS = /* glsl */ `#include <header>
#include <noise>
#include <shadow>
#include <atmosphere>
${SHELL_COMMON}
in vec3 a_pos;              // unit direction from the centre
out vec3 v_world;
// The cover over the vertex's shadow point, and the air between the eye and the vertex per metre of the way: the
// scattered light and the optical depth.
out float v_cover;
out vec3 v_airPerM;
out vec3 v_depthPerM;
void main() {
  vec3 p = u_shellCenter.xyz + a_pos * u_shellCenter.w;
  v_world = p;
#ifdef WH_LOCAL_UP
  v_cover = cloudFieldCover(shellFieldUp(p - u_shellCenter.xyz), u_shellBase.x);
#else
  v_cover = 0.0;
#endif
  vec3 through;
  vec3 air = atmosphereAir(p, through);
  float len = max(length(p - u_shellEye), 1.0);
  v_airPerM = air / len;
  v_depthPerM = -log(max(through, vec3(1e-6))) / len;
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
${SHELL_COMMON}
in vec3 v_world;
in float v_cover;
in vec3 v_airPerM;
in vec3 v_depthPerM;
out vec4 o_color;
void main() {
#ifdef WH_LOCAL_UP
  // Where the cover is nil there is no cloud: the pattern is not looked up.
  float c = clamp(v_cover, 0.0, 1.0);
  if (c <= 0.0) discard;
  vec3 rel = v_world - u_shellCenter.xyz;
  float rb = u_shellBase.x;
  vec3 L = u_shellLight;
  vec3 upHere = normalize(rel);
  vec3 up = shellFieldUp(rel);
  vec3 q = (up * rb - vec3(u_cloud.x, 0.0, u_cloud.y)) * u_cloud.w;
  float fw = metresPerPixelAt(v_world) * u_cloud.w;
  float n = ${CLOUD_NOISE_AA};
  vec2 s = cloudFieldShade(c, n);
  float a = s.y * u_shellBase.y;
  if (a <= 0.003) discard;
  float mu = dot(upHere, L);
  float day = smoothstep(-0.12, 0.2, mu);
  // 1 with the eye under the shell, eased over a few hundred metres round its height.
  float below = 1.0 - smoothstep(-200.0, 200.0, length(u_shellEye - u_shellCenter.xyz) - u_shellCenter.w);
  // How far the pattern stands over the cloud's edge: the thick parts of a cloud, also inside a closed deck.
  float thick = smoothstep(0.0, 0.45, n - cloudCoverTerms(c, u_cloudFieldLight.x).x);
  // From above the top stands in the sun over its own place: through the air over it where there is an atmosphere
  // (white high in the day, red toward the night side), else the frame's sun over its overcast dimming. The frame's
  // sun is the light at the eye; from high up it is not the light on a deck far away (an orange sun under the blue
  // fill made whole decks pink). Darker where the cover is high, brighter where thick. From below the base shows what
  // comes through: the sun share under it (s.x times the dimming) and less of the sky's light the higher the cover,
  // both darker where thick.
  float top = mix(1.0, 0.62, c) * mix(0.55, 1.0, thick);
  float base = s.x * u_cloudFieldLight.y * mix(0.75, 0.45, thick);
  float fill = mix(1.0, mix(1.1, 0.7, thick) * (1.0 - 0.45 * c), below);
  vec3 frameSun = u_sunColor.rgb / max(u_cloudFieldLight.y, 1e-3);
  vec3 sunAbove = frameSun;
#ifdef WH_ATMOSPHERE
  if (u_atmSun.w > 0.0) sunAbove = atmosphereSun(v_world);
#endif
  vec3 col = 0.92 * (mix(sunAbove * top, frameSun * base, below) * (0.55 + 0.45 * max(mu, 0.0)) * day + (u_ambient.rgb + u_skyFill.rgb) * mix(0.15, 1.0, day) * fill);
  float len = length(v_world - u_shellEye);
  o_color = vec4(atmosphereApply(toDisplay(col), v_world, v_airPerM * len, exp(-v_depthPerM * len)), a);
#else
  discard;
#endif
}`;

/** Samples along a view ray of the shell drawing a volume's clouds. */
const SHELL_SAMPLES = 5;

/** The shell drawing the clouds of a volume (`CloudShellLayer.volume`). */
const CLOUD_SHELL_FIELD_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
#include <atmosphere>
${CLOUD_VOLUME_GLSL}
${VOLUME_DENSITY_GLSL}
${VOLUME_LIGHT_GLSL}
${SHELL_COMMON}
uniform float u_shellTop; // 1: the mesh lies at the layer's top, 0: at its base
in vec3 v_world;
in vec3 v_airPerM;
in vec3 v_depthPerM;
out vec4 o_color;
void main() {
#ifdef WH_LOCAL_UP
  vec3 eye = u_shellEye - u_cvRef.xyz;
  vec3 dir = normalize(v_world - u_shellEye);
  float R = u_cvRef.w;
  float r0 = length(eye);
  float he = r0 - R;
  // The point of the mesh that draws the ray: where it first enters the layer (the top from above, the base from below);
  // from inside the layer where it first leaves it (the base where the ray goes down through it, else the top).
  bool top = u_shellTop > 0.5;
  bool outward = dot(dir, v_world - u_cvRef.xyz) > 0.0;
  bool own;
  if (he >= u_cvSlab.y) own = top && !outward;
  else if (he <= u_cvSlab.x) own = !top && outward;
  else {
    float b = dot(eye, dir);
    float rb = R + u_cvSlab.x;
    float db = b * b - (r0 - rb) * (r0 + rb);
    bool down = db > 0.0 && -b - sqrt(db) > 0.0;
    own = top ? outward && !down : !outward && down;
  }
  if (!own) discard;
  vec4 span = cloudVolumeSpan(eye, dir);
  // Where the volume has all of the clouds the shell has nothing to add.
  float t0 = u_cvFar.z >= 0.999 ? max(span.x, u_cvFar.x) : span.x;
  // A ray that dips under the base and misses the ground: only up to the base (the rest lies past the limb).
  float t1 = span.w > span.z ? min(span.y, span.z) : span.y;
  if (t1 <= t0) discard;
  float thick = u_cvSlab.y - u_cvSlab.x;
  float cell = 0.25 / u_cvScale.x;
  // A fixed count of samples spread over the span, so their places (and heights) change smoothly across the view.
  const float n = ${SHELL_SAMPLES}.0;
  float dt = (t1 - t0) / n;
  float tm = 0.5 * (t0 + t1);
  cvLightAt(eye + dir * tm, u_shellEye + dir * tm);
  vec3 ph = cvPhases(dir);
  float cosT = dot(dir, cvL);
  float T = 1.0;
  vec3 light = vec3(0.0);
  float dSum = 0.0;
  float wSum = 0.0;
  // Where the ray last found no cloud (a sample after an empty one stands for the cloud from there on), and the
  // optical depth along the ray so far.
  float tFree = t0;
  float tauView = 0.0;
  for (int i = 0; i < ${SHELL_SAMPLES}; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 rel = eye + dir * t;
    float h = (cloudVolumeHeight(rel) - u_cvSlab.x) / thick;
    float share = 1.0 - cloudVolumeNearShare(t);
    vec3 weather = h > 0.0 && h < 1.0 && share > 0.0 ? cvWeather(rel) : vec3(0.0);
    if (weather.x <= 0.0) {
      tFree = t;
      continue;
    }
    vec3 upHere = normalize(rel);
    // How far apart the samples lie across the view (beyond the shape's cells its mean), and how many of the noise's
    // texels a pixel covers there: from one to four the shape, and the wide lookup, give way to their means, so the
    // far layer and the planet from orbit do not alias into speckle.
    float across = dt * sqrt(max(1.0 - dot(dir, upHere) * dot(dir, upHere), 0.0));
    float texels = metresPerPixelAt(u_cvRef.xyz + rel) * ${NOISE_VOLUME_SHAPE.size}.0;
    float lod = max(smoothstep(0.3, 1.2, across / cell), smoothstep(1.0, 4.0, texels * u_cvScale.x));
    vec3 q = cvNoiseAt(rel);
    float wide = mix(cvWide(q), 0.5, smoothstep(1.0, 4.0, texels * u_cvScale.y));
    vec2 base = cvBaseShare(textureLod(u_cvShape, q * u_cvScale.x, 0.0).r, lod, wide, weather, h);
    float d = base.x * share;
    if (d <= 0.0) {
      tFree = t;
      continue;
    }
    float dense = u_cvSlab.z * (1.0 + ${CLOUD_RAIN_DENSITY.toFixed(2)} * weather.z);
    float sigma = d * dense;
    // Inside the clouds the step stands for (a share of it where the shape gave way to its mean).
    float sigmaIn = sigma / max(base.y, 0.05);
    // The light of the part the eye sees: half a mean free path into the cloud from where the ray met it (the start
    // of the step, or the last empty sample; no higher than the top of the place's cloud type, which lies low in the
    // layer for a deck). The optical depth toward the light from there: looking down, the depth the ray has passed
    // so far turned from the view's slope to the light's (the layer taken as level); looking up or along the layer,
    // as much cloud as here over the way up to that top.
    float hTop = cloudVolumeTypedTop(weather.y, weather.z * (1.0 - weather.y), weather.z);
    float tIn = min(t - 0.5 * dt, tFree);
    float hIn = min((cloudVolumeHeight(eye + dir * tIn) - u_cvSlab.x) / thick, hTop);
    float cosDown = -dot(dir, upHere);
    float hs = clamp(hIn - 0.5 * min(dt, 1.0 / max(sigmaIn, 1e-6)) * abs(cosDown) / thick, 0.0, hTop);
    float muL = max(dot(upHere, cvL), 0.15);
    float tauUp = sigmaIn * min((hTop - hs) * thick / muL, 2500.0) * 0.5;
    float tauDown = (tauView + 0.5 * min(sigmaIn * dt, 1.0)) * max(cosDown, 0.0) / muL;
    float tau = mix(tauUp, tauDown, smoothstep(0.05, 0.3, cosDown));
    // The darker thin edges facing away toward the sun are a detail of the shape: where it gave way to its mean,
    // they average out.
    vec3 s = cvSampleLight(tau, d, hs, weather, ph, mix(cosT, 1.0, lod));
    float ts = cvStepThrough(sigma, base.y, dt);
    float w = T * (1.0 - ts);
    light += s * w;
    dSum += t * w;
    wSum += w;
    T *= ts;
    tFree = t + 0.5 * dt;
    tauView -= log(max(ts, 1e-4));
    if (T < 0.01) {
      T = 0.0;
      break;
    }
  }
  float a = (1.0 - T) * u_shellBase.y;
  if (a <= 0.003) discard;
  float meanM = dSum / max(wSum, 1e-6);
  vec3 col = 0.92 * light / max(1.0 - T, 1e-4);
  vec3 at = u_shellEye + dir * meanM;
  o_color = vec4(atmosphereApply(aerialPerspective(toDisplay(col), at), at, v_airPerM * meanM, exp(-v_depthPerM * meanM)), a);
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

export class CloudShellLayer implements Layer, CloudFarLayer {
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
  /**
   * The volumetric clouds whose far part the shell draws, from their own field (see the top of this file), or null:
   * the shell's own pattern over the cover by place. Set by `CloudVolumeLayer` while the shell is its `shell`.
   */
  volume: CloudVolumeLayer | null = null;
  private readonly program: Program;
  private fieldProgram: Program | null = null;
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
    if (this.volume && this.drawField(ctx, this.volume)) return;
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

  /** Draws the volume's clouds; false when the volume's field is not ready (the pattern is drawn instead). */
  private drawField(ctx: DrawContext, volume: CloudVolumeLayer): boolean {
    const device = ctx.device;
    const r = this.renderer;
    const u = volume.bindField(device);
    if (!u) return false;
    const ref = (u['u_cvRef'] as { vec4: readonly number[] }).vec4;
    const radius = ref[3]!;
    const s = volume.shape;
    if (radius <= 0) {
      volume.unbindField(device);
      return true;
    }
    if (!this.fieldProgram) this.fieldProgram = device.program('cloud shell (volume)', r.resolve(CLOUD_SHELL_VS), r.resolve(CLOUD_SHELL_FIELD_FS), ATTRIBS);
    const p = this.fieldProgram;
    const eye = ctx.view.cornerRays()[0]!.origin;
    const height = Math.hypot(eye[0] - ref[0]!, eye[1] - ref[1]!, eye[2] - ref[2]!) - radius;
    // From above the layer its top, from below its base, from inside both.
    const spheres = height >= s.topM ? [1] : height <= s.baseM ? [0] : [1, 0];
    device.setState({ depthTest: true, depthWrite: false, cullBack: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' } });
    device.use(p);
    for (const name in u) p.set(name, u[name]!);
    p.set('u_shellBase', { vec4: [radius, this.opacity, 0, 0] });
    p.vec3v('u_shellEye', eye);
    for (const top of spheres) {
      p.set('u_shellCenter', { vec4: [ref[0]!, ref[1]!, ref[2]!, radius + (top ? s.topM : s.baseM)] });
      p.float('u_shellTop', top);
      device.draw(this.mesh);
      ctx.count(this.mesh.triangles);
    }
    volume.unbindField(device);
    return true;
  }

  dispose(): void {
    this.renderer.device.deleteMesh(this.mesh);
  }
}
