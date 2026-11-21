// Small instances round the eye on a sphere, streamed by square: which squares of a `NearSquareGrid` are wanted, the
// jobs that make their records (on a worker pool or on the main thread), the squares dropped behind the eye, the gain
// that lets the instances come in from the eye outward, and the `NearInstanceLayer` that draws them.
//
// The content stays with the caller: the shapes and the material of the kinds, and the function that makes a square's
// records (usually `nearScatter` over a lattice of the ground). Kinds are made in groups, one job per square and group,
// each group with its own reach; a group's gain rises by at most `rise` a frame toward the share of its reach the
// nearest missing square leaves free, so instances never pop in round the eye.

import type { MaterialDesc, Vec3 } from '../base/index.ts';
import { NEAR_FLOATS } from '../gen-core/index.ts';
import type { NearSquare, NearSquareGrid } from '../gen-core/index.ts';
import type { WorkerJob, WorkerPool } from '../platform/index.ts';
import { NearInstanceLayer } from '../render/index.ts';
import type { Layer, NearKindDraw, Renderer } from '../render/index.ts';

/** The records of one square and group: what a job gives back. */
export interface NearDetailReply {
  /** Point the records are relative to (from the sphere's centre, or in the world without `center`). */
  anchor: Vec3;
  /** A sphere round the anchor that holds every record. */
  radiusM: number;
  /** Per kind the first record, kinds + 1 entries (`NearRecords.start`). */
  start: Uint32Array;
  data: Float32Array;
}

/** Kinds made by one job per square, with one reach. */
export interface NearDetailGroup {
  /** Bits of the kinds, handed to `generate` and `job`. */
  mask: number;
  kinds: readonly number[];
  /** Metres round the eye's foot the group is wanted in. */
  reachM: number;
}

export interface NearDetailStreamOptions {
  renderer: Renderer;
  material: MaterialDesc;
  /** The kinds' meshes, fades, ceilings and bend heights, by kind index. */
  kinds: readonly NearKindDraw[];
  /** The layer is drawn before this one. */
  before: Layer;
  /** World position of the render origin (doubles). Default the renderer's `worldOrigin`. */
  origin?: () => readonly [number, number, number];
  grid: NearSquareGrid;
  groups: readonly NearDetailGroup[];
  /** Above this height of the eye over the ground there are none. */
  offM: number;
  /** Centre of the sphere in the world, added to every anchor (default none: the anchors are world points). */
  center?: readonly [number, number, number];
  /** Makes a square's records on the main thread, when there is no pool. */
  generate(square: NearSquare, mask: number): NearDetailReply;
  /** Workers whose reply to `job(square, mask)` is a `NearDetailReply` (default none: the main thread). */
  pool?: WorkerPool | null;
  /** The message posted to the pool for a square. */
  job?(square: NearSquare, mask: number): unknown;
  /** Start a job only on an idle worker with nothing waiting (default false: up to `inFlight` jobs at once). */
  idleWorkersOnly?: boolean;
  /** Called when a job has placed its records, and with `invalidatePending` in every frame with work left. */
  invalidate?(): void;
  invalidatePending?: boolean;
  /** Metres beyond a group's reach that are wanted (default 25) and beyond which a square is dropped (default 60). */
  wantM?: number;
  dropM?: number;
  /** Jobs on the pool at once (default 2). */
  inFlight?: number;
  /** Rise of a gain per frame at most (default 0.04). */
  rise?: number;
  /** A square nearer than this counts as at the eye in the gain (default 10 m). */
  nearM?: number;
  /** Wall clock of `rebuildMs` (ms). Default `performance.now`. */
  now?: () => number;
}

/** A frame of the stream. */
export interface NearDetailFrame {
  /** World position of the eye, or null when the details are off for the frame (nothing is kept). */
  eye: Vec3 | null;
  /** Unit direction from the sphere's centre to the eye. */
  dir: Vec3;
  /** Height of the eye above the ground, m. */
  heightM: number;
  /** Time of the world, s; a jump of more than a second leaves out the travelling waves of the wind for the frame. */
  timeS: number;
  /** Unit direction of the wind along the ground and its strength 0–1. */
  windDir: Vec3;
  windStrength: number;
  /** Factor 0–1 on every group's target gain (default 1). */
  lift?: number;
}

export interface NearDetailStats {
  /** Squares there, every group. */
  squares: number;
  /** Records held, sent to the GPU and left out by the ceiling. */
  held: number;
  drawn: number;
  clipped: number;
  /** Jobs started since the start (on the main thread: squares made). */
  jobs: number;
  /** Gain of each group. */
  gains: number[];
  /** Milliseconds of the last rebuild of the buffers. */
  rebuildMs: number;
  /** Squares whose job failed. */
  failed: number;
}

interface Entry {
  square: NearSquare;
  /** 'ready' also for a square that failed: it is not asked again and does not hold the gain down. */
  state: 'queued' | 'running' | 'ready';
  job: WorkerJob<NearDetailReply> | null;
}

/** Small instances round the eye on a sphere, streamed by square and drawn by a `NearInstanceLayer`. */
export class NearDetailStream {
  readonly layer: NearInstanceLayer;
  private readonly o: NearDetailStreamOptions;
  private readonly entries: Map<string, Entry>[];
  private readonly gains: number[];
  private readonly targets: number[];
  private readonly wanted: NearSquare[][];
  private readonly groupOfKind: number[];
  private readonly scratch: NearSquare[] = [];
  private readonly now: () => number;
  private inFlight = 0;
  private jobs = 0;
  private failed = 0;
  private rebuildMs = 0;
  private lastTime: number | null = null;
  private disposed = false;

  constructor(o: NearDetailStreamOptions) {
    this.o = o;
    const renderer = o.renderer;
    this.layer = new NearInstanceLayer(renderer.device, {
      material: renderer.material(o.material),
      kinds: o.kinds,
      origin: o.origin ?? ((): readonly [number, number, number] => renderer.worldOrigin),
    });
    renderer.addBefore(this.layer, o.before);
    this.entries = o.groups.map(() => new Map());
    this.gains = o.groups.map(() => 0);
    this.targets = o.groups.map(() => 0);
    this.wanted = o.groups.map(() => []);
    this.groupOfKind = o.kinds.map((_, k) => o.groups.findIndex((g) => g.kinds.includes(k)));
    this.now = o.now ?? ((): number => performance.now());
  }

  private place(g: number, s: NearSquare, r: NearDetailReply): void {
    const key = this.o.grid.key(s);
    const c = this.o.center;
    const anchor: Vec3 = c ? [r.anchor[0] + c[0], r.anchor[1] + c[1], r.anchor[2] + c[2]] : r.anchor;
    for (const k of this.o.groups[g]!.kinds) {
      const from = r.start[k]!;
      const to = r.start[k + 1]!;
      this.layer.put(key, k, to > from ? { anchor, radiusM: r.radiusM, data: r.data.subarray(from * NEAR_FLOATS, to * NEAR_FLOATS) } : null);
    }
  }

  private drop(g: number, key: string): void {
    const e = this.entries[g]!.get(key);
    if (!e) return;
    if (e.job) {
      e.job.cancel();
      e.job = null;
      if (e.state === 'running') this.inFlight--;
    }
    this.entries[g]!.delete(key);
    for (const k of this.o.groups[g]!.kinds) this.layer.put(key, k, null);
  }

  private dropAll(): void {
    for (let g = 0; g < this.o.groups.length; g++) for (const key of [...this.entries[g]!.keys()]) this.drop(g, key);
  }

  private start(g: number, e: Entry): void {
    const o = this.o;
    const s = e.square;
    const key = o.grid.key(s);
    const mask = o.groups[g]!.mask;
    this.jobs++;
    if (!o.pool) {
      const r = o.generate(s, mask);
      e.state = 'ready';
      this.place(g, s, r);
      return;
    }
    const job = o.pool.run<NearDetailReply>(o.job ? o.job(s, mask) : { face: s.face, i: s.i, j: s.j, mask });
    e.state = 'running';
    e.job = job;
    this.inFlight++;
    job.promise.then(
      (r) => {
        if (this.disposed || this.entries[g]!.get(key) !== e) return;
        this.inFlight--;
        e.job = null;
        e.state = 'ready';
        this.place(g, s, r);
        o.invalidate?.();
      },
      () => {
        if (this.disposed || this.entries[g]!.get(key) !== e) return;
        // Not cancelled by `drop`: the job failed.
        this.inFlight--;
        e.job = null;
        e.state = 'ready';
        this.failed++;
      },
    );
  }

  private view(eye: Vec3): void {
    const layer = this.layer;
    const before = layer.stats.rebuilds;
    const t0 = this.now();
    layer.view(eye, this.groupOfKind.map((g) => this.gains[g] ?? 0));
    if (layer.stats.rebuilds !== before) this.rebuildMs = this.now() - t0;
  }

  private off(eye: Vec3): void {
    this.dropAll();
    for (let g = 0; g < this.o.groups.length; g++) this.gains[g] = this.targets[g] = 0;
    for (const w of this.wanted) w.length = 0;
    this.view(eye);
  }

  /** Once per frame, after the render origin has moved. */
  frame(f: NearDetailFrame): void {
    if (this.disposed) return;
    const o = this.o;
    const jump = this.lastTime === null || Math.abs(f.timeS - this.lastTime) > 1;
    this.lastTime = f.timeS;
    if (!f.eye) {
      this.off([0, 0, 0]);
      return;
    }
    if (f.heightM >= o.offM) {
      this.off(f.eye);
      return;
    }
    const dir = f.dir;
    const grid = o.grid;
    const lift = f.lift ?? 1;
    const wantM = o.wantM ?? 25;
    const dropM = o.dropM ?? 60;
    const nearM = o.nearM ?? 10;
    const rise = o.rise ?? 0.04;
    const missing: { g: number; e: Entry; dist: number }[] = [];
    let pending = false;
    for (let g = 0; g < o.groups.length; g++) {
      const group = o.groups[g]!;
      const map = this.entries[g]!;
      for (const [key, e] of map) if (grid.distanceM(dir, e.square) > group.reachM + dropM) this.drop(g, key);
      const want = grid.near(dir, group.reachM + wantM, this.scratch);
      this.wanted[g] = want.slice();
      let least = 1;
      for (const s of want) {
        const key = grid.key(s);
        let e = map.get(key);
        if (!e) {
          e = { square: s, state: 'queued', job: null };
          map.set(key, e);
        }
        if (e.state === 'ready') continue;
        const dist = grid.distanceM(dir, s);
        least = Math.min(least, Math.min(1, Math.max(0, (dist - nearM) / group.reachM)));
        if (e.state === 'queued') missing.push({ g, e, dist });
      }
      const target = lift * least;
      this.targets[g] = target;
      this.gains[g] = target < this.gains[g]! ? target : Math.min(target, this.gains[g]! + rise);
      if (this.gains[g] !== target) pending = true;
    }
    // Nearest first, ties by group, then as `near` orders them.
    missing.sort((a, b) => a.dist - b.dist || a.g - b.g);
    const pool = o.pool;
    const inFlight = o.inFlight ?? 2;
    const room = pool ? (o.idleWorkersOnly ? (pool.queued === 0 ? Math.min(inFlight - this.inFlight, pool.size - pool.busy) : 0) : inFlight - this.inFlight) : 1;
    for (let n = 0; n < Math.min(room, missing.length); n++) this.start(missing[n]!.g, missing[n]!.e);
    if (o.invalidatePending && (missing.length > 0 || this.inFlight > 0 || pending)) o.invalidate?.();
    this.layer.wind = { dir: f.windDir, strength: f.windStrength, timeS: f.timeS, waves: jump ? 0 : 1 };
    this.view(f.eye);
  }

  /** Every wanted square there, no job in flight and every gain at its target. */
  settled(): boolean {
    if (this.inFlight > 0) return false;
    for (let g = 0; g < this.o.groups.length; g++) {
      if (Math.abs(this.gains[g]! - this.targets[g]!) > 1e-9) return false;
      for (const s of this.wanted[g]!) if (this.entries[g]!.get(this.o.grid.key(s))?.state !== 'ready') return false;
    }
    return true;
  }

  stats(): NearDetailStats {
    let squares = 0;
    for (const map of this.entries) for (const e of map.values()) if (e.state === 'ready') squares++;
    const st = this.layer.stats;
    return { squares, held: st.held, drawn: st.drawn, clipped: st.clipped, jobs: this.jobs, gains: this.gains.slice(), rebuildMs: this.rebuildMs, failed: this.failed };
  }

  /** Drops every square, takes the layer out of the renderer and frees it. */
  dispose(): void {
    this.disposed = true;
    this.dropAll();
    this.o.renderer.remove(this.layer);
    this.layer.dispose();
  }
}
