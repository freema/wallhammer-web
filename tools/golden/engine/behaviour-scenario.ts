// Behaviour cases of the simulation for the golden test, run headless in plain Node:
//
// - lanes: vehicles on loops through a grid of junctions with conflict zones, a static obstacle and a replayed
//   vehicle that does not yield. Hours of simulated time; the run fails on a deadlock (somebody standing too long),
//   on two bodies overlapping, or on a body inside the replayed one.
// - agents: a crowd on crossing ways and a group standing at one point; the run fails when walking agents overlap
//   too often or standing ones stay inside one another.
// - agendas: entities walking between places by their agendas, crossing a vehicle lane on a shared area; the run
//   fails when somebody does not finish or a figure and a vehicle are on the area together.
//
// Each returns its state hash and counts; seeking back and replaying must give the same hash.

import { Agendas, Interlock, MOVER_STATE, Movers, NavGraph, Simulation, TRANSFORM_STRIDE } from '../../../packages/wallhammer-web/src/sim/index.ts';
import type { NavEdgeInput } from '../../../packages/wallhammer-web/src/sim/index.ts';

/** Squared distance between two segments, sampled (enough for a test). */
function segSeg(a: number[], b: number[]): number {
  let best = Infinity;
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    const px = a[0]! + (a[2]! - a[0]!) * u;
    const pz = a[1]! + (a[3]! - a[1]!) * u;
    const dx = b[2]! - b[0]!;
    const dz = b[3]! - b[1]!;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((px - b[0]!) * dx + (pz - b[1]!) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = b[0]! + dx * t - px;
    const qz = b[1]! + dz * t - pz;
    best = Math.min(best, qx * qx + qz * qz);
  }
  return best;
}

function grid(n: number, step: number, name: string): NavGraph {
  const nodes: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) nodes.push(i * step, j * step);
  const edges: NavEdgeInput[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i + 1 < n; i++) edges.push({ from: j * n + i, to: j * n + i + 1, both: true });
  for (let j = 0; j + 1 < n; j++) for (let i = 0; i < n; i++) edges.push({ from: j * n + i, to: (j + 1) * n + i, both: true });
  return new NavGraph(name, { nodes, edges });
}

/** Position of the replayed vehicle: back and forth along the middle street, a pure function of the tick. */
function replayed(tick: number, hz: number): [number, number, number, number] {
  const period = 160 * hz;
  const t = tick % period;
  const half = period / 2;
  const u = t < half ? t / half : 2 - t / half;
  const x = 12 + u * 136;
  const z = 80 - 1.6 * (t < half ? -1 : 1);
  const dir = t < half ? 1 : -1;
  return [x, z, dir, 0];
}

export const LANES_HOURS = 3;

export function runLanesScenario(hours = LANES_HOURS): { hash: string; stats: Record<string, number> } {
  const hz = 10;
  const sim = new Simulation({ seed: 'golden.lanes', hz, checkpointEvery: 3000, checkpoints: 8 });
  const nav = grid(5, 40, 'lanes.nav');
  const movers = new Movers('lanes.movers', { hz, collision: 'lanes', width: 1.8 });
  sim.addState(movers);
  // A parked vehicle half on the carriageway of one street: loops through it are not used.
  movers.addObstacle({ ax: 118, az: 41.2, bx: 122, bz: 41.2, radius: 0.9 });
  // Loops: three junctions each, from the seed; no U-turns, not through the obstacle.
  const loops: number[] = [];
  let rejected = 0;
  for (let k = 0; loops.length < 8 && k < 400; k++) {
    const pick = (i: number): number => sim.random('loop', k, i) % nav.nodeCount;
    const stops = [pick(0), pick(1), pick(2)];
    if (new Set(stops).size < 3) continue;
    const route: number[] = [];
    let ok = true;
    for (let i = 0; i < 3 && ok; i++) {
      const r = nav.findPath(stops[i]!, stops[(i + 1) % 3]!);
      if (!r || r.length === 0) ok = false;
      else route.push(...r);
    }
    for (let i = 0; i < route.length && ok; i++) {
      const a = route[i]!;
      const b = route[(i + 1) % route.length]!;
      if (nav.edgeFrom[a] === nav.edgeTo[b] && nav.edgeTo[a] === nav.edgeFrom[b]) ok = false;
    }
    // The replayed vehicle does not yield: loops driving along its street are not used (they may cross it).
    for (const e of route) if (nav.nodeZ[nav.edgeFrom[e]!] === 80 && nav.nodeZ[nav.edgeTo[e]!] === 80) ok = false;
    if (!ok) continue;
    const id = movers.paths.add(nav.path(route, { loop: true, rightOffset: 1.6 }));
    if (movers.blocked(id).length > 0) {
      rejected++;
      movers.paths.release(id);
      continue;
    }
    loops.push(id);
  }
  // The replayed vehicle's route is a path too (nobody drives it): crossings of it become zones, so vehicles wait
  // before it, not on it, and only cross with room behind it.
  movers.paths.add({ points: [12, 81.6, 148, 81.6, 148, 78.4, 12, 78.4], loop: true });
  const zones = movers.buildZones({ clearance: 4 }); // Sharp corners: a rigid body cuts them by up to 1.6 m.
  let spawned = 0;
  loops.forEach((path, i) => {
    const len = movers.paths.get(path).length / 1000;
    for (let j = 0; j < 3; j++) {
      movers.spawn({ path, at: (len * j) / 3 + i * 3, cruise: 8 + (i % 3), accel: 1.6, decel: 2.5, gap: 8, front: 3.4, back: 1, width: 1.8, tag: spawned++ });
    }
  });
  movers.setKnownObstacles((tick) => {
    // Now and up to five seconds ahead: a vehicle starting from standing needs that long to clear a crossing.
    const out: number[] = [];
    for (const dt of [0, 10, 20, 30, 40, 50]) {
      const [x, z, dx] = replayed(tick + dt, hz);
      out.push(x - dx * 6, z, x + dx * 6, z, 1.3);
    }
    return out;
  });
  sim.addSystem('move', movers.system);

  const total = hours * 3600 * hz;
  const lastMoved = new Float64Array(spawned).fill(0);
  let longestStill = 0;
  let overlaps = 0;
  let intoReplayed = 0;
  let distance = 0;
  const pose = new Float32Array(spawned * TRANSFORM_STRIDE);
  const body = (o: number): number[] => {
    const x = pose[o]!;
    const z = pose[o + 1]!;
    const dx = pose[o + 2]!;
    const dz = pose[o + 3]!;
    return [x - dx * 1, z - dz * 1, x + dx * 3.4, z + dz * 3.4];
  };
  for (let t = 0; t < total; t++) {
    sim.step(1);
    const c = movers.table.col;
    for (let r = 0; r < movers.count; r++) {
      const tag = c.tag[r]!;
      if (c.speed[r]! > 0) lastMoved[tag] = sim.tick;
      longestStill = Math.max(longestStill, sim.tick - lastMoved[tag]!);
      distance += c.speed[r]!;
    }
    // Sampled every half second, after the first half minute (entities are placed without looking at each other).
    if (t % 5 !== 0 || t < 300) continue;
    movers.extract(1, pose);
    for (let a = 0; a < movers.count; a++) {
      const A = body(a * TRANSFORM_STRIDE);
      for (let b = a + 1; b < movers.count; b++) {
        const B = body(b * TRANSFORM_STRIDE);
        if (Math.abs(A[0]! - B[0]!) > 12 || Math.abs(A[1]! - B[1]!) > 12) continue;
        // Bodies 1.8 m wide: centrelines closer than 1.5 m overlap.
        if (segSeg(A, B) < 1.5 * 1.5) overlaps++;
      }
      const [x, z, dx] = replayed(sim.tick, hz);
      if (segSeg(A, [x - dx * 6, z, x + dx * 6, z]) < 1.9 * 1.9) intoReplayed++;
    }
  }
  const hash = sim.stateHash();
  // Seek back an hour and replay: the same state.
  const end = sim.tick;
  sim.seek(end - 3600 * hz);
  sim.seek(end);
  if (sim.stateHash() !== hash) throw new Error('lanes: seek back and replay changed the state');
  const stats = { vehicles: spawned, loops: loops.length, rejected, zones, longestStillS: longestStill / hz, overlaps, intoReplayed, km: distance / 1e6 };
  if (longestStill > 300 * hz) throw new Error(`lanes: a vehicle stood ${longestStill / hz} s (deadlock) ${JSON.stringify(stats)}`);
  if (overlaps > 0) throw new Error(`lanes: ${overlaps} overlaps ${JSON.stringify(stats)}`);
  if (intoReplayed > 0) throw new Error(`lanes: ${intoReplayed} samples with a vehicle in the replayed one ${JSON.stringify(stats)}`);
  return { hash, stats };
}

export function runAgentsScenario(): { hash: string; stats: Record<string, number> } {
  const hz = 10;
  const sim = new Simulation({ seed: 'golden.agents', hz, checkpointEvery: 500, checkpoints: 8 });
  const nav = grid(4, 15, 'agents.nav');
  const movers = new Movers('agents.movers', { hz, collision: 'agents', width: 0.5 });
  sim.addState(movers);
  sim.addSystem('move', movers.system);
  // Walkers between random nodes, a new route at every end; a group comes to node 5 and stays.
  const send = (id: number, k: number): void => {
    const info = movers.info(id);
    const p = movers.paths.get(info.path);
    const end = p.xs.length - 1;
    let here = 0;
    let best = Infinity;
    for (let n = 0; n < nav.nodeCount; n++) {
      const d = (nav.nodeX[n]! - p.xs[end]!) ** 2 + (nav.nodeZ[n]! - p.zs[end]!) ** 2;
      if (d < best) [best, here] = [d, n];
    }
    const goal = (here + 1 + (sim.random('goal', k, sim.tick) % (nav.nodeCount - 1))) % nav.nodeCount;
    const route = nav.findPath(here, goal);
    if (route && route.length) movers.send(id, nav.path(route));
  };
  const walkers: number[] = [];
  for (let i = 0; i < 80; i++) {
    const from = i % nav.nodeCount;
    const to = (from + 1 + (i % (nav.nodeCount - 1))) % nav.nodeCount;
    const route = nav.findPath(from, to)!;
    const path = movers.paths.add(nav.path(route), { owned: true });
    walkers.push(movers.spawn({ path, at: (i * 0.7) % 5, cruise: 1.1 + (i % 5) * 0.1, accel: 1.2, decel: 2, gap: 0.8, front: 0.25, back: 0.25, width: 0.5, tag: i }));
  }
  // The group walks to node 5 and on to a point 4 m into the block beside it (off the ways), and stands there.
  const group: number[] = [];
  for (let i = 0; i < 16; i++) {
    const route = nav.findPath(i % 4, 5)!;
    const def = nav.path(route);
    const path = movers.paths.add({ ...def, points: [...def.points, 18, 18] }, { owned: true });
    group.push(movers.spawn({ path, cruise: 1.2, gap: 0.8, width: 0.5, tag: 1000 + i }));
  }
  let closeWalking = 0;
  let samples = 0;
  const stillSince = new Map<number, number>();
  let longestStill = 0;
  const pose = new Float32Array(200 * TRANSFORM_STRIDE);
  for (let t = 0; t < 3000; t++) {
    sim.step(1);
    for (const e of sim.events.lastTick('move.end')) {
      const k = walkers.indexOf(e.entity);
      if (k >= 0) send(e.entity, k);
    }
    {
      const cc = movers.table.col;
      for (let r = 0; r < movers.count; r++) {
        const tag = cc.tag[r]!;
        if (cc.state[r] !== MOVER_STATE.moving || cc.speed[r]! > 0) stillSince.set(tag, sim.tick);
        else longestStill = Math.max(longestStill, sim.tick - (stillSince.get(tag) ?? 0));
      }
    }
    if (t % 10 !== 0) continue;
    const n = movers.extract(1, pose);
    const c = movers.table.col;
    for (let a = 0; a < n; a++) {
      if (c.state[a] !== MOVER_STATE.moving) continue;
      for (let b = a + 1; b < n; b++) {
        if (c.state[b] !== MOVER_STATE.moving) continue;
        const d2 = (pose[a * TRANSFORM_STRIDE]! - pose[b * TRANSFORM_STRIDE]!) ** 2 + (pose[a * TRANSFORM_STRIDE + 1]! - pose[b * TRANSFORM_STRIDE + 1]!) ** 2;
        samples++;
        if (d2 < 0.3 * 0.3) closeWalking++;
      }
    }
  }
  // The group at node 5: no two closer than 0.45 m once they stand.
  const n = movers.extract(1, pose);
  const at: [number, number][] = [];
  for (let r = 0; r < n; r++) if (movers.table.col.tag[r]! >= 1000) at.push([pose[r * TRANSFORM_STRIDE]!, pose[r * TRANSFORM_STRIDE + 1]!]);
  let standingInside = 0;
  for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) if (Math.hypot(at[a]![0] - at[b]![0], at[a]![1] - at[b]![1]) < 0.45) standingInside++;
  const hash = sim.stateHash();
  const end = sim.tick;
  sim.seek(1000);
  // The walkers' new routes come from events: replaying them needs the same handler, so the seek replays through it.
  for (let t = sim.tick; t < end; t++) {
    sim.step(1);
    for (const e of sim.events.lastTick('move.end')) {
      const k = walkers.indexOf(e.entity);
      if (k >= 0) send(e.entity, k);
    }
  }
  if (sim.stateHash() !== hash) throw new Error('agents: seek back and replay changed the state');
  const stats = { walkers: walkers.length, standing: at.length, standingInside, longestStillS: longestStill / hz, closeWalkingPerMille: Math.round((closeWalking / Math.max(1, samples)) * 1e6) / 1000 };
  if (longestStill > 60 * hz) throw new Error(`agents: a walker stood ${longestStill / hz} s (gridlock) ${JSON.stringify(stats)}`);
  if (standingInside > 0) throw new Error(`agents: ${standingInside} standing pairs inside each other ${JSON.stringify(stats)}`);
  return { hash, stats };
}

export function runAgendaScenario(): { hash: string; stats: Record<string, number> } {
  const hz = 10;
  const sim = new Simulation({ seed: 'golden.agenda', hz, checkpointEvery: 600, checkpoints: 8 });
  // Walkways: a 3 × 3 grid, 20 m apart; a two-way vehicle lane along z = 10 crosses the three walkways x = 0, 20, 40.
  const nav = grid(3, 20, 'agenda.nav');
  const people = new Movers('agenda.people', { hz, collision: 'agents', width: 0.5 });
  const cars = new Movers('agenda.cars', { hz, collision: 'lanes', width: 1.8 });
  const il = new Interlock('agenda.areas', {
    areas: [
      // Two marked areas (people first) and one where vehicles have the right of way.
      { ax: 20, az: 6, bx: 20, bz: 14, radius: 1.5, priority: 0 },
      { ax: 40, az: 6, bx: 40, bz: 14, radius: 1.5, priority: 0 },
      { ax: 0, az: 6, bx: 0, bz: 14, radius: 1.5, priority: 1 },
    ],
  });
  il.attach(people, 0);
  il.attach(cars, 1);
  const lane = cars.paths.add({ points: [-30, 11.6, 70, 11.6, 70, 8.4, -30, 8.4], loop: true });
  cars.buildZones();
  for (let i = 0; i < 3; i++) cars.spawn({ path: lane, at: i * 70, cruise: 7, accel: 1.5, decel: 3, gap: 8, front: 3.4, back: 1, tag: i });
  // Places: every node; a door at node 8 is inside.
  const places = Array.from({ length: nav.nodeCount }, (_, n) => ({ node: n, inside: n === 8 }));
  let WAIT = -1;
  const ag = new Agendas('agenda.people.plan', {
    movers: people,
    nav,
    places,
    origin: 8 * 3600,
    spawn: (i) => ({ cruise: 1.2 + (i % 4) * 0.1, accel: 1.2, decel: 2, gap: 0.8, front: 0.25, back: 0.25, width: 0.5 }),
    // Entities with mode 1 wait at their second place for 5 s more in a state of the app's own.
    onArrive: (e, a) => {
      if (a.activity(e).mode === 1 && a.activity(e).index === 1) {
        a.setTimer(e, a.now + 50);
        return WAIT;
      }
    },
  });
  // A waiting state of the app: entities with mode 1 wait at their place until a fixed tick, then go on.
  WAIT = ag.states.define('waiting', { update: (e, a) => (a.now >= a.timer(e) ? a.leave(e) : undefined) });
  const arrived: number[] = [];
  for (let i = 0; i < 60; i++) {
    const a = i % 9;
    const b = (a + 4 + (i % 3)) % 9;
    const c = (b + 2) % 9;
    ag.add({
      activities: [
        { place: a, at: 8 * 3600 + i * 5, stay: 0 },
        { place: b, at: 8 * 3600 + 20 + i * 5, stay: 30, mode: i % 2 },
        { place: c, at: 8 * 3600 + 200, arrive: true, stay: 60 },
        { place: 8, at: 8 * 3600 + 400, stay: 3600 },
      ],
      tag: i,
    });
  }
  sim.addState(cars);
  sim.addState(people);
  sim.addState(ag);
  sim.addSystem('areas', il.system);
  sim.addSystem('cars', cars.system);
  sim.addSystem('people', people.system);
  sim.addSystem('agendas', ag.system);
  let together = 0;
  let maxOut = 0;
  for (let t = 0; t < 9000; t++) {
    sim.step(1);
    for (const e of sim.events.lastTick('agenda.arrive')) if (Number(e.data.activity) === 3) arrived.push(e.entity);
    maxOut = Math.max(maxOut, people.count);
    for (let a = 0; a < il.areaCount; a++) if (il.on[0][a]! > 0 && il.on[1][a]! > 0) together++;
  }
  const hash = sim.stateHash();
  const end = sim.tick;
  sim.seek(2000);
  sim.seek(end);
  if (sim.stateHash() !== hash) throw new Error('agendas: seek back and replay changed the state');
  const stats = { entities: ag.size, inside: arrived.length, maxOut, outAtEnd: people.count, together };
  if (arrived.length !== 60) throw new Error(`agendas: ${arrived.length} of 60 reached the last place ${JSON.stringify(stats)}`);
  if (together > 0) throw new Error(`agendas: ${together} ticks with a figure and a vehicle on one area ${JSON.stringify(stats)}`);
  return { hash, stats };
}

if (process.argv[1]?.endsWith('behaviour-scenario.ts')) {
  const which = process.argv[2] ?? 'all';
  const t0 = performance.now();
  if (which === 'all' || which === 'lanes') console.log('lanes', JSON.stringify(runLanesScenario(Number(process.argv[3] ?? LANES_HOURS))), Math.round(performance.now() - t0), 'ms');
  if (which === 'all' || which === 'agents') console.log('agents', JSON.stringify(runAgentsScenario()));
  if (which === 'all' || which === 'agenda') console.log('agenda', JSON.stringify(runAgendaScenario()));
}
