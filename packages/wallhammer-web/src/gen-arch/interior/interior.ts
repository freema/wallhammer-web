// Interior of a damaged structure: the destructible parts of the interior plan (slabs, partitions, stairs) and their
// geometry. Only a damaged structure draws it; an intact one stays exactly the plain mesh.
//
// Surfaces are written as `KIND.interior` with the room in the vertex data, so the shader paints them:
//   s0, s1   pattern coordinates (box frame s, t on floors and ceilings; along the wall and height above the floor
//            on walls), s2 clear height of the storey, s3 room hash;
//   a_fac    night light of the room: lowest lit-window threshold of its windows (2 = no window), own threshold, mode;
//   a_bits   finish, room type, storey;
//   a_win    daylight of the room: glazed share (0–255) and the direction it comes from (x, z bytes, 128 = none).
// The lowest threshold uses the same hash as the window light, so a room glows exactly when one of its windows does.
//
// The inner face of an outer wall is `KIND.wallInside`: it keeps the wall's façade data (u along the wall, wall length,
// height above the floor base, window and door attributes), so the shader puts the openings exactly where the outside
// has them. The room goes into slots the inside does not read: s3 packs room paint, lit threshold and own threshold
// (one byte each), a_mat.x finish | type << 2 | mode << 4, a_mat.y daylight, a_mat.w and a_win.w its direction.

import { PART_FLAG, PART_ROLE } from '../../base/index.ts';
import type { PartRole, StructurePart } from '../../base/index.ts';
import { hashInts, unit } from '../../gen-core/index.ts';
import type { Edge, StructurePlan } from '../structure/buildings.ts';
import { INTERIOR_DIM } from '../structure/dims.ts';
import { DOOR_KIND, GROUND_FLOOR } from '../structure/facade.ts';
import { ROOM_TYPE, cellAt, clipToRect, frameS, frameT, frameX, frameZ, segmentInside } from './interior-plan.ts';
import type { FrameRect, InteriorPlan, InteriorPartition, PartitionSeg } from './interior-plan.ts';
import { PART_RULE, bayKey, partitionKey, slabKey, stairKey } from '../structure/parts.ts';
import { DAMAGE_STEP, KIND, WIN_UNIT } from '../structure/writer.ts';
import type { VertexMaterial, VertexWriter, WallAttr } from '../structure/writer.ts';

/** Finish codes the shader reads (a_bits.x). */
export const FINISH = { paint: 0, ceiling: 1, floor: 2, concrete: 3, stair: 4, atticWall: 5, atticFloor: 6 } as const;

/** Material slots of the interior parts, appended after the structure materials. */
export const INTERIOR_MATERIAL = { floor: 5, partition: 6 } as const;

const MAX_STOREY = 255;

// --- Night light ----------------------------------------------------------------------------------------------------

/** The GLSL `hashU` (render/glsl.ts) on 32-bit unsigned integers. */
function hashU(x: number): number {
  x >>>= 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
/** The GLSL `hash2(ivec2(px, py), seed)`, including the float conversion of the shader. */
function hash2(px: number, py: number, seed: number): number {
  const v = hashU((Math.imul(px >>> 0, 0x9e3779b1) ^ hashU((py + Math.imul(seed >>> 0, 0x85ebca6b)) >>> 0)) >>> 0);
  return Math.fround(v) / 4294967296;
}
/** `uint(a * b)` as the shader computes it in 32-bit floats. */
const f32uint = (a: number, b: number): number => Math.floor(Math.fround(Math.fround(a) * b)) >>> 0;

/** Room behind column centre u of an edge, looking a little past the wall's inner face (-1: none). */
function roomBehind(ip: InteriorPlan, e: Edge, u: number, wallT: number): number {
  for (const d of [wallT + 0.35, wallT + 1]) {
    const r = cellAt(ip, e.ax + e.dx * u - e.nx * d, e.az + e.dz * u - e.nz * d);
    if (r >= 0 && ip.cells[r]!.room >= 0) return ip.cells[r]!.room;
  }
  return -1;
}

interface RoomLight {
  /** Lowest lit-window threshold per room and storey (index `room * floors + f`); 2 when the room has no window. */
  lit: Float32Array;
  /** Glazed area per room and storey, and its outward direction weighted by area (x, z). */
  glass: Float32Array;
  dirX: Float32Array;
  dirZ: Float32Array;
}

/**
 * Window light of the rooms, from the same rules the façade shader uses: the lowest lit-window threshold (the room is
 * lit at night when the share of lit windows passes it) and the glazed area with its direction (daylight).
 */
function roomLights(p: StructurePlan, ip: InteriorPlan, wallT: number): RoomLight {
  const n = ip.rooms.length * p.floors;
  const out: RoomLight = { lit: new Float32Array(n).fill(2), glass: new Float32Array(n), dirX: new Float32Array(n), dirZ: new Float32Array(n) };
  const seed = f32uint(p.mat.seed, 16777215);
  const rec = p.rec;
  for (const e of p.edges) {
    const wallSeed = (seed + 77 + f32uint(e.len, 31)) >>> 0;
    if (rec ? e.blind : p.b.windowStyle === 0 || e.len <= p.b.bayWidth * 0.7) continue;
    const doorCol = e.doors.length > 0 ? Math.floor(e.doors[0]!.u / e.colW) : -1;
    const doorKind = e.doors.length > 0 ? e.doors[0]!.kind : 0;
    for (let c = 0; c < e.cols; c++) {
      const u = (c + 0.5) * e.colW;
      const room = roomBehind(ip, e, u, wallT);
      if (room < 0) continue;
      const doorColumn = e.doors.some((d) => Math.floor(d.u / e.colW) === c);
      for (let f = 0; f < p.floors; f++) {
        let row = f;
        let factor = 1;
        let area: number;
        if (rec) {
          if (doorColumn && rec.stairStrip && doorKind !== DOOR_KIND.garage && c === doorCol) continue;
          if (f === 0 && (rec.groundFloor === GROUND_FLOOR.blind || doorColumn)) continue;
          if (f === 0 && rec.groundFloor !== GROUND_FLOOR.windows) factor = 0.5;
          const narrow = ((rec.window.narrowMask >> (c % 4)) & 1) !== 0;
          let ww = Math.min(rec.window.width * (narrow ? 0.55 : 1), 0.86 * e.colW);
          let wh = rec.window.height;
          if (f === 0 && rec.groundFloor === GROUND_FLOOR.glazed) {
            ww = Math.min(0.82 * e.colW, e.colW - 0.5);
            wh = p.groundFloorH - 0.85;
          } else if (f === 0 && rec.groundFloor === GROUND_FLOOR.high) {
            ww *= 0.85;
            wh = 0.7;
          }
          area = Math.max(0, ww) * Math.max(0, wh);
        } else {
          const mid = (ip.floorY[f]! + ip.floorY[f + 1]!) / 2 - p.floorBase;
          row = Math.floor(mid / p.floorHeight);
          if (row >= p.floors) continue;
          factor = p.b.windowStyle === 1 ? 1 : 0.55;
          const st = p.b.windowStyle;
          const ww = st === 2 ? 0.8 : st === 3 ? 0.36 : Math.min(0.66, Math.max(0.38, 1.5 / e.colW));
          const wh = st === 2 ? 0.48 : st === 3 ? 0.3 : Math.min(0.62, Math.max(0.3, 1.65 / p.floorHeight));
          area = ww * e.colW * wh * p.floorHeight;
        }
        const h = hash2(c, row, wallSeed) / factor;
        const k = room * p.floors + f;
        out.lit[k] = Math.min(out.lit[k]!, h);
        out.glass[k] = out.glass[k]! + area;
        out.dirX[k] = out.dirX[k]! + area * e.nx;
        out.dirZ[k] = out.dirZ[k]! + area * e.nz;
      }
    }
  }
  return out;
}

// --- Vertex data ----------------------------------------------------------------------------------------------------

/** Vertex data of interior surfaces per room, storey and finish. */
export class InteriorPaint {
  private cache = new Map<number, WallAttr>();
  private lights: RoomLight;
  private area: Float32Array;
  readonly p: StructurePlan;
  readonly ip: InteriorPlan;
  readonly wallT: number;
  constructor(p: StructurePlan, ip: InteriorPlan, wallT: number) {
    this.p = p;
    this.ip = ip;
    this.wallT = wallT;
    this.lights = roomLights(p, ip, wallT);
    this.area = new Float32Array(ip.rooms.length);
    ip.rooms.forEach((r, k) => {
      for (const c of r.cells) this.area[k] = this.area[k]! + ip.cells[c]!.area;
    });
  }
  /**
   * An opening (a breached bay) of `area` m² in the outer wall at column centre u of edge e, storey f: it lets in
   * daylight like a window. Must be called before the first `attr`.
   */
  addOpening(e: Edge, u: number, f: number, area: number): void {
    const room = roomBehind(this.ip, e, u, this.wallT);
    if (room < 0 || f < 0 || f >= this.p.floors) return;
    const k = room * this.p.floors + f;
    const L = this.lights;
    L.glass[k] = L.glass[k]! + area;
    L.dirX[k] = L.dirX[k]! + area * e.nx;
    L.dirZ[k] = L.dirZ[k]! + area * e.nz;
  }
  /** Room hash of a room index (-1: a neutral one). */
  hash(room: number): number {
    return room >= 0 ? this.ip.rooms[room]!.hash : 0.5;
  }
  /** Daylight of a room on storey f as bytes: amount (glazed share of the floor area) and the direction it comes from (x, z, 128 = none). */
  daylight(room: number, f: number): [number, number, number] {
    if (room < 0 || f >= this.p.floors) return [0, 128, 128];
    const k = room * this.p.floors + f;
    const g = this.lights.glass[k]!;
    const day = Math.min(1, g / Math.max(this.area[room]!, 1) / DAYLIGHT_FULL_SHARE);
    const dx = g > 0 ? this.lights.dirX[k]! / g : 0;
    const dz = g > 0 ? this.lights.dirZ[k]! / g : 0;
    return [Math.round(day * 255), Math.round(128 + 127 * dx), Math.round(128 + 127 * dz)];
  }
  attr(room: number, f: number, finish: number): WallAttr {
    const key = ((room + 1) * 300 + Math.min(f, 299)) * 8 + finish;
    let a = this.cache.get(key);
    if (!a) {
      const r = room >= 0 ? this.ip.rooms[room]! : null;
      const type = f >= this.p.floors ? ROOM_TYPE.attic : r ? r.type : ROOM_TYPE.room;
      const lit = r && f < this.p.floors ? this.lights.lit[room * this.p.floors + f]! : 2;
      const own = unit(hashInts(this.p.b.hash, 0x6c74, room, f));
      // Mode: 0 a room (own threshold only without windows), 1 shared space on timers, 2 never lit (roof space).
      const mode = type === ROOM_TYPE.attic || !r ? 2 : type === ROOM_TYPE.room ? 0 : 1;
      const [day, dx, dz] = this.daylight(room, f);
      a = { doorU: lit, doorW: 0, doorY: own, groundFloorH: mode, win: [day * WIN_UNIT, dx * WIN_UNIT, dz * WIN_UNIT, 0], bits: [finish, type, Math.min(f, MAX_STOREY), 0], cols: [0, 0, 0, 0] };
      this.cache.set(key, a);
    }
    return a;
  }
  /**
   * Vertex data of the inner face of an outer wall (`KIND.wallInside`): the wall's own façade data, so the shader
   * finds its windows and doors exactly where the outside has them, with the room packed into the slots the inside
   * does not read (see the module comment).
   */
  wallInside(room: number, f: number, finish: number, wall: WallAttr): { mat: VertexMaterial; fa: WallAttr; s3: number } {
    const a = this.attr(room, f, finish);
    const rs = f32uint(this.hash(room), 16777215) >>> 16;
    const lit = a.doorU >= 1 ? 255 : Math.round(a.doorU * 254);
    const own = Math.round(a.doorY * 255);
    const [day, dx, dz] = this.daylight(room, f);
    return {
      mat: { ...this.p.mat, wallColor: finish | (a.bits[1]! << 2) | (a.groundFloorH << 4), roofColor: day, trimColor: dx },
      fa: { ...wall, groundFloorH: wall.groundFloorH > 0 ? wall.groundFloorH : this.p.groundFloorH, win: [wall.win[0]!, wall.win[1]!, wall.win[2]!, dz * WIN_UNIT] },
      s3: rs + 256 * lit + 65536 * own,
    };
  }
}

/** Glazed share of the floor area at which a room counts as fully daylit. */
const DAYLIGHT_FULL_SHARE = 0.22;

type Vec3 = [number, number, number];

/** Writes a convex polygon (3D points) facing along n, with per-vertex pattern coordinates. */
function polyOut(w: VertexWriter, p: StructurePlan, pts: Vec3[], uv: [number, number][], n: Vec3, damage: number, s2: number, s3: number, fa: WallAttr): void {
  if (pts.length < 3) return;
  // Orientation from Newell's normal of the whole polygon.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let k = 0; k < pts.length; k++) {
    const q = pts[k]!;
    const r = pts[(k + 1) % pts.length]!;
    nx += (q[1] - r[1]) * (q[2] + r[2]);
    ny += (q[2] - r[2]) * (q[0] + r[0]);
    nz += (q[0] - r[0]) * (q[1] + r[1]);
  }
  const flip = nx * n[0] + ny * n[1] + nz * n[2] < 0;
  const kind = KIND.interior + DAMAGE_STEP * damage;
  const put = (k: number): void => {
    const q = pts[k]!;
    const t = uv[k]!;
    w.push(q[0], q[1], q[2], n[0], n[1], n[2], kind, t[0], t[1], s2, s3, p.mat, p.floors, p.floorHeight, fa);
  };
  for (let k = 1; k + 1 < pts.length; k++) {
    put(0);
    if (flip) {
      put(k + 1);
      put(k);
    } else {
      put(k);
      put(k + 1);
    }
  }
}

/** A vertical quad from (x0, z0) to (x1, z1) between y0 and y1, facing along n; pattern u from u0. */
function wallQuad(w: VertexWriter, p: StructurePlan, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, n: Vec3, u0: number, floorY: number, damage: number, s2: number, s3: number, fa: WallAttr): void {
  if (y1 - y0 < 1e-4) return;
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 1e-4) return;
  polyOut(
    w,
    p,
    [
      [x0, y0, z0],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z0],
    ],
    [
      [u0, y0 - floorY],
      [u0 + len, y0 - floorY],
      [u0 + len, y1 - floorY],
      [u0, y1 - floorY],
    ],
    n,
    damage,
    s2,
    s3,
    fa,
  );
}

/** A box in the box frame: [a0, a1] along `along` (s when true), [b0, b1] across, y from y0 to y1; all six faces. */
function frameBox(w: VertexWriter, p: StructurePlan, ip: InteriorPlan, alongS: boolean, a0: number, a1: number, b0: number, b1: number, y0: number, y1: number, floorY: number, damage: number, s2: number, s3: number, fa: WallAttr, bottom: boolean): void {
  const fr = ip.frame;
  const P = (a: number, b: number, y: number): Vec3 => {
    const s = alongS ? a : b;
    const t = alongS ? b : a;
    return [frameX(fr, s, t), y, frameZ(fr, s, t)];
  };
  const dirA: Vec3 = alongS ? [fr.ux, 0, fr.uz] : [-fr.uz, 0, fr.ux];
  const dirB: Vec3 = alongS ? [-fr.uz, 0, fr.ux] : [fr.ux, 0, fr.uz];
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
  const top: Vec3[] = [P(a0, b0, y1), P(a1, b0, y1), P(a1, b1, y1), P(a0, b1, y1)];
  const uv: [number, number][] = [
    [a0, b0],
    [a1, b0],
    [a1, b1],
    [a0, b1],
  ];
  polyOut(w, p, top, uv, [0, 1, 0], damage, s2, s3, fa);
  if (bottom) polyOut(w, p, [P(a0, b0, y0), P(a1, b0, y0), P(a1, b1, y0), P(a0, b1, y0)], uv, [0, -1, 0], damage, s2, s3, fa);
  const side = (q0: Vec3, q1: Vec3, n: Vec3): void => wallQuad(w, p, q0[0], q0[2], q1[0], q1[2], y0, y1, n, 0, floorY, damage, s2, s3, fa);
  side(P(a0, b0, 0), P(a1, b0, 0), neg(dirB));
  side(P(a0, b1, 0), P(a1, b1, 0), dirB);
  side(P(a0, b0, 0), P(a0, b1, 0), neg(dirA));
  side(P(a1, b0, 0), P(a1, b1, 0), dirA);
}

// --- Plan helpers ---------------------------------------------------------------------------------------------------

/** Neighbouring live cells whose shared boundary lies inside the footprint, with that boundary (x, z segments). */
export interface CellLink {
  a: number;
  b: number;
  /** 0: boundary at s = const (b is the next cell along s), 1: at t = const. */
  dir: 0 | 1;
  segs: [number, number, number, number][];
}
const linkCache = new WeakMap<InteriorPlan, CellLink[]>();
export function cellLinks(ip: InteriorPlan): CellLink[] {
  let out = linkCache.get(ip);
  if (out) return out;
  out = [];
  const nS = ip.sCuts.length - 1;
  const nT = ip.tCuts.length - 1;
  const fr = ip.frame;
  for (let i = 0; i < nS; i++) {
    for (let j = 0; j < nT; j++) {
      const c = i * nT + j;
      if (ip.cells[c]!.area <= 0) continue;
      for (const dir of [0, 1] as const) {
        const ni = dir === 0 ? i + 1 : i;
        const nj = dir === 0 ? j : j + 1;
        if (ni >= nS || nj >= nT) continue;
        const d = ni * nT + nj;
        if (ip.cells[d]!.area <= 0) continue;
        const s0 = dir === 0 ? ip.sCuts[ni]! : ip.sCuts[i]!;
        const s1 = dir === 0 ? ip.sCuts[ni]! : ip.sCuts[i + 1]!;
        const t0 = dir === 0 ? ip.tCuts[j]! : ip.tCuts[nj]!;
        const t1 = dir === 0 ? ip.tCuts[j + 1]! : ip.tCuts[nj]!;
        const ax = frameX(fr, s0, t0);
        const az = frameZ(fr, s0, t0);
        const bx = frameX(fr, s1, t1);
        const bz = frameZ(fr, s1, t1);
        const segs: [number, number, number, number][] = [];
        for (const [p0, p1] of segmentInside(ip.insets, ax, az, bx, bz)) {
          if (p1 - p0 < 1e-4) continue;
          segs.push([ax + (bx - ax) * p0, az + (bz - az) * p0, ax + (bx - ax) * p1, az + (bz - az) * p1]);
        }
        if (segs.length > 0) out.push({ a: c, b: d, dir, segs });
      }
    }
  }
  linkCache.set(ip, out);
  return out;
}

/** A piece of the inner face of an outer wall inside one cell: world end points and positions along the edge. */
interface WallPiece {
  cell: number;
  e: Edge;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  u0: number;
  u1: number;
}
const pieceCache = new WeakMap<InteriorPlan, WallPiece[]>();
/** Inner wall faces split by cell (computed once per plan). */
function wallPieces(p: StructurePlan, ip: InteriorPlan): WallPiece[] {
  let out = pieceCache.get(ip);
  if (out) return out;
  out = [];
  const fr = ip.frame;
  const nT = ip.tCuts.length - 1;
  const edgeOf = new Map(p.edges.map((e) => [e.ring * 100000 + e.i, e] as const));
  ip.insets.forEach((ring, rk) => {
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const e = edgeOf.get(rk * 100000 + k);
      if (!e) continue;
      const q = (k + 1) % n;
      const a = [frameS(fr, ring[k * 2]!, ring[k * 2 + 1]!), frameT(fr, ring[k * 2]!, ring[k * 2 + 1]!)];
      const b = [frameS(fr, ring[q * 2]!, ring[q * 2 + 1]!), frameT(fr, ring[q * 2]!, ring[q * 2 + 1]!)];
      const sLo = Math.min(a[0]!, b[0]!);
      const sHi = Math.max(a[0]!, b[0]!);
      const tLo = Math.min(a[1]!, b[1]!);
      const tHi = Math.max(a[1]!, b[1]!);
      ip.cells.forEach((cell, c) => {
        if (cell.area <= 0) return;
        const i = Math.floor(c / nT);
        const j = c % nT;
        const rect = { s0: ip.sCuts[i]!, s1: ip.sCuts[i + 1]!, t0: ip.tCuts[j]!, t1: ip.tCuts[j + 1]! };
        if (rect.s1 < sLo - 1e-6 || rect.s0 > sHi + 1e-6 || rect.t1 < tLo - 1e-6 || rect.t0 > tHi + 1e-6) return;
        const seg = clipSeg(a, b, rect);
        if (!seg) return;
        const x0 = frameX(fr, seg[0], seg[1]);
        const z0 = frameZ(fr, seg[0], seg[1]);
        const x1 = frameX(fr, seg[2], seg[3]);
        const z1 = frameZ(fr, seg[2], seg[3]);
        out!.push({ cell: c, e, x0, z0, x1, z1, u0: (x0 - e.ax) * e.dx + (z0 - e.az) * e.dz, u1: (x1 - e.ax) * e.dx + (z1 - e.az) * e.dz });
      });
    }
  });
  pieceCache.set(ip, out);
  return out;
}

export interface InteriorExposureContext {
  /** Damage level of a part (0–2), or -1 when it is gone. */
  level: (key: number) => number;
  /** Is the outer wall bay (edge, column, storey) open: breached or gone? */
  bayOpen: (e: Edge, c: number, f: number) => boolean;
  /** Rectangles (box frame) of the roof sections that are gone. */
  roofGone: readonly FrameRect[];
}

/**
 * Which rooms can be seen into, per storey: `open[f * rooms + room]` is 1. Index `floors` is the space under a
 * pitched roof. A room opens behind a breached or gone outer bay, above and below a gone slab, under a gone roof
 * section; it passes the view on through gone partitions, and one step further through a door. The stair core is
 * open on every storey or on none. Rooms that stay closed draw nothing: only exposed rooms cost triangles.
 */
export function interiorExposure(p: StructurePlan, ip: InteriorPlan, ctx: InteriorExposureContext): Uint8Array {
  const nR = ip.rooms.length;
  const F = p.floors;
  const open = new Uint8Array((F + 1) * nR);
  if (!ip.ok || nR === 0) return open;
  const fits = interiorFits(p, ip);
  const lv = (key: number): number => (fits ? ctx.level(key) : 0);
  const roomOf = (c: number): number => (c >= 0 ? ip.cells[c]!.room : -1);
  const mark = (f: number, r: number): void => {
    if (r >= 0 && f >= 0 && f <= F) open[f * nR + r] = 1;
  };
  const nT = ip.tCuts.length - 1;
  // Behind open bays of the outer walls.
  for (const pc of wallPieces(p, ip)) {
    const r = roomOf(pc.cell);
    if (r < 0) continue;
    const ua = Math.min(pc.u0, pc.u1);
    const ub = Math.max(pc.u0, pc.u1);
    const e = pc.e;
    for (let f = 0; f < F; f++) {
      if (open[f * nR + r]) continue;
      for (let col = Math.max(0, Math.floor(ua / e.colW)); col < e.cols && col * e.colW < ub; col++) {
        if (ctx.bayOpen(e, col, f)) {
          mark(f, r);
          break;
        }
      }
    }
  }
  // Under gone roof sections: the top storey of a flat roof, the roof space of a pitched one.
  for (const g of ctx.roofGone) {
    if (!p.flat) {
      for (let r = 0; r < nR; r++) mark(F, r);
      break;
    }
    ip.cells.forEach((cell, c) => {
      if (cell.area <= 0) return;
      const i = Math.floor(c / nT);
      const j = c % nT;
      if (ip.sCuts[i + 1]! <= g.s0 || ip.sCuts[i]! >= g.s1 || ip.tCuts[j + 1]! <= g.t0 || ip.tCuts[j]! >= g.t1) return;
      mark(F - 1, cell.room);
    });
  }
  // Above and below gone slabs.
  const top = topSlab(p);
  for (let f = 1; f <= top; f++) {
    ip.cells.forEach((cell, c) => {
      if (cell.area <= 0 || cell.room < 0) return;
      if (lv(slabKey(f, Math.floor(c / nT), c % nT)) >= 0) return;
      mark(f - 1, cell.room);
      mark(f, cell.room);
    });
  }
  const isOpen = (f: number, r: number): boolean => r >= 0 && open[f * nR + r] === 1;
  const core = ip.core ? roomOf(ip.core.cell) : -1;
  const coreRule = (): void => {
    if (core < 0) return;
    let any = false;
    for (let f = 0; f < F; f++) any ||= isOpen(f, core);
    if (any) for (let f = 0; f < F; f++) mark(f, core);
  };
  // Through gone partitions, until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    coreRule();
    for (let f = 0; f < F; f++) {
      for (const q of ip.partitions) {
        const a = roomOf(q.cellA);
        const b = roomOf(q.cellB);
        if (a < 0 || b < 0 || isOpen(f, a) === isOpen(f, b)) continue;
        if (lv(partitionKey(f, q.dir, q.i, q.j)) >= 0) continue;
        mark(f, a);
        mark(f, b);
        changed = true;
      }
    }
  }
  // One step through doors.
  const before = open.slice();
  for (let f = 0; f < F; f++) {
    for (const q of ip.partitions) {
      if (!q.door) continue;
      const a = roomOf(q.cellA);
      const b = roomOf(q.cellB);
      if (a < 0 || b < 0) continue;
      if (before[f * nR + a]) mark(f, b);
      if (before[f * nR + b]) mark(f, a);
    }
  }
  coreRule();
  return open;
}

/** Top slab level: the slab under the roof space of a pitched roof, else the last floor slab. */
export const topSlab = (p: StructurePlan): number => (p.flat ? p.floors - 1 : p.floors);

/** The stair hole of slab `f` in the core cell (box frame), or null. */
function stairHole(p: StructurePlan, ip: InteriorPlan, f: number): FrameRect | null {
  const core = ip.core;
  if (!core || f < 1 || f > p.floors - 1) return null;
  const g = stairGeometry(p, ip);
  if (!g) return null;
  const r = core.rect;
  if (core.alongS) return core.startLow ? { s0: r.s0 + g.ls, s1: r.s1, t0: r.t0, t1: r.t1 } : { s0: r.s0, s1: r.s1 - g.ls, t0: r.t0, t1: r.t1 };
  return core.startLow ? { s0: r.s0, s1: r.s1, t0: r.t0 + g.ls, t1: r.t1 } : { s0: r.s0, s1: r.s1, t0: r.t0, t1: r.t1 - g.ls };
}

/** Shared stair dimensions of all storeys: tread, start landing length, flight A side. */
function stairGeometry(p: StructurePlan, ip: InteriorPlan): { tread: number; ls: number; aLow: boolean } | null {
  const core = ip.core;
  if (!core) return null;
  const D = INTERIOR_DIM;
  const r = core.rect;
  const L = core.alongS ? r.s1 - r.s0 : r.t1 - r.t0;
  let nAmax = 1;
  for (let f = 0; f + 1 < p.floors; f++) {
    const n = Math.max(2, Math.ceil((ip.floorY[f + 1]! - ip.floorY[f]!) / D.stairRise - 1e-6));
    nAmax = Math.max(nAmax, Math.ceil(n / 2));
  }
  const tread = Math.max(0.12, Math.min(D.treadMax, (L - 2 * D.landingMin) / nAmax));
  const ls = Math.max(0.5, (L - nAmax * tread) / 2);
  return { tread, ls, aLow: unit(hashInts(p.b.hash, 0x5374)) < 0.5 };
}

// --- Description ----------------------------------------------------------------------------------------------------

export interface InteriorDescribeContext {
  add: (key: number, role: PartRole, material: number, massKg: number, pc: StructurePart['piece'], flags: number, maxSpan: number) => void;
  bond: (a: number, b: number, bearing: boolean, x: number, y: number, z: number, area: number) => void;
  piece: (xz: number[], y0: number, y1: number) => StructurePart['piece'];
  foundation: number;
  wallT: number;
}

/** Convex hull (x, z pairs) of points. */
function hull(pts: number[]): number[] {
  const ps: [number, number][] = [];
  for (let k = 0; k < pts.length; k += 2) ps.push([pts[k]!, pts[k + 1]!]);
  ps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (ps.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of ps) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let k = ps.length - 1; k >= 0; k--) {
    const q = ps[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}

/** Seg endpoints in world x, z. */
function segXZ(ip: InteriorPlan, sg: PartitionSeg): [number, number, number, number] {
  const fr = ip.frame;
  return [frameX(fr, sg.s0, sg.t0), frameZ(fr, sg.s0, sg.t0), frameX(fr, sg.s1, sg.t1), frameZ(fr, sg.s1, sg.t1)];
}

/** Does the key layout hold every interior part of the plan? */
export function interiorFits(p: StructurePlan, ip: InteriorPlan): boolean {
  return slabKey(topSlab(p), ip.sCuts.length, ip.tCuts.length) >= 0 && partitionKey(p.floors, 1, ip.sCuts.length, ip.tCuts.length) >= 0;
}

/** Slabs, partitions and stairs as parts with bonds: slabs rest on the walls and partitions under them. */
export function describeInterior(p: StructurePlan, ip: InteriorPlan, ctx: InteriorDescribeContext): void {
  if (!ip.ok || !interiorFits(p, ip)) return;
  const D = INTERIOR_DIM;
  const nT = ip.tCuts.length - 1;
  const ij = (c: number): [number, number] => [Math.floor(c / nT), c % nT];
  const slab = (f: number, c: number): number => {
    const [i, j] = ij(c);
    return slabKey(f, i, j);
  };
  const live = (c: number): boolean => ip.cells[c]!.area > 0;
  const top = topSlab(p);
  const links = cellLinks(ip);

  // Slabs.
  for (let f = 1; f <= top; f++) {
    const y1 = ip.floorY[f]!;
    ip.cells.forEach((cell, c) => {
      if (!live(c)) return;
      const pts = hull(cell.polys.flat());
      ctx.add(slab(f, c), PART_ROLE.span, INTERIOR_MATERIAL.floor, cell.area * D.slab * 2400, ctx.piece(pts, y1 - D.slab, y1), PART_FLAG.inner, 1);
    });
    for (const l of links) {
      const [x0, z0, x1, z1] = l.segs[0]!;
      ctx.bond(slab(f, l.a), slab(f, l.b), false, (x0 + x1) / 2, y1 - D.slab / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) * D.slab);
    }
    // On the outer walls of the storey below: three points per bay just inside the wall.
    for (const e of p.edges) {
      for (let c = 0; c < e.cols; c++) {
        const bay = bayKey(PART_RULE.wall, e.ring, e.i, c, f - 1);
        for (const sm of [0.2, 0.5, 0.8]) {
          const u = (c + sm) * e.colW;
          const x = e.ax + e.dx * u - e.nx * (ctx.wallT + 0.4);
          const z = e.az + e.dz * u - e.nz * (ctx.wallT + 0.4);
          const cc = cellAt(ip, x, z);
          if (cc >= 0 && live(cc)) ctx.bond(bay, slab(f, cc), true, x, y1 - D.slab, z, e.colW * ctx.wallT);
        }
      }
    }
  }

  // Partitions: rest on the slab cells on both sides (or the ground) and carry nothing: they are not load-bearing,
  // so a slab whose outer walls are gone falls even with partitions under it, and takes the partitions on it along.
  for (let f = 0; f < p.floors; f++) {
    for (const q of ip.partitions) {
      const key = partitionKey(f, q.dir, q.i, q.j);
      const pts: number[] = [];
      let len = 0;
      for (const sg of q.segs) {
        const [x0, z0, x1, z1] = segXZ(ip, sg);
        const l = Math.hypot(x1 - x0, z1 - z0) || 1;
        len += l;
        const ox = (-(z1 - z0) / l) * (D.partition / 2);
        const oz = ((x1 - x0) / l) * (D.partition / 2);
        pts.push(x0 + ox, z0 + oz, x0 - ox, z0 - oz, x1 + ox, z1 + oz, x1 - ox, z1 - oz);
      }
      const y0 = ip.floorY[f]!;
      const y1 = ip.ceilY[f]!;
      ctx.add(key, PART_ROLE.bearing, INTERIOR_MATERIAL.partition, len * (y1 - y0) * D.partition * 1500, ctx.piece(hull(pts), y0, y1), PART_FLAG.inner, 0);
      const [mx0, mz0, mx1, mz1] = segXZ(ip, q.segs[0]!);
      const mx = (mx0 + mx1) / 2;
      const mz = (mz0 + mz1) / 2;
      const area = len * D.partition;
      if (f === 0) ctx.bond(ctx.foundation, key, true, mx, y0, mz, area);
      else for (const c of [q.cellA, q.cellB]) ctx.bond(slab(f, c), key, true, mx, y0, mz, area / 2);
    }
  }

  // Stairs: one flight pair per storey, resting on the core cell's floor.
  const core = ip.core;
  if (core) {
    const r = core.rect;
    const corners = [frameX(ip.frame, r.s0, r.t0), frameZ(ip.frame, r.s0, r.t0), frameX(ip.frame, r.s1, r.t0), frameZ(ip.frame, r.s1, r.t0), frameX(ip.frame, r.s1, r.t1), frameZ(ip.frame, r.s1, r.t1), frameX(ip.frame, r.s0, r.t1), frameZ(ip.frame, r.s0, r.t1)];
    const cx = frameX(ip.frame, (r.s0 + r.s1) / 2, (r.t0 + r.t1) / 2);
    const cz = frameZ(ip.frame, (r.s0 + r.s1) / 2, (r.t0 + r.t1) / 2);
    const area = (r.s1 - r.s0) * (r.t1 - r.t0);
    for (let f = 0; f + 1 < p.floors; f++) {
      const key = stairKey(f);
      const y0 = ip.floorY[f]!;
      const y1 = ip.floorY[f + 1]!;
      ctx.add(key, PART_ROLE.fixture, INTERIOR_MATERIAL.floor, area * 0.25 * 2400, ctx.piece(corners, y0, y1), PART_FLAG.inner, 0);
      ctx.bond(f === 0 ? ctx.foundation : slab(f, core.cell), key, true, cx, y0, cz, area);
    }
  }
}

// --- Emission -------------------------------------------------------------------------------------------------------

export interface InteriorEmitContext {
  /** Damage level written into the vertices for a part (0–2), or -1 when the part is gone. */
  level: (key: number) => number;
  /** Open rooms per storey, from `interiorExposure`. */
  open: Uint8Array;
  /** Is the outer wall bay (edge, column, storey) gone? */
  bayGone: (e: Edge, c: number, f: number) => boolean;
  wallT: number;
}

/** Writes slabs, partitions and stairs of a damaged structure. */
export function emitInterior(w: VertexWriter, p: StructurePlan, ip: InteriorPlan, paint: InteriorPaint, ctx: InteriorEmitContext): void {
  if (!ip.ok) return;
  const D = INTERIOR_DIM;
  const fits = interiorFits(p, ip);
  const lv = (key: number): number => (fits ? ctx.level(key) : 0);
  const fr = ip.frame;
  const nT = ip.tCuts.length - 1;
  const ij = (c: number): [number, number] => [Math.floor(c / nT), c % nT];
  const top = topSlab(p);
  const live = (c: number): boolean => ip.cells[c]!.area > 0;
  const slabLevel = (f: number, c: number): number => {
    if (f === 0) return 0;
    const [i, j] = ij(c);
    return lv(slabKey(f, i, j));
  };
  const links = cellLinks(ip);
  const nR = ip.rooms.length;
  const isOpen = (f: number, r: number): boolean => r >= 0 && f >= 0 && ctx.open[f * nR + r] === 1;
  const piecesOf = new Map<number, WallPiece[]>();
  for (const pc of wallPieces(p, ip)) {
    const list = piecesOf.get(pc.cell);
    if (list) list.push(pc);
    else piecesOf.set(pc.cell, [pc]);
  }
  const down: Vec3 = [0, -1, 0];
  const up: Vec3 = [0, 1, 0];

  // --- Slabs: floor on top, ceiling of the storey below underneath, cut edges where a neighbour is gone.
  for (let f = 0; f <= top; f++) {
    const yTop = ip.floorY[f]!;
    const yBot = yTop - D.slab;
    const hole = stairHole(p, ip, f);
    const atticLevel = f >= p.floors;
    ip.cells.forEach((cell, c) => {
      if (!live(c)) return;
      const level = slabLevel(f, c);
      if (level < 0) return;
      const room = cell.room;
      const showTop = isOpen(f, room);
      const showBottom = f > 0 && isOpen(f - 1, room);
      if (!showTop && !showBottom) return;
      const floorFa = paint.attr(room, f, atticLevel ? FINISH.atticFloor : FINISH.floor);
      const ceilFa = f > 0 ? paint.attr(room, f - 1, FINISH.ceiling) : null;
      const hTop = atticLevel ? 3 : ip.ceilY[f]! - yTop;
      const hBelow = f > 0 ? ip.ceilY[f - 1]! - ip.floorY[f - 1]! : 0;
      for (const poly of cell.polys) {
        let pieces: number[][][] = [];
        const st: number[][] = [];
        for (let k = 0; k < poly.length; k += 2) st.push([frameS(fr, poly[k]!, poly[k + 1]!), frameT(fr, poly[k]!, poly[k + 1]!)]);
        if (hole && c === ip.core!.cell) {
          const big = 1e5;
          for (const r of [
            { s0: -big, s1: hole.s0, t0: -big, t1: big },
            { s0: hole.s1, s1: big, t0: -big, t1: big },
            { s0: hole.s0, s1: hole.s1, t0: -big, t1: hole.t0 },
            { s0: hole.s0, s1: hole.s1, t0: hole.t1, t1: big },
          ]) {
            const q = clipToRect(st, r);
            if (q.length >= 3) pieces.push(q);
          }
        } else pieces = [st];
        for (const q of pieces) {
          const pts = (y: number): Vec3[] => q.map((v) => [frameX(fr, v[0]!, v[1]!), y, frameZ(fr, v[0]!, v[1]!)]);
          const uv = q.map((v) => [v[0]!, v[1]!] as [number, number]);
          if (showTop) polyOut(w, p, pts(yTop), uv, up, level, hTop, paint.hash(room), floorFa);
          if (ceilFa && showBottom) polyOut(w, p, pts(yBot), uv, down, level, hBelow, paint.hash(room), ceilFa);
        }
      }
      if (f === 0) return;
      const edgeFa = paint.attr(room, f, FINISH.concrete);
      const edge = (x0: number, z0: number, x1: number, z1: number, n: Vec3): void => wallQuad(w, p, x0, z0, x1, z1, yBot, yTop, n, 0, yBot, level, 1, paint.hash(room), edgeFa);
      // Hole edges, facing into the hole.
      if (hole && c === ip.core!.cell) {
        const P = (s: number, t: number): [number, number] => [frameX(fr, s, t), frameZ(fr, s, t)];
        const sx: Vec3 = [fr.ux, 0, fr.uz];
        const tx: Vec3 = [-fr.uz, 0, fr.ux];
        const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
        const e4: [[number, number], [number, number], Vec3][] = [
          [P(hole.s0, hole.t0), P(hole.s0, hole.t1), sx],
          [P(hole.s1, hole.t0), P(hole.s1, hole.t1), neg(sx)],
          [P(hole.s0, hole.t0), P(hole.s1, hole.t0), tx],
          [P(hole.s0, hole.t1), P(hole.s1, hole.t1), neg(tx)],
        ];
        for (const [a, b, n] of e4) edge(a[0], a[1], b[0], b[1], n);
      }
      // Cut edges towards gone neighbours.
      for (const l of links) {
        if (l.a !== c && l.b !== c) continue;
        const other = l.a === c ? l.b : l.a;
        if (slabLevel(f, other) >= 0) continue;
        const sign = l.a === c ? 1 : -1;
        const n: Vec3 = l.dir === 0 ? [fr.ux * sign, 0, fr.uz * sign] : [-fr.uz * sign, 0, fr.ux * sign];
        for (const [x0, z0, x1, z1] of l.segs) edge(x0, z0, x1, z1, n);
      }
      // Edge along the outer wall where the bay in front of the slab is gone.
      for (const pc of piecesOf.get(c) ?? []) {
        const e = pc.e;
        const ua = Math.min(pc.u0, pc.u1);
        const ub = Math.max(pc.u0, pc.u1);
        for (let col = Math.max(0, Math.floor(ua / e.colW)); col < e.cols && col * e.colW < ub; col++) {
          if (!ctx.bayGone(e, col, f - 1) && !(f < p.floors && ctx.bayGone(e, col, f))) continue;
          const c0 = Math.max(ua, col * e.colW);
          const c1 = Math.min(ub, (col + 1) * e.colW);
          if (c1 - c0 < 1e-3) continue;
          const ta = (c0 - pc.u0) / (pc.u1 - pc.u0 || 1);
          const tb = (c1 - pc.u0) / (pc.u1 - pc.u0 || 1);
          edge(pc.x0 + (pc.x1 - pc.x0) * ta, pc.z0 + (pc.z1 - pc.z0) * ta, pc.x0 + (pc.x1 - pc.x0) * tb, pc.z0 + (pc.z1 - pc.z0) * tb, [e.nx, 0, e.nz]);
        }
      }
    });
  }

  // --- Partitions.
  for (let f = 0; f < p.floors; f++) {
    const y0 = ip.floorY[f]!;
    const y1 = ip.ceilY[f]!;
    const h = y1 - y0;
    for (const q of ip.partitions) {
      const sideA = isOpen(f, ip.cells[q.cellA]!.room);
      const sideB = isOpen(f, ip.cells[q.cellB]!.room);
      if (!sideA && !sideB) continue;
      const level = lv(partitionKey(f, q.dir, q.i, q.j));
      if (level < 0) continue;
      partition(w, p, ip, paint, q, f, y0, y1, h, level, sideA, sideB);
    }
  }

  // --- Stairs.
  const core = ip.core;
  const g = stairGeometry(p, ip);
  if (core && g) {
    const r = core.rect;
    const a0 = core.alongS ? r.s0 : r.t0;
    const a1 = core.alongS ? r.s1 : r.t1;
    const b0 = core.alongS ? r.t0 : r.s0;
    const b1 = core.alongS ? r.t1 : r.s1;
    const L = a1 - a0;
    const bm = (b0 + b1) / 2;
    const gap = D.flightGap / 2;
    // Along-axis position from the start end.
    const A = (d: number): number => (core.startLow ? a0 + d : a1 - d);
    const room = ip.cells[core.cell]!.room;
    const fa = (f: number): WallAttr => paint.attr(room, f, FINISH.stair);
    const [bA0, bA1, bB0, bB1] = g.aLow ? [b0, bm - gap, bm + gap, b1] : [bm + gap, b1, b0, bm - gap];
    for (let f = 0; f + 1 < p.floors; f++) {
      if (!isOpen(f, room)) continue;
      const level = lv(stairKey(f));
      if (level < 0) continue;
      const yf = ip.floorY[f]!;
      const H = ip.floorY[f + 1]! - yf;
      const n = Math.max(2, Math.ceil(H / D.stairRise - 1e-6));
      const rise = H / n;
      const nA = Math.ceil(n / 2);
      const nB = n - nA;
      const s2 = ip.ceilY[f]! - yf;
      const s3 = paint.hash(room);
      const box = (d0: number, d1: number, ba: number, bb: number, ya: number, yb: number): void => {
        const x0 = Math.min(A(d0), A(d1));
        const x1 = Math.max(A(d0), A(d1));
        frameBox(w, p, ip, core.alongS, x0, x1, ba, bb, ya, yb, yf, level, s2, s3, fa(f), true);
      };
      // Flight A up to the landing at the far end.
      for (let k = 0; k + 1 < nA; k++) {
        const t = yf + (k + 1) * rise;
        box(g.ls + k * g.tread, g.ls + (k + 1) * g.tread, bA0, bA1, Math.max(yf, t - rise - 0.16), t);
      }
      const yl = yf + nA * rise;
      box(g.ls + (nA - 1) * g.tread, L, b0, b1, yl - 0.2, yl);
      // Flight B back to the start end, arriving on the slab above.
      const lb = g.ls + (nA - 1) * g.tread;
      for (let k = 0; k < nB - 1; k++) {
        const t = yl + (k + 1) * rise;
        const dEnd = k === nB - 2 ? g.ls : lb - (k + 1) * g.tread;
        box(Math.min(dEnd, lb - (k + 1) * g.tread), lb - k * g.tread, bB0, bB1, t - rise - 0.16, t);
      }
    }
  }
}

/** Clips the segment a–b (frame s, t) to a rectangle; null when nothing is left. */
function clipSeg(a: number[], b: number[], r: FrameRect): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const d = [b[0]! - a[0]!, b[1]! - a[1]!];
  const lims: [number, number, number][] = [
    [0, r.s0, 1],
    [0, r.s1, -1],
    [1, r.t0, 1],
    [1, r.t1, -1],
  ];
  for (const [ax, lim, sign] of lims) {
    const p0 = sign * (a[ax]! - lim);
    const dp = sign * d[ax]!;
    if (Math.abs(dp) < 1e-12) {
      if (p0 < -1e-6) return null;
      continue;
    }
    const t = -p0 / dp;
    if (dp > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  if (t1 - t0 < 1e-6) return null;
  return [a[0]! + d[0]! * t0, a[1]! + d[1]! * t0, a[0]! + d[0]! * t1, a[1]! + d[1]! * t1];
}

/** One partition in storey f: the painted sides facing open rooms, a door opening with jambs and a soffit, ends and top. */
function partition(w: VertexWriter, p: StructurePlan, ip: InteriorPlan, paint: InteriorPaint, q: InteriorPartition, f: number, y0: number, y1: number, h: number, level: number, sideA: boolean, sideB: boolean): void {
  const D = INTERIOR_DIM;
  const half = D.partition / 2;
  const roomA = ip.cells[q.cellA]!.room;
  const roomB = ip.cells[q.cellB]!.room;
  const faA = paint.attr(roomA, f, FINISH.paint);
  const faB = paint.attr(roomB, f, FINISH.paint);
  q.segs.forEach((sg, k) => {
    const [x0, z0, x1, z1] = segXZ(ip, sg);
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-3) return;
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    // Side normal towards cell B: +s for a cut across, +t for a run along.
    const nB: Vec3 = q.dir === 0 ? [ip.frame.ux, 0, ip.frame.uz] : [-ip.frame.uz, 0, ip.frame.ux];
    const nA: Vec3 = [-nB[0], 0, -nB[2]];
    const at = (d: number, side: number): [number, number] => [x0 + dx * d + nB[0] * half * side, z0 + dz * d + nB[2] * half * side];
    // A door to a room that stays closed is drawn shut: nothing is drawn behind it.
    const door = q.door && q.door.seg === k && sideA && sideB ? q.door : null;
    const spans: [number, number, number][] = door
      ? [
          [0, door.at - door.width / 2, y0],
          [door.at - door.width / 2, door.at + door.width / 2, Math.min(y1, y0 + D.doorHeight)],
          [door.at + door.width / 2, len, y0],
        ]
      : [[0, len, y0]];
    for (const [d0, d1, yb] of spans) {
      if (d1 - d0 < 1e-3 || y1 - yb < 1e-3) continue;
      for (const [side, n, fa, room, shown] of [
        [-1, nA, faA, roomA, sideA],
        [1, nB, faB, roomB, sideB],
      ] as const) {
        if (!shown) continue;
        const [ax, az] = at(d0, side);
        const [bx, bz] = at(d1, side);
        wallQuad(w, p, ax, az, bx, bz, yb, y1, n, d0, y0, level, h, paint.hash(room), fa);
      }
    }
    const capFa = paint.attr(roomA, f, FINISH.paint);
    const cap = (d: number, yb: number, ya: number, n: Vec3): void => {
      const [ax, az] = at(d, -1);
      const [bx, bz] = at(d, 1);
      wallQuad(w, p, ax, az, bx, bz, ya, yb, n, 0, y0, level, h, paint.hash(roomA), capFa);
    };
    const dir: Vec3 = [dx, 0, dz];
    const back: Vec3 = [-dx, 0, -dz];
    if (!sg.wall0) cap(0, y1, y0, back);
    if (!sg.wall1) cap(len, y1, y0, dir);
    if (door) {
      const yd = Math.min(y1, y0 + D.doorHeight);
      cap(door.at - door.width / 2, yd, y0, dir);
      cap(door.at + door.width / 2, yd, y0, back);
      // Soffit of the opening.
      const [a0x, a0z] = at(door.at - door.width / 2, -1);
      const [a1x, a1z] = at(door.at + door.width / 2, -1);
      const [b1x, b1z] = at(door.at + door.width / 2, 1);
      const [b0x, b0z] = at(door.at - door.width / 2, 1);
      polyOut(
        w,
        p,
        [
          [a0x, yd, a0z],
          [a1x, yd, a1z],
          [b1x, yd, b1z],
          [b0x, yd, b0z],
        ],
        [
          [0, 0],
          [door.width, 0],
          [door.width, D.partition],
          [0, D.partition],
        ],
        [0, -1, 0],
        level,
        h,
        paint.hash(roomA),
        capFa,
      );
    }
    // Top, seen where the slab above is gone.
    const [t0x, t0z] = at(0, -1);
    const [t1x, t1z] = at(len, -1);
    const [t2x, t2z] = at(len, 1);
    const [t3x, t3z] = at(0, 1);
    polyOut(
      w,
      p,
      [
        [t0x, y1, t0z],
        [t1x, y1, t1z],
        [t2x, y1, t2z],
        [t3x, y1, t3z],
      ],
      [
        [0, 0],
        [len, 0],
        [len, D.partition],
        [0, D.partition],
      ],
      [0, 1, 0],
      level,
      h,
      paint.hash(roomA),
      paint.attr(roomA, f, FINISH.concrete),
    );
  });
}
