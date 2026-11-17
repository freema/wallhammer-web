// Progress of a long piece of work made of named stages (loading a map: data, worker jobs, shader programs, uploads).
// Each stage has a weight and a number of units; whoever does the work advances it, whoever shows it subscribes.
// No DOM and no clock here: an app turns the report into a bar or a line of text.
//
//   const p = new Progress([{ key: 'data', label: 'Data', weight: 1 }, { key: 'jobs', label: 'Pieces', weight: 4 }]);
//   p.total('jobs', 120);
//   p.advance('jobs');           // one of 120 done
//   p.report                     // { fraction, stage: 'data', label: 'Data', done: false }

/** One stage: a key for the code, a label for the user, a weight against the other stages. */
export interface ProgressStage {
  key: string;
  label: string;
  weight: number;
}

/** What a progress shows now. */
export interface ProgressReport {
  /** Share of the weighted work done, 0–1. */
  fraction: number;
  /** Key and label of the first stage not complete; the last stage when all are. */
  stage: string;
  label: string;
  /** Units done and total of that stage. */
  units: number;
  of: number;
  done: boolean;
}

interface StageState {
  readonly stage: ProgressStage;
  total: number;
  done: number;
}

export class Progress {
  private readonly stages: StageState[];
  private readonly listeners = new Set<(r: ProgressReport) => void>();

  constructor(stages: readonly ProgressStage[]) {
    if (stages.length === 0) throw new Error('A progress needs at least one stage');
    this.stages = stages.map((stage) => ({ stage, total: 1, done: 0 }));
  }

  /** Sets the number of units of a stage (default 1). Zero units make the stage complete at once. */
  total(key: string, units: number): void {
    const s = this.get(key);
    s.total = Math.max(0, units);
    s.done = Math.min(s.done, s.total);
    this.emit();
  }

  /** Marks `units` more units of a stage done. */
  advance(key: string, units = 1): void {
    const s = this.get(key);
    s.done = Math.min(s.total, s.done + units);
    this.emit();
  }

  /** Marks a stage complete. */
  complete(key: string): void {
    const s = this.get(key);
    s.done = s.total;
    this.emit();
  }

  /** Marks every stage complete. */
  finish(): void {
    for (const s of this.stages) s.done = s.total;
    this.emit();
  }

  /** Advances a stage by one unit as each promise settles; the stage total becomes the number of promises. */
  track<T>(key: string, promises: readonly Promise<T>[]): Promise<T[]> {
    this.total(key, promises.length);
    return Promise.all(
      promises.map((p) =>
        p.finally(() => {
          this.advance(key);
        }),
      ),
    );
  }

  get report(): ProgressReport {
    let sum = 0;
    let done = 0;
    let current: StageState | null = null;
    for (const s of this.stages) {
      sum += s.stage.weight;
      done += s.total > 0 ? (s.stage.weight * s.done) / s.total : s.stage.weight;
      if (!current && s.done < s.total) current = s;
    }
    const at = current ?? this.stages[this.stages.length - 1]!;
    return { fraction: sum > 0 ? done / sum : 1, stage: at.stage.key, label: at.stage.label, units: at.done, of: at.total, done: current === null };
  }

  /** Calls `fn` with the report now and after every change; returns the function that stops it. */
  subscribe(fn: (r: ProgressReport) => void): () => void {
    this.listeners.add(fn);
    fn(this.report);
    return () => this.listeners.delete(fn);
  }

  private get(key: string): StageState {
    const s = this.stages.find((x) => x.stage.key === key);
    if (!s) throw new Error(`Unknown progress stage: ${key}`);
    return s;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const r = this.report;
    for (const fn of this.listeners) fn(r);
  }
}
