// Self-test of the dependency check: the valid fixture must pass, the known-bad one must fail on every rule.
//   node tools/layers/test.ts

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, 'check.ts');

function run(name: string): { status: number; out: string } {
  const r = spawnSync(process.execPath, [CHECK, '--root', path.join(HERE, 'fixtures', name)], { encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout + r.stderr };
}

let failed = false;
const good = run('good');
if (good.status !== 0) {
  failed = true;
  console.log(`FAIL: the valid fixture did not pass:\n${good.out}`);
} else console.log('ok: valid fixture passes');

const bad = run('bad');
if (bad.status === 0) {
  failed = true;
  console.log('FAIL: the known-bad fixture passed');
}
const expected = [
  '[stray-file]',
  '[unknown-module]',
  '[upward]',
  '[same-layer]',
  '[engine-imports-content]',
  '[content-imports-app]',
  '[content-imports-content]',
  '[content-imports-engine]',
  '[example-imports]',
  '[webgl]',
  '[dom]',
  '[worker]',
  '[sim-headless]',
  '[sim-nondeterministic]',
  '[use-case-word]',
  '[subfolder-order]',
  '[node-only]',
];
for (const e of expected) {
  if (!bad.out.includes(e)) {
    failed = true;
    console.log(`FAIL: the known-bad fixture did not report ${e}`);
  }
}
// Every case of the subfolder order has its own file; each must be reported on its own.
const subfolderCases = ['structure/to-damage.ts', 'structure/to-interior.ts', 'interior/to-damage.ts', 'damage/to-root.ts', 'loose/stray.ts'];
const lines = bad.out.split('\n');
for (const c of subfolderCases) {
  const file = `packages/wallhammer-web/src/gen-arch/${c}:`;
  if (!lines.some((l) => l.startsWith(file) && l.includes('[subfolder-order]'))) {
    failed = true;
    console.log(`FAIL: the known-bad fixture did not report [subfolder-order] for gen-arch/${c}`);
  }
}
// examples/shared (code used by several examples) may import neither an example nor a content module; each case on its own.
const sharedCases = ['to-example.ts', 'to-content.ts'];
for (const c of sharedCases) {
  const file = `examples/shared/src/${c}:`;
  if (!lines.some((l) => l.startsWith(file) && l.includes('[example-imports]'))) {
    failed = true;
    console.log(`FAIL: the known-bad fixture did not report [example-imports] for examples/shared/src/${c}`);
  }
}
// Node-only modules: a Node built-in in a page module, the Node-only module imported by the engine and by an example's
// page code; each case on its own.
const nodeCases = ['packages/wallhammer-web/src/world/files.ts', 'packages/wallhammer-web/src/tools/store.ts', 'examples/demo/src/store.ts'];
for (const c of nodeCases) {
  if (!lines.some((l) => l.startsWith(`${c}:`) && l.includes('[node-only]'))) {
    failed = true;
    console.log(`FAIL: the known-bad fixture did not report [node-only] for ${c}`);
  }
}
const findings = expected.length + subfolderCases.length + sharedCases.length + nodeCases.length;
if (!failed) console.log(`ok: known-bad fixture fails with all ${findings} expected findings`);
else console.log(bad.out);
process.exit(failed ? 1 : 0);
