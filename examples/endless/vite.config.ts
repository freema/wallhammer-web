import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { marksStore } from 'wallhammer-web/marks-store';
import { newFiles } from '../../tools/vite/new-files.ts';
import { workerUrls } from '../../tools/vite/worker-urls.ts';

// In a container on macOS file events do not arrive reliably through the mounted folder, so files are polled there
// (WH_POLL=1 is set by docker-compose.yml).
const poll = process.env.WH_POLL === '1';

export default defineConfig({
  // New files are reported by a folder scan; see tools/vite/new-files.ts for why polling alone misses them.
  // A build bundles the workers handed to the engine as `new URL('./x.ts', import.meta.url)`, see
  // tools/vite/worker-urls.ts. The marks' store (key N in the free camera) answers at /endless/__marks in the dev server
  // only (wallhammer-web/marks-store); this repository keeps its marks in internal/marks/ (git ignores it), not in .marks/.
  plugins: [newFiles({ enabled: poll }), workerUrls(), marksStore({ dir: fileURLToPath(new URL('../../internal/marks', import.meta.url)) })],
  server: {
    port: 5283,
    strictPort: true,
    watch: poll ? { usePolling: true, interval: 300, ignored: ['**/public/cells/**'] } : { ignored: ['**/public/cells/**'] },
  },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
  },
});
