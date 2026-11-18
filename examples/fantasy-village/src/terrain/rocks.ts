// Rocks (owner: terrain, B2/A7): layered, angular stone and big faceted boulders, mossy on top.
//
//   bank cliffs   stacked slabs stepping back from the water along the rocky reaches: by the weir and the mill, and
//                 round the bridge (B3), and in the gorges where the river enters and leaves the valley
//   outcrops      the same layered slabs breaking out of the steeper slopes of the hill ring and of the castle ridge
//   boulders      single large faceted boulders, some with a smaller companion, in the meadows round the village and
//                 along the streets (never on a street, a house pad, a garden, the square or a tree)
//   tree feet     a few stones at the feet of the giant trees
//   river stones  boulders standing in the water (common.ts riverStones: the water foams round the same list)
//
// Every cluster is built in its own MeshBuilder, gets baked occlusion (voxel rays and the ground) and is appended to
// one static mesh. Colours: grey-violet stone varied per slab, warm and dark strata, moss on what faces up, wet and
// weedy below the water line.

import { valueNoise2 } from 'wallhammer-web/gen-core';
import { MAT, MeshBuilder, PALETTE, bakeAo, compose34, groundAo, hex, hullSolid, mixRgb, rock, scaleRgb, signedDistToRing, smoothstep, vary, VARY_RICH } from '../kit/index.ts';
import type { ContentModule, RGB, SolidDef, Stream, Vec3 } from '../kit/index.ts';
import type { Paint } from '../kit/index.ts';
import { pathNear, riverNear } from '../layout.ts';
import { bridgeFrame, cachedGround, frameAt, riverStones } from './common.ts';

const STONE: RGB[] = [PALETTE.stone, PALETTE.stoneWarm, hex('#7e7486'), hex('#9a8c94'), hex('#8a8478')];
const MOSS = hex('#5f7a2e');
const MOSS_LIGHT = hex('#8aa040');
const WEED = hex('#3e4a34');

export const rocks: ContentModule = {
  name: 'rocks',
  build(ctx) {
    const { layout, field } = ctx;
    const heightAt = field.heightAt;
    const s = ctx.stream('rocks');
    const bf = bridgeFrame(ctx);
    const river = layout.river;
    const total = river.lengths[river.lengths.length - 1]!;
    const out = new MeshBuilder().set({ cls: MAT.stone });
    const placed: { x: number; z: number; r: number }[] = [];
    const aoGround = cachedGround(ctx);
    const counts = { cliffs: 0, outcrops: 0, boulders: 0, riverStones: 0, slabs: 0 };

    /** Moss on the faces that look up, a lighter lichen on the very top; `wetBelow` darkens what is under water. */
    const mossy = (base: RGB, moss: number, wetBelow = -Infinity, toWorldY = 0): Paint => (p, n) => {
      let c: RGB = base;
      const up = smoothstep(0.5, 0.92, n[1]);
      c = mixRgb(c, mixRgb(MOSS, MOSS_LIGHT, smoothstep(0.85, 1, n[1])), up * moss);
      if (p[1] + toWorldY < wetBelow) c = mixRgb(scaleRgb(c, 0.6), WEED, 0.45);
      return c;
    };

    /** Is (x, z) free for a rock of radius r (streets, pads, gardens, the square, trees, props, water)? */
    const free = (x: number, z: number, r: number, o: { water?: boolean; trees?: boolean; pads?: number } = {}): boolean => {
      const p = pathNear(layout.paths, x, z);
      if (p.path && p.dist < p.path.width / 2 + r + 0.7) return false;
      for (const st of layout.structures) if (signedDistToRing(st.pad.ring, x, z) < r + (o.pads ?? 1.2)) return false;
      if (Math.hypot(x - layout.square.x, z - layout.square.z) < layout.square.radius + r + 1.5) return false;
      for (const g of layout.gardens) if (Math.hypot(x - g.x, z - g.z) < Math.max(g.w, g.d) / 2 + r + 1.2) return false;
      if (o.trees !== false) {
        for (const t of layout.trees) {
          const d = Math.hypot(x - t.x, z - t.z);
          if (d < r + (t.kind === 'giant' ? 5.5 : t.kind === 'conifer' ? 1.6 : 1.9) * t.scale) return false;
        }
      }
      for (const l of layout.lanterns) if (Math.hypot(x - l.x, z - l.z) < r + 1) return false;
      for (const pi of layout.pois) if (Math.hypot(x - pi.x, z - pi.z) < r + 1.4) return false;
      for (const f of layout.fences) {
        for (let k = 0; k < f.points.length - 1; k++) {
          const a = f.points[k]!, b = f.points[k + 1]!;
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
          if (Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < r + 0.7) return false;
        }
      }
      for (const st of layout.stalls) if (Math.hypot(x - st.x, z - st.z) < r + 2.5) return false;
      for (const b of layout.benches) if (Math.hypot(x - b.x, z - b.z) < r + 1.2) return false;
      if (Math.hypot(x - layout.well.x, z - layout.well.z) < r + 1.8) return false;
      if (bf.onDeck(x, z, r + 0.4)) return false;
      if (o.water !== true) {
        const rv = riverNear(river, x, z);
        if (rv.dist < rv.at.width / 2 + r + 0.3) return false;
      }
      if (placed.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + r + 0.2)) return false;
      return true;
    };

    /** Bakes a cluster's occlusion and appends it. */
    const solids: SolidDef[] = [];
    const commit = (b: MeshBuilder): void => {
      if (b.vertexCount === 0) return;
      // Walk mode: the outline of the cluster, standable (a figure steps onto a low stone, a cliff stops it).
      const sd = hullSolid('rock', b, { grow: -0.08 });
      if (sd) solids.push(sd);
      bakeAo(b, { ground: aoGround, rays: 10, reach: 1.8, cell: 0.2, strength: 0.6 });
      groundAo(b, aoGround, 0.7, 0.4);
      out.append(b);
    };

    /**
     * A layered cliff: `layers` slabs stacked up from the ground at (x, z), each one set back from the face (which
     * looks toward `faceYaw`) and a little narrower, all dipping the same way like bedded rock.
     */
    const cliff = (x: number, z: number, faceYaw: number, width: number, height: number, depth: number, st: Stream, wetBelow = -Infinity): void => {
      const b = new MeshBuilder().set({ cls: MAT.stone });
      const fx = Math.sin(faceYaw), fz = Math.cos(faceYaw);
      const sx = Math.cos(faceYaw), sz = -Math.sin(faceYaw);
      // The lowest ground under the face, so the cliff never floats.
      let y = Infinity;
      for (const [u, v] of [[0, 0], [width / 2, 0], [-width / 2, 0], [0, depth / 2], [0, -depth / 2], [width / 2, -depth / 2], [-width / 2, -depth / 2]] as const) y = Math.min(y, heightAt(x + sx * u + fx * v, z + sz * u + fz * v));
      y -= 0.45;
      const dipPitch = st.range(-0.07, 0.07, 1), dipRoll = st.range(-0.1, 0.1, 2);
      const base = STONE[Math.floor(st.float(3) * STONE.length) % STONE.length]!;
      const top = heightAt(x, z) + height;
      let k = 0;
      let back = 0;
      let lat = 0;
      while (y < top && k < 7) {
        const f = k / 5;
        const h = st.range(0.5, 0.95, 10, k) * (k === 0 ? 1.3 : 1);
        const w = width * (1 - 0.13 * k) * st.range(0.85, 1.1, 11, k);
        const d = depth * (1 - 0.1 * k) * st.range(0.8, 1.05, 12, k);
        if (w < 0.6 || d < 0.6) break;
        const cx = x - fx * back + sx * lat, cz = z - fz * back + sz * lat;
        // Strata: warm and dark layers alternate a little.
        const col = vary(k % 3 === 1 ? mixRgb(base, PALETTE.stoneWarm, 0.4) : k % 3 === 2 ? mixRgb(base, PALETTE.stoneDark, 0.25) : base, VARY_RICH, st, 13, k);
        const yawJ = st.range(-0.22, 0.22, 14, k);
        b.with(compose34([cx, y, cz], faceYaw + yawJ, dipPitch + st.range(-0.04, 0.04, 15, k), dipRoll + st.range(-0.05, 0.05, 16, k)), () => {
          rock(b, [0, 0, 0], [w, h, d], mossy(col, 0.45 + 0.4 * f, wetBelow, y), { stream: st.child(100 + k), detail: w > 2.4 ? 4 : 3, cuts: 9, cutDepth: [0.76, 0.94], flatBottom: -0.55, lumps: 0.07, shade: 0.3 });
        });
        counts.slabs++;
        y += h * st.range(0.72, 0.88, 17, k);
        back += st.range(0.25, 0.55, 18, k) * (height > 2.5 ? 1 : 0.8);
        lat += st.range(-0.3, 0.3, 19, k);
        k++;
      }
      commit(b);
      placed.push({ x, z, r: Math.max(width, depth) / 2 });
    };

    // --- Rocky banks: by the weir and the mill, round the bridge, and the gorges at both ends -----------------------------
    const mill = layout.structures.find((q) => q.kind === 'mill');
    const wheel = layout.millWheel;
    const bAlong = riverNear(river, bf.x, bf.z).at.along;
    const reaches: { from: number; to: number; height: [number, number]; step: number }[] = [
      { from: layout.weir.along - 14, to: layout.weir.along + 24, height: [1.4, 3.2], step: 3.1 },
      { from: bAlong - 15, to: bAlong + 13, height: [0.9, 2.2], step: 3.3 },
      { from: 0, to: 24, height: [3, 6.5], step: 3.6 },
      { from: total - 30, to: total, height: [2.5, 5.5], step: 3.8 },
    ];
    let ci = 0;
    for (const reach of reaches) {
      for (let a = Math.max(0, reach.from); a < Math.min(total, reach.to); a += reach.step) {
        for (const side of [-1, 1]) {
          ci++;
          if (!s.chance(0.78, 200, ci)) continue;
          const along = a + s.jitter(reach.step * 0.3, 201, ci);
          const f = frameAt(river.line, river.lengths, along);
          const rv = riverNear(river, f.x, f.z);
          const off = side * (rv.at.width / 2 + s.range(0.5, 1.4, 202, ci));
          const x = f.x + f.dz * off, z = f.z - f.dx * off;
          const width = s.range(2.2, 3.8, 203, ci);
          const r = width / 2;
          // Keep the mill, its wheel, the weir's abutments, the bridge deck and every street clear.
          if (mill && signedDistToRing(mill.pad.ring, x, z) < r + 0.6) continue;
          if (Math.hypot(x - wheel.x, z - wheel.z) < wheel.radius + r + 1.4) continue;
          if (Math.abs(along - layout.weir.along) < 2.6) continue;
          if (!free(x, z, r * 0.8, { water: true, pads: 0.6 })) continue;
          // Face the water: from the cliff toward the river's centre line.
          const faceYaw = Math.atan2(f.x - x, f.z - z);
          cliff(x, z, faceYaw, width, s.range(reach.height[0], reach.height[1], 204, ci), s.range(1.8, 2.8, 205, ci), s.child(ci), rv.at.y);
          counts.cliffs++;
        }
      }
    }

    // --- Outcrops on the steeper slopes of the hill ring and on the castle ridge ---------------------------------------------
    let tries = 0;
    for (let k = 0; k < 400 && counts.outcrops < 20; k++) {
      tries++;
      const ang = s.range(0, Math.PI * 2, 300, k);
      const r = s.range(56, 128, 301, k);
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      const e = 2;
      const gx = heightAt(x + e, z) - heightAt(x - e, z), gz = heightAt(x, z + e) - heightAt(x, z - e);
      const slope = Math.hypot(gx, gz) / (2 * e);
      if (slope < 0.18 + 0.25 * s.float(302, k)) continue;
      const width = s.range(2.6, 4.6, 303, k);
      if (!free(x, z, width / 2 + 0.5)) continue;
      // The face looks downhill.
      const faceYaw = Math.atan2(-gx, -gz);
      cliff(x, z, faceYaw, width, s.range(1.8, 4.2, 304, k), s.range(2.2, 3.4, 305, k), s.child(5000 + k));
      counts.outcrops++;
    }
    const castle = layout.structures.find((q) => q.kind === 'castle');
    if (castle) {
      for (let k = 0; k < 7; k++) {
        // Below the castle on the side that faces the village, where the ridge falls away.
        const ang = Math.PI * (0.15 + 0.7 * (k / 6)) + s.jitter(0.08, 310, k);
        const dist = s.range(24, 34, 311, k);
        const x = castle.x + Math.cos(ang) * dist * 1.3, z = castle.z + Math.sin(ang) * dist;
        if (signedDistToRing(castle.pad.ring, x, z) < 3) continue;
        const e = 2;
        const gx = heightAt(x + e, z) - heightAt(x - e, z), gz = heightAt(x, z + e) - heightAt(x, z - e);
        const width = s.range(3.5, 6, 312, k);
        if (!free(x, z, width / 2, { pads: 3 })) continue;
        cliff(x, z, Math.atan2(-gx, -gz), width, s.range(3.5, 7, 313, k), s.range(3, 4.5, 314, k), s.child(6000 + k));
        counts.outcrops++;
      }
    }

    // --- Boulders --------------------------------------------------------------------------------------------------------
    const boulder = (x: number, z: number, size: number, st: Stream, companion: boolean): void => {
      const b = new MeshBuilder().set({ cls: MAT.stone });
      const base = vary(STONE[Math.floor(st.float(1) * STONE.length) % STONE.length]!, VARY_RICH, st, 2);
      const y = Math.min(heightAt(x, z), heightAt(x + size * 0.4, z), heightAt(x - size * 0.4, z), heightAt(x, z + size * 0.4), heightAt(x, z - size * 0.4)) - size * 0.18;
      b.with(compose34([x, y, z], st.range(0, Math.PI * 2, 3), st.range(-0.12, 0.12, 4), st.range(-0.12, 0.12, 5)), () => {
        rock(b, [0, 0, 0], [size * st.range(1.0, 1.35, 6), size * st.range(0.7, 0.95, 7), size * st.range(0.85, 1.1, 8)], mossy(base, 0.55), { stream: st.child(1), detail: size > 1.6 ? 4 : 3, cuts: 8, cutDepth: [0.72, 0.9] });
      });
      if (companion) {
        const a = st.range(0, Math.PI * 2, 9);
        const cs = size * st.range(0.35, 0.55, 10);
        const cx = x + Math.cos(a) * size * 0.75, cz = z + Math.sin(a) * size * 0.75;
        b.with(compose34([cx, heightAt(cx, cz) - cs * 0.2, cz], st.range(0, Math.PI * 2, 11), 0, st.range(-0.2, 0.2, 12)), () => {
          rock(b, [0, 0, 0], [cs * 1.2, cs * 0.8, cs], mossy(vary(base, VARY_RICH, st, 13), 0.4), { stream: st.child(2), detail: 3, cuts: 7 });
        });
      }
      commit(b);
      placed.push({ x, z, r: size * 0.7 });
      counts.boulders++;
    };
    for (let k = 0; k < 900 && counts.boulders < 52; k++) {
      const ang = s.range(0, Math.PI * 2, 400, k);
      const r = Math.sqrt(s.range(14 * 14, 120 * 120, 401, k));
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      // Bigger toward the hills; clusters where a noise says so.
      const want = valueNoise2(x, z, 30, s.seed) * 0.8 + 0.25;
      if (s.float(402, k) > want) continue;
      const size = (r < 40 ? s.range(0.9, 1.7, 403, k) : s.range(1.3, 3.2, 403, k)) * (s.chance(0.12, 404, k) ? 1.35 : 1);
      if (!free(x, z, size * 0.75)) continue;
      boulder(x, z, size, s.child(7000 + k), s.chance(0.4, 405, k));
    }
    // Along the streets just outside the village square (the concept's big stones by the path).
    for (const p of layout.paths) {
      if (p.kind !== 'cobble') continue;
      const L = p.lengths[p.lengths.length - 1]!;
      for (let k = 0; k < 6; k++) {
        const a = s.range(8, Math.min(L, 60), 410, p.id.length, k);
        const f = frameAt(p.dense, p.lengths, a);
        const side = s.sign(411, p.id.length, k);
        const size = s.range(0.9, 1.6, 412, p.id.length, k);
        const off = side * (p.width / 2 + size * 0.75 + 0.9);
        const x = f.x + f.dz * off, z = f.z - f.dx * off;
        if (!free(x, z, size * 0.7)) continue;
        boulder(x, z, size, s.child(8000 + p.id.length * 31 + k), s.chance(0.5, 413, p.id.length, k));
      }
    }

    // --- At the feet of the giant trees ------------------------------------------------------------------------------------
    for (const [i, t] of layout.trees.entries()) {
      if (t.kind !== 'giant') continue;
      for (let k = 0; k < 2; k++) {
        const a = s.range(0, Math.PI * 2, 500, i, k);
        const d = s.range(5.2, 7, 501, i, k) * t.scale;
        const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
        const size = s.range(0.8, 1.4, 502, i, k);
        if (!free(x, z, size * 0.6, { trees: false })) continue;
        boulder(x, z, size, s.child(9000 + i * 10 + k), false);
      }
    }

    // --- Stones in the river -----------------------------------------------------------------------------------------------
    for (const [i, rs] of riverStones(ctx).entries()) {
      const b = new MeshBuilder().set({ cls: MAT.stone });
      const st = s.child(10000 + i);
      const water = field.river(rs.x, rs.z).at.y;
      const base = vary(mixRgb(PALETTE.stone, PALETTE.stoneDark, 0.3), VARY_RICH, st, 1);
      const yBase = rs.y - 0.3;
      b.with(compose34([rs.x, yBase, rs.z], rs.yaw, st.range(-0.1, 0.1, 2), st.range(-0.1, 0.1, 3)), () => {
        rock(b, [0, 0, 0], [rs.r * 2, rs.h + 0.3, rs.r * 1.7], mossy(base, 0.5, water, yBase), { stream: st.child(1), detail: 3, cuts: 8, cutDepth: [0.7, 0.9] });
      });
      commit(b);
      counts.riverStones++;
    }

    void tries;
    void (null as unknown as Vec3);
    return {
      statics: [{ material: 'solid', mesh: out, name: 'rocks' }],
      solids,
      stats: { ...counts },
    };
  },
};
