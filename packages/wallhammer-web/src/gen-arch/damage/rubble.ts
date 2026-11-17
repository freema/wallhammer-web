// Rubble of destroyed parts as structure mesh (same layout and material as the structures). A pure seeded generator:
// footprint in (archetype, oriented rectangle, height, seed, material slot), mesh out. The footprint is decided by the
// destruction model at the moment of the event; this only draws it.
//
// Archetypes: heap (a mound of broken masonry with blocks on it), slabs (tilted sections lying on a low mound),
// scatter (loose pieces, no mound), ruin (one large mound over a whole structure).

import { hashInts, unit } from '../../gen-core/index.ts';
import type { PropBox } from '../../gen-mesh/index.ts';
import { RUBBLE } from '../../base/index.ts';
import type { MeshData, RubbleFootprint } from '../../base/index.ts';
import type { BuildingSpec } from '../structure/buildings.ts';
import { STRUCTURE_MATERIAL } from './damaged.ts';
import { BUILDING_LAYOUT, DAMAGE_STEP, KIND, VertexWriter, pushBox } from '../structure/writer.ts';
import type { VertexMaterial } from '../structure/writer.ts';


/** Share of the mound height left as a flat top, and how many blocks each archetype carries. */
const TOP_INSET = 0.45;
/** Damage level of rubble in the vertex damage channel (dusty broken material). */
const RUBBLE_DAMAGE = 4;
/** The roof covering of a fallen roof section lies this far above its core. */
const COVER_LIFT_M = 0.02;
const CHUNKS: Record<number, [number, number]> = {
  [RUBBLE.heap]: [6, 11],
  [RUBBLE.slabs]: [3, 6],
  [RUBBLE.scatter]: [5, 9],
  [RUBBLE.ruin]: [18, 30],
};

/** Writes a truncated four-sided mound over the oriented rectangle. */
function mound(w: VertexWriter, fp: RubbleFootprint, base: number, height: number, mat: VertexMaterial): void {
  const cx = fp.cx / 100;
  const cz = fp.cz / 100;
  const ux = fp.ux / 1024;
  const uz = fp.uz / 1024;
  const hl = fp.halfL / 100;
  const hw = fp.halfW / 100;
  const ring = (k: number): [number, number, number][] =>
    (
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const
    ).map(([su, sv]) => [cx + ux * hl * su * k - uz * hw * sv * k, 0, cz + uz * hl * su * k + ux * hw * sv * k]);
  const lo = ring(1).map((v) => [v[0], base, v[2]] as [number, number, number]);
  const hi = ring(TOP_INSET).map((v) => [v[0], base + height, v[2]] as [number, number, number]);
  const kind = KIND.trim + DAMAGE_STEP * RUBBLE_DAMAGE;
  const put = (v: [number, number, number], n: [number, number, number]): void => w.push(v[0], v[1], v[2], n[0], n[1], n[2], kind, 0, 0, v[1] - base, 100, mat, 1, 3);
  const face = (a: [number, number, number], b: [number, number, number], c: [number, number, number]): void => {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const ez = b[2] - a[2];
    const fx = c[0] - a[0];
    const fy = c[1] - a[1];
    const fz = c[2] - a[2];
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    // Mound faces point up and out.
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      [b, c] = [c, b];
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    const n: [number, number, number] = [nx / l, ny / l, nz / l];
    put(a, n);
    put(b, n);
    put(c, n);
  };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    face(lo[i]!, lo[j]!, hi[j]!);
    face(lo[i]!, hi[j]!, hi[i]!);
  }
  face(hi[0]!, hi[1]!, hi[2]!);
  face(hi[0]!, hi[2]!, hi[3]!);
}

/**
 * A section of roof lying in the rubble: a slab of broken core (`pushBox`, damage 3) with the roof covering on top
 * (KIND.roofPitched, courses along its tilt), so fallen roof reads as roof and not as a dark lump.
 */
function roofSection(w: VertexWriter, p: PropBox): void {
  pushBox(w, p, 3);
  const mat: VertexMaterial = { seed: unit(p.hash), bayWidth: 1, wallColor: p.color, roofColor: p.color, windowStyle: 0, trimColor: p.color };
  const vx = -p.uz;
  const vz = p.ux;
  const lift = p.height + COVER_LIFT_M;
  const nl = Math.hypot(p.slope, 1);
  const nx = (-p.slope * p.ux) / nl;
  const nz = (-p.slope * p.uz) / nl;
  const ny = 1 / nl;
  // Height of the covering above its low edge, scaled so the shader's course spacing holds on a shallow tilt
  // (roofColor divides by the sine of the slope, at least 0.2).
  const sine = Math.max(Math.sqrt(Math.max(0, 1 - ny * ny)), 0.2);
  const low = p.slope >= 0 ? -1 : 1;
  const c = (su: number, sv: number): void => {
    const along = Math.abs(su - low) * p.halfL * nl;
    w.push(p.cx + p.ux * p.halfL * su + vx * p.halfW * sv, p.baseY + p.slope * p.halfL * su + lift, p.cz + p.uz * p.halfL * su + vz * p.halfW * sv, nx, ny, nz, KIND.roofPitched, 0, 0, along * sine, 0, mat, 1, 3);
  };
  c(-1, -1);
  c(-1, 1);
  c(1, -1);
  c(1, -1);
  c(-1, 1);
  c(1, 1);
}

/** Height of the mound at a point given in the footprint's own axes, normalised to −1…1. */
function moundAt(s: number, t: number, height: number): number {
  const q = Math.max(Math.abs(s), Math.abs(t));
  return q <= TOP_INSET ? height : Math.max(0, (height * (1 - q)) / (1 - TOP_INSET));
}

/**
 * Mesh of rubble footprints. `colours` gives the palette rows of each footprint's structure (wall, roof, trim);
 * `groundAt` the ground height under a point (the mound sits on it, a little sunk). `arrival` makes a footprint grow
 * in from its base over a span of clock time (rubble of parts still falling), so it takes over from the falling
 * pieces without a jump.
 */
export function buildRubbleMesh(
  footprints: readonly RubbleFootprint[],
  colours: (structure: number) => { wall: number; roof: number; trim: number } | undefined,
  groundAt: (x: number, z: number) => number,
  arrival?: (fp: RubbleFootprint) => { start: number; seconds: number } | undefined,
): MeshData {
  const w = new VertexWriter();
  for (const fp of footprints) {
    const first = w.count;
    const c = colours(fp.structure) ?? { wall: 0, roof: 0, trim: 0 };
    // A fallen roof: masonry dust under roof sections. A fallen floor: the same mound under concrete sections.
    const roofSlab = fp.archetype === RUBBLE.slabs && fp.material === STRUCTURE_MATERIAL.slab;
    const main = fp.archetype === RUBBLE.slabs ? c.wall : fp.material === STRUCTURE_MATERIAL.masonry ? c.wall : c.trim;
    const r = (k: number): number => unit(hashInts(fp.seed, k));
    const cx = fp.cx / 100;
    const cz = fp.cz / 100;
    const ux = fp.ux / 1024;
    const uz = fp.uz / 1024;
    const hl = fp.halfL / 100;
    const hw = fp.halfW / 100;
    const h = fp.height / 100;
    const base = Math.min(fp.y / 100, groundAt(cx, cz)) - 0.08;
    const mat: VertexMaterial = { seed: r(1), bayWidth: 1, wallColor: main, roofColor: main, windowStyle: 0, trimColor: main };
    const moundH = fp.archetype === RUBBLE.scatter ? 0 : fp.archetype === RUBBLE.slabs ? h * 0.45 : h * 0.8;
    if (moundH > 0.05) mound(w, fp, base, moundH, mat);
    // Slabs: tilted sections lying on the mound, roof sections (three to five) or floor sections (two to four).
    if (fp.archetype === RUBBLE.slabs || fp.archetype === RUBBLE.ruin) {
      const n = (roofSlab ? 3 : 2) + Math.floor(r(2) * 3);
      for (let k = 0; k < n; k++) {
        const s = (r(10 + k) * 2 - 1) * 0.45;
        const t = (r(20 + k) * 2 - 1) * 0.45;
        const yaw = (r(30 + k) - 0.5) * 0.9;
        const cs = 1 - (yaw * yaw) / 2;
        const sn = yaw - (yaw * yaw * yaw) / 6;
        const bx = ux * cs - uz * sn;
        const bz = uz * cs + ux * sn;
        const box: PropBox = {
          cx: cx + ux * s * hl - uz * t * hw,
          cz: cz + uz * s * hl + ux * t * hw,
          baseY: base + moundH * 0.6,
          ux: bx,
          uz: bz,
          halfL: Math.max(0.4, hl * (0.35 + 0.25 * r(40 + k))),
          halfW: Math.max(0.3, hw * (0.3 + 0.2 * r(50 + k))),
          height: 0.18,
          slope: (r(60 + k) - 0.5) * 0.7,
          color: roofSlab || fp.archetype === RUBBLE.ruin ? c.roof : c.trim,
          hash: hashInts(fp.seed, 70 + k),
        };
        if (roofSlab || fp.archetype === RUBBLE.ruin) roofSection(w, box);
        else pushBox(w, box, 1);
      }
    }
    // Blocks scattered over the mound (or the ground), some in the trim colour.
    const [lo, hi] = CHUNKS[fp.archetype] ?? [4, 8];
    const n = lo + Math.floor(r(3) * (hi - lo + 1));
    for (let k = 0; k < n; k++) {
      const s = (r(100 + k) * 2 - 1) * (fp.archetype === RUBBLE.scatter ? 1 : 0.85);
      const t = (r(200 + k) * 2 - 1) * (fp.archetype === RUBBLE.scatter ? 1 : 0.85);
      const size = (fp.archetype === RUBBLE.ruin ? 0.35 : 0.2) + r(300 + k) * (fp.archetype === RUBBLE.ruin ? 0.8 : 0.45);
      const a = r(400 + k) * 2 - 1;
      const b = Math.sqrt(Math.max(0, 1 - a * a)) * (r(500 + k) < 0.5 ? -1 : 1);
      const x = cx + ux * s * hl - uz * t * hw;
      const z = cz + uz * s * hl + ux * t * hw;
      const y = base + moundAt(s, t, moundH) - size * 0.35;
      const colour = r(600 + k) < 0.2 ? c.trim : r(600 + k) < 0.35 && fp.archetype === RUBBLE.ruin ? c.roof : main;
      pushBox(w, { cx: x, cz: z, baseY: y, ux: a, uz: b, halfL: size * (0.5 + 0.4 * r(700 + k)), halfW: size * (0.35 + 0.3 * r(800 + k)), height: size * (0.4 + 0.5 * r(900 + k)), slope: (r(1000 + k) - 0.5) * 0.8, color: colour, hash: hashInts(fp.seed, 1100 + k) }, RUBBLE_DAMAGE);
    }
    const arrive = arrival?.(fp);
    if (arrive) w.growIn(first, w.count, arrive.start, arrive.seconds, base - 0.05);
  }
  return { layout: BUILDING_LAYOUT, vertices: w.bytes(), indices: null, count: w.count };
}

/** Palette rows of structures by id, for `buildRubbleMesh`. */
export function rubbleColours(specs: readonly BuildingSpec[]): (structure: number) => { wall: number; roof: number; trim: number } | undefined {
  const m = new Map(specs.map((b) => [b.id, { wall: b.wallColor, roof: b.roofColor, trim: b.trimColor }]));
  return (id) => m.get(id);
}
