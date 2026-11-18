// The scene as pure data: an island of rolling ground, a ring of standing stones, scattered boulders and a ring-shaped
// sculpture in the middle. Every function is a pure function of the seed, so the same seed always builds the same scene.

import { HeightField, rand, randRange, streamSeed, valueNoise2 } from 'wallhammer-web/gen-core';
import type { InstanceData, MeshData, VertexLayout } from 'wallhammer-web/base';

/** Island size in metres and grid step. */
export const ISLAND_SIZE_M = 168;
const STEP_M = 2;
/** Radius of the stone ring around the island centre. */
const RING_RADIUS_M = 27;
/** Radius of the cart track round the outside of the ring; boulders keep off it. */
export const TRACK_RADIUS_M = 37;
/** Turn of the ring sculpture's plane around the vertical axis, radians. */
export const RING_YAW = 0.6;

/** Solid meshes: position and normal, both float. */
export const SOLID_LAYOUT: VertexLayout = {
  stride: 24,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
  ],
};
export const SOLID_ATTRIBS = { a_pos: 0, a_normal: 1, i_base: 2, i_shape: 3 } as const;

/** One stone instance: base x, y, z, reach radius | height, yaw, width scale, depth scale. */
export const STONE_LAYOUT: VertexLayout = {
  stride: 32,
  attribs: [
    { name: 'i_base', size: 4, type: 'f32', offset: 0 },
    { name: 'i_shape', size: 4, type: 'f32', offset: 16 },
  ],
};
/** Where culling finds the base point, reach radius and height (float offsets inside one instance). */
export const STONE_BOUNDS = { position: 0, radius: 3, height: 4 } as const;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Rolling ground that falls away toward the rim of the island. */
export function islandField(seed: number): HeightField {
  const s = streamSeed(String(seed), 'ground');
  const n = Math.round(ISLAND_SIZE_M / STEP_M) + 1;
  const c = ISLAND_SIZE_M / 2;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * STEP_M;
      const z = j * STEP_M;
      const r = Math.hypot(x - c, z - c) / (ISLAND_SIZE_M * 0.46);
      const hills = 0.55 * valueNoise2(x, z, 48, s) + 0.3 * valueNoise2(x, z, 21, s + 1) + 0.15 * valueNoise2(x, z, 9, s + 2);
      // A gentle bowl where the ring stands, so the stones read against the sky from every side.
      const bowl = 1 - 0.35 * Math.exp(-(((r * ISLAND_SIZE_M * 0.46 - RING_RADIUS_M) / 14) ** 2));
      heights[j * n + i] = (2 + 9 * hills * bowl) * smooth(1.02, 0.7, r) - 3 * smooth(0.85, 1.1, r);
    }
  }
  return new HeightField(STEP_M, n, n, heights);
}

/** Writes one vertex. */
function put(v: number[], p: readonly number[], n: readonly number[]): void {
  v.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!);
}

function mesh(v: number[], idx: number[]): MeshData {
  return { layout: SOLID_LAYOUT, vertices: new Float32Array(v), indices: new Uint32Array(idx), count: idx.length };
}

/**
 * A standing slab of unit width, depth 0.45 and height 1, narrowing slightly toward a bevelled top. Flat-shaded faces,
 * so the light breaks crisply on the edges.
 */
export function slabMesh(): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const w0 = 0.5;
  const d0 = 0.22;
  const w1 = 0.4;
  const d1 = 0.17;
  const top = 0.94;
  const ring = (w: number, d: number, y: number): number[][] => [
    [-w, y, -d],
    [w, y, -d],
    [w, y, d],
    [-w, y, d],
  ];
  const lo = ring(w0, d0, -0.3);
  const hi = ring(w1, d1, top);
  const cap = ring(w1 * 0.7, d1 * 0.6, 1);
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    const nn = [n[0]! / l, n[1]! / l, n[2]! / l];
    const base = v.length / 6;
    for (const p of [a, b, c, d]) put(v, p, nn);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    quad(lo[k]!, hi[k]!, hi[k1]!, lo[k1]!);
    quad(hi[k]!, cap[k]!, cap[k1]!, hi[k1]!);
  }
  quad(cap[0]!, cap[3]!, cap[2]!, cap[1]!);
  return mesh(v, idx);
}

/** A rounded boulder: a subdivided cube pushed toward a sphere and dented by noise. Smooth normals. */
export function boulderMesh(seed: number): MeshData {
  const s = streamSeed(String(seed), 'boulder');
  const N = 6;
  const v: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const shape = (d: number[]): number[] => {
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    const u = [d[0]! / l, d[1]! / l, d[2]! / l];
    const dent = 0.82 + 0.3 * valueNoise2(u[0]! * 3 + 9, u[2]! * 3 + u[1]! * 2.1 + 9, 1, s);
    // Flattened underneath, so the boulder sits on the ground.
    return [u[0]! * dent, Math.max(u[1]! * dent * 0.7, -0.15), u[2]! * dent];
  };
  for (const [nrm, a, b] of faces) {
    const base = v.length / 6;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const fa = (i / N) * 2 - 1;
        const fb = (j / N) * 2 - 1;
        const at = (da: number, db: number): number[] =>
          shape([nrm[0]! + a[0]! * (fa + da) + b[0]! * (fb + db), nrm[1]! + a[1]! * (fa + da) + b[1]! * (fb + db), nrm[2]! + a[2]! * (fa + da) + b[2]! * (fb + db)]);
        const p = at(0, 0);
        const e = 0.02;
        const pa = at(e, 0);
        const pb = at(0, e);
        const t1 = [pa[0]! - p[0]!, pa[1]! - p[1]!, pa[2]! - p[2]!];
        const t2 = [pb[0]! - p[0]!, pb[1]! - p[1]!, pb[2]! - p[2]!];
        let n = [t1[1]! * t2[2]! - t1[2]! * t2[1]!, t1[2]! * t2[0]! - t1[0]! * t2[2]!, t1[0]! * t2[1]! - t1[1]! * t2[0]!];
        const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
        n = [n[0]! / l, n[1]! / l, n[2]! / l];
        // Outward: the normal must point away from the centre.
        if (n[0]! * p[0]! + n[1]! * p[1]! + n[2]! * p[2]! < 0) n = [-n[0]!, -n[1]!, -n[2]!];
        put(v, p, n);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const q = base + j * (N + 1) + i;
        idx.push(q, q + 1, q + N + 2, q, q + N + 2, q + N + 1);
      }
    }
  }
  // Winding: make every triangle face along its normal.
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
    const P = (k: number, o: number): number => v[k * 6 + o]!;
    const e1 = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)];
    const e2 = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    if (cx * P(a, 3) + cy * P(a, 4) + cz * P(a, 5) < 0) {
      idx[t + 1] = c;
      idx[t + 2] = b;
    }
  }
  return mesh(v, idx);
}

/** A ring standing on its edge, its plane turned by `yaw`, centred `radius` above the base point. */
export function ringMesh(base: readonly [number, number, number], radius: number, tube: number, yaw: number): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const U = 96;
  const V = 20;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  for (let i = 0; i <= U; i++) {
    const a = (i / U) * Math.PI * 2;
    for (let j = 0; j <= V; j++) {
      const b = (j / V) * Math.PI * 2;
      // Local: the ring lies in the x-y plane.
      const n = [Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)];
      const p = [Math.cos(a) * radius + n[0]! * tube, Math.sin(a) * radius + n[1]! * tube + radius, n[2]! * tube];
      const rot = (q: number[]): number[] => [q[0]! * cy + q[2]! * sy, q[1]!, -q[0]! * sy + q[2]! * cy];
      const wp = rot(p);
      put(v, [wp[0]! + base[0], wp[1]! + base[1] - tube * 0.6, wp[2]! + base[2]], rot(n));
    }
  }
  for (let i = 0; i < U; i++) {
    for (let j = 0; j < V; j++) {
      const q = i * (V + 1) + j;
      idx.push(q, q + V + 1, q + 1, q + 1, q + V + 1, q + V + 2);
    }
  }
  return mesh(v, idx);
}

/** Pushes one stone instance. */
function stone(out: number[], x: number, z: number, field: HeightField, height: number, yaw: number, width: number, depth: number): void {
  const reach = Math.hypot(width, depth) * 0.75;
  out.push(x, field.heightAt(x, z), z, reach, height, yaw, width, depth);
}

/** The standing stones: a ring facing its centre, with a gap toward the low sun of the evening. */
export function standingStones(field: HeightField, seed: number): InstanceData {
  const s = streamSeed(String(seed), 'stones');
  const c = ISLAND_SIZE_M / 2;
  const out: number[] = [];
  const count = 13;
  for (let k = 0; k < count; k++) {
    if (k === 9) continue;
    const a = (k / count) * Math.PI * 2 + randRange(-0.06, 0.06, s, k, 0);
    const r = RING_RADIUS_M + randRange(-1.2, 1.2, s, k, 1);
    const x = c + Math.cos(a) * r;
    const z = c + Math.sin(a) * r;
    const yaw = -a + Math.PI / 2 + randRange(-0.15, 0.15, s, k, 2);
    stone(out, x, z, field, randRange(5.5, 9, s, k, 3), yaw, randRange(2.2, 3.2, s, k, 4), randRange(2.2, 3.2, s, k, 5));
  }
  return { layout: STONE_LAYOUT, data: new Float32Array(out) };
}

/** Boulders scattered over the island, away from the ring and the centre. */
export function boulders(field: HeightField, seed: number): InstanceData {
  const s = streamSeed(String(seed), 'boulders');
  const c = ISLAND_SIZE_M / 2;
  const out: number[] = [];
  for (let k = 0; k < 600 && out.length < 150 * 8; k++) {
    const x = randRange(8, ISLAND_SIZE_M - 8, s, k, 0);
    const z = randRange(8, ISLAND_SIZE_M - 8, s, k, 1);
    const r = Math.hypot(x - c, z - c);
    if (r < 12 || Math.abs(r - RING_RADIUS_M) < 4.5 || Math.abs(r - TRACK_RADIUS_M) < 4.5 || r > ISLAND_SIZE_M * 0.4) continue;
    // Boulders gather in clusters: noise decides where they lie.
    if (valueNoise2(x, z, 30, s) < 0.45 + 0.3 * rand(s, k, 2)) continue;
    const size = 0.5 + 1.8 * rand(s, k, 3) ** 2;
    stone(out, x, z, field, size * randRange(0.8, 1.2, s, k, 4), rand(s, k, 5) * Math.PI * 2, size, size * randRange(0.8, 1.25, s, k, 6));
  }
  return { layout: STONE_LAYOUT, data: new Float32Array(out) };
}

/** A flat square of water around the island, `reach` metres past each edge, at height `y`. */
export function seaMesh(y: number, reach: number): MeshData {
  const a = -reach;
  const b = ISLAND_SIZE_M + reach;
  const v: number[] = [];
  for (const [x, z] of [[a, a], [b, a], [b, b], [a, b]]) put(v, [x!, y, z!], [0, 1, 0]);
  return mesh(v, [0, 2, 1, 0, 3, 2]);
}
