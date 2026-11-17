// The sky as seen from a perspective view, as an environment slot: gradient from horizon to zenith, the glow around
// the sun, sun and moon discs, stars and the same clouds that cast the cloud shadows on the ground. Colours come from
// the environment (`FrameEnvironment.skyZenith`, `skyHorizon`, `sunGlow`), so the sky moves with the light on the
// scene. The slot also carries the haze that fades distant geometry into the sky (`aerialPerspective`).
//
// The slot's GLSL is registered as the include `<sky>`. Without the slot, `EnvironmentLink` registers `SKY_FALLBACK`
// under the same name: the same functions, with no haze, so materials may call them in any view.

import { clamp, smoothstep } from '../base/math.ts';
import type { RGB, Vec3 } from '../base/math.ts';
import type { EnvSlot, FrameEnvironment } from '../base/env-slot.ts';
import { CLOUD_OCTAVES } from './glsl.ts';

export interface SkyParams {
  /**
   * Distance in metres at which distant geometry has faded about two thirds of the way into the sky colour behind it
   * (perspective views only). The fade grows with the square of the distance, so near things barely change. 0 turns it off.
   */
  hazeDistanceM: number;
  /** How much fog (0–1) and precipitation (0–1) shorten the haze distance at full strength. */
  fogHaze: number;
  precipitationHaze: number;
  /** Height of the cloud deck in world units. */
  cloudHeightM: number;
  /** Clouds sink into the horizon haze at this many cloud heights of distance along the view ray. */
  cloudFadeHeights: number;
  /** Eye of the current view, or null for a view without one (orthographic). The sky layer sets it every frame. */
  eye: Vec3 | null;
}

export const DEFAULT_SKY: Omit<SkyParams, 'eye'> = {
  hazeDistanceM: 1400,
  fogHaze: 0.8,
  precipitationHaze: 0.35,
  cloudHeightM: 1200,
  cloudFadeHeights: 70,
};

/** What the sky slot computes for one frame. */
export interface SkyValues {
  zenith: RGB;
  horizon: RGB;
  glow: RGB;
  sunDir: Vec3;
  moonDir: Vec3;
  /** Colour of the sunlit side of a cloud. */
  cloud: RGB;
  /** 0–1: stars, sun disc, moon disc, continuous overcast deck. */
  stars: number;
  sunDisc: number;
  moon: number;
  overcast: number;
  /** 1 / haze distance in metres, 0 = no haze. */
  invHaze: number;
  cloudHeightM: number;
  cloudFadeM: number;
  eye: Vec3;
  perspective: number;
}

// Sun heights (degrees) between which the stars come out: fully below the first, none above the second.
const STARS_FULL_DEG = -14;
const STARS_OFF_DEG = -4;
// Same day/night transition as the environment's light (DAY_FROM/DAY_TO).
const DAY_FROM = -6;
const DAY_TO = 6;
// Cloud cover between which the sky closes into a continuous deck. A little before the light goes fully diffuse
// (the environment's OVERCAST_FROM = 0.55 to 1): rain and snow skies should read as closed.
const DECK_FROM = 0.45;
const DECK_TO = 0.78;

function luma(c: RGB): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

/** Pure: the sky's values from the generic environment and the params. */
export function computeSky(E: FrameEnvironment, p: SkyParams): SkyValues {
  const dayMode = E.mode === 'day';
  const e = E.sunElevationDeg;
  const daylight = dayMode ? smoothstep(DAY_FROM, DAY_TO, e) : 1;
  const overcast = smoothstep(DECK_FROM, DECK_TO, E.cloudCover);
  const clear = (1 - overcast) * (1 - 0.85 * E.fog);
  // The lit side of a cloud: the horizon's light, whitened as bright as the horizon is, plus the sun's glow.
  const h = E.skyHorizon;
  const white = luma(h) * 1.3;
  const cloud: RGB = [h[0] * 0.4 + white * 0.6 + E.sunGlow[0] * 0.5, h[1] * 0.4 + white * 0.6 + E.sunGlow[1] * 0.5, h[2] * 0.4 + white * 0.6 + E.sunGlow[2] * 0.5];
  const hazeM = p.hazeDistanceM * (1 - p.fogHaze * clamp(E.fog, 0, 1)) * (1 - p.precipitationHaze * clamp(E.precipitation, 0, 1));
  return {
    zenith: E.skyZenith,
    horizon: E.skyHorizon,
    glow: E.sunGlow,
    sunDir: E.sunDir,
    moonDir: E.moonDir,
    cloud,
    stars: dayMode ? (1 - smoothstep(STARS_FULL_DEG, STARS_OFF_DEG, e)) * clear : 0,
    sunDisc: (1 - 0.95 * overcast) * (1 - 0.85 * E.fog),
    moon: dayMode ? (1 - 0.8 * daylight) * clear : 0,
    overcast,
    invHaze: p.eye && hazeM > 0 ? 1 / hazeM : 0,
    cloudHeightM: p.cloudHeightM,
    cloudFadeM: p.cloudHeightM * p.cloudFadeHeights,
    eye: p.eye ?? [0, 0, 0],
    perspective: p.eye ? 1 : 0,
  };
}

/** Cloud field with per-octave fading: an octave whose cells shrink toward a pixel gives way to its mean, so far
 * clouds near the horizon do not shimmer. With `fw = 0` it is exactly the field of the ground's cloud shadows. */
const CLOUD_FIELD_AA = CLOUD_OCTAVES.map(([w, f, o, seed]) => `${w} * mix(0.5, vnoise(q * ${f} + ${o}, ${seed}u), 1.0 - smoothstep(0.3, 0.7, fw * ${f}))`).join('\n    + ');

/** GLSL of the slot, registered as `<sky>`. Needs `<header>` and `<noise>` before it. */
export const SKY_GLSL = /* glsl */ `
float skyCloudField(vec2 q, float fw) {
  return ${CLOUD_FIELD_AA};
}

// Unit direction from a world point toward the eye.
vec3 skyToEye(vec3 worldPos) {
  return u_skyEye.w > 0.5 ? normalize(u_skyEye.xyz - worldPos) : -u_camForward.xyz;
}

// Sky colour in a direction, screen space: the gradient and the glow around the sun, no discs, clouds or stars.
// Below the horizon it stays as at the horizon, so haze and sky meet without a seam.
vec3 skyColorDir(vec3 dir) {
  float y = max(dir.y, 0.0);
  float t = (1.0 - exp(-4.0 * y)) * (1.0 / (1.0 - exp(-4.0)));
  vec3 c = mix(u_skyHorizon.rgb, u_skyZenith.rgb, t);
  vec3 s = u_skySun.xyz;
  float mu = max(dot(normalize(vec3(dir.x, y, dir.z)), s), 0.0);
  float mu2 = mu * mu, mu4 = mu2 * mu2, mu8 = mu4 * mu4, mu32 = mu8 * mu8 * mu8 * mu8;
  // A band of light along the horizon toward the sun, widest at sunset.
  vec2 hz = dir.xz / max(length(dir.xz), 1e-4);
  vec2 hs = s.xz / max(length(s.xz), 1e-4);
  float toward = 0.5 + 0.5 * dot(hz, hs);
  float band = toward * toward * toward * (1.0 - smoothstep(0.0, 0.35, y));
  return c + u_skyGlow.rgb * (0.18 * mu4 + 0.45 * mu32 + 0.4 * band);
}

// Distant geometry fades into the sky behind it. Screen-space colour in, screen-space colour out.
// Off (identity) without a perspective view or with the haze switched off.
vec3 aerialPerspective(vec3 display, vec3 worldPos) {
  if (u_skyHorizon.w <= 0.0) return display;
  vec3 v = worldPos - u_skyEye.xyz;
  float len = max(length(v), 1e-3);
  float k = len * u_skyHorizon.w;
  return mix(display, skyColorDir(v / len), 1.0 - exp(-k * k));
}

// Clouds along a view direction: rgb colour, a coverage. The deck is a plane at u_skySun.w; the field is looked up
// where the light (u_sunDir, the same direction that casts the scene's shadows) throws this cloud's shadow on the
// ground, so the clouds overhead and their shadows agree.
vec4 skyClouds(vec3 dir) {
  // No early return: fwidth below needs every pixel of the quad.
  float t = max(u_skySun.w - u_skyEye.y, 1.0) / max(dir.y, 1e-3);
  vec3 hit = u_skyEye.xyz + dir * t;
  vec3 L = u_sunDir.xyz;
  vec2 ground = hit.xz - L.xz * (u_skySun.w / max(L.y, 0.05));
  vec2 q = (ground - u_cloud.xy) * u_cloud.w;
  float fw = length(fwidth(q));
  float n = skyCloudField(q, fw);
  float edge = 0.5 * fw;
  float cover = smoothstep(u_cloudEdge.x - edge, u_cloudEdge.y + edge, n) * smoothstep(0.0, 0.04, u_snow.w);
  float thick = smoothstep(u_cloudEdge.x, u_cloudEdge.x + 0.45, n);
  float overcast = u_skyCloud.w;
  vec3 lit = u_skyCloud.rgb;
  vec3 col = lit * mix(1.0, 0.7, thick);
  // Thin edges toward the sun light up.
  float mu = max(dot(dir, u_skySun.xyz), 0.0);
  float mu2 = mu * mu, mu4 = mu2 * mu2;
  col += u_skyGlow.rgb * mu4 * mu4 * (1.0 - thick) * 1.4;
  // The continuous deck of an overcast sky: an even grey a little darker than the lit cloud.
  col = mix(col, lit * 0.74, overcast * (1.0 - cover));
  // Fog veils the clouds too.
  float a = max(cover, overcast) * (1.0 - 0.75 * u_weather.z) * step(0.0, dir.y);
  // Far clouds sink into the horizon haze.
  float far = t / u_skyFade.x;
  return vec4(mix(col, skyColorDir(dir), 1.0 - exp(-far * far)), a);
}

// Stars: at most one per cell of a cube-map grid over the directions, from an integer hash. Fixed in the world, so
// they hold still when the view turns; never narrower than a pixel, so they do not flicker.
float skyStars(vec3 dir, float pixelAngle) {
  vec3 a = abs(dir);
  vec2 uv;
  uint face;
  float major;
  if (a.x >= a.y && a.x >= a.z) { uv = dir.zy / a.x; face = dir.x > 0.0 ? 0u : 1u; major = a.x; }
  else if (a.y >= a.z) { uv = dir.xz / a.y; face = dir.y > 0.0 ? 2u : 3u; major = a.y; }
  else { uv = dir.xy / a.z; face = dir.z > 0.0 ? 4u : 5u; major = a.z; }
  const float CELLS = 160.0;
  vec2 g = (uv * 0.5 + 0.5) * CELLS;
  vec2 cf = floor(g);
  ivec2 cell = ivec2(cf);
  uint seed = 400u + face * 8u;
  if (hash2(cell, seed) > 0.3) return 0.0;
  vec2 at = 0.2 + 0.6 * vec2(hash2(cell, seed + 1u), hash2(cell, seed + 2u));
  float m = hash2(cell, seed + 3u);
  float bright = 0.12 + 0.88 * m * m * m * m;
  float px = pixelAngle * CELLS * 0.5 / major;
  float r = max(0.8 * px, 0.01);
  vec2 off = g - cf - at;
  return bright * exp(-dot(off, off) / (r * r));
}

// The whole sky in a direction, screen space: gradient and glow, stars, moon, sun and clouds.
vec3 skyView(vec3 dir) {
  float pa = max(length(fwidth(dir)), 1e-5);
  vec3 c = skyColorDir(dir);
  float up = smoothstep(-0.5 * pa, 0.5 * pa, dir.y);
  c += vec3(0.88, 0.92, 1.0) * skyStars(dir, pa) * u_skyZenith.w * smoothstep(0.02, 0.25, dir.y);
  // Moon: a mottled disc and a faint halo.
  vec3 m = u_skyMoon.xyz;
  float rm = 0.014;
  float dm = length(dir - m);
  vec3 t1 = normalize(cross(m, vec3(0.0, 1.0, 0.0)) + vec3(1e-5, 0.0, 0.0));
  vec3 t2 = cross(t1, m);
  vec2 lm = vec2(dot(dir - m, t1), dot(dir - m, t2)) / rm;
  float mott = 0.8 + 0.2 * vnoise(lm * 2.2 + 5.0, 92u);
  float disc = (1.0 - smoothstep(rm - pa, rm + pa, dm)) * up * u_skyMoon.w;
  c = mix(c, vec3(0.9, 0.91, 0.94) * mott, disc);
  c += vec3(0.1, 0.12, 0.16) * u_skyMoon.w * up * exp(-dm * dm * (1.0 / 0.004));
  // Sun: a bright disc tinted by the glow, the warmer the lower it stands.
  vec3 s = u_skySun.xyz;
  float rs = 0.012;
  float ds = length(dir - s);
  float sun = (1.0 - smoothstep(rs - pa, rs + pa, ds)) * up * u_skyGlow.w;
  vec3 sunCol = min(vec3(1.0, 0.96, 0.88) + u_skyGlow.rgb * 1.2, vec3(1.0));
  c = mix(c, sunCol, sun);
  c += u_skyGlow.rgb * u_skyGlow.w * up * 0.35 * exp(-ds * ds * (1.0 / 0.0008));
  vec4 cl = skyClouds(dir);
  return mix(c, cl.rgb, cl.a);
}
`;

/** Same functions as `SKY_GLSL` without the sky slot: no haze, the fog colour as the sky. Registered as `<sky>`. */
export const SKY_FALLBACK = /* glsl */ `
vec3 skyToEye(vec3 worldPos) { return -u_camForward.xyz; }
vec3 skyColorDir(vec3 dir) { return u_fogColor.rgb; }
vec3 aerialPerspective(vec3 display, vec3 worldPos) { return display; }
`;

/** The sky slot. Pass it in the engine's slots (or use `createEngine({ sky: true })`, which also adds the layer). */
export function skySlot(params: Partial<SkyParams> = {}): EnvSlot<SkyParams, SkyValues> {
  return {
    name: 'sky',
    params: { ...DEFAULT_SKY, eye: null, ...params },
    fields: [
      { member: 'u_skyZenith', order: 1000, lanes: 'xyzw', doc: 'rgb sky straight up, w star visibility 0–1' },
      { member: 'u_skyHorizon', order: 1010, lanes: 'xyzw', doc: 'rgb sky at the horizon, w 1 / haze distance (0 off)' },
      { member: 'u_skyGlow', order: 1020, lanes: 'xyzw', doc: 'rgb glow around the sun, w sun disc visibility 0–1' },
      { member: 'u_skySun', order: 1030, lanes: 'xyzw', doc: 'xyz true direction to the sun, w cloud deck height' },
      { member: 'u_skyMoon', order: 1040, lanes: 'xyzw', doc: 'xyz direction to the moon, w moon visibility 0–1' },
      { member: 'u_skyCloud', order: 1050, lanes: 'xyzw', doc: 'rgb sunlit cloud colour, w overcast deck 0–1' },
      { member: 'u_skyEye', order: 1060, lanes: 'xyzw', doc: 'xyz eye, w 1 perspective, 0 none' },
      { member: 'u_skyFade', order: 1070, lanes: 'x', doc: 'x distance at which clouds sink into the horizon' },
    ],
    compute: computeSky,
    lanes: (v) => [
      ...v.zenith,
      v.stars,
      ...v.horizon,
      v.invHaze,
      ...v.glow,
      v.sunDisc,
      ...v.sunDir,
      v.cloudHeightM,
      ...v.moonDir,
      v.moon,
      ...v.cloud,
      v.overcast,
      ...v.eye,
      v.perspective,
      v.cloudFadeM,
    ],
    glsl: SKY_GLSL,
  };
}
