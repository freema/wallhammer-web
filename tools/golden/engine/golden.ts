// Golden hashes of the engine's generators: small fixed recipes, each run through one generator, its output bytes
// hashed and compared with the stored hash. A generator is pure (input + seed → data), so any difference is a real
// change. These recipes need only the engine package; recipes that need example code live one folder up
// (tools/golden/), next to the examples' tools.
//
//   node tools/golden/engine/golden.ts            check (exit code 1 and the generator's name on a mismatch)
//   node tools/golden/engine/golden.ts --accept   store the current hashes after a deliberate change (see README.md)

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeightField, Occupancy, OutlineField, orientedBox, ringSignedArea, splitInstanceCells } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import type { Ring } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { heightFieldMesh, lineMesh, rigMesh, rigShadowMesh } from '../../../packages/wallhammer-web/src/gen-mesh/index.ts';
import type { PropBox } from '../../../packages/wallhammer-web/src/gen-mesh/index.ts';
import { boxBlur, colorTable } from '../../../packages/wallhammer-web/src/gen-tex/index.ts';
import { GROUND_FLOOR, ROOF_PROFILE, buildBuildingMesh } from '../../../packages/wallhammer-web/src/gen-arch/index.ts';
import type { BuildingSpec, FacadeRecipe, RoofKind, RoofProfile } from '../../../packages/wallhammer-web/src/gen-arch/index.ts';
import { applyEventToAll, destructionEvent } from '../../../packages/wallhammer-web/src/sim/destruction/index.ts';
import { buildGroundMarkings, buildOcclusionMask, groundBake } from '../../../packages/wallhammer-web/src/gen-ground/index.ts';
import { buildTreeBatch, packTreeInstances, plantTrees } from '../../../packages/wallhammer-web/src/gen-vegetation/index.ts';
import type { PlantingRules } from '../../../packages/wallhammer-web/src/gen-vegetation/index.ts';
import { swaySlot } from '../../../packages/wallhammer-web/src/gen-vegetation/index.ts';
import { seasonSlot, snowSlot } from '../../../packages/wallhammer-web/src/gen-ground/index.ts';
import { windowLightSlot } from '../../../packages/wallhammer-web/src/gen-arch/index.ts';
import { Environment, SKY_GLSL, assembleFrameBlock, skySlot } from '../../../packages/wallhammer-web/src/env/index.ts';
import { cellDetail } from '../../../packages/wallhammer-web/src/render/cells.ts';
import { FRAME_PATTERNS, runPoseScenario, runSimScenario } from './sim-scenario.ts';
import { runAgendaScenario, runAgentsScenario, runLanesScenario } from './behaviour-scenario.ts';
import { damagedMeshes, descData, describeAll, encodeStates, fallTracks, interiorMesh, interiorPlans, rubbleData, runDestruction, stateHash, timelineScript } from './destruction-scenario.ts';
import { farSurface, orbitScript, trigTable } from './frames-scenario.ts';
import { depthModes } from './depth-scenario.ts';
import { bisectScript, ceilingScript, packScript } from './tiles-scenario.ts';
import { flowReference, flowVariants, regionRoutes } from './flow-scenario.ts';
import { flowProbeLine } from '../../../packages/wallhammer-web/src/sim/index.ts';
import { drapeEvery, drapeTiles, prismMesh, triangulateRing } from '../../../packages/wallhammer-web/src/gen-mesh/index.ts';
import { VALUE_RAMPS, colorRamp, quantizeValues, valueTableSize, wordTexture, wordValue } from '../../../packages/wallhammer-web/src/gen-tex/index.ts';
import { MASSING_LAYOUT, buildMassingMesh, roofTones, stampFootprints } from '../../../packages/wallhammer-web/src/gen-arch/index.ts';
import { CodeStamp } from '../../../packages/wallhammer-web/src/gen-tex/index.ts';
import type { CodeRegion } from '../../../packages/wallhammer-web/src/gen-tex/index.ts';
import { LevelFade, fadeFragment } from '../../../packages/wallhammer-web/src/core/index.ts';
import { areaFrames, areaScript, horizonScript } from './shadow-scenario.ts';
import { stripNetScript, stripPlaneScript, stripSphereScript } from './strip-scenario.ts';
import { cellStatesScript, refreshScript } from './cell-states-scenario.ts';
import { DEFAULT_ATMOSPHERE_MEDIUM, atmosphereFor, atmosphereSlot, atmosphereTables, sphereSunDirection, sunPosition } from '../../../packages/wallhammer-web/src/env/index.ts';
import { COVER_FADE_GLSL, coverFade, coverKeep } from '../../../packages/wallhammer-web/src/core/index.ts';
import { SPHERE_PATCH_COVER_LAYOUT, SPHERE_PATCH_LAYOUT, spherePatchMesh, valueNoise3 } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { NEAR_FLOATS, SPHERE_PATCH_COVER_EXTRA_LAYOUT, SPHERE_PATCH_EXTRA_LAYOUT, cubeNeighbour, distToSegment, lineRing, nearCount, nearKeep, nearScatter } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import type { NearFade, NearRecords } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { BUILDING_LAYOUT, ROOF_COVER, WALL_FINISH } from '../../../packages/wallhammer-web/src/gen-arch/index.ts';
import { RIG_BEND_AXIS, RIG_MOTION, RIG_VERTEX_FLOATS, rigExtended } from '../../../packages/wallhammer-web/src/base/index.ts';
import type { MeshData, RigDesc, RigPart } from '../../../packages/wallhammer-web/src/base/index.ts';
import { drainageScript, gridWeightsScript, lineTilesScript, planHorizonScript, planGridScript, routesScript } from './plan-scenario.ts';
import { plotsScript, sitesScript } from './sites-scenario.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, 'hashes.json');

/** Hash of typed arrays (their bytes) and plain values (as JSON), in order. */
function hash(...parts: unknown[]): string {
  const h = createHash('sha256');
  const feed = (p: unknown): void => {
    if (ArrayBuffer.isView(p)) h.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    else if (Array.isArray(p)) p.forEach(feed);
    else h.update(JSON.stringify(p) ?? 'undefined');
  };
  parts.forEach(feed);
  return h.digest('hex').slice(0, 16);
}

// --- Fixed inputs -------------------------------------------------------------------------------------------------
const field = new HeightField(4, 9, 7, Float32Array.from({ length: 63 }, (_, i) => 100 + ((i * 37) % 11) * 0.3 + (i % 9) * 0.2));
const ground = (x: number, z: number): number => field.heightAt(x, z);
const rect = (x: number, z: number, w: number, d: number): Ring => {
  const r = Float32Array.of(x, z, x + w, z, x + w, z + d, x, z + d);
  return ringSignedArea(r) > 0 ? r : Float32Array.of(x, z, x, z + d, x + w, z + d, x + w, z);
};
const MESH_DIMS = { minWallHeight: 2.6, wallBelowGround: 0.6, floorHeightMin: 2.7, floorHeightMax: 4.6, parapetThickness: 0.35, roofSlopeMin: 0.32, roofSlopeMax: 1.2, roofUnitMinRoofArea: 60, roofUnitAreaPerUnit: 40, roofUnitMaxCount: 3, roofUnitMinSize: 1.2, roofUnitMaxSize: 3, roofUnitMinHeight: 0.8, roofUnitMaxHeight: 2 };
const RECIPE: FacadeRecipe = {
  groundFloorHeight: 3.6, groundFloor: GROUND_FLOOR.glazed, plinthHeight: 0.5, curtainShare: 0.4, blindShare: 0.2, panelJoints: true, blindEndWalls: 6,
  window: { width: 1.2, height: 1.5, sill: 0.9, mullions: 1, transom: true, narrowMask: 0 },
  balconies: { kind: 'balcony', depth: 1.2, columnMask: 0b0101, minWallLength: 8 }, cornice: { height: 0.4, projection: 0.3 },
  entrances: [{ x: 6, z: 0, kind: 'door', width: 1.4, raise: 0.4, canopy: 1 }], stairStrip: true, chimneys: 2, roofBoxes: null,
  colors: { frame: 3, plinth: 4, door: 5, accent: 6, chimney: 7 },
};
function building(id: number, roof: RoofKind, ridgeY: number, facade?: FacadeRecipe): BuildingSpec {
  const rings = [rect(4 + id * 2, 4, 14, 9)];
  return { id, hash: id * 2654435761, rings, box: orientedBox(rings[0]!), groundMin: 100, groundRef: 100.5, eaveY: 112, ridgeY, roof, ridgeAcross: false, levelsHint: 3, floorHeightNominal: 3.1, bayWidth: 3, windowStyle: 1, parapetHeight: 0.5, wallColor: 8, roofColor: 9, trimColor: 10, roofUnitColor: 11, ...(facade ? { facade } : {}) };
}
/** A regular n-gon with positive area. */
function polygon(cx: number, cz: number, r: number, n: number): Ring {
  const pts: number[] = [];
  for (let k = 0; k < n; k++) pts.push(cx + r * Math.cos((2 * Math.PI * k) / n), cz + r * Math.sin((2 * Math.PI * k) / n));
  const ring = Float32Array.from(pts);
  return ringSignedArea(ring) > 0 ? ring : reversed(ring);
}
function reversed(ring: Ring): Ring {
  const out = new Float32Array(ring.length);
  for (let k = 0; k < ring.length; k += 2) ((out[k] = ring[ring.length - 2 - k]!), (out[k + 1] = ring[ring.length - 1 - k]!));
  return out;
}
/** A profile of the app's own: flat low, steep high. */
const OWN_PROFILE: RoofProfile = [
  [0, 0],
  [0.5, 0.3],
  [1, 1],
];
/** Façade of a composition: tall arched windows, an arch entrance, a cornice, no chimneys. */
const ARCH_RECIPE: FacadeRecipe = {
  ...RECIPE, groundFloorHeight: 0, groundFloor: GROUND_FLOOR.windows, panelJoints: false, blindEndWalls: 0, balconies: null, stairStrip: false, chimneys: 0,
  window: { width: 1.5, height: 6.5, sill: 1.4, mullions: 1, transom: false, narrowMask: 0, arch: true },
  entrances: [{ x: 20, z: 6, kind: 'arch', width: 2.4, raise: 0.2, canopy: 0 }],
};
/**
 * A composition of three parts: a gabled body, a tall part beside its end with a pointed roof, a small domed part on
 * the body's roof. `group` 0 makes them three unrelated structures.
 */
function composition(group: number): BuildingSpec[] {
  const spec = (id: number, ring: Ring, roof: RoofKind, ground: number, eave: number, ridge: number, storey: number, facade: FacadeRecipe): BuildingSpec => ({
    id, hash: id * 2654435761, rings: [ring], box: orientedBox(ring), groundMin: ground, groundRef: ground, eaveY: eave, ridgeY: ridge, roof, ridgeAcross: false,
    levelsHint: 0, floorHeightNominal: storey, bayWidth: 3.6, windowStyle: 3, parapetHeight: 0, wallColor: 8, roofColor: 9, trimColor: 10, roofUnitColor: 11, facade, ...(group ? { group } : {}),
  });
  const shaft: FacadeRecipe = { ...ARCH_RECIPE, cornice: null, entrances: [], window: { width: 1.0, height: 2.4, sill: 2.2, mullions: 0, transom: false, narrowMask: 0, arch: true } };
  return [
    spec(50, rect(10, 10, 20, 10), 'gable', 100.2, 110, 116, 9.8, ARCH_RECIPE),
    spec(51, rect(30, 12, 6, 6), 'apex', 100.4, 121, 133, 6, shaft),
    spec(52, rect(13, 13, 3, 3), 'dome', 112, 116, 118.5, 4, shaft),
  ];
}
const RULES: PlantingRules =JSON.parse(fs.readFileSync(path.join(HERE, 'planting-rules.json'), 'utf8')) as PlantingRules;
const TREE_MATERIAL = { deep: 1, mid: 2, leaf: 3, leafAlt: 4, trunk: 5 };

// --- Recipes: one generator each ------------------------------------------------------------------------------------
const RECIPES: Record<string, () => string> = {
  'gen-mesh heightFieldMesh': () => {
    const m = heightFieldMesh(field, 90);
    return hash(m.vertices, m.indices, m.count);
  },
  'gen-mesh lineMesh': () => hash(lineMesh([{ points: [1, 1, 20, 5, 30, 20], closed: true }], ground, 0.4, 2).vertices),
  'gen-tex colorTable + boxBlur': () => hash(colorTable(new Map([[3, [0.2, 0.5, 0.1]]])).data, boxBlur(Float32Array.from({ length: 64 }, (_, i) => (i * 7) % 5), 8, 8, 2)),
  'gen-arch structure mesh (flat roof, simple windows)': () => {
    const r = buildBuildingMesh([building(1, 'flat', 112)], [], ground, MESH_DIMS);
    return hash(r.mesh.vertices, r.mesh.count, r.stats);
  },
  'gen-arch roof (gable and hip)': () => {
    const r = buildBuildingMesh([building(2, 'gable', 116), building(3, 'hip', 115)], [], ground, MESH_DIMS);
    return hash(r.mesh.vertices, r.stats);
  },
  'gen-arch façade recipe': () => {
    const props: PropBox[] = [];
    const r = buildBuildingMesh([building(4, 'flat', 112, RECIPE)], props, ground, MESH_DIMS);
    return hash(r.mesh.vertices, r.stats, r.anchored);
  },
  'gen-arch field roof budget (large L footprint: 1000 and 4000 triangles; a budget it never reaches changes nothing)': () => {
    const pts = [0, 0, 90, 0, 90, 45, 45, 45, 45, 90, 0, 90].map((v) => v + 10);
    const ring = ringSignedArea(Float32Array.from(pts)) > 0 ? Float32Array.from(pts) : Float32Array.from(pts.flatMap((_, k, a) => (k % 2 ? [] : [a[a.length - 2 - k]!, a[a.length - 1 - k]!])));
    const hall: BuildingSpec = { ...building(5, 'field', 118), rings: [ring], box: orientedBox(ring) };
    const small = building(6, 'field', 116);
    const plain = buildBuildingMesh([small], [], ground, MESH_DIMS);
    const roomy = buildBuildingMesh([small], [], ground, { ...MESH_DIMS, fieldRoofMaxTriangles: 1e6 });
    if (hash(plain.mesh.vertices) !== hash(roomy.mesh.vertices)) throw new Error('field roof: an unreached budget changed the mesh');
    const parts: unknown[] = [plain.mesh.vertices];
    for (const budget of [1000, 4000]) {
      const r = buildBuildingMesh([hall], [], ground, { ...MESH_DIMS, fieldRoofMaxTriangles: budget });
      if (r.stats.roofFallbacks) throw new Error('field roof: the budgeted hall fell back to a flat roof');
      parts.push(r.mesh.vertices, r.mesh.count);
    }
    return hash(parts);
  },
  'gen-arch apex and dome roofs (square, octagon, 12-gon; straight, dome, own profile)': () => {
    const at = (id: number, ring: Ring, roof: RoofKind, ridgeY: number): BuildingSpec => ({ ...building(id, roof, ridgeY), rings: [ring], box: orientedBox(ring) });
    const specs = [
      at(30, rect(4, 4, 8, 8), 'apex', 124),
      at(31, polygon(26, 10, 5, 8), 'dome', 117),
      at(32, polygon(42, 10, 6, 12), 'apex', 121),
      { ...at(33, polygon(58, 10, 5, 8), 'dome', 118), roofProfile: OWN_PROFILE },
      { ...at(34, polygon(74, 10, 6, 12), 'apex', 120), roofProfile: OWN_PROFILE },
    ];
    const r = buildBuildingMesh(specs, [], ground, MESH_DIMS);
    if (r.stats.roofFallbacks !== 0 || r.stats.tier1 !== specs.length) throw new Error('apex roofs: a convex footprint fell back');
    // A concave footprint has no single top point: the roof falls back to flat and is counted.
    const ell = Float32Array.of(90, 4, 100, 4, 100, 8, 94, 8, 94, 14, 90, 14);
    const concave = buildBuildingMesh([at(35, ringSignedArea(ell) > 0 ? ell : reversed(ell), 'apex', 120)], [], ground, MESH_DIMS);
    if (concave.stats.roofFallbacks !== 1 || concave.stats.tier3 !== 1) throw new Error('apex roofs: a concave footprint did not fall back');
    return hash(r.mesh.vertices, r.mesh.count, r.stats, concave.mesh.vertices, concave.stats);
  },
  'gen-arch ridge roof with a profile (mansard; gable and hip with a profile)': () => {
    const specs = [building(40, 'mansard', 117), { ...building(41, 'gable', 116), roofProfile: OWN_PROFILE }, { ...building(42, 'hip', 117), roofProfile: ROOF_PROFILE.mansard }];
    const r = buildBuildingMesh(specs, [], ground, MESH_DIMS);
    if (r.stats.roofFallbacks !== 0) throw new Error('profiled roofs: a roof fell back');
    // The straight profile is the plain roof, byte for byte.
    const plain = buildBuildingMesh([building(43, 'gable', 116), building(44, 'hip', 115)], [], ground, MESH_DIMS);
    const straight = buildBuildingMesh([{ ...building(43, 'gable', 116), roofProfile: ROOF_PROFILE.straight }, { ...building(44, 'hip', 115), roofProfile: ROOF_PROFILE.straight }], [], ground, MESH_DIMS);
    if (hash(plain.mesh.vertices) !== hash(straight.mesh.vertices)) throw new Error('profiled roofs: the straight profile changed a plain roof');
    return hash(r.mesh.vertices, r.mesh.count, r.stats);
  },
  'gen-arch composition (body, part beside it, part on it; arched windows, arch entrance)': () => {
    const specs = composition(1);
    const r = buildBuildingMesh(specs, [], ground, MESH_DIMS);
    if (r.stats.entrances !== 1 || r.stats.roofFallbacks !== 0) throw new Error('composition: the arch entrance or a roof is missing');
    // Without the group the walls toward a member are shared and blind, so the bytes differ.
    const loose = buildBuildingMesh(composition(0), [], ground, MESH_DIMS);
    if (hash(loose.mesh.vertices) === hash(r.mesh.vertices) || loose.stats.partyWalls <= r.stats.partyWalls) throw new Error('composition: the group changed nothing');
    return hash(r.mesh.vertices, r.mesh.count, r.stats, r.anchored);
  },
  'gen-arch composition far and damaged (massing mesh; description; one part hit through applyEvent, byParts)': () => {
    const specs = composition(1);
    const far = buildMassingMesh(specs, MESH_DIMS);
    const described = buildBuildingMesh(specs, [], ground, MESH_DIMS, { describe: true }).structures;
    // A strong hit on the free-standing part, half way up its shaft.
    const hit = applyEventToAll(described, new Map(), destructionEvent({ position: [33, 112, 15], radius: 2.6, energy: 1800, seed: 0x5eed, tick: 0 }));
    if (!hit.states.get(51)?.parts.size || hit.states.has(50) || hit.states.has(52)) throw new Error('composition: the hit did not stay on the part it struck');
    const damaged = buildBuildingMesh(specs, [], ground, MESH_DIMS, { states: hit.states, byParts: true });
    return hash(far.mesh.vertices, far.mesh.indices, far.spans, described.map(descData), stateHash([...hit.states.values()]), damaged.mesh.vertices, damaged.mesh.count, damaged.stats);
  },
  'gen-core instance cells (cell assignment, thinning tiers, widened boxes)': () => {
    const stride = 6;
    const data = Float32Array.from({ length: 600 * stride }, (_, f) => {
      const k = Math.floor(f / stride);
      return [((k * 37) % 113) * 9.7 - 40, 100 + (k % 7), ((k * 53) % 89) * 12.3, 1 + (k % 5) * 0.4, 5 + (k % 3), k][f % stride]!;
    });
    const cells = splitInstanceCells(data, { stride, bounds: { position: 0, radius: 3, height: 4 }, cellM: 256, seed: 7 });
    for (const c of cells) for (let t = 1; t < c.tiers.length; t++) if (c.tiers[t]!.length > c.tiers[t - 1]!.length) throw new Error('instance cells: a thinner tier holds more');
    return hash(cells.map((c) => [c.i, c.j, c.min, c.max, c.tiers]));
  },
  'render cellDetail (level of detail and tier by distance, view and shadow)': () => {
    const detail = { lodSteps: [320], tierSteps: [1100, 2600], shadowTierSteps: [700, 2600] };
    const rows: number[] = [];
    for (const d of [0, 100, 319.9, 320, 699, 700, 1099, 1100, 2599, 2600, 9000]) {
      for (const purpose of ['view', 'shadow'] as const) {
        for (const [lods, tiers] of [[2, 3], [3, 3], [1, 2]] as const) {
          const r = cellDetail(d, purpose, detail, lods, tiers);
          rows.push(r.lod, r.tier);
        }
      }
    }
    return hash(rows);
  },
  'gen-world vegetation batch': () => {
    const inst = packTreeInstances([{ x: 5, z: 6, y: 100, height: 9, radius: 3, kind: 'park', species: 'round', yaw: 0.3, tint: 0.5, crownBase: 0.3, flex: 0.6, phase: 0.2 }]);
    const a = buildTreeBatch('round', 17, inst, TREE_MATERIAL);
    const b = buildTreeBatch('conifer', 18, inst, { ...TREE_MATERIAL, evergreen: true });
    return hash([...a.lods, ...b.lods].map((l) => [l.vertices, l.indices]), a.instances);
  },
  'gen-world placement (plantTrees)': () => {
    const n = 20 * 16;
    const canopy = { height: Uint8Array.from({ length: n }, (_, i) => ((i * 13) % 7 > 2 ? 40 + ((i * 5) % 60) : 0)), cover: Uint8Array.from({ length: n }, (_, i) => ((i * 13) % 7 > 2 ? 230 : 0)), cols: 20, rows: 16, step: 1.6, heightScale: 0.25 };
    const walls = new OutlineField([[rect(10, 10, 6, 5)]], 32, 24);
    const r = plantTrees({ rules: RULES, canopy, walls, occupancy: new Occupancy(32, 24), noTrunkMask: 1, roadMask: 2, streets: [{ points: [0, 20, 32, 20], width: 6, id: 1 }], heightAt: ground, seed: 99 });
    return hash(r.trees, r.stats);
  },
  'gen-world markings': () => {
    const m = buildGroundMarkings(field, [{ a: [4, 4], b: [20, 6], width: 3, pattern: { kind: 'stripes', periodM: 1, duty: 0.5 }, color: [1, 1, 1], wear: 0.3 }, { a: [8, 14], b: [12, 20], width: 2.5, pattern: { kind: 'outline', lineM: 0.12 }, color: [0.9, 0.9, 0.8] }], 0.8);
    return hash(m?.vertices, m?.count);
  },
  'gen-world ground bake inputs + occlusion': () => {
    const codes = Uint8Array.from({ length: 24 * 16 }, (_, i) => (i % 24 < 8 ? 1 : i % 24 < 12 ? 2 : 3));
    const occlusion = buildOcclusionMask({ codes, codeCols: 24, codeStep: 1, isBuilding: Uint8Array.from({ length: 256 }, (_, c) => (c === 3 ? 1 : 0)), cover: new Uint8Array(12 * 8).fill(90), cols: 12, rows: 8, step: 2, blurM: 4 });
    const mat = (r: number, extra: object = {}): { colors: [[number, number, number], [number, number, number], [number, number, number]]; patchM: number; grain: number } => ({ colors: [[r, 0.4, 0.3], [r, 0.5, 0.3], [r, 0.6, 0.3]], patchM: 6, grain: 0.3, ...extra });
    const desc = groundBake({ codes, cols: 24, rows: 16, step: 1, materials: new Map([[1, mat(0.3, { surface: 'vegetation' })], [2, mat(0.5, { kerb: true, surface: 'road' })]]), fallback: mat(0.7), occlusion, albedoScale: 0.9, loweredKerbs: [{ a: [8, 4], b: [12, 4], width: 2 }], warningStrip: { color: [0.8, 0.7, 0.6], depthM: 0.6 } }, [0.6, 0.6, 0.6]);
    return hash(desc.inputs.map((i) => [i.sampler, i.texture.data, i.texture.width, i.texture.height]), desc.uniforms, desc.targets, desc.fs.length);
  },
  'env frame block (slots: season, sway, snow, window light)': () => {
    const block = assembleFrameBlock([seasonSlot(), swaySlot(), snowSlot(), windowLightSlot()]);
    const out = { afterLight: new Float32Array(block.afterLight * 4), afterView: new Float32Array(block.afterView * 4) };
    const parts: unknown[] = [block.glsl];
    for (const mode of ['studio', 'day'] as const) {
      for (const [day, hour] of [[60, 7], [120, 13], [290, 19.5], [350, 23]] as const) {
        const env = new Environment({ mode, site: { latitudeDeg: 50.66, longitudeDeg: 14.03, dayOfYear: day }, hour, wind: { speedMs: 4, fromDeg: 250 }, weather: { cloudCover: 0.4, snowCover: 0.5, precipitation: 0.3, precipitationKind: 'snow', wetness: 0.2, fog: 0.4 }, fogLayer: { bottomY: 140, topY: 260 }, animate: false });
        env.time.set(12.5);
        const r = block.pack(env.frame({ heading: 0.7 }), out);
        parts.push(out.afterLight.slice(), out.afterView.slice(), r.shadowKey);
      }
    }
    return hash(parts);
  },
  'env sky slot (packing over hours and weather, perspective and none)': () => {
    const sky = skySlot({ hazeDistanceM: 1200 });
    const block = assembleFrameBlock([sky]);
    const out = { afterLight: new Float32Array(block.afterLight * 4), afterView: new Float32Array(block.afterView * 4) };
    const parts: unknown[] = [block.glsl, SKY_GLSL];
    for (const eye of [null, [80, 45, 210]] as const) {
      sky.params.eye = eye ? [...eye] : null;
      for (const [hour, weather] of [[6, { cloudCover: 0 }], [13, { cloudCover: 0.45 }], [18.5, { cloudCover: 0.8, precipitation: 0.7, fog: 0.25 }], [23, { cloudCover: 0.3, fog: 0.7 }]] as const) {
        const env = new Environment({ mode: 'day', site: { latitudeDeg: 51, longitudeDeg: 0, dayOfYear: 250, utcOffsetHours: 0 }, hour, weather, animate: false });
        env.time.set(40);
        block.pack(env.frame({ heading: 0.3 }), out);
        parts.push(out.afterLight.slice(), out.afterView.slice());
      }
    }
    return hash(parts);
  },
  'sim fixed step (commands, A*, follow, stops; frame patterns agree)': () => {
    const runs = Object.entries(FRAME_PATTERNS).map(([name, pattern]) => ({ name, ...runSimScenario(pattern) }));
    for (const r of runs) if (r.hash !== runs[0]!.hash) throw new Error(`sim: frame pattern ${r.name} gives ${r.hash}, ${runs[0]!.name} gives ${runs[0]!.hash}`);
    return hash(runs[0]!.hash, runs[0]!.events);
  },
  'sim poses (extractPose between ticks; same rows after a seek)': () => hash(runPoseScenario()),
  'sim lanes (zones, obstacle, replayed vehicle: 3 h without a deadlock or an overlap; seek)': () => hash(runLanesScenario()),
  'sim agents (crowd avoidance, standing group: no gridlock, nobody inside another; seek)': () => hash(runAgentsScenario()),
  'sim agendas (activities, an app state, shared areas: all arrive, never together on an area; seek)': () => hash(runAgendaScenario()),
  'destruction descriptor (flat with façade recipe, gable, hip)': () => hash(describeAll().map(descData)),
  'destruction event script (state hash, encoding, rubble footprints)': () => {
    const r = runDestruction();
    const states = [...r.states.values()];
    return hash(stateHash(states), encodeStates(states), r.changes, rubbleData(r.rubble));
  },
  'destruction damaged mesh (structures and rubble from the scripted state)': () => {
    const r = runDestruction();
    const m = damagedMeshes(r.states, r.rubble);
    return hash(m.structures.vertices, m.structures.count, m.stats, m.rubble.vertices, m.rubble.count);
  },
  'destruction timeline (deterministic, in bounds; final state = instantaneous result)': () => hash(timelineScript()),
  'falling pieces (tracks and poses at fixed clock times, rubble arrivals)': () => hash(fallTracks()),
  'interior plan (L shape, courtyard, shed; intact = scripted = reversed script)': () => hash(interiorPlans()),
  'interior mesh (interior vertices after one deep hit, fixed state)': () => {
    const m = interiorMesh();
    if (m.count === 0) throw new Error('interior mesh: no interior vertices');
    return hash(m.bytes, m.count);
  },
  'base reproducible trigonometry (fixed table of sine, cosine and arc functions, in turns and radians)': () => hash(trigTable()),
  'core bodies on rails (stepped tick by tick = jumped to the tick; solver residual, day and seasons)': () => hash(orbitScript()),
  'base nested frames (object 100,000 km from the top origin: eye-relative floats within 1 mm; reparenting keeps the pose)': () => hash(farSurface()),
  'base depth modes and render origin (reversed and logarithmic matrices tell 1 m and 1,000 km apart; origin on all axes)': () => hash(depthModes()),
  'gen-tex value words and ramps (quantised values with gaps, table layout, smooth and banded ramp)': () => {
    const values = Float32Array.from({ length: 2100 }, (_, i) => (i % 17 === 0 ? NaN : -4 + ((i * 53) % 211) * 0.07));
    const words = quantizeValues(values, -2, 9);
    const size = valueTableSize(words.length);
    const back = [1, 2, 300, 2099].map((i) => Math.round(wordValue(words[i]!, -2, 9) * 1e6));
    return hash(words, size, wordTexture(words, size.width, size.height).data, back, colorRamp(VALUE_RAMPS.heat).data, colorRamp(VALUE_RAMPS.diverging, 7).data);
  },
  'gen-mesh drapeTiles (full density and thinned sheet over a part of a height field)': () => {
    const full = drapeTiles(field, { tileQuads: 5, origin: [10, -20] });
    const part = drapeTiles(field, { rect: { x0: 5, z0: 3, x1: 26, z1: 19 }, every: 2, liftM: 0.4 });
    return hash(drapeEvery(field, 20), full.map((t) => [t.mesh.vertices, t.mesh.indices, t.mesh.count, t.min, t.max]), part.map((t) => [t.mesh.vertices, t.mesh.indices, t.min, t.max]));
  },
  'gen-mesh prismMesh (convex, concave and reversed outlines with table rows, grown walls)': () => {
    const ell = Float32Array.of(0, 0, 12, 0, 12, 5, 5, 5, 5, 11, 0, 11);
    const shapes = [
      { ring: rect(2, 2, 8, 6), minY: 100, maxY: 109, ref: 0 },
      { ring: ell, minY: 99.5, maxY: 104, ref: 3 },
      { ring: Float32Array.from(ell).reverse().map((_, i, a) => a[i ^ 1]!), minY: 101, maxY: 103, ref: 70000 },
    ];
    const plain = prismMesh(shapes);
    const grown = prismMesh(shapes, { growM: 0.3 });
    return hash(triangulateRing(ell), plain.mesh.vertices, plain.mesh.indices, plain.mesh.count, plain.min, plain.max, grown.mesh.vertices, grown.min, grown.max);
  },
  'sim route search on two levels (regions and gates: routes valid and as cheap as plain A*; tables built ahead = on demand)': () => hash(regionRoutes()),
  'sim coarse flow, small run (conservation; set-up at once = in pieces = by the first step; snapshot round trip)': () => hash(flowVariants()),
  'sim coarse flow, whole network (40,000 trips over 3,000 s with a moving focus; conservation; faster than real time)': () => hash(flowProbeLine(flowReference().result)),
  'gen-arch massing mesh (prisms of flat, pitched and holed footprints; a subset relative to an origin; one alone = its span)': () => {
    const yard: BuildingSpec = { ...building(9, 'flat', 112), rings: [rect(40, 30, 20, 16), rect(46, 35, 6, 5)] };
    const specs = [building(7, 'flat', 112), building(8, 'gable', 116, RECIPE), yard];
    const all = buildMassingMesh(specs, MESH_DIMS);
    const part = buildMassingMesh(specs, MESH_DIMS, { only: new Set([1]), origin: [16, 100, 8] });
    const stride = MASSING_LAYOUT.stride;
    const bytes = (v: ArrayBufferView): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (all.structures !== 3 || all.spans[3]! * stride !== all.mesh.vertices.byteLength) throw new Error('massing: spans do not cover the mesh');
    // Hiding and showing one structure in a merged mesh relies on this: built alone it has the bytes of its span.
    const alone = bytes(buildMassingMesh([yard], MESH_DIMS).mesh.vertices);
    const span = bytes(all.mesh.vertices).subarray(all.spans[2]! * stride, all.spans[3]! * stride);
    if (alone.length !== span.length || alone.some((b, i) => b !== span[i])) throw new Error('massing: a structure built alone differs from its span');
    return hash(all.mesh.vertices, all.mesh.indices, all.mesh.count, all.spans, all.minY, all.maxY, part.mesh.vertices, part.mesh.indices, part.spans, part.structures, roofTones([0.5, 0.3, 0.24], 0.84));
  },
  'gen-tex CodeStamp (outlines with a hole, discs, footprints; four parts = at once; small shapes keep their area)': () => {
    const cols = 40;
    const rows = 32;
    const step = 5;
    const yard: BuildingSpec = { ...building(9, 'flat', 112), rings: [rect(60, 40, 50, 45), rect(75, 55, 12, 10)] };
    const run = (region: CodeRegion): { codes: Uint8Array; small: number } => {
      const codes = new Uint8Array(region.cols * region.rows).fill(1);
      const stamp = new CodeStamp(region, codes, 77);
      stamp.polygon([rect(12, 9, 14, 9)], 7, 1);
      stamp.polygon([rect(131, 22, 4, 3)], 8, 2);
      stampFootprints(stamp, [building(1, 'flat', 112), yard], (b) => 20 + b.id);
      stamp.disc(150, 120, 14, 9, 3);
      const before = stamp.stamped;
      // 300 discs of 7 m² on 25 m² cells: none covers a cell, together they should take about 85 cells.
      for (let k = 0; k < 300; k++) stamp.disc(3 + ((k * 37) % 193), 3 + ((k * 91) % 151), 1.5, 10, 100 + k);
      return { codes, small: stamp.stamped - before };
    };
    const whole = run({ col0: 0, row0: 0, cols, rows, step });
    if (Math.abs(whole.small - (300 * Math.PI * 1.5 * 1.5) / (step * step)) > 20) throw new Error(`code stamp: 300 small discs took ${whole.small} cells`);
    for (const [col0, row0] of [[0, 0], [20, 0], [0, 16], [20, 16]] as const) {
      const part = run({ col0, row0, cols: 20, rows: 16, step }).codes;
      for (let r = 0; r < 16; r++) for (let c = 0; c < 20; c++) if (part[r * 20 + c] !== whole.codes[(row0 + r) * cols + col0 + c]) throw new Error('code stamp: a part differs from the whole raster');
    }
    return hash(whole.codes, whole.small);
  },
  'core LevelFade (scripted value path: dead band, timed transition, limit; neighbouring levels cover every fragment once)': () => {
    const fade = new LevelFade({ below: [0.55, 0.14], hysteresis: 0.15, seconds: 0.4 });
    fade.limit = 1;
    // The test of the shader function `fadeHidden` for a fragment with pattern value t.
    const hidden = (f: [number, number], t: number): boolean => (f[1] > 0.5 ? 1 - t : t) < f[0];
    const path = [0.77, 0.77, 0.6, 0.5, 0.45, 0.45, 0.45, 0.45, 0.45, 0.6, 0.64, 0.64, 0.64, 0.64, 0.64, 0.19, 0.19, 0.19, 0.19, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.15, 0.17, 0.17, 0.17, 0.17, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
    const out: number[] = [];
    path.forEach((value, k) => {
      // The coarsest level becomes available part of the way through.
      if (k === 22) fade.limit = 2;
      const more = fade.update(value, 0.05);
      if (more !== fade.moving) throw new Error('level fade: update and moving disagree');
      out.push(fade.level, Math.round(fade.position * 1e6), more ? 1 : 0);
      for (let level = 0; level < 3; level++) out.push(fade.shown(level) ? 1 : 0, ...fade.fade(level).map((v) => Math.round(v * 1e6)));
      for (let s = 0; s < 20; s++) {
        // Pattern values off the positions the path passes through (a fragment exactly on the boundary belongs to both).
        const t = (s + 0.37) / 20;
        let drawn = 0;
        for (let level = 0; level < 3; level++) if (fade.shown(level) && !hidden(fade.fade(level), t)) drawn++;
        if (drawn !== 1) throw new Error(`level fade: a fragment is drawn by ${drawn} levels at position ${fade.position}`);
      }
    });
    if (fade.position !== 0) throw new Error('level fade: the path should end on the finest level');
    return hash(out, fadeFragment('precision highp float;\nout vec4 o;\nvoid main() {\n  o = vec4(1.0);\n}'));
  },
  'render shadow areas (a scripted focus path: every block where the lookup reads it, only uncovered blocks drawn; block size ladder; light frames)': () => hash(areaScript()),
  'render shadow frames (a renderer with a stand-in device, snapped and cascades: every lookup of a frame lands on the texel and depth the point was drawn to; pans, zooms, a moved origin, light above and drifting)': () => hash(areaFrames()),
  'gen-tex light horizon (surface with a block, a ring and a disc lit from four directions; packed heights)': () => hash(horizonScript()),
  'gen-mesh bisectSurface (three tolerances, skirts, a cut side, a clipped square: indices in range, fewer triangles with more tolerance)': () => hash(bisectScript()),
  'gen-mesh packMesh (loose triangles indexed per span, a span alone equals its bytes in the whole, positions within half a step; packed layout and material)': () => hash(packScript()),
  'streaming GPU ceiling (a long pan with a ceiling and a reserve: GPU bytes stay under it, the cover has no hole)': () => hash(ceilingScript()),
  'env atmosphere slot (tables of two shells of air; packing with and without an eye; the sun by the observer\'s place on a turning sphere)': () => {
    const parts: unknown[] = [];
    const small = atmosphereFor(100_000, 30_000);
    for (const medium of [DEFAULT_ATMOSPHERE_MEDIUM, small]) {
      const t = atmosphereTables(medium);
      parts.push(t.texture.data, t.texture.width, t.texture.height, t.multiScatterScale, t.skyLightScale);
    }
    const air = atmosphereSlot(small);
    const block = assembleFrameBlock([air]);
    const out = { afterLight: new Float32Array(block.afterLight * 4), afterView: new Float32Array(block.afterView * 4) };
    parts.push(block.glsl, air.glsl);
    const DAY = 172;
    const RAD = Math.PI / 180;
    for (const eye of [null, [10, 2500, -40]] as const) {
      air.params.eye = eye ? [...eye] : null;
      air.params.eyeHeightM = eye ? 2500 : 0;
      for (const [lat, lon, hour] of [[35, 20, 13], [35, 20, 23], [-60, 170, 6], [0, -15, 12], [80, -120, 18.5]] as const) {
        const env = new Environment({ mode: 'day', site: { latitudeDeg: lat, longitudeDeg: lon, dayOfYear: DAY, utcOffsetHours: 0 }, hour, weather: {}, animate: false });
        const up: [number, number, number] = [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.sin(lat * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD)];
        const sunDir = sphereSunDirection(DAY, hour);
        // The sun stands as high over the place as the site's own sun position says.
        const height = Math.asin(sunDir[0] * up[0] + sunDir[1] * up[1] + sunDir[2] * up[2]) / RAD;
        const site = sunPosition({ latitudeDeg: lat, longitudeDeg: lon, dayOfYear: DAY, utcOffsetHours: 0 }, hour).elevationDeg;
        if (Math.abs(height - site) > 0.05) throw new Error(`atmosphere: the sun over ${lat}, ${lon} at ${hour} h stands at ${height}°, the site says ${site}°`);
        env.observer = { up, sunDir };
        block.pack(env.frame({ heading: 0.3 }), out);
        parts.push(out.afterLight.slice(), out.afterView.slice());
      }
    }
    return hash(parts);
  },
  'gen-core sphere patch cover (cover attributes beside the unchanged bytes of the plain patch; neighbours agree on the cover along a shared border)': () => {
    const at = (x: number, y: number): Parameters<typeof spherePatchMesh>[0] => ({
      radiusM: 100_000,
      face: 2,
      level: 6,
      x,
      y,
      quads: 16,
      heightAt: (px, py, pz) => 400 * valueNoise3(px, py, pz, 5000, 7),
      colorAt: (px, py, pz, h) => [90, Math.round(100 + h * 0.2), 60, 0],
      skirtDepth: 20,
    });
    const coverAt = (px: number, py: number, pz: number, h: number): [number, number, number, number] => [40, 90, 30, h > 320 ? 0 : Math.round(255 * valueNoise3(px, py, pz, 3000, 11))];
    const plain = spherePatchMesh(at(13, 40));
    if (plain.mesh.layout !== SPHERE_PATCH_LAYOUT) throw new Error('sphere patch cover: a patch without coverAt must keep the plain layout');
    const covered = spherePatchMesh({ ...at(13, 40), coverAt });
    if (covered.mesh.layout !== SPHERE_PATCH_COVER_LAYOUT) throw new Error('sphere patch cover: a patch with coverAt must use the cover layout');
    const a = plain.mesh.vertices as Uint8Array;
    const b = covered.mesh.vertices as Uint8Array;
    const n = a.length / SPHERE_PATCH_LAYOUT.stride;
    if (b.length !== n * SPHERE_PATCH_COVER_LAYOUT.stride) throw new Error('sphere patch cover: vertex counts differ');
    for (let v = 0; v < n; v++) {
      for (let k = 0; k < SPHERE_PATCH_LAYOUT.stride; k++) {
        if (a[v * SPHERE_PATCH_LAYOUT.stride + k] !== b[v * SPHERE_PATCH_COVER_LAYOUT.stride + k]) throw new Error(`sphere patch cover: vertex ${v} differs from the plain patch at byte ${k}`);
      }
    }
    // The cover on the border shared with the next cell: both cells hold the same set of values there.
    const next = spherePatchMesh({ ...at(14, 40), coverAt });
    const c = next.mesh.vertices as Uint8Array;
    const S = SPHERE_PATCH_COVER_LAYOUT.stride;
    const key = (bytes: Uint8Array, v: number, o: readonly number[]): string => {
      const f = new Float32Array(bytes.buffer.slice(bytes.byteOffset + v * S, bytes.byteOffset + v * S + 12));
      return `${Math.round(f[0]! + o[0]!)},${Math.round(f[1]! + o[1]!)},${Math.round(f[2]! + o[2]!)}`;
    };
    const own = new Map<string, string>();
    for (let v = 0; v < n; v++) own.set(key(b, v, covered.origin), Array.from(b.subarray(v * S + 40, v * S + 48)).join(','));
    let shared = 0;
    for (let v = 0; v < c.length / S; v++) {
      const mine = own.get(key(c, v, next.origin));
      if (mine === undefined) continue;
      shared++;
      const theirs = Array.from(c.subarray(v * S + 40, v * S + 48)).join(',');
      if (mine !== theirs) throw new Error(`sphere patch cover: neighbours disagree on a shared vertex (${mine} against ${theirs})`);
    }
    if (shared < 17) throw new Error(`sphere patch cover: only ${shared} shared vertices found`);
    return hash(b, covered.mesh.indices, SPHERE_PATCH_COVER_LAYOUT, shared);
  },
  'gen-core strip net and carve (lengths, carve tables on a plane and a sphere; centre = grade + up(0) − bed, past the shoulder the input bit for bit, 5 cm steps under 2 cm across, through a bend and round a node; stripTouches false = identity)': () => hash(stripNetScript()),
  'gen-mesh strip mesh on a plane (three lines, one on a cell border, levels 9 and 10: lengths add up, shared sections agree, blend 1 = the parent rule, never under the ground, node corners shared and no overlap, order-free; GLSL and stripGrow)': () => hash(stripPlaneScript()),
  'gen-mesh strip mesh on a sphere (a net over an edge of the cube, levels 3–4 and 9–10: the same checks)': () => hash(stripSphereScript()),
  'destruction cell states (changed structures by home cell: order-free text and hash, round trip, cells under a coarse cell, malformed pieces skipped, a ceiling of 40 units ruins the largest first, a store full of ruins refuses)': () => hash(cellStatesScript()),
  'streaming refresh (cells of one coarse cell refreshed while RESIDENT, MESHED and in flight, and once settled: drawn throughout and swapped, late results stale, no hole; an empty refresh changes no decision)': () => hash(refreshScript()),
  'gen-plan grid (levels 3 and 5: symmetric neighbours, 7 at the 24 corner nodes, node at its direction, areas sum to the sphere; gridSample exact at the middles, in range, continuous over all edges and corners)': () => hash(planGridScript()),
  'gen-plan drainage (filled over heights, to never climbs, every node reaches a base node, order, flow at the base = supply, pools meet both limits with the sill outside, no base node = lowest node; channels follow to and agree with into; fallingGrade, smoothLine)': () => hash(drainageScript()),
  'gen-plan line tiles (lines over an edge and beside a corner, tiles of level 4: every point within reach finds its line; tileLinesOfCell = brute force at levels 0, 2, 4, 6)': () => hash(lineTilesScript()),
  'gen-plan grid weights (reproduce gridSample bit for bit inside a face, across an edge, at a corner)': () => hash(gridWeightsScript()),
  'gen-plan routes (steps are neighbour steps, cost = brute force, over an edge and a corner, ties stable, null when capped or closed; regions and links; limitGrade, lineAt)': () => hash(routesScript()),
  'gen-plan sites (pickSites best first with spacing, taken and accept; gridSteps = brute force round a corner; gridSlopeAt on an even rise)': () => hash(sitesScript()),
  'gen-plan plots (straight, bent, three lines at a node, a blocked disc: gap, setback, no line too near, none blocked; same seed same, other seed differs)': () => hash(plotsScript()),
  'gen-plan horizon (flat = 0 and lit; one block raises only the axes toward it within reach; raising never lowers; table size and order change nothing; smooth light over an edge, a corner and the axes)': () => hash(planHorizonScript()),
  'gen-core sphere patch extra channel (without the extra bytes = the mesh without extraAt, plain and cover; neighbours agree on shared border vertices, also over an edge of the cube; a child\'s coarse extra = the parent\'s extra; skirt = border)': () => hash(extraChannelScript()),
  'gen-core ring round a line (straight, bent, mitre limit; null cases)': () => hash(lineRingScript()),
  'gen-arch finishes (wall finish, roof cover, shutters, band underside: mesh bytes)': () => hash(finishesScript()),
  'gen-arch raised member (entrances and bands under it are kept; without the flag they differ)': () => hash(raisedMemberScript()),
  'gen-mesh rig options (free gait and bend chains: rigExtended, explicit pair gait = default, bend kinds, amounts, lags and a shared root; near, far and shadow meshes)': () => hash(rigOptionsScript()),
  'gen-core near scatter (three kinds: same bytes twice, sorted by order, inside the square, half density a subset, masks join; nearKeep and nearCount)': () => hash(nearScatterScript()),
  'core cover fade (share of the far look and size of an object over levels and the blend; objects leave in step with the share; GLSL)': () => {
    const out: number[] = [];
    for (const level of [8, 9, 10, 11]) for (let m = 0; m <= 10; m++) out.push(Math.round(coverFade(10, level, m / 10) * 1e6));
    for (let k = 0; k <= 20; k++) {
      const fade = k / 20;
      let kept = 0;
      for (let i = 0; i < 1000; i++) {
        const size = coverKeep(fade, (i + 0.5) / 1000);
        kept += size;
        if (k % 5 === 0 && i % 100 === 0) out.push(Math.round(size * 1e6));
      }
      // About 1 − fade of the objects remain (each shrinks over a tenth of the band).
      if (Math.abs(kept / 1000 - (1 - fade)) > 0.07) throw new Error(`cover fade: at ${fade} the objects that remain are ${kept / 1000}`);
      out.push(Math.round(kept));
    }
    if (coverKeep(0, 0) !== 1 || coverKeep(1, 1) !== 0) throw new Error('cover fade: every object is whole at 0 and none is left at 1');
    return hash(out, COVER_FADE_GLSL);
  },
};

// --- Scripts of the recipes above that do not fit on one line --------------------------------------------------------

/**
 * The extra channel of a sphere patch: cells inside a face and on an edge of the cube at levels 6 and 7, plain and with
 * a cover. Cut out of the vertices, the extra bytes leave the mesh made without `extraAt`; shared border vertices of
 * neighbours carry the same extra; a child's coarse extra on the parent's vertices is the parent's extra; a skirt
 * vertex carries the extra of the border vertex above it.
 */
function extraChannelScript(): unknown[] {
  const R = 100_000;
  const heightAt = (px: number, py: number, pz: number): number => 400 * valueNoise3(px, py, pz, 5000, 7);
  const colorAt = (_x: number, _y: number, _z: number, h: number): [number, number, number, number] => [90, Math.round(100 + h * 0.2), 60, 0];
  const coverAt = (px: number, py: number, pz: number, h: number): [number, number, number, number] => [40, 90, 30, h > 320 ? 0 : Math.round(255 * valueNoise3(px, py, pz, 3000, 11))];
  const extraAt = (px: number, py: number, pz: number, h: number): [number, number, number, number] => [
    Math.round(255 * valueNoise3(px, py, pz, 2000, 21)), Math.round(255 * valueNoise3(px, py, pz, 7000, 22)), Math.max(0, Math.min(255, Math.round(h / 2))), (Math.floor(px / 900) & 1) * 255,
  ];
  type Opts = Parameters<typeof spherePatchMesh>[0];
  const at = (face: number, level: number, x: number, y: number): Opts => ({ radiusM: R, face, level, x, y, quads: 16, heightAt, colorAt, skirtDepth: 20 });
  const out: unknown[] = [];
  /** Per vertex: key of its direction (skirts share their border's) and of its position, and its extra bytes. */
  const vertices = (p: ReturnType<typeof spherePatchMesh>, stride: number, extraOffset: number): { dir: string; pos: string; extra: string; coarse: string }[] => {
    const bytes = p.mesh.vertices as Uint8Array;
    const list: { dir: string; pos: string; extra: string; coarse: string }[] = [];
    for (let v = 0; v < bytes.length / stride; v++) {
      const f = new Float32Array(bytes.buffer.slice(bytes.byteOffset + v * stride, bytes.byteOffset + v * stride + 12));
      const x = f[0]! + p.origin[0];
      const y = f[1]! + p.origin[1];
      const z = f[2]! + p.origin[2];
      const l = Math.hypot(x, y, z);
      list.push({
        dir: `${Math.round((x / l) * 1e7)},${Math.round((y / l) * 1e7)},${Math.round((z / l) * 1e7)}`,
        pos: `${Math.round(x * 10)},${Math.round(y * 10)},${Math.round(z * 10)}`,
        extra: Array.from(bytes.subarray(v * stride + extraOffset, v * stride + extraOffset + 4)).join(','),
        coarse: Array.from(bytes.subarray(v * stride + extraOffset + 4, v * stride + extraOffset + 8)).join(','),
      });
    }
    return list;
  };
  const cells: [number, number, number, number][] = [[2, 6, 13, 40], [0, 6, 63, 20], [2, 7, 26, 80]];
  for (const withCover of [false, true]) {
    const base = withCover ? SPHERE_PATCH_COVER_LAYOUT : SPHERE_PATCH_LAYOUT;
    const layout = withCover ? SPHERE_PATCH_COVER_EXTRA_LAYOUT : SPHERE_PATCH_EXTRA_LAYOUT;
    const S = layout.stride;
    const B = base.stride;
    const made = new Map<string, ReturnType<typeof vertices>>();
    for (const [face, level, x, y] of cells) {
      const o = { ...at(face, level, x, y), ...(withCover ? { coverAt } : {}) };
      const without = spherePatchMesh(o);
      const withExtra = spherePatchMesh({ ...o, extraAt });
      if (withExtra.mesh.layout !== layout) throw new Error('extra channel: wrong layout');
      const a = without.mesh.vertices as Uint8Array;
      const b = withExtra.mesh.vertices as Uint8Array;
      const n = a.length / B;
      if (b.length !== n * S) throw new Error('extra channel: vertex counts differ');
      for (let v = 0; v < n; v++) for (let k = 0; k < B; k++) if (a[v * B + k] !== b[v * S + k]) throw new Error(`extra channel: vertex ${v} differs at byte ${k} from the mesh without extraAt`);
      if (hash(without.mesh.indices) !== hash(withExtra.mesh.indices)) throw new Error('extra channel: indices differ');
      const list = vertices(withExtra, S, B);
      // Skirt = border: every vertex on one direction has one extra.
      const byDir = new Map<string, string>();
      for (const q of list) {
        const seen = byDir.get(q.dir);
        if (seen !== undefined && seen !== q.extra) throw new Error('extra channel: a skirt vertex differs from its border vertex');
        byDir.set(q.dir, q.extra);
      }
      made.set(`${face}/${level}/${x}/${y}`, list);
      out.push(b, withExtra.mesh.indices);
    }
    // Neighbours: inside the face (x + 1) and over the edge of the cube (the cell across from face 0, x = 63).
    const pairs: [string, [number, number, number, number]][] = [['2/6/13/40', [2, 6, 14, 40]], ['0/6/63/20', [0, 6, 63, 21]]];
    for (const [mine, [face, level, x, y]] of pairs) {
      const other = vertices(spherePatchMesh({ ...at(face, level, x, y), ...(withCover ? { coverAt } : {}), extraAt }), S, B);
      const own = new Map(made.get(mine)!.map((q) => [q.pos, q.extra]));
      let shared = 0;
      for (const q of other) {
        const e = own.get(q.pos);
        if (e === undefined) continue;
        shared++;
        if (e !== q.extra) throw new Error(`extra channel: neighbours disagree on a shared vertex (${e} against ${q.extra})`);
      }
      if (shared < 17) throw new Error(`extra channel: only ${shared} shared vertices with ${face}/${level}/${x}/${y}`);
      out.push(shared);
    }
    // Over the edge of the cube: the neighbour of face 0, x = 63 across its +x side.
    const across = cubeNeighbour(0, 6, 63, 20, 1, 0);
    if (!across) throw new Error('extra channel: no cell across the edge');
    const over = vertices(spherePatchMesh({ ...at(across.face, 6, across.x, across.y), ...(withCover ? { coverAt } : {}), extraAt }), S, B);
    const edgeOwn = new Map(made.get('0/6/63/20')!.map((q) => [q.pos, q.extra]));
    let overShared = 0;
    for (const q of over) {
      const e = edgeOwn.get(q.pos);
      if (e === undefined) continue;
      overShared++;
      if (e !== q.extra) throw new Error('extra channel: cells over the edge of the cube disagree');
    }
    if (overShared < 17) throw new Error(`extra channel: only ${overShared} shared vertices over the edge of the cube`);
    // Child 2/7/26/80 lies in parent 2/6/13/40: its coarse extra on the parent's vertices is the parent's extra.
    const parent = new Map(made.get('2/6/13/40')!.map((q) => [q.pos, q.extra]));
    let onParent = 0;
    for (const q of made.get('2/7/26/80')!) {
      const e = parent.get(q.pos);
      if (e === undefined) continue;
      onParent++;
      if (e !== q.coarse) throw new Error(`extra channel: a child's coarse extra ${q.coarse} is not the parent's ${e}`);
    }
    if (onParent < 40) throw new Error(`extra channel: only ${onParent} child vertices on the parent's`);
    out.push(overShared, onParent);
  }
  return out;
}

/** `lineRing`: a straight line, a bent one, a bend at the mitre limit, and the cases that give null. */
function lineRingScript(): unknown[] {
  const out: unknown[] = [];
  const straight = lineRing([0, 0, 10, 0], 1.5);
  if (!straight || straight.length !== 8 || ringSignedArea(straight) <= 0 || Math.abs(ringSignedArea(straight) - 30) > 1e-4) throw new Error('lineRing: the straight ring is not 10 × 3');
  out.push(straight);
  const bent = [0, 0, 12, 0, 20, 7, 21, 18];
  const hw = 1.2;
  const r = lineRing(bent, hw);
  if (!r || r.length !== 16 || ringSignedArea(r) <= 0) throw new Error('lineRing: the bent ring is missing or wound inward');
  // Every ring point lies at least the half-width from the line, and the mitred joins at most 3 × away.
  for (let k = 0; k < r.length; k += 2) {
    let near = Infinity;
    for (let i = 0; i + 3 < bent.length; i += 2) near = Math.min(near, distToSegment(r[k]!, r[k + 1]!, bent[i]!, bent[i + 1]!, bent[i + 2]!, bent[i + 3]!));
    if (near < hw - 1e-4 || near > 3 * hw + 1e-4) throw new Error(`lineRing: a ring point lies ${near} m from the line`);
  }
  out.push(r);
  // A bend just inside the mitre limit, and one past it.
  const bendAt = (deg: number): number[] => {
    const a = (deg * Math.PI) / 180;
    return [0, 0, 10, 0, 10 + 10 * Math.cos(Math.PI - a), 10 * Math.sin(Math.PI - a)];
  };
  // The mitre is hw / sin(a / 2) for an inner angle a: 3 × hw at a ≈ 38.9°.
  const inside = lineRing(bendAt(42), 1);
  const past = lineRing(bendAt(30), 1);
  if (!inside) throw new Error('lineRing: a bend inside the mitre limit gave null');
  if (past !== null) throw new Error('lineRing: a bend past the mitre limit gave a ring');
  out.push(inside);
  if (lineRing([0, 0], 1) !== null || lineRing([0, 0, 0.5, 0, 9, 0], 1) !== null || lineRing([0, 0, 5, 0], 0) !== null || lineRing([0, 0, 5, 0, 0, 0], 1) !== null) throw new Error('lineRing: a null case gave a ring');
  return out;
}

/** True when the vertices of `a` appear in `b` in order (`b` may hold more), compared as whole vertices of `stride` bytes. */
function subsequence(a: Uint8Array, b: Uint8Array, stride: number): boolean {
  const key = (x: Uint8Array, v: number): string => Array.from(x.subarray(v * stride, (v + 1) * stride)).join(',');
  let j = 0;
  const nb = b.length / stride;
  for (let v = 0; v < a.length / stride; v++) {
    const k = key(a, v);
    while (j < nb && key(b, j) !== k) j++;
    if (j === nb) return false;
    j++;
  }
  return true;
}

/**
 * Finishes: wall finish, roof cover and shutters change only byte 50 of the vertices (the material code); 0 or false
 * gives the bytes of leaving them out; the band underside adds two triangles per band and changes nothing else.
 */
function finishesScript(): unknown[] {
  const bytes = (specs: BuildingSpec[]): Uint8Array => {
    const r = buildBuildingMesh(specs, [], ground, MESH_DIMS);
    const v = r.mesh.vertices;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  };
  const recipe: FacadeRecipe = { ...RECIPE, balconies: null };
  const plain = [building(60, 'gable', 116, recipe), building(61, 'hip', 115, recipe)];
  const base = bytes(plain);
  const zeroed = bytes(plain.map((b) => ({ ...b, wallFinish: 0, roofCover: 0, facade: { ...b.facade!, window: { ...b.facade!.window, shutters: false }, cornice: { ...b.facade!.cornice!, underside: false } } })));
  if (hash(zeroed) !== hash(base)) throw new Error('finishes: fields set to 0 or false changed the bytes');
  const out: unknown[] = [base];
  const S = BUILDING_LAYOUT.stride;
  const variants: BuildingSpec[][] = [
    plain.map((b) => ({ ...b, wallFinish: WALL_FINISH.frame })),
    plain.map((b) => ({ ...b, roofCover: ROOF_COVER.slate })),
    plain.map((b) => ({ ...b, facade: { ...b.facade!, window: { ...b.facade!.window, shutters: true } } })),
    plain.map((b, i) => ({ ...b, wallFinish: i ? WALL_FINISH.boards : WALL_FINISH.stone, roofCover: i ? ROOF_COVER.thatch : ROOF_COVER.shingle, facade: { ...b.facade!, window: { ...b.facade!.window, shutters: true } } })),
  ];
  for (const specs of variants) {
    const v = bytes(specs);
    if (v.length !== base.length) throw new Error('finishes: a finish changed the vertex count');
    let changed = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] === base[i]) continue;
      if (i % S !== 50) throw new Error(`finishes: byte ${i % S} of a vertex changed`);
      changed++;
    }
    if (changed === 0) throw new Error('finishes: a finish changed nothing');
    out.push(v);
  }
  // The band underside: two triangles (six vertices) more per band, every other vertex unchanged and in order.
  const under = bytes(plain.map((b) => ({ ...b, facade: { ...b.facade!, cornice: { ...b.facade!.cornice!, underside: true } } })));
  const extra = (under.length - base.length) / S;
  if (!(extra > 0) || extra % 6 !== 0) throw new Error(`finishes: the underside added ${extra} vertices`);
  if (!subsequence(base, under, S)) throw new Error('finishes: the underside changed other vertices');
  out.push(under, extra);
  return out;
}

/**
 * A raised member of a group: an upper part overhanging the wall that holds the body's entrance and its band. With
 * the flag the entrance stays and the band runs on; without it the footprint tests see the part and the bytes differ.
 */
function raisedMemberScript(): unknown[] {
  const specs = (raised: boolean): BuildingSpec[] => {
    const [body] = composition(1);
    const upper = composition(1)[2]!;
    const ring = rect(17, 8, 6, 5);
    return [
      body!,
      { ...upper, id: 53, rings: [ring], box: orientedBox(ring), groundMin: 106, groundRef: 106, eaveY: 112, ridgeY: 114, roof: 'gable', ...(raised ? { raised: true } : {}) },
    ];
  };
  const up = buildBuildingMesh(specs(true), [], ground, MESH_DIMS);
  const flat = buildBuildingMesh(specs(false), [], ground, MESH_DIMS);
  if (up.stats.entrances !== 1) throw new Error(`raised member: ${up.stats.entrances} entrances with the flag`);
  if (hash(up.mesh.vertices) === hash(flat.mesh.vertices)) throw new Error('raised member: the flag changed nothing');
  // The body alone has the same entrance as with a raised part over it.
  const alone = buildBuildingMesh([specs(true)[0]!], [], ground, MESH_DIMS);
  if (alone.stats.entrances !== up.stats.entrances) throw new Error('raised member: the body alone has another entrance count');
  return [up.mesh.vertices, up.mesh.count, up.stats, flat.stats];
}

/** A neutral rig: a body on four limbs, a chain of three links behind and one swinging part. */
function chainRig(gait?: 'pair' | 'free'): RigDesc {
  const leg = (x: number, z: number, phase: number): RigPart => ({ shape: { kind: 'box', size: [0.12, 0.6, 0.12] }, at: [x, 0.3, z], pivot: [x, 0.6, z], motion: 'limb', amount: 0.6, phase, slot: 1 });
  const link = (k: number): RigPart => ({ shape: { kind: 'box', size: [0.14, 0.14, 0.3] }, at: [0, 0.7, -0.6 - 0.3 * k], pivot: [0, 0.7, -0.45], motion: 'bend', amount: 0.4 + 0.1 * k, phase: 0.25, axis: k === 2 ? 'x' : 'y', slot: 0 });
  return {
    name: 'chain',
    parts: [
      { shape: { kind: 'box', size: [0.5, 0.35, 1.0] }, at: [0, 0.75, 0], slot: 0 },
      leg(0.2, 0.35, 0), leg(-0.2, 0.35, gait === 'free' ? 0.25 : 0.5), leg(0.2, -0.35, gait === 'free' ? 0.5 : 0.5), leg(-0.2, -0.35, gait === 'free' ? 0.75 : 0),
      { shape: { kind: 'box', size: [0.2, 0.2, 0.25] }, at: [0, 0.95, 0.6], motion: 'look', amount: 0.5, slot: 2, nearOnly: true },
      link(0), link(1), link(2),
    ],
    segments: [{ shadow: [0.35, 0.7, 0] }],
    height: 1.1,
    radius: 1.2,
    ...(gait ? { gait } : {}),
    ...(gait === 'free' ? { dip: 0.04, walkSpeed: [0.2, 1.0] as const } : {}),
  };
}

/**
 * Rig options: `rigExtended` false for a plain description and true for a free gait or a bend chain; an explicit
 * pair gait gives the default bytes; every vertex of a bend part carries kind 7, 8 or 9 by its axis, its amount and
 * lag; the links of a chain share their root. Hashes near, far and shadow meshes.
 */
function rigOptionsScript(): unknown[] {
  // A plain description: rigid and limb parts only, default gait (it only feeds the checks, not the hashed bytes).
  const plain: RigDesc = {
    name: 'plain',
    parts: [
      { shape: { kind: 'box', size: [0.4, 0.6, 0.25] }, at: [0, 1.1, 0], slot: 0 },
      { shape: { kind: 'box', size: [0.14, 0.8, 0.14] }, at: [0.1, 0.4, 0], pivot: [0.1, 0.8, 0], motion: 'limb', amount: 0.6, phase: 0, slot: 1 },
      { shape: { kind: 'box', size: [0.14, 0.8, 0.14] }, at: [-0.1, 0.4, 0], pivot: [-0.1, 0.8, 0], motion: 'limb', amount: 0.6, phase: 0.5, slot: 1 },
    ],
    segments: [{ shadow: [0.25, 0.25, 0] }],
    height: 1.4,
    radius: 0.5,
  };
  if (rigExtended(plain)) throw new Error('rig options: a plain description is extended');
  const free = chainRig('free');
  if (!rigExtended(free) || !rigExtended(chainRig())) throw new Error('rig options: a free gait or a bend chain is not extended');
  const noBend: RigDesc = { ...chainRig(), parts: chainRig().parts.filter((p) => p.motion !== 'bend') };
  if (rigExtended(noBend) || rigExtended({ ...noBend, gait: 'pair' })) throw new Error('rig options: a pair gait without bend is extended');
  const f32 = (m: MeshData): Float32Array => new Float32Array(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength / 4);
  if (hash(rigMesh(noBend).vertices) !== hash(rigMesh({ ...noBend, gait: 'pair' }).vertices) || hash(rigMesh(plain).vertices) !== hash(rigMesh({ ...plain, gait: 'pair' }).vertices)) throw new Error('rig options: an explicit pair gait changed the bytes');
  const roots = new Set<string>();
  for (const part of free.parts) {
    if (part.motion !== 'bend') continue;
    const v = f32(rigMesh({ ...free, parts: [part] }));
    const want = RIG_MOTION.bend + RIG_BEND_AXIS[part.axis ?? 'y'];
    for (let i = 0; i < v.length; i += RIG_VERTEX_FLOATS) {
      if (v[i + 9] !== want || v[i + 10] !== Math.fround(part.amount!) || v[i + 17] !== Math.fround(part.phase!)) throw new Error(`rig options: a bend vertex carries kind ${v[i + 9]}, amount ${v[i + 10]}, lag ${v[i + 17]}`);
      roots.add(`${v[i + 6]},${v[i + 7]},${v[i + 8]}`);
    }
  }
  if (roots.size !== 1) throw new Error(`rig options: the links of the chain have ${roots.size} roots`);
  return [rigMesh(free).vertices, rigMesh(free, true).vertices, rigShadowMesh(free).vertices, rigMesh(chainRig()).vertices];
}

/**
 * `nearScatter` of three kinds on a synthetic square: the same bytes twice, sorted by order per kind, every u, v
 * inside, half the density a subset with equal bytes, mask 7 = masks 1 and 6 joined; `nearKeep` 1 at 0 and 0 from the
 * reach on, never rising with distance, smooth; `nearCount` leaves out no record that can still be seen.
 */
function nearScatterScript(): unknown[] {
  const F = NEAR_FLOATS;
  const make = (mask: number, scale: number): NearRecords =>
    nearScatter({
      seed: 717,
      key: [3, 41, 17],
      candidates: [400, 90, 30],
      mask,
      densityAt: (k, u, v) => scale * (k === 0 ? 0.3 + 0.6 * u : k === 1 ? 0.5 * (1 - v) : 0.8),
      fill: (k, u, v, roll, out, at) => {
        out[at] = u;
        out[at + 1] = v;
        out[at + 2] = k;
        for (let q = 4; q < F; q++) out[at + q] = roll(q);
      },
    });
  const all = make(7, 1);
  if (hash(all.data, all.start) !== hash(make(7, 1).data, make(7, 1).start)) throw new Error('near scatter: two runs differ');
  for (let k = 0; k < 3; k++) {
    for (let i = all.start[k]!; i < all.start[k + 1]!; i++) {
      const u = all.data[i * F]!;
      const v = all.data[i * F + 1]!;
      if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) throw new Error(`near scatter: record ${i} outside the square`);
      if (i > all.start[k]! && all.data[i * F + 3]! > all.data[(i - 1) * F + 3]!) throw new Error(`near scatter: kind ${k} not sorted by order`);
    }
  }
  // Half the density: a subset, record for record the same bytes.
  const half = make(7, 0.5);
  const records = (r: NearRecords, k: number): Set<string> => {
    const s = new Set<string>();
    for (let i = r.start[k]!; i < r.start[k + 1]!; i++) s.add(Array.from(r.data.subarray(i * F, (i + 1) * F)).join(','));
    return s;
  };
  for (let k = 0; k < 3; k++) {
    const full = records(all, k);
    const some = records(half, k);
    if (some.size >= full.size) throw new Error(`near scatter: half the density kept as many of kind ${k}`);
    for (const r of some) if (!full.has(r)) throw new Error(`near scatter: half the density made a new record of kind ${k}`);
  }
  // Masks: kind 0 alone and kinds 1 and 2 together give the bytes of all three.
  const m1 = make(1, 1);
  const m6 = make(6, 1);
  for (let k = 0; k < 3; k++) {
    const from = k === 0 ? m1 : m6;
    const a = all.data.subarray(all.start[k]! * F, all.start[k + 1]! * F);
    const b = from.data.subarray(from.start[k]! * F, from.start[k + 1]! * F);
    if (hash(a) !== hash(b)) throw new Error(`near scatter: kind ${k} differs under another mask`);
  }
  // Fade.
  const fade: NearFade = { reachM: 60, band: 0.6, softM: 9 };
  const keeps: number[] = [];
  for (const order of [0, 0.3, 0.77, 1]) {
    if (nearKeep(fade, 1, order, 0) !== 1) throw new Error('near scatter: nearKeep is not 1 at the eye');
    let prev = 1;
    for (let d = 0; d <= 70; d += 0.1) {
      const k = nearKeep(fade, 1, order, d);
      if (k > prev + 1e-12) throw new Error('near scatter: nearKeep rises with distance');
      if (prev - k >= 0.02) throw new Error(`near scatter: nearKeep falls by ${prev - k} in 0.1 m`);
      if (d >= fade.reachM && k !== 0) throw new Error('near scatter: something is kept past the reach');
      prev = k;
      if (Math.round(d * 10) % 50 === 0) keeps.push(k);
    }
  }
  const stepM = 2;
  for (const dist of [5, 20, 33, 40, 51, 59]) {
    for (let k = 0; k < 3; k++) {
      const from = all.start[k]!;
      const to = all.start[k + 1]!;
      const n = nearCount(all.data, from, to, fade, 0.8, Math.max(0, dist - stepM));
      for (let i = from + n; i < to; i++) {
        for (let d = dist - stepM; d <= dist + stepM; d += 0.5) if (nearKeep(fade, 0.8, all.data[i * F + 3]!, Math.max(0, d)) > 0) throw new Error(`near scatter: nearCount left out record ${i} still seen at ${d} m`);
      }
      keeps.push(n);
    }
  }
  return [all.data, all.start, half.start, Float64Array.from(keeps)];
}

const accept = process.argv.includes('--accept');
const stored = fs.existsSync(STORE) ? (JSON.parse(fs.readFileSync(STORE, 'utf8')) as Record<string, string>) : {};
const now: Record<string, string> = {};
let failed = 0;
for (const [name, run] of Object.entries(RECIPES)) {
  now[name] = run();
  if (accept) continue;
  if (stored[name] === undefined) {
    failed++;
    console.log(`MISSING ${name}: no stored hash (run with --accept to store ${now[name]})`);
  } else if (stored[name] !== now[name]) {
    failed++;
    console.log(`CHANGED ${name}: output differs from the stored hash (${stored[name]} → ${now[name]})`);
  } else console.log(`ok ${name}`);
}
if (accept) {
  fs.writeFileSync(STORE, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`golden: stored ${Object.keys(now).length} hashes in ${path.relative(process.cwd(), STORE)}`);
} else {
  for (const name of Object.keys(stored)) if (!(name in RECIPES)) console.log(`note: stored hash "${name}" has no recipe any more`);
  console.log(`golden: ${Object.keys(RECIPES).length - failed} of ${Object.keys(RECIPES).length} generators unchanged`);
  process.exit(failed ? 1 : 0);
}
