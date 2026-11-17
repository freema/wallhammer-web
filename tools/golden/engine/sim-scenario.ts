// Determinism case of the simulation for the golden test: a fixed seed, a scripted command list and a small graph,
// run through the headless engine with different frame-step patterns. The state hash at tick N must not depend on
// the pattern, and seeking back and forth must land on the same hash.

import { createHeadlessEngine } from '../../../packages/wallhammer-web/src/runtime/index.ts';
import { Movers, NavGraph, POSE_STRIDE, Simulation } from '../../../packages/wallhammer-web/src/sim/index.ts';

export const SIM_TICKS = 3000;

/** Frame lengths in seconds, cycled: steady 30 Hz, steady 144 Hz and an irregular pattern with stalls. */
export const FRAME_PATTERNS: Record<string, readonly number[]> = {
  '30 Hz': [1 / 30],
  '144 Hz': [1 / 144],
  irregular: [0.004, 0.051, 1 / 60, 0.033, 0.0007, 0.09, 0.012],
};

/** Grid of 4 × 3 nodes, 20 m apart, edges both ways; the middle row is slower. */
function graph(): NavGraph {
  const nodes: number[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) nodes.push(i * 20, j * 20);
  const edges = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) edges.push({ from: j * 4 + i, to: j * 4 + i + 1, both: true, speed: j === 1 ? 0.8 : 0 });
  for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) edges.push({ from: j * 4 + i, to: (j + 1) * 4 + i, both: true });
  return new NavGraph('golden.nav', { nodes, edges });
}

function build(): { sim: Simulation; movers: Movers; nav: NavGraph } {
  const sim = new Simulation({ seed: 'golden', hz: 20, checkpointEvery: 100 });
  const nav = graph();
  const movers = new Movers('golden.movers', { hz: sim.hz, collision: 'follow' });
  sim.addState(nav);
  sim.addState(movers);
  // The outer ring as a loop with a stop at node 3.
  const ring = [0, 1, 2, 3, 7, 11, 10, 9, 8, 4, 0];
  const ringEdges = ring.slice(1).map((to, i) => nav.findEdge(ring[i]!, to));
  const loop = movers.paths.add(nav.path(ringEdges, { loop: true, rightOffset: 0.5, stops: [{ vertex: 3, dwell: 3 }] }));

  sim.onCommand('spawn', (c) => {
    movers.spawn({ path: loop, at: Number(c.data.at), cruise: Number(c.data.cruise), accel: 1.2, decel: 2.5, gap: 2.5, tag: 1 });
  });
  sim.onCommand('wanderer', (c) => {
    const from = Number(c.data.node);
    const id = movers.spawn({ path: loop, cruise: 1.6, gap: 2, tag: 2 });
    movers.send(id, nav.path(nav.findPath(from, (from + 5) % nav.nodeCount)!, { rightOffset: 0.5 }));
  });
  sim.onCommand('block', (c) => nav.setBlocked(nav.findEdge(Number(c.data.from), Number(c.data.to)), true));
  // Wanderers pick a new goal from the seed when they reach the end of their route.
  sim.addSystem('wander', (s) => {
    for (const e of s.events.lastTick('move.end')) {
      const info = movers.info(e.entity);
      const p = movers.paths.get(info.path);
      const x = p.xs[p.xs.length - 1]!;
      const z = p.zs[p.zs.length - 1]!;
      let here = 0;
      let best = Infinity;
      for (let n = 0; n < nav.nodeCount; n++) {
        const dx = nav.nodeX[n]! - x;
        const dz = nav.nodeZ[n]! - z;
        const d = dx * dx + dz * dz;
        if (d < best) [best, here] = [d, n];
      }
      const goal = (here + 1 + (s.random('wander', e.entity % 2 ** 32) % (nav.nodeCount - 1))) % nav.nodeCount;
      const route = nav.findPath(here, goal);
      if (route && route.length > 0) movers.send(e.entity, nav.path(route, { rightOffset: 0.5 }));
    }
  });
  sim.addSystem('move', movers.system);

  // The script: every input is a command stamped with its tick.
  for (let k = 0; k < 5; k++) sim.command('spawn', { at: 12 * k, cruise: 1.2 + 0.15 * k }, 0);
  sim.command('wanderer', { node: 0 }, 40);
  sim.command('wanderer', { node: 6 }, 41);
  sim.command('wanderer', { node: 11 }, 300);
  sim.command('block', { from: 5, to: 6 }, 450);
  sim.command('spawn', { at: 3, cruise: 2.2 }, 700);
  return { sim, movers, nav };
}

/** Runs the scenario with one frame pattern; returns the hash at tick N and the number of arrival events. */
export function runSimScenario(pattern: readonly number[]): { hash: string; events: number } {
  const { sim } = build();
  const engine = createHeadlessEngine({ sim, environment: { animate: false } });
  let hash = '';
  sim.onTick((s) => {
    if (s.tick === SIM_TICKS) hash = s.stateHash();
  });
  let events = 0;
  for (let f = 0; sim.tick < SIM_TICKS; f++) {
    engine.frame(pattern[f % pattern.length]!);
    events += sim.events.drain().filter((e) => e.kind === 'move.arrive' || e.kind === 'move.end').length;
  }
  // Seeking back replays the command log from a checkpoint; going forward again must reproduce the same state.
  const at = sim.tick;
  const there = sim.stateHash();
  sim.seek(333);
  sim.seek(at);
  if (sim.stateHash() !== there) throw new Error('seek back and forth changed the state');
  return { hash, events };
}

/**
 * Poses for the rig layer: the same scenario run at 30 Hz frames, with `extractPose` sampled between ticks at a few
 * interpolation factors (position, heading, distance, speed, turn rate, state). The rows must not depend on how the
 * ticks were reached, so the second run gets there through a seek from a later tick.
 */
export function runPoseScenario(): Float32Array[] {
  const out: Float32Array[] = [];
  const sample = (movers: Movers): void => {
    for (const alpha of [0, 0.25, 0.5, 1]) {
      const rows = new Float32Array(movers.count * POSE_STRIDE);
      movers.extractPose(alpha, rows);
      out.push(rows);
    }
  };
  for (const viaSeek of [false, true]) {
    const { sim, movers } = build();
    const engine = createHeadlessEngine({ sim, environment: { animate: false } });
    for (const tick of [200, 760, 1500]) {
      if (viaSeek) {
        while (sim.tick < 1600) engine.frame(1 / 30);
        sim.seek(tick);
      } else while (sim.tick < tick) engine.frame(1 / 30);
      if (sim.tick !== tick) sim.seek(tick);
      sample(movers);
    }
  }
  const half = out.length / 2;
  for (let i = 0; i < half; i++) {
    const a = out[i]!;
    const b = out[i + half]!;
    if (a.length !== b.length || a.some((v, k) => v !== b[k])) throw new Error(`sim poses: sample ${i} differs after a seek`);
  }
  return out.slice(0, half);
}
