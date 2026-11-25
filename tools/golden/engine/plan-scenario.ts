// Scenarios for the golden hashes of the plan of a sphere (gen-plan): the grid, drainage and channels, line tiles,
// the weights of a grid sample, least-cost routes and the skyline field. Engine code only. Each returns plain data to
// hash and throws when a property that must hold does not.

import type { Vec3 } from '../../../packages/wallhammer-web/src/base/index.ts';
import { cubeDirection, cubeGrid, fractalNoise3, hashInts, rand } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import type { CellId } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import {
  HORIZON_AXES, channelFlow, channelOrder, classifyByThresholds, drainGrid, fallingGrade, gridDirection, gridNeighbours, gridNodeArea, gridNodeAt, gridSample, gridWeights, horizonCodeAt,
  horizonField, horizonLit, limitGrade, lineAt, lineLengths, lineTiles, regionLinks, routeGrid, routeRegions, smoothLine, sphereGrid,
  tileLinesAt, tileLinesOfCell, traceChannels,
} from '../../../packages/wallhammer-web/src/gen-plan/index.ts';
import type { SphereGrid } from '../../../packages/wallhammer-web/src/gen-plan/index.ts';

const fail = (what: string): never => {
  throw new Error(what);
};
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a: Vec3, b: Vec3): number => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))));

/** The twelve edges of the cube (middle and a direction across it) and its eight corners. */
const FACES: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function cubeEdges(): { mid: Vec3; across: Vec3 }[] {
  const out: { mid: Vec3; across: Vec3 }[] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const a = FACES[i]!;
      const b = FACES[j]!;
      if (dot(a, b) !== 0) continue;
      out.push({ mid: norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]), across: norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) });
    }
  }
  return out;
}
function cubeCorners(): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push(norm([x, y, z]));
  return out;
}
/** A unit vector square to `v`. */
function square(v: Vec3, hint: Vec3 = [0.3, 0.8, 0.52]): Vec3 {
  const d = dot(v, hint);
  return norm([hint[0] - v[0] * d, hint[1] - v[1] * d, hint[2] - v[2] * d]);
}
/** The point at angle `t` along the great circle through `p` toward the unit tangent `u`. */
const arcPoint = (p: Vec3, u: Vec3, t: number): Vec3 => {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c * p[0] + s * u[0], c * p[1] + s * u[1], c * p[2] + s * u[2]];
};

/** Field of one hashed value per node. */
function hashedField(g: SphereGrid, seed: number): Float32Array {
  return Float32Array.from({ length: g.count }, (_, i) => rand(seed, i) * 100);
}

/**
 * The grid at levels 3 and 5: symmetric neighbours (7 at the 24 corner nodes, else 8, none farther than 2.2 nominal
 * steps), node at its own direction, areas summing to the sphere, `gridSample` exact at node middles, inside the
 * field's range, and continuous along arcs over all 12 edges and through all 8 corners of the cube.
 */
export function planGridScript(): unknown[] {
  const out: unknown[] = [];
  const nb = new Int32Array(8);
  const nb2 = new Int32Array(8);
  for (const level of [3, 5]) {
    const R = 6000;
    const g = sphereGrid(R, level);
    const nominal = (Math.PI / 2 / g.n);
    let corners = 0;
    let area = 0;
    const counts = new Uint8Array(g.count);
    const d: Vec3 = [0, 0, 0];
    const e: Vec3 = [0, 0, 0];
    for (let i = 0; i < g.count; i++) {
      const k = gridNeighbours(g, i, nb);
      counts[i] = k;
      if (k === 7) corners++;
      else if (k !== 8) fail(`grid ${level}: node ${i} has ${k} neighbours`);
      gridDirection(g, i, d);
      if (gridNodeAt(g, d[0], d[1], d[2]) !== i) fail(`grid ${level}: gridNodeAt(gridDirection(${i})) differs`);
      for (let j = 0; j < k; j++) {
        const v = nb[j]!;
        gridDirection(g, v, e);
        if (angle(d, e) > 2.2 * nominal) fail(`grid ${level}: neighbour ${v} of ${i} is ${(angle(d, e) / nominal).toFixed(2)} steps away`);
        const kk = gridNeighbours(g, v, nb2);
        let back = false;
        for (let q = 0; q < kk; q++) if (nb2[q] === i) back = true;
        if (!back) fail(`grid ${level}: ${v} is a neighbour of ${i} but not the other way`);
      }
      area += gridNodeArea(g, i);
    }
    if (corners !== 24) fail(`grid ${level}: ${corners} nodes with 7 neighbours, not 24`);
    const sphere = 4 * Math.PI * R * R;
    // The closed form is taken at the middle of each cell (a midpoint rule): its error falls with the square of the
    // node size, about 0.24 % at level 3 and 0.015 % at level 5.
    if (Math.abs(area / sphere - 1) > (level <= 3 ? 3e-3 : 1e-3)) fail(`grid ${level}: areas sum to ${area}, sphere ${sphere}`);
    // gridSample: exact at the middles, inside the range, continuous over edges and corners.
    const field = hashedField(g, 31 + level);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of field) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    let maxDiff = 0;
    for (let i = 0; i < g.count; i++) {
      const k = gridNeighbours(g, i, nb);
      for (let j = 0; j < k; j++) maxDiff = Math.max(maxDiff, Math.abs(field[i]! - field[nb[j]!]!));
      gridDirection(g, i, d);
      // Bilinear weights from the face coordinates of a node middle are 1 and 0 to rounding, not bit for bit.
      if (Math.abs(gridSample(g, field, d[0], d[1], d[2]) - field[i]!) > 1e-12 * (hi + 1)) fail(`grid ${level}: gridSample at node ${i} is not its value`);
    }
    const STEP = 1e-6;
    const SPAN = 0.6 * nominal;
    const walks: { p: Vec3; u: Vec3 }[] = [];
    for (const edge of cubeEdges()) walks.push({ p: edge.mid, u: edge.across });
    for (const c of cubeCorners()) {
      walks.push({ p: c, u: square(c) });
      walks.push({ p: c, u: square(c, [0.9, -0.2, 0.4]) });
    }
    let worst = 0;
    const samples: number[] = [];
    for (const w of walks) {
      let prev = NaN;
      for (let t = -SPAN; t <= SPAN; t += STEP) {
        const p = arcPoint(w.p, w.u, t);
        const v = gridSample(g, field, p[0], p[1], p[2]);
        if (!(v >= lo - 1e-9 && v <= hi + 1e-9)) fail(`grid ${level}: gridSample ${v} outside ${lo}…${hi}`);
        if (prev === prev) worst = Math.max(worst, Math.abs(v - prev));
        prev = v;
      }
      const m = arcPoint(w.p, w.u, 0);
      samples.push(gridSample(g, field, m[0], m[1], m[2]));
    }
    if (worst > 1e-3 * maxDiff) fail(`grid ${level}: gridSample jumps by ${worst} over a step of ${STEP} rad (largest neighbour difference ${maxDiff})`);
    out.push({ level, count: g.count, corners, area }, counts, Float64Array.from(samples));
  }
  return out;
}

/** Heights of a level-5 grid of radius 10 km: fractal noise with one carved hollow. */
function drainHeights(g: SphereGrid): Float32Array {
  const d: Vec3 = [0, 0, 0];
  const hollow = norm([0.35, 0.8, -0.2]);
  return Float32Array.from({ length: g.count }, (_, i) => {
    gridDirection(g, i, d);
    const n = fractalNoise3(d[0] * g.radiusM, d[1] * g.radiusM, d[2] * g.radiusM, { cellM: 4000, octaves: 4 }, 725);
    const a = angle(d, hollow);
    const carve = a < 0.25 ? 220 * (1 - a / 0.25) : 0;
    return (n - 0.42) * 900 - carve + 400 * Math.max(0, 0.2 - a);
  });
}

/**
 * Drainage and channels on a level-5 grid: filled over heights, `to` never climbs the filled height, every node
 * reaches a base node, `order` puts each node before its `to`, the flow at the base nodes is the total supply, pools
 * meet both limits with the sill outside, a grid without base nodes drains to its lowest node; channels follow `to`,
 * hold `minFlow` but at their end, agree with `into` and come upper before lower; `fallingGrade` never rises and
 * `smoothLine` keeps the ends and unit length.
 */
export function drainageScript(): unknown[] {
  const g = sphereGrid(10_000, 5);
  const heights = drainHeights(g);
  const supply = Float32Array.from({ length: g.count }, (_, i) => 0.5 + rand(5, i));
  const MIN_POOL_NODES = 4;
  const MIN_POOL_DEPTH = 3;
  const d = drainGrid(g, heights, { baseLevel: 0, supply, minPoolNodes: MIN_POOL_NODES, minPoolDepth: MIN_POOL_DEPTH });
  const count = g.count;
  let bases = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += supply[i]!;
    if (d.filled[i]! < Math.fround(heights[i]!)) fail(`drain: filled under the height at ${i}`);
    const t = d.to[i]!;
    if (t === -1) {
      bases++;
      continue;
    }
    if (d.filled[t]! > d.filled[i]!) fail(`drain: ${i} drains up to ${t}`);
    let steps = 0;
    for (let c = i; d.to[c] !== -1; c = d.to[c]!) if (++steps >= count) fail(`drain: ${i} never reaches a base node`);
  }
  if (bases === 0) fail('drain: no base node in the test field');
  const seen = new Uint8Array(count);
  const place = new Int32Array(count);
  d.order.forEach((n, k) => {
    if (seen[n]) fail(`drain: node ${n} twice in order`);
    seen[n] = 1;
    place[n] = k;
  });
  for (let i = 0; i < count; i++) if (d.to[i]! >= 0 && place[i]! > place[d.to[i]!]!) fail(`drain: ${i} comes after the node it drains to`);
  let atBase = 0;
  for (let i = 0; i < count; i++) if (d.to[i] === -1) atBase += d.flow[i]!;
  if (Math.abs(atBase / total - 1) > 1e-5) fail(`drain: flow at the base nodes ${atBase}, supply ${total}`);
  const pools = d.pools.level.length;
  for (let k = 0; k < pools; k++) {
    let nodes = 0;
    let deepest = 0;
    for (let i = 0; i < count; i++) {
      if (d.pool[i] !== k + 1) continue;
      nodes++;
      deepest = Math.max(deepest, d.pools.level[k]! - Math.fround(heights[i]!));
      if (d.filled[i] !== d.pools.level[k]) fail(`drain: pool ${k} node ${i} not at the pool's level`);
    }
    if (nodes !== d.pools.nodes[k] || nodes < MIN_POOL_NODES || deepest < MIN_POOL_DEPTH) fail(`drain: pool ${k} has ${nodes} nodes, depth ${deepest}`);
    const o = d.pools.outlet[k]!;
    if (o < 0 || d.pool[o] === k + 1) fail(`drain: the outlet ${o} of pool ${k} lies in it`);
    if (d.filled[o]! > d.pools.level[k]!) fail(`drain: the outlet of pool ${k} lies above its level`);
  }
  if (pools === 0) fail('drain: the carved hollow made no pool');
  // No base node: everything drains to the lowest node.
  const high = Float32Array.from(heights, (h) => h + 5000);
  const dh = drainGrid(g, high, { baseLevel: 0, minPoolNodes: MIN_POOL_NODES, minPoolDepth: MIN_POOL_DEPTH });
  let lowest = 0;
  for (let i = 1; i < count; i++) if (high[i]! < high[lowest]!) lowest = i;
  for (let i = 0; i < count; i++) if ((dh.to[i] === -1) !== (i === lowest)) fail(`drain: without a base node ${i} has to = ${dh.to[i]}`);
  // Channels.
  const MIN_FLOW = 12;
  const ch = traceChannels(g, d, { minFlow: MIN_FLOW });
  const channels = ch.start.length - 1;
  if (channels < 3) fail(`channels: only ${channels}`);
  const first = new Int32Array(count).fill(-1);
  for (let c = 0; c < channels; c++) first[ch.nodes[ch.start[c]!]!] = c;
  let lastPlace = -1;
  for (let c = 0; c < channels; c++) {
    const a = ch.start[c]!;
    const b = ch.start[c + 1]!;
    if (b - a < 2) fail(`channels: channel ${c} has ${b - a} nodes`);
    for (let k = a; k < b - 1; k++) {
      const n = ch.nodes[k]!;
      if (d.to[n] !== ch.nodes[k + 1]) fail(`channels: channel ${c} leaves to at node ${n}`);
      if (d.flow[n]! < MIN_FLOW) fail(`channels: channel ${c} node ${n} carries ${d.flow[n]}`);
    }
    const end = ch.nodes[b - 1]!;
    const into = ch.into[c]!;
    if (into === -1 && d.to[end] !== -1) fail(`channels: channel ${c} says base but ends in ${end}`);
    if (into <= -2 && d.pool[end] !== -1 - into) fail(`channels: channel ${c} says pool ${-2 - into}, its end is in ${d.pool[end]! - 1}`);
    if (into >= 0 && first[end] !== into) fail(`channels: channel ${c} says ${into}, ends in ${end}`);
    const p = place[ch.nodes[a]!]!;
    if (p <= lastPlace) fail(`channels: channel ${c} out of order`);
    lastPlace = p;
  }
  // fallingGrade and smoothLine.
  const profile = Float64Array.from({ length: 40 }, (_, i) => 50 - i + 8 * rand(9, i));
  const falling = fallingGrade(profile, 0.25);
  for (let i = 1; i < falling.length; i++) if (falling[i]! > falling[i - 1]! - 0.25 || falling[i]! > profile[i]!) fail('fallingGrade rises');
  const line = new Float64Array(3 * 30);
  for (let i = 0; i < 30; i++) {
    const p = norm([1, 0.02 * i + 0.01 * rand(3, i), 0.3 * rand(4, i) - 0.15]);
    line.set(p, 3 * i);
  }
  const smooth = smoothLine(line, 8);
  for (const k of [0, 1, 2, 87, 88, 89]) if (smooth[k] !== line[k]) fail('smoothLine moved an end');
  for (let i = 0; i < 30; i++) if (Math.abs(Math.hypot(smooth[3 * i]!, smooth[3 * i + 1]!, smooth[3 * i + 2]!) - 1) > 1e-12) fail('smoothLine: not unit');
  return [d.filled, d.to, d.order, d.flow, d.pool, d.pools.level, d.pools.nodes, d.pools.outlet, dh.to, ch.start, ch.nodes, ch.into, falling, smooth];
}

/**
 * "gen-plan channel order and classes": the Strahler order of the channels of the drainage test field (1 where nothing
 * runs in, else the highest inflow, plus 1 when two share it; brute force over the inflows), the flow along every
 * channel (the node's flow, never falling within a channel, `out` the entry before the end), classes by thresholds
 * (brute force: the count of thresholds reached; NaN class 0; a decreasing list throws), a hand-built tree, an `into`
 * that points upstream throws, and the channels of a drainage made by hand over a plane grid (no sphere grid).
 */
export function channelClassesScript(): unknown[] {
  const g = sphereGrid(10_000, 5);
  const heights = drainHeights(g);
  const supply = Float32Array.from({ length: g.count }, (_, i) => 0.5 + rand(5, i));
  const d = drainGrid(g, heights, { baseLevel: 0, supply, minPoolNodes: 4, minPoolDepth: 3 });
  const ch = traceChannels(g, d, { minFlow: 2 });
  const n = ch.into.length;
  const order = channelOrder(ch);
  // Brute force: the orders of the channels that run into each one.
  const inflows: number[][] = Array.from({ length: n }, () => []);
  for (let c = 0; c < n; c++) if (ch.into[c]! >= 0) inflows[ch.into[c]!]!.push(c);
  let highest = 0;
  for (let c = 0; c < n; c++) {
    const ins = inflows[c]!.map((k) => order[k]!);
    const top = ins.length === 0 ? 0 : Math.max(...ins);
    const want = ins.length === 0 ? 1 : top + (ins.filter((o) => o === top).length >= 2 ? 1 : 0);
    if (order[c] !== want) fail(`channel order: channel ${c} has ${order[c]}, want ${want}`);
    highest = Math.max(highest, order[c]!);
  }
  if (highest < 3) fail(`channel order: highest only ${highest}`);
  const flow = channelFlow(ch, d.flow);
  for (let c = 0; c < n; c++) {
    const a = ch.start[c]!;
    const b = ch.start[c + 1]!;
    for (let k = a; k < b; k++) {
      if (flow.along[k] !== d.flow[ch.nodes[k]!]) fail(`channel flow: entry ${k} is not its node's flow`);
      if (k > a && flow.along[k]! < flow.along[k - 1]!) fail(`channel flow: falls along channel ${c}`);
    }
    if (flow.out[c] !== flow.along[b - 2]) fail(`channel flow: out of channel ${c}`);
  }
  const thresholds = [10, 25, 25, 80];
  const classes = classifyByThresholds(flow.out, thresholds);
  for (let c = 0; c < n; c++) {
    const want = thresholds.filter((t) => flow.out[c]! >= t).length;
    if (classes[c] !== want) fail(`classes: channel ${c} has ${classes[c]}, want ${want}`);
  }
  const edge = classifyByThresholds([Number.NaN, -Infinity, 9.99, 10, 25, 79, 80, Infinity], thresholds);
  if (edge.join() !== '0,0,0,1,3,3,4,4') fail(`classes: edge values ${edge.join()}`);
  let threw = false;
  try {
    classifyByThresholds([1], [2, 1]);
  } catch {
    threw = true;
  }
  if (!threw) fail('classes: decreasing thresholds did not throw');
  // A tree by hand: 0 and 1 meet in 2 (order 2); 3 runs alone into 4 (order 1 stays 1), 4 and 5 meet in 6 (2); 2 and 6
  // meet in 7 (3); 7 and 8 (order 1) meet in 9 (3 stays 3).
  const hand = channelOrder({ into: Int32Array.from([2, 2, 7, 4, 6, 6, 7, 9, 9, -1]) });
  if (hand.join() !== '1,1,2,1,1,1,2,3,1,3') fail(`channel order by hand: ${hand.join()}`);
  threw = false;
  try {
    channelOrder({ into: Int32Array.from([-1, 0]) });
  } catch {
    threw = true;
  }
  if (!threw) fail('channel order: an into that points upstream did not throw');
  // A drainage made by hand over a plane grid of 6 × 6 nodes falling toward x = 0, the column x = 0 the base; every
  // node drains straight down the slope, and two side rows join row 2 at x = 3.
  const N = 6;
  const to = new Int32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) to[j * N + i] = i === 0 ? -1 : j * N + i - 1;
  to[1 * N + 4] = 2 * N + 3;
  to[3 * N + 4] = 2 * N + 3;
  const planeOrder = new Uint32Array(N * N);
  for (let k = 0, i = N - 1; i >= 0; i--) for (let j = 0; j < N; j++) planeOrder[k++] = j * N + i;
  const planeFlow = new Float32Array(N * N).fill(1);
  for (const i of planeOrder) if (to[i]! >= 0) planeFlow[to[i]!] = planeFlow[to[i]!]! + planeFlow[i]!;
  const plane = traceChannels({ count: N * N }, { to, flow: planeFlow, pool: new Uint16Array(N * N), order: planeOrder }, { minFlow: 2 });
  const planeOrders = channelOrder(plane);
  if (Math.max(...planeOrders) !== 2) fail(`plane channels: highest order ${Math.max(...planeOrders)}`);
  return [order, flow.along, flow.out, classes, edge, hand, plane.start, plane.nodes, plane.into, planeOrders];
}

/** Chord distance (radians, small) from a direction to the segment of two directions, on the unit sphere. */
function segmentAngle(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const ll = dot(ab, ab);
  const t = ll > 0 ? Math.max(0, Math.min(1, dot(ap, ab) / ll)) : 0;
  const q = norm([a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
  return angle(p, q);
}

/** The brute-force lines of a cell from the tile table: the tile that holds it or every tile under it. */
function bruteCellLines(t: { level: number; keys: Uint32Array; start: Uint32Array; lines: Uint32Array }, cell: CellId): number[] {
  const n = 2 ** t.level;
  const set = new Set<number>();
  for (let k = 0; k < t.keys.length; k++) {
    const key = t.keys[k]!;
    const face = Math.floor(key / (n * n));
    const y = Math.floor((key % (n * n)) / n);
    const x = key % n;
    if (face !== cell.face) continue;
    let under: boolean;
    if (cell.level >= t.level) {
      const s = 2 ** (cell.level - t.level);
      under = Math.floor(cell.x / s) === x && Math.floor(cell.y / s) === y;
    } else {
      const s = 2 ** (t.level - cell.level);
      under = Math.floor(x / s) === cell.x && Math.floor(y / s) === cell.y;
    }
    if (under) for (let i = t.start[k]!; i < t.start[k + 1]!; i++) set.add(t.lines[i]!);
  }
  return [...set].sort((a, b) => a - b);
}

/** Lines over an edge and beside a corner of the cube for the tile index: start, points and reach. */
export function testLines(): { start: Uint32Array; points: Float64Array; reachM: Float64Array } {
  const lines: Vec3[][] = [];
  // Over the edge between +x and +y.
  lines.push(Array.from({ length: 24 }, (_, i) => norm([1, 0.6 + 0.04 * i, 0.1 + 0.01 * i])));
  // Beside the corner (1, 1, 1).
  lines.push(Array.from({ length: 18 }, (_, i) => norm([1, 0.95 - 0.004 * i, 0.9 + 0.012 * i])));
  // Inside the face −z.
  lines.push(Array.from({ length: 10 }, (_, i) => norm([0.2 + 0.03 * i, -0.1, -1])));
  const start = new Uint32Array(lines.length + 1);
  const pts: number[] = [];
  lines.forEach((l, i) => {
    start[i + 1] = start[i]! + l.length;
    for (const p of l) pts.push(...p);
  });
  return { start, points: Float64Array.from(pts), reachM: Float64Array.of(900, 400, 1500) };
}

/** Line tiles of level 4: every hashed point within reach of a line finds it; `tileLinesOfCell` = the brute force; corner tips. */
export function lineTilesScript(): unknown[] {
  const R = 100_000;
  const { start, points, reachM } = testLines();
  const t = lineTiles({ level: 4, radiusM: R, start, points, reachM });
  const lines = start.length - 1;
  const pt = (i: number): Vec3 => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!];
  let found = 0;
  for (let s = 0; s < 4000; s++) {
    const line = s % lines;
    const i = start[line]! + Math.floor(rand(41, s) * (start[line + 1]! - start[line]!));
    const p = pt(i);
    const off = norm([p[0] + (rand(42, s) - 0.5) * 0.04, p[1] + (rand(43, s) - 0.5) * 0.04, p[2] + (rand(44, s) - 0.5) * 0.04]);
    let near = Infinity;
    for (let k = start[line]!; k < start[line + 1]! - 1; k++) near = Math.min(near, segmentAngle(off, pt(k), pt(k + 1)));
    if (near * R > reachM[line]!) continue;
    found++;
    const r = tileLinesAt(t, off[0], off[1], off[2]);
    let has = false;
    if (r) for (let k = r.from; k < r.to; k++) if (t.lines[k] === line) has = true;
    if (!has) fail(`line tiles: a point ${(near * R).toFixed(0)} m from line ${line} does not find it`);
  }
  if (found < 200) fail(`line tiles: only ${found} points within reach`);
  const cells: number[][] = [];
  const outCell: number[] = [];
  for (const level of [0, 2, 4, 6]) {
    const n = 2 ** level;
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < n; y += Math.max(1, n >> 3)) {
        for (let x = 0; x < n; x += Math.max(1, n >> 3)) {
          const cell: CellId = { face, level, x, y };
          const got = [...tileLinesOfCell(t, cell, outCell)];
          const want = bruteCellLines(t, cell);
          if (got.join() !== want.join()) fail(`line tiles: cell ${face}/${level}/${x}/${y} gives ${got} not ${want}`);
          if (got.length) cells.push([face, level, x, y, ...got]);
        }
      }
    }
  }
  return [t.keys, t.start, t.lines, cells, found, cornerTipScript(4), cornerTipScript(5)];
}

/**
 * A short segment across an edge of the cube that passes the side tip of a corner tile (where its 60° angle meets the
 * edge) on the far side, 2 m from it, with a reach of 20 m: the corner tiles of both faces at the tip must list it. The
 * segment is short so that the bound on the tile radius, not half its length, decides whether the corner tiles are met.
 */
function cornerTipScript(level: number): unknown[] {
  const R = 100_000;
  const n = 2 ** level;
  const r = Math.PI / (2 * n);
  // The tip on face 0: grid line n − 1 along s, the edge t = 1; away from the corner is towards smaller s.
  const tip = cubeDirection(0, cubeGrid(n - 1, n), 1);
  const next = cubeDirection(0, cubeGrid(n - 1, n) - 1e-3, 1);
  let e: Vec3 = [next[0] - tip[0], next[1] - tip[1], next[2] - tip[2]];
  const et = dot(e, tip);
  e = norm([e[0] - et * tip[0], e[1] - et * tip[1], e[2] - et * tip[2]]);
  const across = norm([tip[1] * e[2] - tip[2] * e[1], tip[2] * e[0] - tip[0] * e[2], tip[0] * e[1] - tip[1] * e[0]]);
  const at = (de: number, da: number): Vec3 =>
    norm([tip[0] + de * e[0] + da * across[0], tip[1] + de * e[1] + da * across[1], tip[2] + de * e[2] + da * across[2]]);
  const d = 2 / R;
  const a = at(d, -0.01 * r);
  const b = at(d, 0.01 * r);
  const t = lineTiles({ level, radiusM: R, start: Uint32Array.of(0, 2), points: Float64Array.of(...a, ...b), reachM: Float64Array.of(20) });
  const g = sphereGrid(1, level);
  const nb = new Int32Array(8);
  const corners: number[] = [];
  for (const side of [-1, 1]) {
    const p = at(-0.02 * r, side * 0.003 * r);
    const node = gridNodeAt(g, p[0], p[1], p[2]);
    if (gridNeighbours(g, node, nb) !== 7) fail(`line tiles: level ${level} point ${side} is not in a corner tile`);
    const got = tileLinesAt(t, p[0], p[1], p[2]);
    if (!got || got.to - got.from !== 1 || t.lines[got.from] !== 0) fail(`line tiles: level ${level} corner tile ${node} misses the line at its tip`);
    corners.push(node);
  }
  if (corners[0] === corners[1]) fail(`line tiles: level ${level} both points in one corner tile`);
  return [level, corners, t.keys];
}

/** `gridWeights` reproduces `gridSample` bit for bit inside a face, across an edge and at a corner of the cube. */
export function gridWeightsScript(): unknown[] {
  const out: unknown[] = [];
  const nodes = new Int32Array(4);
  const weights = new Float64Array(4);
  for (const level of [2, 5]) {
    const g = sphereGrid(1, level);
    const field = hashedField(g, 77 + level);
    const points: Vec3[] = [];
    for (let s = 0; s < 300; s++) points.push(norm([rand(1, s) * 2 - 1, rand(2, s) * 2 - 1, rand(3, s) * 2 - 1]));
    for (const e of cubeEdges()) for (const t of [-1e-4, 0, 1e-4, 0.01]) points.push(arcPoint(e.mid, e.across, t));
    for (const c of cubeCorners()) for (const t of [0, 1e-5, 0.02]) points.push(arcPoint(c, square(c), t));
    let threes = 0;
    for (const p of points) {
      const k = gridWeights(g, p[0], p[1], p[2], nodes, weights);
      if (k === 3) threes++;
      let sum = 0;
      let wsum = 0;
      for (let j = 0; j < k; j++) {
        sum += weights[j]! * field[nodes[j]!]!;
        wsum += weights[j]!;
      }
      if (sum !== gridSample(g, field, p[0], p[1], p[2])) fail(`gridWeights: level ${level} differs from gridSample at ${p}`);
      if (Math.abs(wsum - 1) > 1e-12) fail(`gridWeights: weights sum to ${wsum}`);
      out.push(k, nodes.slice(0, k), weights.slice(0, k));
    }
    if (threes === 0) fail('gridWeights: no corner case met');
  }
  return out;
}

/** Brute-force least costs from one node over the whole small grid (Bellman-Ford). */
function bruteCosts(g: SphereGrid, from: number, cost: (a: number, b: number) => number): Float64Array {
  const best = new Float64Array(g.count).fill(Infinity);
  best[from] = 0;
  const nb = new Int32Array(8);
  for (let changed = true; changed; ) {
    changed = false;
    for (let u = 0; u < g.count; u++) {
      if (best[u] === Infinity) continue;
      const k = gridNeighbours(g, u, nb);
      for (let j = 0; j < k; j++) {
        const v = nb[j]!;
        const c = cost(u, v);
        if (c !== Infinity && best[u]! + c < best[v]!) {
          best[v] = best[u]! + c;
          changed = true;
        }
      }
    }
  }
  return best;
}

/**
 * Routes on `sphereGrid(1000, 4)`: steps are neighbour steps, costs equal the brute force, routes over an edge and a
 * corner of the cube, ties give the same array twice, a small `maxNodes` and a closed ring give null; regions agree
 * with single routes and `prev` leads to the owner; links sorted and minimal; `limitGrade` and `lineAt`.
 */
export function routesScript(): unknown[] {
  const g = sphereGrid(1000, 4);
  const heights = Float64Array.from({ length: g.count }, (_, i) => (hashInts(11, i) % 1000) / 10);
  const dir: Vec3 = [0, 0, 0];
  const dir2: Vec3 = [0, 0, 0];
  const cost = (a: number, b: number): number => {
    gridDirection(g, a, dir);
    gridDirection(g, b, dir2);
    const len = Math.hypot(dir[0] - dir2[0], dir[1] - dir2[1], dir[2] - dir2[2]) * 1000;
    return len * (1 + Math.abs(heights[a]! - heights[b]!) / 10);
  };
  const nb = new Int32Array(8);
  const isNeighbour = (a: number, b: number): boolean => {
    const k = gridNeighbours(g, a, nb);
    for (let j = 0; j < k; j++) if (nb[j] === b) return true;
    return false;
  };
  const pathCost = (p: Uint32Array, c: (a: number, b: number) => number): number => {
    let s = 0;
    for (let i = 1; i < p.length; i++) s += c(p[i - 1]!, p[i]!);
    return s;
  };
  const out: unknown[] = [];
  // Pairs over an edge and past a corner of the cube, and inside a face.
  const n = g.n;
  const node = (f: number, x: number, y: number): number => f * n * n + y * n + x;
  const pairs: [number, number][] = [[node(0, 2, 3), node(0, 13, 12)], [node(0, n - 1, 5), node(2, 3, 9)], [node(0, n - 1, n - 1), node(4, 1, 1)], [node(1, 0, 0), node(3, 8, 8)]];
  for (const [from, to] of pairs) {
    const r = routeGrid(g, { from, to, cost, maxNodes: g.count });
    if (!r || r[0] !== from || r[r.length - 1] !== to) fail(`routeGrid: no route ${from} → ${to}`);
    for (let i = 1; i < r.length; i++) if (!isNeighbour(r[i - 1]!, r[i]!)) fail(`routeGrid: ${r[i - 1]} → ${r[i]} is not a step`);
    const brute = bruteCosts(g, from, cost);
    const c = pathCost(r, cost);
    if (Math.abs(c - brute[to]!) > 1e-9 * c) fail(`routeGrid: cost ${c}, brute force ${brute[to]}`);
    out.push(r);
  }
  // Ties everywhere: the same array twice.
  const flat = (): number => 1;
  const t1 = routeGrid(g, { from: pairs[1]![0], to: pairs[1]![1], cost: flat, maxNodes: g.count });
  const t2 = routeGrid(g, { from: pairs[1]![0], to: pairs[1]![1], cost: flat, maxNodes: g.count });
  if (!t1 || !t2 || t1.join() !== t2.join()) fail('routeGrid: ties gave two answers');
  out.push(t1);
  if (routeGrid(g, { from: pairs[0]![0], to: pairs[0]![1], cost, maxNodes: 5 }) !== null) fail('routeGrid: a small maxNodes still found a route');
  // A closed ring round the target.
  const target = node(2, 8, 8);
  const ring = new Set<number>();
  gridNeighbours(g, target, nb);
  for (const v of nb) ring.add(v);
  const closed = (a: number, b: number): number => (ring.has(b) && !ring.has(a) && b !== target ? Infinity : ring.has(a) && b === target ? Infinity : cost(a, b));
  if (routeGrid(g, { from: node(5, 3, 3), to: target, cost: closed, maxNodes: g.count }) !== null) fail('routeGrid: crossed a closed ring');
  // Regions.
  const sources = [node(0, 4, 4), node(2, 10, 3), node(4, 7, 12), node(5, 1, 14)];
  const reg = routeRegions(g, { sources, cost, maxNodes: g.count });
  const brutes = sources.map((s) => bruteCosts(g, s, cost));
  for (let i = 0; i < g.count; i += 7) {
    let best = Infinity;
    for (const b of brutes) best = Math.min(best, b[i]!);
    if (Math.abs(reg.cost[i]! - best) > 1e-9 * Math.max(1, best)) fail(`routeRegions: node ${i} cost ${reg.cost[i]}, least ${best}`);
    let c = i;
    let steps = 0;
    while (reg.prev[c] !== -1) {
      if (reg.owner[reg.prev[c]!] !== reg.owner[i]) fail(`routeRegions: prev of ${c} leaves the region`);
      c = reg.prev[c]!;
      if (++steps > g.count) fail('routeRegions: prev loops');
    }
    if (c !== sources[reg.owner[i]!]) fail(`routeRegions: prev of ${i} does not lead to its source`);
  }
  const links = regionLinks(g, reg, cost);
  for (let k = 0; k < links.a.length; k++) {
    if (!(links.a[k]! < links.b[k]!)) fail('regionLinks: a ≥ b');
    if (k > 0 && (links.a[k - 1]! > links.a[k]! || (links.a[k - 1] === links.a[k] && links.b[k - 1]! >= links.b[k]!))) fail('regionLinks: not sorted');
    // Minimal: no other step between the two regions is cheaper.
    for (let u = 0; u < g.count; u++) {
      if (reg.owner[u] !== links.a[k]) continue;
      const kk = gridNeighbours(g, u, nb);
      for (let j = 0; j < kk; j++) {
        const v = nb[j]!;
        if (reg.owner[v] !== links.b[k]) continue;
        const c = reg.cost[u]! + cost(u, v) + reg.cost[v]!;
        if (c < links.cost[k]! - 1e-9 * c) fail(`regionLinks: a cheaper step ${u} → ${v} between ${links.a[k]} and ${links.b[k]}`);
      }
    }
  }
  if (links.a.length < 3) fail(`regionLinks: only ${links.a.length} links`);
  out.push(reg.owner, reg.cost, reg.prev, links.a, links.b, links.cost, links.nodeA, links.nodeB);
  // limitGrade on 50 hashed profiles.
  const G = 0.08;
  for (let p = 0; p < 50; p++) {
    const m = 5 + (hashInts(21, p) % 30);
    const s = new Float64Array(m);
    const h = new Float64Array(m);
    for (let i = 1; i < m; i++) s[i] = s[i - 1]! + 2 + 20 * rand(22, p, i);
    const gentle = p % 5 === 0 && p % 7 !== 1;
    for (let i = 0; i < m; i++) h[i] = gentle ? 10 + 0.5 * G * s[i]! : 10 + 30 * rand(23, p, i);
    if (p % 7 === 1) h[m - 1] = h[0]! + 2 * G * s[m - 1]! + 5;
    const r = limitGrade(s, h, G);
    if (r[0] !== h[0] || r[m - 1] !== h[m - 1]) fail(`limitGrade: profile ${p} lost an end`);
    const broken = Math.abs(h[m - 1]! - h[0]!) > G * s[m - 1]!;
    for (let i = 1; i < m; i++) {
      const dz = Math.abs(r[i]! - r[i - 1]!);
      if (!broken && dz > G * (s[i]! - s[i - 1]!) * (1 + 1e-9) + 1e-9) fail(`limitGrade: profile ${p} step ${i} rises ${dz}`);
    }
    if (gentle) for (let i = 0; i < m; i++) if (r[i] !== h[i]) fail(`limitGrade: gentle profile ${p} changed`);
    if (broken) for (let i = 0; i < m; i++) if (Math.abs(r[i]! - (h[0]! + ((h[m - 1]! - h[0]!) * s[i]!) / s[m - 1]!)) > 1e-9) fail(`limitGrade: broken profile ${p} is not the ramp`);
    out.push(r);
  }
  // lineAt.
  const { start, points } = testLines();
  const line = points.subarray(0, 3 * start[1]!);
  const lengths = lineLengths(line, 100_000);
  const at = { dir: [0, 0, 0] as Vec3, heading: [0, 0, 0] as Vec3 };
  for (let i = 0; i < lengths.length; i++) {
    lineAt(line, lengths, lengths[i]!, at);
    const p: Vec3 = [line[3 * i]!, line[3 * i + 1]!, line[3 * i + 2]!];
    if (Math.hypot(at.dir[0] - p[0], at.dir[1] - p[1], at.dir[2] - p[2]) > 1e-12) fail(`lineAt: point ${i} is not at its own length`);
    if (Math.abs(dot(at.dir, at.heading)) > 1e-9 || Math.abs(Math.hypot(...at.heading) - 1) > 1e-9 || Math.abs(Math.hypot(...at.dir) - 1) > 1e-9) fail('lineAt: dir and heading not unit and square');
    out.push(Float64Array.from([...at.dir, ...at.heading]));
  }
  return out;
}

/**
 * The skyline field on `sphereGrid(10_000, 5)`: flat gives code 0 and full light; one raised block lifts only the axes
 * pointing toward it within reach; raising heights never lowers a value; the table size and the order of asking change
 * nothing; at a node the code is the node's; along walks over an edge, a corner and through the axes the light moves
 * less than 0.05 per eighth of a node step.
 */
export function planHorizonScript(): unknown[] {
  const g = sphereGrid(10_000, 5);
  const o = { reachM: 2500, steps: 12 };
  const code = new Uint8Array(4);
  const code2 = new Uint8Array(4);
  const d: Vec3 = [0, 0, 0];
  // Flat.
  const flat = new Float32Array(g.count);
  const ff = horizonField(g, flat, 1, o);
  for (let s = 0; s < 200; s++) {
    const p = norm([rand(51, s) - 0.5, rand(52, s) - 0.5, rand(53, s) - 0.5]);
    horizonCodeAt(ff, p[0], p[1], p[2], code);
    if (code.some((c) => c !== 0)) fail('horizon: a flat field has a skyline');
    const l = norm([p[0] + 0.3 * (rand(54, s) - 0.5), p[1] + 0.3, p[2]]);
    if (dot(l, p) > 0.01 && horizonLit(code, p, l, 0.02) !== 1) fail('horizon: a flat field shades a light above the plane');
  }
  // One raised block.
  const block = norm([0.2, 0.9, 0.3]);
  const nodeOfBlock = gridNodeAt(g, block[0], block[1], block[2]);
  const raised = new Float32Array(g.count);
  raised[nodeOfBlock] = 400;
  const fr = horizonField(g, raised, 1, o);
  const nominalM = (Math.PI / 2 / g.n) * g.radiusM;
  const nb = new Int32Array(8);
  const k = gridNeighbours(g, nodeOfBlock, nb);
  const values: number[] = [];
  for (let j = 0; j < k; j++) {
    gridDirection(g, nb[j]!, d);
    horizonCodeAt(fr, d[0], d[1], d[2], code);
    values.push(...code);
    const toBlock: Vec3 = [block[0] - d[0], block[1] - d[1], block[2] - d[2]];
    for (let a = 0; a < 4; a++) {
      const ax = HORIZON_AXES[a]!;
      const t: Vec3 = [ax[0] - d[0] * dot(ax, d), ax[1] - d[1] * dot(ax, d), ax[2] - d[2] * dot(ax, d)];
      if (code[a]! > 0 && dot(t, toBlock) <= 0) fail(`horizon: axis ${a} away from the block is raised at neighbour ${j}`);
    }
  }
  if (!values.some((v) => v > 0)) fail('horizon: the block raises no skyline');
  for (let s = 0; s < 300; s++) {
    const p = norm([rand(55, s) - 0.5, rand(56, s) - 0.5, rand(57, s) - 0.5]);
    if (angle(p, block) * g.radiusM < o.reachM + 2 * nominalM) continue;
    horizonCodeAt(fr, p[0], p[1], p[2], code);
    if (code.some((c) => c !== 0)) fail('horizon: a point beyond reach sees the block');
  }
  // A rolling field, raised, and the table and order changes.
  const rolling = Float32Array.from({ length: g.count }, (_, i) => {
    gridDirection(g, i, d);
    return 600 * fractalNoise3(d[0] * 10_000, d[1] * 10_000, d[2] * 10_000, { cellM: 3000, octaves: 3 }, 12);
  });
  // Raised: a hill of nodes; a point's own height also moves its eye, so only points clear of the hill are compared.
  const hill = norm([-0.5, 0.3, 0.8]);
  const higher = Float32Array.from(rolling, (h, i) => {
    gridDirection(g, i, d);
    return angle(d, hill) < 0.12 ? h + 150 + 80 * rand(58, i) : h;
  });
  const clearOfHill = 0.12 + 3 * (Math.PI / 2 / g.n);
  const fa = horizonField(g, rolling, 1, o);
  const fh = horizonField(g, higher, 1, o);
  const fs = horizonField(g, rolling, 1, { ...o, slots: 16 });
  const pts: Vec3[] = [];
  for (let s = 0; s < 400; s++) pts.push(norm([rand(61, s) - 0.5, rand(62, s) - 0.5, rand(63, s) - 0.5]));
  const forward: number[] = [];
  for (const p of pts) {
    horizonCodeAt(fa, p[0], p[1], p[2], code);
    forward.push(...code);
    if (angle(p, hill) < clearOfHill) continue;
    horizonCodeAt(fh, p[0], p[1], p[2], code2);
    for (let a = 0; a < 4; a++) if (code2[a]! < code[a]!) fail('horizon: raising heights lowered a code');
  }
  const backward: number[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    horizonCodeAt(fs, p[0], p[1], p[2], code);
    backward.unshift(...code);
  }
  if (forward.join() !== backward.join()) fail('horizon: the table size or the order changed a code');
  for (let i = 0; i < g.count; i += 37) {
    gridDirection(g, i, d);
    horizonCodeAt(fa, d[0], d[1], d[2], code);
    horizonCodeAt(fs, d[0] * 3, d[1] * 3, d[2] * 3, code2);
    if (code.join() !== code2.join()) fail(`horizon: node ${i} has two codes`);
  }
  // Walks: over an edge, through a corner and through each axis.
  const eighth = Math.PI / 2 / g.n / 8;
  const light = norm([0.4, 0.75, 0.52]);
  const walks: { p: Vec3; u: Vec3 }[] = [{ p: cubeEdges()[0]!.mid, u: cubeEdges()[0]!.across }, { p: cubeCorners()[7]!, u: square(cubeCorners()[7]!) }];
  for (const a of HORIZON_AXES) walks.push({ p: a, u: square(a) });
  const lit: number[] = [];
  for (const w of walks) {
    let prev = NaN;
    for (let t = -0.05; t <= 0.05; t += eighth) {
      const p = norm(arcPoint(w.p, w.u, t));
      horizonCodeAt(fa, p[0], p[1], p[2], code);
      const v = horizonLit(code, p, light, 0.05);
      if (prev === prev && Math.abs(v - prev) >= 0.05) fail(`horizon: the light jumps by ${Math.abs(v - prev)} along a walk`);
      prev = v;
      lit.push(v);
    }
  }
  return [Uint8Array.from(forward), Float64Array.from(lit), Uint8Array.from(values)];
}
