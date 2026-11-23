// The page's client of the marks store on the dev server (tools/vite/marks-store.ts): list, save with a picture,
// change (note, category, status, a log entry) and delete. Every request that changes something carries the header
// `x-marks: 1`, which a page of another origin cannot send without a preflight the store never answers.

import type { Mark, MarkDraft, MarkPatch } from './types.ts';

export interface MarkStore {
  list(): Promise<Mark[]>;
  /** Saves a draft with its picture (a PNG as base64, or null and why) and returns the mark the store wrote. */
  save(draft: MarkDraft, png: string | null, pictureNote: string | null): Promise<Mark>;
  /** Changes a saved mark and appends an entry to its log; returns the mark the store wrote. */
  update(id: string, patch: MarkPatch): Promise<Mark>;
  remove(id: string): Promise<void>;
  /** The URL of a picture of the store, from its path relative to the repository (`internal/marks/m0007.png`). */
  pictureUrl(path: string): string;
}

async function answer<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`marks store: ${r.status} ${await r.text().catch(() => '')}`.trim());
  return (await r.json()) as T;
}

export function markStore(endpoint: string): MarkStore {
  const headers = { 'content-type': 'application/json', 'x-marks': '1' };
  return {
    list: async () => answer<Mark[]>(await fetch(endpoint, { headers: { accept: 'application/json' }, cache: 'no-store' })),
    save: async (draft, png, pictureNote) => answer<Mark>(await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ mark: draft, png, pictureNote }) })),
    update: async (id, patch) => answer<Mark>(await fetch(`${endpoint}/${encodeURIComponent(id)}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })),
    remove: async (id) => {
      await answer<unknown>(await fetch(`${endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE', headers }));
    },
    pictureUrl: (path) => `${endpoint}/${encodeURIComponent(path.slice(path.lastIndexOf('/') + 1))}`,
  };
}
