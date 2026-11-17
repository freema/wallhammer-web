# World streaming

Streaming loads and unloads cells of a quadtree around the viewer. It is split by layer:

| Part | Entry | GPU? |
| --- | --- | --- |
| Cell ids, `FlatWorld`, `CellContent` | `wallhammer-web/gen-core` | no |
| `StreamingManager`, providers, the WHC1 file format | `wallhammer-web/world` | no |
| `StreamedWorld` (a `Layer`), `WorkerCellProvider`, `serveCellGenerator`, `viewTickets` | `wallhammer-web/runtime` | yes |

The working example is `examples/endless`. Its generator and the golden recipes named on this page ("streaming seams" and the others, except "streaming GPU ceiling") live there too.

## Cells

A `CellId` is `{ face, level, x, y }`. The flat world uses `FACE_FLAT` (7). A root cell at level 0 is `FLAT_ROOT_EDGE_M` (65,536 m) wide; each level halves the edge. `LEVEL` names three levels (`region` 4, `district` 6, `cell` 8). `FlatWorld` implements `WorldShape`: `edgeM(level)`, `origin(cell)` and so on.

The manager asks the shape every question of place, so it works on any shape, not only on a plane:

| `WorldShape` member | The manager uses it for |
| --- | --- |
| `cellsNear(p, reachM, level)` | The coarsest cells near a ticket (a superset is fine). |
| `distanceM(cell, p)` | The distance along the surface from under a ticket to a cell; the ticket's altitude is combined with it. |
| `center(cell)`, `upAt(p)` | Which cells lie ahead of a ticket's direction, measured across "up" at the ticket. |
| `children(cell)`, `parent(cell)`, `edgeM(level)` | The quadtree. |
| `hashKey` | The identity of the shape. `shapeHash(shape)` turns it into a 32-bit number for cell files. |

`StreamingConfig.face` is optional: without it every face the shape reports near a ticket is streamed.

A cell's content is plain data:

```ts
import type { CellContent } from 'wallhammer-web/gen-core';

const empty = (c: CellContent['cell']): CellContent => ({
  cell: c,
  domainVersion: 1, // bump when the generator's output changes on purpose
  bounds: { min: [0, 0, 0], max: [1, 1, 1] }, // relative to the cell origin
  meshes: [], // { material: name, mesh: MeshData } relative to the cell origin
  instances: [], // { archetype: name, data: InstanceData, ids: Uint32Array of [high, low] pairs }
  // Optional, both off by default (a cell that states either is written in cell format 2):
  // shapeHash: shapeHash(shape) - the shape the cell was built for
  // error: 0.4 - metres between this cell's surface and the one its children would show
});
```

Positions inside a cell are relative to the cell origin. That keeps float precision at 10,000 km from the origin.

## Generators and providers

A `CellGenerator` is `(seed, cell) => CellContent`. It must be pure. A generator that also takes edits is an `EditableCellGenerator` (see [Edits and refresh](#edits-and-refresh)). Neighbouring cells must agree on their shared border; the golden test of the examples checks this for the example generator ("streaming seams").

A `CellProvider` delivers content: `{ name, blocking, request(cell, signal) }`.

| Provider | Entry | Source |
| --- | --- | --- |
| `GeneratorCellProvider(seed, gen, edits?)` | `world` | Runs the generator on the main thread (`blocking: true`). `generateNow` and `bytes` serve tools. |
| `WorkerCellProvider(url, seed, size?, edits?)` | `runtime` | Runs the generator in workers. The worker script calls `serveCellGenerator(gen)`. |
| `FileCellProvider(baseUrl, fetch, { shapeHash? })` | `world` | Reads `<base>/<face>/<level>/<x>/<y>.whc` (`cellFilePath`). Pass `fetchBytes` from `platform` in the browser. |

Workers that need the same data before they generate cells (a plan of the whole sphere, say) get it with `WorkerPool.broadcast(message)`: one structured copy goes to every worker, to a busy one right after its running job and in any case before the jobs still queued, and the promise resolves when every worker has answered. A cell job sent after the broadcast resolved therefore finds the data in whichever worker takes it. Broadcast replies do not count in `timing`.

`encodeCell` and `decodeCell` convert content to and from the WHC1 binary format. A file provider and a generator provider must give the same bytes; the golden test of the examples checks it, and `examples/endless/scripts/verify.ts` checks baked files.

The format has two versions. A cell that states neither `shapeHash` nor `error` is written in format 1 (`CELL_FORMAT_VERSION`), with the same bytes as before. A cell that states one of them is written in format 2 (`CELL_FORMAT_VERSION_SHAPED`), which adds the two fields after the cell id. `decodeCell` reads both.

The shape hash keeps cells of different shapes apart (another radius, another root edge):

- `cellFilePath(cell, shapeHash)` puts the hash in front of the path: `s<8 hex digits>/<face>/<level>/<x>/<y>.whc`.
- `FileCellProvider` with the `shapeHash` option reads from that folder and rejects a file that states another shape.
- `StreamedWorld` refuses a cell whose `shapeHash` differs from its own shape (`stats().shapeMismatches`).

## The manager

`StreamingManager(config)` decides which cells are wanted. It does no I/O itself. Each frame:

1. `update(tickets)` returns `StreamingActions`: `requests`, `cancels`, `uploads`, `releases`, `evictions`.
2. The caller runs them and reports back: `complete(req, cpuBytes, errorM?)` or `fail(req)` for a request, `resident(cell, gpuBytes)` after an upload.
3. `state(cell)`, `drawn()`, `wanted()`, `settled`, `stale` and `counters` describe the state.

A `Ticket` is a point of interest: `{ id, kind, center, altitude?, base, dir?, pixelsPerRadian?, preload? }`. `dir` is `[x, z]` on a flat world or a world direction `[x, y, z]`. `viewTickets(eye, altitude, forward, velocity)` makes the usual set on a flat world: the camera plus a predicted point ahead. `viewerTickets({ eye, altitude, forward, velocity?, pixelsPerRadian? })` does the same with world directions, for any shape.

`DEFAULT_STREAMING` (without `shape` and `face`): `rootLevel` 4, `leafLevel` 8, `rootRange` 2, `splitLevel` 1, `prefetch` 0.5, `hysteresis` 0.75, `maxInFlight` 8, `memoryBudgetBytes` 128 MB. `screenError` is not set.

## Selection by screen-space error

Off by default. Without it a cell is split while a ticket is within `splitLevel` cell edges. With `screenError` in the config the split distance follows from the screen instead:

| `ScreenErrorConfig` | Meaning |
| --- | --- |
| `maxErrorPx` | The largest error left on the screen, in pixels. |
| `errorPerEdge` | Error of a cell as a share of its edge. For a grid of n quads per edge use `1 / (8 · n)`. |
| `minErrorPerEdge?` | A measured error never counts as less than this share of the edge. Default 0. |
| `pixelsPerRadian` | For tickets that do not state their own. `pixelsPerRadian(viewportHeightPx, fovYRad)` computes it. |
| `maxCells?` | Budget of cells wanted on the GPU at once. |

A cell is split while a ticket is within `errorPerEdge × pixelsPerRadian ÷ maxErrorPx` edges (`manager.splitDistance(ticket)`). `prefetch` and `hysteresis` keep their share of that distance. Four more rules apply:

- **Loaded parents only.** The manager never asks for a cell whose parent is not loaded. Until a cell is loaded nothing could stand in for its children, and its error is not known. After `complete` the manager reports `stale`: run another `update` (`StreamedWorld` does).
- **Measured error.** A cell that reports `CellContent.error` smaller than `errorPerEdge × edge` is split later; with error 0 and no `minErrorPerEdge`, never. A generator whose cells carry content the error does not measure (instances that appear at finer levels) should report the full error for those cells. With blending between levels the same holds for every cell whose shape differs from its children's: the blend ends where a cell with the full error is split, so a cell split later is replaced by children already in their own shape, a step of up to `maxErrorPx` on the screen.
- **Budget of cells.** When the plan wants more than `maxCells`, the split distance shrinks in steps of 2^¼ until the plan fits, and grows back when the finer plan would use at most 85 % of the budget. `counters().detail` is the share in use.
- **Ahead first.** Jobs for cells in front of a ticket's direction start before the others, then the nearest. `maxInFlight` is the budget of jobs.
- **Preloading tickets.** A ticket with `preload: true` fetches the cells it would split and keeps them ready on the CPU, but does not change what is drawn; the cells go to the screen once another ticket wants them. Default off. Use it for the predicted point ahead of the viewer when levels blend: `tickets.map((t) => (t.kind === 'predict' ? { ...t, preload: true } : t))`.

```ts
import { FACE_FLAT, FlatWorld } from 'wallhammer-web/gen-core';
import { DEFAULT_STREAMING, StreamingManager, pixelsPerRadian } from 'wallhammer-web/world';
import type { StreamingConfig } from 'wallhammer-web/world';
import { viewerTickets } from 'wallhammer-web/runtime';

const fovY = (50 * Math.PI) / 180;
const config: StreamingConfig = {
  ...DEFAULT_STREAMING,
  shape: new FlatWorld(),
  face: FACE_FLAT,
  prefetch: 0.2,
  hysteresis: 0.3,
  screenError: {
    maxErrorPx: 2,
    errorPerEdge: 1 / (8 * 32), // cells of 32 quads per edge
    pixelsPerRadian: pixelsPerRadian(1080, fovY),
    maxCells: 800,
  },
};
const manager = new StreamingManager(config);
// Every frame: the viewer with the size of its own screen.
const tickets = viewerTickets({ eye: [0, 300, 0], altitude: 300, forward: [0, 0, -1], pixelsPerRadian: pixelsPerRadian(1440, fovY) });
const actions = manager.update(tickets);
```

## Blending between levels

Off by default. Without it a level-of-detail change is a visible jump and only the skirt hides the cracks. The blend has three parts:

1. **The generator** builds the cell with `cellMorphMesh` (module `gen-mesh`) instead of `cellSurfaceMesh`. Every vertex then also carries the distance to the surface of the cell one level coarser, and that surface's normal and colour (`CELL_MORPH_LAYOUT`). The coarser surface is not sampled again: it is the cell's own grid thinned by two. The result also gives `error` for `CellContent.error` and a skirt deep enough for its border.
2. **The material** pastes `CELL_MORPH_GLSL` into its vertex shaders (colour and shadow) and moves each vertex by `cellMorph(p)`: 0 is the cell's own shape, 1 the coarser one.
3. **`StreamedWorld`** gets `morph: true`. It then sets `u_morphEye`, `u_morphUp` (per frame) and `u_cellMorph` (per cell) from `manager.morphRange(level)`, and redraws shadows when the viewer has moved far enough to change the blend.

`morphRange(level)` returns `{ startM, endM }` for the viewer (`manager.viewer()`, the ticket with the lowest base). A cell is in its own shape nearer than `startM` and in its parent's shape from `endM`, which is exactly where the parent stops being split. So a cell that has just replaced its parent looks like the parent, and a cell next to a coarser one meets it without a crack. This holds for a parent that is split at the full split distance. A parent that reported a smaller `error` is split nearer, where its children have already left its shape; report the full error (`errorPerEdge × edge`) for cells that must not show that step, as the endless example does for every cell with land.

The blend is measured from the viewer alone. A second ticket that splits cells away from the viewer (the predicted point of `viewTickets`) puts cells on the screen in their parent's plain shape, next to cells that already blend into theirs: a step, which the skirt covers, and a jump when the split happens. Mark such a ticket `preload: true`.

The blend is exact while the split distance is at least 2.02 cell edges. Below that (a small `splitLevel`, or the budget of cells holding the detail down) the blend is squeezed into the last 15 % of the way and small steps remain; the skirt covers them.

```ts
import { FlatWorld, shapeHash, valueNoise2 } from 'wallhammer-web/gen-core';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { CELL_MORPH_GLSL, cellMorphMesh } from 'wallhammer-web/gen-mesh';

const shape = new FlatWorld();

export function generate(seed: number, cell: CellId): CellContent {
  const size = shape.edgeM(cell.level);
  const o = shape.origin(cell);
  const s = cellMorphMesh({ originX: o[0], originZ: o[2], size, quads: 32, heightAt: (x, z) => 40 * valueNoise2(x, z, 300, seed), skirtDepth: 0.5 });
  return {
    cell,
    domainVersion: 1,
    bounds: { min: [0, s.minY, 0], max: [size, s.maxY, size] },
    meshes: [{ material: 'terrain', mesh: s.mesh }],
    instances: [],
    shapeHash: shapeHash(shape),
    error: s.error,
  };
}

// Vertex shader of the material named 'terrain' (attribute locations: CELL_MORPH_ATTRIBS).
export const TERRAIN_VS = `#include <header>
uniform vec3 u_cellOffset;
${CELL_MORPH_GLSL}
in vec3 a_pos;
in vec4 a_normal;
in vec4 a_color;
in float a_coarseShift;
in vec4 a_coarseNormal;
in vec4 a_coarseColor;
out vec3 v_world;
out vec3 v_normal;
out vec4 v_color;
void main() {
  vec3 p = a_pos + u_cellOffset;
  float m = cellMorph(p);
  p += u_morphUp * (a_coarseShift * m);
  v_world = p;
  v_normal = mix(a_normal.xyz, a_coarseNormal.xyz, m);
  v_color = mix(a_color, a_coarseColor, m);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;
```

`colorAt` of a blended cell must give a vertex the same colour at every level (from the position and height, not from the normal of that level). Instances can follow the surface the same way: give each instance the shift of its base point as one more instance attribute and add `u_morphUp * (shift * cellMorph(base))`; the endless example does (`PROP_MORPH_LAYOUT`). An instance that the coarser level does not hold can grow with the same factor instead of appearing at once: the example gives it a size of 0 on the coarser level and scales by `mix(1.0, size, cellMorph(base))`.

`HeightField.coarseSurface(cols, rows, values, n)` is the building block: the surface a grid thinned to every n-th vertex would draw, evaluated at every vertex of the full grid.

The endless example switches both options on with `#lod=smooth`. The golden test of the examples checks the seams between levels ("streaming seams between levels") and the cover ("streaming coverage by screen-space error").

## `StreamedWorld`

`StreamedWorld` runs the manager, uploads cells within a time budget and draws them. It is a `Layer`.

<!-- check: wrap -->
```ts
import { FACE_FLAT, FlatWorld } from 'wallhammer-web/gen-core';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import type { Material, Renderer } from 'wallhammer-web/render';
import { DEFAULT_STREAMING, GeneratorCellProvider } from 'wallhammer-web/world';
import { StreamedWorld, viewTickets } from 'wallhammer-web/runtime';
declare const renderer: Renderer;
declare const terrain: Material;
declare function generateCell(seed: number, cell: CellId): CellContent;

const world = new StreamedWorld({
  renderer,
  config: { ...DEFAULT_STREAMING, shape: new FlatWorld(), face: FACE_FLAT },
  provider: new GeneratorCellProvider(7, generateCell),
  materials: { terrain }, // names used by CellContent.meshes and archetypes
  onActivity: () => {
    // request another frame here (engine.invalidate())
  },
  // morph: true - blend between levels, see "Blending between levels"
});
renderer.add(world);

// Every frame, before rendering: where the viewer is, in world metres (double precision).
const eye: [number, number, number] = [0, 300, 0];
world.setFocus([eye[0], 0, eye[2]]);
world.setEye(eye);
world.setTickets(viewTickets(eye, 300, [0, -1]));
```

Render space is shifted: the render origin snaps to a grid (`originGridM`, default 1,024 m) near the focus. Convert with `toRender` and `toWorld`. Shaders of streamed materials read `u_cellOffset` (cell origin minus render origin, vec3) and may read `u_cellLevel`.

**Origin on all axes.** By default the origin follows the focus on x and z only and its height stays 0. That is exact enough near height 0, but a 32-bit float 400 km up has steps of 3 cm, and the image shakes. `originAxes: 'all'` makes the origin follow the height of the focus too:

<!-- check: wrap -->
```ts
import type { FreeRig } from 'wallhammer-web/camera';
import type { StreamedWorld } from 'wallhammer-web/runtime';
declare const world: StreamedWorld; // created with originAxes: 'all'
declare const rig: FreeRig;

// Every frame: the focus is the eye itself, height included; the rig then works relative to the same origin.
world.setFocus(rig.position);
rig.origin = [world.origin[0], world.origin[1], world.origin[2]];
```

Cell origins and the eye stay doubles on the CPU; only their difference to the origin reaches the GPU. With `'all'`, `world.origin[1]` is no longer 0: heights handed to anything that works in render space (a view target, the fog layer, the cloud height of the sky) need it subtracted. Layers of your own do the same as the streamed world: keep the position in doubles and hand the GPU `toRenderSpace(position, world.origin)` (module `base`); `snapRenderOrigin` is the grid rule itself, for a renderer without a streamed world (set `renderer.worldOrigin` to the same origin, so shadow texels stay fixed to the world).

Budgets: `uploadMsPerFrame` (default 3), `blockingMsPerFrame` for blocking providers (default 6). `stats()` reports counts and timings.

## A sphere world

`SphereWorld` (module `world`) is a second `WorldShape`: a sphere of a radius you choose, made of a cube whose six faces are each a quadtree. Nothing uses it unless you create it; a flat world is not touched.

- **Cells.** `face` of a cell id is the face of the cube: 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z. Level 0 is a whole face, a quarter of the way round along its middle (`edgeM(0)`); every level halves it. The grid of a face is spaced evenly in angle (`cubeWarp`), so cells of one level differ in area by a factor of 1.41 at most.
- **Neighbours.** `neighbours(cell)` crosses the edges of the cube. A cell has eight neighbours, seven at a corner of the cube; a whole face has four.
- **Points.** Positions are metres from the sphere's centre, in doubles. `cellAt`, `distanceM` (along the surface, 0 inside the cell) and `cellsNear` look only at the direction of a point, so its height does not matter. `center(cell)` is the middle of the cell on the base sphere and is also the cell origin; cell data are relative to it with the world's axes.
- **Up.** `upAt(p)` points away from the centre. `noiseDomain(p)` is the point of the base sphere under `p`: sample `valueNoise3` / `fractalNoise3` there and the content has no seam and no pole.
- **Shape hash.** `hashKey` holds the radius and the centre, so cell files of another sphere are refused.

**Cells of a sphere.** `spherePatchMesh` (module `gen-core`) builds the surface of one cell: a grid of `quads × quads` on the face, every vertex at the base radius plus `heightAt(x, y, z)` of its point of the base sphere. Heights and colours must be functions of that point alone. Then neighbours agree on their shared border, across the edges of the cube as well, and the mesh carries the shape of the cell one level coarser (`a_coarseShift` along the vertex's own up, `a_coarseNormal`, `a_coarseColor`) and a skirt, like the cell morph mesh of the flat world. `spherePatchRadius` tells where a direction meets the triangles of a level (or of the level above it): stand instances there, with the difference as their own shift.

<!-- check: wrap -->
```ts
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { fractalNoise3, shapeHash, spherePatchMesh } from 'wallhammer-web/gen-core';
import { SphereWorld } from 'wallhammer-web/world';

const shape = new SphereWorld(100_000); // radius in metres; an optional second argument is the centre
const QUADS = 32;

function generateCell(seed: number, cell: CellId): CellContent {
  const patch = spherePatchMesh({
    radiusM: shape.radiusM,
    face: cell.face,
    level: cell.level,
    x: cell.x,
    y: cell.y,
    quads: QUADS,
    // A function of the point on the base sphere; never negative here, so the surface never dips under the sphere.
    heightAt: (x, y, z) => 3000 * fractalNoise3(x, y, z, { cellM: 20_000, octaves: 5 }, seed),
    skirtDepth: shape.edgeM(cell.level) * 0.004,
  });
  return { cell, domainVersion: 1, bounds: patch.bounds, meshes: [{ material: 'terrain', mesh: patch.mesh }], instances: [], shapeHash: shapeHash(shape), error: patch.error };
}
```

**Streaming it.** The manager needs no `face` (all six are streamed) and `rootRange: Infinity`, so every face is always wanted and the far side stays covered by its coarsest cells. Use selection by screen-space error: the error of a cell includes the bulge of the sphere, so a view from far away settles on a few coarse cells by itself.

<!-- check: wrap -->
```ts
import { definePalette } from 'wallhammer-web';
import type { MaterialDesc } from 'wallhammer-web/base';
import { FreeRig } from 'wallhammer-web/camera';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { bindFreeInput } from 'wallhammer-web/platform';
import { StreamedWorld, createEngine, viewerTickets } from 'wallhammer-web/runtime';
import { DEFAULT_STREAMING, GeneratorCellProvider, SphereWorld, pixelsPerRadian } from 'wallhammer-web/world';
declare const canvas: HTMLCanvasElement;
declare const TERRAIN: MaterialDesc; // a material that uses SPHERE_PATCH_GLSL, see below
declare function generateCell(seed: number, cell: CellId): CellContent;
declare function heightAt(x: number, y: number, z: number): number; // the generator's height function

const shape = new SphereWorld(100_000);
const QUADS = 32;
const ROOT_LEVEL = 0;
const MIN_HEIGHT_M = 0; // the lowest height the generator gives

// The camera: up from the shape, height above the surface from the generator's own function.
const start = shape.atHeight([1, 0.6, 0.3], 180_000); // 180 km above the surface, on the line from the centre through a point
const rig = new FreeRig(
  { fovYDeg: 50, minClearance: 2, maxSpeed: 40_000 },
  {
    shape,
    heightAbove: (p) => {
      const b = shape.noiseDomain(p);
      return shape.altitude(p) - heightAt(b[0], b[1], b[2]);
    },
  },
  { position: [start[0], start[1], start[2]], pitchDeg: 89 },
);
const engine = createEngine({
  canvas,
  view: rig,
  palette: definePalette({ sky: '#05070c' }),
  background: [0.02, 0.027, 0.047],
  // A depth mode that reaches from a metre to the far side, and up that points away from the centre.
  renderer: { depth: 'reversed', radialUp: shape.radial },
  environment: { mode: 'day', hour: 13 },
});
const world = new StreamedWorld({
  renderer: engine.renderer,
  config: {
    ...DEFAULT_STREAMING,
    shape, // no `face`
    rootLevel: ROOT_LEVEL,
    leafLevel: 11,
    rootRange: Infinity,
    prefetch: 0.2,
    hysteresis: 0.3,
    screenError: { errorPerEdge: 1 / (8 * QUADS), minErrorPerEdge: 1 / (32 * QUADS), maxErrorPx: 2, maxCells: 900, pixelsPerRadian: 1158 },
  },
  provider: new GeneratorCellProvider(7, generateCell),
  originAxes: 'all', // the render origin follows the camera on three axes
  morph: true, // blend between levels
  // Cells behind the sphere's own horizon are not drawn. The hiding sphere must lie under everything drawn.
  horizon: { center: shape.centerM, radiusM: shape.radiusM + MIN_HEIGHT_M - 2 * shape.facetDropM(ROOT_LEVEL, QUADS) },
  materials: { terrain: engine.renderer.material(TERRAIN) },
  onActivity: () => engine.invalidate(),
});
engine.add(world);

const input = bindFreeInput(engine.canvas, rig, { onChange: () => engine.invalidate() });
engine.renderer.beforeFrame.unshift(() => {
  input.step();
  const eye: [number, number, number] = [rig.position[0], rig.position[1], rig.position[2]];
  world.setFocus(eye);
  rig.origin = [world.origin[0], world.origin[1], world.origin[2]];
  world.setEye(eye);
  world.setTickets(viewerTickets({ eye, altitude: rig.clearance, forward: rig.axes().forward, velocity: rig.velocity, pixelsPerRadian: pixelsPerRadian(engine.canvas.clientHeight, (50 * Math.PI) / 180) }));
});
```

**Shaders.** A renderer made with `radialUp` defines `WH_LOCAL_UP` and gives every shader `localUp(p)`, `localHeight(p)` and `localFrame(p)` (see [Local up](rendering.md#local-up)). The vertex shader of the surface pastes `SPHERE_PATCH_GLSL` after `#include <header>` and blends with the distance measured along the sphere:

<!-- check: skip -->
```ts
// vertex shader
vec3 p = a_pos + u_cellOffset;
float m = spherePatchMorph(p);                       // 0 own shape, 1 the parent's
p += localUp(p) * (a_coarseShift * m);
v_normal = mix(a_normal.xyz, a_coarseNormal.xyz, m); // world axes
// an upright instance: its axes are the local frame of its base point
vec3 world = base + localFrame(base) * (a_pos * scale);
// fragment shader: the sky light of the place
vec3 lit = albedo * lightOnAt(v_world, n, sunVisibility(v_world, n, 1.2), 1.0);
```

**Horizon culling.** `StreamedWorldOptions.horizon` (off by default) names the centre and the radius of a sphere that hides what lies behind it. A cell is skipped in the view pass when even its highest point, at its nearest distance, is below the horizon of that sphere as seen from the eye: `horizonHidden(eye, radius, nearest, farthest radius)`. The test is on the safe side: it never hides what a straight line of sight reaches. The radius must lie under everything that is drawn: under the lowest height of the content and under the flat triangles of the coarsest cells, which dip inside the sphere between their vertices by up to `facetDropM(level, quads)`. `stats().horizonCulled` counts the cells skipped in the last frame. The shadow pass is not culled by the horizon.

The page `sphere.html` of the endless example is a sphere of radius 100 km built this way (`examples/endless/src/sphere-world.ts`, `sphere-shaders.ts`, `sphere-main.ts`). The golden test of the examples checks the shape ("world sphere shape"), the seams ("gen-core sphere patch seams"), the cells, the horizon test and the cover of all six faces on a descent from 300 km to 30 m. The example `examples/planet` adds the atmosphere and a scripted flight from the surface to orbit and back ([The planet example](planet.md)).

Limits of the sphere shape:

- Positions inside a cell are 32-bit floats relative to the middle of the cell. A whole face of a 100 km sphere has steps of 8 mm; a face of a sphere of 6,400 km has steps of half a metre, which is fine from the distance such a cell is drawn at. Leaf cells are exact to micrometres.
- Blending assumes one viewer, as on the flat world. The skirt covers what remains.
- The shadow map, its modes `'snapped'` and `'cascades'` and the light horizon assume a flat ground along y. On a sphere use the default mode with a `shadowDistanceM` of a few kilometres; far from the +y side of the sphere the fit of the light is looser.
- The environment has one sun direction for the whole world and computes it for a site with up along +y. Sky light and direct light fade where the local up turns away from the sun, but dawn colours do not follow the place. The `sky` include and the sky layer assume up along +y. The atmosphere (off by default) lifts these for a sphere: a sky from the ground to orbit, light computed per place, and `Environment.observer` for the sun by the eye's place; see [The atmosphere](rendering.md#the-atmosphere).

## Content beyond its levels

Objects (instances) exist only in the finest levels of cells. Farther away the surface itself has to look the way they did, or an area covered with them changes colour and loses its outline where they stop. The engine gives the generic parts and does not know what the objects are:

- **A baked cover per vertex.** `SpherePatchOptions.coverAt(x, y, z, height)` (off by default) returns RGBA bytes for a surface point: rgb what the content standing there looks like from afar, a the share of the surface it hides (its density). The content function decides both; use the same rule that places the objects, as an expected value, and a function of the point alone so every level agrees. The mesh then has `SPHERE_PATCH_COVER_LAYOUT`: the plain attributes plus `a_cover` and `a_coarseCover` (the cover on the level one coarser, for the blend), at the locations of `SPHERE_PATCH_COVER_ATTRIBS`. Without `coverAt` the bytes of a patch are what they were.
- **The fade.** `coverFade(objectLevel, cellLevel, morph)` (core, also as `COVER_FADE_GLSL`) is the share of the far look for a cell: 0 in cells finer than `objectLevel` (the coarsest level whose cells hold the objects), 1 in coarser ones, and the cell's own blend factor on `objectLevel` itself. So the change is spread over the band in which that level blends into its parent (needs `morph: true`; `u_cellLevel` is set per cell by `StreamedWorld`), and it meets both neighbouring levels without a step.
- **The objects leave one by one.** `coverKeep(fade, order)` is the size of one object at that share, for a number `order` in 0–1 fixed per object (a hash, or any attribute spread evenly): about `1 − fade` of the objects remain, each shrinking over a tenth of the band. Use it in the colour and in the shadow program.

<!-- check: wrap -->
```ts
import { spherePatchMesh } from 'wallhammer-web/gen-core';
import type { SpherePatchOptions } from 'wallhammer-web/gen-core';

declare const patch: SpherePatchOptions; // the cell, heightAt, colorAt, skirtDepth
declare const density: (x: number, y: number, z: number, height: number) => number; // 0–1, the rule of the content

const { mesh } = spherePatchMesh({
  ...patch,
  // rgb: the mean colour of the objects; a: the share of the surface they hide.
  coverAt: (x, y, z, h) => [52, 84, 40, Math.round(255 * density(x, y, z, h))],
});
// mesh.layout is SPHERE_PATCH_COVER_LAYOUT; the material lists SPHERE_PATCH_COVER_ATTRIBS.
```

<!-- check: skip -->
```ts
// surface, vertex shader (after SPHERE_PATCH_GLSL and COVER_FADE_GLSL)
float m = spherePatchMorph(p);
v_cover = mix(a_cover, a_coarseCover, m);
v_cover.a *= coverFade(u_coverLevel, u_cellLevel, m);
// surface, fragment shader
albedo = mix(albedo, v_cover.rgb, v_cover.a);
// objects, vertex shader of the colour and the shadow program
float fade = coverFade(u_coverLevel, u_cellLevel, spherePatchMorph(base));
vec3 world = base + axes * (a_pos * scale * coverKeep(fade, order));
```

`u_coverLevel` is the content's own uniform (set it through `StreamedWorld.uniforms`). Return the colour of the objects from `coverAt` also where the share is 0, so the colour does not darken toward the border of a covered area. The sphere page of the endless example does all of this with `#cover=1` (`surfaceCover` in `sphere-world.ts`, the cover materials in `sphere-shaders.ts`). Limits: the cover is a property of the sphere patch only (the flat `cellMorphMesh` has no such attribute), one cover per vertex stands for all content of the cell, and its share does not follow the angle of view.

- **Four more bytes per vertex.** `SpherePatchOptions.extraAt(x, y, z, height)` (off by default) returns four bytes the content gives a meaning, for example the skyline code of `horizonCodeAt` ([The plan of a sphere](generators.md#gen-plan-the-plan-of-a-sphere)) so the surface shader knows where a far light is hidden. The mesh then has `SPHERE_PATCH_EXTRA_LAYOUT` (or `SPHERE_PATCH_COVER_EXTRA_LAYOUT` with `coverAt` too): `a_extra` and `a_coarseExtra` (thinned to the level one coarser like the colour, for the blend) after the other attributes, at the locations of `SPHERE_PATCH_EXTRA_ATTRIBS` or `SPHERE_PATCH_COVER_EXTRA_ATTRIBS`. Blend them in the vertex shader with the same factor as the height. Make the bytes a function of the point alone, so a vertex on the border of two cells and of two levels gets the same bytes from both. Without `extraAt` the bytes of a patch are what they were.

Narrow, long content (a strip along a broken line) is a second mesh of the cells it passes, at every level, rather than colour in the surface: at a vertex spacing of metres a baked colour blurs and vanishes from afar. The cell generator cuts and fills its ground with `stripCarve`, adds the mesh of `stripMesh` under its own material name, and merges its bounds into the cell's; a cell that `stripTouches` rejects stays as it was apart from its domain version. The strip blends between levels with the surface's blend factor and its vertex shader keeps it a least number of pixels wide, so it stays a thin unbroken line on far levels with no second kind of geometry. Nothing in the runtime changes: a cell already carries several meshes by material name. See [Strips along a surface](generators.md#strips-along-a-surface).

## Packed meshes

A cell's meshes can be stored compactly: positions as 16-bit steps from the cell's corner instead of three floats, and loose triangles as indexed ones. `packMesh` (module `gen-mesh`) does both for any mesh whose layout has `a_pos` as three floats; everything else in a vertex is copied byte for byte.

- Horizontally a cell edge has 16,384 steps (`PACK_STEPS_PER_EDGE`), so a level 8 cell of the flat world (256 m) resolves 1.6 cm and a position may lie up to one edge outside the cell on either side.
- Vertically the step and the height of step 0 are the same for the whole world (`stepY`, `heightOrigin`); with 1/64 m the range is 512 m either side of the origin.
- A mesh without indices is indexed: equal packed vertices are stored once, in the order of their first use. With `spans` (ascending vertex boundaries) vertices are merged only inside a span. Each span is then one run of vertices, and the same span packed alone gives exactly the bytes it has inside the whole mesh, so one object can be overwritten in a cell's vertex buffer without touching the rest.
- A mesh with indices keeps its vertices and their order. Indices are 16-bit when there are at most 65,536 vertices.

`packedMaterial(desc)` returns the material for such meshes. Every vertex shader of `desc` must contain the line `in vec3 a_pos;`. It is replaced by the packed attribute and a function that unpacks it, and `a_pos` becomes that function's value, so the rest of the shader is unchanged. A `'depth'` pass becomes a depth program that unpacks too. The unpacking reads `u_pack` (`packUniform`) and the per-cell `u_cellLevel` and `u_cellOffset` that `StreamedWorld` sets. A shader that declares `u_cellOffset` itself is taken to add it itself: its `a_pos` then stays relative to the cell.

<!-- check: wrap -->
```ts
import type { MaterialDesc, MeshData } from 'wallhammer-web/base';
import { FlatWorld } from 'wallhammer-web/gen-core';
import type { CellId } from 'wallhammer-web/gen-core';
import { packFrame, packMesh, packUniform, packedMaterial } from 'wallhammer-web/gen-mesh';

declare const shape: FlatWorld;
declare const cell: CellId;
declare const mesh: MeshData; // positions in world metres, `a_pos` as three floats
declare const desc: MaterialDesc; // its vertex shader has the line `in vec3 a_pos;`
const STEP_Y = 1 / 64;
const HEIGHT_ORIGIN = 300;

// In the generator: positions become steps from the cell's corner.
const packed = packMesh(mesh, packFrame(shape.edgeM(cell.level), shape.origin(cell), HEIGHT_ORIGIN, STEP_Y));
// On the page: the same material reading the packed position, and the uniform it needs.
const material = packedMaterial(desc);
const uniforms = { u_pack: packUniform(shape.rootEdgeM, STEP_Y, HEIGHT_ORIGIN) };
```

`packed.clamped` counts positions that lay outside the 16-bit range and were moved to its border; it should be 0.

### A surface within a tolerance

`bisectSurface` (module `gen-mesh`) turns a square grid of heights into a packed mesh with as few triangles as an error tolerance allows. The square is two right triangles, and a triangle is cut in two at the middle of its long edge while the grid differs from it by more than `toleranceM` anywhere inside. Flat ground ends up as a few large triangles; broken ground keeps the full grid. A cell of each level samples the ground at its own spacing, so the levels are the densities of the surface.

- `heights` holds `(quads + 3)²` samples with one extra sample all round, used for normals only, so cells that share an edge agree on the normals there.
- Neighbouring cells may be cut differently along their shared edge. Every outer edge gets a skirt `skirtM` deep that hides the gap.
- `cuts` marks sides (low x, high x, low z, high z) as a cut through the ground, for the border of a world that ends: the strip then reaches down to the given height and carries the cut kind.
- `clip` cuts the square off at a rectangle, for a cell that the world only partly covers.

<!-- check: wrap -->
```ts
import { bisectSurface } from 'wallhammer-web/gen-mesh';

declare const heightAt: (x: number, z: number) => number;
const quads = 64;
const edgeM = 512;
const wide = quads + 3;
const heights = new Float32Array(wide * wide);
for (let j = 0; j < wide; j++) {
  for (let i = 0; i < wide; i++) heights[j * wide + i] = heightAt(((i - 1) * edgeM) / quads, ((j - 1) * edgeM) / quads);
}
const surface = bisectSurface(heights, { quads, edgeM, toleranceM: 0.5, stepY: 1 / 64, heightOrigin: 300, skirtM: 8 });
// surface.mesh has the layout BISECT_SURFACE_LAYOUT; surface.triangles of surface.gridTriangles were kept.
```

The mesh is drawn by any material of a height field mesh passed through `packedMaterial` (the attributes are the packed position and the normal with a kind).

## A cache in the browser's storage

`CachedCellProvider` (module `world`) stands in front of another provider and keeps every finished cell as bytes of the cell format. A cell asked for a second time, in this visit or a later one, is decoded from the store instead of being built. The store is a port (`CellStore`: `get` and `put`); in a browser it is `openByteStore` of `platform`, which keeps byte arrays in IndexedDB.

The third argument is a version: a text that names everything the cells depend on (a fingerprint of the data, the generator's version, the world seed). It is the prefix of every key, so cells made from other data are never read, and `keepOnly(prefix)` deletes what older versions left behind.

<!-- check: wrap -->
```ts
import { openByteStore } from 'wallhammer-web/platform';
import { CachedCellProvider } from 'wallhammer-web/world';
import type { CellProvider, CellStore } from 'wallhammer-web/world';

declare const inner: CellProvider;
// The store opens in the background; until then (and where the browser has no storage) cells are simply built.
const opened = openByteStore('my-world-cells');
const store: CellStore = {
  get: async (key) => (await opened)?.get(key) ?? null,
  put: async (key, bytes) => {
    await (await opened)?.put(key, bytes);
  },
};
const provider = new CachedCellProvider(inner, store, 'data-2026-11.generator-3');
void opened.then((s) => s?.keepOnly(provider.prefix));
```

`provider.stats` counts hits, misses, broken entries and bytes. Writes are not awaited, and nothing in the store can reject: a full or missing store only means that a cell is built again.

## Edits and refresh

Content that changes after it was generated (damage, say) is kept outside the cells and handed to the generator as edits: opaque text per cell, whose form the content decides. The cell is then a pure function of (seed, cell, edits), so it comes back the same after it left, and a reload with the same edits gives the same bytes.

- An `EditableCellGenerator` is `(seed, cell, edits?) => CellContent`. With no edits or `''` it must give the same bytes as the call without them. A plain `CellGenerator` takes no edits; the two are separate types so a generator whose own optional third argument means something else stays a plain one.
- `GeneratorCellProvider(seed, gen, edits)` and `WorkerCellProvider(url, seed, size, edits)` take a `CellEdits` source, `(cell) => string`, read when a request starts. A non-empty text goes to the generator as its third argument; with `''` the call is exactly `gen(seed, cell)`. `serveCellGenerator` in the worker passes it on.
- `StreamingManager.refresh(cells)` marks cells whose content is out of date and returns how many tracked cells it touched. A job in flight is cancelled (its late result is stale) and requested again. A MESHED cell is forgotten (listed in the next step's `evictions`). A RESIDENT cell stays drawn with its old content; the next step requests it ahead of every other candidate, and when its new content arrives `complete` leaves it RESIDENT. The execution part then swaps the GPU data and calls `swapped(cell, gpuBytes)`, so the cell never leaves the picture. A refreshing cell that stops being wanted is simply forgotten.
- `refreshes()` gives the cells still waiting for new content (`pending`) and all cells refresh touched (`total`). `settled` waits for the pending ones.
- `StreamedWorld.refresh(cells)` does all of it on the GPU side: swap, `onResident` with the new content, shadows drawn again. `busy` stays true while a refresh is pending.

Without a call to `refresh` the manager takes exactly the decisions it took before; the golden test of the engine ("streaming refresh") checks that and the cases above. `FileCellProvider` and `CachedCellProvider` know nothing of edits: a cache keeps the cells as first built, so keep edited cells out of it (or put the edits in its version).

<!-- check: wrap -->
```ts
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import type { StreamedWorld } from 'wallhammer-web/runtime';
import { GeneratorCellProvider } from 'wallhammer-web/world';

declare function generate(seed: number, cell: CellId, edits?: string): CellContent;
declare function editsOf(cell: CellId): string; // e.g. CellStates.text(cell) of sim/destruction
declare const world: StreamedWorld; // streams from `provider`
declare const changed: CellId[]; // the cells that draw what changed
const provider = new GeneratorCellProvider(7, generate, editsOf);
world.refresh(changed);
const { pending, total } = world.manager.refreshes();
```

## A ceiling of GPU memory

`memoryBudgetBytes` bounds what the streamed cells hold on the CPU and the GPU together, and forgets cells that are no longer wanted. A ceiling of GPU memory is a second, separate limit that also counts what is not a cell. It is off by default.

- `StreamedWorldOptions.gpuCeilingBytes` switches it on. Before every step the layer reads `Device.memory().total`, subtracts the cells' own bytes and gives the rest to the manager as `gpuReserveBytes`, so the ceiling holds for everything the page has on the GPU.
- Over the ceiling the manager takes cells off the GPU: first cells kept only by hysteresis, the one wanted longest ago first; then wanted cells from the least urgent. Their CPU data stays, so they come back without a new job.
- Cells kept only by hysteresis also leave when the waiting uploads would not fit beside them, so a cell nobody wants never holds a wanted one back.
- An upload that would not fit waits, and its parent stays drawn in its place.
- Cells of the coarsest level are exempt both ways: the cover of last resort is never dropped, so the ceiling cannot make a hole. Their size is the floor of what the ceiling can reach.

<!-- check: wrap -->
```ts
import type { StreamedWorld } from 'wallhammer-web/runtime';

declare const world: StreamedWorld; // created with gpuCeilingBytes: 512 * 1024 * 1024
const { released, deferred } = world.manager.gpuPressure();
const held = world.renderer.device.memory().total;
```

The manager alone takes the same limit as `StreamingConfig.gpuBudgetBytes`. The golden test of the engine ("streaming GPU ceiling") pans for 18 km under a ceiling and checks the bytes after every step.

`StreamedWorld` also takes textures and uniforms per material name (`textures`, `materialUniforms`; both stay reachable as fields and can be changed at any time) and reports cells that reach or leave the GPU (`onResident`, `onReleased`), for code that writes into a cell's buffers. Materials of one streamed layer are drawn in the order of their names without the draw state being reset between them, so give every material of a layer that mixes states its full state.

## Baking cells to files

The endless example can bake cells and verify them. Both run inside its `endless` container:

```sh
docker compose exec -T endless sh -c 'cd /app/examples/endless && pnpm bake'
docker compose exec -T endless sh -c 'cd /app/examples/endless && pnpm verify'
```

`bake` writes into `examples/endless/public/cells/`. Open the example with `#src=files` to read them.

## Known weaknesses

From the project's status notes:

- Clouds, fog and sky shift slightly when the render origin is rebased. With `originAxes: 'all'` this also happens on a change of height, and the environment still takes its heights (fog layer, cloud deck) in render space.
- Without `morph`, level-of-detail changes are visible as jumps. With it, the surface and instances that carry a shift blend; instances still appear at once at the level that first holds them unless their material scales them by the blend (see [Blending between levels](#blending-between-levels)).
- When the budget of cells changes the detail, all blend ranges change by one step (16 %) in the same frame.
- The blend is measured from one viewer. Cells split only because of another ticket (a predicted point far ahead) meet their coarser neighbours with a small step that the skirt covers.
- The render origin of `StreamedWorld` follows the focus in x and z only, unless it is created with `originAxes: 'all'`.
- Two world shapes exist: the flat one and `SphereWorld` (see [A sphere world](#a-sphere-world) for its limits).
