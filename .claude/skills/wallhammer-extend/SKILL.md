---
name: wallhammer-extend
description: Change or extend the Wallhammer Web engine (packages/wallhammer-web) or the examples built on it - a new layer, material, shader, environment slot, weather or sky feature, generator, simulation system, walker behaviour, destructible structure, streamed cell provider or a new example - while keeping its layer rules, determinism and abstraction. Use before writing engine or example code. Typical requests "add it to the engine", "a new layer", "a new material", "a new shader", "a new generator", "add an environment slot", "change the weather", "add a system to the simulation", "a new example", "where should this go", "how is this done in wallhammer", "extend the engine".
---

# Extend Wallhammer Web

Read the matching page first; every sample there is type-checked:

| Task | Read |
| --- | --- |
| Where code belongs, import rules | `packages/wallhammer-web/docs/architecture.md` |
| Data contracts, determinism, frame order | `packages/wallhammer-web/docs/concepts.md` |
| Layer, material, shader include, Frame block | `packages/wallhammer-web/docs/rendering.md` |
| Time, sun, sky, atmosphere, weather, clouds (the overview table at the top of "Clouds"), fog, wind, seasons, environment slots | `packages/wallhammer-web/docs/environment.md` |
| A medium below a level, a moving surface of waves, noise volumes, fixed texture units | `packages/wallhammer-web/docs/rendering.md` |
| Generator | `packages/wallhammer-web/docs/generators.md` |
| Simulation system, commands, movers | `packages/wallhammer-web/docs/simulation.md` |
| Cameras, the `View` contract, input binding | `packages/wallhammer-web/docs/cameras.md` |
| Rigs and actors (instanced, posed in the vertex shader) | `packages/wallhammer-web/docs/rigs.md` |
| Walking: collision world, walker, follow camera | `packages/wallhammer-web/docs/walking.md` |
| Motion: skeletons, poses, motion graph, reach | `packages/wallhammer-web/docs/motion.md` |
| Destruction | `packages/wallhammer-web/docs/destruction.md` |
| Streaming, cell providers | `packages/wallhammer-web/docs/streaming.md` |
| Bodies on rails, nested frames; the planet and system examples | `packages/wallhammer-web/docs/frames.md`, `planet.md`, `system.md` |
| What runs in plain Node | `packages/wallhammer-web/docs/headless.md` |
| Checks, golden recipes, frame profile | `packages/wallhammer-web/docs/tools.md` |
| Worked samples of all of the above | `packages/wallhammer-web/docs/recipes.md` |
| Every export | `packages/wallhammer-web/docs/reference.md` |

## Placement in one minute

- Layers: `base` 0, `platform` 1, `core`/`gen-core`/`motion` 2, `gen-mesh`/`gen-tex`/`gen-arch`/`gen-ground`/`gen-vegetation`/`gen-plan` 3, `gpu` 4, `render`/`camera`/`env`/`world`/`sim` 5, `runtime` 6, `tools` 7. Import only lower layers, never the same layer.
- WebGL only in `gpu`. DOM, the Worker API and `window` only in `platform`.
- Engine modules outside the content modules (`gen-arch`, `gen-ground`, `gen-vegetation`) must not name a use case (city, building, roof, facade, tree, car, road, window, …) in file names, exported names or comments. Name the mechanism instead; the project gives it meaning.
- Content (structures, ground and markings, vegetation) goes to `gen-arch`, `gen-ground` or `gen-vegetation`. They import only `base`, `core`, `gen-core`, `gen-mesh`, `gen-tex`, never each other. A module may group its files in subfolders behind one `index.ts`. In `gen-arch` they depend one way, `structure` <- `interior` <- `damage` <- root files (`build.ts`, `index.ts`): a file imports only its own subfolder and earlier ones (layer rule `subfolder-order`, table `SUBFOLDER_ORDER`).
- The engine-only examples (`minimal-3d`, `endless`, `planet`, `fantasy-village`, `walk`, `outpost`, `rivers`; list `ENGINE_ONLY_EXAMPLES` in `tools/layers/check.ts`) must not import the content modules; `destruction` and `system` use `gen-arch` and `sim/destruction`.
- Project-specific code (the data of one place, texts of a user interface, concrete people and vehicle rigs) belongs in the project that uses the engine, never in the engine. An example keeps its own content in its own folder. Example code that more than one example uses goes to `examples/shared/src/` (a private workspace package without `index.html`, so it is neither listed nor built), imported by relative path with the `.ts` extension; it imports only the engine without its content modules, never an example, and its comments do not name an example (layer rule `example-imports`). Examples are private workspace packages and are never published; only `packages/wallhammer-web` is.
- No graphics library and no loaded images: plain WebGL2, all graphics from code.

## Where today's kinds of feature go

- **Clouds and weather.** A model (density, cover, light, a projection) goes to `env`, written twice with the same names: on the CPU and as GLSL (`CLOUD_VOLUME_GLSL`, `CLOUD_WEATHER_GLSL`). The layers and all GPU work go to `runtime` (`CloudVolumeLayer`, `CloudShadowLayer`, `CloudWeatherMap`, `CloudShellLayer`). Noise is made in `gen-tex` on the CPU (`noiseVolumeData`) and in `render` on the GPU (`NoiseVolumes`). Every CPU twin gets a golden recipe.
- **Small arithmetic shared by shaders and the CPU** (a medium below a level in `core/medium.ts`, a field of wave trains in `gen-core/waves.ts`, fades in `core`). Name it by the mechanism, never by what a project uses it for: "a medium below a level", "a moving surface of waves", not "sea" or "water". The content (an example, an app) picks the level, the colours and the trains, and owns the materials and layers that draw it (`examples/planet/src/sea.ts`).
- **A movie mode** belongs to the example, never to the engine: a pure function from the time to a pose (camera, hour, animation time), a player by the clock behind a key and `movie=1`, and members of `window.__wh` that hold the movie at a time for a frame-by-frame recording (`examples/planet/src/movie.ts`, `examples/fantasy-village/src/movie.ts`; skill `wallhammer-run` lists both sets of members). Do not rename the existing members.
- **Fixed texture units.** Some units are taken for a whole pass (the shadow map, the cloud shadow texture, the atmosphere's tables, the light horizon). Read the unit map in `rendering.md`, section "Known weak spots", before binding a texture in a layer, and give every new fixed unit a named constant and a row there.
- **Layer order.** `engine.add` keeps the volumetric clouds after the layers it adds and the precipitation last. A layer that blends and should be seen through the clouds (water, glass, far air shells) is added and then named in `engine.moveCloudsBefore(layer)`; the sky is placed with `engine.moveSkyBefore(layer)`.

## Rules that are easy to break

- Generators are pure: output from input plus seed. Use `hashInts` over input keys; never `Math.random`, `Date` or `performance.now`. Only `sim` is machine-checked for this; review generators yourself.
- `sim` uses integer millimetres and ticks, no transcendental `Math` functions, and imports only `base`, `core`, `gen-core`.
- Shader includes do not nest: list them yourself in dependency order, each alone on its line, usually `#include <header>`, `<noise>`, `<lighting>`, `<sky>`, then slot includes (`<atmosphere>` when used).
- Environment slots shape the Frame block, so they are fixed when the engine is created; pass them all to `createEngine({ slots })`.
- `Layer.cull` runs only when the shadow map is refitted.
- `Walker` does not steer or turn in the air by default (`DEFAULT_WALKER.airControl` 0, `airTurnSpeed` 0). A page that wants air control sets them in its own setup; do not change the defaults for one page.
- Everything in English: code, comments, documentation, READMEs and the strings an example shows.
- The source imports with `.ts` extensions and uses only erasable TypeScript syntax (no enums, no parameter properties), so Node runs it as it is and `tsc` rewrites the extensions for the published build.
- The package is published. A removed or renamed export, a changed signature, a changed default or a new entry in `exports` (which needs its twin in `publishConfig.exports`) is a change for its users: add a line under `Unreleased` in `CHANGELOG.md` and tell the user. While the version is 0.x, a breaking change (a changed default included) needs a minor version, never a patch. The version is the user's (skill `wallhammer-release`).

## A new example

1. `examples/<name>/` with `index.html` (its `<title>` names it in the index), `package.json` (private, `"wallhammer-web": "workspace:*"`, a `typecheck` script; its `description` is its line in the index), `tsconfig.json`, `vite.config.ts`, `README.md`, `src/`. Start from a similar example.
2. `vite.config.ts` uses `newFiles({ enabled: poll })` from `tools/vite/new-files.ts`. If the page hands a worker URL to the engine (`new URL('./x-worker.ts', import.meta.url)` to `WorkerPool` or `WorkerCellProvider`), add `workerUrls()` from `tools/vite/worker-urls.ts` and `worker: { format: 'es' }`, as `endless`, `planet` and `system` do. Without it the dev server works, but the production build (the live demos) ships workers that never start.
3. Expose `window.__wh` with at least `ready`, `presets()`, `setView(v)`, `getView()`, `settled()` and `stats()`, so the picture and measurement tools can drive it (skill `wallhammer-run`).
4. Engine only? Add it to `ENGINE_ONLY_EXAMPLES` in `tools/layers/check.ts`.
5. Docker: a `node_modules` volume and a directory in `Dockerfile.dev` (skill `wallhammer-run`).
6. Add it to the example lists in `README.md` (with its live link) and `CLAUDE.md`.

## After the change

1. Run the checks (skill `wallhammer-verify`); after a change to an example's build (Vite config, workers, pages) also `pnpm build:examples`.
2. A new or changed generator: add or update a golden recipe, in `tools/golden/engine/golden.ts` for the engine alone, in `tools/golden/golden.ts` when it needs example code; ask the user before accepting hashes. After a change in `examples/planet` or `examples/endless` also run that example's own `pnpm verify` (skill `wallhammer-verify`).
3. A new public export: add it to `packages/wallhammer-web/docs/reference.md`, to the matching guide if it is a new concept, and a line under `Unreleased` in `CHANGELOG.md`. `pnpm check:docs` must pass.
4. A new entry (`wallhammer-web/<module>`): add it to `exports` and to `publishConfig.exports` in the package's `package.json`, then run `pnpm check:pack`.
5. Shader changes: no check compiles GLSL. Open an example page and read the console, or take a `shot` picture; judge the look on the real GPU (skill `wallhammer-run`).
