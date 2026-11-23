// Layer 8, marks-store: Node only, never in a page. The dev-server store of the marks (a Vite plugin typed
// structurally, so the package does not depend on Vite) and, beside it, the command-line tool `wallhammer-marks`
// (the package's `bin`). Nothing in the engine imports it and the root entry does not re-export it; a project imports it
// in its `vite.config.ts` only.

export { MARKS_DIR_ENV, marksFolder, marksStore } from './store.ts';
export type { MarksDevServer, MarksRequest, MarksResponse, MarksStoreOptions, MarksStorePlugin } from './store.ts';
