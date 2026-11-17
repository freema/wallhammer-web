// Destruction case for the golden test: three fixed structures on flat ground, their destructible descriptions, a
// scripted list of events applied in order, and the mesh regenerated from the resulting state.

import { orientedBox, pointInRings, ringSignedArea } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import type { Ring } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import type { RubbleFootprint, StructureDesc, StructureState } from '../../../packages/wallhammer-web/src/base/index.ts';
import { TIMELINE, TIMELINE_TICK_S, applyEventToAll, compileStructure, destructionEvent, encodeStates, stateHash } from '../../../packages/wallhammer-web/src/sim/destruction/index.ts';
import { trackPose } from '../../../packages/wallhammer-web/src/core/index.ts';
import type { PartChange } from '../../../packages/wallhammer-web/src/sim/destruction/index.ts';
import { GROUND_FLOOR, buildBuildingMesh, buildRubbleMesh, fallPieces, rubbleColours } from '../../../packages/wallhammer-web/src/gen-arch/index.ts';
import type { BuildingSpec, FacadeRecipe, RoofKind } from '../../../packages/wallhammer-web/src/gen-arch/index.ts';

export const GROUND_Y = 100;
export const groundAt = (): number => GROUND_Y;
export const MESH_DIMS = { minWallHeight: 2.6, wallBelowGround: 0.6, floorHeightMin: 2.7, floorHeightMax: 4.6, parapetThickness: 0.35, roofSlopeMin: 0.32, roofSlopeMax: 1.2, roofUnitMinRoofArea: 60, roofUnitAreaPerUnit: 40, roofUnitMaxCount: 3, roofUnitMinSize: 1.2, roofUnitMaxSize: 3, roofUnitMinHeight: 0.8, roofUnitMaxHeight: 2 };
const RECIPE: FacadeRecipe = {
  groundFloorHeight: 3.6, groundFloor: GROUND_FLOOR.glazed, plinthHeight: 0.5, curtainShare: 0.4, blindShare: 0.2, panelJoints: true, blindEndWalls: 6,
  window: { width: 1.2, height: 1.5, sill: 0.9, mullions: 1, transom: true, narrowMask: 0 },
  balconies: { kind: 'balcony', depth: 1.2, columnMask: 0b0101, minWallLength: 8 }, cornice: { height: 0.4, projection: 0.3 },
  entrances: [{ x: 7, z: 0, kind: 'door', width: 1.4, raise: 0.4, canopy: 1 }], stairStrip: true, chimneys: 2, roofBoxes: null,
  colors: { frame: 3, plinth: 4, door: 5, accent: 6, chimney: 7 },
};
const rect = (x: number, z: number, w: number, d: number): Ring => {
  const r = Float32Array.of(x, z, x + w, z, x + w, z + d, x, z + d);
  return ringSignedArea(r) > 0 ? r : Float32Array.of(x, z, x, z + d, x + w, z + d, x + w, z);
};
function structure(id: number, x: number, roof: RoofKind, eave: number, ridge: number, facade?: FacadeRecipe): BuildingSpec {
  const rings = [rect(x, 0, 14, 9)];
  return { id, hash: id * 2654435761, rings, box: orientedBox(rings[0]!), groundMin: GROUND_Y, groundRef: GROUND_Y, eaveY: GROUND_Y + eave, ridgeY: GROUND_Y + ridge, roof, ridgeAcross: false, levelsHint: 3, floorHeightNominal: 3.1, bayWidth: 3, windowStyle: 1, parapetHeight: 0.5, wallColor: 8, roofColor: 9, trimColor: 10, roofUnitColor: 11, ...(facade ? { facade } : {}) };
}

/** The three fixed structures: flat roof with a façade recipe, gable, hip. */
export const SPECS: readonly BuildingSpec[] = [structure(1, 0, 'flat', 12, 12, RECIPE), structure(2, 24, 'gable', 9.5, 14), structure(3, 48, 'hip', 9.5, 13)];

/** Scripted events (metres): a cracked wall, a blown-out corner, a ground storey taken out under an upper storey. */
export const EVENT_SCRIPT: readonly { position: [number, number, number]; radius: number; energy: number }[] = [
  { position: [7, GROUND_Y + 5, 0], radius: 2.5, energy: 300 },
  { position: [14, GROUND_Y + 1.5, 9], radius: 2.5, energy: 600 },
  { position: [14, GROUND_Y + 2, 9], radius: 3.2, energy: 1500 },
  { position: [27, GROUND_Y + 0.8, 0], radius: 2.2, energy: 1600 },
  { position: [31, GROUND_Y + 0.8, 0], radius: 2.2, energy: 1600 },
  { position: [35, GROUND_Y + 0.8, 0], radius: 2.2, energy: 1600 },
  { position: [55, GROUND_Y + 8, 4.5], radius: 2, energy: 700 },
];

export function describeAll(): StructureDesc[] {
  return buildBuildingMesh([...SPECS], [], groundAt, MESH_DIMS, { describe: true }).structures;
}

export interface ScenarioResult {
  structures: StructureDesc[];
  states: Map<number, StructureState>;
  changes: PartChange[];
  rubble: RubbleFootprint[];
}

/** Runs the event script from an intact start. */
export function runDestruction(): ScenarioResult {
  const structures = describeAll();
  let states = new Map<number, StructureState>();
  const changes: PartChange[] = [];
  const rubble: RubbleFootprint[] = [];
  EVENT_SCRIPT.forEach((e, tick) => {
    const r = applyEventToAll(structures, states, destructionEvent({ ...e, seed: 0x5eed, tick }));
    states = r.states;
    changes.push(...r.changes);
    rubble.push(...r.rubble);
  });
  return { structures, states, changes, rubble };
}

/** Plain data of a description, for hashing. */
export function descData(d: StructureDesc): unknown[] {
  return [d.id, d.keepOut, d.groundY, d.cx, d.cz, d.outline, d.materials, d.parts.map((p) => [p.key, p.role, p.material, p.mass, p.piece.xz, p.piece.y0, p.piece.y1, p.flags, p.maxSpan]), d.bonds.map((b) => [b.a, b.b, b.bearing, b.x, b.y, b.z, b.area])];
}

export function rubbleData(list: readonly RubbleFootprint[]): unknown[] {
  return list.map((f) => [f.structure, f.part, f.archetype, f.material, f.cx, f.cz, f.y, f.ux, f.uz, f.halfL, f.halfW, f.height, f.corners, f.seed]);
}

/** Mesh of the structures in a state, and the mesh of their rubble. */
export function damagedMeshes(states: ReadonlyMap<number, StructureState>, rubble: readonly RubbleFootprint[]) {
  const r = buildBuildingMesh([...SPECS], [], groundAt, MESH_DIMS, { states });
  const heap = buildRubbleMesh(rubble, rubbleColours(SPECS), groundAt);
  return { structures: r.mesh, stats: r.stats, rubble: heap };
}

export { encodeStates, stateHash };

// Interior plans. The plan is a pure function of the structure plan: the three scripted structures plus an L shape,
// a courtyard block and a small shed are planned from intact, after the script and after the script run backwards.
/** A ring wound like the outer rings (positive area), or like a hole (negative area) when `hole` is set. */
const ring = (pts: number[], hole = false): Ring => {
  const r = Float32Array.from(pts);
  if (ringSignedArea(r) > 0 !== hole) return r;
  const out = new Float32Array(r.length);
  for (let i = 0; i < r.length; i += 2) (out[r.length - 2 - i] = r[i]!), (out[r.length - 1 - i] = r[i + 1]!);
  return out;
};
function shaped(id: number, rings: Ring[], roof: RoofKind, eave: number, ridge: number): BuildingSpec {
  return { ...structure(id, 0, roof, eave, ridge), rings, box: orientedBox(rings[0]!) };
}
export const PLAN_SPECS: readonly BuildingSpec[] = [
  ...SPECS,
  shaped(4, [ring([80, 0, 104, 0, 104, 10, 92, 10, 92, 26, 80, 26])], 'flat', 15, 15),
  shaped(5, [ring([120, 0, 150, 0, 150, 30, 120, 30]), ring([128, 8, 128, 22, 142, 22, 142, 8], true)], 'flat', 9, 9),
  shaped(6, [rect(160, 0, 3.2, 2.6)], 'gable', 2.7, 4),
];

function planData(states?: ReadonlyMap<number, StructureState>): unknown[] {
  // Fresh spec objects: the plan cache is per spec object, so every call plans anew.
  const r = buildBuildingMesh(PLAN_SPECS.map((x) => ({ ...x })), [], groundAt, MESH_DIMS, { interiors: true, ...(states ? { states } : {}) });
  return [...r.interiors.entries()].sort((a, b) => a[0] - b[0]).map(([id, ip]) => [id, JSON.stringify(ip, (_k, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v))]);
}

/** Interior plans from intact, from the scripted state and from the script applied in reverse order; all must agree. */
export function interiorPlans(): unknown[] {
  const structures = buildBuildingMesh([...PLAN_SPECS], [], groundAt, MESH_DIMS, { describe: true }).structures;
  const run = (events: typeof EVENT_SCRIPT): Map<number, StructureState> => {
    let states = new Map<number, StructureState>();
    events.forEach((e, tick) => (states = applyEventToAll(structures, states, destructionEvent({ ...e, seed: 0x5eed, tick })).states));
    return states;
  };
  const intact = JSON.stringify(planData());
  const forward = JSON.stringify(planData(run(EVENT_SCRIPT)));
  const reversed = JSON.stringify(planData(run([...EVENT_SCRIPT].reverse())));
  if (forward !== intact || reversed !== intact) throw new Error('interior plan depends on the damage state');
  const plans = buildBuildingMesh([...PLAN_SPECS], [], groundAt, MESH_DIMS, { interiors: true }).interiors;
  for (const s of PLAN_SPECS) {
    for (const c of plans.get(s.id)!.cells) for (const poly of c.polys) for (let k = 0; k < poly.length; k += 2) {
      if (!pointInRings(poly[k]!, poly[k + 1]!, s.rings)) throw new Error(`interior plan of ${s.id}: cell corner outside the footprint`);
    }
  }
  return planData();
}

/** Interior vertices only (kind 4), from one deep hit through the front of the flat structure: storeys cut open. */
export function interiorMesh(): { bytes: Uint8Array; count: number } {
  const structures = describeAll();
  const states = applyEventToAll(structures, new Map(), destructionEvent({ position: [7, GROUND_Y + 6, 1], radius: 5, energy: 900, seed: 0x5eed, tick: 0 })).states;
  const m = buildBuildingMesh([...SPECS], [], groundAt, MESH_DIMS, { states }).mesh;
  const stride = m.layout.stride;
  const src = new Uint8Array(m.vertices.buffer, m.vertices.byteOffset, m.count * stride);
  const keep: number[] = [];
  for (let v = 0; v < m.count; v++) if ((src[v * stride + 15]! & 7) === 4) keep.push(v);
  const bytes = new Uint8Array(keep.length * stride);
  keep.forEach((v, k) => bytes.set(src.subarray(v * stride, (v + 1) * stride), k * stride));
  return { bytes, count: keep.length };
}

// Staged collapse. The timeline is presentation data next to the result: the state an event commits is the same with
// or without it, and a second hit acts on that committed state whenever it comes.
/** Timelines of the event script, run twice; checks the bounds and that the committed states match the plain run. */
export function timelineScript(): unknown[] {
  const run = (): { timelines: Uint16Array[]; hashes: string[]; changes: number[] } => {
    const structures = describeAll();
    let states = new Map<number, StructureState>();
    const timelines: Uint16Array[] = [];
    const hashes: string[] = [];
    const changes: number[] = [];
    EVENT_SCRIPT.forEach((e, tick) => {
      const r = applyEventToAll(structures, states, destructionEvent({ ...e, seed: 0x5eed, tick }));
      if (r.timeline.length !== r.changes.length) throw new Error('timeline: not one entry per change');
      r.changes.forEach((c, k) => {
        const t = r.timeline[k]!;
        if (c.cause === 'damage' ? t !== 0 : t < TIMELINE.first || t > TIMELINE.max) throw new Error(`timeline: ${c.cause} change at tick ${t}`);
      });
      states = r.states;
      timelines.push(r.timeline);
      hashes.push(stateHash([...states.values()]));
      changes.push(r.changes.length);
    });
    return { timelines, hashes, changes };
  };
  const a = run();
  const b = run();
  if (JSON.stringify(a.timelines.map((t) => [...t])) !== JSON.stringify(b.timelines.map((t) => [...t]))) throw new Error('timeline: not deterministic');
  // The final state equals the instantaneous result (the plain script run, which ignores the timeline).
  const plain = runDestruction();
  if (a.hashes[a.hashes.length - 1] !== stateHash([...plain.states.values()])) throw new Error('timeline: final state differs from the instantaneous result');
  if (!a.timelines.some((t) => t.some((v) => v > 0))) throw new Error('timeline: the script has no support loss');
  return [a.timelines, a.hashes, a.changes, TIMELINE_TICK_S];
}

/** Falling pieces of the script's support-loss event: tracks and poses at fixed clock times, rubble arrivals. */
export function fallTracks(): unknown[] {
  const structures = describeAll();
  let states = new Map<number, StructureState>();
  const out: unknown[] = [];
  const AT = 10;
  EVENT_SCRIPT.forEach((e, tick) => {
    const ev = destructionEvent({ ...e, seed: 0x5eed, tick });
    const r = applyEventToAll(structures, states, ev);
    const prev = states;
    states = r.states;
    const by = new Map<number, { part: number; hit: boolean; delay: number }[]>();
    r.changes.forEach((c, k) => {
      if (c.to !== 3) return;
      const l = by.get(c.structure) ?? [];
      l.push({ part: c.part, hit: c.cause === 'damage', delay: r.timeline[k]! * TIMELINE_TICK_S });
      by.set(c.structure, l);
    });
    for (const [id, changes] of [...by].sort((x, y) => x[0] - y[0])) {
      const desc = compileStructure(structures.find((d) => d.id === id)!).desc;
      const spec = SPECS.find((s) => s.id === id)!;
      const before = buildBuildingMesh([spec], [], groundAt, MESH_DIMS, { states: prev, byParts: true }).mesh;
      const f = fallPieces({
        desc,
        state: states.get(id)!,
        before,
        changes,
        event: { x: e.position[0], y: e.position[1], z: e.position[2], radius: e.radius, energy: e.energy, seed: ev.seed },
        at: AT,
        groundAt,
        budget: 40,
      });
      const q = (v: number): number => Math.round(v * 1e4) / 1e4;
      for (const t of f.tracks) {
        if (!t.dust && t.land > t.y + 1e-6 && t.vy <= 0) throw new Error('fall: a piece lands above where it starts');
        const poses = [0, 0.3, 0.8, 1.5, 3, 6].map((dt) => {
          const k = trackPose(t, AT + dt);
          return [q(k.x), q(k.y), q(k.z), q(k.angle), q(k.crumble), k.phase];
        });
        out.push([tick, id, q(t.start), poses]);
      }
      // The pieces' geometry: vertex count and a sum over positions (cut-out triangles, clipped cells, shells).
      const v = new Float32Array(f.mesh.vertices.buffer, f.mesh.vertices.byteOffset, (f.mesh.count * f.mesh.layout.stride) / 4);
      let sum = 0;
      for (let k = 0; k < f.mesh.count; k++) {
        const o = (k * f.mesh.layout.stride) / 4;
        sum += v[o]! * 1 + v[o + 1]! * 3 + v[o + 2]! * 7;
      }
      out.push([f.pieces, f.dust, f.mesh.count, q(sum), q(f.start), q(f.end)]);
      out.push([...f.arrivals].sort((x, y) => x[0] - y[0]).map(([k, a]) => [k, q(a.start), a.seconds]));
    }
  });
  if (out.length === 0) throw new Error('fall: no pieces');
  return out;
}
