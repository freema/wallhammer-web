// The mesh builder of the figures: flat-shaded triangle soups in which every triangle has its own normal and its own flat
// colour. A vertex carries its colour and a material number (`MAT`): a plain colour, a colour multiplied by the
// instance's tint (the cloak of a traveller, its hair and skin), a light that always glows (a lantern, a torch) or
// one that glows more in the dark (embers, glowing cracks).
//
// Shapes are written in the figure's rest pose, in metres (x to the figure's left, y up, z forward, the origin on the
// ground under it); `origin` names the joint of the bone the following triangles hang on, so the mesh of a part ends
// up in its bone's frame.

import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';

export type P = readonly [number, number, number];
export type RGB = readonly [number, number, number];

/** Position, normal, colour and material number: 10 floats. */
export const FIGURE_LAYOUT: VertexLayout = {
  stride: 40,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
    { name: 'a_color', size: 4, type: 'f32', offset: 24 },
  ],
};

/** Material numbers of a vertex (`a_color.w`). */
export const MAT = { flat: 0, tint: 1, glow: 2, ember: 3 } as const;

/** A colour from its hex code, each channel from 0 to 1 on the display's scale. */
export const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: P, s: number): P => [a[0] * s, a[1] * s, a[2] * s];
export const lerp = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: P): P => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const centroid = (ps: readonly P[]): P => {
  let x = 0, y = 0, z = 0;
  for (const p of ps) (x += p[0]), (y += p[1]), (z += p[2]);
  return [x / ps.length, y / ps.length, z / ps.length];
};

/** A ring of `n` points about `c` in the plane of the unit axes `u` and `v`, radii `ru` and `rv`. */
export function ringOn(c: P, u: P, v: P, ru: number, rv: number, n: number, turn = 0): P[] {
  const out: P[] = [];
  for (let k = 0; k < n; k++) {
    const a = ((k + turn) / n) * Math.PI * 2;
    const cu = Math.cos(a) * ru, cv = Math.sin(a) * rv;
    out.push([c[0] + u[0] * cu + v[0] * cv, c[1] + u[1] * cu + v[1] * cv, c[2] + u[2] * cu + v[2] * cv]);
  }
  return out;
}
/** A level ring about `c`: radius `rx` along x and `rz` along z. */
export const ring = (c: P, rx: number, rz: number, n: number, turn = 0): P[] => ringOn(c, [1, 0, 0], [0, 0, 1], rx, rz, n, turn);

/**
 * A colour and a material number for a face from its centre and its normal (rest pose), or null for the painted ones:
 * a coat of two colours on one skin (a pale belly under a darker back).
 */
export type FaceTone = (centre: P, normal: P) => readonly [RGB, number] | null;

export class FigureMesh {
  private readonly v: number[] = [];
  private color: RGB = [1, 1, 1];
  private mat: number = MAT.flat;
  private vary = 0.1;
  private o: P = [0, 0, 0];
  private faces = 0;
  private toneOf: FaceTone | null = null;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Colour and material of the following triangles; `vary` is the share of the brightness that differs per face. */
  paint(color: RGB, mat: number = MAT.flat, vary = 0.1): this {
    this.color = color;
    this.mat = mat;
    this.vary = vary;
    return this;
  }

  /** A face tone over the paint for the following triangles (null: the paint alone). */
  tone(fn: FaceTone | null): this {
    this.toneOf = fn;
    return this;
  }

  /** The joint the following triangles hang on (rest pose). */
  origin(p: P): this {
    this.o = p;
    return this;
  }

  /** One triangle; with `away` it is wound to face away from that point, otherwise as given (counter-clockwise). */
  tri(a: P, b: P, c: P, away: P | null = null): void {
    let n = norm(cross(sub(b, a), sub(c, a)));
    if (away) {
      const m = centroid([a, b, c]);
      if ((m[0] - away[0]) * n[0] + (m[1] - away[1]) * n[1] + (m[2] - away[2]) * n[2] < 0) {
        n = [-n[0], -n[1], -n[2]];
        const t = b;
        b = c;
        c = t;
      }
    }
    const tone = 1 + this.vary * (unit(hashInts(this.seed, this.faces++)) - 0.5) * 2;
    let col = this.color, mat = this.mat;
    if (this.toneOf) {
      const t = this.toneOf(centroid([a, b, c]), n);
      if (t) (col = t[0]), (mat = t[1]);
    }
    const o = this.o;
    for (const p of [a, b, c]) this.v.push(p[0] - o[0], p[1] - o[1], p[2] - o[2], n[0], n[1], n[2], col[0] * tone, col[1] * tone, col[2] * tone, mat);
  }

  /** A triangle seen from both sides. */
  both(a: P, b: P, c: P): void {
    this.tri(a, b, c);
    this.faces--;
    this.tri(a, c, b);
  }

  quad(a: P, b: P, c: P, d: P, away: P | null = null): void {
    this.tri(a, b, c, away);
    this.tri(a, c, d, away);
  }

  /** A flat polygon seen from both sides (a fan from its first point). */
  plate(ps: readonly P[]): void {
    for (let k = 1; k + 1 < ps.length; k++) this.both(ps[0]!, ps[k]!, ps[k + 1]!);
  }

  /** A skin over rings of the same number of points, closed at the ends that are named. */
  loft(rings: readonly (readonly P[])[], capA = true, capB = true): void {
    const cs = rings.map(centroid);
    for (let r = 0; r + 1 < rings.length; r++) {
      const A = rings[r]!, B = rings[r + 1]!;
      const mid = lerp(cs[r]!, cs[r + 1]!, 0.5);
      for (let k = 0; k < A.length; k++) {
        const k1 = (k + 1) % A.length;
        // The diagonal alternates, so the facets do not all lean one way.
        if ((k + r) & 1) {
          this.tri(A[k]!, B[k]!, B[k1]!, mid);
          this.tri(A[k]!, B[k1]!, A[k1]!, mid);
        } else {
          this.tri(A[k]!, B[k]!, A[k1]!, mid);
          this.tri(A[k1]!, B[k]!, B[k1]!, mid);
        }
      }
    }
    const cap = (R: readonly P[], c: P, other: P): void => {
      for (let k = 0; k < R.length; k++) this.tri(R[k]!, R[(k + 1) % R.length]!, c, other);
    };
    const last = rings.length - 1;
    if (capA) cap(rings[0]!, cs[0]!, cs[1] ?? cs[0]!);
    if (capB) cap(rings[last]!, cs[last]!, cs[last - 1] ?? cs[last]!);
  }

  /** A tapered limb from `a` (radius `r0`) to `b` (radius `r1`); `flat` squeezes it along its second cross axis. */
  limb(a: P, b: P, r0: number, r1: number, sides = 5, flat = 1, turn = 0.5): void {
    const axis = norm(sub(b, a));
    const ref: P = Math.abs(axis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const u = norm(cross(ref, axis));
    const w = cross(axis, u);
    this.loft([ringOn(a, u, w, r0, r0 * flat, sides, turn), ringOn(b, u, w, r1, r1 * flat, sides, turn)]);
  }

  /** A box about `c`; `top` scales its upper face (a taper). */
  box(c: P, size: P, top = 1): void {
    const [x, y, z] = [size[0] / 2, size[1] / 2, size[2] / 2];
    this.loft([
      [[c[0] - x, c[1] - y, c[2] - z], [c[0] + x, c[1] - y, c[2] - z], [c[0] + x, c[1] - y, c[2] + z], [c[0] - x, c[1] - y, c[2] + z]],
      [[c[0] - x * top, c[1] + y, c[2] - z * top], [c[0] + x * top, c[1] + y, c[2] - z * top], [c[0] + x * top, c[1] + y, c[2] + z * top], [c[0] - x * top, c[1] + y, c[2] + z * top]],
    ]);
  }

  /**
   * A faceted lump about `c` with the half sizes `r`: `rows` rings of `n` points between two poles, every point moved
   * in or out by up to `rough` of its radius (seeded by `key`). A rock, a head, a crown of leaves.
   */
  blob(c: P, r: P, key: number, rough = 0.14, n = 6, rows = 2): void {
    const j = (i: number, k: number): number => 1 + rough * (unit(hashInts(this.seed, key, i, k)) - 0.5) * 2;
    const rings: P[][] = [];
    for (let i = 1; i <= rows; i++) {
      const lat = -Math.PI / 2 + (Math.PI * i) / (rows + 1);
      const y = Math.sin(lat), q = Math.cos(lat);
      rings.push(Array.from({ length: n }, (_, k): P => {
        const a = ((k + (i & 1) * 0.5) / n) * Math.PI * 2;
        const s = j(i, k);
        return [c[0] + Math.cos(a) * q * r[0] * s, c[1] + y * r[1] * (0.9 + 0.1 * s), c[2] + Math.sin(a) * q * r[2] * s];
      }));
    }
    const bottom: P = [c[0], c[1] - r[1] * j(0, 0), c[2]];
    const top: P = [c[0], c[1] + r[1] * j(rows + 1, 0), c[2]];
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      this.tri(rings[0]![k]!, rings[0]![k1]!, bottom, c);
      this.tri(rings[rows - 1]![k]!, rings[rows - 1]![k1]!, top, c);
    }
    for (let i = 0; i + 1 < rows; i++) {
      const A = rings[i]!, B = rings[i + 1]!;
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        // Rings are turned by half a step against each other: triangles zigzag between them.
        const even = (i & 1) === 0;
        this.tri(A[k]!, A[k1]!, B[even ? k1 : k]!, c);
        this.tri(B[k]!, B[k1]!, even ? A[k]! : A[k1]!, c);
      }
    }
  }

  /**
   * A bevelled boulder about `c` with the half sizes `r`: a belt of `n` upright faces between two bevels and two
   * nearly flat caps, every corner moved by up to `rough` of its radius (seeded by `key`), the whole turned by `turn`
   * of a face. Unlike `blob` it has no pointed poles: a stone that was rounded by weather, not a crystal.
   */
  rock(c: P, r: P, key: number, rough = 0.1, n = 6, turn = 0, bevel = 0.72): void {
    const j = (i: number, k: number): number => 1 + rough * (unit(hashInts(this.seed, key, i, k)) - 0.5) * 2;
    const at = (i: number, y: number, q: number): P[] =>
      Array.from({ length: n }, (_, k): P => {
        const a = ((k + turn) / n) * Math.PI * 2;
        const s = q * j(i, k);
        return [c[0] + Math.cos(a) * r[0] * s, c[1] + y * r[1] * (0.94 + 0.06 * j(i + 7, k)), c[2] + Math.sin(a) * r[2] * s];
      });
    const rings = [at(0, -1, bevel * 0.8), at(1, -0.45, 1), at(2, 0.45, 1), at(3, 1, bevel * 0.8)];
    for (let i = 0; i + 1 < rings.length; i++) {
      const A = rings[i]!, B = rings[i + 1]!;
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        if ((k + i) & 1) {
          this.tri(A[k]!, B[k]!, B[k1]!, c);
          this.tri(A[k]!, B[k1]!, A[k1]!, c);
        } else {
          this.tri(A[k]!, B[k]!, A[k1]!, c);
          this.tri(A[k1]!, B[k]!, B[k1]!, c);
        }
      }
    }
    for (const [R, y] of [[rings[0]!, -1.06], [rings[3]!, 1.06]] as const) {
      const m: P = [c[0], c[1] + y * r[1], c[2]];
      for (let k = 0; k < n; k++) this.tri(R[k]!, R[(k + 1) % n]!, m, c);
    }
  }

  /** A cone from a ring to an apex, closed underneath. */
  cone(base: readonly P[], apex: P): void {
    const c = centroid(base);
    for (let k = 0; k < base.length; k++) {
      const k1 = (k + 1) % base.length;
      this.tri(base[k]!, base[k1]!, apex, c);
      this.tri(base[k]!, base[k1]!, c, apex);
    }
  }

  get empty(): boolean {
    return this.v.length === 0;
  }

  /** The mesh, its positions multiplied by `size`. */
  mesh(size = 1): MeshData {
    const vertices = Float32Array.from(this.v);
    if (size !== 1) for (let i = 0; i < vertices.length; i += 10) (vertices[i]! *= size), (vertices[i + 1]! *= size), (vertices[i + 2]! *= size);
    return { layout: FIGURE_LAYOUT, vertices, indices: null, count: vertices.length / 10 };
  }
}
