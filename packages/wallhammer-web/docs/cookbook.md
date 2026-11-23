# Cookbook

Recipes for building a game or a world **with** the engine. Each has the same shape: the goal, the modules, minimal
code (type-checked against the package), the example to open and the pitfalls. Each links the reference page instead
of repeating it. [Recipes](recipes.md) is the other book: extending the engine itself (a layer, a material, a slot).
Start at [Wallhammer Web for agents](agents.md) for the rules and the module map.

The examples named here live in the repository (<https://github.com/freema/wallhammer-web/tree/main/examples>) and
run live at `https://freema.github.io/wallhammer-web/<name>/`.

## A world that loads only around the player

**Goal.** An endless or large world cut into quadtree cells; cells near the viewer are generated in workers, uploaded
within a time budget and drawn; far ones are coarse; cells nobody needs are forgotten.

**Modules.** `gen-core` (`FlatWorld`, `FACE_FLAT`, `CellContent`), `gen-mesh` (`cellSurfaceMesh`), `world`
(`DEFAULT_STREAMING`, `GeneratorCellProvider`), `runtime` (`StreamedWorld`, `WorkerCellProvider`,
`serveCellGenerator`, `viewTickets`), `platform` (`workersAvailable`).

The generator, in a module of its own that the worker and the page both import. Pure: (seed, cell) → content.

<!-- check: wrap -->
```ts
import { FACE_FLAT, FlatWorld, hashInts, valueNoise2 } from 'wallhammer-web/gen-core';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { cellSurfaceMesh } from 'wallhammer-web/gen-mesh';

const SHAPE = new FlatWorld();
const FACE = FACE_FLAT;

/** Height at a world point (doubles). A function of the point alone, so neighbouring cells agree on their border. */
function heightAt(seed: number, x: number, z: number): number {
  return 60 * valueNoise2(x, z, 900, hashInts(seed, 1)) + 8 * valueNoise2(x, z, 70, hashInts(seed, 2));
}

function generateCell(seed: number, cell: CellId): CellContent {
  const size = SHAPE.edgeM(cell.level);
  const o = SHAPE.origin(cell);
  const skirt = Math.max(2, size * 0.04);
  const s = cellSurfaceMesh({ originX: o[0], originZ: o[2], size, quads: 32, heightAt: (x, z) => heightAt(seed, x, z), skirtDepth: skirt });
  return {
    cell,
    domainVersion: 1, // raise when the output changes on purpose
    bounds: { min: [0, s.minY - skirt, 0], max: [size, s.maxY, size] }, // relative to the cell origin
    meshes: [{ material: 'terrain', mesh: s.mesh }],
    instances: [],
  };
}
```

The worker script is two lines (`cell-worker.ts`):

<!-- check: wrap -->
```ts
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { serveCellGenerator } from 'wallhammer-web/runtime';
declare function generateCell(seed: number, cell: CellId): CellContent; // import it from your generator module

serveCellGenerator(generateCell);
```

The page: a provider (workers, or the main thread where workers are missing), the streamed layer and, every frame,
where the viewer is.

<!-- check: wrap -->
```ts
import type { PerspectiveOrbitRig } from 'wallhammer-web/camera';
import type { CellContent, CellId, FlatWorld } from 'wallhammer-web/gen-core';
import { workersAvailable } from 'wallhammer-web/platform';
import type { Material } from 'wallhammer-web/render';
import { StreamedWorld, WorkerCellProvider, viewTickets } from 'wallhammer-web/runtime';
import type { Engine } from 'wallhammer-web/runtime';
import { DEFAULT_STREAMING, GeneratorCellProvider } from 'wallhammer-web/world';
declare const engine: Engine<PerspectiveOrbitRig>;
declare const SHAPE: FlatWorld;
declare const FACE: number;
declare function generateCell(seed: number, cell: CellId): CellContent;
declare function heightAt(seed: number, x: number, z: number): number;
declare const terrain: Material; // your material for CELL_SURFACE_LAYOUT; its programs add u_cellOffset
declare const cellWorkerUrl: string; // in Vite: import cellWorkerUrl from './cell-worker.ts?worker&url';

const seed = 7;
const provider = workersAvailable() ? new WorkerCellProvider(cellWorkerUrl, seed) : new GeneratorCellProvider(seed, generateCell);
const world = new StreamedWorld({
  renderer: engine.renderer,
  config: { ...DEFAULT_STREAMING, shape: SHAPE, face: FACE, rootLevel: 4, leafLevel: 9, memoryBudgetBytes: 256 * 1024 * 1024 },
  provider,
  materials: { terrain }, // the names in CellContent.meshes
  onActivity: () => engine.invalidate(),
});
engine.add(world);

// The player in world metres (doubles). Before every frame: the focus, the camera in render space, the tickets.
const player: [number, number, number] = [0, 0, 0];
const view = engine.view;
engine.renderer.beforeFrame.unshift(() => {
  world.setFocus([player[0], 0, player[2]]);
  view.target = [player[0] - world.origin[0], heightAt(seed, player[0], player[2]) + 2, player[2] - world.origin[2]];
  const eye = world.toWorld(view.eye());
  const f = view.axes().forward;
  world.setEye(eye);
  world.setTickets(viewTickets(eye, eye[1] - heightAt(seed, eye[0], eye[2]), [f[0], f[2]]));
});
```

**Example.** `endless` (`src/terrain.ts` the generator, `src/cell-worker.ts`, `src/main.ts` the wiring;
`#cam=free` for the free camera). On a sphere: `planet`, and [A sphere world](streaming.md#a-sphere-world).

**Pitfalls.**

- A worker handed to the engine as a URL is not bundled by Vite unless the URL comes from `?worker&url` (or the
  worker stands in `new Worker(new URL(…), …)` itself). In the dev server a plain `new URL('./cell-worker.ts',
  import.meta.url)` works and the build silently ships a worker that never starts.
- The generator must be pure and must not read the cell index for content: heights and colours from world
  coordinates, object ids from `hashInts(seed, rule, anchor)`. Otherwise seams and popping between levels.
- Raise `domainVersion` when the output changes on purpose (cached or baked cells are then rejected).
- `memoryBudgetBytes` counts CPU and GPU bytes together; `gpuCeilingBytes` is a second limit for the whole page
  ([A ceiling of GPU memory](streaming.md#a-ceiling-of-gpu-memory)).
- Anything else you draw next to streamed cells must also subtract `world.origin` (`world.toRender(p)`).
- Without `morph` and screen-space selection, level changes jump. See
  [Blending between levels](streaming.md#blending-between-levels).
- The engine has no ready material for `cellSurfaceMesh`; copy the terrain material of `endless` (`src/shaders.ts`)
  and keep `u_cellOffset` in its vertex programs.

## Terrain with hills

**Goal.** Ground that rises and falls, drawn, walkable and the same everywhere it is asked.

**Modules.** `gen-core` (`valueNoise2`, `streamSeed`, `hashInts`, `HeightField`), `gen-mesh` (`heightFieldMesh`;
in streamed cells `cellSurfaceMesh` or `cellMorphMesh`), `world` (`CollisionWorld`).

One height function drives the drawn mesh and the collision world:

<!-- check: wrap -->
```ts
import { HeightField, hashInts, streamSeed, valueNoise2 } from 'wallhammer-web/gen-core';
import { heightFieldMesh } from 'wallhammer-web/gen-mesh';
import { CollisionWorld } from 'wallhammer-web/world';

const seed = streamSeed('my-world', 'ground');
/** Broad hills plus small bumps; metres. */
const hills = (x: number, z: number): number => 30 * valueNoise2(x, z, 400, seed) + 4 * valueNoise2(x, z, 45, hashInts(seed, 1));

const STEP = 2;
const N = 129; // 256 m square
const heights = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) heights[j * N + i] = hills(i * STEP, j * STEP);
const field = new HeightField(STEP, N, N, heights);

const mesh = heightFieldMesh(field, field.minY - 4); // MeshData with a skirt down to minY − 4; HEIGHT_FIELD_ATTRIBS
// The walker stands on the triangles that are drawn, not on the smooth function between them.
const collision = new CollisionWorld({ heightAt: (x, z) => field.heightAt(x, z), baseMinY: field.minY, baseMaxY: field.maxY });
```

Draw `mesh` with a `MeshLayer` and the material of [Getting started](getting-started.md#the-smallest-scene); set
`renderer.bounds` to the field's extent.

**Example.** `minimal-3d` (an island), `endless` (`src/terrain.ts`: continents, ridges, hills and colours by climate).

**Pitfalls.**

- `valueNoise2(x, z, cellM, seed)` returns 0–1; sum a few octaves with their own seeds (`hashInts(seed, k)`) for
  hills that are not a single wave.
- For a large area do not grow one `HeightField`: stream it ([previous recipe](#a-world-that-loads-only-around-the-player)).
- Ground colour by surface class (grass, path, field) is `gen-ground` (`groundBake` from a class raster); colour by
  height or slope is one line in your fragment shader or in `cellSurfaceMesh`'s `colorAt`.
- A view near the ground needs the eye kept above it: `PerspectiveOrbitRig` takes a ground function
  ([Keeping the eye above the ground](cameras.md#keeping-the-eye-above-the-ground)); `FreeRig` has `minClearance`.

## Houses from footprints

**Goal.** Houses with walls, windows, doors, roofs, cornices and chimneys from outlines on the ground, instead of boxes.

**Modules.** `gen-arch` (`buildBuildingMesh`, `structureMaterial`, `structureUniforms`, `windowLightSlot`),
`gen-ground` (`snowSlot`, the structure shader includes `<snow>`), `gen-core` (`orientedBox`, `ringSignedArea`).

The outline is your data, in local metres. A small function turns it into a `BuildingSpec`; colours are palette rows.

<!-- check: wrap -->
```ts
import { definePalette } from 'wallhammer-web/core';
import { buildBuildingMesh, structureMaterial, structureUniforms, windowLightSlot } from 'wallhammer-web/gen-arch';
import type { ArchDims, BuildingSpec, RoofKind } from 'wallhammer-web/gen-arch';
import { orientedBox, ringSignedArea } from 'wallhammer-web/gen-core';
import type { Ring } from 'wallhammer-web/gen-core';
import { snowSlot } from 'wallhammer-web/gen-ground';
import { MeshLayer } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine; // created with slots: [snowSlot(), windowLightSlot()] and this palette
declare function groundAt(x: number, z: number): number;

/** One house of the project's own data: an outline (x, z pairs), eave and ridge heights above the ground, a roof. */
interface Footprint { id: number; outline: number[]; eaveM: number; ridgeM: number; roof: RoofKind }

const palette = definePalette({ wall: '#a3937a', roof: '#804c3d', trim: '#cbc5ba', unit: '#77736d', glass: '#22272c', glassLit: '#56646e', plinth: '#5b554d' });
const row = (name: 'wall' | 'roof' | 'trim' | 'unit' | 'glass' | 'glassLit' | 'plinth'): number => palette.index(name);
const DIMS: ArchDims = {
  minWallHeight: 2.6, wallBelowGround: 0.6, floorHeightMin: 2.7, floorHeightMax: 4.6, parapetThickness: 0.35,
  roofSlopeMin: 0.32, roofSlopeMax: 1.2, roofUnitMinRoofArea: 60, roofUnitAreaPerUnit: 40, roofUnitMaxCount: 3,
  roofUnitMinSize: 1.2, roofUnitMaxSize: 3, roofUnitMinHeight: 0.8, roofUnitMaxHeight: 2, plinthHeight: 0.5,
  wallBaseShadeHeight: 1.2, parapetHeight: 0.6,
};

/** Outlines must run counter-clockwise (positive signed area); reverse the points otherwise. */
function ring(points: number[]): Ring {
  const r = Float32Array.from(points);
  if (ringSignedArea(r) > 0) return r;
  const out = new Float32Array(r.length);
  for (let i = 0; i < r.length / 2; i++) [out[i * 2], out[i * 2 + 1]] = [r[r.length - 2 - i * 2]!, r[r.length - 1 - i * 2]!];
  return out;
}

function toSpec(f: Footprint): BuildingSpec {
  const r = ring(f.outline);
  const ground = Math.min(...f.outline.map((v, i) => (i % 2 ? Infinity : groundAt(v, f.outline[i + 1]!))));
  return {
    id: f.id, hash: Math.imul(f.id, 2654435761) >>> 0, rings: [r], box: orientedBox(r),
    groundMin: ground, groundRef: ground, eaveY: ground + f.eaveM, ridgeY: ground + f.ridgeM,
    roof: f.roof, ridgeAcross: false, levelsHint: Math.max(1, Math.round(f.eaveM / 3.1)), floorHeightNominal: 3.1,
    bayWidth: 3, windowStyle: 1, parapetHeight: 0.6,
    wallColor: row('wall'), roofColor: row('roof'), trimColor: row('trim'), roofUnitColor: row('unit'),
  };
}

const footprints: Footprint[] = [{ id: 1, outline: [0, 0, 12, 0, 12, 9, 0, 9], eaveM: 6.4, ridgeM: 10.4, roof: 'hip' }];
const specs = footprints.map(toSpec);
const built = buildBuildingMesh(specs, [], groundAt, DIMS);
const material = engine.renderer.material(structureMaterial(DIMS));
const uniforms = structureUniforms({ glass: row('glass'), glassLit: row('glassLit'), plinth: row('plinth') });
engine.add(new MeshLayer({ material, mesh: engine.renderer.createMesh(built.mesh, material), uniforms }));
console.log(built.stats.buildings, built.stats.roofFallbacks);
```

A full façade (ground floor, entrances, balconies, cornice, chimneys) is the optional `facade` recipe of a spec; finishes
(timber frame, stone, boards; thatch, slate, shingle) are codes on the spec drawn by `structureMaterial(dims, { finishes:
true })`. See [gen-arch](generators.md#content-module-gen-arch), [Compositions](generators.md#compositions) and
[Finishes and frames](generators.md#finishes-and-frames).

**Example.** `destruction` (`src/scene.ts`: five structures with different roofs and façade recipes).

**Pitfalls.**

- Register `snowSlot()` (from `gen-ground`) and `windowLightSlot()` in `createEngine({ slots })`: the structure shader
  needs both, and the block layout is fixed when the engine is created.
- Ids and `hash` must come from your data (a stable id), never from the array order, or every house changes when one
  is added.
- A large or ragged footprint with a `field` roof can explode in triangles: set `dims.fieldRoofMaxTriangles`
  (1000 is a sane start).
- For far houses use the massing mesh and stamped footprints ([Distant levels of structures](generators.md#distant-levels-of-structures)),
  not the full mesh.
- Walls should also block the walker: `collision.addPrism(spec.rings[0], spec.groundMin, spec.ridgeY)`.

## Time of day, weather and seasons

**Goal.** The sun on its path for a place and a date, a running day, clouds, rain or snow, wet or snowy ground, the
foliage of the season.

**Modules.** `env` (`Environment` through `engine.env`, `DEFAULT_WEATHER`, `dayOfYear`, `weatherGround`), `runtime`
(`createEngine` options `sky`, `atmosphere`, `precipitation`, `cloudVolume`, `cloudShadows`), `gen-ground`
(`seasonSlot`, `snowSlot`), `gen-vegetation` (`swaySlot`).

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { DEFAULT_WEATHER, dayOfYear, weatherGround } from 'wallhammer-web/env';
import { seasonSlot, snowSlot } from 'wallhammer-web/gen-ground';
import { createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;

const engine = createEngine({
  canvas,
  view: new PerspectiveOrbitRig(),
  palette: definePalette({ sky: '#8fb2c9' }),
  background: [0.56, 0.7, 0.79],
  environment: { mode: 'day', hour: 16, hoursPerSecond: 0.1, site: { latitudeDeg: 50, longitudeDeg: 14, dayOfYear: 120, utcOffsetHours: 2 } },
  slots: [seasonSlot(), snowSlot()],
  sky: true,
  precipitation: true,
});
const { env } = engine;
env.day.play(); // six minutes of the day per real minute
env.setDate(dayOfYear(11, 20)); // the sun's path and the foliage move together
env.weather = { ...DEFAULT_WEATHER, cloudCover: 0.7, precipitation: 0.6, precipitationKind: 'snow', fog: 0.2 };
env.wind = { fromDeg: 230, speedMs: 5 };

// Let the ground follow the sky: snow lies, rain wets, both go away. Stepped by the animation clock, not the wall clock.
let last = env.time.time;
engine.renderer.beforeFrame.push(() => {
  const dt = env.time.time - last;
  last = env.time.time;
  if (dt > 0) env.weather = weatherGround(env.weather, Math.min(dt, 1));
});
```

**Example.** `destruction` (`#w=rain`, `#w=snow`, space runs the day), `planet` (atmosphere, volumetric clouds, rain
under them), `minimal-3d` (`ground=follow`).

**Pitfalls.**

- Your materials must call the lighting functions (`sunVisibility`, `lightOn`, `applyFog`, `snowOn`, or
  `atmosphereLight` and `atmosphereApply` with the atmosphere), or the weather changes nothing on them
  ([Shaders](environment.md#shaders)).
- Wetness and snow cover do not follow precipitation by themselves; `weatherGround` or your own rule does it.
- The weather is six numbers you set. There are no fronts; a change over time is your own function of a clock
  ([Weather](environment.md#weather)).
- A running day redraws the shadow map every frame; for a still scene pause it (`env.day.pause()`).
- Trees from `gen-vegetation` need `seasonSlot`, `snowSlot` and `swaySlot` together.
- The season table is one climate by day of year (no hemisphere); give `seasonSlot` its own `PhenologyConfig`.

## A walking figure with a follow camera

**Goal.** A body walks, runs and jumps over ground and around solids; a camera follows it without passing through
walls; keys, mouse and gamepad drive it.

**Modules.** `world` (`CollisionWorld`, `Walker`, `newWalkIntent`), `camera` (`FollowRig`), `platform`
(`bindWalkInput`), `runtime` (`createEngine` with the rig as its view, no `orbitControls`).

<!-- check: wrap -->
```ts
import { FollowRig } from 'wallhammer-web/camera';
import { bindWalkInput } from 'wallhammer-web/platform';
import type { WalkInputState } from 'wallhammer-web/platform';
import type { Engine } from 'wallhammer-web/runtime';
import { CollisionWorld, Walker, newWalkIntent } from 'wallhammer-web/world';
declare function groundAt(x: number, z: number): number; // the same function the ground mesh is built from
declare const houses: { outline: number[]; minY: number; maxY: number }[];
declare function makeEngine(view: FollowRig): Engine<FollowRig>; // createEngine({ view, … }) without orbitControls

const world = new CollisionWorld({ heightAt: groundAt });
for (const h of houses) world.addPrism(h.outline, h.minY, h.maxY);
const walker = new Walker(world, { runSpeed: 5 });
walker.teleport(0, groundAt(0, 0), 0);

const rig = new FollowRig({ pivotHeight: 1.5, minDistance: 0, maxDistance: 10 }, { clearance: (ox, oy, oz, dx, dy, dz, max) => world.clearance(ox, oy, oz, dx, dy, dz, max, 0.25) });
const engine = makeEngine(rig);
const input = bindWalkInput(engine.canvas, rig, { onChange: () => engine.invalidate() });

const state: WalkInputState = { forward: 0, right: 0, run: false, jump: false };
const intent = newWalkIntent();
const fw = [0, 0, 0];
const at = [0, 0, 0];
let moving = false;
engine.onInput(() => {
  input.read(state);
  rig.forward(fw);
  intent.moveX = fw[0]! * state.forward - fw[2]! * state.right;
  intent.moveZ = fw[2]! * state.forward + fw[0]! * state.right;
  intent.run = state.run;
  intent.jump = state.jump;
  walker.advance(engine.frameSeconds, intent);
  moving = state.forward !== 0 || state.right !== 0 || !walker.grounded;
});
engine.onExtract(() => {
  walker.renderPosition(at);
  rig.follow(at[0]!, at[1]!, at[2]!);
  rig.update(engine.frameSeconds);
  // draw the figure at `at`, turned by walker.renderYaw(); its stride from walker.renderTravelled()
});
engine.animateWhile(() => moving || input.gamepadConnected);
```

**Example.** `walk` (a test course with steps, slopes, pillars and a figure), `outpost` (a walker steered along a
route inside the simulation).

**Pitfalls.**

- The walker is in fixed steps (60 Hz by default); always draw `renderPosition`, never `position`.
- `FollowRig` is flat-world only and has no render origin: keep the walking area within a few kilometres of the
  world origin ([Walking](walking.md), [`FollowRig`](cameras.md#followrig)).
- Solids are upright prisms, cylinders and boxes; a mesh becomes one through `addMeshSolid`
  ([Solids from a mesh](walking.md#solids-from-a-mesh)). Draw them with `collisionLines` to check.
- The engine has no figure of its own: build it with `motion` (skeleton, poses, `MotionGraph`) or as a rig
  ([Motion](motion.md), [Rigs](rigs.md)); the examples' figures are example code.
- With a simulation, put the walker in it (`walker.simState(name)`, step it in a system) so replays and saves hold
  ([Saving and restoring](walking.md#saving-and-restoring)).

## Things you can kick or break

**Goal.** Structures that crack, breach and collapse part by part where they are hit, with rubble and falling
pieces; small things that fly off when kicked.

**Modules.** `sim/destruction` (`compileStructure`, `destructionEvent`, `applyEventToAll`, `raycastParts`,
`rubbleFootprints`, `encodeStates`), `gen-arch` (`buildBuildingMesh` with `describe` and `states`, `buildRubbleMesh`,
`fallPieces`), `render` (`TransientLayer`), `core` (`BallisticTrack`, `trackPose`).

<!-- check: wrap -->
```ts
import type { Ray, StructureState } from 'wallhammer-web/base';
import { buildBuildingMesh, buildRubbleMesh, rubbleColours, structureMaterial } from 'wallhammer-web/gen-arch';
import type { ArchDims, BuildingSpec } from 'wallhammer-web/gen-arch';
import { MeshLayer } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
import { applyEventToAll, compileStructure, destructionEvent, encodeStates, raycastParts, rubbleFootprints } from 'wallhammer-web/sim/destruction';
declare const engine: Engine;
declare const specs: BuildingSpec[]; // from the previous recipe
declare const DIMS: ArchDims;
declare function groundAt(x: number, z: number): number;

const descs = buildBuildingMesh(specs, [], groundAt, DIMS, { describe: true }).structures;
const compiled = descs.map((d) => compileStructure(d));
const material = engine.renderer.material(structureMaterial(DIMS, { damage: true }));
const houses = new MeshLayer({ material });
const rubble = new MeshLayer({ material });
engine.add(houses);
engine.add(rubble);
let states = new Map<number, StructureState>();
let tick = 0;

function rebuild(): void {
  houses.mesh = engine.renderer.createMesh(buildBuildingMesh(specs, [], groundAt, DIMS, { states }).mesh, material);
  const footprints = compiled.flatMap((s) => (states.has(s.desc.id) ? rubbleFootprints(s, states.get(s.desc.id)!) : []));
  rubble.mesh = engine.renderer.createMesh(buildRubbleMesh(footprints, rubbleColours(specs), groundAt), material);
  engine.invalidate(); // delete the old meshes with engine.device.deleteMesh in real code
}

/** A hit under a screen ray: the event seed comes from the tick, so the same hits give the same ruin. */
function hit(ray: Ray, radiusM: number, energy: number): void {
  const at = raycastParts(descs, ray.origin, ray.dir);
  if (!at) return;
  const ev = destructionEvent({ position: at.point, radius: radiusM, energy, seed: 0xd357 + tick, tick });
  tick++;
  const res = applyEventToAll(compiled, states, ev);
  if (res.changes.length === 0) return;
  states = res.states;
  rebuild();
  history.replaceState(null, '', `#d=${encodeStates(states.values())}`); // the state as text: a link reproduces it
}
```

A kicked small thing (a crate, a stone) is a `BallisticTrack` of `core`: a start time, a position, a velocity, a spin
and a landing height. `trackPose(track, now)` gives its pose at any clock time, so pausing or scrubbing shows the same
flight; write it into an `InstanceSet` record each frame (next recipe). Falling parts of a collapse use the same
tracks through `fallPieces` and `TransientLayer`.

**Example.** `destruction` (click to blast, `[` `]` radius, `-` `=` energy, `Z` undo; the falling pieces and the
debris).

**Pitfalls.**

- Damage is in a structure's state, the mesh is regenerated from (recipe, seed, state); never edit the mesh.
- Descriptions are integer centimetres; `destructionEvent` converts from metres.
- With a simulation, make every hit a command and the states simulation state; then replay and seeking work
  ([Feeding events from the simulation](destruction.md#feeding-events-from-the-simulation)).
- In a streamed world keep the states by home cell (`CellStates`) and refresh the cells that draw them
  ([State in streamed cells](destruction.md#state-in-streamed-cells)).
- There is no rigid-body physics: a ballistic track flies, lands and crumbles away; it does not bounce, roll, rest or
  hit walls.

## Vehicles and people on schedules

**Goal.** A bus on a loop that dwells at its stops; people who walk to places at given times, stay, ride and walk on;
all of it deterministic, the same at any frame rate and seekable.

**Modules.** `sim` (`Simulation`, `Movers`, `POSE_STRIDE`, `NavGraph`, `Agendas`), `render` (`instanceSet`,
`writeInstance`, `InstanceSetLayer`), `base` (`mat34RotationY`), `runtime` (`createEngine({ sim })`, `onExtract`).

A vehicle on a looped path with one stop, drawn as instance records written from the simulation each frame:

<!-- check: wrap -->
```ts
import { mat34RotationY } from 'wallhammer-web/base';
import type { InstanceSet } from 'wallhammer-web/render';
import { writeInstance } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
import { Movers, POSE_STRIDE } from 'wallhammer-web/sim';
declare const engine: Engine; // createEngine({ sim: { seed: 'my-world', hz: 20 }, … })
declare const buses: InstanceSet; // instanceSet(busMesh, 8) in an InstanceSetLayer, see the recipe below
declare function groundAt(x: number, z: number): number;

const sim = engine.sim;
const movers = new Movers('buses', { hz: sim.hz, collision: 'none', width: 2.5 });
const route = movers.paths.add({ points: [0, 0, 200, 0, 200, 120, 0, 120], loop: true, stops: [{ vertex: 2, dwell: 20 }] });
movers.spawn({ path: route, at: 0, cruise: 9, accel: 1, decel: 1.5 });
movers.spawn({ path: route, at: 320, cruise: 9, accel: 1, decel: 1.5 });
sim.addState(movers);
sim.addSystem('buses', movers.system);

const pose = new Float32Array(16 * POSE_STRIDE);
const m = new Float32Array(12);
engine.onExtract((alpha) => {
  const n = movers.extractPose(alpha, pose); // x, z, direction x, direction z, metres along, speed, turn rate, state
  for (let i = 0; i < n; i++) {
    const o = i * POSE_STRIDE;
    const x = pose[o]!;
    const z = pose[o + 1]!;
    mat34RotationY(Math.atan2(pose[o + 2]!, pose[o + 3]!), m); // the mesh's +z turned to the direction of travel
    m[9] = x;
    m[10] = groundAt(x, z);
    m[11] = z;
    writeInstance(buses, i, m, 0.8, 0.2, 0.15); // the last numbers reach the shader as i_extra
  }
  buses.count = n;
  buses.dirty = true;
});
```

People with a day of activities are `Agendas` over a `NavGraph`: places, times and stays, with app states for waiting
and riding. [Agendas and states](simulation.md#agendas-and-states) has the small case,
[Drive entities with agendas](recipes.md#drive-entities-with-agendas) the ride, and
[Draw moving copies with instance sets](recipes.md#draw-moving-copies-with-instance-sets) the material the set needs.
Many animated figures are better drawn as rigs ([Rigs](rigs.md)); one figure on a skeleton is `motion`
([Motion](motion.md)). A scripted camera along keyframes (a fly-by, a cut scene) is `FreePath`
([Free paths](cameras.md#free-paths)).

**Example.** `outpost` (`src/life/life.ts`: a rover on a loop with a dwell, an astronaut steered along a route, both in
the simulation; `src/life/rover.ts` writes the records), `rivers` (walkers on footpaths), `minimal-3d` (`src/life.ts`).

**Pitfalls.**

- Movement is read only in `onExtract(alpha)`, interpolated between ticks; the simulation never reads the image.
- Positions inside `sim` are integer millimetres and ticks; metres and seconds only at the edges (`spawn`, extraction).
- Add every entity before the first tick; keep outcome-relevant state in the simulation, or `seek` and snapshots break.
- An `InstanceSetLayer` does not cull; keep sets few (one draw per set and pass). Thousands of still copies over a large
  area belong in `InstancedLayer` or `InstanceCellLayer`.
- A clock that jumps (a time slider) is a rebase and a warm-up, not a fast simulation
  ([A clock that jumps](simulation.md#a-clock-that-jumps)).

## Your own place data

**Goal.** A real or designed place (a map, footprints of houses, roads, stops, timetables) in your game, without
putting any of it into the engine.

**Modules.** Whatever draws it: `gen-arch` for footprints, `gen-mesh` strips for roads and paths, `gen-ground` for
surface classes, `sim` agendas for people, the streaming generator for large areas.

1. **Prepare once, offline.** A script in your project reads the source (GIS export, your editor) and writes a
   compact file: local metres from an origin you choose, y up, stable ids from the source, and `notes` on what was
   assumed. The engine never parses files or projections.
2. **Keep it in your project** (`data/`, `public/`), loaded with `fetch` at start, or bundled.
3. **Map it to engine data** with small pure functions: footprint → `BuildingSpec`
   ([Houses from footprints](#houses-from-footprints)), road centre line → `stripMesh` or `buildGroundMarkings`
   ([Strips along a surface](generators.md#strips-along-a-surface)), land use → a class raster for `groundBake`,
   stops and doors → `AgendaPlace`s ([Feed agendas from external data](recipes.md#feed-agendas-from-external-data)).
4. **For a streamed area** give the generator an index from tile to features (made once, sent to every worker with
   `provider.pool.broadcast(index)` before the first cell), so a cell asks only what passes through it. The cell
   stays a pure function of (seed, cell, data).

<!-- check: wrap -->
```ts
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { WorkerCellProvider } from 'wallhammer-web/runtime';
declare const cellWorkerUrl: string;
/** The project's prepared data: footprints and roads by tile of 256 m, ids from the source. */
declare const index: { tileM: number; tiles: Record<string, { houses: number[]; roads: number[] }> };

const provider = new WorkerCellProvider(cellWorkerUrl, 7);
await provider.pool.broadcast({ kind: 'place-index', index }); // every worker has it before any cell job
```

**Example.** `destruction` (`src/scene.ts`: outlines and recipes as data, turned into specs); the files of a
real place belong to your project, not to an example.

**Pitfalls.**

- Ids from the source, never from array order; a stable id gives the same house the same random details.
- Project geographic coordinates to local metres once, in the preparation script; floats far from the origin lose
  centimetres ([A world that loads only around the player](#a-world-that-loads-only-around-the-player) keeps cells
  relative to their origin).
- Snap points to your own graph in the app and record how far each moved.
- Keep a synthetic fallback for when the file is missing, so the game still runs.
- Licences of map data are your project's concern; nothing of it goes into the engine or its issues.

## Performance and budgets

**Goal.** Know where the frame time goes and keep memory and work within limits you set.

**Modules.** `tools` (`profileFrame`, `formatProfile`), `render` (`renderer.lastStats`), `gpu` (`device.memory()`),
`runtime` (`StreamedWorld.stats()`, `maxPixelRatio`), `world` (`StreamingConfig` budgets).

<!-- check: wrap -->
```ts
import type { FreeRig } from 'wallhammer-web/camera';
import type { Engine, StreamedWorld } from 'wallhammer-web/runtime';
import { formatProfile, profileFrame } from 'wallhammer-web/tools';
declare const engine: Engine<FreeRig>;
declare const world: StreamedWorld;

// Per layer and pass on the GPU at hand; the page blocks while it measures.
const profile = profileFrame(engine.renderer, engine.view, { frames: 20 });
console.log(formatProfile(profile));
// Cheap numbers every frame.
const s = engine.renderer.lastStats; // triangles, draw calls, shadow triangles, CPU ms
const w = world.stats(); // cells drawn, uploads and their ms, generate ms, instances
const gpu = engine.device.memory(); // buffers, textures, targets, total bytes
console.log(s?.drawCalls, w.cellsVisible, w.uploadMs, gpu.total);
```

The knobs:

| Where | Knob | What it bounds |
| --- | --- | --- |
| `createEngine` | `maxPixelRatio` | Pixels drawn on a high-density screen (often the biggest win). |
| `StreamingConfig` | `memoryBudgetBytes`, `maxInFlight`, `screenError.maxCells` | Cells kept, jobs at once, cells drawn. |
| `StreamedWorld` | `uploadMsPerFrame`, `blockingMsPerFrame`, `gpuCeilingBytes` | Upload time per frame, main-thread generation, GPU memory of the page. |
| `ArchDims` | `fieldRoofMaxTriangles` | Triangles of irregular roofs. |
| `TransientLayer` | `maxPieces` | Falling pieces in flight. |
| `env.day`, `env.time` | `pause()` | A still scene costs nothing between frames; a running day redraws shadows. |

**Example.** `fantasy-village` (`__wh.profileText()` in the console), `endless` (the overlay shows `world.stats()`).

**Pitfalls.**

- Numbers from a software renderer (headless Chrome in a container) say nothing about a real GPU; profile in a
  browser on the machine in question.
- A layer cost below `spreadMs` is noise.
- Each `InstanceSetLayer` set and each `MeshLayer` is a draw call per pass; merge static meshes, use instanced layers
  for many copies.
- Keep main-thread generation slices short (generators that yield, as `plantTreesSteps`); move cell generation to
  workers.
- Allocation per frame shows as hitches: reuse `out` arrays (`renderPosition(out)`, `extractPose(alpha, out)`).

## Debugging with marks

**Goal.** Point at what looks wrong in a generated world, keep the exact view and a picture, and let an agent work
through the list.

**Modules.** `marks-store` (`marksStore`, a Vite dev-server plugin), `runtime` (`installEngineMarking`, `heightPick`,
`collisionPick`, `gapPick`), the command line `wallhammer-marks`.

<!-- check: wrap -->
```ts
import type { FreeRig } from 'wallhammer-web/camera';
import { heightPick, installEngineMarking } from 'wallhammer-web/runtime';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine<FreeRig>;
declare function heightAt(x: number, z: number): number;
declare const DEV: boolean; // import.meta.env.DEV in a Vite page

// In vite.config.ts: plugins: [marksStore()] from 'wallhammer-web/marks-store'. Only in the dev server:
if (DEV) installEngineMarking(engine, { pick: heightPick(heightAt) });
```

Press N in the page, click the fault, type a note, Enter. Then from a shell, with the dev server running:

```sh
npx wallhammer-marks list --open                       # the open marks, their pictures under .marks/
npx wallhammer-marks set m0001 --status working --by agent --text "what I am changing"
npx wallhammer-marks set m0001 --status fixed --by agent --text "what changed" --after after.png
```

**Example.** `endless` (`#cam=free`, a `FreeRig` over a height function), `walk` (a `FollowRig` over a collision
world, `placeTarget` puts the walker back), `planet` (a host of its own).

**Pitfalls.**

- The pick sees only its surface (a height function, a collision world): a mark on a tree or a cloud stores the ground
  behind it; the note and the picture say what was meant.
- `fixed` needs an after-picture of the same view (open the mark's link from `list --md`); the developer sets
  `accepted` or `reopened`, never the agent.
- Add `.marks/` to `.gitignore`. The page's view hash holds the camera, hour and animation time; state your page
  keeps elsewhere (a toggled layer, a seed) belongs in the `hash` option.

All of it: [Marks](marks.md).
