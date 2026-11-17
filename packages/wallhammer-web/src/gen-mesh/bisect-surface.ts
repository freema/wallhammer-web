// A height grid as a mesh with as few triangles as a given error allows (right-triangle bisection, RTIN): the square
// is two right triangles, and a triangle is cut in two at the middle of its long edge while the surface there (or
// anywhere inside it) lies farther from the flat triangle than the tolerance. Flat ground ends up as a few large
// triangles, broken ground keeps the full grid. Cuts are always matched on both sides of an edge, so the mesh has no
// gaps inside the square.
//
// Two squares next to each other may be cut differently along their shared edge. A skirt hides that: every outer edge
// gets a strip hanging down from it, shaded as the surface above it. A side can instead be marked as a cut through
// the ground (the edge of the world): its strip then reaches down to a given height and carries the cut kind.
//
// The mesh comes out packed (packed-mesh.ts): positions are 16-bit steps from the square's corner, indices 16-bit
// whenever the vertices allow it.

import type { MeshData, VertexLayout } from '../base/data.ts';
import { PACKED_POSITION, PACK_STEPS_PER_EDGE } from './packed-mesh.ts';

/** Attribute locations: those of the height field mesh, with the packed position in place of `a_pos`. */
export const BISECT_SURFACE_ATTRIBS = { [PACKED_POSITION]: 0, a_normal: 1 } as const;

/** Packed position 4× int16; normal 3× int16 (not normalized, ×32767) and the kind (0 surface, 1 cut) as the fourth. */
export const BISECT_SURFACE_LAYOUT: VertexLayout = {
  stride: 16,
  attribs: [
    { name: PACKED_POSITION, size: 4, type: 'i16', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i16', offset: 8 },
  ],
};

const KIND_TOP = 0;
const KIND_CUT = 1;

export interface BisectSurfaceOptions {
  /** Quads along one side of the square: a power of two from 2 to 256. */
  quads: number;
  /** Edge of the square in metres. */
  edgeM: number;
  /** Largest height difference in metres between the mesh and the grid. 0 drops only grid points that lie exactly on the mesh without them. */
  toleranceM: number;
  /** Metres per vertical step and the height of step 0 (as `packFrame`). */
  stepY: number;
  heightOrigin: number;
  /** How far the skirt hangs below the surface, in metres. 0 = no skirt. */
  skirtM: number;
  /**
   * Per side (low x, high x, low z, high z): `null` = an ordinary skirt; a height in metres = this side is a cut
   * through the ground, its strip reaches down to that height.
   */
  cuts?: readonly (number | null)[];
  /**
   * The part of the square that exists, in metres from its corner: `[minX, minZ, maxX, maxZ]`. Vertices outside are
   * moved onto its border, triangles left without area are dropped. The heights of grid points outside should be
   * those of the border point they move to.
   */
  clip?: readonly [number, number, number, number];
}

export interface BisectSurface {
  mesh: MeshData;
  /** Triangles of the surface (without the skirt), and how many the full grid would have. */
  triangles: number;
  gridTriangles: number;
  /** Largest and smallest height among the surface vertices, in metres. */
  minY: number;
  maxY: number;
}

/**
 * Mesh of a square height grid within `toleranceM`. `heights` holds `(quads + 3)²` samples, row by row along x, with
 * one extra sample all round: sample `(i + 1, j + 1)` is the grid point `(i, j)`; the margin is used for normals only,
 * so squares that share an edge and sample the same ground agree on the normals there.
 */
export function bisectSurface(heights: Float32Array, o: BisectSurfaceOptions): BisectSurface {
  const n = o.quads;
  if (n < 2 || n > 256 || (n & (n - 1)) !== 0) throw new Error('bisectSurface: quads must be a power of two from 2 to 256');
  const size = n + 1;
  const wide = n + 3;
  if (heights.length !== wide * wide) throw new Error(`bisectSurface: ${wide * wide} heights expected, got ${heights.length}`);
  const hAt = (i: number, j: number): number => heights[(j + 1) * wide + i + 1]!;
  const spacing = o.edgeM / n;
  const stepsPerQuad = PACK_STEPS_PER_EDGE / n;
  const stepXZ = o.edgeM / PACK_STEPS_PER_EDGE;

  // 1. Error of every grid point that is the middle of a long edge: the height difference there, or the largest
  // error of the triangles below it. Triangles are numbered as a binary heap (the two halves of a triangle follow
  // from its number), smallest last.
  const numTriangles = n * n * 2 - 2;
  const numParents = numTriangles - n * n;
  const errors = new Float32Array(size * size);
  const coords = new Uint16Array(numTriangles * 4);
  for (let i = 0; i < numTriangles; i++) {
    let id = i + 2;
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    let cx = 0;
    let cy = 0;
    if (id & 1) bx = by = cx = n;
    else ax = ay = cy = n;
    while ((id >>= 1) > 1) {
      const mx = (ax + bx) >> 1;
      const my = (ay + by) >> 1;
      if (id & 1) {
        bx = ax;
        by = ay;
        ax = cx;
        ay = cy;
      } else {
        ax = bx;
        ay = by;
        bx = cx;
        by = cy;
      }
      cx = mx;
      cy = my;
    }
    coords.set([ax, ay, bx, by], i * 4);
  }
  for (let i = numTriangles - 1; i >= 0; i--) {
    const k = i * 4;
    const ax = coords[k]!;
    const ay = coords[k + 1]!;
    const bx = coords[k + 2]!;
    const by = coords[k + 3]!;
    const mx = (ax + bx) >> 1;
    const my = (ay + by) >> 1;
    const cx = mx + my - ay;
    const cy = my + ax - mx;
    const middle = my * size + mx;
    let e = Math.max(errors[middle]!, Math.abs((hAt(ax, ay) + hAt(bx, by)) / 2 - hAt(mx, my)));
    if (i < numParents) {
      const left = ((ay + cy) >> 1) * size + ((ax + cx) >> 1);
      const right = ((by + cy) >> 1) * size + ((bx + cx) >> 1);
      e = Math.max(e, errors[left]!, errors[right]!);
    }
    errors[middle] = e;
  }

  // 2. Triangles within the tolerance, top down. Vertices are numbered in the order they are first used.
  const clip = o.clip;
  const clipSteps = clip ? clip.map((m) => Math.round(m / stepXZ)) : null;
  // A vertex is known by where it ends up: grid points that clipping moves onto one point are one vertex.
  const vertexAt = new Map<number, number>();
  const px: number[] = [];
  const pz: number[] = [];
  const grid: number[] = [];
  const vertex = (i: number, j: number): number => {
    let x = i * stepsPerQuad;
    let z = j * stepsPerQuad;
    if (clipSteps) {
      x = Math.min(clipSteps[2]!, Math.max(clipSteps[0]!, x));
      z = Math.min(clipSteps[3]!, Math.max(clipSteps[1]!, z));
    }
    const key = x * 32768 + z;
    let v = vertexAt.get(key);
    if (v === undefined) {
      v = grid.length;
      vertexAt.set(key, v);
      grid.push(j * size + i);
      px.push(x);
      pz.push(z);
    }
    return v;
  };
  const tris: number[] = [];
  const emit = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void => {
    const a = vertex(ax, ay);
    const b = vertex(bx, by);
    const c = vertex(cx, cy);
    // Twice the area seen from above; clipping may have left none.
    const area = (px[b]! - px[a]!) * (pz[c]! - pz[a]!) - (pz[b]! - pz[a]!) * (px[c]! - px[a]!);
    if (area !== 0) tris.push(a, b, c);
  };
  const tolerance = Math.max(0, o.toleranceM);
  const split = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void => {
    const mx = (ax + bx) >> 1;
    const my = (ay + by) >> 1;
    if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && errors[my * size + mx]! > tolerance) {
      split(cx, cy, ax, ay, mx, my);
      split(bx, by, cx, cy, mx, my);
    } else emit(ax, ay, bx, by, cx, cy);
  };
  split(0, 0, n, n, n, 0);
  split(n, n, 0, 0, 0, n);
  const surfaceTriangles = tris.length / 3;

  // 3. Outer edges: those used by one triangle only. The edge runs the way its triangle does, so the outside is
  // always on the same hand and the strip faces outward.
  const top = grid.length;
  const edgeUse = new Map<number, number>();
  const edgeKey = (a: number, b: number): number => (a < b ? a * top + b : b * top + a);
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(tris[t + e]!, tris[t + ((e + 1) % 3)]!);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
    }
  }
  const lo = clipSteps ? [clipSteps[0]!, clipSteps[1]!] : [0, 0];
  /** Side of an outer edge: 0 low x, 1 high x, 2 low z, 3 high z. */
  const sideOf = (a: number, b: number): number => {
    if (px[a] === px[b]) return px[a] === lo[0] ? 0 : 1;
    return pz[a] === lo[1] ? 2 : 3;
  };
  const SIDE_NORMAL = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;

  // 4. Vertex data. Heights and normals come from the grid point a vertex was made for.
  const yStep = (h: number): number => Math.max(-32768, Math.min(32767, Math.round((h - o.heightOrigin) / o.stepY)));
  const normalOf = (g: number): [number, number, number] => {
    const i = g % size;
    const j = (g - i) / size;
    const dx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * spacing);
    const dz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * spacing);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  };
  const rows: number[] = [];
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: number): number => {
    rows.push(x, y, z, 0, Math.round(nx * 32767), Math.round(ny * 32767), Math.round(nz * 32767), kind);
    return rows.length / 8 - 1;
  };
  let minY = Infinity;
  let maxY = -Infinity;
  const ySteps = new Int32Array(top);
  const normals: [number, number, number][] = [];
  for (let v = 0; v < top; v++) {
    const g = grid[v]!;
    const h = hAt(g % size, Math.floor(g / size));
    if (h < minY) minY = h;
    if (h > maxY) maxY = h;
    ySteps[v] = yStep(h);
    const nrm = normalOf(g);
    normals.push(nrm);
    put(px[v]!, ySteps[v]!, pz[v]!, nrm[0], nrm[1], nrm[2], KIND_TOP);
  }
  if (top === 0) {
    minY = 0;
    maxY = 0;
  }
  const indices: number[] = tris.slice();
  if (o.skirtM > 0 || o.cuts?.some((c) => c !== null && c !== undefined)) {
    const drop = Math.max(1, Math.round(o.skirtM / o.stepY));
    /** Lower vertex of an ordinary skirt under a surface vertex, made once. */
    const below = new Int32Array(top).fill(-1);
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const u = tris[t + e]!;
        const v = tris[t + ((e + 1) % 3)]!;
        if (edgeUse.get(edgeKey(u, v)) !== 1) continue;
        const side = sideOf(u, v);
        const cut = o.cuts?.[side] ?? null;
        let u0 = u;
        let v0 = v;
        let u1: number;
        let v1: number;
        if (cut === null) {
          if (o.skirtM <= 0) continue;
          for (const w of [u, v]) {
            if (below[w]! < 0) {
              const nrm = normals[w]!;
              below[w] = put(px[w]!, Math.max(-32768, ySteps[w]! - drop), pz[w]!, nrm[0], nrm[1], nrm[2], KIND_TOP);
            }
          }
          u1 = below[u]!;
          v1 = below[v]!;
        } else {
          // A cut has its own vertices: its normal points out of the side and its kind differs from the surface.
          const [nx, nz] = SIDE_NORMAL[side]!;
          const base = yStep(cut);
          u0 = put(px[u]!, ySteps[u]!, pz[u]!, nx, 0, nz, KIND_CUT);
          u1 = put(px[u]!, Math.min(ySteps[u]!, base), pz[u]!, nx, 0, nz, KIND_CUT);
          v0 = put(px[v]!, ySteps[v]!, pz[v]!, nx, 0, nz, KIND_CUT);
          v1 = put(px[v]!, Math.min(ySteps[v]!, base), pz[v]!, nx, 0, nz, KIND_CUT);
        }
        indices.push(u0, u1, v0, v0, u1, v1);
      }
    }
  }
  const count = rows.length / 8;
  const vertices = new Int16Array(rows);
  const mesh: MeshData = {
    layout: BISECT_SURFACE_LAYOUT,
    vertices,
    indices: count <= 65536 ? Uint16Array.from(indices) : Uint32Array.from(indices),
    count: indices.length,
  };
  return { mesh, triangles: surfaceTriangles, gridTriangles: n * n * 2, minY, maxY };
}
