# Wallhammer Web for agents

The first page to read before writing code on `wallhammer-web`. It maps goals to modules, pages and examples, so
you read 150 lines instead of the whole documentation. The documentation ships in the package: in a project it is at
`node_modules/wallhammer-web/docs/` and always matches the installed version. Read the [Cookbook](cookbook.md) recipe for
your goal next, then the reference page it links. Never write engine calls from memory: open the page or the type.

## What the engine is

A small 3D engine for the browser on plain WebGL2, in strict TypeScript. It loads no images and no model files: every
mesh and texture is made by code, by generators that are pure functions of their input and a seed, so the same seed
gives the same world. Solids are low-poly; the look comes from materials (GLSL per pass), light, weather and the
environment. One unit is one metre, y is up. A deterministic fixed-step simulation, world streaming, walking and
destruction are part of it. The engine knows nothing about any project: content (a town, a game) is yours.

## Rules for code built on it

- **No images, no 3D or graphics library.** Meshes come from `gen-mesh`, the content modules or your own
  generators; textures from `gen-tex` or a bake. Do not add three.js, Babylon, glTF loaders or PNG textures.
- **Randomness only from named hash streams.** `streamSeed(worldSeed, 'stones')`, `hashInts`, `rand`, `randRange`
  of `gen-core`, keyed by integers from the input (a grid cell, an object id), never by a loop counter over output.
  Never `Math.random`, `Date.now` or `performance.now` in anything that decides content or simulation.
- **Generators are pure.** Input and seed in, plain data out (`MeshData`, `InstanceData`, `CellContent`). No GPU,
  no DOM, no shared mutable state, no clock. The renderer uploads (`renderer.createMesh`, `createInstances`).
- **Streamed cells are relative to their origin.** Positions inside a `CellContent` are metres from the cell's
  origin (`shape.origin(cell)`); world positions stay doubles on the CPU. A streamed world shifts the render origin
  (`world.origin`, `toRender`, `toWorld`): hand the GPU differences, never raw world coordinates far from 0.
- **Neighbouring cells agree on their border.** Compute heights and colours from world coordinates, never from the
  cell's own index; give objects ids from a hash of (seed, rule, anchor).
- **Simulation only through ticks.** State that decides the outcome lives in the `Simulation` (systems, states,
  commands); the image reads it only in `engine.onExtract(alpha)`.
- **Your data stays in your project.** Footprints, roads, timetables, UI texts and game rules are the project's,
  fed into the engine as plain arrays. Do not patch `node_modules/wallhammer-web`.
- **Draw on demand.** The loop draws on input, resize and running clocks only. After you change something yourself
  call `engine.invalidate()`; while something you move keeps moving use `engine.animateWhile(fn)`.

## I want …

| Goal | Import from | Read | Example |
| --- | --- | --- | --- |
| A first scene | `wallhammer-web`, `/render`, `/runtime` | [Getting started](getting-started.md#the-smallest-scene) | `minimal-3d` |
| A world that loads only around the player | `/gen-core`, `/world`, `/runtime` | [Cookbook](cookbook.md#a-world-that-loads-only-around-the-player), [Streaming](streaming.md) | `endless` |
| Terrain with hills | `/gen-core`, `/gen-mesh` | [Cookbook](cookbook.md#terrain-with-hills), [Generators](generators.md) | `minimal-3d`, `endless` |
| Houses from footprints | `/gen-arch` | [Cookbook](cookbook.md#houses-from-footprints), [gen-arch](generators.md#content-module-gen-arch) | `destruction` |
| Time of day, weather, seasons | `/env`, `/runtime`, `/gen-ground` | [Cookbook](cookbook.md#time-of-day-weather-and-seasons), [Environment](environment.md) | `planet`, `destruction` |
| A walking figure, follow camera | `/world`, `/camera`, `/platform` | [Cookbook](cookbook.md#a-walking-figure-with-a-follow-camera), [Walking](walking.md) | `movement` |
| A walker that slows uphill (and on stairs), faster down gentle slopes | `/world` (`uphillSpeedLoss`, `downhillSpeedGain`, `downhillSpeedLoss`, `slopeSpeedFloor`; off by default) | [Cookbook](cookbook.md#a-walker-that-slows-uphill), [Slopes and speed](walking.md#slopes-and-speed) | `movement` (the ramp, the stairs) |
| A body on wheels driven over the collision world (tyres, brakes, handbrake, hull against solids, bodies meeting) | `/world` (`WheeledBody`, `fourWheels`, `WheeledGroup`, `collideWheeledBodies`; `CollisionWorld.setBox`, `sphereContacts`), `/camera` (`FollowRig`) | [Cookbook](cookbook.md#a-body-on-wheels), [Wheeled body](wheeled.md) | `movement` (two cars, E at a door) |
| A body that crawls and glides (a leap, lift and drag, banked turns, a stall, beats, a flare, touch-downs, a hull against solids) | `/world` (`FlyingBody`, `newFlyingIntent`; `CollisionWorld.sphereContacts`), `/camera` (`FollowRig`) | [Cookbook](cookbook.md#a-body-that-crawls-and-glides), [Flying body](flying.md) | `movement` (the glider, E behind its left wing) |
| A figure carried by another (riding, a seat), hands and feet held at its points, getting on and off | `/motion` (`SeatTransition`, `SocketSeat`, `uprightTransform`, `TwoBoneReach.setTargetSocket`), `/world` (`releaseToWalker`, `CollisionWorld.firstStandSpot`) | [Cookbook](cookbook.md#a-body-carried-by-another), [Motion](motion.md#a-body-carried-by-another) | `movement` (the steed, E) |
| Several legs that step (walk, trot, gallop blended by speed), a trunk on the ground under them | `/motion` (`StepCycle`, `StepPattern`, `TwoBoneReach`) | [Cookbook](cookbook.md#legs-that-step), [Motion](motion.md#steps-of-several-legs) | `movement` (the steed) |
| One follow camera for the figure, its mount and its car | `/camera` (`FollowRig`), `/motion` (`SocketSeat.weight`) | [Cookbook](cookbook.md#a-follow-camera-for-a-carried-or-driven-body) | `movement` |
| Walking on a planet | `/world` (`ChartWalker`), `/camera` (`ChartFollowView`), `/base` (`SurfaceChart`) | [Walking on a sphere](walking.md#walking-on-a-sphere), [Cameras](cameras.md#on-a-sphere-chartfollowview) | `planet` (key `G`) |
| Trees and rocks of streamed cells that block the walker | `/base` (`InstanceSolid`), `/world` (`SolidIndex`, `SolidFeed`), `/runtime` (`streamSolids`) | [Solids of streamed cells](walking.md#solids-of-streamed-cells) | `planet` |
| Things you can kick or break | `/sim/destruction`, `/gen-arch`, `/core` | [Cookbook](cookbook.md#things-you-can-kick-or-break), [Destruction](destruction.md) | `destruction` |
| Vehicles and people on schedules | `/sim`, `/render` | [Cookbook](cookbook.md#vehicles-and-people-on-schedules), [Simulation](simulation.md) | `outpost`, `rivers` |
| Your own place data | your project → the above | [Cookbook](cookbook.md#your-own-place-data) | `destruction` (footprints) |
| Find what is slow | `/tools` | [Cookbook](cookbook.md#performance-and-budgets), [Tools](tools.md#frame-profile) | `fantasy-village` |
| Debug a generated world | `/runtime`, `/marks-store` | [Cookbook](cookbook.md#debugging-with-marks), [Marks](marks.md) | `endless`, `movement` |
| Skeletons and poses | `/motion` | [Motion](motion.md) | `outpost` |
| A figure that reaches, aims, holds, stands on a slope | `/motion` (`TwoBoneReach`, `ChainAim`, `SocketBlend`, `WeightFade`, `fitToGround` `align`) | [Motion](motion.md#reaching-aiming-and-holding-over-time) | `planet` (walk mode) |
| A body with weight (run-up, braking, wide turns at a run) and hair or a tail that lags behind | `/world` (`deceleration`, `runAcceleration`, `turnSpeedAtRun`, `retune`), `/motion` (`ChainLag`) | [Momentum](walking.md#momentum), [A chain that lags behind](motion.md#a-chain-that-lags-behind) | `movement` (key `P`), `planet` (walk mode, key `P`) |
| Animated people, vehicles as rigs | `/render` | [Rigs](rigs.md) | `minimal-3d` |
| A planet, orbits, a solar system | `/world`, `/env`, `/core` | [Planet](planet.md), [Frames](frames.md) | `planet`, `system` |
| Rivers and roads planned over a sphere, classes of rivers | `/gen-plan` (`channelOrder`, `channelFlow`, `classifyByThresholds`) | [gen-plan](generators.md#gen-plan-the-plan-of-a-sphere) | `rivers`, `system` |
| A material or a layer of your own | `/base`, `/render` | [Rendering](rendering.md), [Recipes](recipes.md) | any |

Examples are in the repository (<https://github.com/freema/wallhammer-web/tree/main/examples>), not in the npm package,
and run live at `https://freema.github.io/wallhammer-web/<name>/`. Their `src/main.ts` is the wiring to copy from.

## Module map

Each module is `wallhammer-web/<module>`. A module imports only lower layers; WebGL is only in `gpu`, the DOM only in
`platform`. **Not in the root entry** (import them from their own entry): `motion`, `gen-arch`, `gen-ground`,
`gen-vegetation`, `gen-plan`, `render`, `sim`, `sim/destruction`, `runtime`, `marks-store`.

| Entry | What it holds |
| --- | --- |
| `base` | Vector and 3 × 4 matrix math, plain-data contracts (`MeshData`, `MaterialDesc`, `InstanceSolid`, …), `View`, `Progress`, `SurfaceChart`, the mark record. |
| `platform` | Canvas, keys, pointer, gamepad (`bindWalkInput`, `bindFreeInput`), frame loop, workers, `fetchBytes`, the marks panel. |
| `core` | `Clock`, `definePalette`, ballistic tracks, orbits (`BodySystem`), level fades. |
| `gen-core` | Hash streams, value noise, polygons, `HeightField`, occupancy, cell ids, `FlatWorld`, near scatter. |
| `motion` | Skeletons, poses, blends, `MotionGraph`, reach and ground fit, reach, aim and sockets over time (`TwoBoneReach`, `ChainAim`, `SocketBlend`, `WeightFade`), a lagging chain (`ChainLag`), a body carried at a socket of another and getting on and off (`SocketSeat`, `SeatTransition`), steps of several legs (`StepCycle`). No motions of its own. |
| `gen-mesh` | `heightFieldMesh`, `cellSurfaceMesh`, `cellMorphMesh`, strips, prisms, `MeshBuilder` with `box`, `extrude`, `revolve`, `sweep`. |
| `gen-tex` | Code textures, colour ramps, `CodeStamp`, noise volumes. |
| `gen-arch` | Content: structures from recipes over footprints, destructible descriptions, rubble, falling pieces, lit windows. |
| `gen-ground` | Content: ground bake from surface classes, markings, the `season` and `snow` slots. |
| `gen-vegetation` | Content: tree placement, instanced trees with levels, the `sway` slot. |
| `gen-plan` | Coarse plans over a sphere: drainage, rivers and their classes (`channelOrder`, `channelFlow`), routes, sites, skylines. |
| `gpu` | `Device`: programs, buffers, textures, targets, GPU memory. You rarely touch it. |
| `render` | `Renderer` (`setShadowFit` narrows the shadows while running), `MeshLayer`, `InstancedLayer`, `InstanceCellLayer`, `InstanceSetLayer`, `TransientLayer`, `RigLayer`, particles, point lights. |
| `camera` | `PerspectiveOrbitRig`, `FreeRig`, `FollowRig`, `ChartFollowView` (a `FollowRig` on a sphere), `SteppedOrthoRig`, `OrbitPath`, `FreePath`. |
| `env` | `Environment`: clocks, sun, sky, atmosphere, weather, wind, clouds, fog, `weatherGround`, the sphere ground's shaders (with an `extra` channel). |
| `world` | `CollisionWorld`, `Walker` (with momentum and a slope effect on speed), `ChartWalker` (walking on a sphere), `WheeledBody` and `WheeledGroup` (bodies on wheel rays), `FlyingBody` (crawling and gliding), `SolidIndex` and `SolidFeed` (solids of streamed cells), picking (`marchRay`), `StreamingManager`, cell providers, the cell file format. |
| `sim` | `Simulation`, `EntityTable`, `NavGraph`, `Movers`, `Agendas`, `StateMachine`, `FlowNetwork`. |
| `sim/destruction` | The destruction model: events, support, rubble, state text and hash. |
| `runtime` | `createEngine`, `createHeadlessEngine`, `StreamedWorld`, `WorkerCellProvider`, `streamSolids`, sky, clouds, rain, `installEngineMarking`. |
| `tools` | `profileFrame`, the data view, `collisionLines`, mesh checks. |
| `marks-store` | Node only: the marks' Vite dev-server plugin `marksStore`; the `wallhammer-marks` command line. |

Full names per entry: [Reference](reference.md). Layers and rules: [Architecture](architecture.md).

## Debugging

**Use marks to debug your procedurally generated worlds.** Fly or walk to what looks wrong, press N, click it, type a
note. The mark keeps the point, the exact view and a picture; an agent lists the open marks, opens each at its view,
fixes, attaches an after-picture and sets it `fixed`; the developer accepts. Two lines set it up in a Vite project
whose engine draws through a `FreeRig`, a `FollowRig` or a `PerspectiveOrbitRig`:

- `marksStore()` from `wallhammer-web/marks-store` in `vite.config.ts` (marks go to `.marks/`; add it to `.gitignore`);
- `installEngineMarking(engine, { pick })` from `wallhammer-web/runtime` inside `if (import.meta.env.DEV)`, with
  `heightPick(heightAt)` over a height function or `collisionPick(world)` over a collision world. A page whose key N
  is taken passes `key`; one that keeps its own time passes `clocks: false` and puts the time in its `hash`.

Then, with the dev server running: `npx wallhammer-marks list --open`, `npx wallhammer-marks set m0001 --status seen
--by agent`. Agents never set `accepted` or `reopened`. All of it: [Marks](marks.md).

Other tools:

- **What is slow:** `profileFrame(renderer, view)` and `formatProfile` (`tools`) per layer and pass on the GPU at
  hand; `renderer.lastStats`; `world.stats()` of a streamed world; `device.memory()` ([Tools](tools.md#frame-profile)).
- **What the data says:** `DataView` (`tools`) draws ground classes and lines; `collisionLines(world)` draws the solids
  of a collision world ([Walking](walking.md#seeing-the-solids)).
- **Without a browser:** generators, `sim`, `world`, `env` and `camera` run in plain Node; `createHeadlessEngine`
  steps the simulation and the clocks. Hash generator output and compare it in your own tests ([Headless](headless.md)).
- **Shaders:** TypeScript checks do not compile GLSL. A broken shader of a program that is drawn throws in the
  browser console, but the engine checks a program only on its first use, so one that a page makes and does not draw
  yet stays silent. A headless-browser check of your own sees them all: before the page's scripts run, wrap
  `shaderSource`, `attachShader` and `linkProgram` of `WebGL2RenderingContext.prototype` to remember every shader and
  program, and after the load read `getShaderParameter(s, COMPILE_STATUS)` and `getProgramParameter(p, LINK_STATUS)`
  with their info logs. The engine's repository does it in
  [`tools/shot/shader-check.mjs`](https://github.com/freema/wallhammer-web/blob/main/tools/shot/shader-check.mjs), a
  reference script that is not part of the package ([Tools](tools.md#shader-check)).

## Read next

- [Cookbook](cookbook.md): recipes by goal, each with checked code, the example to open and the pitfalls.
- [Concepts](concepts.md): plain data, determinism, the palette, the Frame block, layers, the frame order.
- [Getting started](getting-started.md): the smallest scene, the material it needs.
- [Reference](reference.md): every export of every entry, one line each.
- [Recipes](recipes.md): extending the engine itself (a layer, a material, a slot, a generator).
