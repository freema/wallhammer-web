// Dev-server plugin: report files created or deleted while the server runs.
//
// Why: in Docker on macOS the bind mount does not update a directory's mtime when a file is added from the host.
// Chokidar's polling watches files and directories by stat, so it sees changes to existing files but never sees a new
// one. Vite then keeps its public file set (a new public file is answered with index.html) and its resolver cache (an
// import that failed once keeps failing) until a restart. The engine package also lives outside each app's root, so the
// default watcher does not cover its folder at all.
//
// The fix lists the watched folders by readdir (which is not cached) on an interval and emits the missing `add` and
// `unlink` events on Vite's own watcher, so Vite does its normal bookkeeping. It only runs when polling is on.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The part of Vite's plugin and dev-server API used here, typed locally, so the plugin does not tie itself to one copy
// of vite; the configs that use it accept it structurally.
interface DevServer {
  config: { root: string };
  watcher: { add(paths: string | string[]): unknown; emit(event: string, path: string): boolean };
  httpServer: { on(event: 'close', listener: () => void): unknown } | null;
}
interface Plugin {
  name: string;
  apply: 'serve';
  configureServer(server: DevServer): void;
}

/** The engine package source, shared by every app and example. */
export const ENGINE_SRC = fileURLToPath(new URL('../../packages/wallhammer-web/src', import.meta.url));

const SKIP = new Set(['node_modules', 'dist', '.git']);

function listFiles(dir: string, out: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (e.isFile()) out.add(p);
  }
}

/**
 * Watch `dirs` (absolute; the app root and the engine source by default) for new and deleted files.
 * `enabled` is normally the WH_POLL switch; off, the plugin only adds the engine folder to the watcher.
 */
export function newFiles(options: { enabled: boolean; dirs?: string[]; intervalMs?: number }): Plugin {
  return {
    name: 'wh-new-files',
    apply: 'serve',
    configureServer(server) {
      const dirs = options.dirs ?? [server.config.root, ENGINE_SRC];
      server.watcher.add(ENGINE_SRC);
      if (!options.enabled) return;
      let known = new Set<string>();
      for (const d of dirs) listFiles(d, known);
      const timer = setInterval(() => {
        const now = new Set<string>();
        for (const d of dirs) listFiles(d, now);
        for (const f of now) if (!known.has(f)) server.watcher.emit('add', f);
        for (const f of known) if (!now.has(f)) server.watcher.emit('unlink', f);
        known = now;
      }, options.intervalMs ?? 700);
      timer.unref();
      server.httpServer?.on('close', () => clearInterval(timer));
    },
  };
}
