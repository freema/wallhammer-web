// Build plugin: bundle the module workers a page names with `new URL('./some-worker.ts', import.meta.url)`.
//
// Why: Vite bundles a worker only when that URL stands directly inside `new Worker(...)`. The examples hand the URL to
// the engine (`WorkerPool`, `WorkerCellProvider`), which constructs the worker itself, so Vite takes the file for a
// plain asset: a build would ship the TypeScript source untranspiled (inlined as a data: URL) and the worker would
// never start. The dev server is not affected, it serves the .ts file transpiled, so the plugin only runs in a build.
//
// The fix rewrites every `new URL('<relative path>.ts', import.meta.url)` (also .mts, .js, .mjs) whose file exists into
// `new URL(<url of the bundled worker>, import.meta.url)`, the URL coming from Vite's `?worker&url` import. The worker
// bundle follows the config's `worker.format` (the examples with workers set `es`, the engine starts module workers).

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The part of Vite's plugin API used here, typed locally like tools/vite/new-files.ts.
interface Plugin {
  name: string;
  apply: 'build';
  enforce: 'pre';
  transform(code: string, id: string): { code: string; map: null } | null;
}

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const WORKER_URL = /new URL\(\s*(['"])(\.{1,2}\/[^'"\n]+\.(?:m?ts|m?js))\1\s*,\s*import\.meta\.url\s*\)/g;

export function workerUrls(): Plugin {
  return {
    name: 'wh-worker-urls',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (id.startsWith('\0') || file.includes('/node_modules/') || !SCRIPT.test(file) || !code.includes('import.meta.url')) {
        return null;
      }
      const imports: string[] = [];
      const out = code.replace(WORKER_URL, (match: string, _quote: string, rel: string) => {
        if (!existsSync(resolve(dirname(file), rel))) return match;
        const name = `__whWorkerUrl${imports.length}`;
        imports.push(`import ${name} from ${JSON.stringify(`${rel}?worker&url`)};`);
        return `new URL(${name}, import.meta.url)`;
      });
      if (imports.length === 0) return null;
      // The imports go on the first line, so the line numbers of the module stay the same.
      return { code: imports.join(' ') + out, map: null };
    },
  };
}
