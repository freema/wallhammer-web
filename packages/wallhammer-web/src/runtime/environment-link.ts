// Ties an environment to a renderer: every frame computes the environment for the view, hands the light direction,
// background and shadow key to the renderer and fills the environment's part of the Frame block from its slots.
// Programs that read the environment include `header` and `lighting` (or only `shadow`, the sun visibility without the
// light model); a slot with GLSL is included by its name.

import type { RGB } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { EnvSlot, FrameEnvironment } from '../base/env-slot.ts';
import type { Renderer } from '../render/index.ts';
import type { EnvFrameBlock, Environment } from '../env/index.ts';
import { ATMOSPHERE_FALLBACK, CLOUD_FIELD_SLOT, CLOUD_SHADOW_SLOT, CLOUD_SHADOW_UNIT, LIGHTING, SHADOW_QUERY, SKY_FALLBACK, lightingGlsl, shadowGlsl } from '../env/index.ts';

export interface EnvironmentLinkOptions {
  /** Background colour in full daylight; the environment darkens it at night. */
  background: RGB;
  /** The assembled Frame block; the renderer must have been created with it as `frameSlots`. */
  block: EnvFrameBlock;
}

export class EnvironmentLink {
  readonly env: Environment;
  readonly block: EnvFrameBlock;
  /** Environment of the last frame. */
  frame: FrameEnvironment | null = null;
  background: RGB;
  private slotValues: ReadonlyMap<EnvSlot<any, any>, unknown> = new Map();

  constructor(renderer: Renderer, env: Environment, options: EnvironmentLinkOptions) {
    const block = options.block;
    if (renderer.frameSlots.afterLight.length !== block.afterLight * 4 || renderer.frameSlots.afterView.length !== block.afterView * 4) {
      throw new Error('The renderer was created with other frame slots than this block (frameSlots: block)');
    }
    this.env = env;
    this.block = block;
    this.background = options.background;
    // A cloud cover by place (its slot) brings its functions with the lighting include; the cloud shadow texture (its
    // slot) makes `cloudLight` read the texture, from a unit fixed for every program.
    const byPlace = block.slots.some((s) => s.name === CLOUD_FIELD_SLOT);
    const shadowTexture = block.slots.some((s) => s.name === CLOUD_SHADOW_SLOT);
    const clouds = { cloudField: byPlace, cloudShadow: shadowTexture };
    renderer.includes.set('lighting', byPlace || shadowTexture ? lightingGlsl(clouds) : LIGHTING);
    renderer.includes.set('shadow', byPlace || shadowTexture ? shadowGlsl(clouds) : SHADOW_QUERY);
    if (shadowTexture) renderer.device.fixSampler('u_cloudShadow', CLOUD_SHADOW_UNIT);
    // `<sky>` always resolves: the sky slot's functions when it is registered, otherwise stand-ins without haze.
    renderer.includes.set('sky', SKY_FALLBACK);
    // The same for `<atmosphere>`: without the atmosphere slot `atmosphereApply` passes the colour unchanged.
    renderer.includes.set('atmosphere', ATMOSPHERE_FALLBACK);
    for (const s of block.slots) if (s.glsl !== undefined) renderer.includes.set(s.name, s.glsl);
    renderer.beforeFrame.push((view) => this.update(renderer, view));
  }

  /** Values a slot computed for the last frame, or undefined before the first frame. */
  value<V>(slot: EnvSlot<any, V>): V | undefined {
    return this.slotValues.get(slot) as V | undefined;
  }

  private update(renderer: Renderer, view: View): void {
    const E = this.env.frame(view);
    this.frame = E;
    const paper = this.background;
    renderer.background = [paper[0] * E.backdrop[0], paper[1] * E.backdrop[1], paper[2] * E.backdrop[2]];
    renderer.lightDirection = E.toSun;
    const packed = this.block.pack(E, renderer.frameSlots);
    this.slotValues = packed.values;
    // Slots name what changes the shadow map besides the light (for example how much light passes through a partly transparent occluder).
    renderer.shadowKeyExtra = packed.shadowKey;
  }
}
