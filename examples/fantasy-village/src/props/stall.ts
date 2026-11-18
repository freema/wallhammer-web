// Market stalls (B2: stalls with red and cream canopies, crates, barrels, produce): a frame of thick crooked posts,
// taller at the back, a plank counter with an overhanging top, a canopy of sewn cloth panels that sags between the
// beams and ends in a scalloped valance at the front (it moves gently in the wind through the sway flag), goods on the
// counter by the stall's trade, bundles hanging from the front beam, and spare stock beside the stall.

import type { MeshBuilder, RGB, Stream, Vec3 } from '../kit/index.ts';
import { MAT, PALETTE, VARY_RICH, VARY_SUBTLE, bevelBox, compose34, crookedBeam, lathe, mixRgb, scaleRgb, vary, varyNext } from '../kit/index.ts';
import type { Stall } from '../layout.ts';
import { PROP, lightWoodColor, rope, woodColor } from './common.ts';
import { barrel, basket, crate, producePiece, sack } from './containers.ts';
import type { Produce } from './containers.ts';

const W = 3.0;
const FRONT_Z = 0.72;
const BACK_Z = -0.82;
const FRONT_H = 2.3;
const BACK_H = 2.8;
/** Height of the counter top (goods stand on it). */
export const COUNTER_Y = 1.0;

/** One stall at the local origin, counter toward +z. */
export function stall(b: MeshBuilder, s: Stream, st: Stall, index: number): void {
  const wood = woodColor(s, 1);
  const post = (x: number, z: number, h: number, k: number): void => {
    crookedBeam(b, [x, -0.3, z], [x + s.jitter(0.05, k, 2), h, z + s.jitter(0.05, k, 3)], (p) => scaleRgb(wood, 0.7 + 0.35 * Math.min(1, Math.max(0, p[1] / h))), {
      width: 0.2, wobble: 0.03, irregular: 0.12, stream: s.child(k), segments: 3, twist: 0.2,
    });
  };
  b.withFlags({ cls: MAT.wood }, () => {
    // Posts and the roof frame.
    post(-W / 2, FRONT_Z, FRONT_H + 0.08, 1);
    post(W / 2, FRONT_Z, FRONT_H + 0.08, 2);
    post(-W / 2, BACK_Z, BACK_H + 0.08, 3);
    post(W / 2, BACK_Z, BACK_H + 0.08, 4);
    crookedBeam(b, [-W / 2 - 0.25, FRONT_H, FRONT_Z], [W / 2 + 0.25, FRONT_H, FRONT_Z], scaleRgb(wood, 0.9), { width: 0.16, depth: 0.18, sag: 0.04, stream: s.child(5), segments: 4 });
    crookedBeam(b, [-W / 2 - 0.25, BACK_H, BACK_Z], [W / 2 + 0.25, BACK_H, BACK_Z], scaleRgb(wood, 0.9), { width: 0.16, depth: 0.18, sag: 0.03, stream: s.child(6), segments: 4 });
    for (const sx of [-1, 1]) crookedBeam(b, [sx * W / 2, BACK_H + 0.05, BACK_Z - 0.2], [sx * W / 2, FRONT_H + 0.05, FRONT_Z + 0.2], scaleRgb(wood, 0.85), { width: 0.13, depth: 0.15, stream: s.child(7 + sx), segments: 3 });
    // Counter: a front of vertical planks, sides of horizontal ones, an overhanging top of two boards.
    const planks = 10;
    for (let i = 0; i < planks; i++) {
      const x = -W / 2 + 0.12 + ((W - 0.24) * (i + 0.5)) / planks;
      bevelBox(b, [x, 0, 0.6], [(W - 0.24) / planks - 0.015, COUNTER_Y - 0.06 + s.jitter(0.03, i, 10), 0.05], (p) => scaleRgb(lightWoodColor(s, i, 11), 0.72 + 0.3 * Math.min(1, p[1] / COUNTER_Y)), { bevel: 0.012, jitter: 0.008, stream: s });
    }
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 4; k++) bevelBox(b, [sx * (W / 2 - 0.1), k * 0.235, 0.15], [0.05, 0.22, 0.9], lightWoodColor(s, sx, k, 12), { bevel: 0.012, jitter: 0.008, stream: s });
    }
    bevelBox(b, [0, COUNTER_Y - 0.08, 0.66], [W - 0.1, 0.06, 0.12], scaleRgb(wood, 0.8), { bevel: 0.015 });
    for (let k = 0; k < 2; k++) bevelBox(b, [s.jitter(0.03, k, 13), COUNTER_Y - 0.06, 0.3 + k * 0.36], [W + 0.1, 0.07, 0.35], varyNext(PALETTE.timberLight, VARY_RICH, s), { bevel: 0.02, jitter: 0.01, stream: s });
    // A low shelf behind for the seller.
    bevelBox(b, [0, 0.42, -0.5], [W - 0.4, 0.06, 0.45], lightWoodColor(s, 14), { bevel: 0.015 });
    for (const sx of [-1, 1]) bevelBox(b, [sx * (W / 2 - 0.35), 0, -0.5], [0.08, 0.42, 0.4], scaleRgb(wood, 0.8), { bevel: 0.015 });
  });
  canopy(b, s, st.canopy);
  goods(b, s, st.goods, index);
}

/** The cloth: sewn panels across, sagging between the beams, a scalloped valance at the front; both sides drawn. */
function canopy(b: MeshBuilder, s: Stream, kind: Stall['canopy']): void {
  const red = vary(PALETTE.fabricRed, VARY_SUBTLE, s, 20);
  const cream = vary(PALETTE.fabricCream, VARY_SUBTLE, s, 21);
  const panels = 6;
  const X0 = -W / 2 - 0.22, X1 = W / 2 + 0.22;
  const backZ = BACK_Z - 0.22, frontZ = FRONT_Z + 0.24;
  const backY = BACK_H + 0.1, frontY = FRONT_H + 0.1;
  const valance = 0.34;
  const at = (x: number, u: number): Vec3 => {
    const xn = (x - X0) / (X1 - X0);
    const sag = 0.17 * Math.sin(Math.PI * u) * (0.35 + 0.65 * Math.sin(Math.PI * xn)) + 0.015 * Math.sin(xn * 31 + u * 5);
    return [x, backY + (frontY - backY) * u - sag, backZ + (frontZ - backZ) * u];
  };
  b.withFlags({ cls: MAT.fabric }, () => {
    for (let p = 0; p < panels; p++) {
      const c: RGB = kind === 'stripes' ? (p % 2 ? cream : red) : kind === 'red' ? scaleRgb(red, p % 2 ? 0.94 : 1.03) : scaleRgb(cream, p % 2 ? 0.95 : 1.02);
      const xa = X0 + ((X1 - X0) * p) / panels, xb = X0 + ((X1 - X0) * (p + 1)) / panels;
      const cols = 4, rows = 8;
      const pos = (i: number, j: number): Vec3 => at(xa + ((xb - xa) * i) / (cols - 1), j / (rows - 1));
      const sway = (i: number, j: number): number => 0.45 * Math.sin((Math.PI * j) / (rows - 1)) * (0.4 + 0.6 * Math.sin(Math.PI * ((xa + ((xb - xa) * i) / (cols - 1) - X0) / (X1 - X0))));
      // Top (flip: the grid's own normal points down here) and underside, a little darker and warmer.
      const top = b.vertexCount;
      b.grid(cols, rows, pos, (_i, j) => scaleRgb(c, 0.92 + 0.12 * (j / (rows - 1))), { flip: true });
      setSway(b, top, cols, rows, sway);
      const under = b.vertexCount;
      b.grid(cols, rows, (i, j) => {
        const q = pos(i, j);
        return [q[0], q[1] - 0.018, q[2]];
      }, () => scaleRgb(mixRgb(c, [1, 0.8, 0.6], 0.1), 0.78));
      setSway(b, under, cols, rows, sway);
      // Valance: hangs from the front edge with a rounded scallop per panel.
      const vr = 4;
      const vpos = (i: number, j: number): Vec3 => {
        const x = xa + ((xb - xa) * i) / (cols - 1);
        const q = at(x, 1);
        const scallop = 0.09 * Math.sin((Math.PI * i) / (cols - 1));
        return [x, q[1] - (valance + scallop) * (j / (vr - 1)), q[2] + 0.02 + 0.015 * (j / (vr - 1))];
      };
      const vsway = (_i: number, j: number): number => 0.25 + 0.4 * (j / (vr - 1));
      const vo = b.vertexCount;
      b.grid(cols, vr, vpos, (_i, j) => scaleRgb(c, 1.0 - 0.12 * (j / (vr - 1))), { flip: true });
      setSway(b, vo, cols, vr, vsway);
      const vi = b.vertexCount;
      b.grid(cols, vr, (i, j) => {
        const q = vpos(i, j);
        return [q[0], q[1], q[2] - 0.015];
      }, () => scaleRgb(c, 0.7));
      setSway(b, vi, cols, vr, vsway);
      // The seam: a darker cord along the panel edge.
      if (p > 0) {
        const seam: Vec3[] = [];
        for (let j = 0; j <= 6; j++) {
          const q = at(xa, j / 6);
          seam.push([q[0], q[1] + 0.012, q[2]]);
        }
        rope(b, seam, 0.012, scaleRgb(kind === 'cream' ? cream : red, 0.6), 3);
        setSway(b, b.vertexCount - (seam.length * 3 + 2 * 3), 1, 1, () => 0.2);
      }
    }
  });
}

/** Sets the sway flag of a grid of vertices written from `first` (cols × rows, column index fastest). */
function setSway(b: MeshBuilder, first: number, cols: number, rows: number, fn: (i: number, j: number) => number): void {
  for (let v = first; v < b.vertexCount; v++) {
    const k = v - first;
    const i = k % cols, j = Math.floor(k / cols) % rows;
    b.flg[v * 4 + 1] = Math.max(0, Math.min(1, fn(i, j)));
  }
}

/** Goods on the counter and stock around the stall, by trade. */
function goods(b: MeshBuilder, s: Stream, trade: Stall['goods'], index: number): void {
  const Y = COUNTER_Y + 0.01;
  const g = s.child('goods');
  const put = (x: number, z: number, yaw: number, fn: () => void): void => {
    b.with(compose34([x, Y, z], yaw), fn);
  };
  const baskets: Produce[] =
    trade === 'vegetables' ? ['cabbages', 'carrots', 'turnips', 'cabbages'] :
    trade === 'apples' ? ['apples', 'greenApples', 'pears', 'apples'] :
    trade === 'pottery' ? ['pots', 'pots', 'pots', 'pots'] : ['cloth', 'cloth', 'cloth', 'cloth'];
  const slots = [-1.05, -0.38, 0.32, 1.02];
  slots.forEach((x, k) => {
    const kind = baskets[k]!;
    if (kind === 'cloth') {
      // Stacks of folded bolts and a roll lying on the counter.
      put(x, 0.42 + g.jitter(0.05, k, 1), g.jitter(0.25, k, 2), () => {
        let y = 0;
        const n = g.int(2, 4, k, 3);
        for (let i = 0; i < n; i++) y += producePiece(b, g, 'cloth', [g.jitter(0.03, k, i, 4), y, g.jitter(0.03, k, i, 5)]) - 0.005;
      });
      if (k % 2 === 0) {
        const c = varyNext(g.nextPick([PALETTE.fabricBlue, PALETTE.fabricGreen, PALETTE.fabricRed, PROP.linen]), VARY_SUBTLE, g);
        put(x + 0.15, 0.2, Math.PI / 2 + g.jitter(0.2, k, 6), () => b.withFlags({ cls: MAT.fabric }, () => b.with(compose34([0, 0.075, 0], 0, 0, Math.PI / 2), () => lathe(b, [0, -0.25, 0], [[0.075, 0], [0.078, 0.25], [0.075, 0.5]], c, { segments: 8, capBottom: true, capTop: true }))));
      }
    } else if (kind === 'pots') {
      put(x, 0.42, 0, () => {
        for (let i = 0; i < 3; i++) producePiece(b, g, 'pots', [g.jitter(0.12, k, i, 7), 0, g.jitter(0.1, k, i, 8)]);
      });
    } else if (k === 2 && trade === 'vegetables') {
      put(x, 0.42, g.jitter(0.2, k, 9), () => crate(b, g.child(k), { size: [0.55, 0.32, 0.42], open: true, content: kind }));
    } else {
      put(x, 0.42 + g.jitter(0.04, k, 10), g.jitter(1, k, 11), () => basket(b, g.child(k), { radius: g.range(0.2, 0.25, k, 12), height: g.range(0.16, 0.22, k, 13), handle: g.chance(0.4, k, 14), content: kind }));
    }
  });
  // Loose pieces on the counter front edge.
  const loose: Produce = trade === 'vegetables' ? 'carrots' : trade === 'apples' ? 'apples' : trade === 'pottery' ? 'pots' : 'cloth';
  if (loose !== 'cloth') for (let i = 0; i < 4; i++) producePiece(b, g, loose, [-0.9 + i * 0.55 + g.jitter(0.1, i, 15), Y, 0.78 + g.jitter(0.03, i, 16)]);
  // Bundles hanging from the front beam: herbs and garlic for food, cloth lengths for the draper.
  b.withFlags({ cls: trade === 'cloth' ? MAT.fabric : MAT.foliage }, () => {
    for (let i = 0; i < 5; i++) {
      const x = -1.2 + i * 0.6 + g.jitter(0.08, i, 17);
      const top: Vec3 = [x, FRONT_H - 0.12, FRONT_Z - 0.02];
      if (trade === 'cloth') {
        const c = vary(g.pick([PALETTE.fabricBlue, PALETTE.fabricGreen, PALETTE.gold, PROP.linen, PALETTE.fabricRed], i, 18), VARY_SUBTLE, g, i, 19);
        const len = g.range(0.7, 1.05, i, 20);
        const first = b.vertexCount;
        b.grid(2, 5, (u, j) => [x - 0.16 + u * 0.32, top[1] - (len * j) / 4, top[2] + 0.04 * Math.sin(j * 1.3 + i)], (_u, j) => scaleRgb(c, 1 - 0.15 * (j / 4)), { flip: true });
        setSway(b, first, 2, 5, (_u, j) => 0.2 + 0.6 * (j / 4));
        const back = b.vertexCount;
        b.grid(2, 5, (u, j) => [x - 0.16 + u * 0.32, top[1] - (len * j) / 4, top[2] - 0.012 + 0.04 * Math.sin(j * 1.3 + i)], () => scaleRgb(c, 0.7));
        setSway(b, back, 2, 5, (_u, j) => 0.2 + 0.6 * (j / 4));
      } else {
        const garlic = i % 2 === 1;
        const c = garlic ? PROP.turnip : vary(PROP.greens, VARY_RICH, g, i, 21);
        const len = g.range(0.35, 0.5, i, 22);
        const first = b.vertexCount;
        rope(b, [top, [x, top[1] - 0.12, top[2]]], 0.012, PROP.rope, 3);
        if (garlic) for (let k = 0; k < 4; k++) lathe(b, [x + g.jitter(0.03, i, k, 23), top[1] - 0.16 - k * 0.09, top[2]], [[0.0001, 0], [0.04, 0.02], [0.045, 0.05], [0.02, 0.08], [0.0001, 0.1]], vary(c, VARY_SUBTLE, g, i, k, 24), { segments: 6 });
        else lathe(b, [x, top[1] - 0.12 - len, top[2]], [[0.0001, 0], [0.07, len * 0.25], [0.09, len * 0.6], [0.04, len * 0.95], [0.02, len]], (p) => scaleRgb(c, 0.75 + 0.35 * ((p[1] - top[1] + 0.12 + len) / len)), { segments: 6, noise: 0.15, stream: g.child(i) });
        setSway(b, first, 1, 1, () => 0.35);
      }
    }
  });
  // Stock beside the stall: alternately a stack of crates or sacks with a barrel.
  if (index % 2 === 0) {
    b.with(compose34([W / 2 + 0.55, 0, -0.2], 0.2), () => crate(b, g.child(30), { size: [0.68, 0.5, 0.54] }));
    b.with(compose34([W / 2 + 0.6, 0.525, -0.22], 0.45), () => crate(b, g.child(31), { size: [0.58, 0.4, 0.46], open: true, content: trade === 'apples' ? 'apples' : trade === 'vegetables' ? 'cabbages' : 'cloth' }));
    b.with(compose34([W / 2 + 0.5, 0, 0.62], 0), () => barrel(b, g.child(32)));
  } else {
    for (let k = 0; k < 3; k++) b.with(compose34([-W / 2 - 0.5 + g.jitter(0.12, k, 33), 0, -0.6 + k * 0.48], g.range(0, 6, k, 34), 0, g.jitter(0.15, k, 35)), () => sack(b, g.child(40 + k)));
    b.with(compose34([-W / 2 - 0.55, 0, 0.75], 0.3), () => basket(b, g.child(36), { radius: 0.3, height: 0.32, content: trade === 'apples' ? 'pears' : trade === 'vegetables' ? 'turnips' : 'bread', handle: true }));
  }
  // A spare basket on the seller's shelf.
  b.with(compose34([0.6, 0.48, -0.5], 0), () => basket(b, g.child(50), { radius: 0.18, height: 0.16, content: trade === 'cloth' ? 'cloth' : 'bread' }));
}
