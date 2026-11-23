// The command-line tool of the marks: `wallhammer-marks`, the `bin` of the package (cli.ts runs it). Reads the store's list directly and
// changes a mark through the dev server's store (`marksStore`), so a change lands in the same place as one made in the
// page. No dependencies; Node alone.
//
//   wallhammer-marks list            a table: id, status, category, note, page, place, what was hit, distance,
//                                    picture, the newest log line
//   wallhammer-marks list --open     only the open marks (not accepted, not wontfix; `fixed` ones stay listed)
//   wallhammer-marks list --md       also writes marks.md next to the list: per mark the note, the status, the link
//                                    that puts the camera back, the pick, the facts, the picture and the whole log
//   wallhammer-marks list --json     the marks as one JSON array (for scripts)
//
//   wallhammer-marks set m0007 --status seen --by agent:clouds
//   wallhammer-marks set m0007 --status working --by agent:clouds --text "the shadow edge of the deck"
//   wallhammer-marks set m0007 --status fixed --by agent:clouds --text "the edge fades over 200 m" \
//        --after .marks/m0007-after-1.png
//   options of set: --category bug|look|idea|none
//
// Both take `--dir <folder>` (the store's folder; else WH_MARKS_DIR, else `.marks` in the working folder) and
// `--url <dev server>` (for set's request and list's links; else WH_MARKS_URL, else http://localhost:5173).
//
// An agent sets seen, working, fixed or wontfix; accepted and reopened are the developer's (in the page's panel).
// `fixed` needs --after: a picture of the mark's saved view after the repair. A picture already in the store's folder
// under the name <id>-after-<n>.png is referred to; any other PNG is sent and saved there. The id may be given as
// m0007, 7 or #7. The mark's page (`/scene/`) says under which path the store answers.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { MARK_CATEGORIES, MARK_STATUSES, statusOf } from '../base/marks.ts';
import type { Mark, MarkLogEntry } from '../base/marks.ts';
import { MARKS_DIR_ENV } from './store.ts';

/** The environment variable that names the dev server for `set` and the links of `list`. */
const URL_ENV = 'WH_MARKS_URL';
/** Vite's default address. */
const DEFAULT_URL = 'http://localhost:5173';
const AGENT_STATUSES = ['seen', 'working', 'fixed', 'wontfix'];
const CLOSED = new Set(['accepted', 'wontfix']);
const USAGE = `usage:
  wallhammer-marks list [--open] [--md] [--json] [--dir <folder>] [--url <dev server>]
  wallhammer-marks set <id> --by <label> [--status seen|working|fixed|wontfix] [--text "…"] [--after picture.png]
                       [--category bug|look|idea|none] [--dir <folder>] [--url <dev server>]
The store's folder: --dir, else ${MARKS_DIR_ENV}, else .marks in the working folder.
The dev server: --url, else ${URL_ENV}, else ${DEFAULT_URL}.`;

class Usage extends Error {}

/** Flags without a value and options with one, as the command allows them. */
function parseArgs(argv: readonly string[], flags: readonly string[], values: readonly string[]): { flags: Set<string>; opts: Record<string, string>; pos: string[] } {
  const out = { flags: new Set<string>(), opts: {} as Record<string, string>, pos: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      out.pos.push(a);
      continue;
    }
    const name = a.slice(2);
    if (flags.includes(name)) out.flags.add(name);
    else if (values.includes(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Usage(`${a} needs a value`);
      out.opts[name] = v;
      i++;
    } else throw new Usage(`unknown option ${a} (${[...flags, ...values].map((f) => `--${f}`).join(', ')})`);
  }
  return out;
}

function folderOf(opts: Record<string, string>): string {
  return resolve(opts.dir ?? (process.env[MARKS_DIR_ENV] || '.marks'));
}

function serverOf(opts: Record<string, string>): string {
  return (opts.url ?? (process.env[URL_ENV] || DEFAULT_URL)).replace(/\/+$/, '');
}

/** The marks of the list, oldest first, or null when there is no list; lines that are not JSON are reported and skipped. */
function readMarks(dir: string): Mark[] | null {
  const list = join(dir, 'marks.jsonl');
  if (!existsSync(list)) return null;
  const marks: Mark[] = [];
  readFileSync(list, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const m = JSON.parse(line) as Mark | null;
        if (m && typeof m.id === 'string') marks.push(m);
      } catch {
        console.error(`${list}:${i + 1}: not JSON, skipped`);
      }
    });
  return marks;
}

/** `m0007` from `m0007`, `7` or `#7`, or null. */
function markId(text: string): string | null {
  const num = text.replace(/^#/, '').replace(/^m/, '');
  return /^\d{1,9}$/.test(num) ? `m${num.padStart(4, '0')}` : null;
}

const logOf = (m: Mark): MarkLogEntry[] => (Array.isArray(m.log) ? m.log : []);

function list(argv: readonly string[]): number {
  const { flags, opts, pos } = parseArgs(argv, ['open', 'md', 'json'], ['dir', 'url']);
  if (pos.length) throw new Usage(`list takes no ${pos[0]}`);
  const dir = folderOf(opts);
  const listFile = join(dir, 'marks.jsonl');
  const server = serverOf(opts);
  let marks = readMarks(dir);
  if (!marks) {
    if (flags.has('json')) console.log('[]');
    else console.log(`No marks yet (${listFile} does not exist).`);
    return 0;
  }
  if (flags.has('open')) marks = marks.filter((m) => !CLOSED.has(statusOf(m)));
  if (flags.has('json')) {
    console.log(JSON.stringify(marks, null, 2));
    return 0;
  }

  const cut = (s: unknown, n: number): string => {
    const t = String(s ?? '').replace(/\s+/g, ' ');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const dist = (m: number | undefined): string => (m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`);
  /** The first two values of the host's place of the point (latitude and longitude on a sphere, say). */
  const place = (m: Mark): string =>
    m.point
      ? Object.values(m.point.place ?? {})
          .slice(0, 2)
          .map((v) => (typeof v === 'number' ? v.toFixed(4) : String(v)))
          .join(', ')
      : 'none';
  const last = (m: Mark): string => {
    const e = logOf(m).at(-1);
    return e ? `${e.by}: ${e.text}${e.picture ? ' [after]' : ''}` : '';
  };
  const link = (m: Mark): string => `${server}${m.page ?? '/'}#${m.view?.hash ?? ''}`;

  const rows = marks.map((m) => [m.id, statusOf(m), m.category ?? '', cut(m.note || '(no note)', 44), m.page ?? '?', place(m), m.point ? m.point.surface : '-', dist(m.point?.distanceM), m.picture ? 'png' : '-', cut(last(m), 48)]);
  const head = ['id', 'status', 'cat', 'note', 'page', 'place', 'hit', 'dist', 'pic', 'last log'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r: readonly string[]): string => r.map((c, i) => String(c).padEnd(width[i]!)).join('  ').trimEnd();
  console.log(line(head));
  console.log(width.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  const counts = MARK_STATUSES.map((s) => [s, marks.filter((m) => statusOf(m) === s).length] as const).filter(([, n]) => n > 0);
  console.log(`\n${marks.length} mark(s)${flags.has('open') ? ' open' : ''} in ${listFile}${counts.length ? ` (${counts.map(([s, n]) => `${n} ${s}`).join(', ')})` : ''}`);

  if (flags.has('md')) {
    const out = ['# Marks', '', `Read from \`${listFile}\` by \`wallhammer-marks list --md\`${flags.has('open') ? ' (open marks only)' : ''}.`, ''];
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
    const md = join(dir, 'marks.md');
    writeFileSync(md, out.join('\n'));
    console.log(`wrote ${md}`);
  }
  return 0;
}

async function set(argv: readonly string[]): Promise<number> {
  const { opts, pos } = parseArgs(argv, [], ['status', 'by', 'text', 'after', 'category', 'dir', 'url']);
  if (pos.length !== 1) throw new Usage('set needs exactly one mark id');
  const id = markId(pos[0]!);
  if (!id) throw new Usage(`not a mark id: ${pos[0]}`);
  if (!opts.by || !opts.by.trim()) throw new Usage('--by <label> is needed (agent:<topic>)');
  if (opts.status !== undefined && !AGENT_STATUSES.includes(opts.status)) throw new Usage(`--status: one of ${AGENT_STATUSES.join(', ')} (accepted and reopened are the developer's, in the page)`);
  if (opts.category !== undefined && opts.category !== 'none' && !(MARK_CATEGORIES as readonly string[]).includes(opts.category)) throw new Usage(`--category: one of ${MARK_CATEGORIES.join(', ')}, none`);
  if (opts.status === 'fixed' && !opts.after) throw new Usage('--status fixed needs --after <picture of the same view after the repair>');
  if (opts.status === undefined && opts.text === undefined && opts.after === undefined && opts.category === undefined) throw new Usage('nothing to change: give --status, --text, --after or --category');

  const dir = folderOf(opts);
  const mark = (readMarks(dir) ?? []).find((m) => m.id === id);
  if (!mark) throw new Usage(`no mark ${id} in ${dir}`);
  if (typeof mark.page !== 'string' || !mark.page.startsWith('/')) throw new Usage(`${id} has no page to address its store`);

  const body: Record<string, unknown> = { by: opts.by.trim() };
  if (opts.status) body.status = opts.status;
  if (opts.text !== undefined) body.text = opts.text;
  if (opts.category !== undefined) body.category = opts.category === 'none' ? null : opts.category;
  if (opts.after) {
    const path = resolve(opts.after);
    if (!existsSync(path)) throw new Usage(`--after: ${path} does not exist`);
    const name = basename(path);
    if (dirname(path) === dir && new RegExp(`^${id}-after-\\d{1,6}\\.png$`).test(name)) body.afterFile = name;
    else body.png = readFileSync(path).toString('base64');
  }

  const server = serverOf(opts);
  let r: Response;
  try {
    r = await fetch(`${server}${mark.page}__marks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-marks': '1' }, body: JSON.stringify(body) });
  } catch (e) {
    const err = e as { cause?: { message?: string }; message?: string };
    throw new Usage(`the dev server at ${server} is not reachable (--url, ${URL_ENV}): ${err.cause?.message ?? err.message}`);
  }
  const text = await r.text();
  if (!r.ok) throw new Usage(`${r.status} ${text}`);
  const m = JSON.parse(text) as Mark;
  const e = logOf(m).at(-1)!;
  console.log(`${m.id}: ${m.status} (log ${e.seq}: ${e.by}: ${e.text}${e.picture ? `; after-picture ${e.picture}` : ''})`);
  return 0;
}

/** Runs the tool with the arguments after the program's name; returns the exit code. */
export async function runMarksCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'list') return list(rest);
    if (command === 'set') return await set(rest);
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    }
    throw new Usage(`unknown command ${command} (list, set)`);
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    console.error(`wallhammer-marks: ${e.message}`);
    if (/^(unknown|usage|set needs|list takes)/.test(e.message)) console.error(USAGE);
    return 2;
  }
}

