// Environment slot of this package: lit windows at night. The app registers it with the engine
// (`assembleFrameBlock`); the structure shader reads `u_time.z` (glow) and `u_time.w` (share of lit windows).

import { lerp, smoothstep } from '../../base/index.ts';
import type { EnvSlot } from '../../base/index.ts';

/** Lit windows at night. */
export interface WindowLight {
  /** Share of lit windows by hour: pairs [hour, share], blended linearly between them. */
  shareByHour: readonly (readonly [number, number])[];
  /** Glow strength. */
  strength: number;
}

export interface WindowLightState {
  /** Glow 0–1 (0 in daylight and in studio light) and share of lit windows. */
  glow: number;
  share: number;
}

export const DEFAULT_WINDOWS: WindowLight = {
  shareByHour: [
    [0, 0.12],
    [2, 0.04],
    [4.5, 0.04],
    [6, 0.2],
    [7.5, 0.28],
    [16, 0.28],
    [18, 0.42],
    [20, 0.58],
    [21.5, 0.62],
    [22.5, 0.46],
    [23.5, 0.22],
    [24, 0.12],
  ],
  strength: 1.0,
};

/** Windows light up at dusk: sun heights in degrees between which the glow fades out. */
const GLOW_FROM = -4;
const GLOW_TO = 8;

/** Share of lit windows at a given hour. */
export function windowShare(hour: number, table: WindowLight['shareByHour'] = DEFAULT_WINDOWS.shareByHour): number {
  if (table.length === 0) return 0;
  for (let i = 0; i + 1 < table.length; i++) {
    const [h0, s0] = table[i]!;
    const [h1, s1] = table[i + 1]!;
    if (hour >= h0 && hour <= h1) return h1 > h0 ? lerp(s0, s1, (hour - h0) / (h1 - h0)) : s1;
  }
  return hour < table[0]![0] ? table[0]![1] : table[table.length - 1]![1];
}

/** Window light slot: fills the free lanes of the engine's `u_time` member. Nothing glows in studio light. */
export function windowLightSlot(windows: Partial<WindowLight> = {}): EnvSlot<WindowLight, WindowLightState> {
  return {
    name: 'window-light',
    params: { ...DEFAULT_WINDOWS, ...windows },
    fields: [{ member: 'u_time', lanes: 'zw', doc: 'z window glow 0–1, w share of lit windows' }],
    compute: (env, p) =>
      env.mode === 'studio'
        ? { glow: 0, share: 0 }
        : { glow: (1 - smoothstep(GLOW_FROM, GLOW_TO, env.sunElevationDeg)) * p.strength, share: windowShare(env.hour, p.shareByHour) },
    lanes: (s) => [s.glow, s.share],
  };
}
