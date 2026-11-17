// A grid over the whole sphere: one node at the middle of every cell of one level of the cube sphere (gen-core,
// cube-sphere.ts). Node `face · n² + y · n + x`, with `n = 2^level`, sits at the middle of cell (x, y) of that face.
// Neighbours are found by index arithmetic inside a face and by a seam table of the four sides of every face, built
// once per level; there is no table per node. Everything is arithmetic, `Math.sqrt` and what the cube sphere calls,
// so the same input gives the same bits in every runtime.

import type { Vec3 } from '../base/math.ts';
import { cubeDirectionWarped, cubeFaceOf, cubeGrid, cubeNeighbour, cubeWarp } from '../gen-core/cube-sphere.ts';

/** The grid of nodes at the middles of the cells of one level of the cube sphere. */
export interface SphereGrid {
  readonly radiusM: number;
  readonly level: number;
  /** Nodes along a face side, `2^level`. */
  readonly n: number;
  /** All nodes, `6 n²`. */
  readonly count: number;
}

/** Per level: the warped face coordinate of every node middle and the seam table. Pure caches. */
interface GridTables {
  /** `cubeWarp(cubeGrid(i + 0.5, n))` for i = 0 … n − 1. */
  warp: Float64Array;
  /**
   * Per face and side (0: x = −1, 1: x = n, 2: y = −1, 3: y = n), per index along the side: the node across the edge
   * of the cube that the step off the face lands on.
   */
  seam: Int32Array;
}
const tables = new Map<number, GridTables>();

function tablesOf(level: number): GridTables {
  let t = tables.get(level);
  if (t) return t;
  const n = 2 ** level;
  const warp = new Float64Array(n);
  for (let i = 0; i < n; i++) warp[i] = cubeWarp(cubeGrid(i + 0.5, n));
  const seam = new Int32Array(24 * n);
  for (let face = 0; face < 6; face++) {
    for (let i = 0; i < n; i++) {
      const steps: [number, number, number, number][] = [
        [0, i, -1, 0],
        [n - 1, i, 1, 0],
        [i, 0, 0, -1],
        [i, n - 1, 0, 1],
      ];
      for (let side = 0; side < 4; side++) {
        const [x, y, dx, dy] = steps[side]!;
        const c = cubeNeighbour(face, level, x, y, dx, dy);
        if (!c) throw new Error(`gen-plan: no cell across side ${side} of face ${face}`);
        seam[(face * 4 + side) * n + i] = c.face * n * n + c.y * n + c.x;
      }
    }
  }
  t = { warp, seam };
  tables.set(level, t);
  return t;
}

/** The grid of level `level` on a sphere of `radiusM`. */
export function sphereGrid(radiusM: number, level: number): SphereGrid {
  if (!(level >= 0 && level <= 13 && Number.isInteger(level))) throw new Error(`gen-plan: grid level ${level} out of 0…13`);
  const n = 2 ** level;
  return { radiusM, level, n, count: 6 * n * n };
}

/**
 * The node `x` index `i`, `y` index `j` of `face`, or across an edge of the cube when one of them is −1 or n.
 * −1 when both are off the face (a corner of the cube: no cell lies there).
 */
function nodeOf(t: GridTables, n: number, face: number, i: number, j: number): number {
  const outI = i < 0 || i >= n;
  const outJ = j < 0 || j >= n;
  if (!outI && !outJ) return face * n * n + j * n + i;
  if (outI && outJ) return -1;
  if (outI) return t.seam[(face * 4 + (i < 0 ? 0 : 1)) * n + j]!;
  return t.seam[(face * 4 + (j < 0 ? 2 : 3)) * n + i]!;
}

/** The node whose cell holds the direction (x, y, z), any length but not zero. */
export function gridNodeAt(g: SphereGrid, x: number, y: number, z: number): number {
  const { face, s, t } = cubeFaceOf([x, y, z]);
  const n = g.n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(((s + 1) / 2) * n)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(((t + 1) / 2) * n)));
  return face * n * n + j * n + i;
}

/** Unit direction of a node's middle: `cubeDirection(face, cubeGrid(x + 0.5, n), cubeGrid(y + 0.5, n))`, bit for bit. */
export function gridDirection(g: SphereGrid, node: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const t = tablesOf(g.level);
  const n = g.n;
  const nn = n * n;
  const face = Math.floor(node / nn);
  const r = node - face * nn;
  const y = Math.floor(r / n);
  const x = r - y * n;
  return cubeDirectionWarped(face, t.warp[x]!, t.warp[y]!, out);
}

/**
 * The neighbours of a node in the order (−1,−1) (0,−1) (1,−1) (−1,0) (1,0) (−1,1) (0,1) (1,1) of its own face axes,
 * across an edge of the cube as `cubeNeighbour` folds it. The diagonal step over a corner of the cube does not exist
 * and is left out, so the 24 corner nodes have 7. Writes them to `out` (at least 8 long) and returns how many.
 */
export function gridNeighbours(g: SphereGrid, node: number, out: Int32Array): number {
  const n = g.n;
  const nn = n * n;
  const face = Math.floor(node / nn);
  const r = node - face * nn;
  const y = Math.floor(r / n);
  const x = r - y * n;
  let k = 0;
  if (x > 0 && y > 0 && x < n - 1 && y < n - 1) {
    const b = node;
    out[0] = b - n - 1;
    out[1] = b - n;
    out[2] = b - n + 1;
    out[3] = b - 1;
    out[4] = b + 1;
    out[5] = b + n - 1;
    out[6] = b + n;
    out[7] = b + n + 1;
    return 8;
  }
  const t = tablesOf(g.level);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const q = nodeOf(t, n, face, x + dx, y + dy);
      if (q >= 0) out[k++] = q;
    }
  }
  return k;
}

/** Area in m² of a node's cell, from the closed form of the equal-angle grid at its middle. */
export function gridNodeArea(g: SphereGrid, node: number): number {
  const t = tablesOf(g.level);
  const n = g.n;
  const r = node % (n * n);
  const y = Math.floor(r / n);
  const x = r - y * n;
  const a = t.warp[x]!;
  const b = t.warp[y]!;
  const a2 = a * a;
  const b2 = b * b;
  const q = 1 + a2 + b2;
  const step = (Math.PI / 2 / n) * g.radiusM;
  return (step * step * (1 + a2) * (1 + b2)) / (q * Math.sqrt(q));
}

/**
 * A field of one value per node, read at a direction (x, y, z): bilinear between the four nearest node middles in
 * the face coordinates of the face that holds the direction. Past the last row or column of a face the nodes of the
 * next face stand in; at a corner of the cube the missing fourth value is the mean of the other three. Equal to the
 * field at a node middle, and continuous over the edges and corners of the cube.
 */
export function gridSample(g: SphereGrid, field: ArrayLike<number>, x: number, y: number, z: number): number {
  const count = gridWeights(g, x, y, z, SAMPLE_NODES, SAMPLE_WEIGHTS);
  let sum = 0;
  for (let k = 0; k < count; k++) sum += SAMPLE_WEIGHTS[k]! * field[SAMPLE_NODES[k]!]!;
  return sum;
}

const SAMPLE_NODES = new Int32Array(4);
const SAMPLE_WEIGHTS = new Float64Array(4);

/**
 * The nodes `gridSample` blends at a direction (x, y, z) and their weights (sum 1), in its order. Returns how many:
 * 3 at a corner of the cube (the missing fourth node's weight goes in thirds to the other three), else 4. The sum of
 * `weights[k] · field[nodes[k]]` in this order is `gridSample` bit for bit.
 */
export function gridWeights(g: SphereGrid, x: number, y: number, z: number, nodes: Int32Array, weights: Float64Array): number {
  const { face, s, t: tt } = cubeFaceOf([x, y, z]);
  const n = g.n;
  const tab = tablesOf(g.level);
  const u = ((s + 1) / 2) * n - 0.5;
  const v = ((tt + 1) / 2) * n - 0.5;
  const i0 = Math.min(n - 1, Math.max(-1, Math.floor(u)));
  const j0 = Math.min(n - 1, Math.max(-1, Math.floor(v)));
  const fu = Math.min(1, Math.max(0, u - i0));
  const fv = Math.min(1, Math.max(0, v - j0));
  const ids = [
    nodeOf(tab, n, face, i0, j0),
    nodeOf(tab, n, face, i0 + 1, j0),
    nodeOf(tab, n, face, i0, j0 + 1),
    nodeOf(tab, n, face, i0 + 1, j0 + 1),
  ];
  const w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
  // At most one of the four is missing (a corner of the cube): its weight goes in thirds to the others.
  let missing = -1;
  for (let k = 0; k < 4; k++) if (ids[k]! < 0) missing = k;
  let count = 0;
  for (let k = 0; k < 4; k++) {
    if (k === missing) continue;
    nodes[count] = ids[k]!;
    weights[count] = missing >= 0 ? w[k]! + w[missing]! / 3 : w[k]!;
    count++;
  }
  return count;
}
