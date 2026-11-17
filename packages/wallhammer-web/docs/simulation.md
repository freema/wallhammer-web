# Simulation

`wallhammer-web/sim` is a deterministic fixed-step simulation. It runs in plain Node and in the browser. The image never writes into it; it reads it only through extraction.

## Determinism tier

- Time is an integer tick. The default rate is 20 Hz.
- The only input is a log of tick-stamped commands.
- Lengths are integer millimetres, speeds whole millimetres per tick. Values entering the simulation are quantised at the boundary (`mm`, `mmPerTick`).
- `sim` may not use `Math.random`, `Date`, `performance.now` or transcendental `Math` functions. `pnpm check:layers` enforces this (`sim-nondeterministic`). Input built with `Math.cos` outside the simulation is fine because it is quantised on entry.
- `sim` imports only `base`, `core` and `gen-core` (`sim-headless`).

So the same seed and the same commands give the same `stateHash()` on every machine.

## `Simulation`

<!-- check: wrap -->
```ts
import { EntityTable, Simulation } from 'wallhammer-web/sim';

const sim = new Simulation({ seed: 'demo-1' }); // hz 20, maxTicksPerFrame 8, checkpoint every 200 ticks
const counters = new EntityTable('counters', { value: 'i32' });
sim.addState(counters); // everything in addState is saved, restored and hashed

sim.onCommand('add', (cmd, s) => {
  const id = counters.create();
  counters.col.value[counters.rowOf(id)] = Number(cmd.data.amount ?? 1);
  s.events.post('counter.added', id);
});
sim.addSystem('grow', (s) => {
  for (let r = 0; r < counters.count; r++) counters.col.value[r]! += s.random('grow', counters.idAt(r)) % 3;
});

sim.command('add', { amount: 5 }); // applies before the systems of the next tick
sim.step(100);
const hash = sim.stateHash();
sim.seek(40); // restores a checkpoint and replays the command log
```

Members:

| Member | Meaning |
| --- | --- |
| `tick`, `time`, `alpha` | Current tick, simulated seconds, fraction between the last two ticks (for interpolation). |
| `addSystem(name, fn)` | A system is a plain function, run every tick in registration order. |
| `addState(state)` | Something with `name`, `save(writer)` and `load(reader)`. `EntityTable`, `NavGraph` and `Movers` qualify. |
| `onCommand(kind, handler)`, `command(kind, data, tick?)` | Commands. A command for a past tick is an error. `data` is a flat record of numbers, strings and booleans. |
| `random(stream, ...keys)` | A uint32 from the named stream, keyed by the current tick and the keys. |
| `events` | `EventQueue`: `post`, `thisTick`, `lastTick`, `drain`. |
| `step(n)`, `advance(realSeconds)` | Run ticks. `advance` runs at most `maxTicksPerFrame` per call; beyond that simulated time slows down. |
| `pause`, `play`, `setSpeed`, `stepOnce`, `paused`, `speed`, `animating` | Playback. |
| `seek(tick)` | Jump to a tick: restore the nearest checkpoint, replay commands. |
| `snapshot()`, `restore(bytes)`, `stateHash()` | Save, load, hash. |
| `rebase(snapshot?)` | Restore a snapshot (or keep the state) and make it tick 0 with an empty command log: setting the world up anew. |
| `onTick`, `onChange` | Listeners. |

## `EntityTable`

Dense typed columns. Column types: `i32`, `u32`, `i16`, `u8`, `f64`.

- `create()` returns a stable id: namespace · 2³² + serial.
- `rowOf(id)`, `idAt(row)`, `has(id)`, `count`, `col.<name>[row]`, `ids`.
- `remove(id)` swaps the last row into the gap. Row order is not stable across removals; ids are.

## Navigation and movement

- `NavGraph(name, { nodes: [x, z, …], edges: [{ from, to, cost?, speed?, both? }] })`. `findEdge`, `findPath(from, to)` (A* with a cache), `path(edges, { loop, rightOffset, stops })` turns edges into a `PathDef`. `setCost` and `setBlocked` change the graph.
- `PathSet` holds `PathDef`s (`points`, `loop?`, `speeds?`, `lanes?`, `stops`). `lanes` gives each segment a lane id: segments of different paths with the same lane id are one lane (the same street direction driven by several loops).
- `Movers(name, { hz, collision, width })` moves entities along paths: acceleration, cruising, braking for lower limits ahead, dwelling at stops.
- Movers post `move.arrive`, `move.depart` and `move.end` events.
- `movers.extract(alpha, out)` writes `TRANSFORM_STRIDE` (6) floats per entity in row order; `extractPose(alpha, out)` writes `POSE_STRIDE` (8): the same six, the turn rate and the state. These are the only reads of movement for the image.

`examples/minimal-3d/src/life.ts` is a complete example: a graph, a procession that loops, wanderers that pick A* routes, and a `call` command.

## Collision modes

`collision` picks what an entity respects. Everything is decided from the state at the start of the tick, in integer millimetres, so the order of rows never matters.

| Mode | What it does |
| --- | --- |
| `none` | Nothing. |
| `follow` | Keeps `gap` to the entity ahead on the same lane. |
| `static` | Stops before static obstacles (`addObstacle(capsule)`) on its path. |
| `lanes` | `follow` and `static`, plus conflict zones where lanes cross or merge, known moving obstacles and shared areas. For vehicles. |
| `agents` | Local avoidance in a crowd (side steps, standing groups pushed apart, patience against gridlock), static and known obstacles, shared areas. For people. |

The modes other than `none` and `follow` are the extended ones: they add columns (`front`, `back`, `half`, offsets, `wait`) and accept `front`, `back` and `width` on `spawn`.

**Zones (`lanes`).** `buildZones({ clearance, parallelClearance })` runs once after all paths are added. Where segments of different lanes come closer than `clearance` (3 m), the stretches on both become one zone; side-by-side segments only conflict closer than `parallelClearance` (2 m). A zone has one holder at a time. An entity takes a zone it is in, asks for the first zone ahead within its stopping reach when it heads its queue, and gets it when the zone is free, the lane behind the zone has room for its whole body and no known obstacle will be in the way. When a holder leaves a zone that another entity followed it into, that one holds it next. `zonesOf(path)` lists a path's stretches. `blocked(path)` lists the stretches of a path that static obstacles close; leave such a path out instead of letting entities wait there forever.

**Known obstacles.** `setKnownObstacles((tick) => capsules)` gives moving obstacles that do not take part in the simulation (a replayed schedule). It must be a pure function of the tick. Entities do not enter a capsule; one already inside is free to leave.

**Gridlock.** Zones prevent collisions, not rings: queues on loops that share a few junctions can close into a circle where every head waits for room the next one holds. `waited(id)` counts the ticks an entity has waited for a zone, an area or an obstacle (it stays 0 while it only follows). An app can watch it and move a long waiter on (`setPath(id, path, at)`), as the campus app does after 45 s. Fewer entities per junction is the real remedy.

<!-- check: wrap -->
```ts
import { Movers, NavGraph, Simulation } from 'wallhammer-web/sim';

const hz = 10;
const sim = new Simulation({ seed: 'lanes-demo', hz });
const nav = new NavGraph('streets', { nodes: [0, 0, 80, 0, 80, 80, 0, 80], edges: [{ from: 0, to: 1, both: true }, { from: 1, to: 2, both: true }, { from: 2, to: 3, both: true }, { from: 3, to: 0, both: true }] });
const vehicles = new Movers('vehicles', { hz, collision: 'lanes', width: 1.8 });
sim.addState(vehicles);
const route = [nav.findEdge(0, 1), nav.findEdge(1, 2), nav.findEdge(2, 3), nav.findEdge(3, 0)];
const loop = vehicles.paths.add(nav.path(route, { loop: true, rightOffset: 1.7 }));
vehicles.addObstacle({ ax: 40, az: 1, bx: 44, bz: 1, radius: 0.9 });
if (vehicles.blocked(loop).length === 0) {
  for (let i = 0; i < 3; i++) vehicles.spawn({ path: loop, at: i * 90, cruise: 9, gap: 8, front: 3.5, back: 1 });
}
vehicles.buildZones();
sim.addSystem('vehicles', vehicles.system);
sim.step(600);
```

## Shared areas

`Interlock(name, { areas, approach })` lets two mover sets share places where their paths cross: each area is a capsule with a priority side. Attach the sets (`attach(people, 0)`, `attach(vehicles, 1)`) and register `interlock.system` before both sets' systems. The yielding side does not enter while the priority side is on the area, close before it or can no longer stop; the priority side does not enter while a committed yielding entity is there. Nobody waits for a waiting entity of the other side, so the two sides cannot lock each other. A zebra gives people priority; a plain crossing point gives it to vehicles.

## Agendas and states

`Agendas(name, { movers, nav, places, origin, spawn, onAppear, onArrive })` drives entities by a list of activities: a place, a time and a stay. The system routes each trip through the graph, hands it to the mover set, waits for the arrival and the stay, and goes on. Places are graph nodes with an optional spot off the graph (`x`, `z`) and `inside` (staying hides the entity: its mover is removed, so only people out of doors cost anything).

- The agenda clock is seconds; tick 0 is `origin`. `setOrigin(s)` moves it before the first tick.
- The first activity is where the entity appears. A trip that should have begun before tick 0 starts at the distance walked by now, so a world set up at any time of day looks plausible at once.
- `arrive: true` on an activity means "be there by `at`"; the trip starts the route's walking time earlier.
- `mode` and `tag` are free integers for the app.
- Events: `agenda.appear`, `agenda.arrive`, `agenda.leave`, `agenda.done`, `agenda.unreachable`.

The states are a `StateMachine` with four built in: `before`, `stay`, `travel`, `done`. An app defines its own with `agendas.states.define(name, { enter, update })`; `update` returns the next state's id or nothing. It switches into them from `onAppear` and `onArrive`. Inside an `update` these helpers act on the entity: `show`, `hide`, `walkTo`, `stayUntil`, `leave`, `finish`, `arriveNext` (carried to the next activity without a trip: a ride, a lift), and `activity`, `nextActivity`, `standing`, `timer`, `data`. `now` is the tick and `time` the agenda clock in seconds.

<!-- check: wrap -->
```ts
import { Agendas, Movers, NavGraph, Simulation } from 'wallhammer-web/sim';

const hz = 10;
const sim = new Simulation({ seed: 'agenda-demo', hz });
const nav = new NavGraph('ways', { nodes: [0, 0, 60, 0, 60, 40], edges: [{ from: 0, to: 1, both: true }, { from: 1, to: 2, both: true }] });
const people = new Movers('people', { hz, collision: 'agents', width: 0.5 });
const places = [{ node: 0 }, { node: 2, inside: true }, { node: 1, x: 61, z: 2 }];
let WAITING = -1;
const agendas = new Agendas('agendas', {
  movers: people,
  nav,
  places,
  origin: 8 * 3600,
  // Activities with mode 1 end in a wait for a ride.
  onArrive: (e, a) => (a.activity(e).mode === 1 ? WAITING : undefined),
});
// Wait until the ride comes (here: a fixed time), then be carried on.
WAITING = agendas.states.define('waiting', {
  update: (e, a) => (a.time >= 8 * 3600 + 120 ? a.arriveNext(e) : undefined),
});
agendas.add({ activities: [{ place: 0, at: 8 * 3600, stay: 0 }, { place: 2, at: 8 * 3600 + 10, stay: 0, mode: 1 }, { place: 1, at: 8 * 3600 + 200, stay: 3600 }] });
sim.addState(people);
sim.addState(agendas);
sim.addSystem('people', people.system);
sim.addSystem('agendas', agendas.system);
sim.step(3000);
```

[Recipes](recipes.md#drive-entities-with-agendas) walks through a larger case; [feed agendas from external data](recipes.md#feed-agendas-from-external-data) shows a file format.

## A clock that jumps

A simulation only runs forward. When the app's clock jumps (a time slider, fast play), set the world up again at the new time instead of simulating the gap: keep a `snapshot()` from right after setup, `rebase(snapshot)` (tick 0 again), move the agenda `origin` to the new time minus a short warm-up, and step through the warm-up within a frame budget before showing anything. While the clock runs faster than the simulation can follow, hide the moving entities. The campus app does this in `population.ts`.

## Movement over a whole network

`Movers` and `Agendas` cost per entity, so they fit what the camera sees. For a network far larger than the view there is a coarse model: `FlowNetwork` makes every edge of a `NavGraph` a queue, and a trip in it is only a number. Individual movers exist only inside a focus circle, and they are the same trips.

**Segments.** Per edge: `capacity` trips fit (length · lanes / `spacing`), a trip that enters may leave after `free` ticks at the earliest (length / speed), at most `outflow` trips per second and lane leave, first in first out. A full segment lets nobody in, so queues spill back along the routes; a head that has waited longer than `patience` is pushed on, so rings of full segments dissolve. The queues step every `period` seconds (1 by default), so an edge shorter than speed · period is travelled slower than free travel would take.

**Trips.** `add({ from, to, at, tag })` before the first tick; `at` is a clock second and tick 0 is `origin`. A trip is `pending`, `waiting` (its first segment is full), `queued`, `individual`, `arrived` or `unreachable` (`FLOW_STATE`). `census()` counts them, `check()` recounts everything from the queues and the movers and returns what is wrong, or null.

**Focus and hand-over.** The command `<name>.focus` with `x`, `z` and `radius` in metres sets the circle; edges with both ends inside are detailed. The focus is input, so it only ever comes as a command. A trip is always exactly one of number and mover, and a hand-over never changes the census:

- a trip that moves from a coarse segment into a detailed one becomes a mover at the start of that segment, which lies on the rim of the circle;
- when the circle moves, all trips queued on a segment that turns detailed become movers along it, placed by their leaving time, and the movers of a segment that turns coarse go back into its queue with the leaving time their position gives;
- a mover that leaves the circle is taken back into the queue of the segment it has entered.

So nobody appears in the middle of the circle, except where a trip starts there. Keep the circle larger than the view and grow it step by step: a circle that jumps turns many segments detailed in one tick. The movers are an ordinary set (`flow.movers`, the `tag` column is the trip index), so `extractPose` feeds rigs as usual. `spawn(trip)` gives the mover parameters of a trip and must be a pure function of its index.

**Routes on two levels.** `RegionNav(nav, { cell })` splits the nodes into regions (a square grid of `cell` metres, or `regionOf` per node). A node with an edge into another region is a gate; per gate the cheapest ways inside its region are kept as tables. `find(from, to)` searches only the graph of gates and stitches the route from the tables, then caches it. A route costs what `nav.findPath` finds. `prepare(n)` builds the tables of `n` regions per call; a query builds what it needs itself, so the routes are the same either way. After `setCost` or `setBlocked` call `rebuild()`.

**Set-up in pieces.** `flow.prepare(units)` sets the network up for the clock time of tick 0: trips that left before `origin` are put where free travel has taken them by then, or are over (`horizon` bounds how far back it looks). It does at most `units` pieces of work per call and returns the pieces left. The state does not depend on how the calls are cut, and a simulation stepped before it is ready finishes the work in its first step. For a clock that jumps: `sim.rebase(snapshot)`, `flow.setOrigin(seconds)`, then `prepare` over a few frames.

<!-- check: wrap -->
```ts
import { FlowNetwork, NavGraph, RegionNav, Simulation } from 'wallhammer-web/sim';

const hz = 10;
const sim = new Simulation({ seed: 'flow-demo', hz });
const nav = new NavGraph('net', { nodes: [0, 0, 300, 0, 600, 0, 600, 300], edges: [{ from: 0, to: 1, both: true }, { from: 1, to: 2, both: true }, { from: 2, to: 3, both: true }] });
const routes = new RegionNav(nav, { cell: 400 });
const flow = new FlowNetwork('flow', { nav, routes, hz, speed: 12, origin: 8 * 3600, spawn: () => ({ cruise: 12, gap: 6 }) });
for (let i = 0; i < 200; i++) flow.add({ from: i % 2 ? 0 : 3, to: i % 2 ? 3 : 0, at: 8 * 3600 - 60 + i * 3, tag: i });
flow.attach(sim);
// A frame loop calls this with a small number until it returns 0.
while (flow.prepare(16) > 0);
// The two edges between the first three nodes are detailed, the third one stays a queue.
sim.command('flow.focus', { x: 300, z: 0, radius: 350 });
sim.step(3000);
const census = flow.census();
if (flow.check() !== null || census.queued + census.individual !== census.load) throw new Error('trips were lost');
```

`createFlowProbe()` is a reference run of all of this that is the same on every machine: a lattice from a seed, two networks, 40,000 trips, a scripted focus that pans, jumps, disappears and comes back. `flowProbeLine(probe.result())` is one line with the state hash. The golden test runs it headless (`node tools/golden/engine/flow-scenario.ts` prints the line); an app can run it in slices with `prepare(units)` and `advance(maxTicks)` and print the same line, as the campus app does with `otisk=1` in the address.

## Wiring it to the image

With `createEngine`, pass the simulation as `sim` and use the hooks:

<!-- check: wrap -->
```ts
import { TRANSFORM_STRIDE } from 'wallhammer-web/sim';
import type { Movers } from 'wallhammer-web/sim';
import type { Engine, EngineView } from 'wallhammer-web/runtime';
declare const engine: Engine<EngineView>;
declare const figures: Movers;

const transforms = new Float32Array(256 * TRANSFORM_STRIDE);
engine.onExtract((alpha) => {
  const n = figures.extract(alpha, transforms);
  // write n transforms into an instance buffer here
});
engine.onInput(() => {
  // turn held keys into commands here: engine.command('kind', { ... })
});
```

`engine.command(kind, data)` queues a command for the next tick the simulation runs. `engine.system(name, fn)` adds a system.

## Posed rigs

`extractPose` gives what a rig needs: position, heading, distance travelled (gait and wheel phase), speed, turn rate (steering, body roll) and the mover state (moving, dwelling, standing). [Rigs](rigs.md) shows how to turn it into instance records for `RigLayer`.
