# Headless use

Much of the engine runs in plain Node, without a browser or a GPU. The golden test and the bake script of the endless example rely on this.

## What runs in Node

| Module | In Node? | Notes |
| --- | --- | --- |
| `base`, `core`, `gen-core` | yes | `core` includes the medium below a level (`mediumPath` and the others). |
| `gen-mesh`, `gen-tex` | yes | They return data, the noise volumes on the CPU included (`noiseVolumeData`). |
| `gen-arch`, `gen-ground`, `gen-vegetation` | yes | They return data and `BakeDesc`s. A bake itself needs the GPU. |
| `env` | yes | `Environment`, `assembleFrameBlock`, sun position, sky values, the atmosphere's tables, and the cloud volume, weather and shadow arithmetic (`cloudVolume…`, `cloudWeatherKind`, `cloudShadowProjection`). |
| `world` | yes | Picking, `StreamingManager`, providers, WHC1 encoding. |
| `sim`, `sim/destruction` | yes | Enforced: `sim` may import only `base`, `core`, `gen-core`. |
| `camera` | yes | Rigs are math. |
| `runtime` | partly | `createHeadlessEngine` only. `createEngine`, `StreamedWorld` and the layers need a canvas. |
| `platform`, `gpu`, `render`, `tools` | no | Browser or WebGL. |

Node 22.18 or newer runs the `.ts` sources directly (type stripping). The workspace uses this: `node tools/golden/golden.ts`. Import engine sources by relative path from tools inside the workspace, as the golden test does, or by the package name from a workspace package that depends on `wallhammer-web`.

## `createHeadlessEngine`

The same mediator without canvas and GPU. It steps the simulation and the environment clocks.

<!-- check: wrap -->
```ts
import { Simulation } from 'wallhammer-web/sim';
import { createHeadlessEngine } from 'wallhammer-web/runtime';

const sim = new Simulation({ seed: 'test' });
const engine = createHeadlessEngine({ sim, environment: { animate: false } });
engine.onExtract((alpha) => {
  // read interpolated state here, as a renderer would
});
for (let i = 0; i < 100; i++) engine.frame(1 / 60); // returns how many ticks ran
const hash = engine.sim.stateHash();
engine.dispose();
```

Members: `sim`, `env`, `onInput`, `onExtract`, `system`, `command`, `frame(realSeconds)`, `extract()`, `dispose()`. It produces no image.

`tools/golden/engine/sim-scenario.ts` uses it to prove that different frame patterns (many short frames, few long ones) give the same simulation.

## What needs a GPU

- Any image, including bakes (`renderer.bake`, for example the `gen-ground` ground bake).
- Shader compile errors. Type checks and golden hashes do not compile GLSL. A broken shader shows in the browser console, or in `tools/shot/shader-check.mjs` ([Shader check](tools.md#shader-check)), which compiles every program a page makes in headless Chromium on the software renderer.
- Shadow fitting, culling by `InstancedLayer`, the data view.

To check those, open the page or take a screenshot ([Tools](tools.md#screenshots)).
