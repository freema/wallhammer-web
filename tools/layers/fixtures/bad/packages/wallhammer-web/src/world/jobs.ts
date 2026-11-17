// Known bad: a world module starts its own worker instead of going through platform.
export function startJobs(url: string): void {
  const w = new Worker(url, { type: 'module' });
  w.postMessage({ job: 1 });
}
