// Details near the camera on Hearth (NSO-717): tufts of grass, stones and flowers in the squares of quadtree level 13
// (8 × 8 quads of the finest mesh, about 19 m), made by the engine's `nearScatter` from the plan and the climate, and
// drawn by its `NearInstanceLayer` round the eye only (details-page.ts). Pure: (seed, plan, stage, square) → records;
// the same bytes in Node, in a worker and on the page. Arithmetic, Math.sqrt / floor / ceil / abs / min / max, the
// engine's hashes, noise and reproducible trigonometry only.
//
// - Density of each kind is a continuous function of the place: the biome weights of the climate (`landWeights`),
//   water and slope at the 9 × 9 vertices of the finest mesh in the square, interpolated per candidate, so a border
//   between biomes is a gradient of a few metres and never a line. Flowers come in patches (a low noise).
// - A record stands on the drawn mesh of the finest level (the same flat triangles as the cells), sunk by a tenth of
//   its height; the shapes reach a quarter of their height below their base.
// - None in water or within 0.3 m of it, none within half the width + 0.3 m of a line of the plan (rivers; lanes and
//   roads once their stages are built), none on a lot of a site (stage 3) or within 0.3 m of a deck (stage 4). Tested
//   per candidate only in squares that water, a line, a site's lots or a deck can touch.
// - The fourth number of `i_color` (variant) is the kind plus a hash share 0–1: the material reads the kind from it.

import { RAD_PER_TURN, detCos, detSin } from 'wallhammer-web/base';
import type { MeshData, Vec3 } from 'wallhammer-web/base';
import { NearSquareGrid, cellId, cubeDirection, cubeGrid, hashInts, nearLatticeValue, nearScatter, valueNoise3 } from 'wallhammer-web/gen-core';
import type { NearFade, NearRecords, NearSquare } from 'wallhammer-web/gen-core';
import { SURFACES } from './bodies.ts';
import { BIOME, climateAt, landColor, landWeights } from './climate.ts';
import { planScope, planSiteAt, planStripHit, planSurface, planWater } from './ground.ts';
import type { Scope } from './ground.ts';
import { nearDeck } from './plan-lines.ts';
import { PLAN_BODY, STAGE } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { settlementOf } from './settlement.ts';
import type { Lot } from './settlement.ts';
import { SHAPE_LAYOUT } from './shapes.ts';
import { QUADS } from './world.ts';

export const DETAIL = { tuft: 0, stone: 1, flower: 2 } as const;
/** Squares are the cells of this quadtree level: 8 × 8 quads of the finest mesh, about 19 m. */
export const DETAIL_LEVEL = 13;
/** Instances sent to the graphics card, all kinds together. */
export const DETAIL_CEILING = 60_000;
/** Height above the surface where every gain is 0 (and nothing is made or kept). */
export const DETAIL_OFF_M = 300;

/** One kind: candidates per m², its fade, its ceiling and the tip shift per metre of height at wind strength 1. */
export interface DetailKind {
  name: string;
  perM2: number;
  fade: NearFade;
  maxInstances: number;
  bendM: number;
}

export const DETAIL_KINDS: readonly DetailKind[] = [
  { name: 'tuft', perM2: 3, fade: { reachM: 60, band: 0.6, softM: 9 }, maxInstances: 44_000, bendM: 0.4 },
  { name: 'stone', perM2: 0.2, fade: { reachM: 120, band: 0.6, softM: 18 }, maxInstances: 8000, bendM: 0 },
  { name: 'flower', perM2: 0.2, fade: { reachM: 120, band: 0.6, softM: 18 }, maxInstances: 8000, bendM: 0.4 },
];

type RGB = readonly [number, number, number];

/** What a biome gives each kind: the share of `perM2` kept (tuft, stone, flower), tuft height m, stone colour, flower colours. */
export interface DetailRule {
  share: readonly [number, number, number];
  tuftM: number;
  stone: RGB;
  flowers: readonly RGB[];
}

/** Per BIOME (sea, ice, tundra, taiga, forest, meadow, dry, rock). */
export const DETAIL_RULES: readonly DetailRule[] = [
  { share: [0, 0, 0], tuftM: 0.3, stone: [0.5, 0.5, 0.5], flowers: [] },
  { share: [0, 0.1, 0], tuftM: 0.2, stone: [0.62, 0.64, 0.68], flowers: [] },
  { share: [0.35, 0.5, 0.05], tuftM: 0.16, stone: [0.46, 0.44, 0.4], flowers: [[0.95, 0.95, 0.9], [0.95, 0.85, 0.4]] },
  { share: [0.4, 0.3, 0.05], tuftM: 0.22, stone: [0.42, 0.41, 0.38], flowers: [[0.95, 0.95, 0.92], [0.75, 0.55, 0.85]] },
  { share: [0.6, 0.2, 0.25], tuftM: 0.3, stone: [0.4, 0.39, 0.35], flowers: [[0.96, 0.96, 0.94], [0.55, 0.5, 0.9], [0.95, 0.8, 0.3]] },
  { share: [1, 0.1, 1], tuftM: 0.34, stone: [0.52, 0.5, 0.46], flowers: [[0.98, 0.86, 0.2], [0.97, 0.97, 0.95], [0.66, 0.42, 0.86], [0.86, 0.2, 0.18]] },
  { share: [0.15, 0.8, 0], tuftM: 0.2, stone: [0.66, 0.55, 0.42], flowers: [] },
  { share: [0.05, 1, 0], tuftM: 0.14, stone: [0.5, 0.48, 0.46], flowers: [] },
];

/** Bend of each kind's records (tuft, stone, flower). */
const BEND = [1, 0, 0.7] as const;
/** Flowers grow where this noise (cell in metres) is above the first value, fully above the second. */
const PATCH_M = 7;
const PATCH_FROM = 0.5;
const PATCH_FULL = 0.68;
/** Nothing within this many metres of water or of the edge of a line. */
const CLEAR_M = 0.3;
/** Sink of a base below the mesh, as a share of the height. */
const SINK = 0.1;

const R = SURFACES[PLAN_BODY]!.radiusM;
const LEAF = SURFACES[PLAN_BODY]!.leafLevel;
/** Vertex intervals of the finest mesh across a face, and per square. */
const NV = QUADS * 2 ** LEAF;
const SUB = (QUADS * 2 ** LEAF) / 2 ** DETAIL_LEVEL;
const LAT = SUB + 1;
/** Half the diagonal of the largest square, metres (with a margin). */
const HALF_DIAG_M = 14.5;

/** Half a turn in radians. */
const HALF_TURN = RAD_PER_TURN / 2;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- Shapes ----------------------------------------------------------------------------------------------------------

type P = [number, number, number];

/** Flat-shaded triangles in the shape layout of the example (a_pos, a_normal). */
function soup(tris: readonly (readonly [P, P, P])[]): MeshData {
  const v: number[] = [];
  for (const [a, b, c] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.sqrt(n[0]! * n[0]! + n[1]! * n[1]! + n[2]! * n[2]!) || 1;
    for (const p of [a, b, c]) v.push(p[0], p[1], p[2], n[0]! / l, n[1]! / l, n[2]! / l);
  }
  const vertices = Float32Array.from(v);
  return { layout: SHAPE_LAYOUT, vertices, indices: null, count: vertices.length / 6 };
}

/** Four crossed, tapering blades leaning outward: 12 triangles, seen from both sides. */
function tuftShape(): MeshData {
  const tris: [P, P, P][] = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * HALF_TURN + 0.3 * k;
    const c = detCos(a);
    const s = detSin(a);
    const lean = 0.18 + 0.05 * k;
    const at = (x: number, y: number): P => [c * x + s * lean * Math.max(0, y), y, s * x - c * lean * Math.max(0, y)];
    const w = 0.35;
    const bl = at(-w, -0.25);
    const br = at(w, -0.25);
    const ml = at(-0.55 * w, 0.5);
    const mr = at(0.55 * w, 0.5);
    const tip = at(0.1 * w, 1);
    tris.push([bl, br, mr], [bl, mr, ml], [ml, mr, tip]);
  }
  return soup(tris);
}

/** A rounded lump: a ring of six between a low and a high apex, 12 triangles. */
function stoneShape(): MeshData {
  const ring: P[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * HALF_TURN * 2;
    const r = 0.5 * (0.85 + 0.15 * ((k * 7) % 3) / 2);
    ring.push([detCos(a) * r, 0.35 + 0.08 * (k % 2), detSin(a) * r]);
  }
  const top: P = [0.06, 1, -0.04];
  const bottom: P = [0, -0.25, 0];
  const tris: [P, P, P][] = [];
  for (let k = 0; k < 6; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % 6]!;
    tris.push([a, top, b], [a, b, bottom]);
  }
  return soup(tris);
}

/** A stem of two crossed strips and a head of six triangles above y = 0.8: 10 triangles. */
function flowerShape(): MeshData {
  const tris: [P, P, P][] = [];
  const w = 0.06;
  for (const [c, s] of [[1, 0], [0, 1]] as const) {
    const p = (x: number, y: number): P => [c * x, y, s * x];
    tris.push([p(-w, -0.25), p(w, -0.25), p(w * 0.6, 0.82)], [p(-w, -0.25), p(w * 0.6, 0.82), p(-w * 0.6, 0.82)]);
  }
  const centre: P = [0, 1, 0];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * HALF_TURN * 2;
    const b = ((k + 1) / 6) * HALF_TURN * 2;
    tris.push([[detCos(a) * 0.5, 0.84, detSin(a) * 0.5], centre, [detCos(b) * 0.5, 0.84, detSin(b) * 0.5]]);
  }
  return soup(tris);
}

/** One unit shape per kind (base y = 0, top y = 1), in the order of `DETAIL`. */
export function detailShapes(): MeshData[] {
  return [tuftShape(), stoneShape(), flowerShape()];
}

// --- Squares ---------------------------------------------------------------------------------------------------------

/** A square of the details' grid (the engine's `NearSquare`). */
export type DetailSquare = NearSquare;

/** The squares of the details: level `DETAIL_LEVEL` of the cube grid. */
export const DETAIL_GRID = new NearSquareGrid({ level: DETAIL_LEVEL, radiusM: R, halfDiagM: HALF_DIAG_M });

/** The stage the details read the plan at: at most `routes`; below `climate` there are none. */
export function detailStage(stage: number): number {
  return Math.min(stage, STAGE.routes);
}

// --- Records of a square ---------------------------------------------------------------------------------------------

/** Whether direction d lies on the same side as vertex a of the plane through the centre and vertices b and c. */
function sameSide(p: Float64Array, a: number, b: number, c: number, dx: number, dy: number, dz: number): boolean {
  const wx = p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!;
  const wy = p[b + 2]! * p[c]! - p[b]! * p[c + 2]!;
  const wz = p[b]! * p[c + 1]! - p[b + 1]! * p[c]!;
  return (dx * wx + dy * wy + dz * wz) * (p[a]! * wx + p[a + 1]! * wy + p[a + 2]! * wz) >= 0;
}

/**
 * Distance from the centre at which the line along `d` meets the drawn mesh of the finest level in quad (qi, qj) of
 * the lattice `P` (vertex positions): the arithmetic of `spherePatchRadius` with step 1.
 */
function meshRadius(P: Float64Array, qi: number, qj: number, dx: number, dy: number, dz: number): number {
  const at = (i: number, j: number): number => (j * LAT + i) * 3;
  const v00 = at(qi, qj);
  const v10 = at(qi + 1, qj);
  const v01 = at(qi, qj + 1);
  const lower = sameSide(P, v00, v10, v01, dx, dy, dz);
  const A = lower ? v00 : at(qi + 1, qj + 1);
  const B = lower ? v10 : v01;
  const C = lower ? v01 : v10;
  const bx = P[B]! - P[A]!;
  const by = P[B + 1]! - P[A + 1]!;
  const bz = P[B + 2]! - P[A + 2]!;
  const cx = P[C]! - P[A]!;
  const cy = P[C + 1]! - P[A + 1]!;
  const cz = P[C + 2]! - P[A + 2]!;
  let nx = by * cz - bz * cy;
  let ny = bz * cx - bx * cz;
  let nz = bx * cy - by * cx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  return (nx * P[A]! + ny * P[A + 1]! + nz * P[A + 2]!) / (nx * dx + ny * dy + nz * dz);
}

/** Per lattice vertex: densities of the three kinds, tuft height, stone colour, ground colour, dominant biome. */
interface Lattice {
  /** Vertex positions on the drawn mesh, metres from the centre. */
  pos: Float64Array;
  dens: Float64Array;
  tuft: Float64Array;
  stone: Float64Array;
  ground: Float64Array;
  biome: Uint8Array;
  water: boolean;
  lines: boolean;
}

const weights = new Float64Array(8);

function lattice(scope: Scope, s: DetailSquare): Lattice {
  const n = LAT * LAT;
  const L: Lattice = { pos: new Float64Array(n * 3), dens: new Float64Array(n * 3), tuft: new Float64Array(n), stone: new Float64Array(n * 3), ground: new Float64Array(n * 3), biome: new Uint8Array(n), water: false, lines: false };
  const height = new Float64Array(n);
  const wet = new Uint8Array(n);
  const dir: Vec3 = [0, 0, 0];
  for (let j = 0; j < LAT; j++) {
    for (let i = 0; i < LAT; i++) {
      const k = j * LAT + i;
      // As the finest cell's mesh: cubeDirection of the global grid vertex, the height of `planSurface` there.
      cubeDirection(s.face, cubeGrid(s.i * SUB + i, NV), cubeGrid(s.j * SUB + j, NV), dir);
      const x = dir[0] * R;
      const y = dir[1] * R;
      const z = dir[2] * R;
      const h = planSurface(scope, x, y, z);
      const r = R + h;
      L.pos[k * 3] = dir[0] * r;
      L.pos[k * 3 + 1] = dir[1] * r;
      L.pos[k * 3 + 2] = dir[2] * r;
      height[k] = h;
      const water = planWater(scope, x, y, z).kind !== 0;
      wet[k] = water ? 1 : 0;
      if (water) L.water = true;
      if (planStripHit(scope, x, y, z)) L.lines = true;
      const { t, m } = climateAt(scope, x, y, z, h);
      const w = landWeights(t, m, h, weights);
      let best = 0;
      let tuftM = 0;
      let d0 = 0;
      let d1 = 0;
      let d2 = 0;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let b = 0; b < 8; b++) {
        const wb = w[b]!;
        if (wb > w[best]!) best = b;
        const rule = DETAIL_RULES[b]!;
        d0 += wb * rule.share[0];
        d1 += wb * rule.share[1];
        d2 += wb * rule.share[2];
        s0 += wb * rule.stone[0];
        s1 += wb * rule.stone[1];
        s2 += wb * rule.stone[2];
        tuftM += wb * rule.tuftM;
      }
      L.biome[k] = best;
      // No plant on the beach.
      const beach = smooth(0.5, 3, h);
      L.dens[k * 3] = water ? 0 : d0 * beach;
      L.dens[k * 3 + 1] = water ? 0 : d1;
      L.dens[k * 3 + 2] = water ? 0 : d2 * beach;
      L.tuft[k] = tuftM;
      L.stone[k * 3] = s0;
      L.stone[k * 3 + 1] = s1;
      L.stone[k * 3 + 2] = s2;
      const c = landColor(scope, x, y, z, h);
      for (let q = 0; q < 3; q++) L.ground[k * 3 + q] = c[q]! / 255;
    }
  }
  // Slope from the heights: plants thin out on steep ground, stones gather there.
  const step = Math.sqrt((L.pos[3]! - L.pos[0]!) ** 2 + (L.pos[4]! - L.pos[1]!) ** 2 + (L.pos[5]! - L.pos[2]!) ** 2) || 1;
  for (let j = 0; j < LAT; j++) {
    for (let i = 0; i < LAT; i++) {
      const k = j * LAT + i;
      if (wet[k]) continue;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(LAT - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(LAT - 1, j + 1);
      const su = (height[j * LAT + i1]! - height[j * LAT + i0]!) / ((i1 - i0) * step);
      const sv = (height[j1 * LAT + i]! - height[j0 * LAT + i]!) / ((j1 - j0) * step);
      const slope = Math.sqrt(su * su + sv * sv);
      const steep = smooth(0.45, 1, slope);
      L.dens[k * 3] = L.dens[k * 3]! * (1 - steep);
      L.dens[k * 3 + 1] = Math.min(1, L.dens[k * 3 + 1]! + 0.5 * steep);
      L.dens[k * 3 + 2] = L.dens[k * 3 + 2]! * (1 - steep);
    }
  }
  return L;
}

/** Bilinear value of channel `c` of `field` (stride `w`) at (u, v) of the square. */
const bilinear = (field: Float64Array, w: number, c: number, u: number, v: number): number => nearLatticeValue(field, SUB, w, c, u, v);

/** Area of a square on the base sphere, m²: two flat triangles between its corners. */
function squareArea(s: DetailSquare): number {
  const c = (a: number, b: number): Vec3 => {
    const d = cubeDirection(s.face, cubeGrid(s.i * SUB + a, NV), cubeGrid(s.j * SUB + b, NV));
    return [d[0] * R, d[1] * R, d[2] * R];
  };
  const p00 = c(0, 0);
  const p10 = c(SUB, 0);
  const p01 = c(0, SUB);
  const p11 = c(SUB, SUB);
  const tri = (a: Vec3, b: Vec3, d: Vec3): number => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    const x = uy * vz - uz * vy;
    const y = uz * vx - ux * vz;
    const z = ux * vy - uy * vx;
    return 0.5 * Math.sqrt(x * x + y * y + z * z);
  };
  return tri(p00, p10, p01) + tri(p11, p01, p10);
}

/** Whether a point (east, north m of its site's centre) lies on a lot: its depth runs toward the lane, its width across. */
function onLot(lot: Lot, x: number, z: number): boolean {
  const dx = x - lot.x;
  const dz = z - lot.z;
  return Math.abs(dx * lot.hx + dz * lot.hz) <= lot.depthM / 2 && Math.abs(dz * lot.hx - dx * lot.hz) <= lot.widthM / 2;
}

/**
 * The details of one square of the body `packed` names, at `stage` (`mask`: bit k makes kind k). `anchor` is the
 * surface point at the middle of the square (doubles), every record is relative to it, and `radiusM` holds every
 * record with its height. Below stage 2 there are none.
 */
export function generateDetails(packed: number, plan: WorldPlan, stage: number, s: DetailSquare, mask: number): { anchor: Vec3; radiusM: number; records: NearRecords } {
  const st = Math.min(detailStage(stage), plan.stage);
  const kinds = DETAIL_KINDS.length;
  const mid = SUB / 2;
  if (st < STAGE.climate) {
    const d = cubeDirection(s.face, cubeGrid(s.i * SUB + mid, NV), cubeGrid(s.j * SUB + mid, NV));
    return { anchor: [d[0] * R, d[1] * R, d[2] * R], radiusM: 0, records: { data: new Float32Array(0), start: new Uint32Array(kinds + 1) } };
  }
  const shift = 2 ** (DETAIL_LEVEL - LEAF);
  const cell = cellId(s.face, LEAF, Math.floor(s.i / shift), Math.floor(s.j / shift));
  const scope = planScope(plan, st, cell);
  const L = lattice(scope, s);
  const P = L.pos;
  const a0 = (mid * LAT + mid) * 3;
  const anchor: Vec3 = [P[a0]!, P[a0 + 1]!, P[a0 + 2]!];
  const area = squareArea(s);
  const patchSeed = hashInts(packed, 0x717, 2);
  // Stage 3 and 4: nothing stands on a lot (its structure is there) or under a deck. Asked only where a site's lots or
  // a deck can reach the square (its centre within the site's radius + 40 m, a deck within 20 m).
  const cx = anchor[0];
  const cy = anchor[1];
  const cz = anchor[2];
  const siteHere = st >= STAGE.sites ? planSiteAt(scope, cx, cy, cz) : null;
  const lotsHere = siteHere && siteHere.d < plan.sites!.radiusM[siteHere.site]! + 40 ? settlementOf(plan, siteHere.site).lots : null;
  const deckHere = st >= STAGE.routes && nearDeck(plan, cx, cy, cz, 20);
  const touched = L.water || L.lines || lotsHere !== null || deckHere;
  // Directions along the square's two grid axes, for the margin round water.
  const eu = [P[3]! - P[0]!, P[4]! - P[1]!, P[5]! - P[2]!];
  const ev = [P[LAT * 3]! - P[0]!, P[LAT * 3 + 1]! - P[1]!, P[LAT * 3 + 2]! - P[2]!];
  const lu = Math.sqrt(eu[0]! ** 2 + eu[1]! ** 2 + eu[2]! ** 2) || 1;
  const lv = Math.sqrt(ev[0]! ** 2 + ev[1]! ** 2 + ev[2]! ** 2) || 1;
  const dir: Vec3 = [0, 0, 0];
  const direction = (u: number, v: number): Vec3 => cubeDirection(s.face, cubeGrid(s.i * SUB + u * SUB, NV), cubeGrid(s.j * SUB + v * SUB, NV), dir);
  /** False where nothing may stand: water within `CLEAR_M`, or a line within its half-width and `CLEAR_M`. */
  const free = (u: number, v: number): boolean => {
    const d = direction(u, v);
    const x = d[0] * R;
    const y = d[1] * R;
    const z = d[2] * R;
    if (planWater(scope, x, y, z).kind !== 0) return false;
    if (L.water) {
      for (const [e, l, sgn] of [[eu, lu, 1], [eu, lu, -1], [ev, lv, 1], [ev, lv, -1]] as const) {
        const k = (sgn * CLEAR_M) / l;
        if (planWater(scope, x + e[0]! * k, y + e[1]! * k, z + e[2]! * k).kind !== 0) return false;
      }
    }
    const hit = planStripHit(scope, x, y, z);
    if (hit && (hit.share >= 1 || Math.abs(hit.acrossM) < hit.halfWidthM + CLEAR_M)) return false;
    if (lotsHere) {
      const at = planSiteAt(scope, x, y, z);
      if (at && at.site === siteHere!.site && lotsHere.some((lot) => onLot(lot, at.x, at.z))) return false;
    }
    if (deckHere && nearDeck(plan, x, y, z, CLEAR_M)) return false;
    return true;
  };
  let reach = 0;
  const records = nearScatter({
    seed: hashInts(packed, 0x717),
    key: [s.face, s.i, s.j],
    candidates: DETAIL_KINDS.map((k) => Math.ceil(k.perM2 * area)),
    mask,
    densityAt: (kind, u, v) => {
      let d = bilinear(L.dens, 3, kind, u, v);
      if (d <= 0) return 0;
      if (kind === DETAIL.flower) {
        const x = bilinear(P, 3, 0, u, v);
        const y = bilinear(P, 3, 1, u, v);
        const z = bilinear(P, 3, 2, u, v);
        d *= smooth(PATCH_FROM, PATCH_FULL, valueNoise3(x, y, z, PATCH_M, patchSeed));
        if (d <= 0) return 0;
      }
      if (touched && !free(u, v)) return 0;
      return Math.min(1, d);
    },
    fill: (kind, u, v, roll, out, at) => {
      let w: number;
      let h: number;
      let r: number;
      let g: number;
      let b: number;
      if (kind === DETAIL.tuft) {
        h = bilinear(L.tuft, 1, 0, u, v) * (0.65 + 0.7 * roll(1));
        w = h * (0.9 + 0.5 * roll(2));
        const k = 0.86 + 0.22 * roll(3);
        r = bilinear(L.ground, 3, 0, u, v) * k;
        g = bilinear(L.ground, 3, 1, u, v) * k;
        b = bilinear(L.ground, 3, 2, u, v) * k;
      } else if (kind === DETAIL.stone) {
        const q = roll(1);
        w = 0.08 + 0.32 * q * q;
        h = w * (0.45 + 0.35 * roll(2));
        const k = 0.8 + 0.35 * roll(3);
        r = bilinear(L.stone, 3, 0, u, v) * k;
        g = bilinear(L.stone, 3, 1, u, v) * k;
        b = bilinear(L.stone, 3, 2, u, v) * k;
      } else {
        h = 0.22 + 0.22 * roll(1);
        w = 0.08 + 0.08 * roll(2);
        // Colours of the biome at the nearest lattice vertex (the meadow's where it has none).
        const bi = L.biome[Math.floor(v * SUB + 0.5) * LAT + Math.floor(u * SUB + 0.5)]!;
        const pal = DETAIL_RULES[bi]!.flowers.length > 0 ? DETAIL_RULES[bi]!.flowers : DETAIL_RULES[BIOME.meadow]!.flowers;
        const c = pal[Math.min(pal.length - 1, Math.floor(roll(3) * pal.length))]!;
        const k = 0.9 + 0.15 * roll(4);
        r = c[0] * k;
        g = c[1] * k;
        b = c[2] * k;
      }
      const d = direction(u, v);
      const qi = Math.min(SUB - 1, Math.floor(u * SUB));
      const qj = Math.min(SUB - 1, Math.floor(v * SUB));
      const base = meshRadius(P, qi, qj, d[0], d[1], d[2]) - SINK * h;
      const x = d[0] * base - anchor[0];
      const y = d[1] * base - anchor[1];
      const z = d[2] * base - anchor[2];
      out[at] = x;
      out[at + 1] = y;
      out[at + 2] = z;
      out[at + 4] = w;
      out[at + 5] = h;
      out[at + 6] = roll(0) * RAD_PER_TURN;
      out[at + 7] = BEND[kind as 0 | 1 | 2];
      out[at + 8] = r;
      out[at + 9] = g;
      out[at + 10] = b;
      out[at + 11] = kind + 0.999 * roll(5);
      reach = Math.max(reach, Math.sqrt(x * x + y * y + z * z) + h + w);
    },
  });
  return { anchor, radiusM: reach, records };
}
