// What lives on the island, as simulation: a navigation graph among the standing stones, a procession that circles
// half the ring and crosses to the ring sculpture (where each figure stops a while, the ones behind queue), and
// wanderers that walk from stone to stone along A* routes and linger at each. Everything is a pure function of the
// seed and the commands; the image only reads interpolated transforms (`Movers.extract`).

import { Movers, NavGraph, Simulation } from 'wallhammer-web/sim';
import type { NavEdgeInput } from 'wallhammer-web/sim';
import { ISLAND_SIZE_M, RING_YAW, TRACK_RADIUS_M } from './scene.ts';
import { TRACK_TAG } from './rigs.ts';

const C = ISLAND_SIZE_M / 2;
/** Walkway inside the stone ring, spots in front of the stones, the gap in the ring. */
const WALK_R = 19;
const SPOT_R = 23;
const WALK_NODES = 26;
const STONES = 13;
const GAP_STONE = 9;
/** Lanes: figures keep to the right of the walkway, so opposite directions pass each other. */
const LANE_M = 0.7;

export const TAG = { procession: 1, wanderer: 2 } as const;

export interface Life {
  sim: Simulation;
  nav: NavGraph;
  figures: Movers;
  /** The rig demo: a cart and porters on the track round the outside of the ring (drawn by `rigs.ts`). */
  track: Movers;
}

const at = (r: number, a: number): [number, number] => [C + Math.cos(a) * r, C + Math.sin(a) * r];

function buildGraph(): { nav: NavGraph; spots: number[]; shrineIn: number[]; gate: number } {
  const nodes: number[] = [];
  const edges: NavEdgeInput[] = [];
  const node = (p: readonly [number, number]): number => (nodes.push(p[0], p[1]), nodes.length / 2 - 1);
  // The walkway: a ring of nodes, edges both ways.
  for (let j = 0; j < WALK_NODES; j++) node(at(WALK_R, (j / WALK_NODES) * Math.PI * 2));
  for (let j = 0; j < WALK_NODES; j++) edges.push({ from: j, to: (j + 1) % WALK_NODES, both: true, speed: 1.4 });
  // A spot in front of every stone, on a short spur from the walkway.
  const spots: number[] = [];
  for (let k = 0; k < STONES; k++) {
    if (k === GAP_STONE) continue;
    const s = node(at(SPOT_R, (k / STONES) * Math.PI * 2));
    spots.push(s);
    edges.push({ from: 2 * k, to: s, both: true, speed: 0.8 });
  }
  // The gap in the ring.
  const gate = node(at(27.5, (GAP_STONE / STONES) * Math.PI * 2));
  edges.push({ from: 2 * GAP_STONE, to: gate, both: true, speed: 0.8 });
  // The ring sculpture: a stand on each face and a way round its end, one way only, slowly.
  const n: [number, number] = [Math.sin(RING_YAW), Math.cos(RING_YAW)];
  const t: [number, number] = [Math.cos(RING_YAW), -Math.sin(RING_YAW)];
  const faceA = node([C + n[0] * 5, C + n[1] * 5]);
  const end = node([C + t[0] * 11, C + t[1] * 11]);
  const faceB = node([C - n[0] * 5, C - n[1] * 5]);
  const toNode = (dx: number, dz: number): number => ((Math.round((Math.atan2(dz, dx) / (Math.PI * 2)) * WALK_NODES) % WALK_NODES) + WALK_NODES) % WALK_NODES;
  const jA = toNode(n[0], n[1]);
  const jB = toNode(-n[0], -n[1]);
  edges.push({ from: jA, to: faceA, speed: 0.6 }, { from: faceA, to: end, speed: 0.6 }, { from: end, to: faceB, speed: 0.6 }, { from: faceB, to: jB, speed: 0.6 });
  return { nav: new NavGraph('island.nav', { nodes, edges }), spots, shrineIn: [jB, jA, faceA, end, faceB], gate };
}

/** Builds the simulation of the island for a seed: graph, figures, the wander system and the `call` command. */
export function createLife(seed: number): Life {
  const sim = new Simulation({ seed: `island-${seed}` });
  const { nav, spots, shrineIn, gate } = buildGraph();
  const figures = new Movers('figures', { hz: sim.hz, collision: 'follow' });
  sim.addState(nav);
  sim.addState(figures);

  // The procession: from jB counter-clockwise along half the walkway to jA, then across past the ring sculpture.
  const [jB, jA, faceA, end, faceB] = shrineIn as [number, number, number, number, number];
  const route: number[] = [];
  for (let j = jB; j !== jA; j = (j + 1) % WALK_NODES) route.push(nav.findEdge(j, (j + 1) % WALK_NODES));
  route.push(nav.findEdge(jA, faceA), nav.findEdge(faceA, end), nav.findEdge(end, faceB), nav.findEdge(faceB, jB));
  const stopVertex = route.length - 3;
  const procession = figures.paths.add(nav.path(route, { loop: true, rightOffset: LANE_M, stops: [{ vertex: stopVertex, dwell: 6 }] }));
  for (let i = 0; i < 7; i++) {
    figures.spawn({ path: procession, at: 4 + i * 3.4, cruise: 1.05 + (sim.random('procession', i) % 20) / 100, accel: 0.8, decel: 1.6, gap: 2.2, tag: TAG.procession });
  }

  // Wanderers: the tag holds the node they are heading for.
  const walkTo = (id: number, from: number, to: number, dwell: number): void => {
    const edges = nav.findPath(from, to);
    if (!edges || edges.length === 0) return;
    figures.send(id, nav.path(edges, { rightOffset: LANE_M, stops: [{ vertex: edges.length, dwell }] }));
    figures.table.col.tag[figures.table.rowOf(id)] = TAG.wanderer + 16 * to;
  };
  const pick = (stream: string, key: number, except: number): number => {
    const k = sim.random(stream, key) % (spots.length - 1);
    const s = spots[k]!;
    return s === except ? spots[spots.length - 1]! : s;
  };
  for (let i = 0; i < 6; i++) {
    const from = spots[(i * 5 + (sim.random('start', 0) % spots.length)) % spots.length]!;
    const id = figures.spawn({ path: procession, cruise: 1.25 + (sim.random('wanderer', i) % 30) / 100, accel: 1, decel: 2, gap: 1.6, tag: TAG.wanderer });
    walkTo(id, from, pick('goal', i, from), 2 + (sim.random('dwell', i) % 5));
  }
  // Tag of a wanderer: kind in the low 3 bits, bit 3 = called to the gate, goal node above.
  const tagOf = (id: number): number => figures.table.col.tag[figures.table.rowOf(id)]!;

  // When a wanderer has lingered at its stone, it picks the next one, or walks to the gate when it was called.
  sim.addSystem('wander', (s) => {
    for (const e of s.events.lastTick('move.end')) {
      const tag = tagOf(e.entity);
      const here = Math.floor(tag / 16);
      const key = e.entity % 2 ** 32;
      if (tag & 8) walkTo(e.entity, here, gate, 12);
      else walkTo(e.entity, here, pick('goal', key, here), 3 + (s.random('dwell', key) % 6));
    }
  });
  sim.addSystem('move', figures.system);
  // `call`: every wanderer walks to the gap in the ring after its current stone, waits there, then wanders on.
  sim.onCommand('call', () => {
    const t = figures.table;
    for (let r = 0; r < t.count; r++) if (t.col.tag[r]! % 8 === TAG.wanderer) t.col.tag[r] = t.col.tag[r]! | 8;
  });

  // The track: a loop round the outside of the ring each way. The cart halts at the gap a while and the porters
  // behind it queue (collision `follow`); two more porters walk the other way on their own lane.
  const track = new Movers('track', { hz: sim.hz, collision: 'follow' });
  sim.addState(track);
  const ring = (dir: 1 | -1): number[] => {
    const pts: number[] = [];
    for (let k = 0; k < 40; k++) pts.push(...at(TRACK_RADIUS_M, (dir * k * Math.PI * 2) / 40));
    return pts;
  };
  const gapVertex = Math.round((GAP_STONE / STONES) * 40) % 40;
  const out = track.paths.add({ points: ring(1), loop: true, stops: [{ vertex: gapVertex, dwell: 8 }] });
  const back = track.paths.add({ points: ring(-1).map((v) => C + (v - C) * 1.05), loop: true });
  track.spawn({ path: out, at: 12, cruise: 1.6, accel: 0.6, decel: 1.2, gap: 1.2, tag: TRACK_TAG.cart });
  // The gap is kept from the position (the cart's rear axle) of the one ahead, so the first porter keeps clear of
  // the trailer behind it.
  for (let i = 0; i < 3; i++) track.spawn({ path: out, at: 5 - i * 2.2, cruise: 1.5 + 0.1 * i, accel: 0.9, decel: 1.8, gap: i === 0 ? 5.6 : 1.1, tag: TRACK_TAG.porter });
  for (let i = 0; i < 2; i++) track.spawn({ path: back, at: 40 + i * 2.4, cruise: 1.3 + 0.12 * i, accel: 0.9, decel: 1.8, gap: 1.2, tag: TRACK_TAG.porter });
  sim.addSystem('track', track.system);
  return { sim, nav, figures, track };
}
