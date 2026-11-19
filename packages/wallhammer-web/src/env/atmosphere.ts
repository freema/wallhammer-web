// Air as a shell around a sphere, as an environment slot: light scattered by molecules (Rayleigh) and by particles
// (Mie), an absorbing layer, and light scattered more than once. One model serves an eye on the ground, in flight
// and outside the shell, so nothing switches on the way up: the sky, the haze in front of distant geometry, the rim
// of the shell seen from outside and the line between day and night all come from the same integral along the view
// ray. The method follows Hillaire 2020 ("A Scalable and Production Ready Sky and Atmosphere Rendering Technique").
//
// That integral is never taken per pixel unless asked for (`reference`): the atmosphere layer of runtime keeps it
// for the sky in a small table over the directions from the eye, and a material takes it at its vertices
// (`atmosphereAir`) and lets the rasteriser carry the result to its fragments.
//
// Three small tables are computed once, on the CPU, when the slot is made (`atmosphereTables`), and packed into one
// 160 × 32 texture; no file is involved:
//   - how much sunlight reaches a point from a direction above its horizon (128 × 32),
//   - light scattered more than once, by height and sun height (32 × 16),
//   - the sky's light on a level surface, by height and sun height (32 × 16).
//
// The sphere is the renderer's `radialUp` sphere when there is one. Without it (up is +y) the ground sphere touches
// the plane `groundY` straight under the eye, which is exact enough for a map tens of kilometres across.
//
// The slot's GLSL is registered as the include `<atmosphere>` (it needs only `<header>` before it, in a vertex shader
// as in a fragment shader). Without the slot `EnvironmentLink` registers `ATMOSPHERE_FALLBACK` under the same name, so
// a material may call `atmosphereAir` and `atmosphereApply` in any engine and ask `#ifdef WH_ATMOSPHERE` before it
// uses the rest.

import { smoothstep } from '../base/math.ts';
import type { RGB, Vec3 } from '../base/math.ts';
import type { TextureData } from '../base/data.ts';
import type { EnvSlot, FrameEnvironment } from '../base/env-slot.ts';

/** What the air is made of. Fixed when the slot is created: the tables are computed from it. */
export interface AtmosphereMedium {
  /** Radius of the ground sphere in metres. With the renderer's `radialUp` give the same radius. */
  radiusM: number;
  /** Thickness of the shell of air above the ground sphere in metres. */
  heightM: number;
  /** Scattering by molecules per metre at the ground, and the height over which their density falls to 1/e. */
  rayleigh: RGB;
  rayleighScaleM: number;
  /** Scattering and absorption by particles per metre at the ground, their scale height, and the forward share g (0–1). */
  mieScattering: number;
  mieAbsorption: number;
  mieScaleM: number;
  mieG: number;
  /** An absorbing layer (ozone): absorption per metre in its middle, the height of the middle and its half-width. */
  absorption: RGB;
  absorptionCenterM: number;
  absorptionHalfWidthM: number;
  /** Share of light the ground sends back into the air, for the light scattered more than once. */
  groundAlbedo: number;
}

export interface AtmosphereParams extends AtmosphereMedium {
  /**
   * Brightness of the scattered light on screen: its colour is `1 − exp(−radiance × exposure)`, where the radiance is
   * measured with the sun above the air as 1.
   */
  exposure: number;
  /** The sun above the air as light on surfaces, a multiple of the surface colour (`atmosphereLight`). */
  sunLight: RGB;
  /** Gain of the sky's light on surfaces. 1 is the physical share; more lifts the shadows. */
  skyLightGain: number;
  /** Light on surfaces that remains where the sun does not reach. */
  nightLight: RGB;
  /** Radius of the sun's disc in radians. */
  sunDiscRad: number;
  /** Visibility of the stars behind dark air, 0–1. */
  stars: number;
  /**
   * Height of the cloud tops in metres. Under an overcast sky (the frame's cloud cover over the eye from 0.5 to 0.9)
   * the sky's light on surfaces turns into the grey, even light the clouds pass on and the air's own light dims and
   * greys; an eye above this height (fading out up to twice it) looks down on the clouds and sees neither.
   */
  cloudTopM: number;
  /** Where up is +y: height of the ground in render space. */
  groundY: number;
  /** Steps along a view ray of the sky and along the way to a surface point (at most 48). Fixed at creation. */
  skySteps: number;
  airSteps: number;
  /**
   * Reference quality: the integral along the view ray is taken for every pixel, of the sky and of every material,
   * instead of read from the sky table and carried from the vertices. Many times slower; for comparing the two.
   */
  reference: boolean;
  /** Eye of the current view in render space, or null for a view without one. The atmosphere layer sets it every frame. */
  eye: Vec3 | null;
  /** Height of that eye above the ground sphere in metres. The atmosphere layer sets it every frame. */
  eyeHeightM: number;
}

/** Air of the Earth (coefficients as in Hillaire 2020). */
export const DEFAULT_ATMOSPHERE_MEDIUM: AtmosphereMedium = {
  radiusM: 6_360_000,
  heightM: 100_000,
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6],
  rayleighScaleM: 8000,
  mieScattering: 3.996e-6,
  mieAbsorption: 4.4e-6,
  mieScaleM: 1200,
  mieG: 0.8,
  absorption: [0.65e-6, 1.881e-6, 0.085e-6],
  absorptionCenterM: 25_000,
  absorptionHalfWidthM: 15_000,
  groundAlbedo: 0.3,
};

export const DEFAULT_ATMOSPHERE: Omit<AtmosphereParams, 'eye' | 'eyeHeightM'> = {
  ...DEFAULT_ATMOSPHERE_MEDIUM,
  exposure: 30,
  sunLight: [1.45, 1.38, 1.3],
  skyLightGain: 2.5,
  nightLight: [0.02, 0.025, 0.04],
  sunDiscRad: 0.012,
  stars: 1,
  cloudTopM: 4000,
  groundY: 0,
  skySteps: 24,
  airSteps: 8,
  reference: false,
};

/**
 * The default air fitted to a sphere of another size: every height is scaled to a shell `heightM` thick and every
 * density the other way, so the light that comes straight down is the same as through the default air.
 */
export function atmosphereFor(radiusM: number, heightM: number): AtmosphereMedium {
  const d = DEFAULT_ATMOSPHERE_MEDIUM;
  const k = heightM / d.heightM;
  return {
    radiusM,
    heightM,
    rayleigh: [d.rayleigh[0] / k, d.rayleigh[1] / k, d.rayleigh[2] / k],
    rayleighScaleM: d.rayleighScaleM * k,
    mieScattering: d.mieScattering / k,
    mieAbsorption: d.mieAbsorption / k,
    mieScaleM: d.mieScaleM * k,
    mieG: d.mieG,
    absorption: [d.absorption[0] / k, d.absorption[1] / k, d.absorption[2] / k],
    absorptionCenterM: d.absorptionCenterM * k,
    absorptionHalfWidthM: d.absorptionHalfWidthM * k,
    groundAlbedo: d.groundAlbedo,
  };
}

// --- Tables ----------------------------------------------------------------------------------------------------------

/** Texture unit the atmosphere layer keeps the tables on during the colour pass (sampler `u_atmTables`). */
export const ATMOSPHERE_TABLE_UNIT = 14;

/** Where each table lies in the texture, in texels: x, y, width, height. */
export const ATMOSPHERE_TABLE_LAYOUT = {
  width: 160,
  height: 32,
  transmittance: [0, 0, 128, 32],
  multiScatter: [128, 0, 32, 16],
  skyLight: [128, 16, 32, 16],
} as const;

export interface AtmosphereTables {
  /** RGBA8, linear filter. Every table stores the square root of its value over its scale. */
  texture: TextureData;
  /** Largest value of the table of light scattered more than once, and of the table of sky light. */
  multiScatterScale: number;
  skyLightScale: number;
}

const TW = ATMOSPHERE_TABLE_LAYOUT.transmittance[2];
const TH = ATMOSPHERE_TABLE_LAYOUT.transmittance[3];
const MW = ATMOSPHERE_TABLE_LAYOUT.multiScatter[2];
const MH = ATMOSPHERE_TABLE_LAYOUT.multiScatter[3];
const FOUR_PI = 4 * Math.PI;
/** Cosine range over which the sun sinks behind the horizon of the ground sphere (the GLSL uses the same). */
const HORIZON_SOFT = 0.01;
/** Largest exponent of a density: keeps the smallest density a normal 32-bit float, as in the shader. */
const MAX_EXPONENT = 60;

/** Mean of an exponential over a segment from its two end values (exact when the height changes evenly). */
function expMean(a: number, b: number): number {
  const d = a - b;
  return Math.abs(d) > 1e-4 * (a + b) ? d / Math.log(a / b) : 0.5 * (a + b);
}

/** Reads a table of rgb triples at (x, y) in 0–1 with texel centres at the ends, bilinear. */
function readTable(table: Float64Array, w: number, h: number, x: number, y: number, out: [number, number, number]): void {
  const fx = Math.min(1, Math.max(0, x)) * (w - 1);
  const fy = Math.min(1, Math.max(0, y)) * (h - 1);
  const x0 = Math.min(w - 2, Math.floor(fx));
  const y0 = Math.min(h - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const a = (y0 * w + x0) * 3;
  const b = a + 3;
  const c = a + w * 3;
  const d = c + 3;
  for (let ch = 0; ch < 3; ch++) {
    const top = table[a + ch]! + (table[b + ch]! - table[a + ch]!) * tx;
    const bottom = table[c + ch]! + (table[d + ch]! - table[c + ch]!) * tx;
    out[ch] = top + (bottom - top) * ty;
  }
}

/** The medium with the lengths every integral needs. */
interface Air {
  m: AtmosphereMedium;
  Rg: number;
  Rt: number;
  /** Distance from the ground to the top of the air along the horizon. */
  Hh: number;
  mieExtinction: number;
  transmittance: Float64Array;
}

/** Densities at a height: molecules, particles, the absorbing layer. */
function densities(air: Air, h: number, out: [number, number, number]): void {
  const m = air.m;
  const hh = Math.max(0, h);
  out[0] = Math.exp(-Math.min(hh / m.rayleighScaleM, MAX_EXPONENT));
  out[1] = Math.exp(-Math.min(hh / m.mieScaleM, MAX_EXPONENT));
  out[2] = Math.max(0, 1 - Math.abs(h - m.absorptionCenterM) / m.absorptionHalfWidthM);
}

/** Share of sunlight that reaches a point `r` from the centre when the sun stands at cosine `mu` from straight up. */
function sunAt(air: Air, r: number, mu: number, out: [number, number, number]): void {
  const { Rg, Rt, Hh } = air;
  const rr = Math.min(Rt, Math.max(Rg, r));
  const rho = Math.sqrt(Math.max(0, rr * rr - Rg * Rg));
  const muH = -rho / rr;
  const vis = Math.min(1, Math.max(0, (mu - muH) / HORIZON_SOFT + 0.5));
  if (vis <= 0) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  const muC = Math.max(mu, muH);
  const d = Math.max(0, -rr * muC + Math.sqrt(Math.max(0, rr * rr * (muC * muC - 1) + Rt * Rt)));
  const dMin = Rt - rr;
  const dMax = rho + Hh;
  readTable(air.transmittance, TW, TH, (d - dMin) / Math.max(dMax - dMin, 1e-3), rho / Hh, out);
  out[0] *= vis;
  out[1] *= vis;
  out[2] *= vis;
}

/** Distance along a ray from radius `r` with cosine `mu` from straight up: to the ground when it hits it, else to the top. */
function rayLength(air: Air, r: number, mu: number): { length: number; ground: boolean } {
  const { Rg, Rt } = air;
  const dg = r * r * (mu * mu - 1) + Rg * Rg;
  if (mu < 0 && dg >= 0) return { length: Math.max(0, -r * mu - Math.sqrt(dg)), ground: true };
  return { length: Math.max(0, -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + Rt * Rt))), ground: false };
}

function transmittanceTable(air: Air): Float64Array {
  const { m, Rg, Rt, Hh } = air;
  const out = new Float64Array(TW * TH * 3);
  const STEPS = 40;
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < TH; j++) {
    const rho = (Hh * j) / (TH - 1);
    const r = Math.sqrt(rho * rho + Rg * Rg);
    const dMin = Rt - r;
    const dMax = rho + Hh;
    for (let i = 0; i < TW; i++) {
      const d = dMin + ((dMax - dMin) * i) / (TW - 1);
      const mu = d > 0 ? Math.min(1, Math.max(-1, (Hh * Hh - rho * rho - d * d) / (2 * r * d))) : 1;
      // Optical depth along the ray to the top of the air.
      let depthR = 0;
      let depthM = 0;
      let depthO = 0;
      const dt = d / STEPS;
      densities(air, r - Rg, a);
      for (let k = 1; k <= STEPS; k++) {
        const t = dt * k;
        densities(air, Math.sqrt(r * r + t * t + 2 * r * mu * t) - Rg, b);
        depthR += expMean(a[0], b[0]) * dt;
        depthM += expMean(a[1], b[1]) * dt;
        depthO += 0.5 * (a[2] + b[2]) * dt;
        a[0] = b[0];
        a[1] = b[1];
        a[2] = b[2];
      }
      const at = (j * TW + i) * 3;
      for (let ch = 0; ch < 3; ch++) out[at + ch] = Math.exp(-(m.rayleigh[ch]! * depthR + air.mieExtinction * depthM + m.absorption[ch]! * depthO));
    }
  }
  return out;
}

/**
 * Integrates along a ray from the point (0, r, 0) in the direction `w`, with the sun in the direction `s` (both unit
 * vectors), to the ground or to the top of the air. Adds to `light` what is scattered toward the start (sunlight
 * with the phase values `phaseM` for particles and `phaseR` for molecules, plus `multi`, the light scattered more than
 * once, when given, plus what lit ground at the end of the ray sends back) and to `share` the share of light the air
 * along the ray scatters at all.
 */
function marchRay(
  air: Air,
  r: number,
  w: readonly [number, number, number],
  s: readonly [number, number, number],
  steps: number,
  phaseM: number,
  phaseR: number,
  multi: ((h: number, mu: number, out: [number, number, number]) => void) | null,
  light: [number, number, number],
  share: [number, number, number],
): void {
  const { m, Rg } = air;
  const { length, ground } = rayLength(air, r, w[1]);
  const through: [number, number, number] = [1, 1, 1];
  const dA: [number, number, number] = [0, 0, 0];
  const dB: [number, number, number] = [0, 0, 0];
  const sunA: [number, number, number] = [0, 0, 0];
  const sunB: [number, number, number] = [0, 0, 0];
  const msA: [number, number, number] = [0, 0, 0];
  const msB: [number, number, number] = [0, 0, 0];
  densities(air, r - Rg, dA);
  sunAt(air, r, s[1], sunA);
  if (multi) multi(r - Rg, s[1], msA);
  const dt = length / steps;
  let px = 0;
  let py = r;
  let pz = 0;
  for (let k = 1; k <= steps && dt > 0; k++) {
    const t = dt * k;
    px = w[0] * t;
    py = r + w[1] * t;
    pz = w[2] * t;
    const rk = Math.sqrt(px * px + py * py + pz * pz);
    const mu = (px * s[0] + py * s[1] + pz * s[2]) / rk;
    densities(air, rk - Rg, dB);
    sunAt(air, rk, mu, sunB);
    if (multi) multi(rk - Rg, mu, msB);
    const rhoR = expMean(dA[0], dB[0]);
    const rhoM = expMean(dA[1], dB[1]);
    const rhoO = 0.5 * (dA[2] + dB[2]);
    for (let ch = 0; ch < 3; ch++) {
      const scatR = m.rayleigh[ch]! * rhoR;
      const scatM = m.mieScattering * rhoM;
      const ext = scatR + air.mieExtinction * rhoM + m.absorption[ch]! * rhoO;
      const stepT = Math.exp(-ext * dt);
      const part = ext * dt > 1e-6 ? (1 - stepT) / ext : dt;
      const src = 0.5 * (sunA[ch]! + sunB[ch]!) * (scatR * phaseR + scatM * phaseM) + 0.5 * (msA[ch]! + msB[ch]!) * (scatR + scatM);
      light[ch] = light[ch]! + through[ch]! * src * part;
      share[ch] = share[ch]! + through[ch]! * (scatR + scatM) * part;
      through[ch] = through[ch]! * stepT;
    }
    for (let ch = 0; ch < 3; ch++) {
      dA[ch] = dB[ch]!;
      sunA[ch] = sunB[ch]!;
      msA[ch] = msB[ch]!;
    }
  }
  if (ground && length > 0) {
    // The lit ground at the end of the ray sends its share back.
    const mu = (px * s[0] + py * s[1] + pz * s[2]) / Rg;
    sunAt(air, Rg, mu, sunB);
    const k = (Math.max(0, mu) * m.groundAlbedo) / Math.PI;
    for (let ch = 0; ch < 3; ch++) light[ch] = light[ch]! + through[ch]! * sunB[ch]! * k;
  }
}

/** Height of row `j` of a table of `rows` rows over the shell: a little inside both of its ends. */
function rowRadius(air: Air, j: number, rows: number): number {
  const off = air.m.heightM * 1e-4;
  return air.Rg + off + ((air.m.heightM - 2 * off) * j) / (rows - 1);
}

/** Light scattered more than once, per unit of scattering, by sun height (columns, cosine −1…1) and height (rows). */
function multiScatterTable(air: Air): Float64Array {
  const out = new Float64Array(MW * MH * 3);
  const DIRS = 8;
  const dirs: [number, number, number][] = [];
  for (let a = 0; a < DIRS; a++) {
    for (let b = 0; b < DIRS; b++) {
      const phi = (2 * Math.PI * (a + 0.5)) / DIRS;
      const cos = 1 - (2 * (b + 0.5)) / DIRS;
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      dirs.push([sin * Math.cos(phi), cos, sin * Math.sin(phi)]);
    }
  }
  for (let j = 0; j < MH; j++) {
    const r = rowRadius(air, j, MH);
    for (let i = 0; i < MW; i++) {
      const mu = -1 + (2 * i) / (MW - 1);
      const s: [number, number, number] = [Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0];
      const light: [number, number, number] = [0, 0, 0];
      const share: [number, number, number] = [0, 0, 0];
      // Second order, with an even phase for both kinds of scattering.
      for (const w of dirs) marchRay(air, r, w, s, 20, 1 / FOUR_PI, 1 / FOUR_PI, null, light, share);
      const at = (j * MW + i) * 3;
      // Every further order repeats the same transfer: a geometric series.
      for (let ch = 0; ch < 3; ch++) out[at + ch] = light[ch]! / dirs.length / (1 - Math.min(0.99, share[ch]! / dirs.length));
    }
  }
  return out;
}

/** The sky's light on a level surface (sun above the air = 1), by sun height (columns) and height (rows). */
function skyLightTable(air: Air, multi: Float64Array): Float64Array {
  const out = new Float64Array(MW * MH * 3);
  const AROUND = 8;
  const DOWN = 4;
  const height = air.m.heightM;
  const readMulti = (h: number, mu: number, o: [number, number, number]): void => readTable(multi, MW, MH, mu * 0.5 + 0.5, h / height, o);
  const dirs: [number, number, number][] = [];
  for (let a = 0; a < AROUND; a++) {
    for (let b = 0; b < DOWN; b++) {
      // Spread by the cosine to the surface, so the mean over the directions times pi is the light on it.
      const phi = (2 * Math.PI * (a + 0.5)) / AROUND;
      const cos = Math.sqrt(1 - (b + 0.5) / DOWN);
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      dirs.push([sin * Math.cos(phi), cos, sin * Math.sin(phi)]);
    }
  }
  const unused: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < MH; j++) {
    const r = rowRadius(air, j, MH);
    for (let i = 0; i < MW; i++) {
      const mu = -1 + (2 * i) / (MW - 1);
      const s: [number, number, number] = [Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0];
      const light: [number, number, number] = [0, 0, 0];
      for (const w of dirs) {
        const cosT = w[0] * s[0] + w[1] * s[1] + w[2] * s[2];
        // Particles scatter evenly here: these few directions cannot resolve their forward peak.
        marchRay(air, r, w, s, 16, 1 / FOUR_PI, (3 / (16 * Math.PI)) * (1 + cosT * cosT), readMulti, light, unused);
      }
      const at = (j * MW + i) * 3;
      for (let ch = 0; ch < 3; ch++) out[at + ch] = (Math.PI * light[ch]!) / dirs.length;
    }
  }
  return out;
}

/** Pure: the three tables of a medium, packed into one texture. Takes tens of milliseconds. */
export function atmosphereTables(m: AtmosphereMedium): AtmosphereTables {
  if (!(m.radiusM > 0 && m.heightM > 0)) throw new Error('atmosphereTables: radiusM and heightM must be positive');
  const Rg = m.radiusM;
  const Rt = m.radiusM + m.heightM;
  const air: Air = { m, Rg, Rt, Hh: Math.sqrt(Rt * Rt - Rg * Rg), mieExtinction: m.mieScattering + m.mieAbsorption, transmittance: new Float64Array(0) };
  air.transmittance = transmittanceTable(air);
  const multi = multiScatterTable(air);
  const sky = skyLightTable(air, multi);
  const peak = (t: Float64Array): number => t.reduce((a, v) => Math.max(a, v), 1e-9);
  const multiScatterScale = peak(multi);
  const skyLightScale = peak(sky);
  const L = ATMOSPHERE_TABLE_LAYOUT;
  const data = new Uint8Array(L.width * L.height * 4);
  const put = (table: Float64Array, region: readonly [number, number, number, number], scale: number): void => {
    const [x0, y0, w, h] = region;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const at = ((y0 + j) * L.width + x0 + i) * 4;
        for (let ch = 0; ch < 3; ch++) data[at + ch] = Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, table[(j * w + i) * 3 + ch]! / scale))));
        data[at + 3] = 255;
      }
    }
  };
  put(air.transmittance, L.transmittance, 1);
  put(multi, L.multiScatter, multiScatterScale);
  put(sky, L.skyLight, skyLightScale);
  return { texture: { width: L.width, height: L.height, format: 'rgba8', data, filter: 'linear' }, multiScatterScale, skyLightScale };
}

// --- Slot ------------------------------------------------------------------------------------------------------------

/** What the atmosphere slot computes for one frame. */
export interface AtmosphereValues {
  /** True unit direction to the sun. */
  sunDir: Vec3;
  /** 0 for a view without an eye: no air is drawn in it. */
  exposure: number;
  eye: Vec3;
  eyeHeightM: number;
  radiusM: number;
  topM: number;
  groundY: number;
  sunDiscRad: number;
  rayleigh: RGB;
  invRayleighScale: number;
  mieScattering: number;
  mieExtinction: number;
  invMieScale: number;
  mieG: number;
  absorption: RGB;
  absorptionCenterM: number;
  invAbsorptionHalfWidth: number;
  multiScatterScale: number;
  skyLightScale: number;
  stars: number;
  sunLight: RGB;
  skyLightGain: number;
  nightLight: RGB;
  /** 1 for the reference quality (`AtmosphereParams.reference`), else 0. */
  reference: number;
  /** How overcast the sky over the eye is, 0–1 (`atmosphereOvercast`). */
  overcast: number;
}

/** Cloud cover over the eye from which the sky counts as overcast, and where it is fully so. */
const OVERCAST_FROM = 0.5;
const OVERCAST_TO = 0.9;
/** The light an overcast sky passes on to the ground, as a share of the sun and the sky above the clouds. */
const OVERCAST_LIGHT = 0.3;

/**
 * How overcast the sky over the eye is, 0–1: the cloud cover over the eye from 0.5 to 0.9, fading out as the eye rises
 * from the cloud tops (`cloudTopM`) to twice their height.
 */
export function atmosphereOvercast(cloudCover: number, eyeHeightM: number, cloudTopM: number): number {
  return smoothstep(OVERCAST_FROM, OVERCAST_TO, cloudCover) * (1 - smoothstep(cloudTopM, 2 * cloudTopM, eyeHeightM));
}

/** An atmosphere slot: the slot and the tables computed for its medium. */
export interface AtmosphereSlot extends EnvSlot<AtmosphereParams, AtmosphereValues> {
  /** The medium the tables were made for (a copy; later changes of the params' medium have no effect). */
  readonly medium: AtmosphereMedium;
  readonly tables: AtmosphereTables;
}

/** Pure: the slot's values from the generic environment, the params, and the medium with its tables. */
export function computeAtmosphere(E: FrameEnvironment, p: AtmosphereParams, m: AtmosphereMedium, tables: Pick<AtmosphereTables, 'multiScatterScale' | 'skyLightScale'>): AtmosphereValues {
  return {
    sunDir: E.sunDir,
    exposure: p.eye ? Math.max(0, p.exposure) : 0,
    eye: p.eye ?? [0, 0, 0],
    eyeHeightM: p.eye ? p.eyeHeightM : 0,
    radiusM: m.radiusM,
    topM: m.radiusM + m.heightM,
    groundY: p.groundY,
    sunDiscRad: p.sunDiscRad,
    rayleigh: m.rayleigh,
    invRayleighScale: 1 / m.rayleighScaleM,
    mieScattering: m.mieScattering,
    mieExtinction: m.mieScattering + m.mieAbsorption,
    invMieScale: 1 / m.mieScaleM,
    mieG: m.mieG,
    absorption: m.absorption,
    absorptionCenterM: m.absorptionCenterM,
    invAbsorptionHalfWidth: 1 / m.absorptionHalfWidthM,
    multiScatterScale: tables.multiScatterScale,
    skyLightScale: tables.skyLightScale,
    stars: p.stars,
    sunLight: p.sunLight,
    skyLightGain: p.skyLightGain,
    nightLight: p.nightLight,
    reference: p.reference ? 1 : 0,
    overcast: p.eye ? atmosphereOvercast(E.cloudCover, p.eyeHeightM, p.cloudTopM) : 0,
  };
}

/** Largest number of steps the GLSL integrates along one ray. */
const MAX_STEPS = 48;
const steps = (n: number): number => Math.min(MAX_STEPS, Math.max(2, Math.round(n)));
const f = (n: number): string => n.toFixed(1);

/** GLSL of the slot for the given step counts. Needs `<header>` before it. */
export function atmosphereGlsl(skySteps: number, airSteps: number): string {
  const L = ATMOSPHERE_TABLE_LAYOUT;
  const region = (r: readonly [number, number, number, number]): string => `vec2(${f(r[0])}, ${f(r[1])}), vec2(${f(r[2])}, ${f(r[3])})`;
  return /* glsl */ `
#define WH_ATMOSPHERE 1
#define ATM_SKY_STEPS ${steps(skySteps)}
#define ATM_AIR_STEPS ${steps(airSteps)}
uniform highp sampler2D u_atmTables;

// Centre of the ground sphere in render space. Where up is +y the sphere touches the ground straight under the eye.
vec3 atmCenter() {
#ifdef WH_LOCAL_UP
  return u_upCenter.xyz;
#else
  return vec3(u_atmEye.x, u_atmShell.z - u_atmShell.x, u_atmEye.z);
#endif
}

// One of the tables at a place given in 0–1 with texel centres at both ends; the stored square root is undone.
vec3 atmTable(vec2 at, vec2 origin, vec2 size) {
  vec2 uv = (origin + 0.5 + clamp(at, 0.0, 1.0) * (size - 1.0)) / vec2(${f(L.width)}, ${f(L.height)});
  vec3 v = textureLod(u_atmTables, uv, 0.0).rgb;
  return v * v;
}

// Densities at a height above the ground sphere: x molecules, y particles, z the absorbing layer.
vec3 atmDensity(float h) {
  float hh = max(h, 0.0);
  return vec3(exp(-min(hh * u_atmRayleigh.w, ${f(MAX_EXPONENT)})), exp(-min(hh * u_atmMie.z, ${f(MAX_EXPONENT)})), max(0.0, 1.0 - abs(h - u_atmAbsorb.w) * u_atmTune.x));
}

// Mean of an exponential over a segment from its two end values.
float atmMean(float a, float b) {
  float d = a - b;
  return abs(d) > 1e-4 * (a + b) ? d / log(a / b) : 0.5 * (a + b);
}

// Share of the sun's light that reaches a point at the distance r from the centre, where the sun stands at the
// cosine mu from straight up. Behind the horizon of the ground sphere it is 0: that is the line between day and night.
vec3 atmSunAt(float r, float mu) {
  float Rg = u_atmShell.x;
  float Rt = u_atmShell.y;
  r = clamp(r, Rg, Rt);
  float rho = sqrt(max(r * r - Rg * Rg, 0.0));
  float muH = -rho / r;
  float vis = clamp((mu - muH) * ${f(1 / HORIZON_SOFT)} + 0.5, 0.0, 1.0);
  if (vis <= 0.0) return vec3(0.0);
  mu = max(mu, muH);
  float hh = sqrt(Rt * Rt - Rg * Rg);
  float d = max(-r * mu + sqrt(max(r * r * (mu * mu - 1.0) + Rt * Rt, 0.0)), 0.0);
  float dMin = Rt - r;
  float dMax = rho + hh;
  return atmTable(vec2((d - dMin) / max(dMax - dMin, 1e-3), rho / hh), ${region(L.transmittance)}) * vis;
}

// Light scattered more than once at a height, per unit of scattering.
vec3 atmMultiAt(float h, float mu) {
  return atmTable(vec2(mu * 0.5 + 0.5, h / (u_atmShell.y - u_atmShell.x)), ${region(L.multiScatter)}) * u_atmTune.y;
}

// The sky's light on a level surface at a height.
vec3 atmSkyLightAt(float h, float mu) {
  return atmTable(vec2(mu * 0.5 + 0.5, h / (u_atmShell.y - u_atmShell.x)), ${region(L.skyLight)}) * u_atmTune.z;
}

// Share of the sunlight particles scatter that goes on at the cosine cosT between the ray and the sun.
float atmPhaseMie(float cosT) {
  float g = u_atmMie.w;
  return 0.0795775 * (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
}

// Light the air scatters toward the start of a piece of a ray (the sun above the air is 1), in two parts, and
// through: the share of light from behind the piece that passes it. Returned: what molecules scatter of the sun and
// the light scattered more than once. mie: what particles scatter of the sun, before their phase value
// (atmPhaseMie), which is constant along a ray and far from even across the sky: kept apart, a coarse table of it
// still gives a sharp glow round the sun. ro is the start relative to the centre of the sphere, rd the unit
// direction, len the length of the piece inside the shell of air.
vec3 atmSegmentParts(vec3 ro, vec3 rd, float len, int count, out vec3 mie, out vec3 through) {
  through = vec3(1.0);
  mie = vec3(0.0);
  vec3 light = vec3(0.0);
  if (len <= 0.0) return light;
  float Rg = u_atmShell.x;
  vec3 sunDir = u_atmSun.xyz;
  float cosT = dot(rd, sunDir);
  float phaseR = 0.0596831 * (1.0 + cosT * cosT);
  float dt = len / float(count);
  float r = max(length(ro), 1.0);
  float mu = dot(ro, sunDir) / r;
  vec3 dA = atmDensity(r - Rg);
  vec3 sunA = atmSunAt(r, mu);
  vec3 msA = atmMultiAt(r - Rg, mu);
  for (int i = 1; i <= ${MAX_STEPS}; i++) {
    if (i > count) break;
    vec3 p = ro + rd * (dt * float(i));
    r = max(length(p), 1.0);
    mu = dot(p, sunDir) / r;
    vec3 dB = atmDensity(r - Rg);
    vec3 sunB = atmSunAt(r, mu);
    vec3 msB = atmMultiAt(r - Rg, mu);
    float rhoR = atmMean(dA.x, dB.x);
    float rhoM = atmMean(dA.y, dB.y);
    float rhoO = 0.5 * (dA.z + dB.z);
    vec3 scatR = u_atmRayleigh.rgb * rhoR;
    float scatM = u_atmMie.x * rhoM;
    vec3 ext = scatR + vec3(u_atmMie.y * rhoM) + u_atmAbsorb.rgb * rhoO;
    vec3 sun = 0.5 * (sunA + sunB);
    vec3 x = ext * dt;
    vec3 stepT = exp(-x);
    // The piece's own share, exact for an even source; for very thin air the series, which does not cancel.
    vec3 part = through * mix(dt * (1.0 - 0.5 * x), (1.0 - stepT) / max(ext, vec3(1e-20)), step(vec3(1e-3), x));
    light += part * (sun * scatR * phaseR + 0.5 * (msA + msB) * (scatR + vec3(scatM)));
    mie += part * sun * scatM;
    through *= stepT;
    dA = dB;
    sunA = sunB;
    msA = msB;
  }
  return light;
}

// The same as one light: both parts, the particles' with their phase value.
vec3 atmSegment(vec3 ro, vec3 rd, float len, int count, out vec3 through) {
  vec3 mie;
  vec3 light = atmSegmentParts(ro, rd, len, count, mie, through);
  return light + mie * atmPhaseMie(dot(rd, u_atmSun.xyz));
}

// Scattered light as a screen-space colour.
vec3 atmDisplay(vec3 light) {
  return 1.0 - exp(-light * u_atmSun.w);
}

// The air's light under an overcast sky: the sun that lights it is mostly behind the clouds, so it is dimmer and grey.
vec3 atmUnderCloud(vec3 air) {
  float oc = u_atmCloud.x;
  return oc > 0.0 ? mix(air, vec3(dot(air, vec3(0.3, 0.59, 0.11))), 0.75 * oc) * (1.0 - 0.6 * oc) : air;
}

// The eye relative to the centre of the sphere. Its distance comes from the height computed on the CPU, which stays
// exact a metre above a sphere thousands of kilometres across.
vec3 atmEye(out float h) {
  h = max(u_atmEye.w, 0.5);
  vec3 e = u_atmEye.xyz - atmCenter();
  return e * ((u_atmShell.x + h) / max(length(e), 1.0));
}

// The air along a view ray from the eye: the scattered light (the sun above the air is 1), through: the share of
// what lies behind the air that still shows, ground: 1 when the ray ends on the ground sphere.
vec3 atmosphereSky(vec3 dir, out vec3 through, out float ground) {
  through = vec3(1.0);
  ground = 0.0;
  if (u_atmSun.w <= 0.0) return vec3(0.0);
  float Rg = u_atmShell.x;
  float Rt = u_atmShell.y;
  float h;
  vec3 ro = atmEye(h);
  float r0 = Rg + h;
  float b = dot(ro, dir);
  // r0² − Rt² and r0² − Rg², from the heights.
  float ct = (r0 - Rt) * (r0 + Rt);
  float cg = h * (2.0 * Rg + h);
  float dTop = b * b - ct;
  if (dTop <= 0.0) return vec3(0.0);
  float sq = sqrt(dTop);
  float t0 = max(-b - sq, 0.0);
  float t1 = -b + sq;
  float dGround = b * b - cg;
  if (b < 0.0 && dGround > 0.0) {
    t1 = min(t1, -b - sqrt(dGround));
    ground = 1.0;
  }
  if (t1 <= t0) return vec3(0.0);
  return atmSegment(ro + dir * t0, dir, t1 - t0, ATM_SKY_STEPS, through);
}

// The air between the eye and a point of the scene: the light it scatters toward the eye (the sun above the air is
// 1), and through: the share of the point's own colour that passes.
vec3 atmAirTo(vec3 worldPos, out vec3 through) {
  through = vec3(1.0);
  vec3 d = worldPos - u_atmEye.xyz;
  float len = length(d);
  if (len < 1e-3) return vec3(0.0);
  vec3 dir = d / len;
  float Rt = u_atmShell.y;
  float h;
  vec3 ro = atmEye(h);
  float r0 = u_atmShell.x + h;
  float b = dot(ro, dir);
  float dTop = b * b - (r0 - Rt) * (r0 + Rt);
  if (dTop <= 0.0) return vec3(0.0);
  float sq = sqrt(dTop);
  float t0 = max(-b - sq, 0.0);
  float t1 = min(-b + sq, len);
  if (t1 <= t0) return vec3(0.0);
  return atmSegment(ro + dir * t0, dir, t1 - t0, ATM_AIR_STEPS, through);
}

// The air between the eye and a point of the scene, integrated here and now: screen-space colour in, screen-space
// colour out. Identity in a view without an eye. In a fragment shader this is the integral per pixel; a material
// with vertices close enough together takes it there instead (atmosphereAir) and applies the result below.
vec3 atmosphereApply(vec3 display, vec3 worldPos) {
  if (u_atmSun.w <= 0.0) return display;
  vec3 through;
  vec3 air = atmAirTo(worldPos, through);
  return display * through + atmDisplay(atmUnderCloud(air));
}

// For a vertex shader: the air between the eye and the vertex, as the two values the fragment shader hands to
// atmosphereApply below. Both change slowly over a surface, so the rasteriser may carry them across a triangle.
// Returned: the scattered light, through: the share of the surface's colour that passes. In the reference quality
// nothing is integrated here.
vec3 atmosphereAir(vec3 worldPos, out vec3 through) {
  through = vec3(1.0);
  if (u_atmSun.w <= 0.0 || u_atmNight.w > 0.5) return vec3(0.0);
  return atmAirTo(worldPos, through);
}

// The air in front of a fragment from what atmosphereAir gave at the vertices: screen-space colour in, screen-space
// colour out. In the reference quality the fragment integrates its own view ray instead.
vec3 atmosphereApply(vec3 display, vec3 worldPos, vec3 air, vec3 through) {
  if (u_atmSun.w <= 0.0) return display;
  if (u_atmNight.w > 0.5) return atmosphereApply(display, worldPos);
  return display * through + atmDisplay(atmUnderCloud(air));
}

// Colour of the direct sun at a point, as a multiple of the surface colour: white above the air, red through a long
// way of it, nothing on the night side.
vec3 atmosphereSun(vec3 worldPos) {
  vec3 p = worldPos - atmCenter();
  float r = max(length(p), 1.0);
  return u_atmLight.rgb * atmSunAt(r, dot(p, u_atmSun.xyz) / r);
}

// Light on a surface as a multiple of its colour, in the place of lightOn: the sun through the air over the point,
// the sky's light there and what remains at night. sun is the share of direct light (shadows, clouds), ao the share
// of the surroundings' light. Under an overcast sky (u_atmCloud.x) the sky's light turns into the light the clouds pass
// on: grey, a share of the sun and the sky above them, nearly the same from every side, so the ground is lit flat;
// the sun through a gap comes in through sun (the cloud shadows).
vec3 atmosphereLight(vec3 worldPos, vec3 n, float sun, float ao) {
  vec3 p = worldPos - atmCenter();
  float r = max(length(p), 1.0);
  vec3 up = p / r;
  vec3 s = u_atmSun.xyz;
  float mu = dot(up, s);
  vec3 sunHere = atmSunAt(r, mu);
  vec3 direct = sunHere * (max(dot(n, s), 0.0) * sun);
  vec3 skyHere = atmSkyLightAt(r - u_atmShell.x, mu) * u_atmLight.w;
  vec3 sky = skyHere * (0.5 + 0.5 * dot(n, up));
  float oc = u_atmCloud.x;
  if (oc > 0.0) {
    float above = dot(sunHere * max(mu, 0.0) + skyHere, vec3(0.3, 0.59, 0.11));
    sky = mix(sky, vec3(above * ${OVERCAST_LIGHT} * (0.75 + 0.25 * dot(n, up))), oc);
  }
  return u_atmLight.rgb * (direct + sky * ao) + u_atmNight.rgb * ao;
}
`;
}

/** The functions a material may call without asking: no air, the colour passes unchanged. Registered as `<atmosphere>` when there is no atmosphere slot. */
export const ATMOSPHERE_FALLBACK = /* glsl */ `
vec3 atmosphereApply(vec3 display, vec3 worldPos) { return display; }
vec3 atmosphereAir(vec3 worldPos, out vec3 through) { through = vec3(1.0); return vec3(0.0); }
vec3 atmosphereApply(vec3 display, vec3 worldPos, vec3 air, vec3 through) { return display; }
`;

/**
 * The atmosphere slot. Pass it in the engine's slots together with an `AtmosphereLayer` of runtime, or use
 * `createEngine({ atmosphere })`, which does both. The medium part of the params is read once, here.
 */
export function atmosphereSlot(params: Partial<AtmosphereParams> = {}): AtmosphereSlot {
  const p: AtmosphereParams = { ...DEFAULT_ATMOSPHERE, eye: null, eyeHeightM: 0, ...params };
  const medium: AtmosphereMedium = {
    radiusM: p.radiusM,
    heightM: p.heightM,
    rayleigh: [p.rayleigh[0], p.rayleigh[1], p.rayleigh[2]],
    rayleighScaleM: p.rayleighScaleM,
    mieScattering: p.mieScattering,
    mieAbsorption: p.mieAbsorption,
    mieScaleM: p.mieScaleM,
    mieG: p.mieG,
    absorption: [p.absorption[0], p.absorption[1], p.absorption[2]],
    absorptionCenterM: p.absorptionCenterM,
    absorptionHalfWidthM: p.absorptionHalfWidthM,
    groundAlbedo: p.groundAlbedo,
  };
  const tables = atmosphereTables(medium);
  return {
    name: 'atmosphere',
    params: p,
    medium,
    tables,
    fields: [
      { member: 'u_atmSun', order: 1100, lanes: 'xyzw', doc: 'xyz true direction to the sun, w exposure of the scattered light (0: no air in this view)' },
      { member: 'u_atmEye', order: 1110, lanes: 'xyzw', doc: 'xyz eye, w its height above the ground sphere' },
      { member: 'u_atmShell', order: 1120, lanes: 'xyzw', doc: 'x radius of the ground sphere, y radius of the top of the air, z ground height where up is +y, w radius of the sun disc in radians' },
      { member: 'u_atmRayleigh', order: 1130, lanes: 'xyzw', doc: 'rgb scattering by molecules per metre at the ground, w 1 / its scale height' },
      { member: 'u_atmMie', order: 1140, lanes: 'xyzw', doc: 'x scattering by particles per metre at the ground, y their extinction, z 1 / their scale height, w forward share' },
      { member: 'u_atmAbsorb', order: 1150, lanes: 'xyzw', doc: 'rgb absorption per metre in the middle of the absorbing layer, w height of its middle' },
      { member: 'u_atmTune', order: 1160, lanes: 'xyzw', doc: 'x 1 / half-width of the absorbing layer, y, z scales of the tables of light scattered more than once and of sky light, w star visibility' },
      { member: 'u_atmLight', order: 1170, lanes: 'xyzw', doc: 'rgb the sun above the air as light on surfaces, w gain of the sky light on surfaces' },
      { member: 'u_atmNight', order: 1180, lanes: 'xyzw', doc: 'rgb light on surfaces without the sun, w 1: the reference quality, every pixel integrates its own view ray' },
      { member: 'u_atmCloud', order: 1190, lanes: 'xyzw', doc: 'x how overcast the sky over the eye is (atmosphereOvercast), yzw 0' },
    ],
    compute: (E, q) => computeAtmosphere(E, q, medium, tables),
    lanes: (v) => [
      ...v.sunDir,
      v.exposure,
      ...v.eye,
      v.eyeHeightM,
      v.radiusM,
      v.topM,
      v.groundY,
      v.sunDiscRad,
      ...v.rayleigh,
      v.invRayleighScale,
      v.mieScattering,
      v.mieExtinction,
      v.invMieScale,
      v.mieG,
      ...v.absorption,
      v.absorptionCenterM,
      v.invAbsorptionHalfWidth,
      v.multiScatterScale,
      v.skyLightScale,
      v.stars,
      ...v.sunLight,
      v.skyLightGain,
      ...v.nightLight,
      v.reference,
      v.overcast,
      0,
      0,
      0,
    ],
    glsl: atmosphereGlsl(p.skySteps, p.airSteps),
  };
}
