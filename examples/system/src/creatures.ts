// The creatures of Hearth as rig descriptions (NSO-714): villagers in plain old clothes, skeletons of pale rods, a
// four-legged pack beast and a small field grazer, and a look per creature from a stateless hash of its seed. Pure
// data: the engine's rig tool poses them (free gait and chains for the four-legged ones), life.ts says where they are.
//
// Local axes of every rig: x right, y up, z forward, the feet on the ground at the origin.

import { packRgb } from 'wallhammer-web/base';
import type { RigDesc, RigPart } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';

/** The kinds of creatures, in the order of `creatureRigs`. */
export const CREATURE = { villager: 0, skeleton: 1, beast: 2, grazer: 3 } as const;
/** Instances per kind at most, 300 in all (`LIFE_MAX` of life.ts). */
export const CREATURE_CAP: readonly number[] = [200, 24, 40, 36];
/** Variant bits per kind: villager hood 0, pack 1, staff 2; beast load 0. */
export const CREATURE_VARIANT = { hood: 0, pack: 1, staff: 2, load: 0 } as const;
/** A villager whose seed has this bit set carries a pack (life.ts sets it for the lone walkers of the roads). */
export const VILLAGER_PACK_BIT = 1;

type V3 = readonly [number, number, number];
const box = (size: V3, at: V3, extra: Partial<RigPart> = {}): RigPart => ({ shape: { kind: 'box', size }, at, ...extra });

/** A person of 1.7 m: legs in the pair gait, arms that swing, a head that looks round while standing. */
function villagerRig(): RigDesc {
  const HIP = 0.84;
  const parts: RigPart[] = [];
  for (const side of [-1, 1] as const) {
    const x = 0.09 * side;
    const phase = side < 0 ? 0 : 0.5;
    const pivot: V3 = [x, HIP, 0];
    parts.push(box([0.13, HIP - 0.04, 0.15], [x, HIP / 2 + 0.02, 0], { pivot, motion: 'limb', amount: HIP, phase, slot: 1 }));
    parts.push(box([0.12, 0.07, 0.25], [x, 0.035, 0.04], { pivot, motion: 'limb', amount: HIP, phase, tint: [0.24, 0.17, 0.11], nearOnly: true }));
    const shoulder: V3 = [0.23 * side, 1.38, 0];
    const armPhase = side < 0 ? 0.5 : 0;
    parts.push(box([0.09, 0.6, 0.11], [0.23 * side, 1.1, 0], { pivot: shoulder, motion: 'swing', amount: 0.3, phase: armPhase, slot: 0 }));
    parts.push(box([0.08, 0.09, 0.09], [0.23 * side, 0.76, 0.01], { pivot: shoulder, motion: 'swing', amount: 0.3, phase: armPhase, slot: 2, nearOnly: true }));
  }
  // A tunic over the hips and a belt, the head with its hair, a hood, a pack and a staff as variants.
  parts.push({ shape: { kind: 'frustum', r0: 0.22, r1: 0.2, height: 0.62, sides: 6, depth: 0.65, cap: true }, at: [0, HIP - 0.1, 0], slot: 0 });
  parts.push(box([0.36, 0.06, 0.24], [0, HIP + 0.06, 0], { tint: [0.28, 0.2, 0.13] }));
  const neck: V3 = [0, 1.45, 0];
  parts.push({ shape: { kind: 'frustum', r0: 0.09, r1: 0.085, height: 0.24, sides: 6, cap: true }, at: [0, 1.45, 0.01], pivot: neck, motion: 'look', amount: 0.45, slot: 2 });
  parts.push(box([0.19, 0.07, 0.2], [0, 1.68, -0.01], { pivot: neck, motion: 'look', amount: 0.45, slot: 3, nearOnly: true }));
  parts.push(box([0.25, 0.3, 0.26], [0, 1.6, -0.03], { pivot: neck, motion: 'look', amount: 0.45, slot: 0, tint: [0.85, 0.85, 0.85], variant: CREATURE_VARIANT.hood }));
  parts.push(box([0.32, 0.42, 0.2], [0, 1.18, -0.22], { tint: [0.42, 0.31, 0.2], variant: CREATURE_VARIANT.pack }));
  parts.push({ shape: { kind: 'rod', dir: [0, 1, 0.05], length: 1.75, thickness: 0.04 }, at: [0.3, 0.02, 0.12], pivot: [0.23, 1.38, 0], motion: 'swing', amount: 0.12, phase: 0, tint: [0.36, 0.26, 0.16], variant: CREATURE_VARIANT.staff, nearOnly: true });
  return { name: 'villager', parts, segments: [{ shadow: [0.3, 0.26, 0.02] }], stride: 1.4, height: 1.7, radius: 0.6, farPx: 18, hidePx: 6 };
}

/** A skeleton of the same height: thin pale rods, a rib box, a skull that wobbles; the pair gait, stiff arms. */
function skeletonRig(): RigDesc {
  const HIP = 0.86;
  const parts: RigPart[] = [];
  for (const side of [-1, 1] as const) {
    const x = 0.08 * side;
    const phase = side < 0 ? 0 : 0.5;
    const pivot: V3 = [x, HIP, 0];
    parts.push({ shape: { kind: 'rod', dir: [0, -1, 0], length: HIP, thickness: 0.045 }, at: pivot, pivot, motion: 'limb', amount: HIP, phase, slot: 0 });
    const shoulder: V3 = [0.19 * side, 1.38, 0];
    parts.push({ shape: { kind: 'rod', dir: [0.05 * side, -1, 0], length: 0.62, thickness: 0.04 }, at: shoulder, pivot: shoulder, motion: 'swing', amount: 0.22, phase: side < 0 ? 0.5 : 0, slot: 0 });
  }
  parts.push(box([0.26, 0.09, 0.12], [0, HIP + 0.02, 0], { slot: 0 }));
  parts.push({ shape: { kind: 'rod', dir: [0, 1, 0], length: 0.42, thickness: 0.05 }, at: [0, HIP, -0.02], slot: 0 });
  // The ribs: a hollow-looking box in a darker shade, and the bar of the shoulders.
  parts.push(box([0.3, 0.32, 0.2], [0, 1.2, 0], { slot: 1 }));
  parts.push({ shape: { kind: 'rod', dir: [1, 0, 0], length: 0.4, thickness: 0.045 }, at: [-0.2, 1.39, 0], slot: 0, nearOnly: true });
  const neck: V3 = [0, 1.45, 0];
  parts.push(box([0.18, 0.2, 0.21], [0, 1.57, 0.01], { pivot: neck, motion: 'wobble', amount: 0.12, slot: 0 }));
  parts.push(box([0.13, 0.06, 0.13], [0, 1.45, 0.05], { pivot: neck, motion: 'wobble', amount: 0.12, slot: 1, nearOnly: true }));
  return { name: 'skeleton', parts, segments: [{ shadow: [0.26, 0.22, 0.02] }], stride: 1.3, height: 1.7, radius: 0.6, farPx: 18, hidePx: 6 };
}

/**
 * A four-legged pack beast, 1.5 m at the back and 2.4 m long: front and hind limbs of different lengths in four
 * phases (free gait), a neck of three links carrying the head that nods (axis x), a tail of three links that swings
 * (axis z), and a load as a variant.
 */
function beastRig(): RigDesc {
  const parts: RigPart[] = [];
  const legs: [number, number, number, number][] = [
    // x, z, length, phase: left front, right front, left hind, right hind.
    [-0.17, 0.55, 0.9, 0],
    [0.17, 0.55, 0.9, 0.5],
    [-0.17, -0.58, 0.96, 0.75],
    [0.17, -0.58, 0.96, 0.25],
  ];
  for (const [x, z, L, phase] of legs) {
    const pivot: V3 = [x, L, z];
    parts.push(box([0.12, L, 0.14], [x, L / 2, z], { pivot, motion: 'limb', amount: L, phase, slot: 1 }));
    parts.push(box([0.14, 0.08, 0.16], [x, 0.04, z + 0.01], { pivot, motion: 'limb', amount: L, phase, tint: [0.16, 0.13, 0.11], nearOnly: true }));
  }
  parts.push(box([0.52, 0.56, 1.5], [0, 1.18, -0.02], { slot: 0 }));
  // The neck rises forward from the withers; its links and the head share the root and nod together.
  const root: V3 = [0, 1.3, 0.62];
  const neck = (at: V3, size: V3, extra: Partial<RigPart> = {}): RigPart => box(size, at, { pivot: root, motion: 'bend', axis: 'x', amount: 0.32, phase: 0.18, slot: 0, ...extra });
  parts.push(neck([0, 1.42, 0.78], [0.26, 0.34, 0.3]));
  parts.push(neck([0, 1.58, 0.92], [0.22, 0.32, 0.26]));
  parts.push(neck([0, 1.72, 1.04], [0.2, 0.28, 0.24], { slot: 3 }));
  parts.push(neck([0, 1.76, 1.24], [0.2, 0.2, 0.42]));
  parts.push(neck([-0.07, 1.92, 1.1], [0.05, 0.14, 0.05], { slot: 1, nearOnly: true }));
  parts.push(neck([0.07, 1.92, 1.1], [0.05, 0.14, 0.05], { slot: 1, nearOnly: true }));
  // The tail hangs from the rump and swings sideways.
  const tailRoot: V3 = [0, 1.38, -0.78];
  const tail = (at: V3, size: V3, extra: Partial<RigPart> = {}): RigPart => box(size, at, { pivot: tailRoot, motion: 'bend', axis: 'z', amount: 0.9, phase: 0.35, slot: 3, ...extra });
  parts.push(tail([0, 1.3, -0.8], [0.08, 0.2, 0.08]));
  parts.push(tail([0, 1.12, -0.82], [0.07, 0.2, 0.07]));
  parts.push(tail([0, 0.94, -0.83], [0.09, 0.2, 0.09], { nearOnly: true }));
  // The load: a pannier each side and a bundle on top.
  parts.push(box([0.2, 0.42, 0.6], [-0.36, 1.12, -0.05], { slot: 2, variant: CREATURE_VARIANT.load }));
  parts.push(box([0.2, 0.42, 0.6], [0.36, 1.12, -0.05], { slot: 2, variant: CREATURE_VARIANT.load, nearOnly: true }));
  parts.push(box([0.4, 0.22, 0.5], [0, 1.56, -0.05], { slot: 2, tint: [0.8, 0.8, 0.8], variant: CREATURE_VARIANT.load }));
  return {
    name: 'beast',
    parts,
    segments: [{ shadow: [0.45, 1.25, 0.05] }],
    stride: 1.9,
    gait: 'free',
    dip: 0.03,
    walkSpeed: [0.12, 0.7],
    height: 1.5,
    radius: 1.5,
    farPx: 18,
    hidePx: 5,
  };
}

/** A small field grazer of 0.7 m: four thin limbs in the free gait at a slow walk, a short neck of three links. */
function grazerRig(): RigDesc {
  const L = 0.38;
  const parts: RigPart[] = [];
  const legs: [number, number, number][] = [
    [-0.09, 0.22, 0],
    [0.09, 0.22, 0.5],
    [-0.09, -0.22, 0.75],
    [0.09, -0.22, 0.25],
  ];
  for (const [x, z, phase] of legs) {
    const pivot: V3 = [x, L, z];
    parts.push({ shape: { kind: 'rod', dir: [0, -1, 0], length: L, thickness: 0.06 }, at: pivot, pivot, motion: 'limb', amount: L, phase, slot: 1 });
  }
  parts.push(box([0.3, 0.3, 0.66], [0, 0.53, 0], { slot: 0 }));
  // The neck goes forward and down toward the grass; it sways slowly while the grazer stands.
  const root: V3 = [0, 0.6, 0.28];
  const neck = (at: V3, size: V3, extra: Partial<RigPart> = {}): RigPart => box(size, at, { pivot: root, motion: 'bend', axis: 'x', amount: 0.9, phase: 0.3, slot: 0, ...extra });
  parts.push(neck([0, 0.6, 0.38], [0.15, 0.17, 0.14]));
  parts.push(neck([0, 0.56, 0.48], [0.13, 0.15, 0.12]));
  parts.push(neck([0, 0.5, 0.58], [0.15, 0.15, 0.2], { slot: 1 }));
  parts.push(neck([-0.08, 0.57, 0.52], [0.09, 0.04, 0.05], { slot: 1, nearOnly: true }));
  parts.push(neck([0.08, 0.57, 0.52], [0.09, 0.04, 0.05], { slot: 1, nearOnly: true }));
  parts.push(box([0.06, 0.1, 0.06], [0, 0.6, -0.35], { slot: 0, nearOnly: true }));
  return {
    name: 'grazer',
    parts,
    segments: [{ shadow: [0.22, 0.42, 0.04] }],
    stride: 0.8,
    gait: 'free',
    dip: 0.015,
    walkSpeed: [0.04, 0.3],
    height: 0.7,
    radius: 0.7,
    farPx: 12,
    hidePx: 3,
  };
}

/** The rig of every kind, index = `CREATURE`. */
export function creatureRigs(): RigDesc[] {
  return [villagerRig(), skeletonRig(), beastRig(), grazerRig()];
}

/** How one creature looks: its height and width scale, the colours of the four slots (`packRgb`), its variant bits. */
export interface CreatureLook {
  heightScale: number;
  widthScale: number;
  colors: [number, number, number, number];
  variants: number;
}

type Rgb = readonly [number, number, number];
/** Plain old clothes: undyed wool, browns, faded greens and blues. */
const CLOTH: readonly Rgb[] = [
  [0.55, 0.48, 0.38], [0.42, 0.33, 0.24], [0.36, 0.4, 0.3], [0.3, 0.34, 0.42], [0.62, 0.58, 0.5], [0.46, 0.28, 0.22],
  [0.33, 0.3, 0.27], [0.5, 0.44, 0.3],
];
const HOSE: readonly Rgb[] = [[0.3, 0.26, 0.22], [0.24, 0.22, 0.2], [0.4, 0.36, 0.3], [0.28, 0.3, 0.26]];
const SKIN: readonly Rgb[] = [[0.86, 0.7, 0.6], [0.8, 0.62, 0.5], [0.72, 0.54, 0.42], [0.58, 0.42, 0.32], [0.9, 0.76, 0.66]];
const HAIR: readonly Rgb[] = [[0.2, 0.15, 0.11], [0.12, 0.1, 0.09], [0.42, 0.3, 0.2], [0.62, 0.52, 0.36], [0.56, 0.55, 0.53]];
const BONE: readonly Rgb[] = [[0.88, 0.86, 0.78], [0.82, 0.8, 0.72], [0.92, 0.9, 0.84]];
const COAT: readonly Rgb[] = [[0.42, 0.3, 0.2], [0.3, 0.22, 0.16], [0.55, 0.45, 0.34], [0.2, 0.18, 0.16], [0.6, 0.58, 0.54]];
const LOAD: readonly Rgb[] = [[0.62, 0.52, 0.36], [0.5, 0.4, 0.26], [0.44, 0.46, 0.38]];
const WOOL: readonly Rgb[] = [[0.9, 0.88, 0.82], [0.82, 0.78, 0.7], [0.36, 0.3, 0.26], [0.94, 0.92, 0.88]];

const SALT = 0x714c;
const pick = <T>(list: readonly T[], h: number): T => list[Math.floor(unit(h) * list.length)]!;
const rgb = (c: Rgb): number => packRgb(c[0], c[1], c[2]);
const shade = (c: Rgb, k: number): number => packRgb(c[0] * k, c[1] * k, c[2] * k);

/** The look of a creature of `kind` from its seed (an integer hash). Pure. */
export function creatureLook(kind: number, seed: number): CreatureLook {
  const h = (k: number): number => hashInts(seed, SALT, kind, k);
  if (kind === CREATURE.villager) {
    const r = unit(h(6));
    let variants = 0;
    if (r < 0.25) variants |= 1 << CREATURE_VARIANT.hood;
    if (unit(h(8)) < 0.2) variants |= 1 << CREATURE_VARIANT.staff;
    if ((seed & VILLAGER_PACK_BIT) !== 0) variants |= 1 << CREATURE_VARIANT.pack;
    return {
      heightScale: 0.9 + unit(h(1)) * 0.18,
      widthScale: 0.9 + unit(h(2)) * 0.22,
      colors: [rgb(pick(CLOTH, h(3))), rgb(pick(HOSE, h(4))), rgb(pick(SKIN, h(5))), rgb(pick(HAIR, h(7)))],
      variants,
    };
  }
  if (kind === CREATURE.skeleton) {
    const b = pick(BONE, h(3));
    return { heightScale: 0.95 + unit(h(1)) * 0.1, widthScale: 0.95 + unit(h(2)) * 0.1, colors: [rgb(b), shade(b, 0.62), rgb(b), rgb(b)], variants: 0 };
  }
  if (kind === CREATURE.beast) {
    const c = pick(COAT, h(3));
    return {
      heightScale: 0.92 + unit(h(1)) * 0.16,
      widthScale: 0.92 + unit(h(2)) * 0.16,
      colors: [rgb(c), shade(c, 0.8), rgb(pick(LOAD, h(4))), shade(c, 0.55)],
      variants: unit(h(5)) < 0.85 ? 1 << CREATURE_VARIANT.load : 0,
    };
  }
  const w = pick(WOOL, h(3));
  return { heightScale: 0.85 + unit(h(1)) * 0.3, widthScale: 0.9 + unit(h(2)) * 0.2, colors: [rgb(w), shade(w, 0.45), rgb(w), rgb(w)], variants: 0 };
}
