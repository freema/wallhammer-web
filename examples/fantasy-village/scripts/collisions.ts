// Numeric collision check of the assembled village, without a browser. Builds every content module like the page does
// and reports what intrudes where it should not:
//   - geometry of one building inside another building's footprint,
//   - foreign geometry (vegetation, props, paving, rocks, other buildings) inside a closed building below its roof,
//     tree crowns through roofs included (the open forge is checked for vegetation only),
//   - fences across the cobbled streets, lanterns on the bridge deck,
//   - instanced parts (trees, props) standing in the air or sunk into the ground,
//   - the walk mode: the collision world from the modules' solids, and a figure walked (fixed walker steps, the same
//     path as `__wh.walk.walkTo`) from the square to the inn, over the bridge and to the forge along the villagers'
//     paths: it must not get stuck, nor enter a building or the river.
// Run in the dev container:
//   docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm collisions [seed]'

import { createBuildContext } from '../src/context.ts';
import type { MeshBuilder } from '../src/kit/mesh.ts';
import type { Contribution, PartSet } from '../src/kit/types.ts';
import { PART_FLOATS } from '../src/kit/types.ts';
import { insideStructure, pathNear, riverNear, structureDist, villageLayout } from '../src/layout.ts';
import type { Structure } from '../src/layout.ts';
import { MODULES } from '../src/modules.ts';
import { bridgeFrame } from '../src/terrain/common.ts';
import { buildWalkWorld, driveTo } from '../src/walk/world.ts';
import { NavGraph } from 'wallhammer-web/sim';
import { Walker } from 'wallhammer-web/world';
import { heightField } from '../src/terrain/height.ts';

const seed = Number(process.argv[2] ?? 7);
const layout = villageLayout(seed);
const field = heightField(layout, seed);
const ctx = createBuildContext(seed, layout, field);
const r1 = (v: number): string => v.toFixed(1);
let problems = 0;
const warn = (msg: string): void => {
  problems++;
  console.log(`  ! ${msg}`);
};

const built: { name: string; c: Contribution }[] = [];
for (const m of MODULES) {
  const t0 = performance.now();
  built.push({ name: m.name, c: m.build(ctx) });
  console.log(`built ${m.name.padEnd(11)} ${r1((performance.now() - t0) / 1000)} s`);
}

const BUILDING_MODULES = new Set(['inn', 'cottages', 'forge', 'mill', 'windmill', 'castle']);
const inside = (s: Structure, x: number, z: number, inset: number): boolean => structureDist([s], x, z) < -inset;

// --- Roof heights: the highest building vertex over a 0.5 m grid around every structure -------------------------------
const CELL = 0.5;
interface RoofGrid {
  s: Structure;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  top: Float32Array;
}
const grids: RoofGrid[] = layout.structures.map((s) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const f of s.footprints) for (let k = 0; k < f.length; k += 2) (x0 = Math.min(x0, f[k]!)), (x1 = Math.max(x1, f[k]!)), (z0 = Math.min(z0, f[k + 1]!)), (z1 = Math.max(z1, f[k + 1]!));
  x0 -= 3;
  z0 -= 3;
  const nx = Math.ceil((x1 + 3 - x0) / CELL), nz = Math.ceil((z1 + 3 - z0) / CELL);
  return { s, x0, z0, nx, nz, top: new Float32Array(nx * nz).fill(-Infinity) };
});
const ownerOf = (pieceModule: string, pieceName: string): Structure | undefined => {
  const single = layout.structures.filter((o) => o.kind === pieceModule);
  if (single.length === 1) return single[0];
  // The longest id contained in the piece name ('cottage-3', not 'mill' in 'windmill').
  let best: Structure | undefined;
  for (const s of layout.structures) if (pieceName.includes(s.id) && (!best || s.id.length > best.id.length)) best = s;
  return best;
};
for (const { name, c } of built) {
  if (!BUILDING_MODULES.has(name)) continue;
  for (const p of c.statics ?? []) {
    if (p.material !== 'solid') continue;
    const s = ownerOf(name, p.name ?? '');
    const g = grids.find((q) => q.s === s);
    if (!g) {
      console.log(`  (no structure for ${name}/${p.name})`);
      continue;
    }
    const pos = p.mesh.positionData;
    for (let i = 0; i < pos.length; i += 3) {
      const ix = Math.floor((pos[i]! - g.x0) / CELL), iz = Math.floor((pos[i + 2]! - g.z0) / CELL);
      if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) continue;
      const k = iz * g.nx + ix;
      if (pos[i + 1]! > g.top[k]!) g.top[k] = pos[i + 1]!;
    }
  }
}
const roofAt = (g: RoofGrid, x: number, z: number): number => {
  const ix = Math.floor((x - g.x0) / CELL), iz = Math.floor((z - g.z0) / CELL);
  if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return -Infinity;
  return g.top[iz * g.nx + ix]!;
};

console.log('\nroof tops (highest building vertex inside the footprint, above the pad):');
for (const g of grids) {
  let hi = -Infinity;
  for (let iz = 0; iz < g.nz; iz++) for (let ix = 0; ix < g.nx; ix++) {
    const x = g.x0 + (ix + 0.5) * CELL, z = g.z0 + (iz + 0.5) * CELL;
    if (inside(g.s, x, z, 0)) hi = Math.max(hi, g.top[iz * g.nx + ix]!);
  }
  console.log(`  ${g.s.id.padEnd(10)} pad ${r1(field.padY(g.s.id))} top ${r1(hi)} (+${r1(hi - field.padY(g.s.id))} m)`);
}

// --- Foreign geometry inside buildings -----------------------------------------------------------------------------------
console.log('\nforeign geometry inside buildings (vertices 0.3 m inside a footprint, above the floor and below the roof):');
const intrusions = new Map<string, number>();
function scanMesh(label: string, mod: string, mesh: MeshBuilder, own?: Structure): void {
  const pos = mesh.positionData;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
    for (const g of grids) {
      if (g.s === own) continue;
      // The open forge shelters the smithy (props) and the smith (villagers): only plants may not grow in it.
      if (g.s.kind === 'forge' && mod !== 'vegetation') continue;
      if (g.s.kind === 'castle') continue;
      if (!inside(g.s, x, z, 0.3)) continue;
      const pad = field.padY(g.s.id);
      if (y < pad + 0.15 || y > roofAt(g, x, z) - 0.05) continue;
      const key = `${label} in ${g.s.id}`;
      intrusions.set(key, (intrusions.get(key) ?? 0) + 1);
    }
  }
}
for (const { name, c } of built) {
  if (name === 'ground' || name === 'water') continue;
  for (const p of c.statics ?? []) {
    if (p.material !== 'solid') continue;
    const own = BUILDING_MODULES.has(name) ? ownerOf(name, p.name ?? '') : undefined;
    scanMesh(`${name}/${p.name ?? 'static'}`, name, p.mesh, own);
  }
}
// Instanced static parts (trees, bushes, lantern glass): transform the template vertices of every instance.
function eachInstanceVertex(set: PartSet, fn: (x: number, y: number, z: number, inst: number) => void): void {
  const pos = set.part.positionData;
  const d = set.data;
  for (let n = 0; n < set.count; n++) {
    const o = n * PART_FLOATS;
    for (let i = 0; i < pos.length; i += 3) {
      const px = pos[i]!, py = pos[i + 1]!, pz = pos[i + 2]!;
      fn(d[o]! * px + d[o + 3]! * py + d[o + 6]! * pz + d[o + 9]!, d[o + 1]! * px + d[o + 4]! * py + d[o + 7]! * pz + d[o + 10]!, d[o + 2]! * px + d[o + 5]! * py + d[o + 8]! * pz + d[o + 11]!, n);
    }
  }
}
for (const { name, c } of built) {
  for (const set of c.parts ?? []) {
    if (set.dynamic || set.group === 'villagers') continue;
    const hits = new Map<string, Set<number>>();
    eachInstanceVertex(set, (x, y, z, n) => {
      for (const g of grids) {
        if (g.s.kind === 'castle' || (g.s.kind === 'forge' && name !== 'vegetation')) continue;
        if (!inside(g.s, x, z, 0.3)) continue;
        if (y < field.padY(g.s.id) + 0.15 || y > roofAt(g, x, z) - 0.05) continue;
        const key = `${name}/${set.name} in ${g.s.id}`;
        let s = hits.get(key);
        if (!s) hits.set(key, (s = new Set()));
        s.add(n);
      }
    });
    for (const [k, s] of hits) intrusions.set(`${k} (instances ${[...s].slice(0, 6).join(',')})`, s.size);
  }
}
if (!intrusions.size) console.log('  none');
for (const [k, n] of intrusions) {
  console.log(`  ${k}: ${n}`);
  if (n > 8) warn(`${k}: ${n}`);
}

// --- Trees: crowns through roofs ------------------------------------------------------------------------------------------
console.log('\ntree crowns over roofs (vertices over a footprint within 0.4 m of the roof, or below it):');
let crownHits = 0;
for (const { name, c } of built) {
  if (name !== 'vegetation') continue;
  for (const set of c.parts ?? []) {
    eachInstanceVertex(set, (x, y, z) => {
      for (const g of grids) {
        if (g.s.kind === 'castle') continue;
        if (!inside(g.s, x, z, -0.6)) continue;
        const r = roofAt(g, x, z);
        if (r > -Infinity && y < r + 0.4 && y > field.padY(g.s.id) + 0.5) crownHits++;
      }
    });
  }
  for (const p of c.statics ?? []) {
    if (!/giant/.test(p.name ?? '')) continue;
    const pos = p.mesh.positionData;
    for (let i = 0; i < pos.length; i += 3) {
      for (const g of grids) {
        if (g.s.kind === 'castle' || !inside(g.s, pos[i]!, pos[i + 2]!, -0.6)) continue;
        const r = roofAt(g, pos[i]!, pos[i + 2]!);
        if (r > -Infinity && pos[i + 1]! < r + 0.4 && pos[i + 1]! > field.padY(g.s.id) + 0.5) crownHits++;
      }
    }
  }
}
console.log(`  ${crownHits} vertices`);
if (crownHits > 30) warn(`tree crowns touch roofs: ${crownHits} vertices`);

// --- Fences across streets, lanterns on the bridge --------------------------------------------------------------------
console.log('\nfences across cobbled streets (fence points inside a street, outside its edge strip):');
for (const [fi, f] of layout.fences.entries()) {
  let hits = 0;
  for (let k = 0; k + 1 < f.points.length; k++) {
    const [ax, az] = f.points[k]!, [bx, bz] = f.points[k + 1]!;
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25);
    for (let j = 0; j <= n; j++) {
      const x = ax + ((bx - ax) * j) / n, z = az + ((bz - az) * j) / n;
      const p = pathNear(layout.paths.filter((q) => q.kind === 'cobble'), x, z);
      if (p.path && p.dist < p.path.width / 2 - 0.2) hits++;
    }
  }
  if (hits) warn(`fence ${fi} (${f.kind}) crosses a street at ${hits} points`);
}
console.log(`  ${layout.fences.length} fences checked`);
const b = layout.bridge;
for (const l of layout.lanterns) {
  const dx = l.x - b.x, dz = l.z - b.z;
  const along = dx * Math.sin(b.yaw) + dz * Math.cos(b.yaw), across = dx * Math.cos(b.yaw) - dz * Math.sin(b.yaw);
  if (Math.abs(along) < b.length / 2 + 1.5 && Math.abs(across) < b.width / 2 + 1.5) warn(`lantern at ${r1(l.x)},${r1(l.z)} stands on or next to the bridge (along ${r1(along)}, across ${r1(across)}, bridge length ${r1(b.length)})`);
}

// --- Parts in the air or in the ground -------------------------------------------------------------------------------------
console.log('\ninstanced parts: origin (trunk foot, post foot) against the ground (static sets):');
for (const { name, c } of built) {
  for (const set of c.parts ?? []) {
    if (set.dynamic) continue;
    // The origin of a template is its foot (tree trunk, post); hanging parts (lantern glass) are expected in the air.
    const low = new Float32Array(set.count), xs = new Float32Array(set.count), zs = new Float32Array(set.count);
    for (let n = 0; n < set.count; n++) {
      const o = n * PART_FLOATS;
      xs[n] = set.data[o + 9]!;
      low[n] = set.data[o + 10]!;
      zs[n] = set.data[o + 11]!;
    }
    let air = 0, sunk = 0, worst = 0;
    for (let n = 0; n < set.count; n++) {
      const g = field.heightAt(xs[n]!, zs[n]!);
      const d = low[n]! - g;
      if (d > 0.25) {
        air++;
        console.log(`    floats ${r1(d)} m at ${r1(xs[n]!)},${r1(zs[n]!)} (ground ${r1(g)}, river ${r1(field.river(xs[n]!, zs[n]!).dist)} m)`);
      }
      if (d < -2.5) sunk++;
      if (Math.abs(d) > Math.abs(worst)) worst = d;
    }
    console.log(`  ${`${name}/${set.name}`.padEnd(28)} ${set.count} instances, in the air ${air}, sunk > 2.5 m ${sunk}, worst ${r1(worst)} m`);
    if (air > 0) warn(`${name}/${set.name}: ${air} instances float`);
  }
}

// --- Walk mode: the collision world and a walk through the village ---------------------------------------------------------
console.log('\nwalk mode:');
{
  // The cost of the terrain lookup the walker and the camera boom ask for every step.
  let sink = 0;
  const h0 = performance.now();
  for (let k = 0; k < 20000; k++) sink += field.heightAt(((k * 37) % 200) - 100, ((k * 53) % 200) - 100);
  const perCall = ((performance.now() - h0) / 20000) * 1000;
  const ww = buildWalkWorld(built, field.heightAt, -20, 60);
  const world = ww.world;
  console.log(`  ${world.solidCount} solids in ${r1(ww.ms)} ms; heightAt ${perCall.toFixed(2)} µs per call${sink === 1 ? '' : ''}`);
  console.log(`  ${Object.entries(ww.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const [label, n] of [['river', 1], ['edge', 32], ['bridge-deck', 10], ['inn', 1], ['fence', 10], ['tree', 10]] as const) {
    if ((ww.counts[label] ?? 0) < n) warn(`walk world: only ${ww.counts[label] ?? 0} solids labelled ${label}`);
  }

  // The route: the villagers' paths (their nav graph, the stall nodes closed as for them) between the stops.
  const nav = new NavGraph('walk-check', layout.nav);
  for (let k = 0; k < layout.stalls.length; k++) {
    const node = layout.pois.find((q) => q.id === `stall-${k}`)?.node ?? -1;
    for (let e = 0; e < nav.edgeCount; e++) if (nav.edgeFrom[e] === node || nav.edgeTo[e] === node) nav.setBlocked(e, true);
  }
  const nearest = (x: number, z: number): number => {
    let best = -1, bd = Infinity;
    for (let n = 0; n < nav.nodeCount; n++) {
      const d = Math.hypot(nav.nodeX[n]! - x, nav.nodeZ[n]! - z);
      if (d < bd) (bd = d), (best = n);
    }
    return best;
  };
  const bf = bridgeFrame(ctx);
  const inn = layout.structures.find((q) => q.kind === 'inn')!;
  const forge = layout.structures.find((q) => q.kind === 'forge')!;
  const ends = [bf.world(-bf.halfLength - 1.5, 0), bf.world(bf.halfLength + 1.5, 0)];
  // Over the bridge from the end nearer the inn to the other one.
  const innSide = Math.hypot(ends[0]![0] - inn.door.x, ends[0]![1] - inn.door.z) < Math.hypot(ends[1]![0] - inn.door.x, ends[1]![1] - inn.door.z) ? 0 : 1;
  const stops: { name: string; x: number; z: number }[] = [
    { name: 'square', x: layout.well.x, z: layout.well.z + 3.2 },
    { name: 'inn', x: inn.door.x + Math.sin(inn.door.yaw) * 1.2, z: inn.door.z + Math.cos(inn.door.yaw) * 1.2 },
    { name: 'bridge (near end)', x: ends[innSide]![0], z: ends[innSide]![1] },
    { name: 'bridge (far end)', x: ends[1 - innSide]![0], z: ends[1 - innSide]![1] },
    { name: 'forge', x: forge.door.x + Math.sin(forge.door.yaw) * 1.2, z: forge.door.z + Math.cos(forge.door.yaw) * 1.2 },
  ];
  const walker = new Walker(world);
  const start = stops[0]!;
  walker.teleport(start.x, world.groundAt(start.x, start.z, 1e4, 0, walker.setup.radius), start.z, 0);
  let inBuilding = 0, inRiver = 0, stuck = 0, segments = 0, maxDeckY = -Infinity, onDeck = 0;
  const watch = (w: Walker): void => {
    const p = w.position;
    if (insideStructure(layout, p[0]!, p[2]!)) inBuilding++;
    const rv = riverNear(layout.river, p[0]!, p[2]!);
    // On the bridge the figure is over the water, but well above it.
    if (rv.dist < rv.at.width / 2 && p[1]! < rv.at.y + 0.5) inRiver++;
    const [s, t] = bf.local(p[0]!, p[2]!);
    if (Math.abs(s) < bf.halfLength && Math.abs(t) < bf.halfWidth) (onDeck++, (maxDeckY = Math.max(maxDeckY, p[1]!)));
  };
  const t0 = performance.now();
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1]!, to = stops[k]!;
    // The direct line on the bridge, the paths elsewhere.
    const direct = k === 3;
    const route = direct ? [] : nav.findPath(nearest(walker.position[0]!, walker.position[2]!), nearest(to.x, to.z));
    if (route === null) {
      warn(`walk: no path from ${from.name} to ${to.name}`);
      continue;
    }
    // Nodes inside a footprint (the smith's place in the open forge) are not for the walking figure: the forge is solid.
    const pts: [number, number][] = direct ? [] : nav.routeNodes(route).map((n) => [nav.nodeX[n]!, nav.nodeZ[n]!] as [number, number]).filter(([x, z]) => structureDist(layout.structures, x, z) > 0.2);
    pts.push([to.x, to.z]);
    let bad = 0;
    for (const [x, z] of pts) {
      const p = walker.position;
      const d = Math.hypot(x - p[0]!, z - p[2]!);
      driveTo(walker, x, z, d / 1.2 + 1.5, { within: 0.25 }, watch);
      segments++;
      const left = Math.hypot(x - walker.position[0]!, z - walker.position[2]!);
      // A goal next to a wall or a solid (a door, a node by a post) is reached when the body is within its width.
      if (left > 1.2) {
        bad++;
        console.log(`    stuck ${r1(left)} m short of ${r1(x)},${r1(z)} (at ${r1(walker.position[0]!)},${r1(walker.position[2]!)}) on the way to ${to.name}`);
      }
    }
    const p = walker.position;
    console.log(`  ${from.name} → ${to.name}: ${pts.length} legs, now at ${r1(p[0]!)},${r1(p[1]!)},${r1(p[2]!)}, ${r1(Math.hypot(to.x - p[0]!, to.z - p[2]!))} m from the goal${bad ? `, ${bad} stuck` : ''}`);
    stuck += bad;
  }
  console.log(`  ${segments} legs, ${walker.steps} steps (${r1(walker.steps / walker.setup.stepHz)} s walked, ${r1(walker.travelled)} m) in ${r1(performance.now() - t0)} ms; on the deck ${onDeck} steps, highest ${r1(maxDeckY)} m (deck crown ${r1(layout.bridge.deckY)} m)`);
  // Pushes against what must hold: straight at the middle of the inn, of the forge and of a cottage, and into the river
  // away from the bridge (a point 25 m upstream and downstream of it).
  const pushes: { name: string; x: number; z: number }[] = [
    { name: 'into the inn', x: inn.x, z: inn.z },
    { name: 'into the forge', x: forge.x, z: forge.z },
    ...layout.structures.filter((q) => q.kind === 'cottage').slice(0, 2).map((q) => ({ name: `into ${q.id}`, x: q.x, z: q.z })),
  ];
  for (const [label, off] of [['upstream', -25], ['downstream', 25]] as const) {
    const at = riverNear(layout.river, ...bf.world(0, off));
    pushes.push({ name: `into the river ${label}`, x: at.at.x, z: at.at.z });
  }
  for (const pu of pushes) {
    const b0 = inBuilding, r0 = inRiver;
    // From the nearest path node outside, held for 8 s (it keeps pushing).
    let n = -1, bd = Infinity;
    for (let k = 0; k < nav.nodeCount; k++) {
      const x = nav.nodeX[k]!, z = nav.nodeZ[k]!;
      const d = Math.hypot(x - pu.x, z - pu.z);
      if (d < bd && structureDist(layout.structures, x, z) > 1 && riverNear(layout.river, x, z).dist > riverNear(layout.river, x, z).at.width / 2 + 1) (bd = d), (n = k);
    }
    const sx = nav.nodeX[n]!, sz = nav.nodeZ[n]!;
    walker.teleport(sx, world.groundAt(sx, sz, 1e4, 0, walker.setup.radius), sz, 0);
    const end = driveTo(walker, pu.x, pu.z, 8, { run: true }, watch);
    const ok = inBuilding === b0 && inRiver === r0;
    console.log(`  push ${pu.name.padEnd(26)} from ${r1(sx)},${r1(sz)}: stopped at ${r1(end.x)},${r1(end.z)}, ${r1(Math.hypot(pu.x - end.x, pu.z - end.z))} m short${ok ? '' : ' — GOT IN'}`);
  }
  if (stuck) warn(`walk: stuck on ${stuck} legs`);
  if (inBuilding) warn(`walk: inside a building in ${inBuilding} steps`);
  if (inRiver) warn(`walk: in the river in ${inRiver} steps`);
  if (onDeck === 0) warn('walk: never on the bridge deck');
}

console.log(problems ? `\n${problems} problem(s)` : '\nno problems');
