// The palette of the outpost: every surface colour of the scene, read off the concept art, in one table. Colours are
// display (sRGB) values: the toon material writes the lit colour of a surface as it is, so `#e8e2d2` here is
// `#e8e2d2` on the screen. Shade and shadow are fixed multiples of it (style/materials.ts, STYLE.mid and STYLE.shadow; patches: STYLE.toneDark and toneLight), not
// separate colours, so a builder only ever picks one name per surface.
//
// To add a colour: add a row here with a short comment where it is used; never write a hex value into a builder.

export const PALETTE = {
  // Ground and rock.
  ground: '#8f8e8a',
  groundLight: '#a3a29d',
  rock: '#8d8c88',
  rockDark: '#76756f',
  ridge: '#8a8985',
  track: '#6f6e6a',
  tread: '#5a5955',

  // Structures: warm off-white shells, a slightly darker panel grey, concrete footings.
  shell: '#ebe5d6',
  shellPanel: '#d8d1c0',
  concrete: '#aaa79f',
  concreteDark: '#8e8b84',

  // Trim, glazing, metal.
  orange: '#ef7b22',
  orangeDark: '#c95f12',
  teal: '#137479',
  tealLight: '#2a9a9b',
  metal: '#4b4c51',
  metalMid: '#7d7f85',
  metalLight: '#b4b5b8',
  rubber: '#2f2f32',
  cable: '#3b4d52', // wound cable on the reel
  lamp: '#f4e9b0', // lamp faces of the floodlight

  // Landing pad.
  padAsphalt: '#5b5c60',
  marking: '#ece8de',

  // The planet over the horizon.
  ocean: '#1f63a6',
  oceanDeep: '#174f8a',
  land: '#5da84a',
  landDark: '#4a8f3c',
  ice: '#eef0ec',

  // Lines and the sky.
  outline: '#1b1b1e',
  sky: '#000000',
} as const;

export type PaletteName = keyof typeof PALETTE;

export type RGB = readonly [number, number, number];

const cache = new Map<string, RGB>();

/** A palette colour as 0–1 display values. */
export function rgb(name: PaletteName): RGB {
  let c = cache.get(name);
  if (!c) {
    const h = PALETTE[name];
    c = [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
    cache.set(name, c);
  }
  return c;
}

/** A colour as a GLSL `vec3(...)` literal. */
export function glslColor(name: PaletteName): string {
  const [r, g, b] = rgb(name);
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}
