// Known good: the Worker API inside platform.
export function startWorker(url: string): Worker {
  const w = new Worker(url, { type: 'module' });
  w.postMessage({ hello: 1 });
  return w;
}
