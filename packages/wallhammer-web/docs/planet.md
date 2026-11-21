# The planet example

`examples/planet` is one scene that uses the engine's large-scale options together: a flight from the surface of a small planet up to where the whole sphere is in view, and back. It imports only the engine. The terrain, the objects, the materials and the flight are files of the example.

Read [World streaming](streaming.md) first; this page only says how the parts are joined.

## Run

```sh
docker compose up -d
```

Open <http://127.0.0.1:5281/planet/>. The `dev` service serves it with the other examples; the port comes from `EXAMPLES_PORT`. Press `F` to start the flight, or open `#fly=1` to start it as soon as the start view has loaded.

| Key | What |
| --- | --- |
| `F` | Start the flight, or stop it where it is. `Escape` stops it too. |
| `W` `A` `S` `D`, `E` `Q`, `Shift`, drag, wheel | The free camera: fly along the view, up and down, faster, look around, change the speed. |
| `1`, `2` | Jump to the top of the flight, and back to the surface. |
| `[`, `]` | Move the hour by half an hour. |
| `L` | Tint every cell by its quadtree level. |
| `B` | Measure a frame of the current view with the graphics work finished. |
| `C` | Hide and show the clouds. |
| `H` | Hide the panel. The line at the bottom stays. |

The line at the bottom shows the height above the surface, the speed, the patches drawn (of those loaded), the time of a frame and the GPU memory. The README of the example lists the keys of the URL hash.

## What the scene is made of

| Part | Engine | In the example |
| --- | --- | --- |
| The shape | `SphereWorld` of `wallhammer-web/world`, radius 100 km, six quadtrees of levels 0 to 11 ([A sphere world](streaming.md#a-sphere-world)) | `SHAPE` in `world.ts` |
| The terrain | `spherePatchMesh` and `fractalNoise3` of `wallhammer-web/gen-core` | `groundHeight`, `surfaceColor`, `generatePlanetCell` in `world.ts`; seven biomes from latitude, height and a moisture noise (`climate`, `landWeights`); the seed is the example's own |
| Levels without a jump | `morph: true` of `StreamedWorld` and `SPHERE_PATCH_GLSL` ([Blending between levels](streaming.md#blending-between-levels)) | the vertex shaders in `shaders.ts` |
| Objects that hand over to the surface | `coverFade`, `coverKeep` of `wallhammer-web/core` ([Content beyond its levels](streaming.md#content-beyond-its-levels)) | four kinds of plants (conifer, broadleaf, flat crown, shrub) and rocks from level 10 on; levels 7 to 9 keep the tallest trees, thinned by a rank; coarser cells carry their look in the surface as a canopy that lifts the ground of a wood, darkens and hides more of it as the view grazes, with a ragged edge where a wood ends sharply (`shaders.ts`) |
| The air | `atmosphereFor(radius, height)` passed to `createEngine` ([The atmosphere](rendering.md#the-atmosphere)) | a shell 30 km thick; `#atm=0` switches it off, key `R` compares with the reference quality; the materials take the air at their vertices (`atmosphereAir`) |
| The sun | `env.observer` with `sphereSunDirection` | set every frame for the place under the camera |
| The clouds | `cloudFieldSlot`, `createEngine({ cloudVolume, cloudShadows, precipitation })`, `CloudShellLayer` as the volume's `shell` ([Clouds](environment.md#clouds)) | a cover by place of the example's own (`weather.ts`); `#clouds=0` builds the page without them, `#vol=0` keeps the shell alone, `#cover=` sets one cover everywhere |
| The sea | `MEDIUM_GLSL` and its functions of `wallhammer-web/core` ([A medium below a level](rendering.md#a-medium-below-a-level)) | the floor in the terrain, the water a second mesh of material `water`, a backdrop under the water (`sea.ts`); see [The sea](#the-sea) |
| Up | `radialUp` of the renderer ([Local up](rendering.md#local-up)) | `SHAPE.radial` |
| The camera | `FreeRig` with `bindFreeInput` ([Cameras and views](cameras.md)) | up to 40 km/s; the speed follows the height |
| Precision | `originAxes: 'all'` of `StreamedWorld` and the depth mode `reversed` or `logarithmic` ([Depth modes](rendering.md#depth-modes)) | `#depth=logarithmic` switches the mode |
| Memory | `gpuCeilingBytes` of `StreamedWorld` ([A ceiling of GPU memory](streaming.md#a-ceiling-of-gpu-memory)) and the horizon test | 560 MB by default, `#gpu=` changes it |

The joining code is short. This is its skeleton; the names declared at the top are the content's part.

<!-- check: wrap -->
```ts
import { definePalette } from 'wallhammer-web';
import type { MaterialDesc } from 'wallhammer-web/base';
import { FreeRig } from 'wallhammer-web/camera';
import { atmosphereFor, sphereSunDirection } from 'wallhammer-web/env';
import { bindFreeInput } from 'wallhammer-web/platform';
import { SphereWorld } from 'wallhammer-web/world';
import type { CellProvider, StreamingConfig } from 'wallhammer-web/world';
import { StreamedWorld, createEngine, viewerTickets } from 'wallhammer-web/runtime';

declare const canvas: HTMLCanvasElement;
declare const provider: CellProvider;
declare const config: StreamingConfig;
declare const terrainDesc: MaterialDesc;
/** Height of the visible surface under a world position, above the base sphere. */
declare const surfaceUnder: (p: readonly [number, number, number]) => number;

const RADIUS_M = 100_000;
const DAY_OF_YEAR = 172;
const shape = new SphereWorld(RADIUS_M);

// The camera takes up from the shape and keeps itself above the surface.
const rig = new FreeRig(
  { fovYDeg: 50, maxPitchDeg: 90, minClearance: 2, minSpeed: 5, maxSpeed: 40_000 },
  { shape, heightAbove: (p) => shape.altitude(p) - surfaceUnder(p) },
  { position: [0, RADIUS_M + 500, 0], yawDeg: 0, pitchDeg: 3 },
);

const engine = createEngine({
  canvas,
  view: rig,
  palette: definePalette({ sky: '#05070c' }),
  background: [0.02, 0.027, 0.047],
  renderer: { depth: 'reversed', radialUp: shape.radial },
  environment: { mode: 'day', site: { latitudeDeg: 0, longitudeDeg: 0, dayOfYear: DAY_OF_YEAR, utcOffsetHours: 0 }, hour: 9, weather: {} },
  atmosphere: atmosphereFor(RADIUS_M, 30_000),
});

const world = new StreamedWorld({
  renderer: engine.renderer,
  config,
  provider,
  originAxes: 'all',
  morph: true,
  horizon: { center: shape.centerM, radiusM: RADIUS_M },
  gpuCeilingBytes: 560 * 1024 * 1024,
  materials: { terrain: engine.renderer.material(terrainDesc) },
  onActivity: () => engine.invalidate(),
});
engine.add(world);

const input = bindFreeInput(engine.canvas, rig, { onChange: () => engine.invalidate() });
// Before the streaming step of every frame: move, then hand the camera to the world.
engine.renderer.beforeFrame.unshift(() => {
  input.step();
  const p = rig.position;
  const eye: [number, number, number] = [p[0], p[1], p[2]];
  engine.env.observer = { up: shape.directionOf(eye), sunDir: sphereSunDirection(DAY_OF_YEAR, engine.env.day.time) };
  world.setFocus(eye);
  rig.origin = [world.origin[0], world.origin[1], world.origin[2]];
  world.setEye(eye);
  world.setTickets(viewerTickets({ eye, altitude: rig.clearance, forward: rig.axes().forward, velocity: rig.velocity, pixelsPerRadian: 1158 }));
});
engine.start();
```

### The strips

`strips.ts` lays one strip 50 km long over an edge of the cube and forks it at its far end into two lines of 6 and 4 km, with the engine's strip tools ([Strips along a surface](generators.md#strips-along-a-surface)). `planetStrips(seed)` searches the route from the seed: 64 candidates, each a point on an edge of the cube and a heading 50°–70° to it, the first with land under 80 % of its points and nothing above 1800 m; the grade is the ground smoothed along the line, at most 6 m from it. `generatePlanetStripCell` is `generatePlanetCell` through its hooks (`buildPlanetCell`): the ground cut and filled with `stripCarve`, no objects and no cover on the shoulders, the shoulders tinted as bare ground, and the strip mesh as a second mesh of material `strip` (domain version 6). Away from the strips the ground stays as it is, the sea floor too. The page shows the strips by default and starts on the main line; `#strip=0` is the page without them, its generator, worker and materials. `window.__wh.presets()` adds views from orbit, over the edge of the cube, with level tints, from 900 m, from the surface and over the node.

### The weather

The clouds are the engine's [cloud cover by place](environment.md#cloud-cover-by-place) with a field of the example's own (`src/weather.ts`): a profile by latitude moved a little by the seed, and patches of value noise about 32 km across that start at a place given by the seed and drift with the page's wind. `planetWeatherAt` asks `cloudFieldCover` for the cover under the eye and makes the rest of the weather from it: rain or snow from a cover of 0.6, snow where the place is cold, a little fog. The page sets that as `env.weather`, the cover and the fog faded out between 4 and 8 km up, the rain between 1.5 and 2 km, so from high up the frame's light is that of a clear sky.

Near the ground the clouds are the volumetric clouds (`cloudVolume: true`, 1.5–4 km above the sea, so the mountains reach into them); the `CloudShellLayer`, added after the world and handed to the volume as its `shell`, draws them beyond 20–40 km and alone from 15–30 km up. Their shadows come from a texture (`cloudShadows: true`); the rain stops where no cloud stands over the eye (`rainShare`). With the cover by place `sunVisibility` gives the share of the sun over the frame's dimming, and `atmosphereLight` does not carry that dimming, so the materials multiply the share by `u_cloudFieldLight.y`. The slot stays in the block with `#clouds=0` too, holding no cloud.

### The sea

The sea fills everything below the base sphere. Its floor is the terrain itself (`groundHeight` below 0, coloured by `surfaceColor`: wet sand near the shore, rock in patches, paler silt further down), and every cell whose ground goes under 0 carries a second mesh at height 0 with material `water`, drawn after the others with blending. All materials take `u_sea` (the eye's height above the waves and above the level, set every frame) and apply the water on the way to a fragment with `mediumPath` and `mediumApply` of the engine; the light at the floor is what is left of the surface's light at its depth, with soft moving caustics, strong only in the top metres.

The sea is the engine's [liquid below the level of a sphere](rendering.md#a-liquid-below-the-level-of-a-sphere) with the page's wind, colours and materials. The surface moves with the engine's [waves](rendering.md#a-moving-surface-of-waves): eight trains raised by the page's wind, on a chart of the sphere (the face of a cube under the eye, `sea.ts`) with the phases at the eye's foot computed in double. While the eye is low a grid of rings round its foot (`SeaSurfaceLayer`, 500 m across) is moved by them; beyond it the water of the cells is flat and takes the waves' normal per pixel. The eye's height above the moving surface comes from `waveHeight` on the CPU, so above and below agree with the picture.

From above, the water shows the floor through it, the old colours of the sea from higher up, the reflected sky by the Fresnel share, the sun's glint broken by the waves, foam on the crests and along the shore. From below, the surface shows the sky and the sun inside the window of refraction, bent and broken by the waves and their ripples, the sun as a glitter, and the water under it mirrored beyond; light shafts run down along the refracted sun (`SeaShaftsLayer`); a backdrop (`SeaBackdrop`, `sea.ts`) stands at `mediumClearDistance` (about 85 m) in front of the camera, drawn before the cells, in place of the sky, the air and the clouds. At the surface a waterline crosses the lens (`SeaLensLayer`). The eye under water gets used to the dimmer light in part, so the deep water is darker but not black. The camera may go under the water down to 2 m over the floor; `alt` in the URL and the height on the screen are above the top of land or water, negative under it. No rain falls while the eye is under the water.

`findSeaPlaces(seed)` searches the places the views of the sea start from: a shallow one 5–10 m deep in a warm sea with the floor rising toward the shore, and a deeper one 70–120 m deep on a slope. `window.__wh.presets()` adds `sea-above`, `sea-crossing`, `underwater`, `underwater-up` and `underwater-deep`, and `#view=underwater` opens one of them.

### The movie

`M` or `#movie=1` plays a hands-off show of all of the above in seven shots, 89 s, looping (`movie.ts`): the limb from 45 km, a descent, a valley, a glide under the sea, a summit, rain under a deck and a rise through the clouds to the top. It is example code, not an engine feature. Every shot is data (`MOVIE_SHOTS`); `planMovie` finds its place from the seed and turns it into a pose that is a pure function of the time into the shot (the eye, the view, the hour and the animation time of the clouds), and `movieFrame(movie, t)` gives the pose and the fade at a time of the whole movie. For a recording frame by frame the page holds the movie at a time and resolves when the streaming and the clouds have settled (`window.__wh.movieFrame(t)`; the example's README lists the calls).

## The flight

`flight.ts` holds the flight as a pure function: `flightPose(plan, radiusM, t)` returns the height, the vertical speed, the pitch and the turn of the view `t` seconds after the start. Nothing in it depends on the frame rate, so the flight is the same on every run and the way down mirrors the way up.

- The height grows as a power of the progress, from 3 m to about 260 km. Every doubling of the height takes the same time, so the streaming has the same work per second all the way.
- The progress eases in and out with no speed and no acceleration at either end.
- The view starts a little under the horizon, keeps the horizon in the picture while it sinks, and ends straight down with the sphere in the middle.
- The top lies a quarter above `wholeSphereHeight(radius, air, fov)`, the least height from which the whole sphere with its air fits the view.

The page drives the camera from the pose with `rig.setState` and sets `rig.velocity` for the speed it shows. The ticket ahead of the camera that `viewerTickets` makes of the velocity changes nothing on a way straight up or down: it stands over the same point at the same height as the camera's own ticket. A stalled frame moves the flight by at most a tenth of a second.

## The budget

The example is built for a frame under 8 ms and under 600 MB of GPU memory at 1920×1080.

- **Cells.** At most 900 cells are wanted at a time (`maxCells`); with less the tolerance grows evenly instead of leaving holes. A patch is 32 × 32 quads.
- **Memory.** `gpuCeilingBytes` counts everything the device holds (cells, shadow map, targets, tables of the air). Over the ceiling the least needed cells leave.
- **Shadows.** One map of 4096² for the nearest 4 km.

The panel shows a report of the last flight: the time between frames (mean and worst, a stalled frame with its full length), the refresh interval of the display as the flight saw it and the number of frames that missed a refresh (`refreshMs`, `framesMissed`), the main thread's part of a frame and how often it alone was above 8 ms (`cpuOverBudget`), the peaks of GPU memory, patches and holes, and one frame at the landing measured with `renderer.benchmark`, which waits for the graphics work. The time between frames cannot fall under the refresh interval of the display, so it is compared with that interval and not with the budget: on a display of 120 Hz or more a flight without a missed refresh stayed near the budget all the way, on a slower one only the measured frame says how much room there is. A script reads the same numbers from `window.__wh.flightReport()`. To measure along the flight it holds a pose with `window.__wh.setFlight(seconds)` (the flight then starts where the camera stands, so call it at the start view), waits for `window.__wh.settled()` and calls `window.__wh.measureFrame()`.

## Checks

The flight is checked without a browser, in the `dev` container:

```sh
docker compose exec -T dev sh -c 'cd /app/examples/planet && pnpm verify'
```

`scripts/verify.ts` checks the generator, the pose function, the streaming along the flight with the real generator and the movie: the sphere is covered exactly once at every step, a child is never requested before its parent, the budget of cells holds, the estimate of GPU memory stays under 600 MB, and every shot of the movie keeps above the ground (under the sea above its floor) and moves without a jump. `flight-check.ts` does the flying; it feeds the `StreamingManager` of `wallhammer-web/world` with the tickets of every step and finishes a fixed number of jobs per step in place of the workers.

The golden test of the examples (`tools/golden/golden.ts`) holds the recipes of the example: "planet example cells", "planet example flight", "planet example strips", and for its other pure parts "planet example weather", "planet example sea places" and "planet example movie" ([Tools](tools.md)).

What these checks cannot see is the picture: the shaders, the look of the air and the frame time need a browser with a GPU.
