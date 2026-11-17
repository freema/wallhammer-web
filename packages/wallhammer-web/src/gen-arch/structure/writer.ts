// Vertex stream of the structure mesh and the box primitive written into it. Shared by the intact path
// (buildings.ts), the damaged path (damaged.ts) and the rubble generator (rubble.ts).

import { pointInRings, unit } from '../../gen-core/index.ts';
import type { Ring } from '../../gen-core/index.ts';
import type { PropBox } from '../../gen-mesh/index.ts';
import type { VertexLayout } from '../../base/index.ts';

/** What a vertex carries about its building or box. */
export interface VertexMaterial {
  seed: number;
  bayWidth: number;
  wallColor: number;
  roofColor: number;
  windowStyle: number;
  trimColor: number;
}

/** Façade data of one wall piece for the shader. Zero for roofs, boxes and buildings without a recipe. */
export interface WallAttr {
  doorU: number;
  doorW: number;
  doorY: number;
  groundFloorH: number;
  /** Window width, height, sill and plinth height in metres (stored with 2 cm resolution). */
  win: [number, number, number, number];
  /** FACADE_FLAG bits, misc (mullions | ground floor kind << 2 | door kind << 4), shares, masks. */
  bits: [number, number, number, number];
  /** Palette rows: frame, plinth, door, accent. */
  cols: [number, number, number, number];
}

export const NO_WALL_ATTR: WallAttr = { doorU: -1e4, doorW: 0, doorY: 0, groundFloorH: 0, win: [0, 0, 0, 0], bits: [0, 0, 0, 0], cols: [0, 0, 0, 0] };

export const BUILDING_ATTRIBS = { a_pos: 0, a_normal: 1, a_surf: 2, a_bld: 3, a_mat: 4, a_fac: 5, a_win: 6, a_bits: 7, a_col: 8 } as const;

/** Kind of surface, fourth component of the normal (low three bits). `interior` only appears in a damaged structure. */
export const KIND = { wall: 0, roofPitched: 1, roofFlat: 2, trim: 3, interior: 4, wallInside: 5 } as const;
/**
 * Vertex damage channel: the fourth component of the normal carries `kind + DAMAGE_STEP × damage`, damage 0 intact,
 * 1 cracked, 2 heavily damaged (around a breach), 3 a cut or inner face of a damaged structure, 4 rubble.
 */
export const DAMAGE_STEP = 8;

export const STRIDE = 80;

/** Vertex layout of the structure mesh (attribute locations in `BUILDING_ATTRIBS`). */
export const BUILDING_LAYOUT: VertexLayout = {
  stride: STRIDE,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i8', offset: 12 },
    { name: 'a_surf', size: 4, type: 'f32', offset: 16 },
    { name: 'a_bld', size: 4, type: 'f32', offset: 32 },
    { name: 'a_mat', size: 4, type: 'u8', integer: true, offset: 48 },
    { name: 'a_fac', size: 4, type: 'f32', offset: 52 },
    { name: 'a_win', size: 4, type: 'u8', integer: true, offset: 68 },
    { name: 'a_bits', size: 4, type: 'u8', integer: true, offset: 72 },
    { name: 'a_col', size: 4, type: 'u8', integer: true, offset: 76 },
  ],
};
/** Resolution of the window sizes packed into bytes. */
export const WIN_UNIT = 0.02;
/**
 * Scale of the window height of an arched window (bit 7 of `bits[1]`): its height is stored in steps of
 * `WIN_UNIT * WIN_TALL`, so it can reach 20.4 m.
 */
export const WIN_TALL = 4;
/** Bit of `bits[1]` that marks an arched window. */
export const ARCH_WINDOW_BIT = 128;

export class VertexWriter {
  private buf = new ArrayBuffer(1 << 21);
  private f32 = new Float32Array(this.buf);
  private i8 = new Int8Array(this.buf);
  private u8 = new Uint8Array(this.buf);
  count = 0;

  private grow(): void {
    const next = new ArrayBuffer(this.buf.byteLength * 2);
    new Uint8Array(next).set(this.u8);
    this.buf = next;
    this.f32 = new Float32Array(next);
    this.i8 = new Int8Array(next);
    this.u8 = new Uint8Array(next);
  }

  push(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    kind: number,
    s0: number,
    s1: number,
    s2: number,
    s3: number,
    b: VertexMaterial,
    floors: number,
    floorHeight: number,
    fa: WallAttr = NO_WALL_ATTR,
  ): void {
    if ((this.count + 1) * STRIDE > this.buf.byteLength) this.grow();
    const o = this.count * STRIDE;
    const f = o / 4;
    this.f32[f] = x;
    this.f32[f + 1] = y;
    this.f32[f + 2] = z;
    this.i8[o + 12] = Math.round(nx * 127);
    this.i8[o + 13] = Math.round(ny * 127);
    this.i8[o + 14] = Math.round(nz * 127);
    this.i8[o + 15] = kind;
    this.f32[f + 4] = s0;
    this.f32[f + 5] = s1;
    this.f32[f + 6] = s2;
    this.f32[f + 7] = s3;
    this.f32[f + 8] = floorHeight;
    this.f32[f + 9] = floors;
    this.f32[f + 10] = b.seed;
    this.f32[f + 11] = b.bayWidth;
    this.u8[o + 48] = b.wallColor;
    this.u8[o + 49] = b.roofColor;
    this.u8[o + 50] = b.windowStyle;
    this.u8[o + 51] = b.trimColor;
    this.f32[f + 13] = fa.doorU;
    this.f32[f + 14] = fa.doorW;
    this.f32[f + 15] = fa.doorY;
    this.f32[f + 16] = fa.groundFloorH;
    for (let k = 0; k < 4; k++) {
      const step = k === 1 && fa.bits[1]! & ARCH_WINDOW_BIT ? WIN_UNIT * WIN_TALL : WIN_UNIT;
      this.u8[o + 68 + k] = Math.max(0, Math.min(255, Math.round(fa.win[k]! / step)));
      this.u8[o + 72 + k] = fa.bits[k]!;
      this.u8[o + 76 + k] = fa.cols[k]!;
    }
    this.count++;
  }

  /**
   * Marks vertices `from`–`to` (exclusive) to grow in: from height `baseY` up to their place between clock times
   * `start` and `start + seconds` (the vertex shader reads a negative a_fac.y as the mark).
   */
  growIn(from: number, to: number, start: number, seconds: number, baseY: number): void {
    for (let i = from; i < to; i++) {
      const f = (i * STRIDE) / 4;
      this.f32[f + 13] = start;
      this.f32[f + 14] = -Math.max(1e-3, seconds);
      this.f32[f + 15] = baseY;
    }
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.count * STRIDE);
  }
}

/**
 * Writes a box: four sides and the top. The bottom is skipped unless `underside` asks for it (a band under an overhang).
 * `damage` goes into the vertex damage channel (see `KIND`), 0 for an intact box.
 */
export function pushBox(w: VertexWriter, p: PropBox, damage = 0, underside = false): void {
  const mat: VertexMaterial = { seed: unit(p.hash), bayWidth: 1, wallColor: p.color, roofColor: p.color, windowStyle: 0, trimColor: p.color };
  const vx = -p.uz;
  const vz = p.ux;
  // Corners in the same winding as footprint rings (positive orientation in the x, z plane).
  const signs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const corners = signs.map(([su, sv]): [number, number, number] => [
    p.cx + p.ux * p.halfL * su + vx * p.halfW * sv,
    p.baseY + p.slope * p.halfL * su,
    p.cz + p.uz * p.halfL * su + vz * p.halfW * sv,
  ]);
  const v = (c: [number, number, number], up: number, nx: number, ny: number, nz: number): void =>
    w.push(c[0], c[1] + up, c[2], nx, ny, nz, KIND.trim + DAMAGE_STEP * damage, 0, 0, up, 100, mat, 1, 3);
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    const nx = (b[2] - a[2]) / len;
    const nz = -(b[0] - a[0]) / len;
    v(a, 0, nx, 0, nz);
    v(b, p.height, nx, 0, nz);
    v(b, 0, nx, 0, nz);
    v(a, 0, nx, 0, nz);
    v(a, p.height, nx, 0, nz);
    v(b, p.height, nx, 0, nz);
  }
  const c0 = corners[0]!;
  const c1 = corners[1]!;
  const c2 = corners[2]!;
  const c3 = corners[3]!;
  v(c0, p.height, 0, 1, 0);
  v(c3, p.height, 0, 1, 0);
  v(c1, p.height, 0, 1, 0);
  v(c1, p.height, 0, 1, 0);
  v(c3, p.height, 0, 1, 0);
  v(c2, p.height, 0, 1, 0);
  if (underside) {
    // Bottom face, looking down: the winding of the top reversed.
    v(c0, 0, 0, -1, 0);
    v(c1, 0, 0, -1, 0);
    v(c3, 0, 0, -1, 0);
    v(c1, 0, 0, -1, 0);
    v(c2, 0, 0, -1, 0);
    v(c3, 0, 0, -1, 0);
  }
}

/** Box in front of a wall: `u0`–`u1` along the wall from point a in direction d, `d0`–`d1` out of the wall. */
export function wallBox(ax: number, az: number, dx: number, dz: number, u0: number, u1: number, d0: number, d1: number, baseY: number, height: number, color: number, hash: number): PropBox {
  const um = (u0 + u1) / 2;
  const dm = (d0 + d1) / 2;
  const nx = dz;
  const nz = -dx;
  const long = u1 - u0 >= d1 - d0;
  return {
    cx: ax + dx * um + nx * dm,
    cz: az + dz * um + nz * dm,
    baseY,
    ux: long ? dx : nx,
    uz: long ? dz : nz,
    halfL: (long ? u1 - u0 : d1 - d0) / 2,
    halfW: (long ? d1 - d0 : u1 - u0) / 2,
    height,
    slope: 0,
    color,
    hash,
  };
}

/** Do all four corners of the box, grown by `margin`, lie inside the rings? */
export function boxInside(p: { cx: number; cz: number; ux: number; uz: number; halfL: number; halfW: number }, rings: Ring[], margin: number): boolean {
  if (!pointInRings(p.cx, p.cz, rings)) return false;
  for (const [su, sv] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const x = p.cx + p.ux * (p.halfL + margin) * su - p.uz * (p.halfW + margin) * sv;
    const z = p.cz + p.uz * (p.halfL + margin) * su + p.ux * (p.halfW + margin) * sv;
    if (!pointInRings(x, z, rings)) return false;
  }
  return true;
}
