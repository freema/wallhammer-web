// Vegetation of the village (owner: vegetation, B2 and B3): the four giant twisted trees (each its own shape from the
// seed, static), the smaller broadleaf trees, apple trees and conifers of the layout as instanced part sets (with
// light versions far out), bushes, and the batched ground cover from a noise scatter: grass tufts, flowers of seven
// kinds, ferns by the water and in the shade, reeds and cattails on the banks, small mossy stones, mushrooms, ivy on
// chosen house corners and garden beds with cabbages, carrots, lettuce, onions, pumpkins and herbs. Nothing grows on
// a street, in the water or in a building (src/vegetation/scatter.ts).
//
// Draw calls: 7 part sets (oak, apple, fir, pine, bush, far oak, far fir); the rest is static and merged into the
// chunks of the assembly. Leaves, grass, reeds and flowers sway in the wind through the vertex flag.

import type { BuildContext, ContentModule, PartSet, SolidDef, StaticPiece, Vec3 } from '../kit/index.ts';
import { MeshBuilder, compose34, createPartSet, cylinderSolid, lerp, pushPart, signedDistToRing, smoothstep } from '../kit/index.ts';
import type { Structure, TreeSpot } from '../layout.ts';
import { cornerIvy, ivyCorners } from './climbers.ts';
import { buildGarden, cropTemplates } from './crops.ts';
import { giantTree } from './giant.ts';
import type { FlowerKind } from './ground-cover.ts';
import { groundTemplates } from './ground-cover.ts';
import type { Mask } from './scatter.ts';
import { createMask } from './scatter.ts';
import type { TreeTemplate } from './trees.ts';
import { TRUNK_RADIUS, treeTemplate, treeTint } from './trees.ts';

/** Storey height used by the house builders (src/arch). */
const STOREY = 3;
/** Instanced broadleaf trees nearer than this to the square use the detailed templates; conifers (cheaper) up to NEAR_CONIFER. */
const NEAR = 68;
const NEAR_CONIFER = 92;
/** Ground cover is scattered within this radius. */
const COVER_R = 104;

/** Crown radius (metres at scale 1) of each template, for keeping crowns off the roofs. */
const CROWN: Record<TreeTemplate, number> = { oak: 4.4, apple: 3.9, fir: 3.0, pine: 3.1, bush: 1.3, 'oak-far': 4.4, 'fir-far': 3.1 };

/** Rough top of a building's roof (the roofs themselves are built elsewhere): walls, a pitched roof, a margin. */
function roofTop(ctx: BuildContext, s: Structure): number {
  return ctx.field.padY(s.id) + s.stories * STOREY + 0.62 * Math.min(s.body.w, s.body.d) + 1.4;
}

export const vegetation: ContentModule = {
  name: 'vegetation',
  build(ctx) {
    const L = ctx.layout;
    const mask = createMask(ctx);
    const statics: StaticPiece[] = [];
    const parts: PartSet[] = [];
    const stats: Record<string, number> = {};
    let tick = performance.now();
    const lap = (name: string): void => {
      const now = performance.now();
      stats[`ms-${name}`] = Math.round(now - tick);
      tick = now;
    };
    const tops = L.structures.map((s) => ({ s, top: roofTop(ctx, s) }));

    /** Moves a point with a radius horizontally out of every building it would sit in below the roof. */
    const clear = (p: Vec3, r: number): Vec3 => {
      const q: Vec3 = [p[0], p[1], p[2]];
      for (let it = 0; it < 40; it++) {
        let hit: { s: Structure; d: number } | null = null;
        for (const { s, top } of tops) {
          if (q[1] - r * 0.7 > top) continue;
          let d = Infinity;
          for (const f of s.footprints) d = Math.min(d, signedDistToRing(f, q[0], q[2]));
          if (d < r + 0.4) {
            hit = { s, d };
            break;
          }
        }
        if (!hit) break;
        const dx = q[0] - hit.s.x, dz = q[2] - hit.s.z;
        const l = Math.hypot(dx, dz) || 1;
        const step = Math.max(0.25, r + 0.45 - hit.d);
        q[0] += (dx / l) * step;
        q[2] += (dz / l) * step;
      }
      return q;
    };
    const rootRoom = (x: number, z: number, dx: number, dz: number, want: number): number => {
      let d = 0.5;
      for (; d < want; d += 0.35) {
        const px = x + dx * d, pz = z + dz * d;
        if (mask.building(px, pz) < 0.6 || mask.water(px, pz).edge < 0.5 || mask.paved(px, pz) < 0.15 || mask.props(px, pz) < 0) break;
      }
      return d;
    };

    // --- Giant trees ------------------------------------------------------------------------------------------------
    const solids: SolidDef[] = [];
    const giants = L.trees.filter((t) => t.kind === 'giant');
    const gs = ctx.stream('vegetation-giants');
    giants.forEach((t, i) => {
      // Away from the nearest building, more strongly the nearer it is.
      let away: [number, number] = [0, 0];
      let best = Infinity;
      for (const s of L.structures) {
        let d = Infinity;
        for (const f of s.footprints) d = Math.min(d, signedDistToRing(f, t.x, t.z));
        if (d < best && d < 14) {
          best = d;
          const dx = t.x - s.x, dz = t.z - s.z, l = Math.hypot(dx, dz) || 1;
          const w = 1 - smoothstep(4, 14, d);
          away = [(dx / l) * w, (dz / l) * w];
        }
      }
      const mesh = giantTree({ x: t.x, z: t.z, scale: t.scale, stream: gs.child(i), heightAt: ctx.heightAt, clear, rootRoom, away, ivy: i % 2 === 0 });
      statics.push({ material: 'solid', mesh, name: `giant-${i}` });
      // Walk mode: the flared foot of the trunk (the roots around it can be stepped over).
      const gy = ctx.heightAt(t.x, t.z);
      solids.push(cylinderSolid('giant-tree', t.x, t.z, 1.5 * t.scale, gy - 2, gy + 9 * t.scale, { standable: false }));
    });
    stats.giantTrees = giants.length;
    lap('giants');

    // --- Instanced trees and bushes ---------------------------------------------------------------------------------
    const ts = ctx.stream('vegetation-trees');
    const kinds: TreeTemplate[] = ['oak', 'apple', 'fir', 'pine', 'bush', 'oak-far', 'fir-far'];
    const place: Record<TreeTemplate, { x: number; z: number; sc: number; i: number }[]> = { oak: [], apple: [], fir: [], pine: [], bush: [], 'oak-far': [], 'fir-far': [] };
    const nearestBuilding = (x: number, z: number): number => mask.building(x, z);
    const addTree = (t: TreeSpot, i: number): void => {
      const r = Math.hypot(t.x, t.z);
      const near = r < (t.kind === 'conifer' ? NEAR_CONIFER : NEAR);
      let kind: TreeTemplate;
      if (t.kind === 'bush') kind = 'bush';
      else if (t.kind === 'conifer') kind = near ? (ts.chance(0.4, i, 1) ? 'pine' : 'fir') : 'fir-far';
      else kind = near ? (r < 62 && ts.chance(0.35, i, 2) ? 'apple' : 'oak') : 'oak-far';
      let sc = t.scale;
      // Keep crowns off the roofs: shrink, or grow a bush instead.
      const bd = nearestBuilding(t.x, t.z);
      if (kind !== 'bush' && bd < CROWN[kind] * sc + 0.6) {
        sc = (bd - 0.6) / CROWN[kind];
        if (sc < 0.62) {
          kind = 'bush';
          sc = Math.max(0.6, Math.min(1.2, (bd - 0.5) / CROWN.bush));
        }
      }
      if (mask.paved(t.x, t.z) < 0.4 || mask.water(t.x, t.z).edge < 0.6) return;
      place[kind].push({ x: t.x, z: t.z, sc, i });
    };
    L.trees.forEach((t, i) => {
      if (t.kind !== 'giant') addTree(t, i);
    });
    // Extra bushes and apple trees from a noise scatter: round the houses, along fences, on the banks.
    const bs = ctx.stream('vegetation-bushes');
    let extra = 0;
    for (let j = -26; j <= 26; j++) {
      for (let i = -26; i <= 26; i++) {
        const x = (i + 0.5 + bs.jitter(0.45, i, j, 1)) * 3.4;
        const z = (j + 0.5 + bs.jitter(0.45, i, j, 2)) * 3.4;
        const r = Math.hypot(x, z);
        if (r > 88) continue;
        const sc = bs.range(0.7, 1.25, i, j, 3);
        const rad = 1.2 * sc;
        const bd = mask.building(x, z);
        const fe = mask.fence(x, z);
        const we = mask.water(x, z).edge;
        const pv = mask.paved(x, z);
        let p = 0.1 * smoothstep(0.55, 0.85, mask.noise(x, z, 16, 3));
        if (bd > 1.4 && bd < 4.5) p += 0.27;
        if (fe > 0.5 && fe < 1.8) p += 0.25;
        if (we > 1.2 && we < 4.5) p += 0.18;
        if (pv > 1.4 && pv < 3.5) p += 0.06;
        if (r > 60) p *= 0.6;
        if (bs.float(i, j, 4) > p) continue;
        if (!mask.open(x, z, rad) || pv < rad + 0.5 || bd < rad + 0.4 || fe < rad * 0.6 || mask.trunk(x, z) < rad + 0.3) continue;
        // An apple tree now and then by the cottages, where there is room for a crown.
        if (bd > 5.2 && r < 62 && bs.chance(0.12, i, j, 5)) {
          place.apple.push({ x, z, sc: Math.min(1, (bd - 0.6) / CROWN.apple), i: 5000 + extra });
        } else {
          place.bush.push({ x, z, sc, i: 5000 + extra });
        }
        extra++;
      }
    }
    for (const kind of kinds) {
      const list = place[kind];
      if (list.length === 0) continue;
      const set = createPartSet(`vegetation-${kind}`, treeTemplate(kind, ctx.stream(`vegetation-tpl-${kind}`)), list.length);
      for (const p of list) {
        let y = ctx.heightAt(p.x, p.z);
        for (let k = 0; k < 4; k++) y = Math.min(y, ctx.heightAt(p.x + Math.sin(k * 1.57) * 0.6 * p.sc, p.z + Math.cos(k * 1.57) * 0.6 * p.sc));
        const tint = treeTint(ts, p.i, kind === 'bush' ? 0.8 : 1);
        const m = compose34([p.x, y - 0.03, p.z], ts.range(0, Math.PI * 2, p.i, 7), ts.jitter(0.045, p.i, 8), ts.jitter(0.045, p.i, 9), [p.sc, p.sc * ts.range(0.9, 1.12, p.i, 10), p.sc]);
        pushPart(set, m, tint[0], tint[1], tint[2]);
        // Walk mode: the trunk (a bush as a low round mass).
        if (kind === 'bush') solids.push(cylinderSolid('bush', p.x, p.z, 0.7 * p.sc, y - 1, y + 1.0 * p.sc, { standable: false }));
        else solids.push(cylinderSolid('tree', p.x, p.z, TRUNK_RADIUS[kind] * p.sc + 0.05, y - 1, y + 5 * p.sc, { standable: false }));
      }
      parts.push(set);
      stats[`trees-${kind}`] = list.length;
    }

    lap('trees');
    // --- Ground cover ------------------------------------------------------------------------------------------------
    const gt = groundTemplates(ctx.stream('vegetation-ground-tpl'));
    const grass = new MeshBuilder();
    const flowers = new MeshBuilder();
    const wet = new MeshBuilder();
    const stones = new MeshBuilder();
    const cs = ctx.stream('vegetation-cover');
    const put = (into: MeshBuilder, tpl: MeshBuilder, x: number, z: number, yaw: number, sc: number, tint: readonly number[], tilt = 0.08, sink = 0): void => {
      const y = ctx.heightAt(x, z) - sink;
      into.append(tpl, compose34([x, y, z], yaw, cs.jitter(tilt, Math.round(x * 31), Math.round(z * 17), 1), cs.jitter(tilt, Math.round(x * 13), Math.round(z * 29), 2), [sc, sc, sc]), tint);
    };
    const greenTint = (a: number, b: number, w: number): number[] => {
      const v = 1 + cs.jitter(0.1, a, b, 3) * w;
      const warm = cs.jitter(1, a, b, 4) * w;
      return [v * (1 + 0.08 * warm), v * (1 + 0.03 * warm), v * (1 - 0.1 * warm)];
    };
    const near = (fn: (x: number, z: number) => number, x: number, z: number, lo: number, hi: number): boolean => {
      const d = fn(x, z);
      return d > lo && d < hi;
    };
    // Grass tufts.
    let nGrass = 0;
    const G = 3.4;
    const n = Math.ceil(COVER_R / G);
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const x = (i + 0.5 + cs.jitter(0.48, i, j, 10)) * G;
        const z = (j + 0.5 + cs.jitter(0.48, i, j, 11)) * G;
        const r = Math.hypot(x, z);
        if (r > COVER_R) continue;
        const pv = mask.paved(x, z);
        if (pv < 0.1) continue;
        const we = mask.water(x, z).edge;
        if (we < 0.3) continue;
        const bd = mask.building(x, z);
        if (bd < 0.3 || mask.props(x, z) < 0.05 || mask.garden(x, z, 0.1)) continue;
        let p = 0.08 + 0.4 * smoothstep(0.35, 0.78, mask.noise(x, z, 14, 1));
        if (pv < 1.6) p += 0.55 * (1 - pv / 1.6);
        if (bd < 2.5) p += 0.3;
        if (mask.fence(x, z) < 0.9) p += 0.35;
        if (we < 3) p += 0.3;
        if (mask.trunk(x, z) < 2) p += 0.25;
        if (r > 70) p *= 0.5;
        if (cs.float(i, j, 12) > p) continue;
        const dry = mask.noise(x, z, 9, 2) > 0.62;
        const variant = we < 3 || r > 70 ? 1 : dry ? 2 : cs.int(0, 1, i, j, 13);
        put(grass, gt.grass[variant]!, x, z, cs.range(0, 6.28, i, j, 14), cs.range(0.8, 1.35, i, j, 15), greenTint(i, j, 1));
        nGrass++;
      }
    }
    lap('grass');
    // Flowers in patches of one kind, more by the walls, along fences and the edges of the streets.
    let nFlowers = 0;
    const F = 3.2;
    const nf = Math.ceil(COVER_R / F);
    const patchKinds: FlowerKind[] = ['daisy', 'buttercup', 'poppy', 'bluebell', 'pink', 'lavender', 'forgetmenot', 'daisy', 'buttercup'];
    for (let j = -nf; j <= nf; j++) {
      for (let i = -nf; i <= nf; i++) {
        const x = (i + 0.5 + cs.jitter(0.48, i, j, 20)) * F;
        const z = (j + 0.5 + cs.jitter(0.48, i, j, 21)) * F;
        const r = Math.hypot(x, z);
        if (r > COVER_R - 10) continue;
        if (!mask.open(x, z, 0.2)) continue;
        let p = 0.28 * smoothstep(0.58, 0.82, mask.noise(x, z, 11, 4));
        if (near(mask.building, x, z, 0.5, 2.6)) p += 0.3;
        if (mask.fence(x, z) < 1.2) p += 0.3;
        if (near(mask.paved, x, z, 0.3, 1.4)) p += 0.12;
        if (r > 75) p *= 0.35;
        if (cs.float(i, j, 22) > p) continue;
        const kind = patchKinds[Math.min(patchKinds.length - 1, Math.floor(mask.noise(x, z, 7, 5) * patchKinds.length * 1.25) % patchKinds.length)]!;
        // A clump of two or three together.
        const k = cs.int(1, 2, i, j, 23);
        for (let c = 0; c < k; c++) {
          const fx = x + cs.jitter(0.5, i, j, 24 + c), fz = z + cs.jitter(0.5, i, j, 30 + c);
          if (!mask.open(fx, fz, 0.15)) continue;
          put(flowers, gt.flowers[kind][cs.int(0, 1, i, j, 36 + c)]!, fx, fz, cs.range(0, 6.28, i, j, 40 + c), cs.range(0.85, 1.25, i, j, 44 + c), [1, 1, 1], 0.06);
          nFlowers++;
        }
      }
    }
    lap('flowers');
    // Ferns: on the banks, under the giants, in the shade north of the houses.
    let nFerns = 0;
    const giantSpots = giants.map((t) => [t.x, t.z] as const);
    const E = 2.7;
    const ne = Math.ceil(COVER_R / E);
    for (let j = -ne; j <= ne; j++) {
      for (let i = -ne; i <= ne; i++) {
        const x = (i + 0.5 + cs.jitter(0.48, i, j, 50)) * E;
        const z = (j + 0.5 + cs.jitter(0.48, i, j, 51)) * E;
        if (Math.hypot(x, z) > COVER_R - 6) continue;
        if (!mask.open(x, z, 0.5)) continue;
        let p = 0.02;
        const we = mask.water(x, z).edge;
        if (we < 4) p += 0.26;
        const dg = Math.min(...giantSpots.map(([gx, gz]) => Math.hypot(gx - x, gz - z)));
        if (dg > 2.6 && dg < 8) p += 0.3;
        const bd = mask.building(x, z);
        if (bd > 0.4 && bd < 2.2) {
          const s = L.structures.find((q) => q.footprints.some((f) => signedDistToRing(f, x, z) < 2.3));
          if (s && z < s.z) p += 0.35;
        }
        p *= smoothstep(0.3, 0.6, mask.noise(x, z, 8, 6)) * 0.8 + 0.2;
        if (cs.float(i, j, 52) > p) continue;
        put(wet, gt.ferns[cs.int(0, 1, i, j, 53)]!, x, z, cs.range(0, 6.28, i, j, 54), cs.range(0.75, 1.3, i, j, 55), greenTint(i, j + 999, 0.8), 0.1);
        nFerns++;
      }
    }
    lap('ferns');
    // Reeds along both banks, in clumps, standing in the shallow edge.
    let nReeds = 0;
    const rv = L.river;
    const mw = L.millWheel, wr = L.weir, br = L.bridge;
    for (let k = 1; k < rv.dense.length - 1; k++) {
      const q = rv.dense[k]!;
      if (Math.abs(q.x) > 104 || Math.abs(q.z) > 104) continue;
      const a = rv.dense[k - 1]!, b = rv.dense[k + 1]!;
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      for (const side of [-1, 1]) {
        const key = k * 2 + (side > 0 ? 1 : 0);
        const p = 0.48 * smoothstep(0.42, 0.68, mask.noise(q.along, side * 40, 9, 7));
        if (cs.float(key, 60) > p) continue;
        const off = q.width / 2 + cs.range(-0.75, 0.15, key, 61);
        const x = q.x + (-dz / l) * off * side, z = q.z + (dx / l) * off * side;
        if (Math.hypot(x - mw.x, z - mw.z) < mw.radius + 2.5 || Math.hypot(x - wr.x, z - wr.z) < wr.width / 2 + 4 || Math.hypot(x - br.x, z - br.z) < br.length / 2 + 2.5) continue;
        if (mask.building(x, z) < 1.5 || mask.paved(x, z) < 0.6 || mask.props(x, z) < 0.3) continue;
        // The foot sits on the bed, below the surface where the water is.
        const yb = Math.min(ctx.heightAt(x, z), q.y) - 0.05;
        const sc = cs.range(0.8, 1.2, key, 62);
        wet.append(gt.reeds[cs.int(0, 1, key, 63)]!, compose34([x, yb, z], cs.range(0, 6.28, key, 64), cs.jitter(0.08, key, 65), cs.jitter(0.08, key, 66), [sc, sc, sc]), greenTint(key, 7, 0.7));
        nReeds++;
      }
    }
    // Small mossy stones in the grass, more by the water and the street edges.
    let nStones = 0;
    const S = 5.5;
    const ns = Math.ceil(COVER_R / S);
    for (let j = -ns; j <= ns; j++) {
      for (let i = -ns; i <= ns; i++) {
        const x = (i + 0.5 + cs.jitter(0.45, i, j, 70)) * S;
        const z = (j + 0.5 + cs.jitter(0.45, i, j, 71)) * S;
        if (Math.hypot(x, z) > COVER_R - 8) continue;
        if (!mask.open(x, z, 0.4)) continue;
        let p = 0.07;
        if (mask.water(x, z).edge < 3) p += 0.3;
        if (near(mask.paved, x, z, 0.4, 2)) p += 0.15;
        if (cs.float(i, j, 72) > p) continue;
        const sc = cs.range(0.7, 1.5, i, j, 73);
        put(stones, gt.stones[cs.int(0, gt.stones.length - 1, i, j, 74)]!, x, z, cs.range(0, 6.28, i, j, 75), sc, [1, 1, 1], 0.2, 0.02);
        nStones++;
      }
    }
    // Mushrooms between the roots of the giants and under the trees.
    let nMush = 0;
    giants.forEach((t, gi) => {
      for (let k = 0; k < 6; k++) {
        const a = cs.range(0, 6.28, gi, k, 80);
        const d = cs.range(2.4, 5.5, gi, k, 81) * t.scale;
        const x = t.x + Math.sin(a) * d, z = t.z + Math.cos(a) * d;
        if (!mask.open(x, z, 0.3)) continue;
        put(wet, gt.mushrooms[cs.int(0, 1, gi, k, 82)]!, x, z, a, cs.range(0.8, 1.3, gi, k, 83), [1, 1, 1], 0.05);
        nMush++;
      }
    });
    for (const [kind, list] of [['oak', place.oak], ['apple', place.apple]] as const) {
      list.forEach((p, k) => {
        if (!cs.chance(0.2, p.i, 84)) return;
        const a = cs.range(0, 6.28, p.i, 85);
        const x = p.x + Math.sin(a) * 0.9 * p.sc, z = p.z + Math.cos(a) * 0.9 * p.sc;
        if (!mask.open(x, z, 0.2)) return;
        put(wet, gt.mushrooms[kind === 'apple' ? 0 : (k % 2)]!, x, z, a, 0.9, [1, 1, 1], 0.05);
        nMush++;
      });
    }

    lap('rest');
    // --- Gardens ---------------------------------------------------------------------------------------------------------
    const ct = cropTemplates(ctx.stream('vegetation-crops-tpl'));
    const soil = new MeshBuilder();
    const crops = new MeshBuilder();
    let nCrops = 0;
    L.gardens.forEach((g, gi) => (nCrops += buildGarden(soil, crops, g, ct, gt, ctx.heightAt, ctx.stream(`vegetation-garden-${gi}`))));

    lap('gardens');
    // --- Ivy -------------------------------------------------------------------------------------------------------------
    const ivy = new MeshBuilder();
    const is = ctx.stream('vegetation-ivy');
    const corners = ivyCorners(L.structures, is, (x, z) => mask.building(x, z) < 0.2 || mask.water(x, z).edge < 0.6 || mask.paved(x, z) < 0.3);
    for (const c of corners) {
      const groundY = ctx.field.padY(c.s.id) - 0.15;
      const h = c.s.kind === 'inn' ? 4.6 : lerp(2.2, 3.2, is.float(c.k, 1)) * Math.min(1.4, c.s.stories);
      cornerIvy(ivy, c.ring, c.k, groundY, h, is.child(`${c.s.id}-${c.k}`));
    }

    lap('ivy');
    statics.push(
      { material: 'solid', mesh: grass, castShadow: false, name: 'grass' },
      { material: 'solid', mesh: flowers, castShadow: false, name: 'flowers' },
      { material: 'solid', mesh: wet, castShadow: false, name: 'ferns-reeds-mushrooms' },
      { material: 'solid', mesh: stones, name: 'stones' },
      { material: 'solid', mesh: soil, castShadow: false, name: 'garden-soil' },
      { material: 'solid', mesh: crops, castShadow: false, name: 'crops' },
      { material: 'solid', mesh: ivy, name: 'ivy' },
    );
    Object.assign(stats, { grassTufts: nGrass, flowerClumps: nFlowers, ferns: nFerns, reeds: nReeds, stones: nStones, mushrooms: nMush, crops: nCrops, ivyCorners: corners.length, extraBushes: extra });
    return { statics: statics.filter((p) => p.mesh.triangleCount > 0), parts, solids, stats };
  },
};

/** For checks: the mask of a context (scripts). */
export function vegetationMask(ctx: BuildContext): Mask {
  return createMask(ctx);
}
