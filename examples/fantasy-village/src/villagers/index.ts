// The villagers and animals of the village (owner: villagers; A5, A6, B4). Fifteen people and seven animals, each a
// skeleton of the engine's motion whose body parts are instances of four shared part sets (group 'villagers', key V
// hides them): heads, blobs, limb segments and blocks. The life runs on the engine's fixed-step simulation (sim.ts, routines.ts); every
// frame interpolates the simulation, poses each person through the motion graph of figure.ts and each animal from its
// pose function (animals.ts), and writes the instance matrices in place. The strike mark of the smith's hammer throws
// sparks (instances of the block set) and flashes a light at the anvil.
// `update` allocates nothing: all scratch arrays are made in `build`.

import { NavGraph } from 'wallhammer-web/sim';
import { createPartSet, signedDistToRing } from '../kit/index.ts';
import type { BuildContext, ContentModule, PartSet, PointLight } from '../kit/index.ts';
import { PART_FLOATS } from '../kit/index.ts';
import { CHICKEN_LOOKS, cat, chicken, chickenPose, dog, quadPose } from './animals.ts';
import type { Animal } from './animals.ts';
import { SET, makePeople } from './looks.ts';
import type { PartDef, Person } from './looks.ts';
import { FigureParts, HumanFigure } from './figure.ts';
import { ACT, HUMAN_CHANNELS, poseIn, solve } from './rig.ts';
import type { Skeleton } from './rig.ts';
import { SEAT_Y, routines } from './routines.ts';
import { blobMesh, blockMesh, headMesh, segmentMesh } from './shapes.ts';
import { bridgeFrame } from '../terrain/common.ts';
import { KIND, MODE, VillageLife } from './sim.ts';
import type { Ground } from './sim.ts';
import { M, angleTo, collapse, ease } from './vmath.ts';

/** Sparks thrown by one hammer strike. */
const SPARKS = 14;

/** Ground for walkers: a height grid sampled once at build, the bridge deck, and the obstacles. */
export function makeGround(ctx: BuildContext): Ground {
  const l = ctx.layout;
  const x0 = -70, z0 = -86, step = 1, cols = 121, rows = 177;
  const grid = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) grid[j * cols + i] = ctx.heightAt(x0 + i * step, z0 + j * step);
  const terrain = (x: number, z: number): number => {
    let fx = (x - x0) / step, fz = (z - z0) / step;
    fx = fx < 0 ? 0 : fx > cols - 1.001 ? cols - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > rows - 1.001 ? rows - 1.001 : fz;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = grid[j * cols + i]!, b = grid[j * cols + i + 1]!, c = grid[(j + 1) * cols + i]!, d = grid[(j + 1) * cols + i + 1]!;
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
  // Bridge deck: the profile the bridge is built with (terrain/common.ts bridgeFrame: the ends on the street, a soft
  // parabola up to the deck height in the middle).
  const br = l.bridge;
  const ax = Math.sin(br.yaw), az = Math.cos(br.yaw);
  const half = br.length / 2;
  const deckAt = bridgeFrame(ctx).deckY;
  const blockers = l.structures.filter((s) => s.kind !== 'forge').flatMap((s) => s.footprints);
  const stalls = l.stalls.map((s) => [s.x, s.z] as const);
  const well = l.well;
  return {
    y(x, z) {
      const g = terrain(x, z);
      const dx = x - br.x, dz = z - br.z;
      const along = dx * ax + dz * az, across = dx * az - dz * ax;
      if (Math.abs(along) <= half && Math.abs(across) <= br.width / 2 + 0.3) {
        const deck = deckAt(along);
        return deck > g ? deck : g;
      }
      return g;
    },
    block(x, z) {
      let d = Math.hypot(x - well.x, z - well.z) - 1.0;
      for (let k = 0; k < stalls.length; k++) {
        const s = stalls[k]!;
        const e = Math.hypot(x - s[0], z - s[1]) - 1.15;
        if (e < d) d = e;
      }
      for (let k = 0; k < blockers.length; k++) {
        const e = signedDistToRing(blockers[k]!, x, z);
        if (e < d) d = e;
      }
      return d;
    },
  };
}

export const villagers: ContentModule = {
  name: 'villagers',
  build(ctx) {
    const l = ctx.layout;
    const s = ctx.stream('villagers');
    const people: Person[] = makePeople(s, l.stalls.map((q) => q.goods));
    const animals: Animal[] = [...CHICKEN_LOOKS.map(([name, feathers, tail, scale]) => chicken(name, feathers, tail, scale)), dog(), cat()];

    // Count the instances per set and give every part its index.
    const counts = [0, 0, 0, 0];
    const figures: { skel: Skeleton; parts: PartDef[] }[] = [...people, ...animals];
    for (const f of figures) for (const p of f.parts) counts[p.set]!++;
    const sparkBase = counts[SET.block]!;
    counts[SET.block]! += SPARKS;
    const meshes = [headMesh(), blobMesh(), segmentMesh(), blockMesh()];
    const names = ['villagers-heads', 'villagers-blobs', 'villagers-limbs', 'villagers-blocks'];
    const sets: PartSet[] = meshes.map((m, k) => createPartSet(names[k]!, m, counts[k]!, { dynamic: true, castShadow: true, group: 'villagers' }));
    const next = [0, 0, 0, 0];
    const parts = figures.map((f) => new FigureParts(f.parts, sets, next));
    for (let k = 0; k < 4; k++) sets[k]!.count = counts[k]!;
    // People: the motion graph over each one's own pose input (the fixed fields are set here).
    const humans: HumanFigure[] = people.map((p, i) => {
      const s = poseIn();
      s.ph = i * 0.618;
      s.energy = p.energy;
      s.holdL = p.holdL;
      s.holdR = p.holdR;
      s.listen = p.listen;
      s.armOut = p.body.armOut;
      s.seatDrop = SEAT_Y + p.body.legR * 0.9 - p.body.hipY;
      s.cycle = p.cycle;
      s.stoop = p.stoop;
      return new HumanFigure(p, parts[i]!, s);
    });

    // The life.
    const ground = makeGround(ctx);
    const nav = new NavGraph('villagers-nav', l.nav);
    // Stall nodes stand behind the counters: only the merchants use them, so routes must not pass through them.
    for (let k = 0; k < l.stalls.length; k++) {
      const node = l.pois.find((q) => q.id === `stall-${k}`)?.node ?? -1;
      for (let e = 0; e < nav.edgeCount; e++) if (nav.edgeFrom[e] === node || nav.edgeTo[e] === node) nav.setBlocked(e, true);
    }
    const defs = routines(l, people, animals);
    const life = new VillageLife(defs, nav, ground, ctx.sim.hz);
    life.init(ctx.sim);
    life.attach(ctx.sim);

    // Sparks: fixed launch velocities (forward and up, spread sideways) and lifetimes.
    const sv = new Float64Array(SPARKS * 4);
    for (let k = 0; k < SPARKS; k++) {
      sv[k * 4] = s.range(-1.6, 1.6, 900, k);
      sv[k * 4 + 1] = s.range(1.2, 3.4, 901, k);
      sv[k * 4 + 2] = s.range(0.4, 2.2, 902, k);
      sv[k * 4 + 3] = s.range(0.3, 0.6, 903, k);
    }
    const anvilLight: PointLight = { position: [0, -100, 0], color: [1, 0.62, 0.25], radius: 7, intensity: 0, when: 'always', flicker: 0.2 };
    const smithIx = people.findIndex((p) => p.role === 'smith');

    // Scratch (no allocation in update).
    const bones = new Float64Array(24 * M);
    const poseB = new Float64Array(HUMAN_CHANNELS);
    const hz = ctx.sim.hz;
    const smith = smithIx >= 0 ? humans[smithIx]! : null;

    return {
      parts: sets,
      lights: [anvilLight],
      update(frame) {
        if (!frame.villagersVisible) return;
        const alpha = frame.alpha;
        const rt = Math.max(0, (ctx.sim.tick - 1 + alpha) / hz);
        for (let i = 0; i < life.n; i++) {
          const d = defs[i]!;
          const act = life.act[i]!;
          if (life.mode[i] === MODE.hidden) {
            if (d.kind === KIND.human) humans[d.ref]!.hide();
            else parts[i]!.hide();
            continue;
          }
          const x = life.px[i]! + (life.x[i]! - life.px[i]!) * alpha;
          const z = life.pz[i]! + (life.z[i]! - life.pz[i]!) * alpha;
          const yaw = life.pyaw[i]! + angleTo(life.pyaw[i]!, life.yaw[i]!) * alpha;
          const spd = life.pspd[i]! + (life.spd[i]! - life.pspd[i]!) * alpha;
          const gait = life.pgait[i]! + (life.gait[i]! - life.pgait[i]!) * alpha;
          const y = ground.y(x, z);
          const tA = rt - life.actT0[i]!;
          if (d.kind === KIND.human) {
            const h = humans[d.ref]!;
            const p = h.person;
            const pin = h.input;
            pin.t = rt;
            pin.walk = Math.min(1, spd / (p.speed * 0.85));
            pin.run = act === ACT.run ? Math.min(1, Math.max(0, (spd - 1.2) / 0.8)) : 0;
            pin.gait = gait;
            pin.lookYaw = life.plook[i]! + (life.look[i]! - life.plook[i]!) * alpha;
            pin.lookPitch = 0;
            const sk = ease((rt - life.speakT[i]!) / 0.5);
            pin.speak = life.speaking[i] ? sk : 1 - sk;
            h.pose(x, y, z, yaw, act, tA, rt, life.prop[i]!);
          } else {
            const a = animals[d.ref - people.length]!;
            const walk = Math.min(1, spd / Math.max(0.3, a.speed * 0.5));
            if (a.kind === 'chicken') chickenPose(poseB, act, tA, rt, i * 0.37, Math.min(1, spd / 0.3), gait);
            else quadPose(poseB, a, act, tA, rt, i * 0.37, walk, Math.min(1, Math.max(0, (spd - 1.4) / 1.0)), gait);
            solve(a.skel, x, y, z, yaw, poseB, bones);
            parts[i]!.write(bones, life.prop[i]!, act);
          }
        }

        // Sparks and the flash at the anvil, from the last strike mark of the smith's hammer.
        const blocks = sets[SET.block]!;
        let flash = 0;
        if (smith && life.act[smithIx] === ACT.hammer && life.mode[smithIx] !== MODE.hidden) {
          const age = smith.strikeAt > -Infinity ? rt - smith.strikeAt : -1;
          const yw = life.yaw[smithIx]!;
          const fx = Math.sin(yw), fz = Math.cos(yw);
          const ox = life.x[smithIx]! + fx * 0.62, oz = life.z[smithIx]! + fz * 0.62;
          const oy = ground.y(life.x[smithIx]!, life.z[smithIx]!) + 0.8;
          if (age >= 0) flash = 1.8 * Math.exp(-age * 9);
          anvilLight.position[0] = ox;
          anvilLight.position[1] = oy + 0.3;
          anvilLight.position[2] = oz;
          for (let q = 0; q < SPARKS; q++) {
            const o = (sparkBase + q) * PART_FLOATS;
            const life0 = sv[q * 4 + 3]!;
            if (age < 0 || age > life0) {
              collapse(blocks.data, o);
              continue;
            }
            // Launch in the smith's frame: sideways, up, forward.
            const vs = sv[q * 4]!, vu = sv[q * 4 + 1]!, vf = sv[q * 4 + 2]!;
            const vx = fx * vf + fz * vs, vz = fz * vf - fx * vs;
            const sc = 0.02 * (1 - age / life0) + 0.006;
            const d = blocks.data;
            // A streak stretched along the flight direction: z along the velocity, x level, y the rest.
            const wy = vu - 9.8 * age;
            const vl = Math.hypot(vx, wy, vz) || 1;
            const zx = vx / vl, zy = wy / vl, zz = vz / vl;
            let xx = zz, xz = -zx;
            const xl = Math.hypot(xx, xz) || 1;
            xx /= xl; xz /= xl;
            const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
            d[o] = xx * sc; d[o + 1] = 0; d[o + 2] = xz * sc;
            d[o + 3] = yx * sc; d[o + 4] = yy * sc; d[o + 5] = yz * sc;
            d[o + 6] = zx * sc * 3; d[o + 7] = zy * sc * 3; d[o + 8] = zz * sc * 3;
            d[o + 9] = ox + vx * age;
            d[o + 10] = oy + vu * age - 4.9 * age * age;
            d[o + 11] = oz + vz * age;
            d[o + 12] = 6; d[o + 13] = 2.6; d[o + 14] = 0.6; d[o + 15] = 2; // glow 2: shines in daylight too
          }
        } else {
          for (let q = 0; q < SPARKS; q++) collapse(blocks.data, (sparkBase + q) * PART_FLOATS);
        }
        anvilLight.intensity = flash;
        for (let k = 0; k < 4; k++) sets[k]!.dirty = true;
      },
      stats: {
        villagers: people.length,
        animals: animals.length,
        villagerParts: counts.reduce((a, b) => a + b, 0),
      },
    };
  },
};
