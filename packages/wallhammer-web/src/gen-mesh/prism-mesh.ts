// Upright prisms over outlines, each carrying the number of a table row: shells that a layer colours by a value
// looked up per row. An outline is a simple polygon in the x–z plane (holes are not cut; the lid covers them).
// Walls and lid share vertices and carry no normals; the shader takes the face direction from screen derivatives.

import type { MeshData, VertexLayout } from '../base/data.ts';
import type { Vec3 } from '../base/math.ts';

/** Position 3× float (`a_pos`) and the table row as a float (`a_ref`). */
export const PRISM_LAYOUT: VertexLayout = {
  stride: 16,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_ref', size: 1, type: 'f32', offset: 12 },
  ],
};
/** Attribute locations a material should give the prisms. */
export const PRISM_ATTRIBS = { a_pos: 0, a_ref: 1 } as const;

/** One prism: an outline (x0, z0, x1, z1, …, not closed, either winding), its bottom and top, and its table row. */
export interface PrismShape {
  ring: ArrayLike<number>;
  minY: number;
  maxY: number;
  /** Row of the table the prism takes its value from, 0 and up. */
  ref: number;
}

export interface PrismMeshOptions {
  /** Moves the walls outward by this many metres, so the shell stands clear of what it wraps. Default 0. */
  growM?: number;
}

/** Twice the signed area of a ring in the x–z plane. */
function area2(ring: ArrayLike<number>): number {
  const n = ring.length >> 1;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!;
  }
  return a;
}

/**
 * Triangles of a simple polygon by ear clipping: vertex numbers of the ring, three per triangle, each triangle with
 * a positive area in the x–z plane. Points on a straight line are dropped. A ring that crosses itself is closed with
 * a fan, so the result always covers something.
 */
export function triangulateRing(ring: ArrayLike<number>): number[] {
  const n = ring.length >> 1;
  if (n < 3) return [];
  const forward = area2(ring) > 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(forward ? i : n - 1 - i);
  const x = (i: number): number => ring[i * 2]!;
  const z = (i: number): number => ring[i * 2 + 1]!;
  const cross = (a: number, b: number, c: number): number => (x(b) - x(a)) * (z(c) - z(a)) - (z(b) - z(a)) * (x(c) - x(a));
  const out: number[] = [];
  let i = 0;
  // Vertices tried in a row without finding an ear; a full round means the ring is not simple.
  let tried = 0;
  while (idx.length > 3 && tried < idx.length) {
    const m = idx.length;
    const at = i % m;
    const a = idx[(at + m - 1) % m]!;
    const b = idx[at]!;
    const c = idx[(at + 1) % m]!;
    const turn = cross(a, b, c);
    let ear = turn > 1e-12;
    if (ear) {
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        // Strictly inside or on an edge of the candidate triangle: not an ear.
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) {
          ear = false;
          break;
        }
      }
    }
    if (ear || Math.abs(turn) <= 1e-12) {
      if (ear) out.push(a, b, c);
      idx.splice(at, 1);
      tried = 0;
      i = at;
    } else {
      i = at + 1;
      tried++;
    }
  }
  if (idx.length === 3) {
    if (cross(idx[0]!, idx[1]!, idx[2]!) > 1e-12) out.push(idx[0]!, idx[1]!, idx[2]!);
  } else {
    for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0]!, idx[k]!, idx[k + 1]!);
  }
  return out;
}

/** One mesh of all the prisms (walls and lids, faces outward) and the box that holds it. */
export function prismMesh(shapes: readonly PrismShape[], o: PrismMeshOptions = {}): { mesh: MeshData; min: Vec3; max: Vec3 } {
  const grow = o.growM ?? 0;
  let vertexCount = 0;
  for (const s of shapes) vertexCount += (s.ring.length >> 1) * 2;
  const v = new Float32Array(vertexCount * 4);
  const idx: number[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let base = 0;
  for (const s of shapes) {
    const n = s.ring.length >> 1;
    if (n < 3) continue;
    // Walk the ring so that its area is positive: the outside is then to the right of every edge.
    const forward = area2(s.ring) > 0;
    const px = new Float64Array(n);
    const pz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = forward ? i : n - 1 - i;
      px[i] = s.ring[k * 2]!;
      pz[i] = s.ring[k * 2 + 1]!;
    }
    const flat = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let x = px[i]!;
      let z = pz[i]!;
      if (grow !== 0) {
        // Outward normals of the two edges at the vertex; their mitre keeps both walls `grow` away from the outline.
        const p = (i + n - 1) % n;
        const q = (i + 1) % n;
        let ax = x - px[p]!;
        let az = z - pz[p]!;
        let bx = px[q]! - x;
        let bz = pz[q]! - z;
        const al = Math.hypot(ax, az) || 1;
        const bl = Math.hypot(bx, bz) || 1;
        ax /= al;
        az /= al;
        bx /= bl;
        bz /= bl;
        const mx = az + bz;
        const mz = -ax - bx;
        // 1 + cos of the turn; a near reversal would send the mitre far out, so it is capped.
        const k = Math.max(0.4, 1 + (az * bz + ax * bx));
        x += (mx / k) * grow;
        z += (mz / k) * grow;
      }
      flat[i * 2] = x;
      flat[i * 2 + 1] = z;
      for (let t = 0; t < 2; t++) {
        const w = (base + i * 2 + t) * 4;
        v[w] = x;
        v[w + 1] = t === 0 ? s.minY : s.maxY;
        v[w + 2] = z;
        v[w + 3] = s.ref;
      }
      if (x < min[0]) min[0] = x;
      if (x > max[0]) max[0] = x;
      if (z < min[2]) min[2] = z;
      if (z > max[2]) max[2] = z;
    }
    if (s.minY < min[1]) min[1] = s.minY;
    if (s.maxY > max[1]) max[1] = s.maxY;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = base + i * 2;
      const b = base + j * 2;
      // Bottom a, bottom b, top b, top a; the face looks to the right of the edge.
      idx.push(a, b + 1, b, a, a + 1, b + 1);
    }
    // The lid looks up: a triangle with a positive area in x–z is turned over.
    const lid = triangulateRing(flat);
    for (let k = 0; k < lid.length; k += 3) idx.push(base + lid[k]! * 2 + 1, base + lid[k + 2]! * 2 + 1, base + lid[k + 1]! * 2 + 1);
    base += n * 2;
  }
  if (base === 0) {
    min.fill(0);
    max.fill(0);
  }
  const vertices = base * 4 === v.length ? v : v.slice(0, base * 4);
  const indices = base > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx);
  return { mesh: { layout: PRISM_LAYOUT, vertices, indices, count: idx.length }, min, max };
}
