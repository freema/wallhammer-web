// One water surface for the sea, the lakes and the lines of running water together, chunked like the ground. Pure
// data from a `Field`; it knows nothing of the material that draws it (water-material.ts).
//
// The water has no shape of its own: a point is wet when its ground lies under the level that may stand there.
//   - A grid cell is drawn when at least one of its corners is wet (`water > ground + WET_M`).
//   - A wet vertex lies at its level. A dry vertex of a drawn cell lies at the highest level among its wet
//     8-neighbours, so the sheet runs on level under the bank and the ground mesh itself cuts the shoreline. At a fall
//     the cell between an upper and a lower wet vertex becomes the falling sheet.
//   - Beyond the square one large frame of quads at height 0 is the open sea.
//
// Vertex layout (`WATER_LAYOUT`, 28 bytes, locations in `WATER_ATTRIBS`):
//   a_pos    3× f32  world position, metres
//   a_water  3× f32  x depth (level − ground, metres; on a dry vertex the sheet's height − ground, at most −0.01),
//                    y, z the direction the water runs (unit; 0, 0 in standing water)
//   a_kind   4× u8   x body (0 sea, 1 lake, 2 line), y 1 on a fall, z how near the foot of a fall the water is
//                    (255 at the foot, fading over some twenty metres of the pool below), w unused (read as floats,
//                    not normalized)

import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import type { Field } from './field.ts';
import { CHUNK_CELLS, SEA_FLOOR_M, SEA_REACH_M } from './ground-mesh.ts';

export const WATER_LAYOUT: VertexLayout = {
  stride: 28,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_water', size: 3, type: 'f32', offset: 12 },
    { name: 'a_kind', size: 4, type: 'u8', offset: 24 },
  ],
};
export const WATER_ATTRIBS = { a_pos: 0, a_water: 1, a_kind: 2 } as const;

/** A point is wet when its level stands this far over its ground, metres. */
export const WET_M = 0.01;

export interface WaterPiece {
  data: MeshData;
  min: [number, number, number];
  max: [number, number, number];
}

const STRIDE = WATER_LAYOUT.stride;

function put(view: DataView, v: number, x: number, y: number, z: number, depth: number, fx: number, fz: number, body: number, fall: number, churn = 0): void {
  const o = v * STRIDE;
  view.setFloat32(o, x, true);
  view.setFloat32(o + 4, y, true);
  view.setFloat32(o + 8, z, true);
  view.setFloat32(o + 12, depth, true);
  view.setFloat32(o + 16, fx, true);
  view.setFloat32(o + 20, fz, true);
  view.setUint8(o + 24, body);
  view.setUint8(o + 25, fall);
  view.setUint8(o + 26, Math.round(255 * churn));
}

/** A step of the level counts as a fall's foot from this height on, metres. */
const FOOT_M = 0.3;
/** Rings of vertices the churn of a foot spreads over the pool below, and what is left of it after each. */
const CHURN_ROUNDS = 9;
const CHURN_KEPT = 0.8;

/**
 * Per point 0–1: how near the foot of a fall the water is. 1 where a wet point of a fall has wet water more than
 * `FOOT_M` above it beside it; from there it spreads through wet points that lie no higher, so into the pool and down
 * the stream and never back up over the lip.
 */
function churnOf(f: Field, wet: Uint8Array): Float32Array {
  const { n, water, fall } = f;
  let churn = new Float32Array(n * n);
  const near = (i: number, j: number, each: (q: number) => void): void => {
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const a = i + di;
        const b = j + dj;
        if ((di !== 0 || dj !== 0) && a >= 0 && b >= 0 && a < n && b < n && wet[b * n + a]) each(b * n + a);
      }
  };
  const live: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!wet[k] || !fall[k]) continue;
      near(i, j, (q) => {
        if (water[q]! > water[k]! + FOOT_M) churn[k] = 1;
      });
      if (churn[k]) live.push(k);
    }
  // Only the points around the feet are visited: a round grows the set by one ring.
  let front = live;
  for (let round = 0; round < CHURN_ROUNDS && front.length > 0; round++) {
    const next = Float32Array.from(churn);
    const grown: number[] = [];
    for (const q of front) {
      const v = churn[q]! * CHURN_KEPT;
      near(q % n, Math.floor(q / n), (k) => {
        if (water[k]! <= water[q]! + 1e-3 && v > next[k]!) {
          if (next[k] === 0) grown.push(k);
          next[k] = v;
        }
      });
    }
    churn = next;
    front = grown;
  }
  return churn;
}

/** The water of the square, in chunks of `CHUNK_CELLS` cells; chunks without a wet point are left out. */
export function waterPieces(f: Field): WaterPiece[] {
  const { n, step, x0, z0, ground, water, body, fall, flowX, flowZ } = f;
  const wet = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) wet[k] = water[k]! > ground[k]! + WET_M ? 1 : 0;
  const churn = churnOf(f, wet);
  const pieces: WaterPiece[] = [];
  // Per vertex of the chunk: its index in the chunk's mesh, or −1 while it has none.
  const slot = new Int32Array((CHUNK_CELLS + 1) * (CHUNK_CELLS + 1));
  for (let cj = 0; cj < n - 1; cj += CHUNK_CELLS)
    for (let ci = 0; ci < n - 1; ci += CHUNK_CELLS) {
      const ni = Math.min(CHUNK_CELLS, n - 1 - ci) + 1;
      const nj = Math.min(CHUNK_CELLS, n - 1 - cj) + 1;
      slot.fill(-1);
      const cells: number[] = [];
      for (let b = 0; b < nj - 1; b++)
        for (let a = 0; a < ni - 1; a++) {
          const k = (cj + b) * n + ci + a;
          if (wet[k] || wet[k + 1] || wet[k + n] || wet[k + n + 1]) cells.push(b * ni + a);
        }
      if (cells.length === 0) continue;
      // Number the vertices the drawn cells use.
      let count = 0;
      for (const c of cells) for (const q of [c, c + 1, c + ni, c + ni + 1]) if (slot[q]! < 0) slot[q] = count++;
      const view = new DataView(new ArrayBuffer(count * STRIDE));
      let minY = Infinity;
      let maxY = -Infinity;
      for (let b = 0; b < nj; b++)
        for (let a = 0; a < ni; a++) {
          const v = slot[b * ni + a]!;
          if (v < 0) continue;
          const i = ci + a;
          const j = cj + b;
          const k = j * n + i;
          let src = k;
          if (!wet[k]) {
            // The highest level among the wet 8-neighbours.
            src = -1;
            for (let dj = -1; dj <= 1; dj++)
              for (let di = -1; di <= 1; di++) {
                const ii = i + di;
                const jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
                const q = jj * n + ii;
                if (wet[q] && (src < 0 || water[q]! > water[src]!)) src = q;
              }
          }
          const y = water[src]!;
          const depth = wet[k] ? y - ground[k]! : Math.min(y - ground[k]!, -WET_M);
          put(view, v, x0 + i * step, y, z0 + j * step, depth, flowX[src]!, flowZ[src]!, body[src]!, fall[src]!, churn[src]!);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      const idx = new Uint16Array(cells.length * 6);
      let m = 0;
      for (const c of cells) {
        idx[m++] = slot[c]!;
        idx[m++] = slot[c + ni]!;
        idx[m++] = slot[c + 1]!;
        idx[m++] = slot[c + 1]!;
        idx[m++] = slot[c + ni]!;
        idx[m++] = slot[c + ni + 1]!;
      }
      pieces.push({
        data: { layout: WATER_LAYOUT, vertices: new Uint8Array(view.buffer), indices: idx, count: m },
        min: [x0 + ci * step, minY, z0 + cj * step],
        max: [x0 + (ci + ni - 1) * step, maxY, z0 + (cj + nj - 1) * step],
      });
    }
  return pieces;
}

/** The open sea beyond the square: four quads at height 0 round it, out to `SEA_REACH_M`. */
export function openSeaPiece(f: Field): WaterPiece {
  const lo = f.x0;
  const hi = f.x0 + (f.n - 1) * f.step;
  const zl = f.z0;
  const zh = f.z0 + (f.n - 1) * f.step;
  const R = SEA_REACH_M;
  const rects: [number, number, number, number][] = [
    [lo - R, zl - R, hi + R, zl],
    [lo - R, zh, hi + R, zh + R],
    [lo - R, zl, lo, zh],
    [hi, zl, hi + R, zh],
  ];
  const view = new DataView(new ArrayBuffer(rects.length * 4 * STRIDE));
  const idx = new Uint16Array(rects.length * 6);
  rects.forEach(([xa, za, xb, zb], r) => {
    const v = r * 4;
    put(view, v, xa, 0, za, -SEA_FLOOR_M, 0, 0, 0, 0);
    put(view, v + 1, xb, 0, za, -SEA_FLOOR_M, 0, 0, 0, 0);
    put(view, v + 2, xa, 0, zb, -SEA_FLOOR_M, 0, 0, 0, 0);
    put(view, v + 3, xb, 0, zb, -SEA_FLOOR_M, 0, 0, 0, 0);
    // The same turn as the grid: (x, z), (x, z + 1), (x + 1, z) faces up.
    idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], r * 6);
  });
  return {
    data: { layout: WATER_LAYOUT, vertices: new Uint8Array(view.buffer), indices: idx, count: idx.length },
    min: [lo - R, -0.5, zl - R],
    max: [hi + R, 0.5, zh + R],
  };
}
