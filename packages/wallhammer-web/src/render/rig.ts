// Instanced rigs: every kind is one mesh of rigid parts, posed in the vertex shader from the instance record (see
// `RIG_INSTANCE_LAYOUT`). Gait, rolling, steering, body roll, bob and idle sway are closed-form functions of the
// distance travelled, speed, turn rate and the animation time, so nothing is stored between frames and a jump in
// time poses correctly at once. Every frame the layer culls the instances against the view and splits them by
// their size on screen: near (all parts, animated), far (fewer parts, still) and hidden. Per kind and level of
// detail that is one draw for the bodies and one for a soft contact shadow. Kinds with a free gait or chains of
// links (`rigExtended`) are drawn by a second program, the same text with `WH_RIG_EXT` defined, made when the first
// such kind is added; every other kind keeps the first program as it was.
//
// The posing is its own vertex include (`RIG_POSE_GLSL`, registered as `<rig-pose>`), so a game can draw the bodies
// with its own material (`RigLayerOptions.material`); without one the layer draws exactly as before. By default rigs
// do not enter the shadow map (redrawing it costs time), they receive its shadows and stand on their contact shadow;
// `castShadow` draws them into it as a dynamic caster. The instance field `state` is not read by any shader.

import type { MaterialDesc, PassName } from '../base/material.ts';
import { RIG_ATTRIBS, RIG_INSTANCE_FLOATS, RIG_INSTANCE_LAYOUT, rigExtended } from '../base/rig.ts';
import type { RigDesc } from '../base/rig.ts';
import type { CullVolume } from '../base/view.ts';
import type { InstanceBuffer, Mesh } from '../gpu/index.ts';
import { rigMesh, rigShadowMesh } from '../gen-mesh/rig-mesh.ts';
import type { DrawContext, Layer, Material, Renderer } from './renderer.ts';
import { SHADOW_MAP_UNIT } from './renderer.ts';
import { DEPTH_FS } from './shadow-glsl.ts';

const INPUTS = /* glsl */ `
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_pivot;
in vec4 a_motion;  // kind, amount, segment, colour slot (−1 fixed colour)
in vec4 a_color;   // rgb, finish
in vec2 a_extra;   // gait phase, variant bit (−1 always)
in vec4 i_p0;
in vec4 i_dir;
in vec4 i_p1;
in vec4 i_move;    // distance m, speed m/s, turn rate rad/s, seed
in vec4 i_look;    // state, height scale, width scale, variant bits
in vec4 i_colors;
uniform vec4 u_rig;   // x stride m (0: rolls instead of walking), y steering base m, z roll gain, w roll limit rad
uniform vec4 u_rig2;  // x bob m, y animate 0–1, z lamps 0–1, w leg length m
const float TAU = 6.2831853;
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
`;

/** Places a segment-local point (already posed and scaled) in the world on the segment's anchor and heading. */
const FRAME = /* glsl */ `
vec3 toWorld(vec3 q, float seg, out vec3 fwd, out vec3 right) {
  vec4 p = seg < 0.5 ? i_p0 : i_p1;
  vec2 d = seg < 0.5 ? i_dir.xy : i_dir.zw;
#ifdef WH_LOCAL_UP
  // Up is radial: the heading (x, z) is meant in the local frame of the anchor, and heights go along its up.
  mat3 lf = localFrame(p.xyz);
  fwd = lf * vec3(d.x, 0.0, d.y);
  right = lf * vec3(-d.y, 0.0, d.x);
  return p.xyz + right * q.x + lf[1] * (q.y + q.z * p.w) + fwd * q.z;
#else
  fwd = vec3(d.x, 0.0, d.y);
  right = vec3(-d.y, 0.0, d.x);
  return p.xyz + right * q.x + vec3(0.0, q.y + q.z * p.w, 0.0) + fwd * q.z;
#endif
}
`;

/**
 * Vertex include of rig posing (registered as `<rig-pose>` by `RigLayer`; write it after `<header>` and
 * `<noise>`): the part attributes and instance record (`RIG_ATTRIBS`), the uniforms `RigLayer` sets (`u_rig`,
 * `u_rig2`, with `WH_RIG_EXT` also `u_rig3`) and two functions. `bool rigPose(out vec3 pos, out vec3 nrm)`: the
 * world position and unit normal of the vertex in the pose of its instance; false when the instance lacks the
 * part's variant (collapse the vertex). `vec3 rigColor()`: the part's colour times its instance colour slot.
 */
export const RIG_POSE_GLSL = /* glsl */ `${INPUTS}
${FRAME}
#ifdef WH_RIG_EXT
uniform vec4 u_rig3;  // x gait (0 pair, 1 free), y dip m, z w the speeds the gait fades in between (m/s at scale 1)
#endif
vec3 unpackRgb(float c) {
  float r = floor(c / 65536.0);
  float g = floor((c - r * 65536.0) / 256.0);
  return vec3(r, g, c - r * 65536.0 - g * 256.0) / 255.0;
}
bool rigPose(out vec3 pos, out vec3 nrm) {
  // A variant part the instance does not have collapses outside the clip volume.
  if (a_extra.y >= 0.0 && mod(floor(i_look.w / exp2(a_extra.y)), 2.0) < 0.5) {
    return false;
  }
  float kind = a_motion.x;
  float amount = a_motion.y;
  float anim = u_rig2.y;
  float dist = i_move.x;
  float speed = i_move.y;
  float seed = i_move.w;
  float t = u_time.x;
  vec3 q = a_pos - a_pivot;
  vec3 n = a_normal;
  mat3 r = mat3(1.0);
  float dy = 0.0;
  float roll = 0.0;
  bool sprung = true;
  if (u_rig.x > 0.0) {
    // Gait. Phase in cycles from the distance travelled, so the stance foot moves exactly backward at the speed
    // of travel and stays still on the ground; the swing foot comes forward on a smooth step.
    float walk = smoothstep(0.15, 0.9, speed) * anim;
    float phase = dist / (u_rig.x * i_look.y) + seed;
    float legL = u_rig2.w;
    // The leg on the ground: its foot offset falls linearly from +1/4 to −1/4 of the stride.
    float us = (0.25 - 0.5 * fract(2.0 * phase)) * u_rig.x * walk;
    dy = legL * (cos(asin(clamp(us / legL, -0.9, 0.9))) - 1.0);
    roll = 0.035 * sin(TAU * phase) * walk + 0.02 * sin(t * 0.8 + seed * TAU) * (1.0 - walk) * anim;
    float f = fract(phase + a_extra.x);
    float u = f < 0.5 ? 0.25 - f : -0.25 + 0.5 * smoothstep(0.0, 1.0, (f - 0.5) * 2.0);
    if (kind == 3.0) {
      float lift = f < 0.5 ? 0.0 : sin(3.14159 * (f - 0.5) * 2.0);
      q.y *= 1.0 - 0.22 * lift * walk;
      r = rotX(-asin(clamp(u * u_rig.x * walk / amount, -0.9, 0.9)));
    } else if (kind == 4.0) {
      r = rotX(-amount * 4.0 * u * walk);
    }
  } else {
    // Rolling: wheels spin with the distance, the steering pair turns toward the curve, the body leans out of it
    // and bobs a little on the surface.
    float k = i_move.z / max(speed, 0.5);
    roll = clamp(u_rig.z * speed * i_move.z, -u_rig.w, u_rig.w) * anim;
    dy = u_rig2.x * (vnoise(vec2(dist * 0.9, seed * 97.0), 7u) - 0.5) * 2.0 * min(speed / 4.0, 1.0) * anim;
    if (kind == 1.0 || kind == 2.0) {
      sprung = false;
      r = rotX(dist / amount * anim);
      if (kind == 2.0) r = rotY(clamp(atan(u_rig.y * k), -0.6, 0.6) * anim) * r;
    }
  }
#ifdef WH_RIG_EXT
  // Extended pose. g: the gait phase in cycles (time when the rig rolls); walkX: how much it walks, 0–1.
  float g = u_rig.x > 0.0 ? dist / (u_rig.x * i_look.y) + seed : 0.5 * t + seed;
  float walkX = u_rig.x > 0.0 ? smoothstep(0.15, 0.9, speed) * anim : 0.0;
  if (u_rig.x > 0.0 && u_rig3.x > 0.5) {
    // Free gait: every limb plants its own end point. Stance (f < 0.5): the end point lies on the ground and moves
    // backward at the speed of travel; swing: it comes forward on a smooth step, lifted. The limb is aimed at it and
    // stretched along its own length. The body dips by u_rig3.y twice per cycle and keeps the sway.
    walkX = smoothstep(u_rig3.z * i_look.y, u_rig3.w * i_look.y, speed) * anim;
    dy = -u_rig3.y * walkX * (0.5 + 0.5 * cos(2.0 * TAU * g));
    roll = 0.035 * sin(TAU * g) * walkX + 0.02 * sin(t * 0.8 + seed * TAU) * (1.0 - walkX) * anim;
    q = a_pos - a_pivot;
    r = mat3(1.0);
    float fx = fract(g + a_extra.x);
    float ux = fx < 0.5 ? 0.25 - fx : -0.25 + 0.5 * smoothstep(0.0, 1.0, (fx - 0.5) * 2.0);
    if (kind == 3.0) {
      float lift = fx < 0.5 ? 0.0 : sin(3.14159 * (fx - 0.5) * 2.0);
      // From the pivot (lowered by the dip) to the end point; at rest straight down by the limb's length.
      vec2 e = vec2(ux * u_rig.x * walkX, mix(-amount, 0.22 * amount * lift - (a_pivot.y + dy), walkX));
      q.y *= length(e) / amount;
      r = rotX(-atan(e.x, -e.y));
    } else if (kind == 4.0) {
      r = rotX(-amount * 4.0 * ux * walkX);
    }
  }
  if (kind > 6.5) {
    // A link of a chain (kind 7, 8, 9: about x, y, z): turns about the root by amount × its distance from the root ×
    // a wave that lags along the chain; zero at the root, so the chain never leaves the body and links stay joined.
    float dr = length(a_pos - a_pivot);
    float wave = walkX * sin(TAU * (g - a_extra.x * dr)) + (1.0 - walkX) * 0.4 * sin(TAU * (0.15 * t + seed - a_extra.x * dr)) * anim;
    float th = amount * dr * wave;
    r = kind < 7.5 ? rotX(th) : kind < 8.5 ? rotY(th) : rotZ(th);
  }
#endif
  if (kind == 5.0) {
    float still = 1.0 - smoothstep(0.1, 0.6, speed);
    r = rotY(amount * sin(t * 0.45 + seed * 40.0) * still * anim);
  } else if (kind == 6.0) {
    float wa = (vnoise(vec2(t * 1.7 + seed * 50.0, dist * 0.6), 3u) - 0.5) * 2.0;
    float wb = (vnoise(vec2(t * 1.3 + seed * 20.0, dist * 0.4), 5u) - 0.5) * 2.0;
    r = rotY(amount * wb * anim) * rotX(amount * wa * anim);
  }
  q = r * q + a_pivot;
  n = r * n;
  if (sprung) {
    // Roll about a point half a metre above the ground.
    vec3 c = vec3(0.0, 0.5, 0.0);
    q = rotZ(roll) * (q - c) + c;
    n = rotZ(roll) * n;
    q.y += dy;
  }
  q *= vec3(i_look.y * i_look.z, i_look.y, i_look.y);
  vec3 fwd, right;
  pos = toWorld(q, a_motion.z, fwd, right);
#ifdef WH_LOCAL_UP
  nrm = normalize(right * n.x + cross(right, fwd) * n.y + fwd * n.z);
#else
  nrm = normalize(right * n.x + vec3(0.0, n.y, 0.0) + fwd * n.z);
#endif
  return true;
}
vec3 rigColor() {
  vec3 c = a_color.rgb;
  if (a_motion.w >= 0.0) {
    int s = int(a_motion.w + 0.5);
    c *= unpackRgb(s == 0 ? i_colors.x : s == 1 ? i_colors.y : s == 2 ? i_colors.z : i_colors.w);
  }
  return c;
}
`;

const BODY_VS = /* glsl */ `#include <header>
#include <noise>
${RIG_POSE_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_finish;
void main() {
  vec3 pos, nrm;
  if (!rigPose(pos, nrm)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  v_world = pos;
  v_normal = nrm;
  v_color = rigColor();
  v_finish = a_color.a;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

/** Depth of posed bodies for the shadow map (`RigLayerOptions.castShadow` without a shadow pass of the game). */
const DEPTH_POSE_VS = /* glsl */ `#include <header>
#include <noise>
${RIG_POSE_GLSL}
uniform mat4 u_lightRender;
void main() {
  vec3 pos, nrm;
  if (!rigPose(pos, nrm)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = u_lightRender * vec4(pos, 1.0);
}`;

const BODY_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
uniform vec4 u_rig2;
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_finish;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 0.6);
#ifdef WH_LOCAL_UP
  float nUp = dot(n, localUp(v_world));
#else
  float nUp = n.y;
#endif
  float lamps = u_rig2.z;
  vec3 col = v_color;
  int finish = int(v_finish + 0.5);
  vec3 c;
  if (finish == 1 || finish == 4) {
    // Glass: dark, with a faint sky sheen on upward faces; a lit interior glows at night.
    c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0) * 0.45 + u_skyFill.rgb * 0.18 * (0.4 + 0.6 * max(nUp, 0.0)));
    if (finish == 4) c = mix(c, vec3(0.95, 0.86, 0.62), 0.75 * lamps);
  } else {
    if (finish == 5) {
      // Paving: darker joints of a 0.5 m grid in world space, on upward faces.
      vec2 g = abs(fract(v_world.xz * 2.0) - 0.5);
      col *= 1.0 - 0.22 * smoothstep(0.43, 0.48, max(g.x, g.y)) * max(nUp, 0.0);
    }
    c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
    if (finish == 2) c = mix(c, vec3(1.0, 0.96, 0.84) * 1.15, 0.2 + 0.8 * lamps);
    else if (finish == 3) c = mix(c, vec3(0.95, 0.12, 0.08), 0.3 + 0.6 * lamps);
  }
  o_color = vec4(applyFog(c, v_world), 1.0);
}`;

const SHADOW_VS = /* glsl */ `#include <header>
${INPUTS}
${FRAME}
out vec2 v_local;
void main() {
  v_local = a_pos.xz;
  float s = i_look.y;
  // Half size and forward offset come in the pivot; the quad leans a little away from a low sun.
  vec3 q = vec3(a_pos.x * a_pivot.x * s * i_look.z, 0.04, a_pos.z * a_pivot.y * s + a_pivot.z * s);
  vec3 fwd, right;
  vec3 w = toWorld(q, a_motion.z, fwd, right);
#ifdef WH_LOCAL_UP
  // The same lean along the local horizon.
  vec3 up = localUp(w);
  float high = dot(u_sunDir.xyz, up);
  vec3 away = -(u_sunDir.xyz - up * high) / max(high, 0.35);
  w += away * 0.15 * s * clamp(high * 4.0, 0.0, 1.0);
#else
  vec2 away = -u_sunDir.xz / max(u_sunDir.y, 0.35);
  w.xz += away * 0.15 * s * clamp(u_sunDir.y * 4.0, 0.0, 1.0);
#endif
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

const SHADOW_FS = /* glsl */ `#include <header>
in vec2 v_local;
out vec4 o_color;
void main() {
  vec2 a = abs(v_local);
  float d = pow(pow(a.x, 4.0) + pow(a.y, 4.0), 0.25);
  o_color = vec4(0.0, 0.0, 0.0, 0.42 * (1.0 - smoothstep(0.45, 1.0, d)));
}`;

// The device merges a partial state into the current one, so the body states every field it relies on.
const BODY_MATERIAL: MaterialDesc = {
  name: 'rig',
  attribs: RIG_ATTRIBS,
  passes: { color: { vs: BODY_VS, fs: BODY_FS } },
  state: { color: { depthTest: true, depthWrite: true, cullBack: true, blend: null, polygonOffset: null } },
};
const CONTACT_MATERIAL: MaterialDesc = {
  name: 'rig-contact',
  attribs: RIG_ATTRIBS,
  passes: { color: { vs: SHADOW_VS, fs: SHADOW_FS } },
  state: { color: { depthWrite: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, polygonOffset: [-1, -2] } },
};
const DEPTH_MATERIAL: MaterialDesc = {
  name: 'rig-depth',
  attribs: RIG_ATTRIBS,
  passes: { shadow: { vs: DEPTH_POSE_VS, fs: DEPTH_FS } },
};

/** The same description with the extended pose (`WH_RIG_EXT` defined after the header line of every pass). */
function extended(desc: MaterialDesc): MaterialDesc {
  const passes: MaterialDesc['passes'] = {};
  for (const [pass, src] of Object.entries(desc.passes) as [PassName, MaterialDesc['passes'][PassName]][]) {
    passes[pass] = src === undefined || src === 'depth' ? src : { vs: src.vs.replace('#include <header>\n', '#include <header>\n#define WH_RIG_EXT 1\n'), fs: src.fs };
  }
  return { ...desc, name: `${desc.name}-ext`, passes };
}

export interface RigLayerOptions {
  /**
   * The game's material for the bodies instead of the engine's: attributes `RIG_ATTRIBS`, a vertex shader over the
   * include `<rig-pose>` (after `<header>` and `<noise>`; `rigPose`, `rigColor`), any fragment shader. The layer sets
   * `u_rig`, `u_rig2` (`u_rig3` for extended kinds) and `u_shadowMap`. A `shadow` pass of it is used when
   * `castShadow` is on. Default: the engine's material, drawn exactly as before this option existed.
   */
  material?: MaterialDesc;
  /** Draw the posed bodies into the shadow map (a dynamic caster, every instance, near detail). Default false. */
  castShadow?: boolean;
  /** Soft contact shadows under the rigs. Default true. */
  contactShadows?: boolean;
}

interface Lod {
  data: Float32Array;
  buffer: InstanceBuffer;
  body: Mesh;
  contact: Mesh;
  count: number;
}

interface Kind {
  desc: RigDesc;
  capacity: number;
  source: Float32Array;
  count: number;
  near: Lod;
  far: Lod;
  /** Every instance for the shadow pass (`castShadow` only). */
  shade: { buffer: InstanceBuffer; body: Mesh } | null;
  rig: [number, number, number, number];
  rig2: [number, number, number, number];
  /** Drawn by the extended program; its gait mode, dip and the two walk speeds. */
  ext: boolean;
  rig3: [number, number, number, number];
}

export interface RigCounts {
  near: number;
  far: number;
  hidden: number;
}

export class RigLayer implements Layer {
  /** Lamps and lit interiors, 0 by day to 1 at night; the app sets it from the light. */
  lamps = 0;
  /** Off draws nothing. */
  enabled = true;
  /** Counts of the last drawn frame, all kinds together. */
  readonly counts: RigCounts = { near: 0, far: 0, hidden: 0 };
  /** `'dynamic'` with `castShadow`; unset otherwise (a layer that casts nothing, as before the option existed). */
  readonly shadowCasters?: 'dynamic';
  private readonly kinds: Kind[] = [];
  private readonly bodyDesc: MaterialDesc;
  private readonly body: Material;
  private readonly contact: Material;
  /** The program of the extended pose, made by the first kind that needs it. */
  private bodyExt: Material | null = null;
  private readonly renderer: Renderer;
  private readonly castShadow: boolean;
  private readonly contactShadows: boolean;
  private depth: Material | null = null;
  private depthExt: Material | null = null;
  /** Records changed since the layer was last drawn into the shadow map. */
  private shadowChanged = false;

  constructor(renderer: Renderer, o: RigLayerOptions = {}) {
    this.renderer = renderer;
    if (!renderer.includes.has('rig-pose')) renderer.includes.set('rig-pose', RIG_POSE_GLSL);
    this.bodyDesc = o.material ?? BODY_MATERIAL;
    this.body = renderer.material(this.bodyDesc);
    this.contact = renderer.material(CONTACT_MATERIAL);
    this.castShadow = o.castShadow ?? false;
    this.contactShadows = o.contactShadows ?? true;
    if (this.castShadow) {
      this.shadowCasters = 'dynamic';
      this.depth = renderer.material(this.depthDesc());
    }
  }

  /** Adds a kind of rig that can be drawn up to `capacity` times; returns its index for `set`. */
  addKind(desc: RigDesc, capacity: number): number {
    const ext = rigExtended(desc);
    if (ext && !this.bodyExt) this.bodyExt = this.renderer.material(extended(this.bodyDesc));
    if (ext && this.castShadow && !this.depthExt) this.depthExt = this.renderer.material(extended(this.depthDesc()));
    const bodyMaterial = ext ? this.bodyExt! : this.body;
    const lod = (far: boolean): Lod => {
      const data = new Float32Array(capacity * RIG_INSTANCE_FLOATS);
      const buffer = this.renderer.createInstances({ layout: RIG_INSTANCE_LAYOUT, data });
      return { data, buffer, body: this.renderer.createMesh(rigMesh(desc, far), bodyMaterial, buffer), contact: this.renderer.createMesh(rigShadowMesh(desc), this.contact, buffer), count: 0 };
    };
    const legs = desc.parts.find((p) => p.motion === 'limb');
    const source = new Float32Array(capacity * RIG_INSTANCE_FLOATS);
    let shade: Kind['shade'] = null;
    if (this.castShadow) {
      const buffer = this.renderer.createInstances({ layout: RIG_INSTANCE_LAYOUT, data: source });
      shade = { buffer, body: this.renderer.createMesh(rigMesh(desc, false), ext ? this.depthExt! : this.depth!, buffer) };
    }
    this.kinds.push({
      desc,
      capacity,
      source,
      count: 0,
      near: lod(false),
      far: lod(true),
      shade,
      rig: [desc.stride ?? 0, desc.steerBase ?? 0, desc.roll ?? 0, desc.rollLimit ?? 0],
      rig2: [desc.bob ?? 0, 1, 0, legs?.amount ?? 1],
      ext,
      rig3: desc.gait === 'free' ? [1, desc.dip ?? 0, desc.walkSpeed?.[0] ?? 0.15, desc.walkSpeed?.[1] ?? 0.9] : [0, 0, 0.15, 0.9],
    });
    return this.kinds.length - 1;
  }

  /** Removes every kind and deletes its GPU objects. Kind indices returned by `addKind` are invalid afterwards. */
  clear(): void {
    const device = this.renderer.device;
    for (const k of this.kinds) {
      for (const lod of [k.near, k.far]) {
        device.deleteMesh(lod.body);
        device.deleteMesh(lod.contact);
        device.deleteInstances(lod.buffer);
      }
      if (k.shade) {
        device.deleteMesh(k.shade.body);
        device.deleteInstances(k.shade.buffer);
      }
    }
    this.kinds.length = 0;
    this.shadowChanged = true;
  }

  /** The instance records of a kind for this frame (`RIG_INSTANCE_FLOATS` each); the layer culls them when drawing. */
  set(kind: number, data: Float32Array, count: number): void {
    const k = this.kinds[kind]!;
    const n = Math.min(count, k.capacity);
    k.source.set(data.subarray(0, n * RIG_INSTANCE_FLOATS));
    k.count = n;
    this.shadowChanged = true;
  }

  /** The buffer `set` copies from, to fill in place: write records, then call `commit`. */
  staging(kind: number): Float32Array {
    return this.kinds[kind]!.source;
  }

  commit(kind: number, count: number): void {
    const k = this.kinds[kind]!;
    k.count = Math.min(count, k.capacity);
    this.shadowChanged = true;
  }

  /**
   * With `castShadow`: true when records were set or committed since the layer was last drawn into the shadow map.
   * The pose also moves with the frame time; set the records every frame for moving shadows.
   */
  shadowDirty(): boolean {
    return this.castShadow && this.shadowChanged;
  }

  draw(ctx: DrawContext): void {
    if (!this.enabled) return;
    if (ctx.pass === 'shadow') {
      if (this.castShadow) this.drawShadow(ctx);
      return;
    }
    if (ctx.pass !== 'color') return;
    this.split(ctx);
    const device = ctx.device;
    // Bodies first (opaque, writing depth): the plain kinds, then those of the extended pose; then the blended contact
    // shadows of every kind, which a body in front hides.
    const passes: [Material, boolean, boolean | null][] = [[this.body, false, false]];
    if (this.bodyExt && this.kinds.some((k) => k.ext)) passes.push([this.bodyExt, false, true]);
    if (this.contactShadows) passes.push([this.contact, true, null]);
    for (const [material, contact, ext] of passes) {
      const program = material.program('color')!;
      device.setState(material.state.color ?? {});
      device.use(program);
      if (!contact) program.int('u_shadowMap', SHADOW_MAP_UNIT);
      for (const k of this.kinds) {
        if (ext !== null && k.ext !== ext) continue;
        for (const [lod, animate] of [[k.near, 1], [k.far, 0]] as const) {
          if (lod.count === 0) continue;
          const mesh = contact ? lod.contact : lod.body;
          program.set('u_rig', { vec4: k.rig });
          program.set('u_rig2', { vec4: [k.rig2[0], animate, this.lamps, k.rig2[3]] });
          if (ext) program.set('u_rig3', { vec4: k.rig3 });
          mesh.instances = lod.count;
          device.draw(mesh);
          ctx.count(mesh.triangles * lod.count);
        }
      }
    }
  }

  /** The shadow pass: every instance of every kind, posed at near detail. */
  private drawShadow(ctx: DrawContext): void {
    this.shadowChanged = false;
    const device = ctx.device;
    for (const [material, ext] of [[this.depth, false], [this.depthExt, true]] as const) {
      if (!material) continue;
      const program = material.program('shadow');
      if (!program) continue;
      let used = false;
      for (const k of this.kinds) {
        if (k.ext !== ext || !k.shade || k.count === 0) continue;
        if (!used) {
          const state = material.state.shadow;
          if (state) device.setState(state);
          device.use(program);
          program.mat4('u_lightRender', ctx.lightRender);
          used = true;
        }
        device.writeBuffer(k.shade.buffer.buffer, k.source, k.count * RIG_INSTANCE_FLOATS);
        program.set('u_rig', { vec4: k.rig });
        program.set('u_rig2', { vec4: [k.rig2[0], 1, this.lamps, k.rig2[3]] });
        if (ext) program.set('u_rig3', { vec4: k.rig3 });
        k.shade.body.instances = k.count;
        device.draw(k.shade.body);
        ctx.count(k.shade.body.triangles * k.count);
      }
    }
  }

  /** The material of the shadow pass: the game's when it has a `shadow` pass, else the engine's depth of the pose. */
  private depthDesc(): MaterialDesc {
    const own = this.bodyDesc.passes.shadow;
    if (own !== undefined && this.bodyDesc !== BODY_MATERIAL) return { ...this.bodyDesc, name: `${this.bodyDesc.name}-shadow`, passes: { shadow: own } };
    return DEPTH_MATERIAL;
  }

  /** Culls every kind against the view and sorts the rest into the near and far buffers, then uploads them. */
  private split(ctx: DrawContext): void {
    const view = ctx.view;
    const volume: CullVolume = view.cullVolume();
    const ax = view.axes();
    const f = ax.forward;
    const counts = this.counts;
    counts.near = counts.far = counts.hidden = 0;
    const S = RIG_INSTANCE_FLOATS;
    // With radial up a rig stands away from this point; null: along +y.
    const upC = this.renderer.upCenter();
    for (const k of this.kinds) {
      const d = k.desc;
      const farPx = d.farPx ?? 24;
      const hidePx = d.hidePx ?? 3;
      let nn = 0;
      let nf = 0;
      for (let i = 0; i < k.count; i++) {
        const o = i * S;
        const x = k.source[o]!, y = k.source[o + 1]!, z = k.source[o + 2]!;
        const scale = k.source[o + 17]!;
        const reach = d.radius * scale;
        const half = d.height * 0.5 * scale;
        if (upC) {
          const ux = x - upC[0], uy = y - upC[1], uz = z - upC[2];
          const lift = half / (Math.sqrt(ux * ux + uy * uy + uz * uz) || 1);
          if (!inside(volume, x + ux * lift, y + uy * lift, z + uz * lift, reach)) continue;
        } else if (!inside(volume, x, y + half, z, reach)) continue;
        const mpp = Math.max(1e-4, view.metresPerPixel + view.pixelGrowth * (f[0] * x + f[1] * y + f[2] * z - view.refDepth));
        const px = (d.height * scale) / mpp / view.dpr;
        if (px < hidePx) {
          counts.hidden++;
          continue;
        }
        const lod = px < farPx ? k.far : k.near;
        const at = (lod === k.far ? nf++ : nn++) * S;
        lod.data.set(k.source.subarray(o, o + S), at);
      }
      k.near.count = nn;
      k.far.count = nf;
      counts.near += nn;
      counts.far += nf;
      if (nn > 0) ctx.device.writeBuffer(k.near.buffer.buffer, k.near.data, nn * S);
      if (nf > 0) ctx.device.writeBuffer(k.far.buffer.buffer, k.far.data, nf * S);
    }
  }
}

function inside(v: CullVolume, x: number, y: number, z: number, r: number): boolean {
  if (v.kind === 'frustum') {
    for (const p of v.planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
    return true;
  }
  const a = v.axes;
  const u = a.right[0] * x + a.right[1] * y + a.right[2] * z - v.cx;
  const w = a.up[0] * x + a.up[1] * y + a.up[2] * z - v.cy;
  return Math.abs(u) <= v.halfW + r && Math.abs(w) <= v.halfH + r;
}
