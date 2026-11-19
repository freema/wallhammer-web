// Scene environment: light, time of day, date, weather, wind and clouds. Holds two clocks (animation time and hour of day)
// and for every frame computes from them what the shaders need to know. The app only sets values and runs the clocks.
//
// Three lighting modes:
//  - 'studio': the sun rotates with the camera, the scene is always lit from the left. The hour of day does not matter.
//  - 'day': the sun follows its real path for the given place and date, light colours change with its height,
//    the moon shines at night and the sky is blue.
//  - 'fixed': the light stands in one world direction (`fixed.toLight`) with the colours and strengths given in
//    `fixed`; neither the camera, the place nor the hour change it. Change `fixed` at any time.
//
// Weather (cloud cover, precipitation, snow, wetness, fog) and the date apply in both modes. Everything is a pure
// function of the clocks and the given numbers: the same values give the same frame. What content makes of it (foliage
// by season, lit openings at night, where snow settles) lives in environment slots (`EnvSlot`), not here.

import { Clock } from '../core/clock.ts';
import { DEG, clamp, lerp, normalize, smoothstep } from '../base/math.ts';
import type { RGB, Vec3 } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { FogLayer, FrameEnvironment, LightMode } from '../base/env-slot.ts';
import { upFrame } from '../base/up.ts';
import { skyDirection, sunPosition } from './sun.ts';
import type { SunPosition, SunSite } from './sun.ts';

export type { FogLayer, FrameEnvironment, LightMode, RGB };

/**
 * Direction to a light that turns with the view: azimuth is measured from the "toward the viewer" direction to the left
 * across the screen, 90° is exactly from the left, a smaller angle lights more from the front.
 */
export function studioLightDirection(heading: number, azimuthFromViewDeg: number, elevationDeg: number): Vec3 {
  // Screen right and the horizontal direction away from the viewer for a view with this heading.
  const right: Vec3 = [Math.cos(heading), 0, -Math.sin(heading)];
  const g: Vec3 = [-Math.sin(heading), 0, -Math.cos(heading)];
  const a = azimuthFromViewDeg * DEG;
  const e = elevationDeg * DEG;
  const h = Math.cos(e);
  return normalize([h * (-right[0] * Math.sin(a) - g[0] * Math.cos(a)), Math.sin(e), h * (-right[2] * Math.sin(a) - g[2] * Math.cos(a))]);
}

/** Studio light. Colours are multiples of the surface colour. */
export interface StudioLight {
  /** Sun height above the horizon. */
  sunElevationDeg: number;
  /** Sun angle from the direction toward the viewer to the left across the screen. 90° = exactly from the left. */
  sunAzimuthFromViewDeg: number;
  sun: RGB;
  ambient: RGB;
  /** Sky light from above, at full strength on horizontal surfaces. */
  skyFill: RGB;
  /** Warm bounce from the ground, at full strength on vertical walls. */
  bounce: RGB;
  /** Surface colour shift, multiplies the surface colour. */
  warmTint: RGB;
  /** Overall brightness before the output curve. */
  exposure: number;
}

/** Light of the 'fixed' mode: a direction in the world and the light's numbers as they are. Colours are multiples of the surface colour. */
export interface FixedLight {
  /** Direction toward the light in world axes; need not be unit (it is normalised each frame). */
  toLight: Vec3;
  sun: RGB;
  ambient: RGB;
  /** Sky light from above, at full strength on horizontal surfaces. */
  skyFill: RGB;
  /** Light from below, at full strength on vertical walls. */
  bounce: RGB;
  /** Multiplies the surface colour. */
  warmTint: RGB;
  /** Overall brightness before the output curve. */
  exposure: number;
  /** Multiple of the renderer's background colour. */
  backdrop: RGB;
}

/** Light colours during the day. Values blend between day and night according to the sun height. */
export interface DayLight {
  /** Sun high and sun just above the horizon. */
  sunHigh: RGB;
  sunLow: RGB;
  ambientDay: RGB;
  ambientNight: RGB;
  /** Addition to ambient light at dusk and dawn. */
  twilight: RGB;
  /** How much the sky light from above strengthens when the sun is low. The ground does not go black, walls in shadow barely brighten. */
  lowSunFill: number;
  /** How much the overall brightness rises when the sun is not high. Mornings and afternoons are thus not grey. */
  lowSunExposure: number;
  skyDay: RGB;
  skyNight: RGB;
  bounce: RGB;
  tintDay: RGB;
  tintNight: RGB;
  /** Moon: colour and fixed position in the sky (azimuth from north clockwise). */
  moon: RGB;
  moonAzimuthDeg: number;
  moonElevationDeg: number;
  /** Multiple of the background colour at night. */
  backdropNight: RGB;
  /** Brightness at night. Higher than by day so the night stays readable. */
  exposureNight: number;
  /** The light does not drop below this: under this angle shadows would be infinite and could not be computed. */
  minLightElevationDeg: number;
  /** Sky as seen, in screen space: straight up and at the horizon, by day and at night. */
  skyZenithDay: RGB;
  skyHorizonDay: RGB;
  skyZenithNight: RGB;
  skyHorizonNight: RGB;
  /** Added to the horizon at dusk and dawn. */
  skyTwilight: RGB;
  /** Light scattered in the sky around the sun, sun high and sun low. */
  sunGlowHigh: RGB;
  sunGlowLow: RGB;
}

/** Wind. The direction is meteorological: where it blows from, 0 = from the north, 90 = from the east. */
export interface WindConfig {
  fromDeg: number;
  /** Speed in m/s. A light breeze is 2–3 m/s. */
  speedMs: number;
}

/** Cloud shadows on the scene. How many clouds there are is given by the cloud cover in the weather (`WeatherState.cloudCover`). */
export interface CloudConfig {
  /** How much direct sun a cloud removes at partly cloudy, 0–1. 0 turns cloud shadows off. */
  darkness: number;
  /** Cloud size in metres. */
  sizeM: number;
  /** How many times faster than the wind at ground level the clouds drift. */
  speedFactor: number;
}

/** Weather as the core draws it. Everything 0–1, the app converts its data to this. */
export interface WeatherState {
  /** Cloud cover: 0 clear, 0.5 partly cloudy with drifting cloud shadows, 1 overcast (the sun barely shines, shadows vanish). */
  cloudCover: number;
  /** Precipitation strength 0–1 and its kind. Drawn as rain or snowfall over the image. */
  precipitation: number;
  precipitationKind: 'rain' | 'snow';
  /** Snow cover 0–1. Where it settles is up to the content (an environment slot). */
  snowCover: number;
  /** Wetness 0–1: darker and glossier surfaces. */
  wetness: number;
  /** Fog and haze 0–1. Densest at the floor of the fog layer. */
  fog: number;
}

export interface EnvironmentConfig {
  mode?: LightMode;
  studio?: Partial<StudioLight>;
  /** Direction and numbers of the 'fixed' mode. */
  fixed?: Partial<FixedLight>;
  /** Place and date for 'day' mode. */
  site?: Partial<SunSite>;
  day?: Partial<DayLight>;
  wind?: Partial<WindConfig>;
  clouds?: Partial<CloudConfig>;
  weather?: Partial<WeatherState>;
  /** Vertical extent of the fog layer. */
  fogLayer?: FogLayer;
  /** Snow colour as a multiple of the light (albedo). */
  snowAlbedo?: RGB;
  /** Initial hour of day (0–24) and the speed of its run in hours per second. */
  hour?: number;
  hoursPerSecond?: number;
  /** Should wind and clouds run right from the start? */
  animate?: boolean;
}

export const DEFAULT_STUDIO: StudioLight = {
  sunElevationDeg: 44,
  sunAzimuthFromViewDeg: 80,
  sun: [1.4, 1.29, 0.87],
  ambient: [0.3, 0.3, 0.43],
  skyFill: [0.1, 0.11, 0.14],
  bounce: [0.05, 0.04, 0.02],
  warmTint: [1.02, 1.0, 0.93],
  exposure: 1.0,
};

/** The 'fixed' light: the studio colours, from the south-west, 44° high. */
export const DEFAULT_FIXED: FixedLight = {
  toLight: [-0.5, 0.7, 0.5],
  sun: DEFAULT_STUDIO.sun,
  ambient: DEFAULT_STUDIO.ambient,
  skyFill: DEFAULT_STUDIO.skyFill,
  bounce: DEFAULT_STUDIO.bounce,
  warmTint: DEFAULT_STUDIO.warmTint,
  exposure: DEFAULT_STUDIO.exposure,
  backdrop: [1, 1, 1],
};

export const DEFAULT_SITE: SunSite = { latitudeDeg: 50, longitudeDeg: 15, dayOfYear: 172, utcOffsetHours: 2 };

export const DEFAULT_DAY: DayLight = {
  sunHigh: [1.4, 1.29, 0.87],
  sunLow: [1.5, 0.74, 0.32],
  ambientDay: [0.3, 0.3, 0.43],
  ambientNight: [0.15, 0.18, 0.27],
  twilight: [0.09, 0.035, 0.06],
  lowSunFill: 2.5,
  lowSunExposure: 0.15,
  skyDay: [0.1, 0.11, 0.14],
  skyNight: [0.05, 0.065, 0.11],
  bounce: [0.05, 0.04, 0.02],
  tintDay: [1.02, 1.0, 0.93],
  tintNight: [0.88, 0.95, 1.1],
  moon: [0.17, 0.22, 0.35],
  moonAzimuthDeg: 135,
  moonElevationDeg: 40,
  backdropNight: [0.2, 0.25, 0.4],
  exposureNight: 1.45,
  minLightElevationDeg: 3,
  skyZenithDay: [0.25, 0.45, 0.74],
  skyHorizonDay: [0.66, 0.77, 0.86],
  skyZenithNight: [0.02, 0.035, 0.08],
  skyHorizonNight: [0.08, 0.11, 0.19],
  skyTwilight: [0.42, 0.16, 0.05],
  sunGlowHigh: [0.2, 0.18, 0.12],
  sunGlowLow: [0.62, 0.3, 0.08],
};

export const DEFAULT_WIND: WindConfig = { fromDeg: 270, speedMs: 3 };
export const DEFAULT_CLOUDS: CloudConfig = { darkness: 0.3, sizeM: 320, speedFactor: 1.5 };
export const DEFAULT_WEATHER: WeatherState = { cloudCover: 0, precipitation: 0, precipitationKind: 'rain', snowCover: 0, wetness: 0, fog: 0 };
export const DEFAULT_SNOW_ALBEDO: RGB = [0.66, 0.65, 0.62];

/** Gust length in metres: the distance between waves travelling across the landscape with the wind. */
const GUST_LENGTH_M = 70;

// --- Transitions by sun height (degrees) ------------------------------------------------------------
/** Day and night: ambient light, sky, tint. */
const DAY_FROM = -6;
const DAY_TO = 6;
/** The sun gains strength from the moment it is just below the horizon. */
const SUN_FROM = -1.5;
const SUN_TO = 9;
/** Sun colour: from low to high. */
const WARM_FROM = 2;
const WARM_TO = 30;
/** The moon shines only when the sun is deep below. Between SUN_FROM and MOON_TO nothing directional shines, the light direction is swapped there. */
const MOON_FROM = -9;
const MOON_TO = -3.5;
/** Below this sun height ambient light starts to be added, above it the day is like noon. */
const LOW_SUN_FROM = 3;
const LOW_SUN_TO = 36;
/** Range of sun heights in which brightness is compensated: fully below the first value, not at all above the second. */
const DIM_FROM = 10;
const DIM_TO = 55;
/** Twilight width for the colour addition. */
const TWILIGHT_WIDTH = 6;

// --- Cloud cover --------------------------------------------------------------------------------------------
/** From what cloud cover a continuous layer starts that dims the sun everywhere, and how much of it remains when overcast. */
const OVERCAST_FROM = 0.55;
const OVERCAST_SUN = 0.2;
/** Cloud shadows: noise threshold at cloud cover 0 and 1. Below OVERCAST they gradually merge and vanish. */
const CLOUD_EDGE_CLEAR = 0.92;
const CLOUD_EDGE_FULL = 0.12;
const CLOUD_EDGE_WIDTH = 0.18;
/** How much sunlight is scattered into the surroundings and sky when overcast and how much it cools. */
const OVERCAST_AMBIENT = 0.17;
const OVERCAST_SKY = 0.15;
const OVERCAST_COOL: RGB = [0.95, 0.98, 1.02];
const OVERCAST_TINT: RGB = [0.97, 0.99, 1.02];
/** Fog colour in screen space: light grey with a hint of blue by day, dark at night. */
const FOG_DAY: RGB = [0.63, 0.64, 0.64];
const FOG_NIGHT: RGB = [0.09, 0.11, 0.16];
const FOG_TWILIGHT: RGB = [0.14, 0.06, 0.04];

// --- Sky as seen ----------------------------------------------------------------------------------------------
/** Overcast sky brightness as a multiple of the clear horizon's brightness. */
const OVERCAST_SKY_GREY = 0.92;
/** How far fog pulls the horizon, the zenith and the sun glow toward the fog colour at fog 1. */
const SKY_FOG_HORIZON = 0.85;
const SKY_FOG_ZENITH = 0.55;
const SKY_FOG_GLOW = 0.6;
/** How much green and blue the horizon loses with the sun just above it, and up to what sun height (degrees). */
const HORIZON_WARM: RGB = [0, 0.14, 0.32];
const HORIZON_WARM_TO = 24;
/** Sun heights (degrees) between which the glow around the sun fades in: it outlives the sunset a little. */
const GLOW_FROM = -10;
const GLOW_TO = -1;

/** Rec. 601 brightness of a colour. */
function luma(c: RGB): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

function mix3(a: RGB, b: RGB, t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function scale3(a: RGB, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/**
 * The cloud terms `Environment.frame` derives from a cloud cover, for code that needs them per place: the noise
 * thresholds of the shadow pattern, its darkness, the overcast share and the share of sunlight left by that overcast.
 */
export function cloudCoverTerms(
  cover: number,
  darkness: number,
): { lo: number; hi: number; darkness: number; overcast: number; sunShare: number } {
  const overcast = smoothstep(OVERCAST_FROM, 1, cover);
  const lo = lerp(CLOUD_EDGE_CLEAR, CLOUD_EDGE_FULL, clamp(cover / OVERCAST_FROM, 0, 1));
  return {
    lo,
    hi: lo + CLOUD_EDGE_WIDTH,
    darkness: cover > 0.01 ? darkness * (1 + 1.4 * smoothstep(0.1, OVERCAST_FROM, cover)) * (1 - overcast) : 0,
    overcast,
    sunShare: lerp(1, OVERCAST_SUN, overcast),
  };
}

/**
 * GLSL twin of `cloudCoverTerms` for shaders that look the cover up per place (not exported from the package):
 * `vec4 cloudCoverTerms(float cover, float darkness)` = (lo, hi, darkness, sun share).
 */
export const CLOUD_TERMS_GLSL = `
vec4 cloudCoverTerms(float cover, float darkness) {
  float overcast = smoothstep(${OVERCAST_FROM.toFixed(2)}, 1.0, cover);
  float lo = mix(${CLOUD_EDGE_CLEAR.toFixed(2)}, ${CLOUD_EDGE_FULL.toFixed(2)}, clamp(cover / ${OVERCAST_FROM.toFixed(2)}, 0.0, 1.0));
  float d = cover > 0.01 ? darkness * (1.0 + 1.4 * smoothstep(0.1, ${OVERCAST_FROM.toFixed(2)}, cover)) * (1.0 - overcast) : 0.0;
  return vec4(lo, lo + ${CLOUD_EDGE_WIDTH.toFixed(2)}, d, mix(1.0, ${OVERCAST_SUN.toFixed(2)}, overcast));
}
float cloudOvercast(float cover) {
  return smoothstep(${OVERCAST_FROM.toFixed(2)}, 1.0, cover);
}
`;

/**
 * Cloud cover from which the sky closes into a deck without gaps (the sky's deck is closed at `CLOUD_DECK_CLOSED`):
 * the shadow pattern on the ground fades into the shade of the closed deck between the two (not exported from the
 * package).
 */
export const CLOUD_DECK_CLOSING = 0.7;
export const CLOUD_DECK_CLOSED = 0.78;

/** How closed the deck over a cover is, 0–1: `smoothstep(CLOUD_DECK_CLOSING, CLOUD_DECK_CLOSED, cover)`. */
export function cloudDeckClosed(cover: number): number {
  return smoothstep(CLOUD_DECK_CLOSING, CLOUD_DECK_CLOSED, cover);
}

/** GLSL twin of `cloudDeckClosed` (not exported from the package). */
export const CLOUD_DECK_GLSL = `
float cloudDeckClosed(float cover) {
  return smoothstep(${CLOUD_DECK_CLOSING.toFixed(2)}, ${CLOUD_DECK_CLOSED.toFixed(2)}, cover);
}
`;

/**
 * The sun for a world whose up depends on the place: `sunDir` is the unit direction to the sun in the world's axes
 * (the same for every place), `up` the unit up where the observer stands.
 */
export interface SunObserver {
  up: Vec3;
  sunDir: Vec3;
}

/** A direction given with y up (x east, z south) as a world direction where up is `up`. */
function inUpFrame(up: Vec3, d: Vec3): Vec3 {
  const f = upFrame(up);
  return [f.x[0] * d[0] + f.y[0] * d[1] + f.z[0] * d[2], f.x[1] * d[0] + f.y[1] * d[1] + f.z[1] * d[2], f.x[2] * d[0] + f.y[2] * d[1] + f.z[2] * d[2]];
}

/** `dir` lifted to at least `minDeg` above the horizon of `up`, keeping its compass direction. `e` is its height in degrees. */
function liftedAbove(up: Vec3, dir: Vec3, e: number, minDeg: number): Vec3 {
  if (e >= minDeg) return dir;
  const sinE = Math.sin(e * DEG);
  const flat = normalize([dir[0] - up[0] * sinE, dir[1] - up[1] * sinE, dir[2] - up[2] * sinE]);
  const c = Math.cos(minDeg * DEG);
  const s = Math.sin(minDeg * DEG);
  return [flat[0] * c + up[0] * s, flat[1] * c + up[1] * s, flat[2] * c + up[2] * s];
}

export class Environment {
  mode: LightMode;
  studio: StudioLight;
  /** The 'fixed' mode's light; its fields may be changed (or the object replaced) at any time. */
  fixed: FixedLight;
  site: SunSite;
  dayLight: DayLight;
  wind: WindConfig;
  clouds: CloudConfig;
  /** Weather: changed directly, applies from the next frame. */
  weather: WeatherState;
  snowAlbedo: RGB;
  /** Vertical extent of the fog layer; set when the scene is known. */
  fogLayer: FogLayer;
  /**
   * In 'day' mode, for a world whose up depends on the place (default null: the sun follows `site` and up is +y).
   * When set, the sun stands in the world direction `sunDir` whatever the site says, and everything that follows its
   * height (light colours, exposure, sky colours, the swap to the moon) is computed for an observer whose up is `up`.
   * Light directions of the frame are then world directions. Set it every frame from the eye's place.
   */
  observer: SunObserver | null = null;
  /** Animation time in seconds. Drives wind and clouds, later everything else that moves too. */
  readonly time: Clock;
  /** Hour of day 0–24 in civil time. Speed is in hours per second. */
  readonly day: Clock;

  constructor(config: EnvironmentConfig = {}) {
    this.mode = config.mode ?? 'studio';
    this.studio = { ...DEFAULT_STUDIO, ...config.studio };
    this.fixed = { ...DEFAULT_FIXED, ...config.fixed };
    this.site = { ...DEFAULT_SITE, ...config.site };
    this.dayLight = { ...DEFAULT_DAY, ...config.day };
    this.wind = { ...DEFAULT_WIND, ...config.wind };
    this.clouds = { ...DEFAULT_CLOUDS, ...config.clouds };
    this.weather = { ...DEFAULT_WEATHER, ...config.weather };
    this.snowAlbedo = config.snowAlbedo ?? DEFAULT_SNOW_ALBEDO;
    this.fogLayer = config.fogLayer ?? { bottomY: 0, topY: 1 };
    this.time = new Clock({ playing: config.animate ?? true });
    this.day = new Clock({ time: config.hour ?? 13, rate: config.hoursPerSecond ?? 1, wrap: 24 });
  }

  /** Clock for the frame loop. */
  get clocks(): Clock[] {
    return [this.time, this.day];
  }

  /** Switches the lighting mode. In studio and fixed the hour of day means nothing, so its run is stopped. */
  setMode(mode: LightMode): void {
    this.mode = mode;
    if (mode !== 'day') this.day.pause();
  }

  /** Switches to the 'fixed' mode with the light toward `toLight` (world axes) and, optionally, other numbers of it. */
  setFixedLight(toLight: Vec3, light: Partial<Omit<FixedLight, 'toLight'>> = {}): void {
    this.fixed = { ...this.fixed, ...light, toLight: [toLight[0], toLight[1], toLight[2]] };
    this.setMode('fixed');
  }

  /** Day of year (1–366). Drives the sun path; slots may read it too. */
  get dayOfYear(): number {
    return this.site.dayOfYear;
  }

  /** Sets the date. Optionally also the local time offset from UTC (daylight saving time). */
  setDate(dayOfYear: number, utcOffsetHours?: number): void {
    this.site = { ...this.site, dayOfYear, ...(utcOffsetHours === undefined ? {} : { utcOffsetHours }) };
  }

  /** Where the sun is now according to place, date and hour of day. */
  sun(): SunPosition {
    return sunPosition(this.site, this.day.time);
  }

  /** Environment state for one frame. Pure function of the clocks, settings and (in studio) the view heading. */
  frame(view: Pick<View, 'heading'>): FrameEnvironment {
    const time = this.time.time;
    const hour = this.day.time;
    // Direction the wind blows toward: the meteorological direction is where it comes from.
    const to = (this.wind.fromDeg + 180) * DEG;
    const windX = Math.sin(to);
    const windZ = -Math.cos(to);
    const drift = this.wind.speedMs * this.clouds.speedFactor * time;
    const w = this.weather;
    const cc = clamp(w.cloudCover, 0, 1);
    const overcast = smoothstep(OVERCAST_FROM, 1, cc);
    const cloudLo = lerp(CLOUD_EDGE_CLEAR, CLOUD_EDGE_FULL, clamp(cc / OVERCAST_FROM, 0, 1));
    const shared = {
      time,
      hour,
      windX,
      windZ,
      windSpeedMs: this.wind.speedMs,
      gustLengthM: GUST_LENGTH_M,
      gustSpeed: Math.max(0.5, this.wind.speedMs),
      cloudX: windX * drift,
      cloudZ: windZ * drift,
      // Without clouds there are no cloud shadows. When overcast they merge into a continuous layer and their pattern vanishes.
      cloudDarkness: cc > 0.01 ? this.clouds.darkness * (1 + 1.4 * smoothstep(0.1, OVERCAST_FROM, cc)) * (1 - overcast) : 0,
      cloudSizeM: this.clouds.sizeM,
      cloudLo,
      cloudHi: cloudLo + CLOUD_EDGE_WIDTH,
      cloudCover: cc,
      snowCover: clamp(w.snowCover, 0, 1),
      wetness: clamp(w.wetness, 0, 1),
      fog: clamp(w.fog, 0, 1),
      precipitation: clamp(w.precipitation, 0, 1),
      precipitationKind: w.precipitationKind === 'snow' ? 1 : 0,
      snowAlbedo: this.snowAlbedo,
      fogLayer: this.fogLayer,
      dayOfYear: this.site.dayOfYear,
    };
    return this.applySkyFog(this.applyClouds(this.lightFrame(view.heading, shared), overcast));
  }

  /** Fog and haze veil the sky too: the horizon goes almost to the fog colour, the zenith less. */
  private applySkyFog(f: FrameEnvironment): FrameEnvironment {
    if (f.fog <= 0) return f;
    return {
      ...f,
      skyHorizon: mix3(f.skyHorizon, f.fogColor, SKY_FOG_HORIZON * f.fog),
      skyZenith: mix3(f.skyZenith, f.fogColor, SKY_FOG_ZENITH * f.fog),
      sunGlow: scale3(f.sunGlow, 1 - SKY_FOG_GLOW * f.fog),
    };
  }

  /**
   * Continuous cloud cover: direct sun weakens, its light is scattered into the surroundings and sky, colours cool.
   * Scene shadows fade by themselves, since only direct sun makes them.
   */
  private applyClouds(f: FrameEnvironment, overcast: number): FrameEnvironment {
    if (overcast <= 0) return f;
    const sunLum = (f.sun[0] + f.sun[1] + f.sun[2]) / 3;
    const diffuse = sunLum * overcast;
    return {
      ...f,
      sun: scale3(f.sun, lerp(1, OVERCAST_SUN, overcast)),
      ambient: [
        f.ambient[0] + diffuse * OVERCAST_AMBIENT * OVERCAST_COOL[0],
        f.ambient[1] + diffuse * OVERCAST_AMBIENT * OVERCAST_COOL[1],
        f.ambient[2] + diffuse * OVERCAST_AMBIENT * OVERCAST_COOL[2],
      ],
      skyFill: [
        f.skyFill[0] + diffuse * OVERCAST_SKY * OVERCAST_COOL[0],
        f.skyFill[1] + diffuse * OVERCAST_SKY * OVERCAST_COOL[1],
        f.skyFill[2] + diffuse * OVERCAST_SKY * OVERCAST_COOL[2],
      ],
      bounce: scale3(f.bounce, 1 - overcast),
      warmTint: mix3(f.warmTint, OVERCAST_TINT, overcast * 0.85),
      fogColor: scale3(f.fogColor, 1 - 0.12 * overcast),
      // The sky turns to an even grey as bright as its horizon was; the glow around the sun fades.
      skyHorizon: mix3(f.skyHorizon, scale3(OVERCAST_COOL, luma(f.skyHorizon) * OVERCAST_SKY_GREY), overcast),
      skyZenith: mix3(f.skyZenith, scale3(OVERCAST_COOL, luma(f.skyHorizon) * OVERCAST_SKY_GREY * 0.86), overcast),
      sunGlow: scale3(f.sunGlow, 1 - 0.85 * overcast),
    };
  }

  /** Light without the influence of cloud cover: fixed, studio, or day according to the sun position. */
  private lightFrame(
    heading: number,
    shared: Omit<
      FrameEnvironment,
      'mode' | 'toSun' | 'sunElevationDeg' | 'sun' | 'ambient' | 'skyFill' | 'bounce' | 'warmTint' | 'exposure' | 'backdrop' | 'fogColor' | 'sunDir' | 'moonDir' | 'skyZenith' | 'skyHorizon' | 'sunGlow'
    >,
  ): FrameEnvironment {
    const d = this.dayLight;
    const obs = this.mode === 'day' ? this.observer : null;
    const moonDir = obs ? inUpFrame(obs.up, skyDirection(d.moonAzimuthDeg, d.moonElevationDeg)) : skyDirection(d.moonAzimuthDeg, d.moonElevationDeg);
    if (this.mode === 'fixed') {
      const x = this.fixed;
      const toSun = normalize([x.toLight[0], x.toLight[1], x.toLight[2]]);
      return {
        sunDir: toSun,
        moonDir,
        skyZenith: d.skyZenithDay,
        skyHorizon: d.skyHorizonDay,
        sunGlow: d.sunGlowHigh,
        ...shared,
        mode: 'fixed',
        fogColor: FOG_DAY,
        toSun,
        sunElevationDeg: Math.asin(clamp(toSun[1], -1, 1)) / DEG,
        sun: x.sun,
        ambient: x.ambient,
        skyFill: x.skyFill,
        bounce: x.bounce,
        warmTint: x.warmTint,
        exposure: x.exposure,
        backdrop: x.backdrop,
      };
    }
    if (this.mode === 'studio') {
      const s = this.studio;
      const toSun = studioLightDirection(heading, s.sunAzimuthFromViewDeg, s.sunElevationDeg);
      return {
        sunDir: toSun,
        moonDir,
        skyZenith: d.skyZenithDay,
        skyHorizon: d.skyHorizonDay,
        sunGlow: d.sunGlowHigh,
        ...shared,
        mode: 'studio',
        fogColor: FOG_DAY,
        toSun,
        sunElevationDeg: s.sunElevationDeg,
        sun: s.sun,
        ambient: s.ambient,
        skyFill: s.skyFill,
        bounce: s.bounce,
        warmTint: s.warmTint,
        exposure: s.exposure,
        backdrop: [1, 1, 1],
      };
    }

    const pos = this.sun();
    const e = obs ? Math.asin(clamp(obs.sunDir[0] * obs.up[0] + obs.sunDir[1] * obs.up[1] + obs.sunDir[2] * obs.up[2], -1, 1)) / DEG : pos.elevationDeg;
    const day = smoothstep(DAY_FROM, DAY_TO, e);
    const sunUp = smoothstep(SUN_FROM, SUN_TO, e);
    const moonUp = 1 - smoothstep(MOON_FROM, MOON_TO, e);
    const twilight = Math.exp(-((e / TWILIGHT_WIDTH) ** 2));
    // Between sunset and moonrise nothing directional shines, the direction is swapped invisibly.
    const sunLit = e > (SUN_FROM + MOON_TO) / 2;
    const toSun = obs
      ? sunLit
        ? liftedAbove(obs.up, obs.sunDir, e, d.minLightElevationDeg)
        : moonDir
      : sunLit
        ? skyDirection(pos.azimuthDeg, Math.max(e, d.minLightElevationDeg))
        : skyDirection(d.moonAzimuthDeg, d.moonElevationDeg);
    const sun = sunLit ? scale3(mix3(d.sunLow, d.sunHigh, smoothstep(WARM_FROM, WARM_TO, e)), sunUp) : scale3(d.moon, moonUp);
    // A low sun lights the ground only at a grazing angle, so the sky light is all the more visible.
    const fill = 1 + d.lowSunFill * day * (1 - smoothstep(LOW_SUN_FROM, LOW_SUN_TO, e));
    const ambient = mix3(d.ambientNight, d.ambientDay, day);
    // With the sun low, the haze at the horizon loses its blue.
    const warm = day * (1 - smoothstep(WARM_FROM, HORIZON_WARM_TO, e));
    return {
      ...shared,
      mode: 'day',
      sunElevationDeg: e,
      fogColor: [
        lerp(FOG_NIGHT[0], FOG_DAY[0], day) + FOG_TWILIGHT[0] * twilight,
        lerp(FOG_NIGHT[1], FOG_DAY[1], day) + FOG_TWILIGHT[1] * twilight,
        lerp(FOG_NIGHT[2], FOG_DAY[2], day) + FOG_TWILIGHT[2] * twilight,
      ],
      toSun,
      sun,
      ambient: [ambient[0] + d.twilight[0] * twilight, ambient[1] + d.twilight[1] * twilight, ambient[2] + d.twilight[2] * twilight],
      skyFill: mix3(d.skyNight, scale3(d.skyDay, fill), day),
      bounce: scale3(d.bounce, sunUp),
      warmTint: mix3(d.tintNight, d.tintDay, day),
      exposure: lerp(d.exposureNight, 1 + d.lowSunExposure * (1 - smoothstep(DIM_FROM, DIM_TO, e)), day),
      backdrop: mix3(d.backdropNight, [1, 1, 1], day),
      sunDir: obs ? obs.sunDir : skyDirection(pos.azimuthDeg, e),
      moonDir,
      // The zenith darkens a little later than the horizon; dusk and dawn warm the horizon.
      skyZenith: mix3(d.skyZenithNight, d.skyZenithDay, smoothstep(DAY_FROM - 4, DAY_TO, e)),
      skyHorizon: [
        lerp(d.skyHorizonNight[0], d.skyHorizonDay[0], day) + d.skyTwilight[0] * twilight,
        lerp(d.skyHorizonNight[1], d.skyHorizonDay[1], day) * (1 - HORIZON_WARM[1] * warm) + d.skyTwilight[1] * twilight,
        lerp(d.skyHorizonNight[2], d.skyHorizonDay[2], day) * (1 - HORIZON_WARM[2] * warm) + d.skyTwilight[2] * twilight,
      ],
      sunGlow: scale3(mix3(d.sunGlowLow, d.sunGlowHigh, smoothstep(WARM_FROM, WARM_TO, e)), smoothstep(GLOW_FROM, GLOW_TO, e)),
    };
  }
}
