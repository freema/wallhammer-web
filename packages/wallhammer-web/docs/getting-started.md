# Getting started

This page runs the existing examples, then builds a small scene from nothing. Read [Concepts](concepts.md) next.

## Run what exists

Everything runs in Docker. Node is not needed on the host. From the repository root:

```sh
docker compose up -d
docker compose ps
```

| Service | URL | What it is |
| --- | --- | --- |
| `dev` | http://localhost:5281 | Installs the workspace dependencies, serves every example and stays up for the checks. `/` lists the examples, `/<name>/` opens the one in `examples/<name>`. Another host port: `EXAMPLES_PORT`. |

The `dev` service is healthy once the dependencies are installed and the example server answers (`tools/serve/serve.ts`). Every example keeps its own Vite dev server with live reload, started on the first request for it; source edits reload the page, and the dev servers poll the mounted files (`WH_POLL=1`).

Logs:

```sh
docker compose logs --tail 50 dev
```

Run any workspace command inside the `dev` container. The workspace root is `/app`, which is the repository root on the host:

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'
```

To use the engine in a project of your own, install the published package (`npm install wallhammer-web`) and import its entries (`wallhammer-web/runtime`, `wallhammer-web/render`, …) from code built by a bundler such as Vite.

## The smallest scene

`createEngine` (in `wallhammer-web/runtime`) builds the device, the renderer, the environment, the Frame block and the frame loop in the right order. You add layers and start it.

The scene below is a noise hill under a sun. It uses one generator (`heightFieldMesh`), one material and one `MeshLayer`.

```ts
import { HEIGHT_FIELD_ATTRIBS, HeightField, PerspectiveOrbitRig, definePalette, heightFieldMesh, streamSeed, valueNoise2 } from 'wallhammer-web';
import type { MaterialDesc } from 'wallhammer-web/base';
import { MeshLayer } from 'wallhammer-web/render';
import { createEngine } from 'wallhammer-web/runtime';

// 1. Data. A generator is a pure function of its input and a seed.
const SIZE_M = 128;
const STEP_M = 2;
const n = SIZE_M / STEP_M + 1;
const seed = streamSeed('demo', 'ground');
const heights = new Float32Array(n * n);
for (let j = 0; j < n; j++) {
  for (let i = 0; i < n; i++) heights[j * n + i] = 12 * valueNoise2(i * STEP_M, j * STEP_M, 40, seed);
}
const field = new HeightField(STEP_M, n, n, heights);

// 2. A material: attribute locations and GLSL per pass. 'depth' uses the shared shadow programs.
const GROUND: MaterialDesc = {
  name: 'ground',
  attribs: HEIGHT_FIELD_ATTRIBS,
  passes: {
    shadow: 'depth',
    color: {
      vs: `#include <header>
in vec3 a_pos;
in vec4 a_normal;
out vec3 v_world;
out vec3 v_normal;
void main() {
  v_world = a_pos;
  v_normal = a_normal.xyz;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`,
      fs: `#include <header>
#include <noise>
#include <lighting>
in vec3 v_world;
in vec3 v_normal;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 1.0);
  vec3 c = toDisplay(vec3(0.45, 0.47, 0.3) * lightOn(n, sun, 1.0));
  o_color = vec4(applyFog(c, v_world), 1.0);
}`,
    },
  },
};

// 3. The engine.
const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('canvas')!,
  view: new PerspectiveOrbitRig({ fovYDeg: 45, minDistance: 20, maxDistance: 400 }, { yawDeg: 30, pitchDeg: 30, distance: 180 }),
  palette: definePalette({ sky: '#8fb2c9' }),
  background: [0.56, 0.7, 0.79],
  environment: { mode: 'day', hour: 15 },
  orbitControls: true,
});
const { renderer, view } = engine;
view.target = [SIZE_M / 2, 0, SIZE_M / 2];
renderer.bounds = { min: [0, field.minY - 4, 0], max: [SIZE_M, field.maxY, SIZE_M] };

// 4. Upload through the renderer and add a layer.
const material = renderer.material(GROUND);
engine.add(new MeshLayer({ material, mesh: renderer.createMesh(heightFieldMesh(field, field.minY - 4), material) }));
engine.start();
```

Things to notice:

- `renderer.bounds` must be set. With `bounds = null` the renderer draws only the background. The shadow map is fitted to the bounds.
- Every shader starts with `#include <header>`. It adds `#version 300 es`, precision, the Frame uniform block and the palette block. `#include <lighting>` adds `sunVisibility`, `lightOn`, `applyFog` and `toDisplay`. It needs `<noise>` before it, because includes do not nest. See [Rendering](rendering.md#shader-includes).
- `HEIGHT_FIELD_ATTRIBS` fixes the attribute locations that the mesh layout and the material share.
- The engine draws on demand. It redraws on input, on resize and while a clock runs. Call `engine.invalidate()` after you change something yourself.

## Where to look next

- [Recipes](recipes.md) has short, checked samples for the common extensions; [Draw moving copies with instance sets](recipes.md#draw-moving-copies-with-instance-sets) shows `instanceSet`, `writeInstance`, `pushInstance` and `InstanceSetLayer` with their material.
- `examples/minimal-3d/src/main.ts` is the same pattern with instancing, an environment slot, the sky and the simulation.
- `examples/endless/src/main.ts` streams an endless world.
- `examples/planet/src/main.ts` joins the sphere world, the atmosphere and the free camera in one flight ([The planet example](planet.md)).
- `examples/system/src/main.ts` adds a system of bodies and hands the camera from the frame of one body to the next ([The system example](system.md)).
- `examples/destruction/src/main.ts` uses `gen-arch` and `sim/destruction`.
