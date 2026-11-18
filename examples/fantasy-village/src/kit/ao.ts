// Baked ambient occlusion into the vertex colours (alpha of a_color). Two tools:
//
//   bakeAo       real occlusion: the mesh is rasterised into a coarse voxel grid, and from every vertex a fixed set of
//                rays over its hemisphere is marched through the grid (and against the terrain). Corners under eaves,
//                the inside of a porch, the gaps between stones get darker. Use it once per finished building or prop.
//   groundAo     cheap contact darkening by the height of a vertex above the terrain (feet of walls, trunks, rocks).
//
// Both only lower the AO (they take the minimum with what is there), so they can be combined in any order.

import type { MeshBuilder } from './mesh.ts';
import { clamp, cross3, norm3, smoothstep } from './math.ts';
import type { Vec3 } from './math.ts';

export interface AoOptions {
  /** Voxel size in metres (default 0.25). Grown automatically so the grid stays under ~6M cells. */
  cell?: number;
  /** Rays per vertex (default 14). */
  rays?: number;
  /** How far a ray looks, metres (default 2.4). */
  reach?: number;
  /** Darkness of a fully occluded vertex (default 0.75; 1 would be black ambient). */
  strength?: number;
  /** Terrain under the mesh: rays that go below it are occluded. */
  ground?: (x: number, z: number) => number;
  /** First vertex to bake (default 0): vertices before it occlude but are not baked. */
  first?: number;
}

/** Fixed cosine-weighted directions over the +z hemisphere (Fibonacci spiral), the same for every call. */
function hemisphere(n: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * golden;
    out.push([r * Math.cos(a), r * Math.sin(a), Math.sqrt(Math.max(0, 1 - r * r))]);
  }
  return out;
}

export function bakeAo(b: MeshBuilder, o: AoOptions = {}): void {
  const first = o.first ?? 0;
  const nv = b.vertexCount;
  if (nv === first) return;
  const reach = o.reach ?? 2.4;
  const strength = o.strength ?? 0.75;
  const bounds = b.bounds(0);
  const min = [bounds.min[0] - reach, bounds.min[1] - reach, bounds.min[2] - reach];
  const size = [bounds.max[0] - bounds.min[0] + 2 * reach, bounds.max[1] - bounds.min[1] + 2 * reach, bounds.max[2] - bounds.min[2] + 2 * reach];
  let cell = o.cell ?? 0.25;
  while ((size[0]! / cell) * (size[1]! / cell) * (size[2]! / cell) > 6e6) cell *= 1.25;
  const nx = Math.ceil(size[0]! / cell) + 1, ny = Math.ceil(size[1]! / cell) + 1, nz = Math.ceil(size[2]! / cell) + 1;
  const grid = new Uint8Array(nx * ny * nz);
  const mark = (x: number, y: number, z: number): void => {
    const i = Math.floor((x - min[0]!) / cell), j = Math.floor((y - min[1]!) / cell), k = Math.floor((z - min[2]!) / cell);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    grid[(k * ny + j) * nx + i] = 1;
  };
  // Rasterise every triangle by sampling it densely enough for the cell size.
  const P = b.positionData;
  for (let t = 0; t < b.indexCount; t += 3) {
    const a = b.indexData[t]! * 3, c = b.indexData[t + 1]! * 3, d = b.indexData[t + 2]! * 3;
    const ax = P[a]!, ay = P[a + 1]!, az = P[a + 2]!;
    const bx = P[c]!, by = P[c + 1]!, bz = P[c + 2]!;
    const cx = P[d]!, cy = P[d + 1]!, cz = P[d + 2]!;
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
    const n = Math.max(1, Math.ceil(e / (cell * 0.6)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        mark(ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v);
      }
    }
  }
  const occupied = (x: number, y: number, z: number): boolean => {
    const i = Math.floor((x - min[0]!) / cell), j = Math.floor((y - min[1]!) / cell), k = Math.floor((z - min[2]!) / cell);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
    return grid[(k * ny + j) * nx + i] === 1;
  };
  const dirs = hemisphere(o.rays ?? 14);
  const step = cell * 0.9;
  const steps = Math.ceil(reach / step);
  for (let v = first; v < nv; v++) {
    const px = P[v * 3]!, py = P[v * 3 + 1]!, pz = P[v * 3 + 2]!;
    const n: Vec3 = [b.normalData[v * 3]!, b.normalData[v * 3 + 1]!, b.normalData[v * 3 + 2]!];
    const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const tu = norm3(cross3(ref, n));
    const tv = cross3(n, tu);
    // Start a little out of the surface so the vertex's own voxel does not count.
    const ox = px + n[0] * cell * 1.1, oy = py + n[1] * cell * 1.1, oz = pz + n[2] * cell * 1.1;
    let occ = 0;
    for (const d of dirs) {
      const dx = tu[0] * d[0] + tv[0] * d[1] + n[0] * d[2];
      const dy = tu[1] * d[0] + tv[1] * d[1] + n[1] * d[2];
      const dz = tu[2] * d[0] + tv[2] * d[1] + n[2] * d[2];
      for (let s = 1; s <= steps; s++) {
        const r = s * step;
        const x = ox + dx * r, y = oy + dy * r, z = oz + dz * r;
        if (occupied(x, y, z) || (o.ground && y < o.ground(x, z) - 0.05)) {
          // Near hits darken more than far ones.
          occ += 1 - 0.6 * (r / reach);
          break;
        }
      }
    }
    const ao = clamp(1 - strength * (occ / dirs.length) * 1.4, 1 - strength, 1);
    b.col[v * 4 + 3] = Math.min(b.col[v * 4 + 3]!, ao);
  }
}

/**
 * Contact darkening: vertices within `height` metres above the terrain get darker toward it (down to
 * 1 − `strength` at the ground). From `first` on.
 */
export function groundAo(b: MeshBuilder, ground: (x: number, z: number) => number, height = 1.2, strength = 0.45, first = 0): void {
  for (let v = first; v < b.vertexCount; v++) {
    const x = b.positionData[v * 3]!, y = b.positionData[v * 3 + 1]!, z = b.positionData[v * 3 + 2]!;
    const h = y - ground(x, z);
    const ao = 1 - strength * (1 - smoothstep(0, height, h));
    b.col[v * 4 + 3] = Math.min(b.col[v * 4 + 3]!, ao);
  }
}
