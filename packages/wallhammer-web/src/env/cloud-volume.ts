// Volumetric clouds: the model of a cloud layer between two heights that the runtime's `CloudVolumeLayer` marches
// through on the graphics card, as GLSL and as CPU twins of its pure parts (so they can be checked without one).
//
// The layer lies between `baseM` and `topM` above the ground: two spheres round the centre of up (radial up), or two
// planes of world height (flat). The density at a point is the shape volume (gen-tex `NOISE_VOLUME_SHAPE`, one tile
// per `shapeSizeM`) times a height profile, cut at a threshold set by the cloud cover of the place (the cloud weather
// map): low cover leaves only the densest cores, high cover nearly everything. The profile rises steeply at the base
// (flat bases) and falls toward the top, so the higher a point the denser the noise must be to stay cloud (narrowing,
// rounded tops); as the sky closes the clouds flatten into a lower deck. A second lookup of the same volume at a much
// larger scale moves the cover up and down, so the tiles do not repeat visibly from above; the detail volume
// (`NOISE_VOLUME_DETAIL`) eats into the edges. The noise is fixed to the world (the ground sphere's centre, or the
// world origin) and drifts with the cloud pattern of the frame (`u_cloud.xy`), as the cloud shell does.

import { clamp, smoothstep } from '../base/math.ts';
import type { Vec3 } from '../base/math.ts';

/** The cloud layer: where it lies, how dense it is and the scales of its noise. */
export interface CloudVolumeShape {
  /** Height of the layer's base above the ground (the radial-up sphere, or world y = 0), metres. */
  baseM: number;
  /** Height of the layer's top, metres. */
  topM: number;
  /** Extinction per metre where the density is 1 (light left after d metres: exp(−extinction · d)). */
  extinctionPerM: number;
  /** Edge of one tile of the shape volume, metres (its largest cells are a quarter of it). */
  shapeSizeM: number;
  /** Edge of one tile of the wide lookup of the shape volume that varies the cover, metres. */
  wideSizeM: number;
  /** How far the wide lookup moves the cover up and down (0 = not at all). */
  wideCover: number;
  /** Edge of one tile of the detail volume, metres. */
  detailSizeM: number;
  /** How deep the detail volume eats into the edges, 0–1. */
  erosion: number;
}

/** A layer from 1.5 to 4 km, clouds a few kilometres across (the cloud pattern's `sizeM` of 2400 m). */
export const DEFAULT_CLOUD_VOLUME_SHAPE: Readonly<CloudVolumeShape> = {
  baseM: 1500,
  topM: 4000,
  extinctionPerM: 0.03,
  shapeSizeM: 9600,
  wideSizeM: 41700,
  wideCover: 0.3,
  detailSizeM: 1700,
  erosion: 0.45,
};

/** How finely the layer is marched: the cost per frame. */
export interface CloudVolumeQuality {
  /** Share of the screen's width and height the clouds are marched at (0.1–1); the rest is filled in. */
  scale: number;
  /** Samples along a view ray. */
  steps: number;
  /** Samples toward the light from every sample inside a cloud. */
  lightSteps: number;
  /** Whether the detail volume erodes the edges. */
  detail: boolean;
}

/** Ready settings; `medium` is the default. */
export const CLOUD_VOLUME_QUALITY: Readonly<Record<'low' | 'medium' | 'high', Readonly<CloudVolumeQuality>>> = {
  low: { scale: 0.35, steps: 16, lightSteps: 3, detail: false },
  medium: { scale: 0.5, steps: 20, lightSteps: 4, detail: true },
  high: { scale: 0.5, steps: 40, lightSteps: 5, detail: true },
};

/** Cover from which the heaped clouds start to flatten into a deck, and where they are flattest. */
const DECK_FROM = 0.6;
const DECK_TO = 0.95;
/** Share of the layer the clouds reach under a closed deck (heaped clouds reach the top). */
const DECK_TOP = 0.45;
/** Share of the layer a deck raining at full strength reaches: a thick, raining deck (nimbostratus). */
const RAIN_DECK_TOP = 0.85;
/** Share of the layer over which the base rises from nothing to full. */
const BASE_RISE = 0.07;
/** Where, as a share of the clouds' own top, the profile starts to fall. */
const TOP_FALL = 0.2;
/**
 * Noise thresholds at cover 0 and cover 1 (the shape volume's median is about 0.58). Seen from below, columns with
 * an optical depth over 1 then cover about a tenth of the sky at cover 0.2, 38 % at 0.35, 69 % at 0.5 and nearly
 * all from 0.7 on.
 */
const THRESHOLD_CLEAR = 0.9;
const THRESHOLD_FULL = 0.1;

const g = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** Where, as a share of a tall cloud's top, its profile starts to fall: full tops up to the top of the layer. */
const TALL_FALL = 0.55;

/**
 * The height profile at `h` (0 at the layer's base, 1 at its top) under the cover `cover`: 0 … 1. It rises over the
 * lowest 7 % and falls from a fifth of the clouds' top to that top, which is the whole layer for heaped clouds and
 * sinks to 45 % as the cover closes from 0.6 to 0.95. The same as `cloudVolumeTypedProfile` with the deck share of
 * the cover (`cloudVolumeDeck`) and no tall clouds.
 */
export function cloudVolumeProfile(h: number, cover: number): number {
  return cloudVolumeTypedProfile(h, cloudVolumeDeck(cover), 0);
}

/** The deck share of a cover alone: 0 for heaped clouds, 1 for a flat deck (the cover from 0.6 to 0.95). */
export function cloudVolumeDeck(cover: number): number {
  return smoothstep(DECK_FROM, DECK_TO, cover);
}

/**
 * The height profile by cloud type: `deck` 0 heaped clouds (cumulus) … 1 a flat, lower deck (stratus, reaching 45 % of
 * the layer); `tall` 0 … 1 towering clouds that fill the layer to its top with full, rounded tops (where it rains out
 * of heaped clouds). A tall cloud is never a deck: the deck share counts only for what is not tall. `rain` 0 … 1, the
 * place's precipitation, thickens a deck: a deck raining at full strength reaches 85 % of the layer.
 */
export function cloudVolumeTypedProfile(h: number, deck: number, tall: number, rain = 0): number {
  const k = clamp(tall, 0, 1);
  const deckTop = DECK_TOP + (RAIN_DECK_TOP - DECK_TOP) * clamp(rain, 0, 1);
  const top = 1 - (1 - deckTop) * clamp(deck, 0, 1) * (1 - k);
  const fall = (TOP_FALL + (TALL_FALL - TOP_FALL) * k) * top;
  return smoothstep(0, BASE_RISE, h) * (1 - smoothstep(fall, top, h));
}

/** How the cloud weather map types the clouds of a place by its cover (`CloudWeatherMap.rules`). */
export interface CloudWeatherRules {
  /** Cover over which heaped clouds flatten into a deck (stratus): from, to. Default 0.6 and 0.95. */
  deckCover: readonly [number, number];
  /** Cover over which the clouds start to rain or snow, up to the heaviest: from, to. Default 0.6 and 0.9. */
  rainCover: readonly [number, number];
  /**
   * 0 … 1: how much of the precipitating clouds are towering heaped clouds (showers, storms) rather than a deck that
   * rains steadily. Default 0.
   */
  convection: number;
}

export const DEFAULT_CLOUD_WEATHER_RULES: Readonly<CloudWeatherRules> = { deckCover: [DECK_FROM, DECK_TO], rainCover: [0.6, 0.9], convection: 0 };

/**
 * The cloud type of a place from its cover, as the weather map stores it: [deck share (G), precipitation (B)], both
 * 0–1. The tall share is the precipitation that is not deck: `rain · (1 − deck)`.
 */
export function cloudWeatherKind(cover: number, rules: Readonly<CloudWeatherRules> = DEFAULT_CLOUD_WEATHER_RULES): [number, number] {
  const rain = smoothstep(rules.rainCover[0], rules.rainCover[1], cover);
  const deck = smoothstep(rules.deckCover[0], rules.deckCover[1], cover) * (1 - clamp(rules.convection, 0, 1) * rain);
  return [deck, rain];
}

/** How much denser a cloud that rains at full strength is than a dry one (darker, heavier bases). */
export const CLOUD_RAIN_DENSITY = 2;

/**
 * The cover the shape is cut at where it rains: the place's cover closed toward 1 by its precipitation `rain` (the
 * weather map's B), by its square root so that light rain already closes most of the gaps. The sky over rain is then
 * closed (or towering, where the rules make the rain convective) and rain does not fall out of broken cloud with
 * blue gaps.
 */
export function cloudVolumeRainCover(cover: number, rain: number): number {
  if (cover <= 0) return 0;
  const r = Math.sqrt(clamp(rain, 0, 1));
  return clamp(cover + (1 - cover) * r, 0, 1);
}

/** The shape value under which a cloud raining at full strength has no holes: its column is filled up to it. */
const RAIN_SHAPE_FLOOR = 0.45;

/**
 * The volume's share of the clouds at `distanceM` along a view ray: its `weight` (the fade by the eye's height) up to
 * `fromM`, falling smoothly to 0 at `toM`. A far layer (the cloud shell) draws the rest, 1 − share, so the two meet
 * without a seam at every distance and every height.
 */
export function cloudVolumeNearShare(distanceM: number, fromM: number, toM: number, weight: number): number {
  return weight * (1 - smoothstep(fromM, toM, distanceM));
}

/**
 * The clouds' optical depth straight up through the layer at one place: `samples` points spread evenly over the
 * layer, `shapeAt(h)` the shape volume [at the point, at the wide scale] at the height share h (0 base … 1 top), the
 * place's `cover` and its kind (`cloudWeatherKind`). No erosion: the column's bulk, not its edges.
 */
export function cloudVolumeColumnDepth(
  shapeAt: (h: number) => readonly [number, number],
  cover: number,
  kind: readonly [number, number],
  shape: Pick<CloudVolumeShape, 'baseM' | 'topM' | 'extinctionPerM' | 'wideCover'> = DEFAULT_CLOUD_VOLUME_SHAPE,
  samples = 4,
): number {
  const n = Math.max(1, Math.round(samples));
  const dz = (shape.topM - shape.baseM) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const h = (i + 0.5) / n;
    const [s, wide] = shapeAt(h);
    sum += cloudVolumeDensity(s, wide, 0, cover, h, { wideCover: shape.wideCover, erosion: 0 }, kind);
  }
  return sum * dz * shape.extinctionPerM * (1 + CLOUD_RAIN_DENSITY * kind[1]);
}

/**
 * How much of the frame's precipitation falls at a place, from the clouds' optical depth straight above it
 * (`cloudVolumeColumnDepth`): none under a gap (below 0.5), all under a thick cloud (from 3).
 */
export function cloudVolumeRainShare(columnDepth: number): number {
  return smoothstep(0.5, 3, columnDepth);
}

/** The noise threshold for a cover: the shape value (times the profile) above which a point is cloud. */
export function cloudVolumeThreshold(cover: number): number {
  return THRESHOLD_CLEAR + (THRESHOLD_FULL - THRESHOLD_CLEAR) * clamp(cover, 0, 1);
}

/**
 * The density 0–1 at a point: `shape` and `wide` are the shape volume at the point and at its wide scale, `detail`
 * the detail volume (pass 0 to leave the erosion out), `cover` the place's cover, `h` the height in the layer (0–1).
 * `kind`: the place's [deck share, precipitation] from the weather map (`cloudWeatherKind`); without it the deck
 * share follows the cover and nothing is tall. With it the precipitation closes the cover (`cloudVolumeRainCover`), steadies
 * the wide lookup and fills the shape's low values, so a raining cloud has no gaps.
 */
export function cloudVolumeDensity(
  shape: number,
  wide: number,
  detail: number,
  cover: number,
  h: number,
  look: Pick<CloudVolumeShape, 'wideCover' | 'erosion'> = DEFAULT_CLOUD_VOLUME_SHAPE,
  kind?: readonly [number, number],
): number {
  // Where it rains the cover closes, the wide lookup moves it less and the shape's low values fill up: no gaps.
  const wet = kind ? Math.sqrt(clamp(kind[1], 0, 1)) : 0;
  const closed = kind ? cloudVolumeRainCover(cover, kind[1]) : cover;
  const c = clamp(closed + (wide - 0.5) * look.wideCover * (1 - wet), 0, 1);
  if (cover <= 0 || c <= 0) return 0;
  const t = cloudVolumeThreshold(c);
  const profile = kind ? cloudVolumeTypedProfile(h, kind[0], kind[1] * (1 - kind[0]), kind[1]) : cloudVolumeProfile(h, c);
  const filled = shape + (Math.max(shape, RAIN_SHAPE_FLOOR) - shape) * wet;
  const base = clamp((filled * profile - t) / (1 - t), 0, 1);
  if (base <= 0) return 0;
  const lo = detail * look.erosion;
  return clamp((base - lo) / (1 - lo), 0, 1);
}

/**
 * Where a ray meets the layer: [t0, t1, gap0, gap1] in metres along the unit direction `dir` from `eye` (relative to
 * the centre of the ground sphere of radius `radiusM`, or for 0 a flat world with `eye` in world coordinates). The
 * ray is in the layer from t0 to t1 (none when t1 ≤ t0), cut where it meets the ground and at `maxM`; between gap0
 * and gap1 (when gap1 > gap0) it passes under the base and rises into the layer again further on.
 */
export function cloudVolumeSpan(eye: Vec3, dir: Vec3, radiusM: number, baseM: number, topM: number, maxM: number): [number, number, number, number] {
  if (radiusM > 0) {
    const r0 = Math.hypot(eye[0], eye[1], eye[2]);
    const b = eye[0] * dir[0] + eye[1] * dir[1] + eye[2] * dir[2];
    const rt = radiusM + topM;
    const dt = b * b - (r0 - rt) * (r0 + rt);
    if (dt <= 0) return [1, 0, 0, 0];
    const st = Math.sqrt(dt);
    let t0 = Math.max(-b - st, 0);
    let t1 = -b + st;
    let g0 = 0;
    let g1 = 0;
    const dg = b * b - (r0 - radiusM) * (r0 + radiusM);
    const ground = dg > 0 && -b - Math.sqrt(dg) > 0 ? -b - Math.sqrt(dg) : Infinity;
    const rb = radiusM + baseM;
    const db = b * b - (r0 - rb) * (r0 + rb);
    if (db > 0) {
      const sb = Math.sqrt(db);
      if (r0 < rb) t0 = Math.max(t0, -b + sb);
      else if (-b - sb > 0) {
        if (ground < Infinity) t1 = Math.min(t1, -b - sb);
        else {
          g0 = -b - sb;
          g1 = -b + sb;
        }
      }
    }
    t1 = Math.min(t1, ground, maxM);
    return [t0, t1, g0, g1];
  }
  const h = eye[1];
  if (Math.abs(dir[1]) < 1e-6) return h > baseM && h < topM ? [0, maxM, 0, 0] : [1, 0, 0, 0];
  const ta = (baseM - h) / dir[1];
  const tb = (topM - h) / dir[1];
  return [Math.max(Math.min(ta, tb), 0), Math.min(Math.max(ta, tb), maxM), 0, 0];
}

/**
 * The volume's weight by the eye's height above the ground: 1 up to `fromM`, 0 from `toM`, smooth between. A far
 * layer (the cloud shell) takes over with 1 − weight.
 */
export function cloudVolumeFade(heightM: number, fromM: number, toM: number): number {
  return 1 - smoothstep(fromM, toM, heightM);
}

/**
 * Where along its step a pixel's ray samples (0–1): interleaved gradient noise of the pixel, moved on by the golden
 * ratio with every frame index (`CloudVolumeLayer.frameIndex`). Any few frames in a row then sample each pixel at
 * evenly spread places, so their average is smooth; and the picture holds still while the index does.
 */
export function cloudVolumeJitter(x: number, y: number, frameIndex: number): number {
  const f = (v: number): number => v - Math.floor(v);
  return f(f(52.9829189 * f(0.06711056 * x + 0.00583715 * y)) + frameIndex * 0.618034);
}

/** Texels of the layer's target (the clouds at their own resolution) for a screen of `width` × `height` pixels at `scale`. */
export function cloudVolumeTargetSize(width: number, height: number, scale: number): [number, number] {
  return [Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale))];
}

/** The texel of each 2 × 2 block in the frames 0, 1, 2, 3 (then again): one diagonal, then the other. */
const BAYER: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
];

/**
 * The texel of every 2 × 2 block of the layer's target that the frame `frameIndex` marches while the layer keeps a
 * history (`CloudVolumeLayer.history`): (0, 0), (1, 1), (1, 0), (0, 1) in turn, so four frames march every texel once.
 */
export function cloudVolumeBayer(frameIndex: number): [number, number] {
  const b = BAYER[((Math.floor(frameIndex) % 4) + 4) % 4]!;
  return [b[0], b[1]];
}

/**
 * Texels marched per frame for a layer target of `width` × `height` texels: all of them, or with a history one of
 * every 2 × 2 block (`cloudVolumeBayer`).
 */
export function cloudVolumeMarchSize(width: number, height: number, history: boolean): [number, number] {
  return history ? [Math.ceil(width / 2), Math.ceil(height / 2)] : [width, height];
}

/** Texels of the layer's target along each edge of one quad of the composite (`cloudVolumeTiles`). */
export const CLOUD_VOLUME_TILE = 8;

/** Tiles of the composite across and down a layer target of `width` × `height` texels. */
export function cloudVolumeTiles(width: number, height: number): [number, number] {
  return [Math.ceil(width / CLOUD_VOLUME_TILE), Math.ceil(height / CLOUD_VOLUME_TILE)];
}

/**
 * The inverse of the matrix whose columns are a view's rays scaled to depth 1 along the view (`center`, and `right`
 * and `up` for half the screen's width and height): it takes a point relative to the eye to (depth along the view,
 * x · depth, y · depth), x and y the point's place on the screen from −1 to 1. Nine numbers, column by column; null
 * for rays that span no volume.
 */
export function cloudVolumeScreenBasis(center: Vec3, right: Vec3, up: Vec3): number[] | null {
  const [a, b, c] = center;
  const [d, e, f] = right;
  const [g, h, i] = up;
  // Columns center, right, up: m = [[a, d, g], [b, e, h], [c, f, i]] (rows).
  const A = e * i - f * h;
  const B = -(b * i - c * h);
  const C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (!(Math.abs(det) > 1e-12)) return null;
  const k = 1 / det;
  // Rows of the inverse (each the cofactors of a column, transposed), stored column by column.
  const r0 = [A * k, -(d * i - g * f) * k, (d * h - g * e) * k];
  const r1 = [B * k, (a * i - g * c) * k, -(a * h - g * b) * k];
  const r2 = [C * k, -(a * f - d * c) * k, (a * e - d * b) * k];
  return [r0[0]!, r1[0]!, r2[0]!, r0[1]!, r1[1]!, r2[1]!, r0[2]!, r1[2]!, r2[2]!];
}

/**
 * Where the point at `distanceM` along the unit `dir` from the eye lay on the screen of an earlier frame: [x, y] from −1
 * to 1, or null behind that frame's eye. `inverse` is that frame's `cloudVolumeScreenBasis`, `moved` how far the eye
 * has moved since (now − then). For a cloud that has drifted by `drift` since, pass `moved − drift`.
 */
export function cloudVolumeReproject(inverse: readonly number[], moved: Vec3, dir: Vec3, distanceM: number): [number, number] | null {
  const p = [moved[0] + dir[0] * distanceM, moved[1] + dir[1] * distanceM, moved[2] + dir[2] * distanceM];
  const m = inverse;
  const depth = m[0]! * p[0]! + m[3]! * p[1]! + m[6]! * p[2]!;
  if (!(depth > 1e-6)) return null;
  const x = m[1]! * p[0]! + m[4]! * p[1]! + m[7]! * p[2]!;
  const y = m[2]! * p[0]! + m[5]! * p[1]! + m[8]! * p[2]!;
  return [x / depth, y / depth];
}

/**
 * How a depth value of the main target turns into the distance along the view, for the shader: [kind, a, b, scale].
 * Kind 1 reversed depth and 2 standard depth (the clip depth is a + b / w, the distance w · scale), 3 logarithmic
 * (`logScale` of `depthViewProj`), 0 none. `viewProj` is the frame's world → clip matrix, column-major.
 */
export function cloudVolumeDepthMap(mode: 'standard' | 'reversed' | 'logarithmic', viewProj: ArrayLike<number>, logScale: number): [number, number, number, number] {
  if (mode === 'logarithmic') return logScale > 0 ? [3, 0, 0, logScale] : [0, 0, 0, 0];
  const m = viewProj;
  // Clip z = a · w + b over every point when the z row is parallel to the w row (a perspective matrix).
  const wx = m[3]!;
  const wy = m[7]!;
  const wz = m[11]!;
  const ww = wx * wx + wy * wy + wz * wz;
  if (!(ww > 0)) return [0, 0, 0, 0];
  const a = (m[2]! * wx + m[6]! * wy + m[10]! * wz) / ww;
  const b = m[14]! - a * m[15]!;
  return [mode === 'reversed' ? 1 : 2, a, b, 1 / Math.sqrt(ww)];
}

/** The distance along the view of a depth value under a `cloudVolumeDepthMap`: Infinity where nothing was drawn. */
export function cloudVolumeDepthDistance(depth: number, map: readonly [number, number, number, number]): number {
  const [kind, a, b, scale] = map;
  if (kind === 3) return depth >= 0.999999 ? Infinity : 2 ** (depth / scale) - 1;
  if (kind === 1 ? depth <= 0 : depth >= 0.9999999) return Infinity;
  const ndc = kind === 2 ? depth * 2 - 1 : depth;
  return kind === 0 ? Infinity : (b / (ndc - a)) * scale;
}

/**
 * Whether the history of the last frame still fits the view: not after a cut (the view turned by more than 30°,
 * `turnCos` the cosine of the turn) or a jump (the eye moved by more than a quarter of its distance to the layer,
 * `layerDistanceM`, 0 inside it, and by at least 100 m).
 */
export function cloudVolumeKeepHistory(movedM: number, layerDistanceM: number, turnCos: number): boolean {
  return turnCos > Math.cos(Math.PI / 6) && movedM <= Math.max(0.25 * layerDistanceM, 100);
}

/**
 * GLSL of the model (after `<header>`): `cloudVolumeProfile`, `cloudVolumeTypedProfile`, `cloudVolumeRainCover`,
 * `cloudVolumeRainShape`, `cloudVolumeThreshold`,
 * `cloudVolumeDensity`, `cloudVolumeSpan` (with the layer's uniforms `u_cvRef`: xyz the reference point in render
 * space, w the sphere's radius or 0; `u_cvSlab`: x base, y top, z extinction per metre, w farthest distance),
 * `cloudVolumeNearShare` (`u_cvFar`: x, y the hand-over distances, z the volume's weight), `cloudVolumeJitter`,
 * `cloudVolumeReproject` and `cloudVolumeDepthDistance`.
 */
export const CLOUD_VOLUME_GLSL = /* glsl */ `
uniform vec4 u_cvRef;
uniform vec4 u_cvSlab;
uniform vec4 u_cvFar; // x, y distances over which the volume hands the clouds to a far layer, z the volume's weight
// The height in the layer (0–1) where the clouds of a type end: lower for a deck (less so where it rains), the
// layer's top for a tall type.
float cloudVolumeTypedTop(float deck, float tall, float rain) {
  float deckTop = ${g(DECK_TOP)} + ${(RAIN_DECK_TOP - DECK_TOP).toFixed(2)} * clamp(rain, 0.0, 1.0);
  return 1.0 - (1.0 - deckTop) * clamp(deck, 0.0, 1.0) * (1.0 - clamp(tall, 0.0, 1.0));
}
float cloudVolumeTypedProfile(float h, float deck, float tall, float rain) {
  float k = clamp(tall, 0.0, 1.0);
  float top = cloudVolumeTypedTop(deck, tall, rain);
  float fall = (${g(TOP_FALL)} + ${g(TALL_FALL - TOP_FALL)} * k) * top;
  return smoothstep(0.0, ${g(BASE_RISE)}, h) * (1.0 - smoothstep(fall, top, h));
}
// The cover closed toward 1 by the precipitation of the place (cloudVolumeRainCover).
float cloudVolumeRainCover(float cover, float rain) {
  return cover <= 0.0 ? 0.0 : clamp(cover + (1.0 - cover) * sqrt(clamp(rain, 0.0, 1.0)), 0.0, 1.0);
}
// The shape filled up where it rains (the square root of rain): a raining cloud has no holes.
float cloudVolumeRainShape(float shape, float rain) {
  return mix(shape, max(shape, ${g(RAIN_SHAPE_FLOOR)}), sqrt(clamp(rain, 0.0, 1.0)));
}
float cloudVolumeProfile(float h, float cover) {
  return cloudVolumeTypedProfile(h, smoothstep(${g(DECK_FROM)}, ${g(DECK_TO)}, cover), 0.0, 0.0);
}
// The volume's share of the clouds at a distance along a view ray (cloudVolumeNearShare with u_cvFar).
float cloudVolumeNearShare(float d) {
  return u_cvFar.z * (1.0 - smoothstep(u_cvFar.x, u_cvFar.y, d));
}
float cloudVolumeThreshold(float cover) {
  return ${g(THRESHOLD_CLEAR)} + ${g(THRESHOLD_FULL - THRESHOLD_CLEAR)} * clamp(cover, 0.0, 1.0);
}
// The density before the erosion: x the density 0–1, y the cover moved by the wide lookup.
vec2 cloudVolumeBase(float shape, float wide, float cover, float h, float wideCover) {
  float c = clamp(cover + (wide - 0.5) * wideCover, 0.0, 1.0);
  if (cover <= 0.0 || c <= 0.0) return vec2(0.0, c);
  float t = cloudVolumeThreshold(c);
  return vec2(clamp((shape * cloudVolumeProfile(h, c) - t) / (1.0 - t), 0.0, 1.0), c);
}
float cloudVolumeErode(float base, float detail, float erosion) {
  float lo = detail * erosion;
  return clamp((base - lo) / (1.0 - lo), 0.0, 1.0);
}
float cloudVolumeDensity(float shape, float wide, float detail, float cover, float h, float wideCover, float erosion) {
  float b = cloudVolumeBase(shape, wide, cover, h, wideCover).x;
  return b > 0.0 ? cloudVolumeErode(b, detail, erosion) : 0.0;
}
// Height above the ground of a point relative to the reference point.
float cloudVolumeHeight(vec3 rel) {
  return u_cvRef.w > 0.0 ? length(rel) - u_cvRef.w : rel.y;
}
// (t0, t1, gap0, gap1) of a ray from e (relative to the reference point) along the unit direction dir.
vec4 cloudVolumeSpan(vec3 e, vec3 dir) {
  float R = u_cvRef.w;
  float tMax = u_cvSlab.w;
  if (R > 0.0) {
    float r0 = length(e);
    float b = dot(e, dir);
    float rt = R + u_cvSlab.y;
    float dt = b * b - (r0 - rt) * (r0 + rt);
    if (dt <= 0.0) return vec4(1.0, 0.0, 0.0, 0.0);
    float st = sqrt(dt);
    float t0 = max(-b - st, 0.0);
    float t1 = -b + st;
    float g0 = 0.0;
    float g1 = 0.0;
    float dg = b * b - (r0 - R) * (r0 + R);
    float ground = dg > 0.0 && -b - sqrt(dg) > 0.0 ? -b - sqrt(dg) : 1e30;
    float rb = R + u_cvSlab.x;
    float db = b * b - (r0 - rb) * (r0 + rb);
    if (db > 0.0) {
      float sb = sqrt(db);
      if (r0 < rb) t0 = max(t0, -b + sb);
      else if (-b - sb > 0.0) {
        if (ground < 1e30) t1 = min(t1, -b - sb);
        else {
          g0 = -b - sb;
          g1 = -b + sb;
        }
      }
    }
    return vec4(t0, min(min(t1, ground), tMax), g0, g1);
  }
  float h = e.y;
  if (abs(dir.y) < 1e-6) return h > u_cvSlab.x && h < u_cvSlab.y ? vec4(0.0, tMax, 0.0, 0.0) : vec4(1.0, 0.0, 0.0, 0.0);
  float ta = (u_cvSlab.x - h) / dir.y;
  float tb = (u_cvSlab.y - h) / dir.y;
  return vec4(max(min(ta, tb), 0.0), min(max(ta, tb), tMax), 0.0, 0.0);
}
float cloudVolumeJitter(vec2 pixel, float frameIndex) {
  return fract(fract(52.9829189 * fract(0.06711056 * pixel.x + 0.00583715 * pixel.y)) + frameIndex * 0.618034);
}
// Where the point at distance d along dir lay on an earlier frame's screen: xy from −1 to 1, z its depth along that
// frame's view (0 or less: behind its eye).
vec3 cloudVolumeReproject(mat3 inverse, vec3 moved, vec3 dir, float d) {
  vec3 a = inverse * (moved + dir * d);
  return vec3(a.yz / max(a.x, 1e-6), a.x);
}
// The distance along the view of a depth value of the main target (cloudVolumeDepthMap); 1e30 where nothing was drawn.
float cloudVolumeDepthDistance(float depth, vec4 map) {
  if (map.x > 2.5) return depth >= 0.999999 ? 1e30 : exp2(depth / map.w) - 1.0;
  if (map.x < 0.5 || (map.x < 1.5 ? depth <= 0.0 : depth >= 0.9999999)) return 1e30;
  float ndc = map.x > 1.5 ? depth * 2.0 - 1.0 : depth;
  return map.z / (ndc - map.y) * map.w;
}
`;
