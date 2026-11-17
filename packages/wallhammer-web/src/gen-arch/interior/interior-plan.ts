// Interior plan of a structure: storeys, rooms, a corridor, a stair core and partition walls with door openings, as a
// pure function of the structure plan (footprint, storeys, window columns, doors, seed). It never reads a damage
// state, so every part key that comes from it is the same in every state and in every order of hits.
//
// Layout, in the oriented box of the footprint (s along the long axis, t across):
//   - cross cuts at s = const, taken from the window column boundaries of the long walls, about 3–6 m apart;
//   - a corridor along s in deep footprints (10 m and more), closed at both ends by full-depth end rooms;
//   - otherwise rows across t, at most 7.5 m deep;
//   - cells of that grid, clipped to the footprint inset by the wall thickness. A partition runs between two
//     neighbouring cells; where it meets an outer wall it must land on a pier between window columns, never across a
//     window or a door. A partition that cannot is dropped and its two cells merge into one room;
//   - a stair core in a single-cell room, next to the corridor and nearest the entrance, when there are storeys to
//     connect;
//   - every room gets a door opening, to the corridor when it borders it.
// The same layout serves every storey. Small footprints get one room; a footprint whose inset fails gets no interior.

import earcut from 'earcut';
import { hashInts, insetRing, pointInRings, unit } from '../../gen-core/index.ts';
import type { Ring } from '../../gen-core/index.ts';
import type { Edge, StructurePlan } from '../structure/buildings.ts';
import { INTERIOR_DIM } from '../structure/dims.ts';
import { DOOR_KIND, GROUND_FLOOR } from '../structure/facade.ts';

/** What a room is. Codes are what the shader reads. */
export const ROOM_TYPE = { room: 0, corridor: 1, core: 2, attic: 3 } as const;

/** Oriented frame of the footprint box: s along (ux, uz), t across. */
export interface BoxFrame {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
}

/** A rectangle in the box frame. */
export interface FrameRect {
  s0: number;
  s1: number;
  t0: number;
  t1: number;
}

export interface InteriorCell {
  i: number;
  j: number;
  /** Convex polygons (x, z pairs) of the inset footprint inside the cell. */
  polys: number[][];
  area: number;
  /** Room index, -1 for an empty cell. */
  room: number;
}

/** One straight run of a partition in the box frame; `wall0`/`wall1`: the end meets an outer wall. */
export interface PartitionSeg {
  s0: number;
  t0: number;
  s1: number;
  t1: number;
  wall0: boolean;
  wall1: boolean;
}

export interface InteriorPartition {
  /** 0: along t at s = sCuts[i] (between cells i − 1 and i of row j); 1: along s at t = tCuts[j]. */
  dir: 0 | 1;
  i: number;
  j: number;
  /** Cells on the negative and positive side. */
  cellA: number;
  cellB: number;
  segs: PartitionSeg[];
  /** Door opening: segment, distance of its centre from the segment start, width. */
  door: { seg: number; at: number; width: number } | null;
}

export interface InteriorRoom {
  type: number;
  cells: number[];
  hash: number;
}

/** The stair core: its cell and the stair rectangle; flights run along s when `alongS`, they start at the low end when `startLow`. */
export interface StairCore {
  cell: number;
  rect: FrameRect;
  alongS: boolean;
  startLow: boolean;
}

export interface InteriorPlan {
  /** False when the footprint could not be inset: no interior is drawn. */
  ok: boolean;
  frame: BoxFrame;
  sCuts: number[];
  tCuts: number[];
  /** Row of the corridor, -1 without one. */
  corridorRow: number;
  /** Inset rings (the inner face of the outer walls) and their triangulation (x, z per vertex). */
  insets: Ring[];
  tris: number[];
  /** Cells by `i * nT + j`. */
  cells: InteriorCell[];
  rooms: InteriorRoom[];
  partitions: InteriorPartition[];
  core: StairCore | null;
  /** Floor top of every storey; the last entry (index `floors`) is the floor of the space under the roof. */
  floorY: number[];
  /** Clear ceiling of every storey (underside of the slab or roof above). */
  ceilY: number[];
  /** A pitched roof with room under it: an attic slab at the eave and one attic room. */
  attic: boolean;
  /** Per edge of the structure plan: positions along the wall where partitions meet it, sorted. */
  wallSplits: number[][];
}

const toS = (f: BoxFrame, x: number, z: number): number => (x - f.cx) * f.ux + (z - f.cz) * f.uz;
const toT = (f: BoxFrame, x: number, z: number): number => -(x - f.cx) * f.uz + (z - f.cz) * f.ux;
export const frameX = (f: BoxFrame, s: number, t: number): number => f.cx + f.ux * s - f.uz * t;
export const frameZ = (f: BoxFrame, s: number, t: number): number => f.cz + f.uz * s + f.ux * t;
export { toS as frameS, toT as frameT };

/** Clips a convex polygon given in the box frame (s, t, then any extra values per vertex) to a rectangle. */
export function clipToRect(poly: number[][], r: FrameRect): number[][] {
  let out = poly;
  const planes: [number, number, number][] = [
    [0, 1, r.s0],
    [0, -1, r.s1],
    [1, 1, r.t0],
    [1, -1, r.t1],
  ];
  for (const [axis, sign, lim] of planes) {
    if (out.length < 3) return [];
    const next: number[][] = [];
    for (let k = 0; k < out.length; k++) {
      const a = out[k]!;
      const b = out[(k + 1) % out.length]!;
      const fa = sign * (a[axis]! - lim);
      const fb = sign * (b[axis]! - lim);
      if (fa >= 0) next.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        next.push(a.map((v, i) => v + (b[i]! - v) * t));
      }
    }
    out = next;
  }
  return out.length >= 3 ? out : [];
}

function polyArea(pts: number[][]): number {
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k]!;
    const q = pts[(k + 1) % pts.length]!;
    a += p[0]! * q[1]! - q[0]! * p[1]!;
  }
  return Math.abs(a) / 2;
}

/** Parameter intervals (0–1) of the segment a → b that lie inside the rings (even–odd). */
export function segmentInside(rings: Ring[], ax: number, az: number, bx: number, bz: number): [number, number][] {
  const ts = [0, 1];
  const dx = bx - ax;
  const dz = bz - az;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const px = r[i * 2]!;
      const pz = r[i * 2 + 1]!;
      const ex = r[j * 2]! - px;
      const ez = r[j * 2 + 1]! - pz;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((px - ax) * ez - (pz - az) * ex) / den;
      const u = ((px - ax) * dz - (pz - az) * dx) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u < 1) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k]!;
    const t1 = ts[k + 1]!;
    if (t1 - t0 < 1e-6) continue;
    const tm = (t0 + t1) / 2;
    if (!pointInRings(ax + dx * tm, az + dz * tm, rings)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - t0) < 1e-9) last[1] = t1;
    else out.push([t0, t1]);
  }
  return out;
}

/** Index of the interval of sorted cuts that holds v (clamped to the outer intervals). */
function slot(cuts: number[], v: number): number {
  for (let k = 1; k < cuts.length - 1; k++) if (v < cuts[k]!) return k - 1;
  return cuts.length - 2;
}

/** Cell index of a point, or -1 outside the grid. */
export function cellAt(plan: InteriorPlan, x: number, z: number): number {
  const s = toS(plan.frame, x, z);
  const t = toT(plan.frame, x, z);
  const { sCuts, tCuts } = plan;
  if (s < sCuts[0]! - 1e-6 || s > sCuts[sCuts.length - 1]! + 1e-6 || t < tCuts[0]! - 1e-6 || t > tCuts[tCuts.length - 1]! + 1e-6) return -1;
  return slot(sCuts, s) * (tCuts.length - 1) + slot(tCuts, t);
}

/** Room of a point, or -1. */
export function roomAt(plan: InteriorPlan, x: number, z: number): number {
  const c = cellAt(plan, x, z);
  return c < 0 ? -1 : plan.cells[c]!.room;
}

/** Rectangle of a cell in the box frame. */
export function cellRect(plan: InteriorPlan, c: number): FrameRect {
  const nT = plan.tCuts.length - 1;
  const i = Math.floor(c / nT);
  const j = c % nT;
  return { s0: plan.sCuts[i]!, s1: plan.sCuts[i + 1]!, t0: plan.tCuts[j]!, t1: plan.tCuts[j + 1]! };
}

/** Widest window opening on a wall over all storeys, in metres; 0 when the wall has no windows. */
function widestWindow(p: StructurePlan, e: Edge): number {
  const rec = p.rec;
  if (rec) {
    if (e.blind) return 0;
    let ww = Math.min(rec.window.width, e.colW * 0.7);
    if (rec.groundFloor === GROUND_FLOOR.glazed) ww = Math.max(ww, Math.min(0.82, (e.colW - 0.5) / e.colW) * e.colW);
    return Math.min(ww, 0.86 * e.colW);
  }
  const style = p.b.windowStyle;
  if (style === 0 || e.len <= p.b.bayWidth * 0.7) return 0;
  if (style === 2) return 0.8 * e.colW;
  if (style === 3) return 0.36 * e.colW;
  return Math.max(0.38, Math.min(0.66, 1.5 / e.colW)) * e.colW;
}

/** May a partition meet wall `e` at `u`, coming in along (dx, dz)? Only on a pier, never at a door. */
function wallAccepts(p: StructurePlan, e: Edge, u: number, dx: number, dz: number): boolean {
  if (Math.abs(e.dx * dx + e.dz * dz) > 0.8) return false;
  const half = INTERIOR_DIM.partition / 2;
  for (const d of e.doors) if (Math.abs(u - d.u) < d.width / 2 + half + 0.2) return false;
  const win = widestWindow(p, e);
  if (win <= 0) return true;
  const k = Math.round(u / e.colW);
  const tol = Math.max(0.02, (e.colW - win) / 2 - half - 0.08);
  return Math.abs(u - k * e.colW) <= tol;
}

/**
 * The interior plan of one structure. Deterministic for the same structure plan; independent of any damage state.
 * `wallT` is the outer wall thickness (`DESTRUCT_DIM.wall`), `roofSlab` the roof thickness.
 */
export function planInterior(p: StructurePlan, wallT: number, roofSlab: number): InteriorPlan {
  const { b, edges } = p;
  const D = INTERIOR_DIM;
  const frame: BoxFrame = { cx: b.box.cx, cz: b.box.cz, ux: b.box.ux, uz: b.box.uz };
  const hL = b.box.halfL;
  const hW = b.box.halfW;
  const r = (k: number, ...more: number[]): number => unit(hashInts(b.hash, 0x1a7e, k, ...more));

  // Storeys.
  const floorY: number[] = [];
  for (let f = 0; f < p.floors; f++) floorY.push(f === 0 ? p.floorBase : p.floorBase + p.groundFloorH + (f - 1) * p.floorHeight);
  floorY.push(p.eaveY);
  let roofTop = p.eaveY;
  for (let k = 1; k < p.roof.tris.length; k += 3) roofTop = Math.max(roofTop, p.roof.tris[k]!);
  const attic = !p.flat && roofTop - p.eaveY > 1.2;
  const ceilY: number[] = [];
  for (let f = 0; f < p.floors; f++) ceilY.push(floorY[f + 1]! - (f + 1 < p.floors || !p.flat ? D.slab : roofSlab));

  const empty: InteriorPlan = { ok: false, frame, sCuts: [-hL, hL], tCuts: [-hW, hW], corridorRow: -1, insets: [], tris: [], cells: [], rooms: [], partitions: [], core: null, floorY, ceilY, attic, wallSplits: edges.map(() => []) };
  const insets = b.rings.map((ring) => insetRing(ring, wallT));
  if (insets.some((x) => x === null)) return empty;
  const inner = insets as Ring[];

  // Triangulation of the inset footprint; a triangle that is not inside the real footprint is dropped.
  const coords: number[] = [];
  const holes: number[] = [];
  inner.forEach((ring, k) => {
    if (k > 0) holes.push(coords.length / 2);
    for (const v of ring) coords.push(v);
  });
  const idx = earcut(coords, holes, 2);
  const tris: number[] = [];
  for (let k = 0; k < idx.length; k += 3) {
    const t = [idx[k]!, idx[k + 1]!, idx[k + 2]!].flatMap((v) => [coords[v * 2]!, coords[v * 2 + 1]!]);
    const mx = (t[0]! + t[2]! + t[4]!) / 3;
    const mz = (t[1]! + t[3]! + t[5]!) / 3;
    if (pointInRings(mx, mz, b.rings)) tris.push(...t);
  }
  let area = 0;
  for (let k = 0; k < tris.length; k += 6) area += Math.abs((tris[k + 2]! - tris[k]!) * (tris[k + 5]! - tris[k + 1]!) - (tris[k + 4]! - tris[k]!) * (tris[k + 3]! - tris[k + 1]!)) / 2;
  if (area < 2) return empty;

  // --- Grid -----------------------------------------------------------------------------------------------------
  const oneRoom = area < D.oneRoomArea || 2 * hW < D.oneRoomWidth;
  const sCuts = [-hL];
  if (!oneRoom) {
    // Candidates: window column boundaries of the walls along the long axis (all walls when none runs along it).
    const along = edges.filter((e) => Math.abs(e.dx * frame.ux + e.dz * frame.uz) > 0.95);
    const source = along.length > 0 ? along : edges;
    const cand: number[] = [];
    for (const e of source) for (let k = 1; k < e.cols; k++) cand.push(toS(frame, e.ax + e.dx * k * e.colW, e.az + e.dz * k * e.colW));
    cand.sort((x, y) => x - y);
    const merged: number[] = [];
    for (const c of cand) if (merged.length === 0 || c - merged[merged.length - 1]! > 0.3) merged.push(c);
    for (let k = 0; k < 256; k++) {
      const prev = sCuts[sCuts.length - 1]!;
      const rest = hL - prev;
      if (rest < 2 * D.roomMin) break;
      let want = prev + D.roomWidthMin + (D.roomWidthMax - D.roomWidthMin) * r(1, k);
      if (want > hL - D.roomMin) {
        if (rest <= D.roomMax) break;
        want = prev + rest / 2;
      }
      let best = NaN;
      for (const c of merged) {
        if (c < prev + D.roomMin || c > hL - D.roomMin) continue;
        if (Number.isNaN(best) || Math.abs(c - want) < Math.abs(best - want)) best = c;
      }
      sCuts.push(!Number.isNaN(best) && Math.abs(best - want) <= 1.6 ? best : want);
    }
  }
  sCuts.push(hL);
  const nS = sCuts.length - 1;

  const tCuts = [-hW];
  let corridorRow = -1;
  // Row cuts land on piers of the walls across the long axis where they can (a cut there meets those walls).
  const acrossCand: number[] = [];
  for (const e of edges) {
    if (Math.abs(e.dx * frame.ux + e.dz * frame.uz) > 0.3) continue;
    for (let k = 1; k < e.cols; k++) acrossCand.push(toT(frame, e.ax + e.dx * k * e.colW, e.az + e.dz * k * e.colW));
    if (widestWindow(p, e) <= 0) acrossCand.push(NaN);
  }
  const rows = (t0: number, t1: number): void => {
    const n = Math.max(1, Math.ceil((t1 - t0) / D.rowMax - 1e-6));
    for (let k = 1; k < n; k++) {
      const want = t0 + ((t1 - t0) * k) / n;
      let best = want;
      for (const c of acrossCand) {
        if (Number.isNaN(c) || c < t0 + D.roomMin || c > t1 - D.roomMin) continue;
        if (Math.abs(c - want) <= 1.8 && Math.abs(c - want) < Math.abs(best - want)) best = c;
      }
      tCuts.push(best);
    }
  };
  if (!oneRoom && 2 * hW >= D.corridorDepth && nS >= 3) {
    const cw = D.corridorWidthMin + (D.corridorWidthMax - D.corridorWidthMin) * r(2);
    const tc = (r(3) - 0.5) * 0.12 * 2 * hW;
    rows(-hW, tc - cw / 2);
    tCuts.push(tc - cw / 2);
    corridorRow = tCuts.length - 1;
    tCuts.push(tc + cw / 2);
    rows(tc + cw / 2, hW);
  } else if (!oneRoom) {
    rows(-hW, hW);
  }
  tCuts.push(hW);
  const nT = tCuts.length - 1;
  const isCorridorCell = (i: number, j: number): boolean => corridorRow >= 0 && j === corridorRow && i >= 1 && i <= nS - 2;

  // --- Cells ----------------------------------------------------------------------------------------------------
  const triFrame: number[][][] = [];
  for (let k = 0; k < tris.length; k += 6) {
    const tri: number[][] = [];
    for (let v = 0; v < 6; v += 2) tri.push([toS(frame, tris[k + v]!, tris[k + v + 1]!), toT(frame, tris[k + v]!, tris[k + v + 1]!)]);
    triFrame.push(tri);
  }
  const cells: InteriorCell[] = [];
  for (let i = 0; i < nS; i++) {
    for (let j = 0; j < nT; j++) {
      const rect = { s0: sCuts[i]!, s1: sCuts[i + 1]!, t0: tCuts[j]!, t1: tCuts[j + 1]! };
      const polys: number[][] = [];
      let a = 0;
      for (const tri of triFrame) {
        const ss = tri.map((v) => v[0]!);
        const tt = tri.map((v) => v[1]!);
        if (Math.max(...ss) <= rect.s0 || Math.min(...ss) >= rect.s1 || Math.max(...tt) <= rect.t0 || Math.min(...tt) >= rect.t1) continue;
        const c = clipToRect(tri, rect);
        const ca = c.length ? polyArea(c) : 0;
        if (ca < 1e-4) continue;
        a += ca;
        polys.push(c.flatMap((v) => [frameX(frame, v[0]!, v[1]!), frameZ(frame, v[0]!, v[1]!)]));
      }
      cells.push({ i, j, polys: a >= D.minCellArea ? polys : [], area: a >= D.minCellArea ? a : 0, room: -1 });
    }
  }
  const cellIndex = (i: number, j: number): number => i * nT + j;
  const live = (c: number): boolean => cells[c]!.area > 0;

  // --- Partitions -------------------------------------------------------------------------------------------------
  const edgeByRing = new Map<number, number>();
  edges.forEach((e, k) => edgeByRing.set(e.ring * 4096 + e.i, k));
  const wallSplits: number[][] = edges.map(() => []);
  /** Edge index of the outer wall nearest to an inset boundary point, and the position along it. */
  const wallAt = (x: number, z: number): { ei: number; u: number } | null => {
    let best: { ei: number; u: number } | null = null;
    let bestD = Infinity;
    inner.forEach((ring, rk) => {
      const n = ring.length / 2;
      for (let k = 0; k < n; k++) {
        const q = (k + 1) % n;
        const ax = ring[k * 2]!;
        const az = ring[k * 2 + 1]!;
        const ex = ring[q * 2]! - ax;
        const ez = ring[q * 2 + 1]! - az;
        const l2 = ex * ex + ez * ez;
        if (l2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
        const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
        const ei = edgeByRing.get(rk * 4096 + k);
        if (ei === undefined || d >= bestD) continue;
        const e = edges[ei]!;
        bestD = d;
        best = { ei, u: (x - e.ax) * e.dx + (z - e.az) * e.dz };
      }
    });
    return best;
  };
  const partitions: InteriorPartition[] = [];
  const pending: { part: InteriorPartition; hits: { ei: number; u: number }[] }[] = [];
  const consider = (dir: 0 | 1, i: number, j: number, cellA: number, cellB: number): void => {
    if (!live(cellA) || !live(cellB)) return;
    const s0 = dir === 0 ? sCuts[i]! : sCuts[i]!;
    const s1 = dir === 0 ? sCuts[i]! : sCuts[i + 1]!;
    const t0 = dir === 0 ? tCuts[j]! : tCuts[j]!;
    const t1 = dir === 0 ? tCuts[j + 1]! : tCuts[j]!;
    const ax = frameX(frame, s0, t0);
    const az = frameZ(frame, s0, t0);
    const bx = frameX(frame, s1, t1);
    const bz = frameZ(frame, s1, t1);
    const len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    const segs: PartitionSeg[] = [];
    const hits: { ei: number; u: number }[] = [];
    let ok = true;
    for (const [p0, p1] of segmentInside(inner, ax, az, bx, bz)) {
      if ((p1 - p0) * len < 0.4) continue;
      const seg: PartitionSeg = { s0: s0 + (s1 - s0) * p0, t0: t0 + (t1 - t0) * p0, s1: s0 + (s1 - s0) * p1, t1: t0 + (t1 - t0) * p1, wall0: p0 > 1e-6, wall1: p1 < 1 - 1e-6 };
      for (const [isWall, pr] of [
        [seg.wall0, p0],
        [seg.wall1, p1],
      ] as const) {
        if (!isWall) continue;
        const w = wallAt(ax + (bx - ax) * pr, az + (bz - az) * pr);
        if (!w || !wallAccepts(p, edges[w.ei]!, w.u, dx, dz)) ok = false;
        else hits.push(w);
      }
      segs.push(seg);
    }
    if (!ok || segs.length === 0) return;
    pending.push({ part: { dir, i, j, cellA, cellB, segs, door: null }, hits });
  };
  for (let i = 1; i < nS; i++) {
    for (let j = 0; j < nT; j++) {
      if (corridorRow >= 0 && j === corridorRow && i !== 1 && i !== nS - 1) continue;
      consider(0, i, j, cellIndex(i - 1, j), cellIndex(i, j));
    }
  }
  for (let j = 1; j < nT; j++) {
    for (let i = 0; i < nS; i++) {
      if (corridorRow >= 0 && (i === 0 || i === nS - 1)) continue;
      consider(1, i, j, cellIndex(i, j - 1), cellIndex(i, j));
    }
  }
  for (const { part, hits } of pending) {
    partitions.push(part);
    for (const h of hits) wallSplits[h.ei]!.push(h.u);
  }
  for (const s of wallSplits) s.sort((x, y) => x - y);

  // Runs along s stop at the faces of cross walls they meet.
  const crossAt = (i: number, j: number): boolean => partitions.some((q) => q.dir === 0 && q.i === i && (q.j === j || q.j === j - 1));
  for (const q of partitions) {
    if (q.dir !== 1) continue;
    for (const seg of q.segs) {
      const half = D.partition / 2;
      if (!seg.wall0 && Math.abs(seg.s0 - sCuts[q.i]!) < 1e-6 && crossAt(q.i, q.j)) seg.s0 += half;
      if (!seg.wall1 && Math.abs(seg.s1 - sCuts[q.i + 1]!) < 1e-6 && crossAt(q.i + 1, q.j)) seg.s1 -= half;
    }
  }

  // --- Rooms: cells joined where no partition stands between them --------------------------------------------------
  const parent = cells.map((_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) k = parent[k] = parent[parent[k]!]!;
    return k;
  };
  const join = (a: number, c: number): void => {
    const ra = find(a);
    const rc = find(c);
    if (ra !== rc) parent[Math.max(ra, rc)] = Math.min(ra, rc);
  };
  const has = new Set(partitions.map((q) => `${q.cellA}:${q.cellB}`));
  const touching = (dir: 0 | 1, i: number, j: number): boolean => {
    const s0 = sCuts[i]!;
    const s1 = dir === 0 ? sCuts[i]! : sCuts[i + 1]!;
    const t0 = tCuts[j]!;
    const t1 = dir === 0 ? tCuts[j + 1]! : tCuts[j]!;
    return segmentInside(inner, frameX(frame, s0, t0), frameZ(frame, s0, t0), frameX(frame, s1, t1), frameZ(frame, s1, t1)).some(([a, c]) => c - a > 1e-3);
  };
  for (let i = 0; i < nS; i++) {
    for (let j = 0; j < nT; j++) {
      const c = cellIndex(i, j);
      if (!live(c)) continue;
      if (i + 1 < nS && live(cellIndex(i + 1, j)) && !has.has(`${c}:${cellIndex(i + 1, j)}`) && touching(0, i + 1, j)) join(c, cellIndex(i + 1, j));
      if (j + 1 < nT && live(cellIndex(i, j + 1)) && !has.has(`${c}:${cellIndex(i, j + 1)}`) && touching(1, i, j + 1)) join(c, cellIndex(i, j + 1));
    }
  }
  const rooms: InteriorRoom[] = [];
  const roomOfRoot = new Map<number, number>();
  cells.forEach((cell, k) => {
    if (!live(k)) return;
    const root = find(k);
    let ri = roomOfRoot.get(root);
    if (ri === undefined) {
      ri = rooms.length;
      roomOfRoot.set(root, ri);
      rooms.push({ type: ROOM_TYPE.room, cells: [], hash: unit(hashInts(b.hash, 0x726d, root)) });
    }
    rooms[ri]!.cells.push(k);
    cell.room = ri;
    if (isCorridorCell(cell.i, cell.j)) rooms[ri]!.type = ROOM_TYPE.corridor;
  });
  // A partition between two cells of the same room (possible around a dropped partition) is not needed.
  for (let k = partitions.length - 1; k >= 0; k--) {
    const q = partitions[k]!;
    if (cells[q.cellA]!.room === cells[q.cellB]!.room) partitions.splice(k, 1);
  }
  const corridor = rooms.findIndex((x) => x.type === ROOM_TYPE.corridor);

  // --- Stair core ----------------------------------------------------------------------------------------------------
  let core: StairCore | null = null;
  if (p.floors >= 2 && rooms.length > 1) {
    let maxH = 0;
    for (let f = 0; f + 1 < p.floors; f++) maxH = Math.max(maxH, floorY[f + 1]! - floorY[f]!);
    const steps = Math.ceil(maxH / 2 / D.stairRise);
    const lenMin = steps * D.treadMin + 2 * D.landingMin;
    const lenWant = steps * 0.27 + 2 * 1.1;
    // Aim: inside the main entrance, else the middle of the corridor (or the box).
    let aimS = 0;
    let aimT = corridorRow >= 0 ? (tCuts[corridorRow]! + tCuts[corridorRow + 1]!) / 2 : 0;
    const door = edges.flatMap((e) => e.doors.filter((d) => d.kind !== DOOR_KIND.garage).map((d) => ({ e, d })))[0];
    if (door) {
      const x = door.e.ax + door.e.dx * door.d.u - door.e.nx * 2;
      const z = door.e.az + door.e.dz * door.d.u - door.e.nz * 2;
      aimS = toS(frame, x, z);
      aimT = toT(frame, x, z);
    }
    let bestScore = Infinity;
    // First a room of its own (a stairwell); failing that, any cell of a room (an open stair in the room).
    const candidates: number[] = [];
    rooms.forEach((room) => {
      if (room.type === ROOM_TYPE.room && room.cells.length === 1) candidates.push(room.cells[0]!);
    });
    const alone = candidates.length;
    rooms.forEach((room) => {
      if (room.type === ROOM_TYPE.room && room.cells.length > 1) candidates.push(...room.cells);
    });
    candidates.forEach((c, ci) => {
      const cell = cells[c]!;
      // Bounds of the cell's floor in the box frame, kept clear of partition faces.
      let s0 = Infinity;
      let s1 = -Infinity;
      let t0 = Infinity;
      let t1 = -Infinity;
      for (const poly of cell.polys) {
        for (let k = 0; k < poly.length; k += 2) {
          const s = toS(frame, poly[k]!, poly[k + 1]!);
          const t = toT(frame, poly[k]!, poly[k + 1]!);
          s0 = Math.min(s0, s);
          s1 = Math.max(s1, s);
          t0 = Math.min(t0, t);
          t1 = Math.max(t1, t);
        }
      }
      const m = D.partition / 2 + 0.04;
      s0 += m;
      s1 -= m;
      t0 += m;
      t1 -= m;
      const alongS = s1 - s0 >= t1 - t0;
      const long = alongS ? s1 - s0 : t1 - t0;
      const short = alongS ? t1 - t0 : s1 - s0;
      if (long < lenMin || short < D.stairWidthMin) return;
      const L = Math.min(long, lenWant);
      const W = Math.min(short, D.stairWidthMax);
      const ms = (s0 + s1) / 2;
      const mt = (t0 + t1) / 2;
      const rect = alongS ? { s0: ms - L / 2, s1: ms + L / 2, t0: mt - W / 2, t1: mt + W / 2 } : { s0: ms - W / 2, s1: ms + W / 2, t0: mt - L / 2, t1: mt + L / 2 };
      const corners = [
        [rect.s0, rect.t0],
        [rect.s1, rect.t0],
        [rect.s1, rect.t1],
        [rect.s0, rect.t1],
      ];
      if (!corners.every(([s, t]) => pointInRings(frameX(frame, s!, t!), frameZ(frame, s!, t!), inner) && cellAtST(s!, t!) === c)) return;
      const byCorridor = corridor >= 0 && partitions.some((q) => (q.cellA === c && cells[q.cellB]!.room === corridor) || (q.cellB === c && cells[q.cellA]!.room === corridor));
      const score = (ci < alone ? 0 : 10000) + (byCorridor ? 0 : 1000) + Math.hypot(ms - aimS, mt - aimT);
      if (score < bestScore - 1e-9) {
        bestScore = score;
        // Flights start at the end nearer the aim point, where the door is likely to be.
        const startLow = alongS ? aimS <= ms : aimT <= mt;
        core = { cell: c, rect, alongS, startLow };
      }
    });
    const coreRoom = core ? rooms[cells[(core as StairCore).cell]!.room]! : null;
    if (coreRoom && coreRoom.cells.length === 1) coreRoom.type = ROOM_TYPE.core;
  }
  function cellAtST(s: number, t: number): number {
    return slot(sCuts, s) * nT + slot(tCuts, t);
  }

  // --- Doors ---------------------------------------------------------------------------------------------------------
  const segLen = (sg: PartitionSeg): number => Math.hypot(sg.s1 - sg.s0, sg.t1 - sg.t0);
  const roomOf = (c: number): number => cells[c]!.room;
  rooms.forEach((room, ri) => {
    if (room.type === ROOM_TYPE.corridor) return;
    const width = room.type === ROOM_TYPE.core ? D.coreDoorWidth : D.doorWidth;
    const mine = partitions.filter((q) => roomOf(q.cellA) === ri || roomOf(q.cellB) === ri);
    const other = (q: InteriorPartition): number => (roomOf(q.cellA) === ri ? roomOf(q.cellB) : roomOf(q.cellA));
    if (mine.some((q) => q.door && (other(q) === corridor || corridor < 0))) return;
    const pickFrom = (list: InteriorPartition[]): boolean => {
      let best: { q: InteriorPartition; seg: number; len: number } | null = null;
      for (const q of list) {
        if (q.door) continue;
        q.segs.forEach((sg, k) => {
          const l = segLen(sg);
          if (l >= width + 0.5 && (!best || l > best.len + 1e-9)) best = { q, seg: k, len: l };
        });
      }
      if (!best) return false;
      const { q, seg, len } = best as { q: InteriorPartition; seg: number; len: number };
      const room0 = (len - width) / 2 - 0.25;
      q.door = { seg, at: len / 2 + (r(4, q.dir, q.i, q.j) * 2 - 1) * Math.max(0, room0), width };
      return true;
    };
    if (corridor >= 0 && pickFrom(mine.filter((q) => other(q) === corridor))) return;
    if (mine.some((q) => q.door)) return;
    pickFrom(mine);
  });

  return { ok: true, frame, sCuts, tCuts, corridorRow, insets: inner, tris, cells, rooms, partitions, core, floorY, ceilY, attic, wallSplits };
}
