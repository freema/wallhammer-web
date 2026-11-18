// Meshes of the course drawn from the collision world itself (one source of truth: what is drawn is what stops the
// walker), and the walking figure: six boxes posed every frame into the engine's instance set.

import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import { triangulateRing } from 'wallhammer-web/gen-mesh';
import { instanceSet, writeInstance } from 'wallhammer-web/render';
import type { InstanceSet } from 'wallhammer-web/render';
import type { CollisionWorld, SolidInfo } from 'wallhammer-web/world';
import { STATIONS } from './course.ts';

/** Solids: position, normal and colour, all float. */
export const SOLID_LAYOUT: VertexLayout = {
  stride: 36,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
    { name: 'a_color', size: 3, type: 'f32', offset: 24 },
  ],
};

/** Figure parts: position and normal, float. */
export const PART_LAYOUT: VertexLayout = {
  stride: 24,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
  ],
};

const CYLINDER_SEGMENTS = 24;

/** Every solid that blocks sight, flat-shaded in its station's colour (tops a little lighter). */
export function solidsMesh(world: CollisionWorld): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], col: readonly number[]): void => {
    const base = v.length / 9;
    for (const p of [a, b, c, d]) v.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, col[0]!, col[1]!, col[2]!);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const cap = (ring: ArrayLike<number>, y: number, ny: number, col: readonly number[]): void => {
    const base = v.length / 9;
    const n = ring.length >> 1;
    for (let k = 0; k < n; k++) v.push(ring[k * 2]!, y, ring[k * 2 + 1]!, 0, ny, 0, col[0]!, col[1]!, col[2]!);
    for (const t of triangulateRing(ring)) idx.push(base + t);
  };
  world.forEachSolid((_id, info: SolidInfo) => {
    if (!info.blocksSight) return;
    const col = STATIONS[info.tag]?.color ?? [0.6, 0.6, 0.6];
    const top = [Math.min(1, col[0] * 1.15), Math.min(1, col[1] * 1.15), Math.min(1, col[2] * 1.15)];
    let ring: ArrayLike<number>;
    let smooth = false;
    if (info.kind === 'prism' && info.outline) ring = info.outline;
    else {
      const r = new Float64Array(CYLINDER_SEGMENTS * 2);
      for (let k = 0; k < CYLINDER_SEGMENTS; k++) {
        const a = (k / CYLINDER_SEGMENTS) * Math.PI * 2;
        r[k * 2] = info.x + Math.cos(a) * info.radius;
        r[k * 2 + 1] = info.z + Math.sin(a) * info.radius;
      }
      ring = r;
      smooth = true;
    }
    const n = ring.length >> 1;
    let area2 = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      area2 += ring[k * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[k * 2 + 1]!;
    }
    const out = area2 > 0 ? 1 : -1;
    const lo = info.minY;
    const hi = info.maxY;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const ax = ring[k * 2]!, az = ring[k * 2 + 1]!;
      const bx = ring[j * 2]!, bz = ring[j * 2 + 1]!;
      let nx: number, nz: number;
      if (smooth) {
        // A cylinder's side: the normal of the middle of the segment, enough for 24 segments.
        const mx = (ax + bx) / 2 - info.x, mz = (az + bz) / 2 - info.z;
        const l = Math.hypot(mx, mz) || 1;
        nx = mx / l;
        nz = mz / l;
      } else {
        const l = Math.hypot(bx - ax, bz - az) || 1;
        nx = ((bz - az) / l) * out;
        nz = (-(bx - ax) / l) * out;
      }
      quad([ax, lo, az], [bx, lo, bz], [bx, hi, bz], [ax, hi, az], [nx, 0, nz], col);
    }
    cap(ring, hi, 1, top);
    cap(ring, lo, -1, col);
  });
  return { layout: SOLID_LAYOUT, vertices: new Float32Array(v), indices: new Uint32Array(idx), count: idx.length };
}

/** A unit box centred on the origin, flat normals. */
function unitBox(): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, w] of faces) {
    const base = v.length / 6;
    for (const [su, sw] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      v.push((n[0]! + u[0]! * su + w[0]! * sw) * 0.5, (n[1]! + u[1]! * su + w[1]! * sw) * 0.5, (n[2]! + u[2]! * su + w[2]! * sw) * 0.5, n[0]!, n[1]!, n[2]!);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { layout: PART_LAYOUT, vertices: new Float32Array(v), indices: new Uint32Array(idx), count: idx.length };
}

/**
 * One part of the figure in its own frame (feet at the origin, facing −z, right +x): the joint it swings about, the
 * box's centre relative to the joint, the box's size, its colour, and which swing it follows (0 none, ±1 legs,
 * ±2 arms; the sign is the side, so the two sides swing against each other).
 */
interface Part {
  joint: [number, number, number];
  offset: [number, number, number];
  size: [number, number, number];
  color: [number, number, number];
  swing: number;
}

const COAT: [number, number, number] = [0.86, 0.42, 0.18];
const TROUSERS: [number, number, number] = [0.2, 0.24, 0.34];
const SKIN: [number, number, number] = [0.92, 0.74, 0.6];
const PARTS: readonly Part[] = [
  { joint: [0, 1.15, 0], offset: [0, 0, 0], size: [0.42, 0.6, 0.24], color: COAT, swing: 0 },
  { joint: [0, 1.57, 0], offset: [0, 0, 0], size: [0.24, 0.26, 0.24], color: SKIN, swing: 0 },
  // A dark visor on the face shows where the figure looks.
  { joint: [0, 1.6, -0.12], offset: [0, 0, 0], size: [0.18, 0.06, 0.04], color: [0.12, 0.12, 0.14], swing: 0 },
  { joint: [-0.11, 0.85, 0], offset: [0, -0.425, 0], size: [0.15, 0.85, 0.17], color: TROUSERS, swing: 1 },
  { joint: [0.11, 0.85, 0], offset: [0, -0.425, 0], size: [0.15, 0.85, 0.17], color: TROUSERS, swing: -1 },
  { joint: [-0.28, 1.42, 0], offset: [0, -0.31, 0], size: [0.11, 0.62, 0.12], color: COAT, swing: -2 },
  { joint: [0.28, 1.42, 0], offset: [0, -0.31, 0], size: [0.11, 0.62, 0.12], color: COAT, swing: 2 },
];

/** Metres walked per full stride cycle (left and right step). */
const STRIDE_M = 1.5;

/**
 * The walking figure as an instance set: legs and arms swing by the distance walked, the swing grows with the speed,
 * and in the air the legs hold a stride.
 */
export class Figure {
  readonly set: InstanceSet;
  private readonly m = new Float64Array(12);

  constructor() {
    this.set = instanceSet(unitBox(), PARTS.length, { name: 'figure', castShadow: true });
    this.set.count = PARTS.length;
  }

  /**
   * Poses every part: feet at (x, y, z), heading `yaw` (0 faces −z), `travelled` metres walked, horizontal `speed`,
   * `grounded`.
   */
  pose(x: number, y: number, z: number, yaw: number, travelled: number, speed: number, grounded: boolean): void {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const phase = (travelled / STRIDE_M) * Math.PI * 2;
    const amp = grounded ? 0.55 * Math.min(1, speed / 2.2) : 0;
    const m = this.m;
    for (let i = 0; i < PARTS.length; i++) {
      const p = PARTS[i]!;
      let phi = 0;
      if (p.swing !== 0) {
        const side = p.swing > 0 ? 1 : -1;
        const arms = Math.abs(p.swing) === 2;
        phi = grounded ? side * amp * Math.sin(phase) * (arms ? 0.8 : 1) : side * (arms ? -0.5 : 0.35);
      }
      const cp = Math.cos(phi), sp = Math.sin(phi);
      // Linear part: R_y(yaw) · R_x(phi) · scale, column by column.
      const [sx, syz, sz] = p.size;
      m[0] = cy * sx;
      m[1] = 0;
      m[2] = -sy * sx;
      m[3] = sy * sp * syz;
      m[4] = cp * syz;
      m[5] = cy * sp * syz;
      m[6] = sy * cp * sz;
      m[7] = -sp * sz;
      m[8] = cy * cp * sz;
      // Translation: feet + R_y · (joint + R_x · offset).
      const o = p.offset;
      const qx = p.joint[0] + o[0];
      const qy = p.joint[1] + cp * o[1] - sp * o[2];
      const qz = p.joint[2] + sp * o[1] + cp * o[2];
      m[9] = x + cy * qx + sy * qz;
      m[10] = y + qy;
      m[11] = z - sy * qx + cy * qz;
      writeInstance(this.set, i, m, p.color[0], p.color[1], p.color[2], 0);
    }
    this.set.dirty = true;
  }
}
