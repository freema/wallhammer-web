// Scenarios of the solids of loaded cells (engine `world/solid-index.ts`, `world/solid-feed.ts`): synthetic cell content
// with instance records, added to and removed from a `SolidIndex` cell by cell; `within` against a brute-force answer;
// a flat collision world kept in step (`SolidFeed.attach(world)`) that stops a walker at a cylinder's radius and at a
// turned box's face and lets it through once the cell leaves; on a sphere a feed attached at every rechart of a
// `ChartWalker` that stops the body, still stops it after a rechart while touching, takes in a cell that arrives between
// recharts and drops one that leaves; the precision of the distance at 1e5 m; a huge solid that must not make a query
// scan the hash, an `addCell` that throws and changes nothing, a bad stride, a listener that stops itself, a feed
// attached twice; and the CPU time of the index and the feed.

import type { InstanceSolid, VertexLayout } from '../../packages/wallhammer-web/src/base/data.ts';
import { SurfaceChart } from '../../packages/wallhammer-web/src/base/chart.ts';
import { FlatWorld, cellId } from '../../packages/wallhammer-web/src/gen-core/cell.ts';
import type { CellContent, CellId, WorldPos } from '../../packages/wallhammer-web/src/gen-core/cell.ts';
import { ChartWalker } from '../../packages/wallhammer-web/src/world/chart-walker.ts';
import { CollisionWorld } from '../../packages/wallhammer-web/src/world/collide.ts';
import { SolidFeed } from '../../packages/wallhammer-web/src/world/solid-feed.ts';
import { SolidIndex } from '../../packages/wallhammer-web/src/world/solid-index.ts';
import { Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import { f, meanMs, seeded, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';
import { FACING, START } from './sphere-scenarios.ts';

type V3 = [number, number, number];

/** One instance: base x, y, z (cell-local), radius, height | turn, size x, size z. */
const LAYOUT: VertexLayout = {
  stride: 32,
  attribs: [
    { name: 'i_a', size: 4, type: 'f32', offset: 0 },
    { name: 'i_b', size: 4, type: 'f32', offset: 16 },
  ],
};
const FLOATS = 8;
const POST: InstanceSolid = { position: 0, radius: 3, height: 4, standable: false };
const RADIAL_POST: InstanceSolid = { ...POST, up: 'radial', belowM: 1 };
const BLOCK: InstanceSolid = { position: 0, height: 4, box: { turn: 5, sizeX: 6, sizeZ: 7 } };
/** `plant` has no solid: it must never be indexed. */
const SOLIDS: Record<string, InstanceSolid> = { post: POST, block: BLOCK };

/** A cell whose instances are given per archetype as rows of up to 8 numbers (missing ones are 0). */
function content(cell: CellId, sets: Record<string, number[][]>): CellContent {
  const instances = Object.entries(sets).map(([archetype, rows], s) => {
    const data = new Float32Array(rows.length * FLOATS);
    const ids = new Uint32Array(rows.length * 2);
    rows.forEach((r, i) => {
      for (let k = 0; k < r.length; k++) data[i * FLOATS + k] = r[k]!;
      ids[i * 2] = s + 1;
      ids[i * 2 + 1] = i;
    });
    return { archetype, data: { layout: LAYOUT, data }, ids };
  });
  return { cell, domainVersion: 1, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, meshes: [], instances };
}

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const len = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);
const unit = (v: readonly number[]): V3 => {
  const l = len(v);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const dotv = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** A point `m` metres along the great circle from `START` toward `FACING`, at radius `r`. */
function along(m: number, R: number, r: number): V3 {
  const th = m / R;
  const d = unit([START[0] * Math.cos(th) + FACING[0] * Math.sin(th), START[1] * Math.cos(th) + FACING[1] * Math.sin(th), START[2] * Math.cos(th) + FACING[2] * Math.sin(th)]);
  return [d[0] * r, d[1] * r, d[2] * r];
}

/** Steps a flat walker for `seconds` toward (mx, mz). */
function push(k: Walker, mx: number, mz: number, seconds: number): void {
  const it = newWalkIntent();
  it.moveX = mx;
  it.moveZ = mz;
  it.run = true;
  for (let s = 0; s < Math.round(seconds * k.setup.stepHz); s++) k.step(it);
}

/** Walks a chart walker at a world point for `seconds` (the point found in the current chart every frame). */
function walkAt(w: ChartWalker, goal: V3, seconds: number, each?: (i: number) => void): void {
  const it = newWalkIntent();
  it.run = true;
  const g: V3 = [0, 0, 0];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    w.toChart(goal, g, 1e9);
    const q = w.walker.position;
    const dx = g[0] - q[0]!;
    const dz = g[2] - q[2]!;
    const l = Math.hypot(dx, dz) || 1;
    it.moveX = dx / l;
    it.moveZ = dz / l;
    w.advance(1 / 60, it);
    each?.(i);
  }
}

/** Distance along the sphere of radius R from the walker's feet to the axis through `axis`. */
function alongSphere(w: ChartWalker, axis: V3, R: number): number {
  const p = w.position([0, 0, 0] as V3);
  return Math.acos(Math.min(1, dotv(unit(p), unit(axis)))) * R;
}

export const SOLID_SCENARIOS: Scenario[] = [
  {
    // 3 × 3 cells of 64 m with posts, unsolid plants and posts of radius 0; queries against a brute-force answer; a
    // cell removed, added again and replaced.
    name: 'solids-index-add-remove-query',
    run: () => {
      const shape = new FlatWorld(4096);
      const index = new SolidIndex({ solids: SOLIDS, shape, bucketM: 16 });
      const rnd = seeded(41);
      const all: { cell: string; p: V3; r: number; h: number }[] = [];
      const cells: CellContent[] = [];
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          const cell = cellId(7, 6, x, y);
          const o = shape.origin(cell);
          const posts: number[][] = [];
          for (let i = 0; i < 120; i++) {
            const row = [rnd() * 64, rnd() * 4 - 2, rnd() * 64, i % 10 === 0 ? 0 : 0.2 + rnd(), 1 + rnd() * 6];
            posts.push(row);
            if (row[3]! > 0) all.push({ cell: `${x},${y}`, p: [o[0] + Math.fround(row[0]!), o[1] + Math.fround(row[1]!), o[2] + Math.fround(row[2]!)], r: Math.fround(row[3]!), h: Math.fround(row[4]!) });
          }
          const plants = Array.from({ length: 50 }, () => [rnd() * 64, 0, rnd() * 64, 1, 1]);
          const c = content(cell, { post: posts, plant: plants });
          cells.push(c);
          index.addCell(c);
        }
      }
      const countOk = index.solidCount === all.length && index.cellCount === 9;
      // Brute force: the distance from the point to the upright axis (0..h above the base) less the radius.
      const brute = (q: V3, rad: number, skip: string | null): number => {
        let n = 0;
        for (const s of all) {
          if (s.cell === skip) continue;
          const t = Math.min(s.h, Math.max(0, q[1] - s.p[1]));
          const d = Math.hypot(q[0] - s.p[0], q[1] - s.p[1] - t, q[2] - s.p[2]) - s.r;
          if (d <= rad) n++;
        }
        return n;
      };
      let mismatches = 0;
      let visited = 0;
      let plants = 0;
      const queries = (skip: string | null): void => {
        const qr = seeded(7);
        for (let i = 0; i < 300; i++) {
          const q: V3 = [qr() * 192 - 64, qr() * 6 - 3, qr() * 192 - 64];
          const rad = qr() * 12;
          const got = index.within(q, rad, (h) => {
            if (h.archetype !== 'post') plants++;
          });
          visited += got;
          if (got !== brute(q, rad, skip)) mismatches++;
        }
      };
      queries(null);
      const before = index.solidCount;
      index.removeCell(cells[4]!.cell);
      const removed = before - index.solidCount;
      queries('0,0');
      index.addCell(cells[4]!);
      index.addCell(cells[4]!); // new content of the same cell: replaced, not doubled
      const back = index.solidCount === before && index.cellCount === 9;
      queries(null);
      const ok = countOk && mismatches === 0 && plants === 0 && removed === all.filter((s) => s.cell === '0,0').length && back && visited > 100;
      return verdict(ok, `${all.length} solids in 9 cells (plants and radius 0 skipped ${countOk}); 900 queries, ${visited} hits, ${mismatches} differ from brute force; a cell removed takes ${removed}, added twice gives ${index.solidCount} of ${before}`);
    },
  },
  {
    // Flat: a post and a turned box from a cell stop the walker at the radius and at the face; once the cell leaves, the
    // walker passes.
    name: 'solids-flat-feed-blocks-walker',
    run: () => {
      const shape = new FlatWorld(4096);
      const index = new SolidIndex({ solids: SOLIDS, shape });
      const world = new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
      const feed = new SolidFeed(index);
      feed.attach(world);
      const cell = cellId(7, 6, 0, 0);
      // A post of 1 m at x 20, z 10; a block 4 × 2 m turned 90° at x 20, z 30 (its long side along z).
      index.addCell(content(cell, { post: [[20, 0, 10, 1, 3]], block: [[20, 0, 30, 0, 3, Math.PI / 2, 4, 2]] }));
      const k = new Walker(world);
      k.teleport(5, 0, 10);
      push(k, 1, 0, 6);
      const r = k.setup.radius;
      const atPost = 20 - 1 - r - k.position[0]!;
      const b = new Walker(world);
      b.teleport(5, 0, 30);
      push(b, 1, 0, 6);
      // Turned a quarter, the 2 m size lies along x: the face at x 19.
      const atBox = 19 - r - b.position[0]!;
      const inWorld = world.solidCount;
      index.removeCell(cell);
      const after = world.solidCount;
      push(k, 1, 0, 3);
      const passed = k.position[0]! > 25;
      const ok = Math.abs(atPost) < 2e-3 && Math.abs(atBox) < 2e-3 && inWorld === 2 && after === 0 && feed.count === 0 && passed;
      return verdict(ok, `stopped ${f(atPost, 4)} m off the post's radius and ${f(atBox, 4)} m off the box's face; ${inWorld} solids fed, ${after} after the cell left; walked on to x ${f(k.position[0]!, 1)}`);
    },
  },
  {
    // Sphere of 2 km: a radial post 120 m ahead, fed into every chart, stops the body; a rechart forced while it touches
    // keeps it stopped.
    name: 'solids-chart-feed-blocks-after-rechart',
    run: () => {
      const R = 2000;
      const index = new SolidIndex({ solids: { post: RADIAL_POST }, shape: { origin: () => [0, 0, 0] }, center: [0, 0, 0] });
      const axis = along(120, R, R);
      index.addCell(content(cellId(2, 9, 0, 0), { post: [[axis[0], axis[1], axis[2], 3, 4]] }));
      const feed = new SolidFeed(index);
      let attached = 0;
      const w = new ChartWalker({ radiusM: R, radiusAt: () => R, onRechart: (chart, world) => (attached += feed.attach(world, chart) > 0 ? 1 : 0) }, START);
      w.teleportDirection(START, 0, FACING);
      walkAt(w, axis, 60);
      const first = alongSphere(w, axis, R);
      const rc = w.recharts;
      w.rechart();
      walkAt(w, axis, 3);
      const second = alongSphere(w, axis, R);
      const want = 3 + w.setup.radius;
      const ok = Math.abs(first - want) < 0.01 && Math.abs(second - want) < 0.01 && rc > 3 && attached >= 2 && feed.count === 1;
      return verdict(ok, `stopped ${f(first, 4)} m from the axis (want ${f(want, 2)}), ${f(second, 4)} m after a forced rechart; ${rc} recharts, the post in ${attached} charts`);
    },
  },
  {
    // A cell arrives between recharts within reach: the current chart's world gets it and it stops the body; it leaves:
    // the world loses it and the body walks on.
    name: 'solids-chart-cell-arrives-and-leaves',
    run: () => {
      const R = 2000;
      const index = new SolidIndex({ solids: { post: RADIAL_POST }, shape: { origin: () => [0, 0, 0] }, center: [0, 0, 0] });
      const feed = new SolidFeed(index, { reachM: 100 });
      const w = new ChartWalker({ radiusM: R, radiusAt: () => R, onRechart: (chart, world) => void feed.attach(world, chart) }, START);
      w.teleportDirection(START, 0, FACING);
      const axis = along(30, R, R);
      const cell = cellId(2, 9, 1, 0);
      let rechartsAtArrival = -1;
      let inChart = 0;
      // Half a second in (2 m walked, before any rechart), the cell with a post 30 m ahead arrives.
      walkAt(w, axis, 8, (i) => {
        if (i === 30) {
          rechartsAtArrival = w.recharts;
          index.addCell(content(cell, { post: [[axis[0], axis[1], axis[2], 1, 4]] }));
          inChart = w.world.solidCount;
        }
      });
      const stopped = alongSphere(w, axis, R);
      const want = 1 + w.setup.radius;
      const rc = w.recharts;
      index.removeCell(cell);
      const left = w.world.solidCount;
      walkAt(w, along(500, R, R), 10);
      const gone = alongSphere(w, along(0, R, R), R);
      const ok = inChart === 1 && Math.abs(stopped - want) < 0.01 && left === 0 && feed.count === 0 && gone > 60;
      return verdict(ok, `arrived at recharts ${rechartsAtArrival}, ${inChart} solid in the chart's world; stopped ${f(stopped, 4)} m from the axis (want ${f(want, 2)}) after ${rc} recharts; after it left ${left} solids, the body ${f(gone, 1)} m from the start`);
    },
  },
  {
    // At 1e5 m from the centre: cell origins as doubles, records as floats near them, distances to a millimetre.
    name: 'solids-precision-at-1e5',
    run: () => {
      const R = 100_000;
      const base = along(0, R, R);
      const o: WorldPos = [Math.round(base[0]), Math.round(base[1]), Math.round(base[2])];
      const index = new SolidIndex({ solids: { post: RADIAL_POST }, shape: { origin: () => o }, center: [0, 0, 0] });
      const local = sub(base, o);
      index.addCell(content(cellId(2, 11, 3, 4), { post: [[local[0], local[1], local[2], 0.5, 2]] }));
      // Points on the ground 0.5 + 0.4 and 0.5 + 0.6 m from the axis along the walk's direction: a radius of 0.5 m
      // reaches the first and not the second.
      const near = along(0.9, R, R + 1);
      const far = along(1.1, R, R + 1);
      let dNear = NaN;
      const hitsNear = index.within(near, 0.5, (h) => (dNear = h.distance));
      const hitsFar = index.within(far, 0.5, () => {});
      const ok = hitsNear === 1 && hitsFar === 0 && Math.abs(dNear - 0.4) < 1e-3;
      return verdict(ok, `at ${R} m: ${hitsNear} hit at 0.9 m (distance past the radius ${f(dNear, 5)} m, want 0.4), ${hitsFar} at 1.1 m`);
    },
  },
  {
    // The public within-radius query of a collision world: ids, tags and signed distances of a cylinder and a box.
    name: 'solids-collision-query',
    run: () => {
      const world = new CollisionWorld({ heightAt: () => 0 });
      const cyl = world.addCylinder(0, 0, 1, 0, 2, { tag: 7 });
      const box = world.addBox(10, 0, 1, 2, 0, 0, 2, { tag: 9 });
      const seen: string[] = [];
      const a = world.query(3, 0, 2.1, (id, tag, d) => seen.push(`${id}:${tag}:${d.toFixed(3)}`));
      const b = world.query(3, 0, 1.9, () => {});
      const c = world.query(10, 0, 0, (id, tag, d) => seen.push(`${id}:${tag}:${d.toFixed(3)}`));
      world.remove(cyl);
      const d = world.query(3, 0, 2.1, () => {});
      const ok = a === 1 && b === 0 && c === 1 && d === 0 && seen[0] === `${cyl}:7:2.000` && seen[1] === `${box}:9:-1.000`;
      return verdict(ok, `within 2.1 m of (3, 0): ${a} (${seen[0]}), within 1.9 m: ${b}; at the box's centre: ${c} (${seen[1]}); after removal ${d}`);
    },
  },
  {
    // One huge solid (a post of radius 3.2 km with buckets of 32 m) among small ones: a query of 1 m still answers in
    // well under a millisecond and agrees with brute force; once the huge one's cell leaves, the small ones are found as
    // before. Unbounded, the query would visit 201³ buckets (tens of milliseconds and more).
    name: 'solids-index-huge-solid-bounded',
    run: () => {
      const shape = new FlatWorld(4096);
      const index = new SolidIndex({ solids: SOLIDS, shape, bucketM: 32 });
      const small = content(cellId(7, 6, 0, 0), { post: [[10, 0, 10, 1, 3], [40, 0, 50, 0.5, 2], [60, 0, 5, 2, 4]] });
      const huge = content(cellId(7, 6, 1, 0), { post: [[10, 0, 10, 3200, 3]] });
      index.addCell(small);
      index.addCell(huge);
      const q: V3 = [12, 1, 10];
      let n = 0;
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) n = index.within(q, 1, () => {});
      const withHuge = (performance.now() - t0) / 20;
      index.removeCell(huge.cell);
      let after = 0;
      const t1 = performance.now();
      for (let i = 0; i < 20; i++) after = index.within(q, 1, () => {});
      const without = (performance.now() - t1) / 20;
      const far = index.within([3000, 0, 3000], 1, () => {});
      const ok = n === 2 && after === 1 && far === 0 && withHuge < 1 && without < 1;
      return verdict(ok, `with a 3.2 km solid: ${n} hits (want 2) in ${f(withHuge * 1000, 1)} µs per query; after it left: ${after} hit (want 1) in ${f(without * 1000, 1)} µs; target 1 ms each`);
    },
  },
  {
    // A cell whose second solid lies outside the hash's range: `addCell` throws and leaves the index as it was (no
    // solid of the cell live, the cell not listed); a retry with the bad record taken out adds the cell once.
    name: 'solids-index-add-cell-atomic',
    run: () => {
      const shape = new FlatWorld(4096);
      const index = new SolidIndex({ solids: SOLIDS, shape, bucketM: 1 });
      const cell = cellId(7, 6, 0, 0);
      const bad = content(cell, { post: [[10, 0, 10, 1, 3], [1e6, 0, 10, 1, 3]] });
      let threw = false;
      try {
        index.addCell(bad);
      } catch {
        threw = true;
      }
      const afterThrow = index.solidCount;
      const listed = index.hasCell(cell);
      const hitsAfterThrow = index.within([10, 1, 10], 0.5, () => {});
      index.addCell(content(cell, { post: [[10, 0, 10, 1, 3]] }));
      const afterRetry = index.solidCount;
      index.removeCell(cell);
      const ok = threw && afterThrow === 0 && !listed && hitsAfterThrow === 0 && afterRetry === 1 && index.solidCount === 0;
      return verdict(ok, `threw ${threw}; after the throw ${afterThrow} solids live, cell listed ${listed}, ${hitsAfterThrow} hits; after a retry ${afterRetry} (want 1), after its removal ${index.solidCount}`);
    },
  },
  {
    // A set of instances whose layout has a stride of 0 (or one that is not a whole number of floats) is refused with
    // an error at once, and nothing of the cell enters the index.
    name: 'solids-index-bad-stride',
    run: () => {
      const index = new SolidIndex({ solids: SOLIDS, shape: new FlatWorld(4096) });
      const results: string[] = [];
      for (const stride of [0, -32, 30, Number.NaN]) {
        const c = content(cellId(7, 6, 0, 0), { post: [[10, 0, 10, 1, 3]] });
        c.instances[0]!.data.layout = { ...LAYOUT, stride };
        try {
          index.addCell(c);
          results.push(`${stride}: accepted`);
        } catch (e) {
          results.push(`${stride}: ${e instanceof Error && /stride/.test(e.message) ? 'refused' : 'other error'}`);
        }
      }
      const ok = results.every((r) => r.endsWith('refused')) && index.solidCount === 0 && index.cellCount === 0;
      return verdict(ok, `${results.join(', ')}; ${index.solidCount} solids, ${index.cellCount} cells after`);
    },
  },
  {
    // A listener that stops itself while it is told about a cell: the listener after it is still told.
    name: 'solids-index-listener-unsubscribes',
    run: () => {
      const index = new SolidIndex({ solids: SOLIDS, shape: new FlatWorld(4096) });
      const told: string[] = [];
      const stopA = index.listen(() => {
        told.push('a');
        stopA();
      });
      index.listen(() => told.push('b'));
      index.listen(() => told.push('c'));
      index.addCell(content(cellId(7, 6, 0, 0), { post: [[10, 0, 10, 1, 3]] }));
      const first = told.join('');
      told.length = 0;
      index.removeCell(cellId(7, 6, 0, 0));
      const second = told.join('');
      return verdict(first === 'abc' && second === 'bc', `first notification told ${first} (want abc), the next ${second} (want bc)`);
    },
  },
  {
    // `attach` twice to the same flat world: the solids are there once, and once their cell leaves the world is empty.
    name: 'solids-feed-attach-twice',
    run: () => {
      const index = new SolidIndex({ solids: SOLIDS, shape: new FlatWorld(4096) });
      const world = new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
      const feed = new SolidFeed(index);
      const cell = cellId(7, 6, 0, 0);
      index.addCell(content(cell, { post: [[10, 0, 10, 1, 3], [30, 0, 10, 1, 3]] }));
      feed.attach(world);
      feed.attach(world);
      const inWorld = world.solidCount;
      index.removeCell(cell);
      const after = world.solidCount;
      // A second world: the first one is emptied of this feed's solids.
      index.addCell(content(cell, { post: [[10, 0, 10, 1, 3]] }));
      const other = new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
      feed.attach(other);
      const ok = inWorld === 2 && after === 0 && feed.count === 1 && world.solidCount === 0 && other.solidCount === 1;
      return verdict(ok, `attached twice: ${inWorld} solids in the world (want 2), ${after} after the cell left; another world attached: ${world.solidCount} left in the first, ${other.solidCount} in the new one`);
    },
  },
  {
    // A radial box (6 × 7 m, turned 0.7 rad) near the −y pole of a sphere of 2 km, where `upFrame` gives the world's +x
    // whatever the up leans to, and the same box at an ordinary place: its axis is a unit vector square to its up in
    // both, and the footprint a feed puts into a chart at its base answers the same signed distances at points round it.
    name: 'solids-radial-box-near-pole',
    run: () => {
      const R = 2000;
      const radialBox: InstanceSolid = { ...BLOCK, up: 'radial' };
      const parts: string[] = [];
      let ok = true;
      for (const [label, dir] of [['near −y', unit([0.001, -Math.sqrt(1 - 1e-6), 0])], ['at the start', START]] as const) {
        const index = new SolidIndex({ solids: { block: radialBox }, shape: { origin: () => [0, 0, 0] }, center: [0, 0, 0], bucketM: 64 });
        index.addCell(content(cellId(2, 9, 0, 0), { block: [[dir[0] * R, dir[1] * R, dir[2] * R, 0, 4, 0.7, 6, 7]] }));
        let up: V3 = [0, 0, 0];
        let axis: V3 = [0, 0, 0];
        let base: V3 = [0, 0, 0];
        index.within(dir.map((v) => v * R) as V3, 1, (h) => {
          up = [h.upX, h.upY, h.upZ];
          axis = [h.axisX, h.axisY, h.axisZ];
          base = [h.x, h.y, h.z];
        });
        const square = Math.max(Math.abs(dotv(axis, up)), Math.abs(len(axis) - 1));
        // The footprint in a chart anchored at the base, at points given in the box's own tangent axes.
        const chart = new SurfaceChart([0, 0, 0], R, up);
        const world = new CollisionWorld({ heightAt: () => 0 });
        new SolidFeed(index).attach(world, chart);
        const k = dotv(axis, up);
        const t1 = unit([axis[0] - up[0] * k, axis[1] - up[1] * k, axis[2] - up[2] * k]);
        const t2: V3 = [up[1] * t1[2] - up[2] * t1[1], up[2] * t1[0] - up[0] * t1[2], up[0] * t1[1] - up[1] * t1[0]];
        let worst = 0;
        for (const [a, b] of [[0, 0], [3.5, 0], [0, 4], [3.3, 3.9], [2.8, 0.1], [-3.2, -1], [1, -3.8]]) {
          const w = [0, 1, 2].map((i) => base[i]! + t1[i]! * a! + t2[i]! * b!) as V3;
          const q = chart.fromWorld(w[0], w[1], w[2], [0, 0, 0] as V3);
          let d = NaN;
          world.query(q[0], q[2], 10, (_, __, dist) => (d = dist));
          const dx = Math.abs(a!) - 3, dz = Math.abs(b!) - 3.5;
          const want = dx > 0 || dz > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) : Math.max(dx, dz);
          worst = Math.max(worst, Math.abs(d - want));
        }
        ok &&= square < 1e-12 && worst < 2e-3;
        parts.push(`${label}: axis off square to up by ${square.toExponential(1)}, footprint off by ${f(worst * 1000, 3)} mm`);
      }
      return verdict(ok, parts.join('; '));
    },
  },
  {
    name: 'solids-index-cpu-time',
    kind: 'timing',
    run: () => {
      const shape = new FlatWorld(4096);
      const index = new SolidIndex({ solids: SOLIDS, shape });
      const rnd = seeded(5);
      const cells: CellContent[] = [];
      for (let c = 0; c < 25; c++) {
        const posts = Array.from({ length: 500 }, () => [rnd() * 64, 0, rnd() * 64, 0.3 + rnd(), 2 + 10 * rnd()]);
        cells.push(content(cellId(7, 6, c % 5, Math.floor(c / 5)), { post: posts }));
      }
      // Adding and removing a cell of 500 solids, among 24 others.
      for (const c of cells) index.addCell(c);
      const cycle = meanMs(200, (i) => {
        const c = cells[i % 25]!;
        index.removeCell(c.cell);
        index.addCell(c);
      });
      let hits = 0;
      const pts: V3[] = Array.from({ length: 1000 }, () => [rnd() * 320, 1, rnd() * 320]);
      const query = meanMs(5000, (i) => (hits += index.within(pts[i % 1000]!, 2, () => {})));
      // A chart's feed: the solids within 160 m into a new collision world (what one rechart costs).
      const feed = new SolidFeed(index);
      const radial = new SolidIndex({ solids: { post: RADIAL_POST }, shape: { origin: () => [0, 0, 0] }, center: [0, 0, 0] });
      const R = 2000;
      for (let c = 0; c < 4; c++) {
        const rows = Array.from({ length: 500 }, () => {
          const p = along(rnd() * 300 - 150, R, R);
          const q = unit([p[0] + (rnd() - 0.5) * 300, p[1], p[2] + (rnd() - 0.5) * 300]);
          return [q[0] * R, q[1] * R, q[2] * R, 0.3 + rnd(), 4];
        });
        radial.addCell(content(cellId(2, 9, c, 0), { post: rows }));
      }
      const rfeed = new SolidFeed(radial);
      const w = new ChartWalker({ radiusM: R, radiusAt: () => R }, START);
      let fed = 0;
      const attach = meanMs(20, () => {
        const world = new CollisionWorld({ heightAt: () => 0 });
        fed = rfeed.attach(world, w.chart);
      });
      feed.dispose();
      const ok = cycle < 1 && query < 0.01 && attach < 5;
      return verdict(ok, `remove and add a cell of 500 solids ${f(cycle * 1000, 0)} µs (12,500 indexed); within 2 m ${f(query * 1000, 2)} µs (${f(hits / 10000, 2)} hits); a chart's feed of ${fed} solids ${f(attach, 2)} ms; targets 1 ms, 10 µs, 5 ms`);
    },
  },
];
