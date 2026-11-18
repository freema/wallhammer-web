// Numeric checks of the outpost without a browser. Run in the dev container:
//   docker compose exec -T dev sh -c 'cd /app/examples/outpost && pnpm inspect'
// Prints triangles and parts per module and per piece, and checks:
//   floating   every connected part of every solid piece and of every instanced part record either reaches the ground
//              or touches (bounding boxes, 2 cm) something that does, transitively across all pieces (the engine's
//              `meshParts` and `floatingParts` from tools)
//   corridors  each tube end circle lies wholly inside the shell it joins (gap ≤ 0) and not deep inside it; windows
//              of the domes keep clear of corridors and the airlock
//   routes     the rover loop and the walker's route keep a clearance from every structure (vertices below 3 m)
//   motion     runs the simulation for two minutes: the walker reaches both ends of its route and stays clear of the
//              structures, the boots and the rover wheels stay on the ground, the rover drives its loop, the walk
//              cycle reports a footfall per step

import type { MeshData } from 'wallhammer-web/base';
import type { InstanceSet } from 'wallhammer-web/render';
import { Simulation } from 'wallhammer-web/sim';
import { floatingParts, meshParts } from 'wallhammer-web/tools';
import type { MeshPart } from 'wallhammer-web/tools';
import { SUIT } from '../src/life/astronaut.ts';
import { ROVER } from '../src/life/rover.ts';
import { buildContext } from '../src/context.ts';
import type { MeshBuilder } from '../src/kit/mesh.ts';
import { transformPoint } from '../src/kit/math.ts';
import { outpostLayout } from '../src/layout.ts';
import { outpostModules } from '../src/modules.ts';
import { stationPlan } from '../src/station.ts';
import { angleGap } from '../src/structures/dome.ts';
import { endGap } from '../src/structures/corridor.ts';
import { terrain } from '../src/terrain/height.ts';

const seed = Number(process.argv[2] ?? 1);
const layout = outpostLayout(seed);
const t = terrain(layout);
const ctx = buildContext(seed, layout, t);
const sim = new Simulation({ seed: `outpost-${seed}`, hz: 30 });
const built: { name: string; parts: InstanceSet[]; counters: Readonly<Record<string, number>>; update?: (f: { time: number; dt: number; alpha: number; eye: [number, number, number] }) => void }[] = [];
let problems = 0;
const warn = (msg: string): void => {
  problems++;
  console.log(`  ! ${msg}`);
};

/** Positions of a mesh in the outpost format (kit/mesh.ts): 13 floats per vertex, the position first. */
const FLOATS = 13;
const floats = (m: MeshData): Float32Array => {
  const v = m.vertices as Uint8Array;
  return new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
};
const record = (s: InstanceSet, i: number): Float32Array => s.data.subarray(i * 16, i * 16 + 12);
/** Triangles of a mesh whose three vertices are outlined (a_hull not zero). */
function hullTriangles(m: MeshData): number {
  const f = floats(m);
  const on = (i: number): boolean => f[i * FLOATS + 6] !== 0 || f[i * FLOATS + 7] !== 0 || f[i * FLOATS + 8] !== 0;
  let n = 0;
  for (let k = 0; k < m.count; k += 3) if (on(m.indices![k]!) && on(m.indices![k + 1]!) && on(m.indices![k + 2]!)) n++;
  return n;
}

console.log(`outpost seed ${seed}: ${t.craters.length} craters, sun ${layout.sunDir.map((v) => v.toFixed(2)).join(' ')}, ${layout.pads.length} pads`);
let total = 0;
const allParts: MeshPart[] = [];
/** Structure vertices near the ground (x, z), for the route clearance. */
const obstacles: [number, number, string][] = [];
const collect = (owner: string, positions: ArrayLike<number>, stride = 3, m: ArrayLike<number> | null = null): void => {
  for (let k = 0; k + 2 < positions.length; k += stride) {
    const [x, y, z] = m ? transformPoint(m, [positions[k]!, positions[k + 1]!, positions[k + 2]!]) : [positions[k]!, positions[k + 1]!, positions[k + 2]!];
    if (y - t.heightAt(x, z) < 3) obstacles.push([x, z, owner]);
  }
};
for (const mod of outpostModules(t, sim)) {
  const c = mod.build(ctx);
  built.push({ name: mod.name, parts: c.parts ?? [], counters: c.counters ?? {}, ...(c.update ? { update: c.update.bind(c) } : {}) });
  const tris = (c.statics ?? []).reduce((s, p) => s + p.mesh.triangleCount, 0);
  const parts = (c.parts ?? []).reduce((s, p) => s + (p.mesh.count / 3) * p.count, 0);
  total += tris + parts;
  console.log(`\n${mod.name}: ${tris} static triangles, ${(c.parts ?? []).length} part sets (${parts} triangles drawn)`);
  for (const p of c.statics ?? []) {
    const b = p.mesh.bounds();
    const hull = hullTriangles(p.mesh.build());
    console.log(`  ${p.name.padEnd(18)} ${String(p.mesh.triangleCount).padStart(8)} tris  hull ${String(hull).padStart(7)}  ${(p.kind ?? 'solid').padEnd(8)} y ${b.min[1].toFixed(1)}..${b.max[1].toFixed(1)}`);
    // The ground is the reference; decals and the backdrop are checked by construction.
    if ((p.kind ?? 'solid') !== 'solid' || p.name === 'ground') continue;
    const positions = (p.mesh as MeshBuilder).positions();
    allParts.push(...meshParts(positions, p.mesh.indices(), { heightAt: t.heightAt, label: `${mod.name}/${p.name}` }));
    if (mod.name !== 'terrain') collect(`${mod.name}/${p.name}`, positions);
  }
  for (const s of c.parts ?? []) {
    const name = s.name ?? '';
    console.log(`  ${name.padEnd(18)} ${String(s.mesh.count / 3).padStart(8)} tris × ${s.count}`);
    const f = floats(s.mesh);
    for (let i = 0; i < s.count; i++) {
      allParts.push(...meshParts(f, s.mesh.indices!, { heightAt: t.heightAt, label: `${mod.name}/${name}[${i}]`, stride: FLOATS, transform: record(s, i) }));
      // Moving things are not obstacles of the routes they move on.
      if (mod.name !== 'life') collect(`${mod.name}/${name}`, f, FLOATS, record(s, i));
    }
  }
}
console.log(`\ntotal ${total} triangles`);

console.log(`\nfloating: ${allParts.length} connected parts checked`);
for (const p of floatingParts(allParts, { groundTolerance: 0.05 })) warn(`${p.label}: part at ${p.at[0]!.toFixed(1)}, ${p.at[1]!.toFixed(1)} is ${p.gap.toFixed(2)} m above the ground`);

// Corridors against the shells (independent of the joint search: the end circle sampled twice as densely).
const plan = stationPlan(layout, t.heightAt);
console.log('\ncorridors to shells (gap > 0: the tube end shows outside the shell; depth: how far the end sits inside):');
for (const p of plan.corridors) {
  for (const [end, d] of [[p.a, Math.hypot(p.start[0] - p.a.at[0], p.start[2] - p.a.at[2])], [p.c, Math.hypot(p.end[0] - p.c.at[0], p.end[2] - p.c.at[2])]] as const) {
    const axis = p.axisY - end.at[1];
    const gap = endGap(end.shape, axis, p.radius, d);
    const depth = end.joint.touch - d;
    console.log(`  ${p.name.padEnd(14)} end at ${d.toFixed(2)} m from the axis: gap ${gap.toFixed(3)} m, ${depth.toFixed(2)} m inside, joint at ${end.joint.touch.toFixed(2)} m`);
    if (gap > 0) warn(`${p.name}: the tube end stands ${gap.toFixed(3)} m outside the shell`);
    if (depth > 3) warn(`${p.name}: the tube end sits ${depth.toFixed(2)} m inside the shell (seen through windows?)`);
  }
  if (p.legs.length === 0) warn(`${p.name}: no legs`);
}
console.log('\nwindows against corridors and doors:');
for (const [id, d] of Object.entries(plan.domes)) {
  const w = d.options.windows;
  if (!w) continue;
  let clashes = 0;
  for (const a of w.angles) {
    const half = w.width / 2 / d.site.radius;
    for (const o of d.obstacles) if (o.y1 > w.y0 && o.y0 < w.y1 && angleGap(a, o.angle) < o.half + half) (clashes++, warn(`dome ${id}: window at ${a.toFixed(2)} rad meets ${o.what}`));
  }
  console.log(`  dome ${id.padEnd(8)} ${w.angles.length} windows, ${d.obstacles.length} obstacles, ${clashes} clashes`);
}

// Routes: clearance from structure vertices (horizontal), on a 2 m hash grid.
const grid = new Map<string, [number, number, string][]>();
for (const o of obstacles) {
  const k = `${Math.floor(o[0] / 2)},${Math.floor(o[1] / 2)}`;
  let l = grid.get(k);
  if (!l) grid.set(k, (l = []));
  l.push(o);
}
function nearest(x: number, z: number): { d: number; what: string } {
  let best = { d: Infinity, what: '' };
  const gx = Math.floor(x / 2), gz = Math.floor(z / 2);
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const o of grid.get(`${gx + i},${gz + j}`) ?? []) {
    const d = Math.hypot(o[0] - x, o[1] - z);
    if (d < best.d) best = { d, what: o[2] };
  }
  return best;
}
/** Points along a polyline about `step` metres apart. */
function along(pts: readonly [number, number][], closed: boolean, step = 0.25): [number, number][] {
  const out: [number, number][] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let k = 0; k < n; k++) {
    const a = pts[k]!, b = pts[(k + 1) % pts.length]!;
    const m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 0; i < m; i++) out.push([a[0] + ((b[0] - a[0]) * i) / m, a[1] + ((b[1] - a[1]) * i) / m]);
  }
  if (!closed) out.push(pts[pts.length - 1]!);
  return out;
}
console.log('\nroutes (clearance from structures):');
for (const [name, pts, closed, need] of [
  ['rover loop', layout.roverLoop, true, 2.2],
  ['walker route', layout.walkerPath, false, 0.55],
  ['stand spot', [layout.standSpot], false, 0.55],
] as const) {
  let worst = { d: Infinity, what: '', at: [0, 0] as [number, number] };
  for (const [x, z] of along(pts as [number, number][], closed)) {
    const n = nearest(x, z);
    if (n.d < worst.d) worst = { ...n, at: [x, z] };
  }
  console.log(`  ${name.padEnd(13)} nearest structure ${worst.d === Infinity ? '> 4 m' : `${worst.d.toFixed(2)} m (${worst.what} at ${worst.at[0].toFixed(1)}, ${worst.at[1].toFixed(1)})`}, needs ${need} m`);
  if (worst.d < need) warn(`${name}: only ${worst.d.toFixed(2)} m from ${worst.what} at ${worst.at[0].toFixed(1)}, ${worst.at[1].toFixed(1)}`);
}

// Motion: step the simulation and read the posed records back.
console.log('\nmotion (120 s of simulation):');
{
  const life = built.find((b) => b.name === 'life');
  const set = (name: string): InstanceSet => life!.parts.find((p) => p.name === name)!;
  const at = (s: InstanceSet, i: number): [number, number, number] => [s.data[i * 16 + 9]!, s.data[i * 16 + 10]!, s.data[i * 16 + 11]!];
  const route = layout.walkerPath;
  const ends = [route[0]!, route[route.length - 1]!];
  const reached = [0, 0];
  let near = [false, false];
  let worstWalk = { d: Infinity, at: [0, 0] as [number, number], what: '' };
  let wheelGap = 0, footLow = Infinity, footHigh = -Infinity, roverPath = 0;
  let last: [number, number, number] | null = null;
  let walkedEnd = 0;
  let lastBody: [number, number, number] | null = null;
  for (let tick = 0; tick < 120 * 30; tick++) {
    sim.step(1);
    const time = sim.tick / 30;
    for (const b of built) b.update?.({ time, dt: 1 / 30, alpha: 0, eye: [0, 0, 0] });
    const body = at(set('suit body'), 0);
    if (lastBody) walkedEnd += Math.hypot(body[0] - lastBody[0], body[2] - lastBody[2]);
    lastBody = body;
    ends.forEach(([x, z], k) => {
      const close = Math.hypot(body[0] - x, body[2] - z) < 0.3;
      if (close && !near[k]) reached[k]!++;
      near[k] = close;
    });
    if (tick % 10 === 0) {
      const n = nearest(body[0], body[2]);
      if (n.d < worstWalk.d) worstWalk = { d: n.d, at: [body[0], body[2]], what: n.what };
    }
    // Boot soles: the shin record carries the knee; the sole is 0.47 m down the shin's own axis.
    const shins = set('suit shin');
    for (let i = 0; i < shins.count; i++) {
      const sole = transformPoint(record(shins, i), [0, -0.47, 0.04]);
      const g = sole[1] - t.heightAt(sole[0], sole[2]);
      footLow = Math.min(footLow, g);
      footHigh = Math.max(footHigh, g);
    }
    const wheels = set('rover wheels');
    for (let i = 0; i < wheels.count; i++) {
      const w = at(wheels, i);
      wheelGap = Math.max(wheelGap, Math.abs(w[1] - ROVER.wheelR * ROVER.size - t.heightAt(w[0], w[2])));
    }
    const r = at(set('rover body'), 0);
    if (last) roverPath += Math.hypot(r[0] - last[0], r[2] - last[2]);
    last = r;
  }
  console.log(`  walker reached the stairs end ${reached[0]}×, the bench end ${reached[1]}×; nearest structure ${worstWalk.d.toFixed(2)} m (${worstWalk.what} at ${worstWalk.at[0].toFixed(1)}, ${worstWalk.at[1].toFixed(1)})`);
  const steps = life!.counters;
  const walked = walkedEnd;
  console.log(`  footfalls ${steps.left} left, ${steps.right} right over ${walked.toFixed(1)} m walked (a stride of ${SUIT.stride} m is two steps)`);
  const expected = walked / SUIT.stride;
  if (Math.abs(steps.left! - expected) > 2 || Math.abs(steps.right! - expected) > 2) warn(`the walk cycle reports ${steps.left} + ${steps.right} footfalls, about ${expected.toFixed(0)} each expected`);
  console.log(`  boot soles ${footLow.toFixed(3)} .. ${footHigh.toFixed(3)} m over the ground; rover wheels within ${wheelGap.toFixed(3)} m of the ground; rover drove ${roverPath.toFixed(1)} m`);
  if (reached[0]! < 2 || reached[1]! < 2) warn('the walker does not go back and forth between both ends of its route');
  if (worstWalk.d < 0.3) warn(`the walker passes ${worstWalk.d.toFixed(2)} m from ${worstWalk.what}`);
  if (footLow < -0.08) warn(`a boot sinks ${(-footLow).toFixed(2)} m into the ground`);
  if (wheelGap > 0.01) warn(`a rover wheel leaves the ground by ${wheelGap.toFixed(3)} m`);
  if (roverPath < 60) warn(`the rover drove only ${roverPath.toFixed(1)} m in two minutes`);
}

console.log(problems ? `\n${problems} problem(s)` : '\nno problems');
process.exitCode = problems ? 1 : 0;
