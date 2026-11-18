// The weir above the mill (owner: terrain, B3): a stone and timber weir across the river with its ~1.9 m fall
// (layout.weir), the water's falling sheet and plunge pool are in terrain/water.ts.
//
//   crest      a row of dressed blocks just under the upper water, capped with a wet oak sill the water slides over
//   stakes     a line of driven oak stakes upstream of the crest (an old timber weir the stone one replaced)
//   steps      the downstream face steps down under the falling sheet (always below it), to an apron of flat slabs
//              in the plunge pool
//   abutments  coursed masonry walls on both banks holding the crest's ends, their tops following the bank
//   spray      fine spray and droplets at the foot of the fall (particles; fx adds its own steam above the pool)
//
// Local frame: compose34 at the weir with its yaw, local +z downstream, local x across the river.

import { MAT, MeshBuilder, PALETTE, bakeAo, bevelBox, compose34, crookedBeam, groundAo, hex, mixRgb, scaleRgb, vary, VARY_RICH } from '../kit/index.ts';
import type { ContentModule, ParticleSource } from '../kit/index.ts';
import { nappeY, WEIR_FALL } from './water.ts';
import { cachedGround } from './common.ts';

const WET_OAK = hex('#4a3a2c');
const WET_STONE = hex('#6c6670');

export const weir: ContentModule = {
  name: 'weir',
  build(ctx) {
    const w = ctx.layout.weir;
    const s = ctx.stream('weir');
    const heightAt = ctx.heightAt;
    const b = new MeshBuilder().set({ cls: MAT.stone });
    const half = w.width / 2;
    const sinY = Math.sin(w.yaw), cosY = Math.cos(w.yaw);
    /** World ground height at local (x, z). */
    const groundAt = (x: number, z: number): number => heightAt(w.x + cosY * x + sinY * z, w.z - sinY * x + cosY * z);
    const bedTop = w.top - ctx.layout.river.depth - 0.5;
    const bedBottom = w.bottom - ctx.layout.river.depth - 0.6;
    const stoneCol = (k: number, wet: number): ReturnType<typeof vary> =>
      vary(mixRgb(mixRgb(PALETTE.stone, PALETTE.stoneWarm, s.float(1, k)), WET_STONE, wet), VARY_RICH, s, 2, k);

    b.with(compose34([w.x, 0, w.z], w.yaw), () => {
      // --- Crest: blocks along x, upstream of the crest line (z ≤ 0), top just under the water. ---------------------
      let k = 0;
      for (let x = -half - 0.8; x < half + 0.8; k++) {
        const len = s.range(0.7, 1.1, 10, k);
        const x1 = Math.min(x + len, half + 0.8);
        const top = w.top - 0.12;
        b.set({ cls: MAT.stone });
        bevelBox(b, [(x + x1) / 2, bedTop, -0.75], [x1 - x - 0.03, top - bedTop, 1.5], stoneCol(k, 0.5), { bevel: 0.06, jitter: 0.02, stream: s.child(k), noBottom: true });
        x = x1;
      }
      // Oak sill on the crest, the water slides over it.
      b.set({ cls: MAT.wood });
      crookedBeam(b, [-half - 0.6, w.top - 0.08, -0.2], [half + 0.6, w.top - 0.08, -0.2], WET_OAK, { width: 0.32, depth: 0.2, sag: 0.02, wobble: 0.02, stream: s.child(900) });
      // Stakes upstream, their heads just out of the water.
      for (let i = 0, x = -half + 0.4; x < half - 0.3; i++, x += s.range(0.9, 1.4, 20, i)) {
        const h = s.range(0.12, 0.35, 21, i);
        bevelBox(b, [x, bedTop, -1.85 + s.jitter(0.12, 22, i)], [0.2, w.top + h - bedTop, 0.2], scaleRgb(WET_OAK, s.range(0.85, 1.15, 23, i)), { bevel: 0.04, taper: [0.8, 0.8], lean: [s.jitter(0.06, 24, i), s.jitter(0.06, 25, i)], noBottom: true });
      }
      // --- Steps down under the falling sheet, then the apron. -------------------------------------------------------
      b.set({ cls: MAT.stone });
      const edges = [0, 0.32, 0.64, 0.96, WEIR_FALL + 0.15];
      for (let st = 0; st < edges.length - 1; st++) {
        const z0 = edges[st]!, z1 = edges[st + 1]!;
        const top = Math.min(nappeY(w.top, w.bottom, z1), nappeY(w.top, w.bottom, z0)) - 0.2;
        for (let x = -half - 0.4, i = 0; x < half + 0.4; i++) {
          const len = s.range(0.6, 1.0, 30 + st, i);
          const x1 = Math.min(x + len, half + 0.4);
          bevelBox(b, [(x + x1) / 2, bedBottom, (z0 + z1) / 2], [x1 - x - 0.03, top - bedBottom, z1 - z0 + 0.02], stoneCol(100 * st + i, 0.7), { bevel: 0.05, jitter: 0.02, stream: s.child(1000 + st * 100 + i), noBottom: true });
          x = x1;
        }
      }
      for (let r = 0; r < 3; r++) {
        for (let x = -half - 0.2, i = 0; x < half + 0.2; i++) {
          const len = s.range(0.7, 1.3, 40 + r, i);
          const x1 = Math.min(x + len, half + 0.2);
          const z0 = WEIR_FALL + 0.15 + r * 0.8;
          bevelBox(b, [(x + x1) / 2, bedBottom, z0 + 0.4], [x1 - x - 0.04, w.bottom - 0.4 - bedBottom - r * 0.04, 0.76], stoneCol(500 + r * 50 + i, 0.8), { bevel: 0.05, jitter: 0.025, stream: s.child(2000 + r * 100 + i), noBottom: true });
          x = x1;
        }
      }
      // --- Abutments: coursed walls on both banks from upstream of the stakes to past the apron. ----------------------
      for (const side of [-1, 1]) {
        const xIn = side * (half + 0.2);
        const thick = 1.4;
        const cx = xIn + side * thick / 2;
        let zi = 0;
        for (let z = -2.6; z < WEIR_FALL + 2.6; zi++) {
          const len = s.range(0.65, 1.05, 50 + (side > 0 ? 1 : 0), zi);
          const z1 = Math.min(z + len, WEIR_FALL + 2.6);
          const zm = (z + z1) / 2;
          const ground = Math.min(groundAt(xIn + side * 0.3, zm), groundAt(xIn + side * thick, zm));
          const upper = zm < 0 ? w.top : w.bottom;
          const top = Math.max(upper + 0.45, Math.min(ground + 0.3, w.top + 0.5));
          const bot = Math.min(bedTop, bedBottom) - 0.2;
          // Courses ~0.45 m high, blocks offset course to course.
          let y = bot;
          for (let c = 0; y < top - 0.05; c++) {
            const h = Math.min(s.range(0.38, 0.52, 60, zi, c), top - y);
            bevelBox(b, [cx, y, zm], [thick, h - 0.025, z1 - z - 0.03], stoneCol(3000 + zi * 10 + c, y < upper ? 0.6 : 0), { bevel: 0.05, jitter: 0.02, stream: s.child(3000 + zi * 20 + c + (side > 0 ? 7 : 0)), noBottom: c > 0 });
            y += h;
          }
          // Coping stone.
          bevelBox(b, [cx + side * 0.05, top, zm], [thick + 0.15, 0.16, z1 - z + 0.02], scaleRgb(stoneCol(4000 + zi, 0), 1.08), { bevel: 0.05 });
          z = z1;
        }
      }
    });
    const aoGround = cachedGround(ctx);
    bakeAo(b, { ground: aoGround, rays: 10, reach: 1.6 });
    groundAo(b, aoGround, 0.6, 0.35);

    // Spray at the foot of the fall.
    const particles: ParticleSource[] = [];
    for (const u of [-0.33, 0, 0.33]) {
      const lx = u * w.width, lz = WEIR_FALL + 0.3;
      const px = w.x + cosY * lx + sinY * lz, pz = w.z - sinY * lx + cosY * lz;
      particles.push({ kind: 'steam', position: [px, w.bottom + 0.15, pz], count: 16, life: 2.6, size: [0.5, 1.8], rise: 0.35, spread: [w.width / 6, 0.25], wind: 0.4, colorStart: [0.92, 0.95, 0.97, 0.32], colorEnd: [0.92, 0.95, 0.97, 0] });
      particles.push({ kind: 'dust', position: [px, w.bottom + 0.05, pz], count: 14, life: 0.9, size: [0.1, 0.05], rise: 1.5, spread: [w.width / 6, 0.7], gravity: 4.5, wind: 0.1, colorStart: [0.95, 0.98, 1, 0.75], colorEnd: [0.9, 0.95, 1, 0] });
    }

    return {
      statics: [{ material: 'solid', mesh: b, name: 'weir' }],
      particles,
      stats: { drop: Math.round((w.top - w.bottom) * 100) / 100 },
    };
  },
};
