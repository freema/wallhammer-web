// An index of the solids that the instances of loaded cells stand for, in world space. The application says per
// archetype where an instance record keeps its base point, its size and its turn (`InstanceSolid` of base); the index
// reads the records of a cell when the cell is added, keeps one entry per solid in world metres (double precision) and
// drops them all when the cell is removed. `within` answers which solids come within a radius of a point, on a flat
// world and on a sphere alike, because everything is kept in world coordinates with each solid's own up.
//
// Entries sit in a spatial hash of cubes of `bucketM` keyed on the world position of the middle of each solid's axis; a
// query visits the cubes round the point grown by the largest solid in the index (worked out again after that solid
// leaves). A query that would visit more cubes than there are solids (a huge solid, a wide radius) looks at every
// solid instead, so its cost is bounded by the solids in the index. Cube indices are packed into one safe integer
// (17 bits per axis), so the world must stay within ±65,536 cubes of the origin (±2,097 km with the default 32 m).
// Queries allocate nothing: they fill one reused `SolidHit`.
//
// Nothing here knows about streaming: a cell is added and removed by whoever knows it arrived or left (`streamSolids`
// of runtime does it for a `StreamedWorld`, for one level of its quadtree).

import type { InstanceSolid } from '../base/data.ts';
import { detSinCos } from '../base/trig.ts';
import { squareToUp, upFrame } from '../base/up.ts';
import type { CellContent, CellId, WorldPos, WorldShape } from '../gen-core/cell.ts';
import { cellKey } from '../gen-core/cell.ts';

export interface SolidIndexOptions {
  /** The solid of each archetype; instances of an archetype not named here are not solid. */
  solids: Readonly<Record<string, InstanceSolid>>;
  /** Where a cell's origin lies in world metres (the world shape the cells were built for). */
  shape: Pick<WorldShape, 'origin'>;
  /** The point a `'radial'` up points away from (a sphere's centre). Required when a solid stands radially. */
  center?: readonly [number, number, number];
  /** Edge of a cube of the spatial hash, metres. Default 32. */
  bucketM?: number;
  /**
   * Says whether an instance is solid, after its descriptor: the archetype, the cell's instance floats and the float
   * offset of the instance in them. Default: every instance with a size.
   */
  keep?: (archetype: string, data: Float32Array, offset: number) => boolean;
}

/** One solid as `SolidIndex` hands it out. One object is reused for every hit of a call: copy what you keep. */
export interface SolidHit {
  /** Index of the entry; valid until its cell is removed (`SolidIndex.get`). */
  slot: number;
  /** Base point in world metres (double). */
  x: number;
  y: number;
  z: number;
  /** Unit up the solid stands along. */
  upX: number;
  upY: number;
  upZ: number;
  /** Reach round the axis, metres (a box: half its diagonal). */
  radius: number;
  /** Height of the top above the base point, and depth of the bottom under it, metres. */
  height: number;
  below: number;
  /** A box: half extents along its own x and z (0 and 0 for a cylinder) and its own +x as a unit world direction. */
  halfX: number;
  halfZ: number;
  axisX: number;
  axisY: number;
  axisZ: number;
  standable: boolean;
  blocksSight: boolean;
  /** Distance from the query point to the solid's axis less its radius (negative inside); 0 when no point was given. */
  distance: number;
  archetype: string;
  /** The instance's id as [high, low] halves (`CellInstances.ids`); 0, 0 when the cell has none. */
  idHigh: number;
  idLow: number;
  /** The cell it came with and its index in the cell's instances of that archetype. */
  cell: CellId;
  instance: number;
}

/** A fresh `SolidHit` (allocate once, reuse). */
export function newSolidHit(): SolidHit {
  return {
    slot: -1, x: 0, y: 0, z: 0, upX: 0, upY: 1, upZ: 0, radius: 0, height: 0, below: 0, halfX: 0, halfZ: 0, axisX: 1, axisY: 0, axisZ: 0,
    standable: true, blocksSight: true, distance: 0, archetype: '', idHigh: 0, idLow: 0, cell: { face: 0, level: 0, x: 0, y: 0 }, instance: -1,
  };
}

/** Told when a cell's solids enter the index (`added` true, after) or leave it (`added` false, before they go). */
export type SolidCellListener = (cell: CellId, added: boolean) => void;

const F_STANDABLE = 1;
const F_SIGHT = 2;
const F_LIVE = 4;
/** Cube indices are offset into a positive range of 17 bits per axis: 51 bits, an exact integer. */
const OFFSET = 1 << 16;
const SPAN = 1 << 17;
/** Numbers per entry in `num`: base x, y, z, up x, y, z, axis x, y, z, radius, height, below, half x, half z. */
const NUM = 14;

interface CellEntry {
  cell: CellId;
  slots: number[];
}

export class SolidIndex {
  readonly bucketM: number;
  private readonly solids: Readonly<Record<string, InstanceSolid>>;
  private readonly shape: Pick<WorldShape, 'origin'>;
  private readonly center: readonly [number, number, number] | null;
  private readonly keep: SolidIndexOptions['keep'];

  // One entry per slot (struct of arrays); free slots are reused.
  private num = new Float64Array(64 * NUM);
  private flag = new Uint8Array(64);
  private ids = new Uint32Array(128);
  private inst = new Int32Array(64);
  private bucketOf = new Float64Array(64);
  private readonly arch: string[] = [];
  private readonly cellOf: (CellEntry | null)[] = [];
  private readonly free: number[] = [];
  private used = 0;
  private live = 0;
  /** Largest reach of a solid's axis middle to its farthest point (radius plus half the axis), metres. */
  private reach = 0;
  /** The solid that set `reach` left: worked out again from the live solids before the next query. */
  private reachStale = false;

  private readonly buckets = new Map<number, number[]>();
  private readonly cells = new Map<string, CellEntry>();
  /** Replaced, never changed in place, so a listener that stops itself (or another) during a notification skips no one. */
  private listeners: readonly SolidCellListener[] = [];
  private readonly hit: SolidHit = newSolidHit();
  private readonly sc: [number, number] = [0, 0];

  constructor(options: SolidIndexOptions) {
    this.solids = options.solids;
    this.shape = options.shape;
    this.center = options.center ? [options.center[0], options.center[1], options.center[2]] : null;
    this.keep = options.keep;
    this.bucketM = options.bucketM ?? 32;
    if (!(this.bucketM > 0)) throw new Error('SolidIndex: bucketM must be positive');
    for (const [name, s] of Object.entries(this.solids)) {
      if (s.up === 'radial' && !this.center) throw new Error(`SolidIndex: archetype "${name}" stands radially but no center is given`);
    }
  }

  /** Solids in the index. */
  get solidCount(): number {
    return this.live;
  }

  /** Cells in the index (a cell without solids counts too). */
  get cellCount(): number {
    return this.cells.size;
  }

  hasCell(cell: CellId): boolean {
    return this.cells.has(cellKey(cell));
  }

  /**
   * Adds the solids of a cell's instances; a cell already in the index is replaced (new content of the same cell).
   * Returns the number of solids added. All or nothing: a layout whose stride is not a positive whole number of floats,
   * or a solid outside the range of the hash, throws, and the index (with the cell's earlier content, if any) is left
   * as it was.
   */
  addCell(content: CellContent): number {
    const cell = content.cell;
    const key = cellKey(cell);
    for (const set of content.instances) {
      if (!this.solids[set.archetype]) continue;
      const stride = set.data.layout.stride / 4;
      if (!(Number.isInteger(stride) && stride > 0)) throw new Error(`SolidIndex: the instances of "${set.archetype}" have a stride of ${set.data.layout.stride} bytes; it must be a positive multiple of 4`);
    }
    const entry: CellEntry = { cell, slots: [] };
    const o = this.shape.origin(cell);
    try {
      for (const set of content.instances) {
        const s = this.solids[set.archetype];
        if (!s) continue;
        this.readSet(entry, o, set.archetype, s, set.data.data, set.data.layout.stride / 4, set.ids);
      }
    } catch (e) {
      for (const slot of entry.slots) this.drop(slot);
      throw e;
    }
    if (this.cells.has(key)) this.removeCell(cell);
    this.cells.set(key, entry);
    const ls = this.listeners;
    for (let i = 0; i < ls.length; i++) ls[i]!(cell, true);
    return entry.slots.length;
  }

  /** Removes the solids of a cell; a cell not in the index is ignored. */
  removeCell(cell: CellId): void {
    const key = cellKey(cell);
    const entry = this.cells.get(key);
    if (!entry) return;
    const ls = this.listeners;
    for (let i = 0; i < ls.length; i++) ls[i]!(cell, false);
    for (const slot of entry.slots) this.drop(slot);
    this.cells.delete(key);
  }

  /** Removes everything. */
  clear(): void {
    for (const e of [...this.cells.values()]) this.removeCell(e.cell);
  }

  /**
   * Calls `listener` whenever a cell's solids enter or leave the index. Returns the function that stops it. A listener
   * added or stopped while the listeners are being told takes effect from the next notification.
   */
  listen(listener: SolidCellListener): () => void {
    this.listeners = [...this.listeners, listener];
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners = this.listeners.filter((_, k) => k !== i);
    };
  }

  /**
   * Visits every solid whose axis (from `below` under the base to `height` above it, along its up) comes within
   * `radius` + its own radius of the point, in world metres (`Infinity`: every solid, cell by cell). `hit.distance` is the distance to the axis less the
   * solid's radius. Returns the number visited. Allocates nothing; `visit` gets the same object every time and must not
   * call `within` or `forEachOfCell` of this index.
   */
  within(point: readonly [number, number, number], radius: number, visit: (hit: SolidHit) => void): number {
    if (this.live === 0) return 0;
    if (this.reachStale) this.findReach();
    const px = point[0];
    const py = point[1];
    const pz = point[2];
    const r = radius > 0 ? radius : 0;
    const g = r + this.reach;
    const s = this.bucketM;
    // A box of more cubes than there are solids (or one wider than the hash): every solid is a candidate.
    const side = Math.floor((px + g) / s) - Math.floor((px - g) / s) + 1;
    const across = (Math.floor((py + g) / s) - Math.floor((py - g) / s) + 1) * (Math.floor((pz + g) / s) - Math.floor((pz - g) / s) + 1);
    if (!(g / s < SPAN) || !(side * across <= this.live)) {
      let n = 0;
      for (const entry of this.cells.values()) {
        for (const slot of entry.slots) {
          const d = this.axisDistance(slot, px, py, pz);
          if (d > r) continue;
          this.fill(slot, d);
          n++;
          visit(this.hit);
        }
      }
      return n;
    }
    const i0 = Math.floor((px - g) / s);
    const i1 = Math.floor((px + g) / s);
    const j0 = Math.floor((py - g) / s);
    const j1 = Math.floor((py + g) / s);
    const k0 = Math.floor((pz - g) / s);
    const k1 = Math.floor((pz + g) / s);
    let n = 0;
    for (let i = i0; i <= i1; i++) {
      if (i < -OFFSET || i >= OFFSET) continue;
      for (let j = j0; j <= j1; j++) {
        if (j < -OFFSET || j >= OFFSET) continue;
        for (let k = k0; k <= k1; k++) {
          if (k < -OFFSET || k >= OFFSET) continue;
          const list = this.buckets.get(((i + OFFSET) * SPAN + (j + OFFSET)) * SPAN + (k + OFFSET));
          if (!list) continue;
          for (let q = 0; q < list.length; q++) {
            const slot = list[q]!;
            const d = this.axisDistance(slot, px, py, pz);
            if (d > r) continue;
            this.fill(slot, d);
            n++;
            visit(this.hit);
          }
        }
      }
    }
    return n;
  }

  /**
   * Visits the solids of one cell in the order they were read; with `point`, `hit.distance` is measured from it.
   * Returns the number visited (0 for a cell not in the index). The same rules for `visit` as for `within`.
   */
  forEachOfCell(cell: CellId, visit: (hit: SolidHit) => void, point?: readonly [number, number, number]): number {
    const entry = this.cells.get(cellKey(cell));
    if (!entry) return 0;
    for (const slot of entry.slots) {
      this.fill(slot, point ? this.axisDistance(slot, point[0], point[1], point[2]) : 0);
      visit(this.hit);
    }
    return entry.slots.length;
  }

  /** The solid in `slot` written into `out` (distance 0); false for a free slot. */
  get(slot: number, out: SolidHit): boolean {
    if (!(slot >= 0 && slot < this.used) || (this.flag[slot]! & F_LIVE) === 0) return false;
    this.fill(slot, 0, out);
    return true;
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  /** Reads the solids of one set of instances into `entry`. */
  private readSet(entry: CellEntry, o: WorldPos, archetype: string, s: InstanceSolid, data: Float32Array, stride: number, ids: Uint32Array): void {
    const count = Math.floor(data.length / stride);
    const radial = s.up === 'radial';
    const c = this.center;
    const rs = s.radiusScale ?? 1;
    const hs = s.heightScale ?? 1;
    const below = s.belowM ?? 0;
    const minR = s.minRadiusM ?? 0;
    const flags = F_LIVE | ((s.standable ?? true) ? F_STANDABLE : 0) | ((s.blocksSight ?? true) ? F_SIGHT : 0);
    const box = s.box;
    const bs = box?.scale ?? 0.5;
    for (let i = 0; i < count; i++) {
      const b = i * stride;
      if (this.keep && !this.keep(archetype, data, b)) continue;
      let radius = (s.radius !== undefined ? data[b + s.radius]! : (s.radiusM ?? 0)) * rs;
      const height = (s.height !== undefined ? data[b + s.height]! : (s.heightM ?? 0)) * hs;
      let halfX = 0;
      let halfZ = 0;
      let turn = 0;
      if (box) {
        const sx = data[b + box.sizeX]!;
        const szRaw = box.sizeZ !== undefined ? data[b + box.sizeZ]! : 0;
        halfX = sx * bs;
        halfZ = (szRaw !== 0 ? szRaw : sx) * bs;
        turn = data[b + box.turn]!;
        if (!(halfX > 0 && halfZ > 0) || Math.min(halfX, halfZ) < minR) continue;
        radius = Math.sqrt(halfX * halfX + halfZ * halfZ);
      } else if (!(radius > 0) || radius < minR) continue;
      if (!(height + below > 0)) continue;
      const x = o[0] + data[b + s.position]!;
      const y = o[1] + data[b + s.position + 1]!;
      const z = o[2] + data[b + s.position + 2]!;
      let ux = 0;
      let uy = 1;
      let uz = 0;
      if (radial) {
        const vx = x - c![0];
        const vy = y - c![1];
        const vz = z - c![2];
        const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (l > 0) {
          ux = vx / l;
          uy = vy / l;
          uz = vz / l;
        }
      }
      // The box's own +x: (cos turn, −sin turn) in the local frame of up.
      let ax = 1;
      let ay = 0;
      let az = 0;
      if (box) {
        const sc = detSinCos(turn, this.sc);
        const st = sc[0];
        const ct = sc[1];
        if (radial) {
          const f = upFrame([ux, uy, uz]);
          // Near −y the frame's axes are fixed whatever up leans to: the axis is made square to up there.
          const t = squareToUp([ux, uy, uz], [f.x[0] * ct - f.z[0] * st, f.x[1] * ct - f.z[1] * st, f.x[2] * ct - f.z[2] * st]);
          ax = t[0]!;
          ay = t[1]!;
          az = t[2]!;
        } else {
          ax = ct;
          az = -st;
        }
      }
      // The middle of the axis decides the cube (worked out first: a solid out of range throws before a slot is taken).
      const mid = (height - below) / 2;
      const key = this.bucketKey(x + ux * mid, y + uy * mid, z + uz * mid);
      const slot = this.alloc();
      const p = slot * NUM;
      const m = this.num;
      m[p] = x;
      m[p + 1] = y;
      m[p + 2] = z;
      m[p + 3] = ux;
      m[p + 4] = uy;
      m[p + 5] = uz;
      m[p + 6] = ax;
      m[p + 7] = ay;
      m[p + 8] = az;
      m[p + 9] = radius;
      m[p + 10] = height;
      m[p + 11] = below;
      m[p + 12] = halfX;
      m[p + 13] = halfZ;
      this.flag[slot] = flags;
      this.ids[slot * 2] = ids.length >= (i + 1) * 2 ? ids[i * 2]! : 0;
      this.ids[slot * 2 + 1] = ids.length >= (i + 1) * 2 ? ids[i * 2 + 1]! : 0;
      this.inst[slot] = i;
      this.arch[slot] = archetype;
      this.cellOf[slot] = entry;
      const half = (height + below) / 2;
      const reach = radius + half;
      if (reach > this.reach) this.reach = reach;
      this.bucketOf[slot] = key;
      let list = this.buckets.get(key);
      if (!list) {
        list = [];
        this.buckets.set(key, list);
      }
      list.push(slot);
      entry.slots.push(slot);
      this.live++;
    }
  }

  private bucketKey(x: number, y: number, z: number): number {
    const s = this.bucketM;
    const i = Math.floor(x / s);
    const j = Math.floor(y / s);
    const k = Math.floor(z / s);
    if (i < -OFFSET || i >= OFFSET || j < -OFFSET || j >= OFFSET || k < -OFFSET || k >= OFFSET) {
      throw new Error(`SolidIndex: a solid at (${x}, ${y}, ${z}) lies outside the range of the hash (±${OFFSET * s} m)`);
    }
    return ((i + OFFSET) * SPAN + (j + OFFSET)) * SPAN + (k + OFFSET);
  }

  private alloc(): number {
    const f = this.free.pop();
    if (f !== undefined) return f;
    const slot = this.used++;
    if (slot >= this.flag.length) {
      const cap = this.flag.length * 2;
      const grow = <T extends Float64Array | Uint8Array | Uint32Array | Int32Array>(a: T, n: number): T => {
        const b = new (a.constructor as new (n: number) => T)(n);
        b.set(a);
        return b;
      };
      this.num = grow(this.num, cap * NUM);
      this.flag = grow(this.flag, cap);
      this.ids = grow(this.ids, cap * 2);
      this.inst = grow(this.inst, cap);
      this.bucketOf = grow(this.bucketOf, cap);
    }
    this.arch.push('');
    this.cellOf.push(null);
    return slot;
  }

  private drop(slot: number): void {
    if (this.reachOf(slot) >= this.reach) this.reachStale = true;
    const key = this.bucketOf[slot]!;
    const list = this.buckets.get(key);
    if (list) {
      const at = list.indexOf(slot);
      if (at >= 0) {
        // Order inside a cube does not matter: the last one takes the gap.
        list[at] = list[list.length - 1]!;
        list.pop();
      }
      if (list.length === 0) this.buckets.delete(key);
    }
    this.flag[slot] = 0;
    this.arch[slot] = '';
    this.cellOf[slot] = null;
    this.free.push(slot);
    this.live--;
  }

  /** Reach of a solid's axis middle to its farthest point: its radius plus half its axis. */
  private reachOf(slot: number): number {
    const m = this.num;
    const p = slot * NUM;
    return m[p + 9]! + (m[p + 10]! + m[p + 11]!) / 2;
  }

  /** `reach` worked out again from the live solids (after the one that set it left). */
  private findReach(): void {
    let most = 0;
    for (let slot = 0; slot < this.used; slot++) {
      if ((this.flag[slot]! & F_LIVE) === 0) continue;
      const r = this.reachOf(slot);
      if (r > most) most = r;
    }
    this.reach = most;
    this.reachStale = false;
  }

  /** Distance from a point to the solid's axis segment, less its radius. */
  private axisDistance(slot: number, px: number, py: number, pz: number): number {
    const m = this.num;
    const p = slot * NUM;
    const ux = m[p + 3]!;
    const uy = m[p + 4]!;
    const uz = m[p + 5]!;
    const dx = px - m[p]!;
    const dy = py - m[p + 1]!;
    const dz = pz - m[p + 2]!;
    let t = dx * ux + dy * uy + dz * uz;
    const top = m[p + 10]!;
    const bottom = -m[p + 11]!;
    t = t < bottom ? bottom : t > top ? top : t;
    const ex = dx - ux * t;
    const ey = dy - uy * t;
    const ez = dz - uz * t;
    return Math.sqrt(ex * ex + ey * ey + ez * ez) - m[p + 9]!;
  }

  private fill(slot: number, distance: number, out: SolidHit = this.hit): void {
    const m = this.num;
    const p = slot * NUM;
    const f = this.flag[slot]!;
    out.slot = slot;
    out.x = m[p]!;
    out.y = m[p + 1]!;
    out.z = m[p + 2]!;
    out.upX = m[p + 3]!;
    out.upY = m[p + 4]!;
    out.upZ = m[p + 5]!;
    out.axisX = m[p + 6]!;
    out.axisY = m[p + 7]!;
    out.axisZ = m[p + 8]!;
    out.radius = m[p + 9]!;
    out.height = m[p + 10]!;
    out.below = m[p + 11]!;
    out.halfX = m[p + 12]!;
    out.halfZ = m[p + 13]!;
    out.standable = (f & F_STANDABLE) !== 0;
    out.blocksSight = (f & F_SIGHT) !== 0;
    out.distance = distance;
    out.archetype = this.arch[slot]!;
    out.idHigh = this.ids[slot * 2]!;
    out.idLow = this.ids[slot * 2 + 1]!;
    out.cell = this.cellOf[slot]!.cell;
    out.instance = this.inst[slot]!;
  }
}
