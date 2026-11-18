// The example's own environment slot: a warm glow that wakes up after sunset. It shows how content adds to the
// generic environment without the engine knowing about it: params, a pure compute and one Frame member.

import type { EnvSlot } from 'wallhammer-web/base';

export interface GlowParams {
  color: [number, number, number];
  /** Sun heights in degrees between which the glow fades in (from the second to the first). */
  fullBelowDeg: number;
  offAboveDeg: number;
}

export interface GlowState {
  color: readonly [number, number, number];
  strength: number;
}

export function glowSlot(params: Partial<GlowParams> = {}): EnvSlot<GlowParams, GlowState> {
  return {
    name: 'glow',
    params: { color: [1.0, 0.62, 0.3], fullBelowDeg: -6, offAboveDeg: 3, ...params },
    fields: [{ member: 'u_glow', order: 100, lanes: 'xyzw', doc: 'rgb glow colour, w strength 0–1' }],
    compute: (env, p) => {
      if (env.mode === 'studio') return { color: p.color, strength: 0 };
      const t = Math.min(1, Math.max(0, (env.sunElevationDeg - p.fullBelowDeg) / (p.offAboveDeg - p.fullBelowDeg)));
      return { color: p.color, strength: 1 - t * t * (3 - 2 * t) };
    },
    lanes: (g) => [g.color[0], g.color[1], g.color[2], g.strength],
  };
}
