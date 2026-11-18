// The motion graph: states, transitions and layers over motion sources that the game writes. One description is
// compiled once (`compileMotionGraph`) and shared by any number of figures; every figure has its own `MotionGraph`
// with a small state (a Float64Array: parameters, triggers and a short list of active states per layer), so many
// figures update without allocating and a figure's state saves to bytes and back.
//
// The game steers a figure only through parameters (`setParam`) and one-shot triggers (`trigger`); it reads back
// which states are active and the events since the last call (marks crossed, states entered and left). The engine
// holds no motion of its own: every pose comes from a `MotionSource` of the game.
//
// Time and phase. Every active state has a time (seconds since it was entered, times its rate) and a phase (passes
// of its motions, a running number: 2.25 is a quarter into the third pass). The phase advances with time divided by
// the motions' duration, or follows a parameter (`drive`: phase = parameter / per, for motions that keep step with a
// distance travelled). The sources of one state share its phase, so motions of different length stay in step; a
// transition between two states of the same `sync` group carries the phase over.
//
// Transitions. A layer keeps up to `maxBlend` active states: the newest fades in over the previous result, which
// fades out. A transition that interrupts another (even straight back) adds one more state at weight 0, so the pose
// never jumps; when the list is full the state of the smallest weight is dropped (the only case of a step, as large
// as that weight).

import { addPose, blendPose } from './pose-ops.ts';
import { Pose } from './skeleton.ts';
import type { BoneMask, Skeleton } from './skeleton.ts';

/** A motion is a pure function written by the game. `t` is seconds or a phase, as the source declares. */
export interface MotionSource<P = void> {
  sample(out: Pose, t: number, params: P): void;
  /** Seconds of one pass; undefined = endless (time-driven). */
  readonly duration?: number;
  /** Repeats after a pass. Default true; false holds the end of the pass. */
  readonly loop?: boolean;
  /** Named points on the timeline as a share 0–1 of one pass (a foot touching down, a strike). */
  readonly marks?: readonly { name: string; at: number }[];
  /** Speeds this motion covers: [min, ideal, max]; used to weight motions of one state automatically. */
  readonly speed?: readonly [number, number, number];
  /**
   * What `t` means: `'seconds'` (default) into the pass, or with no `duration` since the state was entered;
   * `'phase'` the share 0–1 of the pass.
   */
  readonly unit?: 'seconds' | 'phase';
}

/** How a transition's weight grows: `'linear'` or `'smooth'` (3t² − 2t³). */
export type MotionEase = 'linear' | 'smooth';

/** A test of one parameter. */
export interface MotionCondition {
  param: string;
  op: '<' | '<=' | '>' | '>=' | '==' | '!=';
  value: number;
}

export interface MotionStateDesc<P = void> {
  name: string;
  /** One motion. A state with neither `source` nor `sources` passes the layer's input through (adds nothing). */
  source?: MotionSource<P> | null;
  /** Several motions weighted by the parameter `by` through their `speed` ranges (continuous, sum 1). */
  sources?: readonly MotionSource<P>[];
  /** Parameter the `sources` are weighted by (and that scales their playback within their speed ranges). */
  by?: string;
  /** Playback rate: a number or the name of a parameter. Default 1. */
  rate?: number | string;
  /** Phase from a parameter instead of time: phase = parameter / `per` (a distance per pass). */
  drive?: { param: string; per: number };
  /** States of one group keep the phase across a transition between them. */
  sync?: string;
}

export interface MotionTransitionDesc {
  /** A state name, or `'*'` for any state. */
  from: string;
  to: string;
  /** Seconds of the cross-fade; 0 switches at once. */
  seconds: number;
  /** Default `'smooth'`. */
  ease?: MotionEase;
  /** All must hold. */
  when?: readonly MotionCondition[];
  /** A trigger that must be set (and is consumed by the transition). */
  trigger?: string;
  /** Only once the current state's phase has reached this many passes (1 = the end of the first pass). */
  after?: number;
  /** Allows a transition into the state that is current (it starts again). Default false. */
  restart?: boolean;
}

export interface MotionLayerDesc<P = void> {
  name: string;
  /** `'override'` (default) blends the layer's pose over what the layers before it made; `'additive'` adds it. */
  mode?: 'override' | 'additive';
  /** Per-bone weights; default every bone 1. */
  mask?: BoneMask | null;
  /** Layer weight: a number or the name of a parameter. Default 1. */
  weight?: number | string;
  states: readonly MotionStateDesc<P>[];
  /** Default: the first state. */
  initial?: string;
  /** Checked in order every update; the first that applies is taken (one per layer and update). */
  transitions?: readonly MotionTransitionDesc[];
}

export interface MotionGraphDesc<P = void> {
  skeleton: Skeleton;
  /** Parameters and their start values. Names used elsewhere in the description are added with 0. */
  params?: Readonly<Record<string, number>>;
  /** Names of one-shot triggers (at most 31). Names used by transitions are added. */
  triggers?: readonly string[];
  layers: readonly MotionLayerDesc<P>[];
  /** Active states per layer at most. Default 4. */
  maxBlend?: number;
  /** Events kept between two `drainEvents` calls. Default 32; more are counted in `droppedEvents`. */
  maxEvents?: number;
}

/** Kinds of events. */
export type MotionEventKind = 'mark' | 'enter' | 'leave';

// --- Compiled description ------------------------------------------------------------------------------------------

interface CState<P> {
  name: string;
  sources: readonly MotionSource<P>[];
  /** Parameter index of `by`, −1 none. */
  by: number;
  rate: number;
  rateParam: number;
  driveParam: number;
  per: number;
  sync: number;
  loop: boolean;
  /** Marks of each source, sorted by `at`, with their name indices. */
  marks: { at: Float64Array; name: Int32Array }[];
}

interface CTransition {
  from: number;
  to: number;
  seconds: number;
  smooth: boolean;
  trigger: number;
  after: number;
  restart: boolean;
  conds: { param: number; op: number; value: number }[];
}

interface CLayer<P> {
  name: string;
  additive: boolean;
  mask: BoneMask | null;
  weight: number;
  weightParam: number;
  states: CState<P>[];
  initial: number;
  transitions: CTransition[];
  /** Offset of the layer's block in the state array. */
  at: number;
}

const OPS = ['<', '<=', '>', '>=', '==', '!='] as const;
/** Numbers per active entry: state, phase, time, progress, seconds, smooth. */
const ENTRY = 6;
const KIND_NAMES: readonly MotionEventKind[] = ['mark', 'enter', 'leave'];
const FORMAT = 1;

/** A compiled description: shared by every figure that uses it. Holds the scratch poses of evaluation. */
export class MotionGraphDef<P = void> {
  readonly skeleton: Skeleton;
  readonly paramNames: readonly string[];
  readonly paramStart: Float64Array;
  readonly triggerNames: readonly string[];
  readonly maxBlend: number;
  readonly maxEvents: number;
  /** Numbers of one figure's state (parameters, triggers, layers). */
  readonly stateSize: number;
  /** @internal */ readonly layers: readonly CLayer<P>[];
  /** Event names: state names first (by layer), then mark names. @internal */
  readonly eventNames: string[] = [];
  /** @internal */ readonly scratch: [Pose, Pose, Pose];
  /** @internal */ readonly weights: Float64Array;
  private readonly params = new Map<string, number>();
  private readonly triggers = new Map<string, number>();

  constructor(desc: MotionGraphDesc<P>) {
    this.skeleton = desc.skeleton;
    this.maxBlend = Math.max(1, desc.maxBlend ?? 4);
    this.maxEvents = Math.max(1, desc.maxEvents ?? 32);
    const pNames: string[] = [];
    const pStart: number[] = [];
    const param = (name: string): number => {
      let i = this.params.get(name);
      if (i === undefined) {
        i = pNames.length;
        this.params.set(name, i);
        pNames.push(name);
        pStart.push(0);
      }
      return i;
    };
    for (const [k, v] of Object.entries(desc.params ?? {})) pStart[param(k)] = v;
    const tNames: string[] = [];
    const trig = (name: string): number => {
      let i = this.triggers.get(name);
      if (i === undefined) {
        i = tNames.length;
        if (i >= 31) throw new Error('MotionGraph: at most 31 triggers');
        this.triggers.set(name, i);
        tNames.push(name);
      }
      return i;
    };
    for (const t of desc.triggers ?? []) trig(t);
    const markIds = new Map<string, number>();
    const markNames: string[] = [];
    const markId = (name: string): number => {
      let i = markIds.get(name);
      if (i === undefined) {
        i = markNames.length;
        markIds.set(name, i);
        markNames.push(name);
      }
      return i;
    };
    const syncIds = new Map<string, number>();
    let maxSources = 1;
    const layers: CLayer<P>[] = [];
    const stateNameBase: number[] = [];
    if (desc.layers.length === 0) throw new Error('MotionGraph: no layers');
    for (const l of desc.layers) {
      if (l.states.length === 0) throw new Error(`MotionGraph: layer ${l.name} has no states`);
      stateNameBase.push(this.eventNames.length);
      const index = new Map<string, number>();
      const states: CState<P>[] = l.states.map((s, k) => {
        if (index.has(s.name)) throw new Error(`MotionGraph: two states ${s.name} in layer ${l.name}`);
        index.set(s.name, k);
        this.eventNames.push(s.name);
        const sources = s.sources ?? (s.source ? [s.source] : []);
        maxSources = Math.max(maxSources, sources.length);
        if (s.drive && !(s.drive.per > 0)) throw new Error(`MotionGraph: state ${s.name} needs drive.per > 0`);
        let sync = -1;
        if (s.sync !== undefined) {
          sync = syncIds.get(s.sync) ?? syncIds.size;
          syncIds.set(s.sync, sync);
        }
        return {
          name: s.name,
          sources,
          by: s.by !== undefined ? param(s.by) : -1,
          rate: typeof s.rate === 'number' ? s.rate : 1,
          rateParam: typeof s.rate === 'string' ? param(s.rate) : -1,
          driveParam: s.drive ? param(s.drive.param) : -1,
          per: s.drive?.per ?? 1,
          sync,
          loop: sources.length === 0 || sources.some((m) => m.loop !== false),
          marks: sources.map((m) => {
            const ms = [...(m.marks ?? [])].sort((a, b) => a.at - b.at);
            return { at: Float64Array.from(ms.map((x) => x.at)), name: Int32Array.from(ms.map((x) => markId(x.name))) };
          }),
        };
      });
      const stateOf = (name: string): number => {
        const i = index.get(name);
        if (i === undefined) throw new Error(`MotionGraph: no state ${name} in layer ${l.name}`);
        return i;
      };
      const transitions: CTransition[] = (l.transitions ?? []).map((t) => ({
        from: t.from === '*' ? -1 : stateOf(t.from),
        to: stateOf(t.to),
        seconds: Math.max(0, t.seconds),
        smooth: (t.ease ?? 'smooth') === 'smooth',
        trigger: t.trigger !== undefined ? trig(t.trigger) : -1,
        after: t.after ?? -Infinity,
        restart: t.restart ?? false,
        conds: (t.when ?? []).map((c) => {
          const op = OPS.indexOf(c.op);
          if (op < 0) throw new Error(`MotionGraph: unknown operator ${c.op}`);
          return { param: param(c.param), op, value: c.value };
        }),
      }));
      layers.push({
        name: l.name,
        additive: l.mode === 'additive',
        mask: l.mask ?? null,
        weight: typeof l.weight === 'number' ? l.weight : 1,
        weightParam: typeof l.weight === 'string' ? param(l.weight) : -1,
        states,
        initial: l.initial !== undefined ? stateOf(l.initial) : 0,
        transitions,
        at: 0,
      });
    }
    // Mark names follow the state names in the event table.
    const markBase = this.eventNames.length;
    this.eventNames.push(...markNames);
    for (const l of layers) for (const s of l.states) for (const m of s.marks) for (let k = 0; k < m.name.length; k++) m.name[k] = m.name[k]! + markBase;
    this.paramNames = pNames;
    this.paramStart = Float64Array.from(pStart);
    this.triggerNames = tNames;
    // State layout: [format, params…, triggers, per layer: count, entries…].
    let at = 1 + pNames.length + 1;
    for (const l of layers) {
      l.at = at;
      at += 1 + this.maxBlend * ENTRY;
    }
    this.stateSize = at;
    this.layers = layers;
    this.stateNameBase = stateNameBase;
    const sk = desc.skeleton;
    this.scratch = [new Pose(sk), new Pose(sk), new Pose(sk)];
    this.weights = new Float64Array(maxSources);
  }

  /** @internal Index of the first state name of each layer in `eventNames`. */
  readonly stateNameBase: readonly number[];

  /** Index of a parameter, −1 when there is none. */
  param(name: string): number {
    return this.params.get(name) ?? -1;
  }

  /** Index of a trigger, −1 when there is none. */
  trigger(name: string): number {
    return this.triggers.get(name) ?? -1;
  }

  /** Index of a layer by name (−1 none). */
  layer(name: string): number {
    for (let i = 0; i < this.layers.length; i++) if (this.layers[i]!.name === name) return i;
    return -1;
  }
}

/** Compiles a description once; pass the result to every figure's `MotionGraph`. */
export function compileMotionGraph<P = void>(desc: MotionGraphDesc<P>): MotionGraphDef<P> {
  return new MotionGraphDef(desc);
}

/**
 * Weights of motions by their speed ranges at `value` into `out` (one per range): the two motions whose ideal
 * speeds enclose the value share the weight linearly; below the lowest ideal the slowest motion has it all, above the
 * highest the fastest. Continuous in `value`, sum 1. Allocates nothing.
 */
export function speedWeights(speeds: readonly (readonly [number, number, number] | undefined)[], value: number, out: { [i: number]: number }): void {
  const n = speeds.length;
  let lo = -1, hi = -1, min = -1, max = -1;
  for (let i = 0; i < n; i++) {
    out[i] = 0;
    const s = speeds[i];
    if (!s) continue;
    const v = s[1];
    if (min < 0 || v < speeds[min]![1]) min = i;
    if (max < 0 || v > speeds[max]![1]) max = i;
    if (v <= value && (lo < 0 || v > speeds[lo]![1])) lo = i;
    if (v >= value && (hi < 0 || v < speeds[hi]![1])) hi = i;
  }
  if (min < 0) {
    // No ranges: equal shares.
    for (let i = 0; i < n; i++) out[i] = 1 / n;
    return;
  }
  if (lo < 0) {
    out[min] = 1;
    return;
  }
  if (hi < 0) {
    out[max] = 1;
    return;
  }
  const a = speeds[lo]![1], b = speeds[hi]![1];
  if (lo === hi || b <= a) {
    out[lo] = 1;
    return;
  }
  const t = (value - a) / (b - a);
  out[lo] = 1 - t;
  out[hi] = t;
}

// --- One figure ----------------------------------------------------------------------------------------------------

/**
 * One figure's motion: the shared compiled description and this figure's small state. `input` is handed to every
 * source's `sample` as its `params` (the game's own per-figure data; set it once, change its fields freely).
 */
export class MotionGraph<P = void> {
  readonly def: MotionGraphDef<P>;
  /** Passed to the sources' `sample` as `params`. */
  input: P;
  /** Parameters, triggers and active states; `save` and `restore` copy it. */
  readonly data: Float64Array;
  /** Events that did not fit between two `drainEvents` calls (counted, then lost). */
  droppedEvents = 0;
  private readonly events: Int32Array;
  private eventCount = 0;
  private readonly bytes: Uint8Array;

  constructor(def: MotionGraphDef<P> | MotionGraphDesc<P>, input?: P) {
    this.def = def instanceof MotionGraphDef ? def : new MotionGraphDef(def);
    this.input = input as P;
    this.data = new Float64Array(this.def.stateSize);
    this.bytes = new Uint8Array(this.data.buffer);
    this.events = new Int32Array(this.def.maxEvents * 4);
    this.reset();
  }

  /** Start values of the parameters, every layer in its initial state at time and phase 0. */
  reset(): void {
    const d = this.data;
    const def = this.def;
    d.fill(0);
    d[0] = FORMAT;
    d.set(def.paramStart, 1);
    for (const l of def.layers) {
      d[l.at] = 1;
      const e = l.at + 1;
      d[e] = l.initial;
      d[e + 3] = 1;
    }
    this.eventCount = 0;
  }

  /** Sets a parameter: the ONLY way game logic steers motion. */
  setParam(name: string, value: number): void {
    const i = this.def.param(name);
    if (i < 0) throw new Error(`MotionGraph: no parameter ${name}`);
    this.data[1 + i] = value;
  }

  getParam(name: string): number {
    const i = this.def.param(name);
    if (i < 0) throw new Error(`MotionGraph: no parameter ${name}`);
    return this.data[1 + i]!;
  }

  /** A one-shot signal: lives until a transition consumes it or the next `update` ends. */
  trigger(name: string): void {
    const i = this.def.trigger(name);
    if (i < 0) throw new Error(`MotionGraph: no trigger ${name}`);
    const at = 1 + this.def.paramNames.length;
    this.data[at] = (this.data[at]! | (1 << i)) >>> 0;
  }

  /** Advances states, transitions and timelines by `dt` seconds; deterministic, allocates nothing. */
  update(dt: number): void {
    const def = this.def;
    const d = this.data;
    const pAt = 1;
    const tAt = 1 + def.paramNames.length;
    for (let li = 0; li < def.layers.length; li++) {
      const l = def.layers[li]!;
      // Transitions from the newest state.
      let n = d[l.at]!;
      const curAt = l.at + 1 + (n - 1) * ENTRY;
      const cur = d[curAt]!;
      for (let k = 0; k < l.transitions.length; k++) {
        const t = l.transitions[k]!;
        if (t.from >= 0 && t.from !== cur) continue;
        if (t.to === cur && !t.restart) continue;
        if (t.trigger >= 0 && (d[tAt]! & (1 << t.trigger)) === 0) continue;
        if (d[curAt + 1]! < t.after) continue;
        let ok = true;
        for (let c = 0; c < t.conds.length && ok; c++) {
          const q = t.conds[c]!;
          const v = d[pAt + q.param]!;
          ok = q.op === 0 ? v < q.value : q.op === 1 ? v <= q.value : q.op === 2 ? v > q.value : q.op === 3 ? v >= q.value : q.op === 4 ? v === q.value : v !== q.value;
        }
        if (!ok) continue;
        if (t.trigger >= 0) d[tAt] = (d[tAt]! & ~(1 << t.trigger)) >>> 0;
        this.push(li, t.to, t.seconds, t.smooth, curAt);
        n = d[l.at]!;
        break;
      }
      // Advance every active state; marks of the newest.
      for (let i = 0; i < n; i++) {
        const e = l.at + 1 + i * ENTRY;
        const s = l.states[d[e]!]!;
        const p0 = d[e + 1]!;
        const leader = this.advance(s, e, dt);
        if (i === n - 1 && leader >= 0) this.marks(li, d[e]!, s.marks[leader]!, p0, d[e + 1]!);
        if (i > 0) {
          const secs = d[e + 4]!;
          d[e + 3] = secs > 0 ? Math.min(1, d[e + 3]! + dt / secs) : 1;
        }
      }
      // Once a newer state is fully in, everything older is gone.
      let full = 0;
      for (let i = n - 1; i > 0; i--) {
        if (d[l.at + 1 + i * ENTRY + 3]! >= 1) {
          full = i;
          break;
        }
      }
      if (full > 0) {
        d.copyWithin(l.at + 1, l.at + 1 + full * ENTRY, l.at + 1 + n * ENTRY);
        n -= full;
        d[l.at] = n;
        d[l.at + 1 + 3] = 1;
      }
    }
    d[tAt] = 0;
  }

  /** Writes the pose of all layers into `out`. Allocates nothing (scratch poses belong to the shared description). */
  evaluate(out: Pose): void {
    const def = this.def;
    const d = this.data;
    const [layerPose, entryPose] = def.scratch;
    out.reset();
    for (let li = 0; li < def.layers.length; li++) {
      const l = def.layers[li]!;
      const lw = l.weightParam >= 0 ? d[1 + l.weightParam]! : l.weight;
      if (lw <= 0) continue;
      const n = d[l.at]!;
      for (let i = 0; i < n; i++) {
        const e = l.at + 1 + i * ENTRY;
        if (i === 0) {
          this.sampleState(l, e, layerPose, out);
          continue;
        }
        const pr = d[e + 3]!;
        const w = d[e + 5]! ? pr * pr * (3 - 2 * pr) : pr;
        if (w <= 0) continue;
        this.sampleState(l, e, entryPose, out);
        blendPose(layerPose, layerPose, entryPose, w);
      }
      if (l.additive) addPose(out, out, layerPose, Math.min(lw, 1), l.mask);
      else blendPose(out, out, layerPose, Math.min(lw, 1), l.mask);
    }
  }

  /**
   * Marks crossed and states entered or left since the last call, oldest first: kind, name (of the mark or the
   * state), state (the state it happened in) and layer. No allocation per call.
   */
  drainEvents(fn: (kind: MotionEventKind, name: string, state: string, layer: string) => void): void {
    const ev = this.events;
    const def = this.def;
    const names = def.eventNames;
    const n = this.eventCount;
    this.eventCount = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const layer = ev[o + 3]!;
      fn(KIND_NAMES[ev[o]!]!, names[ev[o + 1]!]!, names[def.stateNameBase[layer]! + ev[o + 2]!]!, def.layers[layer]!.name);
    }
  }

  /** Name of the current (newest) state of a layer; default the first layer. */
  state(layer?: string): string {
    const l = this.layerOf(layer);
    const n = this.data[l.at]!;
    return l.states[this.data[l.at + 1 + (n - 1) * ENTRY]!]!.name;
  }

  /** Phase (passes) of the current state of a layer. */
  phase(layer?: string): number {
    const l = this.layerOf(layer);
    return this.data[l.at + 1 + (this.data[l.at]! - 1) * ENTRY + 1]!;
  }

  /** Seconds (times rate) since the current state of a layer was entered. */
  time(layer?: string): number {
    const l = this.layerOf(layer);
    return this.data[l.at + 1 + (this.data[l.at]! - 1) * ENTRY + 2]!;
  }

  /** The share 0–1 a state has in its layer's pose now (its cross-fades included); 0 when it is not active. */
  weightOf(state: string, layer?: string): number {
    const l = this.layerOf(layer);
    const d = this.data;
    const n = d[l.at]!;
    let total = 0;
    // Walk from the newest: each entry takes its weight of what is left.
    let left = 1;
    for (let i = n - 1; i >= 0; i--) {
      const e = l.at + 1 + i * ENTRY;
      const pr = i === 0 ? 1 : d[e + 3]!;
      const w = i === 0 ? 1 : d[e + 5]! ? pr * pr * (3 - 2 * pr) : pr;
      if (l.states[d[e]!]!.name === state) total += left * w;
      left *= 1 - w;
    }
    return total;
  }

  /**
   * Makes `state` the only active state of a layer at once, `time` seconds into it (seconds times its rate, as `time()`
   * reads them; the phase follows from its sources' durations and the parameters as they are now, or from its driving
   * parameter). For a figure that starts or comes back into view in the middle of something: it neither begins every
   * loop at its start nor fades in from the layer's initial state. No cross-fade, no events (marks before `time` are not
   * reported). Allocates nothing.
   */
  setState(state: string, layer?: string, time = 0): void {
    const l = this.layerOf(layer);
    let si = -1;
    for (let k = 0; k < l.states.length && si < 0; k++) if (l.states[k]!.name === state) si = k;
    if (si < 0) throw new Error(`MotionGraph: no state ${state} in layer ${l.name}`);
    const s = l.states[si]!;
    const d = this.data;
    const e = l.at + 1;
    this.weigh(s);
    let phase = s.driveParam >= 0 ? d[1 + s.driveParam]! / s.per : time * this.passesPerSecond(s);
    if (!s.loop) phase = phase < 0 ? 0 : phase > 1 ? 1 : phase;
    d[l.at] = 1;
    d[e] = si;
    d[e + 1] = phase;
    d[e + 2] = time;
    d[e + 3] = 1;
    d[e + 4] = 0;
    d[e + 5] = 0;
  }

  /** Bytes of the state (a copy, or written into `out` at `offset`). Drain the events first: they are not saved. */
  save(out?: Uint8Array, offset = 0): Uint8Array {
    if (!out) return this.bytes.slice();
    out.set(this.bytes, offset);
    return out;
  }

  /** Brings back a state saved by `save` of a figure with the same description. */
  restore(bytes: Uint8Array, offset = 0): void {
    if (bytes.length - offset < this.bytes.length) throw new Error('MotionGraph.restore: too few bytes');
    this.bytes.set(bytes.subarray(offset, offset + this.bytes.length));
    if (this.data[0] !== FORMAT) throw new Error('MotionGraph.restore: not a motion graph state');
    this.eventCount = 0;
  }

  /** Bytes `save` writes. */
  get byteLength(): number {
    return this.bytes.length;
  }

  private layerOf(name: string | undefined): CLayer<P> {
    const def = this.def;
    if (name === undefined) return def.layers[0]!;
    const i = def.layer(name);
    if (i < 0) throw new Error(`MotionGraph: no layer ${name}`);
    return def.layers[i]!;
  }

  /** Starts a transition in layer `li` to state `to`; `curAt` is the entry of the current state. */
  private push(li: number, to: number, seconds: number, smooth: boolean, curAt: number): void {
    const def = this.def;
    const l = def.layers[li]!;
    const d = this.data;
    const from = d[curAt]!;
    let phase = 0;
    const sync = l.states[to]!.sync;
    if (sync >= 0 && l.states[from]!.sync === sync) phase = d[curAt + 1]!;
    let n = d[l.at]!;
    if (n >= def.maxBlend) {
      // Full: drop the older entry with the smallest share of the pose.
      let drop = 0;
      let least = Infinity;
      let left = 1;
      for (let i = n - 1; i >= 0; i--) {
        const e = l.at + 1 + i * ENTRY;
        const pr = i === 0 ? 1 : d[e + 3]!;
        const w = i === 0 ? 1 : d[e + 5]! ? pr * pr * (3 - 2 * pr) : pr;
        if (left * w < least) {
          least = left * w;
          drop = i;
        }
        left *= 1 - w;
      }
      const at = l.at + 1 + drop * ENTRY;
      d.copyWithin(at, at + ENTRY, l.at + 1 + n * ENTRY);
      n--;
      d[l.at + 1 + 3] = 1;
    }
    const e = l.at + 1 + n * ENTRY;
    d[e] = to;
    d[e + 1] = phase;
    d[e + 2] = 0;
    d[e + 3] = seconds > 0 ? 0 : 1;
    d[e + 4] = seconds;
    d[e + 5] = smooth ? 1 : 0;
    d[l.at] = n + 1;
    this.event(1, def.stateNameBase[li]! + to, to, li);
    this.event(2, def.stateNameBase[li]! + from, from, li);
  }

  /** Advances one entry's time and phase; returns the source whose marks count (the heaviest), −1 none. */
  private advance(s: CState<P>, e: number, dt: number): number {
    const d = this.data;
    const rate = s.rateParam >= 0 ? d[1 + s.rateParam]! : s.rate;
    d[e + 2] = d[e + 2]! + dt * rate;
    const leader = this.weigh(s);
    let phase: number;
    if (s.driveParam >= 0) phase = d[1 + s.driveParam]! / s.per;
    else phase = d[e + 1]! + dt * rate * this.passesPerSecond(s);
    if (!s.loop) phase = phase < 0 ? 0 : phase > 1 ? 1 : phase;
    d[e + 1] = phase;
    return leader;
  }

  /** Passes per second (before the rate) of a state's weighted sources; `weigh(s)` must have run. */
  private passesPerSecond(s: CState<P>): number {
    const d = this.data;
    const w = this.def.weights;
    let speed = 0;
    const v = s.by >= 0 ? d[1 + s.by]! : 0;
    for (let k = 0; k < s.sources.length; k++) {
      const m = s.sources[k]!;
      if (!(w[k]! > 0) || !(m.duration! > 0)) continue;
      let f = 1;
      const r = m.speed;
      if (s.by >= 0 && r && r[1] > 0) f = (v < r[0] ? r[0] : v > r[2] ? r[2] : v) / r[1];
      speed += (w[k]! * f) / m.duration!;
    }
    return speed;
  }

  /** Weights of a state's sources into `def.weights`; returns the heaviest source with marks, −1 none. */
  private weigh(s: CState<P>): number {
    const w = this.def.weights;
    const n = s.sources.length;
    if (n === 0) return -1;
    if (n === 1) w[0] = 1;
    else if (s.by >= 0) speedWeightsOf(s.sources, this.data[1 + s.by]!, w);
    else for (let k = 0; k < n; k++) w[k] = 1 / n;
    let best = -1;
    for (let k = 0; k < n; k++) if (s.marks[k]!.at.length > 0 && (best < 0 || w[k]! > w[best]!)) best = k;
    return best;
  }

  /** Reports the marks crossed between phases p0 and p1 (either direction), in the order they were crossed. */
  private marks(li: number, state: number, m: { at: Float64Array; name: Int32Array }, p0: number, p1: number): void {
    const at = m.at;
    const n = at.length;
    if (n === 0 || p0 === p1) return;
    if (p1 > p0) {
      const k1 = Math.floor(p1);
      for (let k = Math.floor(p0); k <= k1; k++) {
        for (let j = 0; j < n; j++) {
          const v = k + at[j]!;
          if (v > p0 && v <= p1 && !this.event(0, m.name[j]!, state, li)) return;
        }
      }
    } else {
      const k1 = Math.floor(p1);
      for (let k = Math.floor(p0); k >= k1; k--) {
        for (let j = n - 1; j >= 0; j--) {
          const v = k + at[j]!;
          if (v < p0 && v >= p1 && !this.event(0, m.name[j]!, state, li)) return;
        }
      }
    }
  }

  /** Queues one event; false (and counted as dropped) when the queue is full. */
  private event(kind: number, name: number, state: number, layer: number): boolean {
    if (this.eventCount >= this.def.maxEvents) {
      this.droppedEvents++;
      return false;
    }
    const o = this.eventCount * 4;
    const ev = this.events;
    ev[o] = kind;
    ev[o + 1] = name;
    ev[o + 2] = state;
    ev[o + 3] = layer;
    this.eventCount++;
    return true;
  }

  /** The pose of one active entry of layer `l` into `dst`; `input` is the pose made by the layers before. */
  private sampleState(l: CLayer<P>, e: number, dst: Pose, input: Pose): void {
    const d = this.data;
    const s = l.states[d[e]!]!;
    const n = s.sources.length;
    if (n === 0) {
      if (l.additive) dst.reset();
      else dst.copy(input);
      return;
    }
    const phase = d[e + 1]!;
    const time = d[e + 2]!;
    this.weigh(s);
    const w = this.def.weights;
    const tmp = this.def.scratch[2];
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const wk = w[k]!;
      if (!(wk > 0)) continue;
      const m = s.sources[k]!;
      const target = acc === 0 ? dst : tmp;
      target.reset();
      m.sample(target, timeOf(m, phase, time, s.loop), this.input);
      if (acc === 0) acc = wk;
      else {
        acc += wk;
        blendPose(dst, dst, tmp, wk / acc);
      }
    }
  }
}

/** The `t` a source is sampled at. */
function timeOf<P>(m: MotionSource<P>, phase: number, time: number, loop: boolean): number {
  const dur = m.duration;
  if (dur === undefined || !(dur > 0)) return m.unit === 'phase' ? phase - Math.floor(phase) : time;
  const f = loop && m.loop !== false ? phase - Math.floor(phase) : phase < 0 ? 0 : phase > 1 ? 1 : phase;
  return m.unit === 'phase' ? f : f * dur;
}

function speedWeightsOf<P>(sources: readonly MotionSource<P>[], value: number, out: Float64Array): void {
  // Same rule as `speedWeights`, read straight from the sources (no array of ranges per call).
  const n = sources.length;
  let lo = -1, hi = -1, min = -1, max = -1;
  for (let i = 0; i < n; i++) {
    out[i] = 0;
    const s = sources[i]!.speed;
    if (!s) continue;
    const v = s[1];
    if (min < 0 || v < sources[min]!.speed![1]) min = i;
    if (max < 0 || v > sources[max]!.speed![1]) max = i;
    if (v <= value && (lo < 0 || v > sources[lo]!.speed![1])) lo = i;
    if (v >= value && (hi < 0 || v < sources[hi]!.speed![1])) hi = i;
  }
  if (min < 0) {
    for (let i = 0; i < n; i++) out[i] = 1 / n;
    return;
  }
  if (lo < 0) {
    out[min] = 1;
    return;
  }
  if (hi < 0) {
    out[max] = 1;
    return;
  }
  const a = sources[lo]!.speed![1], b = sources[hi]!.speed![1];
  if (lo === hi || b <= a) {
    out[lo] = 1;
    return;
  }
  const t = (value - a) / (b - a);
  out[lo] = 1 - t;
  out[hi] = t;
}
