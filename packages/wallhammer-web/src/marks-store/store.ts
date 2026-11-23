// Dev-server plugin: the store of the marks a developer makes in a page (`installMarking` of wallhammer-web/platform).
// Only in the dev server (`apply: 'serve'`), never in a build. The routes answer under the page's base, `<base>__marks`:
//
//   GET    …/__marks                     the marks, oldest first (JSON array)
//   GET    …/__marks/<id>.png            a mark's picture
//   GET    …/__marks/<id>-after-<n>.png  an after-picture of a mark (the same view, taken after a repair)
//   POST   …/__marks                     { mark, png, pictureNote }: appends the mark to marks.jsonl with a new id and
//                                        writes the picture as <id>.png with the clicked pixel circled; a picture that
//                                        reads back empty is not kept (`pictureNote` says so); answers with the mark
//   PATCH  …/__marks/<id>                { by, note?, category?, status?, text?, png?, afterFile? }: changes the note,
//                                        the category (null removes it) or the status and appends one entry to the
//                                        mark's log; `png` (base64) is saved as <id>-after-<n>.png, `afterFile` names
//                                        such a file already written there. Status `fixed` needs an after-picture in
//                                        the same request. Answers with the mark
//   DELETE …/__marks/<id>                removes the mark from the list, its picture and its after-pictures
//
// The folder (`marksFolder`): the environment variable WH_MARKS_DIR when set (a scratch folder for a test; never test on
// a developer's marks), else `options.dir` (relative to Vite's root), else `.marks/` in Vite's root. Paths in the
// records are relative to the dev server's working folder when the store's folder lies in it, else absolute.
//
// Tracking: a mark's `status` is one of MARK_STATUSES (a mark without one is `new`), `category` one of MARK_CATEGORIES,
// and `log` an append-only list of { seq, status, by, text, picture?, at, was? } (`was`: the note or category before a
// change). The store stamps `at` like it stamps `savedAt`.
//
// Only requests from a page of this server on localhost are taken: the Host must be localhost (or 127.0.0.1, [::1]),
// an Origin, when sent, must be that same origin, and a request that changes something must carry `x-marks: 1` (a
// page of another origin cannot send that without a preflight this server never answers). Bodies are capped. Files are
// written only inside the store's folder, under names the store makes itself. Changes run one at a time; a change to
// one mark rewrites the list through a temporary file and a rename, every other line kept exactly as it was (a line
// that is not JSON included).
//
// The plugin types the few parts of Vite's plugin and dev-server API it uses itself, so the package does not depend on
// Vite.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { MARK_CATEGORIES, MARK_STATUSES } from '../base/marks.ts';
import { PNG_SIGNATURE, isBlank, readPng, ring, writePng } from './png.ts';

/** The part of an incoming request the store reads (Node's `IncomingMessage` has it). */
export interface MarksRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy(): unknown;
}

/** The part of a response the store writes (Node's `ServerResponse` has it). */
export interface MarksResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(data: Uint8Array): unknown;
}

/** The part of Vite's dev server the store uses: its middleware stack. */
export interface MarksDevServer {
  middlewares: { use(fn: (req: MarksRequest, res: MarksResponse, next: () => void) => void): unknown };
}

/** A Vite plugin, typed structurally: `plugins: [marksStore()]` in `vite.config.ts`. */
export interface MarksStorePlugin {
  name: string;
  apply: 'serve';
  configResolved(config: { root: string }): void;
  configureServer(server: MarksDevServer): void;
}

export interface MarksStoreOptions {
  /** The store's folder; a relative path resolves against Vite's root. Default `.marks` in Vite's root. */
  dir?: string;
}

/** The environment variable that names the store's folder; it wins over the option and the default. */
export const MARKS_DIR_ENV = 'WH_MARKS_DIR';

const SEGMENT = '/__marks';
const MAX_BODY = 48 * 1024 * 1024;
const MAX_NOTE = 2000;
const MAX_BY = 80;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const ID = /^m\d{4,9}$/;
const PICTURE = /^(m\d{4,9})(-after-\d{1,6})?\.png$/;
const STATUSES: readonly string[] = MARK_STATUSES;
const CATEGORIES: readonly string[] = MARK_CATEGORIES;

type Rec = Record<string, unknown>;

/** A failure with the HTTP status to answer. */
class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function hostName(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
}

/** Whether the request comes from a page of this server on localhost; `changes`: it writes or deletes. */
function allowed(req: MarksRequest, changes: boolean): boolean {
  const host = String(req.headers.host ?? '');
  if (!LOCAL.has(hostName(host))) return false;
  const origin = req.headers.origin;
  if (Array.isArray(origin)) return false;
  if (origin !== undefined) {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:' || u.host !== host) return false;
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  return !changes || req.headers['x-marks'] === '1';
}

function send(res: MarksResponse, status: number, body: unknown, type = 'application/json'): void {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.end(data);
}

function readBody(req: MarksRequest): Promise<Buffer | null> {
  return new Promise((done, fail) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return done(null);
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        done(null);
        return;
      }
      parts.push(c);
    });
    req.on('end', () => done(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

/** The JSON object of a body, or a refusal. */
async function jsonBody(req: MarksRequest): Promise<Rec> {
  const body = await readBody(req);
  if (!body) throw new Refused(413, `body over ${MAX_BODY} bytes`);
  let data: unknown;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Refused(400, 'not JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Refused(400, 'not a JSON object');
  return data as Rec;
}

/** A PNG sent as base64, or null when it is not one. */
function pngOf(base64: string): Buffer | null {
  const png = Buffer.from(base64, 'base64');
  return png.length >= 8 && png.subarray(0, 8).equals(PNG_SIGNATURE) ? png : null;
}

/** The record of a line, or null when the line is not a mark. */
function parse(line: string): Rec | null {
  if (!line.trim()) return null;
  try {
    const m = JSON.parse(line) as unknown;
    return m && typeof m === 'object' && !Array.isArray(m) && typeof (m as { id?: unknown }).id === 'string' ? (m as Rec) : null;
  } catch {
    return null;
  }
}

/** The mark's picture with its clicked pixel circled, or null and why there is none. */
function markPicture(png: Buffer, pixel: unknown): { png: Buffer | null; note: string | null } {
  const p = readPng(png);
  if (typeof p === 'string') return { png, note: null };
  if (isBlank(p)) return { png: null, note: 'the canvas read back empty (drawing buffer already cleared)' };
  const at = pixel as { x?: unknown; y?: unknown } | null;
  if (at && typeof at.x === 'number' && typeof at.y === 'number' && Number.isFinite(at.x) && Number.isFinite(at.y)) ring(p, at.x, at.y);
  return { png: writePng(p), note: null };
}

/** The store's files: the list (one JSON line per mark), the pictures and the last sequence number given. */
function files(dir: string, cwd: string) {
  const list = join(dir, 'marks.jsonl');
  const seqFile = join(dir, 'seq');
  // Paths in the records: relative to the working folder when the store's folder is in it.
  const rel = relative(cwd, dir);
  const named = (name: string): string => (rel && !rel.startsWith('..') && !isAbsolute(rel) ? `${rel.split('\\').join('/')}/${name}` : join(dir, name));
  const ensure = (): void => void mkdirSync(dir, { recursive: true });
  /** The lines of the list as they are in the file (without the line breaks), empty ones dropped. */
  const lines = (): string[] => (existsSync(list) ? readFileSync(list, 'utf8').split('\n').filter((l) => l.trim()) : []);
  const read = (): Rec[] =>
    lines().flatMap((l): Rec[] => {
      const m = parse(l);
      return m ? [m] : [];
    });
  /** Writes the list whole: a temporary file, then a rename over the old one. */
  const write = (out: readonly string[]): void => {
    const tmp = `${list}.tmp`;
    writeFileSync(tmp, out.map((l) => `${l}\n`).join(''));
    renameSync(tmp, list);
  };
  const nextSeq = (): number => {
    let last = 0;
    if (existsSync(seqFile)) last = Number(readFileSync(seqFile, 'utf8').trim()) || 0;
    for (const m of read()) last = Math.max(last, Number(m.seq) || 0);
    writeFileSync(seqFile, String(last + 1));
    return last + 1;
  };
  const picture = (name: string): string => join(dir, name.endsWith('.png') ? name : `${name}.png`);
  /** The numbers of the after-pictures of a mark already in the folder. */
  const afters = (id: string): number[] => {
    if (!existsSync(dir)) return [];
    const re = new RegExp(`^${id}-after-(\\d{1,6})\\.png$`);
    return readdirSync(dir).flatMap((n) => {
      const k = re.exec(n);
      return k ? [Number(k[1])] : [];
    });
  };
  return { dir, list, named, ensure, lines, read, write, nextSeq, picture, afters };
}

type Files = ReturnType<typeof files>;

/** The change a PATCH asks for, checked. */
interface Patch {
  by: string;
  note?: string;
  category?: string | null;
  status?: string;
  text?: string;
  png?: Buffer;
  afterFile?: string;
}

function checkPatch(id: string, data: Rec, f: Files): Patch {
  if (typeof data.by !== 'string' || !data.by.trim() || data.by.length > MAX_BY) throw new Refused(400, `by: a label up to ${MAX_BY} characters (developer, agent:<topic>)`);
  const p: Patch = { by: data.by.trim() };
  if (data.note !== undefined) {
    if (typeof data.note !== 'string' || data.note.length > MAX_NOTE) throw new Refused(400, `note must be text up to ${MAX_NOTE} characters`);
    p.note = data.note;
  }
  if (data.category !== undefined) {
    if (data.category !== null && !CATEGORIES.includes(String(data.category))) throw new Refused(400, `category: one of ${CATEGORIES.join(', ')} or null`);
    p.category = data.category as string | null;
  }
  if (data.status !== undefined) {
    if (!STATUSES.includes(String(data.status))) throw new Refused(400, `status: one of ${STATUSES.join(', ')}`);
    p.status = String(data.status);
  }
  if (data.text !== undefined && data.text !== null) {
    if (typeof data.text !== 'string' || data.text.length > MAX_NOTE) throw new Refused(400, `text must be text up to ${MAX_NOTE} characters`);
    p.text = data.text.trim();
  }
  if (typeof data.png === 'string' && data.png.length > 0) {
    const png = pngOf(data.png);
    if (!png) throw new Refused(400, 'png: not a PNG');
    p.png = png;
  }
  if (data.afterFile !== undefined && data.afterFile !== null) {
    const name = String(data.afterFile);
    if (!new RegExp(`^${id}-after-\\d{1,6}\\.png$`).test(name)) throw new Refused(400, `afterFile: a name ${id}-after-<n>.png in the store's folder`);
    const path = f.picture(name);
    if (!existsSync(path)) throw new Refused(400, `afterFile: ${f.named(name)} does not exist`);
    if (!readFileSync(path).subarray(0, 8).equals(PNG_SIGNATURE)) throw new Refused(400, `afterFile: ${f.named(name)} is not a PNG`);
    if (p.png) throw new Refused(400, 'png and afterFile: one picture per change');
    p.afterFile = name;
  }
  if (p.status === 'fixed' && !p.png && !p.afterFile) throw new Refused(400, 'status fixed needs an after-picture of the same view (png or afterFile)');
  if (p.note === undefined && p.category === undefined && p.status === undefined && !p.text && !p.png && !p.afterFile) throw new Refused(400, 'nothing to change');
  return p;
}

/** Applies a checked change to the mark `id` in the list; returns the mark as written. */
function applyPatch(id: string, p: Patch, f: Files): Rec {
  const lines = f.lines();
  let at = -1;
  let old: Rec | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = parse(lines[i]!);
    if (m && m.id === id) {
      at = i;
      old = m;
    }
  }
  if (at < 0 || !old) throw new Refused(404, 'no such mark');
  const mark: Rec = { ...old };
  const was = STATUSES.includes(String(mark.status)) ? String(mark.status) : 'new';
  const log: Rec[] = Array.isArray(mark.log) ? [...(mark.log as Rec[])] : [];
  const changes: string[] = [];
  const before: Rec = {};
  if (p.note !== undefined && p.note !== mark.note) {
    before.note = mark.note ?? null;
    mark.note = p.note;
    changes.push('note changed');
  }
  if (p.category !== undefined && p.category !== (mark.category ?? null)) {
    before.category = mark.category ?? null;
    if (p.category === null) delete mark.category;
    else mark.category = p.category;
    changes.push(`category ${p.category ?? 'removed'}`);
  }
  const status = p.status ?? was;
  if (status !== was) changes.push(`${was} → ${status}`);
  mark.status = status;
  let picture: string | undefined;
  if (p.png) {
    f.ensure();
    let n = Math.max(0, ...f.afters(id)) + 1;
    while (existsSync(f.picture(`${id}-after-${n}`))) n++;
    writeFileSync(f.picture(`${id}-after-${n}`), p.png);
    picture = f.named(`${id}-after-${n}.png`);
  } else if (p.afterFile) picture = f.named(p.afterFile);
  if (picture) changes.push('after-picture');
  const seq = log.reduce((s, e) => Math.max(s, Number(e.seq) || 0), 0) + 1;
  const entry: Rec = { seq, status, by: p.by, text: p.text || changes.join(', ') || 'no change' };
  if (picture) entry.picture = picture;
  if (Object.keys(before).length) entry.was = before;
  entry.at = new Date().toISOString();
  log.push(entry);
  mark.log = log;
  const out = [...lines];
  out[at] = JSON.stringify(mark);
  f.write(out);
  return mark;
}

/**
 * The store's folder: WH_MARKS_DIR when set, else `dir` (relative to `root`), else `.marks` in `root`. `root` is Vite's
 * root for the plugin.
 */
export function marksFolder(root: string, dir?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[MARKS_DIR_ENV];
  if (fromEnv) return resolve(fromEnv);
  return resolve(root, dir ?? '.marks');
}

/** The dev-server store of the marks, a Vite plugin (dev server only). */
export function marksStore(options: MarksStoreOptions = {}): MarksStorePlugin {
  let root = process.cwd();
  return {
    name: 'wallhammer-marks-store',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      const f = files(marksFolder(root, options.dir), process.cwd());
      // One change at a time: appends, rewrites and the sequence number never interleave.
      let queue: Promise<unknown> = Promise.resolve();
      const serial = <T>(job: () => T | Promise<T>): Promise<T> => {
        const run = queue.then(job, job);
        queue = run.catch(() => undefined);
        return run;
      };
      const fail = (res: MarksResponse) => (e: unknown) => (e instanceof Refused ? send(res, e.status, { error: e.message }) : send(res, 500, { error: String(e) }));

      server.middlewares.use((req, res, next) => {
        // The page's base comes first (`/planet/__marks`); only the part from `/__marks` on is read.
        const url = (req.url ?? '').split('?')[0]!;
        const k = url.indexOf(SEGMENT);
        const tail = k < 0 ? null : url.slice(k + SEGMENT.length);
        if (tail === null || (tail !== '' && !tail.startsWith('/'))) return next();
        const method = req.method ?? 'GET';
        const changes = method !== 'GET' && method !== 'HEAD';
        if (!allowed(req, changes)) return send(res, 403, { error: 'only same-origin requests from localhost' });
        const rest = tail.slice(1);

        if (method === 'GET' && tail === '') return send(res, 200, f.read());
        if (method === 'GET' && PICTURE.test(rest)) {
          const p = f.picture(rest);
          return existsSync(p) ? send(res, 200, readFileSync(p), 'image/png') : send(res, 404, { error: 'no picture' });
        }
        if (method === 'POST' && tail === '') {
          void jsonBody(req)
            .then(async (data) => {
              const draft = data.mark;
              if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Refused(400, 'no mark');
              const note = (draft as { note?: unknown }).note;
              if (typeof note !== 'string' || note.length > MAX_NOTE) throw new Refused(400, `note must be text up to ${MAX_NOTE} characters`);
              let png: Buffer | null = null;
              let pictureNote = typeof data.pictureNote === 'string' ? data.pictureNote.slice(0, 300) : null;
              if (typeof data.png === 'string' && data.png.length > 0) {
                png = pngOf(data.png);
                if (!png) pictureNote = 'the page sent something that is not a PNG';
                else {
                  const pic = markPicture(png, (draft as { pixel?: unknown }).pixel);
                  png = pic.png;
                  if (pic.note) pictureNote = pic.note;
                }
              }
              const saved = await serial(() => {
                f.ensure();
                const seq = f.nextSeq();
                const id = `m${String(seq).padStart(4, '0')}`;
                if (png) writeFileSync(f.picture(id), png);
                const mark: Rec = { ...(draft as Rec), id, seq, savedAt: new Date().toISOString(), picture: png ? f.named(`${id}.png`) : null };
                // A new mark starts its tracking afresh, whatever the draft said.
                delete mark.status;
                delete mark.log;
                if (!png) mark.pictureNote = pictureNote ?? 'no picture sent';
                else delete mark.pictureNote;
                writeFileSync(f.list, `${JSON.stringify(mark)}\n`, { flag: 'a' });
                return mark;
              });
              send(res, 200, saved);
            })
            .catch(fail(res));
          return;
        }
        if (method === 'PATCH' && ID.test(rest)) {
          void jsonBody(req)
            .then(async (data) => send(res, 200, await serial(() => applyPatch(rest, checkPatch(rest, data, f), f))))
            .catch(fail(res));
          return;
        }
        if (method === 'DELETE' && ID.test(rest)) {
          void serial(() => {
            const all = f.lines();
            const kept = all.filter((l) => parse(l)?.id !== rest);
            if (kept.length === all.length) return false;
            f.write(kept);
            for (const name of [rest, ...f.afters(rest).map((n) => `${rest}-after-${n}`)]) if (existsSync(f.picture(name))) unlinkSync(f.picture(name));
            return true;
          })
            .then((gone) => send(res, gone ? 200 : 404, gone ? { deleted: rest } : { error: 'no such mark' }))
            .catch(fail(res));
          return;
        }
        send(res, 405, { error: 'not supported' });
      });
    },
  };
}
