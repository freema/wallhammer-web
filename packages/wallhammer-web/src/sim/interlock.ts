// Shared areas between two mover sets (side 0 and side 1), for places where their paths cross: each area is a capsule
// and one side has priority on it. The rules, all from the state at the start of the tick:
//
// - The yielding side does not enter while somebody of the priority side is on the area, close before it
//   (`approach`) or can no longer stop before it, unless it can no longer stop itself.
// - The priority side does not enter while somebody of the yielding side is on the area or can no longer stop
//   before it (it is committed).
//
// The yielding side only ever waits for entities that are there or about to be; the priority side only for ones
// that are already through the door. Nobody waits for a waiting entity of the other side, so the two sides cannot
// wait for each other in a circle. Occupancy is derived from positions each tick: the interlock adds nothing to
// snapshots. Register `system` before the systems of both mover sets.

import { mm, stoppingDistance } from './fixed.ts';
import { MOVER_STATE, capsuleDist2 } from './movers.ts';
import type { Capsule, Movers } from './movers.ts';
import type { Path } from './paths.ts';
import type { Simulation } from './simulation.ts';

export interface SharedArea extends Capsule {
  /** The side with right of way on this area. */
  priority: 0 | 1;
}

export interface InterlockOptions {
  areas: readonly SharedArea[];
  /** Distance before an area within which a priority entity counts as about to enter, metres. Default 3. */
  approach?: number;
}

interface AreaIntervals {
  s0: Int32Array;
  s1: Int32Array;
  area: Int32Array;
}

const STEP = 250;
const HOLD = 500;
const NO_LIMIT = 0x7fffffff;
const CELL = 16000;

/**
 * Distance within which an entity at speed `v` can no longer stop before a point: its next move is at least
 * `v − decel`, and braking from there takes `stoppingDistance(v − decel)`. An entity held back by `limitFor` keeps
 * more than that (the limit leaves `HOLD`), so a held entity never turns committed on its own.
 */
function committedWithin(v: number, decel: number): number {
  return v > 0 ? stoppingDistance(Math.max(0, v - decel), decel) : 0;
}

export class Interlock {
  readonly name: string;
  private readonly areas: Int32Array;
  private readonly priority: Uint8Array;
  private readonly approach: number;
  private readonly sides: (Movers | null)[] = [null, null];
  private readonly intervals: Map<number, AreaIntervals>[] = [new Map(), new Map()];
  private readonly grid = new Map<number, number[]>();
  /** Per side and area: entities on it, entities close before it, entities that can no longer stop before it. */
  readonly on: [Int32Array, Int32Array];
  readonly near: [Int32Array, Int32Array];
  readonly committed: [Int32Array, Int32Array];

  constructor(name: string, options: InterlockOptions) {
    this.name = name;
    const n = options.areas.length;
    this.areas = new Int32Array(n * 5);
    this.priority = new Uint8Array(n);
    options.areas.forEach((a, i) => {
      this.areas.set([mm(a.ax), mm(a.az), mm(a.bx), mm(a.bz), mm(a.radius)], i * 5);
      this.priority[i] = a.priority;
      const r = mm(a.radius) + 3000;
      for (let cx = Math.floor((Math.min(mm(a.ax), mm(a.bx)) - r) / CELL); cx <= Math.floor((Math.max(mm(a.ax), mm(a.bx)) + r) / CELL); cx++) {
        for (let cz = Math.floor((Math.min(mm(a.az), mm(a.bz)) - r) / CELL); cz <= Math.floor((Math.max(mm(a.az), mm(a.bz)) + r) / CELL); cz++) {
          const k = (cx + 0x8000) * 0x10000 + (cz + 0x8000);
          const list = this.grid.get(k);
          if (list) list.push(i);
          else this.grid.set(k, [i]);
        }
      }
    });
    this.approach = mm(options.approach ?? 3);
    this.on = [new Int32Array(n), new Int32Array(n)];
    this.near = [new Int32Array(n), new Int32Array(n)];
    this.committed = [new Int32Array(n), new Int32Array(n)];
  }

  get areaCount(): number {
    return this.priority.length;
  }

  /** Links a mover set as side 0 or 1. Its collision must be `static`, `lanes` or `agents`. */
  attach(movers: Movers, side: 0 | 1): void {
    this.sides[side] = movers;
    movers.interlock = { il: this, side };
  }

  /** Drops the cached stretches of a released path. */
  forget(side: 0 | 1, path: number): void {
    this.intervals[side]!.delete(path);
  }

  /** Drops every cached stretch of a side (its paths were replaced, e.g. by loading a snapshot). */
  forgetAll(side: 0 | 1): void {
    this.intervals[side]!.clear();
  }

  /** Area stretches along a path of one side, mm; the body half width of that set is added to every area. */
  stretches(side: 0 | 1, p: Path): AreaIntervals {
    let iv = this.intervals[side]!.get(p.id);
    if (iv) return iv;
    const movers = this.sides[side]!;
    const half = movers.halfWidth;
    const s0: number[] = [];
    const s1: number[] = [];
    const area: number[] = [];
    const pt: [number, number] = [0, 0];
    // Areas open along the walk (with where they opened) and areas under the current point. Few at a time, so plain
    // arrays; the result is sorted at the end, so the order of closing does not matter.
    const openA: number[] = [];
    const openS: number[] = [];
    const inside: number[] = [];
    // Segments whose grid cells hold no area: every sample on them is outside all areas, so after the first one
    // (which closes what is open) the walk jumps to the next segment. Same samples, same result, far fewer lookups.
    let seg = 0;
    let segChecked = -1;
    let segEmpty = false;
    for (let d = 0; ; d += STEP) {
      const u = Math.min(d, p.length);
      if (u < p.length) {
        while (seg + 1 < p.segments && p.segStart[seg + 1]! <= u) seg++;
        if (segChecked !== seg) {
          segChecked = seg;
          segEmpty = this.segmentEmpty(p, seg);
        }
        if (segEmpty) {
          for (let k = 0; k < openA.length; k++) {
            s0.push(openS[k]!);
            s1.push(u);
            area.push(openA[k]!);
          }
          openA.length = 0;
          openS.length = 0;
          const end = Math.min(p.segStart[seg + 1]!, p.length);
          while (d + STEP < end) d += STEP;
          continue;
        }
      }
      movers.paths.pointAt(p, u, pt);
      const x = Math.round(pt[0] * 1000);
      const z = Math.round(pt[1] * 1000);
      const cand = this.grid.get((Math.floor(x / CELL) + 0x8000) * 0x10000 + (Math.floor(z / CELL) + 0x8000));
      inside.length = 0;
      if (cand) {
        for (const a of cand) {
          const o = a * 5;
          const r = this.areas[o + 4]! + half;
          if (capsuleDist2(x, z, this.areas[o]!, this.areas[o + 1]!, this.areas[o + 2]!, this.areas[o + 3]!) < r * r) inside.push(a);
        }
      }
      for (const a of inside) {
        if (openA.indexOf(a) < 0) {
          openA.push(a);
          openS.push(u);
        }
      }
      for (let k = openA.length - 1; k >= 0; k--) {
        if (inside.indexOf(openA[k]!) >= 0) continue;
        s0.push(openS[k]!);
        s1.push(u);
        area.push(openA[k]!);
        openA.splice(k, 1);
        openS.splice(k, 1);
      }
      if (u >= p.length) break;
    }
    for (let k = 0; k < openA.length; k++) {
      s0.push(openS[k]!);
      s1.push(p.length);
      area.push(openA[k]!);
    }
    const order = s0.map((_, i) => i).sort((a, b) => s0[a]! - s0[b]! || area[a]! - area[b]!);
    iv = { s0: Int32Array.from(order, (i) => s0[i]!), s1: Int32Array.from(order, (i) => s1[i]!), area: Int32Array.from(order, (i) => area[i]!) };
    this.intervals[side]!.set(p.id, iv);
    return iv;
  }

  /** Does no grid cell under segment `seg` of a path hold an area? (Cells of its rounded bounding box, 1 mm wider.) */
  private segmentEmpty(p: Path, seg: number): boolean {
    const a = seg;
    const b = (seg + 1) % p.xs.length;
    const ax = Math.round(p.xs[a]! * 1000);
    const az = Math.round(p.zs[a]! * 1000);
    const bx = Math.round(p.xs[b]! * 1000);
    const bz = Math.round(p.zs[b]! * 1000);
    const c0 = Math.floor((Math.min(ax, bx) - 1) / CELL);
    const c1 = Math.floor((Math.max(ax, bx) + 1) / CELL);
    const r0 = Math.floor((Math.min(az, bz) - 1) / CELL);
    const r1 = Math.floor((Math.max(az, bz) + 1) / CELL);
    for (let cx = c0; cx <= c1; cx++) for (let cz = r0; cz <= r1; cz++) if (this.grid.has((cx + 0x8000) * 0x10000 + (cz + 0x8000))) return false;
    return true;
  }

  /** Recounts who is on, near and committed to every area. Register it before both movers systems. */
  readonly system = (_sim: Simulation): void => {
    for (const side of [0, 1] as const) {
      this.on[side]!.fill(0);
      this.near[side]!.fill(0);
      this.committed[side]!.fill(0);
      const m = this.sides[side];
      if (!m) continue;
      const c = m.table.col;
      for (let r = 0; r < m.count; r++) {
        const p = m.paths.get(c.path[r]!);
        const iv = this.stretches(side, p);
        if (iv.s0.length === 0) continue;
        const [rear, front] = m.body(r);
        const moving = c.state[r] === MOVER_STATE.moving;
        const stop = moving ? committedWithin(c.speed[r]!, c.decel[r]!) : 0;
        for (let lap = 0; lap < (p.loop ? 2 : 1); lap++) {
          const off = lap * p.length;
          for (let i = 0; i < iv.s0.length; i++) {
            const a0 = iv.s0[i]! + off;
            const a1 = iv.s1[i]! + off;
            const a = iv.area[i]!;
            if (a1 >= rear && a0 <= front) this.on[side]![a]!++;
            else if (moving && a0 > front) {
              if (a0 - front <= this.approach) this.near[side]![a]!++;
              if (c.speed[r]! > 0 && a0 - front <= stop) this.committed[side]![a]!++;
            }
          }
        }
      }
    }
  };

  /** Free distance (mm) for row `r` of `movers` on side `side`: how far it may go before the next area it must wait at. */
  limitFor(movers: Movers, side: 0 | 1, r: number, p: Path, reach: number): number {
    const iv = this.stretches(side, p);
    if (iv.s0.length === 0) return NO_LIMIT;
    const c = movers.table.col;
    const [rear, front] = movers.body(r);
    const other = (1 - side) as 0 | 1;
    const stop = committedWithin(c.speed[r]!, c.decel[r]!);
    for (let lap = 0; lap < (p.loop ? 2 : 1); lap++) {
      const off = lap * p.length;
      for (let i = 0; i < iv.s0.length; i++) {
        const a0 = iv.s0[i]! + off;
        const a1 = iv.s1[i]! + off;
        if (a1 < rear) continue;
        if (a0 <= front) continue;
        if (a0 - front > reach) return NO_LIMIT;
        const a = iv.area[i]!;
        let blocked: boolean;
        if (this.priority[a] === side) blocked = this.on[other]![a]! > 0 || this.committed[other]![a]! > 0;
        else blocked = (this.on[other]![a]! > 0 || this.near[other]![a]! > 0 || this.committed[other]![a]! > 0) && !(c.speed[r]! > 0 && a0 - front <= stop);
        if (blocked) return Math.max(0, a0 - front - HOLD);
      }
    }
    return NO_LIMIT;
  }
}
