// A moving surface of a liquid as a sum of a few trochoidal (Gerstner) wave trains: sharp crests, wide troughs.
//
// The trains are data made from a wind and a seed (`waveTrains`): wavelengths from the peak of a fully developed sea
// for that wind (Pierson–Moskowitz) down to an eighth of it, heights from the spectrum's energy in each band,
// directions spread round the wind and phases from the seed. A point of the plane (x, z) at a time is displaced
// toward the crests and up (`waveDisplace`); the normal of the displaced surface and the Jacobian of the horizontal
// displacement (below 1 where the surface is squeezed into a crest, the place for foam) come from `waveNormal`.
// `waveHeight` is the height of the surface over a point of the plane, the displacement toward the crests undone.
//
// Each train fades out where one sample (a vertex or a pixel) covers more than a quarter of its length, so a coarse
// mesh or a far view does not alias; `waveUnresolved` is the slope variance of what has faded, for a rougher glint.
//
// Everything is a pure function of the trains, the point and the time. The shader side (`WAVES_GLSL`) takes the
// trains as uniforms (`waveUniforms`), with the phases at an origin of the caller's choosing computed in double on the
// CPU, so the shader works with positions relative to that origin and keeps its precision far from the plane's zero.
// The engine does not know what the surface is or on what it lies: the caller maps its points to the plane (a flat
// world's x, z; a chart of a sphere) and the displacement back to its space.

import { hashInts, unit } from './hash.ts';

/** Most trains a field holds; the GLSL always loops over this many (unused ones have amplitude 0). */
export const WAVE_TRAINS_MAX = 8;
/** Gravity in m/s² for the speed of the waves (deep water: ω² = g k). */
export const WAVE_GRAVITY = 9.81;

/** One wave train. */
export interface WaveTrain {
  /** Unit direction the train runs toward, in the plane (x, z). */
  dirX: number;
  dirZ: number;
  /** Wavelength in metres. */
  lengthM: number;
  /** Amplitude (half the height from trough to crest) in metres. */
  amplitudeM: number;
  /** How far points move toward the crests, as the share of the steepest the sum of all trains allows (0–1). */
  sharpness: number;
  /** Phase at the plane's zero at time 0, radians. */
  phase: number;
}

export interface WaveFieldOptions {
  /** Wind speed in m/s. */
  windSpeedMs: number;
  /** Direction the wind blows toward in the plane (x, z); need not be a unit vector. */
  towardX: number;
  towardZ: number;
  seed: number;
  /** Number of trains, 1 to `WAVE_TRAINS_MAX`. Default `WAVE_TRAINS_MAX`. */
  count?: number;
  /** Largest angle of a train off the wind, radians. Default 0.7. */
  spreadRad?: number;
  /** Factor on all heights. Default 1. */
  heightScale?: number;
  /** Sharpness of the crests, 0 (sines) to 1 (cusps where all crests meet). Default 0.6. */
  sharpness?: number;
  /** Shortest wavelength as a share of the peak's. Default 1 / 8. */
  shortest?: number;
}

/** The trains of a sea raised by a wind (see the head of the file). Pure: the same options give the same trains. */
export function waveTrains(o: WaveFieldOptions): WaveTrain[] {
  const n = Math.max(1, Math.min(WAVE_TRAINS_MAX, Math.round(o.count ?? WAVE_TRAINS_MAX)));
  const g = WAVE_GRAVITY;
  const u = Math.max(0.5, o.windSpeedMs);
  const spread = o.spreadRad ?? 0.7;
  const sharp = Math.min(1, Math.max(0, o.sharpness ?? 0.6));
  const shortest = Math.min(1, Math.max(0.02, o.shortest ?? 1 / 8));
  const wind = Math.atan2(o.towardX, o.towardZ);
  // The peak of a fully developed sea and its spectrum S(ω) = α g² ω⁻⁵ exp(−1.25 (ωp/ω)⁴).
  const wp = (0.877 * g) / u;
  const spectrum = (w: number): number => 0.0081 * g * g * w ** -5 * Math.exp(-1.25 * (wp / w) ** 4);
  // Bands even in log ω from a little below the peak to the shortest wave.
  const w0 = 0.85 * wp;
  const w1 = wp / Math.sqrt(shortest);
  const trains: WaveTrain[] = [];
  for (let i = 0; i < n; i++) {
    const lo = w0 * (w1 / w0) ** (i / n);
    const hi = w0 * (w1 / w0) ** ((i + 1) / n);
    // The band's energy by the midpoint rule over four steps.
    let e = 0;
    for (let s = 0; s < 4; s++) {
      const a = lo + ((hi - lo) * s) / 4;
      const b = lo + ((hi - lo) * (s + 1)) / 4;
      e += spectrum((a + b) / 2) * (b - a);
    }
    const w = Math.sqrt(lo * hi);
    const k = (w * w) / g;
    // Shorter trains spread wider round the wind, alternating sides.
    const r = (q: number): number => unit(hashInts(o.seed, 0x3a7e5, i, q));
    const side = i % 2 === 0 ? 1 : -1;
    const off = side * spread * (0.25 + 0.75 * (i + 1) / n) * (0.4 + 0.6 * r(1));
    const dir = wind + off;
    trains.push({
      dirX: Math.sin(dir),
      dirZ: Math.cos(dir),
      lengthM: (2 * Math.PI) / k,
      amplitudeM: Math.sqrt(2 * e) * (o.heightScale ?? 1),
      sharpness: sharp,
      phase: 2 * Math.PI * r(2),
    });
  }
  return trains;
}

/** Weight of a train of wavelength `lengthM` where one sample covers `sampleM` metres: 1 sharp, 0 gone. */
export function waveFade(lengthM: number, sampleM: number): number {
  const t = Math.min(1, Math.max(0, (lengthM / Math.max(1e-6, sampleM) - 2) / 2));
  return t * t * (3 - 2 * t);
}

const TAU = 2 * Math.PI;

/** Factor q of a train: the horizontal shift is q · amplitude; the sum of q k a over all trains is the sharpness. */
function shiftFactor(t: WaveTrain, n: number): number {
  const ka = (TAU / t.lengthM) * t.amplitudeM;
  return ka > 0 ? t.sharpness / (ka * n) : 0;
}

/** Phase of a train at a point of the plane at a time. */
function phaseAt(t: WaveTrain, x: number, z: number, timeS: number): number {
  const k = TAU / t.lengthM;
  return k * (t.dirX * x + t.dirZ * z) - Math.sqrt(WAVE_GRAVITY * k) * timeS + t.phase;
}

/**
 * Displacement of the point (x, z) of the plane at `timeS`: [along x, up, along z] in metres. `sampleM` is the size
 * of one sample there (0: every train at full height).
 */
export function waveDisplace(trains: readonly WaveTrain[], x: number, z: number, timeS: number, sampleM = 0): [number, number, number] {
  const n = trains.length;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (const t of trains) {
    const a = t.amplitudeM * waveFade(t.lengthM, sampleM);
    if (a <= 0) continue;
    const th = phaseAt(t, x, z, timeS);
    const c = Math.cos(th);
    const q = shiftFactor(t, n) * a;
    dx += q * t.dirX * c;
    dz += q * t.dirZ * c;
    dy += a * Math.sin(th);
  }
  return [dx, dy, dz];
}

/**
 * Normal of the displaced surface over the point (x, z) of the plane (unit, [x, up, z]) and the Jacobian of the
 * horizontal displacement there (1 flat, toward 1 − sharpness in the sharpest crests).
 */
export function waveNormal(trains: readonly WaveTrain[], x: number, z: number, timeS: number, sampleM = 0): { normal: [number, number, number]; jacobian: number } {
  const n = trains.length;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  let jxx = 1;
  let jzz = 1;
  let jxz = 0;
  for (const t of trains) {
    const a = t.amplitudeM * waveFade(t.lengthM, sampleM);
    if (a <= 0) continue;
    const k = TAU / t.lengthM;
    const th = phaseAt(t, x, z, timeS);
    const c = Math.cos(th);
    const s = Math.sin(th);
    const wa = k * a;
    const qwa = shiftFactor(t, n) * wa;
    nx -= t.dirX * wa * c;
    nz -= t.dirZ * wa * c;
    ny -= qwa * s;
    jxx -= qwa * t.dirX * t.dirX * s;
    jzz -= qwa * t.dirZ * t.dirZ * s;
    jxz -= qwa * t.dirX * t.dirZ * s;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return { normal: [nx / l, ny / l, nz / l], jacobian: jxx * jzz - jxz * jxz };
}

/**
 * Height in metres of the surface over the point (x, z) of the plane at `timeS`: the point of the undisplaced plane
 * whose displacement ends over (x, z) is found by a few steps of fixed-point iteration (the shift is smaller than the
 * distance between crests, so they converge), then its height is taken.
 */
export function waveHeight(trains: readonly WaveTrain[], x: number, z: number, timeS: number, sampleM = 0): number {
  let px = x;
  let pz = z;
  let d = waveDisplace(trains, px, pz, timeS, sampleM);
  for (let i = 0; i < 6; i++) {
    px = x - d[0];
    pz = z - d[2];
    d = waveDisplace(trains, px, pz, timeS, sampleM);
  }
  return d[1];
}

/** Slope variance of the trains that have faded where one sample covers `sampleM` metres (for a rougher glint). */
export function waveUnresolved(trains: readonly WaveTrain[], sampleM: number): number {
  let v = 0;
  for (const t of trains) {
    const ka = (TAU / t.lengthM) * t.amplitudeM;
    v += 0.5 * ka * ka * (1 - waveFade(t.lengthM, sampleM));
  }
  return v;
}

type Vec4 = [number, number, number, number];

/**
 * The uniforms of `WAVES_GLSL` for the trains at `timeS`, for a shader that gives positions relative to the point
 * (`originX`, `originZ`) of the plane. The phases there are computed in double. With `out` (a result of an earlier
 * call) its arrays are rewritten and it is returned, so a frame allocates nothing.
 */
export function waveUniforms(trains: readonly WaveTrain[], timeS: number, originX: number, originZ: number, out?: Record<string, { vec4: Vec4 }>): Record<string, { vec4: Vec4 }> {
  const u = out ?? {};
  const n = trains.length;
  const phases: number[] = [];
  for (let i = 0; i < WAVE_TRAINS_MAX; i++) {
    const t = trains[i];
    const key = `u_waveTrain${i}`;
    const v = (u[key] ??= { vec4: [0, 0, 0, 0] }).vec4;
    if (!t) {
      v[0] = 0;
      v[1] = 0;
      v[2] = 0;
      v[3] = 0;
      phases.push(0);
      continue;
    }
    const k = TAU / t.lengthM;
    v[0] = t.dirX * k;
    v[1] = t.dirZ * k;
    v[2] = t.amplitudeM;
    v[3] = shiftFactor(t, n);
    const p = phaseAt(t, originX, originZ, timeS);
    phases.push(p - TAU * Math.floor(p / TAU));
  }
  for (let j = 0; j < WAVE_TRAINS_MAX / 4; j++) {
    const v = (u[`u_wavePhase${j}`] ??= { vec4: [0, 0, 0, 0] }).vec4;
    for (let c = 0; c < 4; c++) v[c] = phases[j * 4 + c]!;
  }
  return u;
}

/**
 * GLSL of the field (any stage; needs nothing before it). Declares the uniforms `u_waveTrain0` … `u_waveTrain7`
 * (xy the wave vector, z the amplitude, w the shift factor q) and `u_wavePhase0`, `u_wavePhase1` (the phases at the
 * origin), set by `waveUniforms`. Positions `xz` are relative to that origin. Functions: `waveFade`, `waveDisplace`,
 * `waveNormal` (with the Jacobian as an out parameter), `waveHeight`, `waveUnresolved`, the same arithmetic as the
 * TypeScript functions of the same names.
 */
export const WAVES_GLSL = /* glsl */ `
uniform vec4 u_waveTrain0;
uniform vec4 u_waveTrain1;
uniform vec4 u_waveTrain2;
uniform vec4 u_waveTrain3;
uniform vec4 u_waveTrain4;
uniform vec4 u_waveTrain5;
uniform vec4 u_waveTrain6;
uniform vec4 u_waveTrain7;
uniform vec4 u_wavePhase0;
uniform vec4 u_wavePhase1;
float waveFade(float lengthM, float sampleM) {
  return smoothstep(0.0, 1.0, (lengthM / max(sampleM, 1e-6) - 2.0) * 0.5);
}
vec3 waveDisplace(vec2 xz, float sampleM) {
  vec4 w[8] = vec4[8](u_waveTrain0, u_waveTrain1, u_waveTrain2, u_waveTrain3, u_waveTrain4, u_waveTrain5, u_waveTrain6, u_waveTrain7);
  float ph[8] = float[8](u_wavePhase0.x, u_wavePhase0.y, u_wavePhase0.z, u_wavePhase0.w, u_wavePhase1.x, u_wavePhase1.y, u_wavePhase1.z, u_wavePhase1.w);
  vec3 d = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float k = length(w[i].xy);
    if (k <= 0.0) continue;
    float a = w[i].z * waveFade(6.2831853 / k, sampleM);
    if (a <= 0.0) continue;
    float th = dot(w[i].xy, xz) + ph[i];
    float c = cos(th);
    vec2 dir = w[i].xy / k;
    d.xz += dir * (w[i].w * a * c);
    d.y += a * sin(th);
  }
  return d;
}
vec3 waveNormal(vec2 xz, float sampleM, out float jacobian) {
  vec4 w[8] = vec4[8](u_waveTrain0, u_waveTrain1, u_waveTrain2, u_waveTrain3, u_waveTrain4, u_waveTrain5, u_waveTrain6, u_waveTrain7);
  float ph[8] = float[8](u_wavePhase0.x, u_wavePhase0.y, u_wavePhase0.z, u_wavePhase0.w, u_wavePhase1.x, u_wavePhase1.y, u_wavePhase1.z, u_wavePhase1.w);
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 j = vec3(1.0, 1.0, 0.0); // xx, zz, xz
  for (int i = 0; i < 8; i++) {
    float k = length(w[i].xy);
    if (k <= 0.0) continue;
    float a = w[i].z * waveFade(6.2831853 / k, sampleM);
    if (a <= 0.0) continue;
    float th = dot(w[i].xy, xz) + ph[i];
    float c = cos(th);
    float s = sin(th);
    vec2 dir = w[i].xy / k;
    float wa = k * a;
    float qwa = w[i].w * wa;
    n.xz -= dir * (wa * c);
    n.y -= qwa * s;
    j -= vec3(dir.x * dir.x, dir.y * dir.y, dir.x * dir.y) * (qwa * s);
  }
  jacobian = j.x * j.y - j.z * j.z;
  return normalize(n);
}
float waveHeight(vec2 xz, float sampleM) {
  vec2 p = xz;
  vec3 d = waveDisplace(p, sampleM);
  for (int i = 0; i < 6; i++) {
    p = xz - d.xz;
    d = waveDisplace(p, sampleM);
  }
  return d.y;
}
float waveUnresolved(float sampleM) {
  vec4 w[8] = vec4[8](u_waveTrain0, u_waveTrain1, u_waveTrain2, u_waveTrain3, u_waveTrain4, u_waveTrain5, u_waveTrain6, u_waveTrain7);
  float v = 0.0;
  for (int i = 0; i < 8; i++) {
    float k = length(w[i].xy);
    if (k <= 0.0) continue;
    float ka = k * w[i].z;
    v += 0.5 * ka * ka * (1.0 - waveFade(6.2831853 / k, sampleM));
  }
  return v;
}
`;
