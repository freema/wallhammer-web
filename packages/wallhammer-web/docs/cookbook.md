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
- On a sphere, steep walls of patch cells show a saw where every quad is cut the same way: `split: 'shorter'` in the
  patch options picks the shorter diagonal per quad ([A sphere world](streaming.md#a-sphere-world)). A category of your
  own per vertex travels in the patch's extra channel (`coarseExtra: 'nearest'` keeps it a category between levels),
  which the ground's shaders read with `extra` ([The ground of a sphere from patch cells](rendering.md#the-ground-of-a-sphere-from-patch-cells)).
- The instances of streamed cells (trees, rocks) are not solid by themselves: `InstanceSolid` per archetype,
  `SolidIndex` fed by `streamSolids` and `SolidFeed` make them solids of a collision world, and `index.within(point,
  radius, visit)` answers what stands near a point ([Solids of streamed cells](walking.md#solids-of-streamed-cells)).

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

**Example.** `movement` (a test course with steps, slopes, pillars and a figure), `outpost` (a walker steered along a
route inside the simulation).

**Pitfalls.**

- The walker is in fixed steps (60 Hz by default); always draw `renderPosition`, never `position`.
- For a body with weight set `deceleration`, `runAcceleration` and `turnSpeedAtRun` (all off by default) and switch sets
  with `walker.retune` ([Momentum](walking.md#momentum)); a ponytail or a tail that swings behind is a `ChainLag`
  applied after the figure's other post steps ([A chain that lags behind](motion.md#a-chain-that-lags-behind)).
- `FollowRig` is flat-world only and has no render origin: keep the walking area within a few kilometres of the
  world origin ([Walking](walking.md), [`FollowRig`](cameras.md#followrig)). On a planet, `ChartWalker` runs the same
  `CollisionWorld` and `Walker` in a moving local chart (`SurfaceChart`) and `ChartFollowView` shows the `FollowRig` in
  world space with a render origin ([Walking on a sphere](walking.md#walking-on-a-sphere),
  [`ChartFollowView`](cameras.md#on-a-sphere-chartfollowview); the `planet` example, key `G`).
- Trees and rocks of streamed cells stop the walker only as solids: [Solids of streamed
  cells](walking.md#solids-of-streamed-cells).
- Solids are upright prisms, cylinders and boxes; a mesh becomes one through `addMeshSolid`
  ([Solids from a mesh](walking.md#solids-from-a-mesh)). Draw them with `collisionLines` to check.
- The engine has no figure of its own: build it with `motion` (skeleton, poses, `MotionGraph`) or as a rig
  ([Motion](motion.md), [Rigs](rigs.md)); the examples' figures are example code. Feet on a slope: `fitToGround` with
  `align`; a hand that reaches, a head that looks, a thing held: `TwoBoneReach`, `ChainAim`, `SocketBlend`, eased by
  `WeightFade` ([Reaching, aiming and holding over time](motion.md#reaching-aiming-and-holding-over-time)).
- A close view of a figure wants short, sharp shadows, a view over land long ones: `renderer.setShadowFit({ softnessM,
  distanceM })` changes them while running, `renderer.shadowFit` reads them to put them back ([Shadows](rendering.md#shadows)).
- With a simulation, put the walker in it (`walker.simState(name)`, step it in a system) so replays and saves hold
  ([Saving and restoring](walking.md#saving-and-restoring)).
- A body that slows on a climb: [next recipe](#a-walker-that-slows-uphill).

## A walker that slows uphill

**Goal.** A body that walks slower up a slope or a flight of stairs, a little faster down a gentle one and carefully
down a steep one, instead of keeping its flat speed everywhere.

**Modules.** `world` (`Walker`, the `WalkerSetup` options `uphillSpeedLoss`, `downhillSpeedGain`, `downhillSpeedLoss`,
`slopeSpeedFloor`; `retune`).

<!-- check: wrap -->
```ts
import { CollisionWorld, Walker } from 'wallhammer-web/world';
declare function groundAt(x: number, z: number): number;

const world = new CollisionWorld({ heightAt: groundAt });
// A person: 31 % slower up 20°, fastest down 8°, slower again down steep ground, never below 35 % of the flat speed.
const person = new Walker(world, { walkSpeed: 1.4, runSpeed: 4.6, uphillSpeedLoss: 0.85, downhillSpeedGain: 0.5, downhillSpeedLoss: 1.8, slopeSpeedFloor: 0.35 });
// A four-legged body loses less on a climb and takes steep descents with care.
const beast = new Walker(world, { radius: 0.55, height: 2.2, uphillSpeedLoss: 0.5, downhillSpeedGain: 0.3, downhillSpeedLoss: 1.2, slopeSpeedFloor: 0.4 });
// Carrying a load: the climb costs more; the state (and the eased grade) is kept.
person.retune({ uphillSpeedLoss: 1.2 });
void beast;
```

**Example.** `movement` (the default movement profile of `examples/shared/src/figures/profiles.ts` has these numbers,
the steed of `src/ride.ts` its own; the course has a 20° ramp and stairs).

**Pitfalls.**

- All three rates are 0 by default: the walker keeps its flat speed and never probes the grade. The numbers are the
  game's; the engine has no "realistic" set.
- Only the wanted speed is scaled, so `acceleration` and `deceleration` ease the change, and nothing changes in the
  air. A stride animation read from `renderTravelled` and a speed from `lastStepDistance` follow by themselves.
- A slope steeper than `maxSlopeDeg` is not slowed but slid down (`steep`); the floor keeps a body from stalling on
  any slope it may stand on.
- Stairs read as their mean slope; a ledge or a wall is one step, not a slope. The probe costs eight `groundAt` calls
  a step while a rate is on ([Slopes and speed](walking.md#slopes-and-speed)).

## A body on wheels

**Goal.** A cart, a car or a hauler on wheels driven over the same collision world the walker uses, in fixed steps
and drawn smoothly between them; parked bodies that hold still and block walkers; bodies that push each other apart.

**Modules.** `world` (`WheeledBody`, `fourWheels`, `WheeledGroup`, `newWheeledIntent`; `CollisionWorld`),
`render` (`writeInstance` into an `InstanceSet`), `runtime` (`onInput`, `onExtract`, `animateWhile`).

<!-- check: wrap -->
```ts
import type { InstanceSet } from 'wallhammer-web/render';
import { writeInstance } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
import { CollisionWorld, WheeledBody, WheeledGroup, fourWheels, newWheeledIntent } from 'wallhammer-web/world';
import type { WheeledIntent } from 'wallhammer-web/world';
declare const engine: Engine;
declare const world: CollisionWorld; // the walker's world: the ground and the solids
declare const hulls: InstanceSet; // one record per body: a hull mesh modelled round the centre of mass, −z forward
declare const wheels: InstanceSet; // four records per body: a wheel modelled round its centre, the axle along x
declare const keys: { up: boolean; down: boolean; left: boolean; right: boolean; space: boolean };

// Places: x, z and the heading (radians, 0 faces −z).
const places: [number, number, number][] = [[0, 0, 0], [6, -10, Math.PI / 2]];
const bodies = places.map(([x, z, yaw]) => {
  const b = new WheeledBody(world, { mass: 1100, wheels: fourWheels({ drive: 'all' }) });
  b.teleport(x, world.groundAt(x, z, 1e4, 0) + b.restHeight, z, yaw);
  b.syncObstacle(); // a box in the world that walkers meet
  return b;
});
const group = new WheeledGroup(bodies); // steps them together, then pushes touching pairs apart
const drive = newWheeledIntent();
const parked = newWheeledIntent();
parked.handbrake = true;
const intents: WheeledIntent[] = bodies.map(() => parked);
let driven = 0; // the game's: the body the player drives, −1 none

engine.onInput(() => {
  drive.throttle = (keys.up ? 1 : 0) - (keys.down ? 1 : 0); // backward brakes, then reverses
  drive.steer = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  drive.handbrake = keys.space;
  for (let i = 0; i < bodies.length; i++) intents[i] = i === driven ? drive : parked;
  if (group.advance(engine.frameSeconds, intents) > 0) for (const b of bodies) b.syncObstacle();
});

const m = new Float64Array(12);
engine.onExtract(() => {
  const a = group.alpha; // the group's share of the way to the next step, not the bodies' own
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    writeInstance(hulls, i, b.renderMatrix(m, a));
    for (let w = 0; w < b.wheels.length; w++) writeInstance(wheels, i * 4 + w, b.wheelMatrix(w, m, a));
  }
  hulls.count = bodies.length;
  wheels.count = bodies.length * 4;
  hulls.dirty = wheels.dirty = true;
});
engine.animateWhile(() => bodies.some((b) => !b.asleep));
```

The numbers of the body (drive, brakes, tyres, steering, springs) and what each wheel reports (slip for tyre marks
and sound, load, contact): [Wheeled body](wheeled.md). The camera: [A follow camera for a carried or driven
body](#a-follow-camera-for-a-carried-or-driven-body).

**Example.** `movement` (two compact cars in a `WheeledGroup`: `src/car.ts` the stepping, getting in and out and the
tyre marks, `src/car-view.ts` the drawing; E at the driver's door, `#drive=0` starts in a car).

**Pitfalls.**

- Bodies in a group are stepped by the group: draw them with `group.alpha`. Their own `alpha` (the default of
  `renderMatrix`) does not advance; it does only for a body stepped by its own `advance`.
- Change the intent only between steps (in `onInput`, before `advance`), or the same keys at another frame rate give
  another path.
- A walker meets a body only through its obstacle box: call `syncObstacle()` after the steps for every body that may
  have moved (a parked body that nothing pushes needs it once; `src/car.ts` skips the asleep ones). A body outside a group passes through other bodies unless the game calls `collideWheeledBodies(a, b)`
  after both took the same step.
- A sleeping body is not woken by a solid moved into its hull: call `wake()`.
- Flat worlds only: no chart form for a sphere yet ([Limits](wheeled.md#limits)).
- Getting in and out is a seat timeline ([A body carried by another](#a-body-carried-by-another)): `SeatTransition` with the
  seat an upright transform at the body's heading, a free side from `world.firstStandSpot`. What happens at the rate
  of the steps (a seat freed, a script's moment) goes in the group's hook, `group.advance(dt, intents, afterStep)`.
- What the engine does not do is the game's: the door, the side offered, the mesh (the example's compact car is example code,
  `examples/shared/src/vehicles/`), lamps, sound, tyre marks from `wheels[i].slip`, putting an overturned body back
  (`reset()`). On getting out, put the figure's walker beside the door at the start, not at the end (the pitfall of
  [A body carried by another](#a-body-carried-by-another)).

## A body that crawls and glides

**Goal.** A glider, a flying animal or a hang-glider that crawls on the ground, leaps off, glides with height and speed
traded honestly, banks into turns, beats to climb, flares and touches down, without passing through the ground or a
solid; in fixed steps and drawn smoothly between them.

**Modules.** `world` (`FlyingBody`, `newFlyingIntent`; `CollisionWorld`), `runtime` (`onInput`, `onExtract`),
`render` (`writeInstance`).

<!-- check: wrap -->
```ts
import type { InstanceSet } from 'wallhammer-web/render';
import { writeInstance } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
import { CollisionWorld, FlyingBody, newFlyingIntent } from 'wallhammer-web/world';
declare const engine: Engine;
declare const world: CollisionWorld; // the walker's world: the ground and the solids
declare const bodies: InstanceSet; // one record: the body's mesh, −z forward, its origin under the middle
declare const keys: { up: boolean; down: boolean; left: boolean; right: boolean; space: boolean; shift: boolean };
declare const leapPressed: () => boolean; // true once per press of the leap key

const body = new FlyingBody(world, {
  hull: [0, 0.6, 0, 0.45, -1.6, 0.8, 0, 0.35, 1.6, 0.8, 0, 0.35],
  groundHull: [0, 0.6, 0, 0.45],
  groundSpeed: 2.3,
  trimSpeed: 11, // a level glide at 11 m/s
  glideRatio: 9, // 9 m forward per metre down
  stallSpeed: 7.5,
});
body.teleport(0, world.groundAt(0, 0, 1e4, 0), 0, 0);
const intent = newFlyingIntent();

engine.onInput(() => {
  const air = !body.grounded;
  const fwd = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  intent.forward = air ? 0 : fwd; // crawl
  intent.pitch = air ? -fwd : 0; // forward puts the nose down
  intent.turn = (keys.right ? 1 : 0) - (keys.left ? 1 : 0); // turn on the ground, bank in the air
  intent.beat = keys.space ? 1 : 0;
  intent.brake = air && keys.shift ? 1 : 0; // flare
  intent.takeOff ||= !air && leapPressed();
  body.advance(engine.frameSeconds, intent);
  intent.takeOff = false;
});

const m = new Float64Array(12);
engine.onExtract(() => {
  writeInstance(bodies, 0, body.renderMatrix(m, body.alpha));
  bodies.count = 1;
  bodies.dirty = true;
});
```

The polar, the stall, the beats, the flare and the contacts: [Flying body](flying.md). The camera: [A follow camera for
a carried or driven body](#a-follow-camera-for-a-carried-or-driven-body), with the boom grown by the height.

**Example.** `movement` (the glider: `src/glide.ts` the body's numbers, the paws stepped by `StepCycle` on the ground,
the wings posed from `renderBeatPhase` and `renderBank` in the air, getting on and off; E behind its left wing,
`#glide=1` starts on it).

**Pitfalls.**

- The attitude (`pitch`, `bank`) is drawn, not simulated: the body is a point mass with a heading. Pose the wings and
  the tilt from `renderPitch`, `renderBank` and `renderBeatPhase`, not from the velocity.
- `takeOff` is a single step's request: set it on the key's press and clear it after `advance`, or a held key leaps
  again at every touch-down.
- A glide loses height: without beats or a dive the speed falls toward the stall. Measure what the numbers give (the
  sink rate, a turn's radius, the leap) in a headless script of fixed steps, as `pnpm check:walk` does.
- Flat worlds only, and one body: two flying bodies pass through each other ([Limits](flying.md#limits)).
- Riding it is a seat timeline ([the next recipe](#a-body-carried-by-another)); let the rider off only while it is
  grounded and nearly still.

## A body carried by another

**Goal.** A figure that gets on a steed (or into a seat on any moving body), rides with its hands on the grips and its
feet in the stirrups, and gets off again on a free side, all eased, with no jump in the pose or the camera.

**Modules.** `motion` (`SeatTransition`, `headingRoot`, `TwoBoneReach` with `setTargetSocket` and `useEndRotation`,
`WeightFade`, `blendPose`, `solvePose`), `world` (a `Walker` for each body, `attachFromWalker`, `releaseToWalker`,
`CollisionWorld.firstStandSpot`).

The carrier is solved first, all of it; the carried body's root comes from the carrier's bones, blended with its free
root by the seat's weight; then its reaches. `SeatTransition` is the timeline (approach, getting on, held, getting off)
and owns the seat; the game gives its numbers and hangs its cues on times of it. The order and the parts:
[A body carried by another](motion.md#a-body-carried-by-another) and [Getting on and off: a seat
timeline](motion.md#getting-on-and-off-a-seat-timeline).

<!-- check: wrap -->
```ts
import { SeatTransition, TwoBoneReach, WeightFade, blendPose, headingRoot, solvePose } from 'wallhammer-web/motion';
import type { MotionGraph, Pose, Skeleton, Socket, TwoBoneChain } from 'wallhammer-web/motion';
import { attachFromWalker, releaseToWalker } from 'wallhammer-web/world';
import type { CollisionWorld, StandSpotOptions, Walker } from 'wallhammer-web/world';
declare const world: CollisionWorld;
declare const carrierWalker: Walker; // the carrier's own walker: the game steers it while the figure rides
declare const carrierWorld: Float64Array; // the carrier's solved bones this frame, after all its own steps
declare const seatSocket: Socket; // on the carrier's back: the carried root's place and turn
declare const seatY: number; // the seat's height over the carrier's feet
declare const grips: readonly Socket[]; // where the hands hold on
declare const arms: readonly TwoBoneChain[]; // of the carried figure
declare const figure: { skeleton: Skeleton; pose: Pose; world: Float64Array; own: MotionGraph; riding: MotionGraph; ridingPose: Pose };
declare const walker: Walker; // the figure's own walker: not advanced while it rides

const MOUNT_S = 0.95;
const seat = new SeatTransition({
  tilt: 0.45, // a share of the saddle's tilt: upright on slopes, some sway at a gallop
  attach: { seconds: MOUNT_S + 0.15, weightSeconds: 0.78 * MOUNT_S, rise: 0.85, riseTo: 0.45 * MOUNT_S },
  release: { seconds: 1, weightFrom: 0.12, weightSeconds: 0.75, rise: 0.85, riseFrom: 0.3, riseTo: 0.8 },
});
const body: StandSpotOptions = { radius: 0.3, height: 1.7, maxStepUp: 0.35 };
const ridingWeight = new WeightFade(0); // the riding graph over the figure's own
const hands = arms.map((a) => new TwoBoneReach(a, { soft: 0.995 }));
for (const h of hands) h.useEndRotation = true; // the hand turned as the grip
const stand = new Float64Array(4); // x, ground y, z, yaw beside the carrier now
const place = new Float64Array(4);
const at = new Float64Array(3);
const free = new Float64Array(12);
const root = new Float64Array(12);

/** The place beside the carrier, `side` 1 left or −1 right, `out` metres from its middle. */
function beside(side: number, out: number, o: Float64Array, i = 0): void {
  const p = carrierWalker.position, yaw = carrierWalker.yaw;
  o[i] = p[0]! + Math.cos(yaw) * side * out;
  o[i + 1] = p[2]! - Math.sin(yaw) * side * out;
}
let side = 1;

function getOn(): void {
  attachFromWalker(seat, walker, 0.4); // walks 0.4 s from where it stands to the place beside the carrier
}

function getOff(): boolean {
  // The first free side, left before right: from 0.6 m out on the carrier's side to 1.05 m out.
  const spots = new Float64Array(8);
  for (let k = 0; k < 2; k++) (beside(k ? -1 : 1, 0.6, spots, k * 4), beside(k ? -1 : 1, 1.05, spots, k * 4 + 2));
  const p = carrierWalker.position;
  const k = world.firstStandSpot(spots, p[1]!, body, at);
  if (k < 0) return false; // no room: stay on
  side = k ? -1 : 1;
  for (const h of hands) h.off(0.25);
  figure.riding.trigger('dismount');
  // Now, at the start: the walker goes where the figure will stand, so everything that blends from the seat to the
  // free root (the root, the camera) moves toward that place, never back to where the figure got on.
  return releaseToWalker(seat, walker, at[0]!, at[1]!, at[2]!, carrierWalker.yaw);
}

function frame(dt: number): void {
  seat.advance(dt);
  const A = seat.approachSeconds;
  if (seat.gettingOn && seat.crossed(A)) {
    figure.riding.trigger('mount'); // once, as the climb starts
    ridingWeight.to(1, 0.2);
  }
  if (seat.gettingOn && seat.crossed(A + 0.2 * MOUNT_S)) for (const h of hands) h.on(0.4);
  if (seat.became('free')) ridingWeight.to(0, 0.3); // down: back to its own motion
  ridingWeight.update(dt);
  for (const h of hands) h.update(dt);
  figure.own.update(dt);
  figure.riding.update(dt);
  // Where it stands beside the carrier now: the climb's place, or the walker's once it is off.
  if (seat.phase === 'release' || seat.phase === 'free') {
    walker.renderPosition(at);
    (stand[0] = at[0]!), (stand[1] = at[1]!), (stand[2] = at[2]!), (stand[3] = walker.renderYaw());
  } else {
    beside(side, 1.05, stand);
    (stand[2] = stand[1]!), (stand[1] = carrierWalker.position[1]!), (stand[3] = carrierWalker.yaw);
  }
  seat.place(stand, seatY, place);
  headingRoot(place[0]!, place[1]!, place[2]!, place[3]!, 1, free);
  figure.own.evaluate(figure.pose);
  figure.riding.evaluate(figure.ridingPose);
  blendPose(figure.pose, figure.pose, figure.ridingPose, ridingWeight.value);
  seat.write(free, carrierWorld, seatSocket, root);
  solvePose(figure.skeleton, figure.pose, root, figure.world);
  for (let i = 0; i < hands.length; i++) {
    hands[i]!.setTargetSocket(carrierWorld, grips[i]!);
    hands[i]!.apply(figure.skeleton, figure.pose, root, figure.world);
  }
}
```

**Example.** `movement`: one mechanism, two configurations. `src/ride.ts` (`RIDE_SEAT`: E beside the steed; the
steed's own walker, the seat on the saddle, the hands on the grips and the feet in the stirrups with their poles at
times of the timeline, a free side from `firstStandSpot`; `#ride=1` starts in the saddle) and `src/car.ts` (`CAR_SEAT`:
the seat an upright transform at the car's heading used as a one-bone carrier, the doors at times of the timeline).

**Pitfalls.**

- **Put the figure's walker at the place it will stand at the start of getting off, not at the end.** Its free root,
  and everything that follows the walker (the camera's point, a shadow, a name tag), blends from the seat toward that
  root while the seat's weight falls; a walker still where the figure got on pulls all of them back there for the whole
  climb down. `releaseToWalker` does both at once; the movement example had exactly this bug before it.
- A free root that goes straight from the ground to the seat passes through the carrier: give the timeline a `rise`
  that ends before the weight's move on the way on (`riseTo`) and starts after it on the way off (`riseFrom`).
- Cues at times: `crossed(t)` fires once (a graph's trigger, a sound), `passed(t)` holds from then on (a reach's `on`
  with its own fade). Guard them with `gettingOn` or `gettingOff`: both phases count their seconds from 0.
- The carried figure's walker is parked while it rides (not advanced, or with an empty intent) and is not a solid the
  carrier's walker meets; the input steers the carrier's walker.
- Both bodies must be solved in the same frame (on a sphere the same chart), the carrier first.
- `tilt` 1 carries the root rigidly (it rocks with every step of the carrier); less keeps the trunk upright
  (`uprightTransform`) while the hands and feet, held by the reaches, still follow.
- What the engine does not do is the game's: the climb's motions (sources of the figure's graph), the numbers of the
  timeline, the cues, the sides offered, the steering.

## Legs that step

**Goal.** A body with four (or six, or two) legs whose ends are put down on the ground and stay there until lifted,
with patterns that change with speed (a walk, a trot, a gallop), a trunk lowered and tilted with the ground under
them.

**Modules.** `motion` (`StepCycle`, `StepPattern`, `TwoBoneReach`, `MotionGraph`, `solvePose`), `world` (a `Walker`
for the body's root).

<!-- check: wrap -->
```ts
import { StepCycle, TwoBoneReach, solvePose } from 'wallhammer-web/motion';
import type { MotionGraph, Pose, Skeleton, StepPattern, TwoBoneChain } from 'wallhammer-web/motion';
import type { Walker } from 'wallhammer-web/world';
declare const walker: Walker; // the body's own walker: a wide radius, its own speeds and turn rates
declare const skeleton: Skeleton; // a trunk and legs of two bones, +z forward
declare const trunk: number; // the trunk's bone
declare const legs: TwoBoneChain[];
declare const homes: [number, number, number][]; // per leg where its end rests under its hip, root frame
declare const patterns: StepPattern[]; // a walk, a trot, a gallop: data (motion.md has a set)
declare const graph: MotionGraph; // params `speed` and `passes`; its moving state has `drive: { param: 'passes', per: 1 }`
declare const pose: Pose;
declare function groundAt(x: number, z: number): number;

const cycle = new StepCycle({ homes, patterns, tolerance: 0.05, minRate: 1.2 });
const reaches = legs.map((l) => new TwoBoneReach(l));
for (const r of reaches) r.on(0);
const root = new Float64Array(12);
const world = new Float64Array(skeleton.count * 12);
const at = new Float64Array(3);
let lastYaw = Number.NaN;
let lastPhase = 0;
let passes = 0;

function frame(dt: number): void {
  walker.renderPosition(at);
  const yaw = walker.renderYaw();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  root.set([-c, 0, s, 0, 1, 0, -s, 0, -c, at[0]!, at[1]!, at[2]!]); // the root's +z along the walker's facing
  let turn = Number.isNaN(lastYaw) ? 0 : yaw - lastYaw;
  turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
  lastYaw = yaw;
  if (!(dt > 0)) return;
  const vx = walker.velocity[0]!, vz = walker.velocity[2]!;
  cycle.update(dt, root, vx, vz, turn / dt, groundAt);
  // The graph's phase from the cycle's passes: the trunk's motion stays in step with the legs.
  let d = cycle.phase - lastPhase;
  d -= Math.floor(d);
  lastPhase = cycle.phase;
  passes += d;
  graph.setParam('speed', Math.hypot(vx, vz));
  graph.setParam('passes', passes);
  graph.update(dt);
  graph.evaluate(pose);
  pose.offset[trunk * 3 + 1] = pose.offset[trunk * 3 + 1]! + cycle.supportHeight - root[10]!; // onto the ground under the ends
  solvePose(skeleton, pose, root, world);
  const t = cycle.targets;
  for (let i = 0; i < reaches.length; i++) {
    reaches[i]!.setTarget(t[i * 3]!, t[i * 3 + 1]!, t[i * 3 + 2]!);
    reaches[i]!.update(dt);
    reaches[i]!.apply(skeleton, pose, root, world);
  }
}
```

The patterns, the outputs (`planted`, `swing`, `landed` for a footfall's sound, `pitch` and `roll` for tilting the
trunk) and the time rules: [Steps of several legs](motion.md#steps-of-several-legs).

**Example.** `movement` (the steed: `examples/shared/src/figures/steed.ts` its patterns and sockets, `quad-gait.ts`
the cycle, the trunk on the ground and the graph driven by the passes; ride it with E).

**Pitfalls.**

- Give the cycle the drawn root and the walker's velocity every frame, before the reaches; the cycle has no fixed
  step of its own and lands the ends where they would land within the frame.
- The turn rate counts as speed: a body turning on the spot steps too. Get it from the heading of the root you pass.
- A root that jumps farther than `teleport` (4 m) resets the cycle; after placing the body yourself call
  `cycle.reset(root, groundAt)` so it does not walk its ends over from the old place.
- Set `reach` from the legs' length, or a hard stop leaves an end stretched behind.
- On a sphere the cycle runs in the chart; when the chart changes call `cycle.rebase(m)`.
- The engine has no four-legged figure: the skeleton, its motions and the patterns are the game's (the example's
  steed is example code).

## Prints, tyre marks and dust

**Goal.** Feet, hooves and wheels leave marks on the ground that fade, deeper on soft ground than on hard, and kick up
dust where the ground is loose; the same steps give the same marks and the same dust.

**Modules.** `world` (surface tags of the `CollisionWorld`, `WheelState.surfaceTag`), `core` (`ContactTrail`,
`ContactStreaks`), `gen-core` (`hashInt` for the bursts' seeds), `render` (`ContactTrailLayer`,
`contactTrailMaterial`, `ParticleLayer.fire`).

<!-- check: wrap -->
```ts
import { ContactStreaks, ContactTrail } from 'wallhammer-web/core';
import { hashInt } from 'wallhammer-web/gen-core';
import type { MaterialDesc } from 'wallhammer-web/base';
import { ContactTrailLayer, ParticleLayer } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';
import type { CollisionWorld, WheeledBody } from 'wallhammer-web/world';
declare const renderer: Renderer;
declare const world: CollisionWorld; // made with `baseTagAt: (x, z) => isSand(x, z) ? SAND : GRASS`
declare const traceDesc: MaterialDesc; // contactTrailMaterial({ shade: your trailShade per kind, includes: [...] })
declare const car: WheeledBody;
declare let gameTime: number; // the simulation's clock, also advanced by scripted steps
declare let stepIndex: number;
const SAND = 201;
const PRINT = 0, DEEP_PRINT = 1, RUT = 2;

const trail = new ContactTrail(2048);
const prints = new ContactTrailLayer(renderer, trail, { material: renderer.material(traceDesc) });
const dust = new ParticleLayer(renderer, [], { burstCapacity: 1024 });
renderer.add(prints); // after the ground, before what stands on it
renderer.add(dust); // after the opaque layers
const ruts = new ContactStreaks(trail, car.wheels.length);

/** A foot put down at (x, y, z) heading `yaw` (from the gait's landing event). */
function footDown(x: number, y: number, z: number, yaw: number, foot: number): void {
  const sand = world.groundTagAt(x, z, y + 0.3, 0.4) === SAND;
  trail.layRaw(x, world.groundAt(x, z, y + 0.3, 0.4), z, 0, 1, 0, yaw, 0.13, 0.3, sand ? DEEP_PRINT : PRINT, gameTime, sand ? 20 : 10);
  if (sand) {
    dust.fire({
      position: [x, y + 0.05, z], time: gameTime, count: 6, life: 1.2, size: [0.2, 0.8], rise: 0.6, spread: [0.12, 0.6],
      colorStart: [0.5, 0.41, 0.3, 0.55], colorEnd: [0.62, 0.55, 0.46, 0], seed: hashInt(stepIndex, foot),
    });
  }
}

/** After every fixed step of the car: a rut per wheel rolling on sand. */
function afterCarStep(): void {
  car.wheels.forEach((w, i) => {
    const c = w.contact, n = w.normal;
    ruts.touch(i, w.grounded && w.surfaceTag === SAND, c[0]!, c[1]!, c[2]!, n[0]!, n[1]!, n[2]!, 0.2, RUT, gameTime, 14);
  });
}

// Every frame, before rendering:
prints.time = gameTime;
dust.burstTime = gameTime;
```

The ring, the fade and the layer: [Contact trail](rendering.md#contact-trail); bursts: [Particles](rendering.md#particles);
tags: [Surface tags](walking.md#surface-tags).

**Example.** `movement` (`src/traces.ts`: boot prints from the figure's `step.l`/`step.r` marks, hoof prints and dust
from the steed's step cycle, wheel dust; `src/car.ts`: skid marks and ruts through `ContactStreaks`; the patch of loose
ground in front of the start, `src/course.ts`). Presets `trace-trot`, `trace-gallop`, `trace-car`, `trace-handbrake`.

**Pitfalls.**

- Give the layers a clock that the game's own steps advance (`burstTime`, `time`), not the frame time: a script that
  steps the game and then takes a picture sees marks and dust of the right age, and a paused game freezes them.
- Seed a burst from the step and the source (`hashInt(step, source)`), never from `Math.random`, or the same run gives
  other dust.
- Read the tag where the contact is (`groundTagAt` with the foot's height); a print on a solid's top uses the solid's
  tag, so a deck or a rock can stay clean.
- The ring is fixed: a busy scene replaces its oldest marks. Size it from marks per second times their life.
- The marks are flat quads on the ground's plane at the contact; on a strongly curved surface keep them small.

## A follow camera for a carried or driven body

**Goal.** One `FollowRig` that follows the figure on foot, the steed it rides and the car it drives, moving between
them without a jump: a longer boom and a higher pivot for the bigger body, and behind the car while it drives unless
the player turns the view.

**Modules.** `camera` (`FollowRig`: `extraBoom`, `extraPivot`, `followHeading`), `motion` (`SocketSeat.weight`),
`world` (`Walker`, `WheeledBody`), `platform` (`bindWalkInput`, whose turns pause the heading follow).

<!-- check: wrap -->
```ts
import { FollowRig } from 'wallhammer-web/camera';
import type { SocketSeat } from 'wallhammer-web/motion';
import type { Walker, WheeledBody } from 'wallhammer-web/world';
declare const walker: Walker; // the figure's own
declare const carrierWalker: Walker; // the steed's
declare const seat: SocketSeat; // the figure's seat on the steed
declare const car: WheeledBody;
/** The game's: 0 on foot, rising to 1 while getting in, 1 driving, falling to 0 while getting out. */
declare function driveWeight(): number;
declare function driving(): boolean;

// Behind the car: 95 % of the way in 1.2 s, and 1.2 s after the player last turned the view.
const rig = new FollowRig({ minDistance: 0, maxDistance: 14, headingLag: 1.2, headingPause: 1.2 });
const RIDE_BOOM = 2.3, RIDE_PIVOT = 1.15, CAR_BOOM = 2.5, CAR_PIVOT = 0.2;
const at = new Float64Array(3);
const mount = new Float64Array(3);
const m = new Float64Array(12);

function followCamera(dt: number, carAlpha: number): void {
  // The point: the figure, blended to the steed by the seat's weight, then to the car by the drive's.
  walker.renderPosition(at);
  carrierWalker.renderPosition(mount);
  const w = seat.weight;
  let x = at[0]! + (mount[0]! - at[0]!) * w, y = at[1]! + (mount[1]! - at[1]!) * w, z = at[2]! + (mount[2]! - at[2]!) * w;
  const c = driveWeight();
  if (c > 0) {
    car.renderMatrix(m, carAlpha);
    x += (m[9]! - x) * c;
    y += (m[10]! - car.restHeight - y) * c; // the ground under the car, as for the figure's feet
    z += (m[11]! - z) * c;
  }
  // A longer boom and a higher pivot for the bigger body, kept apart from the player's own zoom; first person keeps
  // its boom of 0 and takes only the pivot.
  rig.extraBoom = RIDE_BOOM * w + CAR_BOOM * c;
  rig.extraPivot = RIDE_PIVOT * w + CAR_PIVOT * c;
  rig.follow(x, y, z);
  // While driving, the heading eases behind the car; a turn of the view by the player pauses it.
  rig.followHeading(driving() ? (car.renderYaw(carAlpha) * 180) / Math.PI : null);
  rig.update(dt);
}
```

**Example.** `movement` (`followDriven` and `swingBehindCar` in `src/main.ts`).

**Pitfalls.**

- The engine has no camera for a vehicle or a mount: `FollowRig` takes a point, the framing extras and a heading to
  follow; the blend and the numbers above are the game's.
- **The figure's walker must already stand where the figure will get off (or out) when that starts**
  ([A body carried by another](#a-body-carried-by-another)): the point blends from the carrier to the walker as the
  weight falls, and a walker still where the figure got on swings the camera back there.
- Use the same weights that move the figure (the seat's, the drive's), so the camera arrives as the figure does.
- Draw-time positions only: the walkers' `renderPosition` and the car's `renderMatrix` at its group's alpha, each
  with its own share of the way between its steps.
- Put the game's framing into `extraBoom` and `extraPivot`, never into `distance`: `distance` is the player's own
  zoom, so it comes back exactly on foot, and a saved view (`state()`) keeps the player's length.
- Follow the heading with a lag (`headingLag`), never set `yawDeg` to it: the easing is what keeps a spin or a
  handbrake turn from turning the picture as fast as the body ([A follow camera](wheeled.md#a-follow-camera)). A game
  that freezes its scene (a script holding a pose) passes `null`, or the view keeps swinging.

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

**Example.** `endless` (`#cam=free`, a `FreeRig` over a height function), `movement` (a `FollowRig` over a collision
world, `placeTarget` puts the walker back), `fantasy-village` (a `PerspectiveOrbitRig`), `planet` (a host of its own),
`system` (`engineMarkHost` with its own pick, key `K`, `clocks: false` and the page's time in its hash).

**Pitfalls.**

- The pick sees only its surface (a height function, a collision world): a mark on a tree or a cloud stores the ground
  behind it; the note and the picture say what was meant.
- `fixed` needs an after-picture of the same view (open the mark's link from `list --md`); the developer sets
  `accepted` or `reopened`, never the agent.
- Add `.marks/` to `.gitignore`. The page's view hash holds the camera, hour and animation time; state your page
  keeps elsewhere (a toggled layer, a seed) belongs in the `hash` option, and a clock of the page's own with
  `clocks: false` too.
- A view other than a `FreeRig`, `FollowRig` or `PerspectiveOrbitRig` (`ChartFollowView`, say) needs a `MarkHost` of
  its own ([Marks](marks.md)).

All of it: [Marks](marks.md).
