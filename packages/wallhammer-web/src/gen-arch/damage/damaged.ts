// The destructible structure model of the structure generator. The generator knows its structure, so it emits it as
// parts next to the mesh (`describeStructure`) and draws a damaged structure from the same parts (`emitDamaged`).
//
// Parts and their stable keys (rule id in the top four bits, the part's path in the recipe below; never the order in
// which geometry is written):
//   foundation              one per structure, the ground anchor, indestructible
//   wall (ring, edge, column, storey)   a bay of a footprint edge in one storey; columns are the window columns
//   roof (cell s, cell t)   a section of the roof on a grid in the structure's oriented box
//   balcony (ring, edge, column, storey), canopy (entrance), chimney (index), roof top (index of the superstructure)
//
// Damage ladder per part: intact → cracked (vertex damage channel, no geometry change) → breached (walls only: the
// opening the window rule would cut, enlarged and torn, cut as geometry with reveals) → gone (dropped; the rubble is a
// separate generator, rubble.ts). Inner faces and cut faces appear only in a damaged structure.

import { hashInts, unit } from '../../gen-core/index.ts';
import { DAMAGE, PART_FLAG, PART_ROLE, entryRung, entryVariant } from '../../base/index.ts';
import { PART_RULE, bayKey, canopyKey, chimneyKey, foundationKey, roofKey, roofTopKey } from '../structure/parts.ts';
import type { DamageEntry, DamageRung, DestructibleMaterial, PartRole, StructureBond, StructureDesc, StructurePart, StructureState } from '../../base/index.ts';
import type { BuildingSpec, Edge, StructurePlan } from '../structure/buildings.ts';
import { DOOR_KIND, FACADE_DIM } from '../structure/facade.ts';
import { DAMAGE_STEP, KIND, NO_WALL_ATTR, pushBox, wallBox } from '../structure/writer.ts';
import { FINISH, InteriorPaint, describeInterior, emitInterior, interiorExposure } from '../interior/interior.ts';
import { cellAt, clipToRect, frameS, frameT, frameX, frameZ, planInterior } from '../interior/interior-plan.ts';
import type { InteriorPlan } from '../interior/interior-plan.ts';
import type { VertexMaterial, VertexWriter, WallAttr } from '../structure/writer.ts';

export { PART_RULE, bayKey, canopyKey, chimneyKey, describeKey, foundationKey, partGone, partitionKey, roofKey, roofTopKey, slabKey, stairKey } from '../structure/parts.ts';

// --- Dimensions and materials ---------------------------------------------------------------------------------------

/** Sizes of the destructible model in metres. */
export const DESTRUCT_DIM = {
  /** Wall thickness: depth of reveals, cut faces and inner faces. */
  wall: 0.3,
  /** Target size of a roof section and the most sections along one axis. */
  roofCell: 4.5,
  roofCellsMax: 12,
  /** Thickness of a roof section (for mass and the hit test). */
  roofSlab: 0.25,
  /** Ruin: height range of the wall stubs left standing. */
  stubMin: 0.5,
  stubMax: 2.2,
} as const;

/** Material slots of the description. Energy thresholds in the units of `DestructionEvent.energy`. */
export const STRUCTURE_MATERIAL = { masonry: 0, slab: 1, attached: 2, fixture: 3, foundation: 4, floor: 5, partition: 6 } as const;
export const STRUCTURE_MATERIALS: readonly DestructibleMaterial[] = [
  { crack: 140, breach: 320, gone: 560, density: 1800 },
  { crack: 110, breach: 0, gone: 430, density: 2200 },
  { crack: 70, breach: 0, gone: 250, density: 2400 },
  { crack: 60, breach: 0, gone: 210, density: 1700 },
  { crack: 1 << 30, breach: 0, gone: 1 << 30, density: 2400 },
  // Interior: floor slabs and stairs, partition walls.
  { crack: 220, breach: 0, gone: 950, density: 2400 },
  { crack: 150, breach: 0, gone: 600, density: 1500 },
];

/**
 * Lateral hang allowed per rule (see `StructurePart.maxSpan`). A roof section rests on the walls and partitions under
 * it and hangs no further than it does when intact, so it falls with the walls that carry it.
 */
const SPAN = { wall: 1, roof: 0, attached: 1, fixture: 0 } as const;

const interiorCache = new WeakMap<BuildingSpec, { sig: string; ip: InteriorPlan }>();
/**
 * The interior plan of a structure. It is kept per spec object while the plan inputs stay the same, so repeated
 * rebuilds of one structure (every hit) plan it once.
 */
export function interiorPlan(p: StructurePlan): InteriorPlan {
  const sig = [p.flat, p.baseY, p.eaveY, p.floors, p.floorHeight, p.groundFloorH, p.floorBase, ...p.edges.flatMap((e) => [e.ring, e.i, e.ax, e.az, e.len, e.cols])].join(',');
  const hit = interiorCache.get(p.b);
  if (hit && hit.sig === sig) return hit.ip;
  const ip = planInterior(p, DESTRUCT_DIM.wall, DESTRUCT_DIM.roofSlab);
  interiorCache.set(p.b, { sig, ip });
  return ip;
}

// --- Shared geometry --------------------------------------------------------------------------------------------------

/** Bottom of storey row `f` (row 0 starts at the floor base; the top row reaches up to the roof line). */
function rowBottom(p: StructurePlan, f: number): number {
  return f === 0 ? p.floorBase : p.floorBase + p.groundFloorH + (f - 1) * p.floorHeight;
}
function rowTop(p: StructurePlan, f: number): number {
  return f < p.floors - 1 ? rowBottom(p, f + 1) : Infinity;
}

/** Wall line of one edge: piecewise linear top and ground through the split points, and the façade data per piece. */
interface WallLine {
  e: Edge;
  us: number[];
  tops: number[];
  grounds: number[];
  fas: WallAttr[];
}

function wallLine(p: StructurePlan, ei: number): WallLine {
  const e = p.edges[ei]!;
  const ts = p.splits[ei]!;
  const us: number[] = [];
  const tops: number[] = [];
  const grounds: number[] = [];
  for (const t of ts) {
    const x = e.ax + (e.bx - e.ax) * t;
    const z = e.az + (e.bz - e.az) * t;
    us.push(e.len * t);
    tops.push(p.roof.topAt(x, z) + p.wallTopExtra);
    grounds.push(p.groundAt(x, z));
  }
  const base = p.attrs[ei] ?? null;
  const fas: WallAttr[] = [];
  for (let k = 0; k + 1 < us.length; k++) {
    let fa = base ?? NO_WALL_ATTR;
    if (base) {
      const door = e.doors.find((d) => d.u >= us[k]! - 1e-4 && d.u <= us[k + 1]! + 1e-4);
      if (door) fa = { ...base, doorU: door.u, doorW: door.width, doorY: door.y, bits: [base.bits[0], base.bits[1] | (door.kind << 4), base.bits[2], base.bits[3]] };
    }
    fas.push(fa);
  }
  return { e, us, tops, grounds, fas };
}

/** Index of the piece of the line that holds u. */
function pieceAt(l: WallLine, u: number): number {
  for (let k = 0; k + 2 < l.us.length; k++) if (u < l.us[k + 1]!) return k;
  return Math.max(0, l.us.length - 2);
}
function lerpAt(l: WallLine, vals: number[], u: number): number {
  const k = pieceAt(l, u);
  const u0 = l.us[k]!;
  const u1 = l.us[k + 1]!;
  const t = u1 - u0 > 1e-9 ? (u - u0) / (u1 - u0) : 0;
  return vals[k]! + (vals[k + 1]! - vals[k]!) * t;
}
/** Lowest top of the wall between u0 and u1. */
function minTop(l: WallLine, u0: number, u1: number): number {
  let m = Math.min(lerpAt(l, l.tops, u0), lerpAt(l, l.tops, u1));
  l.us.forEach((u, k) => {
    if (u > u0 && u < u1) m = Math.min(m, l.tops[k]!);
  });
  return m;
}
function maxTop(l: WallLine, u0: number, u1: number): number {
  let m = Math.max(lerpAt(l, l.tops, u0), lerpAt(l, l.tops, u1));
  l.us.forEach((u, k) => {
    if (u > u0 && u < u1) m = Math.max(m, l.tops[k]!);
  });
  return m;
}

type P2 = [number, number];

/** Clips a convex polygon to the half plane a·u + b·y + c ≥ 0 (Sutherland–Hodgman). */
function clip2(poly: P2[], a: number, b: number, c: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const fp = a * p[0] + b * p[1] + c;
    const fq = a * q[0] + b * q[1] + c;
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Pieces of the wall region [u0, u1] × [ya, yb] under the roof line, one convex polygon per line piece (u, y). */
function wallRegion(l: WallLine, u0: number, u1: number, ya: number, yb: number): { poly: P2[]; piece: number }[] {
  const out: { poly: P2[]; piece: number }[] = [];
  for (let k = 0; k + 1 < l.us.length; k++) {
    const s0 = Math.max(u0, l.us[k]!);
    const s1 = Math.min(u1, l.us[k + 1]!);
    if (s1 - s0 < 1e-5) continue;
    const t0 = lerpAt(l, l.tops, s0);
    const t1 = lerpAt(l, l.tops, s1);
    const hi = Math.min(yb, Math.max(t0, t1) + 1);
    if (hi <= ya) continue;
    let poly: P2[] = [
      [s0, ya],
      [s1, ya],
      [s1, hi],
      [s0, hi],
    ];
    // Under the top line y ≤ t0 + (t1 − t0)(u − s0)/(s1 − s0).
    const slope = (t1 - t0) / (s1 - s0);
    poly = clip2(poly, slope, -1, t0 - slope * s0);
    if (poly.length >= 3) out.push({ poly, piece: k });
  }
  return out;
}

/** Writes one triangle, turned so its winding faces along n. */
function tri(w: VertexWriter, a: V, b: V, c: V, n: readonly [number, number, number], put: (v: V) => void): void {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const ez = b[2] - a[2];
  const fx = c[0] - a[0];
  const fy = c[1] - a[1];
  const fz = c[2] - a[2];
  const cx = ey * fz - ez * fy;
  const cy = ez * fx - ex * fz;
  const cz = ex * fy - ey * fx;
  if (cx * n[0] + cy * n[1] + cz * n[2] < 0) {
    put(a);
    put(c);
    put(b);
  } else {
    put(a);
    put(b);
    put(c);
  }
  void w;
}
type V = [number, number, number, number];

// --- Description -------------------------------------------------------------------------------------------------------

const cm = (m: number): number => Math.round(m * 100);

/** Convex prism piece from x, z corners in metres; fixes the winding to counter-clockwise (positive area). */
function piece(xz: number[], y0: number, y1: number): StructurePart['piece'] {
  let area = 0;
  const n = xz.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += xz[i * 2]! * xz[j * 2 + 1]! - xz[j * 2]! * xz[i * 2 + 1]!;
  }
  const out = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s = area >= 0 ? i : n - 1 - i;
    out[i * 2] = cm(xz[s * 2]!);
    out[i * 2 + 1] = cm(xz[s * 2 + 1]!);
  }
  return { xz: out, y0: cm(y0), y1: cm(Math.max(y1, y0 + 0.01)) };
}

function boxCorners(p: { cx: number; cz: number; ux: number; uz: number; halfL: number; halfW: number }): number[] {
  const out: number[] = [];
  for (const [su, sv] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    out.push(p.cx + p.ux * p.halfL * su - p.uz * p.halfW * sv, p.cz + p.uz * p.halfL * su + p.ux * p.halfW * sv);
  }
  return out;
}

/** Roof grid in the structure's oriented box. */
interface RoofGrid {
  nS: number;
  nT: number;
  cs: number;
  ct: number;
}
function roofGrid(b: BuildingSpec): RoofGrid {
  const nS = Math.max(1, Math.min(DESTRUCT_DIM.roofCellsMax, Math.round((2 * b.box.halfL) / DESTRUCT_DIM.roofCell)));
  const nT = Math.max(1, Math.min(DESTRUCT_DIM.roofCellsMax, Math.round((2 * b.box.halfW) / DESTRUCT_DIM.roofCell)));
  return { nS, nT, cs: (2 * b.box.halfL) / nS, ct: (2 * b.box.halfW) / nT };
}
function cellOf(b: BuildingSpec, g: RoofGrid, x: number, z: number): [number, number] {
  const { box } = b;
  const s = (x - box.cx) * box.ux + (z - box.cz) * box.uz;
  const t = -(x - box.cx) * box.uz + (z - box.cz) * box.ux;
  const is = Math.max(0, Math.min(g.nS - 1, Math.floor((s + box.halfL) / g.cs)));
  const it = Math.max(0, Math.min(g.nT - 1, Math.floor((t + box.halfW) / g.ct)));
  return [is, it];
}

/** Roof triangles cut into the cells of the grid: per cell its polygons (x, y, z) with the source triangle's normal. */
interface RoofCell {
  is: number;
  it: number;
  polys: { pts: number[]; n: [number, number, number] }[];
  area: number;
  y0: number;
  y1: number;
}
const roofCellCache = new WeakMap<BuildingSpec, { box: number[]; g: RoofGrid; tris: number[]; cells: Map<number, RoofCell> }>();
/**
 * Roof cells of a structure. Kept per spec object while its box, the grid and the roof triangles are exactly the same,
 * so describing and redrawing one structure (every hit) cut the roof once. Callers only read the result.
 */
function roofCells(p: StructurePlan, g: RoofGrid): Map<number, RoofCell> {
  const hit = roofCellCache.get(p.b);
  const tr = p.roof.tris;
  const bx = p.b.box;
  const box = [bx.cx, bx.cz, bx.ux, bx.uz, bx.halfL, bx.halfW];
  if (hit && hit.box.every((v, i) => v === box[i]) && hit.g.nS === g.nS && hit.g.nT === g.nT && hit.g.cs === g.cs && hit.g.ct === g.ct && hit.tris.length === tr.length && hit.tris.every((v, i) => v === tr[i])) return hit.cells;
  const cells = cutRoofCells(p, g);
  roofCellCache.set(p.b, { box, g: { ...g }, tris: tr.slice(), cells });
  return cells;
}
function cutRoofCells(p: StructurePlan, g: RoofGrid): Map<number, RoofCell> {
  const { box } = p.b;
  const cells = new Map<number, RoofCell>();
  const tr = p.roof.tris;
  type Q = [number, number, number, number, number];
  const clip = (poly: Q[], axis: 3 | 4, lo: number, keepAbove: boolean): Q[] => {
    const out: Q[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const fa = keepAbove ? a[axis] - lo : lo - a[axis];
      const fb = keepAbove ? b[axis] - lo : lo - b[axis];
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        out.push(a.map((v, k) => v + (b[k]! - v) * t) as Q);
      }
    }
    return out;
  };
  for (let t = 0; t < tr.length; t += 9) {
    const ex = tr[t + 3]! - tr[t]!;
    const ey = tr[t + 4]! - tr[t + 1]!;
    const ez = tr[t + 5]! - tr[t + 2]!;
    const fx = tr[t + 6]! - tr[t]!;
    const fy = tr[t + 7]! - tr[t + 1]!;
    const fz = tr[t + 8]! - tr[t + 2]!;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const q: Q[] = [];
    for (let k = 0; k < 9; k += 3) {
      const x = tr[t + k]!;
      const y = tr[t + k + 1]!;
      const z = tr[t + k + 2]!;
      q.push([x, y, z, (x - box.cx) * box.ux + (z - box.cz) * box.uz + box.halfL, -(x - box.cx) * box.uz + (z - box.cz) * box.ux + box.halfW]);
    }
    const sMin = Math.min(q[0]![3], q[1]![3], q[2]![3]);
    const sMax = Math.max(q[0]![3], q[1]![3], q[2]![3]);
    const tMin = Math.min(q[0]![4], q[1]![4], q[2]![4]);
    const tMax = Math.max(q[0]![4], q[1]![4], q[2]![4]);
    const is0 = Math.max(0, Math.min(g.nS - 1, Math.floor(sMin / g.cs)));
    const is1 = Math.max(0, Math.min(g.nS - 1, Math.floor(sMax / g.cs)));
    const it0 = Math.max(0, Math.min(g.nT - 1, Math.floor(tMin / g.ct)));
    const it1 = Math.max(0, Math.min(g.nT - 1, Math.floor(tMax / g.ct)));
    for (let is = is0; is <= is1; is++) {
      for (let it = it0; it <= it1; it++) {
        let poly = q;
        if (is > 0) poly = clip(poly, 3, is * g.cs, true);
        if (is < g.nS - 1) poly = clip(poly, 3, (is + 1) * g.cs, false);
        if (it > 0) poly = clip(poly, 4, it * g.ct, true);
        if (it < g.nT - 1) poly = clip(poly, 4, (it + 1) * g.ct, false);
        if (poly.length < 3) continue;
        // Area in the s, t plane.
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!;
          const b = poly[(i + 1) % poly.length]!;
          area += a[3] * b[4] - b[3] * a[4];
        }
        area = Math.abs(area) / 2;
        if (area < 1e-4) continue;
        const key = roofKey(is, it);
        let cell = cells.get(key);
        if (!cell) {
          cell = { is, it, polys: [], area: 0, y0: Infinity, y1: -Infinity };
          cells.set(key, cell);
        }
        cell.area += area;
        const pts: number[] = [];
        for (const v of poly) {
          pts.push(v[0], v[1], v[2]);
          cell.y0 = Math.min(cell.y0, v[1]);
          cell.y1 = Math.max(cell.y1, v[1]);
        }
        cell.polys.push({ pts, n: [nx, ny, nz] });
      }
    }
  }
  return cells;
}

/**
 * The destructible description of one structure. Deterministic for the same plan; keys from the recipe paths.
 * A structure whose paths do not fit the key layout is described as keep-out with only its foundation.
 */
export function describeStructure(p: StructurePlan, keepOut: boolean): StructureDesc {
  const { b } = p;
  const parts: StructurePart[] = [];
  const bonds = new Map<string, StructureBond>();
  const T = DESTRUCT_DIM.wall;
  const add = (key: number, role: PartRole, material: number, massKg: number, pc: StructurePart['piece'], flags: number, maxSpan: number): void => {
    parts.push({ key, role, material, mass: Math.max(1, Math.round(massKg)), piece: pc, flags, maxSpan });
  };
  const bond = (a: number, c: number, bearing: boolean, x: number, y: number, z: number, area: number): void => {
    // A tie is stored with the smaller key first; a bearing bond keeps its direction.
    const [ka, kb] = bearing || a < c ? [a, c] : [c, a];
    const id = `${ka}:${kb}`;
    if (!bonds.has(id)) bonds.set(id, { a: ka, b: kb, bearing, x: cm(x), y: cm(y), z: cm(z), area: Math.max(1, Math.round(area * 10000)) });
  };

  const box = b.box;
  const outline = piece(boxCorners(box), p.baseY, p.floorBase);
  const fKey = foundationKey();
  add(fKey, PART_ROLE.foundation, STRUCTURE_MATERIAL.foundation, (4 * box.halfL * box.halfW * Math.max(0.1, p.floorBase - p.baseY)) * 2400, outline, PART_FLAG.anchor | PART_FLAG.indestructible, 0);

  const fits = p.edges.every((e) => bayKey(PART_RULE.wall, e.ring, e.i, e.cols - 1, p.floors - 1) >= 0);
  const finish = (keep: boolean): StructureDesc => {
    parts.sort((x, y) => x.key - y.key);
    const list = [...bonds.values()].sort((x, y) => x.a - y.a || x.b - y.b);
    return { id: b.id, keepOut: keep, groundY: cm(p.floorBase), cx: cm(box.cx), cz: cm(box.cz), outline: outline.xz, materials: [...STRUCTURE_MATERIALS], parts, bonds: list };
  };
  if (!fits) return finish(true);

  // Walls: bays per edge, column and storey.
  const lines = p.edges.map((_, ei) => wallLine(p, ei));
  p.edges.forEach((e, ei) => {
    const l = lines[ei]!;
    for (let c = 0; c < e.cols; c++) {
      const u0 = c * e.colW;
      const u1 = (c + 1) * e.colW;
      for (let f = 0; f < p.floors; f++) {
        const key = bayKey(PART_RULE.wall, e.ring, e.i, c, f);
        const ya = rowBottom(p, f);
        const yb = f < p.floors - 1 ? rowTop(p, f) : maxTop(l, u0, u1);
        const xz = [e.ax + e.dx * u0, e.az + e.dz * u0, e.ax + e.dx * u1, e.az + e.dz * u1, e.ax + e.dx * u1 - e.nx * T, e.az + e.dz * u1 - e.nz * T, e.ax + e.dx * u0 - e.nx * T, e.az + e.dz * u0 - e.nz * T];
        const h = f < p.floors - 1 ? yb - ya : (minTop(l, u0, u1) + yb) / 2 - ya;
        add(key, PART_ROLE.bearing, STRUCTURE_MATERIAL.masonry, e.colW * Math.max(0.3, h) * T * STRUCTURE_MATERIALS[0]!.density, piece(xz, ya, yb), 0, SPAN.wall);
        const um = (u0 + u1) / 2;
        const mx = e.ax + e.dx * um - e.nx * T * 0.5;
        const mz = e.az + e.dz * um - e.nz * T * 0.5;
        if (f === 0) bond(fKey, key, true, mx, ya, mz, e.colW * T);
        else bond(bayKey(PART_RULE.wall, e.ring, e.i, c, f - 1), key, true, mx, ya, mz, e.colW * T);
        if (c + 1 < e.cols) {
          const yc = (ya + Math.min(yb, ya + 3)) / 2;
          bond(key, bayKey(PART_RULE.wall, e.ring, e.i, c + 1, f), false, e.ax + e.dx * u1, yc, e.az + e.dz * u1, Math.max(0.3, Math.min(yb, ya + 3) - ya) * T);
        }
      }
    }
  });
  // Corners: the last bay of an edge ties to the first bay of the next edge of the same ring.
  const byRing = new Map<number, Edge[]>();
  for (const e of p.edges) byRing.set(e.ring, [...(byRing.get(e.ring) ?? []), e]);
  for (const ring of byRing.values()) {
    if (ring.length < 2) continue;
    ring.forEach((e, k) => {
      const next = ring[(k + 1) % ring.length]!;
      for (let f = 0; f < p.floors; f++) {
        const ya = rowBottom(p, f);
        bond(bayKey(PART_RULE.wall, e.ring, e.i, e.cols - 1, f), bayKey(PART_RULE.wall, next.ring, next.i, 0, f), false, e.bx, ya + 1, e.bz, 3 * T);
      }
    });
  }

  // Roof sections, resting on the top bays under their edges, tied to each other.
  const grid = roofGrid(b);
  const cells = roofCells(p, grid);
  for (const [key, cell] of cells) {
    const s0 = -box.halfL + cell.is * grid.cs;
    const t0 = -box.halfW + cell.it * grid.ct;
    const sc = { cx: box.cx + box.ux * (s0 + grid.cs / 2) - box.uz * (t0 + grid.ct / 2), cz: box.cz + box.uz * (s0 + grid.cs / 2) + box.ux * (t0 + grid.ct / 2), ux: box.ux, uz: box.uz, halfL: grid.cs / 2, halfW: grid.ct / 2 };
    add(key, PART_ROLE.span, STRUCTURE_MATERIAL.slab, cell.area * DESTRUCT_DIM.roofSlab * STRUCTURE_MATERIALS[1]!.density, piece(boxCorners(sc), cell.y0 - DESTRUCT_DIM.roofSlab, cell.y1), 0, SPAN.roof);
    for (const [ds, dt] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const nKey = roofKey(cell.is + ds, cell.it + dt);
      if (!cells.has(nKey)) continue;
      const x = sc.cx + box.ux * (ds * grid.cs / 2) - box.uz * (dt * grid.ct / 2);
      const z = sc.cz + box.uz * (ds * grid.cs / 2) + box.ux * (dt * grid.ct / 2);
      bond(key, nKey, false, x, (cell.y0 + cell.y1) / 2, z, (ds ? grid.ct : grid.cs) * DESTRUCT_DIM.roofSlab);
    }
  }
  const restOnRoof = (key: number, x: number, z: number, y: number, area: number): void => {
    let [is, it] = cellOf(b, grid, x, z);
    if (!cells.has(roofKey(is, it))) {
      // Nearest section that exists (by grid distance, then key order).
      let best = Infinity;
      for (const c of cells.values()) {
        const d = Math.abs(c.is - is) + Math.abs(c.it - it);
        if (d < best) {
          best = d;
          [is, it] = [c.is, c.it];
        }
      }
    }
    if (cells.has(roofKey(is, it))) bond(roofKey(is, it), key, true, x, y, z, area);
  };
  p.edges.forEach((e) => {
    const f = p.floors - 1;
    for (let c = 0; c < e.cols; c++) {
      const key = bayKey(PART_RULE.wall, e.ring, e.i, c, f);
      for (const s of [0.2, 0.5, 0.8]) {
        const u = (c + s) * e.colW;
        const x = e.ax + e.dx * u - e.nx * 0.8;
        const z = e.az + e.dz * u - e.nz * 0.8;
        const [is, it] = cellOf(b, grid, x, z);
        const rk = roofKey(is, it);
        if (cells.has(rk)) bond(key, rk, true, x, p.eaveY, z, e.colW * T);
      }
    }
  });

  // Interior: slabs on the outer walls, partitions and stairs on the slabs.
  describeInterior(p, interiorPlan(p), {
    add,
    bond,
    piece,
    foundation: fKey,
    wallT: T,
  });

  // Attached parts and fixtures.
  for (const pb of p.balconies) {
    const e = p.edges[pb.edge]!;
    const key = bayKey(PART_RULE.balcony, e.ring, e.i, pb.c, pb.f);
    const bx = pb.box;
    add(key, PART_ROLE.attached, STRUCTURE_MATERIAL.attached, 4 * bx.halfL * bx.halfW * bx.height * 0.5 * 2400, piece(boxCorners(bx), bx.baseY, bx.baseY + bx.height), 0, SPAN.attached);
    for (const f of [pb.f, pb.f - 1]) bond(key, bayKey(PART_RULE.wall, e.ring, e.i, pb.c, f), false, bx.cx, bx.baseY, bx.cz, bx.halfL * 2 * 0.3);
  }
  for (const cp of p.canopies) {
    const e = p.edges[cp.edge]!;
    const key = canopyKey(cp.k);
    const bx = cp.box;
    add(key, PART_ROLE.attached, STRUCTURE_MATERIAL.attached, 4 * bx.halfL * bx.halfW * bx.height * 0.8 * 2400, piece(boxCorners(bx), bx.baseY, bx.baseY + bx.height), 0, SPAN.attached);
    const c = Math.max(0, Math.min(e.cols - 1, Math.floor(cp.u / e.colW)));
    bond(key, bayKey(PART_RULE.wall, e.ring, e.i, c, 0), false, bx.cx, bx.baseY, bx.cz, bx.halfL * 2 * bx.height);
  }
  for (const [list, keyOf, fill] of [
    [p.chimneys, chimneyKey, 0.6],
    [p.tops, roofTopKey, 0.12],
  ] as const) {
    for (const pb of list) {
      const key = keyOf(pb.k);
      const bx = pb.box;
      add(key, PART_ROLE.fixture, STRUCTURE_MATERIAL.fixture, 4 * bx.halfL * bx.halfW * bx.height * fill * 1700, piece(boxCorners(bx), bx.baseY, bx.baseY + bx.height), 0, SPAN.fixture);
      restOnRoof(key, bx.cx, bx.cz, bx.baseY, 4 * bx.halfL * bx.halfW);
    }
  }
  return finish(keepOut);
}

// --- Damaged emission ------------------------------------------------------------------------------------------------

/** Directions of the outline of a breach: cos and sin of 0°, 30°, …, 330° (constants, no trigonometry at run time). */
const DIRS12: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.8660254037844387, 0.5],
  [0.5, 0.8660254037844387],
  [0, 1],
  [-0.5, 0.8660254037844387],
  [-0.8660254037844387, 0.5],
  [-1, 0],
  [-0.8660254037844387, -0.5],
  [-0.5, -0.8660254037844387],
  [0, -1],
  [0.5, -0.8660254037844387],
  [0.8660254037844387, -0.5],
];

/** Damage level written into the vertices for a rung. */
const levelOf = (r: DamageRung): number => (r === DAMAGE.cracked ? 1 : r === DAMAGE.breached ? 2 : 0);

/**
 * Writes a damaged structure: the same plan as the intact path, drawn part by part. Gone parts are left out, cracked
 * ones carry the damage channel, breached bays get a torn opening with reveals, and the inside shows inner faces.
 */
export function emitDamaged(w: VertexWriter, p: StructurePlan, state: StructureState): void {
  const T = DESTRUCT_DIM.wall;
  const { b, mat, floors, floorHeight, floorBase, eaveY } = p;
  const entry = (key: number): DamageEntry => state.parts.get(key) ?? 0;
  const rungOf = (key: number): DamageRung => (state.ruin ? DAMAGE.gone : entryRung(entry(key)));
  const inner: VertexMaterial = { ...mat, trimColor: mat.wallColor };
  const lines = p.edges.map((_, ei) => wallLine(p, ei));
  const ip = state.ruin ? null : interiorPlan(p);
  const paint = ip && ip.ok ? new InteriorPaint(p, ip, T) : null;
  const grid = roofGrid(b);
  const cells = roofCells(p, grid);
  // Rooms that can be seen into; closed rooms draw nothing.
  const open = ip && paint
    ? interiorExposure(p, ip, {
        level: (key) => {
          const r = rungOf(key);
          return r === DAMAGE.gone ? -1 : levelOf(r);
        },
        bayOpen: (e, c, f) => rungOf(bayKey(PART_RULE.wall, e.ring, e.i, c, f)) >= DAMAGE.breached,
        roofGone: [...cells.entries()]
          .filter(([key]) => rungOf(key) === DAMAGE.gone)
          .map(([, c]) => ({ s0: c.is * grid.cs - b.box.halfL, s1: (c.is + 1) * grid.cs - b.box.halfL, t0: c.it * grid.ct - b.box.halfW, t1: (c.it + 1) * grid.ct - b.box.halfW })),
      })
    : null;
  // Torn and missing bays let daylight in like large windows.
  if (paint) {
    for (const e of p.edges) {
      for (let c = 0; c < e.cols; c++) {
        for (let f = 0; f < floors; f++) {
          const r = rungOf(bayKey(PART_RULE.wall, e.ring, e.i, c, f));
          if (r < DAMAGE.breached) continue;
          const flH = f === 0 ? p.groundFloorH : floorHeight;
          paint.addOpening(e, (c + 0.5) * e.colW, f, e.colW * flH * (r === DAMAGE.gone ? 0.9 : 0.45));
        }
      }
    }
  }
  const nRooms = ip ? ip.rooms.length : 0;
  const roomOpen = (f: number, r: number): boolean => open !== null && open[f * nRooms + r] === 1;
  let atticOpen = false;
  for (let r = 0; r < nRooms; r++) atticOpen ||= roomOpen(floors, r);
  const edgeIndex = new Map(p.edges.map((e, k) => [e, k] as const));

  // Writers for a wall line: the outer face (façade data) and the inner face (damage level 3) at depth T.
  const outer = (l: WallLine, piece: number, damage: number) => (v: V): void => {
    const e = l.e;
    const u = v[0];
    const y = v[1];
    w.push(e.ax + e.dx * u, y, e.az + e.dz * u, e.nx, 0, e.nz, KIND.wall + DAMAGE_STEP * damage, u, e.len, y - floorBase, y - lerpAt(l, l.grounds, u), mat, floors, floorHeight, l.fas[piece] ?? NO_WALL_ATTR);
  };
  const innerPut = (l: WallLine, nx: number, ny: number, nz: number) => (v: V): void => {
    const e = l.e;
    const u = v[0];
    const y = v[1];
    const d = v[3];
    w.push(e.ax + e.dx * u - e.nx * d, y, e.az + e.dz * u - e.nz * d, nx, ny, nz, KIND.trim + DAMAGE_STEP * 3, 0, 0, y - floorBase, 100, inner, floors, floorHeight);
  };
  // In wall coordinates (u, y, ·, depth) a face along +n in 3D is a triangle that is clockwise in (u, y).
  const wallTri = (l: WallLine, a: V, bb: V, c: V, front: boolean, put: (v: V) => void): void => {
    const e = l.e;
    const to3 = (v: V): V => [e.ax + e.dx * v[0], v[1], e.az + e.dz * v[0], 0];
    const n: [number, number, number] = front ? [e.nx, 0, e.nz] : [-e.nx, 0, -e.nz];
    const A = to3(a);
    const B = to3(bb);
    const C = to3(c);
    // Orient in 3D, then write the original (u, y) vertices in that order.
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const ez = B[2] - A[2];
    const fx = C[0] - A[0];
    const fy = C[1] - A[1];
    const fz = C[2] - A[2];
    const cx = ey * fz - ez * fy;
    const cy = ez * fx - ex * fz;
    const cz = ex * fy - ey * fx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) {
      put(a);
      put(c);
      put(bb);
    } else {
      put(a);
      put(bb);
      put(c);
    }
  };
  const fan = (l: WallLine, poly: P2[], depth: number, front: boolean, put: (v: V) => void): void => {
    for (let k = 1; k + 1 < poly.length; k++) {
      const a = poly[0]!;
      const q = poly[k]!;
      const r = poly[k + 1]!;
      wallTri(l, [a[0], a[1], 0, depth], [q[0], q[1], 0, depth], [r[0], r[1], 0, depth], front, put);
    }
  };
  /** A quad across the wall thickness along the segment p0–p1 (u, y), facing along nIn (3D). */
  const cut = (l: WallLine, p0: P2, p1: P2, n3: [number, number, number]): void => {
    const e = l.e;
    const put = (v: V): void => {
      w.push(e.ax + e.dx * v[0] - e.nx * v[3], v[1], e.az + e.dz * v[0] - e.nz * v[3], n3[0], n3[1], n3[2], KIND.trim + DAMAGE_STEP * 3, 0, 0, v[1] - floorBase, 100, inner, floors, floorHeight);
    };
    const pos = (v: V): V => [e.ax + e.dx * v[0] - e.nx * v[3], v[1], e.az + e.dz * v[0] - e.nz * v[3], 0];
    const a: V = [p0[0], p0[1], 0, 0];
    const bq: V = [p1[0], p1[1], 0, 0];
    const c: V = [p1[0], p1[1], 0, T];
    const d: V = [p0[0], p0[1], 0, T];
    for (const [x, y, z] of [
      [a, bq, c],
      [a, c, d],
    ] as const) {
      const A = pos(x);
      const B = pos(y);
      const C = pos(z);
      tri(w, A, B, C, n3, () => undefined);
      const ex = B[0] - A[0];
      const ey = B[1] - A[1];
      const ez = B[2] - A[2];
      const fx = C[0] - A[0];
      const fy = C[1] - A[1];
      const fz = C[2] - A[2];
      const flip = (ey * fz - ez * fy) * n3[0] + (ez * fx - ex * fz) * n3[1] + (ex * fy - ey * fx) * n3[2] < 0;
      put(x);
      if (flip) {
        put(z);
        put(y);
      } else {
        put(y);
        put(z);
      }
    }
  };
  /**
   * Inner face of storey `f` of a wall: painted per room between partitions, the slab edge in concrete, the roof space
   * above the eave; without an interior (or for f < 0) the bare core as before.
   */
  const innerFan = (l: WallLine, poly: P2[], f: number, damage: number, outerPiece: number): void => {
    if (!paint || !ip || f < 0) {
      fan(l, poly, T, false, innerPut(l, -l.e.nx, 0, -l.e.nz));
      return;
    }
    const e = l.e;
    const ei = edgeIndex.get(e)!;
    const top = f === floors - 1;
    const cy = ip.ceilY[f]!;
    const bands: [number, number, number][] = [
      [-Infinity, cy, FINISH.paint],
      [cy, top ? eaveY : ip.floorY[f + 1]!, FINISH.concrete],
    ];
    if (top) bands.push([eaveY, Infinity, p.flat ? -1 : FINISH.atticWall]);
    const cuts = [-Infinity, ...ip.wallSplits[ei]!.filter((u) => u > 1e-3 && u < e.len - 1e-3), Infinity];
    let us = Infinity;
    let ue = -Infinity;
    for (const v of poly) {
      us = Math.min(us, v[0]);
      ue = Math.max(ue, v[0]);
    }
    for (const [ya, yb, finish] of bands) {
      let band = clip2(poly, 0, 1, -ya);
      band = clip2(band, 0, -1, yb);
      if (band.length < 3) continue;
      if (finish < 0) {
        fan(l, band, T, false, innerPut(l, -e.nx, 0, -e.nz));
        continue;
      }
      for (let k = 0; k + 1 < cuts.length; k++) {
        const ua = cuts[k]!;
        const ub = cuts[k + 1]!;
        if (ub <= us || ua >= ue) continue;
        let piece = clip2(band, 1, 0, -ua);
        piece = clip2(piece, -1, 0, ub);
        if (piece.length < 3) continue;
        const um = (Math.max(ua, us) + Math.min(ub, ue)) / 2;
        const c = cellAt(ip, e.ax + e.dx * um - e.nx * (T + 0.2), e.az + e.dz * um - e.nz * (T + 0.2));
        const room = finish === FINISH.atticWall ? -1 : c >= 0 ? ip.cells[c]!.room : -1;
        // Closed rooms draw no inner face (a face whose room is unknown is kept).
        if (finish === FINISH.atticWall ? !atticOpen : room >= 0 && !roomOpen(f, room)) continue;
        if (finish === FINISH.atticWall) {
          const fa = paint.attr(room, floors, finish);
          const s3 = paint.hash(room);
          fan(l, piece, T, false, (v: V): void => {
            w.push(e.ax + e.dx * v[0] - e.nx * T, v[1], e.az + e.dz * v[0] - e.nz * T, -e.nx, 0, -e.nz, KIND.interior + DAMAGE_STEP * damage, v[0], v[1] - eaveY, 3, s3, mat, floors, floorHeight, fa);
          });
          continue;
        }
        // Storey walls keep the façade data of the outside piece, so the shader draws the same openings from inside.
        const inside = paint.wallInside(room, f, finish, l.fas[outerPiece] ?? NO_WALL_ATTR);
        fan(l, piece, T, false, (v: V): void => {
          w.push(e.ax + e.dx * v[0] - e.nx * T, v[1], e.az + e.dz * v[0] - e.nz * T, -e.nx, 0, -e.nz, KIND.wallInside + DAMAGE_STEP * damage, v[0], e.len, v[1] - floorBase, inside.s3, inside.mat, floors, floorHeight, inside.fa);
        });
      }
    }
  };
  /** Region [u0, u1] × [ya, yb] of a wall line: outer face with the damage level and the inner face of storey f. */
  const panel = (l: WallLine, u0: number, u1: number, ya: number, yb: number, damage: number, withInner: boolean, f = -1): void => {
    for (const { poly, piece } of wallRegion(l, u0, u1, ya, yb)) {
      fan(l, poly, 0, true, outer(l, piece, damage));
      if (withInner) innerFan(l, poly, f, damage, piece);
    }
  };

  // Foundation band: always there.
  for (const l of lines) panel(l, -1, l.e.len + 1, p.baseY, floorBase, 0, false);

  if (state.ruin) {
    emitRuinStubs(p, lines, panel, cut);
    return;
  }

  p.edges.forEach((e, ei) => {
    const l = lines[ei]!;
    const rungAt = (c: number, f: number): DamageRung => (c < 0 || c >= e.cols || f < 0 || f >= floors ? DAMAGE.intact : rungOf(bayKey(2, e.ring, e.i, c, f)));
    for (let c = 0; c < e.cols; c++) {
      const u0 = c * e.colW;
      const u1 = (c + 1) * e.colW;
      for (let f = 0; f < floors; f++) {
        const key = bayKey(2, e.ring, e.i, c, f);
        const r = rungOf(key);
        const ya = rowBottom(p, f);
        const yb = rowTop(p, f);
        const top = f === floors - 1;
        if (r === DAMAGE.gone) {
          // Cut faces where a standing neighbour borders the gap.
          const hiL = Math.min(yb, lerpAt(l, l.tops, u0));
          const hiR = Math.min(yb, lerpAt(l, l.tops, u1));
          if (c > 0 && rungAt(c - 1, f) !== DAMAGE.gone) cut(l, [u0, ya], [u0, hiL], [e.dx, 0, e.dz]);
          if (c + 1 < e.cols && rungAt(c + 1, f) !== DAMAGE.gone) cut(l, [u1, ya], [u1, hiR], [-e.dx, 0, -e.dz]);
          if (f > 0 && rungAt(c, f - 1) !== DAMAGE.gone) cut(l, [u0, ya], [u1, ya], [0, 1, 0]);
          if (!top && rungAt(c, f + 1) !== DAMAGE.gone) cut(l, [u0, yb], [u1, yb], [0, -1, 0]);
          continue;
        }
        const level = levelOf(r);
        if (r === DAMAGE.breached) {
          const yr = Math.min(top ? Infinity : yb, minTop(l, u0, u1));
          breach(l, u0, u1, ya, yr, f, c, entry(key));
          if (yr < yb) panel(l, u0, u1, yr, yb, level, true, f);
        } else {
          panel(l, u0, u1, ya, yb, level, true, f);
        }
        if (top) topRow(l, ei, c, u0, u1, level);
      }
    }
  });

  /** Breach: the window opening of the bay (or its door), enlarged and torn, cut out of the band [ya, yr]. */
  function breach(l: WallLine, u0: number, u1: number, ya: number, yr: number, f: number, c: number, en: DamageEntry): void {
    const e = l.e;
    const v = entryVariant(en);
    const r = (k: number): number => unit(hashInts(b.hash, 0x6272, e.ring, e.i, c, f, v, k));
    const rec = p.rec;
    const flH = f === 0 ? p.groundFloorH : floorHeight;
    const win = p.attrs[p.edges.indexOf(e)]?.win;
    const winW = win && win[0] > 0 ? win[0] : 1.4;
    const winH = win && win[1] > 0 ? win[1] : Math.min(1.6, flH - 0.8);
    const sill = win && win[2] > 0 ? win[2] : 0.9;
    const door = f === 0 ? e.doors.find((d) => d.u >= u0 && d.u < u1) : undefined;
    let uc = (u0 + u1) / 2;
    let yc = ya + sill + winH / 2;
    let hw = winW / 2 + 0.3 + 0.35 * r(1);
    let hh = winH / 2 + 0.25 + 0.35 * r(2);
    if (door) {
      const dh =
        door.kind === DOOR_KIND.arch
          ? door.width * FACADE_DIM.archHeightPerWidth
          : door.kind === DOOR_KIND.garage
            ? FACADE_DIM.garageDoorHeight
            : door.kind === DOOR_KIND.portal
              ? FACADE_DIM.portalHeight
              : FACADE_DIM.doorHeight;
      uc = door.u;
      yc = door.y + dh / 2 + 0.2;
      hw = door.width / 2 + 0.3 + 0.3 * r(1);
      hh = dh / 2 + 0.2 + 0.3 * r(2);
    }
    void rec;
    const margin = 0.18;
    hw = Math.min(hw, (u1 - u0) / 2 - margin);
    hh = Math.min(hh, (yr - ya) / 2 - margin);
    if (hw < 0.3 || hh < 0.3) {
      panel(l, u0, u1, ya, yr, 2, true, f);
      return;
    }
    uc = Math.max(u0 + margin + hw, Math.min(u1 - margin - hw, uc));
    yc = Math.max(ya + margin + hh, Math.min(yr - margin - hh, yc));
    // Torn outline: a ray every 30°, cut short by a seeded amount; the outer ring is the band rectangle.
    const holeP: P2[] = [];
    const ringP: P2[] = [];
    DIRS12.forEach(([dx, dy], k) => {
      const th = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
      const s = 0.72 + 0.28 * r(10 + k);
      holeP.push([uc + dx * th * s, yc + dy * th * s]);
      const tb = Math.min(dx > 0 ? (u1 - uc) / dx : dx < 0 ? (u0 - uc) / dx : Infinity, dy > 0 ? (yr - yc) / dy : dy < 0 ? (ya - yc) / dy : Infinity);
      ringP.push([uc + dx * tb, yc + dy * tb]);
    });
    const corners: P2[] = [
      [u1, yr],
      [u0, yr],
      [u0, ya],
      [u1, ya],
    ];
    const cross = (a: P2, q: P2): number => a[0] * q[1] - a[1] * q[0];
    const piece = pieceAt(l, uc);
    for (let k = 0; k < 12; k++) {
      const k1 = (k + 1) % 12;
      const d0: P2 = [DIRS12[k]![0], DIRS12[k]![1]];
      const d1: P2 = [DIRS12[k1]![0], DIRS12[k1]![1]];
      const poly: P2[] = [holeP[k]!, ringP[k]!];
      for (const q of corners) {
        const rel: P2 = [q[0] - uc, q[1] - yc];
        if (cross(d0, rel) > 1e-9 && cross(rel, d1) > 1e-9) poly.push(q);
      }
      poly.push(ringP[k1]!, holeP[k1]!);
      // Sector polygon: fan from the hole point.
      fan(l, poly, 0, true, outer(l, piece, 2));
      innerFan(l, poly, f, 2, piece);
      // Reveal along the torn edge, facing into the opening.
      const a = holeP[k]!;
      const q = holeP[k1]!;
      const mu = (a[0] + q[0]) / 2 - uc;
      const my = (a[1] + q[1]) / 2 - yc;
      const len = Math.hypot(mu, my) || 1;
      cut(l, a, q, [(-e.dx * mu) / len, -my / len, (-e.dz * mu) / len]);
    }
  }

  /** Parapet and cornice on top of a standing top-row bay. */
  function topRow(l: WallLine, ei: number, c: number, u0: number, u1: number, level: number): void {
    const e = l.e;
    const innerRing = p.parapet > 0 ? p.insets[e.ring] : null;
    if (innerRing) {
      const ringLen = innerRing.length / 2;
      const j = (e.i + 1) % ringLen;
      const top = eaveY + p.parapet;
      const t0 = u0 / e.len;
      const t1 = u1 / e.len;
      const ix = (t: number): number => innerRing[e.i * 2]! + (innerRing[j * 2]! - innerRing[e.i * 2]!) * t;
      const iz = (t: number): number => innerRing[e.i * 2 + 1]! + (innerRing[j * 2 + 1]! - innerRing[e.i * 2 + 1]!) * t;
      const kind = KIND.trim + DAMAGE_STEP * level;
      const t = (x: number, y: number, z: number, px: number, py: number, pz: number): void => w.push(x, y, z, px, py, pz, kind, 0, 0, y - eaveY, 100, mat, floors, floorHeight);
      const ax = e.ax + e.dx * u0;
      const az = e.az + e.dz * u0;
      const bx = e.ax + e.dx * u1;
      const bz = e.az + e.dz * u1;
      t(ax, top, az, 0, 1, 0);
      t(ix(t0), top, iz(t0), 0, 1, 0);
      t(bx, top, bz, 0, 1, 0);
      t(bx, top, bz, 0, 1, 0);
      t(ix(t0), top, iz(t0), 0, 1, 0);
      t(ix(t1), top, iz(t1), 0, 1, 0);
      t(ix(t0), top, iz(t0), -e.nx, 0, -e.nz);
      t(ix(t0), eaveY, iz(t0), -e.nx, 0, -e.nz);
      t(ix(t1), top, iz(t1), -e.nx, 0, -e.nz);
      t(ix(t1), top, iz(t1), -e.nx, 0, -e.nz);
      t(ix(t0), eaveY, iz(t0), -e.nx, 0, -e.nz);
      t(ix(t1), eaveY, iz(t1), -e.nx, 0, -e.nz);
    }
    const cor = p.cornice;
    if (cor && !e.party && e.levelTop && e.len >= 1.5) {
      const proj = cor.projection + 0.004 * (ei % 3);
      const topY = eaveY + p.wallTopExtra - FACADE_DIM.corniceTopGap - 0.003 * (ei % 2);
      const a0 = c === 0 && e.convexA ? -proj : u0;
      const a1 = c === e.cols - 1 && e.convexB ? e.len + proj : u1;
      pushBox(w, wallBox(e.ax, e.az, e.dx, e.dz, a0, a1, -0.05, proj, topY - cor.height, cor.height, b.trimColor, hashInts(b.hash, 950, ei, c)), level, cor.underside === true);
    }
  }

  // Attachments that still stand.
  for (const pb of p.balconies) {
    const e = p.edges[pb.edge]!;
    const r = rungOf(bayKey(PART_RULE.balcony, e.ring, e.i, pb.c, pb.f));
    if (r !== DAMAGE.gone) pushBox(w, pb.box, levelOf(r));
  }
  for (const pb of p.tops) {
    const r = rungOf(roofTopKey(pb.k));
    if (r !== DAMAGE.gone) pushBox(w, pb.box, levelOf(r));
  }
  for (const pb of p.chimneys) {
    const r = rungOf(chimneyKey(pb.k));
    if (r !== DAMAGE.gone) pushBox(w, pb.box, levelOf(r));
  }

  // Interior: slabs, partitions and stairs.
  if (ip && paint) {
    emitInterior(w, p, ip, paint, {
      level: (key) => {
        const r = rungOf(key);
        return r === DAMAGE.gone ? -1 : levelOf(r);
      },
      bayGone: (e, c, f) => f >= 0 && f < floors && rungOf(bayKey(PART_RULE.wall, e.ring, e.i, c, f)) === DAMAGE.gone,
      open: open!,
      wallT: T,
    });
  }

  // Roof sections.
  const kind = p.flat ? KIND.roofFlat : KIND.roofPitched;
  for (const [key, cell] of cells) {
    const r = rungOf(key);
    if (r === DAMAGE.gone) continue;
    const k2 = kind + DAMAGE_STEP * levelOf(r);
    for (const { pts, n } of cell.polys) {
      const m = pts.length / 3;
      for (let i = 1; i + 1 < m; i++) {
        for (const v of [0, i, i + 1]) {
          const y = pts[v * 3 + 1]!;
          w.push(pts[v * 3]!, y, pts[v * 3 + 2]!, n[0], n[1], n[2], k2, 0, 0, y - eaveY, 100, mat, floors, floorHeight);
        }
      }
    }
    if (ip && paint) roofUnderside(cell, levelOf(r), (s0, t0) => {
      const nk = roofKey(s0, t0);
      return cells.has(nk) && rungOf(nk) === DAMAGE.gone;
    });
  }

  /**
   * Underside of a roof section inside the footprint: the ceiling of the rooms of the top storey under a flat roof
   * (split by room), the roof space under a pitched one. Cut edges where a neighbouring section is gone.
   */
  function roofUnderside(cell: RoofCell, level: number, goneAt: (is: number, it: number) => boolean): void {
    const plan = ip!;
    const fr = plan.frame;
    const slab = DESTRUCT_DIM.roofSlab;
    const topF = floors - 1;
    const yMin = p.flat ? -Infinity : eaveY + 0.02;
    const kindI = KIND.interior + DAMAGE_STEP * level;
    const nTc = plan.tCuts.length - 1;
    const attic = !p.flat && atticOpen;
    if (p.flat) {
      // Flat roof: the ceilings of the open rooms under this section, straight from the plan cells (the section
      // covers the whole footprint inside its rectangle).
      const flatY = cell.polys.find((q) => q.n[1] > 0.05)?.pts[1];
      if (flatY !== undefined) {
        const rect = { s0: cell.is * grid.cs - b.box.halfL, s1: (cell.is + 1) * grid.cs - b.box.halfL, t0: cell.it * grid.ct - b.box.halfW, t1: (cell.it + 1) * grid.ct - b.box.halfW };
        const y = flatY - slab;
        const h = plan.ceilY[topF]! - plan.floorY[topF]!;
        plan.cells.forEach((pc, ci) => {
          if (pc.area <= 0 || !roomOpen(topF, pc.room)) return;
          const i = Math.floor(ci / nTc);
          const j = ci % nTc;
          if (plan.sCuts[i + 1]! <= rect.s0 || plan.sCuts[i]! >= rect.s1 || plan.tCuts[j + 1]! <= rect.t0 || plan.tCuts[j]! >= rect.t1) return;
          const fa = paint!.attr(pc.room, topF, FINISH.ceiling);
          const hash = paint!.hash(pc.room);
          for (const cp of pc.polys) {
            const st: number[][] = [];
            for (let k = 0; k < cp.length; k += 2) st.push([frameS(fr, cp[k]!, cp[k + 1]!), frameT(fr, cp[k]!, cp[k + 1]!), cp[k]!, cp[k + 1]!]);
            const piece = clipToRect(st, rect);
            if (piece.length < 3) continue;
            const put = (v: number[]): void => {
              w.push(frameX(fr, v[0]!, v[1]!), y, frameZ(fr, v[0]!, v[1]!), 0, -1, 0, kindI, v[0]!, v[1]!, h, hash, mat, floors, floorHeight, fa);
            };
            // Written so that every triangle faces down.
            const A = piece[0]!;
            for (let k = 1; k + 1 < piece.length; k++) {
              const B = piece[k]!;
              const C = piece[k + 1]!;
              const ny = (frameZ(fr, B[0]!, B[1]!) - frameZ(fr, A[0]!, A[1]!)) * (frameX(fr, C[0]!, C[1]!) - frameX(fr, A[0]!, A[1]!)) - (frameX(fr, B[0]!, B[1]!) - frameX(fr, A[0]!, A[1]!)) * (frameZ(fr, C[0]!, C[1]!) - frameZ(fr, A[0]!, A[1]!));
              put(A);
              if (ny < 0) {
                put(B);
                put(C);
              } else {
                put(C);
                put(B);
              }
            }
          }
        });
      }
    }
    for (const { pts, n } of cell.polys) {
      const m = pts.length / 3;
      if (n[1] <= 0.05) continue;
      // Polygon in the box frame with its world position: s, t, x, y, z.
      const poly: number[][] = [];
      for (let k = 0; k < m; k++) {
        const x = pts[k * 3]!;
        const z = pts[k * 3 + 2]!;
        poly.push([frameS(fr, x, z), frameT(fr, x, z), x, pts[k * 3 + 1]!, z]);
      }
      // Pitched roof: the underside of the section over the roof space, when that space is open.
      if (attic) {
        const fa = paint!.attr(-1, floors, FINISH.atticWall);
        const hash = paint!.hash(-1);
        const put = (v: number[]): void => {
          const y = Math.max(yMin, v[3]! - slab);
          w.push(v[2]!, y, v[4]!, -n[0], -n[1], -n[2], kindI, v[0]!, v[1]!, 3, hash, mat, floors, floorHeight, fa);
        };
        // The roof polygon winds upwards; written backwards it faces down.
        for (let k = 1; k + 1 < poly.length; k++) {
          put(poly[0]!);
          put(poly[k + 1]!);
          put(poly[k]!);
        }
      }
      // Cut edges on the section borders towards gone neighbours (only inside the footprint).
      for (let k = 0; k < m; k++) {
        const a = poly[k]!;
        const q = poly[(k + 1) % m]!;
        const sa = a[0]! + b.box.halfL;
        const sb = q[0]! + b.box.halfL;
        const ta = a[1]! + b.box.halfW;
        const tb = q[1]! + b.box.halfW;
        let nis = cell.is;
        let nit = cell.it;
        let nrm: [number, number, number] | null = null;
        const on = (va: number, vb: number, line: number): boolean => Math.abs(va - line) < 1e-4 && Math.abs(vb - line) < 1e-4;
        if (on(sa, sb, cell.is * grid.cs)) {
          nis--;
          nrm = [-b.box.ux, 0, -b.box.uz];
        } else if (on(sa, sb, (cell.is + 1) * grid.cs)) {
          nis++;
          nrm = [b.box.ux, 0, b.box.uz];
        } else if (on(ta, tb, cell.it * grid.ct)) {
          nit--;
          nrm = [b.box.uz, 0, -b.box.ux];
        } else if (on(ta, tb, (cell.it + 1) * grid.ct)) {
          nit++;
          nrm = [-b.box.uz, 0, b.box.ux];
        }
        if (!nrm || nis < 0 || nit < 0 || !goneAt(nis, nit)) continue;
        const mx = (a[2]! + q[2]!) / 2;
        const mz = (a[4]! + q[4]!) / 2;
        if (cellAt(plan, mx, mz) < 0 || !pointInside(plan, mx, mz)) continue;
        const fa = paint!.attr(-1, floors, FINISH.concrete);
        const A: V = [a[2]!, a[3]!, a[4]!, 0];
        const B: V = [q[2]!, q[3]!, q[4]!, 0];
        const C: V = [q[2]!, Math.max(yMin, q[3]! - slab), q[4]!, 0];
        const Dd: V = [a[2]!, Math.max(yMin, a[3]! - slab), a[4]!, 0];
        const put = (v: V): void => w.push(v[0], v[1], v[2], nrm![0], 0, nrm![2], kindI, 0, v[1] - eaveY, 1, 0.5, mat, floors, floorHeight, fa);
        tri(w, A, B, C, nrm, put);
        tri(w, A, C, Dd, nrm, put);
      }
    }
  }
}

/** Is a point inside the interior footprint (the inner face of the outer walls)? */
function pointInside(ip: InteriorPlan, x: number, z: number): boolean {
  for (let k = 0; k < ip.tris.length; k += 6) {
    const t = ip.tris;
    const d1 = (x - t[k + 2]!) * (t[k + 1]! - t[k + 3]!) - (t[k]! - t[k + 2]!) * (z - t[k + 3]!);
    const d2 = (x - t[k + 4]!) * (t[k + 3]! - t[k + 5]!) - (t[k + 2]! - t[k + 4]!) * (z - t[k + 5]!);
    const d3 = (x - t[k]!) * (t[k + 5]! - t[k + 1]!) - (t[k + 4]! - t[k]!) * (z - t[k + 1]!);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
}


/** A ruin: only stubs of the ground-storey walls stand, torn at seeded heights. */
function emitRuinStubs(
  p: StructurePlan,
  lines: WallLine[],
  panel: (l: WallLine, u0: number, u1: number, ya: number, yb: number, damage: number, withInner: boolean) => void,
  cut: (l: WallLine, p0: P2, p1: P2, n3: [number, number, number]) => void,
): void {
  const yb0 = rowTop(p, 0);
  for (const l of lines) {
    const e = l.e;
    for (let c = 0; c < e.cols; c++) {
      const u0 = c * e.colW;
      const u1 = (c + 1) * e.colW;
      const h = DESTRUCT_DIM.stubMin + (DESTRUCT_DIM.stubMax - DESTRUCT_DIM.stubMin) * unit(hashInts(p.b.hash, 0x7275, e.ring, e.i, c));
      const top = Math.min(p.floorBase + h, yb0, minTop(l, u0, u1));
      panel(l, u0, u1, p.floorBase, top, 2, true);
      cut(l, [u0, top], [u1, top], [0, 1, 0]);
    }
  }
}
