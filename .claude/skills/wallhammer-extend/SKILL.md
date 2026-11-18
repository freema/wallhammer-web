---
name: wallhammer-extend
description: Change or extend the Wallhammer Web engine (packages/wallhammer-web) or the examples built on it - a new layer, material, shader, environment slot, generator, simulation system, destructible structure or streamed cell provider - while keeping its layer rules, determinism and abstraction. Use before writing engine or example code. Typical requests (Czech) "přidej do enginu", "nová vrstva", "nový materiál", "nový shader", "nový generátor", "přidej slot prostředí", "přidej systém do simulace", "kam to mám dát", "jak se to dělá ve wallhammeru", "rozšiř engine".
---

# Extend Wallhammer Web

Read the matching page first; every sample there is type-checked:

| Task | Read |
| --- | --- |
| Where code belongs, import rules | `packages/wallhammer-web/docs/architecture.md` |
| Data contracts, determinism, frame order | `packages/wallhammer-web/docs/concepts.md` |
| Layer, material, shader include, Frame block, slot | `packages/wallhammer-web/docs/rendering.md` |
| Generator | `packages/wallhammer-web/docs/generators.md` |
| Simulation system, commands, movers | `packages/wallhammer-web/docs/simulation.md` |
| Walking: collision world, walker, follow camera | `packages/wallhammer-web/docs/walking.md` |
| Motion: skeletons, poses, motion graph, reach | `packages/wallhammer-web/docs/motion.md` |
| Destruction | `packages/wallhammer-web/docs/destruction.md` |
| Streaming, cell providers | `packages/wallhammer-web/docs/streaming.md` |
| Worked samples of all of the above | `packages/wallhammer-web/docs/recipes.md` |
| Every export | `packages/wallhammer-web/docs/reference.md` |

## Placement in one minute

- Layers: `base` 0, `platform` 1, `core`/`gen-core`/`motion` 2, `gen-mesh`/`gen-tex`/`gen-arch`/`gen-ground`/`gen-vegetation`/`gen-plan` 3, `gpu` 4, `render`/`camera`/`env`/`world`/`sim` 5, `runtime` 6, `tools` 7. Import only lower layers, never the same layer.
- WebGL only in `gpu`. DOM, workers and `window` only in `platform`.
- Engine modules outside the content modules (`gen-arch`, `gen-ground`, `gen-vegetation`) must not name a use case (city, building, roof, facade, tree, car, road, window, …) in file names, exported names or comments. Name the mechanism instead; the project gives it meaning.
- Content (structures, ground and markings, vegetation) goes to `gen-arch`, `gen-ground` or `gen-vegetation`. They import only `base`, `core`, `gen-core`, `gen-mesh`, `gen-tex`, never each other. A module may group its files in subfolders behind one `index.ts`. In `gen-arch` they depend one way, `structure` <- `interior` <- `damage` <- root files (`build.ts`, `index.ts`): a file imports only its own subfolder and earlier ones (layer rule `subfolder-order`, table `SUBFOLDER_ORDER`).
- The engine-only examples (`minimal-3d`, `endless`, `planet`, `fantasy-village`, `walk`, `outpost`; list `ENGINE_ONLY_EXAMPLES` in `tools/layers/check.ts`) must not import the content modules; `destruction` and `system` use `gen-arch` and `sim/destruction`.
- Project-specific code (the data of one place, texts of a user interface, concrete people and vehicle rigs) belongs in the project that uses the engine, never in the engine. An example keeps its own content in its own folder.
- No graphics library and no loaded images: plain WebGL2, all graphics from code.

## Rules that are easy to break

- Generators are pure: output from input plus seed. Use `hashInts` over input keys; never `Math.random`, `Date` or `performance.now`. Only `sim` is machine-checked for this; review generators yourself.
- `sim` uses integer millimetres and ticks, no transcendental `Math` functions, and imports only `base`, `core`, `gen-core`.
- Shader includes do not nest. Write `#include <header>`, `<noise>`, `<lighting>`, `<sky>` in that order, each on its own line.
- Environment slots are fixed when the engine is created; pass them to `createEngine({ slots })`.
- `Layer.cull` runs only when the shadow map is refitted.
- Code comments in English.
- The source imports with `.ts` extensions and uses only erasable TypeScript syntax (no enums, no parameter properties), so Node runs it as it is and `tsc` rewrites the extensions for the published build.
- The package is published: a removed or renamed export, a changed signature or a new entry in `exports` (which needs its twin in `publishConfig.exports`) is a change for its users. Say so to the user; the version in `packages/wallhammer-web/package.json` is theirs to bump.

## After the change

1. Run the checks (skill `wallhammer-verify`).
2. A new or changed generator: add or update a golden recipe, in `tools/golden/engine/golden.ts` for the engine alone, in `tools/golden/golden.ts` when it needs example code; ask the user before accepting hashes.
3. A new public export: add it to `packages/wallhammer-web/docs/reference.md` and, if it is a new concept, to the matching guide. `pnpm check:docs` must pass.
4. A new entry (`wallhammer-web/<module>`): add it to `exports` and to `publishConfig.exports` in the package's `package.json`, then run `pnpm check:pack`.
5. Shader changes: open an example page (skill `wallhammer-run`) and check the browser console; no check compiles GLSL.
