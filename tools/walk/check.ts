// Headless check of walking in the engine: the collision world, the walker and the follow camera, in plain Node,
// without a browser or graphics. One line per scenario; exit code 1 when a check fails or the run takes over 5 s.
//
//   node tools/walk/check.ts            all scenarios      (pnpm check:walk)
//   node tools/walk/check.ts slide      only scenarios whose name contains "slide"
//
// To add a package of scenarios: write `<package>-scenarios.ts` next to this file exporting a `Scenario[]`
// (see scenario.ts), import it below and append it to PACKAGES. Names must be unique.

import { COLLIDE_SCENARIOS } from './collide-scenarios.ts';
import { COURSE_SCENARIOS } from './course-scenarios.ts';
import type { Scenario } from './scenario.ts';
import { STREAMING_SCENARIOS } from './streaming-scenarios.ts';
import { WALKER_SCENARIOS } from './walker-scenarios.ts';

const PACKAGES: { label: string; scenarios: Scenario[] }[] = [
  { label: 'collision world', scenarios: COLLIDE_SCENARIOS },
  { label: 'walker', scenarios: WALKER_SCENARIOS },
  { label: 'test course (examples/walk)', scenarios: COURSE_SCENARIOS },
  { label: 'streaming preload along a path', scenarios: STREAMING_SCENARIOS },
];

const LIMIT_MS = 5000;
const filter = process.argv[2] ?? '';
const start = performance.now();
let failed = 0;
let run = 0;
const names = new Set<string>();

for (const pkg of PACKAGES) {
  console.log(`# ${pkg.label}`);
  for (const sc of pkg.scenarios) {
    if (names.has(sc.name)) throw new Error(`check:walk: duplicate scenario name ${sc.name}`);
    names.add(sc.name);
    if (filter && !sc.name.includes(filter)) continue;
    run++;
    const t0 = performance.now();
    let ok: boolean;
    let detail: string;
    try {
      const r = sc.run();
      ok = r.ok;
      detail = r.detail;
    } catch (e) {
      ok = false;
      detail = `threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
    }
    const ms = performance.now() - t0;
    const timing = sc.kind === 'timing';
    const word = ok ? 'ok  ' : timing ? 'slow' : 'FAIL';
    if (!ok && !timing) failed++;
    console.log(`${word} ${sc.name} (${ms.toFixed(0)} ms): ${detail}`);
  }
}

const total = performance.now() - start;
const late = total > LIMIT_MS;
console.log(`walk: ${run - failed} of ${run} scenarios ok, ${total.toFixed(0)} ms${late ? ` (over the limit of ${LIMIT_MS} ms)` : ''}`);
if (failed > 0 || late || run === 0) process.exit(1);
