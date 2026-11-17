// Point lights: a list of plain records the owner may change at any time, and per frame the few that matter most for
// the eye, packed into one uniform block (`PointLights`) uploaded once per frame. Any material reads them through the
// include `<point-lights>` (registered by the set): `pointLights(world, normal, wrap)`.
//
// The cost per pixel does not grow with the number of lights. A draw names at most `POINT_LIGHTS_PER_DRAW` of the
// selected lights in two `ivec4` uniforms (`u_lightListA`, `u_lightListB`); the shader visits only those. `PieceLayer`
// fills the list per piece from the lights whose sphere reaches the piece's box (`bindFor`); a piece that more lights
// reach gets the whole selection rather than lose some (so the cost per pixel is bounded by `max`, never by the number
// of lights in the set; `crowdedDraws` counts those draws). A draw that sets no list
// sees the whole selection (the uniforms start at 0), as an instanced set spread over the scene does (`bindAll`).
//
// Encoding of the list: entry k holds selected light index + 1; 0 ends the list. A first entry of 0 means "no list:
// the whole selection", −1 means "no light".
//
// Selection, packing and the per-draw lists allocate nothing: the arrays are made with the set.

import type { Box3 } from '../base/view.ts';
import type { Program, UniformBlock } from '../gpu/index.ts';
import type { Renderer } from './renderer.ts';

/**
 * Binding point of the `PointLights` uniform block. Programs get their block bound to it by the device
 * (`UBO_BINDING.PointLights` in gpu); the value must stay equal to it.
 */
export const POINT_LIGHTS_BINDING = 2;

/** Most lights one draw visits (two `ivec4` of indices). */
export const POINT_LIGHTS_PER_DRAW = 8;

/** A point light. Plain data: change any field at any time, the next `update` reads it. */
export interface PointLight {
  /** Position in the coordinates the renderer draws in. */
  position: [number, number, number];
  /** Linear colour (0–1 per channel, may exceed 1). */
  color: [number, number, number];
  /** Reach in metres: the light fades to zero there. */
  radius: number;
  /** Brightness multiplier. */
  intensity: number;
  /** Flicker 0–1 (0 steady). The phase follows the light, not its slot in the selection. */
  flicker?: number;
  /**
   * Gain group (default 0): the light's brightness is also multiplied by `PointLightSet.gains[group]`, which the owner
   * changes at run time (for example to fade a whole group in and out).
   */
  group?: number;
}

export interface PointLightSetOptions {
  /** Most lights selected per frame (the size of the uniform block). Default 32. */
  max?: number;
  /** Number of gain groups (`gains`). Default 4. */
  groups?: number;
  /** Lights darker than this after gains are skipped. Default 0.02. */
  threshold?: number;
}

/** GLSL of the `<point-lights>` include for a block of `max` lights. Needs `u_time` of the Frame block. */
export function pointLightsGlsl(max: number): string {
  return /* glsl */ `
layout(std140) uniform PointLights {
  vec4 u_pointLights[${max * 2}]; // per light: xyz position, w radius; rgb colour × intensity × gain, w id + flicker
  vec4 u_pointLightInfo;          // x lights in the block
};
uniform ivec4 u_lightListA;
uniform ivec4 u_lightListB;
vec3 pointLightAt(int i, vec3 w, vec3 n, float wrap) {
  vec4 a = u_pointLights[i * 2];
  vec4 b = u_pointLights[i * 2 + 1];
  vec3 d = a.xyz - w;
  float d2 = dot(d, d);
  float r2 = a.w * a.w;
  if (d2 >= r2) return vec3(0.0);
  float att = 1.0 - d2 / r2;
  att *= att;
  float lam = clamp((dot(n, d * inversesqrt(d2 + 1e-4)) + wrap) / (1.0 + wrap), 0.0, 1.0);
  float fl = fract(b.w);
  float fi = floor(b.w);
  float t = u_time.x;
  float flick = 1.0 - fl * (0.35 + 0.35 * sin(t * 8.7 + fi * 7.31) * sin(t * 5.3 + fi * 3.17) + 0.3 * sin(t * 13.1 + fi));
  return b.rgb * att * lam * flick;
}
// Sum of the point lights at world point w with unit normal n; wrap > 0 lets light reach round the terminator.
vec3 pointLights(vec3 w, vec3 n, float wrap) {
  vec3 sum = vec3(0.0);
  int first = u_lightListA.x;
  if (first < 0) return sum;
  if (first == 0) {
    int c = int(u_pointLightInfo.x);
    for (int i = 0; i < ${max}; i++) {
      if (i >= c) break;
      sum += pointLightAt(i, w, n, wrap);
    }
    return sum;
  }
  for (int k = 0; k < ${POINT_LIGHTS_PER_DRAW}; k++) {
    int id = k < 4 ? u_lightListA[k] : u_lightListB[k - 4];
    if (id <= 0) break;
    sum += pointLightAt(id - 1, w, n, wrap);
  }
  return sum;
}
`;
}

/**
 * A set of point lights: owns the `PointLights` uniform block and registers the `<point-lights>` include on the
 * renderer. Make it before compiling the materials that include it. Call `update(eye)` once per frame before rendering.
 */
export class PointLightSet {
  readonly max: number;
  /** Gain per group, 1 by default. Change at run time; read by `update`. */
  readonly gains: Float32Array;
  /** Lights darker than this after gains are skipped. */
  threshold: number;
  /** Lights selected in the last `update`. */
  count = 0;
  /**
   * Draws since the last `update` that more than `POINT_LIGHTS_PER_DRAW` selected lights reach, and that therefore
   * visit the whole selection (`bindFor`). Many of them mean the pieces are large for the lights; for statistics.
   */
  crowdedDraws = 0;

  private readonly list: PointLight[] = [];
  private readonly block: UniformBlock;
  /** The block's contents: two vec4 per light, then the info vec4. */
  private readonly data: Float32Array;
  private readonly best: Int32Array;
  private readonly score: Float64Array;
  /** Spheres of the selected lights, for the per-draw lists. */
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly sz: Float32Array;
  private readonly sr: Float32Array;
  private readonly ids = new Int32Array(POINT_LIGHTS_PER_DRAW);

  constructor(renderer: Renderer, o: PointLightSetOptions = {}) {
    this.max = Math.max(1, Math.floor(o.max ?? 32));
    this.gains = new Float32Array(Math.max(1, Math.floor(o.groups ?? 4))).fill(1);
    this.threshold = o.threshold ?? 0.02;
    this.data = new Float32Array(this.max * 8 + 4);
    this.best = new Int32Array(this.max);
    this.score = new Float64Array(this.max);
    this.sx = new Float32Array(this.max);
    this.sy = new Float32Array(this.max);
    this.sz = new Float32Array(this.max);
    this.sr = new Float32Array(this.max);
    renderer.includes.set('point-lights', pointLightsGlsl(this.max));
    this.block = renderer.device.uniformBlock(POINT_LIGHTS_BINDING, this.data, true);
  }

  /** Every light of the set (selected or not). */
  get lights(): readonly PointLight[] {
    return this.list;
  }

  add(light: PointLight): void {
    this.list.push(light);
  }

  addAll(lights: readonly PointLight[]): void {
    for (const l of lights) this.list.push(l);
  }

  /** Takes a light out; returns whether it was there. */
  remove(light: PointLight): boolean {
    const i = this.list.indexOf(light);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  clear(): void {
    this.list.length = 0;
  }

  private brightness(l: PointLight): number {
    const g = this.gains[l.group ?? 0] ?? 1;
    return l.intensity * g;
  }

  /**
   * Chooses up to `max` lights for the eye at (x, y, z): nearer and larger first, dark ones skipped. Packs and uploads
   * the block. Call once per frame before rendering.
   */
  update(x: number, y: number, z: number): void {
    const max = this.max;
    const best = this.best;
    const score = this.score;
    let n = 0;
    for (let i = 0; i < this.list.length; i++) {
      const l = this.list[i]!;
      if (l.radius <= 0 || this.brightness(l) < this.threshold) continue;
      const dx = l.position[0] - x, dy = l.position[1] - y, dz = l.position[2] - z;
      const s = Math.sqrt(dx * dx + dy * dy + dz * dz) - l.radius * 2;
      let k: number;
      if (n < max) k = n++;
      else if (s < score[max - 1]!) k = max - 1;
      else continue;
      // Insertion into the sorted list of the best so far.
      while (k > 0 && score[k - 1]! > s) {
        score[k] = score[k - 1]!;
        best[k] = best[k - 1]!;
        k--;
      }
      score[k] = s;
      best[k] = i;
    }
    const d = this.data;
    for (let k = 0; k < n; k++) {
      const id = best[k]!;
      const l = this.list[id]!;
      const on = this.brightness(l);
      const o = k * 8;
      d[o] = this.sx[k] = l.position[0];
      d[o + 1] = this.sy[k] = l.position[1];
      d[o + 2] = this.sz[k] = l.position[2];
      d[o + 3] = this.sr[k] = l.radius;
      d[o + 4] = l.color[0] * on;
      d[o + 5] = l.color[1] * on;
      d[o + 6] = l.color[2] * on;
      d[o + 7] = id + Math.min(Math.max(l.flicker ?? 0, 0), 0.999);
    }
    d[max * 8] = n;
    this.count = n;
    this.crowdedDraws = 0;
    this.block.update(d);
  }

  /**
   * Fills `out` with the indices of the selected lights whose sphere reaches the box, at most its length, in order of
   * importance. Returns how many reach the box, which may be more than `out` holds.
   */
  lightsFor(box: Box3, out: Int32Array): number {
    let m = 0;
    const cap = out.length;
    for (let k = 0; k < this.count; k++) {
      const x = this.sx[k]!, y = this.sy[k]!, z = this.sz[k]!, r = this.sr[k]!;
      const ex = x < box.min[0] ? box.min[0] - x : x > box.max[0] ? x - box.max[0] : 0;
      const ey = y < box.min[1] ? box.min[1] - y : y > box.max[1] ? y - box.max[1] : 0;
      const ez = z < box.min[2] ? box.min[2] - z : z > box.max[2] ? z - box.max[2] : 0;
      if (ex * ex + ey * ey + ez * ez < r * r) {
        if (m < cap) out[m] = k;
        m++;
      }
    }
    return m;
  }

  /**
   * Sets the per-draw list of `program` (in use) to the lights that reach `box`, or to none. When more than
   * `POINT_LIGHTS_PER_DRAW` reach it, the draw gets the whole selection instead (no light is dropped from the image;
   * counted in `crowdedDraws`).
   */
  bindFor(program: Program, box: Box3): void {
    const ids = this.ids;
    const m = this.lightsFor(box, ids);
    if (m === 0) {
      program.ivec4('u_lightListA', -1, 0, 0, 0);
      return;
    }
    if (m > POINT_LIGHTS_PER_DRAW) {
      this.crowdedDraws++;
      program.ivec4('u_lightListA', 0, 0, 0, 0);
      return;
    }
    // Selected index + 1, and 0 after the last one (`ids` past `m` are set to −1 here).
    for (let k = m; k < POINT_LIGHTS_PER_DRAW; k++) ids[k] = -1;
    program.ivec4('u_lightListA', ids[0]! + 1, ids[1]! + 1, ids[2]! + 1, ids[3]! + 1);
    // With fewer than four the list ends inside A and B is never read.
    if (m >= 4) program.ivec4('u_lightListB', ids[4]! + 1, ids[5]! + 1, ids[6]! + 1, ids[7]! + 1);
  }

  /** Sets the per-draw list of `program` (in use) to the whole selection (the state of a fresh program). */
  bindAll(program: Program): void {
    program.ivec4('u_lightListA', 0, 0, 0, 0);
  }

  /** Sets the per-draw list of `program` (in use) to no light. */
  bindNone(program: Program): void {
    program.ivec4('u_lightListA', -1, 0, 0, 0);
  }
}
