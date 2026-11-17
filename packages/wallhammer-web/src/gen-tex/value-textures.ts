// Numbers as textures, for layers that show values over a scene: values quantised to 16-bit words (one word per grid
// cell, point or table row), the words as a two-byte texture, and colour ramps as a one-row texture. What the numbers
// mean is the caller's business; here they are a range from `min` to `max` and a word that says "no value".

import type { RGB } from '../base/math.ts';
import type { TextureData } from '../base/data.ts';

/** The word that means "no value here". */
export const NO_VALUE = 0;
/** Largest word; the words 1–65535 span the value range linearly. */
export const VALUE_WORD_MAX = 65535;
/** Widest table texture: rows of a table wrap at this width. */
export const VALUE_TABLE_WIDTH = 1024;

/** One stop of a colour ramp: a position 0–1 and the colour shown there (as it should appear on the screen). */
export interface RampStop {
  at: number;
  color: RGB;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const even = (colors: readonly string[]): RampStop[] => colors.map((c, i) => ({ at: i / (colors.length - 1), color: hex(c) }));

/** Ready-made ramps. `diverging` has its neutral colour in the middle of the range. */
export const VALUE_RAMPS = {
  viridis: even(['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725']),
  heat: even(['#ffffcc', '#fed976', '#fd8d3c', '#e31a1c', '#800026']),
  blues: even(['#f7fbff', '#9ecae1', '#4292c6', '#08519c', '#08306b']),
  diverging: even(['#2166ac', '#92c5de', '#f7f7f7', '#f4a582', '#b2182b']),
  grey: even(['#f2f2f2', '#262626']),
} as const satisfies Record<string, readonly RampStop[]>;

export type ValueRampName = keyof typeof VALUE_RAMPS;

/**
 * Colour of a ramp at position `t` (0–1). Stops are sorted by position here, so their order does not matter. With
 * `bands` > 0 the ramp has that many flat steps, each in the colour of its middle.
 */
export function rampColor(stops: readonly RampStop[], t: number, bands = 0): RGB {
  if (stops.length === 0) return [1, 0, 1];
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  let u = Math.min(1, Math.max(0, t));
  if (bands > 0) u = (Math.min(bands - 1, Math.floor(u * bands)) + 0.5) / bands;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (u <= first.at) return first.color;
  if (u >= last.at) return last.color;
  for (let k = 1; k < sorted.length; k++) {
    const hi = sorted[k]!;
    if (u > hi.at) continue;
    const lo = sorted[k - 1]!;
    const span = hi.at - lo.at;
    const f = span > 0 ? (u - lo.at) / span : 0;
    return [lo.color[0] + (hi.color[0] - lo.color[0]) * f, lo.color[1] + (hi.color[1] - lo.color[1]) * f, lo.color[2] + (hi.color[2] - lo.color[2]) * f];
  }
  return last.color;
}

/** A ramp as a 256 × 1 texture: texel k holds the colour at (k + 0.5) / 256. Smooth ramps filter linearly, banded ones not. */
export function colorRamp(stops: readonly RampStop[], bands = 0): TextureData {
  const data = new Uint8Array(256 * 4);
  for (let k = 0; k < 256; k++) {
    const c = rampColor(stops, (k + 0.5) / 256, bands);
    data[k * 4] = Math.round(c[0] * 255);
    data[k * 4 + 1] = Math.round(c[1] * 255);
    data[k * 4 + 2] = Math.round(c[2] * 255);
    data[k * 4 + 3] = 255;
  }
  return { width: 256, height: 1, format: 'rgba8', data, filter: bands > 0 ? 'nearest' : 'linear' };
}

/**
 * Values as words: `min` becomes 1, `max` becomes 65535, values outside are clamped, and a value that is not a finite
 * number becomes `NO_VALUE`. `out` is reused when it is long enough.
 */
export function quantizeValues(values: ArrayLike<number>, min: number, max: number, out?: Uint16Array): Uint16Array {
  const n = values.length;
  const words = out && out.length >= n ? out : new Uint16Array(n);
  const span = max - min;
  const k = span > 0 ? (VALUE_WORD_MAX - 1) / span : 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) words[i] = NO_VALUE;
    else words[i] = 1 + Math.round(Math.min(VALUE_WORD_MAX - 1, Math.max(0, (v - min) * k)));
  }
  return words;
}

/** The value a word stands for, or NaN for `NO_VALUE`. */
export function wordValue(word: number, min: number, max: number): number {
  return word === NO_VALUE ? NaN : min + ((word - 1) / (VALUE_WORD_MAX - 1)) * (max - min);
}

/** Size of the table texture that holds `count` rows: rows fill it line by line and wrap at `VALUE_TABLE_WIDTH`. */
export function valueTableSize(count: number): { width: number; height: number } {
  const n = Math.max(1, count);
  const width = Math.min(n, VALUE_TABLE_WIDTH);
  return { width, height: Math.ceil(n / width) };
}

/**
 * Words as a two-channel byte texture of `width` × `height` (red = low byte, green = high byte), read with
 * `texelFetch`. Row 0 of the words is row 0 of the texture. Missing words at the end are `NO_VALUE`.
 */
export function wordTexture(words: Uint16Array, width: number, height: number): TextureData {
  const cells = width * height;
  const data = new Uint8Array(cells * 2);
  const n = Math.min(cells, words.length);
  for (let i = 0; i < n; i++) {
    const w = words[i]!;
    data[i * 2] = w & 255;
    data[i * 2 + 1] = w >> 8;
  }
  return { width, height, format: 'rg8', data, filter: 'nearest' };
}
