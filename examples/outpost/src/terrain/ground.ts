// The terrain module: the ground mesh (gentle relief, shallow craters, a few flat colour patches), seeded angular
// rocks, tyre tracks along the rover's loop and its spurs, and the ring of far ridges on the horizon. Everything is a
// static piece; the ground and the tracks have no outline hull, the rocks and the ridges do.

import { valueNoise2 } from 'wallhammer-web/gen-core';
import { MeshBuilder } from '../kit/mesh.ts';
import { place, smoothstep } from '../kit/math.ts';
import type { V3 } from '../kit/math.ts';
import { rock } from '../kit/shapes.ts';
import { Stream } from '../kit/rng.ts';
import type { BuildContext, Contribution, OutpostModule } from '../kit/types.ts';
import type { Layout } from '../layout.ts';
import { rgb } from '../style/palette.ts';
import { TERRAIN_HALF } from './height.ts';
import type { Terrain } from './height.ts';

/** Grid lines per side of the ground mesh, and the share of linear spacing (the rest is cubic: fine in the middle). */
const GRID = 321;
const LINEAR = 0.36;

/** Ground coordinate of grid line i: about 0.77 m apart in the middle, about 4.3 m at the edge. */
function gridCoord(i: number): number {
  const u = (i / (GRID - 1)) * 2 - 1;
  return TERRAIN_HALF * (LINEAR * u + (1 - LINEAR) * u * u * u);
}

function groundMesh(ctx: BuildContext, t: Terrain): MeshBuilder {
  const b = new MeshBuilder();
  b.outline = false;
  const patch = new Stream(ctx.seed, 'ground-patches').seed;
  const xs = Array.from({ length: GRID }, (_, i) => gridCoord(i));
  const H = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) H[j * GRID + i] = t.heightAt(xs[i]!, xs[j]!);
  b.color = rgb('ground');
  const ids = new Uint32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = xs[i]!, z = xs[j]!;
      const i0 = Math.max(0, i - 1), i1 = Math.min(GRID - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(GRID - 1, j + 1);
      const dx = (H[j * GRID + i1]! - H[j * GRID + i0]!) / (xs[i1]! - xs[i0]!);
      const dz = (H[j1 * GRID + i]! - H[j0 * GRID + i]!) / (xs[j1]! - xs[j0]!);
      const l = Math.hypot(dx, 1, dz);
      // Flat tone patches (cut in the shader, so their edges stay smooth on the coarse far grid): large light and dark
      // blotches of regolith, and darker crater floors.
      const pn = valueNoise2(x, z, 38, patch) + 0.35 * (valueNoise2(x, z, 11, patch + 1) - 0.5);
      const k = smoothstep(0.08, 0.25, t.craterAt(x, z));
      b.tone = pn * (1 - k) + 0.12 * k;
      ids[j * GRID + i] = b.ink([x, H[j * GRID + i]!, z], [-dx / l, 1 / l, -dz / l]);
    }
  }
  for (let j = 0; j + 1 < GRID; j++) {
    for (let i = 0; i + 1 < GRID; i++) {
      const a = ids[j * GRID + i]!, c = ids[j * GRID + i + 1]!, d = ids[(j + 1) * GRID + i + 1]!, e = ids[(j + 1) * GRID + i]!;
      // Seen from above (+y) with z toward the viewer, a → e → d → c is counter-clockwise.
      b.quad(a, e, d, c);
    }
  }
  return b;
}

/** Seeded rocks off the sites and routes: many small, some medium, a few large. */
function rocks(ctx: BuildContext): { mesh: MeshBuilder; count: number } {
  const b = new MeshBuilder();
  const rng = ctx.rng('rocks');
  const shape = ctx.rng('rock-shapes');
  const placed: [number, number, number][] = [];
  const colours = [rgb('rock'), rgb('rock'), rgb('rockDark'), rgb('groundLight')];
  for (let i = 0; placed.length < 380 && i < 4000; i++) {
    const a = rng.at(i, 0) * Math.PI * 2;
    const d = 9 + 165 * Math.sqrt(rng.at(i, 1));
    const x = Math.sin(a) * d, z = Math.cos(a) * d - 4;
    const big = rng.at(i, 2) < 0.05;
    const s = big ? rng.range(1.4, 2.8, i, 3) : 0.35 + 1.15 * rng.at(i, 3) ** 2;
    if (ctx.layout.keepouts.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + s * 0.7)) continue;
    if (placed.some(([px, pz, ps]) => Math.hypot(px - x, pz - z) < (ps + s) * 0.6)) continue;
    placed.push([x, z, s]);
    const r = s / 2;
    const y = Math.min(ctx.heightAt(x, z), ctx.heightAt(x + r, z), ctx.heightAt(x - r, z), ctx.heightAt(x, z + r), ctx.heightAt(x, z - r));
    const size: V3 = [s * rng.range(0.85, 1.35, i, 4), s * rng.range(0.42, 0.78, i, 5), s * rng.range(0.85, 1.3, i, 6)];
    b.color = colours[rng.int(0, colours.length - 1, i, 7)]!;
    b.with(place(x, y, z, rng.at(i, 8) * Math.PI * 2), () => rock(b, shape, [i], size, { sink: size[1] * 0.22 }));
  }
  return { mesh: b, count: placed.length };
}

/** A path as dense points with unit tangents (closed loops wrap around). */
function densePath(pts: readonly [number, number][], closed: boolean, stepM: number): { x: number; z: number; tx: number; tz: number }[] {
  const out: { x: number; z: number; tx: number; tz: number }[] = [];
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const [ax, az] = pts[k]!, [cx, cz] = pts[(k + 1) % n]!;
    const len = Math.hypot(cx - ax, cz - az);
    const steps = Math.max(1, Math.round(len / stepM));
    for (let s = 0; s < steps; s++) out.push({ x: ax + ((cx - ax) * s) / steps, z: az + ((cz - az) * s) / steps, tx: (cx - ax) / len, tz: (cz - az) / len });
  }
  if (!closed) {
    const [x, z] = pts[n - 1]!;
    out.push({ x, z, tx: out[out.length - 1]!.tx, tz: out[out.length - 1]!.tz });
  } else out.push({ ...out[0]! });
  // Smooth the tangents a little so the strips do not kink at the polyline corners.
  for (let k = 1; k + 1 < out.length; k++) {
    const p = out[k - 1]!, q = out[k + 1]!;
    const tx = q.x - p.x, tz = q.z - p.z, l = Math.hypot(tx, tz) || 1;
    out[k]!.tx = tx / l;
    out[k]!.tz = tz / l;
  }
  return out;
}

/** Two wheel tracks along a path: darker strips with slanted tread bars, laid just over the ground. */
function tracks(b: MeshBuilder, ctx: BuildContext, pts: readonly [number, number][], closed: boolean): void {
  const path = densePath(pts, closed, 0.3);
  const halfGauge = 1.05, halfWidth = 0.23;
  const strip = rgb('track'), tread = rgb('tread');
  const up = (x: number, z: number): V3 => {
    const e = 0.3;
    const dx = (ctx.heightAt(x + e, z) - ctx.heightAt(x - e, z)) / (2 * e), dz = (ctx.heightAt(x, z + e) - ctx.heightAt(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  };
  for (const side of [-1, 1]) {
    b.color = strip;
    let prev: [number, number] | null = null;
    for (const p of path) {
      // The left of the direction of travel is (tz, −tx) seen from above.
      const nx = p.tz, nz = -p.tx;
      const cx = p.x + nx * halfGauge * side, cz = p.z + nz * halfGauge * side;
      const lx = cx + nx * halfWidth, lz = cz + nz * halfWidth, rx = cx - nx * halfWidth, rz = cz - nz * halfWidth;
      const l = b.ink([lx, ctx.heightAt(lx, lz) + 0.025, lz], up(lx, lz));
      const r = b.ink([rx, ctx.heightAt(rx, rz) + 0.025, rz], up(rx, rz));
      if (prev) b.quad(prev[1], r, l, prev[0]);
      prev = [l, r];
    }
    // Tread: a slanted bar every 0.3 m.
    b.color = tread;
    for (let k = 0; k < path.length; k++) {
      const p = path[k]!;
      const nx = p.tz, nz = -p.tx;
      const cx = p.x + nx * halfGauge * side, cz = p.z + nz * halfGauge * side;
      const w = halfWidth * 0.82, len = 0.06, slant = 0.08 * side;
      const corner = (a: number, s: number): [number, number] => [cx + nx * a * w + p.tx * (s * len + a * slant), cz + nz * a * w + p.tz * (s * len + a * slant)];
      const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map(([x, z]) => b.ink([x, ctx.heightAt(x, z) + 0.04, z], up(x, z)));
      // Bars run across the strip; order them counter-clockwise from above.
      b.quad(q[0]!, q[3]!, q[2]!, q[1]!);
    }
  }
}

/** The ring of far ridges: faceted, low and wide, rising from under the ground at `ridgeRadius` to peaks about 60 m further out (they must stay under the planet). */
function ridges(layout: Layout): MeshBuilder {
  const b = new MeshBuilder();
  const s1 = new Stream(layout.seed, 'ridge-peaks').seed;
  const s2 = new Stream(layout.seed, 'ridge-crags').seed;
  const R0 = layout.ridgeRadius;
  const rings = [R0, R0 + 18, R0 + 38, R0 + 60, R0 + 85, R0 + 115, R0 + 150];
  const around = 220;
  const point = (k: number, i: number): V3 => {
    const a = (k / around) * Math.PI * 2;
    const r = rings[i]!;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    // Peak height along the ring: ridged noise, sampled on a circle so it closes.
    const n1 = valueNoise2(Math.sin(a) * 300, Math.cos(a) * 300, 70, s1);
    const n2 = valueNoise2(Math.sin(a) * 300, Math.cos(a) * 300, 26, s1 + 1);
    const peak = 2 + 11 * (1 - Math.abs(2 * n1 - 1)) ** 1.6 + 3 * n2;
    const shape = smoothstep(R0, R0 + 60, r) * (1 - 0.4 * smoothstep(R0 + 85, R0 + 150, r));
    const crag = 1.5 * (valueNoise2(x, z, 16, s2) - 0.5) * shape;
    return [x, -4 + (peak + 4) * shape + crag, z];
  };
  b.color = rgb('ridge');
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < around; k++) {
      const a = point(k, i), c = point(k + 1, i), d = point(k + 1, i + 1), e = point(k, i + 1);
      // Facing the centre: seen from inside, a → e → d → c.
      for (const [p, q, r] of [[a, d, c], [a, e, d]] as const) {
        const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
        const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        b.tri(b.ink(p, [nx, ny, nz]), b.ink(q, [nx, ny, nz]), b.ink(r, [nx, ny, nz]));
      }
    }
  }
  return b;
}

export function terrainModule(t: Terrain): OutpostModule {
  return {
    name: 'terrain',
    build(ctx): Contribution {
      const trackMesh = new MeshBuilder();
      trackMesh.outline = false;
      tracks(trackMesh, ctx, ctx.layout.roverLoop, true);
      for (const spur of ctx.layout.trackSpurs) tracks(trackMesh, ctx, spur, false);
      const r = rocks(ctx);
      return {
        statics: [
          { name: 'ground', mesh: groundMesh(ctx, t) },
          { name: `rocks (${r.count})`, mesh: r.mesh },
          { name: 'tracks', mesh: trackMesh, kind: 'decal' },
          { name: 'ridges', mesh: ridges(ctx.layout), kind: 'backdrop' },
        ],
      };
    },
  };
}
