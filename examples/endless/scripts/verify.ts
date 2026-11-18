// Checks that every baked file holds exactly the bytes the generator produces for its cell (file provider and
// generator provider must not drift apart). Reads the files through FileCellProvider with a file-system fetch.
//
//   node scripts/verify.ts [--seed 7] [--smooth]
//
// --smooth checks the cells of smooth levels of detail (baked with --smooth into the folder named by the shape hash).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCellProvider, GeneratorCellProvider, encodeCell } from 'wallhammer-web/world';
import { parseCellKey, shapeHash } from 'wallhammer-web/gen-core';
import { cellFilePath } from 'wallhammer-web/world';
import { SHAPE, generateCell, generateSmoothCell } from '../src/terrain.ts';

const i = process.argv.indexOf('--seed');
const seed = i >= 0 ? Number(process.argv[i + 1]) : 7;
const smooth = process.argv.includes('--smooth');
const shape = smooth ? shapeHash(SHAPE) : undefined;
const seedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cells', String(seed));
// Shaped cells live in a folder named by the shape hash; the folder is the part of `cellFilePath` before the face.
const shapeDir = shape === undefined ? '' : cellFilePath({ face: 0, level: 0, x: 0, y: 0 }, shape).split('/')[0]!;
const root = path.join(seedRoot, shapeDir);
const files: string[] = [];
const walk = (d: string, top: boolean): void => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    // Folders of shaped cells next to the plain ones belong to a run with --smooth.
    if (top && !smooth && e.isDirectory() && /^s[0-9a-f]{8}$/.test(e.name)) continue;
    if (e.isDirectory()) walk(path.join(d, e.name), false);
    else files.push(path.join(d, e.name));
  }
};
walk(root, true);
const fromDisk = new FileCellProvider(
  'file:',
  async (url) => {
    const b = fs.readFileSync(path.join(seedRoot, url.slice('file:/'.length)));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
  shape === undefined ? {} : { shapeHash: shape },
);
const gen = new GeneratorCellProvider(seed, smooth ? generateSmoothCell : generateCell);
let bad = 0;
for (const f of files.sort()) {
  const [face, level, x, y] = path.relative(root, f).replace(/\.whc$/, '').split(path.sep);
  const cell = parseCellKey(`${face}/${level}/${x}/${y}`);
  const r = await fromDisk.request(cell, new AbortController().signal);
  const a = r.bytes!;
  const b = gen.bytes(cell);
  // Re-encoding the decoded file must also give the same bytes (the format round-trips).
  const c = encodeCell(r.content);
  if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0 || Buffer.compare(Buffer.from(c), Buffer.from(b)) !== 0) {
    bad++;
    console.log(`DIFFERENT: ${path.relative(root, f)}`);
  }
}
console.log(`${files.length - bad} of ${files.length} baked cells equal the generator's bytes`);
process.exit(bad ? 1 : 0);
