// The fifteen people of the village (A5, A6, B4): every one with their own height, build, colours, hair and gear,
// assembled from the four part meshes (shapes.ts) on the bones of a human skeleton (rig.ts). Clothes are layered
// parts: rounded torsos, aprons, skirts and tabards as flattened segments that follow the legs, cloaks on their own
// bone, boots with cuffs and soles, big hands with thumbs, big heads with hair, beards and hats.

import { PALETTE, hex, mixRgb, scaleRgb, shiftHsv, vary } from '../kit/index.ts';
import type { RGB, Stream } from '../kit/index.ts';
import { ACT, HB, HOLD, LISTEN, body, humanSkeleton } from './rig.ts';
import type { Body, Skeleton } from './rig.ts';
import { mat34Multiply } from 'wallhammer-web/base';
import { M, partMatrix, segmentMatrix } from './vmath.ts';

/** The four part sets. */
export const SET = { head: 0, blob: 1, seg: 2, block: 3 } as const;

export interface PartDef {
  set: number;
  bone: number;
  /** Part matrix in the bone's frame. */
  m: Float32Array;
  color: RGB;
  /** Extra glow (evening channel). */
  glow: number;
  /** Prop modes it shows in (bit per mode; 0: always). */
  show: number;
  /** Actions it shows in (bit per action id; 0: always). */
  acts: number;
}

/** Prop modes of a person (which carried things are out). */
export const PROP = { normal: 0, carry: 1 } as const;
const inMode = (mode: number): number => 1 << mode;
const inActs = (...acts: number[]): number => acts.reduce((m, a) => m | (1 << a), 0);

/** Collects the parts of one figure. Build time only. */
export class FigureBuilder {
  readonly parts: PartDef[] = [];
  private show = 0;
  private acts = 0;
  private frame: Float32Array | null = null;

  /** Parts added in `fn` show only in these prop modes and actions. */
  only(show: number, acts: number, fn: () => void): void {
    const ks = this.show, ka = this.acts;
    this.show = show;
    this.acts = acts;
    fn();
    this.show = ks;
    this.acts = ka;
  }

  /** Parts added in `fn` are placed in the frame `m` (bone-local). */
  within(m: Float32Array, fn: () => void): void {
    const keep = this.frame;
    if (keep) {
      const c = new Float32Array(M);
      mat34Multiply(keep, m, c);
      this.frame = c;
    } else this.frame = m;
    fn();
    this.frame = keep;
  }

  private add(set: number, bone: number, m: Float32Array, color: RGB, glow = 0): void {
    let mm = m;
    if (this.frame) {
      mm = new Float32Array(M);
      mat34Multiply(this.frame, m, mm);
    }
    this.parts.push({ set, bone, m: mm, color: [color[0], color[1], color[2]], glow, show: this.show, acts: this.acts });
  }

  /** A tapered limb from `from` to `to` (thick end at `to`), radii across. */
  seg(bone: number, from: readonly number[], to: readonly number[], rx: number, rz: number, color: RGB, twist = 0): void {
    this.add(SET.seg, bone, segmentMatrix(from, to, rx, rz, twist), color);
  }

  blob(bone: number, at: readonly number[], r: readonly number[], color: RGB, yaw = 0, pitch = 0, roll = 0): void {
    this.add(SET.blob, bone, partMatrix(at, r, yaw, pitch, roll), color);
  }

  block(bone: number, at: readonly number[], size: readonly number[], color: RGB, yaw = 0, pitch = 0, roll = 0, glow = 0): void {
    this.add(SET.block, bone, partMatrix(at, size, yaw, pitch, roll), color, glow);
  }

  head(bone: number, at: readonly number[], h: number, wide: number, color: RGB): void {
    this.add(SET.head, bone, partMatrix(at, [h * wide, h, h]), color);
  }
}

/** What a person does in the village (sim.ts gives each role its routine). */
export type Role =
  | 'smith' | 'innkeeper' | 'merchant' | 'farmer' | 'shopper' | 'guard-patrol' | 'guard-post' | 'traveller'
  | 'oldman' | 'lover-a' | 'lover-b' | 'child';

export interface Person {
  name: string;
  role: Role;
  /** Stall index for merchants, traveller index for travellers. */
  slot: number;
  body: Body;
  skel: Skeleton;
  parts: PartDef[];
  holdL: number;
  holdR: number;
  listen: number;
  energy: number;
  /** Walking speed m/s. */
  speed: number;
  /** Extra forward bend of the back (the old man). */
  stoop: number;
  /** Seconds per work cycle (hammer, hoe). */
  cycle: number;
}

// --- Colours ----------------------------------------------------------------------------------------------------

const C = {
  leather: hex('#6a4026'),
  leatherDark: hex('#3e2618'),
  boot: hex('#3a2a20'),
  sole: hex('#241a14'),
  linen: hex('#e6dcc2'),
  white: hex('#f0ebe0'),
  wool: hex('#8a7a66'),
  straw: hex('#d8b866'),
  wicker: hex('#b08a4a'),
  wood: hex('#8a5a32'),
  woodDark: hex('#5a3a22'),
  steel: hex('#a8aab4'),
  black: hex('#2a2422'),
  ochre: hex('#c8902a'),
  violet: hex('#6a3a7a'),
  pink: hex('#c8566a'),
  orange: hex('#d8762a'),
  teal: hex('#2a7a7a'),
  rope: hex('#b89a6a'),
  cabbage: PALETTE.cabbage,
  bread: hex('#c8883a'),
};

// --- Body ------------------------------------------------------------------------------------------------------

interface Dress {
  skin: RGB;
  shirt: RGB;
  /** Sleeve colour (default the shirt); `bareFore` shows skin from the elbow. */
  sleeve?: RGB;
  bareFore?: boolean;
  legs: RGB;
  hips?: RGB;
  boots: RGB;
  belt?: RGB;
  buckle?: RGB;
  female?: boolean;
  barefoot?: boolean;
}

/** The body every person shares: torso, neck, head, arms with big hands, legs with boots. */
function humanBody(f: FigureBuilder, b: Body, d: Dress): void {
  const H = b.H;
  const tl = b.torsoLen;
  const top = tl * 0.82;
  // Hips (pelvis frame): the seat of the trousers or the tunic hem, wider at the bottom.
  f.seg(HB.pelvis, [0, b.waist + 0.01 * H, 0], [0, -0.055 * H, -0.005 * H], b.hipW + b.legR * 1.05, b.torsoRz * 0.9, d.hips ?? d.legs);
  // Chest (spine frame), rounded and wider at the shoulders.
  f.seg(HB.spine, [0, -0.035 * H, 0], [0, top - 0.012 * H, 0], b.torsoRx, b.torsoRz, d.shirt);
  if (d.female) f.blob(HB.spine, [0, tl * 0.5, b.torsoRz * 0.32], [b.torsoRx * 0.72, tl * 0.15, b.torsoRz * 0.72], d.shirt);
  if (b.belly > 0.15) f.blob(HB.spine, [0, tl * 0.14, b.torsoRz * 0.3], [b.torsoRx * (0.82 + 0.12 * b.belly), tl * (0.2 + 0.08 * b.belly), b.torsoRz * (0.72 + 0.4 * b.belly)], d.shirt);
  // Shoulders.
  for (const s of [-1, 1]) f.blob(HB.spine, [s * b.shoulderW * 0.86, b.shoulderY - b.waist + 0.012 * H, 0], [b.armR * 1.6, b.armR * 1.35, b.armR * 1.5], d.sleeve ?? d.shirt);
  // Neck.
  f.seg(HB.spine, [0, top - 0.04 * H, 0], [0, top + b.neckLen + 0.012 * H, 0.012 * H], 0.031 * H * (0.85 + 0.2 * b.W), 0.029 * H * (0.85 + 0.2 * b.W), d.skin);
  // Belt and buckle.
  const belt = d.belt ?? C.leatherDark;
  const br = 0.74 + 0.25 * b.belly;
  f.seg(HB.spine, [0, -0.035 * H, 0], [0, 0.0, 0], (b.torsoRx * br + 0.012) / 0.86, (b.torsoRz * (br + 0.15 * b.belly) + 0.012) / 0.86, belt);
  f.block(HB.spine, [0, -0.018 * H, b.torsoRz * (br + 0.15 * b.belly) + 0.014], [0.045, 0.036, 0.014], d.buckle ?? PALETTE.ironLight);
  // Head.
  f.head(HB.head, [0, 0, 0], b.headH, 0.94 + 0.1 * b.W, d.skin);
  // Arms and hands.
  for (const side of [1, -1]) {
    const up = side > 0 ? HB.lUpper : HB.rUpper;
    const fo = side > 0 ? HB.lFore : HB.rFore;
    const ha = side > 0 ? HB.lHand : HB.rHand;
    f.seg(up, [0, -b.upper - 0.01 * H, 0], [0, 0.01 * H, 0], b.armR, b.armR * 0.95, d.sleeve ?? d.shirt);
    f.seg(fo, [0, -b.fore, 0], [0, 0.005 * H, 0], b.armR * 0.86, b.armR * 0.82, d.bareFore ? d.skin : d.sleeve ?? d.shirt);
    if (d.bareFore) f.blob(fo, [0, -0.01 * H, 0], [b.armR * 1.05, b.armR * 0.55, b.armR * 1.0], d.sleeve ?? d.shirt);
    else f.blob(fo, [0, -b.fore * 0.92, 0], [b.armR * 0.95, b.armR * 0.5, b.armR * 0.92], scaleRgb(d.sleeve ?? d.shirt, 0.85));
    // A big hand with a thumb toward the front.
    f.blob(ha, [0, -0.042 * H, 0.004 * H], [0.022 * H, 0.041 * H, 0.03 * H], d.skin);
    f.blob(ha, [-side * 0.006 * H, -0.024 * H, 0.026 * H], [0.011 * H, 0.022 * H, 0.012 * H], d.skin, 0, -0.5, 0);
  }
  // Legs with boots.
  for (const side of [1, -1]) {
    const th = side > 0 ? HB.lThigh : HB.rThigh;
    const sh = side > 0 ? HB.lShin : HB.rShin;
    const ft = side > 0 ? HB.lFoot : HB.rFoot;
    f.seg(th, [0, -b.thigh - 0.01 * H, 0], [0, 0.015 * H, 0], b.legR, b.legR, d.legs);
    f.seg(sh, [0, -b.shin, 0], [0, 0.01 * H, 0], b.legR * 0.82, b.legR * 0.86, d.barefoot ? d.skin : d.legs);
    if (!d.barefoot) f.seg(sh, [0, -b.shin - 0.01 * H, 0], [0, -b.shin * 0.48, 0], b.legR * 0.98, b.legR * 1.0, d.boots);
    f.blob(ft, [0, -b.footH * 0.48, 0.034 * H], [b.legR * 0.92, b.footH * 0.56, 0.066 * H], d.barefoot ? d.skin : d.boots);
    if (!d.barefoot) f.block(ft, [0, -b.footH * 0.93, 0.03 * H], [b.legR * 1.75, 0.012 * H, 0.14 * H], C.sole);
  }
}

// --- Clothes -------------------------------------------------------------------------------------------------------

/** A skirt or tunic hem: a front and a back half on the cloth bones, so it follows the legs. */
function skirt(f: FigureBuilder, b: Body, color: RGB, length: number, flare: number): void {
  const rx = (b.hipW + b.legR) * flare;
  const top = b.waist * 0.35;
  const z = b.torsoRz * 0.42;
  f.seg(HB.clothFront, [0, top, z * 0.6], [0, -length, z + 0.02], rx, b.torsoRz * 0.62 * flare, color);
  f.seg(HB.clothBack, [0, top, -z * 0.6], [0, -length, -z - 0.03], rx, b.torsoRz * 0.62 * flare, scaleRgb(color, 0.94));
}

/** An apron hanging from the belt, optionally with a bib over the chest. */
function apron(f: FigureBuilder, b: Body, color: RGB, length: number, bib: boolean): void {
  const z = b.torsoRz * (0.95 + 0.45 * b.belly) + 0.02;
  f.seg(HB.clothFront, [0, b.waist * 0.2, z * 0.9], [0, -length, z + 0.04], b.hipW * 2.1 + 0.02, 0.012, color);
  if (bib) {
    const tl = b.torsoLen;
    f.seg(HB.spine, [0, tl * 0.66, b.torsoRz * 0.9 + 0.012], [0, -0.02 * b.H, z], b.torsoRx * 0.62, 0.012, color);
    // Neck strap.
    f.seg(HB.spine, [-b.torsoRx * 0.3, tl * 0.64, b.torsoRz * 0.6], [0, tl * 0.84, -b.torsoRz * 0.1], 0.012, 0.01, color);
    f.seg(HB.spine, [b.torsoRx * 0.3, tl * 0.64, b.torsoRz * 0.6], [0, tl * 0.84, -b.torsoRz * 0.1], 0.012, 0.01, color);
  }
}

/** An outer layer over the chest (bodice, vest, mail): a slightly larger torso. */
function vest(f: FigureBuilder, b: Body, color: RGB, open: boolean): void {
  const H = b.H;
  const top = b.torsoLen * 0.82;
  if (open) {
    // Two front panels and a back: the shirt shows down the middle.
    for (const s of [-1, 1]) f.seg(HB.spine, [s * b.torsoRx * 0.42, -0.03 * H, b.torsoRz * 0.55], [s * b.torsoRx * 0.5, top - 0.03 * H, b.torsoRz * 0.55], b.torsoRx * 0.5, b.torsoRz * 0.55, color);
    f.seg(HB.spine, [0, -0.03 * H, -b.torsoRz * 0.3], [0, top - 0.02 * H, -b.torsoRz * 0.25], b.torsoRx * 1.0, b.torsoRz * 0.78, color);
  } else {
    f.seg(HB.spine, [0, -0.025 * H, 0], [0, top - 0.04 * H, 0], b.torsoRx * 1.05, b.torsoRz * 1.07, color);
  }
}

/** A tabard: front and back panels over the chest and down over the hips. */
function tabard(f: FigureBuilder, b: Body, color: RGB, trim: RGB): void {
  const tl = b.torsoLen;
  const z = b.torsoRz * (1.02 + 0.4 * b.belly) + 0.012;
  f.seg(HB.spine, [0, tl * 0.75, b.torsoRz * 0.85], [0, -0.02 * b.H, z], b.torsoRx * 0.72, 0.014, color);
  f.seg(HB.spine, [0, tl * 0.75, -b.torsoRz * 0.88], [0, -0.02 * b.H, -b.torsoRz * 1.02 - 0.012], b.torsoRx * 0.75, 0.014, color);
  f.seg(HB.clothFront, [0, b.waist * 0.3, z * 0.95], [0, -0.17 * b.H, z + 0.03], b.torsoRx * 0.62, 0.014, color);
  f.seg(HB.clothBack, [0, b.waist * 0.3, -z * 0.95], [0, -0.17 * b.H, -z - 0.03], b.torsoRx * 0.62, 0.014, color);
  // A badge: a coloured bar across the chest.
  f.block(HB.spine, [0, tl * 0.5, z + 0.004], [b.torsoRx * 0.8, 0.045, 0.012], trim);
}

/** A cloak from the shoulders down the back, with a collar. */
function cloak(f: FigureBuilder, b: Body, color: RGB, length: number): void {
  f.seg(HB.cloak, [0, 0.0, 0.0], [0, -length, -0.06], b.shoulderW * 1.28, 0.03, color);
  f.blob(HB.spine, [0, b.torsoLen * 0.8, -b.torsoRz * 0.1], [b.torsoRx * 1.08, 0.05 * b.H, b.torsoRz * 1.12], scaleRgb(color, 1.05));
}

/** A shawl or scarf around the shoulders. */
function shawl(f: FigureBuilder, b: Body, color: RGB): void {
  f.blob(HB.spine, [0, b.torsoLen * 0.72, 0], [b.torsoRx * 1.06, 0.06 * b.H, b.torsoRz * 1.12], color);
  f.seg(HB.spine, [0, b.torsoLen * 0.7, b.torsoRz * 0.9], [0, b.torsoLen * 0.35, b.torsoRz * 1.05], 0.05, 0.015, scaleRgb(color, 0.92));
}

// --- Hair, beards, hats (head frame: height of the head h, origin at the neck) ------------------------------------

type HairStyle = 'short' | 'bowl' | 'bun' | 'braids' | 'long' | 'bald' | 'curly' | 'tousled' | 'none';

function hair(f: FigureBuilder, h: number, style: HairStyle, color: RGB): void {
  const p = (x: number, y: number, z: number): number[] => [x * h, y * h, z * h];
  const r = (x: number, y: number, z: number): number[] => [x * h, y * h, z * h];
  const B = HB.head;
  switch (style) {
    case 'none':
      break;
    case 'bald':
      // A fringe around the back and over the ears.
      f.blob(B, p(0, 0.47, -0.2), r(0.37, 0.15, 0.24), color, 0, -0.2, 0);
      break;
    case 'short':
      f.blob(B, p(0, 0.67, -0.07), r(0.4, 0.33, 0.42), color, 0, -0.3, 0);
      break;
    case 'bowl':
      f.blob(B, p(0, 0.66, -0.04), r(0.415, 0.33, 0.43), color, 0, -0.12, 0);
      break;
    case 'tousled':
      f.blob(B, p(0, 0.69, -0.06), r(0.41, 0.33, 0.43), color, 0, -0.25, 0);
      for (let k = 0; k < 4; k++) f.blob(B, p(-0.2 + k * 0.13, 0.95 - Math.abs(k - 1.5) * 0.04, 0.12 - (k % 2) * 0.2), r(0.12, 0.08, 0.12), color, k, 0.3 * k, 0.2);
      break;
    case 'curly':
      f.blob(B, p(0, 0.68, -0.06), r(0.4, 0.32, 0.42), color, 0, -0.25, 0);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        f.blob(B, p(Math.cos(a) * 0.3, 0.86 + 0.05 * Math.sin(a * 2), -0.06 + Math.sin(a) * 0.28), r(0.13, 0.12, 0.13), color, a);
      }
      break;
    case 'bun':
      f.blob(B, p(0, 0.67, -0.06), r(0.4, 0.33, 0.42), color, 0, -0.2, 0);
      f.blob(B, p(0, 0.86, -0.36), r(0.17, 0.16, 0.15), color);
      break;
    case 'braids':
      f.blob(B, p(0, 0.67, -0.05), r(0.405, 0.33, 0.42), color, 0, -0.2, 0);
      for (const s of [-1, 1]) for (let k = 0; k < 4; k++) f.blob(B, p(s * (0.32 - k * 0.015), 0.4 - k * 0.15, -0.12 + k * 0.035), r(0.075, 0.09, 0.075), scaleRgb(color, 1 - k * 0.03));
      break;
    case 'long':
      f.blob(B, p(0, 0.67, -0.06), r(0.41, 0.33, 0.43), color, 0, -0.22, 0);
      f.seg(B, p(0, 0.62, -0.24), p(0, -0.2, -0.3), 0.34 * h, 0.12 * h, color);
      break;
  }
}

type BeardStyle = 'none' | 'full' | 'braided' | 'moustache' | 'goatee' | 'long' | 'stubble';

function beard(f: FigureBuilder, h: number, style: BeardStyle, color: RGB): void {
  const p = (x: number, y: number, z: number): number[] => [x * h, y * h, z * h];
  const B = HB.head;
  const tache = (): void => {
    for (const s of [-1, 1]) f.blob(B, p(s * 0.1, 0.33, 0.37), [0.11 * h, 0.04 * h, 0.05 * h], color, 0, 0, s * 0.45);
  };
  switch (style) {
    case 'none':
      break;
    case 'stubble':
      f.blob(B, p(0, 0.27, 0.12), [0.3 * h, 0.2 * h, 0.27 * h], scaleRgb(color, 0.9), 0, 0.15, 0);
      break;
    case 'moustache':
      tache();
      break;
    case 'goatee':
      tache();
      f.blob(B, p(0, 0.15, 0.3), [0.09 * h, 0.1 * h, 0.07 * h], color, 0, 0.3, 0);
      break;
    case 'full':
      f.blob(B, p(0, 0.22, 0.16), [0.33 * h, 0.27 * h, 0.27 * h], color, 0, 0.2, 0);
      tache();
      break;
    case 'braided':
      f.blob(B, p(0, 0.23, 0.16), [0.32 * h, 0.25 * h, 0.27 * h], color, 0, 0.2, 0);
      tache();
      for (let k = 0; k < 4; k++) f.blob(B, p(0, 0.02 - k * 0.11, 0.3 - k * 0.02), [(0.09 - k * 0.01) * h, 0.075 * h, (0.08 - k * 0.008) * h], scaleRgb(color, 1 - 0.04 * k), 0, 0.2, 0);
      f.block(B, p(0, -0.38, 0.27), [0.07 * h, 0.04 * h, 0.07 * h], PALETTE.gold);
      break;
    case 'long':
      f.blob(B, p(0, 0.2, 0.17), [0.32 * h, 0.28 * h, 0.27 * h], color, 0, 0.2, 0);
      f.seg(B, p(0, 0.15, 0.25), p(0, -0.45, 0.32), 0.22 * h, 0.1 * h, color);
      tache();
      break;
  }
}

type HatStyle = 'none' | 'straw' | 'felt' | 'cap' | 'beret' | 'hood' | 'helmet' | 'kerchief' | 'wool';

function hat(f: FigureBuilder, h: number, style: HatStyle, color: RGB, band: RGB): void {
  const p = (x: number, y: number, z: number): number[] => [x * h, y * h, z * h];
  const r = (x: number, y: number, z: number): number[] => [x * h, y * h, z * h];
  const B = HB.head;
  switch (style) {
    case 'none':
      break;
    case 'straw':
      f.blob(B, p(0, 0.82, -0.03), r(0.78, 0.045, 0.78), color, 0, -0.06, 0);
      f.blob(B, p(0, 0.95, -0.04), r(0.39, 0.22, 0.4), color, 0, -0.06, 0);
      f.blob(B, p(0, 0.88, -0.04), r(0.405, 0.06, 0.415), band);
      break;
    case 'felt':
      f.blob(B, p(0, 0.84, -0.03), r(0.66, 0.04, 0.66), color, 0, -0.1, 0.05);
      f.blob(B, p(0, 0.99, -0.05), r(0.37, 0.25, 0.38), color, 0, -0.1, 0.05);
      f.blob(B, p(0, 0.9, -0.05), r(0.385, 0.06, 0.395), band);
      // A feather.
      f.seg(B, p(0.3, 0.9, -0.15), p(0.42, 1.25, -0.35), 0.035 * h, 0.012 * h, PALETTE.flowerWhite);
      break;
    case 'cap':
      f.blob(B, p(0.03, 0.9, -0.08), r(0.43, 0.2, 0.45), color, 0, -0.15, -0.12);
      f.blob(B, p(0, 0.78, 0.3), r(0.28, 0.03, 0.14), scaleRgb(color, 0.85), 0, -0.2, 0);
      break;
    case 'beret':
      f.blob(B, p(0.08, 0.92, -0.06), r(0.48, 0.15, 0.47), color, 0, -0.1, -0.2);
      break;
    case 'wool':
      f.blob(B, p(0, 0.86, -0.05), r(0.42, 0.24, 0.44), color, 0, -0.15, 0);
      f.blob(B, p(0, 1.08, -0.12), r(0.1, 0.1, 0.1), band);
      break;
    case 'kerchief':
      f.blob(B, p(0, 0.7, -0.08), r(0.43, 0.37, 0.45), color, 0, -0.3, 0);
      f.blob(B, p(0, 0.5, -0.4), r(0.12, 0.1, 0.08), scaleRgb(color, 0.9));
      break;
    case 'hood':
      f.blob(B, p(0, 0.62, -0.17), r(0.48, 0.5, 0.47), color, 0, -0.1, 0);
      f.seg(B, p(0, 0.55, -0.4), p(0, -0.12, -0.45), 0.36 * h, 0.12 * h, scaleRgb(color, 0.94));
      break;
    case 'helmet':
      f.blob(B, p(0, 0.8, -0.03), r(0.44, 0.31, 0.46), color, 0, -0.08, 0);
      f.blob(B, p(0, 0.76, -0.03), r(0.66, 0.035, 0.66), color, 0, -0.08, 0);
      f.block(B, p(0, 1.1, -0.04), [0.04 * h, 0.06 * h, 0.5 * h], band, 0, -0.08, 0);
      break;
  }
}

// --- Props ---------------------------------------------------------------------------------------------------------

/** The frame of a tool held in a hand: tool +y along the fist (hand z), tool +z toward the back of the hand's y. */
function grip(b: Body, _side: number): Float32Array {
  return partMatrix([0, -0.045 * b.H, 0.008 * b.H], [1, 1, 1], 0, Math.PI / 2, 0);
}

function hammer(f: FigureBuilder, b: Body): void {
  f.within(grip(b, -1), () => {
    f.seg(HB.rHand, [0, -0.08, 0], [0, 0.3, 0], 0.016, 0.016, C.wood);
    f.block(HB.rHand, [0, 0.31, 0], [0.055, 0.06, 0.15], PALETTE.iron);
  });
}

function tongs(f: FigureBuilder, b: Body): void {
  f.within(grip(b, 1), () => {
    for (const s of [-1, 1]) f.seg(HB.lHand, [0, -0.04, 0], [s * 0.015, 0.36, 0.02], 0.008, 0.008, PALETTE.iron, 0);
    f.block(HB.lHand, [0, 0.38, 0.02], [0.05, 0.03, 0.03], PALETTE.ironLight);
  });
}

function broom(f: FigureBuilder, b: Body): void {
  f.within(grip(b, -1), () => {
    f.seg(HB.rHand, [0, 0.3, 0], [0, -0.92, 0], 0.016, 0.016, C.wood);
    f.seg(HB.rHand, [0, -0.86, 0], [0, -1.2, 0], 0.11, 0.045, C.straw);
    f.blob(HB.rHand, [0, -0.88, 0], [0.04, 0.03, 0.03], C.rope);
  });
}

function staff(f: FigureBuilder, b: Body, side: number, below: number, above: number, color: RGB, knob: boolean): void {
  const bone = side > 0 ? HB.lHand : HB.rHand;
  f.within(grip(b, side), () => {
    f.seg(bone, [0, above, 0], [0, -below, 0], 0.019, 0.019, color);
    if (knob) f.blob(bone, [0, above + 0.02, 0], [0.032, 0.04, 0.032], scaleRgb(color, 0.85));
  });
}

function cane(f: FigureBuilder, b: Body): void {
  f.within(grip(b, -1), () => {
    f.seg(HB.rHand, [0, 0.03, 0], [0, -0.82, 0], 0.016, 0.016, C.woodDark);
    // The crook over the fist.
    f.seg(HB.rHand, [0, 0.04, 0], [0, 0.08, -0.08], 0.017, 0.017, C.woodDark);
  });
}

function halberd(f: FigureBuilder, b: Body): void {
  f.within(grip(b, -1), () => {
    f.seg(HB.rHand, [0, 1.25, 0], [0, -0.95, 0], 0.017, 0.017, C.woodDark);
    // Axe blade toward the front, hook to the back, spike on top.
    f.block(HB.rHand, [0, 1.06, 0.1], [0.012, 0.22, 0.17], C.steel, 0, -0.08, 0);
    f.block(HB.rHand, [0, 1.08, -0.07], [0.012, 0.05, 0.1], C.steel, 0, 0.3, 0);
    f.block(HB.rHand, [0, 1.36, 0], [0.022, 0.24, 0.022], C.steel);
    f.blob(HB.rHand, [0, 0.96, 0], [0.024, 0.03, 0.024], PALETTE.iron);
  });
}

function shield(f: FigureBuilder, b: Body, color: RGB, emblem: RGB): void {
  const x = b.armR * 1.0 + 0.035;
  f.blob(HB.lFore, [x, -b.fore * 0.5, 0.0], [0.035, 0.27, 0.27], color);
  f.blob(HB.lFore, [x + 0.022, -b.fore * 0.5, 0.0], [0.02, 0.17, 0.08], emblem);
  f.blob(HB.lFore, [x + 0.03, -b.fore * 0.5, 0.0], [0.035, 0.055, 0.055], PALETTE.ironLight);
}

/** A woven basket in its own frame (y up, bottom at 0) with goods on top. */
function basketBody(f: FigureBuilder, bone: number, w: number, hgt: number, goods: RGB[], handle: boolean): void {
  f.seg(bone, [0, 0.0, 0], [0, hgt, 0], w, w * 0.78, C.wicker);
  f.seg(bone, [0, hgt * 0.92, 0], [0, hgt * 1.02, 0], w * 1.04, w * 0.82, scaleRgb(C.wicker, 0.8));
  goods.forEach((g, i) => {
    const a = i * 2.3;
    f.blob(bone, [Math.cos(a) * w * 0.45, hgt * 1.02 + (i % 2) * 0.02, Math.sin(a) * w * 0.35], [w * 0.38, w * 0.33, w * 0.38], g);
  });
  if (handle) {
    f.seg(bone, [-w * 0.95, hgt, 0], [-w * 0.5, hgt * 1.9, 0], 0.01, 0.01, C.wicker);
    f.seg(bone, [w * 0.95, hgt, 0], [w * 0.5, hgt * 1.9, 0], 0.01, 0.01, C.wicker);
    f.seg(bone, [-w * 0.55, hgt * 1.88, 0], [w * 0.55, hgt * 1.88, 0], 0.011, 0.011, C.wicker);
  }
}

/** Goods a merchant offers, in the right hand (tool frame), only while offering. */
function goods(f: FigureBuilder, b: Body, kind: string, color: RGB): void {
  f.within(grip(b, -1), () => {
    f.only(0, inActs(ACT.offer, ACT.give), () => {
      switch (kind) {
        case 'cloth':
          f.seg(HB.rHand, [-0.17, 0.02, 0.05], [0.17, 0.02, 0.05], 0.055, 0.055, color);
          break;
        case 'pottery':
          f.blob(HB.rHand, [0, 0.0, 0.08], [0.07, 0.08, 0.07], hex('#b0603a'));
          f.seg(HB.rHand, [0, 0.06, 0.08], [0, 0.13, 0.08], 0.03, 0.03, hex('#b0603a'));
          break;
        case 'apples':
          f.blob(HB.rHand, [0, 0.0, 0.06], [0.045, 0.045, 0.045], PALETTE.apple);
          f.blob(HB.rHand, [0.05, 0.02, 0.05], [0.042, 0.042, 0.042], hex('#d84a2a'));
          break;
        default:
          f.blob(HB.rHand, [0, 0.0, 0.08], [0.08, 0.075, 0.08], PALETTE.cabbage);
          break;
      }
    });
  });
}

// --- The fifteen ----------------------------------------------------------------------------------------------------

interface Spec {
  name: string;
  role: Role;
  slot?: number;
  H: number;
  W: number;
  belly: number;
  headK: number;
  legK: number;
  holdL?: number;
  holdR?: number;
  listen?: number;
  energy?: number;
  speed: number;
  stoop?: number;
  cycle?: number;
  dress(s: Stream, b: Body): Dress;
  extra(f: FigureBuilder, b: Body, s: Stream, d: Dress): void;
}

const skinTone = (s: Stream, k: number, base: RGB = PALETTE.skin): RGB => vary(mixRgb(base, PALETTE.skinDark, s.range(0, 0.35, k)), { hue: 0.01, sat: 0.08, val: 0.06 }, s, k, 1);

/** Builds the people from their descriptions; `stallGoods` gives the merchants their wares by stall. */
export function makePeople(s: Stream, stallGoods: readonly string[]): Person[] {
  const specs: Spec[] = [
    {
      name: 'smith', role: 'smith', H: 1.82, W: 1.36, belly: 0.3, headK: 1.0, legK: 0.95, listen: LISTEN.crossed, energy: 0.9, speed: 1.15, cycle: 1.15,
      dress: (q) => ({ skin: shiftHsv(skinTone(q, 1), 0, 0.12, -0.04), shirt: hex('#4a5a7a'), bareFore: true, legs: hex('#4a3a2e'), boots: C.boot }),
      extra: (f, b) => {
        hair(f, b.headH, 'bald', hex('#5a4030'));
        beard(f, b.headH, 'braided', hex('#7a3a1e'));
        apron(f, b, C.leather, b.hipY * 0.62, true);
        hammer(f, b);
        tongs(f, b);
      },
    },
    {
      name: 'innkeeper', role: 'innkeeper', H: 1.62, W: 1.2, belly: 0.5, headK: 1.02, legK: 0.95, holdR: HOLD.staff, listen: LISTEN.hips, energy: 1.3, speed: 1.1,
      dress: (q) => ({ skin: skinTone(q, 2), shirt: C.linen, legs: hex('#3a6a3a'), boots: C.leatherDark, female: true, belt: hex('#7a2a24') }),
      extra: (f, b) => {
        hair(f, b.headH, 'bun', PALETTE.hairRed);
        vest(f, b, hex('#9a2a2a'), true);
        skirt(f, b, hex('#3a6a3a'), b.hipY * 0.88, 1.5);
        apron(f, b, C.white, b.hipY * 0.72, false);
        broom(f, b);
      },
    },
    {
      name: 'trader', role: 'merchant', slot: 0, H: 1.7, W: 1.05, belly: 0.25, headK: 1.0, legK: 1.0, listen: LISTEN.clasped, energy: 1.2, speed: 1.2,
      dress: (q) => ({ skin: skinTone(q, 3), shirt: C.ochre, legs: hex('#4a5a6a'), boots: C.boot }),
      extra: (f, b, _q, d) => {
        hair(f, b.headH, 'short', C.black);
        beard(f, b.headH, 'moustache', C.black);
        hat(f, b.headH, 'felt', hex('#3a5a3a'), C.leatherDark);
        vest(f, b, hex('#6a4a2a'), true);
        goods(f, b, stallGoods[0] ?? 'vegetables', d.shirt);
      },
    },
    {
      name: 'seller', role: 'merchant', slot: 1, H: 1.58, W: 0.9, belly: 0, headK: 1.04, legK: 0.98, listen: LISTEN.clasped, energy: 1.1, speed: 1.15,
      dress: (q) => ({ skin: skinTone(q, 4, hex('#eab48a')), shirt: C.white, sleeve: C.white, legs: hex('#2f4a9a'), boots: C.leather, female: true }),
      extra: (f, b) => {
        hair(f, b.headH, 'braids', PALETTE.hairBlond);
        vest(f, b, hex('#2f4a9a'), false);
        skirt(f, b, hex('#2f4a9a'), b.hipY * 0.86, 1.35);
        apron(f, b, C.linen, b.hipY * 0.65, false);
        goods(f, b, stallGoods[1] ?? 'apples', PALETTE.fabricRed);
      },
    },
    {
      name: 'draper', role: 'merchant', slot: 2, H: 1.66, W: 1.28, belly: 0.9, headK: 1.0, legK: 0.92, listen: LISTEN.clasped, energy: 0.8, speed: 1.0,
      dress: (q) => ({ skin: skinTone(q, 5), shirt: PALETTE.fabricRed, hips: PALETTE.fabricRed, legs: hex('#3a3a3a'), boots: C.boot, buckle: PALETTE.gold }),
      extra: (f, b) => {
        hair(f, b.headH, 'bald', PALETTE.hairGrey);
        beard(f, b.headH, 'full', PALETTE.hairGrey);
        hat(f, b.headH, 'beret', C.violet, C.violet);
        skirt(f, b, PALETTE.fabricRed, b.hipY * 0.45, 1.15);
        goods(f, b, stallGoods[2] ?? 'cloth', PALETTE.fabricBlue);
      },
    },
    {
      name: 'farmer', role: 'farmer', H: 1.76, W: 1.0, belly: 0, headK: 0.97, legK: 1.06, listen: LISTEN.hips, energy: 0.9, speed: 1.2, cycle: 1.7,
      dress: (q) => ({ skin: shiftHsv(skinTone(q, 6), 0.0, 0.1, -0.08), shirt: hex('#9ab07a'), bareFore: true, legs: hex('#7a5a3a'), boots: C.boot }),
      extra: (f, b) => {
        hair(f, b.headH, 'short', PALETTE.hairBrown);
        beard(f, b.headH, 'stubble', PALETTE.hairBrown);
        hat(f, b.headH, 'straw', C.straw, PALETTE.fabricRed);
        // The hoe in the hand while working, on the back while carrying.
        f.only(inMode(PROP.normal), 0, () => f.within(grip(b, -1), () => {
          f.seg(HB.rHand, [0, -0.4, 0], [0, 1.05, 0], 0.017, 0.017, C.wood);
          f.block(HB.rHand, [0, 1.05, 0.08], [0.15, 0.03, 0.15], PALETTE.iron, 0, 0.25, 0);
        }));
        f.only(inMode(PROP.carry), 0, () => {
          f.seg(HB.back, [0.2, -0.45, -0.04], [-0.25, 0.6, -0.04], 0.017, 0.017, C.wood);
          f.block(HB.back, [-0.27, 0.62, 0.02], [0.15, 0.15, 0.03], PALETTE.iron, 0, 0, 0.4);
          f.within(partMatrix([0.11, -0.045 * b.H - 0.05, -0.2], [1, 1, 1], 0, Math.PI / 2, 0), () => basketBody(f, HB.rHand, 0.17, 0.2, [PALETTE.cabbage, PALETTE.cabbage, PALETTE.pumpkin, PALETTE.cabbage], false));
        });
      },
    },
    {
      name: 'housewife', role: 'shopper', H: 1.55, W: 1.12, belly: 0.35, headK: 1.03, legK: 0.94, holdL: HOLD.basket, listen: LISTEN.clasped, energy: 1.4, speed: 1.1,
      dress: (q) => ({ skin: skinTone(q, 7), shirt: hex('#8a5a3a'), legs: hex('#6a4a32'), boots: C.leatherDark, female: true }),
      extra: (f, b) => {
        hair(f, b.headH, 'short', PALETTE.hairBrown);
        hat(f, b.headH, 'kerchief', hex('#c03a30'), hex('#c03a30'));
        shawl(f, b, hex('#4a7a5a'));
        skirt(f, b, hex('#6a4a32'), b.hipY * 0.9, 1.45);
        apron(f, b, C.linen, b.hipY * 0.7, false);
        f.within(partMatrix([0, -b.fore * 0.55, -0.03], [1, 1, 1], 0, Math.PI / 2, 0), () => {
          f.within(partMatrix([0, -0.21, 0], [1, 1, 1]), () => basketBody(f, HB.lFore, 0.14, 0.15, [PALETTE.apple, C.bread, PALETTE.apple], true));
        });
      },
    },
    {
      name: 'guard', role: 'guard-patrol', H: 1.85, W: 1.15, belly: 0, headK: 0.96, legK: 1.04, holdL: HOLD.shield, holdR: HOLD.staff, listen: LISTEN.relaxed, energy: 0.8, speed: 1.15,
      dress: (q) => ({ skin: skinTone(q, 8), shirt: hex('#7a7a84'), legs: hex('#7a2a2a'), boots: C.boot, belt: C.leatherDark }),
      extra: (f, b) => {
        hair(f, b.headH, 'short', PALETTE.hairRed);
        beard(f, b.headH, 'moustache', PALETTE.hairRed);
        hat(f, b.headH, 'helmet', C.steel, hex('#a8302a'));
        tabard(f, b, hex('#a8302a'), PALETTE.gold);
        halberd(f, b);
        shield(f, b, hex('#a8302a'), PALETTE.gold);
      },
    },
    {
      name: 'bridge guard', role: 'guard-post', H: 1.74, W: 1.3, belly: 0.4, headK: 1.0, legK: 0.96, holdL: HOLD.shield, holdR: HOLD.staff, listen: LISTEN.relaxed, energy: 0.9, speed: 1.05,
      dress: (q) => ({ skin: skinTone(q, 9, hex('#c88a60')), shirt: hex('#6a6a74'), legs: hex('#2f3a6a'), boots: C.boot }),
      extra: (f, b) => {
        hair(f, b.headH, 'short', C.black);
        beard(f, b.headH, 'full', C.black);
        hat(f, b.headH, 'helmet', hex('#8a8c94'), PALETTE.fabricBlue);
        tabard(f, b, PALETTE.fabricBlue, hex('#e8e0c8'));
        halberd(f, b);
        shield(f, b, PALETTE.fabricBlue, hex('#e8e0c8'));
      },
    },
    {
      name: 'pilgrim', role: 'traveller', slot: 0, H: 1.72, W: 0.95, belly: 0, headK: 0.98, legK: 1.04, holdR: HOLD.staff, listen: LISTEN.relaxed, energy: 1.0, speed: 1.3,
      dress: (q) => ({ skin: skinTone(q, 10), shirt: hex('#8a7a5a'), legs: hex('#5a4a3a'), boots: C.leather }),
      extra: (f, b) => {
        hair(f, b.headH, 'short', PALETTE.hairBrown);
        beard(f, b.headH, 'goatee', PALETTE.hairBrown);
        hat(f, b.headH, 'hood', hex('#3a5a3a'), hex('#3a5a3a'));
        cloak(f, b, hex('#3a5a3a'), b.hipY * 1.05 + 0.15);
        // Pack with a bedroll on the back.
        f.blob(HB.back, [0, -0.02, -0.12], [0.17, 0.22, 0.12], hex('#7a5a3a'));
        f.seg(HB.back, [-0.21, 0.24, -0.1], [0.21, 0.24, -0.1], 0.07, 0.07, hex('#a8303a'));
        f.seg(HB.spine, [b.torsoRx * 0.7, b.torsoLen * 0.78, 0.0], [-b.torsoRx * 0.6, -0.02, b.torsoRz * 0.95], 0.018, 0.012, C.leatherDark);
        staff(f, b, -1, 0.95, 0.75, C.wood, true);
      },
    },
    {
      name: 'porter', role: 'traveller', slot: 1, H: 1.64, W: 1.32, belly: 0.2, headK: 1.0, legK: 0.92, holdR: HOLD.staff, listen: LISTEN.hips, energy: 1.2, speed: 1.2,
      dress: (q) => ({ skin: shiftHsv(skinTone(q, 11), 0, 0.15, 0), shirt: hex('#6a7a8a'), legs: hex('#4a4a3a'), boots: C.boot }),
      extra: (f, b) => {
        hair(f, b.headH, 'short', hex('#a84a20'));
        beard(f, b.headH, 'full', hex('#a84a20'));
        hat(f, b.headH, 'wool', hex('#8a6a4a'), hex('#c8a86a'));
        cloak(f, b, hex('#6a5a4a'), b.hipY * 0.8);
        // The tall carry basket with straps.
        f.within(partMatrix([0, -0.28, -0.22], [1, 1, 1]), () => basketBody(f, HB.back, 0.2, 0.58, [PALETTE.cabbage, C.bread, PALETTE.pumpkin, PALETTE.cabbage], false));
        for (const sx of [-1, 1]) f.seg(HB.spine, [sx * b.torsoRx * 0.55, b.torsoLen * 0.2, b.torsoRz * 0.8], [sx * b.torsoRx * 0.5, b.torsoLen * 0.84, -b.torsoRz * 0.2], 0.02, 0.012, C.leatherDark);
        staff(f, b, -1, 0.9, 0.5, C.woodDark, false);
      },
    },
    {
      name: 'old man', role: 'oldman', H: 1.57, W: 0.95, belly: 0.1, headK: 1.03, legK: 0.92, holdR: HOLD.cane, listen: LISTEN.clasped, energy: 0.7, speed: 0.55, stoop: 0.22,
      dress: (q) => ({ skin: shiftHsv(skinTone(q, 12), 0, -0.1, 0.03), shirt: hex('#7a5a4a'), legs: hex('#5a5048'), boots: C.leatherDark }),
      extra: (f, b) => {
        hair(f, b.headH, 'bald', C.white);
        beard(f, b.headH, 'long', C.white);
        hat(f, b.headH, 'cap', hex('#4a4a5a'), hex('#4a4a5a'));
        cloak(f, b, hex('#5a4a3a'), b.hipY * 0.9);
        cane(f, b);
      },
    },
    {
      name: 'girl', role: 'lover-a', H: 1.63, W: 0.88, belly: 0, headK: 1.0, legK: 1.04, listen: LISTEN.clasped, energy: 1.35, speed: 1.2,
      dress: (q) => ({ skin: skinTone(q, 13, hex('#ecb890')), shirt: C.white, legs: C.pink, boots: C.leather, female: true }),
      extra: (f, b) => {
        hair(f, b.headH, 'long', hex('#8a6a3a'));
        f.blob(HB.head, [0.3 * b.headH, 0.82 * b.headH, 0.1 * b.headH], [0.07 * b.headH, 0.07 * b.headH, 0.07 * b.headH], PALETTE.flowerYellow);
        vest(f, b, PALETTE.fabricBlue, true);
        skirt(f, b, C.pink, b.hipY * 0.85, 1.4);
      },
    },
    {
      name: 'young man', role: 'lover-b', H: 1.79, W: 1.05, belly: 0, headK: 0.97, legK: 1.06, listen: LISTEN.relaxed, energy: 1.25, speed: 1.25,
      dress: (q) => ({ skin: skinTone(q, 14), shirt: C.white, legs: hex('#b08a5a'), boots: C.boot }),
      extra: (f, b) => {
        hair(f, b.headH, 'curly', PALETTE.hairRed);
        vest(f, b, PALETTE.fabricGreen, true);
      },
    },
    {
      name: 'boy', role: 'child', H: 1.12, W: 0.98, belly: 0.1, headK: 1.28, legK: 0.9, listen: LISTEN.relaxed, energy: 1.5, speed: 2.2,
      dress: (q) => ({ skin: skinTone(q, 15, hex('#eab088')), shirt: C.orange, hips: C.orange, legs: hex('#6a4a2a'), boots: PALETTE.skin, barefoot: true }),
      extra: (f, b) => {
        hair(f, b.headH, 'tousled', PALETTE.hairBlond);
        skirt(f, b, C.orange, b.hipY * 0.3, 1.05);
      },
    },
  ];
  return specs.map((sp, i) => personOf(sp, i, s));
}

/**
 * The walking figure of the walk mode (src/walk/): the villagers' body, rig and walk, in colours no villager wears
 * (a saffron hood and cloak over a bright blue tunic) so it stands out among them.
 */
export function makePlayer(s: Stream): Person {
  return personOf(
    {
      name: 'walker', role: 'traveller', slot: 99, H: 1.76, W: 1.05, belly: 0, headK: 1.0, legK: 1.03, listen: LISTEN.relaxed, energy: 1.2, speed: 1.6,
      dress: (q) => ({ skin: skinTone(q, 16), shirt: hex('#2f62c8'), legs: hex('#2a2a36'), boots: C.leather, belt: C.leatherDark, buckle: PALETTE.gold }),
      extra: (f, b) => {
        hair(f, b.headH, 'short', PALETTE.hairBrown);
        hat(f, b.headH, 'hood', hex('#e8a41c'), hex('#e8a41c'));
        cloak(f, b, hex('#e8a41c'), b.hipY * 0.95);
      },
    },
    0,
    s,
  );
}

function personOf(sp: Spec, i: number, s: Stream): Person {
  const q = s.child(sp.name);
  const b = body(sp.H, sp.W, sp.belly, sp.headK, sp.legK);
  const f = new FigureBuilder();
  const d = sp.dress(q, b);
  // Clothes vary a little per seed so the same people look subtly different in another village.
  d.shirt = vary(d.shirt, { hue: 0.015, sat: 0.08, val: 0.06 }, q, 20);
  d.legs = vary(d.legs, { hue: 0.01, sat: 0.06, val: 0.05 }, q, 21);
  humanBody(f, b, d);
  sp.extra(f, b, q, d);
  return {
    name: sp.name,
    role: sp.role,
    slot: sp.slot ?? i,
    body: b,
    skel: humanSkeleton(b),
    parts: f.parts,
    holdL: sp.holdL ?? HOLD.none,
    holdR: sp.holdR ?? HOLD.none,
    listen: sp.listen ?? LISTEN.relaxed,
    energy: sp.energy ?? 1,
    speed: sp.speed,
    stoop: sp.stoop ?? 0,
    cycle: sp.cycle ?? 1.2,
  };
}
