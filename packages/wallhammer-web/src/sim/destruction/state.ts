// The authoritative damage state of structures: a small map `part key → entry` per structure, a hash of it, and a
// compact text form that fits into a URL or a save.
//
// Text form (URL-safe): structures joined by `_`, each `<id>[!]~<entries>` with the id in base 36, `!` for a ruin,
// and entries `<key delta>.<entry>` joined by `,` (keys ascending, each as the difference to the previous key, both in
// base 36). Example: `1~2h4k.c3,1.3_2!~`.

import type { DamageEntry, StructureState } from '../../base/destructible.ts';
import { hashInts } from '../../gen-core/hash.ts';

export function intactState(structure: number): StructureState {
  return { structure, ruin: false, parts: new Map() };
}

/** Entries in ascending key order. */
export function sortedEntries(state: StructureState): [number, DamageEntry][] {
  return [...state.parts.entries()].sort((p, q) => p[0] - q[0]);
}

/** True when nothing is damaged. */
export function isIntact(state: StructureState | undefined): boolean {
  return !state || (!state.ruin && state.parts.size === 0);
}

/** 64-bit hash of one or more structure states as 16 hex digits. Independent of map insertion order. */
export function stateHash(states: StructureState | readonly StructureState[]): string {
  const list = (Array.isArray(states) ? [...states] : [states as StructureState]).sort((p, q) => p.structure - q.structure);
  let h1 = 0x2545f491;
  let h2 = 0x6c8e9cf5;
  for (const s of list) {
    h1 = hashInts(h1, s.structure, s.ruin ? 1 : 0);
    h2 = hashInts(h2, s.structure ^ 0x5bd1e995, s.ruin ? 3 : 2);
    for (const [k, e] of sortedEntries(s)) {
      h1 = hashInts(h1, k, e);
      h2 = hashInts(h2, e, k);
    }
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Compact text of several structure states (structures in id order; intact ones are left out). */
export function encodeStates(states: Iterable<StructureState>): string {
  const list = [...states].filter((s) => !isIntact(s)).sort((p, q) => p.structure - q.structure);
  return list
    .map((s) => {
      let prev = 0;
      const entries = s.ruin
        ? []
        : sortedEntries(s).map(([k, e]) => {
            const d = k - prev;
            prev = k;
            return `${d.toString(36)}.${e.toString(36)}`;
          });
      return `${(s.structure >>> 0).toString(36)}${s.ruin ? '!' : ''}~${entries.join(',')}`;
    })
    .join('_');
}

/** Parses the text of `encodeStates`. Malformed pieces are skipped (and reported in `errors`), never guessed. */
export function decodeStates(text: string): { states: Map<number, StructureState>; errors: string[] } {
  const states = new Map<number, StructureState>();
  const errors: string[] = [];
  for (const chunk of text.split('_')) {
    if (!chunk) continue;
    const m = /^([0-9a-z]+)(!?)~([0-9a-z.,]*)$/.exec(chunk);
    if (!m) {
      errors.push(`bad structure "${chunk.slice(0, 24)}"`);
      continue;
    }
    const structure = parseInt(m[1]!, 36);
    const parts = new Map<number, DamageEntry>();
    let key = 0;
    let ok = true;
    for (const item of m[3] ? m[3].split(',') : []) {
      const [d, e] = item.split('.');
      const dk = parseInt(d ?? '', 36);
      const en = parseInt(e ?? '', 36);
      if (!Number.isFinite(dk) || !Number.isFinite(en) || dk <= 0 && key > 0) {
        errors.push(`bad entry "${item}" in structure ${structure}`);
        ok = false;
        break;
      }
      key += dk;
      parts.set(key >>> 0, en);
    }
    if (ok) states.set(structure, { structure, ruin: m[2] === '!', parts });
  }
  return { states, errors };
}
