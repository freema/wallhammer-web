#!/usr/bin/env node
// The marks made in an example page (key N in the planet example; examples/shared/src/marks/), read from
// internal/marks/marks.jsonl (or WH_MARKS_DIR). Runs on the host or in the container; no dependencies.
//
//   node tools/marks/list.mjs          a table: id, status, category, note, page, place, what was hit, distance,
//                                      picture, the newest log line
//   node tools/marks/list.mjs --open   only the open marks (not accepted, not wontfix; `fixed` ones stay listed)
//   node tools/marks/list.mjs --md     also writes marks.md next to the list: per mark the note, the status, the link
//                                      that puts the camera back, the pick, the facts, the picture and the whole log
//   node tools/marks/list.mjs --json   the marks as one JSON array (for scripts)
//
// Change a status with tools/marks/set.mjs.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, LIST, SERVER, STATUSES, readMarks, statusOf } from './common.mjs';

const args = new Set(process.argv.slice(2));
for (const a of args) if (!['--open', '--md', '--json'].includes(a)) {
  console.error(`list.mjs: unknown option ${a} (--open, --md, --json)`);
  process.exit(2);
}
const CLOSED = new Set(['accepted', 'wontfix']);

let marks = readMarks();
if (!marks) {
  console.log(`No marks yet (${LIST} does not exist).`);
  process.exit(0);
}
const logOf = (m) => (Array.isArray(m.log) ? m.log : []);
if (args.has('--open')) marks = marks.filter((m) => !CLOSED.has(statusOf(m)));

if (args.has('--json')) {
  console.log(JSON.stringify(marks, null, 2));
  process.exit(0);
}

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const dist = (m) => (m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`);
/** The first two values of the host's place of the point (latitude and longitude on the planet). */
const place = (m) => (m.point ? Object.values(m.point.place ?? {}).slice(0, 2).map((v) => (typeof v === 'number' ? v.toFixed(4) : String(v))).join(', ') : 'none');
const last = (m) => {
  const e = logOf(m).at(-1);
  return e ? `${e.by}: ${e.text}${e.picture ? ' [after]' : ''}` : '';
};
const link = (m) => `${SERVER}${m.page ?? '/'}#${m.view?.hash ?? ''}`;

const rows = marks.map((m) => [m.id, statusOf(m), m.category ?? '', cut(m.note || '(no note)', 44), m.page ?? '?', place(m), m.point ? m.point.surface : '-', dist(m.point?.distanceM), m.picture ? 'png' : '-', cut(last(m), 48)]);
const head = ['id', 'status', 'cat', 'note', 'page', 'place', 'hit', 'dist', 'pic', 'last log'];
const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((c, i) => String(c).padEnd(width[i])).join('  ').trimEnd();
console.log(line(head));
console.log(width.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));
const counts = STATUSES.map((s) => [s, marks.filter((m) => statusOf(m) === s).length]).filter(([, n]) => n > 0);
console.log(`\n${marks.length} mark(s)${args.has('--open') ? ' open' : ''} in ${LIST}${counts.length ? ` (${counts.map(([s, n]) => `${n} ${s}`).join(', ')})` : ''}`);

if (args.has('--md')) {
  const out = ['# Marks', '', `Read from \`${LIST}\` by \`tools/marks/list.mjs --md\`${args.has('--open') ? ' (open marks only)' : ''}.`, ''];
  for (const m of marks) {
    out.push(`## ${m.id}: ${cut(m.note || '(no note)', 100)}`, '');
    if (m.note && m.note.length > 100) out.push(m.note, '');
    out.push(`- Status: **${statusOf(m)}**${m.category ? `, category ${m.category}` : ''}`);
    out.push(`- View: [\`${m.page ?? '?'}#${m.view?.hash}\`](${link(m)})`);
    if (m.point) {
      const p = m.point;
      out.push(`- Point: ${p.surface} at ${Object.entries(p.place ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}; ${dist(p.distanceM)} from the eye`);
      if (p.accuracy) out.push(`- Pick: ${Object.entries(p.accuracy).map(([k, v]) => `${k} ${v}`).join('; ')}`);
    } else out.push('- Point: none (the ray met nothing)');
    out.push(`- Click: pixel ${m.pixel?.x}, ${m.pixel?.y} of ${m.canvas?.width} × ${m.canvas?.height}`);
    out.push(m.picture ? `- Picture: \`${m.picture}\` ![${m.id}](${m.id}.png)` : `- Picture: none (${m.pictureNote ?? 'unknown'})`);
    if (m.savedAt) out.push(`- Saved: ${m.savedAt}`);
    const log = logOf(m);
    if (log.length) {
      out.push('', '### Log', '');
      for (const e of log) {
        const was = e.was ? ` (was: ${Object.entries(e.was).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')})` : '';
        out.push(`${e.seq}. **${e.status}** by ${e.by}${e.at ? `, ${e.at}` : ''}: ${e.text}${was}`);
        if (e.picture) {
          const name = e.picture.slice(e.picture.lastIndexOf('/') + 1);
          out.push(`   after-picture \`${e.picture}\` ![${name}](${name})`);
        }
      }
    }
    out.push('', '```json', JSON.stringify(m.facts ?? {}, null, 1), '```', '');
  }
  const md = join(DIR, 'marks.md');
  writeFileSync(md, out.join('\n'));
  console.log(`wrote ${md}`);
}
