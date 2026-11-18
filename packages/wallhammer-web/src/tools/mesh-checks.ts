// Checks of built geometry without a browser, for a project's own inspection scripts. They read plain numbers only
// (positions, indices, a height function, a collision world) and allocate freely: run them in a script, not per frame.
//
// - `meshParts` splits a mesh into connected parts (shared triangles, or vertices at the same place) with their
//   bounds and their lowest gap over the ground.
// - `floatingParts` finds the parts that neither reach the ground nor touch, directly or through others, a part that
//   does: something hanging in the air.
// - `routeClearance` walks a route (x, z points) and reports where it comes closest to a solid of a collision world.

import { distToSegment } from '../gen-core/geometry.ts';
import type { CollisionWorld } from '../world/collide.ts';

/** One connected part of a mesh. */
export interface MeshPart {
  /** The caller's name for the mesh it came from. */
  label: string;
  /** Bounds in world space. */
  min: [number, number, number];
  max: [number, number, number];
  /** Lowest height of a vertex over the ground (negative: below it). */
  gap: number;
  /** x, z of that vertex. */
  at: [number, number];
  vertices: number;
}

export interface MeshPartsOptions {
  /** Height of the ground under a point. */
  heightAt(x: number, z: number): number;
  /** Name carried by every part (default ''). */
  label?: string;
  /** Numbers per vertex in `positions`, the position being the first three. Default 3. */
  stride?: number;
  /** Mesh space → world: 12 numbers, linear part column by column then the translation (an instance record). */
  transform?: ArrayLike<number> | null;
  /** Vertices closer than this count as one place (parts that only share a position are one), metres. Default 0.01. */
  weld?: number;
}

/** Splits a triangle mesh into connected parts: triangles sharing a vertex, or vertices within `weld` of each other. */
export function meshParts(positions: ArrayLike<number>, indices: ArrayLike<number>, o: MeshPartsOptions): MeshPart[] {
  const stride = o.stride ?? 3;
  const n = Math.floor(positions.length / stride);
  const m = o.transform ?? null;
  const P = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = positions[i * stride]!;
    const y = positions[i * stride + 1]!;
    const z = positions[i * stride + 2]!;
    if (m) {
      P[i * 3] = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
      P[i * 3 + 1] = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
      P[i * 3 + 2] = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
    } else {
      P[i * 3] = x;
      P[i * 3 + 1] = y;
      P[i * 3 + 2] = z;
    }
  }
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const union = (a: number, b: number): void => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent[x] = y;
  };
  const weld = o.weld ?? 0.01;
  const byPos = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(P[i * 3]! / weld)},${Math.round(P[i * 3 + 1]! / weld)},${Math.round(P[i * 3 + 2]! / weld)}`;
    const j = byPos.get(k);
    if (j === undefined) byPos.set(k, i);
    else union(i, j);
  }
  for (let k = 0; k + 2 < indices.length; k += 3) {
    union(indices[k]!, indices[k + 1]!);
    union(indices[k]!, indices[k + 2]!);
  }
  const used = new Uint8Array(n);
  for (let k = 0; k < indices.length; k++) used[indices[k]!] = 1;
  const parts = new Map<number, MeshPart>();
  const label = o.label ?? '';
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const r = find(i);
    const x = P[i * 3]!;
    const y = P[i * 3 + 1]!;
    const z = P[i * 3 + 2]!;
    let p = parts.get(r);
    if (!p) parts.set(r, (p = { label, min: [x, y, z], max: [x, y, z], gap: Infinity, at: [x, z], vertices: 0 }));
    p.vertices++;
    if (x < p.min[0]) p.min[0] = x;
    if (y < p.min[1]) p.min[1] = y;
    if (z < p.min[2]) p.min[2] = z;
    if (x > p.max[0]) p.max[0] = x;
    if (y > p.max[1]) p.max[1] = y;
    if (z > p.max[2]) p.max[2] = z;
    const g = y - o.heightAt(x, z);
    if (g < p.gap) {
      p.gap = g;
      p.at = [x, z];
    }
  }
  return [...parts.values()];
}

export interface FloatingOptions {
  /** A part whose lowest vertex is at most this high over the ground rests on it, metres. Default 0.05. */
  groundTolerance?: number;
  /** Two parts whose bounds come this close touch, metres. Default 0.02. */
  touchTolerance?: number;
}

/**
 * The parts that hang in the air: neither reaching the ground (within `groundTolerance`) nor touching (bounds within
 * `touchTolerance`) a part that rests, directly or through a chain of touching parts. Pass the parts of every mesh
 * that may hold another up together.
 */
export function floatingParts(parts: readonly MeshPart[], o: FloatingOptions = {}): MeshPart[] {
  const tol = o.groundTolerance ?? 0.05;
  const touch = o.touchTolerance ?? 0.02;
  const rests = parts.map((p) => p.gap <= tol);
  const touches = (a: MeshPart, b: MeshPart): boolean => {
    for (let k = 0; k < 3; k++) if (a.min[k]! > b.max[k]! + touch || b.min[k]! > a.max[k]! + touch) return false;
    return true;
  };
  // Spread "rests" over touching parts until nothing changes.
  const queue: number[] = [];
  rests.forEach((r, i) => r && queue.push(i));
  while (queue.length > 0) {
    const a = parts[queue.pop()!]!;
    for (let j = 0; j < parts.length; j++) {
      if (rests[j] || !touches(a, parts[j]!)) continue;
      rests[j] = true;
      queue.push(j);
    }
  }
  return parts.filter((_, i) => !rests[i]);
}

/** Where a route comes closest to a solid. */
export interface RouteClearance {
  /** Horizontal distance from the route to the solid's side (0 or less: the route enters it), metres; Infinity: no solid. */
  distance: number;
  /** The route point. */
  x: number;
  z: number;
  /** The solid's id and tag (−1: none). */
  solid: number;
  tag: number;
}

export interface RouteClearanceOptions {
  /** The route is a closed loop. Default false. */
  closed?: boolean;
  /** Spacing of the points checked along the route, metres. Default 0.25. */
  step?: number;
  /** Only solids that overlap this height span count (the body that walks the route). Default all. */
  minY?: number;
  maxY?: number;
  /** Solids left out (for example the thing that drives the route). */
  ignore?: (id: number, tag: number) => boolean;
}

/**
 * The least horizontal distance between a route (x, z pairs) and the sides of the solids of a collision world (the
 * base surface does not count), sampled every `step` along the route.
 */
export function routeClearance(world: CollisionWorld, route: ArrayLike<number>, o: RouteClearanceOptions = {}): RouteClearance {
  const solids: { id: number; tag: number; ring: Float32Array | null; x: number; z: number; r: number }[] = [];
  const lo = o.minY ?? -Infinity;
  const hi = o.maxY ?? Infinity;
  world.forEachSolid((id, s) => {
    if (s.maxY < lo || s.minY > hi) return;
    if (o.ignore?.(id, s.tag)) return;
    solids.push({ id, tag: s.tag, ring: s.outline, x: s.x, z: s.z, r: s.radius });
  });
  const best: RouteClearance = { distance: Infinity, x: 0, z: 0, solid: -1, tag: -1 };
  const check = (x: number, z: number): void => {
    for (const s of solids) {
      let d: number;
      if (s.ring) {
        const ring = s.ring;
        const n = ring.length / 2;
        d = Infinity;
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ax = ring[j * 2]!;
          const az = ring[j * 2 + 1]!;
          const bx = ring[i * 2]!;
          const bz = ring[i * 2 + 1]!;
          d = Math.min(d, distToSegment(x, z, ax, az, bx, bz));
          if (bz > z !== az > z && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
        }
        if (inside) d = -d;
      } else d = Math.hypot(x - s.x, z - s.z) - s.r;
      if (d < best.distance) {
        best.distance = d;
        best.x = x;
        best.z = z;
        best.solid = s.id;
        best.tag = s.tag;
      }
    }
  };
  const n = Math.floor(route.length / 2);
  if (n === 0) return best;
  const step = o.step ?? 0.25;
  const segs = o.closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const ax = route[k * 2]!;
    const az = route[k * 2 + 1]!;
    const bx = route[((k + 1) % n) * 2]!;
    const bz = route[((k + 1) % n) * 2 + 1]!;
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let i = 0; i < m; i++) check(ax + ((bx - ax) * i) / m, az + ((bz - az) * i) / m);
  }
  if (!o.closed) check(route[(n - 1) * 2]!, route[(n - 1) * 2 + 1]!);
  return best;
}
