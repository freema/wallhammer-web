// The damage of the structures of Hearth, held in the page's memory: structure key → state per part, as the
// `destruction` example keeps it. A strike in the body's frame is turned into the frame of every near structure and
// applied there in ascending key order; the state is committed at once. A reload clears it.

import type { StructureDesc, StructureState } from 'wallhammer-web';
import type { Vec3 } from 'wallhammer-web/base';
import { hashInts } from 'wallhammer-web/gen-core';
import { applyEvent, decodeStates, destructionEvent, encodeStates, intactState, stateHash } from 'wallhammer-web/sim/destruction';
import type { PartChange } from 'wallhammer-web/sim/destruction';
import type { WorldPlan } from './plan.ts';
import type { StructureRecipe } from './structures.ts';

/** Hash stream of the strikes. */
export const STRIKE_STREAM = 7131;
/** Radius and energy of a strike: those of the `destruction` example's default. */
export const STRIKE_RADIUS_M = 3;
export const STRIKE_ENERGY = 900;
/** Parts per structure in the encoded ids (`key * PARTS + spec id`). */
const PARTS = 8;

/** What the last strike did to one structure, for the presentation (falling parts, rubble); nothing of it is kept. */
export interface StrikeChange {
  key: number;
  /** The states of its parts before the strike. */
  before: ReadonlyMap<number, StructureState>;
  /** The strike in the structure's frame: centre and radius in metres, energy, seed. */
  event: { x: number; y: number; z: number; radius: number; energy: number; seed: number };
  /** Per part (spec id) that changed: its part changes and their timeline (ticks, same order). */
  parts: { id: number; changes: readonly PartChange[]; timeline: Uint16Array }[];
}

export interface Damage {
  /** Keys that changed, ascending. */
  strike(dir: Vec3, heightM: number, radiusM: number, energy: number): number[];
  /** The changes of the last strike, ascending by key. */
  last(): readonly StrikeChange[];
  states(key: number): ReadonlyMap<number, StructureState> | undefined;
  hash(): string;
  encode(): string;
  decode(text: string): void;
  clear(): void;
  /** Keys with any damage. */
  keys(): number[];
}

export function createDamage(o: { packed: number; plan: () => WorldPlan | null; near: () => readonly StructureRecipe[]; descs: (key: number) => readonly StructureDesc[] }): Damage {
  const table = new Map<number, Map<number, StructureState>>();
  let count = 0;
  let last: StrikeChange[] = [];
  const flat = (): StructureState[] => {
    const out: StructureState[] = [];
    for (const k of [...table.keys()].sort((a, b) => a - b)) {
      for (const [id, s] of [...table.get(k)!].sort((a, b) => a[0] - b[0])) out.push({ ...s, structure: k * PARTS + id });
    }
    return out;
  };
  return {
    strike(dir, heightM, radiusM, energy) {
      const plan = o.plan();
      if (!plan) return [];
      count++;
      const R = plan.grid.radiusM;
      const P: Vec3 = [dir[0] * (R + heightM), dir[1] * (R + heightM), dir[2] * (R + heightM)];
      const seed = hashInts(o.packed, STRIKE_STREAM, count);
      const changed: number[] = [];
      last = [];
      const near = [...o.near()].sort((a, b) => a.key - b.key);
      for (const r of near) {
        const f = r.frame;
        const rr = R + f.heightM;
        const d: Vec3 = [P[0] - f.origin[0] * rr, P[1] - f.origin[1] * rr, P[2] - f.origin[2] * rr];
        const dist = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        if (dist > radiusM + 40) continue;
        // Into the frame: x, y, z are orthonormal, so the transpose turns the offset.
        const local: Vec3 = [d[0] * f.x[0] + d[1] * f.x[1] + d[2] * f.x[2], d[0] * f.y[0] + d[1] * f.y[1] + d[2] * f.y[2], d[0] * f.z[0] + d[1] * f.z[1] + d[2] * f.z[2]];
        const ev = destructionEvent({ position: local, radius: radiusM, energy, seed, tick: count });
        const descs = o.descs(r.key);
        let states = table.get(r.key);
        let hit = false;
        const next = new Map(states ?? []);
        const parts: StrikeChange['parts'] = [];
        for (const desc of descs) {
          const before = next.get(desc.id) ?? intactState(desc.id);
          const res = applyEvent(desc, before, ev);
          if (res.changes.length > 0 || res.state.ruin !== before.ruin) {
            next.set(desc.id, res.state);
            hit = true;
            parts.push({ id: desc.id, changes: res.changes, timeline: res.timeline });
          }
        }
        if (hit) last.push({ key: r.key, before: new Map(states ?? []), event: { x: local[0], y: local[1], z: local[2], radius: radiusM, energy, seed: ev.seed }, parts });
        // A raised part goes with the part under it: once a part standing on the ground is a ruin, the raised parts are too.
        if (hit) {
          const groundRuin = r.specs.some((s) => !s.raised && next.get(s.id)?.ruin === true);
          if (groundRuin) for (const s of r.specs) if (s.raised) next.set(s.id, { ...(next.get(s.id) ?? intactState(s.id)), ruin: true });
          states = next;
          table.set(r.key, states);
          changed.push(r.key);
        }
      }
      return changed;
    },
    last: () => last,
    states: (key) => table.get(key),
    hash: () => stateHash(flat()),
    encode: () => encodeStates(flat()),
    decode(text) {
      table.clear();
      for (const s of decodeStates(text).states.values()) {
        const key = Math.floor(s.structure / PARTS);
        const id = s.structure % PARTS;
        let m = table.get(key);
        if (!m) table.set(key, (m = new Map()));
        m.set(id, { ...s, structure: id });
      }
    },
    clear() {
      table.clear();
      count = 0;
      last = [];
    },
    keys: () => [...table.keys()].sort((a, b) => a - b),
  };
}
