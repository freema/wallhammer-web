// Rubble footprints: where a gone part lies. The footprint is a pure function of the part, its damage entry (fall
// direction and variant, both chosen at the moment of the event) and the structure, so it can be rebuilt from the
// saved state alone. Integer arithmetic only.

import { DAMAGE, PART_FLAG, PART_ROLE, RUBBLE, entryDir, entryVariant } from '../../base/destructible.ts';
import type { DamageEntry, RubbleArchetype, RubbleFootprint, StructurePart, StructureState } from '../../base/destructible.ts';
import { hashInts } from '../../gen-core/hash.ts';
import { OCTANT_DIRS, idiv, isqrt, longestEdge, pieceCentre, unit1024 } from './int-geometry.ts';
import type { CompiledStructure } from './structure.ts';

/** Small turns of the footprint axis picked by the variant: cos and sin scaled by 1024 (0°, ±8°, ±16°). */
const TURNS: readonly (readonly [number, number])[] = [
  [1024, 0],
  [1014, 143],
  [1014, -143],
  [984, 282],
  [984, -282],
];

/** Footprint limits in centimetres. */
const MIN_LEN = 80;
const MAX_LEN = 700;
const MIN_HEIGHT = 12;
const MAX_HEIGHT = 160;
/** Rubble takes more room than the solid: share of voids, as a fraction 3/2. */
const BULK_NUM = 3;
const BULK_DEN = 2;

function archetypeOf(part: StructurePart): RubbleArchetype {
  if (part.role === PART_ROLE.span) return RUBBLE.slabs;
  if (part.role === PART_ROLE.attached || part.role === PART_ROLE.fixture) return RUBBLE.scatter;
  return RUBBLE.heap;
}

/** Oriented rectangle corners, counter-clockwise (x right, z down). */
function corners(cx: number, cz: number, ux: number, uz: number, halfL: number, halfW: number): Int32Array {
  const out = new Int32Array(8);
  const signs = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  signs.forEach(([su, sv], k) => {
    out[k * 2] = cx + idiv(ux * halfL * su, 1024) + idiv(-uz * halfW * sv, 1024);
    out[k * 2 + 1] = cz + idiv(uz * halfL * su, 1024) + idiv(ux * halfW * sv, 1024);
  });
  return out;
}

/** Extent of a polygon across the unit direction (bx, bz) scaled by 1024. */
function shortSide(xz: Int32Array, bx: number, bz: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < xz.length; k += 2) {
    const v = idiv(-xz[k]! * bz + xz[k + 1]! * bx, 1024);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi - lo;
}

/** Rubble of one gone part. */
export function partRubble(s: CompiledStructure, part: StructurePart, entry: DamageEntry): RubbleFootprint {
  const desc = s.desc;
  const variant = entryVariant(entry);
  const dir = entryDir(entry);
  const [pcx, , pcz] = pieceCentre(part.piece);
  // Falls away from the blast or out of the structure, further the higher it stood.
  const above = Math.max(0, part.piece.y1 - desc.groundY);
  const inner = (part.flags & PART_FLAG.inner) !== 0;
  const reach = dir < 8 && !inner ? Math.min(idiv(above * 35, 100), 300) + 40 : 0;
  const d = OCTANT_DIRS[dir < 8 ? dir : 0]!;
  const cx = pcx + idiv(d[0] * reach, 1024);
  const cz = pcz + idiv(d[1] * reach, 1024);
  const [ex, ez] = longestEdge(part.piece.xz);
  const [bx, bz] = unit1024(ex, ez);
  const turn = inner ? TURNS[0]! : TURNS[variant % TURNS.length]!;
  const ux = idiv(bx * turn[0] - bz * turn[1], 1024);
  const uz = idiv(bx * turn[1] + bz * turn[0], 1024);
  // Size from the volume of the solid: length along the part, width and height of a low mound.
  const material = desc.materials[part.material];
  const density = material && material.density > 0 ? material.density : 2000;
  const volume = idiv(idiv(part.mass * 1_000_000, density) * BULK_NUM, BULK_DEN);
  const len = Math.min(MAX_LEN, Math.max(MIN_LEN, isqrt(ex * ex + ez * ez)));
  let width = Math.min(400, Math.max(MIN_LEN, idiv(len, 2)));
  let height = idiv(2 * volume, len * width);
  if (height > MAX_HEIGHT) {
    width = Math.min(MAX_LEN, idiv(2 * volume, len * MAX_HEIGHT));
    height = MAX_HEIGHT;
  }
  height = Math.max(MIN_HEIGHT, height);
  // An inner part keeps its rubble within its own footprint (shrunk a little, so it never pokes through the shell).
  const halfL = inner ? Math.max(20, idiv(len, 2) - 30) : idiv(len, 2) + 30;
  const halfW = inner ? Math.max(20, Math.min(idiv(width, 2), idiv(shortSide(part.piece.xz, bx, bz), 2) - 30)) : idiv(width, 2) + 20;
  return {
    structure: desc.id,
    part: part.key,
    archetype: archetypeOf(part),
    material: part.material,
    cx,
    cz,
    y: desc.groundY,
    ux,
    uz,
    halfL,
    halfW,
    height,
    corners: corners(cx, cz, ux, uz, halfL, halfW),
    seed: hashInts(desc.id, part.key, entry),
  };
}

/** One mound over the whole outline: the rubble of a structure coarsened into a ruin. */
export function ruinRubble(s: CompiledStructure): RubbleFootprint {
  const desc = s.desc;
  const o = desc.outline;
  const [ex, ez] = longestEdge(o);
  const [ux, uz] = unit1024(ex, ez);
  let halfL = 0;
  let halfW = 0;
  for (let k = 0; k < o.length; k += 2) {
    const rx = o[k]! - desc.cx;
    const rz = o[k + 1]! - desc.cz;
    halfL = Math.max(halfL, Math.abs(idiv(rx * ux + rz * uz, 1024)));
    halfW = Math.max(halfW, Math.abs(idiv(-rx * uz + rz * ux, 1024)));
  }
  let volume = 0;
  for (const p of desc.parts) {
    if (p.flags & PART_FLAG.indestructible) continue;
    const m = desc.materials[p.material];
    volume += idiv(p.mass * 1_000_000, m && m.density > 0 ? m.density : 2000);
  }
  halfL += 60;
  halfW += 60;
  const area = Math.max(1, 4 * halfL * halfW);
  const height = Math.min(450, Math.max(60, idiv(2 * idiv(volume * BULK_NUM, BULK_DEN), area)));
  return {
    structure: desc.id,
    part: 0,
    archetype: RUBBLE.ruin,
    material: 0,
    cx: desc.cx,
    cz: desc.cz,
    y: desc.groundY,
    ux,
    uz,
    halfL,
    halfW,
    height,
    corners: corners(desc.cx, desc.cz, ux, uz, halfL, halfW),
    seed: hashInts(desc.id, 0x7275696e),
  };
}

/** All rubble of a structure in its state, in part key order. This is what navigation and saves may read. */
export function rubbleFootprints(s: CompiledStructure, state: StructureState): RubbleFootprint[] {
  if (state.ruin) return [ruinRubble(s)];
  const out: RubbleFootprint[] = [];
  for (const part of s.desc.parts) {
    const e = state.parts.get(part.key);
    if (e !== undefined && (e & 3) === DAMAGE.gone) out.push(partRubble(s, part, e));
  }
  return out;
}
