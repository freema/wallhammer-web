// The generic environment of one frame and the contract for environment slots.
//
// The engine's environment knows only time, sun and sky, light colours, fog, wind, clouds, precipitation, wetness and
// snow cover. Anything that interprets them for a particular kind of content (how foliage follows the season, how
// lit openings glow at night, where snow settles) is a slot: plain params, a pure compute from the generic state,
// the Frame block members it fills and optional GLSL. Content packages and apps define slots; the engine assembles
// them into one Frame block in a deterministic order.

import type { RGB, Vec3 } from './math.ts';

export type LightMode = 'studio' | 'day';

/** Vertical extent of the fog layer: it is densest at `bottomY` and thins out toward `topY`. */
export interface FogLayer {
  bottomY: number;
  topY: number;
}

/** What one frame needs to know about the generic environment. */
export interface FrameEnvironment {
  mode: LightMode;
  /** Unit direction toward the light (sun or moon). */
  toSun: Vec3;
  /** Height of the sun above the horizon in degrees (in studio mode the studio light's height). */
  sunElevationDeg: number;
  sun: RGB;
  ambient: RGB;
  skyFill: RGB;
  bounce: RGB;
  warmTint: RGB;
  exposure: number;
  /** Multiple of the background colour: 1 by day, dark blue at night. */
  backdrop: RGB;
  /** Animation time in seconds and hour of day. */
  time: number;
  hour: number;
  /** Day of year (1–366). */
  dayOfYear: number;
  /** Wind: unit direction it blows toward (x, z), speed in m/s, gusts. */
  windX: number;
  windZ: number;
  windSpeedMs: number;
  gustLengthM: number;
  gustSpeed: number;
  /** Clouds: pattern offset in metres, darkening, size and noise thresholds. */
  cloudX: number;
  cloudZ: number;
  cloudDarkness: number;
  cloudSizeM: number;
  cloudLo: number;
  cloudHi: number;
  /** Weather, all 0–1. */
  cloudCover: number;
  snowCover: number;
  wetness: number;
  fog: number;
  /** Fog colour in screen space and the vertical extent of the fog layer. */
  fogColor: RGB;
  fogLayer: FogLayer;
  precipitation: number;
  /** 0 rain, 1 snow. */
  precipitationKind: number;
  snowAlbedo: RGB;
  /** True unit direction toward the sun, also below the horizon (`toSun` is clamped and turns to the moon at night). */
  sunDir: Vec3;
  /** Unit direction toward the moon. */
  moonDir: Vec3;
  /** Sky colours as seen, in screen space: straight up, at the horizon, and the light scattered around the sun. */
  skyZenith: RGB;
  skyHorizon: RGB;
  sunGlow: RGB;
}

/** Which region of the Frame block a member lives in: right after the light direction, or after the view axes. */
export type FrameRegion = 'afterLight' | 'afterView';

/**
 * Part of one vec4 member of the Frame block. Several fields (from different slots) may share a member when their
 * lanes do not overlap. Exactly one field per member gives `order`: members are sorted by it within their region.
 * The engine's own members use multiples of 10.
 */
export interface FrameField {
  /** GLSL name of the vec4 member, for example `u_wind`. */
  member: string;
  /** Lanes this field fills, in order, for example `'zw'`. */
  lanes: string;
  /** Short description of the lanes for the comment in the block, for example `'z bend in metres, w flutter in metres'`. */
  doc: string;
  /** Position of the member within its region; only on the field that declares the member. */
  order?: number;
  /** Default `'afterView'`. */
  region?: FrameRegion;
}

/**
 * An environment slot. `compute` must be pure: the same generic state and params give the same values.
 * `lanes` flattens the values into the lanes of `fields`, in order. The optional `glsl` (functions over the Frame
 * members) is registered as the shader include `#include <name>`. `shadowKey` names the part of the values that
 * changes the shadow map (for example how much light passes through a partly transparent occluder); the shadow map is redrawn when it changes.
 */
export interface EnvSlot<P = unknown, V = unknown> {
  readonly name: string;
  /** Plain parameters; changes apply from the next frame. */
  params: P;
  readonly fields: readonly FrameField[];
  compute(env: FrameEnvironment, params: P): V;
  lanes(values: V): readonly number[];
  readonly glsl?: string;
  shadowKey?(values: V): string;
}
