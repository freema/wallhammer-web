// Texture generators: byte rasters and colour tables as texture data, and a separable blur for masks.

import type { RGB } from '../base/math.ts';
import type { TextureData } from '../base/data.ts';

/** A byte raster (one byte per pixel, row 0 first) as an unsigned integer texture, read with `texelFetch`. */
export function codeTexture(codes: Uint8Array, cols: number, rows: number): TextureData {
  return { width: cols, height: rows, format: 'r8ui', data: codes };
}

/** Table of 256 colours by code, one row. A code not in the table gets `fallback`. */
export function colorTable(colors: ReadonlyMap<number, RGB>, fallback: RGB = [1, 0, 1]): TextureData {
  const data = new Uint8Array(256 * 4);
  for (let code = 0; code < 256; code++) {
    const c = colors.get(code) ?? fallback;
    data[code * 4] = Math.round(c[0] * 255);
    data[code * 4 + 1] = Math.round(c[1] * 255);
    data[code * 4 + 2] = Math.round(c[2] * 255);
    data[code * 4 + 3] = 255;
  }
  return { width: 256, height: 1, format: 'rgba8', data };
}

/** Blurs one channel with a moving average, twice horizontally and twice vertically. */
export function boxBlur(src: Float32Array, cols: number, rows: number, radius: number): Float32Array {
  let a: Float32Array = src;
  let b: Float32Array = new Float32Array(src.length);
  const pass = (horizontal: boolean): void => {
    const n = horizontal ? cols : rows;
    const lines = horizontal ? rows : cols;
    const stride = horizontal ? 1 : cols;
    const lineStride = horizontal ? cols : 1;
    const win = 2 * radius + 1;
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[base + Math.min(n - 1, Math.max(0, k)) * stride]!;
      for (let k = 0; k < n; k++) {
        b[base + k * stride] = sum / win;
        const add = Math.min(n - 1, k + radius + 1);
        const sub = Math.max(0, k - radius);
        sum += a[base + add * stride]! - a[base + sub * stride]!;
      }
    }
    const t = a;
    a = b;
    b = t === src ? new Float32Array(src.length) : t;
  };
  pass(true);
  pass(false);
  pass(true);
  pass(false);
  return a;
}
