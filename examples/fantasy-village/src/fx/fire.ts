// The forge fire: tongues of flame over the coal bed, a white-hot core, sparks that leap and fall, a little smoke at
// the hearth mouth (most of it leaves through the flue), and a strongly flickering orange light that also sways.

import type { ParticleSource, PointLight, Vec3 } from '../kit/index.ts';
import { chimneySmoke } from './smoke.ts';

export interface ForgeFire {
  particles: ParticleSource[];
  light: PointLight;
  /** Base light position (the light wanders around it in `sway`). */
  base: Vec3;
}

export function forgeFire(fire: Vec3, flueTop: Vec3, light: Vec3): ForgeFire {
  const [x, y, z] = fire;
  const particles: ParticleSource[] = [
    // Tongues of flame: born over the whole coal bed, short-lived, shrinking as they rise.
    { kind: 'fire', position: [x, y, z], count: 46, life: 0.85, size: [0.42, 0.1], rise: 0.85, spread: [0.32, 0.08], wind: 0.05, colorStart: [1.7, 0.75, 0.22, 0.95], colorEnd: [0.9, 0.18, 0.04, 0] },
    // The hot core where the bellows blow: small, white-yellow, very bright.
    { kind: 'fire', position: [x, y - 0.03, z], count: 18, life: 0.5, size: [0.26, 0.08], rise: 0.45, spread: [0.12, 0.05], colorStart: [2.2, 1.6, 0.8, 1], colorEnd: [1.4, 0.5, 0.1, 0] },
    // Sparks: thrown up and out, falling back under gravity.
    { kind: 'spark', position: [x, y + 0.1, z], count: 56, life: 1.5, size: [0.06, 0.025], rise: 2.4, spread: [0.22, 1.0], gravity: 5.5, colorStart: [2.2, 1.2, 0.45, 1], colorEnd: [1.3, 0.3, 0.05, 0] },
    // Lazy embers drifting up into the hood.
    { kind: 'spark', position: [x, y + 0.2, z], count: 16, life: 2.8, size: [0.04, 0.015], rise: 0.6, spread: [0.25, 0.15], wind: 0.2, colorStart: [1.8, 0.7, 0.2, 0.9], colorEnd: [0.8, 0.15, 0.03, 0] },
    // A whiff of smoke spilling under the hood.
    { kind: 'smoke', position: [x, y + 0.45, z], count: 8, life: 2.2, size: [0.3, 0.9], rise: 0.4, spread: [0.2, 0.08], wind: 0.2, colorStart: [0.35, 0.33, 0.33, 0.25], colorEnd: [0.5, 0.48, 0.5, 0] },
    ...chimneySmoke(flueTop, { strength: 1.25, soot: 0.6 }),
  ];
  const base: Vec3 = [light[0], light[1], light[2]];
  return { particles, base, light: { position: [light[0], light[1], light[2]], color: [1.0, 0.48, 0.16], radius: 9.5, intensity: 1.9, when: 'always', flicker: 0.6 } };
}

/** Moves the fire light a little (flames dancing); writes into the existing position array, no allocation. */
export function swayFireLight(f: ForgeFire, t: number): void {
  const p = f.light.position;
  p[0] = f.base[0] + 0.07 * Math.sin(t * 5.3) + 0.04 * Math.sin(t * 11.7);
  p[1] = f.base[1] + 0.06 * Math.sin(t * 7.1 + 1.3);
  p[2] = f.base[2] + 0.07 * Math.sin(t * 4.1 + 2.1) + 0.03 * Math.sin(t * 13.3);
}
