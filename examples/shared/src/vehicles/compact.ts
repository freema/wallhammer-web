// A compact hatchback built from code in the chunky, flat-shaded style of the figures (the same `FigureMesh` builder
// and vertex layout): a body shell lofted from cross-sections along its length, with wheel arches cut into its sides,
// a bonnet and a short boot deck that ride up into a cabin of pillars and dark glass, bumpers, head, tail and reversing
// lamps, mirrors, door seams and a door handle; a simple interior (seats, dashboard, steering wheel) seen when a door
// is open. The two front doors are one mesh of their own (the left door; the right one is the same mesh mirrored), so
// a page can swing them about their hinges; the wheel is a mesh of its own too (tyre, rim with five spokes and a hub),
// drawn once per wheel.
//
// Frame: the frame of a rigid body on wheel rays: origin at the centre of mass, +x to the right, +y up, −z forward,
// metres. The shapes are written over the ground (y = 0 under the wheels at rest) and moved down by the body's rest
// height, so the wheels drawn at their rest places touch the ground and sit in their arches. The vertex colour's fourth
// number is a material of `CAR_MAT`: a page's car material tints the paint per car, lets the glass reflect the sky and
// lights the lamps from a per-car number (braking, reversing).

import type { MeshData } from 'wallhammer-web/base';
import { FigureMesh, rgb } from '../figures/mesh.ts';
import type { P, RGB } from '../figures/mesh.ts';

/** Materials of the car's vertices (`a_color.w`). */
export const CAR_MAT = { flat: 0, paint: 1, glass: 2, headLamp: 3, tailLamp: 4, reverseLamp: 5 } as const;

/**
 * Measures of the compact car, metres, over the ground at rest (x to the right, −z forward), and the body the meshes
 * are drawn round: a page builds its rigid body on wheel rays from these (the hull box, the mass, the wheels' places).
 */
export const COMPACT_CAR = {
  /** Half the width, height and length of the hull box (the body's nose and tail at ±halfLength). */
  halfWidth: 0.9,
  halfHeight: 0.6,
  halfLength: 2.1,
  /** Mass, kg. */
  mass: 1200,
  /** Wheel centres: z of the front and rear axles and half the track. */
  frontAxleZ: -1.3,
  rearAxleZ: 1.3,
  halfTrack: 0.78,
  wheelRadius: 0.33,
  /** Half width of a tyre, m. */
  tyreHalfWidth: 0.1,
  /** Radius of the wheel arches about the wheel centres at rest. */
  archRadius: 0.43,
  /** Height of the roof's middle over the ground. */
  roof: 1.45,
  /** The driver's door (the left one): its hinge (x, z) at its front edge, its rear edge, how far it opens. */
  door: { hingeX: -0.87, hingeZ: -0.84, rearZ: 0.42, openDeg: 62 },
  /** Top of the driver's seat cushion (x, y over the ground, z). */
  seat: [-0.38, 0.47, 0.2] as P,
  /** Where a figure stands to get in at the driver's door (x, z). */
  doorSpot: [-1.42, 0.02] as const,
} as const;

/** The meshes of one car: the body, the left front door (mirror it for the right) and one wheel. */
export interface CompactCarMeshes {
  body: MeshData;
  door: MeshData;
  wheel: MeshData;
}

const PAINT: RGB = [0.92, 0.92, 0.92];
const GLASS: RGB = [0.1, 0.13, 0.16];
const TRIM = rgb('#2b2c30');
const UNDER = rgb('#1c1c1f');
const SEAM = rgb('#141416');
const SEAT = rgb('#3a3632');
const DASH = rgb('#242426');
const HEAD: RGB = [0.95, 0.93, 0.82];
const TAIL: RGB = [0.72, 0.06, 0.05];
const REVERSE: RGB = [0.86, 0.86, 0.82];
const TYRE = rgb('#19191b');
const TREAD = rgb('#222225');
const RIM = rgb('#b9bcc2');
const RIM_DARK = rgb('#55585e');
const HUB_HOLE = rgb('#0e0e10');

const C = COMPACT_CAR;
/** Ground clearance of the sills. */
const SILL = 0.3;
/** Base of the windscreen and of the rear window along the length. */
const WINDSCREEN_Z = -0.92;
const REAR_WINDOW_Z = 1.62;
const NOSE_Z = -C.halfLength;
const TAIL_Z = C.halfLength;

/** Height of the bottom edge of the side at z: the sill, or the arch over a wheel. */
function bottomAt(z: number): number {
  for (const zc of [C.frontAxleZ, C.rearAxleZ]) {
    const d = z - zc;
    if (Math.abs(d) < C.archRadius) return Math.max(SILL, C.wheelRadius + Math.sqrt(C.archRadius * C.archRadius - d * d));
  }
  return SILL;
}

/** Height of the shoulder (where the side turns into the bonnet, the belt under the glass, the boot deck) at z. */
function shoulderAt(z: number): number {
  if (z <= NOSE_Z + 1e-6) return 0.74;
  if (z <= WINDSCREEN_Z) return 0.84 + ((z + 2.03) / (WINDSCREEN_Z + 2.03)) * 0.13;
  if (z <= REAR_WINDOW_Z) return 0.97 + ((z - WINDSCREEN_Z) / (REAR_WINDOW_Z - WINDSCREEN_Z)) * 0.03;
  if (z < TAIL_Z - 1e-6) return 1.0 - ((z - REAR_WINDOW_Z) / (2.04 - REAR_WINDOW_Z)) * 0.05;
  return 0.86;
}

interface Station {
  z: number;
  /** Half widths of the bottom, crease, shoulder and crown points. */
  w: readonly [number, number, number, number];
  /** Heights of the same points. */
  y: readonly [number, number, number, number];
}

/** One cross-section of the lower body. */
function station(z: number): Station {
  const end = z <= NOSE_Z + 1e-6 || z >= TAIL_Z - 1e-6;
  const nearEnd = Math.abs(Math.abs(z) - 2.03) < 0.02;
  const yb = bottomAt(z);
  const ys = shoulderAt(z);
  const flat = Math.abs(z - WINDSCREEN_Z) < 1e-6 || Math.abs(z - REAR_WINDOW_Z) < 1e-6 || end;
  const yk = ys + (flat ? 0 : 0.035);
  const yc = end ? 0.55 : Math.max(ys - 0.24, yb + 0.05);
  const w: Station['w'] = end ? [0.76, 0.8, 0.7, 0.34] : nearEnd ? [0.83, 0.88, 0.8, 0.39] : [0.85, 0.9, 0.83, 0.4];
  return { z, w, y: [yb, yc, ys, yk] };
}

/** The eight points of a section, around from the bottom left: bottom, crease, shoulder, crown, then the right side back down. */
function sectionRing(s: Station): P[] {
  const [wb, wc, ws, wk] = s.w;
  const [yb, yc, ys, yk] = s.y;
  return [
    [-wb, yb, s.z], [-wc, yc, s.z], [-ws, ys, s.z], [-wk, yk, s.z],
    [wk, yk, s.z], [ws, ys, s.z], [wc, yc, s.z], [wb, yb, s.z],
  ];
}

/** The z of the sections: the ends, the arches in steps of 30°, the door edges and the bases of the glass. */
function stationZs(): number[] {
  const fixed = [NOSE_Z, -2.03, WINDSCREEN_Z, C.door.hingeZ, -0.2, C.door.rearZ, REAR_WINDOW_Z, 2.03, TAIL_Z];
  const zs = [...fixed];
  for (const zc of [C.frontAxleZ, C.rearAxleZ]) {
    for (let k = 0; k <= 6; k++) zs.push(zc - C.archRadius * Math.cos((k * Math.PI) / 6));
  }
  zs.sort((a, b) => a - b);
  // Arch samples too close to a fixed station give way to it.
  const out: number[] = [];
  for (const z of zs) {
    const fix = fixed.some((f) => Math.abs(f - z) < 1e-9);
    const prev = out[out.length - 1];
    if (prev !== undefined && z - prev < 0.05) {
      if (fix && !fixed.some((f) => Math.abs(f - prev) < 1e-9)) out[out.length - 1] = z;
      continue;
    }
    out.push(z);
  }
  return out;
}

/**
 * A pane of glass in a frame of paint: the corners in order, the frame `inset` wide; the glass sits a little inside.
 * `away` is a point inside the car.
 */
function framedPane(m: FigureMesh, c: readonly P[], inset: number, away: P): void {
  const n = c.length;
  let cx = 0, cy = 0, cz = 0;
  for (const p of c) (cx += p[0]), (cy += p[1]), (cz += p[2]);
  cx /= n;
  cy /= n;
  cz /= n;
  // Toward the inside of the car, for the glass's small step back.
  const ix = away[0] - cx, iy = away[1] - cy, iz = away[2] - cz;
  const il = Math.hypot(ix, iy, iz) || 1;
  const inner = c.map((p): P => {
    const dx = cx - p[0], dy = cy - p[1], dz = cz - p[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    const k = Math.min(0.45, (inset * 1.35) / l);
    return [p[0] + dx * k + (ix / il) * 0.012, p[1] + dy * k + (iy / il) * 0.012, p[2] + dz * k + (iz / il) * 0.012];
  });
  m.paint(PAINT, 1, 0.05);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m.quad(c[i]!, c[j]!, inner[j]!, inner[i]!, away);
  }
  m.paint(GLASS, 2, 0.02);
  for (let k = 1; k + 1 < n; k++) m.tri(inner[0]!, inner[k]!, inner[k + 1]!, away);
}

/** A flat rectangle on a plane of constant z (a lamp, a grille): x from x0 to x1, y from y0 to y1, facing away from `away`. */
function plateZ(m: FigureMesh, x0: number, x1: number, y0: number, y1: number, z: number, away: P): void {
  m.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], away);
}

/** The left front door: the lower side between its edges, its window in a frame, seams and a handle. */
function buildDoor(m: FigureMesh, rings: readonly P[][], zs: readonly number[]): void {
  const inside: P = [0, 0.75, -0.2];
  for (let r = 0; r + 1 < rings.length; r++) {
    const z0 = zs[r]!, z1 = zs[r + 1]!;
    if (z0 < C.door.hingeZ - 1e-6 || z1 > C.door.rearZ + 1e-6) continue;
    const A = rings[r]!, B = rings[r + 1]!;
    m.paint(PAINT, 1, 0.05);
    for (const k of [0, 1]) m.quad(A[k]!, B[k]!, B[k + 1]!, A[k + 1]!, [0, 0.75, (z0 + z1) / 2]);
  }
  // The window: from the belt at the door's front edge up the windscreen pillar, along the roof, down the middle pillar.
  const g = greenhouse(-1);
  framedPane(m, [g.db0, g.bb, g.bt, g.at], 0.055, inside);
  // Seams along the front and rear edges, just outside the panel, and a handle near the rear edge.
  const ring = (z: number): P[] => sectionRing(station(z));
  m.paint(SEAM, 0, 0.02);
  for (const [z, dz] of [[C.door.hingeZ, 0.014], [C.door.rearZ, -0.014]] as const) {
    const R = ring(z);
    for (const k of [0, 1]) {
      const a = R[k]!, b = R[k + 1]!;
      m.quad([a[0] - 0.004, a[1], a[2]], [b[0] - 0.004, b[1], b[2]], [b[0] - 0.004, b[1], b[2] + dz], [a[0] - 0.004, a[1], a[2] + dz], inside);
    }
  }
  m.paint(TRIM, 0, 0.04);
  const hy = 0.86, hz = 0.24;
  const hx = -sectionAtX(hz, hy) - 0.004;
  m.box([hx - 0.012, hy, hz], [0.03, 0.035, 0.15]);
}

/** Half width of the lower body's side at z and height y (between its crease and shoulder points, or below the crease). */
function sectionAtX(z: number, y: number): number {
  const s = station(z);
  const [, wc, ws] = s.w;
  const [, yc, ys] = s.y;
  if (y <= yc) return wc;
  const t = Math.min(1, (y - yc) / Math.max(1e-6, ys - yc));
  return wc + (ws - wc) * t;
}

/** Corners of the cabin on one side (`s` = −1 left, 1 right). */
function greenhouse(s: number): { ab: P; db0: P; bb: P; cb: P; at: P; bt: P; ct: P } {
  const belt = (z: number): number => shoulderAt(z);
  return {
    ab: [0.83 * s, belt(WINDSCREEN_Z), WINDSCREEN_Z],
    db0: [0.83 * s, belt(C.door.hingeZ), C.door.hingeZ],
    bb: [0.83 * s, belt(C.door.rearZ), C.door.rearZ],
    cb: [0.83 * s, belt(REAR_WINDOW_Z), REAR_WINDOW_Z],
    at: [0.66 * s, C.roof - 0.04, -0.2],
    bt: [0.67 * s, C.roof - 0.025, C.door.rearZ],
    ct: [0.66 * s, C.roof - 0.035, 1.04],
  };
}

/** The wheel: a tyre round the axle (x) with its outer face at +x, a rim of five spokes, a hub; centred on the wheel. */
function buildWheel(m: FigureMesh, R: number, w: number): void {
  const N = 16;
  const ringX = (x: number, r: number, turn = 0): P[] => {
    const out: P[] = [];
    for (let k = 0; k < N; k++) {
      const a = ((k + turn) / N) * Math.PI * 2;
      out.push([x, Math.cos(a) * r, Math.sin(a) * r]);
    }
    return out;
  };
  const band = (A: readonly P[], B: readonly P[], away: (k: number) => P): void => {
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      m.quad(A[k]!, B[k]!, B[k1]!, A[k1]!, away(k));
    }
  };
  const axis = (x: number) => (): P => [x, 0, 0];
  /** Away from the axle: the inner face of the rim's barrel, seen from the hub's side. */
  const outward = (x: number) => (k: number): P => {
    const a = ((k + 0.5) / N) * Math.PI * 2;
    return [x, Math.cos(a) * 3 * R, Math.sin(a) * 3 * R];
  };
  // Tyre: inner sidewall, shoulders and tread, outer sidewall up to the rim's lip.
  const inSide = ringX(-w, 0.6 * R), inShoulder = ringX(-w, 0.9 * R), inTread = ringX(-0.72 * w, R);
  const outTread = ringX(0.72 * w, R), outShoulder = ringX(w, 0.9 * R), lip = ringX(w, 0.66 * R);
  m.paint(TYRE, 0, 0.06);
  band(inSide, inShoulder, axis(2));
  band(inShoulder, inTread, axis(0));
  m.paint(TREAD, 0, 0.12);
  band(inTread, outTread, axis(0));
  m.paint(TYRE, 0, 0.06);
  band(outTread, outShoulder, axis(0));
  band(outShoulder, lip, axis(-2));
  // Rim: the barrel from the lip in to the dish, then the dark dish the spokes stand in front of.
  const barrel = ringX(0.35 * w, 0.62 * R);
  m.paint(RIM, 0, 0.05);
  band(lip, barrel, outward(0.6 * w));
  m.paint(RIM_DARK, 0, 0.03);
  for (let k = 0; k < N; k++) m.tri(barrel[k]!, barrel[(k + 1) % N]!, [0.35 * w, 0, 0], [-1, 0, 0]);
  // The inner side of the wheel, closed.
  m.paint(TYRE, 0, 0.03);
  for (let k = 0; k < N; k++) m.tri(inSide[k]!, inSide[(k + 1) % N]!, [-w, 0, 0], [1, 0, 0]);
  // Five spokes from the hub to the barrel, standing out of the dish.
  m.paint(RIM, 0, 0.08);
  const front = 0.78 * w, back = 0.38 * w;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const dy = Math.cos(a), dz = Math.sin(a), ty = -dz, tz = dy;
    const r0 = 0.16 * R, r1 = 0.6 * R, h0 = 0.085 * R, h1 = 0.055 * R;
    const p = (r: number, h: number, x: number): P => [x, dy * r + ty * h, dz * r + tz * h];
    const f = [p(r0, -h0, front), p(r1, -h1, front - 0.01), p(r1, h1, front - 0.01), p(r0, h0, front)];
    const b = [p(r0, -h0, back), p(r1, -h1, back), p(r1, h1, back), p(r0, h0, back)];
    const mid: P = [(front + back) / 2, dy * (r0 + r1) / 2, dz * (r0 + r1) / 2];
    m.quad(f[0]!, f[1]!, f[2]!, f[3]!, mid);
    m.quad(b[0]!, b[1]!, f[1]!, f[0]!, mid);
    m.quad(b[3]!, f[3]!, f[2]!, b[2]!, mid);
  }
  // Hub: a short cap over the spokes with a dark ring of nuts' shadow round it.
  const hub0 = ringX(0.5 * w, 0.17 * R, 0.5), hub1 = ringX(0.95 * w, 0.14 * R, 0.5);
  m.paint(RIM, 0, 0.04);
  for (let k = 0; k < N; k++) m.quad(hub0[k]!, hub1[k]!, hub1[(k + 1) % N]!, hub0[(k + 1) % N]!, [0.7 * w, 0, 0]);
  m.paint(RIM_DARK, 0, 0.03);
  for (let k = 0; k < N; k++) m.tri(hub1[k]!, hub1[(k + 1) % N]!, [0.95 * w, 0, 0], [0, 0, 0]);
  m.paint(HUB_HOLE, 0, 0);
  const nut = ringX(0.951 * w, 0.05 * R, 0.5);
  for (let k = 0; k < N; k++) m.tri(nut[k]!, nut[(k + 1) % N]!, [0.951 * w, 0, 0], [0, 0, 0]);
}

/**
 * The meshes of the compact car for a body whose centre of mass rests `restHeight` over flat ground (`WheeledBody`'s
 * `restHeight`); `seed` varies the facets' brightness.
 */
export function compactCarMeshes(restHeight: number, seed = 5): CompactCarMeshes {
  const body = new FigureMesh(seed * 7 + 1);
  const door = new FigureMesh(seed * 7 + 2);
  const wheel = new FigureMesh(seed * 7 + 3);
  // Shapes are written over the ground; the origin moves them to the centre of mass.
  const o: P = [0, restHeight, 0];
  body.origin(o);
  door.origin(o);

  const zs = stationZs();
  const rings = zs.map((z) => sectionRing(station(z)));
  const inDoor = (z0: number, z1: number): boolean => z0 >= C.door.hingeZ - 1e-6 && z1 <= C.door.rearZ + 1e-6;
  const inCabin = (z0: number, z1: number): boolean => z0 >= WINDSCREEN_Z - 1e-6 && z1 <= REAR_WINDOW_Z + 1e-6;

  // Lower body: the sections lofted; the doors' panels and the top inside the cabin are left out.
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r]!, B = rings[r + 1]!;
    const z0 = zs[r]!, z1 = zs[r + 1]!;
    const away: P = [0, 0.7, (z0 + z1) / 2];
    for (let k = 0; k < 8; k++) {
      const k1 = (k + 1) % 8;
      if (inDoor(z0, z1) && (k <= 1 || k === 5 || k === 6)) continue;
      if (inCabin(z0, z1) && k >= 2 && k <= 4) continue;
      if (k === 7) body.paint(UNDER, 0, 0.02);
      else body.paint(PAINT, 1, 0.05);
      body.quad(A[k]!, B[k]!, B[k1]!, A[k1]!, away);
    }
  }
  // The nose and the tail: flat faces.
  for (const [R, next] of [[rings[0]!, rings[1]!], [rings[rings.length - 1]!, rings[rings.length - 2]!]] as const) {
    const zc = R[0]![2];
    const centre: P = [0, 0.55, zc];
    const into: P = [0, 0.55, next[0]![2]];
    body.paint(PAINT, 1, 0.05);
    for (let k = 0; k < 8; k++) body.tri(R[k]!, R[(k + 1) % 8]!, centre, into);
  }

  // The cabin: windscreen, rear window, roof, the pillars and the side windows behind the doors.
  const inside: P = [0, 0.8, 0.3];
  const L = greenhouse(-1), Rg = greenhouse(1);
  framedPane(body, [L.ab, Rg.ab, Rg.at, L.at], 0.06, inside);
  framedPane(body, [Rg.cb, L.cb, L.ct, Rg.ct], 0.06, inside);
  const ridge = (p: P, lift: number): P => [0, p[1] + lift, p[2]];
  body.paint(PAINT, 1, 0.05);
  for (const g of [L, Rg]) {
    body.quad(ridge(g.at, 0), g.at, g.bt, ridge(g.bt, 0.03), inside);
    body.quad(ridge(g.bt, 0.03), g.bt, g.ct, ridge(g.ct, 0), inside);
    // The windscreen pillar in front of the door, and the rear quarter window behind it.
    body.tri(g.ab, g.db0, g.at, inside);
    framedPane(body, [g.bb, g.cb, g.ct, g.bt], 0.06, inside);
  }

  // Wheel arch liners on the inner side of each wheel, so the arches are dark wells.
  body.paint(UNDER, 0, 0.02);
  for (const zc of [C.frontAxleZ, C.rearAxleZ]) {
    for (const s of [-1, 1]) {
      const x = s * (C.halfTrack - C.tyreHalfWidth - 0.04);
      const pts: P[] = [];
      for (let k = 0; k <= 8; k++) {
        const a = (k / 8) * Math.PI;
        pts.push([x, C.wheelRadius + Math.sin(a) * (C.archRadius + 0.02), zc - Math.cos(a) * (C.archRadius + 0.02)]);
      }
      const c: P = [x, C.wheelRadius * 0.8, zc];
      for (let k = 0; k < 8; k++) body.tri(pts[k]!, pts[k + 1]!, c, [x - s, 0.5, zc]);
    }
  }

  // Bumpers: chunky dark blocks across the ends.
  body.paint(TRIM, 0, 0.06);
  body.box([0, 0.4, NOSE_Z + 0.01], [1.72, 0.22, 0.17], 0.96);
  body.box([0, 0.41, TAIL_Z - 0.01], [1.72, 0.24, 0.17], 0.96);
  // The front: a dark grille between the lamps, the headlamps; the back: tail and reversing lamps.
  const front: P = [0, 0.6, 0];
  body.paint(UNDER, 0, 0.04);
  plateZ(body, -0.34, 0.34, 0.53, 0.66, NOSE_Z - 0.004, front);
  body.paint(TRIM, 0, 0.02);
  plateZ(body, -0.36, 0.36, 0.585, 0.605, NOSE_Z - 0.006, front);
  body.paint(HEAD, 3, 0.02);
  for (const s of [-1, 1]) plateZ(body, s * 0.42, s * 0.68, 0.59, 0.69, NOSE_Z - 0.004, front);
  body.paint(TAIL, 4, 0.03);
  for (const s of [-1, 1]) plateZ(body, s * 0.5, s * 0.7, 0.71, 0.83, TAIL_Z + 0.004, front);
  body.paint(REVERSE, 5, 0.02);
  for (const s of [-1, 1]) plateZ(body, s * 0.38, s * 0.5, 0.71, 0.83, TAIL_Z + 0.004, front);
  // Mirrors on the windscreen pillars' feet.
  body.paint(PAINT, 1, 0.05);
  for (const s of [-1, 1]) body.box([s * 0.95, 1.03, -0.78], [0.13, 0.1, 0.1], 0.85);
  body.paint(UNDER, 0, 0.02);
  for (const s of [-1, 1]) body.box([s * 0.96, 1.03, -0.725], [0.1, 0.07, 0.006]);

  // The interior: seats, a bench, the dashboard and the steering wheel on the left.
  body.paint(SEAT, 0, 0.08);
  for (const s of [-1, 1]) {
    body.box([s * 0.38, C.seat[1] - 0.06, 0.22], [0.46, 0.12, 0.5]);
    body.box([s * 0.38, C.seat[1] + 0.32, 0.5], [0.46, 0.62, 0.12], 0.85);
  }
  body.box([0, C.seat[1] - 0.06, 1.0], [1.3, 0.12, 0.45]);
  body.box([0, C.seat[1] + 0.28, 1.27], [1.3, 0.55, 0.12]);
  body.paint(DASH, 0, 0.06);
  body.box([0, 0.86, -0.72], [1.56, 0.16, 0.36]);
  const sw: P = [-0.38, 0.97, -0.5];
  const u: P = [1, 0, 0], v: P = [0, 0.89, -0.45];
  for (let k = 0; k < 10; k++) {
    const a0 = (k / 10) * Math.PI * 2, a1 = ((k + 1) / 10) * Math.PI * 2;
    const q = (a: number): P => [sw[0] + u[0] * Math.cos(a) * 0.17 + v[0] * Math.sin(a) * 0.17, sw[1] + u[1] * Math.cos(a) * 0.17 + v[1] * Math.sin(a) * 0.17, sw[2] + u[2] * Math.cos(a) * 0.17 + v[2] * Math.sin(a) * 0.17];
    body.limb(q(a0), q(a1), 0.02, 0.02, 4);
  }
  body.limb(sw, [-0.38, 0.86, -0.66], 0.03, 0.035, 4);

  buildDoor(door, rings, zs);
  buildWheel(wheel, C.wheelRadius, C.tyreHalfWidth);
  return { body: body.mesh(), door: door.mesh(), wheel: wheel.mesh() };
}

/**
 * The door's hinge turn for an opening of `open` (0 shut, 1 open), as a 3 × 4 matrix in the body's frame (the left
 * door; mirror x for the right one): about the vertical line through the hinge, the rear edge swinging out.
 */
export function doorHinge(open: number, out: Float64Array): Float64Array {
  const t = Math.min(1, Math.max(0, open));
  const a = -(t * t * (3 - 2 * t)) * C.door.openDeg * (Math.PI / 180);
  const c = Math.cos(a), s = Math.sin(a);
  // R_y(a) columns: (c, 0, −s), (0, 1, 0), (s, 0, c); the hinge stays where it is.
  out[0] = c;
  out[1] = 0;
  out[2] = -s;
  out[3] = 0;
  out[4] = 1;
  out[5] = 0;
  out[6] = s;
  out[7] = 0;
  out[8] = c;
  const hx = C.door.hingeX, hz = C.door.hingeZ;
  out[9] = hx - (c * hx + s * hz);
  out[10] = 0;
  out[11] = hz - (-s * hx + c * hz);
  return out;
}
