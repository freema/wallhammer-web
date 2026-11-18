// The climate of Hearth (stage 2 of the plan): temperature by latitude and height, moisture from the plan's water
// (plan-climate.ts), eight biomes from the two, and what a cell takes from them: ground colours from continuous
// weights round the biome thresholds (never the hard id), a frozen sea and lakes near the poles, the plants and stones
// of each biome as scatter rules, and the far cover as the expected value of those rules.
// Below stage 2 `climateAt` is the living terrain's own formula, bit for bit. Pure: (seed, plan, point) → value.

import { gridSample } from 'wallhammer-web/gen-plan';
import { hashInts, unit, valueNoise3 } from 'wallhammer-web/gen-core';
import { SURFACES } from './bodies.ts';
import { planClear, planWater } from './ground.ts';
import type { Scope } from './ground.ts';
import { PLAN_BODY, STAGE } from './plan.ts';
import { bodyClimate, livingParts } from './world.ts';
import type { Rule, RuleAnchor } from './world.ts';

export const BIOME = { sea: 0, ice: 1, tundra: 2, taiga: 3, forest: 4, meadow: 5, dry: 6, rock: 7 } as const;

type RGB = readonly [number, number, number];
type RGBA = [number, number, number, number];

/** Ground colours of the biomes; rock and beach as the living terrain has them. */
const ICE: RGB = [226, 236, 244];
const TUNDRA: RGB = [128, 124, 96];
const TAIGA: RGB = [74, 96, 58];
const FOREST: RGB = [70, 112, 48];
const MEADOW: RGB = [124, 150, 66];
const DRY: RGB = [200, 160, 104];
const ROCK: RGB = [120, 112, 104];
const SAND: RGB = [202, 188, 140];

/** Thresholds of the biomes in temperature, moisture and height, and the half-widths of the blend round them. */
const T_ICE = 0.16;
const T_TUNDRA = 0.3;
const T_TAIGA = 0.46;
const T_DRY = 0.62;
const M_TAIGA = 0.36;
const M_FOREST = 0.54;
const M_DRY = 0.34;
const H_ROCK = 1900;
const T_BLEND = 0.03;
const M_BLEND = 0.05;
const H_BLEND = 100;
/** No plant above this height, none on the beach below the second. */
const PLANT_TOP_M = 1700;
const PLANT_BOTTOM_M = 3;
/** Share of an anchor's square each plant hides from a slanted view (as the stage 1 conifer: 0.45). */
const COVER_TREE = 0.45;
const COVER_BROADLEAF = 0.55;
const COVER_SHRUB = 0.15;
const COVER_FLAT = 0.4;
const COVER_SHADE = 0.85;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const above = (x: number, th: number, w: number): number => smooth(th - w, th + w, x);
const mixRgb = (a: readonly number[], b: RGB, t: number): [number, number, number] => [a[0]! + (b[0] - a[0]!) * t, a[1]! + (b[1] - a[1]!) * t, a[2]! + (b[2] - a[2]!) * t];
const toBytes = (c: readonly number[], v: number, a: number): RGBA => [
  Math.min(255, Math.max(0, Math.round(c[0]! * v))),
  Math.min(255, Math.max(0, Math.round(c[1]! * v))),
  Math.min(255, Math.max(0, Math.round(c[2]! * v))),
  a,
];

// The radius of the body is read when asked, not when this module loads: plan.ts reaches this module through
// plan-sites.ts before its own constants exist.
const radiusM = (): number => SURFACES[PLAN_BODY]!.radiusM;

interface Seeds {
  temperature: number;
  moisture: number;
  edge: number;
}
const seedsOf = new Map<number, Seeds>();
function seeds(packed: number): Seeds {
  let s = seedsOf.get(packed);
  if (!s) {
    const k = (i: number): number => hashInts(packed, 0xc11a7e, i);
    s = { temperature: k(1), moisture: k(2), edge: k(3) };
    seedsOf.set(packed, s);
  }
  return s;
}

/**
 * Temperature 0–1 and moisture 0–1 at a point of the base sphere and its ground height `h`. Below stage 2 the
 * living terrain's own formula; from stage 2 the moisture of the plan and a little noise in both.
 */
export function climateAt(scope: Scope, x: number, y: number, z: number, h: number): { t: number; m: number } {
  const plan = scope.plan;
  if (scope.stage < STAGE.climate || !plan.wet) return bodyClimate(plan.seed, x, y, z, h)!;
  const S = seeds(plan.seed);
  const R = radiusM();
  const lat = Math.abs(y) / R;
  const t = 1 - 0.9 * lat * lat - Math.max(0, h) / 4600 + 0.05 * (2 * valueNoise3(x, y, z, 18000 * (R / 100_000), S.temperature) - 1);
  const m = Math.min(1, Math.max(0, gridSample(plan.grid, plan.wet, x, y, z) / 255 + 0.08 * (valueNoise3(x, y, z, 1800, S.moisture) - 0.5)));
  return { t, m };
}

/** Temperature of the place at sea level (for frozen water). */
function seaTemperature(scope: Scope, x: number, y: number, z: number): number {
  return climateAt(scope, x, y, z, 0).t;
}

/** The biome at a point: the first match of the thresholds (BIOME). */
export function biomeAt(scope: Scope, x: number, y: number, z: number, h: number): number {
  const water = planWater(scope, x, y, z).kind !== 0;
  if (water) return seaTemperature(scope, x, y, z) < T_ICE ? BIOME.ice : BIOME.sea;
  const { t, m } = climateAt(scope, x, y, z, h);
  if (t < T_ICE) return BIOME.ice;
  if (h > H_ROCK) return BIOME.rock;
  if (t < T_TUNDRA) return BIOME.tundra;
  if (t < T_TAIGA) return m >= M_TAIGA ? BIOME.taiga : BIOME.tundra;
  if (m >= M_FOREST) return BIOME.forest;
  if (t >= T_DRY && m < M_DRY) return BIOME.dry;
  return BIOME.meadow;
}

/**
 * The biome of dry land from its temperature, moisture and height: the thresholds of `biomeAt` without its water test
 * (for the nodes of the plan, which know their water from the plan's sections).
 */
export function landBiome(t: number, m: number, h: number): number {
  if (t < T_ICE) return BIOME.ice;
  if (h > H_ROCK) return BIOME.rock;
  if (t < T_TUNDRA) return BIOME.tundra;
  if (t < T_TAIGA) return m >= M_TAIGA ? BIOME.taiga : BIOME.tundra;
  if (m >= M_FOREST) return BIOME.forest;
  if (t >= T_DRY && m < M_DRY) return BIOME.dry;
  return BIOME.meadow;
}

/** Continuous weights of the land biomes (index by BIOME, sea 0), summing to 1. */
export function landWeights(t: number, m: number, h: number, out: Float64Array = new Float64Array(8)): Float64Array {
  const ice = 1 - above(t, T_ICE, T_BLEND);
  const rest = 1 - ice;
  const rock = rest * above(h, H_ROCK, H_BLEND);
  const L = rest - rock;
  const a = above(t, T_TUNDRA, T_BLEND);
  const b = above(t, T_TAIGA, T_BLEND);
  const warm = above(t, T_DRY, T_BLEND);
  const mT = above(m, M_TAIGA, M_BLEND);
  const mF = above(m, M_FOREST, M_BLEND);
  const mD = 1 - above(m, M_DRY, M_BLEND);
  out[BIOME.sea] = 0;
  out[BIOME.ice] = ice;
  out[BIOME.rock] = rock;
  out[BIOME.tundra] = L * (1 - a + a * (1 - b) * (1 - mT));
  out[BIOME.taiga] = L * a * (1 - b) * mT;
  out[BIOME.forest] = L * b * mF;
  out[BIOME.dry] = L * b * (1 - mF) * warm * mD;
  out[BIOME.meadow] = L * b * (1 - mF) * (1 - warm * mD);
  return out;
}

/** How frozen the water at a point is, 0–1, with a ragged edge. */
export function frozenShare(scope: Scope, x: number, y: number, z: number): number {
  const t = seaTemperature(scope, x, y, z);
  const ragged = 0.05 * (valueNoise3(x, y, z, 900, seeds(scope.plan.seed).edge) - 0.5) + 0.03 * (valueNoise3(x, y, z, 160, seeds(scope.plan.seed).edge + 1) - 0.5);
  return 1 - smooth(T_ICE - 0.02, T_ICE + 0.02, t + ragged);
}

/** Colour of frozen water: ice, land-like (alpha 0) where it has frozen through. */
export function frozenColor(open: RGBA, share: number): RGBA {
  if (share <= 0) return open;
  const c = mixRgb(open, ICE, smooth(0, 0.5, share));
  return toBytes(c, 1, share >= 0.5 ? 0 : open[3]);
}

const weights = new Float64Array(8);

/** Ground colour of land at stage 2, at the ground height `h` (alpha 0). */
export function landColor(scope: Scope, x: number, y: number, z: number, h: number): RGBA {
  const { t, m } = climateAt(scope, x, y, z, h);
  const w = landWeights(t, m, h, weights);
  const c: [number, number, number] = [0, 0, 0];
  const add = (col: RGB, k: number): void => {
    c[0] += col[0] * k;
    c[1] += col[1] * k;
    c[2] += col[2] * k;
  };
  add(TUNDRA, w[BIOME.tundra]!);
  add(TAIGA, w[BIOME.taiga]!);
  add(FOREST, w[BIOME.forest]!);
  add(MEADOW, w[BIOME.meadow]!);
  add(DRY, w[BIOME.dry]!);
  add(ROCK, w[BIOME.rock]!);
  // Ice last, so the weights of the others are taken from the land outside it.
  const ice = w[BIOME.ice]!;
  const rest = 1 - ice;
  let col: readonly number[] = rest > 0 ? [c[0]! / rest, c[1]! / rest, c[2]! / rest] : [ICE[0], ICE[1], ICE[2]];
  col = mixRgb(col, SAND, (1 - smooth(3, 26, h)) * rest);
  col = mixRgb(col, ROCK, smooth(1000, 2100, h) * 0.85 * rest);
  col = mixRgb(col, ICE, ice);
  const tint = livingParts(scope.plan.seed)?.tint(x, y, z) ?? 0.5;
  return toBytes(col, 0.9 + 0.2 * tint, 0);
}

/** Chances per anchor of the four plants, from the biome weights (no plant above 1700 m or on the beach). */
function plantChances(t: number, h: number, w: Float64Array): [tree: number, broadleaf: number, shrub: number, flat: number] {
  if (h > PLANT_TOP_M || h < PLANT_BOTTOM_M) return [0, 0, 0, 0];
  const tree = 0.75 * w[BIOME.taiga]! + 0.15 * w[BIOME.forest]! + 0.03 * w[BIOME.tundra]!;
  const broadleaf = 0.7 * w[BIOME.forest]! + 0.04 * w[BIOME.meadow]!;
  const shrub = 0.12 * w[BIOME.meadow]! + 0.1 * w[BIOME.tundra]! + 0.1 * w[BIOME.forest]! + 0.05 * w[BIOME.dry]!;
  const flat = 0.035 * w[BIOME.dry]! + 0.02 * w[BIOME.meadow]! * smooth(0.72, 0.78, t);
  return [tree, broadleaf, shrub, flat];
}

/** Colours of the plants before their own brightness. */
const coniferColor = (cold: number): RGB => [0.2 - 0.06 * cold, 0.34 - 0.05 * cold, 0.15 + 0.03 * cold];
const BROADLEAF_COLOR: RGB = [0.24, 0.38, 0.14];
const shrubColor = (dry: number): RGB => [0.3 + 0.12 * dry, 0.36 + 0.02 * dry, 0.16];
const FLAT_COLOR: RGB = [0.3, 0.36, 0.13];

/** What the plants look like from afar: rgb their chance-weighted mean colour, alpha the share they hide. */
export function landCover(scope: Scope, x: number, y: number, z: number, h: number): RGBA {
  const { t, m } = climateAt(scope, x, y, z, h);
  const w = landWeights(t, m, h, weights);
  const [ct, cb, cs, cf] = plantChances(t, h, w);
  const kt = ct * COVER_TREE;
  const kb = cb * COVER_BROADLEAF;
  const ks = cs * COVER_SHRUB;
  const kf = cf * COVER_FLAT;
  const sum = kt + kb + ks + kf;
  if (sum <= 0) return [0, 0, 0, 0];
  const conifer = coniferColor(1 - smooth(0.3, 0.5, t));
  const shrub = shrubColor(w[BIOME.dry]!);
  const v = (0.975 * COVER_SHADE * 255) / sum;
  const ch = (k: 0 | 1 | 2): number => Math.round((conifer[k] * kt + BROADLEAF_COLOR[k] * kb + shrub[k] * ks + FLAT_COLOR[k] * kf) * v);
  return [ch(0), ch(1), ch(2), Math.round(255 * (1 - Math.exp(-sum)))];
}

/** The scatter rules of stage 2 for a body whose objects start at `leafLevel` (ids from 11). */
export function climateRules(scope: Scope, leafLevel: number): Rule[] {
  const packed = scope.plan.seed;
  const parts = livingParts(packed);
  const range = (x: number, y: number, z: number): number => parts?.rangeShare(x, y, z) ?? 0;
  const w = new Float64Array(8);
  /** The one draw an anchor of the plants' grid makes, shared by the four plant rules. */
  const draw = (at: RuleAnchor): number => unit(hashInts(packed, 0x715, at.face, at.i, at.j));
  /** The slice of the draw a plant takes: its chance after the chances of the plants before it. */
  const plant = (slot: 0 | 1 | 2 | 3) => (x: number, y: number, z: number, h: number, at: RuleAnchor): { t: number; m: number } | null => {
    const c = climateAt(scope, x, y, z, h);
    const chances = plantChances(c.t, h, landWeights(c.t, c.m, h, w));
    let from = 0;
    for (let k = 0; k < slot; k++) from += chances[k]!;
    const u = draw(at);
    if (u < from || u >= from + chances[slot]!) return null;
    if (!planClear(scope, x, y, z)) return null;
    return c;
  };
  const tree = plant(0);
  const broadleaf = plant(1);
  const shrub = plant(2);
  const flat = plant(3);
  return [
    {
      id: 11,
      name: 'rock',
      gridLevel: leafLevel + 1,
      place: (x, y, z, h, r) => {
        if (h < 2 || !planClear(scope, x, y, z)) return null;
        const c = climateAt(scope, x, y, z, h);
        const b = landWeights(c.t, c.m, h, w);
        if (b[BIOME.ice]! > 0.5) return null;
        // As at stage 1, and more of them in rock and tundra.
        if (r(3) > 0.06 + 0.4 * range(x, y, z) + 0.2 * smooth(1200, 2200, h) + 0.15 * b[BIOME.rock]! + 0.08 * b[BIOME.tundra]!) return null;
        const size = 1.2 + 6 * r(4) * r(4);
        const tone = 0.8 + 0.3 * r(5);
        // Tinted a little by the ground round it.
        const g = landColor(scope, x, y, z, h);
        const k = 0.2 / 255;
        return [size, size * (0.5 + 0.4 * r(6)), r(7) * 6.2832, size, size * (0.7 + 0.5 * r(8)), (0.4 + g[0] * k) * tone, (0.376 + g[1] * k) * tone, (0.344 + g[2] * k) * tone, 0];
      },
    },
    {
      id: 12,
      name: 'tree',
      gridLevel: leafLevel + 2,
      place: (x, y, z, h, r, at) => {
        const c = tree(x, y, z, h, at);
        if (!c) return null;
        const height = 9 + 13 * r(4);
        const cold = 1 - smooth(0.3, 0.5, c.t);
        const col = coniferColor(cold);
        const v = 0.85 + 0.25 * r(5);
        return [height * 0.35, height, r(6) * 6.2832, height * (0.28 + 0.08 * r(7)), 0, col[0] * v, col[1] * v, col[2] * v, c.t < 0.36 ? 1 : 0];
      },
    },
    {
      id: 13,
      name: 'broadleaf',
      gridLevel: leafLevel + 2,
      place: (x, y, z, h, r, at) => {
        if (!broadleaf(x, y, z, h, at)) return null;
        const height = 10 + 10 * r(4);
        const v = 0.82 + 0.3 * r(5);
        const width = height * (0.55 + 0.15 * r(7));
        return [width * 0.5, height, r(6) * 6.2832, width, width * (0.85 + 0.3 * r(8)), BROADLEAF_COLOR[0] * v, BROADLEAF_COLOR[1] * v, BROADLEAF_COLOR[2] * v, 0];
      },
    },
    {
      id: 14,
      name: 'shrub',
      gridLevel: leafLevel + 2,
      place: (x, y, z, h, r, at) => {
        const c = shrub(x, y, z, h, at);
        if (!c) return null;
        const height = 0.8 + 1.6 * r(4);
        const width = height * (1.3 + 0.6 * r(7));
        const col = shrubColor(smooth(0.5, 0.75, c.t) * (1 - smooth(0.3, 0.5, c.m)));
        const v = 0.85 + 0.25 * r(5);
        return [width * 0.5, height, r(6) * 6.2832, width, width * (0.8 + 0.4 * r(8)), col[0] * v, col[1] * v, col[2] * v, c.t < 0.3 ? 1 : 0];
      },
    },
    {
      id: 15,
      name: 'flat-crown',
      gridLevel: leafLevel + 2,
      place: (x, y, z, h, r, at) => {
        if (!flat(x, y, z, h, at)) return null;
        const height = 6 + 6 * r(4);
        const width = height * (0.9 + 0.4 * r(7));
        const v = 0.85 + 0.25 * r(5);
        return [width * 0.5, height, r(6) * 6.2832, width, width * (0.8 + 0.4 * r(8)), FLAT_COLOR[0] * v, FLAT_COLOR[1] * v, FLAT_COLOR[2] * v, 0];
      },
    },
    {
      id: 16,
      name: 'shard',
      gridLevel: leafLevel + 1,
      place: (x, y, z, h, r) => {
        const water = planWater(scope, x, y, z).kind;
        let chance: number;
        if (water === 1 || water === 2) chance = frozenShare(scope, x, y, z) >= 0.5 ? 0.015 : 0;
        else if (water === 3 || !planClear(scope, x, y, z)) chance = 0;
        else chance = 0.05 * smooth(0.5, 1, landWeights(climateAt(scope, x, y, z, h).t, 0.5, h, w)[BIOME.ice]!);
        if (r(3) >= chance) return null;
        const size = 0.8 + 3 * r(4) * r(4);
        const tone = 0.85 + 0.2 * r(5);
        return [size * 0.6, size * (1.1 + 1.4 * r(6)), r(7) * 6.2832, size, size * (0.6 + 0.6 * r(8)), 0.72 * tone, 0.8 * tone, 0.88 * tone, 0];
      },
    },
  ];
}
