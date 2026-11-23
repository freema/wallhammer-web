// Automatic check of the marks store (`marksStore` of wallhammer-web/marks-store) and of the command-line tool
// `wallhammer-marks`, on a scratch folder that is removed afterwards; it never touches internal/marks/. The plugin is
// mounted on a plain Node HTTP server on 127.0.0.1 (no Vite), requests go through node:http so the Host and Origin
// headers can be set. Cases: the folder's resolution, save (with a picture, with an empty one), list, patch (status,
// category, note, log), an after-picture (sent, and named through the tool), delete, and refused input.
//
//   node tools/marks/test.ts        (pnpm test:marks)

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marksFolder, marksStore } from '../../packages/wallhammer-web/src/marks-store/index.ts';
import type { MarksRequest, MarksResponse } from '../../packages/wallhammer-web/src/marks-store/index.ts';
import { readPng, writePng } from '../../packages/wallhammer-web/src/marks-store/png.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'packages/wallhammer-web/src/marks-store/cli.ts');

let failures = 0;
let passed = 0;
function ok(cond: unknown, name: string, detail = ''): void {
  if (cond) passed++;
  else {
    failures++;
    console.log(`FAIL marks: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A 32 × 16 RGBA picture, all grey, or all zero (`blank`), as a PNG. */
function png(blank = false): Buffer {
  const data = new Uint8Array(32 * 16 * 4).fill(blank ? 0 : 128);
  return writePng({ width: 32, height: 16, channels: 4, data });
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'wh-marks-test-'));
const store = path.join(scratch, 'store');
const savedEnv = process.env.WH_MARKS_DIR;
delete process.env.WH_MARKS_DIR;

// The folder: WH_MARKS_DIR, else the option (relative to the root), else .marks in the root.
ok(marksFolder('/p') === path.resolve('/p/.marks'), 'default folder is .marks in the root');
ok(marksFolder('/p', 'notes/m') === path.resolve('/p/notes/m'), 'a relative dir resolves against the root');
ok(marksFolder('/p', '/abs/m') === path.resolve('/abs/m'), 'an absolute dir stays');
ok(marksFolder('/p', 'x', { WH_MARKS_DIR: '/env/m' }) === path.resolve('/env/m'), 'WH_MARKS_DIR wins over the option');

// The plugin on a plain HTTP server.
const plugin = marksStore({ dir: 'store' });
ok(plugin.name.length > 0 && plugin.apply === 'serve', 'the plugin is a dev-server plugin');
plugin.configResolved({ root: scratch });
let handler: ((req: MarksRequest, res: MarksResponse, next: () => void) => void) | null = null;
plugin.configureServer({ middlewares: { use: (fn) => void (handler = fn) } });
const server = http.createServer((req, res) =>
  handler!(req, res, () => {
    res.statusCode = 404;
    res.end('next');
  }),
);
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as AddressInfo).port;
const origin = `http://127.0.0.1:${port}`;

interface Answer {
  status: number;
  type: string;
  body: Buffer;
  json: () => any;
}
function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h: Record<string, string> = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'x-marks': '1' } : {}), ...headers };
  return new Promise((done, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const b = Buffer.concat(parts);
        done({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: b, json: () => JSON.parse(b.toString('utf8')) });
      });
    });
    req.on('error', fail);
    if (data) req.write(data);
    req.end();
  });
}

const draft = (note: string) => ({
  note,
  page: '/scene/',
  point: { world: [1, 2, 3], distanceM: 12.5, surface: 'ground', place: { x: 1, z: 3 }, accuracy: { method: 'test' } },
  pixel: { x: 16, y: 8 },
  canvas: { width: 32, height: 16, cssWidth: 32, cssHeight: 16 },
  view: { hash: 'cam=1,2,3' },
  facts: { seed: 7 },
});

try {
  // Nothing yet.
  let r = await request('GET', '/scene/__marks');
  ok(r.status === 200 && Array.isArray(r.json()) && r.json().length === 0, 'an empty store lists nothing', `${r.status} ${r.body}`);
  r = await request('GET', '/scene/other');
  ok(r.status === 404 && r.body.toString() === 'next', 'other paths go to the next middleware');

  // Save with a picture: the clicked pixel is circled, the record gets an id, a sequence and a path.
  r = await request('POST', '/scene/__marks', { mark: { ...draft('first'), status: 'fixed', log: [{}] }, png: png().toString('base64'), pictureNote: null });
  const first = r.json();
  ok(r.status === 200 && first.id === 'm0001' && first.seq === 1, 'save gives m0001', `${r.status} ${r.body}`);
  ok(first.status === undefined && first.log === undefined, 'a new mark starts its tracking afresh');
  ok(typeof first.picture === 'string' && first.picture.endsWith('m0001.png') && existsSync(path.join(store, 'm0001.png')), 'the picture is written', String(first.picture));
  const pic = readPng(readFileSync(path.join(store, 'm0001.png')));
  ok(typeof pic !== 'string' && pic.data.some((v, i) => i % 4 === 0 && v !== 128), 'the clicked pixel is circled');

  // Save with an empty read-back: no picture, and why.
  r = await request('POST', '/scene/__marks', { mark: draft('second'), png: png(true).toString('base64') });
  const second = r.json();
  ok(r.status === 200 && second.id === 'm0002' && second.picture === null && /empty/.test(second.pictureNote), 'an empty picture is not kept', `${r.body}`);

  // The list on disk and through the store.
  r = await request('GET', '/scene/__marks');
  ok(r.json().length === 2 && r.json()[0].note === 'first', 'the store lists both, oldest first');
  r = await request('GET', '/scene/__marks/m0001.png');
  ok(r.status === 200 && r.type === 'image/png' && r.body.subarray(1, 4).toString() === 'PNG', 'the picture is served');

  // Patch: status, category, note; each appends one log entry.
  r = await request('PATCH', '/scene/__marks/m0001', { by: 'agent:test', status: 'seen' });
  ok(r.status === 200 && r.json().status === 'seen' && r.json().log.length === 1 && r.json().log[0].text === 'new → seen', 'patch sets a status and logs it', `${r.body}`);
  r = await request('PATCH', '/scene/__marks/m0001', { by: 'developer', category: 'look', note: 'first, edited' });
  const edited = r.json();
  ok(edited.category === 'look' && edited.note === 'first, edited' && edited.log.length === 2 && edited.log[1].was.note === 'first', 'patch changes the note and category and keeps what was');

  // An after-picture sent with the change.
  r = await request('PATCH', '/scene/__marks/m0001', { by: 'agent:test', status: 'fixed', text: 'repaired', png: png().toString('base64') });
  const fixed = r.json();
  ok(r.status === 200 && fixed.status === 'fixed' && /m0001-after-1\.png$/.test(fixed.log[2].picture) && existsSync(path.join(store, 'm0001-after-1.png')), 'fixed with an after-picture', `${r.body}`);
  r = await request('GET', '/scene/__marks/m0001-after-1.png');
  ok(r.status === 200 && r.type === 'image/png', 'the after-picture is served');

  // A line that is not JSON stays where it is through a rewrite.
  const list = path.join(store, 'marks.jsonl');
  writeFileSync(list, `${readFileSync(list, 'utf8')}not json\n`);
  r = await request('PATCH', '/scene/__marks/m0002', { by: 'agent:test', text: 'a note only' });
  ok(r.status === 200 && r.json().log[0].text === 'a note only' && readFileSync(list, 'utf8').includes('not json\n'), 'a rewrite keeps other lines as they are');

  // Refused input.
  const refused: [string, Promise<Answer>, number][] = [
    ['a change without x-marks', request('PATCH', '/scene/__marks/m0001', { by: 'x', text: 'y' }, { 'x-marks': '0' }), 403],
    ['a Host other than localhost', request('GET', '/scene/__marks', undefined, { host: 'example.com' }), 403],
    ['another Origin', request('PATCH', '/scene/__marks/m0001', { by: 'x', text: 'y' }, { origin: 'http://localhost:1' }), 403],
    ['a cross-site fetch', request('GET', '/scene/__marks', undefined, { 'sec-fetch-site': 'cross-site' }), 403],
    ['a body that is not JSON', request('POST', '/scene/__marks', '{not json'), 400],
    ['a save without a mark', request('POST', '/scene/__marks', { png: null }), 400],
    ['a note too long', request('POST', '/scene/__marks', { mark: draft('x'.repeat(2001)) }), 400],
    ['a change without by', request('PATCH', '/scene/__marks/m0001', { status: 'seen' }), 400],
    ['an unknown status', request('PATCH', '/scene/__marks/m0001', { by: 'x', status: 'done' }), 400],
    ['an unknown category', request('PATCH', '/scene/__marks/m0001', { by: 'x', category: 'art' }), 400],
    ['fixed without an after-picture', request('PATCH', '/scene/__marks/m0002', { by: 'x', status: 'fixed' }), 400],
    ['a png that is not one', request('PATCH', '/scene/__marks/m0002', { by: 'x', png: Buffer.from('nope').toString('base64') }), 400],
    ['an afterFile of another mark', request('PATCH', '/scene/__marks/m0002', { by: 'x', afterFile: 'm0001-after-1.png' }), 400],
    ['nothing to change', request('PATCH', '/scene/__marks/m0002', { by: 'x' }), 400],
    ['an unknown mark', request('PATCH', '/scene/__marks/m0099', { by: 'x', text: 'y' }), 404],
    ['a picture name outside the pattern', request('GET', '/scene/__marks/..%2Fmarks.jsonl'), 405],
  ];
  for (const [name, p, status] of refused) {
    const a = await p;
    ok(a.status === status, `refused: ${name}`, `${a.status} ${a.body}`);
  }

  // The command-line tool against the same folder: list, and set with an after-picture already in the folder.
  // Asynchronous: `set` asks the server in this same process, which must keep answering meanwhile.
  const run = (...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, WH_MARKS_DIR: '' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => child.kill(), 20_000);
      child.on('error', fail);
      child.on('close', (status) => {
        clearTimeout(timer);
        done({ status, stdout, stderr });
      });
    });
  let c = await run('list', '--json', '--dir', store);
  ok(c.status === 0 && JSON.parse(c.stdout).length === 2, 'wallhammer-marks list --json reads the folder', c.stderr);
  c = await run('list', '--open', '--dir', store);
  ok(c.status === 0 && /m0001\s+fixed/.test(c.stdout) && /2 mark\(s\) open/.test(c.stdout), 'wallhammer-marks list --open keeps fixed marks', c.stdout + c.stderr);
  c = await run('list', '--md', '--dir', store, '--url', origin);
  ok(c.status === 0 && readFileSync(path.join(store, 'marks.md'), 'utf8').includes(`${origin}/scene/#cam=1,2,3`), 'wallhammer-marks list --md writes the links', c.stderr);
  writeFileSync(path.join(store, 'm0002-after-1.png'), png());
  c = await run('set', 'm0002', '--by', 'agent:test', '--status', 'fixed', '--after', path.join(store, 'm0002-after-1.png'), '--dir', store, '--url', origin);
  const m2 = (JSON.parse((await run('list', '--json', '--dir', store)).stdout) as { id: string; status: string; log: { picture?: string }[] }[]).find((m) => m.id === 'm0002');
  ok(c.status === 0 && m2?.status === 'fixed' && /m0002-after-1\.png$/.test(m2.log.at(-1)?.picture ?? ''), 'wallhammer-marks set names an after-picture in the folder', c.stdout + c.stderr);
  c = await run('set', '2', '--by', 'agent:test', '--status', 'accepted', '--dir', store, '--url', origin);
  ok(c.status === 2 && /developer/.test(c.stderr), 'wallhammer-marks set refuses accepted', c.stderr);
  c = await run('set', '2', '--by', 'agent:test', '--status', 'fixed', '--dir', store, '--url', origin);
  ok(c.status === 2 && /--after/.test(c.stderr), 'wallhammer-marks set refuses fixed without --after', c.stderr);
  c = await run('list', '--dir', path.join(scratch, 'none'));
  ok(c.status === 0 && /No marks yet/.test(c.stdout), 'wallhammer-marks list on an empty folder', c.stdout + c.stderr);
  c = await run('nonsense');
  ok(c.status === 2, 'an unknown command fails');

  // Delete: the record and every picture of the mark go.
  r = await request('DELETE', '/scene/__marks/m0001', undefined, { 'x-marks': '1' });
  ok(r.status === 200 && !existsSync(path.join(store, 'm0001.png')) && !existsSync(path.join(store, 'm0001-after-1.png')), 'delete removes the mark and its pictures', `${r.body}`);
  r = await request('GET', '/scene/__marks');
  ok(r.json().length === 1 && r.json()[0].id === 'm0002', 'the list holds the rest');
  r = await request('POST', '/scene/__marks', { mark: draft('third') });
  ok(r.json().id === 'm0003', 'an id is never reused', r.json().id);
} finally {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
  if (savedEnv !== undefined) process.env.WH_MARKS_DIR = savedEnv;
}

console.log(`marks: ${passed} of ${passed + failures} cases ok`);
process.exit(failures ? 1 : 0);
