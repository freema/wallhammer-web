// The terrain height: one pure function of (x, z) for the whole world, built from the layout. Everything that stands
// on the ground asks it (`ctx.heightAt`), and the ground mesh (terrain/ground.ts) samples it, so they always agree.
//
// Composition, in order:
//   natural   a gentle bowl around the square that tilts up toward the north-east (where the river comes from),
//             soft undulation, the hill ring (8–14 m, B3), higher backdrop hills far out and the castle ridge
//   square    levelled at SQUARE_Y around the square
//   pads      every structure stands on a levelled pad (natural height at its centre, plus `raise` for terraces),
//             blended out over the pad's falloff
//   river     the banks are kept at least BANK above the water, and the channel is carved below the surface down to
//             the river depth (a rounded bed), with the weir step following the water surface
//   paths     a slight dip along the paved centre lines, so paving sits in the ground, not on it
//
// No randomness except value noise from the seed; the same layout and seed give the same heights everywhere.

import { streamSeed, valueNoise2 } from 'wallhammer-web/gen-core';
import { clamp, lerp, nearestOnPolyline, signedDistToRing, smoothstep } from '../kit/math.ts';
import type { RiverPoint, Structure, VillageLayout } from '../layout.ts';
import { riverAt } from '../layout.ts';

/** Height of the village square. */
export const SQUARE_Y = 2.5;
/** The banks stay at least this far above the water surface. */
const BANK = 0.55;
/** Width of the bank slope beyond the water edge, metres. */
const BANK_SLOPE = 6;

export interface HeightField {
  /** Final terrain height at a point. */
  heightAt(x: number, z: number): number;
  /** Height before levelling and carving (hills, bowl, noise). */
  natural(x: number, z: number): number;
  /** Height of a structure's levelled pad (where its floor starts). */
  padY(id: string): number;
  /**
   * The river at a point: distance from its centre line and the river point there (surface height `y`, `width`).
   * `inWater` when the point is between the water edges.
   */
  river(x: number, z: number): { dist: number; at: RiverPoint; inWater: boolean };
}

/** River segments near each cell of a coarse grid, for fast distance queries. */
class RiverIndex {
  private readonly cell = 12;
  private readonly reach = 30;
  private readonly buckets = new Map<number, number[]>();

  private readonly line: readonly (readonly number[])[];

  constructor(line: readonly (readonly number[])[]) {
    this.line = line;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!, b = line[i + 1]!;
      const x0 = Math.floor((Math.min(a[0]!, b[0]!) - this.reach) / this.cell), x1 = Math.floor((Math.max(a[0]!, b[0]!) + this.reach) / this.cell);
      const z0 = Math.floor((Math.min(a[1]!, b[1]!) - this.reach) / this.cell), z1 = Math.floor((Math.max(a[1]!, b[1]!) + this.reach) / this.cell);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const key = cx * 100003 + cz;
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push(i);
        }
      }
    }
  }

  /** Nearest point within the reach: distance and distance along, or null when the river is farther. */
  near(x: number, z: number, lengths: readonly number[]): { dist: number; along: number } | null {
    const list = this.buckets.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!list) return null;
    let best = Infinity, along = 0;
    for (const i of list) {
      const a = this.line[i]!, b = this.line[i + 1]!;
      const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = clamp(((x - a[0]!) * dx + (z - a[1]!) * dz) / l2, 0, 1);
      const d = Math.hypot(x - (a[0]! + dx * t), z - (a[1]! + dz * t));
      if (d < best) (best = d), (along = lengths[i]! + t * Math.sqrt(l2));
    }
    return best <= this.reach ? { dist: best, along } : null;
  }
}

const fields = new Map<string, HeightField>();

/** The height field of a layout and seed (cached). */
export function heightField(layout: VillageLayout, seed: number): HeightField {
  const key = `${seed}`;
  let f = fields.get(key);
  if (f && (f as HeightField & { layout?: VillageLayout }).layout === layout) return f;
  f = createField(layout, seed);
  fields.set(key, f);
  return f;
}

function createField(layout: VillageLayout, seed: number): HeightField & { layout: VillageLayout } {
  const nSeed = streamSeed(String(seed), 'terrain');
  const hills = layout.hills;
  const castle = layout.structures.find((s) => s.kind === 'castle');

  const natural = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    // Bowl: rises slowly away from the square, tilted up toward the north-east.
    let h = SQUARE_Y + 0.006 * r * r * 0.1 + clamp(0.024 * x - 0.02 * z, -1.2, 2.2);
    // Soft undulation (two octaves), weaker in the middle of the village.
    const und = (valueNoise2(x, z, 38, nSeed) - 0.5) * 2.2 + (valueNoise2(x, z, 13, nSeed + 1) - 0.5) * 0.6;
    h += und * smoothstep(8, 40, r);
    // Hill ring: 8–14 m, varying around.
    const ring = smoothstep(hills.from, hills.to, r);
    const ringVar = 0.72 + 0.55 * valueNoise2(x, z, 45, nSeed + 2);
    h += ring * hills.height * ringVar;
    // Backdrop: higher, rougher hills far out.
    const far = smoothstep(hills.to, layout.terrain.outer, r);
    h += far * (14 + 26 * valueNoise2(x, z, 90, nSeed + 3)) + (valueNoise2(x, z, 24, nSeed + 4) - 0.5) * 4 * ring;
    // Castle ridge: a long rise in the north carrying the castle.
    if (castle) {
      const dx = (x - castle.x) / 70, dz = (z - castle.z) / 38;
      h += 26 * Math.exp(-(dx * dx + dz * dz) * 1.6);
    }
    return h;
  };

  // Pad heights, from the natural height at each structure's centre.
  const pads = new Map<string, number>();
  const padList: { s: Structure; y: number }[] = [];
  for (const s of layout.structures) {
    const y = natural(s.x, s.z) + s.raise;
    pads.set(s.id, y);
    padList.push({ s, y });
  }
  const river = layout.river;
  const index = new RiverIndex(river.line);

  const riverNear = (x: number, z: number): { dist: number; at: RiverPoint } | null => {
    const hit = index.near(x, z, river.lengths);
    if (!hit) return null;
    return { dist: hit.dist, at: riverAt(river, hit.along) };
  };

  const square = layout.square;
  const cobble = layout.paths.filter((p) => p.kind === 'cobble');

  const heightAt = (x: number, z: number): number => {
    let h = natural(x, z);
    // Square.
    const ds = Math.hypot(x - square.x, z - square.z);
    h = lerp(h, SQUARE_Y, 1 - smoothstep(square.radius + 1, square.radius + 9, ds));
    // Pads.
    for (const { s, y } of padList) {
      const d = signedDistToRing(s.pad.ring, x, z);
      if (d > s.pad.falloff) continue;
      h = lerp(h, y, 1 - smoothstep(0, s.pad.falloff, d));
    }
    // Paths: a slight dip along cobbled streets (only near the village, cheap bounds check first).
    if (Math.abs(x) < 120 && Math.abs(z) < 120) {
      for (const p of cobble) {
        const hit = nearestOnPolyline(p.dense, p.lengths, x, z);
        if (hit.dist < p.width / 2 + 0.6) {
          h -= 0.05 * (1 - smoothstep(p.width / 2 - 0.4, p.width / 2 + 0.6, hit.dist));
          break;
        }
      }
    }
    // River: keep banks above the water, carve the channel.
    const rv = riverNear(x, z);
    if (rv) {
      const half = rv.at.width / 2;
      const bank = rv.at.y + BANK;
      const beyond = rv.dist - half;
      // From the water edge the ground goes from the bank height to the land over BANK_SLOPE (a levee where the
      // land is lower, a bank slope where it is higher).
      if (beyond < BANK_SLOPE) h = lerp(bank, h, smoothstep(0, BANK_SLOPE, beyond));
      if (rv.dist < half + 0.8) {
        // Bed: rounded, deepest in the middle, meeting the bank just past the water edge.
        const u = clamp(rv.dist / (half + 0.8), 0, 1);
        const bed = rv.at.y - river.depth * (1 - u * u) + 0.15 * u;
        const edge = smoothstep(half - 0.6, half + 0.8, rv.dist);
        h = lerp(bed, Math.min(h, bank), edge);
      }
    }
    return h;
  };

  return {
    layout,
    heightAt,
    natural,
    padY: (id) => {
      const y = pads.get(id);
      if (y === undefined) throw new Error(`height: no pad ${id}`);
      return y;
    },
    river: (x, z) => {
      const rv = riverNear(x, z);
      if (rv) return { ...rv, inWater: rv.dist < rv.at.width / 2 };
      const hit = nearestOnPolyline(river.line, river.lengths, x, z);
      const at = riverAt(river, hit.along);
      return { dist: hit.dist, at, inWater: false };
    },
  };
}
