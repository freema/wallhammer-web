// The moving sea of the planet example: the engine's liquid below a level (`LiquidSurface` of env, its layers in
// runtime) with this page's wind, look and materials.
//
// The waves are a sum of trochoidal trains raised by the page's wind (`PLANET_WIND`) on a chart of the sphere (the face
// of a cube under the eye). `seaUniforms` gives every material of the cells (shaders.ts) the eye's height above the
// moving surface, the chart and, for the water, the trains and the ripples. The near surface (`SeaSurfaceLayer`) is a
// grid of rings round the eye's foot moved by the waves (`NEAR_WATER_MATERIAL`); the water of the cells leaves out its
// disc. The backdrop (`SeaBackdrop`) stands at the distance where the water hides everything while the eye is under it,
// the light shafts (`SeaShaftsLayer`) are added along every view ray then, and the waterline (`SeaLensLayer`) splits the
// picture where the surface passes through the front of the lens.

import type { Uniforms, Vec3 } from 'wallhammer-web/base';
import { LiquidSurface } from 'wallhammer-web/env';
import type { WaveTrain } from 'wallhammer-web/gen-core';
import type { Renderer } from 'wallhammer-web/render';
import { LiquidBackdropLayer, LiquidLensLayer, LiquidNearLayer, LiquidShaftsLayer } from 'wallhammer-web/runtime';
import { NEAR_WATER_MATERIAL, SEA_LOOK } from './shaders.ts';
import { PLANET_WIND } from './weather.ts';
import { RADIUS_M } from './world.ts';

/** Radius in metres round the eye's foot that the near surface covers while the eye is low. */
export const SEA_NEAR_M = 500;
/** The waves' heights fade out between these heights of the eye (m); above the upper one the near surface is off. */
export const SEA_NEAR_FADE_M = [60, 120] as const;

/** The sea: a factor of 1.3 on the heights of the wind's sea (Pierson–Moskowitz), for a livelier surface than 6 m/s alone raises. */
export const SEA = new LiquidSurface({ radiusM: RADIUS_M, wind: PLANET_WIND, heightScale: 1.3, nearM: SEA_NEAR_M, nearFadeM: SEA_NEAR_FADE_M, look: SEA_LOOK });

/** What `seaUniforms` computed last: the eye's height above the moving surface and above the level. */
export const seaState = SEA.state;

/** The trains of a face for a seed: the page's wind, its direction taken against the face's north. */
export function seaTrains(seed: number, face: number): WaveTrain[] {
  return SEA.trains(seed, face);
}

/** Factor on the waves' heights for an eye `heightM` above the level: 1 low down, 0 from the upper fade height up. */
export function seaWaveFactor(heightM: number): number {
  return SEA.waveFactor(heightM);
}

/**
 * Height in metres of the moving surface above the level over the point `p` (world metres from the centre) at
 * `timeS`, with the waves as tall as an eye at `eyeHeightM` sees them (default: full). A pure function.
 */
export function seaSurfaceHeight(seed: number, p: Vec3, timeS: number, eyeHeightM = 0): number {
  return SEA.surfaceHeight(seed, p, timeS, eyeHeightM);
}

/**
 * The sea's uniforms for a frame: `common` for every material of the cells and the layers, `water` for the water
 * (common and the trains). `eye` and `origin` are world positions (the render origin), the time the animation time.
 * The same objects are rewritten every call, so a frame allocates nothing.
 */
export function seaUniforms(seed: number, eye: Vec3, origin: Vec3, timeS: number): { common: Uniforms; water: Uniforms } {
  return SEA.uniforms(seed, eye, origin, timeS);
}

/** The near surface: drawn after the cells while `seaUniforms` says the eye is low. */
export class SeaSurfaceLayer extends LiquidNearLayer {
  constructor(renderer: Renderer) {
    super(renderer, SEA, NEAR_WATER_MATERIAL, { name: 'sea-near' });
  }
}

/** The backdrop under the water. Add it before the streamed world. */
export class SeaBackdrop extends LiquidBackdropLayer {
  constructor(renderer: Renderer) {
    super(renderer, SEA, { name: 'sea-backdrop' });
  }
}

/** The light shafts while the eye is under the water: one full-screen pass after the water. */
export class SeaShaftsLayer extends LiquidShaftsLayer {
  constructor(renderer: Renderer) {
    super(renderer, SEA, { name: 'sea-shafts' });
  }
}

/** The waterline across the lens while the eye is within a few decimetres of the moving surface. Drawn last. */
export class SeaLensLayer extends LiquidLensLayer {
  constructor(renderer: Renderer) {
    super(renderer, SEA, { name: 'sea-lens' });
  }
}
