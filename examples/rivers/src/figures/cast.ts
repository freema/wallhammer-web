// The figures on screen: any number of them, each given as a record (`FigureState`, state.ts): a kind, a look, a place
// on the ground with a forward and an up direction, a motion name and a motion time. Everything a figure shows follows
// from that record alone.
//
// How it is drawn. Every part of a kind (a mesh on one bone) owns one instance set of the engine (`instanceSet`): one
// record per figure, the bone's 3 × 4 matrix in world space, the look's tint for the part and a glow. Each frame
// `FigureCast` samples the motions on the CPU (`wallhammer-web/motion`: `Pose`, `solvePose`) and writes the records;
// a set is one instanced draw, kinds without figures draw nothing. The material lights the parts as the ground's
// material lights the ground and the trees (the environment's sun and sky, the engine's shadow map, fog and the sky's
// haze), and the figures cast shadows into the same map.
//
// Why not `RigLayer`: its poses are closed forms of the distance travelled, written in the vertex shader. The
// pathfinder's motions are functions of a time on the CPU (a cloak in the wind, lanterns that hang plumb), and this
// layer shows them as they are written.

import type { MaterialDesc, Vec3 } from 'wallhammer-web/base';
import { Pose, blendPose, solvePose } from 'wallhammer-web/motion';
import { DEPTH_FS, INSTANCE_SET_FLOATS, INSTANCE_SET_GLSL, InstanceSetLayer, instanceSet, instanceSetAttribs } from 'wallhammer-web/render';
import type { InstanceSet, Renderer } from 'wallhammer-web/render';
import type { FigureInput, FigureKind, FigureMotion } from '../../../shared/src/figures/kind.ts';
import { figureKind } from './state.ts';
import type { FigureKindName, FigureState } from './state.ts';

const ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2, ...instanceSetAttribs(3) } as const;

const FIGURE_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec4 a_color; // rgb colour, w material: 0 plain, 1 times the instance's tint, 2 a light, 3 a light in the dark
${INSTANCE_SET_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out vec2 v_light; // x material, y the instance's glow
void main() {
  v_world = instancePoint(a_pos);
  v_normal = instanceNormal(a_normal);
  v_color = a_color.w > 0.5 && a_color.w < 1.5 ? a_color.rgb * i_extra.rgb : a_color.rgb;
  v_light = vec2(a_color.w, i_extra.w);
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const FIGURE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in vec2 v_light;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 1.0);
  // How far the sun is down: 0 by day, 1 from a little after sunset.
  float dark = 1.0 - smoothstep(-0.06, 0.3, u_sunDir.y);
  vec3 lit = v_color * u_warmTint.rgb * lightOn(n, sun, 1.0);
  // Lights: a lantern or a torch shines by day and more by night; embers are dull by day and glow in the dark.
  if (v_light.x > 2.5) lit = mix(lit, v_color * FIGURE_GLOW, (0.55 + 0.45 * dark) * v_light.y);
  else if (v_light.x > 1.5) lit = v_color * (FIGURE_GLOW * v_light.y * (0.8 + 0.5 * dark));
  vec3 c = toDisplay(lit);
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`;

const FIGURE_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
${INSTANCE_SET_GLSL}
void main() {
  gl_Position = u_lightRender * vec4(instancePoint(a_pos), 1.0);
}`;

/** The figures' material. `glow` is the light of a lantern's glass against the light of a white face in full sun (found by eye). */
const figureMaterial = (glow: number): MaterialDesc => ({
  name: 'figure',
  attribs: ATTRIBS,
  passes: {
    color: { vs: FIGURE_VS, fs: FIGURE_FS.replaceAll('FIGURE_GLOW', glow.toFixed(3)) },
    shadow: { vs: FIGURE_DEPTH_VS, fs: DEPTH_FS },
  },
});

/** The GPU side of a kind: one set per part. */
interface KindSets {
  kind: FigureKind;
  /** Per part of the kind: its set. */
  sets: InstanceSet[];
  pose: Pose;
  other: Pose;
  world: Float64Array;
  /** Figures written this frame. */
  count: number;
  /** Distance of the nearest one from the eye this frame. */
  nearest: number;
}

const WHITE = [1, 1, 1] as const;
const input: FigureInput = { seed: 0, param: 0 };
const root = new Float64Array(12);

function motionOf(kind: FigureKind, name: string): FigureMotion {
  const m = kind.motions[name];
  if (!m) throw new Error(`figure ${kind.name}: no motion ${name} (has ${Object.keys(kind.motions).join(', ')})`);
  return m;
}

/** The figure's root matrix (columns left, up, forward, then the place). */
function rootOf(s: FigureState, out: Float64Array): void {
  const u = s.up, f0 = s.forward;
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  const ux = u[0] / ul, uy = u[1] / ul, uz = u[2] / ul;
  const d = f0[0] * ux + f0[1] * uy + f0[2] * uz;
  let fx = f0[0] - ux * d, fy = f0[1] - uy * d, fz = f0[2] - uz * d;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  const k = s.scale ?? 1;
  out[0] = (uy * fz - uz * fy) * k;
  out[1] = (uz * fx - ux * fz) * k;
  out[2] = (ux * fy - uy * fx) * k;
  out[3] = ux * k;
  out[4] = uy * k;
  out[5] = uz * k;
  out[6] = fx * k;
  out[7] = fy * k;
  out[8] = fz * k;
  out[9] = s.position[0];
  out[10] = s.position[1];
  out[11] = s.position[2];
}

/** Samples a figure's pose (its motion, and the blended one) into `pose`; `other` is scratch. */
function samplePose(kind: FigureKind, s: FigureState, pose: Pose, other: Pose): FigureMotion {
  input.seed = s.seed ?? 0;
  input.param = s.param ?? 0;
  const m = motionOf(kind, s.motion);
  pose.reset();
  m.sample(pose, s.time, input);
  const b = s.blend;
  if (b && b.weight > 0) {
    other.reset();
    motionOf(kind, b.motion).sample(other, b.time, input);
    blendPose(pose, pose, other, Math.min(1, b.weight));
  }
  return m;
}

export interface FigureCastOptions {
  /** Whether near figures are drawn into the shadow map (each kind within its own range). Default true. */
  shadows?: boolean;
  /** Light of a lantern's glass against a white face in full sun. Default 2.4. */
  glow?: number;
}

export class FigureCast {
  /** The layer that draws the figures; add it to the engine before the layers that blend (the water). */
  readonly layer: InstanceSetLayer;
  /** The figures of the frame. Assign a new list (or change the records) and the next `update` shows them. */
  figures: readonly FigureState[] = [];
  shadows: boolean;
  private readonly kinds = new Map<FigureKindName, KindSets>();

  constructor(renderer: Renderer, o: FigureCastOptions = {}) {
    this.shadows = o.shadows ?? true;
    this.layer = new InstanceSetLayer(renderer, { name: 'figures', material: renderer.material(figureMaterial(o.glow ?? 2.4)) });
  }

  /** Builds the meshes and the sets of kinds ahead of their first frame (a kind is otherwise built when first shown). */
  prepare(kinds: readonly FigureKindName[]): void {
    for (const k of kinds) this.setsOf(k);
  }

  private setsOf(name: FigureKindName): KindSets {
    let k = this.kinds.get(name);
    if (k) return k;
    const kind = figureKind(name);
    const sets = kind.parts.map((part, i) => {
      const set = instanceSet(part.mesh, kind.capacity, { name: `${kind.name} ${kind.skeleton.names[part.bone]} ${i}`, castShadow: false });
      this.layer.add(set);
      return set;
    });
    k = { kind, sets, pose: new Pose(kind.skeleton), other: new Pose(kind.skeleton), world: new Float64Array(kind.skeleton.count * 12), count: 0, nearest: Infinity };
    this.kinds.set(name, k);
    return k;
  }

  /**
   * Poses every figure and writes its records; `eye` is the camera's world position (for the shadows' range). Call it
   * before the frame is drawn (the layer uploads the records at the start of the frame).
   */
  update(eye: Vec3): void {
    for (const k of this.kinds.values()) {
      k.count = 0;
      k.nearest = Infinity;
    }
    for (const s of this.figures) {
      const k = this.setsOf(s.kind);
      const i = k.count;
      if (i >= k.kind.capacity) continue;
      k.count++;
      const motion = samplePose(k.kind, s, k.pose, k.other);
      rootOf(s, root);
      solvePose(k.kind.skeleton, k.pose, root, k.world);
      const look = k.kind.look(s.variant ?? 0);
      const glow = s.glow ?? 1;
      const hide = motion.hide;
      const parts = k.kind.parts;
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p]!;
        const out = k.sets[p]!.data, o = i * INSTANCE_SET_FLOATS, w = part.bone * 12;
        const hidden = (part.feature !== 0 && (look.features & part.feature) === 0) || (hide !== undefined && hide.includes(part.bone));
        if (hidden) for (let j = 0; j < 12; j++) out[o + j] = 0;
        else for (let j = 0; j < 12; j++) out[o + j] = k.world[w + j]!;
        const tint = look.colors[part.slot] ?? WHITE;
        out[o + 12] = tint[0];
        out[o + 13] = tint[1];
        out[o + 14] = tint[2];
        out[o + 15] = glow;
      }
      const d = Math.hypot(s.position[0] - eye[0], s.position[1] - eye[1], s.position[2] - eye[2]);
      if (d < k.nearest) k.nearest = d;
    }
    for (const k of this.kinds.values()) {
      const cast = this.shadows && k.count > 0 && k.nearest < k.kind.shadowRangeM;
      for (const set of k.sets) {
        if (set.count === 0 && k.count === 0) continue;
        set.count = k.count;
        set.castShadow = cast;
        set.dirty = true;
      }
    }
  }

  /** Figures drawn, sets (draw calls of the colour pass) and triangles in the last frame. */
  stats(): { figures: number; sets: number; shadowSets: number; triangles: number } {
    let figures = 0, sets = 0, shadowSets = 0;
    for (const k of this.kinds.values()) {
      figures += k.count;
      if (k.count > 0) for (const s of k.sets) (sets++, s.castShadow && shadowSets++);
    }
    return { figures, sets, shadowSets, triangles: this.layer.triangles };
  }
}
