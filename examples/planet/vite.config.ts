import { defineConfig } from 'vite';
import { newFiles } from '../../tools/vite/new-files.ts';

// In a container on macOS file events do not arrive reliably through the mounted folder, so files are polled there
// (WH_POLL=1 is set by docker-compose.yml).
const poll = process.env.WH_POLL === '1';

export default defineConfig({
  // New files are reported by a folder scan; see tools/vite/new-files.ts for why polling alone misses them.
  plugins: [newFiles({ enabled: poll })],
  server: {
    port: 5284,
    strictPort: true,
    ...(poll ? { watch: { usePolling: true, interval: 300 } } : {}),
  },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
  },
});
