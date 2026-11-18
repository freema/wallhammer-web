# Wallhammer Web

[![npm](https://img.shields.io/npm/v/wallhammer-web?logo=npm)](https://www.npmjs.com/package/wallhammer-web)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)
[![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![WebGL2](https://img.shields.io/badge/WebGL2-plain-990000)](https://developer.mozilla.org/docs/Web/API/WebGL2RenderingContext)

A small WebGL2 engine for the browser, written in strict TypeScript. It uses plain WebGL2 and no graphics library. All graphics come from code; the engine loads no images. One world unit is one metre, and y points up.

The engine knows nothing about any particular project. It provides a renderer that draws the layers it is given, view rigs, an environment model (time, sun, sky, weather) that projects extend with environment slots, stateless randomness, generic geometry, a deterministic fixed-step simulation and world streaming. Ground, vegetation and structures come from three optional content modules, `gen-arch`, `gen-ground` and `gen-vegetation`. Nothing else in the engine depends on them.

In this repository the package exports its TypeScript sources and the examples build them with Vite. The published npm package holds compiled JavaScript with type declarations (`dist/`) and these docs. Its only runtime dependency is `earcut`, used for roof triangulation in `gen-arch`.

```sh
npm install wallhammer-web
```

## Where the engine lives

The engine is developed in this repository, at `packages/wallhammer-web`. The repository is a pnpm workspace: the engine, its checks (`tools/`) and the examples that exercise it (`examples/`: `minimal-3d`, `destruction`, `endless`, `planet`, `system`, `fantasy-village`, `walk`, `outpost`), which import the package through the workspace, so a change here reaches them at once. Paths such as `examples/endless/...` in these docs are paths from the repository root.

Projects outside this repository use the published package or keep a copy of a fixed version. These docs name one such project, the campus app, as the place where a pattern is used at full size; its code is not part of this repository.

## Documentation

Start here:

- [Getting started](docs/getting-started.md): start the dev container and draw a first scene.
- [Architecture](docs/architecture.md): modules, layers, the import rules and what enforces them.
- [Concepts](docs/concepts.md): plain-data contracts, determinism, the palette, the frame order.

Guides:

- [Rendering](docs/rendering.md): renderer, layers, materials, includes, shadows, environment slots, the sky.
- [Cameras and views](docs/cameras.md): `SteppedOrthoRig`, `PerspectiveOrbitRig` and the `View` contract.
- [Generators](docs/generators.md): `gen-core`, `gen-mesh`, `gen-tex` and the content modules.
- [Simulation](docs/simulation.md): `Simulation`, commands, entity tables, navigation, movers and their collision modes, shared areas, agendas and states.
- [Rigs and actors](docs/rigs.md): instanced animated rigs, `RigLayer`, how an app defines people, vehicles and stop furniture as rigs.
- [Destruction](docs/destruction.md): destructible structures, events, staged collapse, falling pieces.
- [World streaming](docs/streaming.md): cells, providers, the streaming manager and `StreamedWorld`.
- [The planet example](docs/planet.md): the sphere world, the atmosphere, the free camera and the large depth range joined in one flight from the surface to orbit.
- [The system example](docs/system.md): a sun and four bodies on their paths, and one flight from the view of the whole system down to a surface, with the camera handed from frame to frame.
- [Headless use](docs/headless.md): what runs in plain Node without a GPU.
- [Bodies on rails and nested frames](docs/frames.md): reproducible trigonometry, orbits and spin from time, 64-bit frames and numbers relative to the eye for the GPU.
- [Tools](docs/tools.md): the layer check, golden hashes, the docs check, screenshots, benchmarks.

Lookup:

- [Reference](docs/reference.md): every subpath export with its main names.
- [Recipes](docs/recipes.md): add a layer, a material, an environment slot, a generator, a destructible structure, a streamed cell provider, an animated rig; drive entities with agendas; feed agendas from external data.

## Entries

Each engine module has its own entry, `wallhammer-web/<module>`. The root entry `wallhammer-web` re-exports `base`, `platform`, `core`, `gen-core`, `gen-mesh`, `gen-tex`, `gpu`, `camera`, `env`, `world` and `tools`. Import `render`, `sim`, `sim/destruction`, `runtime`, `gen-arch`, `gen-ground` and `gen-vegetation` from their own entries.

```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { createEngine } from 'wallhammer-web/runtime';

const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('canvas')!,
  view: new PerspectiveOrbitRig({ fovYDeg: 40, minDistance: 20, maxDistance: 200 }),
  palette: definePalette({ sky: '#6795b1' }),
  background: [0.4, 0.58, 0.69],
  orbitControls: true,
});
engine.start();
```

This draws only the background. [Getting started](docs/getting-started.md) adds a mesh.

## Rules in one paragraph

WebGL appears only in `gpu`. The browser DOM appears only in `platform`. A module imports only lower layers. Content modules import only the generator layers. Generators return plain data and never touch the GPU. Randomness comes from named hash streams, never from `Math.random`. `pnpm check:layers` enforces the import rules; [Architecture](docs/architecture.md) says which rules are checked and which are conventions only.

## Development

From the repository root, everything runs in Docker:

```sh
docker compose up -d
docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers'
docker compose exec -T dev sh -c 'cd /app && pnpm test:golden'
docker compose exec -T dev sh -c 'cd /app && pnpm check:docs'
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'
```

[Tools](docs/tools.md) explains each check. A change to the engine can also break an example; the examples have their own golden hashes (`tools/golden/`) and checks next to them.
