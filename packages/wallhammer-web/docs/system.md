# The system example

`examples/system` is one scene with a sun and four bodies on their paths. The camera starts at a view of the whole system and flies down to a few metres above the surface of any body, in one shot and without a loading screen. It imports the engine and, for the structures of its settlements and their damage, the content modules `gen-arch` and `sim/destruction` (the structure material with the `framed` and `finishes` options, see [Finishes and frames](generators.md#finishes-and-frames)). The bodies, their terrain, the materials, what is drawn from afar and the flights are files of the example.

Read [Bodies on rails and nested frames](frames.md) and [The planet example](planet.md) first; this page only says what the example adds to them.

## Run

```sh
docker compose up -d
```

Open <http://127.0.0.1:5281/system/>. The `dev` service serves it with the other examples; the port comes from `EXAMPLES_PORT`.

| Key | What |
| --- | --- |
| `1` `2` `3` `4` | Fly to Hearth, Pale, Ember, Rime: from the surface of one body to the surface of the other, or down from where the camera is. |
| `0` | Fly to the view of the whole system. |
| `F` | Fly to the next stop of the tour (the four bodies, then the whole system), or stop the flight. `Escape` stops it too. |
| `W` `A` `S` `D`, `E` `Q`, `Shift`, drag, wheel | The free camera, anywhere between the view of the whole system and two metres above a surface. Its speed follows its height. |
| `,` `.` | Time slower and faster: ×0, ×1, ×10, ×100, ×1000. `P` pauses it. |
| `O`, `N` | Show and hide the paths of the bodies, and their names. |
| `L` | Tint every cell by its quadtree level. |
| `M` | Show and hide the marks of the plan of Hearth: its rivers by class and the edges of its lakes. |
| `R` | Fly from orbit down to the spring of the longest river of Hearth and along it to the sea (with the plan built). |
| `C` | Show and hide the clouds of Hearth (stage 2, `world=2`). |
| `J` | Show the shade of the relief alone, in grey (stage 5, `world=5`). |
| `B` | Measure a frame of the current view with the graphics work finished. |
| `H` | Hide the panel. The line at the bottom stays. |

The line at the bottom shows the body the camera is kept by, the height, the speed, the rate of the time, the patches drawn, the time of a frame and the GPU memory. The README of the example lists the keys of the URL hash.

## What the scene is made of

| Part | Engine | In the example |
| --- | --- | --- |
| The paths and the turning | `BodySystem` of `wallhammer-web/core`, stepped with `setTick` ([A system of bodies](frames.md#a-system-of-bodies)) | `bodies.ts`: a sun, Hearth with its moon Pale, Ember, Rime; the time is a whole number of ticks |
| The camera's place | `FrameSet.convertPoint` and `convertDirection` ([Nested frames](frames.md#nested-frames)) | kept in the frame of the body the camera is at; see below |
| Up | `UpSource` of `FreeRig` and `radialUp` of the renderer ([Local up](rendering.md#local-up)) | away from the centre near a body, along its axis farther out, the up of the system between the bodies |
| The surface of each body | `SphereWorld`, `spherePatchMesh`, `StreamedWorld` with `morph: true` ([A sphere world](streaming.md#a-sphere-world)) | one generator for all bodies (`world.ts`), four terrains, the seed of a body is the seed of the system and its index |
| The body the camera is at | one `StreamedWorld`, made on arrival and disposed on leaving | all cells from one pool of workers; the six coarsest cells of every body are kept from the start |
| Every other body | a layer of the example (`Layer` of `wallhammer-web/render`) | `far.ts`: the six coarsest cells of the same generator, lit by the sun from the body's own place |
| The air | `atmosphereFor(radius, height)` for the body the camera is at ([The atmosphere](rendering.md#the-atmosphere)) | from afar a shell with a thickness worked out per pixel (`SHELL_FS`); the two are blended over a range of distance |
| The sun, the stars, the paths | none | `far.ts` and `shaders.ts`; the stars are fixed to the frame of the system |
| Precision | `originAxes: 'all'`, `snapRenderOrigin`, `relativeMatrix`, depth mode `reversed` ([Depth modes](rendering.md#depth-modes)) | everything on the GPU is relative to a render origin near the eye |

## One frame for the camera, handed over without a jump

The position of the camera is a 64-bit point in one frame of the system, and the picture is drawn in that frame:

- near a body (within 6 radii) the **turning frame** of that body: the ground stands still under the camera, and its cells are streamed in the frame they were generated in;
- farther out, inside the reach of a body (`influence`), its **carried frame**: the body stays in place, the stars do not turn;
- between the bodies the carried frame of the sun.

`BodySystem.dominantBody` picks the body. Entering a reach takes the camera over at its border, leaving it a tenth beyond, so the choice does not flip on the border. When the frame changes, the position, the heading and the velocity are converted, and nothing else changes: it is the same place and the same view in other numbers.

<!-- check: wrap -->
```ts
import { FreeRig } from 'wallhammer-web/camera';
import { BodySystem } from 'wallhammer-web/core';

declare const system: BodySystem;
declare const rig: FreeRig;
/** The frame the camera's position is in, and the body it is kept by. */
declare let frame: number;
declare let attached: number;

function handOver(): void {
  const enter = system.dominantBody(rig.position, frame, 1);
  const keep = system.dominantBody(rig.position, frame, 1.1);
  const next = keep === attached ? attached : Math.max(enter, 0);
  const body = system.bodies[next]!;
  const centre = system.frames.convertPoint([0, 0, 0], body.carriedFrame, frame);
  const p = rig.position;
  const near = Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) < 6 * body.radius;
  const nextFrame = near ? body.turningFrame : body.carriedFrame;
  if (nextFrame === frame) return;
  const heading = system.frames.convertDirection(rig.headingDir(), frame, nextFrame);
  const position = system.frames.convertPoint(p, frame, nextFrame);
  const velocity = system.frames.convertDirection(rig.velocity, frame, nextFrame);
  const pitch = rig.pitch;
  frame = nextFrame;
  attached = next;
  rig.position = position;
  rig.velocity = velocity;
  rig.lookAt([position[0] + heading[0] * 1e4, position[1] + heading[1] * 1e4, position[2] + heading[2] * 1e4]);
  rig.pitch = pitch;
}
```

Three things keep the hand-over out of the picture:

- **Up is a function of the place.** The `UpSource` of the rig blends from "away from the centre" (within 2 radii) to the axis of the body (from 5 radii) to what the parent body says (toward the border of the reach). It never asks which frame the position is in, so the horizon does not tip when the frame changes.
- **The turning is taken up before the frame.** A body turns under a camera that stands in its carried frame. Between 10 and 7 radii the example turns the camera about the axis by a growing share of the body's turn, so at 6 radii, where the turning frame takes over, the camera already turns with the body.
- **The stars are fixed to the system.** The star field of the example reads a direction in the root frame (`relativeMatrix` of the pose of the picture's frame), so it does not move when the axes of the picture change.

The render origin follows the camera on all three axes (`snapRenderOrigin(eye, 1024, 'all')`, or the streamed world's own). Every body, path and shell is placed by `relativeMatrix(frames.relativePose(itsFrame, pictureFrame), renderOrigin)`: the subtraction is done in 64 bits, the GPU gets small numbers.

## Near and far

A body is drawn in one of two ways, and both use the same generator and the same look:

- **From afar** its six coarsest cells (32 × 32 quads each) are drawn by the layer of the example, with the light of the sun from the body's own direction. This gives the right lit phase of a neighbouring body in the sky of another. A body smaller than three pixels is drawn larger, so it stays a visible dot at the view of the whole system.
- **Near** (within 6 radii) a `StreamedWorld` streams its cells. Its six coarsest cells are answered from memory, so the streamed surface starts with the very meshes the far layer draws. The far layer stops drawing the body in the frame after the streamed surface covers it without a hole; the finer levels then blend in with `morph`.

The air works the same way. The engine has one atmosphere; it belongs to the body the camera is at. From 5.7 radii down to 4.2 its share in the picture grows from none to all (`u_airNear`), and the shell of the far layer fades by the same share. Every body with air has a shell 0.3 radii thick, so the tables of the engine's atmosphere hold for all of them and only the medium's radius changes on arrival.

## The flights

`flight.ts` holds the flights as pure functions of their time and of where the bodies are. A flight is one or two legs. A leg belongs to one body and is kept in its turning frame: the low end stands over a place of the surface, the far end is a point that may move (the middle between two bodies, a point of another frame).

- The height grows as a power of the leg's time, so every doubling of the height takes about the same time, from 3 m to a hundred thousand kilometres.
- The camera stays straight above its place until nothing of the body stands in the way, then goes over to the direction of the far end.
- Two legs meet in one point and pass it at one speed (`matchedSeconds`).
- The far end is read every frame, so a leg ends exactly where it should, whatever the system did meanwhile. The flights work at any rate of the time.
- The place of a landing is chosen for the time of the arrival (`landingDirection`, `landingView`). Where the body has a neighbour worth it, the place aims at that neighbour 15° to 28° above the horizon, on the side of it that faces the sun, and the view turns to it. The sun is then above the horizon too, unless the two stand nearly opposite each other: the landing is then on the night side under a fully lit neighbour. The search for level ground (`findSite`) may move the place by some degrees, and the neighbour in the sky with it. A neighbour that stands close to the sun in the sky shows only a thin lit edge; that is its right phase. Hearth and Pale are each other's neighbour.

## The plan of a world

Hearth gets a plan of its whole surface before its finer cells need it, built with `gen-plan` from the same terrain the cells use (`plan.ts`, `plan-water.ts`). Stage 1 is the water: the heights at every node of a level-9 grid (1 572 864 nodes), the hollows filled from the sea inward (the larger ones stay as lakes), flow gathered downstream from a supply that follows the climate of the terrain, and the rivers as smooth lines whose grade never rises and ends at the level of the sea or lake they reach. An index from the cells of level 8 to the lines near them goes with it.

- The plan is a pure function of the seed of the body. It is written in its own binary format (`WHP1`, sections aligned to 8 bytes) and carries a 64-bit fingerprint of its water (`planHash`), the same in Node and in a browser.
- With workers (`inhabited.ts`) one `plan` job runs after the root cells; the page decodes its bytes, checks the fingerprint and sends them to every worker with `WorkerPool.broadcast`, so each one holds the plan. Without workers the plan is built on the main thread after one frame that shows that it is being built.
- The line at the bottom shows its time, the number of rivers and lakes and the fingerprint. `M` (or `map=1` in the hash) draws the marks: line meshes in the frame of the body, drawn after the far layer with a depth test and lifted toward the eye by a small share of their distance, so the coarse facets do not hide them.
- `world=0` in the hash builds no plan at all and the cells are today's; `world=1` lets the cells of Hearth read the water of the plan once it is there; `world=2` adds the climate and `world=3` (the default) the settlements (below).

Stage 1 reaches the cells (`plan-lines.ts`, `ground.ts`, `planned-cell.ts`). Ground and water are one pure function of the point, so cells, levels and threads agree without talking to each other:

- The river lines of the plan become strip nets (`stripNet` of `wallhammer-web/gen-core`), one per tile of level 8 with the lines that touch it and their neighbours at the nodes, cached in each thread. `stripCarve` cuts them into the ground; the wide shoulder of each profile opens the valley.
- The share of a lake at a point comes from `gridWeights` of `wallhammer-web/gen-plan` and a little noise; a shore band after the carve makes the ground exactly the level of the lake on its outline.
- A planned cell (`buildBodyCell` with hooks) draws the terrain with the plan's surface and colour, drops objects where there is water and adds one `water` mesh: `stripMesh` of a view of the net with flat sections, its vertices carrying metres to the end of the water and the class of the line. It is blended and drawn after the terrain.
- `R` flies from orbit to the spring of the longest river and down its stream to the sea (`river-flight.ts`).

A script reads the fingerprint from `window.__wh.planHash()` and the report of the build from `window.__wh.stats().plan`. The presets add five views of the plan (`world-orbit`, `world-orbit-plain`, `world-mouth-20km`, `world-pool-20km`, `world-edge-60km`), each at a time with the sun over its place.

Stage 2 is the climate (`plan-climate.ts`, `climate.ts`, `weather.ts`; `world=2` in the hash). The plan gains a moisture per node (`wet`, its own section and the part `climate` of `planHash`): wet near rivers, lakes and the sea and fading with the distance along the grid, over the moisture the terrain had. The cells read temperature from latitude, height and noise, and moisture from the plan; first-match rules give the biome, its ground colour and cover and its plants (four more shapes, `shapes.ts`); the sea and lakes freeze near the poles. The weather is a pure function of plan, place and time: the engine's cloud cover by place ([Cloud cover by place](environment.md#cloud-cover-by-place)) with a profile by latitude and patches drifting with the wind, its clouds as the [volumetric clouds](environment.md#volumetric-clouds) with a `CloudShellLayer` as their far layer and their shadows from a texture (`volume=0` in the hash keeps the cloud shell alone), and under the eye rain or snow, wet ground and fresh snow faded with height. `C` (or `clouds=0`) hides the clouds. The presets add the views `world-climate-…`: from orbit, a river through warm country, clouds from above and below, the cap, the equator, rain, snow and a border of biomes with level tints.

From stage 2, details round the camera stand on Hearth's ground (`details.ts`, `details-page.ts`; `details=0` in the hash leaves them out): tufts out to 60 m, stones and flowers out to 120 m, made per square of quadtree level 13 (about 19 m) by `nearScatter` and drawn by `NearInstanceLayer` ([Instances near the viewer](rendering.md#instances-near-the-viewer)). Their density follows the biome weights of the climate, water and slope at the vertices of the finest mesh, so a border is a gradient; each stands on the drawn triangles, none in water or on a line of the plan. A square is a `details` job on the pool (two at a time), nearest first; while squares are missing the reach shrinks toward the camera (the gain), so none appears in view. From 200 m up the reach shrinks, from 300 m nothing is made or drawn. Tufts and flowers bend in Hearth's wind. `window.__wh.stats().details` reports squares, records held, drawn and clipped, jobs, the gain of both groups and the time of the last rebuild; the presets add the views `world-detail-…`.

Stage 3 is the settlements (`plan-sites.ts`, `settlement.ts`, `settlement-layer.ts`; `world=3` in the hash). The plan picks one town and up to 127 villages with `pickSites` of `wallhammer-web/gen-plan`: a score per node from water near (`gridSteps`), a kind climate, gentle slope (`gridSlopeAt`) and moderate height, then a fit of a flat, slightly tilted pad to the terrain at each candidate (no sea, lake, river, ice, dry land or rock within it, nothing steeper than 6 %). Its sections hold the site table; the lanes and streets are lines of the kind `lane` after the rivers, with their nodes, and the part `sites` of `planHash` fingerprints both. The ground eases onto the pad over a skirt before the lines are cut (`ground.ts`); a planned cell colours yards, the village green or the town square and a patchwork of fields round each site, keeps the wild out of it, and draws its lanes as a mesh of material `way`. Lots come from `plotsAlong` along the lanes on any thread and are never stored; near the eye one block with a pitched top stands on each lot. `M` draws a cross over every site, `G` (or `site=<n>`) goes to the next site, the presets add the views `world-sites-…`, `world-town-1km`, `world-village-…` and `world-pad-edge`.

Stage 4 is the roads (`plan-routes.ts`; `world=4` in the hash). The example joins the settlements with the least-cost tools of `wallhammer-web/gen-plan`: `routeRegions` grows a region round every site, `regionLinks` gives the cheapest link between touching regions, each site keeps the link to its nearest neighbour and the cheapest links join the rest, and `routeGrid` finds each road over the grid, cheaper over steps already laid so roads share trunks. A trunk is smoothed, gets a deck where it reaches a river's water, and its heights stay under a grade limit (`limitGrade`, node heights solved over the whole graph). Roads are lines of the kind `road` cut into the ground like the lanes; decks are lines of the kind `deck`, never carved, drawn from their own net. The route table is its own sections and the part `routes` of `planHash`. `M` draws the roads, the line at the bottom counts routes, decks and sites without a road, `__wh.routes()` returns `routeStats`, and the presets add the views `world-roads-…`, `world-road-…`, `world-deck…` and `world-junction`.

Stage 5 is the shade of the mountains and the lights at night (`shade.ts`, `lights.ts`; `world=5` in the hash, now the default). Nothing new is stored in the plan: every vertex of a planned cell carries the skyline code of `horizonCodeAt` of `wallhammer-web/gen-plan` over the plan's relief (reach 20 km, 32 samples, the sea as the floor) as the extra channel of the sphere patch (`extraAt`), strips and objects carry it per vertex and per instance, and the shaders multiply the sun by `horizonLit`, so a valley stays in shade in the morning while the ridges are lit and the shade moves with the sun. The far body carries the same codes. Lights are points of a pure function of the plan: one per site from afar, one per lit structure near the eye, each on from about 6° of the sun under its horizon, staggered by a byte of its hash; one additive draw (`LightsLayer`). `J` shows the shade alone; the presets add `world-shade-…`, `world-night-…` and `world-dusk-town`.

From stage 3 figures walk round the camera on Hearth (`creatures.ts`, `life.ts`, `life-layer.ts`; `life=0` in the hash leaves them out). Four rigs of the example are drawn by one `RigLayer` ([Rigs and actors](rigs.md)): a figure on two legs in plain clothes, a thin figure of pale rods, a four-limbed pack carrier with a bending neck and tail on the free gait ([Free gait and chains](rigs.md#free-gait-and-chains)), and a small four-limbed grazer. Nothing is simulated and nothing is stored: every walker has a fixed path of plan lines that it walks there and back for ever, standing at either end (ramped speed, half a turn to the right while it stands), so its pose is a closed form of the system's time and a jump of the clock poses at once. Every settlement has `clamp(round(0.6 · lots), 8, 24)` walkers on its lanes (the town `min(140, round(0.35 · lots))`), chains of one to three lane lines from the home lot, at most 250 m, standing 20–90 s; every road `clamp(round(length / 800), 1, 12)` parties over its whole length, 60 % a pack carrier with a walker 2.2 m ahead and 40 % a lone walker with a pack, standing 120–600 s; a road of 3 km or more a troop of three rod figures 1.5 m apart on its middle third, standing 5–10 s; every village two groups of three to six grazers standing in the ring 1.05–1.35 radii from its centre. Speeds 1.15–1.45, 1.1–1.3 and 0.95–1.05 m/s. Only sites within their radius + 450 m of the eye and roads in the tiles within 450 m take part, nothing from 450 m above the ground; poses within 400 m are drawn, at most 300 (200, 24, 40 and 36 per rig). Each stands on the drawn surface of its strip (grade plus the section at its offset, a deck on the deck), up along the body's radius. `window.__wh.stats().life` reports `near`, `far`, `hidden`, `made`, `capped` and `logicMs`; the presets add `world-life-lane`, `world-life-lane-later`, `world-road`, `world-gait`, `world-troop`, `world-field`, `world-far-side` and `world-village-top`.

## The budget

The example is built for a frame under 8 ms and under 600 MB of GPU memory at 1920×1080.

- Only one body is streamed at a time, with the budget of the planet example (900 cells, a ceiling of 560 MB).
- Every other body costs six draw calls of one 32 × 32 patch each, and one sphere for its air.
- The stars are one pass over the screen; the paths are four line loops.
- The plan of Hearth is one job in a worker; its limits (5 s, 64 MB of working memory, 12 MB of bytes) and measured times are in the README of the example.

The panel shows a report of the last flight, as in the planet example. A script reads it from `window.__wh.flightReport()`, starts a flight with `window.__wh.startFlight(name)` and steps it with `window.__wh.setFlight(seconds)`.

## Checks

The golden test of the examples (`tools/golden/golden.ts`) holds two recipes of the example ([Tools](tools.md#golden-hashes)):

- "system example cells": every body has its own surface, the bytes of a cell do not depend on the order of generation and survive the cell format;
- "system example flights": the reaches of the bodies are nested or apart; a flight from the surface of Hearth to the surface of Pale and a descent from the view of the whole system to Rime, flown at 60 steps per second while the system runs, make no step longer than their share of the distance, meet at one speed and end at the planned place with the neighbour in the sky.

What these checks cannot see is the picture: the shaders, the hand-over between the far layer and the streamed surface, the look of the air and the frame time need a browser with a GPU.
