// Picking: what a ray (typically from `camera.screenRay`) hits first. Rough solids are enough here.
// The two ray tests below (`rayPrism`, `marchSurface`) are shared with the collision world (`collide.ts`); they take
// plain numbers and allocate nothing, the exported picking functions wrap them.

import { pointInRings } from '../gen-core/geometry.ts';
import type { Ring } from '../gen-core/geometry.ts';
import type { HeightField } from '../gen-core/height-field.ts';

/** Vertical prism: footprint extruded from `minY` to `maxY`. Rough solid shape for the query of what is under the cursor. */
export interface Prism {
  rings: Ring[];
  minY: number;
  maxY: number;
}

/**
 * Smallest ray parameter t in [tMin, tMax) at which the ray meets the prism over `rings` (top face, side walls and,
 * with `withBottom`, the bottom face), or Infinity. `minX`…`maxZ` is the footprint's rectangle for a quick rejection.
 * With `normal` the unit normal of the face hit, turned against the ray, is written to it. Internal to `world`.
 */
export function rayPrism(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  rings: Ring[], minY: number, maxY: number,
  minX: number, maxX: number, minZ: number, maxZ: number,
  tMin: number, tMax: number, withBottom: boolean,
  normal: Float64Array | null,
): number {
  // Quick rejection: rectangle around the footprint against the ray segment between the prism heights.
  const ta = Math.abs(dy) > 1e-9 ? (maxY - oy) / dy : -1e9;
  const tb = Math.abs(dy) > 1e-9 ? (minY - oy) / dy : 1e9;
  const xa = ox + dx * ta;
  const xb = ox + dx * tb;
  const za = oz + dz * ta;
  const zb = oz + dz * tb;
  if (Math.max(xa, xb) < minX || Math.min(xa, xb) > maxX || Math.max(za, zb) < minZ || Math.min(za, zb) > maxZ) return Infinity;
  let best = tMax;
  let face = 0; // 0 none, 1 top, 2 bottom, 3 side
  let nx = 0;
  let nz = 0;
  // Top face.
  if (ta >= tMin && ta < best && pointInRings(xa, za, rings)) {
    best = ta;
    face = 1;
  }
  if (withBottom && Math.abs(dy) > 1e-9 && tb >= tMin && tb < best && pointInRings(xb, zb, rings)) {
    best = tb;
    face = 2;
  }
  // Side walls: intersection of the ray's projection onto the x-z plane with the edge, and a height check.
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j * 2]!;
      const az = ring[j * 2 + 1]!;
      const ex = ring[i * 2]! - ax;
      const ez = ring[i * 2 + 1]! - az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - ox) * ez - (az - oz) * ex) / den;
      const u = ((ax - ox) * dz - (az - oz) * dx) / den;
      if (u < 0 || u > 1 || t >= best || t < tMin) continue;
      const y = oy + dy * t;
      if (y < minY || y > maxY) continue;
      best = t;
      face = 3;
      nx = ez;
      nz = -ex;
    }
  }
  if (face === 0) return Infinity;
  if (normal) {
    if (face === 3) {
      const len = Math.sqrt(nx * nx + nz * nz);
      nx /= len;
      nz /= len;
      if (nx * dx + nz * dz > 0) {
        nx = -nx;
        nz = -nz;
      }
      normal[0] = nx;
      normal[1] = 0;
      normal[2] = nz;
    } else {
      // A horizontal face: its normal points against the vertical part of the ray.
      normal[0] = 0;
      normal[1] = dy > 0 ? -1 : 1;
      normal[2] = 0;
    }
  }
  return best;
}

/**
 * First passage of a ray from above to below a surface y = heightAt(x, z) between t0 and t1: steps of `stepT`
 * along the ray, the passage refined by bisection. A passage where `inside` (when given) is false at both step ends
 * or at the refined point is skipped. Returns the parameter of the passage, or NaN. Internal to `world`.
 */
export function marchSurface(
  heightAt: (x: number, z: number) => number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  t0: number, t1: number, stepT: number,
  inside: ((t: number) => boolean) | null,
): number {
  let prevT = t0;
  let prev = oy + dy * t0 - heightAt(ox + dx * t0, oz + dz * t0);
  for (let t = t0 + stepT; t <= t1 + stepT; t += stepT) {
    const cur = oy + dy * t - heightAt(ox + dx * t, oz + dz * t);
    if (prev >= 0 && cur < 0 && (inside === null || inside(prevT) || inside(t))) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (oy + dy * mid - heightAt(ox + dx * mid, oz + dz * mid) >= 0) lo = mid;
        else hi = mid;
      }
      const th = (lo + hi) / 2;
      if (inside !== null && !inside(th)) return NaN;
      return th;
    }
    prevT = t;
    prev = cur;
  }
  return NaN;
}

/**
 * The first prism the ray hits, counted from the camera (smallest parameter t, even negative: the ray is a whole line).
 * The top face and side walls are used. A sloped top is flat here at its highest point, which is enough for picking.
 */
export function raycastPrisms(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  prisms: readonly Prism[],
): { index: number; t: number; point: [number, number, number] } | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  let best = Infinity;
  let bestIndex = -1;
  prisms.forEach((p, index) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const outer = p.rings[0];
    if (!outer) return;
    for (let i = 0; i < outer.length; i += 2) {
      minX = Math.min(minX, outer[i]!);
      maxX = Math.max(maxX, outer[i]!);
      minZ = Math.min(minZ, outer[i + 1]!);
      maxZ = Math.max(maxZ, outer[i + 1]!);
    }
    const t = rayPrism(ox, oy, oz, dx, dy, dz, p.rings, p.minY, p.maxY, minX, maxX, minZ, maxZ, -Infinity, best, false, null);
    if (t < best) {
      best = t;
      bestIndex = index;
    }
  });
  if (bestIndex < 0) return null;
  return { index: bestIndex, t: best, point: [ox + dx * best, oy + dy * best, oz + dz * best] };
}

/**
 * Where a ray first hits the height field from above, or `null` when it misses the field's extent.
 * Steps along the ray between the highest and lowest point and refines the intersection by bisection.
 */
export function raycastHeightField(field: HeightField, origin: readonly [number, number, number], dir: readonly [number, number, number]): [number, number, number] | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const inside = (t: number): boolean => {
    const x = ox + dx * t;
    const z = oz + dz * t;
    return x >= 0 && z >= 0 && x <= field.sizeX && z <= field.sizeZ;
  };
  // Ray segment between the highest and the lowest point of the field.
  let t0: number;
  let t1: number;
  if (Math.abs(dy) < 1e-9) {
    t0 = -1e5;
    t1 = 1e5;
  } else {
    const ta = (field.maxY + 0.01 - oy) / dy;
    const tb = (field.minY - 0.01 - oy) / dy;
    t0 = Math.min(ta, tb);
    t1 = Math.max(ta, tb);
  }
  const horiz = Math.hypot(dx, dz);
  const stepT = horiz > 1e-9 ? (field.step * 0.4) / horiz : (t1 - t0) / 4;
  const th = marchSurface((x, z) => field.heightAt(x, z), ox, oy, oz, dx, dy, dz, t0, t1, stepT, inside);
  if (Number.isNaN(th)) return null;
  const x = ox + dx * th;
  const z = oz + dz * th;
  return [x, field.heightAt(x, z), z];
}
