// Stage 5 of Hearth: the lights of the settlements at night. One point per site seen from afar, one per lit structure
// near the eye (`structureLights` of structures.ts), drawn by `LightsLayer` as one additive draw of round sprites. The
// points are a pure function of the plan; whether one is on follows the sun's height over its own place, staggered by
// a byte of its hash (`lightGain`), so there is nothing to store and any jump of the clock is right. The lights are
// seen but light nothing. Also the views of the shade and the night for the script interface (`shadeViews`).

import type { MeshData, Vec3, VertexLayout } from 'wallhammer-web/base';
import { hashInts } from 'wallhammer-web/gen-core';
import { gridSample, horizonCodeAt, horizonLit } from 'wallhammer-web/gen-plan';
import type { Mesh, Program } from 'wallhammer-web/gpu';
import type { DrawContext, Layer, Renderer } from 'wallhammer-web/render';
import { SURFACES } from './bodies.ts';
import type { FarBody, FarScene } from './far.ts';
import type { PlanView } from './inhabited.ts';
import { PLAN_BODY, SITE_KIND, STAGE } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { settlementOf, siteFrame, sitePoint } from './settlement.ts';
import { SHADE, shadeField } from './shade.ts';
import { LIGHT_ATTRIBS, LIGHT_FS, LIGHT_VS } from './shaders.ts';
import { structureLights } from './structures.ts';
import { directionAt, latLonOf } from './world.ts';

/** One light: x y z f32 (metres from the body's centre, its own axes), size f32 (metres), rgb u8, phase u8. */
export const LIGHT_LAYOUT: VertexLayout = {
  stride: 20,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_size', size: 1, type: 'f32', offset: 12 },
    { name: 'a_color', size: 4, type: 'u8', normalized: true, offset: 16 },
  ],
};

/** A block of lights in `LIGHT_LAYOUT`. */
export interface LightSet {
  count: number;
  data: Uint8Array;
}

/** Height of a far point above the pad, m. */
const FAR_UP_M = 20;
/** Fallback when a site has no lit structure: one light per lot, this high above the pad at the lot's centre. */
const LOT_UP_M = 3;
/** Near points: sites within this distance of the eye (beyond their radius), at most this many points. */
const NEAR_REACH_M = 10_000;
const NEAR_MAX = 2000;
/** The far point of a site stands for this key in place of a lot. */
const FAR_KEY = 0xffff;

/** Writes light `i` of a block. Colour warm, with a small spread from the same hash as the phase. */
function putLight(view: DataView, i: number, x: number, y: number, z: number, size: number, h: number): void {
  const o = i * LIGHT_LAYOUT.stride;
  view.setFloat32(o, x, true);
  view.setFloat32(o + 4, y, true);
  view.setFloat32(o + 8, z, true);
  view.setFloat32(o + 12, size, true);
  const g = ((h >>> 8) & 255) / 255 - 0.5;
  const b = ((h >>> 16) & 255) / 255 - 0.5;
  view.setUint8(o + 16, 255);
  view.setUint8(o + 17, Math.round(190 + 24 * g));
  view.setUint8(o + 18, Math.round(110 + 36 * b));
  view.setUint8(o + 19, h & 255);
}

/** One light per site, in table order: 20 m above the pad at its centre, size the built-up radius. */
export function farLights(plan: WorldPlan): LightSet {
  const S = plan.sites;
  const count = S ? S.count : 0;
  const data = new Uint8Array(count * LIGHT_LAYOUT.stride);
  const view = new DataView(data.buffer);
  const R = plan.grid.radiusM;
  for (let s = 0; s < count; s++) {
    const f = siteFrame(plan, s);
    const r = R + f.heightM + FAR_UP_M;
    putLight(view, s, f.origin[0] * r, f.origin[1] * r, f.origin[2] * r, S!.radiusM[s]!, hashInts(plan.seed, s, FAR_KEY, 0) >>> 0);
  }
  return { count, data };
}

/**
 * The lights of one site near the eye: one per lit structure (`structureLights`), at its place in the site's frame,
 * size 0.3–0.6 m by its strength. A site without any gets one per lot, 3 m above the pad at the lot's centre.
 */
export function nearLights(plan: WorldPlan, site: number): LightSet {
  const R = plan.grid.radiusM;
  const f = siteFrame(plan, site);
  const lit = structureLights(plan, site);
  const n = Math.floor(lit.length / 4);
  if (n > 0) {
    const data = new Uint8Array(n * LIGHT_LAYOUT.stride);
    const view = new DataView(data.buffer);
    for (let k = 0; k < n; k++) {
      const p = sitePoint(f, lit[4 * k]!, lit[4 * k + 1]!);
      const r = R + p.heightM + lit[4 * k + 2]!;
      const strength = Math.min(1, Math.max(0, lit[4 * k + 3]!));
      putLight(view, k, p.dir[0] * r, p.dir[1] * r, p.dir[2] * r, 0.3 + 0.3 * strength, hashInts(plan.seed, site, k, 1) >>> 0);
    }
    return { count: n, data };
  }
  const lots = settlementOf(plan, site).lots;
  const data = new Uint8Array(lots.length * LIGHT_LAYOUT.stride);
  const view = new DataView(data.buffer);
  lots.forEach((lot, k) => {
    const p = sitePoint(f, lot.x, lot.z);
    const r = R + p.heightM + LOT_UP_M;
    putLight(view, k, p.dir[0] * r, p.dir[1] * r, p.dir[2] * r, 0.45, hashInts(plan.seed, site, lot.id, 0) >>> 0);
  });
  return { count: lots.length, data };
}

/** How much a light is on: 1 from about 6° under the horizon, 0 from just above it, staggered by `phase` (0–255). */
export function lightGain(sunSine: number, phase: number): number {
  return Math.min(1, Math.max(0, (0.02 - (0.12 * phase) / 255 - sunSine) / 0.03));
}

/** A corner of a sprite: the light (`LIGHT_LAYOUT`) and the corner, with the kind of block in z. */
const CORNER_LAYOUT: VertexLayout = {
  stride: 32,
  attribs: [...LIGHT_LAYOUT.attribs, { name: 'a_corner', size: 3, type: 'f32', offset: 20 }],
};
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/** Four corners per light of `sets` (kind per set: 0 near, 1 far, 2 far of the town by `town`). */
function spriteMesh(blocks: readonly { set: LightSet; kind: (i: number) => number }[]): MeshData | null {
  let count = 0;
  for (const b of blocks) count += b.set.count;
  if (count === 0) return null;
  const vertices = new Uint8Array(count * 4 * CORNER_LAYOUT.stride);
  const view = new DataView(vertices.buffer);
  const indices = new Uint16Array(count * 6);
  let v = 0;
  let w = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.set.count; i++) {
      const src = b.set.data.subarray(i * LIGHT_LAYOUT.stride, (i + 1) * LIGHT_LAYOUT.stride);
      const kind = b.kind(i);
      for (let c = 0; c < 4; c++) {
        const o = (v + c) * CORNER_LAYOUT.stride;
        vertices.set(src, o);
        view.setFloat32(o + 20, CORNERS[c]![0], true);
        view.setFloat32(o + 24, CORNERS[c]![1], true);
        view.setFloat32(o + 28, kind, true);
      }
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], w);
      v += 4;
      w += 6;
    }
  }
  return { layout: CORNER_LAYOUT, vertices, indices, count: w };
}

/**
 * The lights of the planned body: the far block (every site, static) and the near block (sites within 10 km of the
 * eye, nearest first, ties by index, at most 2000 points; rebuilt only when that list changes), one buffer, one
 * additive draw with the depth test on and no depth write. Placed with the model and size of the body's `FarBody`, so
 * the points follow the same path as the surface under them, streamed or from afar.
 */
export class LightsLayer implements Layer {
  private readonly renderer: Renderer;
  private readonly scene: FarScene;
  private readonly body: FarBody;
  private readonly plan: WorldPlan;
  private readonly program: Program;
  private readonly far: LightSet;
  private readonly near = new Map<number, LightSet>();
  private mesh: Mesh | null = null;
  /** The sites of the near block, as a key. */
  private key = '';
  private nearCount = 0;
  /** The eye of the last walk over the sites (undefined before the first); a smaller move skips the walk. */
  private lastEye: Vec3 | null | undefined = undefined;

  constructor(renderer: Renderer, scene: FarScene, body: FarBody, plan: WorldPlan) {
    this.renderer = renderer;
    this.scene = scene;
    this.body = body;
    this.plan = plan;
    this.program = renderer.device.program('system lights', renderer.resolve(LIGHT_VS), renderer.resolve(LIGHT_FS), LIGHT_ATTRIBS);
    this.far = farLights(plan);
    this.rebuild([]);
  }

  /** Once per frame with the eye in the body's frame (metres from its centre), or null when the body is not near. */
  update(eye: Vec3 | null): void {
    // The walk over every site runs only when the eye has moved by a metre or more (or come or gone), not per frame.
    const last = this.lastEye;
    if (last !== undefined && (eye === null ? last === null : last !== null && (eye[0] - last[0]) ** 2 + (eye[1] - last[1]) ** 2 + (eye[2] - last[2]) ** 2 < 1)) return;
    this.lastEye = eye ? [eye[0], eye[1], eye[2]] : null;
    const S = this.plan.sites;
    const sites: { s: number; d: number }[] = [];
    if (eye && S) {
      const R = this.plan.grid.radiusM;
      for (let s = 0; s < S.count; s++) {
        const r = R + S.heightM[s]!;
        const dx = S.dir[3 * s]! * r - eye[0];
        const dy = S.dir[3 * s + 1]! * r - eye[1];
        const dz = S.dir[3 * s + 2]! * r - eye[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - S.radiusM[s]!;
        if (d < NEAR_REACH_M) sites.push({ s, d });
      }
      sites.sort((a, b) => a.d - b.d || a.s - b.s);
    }
    const chosen: number[] = [];
    let points = 0;
    for (const { s } of sites) {
      const set = this.nearOf(s);
      if (points + set.count > NEAR_MAX) break;
      chosen.push(s);
      points += set.count;
    }
    const key = chosen.join(',');
    if (key !== this.key) this.rebuild(chosen);
  }

  /** Lights in the buffer: far points, near points. */
  stats(): { far: number; near: number } {
    return { far: this.far.count, near: this.nearCount };
  }

  dispose(): void {
    if (this.mesh) this.renderer.device.deleteMesh(this.mesh);
    this.mesh = null;
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color' || !this.mesh) return;
    const b = this.body;
    const device = ctx.device;
    device.setState({ depthTest: true, depthWrite: false, cullBack: false, blend: { src: 'one', dst: 'one' } });
    device.use(this.program);
    this.program.vec3v('u_eyePos', this.scene.eye);
    this.program.mat4('u_model', b.model);
    this.program.set('u_body', { vec4: [b.center[0], b.center[1], b.center[2], b.size] });
    this.program.vec3v('u_toSun', b.toSun);
    this.program.float('u_bodyRadius', b.radiusM);
    device.draw(this.mesh);
    ctx.count(this.mesh.triangles);
  }

  private nearOf(site: number): LightSet {
    let set = this.near.get(site);
    if (!set) {
      set = nearLights(this.plan, site);
      this.near.set(site, set);
    }
    return set;
  }

  private rebuild(sites: readonly number[]): void {
    this.key = sites.join(',');
    const S = this.plan.sites;
    const blocks: { set: LightSet; kind: (i: number) => number }[] = [{ set: this.far, kind: (i) => (S && S.kind[i] === SITE_KIND.town ? 2 : 1) }];
    this.nearCount = 0;
    for (const s of sites) {
      const set = this.nearOf(s);
      blocks.push({ set, kind: () => 0 });
      this.nearCount += set.count;
    }
    if (this.mesh) this.renderer.device.deleteMesh(this.mesh);
    const data = spriteMesh(blocks);
    this.mesh = data ? this.renderer.device.createMesh(data, LIGHT_ATTRIBS) : null;
  }
}

// --- The views of the shade and the night ----------------------------------------------------------------------------

/** The sun as the views need it: its direction in the body's turning frame at a time (the clock put back after). */
export interface ShadeSky {
  toSun(timeS: number): Vec3;
  /** One turn of the body, s. */
  periodS: number;
}

const SIN_3 = 0.05233595624294383;
const SIN_5 = 0.08715574274765817;
const SIN_8 = 0.13917310096006544;
const SIN_20 = 0.3420201433256687;

/** The sun's sine over `dir` at a time. */
function sunSine(sky: ShadeSky, dir: Vec3, t: number): number {
  const s = sky.toSun(t);
  return s[0] * dir[0] + s[1] * dir[1] + s[2] * dir[2];
}

/**
 * A time within one turn at which the sun's sine over `dir` passes `sine`, rising (morning) or falling (evening);
 * null when it never does there.
 */
export function sunTime(sky: ShadeSky, dir: Vec3, sine: number, rising: boolean): number | null {
  const STEPS = 720;
  const P = sky.periodS;
  let prev = sunSine(sky, dir, 0);
  for (let i = 1; i <= STEPS; i++) {
    const t = (i * P) / STEPS;
    const cur = sunSine(sky, dir, t);
    if (rising ? prev < sine && cur >= sine : prev > sine && cur <= sine) {
      let a = ((i - 1) * P) / STEPS;
      let b = t;
      for (let k = 0; k < 40; k++) {
        const m = (a + b) / 2;
        const s = sunSine(sky, dir, m);
        if (rising ? s < sine : s > sine) a = m;
        else b = m;
      }
      return b;
    }
    prev = cur;
  }
  return null;
}

/** The time within one turn with the sun highest (`low`: lowest) over `dir`. */
function extremeTime(sky: ShadeSky, dir: Vec3, low: boolean): number {
  const STEPS = 360;
  let best = 0;
  let bestS = low ? Infinity : -Infinity;
  for (let i = 0; i < STEPS; i++) {
    const t = (i * sky.periodS) / STEPS;
    const s = sunSine(sky, dir, t);
    if (low ? s < bestS : s > bestS) {
      bestS = s;
      best = t;
    }
  }
  return best;
}

/** The place the morning views look at: a site whose floor is in the shade of the morning while a ridge near it is lit. */
interface MorningPlace {
  site: number;
  floor: Vec3;
  floorM: number;
  sine: number;
  time: number;
  toSun: Vec3;
  /** Whether the search found floor and ridge as asked (else the best floor in shade it saw). */
  found: boolean;
}

const mornings = new WeakMap<WorldPlan, MorningPlace | null>();

/** Searches the first 32 sites for a morning place (see `MorningPlace`); cached per plan. */
function morningPlace(plan: WorldPlan, sky: ShadeSky): MorningPlace | null {
  if (mornings.has(plan)) return mornings.get(plan)!;
  const S = plan.sites;
  let best: MorningPlace | null = null;
  let bestLit = Infinity;
  if (S) {
    const field = shadeField(plan);
    const code = new Uint8Array(4);
    const heightAt = (d: Vec3): number => Math.max(0, gridSample(plan.grid, plan.relief, d[0], d[1], d[2]) * 0.5);
    search: for (let s = 0; s < Math.min(32, S.count); s++) {
      const f = siteFrame(plan, s);
      const floor = f.origin;
      horizonCodeAt(field, floor[0], floor[1], floor[2], code);
      const floorM = heightAt(floor);
      for (const sine of [SIN_5, SIN_3 + 0.02, SIN_8 - 0.01]) {
        const time = sunTime(sky, floor, sine, true);
        if (time === null) continue;
        const toSun = sky.toSun(time);
        const litFloor = horizonLit(code, floor, toSun, SHADE.soft);
        if (litFloor < bestLit) {
          bestLit = litFloor;
          best = { site: s, floor, floorM, sine, time, toSun, found: false };
        }
        if (litFloor >= 0.1) continue;
        // A ridge: higher ground within 3 km, lit by the same sun.
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          for (const d of [800, 1600, 2400]) {
            const p = sitePoint(f, Math.cos(a) * d, Math.sin(a) * d);
            if (heightAt(p.dir) < floorM + 60) continue;
            horizonCodeAt(field, p.dir[0], p.dir[1], p.dir[2], code);
            if (horizonLit(code, p.dir, toSun, SHADE.soft) > 0.9) {
              best = { site: s, floor, floorM, sine, time, toSun, found: true };
              break search;
            }
          }
        }
        horizonCodeAt(field, floor[0], floor[1], floor[2], code);
      }
    }
  }
  mornings.set(plan, best);
  return best;
}

/** Whether the morning views found what they ask for (a floor in shade with a lit ridge), null without sites. */
export function shadeSearchFound(plan: WorldPlan): boolean | null {
  const m = mornings.get(plan);
  return m === undefined || m === null ? null : m.found;
}

/**
 * The views of stage 5 (the shade of the relief and the lights at night). At `stage` 4 only `world-shade-4`, the
 * morning view without the shade. The place of the morning is searched once per plan on the page.
 */
export function shadeViews(plan: WorldPlan, stage: number, sky: ShadeSky): PlanView[] {
  const S = plan.sites;
  if (!S || S.count === 0 || stage < STAGE.routes) return [];
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const view = (name: string, dir: Vec3, height: number, time: number, extra: Partial<PlanView> = {}): PlanView => {
    const [lat, lon] = latLonOf(dir);
    return { name, body, lat, lon, height, pitchDeg: 89, yawDeg: 0, map: false, time, ...extra };
  };
  const views: PlanView[] = [];
  const m = morningPlace(plan, sky);
  if (m) {
    // The camera 2 km from the floor away from the sun, 1.5 km up, looking at the floor.
    const s = m.toSun;
    const up = m.floor;
    const along = s[0] * up[0] + s[1] * up[1] + s[2] * up[2];
    let tx = s[0] - up[0] * along;
    let ty = s[1] - up[1] * along;
    let tz = s[2] - up[2] * along;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const cx = up[0] * R - tx * 2000;
    const cy = up[1] * R - ty * 2000;
    const cz = up[2] * R - tz * 2000;
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const camera: Vec3 = [cx / cl, cy / cl, cz / cl];
    const r = R + m.floorM;
    const toward: Vec3 = [up[0] * r, up[1] * r, up[2] * r];
    const look = { pitchDeg: 30, toward };
    if (stage >= STAGE.shade) {
      views.push(view('world-shade-morning', camera, 1500, m.time, look));
      views.push(view('world-shade-forenoon', camera, 1500, sunTime(sky, m.floor, SIN_20, true) ?? m.time, look));
      views.push(view('world-shade-noon', camera, 1500, extremeTime(sky, m.floor, false), look));
      views.push(view('world-shade-view', camera, 1500, m.time, { ...look, levels: true, shadeView: true }));
    } else views.push(view('world-shade-4', camera, 1500, m.time, look));
  }
  if (stage < STAGE.shade) return views;
  const pole = directionAt(85, 0);
  views.push(view('world-shade-pole', pole, 30_000, extremeTime(sky, pole, false), { pitchDeg: 35 }));
  const town = Math.max(0, S.kind.indexOf(SITE_KIND.town));
  const tf = siteFrame(plan, town);
  const townDir = tf.origin;
  views.push(view('world-shade-orbit', townDir, 4 * R, sunTime(sky, townDir, 0, true) ?? extremeTime(sky, townDir, false), { lookAtBody: true }));
  const midnight = extremeTime(sky, townDir, true);
  views.push(view('world-night-orbit', townDir, 4 * R, midnight, { lookAtBody: true }));
  views.push(view('world-night-town', townDir, 20_000, midnight));
  // In a lane of the first village, as `world-lane`, at night.
  let v = -1;
  for (let s = 0; s < S.count && v < 0; s++) if (S.kind[s] === SITE_KIND.village) v = s;
  const lot = v >= 0 ? settlementOf(plan, v).lots[0] : undefined;
  if (lot) {
    const f = siteFrame(plan, v);
    const out = lot.depthM / 2 + 6;
    const eye = sitePoint(f, lot.x + lot.hx * out + lot.hz * 6, lot.z + lot.hz * out - lot.hx * 6);
    const at = sitePoint(f, lot.x, lot.z);
    const ra = R + at.heightM + 3;
    views.push(view('world-night-lane', eye.dir, 1.7, extremeTime(sky, f.origin, true), { pitchDeg: 5, toward: [at.dir[0] * ra, at.dir[1] * ra, at.dir[2] * ra] }));
  }
  const near = sitePoint(tf, 0, -S.radiusM[town]! - 350);
  const rc = R + tf.heightM;
  const dusk = sunTime(sky, townDir, -SIN_3, false) ?? midnight;
  views.push(view('world-dusk-town', near.dir, 250, dusk, { pitchDeg: 30, toward: [townDir[0] * rc, townDir[1] * rc, townDir[2] * rc] }));
  return views;
}
