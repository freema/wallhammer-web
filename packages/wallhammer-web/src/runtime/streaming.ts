// World streaming, the execution part: runs the decisions of `StreamingManager` (module world) once per frame.
// It starts jobs on a provider (workers, files, or the main thread within a time budget), uploads finished cells to
// the GPU within a time budget, releases what the manager drops, and draws the manager's cover as a renderer layer.
// Clocks here decide only *when* work is done, never *what*: the manager's decisions do not see them.
//
// Positions: the authoritative position is a double. The renderer works in a render space whose origin is the
// camera focus snapped to a coarse grid (`originGridM`), so every number the GPU sees is small. Each cell is drawn
// with `u_cellOffset = cell origin − render origin`, computed in double and only then handed to the GPU as floats;
// a large number never reaches the GPU. Because the render origin depends only on where the camera is, the same
// position gives the same image however the camera got there.

import type { MeshData } from '../base/data.ts';
import type { Uniforms } from '../base/material.ts';
import type { Vec3 } from '../base/math.ts';
import type { CullVolume, OriginAxes } from '../base/view.ts';
import { boxInVolume, distanceToBox, snapRenderOrigin } from '../base/view.ts';
import type { CellContent, CellId, WorldPos } from '../gen-core/cell.ts';
import { cellContentBytes, cellKey, shapeHash } from '../gen-core/cell.ts';
import type { InstanceBuffer, Mesh, Texture } from '../gpu/index.ts';
import type { DrawContext, Layer, Material, Renderer } from '../render/index.ts';
import { SHADOW_MAP_UNIT } from '../render/index.ts';
import type { CellProvider, CellRequest, CellResult, StreamingConfig, StreamingCounters, Ticket } from '../world/index.ts';
import { StreamingManager, boxMaxRadius, decodeCell, encodeCell, horizonHidden } from '../world/index.ts';
import type { CellEdits, CellGenerator, EditableCellGenerator } from '../world/index.ts';
import { WorkerPool, serveWorker } from '../platform/index.ts';

/** A shape drawn many times: one material and a level-of-detail chain, finest first. */
export interface StreamArchetype {
  material: string;
  /** Each mesh is used while the cell is at most `maxDistance` metres from the eye; beyond the last, nothing is drawn. */
  lods: readonly { mesh: MeshData; maxDistance: number }[];
}

export interface StreamedWorldOptions {
  renderer: Renderer;
  config: StreamingConfig;
  provider: CellProvider;
  /**
   * Materials by the names cell meshes and archetypes use. Programs read `u_cellOffset` (vec3, cell origin minus
   * render origin) and may read `u_cellLevel` (float, the cell's quadtree level).
   */
  materials: Readonly<Record<string, Material>>;
  archetypes?: Readonly<Record<string, StreamArchetype>>;
  /** Grid the render origin snaps to, in metres. Default 1,024 m. */
  originGridM?: number;
  /**
   * Axes on which the render origin follows the focus. `'horizontal'` (default): x and z, its height stays 0, which
   * is exact enough while the viewer stays within a few kilometres of height 0. `'all'`: the height too, so the
   * numbers the GPU sees stay small at any height (and anywhere round a sphere). Heights handed to anything that
   * works in render space (the view, fog, clouds) then need `origin[1]` subtracted.
   */
  originAxes?: OriginAxes;
  /** Upload time per frame in ms (at least one cell per frame is uploaded). Default 3. */
  uploadMsPerFrame?: number;
  /** Main-thread generation time per frame in ms, for blocking providers (at least one job per frame). Default 6. */
  blockingMsPerFrame?: number;
  /** Called when streaming work wants another frame (a job finished, or more is waiting). */
  onActivity?: () => void;
  /** Wall clock for the budgets only (ms). Default `performance.now`. */
  now?: () => number;
  /**
   * Blend between levels of detail. When on, every program also gets `u_morphEye` (vec4: the viewer in render space
   * and its altitude), `u_morphUp` (vec3) and, per cell, `u_cellMorph` (vec2: where the blend into the parent's shape
   * starts and 1 / its length; 0, 0 for a cell with nothing to blend into). Materials read them through
   * `CELL_MORPH_GLSL` of gen-mesh. Shadows are redrawn when the viewer has moved far enough to change the blend.
   * Default off: none of these uniforms is set.
   */
  morph?: boolean;
  /**
   * Culling by the horizon of a sphere: a cell that the sphere's own bulge hides from the eye is left out of the
   * view's draws (the shadow pass keeps it). `center` is the sphere's centre in world metres. `radiusM` is the radius
   * of the sphere that hides; it must lie under everything that is drawn, so give the base radius plus the lowest
   * height the content has (a larger one cuts holes at the horizon). Uses the eye of `setEye`.
   * Default: unset, no cell is hidden this way.
   */
  horizon?: { center: WorldPos; radiusM: number };
  /**
   * Textures per material name, by sampler name: bound to the units after the shadow map before the material's cells
   * are drawn. The record stays reachable as `StreamedWorld.textures` and may be changed at any time.
   */
  textures?: Record<string, Record<string, Texture | null>>;
  /** Uniforms per material name, set after the shared `uniforms`. Reachable as `StreamedWorld.materialUniforms`. */
  materialUniforms?: Record<string, Uniforms>;
  /**
   * Ceiling of GPU memory in bytes, measured on the device (`Device.memory().total`: everything the page holds, not
   * only the cells). Over it, the manager takes cells off the GPU, least recently wanted first, and holds uploads
   * back (`StreamingConfig.gpuBudgetBytes`, which this sets). Default off.
   */
  gpuCeilingBytes?: number;
  /** A cell was uploaded: its meshes on the GPU in the order of `content.meshes`. */
  onResident?: (cell: CellId, meshes: readonly { material: Material; mesh: Mesh }[], content: CellContent) => void;
  /** A cell left the GPU (its meshes are deleted). */
  onReleased?: (cell: CellId) => void;
}

interface GpuCell {
  cell: CellId;
  key: string;
  origin: WorldPos;
  bounds: CellContent['bounds'];
  meshes: { material: Material; mesh: Mesh }[];
  batches: { archetype: string; material: Material; instances: InstanceBuffer; lods: Mesh[]; count: number }[];
  bytes: number;
  /** With `horizon`: the largest distance from the sphere's centre that the cell's box reaches. Otherwise 0. */
  maxRadius: number;
}

export interface StreamedWorldStats extends StreamingCounters {
  /** Cells kept by the last view culling, and draw calls and triangles this layer issued in the last colour pass. */
  cellsVisible: number;
  drawCalls: number;
  triangles: number;
  instances: number;
  /** Last frame: upload and main-thread generation time, and how many cells each handled. */
  uploadMs: number;
  uploads: number;
  blockingMs: number;
  blockingJobs: number;
  /** Average generation time of one cell, measured where it ran (worker or main thread). */
  generateMsAvg: number;
  /** Average upload time of one cell. */
  uploadMsAvg: number;
  renderOrigin: WorldPos;
  /** Cells refused because they were built for another world shape (their jobs count as failed). */
  shapeMismatches: number;
  /** Cells the last view culling left out because they lie behind the horizon (0 without the `horizon` option). */
  horizonCulled: number;
}

/** What the blend between levels needs for one draw: the viewer and the range of every level in use. */
interface MorphFrame {
  eye: readonly [number, number, number, number];
  up: Vec3;
  /** Per level: [start distance, 1 / length]; [0, 0] where there is no blend. */
  range: (level: number) => readonly [number, number];
}

/** A pending blocking job. */
interface BlockingJob {
  req: CellRequest;
  abort: AbortController;
}

export class StreamedWorld implements Layer {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'streamed-world';
  readonly manager: StreamingManager;
  readonly renderer: Renderer;
  readonly provider: CellProvider;
  /** Render-space origin in world metres (double); x and z snap to the grid, y is 0 unless `originAxes` is `'all'`. */
  origin: WorldPos = [0, 0, 0];
  /** Textures and uniforms per material name (see the options of the same names). */
  textures: Record<string, Record<string, Texture | null>>;
  materialUniforms: Record<string, Uniforms>;
  private readonly gpuCeiling: number | undefined;
  private readonly onResident: StreamedWorldOptions['onResident'];
  private readonly onReleased: StreamedWorldOptions['onReleased'];
  /** Uniforms set for every material before its cells are drawn. */
  uniforms: Uniforms = {};
  private readonly materials: Readonly<Record<string, Material>>;
  private readonly archetypes: Readonly<Record<string, StreamArchetype>>;
  private readonly grid: number;
  private readonly originAxes: OriginAxes;
  private readonly uploadMs: number;
  private readonly blockingMs: number;
  private readonly onActivity: () => void;
  private readonly now: () => number;
  private tickets: Ticket[] = [];
  private readonly cpu = new Map<string, CellContent>();
  private readonly gpu = new Map<string, GpuCell>();
  private readonly running = new Map<string, AbortController>();
  private readonly blocking: BlockingJob[] = [];
  private readonly arrived: { req: CellRequest; result: CellResult }[] = [];
  private readonly failedJobs: CellRequest[] = [];
  private pendingUploads: CellId[] = [];
  private drawList: GpuCell[] = [];
  private drawKey = '';
  private viewList: GpuCell[] = [];
  private shadowList: GpuCell[] = [];
  private eye: Vec3 = [0, 0, 0];
  private eyeWorld: WorldPos = [0, 0, 0];
  private readonly horizon: { center: WorldPos; radiusM: number } | null;
  private horizonCulled = 0;
  private frame = { uploadMs: 0, uploads: 0, blockingMs: 0, blockingJobs: 0, drawCalls: 0, triangles: 0, instances: 0 };
  private totals = { genMs: 0, genJobs: 0, upMs: 0, upCells: 0 };
  private readonly undo: () => void;
  private readonly morph: boolean;
  /** Hash of the manager's world shape; a cell that states another one is refused. */
  private readonly shape: number;
  private shapeMismatches = 0;

  constructor(o: StreamedWorldOptions) {
    this.renderer = o.renderer;
    this.manager = new StreamingManager(o.gpuCeilingBytes === undefined ? o.config : { ...o.config, gpuBudgetBytes: o.gpuCeilingBytes });
    this.gpuCeiling = o.gpuCeilingBytes;
    this.textures = o.textures ?? {};
    this.materialUniforms = o.materialUniforms ?? {};
    this.onResident = o.onResident;
    this.onReleased = o.onReleased;
    this.provider = o.provider;
    this.materials = o.materials;
    this.archetypes = o.archetypes ?? {};
    this.grid = o.originGridM ?? 1024;
    this.originAxes = o.originAxes ?? 'horizontal';
    this.uploadMs = o.uploadMsPerFrame ?? 3;
    this.blockingMs = o.blockingMsPerFrame ?? 6;
    this.onActivity = o.onActivity ?? ((): void => {});
    this.now = o.now ?? ((): number => performance.now());
    this.morph = o.morph ?? false;
    this.horizon = o.horizon ?? null;
    this.shape = shapeHash(o.config.shape);
    const hook = (): void => this.step();
    this.renderer.beforeFrame.push(hook);
    // A device that keeps its uploads restores the meshes itself; otherwise the cells are uploaded again.
    const device = this.renderer.device;
    const unwatch = device.onRestored(() => {
      if (!device.retainUploads) this.reupload();
    });
    this.undo = () => {
      unwatch();
      const i = this.renderer.beforeFrame.indexOf(hook);
      if (i >= 0) this.renderer.beforeFrame.splice(i, 1);
    };
  }

  /**
   * Forgets every GPU object of the cells without deleting it and has the manager list the cells for upload again
   * (from the CPU data this layer keeps). For a fresh graphics context after a loss, on a device that did not keep
   * the uploads; the cover fills in again within the upload budget of the next frames.
   */
  reupload(): void {
    for (const key of [...this.gpu.keys()]) {
      const g = this.gpu.get(key)!;
      this.gpu.delete(key);
      this.onReleased?.(g.cell);
    }
    this.manager.dropResident();
    this.drawList = [];
    this.viewList = [];
    this.shadowList = [];
    this.drawKey = '';
    this.onActivity();
  }

  /**
   * Moves the render origin to the grid point at or below `p` (x and z; y too with `originAxes: 'all'`), and sets the
   * renderer's world origin.
   */
  setFocus(p: WorldPos): void {
    this.origin = snapRenderOrigin(p, this.grid, this.originAxes);
    this.renderer.worldOrigin = [this.origin[0], this.origin[1], this.origin[2]];
  }

  /** World position (double) → render space (small numbers). */
  toRender(p: WorldPos): Vec3 {
    return [p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]];
  }

  /** Render space → world position (double). */
  toWorld(p: readonly [number, number, number]): WorldPos {
    return [p[0] + this.origin[0], p[1] + this.origin[1], p[2] + this.origin[2]];
  }

  /** The reasons to load for the coming frames. */
  setTickets(tickets: readonly Ticket[]): void {
    this.tickets = [...tickets];
  }

  /** Eye position in world metres, for level-of-detail choice of instances. */
  setEye(p: WorldPos): void {
    this.eye = this.toRender(p);
    this.eyeWorld = [p[0], p[1], p[2]];
  }

  /** True when every wanted cell is on the GPU and drawn, and no upload waits. */
  get settled(): boolean {
    return this.manager.settled && this.pendingUploads.length === 0 && this.drawList.length === this.manager.drawn().length;
  }

  /** True while jobs run or wait, or uploads wait. */
  get busy(): boolean {
    const c = this.manager.counters();
    return c.inFlight > 0 || c.queued > 0 || this.pendingUploads.length > 0 || this.blocking.length > 0 || this.arrived.length > 0 || this.manager.stale || this.manager.refreshes().pending > 0;
  }

  stats(): StreamedWorldStats {
    return {
      ...this.manager.counters(),
      cellsVisible: this.viewList.length,
      ...this.frame,
      generateMsAvg: this.totals.genJobs ? this.totals.genMs / this.totals.genJobs : 0,
      uploadMsAvg: this.totals.upCells ? this.totals.upMs / this.totals.upCells : 0,
      renderOrigin: this.origin,
      shapeMismatches: this.shapeMismatches,
      horizonCulled: this.horizonCulled,
    };
  }

  /** Adds generation time measured elsewhere (a worker pool) to the average. */
  recordGeneration(ms: number, jobs: number): void {
    this.totals.genMs += ms;
    this.totals.genJobs += jobs;
  }

  /** One streaming step. Runs at the start of every rendered frame (renderer.beforeFrame). */
  step(): void {
    const m = this.manager;
    // 1. Results that arrived since the last frame.
    for (const { req, result } of this.arrived.splice(0)) this.accept(req, result);
    for (const req of this.failedJobs.splice(0)) m.fail(req);

    // 2. Decisions. With a GPU ceiling the manager is told what everything but the cells holds right now.
    if (this.gpuCeiling !== undefined) m.gpuReserveBytes = Math.max(0, this.renderer.device.memory().total - m.counters().gpuBytes);
    const a = m.update(this.tickets);
    for (const c of a.cancels) {
      this.running.get(c.key)?.abort();
      this.running.delete(c.key);
      const i = this.blocking.findIndex((j) => j.req.key === c.key);
      if (i >= 0) this.blocking.splice(i, 1);
    }
    for (const c of a.releases) this.release(cellKey(c));
    for (const c of a.evictions) {
      const k = cellKey(c);
      this.release(k);
      this.cpu.delete(k);
    }
    for (const req of a.requests) this.start(req);

    // 3. Main-thread jobs within the budget (at least one).
    const t0 = this.now();
    let jobs = 0;
    while (this.blocking.length > 0 && (jobs === 0 || this.now() - t0 < this.blockingMs)) {
      const job = this.blocking.shift()!;
      const tj = this.now();
      this.provider.request(job.req.cell, job.abort.signal).then(
        (result) => this.arrived.push({ req: job.req, result }),
        () => this.failedJobs.push(job.req),
      );
      this.totals.genMs += this.now() - tj;
      this.totals.genJobs++;
      jobs++;
    }
    this.frame.blockingMs = this.now() - t0;
    this.frame.blockingJobs = jobs;
    // A blocking provider resolves at once, but the promise callbacks run after this frame: take them next frame.

    // 4. Uploads within the budget (at least one), most urgent first.
    this.pendingUploads = a.uploads.filter((c) => this.cpu.has(cellKey(c)) && !this.gpu.has(cellKey(c)));
    const u0 = this.now();
    let ups = 0;
    while (this.pendingUploads.length > 0 && (ups === 0 || this.now() - u0 < this.uploadMs)) {
      const c = this.pendingUploads.shift()!;
      const k = cellKey(c);
      const tu = this.now();
      const content = this.cpu.get(k)!;
      const g = this.upload(content);
      this.gpu.set(k, g);
      m.resident(c, g.bytes);
      this.onResident?.(c, g.meshes, content);
      this.totals.upMs += this.now() - tu;
      this.totals.upCells++;
      ups++;
    }
    this.frame.uploadMs = this.now() - u0;
    this.frame.uploads = ups;

    // 5. What to draw; scene bounds in render space; shadows refit when the set changes.
    const drawn = m.drawn();
    this.drawList = drawn.map((c) => this.gpu.get(cellKey(c))).filter((g): g is GpuCell => g !== undefined);
    const key = `${this.origin[0]},${this.origin[1]},${this.origin[2]}|${this.drawList.map((g) => g.key).join(';')}${this.morph ? this.morphKey() : ''}`;
    if (key !== this.drawKey) {
      this.drawKey = key;
      this.renderer.invalidateShadows();
    }
    this.renderer.bounds = this.sceneBounds();
    if (this.busy) this.onActivity();
  }

  /** Accepts a finished job (stale results are dropped by the manager). */
  private accept(req: CellRequest, result: CellResult): void {
    this.running.delete(req.key);
    const content = result.content;
    // A cell built for another world shape (another radius, another root edge) must not be drawn in this one.
    if (content.shapeHash !== undefined && content.shapeHash !== this.shape) {
      this.shapeMismatches++;
      this.manager.fail(req);
      return;
    }
    if (!this.manager.complete(req, cellContentBytes(content), content.error)) return;
    this.cpu.set(req.key, content);
    // New content of a cell drawn with out-of-date content (`refresh`): swapped on the GPU before this frame draws.
    if (this.manager.state(req.cell) === 'RESIDENT') this.swap(req.cell, content);
  }

  /** Replaces the GPU data of a RESIDENT cell; it stays drawn, the frame that follows shows the new content. */
  private swap(cell: CellId, content: CellContent): void {
    const k = cellKey(cell);
    const tu = this.now();
    const g = this.upload(content);
    this.release(k);
    this.gpu.set(k, g);
    this.manager.swapped(cell, g.bytes);
    this.onResident?.(cell, g.meshes, content);
    this.renderer.invalidateShadows();
    this.totals.upMs += this.now() - tu;
    this.totals.upCells++;
  }

  /**
   * The content of these cells is out of date (`StreamingManager.refresh`): cells on the GPU stay drawn and are
   * swapped when their new content arrives, other loaded cells are built again when wanted. Returns how many tracked
   * cells it touched.
   */
  refresh(cells: Iterable<CellId>): number {
    const n = this.manager.refresh(cells);
    if (n > 0) this.onActivity();
    return n;
  }

  /** The viewer and the blend ranges for one draw, from the manager's last step. */
  private morphFrame(): MorphFrame {
    const m = this.manager;
    const t = m.viewer();
    const none = [0, 0] as const;
    if (!t) return { eye: [0, 0, 0, 0], up: [0, 1, 0], range: () => none };
    const e = this.toRender(t.center);
    const cache = new Map<number, readonly [number, number]>();
    return {
      eye: [e[0], e[1], e[2], t.altitude ?? 0],
      up: m.config.shape.upAt(t.center),
      range: (level) => {
        let r = cache.get(level);
        if (!r) {
          const w = m.morphRange(level);
          r = w && w.endM > w.startM ? [w.startM, 1 / (w.endM - w.startM)] : none;
          cache.set(level, r);
        }
        return r;
      },
    };
  }

  /**
   * Changes when the viewer has moved far enough to change the blended shape visibly: its position and altitude in
   * steps of 1/16 of the finest drawn cell's blend length. Part of the key that decides when shadows are redrawn.
   */
  private morphKey(): string {
    const t = this.manager.viewer();
    if (!t) return '';
    let finest = -1;
    for (const g of this.drawList) if (g.cell.level > finest) finest = g.cell.level;
    const w = finest >= 0 ? this.manager.morphRange(finest) : null;
    if (!w) return '';
    const q = Math.max(1e-3, (w.endM - w.startM) / 16);
    return `|m${Math.round(t.center[0] / q)},${Math.round(t.center[1] / q)},${Math.round(t.center[2] / q)},${Math.round((t.altitude ?? 0) / q)},${finest}`;
  }

  private start(req: CellRequest): void {
    const abort = new AbortController();
    if (this.provider.blocking) {
      this.blocking.push({ req, abort });
      return;
    }
    this.running.set(req.key, abort);
    this.provider.request(req.cell, abort.signal).then(
      (result) => {
        this.arrived.push({ req, result });
        this.onActivity();
      },
      (e: unknown) => {
        // A cancelled job may already have a successor under the same key; leave that one's controller alone.
        if (this.running.get(req.key) === abort) this.running.delete(req.key);
        // An aborted job was cancelled by the manager, which already raised the cell's epoch.
        if ((e as Error)?.name !== 'AbortError') this.failedJobs.push(req);
        this.onActivity();
      },
    );
  }

  private upload(c: CellContent): GpuCell {
    const r = this.renderer;
    const key = cellKey(c.cell);
    const g: GpuCell = { cell: c.cell, key, origin: this.manager.config.shape.origin(c.cell), bounds: c.bounds, meshes: [], batches: [], bytes: 0, maxRadius: 0 };
    if (this.horizon) {
      const o = g.origin;
      const b = c.bounds;
      g.maxRadius = boxMaxRadius([o[0] + b.min[0], o[1] + b.min[1], o[2] + b.min[2]], [o[0] + b.max[0], o[1] + b.max[1], o[2] + b.max[2]], this.horizon.center);
    }
    for (const cm of c.meshes) {
      const material = this.materials[cm.material];
      if (!material) throw new Error(`streamed cell ${key}: unknown material "${cm.material}"`);
      g.meshes.push({ material, mesh: r.createMesh(cm.mesh, material) });
      g.bytes += cm.mesh.vertices.byteLength + (cm.mesh.indices?.byteLength ?? 0);
    }
    for (const b of c.instances) {
      const arch = this.archetypes[b.archetype];
      if (!arch) throw new Error(`streamed cell ${key}: unknown archetype "${b.archetype}"`);
      const material = this.materials[arch.material];
      if (!material) throw new Error(`archetype ${b.archetype}: unknown material "${arch.material}"`);
      const count = (b.data.data.length * 4) / b.data.layout.stride;
      if (count === 0) continue;
      const instances = r.createInstances(b.data);
      const lods = arch.lods.map((l) => r.createMesh(l.mesh, material, instances));
      g.batches.push({ archetype: b.archetype, material, instances, lods, count });
      g.bytes += b.data.data.byteLength + arch.lods.reduce((s, l) => s + l.mesh.vertices.byteLength + (l.mesh.indices?.byteLength ?? 0), 0);
    }
    return g;
  }

  private release(key: string): void {
    const g = this.gpu.get(key);
    if (!g) return;
    const d = this.renderer.device;
    for (const m of g.meshes) d.deleteMesh(m.mesh);
    for (const b of g.batches) {
      for (const l of b.lods) d.deleteMesh(l);
      d.deleteInstances(b.instances);
    }
    this.gpu.delete(key);
    this.onReleased?.(g.cell);
  }

  /** Render-space box of a drawn cell. */
  private box(g: GpuCell): { min: Vec3; max: Vec3 } {
    const ox = g.origin[0] - this.origin[0];
    const oy = g.origin[1] - this.origin[1];
    const oz = g.origin[2] - this.origin[2];
    return {
      min: [ox + g.bounds.min[0], oy + g.bounds.min[1], oz + g.bounds.min[2]],
      max: [ox + g.bounds.max[0], oy + g.bounds.max[1], oz + g.bounds.max[2]],
    };
  }

  private sceneBounds(): { min: Vec3; max: Vec3 } | null {
    if (this.drawList.length === 0) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const g of this.drawList) {
      const b = this.box(g);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, b.min[i]!);
        max[i] = Math.max(max[i]!, b.max[i]!);
      }
    }
    return { min, max };
  }

  cull(volume: CullVolume, purpose: 'shadow' | 'view'): number {
    let kept = this.drawList.filter((g) => boxInVolume(this.box(g), volume));
    if (purpose === 'view' && this.horizon) {
      // Behind the horizon: the nearest point of the cell's box is farther than its highest point could be seen.
      const h = this.horizon;
      const eye = this.toRender(this.eyeWorld);
      const fromCenter = [this.eyeWorld[0] - h.center[0], this.eyeWorld[1] - h.center[1], this.eyeWorld[2] - h.center[2]] as const;
      const inView = kept.length;
      kept = kept.filter((g) => !horizonHidden(fromCenter, h.radiusM, distanceToBox(eye, this.box(g)), g.maxRadius));
      this.horizonCulled = inView - kept.length;
    }
    if (purpose === 'shadow') this.shadowList = kept;
    else this.viewList = kept;
    return purpose === 'view' ? kept.reduce((s, g) => s + g.batches.reduce((t, b) => t + b.count, 0), 0) : 0;
  }

  draw(ctx: DrawContext): void {
    const list = ctx.pass === 'shadow' ? this.shadowList : this.viewList;
    if (list.length === 0) return;
    const counting = ctx.pass === 'color' || ctx.pass === 'data';
    if (counting) this.frame = { ...this.frame, drawCalls: 0, triangles: 0, instances: 0 };
    const names = Object.keys(this.materials).sort();
    const morph = this.morph ? this.morphFrame() : null;
    for (const name of names) {
      const material = this.materials[name]!;
      const program = material.program(ctx.pass);
      if (!program) continue;
      let used = false;
      const begin = (): void => {
        if (used) return;
        used = true;
        const state = material.state[ctx.pass];
        if (state) ctx.device.setState(state);
        ctx.device.use(program);
        if (ctx.pass === 'shadow') program.mat4('u_lightRender', ctx.lightRender);
        else program.int('u_shadowMap', SHADOW_MAP_UNIT);
        for (const u in this.uniforms) program.set(u, this.uniforms[u]!);
        const own = this.materialUniforms[name];
        if (own) for (const u in own) program.set(u, own[u]!);
        const textures = this.textures[name];
        if (textures) {
          let unit = SHADOW_MAP_UNIT + 1;
          for (const sampler in textures) {
            ctx.device.texture(unit, textures[sampler]!);
            program.int(sampler, unit++);
          }
        }
        if (morph) {
          program.set('u_morphEye', { vec4: morph.eye });
          program.vec3('u_morphUp', morph.up[0], morph.up[1], morph.up[2]);
        }
      };
      for (const g of list) {
        const ox = g.origin[0] - this.origin[0];
        const oy = g.origin[1] - this.origin[1];
        const oz = g.origin[2] - this.origin[2];
        const blend = morph ? morph.range(g.cell.level) : null;
        for (const m of g.meshes) {
          if (m.material !== material) continue;
          begin();
          program.vec3('u_cellOffset', ox, oy, oz);
          program.float('u_cellLevel', g.cell.level);
          if (blend) program.vec2('u_cellMorph', blend[0], blend[1]);
          ctx.device.draw(m.mesh);
          ctx.count(m.mesh.triangles);
          if (counting) {
            this.frame.drawCalls++;
            this.frame.triangles += m.mesh.triangles;
          }
        }
        let dist = -1;
        for (const b of g.batches) {
          if (b.material !== material) continue;
          if (dist < 0) dist = distanceToBox(this.eye, this.box(g));
          const arch = this.archetypes[b.archetype]!;
          const lod = arch.lods.findIndex((l) => dist <= l.maxDistance);
          if (lod < 0) continue;
          begin();
          program.vec3('u_cellOffset', ox, oy, oz);
          program.float('u_cellLevel', g.cell.level);
          if (blend) program.vec2('u_cellMorph', blend[0], blend[1]);
          const mesh = b.lods[lod]!;
          ctx.device.draw(mesh);
          ctx.count(mesh.triangles * mesh.instances);
          if (counting) {
            this.frame.drawCalls++;
            this.frame.triangles += mesh.triangles * mesh.instances;
            this.frame.instances += mesh.instances;
          }
        }
      }
    }
  }

  /** Releases every GPU resource, aborts jobs and detaches from the renderer. */
  dispose(): void {
    this.undo();
    for (const a of this.running.values()) a.abort();
    this.running.clear();
    for (const k of [...this.gpu.keys()]) this.release(k);
    this.cpu.clear();
    this.renderer.remove(this);
  }
}

/** Tickets for a viewer: one at the eye, and one at the predicted point ahead when it moves (design: `predict`). */
export function viewTickets(eye: WorldPos, altitude: number, forward: readonly [number, number], velocity: readonly [number, number] = [0, 0], lookAheadS = 2): Ticket[] {
  const t: Ticket[] = [{ id: 'camera', kind: 'camera', center: eye, altitude: Math.max(0, altitude), base: 0, dir: forward }];
  const speed = Math.sqrt(velocity[0] * velocity[0] + velocity[1] * velocity[1]);
  if (speed > 0.5) {
    t.push({ id: 'predict', kind: 'predict', center: [eye[0] + velocity[0] * lookAheadS, eye[1], eye[2] + velocity[1] * lookAheadS], altitude: Math.max(0, altitude), base: 1, dir: velocity });
  }
  return t;
}

/**
 * Tickets for a viewer on any world shape: as `viewTickets`, with the directions as world vectors and, for selection
 * by screen-space error, the pixels one radian covers on the viewer's screen (`pixelsPerRadian` of world).
 */
export function viewerTickets(o: {
  eye: WorldPos;
  /** Height of the eye above the surface under it. */
  altitude: number;
  forward: readonly [number, number, number];
  velocity?: readonly [number, number, number];
  lookAheadS?: number;
  pixelsPerRadian?: number;
}): Ticket[] {
  const altitude = Math.max(0, o.altitude);
  const px = o.pixelsPerRadian !== undefined ? { pixelsPerRadian: o.pixelsPerRadian } : {};
  const t: Ticket[] = [{ id: 'camera', kind: 'camera', center: o.eye, altitude, base: 0, dir: o.forward, ...px }];
  const v = o.velocity ?? [0, 0, 0];
  const look = o.lookAheadS ?? 2;
  if (Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) > 0.5) {
    t.push({ id: 'predict', kind: 'predict', center: [o.eye[0] + v[0] * look, o.eye[1] + v[1] * look, o.eye[2] + v[2] * look], altitude, base: 1, dir: v, ...px });
  }
  return t;
}

/** Generator provider running in a pool of module workers. The worker script calls `serveCellGenerator`. */
export class WorkerCellProvider implements CellProvider {
  readonly name: string;
  readonly blocking = false;
  readonly pool: WorkerPool;
  readonly seed: number;
  private readonly edits: CellEdits | undefined;

  /** With `edits`, the edits text of a cell travels with its job when it is not empty (read when the request starts). */
  constructor(workerUrl: URL | string, seed: number, size?: number, edits?: CellEdits) {
    this.pool = new WorkerPool(workerUrl, size);
    this.seed = seed;
    this.edits = edits;
    this.name = `generator (${this.pool.size} workers)`;
  }

  async request(cell: CellId, signal: AbortSignal): Promise<CellResult> {
    const message: { seed: number; cell: CellId; edits?: string } = { seed: this.seed, cell: { face: cell.face, level: cell.level, x: cell.x, y: cell.y } };
    const edits = this.edits ? this.edits(cell) : '';
    if (edits) message.edits = edits;
    const job = this.pool.run<ArrayBuffer>(message);
    const onAbort = (): void => job.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const buf = await job.promise;
      const bytes = new Uint8Array(buf);
      return { content: decodeCell(bytes), bytes, origin: 'generated' };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    this.pool.dispose();
  }
}

/**
 * Inside a worker script: generates and encodes cells for `WorkerCellProvider`; the bytes are transferred. A job
 * that carries edits text hands it to the generator as the third argument.
 */
export function serveCellGenerator(generate: CellGenerator): void;
export function serveCellGenerator(generate: EditableCellGenerator): void;
export function serveCellGenerator(generate: EditableCellGenerator): void {
  serveWorker((message) => {
    const { seed, cell, edits } = message as { seed: number; cell: CellId; edits?: string };
    const id = Object.freeze({ ...cell });
    const bytes = encodeCell(typeof edits === 'string' && edits ? generate(seed, id, edits) : generate(seed, id));
    return { value: bytes.buffer, transfer: [bytes.buffer] };
  });
}
