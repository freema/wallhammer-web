// World streaming, the decision part (Wallhammer Zero ARCHITECTURE "One frame → Streaming" and the research report
// "No Man's Sky: generation and streaming", sections on cell states, tickets and epochs). Pure logic: it runs in Node
// without a GPU, reads no clock and decides only from its inputs, so the same camera path always gives the same
// sequence of requests. The execution part (workers, uploads, time budgets) lives in `runtime` and only decides *when*
// work happens, never *what*.
//
// - Cells form a quadtree over the world shape. The level of a cell is its level of detail: a coarse parent covers
//   what its four children cover, with the same number of vertices on four times the area.
// - A ticket is a reason to load (the camera, a predicted point ahead of it, a teleport target, a tool). The ticket
//   level of a cell is `min over tickets (base + distance / cell edge)`. Roots are wanted while it is at most
//   `rootRange`; a cell is split into its children while it is at most `splitLevel`. Because the distance is divided
//   by the edge, every quadtree level gets its own ring around the camera, in proportion to its size.
// - Cell states follow the design: NONE → MESHED (one job builds layout, content and meshes) → RESIDENT (uploaded).
//   MACRO, LAYOUT and CONTENT pass inside the job; ACTIVE (physics, AI) does not exist in this engine.
// - Cancelling: every request carries the cell's epoch. When a cell stops being wanted while its job runs, the epoch
//   is raised and the job is aborted; a result with an old epoch is dropped as stale.
// - A cell keeps its GPU data while its parent's ticket level stays within `splitLevel + hysteresis` (no flicker at a
//   ring edge). Outside it, GPU data are released and the CPU data stay as a cache until the memory budget needs room;
//   then the cells wanted longest ago and farthest away go first.
// - Drawing: the cover of the wanted quadtree. A split cell is replaced by its children only when all four are
//   RESIDENT, so the parent stays visible until the children arrive: no holes, no overlap, no popping to empty.
// - The world shape answers every question of place: which coarsest cells lie near a ticket (`cellsNear`), how far a
//   cell is (`distanceM`), where its middle is (`center`) and which way is up at a ticket (`upAt`). Nothing here
//   assumes a plane.
// - Optional, off by default: selection by screen-space error (`screenError`). The split distance then follows from
//   the viewport and a tolerance in pixels instead of `splitLevel`, a cell is never split before it is loaded, a cell
//   whose measured error is too small to see is not split at all, and a budget of cells lowers the detail as a whole
//   when the plan would not fit. Jobs for cells in front of a ticket's direction start first.
// - `morphRange` gives, per level, the distances between which cells of that level blend into their parent's shape
//   (see gen-mesh, cell morph mesh). It follows from the split distance alone, so the blend and the choice of levels
//   cannot drift apart.
// - `refresh` marks the content of cells as out of date (their source changed, for example edits of the content).
//   A job in flight is cancelled and requested again, a cell kept off the GPU is forgotten, and a cell on the GPU
//   stays drawn with its old content while its new content is built ahead of every other request; the execution
//   part swaps the GPU data when it arrives (`complete` leaves such a cell RESIDENT, then `swapped`). Out-of-date
//   content never goes onto the GPU again: a refreshing cell that leaves the GPU first is forgotten. Without a call
//   of `refresh` nothing here behaves differently.

import type { CellId, WorldPos, WorldShape } from '../gen-core/cell.ts';
import { cellKey, compareCells } from '../gen-core/cell.ts';

/** Cell states of the design. MACRO, LAYOUT and CONTENT are passed inside one job here; ACTIVE is not used. */
export const CELL_STATES = ['NONE', 'MACRO', 'LAYOUT', 'CONTENT', 'MESHED', 'RESIDENT', 'ACTIVE'] as const;
export type CellState = (typeof CELL_STATES)[number];
const RANK: Record<CellState, number> = { NONE: 0, MACRO: 1, LAYOUT: 2, CONTENT: 3, MESHED: 4, RESIDENT: 5, ACTIVE: 6 };

/** Ticket kinds of the design. */
export type TicketKind = 'player' | 'predict' | 'camera' | 'travel' | 'tool';

export interface Ticket {
  /** Stable name; tickets are processed in the order of their ids. */
  id: string;
  kind: TicketKind;
  /** Where the ticket stands (world metres, double). */
  center: WorldPos;
  /** Height of the viewer above the ground, added to the horizontal distance (0 = on the ground). */
  altitude?: number;
  /** Base level: 0 for the viewer, 1 for a predicted point (tighter rings). */
  base: number;
  /**
   * Direction of view or travel; cells in front of it are fetched first. Two numbers are [x, z] on a flat world,
   * three are a world direction (the manager compares it with the direction to a cell across "up" at the ticket).
   */
  dir?: readonly [number, number] | readonly [number, number, number];
  /**
   * Pixels that one radian covers on the viewer's screen (`pixelsPerRadian`). Used only by selection by screen-space
   * error; a ticket without it uses the configured default.
   */
  pixelsPerRadian?: number;
  /**
   * Selection by screen-space error only: the ticket loads its cells but does not change what is drawn. Cells it alone
   * asks for are fetched and kept ready on the CPU; they replace their parent on the screen only once a ticket without
   * this flag wants them. For a predicted point ahead of the viewer: the levels on the screen then depend on the
   * viewer alone, which the blend between levels needs (a cell split far from the viewer would show its parent's
   * shape without the parent's own blend, a step). The coarsest cells near it are wanted as for any ticket.
   * Default off.
   */
  preload?: boolean;
}

/**
 * Selection by screen-space error. A cell is replaced by its children while its error, seen from a ticket, covers
 * more than `maxErrorPx` pixels. The error of a cell is `errorPerEdge` × its edge, so the split distance is
 * `errorPerEdge × pixelsPerRadian / maxErrorPx` edges (it replaces `splitLevel`; `prefetch` and `hysteresis` keep
 * their share of it). A cell that reports a smaller measured error (`CellContent.error`) is split later or never.
 */
export interface ScreenErrorConfig {
  /** Largest error left on the screen, in pixels. */
  maxErrorPx: number;
  /** Error of a cell as a share of its edge (for a regular grid about an eighth of the vertex spacing ÷ edge). */
  errorPerEdge: number;
  /** A measured error never counts as less than this share of the edge (content finer than the geometry). Default 0. */
  minErrorPerEdge?: number;
  /** Pixels per radian for tickets that do not state it. */
  pixelsPerRadian: number;
  /**
   * Budget of cells: the most cells wanted on the GPU at once. When the plan is larger, the detail is lowered as a
   * whole (the split distance shrinks in steps of 2^¼) until it fits; it comes back when there is room again.
   */
  maxCells?: number;
}

/** Pixels that one radian covers at the middle of a perspective view: `viewportHeightPx / (2 · tan(fovY / 2))`. */
export function pixelsPerRadian(viewportHeightPx: number, fovYRad: number): number {
  return viewportHeightPx / (2 * Math.tan(fovYRad / 2));
}

export interface StreamingConfig {
  shape: WorldShape;
  /** Only cells of this face are streamed. Without it every face the shape reports near a ticket is. */
  face?: number;
  /** Coarsest and finest quadtree level that is streamed. */
  rootLevel: number;
  leafLevel: number;
  /** Roots are wanted while their ticket level is at most this. */
  rootRange: number;
  /** A cell is replaced by its children while its ticket level is at most this. */
  splitLevel: number;
  /** Children of cells within `splitLevel + prefetch` are fetched to the CPU ahead of need (0 = no prefetch). */
  prefetch: number;
  /** A cell keeps its GPU data while its parent is within `splitLevel + hysteresis`. */
  hysteresis: number;
  /** Most requests in flight at once (generation and loading together). */
  maxInFlight: number;
  /** CPU and GPU bytes the streamed cells may hold together. */
  memoryBudgetBytes: number;
  /**
   * Room of their own for the cells that only `preload` tickets ask for (selection by screen-space error), in bytes
   * of CPU data; default off. Without it such cells share `memoryBudgetBytes` with the plan: they count in the fit
   * that lowers the detail, and they are fetched only while room is left beside the wanted cells. With it they are
   * counted apart, up to this many bytes, so a second place can be held ready without a change to the place in view.
   */
  preloadBudgetBytes?: number;
  /** Selection by screen-space error with a budget of cells. Default off: levels follow `splitLevel`. */
  screenError?: ScreenErrorConfig;
  /**
   * Ceiling of GPU bytes, default off. The streamed cells may hold this many bytes on the GPU minus `gpuReserveBytes`
   * (what everything else holds). Over the ceiling, cells leave the GPU: first those kept only by hysteresis, the
   * ones wanted longest ago first, then wanted cells from the least urgent (the finest and farthest), so the coarse
   * cover stays. Cells kept only by hysteresis also leave when the waiting uploads would not fit beside them. An
   * upload that still does not fit waits, and its parent stays drawn in its place. With selection by screen-space
   * error the plan itself is kept within the room as well: the detail is lowered in every direction, as for
   * `maxCells`, so wanted cells rarely have to leave and a turn of the view finds its cells on the GPU.
   */
  gpuBudgetBytes?: number;
}

export const DEFAULT_STREAMING: Omit<StreamingConfig, 'shape' | 'face'> = {
  rootLevel: 4,
  leafLevel: 8,
  rootRange: 2,
  splitLevel: 1,
  prefetch: 0.5,
  hysteresis: 0.75,
  maxInFlight: 8,
  memoryBudgetBytes: 128 * 1024 * 1024,
};

type Want = 'resident' | 'meshed' | 'keep' | 'none';

interface CellRecord {
  cell: CellId;
  key: string;
  state: CellState;
  want: Want;
  epoch: number;
  inFlight: boolean;
  cpuBytes: number;
  gpuBytes: number;
  /** Last step in which the cell was wanted (resident or meshed). */
  lastWanted: number;
  /** Ticket level of the cell in the last step. */
  level: number;
  failures: number;
  /** After a failure the cell is not requested again before this step. */
  retryAt: number;
  /** Measured error of the loaded content in metres, when the provider reported one. */
  errorM?: number;
  /** RESIDENT with out-of-date content (`refresh`): drawn as it is until the new content arrives and is swapped in. */
  refresh?: boolean;
}

export interface CellRequest {
  cell: CellId;
  key: string;
  epoch: number;
}

/** What the execution part should do after a step. Every list is in a deterministic order. */
export interface StreamingActions {
  /** Start these jobs (generation or loading). */
  requests: CellRequest[];
  /** Abort these jobs; their results will be dropped anyway. */
  cancels: CellRequest[];
  /** Cells that are MESHED and wanted on the GPU, most urgent first. Upload within the budget and call `resident`. */
  uploads: CellId[];
  /** Release the GPU data of these cells (they fall back to MESHED). */
  releases: CellId[];
  /** Forget these cells completely (GPU and CPU data). */
  evictions: CellId[];
}

export interface StreamingCounters {
  step: number;
  /** Cells per state (tracked cells only). */
  states: Record<CellState, number>;
  inFlight: number;
  /** Wanted cells still waiting for a free slot. */
  queued: number;
  wanted: number;
  drawn: number;
  /** Wanted roots with nothing to draw (only right after a jump or at start). */
  holes: number;
  cpuBytes: number;
  gpuBytes: number;
  requested: number;
  completed: number;
  cancelled: number;
  stale: number;
  failed: number;
  evicted: number;
  settled: boolean;
  /** Share of the full split distance in use: 1, or less while the budget of cells or the GPU ceiling holds the detail down. */
  detail: number;
}

/** Most steps the budget of cells may lower the detail by (each step divides the split distance by 2^¼). */
const MAX_DETAIL_STEPS = 16;
/** Detail comes back one step when the finer plan would use at most this share of the budget. */
const DETAIL_BACK_SHARE = 0.85;
/** The blend into the parent's shape takes at least this share of the distance at which the parent is split. */
const MORPH_MIN_SHARE = 0.15;

/** Cells the step decided on, kept for the drawing cover. */
interface Plan {
  wanted: Map<string, CellId>;
  prefetch: Map<string, CellId>;
  /** The cells of `prefetch` that only `preload` tickets ask for (filled with `preloadBudgetBytes` alone). */
  preload: Set<string>;
  split: Set<string>;
  roots: CellId[];
  levels: Map<string, number>;
}

export class StreamingManager {
  readonly config: StreamingConfig;
  private readonly cells = new Map<string, CellRecord>();
  private tickets: Ticket[] = [];
  private plan: Plan = { wanted: new Map(), prefetch: new Map(), preload: new Set(), split: new Set(), roots: [], levels: new Map() };
  private drawnList: CellId[] = [];
  private holes = 0;
  private stepNo = 0;
  /** Source of epochs. World-wide and never reused, so a result from before a cell was forgotten can never match. */
  private epochSeq = 0;
  private totals = { requested: 0, completed: 0, cancelled: 0, stale: 0, failed: 0, evicted: 0 };
  /** Steps the budget of cells has lowered the detail by (selection by screen-space error only). */
  private detailStep = 0;
  /** A cell changed state since the last plan and the plan depends on states (selection by screen-space error). */
  private planStale = false;
  /** Every request issued, as `step:key`, for determinism checks. Cleared by `clearLog`. */
  readonly log: string[] = [];
  /** Cancels and evictions `refresh` decided between steps; handed out with the next `update`. */
  private pendingCancels: CellRequest[] = [];
  private pendingEvictions: CellId[] = [];
  private refreshTotal = 0;
  /** Cells fetched only ahead of need that the last step did not request for want of room in the memory budget. */
  private readonly noRoom = new Set<string>();

  constructor(config: StreamingConfig) {
    if (config.leafLevel < config.rootLevel) throw new Error('leafLevel must not be coarser than rootLevel');
    this.config = config;
  }

  /** Ticket level of a cell: the minimum over tickets of base + distance / edge. */
  ticketLevel(cell: CellId, tickets: readonly Ticket[] = this.tickets): number {
    const shape = this.config.shape;
    const edge = shape.edgeM(cell.level);
    let best = Infinity;
    for (const t of tickets) {
      const d = shape.distanceM(cell, t.center);
      const a = t.altitude ?? 0;
      const l = t.base + Math.sqrt(d * d + a * a) / edge;
      if (l < best) best = l;
    }
    return best;
  }

  /**
   * The ticket the image is drawn for: the one with the lowest base (the first by id among equals), or null without
   * tickets. A ticket that only preloads counts only when there is no other. The blend between levels is measured
   * from it.
   */
  viewer(): Ticket | null {
    let best: Ticket | null = null;
    for (const t of this.tickets) {
      if (!best) best = t;
      else if (!best.preload !== !t.preload) best = best.preload ? t : best;
      else if (t.base < best.base) best = t;
    }
    return best;
  }

  /**
   * Split distance of a ticket in cell edges: a cell is replaced by its children while its ticket level is at most
   * this. `splitLevel`, or with selection by screen-space error the distance at which the error covers the tolerance.
   */
  splitDistance(t: Ticket): number {
    const se = this.config.screenError;
    if (!se) return this.config.splitLevel;
    return ((se.errorPerEdge * (t.pixelsPerRadian ?? se.pixelsPerRadian)) / se.maxErrorPx) * this.detailScale(this.detailStep);
  }

  /**
   * Distances from the viewer between which a cell of `level` blends from its own shape (at `startM` and nearer) into
   * its parent's (at `endM` and farther), in the metric of the ticket level: distance along the surface combined with
   * the viewer's altitude. `endM` is where the parent stops being split, so a cell that has just replaced its parent
   * shows the parent's shape. Null when there is nothing to blend into (the coarsest level, no viewer).
   *
   * The blend is free of jumps when the split distance is at least 2.02 edges: a cell must be back in its own shape
   * over its whole footprint (√2 edges across) before it is split, and the blend still needs 15 % of the way to run.
   * Below that the blend is squeezed into the last 15 % and small steps remain, which the skirt of the cell covers.
   *
   * The ranges assume a parent that is split at the full split distance. A parent whose measured error is smaller is
   * split nearer (selection by screen-space error), where its children are already in their own shape: they replace
   * it with a step of up to the tolerance on the screen. Content that must not show that step reports the full error.
   */
  morphRange(level: number): { startM: number; endM: number } | null {
    const t = this.viewer();
    if (!t || level <= this.config.rootLevel || level > this.config.leafLevel) return null;
    const split = this.splitDistance(t) - t.base;
    if (!(split > 0)) return null;
    const edge = this.config.shape.edgeM(level);
    const endM = 2 * split * edge;
    const startM = Math.min((split + Math.SQRT2) * edge, (1 - MORPH_MIN_SHARE) * endM);
    return { startM, endM };
  }

  /** Decides what is wanted for the given tickets, then returns the work to do. One call per frame (or step). */
  update(tickets: readonly Ticket[]): StreamingActions {
    this.stepNo++;
    this.tickets = [...tickets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.distances.clear();
    const plan = this.config.screenError ? this.planByScreenError(this.config.screenError) : this.planCells();
    this.plan = plan;
    this.planStale = false;
    const cfg = this.config;
    const actions: StreamingActions = { requests: [], cancels: [], uploads: [], releases: [], evictions: [] };
    if (this.pendingCancels.length > 0 || this.pendingEvictions.length > 0) {
      actions.cancels.push(...this.pendingCancels);
      actions.evictions.push(...this.pendingEvictions);
      this.pendingCancels = [];
      this.pendingEvictions = [];
    }

    // Records for every wanted or prefetched cell.
    for (const [key, cell] of [...plan.wanted, ...plan.prefetch]) {
      let r = this.cells.get(key);
      if (!r) {
        r = { cell, key, state: 'NONE', want: 'none', epoch: 0, inFlight: false, cpuBytes: 0, gpuBytes: 0, lastWanted: 0, level: 0, failures: 0, retryAt: 0 };
        this.cells.set(key, r);
      }
    }

    // What each tracked cell is wanted for now.
    this.keepBand.clear();
    const records = this.sortedRecords();
    for (const r of records) {
      // A cell outside the plan gets its level when something asks for it (`levelOf`): most are never asked.
      r.level = plan.levels.get(r.key) ?? NaN;
      if (plan.wanted.has(r.key)) r.want = 'resident';
      else if (plan.prefetch.has(r.key)) r.want = 'meshed';
      else r.want = this.withinKeepBand(r.cell) ? 'keep' : 'none';
      if (r.want === 'resident' || r.want === 'meshed') r.lastWanted = this.stepNo;
      // Out-of-date content that is no longer wanted on the screen is forgotten, never kept for later.
      if (r.refresh && r.want !== 'resident') this.forgetRefreshing(r, actions.cancels, actions.releases, actions.evictions);
      if (r.want === 'none') {
        if (r.inFlight) {
          // Stale work: raise the epoch, abort the job; its result will not be accepted.
          actions.cancels.push({ cell: r.cell, key: r.key, epoch: r.epoch });
          r.epoch = ++this.epochSeq;
          r.inFlight = false;
          this.totals.cancelled++;
        }
        if (r.state === 'RESIDENT') {
          actions.releases.push(r.cell);
          r.state = 'MESHED';
          r.gpuBytes = 0;
        }
      }
    }

    // New requests, most urgent first, up to the in-flight limit.
    const inFlight = records.filter((r) => r.inFlight).length;
    const candidates = records.filter((r) => (r.want === 'resident' || r.want === 'meshed') && RANK[r.state] < RANK.MESHED && !r.inFlight && r.retryAt <= this.stepNo);
    const keyed = candidates.map((r) => ({ r, k: this.priority(r) }));
    keyed.sort((a, b) => comparePriority(a.k, b.k) || compareCells(a.r.cell, b.r.cell));
    // Cells drawn with out-of-date content go ahead of every other candidate, in cell order.
    const refreshing = records.filter((r) => r.refresh && r.state === 'RESIDENT' && !r.inFlight && r.retryAt <= this.stepNo);
    const order = refreshing.length > 0 ? [...refreshing, ...keyed.map((x) => x.r)] : keyed.map((x) => x.r);
    let free = Math.max(0, cfg.maxInFlight - inFlight);
    // A cell fetched only ahead of need is requested only while it fits the memory budget beside what wanted and
    // prefetched cells hold and what the jobs in flight will bring. Otherwise the budget would forget it again in this
    // very step and the next step would ask for it again, for as long as the view stands.
    this.noRoom.clear();
    const room = this.memoryRoom(records);
    const apart = this.preloadRoom(records, room.estimate);
    for (const r of order) {
      if (free <= 0) break;
      if (apart && r.want === 'meshed' && !r.refresh && plan.preload.has(r.key)) {
        // A cell of a preload ticket alone, with room of its own (`preloadBudgetBytes`).
        const need = room.estimate(r.cell);
        if (apart.used + need > apart.budget) {
          this.noRoom.add(r.key);
          continue;
        }
        apart.used += need;
      } else if (r.want === 'meshed' && !r.refresh) {
        const need = room.estimate(r.cell);
        if (room.used + need > cfg.memoryBudgetBytes) {
          this.noRoom.add(r.key);
          continue;
        }
        room.used += need;
      } else room.used += room.estimate(r.cell);
      free--;
      r.inFlight = true;
      r.epoch = ++this.epochSeq;
      actions.requests.push({ cell: r.cell, key: r.key, epoch: r.epoch });
      this.log.push(`${this.stepNo}:${r.key}`);
      this.totals.requested++;
    }

    // Uploads: MESHED cells wanted on the GPU, coarse-first like the requests.
    const up = records.filter((r) => r.want === 'resident' && r.state === 'MESHED').map((r) => ({ r, k: this.priority(r) }));
    up.sort((a, b) => comparePriority(a.k, b.k) || compareCells(a.r.cell, b.r.cell));
    actions.uploads = up.map((u) => u.r.cell);

    // Memory budget: forget unwanted cells first, the ones wanted longest ago and farthest away before others.
    this.enforceBudget(actions);
    if (cfg.gpuBudgetBytes !== undefined) this.enforceGpuCeiling(actions, cfg.gpuBudgetBytes);

    this.computeCover();
    return actions;
  }

  /**
   * A job finished. Returns false when the result is stale (old epoch) or nobody waits for it any more. `errorM` is
   * the content's measured error (`CellContent.error`), used by selection by screen-space error.
   */
  complete(req: CellRequest, cpuBytes: number, errorM?: number): boolean {
    const r = this.cells.get(req.key);
    if (!r || r.epoch !== req.epoch || !r.inFlight) {
      this.totals.stale++;
      return false;
    }
    r.inFlight = false;
    // New content for a cell drawn with out-of-date content: it stays RESIDENT, the execution part swaps its GPU data.
    if (r.refresh && r.state === 'RESIDENT') r.refresh = false;
    else r.state = 'MESHED';
    r.cpuBytes = cpuBytes;
    r.failures = 0;
    if (errorM !== undefined && errorM >= 0) r.errorM = errorM;
    else delete r.errorM;
    if (this.config.screenError) this.planStale = true;
    this.totals.completed++;
    return true;
  }

  /** A job failed or was aborted. A cell that keeps failing is retried no sooner than its next request round. */
  fail(req: CellRequest): void {
    const r = this.cells.get(req.key);
    if (!r || r.epoch !== req.epoch) return;
    r.inFlight = false;
    r.failures++;
    r.retryAt = this.stepNo + Math.min(600, 30 * 2 ** Math.min(r.failures, 5));
    this.totals.failed++;
  }

  /** The execution part uploaded a MESHED cell. */
  resident(cell: CellId, gpuBytes: number): void {
    const r = this.cells.get(cellKey(cell));
    if (!r || r.state !== 'MESHED') return;
    r.state = 'RESIDENT';
    r.gpuBytes = gpuBytes;
    this.computeCover();
  }

  /** `resident` for several cells at once (cells that were uploaded ahead of need): the cover is worked out once. */
  residentAll(cells: readonly { cell: CellId; gpuBytes: number }[]): void {
    let any = false;
    for (const c of cells) {
      const r = this.cells.get(cellKey(c.cell));
      if (!r || r.state !== 'MESHED') continue;
      r.state = 'RESIDENT';
      r.gpuBytes = c.gpuBytes;
      any = true;
    }
    if (any) this.computeCover();
  }

  /**
   * The execution part swapped the GPU data of a RESIDENT cell for the new content `complete` accepted after a
   * `refresh`. The cell stays RESIDENT and drawn throughout.
   */
  swapped(cell: CellId, gpuBytes: number): void {
    const r = this.cells.get(cellKey(cell));
    if (!r || r.state !== 'RESIDENT') return;
    r.gpuBytes = gpuBytes;
  }

  /**
   * The content of these cells is out of date. Returns how many tracked cells it touched:
   * - a job in flight is cancelled (its late result is stale) and the cell is requested again by the usual rules;
   * - a MESHED cell is forgotten (state NONE, listed in the next step's `evictions`) and built again when wanted;
   * - a RESIDENT cell stays drawn with its old content; the next step requests it ahead of every other candidate
   *   (within `maxInFlight`), and when its new content arrives `complete` leaves it RESIDENT for the swap. A second
   *   call during a refresh restarts the job.
   * Cells that are not tracked, or NONE with no job, are left alone.
   */
  refresh(cells: Iterable<CellId>): number {
    const list = [...cells].sort(compareCells);
    let touched = 0;
    let last = '';
    for (const c of list) {
      const key = cellKey(c);
      if (key === last) continue;
      last = key;
      const r = this.cells.get(key);
      if (!r) continue;
      const wasInFlight = r.inFlight;
      if (r.inFlight) {
        this.pendingCancels.push({ cell: r.cell, key: r.key, epoch: r.epoch });
        r.epoch = ++this.epochSeq;
        r.inFlight = false;
        this.totals.cancelled++;
      }
      if (r.state === 'RESIDENT') {
        r.refresh = true;
        touched++;
      } else if (r.state === 'MESHED') {
        this.pendingEvictions.push(r.cell);
        r.state = 'NONE';
        r.cpuBytes = 0;
        delete r.errorM;
        if (this.config.screenError) this.planStale = true;
        touched++;
      } else if (wasInFlight) touched++;
    }
    this.refreshTotal += touched;
    return touched;
  }

  /** Cells drawn with out-of-date content that wait for their new content, and all cells `refresh` has touched. */
  refreshes(): { pending: number; total: number } {
    let pending = 0;
    for (const r of this.cells.values()) if (r.refresh) pending++;
    return { pending, total: this.refreshTotal };
  }

  /** State of a cell (NONE when it is not tracked). */
  state(cell: CellId): CellState {
    return this.cells.get(cellKey(cell))?.state ?? 'NONE';
  }

  /** Cells to draw this frame: the cover of the wanted quadtree, parents standing in for children not yet resident. */
  drawn(): readonly CellId[] {
    return this.drawnList;
  }

  /** True when every wanted cell is RESIDENT: the image is complete and depends only on the tickets. */
  get settled(): boolean {
    if (this.planStale) return false;
    for (const key of this.plan.wanted.keys()) {
      const r = this.cells.get(key);
      if (r?.state !== 'RESIDENT' || r.refresh) return false;
    }
    return this.plan.wanted.size > 0;
  }

  /**
   * The loaded cells that are fetched ahead of need and wait on the CPU (MESHED): the children a ticket will split
   * next and the cells of `preload` tickets, in cell order. For an execution part that uploads them ahead.
   */
  ahead(): CellId[] {
    const out: CellId[] = [];
    for (const key of this.plan.prefetch.keys()) {
      const r = this.cells.get(key);
      if (r && r.state === 'MESHED' && !r.refresh) out.push(r.cell);
    }
    return out.sort(compareCells);
  }

  /**
   * True when the image is settled (`settled`) and every cell fetched ahead of need is loaded too: the children a
   * ticket will split next (`prefetch`) and, with selection by screen-space error, the cells that `preload` tickets
   * alone ask for. Those are kept on the CPU (MESHED) and uploaded once a ticket without `preload` wants them on the
   * screen; this answers whether nothing is left to generate or load for the tickets of the last `update`. False
   * while a loaded cell may still make the plan want more (`stale`). Cells the memory budget forgot or has no room
   * for keep it false.
   */
  get prefetched(): boolean {
    if (!this.settled || this.noRoom.size > 0) return false;
    for (const key of this.plan.prefetch.keys()) {
      const r = this.cells.get(key);
      if (!r || RANK[r.state] < RANK.MESHED || r.inFlight) return false;
    }
    return true;
  }

  /**
   * True when a cell was loaded since the last `update` and the next one may therefore want more (selection by
   * screen-space error descends only below loaded cells). The caller should run another step.
   */
  get stale(): boolean {
    return this.planStale;
  }

  /** Wanted cells (target RESIDENT), in a deterministic order. */
  wanted(): CellId[] {
    return [...this.plan.wanted.values()].sort(compareCells);
  }

  counters(): StreamingCounters {
    const states = Object.fromEntries(CELL_STATES.map((s) => [s, 0])) as Record<CellState, number>;
    let cpu = 0;
    let gpu = 0;
    let inFlight = 0;
    let queued = 0;
    for (const r of this.cells.values()) {
      states[r.state]++;
      cpu += r.cpuBytes;
      gpu += r.gpuBytes;
      if (r.inFlight) inFlight++;
      else if ((r.want === 'resident' || r.want === 'meshed') && RANK[r.state] < RANK.MESHED && !this.noRoom.has(r.key)) queued++;
    }
    return {
      step: this.stepNo,
      states,
      inFlight,
      queued,
      wanted: this.plan.wanted.size,
      drawn: this.drawnList.length,
      holes: this.holes,
      cpuBytes: cpu,
      gpuBytes: gpu,
      ...this.totals,
      settled: this.settled,
      detail: this.config.screenError ? this.detailScale(this.detailStep) : 1,
    };
  }

  clearLog(): void {
    this.log.length = 0;
  }

  // --- internals ---------------------------------------------------------------------------------------------------

  private sortedRecords(): CellRecord[] {
    return [...this.cells.values()].sort((a, b) => compareCells(a.cell, b.cell));
  }

  /** The wanted quadtree: roots near the tickets, split while the ticket level allows it. */
  private planCells(): Plan {
    const cfg = this.config;
    const shape = cfg.shape;
    const plan: Plan = { wanted: new Map(), prefetch: new Map(), preload: new Set(), split: new Set(), roots: [], levels: new Map() };
    plan.roots = this.planRoots();
    const visit = (c: CellId, prefetchOnly: boolean): void => {
      const key = cellKey(c);
      const level = this.ticketLevel(c);
      plan.levels.set(key, level);
      if (prefetchOnly) plan.prefetch.set(key, c);
      else plan.wanted.set(key, c);
      if (c.level >= cfg.leafLevel) return;
      const split = !prefetchOnly && level <= cfg.splitLevel;
      if (split) plan.split.add(key);
      if (split || level <= cfg.splitLevel + cfg.prefetch) for (const ch of shape.children(c)) visit(ch, !split);
    };
    for (const r of plan.roots) visit(r, false);
    // A cell wanted through one parent is not also a prefetch.
    for (const k of plan.wanted.keys()) plan.prefetch.delete(k);
    return plan;
  }

  /** The coarsest wanted cells: those the shape reports near a ticket whose ticket level is within `rootRange`. */
  private planRoots(): CellId[] {
    const cfg = this.config;
    const shape = cfg.shape;
    const rootEdge = shape.edgeM(cfg.rootLevel);
    const roots = new Map<string, CellId>();
    for (const t of this.tickets) {
      const reach = Math.max(0, cfg.rootRange - t.base) * rootEdge;
      for (const c of shape.cellsNear(t.center, reach, cfg.rootLevel)) {
        if (cfg.face !== undefined && c.face !== cfg.face) continue;
        const key = cellKey(c);
        if (!roots.has(key) && this.ticketLevel(c) <= cfg.rootRange) roots.set(key, c);
      }
    }
    return [...roots.values()].sort(compareCells);
  }

  /** Share of the full split distance after the budget lowered the detail by `step` steps. */
  private detailScale(step: number): number {
    return 2 ** (-step / 4);
  }

  /** Distance of a cell to each ticket of the step in progress, by the cell's key (`relativeLevel`). */
  private readonly distances = new Map<string, number[]>();

  /**
   * Ticket level of a cell divided by the ticket's split distance, the minimum over tickets: at most 1 where the cell
   * is close enough to be split. `scale` is the share of the full split distance in use. `preload` picks the tickets:
   * all of them (undefined), only those that load without changing the image (true) or only the others (false).
   */
  private relativeLevel(cell: CellId, se: ScreenErrorConfig, scale: number, preload?: boolean): number {
    const shape = this.config.shape;
    const edge = shape.edgeM(cell.level);
    let best = Infinity;
    // A step asks for the same cell several times (the plan at two details, the keep band, the levels): the distance
    // to each ticket is measured once.
    const key = cellKey(cell);
    let known = this.distances.get(key);
    if (!known) this.distances.set(key, (known = []));
    for (let i = 0; i < this.tickets.length; i++) {
      const t = this.tickets[i]!;
      if (preload !== undefined && (t.preload ?? false) !== preload) continue;
      const split = ((se.errorPerEdge * (t.pixelsPerRadian ?? se.pixelsPerRadian)) / se.maxErrorPx) * scale;
      if (!(split > 0)) continue;
      const d = (known[i] ??= shape.distanceM(cell, t.center));
      const a = t.altitude ?? 0;
      const l = (t.base + Math.sqrt(d * d + a * a) / edge) / split;
      if (l < best) best = l;
    }
    return best;
  }

  /**
   * Share of the split distance at which a loaded cell is really split: 1 without a measured error, less when the
   * measured error is smaller than the assumed one (a flat cell is split later, a cell without error never).
   */
  private errorShare(cell: CellId, se: ScreenErrorConfig): number {
    const e = this.cells.get(cellKey(cell))?.errorM;
    if (e === undefined) return 1;
    const edge = this.config.shape.edgeM(cell.level);
    return Math.min(1, Math.max(e, (se.minErrorPerEdge ?? 0) * edge) / (se.errorPerEdge * edge));
  }

  /** The level a record is ordered by when the plan does not list it. */
  /** The record's level in this step's plan; computed on the first call for a cell the plan does not hold. */
  private levelOf(r: CellRecord): number {
    if (Number.isNaN(r.level)) r.level = this.planLevel(r.cell);
    return r.level;
  }

  private planLevel(cell: CellId): number {
    const se = this.config.screenError;
    return se ? this.relativeLevel(cell, se, this.detailScale(this.detailStep)) : this.ticketLevel(cell);
  }

  /**
   * The wanted quadtree by screen-space error, within the budget of cells. Lowers the detail step by step while the
   * plan is over the budget and raises it again once the next finer plan fits with room to spare.
   */
  private planByScreenError(se: ScreenErrorConfig): Plan {
    const budget = se.maxCells ?? Infinity;
    // With a GPU ceiling the plan must fit the room the ceiling leaves the cells as well. A plan over it would have
    // wanted cells taken off the GPU by urgency, which puts the cells behind the viewer last: a turn would show their
    // coarse ancestors until they are back. A coarser plan holds the same detail in every direction instead.
    const room = this.config.gpuBudgetBytes === undefined ? Infinity : Math.max(0, this.config.gpuBudgetBytes - this.gpuReserveBytes);
    const bytes = room === Infinity ? null : this.planBytesEstimator();
    // The plan with the cells it fetches ahead must fit the memory budget too: wanted cells are never forgotten, so a
    // plan over it would leave the budget only the prefetched cells to forget, again in every step.
    const memory = this.config.memoryBudgetBytes;
    const held = memory === Infinity ? null : this.planMemoryEstimator();
    const fits = (p: Plan, share: number): boolean => p.wanted.size <= budget * share && (bytes === null || bytes(p) <= room * share) && (held === null || held(p) <= memory * share);
    let step = this.detailStep;
    let plan: Plan | null = null;
    if (step > 0) {
      const finer = this.planAtDetail(se, step - 1);
      if (fits(finer, DETAIL_BACK_SHARE)) {
        step--;
        plan = finer;
      }
    }
    plan ??= this.planAtDetail(se, step);
    while (!fits(plan, 1) && step < MAX_DETAIL_STEPS) plan = this.planAtDetail(se, ++step);
    this.detailStep = step;
    return plan;
  }

  /**
   * GPU bytes a plan would hold: a loaded cell counts its own bytes (its GPU bytes on the GPU, else its CPU bytes), a
   * cell not yet loaded the mean of the loaded cells of its level, or of all loaded cells when none of its level is.
   */
  private planBytesEstimator(): (p: Plan) => number {
    const sum = new Map<number, { n: number; bytes: number }>();
    let n = 0;
    let all = 0;
    const own = (r: CellRecord): number => (RANK[r.state] < RANK.MESHED ? 0 : r.gpuBytes > 0 ? r.gpuBytes : r.cpuBytes);
    for (const r of this.cells.values()) {
      const b = own(r);
      if (b <= 0) continue;
      const s = sum.get(r.cell.level) ?? { n: 0, bytes: 0 };
      s.n++;
      s.bytes += b;
      sum.set(r.cell.level, s);
      n++;
      all += b;
    }
    const mean = n > 0 ? all / n : 0;
    return (p) => {
      let total = 0;
      for (const [key, cell] of p.wanted) {
        const r = this.cells.get(key);
        const b = r ? own(r) : 0;
        if (b > 0) total += b;
        else {
          const s = sum.get(cell.level);
          total += s ? s.bytes / s.n : mean;
        }
      }
      return total;
    };
  }

  /**
   * Means of the CPU bytes of loaded cells, by level and over all of them, for cells whose bytes are not known yet.
   * A cell on the GPU holds its CPU data too, and its GPU bytes are about its CPU bytes before it is uploaded.
   */
  private cpuMeans(): (cell: CellId) => number {
    const sum = new Map<number, { n: number; bytes: number }>();
    let n = 0;
    let all = 0;
    for (const r of this.cells.values()) {
      if (RANK[r.state] < RANK.MESHED || r.cpuBytes <= 0) continue;
      const s = sum.get(r.cell.level) ?? { n: 0, bytes: 0 };
      s.n++;
      s.bytes += r.cpuBytes;
      sum.set(r.cell.level, s);
      n++;
      all += r.cpuBytes;
    }
    const mean = n > 0 ? all / n : 0;
    return (cell) => {
      const s = sum.get(cell.level);
      return s ? s.bytes / s.n : mean;
    };
  }

  /**
   * Bytes of the memory budget already spoken for: what wanted and prefetched cells hold (cells kept only by
   * hysteresis, or not wanted, give way when room is needed) and what the jobs in flight will bring (estimated as
   * the CPU bytes of loaded cells of their level).
   */
  private memoryRoom(records: readonly CellRecord[]): { used: number; estimate: (cell: CellId) => number } {
    const estimate = this.cpuMeans();
    let used = 0;
    const apart = this.config.preloadBudgetBytes !== undefined;
    for (const r of records) {
      if (apart && r.want === 'meshed' && this.plan.preload.has(r.key)) continue;
      if (r.want === 'resident' || r.want === 'meshed') used += r.cpuBytes + r.gpuBytes;
      if (r.inFlight) used += estimate(r.cell);
    }
    return { used, estimate };
  }

  /** With `preloadBudgetBytes`: the bytes the cells of preload tickets alone hold and will hold, and their room. */
  private preloadRoom(records: readonly CellRecord[], estimate: (cell: CellId) => number): { used: number; budget: number } | null {
    const budget = this.config.preloadBudgetBytes;
    if (budget === undefined) return null;
    let used = 0;
    for (const r of records) {
      if (r.want !== 'meshed' || !this.plan.preload.has(r.key)) continue;
      used += r.cpuBytes + r.gpuBytes;
      if (r.inFlight) used += estimate(r.cell);
    }
    return { used, budget };
  }

  /**
   * CPU and GPU bytes a plan would hold, for the memory budget: a wanted cell its CPU data and as much again on the
   * GPU (its own GPU bytes once there), a cell fetched ahead of need its CPU data. Bytes not known yet are the means of
   * `cpuMeans`.
   */
  private planMemoryEstimator(): (p: Plan) => number {
    const estimate = this.cpuMeans();
    return (p) => {
      let total = 0;
      for (const [key, cell] of p.wanted) {
        const r = this.cells.get(key);
        if (r && RANK[r.state] >= RANK.MESHED && r.cpuBytes > 0) total += r.cpuBytes + (r.gpuBytes > 0 ? r.gpuBytes : r.cpuBytes);
        else total += 2 * estimate(cell);
      }
      for (const [key, cell] of p.prefetch) {
        // Cells of preload tickets alone have room of their own (`preloadBudgetBytes`).
        if (p.preload.has(key)) continue;
        const r = this.cells.get(key);
        total += r && RANK[r.state] >= RANK.MESHED && r.cpuBytes > 0 ? r.cpuBytes : estimate(cell);
      }
      return total;
    };
  }

  private planAtDetail(se: ScreenErrorConfig, step: number): Plan {
    const cfg = this.config;
    const shape = cfg.shape;
    const scale = this.detailScale(step);
    const plan: Plan = { wanted: new Map(), prefetch: new Map(), preload: new Set(), split: new Set(), roots: this.planRoots(), levels: new Map() };
    const ahead = 1 + cfg.prefetch / cfg.splitLevel;
    const preloading = this.tickets.some((t) => t.preload);
    const apart = cfg.preloadBudgetBytes !== undefined;
    const visit = (c: CellId, prefetchOnly: boolean, preloadOnly = false): void => {
      const key = cellKey(c);
      // What is drawn follows the tickets that are not preloading; a preloading ticket fetches the cells it would split.
      const level = this.relativeLevel(c, se, scale, false);
      const fetch = preloading ? this.relativeLevel(c, se, scale, true) : Infinity;
      plan.levels.set(key, Math.min(level, fetch));
      if (prefetchOnly) plan.prefetch.set(key, c);
      else plan.wanted.set(key, c);
      if (apart && prefetchOnly && preloadOnly) plan.preload.add(key);
      if (c.level >= cfg.leafLevel) return;
      // Never descend below a cell that is not loaded: until it is, nothing could stand in for its children on the
      // screen, and its measured error is not known.
      const r = this.cells.get(key);
      if (!r || RANK[r.state] < RANK.MESHED) return;
      const share = this.errorShare(c, se);
      const split = !prefetchOnly && level <= share;
      if (split) plan.split.add(key);
      // Children that only a preloading ticket asks for (and everything under them) are marked as such.
      const own = split || level <= share * ahead;
      if (own || fetch <= share) for (const ch of shape.children(c)) visit(ch, !split, preloadOnly || !own);
    };
    for (const r of plan.roots) visit(r, false);
    for (const k of plan.wanted.keys()) plan.prefetch.delete(k);
    return plan;
  }

  /** `withinKeepBand` by the parent's key, for the step in progress (cleared when the step starts its pass over the records). */
  private readonly keepBand = new Map<string, boolean>();

  /** Is the cell still close enough to keep its GPU data (hysteresis)? */
  private withinKeepBand(cell: CellId): boolean {
    const cfg = this.config;
    if (cell.level <= cfg.rootLevel) return this.ticketLevel(cell) <= cfg.rootRange + cfg.hysteresis;
    const p = cfg.shape.parent(cell);
    if (p === null) return false;
    // The answer is the parent's, so the children of one parent ask once in a step.
    const key = cellKey(p);
    const known = this.keepBand.get(key);
    if (known !== undefined) return known;
    const se = cfg.screenError;
    const keep = se
      ? this.relativeLevel(p, se, this.detailScale(this.detailStep)) <= this.errorShare(p, se) * (1 + cfg.hysteresis / cfg.splitLevel)
      : this.ticketLevel(p) <= cfg.splitLevel + cfg.hysteresis;
    this.keepBand.set(key, keep);
    return keep;
  }

  /** Lexicographic priority, smaller first (see the design's job order). */
  private priority(r: CellRecord): number[] {
    const cfg = this.config;
    // 1. Missing drawable parent: a cell with nothing resident above it would leave a hole.
    let covered = 1;
    if (r.cell.level > cfg.rootLevel) {
      covered = 0;
      for (let p = cfg.shape.parent(r.cell); p && p.level >= cfg.rootLevel; p = cfg.shape.parent(p)) {
        if (this.cells.get(cellKey(p))?.state === 'RESIDENT') {
          covered = 1;
          break;
        }
      }
    } else covered = 0;
    // 2. Deficit: wanted on the GPU before prefetch.
    const deficit = r.want === 'resident' ? 0 : 1;
    // 3. Ticket level band, 4. direction of view or travel, 5. exact level.
    const facing = this.facingBucket(r.cell);
    // Selection by screen-space error: what lies in front of a ticket's direction goes first, then the nearest.
    const level = this.levelOf(r);
    if (cfg.screenError) return [covered, deficit, facing, level];
    const band = Math.floor(level);
    return [covered, deficit, band, facing, level];
  }

  /**
   * 0 = straight ahead of a ticket's direction … 3 = behind it. Cells without a directed ticket get 1. Both the
   * direction and the way to the cell's middle are taken across "up" at the ticket, so height plays no part.
   */
  private facingBucket(cell: CellId): number {
    const shape = this.config.shape;
    const c = shape.center(cell);
    const half = shape.edgeM(cell.level) / 2;
    let best = 3;
    let any = false;
    for (const t of this.tickets) {
      if (!t.dir) continue;
      any = true;
      const up = shape.upAt(t.center);
      let vx = c[0] - t.center[0];
      let vy = c[1] - t.center[1];
      let vz = c[2] - t.center[2];
      const vu = vx * up[0] + vy * up[1] + vz * up[2];
      vx -= up[0] * vu;
      vy -= up[1] * vu;
      vz -= up[2] * vu;
      let dx = t.dir[0];
      let dy = t.dir.length === 3 ? t.dir[1] : 0;
      let dz = t.dir.length === 3 ? t.dir[2] : t.dir[1];
      const du = dx * up[0] + dy * up[1] + dz * up[2];
      dx -= up[0] * du;
      dy -= up[1] * du;
      dz -= up[2] * du;
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < half * 1.5 || dl === 0) return 0;
      const cos = (vx * dx + vy * dy + vz * dz) / (len * dl);
      const b = cos > 0.7 ? 0 : cos > 0 ? 1 : cos > -0.7 ? 2 : 3;
      if (b < best) best = b;
    }
    return any ? best : 1;
  }

  private enforceBudget(actions: StreamingActions): void {
    let total = 0;
    let apart = 0;
    for (const r of this.cells.values()) {
      if (r.want === 'meshed' && this.plan.preload.has(r.key)) apart += r.cpuBytes + r.gpuBytes;
      else total += r.cpuBytes + r.gpuBytes;
    }
    // Cells of preload tickets alone count only with what they hold over their own room (`preloadBudgetBytes`).
    total += Math.max(0, apart - (this.config.preloadBudgetBytes ?? 0));
    const within = apart > 0 && apart <= (this.config.preloadBudgetBytes ?? 0);
    const budget = this.config.memoryBudgetBytes;
    // Untouched cells with no data and no job are dropped from bookkeeping at once.
    for (const r of this.sortedRecords()) {
      if (r.want === 'none' && r.state === 'NONE' && !r.inFlight) this.cells.delete(r.key);
    }
    if (total <= budget) return;
    const order: Record<Want, number> = { none: 0, keep: 1, meshed: 2, resident: 3 };
    const victims = [...this.cells.values()]
      .filter((r) => r.want !== 'resident' && r.state !== 'NONE' && !r.inFlight && !(within && r.want === 'meshed' && this.plan.preload.has(r.key)))
      .sort((a, b) => order[a.want] - order[b.want] || a.lastWanted - b.lastWanted || this.levelOf(b) - this.levelOf(a) || compareCells(a.cell, b.cell));
    for (const r of victims) {
      if (total <= budget) break;
      total -= r.cpuBytes + r.gpuBytes;
      if (r.state === 'RESIDENT' && !actions.releases.some((c) => cellKey(c) === r.key)) actions.releases.push(r.cell);
      actions.evictions.push(r.cell);
      this.cells.delete(r.key);
      this.totals.evicted++;
    }
  }

  /**
   * GPU bytes held by everything that is not a streamed cell (textures, other meshes, targets). The execution part
   * sets it from what the device reports; it only matters with `gpuBudgetBytes`.
   */
  gpuReserveBytes = 0;
  private gpuTotals = { released: 0, deferred: 0 };

  /** With `gpuBudgetBytes`: cells taken off the GPU to get under the ceiling, and uploads that had to wait (per step). */
  gpuPressure(): { released: number; deferred: number } {
    return { ...this.gpuTotals };
  }

  /**
   * The execution part lost every GPU object (a lost graphics context): cells on the GPU are MESHED again, so the
   * next step lists them as uploads and they are made again from their CPU data.
   */
  dropResident(): void {
    for (const r of this.cells.values()) {
      if (r.state !== 'RESIDENT') continue;
      if (r.refresh) {
        // Its CPU data are out of date too: forgotten, listed in the next step.
        this.forgetRefreshing(r, this.pendingCancels, null, this.pendingEvictions);
        continue;
      }
      r.state = 'MESHED';
      r.gpuBytes = 0;
    }
    this.computeCover();
  }

  /** A cell with out-of-date content leaves the GPU: its job is cancelled and it is forgotten (state NONE). */
  private forgetRefreshing(r: CellRecord, cancels: CellRequest[], releases: CellId[] | null, evictions: CellId[]): void {
    if (r.inFlight) {
      cancels.push({ cell: r.cell, key: r.key, epoch: r.epoch });
      r.epoch = ++this.epochSeq;
      r.inFlight = false;
      this.totals.cancelled++;
    }
    if (releases && !releases.some((c) => cellKey(c) === r.key)) releases.push(r.cell);
    evictions.push(r.cell);
    r.state = 'NONE';
    r.cpuBytes = 0;
    r.gpuBytes = 0;
    r.refresh = false;
    delete r.errorM;
    if (this.config.screenError) this.planStale = true;
  }

  private enforceGpuCeiling(actions: StreamingActions, ceiling: number): void {
    this.gpuTotals = { released: 0, deferred: 0 };
    const room = Math.max(0, ceiling - this.gpuReserveBytes);
    let total = 0;
    for (const r of this.cells.values()) total += r.gpuBytes;
    // What the uploads of this step would add. Cells nobody wants on the GPU make room for them too; otherwise a
    // cell kept only by hysteresis could hold a wanted one back for as long as the view stands.
    let asked = 0;
    for (const cell of actions.uploads) asked += this.cells.get(cellKey(cell))?.cpuBytes ?? 0;
    if (total + asked > room) {
      const victims = [...this.cells.values()].filter((r) => r.state === 'RESIDENT').map((r) => ({ r, k: this.priority(r) }));
      // Not wanted on the GPU first (longest ago first), then wanted ones in reverse order of urgency.
      victims.sort(
        (a, b) =>
          (a.r.want === 'resident' ? 1 : 0) - (b.r.want === 'resident' ? 1 : 0) ||
          (a.r.want === 'resident' ? comparePriority(b.k, a.k) : a.r.lastWanted - b.r.lastWanted) ||
          compareCells(b.r.cell, a.r.cell),
      );
      for (const { r } of victims) {
        // A wanted cell leaves only while the ceiling itself is broken.
        if (total + (r.want === 'resident' ? 0 : asked) <= room) break;
        // The coarsest cells are the cover of last resort: they stay.
        if (r.want === 'resident' && r.cell.level <= this.config.rootLevel) continue;
        total -= r.gpuBytes;
        this.gpuTotals.released++;
        if (r.refresh) {
          this.forgetRefreshing(r, actions.cancels, actions.releases, actions.evictions);
          continue;
        }
        r.state = 'MESHED';
        r.gpuBytes = 0;
        if (!actions.releases.some((c) => cellKey(c) === r.key)) actions.releases.push(r.cell);
      }
    }
    // Uploads in their order of urgency while they fit (a cell's GPU bytes are its CPU bytes).
    const fit: CellId[] = [];
    const releasedNow = new Set(actions.releases.map(cellKey));
    for (const cell of actions.uploads) {
      const r = this.cells.get(cellKey(cell));
      if (!r) continue;
      const first = r.cell.level <= this.config.rootLevel;
      if (!releasedNow.has(r.key) && (first || total + r.cpuBytes <= room)) {
        fit.push(cell);
        total += r.cpuBytes;
      } else this.gpuTotals.deferred++;
    }
    actions.uploads = fit;
  }

  /** Drawing cover of the wanted quadtree. */
  private computeCover(): void {
    const plan = this.plan;
    const out: CellId[] = [];
    let holes = 0;
    const resident = (c: CellId): boolean => this.cells.get(cellKey(c))?.state === 'RESIDENT';
    const visit = (c: CellId): void => {
      const kids = c.level < this.config.leafLevel ? this.config.shape.children(c) : [];
      const kidsReady = kids.length > 0 && kids.every(resident);
      if (plan.split.has(cellKey(c)) && kidsReady) for (const k of kids) visit(k);
      else if (resident(c)) out.push(c);
      // Only after a jump: the cell itself is missing but finer cells from before still cover it.
      else if (kidsReady) for (const k of kids) visit(k);
      else holes++;
    };
    for (const r of plan.roots) visit(r);
    this.drawnList = out;
    this.holes = holes;
  }
}

function comparePriority(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
