// Shapes the cells place as instances: a conifer and a boulder, each with a fine and a coarse level of detail.
// Unit-sized, base at y = 0 and top at y = 1; the instance scales them (width, height, depth), turns them about their
// up and stands them along the local up of their base. Built once on the main thread, so they are not part of the
// cell bytes.

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

/** Flat-shaded triangle soup; each triangle is turned to face away from a reference point (the axis at its height by default). */
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
    if (out < 0) this.v.push(...a, -n[0], -n[1], -n[2], ...c, -n[0], -n[1], -n[2], ...b, -n[0], -n[1], -n[2]);
    else this.v.push(...a, ...n, ...b, ...n, ...c, ...n);
  }
  mesh(): MeshData {
    const vertices = Float32Array.from(this.v);
    return { layout: SHAPE_LAYOUT, vertices, indices: null, count: vertices.length / 6 };
  }
}

const ring = (n: number, r: number, y: number, turn = 0): P[] =>
  Array.from({ length: n }, (_, k) => {
    const a = ((k + turn) / n) * Math.PI * 2;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });

/** A cone from a ring to an apex, closed underneath. */
function cone(b: Builder, base: P[], apexY: number): void {
  const y = base[0]![1];
  for (let k = 0; k < base.length; k++) {
    const k1 = (k + 1) % base.length;
    b.tri(base[k]!, base[k1]!, [0, apexY, 0], [0, y, 0]);
    b.tri(base[k]!, base[k1]!, [0, y, 0], [0, apexY, 0]);
  }
}

/** Conifer: a trunk and three tiers of branches (fine), or one cone (coarse). */
export function treeMesh(fine: boolean): MeshData {
  const b = new Builder();
  if (!fine) {
    cone(b, ring(4, 0.45, 0.08, 0.5), 1);
    return b.mesh();
  }
  const t0 = ring(5, 0.05, 0);
  const t1 = ring(5, 0.04, 0.26);
  for (let k = 0; k < 5; k++) {
    const k1 = (k + 1) % 5;
    b.tri(t0[k]!, t1[k]!, t1[k1]!);
    b.tri(t0[k]!, t1[k1]!, t0[k1]!);
  }
  cone(b, ring(7, 0.5, 0.16), 0.6);
  cone(b, ring(7, 0.4, 0.4, 0.5), 0.82);
  cone(b, ring(6, 0.28, 0.64), 1);
  return b.mesh();
}

/** Boulder: a lumpy, flattened ball sitting on its base (fine: subdivided twice). */
export function rockMesh(fine: boolean): MeshData {
  const b = new Builder();
  const base: P[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let tris: [P, P, P][] = [];
  for (const sx of [0, 1]) for (const sy of [2, 3]) for (const sz of [4, 5]) tris.push([base[sx]!, base[sy]!, base[sz]!]);
  const norm = (p: P): P => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  const mid = (p: P, q: P): P => norm([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]);
  for (let s = 0; s < (fine ? 2 : 0); s++) {
    const next: [P, P, P][] = [];
    for (const [a, c, d] of tris) {
      const ab = mid(a, c);
      const bc = mid(c, d);
      const ca = mid(d, a);
      next.push([a, ab, ca], [ab, c, bc], [ca, bc, d], [ab, bc, ca]);
    }
    tris = next;
  }
  // Lumps from the direction, so a point gets the same radius in every triangle that shares it.
  const lump = (p: P): P => {
    const r = 0.8 + 0.32 * unit(hashInts(2611, Math.round(p[0] * 1000), Math.round(p[1] * 1000), Math.round(p[2] * 1000)));
    return [p[0] * r * 0.5, (p[1] * r * 0.5 + 0.4) / 0.96, p[2] * r * 0.5];
  };
  for (const [a, c, d] of tris) b.tri(lump(a), lump(c), lump(d), [0, 0.42, 0]);
  return b.mesh();
}
