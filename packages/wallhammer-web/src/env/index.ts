// Layer 5, env: time, sun and sky, light colours, fog, wind, clouds, precipitation, wetness and snow cover as frame
// parameters, and the assembly of environment slots into the Frame block.

export {
  Environment,
  DEFAULT_STUDIO,
  DEFAULT_FIXED,
  DEFAULT_SITE,
  DEFAULT_DAY,
  DEFAULT_WIND,
  DEFAULT_CLOUDS,
  DEFAULT_WEATHER,
  DEFAULT_SNOW_ALBEDO,
  studioLightDirection,
  cloudCoverTerms,
} from './environment.ts';
export { CLOUD_NOISE, CLOUD_NOISE_RADIAL, CLOUD_OCTAVES, LIGHTING, SHADOW_QUERY, lightingGlsl, shadowGlsl } from './glsl.ts';
export { CLOUD_FIELD_SLOT, cloudFieldCover, cloudFieldSlot, cloudFieldSun } from './cloud-field.ts';
export type { CloudCoverField, CloudFieldValues } from './cloud-field.ts';
export { DEFAULT_SKY, SKY_FALLBACK, SKY_GLSL, computeSky, skySlot } from './sky.ts';
export type { SkyParams, SkyValues } from './sky.ts';
export {
  ATMOSPHERE_FALLBACK,
  ATMOSPHERE_TABLE_LAYOUT,
  ATMOSPHERE_TABLE_UNIT,
  DEFAULT_ATMOSPHERE,
  DEFAULT_ATMOSPHERE_MEDIUM,
  atmosphereFor,
  atmosphereGlsl,
  atmosphereSlot,
  atmosphereTables,
  computeAtmosphere,
} from './atmosphere.ts';
export type { AtmosphereMedium, AtmosphereParams, AtmosphereSlot, AtmosphereTables, AtmosphereValues } from './atmosphere.ts';
export { ENV_CORE_SLOT, assembleFrameBlock } from './frame-block.ts';
export type { EnvFrameBlock, FrameBlockValues, FrameRegions } from './frame-block.ts';
export type { CloudConfig, DayLight, EnvironmentConfig, FixedLight, StudioLight, SunObserver, WeatherState, WindConfig } from './environment.ts';
export { dayOfYear, skyDirection, sphereSunDirection, sunPosition } from './sun.ts';
export type { SunPosition, SunSite } from './sun.ts';
