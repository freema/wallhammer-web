// Picking parts with a ray, for turning a click into an event position. Input side, not a decision: plain floats.

import type { StructureDesc } from '../../base/destructible.ts';

export interface PartHit {
  structure: number;
  part: number;
  /** Ray parameter and the hit point in metres. */
  t: number;
  point: [number, number, number];
}

/**
 * First part piece hit by the ray (origin and direction in metres), with `t > 0`. Clips the ray against the half
 * spaces of each convex prism (Cyrus–Beck). `skip` leaves out parts, for example the gone ones.
 */
export function raycastParts(
  structures: readonly StructureDesc[],
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  skip?: (structure: number, part: number) => boolean,
): PartHit | null {
  let best: PartHit | null = null;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  for (const s of structures) {
    for (const p of s.parts) {
      if (skip?.(s.id, p.key)) continue;
      let t0 = 1e-6;
      let t1 = best ? best.t : Infinity;
      // Bottom and top planes.
      const y0 = p.piece.y0 / 100;
      const y1 = p.piece.y1 / 100;
      if (Math.abs(dy) < 1e-12) {
        if (oy < y0 || oy > y1) continue;
      } else {
        let a = (y0 - oy) / dy;
        let b = (y1 - oy) / dy;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      // Side planes: inside is where the cross product with the edge is not negative.
      const c = p.piece.xz;
      const n = c.length / 2;
      for (let i = 0; i < n && t0 <= t1; i++) {
        const j = (i + 1) % n;
        const ax = c[i * 2]! / 100;
        const az = c[i * 2 + 1]! / 100;
        const ex = c[j * 2]! / 100 - ax;
        const ez = c[j * 2 + 1]! / 100 - az;
        // f(t) = ex·(z − az) − ez·(x − ax) ≥ 0
        const f0 = ex * (oz - az) - ez * (ox - ax);
        const fd = ex * dz - ez * dx;
        if (Math.abs(fd) < 1e-12) {
          if (f0 < 0) t1 = -Infinity;
          continue;
        }
        const t = -f0 / fd;
        if (fd > 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
      if (t0 <= t1 && t0 < (best?.t ?? Infinity)) best = { structure: s.id, part: p.key, t: t0, point: [ox + dx * t0, oy + dy * t0, oz + dz * t0] };
    }
  }
  return best;
}
