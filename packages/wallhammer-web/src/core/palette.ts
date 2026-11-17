// Palette mechanism: a project names its colours, the engine turns them into a colour table for the shaders and
// hands back typed keys and row indices. The engine itself holds no colours.
//
//   const palette = definePalette({ ground: '#4d4335', sky: '#6795b1' });
//   palette.index('sky')  // 1, the row a shader reads as u_palette[1]
//   palette.color('sky')  // [r, g, b] in 0–1, display space (sRGB)
//
// Rows keep the order in which the object lists them, so the table is the same byte for byte on every run.

import type { RGB } from '../base/math.ts';

/** Largest number of rows the shaders expect (size of the Palette uniform block). */
export const PALETTE_CAPACITY = 96;

export interface Palette<K extends string> {
  /** Row names in row order. */
  readonly keys: readonly K[];
  /** Row index of a colour: the number that goes into vertices and shader uniforms. */
  index(key: K): number;
  /** Colour of a row as three numbers 0–1 in display space (sRGB). */
  color(key: K): RGB;
  /** The table for the Palette uniform block: `PALETTE_CAPACITY` vec4 rows, unused rows are zero. */
  data(): Float32Array;
}

function hexToRgb(hex: string): RGB {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const v = Number.parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Builds a palette from named `#rrggbb` rows. */
export function definePalette<const R extends Record<string, string>>(rows: R): Palette<Extract<keyof R, string>> {
  type K = Extract<keyof R, string>;
  const keys = Object.keys(rows) as K[];
  if (keys.length > PALETTE_CAPACITY) throw new Error(`The palette has ${keys.length} rows, the shaders hold ${PALETTE_CAPACITY}`);
  const colors = keys.map((k) => hexToRgb(rows[k]!));
  const indexOf = new Map<K, number>(keys.map((k, i) => [k, i]));
  return {
    keys,
    index(key: K): number {
      const i = indexOf.get(key);
      if (i === undefined) throw new Error(`Unknown palette row: ${key}`);
      return i;
    },
    color(key: K): RGB {
      const c = colors[this.index(key)]!;
      return [c[0], c[1], c[2]];
    },
    data(): Float32Array {
      const out = new Float32Array(PALETTE_CAPACITY * 4);
      colors.forEach((c, i) => {
        out[i * 4] = c[0];
        out[i * 4 + 1] = c[1];
        out[i * 4 + 2] = c[2];
        out[i * 4 + 3] = 1;
      });
      return out;
    },
  };
}
