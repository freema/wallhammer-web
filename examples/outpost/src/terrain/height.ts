// The ground height: gentle seeded relief, shallow craters with a raised rim, flat pads under every site of the
// layout, and a slow rise toward the far ridges. One pure function of (x, z) that every module uses to stand things
// on the ground (`BuildContext.heightAt`).

import { valueNoise2 } from 'wallhammer-web/gen-core';
import { smoothstep } from '../kit/math.ts';
import { Stream } from '../kit/rng.ts';
import type { Layout } from '../layout.ts';

export interface Crater {
  x: number;
  z: number;
  r: number;
  depth: number;
}

export interface Terrain {
  heightAt(x: number, z: number): number;
  /** 0 outside every crater, up to 1 at a crater's centre (for the floor colour). */
  craterAt(x: number, z: number): number;
  craters: readonly Crater[];
}

/** Half the edge of the square the terrain mesh covers, metres. */
export const TERRAIN_HALF = 340;

/** Craters: the fixed big one, then seeded ones off the sites and routes, larger ones farther out. */
function placeCraters(layout: Layout): Crater[] {
  const rng = new Stream(layout.seed, 'craters');
  const out: Crater[] = [{ ...layout.bigCrater }];
  for (let i = 0; out.length < 46 && i < 600; i++) {
    const a = rng.at(i, 0) * Math.PI * 2;
    const d = 18 + 150 * Math.sqrt(rng.at(i, 1));
    const x = Math.sin(a) * d, z = Math.cos(a) * d - 10;
    const r = 1.4 + (d > 60 ? 7 : 3.2) * rng.at(i, 2) ** 2;
    if (layout.keepouts.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + r * 1.25)) continue;
    if (out.some((c) => Math.hypot(c.x - x, c.z - z) < (c.r + r) * 1.1)) continue;
    out.push({ x, z, r, depth: r * rng.range(0.12, 0.2, i, 3) });
  }
  return out;
}

export function terrain(layout: Layout): Terrain {
  const s1 = new Stream(layout.seed, 'relief-1').seed;
  const s2 = new Stream(layout.seed, 'relief-2').seed;
  const s3 = new Stream(layout.seed, 'relief-3').seed;
  const craters = placeCraters(layout);
  const station = layout.domes.central;

  const relief = (x: number, z: number): number =>
    1.3 * (valueNoise2(x, z, 64, s1) - 0.5) * 2 + 0.45 * (valueNoise2(x, z, 23, s2) - 0.5) * 2 + 0.1 * (valueNoise2(x, z, 7, s3) - 0.5) * 2;

  const craterHeight = (x: number, z: number): number => {
    let h = 0;
    for (const c of craters) {
      const dx = x - c.x, dz = z - c.z;
      const reach = c.r * 1.8;
      if (dx * dx + dz * dz > reach * reach) continue;
      const q = Math.sqrt(dx * dx + dz * dz) / c.r;
      // A bowl with a flattish floor inside the rim, and a rim bump that fades out past it.
      const bowl = q < 1 ? -c.depth * (1 - q * q) ** 1.4 : 0;
      const rim = 0.32 * c.depth * Math.exp(-(((q - 1) / 0.26) ** 2));
      h += bowl + rim;
    }
    return h;
  };

  const heightAt = (x: number, z: number): number => {
    const dStation = Math.hypot(x - station.x, z - station.z - 4);
    // Calmer ground around the station, the full relief farther out, rising toward the ridges.
    let h = relief(x, z) * (0.35 + 0.65 * smoothstep(30, 75, dStation));
    h += 2.5 * smoothstep(130, 300, Math.hypot(x, z));
    h += craterHeight(x, z);
    for (const p of layout.pads) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d >= p.r + p.fall) continue;
      const w = 1 - smoothstep(p.r, p.r + p.fall, d);
      h = h + (p.y - h) * w;
    }
    return h;
  };

  const craterAt = (x: number, z: number): number => {
    let m = 0;
    for (const c of craters) {
      const q = Math.hypot(x - c.x, z - c.z) / c.r;
      if (q < 1) m = Math.max(m, 1 - q);
    }
    return m;
  };

  return { heightAt, craterAt, craters };
}
