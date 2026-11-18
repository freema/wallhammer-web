// Colour tools for the painted look: a palette of base colours per material, hue / saturation / value jitter from a
// stream, gradients by height, and the common "darker at the foot, lighter at the top and on edges" ramp.
// Colours are rgb 0–1 in the space the shaders light in (the engine's lighting multiplies them directly).

import type { Vec3 } from './math.ts';
import { clamp, lerp, smoothstep } from './math.ts';
import type { Stream } from './rng.ts';

export type RGB = [number, number, number];

/** '#rrggbb' to rgb 0–1. */
export function hex(s: string): RGB {
  const v = parseInt(s.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const mixRgb = (a: readonly number[], b: readonly number[], t: number): RGB => [lerp(a[0]!, b[0]!, t), lerp(a[1]!, b[1]!, t), lerp(a[2]!, b[2]!, t)];
export const scaleRgb = (a: readonly number[], s: number): RGB => [a[0]! * s, a[1]! * s, a[2]! * s];
export const mulRgb = (a: readonly number[], b: readonly number[]): RGB => [a[0]! * b[0]!, a[1]! * b[1]!, a[2]! * b[2]!];

export function rgbToHsv(c: readonly number[]): Vec3 {
  const r = c[0]!, g = c[1]!, b = c[2]!;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** Shifts hue (turns), saturation and value (multipliers around 1 given as offsets). */
export function shiftHsv(c: readonly number[], dh: number, ds: number, dv: number): RGB {
  const [h, s, v] = rgbToHsv(c);
  return hsvToRgb(h + dh, clamp(s * (1 + ds), 0, 1), clamp(v * (1 + dv), 0, 1.2));
}

/** How much a colour may wander: hue in turns, saturation and value as relative amounts. */
export interface Variation {
  hue: number;
  sat: number;
  val: number;
}

export const VARY_SUBTLE: Variation = { hue: 0.012, sat: 0.08, val: 0.07 };
export const VARY_RICH: Variation = { hue: 0.03, sat: 0.18, val: 0.16 };

/** A variant of `c` drawn from a stream with keys (the same keys give the same variant). */
export function vary(c: readonly number[], v: Variation, s: Stream, ...keys: number[]): RGB {
  return shiftHsv(c, s.jitter(v.hue, ...keys, 1), s.jitter(v.sat, ...keys, 2), s.jitter(v.val, ...keys, 3));
}

/** A variant of `c` from the next numbers of a stream (sequential use inside one generator). */
export function varyNext(c: readonly number[], v: Variation, s: Stream): RGB {
  return shiftHsv(c, s.nextJitter(v.hue), s.nextJitter(v.sat), s.nextJitter(v.val));
}

/**
 * The painted ramp: `c` darkened toward `y0` (foot) and lightened toward `y1` (top), by `dark` and `light`. Typical
 * use: walls darker where they meet the ground, foliage lighter on top.
 */
export function heightRamp(c: readonly number[], y: number, y0: number, y1: number, dark = 0.35, light = 0.12): RGB {
  const t = smoothstep(y0, y1, y);
  return scaleRgb(c, lerp(1 - dark, 1 + light, t));
}

/** A gradient through several colours over 0–1. */
export function gradient(stops: readonly (readonly [number, RGB])[], t: number): RGB {
  if (t <= stops[0]![0]) return [...stops[0]![1]];
  for (let i = 1; i < stops.length; i++) {
    const [ta, ca] = stops[i - 1]!;
    const [tb, cb] = stops[i]!;
    if (t <= tb) return mixRgb(ca, cb, (t - ta) / (tb - ta || 1));
  }
  return [...stops[stops.length - 1]![1]];
}

/**
 * Base colours of the village, picked from the concept: warm timber, cream plaster, grey-violet stone, blue slate,
 * red and rust shingles, saturated greens. Generators vary them per piece (`vary`) rather than adding new ones.
 */
export const PALETTE = {
  timberDark: hex('#4a2e1c'),
  timber: hex('#7a4e2c'),
  timberLight: hex('#a8743f'),
  plank: hex('#8c5a32'),
  plaster: hex('#e8d6ae'),
  plasterWarm: hex('#e2c48f'),
  stone: hex('#8d8790'),
  stoneWarm: hex('#a49582'),
  stoneDark: hex('#5f5866'),
  cobble: hex('#9a8c7c'),
  slate: hex('#3f4f9a'),
  slateLight: hex('#5f74c4'),
  slateViolet: hex('#4b3f86'),
  roofRed: hex('#b23a2a'),
  roofRust: hex('#a8562a'),
  roofMoss: hex('#7a6a3a'),
  thatch: hex('#c49a52'),
  grass: hex('#6f9a3a'),
  grassLight: hex('#a8c25a'),
  grassDry: hex('#b2a856'),
  dirt: hex('#8a6440'),
  dirtLight: hex('#b08a5c'),
  foliageDark: hex('#2f5a2a'),
  foliage: hex('#5c8e34'),
  foliageLight: hex('#a6c050'),
  conifer: hex('#2e5440'),
  bark: hex('#5a3a26'),
  barkLight: hex('#8a6040'),
  water: hex('#2f6f86'),
  waterShallow: hex('#5fa8a8'),
  foam: hex('#e8f2f0'),
  fabricRed: hex('#a8302a'),
  fabricCream: hex('#eadcb4'),
  fabricBlue: hex('#2f4a9a'),
  fabricGreen: hex('#4a7a3a'),
  iron: hex('#3a3a42'),
  ironLight: hex('#6a6a74'),
  gold: hex('#d8a83a'),
  windowGlow: hex('#ffc65a'),
  fire: hex('#ff8a2a'),
  ember: hex('#ff4a1a'),
  skin: hex('#e0a47a'),
  skinDark: hex('#a8704a'),
  hairBrown: hex('#5a3a22'),
  hairBlond: hex('#c89a52'),
  hairRed: hex('#a8482a'),
  hairGrey: hex('#9a948c'),
  flowerPink: hex('#e86a9a'),
  flowerWhite: hex('#f2eee0'),
  flowerYellow: hex('#f2c83a'),
  flowerViolet: hex('#8a5ac8'),
  cabbage: hex('#7aa84a'),
  pumpkin: hex('#e0782a'),
  apple: hex('#c83a2a'),
} as const satisfies Record<string, RGB>;
