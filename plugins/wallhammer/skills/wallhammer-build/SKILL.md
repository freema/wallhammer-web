---
name: wallhammer-build
description: Write or change code of a project built on the wallhammer-web npm package (a WebGL2 engine where every mesh and texture is made by code) - a scene, terrain, a streamed world, houses from footprints, weather and time of day, a walking figure and follow camera, destruction, vehicles and people on schedules, the project's own place data, performance. Read the engine's agent page first, keep its rules (no images or 3D libraries, randomness from named hash streams, pure generators, cells relative to their origin), take the cookbook recipe for the goal and verify with the project's own checks. Typical requests "add terrain", "make a town from these footprints", "stream the world", "add rain", "let the player walk", "make it breakable", "a bus on a loop", "why is it slow", "which wallhammer module do I use".
---

# Building on Wallhammer Web

The engine ships its documentation in the package. In a project that installed it, everything below is under
`node_modules/wallhammer-web/docs/` and matches the installed version. Never write engine calls from memory; read
the page or the type declaration (`node_modules/wallhammer-web/dist/<module>/index.d.ts`).

## First, every time

1. Read `node_modules/wallhammer-web/docs/agents.md` (about 120 lines): what the engine is, the rules, the table
   goal → entry → page → example, the module map and debugging.
2. Read the recipe for the goal in `node_modules/wallhammer-web/docs/cookbook.md` (table below), then the reference
   page it links. Copy its code as the starting point: it is type-checked against the package.
3. Look at the project's own code before adding to it: how it creates the engine (`createEngine` options, slots,
   palette), which rig it uses, where its generators and data live.

## The rules

- No images, model files or 3D/graphics libraries (three.js, Babylon, glTF loaders, PNG textures). Meshes come from
  `gen-mesh`, the content modules or the project's own generators; textures from `gen-tex`.
- Randomness only from named hash streams of `wallhammer-web/gen-core` (`streamSeed`, `hashInts`, `rand`), keyed by
  ids or coordinates from the input. Never `Math.random`, `Date.now` or `performance.now` for content or simulation.
- Generators are pure: input and seed in, plain data out. No GPU, DOM or clock inside.
- Streamed cell content is relative to the cell origin; heights and colours from world coordinates so neighbours
  agree; draw beside a streamed world through `world.toRender`.
- Outcome-relevant state lives in the `Simulation`; the image reads it in `engine.onExtract(alpha)`.
- `motion`, `render`, `sim`, `sim/destruction`, `runtime` and the content modules are not in the root entry; import
  them from `wallhammer-web/<module>`.
- Never edit `node_modules/wallhammer-web`. If the engine lacks something, write it in the project on top of the
  public entries, and tell the developer what was missing (it may belong upstream).

## Where things go in the project

| What | Where |
| --- | --- |
| Pure generators (terrain, placement, cells) | their own modules, importing only the `gen-*`, `base` and `world` entries; no DOM |
| A cell worker | its own file, `serveCellGenerator(generateCell)`; in Vite pass `import url from './cell-worker.ts?worker&url'` |
| Materials (GLSL) | next to the layer that draws with them |
| Place data (footprints, roads, timetables) | `data/` or `public/` of the project, prepared offline to local metres with stable ids |
| Wiring (engine, layers, input, UI) | the page's `main.ts` |
| Tests | the project's own: hash generator output for fixed seeds and compare |

## Recipe by goal

Sections of `cookbook.md`:

| Goal | Recipe |
| --- | --- |
| Endless or large world, workers | A world that loads only around the player |
| Hills, ground the walker stands on | Terrain with hills |
| Houses, a village or a town | Houses from footprints |
| Sun, day, rain, snow, seasons | Time of day, weather and seasons |
| A player who walks, third-person camera | A walking figure with a follow camera |
| Breakable houses, kicked props | Things you can kick or break |
| Buses, people, timetables | Vehicles and people on schedules |
| A real or designed place | Your own place data |
| Frame time, memory, budgets | Performance and budgets |
| "This spot looks wrong" | Debugging with marks (and the `wallhammer-marks` skill) |

A goal not in the table: the table "I want …" in `agents.md`, then `reference.md` for the names of each entry.
Extending the engine's own patterns (a layer, a material, an environment slot): `recipes.md`.

## Verify

1. Run the project's own checks: its type check (`tsc --noEmit` or the script in `package.json`), its tests and
   its build. Report what passed, what failed and what was not run.
2. Open the page in the dev server and look; nothing checks GLSL before it runs, so read the browser console.
3. For determinism, generate twice with the same seed and compare a hash of the output.
4. If the project has marks (`.marks/`, `wallhammer-web/marks-store` in `vite.config.ts`), set the marks you
   worked on as the `wallhammer-marks` skill says.
