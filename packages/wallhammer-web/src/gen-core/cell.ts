// Cell identity and world shape (Wallhammer Zero CONVENTIONS §2–§3, `eng_cell_id` and the world shape port).
//
// A cell id is the 64-bit number `[face:3][level:5][x:28][y:28]`. In JavaScript it is a small frozen object with
// four integers, because a plain number holds only 53 bits exactly and a BigInt is slow to hash and compare. Two exact
// encodings exist next to it: the text key `face/level/x/y` (map key, log, file names; x and y without the offset) and
// the 64-bit value as two unsigned 32-bit halves (`cellBits`, for files and hashes).
//
// This engine is y-up: the map is the XZ plane, x east, z south. A cell's `x` index runs along +x and its `y` index
// along +z. The authoritative position is a double; cell data are floats relative to the cell origin, and only
// differences of doubles near the camera ever become floats.

import type { MeshData, InstanceData } from '../base/data.ts';
import type { Vec3 } from '../base/math.ts';
import { hashString } from './hash.ts';

/** Face of a flat world (0–5 are reserved for the faces of a cube-sphere, 6 is reserved). */
export const FACE_FLAT = 7;
/** Offset that makes negative grid coordinates unsigned in the 28-bit fields. */
const XY_OFFSET = 2 ** 27;
const XY_MASK = 2 ** 28 - 1;
/** Edge of the root tile of a flat world (level 0). */
export const FLAT_ROOT_EDGE_M = 65536;
/** Named levels of a flat world: region 4,096 m, district 1,024 m, streaming cell 256 m. */
export const LEVEL = { region: 4, district: 6, cell: 8 } as const;

export interface CellId {
  readonly face: number;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

export function cellId(face: number, level: number, x: number, y: number): CellId {
  if (!(face >= 0 && face <= 7 && level >= 0 && level <= 31) || x < -XY_OFFSET || x >= XY_OFFSET || y < -XY_OFFSET || y >= XY_OFFSET) {
    throw new Error(`cell id out of range: ${face}/${level}/${x}/${y}`);
  }
  return Object.freeze({ face, level, x: x | 0, y: y | 0 });
}

/** Text form `face/level/x/y`, coordinates without the offset (for example `7/8/12/-3`). Exact and usable as a map key. */
export function cellKey(c: CellId): string {
  return `${c.face}/${c.level}/${c.x}/${c.y}`;
}

export function parseCellKey(key: string): CellId {
  const p = key.split('/').map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isInteger(v))) throw new Error(`not a cell key: ${key}`);
  return cellId(p[0]!, p[1]!, p[2]!, p[3]!);
}

/** The 64-bit id as unsigned 32-bit halves [high, low]. */
export function cellBits(c: CellId): [number, number] {
  const X = c.x + XY_OFFSET;
  const Y = c.y + XY_OFFSET;
  const hi = ((c.face << 29) | (c.level << 24) | Math.floor(X / 16)) >>> 0;
  const lo = (((X & 15) << 28) | Y) >>> 0;
  return [hi, lo];
}

export function cellFromBits(hi: number, lo: number): CellId {
  const face = hi >>> 29;
  const level = (hi >>> 24) & 31;
  const X = (hi & 0xffffff) * 16 + (lo >>> 28);
  const Y = lo & XY_MASK;
  return cellId(face, level, X - XY_OFFSET, Y - XY_OFFSET);
}

export function sameCell(a: CellId, b: CellId): boolean {
  return a.face === b.face && a.level === b.level && a.x === b.x && a.y === b.y;
}

/** Total order: level, then y, then x. Used wherever a deterministic order of cells is needed. */
export function compareCells(a: CellId, b: CellId): number {
  return a.face - b.face || a.level - b.level || a.y - b.y || a.x - b.x;
}

/** World position in metres, double precision: x east, y up, z south. */
export type WorldPos = readonly [number, number, number];

/** Axis-aligned box in cell-local metres (floats relative to the cell origin). */
export interface LocalBounds {
  min: Vec3;
  max: Vec3;
}

/**
 * The world shape port: everything that differs between a flat world and a planet. Only the flat implementation
 * exists; code above it asks the port for cell sizes, distances, origins and "up" instead of assuming them.
 */
export interface WorldShape {
  readonly name: string;
  /** Edge of a cell of this level in metres. Cell size is a query, never an engine constant. */
  edgeM(level: number): number;
  /** Cell of the given level that contains a world position. */
  cellAt(p: WorldPos, level: number): CellId;
  /** Origin of the cell frame in world metres (double). Cell data are relative to it. */
  origin(c: CellId): WorldPos;
  /** Position relative to the cell origin, rounded to float. */
  toLocal(c: CellId, p: WorldPos): Vec3;
  /** World position of a cell-local point (double). */
  toWorld(c: CellId, local: readonly [number, number, number]): WorldPos;
  /**
   * Distance along the surface from the point below (or above) a world position to the cell's footprint, 0 inside it.
   * The height of the position above the surface is not part of it; streaming adds it as the ticket's altitude.
   */
  distanceM(c: CellId, p: WorldPos): number;
  /** Middle of the cell's footprint on the base surface (world metres, double). */
  center(c: CellId): WorldPos;
  /**
   * Cells of `level` whose footprint may lie within `reachM` (measured as `distanceM`) of a world position, in a fixed
   * order. A superset is fine: the caller tests every cell with `distanceM`. Streaming finds its coarsest cells here.
   */
  cellsNear(p: WorldPos, reachM: number, level: number): CellId[];
  /** Cells sharing an edge or a corner, in a fixed order. */
  neighbours(c: CellId): CellId[];
  /** Cell one level coarser that contains this one, or null at the root. */
  parent(c: CellId): CellId | null;
  /** The cells one level finer that cover this one, in a fixed order. */
  children(c: CellId): CellId[];
  /** Unit "up" at a world position. */
  upAt(p: WorldPos): Vec3;
  /** Coordinates that seamless noise is evaluated at (a flat world returns x, z, 0). */
  noiseDomain(p: WorldPos): [number, number, number];
  /** Short text that identifies the shape and its parameters (enters cache keys and file headers). */
  readonly hashKey: string;
}

/** A flat, unbounded world on the XZ plane with a quadtree of square cells. */
export class FlatWorld implements WorldShape {
  readonly name = 'flat';
  readonly rootEdgeM: number;
  readonly hashKey: string;

  constructor(rootEdgeM: number = FLAT_ROOT_EDGE_M) {
    this.rootEdgeM = rootEdgeM;
    this.hashKey = `flat:${rootEdgeM}`;
  }

  edgeM(level: number): number {
    // A power-of-two division: exact.
    return this.rootEdgeM / 2 ** level;
  }

  cellAt(p: WorldPos, level: number): CellId {
    const e = this.edgeM(level);
    return cellId(FACE_FLAT, level, Math.floor(p[0] / e), Math.floor(p[2] / e));
  }

  origin(c: CellId): WorldPos {
    const e = this.edgeM(c.level);
    return [c.x * e, 0, c.y * e];
  }

  toLocal(c: CellId, p: WorldPos): Vec3 {
    const o = this.origin(c);
    return [Math.fround(p[0] - o[0]), Math.fround(p[1] - o[1]), Math.fround(p[2] - o[2])];
  }

  toWorld(c: CellId, local: readonly [number, number, number]): WorldPos {
    const o = this.origin(c);
    return [o[0] + local[0], o[1] + local[1], o[2] + local[2]];
  }

  distanceM(c: CellId, p: WorldPos): number {
    const e = this.edgeM(c.level);
    const x0 = c.x * e;
    const z0 = c.y * e;
    const dx = p[0] < x0 ? x0 - p[0] : p[0] > x0 + e ? p[0] - x0 - e : 0;
    const dz = p[2] < z0 ? z0 - p[2] : p[2] > z0 + e ? p[2] - z0 - e : 0;
    return Math.sqrt(dx * dx + dz * dz);
  }

  center(c: CellId): WorldPos {
    const e = this.edgeM(c.level);
    return [c.x * e + e / 2, 0, c.y * e + e / 2];
  }

  cellsNear(p: WorldPos, reachM: number, level: number): CellId[] {
    const lo = this.cellAt([p[0] - reachM, 0, p[2] - reachM], level);
    const hi = this.cellAt([p[0] + reachM, 0, p[2] + reachM], level);
    const out: CellId[] = [];
    for (let y = lo.y; y <= hi.y; y++) for (let x = lo.x; x <= hi.x; x++) out.push(cellId(FACE_FLAT, level, x, y));
    return out;
  }

  neighbours(c: CellId): CellId[] {
    const out: CellId[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0) out.push(cellId(c.face, c.level, c.x + dx, c.y + dy));
    return out;
  }

  parent(c: CellId): CellId | null {
    if (c.level === 0) return null;
    return cellId(c.face, c.level - 1, Math.floor(c.x / 2), Math.floor(c.y / 2));
  }

  children(c: CellId): CellId[] {
    const l = c.level + 1;
    const x = c.x * 2;
    const y = c.y * 2;
    return [cellId(c.face, l, x, y), cellId(c.face, l, x + 1, y), cellId(c.face, l, x, y + 1), cellId(c.face, l, x + 1, y + 1)];
  }

  upAt(): Vec3 {
    return [0, 1, 0];
  }

  noiseDomain(p: WorldPos): [number, number, number] {
    return [p[0], p[2], 0];
  }
}

/**
 * The shape's `hashKey` as an unsigned 32-bit number, never 0. It is written into shaped cell files and into their
 * path, so cells built for one shape (or one radius, or one root edge) are never read as cells of another.
 */
export function shapeHash(shape: Pick<WorldShape, 'hashKey'>): number {
  return hashString(shape.hashKey) || 1;
}

/** One mesh of a cell, drawn with a material the application registered under this name. */
export interface CellMesh {
  material: string;
  mesh: MeshData;
}

/** Instances of one archetype (a shared shape with its level-of-detail chain) placed in a cell. */
export interface CellInstances {
  archetype: string;
  /** Positions relative to the cell origin. */
  data: InstanceData;
  /** Stable 64-bit object ids from the input-space anchor, as [high, low] pairs, one pair per instance. */
  ids: Uint32Array;
}

/**
 * What a cell holds once it is MESHED: meshes and instances as plain data, relative to the cell origin, and their
 * extent. A generator and a pre-baked file produce exactly this, byte for byte.
 */
export interface CellContent {
  cell: CellId;
  /** Version of the generator domain the cell was built with. */
  domainVersion: number;
  bounds: LocalBounds;
  meshes: CellMesh[];
  instances: CellInstances[];
  /**
   * `shapeHash` of the world shape the cell was built for. Optional: a cell that states it (or `error`) is encoded in
   * format 2, a cell without both keeps format 1 and its bytes.
   */
  shapeHash?: number;
  /**
   * Largest distance in metres between this cell's surface and the surface its children would show (an estimate is
   * fine). Streaming by screen-space error skips the split of a cell whose error is too small to see.
   */
  error?: number;
}

/** Bytes of the typed arrays a cell holds. */
export function cellContentBytes(c: CellContent): number {
  let n = 0;
  for (const m of c.meshes) n += m.mesh.vertices.byteLength + (m.mesh.indices?.byteLength ?? 0);
  for (const i of c.instances) n += i.data.data.byteLength + i.ids.byteLength;
  return n;
}
