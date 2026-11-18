// Chimney smoke for the buildings: call `chimneySmoke(top)` with the world position of a chimney's mouth and add the
// result to the building's `particles`. Two emitters: a dense young core that leaves the chimney quickly and widens,
// and a long, thin trail of old smoke that drifts far with the wind and fades.

import type { ParticleSource, Vec3 } from '../kit/index.ts';

export interface SmokeOptions {
  /** 1 a normal hearth, 0.5 a banked fire, 1.5 a forge or bakery. Scales count, opacity and size. */
  strength?: number;
  /** Darker, sootier smoke (0 clean wood smoke, 1 coal). */
  soot?: number;
}

/** Soft puffs rising from a chimney mouth at `top` (world), widening, carried by the wind and fading. ~28 particles. */
export function chimneySmoke(top: Vec3, o: SmokeOptions = {}): ParticleSource[] {
  const k = o.strength ?? 1;
  const d = 1 - 0.35 * (o.soot ?? 0);
  return [
    {
      kind: 'smoke', position: [top[0], top[1] + 0.1, top[2]], count: Math.round(16 * k), life: 5.5, size: [0.45 * Math.sqrt(k), 2.2 * k],
      rise: 1.1, spread: [0.12, 0.12], wind: 0.8,
      colorStart: [0.55 * d, 0.53 * d, 0.55 * d, Math.min(0.85, 0.6 * k)], colorEnd: [0.78 * d, 0.76 * d, 0.8 * d, 0],
    },
    {
      kind: 'smoke', position: [top[0], top[1] + 0.6, top[2]], count: Math.round(12 * k), life: 11, size: [0.9 * k, 4.2 * k],
      rise: 0.7, spread: [0.2, 0.22], wind: 1,
      colorStart: [0.62 * d, 0.6 * d, 0.64 * d, Math.min(0.5, 0.32 * k)], colorEnd: [0.8 * d, 0.78 * d, 0.84 * d, 0],
    },
  ];
}
