// Volumetric clouds: a layer that marches the cloud model of env (`CLOUD_VOLUME_GLSL`) through the noise volumes and
// the cloud weather map at a share of the screen's resolution, keeps what it marched from frame to frame, and lays
// the result over the scene.
//
// With the cloud shadows (`CloudShadowSource`) the layer also gives the cloud shadow texture the clouds' depth along
// the light: the shape's density at a few points along the light's line through the layer.
//
// In `prepare` (between passes), three steps:
//
// 1. Where the main target can be read (the reversed and logarithmic depth modes, or two samples), the depth the last
//    frame drew is copied. A ray's march ends where that scene lies along it: the last frame's depth reprojected to
//    this frame's eye (twice: the point found the first time is looked up again from where it lies now). So a
//    hill or a ridge that reaches into the layer has the clouds in front of it, and none from behind.
// 2. The march. With a history (the default) one texel of every 2 × 2 block of the layer's target per frame, in turn
//    (`cloudVolumeBayer`); without one every texel. Per texel: the view ray's span in the layer, `steps` samples along
//    it (evenly, or crowded toward the eye when the eye is inside the layer; up to four times as many along a span that
//    runs far through the layer, so the far samples still resolve the shape), and from every sample inside a cloud
//    `lightSteps` samples toward the light, whose growing lengths reach about two thirds of the layer. The light of a
//    sample: the sun at the clouds (through the air where there is an atmosphere) times the light that gets through
//    toward it, in three octaves of ever less extinction and ever softer forward scattering (light scattered many
//    times inside a cloud), plus the sky's light from above and the ground's from below. Out come the clouds' colour
//    in screen space (exposure, air and haze applied at the clouds' mean distance) premultiplied by their opacity, and
//    the distances: the clouds' mean distance, where the ray entered the layer and where it ended.
// 3. With a history: every texel of the layer's target takes its place in the last frame's picture (reprojected at
//    the clouds' mean distance, moved with the eye and with the drifting clouds) and, where it was marched now, blends
//    the new samples in, averaging up to 12 samples per texel while the eye holds still and 4 while it moves. The
//    last picture is left out where the place fell off the screen, where the ray's entry or
//    end moved (a surface came in front or went away, the edge of the layer), after a cut or a jump of the eye
//    (`cloudVolumeKeepHistory`) and after `frameIndex` was set; the texel then takes the new samples around it. The
//    last picture is held within the range of the new samples around (a little widened), so moving clouds leave no
//    trails. A still view settles within about a second, the jitter of the samples averaged out.
//
// In the colour pass one quad per 8 × 8 texels (none where the layer is out of view) puts the clouds over the scene;
// pixels without cloud are discarded. Where the four nearest texels saw
// the same surface (entry and end) as this pixel's ray, the pixel takes four filtered taps around it (a tent over
// 3 × 3 texels); elsewhere (the edge of the planet, of the layer or of a ridge) only the texels whose entry and end
// match its own. Where the scene's depth is copied (step 1), each quad lies where the layer begins along its view,
// so the depth test keeps the clouds off whatever is nearer (a hill, a figure below the clouds) and early depth
// testing culls the pixels behind it. Where it is not (the standard mode drawing into the canvas), the pixel writes
// the clouds' mean distance as its depth, as a surface would.

import type { Vec3 } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { Uniforms } from '../base/material.ts';
import type { ColorTarget, Device, Program, Texture } from '../gpu/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import { NoiseVolumes } from '../render/index.ts';
import { NOISE_VOLUME_SHAPE, shapeNoiseAt } from '../gen-tex/index.ts';
import {
  CLOUD_FIELD_SLOT,
  CLOUD_RAIN_DENSITY,
  CLOUD_VOLUME_GLSL,
  CLOUD_VOLUME_QUALITY,
  CLOUD_VOLUME_TILE,
  DEFAULT_CLOUD_VOLUME_SHAPE,
  cloudCoverTerms,
  cloudFieldCover,
  cloudVolumeBayer,
  cloudVolumeColumnDepth,
  cloudVolumeDepthMap,
  cloudVolumeFade,
  cloudVolumeKeepHistory,
  cloudVolumeMarchSize,
  cloudVolumeRainShare,
  cloudVolumeScreenBasis,
  cloudVolumeTargetSize,
  cloudVolumeTiles,
  cloudWeatherKind,
} from '../env/index.ts';
import type { CloudCoverField, CloudVolumeQuality, CloudVolumeShape } from '../env/index.ts';
import type { AtmosphereLayer } from './atmosphere.ts';
import { CloudWeatherMap } from './cloud-shadows.ts';
import type { CloudShadowSource, CloudWeatherMapOptions } from './cloud-shadows.ts';
import type { EnvironmentLink } from './environment-link.ts';

/** Texture units of the layer's own draws. The march: the noise volumes, the weather map, the scene's depth. */
const SHAPE_UNIT = 8;
const DETAIL_UNIT = 9;
const WEATHER_UNIT = 10;
const SCENE_UNIT = 11;
/** The accumulation: the march target, the last picture; the scene's depth on `HISTORY_SCENE_UNIT`. */
const MARCH_COLOR_UNIT = 8;
const MARCH_INFO_UNIT = 9;
const HISTORY_COLOR_UNIT = 10;
const HISTORY_INFO_UNIT = 11;
const HISTORY_SCENE_UNIT = 7;
/** The composite: the clouds and their distances (and the scene's depth on `SCENE_UNIT`). */
const COLOR_UNIT = 8;
const INFO_UNIT = 9;
/** A unit nobody keeps a texture on, selected after the layer's binds (as the cloud shadow layer does). */
const SPARE_UNIT = 13;
/** Distance stored for "no cloud" and "no layer on this ray", metres. */
const FAR_M = 1e7;
const FAR = FAR_M.toFixed(1);
const HALF_FAR = (FAR_M * 0.5).toFixed(1);
// The mean of the shape volume and the half width of an even spread with its deviation (0.57 and 0.16 measured).
const SHAPE_MEAN = '0.57';
const SHAPE_SPREAD = '0.27';
const RAIN_DENSITY = CLOUD_RAIN_DENSITY.toFixed(2);
/** Share of the light the base of a cloud under the heaviest rain loses (its top loses a little). */
const RAIN_BASE_DARK_LOSS = '0.72';
const RAIN_TOP_DARK_LOSS = '0.4';
/** Extinction per metre of the falling rain under a cloud raining at full strength (`CloudVolumeLayer.rainShafts` 1). */
const RAIN_SHAFT_EXTINCTION = 0.0006;
/** Samples of the falling rain along a view ray below the clouds' base, and how far along it they reach (metres). */
const RAIN_SHAFT_SAMPLES = 6;
const RAIN_SHAFT_REACH_M = 30000;
/**
 * How many samples a texel of the history averages at most: with the eye still, and while it moves (fewer: the last
 * picture moved to this frame blurs a little every frame).
 */
const HISTORY_STILL = 12;
const HISTORY_MOVING = 4;
/**
 * How many times `steps` a view ray that runs far through the layer may take: toward the horizon, and with the eye
 * inside the layer, so that its farthest samples still lie no more than half a cell of the shape apart.
 */
const LONG_SPAN_STEPS = 4;

const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Uniforms every draw shares: the view's rays and the target's encoding. */
const VIEW_GLSL = /* glsl */ `
uniform vec4 u_cvView;      // x, y screen size in pixels, z target texels per pixel, w 1 = 8-bit target
uniform vec3 u_cvEye;       // the eye relative to the reference point (u_cvRef), from the CPU
uniform vec3 u_cvEyeRender; // the eye in render space
uniform vec3 u_cvRayCenter; // view rays scaled to depth 1 along the view: centre, half the width, half the height
uniform vec3 u_cvRayRight;
uniform vec3 u_cvRayUp;
uniform vec4 u_cvRain;      // x extinction per metre of the rain out of a cloud raining at full strength, y 1: the eye is under the base and the rain is drawn, z how far it is drawn
vec3 cvRayAt1(vec2 pixel) {
  vec2 ndc = pixel / u_cvView.xy * 2.0 - 1.0;
  return u_cvRayCenter + u_cvRayRight * ndc.x + u_cvRayUp * ndc.y;
}
vec3 cvRay(vec2 pixel) { return normalize(cvRayAt1(pixel)); }
// The distances of a texel of the second target (metres): x the clouds' mean distance, y where the ray entered the
// layer, z where it ended there (the layer's far side or the scene). An 8-bit target keeps x and y only, as 16-bit
// logarithms, and reads z as far.
vec4 cvPackInfo(float meanM, float entryM, float endM) {
  if (u_cvView.w < 0.5) return vec4(meanM, entryM, endM, 0.0) * 0.001;
  vec2 e = clamp(log2(1.0 + vec2(meanM, entryM)) / 25.0, 0.0, 1.0) * 255.0;
  vec2 hi = floor(e);
  return vec4(hi.x / 255.0, e.x - hi.x, hi.y / 255.0, e.y - hi.y);
}
vec3 cvUnpackInfo(vec4 v) {
  if (u_cvView.w < 0.5) return v.xyz * 1000.0;
  return vec3(exp2((vec2(v.x, v.z) + vec2(v.y, v.w) / 255.0) * 25.0) - 1.0, ${FAR});
}
// How far apart two distances are, relative to the nearer one (50 m at least).
float cvApart(float a, float b) { return abs(a - b) / max(min(a, b), 50.0); }
`;

/** The last frame's scene along a ray of this frame. */
const SCENE_GLSL = /* glsl */ `
uniform highp sampler2D u_cvScene; // the depth the last frame drew
uniform vec3 u_cvSceneInv0;        // its screen basis, inverted (cloudVolumeScreenBasis), column by column
uniform vec3 u_cvSceneInv1;
uniform vec3 u_cvSceneInv2;
uniform vec3 u_cvSceneCenter;      // its rays at depth 1: centre, half the width, half the height
uniform vec3 u_cvSceneRight;
uniform vec3 u_cvSceneUp;
uniform vec3 u_cvSceneMoved;       // how far the eye moved since
uniform vec4 u_cvSceneMap;         // its depth → distance along its view (cloudVolumeDepthMap); x 0: no depth
mat3 cvSceneInverse() { return mat3(u_cvSceneInv0, u_cvSceneInv1, u_cvSceneInv2); }
// The distance along dir to what the last frame drew there: the place at the distance guessed is looked up on the last
// frame's screen, and the point found there looked up once more. 1e30 where it drew nothing (or no depth is known),
// −1 where it did not see the place.
float cvScene(vec3 dir, float guess) {
  if (u_cvSceneMap.x < 0.5) return 1e30;
  vec2 size = vec2(textureSize(u_cvScene, 0));
  float d = guess;
  for (int i = 0; i < 2; i++) {
    vec3 s = cloudVolumeReproject(cvSceneInverse(), u_cvSceneMoved, dir, d);
    if (s.z <= 0.0 || abs(s.x) >= 1.0 || abs(s.y) >= 1.0) return -1.0;
    float z = cloudVolumeDepthDistance(texelFetch(u_cvScene, ivec2((s.xy * 0.5 + 0.5) * size), 0).r, u_cvSceneMap);
    if (z >= 1e29) return 1e30;
    d = dot((u_cvSceneCenter + u_cvSceneRight * s.x + u_cvSceneUp * s.y) * z - u_cvSceneMoved, dir);
  }
  return max(d, 0.0);
}
// Where a march along dir ends (x): the layer's far side, or the scene where it is nearer. y 1 where the last frame
// did not see the place (off its screen): the end is then the layer's far side, not known for sure.
vec2 cvEnd(vec3 dir, float far) {
  float s = cvScene(dir, far);
  return s < 0.0 ? vec2(far, 1.0) : vec2(min(far, s), 0.0);
}
// cvEnd of a ray with its span in the layer: also where a ray that misses the layer ends while the rain under the
// clouds is drawn (the scene, or how far the rain is drawn); far for other rays that miss it.
vec2 cvRayEnd(vec4 span, vec3 dir) {
  if (span.y > span.x) return cvEnd(dir, span.y);
  return u_cvRain.y > 0.5 ? cvEnd(dir, u_cvRain.z) : vec2(${FAR}, 0.0);
}
`;

/**
 * The density of the layer before the erosion (after `CLOUD_VOLUME_GLSL`): the weather of the place (cover, deck
 * share, precipitation), the place in the drifting noise and the shape's density with its spread over long steps.
 * The cloud shell reads the same (`CloudShellLayer` with `volume`).
 */
export const VOLUME_DENSITY_GLSL = /* glsl */ `
uniform highp sampler3D u_cvShape;
#ifdef WH_LOCAL_UP
uniform highp samplerCube u_cvWeather;
#else
uniform highp sampler2D u_cvWeather;
uniform vec4 u_cvTile;
#endif
uniform vec4 u_cvScale; // x 1 / shape tile, y 1 / wide tile, z 1 / detail tile, w wide cover
uniform float u_cvEdge; // CloudVolumeStyle.edge − 1: how much faster the density rises from a cloud's edge
// The weather of the place over a point: x cover, y deck share, z precipitation.
vec3 cvWeather(vec3 rel) {
#ifdef WH_LOCAL_UP
  return textureLod(u_cvWeather, rel, 0.0).rgb;
#else
  return textureLod(u_cvWeather, (rel.xz + u_cvRef.xz - u_cvTile.xy) / u_cvTile.z + 0.5, 0.0).rgb;
#endif
}
// The wide lookup of the shape at a place in the noise.
float cvWide(vec3 q) { return textureLod(u_cvShape, q * u_cvScale.y + vec3(0.37, 0.11, 0.73), 0.0).r; }
// The place in the noise: fixed to the reference point, drifting with the cloud pattern.
vec3 cvNoiseAt(vec3 rel) { return rel - vec3(u_cloud.x, 0.0, u_cloud.y); }
// The density before the erosion where the samples lie too far apart for the shape (lod 0–1): the shape's value
// gives way to its mean and spreads out by as much as the shape varies, and the density is its mean over that
// spread. Far clouds thin out into a soft layer of the right mean density instead of scattered dots or a solid deck;
// the wide lookup moves the cover the more, so that layer still gathers into banks and gaps. The profile follows the
// place's type: the deck share flattens it, precipitation out of heaped clouds makes it tall, and precipitation
// closes the cover (cloudVolumeRainCover), steadies the wide lookup and fills the shape (cloudVolumeRainShape), so
// the sky over rain has no gaps. y: the share of the
// spread that is cloud (1 where the shape is resolved), so a step can let the light through the gaps between the
// clouds it stands for (cvStepThrough) instead of spreading their density into a haze that is too opaque.
vec2 cvBaseShare(float shape, float lod, float wide, vec3 weather, float h) {
  float cover = weather.x;
  float wet = sqrt(clamp(weather.z, 0.0, 1.0));
  float c = clamp(cloudVolumeRainCover(cover, weather.z) + (wide - 0.5) * u_cvScale.w * (1.0 + 1.5 * lod) * (1.0 - wet), 0.0, 1.0);
  if (cover <= 0.0 || c <= 0.0) return vec2(0.0);
  float t = cloudVolumeThreshold(c);
  float p = cloudVolumeTypedProfile(h, weather.y, weather.z * (1.0 - weather.y), weather.z);
  float m = mix(cloudVolumeRainShape(shape, weather.z), ${SHAPE_MEAN}, lod) * p;
  float w = ${SHAPE_SPREAD} * lod * p;
  if (m + w <= t) return vec2(0.0);
  if (m - w >= t) return vec2(min((m - t) / (1.0 - t) * (1.0 + u_cvEdge), 1.0), 1.0);
  float e = m + w - t;
  float share = e / (2.0 * w);
  return vec2(min(e * e / (4.0 * w * (1.0 - t)) * (1.0 + u_cvEdge), share), share);
}
float cvBase(float shape, float lod, float wide, vec3 weather, float h) {
  return cvBaseShare(shape, lod, wide, weather, h).x;
}
// What a step of length dt lets through where a share f of it is cloud of mean extinction sigma (over the whole
// step): the gaps, and the clouds' own transmittance at their density.
float cvStepThrough(float sigma, float f, float dt) {
  float k = max(f, 0.05);
  return 1.0 - k + k * exp(-sigma / k * dt);
}
`;

/**
 * The light of the clouds (after `<lighting>`, `<atmosphere>` and `CLOUD_VOLUME_GLSL`), shared by the march and the
 * cloud shell: `cvLightAt` once per pixel at a point of the layer, `cvSampleLight` for every sample. The sun at the
 * clouds (through the air where there is an atmosphere), the sky's light from above, greyed by the cloud around, and
 * the ground's from below. `u_cvLook`: y gain that undoes the frame's overcast dimming of the sun, z ambient gain.
 * `u_cvLit`, `u_cvShade`: the layer's `CloudVolumeStyle` (`CloudVolumeLayer.styleUniforms`); unset, the default look.
 */
export const VOLUME_LIGHT_GLSL = /* glsl */ `
uniform vec4 u_cvLook;
uniform vec4 u_cvLit;   // CloudVolumeStyle as differences from 1: rgb the sun's light in the clouds, w their own shadow
uniform vec4 u_cvShade; // rgb the sky's and the ground's light in the clouds, w how evenly they scatter the sun (0–1)
vec3 cvL;
vec3 cvSun;
vec3 cvSkyGrey;
vec3 cvSkyBlue;
vec3 cvGround;
// Henyey-Greenstein, 1 for light scattered evenly.
float cvHg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}
// Forward scattering (the bright rim toward the sun) and a little backward (the sunlit side seen with the sun behind).
float cvPhase(float c, float k) { return mix(cvHg(c, 0.75 * k), cvHg(c, -0.3 * k), 0.3); }
// The three phase values of a view ray (ever softer forward scattering of light scattered a few times).
vec3 cvPhases(vec3 dir) {
  float c = dot(dir, cvL);
  return mix(vec3(cvPhase(c, 1.0), cvPhase(c, 0.5), cvPhase(c, 0.25)), vec3(1.0), u_cvShade.w);
}
// The light at the clouds round a point (relative to the reference point, and in render space): the frame's light
// (the sun, or the moon at night), or with the atmosphere the sun through the air, the sky's light at that height
// and what remains at night, as the atmosphere lights the ground.
void cvLightAt(vec3 rel, vec3 world) {
  vec3 L = u_sunDir.xyz;
#ifdef WH_LOCAL_UP
  float mu = dot(normalize(rel), L);
#else
  float mu = L.y;
#endif
  float day = smoothstep(-0.12, 0.2, mu);
  vec3 sun = u_sunColor.rgb * u_cvLook.y * day;
  vec3 skyRaw = (u_ambient.rgb + u_skyFill.rgb) * mix(0.15, 1.0, day);
  vec3 ground = u_bounce.rgb * mix(0.15, 1.0, day);
#ifdef WH_ATMOSPHERE
  if (u_atmSun.w > 0.0) {
    L = u_atmSun.xyz;
    vec3 pS = world - atmCenter();
    float rS = max(length(pS), 1.0);
    float muS = dot(pS, L) / rS;
    sun = u_atmLight.rgb * atmSunAt(rS, muS);
    vec3 skyA = u_atmLight.rgb * atmSkyLightAt(rS - u_atmShell.x, muS) * u_atmLight.w;
    skyRaw = skyA + u_atmNight.rgb;
    // The ground below lit by the sun and the sky, at a dull albedo.
    ground = (sun * max(muS, 0.0) + skyA) * 0.25 + u_atmNight.rgb;
  }
#endif
  // The sky's light inside a cloud is mostly light the cloud scattered: most of the way to grey at the tops, less so
  // at the bases, which the open sky around and below lights (bluish).
  vec3 grey = vec3(dot(skyRaw, vec3(0.3, 0.59, 0.11)));
  cvL = L;
  cvSun = sun;
  cvSkyGrey = mix(skyRaw, grey, 0.8) * u_cvLook.z;
  cvSkyBlue = mix(skyRaw, grey, 0.45) * u_cvLook.z;
  cvGround = ground * u_cvLook.z;
}
// The light a sample scatters toward the eye, per unit of its opacity: tau the optical depth toward the light, d the
// density, h the height in the layer (0–1), weather the place's (cover, deck share, precipitation), ph cvPhases,
// cosT the cosine between the view ray and the light.
vec3 cvSampleLight(float tau, float d, float h, vec3 weather, vec3 ph, float cosT) {
  tau *= 1.0 + u_cvLit.w;
  // Light scattered once or a few times (ever less extinction, ever softer forward scattering), and light that
  // diffused through the cloud, which falls off slowly with the optical depth.
  float direct = ph.x * exp(-tau) + 0.5 * ph.y * exp(-0.5 * tau) + 0.25 * ph.z * exp(-0.25 * tau);
  // Edges facing away from the eye toward the sun stay darker than the cloud's inside (less light scattered in).
  direct *= mix(1.0, 1.0 - exp(-2.0 * tau - d * 2.0), 0.5 * (0.5 - 0.5 * cosT));
  float diffuse = 0.5 / (1.0 + 0.1 * tau);
  // The sky's light falls off toward the base, the more so under a closing deck (the cloud above shades it) and
  // under a raining cloud, whose heavy base is darker still and gets less light from the ground.
  float shade = mix(0.4 - 0.22 * smoothstep(0.55, 0.9, weather.x) - 0.2 * weather.z, 1.0, h);
  vec3 c = cvSun * (1.0 + u_cvLit.rgb) * (direct + diffuse) + (mix(cvSkyBlue, cvSkyGrey, h) * shade + cvGround * (1.0 - h) * (0.7 - 0.4 * weather.z)) * (1.0 + u_cvShade.rgb);
  // A raining cloud is a thick, water-laden column: little of the light gets through to its lower part, which turns
  // a dark slate grey (a little more than a quarter of the light at its base under the heaviest rain), its top grey.
  // Already light rain shows (the square root of the precipitation).
  float wet = sqrt(clamp(weather.z, 0.0, 1.0));
  float keep = 1.0 - wet * mix(${RAIN_BASE_DARK_LOSS}, ${RAIN_TOP_DARK_LOSS}, smoothstep(0.0, 0.85, h));
  return mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), 0.6 * wet) * keep;
}
`;

/**
 * The clouds' depth along the light for the cloud shadow texture (`cloudShadowFillFs`'s `depth`): the shape's density
 * (without the erosion) at a few points where the light's line from the point crosses the layer. y: the layer's
 * weight, so the shadows follow the pattern again where the volume gives way to a far layer.
 */
const SHADOW_DEPTH_GLSL = /* glsl */ `${CLOUD_VOLUME_GLSL}
${VOLUME_DENSITY_GLSL}
uniform vec4 u_cvShadow; // x samples, y weight
vec2 cloudShadowDepth(vec3 point, vec3 L) {
  vec3 rel = point - u_cvRef.xyz;
  vec4 span = cloudVolumeSpan(rel, L);
  if (span.y <= span.x) return vec2(0.0, u_cvShadow.y);
  float thick = u_cvSlab.y - u_cvSlab.x;
  float n = u_cvShadow.x;
  float dt = (span.y - span.x) / n;
  float lod = smoothstep(0.12, 0.5, dt * u_cvScale.x * 4.0);
  float sum = 0.0;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= n) break;
    vec3 p = rel + L * (span.x + (float(i) + 0.5) * dt);
    float h = (cloudVolumeHeight(p) - u_cvSlab.x) / thick;
    vec3 weather = cvWeather(p);
    if (weather.x <= 0.0 || h <= 0.0 || h >= 1.0) continue;
    vec3 q = cvNoiseAt(p);
    sum += cvBase(textureLod(u_cvShape, q * u_cvScale.x, 0.0).r, lod, cvWide(q), weather, h) * (1.0 + ${RAIN_DENSITY} * weather.z);
  }
  return vec2(sum * dt * u_cvSlab.z, u_cvShadow.y);
}
`;

/** Fragment shader of the march (into the layer's target; `'other'`). Two outputs: colour and distances. */
function marchFs(field: boolean): string {
  return /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <sky>
#include <atmosphere>
${CLOUD_VOLUME_GLSL}
${VIEW_GLSL}
${SCENE_GLSL}
${VOLUME_DENSITY_GLSL}
${VOLUME_LIGHT_GLSL}
uniform highp sampler3D u_cvDetail;
// u_cvLook: x erosion (0: no detail), y gain that undoes the frame's overcast dimming of the sun, z ambient gain, w weight
uniform vec4 u_cvMarch; // x view steps, y light steps, z first light step in metres, w frame index
uniform vec4 u_cvBlock; // xy the texel of each 2 × 2 block marched now, z 2: one texel per block, 1: every texel
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_info;
${field ? '#define WH_CV_FIELD 1' : ''}
// The distance along dir from e (relative to the reference point) to the ground: the sphere of radius u_cvRef.w, or
// height 0. 1e30 where the ray does not meet it.
float cvGroundAlong(vec3 e, vec3 dir) {
  if (u_cvRef.w > 0.0) {
    float b = dot(e, dir);
    float dg = b * b - (dot(e, e) - u_cvRef.w * u_cvRef.w);
    float t = dg > 0.0 ? -b - sqrt(dg) : -1.0;
    return t > 0.0 ? t : 1e30;
  }
  return dir.y < 0.0 ? max(-e.y / dir.y, 0.0) : 1e30;
}

void main() {
  vec2 texel = u_cvBlock.z > 1.5 ? floor(gl_FragCoord.xy) * 2.0 + u_cvBlock.xy + 0.5 : gl_FragCoord.xy;
  vec3 dir = cvRay(texel / u_cvView.z);
  vec4 span = cloudVolumeSpan(u_cvEye, dir);
  bool layer = span.y > span.x;
  float entry = layer ? span.x : ${FAR};
  // The scene the last frame drew along this ray ends the march there; beyond the hand-over distance a far layer
  // has the clouds.
  float end = cvRayEnd(span, dir).x;
  float stop = min(end, u_cvFar.y);
  bool clouds = layer && stop > span.x;
  // With the eye under the base: the stretch of the ray under it, up to the layer, the scene or the ground.
  float rainEnd = u_cvRain.y > 0.5 ? min(min(entry, end), min(cvGroundAlong(u_cvEye, dir), u_cvRain.z)) : 0.0;
  if ((!clouds && rainEnd <= 0.0) || u_cvLook.w <= 0.0) {
    o_color = vec4(0.0);
    o_info = cvPackInfo(${FAR}, entry, end);
    return;
  }
  float t0 = span.x;
  float len = clouds ? stop - span.x : 0.0;
  float thick = u_cvSlab.y - u_cvSlab.x;
  int lightSteps = int(u_cvMarch.y);
  // The jitter over the texels marched now (neighbours in the march differ most), moved on every frame.
  float j = cloudVolumeJitter(floor(gl_FragCoord.xy) + 0.5, u_cvMarch.w);
  // Inside the layer and along long rays the samples crowd toward the eye (spacing growing with the distance): the
  // cloud around the eye is a whiteout, and near clouds are larger on the screen than far ones.
  float k = t0 <= 0.0 ? 2.0 : 1.0 + smoothstep(2.0, 8.0, len / thick);
  // Where the samples lie more than half a cell of the shape apart, the shape gives way to its mean (cvBaseShare).
  float cell = 0.25 / u_cvScale.x;
  // The light at the clouds, once per pixel, where the ray has gone a quarter into the layer (halfway through the rain
  // where it misses the clouds).
  float tl = clouds ? t0 + 0.25 * len : 0.5 * rainEnd;
  cvLightAt(u_cvEye + dir * tl, u_cvEyeRender + dir * tl);
  vec3 L = cvL;
  float cosT = dot(dir, L);
  vec3 ph = cvPhases(dir);
  float ext = u_cvSlab.z;
  float T = 1.0;
  vec3 light = vec3(0.0);
  float dSum = 0.0;
  float wSum = 0.0;
  // With the eye under the clouds' base: the rain falling out of them between the eye and where the ray enters the
  // layer, grey shafts in front of the clouds. A sample counts where the place's precipitation (the weather map's B)
  // falls out of cloud right above it (the shape just over the base); it fades out toward the hand-over distance.
  if (rainEnd > 0.0) {
    float rdt = rainEnd / ${RAIN_SHAFT_SAMPLES}.0;
    float rlod = smoothstep(0.12, 0.5, rdt / cell);
    float hr = 0.12;
    // The rain is lit by the grey light under the clouds and the ground's, with little of the sun.
    vec3 rainLight = vec3(dot(0.55 * cvSkyGrey + 0.3 * cvGround + 0.06 * cvSun, vec3(0.3, 0.59, 0.11)));
    for (int i = 0; i < ${RAIN_SHAFT_SAMPLES}; i++) {
      float t = (float(i) + j) * rdt;
      vec3 rel = u_cvEye + dir * t;
      vec3 w = cvWeather(rel);
      if (w.z <= 0.0 || w.x <= 0.0) continue;
      vec3 above = u_cvRef.w > 0.0 ? normalize(rel) * (u_cvRef.w + u_cvSlab.x + hr * thick) : vec3(rel.x, u_cvSlab.x + hr * thick, rel.z);
      vec3 qa = cvNoiseAt(above);
      float shapeA = textureLod(u_cvShape, qa * u_cvScale.x, 0.0).r;
      float cloud = cvBase(shapeA, rlod, cvWide(qa), w, hr);
      // Heavier under the cloud's cores, lighter between them: curtains rather than an even veil.
      float core = mix(0.35, 1.0, smoothstep(0.35, 0.8, mix(shapeA, ${SHAPE_MEAN}, rlod)));
      float sigma = u_cvRain.x * w.z * core * smoothstep(0.0, 0.15, cloud) * (1.0 - smoothstep(0.6 * u_cvRain.z, u_cvRain.z, t));
      if (sigma <= 0.0) continue;
      float ts = exp(-sigma * rdt);
      float wr = T * (1.0 - ts);
      light += rainLight * wr;
      dSum += t * wr;
      wSum += wr;
      T *= ts;
    }
  }
  // Samples: fewer along short spans (steeply from above or below), all of them along long ones, and along a span
  // that runs far through the layer as many as keep the farthest (len * k / fs apart) within half a cell of the
  // shape, up to ${LONG_SPAN_STEPS} times as many. With fewer, the far samples of such a span (tens of kilometres toward the
  // horizon) lie kilometres apart, the shape gives way to its mean over its spread at every one of them, and their
  // shares of cloud, taken as independent, add up to an opaque, evenly lit band where there are clouds with gaps.
  float fs = clouds ? clamp(max(ceil(len * 16.0 / thick), ceil(2.0 * k * len / cell)), max(4.0, floor(u_cvMarch.x * 0.5)), min(u_cvMarch.x * ${LONG_SPAN_STEPS}.0, 160.0)) : 0.0;
  // Through clear air the march takes every second sample; at the first cloud it steps one sample back and goes on
  // sample by sample until three in a row are clear again.
  float fi = 0.0;
  float stride = t0 <= 0.0 ? 1.0 : 2.0;
  float clearRun = 0.0;
  for (int n = 0; n < 160; n++) {
    if (fi >= fs) break;
    float u = (fi + j) / fs;
    float t = t0 + len * pow(u, k);
    float dt = len * k * pow(max(u, 0.5 / fs), k - 1.0) / fs;
    vec3 rel = u_cvEye + dir * t;
    float h = (cloudVolumeHeight(rel) - u_cvSlab.x) / thick;
    float d = 0.0;
    float f = 1.0;
    vec3 weather = vec3(0.0);
    float wide = 0.0;
    float lod = 0.0;
    vec3 q = vec3(0.0);
    if (!(t > span.z && t < span.w) && h > 0.0 && h < 1.0) {
      weather = cvWeather(rel);
      if (weather.x > 0.0) {
        q = cvNoiseAt(rel);
        wide = cvWide(q);
        lod = smoothstep(0.5, 1.0, dt / cell);
        // Toward the hand-over distance the clouds give way to the far layer's.
        vec2 base = cvBaseShare(textureLod(u_cvShape, q * u_cvScale.x, 0.0).r, lod, wide, weather, h);
        d = base.x * (1.0 - smoothstep(u_cvFar.x, u_cvFar.y, t));
        f = base.y;
      }
    }
    if (d > 0.0 && stride > 1.0) {
      stride = 1.0;
      clearRun = 0.0;
      if (fi >= 1.0) {
        fi -= 1.0;
        continue;
      }
    }
    // The erosion's detail is finer than the shape: it gives way sooner, from an eighth of a shape cell between samples.
    float lodDetail = smoothstep(0.12, 0.5, dt / cell);
    if (d > 0.0 && u_cvLook.x > 0.0 && lodDetail < 0.5) d = cloudVolumeErode(d, textureLod(u_cvDetail, q * u_cvScale.z, 0.0).r, u_cvLook.x * (1.0 - 2.0 * lodDetail));
    if (d <= 0.0) {
      clearRun += 1.0;
      if (clearRun >= 3.0) stride = 2.0;
      fi += stride;
      continue;
    }
    clearRun = 0.0;
    fi += 1.0;
    // Toward the light: steps of 1, 3, 5, 7 … times the first step, so the samples reach out ever further.
    float tau = 0.0;
    float s0 = 0.0;
    for (int l = 0; l < 8; l++) {
      if (l >= lightSteps) break;
      float s1 = u_cvMarch.z * float((l + 1) * (l + 1));
      vec3 rl = rel + L * (0.5 * (s0 + s1));
      float hl = (cloudVolumeHeight(rl) - u_cvSlab.x) / thick;
      if (hl >= 1.0 || hl <= 0.0) break;
      tau += cvBase(textureLod(u_cvShape, cvNoiseAt(rl) * u_cvScale.x, 0.0).r, lod, wide, weather, hl) * (s1 - s0);
      s0 = s1;
    }
    // A raining cloud is denser: darker and heavier underneath.
    float dense = ext * (1.0 + ${RAIN_DENSITY} * weather.z);
    tau *= dense;
    vec3 s = cvSampleLight(tau, d, h, weather, ph, cosT);
    float sigma = d * dense;
    float ts = cvStepThrough(sigma, f, dt);
    float w = T * (1.0 - ts);
    light += s * w;
    dSum += t * w;
    wSum += w;
    T *= ts;
    if (T < 0.01) {
      T = 0.0;
      break;
    }
  }
  float alpha = (1.0 - T) * u_cvLook.w;
  if (alpha < 0.002) {
    o_color = vec4(0.0);
    o_info = cvPackInfo(${FAR}, entry, end);
    return;
  }
  float meanM = dSum / max(wSum, 1e-6);
  vec3 col = 0.92 * light / max(1.0 - T, 1e-4);
  vec3 at = u_cvEyeRender + dir * meanM;
  vec3 display = atmosphereApply(aerialPerspective(toDisplay(col), at), at);
  vec4 c = vec4(display * alpha, alpha);
  o_color = u_cvView.w > 0.5 ? sqrt(max(c, 0.0)) : c;
  o_info = cvPackInfo(meanM, entry, end);
}`;
}

/**
 * Fragment shader of the accumulation (into the layer's target, float only; `'other'`): the last picture moved to
 * this frame and the new samples blended in. Two outputs: colour and distances.
 */
const ACCUMULATE_FS = /* glsl */ `#include <header>
${CLOUD_VOLUME_GLSL}
${VIEW_GLSL}
${SCENE_GLSL}
uniform highp sampler2D u_cvMarchColor;
uniform highp sampler2D u_cvMarchInfo;
uniform highp sampler2D u_cvHistColor;
uniform highp sampler2D u_cvHistInfo;
uniform vec4 u_cvBlock;      // xy the texel of each 2 × 2 block marched now, z 1: the last picture is kept, w most samples a texel averages
uniform vec4 u_cvKeep;       // x how far the range of the new samples around is widened for the last picture
uniform vec3 u_cvCloudMoved; // the eye's move since the last frame less the clouds' drift
// The fourth distance of a texel: 2 × the samples it averages + 1 where the last frame did not see where it ended.
vec4 cvInfo(float meanM, float entryM, float endM, float samples, float unseen) {
  return vec4(cvPackInfo(meanM, entryM, endM).xyz, samples * 2.0 + unseen);
}
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_info;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 b = ivec2(u_cvBlock.xy);
  ivec2 last = textureSize(u_cvMarchColor, 0) - 1;
  ivec2 m = c / 2;
  bool fresh = c - m * 2 == b;
  vec3 dir = cvRay((vec2(c) + 0.5) / u_cvView.z);
  vec4 span = cloudVolumeSpan(u_cvEye, dir);
  bool layer = span.y > span.x;
  float entry = layer ? span.x : ${FAR};
  vec2 ends = cvRayEnd(span, dir);
  float end = ends.x;
  // Under the base with the rain drawn every ray may hold some (cvRayEnd).
  if (u_cvRain.y < 0.5 && (!layer || end <= span.x)) {
    o_color = vec4(0.0);
    o_info = cvInfo(${FAR}, entry, end, 0.0, ends.y);
    return;
  }
  // The four nearest marched texels (texel i of the march holds the block texel 2 i + b): the range the last picture
  // is held in. The distances of the nearest.
  vec2 mp = vec2(c - b) * 0.5;
  ivec2 i0 = ivec2(floor(mp));
  vec4 lo = vec4(1e9);
  vec4 hi = vec4(-1e9);
  for (int i = 0; i < 4; i++) {
    vec4 col = texelFetch(u_cvMarchColor, clamp(i0 + ivec2(i & 1, i >> 1), ivec2(0), last), 0);
    lo = min(lo, col);
    hi = max(hi, col);
  }
  vec3 Fi = cvUnpackInfo(texelFetch(u_cvMarchInfo, clamp(ivec2(floor(mp + 0.5)), ivec2(0), last), 0));
  if (u_cvBlock.z > 0.5) {
    // Where this texel's clouds lay in the last frame (at their mean distance, or halfway through the layer; 100 m at
    // least, so that the eye's small moves do not throw the cloud around the eye across the screen).
    float d = max(Fi.x < ${HALF_FAR} ? Fi.x : 0.5 * (span.x + end), 100.0);
    vec3 s = cloudVolumeReproject(cvSceneInverse(), u_cvCloudMoved, dir, d);
    vec2 uv = s.xy * 0.5 + 0.5;
    if (s.z > 0.0 && uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
      // The last frame saw the same surfaces there when one of the four texels around the place saw where this ray
      // enters the layer and where it ends, both seen from the last eye (the end only where both frames knew it).
      float e0 = entry > 0.0 ? length(u_cvSceneMoved + dir * entry) : 0.0;
      float z0 = length(u_cvSceneMoved + dir * end);
      ivec2 hsize = textureSize(u_cvHistInfo, 0);
      ivec2 h0 = ivec2(floor(uv * vec2(hsize) - 0.5));
      float match = 1e9;
      vec4 Hi = vec4(${FAR});
      for (int i = 0; i < 4; i++) {
        vec4 v = texelFetch(u_cvHistInfo, clamp(h0 + ivec2(i & 1, i >> 1), ivec2(0), hsize - 1), 0);
        vec3 hv = v.xyz * 1000.0;
        float a = max(cvApart(hv.y, e0), ends.y + mod(v.w, 2.0) > 0.5 ? 0.0 : cvApart(hv.z, z0));
        if (a < match) {
          match = a;
          Hi = vec4(hv, v.w);
        }
      }
      if (match < 0.05) {
        // Held within the range of the new samples around (widened), and the new sample averaged in.
        vec4 H = texture(u_cvHistColor, uv);
        vec4 pad = (hi - lo) * u_cvKeep.x + 0.01;
        H = clamp(H, lo - pad, hi + pad);
        float n = min(floor(Hi.w * 0.5) + (fresh ? 1.0 : 0.0), u_cvBlock.w);
        o_color = fresh ? mix(H, texelFetch(u_cvMarchColor, m, 0), 1.0 / max(n, 1.0)) : H;
        float meanM = fresh || Hi.x >= ${HALF_FAR} ? Fi.x : max(Hi.x - dot(u_cvCloudMoved, dir), 0.0);
        o_info = cvInfo(o_color.a < 0.002 ? ${FAR} : meanM, entry, end, n, ends.y);
        return;
      }
    }
  }
  // Without the last picture: a tent two march texels wide over the texels around, those of another surface (entry
  // and end) counting little.
  vec4 near = vec4(0.0);
  float wNear = 0.0;
  for (int i = 0; i < 16; i++) {
    ivec2 q = i0 + ivec2((i & 3) - 1, (i >> 2) - 1);
    vec2 dq = abs(vec2(q) - mp);
    if (q.x < 0 || q.y < 0 || q.x > last.x || q.y > last.y || max(dq.x, dq.y) >= 2.0) continue;
    vec3 inf = cvUnpackInfo(texelFetch(u_cvMarchInfo, q, 0));
    float w = (1.0 - 0.5 * dq.x) * (1.0 - 0.5 * dq.y) * (exp(-8.0 * max(cvApart(inf.y, entry), cvApart(inf.z, end))) + 1e-3);
    near += texelFetch(u_cvMarchColor, q, 0) * w;
    wNear += w;
  }
  o_color = near / max(wNear, 1e-6);
  o_info = cvInfo(Fi.x, entry, end, 1.0, ends.y);
}`;

/**
 * Vertex shader of the composite: one quad per tile, none where the layer is not in view. With the depth of the scene
 * known, the quad lies where the layer begins along the view in its tile (its depth the same over the quad). It reads
 * no texture: a vertex shader reading what this frame drew before the colour pass holds the pass back until then.
 */
const COMPOSITE_VS = /* glsl */ `#include <header>
${CLOUD_VOLUME_GLSL}
${VIEW_GLSL}
uniform vec4 u_cvTiling; // x tiles across, y edge of a tile in pixels, z nearest depth along the view, w 1: the quad lies where the layer begins
void main() {
  int tile = gl_VertexID / 6;
  int k = gl_VertexID - tile * 6;
  int across = int(u_cvTiling.x);
  ivec2 t = ivec2(tile % across, tile / across);
  vec2 corner = vec2(k == 1 || k == 4 || k == 5 ? 1.0 : 0.0, k == 2 || k == 3 || k == 5 ? 1.0 : 0.0);
  vec2 p0 = vec2(t) * u_cvTiling.y;
  vec2 p1 = min(p0 + u_cvTiling.y, u_cvView.xy);
  vec2 px = mix(p0, p1, corner);
  vec2 ndc = px / u_cvView.xy * 2.0 - 1.0;
  if (u_cvTiling.w < 0.5) {
    gl_Position = vec4(ndc, 0.0, 1.0);
    return;
  }
  // The nearest the layer comes along the view in the tile and half a tile around (at the corners and the centre):
  // no cloud of the tile lies nearer. None of them in the layer: the tile is far from it.
  float z = 1e30;
  vec2 q0 = p0 - 0.5 * u_cvTiling.y;
  vec2 q1 = p1 + 0.5 * u_cvTiling.y;
  for (int i = 0; i < 5; i++) {
    vec2 p = i == 4 ? 0.5 * (q0 + q1) : mix(q0, q1, vec2(float(i & 1), float(i >> 1)));
    vec3 r = cvRayAt1(p);
    float lr = length(r);
    vec4 span = cloudVolumeSpan(u_cvEye, r / lr);
    z = min(z, span.y > span.x ? span.x / lr : 1e30);
  }
  if (z >= 1e29) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  z = clamp(z * 0.98, u_cvTiling.z, 1e9);
#ifdef WH_DEPTH_LOGARITHMIC
  float depth = u_camUp.w > 0.0 ? min(log2(1.0 + z) * u_camUp.w, 0.9999999) : 0.5;
  gl_Position = vec4(ndc, depth * 2.0 - 1.0, 1.0);
#else
  vec4 clip = u_viewProj * vec4(u_cvEyeRender + cvRayAt1(px) * z, 1.0);
  gl_Position = vec4(ndc, clamp(clip.z / clip.w, -1.0, 1.0), 1.0);
#endif
}`;

/** Fragment shader of the composite (colour pass, `'other'`: it writes its own depth where it needs one). */
function compositeFs(tileDepth: boolean): string {
  return /* glsl */ `#include <header>
${tileDepth ? '#define WH_CV_TILE_DEPTH 1' : ''}
${CLOUD_VOLUME_GLSL}
${VIEW_GLSL}
${SCENE_GLSL}
uniform highp sampler2D u_cvColor;
uniform highp sampler2D u_cvInfo;
out vec4 o_color;
void main() {
  vec2 low = gl_FragCoord.xy * u_cvView.z - 0.5;
  vec2 fl = floor(low);
  vec2 f = low - fl;
  ivec2 b = ivec2(fl);
  ivec2 last = textureSize(u_cvColor, 0) - 1;
  // Four filtered taps half a texel around the pixel: a tent over the 3 × 3 nearest texels, which evens out what is
  // left of the jitter of the march. Where they hold no cloud the pixel is done.
  vec2 size = vec2(last + 1);
  vec4 tent = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i & 1) - 0.5, float(i >> 1) - 0.5);
    vec4 c = texture(u_cvColor, (low + 0.5 + o) / size);
    if (u_cvView.w > 0.5) c *= c;
    tent += c;
  }
  tent *= 0.25;
  if (tent.a < 1e-4) discard;
  vec3 dir = cvRay(gl_FragCoord.xy);
  vec4 span = cloudVolumeSpan(u_cvEye, dir);
  bool layer = span.y > span.x;
  float entry = layer ? span.x : ${FAR};
  // The four nearest texels: their distances, and whether they saw one surface with this pixel (where the ray
  // entered the layer and where it ended there).
  vec3 dd[4];
  float spread = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 q = clamp(b + ivec2(i & 1, i >> 1), ivec2(0), last);
    dd[i] = cvUnpackInfo(texelFetch(u_cvInfo, q, 0));
    spread = max(spread, max(cvApart(dd[i].y, entry), cvApart(dd[i].z, dd[0].z)));
  }
  vec4 sum = vec4(0.0);
  float wSum = 0.0;
  float dSum = 0.0;
  float daSum = 0.0;
  if (spread < 0.02) {
#ifdef WH_CV_TILE_DEPTH
    // One surface, and the quad gave the pixel its depth: the tent.
    if (tent.a < 0.002) discard;
    o_color = tent;
    return;
#endif
    // One surface: the tent, and the distance of the nearest texels that hold a cloud (an empty texel keeps the far
    // distance).
    sum = tent;
    wSum = 1.0;
    for (int i = 0; i < 4; i++) {
      vec2 wb2 = mix(1.0 - f, f, vec2(float(i & 1), float(i >> 1)));
      float w = wb2.x * wb2.y * (dd[i].x < ${HALF_FAR} ? 1.0 : 1e-4);
      dSum += dd[i].x * w;
      daSum += w;
    }
  } else {
    // The edge of the planet, of the layer or of a ridge: only the nearest texels whose entry and end match this
    // pixel's own.
    float end = cvRayEnd(span, dir).x;
    for (int i = 0; i < 4; i++) {
      vec4 c = texelFetch(u_cvColor, clamp(b + ivec2(i & 1, i >> 1), ivec2(0), last), 0);
      if (u_cvView.w > 0.5) c *= c;
      vec2 wb2 = mix(1.0 - f, f, vec2(float(i & 1), float(i >> 1)));
      float r = max(cvApart(dd[i].y, entry), u_cvView.w > 0.5 ? 0.0 : cvApart(dd[i].z, end));
      float w = wb2.x * wb2.y * (exp(-8.0 * r) + 1e-4);
      sum += c * w;
      wSum += w;
      dSum += dd[i].x * w * c.a;
      daSum += w * c.a;
    }
  }
  vec4 c = sum / wSum;
  if (c.a < 0.002) discard;
#ifndef WH_CV_TILE_DEPTH
  float meanM = dSum / max(daSum, 1e-6);
  vec4 clip = u_viewProj * vec4(u_cvEyeRender + dir * meanM, 1.0);
#if defined(WH_DEPTH_LOGARITHMIC)
  float z = u_camUp.w > 0.0 ? log2(1.0 + max(clip.w, 0.0)) * u_camUp.w : clip.z / clip.w * 0.5 + 0.5;
  z = min(z, 0.9999999);
#elif defined(WH_DEPTH_REVERSED)
  float z = max(clip.z / clip.w, 1e-7);
#else
  float z = min(clip.z / clip.w * 0.5 + 0.5, 0.9999999);
#endif
  gl_FragDepth = clamp(z, 0.0, 1.0);
#endif
  o_color = c;
}`;
}

export interface CloudVolumeOptions extends Partial<CloudVolumeShape> {
  /** How finely the layer is marched: a ready setting or its own numbers over `medium`. Default `'medium'`. */
  quality?: keyof typeof CLOUD_VOLUME_QUALITY | Partial<CloudVolumeQuality>;
  /**
   * Eye heights above the ground between which the layer fades out (a far layer such as the cloud shell takes over
   * with `shell`). Default 15 km and 30 km.
   */
  fadeFromM?: number;
  fadeToM?: number;
  /** Farthest distance along a view ray that is marched, metres. Default 120 km. */
  maxDistanceM?: number;
  /**
   * Distances along a view ray over which the volume hands its clouds to a far layer that draws them from the
   * volume's own field (`shell` with `volume`, the cloud shell): all the volume's up to `handoverFromM`, all the far
   * layer's from `handoverToM`. Default 20 km and 40 km. Without such a layer the volume fades out over the last fifth
   * of `maxDistanceM` instead.
   */
  handoverFromM?: number;
  handoverToM?: number;
  /**
   * Keep the clouds from frame to frame (see `CloudVolumeLayer.history`). Default true. Needs a float target; without
   * one the layer marches every texel.
   */
  history?: boolean;
  /** Seed of the noise volumes. Default 0. */
  seed?: number;
  /** Options of the layer's own cloud weather map. */
  weather?: CloudWeatherMapOptions;
  /** The engine's atmosphere layer, when there is one: the march reads the air's tables. */
  atmosphere?: AtmosphereLayer | null;
}

/** The clouds' look that is not the model: how bright the sky's light is inside them. */
const AMBIENT_GAIN = 1;

/**
 * A far layer the volume hands its clouds over to. Its `opacity` is set in every frame. With `volume` (not undefined)
 * the far layer draws the same clouds from the volume's field (`CloudVolumeLayer.bindField`): the volume then sets
 * `volume` to itself while its noise is ready (null before), keeps `opacity` at 1 and hands over by the distance along
 * every view ray as well as by the eye's height. Without it the far layer has its own clouds and `opacity` is
 * 1 − `weight`, a cross-fade by height.
 */
export interface CloudFarLayer {
  opacity: number;
  volume?: CloudVolumeLayer | null;
}

/**
 * The look of the clouds' light, over what the frame's light gives (`CloudVolumeLayer.style`).
 */
export interface CloudVolumeStyle {
  /**
   * How fast the density rises from a cloud's edge inward, a multiple (the density stays at most 1). Above 1 the
   * clouds have crisp edges and solid bodies; their shadows follow.
   */
  edge: number;
  /**
   * How much the clouds shade themselves: a multiple of the optical depth toward the light. Below 1 the sunlit
   * side and the inside stay bright in dense clouds (dense clouds have crisp edges), above 1 they darken sooner.
   */
  selfShadow: number;
  /**
   * How evenly the clouds scatter the sun's light, 0–1: 0 as water drops do (a bright rim toward the sun, darker
   * with the sun behind the eye), 1 the same from every side (no rim).
   */
  even: number;
  /** A multiple of the sun's light in the clouds, by channel: their lit sides. */
  lit: readonly [number, number, number];
  /** A multiple of the sky's and the ground's light in the clouds, by channel: their shaded sides and bases. */
  shade: readonly [number, number, number];
}

/** The style that changes nothing. */
export const DEFAULT_CLOUD_VOLUME_STYLE: CloudVolumeStyle = { edge: 1, selfShadow: 1, even: 0, lit: [1, 1, 1], shade: [1, 1, 1] };

/** What the layer keeps of a frame's view for the next one. */
interface FrameCamera {
  valid: boolean;
  width: number;
  height: number;
  /** The eye relative to the reference point. */
  rel: Vec3;
  forward: Vec3;
  /** The rays at depth 1 (centre, right, up) column by column, and their inverse. */
  rays: number[];
  inverse: number[];
  /** Depth → distance of the frame's depth mode (`cloudVolumeDepthMap`). */
  depthMap: [number, number, number, number];
  /** The cloud pattern's drift, metres. */
  driftX: number;
  driftZ: number;
}

const newCamera = (): FrameCamera => ({ valid: false, width: 0, height: 0, rel: [0, 0, 0], forward: [0, 0, 1], rays: [1, 0, 0, 0, 1, 0, 0, 0, 1], inverse: [1, 0, 0, 0, 1, 0, 0, 0, 1], depthMap: [0, 0, 0, 0], driftX: 0, driftZ: 0 });

/**
 * Volumetric clouds over the scene: the cloud model of `CLOUD_VOLUME_GLSL` marched at a share of the screen's
 * resolution in `prepare`, kept from frame to frame, and put over the scene in the `color` pass. It owns its noise
 * volumes and its cloud weather map (the cover over every place, from the cover by place when the block holds
 * `cloudFieldSlot`). Add it after the opaque layers; `createEngine({ cloudVolume })` keeps it after every layer added
 * through `Engine.add`. One view per renderer: the layer reads the depth the renderer's last frame drew.
 */
export class CloudVolumeLayer implements Layer, CloudShadowSource {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'cloud-volume';
  /** The model: heights, extinction, noise scales. Change it at any time. */
  readonly shape: CloudVolumeShape;
  /** The look of the clouds' light. Change it at any time; the cloud shell that draws this volume's clouds follows. */
  style: CloudVolumeStyle = { ...DEFAULT_CLOUD_VOLUME_STYLE };
  /** How finely the layer is marched. Change it at any time; a new `scale` makes new targets. */
  quality: CloudVolumeQuality;
  fadeFromM: number;
  fadeToM: number;
  maxDistanceM: number;
  handoverFromM: number;
  handoverToM: number;
  /**
   * Keep the clouds from frame to frame: each frame marches a quarter of the texels (one of every 2 × 2, in turn) and
   * the rest come from the last frame's picture moved to this one, which also averages out the jitter of the samples.
   * False: every frame marches every texel and nothing is kept, so a frame is a function of the view, the
   * environment and `frameIndex` alone (for tests). Change it at any time.
   */
  history: boolean;
  /** False: nothing is marched or drawn (and `shell` is fully shown). */
  enabled = true;
  /**
   * A far layer this one hands over to (the cloud shell, `CloudFarLayer`): its `opacity` (and `volume`) are set in
   * every frame. The app should not set them itself while it is attached here.
   */
  shell: CloudFarLayer | null = null;
  /**
   * How much of the frame's precipitation falls at the eye, 0–1: the clouds' optical depth straight above the eye
   * (`cloudVolumeColumnDepth` on the CPU, from the same noise and weather) through `cloudVolumeRainShare`. 1 under a
   * thick cloud, 0 under a gap. `createEngine` hands it to the precipitation layer (`PrecipitationLayer.source`).
   */
  rainShare = 1;
  /**
   * How dense the rain falling out of raining clouds is drawn, seen from under the clouds' base: grey curtains
   * between the ground and the base wherever the weather map's precipitation falls out of cloud, heavier under the
   * clouds' cores, in front of the clouds and of the scene, up to 30 km (or the hand-over distance). 1 the default
   * (the heaviest rain under a core hides what lies 5 km behind it), 0 none (and no cost).
   */
  rainShafts = 1;
  readonly noise: NoiseVolumes;
  readonly weather: CloudWeatherMap;
  /** The layer's weight in the last frame: 1 below `fadeFromM`, 0 from `fadeToM` (and when disabled or not ready). */
  weight = 0;
  /** Samples along the light per texel of the cloud shadow texture (`CloudShadowSource`). */
  shadowSamples = 12;
  /** GLSL of the clouds' depth along the light (`CloudShadowSource`). */
  readonly shadowDepthGlsl: string = SHADOW_DEPTH_GLSL;
  private readonly renderer: Renderer;
  private readonly link: EnvironmentLink;
  private readonly atmosphere: AtmosphereLayer | null;
  private readonly seed: number;
  private readonly fieldParams: (() => CloudCoverField) | null;
  /** This frame's hand-over distances and the sun's gain. */
  private readonly far: [number, number, number, number] = [0, 0, 0, 0];
  private gain = 1;
  private readonly march: Program;
  private readonly accumulate: Program;
  private readonly composites: Partial<Record<'tile' | 'fragment', Program>> = {};
  private marchTarget: ColorTarget | null = null;
  private historyTargets: [ColorTarget, ColorTarget] | null = null;
  /** The picture the composite reads: the history target written last, or the march target. */
  private picture: ColorTarget | null = null;
  private current = 0;
  private format: 'rgba16f' | 'rgba8' = 'rgba16f';
  private drawn = false;
  private historyValid = false;
  /** True once a history could not be made (no room): every texel is marched from then on. */
  private historyFailed = false;
  private index = 0;
  private sceneTexture: Texture | null = null;
  private tileDepth = false;
  /** The eye is under the clouds' base and the rain under them is drawn (`rainShafts`). */
  private under = false;
  private readonly rays: { center: Vec3; right: Vec3; up: Vec3; eye: Vec3; rel: Vec3 } = { center: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], eye: [0, 0, 0], rel: [0, 0, 0] };
  private readonly ref: [number, number, number, number] = [0, 0, 0, 0];
  /** The camera of the last frame (`prev`) and of this one (`now`), swapped after every frame. */
  private prev: FrameCamera = newCamera();
  private now: FrameCamera = newCamera();
  private readonly scene: { inverse: number[]; rays: number[]; moved: Vec3; cloudMoved: Vec3; map: [number, number, number, number] } = {
    inverse: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    rays: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    moved: [0, 0, 0],
    cloudMoved: [0, 0, 0],
    map: [0, 0, 0, 0],
  };

  constructor(renderer: Renderer, link: EnvironmentLink, o: CloudVolumeOptions = {}) {
    this.renderer = renderer;
    this.link = link;
    this.atmosphere = o.atmosphere ?? null;
    const { quality, fadeFromM, fadeToM, maxDistanceM, handoverFromM, handoverToM, history, seed, weather, atmosphere: _a, ...shape } = o;
    this.shape = { ...DEFAULT_CLOUD_VOLUME_SHAPE, ...shape };
    this.quality = { ...CLOUD_VOLUME_QUALITY.medium, ...(typeof quality === 'string' ? CLOUD_VOLUME_QUALITY[quality] : (quality ?? {})) };
    this.fadeFromM = fadeFromM ?? 15000;
    this.fadeToM = fadeToM ?? 30000;
    this.maxDistanceM = maxDistanceM ?? 120000;
    this.handoverFromM = handoverFromM ?? 20000;
    this.handoverToM = handoverToM ?? 40000;
    this.history = history ?? true;
    const device = renderer.device;
    this.seed = seed ?? 0;
    this.noise = new NoiseVolumes(device, { seed: this.seed });
    this.weather = new CloudWeatherMap(renderer, link, weather ?? {});
    const fieldSlot = link.block.slots.find((s) => s.name === CLOUD_FIELD_SLOT) as { params: CloudCoverField } | undefined;
    this.fieldParams = fieldSlot && renderer.radialUp ? () => fieldSlot.params : null;
    const field = fieldSlot !== undefined;
    this.march = device.program('cloud volume march', FULLSCREEN_VS, renderer.resolve(marchFs(field), 'other'));
    this.accumulate = device.program('cloud volume accumulate', FULLSCREEN_VS, renderer.resolve(ACCUMULATE_FS, 'other'));
  }

  /**
   * Moves the per-pixel sample positions (and with a history the texels marched, `cloudVolumeBayer`). With a history
   * it counts up by one every frame; setting it forgets the history, so that a test sees a frame of its own. Without
   * a history it stays where it is set, and the picture holds still.
   */
  get frameIndex(): number {
    return this.index;
  }

  set frameIndex(v: number) {
    this.index = v;
    this.historyValid = false;
  }

  /** Forgets the clouds of earlier frames (after a cut the layer cannot see itself: a new scene in the same view). */
  resetHistory(): void {
    this.historyValid = false;
  }

  /**
   * `CloudShadowSource`: binds the noise and the weather map for a draw of the cloud shadow texture and returns the
   * uniforms of `shadowDepthGlsl`; null while the layer is faded out or not ready. The weight is the last frame's.
   */
  bindShadowDepth(device: Device): Uniforms | null {
    if (this.weight <= 0 || !this.noise.ready) return null;
    const r = this.renderer;
    const c = r.upCenter();
    const wo = r.worldOrigin;
    const s = this.shape;
    this.noise.bind(device, SHAPE_UNIT, DETAIL_UNIT);
    this.weather.bind(device, WEATHER_UNIT);
    return {
      u_cvRef: { vec4: c ? [c[0], c[1], c[2], r.radialUp ? r.radialUp.radiusM : 0] : [-wo[0], -wo[1], -wo[2], 0] },
      u_cvSlab: { vec4: [s.baseM, s.topM, s.extinctionPerM, this.maxDistanceM] },
      u_cvShape: { int: SHAPE_UNIT },
      u_cvWeather: { int: WEATHER_UNIT },
      u_cvTile: { vec4: this.weather.tile },
      u_cvScale: { vec4: [1 / s.shapeSizeM, 1 / s.wideSizeM, 1 / s.detailSizeM, s.wideCover] },
      u_cvShadow: { vec4: [Math.max(1, Math.min(32, Math.round(this.shadowSamples))), this.weight, 0, 0] },
      u_cvEdge: { float: Math.max(0.01, this.style.edge) - 1 },
    };
  }

  /** `CloudShadowSource`: takes the textures of `bindShadowDepth` off their units. */
  unbindShadowDepth(device: Device): void {
    device.volumeTexture(SHAPE_UNIT, null);
    device.volumeTexture(DETAIL_UNIT, null);
    if (this.weather.cube) device.cubeTexture(WEATHER_UNIT, null);
    else device.texture(WEATHER_UNIT, null);
  }

  /**
   * For a far layer that draws the volume's clouds (the cloud shell with `volume`): binds the shape volume and the
   * weather map and returns the uniforms of `VOLUME_DENSITY_GLSL`, `VOLUME_LIGHT_GLSL` and `cloudVolumeNearShare`
   * for this frame; null while the noise is not ready. Call `unbindField` after the draw.
   */
  bindField(device: Device): Uniforms | null {
    if (!this.noise.ready) return null;
    const s = this.shape;
    this.noise.bind(device, SHAPE_UNIT, DETAIL_UNIT);
    this.weather.bind(device, WEATHER_UNIT);
    device.texture(SPARE_UNIT, null);
    return {
      u_cvRef: { vec4: this.ref },
      u_cvSlab: { vec4: [s.baseM, s.topM, s.extinctionPerM, 1e9] },
      u_cvShape: { int: SHAPE_UNIT },
      u_cvWeather: { int: WEATHER_UNIT },
      u_cvTile: { vec4: this.weather.tile },
      u_cvScale: { vec4: [1 / s.shapeSizeM, 1 / s.wideSizeM, 1 / s.detailSizeM, s.wideCover] },
      u_cvFar: { vec4: [this.far[0], this.far[1], this.weight, 0] },
      u_cvLook: { vec4: [0, this.gain, AMBIENT_GAIN, 1] },
      ...this.styleUniforms(),
    };
  }

  /** The uniforms of `style` for `VOLUME_LIGHT_GLSL`. */
  styleUniforms(): Uniforms {
    const { edge, selfShadow, even, lit, shade } = this.style;
    return {
      u_cvEdge: { float: Math.max(0.01, edge) - 1 },
      u_cvLit: { vec4: [lit[0] - 1, lit[1] - 1, lit[2] - 1, Math.max(0, selfShadow) - 1] },
      u_cvShade: { vec4: [shade[0] - 1, shade[1] - 1, shade[2] - 1, Math.min(1, Math.max(0, even))] },
    };
  }

  /** Takes the textures of `bindField` off their units. */
  unbindField(device: Device): void {
    this.unbindShadowDepth(device);
    device.texture(SPARE_UNIT, null);
  }

  /** The clouds' optical depth straight above the eye (`rel`: the eye relative to the reference point). */
  private columnAbove(rel: Vec3, radius: number): number {
    const s = this.shape;
    const E = this.link.frame;
    const r0 = Math.hypot(rel[0], rel[1], rel[2]);
    const up: Vec3 = radius > 0 && r0 > 0 ? [rel[0] / r0, rel[1] / r0, rel[2] / r0] : [0, 1, 0];
    const cover = radius > 0 && this.fieldParams ? cloudFieldCover(this.fieldParams(), up, radius) : (E?.cloudCover ?? 0);
    if (cover <= 0) return 0;
    const dx = E?.cloudX ?? 0;
    const dz = E?.cloudZ ?? 0;
    const wrap = (v: number): number => v - Math.floor(v);
    const at = (h: number): readonly [number, number] => {
      const height = s.baseM + h * (s.topM - s.baseM);
      const p: Vec3 = radius > 0 ? [up[0] * (radius + height), up[1] * (radius + height), up[2] * (radius + height)] : [rel[0], height, rel[2]];
      const q: Vec3 = [p[0] - dx, p[1], p[2] - dz];
      const shape = shapeNoiseAt(wrap(q[0] / s.shapeSizeM), wrap(q[1] / s.shapeSizeM), wrap(q[2] / s.shapeSizeM), NOISE_VOLUME_SHAPE, this.seed);
      const wide = shapeNoiseAt(wrap(q[0] / s.wideSizeM + 0.37), wrap(q[1] / s.wideSizeM + 0.11), wrap(q[2] / s.wideSizeM + 0.73), NOISE_VOLUME_SHAPE, this.seed);
      return [shape, wide];
    };
    return cloudVolumeColumnDepth(at, cover, cloudWeatherKind(cover, this.weather.rules), s);
  }

  /** The clouds' picture (colour, distances) the composite reads, or null before the first frame that marched. */
  get targetTextures(): ColorTarget | null {
    return this.picture;
  }

  prepare(device: Device, view: View): void {
    this.drawn = false;
    this.sceneTexture = null;
    if (view.pixelGrowth <= 0) {
      this.weight = 0;
      this.handOver();
      this.prev.valid = false;
      this.historyValid = false;
      return;
    }
    const r = this.renderer;
    const rays = this.rays;
    const corner = view.cornerRays();
    const o = corner[0]!.origin;
    rays.eye = [o[0], o[1], o[2]];
    const c = r.upCenter();
    const radius = c && r.radialUp ? r.radialUp.radiusM : 0;
    const wo = r.worldOrigin;
    const ref = c ?? [-wo[0], -wo[1], -wo[2]];
    this.ref[0] = ref[0];
    this.ref[1] = ref[1];
    this.ref[2] = ref[2];
    this.ref[3] = radius;
    rays.rel = [o[0] - ref[0], o[1] - ref[1], o[2] - ref[2]];
    // Rays at depth 1 along the view: left-bottom, left-top, right-bottom.
    const f = view.axes().forward;
    const [lb, lt, rb] = corner.map((ray) => {
      const k = 1 / (ray.dir[0] * f[0] + ray.dir[1] * f[1] + ray.dir[2] * f[2]);
      return [ray.dir[0] * k, ray.dir[1] * k, ray.dir[2] * k] as Vec3;
    }) as [Vec3, Vec3, Vec3, Vec3];
    rays.right = [(rb[0] - lb[0]) / 2, (rb[1] - lb[1]) / 2, (rb[2] - lb[2]) / 2];
    rays.up = [(lt[0] - lb[0]) / 2, (lt[1] - lb[1]) / 2, (lt[2] - lb[2]) / 2];
    rays.center = [lb[0] + rays.right[0] + rays.up[0], lb[1] + rays.right[1] + rays.up[1], lb[2] + rays.right[2] + rays.up[2]];
    this.noteCamera(view, f, r);

    const height = radius > 0 ? Math.hypot(rays.rel[0], rays.rel[1], rays.rel[2]) - radius : rays.rel[1];
    this.weight = this.enabled ? cloudVolumeFade(height, this.fadeFromM, this.fadeToM) : 0;
    this.under = this.rainShafts > 0 && height < this.shape.baseM;
    const cover = this.link.frame?.cloudCover ?? 0;
    this.gain = 1 / Math.max(cloudCoverTerms(cover, 0).sunShare, 1e-3);
    // The weather map and the volumes are made (and kept) also while the layer is faded out, so it is ready.
    if (this.enabled) {
      this.weather.prepare(device, view);
      this.noise.prepare(device, view);
      this.rainShare = cloudVolumeRainShare(this.columnAbove(rays.rel, radius));
    } else this.rainShare = 1;
    if (this.weight <= 0 || !this.noise.ready || !this.ensureTargets(device, view)) {
      this.weight = 0;
      this.handOver();
      this.endFrame(false);
      return;
    }
    this.handOver();
    const s = this.shape;
    const q = this.quality;
    const history = this.historyTargets !== null;
    const prev = this.prev;
    const now = this.now;
    // The last frame's depth, where it can be read and its view is known.
    const sc = this.scene;
    const sameScreen = prev.valid && prev.width === now.width && prev.height === now.height;
    sc.map = [0, 0, 0, 0];
    if (sameScreen) {
      this.sceneTexture = device.sceneDepth();
      if (this.sceneTexture) sc.map = prev.depthMap;
    }
    sc.inverse = prev.inverse;
    sc.rays = prev.rays;
    sc.moved = [now.rel[0] - prev.rel[0], now.rel[1] - prev.rel[1], now.rel[2] - prev.rel[2]];
    sc.cloudMoved = [sc.moved[0] - (now.driftX - prev.driftX), sc.moved[1], sc.moved[2] - (now.driftZ - prev.driftZ)];
    const layerDistance = height < s.baseM ? s.baseM - height : height > s.topM ? height - s.topM : 0;
    const turn = now.forward[0] * prev.forward[0] + now.forward[1] * prev.forward[1] + now.forward[2] * prev.forward[2];
    const movedM = Math.hypot(sc.moved[0], sc.moved[1], sc.moved[2]);
    const keep = history && this.historyValid && sameScreen && cloudVolumeKeepHistory(movedM, layerDistance, turn);
    // The eye did not move: the history averages more samples and holds them less tightly.
    const still = movedM < 0.01 && turn > 0.9999999;
    // Under the base with the rain drawn, a ray that misses the layer (toward the ground) may hold rain in front of the
    // scene: every pixel then writes its depth (the quads at the layer's start would hide it behind the scene).
    this.tileDepth = this.format === 'rgba16f' && device.depthMode !== 'standard' && !this.under;

    // The march.
    const gain = this.gain;
    const lightSteps = Math.max(1, Math.min(8, Math.round(q.lightSteps)));
    const reach = Math.min(0.65 * (s.topM - s.baseM), 2000);
    const [bx, by] = cloudVolumeBayer(this.index);
    this.noise.bind(device, SHAPE_UNIT, DETAIL_UNIT);
    this.weather.bind(device, WEATHER_UNIT);
    this.atmosphere?.bindTables(device);
    device.texture(SCENE_UNIT, this.sceneTexture);
    device.texture(SPARE_UNIT, null);
    const marchTarget = this.marchTarget!;
    device.fill(marchTarget, this.march, {
      ...this.viewUniforms(view),
      ...this.sceneUniforms(SCENE_UNIT),
      u_cvShape: { int: SHAPE_UNIT },
      u_cvDetail: { int: DETAIL_UNIT },
      u_cvWeather: { int: WEATHER_UNIT },
      u_cvTile: { vec4: this.weather.tile },
      u_cvScale: { vec4: [1 / s.shapeSizeM, 1 / s.wideSizeM, 1 / s.detailSizeM, s.wideCover] },
      u_cvLook: { vec4: [q.detail ? s.erosion : 0, gain, AMBIENT_GAIN, this.weight] },
      ...this.styleUniforms(),
      u_cvFar: { vec4: this.far },
      // With a history every texel is marched every fourth frame: its jitter moves on once per visit.
      u_cvMarch: { vec4: [Math.max(1, Math.min(128, Math.round(q.steps))), lightSteps, reach / (lightSteps * lightSteps), history ? Math.floor(this.index / 4) : this.index] },
      u_cvBlock: { vec4: [bx, by, history ? 2 : 1, 0] },
    });
    device.volumeTexture(SHAPE_UNIT, null);
    device.volumeTexture(DETAIL_UNIT, null);
    if (this.weather.cube) device.cubeTexture(WEATHER_UNIT, null);
    else device.texture(WEATHER_UNIT, null);
    device.texture(SCENE_UNIT, null);

    // The accumulation.
    this.picture = marchTarget;
    if (this.historyTargets) {
      const from = this.historyTargets[this.current]!;
      const into = this.historyTargets[1 - this.current]!;
      device.texture(MARCH_COLOR_UNIT, marchTarget.textures[0]!);
      device.texture(MARCH_INFO_UNIT, marchTarget.textures[1]!);
      device.texture(HISTORY_COLOR_UNIT, from.textures[0]!);
      device.texture(HISTORY_INFO_UNIT, from.textures[1]!);
      device.texture(HISTORY_SCENE_UNIT, this.sceneTexture);
      device.texture(SPARE_UNIT, null);
      device.fill(into, this.accumulate, {
        ...this.viewUniforms(view),
        ...this.sceneUniforms(HISTORY_SCENE_UNIT),
        u_cvMarchColor: { int: MARCH_COLOR_UNIT },
        u_cvMarchInfo: { int: MARCH_INFO_UNIT },
        u_cvHistColor: { int: HISTORY_COLOR_UNIT },
        u_cvHistInfo: { int: HISTORY_INFO_UNIT },
        u_cvBlock: { vec4: [bx, by, keep ? 1 : 0, still ? HISTORY_STILL : HISTORY_MOVING] },
        u_cvKeep: { vec4: [still ? 1.5 : 0.5, 0, 0, 0] },
        u_cvCloudMoved: { vec3: sc.cloudMoved },
      });
      for (const unit of [MARCH_COLOR_UNIT, MARCH_INFO_UNIT, HISTORY_COLOR_UNIT, HISTORY_INFO_UNIT, HISTORY_SCENE_UNIT]) device.texture(unit, null);
      this.current = 1 - this.current;
      this.picture = into;
    }

    this.drawn = true;
    this.endFrame(history);
  }

  /**
   * This frame's hand-over: the distances along a view ray (to a far layer that draws from this field, else the last
   * fifth of the farthest distance) and the far layer's opacity and field.
   */
  private handOver(): void {
    const shell = this.shell;
    // The far layer draws from the field only round a sphere (`radialUp`): a flat world keeps the cross-fade.
    const field = shell !== null && shell.volume !== undefined && this.enabled && this.noise.ready && this.ref[3]! > 0;
    const to = field ? Math.min(this.handoverToM, this.maxDistanceM) : this.maxDistanceM;
    this.far[0] = field ? Math.min(this.handoverFromM, to * 0.999) : 0.8 * to;
    this.far[1] = to;
    this.far[2] = this.weight;
    if (!shell) return;
    if (shell.volume !== undefined) shell.volume = field ? this : null;
    shell.opacity = field ? 1 : 1 - this.weight;
  }

  /** Notes this frame's view (`now`): what the next frame reprojects from. */
  private noteCamera(view: View, forward: Vec3, r: Renderer): void {
    const rays = this.rays;
    const now = this.now;
    now.valid = true;
    now.width = view.width;
    now.height = view.height;
    now.rel = [rays.rel[0], rays.rel[1], rays.rel[2]];
    now.forward = [forward[0], forward[1], forward[2]];
    now.rays = [...rays.center, ...rays.right, ...rays.up];
    const inv = cloudVolumeScreenBasis(rays.center, rays.right, rays.up);
    if (inv) now.inverse = inv;
    else now.valid = false;
    const p = r.projection;
    now.depthMap = cloudVolumeDepthMap(r.device.depthMode, p.viewProj, p.logScale);
    now.driftX = this.link.frame?.cloudX ?? 0;
    now.driftZ = this.link.frame?.cloudZ ?? 0;
  }

  /** The frame is done: this camera becomes the last one; with a history the index moves on. */
  private endFrame(kept: boolean): void {
    const t = this.prev;
    this.prev = this.now;
    this.now = t;
    this.historyValid = kept;
    if (kept) this.index++;
  }

  /** Uniforms of every draw: the reference point, the layer, the rays and the target's encoding. */
  private viewUniforms(view: View): Record<string, { vec4: [number, number, number, number] } | { vec3: [number, number, number] }> {
    const rays = this.rays;
    const s = this.shape;
    const t = this.picture ?? this.marchTarget;
    const w = this.historyTargets ? this.historyTargets[0].width : (t?.width ?? view.width);
    return {
      u_cvRef: { vec4: this.ref },
      u_cvSlab: { vec4: [s.baseM, s.topM, s.extinctionPerM, this.maxDistanceM] },
      u_cvView: { vec4: [view.width, view.height, w / view.width, this.format === 'rgba8' ? 1 : 0] },
      u_cvEye: { vec3: rays.rel },
      u_cvEyeRender: { vec3: rays.eye },
      u_cvRayCenter: { vec3: rays.center },
      u_cvRayRight: { vec3: rays.right },
      u_cvRayUp: { vec3: rays.up },
      u_cvRain: { vec4: [Math.max(0, this.rainShafts) * RAIN_SHAFT_EXTINCTION, this.under ? 1 : 0, Math.min(this.far[1], RAIN_SHAFT_REACH_M), 0] },
    };
  }

  /** Uniforms of the last frame's scene (its depth on `unit`). */
  private sceneUniforms(unit: number): Record<string, { int: number } | { vec4: [number, number, number, number] } | { vec3: [number, number, number] }> {
    const sc = this.scene;
    const m = sc.inverse;
    const r = sc.rays;
    return {
      u_cvScene: { int: unit },
      u_cvSceneInv0: { vec3: [m[0]!, m[1]!, m[2]!] },
      u_cvSceneInv1: { vec3: [m[3]!, m[4]!, m[5]!] },
      u_cvSceneInv2: { vec3: [m[6]!, m[7]!, m[8]!] },
      u_cvSceneCenter: { vec3: [r[0]!, r[1]!, r[2]!] },
      u_cvSceneRight: { vec3: [r[3]!, r[4]!, r[5]!] },
      u_cvSceneUp: { vec3: [r[6]!, r[7]!, r[8]!] },
      u_cvSceneMoved: { vec3: sc.moved },
      u_cvSceneMap: { vec4: this.sceneTexture ? sc.map : [0, 0, 0, 0] },
    };
  }

  /**
   * The targets at this frame's size: made again when the screen, the scale or `history` changed. False when none
   * can be made (a lost context).
   */
  private ensureTargets(device: Device, view: View): boolean {
    const scale = Math.min(1, Math.max(0.1, this.quality.scale));
    const [w, h] = cloudVolumeTargetSize(view.width, view.height, scale);
    const wantHistory = this.history && this.format === 'rgba16f' && !this.historyFailed;
    const [mw, mh] = cloudVolumeMarchSize(w, h, wantHistory);
    const m = this.marchTarget;
    const hist = this.historyTargets;
    const fits = m && m.width === mw && m.height === mh && m.textures[0] && (wantHistory ? hist !== null && hist[0].width === w && hist[0].height === h : hist === null);
    if (fits) return true;
    this.dropTargets(device);
    this.historyValid = false;
    let march = device.colorTarget(mw, mh, 2, 'rgba16f');
    this.format = 'rgba16f';
    if (!march) {
      // Without float targets: every texel every frame, the distances as logarithms.
      this.format = 'rgba8';
      const [fw, fh] = cloudVolumeMarchSize(w, h, false);
      march = device.colorTarget(fw, fh, 2, 'rgba8');
    }
    if (!march) return false;
    this.marchTarget = march;
    if (wantHistory && this.format === 'rgba16f') {
      const a = device.colorTarget(w, h, 2, 'rgba16f');
      const b = device.colorTarget(w, h, 2, 'rgba16f');
      if (a && b) this.historyTargets = [a, b];
      else {
        if (a) device.deleteColorTarget(a);
        if (b) device.deleteColorTarget(b);
        // No room for a history: march every texel.
        this.historyFailed = true;
        device.deleteColorTarget(march);
        const full = device.colorTarget(w, h, 2, 'rgba16f');
        if (!full) return false;
        this.marchTarget = full;
      }
    }
    return true;
  }

  private dropTargets(device: Device): void {
    if (this.marchTarget) device.deleteColorTarget(this.marchTarget);
    if (this.historyTargets) for (const t of this.historyTargets) device.deleteColorTarget(t);
    this.marchTarget = null;
    this.historyTargets = null;
    this.picture = null;
  }

  /** The composite program for this frame: the quads at the layer's start, or every pixel writing its depth. */
  private composite(): Program {
    const kind = this.tileDepth ? 'tile' : 'fragment';
    let p = this.composites[kind];
    if (!p) {
      const r = this.renderer;
      p = r.device.program(`cloud volume composite (${kind})`, r.resolve(COMPOSITE_VS, 'other'), r.resolve(compositeFs(this.tileDepth), 'other'));
      this.composites[kind] = p;
    }
    return p;
  }

  draw(ctx: DrawContext): void {
    const picture = this.picture;
    if (ctx.pass !== 'color' || !this.drawn || !picture) return;
    const device = ctx.device;
    const p = this.composite();
    device.setState({ depthTest: true, depthWrite: false, cullBack: false, blend: { src: 'one', dst: 'one-minus-src-alpha' }, alphaToCoverage: false, polygonOffset: null });
    device.use(p);
    const uniforms = { ...this.viewUniforms(ctx.view), ...this.sceneUniforms(SCENE_UNIT) };
    for (const name in uniforms) p.set(name, uniforms[name]!);
    const [tx, ty] = cloudVolumeTiles(picture.width, picture.height);
    p.set('u_cvTiling', { vec4: [tx, CLOUD_VOLUME_TILE / (picture.width / ctx.view.width), this.renderer.depthNearM * 1.5, this.tileDepth ? 1 : 0] });
    device.texture(COLOR_UNIT, picture.textures[0]!);
    device.texture(INFO_UNIT, picture.textures[1]!);
    device.texture(SCENE_UNIT, this.sceneTexture);
    p.int('u_cvColor', COLOR_UNIT);
    p.int('u_cvInfo', INFO_UNIT);
    device.drawVertices(tx * ty * 6);
    for (const unit of [COLOR_UNIT, INFO_UNIT, SCENE_UNIT, SPARE_UNIT]) device.texture(unit, null);
    ctx.count(2 * tx * ty);
  }

  dispose(): void {
    this.noise.dispose();
    this.dropTargets(this.renderer.device);
  }
}
