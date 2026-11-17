// Damage state of a streamed world: one store keyed by the home cell of a structure and the structure's id. A home
// cell is the one cell that owns a structure; which quadtree level that is, the content decides. The store holds only
// structures that changed, has a ceiling in units with one fixed rule, and saves to URL-safe text.
//
// Determinism: the store takes no seed and reads no clock. Its content, text and hash are a function of the commits;
// equal content gives equal text and hash whatever the order of the commits. Cells are ordered by `compareCells`,
// structures by id, parts by key; never by the iteration order of a map.
//
// Text form: cells in order joined by `;`, each `<face>.<level>.<x>.<y>:<encodeStates of the cell>`, numbers in base
// 36, x and y as the unsigned 28-bit fields of the cell id (the coordinate plus 2^27, so no sign is needed). Only the
// characters `0-9 a-z . : ; ! ~ , _` occur. Example: `7.9.2ihn5c.2ihn4w:0~2h4k.c3,1.3`.
//
// Ceiling (`units ≤ maxUnits` after every commit; a changed structure costs 1 plus its number of part entries, a ruin
// costs 1): (1) a commit that would leave more changed structures than `maxUnits` is refused and changes nothing;
// (2) otherwise, while the store is over the ceiling, the structure with the most part entries in the whole store
// (ties: the earlier cell, then the lower id) becomes a ruin. The rule reads only the store, never which cells are
// loaded, where a viewer is, the order of visits or time.

import type { StructureState } from '../../base/destructible.ts';
import type { CellId } from '../../gen-core/cell.ts';
import { cellBits, cellId, cellKey, compareCells } from '../../gen-core/cell.ts';
import { hashInts } from '../../gen-core/hash.ts';
import { decodeStates, encodeStates, isIntact, stateHash } from './state.ts';

/** Default ceiling of a store in units. */
export const DEFAULT_MAX_UNITS = 20000;
/** `text()` is never longer than this many characters per unit of the ceiling. */
export const CELL_STATES_CHARS_PER_UNIT = 40;

/** Offset of the unsigned x and y fields of a cell id (see gen-core/cell.ts). */
const XY_OFFSET = 2 ** 27;

export interface CommitResult {
  /** False: the store is full of changed structures, nothing changed. */
  accepted: boolean;
  /** Structures the ceiling turned into ruins, in the order it took them. */
  ruined: { cell: CellId; structure: number }[];
}

interface CellRecord {
  cell: CellId;
  /** By structure id; only changed structures, ruins without entries. */
  states: Map<number, StructureState>;
  units: number;
}

const EMPTY: ReadonlyMap<number, StructureState> = new Map();

function unitsOf(s: StructureState): number {
  return 1 + (s.ruin ? 0 : s.parts.size);
}

function hex8(s: string, from: number): number {
  return parseInt(s.slice(from, from + 8), 16) >>> 0;
}

/** Store of changed structure states by home cell. */
export class CellStates {
  readonly maxUnits: number;
  private readonly records = new Map<string, CellRecord>();
  private unitTotal = 0;
  private structureTotal = 0;

  constructor(options: { maxUnits?: number } = {}) {
    const m = options.maxUnits ?? DEFAULT_MAX_UNITS;
    this.maxUnits = Math.max(1, Math.floor(m));
  }

  /** Σ over changed structures of 1 + its number of part entries (a ruin costs 1). */
  get units(): number {
    return this.unitTotal;
  }

  /** Changed structures. */
  get structures(): number {
    return this.structureTotal;
  }

  /** States of a home cell by structure id; one shared empty map when nothing changed there. */
  of(cell: CellId): ReadonlyMap<number, StructureState> {
    return this.records.get(cellKey(cell))?.states ?? EMPTY;
  }

  /** Replaces the states of a home cell. Intact states are dropped; the ceiling is applied inside. */
  commit(cell: CellId, states: ReadonlyMap<number, StructureState>): CommitResult {
    const key = cellKey(cell);
    const ids = [...states.keys()].sort((a, b) => a - b);
    const next = new Map<number, StructureState>();
    let units = 0;
    for (const id of ids) {
      const s = states.get(id)!;
      if (isIntact(s)) continue;
      const own: StructureState = s.ruin ? { structure: id, ruin: true, parts: new Map() } : { structure: id, ruin: false, parts: new Map(s.parts) };
      next.set(id, own);
      units += unitsOf(own);
    }
    const old = this.records.get(key);
    const structures = this.structureTotal - (old?.states.size ?? 0) + next.size;
    if (structures > this.maxUnits) return { accepted: false, ruined: [] };
    this.unitTotal += units - (old?.units ?? 0);
    this.structureTotal = structures;
    if (next.size === 0) this.records.delete(key);
    else this.records.set(key, { cell: cellId(cell.face, cell.level, cell.x, cell.y), states: next, units });
    const ruined: CommitResult['ruined'] = [];
    while (this.unitTotal > this.maxUnits) {
      // The largest structure in the whole store; ties go to the earlier cell, then the lower id.
      let best: { rec: CellRecord; id: number; size: number } | null = null;
      for (const rec of this.sortedRecords()) {
        for (const id of [...rec.states.keys()].sort((a, b) => a - b)) {
          const s = rec.states.get(id)!;
          const size = s.ruin ? 0 : s.parts.size;
          if (size > 0 && (!best || size > best.size)) best = { rec, id, size };
        }
      }
      // Cannot happen while structures ≤ maxUnits; guards the loop.
      if (!best) break;
      best.rec.states.set(best.id, { structure: best.id, ruin: true, parts: new Map() });
      best.rec.units -= best.size;
      this.unitTotal -= best.size;
      ruined.push({ cell: best.rec.cell, structure: best.id });
    }
    return { accepted: true, ruined };
  }

  /** Home cells with a change, in `compareCells` order. */
  cells(): CellId[] {
    return this.sortedRecords().map((r) => r.cell);
  }

  /** Home cells with a change that are `cell` or lie below it in the quadtree, in `compareCells` order. */
  under(cell: CellId): CellId[] {
    return this.cells().filter((c) => isUnder(c, cell));
  }

  /** Forgets one home cell, or everything. */
  clear(cell?: CellId): void {
    if (!cell) {
      this.records.clear();
      this.unitTotal = 0;
      this.structureTotal = 0;
      return;
    }
    const key = cellKey(cell);
    const r = this.records.get(key);
    if (!r) return;
    this.unitTotal -= r.units;
    this.structureTotal -= r.states.size;
    this.records.delete(key);
  }

  /** 64-bit hash of the whole store as 16 hex digits: each cell's bits and its `stateHash`, in cell order. */
  hash(): string {
    let h1 = 0x3c6ef372;
    let h2 = 0x1b873593;
    for (const r of this.sortedRecords()) {
      const [hi, lo] = cellBits(r.cell);
      const s = stateHash([...r.states.values()]);
      const a = hex8(s, 0);
      const b = hex8(s, 8);
      h1 = hashInts(h1, hi, lo, a, b);
      h2 = hashInts(h2, lo ^ 0x5bd1e995, hi, b, a);
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /** Canonical text of the whole store, or only of the home cells of `under(cell)`; '' when there are none. */
  text(under?: CellId): string {
    const list = under ? this.sortedRecords().filter((r) => isUnder(r.cell, under)) : this.sortedRecords();
    return list.map((r) => `${cellText(r.cell)}:${encodeStates(r.states.values())}`).join(';');
  }

  private sortedRecords(): CellRecord[] {
    return [...this.records.values()].sort((a, b) => compareCells(a.cell, b.cell));
  }
}

/** True when `c` is `top` or lies below it in the quadtree (children of (x, y) are (2x + i, 2y + j)). */
function isUnder(c: CellId, top: CellId): boolean {
  if (c.face !== top.face || c.level < top.level) return false;
  const d = c.level - top.level;
  return c.x >> d === top.x && c.y >> d === top.y;
}

function cellText(c: CellId): string {
  return `${c.face.toString(36)}.${c.level.toString(36)}.${(c.x + XY_OFFSET).toString(36)}.${(c.y + XY_OFFSET).toString(36)}`;
}

/**
 * Parses the text of `CellStates.text`. Commits cell by cell in text order; a malformed cell (or one the ceiling
 * refuses, or one that repeats) is skipped and reported in `errors`, never guessed.
 */
export function decodeCellStates(text: string, options: { maxUnits?: number } = {}): { store: CellStates; errors: string[] } {
  const store = new CellStates(options);
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const chunk of text.split(';')) {
    if (!chunk) continue;
    const m = /^([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+):([0-9a-z.,!~_]*)$/.exec(chunk);
    if (!m) {
      errors.push(`bad cell "${chunk.slice(0, 32)}"`);
      continue;
    }
    let cell: CellId;
    try {
      cell = cellId(parseInt(m[1]!, 36), parseInt(m[2]!, 36), parseInt(m[3]!, 36) - XY_OFFSET, parseInt(m[4]!, 36) - XY_OFFSET);
    } catch {
      errors.push(`bad cell id "${chunk.slice(0, 32)}"`);
      continue;
    }
    const key = cellKey(cell);
    if (seen.has(key)) {
      errors.push(`cell ${key} repeats`);
      continue;
    }
    seen.add(key);
    const { states, errors: bad } = decodeStates(m[5]!);
    if (bad.length > 0) {
      errors.push(`cell ${key}: ${bad.join('; ')}`);
      continue;
    }
    if (!store.commit(cell, states).accepted) errors.push(`cell ${key}: over the ceiling of ${store.maxUnits} units`);
  }
  return { store, errors };
}
