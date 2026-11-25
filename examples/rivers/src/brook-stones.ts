// Stones in and beside the brooks: a pure function of the brooks and the field. Small faceted stones, built like the
// path's (path-props.ts) but lighter: a ring a little in the ground, a narrower ring turned half a step, a point; on the
// bed and its edges, a few standing half out of the water. More of them where the brook runs steeply (a riffle) and on
// the inside of a bend (its bar of gravel), few in a pool. Their vertices use the ground's layout, so the ground's
// material draws them, lit and shadowed with the ground; they are bucketed by the ground's chunks for culling.

import { hashInts } from 'wallhammer-web/gen-core';
import { BROOK_CLASSES, STEP_M, bedBelow, type BrookPlan } from './brooks.ts';
import type { V3 } from './colours.ts';
import type { Field } from './field.ts';
import { GROUND_LAYOUT } from './ground-layout.ts';
import { CHUNK_CELLS, groundHeightAt, putVertex, type GroundPiece } from './ground-mesh.ts';

type P = [number, number, number];

const STONE_WARM: V3 = [0.4, 0.36, 0.31];
const STONE_COOL: V3 = [0.42, 0.43, 0.42];
const MOSS: V3 = [0.16, 0.26, 0.08];
/** A stone is looked for every this many metres along a brook. */
const LOOK_M = 0.7;
/** The chance of a stone at a look: on level ground, added on a riffle, added on a bar. */
const CHANCE = [0.06, 0.35, 0.3];
/** The grade from which the water counts as a riffle (none under the first, full from the second). */
const RIFFLE: readonly [number, number] = [0.03, 0.12];
/** The bend (1/radius in metres) from which the inside of it has a bar. */
const BAR_BEND: readonly [number, number] = [0.02, 0.09];
/** Radius of a stone: least and largest, metres; on a riffle up to `RIFFLE_GROW` times larger. */
const RADIUS_M = [0.04, 0.14];
const RIFFLE_GROW = 1.7;
/** A stone lies at least this far over the bed's design or the ground, whichever is higher, metres. */
const LIFT_M = 0.01;
/** No stone lies nearer a brook's shore than this, metres along it. */
const SHORE_CLEAR_M = 2;

/** Whether the water of a line, a lake or the sea stands at a corner of the field's cell round a point. */
function wetNear(f: Field, x: number, z: number): boolean {
  const i = Math.min(f.n - 2, Math.max(0, Math.floor((x - f.x0) / f.step)));
  const j = Math.min(f.n - 2, Math.max(0, Math.floor((z - f.z0) / f.step)));
  for (const k of [j * f.n + i, j * f.n + i + 1, (j + 1) * f.n + i, (j + 1) * f.n + i + 1]) if (f.water[k]! > f.ground[k]! + 0.01) return true;
  return false;
}

const TAU = Math.PI * 2;
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The stones of all brooks, as pieces of the ground's layout. */
export function brookStones(f: Field, bp: BrookPlan, seed: number): GroundPiece[] {
  const size = (f.n - 1) * f.step;
  const chunkM = CHUNK_CELLS * f.step;
  const across = Math.ceil(size / chunkM);
  /** Per chunk, nine numbers a vertex: position, normal, colour. */
  const lists: number[][] = [];
  const u = (...k: number[]): number => hashInts(seed, 0xb5, ...k) / 4294967296;

  const tri = (a: P, b: P, c: P, col: V3, shade: number, inside: P): void => {
    let n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    n = [n[0] / l, n[1] / l, n[2] / l];
    if (dot(n, sub(a, inside)) < 0) {
      [b, c] = [c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    const ci = Math.min(across - 1, Math.max(0, Math.floor((a[2] - f.z0) / chunkM))) * across + Math.min(across - 1, Math.max(0, Math.floor((a[0] - f.x0) / chunkM)));
    const list = (lists[ci] ??= []);
    for (const p of [a, b, c]) list.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0] * shade, col[1] * shade, col[2] * shade);
  };

  /** One stone round (cx, y0, cz): radii, turn, height, sides; `key` its own stream of hashes. */
  const stone = (cx: number, y0: number, cz: number, rx: number, rz: number, turn: number, h: number, sides: number, key: number, tone: V3): void => {
    const cosT = Math.cos(turn);
    const sinT = Math.sin(turn);
    const at = (k: number, half: number, r: number, up: number, q: number): P => {
      const a = ((k + half) / sides) * TAU;
      const j = r * (1 + 0.3 * (u(key, k, q) - 0.5));
      const ex = Math.cos(a) * rx * j;
      const ez = Math.sin(a) * rz * j;
      return [cx + cosT * ex - sinT * ez, y0 + up, cz + sinT * ex + cosT * ez];
    };
    const low: P[] = [];
    const high: P[] = [];
    // The low ring lies a little in the ground or the bed: the stone has no skirt of its own.
    for (let k = 0; k < sides; k++) {
      low.push(at(k, 0, 1, -0.15 * h + h * 0.2 * u(key, k, 5), 1));
      high.push(at(k, 0.5, 0.7, h * (0.88 + 0.14 * u(key, k, 6)), 2));
    }
    const top: P = [cx + 0.15 * rx * (u(key, 7) - 0.5), y0 + h, cz + 0.15 * rz * (u(key, 8) - 0.5)];
    const inside: P = [cx, y0 + h * 0.3, cz];
    const mossy = u(key, 9) < 0.2;
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const j = 0.92 + 0.16 * u(key, k, 10);
      tri(low[k]!, low[k1]!, high[k]!, tone, 0.86 * j, inside);
      tri(high[k]!, high[k1]!, low[k1]!, tone, 0.9 * j, inside);
      tri(high[k]!, high[k1]!, top, mossy ? [tone[0] * 0.4 + MOSS[0] * 0.6, tone[1] * 0.4 + MOSS[1] * 0.6, tone[2] * 0.4 + MOSS[2] * 0.6] : tone, 1.05 * j, inside);
    }
  };

  bp.brooks.forEach((b, id) => {
    const depth = BROOK_CLASSES[b.kind]!.depthM;
    // None past a little before its shore: the water it runs into covers the rest, and the brook fades out there.
    const lengthM = Math.min((b.n - 1) * STEP_M, b.shoreM - SHORE_CLEAR_M);
    for (let look = 0, s = 0.5 * LOOK_M; s < lengthM; look++, s += LOOK_M) {
      const fi = s / STEP_M;
      const i = Math.min(b.n - 2, Math.floor(fi));
      const t = fi - i;
      const i2 = Math.min(b.n - 1, i + 2);
      const i0 = Math.max(0, i - 2);
      const grade = (b.water[i0]! - b.water[i2]!) / Math.max(STEP_M, (i2 - i0) * STEP_M);
      const riffle = smooth(RIFFLE[0], RIFFLE[1], grade);
      const bx = b.bend[2 * i]!;
      const bz = b.bend[2 * i + 1]!;
      const bend = Math.hypot(bx, bz);
      const bar = smooth(BAR_BEND[0], BAR_BEND[1], bend);
      if (u(id, look, 1) >= CHANCE[0]! + CHANCE[1]! * riffle + CHANCE[2]! * bar) continue;
      // Where across: anywhere on a riffle; on a bar mostly on its inside; otherwise mostly toward the edges.
      const x = b.x[i]! + (b.x[i + 1]! - b.x[i]!) * t;
      const z = b.z[i]! + (b.z[i + 1]! - b.z[i]!) * t;
      let tx = b.x[i + 1]! - b.x[i]!;
      let tz = b.z[i + 1]! - b.z[i]!;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // Right of the way: (−tz, tx). The inside of the bend is the side the bend points to.
      const insideSign = -tz * bx + tx * bz >= 0 ? 1 : -1;
      const pick = u(id, look, 2);
      let a: number;
      if (bar > 0.3 && pick < 0.6) a = insideSign * (0.45 + 0.45 * u(id, look, 3));
      else if (riffle > 0.4) a = 2 * u(id, look, 3) - 1;
      else a = (u(id, look, 4) < 0.5 ? -1 : 1) * (0.55 + 0.4 * u(id, look, 3));
      a *= 0.95;
      const half = b.half[i]! + (b.half[i + 1]! - b.half[i]!) * t;
      const px = x - tz * a * half;
      const pz = z + tx * a * half;
      const bank = b.bank[i]! + (b.bank[i + 1]! - b.bank[i]!) * t;
      const y = Math.max(bank + bedBelow(a, depth), groundHeightAt(f, px, pz)) + LIFT_M;
      // Nor where the water of a line, a lake or the sea stands.
      if (wetNear(f, px, pz)) continue;
      const grow = 1 + (RIFFLE_GROW - 1) * riffle;
      const r = (RADIUS_M[0]! + (RADIUS_M[1]! - RADIUS_M[0]!) * Math.pow(u(id, look, 5), 2)) * grow;
      const key = id * 65536 + look;
      const cool = u(id, look, 6);
      const tone: V3 = [STONE_WARM[0] + (STONE_COOL[0] - STONE_WARM[0]) * cool, STONE_WARM[1] + (STONE_COOL[1] - STONE_WARM[1]) * cool, STONE_WARM[2] + (STONE_COOL[2] - STONE_WARM[2]) * cool];
      // Stones under the water are darker (wet).
      const wet = y < b.water[i]! ? 0.72 : 1;
      stone(px, y, pz, r, r * (0.65 + 0.35 * u(id, look, 7)), TAU * u(id, look, 8), r * (0.5 + 0.5 * u(id, look, 9)), 5 + (u(id, look, 10) < 0.4 ? 1 : 0), key, [tone[0] * wet, tone[1] * wet, tone[2] * wet]);
    }
  });

  const stride = GROUND_LAYOUT.stride;
  const pieces: GroundPiece[] = [];
  for (const list of lists) {
    if (!list || list.length === 0) continue;
    const count = list.length / 9;
    const view = new DataView(new ArrayBuffer(count * stride));
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v++) {
      const o = v * 9;
      putVertex(view, v, list[o]!, list[o + 1]!, list[o + 2]!, list[o + 3]!, list[o + 4]!, list[o + 5]!, 0, list[o + 6]!, list[o + 7]!, list[o + 8]!);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, list[o + k]!);
        max[k] = Math.max(max[k]!, list[o + k]!);
      }
    }
    const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let v = 0; v < count; v++) indices[v] = v;
    pieces.push({ data: { layout: GROUND_LAYOUT, vertices: new Uint8Array(view.buffer), indices, count }, min, max });
  }
  return pieces;
}
