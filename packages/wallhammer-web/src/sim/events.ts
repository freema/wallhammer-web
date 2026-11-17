// Event queue of the simulation. Any system posts events (arrivals, departures, anything another system defines,
// for example damage); systems later in the same tick and every system in the next tick read them, and the app
// drains everything that happened since its last frame.
//
// Events are part of the simulation state: the two ticks a system can see are saved in snapshots and hashed.

import type { ByteReader, ByteWriter } from './bytes.ts';
import type { SimState } from './simulation.ts';

/** A plain value an event or command may carry. */
export type SimValue = number | string | boolean;
export type SimData = Readonly<Record<string, SimValue>>;

export interface SimEvent {
  /** Tick the event was posted in. */
  readonly tick: number;
  /** Dotted name, owned by whoever posts it (`move.arrive`, `damage.hit`, …). */
  readonly kind: string;
  /** Entity the event is about, 0 when none. */
  readonly entity: number;
  readonly data: SimData;
}

const NO_DATA: SimData = Object.freeze({});
/** Events the app has not drained yet are capped; older ones are dropped and counted. */
const APP_CAP = 65536;

export class EventQueue implements SimState {
  readonly name = 'events';
  private now: SimEvent[] = [];
  private before: SimEvent[] = [];
  private outbox: SimEvent[] = [];
  private tickNow = 0;
  /** Events dropped because the app did not drain them in time. */
  dropped = 0;

  /** Called by the simulation when a tick starts: this tick's events become last tick's. */
  beginTick(tick: number): void {
    this.before = this.now;
    this.now = [];
    this.tickNow = tick;
  }

  post(kind: string, entity = 0, data: SimData = NO_DATA): void {
    const e: SimEvent = { tick: this.tickNow, kind, entity, data };
    this.now.push(e);
    this.outbox.push(e);
    if (this.outbox.length > APP_CAP) {
      const cut = this.outbox.length - APP_CAP;
      this.outbox.splice(0, cut);
      this.dropped += cut;
    }
  }

  /** Events posted so far in this tick, optionally of one kind. */
  thisTick(kind?: string): readonly SimEvent[] {
    return kind === undefined ? this.now : this.now.filter((e) => e.kind === kind);
  }

  /** Events of the previous tick, optionally of one kind. */
  lastTick(kind?: string): readonly SimEvent[] {
    return kind === undefined ? this.before : this.before.filter((e) => e.kind === kind);
  }

  /** Everything posted since the last call (for the app, not for systems). */
  drain(): SimEvent[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  save(w: ByteWriter): void {
    w.i32(this.tickNow);
    for (const list of [this.before, this.now]) {
      w.u32(list.length);
      for (const e of list) {
        w.i32(e.tick);
        w.str(e.kind);
        w.f64(e.entity);
        writeData(w, e.data);
      }
    }
  }

  load(r: ByteReader): void {
    this.tickNow = r.i32();
    const read = (): SimEvent[] => {
      const n = r.u32();
      const out: SimEvent[] = [];
      for (let i = 0; i < n; i++) out.push({ tick: r.i32(), kind: r.str(), entity: r.f64(), data: readData(r) });
      return out;
    };
    this.before = read();
    this.now = read();
    // Events the app saw before a restore are history of another timeline.
    this.outbox = [];
  }
}

/** Writes plain data with its keys sorted, so equal data always gives equal bytes. */
export function writeData(w: ByteWriter, data: SimData): void {
  const keys = Object.keys(data).sort();
  w.u32(keys.length);
  for (const k of keys) {
    const v = data[k]!;
    w.str(k);
    if (typeof v === 'number') {
      w.u8(0);
      w.f64(v);
    } else if (typeof v === 'string') {
      w.u8(1);
      w.str(v);
    } else {
      w.u8(2);
      w.u8(v ? 1 : 0);
    }
  }
}

export function readData(r: ByteReader): SimData {
  const n = r.u32();
  if (n === 0) return NO_DATA;
  const out: Record<string, SimValue> = {};
  for (let i = 0; i < n; i++) {
    const k = r.str();
    const t = r.u8();
    out[k] = t === 0 ? r.f64() : t === 1 ? r.str() : r.u8() === 1;
  }
  return out;
}
