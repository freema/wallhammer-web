// Shapes the cells place as instances: trees, rocks and rock pillars, each with a fine and a coarse level of detail.
// Unit-sized, base at y = 0 and top at y = 1; the instance scales them (width, height, depth) and turns them.
// Built once on the main thread, so they are not part of the cell bytes.

import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';

export const SHAPE_LAYOUT: VertexLayout = {
  stride: 24,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
  ],
};

type P = [number, number, number];

/** Flat-shaded triangle soup; each triangle is turned to face away from the axis point at its height. */
class Builder {
  readonly v: number[] = [];
  tri(a: P, b: P, c: P, center: P | null = null): void {
    const e1: P = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: P = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: P = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    const m: P = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const ref: P = center ?? [0, m[1], 0];
    const out = (m[0] - ref[0]) * n[0] + (m[1] - ref[1]) * n[1] + (m[2] - ref[2]) * n[2];
    if (out < 0) {
      this.v.push(...a, -n[0], -n[1], -n[2], ...c, -n[0], -n[1], -n[2], ...b, -n[0], -n[1], -n[2]);
    } else {
      this.v.push(...a, ...n, ...b, ...n, ...c, ...n);
    }
  }
  mesh(): MeshData {
    const vertices = Float32Array.from(this.v);
    return { layout: SHAPE_LAYOUT, vertices, indices: null, count: vertices.length / 6 };
  }
}

const ring = (n: number, r: number, y: number, turn = 0, jitter: (k: number) => number = () => 1): P[] =>
  Array.from({ length: n }, (_, k) => {
    const a = ((k + turn) / n) * Math.PI * 2;
    const rr = r * jitter(k);
    return [Math.cos(a) * rr, y, Math.sin(a) * rr];
  });

/** Side faces between two rings, and optional caps. */
function band(b: Builder, lo: P[], hi: P[]): void {
  const n = lo.length;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    b.tri(lo[k]!, hi[k]!, hi[k1]!);
    b.tri(lo[k]!, hi[k1]!, lo[k1]!);
  }
}
function cap(b: Builder, r: P[], apex: P, inward: P): void {
  for (let k = 0; k < r.length; k++) b.tri(r[k]!, r[(k + 1) % r.length]!, apex, inward);
}

/** Conifer: trunk and two (fine) or one (coarse) cone. */
export function treeMesh(fine: boolean): MeshData {
  const b = new Builder();
  const n = fine ? 7 : 4;
  if (fine) {
    const t0 = ring(5, 0.05, 0);
    const t1 = ring(5, 0.04, 0.3);
    band(b, t0, t1);
    const c0 = ring(n, 0.5, 0.18);
    cap(b, c0, [0, 0.72, 0], [0, 0, 0]);
    cap(b, c0, [0, 0.18, 0], [0, 1, 0]);
    const c1 = ring(n, 0.36, 0.5, 0.5);
    cap(b, c1, [0, 1, 0], [0, 0, 0]);
    cap(b, c1, [0, 0.5, 0], [0, 1, 0]);
  } else {
    const c0 = ring(n, 0.45, 0.1, 0.5);
    cap(b, c0, [0, 1, 0], [0, 0, 0]);
    cap(b, c0, [0, 0.1, 0], [0, 1, 0]);
  }
  return b.mesh();
}

/** Boulder: a lumpy sphere (fine: subdivided twice) sitting on its base. */
export function rockMesh(fine: boolean): MeshData {
  const b = new Builder();
  const base: P[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let tris: [P, P, P][] = [];
  for (const sx of [0, 1]) for (const sy of [2, 3]) for (const sz of [4, 5]) tris.push([base[sx]!, base[sy]!, base[sz]!]);
  const norm = (p: P): P => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  for (let s = 0; s < (fine ? 2 : 0); s++) {
    const next: [P, P, P][] = [];
    for (const [a, c, d] of tris) {
      const ab = norm([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2]);
      const bc = norm([(c[0] + d[0]) / 2, (c[1] + d[1]) / 2, (c[2] + d[2]) / 2]);
      const ca = norm([(d[0] + a[0]) / 2, (d[1] + a[1]) / 2, (d[2] + a[2]) / 2]);
      next.push([a, ab, ca], [ab, c, bc], [ca, bc, d], [ab, bc, ca]);
    }
    tris = next;
  }
  // Lumps from the direction (the same point gets the same radius in every triangle that shares it).
  const lump = (p: P): P => {
    const k = hashInts(77, Math.round(p[0] * 1000), Math.round(p[1] * 1000), Math.round(p[2] * 1000));
    const r = 0.82 + 0.3 * unit(k);
    // Flattened, base at 0, top at 1.
    return [p[0] * r * 0.5, (p[1] * r * 0.5 + 0.42) / 0.92, p[2] * r * 0.5];
  };
  for (const [a, c, d] of tris) b.tri(lump(a), lump(c), lump(d), [0, 0.45, 0]);
  return b.mesh();
}

/** Rock pillar: a tapering, jagged prism in stacked drums with a flat top. */
export function pillarMesh(fine: boolean): MeshData {
  const b = new Builder();
  const n = fine ? 7 : 5;
  const drums = fine ? 5 : 2;
  const rings: P[][] = [];
  for (let d = 0; d <= drums; d++) {
    const y = d / drums;
    const r = 0.5 * (1 - 0.35 * y) * (d === drums ? 0.85 : 1);
    rings.push(ring(n, r, y, d * 0.37, (k) => 0.82 + 0.3 * unit(hashInts(91, d, k))));
  }
  for (let d = 0; d < drums; d++) band(b, rings[d]!, rings[d + 1]!);
  cap(b, rings[drums]!, [0, 1.02, 0], [0, 0, 0]);
  return b.mesh();
}
