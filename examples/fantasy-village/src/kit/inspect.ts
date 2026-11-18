// Numbers about a mesh, for checking shapes without looking at them: size, triangle count, and whether faces point
// the way their normals say. Run it in the dev container on a generator's output, e.g. from a small script:
//   docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && node --experimental-strip-types check.ts'
// or call it from the browser console through `__wh.inspect()` (src/main.ts lists every module's meshes).

import type { MeshBuilder } from './mesh.ts';

export interface MeshReport {
  name: string;
  vertices: number;
  triangles: number;
  /** Bounds as [min x, y, z], [max x, y, z] and the size. */
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  /** Share of triangles whose winding disagrees with their vertex normals (should be near 0). */
  flipped: number;
  /**
   * Signed volume of the mesh (positive when closed parts face outward). Open shapes give partial numbers, but a
   * clearly negative value on a closed solid means it is inside out.
   */
  volume: number;
  /** Vertices that are not finite numbers (should be 0). */
  broken: number;
}

export function inspect(name: string, b: MeshBuilder): MeshReport {
  const P = b.positionData, N = b.normalData;
  let flipped = 0;
  let volume = 0;
  let broken = 0;
  for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i]!)) broken++;
  for (let t = 0; t < b.indexCount; t += 3) {
    const a = b.indexData[t]! * 3, c = b.indexData[t + 1]! * 3, d = b.indexData[t + 2]! * 3;
    const e1x = P[c]! - P[a]!, e1y = P[c + 1]! - P[a + 1]!, e1z = P[c + 2]! - P[a + 2]!;
    const e2x = P[d]! - P[a]!, e2y = P[d + 1]! - P[a + 1]!, e2z = P[d + 2]! - P[a + 2]!;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const vx = N[a]! + N[c]! + N[d]!, vy = N[a + 1]! + N[c + 1]! + N[d + 1]!, vz = N[a + 2]! + N[c + 2]! + N[d + 2]!;
    if (nx * vx + ny * vy + nz * vz < 0) flipped++;
    // Signed tetrahedron volume against the origin.
    volume += (P[a]! * (P[c + 1]! * P[d + 2]! - P[c + 2]! * P[d + 1]!) - P[a + 1]! * (P[c]! * P[d + 2]! - P[c + 2]! * P[d]!) + P[a + 2]! * (P[c]! * P[d + 1]! - P[c + 1]! * P[d]!)) / 6;
  }
  const { min, max } = b.bounds();
  const r = (v: number): number => Math.round(v * 100) / 100;
  return {
    name,
    vertices: b.vertexCount,
    triangles: b.triangleCount,
    min: [r(min[0]), r(min[1]), r(min[2])],
    max: [r(max[0]), r(max[1]), r(max[2])],
    size: [r(max[0] - min[0]), r(max[1] - min[1]), r(max[2] - min[2])],
    flipped: b.triangleCount ? r(flipped / b.triangleCount) : 0,
    volume: r(volume),
    broken,
  };
}

/** One line per report. */
export function formatReport(m: MeshReport): string {
  return `${m.name}: ${m.triangles} tris, size ${m.size.join(' × ')} m, min ${m.min.join(', ')}, max ${m.max.join(', ')}, flipped ${(m.flipped * 100).toFixed(1)} %, volume ${m.volume}${m.broken ? `, BROKEN ${m.broken}` : ''}`;
}
