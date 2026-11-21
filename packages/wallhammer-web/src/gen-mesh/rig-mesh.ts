// Meshes of a rig: every part's shape placed in segment space, with its pivot, motion, colour slot and finish written
// into each vertex, so one draw call poses all parts in the vertex shader. Two levels of detail (the far one leaves
// out `nearOnly` parts) and a flat contact shadow quad per segment.

import type { MeshData } from '../base/data.ts';
import { RIG_BEND_AXIS, RIG_CLOCK_STEP, RIG_FINISH, RIG_MOTION, RIG_SWING_KIND, RIG_VERTEX_FLOATS, RIG_VERTEX_LAYOUT, rigClockRates } from '../base/rig.ts';
import type { RigDesc, RigPart } from '../base/rig.ts';

type V3 = readonly [number, number, number];

class Builder {
  readonly v: number[] = [];
  readonly idx: number[] = [];
  private head: number[] = [];
  private tail: number[] = [];

  /** Per-part attributes shared by every vertex of the part. */
  part(pivot: V3, motion: number, amount: number, segment: number, slot: number, color: V3, finish: number, phase: number, variant: number): void {
    this.head = [pivot[0], pivot[1], pivot[2], motion, amount, segment, slot];
    this.tail = [color[0], color[1], color[2], finish, phase, variant];
  }

  /**
   * A flat polygon (convex, counter-clockwise seen from outside). The rig's local axes (x right, y up, z forward) are
   * left-handed once placed in the world, so the triangles are written in the reverse order to come out
   * counter-clockwise there; the normal is taken from the listed order and points outward.
   */
  face(p: readonly V3[]): void {
    const [a, b, c] = p as [V3, V3, V3];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.v.length / RIG_VERTEX_FLOATS;
    for (const q of p) this.v.push(q[0], q[1], q[2], nx, ny, nz, ...this.head, ...this.tail);
    for (let i = 1; i + 1 < p.length; i++) this.idx.push(base, base + i + 1, base + i);
  }

  mesh(): MeshData {
    return { layout: RIG_VERTEX_LAYOUT, vertices: new Float32Array(this.v), indices: new Uint32Array(this.idx), count: this.idx.length };
  }
}

function box(b: Builder, c: V3, s: V3): void {
  const [x0, x1] = [c[0] - s[0] / 2, c[0] + s[0] / 2];
  const [y0, y1] = [c[1] - s[1] / 2, c[1] + s[1] / 2];
  const [z0, z1] = [c[2] - s[2] / 2, c[2] + s[2] / 2];
  b.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  b.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]);
  b.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]);
  b.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  b.face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]);
  b.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
}

function frustum(b: Builder, at: V3, r0: number, r1: number, h: number, sides: number, depth: number, cap: boolean): void {
  const ring = (r: number, y: number): V3[] =>
    Array.from({ length: sides }, (_, i) => {
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      return [at[0] + Math.cos(a) * r, at[1] + y, at[2] + Math.sin(a) * r * depth] as const;
    });
  const lo = ring(r0, 0);
  const hi = ring(r1, h);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    b.face([lo[j]!, lo[i]!, hi[i]!, hi[j]!]);
  }
  if (cap && r1 > 0) b.face([...hi].reverse());
  if (cap && r0 > 0) b.face(lo);
}

function roller(b: Builder, c: V3, r: number, w: number, sides: number): void {
  const ring = (x: number): V3[] =>
    Array.from({ length: sides }, (_, i) => {
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      return [x, c[1] + Math.cos(a) * r, c[2] + Math.sin(a) * r] as const;
    });
  const l = ring(c[0] - w / 2);
  const h = ring(c[0] + w / 2);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    b.face([l[i]!, l[j]!, h[j]!, h[i]!]);
  }
  b.face([...h]);
  b.face([...l].reverse());
}

function rod(b: Builder, at: V3, dir: V3, len: number, t: number): void {
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d: V3 = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  // Two axes across the rod.
  const up: V3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ux = d[1] * up[2] - d[2] * up[1], uy = d[2] * up[0] - d[0] * up[2], uz = d[0] * up[1] - d[1] * up[0];
  const ul = Math.hypot(ux, uy, uz);
  const u: V3 = [(ux / ul) * t / 2, (uy / ul) * t / 2, (uz / ul) * t / 2];
  const v: V3 = [(d[1] * u[2] - d[2] * u[1]), (d[2] * u[0] - d[0] * u[2]), (d[0] * u[1] - d[1] * u[0])];
  const corner = (s: number, i: number): V3 => {
    const su = i === 0 || i === 3 ? -1 : 1;
    const sv = i < 2 ? -1 : 1;
    return [at[0] + d[0] * s + u[0] * su + v[0] * sv, at[1] + d[1] * s + u[1] * su + v[1] * sv, at[2] + d[2] * s + u[2] * su + v[2] * sv];
  };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    b.face([corner(0, i), corner(0, j), corner(len, j), corner(len, i)]);
  }
  b.face([corner(len, 0), corner(len, 1), corner(len, 2), corner(len, 3)]);
}

function addPart(b: Builder, p: RigPart, rates: readonly number[]): void {
  // A link of a chain carries its axis in the kind: 7 + 0, 1 or 2; a swing about y or z has kinds of its own.
  let motion = p.motion === 'bend' ? RIG_MOTION.bend + RIG_BEND_AXIS[p.axis ?? 'y'] : p.motion === 'swing' ? RIG_SWING_KIND[p.axis ?? 'x'] : RIG_MOTION[p.motion ?? 'fixed'];
  // A part on a clock: its clock's index above the kind.
  if (p.rate !== undefined) motion += RIG_CLOCK_STEP * (rates.indexOf(p.rate) + 1);
  b.part(p.pivot ?? p.at, motion, p.amount ?? 0, p.segment ?? 0, p.slot ?? -1, p.tint ?? [1, 1, 1], RIG_FINISH[p.finish ?? 'matte'], p.phase ?? 0, p.variant ?? -1);
  const s = p.shape;
  if (s.kind === 'box') box(b, p.at, s.size);
  else if (s.kind === 'frustum') frustum(b, p.at, s.r0, s.r1, s.height, s.sides, s.depth ?? 1, s.cap ?? false);
  else if (s.kind === 'roller') roller(b, p.at, s.radius, s.width, s.sides);
  else rod(b, p.at, s.dir, s.length, s.thickness);
}

/** The rig's parts as one mesh in `RIG_VERTEX_LAYOUT`. `far` leaves out the parts marked `nearOnly`. */
export function rigMesh(desc: RigDesc, far = false): MeshData {
  const b = new Builder();
  const rates = rigClockRates(desc);
  for (const p of desc.parts) if (!far || !p.nearOnly) addPart(b, p, rates);
  return b.mesh();
}

/**
 * Contact shadow: one quad per segment in `RIG_VERTEX_LAYOUT`. Position holds the corner (±1, 0, ±1), the pivot holds
 * the half width, half length and forward offset, the motion's third value the segment.
 */
export function rigShadowMesh(desc: RigDesc): MeshData {
  const b = new Builder();
  desc.segments.forEach((s, i) => {
    b.part(s.shadow, 0, 0, i, -1, [0, 0, 0], 0, 0, -1);
    b.face([[-1, 0, 1], [1, 0, 1], [1, 0, -1], [-1, 0, -1]]);
  });
  return b.mesh();
}
