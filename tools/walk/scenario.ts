// Shared shape of the headless walking checks (`pnpm check:walk`): a scenario is a name and a function that returns
// its verdict with a one-line detail. Each package of scenarios (collision world, walker, follow camera) lives in its
// own file and exports an array; `check.ts` runs them all.

export interface ScenarioResult {
  ok: boolean;
  /** One line: the measured numbers that justify the verdict. */
  detail: string;
}

export interface Scenario {
  /** Short kebab-case name, unique across all files. */
  name: string;
  /**
   * 'check' (default) fails the run when not ok. 'timing' measures CPU time: it reports `slow` instead of failing,
   * because a shared machine or a container can be slower than the target without anything being wrong.
   */
  kind?: 'check' | 'timing';
  run(): ScenarioResult;
}

export function pass(detail: string): ScenarioResult {
  return { ok: true, detail };
}

export function fail(detail: string): ScenarioResult {
  return { ok: false, detail };
}

/** `ok` when `cond`, with the same detail either way. */
export function verdict(cond: boolean, detail: string): ScenarioResult {
  return { ok: cond, detail };
}

/** Mean wall time of one call of `fn`, in milliseconds, over `calls` calls after a warm-up of the same length. */
export function meanMs(calls: number, fn: (i: number) => void): number {
  for (let i = 0; i < calls; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < calls; i++) fn(i);
  return (performance.now() - t0) / calls;
}

/** Small deterministic generator (mulberry32): a function returning numbers in [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number with fixed decimals for detail lines. */
export function f(x: number, digits = 3): string {
  return Number.isFinite(x) ? x.toFixed(digits) : String(x);
}
