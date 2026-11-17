// Web Workers and network reads: the only place in the engine that touches the Worker API or fetch. A pool of module
// workers runs pure jobs off the main thread; typed arrays travel as transferred buffers, never copied. Jobs wait in
// one queue and each worker runs one job at a time, so a job that is cancelled before it starts never runs and one
// that is running finishes and is dropped by its caller.

/** A job handed to the pool. */
export interface WorkerJob<R> {
  readonly promise: Promise<R>;
  /** Removes the job from the queue if it has not started; a running job finishes and its promise rejects. */
  cancel(): void;
}

interface Pending {
  id: number;
  message: unknown;
  transfer: Transferable[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
  /** Part of a `broadcast`: its reply does not count in `timing`. */
  broadcast?: boolean;
}

interface Reply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  ms?: number;
}

/** Threads the machine offers, as the browser reports them (at least 1). */
export function hardwareThreads(): number {
  return typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 1;
}

/** Can module workers be created here? (False in Node and in old browsers.) */
export function workersAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

export class WorkerPool {
  readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly running = new Map<Worker, Pending>();
  private readonly queue: Pending[] = [];
  /** Per worker: copies of broadcast messages it has still to get, in the order sent. They go before the queue. */
  private readonly direct = new Map<Worker, Pending[]>();
  private nextId = 1;
  /** Time the workers spent in jobs, from their own clock: total and count. */
  readonly timing = { ms: 0, jobs: 0 };

  /** `url` is a module worker script that calls `serveWorker`. */
  constructor(url: URL | string, size: number = Math.max(1, Math.min(4, hardwareThreads() - 1))) {
    this.size = size;
    for (let i = 0; i < size; i++) {
      const w = new Worker(url, { type: 'module', name: `wh-worker-${i}` });
      w.onmessage = (e: MessageEvent<Reply>) => this.finish(w, e.data);
      w.onerror = (e: ErrorEvent) => {
        const p = this.running.get(w);
        if (p) this.finish(w, { id: p.id, ok: false, error: e.message || 'worker error' });
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Jobs waiting for a worker. */
  get queued(): number {
    return this.queue.length;
  }

  /** Jobs running now. */
  get busy(): number {
    return this.running.size;
  }

  run<R>(message: unknown, transfer: Transferable[] = []): WorkerJob<R> {
    let p!: Pending;
    const promise = new Promise<R>((resolve, reject) => {
      p = { id: this.nextId++, message, transfer, resolve: resolve as (v: unknown) => void, reject, cancelled: false };
    });
    this.queue.push(p);
    this.pump();
    return {
      promise,
      cancel: () => {
        if (p.cancelled) return;
        p.cancelled = true;
        const i = this.queue.indexOf(p);
        if (i >= 0) this.queue.splice(i, 1);
        p.reject(abortError());
      },
    };
  }

  /**
   * Posts one structured copy of `message` to every worker of the pool (no transfer list): at once to a free worker,
   * right after its running job to a busy one, in either case before any queued job; two broadcasts reach a worker in
   * the order sent. Resolves when every worker has answered, rejects with the first error, and with an `AbortError`
   * after `dispose`. The replies do not count in `timing`.
   */
  broadcast(message: unknown): Promise<void> {
    if (this.workers.length === 0) return Promise.reject(abortError());
    const parts = this.workers.map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          const p: Pending = { id: this.nextId++, message, transfer: [], resolve: () => resolve(), reject, cancelled: false, broadcast: true };
          const list = this.direct.get(w);
          if (list) list.push(p);
          else this.direct.set(w, [p]);
        }),
    );
    this.pump();
    return Promise.all(parts).then(() => undefined);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const list of this.direct.values()) for (const p of list) p.reject(abortError());
    this.direct.clear();
    for (const p of [...this.queue, ...this.running.values()]) if (!p.cancelled) p.reject(abortError());
    this.queue.length = 0;
    this.running.clear();
    this.workers.length = 0;
    this.idle.length = 0;
  }

  private pump(): void {
    // Broadcast copies first, each to its own worker once that worker is free.
    if (this.direct.size > 0) {
      for (let i = this.idle.length - 1; i >= 0; i--) {
        const w = this.idle[i]!;
        const list = this.direct.get(w);
        if (!list) continue;
        const p = list.shift()!;
        if (list.length === 0) this.direct.delete(w);
        this.idle.splice(i, 1);
        this.running.set(w, p);
        w.postMessage({ id: p.id, message: p.message }, p.transfer);
      }
    }
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const p = this.queue.shift()!;
      this.running.set(w, p);
      w.postMessage({ id: p.id, message: p.message }, p.transfer);
    }
  }

  private finish(w: Worker, reply: Reply): void {
    const p = this.running.get(w);
    this.running.delete(w);
    this.idle.push(w);
    if (p && p.id === reply.id) {
      if (reply.ms !== undefined && !p.broadcast) {
        this.timing.ms += reply.ms;
        this.timing.jobs++;
      }
      if (!p.cancelled) {
        if (reply.ok) p.resolve(reply.value);
        else p.reject(new Error(reply.error ?? 'worker job failed'));
      }
    }
    this.pump();
  }
}

/** What a worker handler returns: the reply and the buffers to transfer with it. */
export interface WorkerAnswer {
  value: unknown;
  transfer?: Transferable[];
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<{ id: number; message: unknown }>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** Inside a worker script: answers every job of a `WorkerPool` with `handler`. */
export function serveWorker(handler: (message: unknown) => WorkerAnswer | Promise<WorkerAnswer>): void {
  const scope = globalThis as unknown as WorkerScope;
  scope.onmessage = async (e) => {
    const { id, message } = e.data;
    const t0 = performance.now();
    try {
      const a = await handler(message);
      scope.postMessage({ id, ok: true, value: a.value, ms: performance.now() - t0 } satisfies Reply, a.transfer ?? []);
    } catch (err) {
      scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err), ms: performance.now() - t0 } satisfies Reply, []);
    }
  };
}

function abortError(): Error {
  const e = new Error('job cancelled');
  e.name = 'AbortError';
  return e;
}

/** Reads a URL into bytes; rejects on an HTTP error or when the signal fires. */
export async function fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}
