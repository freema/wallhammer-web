// Garden beds by the cottages (layout.gardens): raised soil rows and the crops on them. Cabbage gardens grow rows of
// cabbages with carrots, lettuce and onions between; the pumpkin garden ribbed pumpkins on vines; the herb garden
// lettuce, herbs, carrots and onions; the flower garden dense mixed flowers. The fences round the beds are props.

import type { RGB, Stream, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, add3, compose34, hex, lerp, mixRgb, norm3, rotateY, scale3, scaleRgb, shiftHsv, sweep } from '../kit/index.ts';
import type { Garden } from '../layout.ts';
import { barkTube, blade, ellipsoid, leaf } from './common.ts';
import type { FoliageStyle } from './foliage.ts';
import { IVY, leafCluster } from './foliage.ts';
import type { FlowerKind, GroundTemplates } from './ground-cover.ts';

type Crop = 'cabbage' | 'carrot' | 'lettuce' | 'onion' | 'pumpkin' | 'herbs' | 'flowers';

/** Spacing of plants along a row. */
const SPACING: Record<Crop, number> = { cabbage: 0.55, carrot: 0.3, lettuce: 0.42, onion: 0.28, pumpkin: 1.15, herbs: 0.45, flowers: 0.38 };

/** Row programmes of each garden kind (cycled over the rows). */
const ROWS: Record<Garden['crop'], Crop[]> = {
  cabbage: ['cabbage', 'cabbage', 'carrot', 'lettuce', 'cabbage', 'onion'],
  pumpkin: ['pumpkin', 'lettuce', 'pumpkin', 'carrot'],
  herbs: ['lettuce', 'herbs', 'carrot', 'onion', 'herbs'],
  flowers: ['flowers'],
};

const UP: Vec3 = [0, 1, 0];

function cabbage(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  const head = hex('#b6d48a');
  ellipsoid(b, [0, 0.12, 0], [0.16, 0.14, 0.16], { seg: 8, rings: 5, noise: 0.06, seed: 3, paint: (d) => scaleRgb(head, lerp(0.75, 1.1, d[1] * 0.5 + 0.5)), sway: () => 0.05 });
  const n = 7;
  const outer = hex('#6e9e5a');
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + s.nextJitter(0.3);
    const rd: Vec3 = [Math.sin(a), 0, Math.cos(a)];
    const tip = norm3(add3(scale3(rd, 0.85), [0, s.nextRange(0.45, 0.8), 0]));
    const nrm = norm3(add3(UP, scale3(rd, -0.7)));
    const col = shiftHsv(outer, s.nextJitter(0.02), s.nextJitter(0.1), s.nextJitter(0.12));
    leaf(b, add3(scale3(rd, 0.05), [0, 0.03, 0]), tip, nrm, s.nextRange(0.26, 0.33), 0.3, { base: col, tip: hex('#a8cc8a'), under: scaleRgb(col, 0.6) }, [0.05, 0.25], add3(UP, scale3(rd, 0.5)));
  }
  return b;
}

function lettuce(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  const green = hex('#9ccc4a');
  ellipsoid(b, [0, 0.06, 0], [0.08, 0.07, 0.08], { seg: 6, rings: 4, paint: () => hex('#c8e070') });
  const n = 9;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + s.nextJitter(0.3);
    const rd: Vec3 = [Math.sin(a), 0, Math.cos(a)];
    const tip = norm3(add3(scale3(rd, 0.7), [0, s.nextRange(0.6, 1.0), 0]));
    const col = shiftHsv(green, s.nextJitter(0.03), s.nextJitter(0.1), s.nextJitter(0.1));
    leaf(b, add3(scale3(rd, 0.03), [0, 0.01, 0]), tip, add3(UP, scale3(rd, -0.8)), s.nextRange(0.17, 0.23), 0.19, { base: col, tip: hex('#d4ea7a'), under: scaleRgb(col, 0.6) }, [0.05, 0.3], add3(UP, scale3(rd, 0.6)));
  }
  return b;
}

function carrot(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.generic });
  ellipsoid(b, [0, -0.01, 0], [0.032, 0.045, 0.032], { seg: 6, rings: 3, paint: (d) => scaleRgb(hex('#e8781e'), lerp(0.75, 1.1, d[1] * 0.5 + 0.5)) });
  b.set({ cls: MAT.foliage });
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + s.nextJitter(0.4);
    blade(b, [0, 0.02, 0], norm3([Math.sin(a) * 0.4, 1, Math.cos(a) * 0.4]), [Math.sin(a), 0, Math.cos(a)], s.nextRange(0.2, 0.32), 0.045, hex('#4a8a2a'), hex('#a8d458'), [0, 0.7]);
  }
  return b;
}

function onion(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.generic });
  ellipsoid(b, [0, 0.02, 0], [0.05, 0.05, 0.05], { seg: 6, rings: 4, paint: (d) => scaleRgb(hex('#eee4c8'), lerp(0.8, 1.05, d[1] * 0.5 + 0.5)) });
  b.set({ cls: MAT.foliage });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + s.nextJitter(0.4);
    blade(b, [0, 0.05, 0], norm3([Math.sin(a) * 0.2, 1, Math.cos(a) * 0.2]), [Math.sin(a), 0, Math.cos(a)], s.nextRange(0.28, 0.4), 0.04, hex('#5a8a6a'), hex('#a8c8a0'), [0, 0.6]);
  }
  return b;
}

function pumpkin(s: Stream): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.generic });
  const R = s.nextRange(0.22, 0.3);
  const H = R * 1.25;
  const spine: Vec3[] = [];
  for (let i = 0; i <= 6; i++) spine.push([0, -0.03 + (i / 6) * H, 0]);
  barkTube(b, spine, { sides: 16, radius: (f) => R * Math.pow(Math.sin(Math.PI * (0.06 + 0.88 * f)), 0.55), ridges: 8, ridgeDepth: 0.11, twist: 0, bark: hex('#d0601c'), barkLight: hex('#f4a040'), foot: 0, seed: 5 });
  // The dimple and the stem on top.
  ellipsoid(b, [0, H - 0.04, 0], [R * 0.42, 0.05, R * 0.42], { seg: 8, rings: 4, paint: () => hex('#b8541a') });
  blade(b, [0, H - 0.02, 0], norm3([0.3, 1, 0.1]), [1, 0, 0], 0.12, 0.05, hex('#6a5a2a'), hex('#8a7a3a'), [0, 0]);
  // Vine leaves lying round it.
  b.set({ cls: MAT.foliage });
  const green = hex('#4f8a32');
  for (let k = 0; k < 4; k++) {
    const a = s.next() * Math.PI * 2;
    const rd: Vec3 = [Math.sin(a), 0, Math.cos(a)];
    const col = shiftHsv(green, s.nextJitter(0.02), s.nextJitter(0.1), s.nextJitter(0.12));
    leaf(b, add3(scale3(rd, R * 0.9), [0, 0.04, 0]), add3(rd, [0, 0.25, 0]), UP, s.nextRange(0.3, 0.42), 0.34, { base: col, tip: hex('#8ab84a'), under: scaleRgb(col, 0.55) }, [0.05, 0.35]);
  }
  b.set({ cls: MAT.bark });
  const vine: Vec3[] = [];
  const a0 = s.next() * Math.PI * 2;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    vine.push([Math.sin(a0 + t * 2) * (R + 0.1 + t * 0.4), 0.03, Math.cos(a0 + t * 2) * (R + 0.1 + t * 0.4)]);
  }
  barkTube(b, vine, { sides: 4, radius: () => 0.018, ridges: 0, ridgeDepth: 0, twist: 0, bark: hex('#4a6a2a'), barkLight: hex('#6a8a3a'), foot: 0, seed: 9 });
  return b;
}

const HERB: FoliageStyle = { ...IVY, dark: hex('#2a5a26'), mid: hex('#5a9a3a'), light: hex('#a8cc5a'), tip: hex('#c8dc6a'), leafLen: 0.1, leafWidth: 0.07, density: 60, maxLeaves: 22, sway: 0.4 };
const SAGE: FoliageStyle = { ...HERB, dark: hex('#3a5a46'), mid: hex('#7a9a82'), light: hex('#b4c8b0'), tip: hex('#c8d8c0') };

function herbs(s: Stream, style: FoliageStyle): MeshBuilder {
  const b = new MeshBuilder();
  b.set({ cls: MAT.foliage });
  leafCluster(b, [0, 0.1, 0], [0.2, 0.16, 0.2], style, s, { floor: -0.6, underLeaves: 0.1 });
  return b;
}

export interface CropTemplates {
  cabbage: MeshBuilder[];
  carrot: MeshBuilder[];
  lettuce: MeshBuilder[];
  onion: MeshBuilder[];
  pumpkin: MeshBuilder[];
  herbs: MeshBuilder[];
}

export function cropTemplates(s: Stream): CropTemplates {
  return {
    cabbage: [cabbage(s.child(1)), cabbage(s.child(2))],
    carrot: [carrot(s.child(3)), carrot(s.child(4))],
    lettuce: [lettuce(s.child(5)), lettuce(s.child(6))],
    onion: [onion(s.child(7))],
    pumpkin: [pumpkin(s.child(8)), pumpkin(s.child(9)), pumpkin(s.child(10))],
    herbs: [herbs(s.child(11), HERB), herbs(s.child(12), SAGE)],
  };
}

const SOIL: RGB = hex('#5e3c24');
const SOIL_LIGHT: RGB = hex('#7e5636');

/** Raised rows and crops of one garden, in world coordinates. Returns the number of plants. */
export function buildGarden(soil: MeshBuilder, plants: MeshBuilder, g: Garden, crops: CropTemplates, ground: GroundTemplates, heightAt: (x: number, z: number) => number, s: Stream): number {
  const world = (lx: number, lz: number): [number, number] => {
    const [dx, dz] = rotateY(lx, lz, g.yaw);
    return [g.x + dx, g.z + dz];
  };
  const spacing = g.crop === 'flowers' ? 0.75 : 0.92;
  const rows = Math.max(1, Math.floor((g.d - 0.5) / spacing) + 1);
  const len = g.w - 0.5;
  const program = ROWS[g.crop];
  let count = 0;
  for (let r = 0; r < rows; r++) {
    const lz = -((rows - 1) * spacing) / 2 + r * spacing;
    // The soil mound along the row, following the ground.
    const path: Vec3[] = [];
    const steps = Math.max(2, Math.ceil(len / 0.5));
    for (let i = 0; i <= steps; i++) {
      const lx = -len / 2 + (i / steps) * len;
      const [x, z] = world(lx, lz);
      path.push([x, heightAt(x, z) - 0.02, z]);
    }
    soil.set({ cls: MAT.ground });
    sweep(soil, path, [[0.36, -0.12], [0.26, 0.08], [0.1, 0.15], [-0.1, 0.15], [-0.26, 0.08], [-0.36, -0.12]], (p, n) => {
      const k = 0.5 + 0.5 * Math.sin(p[0] * 7.1 + p[2] * 5.3) * Math.sin(p[0] * 3.3 - p[2] * 6.1);
      return scaleRgb(mixRgb(SOIL, SOIL_LIGHT, 0.25 + 0.5 * k), lerp(0.75, 1.05, Math.max(0, n[1])));
    }, { caps: true });
    const crop = program[r % program.length]!;
    const step = SPACING[crop];
    const n = Math.max(1, Math.floor(len / step));
    for (let i = 0; i < n; i++) {
      const lx = -len / 2 + (i + 0.5) * (len / n) + s.jitter(step * 0.12, r, i, 1);
      const [x, z] = world(lx, lz + s.jitter(0.05, r, i, 2));
      const y = heightAt(x, z) + 0.12;
      const yaw = s.range(0, Math.PI * 2, r, i, 3);
      const sc = s.range(0.85, 1.15, r, i, 4);
      const m = compose34([x, y, z], yaw, s.jitter(0.06, r, i, 5), s.jitter(0.06, r, i, 6), [sc, sc, sc]);
      if (crop === 'flowers') {
        const kinds: FlowerKind[] = ['pink', 'daisy', 'poppy', 'lavender', 'buttercup', 'bluebell'];
        const kind = kinds[(r * 3 + Math.floor(i / 2)) % kinds.length]!;
        plants.append(ground.flowers[kind][s.int(0, 1, r, i, 7)]!, m);
      } else {
        const list = crops[crop];
        plants.append(list[s.int(0, list.length - 1, r, i, 7)]!, m);
      }
      count++;
    }
  }
  return count;
}
