// The tile index of the plan's lines, built once per stage without redoing the lines an earlier stage indexed.
// `lineTiles` lists each line from its own points and reach alone, keys ascending and the lines of a tile ascending.
// So the index of a later stage is the index of the earlier one with the entries of the lines that are new or whose
// reach or points changed replaced: the same bytes as a full `lineTiles` over all lines, at a fraction of the time.
// Stage 3 still indexes the rivers again (their reach there comes from float32 half-widths, at stage 1 from float64
// ones, and differs in the last bits); stage 4 keeps every earlier line and indexes only its roads and decks.

import { lineTiles } from 'wallhammer-web/gen-plan';
import type { LineTiles, LineTilesOptions } from 'wallhammer-web/gen-plan';

/** What an index was built from, kept beside it for the next stage (only within one `worldPlan` call). */
interface Source {
  radiusM: number;
  start: ArrayLike<number>;
  points: ArrayLike<number>;
  reachM: ArrayLike<number>;
}
const sources = new WeakMap<LineTiles, Source>();

/** Keeps the arrays themselves (the plan never writes to them after its index is built). */
function remember(t: LineTiles, o: LineTilesOptions): LineTiles {
  sources.set(t, { radiusM: o.radiusM, start: o.start, points: o.points, reachM: o.reachM });
  return t;
}

/**
 * The same index as `lineTiles(o)`. With `prev`, an index this function built for an earlier set of the lines (the
 * same lines first, more appended), only the lines that differ from it are indexed again.
 */
export function planLineTiles(o: LineTilesOptions, prev?: LineTiles): LineTiles {
  const src = prev ? sources.get(prev) : undefined;
  const lineCount = o.start.length - 1;
  if (!prev || !src || prev.level !== o.level || src.radiusM !== o.radiusM || src.reachM.length > lineCount) return remember(lineTiles(o), o);
  const oldCount = src.reachM.length;
  // Lines to index again: changed reach, start or points, and every appended line.
  const redo = new Uint8Array(lineCount);
  for (let l = 0; l < lineCount; l++) {
    if (l >= oldCount) {
      redo[l] = 1;
      continue;
    }
    const a = o.start[l]!;
    const b = o.start[l + 1]!;
    if (src.start[l] !== a || src.start[l + 1] !== b || src.reachM[l] !== o.reachM[l]) {
      redo[l] = 1;
      continue;
    }
    for (let k = 3 * a; k < 3 * b; k++) {
      if (src.points[k] !== o.points[k]) {
        redo[l] = 1;
        break;
      }
    }
  }
  // The lines to redo, compacted, indexed by the engine.
  const ids: number[] = [];
  const subStart: number[] = [0];
  const subPoints: number[] = [];
  const subReach: number[] = [];
  for (let l = 0; l < lineCount; l++) {
    if (!redo[l]) continue;
    ids.push(l);
    for (let k = 3 * o.start[l]!; k < 3 * o.start[l + 1]!; k++) subPoints.push(o.points[k]!);
    subStart.push(subPoints.length / 3);
    subReach.push(o.reachM[l]!);
  }
  const fresh = lineTiles({ level: o.level, radiusM: o.radiusM, start: subStart, points: subPoints, reachM: subReach });
  // Merge the kept entries of `prev` with the fresh ones, by key and then by line.
  const pKeys = prev.keys;
  const pStart = prev.start;
  const pLines = prev.lines;
  const fKeys = fresh.keys;
  const fStart = fresh.start;
  const fLines = fresh.lines;
  const idOf = Uint32Array.from(ids);
  const nOld = pKeys.length;
  const nNew = fKeys.length;
  const keys = new Uint32Array(nOld + nNew);
  const start = new Uint32Array(nOld + nNew + 1);
  const out = new Uint32Array(pLines.length + fLines.length);
  let nk = 0;
  let no = 0;
  let i = 0;
  let j = 0;
  while (i < nOld || j < nNew) {
    const ka = i < nOld ? pKeys[i]! : Infinity;
    const kb = j < nNew ? fKeys[j]! : Infinity;
    const key = ka < kb ? ka : kb;
    let p = ka === key ? pStart[i]! : 0;
    const pEnd = ka === key ? pStart[i + 1]! : 0;
    let q = kb === key ? fStart[j]! : 0;
    const qEnd = kb === key ? fStart[j + 1]! : 0;
    const from = no;
    for (;;) {
      while (p < pEnd && redo[pLines[p]!] === 1) p++;
      if (p < pEnd) {
        const la = pLines[p]!;
        if (q < qEnd && idOf[fLines[q]!]! < la) out[no++] = idOf[fLines[q++]!]!;
        else {
          out[no++] = la;
          p++;
        }
      } else if (q < qEnd) out[no++] = idOf[fLines[q++]!]!;
      else break;
    }
    if (no > from) {
      keys[nk] = key;
      start[nk++] = from;
    }
    if (ka === key) i++;
    if (kb === key) j++;
  }
  start[nk] = no;
  return remember({ level: o.level, keys: keys.slice(0, nk), start: start.slice(0, nk + 1), lines: out.slice(0, no) }, o);
}
