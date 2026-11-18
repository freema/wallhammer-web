// How something is drawn, as a plain description: shaders per pass, fixed draw state, uniforms and samplers.
// Content packages describe materials and texture bakes with these types; the render module compiles and runs them.
// Shader sources may contain include lines (`#include <name>` on a line of its own), resolved by the renderer:
// `header` (version, precision, the Frame and Palette blocks), `noise` (integer-hash noise) and whatever the
// renderer's owner registered (for example lighting from the environment).

import type { TextureData, TextureSampling } from './data.ts';

/**
 * - `shadow`: depth from the light into the shadow map (only when it is refitted)
 * - `color`: the normal image
 * - `data`: replaces `color` when the renderer is in data mode (flat debugging views)
 * - `overlay`: after `color`, screen-space effects; skipped in data mode
 */
export type PassName = 'shadow' | 'color' | 'data' | 'overlay';

export type BlendFactor = 'zero' | 'one' | 'src-alpha' | 'one-minus-src-alpha';

/** Blend equation `src * srcFactor + dst * dstFactor`, with optional separate factors for alpha. */
export interface BlendSpec {
  src: BlendFactor;
  dst: BlendFactor;
  srcAlpha?: BlendFactor;
  dstAlpha?: BlendFactor;
}

/** Faces skipped by a draw. */
export type CullMode = 'none' | 'back' | 'front';

/** Fixed-function state of a draw. Fields left out keep their current value. */
export interface DrawState {
  depthTest?: boolean;
  depthFunc?: 'less' | 'lequal';
  depthWrite?: boolean;
  /** True culls back faces, false culls nothing. `cull`, when given in the same state, wins over it. */
  cullBack?: boolean;
  /**
   * Which faces are not drawn: none, the back faces (counter-clockwise is front) or the front faces (for example an
   * outline hull drawn from the inside of an enlarged copy). Wins over `cullBack` in the same state object.
   */
  cull?: CullMode;
  /** `null` = no blending. */
  blend?: BlendSpec | null;
  /** Multisample coverage from fragment alpha. */
  alphaToCoverage?: boolean;
  /** Depth offset `[factor, units]`, `null` = off. */
  polygonOffset?: readonly [number, number] | null;
}

/** Value of one uniform, tagged by its GLSL type. */
export type UniformValue =
  | { readonly int: number }
  | { readonly float: number }
  | { readonly vec2: readonly [number, number] }
  | { readonly vec3: readonly [number, number, number] }
  | { readonly vec4: readonly [number, number, number, number] }
  | { readonly ivec4: readonly [number, number, number, number] }
  | { readonly mat4: Float32Array };

export type Uniforms = Record<string, UniformValue>;

export interface ShaderSource {
  vs: string;
  fs: string;
}

/** A program per pass. `'depth'` is the renderer's plain depth program (position attribute `a_pos`). */
export interface MaterialDesc {
  name: string;
  /** Fixed attribute locations shared by every program of the material and by the meshes drawn with it. */
  attribs: Readonly<Record<string, number>>;
  passes: Partial<Record<PassName, ShaderSource | 'depth'>>;
  /** Extra draw state per pass, on top of the pass base state. */
  state?: Partial<Record<PassName, DrawState>>;
}

/** Output of a bake: an RGBA8 texture of the bake's size. */
export type BakeTarget = { format: 'rgba8' } & TextureSampling;

/**
 * A texture bake: one fragment shader run over a full-screen triangle into one or more targets (MRT, `location = i`).
 * Inputs are bound in order to the units 0, 1, …; the shader reads them with `texelFetch` or `texture`.
 */
export interface BakeDesc {
  name: string;
  width: number;
  height: number;
  fs: string;
  inputs: readonly { sampler: string; texture: TextureData }[];
  uniforms?: Uniforms;
  targets: readonly BakeTarget[];
}
