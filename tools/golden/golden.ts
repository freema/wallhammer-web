// Golden hashes of the generators of the examples: small fixed recipes, each run through one generator, its output
// bytes hashed and compared with the stored hash. A generator is pure (input + seed → data), so any difference is a
// real change. These recipes need example code (examples/endless, planet, system); the recipes of the engine alone
// are in tools/golden/engine/ of this repository.
//
//   node tools/golden/golden.ts            check (exit code 1 and the generator's name on a mismatch)
//   node tools/golden/golden.ts --accept   store the current hashes after a deliberate change (see README.md)

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { borderSeams, fileEqualsGenerator, levelSeams, managerScript, orderIndependence, selectionScript, smoothCells } from './streaming-scenario.ts';
import { horizonSamples, noiseTable, shapeScript, sphereCells, sphereCoverage, sphereSeams } from './sphere-scenario.ts';
import { planetCells, planetFlight } from './planet-scenario.ts';
import { systemCells, systemFlights } from './system-scenario.ts';
import { endlessStripScript, planetStripScript } from './strip-scenario.ts';
import { damageScript } from './damage-scenario.ts';
import { worldPlanClimate, worldPlanRoutes, worldPlanSites, worldPlanWater } from './plan-scenario.ts';
import { structuresScript } from './structures-scenario.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, 'hashes.json');

/** Hash of typed arrays (their bytes) and plain values (as JSON), in order. */
function hash(...parts: unknown[]): string {
  const h = createHash('sha256');
  const feed = (p: unknown): void => {
    if (ArrayBuffer.isView(p)) h.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    else if (Array.isArray(p)) p.forEach(feed);
    else h.update(JSON.stringify(p) ?? 'undefined');
  };
  parts.forEach(feed);
  return h.digest('hex').slice(0, 16);
}

// --- Recipes: one generator each ------------------------------------------------------------------------------------
const streamingFiles = await fileEqualsGenerator();
const streamingSmoothFiles = await smoothCells();

const RECIPES: Record<string, () => string> = {
  'streaming cell bytes (alone = after neighbours, any order; near and 10,000 km out)': () => hash(orderIndependence()),
  'streaming seams (border vertices of neighbours equal, near and 10,000 km out)': () => hash(borderSeams()),
  'streaming file provider = generator bytes (WHC1 round trip)': () => hash(streamingFiles),
  'streaming manager (requests and cover on a scripted camera path; no overlap, settled cover complete)': () => hash(managerScript()),
  'streaming smooth cells (format 2 with shape hash and error: order-independent, round trip, files by shape)': () => hash(streamingSmoothFiles),
  'streaming seams between levels (cell blended into its parent = the parent; border of a coarser neighbour; skirt depth)': () => hash(levelSeams()),
  'streaming coverage by screen-space error (scripted zoom: no hole, no overlap, never below an unloaded cell, budgets, ahead first)': () => hash(selectionScript()),
  'gen-core noise in space (valueNoise3 and fractalNoise3: table of values, range, continuity across the lattice)': () => hash(noiseTable()),
  'world sphere shape (six quadtrees: neighbours across edges and at corners of the cube, parents, points, distances, cells near a point; frame of an upright object)': () => hash(shapeScript()),
  'gen-core sphere patch seams (same-level neighbours agree in every attribute inside a face and across the cube; blended cells lie on the parent and on coarser neighbours; skirt depth)': () => hash(sphereSeams()),
  'streaming sphere cells (order-independent bytes, shape hash and error, instances owned by one cell per level and standing on the surface)': () => hash(sphereCells()),
  'world horizon test (never hides what a straight line of sight reaches; far radius of a box)': () => hash(horizonSamples()),
  'streaming sphere coverage (descent from 300 km to 30 m across an edge of the cube and back: all six faces covered exactly once, no hole)': () => hash(sphereCoverage()),
  'planet example cells (start place from the seed; order-independent bytes, round trip, every object of a cell in exactly one child)': () => hash(planetCells()),
  'planet example flight (poses from the ground to the whole sphere in view and back, mirrored; the sphere covered exactly once at every step of the flight)': () => hash(planetFlight()),
  'system example cells (every body its own surface from one generator; order-independent bytes, round trip, a place to land from the seed)': () => hash(systemCells()),
  'planet example strips (main line 50 km over an edge of the cube, a node of three lines; strip mesh at levels 0, 4, 8 and 10–11 near the edge and the node: lengths, shared sections, blend to the parent, never under the ground; surface = shape; whole cells order-free, round trip)': () => hash(planetStripScript()),
  'endless example strips (strip mesh at levels 6 and 9: lengths, shared sections, blend to the parent, never under the ground; whole cells order-free, round trip; off the strips the smooth cell under another domain version)': () => hash(endlessStripScript()),
  'endless example damage (the demo structure hit by the page\'s two events: the cells that draw it are the same bytes alone, after other cells, after leaving and after the state was saved and loaded; the same events give the same store hash; no edits = intact; a ceiling of 60 units holds over many hit structures)': () => hash(damageScript()),
  'world plan: water (stage 1, seed 725: rivers fall, 30–160 m steps, lines ≤ 1300 m, nodes join two lines, every walk downstream ends in the sea or a lake at its level; lakes on land; round trip, same bytes twice, seed 726 differs; tile index = brute force)': () => worldPlanWater(),
  'world plan: climate (stage 2: water nodes wet ≥ 200, near the great rivers wetter than far from water; the water fingerprint of stage 1; round trip)': () => worldPlanClimate(),
  'world plan: sites (stage 3: ≥ 40 sites 9 km apart, the town first; on flat dry land with 2–6 gates; earlier fingerprints unchanged; round trip)': () => worldPlanSites(),
  'world plan: routes (stage 4: roads and decks within the grade limit, nodes at one height, decks clear the water; earlier fingerprints unchanged; same bytes twice; routePoint without jumps)': () => worldPlanRoutes(),
  'system example structures (five kinds in a village, mesh bytes, massing of a village and a span with piers and parapets, damage state there and back)': () => hash(structuresScript()),
  'system example flights (reaches nested or apart; surface to surface of a neighbour and a descent from the whole system: no jump, legs meet at one speed, the neighbour in the sky at the landing)': () => hash(systemFlights()),
};

const accept = process.argv.includes('--accept');
const stored = fs.existsSync(STORE) ? (JSON.parse(fs.readFileSync(STORE, 'utf8')) as Record<string, string>) : {};
const now: Record<string, string> = {};
let failed = 0;
for (const [name, run] of Object.entries(RECIPES)) {
  now[name] = run();
  if (accept) continue;
  if (stored[name] === undefined) {
    failed++;
    console.log(`MISSING ${name}: no stored hash (run with --accept to store ${now[name]})`);
  } else if (stored[name] !== now[name]) {
    failed++;
    console.log(`CHANGED ${name}: output differs from the stored hash (${stored[name]} → ${now[name]})`);
  } else console.log(`ok ${name}`);
}
if (accept) {
  fs.writeFileSync(STORE, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`golden: stored ${Object.keys(now).length} hashes in ${path.relative(process.cwd(), STORE)}`);
} else {
  for (const name of Object.keys(stored)) if (!(name in RECIPES)) console.log(`note: stored hash "${name}" has no recipe any more`);
  console.log(`golden: ${Object.keys(RECIPES).length - failed} of ${Object.keys(RECIPES).length} generators unchanged`);
  process.exit(failed ? 1 : 0);
}
