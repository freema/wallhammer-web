// A reference run of the flow model, the same on every machine: a lattice network made from a seed, two flow
// networks on it (vehicles that follow each other on lanes, walkers that avoid each other), tens of thousands of trips,
// and a scripted focus area that pans, jumps, disappears and comes back. It starts in the middle of the departures, so
// the set-up at a clock time is part of it. The run checks the conservation rule as it goes and ends in a state hash.
//
// Two uses: the golden test runs it headless, and an app can run it in the browser in slices (`prepare`, `advance`)
// and print the same line (`flowProbeLine`), so the two machines can be compared.

import { hashInts, streamSeed } from '../gen-core/hash.ts';
import { lengthMm } from './fixed.ts';
import { FlowNetwork } from './flow.ts';
import type { FlowCensus } from './flow.ts';
import { NavGraph } from './nav.ts';
import type { NavEdgeInput } from './nav.ts';
import { RegionNav } from './regions.ts';
import { Simulation } from './simulation.ts';

export interface FlowProbeOptions {
  seed?: string;
  /** Nodes per side of the lattice. Default 48. */
  side?: number;
  /** Distance between neighbouring nodes, metres. Default 90. */
  step?: number;
  /** Trips per network (there are two). Default 20000. */
  trips?: number;
  /** Clock seconds over which the trips depart, from 0. Default 3600. */
  span?: number;
  /** Clock second of tick 0; trips that left earlier are set up under way. Default 600. */
  origin?: number;
  /** Seconds simulated. Default 3000. */
  seconds?: number;
  /** Ticks per second. Default 10. */
  hz?: number;
  /** Edges a mover's path looks ahead (`FlowOptions.pathEdges`); a small number makes movers change paths often. Default: the network's. */
  pathEdges?: number;
}

export interface FlowProbeResult {
  /** State hash of the simulation at the end. */
  hash: string;
  tick: number;
  seconds: number;
  /** Per network: the census at the end, hand-overs both ways and the most individual movers at once. */
  nets: { name: string; census: FlowCensus; spawned: number; merged: number; peak: number }[];
  /** Route search: regions, gates, searches and cache hits over both networks. */
  routes: { regions: number; gates: number; searches: number; hits: number };
}

export interface FlowProbe {
  readonly sim: Simulation;
  /** The two networks: vehicles, walkers. */
  readonly nets: readonly FlowNetwork[];
  /** Ticks of the whole run. */
  readonly ticks: number;
  /** Sets the networks up, at most `units` pieces of work per network; returns the pieces left (0: ready). */
  prepare(units?: number): number;
  /** Runs at most `maxTicks` ticks and returns true when the run is over. Throws when a count does not add up. */
  advance(maxTicks?: number): boolean;
  result(): FlowProbeResult;
}

/** Ticks between two checks of the conservation rule. */
const CHECK_EVERY = 100;

export function createFlowProbe(options: FlowProbeOptions = {}): FlowProbe {
  const seed = options.seed ?? 'flow-probe';
  const side = Math.max(4, Math.floor(options.side ?? 48));
  const step = Math.max(20, Math.floor(options.step ?? 90));
  const trips = Math.max(1, Math.floor(options.trips ?? 20000));
  const span = Math.max(1, Math.floor(options.span ?? 3600));
  const origin = Math.floor(options.origin ?? 600);
  const seconds = Math.max(1, Math.floor(options.seconds ?? 3000));
  const hz = Math.max(1, Math.floor(options.hz ?? 10));
  const ahead = options.pathEdges !== undefined ? { pathEdges: options.pathEdges } : {};
  const sim = new Simulation({ seed, hz, checkpointEvery: 600 * hz, checkpoints: 4 });

  // The lattice: nodes shifted by up to a fifth of the step, every sixth line a wide and fast one that is never cut.
  const lattice = streamSeed(seed, 'lattice');
  const nodes: number[] = [];
  const xs: number[] = [];
  const zs: number[] = [];
  const shift = Math.floor((step * 1000) / 5);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = i * step * 1000 + (hashInts(lattice, i, j, 0) % shift);
      const z = j * step * 1000 + (hashInts(lattice, i, j, 1) % shift);
      xs.push(x);
      zs.push(z);
      nodes.push(x / 1000, z / 1000);
    }
  }
  const driveEdges: NavEdgeInput[] = [];
  const driveLanes: number[] = [];
  const walkEdges: NavEdgeInput[] = [];
  let serial = 0;
  const link = (a: number, b: number, major: boolean): void => {
    const k = serial++;
    const len = Math.max(1, lengthMm(xs[b]! - xs[a]!, zs[b]! - zs[a]!));
    if (major || hashInts(lattice, k, 2) % 100 >= 12) {
      // Cost is travel time: the fast lines count 4/7 of their length.
      driveEdges.push({ from: a, to: b, both: true, speed: major ? 14 : 8, cost: major ? Math.max(1, Math.round((len * 4) / 7)) : len });
      driveLanes.push(major ? 2 : 1, major ? 2 : 1);
    }
    if (major || hashInts(lattice, k, 3) % 100 >= 8) walkEdges.push({ from: a, to: b, both: true });
  };
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const a = j * side + i;
      if (i + 1 < side) link(a, a + 1, j % 6 === 0);
      if (j + 1 < side) link(a, a + side, i % 6 === 0);
    }
  }
  const count = side * side;
  const driveNav = new NavGraph('probe.drive', { nodes, edges: driveEdges });
  const walkNav = new NavGraph('probe.walk', { nodes, edges: walkEdges });
  const driveRoutes = new RegionNav(driveNav, { cell: step * 8 });
  const walkRoutes = new RegionNav(walkNav, { cell: step * 8 });

  const vs = streamSeed(seed, 'vehicles');
  const ws = streamSeed(seed, 'walkers');
  const vehicles = new FlowNetwork('probe.vehicles', {
    nav: driveNav, routes: driveRoutes, hz, origin, speed: 14, spacing: 7.5, outflow: 0.5, lanes: driveLanes, patience: 90, horizon: 3600,
    collision: 'follow', width: 1.8, rightOffset: 1.6, ...ahead,
    spawn: (trip) => ({ cruise: 9 + (hashInts(vs, trip, 2) % 5), accel: 1.6, decel: 2.5, gap: 8 }),
  });
  const walkers = new FlowNetwork('probe.walkers', {
    nav: walkNav, routes: walkRoutes, hz, origin, speed: 1.4, spacing: 0.8, outflow: 1.2, lanes: 3, patience: 60, horizon: 3600,
    collision: 'agents', width: 0.5, rightOffset: 1, ...ahead,
    spawn: (trip) => ({ cruise: 1.1 + (hashInts(ws, trip, 2) % 5) / 10, accel: 1.2, decel: 2, gap: 0.8, front: 0.25, back: 0.25, width: 0.5 }),
  });
  for (let i = 0; i < trips; i++) {
    const at = Math.floor((i * span * hz) / trips) / hz;
    vehicles.add({ from: hashInts(vs, i, 0) % count, to: hashInts(vs, i, 1) % count, at, tag: i });
    // Walks are short: the goal lies within six lattice steps of the start.
    const from = hashInts(ws, i, 0) % count;
    const ti = Math.min(side - 1, Math.max(0, (from % side) + (hashInts(ws, i, 1) % 13) - 6));
    const tj = Math.min(side - 1, Math.max(0, Math.floor(from / side) + (hashInts(ws, i, 3) % 13) - 6));
    walkers.add({ from, to: tj * side + ti, at, tag: i });
  }
  const nets = [vehicles, walkers];
  for (const net of nets) net.attach(sim);

  // The focus script: a pan, a jump and a second pan, a minute without a focus, then a wide focus that stays.
  const total = seconds * hz;
  const width = (side - 1) * step;
  const third = Math.floor(seconds / 3);
  const focus = (second: number, x: number, z: number, radius: number): void => {
    for (const net of nets) sim.command(`${net.name}.focus`, { x, z, radius }, second * hz);
  };
  for (let s = 0; s < third; s += 15) focus(s, Math.floor(width * 0.3) + s * 3, Math.floor(width * 0.3) + Math.floor((s * 3) / 2), 450);
  for (let s = third; s < 2 * third; s += 15) focus(s, Math.floor(width * 0.8) - (s - third) * 2, Math.floor(width * 0.2) + Math.floor(((s - third) * 5) / 2), 450);
  focus(2 * third, 0, 0, 0);
  if (2 * third + 60 < seconds) focus(2 * third + 60, Math.floor(width / 2), Math.floor(width / 2), 600);

  const peak = [0, 0];
  const verify = (): void => {
    nets.forEach((net, i) => {
      const wrong = net.check();
      if (wrong) throw new Error(`flow probe: ${net.name} at tick ${sim.tick}: ${wrong}`);
      peak[i] = Math.max(peak[i]!, net.movers.count);
    });
  };

  return {
    sim,
    nets,
    ticks: total,
    prepare(units = Infinity): number {
      let left = 0;
      for (const net of nets) left += net.prepare(units);
      return left;
    },
    advance(maxTicks = Infinity): boolean {
      let n = 0;
      while (sim.tick < total && n < maxTicks) {
        const chunk = Math.min(total - sim.tick, maxTicks - n, CHECK_EVERY - (sim.tick % CHECK_EVERY));
        sim.step(chunk);
        n += chunk;
        if (sim.tick % CHECK_EVERY === 0 || sim.tick === total) verify();
      }
      return sim.tick >= total;
    },
    result(): FlowProbeResult {
      return {
        hash: sim.stateHash(),
        tick: sim.tick,
        seconds: sim.tick / hz,
        nets: nets.map((net, i) => ({ name: net.name, census: net.census(), spawned: net.spawned, merged: net.merged, peak: peak[i]! })),
        routes: {
          regions: driveRoutes.regionCount + walkRoutes.regionCount, gates: driveRoutes.gateCount + walkRoutes.gateCount,
          searches: driveRoutes.searches + walkRoutes.searches, hits: driveRoutes.hits + walkRoutes.hits,
        },
      };
    },
  };
}

/** One line of a probe result for a log: the hash first, then the counts that explain it. */
export function flowProbeLine(r: FlowProbeResult): string {
  const nets = r.nets.map((n) => `${n.name} arrived ${n.census.arrived}/${n.census.trips} under way ${n.census.load} individual ${n.census.individual} out ${n.spawned} back ${n.merged}`).join('; ');
  return `flow ${r.hash} tick ${r.tick} (${r.seconds} s); ${nets}; routes ${r.routes.searches} searched ${r.routes.hits} cached`;
}
