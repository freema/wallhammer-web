// Agendas: entities that follow a list of activities. An activity is a place, a time and a stay: the system turns the
// next activity into a route through the navigation graph, hands it to a mover set, waits for the arrival, waits out
// the stay and goes on. What places and activities mean (a door, a stop, a lecture) belongs to the app; the engine
// only knows nodes, points and times.
//
// - The agenda clock is seconds; tick 0 is `origin`. Activity times are converted to ticks once, on `add`.
// - The first activity is where the entity appears, at its time; later ones are reached by walking a route. An
//   activity with `arrive` sets the time to be there by: the trip starts the route's walking time earlier.
// - A place marked `inside` hides the entity while it stays there (its mover is removed, and spawned again when it
//   leaves), so only the ones out of doors cost anything.
// - Late starts are caught up: an entity whose trip should have begun before tick 0 (or before a stay ended) starts
//   it at the distance it would have walked by now. Setting up the agenda world at any time of day therefore gives a
//   plausible picture at once.
// - States are a `StateMachine` with four built in (`before`, `stay`, `travel`, `done`). An app adds its own (waiting,
//   boarding, riding) and switches to them from the hooks `onAppear` and `onArrive`; their `update` may use the
//   helpers below (`show`, `walkTo`, `hide`, `stayUntil`, `leave`, `arriveNext`).
//
// Events: agenda.appear, agenda.arrive, agenda.leave { place, activity }, agenda.done, agenda.unreachable { place }.
// The activities are setup data: add every entity before the first tick (a snapshot holds the table, not the lists).

import { ByteReader, ByteWriter } from './bytes.ts';
import { mmPerTick } from './fixed.ts';
import { MOVER_STATE } from './movers.ts';
import type { Movers, SpawnOptions } from './movers.ts';
import type { NavGraph } from './nav.ts';
import type { PathDef } from './paths.ts';
import type { SimState, Simulation } from './simulation.ts';
import { StateMachine } from './states.ts';
import { EntityTable } from './table.ts';

export interface AgendaPlace {
  /** Node of the navigation graph where routes to and from the place end. */
  node: number;
  /** A point off the graph where the entity stands (a door, a spot on a platform), metres. Default the node. */
  x?: number;
  z?: number;
  /** Staying here hides the entity (it is inside). */
  inside?: boolean;
}

export interface AgendaActivity {
  place: number;
  /** Seconds on the agenda clock: when the trip there starts (or, with `arrive`, when to be there by). */
  at: number;
  arrive?: boolean;
  /** Seconds to stay. */
  stay: number;
  /** Free integer for the app (how the place is reached or left). */
  mode?: number;
}

export interface AgendaEntity {
  activities: readonly AgendaActivity[];
  /** Free integer for the app. */
  tag?: number;
}

export interface AgendaOptions {
  movers: Movers;
  nav: NavGraph;
  places: readonly AgendaPlace[];
  /** Agenda clock at tick 0, seconds. Default 0. */
  origin?: number;
  /** Routes run this far right of the graph edges, metres (people keep to one side). Default 0. */
  rightOffset?: number;
  /** Mover settings of an entity (its index in the order of `add`). Default: 1.3 m/s walking. */
  spawn?: (index: number) => Omit<SpawnOptions, 'path' | 'at'>;
  /** Called when an entity's first activity begins: return a state to go to instead of appearing at the place. */
  onAppear?: (entity: number, agendas: Agendas) => number | void;
  /** Called when an entity reaches the place of an activity: return a state instead of `stay`. */
  onArrive?: (entity: number, agendas: Agendas) => number | void;
}

const COLUMNS = {
  /** Index of the current activity (being stayed at, or travelled to). */
  act: 'i32',
  state: 'i32',
  /** Mover id (0: not out of doors). */
  mover: 'f64',
  /** Tick a stay ends, or a state's own timer. */
  timer: 'i32',
  /** Planned start of the next trip (for `arrive` activities, computed from the route), or UNSET. */
  dep: 'i32',
  /** Index of the entity in the order of `add`, and the app's integers. */
  index: 'i32',
  tag: 'i32',
  data: 'i32',
} as const;

const UNSET = -0x7fffffff;

export class Agendas implements SimState {
  readonly name: string;
  readonly table: EntityTable<typeof COLUMNS>;
  readonly states = new StateMachine<Agendas>();
  readonly BEFORE: number;
  readonly STAY: number;
  readonly TRAVEL: number;
  readonly DONE: number;
  readonly movers: Movers;
  readonly nav: NavGraph;
  readonly places: readonly AgendaPlace[];
  /** Agenda clock at tick 0, seconds (see `setOrigin`). */
  origin: number;
  private readonly hz: number;
  private readonly options: AgendaOptions;
  /** Activities of all entities, flat; `first[index]` and `count[index]` locate an entity's list. */
  private readonly aPlace: number[] = [];
  private readonly aAt: number[] = [];
  /** Activity times in seconds, as given (`aAt` holds them in ticks from the origin). */
  private readonly aAtS: number[] = [];
  private readonly aArrive: boolean[] = [];
  private readonly aStay: number[] = [];
  private readonly aMode: number[] = [];
  private readonly first: number[] = [];
  private readonly count: number[] = [];
  private sim: Simulation | null = null;

  constructor(name: string, options: AgendaOptions) {
    this.name = name;
    this.options = options;
    this.movers = options.movers;
    this.nav = options.nav;
    this.places = options.places;
    this.origin = options.origin ?? 0;
    this.hz = options.movers.hz;
    this.table = new EntityTable(name, COLUMNS);
    this.BEFORE = this.states.define('before', { update: (e) => this.updateBefore(e) });
    this.STAY = this.states.define('stay', { update: (e) => this.updateStay(e) });
    this.TRAVEL = this.states.define('travel', { update: (e) => this.updateTravel(e) });
    this.DONE = this.states.define('done');
  }

  /** Adds an entity and returns its id. */
  add(entity: AgendaEntity): number {
    if (entity.activities.length === 0) throw new Error('Agendas: an entity needs at least one activity');
    const index = this.first.length;
    this.first.push(this.aPlace.length);
    this.count.push(entity.activities.length);
    for (const a of entity.activities) {
      if (a.place < 0 || a.place >= this.places.length) throw new Error(`Agendas: no place ${a.place}`);
      this.aPlace.push(a.place);
      this.aAt.push(Math.round((a.at - this.origin) * this.hz));
      this.aAtS.push(a.at);
      this.aArrive.push(a.arrive ?? false);
      this.aStay.push(Math.round(a.stay * this.hz));
      this.aMode.push(a.mode ?? 0);
    }
    const id = this.table.create();
    const row = this.table.rowOf(id);
    const c = this.table.col;
    c.state[row] = this.BEFORE;
    c.index[row] = index;
    c.tag[row] = entity.tag ?? 0;
    c.dep[row] = UNSET;
    return id;
  }

  get size(): number {
    return this.table.count;
  }

  /**
   * Moves tick 0 to another time of the agenda clock. Only for a state in which no entity has begun (all `before`):
   * restore such a snapshot with `Simulation.rebase(snapshot)` and set the origin before the next tick. A jump of the
   * app's clock then sets everything up anew from the agendas, caught up at once.
   */
  setOrigin(seconds: number): void {
    this.origin = seconds;
    for (let i = 0; i < this.aAt.length; i++) this.aAt[i] = Math.round((this.aAtS[i]! - seconds) * this.hz);
  }

  /** Current tick and agenda time in seconds (valid inside the system). */
  get now(): number {
    return this.sim?.tick ?? 0;
  }

  get time(): number {
    return this.origin + this.now / this.hz;
  }

  /** Ticks of a time on the agenda clock. */
  tickOf(seconds: number): number {
    return Math.round((seconds - this.origin) * this.hz);
  }

  private row(e: number): number {
    const r = this.table.rowOf(e);
    if (r < 0) throw new Error(`Agendas: no entity ${e}`);
    return r;
  }

  /** The current activity of an entity. */
  activity(e: number): { index: number; place: number; at: number; stay: number; mode: number; last: boolean } {
    const r = this.row(e);
    const c = this.table.col;
    const i = this.first[c.index[r]!]! + c.act[r]!;
    return { index: c.act[r]!, place: this.aPlace[i]!, at: this.aAt[i]!, stay: this.aStay[i]!, mode: this.aMode[i]!, last: c.act[r]! === this.count[c.index[r]!]! - 1 };
  }

  /** The activity after the current one, or null. */
  nextActivity(e: number): { place: number; at: number; stay: number; mode: number } | null {
    const r = this.row(e);
    const c = this.table.col;
    const k = c.act[r]! + 1;
    if (k >= this.count[c.index[r]!]!) return null;
    const i = this.first[c.index[r]!]! + k;
    return { place: this.aPlace[i]!, at: this.aAt[i]!, stay: this.aStay[i]!, mode: this.aMode[i]! };
  }

  /** Mover id of an entity (0 when it is not out of doors), its index, state and the app's integers. */
  mover(e: number): number {
    return this.table.col.mover[this.row(e)]!;
  }

  indexOf(e: number): number {
    return this.table.col.index[this.row(e)]!;
  }

  state(e: number): number {
    return this.table.col.state[this.row(e)]!;
  }

  timer(e: number): number {
    return this.table.col.timer[this.row(e)]!;
  }

  setTimer(e: number, tick: number): void {
    this.table.col.timer[this.row(e)] = tick;
  }

  data(e: number): number {
    return this.table.col.data[this.row(e)]!;
  }

  setData(e: number, v: number): void {
    this.table.col.data[this.row(e)] = v;
  }

  tag(e: number): number {
    return this.table.col.tag[this.row(e)]!;
  }

  /** Has the entity's mover reached the end of its path (and stands)? */
  standing(e: number): boolean {
    const m = this.mover(e);
    if (m === 0) return false;
    return this.movers.info(m).state === MOVER_STATE.done;
  }

  private spot(place: number): [number, number] {
    const p = this.places[place]!;
    return [p.x ?? this.nav.nodeX[p.node]!, p.z ?? this.nav.nodeZ[p.node]!];
  }

  private spawnMover(e: number, def: PathDef, at: number): number {
    const r = this.row(e);
    const c = this.table.col;
    const path = this.movers.paths.add(def, { owned: true });
    const o = this.options.spawn?.(c.index[r]!) ?? { cruise: 1.3, gap: 0.8 };
    const id = this.movers.spawn({ ...o, path, at, tag: c.index[r]! });
    c.mover[r] = id;
    return id;
  }

  /** Shows the entity standing at a point, facing `dirX, dirZ` (spawns its mover if it has none). */
  show(e: number, x: number, z: number, dirX = 0, dirZ = 1): void {
    const def: PathDef = { points: [x - dirX * 0.5, z - dirZ * 0.5, x, z] };
    const m = this.mover(e);
    if (m === 0) this.spawnMover(e, def, 0.5);
    else this.movers.send(m, def, 0.5);
  }

  /** Removes the entity's mover (it goes inside, boards, leaves the map). */
  hide(e: number): void {
    const r = this.row(e);
    const c = this.table.col;
    const m = c.mover[r]!;
    if (m !== 0) this.movers.remove(m);
    c.mover[r] = 0;
  }

  /** Walks the entity in a straight line from where it is to a point. */
  walkTo(e: number, x: number, z: number): void {
    const m = this.mover(e);
    if (m === 0) return;
    const [px, pz] = this.movers.position(m);
    if ((x - px) * (x - px) + (z - pz) * (z - pz) < 0.0025) x += 0.05;
    this.movers.send(m, { points: [px, pz, x, z] }, 0);
  }

  /** Puts the entity into `stay` at its current activity until `tick`; returns the state id for an `update`. */
  stayUntil(e: number, tick: number): number {
    const r = this.row(e);
    this.table.col.timer[r] = tick;
    this.table.col.dep[r] = UNSET;
    return this.STAY;
  }

  /** Ends the entity's agenda: hides it. Returns the state id for an `update`. */
  finish(e: number): number {
    this.hide(e);
    this.sim?.events.post('agenda.done', e);
    return this.DONE;
  }

  /** Starts the trip to the next activity now (or ends the agenda); returns the state id for an `update`. */
  leave(e: number, lateTicks = 0): number {
    const r = this.row(e);
    const c = this.table.col;
    const idx = c.index[r]!;
    const from = this.first[idx]! + c.act[r]!;
    if (c.act[r]! + 1 >= this.count[idx]!) return this.finish(e);
    const to = from + 1;
    this.sim?.events.post('agenda.leave', e, { place: this.aPlace[from]!, activity: c.act[r]! });
    c.act[r] = c.act[r]! + 1;
    c.dep[r] = UNSET;
    const def = this.route(this.aPlace[from]!, this.aPlace[to]!);
    if (!def) {
      // No way there: the entity skips the trip and appears at the place (a gap in the data, reported as an event).
      this.sim?.events.post('agenda.unreachable', e, { place: this.aPlace[to]! });
      this.hide(e);
      return this.arrive(e);
    }
    const speed = mmPerTick(this.options.spawn?.(idx).cruise ?? 1.3, this.hz);
    const at = Math.max(0, lateTicks) * speed;
    const m = c.mover[r]!;
    if (m === 0) this.spawnMover(e, def, at / 1000);
    else {
      // Out of doors already: the trip starts where it stands.
      const [px, pz] = this.movers.position(m);
      const pts = [px, pz, ...def.points];
      this.movers.send(m, { points: pts }, at / 1000);
    }
    return this.TRAVEL;
  }

  /**
   * Moves the entity on to its next activity without a trip, as if it was carried there (it rides a vehicle, takes a
   * lift): its mover is removed and the arrival at the next place runs at once (`onArrive`, or `stay`). Returns the
   * state id for an `update`; ends the agenda at the last activity.
   */
  arriveNext(e: number): number {
    const r = this.row(e);
    const c = this.table.col;
    const idx = c.index[r]!;
    if (c.act[r]! + 1 >= this.count[idx]!) return this.finish(e);
    this.sim?.events.post('agenda.leave', e, { place: this.aPlace[this.first[idx]! + c.act[r]!]!, activity: c.act[r]! });
    c.act[r] = c.act[r]! + 1;
    c.dep[r] = UNSET;
    this.hide(e);
    return this.arrive(e);
  }

  /** Route between two places as a path definition (spots at both ends), or null when there is none. */
  route(from: number, to: number): PathDef | null {
    const a = this.places[from]!;
    const b = this.places[to]!;
    const [ax, az] = this.spot(from);
    const [bx, bz] = this.spot(to);
    const pts: number[] = [ax, az];
    if (a.node !== b.node) {
      const edges = this.nav.findPath(a.node, b.node);
      if (!edges || edges.length === 0) return null;
      const def = this.nav.path(edges, { rightOffset: this.options.rightOffset ?? 0 });
      pts.push(...def.points);
    }
    pts.push(bx, bz);
    // Drop points closer than 5 cm to the previous one.
    const out: number[] = [pts[0]!, pts[1]!];
    for (let i = 2; i < pts.length; i += 2) {
      const dx = pts[i]! - out[out.length - 2]!;
      const dz = pts[i + 1]! - out[out.length - 1]!;
      if (dx * dx + dz * dz >= 0.0025) out.push(pts[i]!, pts[i + 1]!);
    }
    if (out.length < 4) out.push(out[0]! + 0.05, out[1]!);
    return { points: out };
  }

  /** Walking length of a route between two places, metres (straight line when there is no route). */
  routeLength(from: number, to: number): number {
    const def = this.route(from, to);
    if (!def) return 0;
    let l = 0;
    for (let i = 2; i < def.points.length; i += 2) {
      const dx = def.points[i]! - def.points[i - 2]!;
      const dz = def.points[i + 1]! - def.points[i - 1]!;
      l += Math.sqrt(dx * dx + dz * dz);
    }
    return l;
  }

  /** Arrival at the current activity's place: the app's hook or `stay`. */
  private arrive(e: number): number {
    const r = this.row(e);
    const c = this.table.col;
    const i = this.first[c.index[r]!]! + c.act[r]!;
    this.sim?.events.post('agenda.arrive', e, { place: this.aPlace[i]!, activity: c.act[r]! });
    const s = this.options.onArrive?.(e, this);
    if (s !== undefined) return s;
    if (this.places[this.aPlace[i]!]!.inside) this.hide(e);
    return this.stayUntil(e, this.now + this.aStay[i]!);
  }

  private updateBefore(e: number): number | void {
    const r = this.row(e);
    const c = this.table.col;
    const i = this.first[c.index[r]!]!;
    if (this.now < this.aAt[i]!) return;
    this.sim?.events.post('agenda.appear', e, { place: this.aPlace[i]!, activity: 0 });
    const s = this.options.onAppear?.(e, this);
    if (s !== undefined) return s;
    const place = this.places[this.aPlace[i]!]!;
    if (!place.inside) {
      const [x, z] = this.spot(this.aPlace[i]!);
      this.show(e, x, z);
    }
    return this.stayUntil(e, this.aAt[i]! + this.aStay[i]!);
  }

  /** When the trip to the next activity is due (tick), or null at the last one. */
  private departure(e: number): number | null {
    const r = this.row(e);
    const c = this.table.col;
    const idx = c.index[r]!;
    const k = c.act[r]! + 1;
    if (k >= this.count[idx]!) return null;
    const i = this.first[idx]! + k;
    if (!this.aArrive[i]) return this.aAt[i]!;
    if (c.dep[r] === UNSET) {
      // Arrive by `at`: leave the walking time earlier (route length at the entity's speed).
      const len = this.routeLength(this.aPlace[i - 1]!, this.aPlace[i]!);
      const speed = this.options.spawn?.(idx).cruise ?? 1.3;
      c.dep[r] = this.aAt[i]! - Math.ceil((len / speed) * this.hz);
    }
    return c.dep[r]!;
  }

  private updateStay(e: number): number | void {
    const end = this.timer(e);
    const dep = this.departure(e);
    if (dep === null) {
      if (this.now >= end) return this.finish(e);
      return;
    }
    const leave = Math.max(end, dep);
    if (this.now < leave) return;
    return this.leave(e, this.now - leave);
  }

  private updateTravel(e: number): number | void {
    const m = this.mover(e);
    if (m !== 0 && this.movers.info(m).state !== MOVER_STATE.done) return;
    return this.arrive(e);
  }

  /** The system: one tick of every agenda. Register it after the movers' system. */
  readonly system = (sim: Simulation): void => {
    this.sim = sim;
    const c = this.table.col;
    // Rows can be removed by nobody but the app; iterate by id order of the rows at the start of the tick.
    const ids = Array.from(this.table.ids.subarray(0, this.table.count));
    for (const e of ids) {
      const r = this.table.rowOf(e);
      if (r < 0) continue;
      const s = c.state[r]!;
      if (s === this.DONE) continue;
      const next = this.states.step(e, s, this);
      const r2 = this.table.rowOf(e);
      if (r2 >= 0) c.state[r2] = next;
    }
  };

  save(w: ByteWriter): void {
    w.u32(this.aPlace.length);
    this.table.save(w);
  }

  load(r: ByteReader): void {
    if (r.u32() !== this.aPlace.length) throw new Error('Agendas: the snapshot has other activities than this setup');
    this.table.load(r);
  }
}
