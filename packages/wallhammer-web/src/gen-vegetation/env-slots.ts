// Environment slot of this module: how wind bends canopies. The app registers it with the engine
// (`assembleFrameBlock`); the shaders here read its lanes of `u_wind`. The season (`u_season`), which the vegetation
// shader reads as well, is a slot of gen-ground, so the ground does not depend on the vegetation.

import type { EnvSlot } from '../base/index.ts';

/** How wind moves canopies. */
export interface SwayConfig {
  /** Deflection of an ordinary tree's top in metres per 1 m/s of wind, and its cap. */
  mPerMs: number;
  maxM: number;
  /** Canopy surface flutter as a share of the deflection. */
  flutterShare: number;
}

export const DEFAULT_SWAY: SwayConfig = { mPerMs: 0.075, maxM: 0.28, flutterShare: 0.2 };

export interface SwayState {
  /** Top deflection of a tree with flexibility 1, and the flutter, in metres. */
  swayM: number;
  flutterM: number;
}

/**
 * Largest horizontal deflection as a multiple of the bend and the flutter. Follows from the formula in the vertex shader
 * (bend with the wind, quarter bend across, flutter in three axes).
 */
const SWAY_BOUND = 1.03;
const FLUTTER_BOUND = 1.46;

export function swayAt(windSpeedMs: number, p: SwayConfig = DEFAULT_SWAY): SwayState {
  const swayM = Math.min(p.maxM, Math.max(0, windSpeedMs) * p.mPerMs);
  return { swayM, flutterM: swayM * p.flutterShare };
}

/** How far a canopy with the given flexibility deflects horizontally at most. A check compares it with the gap at a wall. */
export function maxSway(windSpeedMs: number, flex = 1, p: SwayConfig = DEFAULT_SWAY): number {
  const { swayM, flutterM } = swayAt(windSpeedMs, p);
  return flex * swayM * SWAY_BOUND + flutterM * FLUTTER_BOUND;
}

/** Sway slot: fills the free lanes of the engine's `u_wind` member. */
export function swaySlot(sway: Partial<SwayConfig> = {}): EnvSlot<SwayConfig, SwayState> {
  return {
    name: 'sway',
    params: { ...DEFAULT_SWAY, ...sway },
    fields: [{ member: 'u_wind', lanes: 'zw', doc: 'z tree top deflection in metres, w foliage flutter in metres' }],
    compute: (env, p) => swayAt(env.windSpeedMs, p),
    lanes: (s) => [s.swayM, s.flutterM],
  };
}
