// Numeric check of the buildings of the "buildings" part (cottages, forge, mill, windmill, castle), without a browser.
// Run in the dev container:
//   docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm exec vite build --ssr src/buildings/check.ts \
//     --outDir node_modules/.buildcheck --emptyOutDir --logLevel warn && node node_modules/.buildcheck/check.js'
// Prints the site numbers of each structure (pad, ground around, river), then builds every module and prints size,
// triangles, flipped share, volume, the lowest point against the pad, lights, particles and part sets.

import { formatReport, inspect } from '../kit/index.ts';
import { villageLayout, toLocal, riverNear, riverAt } from '../layout.ts';
import { heightField } from '../terrain/height.ts';
import { createBuildContext } from '../context.ts';
import { cottages } from './cottages.ts';
import { forge } from './forge.ts';
import { mill } from './mill.ts';
import { windmill } from './windmill.ts';
import { castle } from './castle.ts';

const seed = Number(process.argv[2] ?? 7);
const layout = villageLayout(seed);
const field = heightField(layout, seed);
const r2 = (v: number): string => v.toFixed(2);

console.log('sites:');
for (const s of layout.structures) {
  if (s.kind === 'inn') continue;
  const pad = field.padY(s.id);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < s.pad.ring.length; k += 2) {
    // Ground 1.5 m outside each pad corner.
    const x = s.pad.ring[k]!, z = s.pad.ring[k + 1]!;
    const dx = x - s.x, dz = z - s.z, l = Math.hypot(dx, dz) || 1;
    const h = field.heightAt(x + (dx / l) * 1.5, z + (dz / l) * 1.5);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  const rv = field.river(s.x, s.z);
  console.log(`  ${s.id.padEnd(10)} at ${r2(s.x)},${r2(s.z)} yaw ${r2(s.yaw)} pad ${r2(pad)} ground outside pad ${r2(lo)}..${r2(hi)} river ${r2(rv.dist)} (surface ${r2(rv.at.y)} w ${r2(rv.at.width)}) door ${r2(s.door.x)},${r2(s.door.z)} roof ${s.roof} plan ${s.plan ?? '-'}`);
}
const mw = layout.millWheel;
const millS = layout.structures.find((s) => s.id === 'mill')!;
console.log(`  wheel world ${r2(mw.x)},${r2(mw.y)},${r2(mw.z)} local ${toLocal(millS, mw.x, mw.z).map(r2).join(',')} yaw ${r2(mw.yaw)}`);
console.log(`  weir ${r2(layout.weir.x)},${r2(layout.weir.z)} yaw ${r2(layout.weir.yaw)} width ${r2(layout.weir.width)} top ${r2(layout.weir.top)} bottom ${r2(layout.weir.bottom)}`);
{
  const rn = riverNear(layout.river, mw.x, mw.z);
  console.log(`  wheel river: flowYaw ${r2(rn.flowYaw)} dist ${r2(rn.dist)} along ${r2(rn.at.along)} surface ${r2(rn.at.y)} width ${r2(rn.at.width)}; weir along ${r2(layout.weir.along)}`);
  for (let a = layout.weir.along - 12; a <= layout.weir.along + 8; a += 2) {
    const q = riverAt(layout.river, a);
    const l = toLocal(millS, q.x, q.z);
    console.log(`    along ${r2(a)}: ${r2(q.x)},${r2(q.z)} (mill local ${r2(l[0])},${r2(l[1])}) y ${r2(q.y)} w ${r2(q.width)} bed ${r2(field.heightAt(q.x, q.z))}`);
  }
}
// Ground and water along the mill's back (river) side and up to the weir.
for (let lz = -3; lz >= -8; lz -= 1) {
  const row: string[] = [];
  for (let lx = -6; lx <= 4; lx += 2) {
    const [dx, dz] = [Math.sin(millS.yaw) * lz + Math.cos(millS.yaw) * lx, Math.cos(millS.yaw) * lz - Math.sin(millS.yaw) * lx];
    const x = millS.x + dx, z = millS.z + dz;
    const rv = field.river(x, z);
    row.push(`${r2(field.heightAt(x, z))}${rv.inWater ? `~${r2(rv.at.y)}` : ''}`);
  }
  console.log(`  mill lz ${lz}: ${row.join('  ')}`);
}

const ctx = createBuildContext(seed, layout, field);
console.log('\nmodules:');
for (const m of [cottages, forge, mill, windmill, castle]) {
  const t0 = performance.now();
  const c = m.build(ctx);
  const ms = performance.now() - t0;
  let tris = 0;
  for (const p of c.statics ?? []) {
    tris += p.mesh.triangleCount;
    const rep = inspect(`${m.name}/${p.name ?? p.material}`, p.mesh);
    const st = layout.structures.find((q) => q.id === p.name);
    const below = st ? ` lowest ${r2(rep.min[1] - field.padY(st.id))} top ${r2(rep.max[1] - field.padY(st.id))} vs pad` : '';
    console.log(`  ${formatReport(rep)}${below}`);
  }
  for (const set of c.parts ?? []) {
    const rep = inspect(`${m.name}/part:${set.name}`, set.part);
    console.log(`  ${formatReport(rep)} × ${set.count} (${set.dynamic ? 'dynamic' : 'static'})`);
  }
  if (c.update) {
    const f = { time: 1.5, dt: 0.016, evening: 1, alpha: 0, eye: [0, 30, 40] as [number, number, number], villagersVisible: true };
    c.update(f);
  }
  console.log(`  -> ${m.name}: static ${tris} tris, ${(c.lights ?? []).length} lights, ${(c.particles ?? []).length} emitters, ${(c.parts ?? []).length} part sets, build ${ms.toFixed(0)} ms, stats ${JSON.stringify(c.stats ?? {})}`);
}
