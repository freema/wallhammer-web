// Falling parts of a structure: turns the parts an event took away into pieces that move on closed-form tracks
// (core/ballistic.ts) and tells when each part's rubble should grow in. Presentation only: the destruction state is
// already final when this runs, and nothing here is saved or read back.
//
// A piece is the part's own geometry, cut out of the structure drawn part by part in the state it had before the
// event (`buildBuildingMesh(..., { byParts: true, states })`): its façade with windows, its roof covering, its damage
// rung, byte for byte. Every triangle goes to the part whose solid holds a point just behind its face. Solid parts
// (masonry, floors, partitions) whose faces cover their outline also get a closed shell slightly inside it, drawn only
// once the piece moves, so a piece seen from behind or from a side is a solid with broken edges. Until its time in the event's
// timeline a piece stands exactly where it stood, so nothing changes when the event happens except the parts that
// go at once.
//
// Blown parts (hit by the event) are pushed out from the event centre and up, spinning. Parts that lost their
// support let go at their timeline time, drift toward the side their rubble falls to and tilt. A part wider than
// `SPLIT_M` is cut along a grid into pieces with slightly different tracks. A piece lands on the highest surviving
// part under its centre or on the ground, crumbles into it and its rubble grows in there.
//
// Budget: at most `budget` pieces fly. The rest stand until their time and then go up as dust: hidden pieces (inside
// the outline, or with nothing drawn) first, then those with the least drawn surface.

import { DAMAGE, PART_FLAG, entryDir } from '../../base/index.ts';
import type { MeshData, StructureDesc, StructurePart, StructureState, VertexLayout } from '../../base/index.ts';
import { TRACK_FLOATS, trackAttribs, trackFlightTime, trackLifetime, writeTrack } from '../../core/index.ts';
import type { BallisticTrack, DustPuff } from '../../core/index.ts';
import { hashInts, unit } from '../../gen-core/index.ts';
import { STRUCTURE_MATERIAL } from './damaged.ts';
import { FINISH } from '../interior/interior.ts';
import { ROOM_TYPE } from '../interior/interior-plan.ts';
import { BUILDING_ATTRIBS, BUILDING_LAYOUT, DAMAGE_STEP, KIND, VertexWriter, WIN_UNIT } from '../structure/writer.ts';
import type { WallAttr } from '../structure/writer.ts';

/** One change of the event as the mapping needs it: the part, whether the event hit it, when it lets go. */
export interface FallChange {
  part: number;
  /** True for a part the event itself destroyed (blown), false for one that lost its support. */
  hit: boolean;
  /** Seconds after the event at which it lets go. */
  delay: number;
  /** The event that took it, when several events at one clock time are presented together (else `FallInput.event`). */
  event?: FallEvent;
}

/** Event centre (metres), radius (metres), energy and seed. */
export interface FallEvent {
  x: number;
  y: number;
  z: number;
  radius: number;
  energy: number;
  seed: number;
}

export interface FallInput {
  desc: StructureDesc;
  /** State after the event (final). */
  state: StructureState;
  /** The structure drawn part by part in its state before the event (BUILDING_LAYOUT, no indices). */
  before: MeshData;
  /** Gone parts of the event. */
  changes: readonly FallChange[];
  event: FallEvent;
  /** Clock time of the event (seconds). */
  at: number;
  groundAt: (x: number, z: number) => number;
  /** Pieces that may still fly; the rest go to dust. */
  budget: number;
}

export interface FallOutput {
  /** Vertices of all pieces with their tracks (`FALL_LAYOUT`), for `fallingMaterial`. */
  mesh: MeshData;
  pieces: number;
  /** Pieces over the budget, shown only as dust. */
  dust: number;
  puffs: DustPuff[];
  /** Per part key: clock time its rubble starts to grow in and over how long. */
  arrivals: Map<number, { start: number; seconds: number }>;
  /** Clock span in which something moves or grows. */
  start: number;
  end: number;
  /** Tracks in piece order (flying pieces first), for tests. */
  tracks: BallisticTrack[];
}

const SRC = BUILDING_LAYOUT.stride;
const STRIDE = SRC + TRACK_FLOATS * 4;
/** Vertex layout of falling pieces: the structure vertex, then the track. */
export const FALL_LAYOUT: VertexLayout = { stride: STRIDE, attribs: [...BUILDING_LAYOUT.attribs, ...trackAttribs(SRC)] };
export const FALL_ATTRIBS = { ...BUILDING_ATTRIBS, a_track0: 9, a_track1: 10, a_track2: 11, a_track3: 12 } as const;

/** Eight fall directions of the damage entries (x, z), as in sim/destruction's octants. */
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.7071, 0.7071],
  [0, 1],
  [-0.7071, 0.7071],
  [-1, 0],
  [-0.7071, -0.7071],
  [0, -1],
  [0.7071, -0.7071],
];
/** Rubble grows in over this long, starting when its piece lands. */
const GROW_S = 0.7;
/** Horizontal speed (m/s, times 0.5–1.5) with which a piece that lost its support leans away from the structure. */
const LEAN_MS = 0.7;
/** Pieces that lose support let go spread over this long (s), so neighbours do not move as one sheet. */
const STAGGER_S = 0.14;
/** A piece counts as inside a standing part from this far below that part's top (m). */
const BLOCK_M = 0.2;
/** Shares of the horizontal velocity tried when a piece would land in or fly through a standing part. */
const CLEAR_SCALES = [1, 0.6, 0.3, -0.4, 0] as const;
/** Parts wider than this are cut into pieces of about `SPLIT_M` (single surfaces such as roof sections: `SPLIT_THIN_M`). */
const SPLIT_M = 3.6;
const SPLIT_THIN_M = 2.6;
/** How far behind a face the point lies that decides its part (metres), and the farthest a part may be. */
const PROBE_M = 0.03;
const REACH_M = 1.0;
/** The shell of cut faces lies this far inside the outline. */
const SHELL_INSET_M = 0.02;
const GRID_M = 2;
/** Daylight share (0–255) the broad faces of a shell are lit with: they fly in the open. */
const SHELL_DAYLIGHT = 110;

interface Solid {
  part: StructurePart;
  ring: number[];
  /** Outward unit normals and offsets of the outline edges: inside where n·p <= d. */
  nx: number[];
  nz: number[];
  d: number[];
  y0: number;
  y1: number;
  volume: number;
}

type P2 = [number, number];

interface Piece {
  part: StructurePart;
  change: FallChange;
  sub: number;
  /** Outline of the piece (x, z) and its frame extents. */
  poly: P2[];
  cx: number;
  cz: number;
  thin: number;
  size: number;
  /** Area of its own drawn surface (m²). */
  surface: number;
  /** Source triangles (whole) and clipped polygons (barycentric over a source triangle). */
  whole: number[];
  clipped: { tri: number; w: [number, number, number][] }[];
  shell: boolean;
  hidden: boolean;
  track?: BallisticTrack;
}

export function fallPieces(o: FallInput): FallOutput {
  const { desc, state, before } = o;
  if (before.indices) throw new Error('fallPieces: indexed meshes are not supported');
  const src = new Uint8Array(before.vertices.buffer, before.vertices.byteOffset, before.count * SRC);
  const f32 = new Float32Array(before.vertices.buffer, before.vertices.byteOffset, (before.count * SRC) / 4);
  const i8 = new Int8Array(before.vertices.buffer, before.vertices.byteOffset, before.count * SRC);
  const falling = new Map<number, FallChange>();
  for (const c of o.changes) falling.set(c.part, c);

  // Solids of every part, in a grid over x, z.
  const solids = desc.parts.map(solidOf);
  const grid = new Map<number, Solid[]>();
  const cell = (x: number, z: number): number => (Math.floor(x / GRID_M) + 32768) * 65536 + (Math.floor(z / GRID_M) + 32768);
  for (const s of solids) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let k = 0; k < s.ring.length; k += 2) {
      x0 = Math.min(x0, s.ring[k]!);
      x1 = Math.max(x1, s.ring[k]!);
      z0 = Math.min(z0, s.ring[k + 1]!);
      z1 = Math.max(z1, s.ring[k + 1]!);
    }
    for (let gx = Math.floor((x0 - REACH_M) / GRID_M); gx <= Math.floor((x1 + REACH_M) / GRID_M); gx++) {
      for (let gz = Math.floor((z0 - REACH_M) / GRID_M); gz <= Math.floor((z1 + REACH_M) / GRID_M); gz++) {
        const key = (gx + 32768) * 65536 + (gz + 32768);
        const l = grid.get(key);
        if (l) l.push(s);
        else grid.set(key, [s]);
      }
    }
  }

  // Every triangle to the part whose solid holds the point just behind its face.
  const trisOf = new Map<number, number[]>();
  const tris = before.count / 3;
  for (let t = 0; t < tris; t++) {
    const v0 = t * 3;
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let k = 0; k < 3; k++) {
      px += f32[((v0 + k) * SRC) / 4]! / 3;
      py += f32[((v0 + k) * SRC) / 4 + 1]! / 3;
      pz += f32[((v0 + k) * SRC) / 4 + 2]! / 3;
    }
    const o2 = (v0 + 2) * SRC + 12;
    let nx = i8[o2]!;
    let ny = i8[o2 + 1]!;
    let nz = i8[o2 + 2]!;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    px -= nx * PROBE_M;
    py -= ny * PROBE_M;
    pz -= nz * PROBE_M;
    let best: Solid | null = null;
    let bestD = REACH_M;
    for (const s of grid.get(cell(px, pz)) ?? []) {
      const d = outside(s, px, py, pz);
      if (d < bestD - 1e-6 || (best && d <= bestD + 1e-6 && s.volume < best.volume)) {
        best = s;
        bestD = Math.min(bestD, d);
      }
    }
    if (!best || !falling.has(best.part.key)) continue;
    const l = trisOf.get(best.part.key);
    if (l) l.push(t);
    else trisOf.set(best.part.key, [t]);
  }

  // Pieces: one per part, or a grid of them for a wide part.
  const byKey = new Map(solids.map((s) => [s.part.key, s] as const));
  const pieces: Piece[] = [];
  for (const c of o.changes) {
    const s = byKey.get(c.part);
    if (!s) continue;
    const own = trisOf.get(c.part) ?? [];
    const solidMaterial = s.part.material === STRUCTURE_MATERIAL.masonry || s.part.material === STRUCTURE_MATERIAL.floor || s.part.material === STRUCTURE_MATERIAL.partition;
    // Frame along the longest outline edge.
    let ux = 1;
    let uz = 0;
    let longest = 0;
    const n = s.ring.length / 2;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const dx = s.ring[j * 2]! - s.ring[k * 2]!;
      const dz = s.ring[j * 2 + 1]! - s.ring[k * 2 + 1]!;
      const l = Math.sqrt(dx * dx + dz * dz);
      if (l > longest) {
        longest = l;
        ux = dx / l;
        uz = dz / l;
      }
    }
    // A solid part gets a shell only where its own faces cover its outline's long side (a wall bay, a slab); a part
    // whose solid is only a bounding box of its surface (a gable triangle) would show the box.
    let shell = solidMaterial && own.length === 0;
    if (solidMaterial && own.length > 0) {
      const h = s.y1 - s.y0;
      let front = 0;
      let back = 0;
      let flat = 0;
      for (const t of own) {
        const [area, nx, ny, nz] = triArea(f32, t);
        const across = -nx * uz + nz * ux;
        if (Math.abs(ny) > 0.7) flat += area;
        else if (across > 0.7) front += area;
        else if (across < -0.7) back += area;
      }
      const side = Math.max(front, back);
      shell = side >= 0.7 * longest * h || flat >= 0.7 * (s.volume / Math.max(h, 0.01));
    }
    const U = (x: number, z: number): number => x * ux + z * uz;
    const V = (x: number, z: number): number => -x * uz + z * ux;
    let u0 = Infinity;
    let u1 = -Infinity;
    let w0 = Infinity;
    let w1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const u = U(s.ring[k * 2]!, s.ring[k * 2 + 1]!);
      const v = V(s.ring[k * 2]!, s.ring[k * 2 + 1]!);
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      w0 = Math.min(w0, v);
      w1 = Math.max(w1, v);
    }
    const split = shell ? SPLIT_M : SPLIT_THIN_M;
    const nu = u1 - u0 > split * 1.15 ? Math.ceil((u1 - u0) / split) : 1;
    const nv = w1 - w0 > split * 1.15 ? Math.ceil((w1 - w0) / split) : 1;
    const ringP: P2[] = [];
    for (let k = 0; k < n; k++) ringP.push([s.ring[k * 2]!, s.ring[k * 2 + 1]!]);
    for (let a = 0; a < nu; a++) {
      for (let b = 0; b < nv; b++) {
        const cu0 = nu === 1 ? -Infinity : u0 + ((u1 - u0) * a) / nu;
        const cu1 = nu === 1 ? Infinity : u0 + ((u1 - u0) * (a + 1)) / nu;
        const cv0 = nv === 1 ? -Infinity : w0 + ((w1 - w0) * b) / nv;
        const cv1 = nv === 1 ? Infinity : w0 + ((w1 - w0) * (b + 1)) / nv;
        const inCell = (p: P2): [number, number, number, number] => [U(p[0], p[1]) - cu0, cu1 - U(p[0], p[1]), V(p[0], p[1]) - cv0, cv1 - V(p[0], p[1])];
        let poly = ringP;
        for (let h = 0; h < 4; h++) poly = clipPoly(poly, (p) => inCell(p)[h]!);
        if (poly.length < 3) continue;
        const piece: Piece = { part: s.part, change: c, sub: a * nv + b, poly, cx: 0, cz: 0, thin: 0, size: 0, surface: 0, whole: [], clipped: [], shell, hidden: false };
        for (const p of poly) {
          piece.cx += p[0] / poly.length;
          piece.cz += p[1] / poly.length;
        }
        let pu0 = Infinity;
        let pu1 = -Infinity;
        let pv0 = Infinity;
        let pv1 = -Infinity;
        for (const p of poly) {
          pu0 = Math.min(pu0, U(p[0], p[1]));
          pu1 = Math.max(pu1, U(p[0], p[1]));
          pv0 = Math.min(pv0, V(p[0], p[1]));
          pv1 = Math.max(pv1, V(p[0], p[1]));
        }
        const h = s.y1 - s.y0;
        piece.thin = Math.min(h, Math.min(pu1 - pu0, pv1 - pv0) + 0.1);
        piece.size = (pu1 - pu0) * (pv1 - pv0) * Math.max(h, 0.2);
        if (nu * nv === 1) {
          piece.whole = own;
          for (const t of own) piece.surface += triArea(f32, t)[0];
        } else {
          for (const t of own) {
            const w = clipTri(t, (p) => inCell(p), f32);
            if (w.length < 3) continue;
            piece.clipped.push({ tri: t, w });
            // Share of the triangle kept: area of the clipped polygon in barycentric coordinates (the triangle is 1/2).
            let a = 0;
            for (let k = 0; k < w.length; k++) {
              const p = w[k]!;
              const q = w[(k + 1) % w.length]!;
              a += p[0] * q[1] - q[0] * p[1];
            }
            piece.surface += triArea(f32, t)[0] * Math.min(1, Math.abs(a));
          }
        }
        if (piece.whole.length === 0 && piece.clipped.length === 0 && !shell) continue;
        piece.hidden = (s.part.flags & PART_FLAG.inner) !== 0 || (piece.whole.length === 0 && piece.clipped.length === 0);
        pieces.push(piece);
      }
    }
  }

  // Budget: hidden and small pieces go to dust first.
  const order = pieces.map((_, i) => i).sort((a, b) => score(pieces[b]!) - score(pieces[a]!) || a - b);
  const flies = new Uint8Array(pieces.length);
  order.slice(0, Math.max(0, o.budget)).forEach((i) => (flies[i] = 1));

  // Tracks, puffs, arrivals.
  const alive = desc.parts.filter((p) => {
    if (state.ruin) return (p.flags & PART_FLAG.indestructible) !== 0;
    const e = state.parts.get(p.key);
    return e === undefined || (e & 3) !== DAMAGE.gone;
  });
  // Standing parts, for where a piece may land and what it must not fly into (grid lookups, no search).
  const standing = new Set(alive.map((p) => p.key));
  /** Highest standing top under (x, z) that is not above `below`, else the ground. */
  const supportAt = (x: number, z: number, below: number): number => {
    let f = o.groundAt(x, z);
    for (const q of grid.get(cell(x, z)) ?? []) {
      if (!standing.has(q.part.key) || q.y1 > below + 0.01 || q.y1 <= f) continue;
      if (insideCm(q.part, x * 100, z * 100)) f = q.y1;
    }
    return f;
  };
  /** A standing part holds the point (x, y, z): a piece there would be inside it. */
  const blocked = (x: number, y: number, z: number): boolean => {
    for (const q of grid.get(cell(x, z)) ?? []) {
      if (!standing.has(q.part.key) || q.y1 <= y + BLOCK_M || q.y0 >= y + BLOCK_M) continue;
      if (insideCm(q.part, x * 100, z * 100)) return true;
    }
    return false;
  };
  // Centre of the structure (bounding box of its parts): pieces that lose support lean away from it.
  let sx0 = Infinity;
  let sx1 = -Infinity;
  let sz0 = Infinity;
  let sz1 = -Infinity;
  for (const q of solids) {
    for (let k = 0; k < q.ring.length; k += 2) {
      sx0 = Math.min(sx0, q.ring[k]!);
      sx1 = Math.max(sx1, q.ring[k]!);
      sz0 = Math.min(sz0, q.ring[k + 1]!);
      sz1 = Math.max(sz1, q.ring[k + 1]!);
    }
  }
  const scx = (sx0 + sx1) / 2;
  const scz = (sz0 + sz1) / 2;
  /**
   * Keeps a piece out of standing parts: the landing spot (and the middle of the flight) must not lie inside one. The
   * horizontal velocity is tried at full, reduced, turned back and zero, and the landing height follows the spot.
   */
  const clear = (t: BallisticTrack, x: number, z: number, below: number, thin: number): BallisticTrack => {
    for (const k of CLEAR_SCALES) {
      let c: BallisticTrack = { ...t, vx: t.vx * k, vz: t.vz * k };
      for (let it = 0; it < 2; it++) {
        const fl = trackFlightTime(c);
        c = { ...c, land: supportAt(x + c.vx * fl, z + c.vz * fl, below) + thin * 0.5 };
      }
      if (k === 0) return c;
      const fl = trackFlightTime(c);
      const h = fl / 2;
      const midY = Math.max(c.land, c.y + c.vy * h - 4.905 * h * h);
      if (!blocked(x + c.vx * fl, c.land, z + c.vz * fl) && !blocked(x + c.vx * h, midY, z + c.vz * h)) return c;
    }
    return t;
  };
  const puffs: DustPuff[] = [];
  const arrivals = new Map<number, { start: number; seconds: number }>();
  let start = Infinity;
  let end = -Infinity;
  pieces.forEach((pc, i) => {
    const s = byKey.get(pc.part.key)!;
    const ev = pc.change.event ?? o.event;
    const r = (k: number): number => unit(hashInts(ev.seed, desc.id, pc.part.key, pc.sub, k));
    const y0 = s.y0;
    const y1 = s.y1;
    const cy = (y0 + y1) / 2;
    const { cx, cz, thin } = pc;
    let floor = o.groundAt(cx, cz);
    for (const q of alive) {
      if (q.piece.y1 / 100 > y0 + 0.01 || q.piece.y1 / 100 <= floor) continue;
      if (insideCm(q, cx * 100, cz * 100)) floor = q.piece.y1 / 100;
    }
    const at = o.at + pc.change.delay;
    let track: BallisticTrack;
    if (pc.change.hit) {
      let dx = cx - ev.x;
      let dz = cz - ev.z;
      const dy = cy - ev.y;
      const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
      const l = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= l;
      dz /= l;
      const near = Math.max(0, 1 - dist / Math.max(ev.radius, 0.5));
      const speed = (2 + 7 * Math.min(1, ev.energy / 2000) * (0.4 + 0.6 * near)) * (0.8 + 0.4 * r(1));
      const side = (r(2) - 0.5) * 0.5;
      const ground = o.groundAt(cx + dx * speed * 0.8, cz + dz * speed * 0.8);
      track = { start: at, x: cx, y: cy, z: cz, vx: (dx - dz * side) * speed, vy: 1.5 + 3 * r(3) * (0.5 + near), vz: (dz + dx * side) * speed, ax: -dz, ay: 0, az: dx, spin: (r(4) < 0.5 ? -1 : 1) * (2 + 5 * r(5)), land: ground + thin * 0.5 };
    } else {
      const e = state.ruin ? 0 : (state.parts.get(pc.part.key) ?? 0);
      const dir = state.ruin ? 8 : entryDir(e);
      const [fx, fz] = dir < 8 ? DIRS[dir]! : [0, 0];
      const drift = dir < 8 ? 0.6 + 0.8 * r(1) : 0.15 * r(1);
      const tilt = (r(4) < 0.5 ? -1 : 1) * (0.4 + 1.0 * r(5));
      // Lean away from the structure's centre, so falling pieces spread out instead of dropping through each other.
      let ox = cx - scx;
      let oz = cz - scz;
      const ol = Math.sqrt(ox * ox + oz * oz);
      const lean = ol > 0.5 ? LEAN_MS * (0.5 + r(8)) : 0;
      ox = ol > 0.5 ? ox / ol : 0;
      oz = ol > 0.5 ? oz / ol : 0;
      // Without a fall side the tilt axis is a hashed horizontal direction.
      const ang = r(6) * Math.PI;
      const ax = fz !== 0 || fx !== 0 ? -fz : Math.cos(ang);
      const az = fz !== 0 || fx !== 0 ? fx : Math.sin(ang);
      track = {
        start: at + STAGGER_S * r(7),
        x: cx,
        y: cy,
        z: cz,
        vx: fx * drift + ox * lean + (r(2) - 0.5) * 0.4,
        vy: 0,
        vz: fz * drift + oz * lean + (r(3) - 0.5) * 0.4,
        ax,
        ay: 0,
        az,
        spin: tilt,
        land: floor + thin * 0.5,
      };
    }
    if (!flies[i]) track = { ...track, vx: 0, vy: 0, vz: 0, spin: 0, dust: true };
    else track = clear(track, cx, cz, y0, thin);
    pc.track = track;
    const fl = trackFlightTime(track);
    if (track.dust) {
      puffs.push({ x: cx, y: cy, z: cz, start: track.start, size: Math.max(1.2, Math.min(4, Math.sqrt(pc.size / Math.max(thin, 0.2)))) });
    } else {
      puffs.push({ x: cx + track.vx * fl, y: track.land - 0.3, z: cz + track.vz * fl, start: track.start + fl, size: Math.max(0.8, Math.min(3.5, Math.cbrt(pc.size) * 1.1)) });
    }
    const arrive = track.start + fl;
    const prev = arrivals.get(pc.part.key);
    if (!prev || arrive > prev.start) arrivals.set(pc.part.key, { start: arrive, seconds: GROW_S });
    start = Math.min(start, track.start);
    end = Math.max(end, track.start + trackLifetime(track), arrive + GROW_S);
  });
  // Parts with nothing to draw still get their rubble on time.
  for (const c of o.changes) {
    if (!arrivals.has(c.part)) arrivals.set(c.part, { start: o.at + c.delay, seconds: GROW_S });
    start = Math.min(start, o.at + c.delay);
    end = Math.max(end, o.at + c.delay + GROW_S);
  }

  // Vertices: the source bytes (whole triangles), clipped triangles (interpolated position and surface coordinates,
  // the rest from the provoking vertex), the shell; each with the piece's track.
  // Colours and storey data of a shell come from a wall triangle of its own part, else from any wall of the structure.
  const isWall = (t: number): boolean => (i8[t * 3 * SRC + 15]! & 7) === KIND.wall;
  let wallTri = 0;
  for (let t = 0; t < tris; t++) {
    if (isWall(t)) {
      wallTri = t;
      break;
    }
  }
  const ownWall = (pc: Piece): number | undefined => pc.whole.find(isWall) ?? pc.clipped.find((c) => isWall(c.tri))?.tri;
  const shellW = new VertexWriter();
  const shellRange: [number, number][] = [];
  for (const pc of pieces) {
    const from = shellW.count;
    if (pc.shell) writeShell(shellW, pc, byKey.get(pc.part.key)!, src, f32, ownWall(pc) ?? wallTri, before.count > 0);
    shellRange.push([from, shellW.count]);
  }
  const shellBytes = shellW.bytes();
  let total = 0;
  pieces.forEach((pc, i) => {
    total += pc.whole.length * 3 + shellRange[i]![1] - shellRange[i]![0];
    for (const c of pc.clipped) total += (c.w.length - 2) * 3;
  });
  const out = new ArrayBuffer(total * STRIDE);
  const ob = new Uint8Array(out);
  const of = new Float32Array(out);
  let v = 0;
  const trackAt = (t: BallisticTrack): void => writeTrack(of, (v * STRIDE + SRC) / 4, t);
  const tracks: BallisticTrack[] = [];
  const flyingFirst = pieces.map((_, i) => i).sort((a, b) => flies[b]! - flies[a]! || a - b);
  for (const i of flyingFirst) {
    const pc = pieces[i]!;
    const t = pc.track!;
    tracks.push(t);
    for (const tri of pc.whole) {
      for (let k = 0; k < 3; k++) {
        ob.set(src.subarray((tri * 3 + k) * SRC, (tri * 3 + k + 1) * SRC), v * STRIDE);
        trackAt(t);
        v++;
      }
    }
    for (const c of pc.clipped) {
      const put = (w: [number, number, number]): void => {
        const prov = (c.tri * 3 + 2) * SRC;
        ob.set(src.subarray(prov, prov + SRC), v * STRIDE);
        const of0 = (v * STRIDE) / 4;
        for (const fi of [0, 1, 2, 4, 5, 6, 7]) {
          let x = 0;
          for (let k = 0; k < 3; k++) x += w[k]! * f32[((c.tri * 3 + k) * SRC) / 4 + fi]!;
          of[of0 + fi] = x;
        }
        trackAt(t);
        v++;
      };
      for (let k = 1; k + 1 < c.w.length; k++) {
        put(c.w[0]!);
        put(c.w[k]!);
        put(c.w[k + 1]!);
      }
    }
    const [a, b] = shellRange[i]!;
    for (let k = a; k < b; k++) {
      ob.set(shellBytes.subarray(k * SRC, (k + 1) * SRC), v * STRIDE);
      writeTrack(of, (v * STRIDE + SRC) / 4, t, true);
      v++;
    }
  }
  const flying = flies.reduce((n, x) => n + x, 0);
  return {
    mesh: { layout: FALL_LAYOUT, vertices: new Float32Array(out), indices: null, count: v },
    pieces: flying,
    dust: pieces.length - flying,
    puffs,
    arrivals,
    start: Number.isFinite(start) ? start : o.at,
    end: Number.isFinite(end) ? end : o.at,
    tracks,
  };
}

/**
 * Moves a prepared fall `dt` seconds later on the clock: track starts in every vertex, puffs, arrivals and the span.
 * For a fall prepared at the event's clock time and shown a little later (the preparation ran over a few tasks), so the
 * collapse starts when it first shows. Shapes and the timeline relative to the event stay the same.
 */
export function retimeFall(out: FallOutput, dt: number): void {
  if (dt === 0) return;
  const f32 = new Float32Array(out.mesh.vertices.buffer, out.mesh.vertices.byteOffset, (out.mesh.count * STRIDE) / 4);
  for (let v = 0; v < out.mesh.count; v++) {
    const k = (v * STRIDE + SRC) / 4 + 3;
    f32[k] = f32[k]! + dt;
  }
  out.puffs = out.puffs.map((p) => ({ ...p, start: p.start + dt }));
  for (const a of out.arrivals.values()) a.start += dt;
  out.tracks = out.tracks.map((t) => ({ ...t, start: t.start + dt }));
  out.start += dt;
  out.end += dt;
}

/** Area and unit normal of a source triangle (from its positions). */
function triArea(f32: Float32Array, t: number): [number, number, number, number] {
  const o = (k: number): number => ((t * 3 + k) * SRC) / 4;
  const ax = f32[o(1)]! - f32[o(0)]!;
  const ay = f32[o(1) + 1]! - f32[o(0) + 1]!;
  const az = f32[o(1) + 2]! - f32[o(0) + 2]!;
  const bx = f32[o(2)]! - f32[o(0)]!;
  const by = f32[o(2) + 1]! - f32[o(0) + 1]!;
  const bz = f32[o(2) + 2]! - f32[o(0) + 2]!;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return l < 1e-12 ? [0, 0, 1, 0] : [l / 2, cx / l, cy / l, cz / l];
}

/** Which pieces fly when the budget is short: the most drawn surface first; hidden pieces last, by size. */
function score(p: Piece): number {
  return p.hidden ? 1e-3 * p.size : p.surface;
}

function solidOf(part: StructurePart): Solid {
  const ring: number[] = [];
  const n = part.piece.xz.length / 2;
  let cx = 0;
  let cz = 0;
  for (let k = 0; k < n; k++) {
    ring.push(part.piece.xz[k * 2]! / 100, part.piece.xz[k * 2 + 1]! / 100);
    cx += ring[k * 2]! / n;
    cz += ring[k * 2 + 1]! / n;
  }
  const nx: number[] = [];
  const nz: number[] = [];
  const d: number[] = [];
  let area = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ax = ring[k * 2]!;
    const az = ring[k * 2 + 1]!;
    const bx = ring[j * 2]!;
    const bz = ring[j * 2 + 1]!;
    area += ax * bz - bx * az;
    const l = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
    if (l < 1e-6) continue;
    let ex = (bz - az) / l;
    let ez = -(bx - ax) / l;
    if ((ax + bx) / 2 * ex + (az + bz) / 2 * ez - (cx * ex + cz * ez) < 0) {
      ex = -ex;
      ez = -ez;
    }
    nx.push(ex);
    nz.push(ez);
    d.push(ax * ex + az * ez);
  }
  const y0 = part.piece.y0 / 100;
  const y1 = part.piece.y1 / 100;
  return { part, ring, nx, nz, d, y0, y1, volume: (Math.abs(area) / 2) * Math.max(0.01, y1 - y0) };
}

/** Distance of a point outside a solid (0 inside). */
function outside(s: Solid, x: number, y: number, z: number): number {
  let m = Math.max(s.y0 - y, y - s.y1);
  for (let k = 0; k < s.nx.length; k++) m = Math.max(m, x * s.nx[k]! + z * s.nz[k]! - s.d[k]!);
  return Math.max(0, m);
}

/** Is the point (cm) inside the convex outline of the part? */
function insideCm(p: StructurePart, x: number, z: number): boolean {
  const xz = p.piece.xz;
  const n = xz.length / 2;
  let sign = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const cr = (xz[j * 2]! - xz[k * 2]!) * (z - xz[k * 2 + 1]!) - (xz[j * 2 + 1]! - xz[k * 2 + 1]!) * (x - xz[k * 2]!);
    if (cr === 0) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Keeps the part of a convex polygon where `side(p) >= 0` (side is affine). */
function clipPoly(poly: P2[], side: (p: P2) => number): P2[] {
  const out: P2[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!;
    const b = poly[(k + 1) % poly.length]!;
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Clips a source triangle to a cell (four affine sides in x, z); the result as barycentric weights. */
function clipTri(t: number, sides: (p: P2) => [number, number, number, number], f32: Float32Array): [number, number, number][] {
  const P = (k: number): P2 => [f32[((t * 3 + k) * SRC) / 4]!, f32[((t * 3 + k) * SRC) / 4 + 2]!];
  const p = [P(0), P(1), P(2)];
  let poly: [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const at = (w: [number, number, number]): P2 => [w[0] * p[0]![0] + w[1] * p[1]![0] + w[2] * p[2]![0], w[0] * p[0]![1] + w[1] * p[1]![1] + w[2] * p[2]![1]];
  for (let h = 0; h < 4; h++) {
    const out: [number, number, number][] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!;
      const b = poly[(k + 1) % poly.length]!;
      const sa = sides(at(a))[h]!;
      const sb = sides(at(b))[h]!;
      if (sa >= 0) out.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const u = sa / (sa - sb);
        out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
      }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly;
}

/**
 * A closed shell of cut faces just inside the piece's outline, from its bottom to its top: sides, top and bottom.
 * Colours and storey data come from one of the part's own vertices.
 */
function writeShell(w: VertexWriter, pc: Piece, s: Solid, src: Uint8Array, f32: Float32Array, tri: number, hasSource: boolean): void {
  const o = tri * 3 * SRC;
  const fo = o / 4;
  const wallColor = hasSource ? src[o + 48]! : 0;
  const mat = { seed: hasSource ? f32[fo + 10]! : 0, bayWidth: hasSource ? f32[fo + 11]! : 3, wallColor, roofColor: hasSource ? src[o + 49]! : 0, windowStyle: hasSource ? src[o + 50]! : 0, trimColor: wallColor };
  const floorHeight = hasSource ? f32[fo + 8]! : 3;
  const floors = hasSource ? f32[fo + 9]! : 1;
  const poly = inset(pc.poly, SHELL_INSET_M);
  if (poly.length < 3) return;
  const y0 = s.y0 + SHELL_INSET_M;
  const y1 = s.y1 - SHELL_INSET_M;
  if (y1 <= y0) return;
  // Narrow faces (the thickness of a wall or a slab where it broke) show the broken core. Broad faces show the
  // surface the part had inside: a slab its floor on top and its ceiling below, a partition and the back of a wall
  // room paint (KIND.interior, the same shading as the interior of a damaged structure, lit as a room in full
  // daylight that never has its lamp on). The room hash comes from the part, so all pieces of a slab match.
  const CORE_M = 0.8;
  const isFloor = s.part.material === STRUCTURE_MATERIAL.floor;
  const room = unit(hashInts(0x5e11, s.part.key)) * 0.999;
  const faFor = (finish: number): WallAttr => ({
    doorU: 2,
    doorW: 0,
    doorY: 1,
    groundFloorH: 2,
    win: [SHELL_DAYLIGHT * WIN_UNIT, 128 * WIN_UNIT, 128 * WIN_UNIT, 0],
    bits: [finish, ROOM_TYPE.room, 0, 0],
    cols: [0, 0, 0, 0],
  });
  const core = KIND.trim + DAMAGE_STEP * 3;
  // Paint stays clean (cracks at room-paint scale read as a glaze); floors and ceilings get the light cracks.
  const surface = KIND.interior;
  const cracked = KIND.interior + DAMAGE_STEP * 1;
  const faCore = faFor(0);
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: number, s0: number, s1: number, fa: WallAttr): void =>
    kind === core
      ? w.push(x, y, z, nx, ny, nz, kind, 0, 0, y - s.y0, 100, mat, floors, floorHeight)
      : w.push(x, y, z, nx, ny, nz, kind, s0, s1, floorHeight, room, mat, floors, floorHeight, fa);
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p[0] / poly.length;
    cz += p[1] / poly.length;
  }
  const paint = faFor(FINISH.paint);
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!;
    const b = poly[(k + 1) % poly.length]!;
    let nx = b[1] - a[1];
    let nz = -(b[0] - a[0]);
    const l = Math.sqrt(nx * nx + nz * nz) || 1;
    nx /= l;
    nz /= l;
    if ((a[0] + b[0]) / 2 * nx + (a[1] + b[1]) / 2 * nz < cx * nx + cz * nz) {
      nx = -nx;
      nz = -nz;
    }
    const narrow = Math.min(l, y1 - y0) < CORE_M;
    const kind = narrow || isFloor ? core : surface;
    const fa = kind === core ? faCore : paint;
    // Pattern coordinates on a side: along the edge and height above the part's bottom.
    const ua = a[0] * -nz + a[1] * nx;
    const ub = b[0] * -nz + b[1] * nx;
    put(a[0], y0, a[1], nx, 0, nz, kind, ua, y0 - s.y0, fa);
    put(b[0], y0, b[1], nx, 0, nz, kind, ub, y0 - s.y0, fa);
    put(b[0], y1, b[1], nx, 0, nz, kind, ub, y1 - s.y0, fa);
    put(a[0], y0, a[1], nx, 0, nz, kind, ua, y0 - s.y0, fa);
    put(b[0], y1, b[1], nx, 0, nz, kind, ub, y1 - s.y0, fa);
    put(a[0], y1, a[1], nx, 0, nz, kind, ua, y1 - s.y0, fa);
  }
  let edge = 0;
  for (let k = 0; k < poly.length; k++) edge = Math.max(edge, Math.hypot(poly[(k + 1) % poly.length]![0] - poly[k]![0], poly[(k + 1) % poly.length]![1] - poly[k]![1]));
  const flatNarrow = polyArea(poly) / Math.max(edge, 1e-3) < CORE_M;
  for (const [y, ny] of [
    [y1, 1],
    [y0, -1],
  ] as const) {
    const kind = flatNarrow || !isFloor ? core : cracked;
    const fa = kind === core ? faCore : faFor(ny > 0 ? FINISH.floor : FINISH.ceiling);
    for (let k = 1; k + 1 < poly.length; k++) {
      put(poly[0]![0], y, poly[0]![1], 0, ny, 0, kind, poly[0]![0], poly[0]![1], fa);
      put(poly[k]![0], y, poly[k]![1], 0, ny, 0, kind, poly[k]![0], poly[k]![1], fa);
      put(poly[k + 1]![0], y, poly[k + 1]![1], 0, ny, 0, kind, poly[k + 1]![0], poly[k + 1]![1], fa);
    }
  }
}

function polyArea(poly: P2[]): number {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!;
    const q = poly[(k + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** A convex polygon moved inward by `d` along every edge (corners where the moved edges meet). */
function inset(poly: P2[], d: number): P2[] {
  const n = poly.length;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p[0] / n;
    cz += p[1] / n;
  }
  const lines: [number, number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = poly[k]!;
    const b = poly[(k + 1) % n]!;
    let nx = b[1] - a[1];
    let nz = -(b[0] - a[0]);
    const l = Math.sqrt(nx * nx + nz * nz);
    if (l < 1e-6) continue;
    nx /= l;
    nz /= l;
    if (a[0] * nx + a[1] * nz < cx * nx + cz * nz) {
      nx = -nx;
      nz = -nz;
    }
    lines.push([nx, nz, a[0] * nx + a[1] * nz - d]);
  }
  const out: P2[] = [];
  for (let k = 0; k < lines.length; k++) {
    const [ax, az, ad] = lines[(k + lines.length - 1) % lines.length]!;
    const [bx, bz, bd] = lines[k]!;
    const det = ax * bz - az * bx;
    if (Math.abs(det) < 1e-9) continue;
    out.push([(ad * bz - az * bd) / det, (ax * bd - ad * bx) / det]);
  }
  return out;
}
