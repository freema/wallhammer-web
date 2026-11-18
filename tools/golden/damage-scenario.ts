// Golden scenario of the damage of the endless example (examples/endless/src/structures.ts, page option dmg=1). Each
// check throws on a violation; the returned values go into the golden hash.
//   - the demo structure of the seed is hit by the page's two fixed events; the state goes into a `CellStates` store;
//   - the cells that draw it, generated with the store's text the way the page's provider asks for it, are the same
//     bytes generated alone, after other cells, after leaving (a new provider) and after the text was saved and loaded;
//   - the same events in a new run give the same store hash; without edits the cells are the intact ones, and a cell
//     with no damaged home cell under it is the same with or without the store;
//   - 40 other cells built in two orders in between leave the three cells' bytes alone; all three levels list the
//     demo structure; parts and rubble stay inside the home cell; a cell coarser than level 7 is the smooth cell under
//     another domain version; the cells survive the cell format;
//   - a store with a small ceiling over many hit structures stays within it, in units and in text length.

import { cellKey } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import type { CellId } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { CELL_STATES_CHARS_PER_UNIT, CellStates, applyEventToAll, compileStructure, decodeCellStates, rubbleFootprints } from '../../packages/wallhammer-web/src/sim/destruction/index.ts';
import { GeneratorCellProvider, decodeCell, encodeCell } from '../../packages/wallhammer-web/src/world/index.ts';
import type { CellEdits } from '../../packages/wallhammer-web/src/world/index.ts';
import { FACE, SHAPE, generateSmoothCell } from '../../examples/endless/src/terrain.ts';
import { DAMAGE_DOMAIN_VERSION, HOME_LEVEL, STRUCTURE_MIN_LEVEL, cellStructures, demoEvent, drawingCells, findDemoStructure, generateDamageCell, homeCellsUnder } from '../../examples/endless/src/structures.ts';

const SEED = 7;
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

/** The page's source of edits: the store's text of the cells at or under a cell, none below level 7. */
const editsOf = (store: CellStates): CellEdits => (c) => (c.level >= STRUCTURE_MIN_LEVEL ? store.text(c) : '');

/** The demo's two events on the structures of a home cell, applied in order the way the page applies them. */
function hitDemo(store: CellStates, home: CellId, first: number): number {
  const structures = cellStructures(SEED, home);
  let n = first;
  for (let k = 0; k < 2; k++) {
    for (const s of structures) {
      const r = applyEventToAll(structures, store.of(home), demoEvent(s, k, n++));
      if (r.changes.length > 0 && !store.commit(home, r.states).accepted) throw new Error(`damage: a commit in ${cellKey(home)} was refused`);
    }
  }
  return n;
}

/** Every part and every heap of rubble (ruins included) of the changed structures lies inside its home cell. */
function checkInside(s: CellStates): void {
  const edgeCm = SHAPE.edgeM(HOME_LEVEL) * 100;
  const inside = (xz: Int32Array): boolean => {
    for (let k = 0; k < xz.length; k++) if (xz[k]! < 0 || xz[k]! > edgeCm) return false;
    return true;
  };
  for (const home of s.cells()) {
    for (const d of cellStructures(SEED, home)) {
      const st = s.of(home).get(d.id);
      if (!d.parts.every((p) => inside(p.piece.xz))) throw new Error(`damage: a part of ${cellKey(home)}#${d.id} leaves its home cell`);
      if (st && !rubbleFootprints(compileStructure(d), st).every((f) => inside(f.corners))) throw new Error(`damage: rubble of ${cellKey(home)}#${d.id} leaves its home cell`);
    }
  }
}

export function damageScript(): unknown[] {
  const out: unknown[] = [];
  const demo = findDemoStructure(SEED);
  const store = new CellStates();
  hitDemo(store, demo.home, 0);
  if (store.structures === 0) throw new Error('damage: the demo events changed nothing');
  const hash = store.hash();
  const text = store.text();
  out.push(cellKey(demo.home), demo.structure.id, text, hash, store.units);

  // A new run of the same events: the same store.
  const again = new CellStates();
  hitDemo(again, demo.home, 0);
  if (again.hash() !== hash || again.text() !== text) throw new Error('damage: the same events gave another store');

  // The cells that draw the structure: damaged bytes alone, after other cells, after leaving and after save and load.
  const cells = drawingCells(demo.home);
  if (cells.length !== HOME_LEVEL - STRUCTURE_MIN_LEVEL + 1) throw new Error(`damage: ${cells.length} cells draw the demo structure`);
  const loaded = decodeCellStates(text);
  if (loaded.errors.length > 0 || loaded.store.hash() !== hash) throw new Error('damage: the saved text does not load to the same store');
  const intactProvider = new GeneratorCellProvider(SEED, generateDamageCell);
  for (const c of cells) {
    const alone = new GeneratorCellProvider(SEED, generateDamageCell, editsOf(store)).bytes(c);
    const busy = new GeneratorCellProvider(SEED, generateDamageCell, editsOf(store));
    for (const other of [SHAPE.parent(c)!, SHAPE.cellAt([demo.x + 900, 0, demo.z - 700], c.level)]) busy.bytes(other);
    const after = busy.bytes(c);
    const back = new GeneratorCellProvider(SEED, generateDamageCell, editsOf(again)).bytes(c);
    const reloaded = new GeneratorCellProvider(SEED, generateDamageCell, editsOf(loaded.store)).bytes(c);
    if (!eq(alone, after) || !eq(alone, back) || !eq(alone, reloaded)) throw new Error(`damage: cell ${cellKey(c)} is not the same bytes after leaving or loading`);
    const intact = intactProvider.bytes(c);
    if (eq(alone, intact)) throw new Error(`damage: cell ${cellKey(c)} draws the damaged structure intact`);
    if (!eq(intact, new GeneratorCellProvider(SEED, generateDamageCell, () => '').bytes(c))) throw new Error(`damage: empty edits changed ${cellKey(c)}`);
    out.push(cellKey(c), alone);
  }
  // 40 other cells built in two orders through one provider, then the three again: the same bytes.
  const others: CellId[] = [];
  for (let k = 0; k < 40; k++) others.push(SHAPE.cellAt([demo.x + (k % 8 - 4) * 300 + 1500, 0, demo.z + (Math.floor(k / 8) - 2) * 300], [9, 8, 7][k % 3]!));
  const shared = new GeneratorCellProvider(SEED, generateDamageCell, editsOf(store));
  const first = cells.map((c) => shared.bytes(c));
  for (const order of [others, [...others].reverse()]) {
    for (const c of order) shared.bytes(c);
    cells.forEach((c, i) => {
      if (!eq(first[i]!, shared.bytes(c))) throw new Error(`damage: cell ${cellKey(c)} changed after other cells were built`);
    });
  }

  // The three levels list the same structures; every part and every heap of rubble lies inside the home cell.
  const homesOf = cells.map((c) => homeCellsUnder(c).filter((h) => cellStructures(SEED, h).length > 0).map(cellKey));
  for (const list of homesOf) if (!list.includes(cellKey(demo.home))) throw new Error('damage: a level does not draw the demo structure');
  checkInside(store);
  out.push(homesOf);

  // A cell coarser than level 7 differs from the smooth generator in the domain version only; cell format round trip.
  const coarse = drawingCells(demo.home)[2]!;
  const level6 = SHAPE.parent(coarse)!;
  const plain = generateSmoothCell(SEED, level6);
  if (!eq(encodeCell({ ...plain, domainVersion: DAMAGE_DOMAIN_VERSION }), encodeCell(generateDamageCell(SEED, level6, text)))) throw new Error('damage: a coarse cell differs from the smooth cell beyond its domain version');
  for (const c of cells) {
    const bytes = new GeneratorCellProvider(SEED, generateDamageCell, editsOf(store)).bytes(c);
    if (!eq(encodeCell(decodeCell(bytes)), bytes)) throw new Error(`damage: cell ${cellKey(c)} does not survive the cell format`);
  }

  // A cell with no damaged home cell under it: the same with or without the store.
  const far = SHAPE.cellAt([demo.x + 2000, 0, demo.z + 2000], HOME_LEVEL);
  if (far.face !== FACE || store.text(far) !== '') throw new Error('damage: the far cell holds damage');
  if (!eq(intactProvider.bytes(far), new GeneratorCellProvider(SEED, generateDamageCell, editsOf(store)).bytes(far))) throw new Error('damage: the store changed a cell with no damage under it');

  // A ceiling of 60 units over the structures of the home cells round the demo.
  const small = new CellStates({ maxUnits: 60 });
  let n = 0;
  let hit = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const home = SHAPE.cellAt([demo.x + dx * SHAPE.edgeM(HOME_LEVEL), 0, demo.z + dy * SHAPE.edgeM(HOME_LEVEL)], HOME_LEVEL);
      if (cellStructures(SEED, home).length === 0) continue;
      n = hitDemo(small, home, n);
      hit++;
      if (small.units > small.maxUnits) throw new Error(`damage: ${small.units} units over a ceiling of ${small.maxUnits}`);
      if (small.text().length > CELL_STATES_CHARS_PER_UNIT * small.maxUnits) throw new Error('damage: the text outgrew its bound');
    }
  }
  const ruins = small.cells().reduce((sum, c) => sum + [...small.of(c).values()].filter((s) => s.ruin).length, 0);
  if (hit < 4 || ruins === 0) throw new Error(`damage: the ceiling was never reached (${hit} home cells hit, ${ruins} ruins)`);
  checkInside(small);
  out.push(hit, ruins, small.units, small.text(), small.hash());
  return out;
}
