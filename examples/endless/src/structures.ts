// Small structures of blocks for the damage demo of the endless world (dmg=1), built on the engine's destructible
// data types only (no content module):
//   - `cellStructures(seed, home)`: the structures a home cell (level 9, 128 m) owns, a pure function of the seed and
//     the cell (stream 0x5d0), in centimetres relative to the home cell's origin, so they keep their precision far out;
//   - `structureMeshes(...)`: the mesh of the structures of a home cell in a damage state, flat shaded, own layout;
//   - `generateDamageCell(seed, cell, edits)`: `generateSmoothCell` through its hooks, with the structures of every home
//     cell at or under the cell (levels 7–9) in their state from the edits text, and no objects next to them.
// The damage state is never read from a store or a global: a cell's bytes are a function of (seed, cell, edits).

import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import { DAMAGE, PART_FLAG, PART_ROLE, entryRung } from 'wallhammer-web/base';
import type { DestructionEvent, StructureBond, StructureDesc, StructurePart, StructureState } from 'wallhammer-web/base';
import { cellId, cellKey, hashInts, unit } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, LocalBounds } from 'wallhammer-web/gen-core';
import { compileStructure, decodeCellStates, rubbleFootprints } from 'wallhammer-web/sim/destruction';
import { FACE, LEAF_LEVEL, RULES, SHAPE, buildSmoothCell, groundHeight, surfaceHeight } from './terrain.ts';

/** The level of the cells that own structures (128 m). */
export const HOME_LEVEL = LEAF_LEVEL;
/** Structures are drawn in cells of this level and finer, not in coarser ones. */
export const STRUCTURE_MIN_LEVEL = 7;
/** Domain version of the cells of `generateDamageCell` (the smooth generator has 1, the strips 2). */
export const DAMAGE_DOMAIN_VERSION = 3;
const STREAM = 0x5d0;
/** Share of home cells that hold a structure. */
const SHARE = 1 / 3;
/** Least distance of a structure's centre from its home cell's border, metres. */
const BORDER_M = 24;
/** Objects keep this distance from a structure's centre, metres. */
const CLEAR_M = 12;
/** Block of the ring: 2 × 2 m, 2.5 m high; the plinth reaches this far under the lowest ground, centimetres. */
const BLOCK = 200;
const TIER = 250;
const COVER = 40;
const PLINTH_HALF = 360;
const PLINTH_DEPTH = 400;
/** Slots of the ring of a 3 × 3 grid without its middle, in order round the ring: (column, row). */
const RING: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1],
];
const KEY_PLINTH = 1;
const blockKey = (tier: number, slot: number): number => 0x100 + tier * 16 + slot;
const coverKey = (quarter: number): number => 0x800 + quarter;

const MATERIALS = [
  { crack: 260, breach: 520, gone: 800, density: 1800 },
  { crack: 100000, breach: 0, gone: 100000, density: 2400 },
];

const box = (x0: number, z0: number, x1: number, z1: number): Int32Array => Int32Array.of(x0, z0, x1, z0, x1, z1, x0, z1);

/** The home cell that owns a world point. */
export function homeCellAt(x: number, z: number): CellId {
  return SHAPE.cellAt([x, 0, z], HOME_LEVEL);
}

/** Is there a pillar (the one tall object rule of coarse levels) within reach of a point? */
function nearPillar(seed: number, x: number, z: number): boolean {
  const rule = RULES.find((r) => r.name === 'pillar')!;
  const g = rule.gridM;
  const gi = Math.floor(x / g);
  const gj = Math.floor(z / g);
  for (let j = gj - 1; j <= gj + 1; j++) {
    for (let i = gi - 1; i <= gi + 1; i++) {
      const r = (k: number): number => unit(hashInts(seed, rule.id, i, j, k));
      const px = (i + 0.1 + 0.8 * r(1)) * g;
      const pz = (j + 0.1 + 0.8 * r(2)) * g;
      const p = rule.place(seed, px, pz, groundHeight(seed, px, pz), r);
      if (!p) continue;
      const reach = p[0]! + CLEAR_M + 8;
      if ((px - x) * (px - x) + (pz - z) * (pz - z) < reach * reach) return true;
    }
  }
  return false;
}

/** One structure: a ring of blocks in tiers on a plinth, with four cover parts on top. Centimetres, home-local. */
function ringStructure(id: number, cx: number, cz: number, groundY: number, lowY: number, tiers: number): StructureDesc {
  const parts: StructurePart[] = [];
  const bonds: StructureBond[] = [];
  const x0 = cx - (3 * BLOCK) / 2;
  const z0 = cz - (3 * BLOCK) / 2;
  parts.push({
    key: KEY_PLINTH,
    role: PART_ROLE.foundation,
    material: 1,
    mass: Math.round(2 * PLINTH_HALF * 2 * PLINTH_HALF * (groundY - lowY) * 2.4e-3),
    piece: { xz: box(cx - PLINTH_HALF, cz - PLINTH_HALF, cx + PLINTH_HALF, cz + PLINTH_HALF), y0: lowY, y1: groundY },
    flags: PART_FLAG.anchor | PART_FLAG.indestructible,
    maxSpan: 255,
  });
  const blockMass = Math.round(BLOCK * BLOCK * TIER * 1.8e-3);
  for (let t = 0; t < tiers; t++) {
    for (let s = 0; s < RING.length; s++) {
      const [c, r] = RING[s]!;
      const bx = x0 + c * BLOCK;
      const bz = z0 + r * BLOCK;
      const y0 = groundY + t * TIER;
      parts.push({ key: blockKey(t, s), role: PART_ROLE.bearing, material: 0, mass: blockMass, piece: { xz: box(bx, bz, bx + BLOCK, bz + BLOCK), y0, y1: y0 + TIER }, flags: 0, maxSpan: 1 });
      const centre = { x: bx + BLOCK / 2, z: bz + BLOCK / 2 };
      // Bearing: on the plinth or on the block of the tier below.
      bonds.push({ a: t === 0 ? KEY_PLINTH : blockKey(t - 1, s), b: blockKey(t, s), bearing: true, x: centre.x, y: y0, z: centre.z, area: BLOCK * BLOCK });
      // Lateral tie to the next slot round the ring (they share a face).
      const n = (s + 1) % RING.length;
      const [c2, r2] = RING[n]!;
      const fx = x0 + ((c + c2 + 1) * BLOCK) / 2;
      const fz = z0 + ((r + r2 + 1) * BLOCK) / 2;
      bonds.push({ a: Math.min(blockKey(t, s), blockKey(t, n)), b: Math.max(blockKey(t, s), blockKey(t, n)), bearing: false, x: fx, y: y0 + TIER / 2, z: fz, area: BLOCK * TIER });
    }
  }
  // Cover: four quarters of the top, each resting on the top-tier blocks under it, tied to its two neighbours.
  const top = groundY + tiers * TIER;
  const half = (3 * BLOCK) / 2;
  for (let k = 0; k < 4; k++) {
    const qx = k & 1;
    const qz = k >> 1;
    const ax = x0 + qx * half;
    const az = z0 + qz * half;
    parts.push({ key: coverKey(k), role: PART_ROLE.span, material: 0, mass: Math.round(half * half * COVER * 1.8e-3), piece: { xz: box(ax, az, ax + half, az + half), y0: top, y1: top + COVER }, flags: 0, maxSpan: 1 });
    for (let s = 0; s < RING.length; s++) {
      const [c, r] = RING[s]!;
      // The blocks of columns and rows the quarter overlaps.
      const cols = qx === 0 ? c <= 1 : c >= 1;
      const rows = qz === 0 ? r <= 1 : r >= 1;
      if (!cols || !rows) continue;
      const ox0 = Math.max(ax, x0 + c * BLOCK);
      const ox1 = Math.min(ax + half, x0 + (c + 1) * BLOCK);
      const oz0 = Math.max(az, z0 + r * BLOCK);
      const oz1 = Math.min(az + half, z0 + (r + 1) * BLOCK);
      bonds.push({ a: blockKey(tiers - 1, s), b: coverKey(k), bearing: true, x: (ox0 + ox1) >> 1, y: top, z: (oz0 + oz1) >> 1, area: (ox1 - ox0) * (oz1 - oz0) });
    }
  }
  for (const [a, b, x, z] of [
    [0, 1, cx, cz - half / 2],
    [2, 3, cx, cz + half / 2],
    [0, 2, cx - half / 2, cz],
    [1, 3, cx + half / 2, cz],
  ] as const) {
    bonds.push({ a: coverKey(a), b: coverKey(b), bearing: false, x, y: top + COVER / 2, z, area: half * COVER });
  }
  parts.sort((p, q) => p.key - q.key);
  bonds.sort((p, q) => p.a - q.a || p.b - q.b);
  return {
    id,
    keepOut: false,
    groundY,
    cx,
    cz,
    outline: box(x0, z0, x0 + 3 * BLOCK, z0 + 3 * BLOCK),
    materials: MATERIALS,
    parts,
    bonds,
  };
}

const structureCache = new Map<string, StructureDesc[]>();

/**
 * Structures of a home cell (level `HOME_LEVEL`): about one cell in three holds one, its centre at least 24 m from the
 * cell border, its ground at least 2 m above the water and within 3 m of level, and no pillar near it. Pure and
 * cached. Coordinates are centimetres relative to the home cell's origin; `id` is the index in the cell.
 */
export function cellStructures(seed: number, home: CellId): StructureDesc[] {
  if (home.level !== HOME_LEVEL) return [];
  const key = `${seed}|${cellKey(home)}`;
  const hit = structureCache.get(key);
  if (hit) return hit;
  const out: StructureDesc[] = [];
  const r = (k: number): number => unit(hashInts(seed, STREAM, home.face, home.x, home.y, k));
  if (r(1) < SHARE) {
    const edge = SHAPE.edgeM(HOME_LEVEL);
    const o = SHAPE.origin(home);
    // Whole decimetres, so every coordinate below is a whole centimetre.
    const lx = Math.round((BORDER_M + r(2) * (edge - 2 * BORDER_M)) * 10) / 10;
    const lz = Math.round((BORDER_M + r(3) * (edge - 2 * BORDER_M)) * 10) / 10;
    const x = o[0] + lx;
    const z = o[2] + lz;
    const reach = PLINTH_HALF / 100;
    let lo = Infinity;
    let hi = -Infinity;
    let water = Infinity;
    for (const [dx, dz] of [[0, 0], [-reach, -reach], [reach, -reach], [reach, reach], [-reach, reach], [0, -reach], [reach, 0], [0, reach], [-reach, 0]] as const) {
      const h = surfaceHeight(seed, x + dx, z + dz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      water = Math.min(water, groundHeight(seed, x + dx, z + dz));
    }
    if (water >= 2 && hi - lo <= 3 && !nearPillar(seed, x, z)) {
      const groundY = Math.ceil((hi + 0.15) * 100);
      const lowY = Math.floor(lo * 100) - PLINTH_DEPTH;
      out.push(ringStructure(0, Math.round(lx * 100), Math.round(lz * 100), groundY, lowY, 4 + Math.floor(r(4) * 3)));
    }
  }
  structureCache.set(key, out);
  return out;
}

/** Home cells at or under a cell, in cell order; none for a cell coarser than `STRUCTURE_MIN_LEVEL`. */
export function homeCellsUnder(cell: CellId): CellId[] {
  if (cell.level < STRUCTURE_MIN_LEVEL || cell.level > HOME_LEVEL) return [];
  const n = 2 ** (HOME_LEVEL - cell.level);
  const out: CellId[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out.push(cellId(cell.face, HOME_LEVEL, cell.x * n + x, cell.y * n + y));
  return out;
}

/** Cells of levels 7–9 that draw the structures of a home cell, finest first. */
export function drawingCells(home: CellId): CellId[] {
  const out: CellId[] = [];
  for (let level = HOME_LEVEL; level >= STRUCTURE_MIN_LEVEL; level--) {
    const d = HOME_LEVEL - level;
    out.push(cellId(home.face, level, Math.floor(home.x / 2 ** d), Math.floor(home.y / 2 ** d)));
  }
  return out;
}

// --- Mesh --------------------------------------------------------------------------------------------------------------

/** Position (metres, relative to the drawing cell), flat normal, colour (a: 1 for rubble). */
export const STRUCTURE_LAYOUT: VertexLayout = {
  stride: 20,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i8', normalized: true, offset: 12 },
    { name: 'a_color', size: 4, type: 'u8', normalized: true, offset: 16 },
  ],
};

type RGB = readonly [number, number, number];
const STONE: RGB = [184, 166, 134];
const COVER_RGB: RGB = [146, 98, 76];
const PLINTH_RGB: RGB = [122, 118, 112];
const RUBBLE_RGB: RGB = [150, 136, 112];
/** Tint by rung: intact, cracked (darker), breached (darkest). */
const RUNG_SHADE = [1, 0.74, 0.52] as const;

class MeshWriter {
  private readonly f: number[] = [];
  private readonly n: number[] = [];
  private readonly c: number[] = [];
  private readonly idx: number[] = [];
  private count = 0;
  readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  /** A planar convex polygon (counter-clockwise seen from the side the normal points to). */
  face(pts: readonly (readonly [number, number, number])[], normal: readonly [number, number, number], rgb: RGB, rubble: number): void {
    const base = this.count;
    for (const p of pts) {
      this.f.push(p[0], p[1], p[2]);
      this.n.push(Math.round(normal[0] * 127), Math.round(normal[1] * 127), Math.round(normal[2] * 127), 0);
      this.c.push(Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), rubble);
      for (let k = 0; k < 3; k++) {
        this.min[k] = Math.min(this.min[k]!, p[k]!);
        this.max[k] = Math.max(this.max[k]!, p[k]!);
      }
      this.count++;
    }
    for (let k = 1; k + 1 < pts.length; k++) this.idx.push(base, base + k, base + k + 1);
  }

  get empty(): boolean {
    return this.count === 0;
  }

  mesh(): MeshData {
    const bytes = new ArrayBuffer(this.count * STRUCTURE_LAYOUT.stride);
    const f = new Float32Array(bytes);
    const b = new Int8Array(bytes);
    const u = new Uint8Array(bytes);
    for (let v = 0; v < this.count; v++) {
      const o = v * 5;
      f[o] = this.f[v * 3]!;
      f[o + 1] = this.f[v * 3 + 1]!;
      f[o + 2] = this.f[v * 3 + 2]!;
      for (let k = 0; k < 4; k++) {
        b[v * 20 + 12 + k] = this.n[v * 4 + k]!;
        u[v * 20 + 16 + k] = this.c[v * 4 + k]!;
      }
    }
    return { layout: STRUCTURE_LAYOUT, vertices: u, indices: Uint32Array.from(this.idx), count: this.idx.length };
  }
}

/**
 * A vertical prism over a convex polygon (`xz` in cm, counter-clockwise with x right and z down), offset by (ox, oz)
 * metres. `bottom` false leaves out the floor.
 */
function prism(w: MeshWriter, xz: Int32Array, y0: number, y1: number, ox: number, oz: number, rgb: RGB, bottom: boolean, rubble = 0, top?: Int32Array, yTop?: number): void {
  const n = xz.length / 2;
  const at = (poly: Int32Array, k: number, y: number): [number, number, number] => [ox + poly[k * 2]! / 100, y / 100, oz + poly[k * 2 + 1]! / 100];
  const up = top ?? xz;
  const yt = yTop ?? y1;
  // Seen from above (+y) with z pointing down the screen, counter-clockwise in (x, z) is clockwise: reverse for the top.
  w.face(Array.from({ length: n }, (_, k) => at(up, n - 1 - k, yt)), [0, 1, 0], rgb, rubble);
  if (bottom) w.face(Array.from({ length: n }, (_, k) => at(xz, k, y0)), [0, -1, 0], scale(rgb, 0.6), rubble);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ex = xz[j * 2]! - xz[k * 2]!;
    const ez = xz[j * 2 + 1]! - xz[k * 2 + 1]!;
    const len = Math.sqrt(ex * ex + ez * ez) || 1;
    // Outward normal of a counter-clockwise edge (x right, z down): (ez, −ex).
    const nx = ez / len;
    const nz = -ex / len;
    const shade = 0.82 + 0.12 * nx - 0.06 * nz;
    w.face([at(xz, k, y0), at(xz, j, y0), at(up, j, yt), at(up, k, yt)].reverse(), [nx, 0, nz], scale(rgb, shade), rubble);
  }
}

const scale = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];

/** A small hashed variation of a colour per part. */
function vary(c: RGB, structure: number, key: number): RGB {
  return scale(c, 0.92 + 0.12 * unit(hashInts(0x5d1, structure, key)));
}

/** The low heap of one rubble footprint: walls from deep under the ground, a top shrunk to half. */
function heap(w: MeshWriter, corners: Int32Array, y: number, height: number, ox: number, oz: number): void {
  let cx = 0;
  let cz = 0;
  for (let k = 0; k < 4; k++) (cx += corners[k * 2]!), (cz += corners[k * 2 + 1]!);
  cx /= 4;
  cz /= 4;
  const top = new Int32Array(8);
  for (let k = 0; k < 4; k++) {
    top[k * 2] = Math.round(cx + (corners[k * 2]! - cx) * 0.5);
    top[k * 2 + 1] = Math.round(cz + (corners[k * 2 + 1]! - cz) * 0.5);
  }
  // The skirt reaches under the plinth's lowest ground, so the heap never floats over a slope.
  prism(w, corners, y - PLINTH_DEPTH, y, ox, oz, scale(RUBBLE_RGB, 0.85), false, 1);
  const n = 4;
  const at = (poly: Int32Array, k: number, yy: number): [number, number, number] => [ox + poly[k * 2]! / 100, yy / 100, oz + poly[k * 2 + 1]! / 100];
  w.face(Array.from({ length: n }, (_, k) => at(top, n - 1 - k, y + height)), [0, 1, 0], RUBBLE_RGB, 1);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ex = corners[j * 2]! - corners[k * 2]!;
    const ez = corners[j * 2 + 1]! - corners[k * 2 + 1]!;
    const len = Math.sqrt(ex * ex + ez * ez) || 1;
    const nx = ez / len;
    const nz = -ex / len;
    const s = Math.sqrt(height * height + 1e4);
    const ny = 100 / s;
    const k2 = height / s;
    w.face([at(corners, k, y), at(corners, j, y), at(top, j, y + height), at(top, k, y + height)].reverse(), [nx * k2, ny, nz * k2], scale(RUBBLE_RGB, 0.9 + 0.08 * nx), 1);
  }
}

/**
 * Adds the structures of one home cell in their states: every part below `gone` as its prism tinted by rung, nothing
 * for a gone part, a heap per footprint of `rubbleFootprints`; a ruin is its plinth and the ruin's heap. (ox, oz) is
 * the home cell's origin relative to the drawing cell, metres.
 */
export function structureMeshes(w: MeshWriter, structures: readonly StructureDesc[], states: ReadonlyMap<number, StructureState>, ox: number, oz: number): void {
  for (const d of structures) {
    const state = states.get(d.id);
    const ruin = state?.ruin ?? false;
    for (const p of d.parts) {
      const indestructible = (p.flags & PART_FLAG.indestructible) !== 0;
      if (ruin && !indestructible) continue;
      const e = state?.parts.get(p.key);
      const rung = e === undefined ? DAMAGE.intact : entryRung(e);
      if (rung === DAMAGE.gone) continue;
      const base = p.key === KEY_PLINTH ? PLINTH_RGB : p.role === PART_ROLE.span ? COVER_RGB : STONE;
      prism(w, p.piece.xz, p.piece.y0, p.piece.y1, ox, oz, scale(vary(base, d.id, p.key), RUNG_SHADE[rung as 0 | 1 | 2]), p.key !== KEY_PLINTH);
    }
    if (state) for (const f of rubbleFootprints(compileStructure(d), state)) heap(w, f.corners, f.y, f.height, ox, oz);
  }
}

export { MeshWriter };

// --- The generator -------------------------------------------------------------------------------------------------

/** States per home cell from the edits text (a store decoded from it); empty without edits. */
function statesOf(edits: string | undefined): (home: CellId) => ReadonlyMap<number, StructureState> {
  if (!edits) return () => EMPTY_STATES;
  const { store } = decodeCellStates(edits, { maxUnits: 1 << 30 });
  return (home) => store.of(home);
}
const EMPTY_STATES: ReadonlyMap<number, StructureState> = new Map();

/** No object within 12 m of a structure. Structures stay 24 m inside their home cell, so only that one is asked. */
function keepObject(seed: number): (x: number, z: number) => boolean {
  return (x, z) => {
    const home = homeCellAt(x, z);
    const list = cellStructures(seed, home);
    if (list.length === 0) return true;
    const o = SHAPE.origin(home);
    for (const d of list) {
      const dx = x - (o[0] + d.cx / 100);
      const dz = z - (o[2] + d.cz / 100);
      if (dx * dx + dz * dz < CLEAR_M * CLEAR_M) return false;
    }
    return true;
  };
}

/**
 * Generates one smooth cell with the structures (dmg=1). Pure: (seed, cell, edits) → content. `edits` is the text of a
 * `CellStates` store (all or part of it); the cell draws the structures of every home cell at or under it, in the state
 * the text gives, and coarser cells than level 7 draw none.
 */
export function generateDamageCell(seed: number, cell: CellId, edits?: string): CellContent {
  const homes = homeCellsUnder(cell);
  const keep = keepObject(seed);
  if (homes.length === 0) return buildSmoothCell(seed, cell, { keepObject: keep, domainVersion: DAMAGE_DOMAIN_VERSION });
  const states = statesOf(edits);
  return buildSmoothCell(seed, cell, {
    keepObject: keep,
    domainVersion: DAMAGE_DOMAIN_VERSION,
    extra: () => {
      const w = new MeshWriter();
      const o = SHAPE.origin(cell);
      for (const home of homes) {
        const list = cellStructures(seed, home);
        if (list.length === 0) continue;
        const h = SHAPE.origin(home);
        structureMeshes(w, list, states(home), h[0] - o[0], h[2] - o[2]);
      }
      if (w.empty) return [];
      const bounds: LocalBounds = { min: [w.min[0], w.min[1], w.min[2]], max: [w.max[0], w.max[1], w.max[2]] };
      return [{ material: 'structure', mesh: w.mesh(), bounds }];
    },
  });
}

// --- The demo structure and its events -------------------------------------------------------------------------------

/** Where the demo looks first: the first home cell with a structure in a fixed spiral round the default start (0, 0). */
export function findDemoStructure(seed: number): { home: CellId; structure: StructureDesc; x: number; y: number; z: number } {
  const start = homeCellAt(0, 0);
  for (let ring = 0; ring < 64; ring++) {
    // The ring of cells at Chebyshev distance `ring`, from its top-left corner clockwise.
    const cells: [number, number][] = [];
    if (ring === 0) cells.push([0, 0]);
    else {
      for (let k = -ring; k < ring; k++) cells.push([k, -ring]);
      for (let k = -ring; k < ring; k++) cells.push([ring, k]);
      for (let k = ring; k > -ring; k--) cells.push([k, ring]);
      for (let k = ring; k > -ring; k--) cells.push([-ring, k]);
    }
    for (const [dx, dy] of cells) {
      const home = cellId(FACE, HOME_LEVEL, start.x + dx, start.y + dy);
      const s = cellStructures(seed, home)[0];
      if (!s) continue;
      const o = SHAPE.origin(home);
      return { home, structure: s, x: o[0] + s.cx / 100, y: s.groundY / 100, z: o[2] + s.cz / 100 };
    }
  }
  throw new Error(`no structure within 64 cells of the start for seed ${seed}`);
}

/** The fixed events of the demo, relative to a structure (cm from its centre and from its plinth top). */
export const DEMO_EVENTS: readonly { dx: number; dy: number; dz: number }[] = [
  // An upper corner: the outer corner of the top tier.
  { dx: -300, dy: 0, dz: -300 },
  // The base, in the middle of the +x side.
  { dx: 300, dy: 80, dz: 0 },
];
/** Radius (m) and energy of every event of the demo. */
export const EVENT_RADIUS_M = 3;
export const EVENT_ENERGY = 900;

/** The n-th event of the page at a point in the home cell's frame (cm). */
export function structureEvent(n: number, x: number, y: number, z: number): DestructionEvent {
  return { x: Math.round(x), y: Math.round(y), z: Math.round(z), radius: EVENT_RADIUS_M * 100, energy: EVENT_ENERGY, seed: hashInts(0xd357, n) >>> 0, tick: n };
}

/** The k-th of `DEMO_EVENTS` on a structure, as the n-th event of the page. An upper event is taken at the top tier. */
export function demoEvent(d: StructureDesc, k: number, n: number): DestructionEvent {
  const e = DEMO_EVENTS[k]!;
  const top = Math.max(...d.parts.map((p) => p.piece.y1));
  const y = k === 0 ? top - TIER / 2 - COVER : d.groundY + e.dy;
  return structureEvent(n, d.cx + e.dx, y, d.cz + e.dz);
}
