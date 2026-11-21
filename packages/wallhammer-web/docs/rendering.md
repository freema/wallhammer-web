# Rendering

The renderer lives in `wallhammer-web/render`. It draws a list of layers through four passes, owns the shadow map and compiles materials. The GPU itself is hidden in `wallhammer-web/gpu` (`Device`).

## Passes

| Pass | When | What |
| --- | --- | --- |
| `shadow` | Only when the shadow map must be refitted (see [Shadows](#shadows)). | Depth from the light. Programs read the light matrix as `u_lightRender`. |
| `color` | Every frame in the normal mode. | The image. |
| `data` | Every frame when `renderer.mode = 'data'`. | Flat data colours (the data view). Falls back to the `color` program when a material has no `data` program. `overlay` is skipped in this mode. |
| `overlay` | After `color`. | Things drawn on top. |

`ctx.pass` tells a layer which pass is running.

## Layers

A layer implements `Layer`:

```ts
import type { CullVolume, View } from 'wallhammer-web/base';
import type { DrawContext, Layer } from 'wallhammer-web/render';

class CountingLayer implements Layer {
  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color') return;
    // ctx.device draws; ctx.count(triangles) records a draw call in the frame statistics.
    ctx.count(0);
  }
  // Optional. Called only when the shadow map is refitted: first with the light's volume, then with the view's.
  cull(volume: CullVolume, purpose: 'shadow' | 'view', view: View): number {
    return 0;
  }
  // Optional. True makes the renderer refit and cull again this frame (for example after something was added).
  cullStale(): boolean {
    return false;
  }
}
```

A layer may also have `prepare(device, view)`. The renderer calls it once per frame that draws the scene, after the Frame block of the frame is uploaded and before the first pass. It is the place to fill a target of the layer's own: `device.colorTarget(width, height, count, format)` makes a target of `count` colour textures (`'rgba8'` or `'rgba16f'`; `null` where the graphics card cannot draw into the format), and `device.fill(target, program, uniforms?)` draws one triangle over all of it. `fill` changes the viewport and the draw state, so it belongs between passes, not inside `draw`.

Two more kinds of target are drawn one layer at a time, with `device.fillLayer(target, layer, program, uniforms?)` under the same rules as `fill` (pass the layer among the uniforms; the fragment shader writes every texel of it):

- `device.volumeTarget(width, height, depth, format)`: a 3D texture, `'r8'` or `'rgba8'`, read as a `highp sampler3D` with linear filtering, wrapping in all three axes. A layer is one z slice.
- `device.cubeTarget(size, format)`: a cube map, read as a `samplerCube`. A layer is one face, in the order +x, −x, +y, −y, +z, −z. WebGL2 always filters across the faces' edges, so a field drawn by direction has no seam.

Bind them with `device.volumeTexture(unit, target)` and `device.cubeTexture(unit, target)`. A unit holds a 2D, a 3D and a cube texture side by side, and a program must not read two kinds from one unit, so give each sampler a unit of its own (`device.fixSampler`). Both return null while the context is lost or past the device's limits (`MAX_3D_TEXTURE_SIZE`, `MAX_CUBE_MAP_TEXTURE_SIZE`). They count under `targets` in `memory()`, come back empty after a context loss, and `deleteLayeredTarget` deletes them.

Layers draw in the order they were added (`renderer.add`, or `engine.add`, which keeps the volumetric clouds, until `moveCloudsBefore`, and then the precipitation layer last). The pass base state is set before each layer and restored after it.

Ready-made layers (which one: a single mesh → `MeshLayer`; many meshes with their own boxes → `PieceLayer`; a few thousand instances → `InstancedLayer`; many thousands of instances over a large area → `InstanceCellLayer`):

- **`MeshLayer`**: one material, one mesh, uniforms, textures and an optional `bind` hook. Passes default to every pass the material has a program for. Textures bind to units 1, 2, … in order. Unit 0 (`SHADOW_MAP_UNIT`) holds the shadow map.
- **`PieceLayer`**: a `MeshLayer` with a list of pieces (`{ mesh, min, max }`) instead of one mesh. Each piece is culled by its axis-aligned box: against the light's volume for the shadow pass and against the view's volume for the others. Material, uniforms and textures are set once per pass, then each kept piece is one draw. `add` and `remove` mark the layer stale, so the next frame refits and culls again. `drawn` is the number of pieces in the last colour pass; `bytes` sums the pieces' GPU buffers. Use it for a scene built in separately generated tiles or chunks. Culling writes into arrays that grow only on `add`, so it allocates nothing. `order: 'front-to-back'` sorts the kept pieces by the depth of their box centre along the view when culling (default `'added'`, the order of `add`); `lights` gives each piece its own list of point lights (see [Point lights](#point-lights)).
- **`InstanceSetLayer`**, **`ParticleLayer`**: one mesh with a matrix per instance, and looping particles. See [Point lights, particles and instance sets](#point-lights-particles-and-instance-sets).
- **`InstanceCellLayer`**: instances split into cells by `splitInstanceCells` (`gen-core`). `addGroup(lods, cells, layout, uniforms?)` uploads one shape: each level of detail once, each (cell, tier) as an instance buffer, and a shared mesh per (cell, tier, level). On a refit each cell is culled as one box and picks its level of detail and thinning tier by its distance from the eye (`detail: CellDetail`, see `cellDetail`). Nothing is rewritten on the GPU afterwards. The shadow pass draws level 0. An orthographic view has no eye, so all cells use one distance from `orthoDistance(view)` (by default the distance at which a 45° perspective view of about 1100 pixels would show the same pixel size). `group.uniforms` is set before that group's draws.
- **`InstancedLayer`**: batches of instances with per-instance culling and levels of detail. Each instance is culled as an upright segment (`bounds.position`, `bounds.height`) widened by `bounds.radius`. Culling copies the kept instances into the GPU buffer. The shadow pass uses level 0; the colour pass asks `levelOfDetail()`.
- **`TransientLayer`**: batches of pieces on closed-form tracks driven by the clock in `u_time.x`, plus dust puffs. Nothing is integrated per frame, so pausing or scrubbing the clock shows the same pose. While a batch moves, the shadow map is redrawn every frame. Used for falling pieces ([Destruction](destruction.md)).

<!-- check: wrap -->
```ts
import type { InstanceData, MeshData } from 'wallhammer-web/base';
import { splitInstanceCells } from 'wallhammer-web/gen-core';
import { InstanceCellLayer, InstancedLayer, MeshLayer, PieceLayer } from 'wallhammer-web/render';
import type { Material, Renderer } from 'wallhammer-web/render';
declare const renderer: Renderer;
declare const material: Material;
declare const instancedMaterial: Material;
declare const ground: MeshData;
declare const shape: MeshData;
declare const shapeFar: MeshData;
declare const stones: InstanceData;
declare const tiles: { mesh: MeshData; min: [number, number, number]; max: [number, number, number] }[];

// One mesh with a uniform.
renderer.add(new MeshLayer({ material, mesh: renderer.createMesh(ground, material), uniforms: { u_albedo: { vec3: [0.6, 0.6, 0.5] } } }));

// Instances: base point at float 0, reach 1.5 m, 4 m tall.
const layer = new InstancedLayer(renderer.device, { material: instancedMaterial, bounds: { position: 0, radius: 1.5, height: 4 } });
const instances = renderer.createInstances(stones);
layer.batches = [{ lods: [renderer.createMesh(shape, instancedMaterial, instances)], instances, all: stones.data, uniforms: {} }];
renderer.add(layer);

// Tiles, each culled by its box. Pieces can arrive later (from workers); the next frame culls them in.
const tileLayer = new PieceLayer({ material });
for (const t of tiles) tileLayer.add({ mesh: renderer.createMesh(t.mesh, material), min: t.min, max: t.max });
renderer.add(tileLayer);

// Many instances over a large area: 256 m cells, the fine shape up to 150 m, thinned tiers from 600 m and 1500 m.
const bounds = { position: 0, radius: 1.5, height: 4 };
const cells = splitInstanceCells(stones.data, { stride: stones.layout.stride / 4, bounds, cellM: 256 });
const cellLayer = new InstanceCellLayer(renderer.device, { material: instancedMaterial, detail: { lodSteps: [150], tierSteps: [600, 1500] } });
cellLayer.addGroup([shapeFar, shape], cells, stones.layout);
renderer.add(cellLayer);
```

## Value layers

Three layers show numbers over a scene through a colour ramp. The engine does not know what the numbers mean: the caller gives values, a range and a ramp, and draws the legend itself.

- **`RasterValueLayer`**: a grid of values on a sheet over the ground. The sheet (`drapeTiles` over the height field) only carries the surface; which cell a fragment shows follows from its world position, so the grid and the sheet need not match in size or density. With `smooth` (default) values blend between cell centres, cells without a value take no part and the sheet ends half-way to them. With `lookup: { cells, rows }` a cell does not hold a value but names a table row (row + 1, 0 = nothing): areas of any outline, rasterised once, coloured from a table per time step, with a darkened border between rows.
- **`PointValueLayer`**: discs that face the view, one per point (x, y, z, radius in metres), coloured by a value per point; one instanced draw call. `sizeByValue` (0–1) lets the disc area follow the value, `minRadiusPx` keeps far points visible. By default the discs lie over the whole image; `depthTest: true` hides them behind nearer surfaces.
- **`ShapeValueLayer`**: prisms (`prismMesh`) tinted by the value of the table row each of them carries. Blended over what is already drawn, with depth and a polygon offset. Rows without a value are not drawn unless `neutral` gives them a colour.

What they share:

- **Values are 16-bit words** (`quantizeValues`): 0 means "no value", 1–65535 span `min`–`max` linearly. One `Uint16Array` per time step: one word per grid cell (row by row, row 0 first), per point, or per table row.
- **Time steps.** `show(a)` shows one step, `show(a, b, mix)` blends two; where only one of the two has a value it fades in or out. A step is recognised by its array, so walking through steps uploads one small texture per new step and showing a loaded one costs nothing. Keep one array per step and pass the same arrays again.
- **Style.** `setStyle({ opacity, range })`; `range` is the part of the value range the ramp spans (default `[0, 1]`), for a legend that zooms into the data. `setRamp` replaces the ramp of a raster layer.
- **Passes and order.** They draw in the `color` and `data` passes, never in the shadow pass, without light or haze, so a colour can be read against the legend. Register them after the layers they should lie on. Nothing of them exists until a layer is constructed, and `dispose()` frees its meshes and textures (take the layer out of the renderer yourself).
- **Coordinates.** The sheet, the points, the prisms and the corner of a grid are in the coordinates the renderer draws in. A scene drawn relative to a moving origin (`worldOrigin`) has to give them relative to that origin and build them again when it moves.

<!-- check: wrap -->
```ts
import { HeightField } from 'wallhammer-web/gen-core';
import { drapeEvery, drapeTiles, prismMesh } from 'wallhammer-web/gen-mesh';
import { VALUE_RAMPS, colorRamp, quantizeValues } from 'wallhammer-web/gen-tex';
import { PointValueLayer, RasterValueLayer, ShapeValueLayer } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';
declare const renderer: Renderer;
declare const field: HeightField;
// Two time steps of a 60 × 40 grid of 25 m cells; NaN marks cells without a value.
declare const morning: Float32Array;
declare const noon: Float32Array;

const [min, max] = [5, 35];
const steps = [quantizeValues(morning, min, max), quantizeValues(noon, min, max)];
const grid = { x0: 0, z0: 0, cellX: 25, cellZ: 25, cols: 60, rows: 40 };
const raster = new RasterValueLayer(renderer, { grid, ramp: colorRamp(VALUE_RAMPS.heat), opacity: 0.75 });
const rect = { x0: 0, z0: 0, x1: 1500, z1: 1000 };
raster.addTiles(drapeTiles(field, { rect, every: drapeEvery(field, 400_000, rect) }));
raster.show(steps[0]!, steps[1]!, 0.5); // half-way between the two steps
renderer.add(raster);

// Three points: x, y, z, radius. Table row i belongs to point i.
const points = new PointValueLayer(renderer, { points: Float32Array.of(100, 210, 80, 6, 400, 214, 300, 6, 900, 209, 650, 9), ramp: colorRamp(VALUE_RAMPS.viridis), sizeByValue: 0.8 });
points.show(quantizeValues([12, NaN, 40], 0, 50)); // the second point has no value and is not drawn
renderer.add(points);

// Two prisms tinted by rows 0 and 1 of a table; the ramp has six flat bands.
const shapes = new ShapeValueLayer(renderer, { rows: 2, ramp: colorRamp(VALUE_RAMPS.blues, 6) });
shapes.addShapes(
  prismMesh(
    [
      { ring: [10, 10, 30, 10, 30, 25, 10, 25], minY: 200, maxY: 212, ref: 0 },
      { ring: [50, 10, 70, 10, 60, 30], minY: 200, maxY: 207, ref: 1 },
    ],
    { growM: 0.25 },
  ),
);
shapes.show(quantizeValues([3.5, 9], 0, 10));
renderer.add(shapes);

// Later: take a layer out and free what it holds.
renderer.remove(raster);
raster.dispose();
```

A shader of your own can read the same words: `VALUE_GLSL` (put it right after `#include <header>`) has `valueWord`, `tableCell`, `valueOf`, `blendSteps`, `rampPosition` and `rampCoord`.

## Materials

A material is data (`MaterialDesc` in `base`) and is compiled by `renderer.material(desc)`:

- `attribs`: fixed attribute locations. The mesh layout and every program of the material share them.
- `passes`: GLSL (`{ vs, fs }`) per pass, or `'depth'` for the shared shadow programs (`DEPTH_VS`, `DEPTH_FS`). A material with instanced or displaced vertices needs its own shadow program; `'depth'` only transforms `a_pos`.
- `state`: extra draw state per pass (`DrawState`: depth test and function, depth write, face culling, blending, alpha to coverage, polygon offset). The device applies only what changes.
- Face culling: `cull: 'none' | 'back' | 'front'` (type `CullMode`). The older `cullBack` (true: `'back'`, false: `'none'`) keeps working; when one state object has both, `cull` wins. The pass base state is `'back'`. The device switches `CULL_FACE` and `cullFace` only when they change. `'front'` draws only the back faces, for example an inflated copy of a mesh drawn behind it as a silhouette.

Uniforms are tagged values (`UniformValue`): `{ int }`, `{ float }`, `{ vec2 }`, `{ vec3 }`, `{ vec4 }`, `{ ivec4 }`, `{ mat4 }`.

## Shader includes

A line `#include <name>` is replaced by a registered snippet. Rules:

- The line must hold only the include and must end with a newline. The regex is `^#include <name>\n`.
- Includes do not nest. A snippet's own `#include` lines are not resolved. So list them yourself, in dependency order.
- An unknown name throws when the material is compiled.

Built-in and engine-registered includes:

| Include | Registered by | Provides |
| --- | --- | --- |
| `header` | renderer | `#version 300 es`, precision, the `Frame` block, the `Palette` block (`u_palette[64]`). Also `localUp`, `localHeight`, `localFrame` (see [Local up](#local-up)) and the pixel size helpers `detailVisible`, `metresPerPixelAt`, `detailVisibleAt` (`PIXEL_SIZE_GLSL`), so a material without `<noise>` can fade detail by its size on screen. In the logarithmic depth mode a fragment shader also gets its depth output here (see [Depth modes](#depth-modes)). |
| `noise` | renderer | `hashU`, `hash1/2/3`, `vnoise`, `vnoise3`. It still contains the pixel size helpers, behind the guard `WH_PIXEL_SIZE`, so including it after the header defines nothing twice. |
| `shadow` | `EnvironmentLink` | The sun visibility alone, without colours of light: `u_shadowMap`, `cloudLight`, `sunVisibility(worldPos, n, offsetTexels)`, `sunVisibilityBaked(…, baked)`, and the sharp variants `sunVisibilitySharp(worldPos, n, offsetTexels)` and `sunVisibilityBakedSharp(…, baked)`: one depth compare at the centre of the shadow map texel, no filter, so the edge is a hard step (stepped light, toon shading). Guarded by `WH_SHADOW_QUERY`: `<lighting>` contains the same text, so a material may include both, in either order. Needs `<noise>` before it (for `cloudLight`). |
| `lighting` | `EnvironmentLink` | `u_shadowMap`, `cloudLight`, `sunVisibility(worldPos, n, offsetTexels)`, `sunVisibilityBaked(worldPos, n, offsetTexels, baked)` (see [Shadow modes](#shadow-modes)), `lightOn(n, sun, ao)`, `lightOnAt(worldPos, n, sun, ao)` (see [Local up](#local-up)), `applyFog(display, worldPos)`, `toDisplay(c)`. Needs `<noise>` first. |
| `sky` | `EnvironmentLink` (stand-ins) or the sky slot | `skyToEye`, `skyColorDir`, `aerialPerspective`. Without the sky slot, stand-ins (no haze, fog colour as sky) keep the same material working. |
| `atmosphere` | `EnvironmentLink` (stand-in) or the atmosphere slot | `atmosphereAir(worldPos, through)` for the vertex shader and `atmosphereApply(display, worldPos, air, through)` for the fragment shader; `atmosphereApply(display, worldPos)` integrates in the fragment shader instead. With the slot it also defines `WH_ATMOSPHERE` and provides `atmosphereLight(worldPos, n, sun, ao)`, `atmosphereSun(worldPos)` and `atmosphereSky(dir, through, ground)`. Without it `atmosphereApply` returns its input and `atmosphereAir` gives no air. See [The atmosphere](#the-atmosphere). |
| `point-lights` | `PointLightSet` | The `PointLights` block, `u_lightListA`/`B` and `pointLights(world, normal, wrap)`. Needs `u_time`. See [Point lights](#point-lights). |
| slot name | `EnvironmentLink` | The `glsl` of each environment slot that has one. |

The usual order is `header`, `noise`, `lighting`, `sky`, then slot includes. Register your own with `renderer.includes.set(name, glsl)` before compiling the material.

## The Frame block

Members of `Frame`, in order: `u_viewProj`, `u_lightViewProj`, `u_sunDir` (w = used share of the shadow map), the `afterLight` slot members, `u_view`, `u_camRight` (w = pixel growth), `u_camUp` (w = logarithmic depth scale, 0 unless the depth mode is logarithmic), `u_camForward` (w = reference depth), the `afterView` slot members.

Engine members (from `ENV_CORE_SLOT`):

- after light: `u_sunColor`, `u_ambient`, `u_skyFill`, `u_bounce`, `u_warmTint`;
- after view: `u_time` (x animation time in seconds, y hour of day), `u_wind`, `u_gust`, `u_cloud`, `u_cloudEdge`, `u_weather` (x snow, y wetness, z fog, w precipitation), `u_fogColor`, `u_snow`, `u_fogShape`.

With a shadow mode other than `'single'` the block ends with the members of the shadow areas (`u_shadowArea[n]`, `u_shadowPart[n]`, `u_shadowReach[n]`, `u_shadowFocus`, `u_shadowRight`, `u_shadowUp`, `u_shadowHorizon`, `u_shadowHorizonY`) and the header defines `WH_SHADOW_AREAS` as their number. Materials do not read them; `sunVisibility` does.

Free lanes: `u_time.zw` and `u_wind.zw`. `gen-arch`'s window light uses `u_time.zw`; `gen-vegetation`'s sway uses `u_wind.zw`. Read the generated block (`assembleFrameBlock(slots).glsl`) when in doubt.

## Environment slots

The environment is generic. A slot (`EnvSlot` in `base`) turns it into what content needs:

- `params`: plain, mutable parameters.
- `compute(env, params)`: a pure function of `FrameEnvironment`.
- `fields`: the vec4 members it declares, or lanes of an existing member, filled by `lanes(values)`.
- `glsl`: optional, registered as the include `<name>`.
- `shadowKey(values)`: optional part of the shadow cache key.

`assembleFrameBlock(slots)` puts `ENV_CORE_SLOT` first and sorts members by `order` within their region. The engine uses multiples of 10. It throws on a duplicate slot name or a lane filled twice. The block is fixed when the engine is created, so pass every slot to `createEngine({ slots })`. `engine.link.value(slot)` returns a slot's values for the last frame. [Recipes](recipes.md#add-an-environment-slot) has a full slot; [Environment slots](environment.md#environment-slots) lists the slots of the engine and its content modules.

### Cloud cover by place

Under radial up (see [Local up](#local-up)) `cloudFieldSlot(field)` (in `env`) makes the cloud cover vary by place instead of one `weather.cloudCover` for the whole world: a profile by the angle to an axis plus drifting patches. With the slot the environment link registers `lightingGlsl({ cloudField: true })` as `lighting`, so `cloudLight` reads the cover at each point, and `CloudShellLayer` (in `runtime`) draws the clouds as a shell over their own shadows. The field, the division by the frame's dimming (`u_cloudFieldLight.y`), the CPU twins `cloudFieldCover` and `cloudFieldSun`, the shell's light and its cost per vertex and per fragment are in [Cloud cover by place](environment.md#cloud-cover-by-place) and [The cloud shell](environment.md#the-cloud-shell).

`createEngine({ cloudShadows: true })` adds `cloudShadowSlot()` and `CloudShadowLayer`, with or without the cover by place: `cloudLight` then reads a texture of the share of the sun, drawn every few frames along the light, instead of computing the cloud pattern per fragment. See [Cloud shadows from a texture](environment.md#cloud-shadows-from-a-texture).

## The environment

`Environment` (in `env`) holds the light mode (`'studio'` by default, `'day'` or `'fixed'`), two clocks (`time`, which plays by default, and `day`, the hour, which is paused by default), the weather, the wind, the clouds, the fog layer and the site. [The environment](environment.md) describes all of it: time and light, the sky and the atmosphere, weather, clouds, fog, wind, seasons and snow, its slots and the shader functions that receive it.

### A fixed light

`env.setFixedLight(toLight, light?)` switches to `mode: 'fixed'`: the light stands in one world direction with the colours and strengths given, changeable at any time. See [A fixed light](environment.md#a-fixed-light).

## Shadows

The shadow map is refitted only when the view key, the light direction or `renderer.shadowKeyExtra` change. A static frame is one pass. Consequences:

- `Layer.cull` runs only on a refit. A layer whose visible set changes for another reason must make the renderer refit: return true from `cullStale()` (as `PieceLayer` and `InstanceCellLayer` do after an add), or call `renderer.invalidateShadows()`.
- Animation time is not part of the key. Something that moves and casts a shadow must refresh the map itself. `TransientLayer` does this while its batches move.

Options: `shadowMapSize` (default 4096), `shadowSoftnessM` (default 0.9), `shadowDistanceM` (perspective only, default the whole scene).

### Moving casters

A layer whose casters move says so: `shadowCasters: 'dynamic'` and `shadowDirty()`, which the renderer asks once per frame and which returns true when what the layer casts changed since it was last drawn into the shadow map. Nobody calls `invalidateShadows()` for it. Without such a layer nothing below happens and the frame is what it was.

In the mode `'single'`, with at least one dynamic layer:

- A second depth target of the same size, made with the first dynamic layer, keeps only the static casters (every layer without `shadowCasters: 'dynamic'`). It is drawn on a refit only: when the view key, the light direction or `shadowKeyExtra` change, a static layer's `cullStale()` is true, `invalidateShadows()` is called, or the first dynamic layer comes or the last one goes.
- In a frame where it was drawn, or where a dynamic layer's `shadowDirty()` (or `cullStale()`) is true, its depth is copied into the map that is sampled (`Device.copyDepth`, a depth blit of the used square) and only the dynamic layers are drawn over it. Around that draw each dynamic layer's `cull` is called with the light's volume of the fitted map (`'shadow'`) and then with the view's (`'view'`), as at a refit; static layers are not culled again.
- A frame where nothing moved draws no shadow pass, as before. `FrameStats.shadowTriangles` and `shadowDrawCalls` count everything drawn into the map in the frame; `dynamicShadowTriangles` and `dynamicShadowDrawCalls` the dynamic part of it.
- Set `shadowCasters` before the layer is added and leave it; a layer that changes it is not followed until the next refit.

The modes `'snapped'` and `'cascades'` keep no static map: a dynamic layer's `shadowDirty()` redraws all their areas, as `invalidateShadows()` does. That is correct but costs the whole scene in every such frame.

The mode `'single'` still refits (and draws the static casters again) in every frame in which the view changes, for instance while the camera turns.

### Shadow modes

`RendererOptions.shadows.mode` chooses how the shadow map is laid out. The default is `'single'`: the map above, fitted to what the view sees, and nothing in this section applies. The mode is fixed when the renderer is created (it changes the program header); `renderer.shadowMode` tells it.

| Mode | The map | For |
| --- | --- | --- |
| `'single'` | One map fitted to the view, drawn anew whenever the view changes. | Small scenes. |
| `'snapped'` | One map over a square of the light's plane around the centre of the view, fixed to the world's texel grid. Kept between frames; a pan draws only the border it uncovers. | Views from above over a large scene. |
| `'cascades'` | Two to four maps around the eye in the quarters of the one shadow texture, each reaching farther and coarser, blended into each other. | Perspective views that see far. |

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { createEngine } from 'wallhammer-web/runtime';

const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('canvas')!,
  view: new PerspectiveOrbitRig(),
  palette: definePalette({ ground: '#4d4335' }),
  background: [0.6, 0.7, 0.8],
  renderer: { shadowMapSize: 4096, shadows: { mode: 'cascades', cascades: 4, firstReachM: 48, reachM: 3000 } },
});
console.log(engine.renderer.shadowMode, engine.renderer.lastStats.shadowUpdates);
```

How the two new modes work:

- **Areas on a block grid.** Each map holds an area: a square of the light's plane, 16 blocks along its edge, placed on a grid of blocks counted from the world origin (`worldOrigin` is taken into account). A texel therefore never moves against the world, and a shadow edge does not shimmer when the view moves. An area follows its focus in whole blocks, and only when the focus has left its middle block by a quarter of a block; it always covers 7 blocks around the focus.
- **The cache.** An area is drawn anew only when the light direction (compared to 4 decimals; the light's plane is laid by the direction rounded the same way, so a light that drifts by less keeps the map and its lookup in step), `shadowKeyExtra` or the scene's depth range change, when `invalidateShadows()` is called or a layer's `cullStale()` returns true. Otherwise a frame draws no shadow pass at all. `FrameStats.shadowUpdates` counts the parts of the map drawn in a frame.
- **`'snapped'`** addresses its one map around the edges (a texel's place is its world texel number modulo the map size), so a step keeps every texel it still covers and draws only the uncovered strips, each with the casters the light's volume over that strip selects. The block size follows the scale of the view on a ladder of √2 steps, from the size the softness asks for up to a reach of `reachM` (default 2048 m); a change of step draws the map once.
- **`'cascades'`** centres every area on the eye (on the centre of the view for an orthographic one). Reaches grow in equal ratios from `firstReachM` (default 48) to `reachM` (default `shadowDistanceM`, else 4000). An area that steps is drawn whole, the far ones rarely. The lookup takes the finest area whose reach holds the point and blends into the next over the outer 15 % of the reach, so there is no seam.
- **The light may stand straight above.** The areas use a light frame that is defined for every direction.
- **Beyond the reach** the lookup returns the far term: `baked` of `sunVisibilityBaked(worldPos, n, offsetTexels, baked)` (what the material knows itself, for example an occlusion value baked per vertex or per tile; 1 = lit; `sunVisibility` passes 1) times the scene's light horizon when `renderer.shadowHorizon` is set. The last area blends into it over the outer 25 % of its reach, so shadows do not end with a jump. In the `'single'` mode `sunVisibilityBaked` returns `baked` outside the map and the usual lookup inside.
- **The light horizon** is a coarse texture over the scene's x–z extent: per texel the height below which a point is hidden from the light. A texel with code 0 hides nothing, whatever the height of the point. `lightHorizon` and `horizonTexture` in `gen-tex` make it from a `SurfaceRaster` of surface heights (see [Generators](generators.md)); it belongs to one light direction, so make a new one when the light has moved. It is sampled through `u_shadowHorizonMap` on the fixed texture unit `SHADOW_HORIZON_UNIT`, which the device sets in every program (`Device.fixSampler`); layers need not know about it.

<!-- check: wrap -->
```ts
import { SurfaceRaster, horizonTexture, lightHorizon } from 'wallhammer-web/gen-tex';
import type { Renderer } from 'wallhammer-web/render';

declare const renderer: Renderer;
declare const surfaceAt: (x: number, z: number) => number;

// 8 m cells over a 4 km square whose corner is the world origin; one outline raised to 30 m above the surface.
const surface = new SurfaceRaster(500, 500, 8, surfaceAt);
surface.raisePolygon([[100, 100, 160, 100, 160, 140, 100, 140]], surfaceAt(130, 120) + 30);
const packed = horizonTexture(lightHorizon(surface, renderer.lightDirection), surface);
renderer.shadowHorizon = {
  texture: renderer.device.createTexture(packed.texture),
  originX: 0,
  originZ: 0,
  sizeX: surface.cols * surface.step,
  sizeZ: surface.rows * surface.step,
  baseY: packed.baseY,
  rangeM: packed.rangeM,
};
```

Limits: in the new modes `u_lightViewProj` is the projection of the first area only (read shadows through `sunVisibility`); the horizon assumes that up is +y; `Layer.cull` for the shadow pass gets a box volume per drawn part instead of one volume per frame; the shadow texture of `'snapped'` repeats, so a program that samples `u_shadowMap` itself must wrap its coordinates as `whShadowArea` does.

## Depth modes

`RendererOptions.depth` chooses how the main passes (`color`, `data`, `overlay`) store depth. The default is `'standard'` and changes nothing. The shadow pass always stores standard depth.

| Mode | Depth buffer | What it gives | Cost |
| --- | --- | --- | --- |
| `'standard'` | The canvas's own. | A perspective view holds a far : near ratio of a few thousand (the rigs use at most 2000). | None. |
| `'reversed'` | 32-bit float, 1 at the near plane, 0 at infinity (`EXT_clip_control`). | About the same relative precision at every distance: 1 m and 1,000 km in one view. No far plane. | An offscreen target and one copy per frame. |
| `'logarithmic'` | 32-bit float, the fragment shader writes `log2(1 + distance)`. | The same range. The fallback when `'reversed'` is asked for and the browser lacks `EXT_clip_control`. | The same, and no early depth test (roughly 10 % more fragment work). |

`renderer.depthMode` is the mode in effect after the fallback. `depthNearM` (default 0.1, also a field of the renderer) is the near plane of a perspective view in the two new modes; the far : near rule of the rig does not apply there.

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { createEngine } from 'wallhammer-web/runtime';

const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('canvas')!,
  view: new PerspectiveOrbitRig(),
  palette: definePalette({ ground: '#4d4335' }),
  background: [0.6, 0.7, 0.8],
  renderer: { depth: 'reversed', depthNearM: 0.1 },
});
console.log(engine.renderer.depthMode); // 'reversed', or 'logarithmic' without EXT_clip_control
```

By hand (see [Without `createEngine`](#without-createengine)): `new Device(createContext(canvas, mode))`, then `new Renderer(device, { depth: mode, … })`. The context has to know the mode, because a canvas for the two new modes is created without its own depth buffer and antialiasing.

How it works, and what a material has to do (nothing):

- **The device owns the convention of the bound target.** `DrawState` keeps one meaning in every mode: `depthFunc: 'less'` passes what is nearer, a positive `polygonOffset` pushes away from the viewer, `device.clear` clears depth to the farthest value. With reversed depth the device turns these into "greater", a negated offset and a clear to 0, and switches the clip range to 0…w for the main target and back to −w…w for a depth target.
- **The renderer builds the matrix.** In the two new modes a perspective `u_viewProj` comes from `depthViewProj` (module `base`): the rig's axes, field of view and eye with the renderer's own depth row. A rig needs no code per mode; `View.viewProj` is used as it is only in the standard mode and for orthographic views.
- **A canvas cannot have a float depth buffer.** In the two new modes the device draws into its own multisampled target (`device.target(null)` binds it) and `device.present()`, called by the renderer at the end of a frame, copies the result to the canvas.
- **Logarithmic depth is added to fragment shaders by `renderer.resolve`.** A fragment shader of the main target that starts with `#include <header>` gets its `main` renamed and a new `main` that calls it and then writes `gl_FragDepth` from `gl_FragCoord.w`. No varying is needed, so vertex shaders stay as they are. The polygon offset of the draw state reaches such a shader as a uniform, set by the device before each draw.
- `u_camUp.w` carries the logarithmic scale (0 in the other modes). The header defines `WH_DEPTH_REVERSED` or `WH_DEPTH_LOGARITHMIC` for a shader that reads depth values of the main target itself.

Rules for code that goes around the usual path:

- A program built with `device.program` for the main target must get its fragment source through `renderer.resolve(src)` and its shadow or bake sources through `renderer.resolve(src, 'other')`. A source that never mentions `gl_Position` counts as a fragment shader.
- A fragment shader with its own `#version` line instead of `<header>` is not wrapped. In the logarithmic mode use it only for draws with the depth test off.
- A vertex shader that writes clip coordinates directly must not assume that z = 1 is far. Draw such things with the depth test off (as the sky and the precipitation layers do), or put hidden vertices outside the clip volume on x or y.
- Bind the main target only with `device.target(null)`, and read pixels of the frame only after `renderer.render` has returned.
- A full-screen draw that writes its own depth (as the volumetric clouds do in the standard mode: the clouds' distance, so that the depth test hides them behind terrain) gets its source through `renderer.resolve(src, 'other')` and writes `gl_FragDepth` itself in the mode in effect: `0.5 × z / w + 0.5` in the standard mode, `z / w` in the reversed one, `log2(1 + w) × u_camUp.w` in the logarithmic one (`w` the clip coordinate). Writing `gl_FragDepth` turns off the early depth test for that draw. Cheaper where it fits: geometry built in the vertex shader (`device.drawVertices`) at a depth of its own, as the volumetric clouds' quads per tile in the reversed and logarithmic modes, keeps it.
- `device.sceneDepth()` copies the depth drawn so far (reversed and logarithmic modes, or two samples) for a layer to read, e.g. in `prepare` the last frame's depth with `renderer.projection` of that frame. A vertex shader that reads a texture drawn earlier in the same frame can stall the pass on some drivers (about 0.3 ms on Apple GPUs through Metal): read it in the fragment shader.

## Local up

By default up is +y everywhere, and everything that needs up says so in its shader. `RendererOptions.radialUp` (off by default) makes up point away from one point instead, for a world on a sphere:

<!-- check: wrap -->
```ts
import type { Device } from 'wallhammer-web/gpu';
import { Renderer } from 'wallhammer-web/render';
import type { RendererOptions } from 'wallhammer-web/render';
import { SphereWorld } from 'wallhammer-web/world';
declare const device: Device;
declare const options: RendererOptions;

const shape = new SphereWorld(100_000);
// `shape.radial` is { center, radiusM }: the centre in world metres (doubles) and the radius of the base surface.
const renderer = new Renderer(device, { ...options, radialUp: shape.radial });
renderer.upCenter(); // the centre relative to the render origin, or null when up is +y
```

Every program header then defines `WH_LOCAL_UP`, and the Frame block ends with `vec4 u_upCenter` (xyz the centre in render space, w the radius). Three functions exist in every shader, with or without the option:

| Function | Up is +y (default) | With `radialUp` |
| --- | --- | --- |
| `localUp(p)` | `vec3(0, 1, 0)` | unit vector from the centre to `p` |
| `localHeight(p)` | `p.y` | distance from the centre minus the radius |
| `localFrame(p)` | identity | the world's axes turned by the shortest rotation that takes +y to up; the middle column is up |

Write a new shader with these instead of `.y` and `vec3(0, 1, 0)` and it works on both kinds of world: an upright object is `base + localFrame(base) * (a_pos * scale)`, the share of sky a normal sees is `dot(n, localUp(p))`. On the CPU the same frame is `upFrame(radialUpAt(center, p))` (module `base`); `toFramePlane(frame, dir)` gives a world direction as the (x, z) pair of that frame, and `radialHeight` is the height.

What follows the option in the engine:

- **`lighting` include.** `lightOn(n, sun, ao)` takes the sky and bounce light by the up of the point last given to `sunVisibility`, `sunVisibilityBaked` or `cloudLight`; `lightOnAt(worldPos, n, sun, ao)` names the point. Where up turns away from the sun the direct light and the sky light fade out (the night side). Cloud shadows are read from a field on the sphere. `applyFog` takes the fog layer as heights above the base surface (`env.fogLayer = { bottomY: 0, topY: 1500 }` is then 0–1500 m above the sphere).
- **Rigs.** `RigLayer` stands every rig along the up of its position, turns its heading in the local horizon and culls it there.
- **Instances.** `InstancedLayerOptions.upCenter` (pass `() => renderer.upCenter()`) culls instance boxes that extend along the local up; `cullInstances` takes the same centre as its sixth argument. The streamed world culls by cell boxes and needs nothing.
- **Slots of `gen-ground` and `gen-vegetation`.** `snowOn` settles snow by the local up; the plant shader stands plants along the up of their base and sways them in the local horizon.
- **Precipitation.** `PrecipitationLayer` lets rain and snow fall along the up at the eye (towards `renderer.upCenter()`), with the wind across it; its landing marks lie on the surfaces that face that up (see [Rain and snow](environment.md#rain-and-snow)).
- **Cloud cover by place.** See [Cloud cover by place](environment.md#cloud-cover-by-place).

Not adapted: the shadow modes `'snapped'` and `'cascades'` and the light horizon (they assume ground along y), the `sky` include and the sky layer, `InstanceCellLayer`, `PieceLayer`, `TransientLayer` and the value layers, the shaders of `gen-arch`, and the joint pattern of the rig finish `'tiles'` (a grid in render-space xz). The environment computes one sun direction for a site whose up is +y. `localFrame` has no shortest rotation exactly opposite +y: where up is within a quarter of a degree of −y (cosine under −0.99999, a disc of 450 m radius on a sphere of 100 km) the frame is the world turned by half a turn about x, so objects there stand along −y exactly, and headings jump at the rim of that disc.

## A medium below a level

A clear medium that fills everything below a level (water under a sea's surface, haze in a basin) dims what is seen through it and adds its own scattered light. `core` holds the arithmetic for both sides, as TypeScript functions and, with the same names, in `MEDIUM_GLSL` (any stage, needs nothing before it). The functions take heights relative to the level, so one formula serves a radial world (`localHeight(p)` minus the level) and a flat one (`p.y` minus the level).

| Function | Gives |
| --- | --- |
| `mediumPath(fromHeight, toHeight, lengthM)` | the part of a straight segment that lies below the level, the height taken as linear along it |
| `mediumThrough(extinction, lengthM)` | the share of light per channel that crosses that length, `exp(-extinction * d)` |
| `mediumApply(color, inscatter, extinction, lengthM)` (GLSL only) | a colour seen through the medium: dimmed, with the medium's own light added by the share that was lost |
| `mediumClearDistance(extinction, share)` (TypeScript only) | the distance at which every channel has fallen to `share`: beyond it the medium hides everything, so a backdrop may stand there |
| `mediumFresnel(cosI, eta)` | the share the boundary reflects (Schlick), with total reflection from the denser side (`eta` > 1) |

The engine draws a medium only as the liquid of a sphere ([A liquid below the level of a sphere](#a-liquid-below-the-level-of-a-sphere)); otherwise the content chooses the level, the extinction and the inscattered colour, and calls these from its materials: a fragment applies `mediumApply` over `mediumPath(eyeHeight, fragmentHeight, distance)`, and from inside the medium a layer can stand a backdrop at `mediumClearDistance` in place of the sky. The `planet` example does this for its sea ([The sea](planet.md#the-sea)).

```ts
import { mediumClearDistance, mediumFresnel, mediumPath, mediumThrough } from 'wallhammer-web/core';

const extinction = [0.2, 0.062, 0.068] as const; // per metre: red is lost first
const eyeHeight = -3; // the eye 3 m below the level
const path = mediumPath(eyeHeight, 2, 50); // a point 50 m away, 2 m above the level: the part under it
const left = mediumThrough(extinction, path); // the share of each channel that reaches the eye
const backdropM = mediumClearDistance(extinction, 0.01); // where 99 % of every channel is gone
const reflected = mediumFresnel(0.3, 1.33); // looking up at a grazing angle from below: all of it
console.log(path, left, backdropM, reflected);
```

## A moving surface of waves

`gen-core` holds a field of waves for the surface of a liquid: a sum of up to eight trochoidal (Gerstner) trains, with sharp crests and wide troughs. It is a pure function of the trains, a point of a plane and the time, as TypeScript functions and, with the same names, in `WAVES_GLSL` (any stage, needs nothing before it). The engine does not know what the surface lies on: the caller maps its points to the plane (a flat world's x and z, a chart of a sphere) and the displacement back to its own space.

| Function | Gives |
| --- | --- |
| `waveTrains(options)` | the trains of a sea raised by a wind: wavelengths from the peak of a fully developed sea (Pierson–Moskowitz) down to `shortest` of it, heights from the spectrum's energy, directions spread round the wind and phases from the seed |
| `waveDisplace(trains, x, z, timeS, sampleM)` | the displacement of a point of the plane: toward the crests and up |
| `waveNormal(trains, x, z, timeS, sampleM)` | the normal of the displaced surface and the Jacobian of the horizontal displacement (below 1 where the surface is squeezed into a crest: the place for foam) |
| `waveHeight(trains, x, z, timeS, sampleM)` | the height of the surface over a point, the displacement toward the crests undone; for the CPU to tell above from below the surface as the picture does |
| `waveFade(lengthM, sampleM)` | how much of a train is kept where one sample (a vertex, a pixel) is `sampleM` across: all of it up to a quarter of its length, none from half of it |
| `waveUnresolved(trains, sampleM)` | the slope variance of what has faded, to widen a glint |
| `waveUniforms(trains, timeS, originX, originZ, out?)` | the uniforms of `WAVES_GLSL`: per train `u_waveTrain0`–`7` (direction times wave number, amplitude, shift) and the phases at an origin in `u_wavePhase0`, `u_wavePhase1`, computed in double |

In GLSL the functions take the point relative to the origin given to `waveUniforms` and no time: the time is in the phases. A shader therefore works with small numbers anywhere on the plane, and a frame is the same function of the time on every run, so a recorded movie shows the same waves. A vertex shader moves a dense mesh near the eye with `waveDisplace`, its spacing as `sampleM`; a fragment shader takes `waveNormal` at the pixel's footprint, so the trains a pixel cannot hold fade into roughness instead of aliasing.

```ts
import { WAVES_GLSL, waveHeight, waveNormal, waveTrains, waveUniforms } from 'wallhammer-web/gen-core';

const trains = waveTrains({ windSpeedMs: 6, towardX: 1, towardZ: 0.3, seed: 7 });
const timeS = 12.5;
const surfaceM = waveHeight(trains, 40, -12, timeS); // the surface over that point at that time
const { normal, jacobian } = waveNormal(trains, 40, -12, timeS); // foam where jacobian falls under about 0.8
const uniforms = waveUniforms(trains, timeS, 40, -12); // the shader's points are then relative to (40, -12)
console.log(surfaceM, normal, jacobian, Object.keys(uniforms).length, WAVES_GLSL.length);
```

The `planet` example builds its sea with them ([The sea](planet.md#the-sea)): a chart of the sphere as the plane, a grid of rings round the eye moved by the waves, the flat water of the cells beyond it, and the eye's height above the moving surface from `waveHeight` on the CPU.

## A liquid below the level of a sphere

The two pieces above make a liquid on a radial world: `env` holds its CPU side and GLSL, `runtime` the layers that draw
it round the eye. The content keeps its own look and the materials of its far surface and of what lies under it.

- `LiquidSurface` (`env`): the waves of a wind (`waveTrains`) on a chart of the sphere, the face of a cube under the
  eye, whose coordinates are metres along the face's axes. `uniforms(seed, eye, origin, timeS)` gives a frame's
  `common` uniforms (`u_liquid`: the eye's height above the moving surface and above the level, the near radius and
  the factor on the waves; `u_liquidFoot`, `u_liquidAxisA/B/N`: the chart; `u_liquidSlope`) and `water` (common plus
  the trains of `waveUniforms` and the ripples' `u_liquidRipple0`…), rewritten in place every call; `state` holds what
  it computed (`aboveSurfaceM`, `aboveLevelM`, `nearM`). `surfaceHeight` is the height of the surface over a point on
  the CPU, the same function the picture uses. `setLoop(seconds, clockS)` moves every train to a length whose period
  divides `seconds`, so a scene that plays in a circle shows the same surface where it begins and ends.
- `liquidGlsl(look)` writes the look (`LiquidLook`: extinction, the liquid's own colour, the light lost with depth, the
  colours from high above, optional other optics for an eye below and caustics that follow a looping clock) into GLSL
  with the functions its materials share: `liquidLightAt`, `liquidSurfaceLight`, `liquidInscatter`, `liquidDisplay`,
  `liquidPlane`, `liquidTangents`, `liquidSunIn`, `liquidCaustic` and more. It needs `<noise>`, `<lighting>`,
  `<atmosphere>` and `MEDIUM_GLSL` before it. `liquidRipplesGlsl()` adds the ripples (`liquidRipples`), fine detail of
  the normal down to a few centimetres, and `liquidShaftsGlsl()` the light shafts seen from below.
- The layers (`runtime`), each taking the renderer and the surface: `LiquidNearLayer` a grid of rings round the eye's
  foot drawn with the caller's material (it moves the grid with `waveDisplace`), `LiquidBackdropLayer` the liquid's own
  light at `clearM` ahead while the eye is below the surface, `LiquidShaftsLayer` the light shafts along every view
  ray then, and `LiquidLensLayer` the line where the surface crosses the front of the lens. Each draws only while
  `surface.state` says it is needed; the page hands them the frame's uniforms.

<!-- check: wrap -->
```ts
import type { MaterialDesc, Vec3 } from 'wallhammer-web/base';
import { LiquidSurface } from 'wallhammer-web/env';
import type { LiquidLook } from 'wallhammer-web/env';
import type { Renderer } from 'wallhammer-web/render';
import { LiquidBackdropLayer, LiquidLensLayer, LiquidNearLayer, LiquidShaftsLayer } from 'wallhammer-web/runtime';
declare const renderer: Renderer;
declare const NEAR_MATERIAL: MaterialDesc; // its shaders include MEDIUM_GLSL, liquidGlsl(look), WAVES_GLSL, liquidRipplesGlsl()
declare const seed: number, eye: Vec3, origin: Vec3, timeS: number;

const look: LiquidLook = {
  extinction: [0.32, 0.055, 0.06],
  body: [0.03, 0.24, 0.34],
  lightLoss: [0.3, 0.05, 0.03],
  farShallow: [0.14, 0.41, 0.49],
  farDeep: [0.03, 0.12, 0.27],
};
const surface = new LiquidSurface({ radiusM: 100_000, wind: { speedMs: 6, fromDeg: 240 }, look });
const near = new LiquidNearLayer(renderer, surface, NEAR_MATERIAL);
const backdrop = new LiquidBackdropLayer(renderer, surface);
const shafts = new LiquidShaftsLayer(renderer, surface);
const lens = new LiquidLensLayer(renderer, surface);
// every frame, with the eye and the render origin from the sphere's centre:
const { common, water } = surface.uniforms(seed, eye, origin, timeS);
near.uniforms = water;
lens.uniforms = water;
backdrop.uniforms = common;
shafts.uniforms = common;
console.log(surface.state.aboveSurfaceM, surface.clearM);
```

The `planet` example draws its sea this way (`examples/planet/src/sea.ts`): the backdrop before
the streamed world, the near surface after it, the shafts after the water and the lens last.

## The ground of a sphere from patch cells

`env` holds the shader parts of a ground streamed as sphere patch cells (`SPHERE_PATCH_ATTRIBS` and
`SPHERE_PATCH_COVER_ATTRIBS`), with a cover of objects that lifts the surface where it stands for them from afar
(`env/sphere-ground.ts`). The fragment shader, with its palette and colours, stays with the content.

- `sphereGroundVs(options)` is the vertex shader of the colour pass, `sphereGroundDepthVs(options)` that of the shadow
  pass (the surface lifted as the colour pass lifts it), `DEPTH_ONLY_FS` a fragment shader that writes only depth.
  `thinRank` and `thinFrom` set the share of the far look by level (`sphereCoverThinGlsl`, also for the objects'
  own shaders: `coverShareAt`, `thinKeep`). The hooks are four GLSL functions in `lift`: `coverLift`,
  `coverLiftShare`, `coverElevation` and `coverShade`.
- The varyings for the content's fragment shader: `v_world`, `v_normal`, `v_color` (alpha: 0.5 or more under the
  level, a number of the content's above it), `v_cover`, `v_lift` (x the lift, y the sine of the view's angle above
  the ground, z the share of the far look, w the ground's height), `v_air`, `v_airThrough`.
- **The waterline**, opt-in: a test of the interpolated alpha (`step(0.5, v_color.a)`) makes teeth along every
  triangle that crosses the level, and the content's number above the level is mixed with the marks of the vertices
  under it. With `waterline: true` the vertex shader also hands over `v_landMark`, and `SPHERE_GROUND_WATERLINE_GLSL`
  gives `groundUnder(p, blendM)`, the share under the level by the fragment's own height (over ± `blendM`, at least a
  pixel), and `groundLandAlpha()`, the alpha of the vertices above the level alone. Without it the program is unchanged.

<!-- check: wrap -->
```ts
import type { MaterialDesc } from 'wallhammer-web/base';
import { DEPTH_ONLY_FS, SPHERE_GROUND_WATERLINE_GLSL, sphereGroundDepthVs, sphereGroundVs } from 'wallhammer-web/env';
declare const LIFT_GLSL: string; // defines coverLift, coverLiftShare, coverElevation, coverShade
declare const MY_FS_HEAD: string, MY_FS_MAIN: string; // the content's look; MY_FS_MAIN reads groundUnder(v_world, 0.05)
declare const material: Omit<MaterialDesc, 'passes'>;

const ground = { thinRank: [0.12, 0.25, 0.5, 1], thinFrom: [0.75, 0.6, 0.55, 0.5], lift: LIFT_GLSL };
const desc: MaterialDesc = {
  ...material,
  passes: {
    color: { vs: sphereGroundVs({ ...ground, waterline: true }), fs: `${MY_FS_HEAD}${SPHERE_GROUND_WATERLINE_GLSL}${MY_FS_MAIN}` },
    shadow: { vs: sphereGroundDepthVs(ground), fs: DEPTH_ONLY_FS },
  },
};
console.log(desc.name);
```

The `planet` example builds its ground this way.

## Levels of detail with a fade

`LevelFade` (`core`) picks a level from one number, for example screen pixels per metre: level 0 is the finest, level k + 1 takes over once the value drops below `below[k]`. A dead band around every threshold (`hysteresis`, a share of it) keeps the level from flickering, and a change moves a continuous `position` to the new level over `seconds`. The class has no clock: pass the time since the last frame to `update`. `limit` holds the position at a finer level while a coarser one is not ready yet.

The transition is drawn as a screen-door fade (`FADE_GLSL`): while the position is between two levels both are drawn, and every fragment belongs to exactly one of them by a fixed screen pattern. Nothing is blended, so the passes, the depth buffer and the draw order stay as they are. `withFade(desc)` adds the fade to every pass of a material that has its own program (a pass drawn with `'depth'` stays whole; to fade it as well, write the pass out as `{ vs: DEPTH_VS, fs: DEPTH_FS }` from `render` before wrapping); the uniform is `u_fade`, and a layer that never sets it is drawn whole.

```ts
import { LevelFade, withFade } from 'wallhammer-web/core';
import type { MaterialDesc, MeshData, View } from 'wallhammer-web/base';
import { MeshLayer } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';

declare const renderer: Renderer;
declare const fineDesc: MaterialDesc;
declare const coarseDesc: MaterialDesc;
declare const fineMesh: MeshData;
declare const coarseMesh: MeshData;
declare const requestFrame: () => void;

const fineMaterial = renderer.material(withFade(fineDesc));
const coarseMaterial = renderer.material(withFade(coarseDesc));
const layers = [
  new MeshLayer({ material: fineMaterial, mesh: renderer.createMesh(fineMesh, fineMaterial) }),
  new MeshLayer({ material: coarseMaterial, mesh: renderer.createMesh(coarseMesh, coarseMaterial) }),
];
for (const layer of layers) renderer.add(layer);
const passes = layers.map((layer) => layer.passes);

// The coarse level takes over below half a screen pixel per metre.
const levels = new LevelFade({ below: [0.5], hysteresis: 0.15, seconds: 0.35 });
let last = 0;
renderer.beforeFrame.push((view: View) => {
  const now = performance.now();
  // A transition starts with the frame that asks for it: time the page stood still before does not count.
  const dt = levels.moving ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  const before = levels.position;
  const more = levels.update(1 / view.metresPerPixel, dt);
  layers.forEach((layer, level) => {
    layer.passes = levels.shown(level) ? passes[level]! : new Set();
    layer.uniforms = { ...layer.uniforms, ...levels.uniforms(level) };
  });
  // The shadow pass fades too, and the shadow map is drawn anew only when asked.
  if (levels.position !== before) renderer.invalidateShadows();
  if (more) requestFrame();
});
```

A level may span several entries: `levels.shown(0, 1)` and `levels.fade(0, 1)` are for something drawn on levels 0 and 1 alike. Neighbouring spans get complementary patterns.

## Point lights, particles and instance sets

Three things a lit, animated scene needs besides the sun: many small lights, looping particles, and meshes that move
in their own way. Each is plain data owned by the app; the engine selects, packs and draws it without allocating in
the frame. Static meshes for such a scene are best cut into chunks first (`chunkMeshes` in `gen-mesh`) and drawn by a
`PieceLayer`, one draw per visible chunk.

<!-- check: wrap -->
```ts
import type { MaterialDesc, MeshData } from 'wallhammer-web/base';
import { chunkMeshes } from 'wallhammer-web/gen-mesh';
import { InstanceSetLayer, ParticleLayer, PieceLayer, PointLightSet, instanceSet, pushInstance } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';
declare const renderer: Renderer;
declare const staticMeshes: MeshData[];
declare const partMesh: MeshData;
declare const solidDesc: MaterialDesc; // includes <point-lights>
declare const instancedDesc: MaterialDesc; // also INSTANCE_SET_GLSL and instanceSetAttribs
declare const eye: [number, number, number];

// Lights first: the set registers the include the materials need.
const lights = new PointLightSet(renderer, { max: 32 });
lights.add({ position: [4, 3, -2], color: [1, 0.7, 0.4], radius: 9, intensity: 1, flicker: 0.15, group: 1 });

const solid = renderer.material(solidDesc);
const statics = new PieceLayer({ material: solid, order: 'front-to-back', lights, name: 'statics' });
for (const c of chunkMeshes(staticMeshes, { cellM: 56, padM: 0.5 })) statics.add({ mesh: renderer.createMesh(c.data, solid), min: c.min, max: c.max });

const moving = new InstanceSetLayer(renderer, { material: renderer.material(instancedDesc), lights, name: 'moving' });
const set = instanceSet(partMesh, 64);
moving.add(set);
pushInstance(set, [1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 5], 0.8, 0.6, 0.4, 0);

const particles = new ParticleLayer(renderer, [
  { position: [0, 2, 0], count: 40, life: 6, size: [0.6, 2.4], rise: 0.8, spread: [0.3, 0.15], colorStart: [0.5, 0.5, 0.5, 0.5], colorEnd: [0.6, 0.6, 0.6, 0] },
]);
renderer.add(statics);
renderer.add(moving);
renderer.add(particles);

// Every frame, before rendering:
lights.gains[1] = 0.8; // fade group 1
lights.update(eye[0], eye[1], eye[2]);
```

### Point lights

`PointLightSet` holds `PointLight` records (`position`, `color`, `radius` where the light reaches zero, `intensity`,
`flicker` 0–1, `group`). The owner may change any field or the gain of a group (`gains[group]`, default 1) at any time.
`update(x, y, z)` once per frame selects at most `max` lights (default 32) for the eye at that point: brighter than
`threshold` after gains, nearer and larger first. It packs them into the uniform block `PointLights` (binding
`POINT_LIGHTS_BINDING`) and uploads it once. The set registers the include `<point-lights>` when it is made, so make it
before compiling the materials that use it; a material that includes it without a set fails to compile.

The include gives `pointLights(world, normal, wrap)`: the summed light at a point, with `wrap` > 0 letting it reach round
the terminator (0 is plain Lambert). It reads `u_time` of the Frame block for the flicker, whose phase follows the
light, not its slot. Multiply the result into the albedo as you do the sun.

The cost per pixel does not grow with the number of lights. A draw names at most `POINT_LIGHTS_PER_DRAW` (8) of the
selected lights in the uniforms `u_lightListA` and `u_lightListB`, and the shader visits only those. `PieceLayer` with
`lights` fills the list per piece from the lights whose sphere reaches the piece's box (`bindFor(program, box)`), in
order of importance; a piece out of every light's reach visits none. A piece that more than 8 lights reach gets the
whole selection rather than lose some of them (the cost per pixel is then bounded by `max`; `crowdedDraws` counts such
draws since the last `update`, so smaller pieces can be chosen where it is high). A draw that sets no list sees the whole selection
(`bindAll`, also the state of a fresh program), which `InstanceSetLayer` uses, since its sets spread over the scene;
`bindNone` turns them off for a draw. A scene without a `PointLightSet` pays nothing.

### Particles

`ParticleLayer(renderer, sources, { budget?, name? })` draws looping `ParticleSource`s: a birth disc (`position`,
`spread[0]`), `count` particles alive at once born one after the other over `life` seconds, size from `size[0]` to
`size[1]`, upward speed `rise`, horizontal spread speed `spread[1]`, `gravity`, the share of the wind `wind` (default 1),
colour and opacity from `colorStart` to `colorEnd`. `blend` is `'blend'` (alpha over the scene) or `'add'` (light added),
`shape` is `'soft'` (a lit noise puff, turned per particle) or `'core'` (a bright core with a flicker). Opacity is
multiplied by `gains[group]` (four groups, default 1), so a group can be faded at run time.

The whole life of a particle is computed in the vertex shader from `u_time.x`: nothing is simulated, pausing the clock
freezes the particles and scrubbing it shows the same picture. The instance buffers are written once, by the
constructor or by `setSources`. The budget (default 4096) is shared by all sources in order; `counts.dropped` tells how
many particles did not fit. The layer draws in the colour pass only, at most two draws (blended first, then added), with
the depth test and no depth write: add it after the opaque layers. The materials read `u_time`, `u_wind`, `u_warmTint`
and the `lighting` include of the environment.

`TransientLayer` dust stays separate: its puffs are one-shot events at absolute clock times that come and go with
batches of falling pieces, while particle sources loop with no start or end.

### Instance sets

An `InstanceSet` (`instanceSet(mesh, capacity, { name?, castShadow?, visible? })`) is one mesh in its own coordinates
and `capacity` records of `INSTANCE_SET_FLOATS` (16) floats: a 3 × 4 matrix as four columns (the linear part column by
column, then the translation) and four free numbers (typically a tint and one more value). The owner writes records with
`writeInstance(set, i, m, a, b, c, d)` or appends with `pushInstance`, sets `count`, and sets `dirty` after a change.
`InstanceSetLayer` uploads the dirty sets at the start of the next frame (a `Renderer.beforeFrame` hook; `dispose()`
removes it) over the set's own array, and draws each visible set with one instanced draw, in the shadow pass too when it
casts shadows.

The material's vertex shader adds `INSTANCE_SET_GLSL`, which declares the attributes `i_m0`, `i_m1`, `i_m2`, `i_extra`
and gives `instanceLinear()`, `instancePoint(p)` and `instanceNormal(n)`; `instanceSetAttribs(first)` gives their
locations after the mesh's own attributes.

The layer is a dynamic shadow caster: `shadowCasters` is `'dynamic'` and `shadowDirty()` is true when a set that casts
shadows was uploaded, added, removed, shown or hidden since the layer was last drawn into the shadow map. The renderer
then draws only the dynamic layers over the kept static shadow map; the app never calls `invalidateShadows` for it.
A layer whose material has no shadow pass, or whose sets never cast shadows, never reports `shadowDirty()`, so it
costs no shadow redraw.

One set may be added to several layers of one renderer, for example one material for the surface and another (with
`cull: 'front'`) for an outline. The layers share the set's GPU instance buffer: whichever layer uploads first writes
the records once and clears `dirty`, the others only take the new count. Each layer keeps its own vertex binding of the
mesh, because each material has its own attribute locations. The buffer is deleted when the last layer removes the set.

The layer does not cull, but `cull` returns the records of its visible sets, so `FrameStats.instancesVisible` counts
them.

<!-- check: wrap -->
```ts
import type { MeshData } from 'wallhammer-web/base';
import { InstanceSetLayer, instanceSet } from 'wallhammer-web/render';
import type { Material, Renderer } from 'wallhammer-web/render';
declare const renderer: Renderer;
declare const surface: Material;
declare const outline: Material;
declare const shape: MeshData;

const set = instanceSet(shape, 64, { name: 'props' });
const fill = new InstanceSetLayer(renderer, { material: surface });
const edge = new InstanceSetLayer(renderer, { material: outline, passes: ['color'], state: { color: { cull: 'front' } } });
fill.add(set);
edge.add(set); // the same records, uploaded once
renderer.add(fill);
renderer.add(edge);
```

## Instances near the viewer

`NearInstanceLayer` (`render/near-instances.ts`) draws the records of `nearScatter`
([Instances near the viewer](generators.md#instances-near-the-viewer)) round the eye.

<!-- check: wrap -->
```ts
import type { MaterialDesc, MeshData, Vec3 } from 'wallhammer-web/base';
import type { Device } from 'wallhammer-web/gpu';
import { NearInstanceLayer } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';
declare const engine: { device: Device };
declare const renderer: Renderer;
declare const MY_MATERIAL: MaterialDesc;
declare const unitShape: MeshData;
declare const key: string;
declare const anchor: Vec3, radiusM: number, data: Float32Array;
declare const dir: Vec3, strength: number, timeS: number, eye: Vec3, gain: number;

const layer = new NearInstanceLayer(engine.device, {
  material: renderer.material(MY_MATERIAL), // its vertex shader includes NEAR_INSTANCE_GLSL
  kinds: [{ mesh: unitShape, fade: { reachM: 60, band: 0.6, softM: 9 }, maxInstances: 44_000, bendM: 0.4 }],
  origin: () => renderer.worldOrigin,
});
renderer.add(layer);
layer.put(key, 0, { anchor, radiusM, data }); // one kind of one set; null removes it
// every frame:
layer.wind = { dir, strength, timeS };
layer.view(eye, [gain]);
```

- A set is one kind of the records of one square, relative to its anchor, a world point in doubles. The layer keeps
  what it is given and drops nothing by itself.
- `view` rebuilds the buffers only when the eye has moved more than `stepM` (default 2 m), a set came or went, or a
  gain changed by more than 0.01. A rebuild takes the sets nearest first and from each the prefix that can still be
  seen from the nearest point of its sphere, moved to one anchor of the layer (the eye of the rebuild) so the numbers
  on the GPU stay small. A full buffer leaves the rest out and counts it in `stats.clipped`: the hard ceiling.
- The exact fade runs per instance in the vertex shader, so a rebuild changes no pixel. A gain below 1 shortens the
  reach of its kind.
- The bend in the wind follows two waves fixed to the world (9 m and 3.5 m long): the layer computes the phase of its
  anchor per wave in doubles, the shader adds the part of the instance. Time is wrapped to 20π s, in which both
  speeds make whole turns. `wind.waves = 0` keeps only the steady lean (for a jump of the time).
- One draw per kind with records, colour pass only, no shadow pass. With every gain 0 nothing is uploaded or drawn.

`NEAR_INSTANCE_GLSL` declares `i_base`, `i_shape`, `i_color` and the uniforms the layer sets, and gives `nearBase()`,
`nearScale()`, `nearAxes(base)` (upright along `localFrame`, turned about up) and `nearPoint(unitPos)`, the vertex in
render space. The unit shape stands on y = 0 and reaches y = 1; width scales x and z, height y.

### Details streamed round the eye

`NearDetailStream` (`runtime/near-details.ts`) runs such a layer on a sphere: which squares of a `NearSquareGrid` are
wanted, the jobs that make their records, the squares dropped behind the eye and the gain.

- The kinds are made in groups (`NearDetailGroup`: a mask, its kinds, a reach), one job per square and group. Per
  frame a group wants the squares its reach + `wantM` (25 m) touches and drops those beyond its reach + `dropM`
  (60 m); the missing ones start nearest first, up to `inFlight` (2) jobs on the `pool` (or one square a frame on the
  main thread through `generate`). `idleWorkersOnly` starts a job only on an idle worker with nothing waiting.
- A group's gain is `lift` × the least, over its wanted squares not there yet, of clamp((distance − `nearM`) / reach,
  0, 1). It falls at once and rises by at most `rise` (0.04) a frame, so no square appears inside the visible reach.
- From `offM` above the ground, or with no eye, every square is dropped. The content (shapes, material, the function
  that makes a square's records, the wind) stays with the caller.

<!-- check: wrap -->
```ts
import type { MaterialDesc, Vec3 } from 'wallhammer-web/base';
import type { NearSquareGrid } from 'wallhammer-web/gen-core';
import type { Layer, NearKindDraw, Renderer } from 'wallhammer-web/render';
import { NearDetailStream } from 'wallhammer-web/runtime';
import type { NearDetailReply } from 'wallhammer-web/runtime';
declare const renderer: Renderer, before: Layer, grid: NearSquareGrid, MY_MATERIAL: MaterialDesc;
declare const kinds: NearKindDraw[];
declare function makeSquare(face: number, i: number, j: number, mask: number): NearDetailReply;
declare const eye: Vec3, dir: Vec3, heightM: number, timeS: number, windDir: Vec3;

const details = new NearDetailStream({
  renderer, material: MY_MATERIAL, kinds, before, grid,
  groups: [{ mask: -1, kinds: kinds.map((_, k) => k), reachM: 60 }],
  offM: 300,
  generate: (s, mask) => makeSquare(s.face, s.i, s.j, mask),
});
// every frame, after the render origin has moved:
details.frame({ eye, dir, heightM, timeS, windDir, windStrength: 0.5 });
console.log(details.settled(), details.stats().squares);
```

## Noise volumes

`NoiseVolumes` (in `render`) makes two tileable noise volumes on the graphics card from a seed, for volumetric media such as the [volumetric clouds](environment.md#volumetric-clouds). Both repeat in all three axes.

| Volume | Texels | Memory | What |
| --- | --- | --- | --- |
| `shape` | 128³, R8 | 2 MB | Perlin-Worley: four octaves of gradient noise from 4 cells across, dilated by three octaves of cellular noise (4, 8 and 16 cells) and eroded by the next three (8, 16 and 32). Its raw values lie between about 0.56 and 1; they are stretched from 0.6 … 1 to 0 … 1 (`low` of the recipe), median about 0.58. A cloud shader remaps them with the cover. |
| `detail` | 32³, R8 | 32 KB | Three octaves of cellular noise (2, 4 and 8 cells), weights 0.625, 0.25 and 0.125. |

Add it as a layer. It draws nothing; its `prepare` makes the layers once the driver has compiled both programs, `layersPerStep` of them per frame (default all 160 at once). `ready` is true when both are complete, `step(count)` makes layers by hand, and `bind(device, shapeUnit, detailUnit)` binds the volumes as `sampler3D`. After a context loss they are made again from the first layer. `NOISE_VOLUME_GLSL` gives the noise itself in GLSL (`worleyTile`, `perlinTile`; after `<noise>`).

On an Apple M4 Pro the two programs take about 60–80 ms to compile, once, in parallel with the frames where the driver can. Making all layers afterwards takes 1.6–3.1 ms of GPU time (about 0.025 ms per shape layer, 0.019 ms per detail layer), so spreading them over frames is rarely needed.

**The same volumes on the CPU.** `gen-tex` holds the recipe (`NOISE_VOLUME_SHAPE`, `NOISE_VOLUME_DETAIL`, `WORLEY_WEIGHTS`, the seeds of the octaves) and the same texel function: `shapeNoiseAt`, `detailNoiseAt` and `noiseVolumeData(kind, seed, size?)`, the whole volume as bytes. The features come from the integer hash of `<noise>` and are exact on both sides: a feature point is 10 bits per axis of one hash word, a gradient one of 12 cube edges. The arithmetic after them runs in single precision on the GPU and in double precision on the CPU, so a texel can differ by one step of 8 bits where its value lies on a rounding boundary. For seed 0 that was 3 texels of 49 152 compared in the shape volume and none in the detail volume. One device makes the same bytes on every run. The golden test hashes the CPU volumes.

<!-- check: wrap -->
```ts
import { noiseVolumeData } from 'wallhammer-web/gen-tex';
import { NoiseVolumes } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine;

const volumes = new NoiseVolumes(engine.renderer.device, { seed: 7 });
engine.add(volumes);
// In the prepare of the layer that reads them, once volumes.ready: volumes.bind(device, 9, 10), with the samplers
// fixed to those units (device.fixSampler('u_shape', 9)) and declared `uniform highp sampler3D u_shape;`.
const reference = noiseVolumeData('detail', 7); // 32³ bytes, as the GPU makes them
```

## The sky

`createEngine({ sky: true })` or `sky: { hazeDistanceM, cloudHeightM, … }` adds the sky slot and `SkyLayer` as the first layer. Perspective views only. The sky draws a gradient, a sun glow, sun and moon discs, stars and clouds. The clouds use the same field as the cloud shadows (`CLOUD_OCTAVES`), so they agree. Materials end with `aerialPerspective(display, worldPos)` to fade into the sky. Its params, what the weather does to it and when to take the atmosphere instead are in [Sky and atmosphere](environment.md#sky-and-atmosphere). With `createEngine({ cloudVolume })` the sky is made with `{ clouds: false }` and draws no flat deck: the [volumetric clouds](environment.md#volumetric-clouds) take its place.

**Behind the scene.** As the first layer the sky computes every pixel of the screen, and the scene then draws over most of them. `engine.moveSkyBefore(layer)` sets `SkyLayer.behindScene` and moves the sky to just before `layer` (null: after every layer added so far, but before the volumetric clouds and the precipitation). It then draws at the far end of the depth range with the depth test on and without writing depth, so only the samples nothing has covered get the sky, and each of them the colour it got before. The image is the same as long as every layer drawn before the sky is opaque (writes depth where it draws); give it the first layer that blends or does not write depth (water, glass, particles). In the logarithmic depth mode the sky's fragment shader keeps the pipeline's depth of the far end, so a surface that the logarithm puts at exactly depth 1 (beyond the scene's far end) is covered by the sky. Off by default.

<!-- check: wrap -->
```ts
import type { Engine } from 'wallhammer-web/runtime';
import type { Layer } from 'wallhammer-web/render';

declare const engine: Engine;
declare const water: Layer; // the first layer that blends
engine.moveSkyBefore(water);
```

## The atmosphere

`createEngine({ atmosphere: true })`, or `atmosphere: { … }` with its params, adds air as a shell round a sphere: the atmosphere slot in the Frame block and `AtmosphereLayer` as the first layer. Off by default; the sky above stays what it was and is still the choice for a flat map. Use one or the other. Perspective views only.

The sphere is the renderer's [`radialUp`](#local-up) sphere, and its radius must be the slot's `radiusM`. Without `radialUp` the ground is the plane `groundY` and the air curves away from it as on a sphere of `radiusM`. The air itself (`AtmosphereMedium`: molecules, particles, an absorbing layer, the albedo of the ground) defaults to that of the Earth; `atmosphereFor(radiusM, heightM)` gives the same air fitted to another sphere, with the same light straight down.

<!-- check: wrap -->
```ts
import type { Vec3 } from 'wallhammer-web/base';
import { atmosphereFor, sphereSunDirection } from 'wallhammer-web/env';
import { createEngine } from 'wallhammer-web/runtime';
import type { EngineOptions, EngineView } from 'wallhammer-web/runtime';

declare const options: EngineOptions<EngineView>; // canvas, view, palette, background, renderer: { radialUp }
declare const upAtEye: () => Vec3; // unit up at the place of the eye

const engine = createEngine({ ...options, atmosphere: { ...atmosphereFor(100_000, 30_000), exposure: 30 } });
// The sun over a turning sphere, and the light of the frame for the place under the eye.
engine.renderer.beforeFrame.unshift(() => {
  engine.env.observer = { up: upAtEye(), sunDir: sphereSunDirection(172, engine.env.day.time) };
});
```

How it works:

- **Tables.** Three small tables are computed on the CPU when the slot is made, from the medium alone (pure, no files; in the order of a tenth of a second on the calling thread, once): how much sunlight passes the air from a point toward the sun, the light scattered more than once, and the sky's light on a level surface. They are stored in one 160 × 32 RGBA8 texture (`atmosphereTables`, `ATMOSPHERE_TABLE_LAYOUT`), which the layer keeps on texture unit 14 (`ATMOSPHERE_TABLE_UNIT`, sampler `u_atmTables`) for every layer drawn after it. The tables do not depend on the sun or the eye, so nothing is baked again while they move.
- **The sky** is the integral of the scattered light along a view ray (`atmosphereSky`, `skySteps` steps), from wherever the eye is: on the ground, in flight, above the air. There is one code path, so the way up has no seam: from orbit the same integral gives the rim of the shell round the sphere, and the shadow of the sphere in its own air gives the line between day and night. The pixels do not integrate it themselves. Before the passes of a frame the layer fills the **sky table** on the graphics card (`Layer.prepare`; 64 × 128 texels, `ATMOSPHERE_SKY_TABLE`, three 16-bit float textures, program `ATMOSPHERE_TABLE_FS`) with that integral for directions over the whole sky of the eye, and every pixel reads it. The table is filled again only in a frame whose environment or eye differs from the last one.
  - Columns follow the cosine of the angle round the eye's up between the direction and the sun. Rows are in two halves that never blend into each other, so the horizon stays a line: the lower half holds the directions that end on the ground sphere, the upper half the others, up to straight up, or up to the rim of the shell for an eye above the air. Both halves are spaced by the square root of the angle from the horizon, where the light changes fastest.
  - The light of particles is stored before its phase value and the pixel multiplies that in, so the glow round the sun stays sharp. The sun's disc and the stars are worked out per pixel as before, behind the share of light the table says passes.
- **Materials** take the air between the eye and the surface at their vertices and apply it in the fragment shader: `v_air = atmosphereAir(worldPos, v_airThrough)` in the vertex shader (`airSteps` steps per vertex, two `vec3` varyings), and `atmosphereApply(display, v_world, v_air, v_airThrough)` at the end of the fragment shader, after `toDisplay` and `applyFog`. Both values change slowly over a surface, so this suits any mesh whose triangles are small against the distance over which the air changes (streamed terrain, objects). A material with very large triangles calls `atmosphereApply(display, worldPos)` instead, which integrates per fragment. A material that is also used without the slot needs no branch for this: the stand-ins give no air and return the input.
- **Reference quality.** `params.reference = true` (may change at any time) makes every pixel integrate its own ray again: the sky per pixel, and `atmosphereApply` with the vertex values per fragment. It costs many times more and is there to compare the picture against. The layer also falls back to it for the sky where the graphics card cannot draw into 16-bit float textures.
- **Light on surfaces.** `atmosphereLight(worldPos, n, sun, ao)` stands in the place of `lightOnAt`: the sun through the air above the point (white high up, red through a long way of air, none behind the sphere), the sky's light there, and `nightLight`. It is computed for the point, not for the eye, so the far side of a sphere is dark while the eye stands in daylight. `atmosphereSun(worldPos)` is the colour of the direct sun alone, e.g. for a glint.
- **Under an overcast sky.** The slot carries how overcast the sky over the eye is (`u_atmCloud.x`, `atmosphereOvercast`: the frame's cloud cover from 0.5 to 0.9, gone for an eye above twice `cloudTopM`). There `atmosphereLight` takes a grey, even light from the clouds in place of the sky's, and `atmosphereApply` greys and dims the air. A material greys under the clouds only through these two calls. See [Overcast with the atmosphere](environment.md#weather).
- **The sun.** The slot takes the direction to the sun from the environment (`sunDir` of the frame). For a world with one up that is the site's sun. For a sphere set `Environment.observer` every frame (default `null`): the sun then stands in the given world direction, and the values of the frame that follow its height (light colours, exposure, the direction of the shadow map, the swap to the moon) are computed for the place with the given up.

<!-- check: skip -->
```ts
#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
// …
float sun = sunVisibility(v_world, n, 1.2);
#ifdef WH_ATMOSPHERE
  vec3 lit = albedo * atmosphereLight(v_world, n, sun, 1.0);
#else
  vec3 lit = albedo * u_warmTint.rgb * lightOnAt(v_world, n, sun, 1.0);
#endif
// v_air and v_airThrough come from the vertex shader: v_air = atmosphereAir(v_world, v_airThrough);
o_color = vec4(atmosphereApply(applyFog(toDisplay(lit), v_world), v_world, v_air, v_airThrough), 1.0);
```

Params that may change at any time (`engine.atmosphere.slot.params`): `exposure` (scattered light to screen colour, `1 − exp(−light × exposure)`), `sunLight`, `skyLightGain`, `nightLight`, `sunDiscRad`, `stars`, `cloudTopM` (the clouds' top, 4000 m: above twice it the eye no longer stands under an overcast sky), `groundY`, `reference`. The medium and the step counts `skySteps` and `airSteps` are read once, when the slot is made. Without `createEngine`: pass `atmosphereSlot(params)` to `assembleFrameBlock` and to the `EnvironmentLink`, then add `new AtmosphereLayer(renderer, slot)` first.

Limits: the atmosphere draws no clouds and no moon, and of the weather only the cloud cover over the eye changes it (the overcast; `applyFog` still adds the fog). The tables hold 8 bits per channel behind a square root. A pixel of the sky costs three reads of the sky table, and a fragment of a material that takes the air at its vertices costs nothing more than the two varyings; the steps (three table reads each) are paid per texel of the sky table (`skySteps`) and per vertex (`airSteps`). In the reference quality, and for `atmosphereApply(display, worldPos)`, they are paid per pixel. Across one triangle the air is interpolated, so a triangle that spans a long way of air (a single quad to the horizon) shows it only roughly: such a material integrates per fragment. The sky table follows the sun by 64 columns: the shadow line of the sphere in the sky at dusk is as sharp as that allows. Shadows still come from the one shadow map round the eye.

## Resolution and antialiasing

`createEngine({ maxPixelRatio })` caps the canvas's pixels per CSS pixel (default none: the device's own ratio, as before). With a cap below the device's ratio the image is drawn at fewer pixels and the browser scales the canvas up to its CSS size; the view's `dpr` is the ratio in effect, so input and pixel sizes stay right. Without the engine pass the same cap to `observeCanvasSize` and `syncCanvasSize` (`canvasPixelRatio(max)` gives the ratio).

`renderer: { samples }` chooses the samples per pixel of the main target: 0, 2 or 4 (`Device.setMainSamples`; the engine also creates the context to match, by hand use `createContext(canvas, depth, samples)`). Default unchanged: the canvas's own antialiasing in the standard depth mode, 4 samples in the reversed and logarithmic modes. In the standard mode 0 and 4 keep drawing into the canvas (made without or with antialiasing); 2 draws into the device's offscreen target with a 32-bit float depth buffer and copies it to the canvas in `present`, as the other depth modes do, because a canvas cannot be asked for a sample count. `Device.mainSamples()` reports the count in effect.

`renderer: { readableDepth: true }` makes the standard depth mode draw into the offscreen target too, with the samples it would have had (`Device.setReadableDepth`; by hand create the context with `createContext(canvas, 'standard', samples, true)`), so `device.sceneDepth()` can copy the depth for a layer to read. The picture is the same; the copy to the canvas in `present` costs about 0.15–0.3 ms a frame at 1600 × 900 on an Apple M4 Pro. `createEngine` turns it on when the precipitation draws its landing marks (`precipitation: true` in a perspective view, unless `impacts: false`; see [Rain and snow](environment.md#rain-and-snow)). The reversed and logarithmic modes and 2 samples draw offscreen anyway.

<!-- check: wrap -->
```ts
import { createEngine } from 'wallhammer-web/runtime';
import type { EngineOptions, EngineView } from 'wallhammer-web/runtime';

declare const options: EngineOptions<EngineView>;
const engine = createEngine({ ...options, maxPixelRatio: 1.5, renderer: { ...options.renderer, samples: 2 } });
console.log(engine.view.dpr, engine.device.mainSamples());
```

## A grade of the picture

`createEngine({ grade })` (or `device.grade`, a `DisplayGrade` or null) grades the finished picture when the frame is shown, in the copy of the offscreen main target to the canvas (`Device.present`). In this order: `exposure` multiplies the colour, `lift` raises the dark end toward a colour and `gain` multiplies the result, `gamma` bends the middle (above 1 brighter), `saturation` moves the colour away from its grey and `contrast` away from the middle grey. `DEFAULT_DISPLAY_GRADE` changes nothing. The engine keeps the object it was given, so its values may change in any frame. The grade needs the offscreen main target: the reversed and logarithmic depth modes have it, and in the standard mode `createEngine` turns on the readable depth for it (by hand: `readableDepth`). Without a grade the copy is the same as before.

<!-- check: wrap -->
```ts
import { DEFAULT_DISPLAY_GRADE } from 'wallhammer-web/gpu';
import type { DisplayGrade } from 'wallhammer-web/gpu';
import { createEngine } from 'wallhammer-web/runtime';
import type { EngineOptions, EngineView } from 'wallhammer-web/runtime';

declare const options: EngineOptions<EngineView>;
const grade: DisplayGrade = { ...DEFAULT_DISPLAY_GRADE, saturation: 1.1, lift: [0.01, 0.01, 0.03] };
const engine = createEngine({ ...options, grade });
grade.exposure = 0.9; // at any time
engine.invalidate();
```

## Allocation-free frames

A frame of a still scene allocates nothing in the renderer: the Frame block is written in place, the shadow key is compared as numbers and the view key, and the renderer hands its own scratch to the view (`View.axes(out)`, `View.cornerRays(out)`, `View.viewProj(…, out)`, `depthViewProj(…, out)`). These `out` arguments are optional: a rig that ignores them still works and allocates as before. `PerspectiveOrbitRig` and `SteppedOrthoRig` honour them and build `key()` only when a number in it changed; `FreeRig` takes `eye(out)` only (its up comes from the world shape). `SkyLayer` and the frame loop allocate nothing per frame either. Still allocating per frame: the returned `FrameStats` object, the environment (`Environment.frame` and the slots' `pack`), and a refit (the light fit and the view's cull volume).

## Statistics and benchmarks

`renderer.render(view)` returns `FrameStats` (triangles, draw calls, shadow triangles and calls, CPU ms, instances visible). `renderer.lastStats` keeps the last one. `renderer.benchmark(view, n)` renders `n` frames synchronously and returns ms per frame. It flushes after each frame, as presenting a frame would: without that, Chrome's Metal backend merged the frames of a still view (no shadow pass, so no render target switch between them) into one long render pass, and a whole-town view measured 15–21 ms instead of about 4 ms.

**Frame profile.** `profileFrame(renderer, view)` from `tools` measures what the frame costs on the graphics card at hand and what every layer adds to it, in the colour and in the shadow pass (see [Tools](tools.md#frame-profile)). It uses two hooks of the renderer that are idle in normal use: `Layer.name` (optional, shown in the profile) and `Renderer.probe` (`RenderProbe`: `draws(layer, pass)` may leave a layer out of a pass or of `prepare`, `drawn(layer, pass, triangles, calls)` reports what it counted). With `probe` null the renderer does exactly what it did before.

**GPU memory.** `device.memory()` returns the bytes the device has allocated and not deleted: `buffers` (vertex, index, instance, uniform), `textures` (uploads and bakes, mipmaps included), `targets` (the shadow map) and `total`. Every `Mesh` carries `bytes` (its own buffers; 0 for a mesh from `shareMesh`). The canvas's drawing buffer is not counted.

## Without `createEngine`

The same parts by hand. Use this when you need a non-standard loop.

<!-- check: wrap -->
```ts
import { Device, Environment, SteppedOrthoRig, createContext, definePalette } from 'wallhammer-web';
import { Renderer } from 'wallhammer-web/render';
import { assembleFrameBlock } from 'wallhammer-web/env';
import { EnvironmentLink } from 'wallhammer-web/runtime';

const palette = definePalette({ background: '#6795b1', ground: '#4d4335' });
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const device = new Device(createContext(canvas));
const block = assembleFrameBlock([]); // environment slots go here
const renderer = new Renderer(device, { palette: palette.data(), frameSlots: block });
const env = new Environment({ mode: 'day' });
const link = new EnvironmentLink(renderer, env, { background: palette.color('background'), block });
renderer.bounds = { min: [0, 0, 0], max: [500, 80, 500] };

const view = new SteppedOrthoRig({ yawDeg: 22.5, pitchDegByZoom: [35, 45], pxPerMeterByZoom: [1, 4] });
view.bounds = { minX: 0, maxX: 500, minZ: 0, maxZ: 500 };
renderer.render(view);
```

The link registers itself in `renderer.beforeFrame`, so each `render` computes the environment first. You still size the canvas and the view yourself (`syncCanvasSize` or `observeCanvasSize` in `platform`), run the clocks and own the loop. `src/runtime/engine.ts` shows the exact calls.

## Loss of the graphics context

A browser may take the WebGL context of a canvas away at any time (a driver reset, too many contexts, a tab put to sleep) and hand a fresh, empty one back later. Every program, buffer and texture of the old context is then void. By default the engine does nothing about it. With `contextRecovery: true` in `createEngine` it restores the picture without a reload:

- `Device.retainUploads` is set, so the device keeps what every mesh, instance buffer, texture and bake was made from. These are references to the arrays the caller uploaded, not copies; the price is that uploaded data stays in memory for as long as its GPU object lives.
- `watchContextLoss` (module `platform`) answers the browser's "lost" event so that a restore happens at all, and reports the restore.
- While the context is lost, `Device.lost` is true and `Renderer.render` returns without drawing. Uploads made in that time get handles that are filled in on the restore.
- On the restore, `Device.contextRestored()` puts the context state back and makes everything again in place: the same `Program`, `Mesh`, `InstanceBuffer` and `Texture` objects are valid again, including bytes written into mesh vertices with `writeBuffer`. Then the `onRestored` listeners run; the renderer uses one to draw its shadow maps again. The engine draws a frame.

<!-- check: wrap -->
```ts
import { createEngine } from 'wallhammer-web/runtime';
import type { EngineOptions, EngineView } from 'wallhammer-web/runtime';

declare const options: EngineOptions<EngineView>;
const engine = createEngine({ ...options, contextRecovery: true });

// For a test: take the context away as a driver reset would, and ask for it back.
if (engine.device.loseContext()) setTimeout(() => engine.device.restoreContext(), 500);
```

Without `createEngine` the same takes three lines: set `device.retainUploads = true` before the first upload, call `watchContextLoss(canvas, { restored })`, and in `restored` call `device.contextRestored()` and draw a frame. A device without `retainUploads` still restores its programs, uniform blocks and depth targets; whoever owns meshes and textures then makes them again in an `onRestored` listener (`StreamedWorld` does: it uploads its cells again from their CPU data, see `reupload()`).

What is not restored: anything drawn into a texture outside a bake, and GPU objects made with the low-level helpers (`createBuffer`, `createTexture` of `gpu`) instead of the device.

## Known weak spots

- Includes are a plain text replace without nesting or include guards.
- Depth modes: the shadow map keeps 24-bit standard depth in every mode. With logarithmic depth a multisampled pixel has one depth for all its samples, so the line where two surfaces cut through each other is not antialiased (outlines are).
- The shadow map does not follow animation time. Moving shadow casters other than `TransientLayer` batches need `invalidateShadows()`, or `shadowCasters: 'dynamic'` with `shadowDirty()` (see [Moving casters](#moving-casters)).
- Texture units are shared by convention, with no allocator. Some are held for a whole pass; a layer binds its own textures from unit 1 up and may use units 1–11:

  | Unit | Held by | When |
  | --- | --- | --- |
  | 0 | the shadow map (`SHADOW_MAP_UNIT`) | always |
  | 1–11 | the layer that is drawing (`MeshLayer` starts at 1) | during its own draws |
  | 2–4 | the data view's ground (`tools`) | during its draws; next to `MeshLayer`'s units starting at 1 |
  | 7–11 | `CloudVolumeLayer`: the noise volumes, the weather map, the scene's depth, its own targets | during its own draws in `prepare` and the colour pass |
  | 11 | the liquid's near surface and shafts: the scene's depth (`LIQUID_SCENE_UNIT`) | during their own draws |
  | 12 | the cloud shadow texture (`CLOUD_SHADOW_UNIT`) | the whole colour pass, with `cloudShadows` |
  | 13 | nobody: the spare unit the engine's layers select after their binds | keep it empty |
  | 14 | the atmosphere's tables (`ATMOSPHERE_TABLE_UNIT`) | the whole colour pass, with `atmosphere` |
  | 15 | the light horizon (`SHADOW_HORIZON_UNIT`) | with a light horizon |

  A layer that binds a texture on unit 12 or above takes a held unit over. While it draws the sky the atmosphere layer also uses units 1 to 3 for the sky table and leaves them empty. A unit holds a 2D, a 3D and a cube texture side by side, and a program must not read two kinds from one unit.
