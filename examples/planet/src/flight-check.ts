// The scripted flight run through the streaming manager without a browser: the camera of every step becomes the
// tickets of that step, and a stand-in for the workers and the uploads finishes a fixed number of jobs per step.
// It answers what can be answered without an image: is the sphere covered at every moment of the flight (no hole,
// nothing drawn twice), does the plan stay inside its budget of cells, and how many cells and bytes are held at the
// worst moment. Used by scripts/verify.ts with the real generator and by the golden test of the workspace.

import type { CellId } from 'wallhammer-web/gen-core';
import { cellKey } from 'wallhammer-web/gen-core';
import { DEFAULT_STREAMING, StreamingManager } from 'wallhammer-web/world';
import type { CellRequest, StreamingConfig, Ticket } from 'wallhammer-web/world';
import { flightDuration, flightPose } from './flight.ts';
import type { FlightPlan } from './flight.ts';
import { LEAF_LEVEL, RADIUS_M, ROOT_LEVEL, SELECTION, SHAPE } from './world.ts';

type V3 = readonly [number, number, number];

/** What the stand-in executor needs to know about a finished cell. */
export interface CellCost {
  cpuBytes: number;
  gpuBytes: number;
  /** Measured error of the content in metres (`CellContent.error`). */
  errorM: number;
}

export interface FlightCheckOptions {
  plan: FlightPlan;
  /** Unit direction of the start from the centre, and the height of the surface there. */
  dir: V3;
  groundM: number;
  /** Seconds of the flight per step. */
  stepS: number;
  /** Pixels one radian covers on the viewer's screen. */
  pixelsPerRadian: number;
  /** Budget of cells (`ScreenErrorConfig.maxCells`). */
  maxCells: number;
  /** Jobs that finish and cells that are uploaded per step, at most. A job takes at least two steps. */
  jobsPerStep: number;
  uploadsPerStep: number;
  /** Cost and error of a cell; called once per finished job. */
  costOf: (cell: CellId) => CellCost;
}

export interface FlightCheckResult {
  /** Steps in all: loading the start view, the flight, settling after the landing. */
  steps: number;
  requested: number;
  completed: number;
  cancelled: number;
  evicted: number;
  /** Most cells wanted, drawn and held on the GPU at one step, and the most bytes held. */
  peakWanted: number;
  peakDrawn: number;
  peakResident: number;
  peakGpuBytes: number;
  peakCpuBytes: number;
  /** Lowest share of the full detail the budget of cells allowed (1 = never lowered). */
  lowestDetail: number;
  /** Finest level drawn during the flight. */
  finestLevel: number;
  /** Steps of the flight alone. */
  flightSteps: number;
  /** Steps of the flight at which some wanted cell was not drawn yet (its parent stood in). */
  stepsBehind: number;
  /** Steps after the landing until everything wanted was drawn. */
  stepsToSettle: number;
  /** One line per step: what was drawn. For hashing. */
  trace: string[];
}

/** Streaming configuration of the example for a budget of cells; main.ts builds the same one. */
export function flightStreaming(maxCells: number): StreamingConfig {
  return { ...DEFAULT_STREAMING, shape: SHAPE, rootLevel: ROOT_LEVEL, leafLevel: LEAF_LEVEL, rootRange: Infinity, prefetch: 0.2, hysteresis: 0.3, maxInFlight: 12, memoryBudgetBytes: 320 * 1024 * 1024, screenError: { ...SELECTION, maxCells } };
}

const cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (v: V3): [number, number, number] => {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Flies the plan and checks the cover at every step. Throws on a violation: a cell drawn on top of another, a face
 * of the cube that lost its cover or is covered in part, a child requested before its parent is loaded, more cells
 * wanted than the budget, or a flight that does not settle after the landing.
 */
export function checkFlight(o: FlightCheckOptions): FlightCheckResult {
  const config = flightStreaming(o.maxCells);
  const m = new StreamingManager(config);
  const total = flightDuration(o.plan);
  const flightSteps = Math.ceil(total / o.stepS);
  // A direction along the ground at the start, for the heading of the view.
  const ahead = unit3(cross(o.dir, Math.abs(o.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const left = cross(o.dir, ahead);
  const queue: { req: CellRequest; due: number }[] = [];
  const res: FlightCheckResult = { steps: 0, requested: 0, completed: 0, cancelled: 0, evicted: 0, peakWanted: 0, peakDrawn: 0, peakResident: 0, peakGpuBytes: 0, peakCpuBytes: 0, lowestDetail: 1, finestLevel: ROOT_LEVEL, flightSteps: flightSteps + 1, stepsBehind: 0, stepsToSettle: 0, trace: [] };
  const costs = new Map<string, CellCost>();
  let covered = new Set<string>();
  const settleLimit = 4000;
  // Step of the flight; −1 while the start view loads, before the clock of the flight runs.
  let k = -1;
  for (let s = 0; ; s++) {
    const pose = flightPose(o.plan, RADIUS_M, k < 0 ? 0 : Math.min(total, k * o.stepS));
    const r = RADIUS_M + o.groundM + pose.heightM;
    const eye: [number, number, number] = [o.dir[0] * r, o.dir[1] * r, o.dir[2] * r];
    const turn = (pose.turnDeg * Math.PI) / 180;
    const pitch = (pose.pitchDeg * Math.PI) / 180;
    const t = [0, 1, 2].map((i) => ahead[i]! * Math.cos(turn) + left[i]! * Math.sin(turn));
    const forward: [number, number, number] = [t[0]! * Math.cos(pitch) - o.dir[0] * Math.sin(pitch), t[1]! * Math.cos(pitch) - o.dir[1] * Math.sin(pitch), t[2]! * Math.cos(pitch) - o.dir[2] * Math.sin(pitch)];
    const px = { pixelsPerRadian: o.pixelsPerRadian };
    const tickets: Ticket[] = [{ id: 'camera', kind: 'camera', center: eye, altitude: pose.heightM, base: 0, dir: forward, ...px }];
    // As `viewerTickets` of the engine: a second ticket two seconds ahead while the camera moves.
    if (Math.abs(pose.climbMs) > 0.5) {
      const v: V3 = [o.dir[0] * pose.climbMs, o.dir[1] * pose.climbMs, o.dir[2] * pose.climbMs];
      tickets.push({ id: 'predict', kind: 'predict', center: [eye[0] + v[0] * 2, eye[1] + v[1] * 2, eye[2] + v[2] * 2], altitude: pose.heightM, base: 1, dir: v, ...px });
    }
    const a = m.update(tickets);
    for (const c of a.cancels) {
      const i = queue.findIndex((j) => j.req.key === c.key && j.req.epoch === c.epoch);
      if (i >= 0) queue.splice(i, 1);
    }
    for (const req of a.requests) {
      if (req.cell.level > ROOT_LEVEL) {
        const ps = m.state(SHAPE.parent(req.cell)!);
        if (ps !== 'MESHED' && ps !== 'RESIDENT') throw new Error(`flight: step ${s} requests ${req.key} while its parent is ${ps}`);
      }
      queue.push({ req, due: s + 2 });
    }
    for (const c of a.uploads.slice(0, o.uploadsPerStep)) m.resident(c, costs.get(cellKey(c))?.gpuBytes ?? 0);
    let done = 0;
    for (let i = 0; i < queue.length && done < o.jobsPerStep; ) {
      if (queue[i]!.due > s) {
        i++;
        continue;
      }
      const { req } = queue.splice(i, 1)[0]!;
      const cost = o.costOf(req.cell);
      costs.set(req.key, cost);
      m.complete(req, cost.cpuBytes, cost.errorM);
      done++;
    }

    const c = m.counters();
    if (c.wanted > o.maxCells) throw new Error(`flight: step ${s} wants ${c.wanted} cells, the budget is ${o.maxCells}`);
    if (c.inFlight > config.maxInFlight) throw new Error(`flight: step ${s} has ${c.inFlight} jobs in flight`);
    const drawn = m.drawn();
    const keys = new Set(drawn.map(cellKey));
    // Nothing is drawn on top of anything: no drawn cell has a drawn cell above it in its quadtree.
    for (const d of drawn) {
      for (let p = SHAPE.parent(d); p; p = SHAPE.parent(p)) {
        if (keys.has(cellKey(p))) throw new Error(`flight: step ${s} draws ${cellKey(d)} and ${cellKey(p)} on top of each other`);
      }
    }
    // Share of each face that is drawn, in units of the finest level (exact in doubles).
    const share = [0, 0, 0, 0, 0, 0];
    for (const d of drawn) share[d.face]! += 4 ** (LEAF_LEVEL - d.level);
    const now = new Set<string>();
    for (let face = 0; face < 6; face++) {
      const key = String(face);
      if (share[face] === 4 ** LEAF_LEVEL) now.add(key);
      else if (share[face] !== 0) throw new Error(`flight: step ${s} covers ${share[face]! / 4 ** LEAF_LEVEL} of face ${face}`);
      else if (covered.has(key)) throw new Error(`flight: step ${s} lost the cover of face ${face}`);
    }
    covered = now;
    for (const d of drawn) if (d.level > res.finestLevel) res.finestLevel = d.level;
    res.peakWanted = Math.max(res.peakWanted, c.wanted);
    res.peakDrawn = Math.max(res.peakDrawn, c.drawn);
    res.peakResident = Math.max(res.peakResident, c.states.RESIDENT);
    res.peakGpuBytes = Math.max(res.peakGpuBytes, c.gpuBytes);
    res.peakCpuBytes = Math.max(res.peakCpuBytes, c.cpuBytes);
    res.lowestDetail = Math.min(res.lowestDetail, c.detail);
    res.trace.push(`${s}|${drawn.length}|${[...keys].sort().join(';')}|${c.holes}|${c.settled}|${c.detail}`);
    res.steps = s + 1;
    const settled = c.settled && covered.size === 6 && queue.length === 0;
    if (k < 0) {
      if (settled) k = 0;
      else if (s > settleLimit) throw new Error(`flight: the start view is not settled after ${settleLimit} steps (wanted ${c.wanted}, drawn ${c.drawn})`);
    } else if (k <= flightSteps) {
      if (!settled) res.stepsBehind++;
      k++;
    } else if (settled) {
      if (c.holes !== 0) throw new Error(`flight: ${c.holes} holes after the landing`);
      res.requested = c.requested;
      res.completed = c.completed;
      res.cancelled = c.cancelled;
      res.evicted = c.evicted;
      return res;
    } else {
      res.stepsToSettle++;
      if (res.stepsToSettle > settleLimit) throw new Error(`flight: not settled ${settleLimit} steps after the landing (wanted ${c.wanted}, drawn ${c.drawn}, in flight ${c.inFlight}, queued ${c.queued})`);
    }
  }
}
