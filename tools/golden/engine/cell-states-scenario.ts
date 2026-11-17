// Scenarios for the golden hashes of damage in a streamed world: the store of changed structure states by home cell
// (sim/destruction) and the refresh of streamed cells whose content went out of date (world). Each returns plain data
// to hash and throws when a property that must hold does not.

import type { StructureState } from '../../../packages/wallhammer-web/src/base/index.ts';
import { FlatWorld, cellId, cellKey, compareCells } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import type { CellId } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { CELL_STATES_CHARS_PER_UNIT, CellStates, decodeCellStates } from '../../../packages/wallhammer-web/src/sim/destruction/index.ts';
import { DEFAULT_STREAMING, StreamingManager } from '../../../packages/wallhammer-web/src/world/index.ts';
import type { CellRequest, StreamingConfig } from '../../../packages/wallhammer-web/src/world/index.ts';
import { runDestruction } from './destruction-scenario.ts';

/** A changed state with `n` part entries (rung 1 to 3 in turn), or a ruin. */
function synthetic(id: number, n: number, ruin = false): StructureState {
  const parts = new Map<number, number>();
  if (!ruin) for (let k = 0; k < n; k++) parts.set(10 + k * 3, (k % 3) + 1);
  return { structure: id, ruin, parts };
}

function states(...list: StructureState[]): Map<number, StructureState> {
  return new Map(list.map((s) => [s.structure, s]));
}

/**
 * The store: the scripted destruction state in one home cell, synthetic states in cells on two faces and levels with
 * negative coordinates. Checks: the order of commits does not change text or hash; the text decodes to the same store;
 * `under` finds exactly the cells below a coarse cell; an empty store has empty text; malformed pieces are reported and
 * skipped; a small ceiling ruins the largest structures by the fixed rule and keeps `units ≤ maxUnits`; a store full of
 * ruins refuses a commit and stays as it was; the text stays within its length bound.
 */
export function cellStatesScript(): unknown[] {
  const out: unknown[] = [];
  const scripted = runDestruction().states;
  const commits: [CellId, Map<number, StructureState>][] = [
    [cellId(2, 9, 140, 77), scripted],
    [cellId(2, 9, -3, 5), states(synthetic(4, 6), synthetic(9, 2))],
    [cellId(2, 8, -2, 2), states(synthetic(1, 0, true))],
    [cellId(5, 9, 0, -1), states(synthetic(7, 3), { structure: 8, ruin: false, parts: new Map() })],
    [cellId(2, 10, -5, 10), states(synthetic(3, 4))],
  ];
  const forward = new CellStates();
  for (const [c, s] of commits) if (!forward.commit(c, s).accepted) throw new Error('cell states: a commit under the ceiling was refused');
  const backward = new CellStates();
  for (const [c, s] of [...commits].reverse()) backward.commit(c, s);
  if (forward.text() !== backward.text() || forward.hash() !== backward.hash()) throw new Error('cell states: the order of commits changed the store');
  // The intact state of structure 8 is dropped: 5 cells, 8 changed structures (three from the script).
  if (forward.cells().length !== 5 || forward.structures !== 8) throw new Error(`cell states: ${forward.cells().length} cells and ${forward.structures} structures`);
  const text = forward.text();
  if (!/^[0-9a-z.:;!~,_]*$/.test(text)) throw new Error('cell states: the text has a character outside the URL-safe set');
  if (text.length > CELL_STATES_CHARS_PER_UNIT * forward.units) throw new Error(`cell states: ${text.length} characters for ${forward.units} units`);
  const back = decodeCellStates(text);
  if (back.errors.length > 0 || back.store.text() !== text || back.store.hash() !== forward.hash() || back.store.units !== forward.units) throw new Error('cell states: the text does not decode to the same store');
  out.push(text, forward.hash(), forward.units, forward.structures, forward.cells().map(cellKey));

  // Cells below a coarse cell: (2, 8, -2, 2) holds itself and (2, 9, -3, 5); (2, 10, -5, 10) lies under (2, 9, -3, 5).
  const coarse = cellId(2, 8, -2, 2);
  const under = forward.under(coarse).map(cellKey);
  if (under.join(' ') !== '2/8/-2/2 2/9/-3/5 2/10/-5/10') throw new Error(`cell states: under ${cellKey(coarse)} gave ${under.join(' ')}`);
  out.push(under, forward.text(coarse), forward.under(cellId(5, 0, 0, 0)).map(cellKey));

  // An empty store, then clearing one cell and everything.
  const empty = new CellStates();
  if (empty.text() !== '' || decodeCellStates('').store.hash() !== empty.hash() || empty.of(coarse).size !== 0) throw new Error('cell states: an empty store');
  const cleared = decodeCellStates(text).store;
  cleared.clear(cellId(2, 9, 140, 77));
  out.push(cleared.text(), cleared.units, cleared.hash(), empty.hash());
  cleared.clear();
  if (cleared.hash() !== empty.hash() || cleared.units !== 0) throw new Error('cell states: clear() did not empty the store');

  // Malformed pieces: bad cell, out of range, bad states, a repeated cell. The good pieces survive.
  const pieces = text.split(';');
  const bad = [pieces[0], 'zz', '2.9.zzzzzzzz.0:', pieces[1] + 'q?', pieces[0], '2.9.2ihn5c.2ihn4w:1~,,', pieces[2]].join(';');
  const broken = decodeCellStates(bad);
  if (broken.errors.length !== 5) throw new Error(`cell states: ${broken.errors.length} errors in the malformed text: ${broken.errors.join(' | ')}`);
  if (broken.store.text() !== `${pieces[0]};${pieces[2]}` || broken.store.cells().length !== 2) throw new Error('cell states: the good pieces of a malformed text were lost');
  out.push(broken.errors, broken.store.text());

  // A ceiling of 40 units: commits one after another, every one within the ceiling; what the rule ruined and when.
  const small = new CellStates({ maxUnits: 40 });
  // An independent model of the rule: a flat list of (cell, id, entries); the largest goes first, ties by cell, then id.
  let model: { cell: CellId; id: number; size: number }[] = [];
  for (const [c, s] of commits) {
    const r = small.commit(c, s);
    if (!r.accepted) throw new Error('cell states: a commit under the ceiling of structures was refused');
    if (small.units > small.maxUnits) throw new Error(`cell states: ${small.units} units over a ceiling of ${small.maxUnits}`);
    if (small.text().length > CELL_STATES_CHARS_PER_UNIT * small.maxUnits) throw new Error('cell states: the text outgrew its bound');
    model = model.filter((e) => cellKey(e.cell) !== cellKey(c));
    for (const st of s.values()) if (st.ruin || st.parts.size > 0) model.push({ cell: c, id: st.structure, size: st.ruin ? 0 : st.parts.size });
    const expected: string[] = [];
    while (model.reduce((u, e) => u + 1 + e.size, 0) > 40) {
      const pick = [...model].sort((a, b) => b.size - a.size || compareCells(a.cell, b.cell) || a.id - b.id)[0]!;
      pick.size = 0;
      expected.push(`${cellKey(pick.cell)}#${pick.id}`);
    }
    const got = r.ruined.map((x) => `${cellKey(x.cell)}#${x.structure}`);
    if (got.join(' ') !== expected.join(' ')) throw new Error(`cell states: the ceiling ruined ${got.join(' ')}, the model ${expected.join(' ')}`);
    out.push(r.ruined.map((x) => `${cellKey(x.cell)}#${x.structure}`), small.units);
  }
  const ruins = [...small.cells()].flatMap((c) => [...small.of(c).values()].filter((s) => s.ruin).map((s) => `${cellKey(c)}#${s.structure}`));
  if (ruins.length === 0) throw new Error('cell states: the small ceiling never ruined a structure');
  const reread = decodeCellStates(small.text(), { maxUnits: 40 });
  if (reread.errors.length > 0 || reread.store.hash() !== small.hash()) throw new Error('cell states: a store at its ceiling does not decode to itself');
  out.push(ruins, small.text(), small.hash());

  // Full of ruins: a ceiling of 3 holds three ruins; a fourth changed structure is refused and nothing changes.
  const full = new CellStates({ maxUnits: 3 });
  full.commit(cellId(2, 9, 0, 0), states(synthetic(1, 0, true), synthetic(2, 0, true)));
  full.commit(cellId(2, 9, 1, 0), states(synthetic(3, 0, true)));
  const before = full.hash();
  const refused = full.commit(cellId(2, 9, 2, 0), states(synthetic(4, 1)));
  if (refused.accepted || full.hash() !== before || full.units !== 3) throw new Error('cell states: a store full of ruins took another structure');
  // Replacing a cell's states is no new structure: it is accepted.
  const replaced = full.commit(cellId(2, 9, 1, 0), states(synthetic(5, 0, true)));
  if (!replaced.accepted || full.structures !== 3) throw new Error('cell states: replacing the states of a cell was refused');
  const over = decodeCellStates(`${full.text()};2.9.40000.40000:7!~`, { maxUnits: 3 });
  if (over.errors.length !== 1) throw new Error('cell states: decoding past the ceiling did not report the refused cell');
  out.push(full.text(), refused, replaced, over.errors);
  return out;
}

/**
 * Refresh of streamed cells on a flat world: a viewer stands still while its cells load (four jobs at a time, two
 * uploads a step); at step 6 the cells of one coarse cell are refreshed while some are RESIDENT, some MESHED and some
 * in flight, together with a cell that is not tracked; at step 40 again once everything is settled. Checks: a refreshed
 * RESIDENT cell stays RESIDENT and drawn throughout and is swapped, never uploaded again; the late result of a
 * cancelled job is stale; the cover never gets a hole after it was whole; settled waits for the refreshes; the same run
 * with `refresh([])` takes the decisions of a run without refresh step for step.
 */
export function refreshScript(): string[] {
  const run = (refreshAt: Map<number, () => CellId[]>, track: string[] | null): { trace: string[]; m: StreamingManager } => {
    const config: StreamingConfig = { ...DEFAULT_STREAMING, shape: new FlatWorld(), rootLevel: 5, leafLevel: 8, maxInFlight: 4 };
    const m = new StreamingManager(config);
    const queue: { req: CellRequest; due: number }[] = [];
    const late: CellRequest[] = [];
    const trace: string[] = [];
    const refreshed = new Set<string>();
    let whole = false;
    let swaps = 0;
    let stale = 0;
    for (let s = 0; s < 120; s++) {
      const a = m.update([{ id: 'view', kind: 'camera', center: [2100, 0, 1700], altitude: 60, base: 0, dir: [1, 0] }]);
      for (const c of a.cancels) {
        const i = queue.findIndex((j) => j.req.key === c.key && j.req.epoch === c.epoch);
        // A cancelled job whose result still comes back: it must be stale.
        if (i >= 0) late.push(queue.splice(i, 1)[0]!.req);
      }
      for (const r of a.requests) queue.push({ req: r, due: s + 2 });
      for (const c of a.uploads.slice(0, 2)) {
        if (refreshed.has(cellKey(c)) && m.state(c) === 'RESIDENT') throw new Error(`refresh: step ${s}: a RESIDENT cell ${cellKey(c)} was listed for upload`);
        m.resident(c, 1000);
      }
      for (const r of late.splice(0)) {
        stale++;
        if (m.complete(r, 1000)) throw new Error(`refresh: step ${s}: the late result of a cancelled job for ${r.key} was accepted`);
      }
      let done = 0;
      for (let i = 0; i < queue.length && done < 4; ) {
        if (queue[i]!.due > s) {
          i++;
          continue;
        }
        const req = queue.splice(i, 1)[0]!.req;
        if (m.complete(req, 1000) && m.state(req.cell) === 'RESIDENT') {
          m.swapped(req.cell, 1100);
          swaps++;
        }
        done++;
      }
      const touch = refreshAt.get(s);
      if (touch) {
        const cells = touch();
        for (const c of cells) if (m.state(c) === 'RESIDENT') refreshed.add(cellKey(c));
        const states = cells.map((c) => `${cellKey(c)}=${m.state(c)}`);
        const n = m.refresh(cells);
        track?.push(`refresh ${s}: ${n} of ${cells.length}: ${states.join(' ')}`);
        for (const k of refreshed) {
          const c = cells.find((x) => cellKey(x) === k);
          if (c && m.state(c) !== 'RESIDENT') throw new Error(`refresh: step ${s}: the refreshed cell ${k} left the GPU`);
        }
      }
      const c = m.counters();
      if (c.holes === 0 && c.drawn > 0) whole = true;
      else if (whole) throw new Error(`refresh: step ${s}: the cover has a hole after it was whole`);
      const p = m.refreshes();
      if (p.pending > 0 && m.settled) throw new Error(`refresh: step ${s}: settled while ${p.pending} cells wait for new content`);
      trace.push(`${s}|${a.requests.map((r) => r.key).join(',')}|${a.cancels.length}|${a.uploads.length}|${a.releases.length}|${a.evictions.map(cellKey).join(',')}|${c.drawn}|${c.holes}|${c.inFlight}|${c.cpuBytes}|${c.gpuBytes}|${p.pending}|${m.settled}`);
    }
    if (!m.settled) throw new Error('refresh: the run did not settle');
    track?.push(`swaps ${swaps} stale ${stale}`);
    return { trace, m };
  };

  // The same run without refresh and with an empty refresh: the same decisions.
  const plain = run(new Map(), null).trace;
  const none = run(new Map([[6, () => []], [40, () => []]]), null).trace;
  if (plain.join('\n') !== none.join('\n')) throw new Error('refresh: an empty refresh changed the decisions');

  // The cells of the level 6 cell under the viewer and its children, plus an untracked cell far away.
  const shape = new FlatWorld();
  const top = shape.cellAt([2100, 0, 1700], 6);
  const group = (): CellId[] => {
    const list: CellId[] = [top, cellId(top.face, 8, top.x * 4 + 4000, top.y * 4)];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) list.push(cellId(top.face, 7, top.x * 2 + i, top.y * 2 + j));
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) list.push(cellId(top.face, 8, top.x * 4 + i, top.y * 4 + j));
    return list.sort(compareCells);
  };
  const track: string[] = [];
  const { trace, m } = run(new Map([[6, group], [40, group]]), track);
  const total = m.refreshes().total;
  if (total === 0) throw new Error('refresh: nothing was touched');
  if (!track.some((t) => t.includes('=RESIDENT')) || !track.some((t) => t.startsWith('refresh 40') && t.includes('=RESIDENT'))) throw new Error('refresh: no RESIDENT cell was refreshed');
  const [, swaps, , stale] = track[track.length - 1]!.split(' ');
  if (swaps === '0') throw new Error('refresh: no cell was swapped');
  if (stale === '0') throw new Error('refresh: no job was in flight when it was refreshed');
  if (!track[0]!.includes('=MESHED')) throw new Error('refresh: no MESHED cell was refreshed at step 6');
  return [...plain.slice(-1), ...track, ...trace, String(total), ...leaveWhileRefreshing()];
}

/**
 * A refreshed RESIDENT cell whose new content has not arrived when the viewer flies away: it is forgotten (NONE,
 * evicted), its job cancelled, and its late result refused.
 */
function leaveWhileRefreshing(): string[] {
  const config: StreamingConfig = { ...DEFAULT_STREAMING, shape: new FlatWorld(), rootLevel: 5, leafLevel: 8, maxInFlight: 4 };
  const m = new StreamingManager(config);
  const at = (x: number): Parameters<StreamingManager['update']>[0] => [{ id: 'view', kind: 'camera', center: [x, 0, 1700], altitude: 60, base: 0, dir: [1, 0] }];
  // Settle at the first place: every job answers at once, every upload is done.
  for (let s = 0; s < 200 && !m.settled; s++) {
    const a = m.update(at(2100));
    for (const r of a.requests) m.complete(r, 1000);
    for (const c of a.uploads) m.resident(c, 1000);
  }
  if (!m.settled) throw new Error('refresh: the first place did not settle');
  const leaf = m.drawn().find((c) => c.level === config.leafLevel);
  if (!leaf) throw new Error('refresh: no leaf is drawn');
  if (m.refresh([leaf]) !== 1) throw new Error('refresh: a RESIDENT leaf was not touched');
  const a = m.update(at(2100));
  const job = a.requests.find((r) => r.key === cellKey(leaf));
  if (!job || a.requests[0]!.key !== job.key) throw new Error('refresh: the refreshed leaf was not requested first');
  const out: string[] = [`leave ${cellKey(leaf)}`];
  let evicted = false;
  let cancelled = false;
  for (let s = 0; s < 40; s++) {
    const b = m.update(at(2100 + 60_000));
    if (b.evictions.some((c) => cellKey(c) === job.key)) evicted = true;
    if (b.cancels.some((c) => c.key === job.key && c.epoch === job.epoch)) cancelled = true;
    for (const r of b.requests) m.complete(r, 1000);
    for (const c of b.uploads) m.resident(c, 1000);
  }
  if (m.state(leaf) !== 'NONE' || !evicted || !cancelled) throw new Error(`refresh: a refreshing leaf left behind is ${m.state(leaf)} (evicted ${evicted}, cancelled ${cancelled})`);
  if (m.complete(job, 1000)) throw new Error('refresh: the late result for a forgotten leaf was accepted');
  if (m.refreshes().pending !== 0) throw new Error('refresh: a forgotten leaf still waits for content');
  out.push(`${m.state(leaf)} ${m.refreshes().total}`);
  return out;
}
