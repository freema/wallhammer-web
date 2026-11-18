// Numeric check of the vegetation (no browser): templates, giants, the whole module, and probes that nothing grows on
// streets, in the water or in buildings. Run in the dev container:
//   pnpm exec vite build --ssr src/vegetation/check.ts --outDir node_modules/.vegcheck --emptyOutDir --logLevel warn && node node_modules/.vegcheck/check.js

import { Stream, formatReport, inspect } from '../kit/index.ts';
import { villageLayout } from '../layout.ts';
import { heightField } from '../terrain/height.ts';
import { createBuildContext } from '../context.ts';
import { vegetation, vegetationMask } from './index.ts';
import type { TreeTemplate } from './trees.ts';
import { treeTemplate } from './trees.ts';
import { groundTemplates } from './ground-cover.ts';
import { cropTemplates } from './crops.ts';

const seed = Number(process.argv[2] ?? 7);
const layout = villageLayout(seed);
const field = heightField(layout, seed);
const ctx = createBuildContext(seed, layout, field);
const s = Stream.of(seed, 'check');

console.log('templates:');
for (const k of ['oak', 'apple', 'fir', 'pine', 'bush', 'oak-far', 'fir-far'] as TreeTemplate[]) console.log('  ' + formatReport(inspect(k, treeTemplate(k, s.child(k)))));
const gt = groundTemplates(s.child('g'));
gt.grass.forEach((m, i) => console.log('  ' + formatReport(inspect(`grass${i}`, m))));
for (const [k, l] of Object.entries(gt.flowers)) console.log('  ' + formatReport(inspect(`flower-${k}`, l[0]!)));
gt.ferns.forEach((m, i) => console.log('  ' + formatReport(inspect(`fern${i}`, m))));
gt.reeds.forEach((m, i) => console.log('  ' + formatReport(inspect(`reeds${i}`, m))));
gt.stones.forEach((m, i) => console.log('  ' + formatReport(inspect(`stone${i}`, m))));
gt.mushrooms.forEach((m, i) => console.log('  ' + formatReport(inspect(`mush${i}`, m))));
const ct = cropTemplates(s.child('c'));
for (const [k, l] of Object.entries(ct)) console.log('  ' + formatReport(inspect(`crop-${k}`, l[0]!)));

const t0 = performance.now();
const c = vegetation.build(ctx);
console.log(`\nbuild ${(performance.now() - t0).toFixed(0)} ms`);
let total = 0;
for (const p of c.statics ?? []) {
  const r = inspect(p.name ?? '?', p.mesh);
  total += r.triangles;
  console.log('  static ' + formatReport(r));
}
for (const p of c.parts ?? []) {
  const t = p.part.triangleCount * p.count;
  total += t;
  console.log(`  parts ${p.name}: ${p.count} × ${p.part.triangleCount} = ${t} tris`);
}
console.log(`total ${total} tris, part sets ${(c.parts ?? []).length}, statics ${(c.statics ?? []).length}`);
console.log('stats', JSON.stringify(c.stats));

// Giants against the roofs: crown top vs nearby houses.
const giants = (c.statics ?? []).filter((p) => p.name?.startsWith('giant'));
for (const g of giants) {
  const { min, max } = g.mesh.bounds();
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const ground = field.heightAt(cx, cz);
  console.log(`  ${g.name}: top ${(max[1] - ground).toFixed(1)} m above ground, crown ${(max[0] - min[0]).toFixed(1)} × ${(max[2] - min[2]).toFixed(1)}, lowest ${(min[1] - ground).toFixed(2)}`);
}
const inn = layout.structures.find((q) => q.id === 'inn')!;
console.log(`  inn pad ${field.padY('inn').toFixed(1)}, stories ${inn.stories}, body ${inn.body.w}×${inn.body.d}`);

// Probes: vertices of ground cover statics on paved ground, in the water or inside buildings.
const mask = vegetationMask(ctx);
for (const p of c.statics ?? []) {
  if (p.name?.startsWith('giant') || p.name === 'ivy') continue;
  const P = p.mesh.positionData;
  let paved = 0, wet = 0, inside = 0, under = 0, n = 0;
  for (let i = 0; i < P.length; i += 3 * 7) {
    const x = P[i]!, y = P[i + 1]!, z = P[i + 2]!;
    n++;
    if (mask.paved(x, z) < -0.25) paved++;
    if (p.name !== 'ferns-reeds-mushrooms' && mask.water(x, z).edge < -0.2) wet++;
    if (mask.building(x, z) < -0.1) inside++;
    if (y < field.heightAt(x, z) - 0.6) under++;
  }
  console.log(`  probe ${p.name}: ${n} pts, paved ${paved}, water ${wet}, inside ${inside}, deep under ${under}`);
}

