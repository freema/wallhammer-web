// Small instances round the viewer, drawn from sets of records (`nearScatter` of gen-core): one instance buffer per
// kind with a fixed capacity, filled from the sets nearest the eye first.
//
// - A set (`put`) is one kind of the records of one square, relative to its anchor, a world point in doubles. The
//   layer keeps the sets it is given and drops none by itself.
// - `view` rebuilds the buffers only when the eye has moved more than `stepM` since the last rebuild, a set came or
//   went, or a gain changed by more than 0.01. A rebuild takes from every set the prefix of records that can still be
//   seen from the nearest point of its sphere (`nearCount`) and copies it with its positions moved to one anchor of
//   the layer (the eye of the rebuild, in doubles), so numbers on the GPU stay small. A full buffer leaves the rest
//   out and counts it as clipped: the hard ceiling.
// - The exact fade runs per instance in the vertex shader (`nearKeep` of the true distance to the eye), so a rebuild
//   changes no pixel. The bend in the wind follows two waves fixed to the world: the layer computes the phase of its
//   anchor per wave in doubles and the shader adds the part of the instance.
// - One draw per kind that has records, colour pass only, no shadow pass. With every gain 0 nothing is drawn or uploaded.
//
// The look is the app's: `NEAR_INSTANCE_GLSL` is a vertex include that places a vertex of the unit shape; the app's
// material lights and colours it.

import type { MeshData } from '../base/data.ts';
import type { Vec3 } from '../base/math.ts';
import { RAD_PER_TURN } from '../base/trig.ts';
import { NEAR_FADE_GLSL, NEAR_FLOATS, NEAR_LAYOUT, nearCount } from '../gen-core/near-scatter.ts';
import type { NearFade } from '../gen-core/near-scatter.ts';
import type { Device, InstanceBuffer, Mesh } from '../gpu/index.ts';
import { MeshLayer } from './renderer.ts';
import type { DrawContext, MeshLayerOptions } from './renderer.ts';

/** One kind: its unit shape (base y = 0, top y = 1), its fade, its ceiling and the tip shift per metre of height at wind 1. */
export interface NearKindDraw {
  mesh: MeshData;
  fade: NearFade;
  maxInstances: number;
  bendM: number;
}

/** One kind of one set: the anchor (a world point in doubles), a sphere round it that holds every record, the records. */
export interface NearPart {
  anchor: Vec3;
  radiusM: number;
  /** Records of one kind in the order of `nearScatter` (highest order first). */
  data: Float32Array;
}

/** The wind: unit direction along the ground in the frame of the anchors, strength 0–1, time in seconds. */
export interface NearWind {
  dir: Vec3;
  strength: number;
  timeS: number;
  /** Share of the two travelling waves, 0–1 (default 1); 0 leaves the steady lean alone. */
  waves?: number;
}

export interface NearInstanceLayerOptions extends Omit<MeshLayerOptions, 'mesh'> {
  kinds: readonly NearKindDraw[];
  /** Metres the eye may move before the buffers are rebuilt. Default 2. */
  stepM?: number;
  /** World position of the render origin (doubles), asked at every draw. Default the world origin. */
  origin?: () => readonly [number, number, number];
}

/** Lengths of the two waves of the wind in metres, and their speeds in radians per second. */
const WAVE_M: readonly [number, number] = [9, 3.5];
/** Time is wrapped to this many seconds: 1.7 and 2.9 radians per second make whole turns in it. */
const WRAP_S = 10 * RAD_PER_TURN;

interface KindState {
  draw: NearKindDraw;
  instances: InstanceBuffer;
  mesh: Mesh;
  scratch: Float32Array;
  count: number;
  gain: number;
}

/** Instances of several kinds round the eye; see the header of this file. */
export class NearInstanceLayer extends MeshLayer {
  wind: NearWind = { dir: [1, 0, 0], strength: 0, timeS: 0 };
  readonly stats = { parts: 0, held: 0, drawn: 0, clipped: 0, rebuilds: 0, bytes: 0 };
  private readonly device: Device;
  private readonly kinds: KindState[];
  private readonly parts = new Map<string, NearPart>();
  private readonly stepM: number;
  private readonly origin: () => readonly [number, number, number];
  private dirty = true;
  /** Anchor of the layer: the eye of the last rebuild. */
  private anchor: Vec3 = [0, 0, 0];
  private eye: Vec3 = [0, 0, 0];

  constructor(device: Device, o: NearInstanceLayerOptions) {
    super({ ...o, passes: o.passes ?? ['color'] });
    this.device = device;
    this.stepM = o.stepM ?? 2;
    this.origin = o.origin ?? ((): readonly [number, number, number] => [0, 0, 0]);
    let bytes = 0;
    this.kinds = o.kinds.map((draw) => {
      const instances = device.createInstances({ layout: NEAR_LAYOUT, data: new Float32Array(draw.maxInstances * NEAR_FLOATS) });
      const mesh = device.createMesh(draw.mesh, this.material.attribs, instances);
      mesh.instances = 0;
      bytes += draw.maxInstances * NEAR_LAYOUT.stride + mesh.bytes;
      return { draw, instances, mesh, scratch: new Float32Array(draw.maxInstances * NEAR_FLOATS), count: 0, gain: -1 };
    });
    this.stats.bytes = bytes;
  }

  private static id(key: string, kind: number): string {
    return `${kind}|${key}`;
  }

  /** Adds, replaces or (with null) removes one kind of one set. */
  put(key: string, kind: number, part: NearPart | null): void {
    const id = NearInstanceLayer.id(key, kind);
    if (part) this.parts.set(id, part);
    else if (!this.parts.delete(id)) return;
    this.dirty = true;
  }

  has(key: string, kind: number): boolean {
    return this.parts.has(NearInstanceLayer.id(key, kind));
  }

  /** Once per frame: the eye in world doubles and a gain 0–1 per kind that scales its reach. */
  view(eye: Vec3, gains: readonly number[]): void {
    this.eye = [eye[0], eye[1], eye[2]];
    const dx = eye[0] - this.anchor[0];
    const dy = eye[1] - this.anchor[1];
    const dz = eye[2] - this.anchor[2];
    let rebuild = this.dirty || dx * dx + dy * dy + dz * dz > this.stepM * this.stepM;
    for (let k = 0; k < this.kinds.length; k++) if (Math.abs((gains[k] ?? 0) - this.kinds[k]!.gain) > 0.01) rebuild = true;
    if (!rebuild) return;
    this.dirty = false;
    this.anchor = [eye[0], eye[1], eye[2]];
    this.stats.rebuilds++;
    // Every set by kind, nearest first, ties by key.
    const byKind: { id: string; part: NearPart; dist: number }[][] = this.kinds.map(() => []);
    let held = 0;
    for (const [id, part] of this.parts) {
      const kind = Number(id.slice(0, id.indexOf('|')));
      const list = byKind[kind];
      if (!list) continue;
      const ax = part.anchor[0] - eye[0];
      const ay = part.anchor[1] - eye[1];
      const az = part.anchor[2] - eye[2];
      list.push({ id, part, dist: Math.sqrt(ax * ax + ay * ay + az * az) });
      held += part.data.length / NEAR_FLOATS;
    }
    let drawn = 0;
    let clipped = 0;
    for (let k = 0; k < this.kinds.length; k++) {
      const s = this.kinds[k]!;
      const gain = Math.min(1, Math.max(0, gains[k] ?? 0));
      s.gain = gain;
      let count = 0;
      if (gain > 0) {
        const list = byKind[k]!.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const cap = s.draw.maxInstances;
        for (const { part, dist } of list) {
          const n = nearCount(part.data, 0, part.data.length / NEAR_FLOATS, s.draw.fade, gain, Math.max(0, dist - part.radiusM - this.stepM));
          const take = Math.min(n, cap - count);
          clipped += n - take;
          if (take <= 0) continue;
          const ox = part.anchor[0] - eye[0];
          const oy = part.anchor[1] - eye[1];
          const oz = part.anchor[2] - eye[2];
          const out = s.scratch;
          out.set(part.data.subarray(0, take * NEAR_FLOATS), count * NEAR_FLOATS);
          for (let i = 0; i < take; i++) {
            const at = (count + i) * NEAR_FLOATS;
            out[at] = out[at]! + ox;
            out[at + 1] = out[at + 1]! + oy;
            out[at + 2] = out[at + 2]! + oz;
          }
          count += take;
        }
      }
      if (count > 0) this.device.writeBuffer(s.instances.buffer, s.scratch, count * NEAR_FLOATS);
      s.count = count;
      s.mesh.instances = count;
      drawn += count;
    }
    this.stats.parts = this.parts.size;
    this.stats.held = held;
    this.stats.drawn = drawn;
    this.stats.clipped = clipped;
  }

  override draw(ctx: DrawContext): void {
    if (this.kinds.every((s) => s.count === 0)) return;
    const program = this.begin(ctx);
    if (!program) return;
    const o = this.origin();
    const a = this.anchor;
    const w = this.wind;
    const waves = Math.min(1, Math.max(0, w.waves ?? 1));
    const t = w.timeS - Math.floor(w.timeS / WRAP_S) * WRAP_S;
    // Phase of the layer's anchor along the wind per wave, in doubles, wrapped to one turn.
    const along = a[0] * w.dir[0] + a[1] * w.dir[1] + a[2] * w.dir[2];
    const phase = (m: number): number => {
      const turns = along / m;
      return (turns - Math.floor(turns)) * RAD_PER_TURN;
    };
    program.vec3('u_nearOffset', a[0] - o[0], a[1] - o[1], a[2] - o[2]);
    program.vec3('u_nearEye', this.eye[0] - o[0], this.eye[1] - o[1], this.eye[2] - o[2]);
    program.set('u_nearWave', { vec4: [phase(WAVE_M[0]), phase(WAVE_M[1]), waves, 0] });
    for (const s of this.kinds) {
      if (s.count === 0) continue;
      const f = s.draw.fade;
      const b = w.strength * s.draw.bendM;
      program.vec3('u_nearFade', s.gain * f.reachM, f.band, f.softM);
      program.set('u_nearWind', { vec4: [w.dir[0] * b, w.dir[1] * b, w.dir[2] * b, t] });
      ctx.device.draw(s.mesh);
      ctx.count(s.mesh.triangles * s.count);
    }
  }

  dispose(): void {
    for (const s of this.kinds) {
      this.device.deleteMesh(s.mesh);
      this.device.deleteInstances(s.instances);
      s.count = 0;
    }
    this.parts.clear();
  }
}

/**
 * Vertex include for the app's material (after `#include <header>`). Declares the instance attributes `i_base`,
 * `i_shape`, `i_color` and the uniforms the layer sets per draw (`u_nearOffset`: layer anchor − render origin;
 * `u_nearEye`: the eye in render space; `u_nearFade`: gain · reach, band, soft; `u_nearWind`: xyz = direction ·
 * strength · bendM, w = time; `u_nearWave`: phases of the anchor per wave and the share of the waves). Gives
 * `nearBase()` (the base in render space), `nearScale()` (0–1, the fade), `nearAxes(base)` (the instance's frame:
 * upright along `localFrame`, turned about up) and `nearPoint(unitPos)`: the vertex in render space, scaled by the
 * fade and bent by the wind.
 */
export const NEAR_INSTANCE_GLSL = /* glsl */ `
${NEAR_FADE_GLSL}
uniform vec3 u_nearOffset;
uniform vec3 u_nearEye;
uniform vec3 u_nearFade;
uniform vec4 u_nearWind;
uniform vec4 u_nearWave;
in vec4 i_base;   // xyz relative to the layer's anchor, w order
in vec4 i_shape;  // width, height, turn about up, bend
in vec4 i_color;  // rgb, variant
vec3 nearBase() { return i_base.xyz + u_nearOffset; }
float nearScale() { return nearKeep(u_nearFade, i_base.w, distance(nearBase(), u_nearEye)); }
mat3 nearAxes(vec3 base) {
  float c = cos(i_shape.z), s = sin(i_shape.z);
  return localFrame(base) * mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
vec3 nearPoint(vec3 unitPos) {
  vec3 base = nearBase();
  float k = nearScale();
  vec3 p = base + nearAxes(base) * (unitPos * vec3(i_shape.x, i_shape.y, i_shape.x) * k);
  float wl = length(u_nearWind.xyz);
  if (wl > 0.0) {
    // Two waves fixed to the world (${WAVE_M[0]} m and ${WAVE_M[1]} m long) travel along the wind.
    float along = dot(i_base.xyz, u_nearWind.xyz / wl);
    float t = u_nearWind.w;
    float sway = 0.35 + u_nearWave.z * (0.5 * sin(u_nearWave.x + along * ${(RAD_PER_TURN / WAVE_M[0]).toFixed(7)} - 1.7 * t)
      + 0.3 * sin(u_nearWave.y + along * ${(RAD_PER_TURN / WAVE_M[1]).toFixed(7)} + 2.9 * t + 6.28 * i_color.w));
    float y = max(unitPos.y, 0.0);
    p += u_nearWind.xyz * (i_shape.w * i_shape.y * y * y * sway * k);
  }
  return p;
}
`;
