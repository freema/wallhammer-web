// The river's water surface (owner: terrain, B2/B3): one water mesh from the upstream gorge to the downstream gorge.
//
//   surface   stations every ~0.6 m along the river (finer over the weir), 15 columns across; the surface reaches
//             0.9 m under the banks where it fades to clear (alpha 0), so the bank line is soft
//   weir      the falling sheet over the weir follows the layout's step (a parabola over 1.2 m): faster, all foam,
//             its normals tilted downstream; below it a churning plunge pool whose foam thins out over ~7 m
//   foam      a little along the banks, rings round every stone standing in the water and a wake behind it,
//             churn round the mill wheel and behind it
//   flow      direction along the river in every vertex, speed faster in the middle and on the weir
//   ends      the surface runs 4 m past both ends of the river into the hills, so the ground hides the cut
//
// Water vertex meaning (kit/types.ts): rgb tint, the `ao` slot is opacity, flags from `waterFlags(foam, speed, dir)`.

import { valueNoise2 } from 'wallhammer-web/gen-core';
import { MAT, MeshBuilder, PALETTE, clamp, hex, mixRgb, norm3, smoothstep, waterFlags } from '../kit/index.ts';
import type { BuildContext, ContentModule, SolidDef } from '../kit/index.ts';
import { riverAt } from '../layout.ts';
import { bridgeFrame, frameAt, riverStones, within } from './common.ts';

/** Fall of the water over the weir: the layout's surface step (layout.ts buildRiver). */
export const WEIR_FALL = 1.2;

const DEEP = hex('#2a6178');
const SHALLOW = hex('#4f8f8c');

/** Surface height `d` metres downstream of the weir crest, on the falling sheet. */
export const nappeY = (top: number, bottom: number, d: number): number => {
  const t = clamp(d / WEIR_FALL, 0, 1);
  return top + (bottom - top) * t * t;
};

export const water: ContentModule = {
  name: 'water',
  build(ctx) {
    const { layout } = ctx;
    const { river, weir, millWheel: wheel } = layout;
    const seed = ctx.stream('water').seed;
    const total = river.lengths[river.lengths.length - 1]!;
    const stones = riverStones(ctx);
    const b = new MeshBuilder().set({ cls: MAT.generic });

    // Stations along the river: regular, plus a fine run over the weir's fall.
    const stations: number[] = [];
    for (let a = -4; a < weir.along - 0.3; a += 0.6) stations.push(a);
    for (const d of [0, 0.12, 0.3, 0.5, 0.72, 0.95, WEIR_FALL]) stations.push(weir.along + d);
    for (let a = weir.along + WEIR_FALL + 0.4; a < total + 4; a += 0.6) stations.push(a);
    stations.push(total + 4);

    // Columns across: s = −1 / 1 at the water's edge, beyond it to 0.9 m under the bank.
    const cols = [-1.2, -1, -0.86, -0.7, -0.5, -0.32, -0.16, 0, 0.16, 0.32, 0.5, 0.7, 0.86, 1, 1.2];
    const f = { x: 0, z: 0, dx: 0, dz: 1 };
    const first = b.indexCount;
    const v0 = b.vertexCount;
    for (const a of stations) {
      const ac = clamp(a, 0, total);
      frameAt(river.line, river.lengths, ac, f);
      // Past the ends: straight on along the end direction.
      const ext = a - ac;
      const cx = f.x + f.dx * ext, cz = f.z + f.dz * ext;
      const at = riverAt(river, ac);
      const d = a - weir.along;
      const onFall = d >= 0 && d <= WEIR_FALL;
      const y = onFall ? nappeY(weir.top, weir.bottom, d) : at.y;
      // Slope of the surface along the flow (for the falling sheet's normal).
      const slope = onFall ? ((weir.bottom - weir.top) * 2 * (d / WEIR_FALL)) / WEIR_FALL : 0;
      const half = at.width / 2;
      const pool = d > WEIR_FALL ? 1 - smoothstep(0, 7, d - WEIR_FALL) : 0;
      const approach = d < 0 ? 1 - smoothstep(0, 6, -d) : 0;
      for (const sc of cols) {
        const edge = Math.abs(sc);
        const v = sc <= -1 ? -(half + (edge - 1) * 4.5) : sc >= 1 ? half + (edge - 1) * 4.5 : sc * half;
        const x = cx + f.dz * v, z = cz - f.dx * v;
        const n1 = valueNoise2(x, z, 1.6, seed);
        const n2 = valueNoise2(x, z, 4.5, seed + 1);
        // Foam: banks, the fall, the pool, the stones, the wheel.
        let foam = smoothstep(0.78, 1, edge) * (0.18 + 0.25 * n1);
        if (onFall) foam = Math.max(foam, 0.55 + 0.45 * smoothstep(0.2, 1, d / WEIR_FALL));
        foam = Math.max(foam, pool * (0.55 + 0.4 * n1) * (0.6 + 0.4 * pool));
        let speed = 0.24 + 0.16 * (1 - smoothstep(0.3, 1, edge)) + approach * 0.25 + pool * 0.35;
        if (onFall) speed = 1;
        for (const st of stones) {
          const ox = x - st.x, oz = z - st.z;
          const dist = Math.hypot(ox, oz);
          if (dist > st.r + 6) continue;
          foam = Math.max(foam, within(dist - st.r, 0.05, 0.75) * (0.65 + 0.3 * n1));
          // Wake: downstream of the stone, widening and fading.
          const u = ox * f.dx + oz * f.dz;
          const l = Math.abs(ox * f.dz - oz * f.dx);
          if (u > 0) foam = Math.max(foam, (1 - smoothstep(0, 4.5, u)) * within(l, st.r * 0.4, st.r * (0.9 + u * 0.15)) * (0.35 + 0.35 * n2));
          speed = Math.max(speed, 0.45 * within(dist - st.r, 0, 1));
        }
        {
          const ox = x - wheel.x, oz = z - wheel.z;
          const dist = Math.hypot(ox, oz);
          if (dist < 10) {
            foam = Math.max(foam, within(dist, 1.2, 2.6) * (0.6 + 0.3 * n1));
            const u = ox * f.dx + oz * f.dz;
            const l = Math.abs(ox * f.dz - oz * f.dx);
            if (u > 0) foam = Math.max(foam, (1 - smoothstep(0, 7, u)) * within(l, 0.8, 1.8 + u * 0.2) * (0.4 + 0.3 * n2));
            speed = Math.max(speed, 0.55 * within(dist, 1, 2.6));
          }
        }
        foam = clamp(foam, 0, 1);
        b.set(waterFlags(foam, clamp(speed, 0, 1), f.dx, f.dz));
        // Tint: deep in the middle, shallow and greener toward the banks, lighter where it churns.
        let col = mixRgb(DEEP, SHALLOW, smoothstep(0.35, 1, edge) * (0.7 + 0.3 * n2));
        col = mixRgb(col, PALETTE.waterShallow, pool * 0.3);
        // Opacity: clear over the shallows, gone under the bank.
        const alpha = edge > 1 ? 0 : 0.88 - 0.4 * smoothstep(0.6, 1, edge);
        const n = slope === 0 ? ([0, 1, 0] as const) : norm3([-slope * f.dx, 1, -slope * f.dz]);
        b.vertex([x, y, z], n, col, alpha);
      }
    }
    const nc = cols.length;
    for (let j = 0; j < stations.length - 1; j++) {
      for (let i = 0; i < nc - 1; i++) {
        const v = v0 + j * nc + i;
        b.quad(v, v + nc, v + nc + 1, v + 1);
      }
    }
    // Every triangle faces up (seen from above), whatever the bends did to the winding.
    for (let t = first; t < b.indexCount; t += 3) {
      const ia = b.indexData[t]!, ib = b.indexData[t + 1]!, ic = b.indexData[t + 2]!;
      const ux = b.positionData[ib * 3]! - b.positionData[ia * 3]!, uz = b.positionData[ib * 3 + 2]! - b.positionData[ia * 3 + 2]!;
      const vx = b.positionData[ic * 3]! - b.positionData[ia * 3]!, vz = b.positionData[ic * 3 + 2]! - b.positionData[ia * 3 + 2]!;
      if (uz * vx - ux * vz < 0) b.setTriangle(t / 3, ia, ic, ib);
    }
    return {
      statics: [{ material: 'water', mesh: b, name: 'river' }],
      solids: riverLimit(ctx),
      stats: { stations: stations.length, foamStones: stones.length },
    };
  },
};

/**
 * The river as an invisible limit for the walk mode: one quad per stretch of the dense line, 0.2 m inside the water
 * edges (a body of radius 0.3 stops with its feet on the bank), from under the bed up high, not blocking sight. Next to
 * the bridge the quads are cut back to both sides of its corridor, so the deck stays the way across.
 */
export function riverLimit(ctx: Pick<BuildContext, 'layout' | 'heightAt'>): SolidDef[] {
  const { river } = ctx.layout;
  const d = river.dense;
  const bf = bridgeFrame(ctx);
  const gap = bf.halfWidth + 0.1;
  const out: SolidDef[] = [];
  // Edge points per dense point, along the averaged normal so neighbouring quads share their edges.
  const L: [number, number][] = [], R: [number, number][] = [];
  for (let i = 0; i < d.length; i++) {
    const a = d[Math.max(0, i - 1)]!, c = d[Math.min(d.length - 1, i + 1)]!;
    const tx = c.x - a.x, tz = c.z - a.z, l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l, nz = tx / l;
    const h = Math.max(0.2, d[i]!.width / 2 - 0.2);
    L.push([d[i]!.x + nx * h, d[i]!.z + nz * h]);
    R.push([d[i]!.x - nx * h, d[i]!.z - nz * h]);
  }
  for (let i = 0; i + 1 < d.length; i++) {
    const poly: [number, number][] = [L[i]!, L[i + 1]!, R[i + 1]!, R[i]!];
    if (!simpleQuad(poly)) continue;
    const lo = Math.min(d[i]!.y, d[i + 1]!.y) - river.depth - 5;
    const hi = Math.max(d[i]!.y, d[i + 1]!.y) + 40;
    const near = poly.some(([x, z]) => Math.abs(bf.local(x, z)[0]) < bf.halfLength + 3);
    const parts = near ? [clipT(poly, bf, -1, gap), clipT(poly, bf, 1, gap)] : [poly];
    for (const q of parts) {
      if (q.length < 3) continue;
      out.push({ shape: 'prism', outline: q.flat(), minY: lo, maxY: hi, label: 'river', standable: false, blocksSight: false });
    }
  }
  return out;
}

/** A quad whose two triangles turn the same way (not folded at a tight bend). */
function simpleQuad(p: [number, number][]): boolean {
  const cr = (a: [number, number], b: [number, number], c: [number, number]): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const s = [cr(p[0]!, p[1]!, p[2]!), cr(p[1]!, p[2]!, p[3]!), cr(p[2]!, p[3]!, p[0]!), cr(p[3]!, p[0]!, p[1]!)];
  return s.every((v) => v > 1e-6) || s.every((v) => v < -1e-6);
}

/** The part of a convex polygon on one side of the bridge corridor: `side` · t ≥ `gap` in the bridge's frame. */
function clipT(poly: [number, number][], bf: ReturnType<typeof bridgeFrame>, side: number, gap: number): [number, number][] {
  const f = (p: [number, number]): number => side * bf.local(p[0], p[1])[1] - gap;
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const k = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}
