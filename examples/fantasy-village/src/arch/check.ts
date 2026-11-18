// Numeric check of the architecture kit and the inn, without a browser. Run in the dev container:
//   docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm exec vite build --ssr src/arch/check.ts \
//     --outDir node_modules/.archcheck --emptyOutDir --logLevel warn && node node_modules/.archcheck/check.js'
// Prints size, triangles, flipped share and volume of each generator on its own and of the whole inn, the inn's
// triangles by material class, its lights and particles, and how far it reaches below its pad.

import { MAT, MeshBuilder, Stream, compose34, formatReport, inspect } from '../kit/index.ts';
import { villageLayout } from '../layout.ts';
import { heightField } from '../terrain/height.ts';
import { createBuildContext } from '../context.ts';
import { inn } from '../buildings/inn.ts';
import { COTTAGE_RED, INN_PALETTE } from './palette.ts';
import { emitters, openSite } from './site.ts';
import type { Site } from './site.ts';
import { buttress, stoneChimney, stonePlinth } from './stone.ts';
import { doorAt, windowAt } from './openings.ts';
import { buildRoof, dormer, dormerHole, roofShape } from './roof.ts';
import { banner, barrel, hangingSign, wallLantern } from './details.ts';
import { buildHouse } from './house.ts';

const seed = Number(process.argv[2] ?? 7);
const one = (name: string, fn: (s: Site) => void, pal = INN_PALETTE): void => {
  const b = new MeshBuilder();
  openSite(b, compose34([0, 0, 0]), new Stream(seed).child(name), pal, emitters(), fn);
  console.log('  ' + formatReport(inspect(name, b)));
};

console.log('generators alone (local metres):');
one('plinth 6x4', (s) => stonePlinth(s, { ring: [[-3, 2], [3, 2], [3, -2], [-3, -2]], top: 0.7, rises: [{ edge: 0, u0: 0, u1: 1.2, top: 1.5 }] }));
one('buttress', (s) => buttress(s, { x: 0, z: 0, yaw: 0 }));
one('chimney', (s) => void stoneChimney(s, { x: 0, z: 0, y0: 0, y1: 6, pots: 2, breast: { height: 3, extra: 0.4 } }));
one('window square', (s) => windowAt(s, { u: 0, v: 1, w: 0.9, h: 1.2, shutters: true, box: true }));
one('window round', (s) => windowAt(s, { shape: 'round', u: 0, v: 1, w: 1, h: 1, box: true }));
one('window arched', (s) => windowAt(s, { shape: 'arched', u: 0, v: 1, w: 0.8, h: 1.3, bars: 'lattice' }));
one('door arched', (s) => doorAt(s, { u: 0, v: 0.7, w: 1.4, h: 2.5, steps: 0.7 }));
one('door square timber', (s) => doorAt(s, { u: 0, v: 0, w: 1, h: 2.1, shape: 'square', surround: 'timber' }));
one('sign', (s) => hangingSign(s, { u: 0, v: 2.7 }));
one('banner', (s) => banner(s, { u: 0, v: 2.5 }));
one('lantern', (s) => wallLantern(s, { u: 0, v: 2.3 }));
one('barrel', (s) => barrel(s, { at: [0, 0, 0] }));
one('roof 8x6', (s) => {
  const sh = roofShape({ x: 0, z: 0, y: 3, axis: 'x', length: 8, span: 6, rise: 4 });
  const d = { s: 1, side: 1 as const };
  buildRoof(s, sh, { holes: [dormerHole(sh, d)] });
  dormer(s, sh, d);
  console.log(`    roof ridge y ${sh.ridgeY.toFixed(2)}, eave corner y ${(sh.y(-sh.halfL - 0.7, sh.qMax) + 3).toFixed(2)}, middle eave y ${(sh.y(0, sh.qMax) + 3).toFixed(2)}`);
}, COTTAGE_RED);
one('cottage house', (s) =>
  void buildHouse(s, {
    rect: { x: 0, z: 0, w: 7, d: 5 },
    storeys: [2.8],
    openings: [{ side: 'front', storey: 0, at: 0, door: { w: 1.1, h: 2.1 } }, { side: 'front', storey: 0, at: 2, window: { w: 0.8, h: 1, shutters: true, box: true } }],
    roof: { axis: 'x', dormers: [{ facing: 'front', at: -1.5 }] },
    chimneys: [{ x: 2, z: -1 }],
  }), COTTAGE_RED);

// The inn as the scene builds it.
const layout = villageLayout(seed);
const field = heightField(layout, seed);
const ctx = createBuildContext(seed, layout, field);
const t0 = performance.now();
const c = inn.build(ctx);
const ms = performance.now() - t0;
console.log(`\ninn module: built in ${ms.toFixed(0)} ms`);
const s = layout.structures.find((q) => q.id === 'inn')!;
const pad = field.padY('inn');
for (const st of c.statics ?? []) {
  const r = inspect(st.name ?? '?', st.mesh);
  console.log('  ' + formatReport(r));
  console.log(`  pad y ${pad.toFixed(2)}: lowest point ${(r.min[1] - pad).toFixed(2)} m below the pad, highest ${(r.max[1] - pad).toFixed(2)} m above`);
  const names = Object.fromEntries(Object.entries(MAT).map(([k, v]) => [v, k]));
  const byCls: Record<string, number> = {};
  const b = st.mesh;
  for (let t = 0; t < b.indexCount; t += 3) {
    const cls = names[b.flg[b.indexData[t]! * 4 + 2]!] ?? '?';
    byCls[cls] = (byCls[cls] ?? 0) + 1;
  }
  console.log('  by class: ' + Object.entries(byCls).sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  let glow = 0, sway = 0;
  for (let v = 0; v < b.vertexCount; v++) {
    if (b.flg[v * 4]! > 0) glow++;
    if (b.flg[v * 4 + 1]! > 0) sway++;
  }
  console.log(`  vertices with glow ${glow}, with sway ${sway}`);
}
console.log(`  lights ${c.lights?.length ?? 0}:`);
for (const l of c.lights ?? []) console.log(`    at ${l.position.map((v) => v.toFixed(1)).join(', ')} (${(l.position[1] - pad).toFixed(1)} above pad) r ${l.radius} i ${l.intensity} ${l.when}`);
console.log(`  particle emitters ${c.particles?.length ?? 0}, particles ${(c.particles ?? []).reduce((a, p) => a + p.count, 0)}:`);
for (const p of c.particles ?? []) console.log(`    ${p.kind} at ${p.position.map((v) => v.toFixed(1)).join(', ')} (${(p.position[1] - pad).toFixed(1)} above pad)`);
console.log(`  structure at ${s.x}, ${s.z} yaw ${s.yaw.toFixed(2)}, stats ${JSON.stringify(c.stats)}`);

// Where the inn's triangles go: the main body and the wing built with parts switched off.
{
  const { mainSpec, wingSpec } = await import('../buildings/inn.ts');
  const count = (name: string, spec: import('./house.ts').HouseSpec): number => {
    const b = new MeshBuilder();
    openSite(b, compose34([0, 0, 0]), new Stream(seed).child(name), INN_PALETTE, emitters(), (st) => void buildHouse(st, spec));
    return b.triangleCount;
  };
  for (const [name, spec] of [['main', mainSpec(s)], ['wing', wingSpec(s)]] as const) {
    const all = count(name, spec);
    const noOpen = count(name, { ...spec, openings: [] });
    const noRoof = count(name, { ...spec, openings: [], roof: false, chimneys: [] });
    const noChim = count(name, { ...spec, chimneys: [] });
    const bare = count(name, { ...spec, openings: [], roof: false, chimneys: [], storeys: [0.01], plinth: {} });
    console.log(`  ${name}: all ${all}, openings ${all - noOpen}, roof+dormers ${noOpen - noRoof - (all - noChim)}, chimneys ${all - noChim}, walls+frame ${noRoof - bare}, plinth ${bare}`);
  }
}
