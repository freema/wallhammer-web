// Paths entities move along: a polyline in metres with an optional speed limit and lane per segment and stops at
// vertices. Inside, a path is integer millimetres (segment starts, limits in mm per tick, dwell in ticks), so moving
// along it is exact. A path set is simulation state: paths created at run time (routes) are saved in snapshots.

import { ByteReader, ByteWriter } from './bytes.ts';
import { lengthMm, mmPerTick, snapMm } from './fixed.ts';
import type { SimState } from './simulation.ts';

export interface PathStop {
  /** Vertex index the stop sits at. */
  vertex: number;
  /** Seconds to stay. */
  dwell: number;
}

/** A path as the app describes it. */
export interface PathDef {
  /** Vertices as x, z pairs in metres. */
  points: readonly number[];
  /** A loop returns from the last vertex to the first and starts over. */
  loop?: boolean;
  /** Speed limit per segment in m/s; 0 or missing = no limit. */
  speeds?: readonly number[];
  /**
   * Lane key per segment (≥ 0), e.g. a graph edge. Entities on the same lane keep their distance (collision `follow`).
   * Missing = the segment has a lane of its own, shared only by entities on this same path.
   */
  lanes?: readonly number[];
  stops?: readonly PathStop[];
}

/** A built path: integer millimetres and ticks. */
export interface Path {
  readonly id: number;
  readonly loop: boolean;
  /** Vertices in metres (for extraction). */
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly segments: number;
  /** Start of each segment along the path in mm; `segStart[segments]` is the length. */
  readonly segStart: Int32Array;
  /** Speed limit per segment in mm per tick, 0 = none. */
  readonly segLimit: Int32Array;
  /** Lane key per segment. */
  readonly segLane: Float64Array;
  /**
   * Where each segment starts along its lane, mm: the start point projected on the segment's direction. Paths that
   * share a straight lane but enter it at different points (corners cut differently) measure positions on it alike.
   */
  readonly segOrigin: Int32Array;
  /** Stops along the path in mm (ascending) and their dwell in ticks. */
  readonly stopAt: Int32Array;
  readonly stopDwell: Int32Array;
  /** Freed automatically when its single user leaves it. */
  readonly owned: boolean;
  readonly length: number;
}

interface Stored {
  points: Float64Array;
  loop: boolean;
  limits: Int32Array;
  lanes: Float64Array;
  stopVertex: Int32Array;
  stopDwell: Int32Array;
  owned: boolean;
}

const PRIVATE_LANE_SPAN = 2 ** 20;

export class PathSet implements SimState {
  readonly name: string;
  readonly hz: number;
  private readonly paths = new Map<number, Path>();
  private readonly stored = new Map<number, Stored>();
  private nextId = 1;

  constructor(name: string, hz: number) {
    this.name = name;
    this.hz = hz;
  }

  get size(): number {
    return this.paths.size;
  }

  /** Adds a path and returns its id (ids count up and are never reused). */
  add(def: PathDef, options: { owned?: boolean } = {}): number {
    const n = def.points.length / 2;
    if (n < 2 || !Number.isInteger(n)) throw new Error('PathSet: a path needs at least two x, z points');
    const segments = def.loop ? n : n - 1;
    const id = this.nextId++;
    const lanes = new Float64Array(segments);
    for (let s = 0; s < segments; s++) {
      const lane = def.lanes?.[s];
      lanes[s] = lane !== undefined && lane >= 0 ? lane : -(id * PRIVATE_LANE_SPAN + s + 1);
    }
    const stops = [...(def.stops ?? [])].sort((a, b) => a.vertex - b.vertex);
    const st: Stored = {
      // Quantised at the boundary: points to whole millimetres (speeds become whole mm per tick below).
      points: Float64Array.from(def.points, snapMm),
      loop: def.loop ?? false,
      limits: Int32Array.from({ length: segments }, (_, s) => mmPerTick(snapMm(def.speeds?.[s] ?? 0), this.hz)),
      lanes,
      stopVertex: Int32Array.from(stops, (s) => s.vertex),
      stopDwell: Int32Array.from(stops, (s) => Math.round(s.dwell * this.hz)),
      owned: options.owned ?? false,
    };
    this.put(id, st);
    return id;
  }

  private put(id: number, st: Stored): void {
    const n = st.points.length / 2;
    const segments = st.loop ? n : n - 1;
    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = st.points[i * 2]!;
      zs[i] = st.points[i * 2 + 1]!;
    }
    const segStart = new Int32Array(segments + 1);
    for (let s = 0; s < segments; s++) {
      const b = (s + 1) % n;
      segStart[s + 1] = segStart[s]! + Math.max(1, lengthMm((xs[b]! - xs[s]!) * 1000, (zs[b]! - zs[s]!) * 1000));
    }
    const segOrigin = new Int32Array(segments);
    for (let s = 0; s < segments; s++) {
      const b = (s + 1) % n;
      const dx = xs[b]! - xs[s]!;
      const dz = zs[b]! - zs[s]!;
      const l = Math.sqrt(dx * dx + dz * dz);
      segOrigin[s] = l > 0 ? Math.round(((xs[s]! * dx + zs[s]! * dz) / l) * 1000) : 0;
    }
    const stopAt = new Int32Array(st.stopVertex.length);
    for (let k = 0; k < stopAt.length; k++) {
      const v = st.stopVertex[k]!;
      if (v < 0 || v > segments) throw new Error(`PathSet: stop at vertex ${v} outside the path`);
      stopAt[k] = st.loop && v === n ? 0 : segStart[v]!;
    }
    this.stored.set(id, st);
    this.paths.set(id, { id, loop: st.loop, xs, zs, segments, segStart, segLimit: st.limits, segLane: st.lanes, segOrigin, stopAt, stopDwell: st.stopDwell, owned: st.owned, length: segStart[segments]! });
  }

  get(id: number): Path {
    const p = this.paths.get(id);
    if (!p) throw new Error(`PathSet: no path ${id}`);
    return p;
  }

  has(id: number): boolean {
    return this.paths.has(id);
  }

  release(id: number): void {
    this.paths.delete(id);
    this.stored.delete(id);
  }

  /** Point at a distance (mm, may be fractional) along a path, in metres. Distances outside wrap (loop) or clamp. */
  pointAt(p: Path, d: number, out: [number, number]): void {
    const len = p.length;
    if (p.loop) d = ((d % len) + len) % len;
    else d = Math.min(len, Math.max(0, d));
    let lo = 0;
    let hi = p.segments - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p.segStart[mid]! <= d) lo = mid;
      else hi = mid - 1;
    }
    const a = lo;
    const b = (lo + 1) % p.xs.length;
    const s0 = p.segStart[lo]!;
    const t = (d - s0) / (p.segStart[lo + 1]! - s0);
    out[0] = p.xs[a]! + (p.xs[b]! - p.xs[a]!) * t;
    out[1] = p.zs[a]! + (p.zs[b]! - p.zs[a]!) * t;
  }

  /**
   * Position, heading and curvature at a distance along a path (mm), for extraction: `out` gets x, z (metres), the
   * unit direction x, z taken between the points `look` mm behind and ahead, and the signed curvature in 1/m
   * (positive bends right, clockwise seen from above). A trailing segment of a rig uses the same call a fixed
   * distance further back.
   */
  frameAt(p: Path, d: number, look: number, out: Float64Array): void {
    const a = this.fa;
    const b = this.fb;
    const m = this.fm;
    this.pointAt(p, d, m);
    this.pointAt(p, d - look, a);
    this.pointAt(p, d + look, b);
    out[0] = m[0];
    out[1] = m[1];
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l > 1e-6) {
      dx /= l;
      dz /= l;
    } else {
      dx = 0;
      dz = -1;
    }
    out[2] = dx;
    out[3] = dz;
    // Turn between the chord behind and the chord ahead: 2·tan(θ/2) = 2·cross / (1 + dot) for unit chords, close to
    // θ for the small angles a short look gives. Over the look distance it is the curvature.
    const ux = m[0] - a[0], uz = m[1] - a[1];
    const vx = b[0] - m[0], vz = b[1] - m[1];
    const lu = Math.sqrt(ux * ux + uz * uz);
    const lv = Math.sqrt(vx * vx + vz * vz);
    if (lu < 1e-6 || lv < 1e-6) {
      out[4] = 0;
      return;
    }
    const cross = (ux * vz - uz * vx) / (lu * lv);
    const dot = (ux * vx + uz * vz) / (lu * lv);
    out[4] = dot > -0.99 ? (2 * cross) / (1 + dot) / ((lu + lv) * 0.5) : 0;
  }

  private readonly fa: [number, number] = [0, 0];
  private readonly fb: [number, number] = [0, 0];
  private readonly fm: [number, number] = [0, 0];

  save(w: ByteWriter): void {
    w.u32(this.nextId);
    w.u32(this.stored.size);
    for (const [id, st] of this.stored) {
      w.u32(id);
      w.u8((st.loop ? 1 : 0) | (st.owned ? 2 : 0));
      for (const a of [st.points, st.limits, st.lanes, st.stopVertex, st.stopDwell]) {
        w.u32(a.length);
        w.bytes(a);
      }
    }
  }

  load(r: ByteReader): void {
    this.paths.clear();
    this.stored.clear();
    this.nextId = r.u32();
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const id = r.u32();
      const flags = r.u8();
      const f64 = (): Float64Array => {
        const a = new Float64Array(r.u32());
        r.into(a);
        return a;
      };
      const i32 = (): Int32Array => {
        const a = new Int32Array(r.u32());
        r.into(a);
        return a;
      };
      const points = f64();
      const limits = i32();
      const lanes = f64();
      const stopVertex = i32();
      const stopDwell = i32();
      this.put(id, { points, loop: (flags & 1) !== 0, owned: (flags & 2) !== 0, limits, lanes, stopVertex, stopDwell });
    }
  }
}
