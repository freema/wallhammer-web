// The weather of the planet example: a cloud cover by place for the engine's slot (`cloudFieldSlot`) and the weather
// at a place, both pure functions of the seed, the place and the animation time. No wall clock, no state between
// calls.
//
// The cover is a profile by latitude (wetter round the equator and in the middle latitudes, drier belts and clearer
// poles), moved per seed by a few hundredths, plus patches of value noise (weather systems about a third of the
// planet's radius across) that carry it from clear sky to a closed deck. The patches start at a place given by the
// seed and drift with the page's wind. Rain or snow falls where the cover closes; snow where the place is cold.

import type { Vec3 } from 'wallhammer-web/base';
import { cloudFieldCover } from 'wallhammer-web/env';
import type { CloudCoverField, WeatherState } from 'wallhammer-web/env';
import { hashInts } from 'wallhammer-web/gen-core';
import { RADIUS_M } from './world.ts';

/** The wind of the page (`environment.wind`) and how fast the clouds move with it (`CloudConfig.speedFactor`, default). */
export const PLANET_WIND = { fromDeg: 240, speedMs: 6 } as const;
const CLOUD_SPEED = 1.5;
/** Stream of the weather's random numbers. */
const WEATHER_STREAM = 0x3e47;
/**
 * Cover by |up · axis| = 0, 1/7 … 1. On its own the profile is broken cloud at most; the patches carry it from clear
 * country to overcast and rain. With these numbers about a quarter of the planet is clear, about half broken to mostly
 * cloudy, the rest overcast, and a few hundredths of it raining or snowing.
 */
const ZONAL = [0.46, 0.38, 0.24, 0.2, 0.3, 0.4, 0.36, 0.26] as const;
/** How far the seed moves each entry of the profile up or down. */
const ZONAL_SPREAD = 0.06;
const PATCH_AMOUNT = 0.8;
const PATCH_SIZE_M = 32_000;
const PATCH_WARP = 0.8;
const DARKNESS = 0.3;
/** How far from the origin the seed puts the patches, metres along each axis (at most). */
const SEED_OFFSET_M = 200_000;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** A number in [0, 1) from the weather's stream of `seed` and a key. */
const rand = (seed: number, k: number): number => hashInts(seed, WEATHER_STREAM, k) / 4294967296;

/**
 * The cloud cover by place at animation time `timeS` (seconds), in the world's frame (the poles on the y axis).
 * `cover`: one cover for every place in place of the profile and its patches (the page's `cover=`).
 */
export function planetCloudField(seed: number, timeS: number, cover: number | null = null): CloudCoverField {
  // The wind blows from `fromDeg` (0 = from +z, 90 = from +x); the patches drift at half the speed of the clouds.
  const toward = ((PLANET_WIND.fromDeg + 180) * Math.PI) / 180;
  const drift = 0.5 * PLANET_WIND.speedMs * CLOUD_SPEED * timeS;
  const start = [0, 1, 2].map((k) => (2 * rand(seed, 10 + k) - 1) * SEED_OFFSET_M) as [number, number, number];
  return {
    axis: [0, 1, 0],
    zonal: ZONAL.map((z, i) => (cover === null ? Math.min(1, Math.max(0, z + (2 * rand(seed, i) - 1) * ZONAL_SPREAD)) : cover)),
    patchAmount: cover === null ? PATCH_AMOUNT : 0,
    patchSizeM: PATCH_SIZE_M,
    patchWarp: PATCH_WARP,
    patchOffset: [start[0] + Math.sin(toward) * drift, start[1], start[2] + Math.cos(toward) * drift],
    darkness: DARKNESS,
  };
}

/** A field with no cloud anywhere (`clouds=0`). */
export const NO_CLOUD_FIELD: CloudCoverField = { axis: [0, 1, 0], zonal: [0, 0, 0, 0, 0, 0, 0, 0], patchAmount: 0, patchSizeM: PATCH_SIZE_M, patchWarp: 0, patchOffset: [0, 0, 0], darkness: DARKNESS };

/**
 * The weather at the place under the unit direction `dir` (ground `groundM` metres above the base sphere) at animation
 * time `timeS`. Cold places (toward the poles, high ground) get snow instead of rain. Pure.
 */
export function planetWeatherAt(seed: number, dir: Vec3, groundM: number, timeS: number, cover: number | null = null): WeatherState {
  const c = cloudFieldCover(planetCloudField(seed, timeS, cover), dir, RADIUS_M);
  // The temperature of the surface's colours (world.ts): falls toward the poles and with height.
  const t = 1 - dir[1] * dir[1] * 0.9 - Math.max(0, groundM) / 4600;
  const precipitation = smooth(0.6, 0.9, c) * 0.9;
  const snow = t < 0.22;
  return {
    cloudCover: c,
    precipitation,
    precipitationKind: snow ? 'snow' : 'rain',
    snowCover: snow ? precipitation : 0,
    wetness: snow ? 0 : Math.max(precipitation, 0.5 * smooth(0.5, 0.75, c)),
    fog: 0.25 * smooth(0.55, 0.85, c),
  };
}
