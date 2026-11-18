// Palettes of the architecture kit: the base colours one building is painted from. Generators vary them per piece
// (beam by beam, stone by stone, shingle by shingle), so a palette only names the families. Presets for the buildings
// of the concept: the inn (blue-violet slate), cottages with red or rust shingles, the forge, the mill, thatch.

import type { RGB } from '../kit/index.ts';
import { PALETTE, hex, mixRgb } from '../kit/index.ts';
import type { Structure } from '../layout.ts';

export interface ArchPalette {
  /** Timber frame, darker timber (corner posts, brackets), planks (doors, shutters, boxes). */
  timber: RGB;
  timberDark: RGB;
  plank: RGB;
  /** Plaster infill and its warm patches. */
  plaster: RGB;
  plasterWarm: RGB;
  /** Stone blocks: main, warm and dark variants (picked per block). */
  stone: RGB;
  stoneWarm: RGB;
  stoneDark: RGB;
  /** Shingles: the main colour and accent colours mixed in for single shingles. */
  roof: RGB;
  roofAccents: RGB[];
  /** Under the shingles (seen through gaps and missing shingles) and under the eaves. */
  roofDeck: RGB;
  roofUnder: RGB;
  /** Ridge caps. */
  ridge: RGB;
  /** Shutters and door leaves. */
  shutter: RGB;
  door: RGB;
  /** Iron fittings, lantern frames. */
  iron: RGB;
  /** Window light (also the day colour of the panes). */
  glow: RGB;
  /** Banner cloth, its trim and the emblem. */
  fabric: RGB;
  trim: RGB;
  /** Flower colours of window boxes and their leaves. */
  flowers: RGB[];
  leaves: RGB;
}

const FLOWERS: RGB[] = [PALETTE.flowerPink, PALETTE.flowerWhite, PALETTE.flowerYellow, PALETTE.flowerViolet, hex('#e0483a')];

/** The inn: dark warm timber, cream plaster, grey-violet stone, blue-violet slate, blue banner with gold. */
export const INN_PALETTE: ArchPalette = {
  timber: hex('#5e3a22'),
  timberDark: hex('#43281a'),
  plank: hex('#86542e'),
  plaster: hex('#ecdcb4'),
  plasterWarm: hex('#e4c894'),
  stone: hex('#8f8894'),
  stoneWarm: hex('#a2968a'),
  stoneDark: hex('#676070'),
  roof: hex('#46559e'),
  roofAccents: [hex('#5a6cbc'), hex('#4a3f8a'), hex('#3a4688'), hex('#6270b0')],
  roofDeck: hex('#2a2440'),
  roofUnder: hex('#4a3020'),
  ridge: hex('#3a4280'),
  shutter: hex('#3d5a8c'),
  door: hex('#7a4a28'),
  iron: PALETTE.iron,
  glow: hex('#ffc25a'),
  fabric: hex('#2c4aa0'),
  trim: PALETTE.gold,
  flowers: FLOWERS,
  leaves: hex('#4f8a32'),
};

/** Cottage with red shingles. */
export const COTTAGE_RED: ArchPalette = {
  ...INN_PALETTE,
  timber: hex('#6a4226'),
  plaster: hex('#eadab0'),
  plasterWarm: hex('#e0c088'),
  roof: PALETTE.roofRed,
  roofAccents: [hex('#c84a32'), hex('#962e24'), hex('#b8502e'), hex('#a8402e')],
  roofDeck: hex('#3a2018'),
  ridge: hex('#8a2a20'),
  shutter: hex('#4a6a3a'),
  fabric: PALETTE.fabricRed,
};

/** Cottage (and mill) with rust shingles. */
export const COTTAGE_RUST: ArchPalette = {
  ...COTTAGE_RED,
  roof: PALETTE.roofRust,
  roofAccents: [hex('#b8642e'), hex('#8e4422'), hex('#c07038'), hex('#9a5a30')],
  ridge: hex('#7a3a1c'),
  shutter: hex('#8a3a2a'),
};

/** Thatch-coloured covering (the windmill): shingles read as bundles of straw. */
export const THATCH_PALETTE: ArchPalette = {
  ...COTTAGE_RUST,
  roof: PALETTE.thatch,
  roofAccents: [hex('#d2aa60'), hex('#a8823e'), hex('#b8944c')],
  roofDeck: hex('#5a4020'),
  ridge: hex('#8a6a34'),
};

/** The forge: sooty timber, warm stone, red shingles. */
export const FORGE_PALETTE: ArchPalette = {
  ...COTTAGE_RED,
  timber: hex('#4e3220'),
  stone: hex('#8a8086'),
  stoneWarm: hex('#9a8a7a'),
  plaster: mixRgb(hex('#eadab0'), hex('#a09080'), 0.25),
};

/** The palette of a structure by its covering. */
export function paletteFor(s: Structure): ArchPalette {
  if (s.kind === 'inn') return INN_PALETTE;
  if (s.kind === 'forge') return FORGE_PALETTE;
  switch (s.roof) {
    case 'slate':
      return INN_PALETTE;
    case 'rust':
      return COTTAGE_RUST;
    case 'thatch':
      return THATCH_PALETTE;
    default:
      return COTTAGE_RED;
  }
}
