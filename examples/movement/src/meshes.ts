// Meshes of the course drawn from the collision world itself (one source of truth: what is drawn is what stops the
// walker), and the walking figure: eleven boxes posed every frame into the engine's instance set.

import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import { triangulateRing } from 'wallhammer-web/gen-mesh';
import { instanceSet, writeInstance } from 'wallhammer-web/render';
import type { InstanceSet } from 'wallhammer-web/render';
import type { CollisionWorld, SolidInfo } from 'wallhammer-web/world';
import { STATIONS } from './course.ts';
import { ANKLE_M, HEEL_M, HIP_M, SHIN_M, THIGH_M, TOE_M } from './pose.ts';
import type { FigureMotion } from './pose.ts';

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

type Rgb = readonly [number, number, number];
const COAT: Rgb = [0.86, 0.42, 0.18];
const TROUSERS: Rgb = [0.2, 0.24, 0.34];
const SKIN: Rgb = [0.92, 0.74, 0.6];
const VISOR: Rgb = [0.12, 0.12, 0.14];
const SHOES: Rgb = [0.16, 0.13, 0.11];

/** Shoulders above the hips and out to the side, metres; arm length. */
const SHOULDER_Y = 0.57;
const SHOULDER_X = 0.28;
const ARM_M = 0.62;
const HIP_X = 0.11;
/** Parts in instance order. */
const TORSO = 0, HEAD = 1, EYES = 2, ARM = 3, THIGH = 5, SHIN = 7, FOOT = 9, PART_COUNT = 11;

/**
 * The walking figure as an instance set of eleven boxes (body, head, a dark visor that shows where it looks, arms,
 * thighs, shins and feet), posed every frame from the channels of a `FigureMotion` (src/pose.ts).
 */
export class Figure {
  readonly set: InstanceSet;
  private readonly m = new Float64Array(12);
  private cy = 1;
  private sy = 0;
  private x = 0;
  private y = 0;
  private z = 0;

  constructor() {
    this.set = instanceSet(unitBox(), PART_COUNT, { name: 'figure', castShadow: true });
    this.set.count = PART_COUNT;
  }

  /** Poses every part: feet at (x, y, z), heading `yaw` (0 faces −z), the limbs from `motion`. */
  pose(x: number, y: number, z: number, yaw: number, motion: FigureMotion): void {
    this.cy = Math.cos(yaw);
    this.sy = Math.sin(yaw);
    this.x = x;
    this.y = y;
    this.z = z;
    // The upper body turns about the hips by the lean (a forward lean is a negative turn about x).
    const py = HIP_M - motion.drop;
    const up = -motion.lean;
    const cu = Math.cos(up), su = Math.sin(up);
    // A point of the upper body (relative to the hips, upright) in the figure's frame: hips + R_x(up) · (0, vy, vz).
    const uy = (vy: number, vz: number): number => py + cu * vy - su * vz;
    const uz = (vy: number, vz: number): number => su * vy + cu * vz;
    this.part(TORSO, 0, uy(0.3, 0), uz(0.3, 0), up, 0, 0.42, 0.6, 0.24, COAT);
    this.part(HEAD, 0, uy(0.72, 0), uz(0.72, 0), up, 0, 0.24, 0.26, 0.24, SKIN);
    this.part(EYES, 0, uy(0.75, -0.12), uz(0.75, -0.12), up, 0, 0.18, 0.06, 0.04, VISOR);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      // Arm: from the shoulder, swung forward against the body and spread out; its middle half its length down.
      const a = up + motion.arm[i]!;
      const b = side * motion.spread[i]!;
      const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      const h = ARM_M / 2;
      this.part(ARM + i, side * SHOULDER_X + h * sb, uy(SHOULDER_Y, 0) - h * ca * cb, uz(SHOULDER_Y, 0) - h * sa * cb, a, b, 0.11, ARM_M, 0.12, COAT);
      // Leg: thigh from the hip, shin from the knee, foot from the ankle (toes ahead, −z).
      const hx = side * HIP_X;
      const t = motion.hip[i]!;
      const s = t - motion.knee[i]!;
      const ct = Math.cos(t), st = Math.sin(t), cs = Math.cos(s), ss = Math.sin(s);
      this.part(THIGH + i, hx, py - (THIGH_M / 2) * ct, -(THIGH_M / 2) * st, t, 0, 0.15, THIGH_M + 0.03, 0.17, TROUSERS);
      const ky = py - THIGH_M * ct, kz = -THIGH_M * st;
      this.part(SHIN + i, hx, ky - (SHIN_M / 2) * cs, kz - (SHIN_M / 2) * ss, s, 0, 0.13, SHIN_M + 0.03, 0.15, TROUSERS);
      const ay = ky - SHIN_M * cs, az = kz - SHIN_M * ss;
      // The foot turns by minus its toe pitch (a turn about x lifts the toes); its middle is between toe and heel.
      const f = -motion.toe[i]!;
      const cf = Math.cos(f), sf = Math.sin(f);
      const oy = -ANKLE_M / 2, oz = -(TOE_M - HEEL_M) / 2;
      this.part(FOOT + i, hx, ay + cf * oy - sf * oz, az + sf * oy + cf * oz, f, 0, 0.13, ANKLE_M, TOE_M + HEEL_M, SHOES);
    }
    this.set.dirty = true;
  }

  /**
   * Writes one box: centre (px, py, pz) in the figure's frame (feet at the origin, facing −z, right +x), turned by
   * R_x(a) · R_z(b), sized (sx, sy, sz); then the heading R_y(yaw) and the feet's position.
   */
  private part(i: number, px: number, py: number, pz: number, a: number, b: number, sx: number, sy: number, sz: number, c: Rgb): void {
    const m = this.m;
    const cy = this.cy, sy_ = this.sy;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    // Columns of R_x(a) · R_z(b): (cb, ca sb, sa sb), (−sb, ca cb, sa cb), (0, −sa, ca); each turned by R_y and scaled.
    m[0] = (cy * cb + sy_ * sa * sb) * sx;
    m[1] = ca * sb * sx;
    m[2] = (-sy_ * cb + cy * sa * sb) * sx;
    m[3] = (-cy * sb + sy_ * sa * cb) * sy;
    m[4] = ca * cb * sy;
    m[5] = (sy_ * sb + cy * sa * cb) * sy;
    m[6] = sy_ * ca * sz;
    m[7] = -sa * sz;
    m[8] = cy * ca * sz;
    m[9] = this.x + cy * px + sy_ * pz;
    m[10] = this.y + py;
    m[11] = this.z - sy_ * px + cy * pz;
    writeInstance(this.set, i, m, c[0], c[1], c[2], 0);
  }
}

/** `mesh` (positions as 3 floats at the start of each vertex) moved by `dx`, `dz` in place; returns it. */
export function shiftedXZ(mesh: MeshData, dx: number, dz: number): MeshData {
  const v = mesh.vertices, stride = mesh.layout.stride;
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength);
  for (let o = 0; o + 12 <= v.byteLength; o += stride) {
    view.setFloat32(o, view.getFloat32(o, true) + dx, true);
    view.setFloat32(o + 8, view.getFloat32(o + 8, true) + dz, true);
  }
  return mesh;
}
