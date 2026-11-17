// Coarse movement over a whole network: every edge of a navigation graph is a queue with a capacity, and the trips
// in it are only numbers (how many, and when each may leave). Individual entities exist only on the edges of a focus
// area (around the camera of the app); there the same trips are movers of an ordinary `Movers` set.
//
// The model, per edge (a "segment"):
// - storage: at most `capacity` trips fit (length · lanes / spacing); a full segment lets nobody in, so queues spill
//   back along the routes;
// - free time: a trip that enters may leave after `free` ticks at the earliest (length / speed);
// - outflow: at most `outflow` trips per second and lane leave, first in first out;
// - patience: a head that has waited for room longer than `patience` is pushed on anyway, so rings of full segments
//   dissolve.
//
// Hand-over between numbers and individuals (conservation: a trip is always exactly one of the two, the totals of
// `census` never change by a hand-over):
// - a trip that moves from a coarse segment into a detailed one becomes a mover at the start of that segment, which
//   lies on the rim of the focus area;
// - when the focus moves, the trips queued on a segment that turns detailed all become movers along it, placed by
//   how far through the segment their leaving time puts them (so a detailed segment never holds a number); the
//   movers on a segment that turns coarse go back into its queue with the leaving time their position gives;
// - a mover that drives out of the focus area is taken back into the queue of the coarse segment it has entered.
//
// Determinism: integer ticks and millimetres only. The focus is input, so it comes as a command. Routes are a pure
// function of the graph (`RegionNav`), so they are derived data, not state. Setting the model up at a clock time
// (`prepare`) is a pure function of the trips and the origin: it can be done in pieces over many frames and gives
// the same state as doing it at once.

import { hashInts } from '../gen-core/hash.ts';
import type { ByteReader, ByteWriter } from './bytes.ts';
import { mm, mmPerTick } from './fixed.ts';
import { MOVER_STATE, Movers } from './movers.ts';
import type { CollisionMode, SpawnOptions } from './movers.ts';
import type { NavGraph } from './nav.ts';
import type { PathDef } from './paths.ts';
import type { RegionNav } from './regions.ts';
import type { SimState, Simulation } from './simulation.ts';

/** State of a trip. */
export const FLOW_STATE = { pending: 0, waiting: 1, queued: 2, individual: 3, arrived: 4, unreachable: 5 } as const;

export interface FlowTrip {
  /** Start and goal node of the graph. */
  from: number;
  to: number;
  /** Departure on the flow clock, seconds (tick 0 is `origin`). */
  at: number;
  /** Free integer for the app. */
  tag?: number;
}

/** How a trip looks as a mover: everything of `SpawnOptions` the network does not decide itself. */
export type FlowMoverOptions = Omit<SpawnOptions, 'path' | 'at' | 'tag' | 'speed'>;

export interface FlowOptions {
  nav: NavGraph;
  routes: RegionNav;
  hz: number;
  /** Seconds between two steps of the queues. Default 1. */
  period?: number;
  /** Speed on edges without a limit, and the most on any edge, m/s. Default 10. */
  speed?: number;
  /** Length one trip takes in a standing queue, metres. Default 7.5. */
  spacing?: number;
  /** Trips that may leave a segment per second and lane. Default 0.5. */
  outflow?: number;
  /** Lanes of every edge, or one number per edge. Default 1. */
  lanes?: number | ArrayLike<number>;
  /** Seconds a trip waits for room in the next segment before it is pushed on anyway. Default 120. */
  patience?: number;
  /** Most trips that may start in one step (each needs a route). Default 256. */
  departuresPerStep?: number;
  /** No trip takes longer than this, seconds: trips that left earlier are over when the model is set up. Default 7200. */
  horizon?: number;
  /** Clock second of tick 0. Default 0. */
  origin?: number;
  /** Collision mode and default width of the individual movers. Defaults `follow` and 1.8 m. */
  collision?: CollisionMode;
  width?: number;
  /** Movers keep this far to the right of the edges, metres: one number, or one per edge. Default 0. */
  rightOffset?: number | ArrayLike<number>;
  /** Edges a mover's path looks ahead; a longer route gets a new path on the way. Default 24. */
  pathEdges?: number;
  /** Mover parameters of a trip; must be a pure function of the trip index. Default: cruise at `speed`. */
  spawn?: (trip: number) => FlowMoverOptions;
}

export interface FlowCensus {
  trips: number;
  pending: number;
  waiting: number;
  queued: number;
  individual: number;
  arrived: number;
  unreachable: number;
  /** Trips on the segments (queued + individual). */
  load: number;
}

const NEVER = 0x7fffffff;
const MILLI = 1000;

export class FlowNetwork implements SimState {
  readonly name: string;
  readonly nav: NavGraph;
  readonly routes: RegionNav;
  readonly hz: number;
  /** The individual trips. Its `tag` column is the trip index. */
  readonly movers: Movers;
  /** Ticks between two steps of the queues. */
  readonly every: number;
  /** Per edge: trips that fit, and ticks a trip needs at least. */
  readonly capacity: Int32Array;
  readonly free: Int32Array;
  /** Per edge: trips on it now (queued and individual), and whether it is in the focus area. */
  readonly occupancy: Int32Array;
  readonly detail: Uint8Array;
  /** Hand-overs so far: numbers to movers, and movers back to numbers. Not state. */
  spawned = 0;
  merged = 0;

  private readonly edges: number;
  private readonly mmX: Int32Array;
  private readonly mmZ: Int32Array;
  /** Outflow per step in thousandths of a trip, and the size of the allowance (at least one trip). */
  private readonly rate: Int32Array;
  private readonly bucket: Int32Array;
  /** Queue per edge: first and last trip, and the leaving time of the first (NEVER when empty). */
  private readonly head: Int32Array;
  private readonly tail: Int32Array;
  private readonly headDue: Int32Array;
  /** Used part of the outflow allowance and the tick it was last refilled. */
  private readonly deficit: Float64Array;
  private readonly refillTick: Int32Array;
  /** Tick since which the head has waited for room, or -1. */
  private readonly blockedSince: Int32Array;

  private readonly spacing: number;
  private readonly patience: number;
  private readonly horizon: number;
  private readonly perStep: number;
  private readonly pathEdges: number;
  private readonly pathOptions: { rightOffset: number };
  /** Offset to the right per edge, metres, when the edges do not share one. */
  private readonly offsets: Float64Array | null;
  private readonly spawnOptions: (trip: number) => FlowMoverOptions;

  // Trips: what was asked for (fixed) and where each is now (state).
  private n = 0;
  private tFrom = new Int32Array(1024);
  private tTo = new Int32Array(1024);
  private tDepart = new Int32Array(1024);
  private tTag = new Int32Array(1024);
  private tState = new Uint8Array(1024);
  /** Index of the current edge in the route, and the edge itself. */
  private tLeg = new Int32Array(1024);
  private tSeg = new Int32Array(1024);
  /** Queued: earliest leaving tick. Waiting: tick since which it waits. */
  private tDue = new Int32Array(1024);
  /** Queued: the trip behind it. */
  private tNext = new Int32Array(1024);
  /** Individual: route index of the first edge of its path, and its mover. */
  private tBase = new Int32Array(1024);
  private tMover = new Float64Array(1024);
  /** Routes of the trips under way (derived: looked up again when missing). */
  private tRoute: (Int32Array | undefined)[] = [];
  private defHash = 0x9e3779b9;
  private inOrder = true;
  /** Trips by departure, then index; null while the trips were added in that order anyway. */
  private order: Int32Array | null = null;
  private sorted = false;
  private started = false;

  private originTick: number;
  private prepared = false;
  /** Set-up progress: next and last position in `order` to place, -1 before the range is known. */
  private placeAt = -1;
  private placeEnd = 0;
  /** Position in `order` of the next trip to start. */
  private cursor = 0;
  private waiting: number[] = [];
  private lastStep = 0;
  private fx = 0;
  private fz = 0;
  private fr = 0;
  private focusDirty = false;
  private cPending = 0;
  private cQueued = 0;
  private cIndividual = 0;
  private cArrived = 0;
  private cUnreachable = 0;

  constructor(name: string, options: FlowOptions) {
    this.name = name;
    this.nav = options.nav;
    this.routes = options.routes;
    if (this.routes.nav !== this.nav) throw new Error('FlowNetwork: the routes belong to another graph');
    this.hz = options.hz;
    const nav = this.nav;
    const m = nav.edgeCount;
    this.edges = m;
    this.every = Math.max(1, Math.round((options.period ?? 1) * this.hz));
    const speed = Math.max(1, mmPerTick(options.speed ?? 10, this.hz));
    this.spacing = Math.max(1, mm(options.spacing ?? 7.5));
    this.patience = Math.max(this.every, Math.round((options.patience ?? 120) * this.hz));
    this.horizon = Math.max(1, Math.round((options.horizon ?? 7200) * this.hz));
    this.perStep = Math.max(1, Math.floor(options.departuresPerStep ?? 256));
    this.pathEdges = Math.max(2, Math.floor(options.pathEdges ?? 24));
    const right = options.rightOffset ?? 0;
    this.pathOptions = { rightOffset: typeof right === 'number' ? right : 0 };
    this.offsets = typeof right === 'number' ? null : Float64Array.from({ length: this.nav.edgeCount }, (_, e) => right[e] ?? 0);
    const cruise = options.speed ?? 10;
    this.spawnOptions = options.spawn ?? (() => ({ cruise }));
    this.originTick = Math.round((options.origin ?? 0) * this.hz);
    this.movers = new Movers(`${name}.movers`, { hz: this.hz, collision: options.collision ?? 'follow', ...(options.width !== undefined ? { width: options.width } : {}) });

    this.mmX = new Int32Array(nav.nodeCount);
    this.mmZ = new Int32Array(nav.nodeCount);
    for (let i = 0; i < nav.nodeCount; i++) {
      this.mmX[i] = mm(nav.nodeX[i]!);
      this.mmZ[i] = mm(nav.nodeZ[i]!);
    }
    this.capacity = new Int32Array(m);
    this.free = new Int32Array(m);
    this.rate = new Int32Array(m);
    this.bucket = new Int32Array(m);
    const lanes = options.lanes ?? 1;
    const perSecond = options.outflow ?? 0.5;
    const period = this.every / this.hz;
    for (let e = 0; e < m; e++) {
      const l = Math.max(1, Math.round(typeof lanes === 'number' ? lanes : (lanes[e] ?? 1)));
      const len = nav.edgeLength[e]!;
      this.capacity[e] = Math.max(1, Math.floor((len * l) / this.spacing));
      const limit = nav.edgeSpeed[e]! > 0 ? Math.max(1, Math.min(speed, mmPerTick(nav.edgeSpeed[e]!, this.hz))) : speed;
      this.free[e] = Math.max(this.every, Math.ceil(len / limit));
      this.rate[e] = Math.max(1, Math.round(perSecond * l * period * MILLI));
      this.bucket[e] = Math.max(MILLI, this.rate[e]!);
    }
    this.occupancy = new Int32Array(m);
    this.detail = new Uint8Array(m);
    this.head = new Int32Array(m).fill(-1);
    this.tail = new Int32Array(m).fill(-1);
    this.headDue = new Int32Array(m).fill(NEVER);
    this.deficit = new Float64Array(m);
    this.refillTick = new Int32Array(m);
    this.blockedSince = new Int32Array(m).fill(-1);
  }

  // --- Setup -------------------------------------------------------------------------------------------------------

  /** Trips added. */
  get size(): number {
    return this.n;
  }

  private grow(): void {
    const cap = this.tFrom.length * 2;
    const i32 = (a: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.tFrom = i32(this.tFrom);
    this.tTo = i32(this.tTo);
    this.tDepart = i32(this.tDepart);
    this.tTag = i32(this.tTag);
    this.tLeg = i32(this.tLeg);
    this.tSeg = i32(this.tSeg);
    this.tDue = i32(this.tDue);
    this.tNext = i32(this.tNext);
    this.tBase = i32(this.tBase);
    const s = new Uint8Array(cap);
    s.set(this.tState);
    this.tState = s;
    const f = new Float64Array(cap);
    f.set(this.tMover);
    this.tMover = f;
  }

  /** Adds a trip and returns its index. Trips are setup: add them all before the first tick. */
  add(trip: FlowTrip): number {
    if (this.started) throw new Error('FlowNetwork: add trips before the simulation runs');
    const nodes = this.nav.nodeCount;
    if (!(trip.from >= 0 && trip.from < nodes && trip.to >= 0 && trip.to < nodes)) throw new Error(`FlowNetwork: trip ${trip.from} → ${trip.to} names a node outside the graph`);
    if (this.n === this.tFrom.length) this.grow();
    const i = this.n++;
    this.tFrom[i] = trip.from;
    this.tTo[i] = trip.to;
    this.tDepart[i] = Math.round(trip.at * this.hz);
    this.tTag[i] = trip.tag ?? 0;
    this.tState[i] = FLOW_STATE.pending;
    if (i > 0 && this.tDepart[i]! < this.tDepart[i - 1]!) this.inOrder = false;
    this.defHash = hashInts(this.defHash, trip.from, trip.to, this.tDepart[i]!, this.tTag[i]!);
    this.cPending++;
    return i;
  }

  /**
   * Registers the network with a simulation: its movers and itself as state, the command `<name>.focus`
   * (`x`, `z`, `radius` in metres) and the two systems (movers, then the queues).
   */
  attach(sim: Simulation): void {
    sim.addState(this.movers);
    sim.addState(this);
    sim.onCommand(`${this.name}.focus`, (cmd) => this.setFocus(Number(cmd.data.x ?? 0), Number(cmd.data.z ?? 0), Number(cmd.data.radius ?? 0)));
    sim.addSystem(`${this.name}.movers`, this.movers.system);
    sim.addSystem(this.name, this.system);
  }

  /**
   * Moves the focus area: a circle in metres; edges with both ends inside are detailed. Radius 0 means no focus.
   * The focus is input of the simulation: call this only from a command handler (`attach` registers one), never from
   * a frame. It takes effect at the next step of the queues.
   */
  setFocus(x: number, z: number, radius: number): void {
    this.fx = mm(x);
    this.fz = mm(z);
    this.fr = Math.max(0, mm(radius));
    this.focusDirty = true;
  }

  /** The focus area now: centre and radius in metres (radius 0: none). */
  get focus(): { x: number; z: number; radius: number } {
    return { x: this.fx / 1000, z: this.fz / 1000, radius: this.fr / 1000 };
  }

  /** Clock second of tick 0. */
  get origin(): number {
    return this.originTick / this.hz;
  }

  /**
   * Moves tick 0 to another clock second and empties the network; `prepare` then sets it up for that time. For a
   * clock that jumps: `sim.rebase(snapshot)`, `setOrigin`, then `prepare` over a few frames before stepping.
   */
  setOrigin(seconds: number): void {
    this.originTick = Math.round(seconds * this.hz);
    this.clear();
  }

  private clear(): void {
    const m = this.movers;
    while (m.count > 0) m.remove(m.table.idAt(m.count - 1));
    this.tState.fill(FLOW_STATE.pending, 0, this.n);
    this.tRoute.length = 0;
    this.occupancy.fill(0);
    this.detail.fill(0);
    this.head.fill(-1);
    this.tail.fill(-1);
    this.headDue.fill(NEVER);
    this.deficit.fill(0);
    this.refillTick.fill(0);
    this.blockedSince.fill(-1);
    this.waiting.length = 0;
    this.prepared = false;
    this.placeAt = -1;
    this.placeEnd = 0;
    this.cursor = 0;
    this.lastStep = 0;
    this.fx = this.fz = this.fr = 0;
    this.focusDirty = false;
    this.cPending = this.n;
    this.cQueued = this.cIndividual = this.cArrived = this.cUnreachable = 0;
  }

  private at(k: number): number {
    return this.order ? this.order[k]! : k;
  }

  /** First position in `order` whose trip departs at or after `tick`. */
  private firstFrom(tick: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tDepart[this.at(mid)]! < tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Is the network set up for its origin (nothing left for `prepare`)? */
  get ready(): boolean {
    return this.prepared;
  }

  /**
   * Sets the network up for the clock time of tick 0, at most `units` pieces of work per call (a region of the route
   * search or one trip), and returns the pieces left; 0 means ready. Trips that left before the origin are put where
   * free travel has taken them by then, or are over. The result does not depend on how the calls are cut, and a
   * simulation stepped before it is ready finishes the work in its first step.
   */
  prepare(units = Infinity): number {
    if (this.prepared) return 0;
    this.started = true;
    let left = units;
    if (!this.routes.ready) {
      const before = this.routes.pending;
      const rest = this.routes.prepare(left);
      left -= before - rest;
      if (rest > 0) return rest + this.n;
    }
    this.sortTrips();
    if (this.placeAt < 0) {
      // Trips that left more than the horizon ago are over; the ones in between are placed one by one.
      const over = this.firstFrom(this.originTick - this.horizon);
      for (let k = 0; k < over; k++) this.tState[this.at(k)] = FLOW_STATE.arrived;
      this.cArrived += over;
      this.cPending -= over;
      this.placeAt = over;
      this.placeEnd = this.firstFrom(this.originTick);
    }
    while (this.placeAt < this.placeEnd && left > 0) {
      this.placeUnderWay(this.at(this.placeAt++));
      left--;
    }
    if (this.placeAt < this.placeEnd) return this.placeEnd - this.placeAt;
    this.cursor = this.placeEnd;
    this.prepared = true;
    return 0;
  }

  /** Orders the trips by departure (derived from the trips, so it is not part of the saved state). */
  private sortTrips(): void {
    if (this.sorted) return;
    if (!this.inOrder) {
      const depart = this.tDepart;
      this.order = Int32Array.from({ length: this.n }, (_, i) => i).sort((a, b) => depart[a]! - depart[b]! || a - b);
    }
    this.sorted = true;
  }

  /** Puts a trip that left before the origin where free travel has taken it by tick 0. */
  private placeUnderWay(trip: number): void {
    this.cPending--;
    const route = this.routes.find(this.tFrom[trip]!, this.tTo[trip]!);
    if (route === null) {
      this.tState[trip] = FLOW_STATE.unreachable;
      this.cUnreachable++;
      return;
    }
    const elapsed = this.originTick - this.tDepart[trip]!;
    let t = 0;
    for (let leg = 0; leg < route.length; leg++) {
      const e = route[leg]!;
      t += this.free[e]!;
      if (t <= elapsed) continue;
      this.tRoute[trip] = route;
      this.tLeg[trip] = leg;
      this.tSeg[trip] = e;
      this.tState[trip] = FLOW_STATE.queued;
      this.occupancy[e] = this.occupancy[e]! + 1;
      this.cQueued++;
      this.enqueue(e, trip, t - elapsed);
      return;
    }
    this.tState[trip] = FLOW_STATE.arrived;
    this.cArrived++;
  }

  // --- Queues ------------------------------------------------------------------------------------------------------

  /** Puts a trip into the queue of an edge, ordered by leaving time (behind the ones that leave at the same tick). */
  private enqueue(e: number, trip: number, due: number): void {
    this.tDue[trip] = due;
    const last = this.tail[e]!;
    if (last < 0) {
      this.head[e] = trip;
      this.tail[e] = trip;
      this.tNext[trip] = -1;
      this.headDue[e] = due;
      return;
    }
    if (this.tDue[last]! <= due) {
      this.tNext[last] = trip;
      this.tNext[trip] = -1;
      this.tail[e] = trip;
      return;
    }
    // Out of order (set-up, a mover handed back): before the first one that leaves later. The tail leaves later.
    let prev = -1;
    let cur = this.head[e]!;
    while (this.tDue[cur]! <= due) {
      prev = cur;
      cur = this.tNext[cur]!;
    }
    this.tNext[trip] = cur;
    if (prev < 0) {
      this.head[e] = trip;
      this.headDue[e] = due;
    } else this.tNext[prev] = trip;
  }

  private popHead(e: number): number {
    const h = this.head[e]!;
    const next = this.tNext[h]!;
    this.head[e] = next;
    if (next < 0) {
      this.tail[e] = -1;
      this.headDue[e] = NEVER;
    } else this.headDue[e] = this.tDue[next]!;
    return h;
  }

  private routeOf(trip: number): Int32Array {
    let r = this.tRoute[trip];
    if (r === undefined) {
      r = this.routes.find(this.tFrom[trip]!, this.tTo[trip]!) ?? undefined;
      if (r === undefined) throw new Error(`FlowNetwork: trip ${trip} is under way without a route`);
      this.tRoute[trip] = r;
    }
    return r;
  }

  private arrive(sim: Simulation, trip: number): void {
    this.tState[trip] = FLOW_STATE.arrived;
    this.tRoute[trip] = undefined;
    this.cArrived++;
    sim.events.post('flow.arrive', 0, { net: this.name, trip });
  }

  /** The system: steps the queues every `every` ticks. `attach` registers it after the movers' system. */
  readonly system = (sim: Simulation): void => {
    const now = sim.tick;
    if (now % this.every !== 0) return;
    if (!this.prepared) this.prepare();
    this.lastStep = now;
    if (this.focusDirty) this.applyFocus(now);
    this.sync(sim, now);
    this.depart(sim, now);
    this.outflow(sim, now);
  };

  /** Starts the trips whose time has come: the ones waiting for room first, then new ones up to the step's budget. */
  private depart(sim: Simulation, now: number): void {
    const waiting = this.waiting;
    let kept = 0;
    for (let i = 0; i < waiting.length; i++) {
      const trip = waiting[i]!;
      const e = this.tSeg[trip]!;
      if (this.occupancy[e]! < this.capacity[e]! || now - this.tDue[trip]! >= this.patience) this.start(trip, e, now);
      else waiting[kept++] = trip;
    }
    waiting.length = kept;
    const clock = this.originTick + now;
    let budget = this.perStep;
    while (this.cursor < this.n && budget > 0) {
      const trip = this.at(this.cursor);
      if (this.tDepart[trip]! > clock) break;
      this.cursor++;
      budget--;
      this.cPending--;
      const route = this.routes.find(this.tFrom[trip]!, this.tTo[trip]!);
      if (route === null) {
        this.tState[trip] = FLOW_STATE.unreachable;
        this.cUnreachable++;
        sim.events.post('flow.unreachable', 0, { net: this.name, trip });
        continue;
      }
      if (route.length === 0) {
        this.arrive(sim, trip);
        continue;
      }
      this.tRoute[trip] = route;
      const e = route[0]!;
      this.tLeg[trip] = 0;
      this.tSeg[trip] = e;
      if (this.occupancy[e]! < this.capacity[e]!) this.start(trip, e, now);
      else {
        this.tState[trip] = FLOW_STATE.waiting;
        this.tDue[trip] = now;
        waiting.push(trip);
      }
    }
  }

  /** Lets a trip onto the first edge of its route: as a mover when the edge is detailed, else into its queue. */
  private start(trip: number, e: number, now: number): void {
    this.occupancy[e] = this.occupancy[e]! + 1;
    if (this.detail[e]) this.spawn(trip, 0, 0, false);
    else {
      this.tState[trip] = FLOW_STATE.queued;
      this.cQueued++;
      this.enqueue(e, trip, now + this.free[e]!);
    }
  }

  /** Moves the heads of the queues on: to the next edge of their route when it has room, or out at their goal. */
  private outflow(sim: Simulation, now: number): void {
    const headDue = this.headDue;
    for (let e = 0; e < this.edges; e++) {
      if (headDue[e]! > now) continue;
      // The allowance refills by `rate` per step, up to `bucket`.
      const steps = Math.floor((now - this.refillTick[e]!) / this.every);
      let used = Math.max(0, this.deficit[e]! - this.rate[e]! * steps);
      this.refillTick[e] = now;
      const room = this.bucket[e]!;
      while (headDue[e]! <= now && room - used >= MILLI) {
        const trip = this.head[e]!;
        const route = this.routeOf(trip);
        const leg = this.tLeg[trip]!;
        if (leg === route.length - 1) {
          this.popHead(e);
          this.occupancy[e] = this.occupancy[e]! - 1;
          this.cQueued--;
          this.blockedSince[e] = -1;
          used += MILLI;
          this.arrive(sim, trip);
          continue;
        }
        const next = route[leg + 1]!;
        if (this.occupancy[next]! >= this.capacity[next]! && !(this.blockedSince[e]! >= 0 && now - this.blockedSince[e]! >= this.patience)) {
          if (this.blockedSince[e]! < 0) this.blockedSince[e] = now;
          break;
        }
        this.popHead(e);
        this.occupancy[e] = this.occupancy[e]! - 1;
        this.occupancy[next] = this.occupancy[next]! + 1;
        this.blockedSince[e] = -1;
        used += MILLI;
        this.tLeg[trip] = leg + 1;
        this.tSeg[trip] = next;
        if (this.detail[next]) {
          this.cQueued--;
          this.spawn(trip, leg + 1, 0, true);
        } else this.enqueue(next, trip, now + this.free[next]!);
      }
      this.deficit[e] = used;
    }
  }

  // --- Hand-over ---------------------------------------------------------------------------------------------------

  /** The edges of a route from `base` on, as far as a path looks ahead. */
  private pathFrom(route: Int32Array, base: number, count: number): number {
    const n = Math.min(count, route.length - base);
    const edges = new Array<number>(n);
    for (let i = 0; i < n; i++) edges[i] = route[base + i]!;
    return this.movers.paths.add(this.offsets ? this.offsetPath(edges, this.offsets) : this.nav.path(edges, this.pathOptions), { owned: true });
  }

  /**
   * A path along edges that each keep an own distance to the right: one segment per edge with the edge as its lane.
   * A vertex between two edges lies on both shifted lines; where they are nearly parallel, or the meeting point
   * would run away, it lies halfway between the two shifted ends.
   */
  private offsetPath(edges: readonly number[], off: Float64Array): PathDef {
    const nav = this.nav;
    const points: number[] = [];
    // Right-hand normal and offset of the edge before the vertex.
    let pnx = 0;
    let pnz = 0;
    let po = 0;
    for (let i = 0; i <= edges.length; i++) {
      const node = i < edges.length ? nav.edgeFrom[edges[i]!]! : nav.edgeTo[edges[i - 1]!]!;
      let nx = 0;
      let nz = 0;
      let o = 0;
      if (i < edges.length) {
        const e = edges[i]!;
        const a = nav.edgeFrom[e]!;
        const b = nav.edgeTo[e]!;
        const dx = nav.nodeX[b]! - nav.nodeX[a]!;
        const dz = nav.nodeZ[b]! - nav.nodeZ[a]!;
        const l = Math.sqrt(dx * dx + dz * dz) || 1;
        nx = -dz / l;
        nz = dx / l;
        o = off[e]!;
      }
      let vx = nx * o;
      let vz = nz * o;
      if (i === edges.length) {
        vx = pnx * po;
        vz = pnz * po;
      } else if (i > 0) {
        vx = (pnx * po + nx * o) / 2;
        vz = (pnz * po + nz * o) / 2;
        const det = pnx * nz - pnz * nx;
        if (Math.abs(det) > 0.2) {
          const mx = (po * nz - o * pnz) / det;
          const mz = (o * pnx - po * nx) / det;
          const reach = 3 * Math.max(Math.abs(po), Math.abs(o));
          if (mx * mx + mz * mz <= reach * reach) {
            vx = mx;
            vz = mz;
          }
        }
      }
      points.push(nav.nodeX[node]! + vx, nav.nodeZ[node]! + vz);
      pnx = nx;
      pnz = nz;
      po = o;
    }
    return { points, speeds: edges.map((e) => nav.edgeSpeed[e]!), lanes: [...edges] };
  }

  /**
   * Makes a trip an individual mover on edge `leg` of its route, `s` mm into the edge (of the edge's own length).
   * The caller has counted the trip on the edge and taken it out of any queue.
   */
  private spawn(trip: number, leg: number, s: number, moving: boolean): void {
    const route = this.routeOf(trip);
    const e = route[leg]!;
    const path = this.pathFrom(route, leg, this.pathEdges);
    const p = this.movers.paths.get(path);
    // The path runs beside the edge, so its first segment has a slightly different length: keep the proportion.
    const at = Math.min(p.segStart[1]! - 1, Math.floor((s * p.segStart[1]!) / this.nav.edgeLength[e]!));
    const o = this.spawnOptions(trip);
    this.tMover[trip] = this.movers.spawn({ ...o, path, at: Math.max(0, at) / 1000, tag: trip, speed: moving ? o.cruise : 0 });
    this.tBase[trip] = leg;
    this.tLeg[trip] = leg;
    this.tSeg[trip] = e;
    this.tState[trip] = FLOW_STATE.individual;
    this.cIndividual++;
    this.spawned++;
  }

  /** Applies a moved focus: marks the edges and turns the queues of newly detailed edges into movers. */
  private applyFocus(now: number): void {
    this.focusDirty = false;
    const nav = this.nav;
    const r2 = this.fr * this.fr;
    for (let e = 0; e < this.edges; e++) {
      let inside = 0;
      if (this.fr > 0) {
        const a = nav.edgeFrom[e]!;
        const b = nav.edgeTo[e]!;
        const ax = this.mmX[a]! - this.fx;
        const az = this.mmZ[a]! - this.fz;
        const bx = this.mmX[b]! - this.fx;
        const bz = this.mmZ[b]! - this.fz;
        if (ax * ax + az * az <= r2 && bx * bx + bz * bz <= r2) inside = 1;
      }
      if (inside === this.detail[e]) continue;
      this.detail[e] = inside;
      if (inside && this.head[e]! >= 0) this.materialise(e, now);
    }
  }

  /**
   * Turns the whole queue of an edge into movers along it, the first to leave furthest ahead: each stands where its
   * leaving time puts it at free speed, but no closer than `spacing` behind the one ahead (closer only when more
   * trips are queued than fit in one file).
   */
  private materialise(e: number, now: number): void {
    const len = this.nav.edgeLength[e]!;
    const free = this.free[e]!;
    let count = 0;
    for (let trip = this.head[e]!; trip >= 0; trip = this.tNext[trip]!) count++;
    const gap = Math.min(this.spacing, Math.floor(len / count));
    let ahead = len - 1 + gap;
    for (;;) {
      const trip = this.head[e]!;
      if (trip < 0) break;
      const remain = Math.min(free, Math.max(0, this.tDue[trip]! - now));
      const s = Math.max(0, Math.min(len - 1 - Math.floor(((len - 1) * remain) / free), ahead - gap));
      this.popHead(e);
      this.cQueued--;
      this.spawn(trip, this.tLeg[trip]!, s, remain > 0);
      ahead = s;
    }
    this.blockedSince[e] = -1;
  }

  /**
   * Follows the movers: counts each on the edge it has reached, lets the ones at their goal arrive, takes the ones
   * on a coarse edge back into that edge's queue, and gives a new path to the ones near the end of theirs.
   */
  private sync(sim: Simulation, now: number): void {
    const m = this.movers;
    const t = m.table;
    for (let r = t.count - 1; r >= 0; r--) {
      const c = t.col;
      const trip = c.tag[r]!;
      const id = t.idAt(r);
      const p = m.paths.get(c.path[r]!);
      const seg = c.seg[r]!;
      const route = this.routeOf(trip);
      let leg = this.tLeg[trip]!;
      const reached = this.tBase[trip]! + seg;
      while (leg < reached) {
        this.occupancy[route[leg]!] = this.occupancy[route[leg]!]! - 1;
        leg++;
        this.occupancy[route[leg]!] = this.occupancy[route[leg]!]! + 1;
      }
      let e = route[leg]!;
      const last = leg === route.length - 1;
      let pos = c.dist[r]! - p.segStart[seg]!;
      let segLen = p.segStart[seg + 1]! - p.segStart[seg]!;
      let speed = c.speed[r]!;
      let renew = seg === p.segments - 1 && !last && this.detail[route[leg + 1]!] === 1;
      if (c.state[r] === MOVER_STATE.done) {
        if (last) {
          this.occupancy[e] = this.occupancy[e]! - 1;
          m.remove(id);
          this.cIndividual--;
          this.arrive(sim, trip);
          continue;
        }
        // The end of a path that did not reach the goal: it stands at the start of the next edge.
        this.occupancy[e] = this.occupancy[e]! - 1;
        leg++;
        e = route[leg]!;
        this.occupancy[e] = this.occupancy[e]! + 1;
        pos = 0;
        segLen = 0;
        speed = 0;
        renew = true;
      }
      this.tLeg[trip] = leg;
      this.tSeg[trip] = e;
      if (!this.detail[e]) {
        // Out of the focus area: back to a number, leaving when free travel over the rest of the edge allows.
        const free = this.free[e]!;
        const remain = segLen > 0 ? Math.ceil((free * (segLen - pos)) / segLen) : free;
        m.remove(id);
        this.cIndividual--;
        this.tState[trip] = FLOW_STATE.queued;
        this.cQueued++;
        this.merged++;
        this.enqueue(e, trip, now + Math.max(1, remain));
        continue;
      }
      if (!renew) continue;
      // A new path from the edge before the current one (so the corner into it keeps its shape), same place and speed.
      const base = leg > 0 ? leg - 1 : 0;
      const path = this.pathFrom(route, base, this.pathEdges + (leg - base));
      const np = m.paths.get(path);
      const k = leg - base;
      const d = Math.min(np.segStart[k]! + pos, np.segStart[k + 1]! - 1);
      // The way covered in this tick is kept across the switch, so a pose taken between two ticks runs on smoothly
      // and reports the real speed.
      const moved = Math.max(0, c.dist[r]! - c.prev[r]!);
      m.setPath(id, path, d / 1000);
      const cc = t.col;
      cc.speed[r] = Math.min(speed, cc.cruise[r]!);
      cc.prev[r] = Math.max(0, d - moved);
      this.tBase[trip] = base;
    }
  }

  // --- Reading -----------------------------------------------------------------------------------------------------

  /** State of a trip (`FLOW_STATE`). */
  stateOf(trip: number): number {
    return this.tState[trip]!;
  }

  /** The app's tag of a trip. */
  tagOf(trip: number): number {
    return this.tTag[trip]!;
  }

  /** The edge a trip is on (or waits to enter), -1 when it is not under way. */
  edgeOf(trip: number): number {
    const s = this.tState[trip]!;
    return s === FLOW_STATE.waiting || s === FLOW_STATE.queued || s === FLOW_STATE.individual ? this.tSeg[trip]! : -1;
  }

  /** How many trips are in each state. Hand-overs between `queued` and `individual` never change the sums. */
  census(): FlowCensus {
    let load = 0;
    for (let e = 0; e < this.edges; e++) load += this.occupancy[e]!;
    return {
      trips: this.n, pending: this.cPending, waiting: this.waiting.length, queued: this.cQueued, individual: this.cIndividual,
      arrived: this.cArrived, unreachable: this.cUnreachable, load,
    };
  }

  /**
   * Counts everything again from the trips, the queues and the movers and compares it with the running counters:
   * returns what is wrong, or null. For tests of the conservation rule.
   */
  check(): string | null {
    const counts = [0, 0, 0, 0, 0, 0];
    const onEdge = new Int32Array(this.edges);
    for (let i = 0; i < this.n; i++) {
      const s = this.tState[i]!;
      counts[s] = counts[s]! + 1;
      if (s === FLOW_STATE.queued || s === FLOW_STATE.individual) onEdge[this.tSeg[i]!]!++;
    }
    const c = this.census();
    const want = [c.pending, c.waiting, c.queued, c.individual, c.arrived, c.unreachable];
    for (let s = 0; s < 6; s++) if (counts[s] !== want[s]) return `state ${s}: ${counts[s]} trips, counter says ${want[s]}`;
    if (c.pending + c.waiting + c.queued + c.individual + c.arrived + c.unreachable !== c.trips) return 'the states do not add up to the trips';
    if (c.load !== c.queued + c.individual) return `load ${c.load}, but ${c.queued} queued and ${c.individual} individual`;
    if (this.movers.count !== c.individual) return `${this.movers.count} movers for ${c.individual} individual trips`;
    let inQueues = 0;
    for (let e = 0; e < this.edges; e++) {
      if (onEdge[e] !== this.occupancy[e]) return `edge ${e}: load ${this.occupancy[e]}, trips on it ${onEdge[e]}`;
      if (this.detail[e] && this.head[e]! >= 0) return `edge ${e}: a queue on a detailed edge`;
      let due = -Infinity;
      for (let trip = this.head[e]!; trip >= 0; trip = this.tNext[trip]!) {
        if (this.tState[trip] !== FLOW_STATE.queued || this.tSeg[trip] !== e) return `edge ${e}: trip ${trip} in its queue is not queued on it`;
        if (this.tDue[trip]! < due) return `edge ${e}: queue out of order`;
        due = this.tDue[trip]!;
        inQueues++;
      }
    }
    if (inQueues !== c.queued) return `${inQueues} trips in queues, ${c.queued} queued`;
    const tags = this.movers.table.col.tag;
    for (let r = 0; r < this.movers.count; r++) {
      const trip = tags[r]!;
      if (this.tState[trip] !== FLOW_STATE.individual || this.tMover[trip] !== this.movers.table.idAt(r)) return `mover row ${r} does not belong to an individual trip`;
    }
    return null;
  }

  // --- State -------------------------------------------------------------------------------------------------------

  save(w: ByteWriter): void {
    const n = this.n;
    w.u32(n);
    w.u32(this.defHash);
    w.i32(this.originTick);
    w.u8(this.prepared ? 1 : 0);
    w.i32(this.placeAt);
    w.i32(this.placeEnd);
    w.i32(this.cursor);
    w.i32(this.lastStep);
    w.i32(this.fx);
    w.i32(this.fz);
    w.i32(this.fr);
    w.u8(this.focusDirty ? 1 : 0);
    w.i32(this.cPending);
    w.i32(this.cQueued);
    w.i32(this.cIndividual);
    w.i32(this.cArrived);
    w.i32(this.cUnreachable);
    w.bytes(this.tState.subarray(0, n));
    // Only trips under way have more than their state.
    for (let i = 0; i < n; i++) {
      const s = this.tState[i]!;
      if (s !== FLOW_STATE.waiting && s !== FLOW_STATE.queued && s !== FLOW_STATE.individual) continue;
      w.i32(this.tLeg[i]!);
      w.i32(this.tSeg[i]!);
      w.i32(s === FLOW_STATE.individual ? 0 : this.tDue[i]!);
      w.i32(s === FLOW_STATE.queued ? this.tNext[i]! : -1);
      w.i32(s === FLOW_STATE.individual ? this.tBase[i]! : 0);
      w.f64(s === FLOW_STATE.individual ? this.tMover[i]! : 0);
    }
    w.u32(this.waiting.length);
    for (const trip of this.waiting) w.i32(trip);
    // Only edges that hold something differ from an empty edge. The allowance is written as it stands at the last
    // step, so the bytes do not depend on when an edge was last looked at.
    let used = 0;
    for (let e = 0; e < this.edges; e++) if (this.edgeUsed(e)) used++;
    w.u32(used);
    for (let e = 0; e < this.edges; e++) {
      if (!this.edgeUsed(e)) continue;
      w.i32(e);
      w.i32(this.occupancy[e]!);
      w.i32(this.head[e]!);
      w.i32(this.tail[e]!);
      w.f64(this.deficitAt(e));
      w.i32(this.blockedSince[e]!);
      w.u8(this.detail[e]!);
    }
  }

  private deficitAt(e: number): number {
    return Math.max(0, this.deficit[e]! - this.rate[e]! * Math.floor((this.lastStep - this.refillTick[e]!) / this.every));
  }

  private edgeUsed(e: number): boolean {
    return this.occupancy[e]! > 0 || this.detail[e]! === 1 || this.head[e]! >= 0 || this.blockedSince[e]! >= 0 || this.deficitAt(e) > 0;
  }

  load(r: ByteReader): void {
    const n = r.u32();
    if (n !== this.n || r.u32() !== this.defHash >>> 0) throw new Error('FlowNetwork: snapshot of other trips');
    this.started = true;
    this.sortTrips();
    this.originTick = r.i32();
    this.prepared = r.u8() === 1;
    this.placeAt = r.i32();
    this.placeEnd = r.i32();
    this.cursor = r.i32();
    this.lastStep = r.i32();
    this.fx = r.i32();
    this.fz = r.i32();
    this.fr = r.i32();
    this.focusDirty = r.u8() === 1;
    this.cPending = r.i32();
    this.cQueued = r.i32();
    this.cIndividual = r.i32();
    this.cArrived = r.i32();
    this.cUnreachable = r.i32();
    r.into(this.tState.subarray(0, n));
    for (let i = 0; i < n; i++) {
      const s = this.tState[i]!;
      if (s !== FLOW_STATE.waiting && s !== FLOW_STATE.queued && s !== FLOW_STATE.individual) {
        this.tRoute[i] = undefined;
        continue;
      }
      this.tLeg[i] = r.i32();
      this.tSeg[i] = r.i32();
      this.tDue[i] = r.i32();
      this.tNext[i] = r.i32();
      this.tBase[i] = r.i32();
      this.tMover[i] = r.f64();
    }
    const waiting = r.u32();
    this.waiting.length = 0;
    for (let i = 0; i < waiting; i++) this.waiting.push(r.i32());
    this.occupancy.fill(0);
    this.detail.fill(0);
    this.head.fill(-1);
    this.tail.fill(-1);
    this.headDue.fill(NEVER);
    this.deficit.fill(0);
    this.refillTick.fill(this.lastStep);
    this.blockedSince.fill(-1);
    const used = r.u32();
    for (let k = 0; k < used; k++) {
      const e = r.i32();
      this.occupancy[e] = r.i32();
      this.head[e] = r.i32();
      this.tail[e] = r.i32();
      this.deficit[e] = r.f64();
      this.blockedSince[e] = r.i32();
      this.detail[e] = r.u8();
      if (this.head[e]! >= 0) this.headDue[e] = this.tDue[this.head[e]!]!;
    }
  }
}
