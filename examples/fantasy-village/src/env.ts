// Light of the village: a late afternoon that turns into a pink and violet evening. The engine's day light and sky
// do the sun, ambient, shadows and the sky dome (with the colours tuned here); this file adds the example's own
// environment slot `u_villageGlow` (how strongly windows, lanterns and fire shine, and the colour of the distance
// haze) and the smooth switch between the two moods (key E).
//
// Everything the materials need beyond the engine's Frame block comes from the slot below, computed from the sun's
// height every frame (pure), so a frozen hour always gives the same image.

import type { EnvSlot } from 'wallhammer-web/base';
import type { DayLight, SunSite } from 'wallhammer-web/env';
import { clamp, lerp, smoothstep } from './kit/math.ts';

/** Place and date: central Europe in mid September, local solar time (sunset a little after 18:00). */
export const SITE: Partial<SunSite> = { latitudeDeg: 50, longitudeDeg: 15, dayOfYear: 258, utcOffsetHours: 1 };

/** The two moods the E key moves between (hours of the day). */
export const HOUR_AFTERNOON = 16.4;
export const HOUR_EVENING = 18.55;
/** How long the switch takes, real seconds. */
export const SWITCH_SECONDS = 6;

/**
 * Day light tuned for the hand-painted look: a golden low sun, warm bounce, cool violet shade, and a sky that goes
 * from soft blue over warm peach to pink and violet at dusk.
 */
export const DAY_LIGHT: Partial<DayLight> = {
  sunHigh: [1.0, 0.94, 0.82],
  sunLow: [1.0, 0.62, 0.36],
  ambientDay: [0.42, 0.42, 0.52],
  ambientNight: [0.13, 0.11, 0.22],
  twilight: [0.2, 0.09, 0.16],
  bounce: [0.2, 0.13, 0.07],
  tintDay: [1.02, 0.99, 0.95],
  tintNight: [0.8, 0.78, 1.0],
  skyZenithDay: [0.36, 0.5, 0.78],
  skyHorizonDay: [0.95, 0.8, 0.66],
  skyZenithNight: [0.1, 0.08, 0.22],
  skyHorizonNight: [0.34, 0.2, 0.36],
  skyTwilight: [0.62, 0.26, 0.42],
  sunGlowHigh: [0.5, 0.4, 0.3],
  sunGlowLow: [0.95, 0.42, 0.3],
  exposureNight: 1.25,
  lowSunFill: 0.6,
};

export interface VillageGlowParams {
  /** Sun heights (degrees) between which the evening glow fades in: off above `offAboveDeg`, full below `fullBelowDeg`. */
  offAboveDeg: number;
  fullBelowDeg: number;
  /** Fire is always on; it gets this much brighter in the evening (contrast against the darker scene). */
  fireDay: number;
  fireEvening: number;
  /** Distance haze tint: afternoon (warm) and evening (violet), and how strongly it tints (0–1) at the far end. */
  hazeDay: [number, number, number];
  hazeEvening: [number, number, number];
  hazeAmount: number;
}

export interface VillageGlowState {
  /** 0 afternoon … 1 evening (windows, lanterns). */
  evening: number;
  fire: number;
  haze: readonly [number, number, number];
  hazeAmount: number;
}

/**
 * The example's environment slot: two Frame members.
 *   u_villageGlow  x evening glow 0–1, y fire strength, z steady glow, w haze amount
 *   u_villageHaze  rgb distance haze colour (display space), w unused
 */
export function villageGlowSlot(params: Partial<VillageGlowParams> = {}): EnvSlot<VillageGlowParams, VillageGlowState> {
  return {
    name: 'villageGlow',
    params: {
      offAboveDeg: 9,
      fullBelowDeg: -1.5,
      fireDay: 0.75,
      fireEvening: 1.35,
      hazeDay: [0.93, 0.8, 0.7],
      hazeEvening: [0.55, 0.38, 0.62],
      hazeAmount: 0.42,
      ...params,
    },
    fields: [
      { member: 'u_villageGlow', order: 110, lanes: 'xyzw', doc: 'x evening glow 0–1, y fire strength, z steady glow, w haze amount' },
      { member: 'u_villageHaze', order: 120, lanes: 'xyzw', doc: 'rgb distance haze colour, w evening share for water and sky tints' },
    ],
    compute: (env, p) => {
      const evening = env.mode === 'studio' ? 0 : 1 - smoothstep(p.fullBelowDeg, p.offAboveDeg, env.sunElevationDeg);
      const haze: [number, number, number] = [lerp(p.hazeDay[0], p.hazeEvening[0], evening), lerp(p.hazeDay[1], p.hazeEvening[1], evening), lerp(p.hazeDay[2], p.hazeEvening[2], evening)];
      return { evening, fire: lerp(p.fireDay, p.fireEvening, evening), haze, hazeAmount: p.hazeAmount };
    },
    lanes: (g) => [g.evening, g.fire, 1, g.hazeAmount, g.haze[0], g.haze[1], g.haze[2], g.evening],
  };
}

/**
 * The smooth switch between afternoon and evening: `toggle()` starts moving the hour toward the other mood, `step`
 * (every frame, with real seconds) moves it with an ease, `hour` is where it is now. No allocation per frame.
 */
export class MoodSwitch {
  hour: number;
  private from: number;
  private to: number;
  private t = 1;

  constructor(hour: number) {
    this.hour = hour;
    this.from = hour;
    this.to = hour;
  }

  /** The mood the switch is heading to. */
  get evening(): boolean {
    return this.to >= (HOUR_AFTERNOON + HOUR_EVENING) / 2;
  }

  get moving(): boolean {
    return this.t < 1;
  }

  toggle(): void {
    this.from = this.hour;
    this.to = this.evening ? HOUR_AFTERNOON : HOUR_EVENING;
    this.t = 0;
  }

  /** Jumps to an hour (no animation). */
  set(hour: number): void {
    this.hour = this.from = this.to = hour;
    this.t = 1;
  }

  /** Advances by real seconds; returns whether the hour changed. */
  step(seconds: number): boolean {
    if (this.t >= 1) return false;
    this.t = clamp(this.t + seconds / SWITCH_SECONDS, 0, 1);
    const e = this.t * this.t * (3 - 2 * this.t);
    this.hour = lerp(this.from, this.to, e);
    return true;
  }
}
