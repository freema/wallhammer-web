// Props of the village (owner: props and effects). Everything small that makes the village lived in, placed from the
// layout: lantern posts along the streets (glass that flickers in the evening, a warm light each), fences with gates
// round the gardens and along the streets, the three market stalls with canopies and goods, the well, benches, the
// smithy inside the forge (hearth, bellows that pump, anvil, quench trough, tool rack), barrels, crates and sacks by
// the doors, a handcart, woodpiles, a ladder, a washing line, and a watering trough.
//
// Statics are merged into one batch (plus a small water batch for the troughs and the well); groups are baked for
// occlusion one by one. Two instanced sets move: the lantern glass (glow flicker) and the bellows (pumping).

import type { BuildContext, ContentModule, FrameInfo, HullOptions, Mat34, MeshBuilder, PointLight, SolidDef, StaticPiece, Vec3 } from '../kit/index.ts';
import { compose34, createPartSet, cylinderSolid, hullSolid, pushPart, rotateY, waterFlags } from '../kit/index.ts';
import type { Structure } from '../layout.ts';
import { toWorld } from '../layout.ts';
import { bakeInto, builder, freeSpot, groundUnder } from './common.ts';
import { basket } from './containers.ts';
import { buildFence } from './fence.ts';
import type { FenceStats } from './fence.ts';
import { LANTERN_GLASS_Y, LANTERN_REACH, lanternGlassMesh, lanternPost } from './lantern.ts';
import { bellowsPartMesh, smithy, trough } from './smithy.ts';
import { stall } from './stall.ts';
import { well } from './well.ts';
import { bench, cart, clutter, ladder, washingLine, woodpile } from './yard.ts';

export { forgeAnchors } from './smithy.ts';

export const props: ContentModule = {
  name: 'props',
  build(ctx) {
    const { layout } = ctx;
    const s = ctx.stream('props');
    const all = builder();
    const water = builder();
    water.set(waterFlags(0.1, 0, 1, 0));
    const lights: PointLight[] = [];
    // Triangles per section (HUD / inspect), measured as the batch grows.
    const tris: Record<string, number> = {};
    let triMark = 0;
    const cut = (name: string): void => {
      tris[`tris.${name}`] = all.triangleCount - triMark;
      triMark = all.triangleCount;
    };
    // Walk mode: what a walking figure bumps into (posts, the well, stalls, benches, clutter, carts).
    const solids: SolidDef[] = [];
    const hull = (label: string, g: MeshBuilder, o: HullOptions = {}): void => {
      const sd = hullSolid(label, g, o);
      if (sd) solids.push(sd);
    };
    const stats = { lanterns: 0, fences: 0, fencePosts: 0, pickets: 0, gates: 0, stalls: 0, benches: 0, clutter: 0, woodpiles: 0, carts: 0, ladders: 0, washingLines: 0, troughs: 0 };

    // --- Lanterns --------------------------------------------------------------------------------------------------------
    const glass = createPartSet('props.lantern-glass', lanternGlassMesh(), Math.max(1, layout.lanterns.length), { dynamic: true, castShadow: false });
    const flickerPhase = new Float32Array(layout.lanterns.length * 2);
    layout.lanterns.forEach((l, i) => {
      const y = groundUnder(ctx, l.x, l.z, 0.3) + 0.02;
      const g = builder();
      g.with(compose34([l.x, y, l.z], l.yaw), () => lanternPost(g, s.child('lantern'), i));
      solids.push(cylinderSolid('lantern', l.x, l.z, 0.16, y - 0.5, y + 3.3, { standable: false }));
      bakeInto(ctx, all, g, { rays: 8 });
      const gx = l.x + Math.sin(l.yaw) * LANTERN_REACH, gz = l.z + Math.cos(l.yaw) * LANTERN_REACH, gy = y + LANTERN_GLASS_Y;
      pushPart(glass, compose34([gx, gy, gz], l.yaw), 1, 1, 1, 0.35);
      lights.push({ position: [gx, gy - 0.05, gz], color: [1.0, 0.64, 0.3], radius: 10, intensity: 1.15, when: 'evening', flicker: 0.15 });
      flickerPhase[i * 2] = s.range(0, 6.283, i, 900);
      flickerPhase[i * 2 + 1] = s.range(0.8, 1.25, i, 901);
      stats.lanterns++;
    });

    cut('lanterns');

    // --- Fences --------------------------------------------------------------------------------------------------------
    const fs: FenceStats = { posts: 0, rails: 0, pickets: 0, gates: 0 };
    layout.fences.forEach((f, fi) => {
      const g = builder();
      buildFence(ctx, g, f, fi, fs, solids);
      bakeInto(ctx, all, g, { rays: 8, cell: 0.1, reach: 0.9 });
      stats.fences++;
    });
    stats.fencePosts = fs.posts;
    stats.pickets = fs.pickets;
    stats.gates = fs.gates;

    cut('fences');

    // --- Market stalls -------------------------------------------------------------------------------------------------
    layout.stalls.forEach((st, i) => {
      const g = builder();
      const y = groundUnder(ctx, st.x, st.z, 1.4);
      g.with(compose34([st.x, y, st.z], st.yaw), () => stall(g, s.child('stall').child(i), st, i));
      // The counter and the posts, not the canopy over the customers' heads.
      hull('stall', g, { below: 1.3, standable: false });
      bakeInto(ctx, all, g, { rays: 10 });
      stats.stalls++;
    });

    cut('stalls');

    // --- Well ------------------------------------------------------------------------------------------------------------
    {
      const g = builder();
      const { x, z } = layout.well;
      const y = groundUnder(ctx, x, z, 1.0);
      const yaw = 0.35;
      const m = compose34([x, y, z], yaw);
      const world = (p: Vec3): Vec3 => {
        const [dx, dz] = rotateY(p[0], p[2], yaw);
        return [x + dx, y + p[1], z + dz];
      };
      g.with(m, () => well(g, water, s.child('well'), world));
      solids.push(cylinderSolid('well', x, z, 1.05, y - 1, y + 2.9, { standable: false }));
      bakeInto(ctx, all, g, { rays: 12 });
      // A watering trough near the well, on free ground.
      for (let k = 0; k < 12; k++) {
        const a = 2.4 + k * 0.52;
        const tx = x + Math.sin(a) * 3.0, tz = z + Math.cos(a) * 3.0;
        if (!freeSpot(layout, tx, tz, 1.0, 0.0)) continue;
        const ty = groundUnder(ctx, tx, tz, 0.9);
        const tm = compose34([tx, ty, tz], a + Math.PI / 2);
        const t = builder();
        t.with(tm, () => trough(t, water, s.child('trough'), 1.8, 0.6, 0.62, tm));
        hull('trough', t, { standable: false });
        bakeInto(ctx, all, t);
        stats.troughs++;
        break;
      }
    }

    cut('well');

    // --- Benches -------------------------------------------------------------------------------------------------------
    layout.benches.forEach((bn, i) => {
      const g = builder();
      g.with(compose34([bn.x, groundUnder(ctx, bn.x, bn.z, 0.9), bn.z], bn.yaw), () => bench(g, s.child('bench').child(i), i !== 1));
      hull('bench', g, { below: 0.5 });
      bakeInto(ctx, all, g);
      stats.benches++;
    });

    cut('benches');

    // --- The smithy ----------------------------------------------------------------------------------------------------
    const forge = layout.structures.find((q) => q.kind === 'forge');
    const bellows = createPartSet('props.bellows', bellowsPartMesh(s.child('bellows-part')), 1, { dynamic: true, castShadow: false });
    const bellowsBase: Mat34 = new Float32Array(12);
    if (forge) {
      const g = builder();
      const { bellowsHinge } = smithy(ctx, g, water, forge);
      bakeInto(ctx, all, g, { rays: 12 });
      const [hx, hz] = toWorld(forge, bellowsHinge[0], bellowsHinge[2]);
      compose34([hx, ctx.field.padY(forge.id) + bellowsHinge[1], hz], forge.yaw, 0, 0, [1, 1, 1], bellowsBase);
      pushPart(bellows, bellowsBase);
      stats.troughs++;
    }

    cut('smithy');

    // --- Clutter by doors: barrels, crates and sacks -------------------------------------------------------------------
    const near = (st: Structure, lx: number, lz: number, r: number, fn: (g: MeshBuilder) => void, yaw = 0, wall = r + 0.15): boolean => {
      const [x, z] = toWorld(st, lx, lz);
      if (!freeSpot(layout, x, z, r, -0.3, wall)) return false;
      const g = builder();
      g.with(compose34([x, groundUnder(ctx, x, z, r * 0.6), z], st.yaw + yaw), () => fn(g));
      hull('clutter', g, { standable: false });
      bakeInto(ctx, all, g);
      return true;
    };
    for (const st of layout.structures) {
      if (st.kind === 'windmill' || st.kind === 'castle' || st.kind === 'forge') continue;
      const front = st.body.z + st.body.d / 2;
      const cs = s.child('clutter').child(st.index + (st.kind === 'inn' ? 50 : st.kind === 'mill' ? 60 : 0));
      const n = st.kind === 'inn' ? 5 : st.kind === 'mill' ? 4 : 2 + (st.index % 2);
      // Try spots beside the door, either side, then by the corners.
      const doorX = toLocalX(st);
      const tries: [number, number][] = [[doorX + 2.0, front + 1.1], [doorX - 2.0, front + 1.1], [st.body.x + st.body.w / 2 - 0.9, front + 1.1], [st.body.x - st.body.w / 2 + 0.9, front + 1.1], [st.body.x + st.body.w / 2 + 1.1, st.body.z], [st.body.x - st.body.w / 2 - 1.1, st.body.z]];
      if (st.kind === 'inn') tries.unshift([3.9, front + 1.1]);
      for (const [lx, lz] of tries) {
        if (near(st, lx, lz, 0.9, (g) => clutter(g, cs, n), cs.range(-0.3, 0.3, 1), 0.85)) {
          stats.clutter++;
          break;
        }
      }
    }

    cut('clutter');

    // --- Woodpiles against side walls, a ladder, a cart, a washing line, baskets by the gardens ----------------------
    const cottages = layout.structures.filter((q) => q.kind === 'cottage');
    for (const c of cottages) {
      if (c.index % 2 === 1) continue;
      const ws = s.child('woodpile').child(c.index);
      for (const side of [1, -1]) {
        const lx = side * (c.body.w / 2 + 0.6) + c.body.x;
        if (near(c, lx, c.body.z - 0.3, 1.3, (g) => g.with(compose34([0, 0, 0], side * Math.PI / 2), () => woodpile(g, ws, 2.4)), 0, 0.45)) {
          stats.woodpiles++;
          break;
        }
      }
    }
    const forLadder = cottages.find((q) => q.plan === 'long') ?? cottages[0];
    if (forLadder) {
      const c = forLadder;
      for (const side of [1, -1]) {
        const lx = side * (c.body.w / 2 + 0.85) + c.body.x;
        const [x, z] = toWorld(c, lx, c.body.z + 0.8);
        if (!freeSpot(layout, x, z, 0.4, -0.3)) continue;
        const g = builder();
        const lean = Math.asin(0.82 / 3.1);
        g.with(compose34([x, groundUnder(ctx, x, z, 0.25), z], c.yaw + side * Math.PI / 2), () => ladder(g, s.child('ladder'), 3.1, lean));
        bakeInto(ctx, all, g);
        stats.ladders++;
        break;
      }
    }
    const mill = layout.structures.find((q) => q.kind === 'mill');
    const cartTries: [Structure | undefined, number, number, number][] = [[mill, -2.0, mill ? mill.body.d / 2 + 3.2 : 0, 0.6], [layout.structures.find((q) => q.id === 'cottage-3'), 5.2, 1.5, 1.2], [layout.structures.find((q) => q.id === 'cottage-0'), -5.5, 1.5, -0.8]];
    for (const [st, lx, lz, yaw] of cartTries) {
      if (!st) continue;
      if (near(st, lx, lz, 1.5, (g) => cart(g, s.child('cart')), yaw)) {
        stats.carts++;
        break;
      }
    }
    // The washing line behind a cottage: a free strip of 7 m.
    const lineTries: [string, number][] = [['cottage-3', -1], ['cottage-5', -1], ['cottage-0', -1], ['cottage-2', -1], ['cottage-3', 1]];
    for (const [id, side] of lineTries) {
      const c = layout.structures.find((q) => q.id === id);
      if (!c) continue;
      const lz = side * (c.body.d / 2 + 3.2) + c.body.z;
      let ok = true;
      for (let k = -4; k <= 4; k++) {
        const [x, z] = toWorld(c, c.body.x + k * 0.85, lz);
        if (!freeSpot(layout, x, z, 0.7, 0.1)) ok = false;
      }
      if (!ok) continue;
      const [x, z] = toWorld(c, c.body.x, lz);
      const g = builder();
      g.with(compose34([x, groundUnder(ctx, x, z, 3), z], c.yaw), () => washingLine(g, s.child('washing'), 6.6));
      bakeInto(ctx, all, g, { rays: 8 });
      stats.washingLines++;
      break;
    }
    // A basket of the crop beside each garden gate.
    layout.gardens.forEach((gd, i) => {
      const [dx, dz] = rotateY(gd.w / 2 + 0.95, gd.d / 2 + 0.6, gd.yaw);
      const x = gd.x + dx, z = gd.z + dz;
      if (!freeSpot(layout, x, z, 0.35, -0.2)) return;
      const g = builder();
      const crop = gd.crop === 'cabbage' ? 'cabbages' : gd.crop === 'pumpkin' ? 'turnips' : gd.crop === 'herbs' ? 'carrots' : 'apples';
      g.with(compose34([x, groundUnder(ctx, x, z, 0.3), z], gd.yaw), () => basket(g, s.child('garden-basket').child(i), { radius: 0.3, height: 0.3, handle: i % 2 === 0, content: crop }));
      hull('basket', g);
      bakeInto(ctx, all, g);
    });

    cut('yard');

    // --- Contribution ----------------------------------------------------------------------------------------------------
    const statics: StaticPiece[] = [{ material: 'solid', mesh: all, name: 'props' }];
    if (water.triangleCount > 0) statics.push({ material: 'water', mesh: water, name: 'props-water' });
    const bellowsM = new Float32Array(12);
    const update = (f: FrameInfo): void => {
      const t = f.time;
      if (f.evening > 0.001) {
        const d = glass.data;
        for (let i = 0; i < glass.count; i++) {
          const ph = flickerPhase[i * 2]!, sp = flickerPhase[i * 2 + 1]!;
          // A candle: a slow breathing, a quicker flutter, a rare dip.
          const g = 0.36 + 0.1 * Math.sin(t * 2.1 * sp + ph) + 0.07 * Math.sin(t * 7.3 * sp + ph * 2.0) * Math.sin(t * 4.9 + ph) - 0.08 * Math.max(0, Math.sin(t * 0.7 * sp + ph * 3.0) - 0.85) * 6;
          d[i * 16 + 15] = g;
        }
        glass.dirty = true;
      }
      if (bellows.count > 0) {
        // Pumping: the bag squashes (scale y about the hinge) and fills again, a stroke every ~3.5 s.
        const ph = (t * 1.8) % (Math.PI * 2);
        const sc = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(ph + Math.sin(ph) * 0.6));
        for (let k = 0; k < 12; k++) bellowsM[k] = bellowsBase[k]!;
        bellowsM[3] = bellowsBase[3]! * sc;
        bellowsM[4] = bellowsBase[4]! * sc;
        bellowsM[5] = bellowsBase[5]! * sc;
        for (let k = 0; k < 12; k++) bellows.data[k] = bellowsM[k]!;
        bellows.dirty = true;
      }
    };
    return {
      statics,
      parts: [glass, bellows],
      lights,
      update,
      solids,
      stats: { ...stats, ...tris, triangles: all.triangleCount },
    };
  },
};

/** The door's position along the structure's local x. */
function toLocalX(st: Structure): number {
  const dx = st.door.x - st.x, dz = st.door.z - st.z;
  return rotateY(dx, dz, -st.yaw)[0];
}

export type { BuildContext };
