// Scenarios of the coarse flow model and the route search on two levels (sim/flow.ts, sim/regions.ts) for the golden
// test. They check the rules as they go (routes valid and no dearer than a plain search, the conservation rule of the
// hand-over, set-up in pieces = at once, snapshot round trip, faster than real time) and throw when one is broken;
// what they return is hashed.
//
//   node tools/golden/engine/flow-scenario.ts     prints the line of the reference run (flowProbeLine), the line an
//                                                 app can print in a browser to compare its own run

import { fileURLToPath } from 'node:url';
import { hashInts } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { RegionNav, createFlowProbe, flowProbeLine } from '../../../packages/wallhammer-web/src/sim/index.ts';
import type { FlowProbeOptions, FlowProbeResult } from '../../../packages/wallhammer-web/src/sim/index.ts';

/**
 * Routes of the search on two levels over the probe's network against the plain A* of the graph: the same pairs are
 * reachable, every route is a chain of edges from start to goal, its cost is the cheapest one, and tables built ahead
 * give the same routes as tables built on demand.
 */
export function regionRoutes(): unknown[] {
  const probe = createFlowProbe({ seed: 'region-routes', side: 28, trips: 1 });
  const nav = probe.nets[0]!.nav;
  const ahead = new RegionNav(nav, { cell: 540 });
  const lazy = new RegionNav(nav, { cell: 540 });
  // Built in pieces, as a frame loop would.
  let rounds = 0;
  while (ahead.prepare(3) > 0) rounds++;
  if (!ahead.ready || ahead.pending !== 0) throw new Error('region routes: prepare left regions unbuilt');
  const out: unknown[] = [ahead.regionCount, ahead.gateCount, rounds];
  let unreachable = 0;
  let total = 0;
  for (let i = 0; i < 1500; i++) {
    const from = hashInts(0x51ed, i, 0) % nav.nodeCount;
    // Every third pair is close, so routes inside one region and between neighbours are covered.
    const to = i % 3 === 0 ? Math.min(nav.nodeCount - 1, from + (hashInts(0x51ed, i, 1) % 9)) : hashInts(0x51ed, i, 1) % nav.nodeCount;
    const a = ahead.find(from, to);
    const b = lazy.find(from, to);
    const plain = nav.findPath(from, to);
    if ((a === null) !== (plain === null)) throw new Error(`region routes: ${from} → ${to} reachable for one search only`);
    if ((a === null) !== (b === null) || (a && b && (a.length !== b.length || a.some((e, k) => e !== b[k])))) throw new Error(`region routes: ${from} → ${to} differs between tables built ahead and on demand`);
    if (a === null || plain === null) {
      unreachable++;
      continue;
    }
    let at = from;
    for (const e of a) {
      if (nav.edgeFrom[e] !== at || nav.blocked[e]) throw new Error(`region routes: ${from} → ${to} is not a chain of open edges`);
      at = nav.edgeTo[e]!;
    }
    if (at !== to) throw new Error(`region routes: ${from} → ${to} ends at ${at}`);
    const cost = ahead.cost(a);
    const best = ahead.cost(plain);
    if (cost !== best) throw new Error(`region routes: ${from} → ${to} costs ${cost}, the cheapest route ${best}`);
    total += cost;
    out.push(a.length, cost);
  }
  // The same query again comes from the cache.
  const before = ahead.searches;
  ahead.find(hashInts(0x51ed, 1, 0) % nav.nodeCount, hashInts(0x51ed, 1, 1) % nav.nodeCount);
  if (ahead.searches !== before || ahead.hits === 0) throw new Error('region routes: a repeated query was searched again');
  out.push(unreachable, total);
  return out;
}

function sameResult(a: FlowProbeResult, b: FlowProbeResult, what: string): void {
  if (flowProbeLine(a) !== flowProbeLine(b)) throw new Error(`flow: ${what} gives another state\n  ${flowProbeLine(a)}\n  ${flowProbeLine(b)}`);
}

/**
 * A small run four ways: set up at once, set up in pieces, never set up (the first step does it), and continued from
 * a snapshot taken on the way. All four must end in the same state.
 */
export function flowVariants(): string {
  // Paths of three edges: movers cross the focus area on several paths, so the change of path on the way and the stop
  // at the end of a path are part of the run (the reference run's paths are longer than its focus area is wide).
  const options: FlowProbeOptions = { seed: 'flow-variants', side: 20, trips: 3000, span: 1500, origin: 400, seconds: 900, pathEdges: 3 };
  const once = createFlowProbe(options);
  if (once.prepare() !== 0) throw new Error('flow: prepare() did not finish');
  once.advance(once.ticks >> 1);
  const half = once.sim.snapshot();
  once.advance();
  const reference = once.result();

  const pieces = createFlowProbe(options);
  let calls = 0;
  while (pieces.prepare(17) > 0) calls++;
  if (calls < 10) throw new Error('flow: the set-up in pieces was not cut');
  pieces.advance();
  sameResult(reference, pieces.result(), 'a set-up in pieces');

  const lazy = createFlowProbe(options);
  lazy.advance();
  sameResult(reference, lazy.result(), 'a run without prepare()');

  // Back to the snapshot of the middle and on to the end: the hash, the census and the tick must match (the counters
  // of hand-overs and searches are not state, so only those are compared).
  once.sim.restore(half);
  once.advance();
  const again = once.result();
  if (again.hash !== reference.hash || JSON.stringify(again.nets.map((n) => n.census)) !== JSON.stringify(reference.nets.map((n) => n.census))) throw new Error('flow: a run continued from a snapshot gives another state');

  const moved = reference.nets.reduce((n, net) => n + net.spawned + net.merged, 0);
  if (moved === 0) throw new Error('flow: the run had no hand-over');
  return flowProbeLine(reference);
}

/** The reference run (two networks, 40,000 trips, 3,000 s) and how long it took on this machine, milliseconds. */
export function flowReference(): { result: FlowProbeResult; ms: number } {
  const t0 = performance.now();
  const probe = createFlowProbe();
  probe.prepare();
  probe.advance();
  const result = probe.result();
  const ms = performance.now() - t0;
  for (const net of result.nets) {
    const c = net.census;
    if (c.pending + c.waiting + c.queued + c.individual + c.arrived + c.unreachable !== c.trips) throw new Error(`flow: ${net.name} lost or made trips`);
    if (net.spawned === 0 || net.merged === 0 || net.peak === 0) throw new Error(`flow: ${net.name} had no hand-over`);
    if (c.arrived < c.trips / 2) throw new Error(`flow: ${net.name} is stuck (${c.arrived} of ${c.trips} arrived)`);
  }
  if (ms >= result.seconds * 1000) throw new Error(`flow: ${result.seconds} s simulated in ${Math.round(ms)} ms, slower than real time`);
  return { result, ms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { result, ms } = flowReference();
  console.log(flowProbeLine(result));
  console.log(`${result.seconds} s simulated in ${Math.round(ms)} ms (${Math.round((result.seconds * 1000) / ms)}× real time)`);
}
