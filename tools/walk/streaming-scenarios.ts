// Scenarios of preloading streamed cells along a coming path (world `StreamingManager.prefetched`, runtime
// `preloadTickets`), run by check:walk as their own group. Plain Node: a manager over a flat world with selection by
// screen-space error, jobs that finish at once and uploads that succeed at once.

import { FlatWorld, cellKey } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import type { CellId, WorldPos } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { preloadTickets, viewerTickets } from '../../packages/wallhammer-web/src/runtime/streaming.ts';
import { DEFAULT_STREAMING, StreamingManager } from '../../packages/wallhammer-web/src/world/index.ts';
import type { StreamingConfig, Ticket } from '../../packages/wallhammer-web/src/world/index.ts';
import { fail, pass, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

const CONFIG: StreamingConfig = {
  ...DEFAULT_STREAMING,
  shape: new FlatWorld(4096),
  rootLevel: 0,
  leafLevel: 6,
  rootRange: 2,
  prefetch: 0.2,
  hysteresis: 0.3,
  maxInFlight: 32,
  memoryBudgetBytes: 1e9,
  screenError: { errorPerEdge: 1 / 256, maxErrorPx: 2, pixelsPerRadian: 1158 },
};
const A: WorldPos = [100, 30, -200];
const B: WorldPos = [14000, 40, 9000];

/** Steps with jobs and uploads that finish at once, until `done` holds or the step limit is reached. */
function run(m: StreamingManager, tickets: Ticket[], done: () => boolean, limit = 2000): number {
  for (let step = 1; step <= limit; step++) {
    const a = m.update(tickets);
    for (const c of a.uploads) m.resident(c, 1000);
    for (const r of a.requests) m.complete(r, 1000);
    if (done() && !m.stale) return step;
  }
  return -1;
}

const viewer = (eye: WorldPos): Ticket[] => viewerTickets({ eye, altitude: eye[1], forward: [0, 0, -1] });

/** Bytes every cell holds on the CPU, and as much again on the GPU once uploaded. */
const CELL_BYTES = 1000;

/** Steps a view stands after it came to rest, in which it must ask for nothing and forget nothing. */
const TAIL = 100;

/**
 * A view held still over a manager with the given memory budget; jobs and uploads finish at once. The view first
 * warms up until a quiet step (settled, nothing stale, no request, upload or eviction; at most `warmup` steps), then
 * stands for `tail` more steps. Counts the requests and evictions of those `tail` steps (a view that stands should ask
 * for nothing), the largest number of bytes held after a step of the tail (`maxHeld`) and of the whole run
 * (`peakHeld`: the first steps may go over while the size of a cell is not known yet). A view that never comes to
 * rest uses up the warm-up and is measured anyway, so its tail shows the churn.
 */
function hold(config: StreamingConfig, tickets: Ticket[], tail = TAIL, warmup = 400): { m: StreamingManager; quietAt: number; lateRequests: number; lateEvictions: number; maxHeld: number; peakHeld: number } {
  const m = new StreamingManager(config);
  let lateRequests = 0;
  let lateEvictions = 0;
  let maxHeld = 0;
  let peakHeld = 0;
  let quietAt = -1; // step of the first quiet step, -1 when the warm-up ran out without one
  let warm = false;
  let measured = 0;
  for (let step = 1; !warm || measured < tail; step++) {
    const a = m.update(tickets);
    for (const c of a.uploads) m.resident(c, CELL_BYTES);
    for (const r of a.requests) m.complete(r, CELL_BYTES);
    const c = m.counters();
    const held = c.cpuBytes + c.gpuBytes;
    peakHeld = Math.max(peakHeld, held);
    if (!warm) {
      const quiet = a.requests.length === 0 && a.uploads.length === 0 && a.evictions.length === 0 && m.settled && !m.stale;
      if (quiet) quietAt = step;
      warm = quiet || step >= warmup;
      continue;
    }
    measured++;
    lateRequests += a.requests.length;
    lateEvictions += a.evictions.length;
    maxHeld = Math.max(maxHeld, held);
  }
  return { m, quietAt, lateRequests, lateEvictions, maxHeld, peakHeld };
}

/** Wanted and prefetched cells of a view with room for everything, computed once per configuration and view. */
const plans = new Map<string, { wanted: number; prefetch: number }>();
function fullPlan(config: StreamingConfig, tickets: Ticket[], key: string): { wanted: number; prefetch: number } {
  let plan = plans.get(key);
  if (!plan) {
    const { m } = hold({ ...config, memoryBudgetBytes: 1e12 }, tickets, 0);
    const c = m.counters();
    plan = { wanted: c.wanted, prefetch: c.states.MESHED };
    plans.set(key, plan);
  }
  return plan;
}

export const STREAMING_SCENARIOS: Scenario[] = [
  {
    name: 'preload-tickets-shape',
    run() {
      const t = preloadTickets([{ eye: A, altitude: -3, forward: [1, 0, 0], pixelsPerRadian: 900 }, { eye: B, altitude: 40 }], 'path');
      const ok = t.length === 2 && t[0]!.id === 'path-000' && t[1]!.id === 'path-001' && t.every((x) => x.preload === true && x.base === 0 && x.kind === 'travel') && t[0]!.altitude === 0 && t[0]!.pixelsPerRadian === 900 && t[1]!.dir === undefined;
      return ok ? pass(`ids ${t.map((x) => x.id).join(', ')}, preload, base 0, altitude clamped to 0`) : fail(JSON.stringify(t));
    },
  },
  {
    name: 'preload-loads-what-the-viewer-will-need',
    run() {
      // The viewer at A with a preload ticket at B, until everything is loaded.
      const m = new StreamingManager(CONFIG);
      const tickets = [...viewer(A), ...preloadTickets([{ eye: B, altitude: B[1] }])];
      run(m, tickets, () => false, 1);
      const early = m.prefetched;
      const steps = 1 + run(m, tickets, () => m.prefetched);
      // The viewer at B alone: every cell it wants must already be loaded in the first manager.
      const there = new StreamingManager(CONFIG);
      run(there, viewer(B), () => there.settled);
      const missing = there.wanted().filter((c) => m.state(c) !== 'MESHED' && m.state(c) !== 'RESIDENT');
      // The viewer at A alone draws the same cover; the preload ticket adds only cells under roots it brought in
      // (the coarsest cells near any ticket are wanted), which the viewer alone does not draw at all.
      const here = new StreamingManager(CONFIG);
      run(here, viewer(A), () => here.settled);
      const mine = new Set(m.drawn().map(cellKey));
      const hereKeys = new Set(here.drawn().map(cellKey));
      const extra = m.drawn().filter((c) => !hereKeys.has(cellKey(c)));
      const rootOf = (c: CellId): string => {
        let r = c;
        while (r.level > CONFIG.rootLevel) r = CONFIG.shape.parent(r)!;
        return cellKey(r);
      };
      const hereRoots = new Set(here.drawn().map(rootOf));
      const same = [...hereKeys].every((k) => mine.has(k)) && extra.every((c) => !hereRoots.has(rootOf(c)));
      const ok = !early && steps > 1 && m.settled && missing.length === 0 && same;
      const detail = `prefetched after ${steps} steps (not after the first: ${!early}); ${there.wanted().length} cells wanted at B, ${missing.length} not loaded; cover at A unchanged: ${same} (${here.drawn().length} cells, ${extra.length} more under roots near B)`;
      return ok ? pass(detail) : fail(detail);
    },
  },
  {
    name: 'memory-budget-lowers-detail-instead-of-refetching',
    run() {
      // The full plan holds more than the budget: before, the budget forgot the prefetched cells in every step and the
      // next step asked for them again, for ever. The plan must shrink to fit and the view must come to rest.
      const tickets = viewer(A);
      const full = fullPlan(CONFIG, tickets, 'error A');
      const budget = Math.round(full.wanted * 2 * CELL_BYTES * 0.8);
      const r = hold({ ...CONFIG, memoryBudgetBytes: budget }, tickets);
      const c = r.m.counters();
      const detail = `full plan ${full.wanted} wanted + ${full.prefetch} prefetched; budget ${budget} B: detail ${c.detail.toFixed(2)}, ${c.wanted} wanted, at rest after ${r.quietAt} steps, next ${TAIL} steps ${r.lateRequests} requests and ${r.lateEvictions} evictions, settled ${r.m.settled}, queued ${c.queued}, held ${r.maxHeld} B (peak ${r.peakHeld} B while sizes were unknown)`;
      return verdict(r.quietAt > 0 && r.lateRequests === 0 && r.lateEvictions === 0 && r.m.settled && c.queued === 0 && c.detail < 1 && r.maxHeld <= budget, detail);
    },
  },
  {
    name: 'prefetch-waits-for-room-in-the-budget',
    run() {
      // Selection by ticket level (no detail to lower): the wanted cells fit, the prefetched ones only in part. Those
      // without room are not asked for, so nothing is forgotten and asked for again, and the view settles.
      const config: StreamingConfig = { ...CONFIG, screenError: undefined, splitLevel: 1.5, prefetch: 0.5 };
      delete config.screenError;
      const tickets = viewer(A);
      const full = fullPlan(config, tickets, 'level A');
      const budget = full.wanted * 2 * CELL_BYTES + Math.floor(full.prefetch / 2) * CELL_BYTES;
      const r = hold({ ...config, memoryBudgetBytes: budget }, tickets);
      const c = r.m.counters();
      const detail = `full plan ${full.wanted} wanted + ${full.prefetch} prefetched; budget ${budget} B: ${c.states.MESHED} prefetched, at rest after ${r.quietAt} steps, next ${TAIL} steps ${r.lateRequests} requests and ${r.lateEvictions} evictions, settled ${r.m.settled}, queued ${c.queued}, prefetched all ${r.m.prefetched}, held ${r.maxHeld} B (peak ${r.peakHeld} B)`;
      return verdict(full.prefetch > 1 && r.quietAt > 0 && r.lateRequests === 0 && r.lateEvictions === 0 && r.m.settled && c.queued === 0 && !r.m.prefetched && c.states.MESHED > 0 && r.peakHeld <= budget, detail);
    },
  },
  {
    name: 'preload-budget-keeps-the-detail-of-the-view',
    run() {
      // A budget that just holds the view at A, and a second place B asked for by preload tickets. In the shared
      // budget B either lowers the detail at A or finds no room; with `preloadBudgetBytes` A is as without B and B is
      // loaded whole, ready to be uploaded ahead (`ahead`).
      const tickets = viewer(A);
      const both = [...tickets, ...viewer(B).map((t) => ({ ...t, id: `b-${t.id}`, preload: true }))];
      const full = fullPlan(CONFIG, tickets, 'error A');
      const budget = Math.round((full.wanted * 2 + full.prefetch) * CELL_BYTES * 1.05);
      const alone = hold({ ...CONFIG, memoryBudgetBytes: budget }, tickets);
      const shared = hold({ ...CONFIG, memoryBudgetBytes: budget }, both);
      const apart = hold({ ...CONFIG, memoryBudgetBytes: budget, preloadBudgetBytes: 1e9 }, both);
      const a = alone.m.counters(), s = shared.m.counters(), p = apart.m.counters();
      const hurt = s.detail < a.detail || !shared.m.prefetched;
      // (The roots near B are wanted as for any ticket, so a few more cells are wanted than alone.)
      const kept = p.detail === a.detail && p.wanted >= a.wanted && apart.m.prefetched && apart.quietAt > 0 && apart.lateRequests === 0 && apart.lateEvictions === 0;
      const waiting = apart.m.ahead().length;
      const detail = `alone: detail ${a.detail.toFixed(2)}, ${a.wanted} wanted; shared budget with B: detail ${s.detail.toFixed(2)}, prefetched ${shared.m.prefetched}; own room for B: detail ${p.detail.toFixed(2)}, ${p.wanted} wanted, prefetched ${apart.m.prefetched}, ${waiting} cells wait ahead (${a.states.MESHED} without B), at rest after ${apart.quietAt} steps, next ${TAIL} steps ${apart.lateRequests} requests and ${apart.lateEvictions} evictions`;
      return verdict(hurt && kept && waiting > a.states.MESHED, detail);
    },
  },
];
