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
export { CLOUD_NOISE, CLOUD_NOISE_RADIAL, CLOUD_OCTAVES, CLOUD_WEATHER_GLSL, LIGHTING, SHADOW_QUERY, cloudShadowFillFs, cloudWeatherFillFs, lightingGlsl, shadowGlsl } from './glsl.ts';
export {
  DEFAULT_WEATHER_GROUND,
  PRECIPITATION_GLSL,
  PRECIPITATION_IMPACT_PERIOD_M,
  PRECIPITATION_MAX_TILES,
  PRECIPITATION_MIN,
  RAIN_FALL,
  RAIN_RINGS,
  RAIN_SHELLS,
  RAIN_SPLASHES,
  SNOW_FALL,
  SNOW_SHELLS,
  SNOW_SPECKS,
  precipitationClock,
  precipitationCount,
  precipitationDown,
  precipitationDrop,
  precipitationEyeOffset,
  precipitationImpactAt,
  precipitationImpactClock,
  precipitationTiles,
  precipitationVelocity,
  weatherGround,
} from './precipitation.ts';
export type { PrecipitationDrop, PrecipitationFall, PrecipitationImpact, PrecipitationMark, PrecipitationShell, WeatherGroundRates } from './precipitation.ts';
export { CLOUD_FIELD_SLOT, cloudFieldCover, cloudFieldSlot, cloudFieldSun } from './cloud-field.ts';
export type { CloudCoverField, CloudFieldValues } from './cloud-field.ts';
export { CLOUD_SHADOW_EXTENT_CLOUDS, CLOUD_SHADOW_SIZE, CLOUD_SHADOW_SLOT, CLOUD_SHADOW_UNIT, cloudShadowProjection, cloudShadowSlot } from './cloud-shadow.ts';
export type { CloudShadowParams, CloudShadowProjection, CloudShadowValues } from './cloud-shadow.ts';
export {
  CLOUD_RAIN_DENSITY,
  CLOUD_VOLUME_GLSL,
  CLOUD_VOLUME_QUALITY,
  CLOUD_VOLUME_TILE,
  DEFAULT_CLOUD_VOLUME_SHAPE,
  DEFAULT_CLOUD_WEATHER_RULES,
  cloudVolumeBayer,
  cloudVolumeColumnDepth,
  cloudVolumeDeck,
  cloudVolumeDensity,
  cloudVolumeDepthDistance,
  cloudVolumeDepthMap,
  cloudVolumeFade,
  cloudVolumeJitter,
  cloudVolumeKeepHistory,
  cloudVolumeMarchSize,
  cloudVolumeNearShare,
  cloudVolumeProfile,
  cloudVolumeRainCover,
  cloudVolumeRainShare,
  cloudVolumeReproject,
  cloudVolumeScreenBasis,
  cloudVolumeSpan,
  cloudVolumeTargetSize,
  cloudVolumeThreshold,
  cloudVolumeTiles,
  cloudVolumeTypedProfile,
  cloudWeatherKind,
} from './cloud-volume.ts';
export type { CloudVolumeQuality, CloudVolumeShape, CloudWeatherRules } from './cloud-volume.ts';
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
  atmosphereOvercast,
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
