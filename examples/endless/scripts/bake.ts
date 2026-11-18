// Bakes cells of the endless world into files: public/cells/<seed>/<face>/<level>/<x>/<y>.whc, the bytes the worker
// would hand over. Runs in Node (in Docker): docker compose exec -T endless sh -c 'cd /app/examples/endless && pnpm bake'
//
//   node scripts/bake.ts [--seed 7] [--x 0] [--z 0] [--steps 2] [--spacing 600] [--altitude 300] [--smooth]
//
// --smooth bakes the cells of smooth levels of detail (lod=smooth) instead. They state the hash of the world shape,
// which also names their folder: public/cells/<seed>/s<hash>/<face>/<level>/<x>/<y>.whc.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellKey, shapeHash } from 'wallhammer-web/gen-core';
import type { CellId } from 'wallhammer-web/gen-core';
import { GeneratorCellProvider, cellFilePath } from 'wallhammer-web/world';
import { SHAPE, generateCell, generateSmoothCell } from '../src/terrain.ts';
import { planArea } from './plan.ts';

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const seed = arg('seed', 7);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cells', String(seed));
const smooth = process.argv.includes('--smooth');
const gen = new GeneratorCellProvider(seed, smooth ? generateSmoothCell : generateCell);
// Smooth levels: the plan depends on the error of each cell, so the planner generates the cells it asks about.
const errors = new Map<string, number | undefined>();
const errorOf = (c: CellId): number | undefined => {
  const k = cellKey(c);
  if (!errors.has(k)) errors.set(k, gen.generateNow(c).error);
  return errors.get(k);
};
const cells = planArea(arg('x', 0), arg('z', 0), arg('steps', 2), arg('spacing', 600), arg('altitude', 300), smooth ? errorOf : undefined);
let bytes = 0;
const t0 = performance.now();
for (const c of cells) {
  const b = gen.bytes(c);
  const file = path.join(out, cellFilePath(c, smooth ? shapeHash(SHAPE) : undefined));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b);
  bytes += b.byteLength;
}
const ms = performance.now() - t0;
console.log(`baked ${cells.length} cells, ${(bytes / 1048576).toFixed(1)} MB, ${(ms / cells.length).toFixed(1)} ms/cell → ${out}`);
