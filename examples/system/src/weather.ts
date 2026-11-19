// The weather of Hearth (stage 2): a cloud cover by place for the engine's slot (`cloudFieldSlot`), a profile by
// latitude with patches that drift with the wind, and the weather at a place as a pure function of plan, place and
// time: cloud, rain or snowfall, wet ground, fresh snow and fog. No wall clock, no state between calls.

import type { Vec3 } from 'wallhammer-web/base';
import { cloudFieldCover } from 'wallhammer-web/env';
import type { CloudCoverField, WeatherState } from 'wallhammer-web/env';
import { biomeAt, climateAt } from './climate.ts';
import { planGround, planScope } from './ground.ts';
import type { Scope } from './ground.ts';
import type { WorldPlan } from './plan.ts';
import { LINE_KIND, PLAN_BODY } from './plan.ts';
import { SURFACES } from './bodies.ts';
import type { PlanView } from './inhabited.ts';
import { latLonOf } from './world.ts';

/** The wind of Hearth's page and how fast the clouds move with it (`CloudConfig.speedFactor`). */
export const HEARTH_WIND = { fromDeg: 240, speedMs: 6 } as const;
export const HEARTH_CLOUD_SPEED = 1.5;
/**
 * Cover by |up · axis| = 0, 1/7 … 1: wet tropics, dry belts, wet middle latitudes, clearer poles. The profile alone
 * is broken cloud at most (0.44); the patches (weather systems of about 55 km and 24 km, bent by the warp) carry it
 * from clear country up to overcast and rain. About a quarter of the planet is then clear, half broken to mostly
 * cloudy, an eighth overcast and a twenty-fifth raining or snowing; from orbit the cloud hides about two fifths of the
 * ground, so the continents and the seas show.
 */
const ZONAL = [0.44, 0.36, 0.2, 0.16, 0.26, 0.38, 0.36, 0.24] as const;
const PATCH_AMOUNT = 0.8;
const PATCH_SIZE_M = 55_000;
const PATCH_WARP = 0.8;
const DARKNESS = 0.3;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Hearth's cloud cover by place at the time of the system `timeS`, in the body's own frame (axis +y). `cover`: one
 * cover for every place in place of the profile and its patches (the page's `cover=`); the pattern still drifts.
 */
export function hearthCloudField(timeS: number, cover: number | null = null): CloudCoverField {
  // The wind blows from `fromDeg` (0 = from +z, 90 = from +x); the patches drift at half the speed of the clouds.
  const toward = ((HEARTH_WIND.fromDeg + 180) * Math.PI) / 180;
  const drift = 0.5 * HEARTH_WIND.speedMs * HEARTH_CLOUD_SPEED * timeS;
  return {
    axis: [0, 1, 0],
    zonal: cover === null ? ZONAL : Array.from({ length: 8 }, () => cover),
    patchAmount: cover === null ? PATCH_AMOUNT : 0,
    patchSizeM: PATCH_SIZE_M,
    patchWarp: PATCH_WARP,
    patchOffset: [Math.sin(toward) * drift, 0, Math.cos(toward) * drift],
    darkness: DARKNESS,
  };
}

/** A field with no cloud anywhere (another body is the body of radial up, or the clouds are switched off). */
export const NO_CLOUD_FIELD: CloudCoverField = { axis: [0, 1, 0], zonal: [0, 0, 0, 0, 0, 0, 0, 0], patchAmount: 0, patchSizeM: PATCH_SIZE_M, patchWarp: 0, patchOffset: [0, 0, 0], darkness: DARKNESS };

const scopes = new WeakMap<WorldPlan, Scope>();
function pageScope(plan: WorldPlan): Scope {
  let s = scopes.get(plan);
  if (!s) {
    s = planScope(plan, plan.stage, null);
    scopes.set(plan, s);
  }
  return s;
}

/** The place under a unit direction of the body: its ground height, climate and biome. */
export function placeAt(plan: WorldPlan, dir: Vec3): { h: number; t: number; m: number; biome: number } {
  const s = pageScope(plan);
  const R = plan.grid.radiusM;
  const x = dir[0] * R;
  const y = dir[1] * R;
  const z = dir[2] * R;
  const h = planGround(s, x, y, z);
  const { t, m } = climateAt(s, x, y, z, h);
  return { h, t, m, biome: biomeAt(s, x, y, z, h) };
}

/**
 * The weather at the place under the unit direction `dir` of the body at the time of the system `timeS`. Pure.
 * `place`: `placeAt(plan, dir)` when the caller already has it (it saves a probe of the ground). `cover`: as for
 * `hearthCloudField`.
 */
export function weatherAt(plan: WorldPlan, dir: Vec3, timeS: number, place: { t: number; m: number } = placeAt(plan, dir), cover: number | null = null): WeatherState {
  const c = cloudFieldCover(hearthCloudField(timeS, cover), dir, plan.grid.radiusM);
  const { t, m } = place;
  const precipitation = smooth(0.6, 0.9, c) * (0.35 + 0.65 * m);
  const snow = t < 0.2;
  const snowfall = snow ? precipitation : 0;
  const rain = snow ? 0 : precipitation;
  return {
    cloudCover: c,
    precipitation,
    precipitationKind: snow ? 'snow' : 'rain',
    snowCover: Math.max(1 - smooth(0.12, 0.24, t), snowfall),
    wetness: Math.max(rain, 0.5 * smooth(0.5, 0.75, c) * m),
    fog: 0.3 * smooth(0.55, 0.85, c) * m,
  };
}

// --- Views of the climate for the pictures (presets `world-climate-…`) ---------------------------------------------

/** Unit directions of a Fibonacci lattice over the sphere, a fixed set. */
function lattice(count: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    out.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  return out;
}

/**
 * The views of the climate, each with a fixed time: from orbit (without clouds and at stage 1 by `clouds=0` and
 * `world=1` in the address), a great
 * river through warm country from 25 km, clouds from 8 km and from below, the cap from 30 km and close up, the
 * equator close up, rain, snowfall and a border of biomes from 3 km with the level tints. `daylight` gives a time of
 * the system with the sun high over a direction.
 */
export function climateViews(plan: WorldPlan, daylight: (dir: Vec3) => number): PlanView[] {
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const view = (name: string, d: Vec3, height: number, pitchDeg: number, extra: Partial<PlanView> = {}, time = daylight(d)): PlanView => {
    const [lat, lon] = latLonOf(d);
    return { name: `world-climate-${name}`, body, lat, lon, height, pitchDeg, yawDeg: 0, time, map: false, ...extra };
  };
  const dirs = lattice(1500);
  const land = (d: Vec3): boolean => placeAt(plan, d).h > 5;
  // From orbit: the day side over the warm half, the cap in the picture.
  const orbitDir: Vec3 = [Math.cos(0.5), Math.sin(0.5), 0];
  const orbitTime = daylight(orbitDir);
  const views: PlanView[] = [
    view('orbit', orbitDir, 2.6 * R, 0, { lookAtBody: true }, orbitTime),
  ];
  // A great river through the warmest country it crosses.
  const L = plan.lines;
  let river: Vec3 | null = null;
  let warmest = -Infinity;
  for (let l = L.kindStart[LINE_KIND.river]!; l < L.kindStart[LINE_KIND.river + 1]!; l++) {
    if (L.cls[l] !== 0) continue;
    for (let k = L.start[l]!; k < L.start[l + 1]!; k += 8) {
      const d: Vec3 = [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
      const t = placeAt(plan, d).t;
      if (t > warmest) {
        warmest = t;
        river = d;
      }
    }
  }
  if (river) views.push(view('river-25km', river, 25_000, 70));
  // Partly cloudy land in the middle latitudes: clouds from 8 km and from the ground.
  const partly = dirs.find((d) => Math.abs(d[1]) > 0.45 && Math.abs(d[1]) < 0.7 && land(d) && Math.abs(cloudFieldCover(hearthCloudField(daylight(d)), d, R) - 0.5) < 0.08);
  if (partly) {
    views.push(view('clouds-8km', partly, 8000, 28));
    views.push(view('clouds-below', partly, 3, -35));
  }
  // The cap and the equator.
  const pole = dirs.find((d) => d[1] > 0.985 && land(d)) ?? ([0, 1, 0] as Vec3);
  views.push(view('pole-30km', pole, 30_000, 55));
  views.push(view('pole-close', pole, 3, 3));
  const equator = dirs.find((d) => Math.abs(d[1]) < 0.06 && land(d));
  if (equator) views.push(view('equator-close', equator, 3, 3));
  // Rain over 0.4 and snowfall, each at its own time with the sun up (snowfall short of the circle of the polar
  // night, |up · axis| under 0.92).
  for (const kind of ['rain', 'snow'] as const) {
    const at = dirs.find((d) => {
      const a = Math.abs(d[1]);
      if (!land(d) || (kind === 'snow' ? a < 0.85 || a > 0.92 : a > 0.8)) return false;
      const w = weatherAt(plan, d, daylight(d));
      return w.precipitationKind === kind && w.precipitation > 0.4;
    });
    if (at) views.push(view(kind, at, 3, 4));
  }
  // A border of biomes (meadow against forest) from 3 km with the level tints.
  const border = dirs.find((d) => {
    if (!land(d)) return false;
    const b = placeAt(plan, d).biome;
    const e: Vec3 = [d[0] + 0.004, d[1], d[2]];
    const l = Math.hypot(e[0], e[1], e[2]);
    return b === 5 && placeAt(plan, [e[0] / l, e[1] / l, e[2] / l]).biome === 4;
  });
  if (border) views.push(view('level-border', border, 3000, 50, { levels: true }));
  return views;
}
