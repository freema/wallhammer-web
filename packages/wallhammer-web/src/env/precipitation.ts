// Precipitation in the world round the eye: the model of the drops and flakes, of their landing marks and of the
// ground that follows the weather. Everything is a pure function of its inputs (the weather, the animation time, the
// eye), on the CPU and, for the drops and the marks, in GLSL (`PRECIPITATION_GLSL`); the precipitation layer of
// runtime draws with it.
//
// Drops. The world is split into cubic tiles of `tileM`; every tile holds its own drops, hashed from the tile's
// coordinates, so the drops belong to the world (they stay where they are when the eye moves or turns) and nothing
// repeats. Each drop lives for `lifeS` seconds and then starts again at another place: drop i of a tile in its life k
// starts at a place hashed from (i, k) inside the tile and moves with the fall velocity. The place in a life is the
// start plus the velocity times the age, so a change of wind or of the local down bends the drops smoothly instead of
// moving them. A drop fades in and out at the ends of its life and by its distance from the eye, so none pops. Only
// the tiles a drop of which can be seen are drawn (`precipitationTiles`, on the CPU per tile, never per drop): the
// density is spent where it is seen. Large times are split on the CPU in double (`precipitationClock`), and the tiles
// are handed over relative to the eye.
//
// Landing marks. A surface that faces up is split into cells in the plane of the up axis the eye's up lies nearest to;
// each cell has at most one mark per slot of time, hashed from the cell and the slot, with a start inside the slot and
// a centre inside the cell, so one cell decides a pixel. Every cell runs its slots at a phase of its own, so no two
// cells start their slots together and a still frame at any time shows marks. Cells are counted from a period of 2048 m, so the pattern stays
// the same when the eye (or the render origin) moves.

import type { Vec3 } from '../base/math.ts';
import type { WeatherState } from './environment.ts';

/** How drops or flakes of one kind fall. */
export interface PrecipitationFall {
  /** Speed of the fall in still air, m/s. */
  fallMs: number;
  /** Share of the wind's speed the drops take on across the fall. */
  windShare: number;
  /** The fastest motion across the fall, m/s. */
  maxDriftMs: number;
  /** Life of a drop in seconds; afterwards it starts again at another place. */
  lifeS: number;
  /** How far a flake sways across the fall, metres (0: no sway). */
  swayM: number;
  /** Sways in one life (a whole number). */
  swayCycles: number;
}

/** One range of drops round the eye: tiles of one size and the distances the drops are seen at. */
export interface PrecipitationShell {
  /** Edge of a tile in metres. */
  tileM: number;
  /** Drops per tile at full strength. */
  perTile: number;
  /** Distance from the eye over which the drops fade in, [from, to] in metres. */
  nearM: readonly [number, number];
  /** Distance over which they fade out, [from, to] in metres. */
  farM: readonly [number, number];
  /** Size of the drops against the kind's own (width and length of a streak, radius of a flake). */
  size: number;
  /** Seed of the shell's hashes. */
  seed: number;
}

/** One kind of landing mark: at most one per cell and slot of time. */
export interface PrecipitationImpact {
  /** Edge of a cell in metres; 2048 is a whole number of cells. */
  cellM: number;
  /** Length of a slot of time in seconds, at least `lifeS`. */
  slotS: number;
  /** How long a mark lasts in seconds. */
  lifeS: number;
  /** Largest radius of a mark in metres, at most a third of the cell. */
  radiusM: number;
  /** Share of cells with a mark in a slot at full strength. */
  rate: number;
  /** Seed of the hashes. */
  seed: number;
}

/** Rain: 8.5 m/s, tilted by a third of the wind. */
export const RAIN_FALL: PrecipitationFall = { fallMs: 8.5, windShare: 0.35, maxDriftMs: 4, lifeS: 0.8, swayM: 0, swayCycles: 0 };
/** Snow: 1.2 m/s, carried by most of the wind, swaying. */
export const SNOW_FALL: PrecipitationFall = { fallMs: 1.2, windShare: 0.6, maxDriftMs: 2.5, lifeS: 4, swayM: 0.25, swayCycles: 2 };

/** The ranges of rain: dense near the eye, coarse beyond it. */
export const RAIN_SHELLS: readonly PrecipitationShell[] = [
  { tileM: 8, perTile: 4096, nearM: [0.35, 1.2], farM: [10, 16], size: 1, seed: 7101 },
  { tileM: 24, perTile: 1536, nearM: [10, 16], farM: [40, 64], size: 2.5, seed: 7102 },
];
/** The ranges of snow. */
export const SNOW_SHELLS: readonly PrecipitationShell[] = [
  { tileM: 8, perTile: 3072, nearM: [0.25, 0.9], farM: [8, 14], size: 1, seed: 7111 },
  { tileM: 24, perTile: 1536, nearM: [8, 14], farM: [34, 56], size: 2.2, seed: 7112 },
];

/** The most tiles of one shell drawn in a frame. */
export const PRECIPITATION_MAX_TILES = 160;

/** Rain: short bright splashes, and rings that widen on wet ground. */
export const RAIN_SPLASHES: PrecipitationImpact = { cellM: 0.25, slotS: 0.5, lifeS: 0.14, radiusM: 0.03, rate: 0.9, seed: 7121 };
export const RAIN_RINGS: PrecipitationImpact = { cellM: 0.5, slotS: 1, lifeS: 0.8, radiusM: 0.12, rate: 0.6, seed: 7122 };
/** Snow: soft specks that appear where a flake lands and fade. */
export const SNOW_SPECKS: PrecipitationImpact = { cellM: 0.2, slotS: 2, lifeS: 1.6, radiusM: 0.016, rate: 0.75, seed: 7123 };

/** The period in metres the landing marks repeat with (a whole number of cells of every kind). */
export const PRECIPITATION_IMPACT_PERIOD_M = 2048;

/** Below this strength (precipitation times the share that falls here) nothing is drawn. */
export const PRECIPITATION_MIN = 0.005;

/** Local down at the eye: −y, or toward the centre under radial up. */
export function precipitationDown(eye: Vec3, center: Vec3 | null): Vec3 {
  if (!center) return [0, -1, 0];
  const x = eye[0] - center[0], y = eye[1] - center[1], z = eye[2] - center[2];
  const len = Math.hypot(x, y, z);
  return len > 1e-6 ? [-x / len, -y / len, -z / len] : [0, -1, 0];
}

/**
 * Velocity of the fall in m/s: the fall along `down` and the wind across it. `windX`, `windZ` is the direction the wind
 * blows toward (unit, in the horizontal plane of the world), `windSpeedMs` its speed.
 */
export function precipitationVelocity(fall: PrecipitationFall, down: Vec3, windX: number, windZ: number, windSpeedMs: number): Vec3 {
  const along = windX * down[0] + windZ * down[2];
  let wx = windX - down[0] * along, wy = -down[1] * along, wz = windZ - down[2] * along;
  const len = Math.hypot(wx, wy, wz);
  const drift = Math.min(fall.maxDriftMs, Math.max(0, windSpeedMs) * fall.windShare);
  const k = len > 1e-6 ? drift / len : 0;
  wx *= k;
  wy *= k;
  wz *= k;
  return [down[0] * fall.fallMs + wx, down[1] * fall.fallMs + wy, down[2] * fall.fallMs + wz];
}

/** Drops per tile of a shell at a strength (0–1) and a density (1 the shell's own); fractional, the last one fades in. */
export function precipitationCount(shell: PrecipitationShell, strength: number, density = 1): number {
  return shell.perTile * Math.min(1, Math.max(0, strength)) * Math.max(0, density);
}

/**
 * The tiles of a shell whose drops can be seen, nearest first, at most `max`: per tile its corner relative to the eye
 * (xyz, metres) and its seed (w, a whole number below 2²⁴). A tile counts when the space its drops move through in a
 * life (the tile grown by half the fall of a life and the sway) reaches into the shell's sphere and, given `visible`
 * (a test of a box relative to the eye, such as the view's frustum), into the view. `eyeWorld` in double.
 */
export function precipitationTiles(shell: PrecipitationShell, fall: PrecipitationFall, velocity: Vec3, eyeWorld: Vec3, visible?: (min: Vec3, max: Vec3) => boolean, max = PRECIPITATION_MAX_TILES): number[] {
  const e = shell.tileM;
  const reach = 0.5 * fall.lifeS * Math.hypot(velocity[0], velocity[1], velocity[2]) + fall.swayM;
  const range = shell.farM[1];
  const lo = (v: number): number => Math.floor((v - range - reach) / e);
  const hi = (v: number): number => Math.floor((v + range + reach) / e);
  const found: { d: number; v: [number, number, number, number] }[] = [];
  for (let x = lo(eyeWorld[0]); x <= hi(eyeWorld[0]); x++) {
    for (let y = lo(eyeWorld[1]); y <= hi(eyeWorld[1]); y++) {
      for (let z = lo(eyeWorld[2]); z <= hi(eyeWorld[2]); z++) {
        const min: Vec3 = [x * e - eyeWorld[0] - reach, y * e - eyeWorld[1] - reach, z * e - eyeWorld[2] - reach];
        const mx: Vec3 = [min[0] + e + 2 * reach, min[1] + e + 2 * reach, min[2] + e + 2 * reach];
        // Distance from the eye (the origin) to the grown tile.
        let dd = 0;
        for (let i = 0; i < 3; i++) {
          const g = min[i]! > 0 ? min[i]! : mx[i]! < 0 ? -mx[i]! : 0;
          dd += g * g;
        }
        if (dd > range * range) continue;
        // The tile wholly inside the near fade has no visible drop.
        let far = 0;
        for (let i = 0; i < 3; i++) far += Math.max(min[i]! * min[i]!, mx[i]! * mx[i]!);
        if (far < shell.nearM[0] * shell.nearM[0]) continue;
        if (visible && !visible(min, mx)) continue;
        const seed = Math.floor(hash3(x | 0, y | 0, z | 0, shell.seed) * 16777216);
        found.push({ d: dd, v: [x * e - eyeWorld[0], y * e - eyeWorld[1], z * e - eyeWorld[2], seed] });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  const out: number[] = [];
  for (let i = 0; i < Math.min(max, found.length); i++) out.push(...found[i]!.v);
  return out;
}

/** The clock of the drops: [share of the current life 0–1, whole lives since time 0 (wrapped at 2²⁰)]. */
export function precipitationClock(timeS: number, lifeS: number): [number, number] {
  const c = timeS / lifeS;
  const whole = Math.floor(c);
  return [c - whole, ((whole % 1048576) + 1048576) % 1048576];
}

/** The eye's place in the world (render space plus the render origin), wrapped into [0, period) per axis, in double (for the landing marks). */
export function precipitationEyeOffset(eyeWorld: Vec3, periodM: number): Vec3 {
  const m = (v: number): number => v - Math.floor(v / periodM) * periodM;
  return [m(eyeWorld[0]), m(eyeWorld[1]), m(eyeWorld[2])];
}

/** One drop now: its place relative to the eye, its age in its life (0–1) and how visible it is (0–1). */
export interface PrecipitationDrop {
  rel: Vec3;
  age: number;
  alpha: number;
}

/**
 * Drop `i` of a tile: where it is relative to the eye and how visible. `tile` is one entry of `precipitationTiles`
 * (corner relative to the eye, seed), `clock` from `precipitationClock`, `count` from `precipitationCount`.
 */
export function precipitationDrop(i: number, tile: readonly [number, number, number, number], shell: PrecipitationShell, fall: PrecipitationFall, velocity: Vec3, clock: readonly [number, number], count: number): PrecipitationDrop {
  const seed = tile[3];
  const c = clock[0] + hash3(i, 0, 3, seed);
  const kc = Math.floor(c);
  const u = c - kc;
  const k = clock[1] + kc;
  const e = shell.tileM;
  const t = fall.lifeS * (u - 0.5);
  const q: Vec3 = [tile[0] + hash3(i, k, 0, seed) * e + velocity[0] * t, tile[1] + hash3(i, k, 1, seed) * e + velocity[1] * t, tile[2] + hash3(i, k, 2, seed) * e + velocity[2] * t];
  if (fall.swayM > 0) {
    const [a, b] = swayAxes(velocity);
    const ph = 2 * Math.PI * (fall.swayCycles * u + hash3(i, k, 4, seed));
    const s = Math.sin(ph) * fall.swayM, co = 0.6 * Math.cos(ph) * fall.swayM;
    for (let j = 0; j < 3; j++) q[j] = q[j]! + a[j]! * s + b[j]! * co;
  }
  const rel = q;
  const d = Math.hypot(rel[0], rel[1], rel[2]);
  const life = smooth(0, 0.08, u) * (1 - smooth(0.92, 1, u));
  const place = smooth(shell.nearM[0], shell.nearM[1], d) * (1 - smooth(shell.farM[0], shell.farM[1], d));
  const alpha = life * place * Math.min(1, Math.max(0, count - i));
  return { rel, age: u, alpha };
}

/** The clock of a kind of landing mark: [slot index (wrapped at 2²⁰), share of the slot 0–1]. */
export function precipitationImpactClock(impact: PrecipitationImpact, timeS: number): [number, number] {
  const c = timeS / impact.slotS;
  const whole = Math.floor(c);
  return [((whole % 1048576) + 1048576) % 1048576, c - whole];
}

/** The landing mark that covers a point: its age (0–1), its distance from the point and its weight by strength. */
export interface PrecipitationMark {
  age: number;
  distanceM: number;
  weight: number;
}

/**
 * The mark of one kind over a point of a surface, or null. `a`, `b` are the point's two coordinates in the plane of the
 * cells (world metres from the period's origin, `precipitationEyeOffset(eye, PRECIPITATION_IMPACT_PERIOD_M)` plus the
 * point relative to the eye), `normal` the surface's normal in the order (a, b, the remaining axis).
 */
export function precipitationImpactAt(impact: PrecipitationImpact, a: number, b: number, normal: Vec3, clock: readonly [number, number], strength: number): PrecipitationMark | null {
  const cell = impact.cellM;
  const n = Math.round(PRECIPITATION_IMPACT_PERIOD_M / cell);
  const fa = Math.floor(a / cell), fb = Math.floor(b / cell);
  const ca = ((fa % n) + n) % n, cb = ((fb % n) + n) % n;
  const seed = impact.seed;
  // Every cell runs its slots at its own phase, so the marks never start together.
  const local = clock[1] + hash3(ca, cb, 0, seed + 4);
  const slot = clock[0] + Math.floor(local);
  const within = local - Math.floor(local);
  const h = hash3(ca, cb, slot, seed);
  const p = impact.rate * Math.min(1, Math.max(0, strength));
  const weight = Math.min(1, Math.max(0, (p - h) * 20));
  if (weight <= 0) return null;
  const share = impact.lifeS / impact.slotS;
  const start = hash3(ca, cb, slot, seed + 1) * (1 - share);
  const age = (within - start) / share;
  if (age < 0 || age >= 1) return null;
  const r = impact.radiusM / cell;
  const da = cell * (r + hash3(ca, cb, slot, seed + 2) * (1 - 2 * r)) - (a - fa * cell);
  const db = cell * (r + hash3(ca, cb, slot, seed + 3) * (1 - 2 * r)) - (b - fb * cell);
  const nk = Math.max(Math.abs(normal[2]), 0.3);
  const dk = -(normal[0] * da + normal[1] * db) / nk;
  return { age, distanceM: Math.hypot(da, db, dk), weight };
}

/**
 * GLSL of the model (after `<header>` and `<noise>`): `precipitationDrop` (the drop's place relative to the eye and
 * its age), `precipitationDropFade`, `precipitationImpact` (the mark of one kind over a point) and
 * `precipitationDepthDistance` (a depth of the main target as the distance along the view, `cloudVolumeDepthMap`).
 */
export const PRECIPITATION_GLSL = /* glsl */ `
// Drop i of a tile: xyz its place relative to the eye, w its age in its life. tile: xyz its corner relative to the
// eye, w its seed; shell: x tile edge, y life in seconds, z sway in metres, w sways per life; clock: x share of the
// life, y whole lives.
vec4 precipitationDrop(int i, vec4 tile, vec4 shell, vec3 velocity, vec2 clock) {
  uint seed = uint(tile.w);
  float c = clock.x + hash3(ivec3(i, 0, 3), seed);
  float kc = floor(c);
  float u = c - kc;
  int k = int(clock.y) + int(kc);
  float e = shell.x;
  vec3 q = tile.xyz + vec3(hash3(ivec3(i, k, 0), seed), hash3(ivec3(i, k, 1), seed), hash3(ivec3(i, k, 2), seed)) * e
    + velocity * (shell.y * (u - 0.5));
  if (shell.z > 0.0) {
    vec3 d = normalize(velocity);
    vec3 a = normalize(cross(d, abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(d, a);
    float ph = 6.2831853 * (shell.w * u + hash3(ivec3(i, k, 4), seed));
    q += a * (sin(ph) * shell.z) + b * (0.6 * cos(ph) * shell.z);
  }
  return vec4(q, u);
}
// How visible a drop is by its age and its distance; range: x, y the fade in, z, w the fade out (metres).
float precipitationDropFade(float d, float u, vec4 range) {
  return smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.92, 1.0, u)) * smoothstep(range.x, range.y, d) * (1.0 - smoothstep(range.z, range.w, d));
}
// The mark of one kind over a point: x age 0–1 (negative: none), y distance from its centre in metres, z weight.
// ab the point in the plane of the cells, n the normal in the order (a, b, the remaining axis); spec: x cell, y life
// over slot, z radius, w rate times strength; clock: x slot index, y share of the slot.
vec3 precipitationImpact(vec2 ab, vec3 n, vec4 spec, uint seed, vec2 clock) {
  float cell = spec.x;
  int count = int(${PRECIPITATION_IMPACT_PERIOD_M}.0 / cell + 0.5);
  vec2 f = floor(ab / cell);
  ivec2 c = ivec2(f);
  c = ((c % count) + count) % count;
  // Every cell runs its slots at its own phase, so the marks never start together.
  float phase = clock.y + hash3(ivec3(c, 0), seed + 4u);
  int slot = int(clock.x) + int(floor(phase));
  float within = fract(phase);
  float h = hash3(ivec3(c, slot), seed);
  float weight = clamp((spec.w - h) * 20.0, 0.0, 1.0);
  if (weight <= 0.0) return vec3(-1.0, 1e9, 0.0);
  float start = hash3(ivec3(c, slot), seed + 1u) * (1.0 - spec.y);
  float age = (within - start) / spec.y;
  if (age < 0.0 || age >= 1.0) return vec3(-1.0, 1e9, 0.0);
  float r = spec.z / cell;
  vec2 local = ab - f * cell;
  vec2 dd = cell * (r + vec2(hash3(ivec3(c, slot), seed + 2u), hash3(ivec3(c, slot), seed + 3u)) * (1.0 - 2.0 * r)) - local;
  float dk = -(n.x * dd.x + n.y * dd.y) / max(abs(n.z), 0.3);
  return vec3(age, length(vec3(dd, dk)), weight);
}
// A depth of the main target as the distance along the view (map from cloudVolumeDepthMap); 1e30 where nothing was drawn.
float precipitationDepthDistance(float depth, vec4 map) {
  if (map.x > 2.5) return depth >= 0.999999 ? 1e30 : exp2(depth / map.w) - 1.0;
  if (map.x < 0.5 || (map.x < 1.5 ? depth <= 0.0 : depth >= 0.9999999)) return 1e30;
  float ndc = map.x > 1.5 ? depth * 2.0 - 1.0 : depth;
  return map.z / (ndc - map.y) * map.w;
}
`;

/** How fast the ground follows the weather (`weatherGround`); every rate is a share per second. */
export interface WeatherGroundRates {
  /** Snow cover gained per second of snowfall at strength 1. Default 1/180: full after three minutes of heavy snow. */
  snowPerS: number;
  /** Wetness gained per second of rain at strength 1. Default 1/20. */
  wetPerS: number;
  /** Wetness lost per second while no rain falls. Default 1/240: dry after four minutes. */
  dryPerS: number;
  /** Snow cover washed away per second of rain at strength 1. Default 1/300. */
  rainMeltPerS: number;
  /** Snow cover lost per second while no snow falls (a thaw). Default 0: the snow stays. */
  thawPerS: number;
}

export const DEFAULT_WEATHER_GROUND: WeatherGroundRates = { snowPerS: 1 / 180, wetPerS: 1 / 20, dryPerS: 1 / 240, rainMeltPerS: 1 / 300, thawPerS: 0 };

/**
 * The weather after `dtS` seconds with the ground following the precipitation: snowfall raises `snowCover`, rain
 * raises `wetness` and washes the snow away, and with nothing falling the ground dries and (at `thawPerS`) the snow
 * melts; melted snow wets the ground. Everything else is passed on; the values stay within 0–1. A pure function: step
 * it with the simulation's or the animation's clock, never with the wall clock.
 */
export function weatherGround(weather: WeatherState, dtS: number, rates: Partial<WeatherGroundRates> = {}): WeatherState {
  const r = { ...DEFAULT_WEATHER_GROUND, ...rates };
  const dt = Math.max(0, dtS);
  const p = Math.min(1, Math.max(0, weather.precipitation));
  const rain = weather.precipitationKind === 'rain' ? p : 0;
  const snow = weather.precipitationKind === 'snow' ? p : 0;
  const cover = Math.min(1, Math.max(0, weather.snowCover));
  const gained = Math.min(1, cover + r.snowPerS * snow * dt);
  const lost = Math.min(gained, (r.rainMeltPerS * rain + r.thawPerS * (1 - snow)) * dt);
  const wet = Math.min(1, Math.max(0, weather.wetness));
  const wetness = Math.min(1, Math.max(0, wet + r.wetPerS * rain * dt - r.dryPerS * (1 - rain) * dt + lost));
  return { ...weather, snowCover: gained - lost, wetness };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Two axes across the fall, as the GLSL picks them. */
function swayAxes(velocity: Vec3): [Vec3, Vec3] {
  const len = Math.hypot(velocity[0], velocity[1], velocity[2]) || 1;
  const d: Vec3 = [velocity[0] / len, velocity[1] / len, velocity[2] / len];
  const o: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let a: Vec3 = [d[1] * o[2] - d[2] * o[1], d[2] * o[0] - d[0] * o[2], d[0] * o[1] - d[1] * o[0]];
  const al = Math.hypot(a[0], a[1], a[2]) || 1;
  a = [a[0] / al, a[1] / al, a[2] / al];
  const b: Vec3 = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]];
  return [a, b];
}

// The integer hashes of `<noise>` (hashU, hash3), the same bits on the CPU.
function hashU(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  const hz = hashU(((z >>> 0) + seed) >>> 0);
  const hy = hashU((Math.imul(y >>> 0, 0xc2b2ae35) ^ hz) >>> 0);
  return hashU((Math.imul(x >>> 0, 0x9e3779b1) ^ hy) >>> 0) / 4294967296;
}
