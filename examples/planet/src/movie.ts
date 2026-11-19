// The movie of the planet example: a hands-off show of the planet in a few shots, looping. Every shot is data (a
// kind, its length, its fades and what it asks of the light) turned into a pose that is a pure function of the time
// since the start of the shot: where the eye is, where it looks, the hour and the animation time of the clouds. The
// places come from the seed (the start place of `findStart`, a dry summit under the clouds, a raining deck, broken cloud), and
// the hour of each shot is solved from the height of the sun it asks for, so the light is the same on every run and
// for every seed.
//
// Inside a shot the eye moves on smooth curves: its speed eases in and out with no step (`glide`), and over the
// ground it keeps above an envelope of the ground along its path, widened and smoothed so the height does not follow
// every bump. Between shots there are cuts, softened by a fade through black where a shot asks for one.

import type { Vec3 } from 'wallhammer-web/base';
import { sphereSunDirection } from 'wallhammer-web/env';
import { flightPose } from './flight.ts';
import { directionAt, findSeaPlaces, findStart, groundHeight, latLonOf } from './world.ts';

/** What the movie needs of the page: the planet, its ground and its weather. */
export interface MovieWorld {
  seed: number;
  radiusM: number;
  /** Height of the top (the whole sphere in view), in metres. */
  topM: number;
  dayOfYear: number;
  /** Height of the visible surface above the base sphere under a unit direction, in metres. */
  groundAt(dir: Vec3): number;
  /** Height of the ground itself, the sea floor included (negative under the sea); default the plain generator's. */
  floorAt?(dir: Vec3): number;
  /** The weather at a place at an animation time; null without clouds. */
  weatherAt(dir: Vec3, groundM: number, timeS: number): { cloudCover: number; precipitation: number; precipitationKind: string } | null;
}

/** One shot of the movie as data. `sunDeg` is the height of the sun the shot asks for at its place. */
export type ShotSpec =
  | { key: string; kind: 'limb'; seconds: number; fadeInS: number; fadeOutS: number; heightM: number; riseDeg: number }
  | { key: string; kind: 'descent'; seconds: number; fadeInS: number; fadeOutS: number; lowM: number; sunDeg: number; turnDeg: number }
  | { key: string; kind: 'valley'; seconds: number; fadeInS: number; fadeOutS: number; clearM: number; lengthM: number; sunDeg: number }
  | { key: string; kind: 'peak'; seconds: number; fadeInS: number; fadeOutS: number; radiusM: number; arcDeg: number; clearM: number; sunDeg: number }
  | { key: string; kind: 'sea'; seconds: number; fadeInS: number; fadeOutS: number; depthM: number; lengthM: number; sunDeg: number; upDeg: number }
  | { key: string; kind: 'rain'; seconds: number; fadeInS: number; fadeOutS: number; eyeM: number; lengthM: number; sunDeg: number }
  | { key: string; kind: 'rise'; seconds: number; fadeInS: number; fadeOutS: number; lowM: number; sunDeg: number; sunEndDeg: number; driftM: number };

/**
 * The shots in order (about 90 s), the loop closing from orbit back to the limb:
 * - limb: sunrise over the edge of the planet from 45 km, the sun climbing out of the air;
 * - descent: from the top down to the start place in the morning, the view turning from the sphere to the horizon;
 * - valley: a low sweep over the start place in the morning sun, toward its high ground or the sea;
 * - sea: a glide a few metres under the moving surface over the sand of a shallow sea, then a tilt up toward the sun
 *   and the window of the surface;
 * - peak: part of an orbit round a summit under a clear sky in the afternoon, the sun on the slope in view;
 * - rain: a slow walk under a raining deck;
 * - rise: up from under broken cloud through the deck to orbit at sunset, the terminator across the sphere.
 */
export const MOVIE_SHOTS: readonly ShotSpec[] = [
  { key: 'limb', kind: 'limb', seconds: 10, fadeInS: 1.2, fadeOutS: 0.5, heightM: 45_000, riseDeg: 5 },
  { key: 'descent', kind: 'descent', seconds: 14, fadeInS: 0.5, fadeOutS: 0.4, lowM: 220, sunDeg: 24, turnDeg: 40 },
  { key: 'valley', kind: 'valley', seconds: 12, fadeInS: 0.4, fadeOutS: 0.4, clearM: 40, lengthM: 1400, sunDeg: 26 },
  { key: 'sea', kind: 'sea', seconds: 10, fadeInS: 0.4, fadeOutS: 0.4, depthM: 3, lengthM: 18, sunDeg: 50, upDeg: 52 },
  { key: 'peak', kind: 'peak', seconds: 11, fadeInS: 0.4, fadeOutS: 0.4, radiusM: 2800, arcDeg: 55, clearM: 140, sunDeg: 32 },
  { key: 'rain', kind: 'rain', seconds: 8, fadeInS: 0.4, fadeOutS: 0.4, eyeM: 5, lengthM: 36, sunDeg: 30 },
  { key: 'rise', kind: 'rise', seconds: 24, fadeInS: 0.4, fadeOutS: 1.2, lowM: 120, sunDeg: 10, sunEndDeg: 3, driftM: 3500 },
];

/**
 * Highest top the peak shot takes, in metres. Above about two scale heights of the example's air (2.4 km each) the
 * sky over a summit turns dark blue with stars even at noon: a true picture of thin air, but it reads as night.
 */
export const MOVIE_PEAK_MAX_M = 1300;

/** Animation time of the clouds in the middle of every shot, in seconds: the places are searched at it. */
export const MOVIE_CLOUD_TIME_S = 600;

/** Where the eye is and where it looks, the hour (universal time) and the animation time. */
export interface ShotPose {
  eye: Vec3;
  /** Unit direction of the view. */
  look: Vec3;
  hour: number;
  timeS: number;
}

export interface MovieShot {
  key: string;
  seconds: number;
  fadeInS: number;
  fadeOutS: number;
  /** Latitude and longitude of the shot's place, in degrees. */
  place: [number, number];
  /** The pose `u` seconds into the shot (clamped to the shot). */
  pose(u: number): ShotPose;
}

export interface Movie {
  shots: MovieShot[];
  /** Seconds of one pass; the movie loops. */
  seconds: number;
}

export interface MovieFrame extends ShotPose {
  /** Index of the shot and seconds into it. */
  shot: number;
  u: number;
  /** Share of black over the picture, 0–1 (the fades). */
  dark: number;
}

// --- Small tools --------------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** North and east in the horizon of the unit direction `d` (away from the poles). */
function horizonAxes(d: Vec3): { north: Vec3; east: Vec3 } {
  const [lat, lon] = latLonOf(d);
  const north = directionAt(lat + 90, lon);
  return { north, east: cross(d, north) };
}

/** The direction `m` metres from `d` along the bearing `a` (radians from north toward east) on a sphere of `radiusM`. */
function stepFrom(d: Vec3, a: number, m: number, radiusM: number): Vec3 {
  const { north, east } = horizonAxes(d);
  const c = Math.cos(m / radiusM);
  const s = Math.sin(m / radiusM);
  const h: Vec3 = [north[0] * Math.cos(a) + east[0] * Math.sin(a), north[1] * Math.cos(a) + east[1] * Math.sin(a), north[2] * Math.cos(a) + east[2] * Math.sin(a)];
  return normalize([d[0] * c + h[0] * s, d[1] * c + h[1] * s, d[2] * c + h[2] * s]);
}

/** Bearing of a world direction `v` seen from the place `d`, in radians from north toward east. */
function bearingOf(d: Vec3, v: Vec3): number {
  const { north, east } = horizonAxes(d);
  return Math.atan2(dot(v, east), dot(v, north));
}

/** Unit view direction at `d` along the bearing `a` (radians), `pitchDeg` under the horizon. */
function viewAlong(d: Vec3, a: number, pitchDeg: number): Vec3 {
  const { north, east } = horizonAxes(d);
  const cp = Math.cos(pitchDeg * DEG);
  const sp = Math.sin(pitchDeg * DEG);
  return normalize([(north[0] * Math.cos(a) + east[0] * Math.sin(a)) * cp - d[0] * sp, (north[1] * Math.cos(a) + east[1] * Math.sin(a)) * cp - d[1] * sp, (north[2] * Math.cos(a) + east[2] * Math.sin(a)) * cp - d[2] * sp]);
}

/**
 * Share of the way at `x` (0–1) for a move whose speed rises from `v0` of its cruise to all of it over the first `r`
 * of the time (a half cosine, so no step in the speed) and falls the same way at the end. `v0` 0 starts and stops at
 * rest; above 0 the camera is already moving when the shot cuts in.
 */
export function glide(x: number, r: number, v0: number): number {
  const t = clamp01(x);
  const ramp = (y: number): number => v0 * y + (1 - v0) * (y / 2 - (r / (2 * Math.PI)) * Math.sin((Math.PI * y) / r));
  const area = 1 - (1 - v0) * r;
  const s = t < r ? ramp(t) : t > 1 - r ? area - ramp(1 - t) : ramp(r) + (t - r);
  return s / area;
}

/** Height of the sun at the place `d` at the hour `hour` (UT), in degrees. */
function sunHeightDeg(day: number, d: Vec3, hour: number): number {
  return Math.asin(Math.max(-1, Math.min(1, dot(sphereSunDirection(day, hour), d)))) / DEG;
}

/** Bearing of the sun at `d` at `hour`, in radians. */
function sunBearing(day: number, d: Vec3, hour: number): number {
  return bearingOf(d, sphereSunDirection(day, hour));
}

/**
 * The hour (UT) at which the sun stands `deg` high at `d`, rising (morning) or setting (evening). Where the sun never
 * reaches that height the hour of its nearest approach on the right side of the day.
 */
function hourOfSun(day: number, d: Vec3, deg: number, rising: boolean): number {
  const STEP = 0.05;
  let best = 0;
  let bestMiss = Infinity;
  for (let h = 0; h < 24; h += STEP) {
    const a = sunHeightDeg(day, d, h) - deg;
    const b = sunHeightDeg(day, d, h + STEP) - deg;
    const up = b > a;
    if (up !== rising) continue;
    if (a <= 0 !== b <= 0) {
      let lo = h;
      let hi = h + STEP;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (sunHeightDeg(day, d, mid) - deg <= 0 === a <= 0) lo = mid;
        else hi = mid;
      }
      return ((lo + hi) / 2) % 24;
    }
    if (Math.abs(a) < bestMiss) {
      bestMiss = Math.abs(a);
      best = h;
    }
  }
  return best;
}

/** Degrees per hour the sun's height changes at `d` around `hour`. */
function sunRate(day: number, d: Vec3, hour: number): number {
  return (sunHeightDeg(day, d, hour + 0.01) - sunHeightDeg(day, d, hour - 0.01)) / 0.02;
}

/** Angle between two bearings, 0–π. */
const bearingGap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/**
 * Of the morning and the evening hour that put the sun `deg` high at `d`, the one whose sun stands nearest to
 * `wantGap` radians off the view's bearing `view` (light from the side and a little ahead looks best low over land).
 */
function hourFacing(day: number, d: Vec3, deg: number, view: number, wantGap: number): number {
  const morning = hourOfSun(day, d, deg, true);
  const evening = hourOfSun(day, d, deg, false);
  const miss = (h: number): number => Math.abs(bearingGap(sunBearing(day, d, h), view) - wantGap);
  return miss(morning) <= miss(evening) ? morning : evening;
}

/**
 * Height above the base sphere that keeps `clearM` over the ground along a path `dirAt(s)`, s 0–1, as a smooth curve:
 * the ground is sampled, each sample takes the highest ground within four samples on either side, and the result is
 * smoothed over three samples (narrower than the four, so it never sinks under the ground it was taken from). Sea
 * counts as level 0.
 */
function clearCurve(w: MovieWorld, dirAt: (s: number) => Vec3, clearM: number, n = 96): (s: number) => number {
  const g: number[] = [];
  for (let i = 0; i <= n; i++) g.push(Math.max(0, w.groundAt(dirAt(i / n))));
  let e = g.map((_, i) => {
    let m = -Infinity;
    for (let j = Math.max(0, i - 4); j <= Math.min(n, i + 4); j++) m = Math.max(m, g[j]!);
    return m;
  });
  for (let pass = 0; pass < 3; pass++) e = e.map((v, i) => (e[Math.max(0, i - 1)]! + 2 * v + e[Math.min(n, i + 1)]!) / 4);
  return (s: number): number => {
    const x = clamp01(s) * n;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i;
    const p0 = e[Math.max(0, i - 1)]!;
    const p1 = e[i]!;
    const p2 = e[i + 1]!;
    const p3 = e[Math.min(n, i + 2)]!;
    // Catmull–Rom: through the samples with a continuous slope.
    const v = 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);
    return Math.max(v, Math.min(p1, p2)) + clearM;
  };
}

/** Points of a fixed lattice over the sphere (a golden spiral), away from the poles. */
function* lattice(n: number, maxY = 0.7): Generator<Vec3> {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    if (Math.abs(y) > maxY) continue;
    const r = Math.sqrt(1 - y * y);
    yield [Math.cos(golden * i) * r, y, Math.sin(golden * i) * r];
  }
}

// --- Places ---------------------------------------------------------------------------------------------------------
interface Places {
  /** The start place of `findStart` and the point it looks at. */
  start: Vec3;
  toward: Vec3;
  /** The highest summit no higher than `MOVIE_PEAK_MAX_M` under a cover below 0.35. */
  peak: Vec3;
  /** Low land under a raining deck, or the start place without one. */
  rain: Vec3;
  /** Low land under broken cloud (cover about 0.5), or the start place without one. */
  broken: Vec3;
}

/** Up the slope from `d` (ground `g`) in steps of 300 m while the ground rises: the top it reaches, or null above `maxM`. */
function climb(w: MovieWorld, d: Vec3, g: number, maxM: number): { d: Vec3; g: number } | null {
  for (let i = 0; i < 40; i++) {
    let next: Vec3 | null = null;
    for (let k = 0; k < 8; k++) {
      const e = stepFrom(d, (k * Math.PI) / 4, 300, w.radiusM);
      const h = w.groundAt(e);
      if (h > g) {
        g = h;
        next = e;
      }
    }
    if (!next) break;
    if (g > maxM) return null;
    d = next;
  }
  return { d, g };
}

function findPlaces(w: MovieWorld): Places {
  const found = findStart(w.seed);
  const start = directionAt(found.latDeg, found.lonDeg);
  const t = MOVIE_CLOUD_TIME_S;
  const dry: { d: Vec3; g: number }[] = [];
  let rain: Vec3 | null = null;
  let broken: Vec3 | null = null;
  for (const d of lattice(3000)) {
    const g = w.groundAt(d);
    const weather = w.weatherAt(d, g, t);
    if (g > 0 && g <= MOVIE_PEAK_MAX_M && (!weather || weather.cloudCover < 0.35)) dry.push({ d, g });
    if (g < 20 || g > 600 || !weather) continue;
    if (!rain && weather.precipitation > 0.45 && weather.precipitationKind === 'rain') rain = d;
    if (!broken && Math.abs(weather.cloudCover - 0.5) < 0.04) broken = d;
  }
  // Every dry place climbed to its top (steps of 300 m while the ground rises); of the tops under the cap the one
  // that stands highest over the ground 3 km round it is the peak: a real summit that rises out of its land, not a
  // shoulder of a higher mountain or the crown of a broad dome.
  let peak = start;
  let best = -Infinity;
  for (const c of dry) {
    const top = climb(w, c.d, c.g, MOVIE_PEAK_MAX_M);
    if (!top) continue;
    const there = w.weatherAt(top.d, top.g, t);
    if (there && there.cloudCover >= 0.35) continue;
    let ring = 0;
    for (let k = 0; k < 8; k++) ring += Math.max(0, w.groundAt(stepFrom(top.d, (k * Math.PI) / 4, 3000, w.radiusM))) / 8;
    if (top.g - ring > best) {
      best = top.g - ring;
      peak = top.d;
    }
  }
  return { start, toward: found.toward, peak, rain: rain ?? start, broken: broken ?? start };
}

// --- Shots ----------------------------------------------------------------------------------------------------------
type Build = (spec: never, w: MovieWorld, p: Places) => { place: Vec3; pose: (u: number) => ShotPose };

/** Animation time `u` seconds into a shot of `seconds`: the clouds' time of the search in its middle. */
const cloudTime = (u: number, seconds: number): number => MOVIE_CLOUD_TIME_S + u - seconds / 2;
const at = (d: Vec3, r: number): Vec3 => scale(d, r);

const BUILD: Record<ShotSpec['kind'], Build> = {
  // From high up toward the sun just under the limb; it climbs `riseDeg` out of the air, the view panning a little.
  limb: ((s: Extract<ShotSpec, { kind: 'limb' }>, w: MovieWorld, p: Places) => {
    const R = w.radiusM;
    const d0 = p.start;
    const dipDeg = Math.acos(R / (R + s.heightM)) / DEG;
    // The sun at the eye's horizon stands `dipDeg` under the horizon of the ground below.
    const hour0 = hourOfSun(w.dayOfYear, d0, -dipDeg - 3, true);
    const rate = Math.max(5, sunRate(w.dayOfYear, d0, hour0));
    const hoursPerS = s.riseDeg / rate / s.seconds;
    const sunA = sunBearing(w.dayOfYear, d0, hour0);
    return {
      place: d0,
      pose: (u: number) => {
        const x = clamp01(u / s.seconds);
        const k = glide(x, 0.35, 0.3);
        const d = stepFrom(d0, sunA, 3000 * k, R);
        const ground = Math.max(0, w.groundAt(d0));
        return { eye: at(d, R + ground + s.heightM), look: viewAlong(d, sunA - 14 * DEG + 22 * DEG * k, dipDeg - 7), hour: hour0 + hoursPerS * u, timeS: cloudTime(u, s.seconds) };
      },
    };
  }) as Build,

  // The way down of the flight (flight.ts) from the top to `lowM` over the start place.
  descent: ((s: Extract<ShotSpec, { kind: 'descent' }>, w: MovieWorld, p: Places) => {
    const d = p.start;
    const ground = Math.max(0, w.groundAt(d));
    const plan = { lowM: s.lowM, highM: w.topM, climbS: s.seconds, holdS: 0, turnDeg: s.turnDeg, lowPitchDeg: 4 };
    const heading = bearingOf(d, normalize([p.toward[0] - d[0], p.toward[1] - d[1], p.toward[2] - d[2]]));
    const hour0 = hourOfSun(w.dayOfYear, d, s.sunDeg, true);
    return {
      place: d,
      pose: (u: number) => {
        const f = flightPose(plan, w.radiusM, s.seconds + clamp01(u / s.seconds) * s.seconds);
        return { eye: at(d, w.radiusM + ground + f.heightM), look: viewAlong(d, heading + f.turnDeg * DEG, Math.min(89.5, f.pitchDeg)), hour: hour0 + 0.02 * u, timeS: cloudTime(u, s.seconds) };
      },
    };
  }) as Build,

  // Low and level over the start place toward its high ground or the sea, the morning sun from the side and behind.
  valley: ((s: Extract<ShotSpec, { kind: 'valley' }>, w: MovieWorld, p: Places) => {
    const R = w.radiusM;
    const heading = bearingOf(p.start, normalize([p.toward[0] - p.start[0], p.toward[1] - p.start[1], p.toward[2] - p.start[2]]));
    const from = stepFrom(p.start, heading + Math.PI, 0.35 * s.lengthM, R);
    const dirAt = (k: number): Vec3 => stepFrom(from, heading, k * s.lengthM, R);
    const height = clearCurve(w, dirAt, s.clearM);
    const hour0 = hourFacing(w.dayOfYear, p.start, s.sunDeg, heading, 115 * DEG);
    return {
      place: p.start,
      pose: (u: number) => {
        const x = clamp01(u / s.seconds);
        const k = glide(x, 0.3, 0.35);
        const d = dirAt(k);
        return { eye: at(d, R + height(k)), look: viewAlong(d, heading - 8 * DEG + 16 * DEG * k, 2.5 + 1.5 * k), hour: hour0 - 0.006 * u, timeS: cloudTime(u, s.seconds) };
      },
    };
  }) as Build,

  // Part of an orbit round the peak, looking at a point under its top; the sun from the side and a little behind the
  // eye, so the slope in view lies in the light.
  peak: ((s: Extract<ShotSpec, { kind: 'peak' }>, w: MovieWorld, p: Places) => {
    const R = w.radiusM;
    const top = p.peak;
    const topM = w.groundAt(top);
    const hour0 = hourOfSun(w.dayOfYear, top, s.sunDeg, false);
    // The view in the middle of the arc looks 130° off the sun's bearing; the eye stands opposite the view.
    const view = sunBearing(w.dayOfYear, top, hour0) + 130 * DEG;
    const a0 = view + Math.PI - (s.arcDeg / 2) * DEG;
    const dirAt = (k: number): Vec3 => stepFrom(top, a0 + s.arcDeg * DEG * k, s.radiusM, R);
    const height = clearCurve(w, dirAt, s.clearM);
    const aim = at(top, R + topM - 250);
    return {
      place: top,
      pose: (u: number) => {
        const k = glide(clamp01(u / s.seconds), 0.3, 0.4);
        const d = dirAt(k);
        const eye = at(d, R + Math.max(height(k), topM - 350));
        return { eye, look: normalize([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]]), hour: hour0 + 0.004 * u, timeS: cloudTime(u, s.seconds) };
      },
    };
  }) as Build,

  // Under the sea at the shallow place of `findSeaPlaces`: a slow glide `depthM` under the level toward the rising
  // floor, the view level over the sand, then tilting `upDeg` up and turning toward the sun to the window of the
  // surface. The eye keeps at least 1.5 m over the floor and 1.6 m under the level (under the troughs). Without a
  // shallow sea the same glide 40 m over the start place.
  sea: ((s: Extract<ShotSpec, { kind: 'sea' }>, w: MovieWorld, p: Places) => {
    const R = w.radiusM;
    const place = findSeaPlaces(w.seed).shallow;
    const d0 = place ? directionAt(place.latDeg, place.lonDeg) : p.start;
    const toward = place ? place.toward : p.toward;
    const heading = bearingOf(d0, normalize([toward[0] - d0[0], toward[1] - d0[1], toward[2] - d0[2]]));
    const dirAt = (k: number): Vec3 => stepFrom(d0, heading, k * s.lengthM, R);
    const floor = (d: Vec3): number => (w.floorAt ? w.floorAt(d) : groundHeight(w.seed, d[0] * R, d[1] * R, d[2] * R));
    let high = -Infinity;
    for (let i = 0; i <= 24; i++) high = Math.max(high, floor(dirAt(i / 24)));
    const height = place ? Math.min(-1.6, Math.max(-s.depthM, high + 1.5)) : Math.max(0, high) + 40;
    // The sun ahead and a little to the side, as high as asked (or as high as it gets).
    const hour0 = hourFacing(w.dayOfYear, d0, s.sunDeg, heading, 25 * DEG);
    const sunA = sunBearing(w.dayOfYear, d0, hour0);
    const turn = Math.atan2(Math.sin(sunA - heading), Math.cos(sunA - heading));
    return {
      place: d0,
      pose: (u: number) => {
        const x = clamp01(u / s.seconds);
        const k = glide(x, 0.3, 0.4);
        const d = dirAt(k);
        const up = smooth(0.4, 0.95, x);
        return { eye: at(d, R + height), look: viewAlong(d, heading + turn * up, 6 - (6 + s.upDeg) * up), hour: hour0, timeS: cloudTime(u, s.seconds) };
      },
    };
  }) as Build,

  // A few steps under a raining deck, looking a little up into the rain.
  rain: ((s: Extract<ShotSpec, { kind: 'rain' }>, w: MovieWorld, p: Places) => {
    const R = w.radiusM;
    const d0 = p.rain;
    // Toward the highest of eight points 3 km away.
    let heading = 0;
    let best = -Infinity;
    for (let k = 0; k < 8; k++) {
      const g = w.groundAt(stepFrom(d0, (k * Math.PI) / 4, 3000, R));
      if (g > best) {
        best = g;
        heading = (k * Math.PI) / 4;
      }
    }
    const dirAt = (k: number): Vec3 => stepFrom(d0, heading, k * s.lengthM, R);
    const height = clearCurve(w, dirAt, s.eyeM, 32);
    const hour0 = hourOfSun(w.dayOfYear, d0, s.sunDeg, true);
    return {
      place: d0,
      pose: (u: number) => {
        const k = glide(clamp01(u / s.seconds), 0.3, 0.3);
        const d = dirAt(k);
        return { eye: at(d, R + height(k)), look: viewAlong(d, heading + 6 * DEG * k, -3 - 3 * k), hour: hour0, timeS: cloudTime(u, s.seconds) };
      },
    };
  }) as Build,

  // From under broken cloud up through the deck to the top, at sunset: the eye looks up at the cloud, levels out above
  // it and turns down to the sphere, the terminator across it at the end.
  rise: ((s: Extract<ShotSpec, { kind: 'rise' }>, w: MovieWorld, p: Places) => {
    const R = w.radiusM;
    const d0 = p.broken;
    const hour0 = hourOfSun(w.dayOfYear, d0, s.sunDeg, false);
    const rate = Math.min(-3, sunRate(w.dayOfYear, d0, hour0));
    const hoursPerS = (s.sunEndDeg - s.sunDeg) / rate / s.seconds;
    // The eye drifts and looks across the sun's bearing.
    const heading = sunBearing(w.dayOfYear, d0, hour0) + 75 * DEG;
    const dirAt = (k: number): Vec3 => stepFrom(d0, heading, k * s.driftM, R);
    const ground = clearCurve(w, dirAt, 0);
    const span = Math.log(w.topM / s.lowM);
    return {
      place: d0,
      pose: (u: number) => {
        const x = clamp01(u / s.seconds);
        const k = glide(x, 0.3, 0);
        // Equal times for equal ratios of height, eased at both ends as the flight is.
        const pr = x * x * x * (x * (6 * x - 15) + 10);
        const h = s.lowM * Math.exp(span * pr);
        const d = dirAt(k);
        const pitch = -16 + 34 * smooth(0.12, 0.45, pr) + 71.5 * smooth(0.55, 1, pr);
        return { eye: at(d, R + ground(k) + h), look: viewAlong(d, heading - 30 * DEG * pr, pitch), hour: hour0 + hoursPerS * u, timeS: cloudTime(u, s.seconds) };
      },
    };
  }) as Build,
};

/** The movie for a world: its places found and every shot turned into its pose. Pure; costs a few thousand ground samples. */
export function planMovie(w: MovieWorld, specs: readonly ShotSpec[] = MOVIE_SHOTS): Movie {
  const places = findPlaces(w);
  const shots = specs.map((spec): MovieShot => {
    const b = (BUILD[spec.kind] as (s: ShotSpec, w: MovieWorld, p: Places) => { place: Vec3; pose: (u: number) => ShotPose })(spec, w, places);
    const [lat, lon] = latLonOf(b.place);
    return { key: spec.key, seconds: spec.seconds, fadeInS: spec.fadeInS, fadeOutS: spec.fadeOutS, place: [lat, lon], pose: (u) => b.pose(Math.min(spec.seconds, Math.max(0, u))) };
  });
  return { shots, seconds: shots.reduce((a, s) => a + s.seconds, 0) };
}

/** Index of the shot at movie time `t` (wrapped into one pass) and the seconds into it. */
export function shotAt(movie: Movie, t: number): { shot: number; u: number } {
  let r = ((t % movie.seconds) + movie.seconds) % movie.seconds;
  for (let i = 0; i < movie.shots.length; i++) {
    const s = movie.shots[i]!;
    if (r < s.seconds || i === movie.shots.length - 1) return { shot: i, u: Math.min(r, s.seconds) };
    r -= s.seconds;
  }
  return { shot: 0, u: 0 };
}

/** Everything of the movie at time `t` seconds since its start (it loops): the pose, the shot and the fade. */
export function movieFrame(movie: Movie, t: number): MovieFrame {
  const { shot, u } = shotAt(movie, t);
  const s = movie.shots[shot]!;
  const fadeIn = s.fadeInS > 0 ? 1 - smooth(0, s.fadeInS, u) : 0;
  const fadeOut = s.fadeOutS > 0 ? smooth(s.seconds - s.fadeOutS, s.seconds, u) : 0;
  return { ...s.pose(u), shot, u, dark: Math.max(fadeIn, fadeOut) };
}

// --- Player ---------------------------------------------------------------------------------------------------------
/** What the player needs of the page. */
export interface MovieHost {
  /** Plans the movie (called once, at the first start). */
  plan(): Movie;
  /** Puts the camera, the hour and the animation time where a frame says; `velocity` in world metres per second. */
  apply(frame: MovieFrame, velocity: Vec3): void;
  /** True once the streaming has drawn everything the view wants. */
  settled(): boolean;
  /** Called when the movie starts (to stop anything else that drives the camera). */
  onStart(): void;
  /** The page's panels, hidden while the movie plays. */
  panels: readonly HTMLElement[];
  /** Letterbox bars to 2.39 : 1 while the movie plays. */
  bars: boolean;
}

/** Longest wait at a cut for the streaming to settle, in ms, while the movie plays by the clock. */
const CUT_WAIT_MS = 5000;

/**
 * Plays a movie by the clock, or holds it at a time a script sets (`hold`). By the clock the time runs in real
 * seconds, at most a tenth of a second per frame; at every cut it waits in black until the streaming has settled at
 * the new place (at most five seconds), so the shot starts with its ground in place. Held, the frame is exactly the
 * movie's pose at that time.
 */
export class MoviePlayer {
  active = false;
  /** Movie time in seconds since the start. */
  t = 0;
  /** True while a script sets the time; the clock does not move it then. */
  held = false;
  private movie: Movie | null = null;
  private lastMs = 0;
  private lastShot = -1;
  private waitFrom = 0;
  private waitFrames = 0;
  private readonly fade: HTMLDivElement;
  private readonly barEls: HTMLDivElement[];
  private readonly shown = new Map<HTMLElement, boolean>();
  private readonly host: MovieHost;

  constructor(host: MovieHost) {
    this.host = host;
    const layer = (css: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.style.cssText = `position:fixed;left:0;right:0;pointer-events:none;background:#000;display:none;${css}`;
      document.body.appendChild(el);
      return el;
    };
    this.barEls = [layer('top:0;height:max(0px, calc((100vh - 100vw / 2.39) / 2))'), layer('bottom:0;height:max(0px, calc((100vh - 100vw / 2.39) / 2))')];
    this.fade = layer('top:0;bottom:0;opacity:0');
  }

  /** The planned movie (planned at the first call). */
  get plan(): Movie {
    return (this.movie ??= this.host.plan());
  }

  /** Seconds of one pass. */
  get seconds(): number {
    return this.plan.seconds;
  }

  start(t = 0): void {
    this.host.onStart();
    this.active = true;
    this.held = false;
    this.t = t;
    this.lastMs = 0;
    this.lastShot = -1;
    for (const p of this.host.panels) {
      if (!this.shown.has(p)) this.shown.set(p, p.style.visibility !== 'hidden');
      p.style.visibility = 'hidden';
    }
    for (const b of this.barEls) b.style.display = this.host.bars ? 'block' : 'none';
    this.fade.style.display = 'block';
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.held = false;
    for (const [p, shown] of this.shown) p.style.visibility = shown ? '' : 'hidden';
    this.shown.clear();
    for (const b of this.barEls) b.style.display = 'none';
    this.fade.style.display = 'none';
  }

  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  /** Holds the movie at time `t` for a script: the clock stops and every frame shows that time. */
  hold(t: number): MovieFrame {
    if (!this.active) this.start(t);
    this.held = true;
    this.t = t;
    return movieFrame(this.plan, t);
  }

  /**
   * Called before every frame: moves the clock, applies the frame and sets the fade. Returns false when the movie is
   * not playing (the page's own controls drive the camera then).
   */
  drive(nowMs: number): boolean {
    if (!this.active) return false;
    const movie = this.plan;
    const waiting = !this.held && this.waitFrom > 0;
    if (!this.held && !waiting && this.lastMs > 0) this.t += Math.min(0.1, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    const f = movieFrame(movie, this.t);
    if (f.shot !== this.lastShot) {
      this.lastShot = f.shot;
      if (!this.held) {
        this.waitFrom = nowMs;
        this.waitFrames = 0;
      }
    }
    // The settled flag of the first frames after a cut is the old place's: wait a few frames before trusting it.
    if (this.waitFrom > 0 && (this.held || (++this.waitFrames > 3 && this.host.settled()) || nowMs - this.waitFrom > CUT_WAIT_MS)) this.waitFrom = 0;
    // The velocity over the next thirtieth of a second of the shot, for the streaming's ticket ahead of the eye.
    const shot = movie.shots[f.shot]!;
    const h = 1 / 30;
    const next = shot.pose(Math.min(shot.seconds, f.u + h)).eye;
    const prev = f.u + h <= shot.seconds ? f.eye : shot.pose(f.u - h).eye;
    const v: Vec3 = [(next[0] - prev[0]) / h, (next[1] - prev[1]) / h, (next[2] - prev[2]) / h];
    this.host.apply(f, v);
    this.fade.style.opacity = String(this.waitFrom > 0 ? 1 : f.dark);
    return true;
  }
}
