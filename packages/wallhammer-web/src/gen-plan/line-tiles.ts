// An index from the cells of one level of the cube sphere ("tiles") to the lines over the sphere that can reach
// them. A line is listed in every tile that has a point within its reach of any of its segments; more tiles than
// needed are allowed, fewer never. Key of a tile: `face · 4^level + y · 2^level + x`.

import type { CellId } from '../gen-core/cell.ts';
import { gridDirection, gridNeighbours, gridNodeAt, sphereGrid } from './grid.ts';

/** The index: tiles that hold a line, ascending, and per tile its lines, ascending. */
export interface LineTiles {
  level: number;
  /** Keys of the tiles that hold at least one line, ascending. */
  keys: Uint32Array;
  /** Per key + 1: its first entry in `lines`. */
  start: Uint32Array;
  lines: Uint32Array;
}

/** Options of `lineTiles`. */
export interface LineTilesOptions {
  /** Level of the tiles. */
  level: number;
  /** Radius of the sphere the lines lie on, m. */
  radiusM: number;
  /** Per line + 1: its first point. */
  start: ArrayLike<number>;
  /** Unit directions, x y z per point. */
  points: ArrayLike<number>;
  /** Per line: how far from its segments it reaches, m. */
  reachM: ArrayLike<number>;
}

/**
 * Bound on the angle from the middle of a tile to any point of it, in radians, for tiles of `n` across a face. The
 * longest half diagonal is at a corner of the cube, not in the middle of a face: there the cell is a rhombus with a
 * 120° angle, its edges scaled by 2√2/3 against the π/2n of a face's middle, and half its long diagonal tends to
 * 2√2/3 · cos 30° · π/2n ≈ 0.8165 · π/2n. 0.85 keeps a margin above that.
 */
const tileRadius = (n: number): number => (0.85 * Math.PI) / (2 * n);

/** Builds the index of lines `o.start` over `o.points` at tiles of `o.level`. */
export function lineTiles(o: LineTilesOptions): LineTiles {
  const g = sphereGrid(o.radiusM, o.level);
  const lineCount = o.start.length - 1;
  const tr = tileRadius(g.n);
  const nb = new Int32Array(8);
  const c: [number, number, number] = [0, 0, 0];
  const pairs: number[] = [];
  const seen = new Set<number>();
  const visited = new Set<number>();
  const queue: number[] = [];
  for (let line = 0; line < lineCount; line++) {
    seen.clear();
    const p0 = o.start[line]!;
    const p1 = o.start[line + 1]!;
    const reach = o.reachM[line]!;
    if (p1 <= p0) continue;
    for (let p = p0; p < Math.max(p0 + 1, p1 - 1); p++) {
      // The segment from point p to p + 1 (a single point when the line has one).
      const q = Math.min(p + 1, p1 - 1);
      const ax = o.points[3 * p]!;
      const ay = o.points[3 * p + 1]!;
      const az = o.points[3 * p + 2]!;
      const bx = o.points[3 * q]!;
      const by = o.points[3 * q + 1]!;
      const bz = o.points[3 * q + 2]!;
      let mx = ax + bx;
      let my = ay + by;
      let mz = az + bz;
      const ml = Math.sqrt(mx * mx + my * my + mz * mz);
      mx /= ml;
      my /= ml;
      mz /= ml;
      const ex = ax - bx;
      const ey = ay - by;
      const ez = az - bz;
      const half = 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez);
      // Every point within the reach of the segment lies within this angle of its middle (chord ≤ arc, with margin).
      const limit = (reach + 2) / o.radiusM + 1.01 * half + tr;
      const limit2 = limit * limit;
      visited.clear();
      queue.length = 0;
      const first = gridNodeAt(g, mx, my, mz);
      visited.add(first);
      queue.push(first);
      while (queue.length > 0) {
        const t = queue.pop()!;
        if (!seen.has(t)) {
          seen.add(t);
          pairs.push(t, line);
        }
        const k = gridNeighbours(g, t, nb);
        for (let j = 0; j < k; j++) {
          const u = nb[j]!;
          if (visited.has(u)) continue;
          visited.add(u);
          gridDirection(g, u, c);
          const dx = c[0] - mx;
          const dy = c[1] - my;
          const dz = c[2] - mz;
          if (dx * dx + dy * dy + dz * dz <= limit2) queue.push(u);
        }
      }
    }
  }
  // Grid nodes and tile keys are the same numbers: face · n² + y · n + x. The pairs were made line by line, so a sort
  // by key that keeps the order of equal keys leaves the lines of a tile ascending.
  const total = pairs.length / 2;
  const tileKey = new Uint32Array(total);
  const tileLine = new Uint32Array(total);
  for (let i = 0; i < total; i++) {
    tileKey[i] = pairs[2 * i]!;
    tileLine[i] = pairs[2 * i + 1]!;
  }
  let lineSpan = 1;
  while (lineSpan <= lineCount) lineSpan *= 2;
  let sorted: ArrayLike<number>;
  if (g.count * lineSpan <= 2 ** 53) {
    // Key and line packed into one exact double: a plain numeric sort.
    const packed = new Float64Array(total);
    for (let i = 0; i < total; i++) packed[i] = tileKey[i]! * lineSpan + tileLine[i]!;
    packed.sort();
    const index = new Uint32Array(total);
    for (let i = 0; i < total; i++) {
      const key = Math.floor(packed[i]! / lineSpan);
      tileKey[i] = key;
      tileLine[i] = packed[i]! - key * lineSpan;
      index[i] = i;
    }
    sorted = index;
  } else {
    const index = Array.from({ length: total }, (_, i) => i);
    index.sort((a, b) => tileKey[a]! - tileKey[b]! || a - b);
    sorted = index;
  }
  const keys: number[] = [];
  const start: number[] = [];
  const lines = new Uint32Array(total);
  for (let i = 0; i < total; i++) {
    const j = sorted[i]!;
    const key = tileKey[j]!;
    if (keys.length === 0 || keys[keys.length - 1] !== key) {
      keys.push(key);
      start.push(i);
    }
    lines[i] = tileLine[j]!;
  }
  start.push(total);
  return { level: o.level, keys: Uint32Array.from(keys), start: Uint32Array.from(start), lines };
}

/** Index in `t.keys` of `key`, or −1. */
function findKey(t: LineTiles, key: number): number {
  let lo = 0;
  let hi = t.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t.keys[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo < t.keys.length && t.keys[lo] === key ? lo : -1;
}

/** The lines of the tile that holds the direction (x, y, z), as a range of `t.lines`; null when the tile holds none. */
export function tileLinesAt(t: LineTiles, x: number, y: number, z: number): { from: number; to: number } | null {
  const key = gridNodeAt(sphereGrid(1, t.level), x, y, z);
  const k = findKey(t, key);
  return k < 0 ? null : { from: t.start[k]!, to: t.start[k + 1]! };
}

/**
 * The lines that can reach a cell of the cube sphere, ascending and each once: those of the tile that holds it when it
 * is as fine as the tiles or finer, else those of every tile under it. Clears `out` and returns it.
 */
export function tileLinesOfCell(t: LineTiles, cell: CellId, out: number[]): number[] {
  out.length = 0;
  const n = 2 ** t.level;
  const base = cell.face * n * n;
  if (cell.level >= t.level) {
    const shift = 2 ** (cell.level - t.level);
    const k = findKey(t, base + Math.floor(cell.y / shift) * n + Math.floor(cell.x / shift));
    if (k >= 0) for (let i = t.start[k]!; i < t.start[k + 1]!; i++) out.push(t.lines[i]!);
    return out;
  }
  const span = 2 ** (t.level - cell.level);
  const x0 = cell.x * span;
  const y0 = cell.y * span;
  for (let y = y0; y < y0 + span; y++) {
    const row = base + y * n;
    // The first key of this row inside the cell, then on while the keys stay inside it.
    let lo = 0;
    let hi = t.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.keys[mid]! < row + x0) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < t.keys.length && t.keys[k]! < row + x0 + span; k++) {
      for (let i = t.start[k]!; i < t.start[k + 1]!; i++) out.push(t.lines[i]!);
    }
  }
  out.sort((a, b) => a - b);
  let w = 0;
  for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[w - 1]) out[w++] = out[i]!;
  out.length = w;
  return out;
}
