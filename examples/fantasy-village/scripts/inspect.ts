// Numeric checks of the layout, the terrain and the kit shapes, without a browser. Run in the dev container:
//   docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm inspect'
// Builders can add their generators at the end (build into a MeshBuilder, print `formatReport(inspect(...))`).

import { NavGraph } from 'wallhammer-web/sim';
import { MeshBuilder, PALETTE, Stream, bakeAo, bevelBox, crookedBeam, formatReport, groundAo, inspect, lathe, rock, sweep, tube } from '../src/kit/index.ts';
import { pathNear, structureDist, villageLayout } from '../src/layout.ts';
import { heightField } from '../src/terrain/height.ts';
import { MODULES } from '../src/modules.ts';
import { createBuildContext } from '../src/context.ts';

const seed = Number(process.argv[2] ?? 7);
const layout = villageLayout(seed);
const field = heightField(layout, seed);
const r1 = (v: number): string => v.toFixed(1);
let problems = 0;
const warn = (msg: string): void => {
  problems++;
  console.log(`  ! ${msg}`);
};

console.log(`layout seed ${seed}: ${layout.structures.length} structures, ${layout.paths.length} paths, ${layout.trees.length} trees, ${layout.lanterns.length} lanterns, ${layout.fences.length} fences, ${layout.pois.length} pois, nav ${layout.nav.nodes.length / 2} nodes ${layout.nav.edges.length} edges`);

console.log('\nstructures (pad y, ground under footprint min..max, water edge distance, nearest path edge):');
for (const s of layout.structures) {
  let lo = Infinity, hi = -Infinity;
  for (const f of s.footprints) {
    for (let k = 0; k < f.length; k += 2) {
      const h = field.heightAt(f[k]!, f[k + 1]!);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  const rv = field.river(s.x, s.z);
  let water = Infinity;
  for (const f of s.footprints) for (let k = 0; k < f.length; k += 2) {
    const r = field.river(f[k]!, f[k + 1]!);
    water = Math.min(water, r.dist - r.at.width / 2);
  }
  const p = pathNear(layout.paths, s.door.x, s.door.z);
  console.log(`  ${s.id.padEnd(10)} at ${r1(s.x)},${r1(s.z)} yaw ${s.yaw.toFixed(2)} pad ${r1(field.padY(s.id))} ground ${r1(lo)}..${r1(hi)} water edge ${r1(water)} m, door→path ${r1(p.dist - (p.path?.width ?? 0) / 2)} m (${p.path?.id})`);
  // The water mill's river wall stands on a stone footing in the bank by design (B3); it may touch the water edge.
  if (s.kind === 'mill' ? water < -1 : water < 0.5) warn(`${s.id} footprint reaches the water`);
  void rv;
  // Footprint overlaps.
  for (const o of layout.structures) {
    if (o === s) continue;
    for (const f of s.footprints) for (let k = 0; k < f.length; k += 2) {
      for (const g of o.footprints) {
        // A corner of s inside o.
        if (structureDist([{ ...o, footprints: [g] }], f[k]!, f[k + 1]!) < 0) warn(`${s.id} overlaps ${o.id}`);
      }
    }
  }
}

console.log('\npaths crossing footprints or water (outside the bridge):');
for (const p of layout.paths) {
  let hits = 0, wet = 0;
  for (const [x, z] of p.dense) {
    if (structureDist(layout.structures, x, z) < p.width / 2 - 0.3) hits++;
    const rv = field.river(x, z);
    const onBridge = Math.hypot(x - layout.bridge.x, z - layout.bridge.z) < layout.bridge.length / 2 + 1;
    if (rv.inWater && !onBridge) wet++;
  }
  console.log(`  ${p.id.padEnd(16)} ${r1(p.lengths[p.lengths.length - 1]!)} m, through buildings ${hits} pts, in water ${wet} pts`);
  if (hits) warn(`path ${p.id} runs through a building`);
  if (wet) warn(`path ${p.id} runs through the water`);
}

console.log('\nriver (surface, bank ground 1 m past the edge, bed at centre):');
for (let i = 0; i < layout.river.dense.length; i += 12) {
  const q = layout.river.dense[i]!;
  // Perpendicular: from the neighbours.
  const a = layout.river.dense[Math.max(0, i - 1)]!, b = layout.river.dense[Math.min(layout.river.dense.length - 1, i + 1)]!;
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  const nx = -dz / l, nz = dx / l;
  const left = field.heightAt(q.x + nx * (q.width / 2 + 1), q.z + nz * (q.width / 2 + 1));
  const right = field.heightAt(q.x - nx * (q.width / 2 + 1), q.z - nz * (q.width / 2 + 1));
  const bed = field.heightAt(q.x, q.z);
  const line = `  ${r1(q.x)},${r1(q.z)} w ${r1(q.width)} surface ${q.y.toFixed(2)} banks ${r1(left)} / ${r1(right)} bed ${r1(bed)}`;
  if (Math.abs(q.x) < 120 && Math.abs(q.z) < 120) console.log(line);
  if (Math.abs(q.x) < 110 && Math.abs(q.z) < 110) {
    if (Math.min(left, right) < q.y + 0.2) warn(`low bank at ${r1(q.x)},${r1(q.z)}`);
    if (bed > q.y - 0.3) warn(`shallow bed at ${r1(q.x)},${r1(q.z)}`);
  }
}
const w = layout.weir;
console.log(`  weir at ${r1(w.x)},${r1(w.z)} top ${w.top.toFixed(2)} bottom ${w.bottom.toFixed(2)} drop ${(w.top - w.bottom).toFixed(2)} m`);
const br = layout.bridge;
console.log(`  bridge at ${r1(br.x)},${r1(br.z)} yaw ${br.yaw.toFixed(2)} deck ${r1(br.deckY)} water ${r1(br.waterY)}; ground at its ends ${r1(field.heightAt(br.x + Math.sin(br.yaw) * br.length / 2, br.z + Math.cos(br.yaw) * br.length / 2))} / ${r1(field.heightAt(br.x - Math.sin(br.yaw) * br.length / 2, br.z - Math.cos(br.yaw) * br.length / 2))}`);
const mw = layout.millWheel;
const mwr = field.river(mw.x, mw.z);
console.log(`  mill wheel at ${r1(mw.x)},${r1(mw.z)} axle ${r1(mw.y)} r ${mw.radius}, water ${mwr.at.y.toFixed(2)} (in water: ${mwr.inWater}), bottom ${r1(mw.y - mw.radius)}`);

console.log('\nterrain samples:');
for (const [x, z, name] of [[0, 2, 'square'], [0, -60, 'north 60'], [0, -90, 'north 90'], [90, 0, 'east 90'], [-90, 0, 'west 90'], [0, 90, 'south 90'], [0, -150, 'castle'], [-75, -70, 'windmill'], [200, 200, 'corner far']] as const) {
  console.log(`  ${String(name).padEnd(10)} ${r1(field.heightAt(x, z))}`);
}

console.log('\nlanterns and trees:');
let badLamp = 0;
for (const l of layout.lanterns) if (structureDist(layout.structures, l.x, l.z) < 0.5 || field.river(l.x, l.z).inWater) badLamp++;
console.log(`  ${layout.lanterns.length} lanterns, ${badLamp} misplaced`);
if (badLamp) warn('misplaced lanterns');
const giants = layout.trees.filter((t) => t.kind === 'giant');
for (const t of giants) console.log(`  giant tree ${r1(t.x)},${r1(t.z)} ground ${r1(field.heightAt(t.x, t.z))}, to building ${r1(structureDist(layout.structures, t.x, t.z))} m`);

console.log('\nwalking graph:');
const graph = new NavGraph('village.nav', layout.nav);
const n = layout.nav.nodes.length / 2;
// Connectivity: BFS over the edges.
const adj: number[][] = Array.from({ length: n }, () => []);
for (const e of layout.nav.edges) {
  adj[e.from]!.push(e.to);
  adj[e.to]!.push(e.from);
}
const seen = new Uint8Array(n);
const queue = [0];
seen[0] = 1;
while (queue.length) {
  const a = queue.pop()!;
  for (const b of adj[a]!) if (!seen[b]) (seen[b] = 1), queue.push(b);
}
const reached = seen.reduce((s, v) => s + v, 0);
console.log(`  ${n} nodes, ${reached} reachable from node 0`);
if (reached !== n) warn(`walking graph is not connected (${n - reached} nodes unreachable)`);
for (const p of layout.pois) if (!seen[p.node]) warn(`poi ${p.id} unreachable`);
console.log(`  pois: ${layout.pois.map((p) => p.id).join(', ')}`);
void graph;

console.log('\nkit shapes:');
const s = new Stream(1);
const shapes: [string, (b: MeshBuilder) => void][] = [
  ['bevelBox 1×0.6×0.8', (b) => bevelBox(b, [0, 0, 0], [1, 0.6, 0.8], PALETTE.stone, { bevel: 0.08, jitter: 0.03, stream: s })],
  ['crookedBeam 4 m', (b) => crookedBeam(b, [0, 2, 0], [4, 2.1, 0], PALETTE.timber, { width: 0.42, sag: 0.06, wobble: 0.04, twist: 0.1, stream: s })],
  ['crookedBeam vertical 3 m', (b) => crookedBeam(b, [0, 0, 0], [0.05, 3, 0], PALETTE.timber, { width: 0.4, stream: s })],
  ['lathe barrel', (b) => lathe(b, [0, 0, 0], [[0.32, 0], [0.4, 0.45], [0.32, 0.9]], PALETTE.timber, { segments: 14, capBottom: true, capTop: true })],
  ['lathe faceted', (b) => lathe(b, [0, 0, 0], [[0.3, 0], [0.25, 1]], PALETTE.stone, { faceted: true, capTop: true, capBottom: true })],
  ['sweep ridge', (b) => sweep(b, [[0, 3, 0], [2, 3.1, 0], [4, 3, 0]], [[0.15, 0], [0, 0.15], [-0.15, 0], [0, -0.15]], PALETTE.slate, { caps: true })],
  ['tube branch', (b) => tube(b, [[0, 0, 0], [0.3, 1, 0], [0.8, 2, 0.2]], (f) => 0.2 * (1 - f * 0.6), PALETTE.bark, { caps: true })],
  ['rock 1.2', (b) => rock(b, [0, 0, 0], [1.2, 0.8, 1.0], PALETTE.stone, { stream: s })],
];
for (const [name, fn] of shapes) {
  const b = new MeshBuilder();
  fn(b);
  bakeAo(b, { rays: 8 });
  groundAo(b, () => 0);
  const rep = inspect(name, b);
  console.log(`  ${formatReport(rep)}`);
  if (rep.flipped > 0.02) warn(`${name}: ${rep.flipped * 100}% flipped`);
  if (rep.volume < 0) warn(`${name}: negative volume (inside out)`);
  if (rep.broken) warn(`${name}: broken vertices`);
}

console.log('\ncontent modules:');
const ctx = createBuildContext(seed, layout, field);
let total = 0;
for (const m of MODULES) {
  const c = m.build(ctx);
  let tris = 0;
  for (const p of c.statics ?? []) {
    tris += p.mesh.triangleCount;
    const rep = inspect(`${m.name}/${p.name ?? p.material}`, p.mesh);
    if (rep.broken) warn(`${rep.name}: broken vertices`);
    if (rep.flipped > 0.05 && p.material === 'solid') warn(`${rep.name}: ${(rep.flipped * 100).toFixed(1)} % flipped`);
  }
  let parts = 0;
  for (const set of c.parts ?? []) {
    parts += set.part.triangleCount * set.count;
    const rep = inspect(`${m.name}/${set.name}`, set.part);
    if (rep.broken) warn(`${rep.name}: broken vertices`);
    if (rep.flipped > 0.05) warn(`${rep.name}: ${(rep.flipped * 100).toFixed(1)} % flipped`);
    if (set.part.triangleCount && set.count === 0) warn(`${rep.name}: empty part set`);
    if (/\.sign$/.test(set.name)) console.log(`  ${formatReport(rep)} (hinge frame)`);
  }
  total += tris + parts;
  console.log(`  ${m.name.padEnd(14)} static ${tris} tris in ${(c.statics ?? []).length} pieces, parts ${parts} tris in ${(c.parts ?? []).length} sets, ${(c.lights ?? []).length} lights, ${(c.particles ?? []).length} emitters`);
}
console.log(`  total ${total} triangles`);

console.log(problems ? `\n${problems} problem(s)` : '\nno problems');
