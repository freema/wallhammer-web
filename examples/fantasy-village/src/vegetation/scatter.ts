// Where plants may grow: distances to everything they must stay off (streets and the square, the bridge, the water,
// building footprints, props and points of interest, garden beds, tree trunks), answered fast enough to test tens of
// thousands of candidate points. All from the layout and the height field; nothing here draws.

import { valueNoise2 } from 'wallhammer-web/gen-core';
import type { BuildContext } from '../kit/index.ts';
import { rotateY, signedDistToRing } from '../kit/index.ts';
import type { VillageLayout } from '../layout.ts';
import { TRUNK_RADIUS } from './trees.ts';

/** Segments of polylines bucketed in a coarse grid, for "distance to the nearest line minus its half width". */
class LineIndex {
  private readonly cell: number;
  private readonly reach: number;
  private readonly buckets = new Map<number, number[]>();
  /** Flat segments: ax, az, bx, bz, half width. */
  private readonly segs: number[] = [];

  constructor(cell: number, reach: number) {
    this.cell = cell;
    this.reach = reach;
  }

  add(points: readonly (readonly number[])[], half: number, closed = false): void {
    const n = closed ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      const id = this.segs.length / 5;
      this.segs.push(a[0]!, a[1]!, b[0]!, b[1]!, half);
      const g = half + this.reach;
      const x0 = Math.floor((Math.min(a[0]!, b[0]!) - g) / this.cell), x1 = Math.floor((Math.max(a[0]!, b[0]!) + g) / this.cell);
      const z0 = Math.floor((Math.min(a[1]!, b[1]!) - g) / this.cell), z1 = Math.floor((Math.max(a[1]!, b[1]!) + g) / this.cell);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const key = cx * 100003 + cz;
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push(id);
        }
      }
    }
  }

  /** Distance beyond the nearest line's half width (negative on it); `reach` when nothing is that near. */
  dist(x: number, z: number): number {
    const list = this.buckets.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!list) return this.reach;
    let best = this.reach;
    for (const id of list) {
      const o = id * 5;
      const ax = this.segs[o]!, az = this.segs[o + 1]!, bx = this.segs[o + 2]!, bz = this.segs[o + 3]!;
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t) - this.segs[o + 4]!;
      if (d < best) best = d;
    }
    return best;
  }
}

/** Point obstacles: centre and radius. */
interface Disc {
  x: number;
  z: number;
  r: number;
}

export interface Mask {
  /** Distance beyond the edge of the nearest paved surface (streets, spurs, the square, the bridge); negative on it. */
  paved(x: number, z: number): number;
  /** Distance beyond the water edge (negative in the water) and the water surface height there. */
  water(x: number, z: number): { edge: number; y: number };
  /** Signed distance to the nearest building footprint (negative inside). */
  building(x: number, z: number): number;
  /** Distance beyond the nearest prop or standing place (stalls, well, benches, lanterns, doors, the weir, the wheel, places of villagers). */
  props(x: number, z: number): number;
  /** Distance beyond the nearest fence line. */
  fence(x: number, z: number): number;
  /** Inside a garden bed (grown by `grow`). */
  garden(x: number, z: number, grow?: number): boolean;
  /** Distance beyond the nearest tree trunk of the layout. */
  trunk(x: number, z: number): number;
  /** A smooth noise field 0–1 of a given cell size and channel (patches of plants). */
  noise(x: number, z: number, cell: number, channel: number): number;
  /** The common test for a plant of radius `r` on open ground: off streets, water, buildings, props, beds and trunks. */
  open(x: number, z: number, r: number): boolean;
}

export function createMask(ctx: BuildContext): Mask {
  const L: VillageLayout = ctx.layout;
  const paths = new LineIndex(6, 4);
  for (const p of L.paths) paths.add(p.dense, p.width / 2);
  const fences = new LineIndex(6, 3);
  for (const f of L.fences) fences.add(f.points, 0.12, f.closed);
  const props: Disc[] = [];
  for (const s of L.stalls) props.push({ x: s.x, z: s.z, r: 2.4 });
  props.push({ x: L.well.x, z: L.well.z, r: 1.6 });
  for (const b of L.benches) props.push({ x: b.x, z: b.z, r: 1.3 });
  for (const l of L.lanterns) props.push({ x: l.x, z: l.z, r: 0.5 });
  for (const s of L.structures) props.push({ x: s.door.x + Math.sin(s.door.yaw) * 1.2, z: s.door.z + Math.cos(s.door.yaw) * 1.2, r: 1.8 });
  for (const p of L.pois) props.push({ x: p.x, z: p.z, r: 0.7 });
  props.push({ x: L.weir.x, z: L.weir.z, r: L.weir.width / 2 + 2.5 });
  props.push({ x: L.millWheel.x, z: L.millWheel.z, r: L.millWheel.radius + 1.5 });
  const trunks: Disc[] = L.trees.map((t) => ({ x: t.x, z: t.z, r: (t.kind === 'giant' ? 2.4 : TRUNK_RADIUS[t.kind === 'conifer' ? 'fir' : t.kind === 'bush' ? 'bush' : 'oak']) * t.scale }));
  const nSeed = ctx.seed * 7919 + 13;
  const br = L.bridge;
  const bridgeDist = (x: number, z: number): number => {
    const [lx, lz] = rotateY(x - br.x, z - br.z, -br.yaw);
    const ax = Math.abs(lx) - (br.width / 2 + 0.7), az = Math.abs(lz) - (br.length / 2 + 0.6);
    return ax > 0 && az > 0 ? Math.hypot(ax, az) : Math.max(ax, az);
  };
  const discDist = (list: readonly Disc[], x: number, z: number): number => {
    let d = 99;
    for (const q of list) {
      const e = Math.hypot(q.x - x, q.z - z) - q.r;
      if (e < d) d = e;
    }
    return d;
  };
  const gardenRects = L.gardens.map((g) => ({ g, c: Math.cos(g.yaw), s: Math.sin(g.yaw) }));
  const mask: Mask = {
    paved: (x, z) => Math.min(paths.dist(x, z), Math.hypot(x - L.square.x, z - L.square.z) - L.square.radius, bridgeDist(x, z)),
    water: (x, z) => {
      const r = ctx.field.river(x, z);
      return { edge: r.dist - r.at.width / 2, y: r.at.y };
    },
    building: (x, z) => {
      let d = 99;
      for (const s of L.structures) {
        if (Math.abs(s.x - x) > 40 || Math.abs(s.z - z) > 40) continue;
        for (const f of s.footprints) d = Math.min(d, signedDistToRing(f, x, z));
      }
      return d;
    },
    props: (x, z) => discDist(props, x, z),
    fence: (x, z) => fences.dist(x, z),
    garden: (x, z, grow = 0.3) => {
      for (const { g, c, s } of gardenRects) {
        const dx = x - g.x, dz = z - g.z;
        // Local frame of the bed (inverse of rotateY by yaw).
        const lx = c * dx - s * dz, lz = s * dx + c * dz;
        if (Math.abs(lx) < g.w / 2 + grow && Math.abs(lz) < g.d / 2 + grow) return true;
      }
      return false;
    },
    trunk: (x, z) => discDist(trunks, x, z),
    noise: (x, z, cell, channel) => valueNoise2(x + channel * 1013.7, z - channel * 517.3, cell, nSeed + channel),
    open: (x, z, r) =>
      mask.paved(x, z) > r + 0.15 &&
      mask.water(x, z).edge > r + 0.3 &&
      mask.building(x, z) > r + 0.35 &&
      mask.props(x, z) > r &&
      !mask.garden(x, z, r + 0.25) &&
      mask.trunk(x, z) > r * 0.5,
  };
  return mask;
}
