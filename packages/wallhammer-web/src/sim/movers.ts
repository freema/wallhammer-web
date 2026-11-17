// Entities that move along paths: speed up, cruise, slow down for lower limits ahead, stop at stops and dwell there,
// loop or stop at the end. One dense table per mover set, integer millimetres and ticks throughout, and a system
// that is a plain function. Arrivals and departures go to the event queue:
//
//   move.arrive  { path, stop }   reached stop `stop` (index along the path) and dwells
//   move.depart  { path, stop }   left that stop
//   move.end     { path }         reached the end of an open path and stands
//
// Collision is a parameter of the set:
// - `none`: entities pass through each other.
// - `follow`: keep a distance to the entity ahead on the same lane, looking one segment ahead.
// - `static`: no interaction between entities, but obstacles (`addObstacle`), known moving obstacles
//   (`setKnownObstacles`) and shared areas of an `Interlock` stop them.
// - `lanes`: `follow`, plus conflict zones where paths of different lanes come close (`buildZones`): a zone is held
//   by one entity at a time, granted in a fixed order and only when there is room behind it, plus everything of
//   `static`. For vehicles on a network.
// - `agents`: local avoidance for crowds on shared ways (a spatial hash over integer positions: slow down behind
//   someone, step aside for oncoming and standing ones, push apart when standing), plus everything of `static`.
//
// Every limit is computed from the state at the start of the tick, so the order rows are updated in does not matter.
// `none` and `follow` keep the snapshot layout they always had; the other modes add columns and sections.

import { ByteReader, ByteWriter } from './bytes.ts';
import { approachSpeed, brakeSpeed, isqrt, mm, mmPerTick, mmPerTick2, stoppingDistance } from './fixed.ts';
import type { Interlock } from './interlock.ts';
import { PathSet } from './paths.ts';
import type { Path, PathDef } from './paths.ts';
import type { SimState, Simulation } from './simulation.ts';
import { EntityTable } from './table.ts';
import { buildZoneIntervals } from './zones.ts';
import type { ZoneIntervals } from './zones.ts';

export type CollisionMode = 'none' | 'follow' | 'static' | 'agents' | 'lanes';

export const MOVER_STATE = { moving: 0, dwelling: 1, done: 2 } as const;

const MOVER_COLUMNS = {
  path: 'i32',
  seg: 'i32',
  /** Distance along the path in mm, and its value one tick earlier (unwrapped, for interpolation). */
  dist: 'i32',
  prev: 'i32',
  /** Speed now and wanted, mm per tick; acceleration and braking, mm per tick². */
  speed: 'i32',
  cruise: 'i32',
  accel: 'i32',
  decel: 'i32',
  /** Distance to keep to the entity ahead, mm (centre to centre). */
  gap: 'i32',
  /** Index of the next stop along the path (equal to the number of stops: the first stop of the next lap). */
  stop: 'i32',
  dwell: 'i32',
  state: 'u8',
  /** Free integer for the app (kind, colour, group). */
  tag: 'i32',
} as const;

/** Columns of the modes `static`, `lanes` and `agents`. */
const EXTRA_COLUMNS = {
  /** Body reach ahead of and behind the anchor, and half the width, mm. */
  front: 'i32',
  back: 'i32',
  half: 'i32',
  /** Offset from the path point (agents), mm, now and one tick earlier. */
  ox: 'i32',
  oz: 'i32',
  pox: 'i32',
  poz: 'i32',
  /** Ticks spent waiting for a zone or an area (older requests are granted first). */
  wait: 'i32',
  /** Agents: ticks standing still while meant to walk; after a while standing and oncoming ones no longer stop it. */
  stuck: 'i32',
} as const;

type MoverColumns = typeof MOVER_COLUMNS;
type AllColumns = typeof MOVER_COLUMNS & typeof EXTRA_COLUMNS;

export interface SpawnOptions {
  path: number;
  /** Start this far along the path, metres. */
  at?: number;
  /** Cruising speed, m/s. */
  cruise: number;
  /** m/s². Defaults 1 and 2. */
  accel?: number;
  decel?: number;
  /** Distance kept to the entity ahead, metres. Default 2. */
  gap?: number;
  /** Initial speed, m/s. */
  speed?: number;
  tag?: number;
  /** Body reach ahead of and behind the anchor, metres (zones, areas, obstacles). Defaults gap / 4 each. */
  front?: number;
  back?: number;
  /** Body width, metres (obstacles). Default the set's `width`. */
  width?: number;
}

/** A capsule: the segment a–b swollen by `radius`, metres. */
export interface Capsule {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  radius: number;
}

/**
 * Known moving obstacles for one tick: flat capsules `ax, az, bx, bz, radius` in metres. It must be a pure function
 * of the tick (a replayed schedule), so that seeking and replaying give the same simulation. Entities do not enter a
 * capsule; one already inside is free to leave it.
 */
export type KnownObstacles = (tick: number) => ArrayLike<number>;

export interface MoversOptions {
  hz: number;
  collision?: CollisionMode;
  namespace?: number;
  /** Default body width of the entities, metres (obstacle clearance). Default 1.8. */
  width?: number;
}

/** Floats per entity written by `extract`: x, z, direction x, direction z, metres along the path, speed m/s. */
export const TRANSFORM_STRIDE = 6;
/**
 * Floats per entity written by `extractPose`: the six of `extract`, then the turn rate in rad/s (positive turns
 * right, clockwise seen from above) and the state (`MOVER_STATE`). Enough to animate a rig.
 */
export const POSE_STRIDE = 8;
/** Direction is taken over this distance around the position (mm), so corners turn smoothly. */
const LOOK_MM = 800;
/** Grid cell of the static obstacle lookup, mm. */
const OBSTACLE_CELL = 8000;
/** Sampling step along a path when testing it against obstacles, mm. */
const SWEEP_MM = 250;
/** Distance kept before a blocked point, a zone or an area, mm. */
const HOLD_MM = 500;
const NO_LIMIT = 0x7fffffff;

/** Agents: neighbourhood radius, lateral corridor, sideways speed. */
const AGENT_CELL = 2000;
const AGENT_LOOK = 1800;
const AGENT_CORRIDOR = 650;
/** Neighbours closer sideways than this block the way; the side step goes this far out. */
const AGENT_BLOCK = 480;
const AGENT_STEP = 760;
/** Seconds of standing still after which an agent squeezes past standing and oncoming ones (no gridlock). */
const AGENT_PATIENCE_S = 3;
const AGENT_SIDE_MM_S = 600;
/** Standing agents are pushed apart until this far from each other, and stay within this radius of their point. */
const AGENT_STAND_GAP = 560;
const AGENT_STAND_RADIUS = 2000;

/** Collision features per mode. */
const F_FOLLOW = 1;
const F_ZONES = 2;
const F_OBSTACLES = 4;
const F_AGENTS = 8;
const FEATURES: Readonly<Record<CollisionMode, number>> = {
  none: 0,
  follow: F_FOLLOW,
  static: F_OBSTACLES,
  lanes: F_FOLLOW | F_ZONES | F_OBSTACLES,
  agents: F_AGENTS | F_OBSTACLES,
};

/** Per-path data derived from obstacles and areas (not state: rebuilt on demand). */
interface PathCache {
  /** Blocked stretches along the path, mm, ascending. */
  block0: Int32Array;
  block1: Int32Array;
}

export class Movers implements SimState {
  readonly name: string;
  readonly hz: number;
  readonly collision: CollisionMode;
  readonly table: EntityTable<MoverColumns>;
  readonly paths: PathSet;
  private readonly features: number;
  private readonly extended: boolean;
  private readonly defaultHalf: number;
  private follow = new Int32Array(0);
  private order: number[] = [];
  private readonly point: [number, number] = [0, 0];
  private readonly point2: [number, number] = [0, 0];
  private readonly frame = new Float64Array(5);
  /** Static obstacles: flat capsules in mm (ax, az, bx, bz, radius). Simulation state. */
  private obstacles: number[] = [];
  /** Obstacle indices by grid cell (not state: rebuilt when the obstacles change). */
  private obstacleGrid: Map<number, number[]> | null = null;
  private readonly cache = new Map<number, PathCache>();
  /** Conflict zones (`lanes`): intervals per path and the entity holding each zone (0 = free). */
  private zones: ZoneIntervals = { byPath: new Map(), count: 0 };
  private holder = new Float64Array(0);
  private known: KnownObstacles | null = null;
  /** Shared areas with another set. */
  interlock: { il: Interlock; side: 0 | 1 } | null = null;
  /** Lane groups of the last follow pass: lane → rows sorted by position on it. */
  private laneRows = new Map<number, number[]>();
  private lanePos = new Int32Array(0);

  constructor(name: string, options: MoversOptions) {
    this.name = name;
    this.hz = options.hz;
    this.collision = options.collision ?? 'none';
    if (!(this.collision in FEATURES)) throw new Error(`Movers: unknown collision "${this.collision}"`);
    this.features = FEATURES[this.collision];
    this.extended = this.collision !== 'none' && this.collision !== 'follow';
    this.defaultHalf = mm((options.width ?? 1.8) / 2);
    const spec = this.extended ? { ...MOVER_COLUMNS, ...EXTRA_COLUMNS } : MOVER_COLUMNS;
    this.table = new EntityTable(name, spec, options.namespace !== undefined ? { namespace: options.namespace } : {}) as EntityTable<MoverColumns>;
    this.paths = new PathSet(`${name}.paths`, this.hz);
  }

  get count(): number {
    return this.table.count;
  }

  /** Default half width of the entities, mm. */
  get halfWidth(): number {
    return this.defaultHalf;
  }

  private get ext(): Readonly<Record<keyof AllColumns, Int32Array>> {
    return this.table.col as unknown as Record<keyof AllColumns, Int32Array>;
  }

  /** Adds an entity on a path and returns its id. */
  spawn(o: SpawnOptions): number {
    const id = this.table.create();
    const row = this.table.rowOf(id);
    const c = this.table.col;
    c.cruise[row] = mmPerTick(o.cruise, this.hz);
    c.accel[row] = mmPerTick2(o.accel ?? 1, this.hz);
    c.decel[row] = mmPerTick2(o.decel ?? 2, this.hz);
    if (c.decel[row] === 0) throw new Error('Movers: braking must be positive');
    c.gap[row] = mm(o.gap ?? 2);
    c.tag[row] = o.tag ?? 0;
    if (this.extended) {
      const e = this.ext;
      e.front[row] = mm(o.front ?? (o.gap ?? 2) / 4);
      e.back[row] = mm(o.back ?? (o.gap ?? 2) / 4);
      e.half[row] = o.width !== undefined ? mm(o.width / 2) : this.defaultHalf;
    }
    this.place(row, o.path, mm(o.at ?? 0));
    c.speed[row] = Math.min(c.cruise[row]!, mmPerTick(o.speed ?? 0, this.hz));
    return id;
  }

  /** Moves an entity onto another path (no interpolation across the switch). An owned path it leaves is freed. */
  setPath(id: number, path: number, at = 0): void {
    const row = this.mustRow(id);
    const old = this.table.col.path[row]!;
    this.place(row, path, mm(at));
    if (old !== path) this.releaseIfOwned(old);
  }

  /** Adds a path owned by this entity (freed when it leaves it) and moves the entity onto it. */
  send(id: number, def: PathDef, at = 0): number {
    const path = this.paths.add(def, { owned: true });
    this.setPath(id, path, at);
    return path;
  }

  remove(id: number): void {
    const row = this.mustRow(id);
    const old = this.table.col.path[row]!;
    this.table.remove(id);
    this.releaseIfOwned(old);
  }

  /** State of one entity in app units. */
  info(id: number): { state: number; path: number; along: number; speed: number; tag: number } {
    const row = this.mustRow(id);
    const c = this.table.col;
    return { state: c.state[row]!, path: c.path[row]!, along: c.dist[row]! / 1000, speed: (c.speed[row]! * this.hz) / 1000, tag: c.tag[row]! };
  }

  /**
   * Ticks an entity has waited in a row for a zone, an area or an obstacle (0 when it moves freely or only follows the
   * one ahead). Extended modes only. A ring of queues that all wait on each other never clears by itself; the caller
   * can watch this and move one of them (`setPath`) to break it.
   */
  waited(id: number): number {
    this.requireExtended('waited');
    return this.ext.wait[this.mustRow(id)]!;
  }

  /** Where an entity is now (at the last tick, with its offset), metres. */
  position(id: number): [number, number] {
    const row = this.mustRow(id);
    const c = this.table.col;
    const pt: [number, number] = [0, 0];
    this.paths.pointAt(this.paths.get(c.path[row]!), c.dist[row]!, pt);
    if (this.features & F_AGENTS) {
      const e = this.ext;
      pt[0] += e.ox[row]! / 1000;
      pt[1] += e.oz[row]! / 1000;
    }
    return pt;
  }

  private mustRow(id: number): number {
    const row = this.table.rowOf(id);
    if (row < 0) throw new Error(`Movers: no entity ${id}`);
    return row;
  }

  private releaseIfOwned(path: number): void {
    if (!this.paths.has(path) || !this.paths.get(path).owned) return;
    const c = this.table.col;
    for (let r = 0; r < this.table.count; r++) if (c.path[r] === path) return;
    this.paths.release(path);
    this.cache.delete(path);
    this.interlock?.il.forget(this.interlock.side, path);
  }

  private place(row: number, pathId: number, at: number): void {
    const p = this.paths.get(pathId);
    const c = this.table.col;
    const d = p.loop ? ((at % p.length) + p.length) % p.length : Math.min(p.length, Math.max(0, at));
    c.path[row] = pathId;
    c.dist[row] = d;
    c.prev[row] = d;
    c.speed[row] = 0;
    c.dwell[row] = 0;
    c.state[row] = MOVER_STATE.moving;
    let seg = 0;
    while (seg + 1 < p.segments && d >= p.segStart[seg + 1]!) seg++;
    c.seg[row] = seg;
    // Stops at the starting point are behind the entity.
    let k = 0;
    while (k < p.stopAt.length && p.stopAt[k]! <= d) k++;
    c.stop[row] = k;
    if (this.extended) {
      const e = this.ext;
      e.wait[row] = 0;
      // The offset is kept across a path switch (an agent steps on from where it stood); `pox` follows it.
      e.pox[row] = e.ox[row]!;
      e.poz[row] = e.oz[row]!;
    }
  }

  // --- Obstacles, zones, known obstacles ---------------------------------------------------------------------------

  private requireExtended(what: string): void {
    if (!this.extended) throw new Error(`Movers: ${what} needs collision "static", "lanes" or "agents" (this set is "${this.collision}")`);
  }

  /** Adds a static obstacle (a capsule in metres) and returns its index. Entities stop before it. */
  addObstacle(o: Capsule): number {
    this.requireExtended('addObstacle');
    this.obstacles.push(mm(o.ax), mm(o.az), mm(o.bx), mm(o.bz), mm(o.radius));
    this.cache.clear();
    this.obstacleGrid = null;
    return this.obstacles.length / 5 - 1;
  }

  get obstacleCount(): number {
    return this.obstacles.length / 5;
  }

  /**
   * Stretches of a path that an entity of the default width cannot pass because of static obstacles, metres along
   * the path. Meant for build time: a path that is blocked is better not used at all, since an entity would stand
   * before the obstacle for ever and everybody behind it too.
   */
  blocked(path: number): { from: number; to: number }[] {
    const pc = this.pathCache(this.paths.get(path));
    return Array.from(pc.block0, (s, i) => ({ from: s / 1000, to: pc.block1[i]! / 1000 }));
  }

  /** Obstacles by grid cell: every cell a capsule (swollen by the default half width) touches lists its offset. */
  private obstacleCells(): Map<number, number[]> {
    if (this.obstacleGrid) return this.obstacleGrid;
    const grid = new Map<number, number[]>();
    const ob = this.obstacles;
    for (let k = 0; k < ob.length; k += 5) {
      const r = ob[k + 4]! + this.defaultHalf;
      for (let cx = Math.floor((Math.min(ob[k]!, ob[k + 2]!) - r) / OBSTACLE_CELL); cx <= Math.floor((Math.max(ob[k]!, ob[k + 2]!) + r) / OBSTACLE_CELL); cx++) {
        for (let cz = Math.floor((Math.min(ob[k + 1]!, ob[k + 3]!) - r) / OBSTACLE_CELL); cz <= Math.floor((Math.max(ob[k + 1]!, ob[k + 3]!) + r) / OBSTACLE_CELL); cz++) {
          const key = cellKey(cx, cz);
          const list = grid.get(key);
          if (list) list.push(k);
          else grid.set(key, [k]);
        }
      }
    }
    this.obstacleGrid = grid;
    return grid;
  }

  private pathCache(p: Path): PathCache {
    let pc = this.cache.get(p.id);
    if (pc) return pc;
    const b0: number[] = [];
    const b1: number[] = [];
    const ob = this.obstacles;
    if (ob.length > 0) {
      const grid = this.obstacleCells();
      const pt = this.point;
      let inside = false;
      for (let d = 0; d <= p.length; d += SWEEP_MM) {
        this.paths.pointAt(p, d, pt);
        const x = Math.round(pt[0] * 1000);
        const z = Math.round(pt[1] * 1000);
        let hit = false;
        for (const k of grid.get(cellKey(Math.floor(x / OBSTACLE_CELL), Math.floor(z / OBSTACLE_CELL))) ?? []) {
          const r = ob[k + 4]! + this.defaultHalf;
          if (capsuleDist2(x, z, ob[k]!, ob[k + 1]!, ob[k + 2]!, ob[k + 3]!) < r * r) {
            hit = true;
            break;
          }
        }
        if (hit && !inside) b0.push(d);
        if (!hit && inside) b1.push(d);
        inside = hit;
      }
      if (inside) b1.push(p.length);
    }
    pc = { block0: Int32Array.from(b0), block1: Int32Array.from(b1) };
    this.cache.set(p.id, pc);
    return pc;
  }

  /**
   * Builds the conflict zones of the `lanes` mode from the paths in the set now: where segments of different lanes
   * come closer than `clearance` metres, the stretches on both become one zone. Segments running side by side
   * (within about 18 degrees of parallel or antiparallel, e.g. the two directions of a street) only conflict closer
   * than `parallelClearance`. Returns the number of zones. Call it after adding the network's paths and before the
   * first tick; paths added later have no zones. Defaults 3 and 2 m (bodies about 1.8 m wide; a rigid body cuts the
   * inside of a corner, hence the margin).
   */
  buildZones(options: { clearance?: number; parallelClearance?: number } = {}): number {
    if ((this.features & F_ZONES) === 0) throw new Error('Movers: zones need collision "lanes"');
    const list: Path[] = [];
    for (let id = 1; list.length < this.paths.size; id++) if (this.paths.has(id)) list.push(this.paths.get(id));
    this.zones = buildZoneIntervals(list.filter((p) => !p.owned), mm(options.clearance ?? 3), mm(options.parallelClearance ?? 2));
    this.holder = new Float64Array(this.zones.count);
    return this.zones.count;
  }

  get zoneCount(): number {
    return this.zones.count;
  }

  /** Zone stretches of a path, metres along it. */
  zonesOf(path: number): { from: number; to: number; zone: number }[] {
    const z = this.zones.byPath.get(path);
    if (!z) return [];
    return Array.from(z.s0, (s, i) => ({ from: s / 1000, to: z.s1[i]! / 1000, zone: z.zone[i]! }));
  }

  /** Known moving obstacles (a replayed schedule). Not state: set it again after setting the simulation up anew. */
  setKnownObstacles(fn: KnownObstacles | null): void {
    this.requireExtended('setKnownObstacles');
    this.known = fn;
  }

  /** Body of an entity along its path: rear and front distance (mm), and half the width. For `Interlock`. */
  body(row: number): [number, number, number] {
    const c = this.table.col;
    if (!this.extended) return [c.dist[row]!, c.dist[row]!, this.defaultHalf];
    const e = this.ext;
    return [c.dist[row]! - e.back[row]!, c.dist[row]! + e.front[row]!, e.half[row]!];
  }

  // --- The system ----------------------------------------------------------------------------------------------------

  /** The system: one tick of movement. Register it with `sim.addSystem(name, movers.system)`. */
  readonly system = (sim: Simulation): void => {
    const t = this.table;
    const n = t.count;
    const c = t.col;
    if (this.follow.length < n) this.follow = new Int32Array(Math.max(n, this.follow.length * 2));
    if (this.features & F_FOLLOW) this.computeFollow();
    else this.follow.fill(NO_LIMIT, 0, n);
    if (this.extended) this.limits(sim);
    for (let r = 0; r < n; r++) {
      c.prev[r] = c.dist[r]!;
      const state = c.state[r]!;
      if (state === MOVER_STATE.done) {
        c.speed[r] = 0;
        continue;
      }
      const p = this.paths.get(c.path[r]!);
      if (state === MOVER_STATE.dwelling) {
        c.dwell[r] = c.dwell[r]! - 1;
        if (c.dwell[r]! <= 0) {
          c.state[r] = MOVER_STATE.moving;
          sim.events.post('move.depart', t.idAt(r), { path: p.id, stop: c.stop[r]! });
          c.stop[r] = c.stop[r]! + 1;
        }
        continue;
      }
      this.move(sim, r, p);
    }
  };

  private move(sim: Simulation, r: number, p: Path): void {
    const c = this.table.col;
    const dist = c.dist[r]!;
    const decel = c.decel[r]!;
    const len = p.length;
    const nStops = p.stopAt.length;
    const k = c.stop[r]!;
    // Where the entity must stand still next: a stop, or the end of an open path.
    let hard = Infinity;
    if (k < nStops) hard = p.stopAt[k]! - dist;
    else if (p.loop && nStops > 0) hard = p.stopAt[0]! + len - dist;
    else if (!p.loop) hard = len - dist;

    let target = c.cruise[r]!;
    const seg = c.seg[r]!;
    if (p.segLimit[seg]! > 0) target = Math.min(target, p.segLimit[seg]!);
    // Lower limits ahead, within the distance needed to brake from the current target.
    const horizon = stoppingDistance(target, decel) + target;
    for (let i = 1; i < p.segments; i++) {
      let j = seg + i;
      let start: number;
      if (j < p.segments) start = p.segStart[j]!;
      else if (p.loop) {
        j -= p.segments;
        start = p.segStart[j]! + len;
      } else break;
      const ahead = start - dist;
      if (ahead > horizon) break;
      const lim = p.segLimit[j]!;
      if (lim > 0) target = Math.min(target, approachSpeed(lim, ahead, decel));
    }
    if (hard !== Infinity) target = Math.min(target, brakeSpeed(hard, decel));
    const free = this.follow[r]!;
    if (free < NO_LIMIT) target = Math.min(target, brakeSpeed(free, decel));

    const v = c.speed[r]!;
    let nv = Math.min(target, v + c.accel[r]!);
    nv = Math.max(nv, v - decel);
    nv = Math.max(0, Math.min(nv, hard, free));
    let d = dist + nv;
    c.speed[r] = nv;
    const arrived = hard !== Infinity && nv === hard;

    let stop = k;
    if (p.loop && d >= len) {
      d -= len;
      c.prev[r] = c.prev[r]! - len;
      if (stop >= nStops) stop = 0;
      c.seg[r] = 0;
    }
    let s = c.seg[r]!;
    while (s + 1 < p.segments && d >= p.segStart[s + 1]!) s++;
    c.seg[r] = s;
    c.dist[r] = d;
    c.stop[r] = stop;
    if (!arrived) return;
    c.speed[r] = 0;
    const id = this.table.idAt(r);
    if (stop < nStops) {
      c.state[r] = MOVER_STATE.dwelling;
      c.dwell[r] = p.stopDwell[stop]!;
      sim.events.post('move.arrive', id, { path: p.id, stop });
    } else {
      c.state[r] = MOVER_STATE.done;
      sim.events.post('move.end', id, { path: p.id });
    }
  }

  /** Free distance (mm) each entity may cover before it gets closer than its gap to the entity ahead on its lane. */
  private computeFollow(): void {
    const t = this.table;
    const n = t.count;
    const c = t.col;
    const lane = new Float64Array(n);
    if (this.lanePos.length < n) this.lanePos = new Int32Array(Math.max(n, this.lanePos.length * 2));
    const pos = this.lanePos;
    const order = this.order;
    order.length = 0;
    for (let r = 0; r < n; r++) {
      const p = this.paths.get(c.path[r]!);
      const s = c.seg[r]!;
      lane[r] = p.segLane[s]!;
      pos[r] = p.segOrigin[s]! + c.dist[r]! - p.segStart[s]!;
      order.push(r);
    }
    // Sorted by lane, then position, then id: a total order that does not depend on row order.
    order.sort((a, b) => lane[a]! - lane[b]! || pos[a]! - pos[b]! || t.idAt(a) - t.idAt(b));
    const firstOnLane = new Map<number, number>();
    for (let i = n - 1; i >= 0; i--) firstOnLane.set(lane[order[i]!]!, i);
    if (this.extended) {
      this.laneRows.clear();
      for (let i = 0; i < n; i++) {
        const r = order[i]!;
        const l = lane[r]!;
        const list = this.laneRows.get(l);
        if (list) list.push(r);
        else this.laneRows.set(l, [r]);
      }
    }
    for (let i = 0; i < n; i++) {
      const r = order[i]!;
      let gapMm = Infinity;
      const next = order[i + 1];
      if (next !== undefined && lane[next] === lane[r]) gapMm = pos[next]! - pos[r]!;
      else {
        // Nobody ahead on this lane: look at the start of the next segment's lane.
        const p = this.paths.get(c.path[r]!);
        const s = c.seg[r]!;
        const ns = s + 1 < p.segments ? s + 1 : p.loop ? 0 : -1;
        if (ns >= 0) {
          const j = firstOnLane.get(p.segLane[ns]!);
          if (j !== undefined && order[j] !== r) gapMm = (s + 1 < p.segments ? p.segStart[s + 1]! : p.length) - c.dist[r]! + pos[order[j]!]! - p.segOrigin[ns]!;
        }
      }
      this.follow[r] = gapMm === Infinity ? NO_LIMIT : Math.max(0, gapMm - c.gap[r]!);
    }
  }

  /** Is anybody but `self` anchored on `lane` between `from` and `to` (mm from the segment start)? */
  private laneTaken(lane: number, from: number, to: number, self: number): boolean {
    const rows = this.laneRows.get(lane);
    if (!rows) return false;
    const pos = this.lanePos;
    for (const r of rows) {
      if (r === self) continue;
      const q = pos[r]!;
      if (q >= from && q <= to) return true;
      if (q > to) break;
    }
    return false;
  }

  /** Limits of the extended modes, folded into `follow`: obstacles, known obstacles, zones, areas, agents. */
  private limits(sim: Simulation): void {
    const n = this.table.count;
    const c = this.table.col;
    const e = this.ext;
    if (this.features & F_AGENTS) this.agents();
    // Known moving obstacles of this tick, quantised to mm.
    let known: Int32Array | null = null;
    if (this.known) {
      const k = this.known(sim.tick);
      if (k.length > 0) known = Int32Array.from(k, (v) => Math.round(v * 1000));
    }
    const zoneReq = this.features & F_ZONES && this.zones.count > 0 ? this.zoneRequests(known) : null;
    const il = this.interlock;
    for (let r = 0; r < n; r++) {
      if (c.state[r] !== MOVER_STATE.moving) continue;
      const p = this.paths.get(c.path[r]!);
      const dist = c.dist[r]!;
      const front = dist + e.front[r]!;
      const reach = stoppingDistance(Math.max(c.cruise[r]!, c.speed[r]!), c.decel[r]!) + c.cruise[r]! + HOLD_MM;
      let free = this.follow[r]!;
      // Static obstacles: the first blocked stretch ahead that the body is not in already.
      if (this.obstacles.length > 0) {
        const pc = this.pathCache(p);
        for (let i = 0; i < pc.block0.length; i++) {
          let s0 = pc.block0[i]!;
          let s1 = pc.block1[i]!;
          if (p.loop && s1 < dist - e.back[r]!) {
            s0 += p.length;
            s1 += p.length;
          }
          if (s1 < dist - e.back[r]!) continue;
          if (s0 <= front) continue;
          free = Math.min(free, Math.max(0, s0 - front - HOLD_MM));
          break;
        }
      }
      if (known) {
        // Inside a held zone the entity clears it (it entered only with the way clear); known obstacles count after.
        const from = zoneReq ? Math.max(front, zoneReq.clearTo[r]!) : front;
        const hit = this.sweep(p, r, from, front + reach, known);
        if (hit >= 0) free = Math.min(free, Math.max(0, hit - front - HOLD_MM));
      }
      if (zoneReq) {
        const z = zoneReq.limit[r]!;
        if (z < NO_LIMIT) free = Math.min(free, z);
      }
      if (il) {
        const a = il.il.limitFor(this, il.side, r, p, reach);
        if (a < NO_LIMIT) free = Math.min(free, a);
      }
      if (free < this.follow[r]! && free < reach) e.wait[r] = e.wait[r]! + 1;
      else e.wait[r] = 0;
      this.follow[r] = free;
    }
  }

  /**
   * First distance along the path in [from, to] (mm) where the body of row `r` would touch one of the capsules, or
   * -1. Capsules the body is in already are left out, so an entity inside one can leave it.
   */
  private sweep(p: Path, r: number, from: number, to: number, caps: Int32Array): number {
    const half = this.ext.half[r]!;
    const pt = this.point;
    const c = this.table.col;
    this.paths.pointAt(p, c.dist[r]!, pt);
    const x0 = Math.round(pt[0] * 1000);
    const z0 = Math.round(pt[1] * 1000);
    const span = to - c.dist[r]! + 1000;
    let best = -1;
    for (let k = 0; k < caps.length; k += 5) {
      const rad = caps[k + 4]! + half;
      // Far away: skip without sampling.
      const bx0 = Math.min(caps[k]!, caps[k + 2]!) - rad - span;
      const bx1 = Math.max(caps[k]!, caps[k + 2]!) + rad + span;
      const bz0 = Math.min(caps[k + 1]!, caps[k + 3]!) - rad - span;
      const bz1 = Math.max(caps[k + 1]!, caps[k + 3]!) + rad + span;
      if (x0 < bx0 || x0 > bx1 || z0 < bz0 || z0 > bz1) continue;
      const r2 = rad * rad;
      // Already inside: free to leave.
      if (capsuleDist2(x0, z0, caps[k]!, caps[k + 1]!, caps[k + 2]!, caps[k + 3]!) < r2) continue;
      const limit = best >= 0 ? best : to;
      for (let d = from; d <= limit; d += SWEEP_MM) {
        this.paths.pointAt(p, d, pt);
        if (capsuleDist2(Math.round(pt[0] * 1000), Math.round(pt[1] * 1000), caps[k]!, caps[k + 1]!, caps[k + 2]!, caps[k + 3]!) < r2) {
          best = d;
          break;
        }
      }
    }
    return best;
  }

  /**
   * Zones: who holds what, and how far everybody else may go. A holder keeps its zone while the zone's stretch is
   * still ahead or under its body; then the zone is free. A free zone goes to the requester that has waited longest
   * (then the lowest id), and only when the lane behind the zone has room for it (it must not stop inside).
   */
  private zoneRequests(known: Int32Array | null): { limit: Int32Array; clearTo: Int32Array } {
    const n = this.table.count;
    const c = this.table.col;
    const e = this.ext;
    const t = this.table;
    const limit = new Int32Array(n).fill(NO_LIMIT);
    // End of the held stretch under each body (mm along its path), or -1.
    const clearTo = new Int32Array(n).fill(-1);
    const holder = this.holder;
    const wants = new Uint8Array(this.zones.count);
    // Per row: the first zone stretch it is in or approaching within its reach.
    const reqZone = new Int32Array(n).fill(-1);
    const reqAt = new Int32Array(n);
    const reqEnd = new Int32Array(n);
    // Per zone: one that is in it without holding it (it followed the holder in), lowest id.
    const inside = new Float64Array(this.zones.count);
    for (let r = 0; r < n; r++) {
      const zi = this.zones.byPath.get(c.path[r]!);
      if (!zi || c.state[r] === MOVER_STATE.done) continue;
      const p = this.paths.get(c.path[r]!);
      const dist = c.dist[r]!;
      const back = dist - e.back[r]!;
      const front = dist + e.front[r]!;
      const reach = stoppingDistance(Math.max(c.cruise[r]!, c.speed[r]!), c.decel[r]!) + c.cruise[r]! + HOLD_MM;
      const id = t.idAt(r);
      const m = zi.s0.length;
      // Stretches under the body: their zones are held (taken if free, kept if held by this row). Then the first
      // stretch ahead within reach is requested.
      let done = false;
      for (let lap = 0; lap < (p.loop ? 2 : 1) && !done; lap++) {
        const off = lap * p.length;
        for (let i = 0; i < m; i++) {
          const s0 = zi.s0[i]! + off;
          const s1 = zi.s1[i]! + off;
          if (s1 < back) continue;
          const z = zi.zone[i]!;
          if (s0 <= front) {
            wants[z] = 1;
            if (holder[z] === 0) holder[z] = id;
            if (holder[z] === id) clearTo[r] = Math.max(clearTo[r]!, s1);
            else if (inside[z] === 0 || id < inside[z]!) inside[z] = id;
            continue;
          }
          done = true;
          if (s0 - front > reach) break;
          // Only the first in its queue asks: somebody between it and the zone on its lane goes first (a zone held by
          // one stuck behind a waiting one would block both).
          if (this.follow[r]! < s0 - front - HOLD_MM) break;
          reqZone[r] = z;
          reqAt[r] = s0 - front;
          reqEnd[r] = s1;
          break;
        }
      }
      if (reqZone[r]! >= 0 && holder[reqZone[r]!] === id) wants[reqZone[r]!] = 1;
    }
    // Free zones whose holder neither is in them nor heads for them.
    for (let z = 0; z < holder.length; z++) {
      const h = holder[z]!;
      if (h !== 0 && (!wants[z] || t.rowOf(h) < 0)) holder[z] = 0;
      // A zone the holder has left passes to one still in it before anybody outside may ask.
      if (holder[z] === 0 && inside[z] !== 0) holder[z] = inside[z]!;
    }
    // Grants: requesters of free zones, longest wait first, then lowest id.
    const req: number[] = [];
    for (let r = 0; r < n; r++) if (reqZone[r]! >= 0 && holder[reqZone[r]!] === 0) req.push(r);
    req.sort((a, b) => e.wait[b]! - e.wait[a]! || t.idAt(a) - t.idAt(b));
    for (const r of req) {
      const z = reqZone[r]!;
      if (holder[z] !== 0) continue;
      if (!this.exitFree(r, reqEnd[r]!)) continue;
      // Known moving obstacles: enter only when the whole stretch can be cleared before they come.
      if (known && this.sweep(this.paths.get(c.path[r]!), r, c.dist[r]! + e.front[r]!, reqEnd[r]! + e.back[r]!, known) >= 0) continue;
      holder[z] = t.idAt(r);
    }
    for (let r = 0; r < n; r++) {
      const z = reqZone[r]!;
      if (z >= 0 && holder[z] !== t.idAt(r)) limit[r] = Math.max(0, reqAt[r]! - HOLD_MM);
    }
    return { limit, clearTo };
  }

  /** Room on the lane right behind a zone stretch ending at `s1` (mm along the row's path) for the whole body. */
  private exitFree(r: number, s1: number): boolean {
    const c = this.table.col;
    const e = this.ext;
    const p = this.paths.get(c.path[r]!);
    let at = s1;
    if (p.loop) at = ((at % p.length) + p.length) % p.length;
    else if (at >= p.length) return true;
    let seg = 0;
    while (seg + 1 < p.segments && at >= p.segStart[seg + 1]!) seg++;
    const base = p.segOrigin[seg]! + at - p.segStart[seg]!;
    const from = base - e.back[r]!;
    const to = base + c.gap[r]! + e.front[r]!;
    return !this.laneTaken(p.segLane[seg]!, from, to, r);
  }

  /**
   * Agents: local avoidance on integer positions. Neighbours come from a spatial hash of 2 m cells; every decision
   * uses the positions at the start of the tick (a Jacobi step), so the result does not depend on the row order.
   */
  private agents(): void {
    const n = this.table.count;
    const c = this.table.col;
    const e = this.ext;
    const X = new Int32Array(n);
    const Z = new Int32Array(n);
    const DX = new Int32Array(n);
    const DZ = new Int32Array(n);
    const pt = this.point;
    const pt2 = this.point2;
    const cells = new Map<number, number[]>();
    for (let r = 0; r < n; r++) {
      const p = this.paths.get(c.path[r]!);
      const d = c.dist[r]!;
      this.paths.pointAt(p, d, pt);
      X[r] = Math.round(pt[0] * 1000) + e.ox[r]!;
      Z[r] = Math.round(pt[1] * 1000) + e.oz[r]!;
      this.paths.pointAt(p, d - 400, pt);
      this.paths.pointAt(p, d + 400, pt2);
      const dx = pt2[0] - pt[0];
      const dz = pt2[1] - pt[1];
      const l = Math.sqrt(dx * dx + dz * dz);
      DX[r] = l > 1e-6 ? Math.round((dx / l) * 1024) : 0;
      DZ[r] = l > 1e-6 ? Math.round((dz / l) * 1024) : 1024;
      const key = cellKey(Math.floor(X[r]! / AGENT_CELL), Math.floor(Z[r]! / AGENT_CELL));
      const list = cells.get(key);
      if (list) list.push(r);
      else cells.set(key, [r]);
    }
    const side = Math.max(1, Math.round(AGENT_SIDE_MM_S / this.hz));
    const patience = AGENT_PATIENCE_S * this.hz;
    const nox = new Int32Array(n);
    const noz = new Int32Array(n);
    for (let r = 0; r < n; r++) {
      const standing = c.state[r] !== MOVER_STATE.moving;
      const cx = Math.floor(X[r]! / AGENT_CELL);
      const cz = Math.floor(Z[r]! / AGENT_CELL);
      // Right-hand normal of the walking direction: (−dz, dx).
      const rx = -DZ[r]!;
      const rz = DX[r]!;
      // Votes for a side to step to (summed, so the neighbour order does not matter): + right, − left.
      let vote = 0;
      let free = NO_LIMIT;
      let pushX = 0;
      let pushZ = 0;
      // Close to the end of an open path, standing ones do not stop it: it arrives and is pushed into the group.
      const pr = this.paths.get(c.path[r]!);
      const arriving = !pr.loop && pr.length - c.dist[r]! < AGENT_STAND_RADIUS;
      if (!standing) e.stuck[r] = c.speed[r] === 0 ? e.stuck[r]! + 1 : 0;
      const patient = e.stuck[r]! < patience;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const list = cells.get(cellKey(gx, gz));
          if (!list) continue;
          for (const j of list) {
            if (j === r) continue;
            const qx = X[j]! - X[r]!;
            const qz = Z[j]! - Z[r]!;
            const d2 = qx * qx + qz * qz;
            if (d2 > AGENT_LOOK * AGENT_LOOK) continue;
            // Too close: pushed apart (standing: both ways; walking: sideways only, below).
            if (d2 < AGENT_STAND_GAP * AGENT_STAND_GAP) {
              const d = Math.max(1, isqrt(d2));
              const k = AGENT_STAND_GAP - d;
              if (d2 === 0) {
                // Same point: the lower id stays, the other steps to its right.
                if (this.table.idAt(r) > this.table.idAt(j)) {
                  pushX += (rx * k) >> 11;
                  pushZ += (rz * k) >> 11;
                }
              } else {
                pushX -= Math.trunc((qx * k) / (2 * d));
                pushZ -= Math.trunc((qz * k) / (2 * d));
              }
            }
            if (standing) continue;
            const f = (qx * DX[r]! + qz * DZ[r]!) >> 10;
            const s = (qx * rx + qz * rz) >> 10;
            if (f <= 0 || f > AGENT_LOOK || Math.abs(s) > AGENT_CORRIDOR) continue;
            // Same direction: within about 30 degrees (cos 30° · 1024²).
            const same = DX[r]! * DX[j]! + DZ[r]! * DZ[j]! > 908000;
            const still = c.state[j] !== MOVER_STATE.moving;
            if (still) {
              // Standing: pass on the side away from it, slow down when close.
              vote += s > 0 ? -2 : 2;
              if (f < 700 && Math.abs(s) < AGENT_BLOCK && !arriving && patient) free = Math.min(free, Math.max(0, f - 450));
            } else if (!same) {
              // Oncoming or across: both keep to their right; only the higher id waits, so waits cannot go in a
              // circle (the lowest id of any group always walks on).
              vote += 2;
              if (f < 700 && Math.abs(s) < AGENT_BLOCK && patient && this.table.idAt(j) < this.table.idAt(r)) free = Math.min(free, Math.max(0, f - 450));
            } else {
              // Same direction: keep the gap; overtake on the left when the one ahead is slower.
              // When each is ahead of the other (bent ways), only the higher id waits.
              const fj = -(qx * DX[j]! + qz * DZ[j]!) >> 10;
              const mutual = fj > 0 && this.table.idAt(j) > this.table.idAt(r);
              if (Math.abs(s) < AGENT_BLOCK && !mutual) free = Math.min(free, Math.max(0, f - c.gap[r]!));
              if (c.speed[j]! < c.cruise[r]!) vote -= 1;
            }
          }
        }
      }
      if (standing) {
        // Standing: pushed apart, kept within reach of its point.
        let ox = e.ox[r]! + pushX;
        let oz = e.oz[r]! + pushZ;
        const l2 = ox * ox + oz * oz;
        if (l2 > AGENT_STAND_RADIUS * AGENT_STAND_RADIUS) {
          const l = isqrt(l2);
          ox = Math.trunc((ox * AGENT_STAND_RADIUS) / l);
          oz = Math.trunc((oz * AGENT_STAND_RADIUS) / l);
        }
        nox[r] = ox;
        noz[r] = oz;
        continue;
      }
      // Walking: the offset drifts toward the wanted side (or back to the path), at a walking pace sideways.
      const cur = (e.ox[r]! * rx + e.oz[r]! * rz) >> 10;
      const lateral = vote === 0 ? 0 : vote > 0 ? AGENT_STEP : -AGENT_STEP;
      const pushS = (pushX * rx + pushZ * rz) >> 10;
      let next = cur + Math.max(-side, Math.min(side, lateral - cur)) + Math.max(-side, Math.min(side, pushS));
      next = Math.max(-900, Math.min(900, next));
      nox[r] = (rx * next) >> 10;
      noz[r] = (rz * next) >> 10;
      if (free < this.follow[r]!) this.follow[r] = free;
    }
    for (let r = 0; r < n; r++) {
      e.pox[r] = e.ox[r]!;
      e.poz[r] = e.oz[r]!;
      e.ox[r] = nox[r]!;
      e.oz[r] = noz[r]!;
    }
  }

  // --- Extraction ---------------------------------------------------------------------------------------------------

  /**
   * Extraction: writes every entity's interpolated transform into `out` (`TRANSFORM_STRIDE` floats each, in row
   * order; `table.ids` gives the id of each row) and returns the count. `alpha` is the fraction between the last two
   * ticks. This is the only way the image reads movement; it does not change the simulation.
   */
  extract(alpha: number, out: Float32Array): number {
    const t = this.table;
    const n = t.count;
    const c = t.col;
    if (out.length < n * TRANSFORM_STRIDE) throw new Error(`Movers.extract: output holds ${out.length / TRANSFORM_STRIDE} entities, there are ${n}`);
    const a = this.point;
    const b = this.point2;
    for (let r = 0; r < n; r++) {
      const p = this.paths.get(c.path[r]!);
      const prev = c.prev[r]!;
      let d = prev + (c.dist[r]! - prev) * alpha;
      if (d < 0) d += p.length;
      this.paths.pointAt(p, d, a);
      const o = r * TRANSFORM_STRIDE;
      out[o] = a[0] + this.offsetX(r, alpha);
      out[o + 1] = a[1] + this.offsetZ(r, alpha);
      this.paths.pointAt(p, d - LOOK_MM, a);
      this.paths.pointAt(p, d + LOOK_MM, b);
      let dx = b[0] - a[0];
      let dz = b[1] - a[1];
      const l = Math.sqrt(dx * dx + dz * dz);
      if (l > 1e-6) {
        dx /= l;
        dz /= l;
      } else {
        dx = 0;
        dz = -1;
      }
      out[o + 2] = dx;
      out[o + 3] = dz;
      out[o + 4] = d / 1000;
      out[o + 5] = ((c.dist[r]! - prev) * this.hz) / 1000;
    }
    return n;
  }

  private offsetX(r: number, alpha: number): number {
    if ((this.features & F_AGENTS) === 0) return 0;
    const e = this.ext;
    return (e.pox[r]! + (e.ox[r]! - e.pox[r]!) * alpha) / 1000;
  }

  private offsetZ(r: number, alpha: number): number {
    if ((this.features & F_AGENTS) === 0) return 0;
    const e = this.ext;
    return (e.poz[r]! + (e.oz[r]! - e.poz[r]!) * alpha) / 1000;
  }

  /**
   * Extraction with the turn rate and state as well (`POSE_STRIDE` floats per entity, row order). The turn rate is
   * the path curvature around the position times the interpolated speed. Does not change the simulation.
   */
  extractPose(alpha: number, out: Float32Array): number {
    const t = this.table;
    const n = t.count;
    const c = t.col;
    if (out.length < n * POSE_STRIDE) throw new Error(`Movers.extractPose: output holds ${out.length / POSE_STRIDE} entities, there are ${n}`);
    const f = this.frame;
    for (let r = 0; r < n; r++) {
      const p = this.paths.get(c.path[r]!);
      const prev = c.prev[r]!;
      let d = prev + (c.dist[r]! - prev) * alpha;
      if (d < 0) d += p.length;
      this.paths.frameAt(p, d, LOOK_MM, f);
      const o = r * POSE_STRIDE;
      const speed = ((c.dist[r]! - prev) * this.hz) / 1000;
      out[o] = f[0]! + this.offsetX(r, alpha);
      out[o + 1] = f[1]! + this.offsetZ(r, alpha);
      out[o + 2] = f[2]!;
      out[o + 3] = f[3]!;
      out[o + 4] = d / 1000;
      out[o + 5] = speed;
      out[o + 6] = f[4]! * speed;
      out[o + 7] = c.state[r]!;
    }
    return n;
  }

  save(w: ByteWriter): void {
    this.table.save(w);
    this.paths.save(w);
    if (!this.extended) return;
    w.u32(this.obstacles.length);
    w.bytes(Int32Array.from(this.obstacles));
    w.u32(this.holder.length);
    w.bytes(this.holder);
  }

  load(r: ByteReader): void {
    this.table.load(r);
    this.paths.load(r);
    this.cache.clear();
    // Path ids of the snapshot can name other paths than the ones cached by an interlock.
    this.interlock?.il.forgetAll(this.interlock.side);
    if (!this.extended) return;
    const ob = new Int32Array(r.u32());
    r.into(ob);
    this.obstacles = Array.from(ob);
    this.obstacleGrid = null;
    const h = new Float64Array(r.u32());
    r.into(h);
    this.holder = h;
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
}

/** Squared distance from a point to the segment a–b (integer mm in, float out; IEEE operations only). */
export function capsuleDist2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x;
  const pz = az + dz * t - z;
  return px * px + pz * pz;
}
