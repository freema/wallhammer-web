// The loader of the system example: a small panel in the lower middle of the page while the plan of the world is
// computed (its phase, a bar weighted by the usual time of each phase, the seconds since the start) and then while the
// surface under the camera loads for the first time (the share of the wanted cells that are done). It fades out once
// the surface has settled and comes back only after a jump to another place. It takes no pointer events.
//
// The plan job of the worker (cell-worker.ts) posts the end of each phase on a BroadcastChannel: the engine's worker
// pool takes every message of a worker for the reply of its job, so the progress cannot travel on that path.

/** Name of the channel the plan job posts its phases on. */
export const PLAN_PROGRESS_CHANNEL = 'wallhammer-system-plan-progress';

/** One message of the plan job: the phase `phase` of the plan of (`seed`, `stage`) has ended. */
export interface PlanProgress {
  seed: number;
  stage: number;
  phase: string;
}

/**
 * The phases of the plan in order: the key `worldPlan` marks at its end (`sent`: the worker has encoded the bytes
 * for the page), its label in the loader, its usual seconds in a worker of the browser and the least plan stage
 * that has it. The last one ends when the page holds the plan (every worker has its copy).
 */
const PHASES: readonly { key: string; label: string; s: number; from: number }[] = [
  { key: 'heights', label: 'heights', s: 7.2, from: 1 },
  { key: 'drainage', label: 'drainage', s: 2.3, from: 1 },
  { key: 'channels', label: 'river channels', s: 1.0, from: 1 },
  { key: 'lines', label: 'river courses', s: 0.2, from: 1 },
  { key: 'tiles', label: 'map tiles', s: 1.3, from: 1 },
  { key: 'moisture', label: 'climate', s: 1.9, from: 2 },
  { key: 'sites', label: 'settlements', s: 5.3, from: 3 },
  { key: 'routes', label: 'roads', s: 6.7, from: 4 },
  { key: 'bytes', label: 'writing the plan', s: 0.4, from: 1 },
  { key: 'sent', label: 'writing the plan', s: 0.3, from: 1 },
  { key: 'arrived', label: 'handing the plan to the workers', s: 0.8, from: 1 },
];

/** The surface counts as settled only this long after the loader started waiting for it, ms. */
const SETTLE_GRACE_MS = 600;

/** What the page tells the loader on each refresh. */
export interface LoaderState {
  /** The plan is there (or has failed). */
  planDone: boolean;
  /** The surface under the camera: wanted cells and those done; null when no surface is streamed. */
  cells: { wanted: number; done: number } | null;
  /** The view has loaded: the plan, the surface and the details round the camera. */
  settled: boolean;
  /** A script drives the page: no loader in its pictures. */
  hidden: boolean;
}

export interface Loader {
  /** On every refresh of the page. */
  update(s: LoaderState): void;
  /** After a jump to another place: the surface part again until it settles (nothing while the plan is computed). */
  rearm(): void;
  /** At once out of the picture (a script takes the view over); `update` with `hidden` keeps it so. */
  hide(): void;
}

const CSS = `
#loader { position: fixed; left: 50%; bottom: 52px; transform: translateX(-50%); min-width: 300px; margin: 0;
  padding: 8px 12px 9px; font: 12px/1.45 ui-monospace, Menlo, monospace; color: #f2f4f6;
  background: rgba(16, 22, 28, 0.62); border-radius: 4px; pointer-events: none; white-space: pre;
  opacity: 1; transition: opacity 0.6s ease; }
#loader.gone { opacity: 0; }
#loader.off { display: none; }
#loader .title { font-weight: 600; }
#loader .bar { height: 4px; margin: 6px 0 5px; background: rgba(242, 244, 246, 0.16); border-radius: 2px; overflow: hidden; }
#loader .fill { height: 100%; width: 0; background: #9fd0ff; transition: width 0.25s linear; }
#loader .line { color: #c9d2dc; }
`;

/** The loader of the plan `seed`, `stage`; `plan`: false when the page has no plan (then only jumps show it). */
export function createLoader(o: { seed: number; stage: number; plan: boolean }): Loader {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.id = 'loader';
  const title = document.createElement('div');
  title.className = 'title';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'fill';
  bar.append(fill);
  const line = document.createElement('div');
  line.className = 'line';
  el.append(title, bar, line);
  document.body.append(el);

  const phases = PHASES.filter((p) => o.stage >= p.from);
  const total = phases.reduce((n, p) => n + p.s, 0);
  /** Index of the phase being computed (all before it have ended), and when it began. */
  let current = 0;
  let phaseAt = performance.now();
  const startedAt = phaseAt;
  let mode: 'plan' | 'surface' | 'done' = o.plan ? 'plan' : 'done';
  let surfaceAt = 0;

  const channel = o.plan && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(PLAN_PROGRESS_CHANNEL) : null;
  if (channel) {
    channel.onmessage = (e: MessageEvent<PlanProgress>) => {
      const m = e.data;
      if (!m || m.seed !== o.seed || m.stage !== o.stage) return;
      const i = phases.findIndex((p) => p.key === m.phase);
      if (i >= current) {
        current = i + 1;
        phaseAt = performance.now();
      }
    };
  }

  const show = (visible: boolean): void => {
    el.classList.remove('off');
    el.classList.toggle('gone', !visible);
  };
  const seconds = (from: number): string => `${((performance.now() - from) / 1000).toFixed(0)} s`;
  if (mode === 'done') el.classList.add('off');

  return {
    update(s) {
      if (s.hidden) {
        el.classList.add('off');
        return;
      }
      if (mode === 'plan' && s.planDone) {
        channel?.close();
        mode = 'surface';
        surfaceAt = performance.now();
      }
      if (mode === 'plan') {
        let done = 0;
        for (let i = 0; i < current && i < phases.length; i++) done += phases[i]!.s;
        const p = phases[Math.min(current, phases.length - 1)]!;
        // Within a phase: its usual time, never past nine tenths of it before its end is posted.
        const within = current < phases.length ? Math.min(0.9, (performance.now() - phaseAt) / 1000 / p.s) * p.s : 0;
        const share = Math.min(1, (done + within) / total);
        title.textContent = 'Computing the world plan';
        fill.style.width = `${(share * 100).toFixed(1)}%`;
        line.textContent = `${p.label} · ${Math.round(share * 100)} % · ${seconds(startedAt)}`;
        show(true);
        return;
      }
      if (mode === 'surface') {
        // A moment after the arming first: right after a jump the streaming has not seen the new place yet.
        if (s.settled && performance.now() - surfaceAt > SETTLE_GRACE_MS) {
          mode = 'done';
          fill.style.width = '100%';
          show(false);
          return;
        }
        const c = s.cells;
        const share = c && c.wanted > 0 ? Math.min(1, c.done / c.wanted) : 0;
        title.textContent = 'Building the surface';
        fill.style.width = `${(share * 100).toFixed(1)}%`;
        line.textContent = `${c ? `${c.done} of ${c.wanted} cells` : 'waiting for cells'} · ${Math.round(share * 100)} % · ${seconds(surfaceAt)}`;
        show(true);
        return;
      }
      if (!el.classList.contains('gone')) show(false);
    },
    rearm() {
      if (mode !== 'done') return;
      mode = 'surface';
      surfaceAt = performance.now();
    },
    hide() {
      el.classList.add('off');
    },
  };
}
