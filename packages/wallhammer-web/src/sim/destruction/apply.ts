// What a destruction event breaks. Pure and deterministic: (structure, state, event) → (new state, changed parts,
// new rubble). No clock, no Math.random, integers wherever a decision is made.
//
// 1. Hit test: every destructible part whose convex piece lies within the event radius, in key order.
// 2. Damage: energy × (r² − d²) / r², against the part's material thresholds, each jittered ±20 % by the event seed.
//    A part that is hit again moves at least one rung further.
// 3. Support: connectivity from the ground anchors (structure.ts). A part with no supported path falls: it is gone.
// 4. Rubble: every part that became gone gets its footprint (rubble.ts) from the fall direction and a variant chosen now.
// 5. Budget: a structure with more entries than the budget coarsens into a ruin, visibly, never silently.
// 6. Timeline: when each changed part lets go, in whole ticks after the event (`TIMELINE_TICK_S`), for presentation.
//    The state is committed at once and does not depend on it: a state saved mid-collapse is the final state, and a
//    second event during a collapse acts on that final state. Hit parts go at tick 0. A part that lost its support
//    goes after the parts it hung on: a shortest path over the bonds from the parts the event destroyed (a step to a
//    part resting on another costs a whole stage, a lateral step a little), plus a hashed jitter, squeezed into
//    `TIMELINE_MAX_TICKS`. Parts with no path from a destroyed part (a ruin) go by height.

import { DAMAGE, PART_FLAG, entryRung, packEntry } from '../../base/destructible.ts';
import type { DamageEntry, DamageRung, DestructionEvent, RubbleFootprint, StructureDesc, StructureState } from '../../base/destructible.ts';
import { hashInts } from '../../gen-core/hash.ts';
import { idiv, octant, pieceDistSq } from './int-geometry.ts';
import { partRubble, ruinRubble } from './rubble.ts';
import { compileStructure, solveSupport, UNSUPPORTED } from './structure.ts';
import type { CompiledStructure } from './structure.ts';

export type ChangeCause = 'damage' | 'support' | 'ruin';

export interface PartChange {
  structure: number;
  part: number;
  from: DamageRung;
  to: DamageRung;
  cause: ChangeCause;
}

export interface DestructionResult {
  state: StructureState;
  changes: PartChange[];
  /** Rubble that appeared with this event. */
  rubble: RubbleFootprint[];
  /** Per change (same order): ticks after the event at which the part lets go (`TIMELINE_TICK_S` each). */
  timeline: Uint16Array;
}

/** Length of one timeline tick in seconds. */
export const TIMELINE_TICK_S = 0.05;
/** Timeline shape in ticks: first support loss, one stage up a resting chain, one lateral step, jitter range, latest. */
export const TIMELINE = { first: 10, stage: 6, lateral: 2, jitter: 4, max: 50 } as const;
/** Height of one stage of the height fallback (cm). */
const STAGE_HEIGHT = 300;

export interface DestructionOptions {
  /** Most damaged parts a structure may hold before it coarsens into a ruin. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 600;
/** Fall direction counts as straight down within this distance of the structure centre (cm). */
const CENTRE_RADIUS = 50;

/**
 * Builds a canonical event from metres (as a click gives them). Rounding happens here, once; from then on the
 * event is integers. Energy is in abstract units (a few hundred cracks masonry, about a thousand blows it out).
 */
export function destructionEvent(o: { position: readonly [number, number, number]; radius: number; energy: number; seed: number; tick: number }): DestructionEvent {
  return {
    x: Math.round(o.position[0] * 100),
    y: Math.round(o.position[1] * 100),
    z: Math.round(o.position[2] * 100),
    radius: Math.max(1, Math.round(o.radius * 100)),
    energy: Math.max(0, Math.round(o.energy)),
    seed: o.seed >>> 0,
    tick: Math.max(0, Math.round(o.tick)),
  };
}

function rungFor(dmg: number, crack: number, breach: number, gone: number): DamageRung {
  if (dmg >= gone) return DAMAGE.gone;
  if (breach > 0 && dmg >= breach) return DAMAGE.breached;
  if (dmg >= crack) return DAMAGE.cracked;
  return DAMAGE.intact;
}

/** Applies one event to one structure. */
export function applyEvent(structure: StructureDesc | CompiledStructure, state: StructureState, ev: DestructionEvent, options: DestructionOptions = {}): DestructionResult {
  const s = 'desc' in structure ? structure : compileStructure(structure);
  const desc = s.desc;
  if (desc.keepOut || state.ruin) return { state, changes: [], rubble: [], timeline: NO_TIMELINE };
  const r = ev.radius;
  const r2 = r * r;
  const b = s.bounds;
  // Broad phase: the event sphere against the structure's box.
  const gap = (v: number, lo: number, hi: number): number => (v < lo ? lo - v : v > hi ? v - hi : 0);
  const gx = gap(ev.x, b[0], b[1]);
  const gy = gap(ev.y, b[2], b[3]);
  const gz = gap(ev.z, b[4], b[5]);
  if (gx * gx + gy * gy + gz * gz > r2) return { state, changes: [], rubble: [], timeline: NO_TIMELINE };

  const seed = hashInts(ev.seed, ev.tick, desc.id);
  const parts = desc.parts;
  const n = parts.length;
  const next = new Map<number, DamageEntry>(state.parts);
  const changes: PartChange[] = [];
  const rubble: RubbleFootprint[] = [];

  // --- Damage ---------------------------------------------------------------------------------------------------
  for (let i = 0; i < n; i++) {
    const p = parts[i]!;
    if (p.flags & PART_FLAG.indestructible) continue;
    const old = next.get(p.key);
    const oldRung = old === undefined ? DAMAGE.intact : entryRung(old);
    if (oldRung === DAMAGE.gone) continue;
    const o = i * 6;
    const bx = gap(ev.x, s.box[o]!, s.box[o + 1]!);
    const by = gap(ev.y, s.box[o + 2]!, s.box[o + 3]!);
    const bz = gap(ev.z, s.box[o + 4]!, s.box[o + 5]!);
    if (bx * bx + by * by + bz * bz > r2) continue;
    const d2 = pieceDistSq(p.piece, ev.x, ev.y, ev.z);
    if (d2 > r2) continue;
    const dmg = idiv(ev.energy * (r2 - d2), r2);
    const m = desc.materials[p.material];
    if (!m) continue;
    const pct = 80 + (hashInts(seed, p.key) % 41);
    const crack = idiv(m.crack * pct, 100);
    const breach = idiv(m.breach * pct, 100);
    const goneAt = idiv(m.gone * pct, 100);
    let rung: DamageRung = rungFor(dmg, crack, breach, goneAt);
    if (rung === DAMAGE.intact) continue;
    // A hit on a damaged part moves it at least one rung further (skipping breach where the material has none).
    if (rung <= oldRung) rung = (oldRung + 1 === DAMAGE.breached && m.breach <= 0 ? DAMAGE.gone : oldRung + 1) as DamageRung;
    const c = i * 3;
    const dir = octant(s.centre[c]! - ev.x, s.centre[c + 2]! - ev.z, 1);
    const entry = packEntry(rung, dir, hashInts(seed, p.key, 1) & 255);
    next.set(p.key, entry);
    changes.push({ structure: desc.id, part: p.key, from: oldRung, to: rung, cause: 'damage' });
    if (rung === DAMAGE.gone) rubble.push(partRubble(s, p, entry));
  }
  if (changes.length === 0) return { state, changes, rubble, timeline: NO_TIMELINE };

  // --- Support -----------------------------------------------------------------------------------------------------
  const alive = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = next.get(parts[i]!.key);
    alive[i] = e === undefined || entryRung(e) !== DAMAGE.gone ? 1 : 0;
  }
  const hang = solveSupport(s, alive, s.span);
  for (let i = 0; i < n; i++) {
    if (!alive[i] || hang[i] !== UNSUPPORTED) continue;
    const p = parts[i]!;
    if (p.flags & PART_FLAG.indestructible) continue;
    const old = next.get(p.key);
    const oldRung = old === undefined ? DAMAGE.intact : entryRung(old);
    const c = i * 3;
    const dir = octant(s.centre[c]! - desc.cx, s.centre[c + 2]! - desc.cz, CENTRE_RADIUS);
    const entry = packEntry(DAMAGE.gone, dir, hashInts(seed, p.key, 2) & 255);
    next.set(p.key, entry);
    changes.push({ structure: desc.id, part: p.key, from: oldRung, to: DAMAGE.gone, cause: 'support' });
    rubble.push(partRubble(s, p, entry));
  }

  // --- Budget ------------------------------------------------------------------------------------------------------
  if (next.size > (options.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
    const ruinChanges: PartChange[] = [];
    for (const p of parts) {
      if (p.flags & PART_FLAG.indestructible) continue;
      const e = next.get(p.key);
      const from = e === undefined ? DAMAGE.intact : entryRung(e);
      if (from !== DAMAGE.gone) ruinChanges.push({ structure: desc.id, part: p.key, from, to: DAMAGE.gone, cause: 'ruin' });
    }
    const all = [...changes, ...ruinChanges];
    return { state: { structure: desc.id, ruin: true, parts: new Map() }, changes: all, rubble: [ruinRubble(s)], timeline: fallTimeline(s, all, seed) };
  }
  return { state: { structure: desc.id, ruin: false, parts: next }, changes, rubble, timeline: fallTimeline(s, changes, seed) };
}

const NO_TIMELINE = new Uint16Array(0);

/**
 * When each changed part lets go (ticks after the event), see step 6 above. Pure: the changes, the bonds and the seed.
 */
export function fallTimeline(s: CompiledStructure, changes: readonly PartChange[], seed: number): Uint16Array {
  const n = s.desc.parts.length;
  const T = TIMELINE;
  const INF = 0xffff;
  const dist = new Uint16Array(n).fill(INF);
  const falling = new Uint8Array(n);
  const buckets: number[][] = [[]];
  for (const c of changes) {
    const i = s.index.get(c.part);
    if (i === undefined) continue;
    if (c.cause === 'damage') {
      if (c.to !== DAMAGE.gone) continue;
      dist[i] = 0;
      buckets[0]!.push(i);
    } else falling[i] = 1;
  }
  // Shortest paths over the bonds, only through parts that fall in this event (bucket queue, small integer weights).
  for (let d = 0; d < buckets.length; d++) {
    const bucket = buckets[d];
    if (!bucket) continue;
    for (let k = 0; k < bucket.length; k++) {
      const i = bucket[k]!;
      if (dist[i] !== d) continue;
      const relax = (j: number, w: number): void => {
        const to = d + w;
        if (!falling[j] || dist[j]! <= to || to >= INF) return;
        dist[j] = to;
        (buckets[to] ??= []).push(j);
      };
      for (const j of s.above[i]!) relax(j, T.stage);
      for (const j of s.below[i]!) relax(j, T.stage);
      for (const j of s.lateral[i]!) relax(j, T.lateral);
    }
  }
  const y0 = s.bounds[2];
  const raw = new Uint32Array(changes.length);
  let most = 0;
  changes.forEach((c, k) => {
    const i = s.index.get(c.part);
    if (c.cause === 'damage' || i === undefined) return;
    const height = Math.max(0, s.centre[i * 3 + 1]! - y0);
    const base = dist[i] !== INF ? dist[i]! : idiv(height * T.stage, STAGE_HEIGHT);
    raw[k] = T.first + base + (hashInts(seed, c.part, 3) % T.jitter);
    most = Math.max(most, raw[k]!);
  });
  const out = new Uint16Array(changes.length);
  raw.forEach((v, k) => {
    out[k] = v === 0 ? 0 : most > T.max ? T.first + idiv((v - T.first) * (T.max - T.first), most - T.first) : v;
  });
  return out;
}

/**
 * Applies one event to many structures, in structure id order. `states` is not modified; the result holds the new
 * state of every structure that changed.
 */
export function applyEventToAll(
  structures: readonly (StructureDesc | CompiledStructure)[],
  states: ReadonlyMap<number, StructureState>,
  ev: DestructionEvent,
  options: DestructionOptions = {},
): { states: Map<number, StructureState>; changes: PartChange[]; rubble: RubbleFootprint[]; timeline: Uint16Array } {
  const compiled = structures.map((x) => ('desc' in x ? x : compileStructure(x))).sort((p, q) => p.desc.id - q.desc.id);
  const out = new Map(states);
  const changes: PartChange[] = [];
  const rubble: RubbleFootprint[] = [];
  const timeline: number[] = [];
  for (const s of compiled) {
    const before = states.get(s.desc.id) ?? { structure: s.desc.id, ruin: false, parts: new Map() };
    const r = applyEvent(s, before, ev, options);
    if (r.changes.length === 0) continue;
    out.set(s.desc.id, r.state);
    changes.push(...r.changes);
    rubble.push(...r.rubble);
    timeline.push(...r.timeline);
  }
  return { states: out, changes, rubble, timeline: Uint16Array.from(timeline) };
}
