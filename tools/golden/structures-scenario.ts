// Golden scenario of the structures of the system example (examples/system/src/structures.ts, damage.ts) on the plan
// of seed 725 at stage 4: the kinds of the villages, the spans with their piers and parapets, the town's ring, the
// distant massing and one strike there and back. Broken properties of the generated world are printed as GAP lines
// (the report lists them); a broken invariant of determinism or of the damage round trip throws.

import type { Vec3 } from '../../packages/wallhammer-web/src/base/index.ts';
import { SITE_KIND, STAGE } from '../../examples/system/src/plan.ts';
import { STRUCTURE_KIND, STRUCTURE_KIND_NAME, buildStructure, clusterCount, clusterFull, clusterMassing, clusterRecipes, siteKinds, structureScope } from '../../examples/system/src/structures.ts';
import type { StructureRecipe } from '../../examples/system/src/structures.ts';
import { STRIKE_ENERGY, STRIKE_RADIUS_M, createDamage } from '../../examples/system/src/damage.ts';
import { PACKED, planAt } from './plan-scenario.ts';

const stop = (what: string): never => {
  throw new Error(what);
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const sameBytes = (a: ArrayBufferView, b: ArrayBufferView): boolean => {
  const x = bytesOf(a);
  const y = bytesOf(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * "system example structures". Asserts: villages of ≥ 6 lots hold ≥ 5 kinds; frames orthonormal with y = origin; one
 * recipe per kind under 15 000 triangles; every span cluster has piers and parapets in its recipes and in its massing;
 * the town (when the plan has one) has a ring of ramparts in its massing; one strike on a hall changes its state,
 * `decode(encode())` keeps `hash()`, the damaged mesh differs and after `clear()` the rebuilt mesh equals the intact
 * bytes. Returns the parts to hash: kinds of three sites, one mesh per kind, the massing of a village and a span, the
 * state hash after the strike.
 */
export function structuresScript(): unknown[] {
  const plan = planAt(STAGE.routes);
  const S = plan.sites ?? stop('structures: no sites');
  const scope = structureScope(plan);
  const gaps: string[] = [];
  const clusters = clusterCount(plan);
  const spans = clusters - S.count;
  const towns = Array.from({ length: S.count }, (_, s) => s).filter((s) => S.kind[s] === SITE_KIND.town);
  if (towns.length === 0) gaps.push('the plan of seed 725 has no town: no rampart ring anywhere, the town walls never reach the distant level');
  // Villages: kinds.
  let small = 0;
  let poor = 0;
  for (let s = 0; s < S.count; s++) {
    const kinds = siteKinds(plan, s);
    if (kinds.length < 6) {
      small++;
      continue;
    }
    if (new Set(kinds).size < 5) poor++;
  }
  if (poor) gaps.push(`${poor} sites of ≥ 6 lots hold fewer than 5 kinds`);
  // Frames and one recipe per kind.
  const perKind = new Map<number, StructureRecipe>();
  let frames = 0;
  for (let c = 0; c < clusters; c++) {
    for (const r of clusterRecipes(plan, c)) {
      const f = r.frame;
      for (const [a, b] of [[f.x, f.y], [f.y, f.z], [f.x, f.z]] as const) if (Math.abs(dot(a, b)) > 1e-9) stop(`structures: frame of ${r.key} not orthogonal`);
      for (const a of [f.x, f.y, f.z]) if (Math.abs(dot(a, a) - 1) > 1e-9) stop(`structures: frame of ${r.key} not unit`);
      if (f.y.some((v, k) => Math.abs(v - f.origin[k]!) > 1e-12)) stop(`structures: frame of ${r.key} has y ≠ origin`);
      frames++;
      if (!perKind.has(r.kind)) perKind.set(r.kind, r);
    }
  }
  const meshes: unknown[] = [];
  const triangles: string[] = [];
  for (const kind of [...perKind.keys()].sort((a, b) => a - b)) {
    const r = perKind.get(kind)!;
    const m = buildStructure(r, plan, scope).mesh;
    const t = (m.indices?.length ?? m.count) / 3;
    if (t > 15000) gaps.push(`${STRUCTURE_KIND_NAME[kind]} ${r.key} has ${t} triangles`);
    triangles.push(`${STRUCTURE_KIND_NAME[kind]} ${t}`);
    meshes.push(kind, m.vertices, m.indices ?? []);
  }
  const missingKinds = Object.values(STRUCTURE_KIND).filter((k) => !perKind.has(k)).map((k) => STRUCTURE_KIND_NAME[k]);
  if (missingKinds.length) gaps.push(`kinds that occur nowhere in the world: ${missingKinds.join(', ')}`);
  // Spans: piers and parapets, in the recipes and in the massing.
  let withPier = 0;
  let withParapet = 0;
  let massed = 0;
  let spanMassing: unknown[] = [];
  for (let c = S.count; c < clusters; c++) {
    const rs = clusterRecipes(plan, c);
    const kinds = new Set(rs.map((r) => r.kind));
    if (kinds.has(STRUCTURE_KIND.pier)) withPier++;
    if (kinds.has(STRUCTURE_KIND.parapet)) withParapet++;
    const m = clusterMassing(plan, c);
    if (m.keys.length === rs.length && m.spans[rs.length]! > 0) massed++;
    if (c === S.count) spanMassing = [m.mesh.vertices, m.mesh.indices ?? [], m.keys];
  }
  if (withParapet < spans) gaps.push(`${spans - withParapet} of ${spans} spans have no parapet`);
  if (massed < spans) gaps.push(`${spans - massed} of ${spans} spans have no massing`);
  // Ramparts in the massing of a town.
  for (const t of towns) {
    const rs = clusterRecipes(plan, t);
    const m = clusterMassing(plan, t);
    const ramparts = rs.filter((r) => r.kind === STRUCTURE_KIND.rampart).length;
    if (ramparts === 0) gaps.push(`town ${t} has no rampart`);
    if (m.keys.length !== rs.length) gaps.push(`the massing of town ${t} misses items`);
  }
  // A village's massing.
  const village = Array.from({ length: S.count }, (_, s) => s).find((s) => S.kind[s] === SITE_KIND.village && siteKinds(plan, s).includes(STRUCTURE_KIND.hall)) ?? stop('structures: no village with a hall');
  const vm = clusterMassing(plan, village);
  // One strike on the hall of that village.
  const hallItem = clusterRecipes(plan, village).findIndex((r) => r.kind === STRUCTURE_KIND.hall);
  const hall = clusterRecipes(plan, village)[hallItem]!;
  const full = clusterFull(plan, village, [hallItem])[0] ?? stop('structures: no full mesh of the hall');
  const near = clusterRecipes(plan, village);
  const descs = new Map(clusterFull(plan, village, near.map((_, i) => i)).map((f) => [f.key, f.descs]));
  const damage = createDamage({ packed: PACKED, plan: () => plan, near: () => near, descs: (key) => descs.get(key) ?? [] });
  const intact = damage.hash();
  const changed = damage.strike(hall.frame.origin, hall.frame.heightM + 3, STRIKE_RADIUS_M, STRIKE_ENERGY);
  if (!changed.includes(hall.key)) stop(`structures: the strike on hall ${hall.key} changed ${changed.join(',') || 'nothing'}`);
  const struck = damage.hash();
  if (struck === intact) stop('structures: the strike left the state hash as it was');
  const falling = damage.last().reduce((n, c) => n + c.parts.length, 0);
  const text = damage.encode();
  damage.clear();
  if (damage.hash() !== intact) stop('structures: clear() did not give the intact hash');
  damage.decode(text);
  if (damage.hash() !== struck) stop('structures: decode(encode()) changed the hash');
  const states = damage.states(hall.key) ?? stop('structures: no state of the struck hall');
  // As the page rebuilds it (settlement-layer.ts `build`).
  const damaged = buildStructure(hall, plan, scope, { describe: true, states }).mesh;
  if (sameBytes(damaged.vertices, full.mesh.vertices)) stop('structures: the damaged hall mesh equals the intact one');
  damage.clear();
  const rebuilt = buildStructure(hall, plan, scope, { describe: true }).mesh;
  if (!sameBytes(rebuilt.vertices, full.mesh.vertices)) stop('structures: after clear() the hall mesh differs from the intact bytes');
  console.log(`  system example structures — ${S.count} sites (${towns.length} towns, ${small} with fewer than 6 lots), ${spans} spans (${withPier} with piers, ${withParapet} with parapets, ${massed} with massing), ${frames} frames; triangles per kind: ${triangles.join(', ')}; strike on hall ${hall.key}: ${changed.length} structure(s), ${falling} part(s) changed`);
  for (const g of gaps) console.log(`  GAP system example structures: ${g}`);
  return [[0, 1, village].map((s) => [...siteKinds(plan, s)]), meshes, vm.mesh.vertices, vm.mesh.indices ?? [], spanMassing, struck];
}
