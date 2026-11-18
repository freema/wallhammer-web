# Architecture

The engine is one npm package, `wallhammer-web`, in `packages/wallhammer-web`. Each module is a folder under `src/` with an `index.ts` and its own entry `wallhammer-web/<module>`. A module may group its files in subfolders; they belong to the module. The workspace (the repository root) also holds the examples (`examples/*`) and the dev tools (`tools/*`).

## Layers

A module may import only modules of a **lower** layer. It may not import a module of its own layer.

| Layer | Module | Contents |
| --- | --- | --- |
| 0 | `base` | Vector math, the `View` contract, plain-data contracts (`MeshData`, `InstanceData`, `TextureData`, `VertexLayout`, `MaterialDesc`, `BakeDesc`, `DrawState`, `UniformValue`), the `EnvSlot` contract, destructible structure types, reproducible trigonometry (`detSinCosTurns`), nested 64-bit frames (`FrameSet`). |
| 1 | `platform` | The only place that touches the browser: canvas size, pointer, key and gamepad input (`bindWalkInput`), the frame loop, workers, `fetchBytes`. |
| 2 | `core` | `Clock`, the palette (`definePalette`), closed-form ballistic tracks for falling pieces, orbits and spin as functions of time (`BodySystem`). |
| 2 | `gen-core` | Hash-based randomness with named streams, value noise, polygon geometry, spatial fields (`HeightField`, `SegmentField`, `OutlineField`, `Occupancy`), instance cells (`splitInstanceCells`), cell ids and the flat world shape for streaming. |
| 2 | `motion` | Skeletons and poses as data (`Skeleton`, `Pose`, `boneMask`), blend and additive operations, world matrices (`solvePose`), a motion graph of states, transitions, layers, parameters, triggers and events at marks over motions the game writes (`MotionGraph`), a two-bone reach and ends kept on the ground. No motion of its own. See [Motion](motion.md). |
| 3 | `gen-mesh` | Mesh generators: `heightFieldMesh`, `lineMesh`, `cellSurfaceMesh`, `cellMorphMesh`. |
| 3 | `gen-tex` | Texture generators: `codeTexture`, `colorTable`, `boxBlur`. |
| 3 | `gen-arch` | Content module: structures from recipes, destructible descriptions, damaged meshes, interiors, rubble, falling pieces and their materials. Subfolders `structure/`, `interior/` and `damage/` in that one-way order, root files `build.ts` and `index.ts`; one entry. |
| 3 | `gen-ground` | Content module: ground bake from surface classes, markings, their materials, the season and snow slots. |
| 3 | `gen-vegetation` | Content module: vegetation placement and meshes, their material, the sway slot. |
| 3 | `gen-plan` | Coarse plans over a whole sphere: a grid of nodes at the middles of the cells of one cube-sphere level (`sphereGrid`, `gridNeighbours`, `gridSample`), drainage (`drainGrid`, `traceChannels`), lines over the sphere (`smoothLine`, `fallingGrade`, `limitGrade`, `lineAt`), least-cost ways and regions (`routeGrid`, `routeRegions`, `regionLinks`), picks of nodes by a score (`pickSites`, `gridSteps`), plots along lines on a plane (`plotsAlong`), an index from tiles to lines (`lineTiles`) and the skyline of a height field (`horizonField`, `gridHorizon`). Not a content module; imports only `base` and `gen-core`. |
| 4 | `gpu` | The only place with WebGL2: `Device`, programs, buffers, textures, meshes, bakes, GPU memory accounting. |
| 5 | `render` | `Renderer`, passes, the shadow map, `MeshLayer`, `PieceLayer`, `InstancedLayer`, `InstanceCellLayer`, `TransientLayer`, `RigLayer`, shader includes. |
| 5 | `camera` | `SteppedOrthoRig`, `PerspectiveOrbitRig`, `FreeRig`, `FollowRig` and keyframed orbit paths (`OrbitPath`). |
| 5 | `env` | `Environment` (clocks, sun, light, weather, wind, clouds), the `lighting` and sky GLSL, `assembleFrameBlock`. |
| 5 | `world` | Picking (`raycastHeightField`, `raycastPrisms`), the collision world (`CollisionWorld`) and a walker over it (`Walker`) and streaming without the GPU: `StreamingManager`, cell providers, the WHC1 cell file format. |
| 5 | `sim` | Deterministic fixed-step simulation that runs in plain Node. Submodule `sim/destruction`. |
| 6 | `runtime` | `createEngine`, `createHeadlessEngine`, `EnvironmentLink`, `SkyLayer`, `PrecipitationLayer`, `StreamedWorld`. |
| 7 | `tools` | Debugging aids: the data view, the frame profile. |

The root entry `wallhammer-web` re-exports `base`, `platform`, `core`, `gen-core`, `gen-mesh`, `gen-tex`, `gpu`, `camera`, `env`, `world` and `tools`. It does **not** re-export `motion`, `render`, `sim`, `runtime`, `gen-arch`, `gen-ground`, `gen-vegetation` or `gen-plan`. Import those from their own entries.

`sim/destruction` is a folder inside `sim`. The layer check treats it as part of `sim`.

## Content modules

`gen-arch`, `gen-ground` and `gen-vegetation` are content modules. They are the only engine modules that may name what they generate (structures, vegetation, markings). The rules:

- They import only `base`, `core`, `gen-core`, `gen-mesh` and `gen-tex`, and `earcut` from npm.
- They do not import each other, any app or the root entry.
- No other engine module imports them, and the root entry does not re-export them.

Apps and the `destruction` and `system` examples may import them (`system` for the structures of its settlements and their damage). The engine-only examples (`minimal-3d`, `endless`, `planet`, `fantasy-village`, `walk`, `outpost`) may not; the layer check enforces this.

`gen-ground` and `gen-vegetation` do not import each other, but their shaders share Frame members. Both slots they share belong to `gen-ground`: the terrain shader reads `u_season` from its season slot and includes `<snow>` from its snow slot, and the vegetation shader reads the same two (the structure shaders of `gen-arch` include `<snow>` as well). So the ground depends on nothing of the vegetation, and an app that draws vegetation registers the season and snow slots of `gen-ground` together with the sway slot.

### Subfolder order in `gen-arch`

The subfolders of `gen-arch` depend one way: `structure` <- `interior` <- `damage` <- module root. A file imports only its own subfolder and the ones before it: `structure` imports neither `interior` nor `damage`, and `interior` does not import `damage`. Type imports and re-exports count. The plan of one structure (`StructurePlan`) and the interior sizes (`INTERIOR_DIM`) live in `structure`, the falling-parts material in `damage`. The files directly in the module folder rank after all subfolders and may import every one of them: `build.ts` assembles the structure mesh (`buildBuildingMesh`) from the structure parts, the interior plan and the damage model, and `index.ts` is the entry. The layer check reads the order from `SUBFOLDER_ORDER`; a new subfolder must be given a place there.

## The engine stays abstract

Outside the content modules the engine must not name a use case. The layer check flags these words in file names, exported identifiers and comments of non-content engine modules: city, building, roof, facade, tree, leaf, crown, car, parking, kerb, road, pavement, crossing, window, river, lake, shore, coast, mountain, biome, village, town, settlement, flower, bridge, tower, mill, creature, animal (also plural forms, and façade with the cedilla). The list is `USE_CASE_WORDS` in `tools/layers/check.ts`. `window` is allowed in `platform`, where it is the browser global.

So a renderer feature is described in neutral terms ("instances", "surface classes", "transient pieces"), and the project or a content module gives it meaning.

## What `pnpm check:layers` enforces

`tools/layers/check.ts` walks `packages/wallhammer-web/src`, `examples/*` and, in a workspace that has them, `apps/*`. It does not walk `tools/`. Every finding is an error; there are no exceptions. Rule ids as they appear in the output:

| Rule | Meaning |
| --- | --- |
| `upward` | An engine module imports a higher layer. |
| `same-layer` | An engine module imports another module of its own layer. |
| `stray-file` | An engine source file sits outside a module folder (only `src/index.ts` may). Subfolders of a module are part of it. |
| `unknown-module` | An import points to an engine folder that is not a known module. |
| `engine-imports-content` | A non-content engine module or the root entry imports a content module, or the engine imports an app. |
| `content-imports-app` | A content module imports an app. |
| `content-imports-content` | One content module imports another. |
| `content-imports-engine` | A content module imports an engine module other than the generator layers. |
| `subfolder-order` | Inside `gen-arch`, a file imports a later subfolder or a root file (order `structure` <- `interior` <- `damage` <- root), or sits in a subfolder the order does not list. |
| `example-imports` | An example imports an app, or an engine-only example imports something other than the engine or imports a content module. |
| `webgl` | WebGL types or calls outside `gpu` (engine and examples). |
| `dom` | Browser DOM outside `platform` (engine). |
| `worker` | The Worker API outside `platform` (engine). |
| `use-case-word` | A use-case word (list above) in a non-content engine module. |
| `sim-headless` | `sim` imports anything but `base`, `core` and `gen-core`. |
| `sim-nondeterministic` | `sim` uses `Math.random`, `Date`, `performance.now` or a transcendental `Math` function (`sin`, `cos`, `atan2`, `exp`, `pow`, `hypot` and others). |

`pnpm check:layers:test` runs the check against a valid fixture and a known-bad fixture in `tools/layers/fixtures`.

### Conventions the check does not enforce

- **No `Math.random` and no wall clock in generators.** Only `sim` is checked for this. A generator that calls `Math.random` passes `check:layers`. The golden hashes catch it only if a golden recipe covers that generator.
- **Generators never touch the GPU.** This follows from the layers (generators are below `gpu`), so it is enforced indirectly.
- **Code comments are in English.** Not checked.
- **Apps.** The check reads app files only to find engine code that imports an app. No rule applies to an app's own imports or to WebGL use inside an app.

## Workspace layout

```text
packages/wallhammer-web/     the engine (this package)
  src/<module>/index.ts      one entry per module
  docs/                      this documentation
examples/minimal-3d/         engine-only example
examples/destruction/        engine + gen-arch example
examples/endless/            engine-only streaming example
examples/planet/             engine-only example: a sphere with an atmosphere, from its surface to orbit
examples/system/             example with content modules: a sun and four bodies, from the whole system to a surface
examples/fantasy-village/    engine-only example: a living village from code
examples/walk/               engine-only example: the walking test course
examples/outpost/            engine-only example: a lunar research outpost in a comic look
tools/layers/                the layer check
tools/golden/engine/         golden hashes of the engine's generators
tools/golden/                golden hashes that need example code
tools/docs/                  the documentation check
tools/pack/                  the check of the published package
tools/walk/, tools/follow-check/   the walking and follow-camera checks (plain Node)
tools/serve/, tools/vite/    the example server (one port for all examples) and the Vite plugins of the examples
tools/pages/                 the static build of the examples (the live demos on GitHub Pages)
tools/shot/, tools/bench/    screenshots and measurements of the example pages (run on the host)
```
