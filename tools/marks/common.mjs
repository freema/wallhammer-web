// Shared by the marks' command-line tools (list.mjs, set.mjs, shoot.mjs): where the store's files are, reading the
// list, mark ids. No dependencies.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The store's folder: WH_MARKS_DIR (a scratch folder for a test), else internal/marks/ of the repository. */
export const DIR = process.env.WH_MARKS_DIR ? resolve(process.env.WH_MARKS_DIR) : join(REPO, 'internal', 'marks');
export const LIST = join(DIR, 'marks.jsonl');
export const STATUSES = ['new', 'seen', 'working', 'fixed', 'accepted', 'reopened', 'wontfix'];
export const CATEGORIES = ['bug', 'look', 'idea'];
/** The example server (docker compose up -d). */
export const SERVER = 'http://127.0.0.1:5281';

export const statusOf = (m) => (STATUSES.includes(m.status) ? m.status : 'new');

/** The marks of the list, oldest first; lines that are not JSON are reported and skipped. */
export function readMarks() {
  if (!existsSync(LIST)) return null;
  const marks = [];
  readFileSync(LIST, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const m = JSON.parse(line);
        if (m && typeof m.id === 'string') marks.push(m);
      } catch {
        console.error(`${LIST}:${i + 1}: not JSON, skipped`);
      }
    });
  return marks;
}

/** `m0007` from `m0007`, `7` or `#7`, or null. */
export function markId(text) {
  const num = String(text).replace(/^#/, '').replace(/^m/, '');
  return /^\d{1,9}$/.test(num) ? `m${num.padStart(4, '0')}` : null;
}
