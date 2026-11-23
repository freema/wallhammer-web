#!/usr/bin/env node
// Changes a mark through the dev server's store (tools/vite/marks-store.ts, PATCH <page>__marks/<id>): its status, its
// category, and one entry appended to its log, optionally with an after-picture. Needs the example server
// (docker compose up -d); runs on the host or in the container. No dependencies.
//
//   node tools/marks/set.mjs m0007 --status seen --by agent:clouds
//   node tools/marks/set.mjs m0007 --status working --by agent:clouds --text "the shadow edge of the deck"
//   node tools/marks/set.mjs m0007 --status fixed --by agent:clouds --text "the edge fades over 200 m" \
//        --after internal/marks/m0007-after-1.png
//   options: --category bug|look|idea|none   --url http://127.0.0.1:5281
//
// An agent sets seen, working, fixed or wontfix; accepted and reopened are the developer's (in the page's panel).
// `fixed` needs --after: a picture of the mark's saved view after the repair (tools/marks/shoot.mjs takes it). A picture
// already in the store's folder under the name <id>-after-<n>.png is referred to; any other PNG is sent and saved there.
// The id may be given as m0007, 7 or #7. The mark's page (`/planet/`) says which example's store answers.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { CATEGORIES, DIR, SERVER, markId, readMarks } from './common.mjs';

const AGENT_STATUSES = ['seen', 'working', 'fixed', 'wontfix'];

function fail(text) {
  console.error(`set.mjs: ${text}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
    opts[a.slice(2)] = v;
    i++;
  } else pos.push(a);
}
const known = new Set(['status', 'by', 'text', 'after', 'category', 'url']);
for (const k of Object.keys(opts)) if (!known.has(k)) fail(`unknown option --${k}`);
if (pos.length !== 1) fail('usage: set.mjs <id> --by <label> [--status seen|working|fixed|wontfix] [--text "…"] [--after picture.png] [--category bug|look|idea|none]');
const id = markId(pos[0]);
if (!id) fail(`not a mark id: ${pos[0]}`);
if (!opts.by || !opts.by.trim()) fail('--by <label> is needed (agent:<topic>)');
if (opts.status !== undefined && !AGENT_STATUSES.includes(opts.status)) fail(`--status: one of ${AGENT_STATUSES.join(', ')} (accepted and reopened are the developer's, in the page)`);
if (opts.category !== undefined && opts.category !== 'none' && !CATEGORIES.includes(opts.category)) fail(`--category: one of ${CATEGORIES.join(', ')}, none`);
if (opts.status === 'fixed' && !opts.after) fail('--status fixed needs --after <picture of the same view after the repair> (tools/marks/shoot.mjs)');
if (opts.status === undefined && opts.text === undefined && opts.after === undefined && opts.category === undefined) fail('nothing to change: give --status, --text, --after or --category');

const mark = (readMarks() ?? []).find((m) => m.id === id);
if (!mark) fail(`no mark ${id} in ${DIR}`);
if (typeof mark.page !== 'string' || !mark.page.startsWith('/')) fail(`${id} has no page to address its store`);

const body = { by: opts.by.trim() };
if (opts.status) body.status = opts.status;
if (opts.text !== undefined) body.text = opts.text;
if (opts.category !== undefined) body.category = opts.category === 'none' ? null : opts.category;
if (opts.after) {
  const path = resolve(opts.after);
  if (!existsSync(path)) fail(`--after: ${path} does not exist`);
  const name = basename(path);
  if (dirname(path) === DIR && new RegExp(`^${id}-after-\\d{1,6}\\.png$`).test(name)) body.afterFile = name;
  else body.png = readFileSync(path).toString('base64');
}

const url = (opts.url ?? SERVER).replace(/\/+$/, '');
let r;
try {
  r = await fetch(`${url}${mark.page}__marks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-marks': '1' }, body: JSON.stringify(body) });
} catch (e) {
  fail(`the example server at ${url} is not reachable (docker compose up -d): ${e.cause?.message ?? e.message}`);
}
const text = await r.text();
if (!r.ok) fail(`${r.status} ${text}`);
const m = JSON.parse(text);
const e = m.log.at(-1);
console.log(`${m.id}: ${m.status} (log ${e.seq}: ${e.by}: ${e.text}${e.picture ? `; after-picture ${e.picture}` : ''})`);
