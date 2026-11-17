// Wireframe of the solids of a collision world, for a debugging overlay: each prism as its outline at the bottom and
// at the top joined by its upright edges, each cylinder as two circles joined by four upright lines. One line mesh
// (`LINE_LAYOUT`, primitive 'lines'); draw it with any line material, for example `LINE_VS` and `LINE_FS`.

import type { MeshData } from '../base/data.ts';
import { spaceLineMesh } from '../gen-mesh/line-mesh.ts';
import type { SpaceLinePath } from '../gen-mesh/line-mesh.ts';
import type { CollisionWorld, SolidInfo } from '../world/collide.ts';

export interface CollisionLinesOptions {
  /** Which solids to draw. Default all. */
  select?: (info: SolidInfo, id: number) => boolean;
  /** Segments of a cylinder's circle. Default 16. */
  segments?: number;
  /** Bottoms deeper than this are drawn at it (a solid that reaches far below the base). Default −Infinity. */
  floorY?: number;
}

/** The solids of `world` as lines. Built once per call (it allocates); rebuild after adding or removing solids. */
export function collisionLines(world: CollisionWorld, o: CollisionLinesOptions = {}): MeshData {
  const segments = Math.max(3, Math.floor(o.segments ?? 16));
  const floorY = o.floorY ?? -Infinity;
  const paths: SpaceLinePath[] = [];
  world.forEachSolid((id, info) => {
    if (o.select && !o.select(info, id)) return;
    const lo = Math.max(info.minY, floorY);
    const hi = info.maxY;
    let ring: ArrayLike<number>;
    let uprights: number;
    if (info.kind === 'prism' && info.outline) {
      ring = info.outline;
      uprights = 1;
    } else {
      const r = new Float64Array(segments * 2);
      for (let k = 0; k < segments; k++) {
        const a = (k / segments) * Math.PI * 2;
        r[k * 2] = info.x + Math.cos(a) * info.radius;
        r[k * 2 + 1] = info.z + Math.sin(a) * info.radius;
      }
      ring = r;
      // Four upright lines round a circle are enough to read it as a cylinder.
      uprights = Math.max(1, Math.floor(segments / 4));
    }
    const n = ring.length >> 1;
    const bottom = new Float64Array(n * 3);
    const top = new Float64Array(n * 3);
    for (let k = 0; k < n; k++) {
      const x = ring[k * 2]!;
      const z = ring[k * 2 + 1]!;
      bottom[k * 3] = x;
      bottom[k * 3 + 1] = lo;
      bottom[k * 3 + 2] = z;
      top[k * 3] = x;
      top[k * 3 + 1] = hi;
      top[k * 3 + 2] = z;
      if (k % uprights === 0) paths.push({ points: [x, lo, z, x, hi, z] });
    }
    paths.push({ points: bottom, closed: true }, { points: top, closed: true });
  });
  return spaceLineMesh(paths);
}
