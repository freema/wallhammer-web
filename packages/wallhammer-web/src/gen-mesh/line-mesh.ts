// Polylines laid on a surface as a line mesh (one pixel wide), for outlines and debugging overlays.

import type { MeshData, VertexLayout } from '../base/data.ts';

/** Polyline in the x-z plane, flat array x0, z0, x1, z1, … */
export interface LinePath {
  points: ArrayLike<number>;
  /** Connect the last point to the first (outline). */
  closed?: boolean;
}

/** Position 3× float, attribute `a_pos`. */
export const LINE_LAYOUT: VertexLayout = { stride: 12, attribs: [{ name: 'a_pos', size: 3, type: 'f32', offset: 0 }] };

/**
 * Lines laid on a surface given by `heightAt`. Segments are split by `maxSegmentM` so the line follows the slope,
 * and lifted by `liftM` above the surface.
 */
export function lineMesh(paths: readonly LinePath[], heightAt: (x: number, z: number) => number, liftM = 0.3, maxSegmentM = 2): MeshData {
  const out: number[] = [];
  const vertex = (x: number, z: number): void => {
    out.push(x, heightAt(x, z) + liftM, z);
  };
  for (const path of paths) {
    const p = path.points;
    const n = p.length / 2;
    const segments = path.closed ? n : n - 1;
    for (let k = 0; k < segments; k++) {
      const ax = p[k * 2]!;
      const az = p[k * 2 + 1]!;
      const bx = p[((k + 1) % n) * 2]!;
      const bz = p[((k + 1) % n) * 2 + 1]!;
      const parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / maxSegmentM));
      for (let i = 0; i < parts; i++) {
        vertex(ax + ((bx - ax) * i) / parts, az + ((bz - az) * i) / parts);
        vertex(ax + ((bx - ax) * (i + 1)) / parts, az + ((bz - az) * (i + 1)) / parts);
      }
    }
  }
  return { layout: LINE_LAYOUT, vertices: new Float32Array(out), indices: null, count: out.length / 3, primitive: 'lines' };
}

/** Polyline in space, flat array x0, y0, z0, x1, y1, z1, … */
export interface SpaceLinePath {
  points: ArrayLike<number>;
  /** Connect the last point to the first. */
  closed?: boolean;
}

/**
 * Polylines in space as a line mesh (one pixel wide, `LINE_LAYOUT`), taken as they are: no draping, no splitting.
 * For wireframes and debugging overlays of upright shapes.
 */
export function spaceLineMesh(paths: readonly SpaceLinePath[]): MeshData {
  let segments = 0;
  for (const path of paths) {
    const n = Math.floor(path.points.length / 3);
    if (n >= 2) segments += path.closed && n > 2 ? n : n - 1;
  }
  const out = new Float32Array(segments * 6);
  let o = 0;
  for (const path of paths) {
    const p = path.points;
    const n = Math.floor(p.length / 3);
    if (n < 2) continue;
    const count = path.closed && n > 2 ? n : n - 1;
    for (let k = 0; k < count; k++) {
      const a = k * 3;
      const b = ((k + 1) % n) * 3;
      out[o++] = p[a]!;
      out[o++] = p[a + 1]!;
      out[o++] = p[a + 2]!;
      out[o++] = p[b]!;
      out[o++] = p[b + 1]!;
      out[o++] = p[b + 2]!;
    }
  }
  return { layout: LINE_LAYOUT, vertices: out, indices: null, count: segments * 2, primitive: 'lines' };
}
