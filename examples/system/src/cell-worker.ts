// Worker script of the system example: generates and encodes cells of any of its bodies off the main thread. The
// seed of a job names the body (`packSeed` of world.ts), so one pool of workers serves them all.
//
// Jobs with a `kind` deal with the plan of the world (plan.ts): `plan` computes it and keeps it, `have-plan` keeps the
// bytes another worker computed (after checking their fingerprint), `plan-heights` gives the heights of one face,
// `cell` generates a cell of the planned body with the plan this worker holds (planned-cell.ts), `details` the
// details near the camera of one square (details.ts), `site` the structures of one cluster (structures.ts): its
// massing, or the intact full meshes of some of its items with the descriptions of their parts.
import type { CellId } from 'wallhammer-web/gen-core';
import { serveWorker } from 'wallhammer-web/platform';
import { encodeCell } from 'wallhammer-web/world';
import { generateDetails } from './details.ts';
import { PLAN_PROGRESS_CHANNEL } from './loader.ts';
import type { PlanProgress } from './loader.ts';
import { decodePlan, encodePlan, planHash, worldPlan } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { planFaceHeights } from './plan-water.ts';
import { generateWorldCell } from './planned-cell.ts';
import { clusterFull, clusterMassing } from './structures.ts';
import { generateBodyCell } from './world.ts';

type Job =
  | { kind?: undefined; seed: number; cell: CellId }
  | { kind: 'plan'; seed: number; stage: number; heights?: Float32Array }
  | { kind: 'have-plan'; seed: number; bytes: ArrayBuffer; hash: string }
  | { kind: 'plan-heights'; seed: number; face: number }
  | { kind: 'cell'; seed: number; cell: CellId; stage: number }
  | { kind: 'details'; seed: number; stage: number; face: number; i: number; j: number; mask: number }
  | { kind: 'site'; seed: number; stage: number; cluster: number; level: 'massing' }
  | { kind: 'site'; seed: number; stage: number; cluster: number; level: 'full'; items: number[] };

/** The plan this worker holds; the `cell` jobs read it. */
let plan: WorldPlan | null = null;

serveWorker((message) => {
  const job = message as Job;
  switch (job.kind) {
    case undefined: {
      const bytes = encodeCell(generateBodyCell(job.seed, Object.freeze({ ...job.cell })));
      return { value: bytes.buffer, transfer: [bytes.buffer] };
    }
    case 'plan': {
      const ms: Record<string, number> = {};
      const t0 = performance.now();
      let last = t0;
      // The end of every phase also goes to the page's loader (loader.ts); only the page reads it, the plan does not.
      const progress = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(PLAN_PROGRESS_CHANNEL) : null;
      const post = (phase: string): void => progress?.postMessage({ seed: job.seed, stage: job.stage, phase } satisfies PlanProgress);
      const mark = (phase: string): void => {
        const now = performance.now();
        ms[phase] = now - last;
        last = now;
        post(phase);
      };
      let bytes: ReturnType<typeof encodePlan>;
      try {
        plan = worldPlan(job.seed, job.stage, { ...(job.heights ? { heights: job.heights } : {}), mark });
        bytes = encodePlan(plan);
        post('sent');
      } finally {
        progress?.close();
      }
      ms.total = performance.now() - t0;
      return { value: { bytes: bytes.buffer, ms }, transfer: [bytes.buffer] };
    }
    case 'have-plan': {
      const p = decodePlan(job.bytes);
      const hash = planHash(p, 'water');
      if (p.seed !== job.seed || hash !== job.hash) throw new Error(`plan: this worker read fingerprint ${hash}, the page has ${job.hash}`);
      plan = p;
      return { value: hash };
    }
    case 'plan-heights': {
      const h = planFaceHeights(job.seed, job.face);
      return { value: h, transfer: [h.buffer] };
    }
    case 'cell': {
      if (!plan) throw new Error('cell: this worker holds no plan');
      const bytes = encodeCell(generateWorldCell(job.seed, Object.freeze({ ...job.cell }), plan, job.stage));
      return { value: bytes.buffer, transfer: [bytes.buffer] };
    }
    case 'details': {
      if (!plan) throw new Error('details: this worker holds no plan');
      const d = generateDetails(job.seed, plan, job.stage, { face: job.face, i: job.i, j: job.j }, job.mask);
      const value = { anchor: d.anchor, radiusM: d.radiusM, data: d.records.data, start: d.records.start };
      return { value, transfer: [d.records.data.buffer, d.records.start.buffer] };
    }
    case 'site': {
      if (!plan) throw new Error('site: this worker holds no plan');
      if (job.level === 'massing') {
        const m = clusterMassing(plan, job.cluster);
        return { value: m, transfer: [m.mesh.vertices.buffer, (m.mesh.indices as Uint32Array).buffer, m.spans.buffer, m.indexSpans.buffer, m.keys.buffer] };
      }
      const full = clusterFull(plan, job.cluster, job.items);
      return { value: full, transfer: full.map((f) => f.mesh.vertices.buffer) };
    }
  }
});

/** For a debugger: whether this worker holds a plan. */
export const holdsPlan = (): boolean => plan !== null;
