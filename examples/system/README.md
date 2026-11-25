# System example

A sun and four bodies on their paths, each with its own seed and its own look. The page starts at a view of the whole
system with the paths drawn; the time can run up to a thousand times faster; and the free camera flies from one body
to another down to a few metres above its surface, in one shot and without a loading screen. From the surface of one
body its neighbour stands in the sky, lit from where the sun is.

| Body | What |
| --- | --- |
| sun | The centre. It only shines. |
| Hearth | Radius 100 km. Sea, forests and snow under a shell of air. |
| Pale | Radius 30 km. The moon of Hearth: craters, no air, always the same side toward Hearth. |
| Ember | Radius 140 km. Sand and rock under air of its own. |
| Rime | Radius 60 km. A frozen body far out, on a tilted, stretched path. |

It imports `wallhammer-web` and, for the structures of Hearth and their damage, the content modules `gen-arch` and
`sim/destruction` (never an app; `pnpm check:layers` enforces that). The bodies, the terrain,
the materials, what is drawn from afar and the flights are the example's own files.

The engine documentation describes it in [docs/system.md](../../packages/wallhammer-web/docs/system.md).

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://127.0.0.1:5281/system/>. Another port: `EXAMPLES_PORT=5291 docker compose up -d`.

- `1` `2` `3` `4` fly to Hearth, Pale, Ember and Rime. `0` flies to the view of the whole system.
- `F` flies to the next stop of the tour, or stops the flight; `Escape` stops it too. `#fly=1` in the URL starts
  the first flight as soon as the bodies are there, `#tour=1` goes on from stop to stop.
- `W` `A` `S` `D` fly along the view, `E` and `Q` up and down, `Shift` faster, drag looks around, the wheel changes
  the speed. The speed follows the height above the nearest body.
- `,` and `.` slow the time down and speed it up (×0, ×1, ×10, ×100, ×1000). `P` pauses it.
- `O` shows and hides the paths, `N` the names. `L` tints every cell by its quadtree level. `M` shows and hides the
  marks of the plan of Hearth (its rivers by class and the edges of its lakes).
- `R` flies from 250 km above the spring of the longest river of Hearth down to it and along the river to 1 km past
  its mouth (stage 1, once the plan is there); `R` or `Escape` stops it.
- `C` shows and hides the clouds of Hearth with their shadows (stage 2).
- `G` goes to the next settlement of Hearth, 300 m above the ground south of it, looking at its middle (stage 3);
  `#site=<n>` starts there.
- `X` strikes the structure part in the middle of the view (stage 3): parts fall out, the rest stands; a reload clears it.
- `V` is the movie mode, a clean screen for filming: the panel, the bottom line, the names and the cursor are
  hidden and the tour flies on from stop to stop. `V` or `Escape` brings them back. `#movie=1` starts in it.
- `B` measures a frame of the current view with the graphics work finished. `H` hides the panel.
- `K` switches the mark mode (dev server only, not in the live demo; `N` stays the names): a click pins a note to the
  surface of the body the camera is near, kept in `internal/marks/` by the dev server's store (see
  [Marks](../../packages/wallhammer-web/docs/marks.md)). The mode opens only while a body's surface is streamed round
  the camera and no flight or movie runs. The point is picked against the height of that body's surface in its turning
  frame (`gapPick`), so a pin stays on the ground as the body turns; trees, rocks, details, structures, creatures and
  clouds are not in the pick. A mark's view is the page's hash with the exact time `t`, `rate=0`, `flow=` and the
  camera's exact state (`mkview=`): opening it shows the same view at the same moment, the time stopped. Damage done
  with `X` is not in it. `marks=1` turns the marks on in a page driven by a script, `marks=0` hides the pins.
- The line at the bottom always shows the body the camera is kept by, the height, the speed, the rate of the time,
  the patches drawn, the time of a frame and the GPU memory.

URL hash (kept up to date while flying by hand):
`#seed=725&body=Hearth&lat=..&lon=..&alt=3&yaw=..&pitch=3&t=..&rate=1`

| Key | Default | Meaning |
| --- | --- | --- |
| `seed` | 725 | Seed of the system. Every body takes its own seed from it. |
| `body` | none | Name of the body to start at. Without it the page starts at the view of the whole system. |
| `lat`, `lon`, `alt` | 0, 0, 3 | Degrees on the body (the poles are on its axis) and metres above the surface. |
| `yaw`, `pitch` | 0, 3 | Degrees; a positive pitch looks down. |
| `t` | 0 | Time of the system in seconds. |
| `rate` | 1 | How many times faster than real the time runs: 0, 1, 10, 100 or 1000. |
| `fly`, `tour` | 0 | `fly=1` starts the first flight of the tour once the bodies are there; `tour=1` flies on from stop to stop. |
| `pace` | 1 | Multiplier of the time a flight takes (0.25 to 8). |
| `orbits`, `names` | 1 | `0` hides the paths, the names. |
| `depth` | `reversed` | Or `logarithmic`. |
| `src` | `workers` | Or `main`: cells generated on the main thread within a budget per frame. |
| `px`, `cells` | 2, 900 | Tolerated error in pixels and the budget of cells. |
| `gpu` | 560 | Ceiling of GPU memory in MB; `0` for none. |
| `levels` | 0 | `1` tints the cells by level. |
| `world` | 5 | Stage of the plan of Hearth, 0 to 5. `0` builds no plan and the page is the one before the plan; `1` builds the cells of Hearth from the plan (lakes, rivers, valleys); `2` adds the climate (biomes, moisture by the water, frozen sea, cloud cover by place, rain and snow); `3` adds the settlements (one town and villages, their pads, lanes, fields and massing); `4` the roads; `5` the shade of the relief and the lights at night. Written to the hash only when given. |
| `site` | — | Stage 3: starts over settlement `n` (0 is the town), `alt` above the ground (default 300 m), as `G`. |
| `clouds` | 1 | `0` hides the clouds of Hearth and their shadows (as `C`; stage 2). |
| `volume` | 1 | `0` draws the clouds of Hearth as the flat cloud shell at every height, without the volumetric clouds (stage 2). |
| `cover` | — | `0` to `1`: one cloud cover for all of Hearth in place of the profile by latitude and its patches (stage 2), to see a weather from the ground anywhere. The clouds, their shadows and the weather under the eye follow from it: from about `0.55` the deck is closed, from `0.6` it rains or snows (snow where it is cold) and the ground gets wet. |
| `map` | 0 | `1` draws the marks of the plan (as `M`). |
| `details` | 1 | `0` leaves out the details near the camera (tufts, stones, flowers; stage 2). |
| `life` | 1 | `0` leaves out the creatures near the camera (villagers, beasts, skeletons, grazers; stage 3). |
| `flow` | 0 | Seconds of the clock of the water's flow at the start (a mark's view writes it). |
| `marks` | 1 | Dev server only. `0` hides the marks' pins; `1` turns the marks on in a page driven by a script, which has none otherwise. `mkview=` in a mark's hash is the camera's exact state. |

## Files

| File | What |
| --- | --- |
| `src/bodies.ts` | The system as data: radii, air, paths, turning, reaches. |
| `src/world.ts` | One generator for every body: four terrains, the cover, the rules of the objects, `generateBodyCell`, `findSite`. Pure, runs in Node and in a worker. |
| `src/flight.ts` | The flights: legs along a body, where the camera is on them, the place and the view of a landing. Pure. |
| `src/vec.ts` | Small vector helpers. |
| `src/shapes.ts` | Unit meshes of the tree and the rock; from stage 2 also a broadleaf tree, a shrub, a tree with a flat crown and a shard of ice. |
| `src/shaders.ts` | The two materials of the streamed surface, the planned terrain and the water of Hearth at stage 1, and the shaders of what is drawn from afar: a body, its air as a shell, the sun, the paths, the stars. |
| `src/far.ts` | The two layers that draw everything but the streamed surface. |
| `src/main.ts` | The page: the system and its clock, the frame of the camera, streaming, flights, names, line and panel, script interface `window.__wh`. |
| `src/cell-worker.ts` | The worker that runs the generator, builds the plan (`plan`), takes the plan from the page (`have-plan`), keeps it and makes the planned cells (`cell`), the details of a square (`details`) and the massing or full structures of a cluster (`site`). |
| `src/plan.ts` | The plan of the world: `worldPlan`, its binary format (`encodePlan`, `decodePlan`) and its fingerprint (`planHash`). Pure. |
| `src/plan-water.ts` | Stage 1 of the plan: heights, drainage, lakes, rivers as lines with a falling grade, the index from tiles to lines. Pure. |
| `src/inhabited.ts` | The plan on the page: one job in a worker (or the main thread), the broadcast to every worker, the status line, the marks and the views of the plan; from stage 1 the planned body (`plannedBody`: its provider, roots, surface and main stem) and the views of the water. |
| `src/plan-lines.ts` | The lines of the plan as strip nets: profiles, a net per tile of level 8 (cached), the view the water mesh is made from, the run of every river to the end of its water. Pure. |
| `src/ground.ts` | The ground with the plan as one function of the point: `planScope`, `planGround`, `planSurface`, `planWater`, `planClear`. Pure. |
| `src/planned-cell.ts` | `generateWorldCell`: a cell of Hearth with its plan (lakes, rivers cut in, valley colours, no objects in water, one `water` mesh). Pure. |
| `src/river-flight.ts` | The flight along the main river: `mainStem`, `riverFlightPose`. Pure. |
| `src/plan-climate.ts` | Stage 2 of the plan: the moisture per node (`planMoisture`), wet by rivers, lakes and the sea, spread along the grid. Pure. |
| `src/climate.ts` | The climate of a point (`climateAt`, `biomeAt`), the colours and cover of the biomes, frozen water, and the rules of the plants and rocks (`climateRules`). Pure. |
| `src/weather.ts` | Hearth's cloud cover by place (`hearthCloudField`), the weather at a place and time (`weatherAt`), and the views `world-climate-…`. Pure. |
| `src/details.ts` | Details near the camera: the kinds, the rules by biome, the unit shapes, the squares round a point (`DETAIL_GRID`, the engine's `NearSquareGrid`) and the records of one square (`generateDetails`). Pure. |
| `src/details-page.ts` | The details on the page through the engine's `NearDetailStream` (the wanted squares, their jobs, the gain and the `NearInstanceLayer`), the wind; the views `world-detail-…`. |
| `src/plan-sites.ts` | Stage 3 of the plan: the score per node, the fit of a pad, the pick of the town and the villages (`pickSites`), their lanes as lines of the plan (`planSites`). Pure. |
| `src/settlement.ts` | A settlement from the plan's bytes on any thread: its frame and pad (`siteFrame`, `sitePoint`, `siteLocal`), its lots along the lanes (`plotsAlong`) and what stands on each (`settlementOf`). Pure. |
| `src/plan-routes.ts` | Stage 4 of the plan: least-cost roads between the settlements over the grid, smoothed, decks over rivers, heights under the grade limit (`planRoutes`, `ROAD`); points along a route or line (`routePoint`, `lanePoint`) and `routeStats`. Pure. |
| `src/settlement-layer.ts` | The massing near the eye: the generator's massing of every structure, one mesh per cluster (site or span) within 8 km; nearer than 250 m the full structures in their own frames, built in a worker or on the page, the damage, the falling parts, the rubble and the pick (`SettlementLayer`). |
| `src/structures.ts` | The structures of the settlements: kind per lot (at least five kinds per site where the lots allow), their parts for the structure generator in a frame of their own, the ring of line walls and towers round the town, the abutments, piers and parapets of every span (`clusterRecipes`, `clusterMassing`, `clusterFull`, `buildStructure`, `structureLights`). Pure. |
| `src/damage.ts` | The damage of the structures in the page's memory: strikes, state per structure key, its hash and text (`createDamage`). |
| `src/shade.ts` | Stage 5: the skyline codes of a point over the plan's relief (`shadeField`, `shadeCodeAt`, `SHADE`). Pure. |
| `src/lights.ts` | Stage 5: the light points of the settlements (`farLights`, `nearLights`, `lightGain`), their layer (`LightsLayer`) and the views of the shade and the night (`shadeViews`). |
| `src/creatures.ts` | The four kinds of creatures as rig descriptions (`creatureRigs`), their ceilings (`CREATURE_CAP`) and the look of one from its seed (`creatureLook`). Pure. |
| `src/life.ts` | Who walks where: the walks of the lanes and roads and the grazers that stand (`siteWalks`, `routeWalks`, `siteStands`), the pose at a time as a closed form (`walkPose`), the near set and the poses round the eye (`lifeSet`, `lifeNear`). Pure. |
| `src/life-layer.ts` | The creatures on the page: the `RigLayer` of the four kinds, the records per frame in render space, the panel line and the views (`createLife`, `lifeLine`, `lifeViews`). |
| `src/marks.ts` | The marks' host (dev server only): the engine's host for a `FreeRig` (`engineMarkHost`) with the pick against the surface of the body near in its turning frame, the page's exact hash and time, the pins of that body alone; installs `installMarking` behind key `K` as `__wh.marks`. The store is `marksStore` of `wallhammer-web/marks-store` in `vite.config.ts`, with the folder `internal/marks/`. |

## Stage 1: water in the cells

With `world=1` the cells of Hearth come from `generateWorldCell` once the plan is there; until then
its streaming waits, and from afar its six coarsest planned cells replace the plain ones (the river strips are not
drawn from afar). `world=0` is the page as before the plan.

- **The cut.** The river lines of the plan are strip nets (`stripNet`), one per tile of level 8: the lines the plan's
  index lists for the tile plus every line that shares a node with one of them, whole and ascending. `stripCarve` cuts
  them into the ground. Carve profiles, zero being the water level (`bedM` 0): brook `[-1,0, -0.55,-0.5, 0.55,-0.5,
  1,0]` with a shoulder of 30 m, stream `[-1,0, -0.6,-1.1, 0.6,-1.1, 1,0]` 90 m, river `[-1,0, -0.7,-2.4, 0.7,-2.4,
  1,0]` 220 m. The wide shoulder is the valley: flat at the bank, the full relief at its rim.
- **Lakes** (`src/plan-lakes.ts`). A lake is a filled hollow whose shore is the contour of the real ground at its
  level. Per point, of the nodes `gridWeights` blends: `q` the summed weight of the lake with the largest sum, bent by
  noise that is zero at 0 and 1; `c` the blend of `relief / 2`; `L` the level. Sediment eases the own ground toward
  `c` by `0.75 · smooth(0.5, 3.5, L − c)`; a dam rises toward `L + 0.8` m only where the real ground would let the lake
  leak (`Q0 = 0.2`, `Q1 = 0.7`), never lowering the ground. The domain of a lake is `q > Q0`; its signed depth is
  `min(L − g, 300 · (q − Q0))`, the sea's `−g`, the larger counts; water stands where it is above zero. The premise
  (no blended cell holds two lakes, every node next to a lake lies at least `L − 0.26` high) is asserted by the plan.
  Order of the ground: own terrain, the lake rule, the pad of a site, `stripCarve`; under standing water a strip only
  cuts (its fill fades out 0.2 to 1.2 m under the level), so a river through a lake raises no bank across it.
- **Rivers run through their lakes.** Channels are traced with the pools hidden, so every chain runs from its spring
  to the sea; past its last node it runs on (steepest descent, at most 4 nodes) until the ground has been 1.5 m plus
  the channel's depth under the sea for 60 m, its half-width growing to twice over that run-out. The grade never
  rises, equals `L` wherever a lake's domain holds a point and never lies under a lake further down. Lines are cut
  to equal lengths of at most 1100 m plus one spacing, points at most 150 m apart.
- **The water mesh.** One mesh of material `water` per cell: `stripMesh` of a view of the net with flat sections
  `[-1.15,-0.6, -1,0, 1,0, 1.15,-0.6]`, on the ground; a class `c` is meshed from level `[0, 4, 7, 9][c]`. Its
  vertices carry the metres to the end of the water (the flow pattern runs on over line ends and confluences) and the
  class, plus 4 on the coarsest level that meshes the line (it fades out as the cell blends into its parent), plus
  0.9 × the fade into standing water at the centre (`smooth(0.2, 1.2, level − ground before the carve)`, 1 at the
  last 60 m of a chain): a strip dissolves into a lake or the sea, it never ends with a cut.
- **Colour and the shore per pixel.** A terrain vertex carries the colour of the bed, also under water (sand and
  silt with depth), and in its alpha the depth code `clamp(round(32 + 8 · depth), 0, 255)`. The fragment shader puts
  the waterline on the zero line of the interpolated depth, antialiased, and darkens land up to 0.25 m above the
  level. One GLSL block `WATER_LOOK` (shaders.ts) draws sea, lakes and rivers: the bed through the shallows
  (`1 − exp(−d / 2.2)` toward one deep colour), ripples whose octaves fade under two pixels, the sky by Fresnel and
  the sun's glint. Bare scree on the walls by the depth of the cut (6 to 40 m); the tree cover thins on the walls; no
  object and no cover where there is water or within 2 m of a strip.
- **Conditioning rule** (the only one): inner points of a line nearer to an end at a node than 3.2 × the widest
  half-width at that node are dropped, because the corners of a node reach up to 3 × that width and `stripNet`
  refuses a shorter segment. The rule reads only the line and the lines at its two nodes. The index of tiles lets a
  line reach `3 × widest + 261` m (`tileReachM` of plan.ts), at least the reach of its strip in the cells.
- **Nets are proven for seed 725 only.** Proving every seed would need a repair rule inside the plan, which would
  change its fingerprint. The proof itself (every tile net of seed 725 builds; the same carve from any net that holds
  the lines) belongs to the golden recipe "world cells: water", which is not written yet.
- **The flow clock** is the seconds the page has run, at most real time, stopped by `P`, and 0 while a script drives
  the page, so pictures repeat.

Views of stage 1 in `__wh.presets()` (computed from the plan): `world-river-20km`, `world-spring`,
`world-river-low`, `world-confluence`, `world-lake`, `world-outlet`, `world-mouth`, `world-lake-top`,
`world-shore-low`, `world-inlet`, `world-coast-low`, `world-leak` (the highest dam of the lake rule), `world-edge-levels` and
`world-flight-0` … `world-flight-7` (eight poses of the flight). `world-orbit` is the view of the plan from orbit
that was already there. A script starts the flight with `__wh.startRiverFlight()` and holds it at a share with
`__wh.setRiverFlight(t01)`; a view can look at a point (`toward`, metres in the body's frame).

Numbers (not measured yet): the time of a planned leaf without lines and with a river against a plain leaf, a root
cell, the bytes against stage 0, the counts of `world-river-low` against `world=0`. A frame time measured in Docker is
a software renderer's.

## Stage 2: climate, biomes and weather

From `world=2` the plan holds a moisture per node (section 20, part `climate` of `planHash`) and the
cells of Hearth take their colour, cover and objects from the climate; `world=1` and `world=0` stay as they were.

- **Moisture.** Every lake, the sea and the great rivers are sources; the wet spreads along the grid (hops of one node)
  and fades from 12 to 45 km, over the dry floor the terrain had. Each node keeps one source (the strongest, then the
  one that reaches farthest), so the spread is an approximation. Water nodes are at least 200 of 255.
- **Climate and biomes.** Temperature from latitude, height and noise, moisture from the plan; first-match rules give
  sea, ice, tundra, taiga, forest, meadow, dry land or rock; colours and cover blend near the borders.
- **Objects.** The plants share one draw per anchor: conifers (a dark variant in the cold), broadleaf trees, shrubs,
  trees with a flat crown, rocks, and shards on frozen water. They ask `planClear` themselves.
- **Frozen water.** The sea and the lakes freeze toward the poles with a ragged edge; the rivers do not.
- **Weather.** A cloud cover by place (the engine's `cloudFieldSlot`): a profile by latitude (wet tropics, dry belts,
  wet middle latitudes, clearer poles) that stays under the cover at which a deck closes, plus weather systems of about
  55 km and 24 km, bent and drifting with the wind, that carry it from clear country up to overcast and rain. About a
  quarter of Hearth is clear, half broken to mostly cloudy, an eighth overcast and a twenty-fifth under rain or snow;
  from orbit the cloud hides about two fifths of the ground. Below 15 km the clouds are the engine's volumetric
  clouds (`cloudVolume`): heaped clouds from 1.5 to 4 km with light through them, read from the same cover by place.
  Between 15 and 30 km they fade into a `CloudShellLayer` 3 km up over their shadows; seen from above, a deck stands
  in the sun over its own place (the engine's `atmosphereSun`). The shadows come from a texture (`cloudShadows`).
  `volume=0` keeps the shell at every height. Under the eye `weatherAt` gives rain or
  snow, wet ground, fresh snow and fog, faded with the height. All pure functions of plan, place and time. The fog
  reaches `env.weather` but nothing draws it: the page's materials take the air of the atmosphere
  (`atmosphereApply`), and the engine's fog (`applyFog`) is the one of a scene without it. `cover=` sets one cover
  for the whole body, to see a given weather from the ground.

Views of stage 2 in `__wh.presets()`: `world-climate-orbit`, `world-climate-river-25km`, `world-climate-clouds-8km`,
`world-climate-clouds-below`, `world-climate-pole-30km`, `world-climate-pole-close`, `world-climate-equator-close`,
`world-climate-rain`, `world-climate-snow` and `world-climate-level-border` (each only where the search finds a
place). Orbit without clouds and before the climate: the same view with `clouds=0` or `world=1`.

## Forests from afar

Trees are objects in the cells of level 10 (edge about 150 m) and finer; on Hearth from stage 2 the tallest of them
also stand in the cells of levels 9 to 7 (thinned trees, below). Farther out the ground draws them as its cover (the
alpha of the cover), and in the band where a cell blends into its parent the objects shrink away one by one while the
cover takes over (`coverFade`, `coverKeep`). The canopy makes that cover look like the trees it stands for.

- **Relief.** Where the cover is a wood (its alpha from 0.04, a meadow, to 0.26 and more), the vertices of the ground
  rise by up to 13 m times the share of the far look, in the colour pass and in the shadow pass alike: a wood stands
  above a meadow on a skyline and casts its shadow. Water, roads, sites and fields have no cover and stay flat. The
  normal bends with the lifted edge (a surface gradient from screen derivatives) and with a fine noise of the crowns.
- **Seen from the side.** The share of the canopy grows as the view grazes the ground (`canopyShare`:
  1 − (1 − a)^k, k from 1 at 45 degrees and steeper up to 10 at the horizon), and the canopy darkens as the view
  grazes it (the shaded sides of the crowns). From 45 degrees and steeper the look is the cover as baked. Where the objects hand over to the cover
  the tone does not jump: the brightness of cover against trees was 0.98 to 1.07 in four views.
- **Edges.** The cover is known per vertex, so its edge would follow the triangles. The edge of a wood is drawn per
  pixel with value noise (24, 80 and 320 m), and the tree line follows the height of the ground up to `PLANT_TOP_M`
  (1700 m), ragged by about 30 m; the lift fades out over the last 150 m below it.
- **Look ahead.** Besides the camera's ticket and its prediction, a preload ticket at full detail stands at the landing
  site of a planned flight: its cells are fetched but change nothing that is drawn. A preload ticket 1.5 s ahead of
  the camera was tried and left out (see the measures below).
- **Workers.** One pool of four workers serves the cells, the details and the settlements in the order the jobs came.
  A detail or settlement job starts only when no job waits and a worker is idle, so the cells of the surface go
  first. At most 12 cell jobs are in flight.
- **Fine trees.** Conifers, broadleaf trees and trees with a flat crown keep their fine shape to 700 m (`TREE_FINE_M`),
  where a crown is 10 to 15 pixels wide on a screen 900 pixels high.

Nothing of this is in the cells' bytes. Measured on an Apple M4 Pro, 1600 × 900 at a pixel ratio of 2 (frame cost:
the least of five runs of 20 frames, views `d300`, `r-60` and `side` from 300, 60 and 150 m). A frame is bare when a
cell coarser than level 10 is drawn nearer than where level 10 starts to blend (`__wh.stats().bareCells` above 0).

| Measure | Result |
| --- | --- |
| frame, canopy against the plain cover | +0.04 to +0.42 ms (most on the grazing ridge `r-60`) |
| frame, fine trees to 700 m against 260 m | +0.07 to +0.18 ms; triangles +35 000 to +43 000 (7 to 8 %) |
| low flight at 150 m, normal speed and fast, real CPU | no bare frame |
| fast low flight at 150 m, CPU slowed 4 times | 9 to 13 % bare frames, as before the change |
| the same with a preload 1.5 s ahead (left out) | 20 to 25 % |
| the same with 16 jobs in flight (left out) | 52 to 70 % |
| planned flight to Hearth, CPU slowed 4 times | no bare frame in the descent or after the landing |
| peak memory in those flights | streamed cells 116 to 230 MB, GPU 227 to 241 MB, as before |

### Thinned trees

On Hearth from stage 2 the trees do not end where level 10 ends: the tallest of them also stand in the cells of
levels 9, 8 and 7 and thin out toward the horizon, so there is no edge where the trees stop and the canopy begins.

- **Subsets per level.** Every anchor of the plants' grid has a rank (`plantRank` in climate.ts: 1024 steps from a
  hash of its place, a stream of its own). The turn of a conifer, a broadleaf tree or a tree with a flat crown is that
  rank, and its height grows with it (9–22, 10–20 and 6–12 m). A cell one, two and three levels above level 10 holds
  the trees ranked from 0.75, 0.9375 and 0.984375 up (`THIN_RANK`: the tallest quarter, sixteenth and 64th), so the
  trees of a coarse cell are some of its children's, at the same place with the same size, turn and kind. Shrubs,
  stones and shards stay at level 10. The planned cells build them through the `thin` hook of `buildBodyCell`
  (world.ts); their domain version grows by 10 with it. Other bodies and stages 0 and 1 do not change.
- **Hand-over.** Over the far part of each level's band, from 75, 60, 55 and 50 % of the distance where the cells of
  levels 10, 9, 8 and 7 blend into their parent (about 440–580 m, 700–1170 m, 1.3–2.3 km and 2.3–4.7 km, the height
  counted), the trees ranked under the next threshold shrink away in the order of their rank (`thinKeep` in
  shaders.ts), and the canopy takes over exactly the share of the trees that have left (`coverShareAt`): a layer of
  crowns of that share (the gap fraction to the power of the share) over the forest floor, lifted by the same share.
  A level hands its parent the trees and the canopy the parent starts with, so nothing changes where the cells switch.
  From a low view: every tree and no lift to about 440 m, then the tallest trees out of a canopy that thickens, from
  4.7 km the canopy alone. On a descent the trees come out of the canopy as dots from about 1.2 km and fill in by 350 m.
- **Forest floor.** Under a wood (the extent of the canopy, `canopyAt`) the ground turns toward litter and moss in
  patches and lies in the shade of the crowns (`forestFloor`: 45 % litter and moss, 0.8 of the light); along the
  wood's ragged edge it blends back into the open ground. The far body does the same with the mean of the patches.
- **Tone.** The canopy of the thinned trees is 0.57 of the cover's colour seen from the side and 0.85 from above
  (`THIN_SHADE`; elsewhere 0.58 and 0.95), so it matches the trees over the darker floor: the brightness of the canopy
  against the trees (five views, bands from 80 m to 4.8 km) is 0.98 to 1.06 from 450 m out, where the canopy is drawn,
  and 1.10 at 200–450 m, where every tree stands and none is drawn. Woods read about 5 to 10 % darker than before
  from 2 to 20 km up and about 20 % darker from under 1 km.

Measured as above (frame cost: interleaved runs against the code before; cells: 24 per level of stage 5, in Node;
flights: one run each against the code before, the CPU slowed in the browser for the last column).

| Measure | Result |
| --- | --- |
| frame, views `d300`, `r-60`, `side` | +0.23 to +0.27 ms (6.9 to 7.7 ms); triangles +15 600 to +24 300 (2 to 4 %); draws +86 to +108 |
| instances drawn | 3600 to 4300 against 1400 to 2200 |
| cell bytes, levels 9, 8, 7 | +1.6 KB (89 to 94 KB): 23 trees a cell on the mean, at most 69; levels 10 and finer and 6 and coarser unchanged |
| cell job, levels 9, 8, 7 (median) | +0.9 to +1.8 ms (6.9 to 7.9 ms) |
| GPU memory in the three views | +2 MB |
| low flight at normal speed, boost, CPU 4× slower: frames without ground | 0, 0, 31 of 415 (before 0, 0, 55 of 417) |
| low flight: peak streamed memory | CPU 142, 226, 227 MB, GPU 254 MB (before 141, 226, 226 MB and 252 to 253 MB) |
| landing from 20 km, normal and CPU 4× slower | no frame without ground; CPU 117 MB, GPU 243 MB at the peak (before 116 and 240 MB) |
| a slow walk over the switch of levels 9 and 10, 40 frames 1.5 m apart | 8 single pixels change shape between frames (before 947) |

## Details near the camera

From stage 2 (`details=1`, the default) tufts, stones and flowers stand round the camera on Hearth. `details.ts` makes
them per square of quadtree level 13 (8 × 8 quads of the finest mesh, about 19 m) with the engine's `nearScatter`;
`details-page.ts` asks for the squares round the eye (a `details` job on the pool, two at a time, nearest first, each
only when no cell job waits for a worker) and
draws them with the engine's `NearInstanceLayer`.

- **Seed.** `hashInts(packed, 0x717)`, key `[face, i, j]`: a square gives the same bytes in Node, a worker and the
  page, whatever the eye, the order of the jobs or the cells loaded.
- **Density.** Each kind's share is a continuous function of the biome weights of the climate (`landWeights`), water
  and slope at the 9 × 9 vertices of the finest mesh in the square, interpolated per candidate: a border between
  biomes is a gradient of a few metres. No tuft or flower within 3 m above the sea; steep ground loses plants and
  gains stones. Flowers grow in patches (value noise with 7 m cells).
- **Where.** Each stands on the drawn triangles of the finest level (the split of `spherePatchRadius`), sunk by a tenth
  of its height. None in water or within 0.3 m of it, none within half the width + 0.3 m of a line of the plan; this
  is tested per candidate only in squares where water or a line touches the lattice.
- **Colour.** A tuft takes the ground colour of the climate there (`landColor`), the material lightens its tips; stones
  and flower heads from the table below. The variant carries the kind in its integer part.
- **Fade.** Each kind fades by distance one record after another (`band` 0.6, `softM` 0.15 · reach). The gain of a
  group shrinks the reach toward the camera while squares are missing (no square appears in view), and falls from
  200 m up to 0 at 300 m; above 300 m nothing is made or held. It falls at once and rises by at most 0.04 per frame.
- **Wind.** `HEARTH_WIND` along the ground at the eye, strength min(1, 6 / 12) = 0.5; two waves fixed to the ground
  (9 m and 3.5 m) travel along it. When the time jumps by more than 1 s, the waves are off for that frame.

| Kind | Per m² | Reach | Ceiling | Bend | Shape |
| --- | --- | --- | --- | --- | --- |
| tuft | 3 | 60 m | 44 000 | 0.4 m per m at full wind | 4 blades, 12 triangles, both faces |
| stone | 0.2 | 120 m | 8 000 | none | 12 triangles |
| flower | 0.2 | 120 m | 8 000 | 0.4 m per m (× 0.7) | stem and head, 10 triangles |

Shares of `perM2` by biome (tuft, stone, flower): sea 0, 0, 0; ice 0, 0.1, 0; tundra 0.35, 0.5, 0.05; taiga 0.4, 0.3,
0.05; forest 0.6, 0.2, 0.25; meadow 1, 0.1, 1; dry 0.15, 0.8, 0; rock 0.05, 1, 0. Tuft height by biome 0.14–0.34 m.

`window.__wh.stats().details`: `squares`, `held`, `drawn`, `clipped`, `jobs`, `gain` (tufts, stones with flowers),
`rebuildMs`, `failed`. Views in `__wh.presets()`: `world-detail-meadow`, `world-detail-meadow-30m`,
`world-detail-walk-a`, `-b`, `-c` (3 m apart along the heading), `world-detail-lane` and `world-detail-lane-again`
(until the lanes of the town are built: the bank of a river, 6 m from its edge), `world-detail-dry`,
`world-detail-tundra` (or `-forest`) and `world-detail-300m`; each only where the search finds a place.

### Details budget

For the view `world-detail-meadow`. Not measured yet; Docker draws with a software renderer, so its times would say
nothing of a graphics card, and the allowance of 1.0 ms on a real card has not been checked.

| Measure | Limit | Measured |
| --- | --- | --- |
| instances sent | at most 60 000 | not measured |
| triangles | at most 750 000 | not measured |
| draws | at most 3 | not measured (one per kind with records, by construction) |
| GPU bytes of the layer | at most 4 MB | not measured (buffers: 60 000 × 48 B = 2.9 MB plus the three shapes) |
| one rebuild | — | not measured |
| rebuilds at walking speed | — | not measured (one per 2 m of the eye) |
| `clipped` | 0 | not measured |
| frame, `details=1` / `details=0` | — | not measured |
| worker time per square (Node, median of 20) | tufts 3 ms, others 1.5 ms | not measured |

## Stage 3: settlements

From `world=3` the plan holds the settlements of Hearth: one town and up to 127 villages (sections
21–29, part `sites` of `planHash`; their lanes are lines of the kind `lane` after the rivers, their nodes after the
rivers' nodes, so the part `water` does not change).

- **Score.** Per node of the grid: none on the sea, in a lake, under 4 m, near a pole (`|y| > 0.9`); else the product
  of water near (steps over the grid to the sea, a lake or a river of half-width ≥ 3 m: 0.5 on it, 1 at 1–2 steps,
  down to 0.15 at 8), the biome (meadow 1, forest 0.85, taiga 0.55, tundra 0.25, the rest 0), the slope (full below
  3 %, none above 12 %), the height (full below 600 m, none above 1400 m) and 0.9–1.1 of noise. The town scores 1.3 ×
  within 3 steps of the sea or of a river of half-width ≥ 12 m.
- **Fit.** A candidate gets a flat pad of radius `r` (village 90–220 m, town 600–800 m) and a skirt (40 m, 120 m):
  a least-squares plane through samples on rings, tilt at most 6 %, the terrain within `r` at most 12 m (town 30 m,
  relaxed twice by 1.5) off it, every sample and the plane at least 3 m above the sea, no lake node, the ground of
  stage 2 equal to the own ground (no river cuts there), no river line nearer than the skirt + 30 m + its half-width
  and shoulder, and no sea, ice, dry land or rock at the centre or at eight points of the rim.
- **Pick.** `pickSites`: the town first (score ≥ 0.35), then villages at least 9 km apart; at most 600 fits are tried
  per relaxation of the town and 6000 for all villages (a cap on the time; a candidate past the cap is skipped).
- **Lanes.** A village has 2–4 lanes from the rim of its green (14–26 m) to its radius, the first toward the nearest
  site, the second toward the next one when 60° away, the others 70° apart, gently bent; a village over 150 m one
  dead-end side lane. The town has five streets from its square (40 m) to its radius and two rings of cross streets
  at 0.38 and 0.72 of it. The outer ends are the gates (routes of stage 4 will start there).
- **Ground and colour.** The pad comes before the lines are cut, eased over the skirt; the lanes are cut a hand's
  breadth into it. Inside the radius the ground is a trodden yard, the green of a village grass, the square of the
  town paving; round it fields in strips of 60 × 180 m in three tones out to the field radius (village
  600 m + 2.5 r, town 3.2 r), fading off where the terrain lies far off the pad. No tree, shrub or rock stands within
  `r` + 10 m, on a lane or in a strong field.
- **Lots and massing.** `settlementOf` lays lots along both sides of the lanes (`plotsAlong`) on any thread: the
  lot nearest the middle is the hall, in the town a tower stands by each gate, in a village the farthest lot is the
  mill and the deepest third are farms, a few are workshops, the rest homes. Within 8 km of the eye one block with a
  pitched top stands on each lot (`SettlementLayer`, one mesh and one draw per site, at most 12 sites).
- `M` draws an orange cross over every site (2 km a village, 5 km the town). The line at the bottom says how many
  settlements there are; `G` goes to the next one.

Views of stage 3 in `__wh.presets()`: `world-sites-orbit`, `world-sites-map`, `world-sites-20km`, `world-town-1km`,
`world-village-1km`, `world-village-lane`, `world-pad-edge` and `world-village-levels`.

Not checked yet: the time of the stage in the worker, the number of sites the caps let through for seed 725, how
the four-line nodes of the town's streets mesh, and the pictures of the views above.

## Stage 4: roads

With `world=4` the plan joins the settlements by roads (sections 30–39, part `routes` of `planHash`;
the road and deck lines follow the lanes, their nodes follow those of stage 3, so the parts `water` and `sites` do not
change). Everything is a pure function of the stage-3 plan; the numbers are `ROAD` in `plan-routes.ts`.

| Number | Value | What |
| --- | --- | --- |
| `gradeMax` | 0.12 | No road or deck is steeper (the limit a test is to assert). |
| `gradeDesign` | 0.118 | The grade the heights are solved to, a margin under the limit for the float32 bytes. |
| `gridGradeMax` | 0.09 | A grid step steeper than this is closed to the search. |
| `halfM` | 3 | Half-width of a road and a deck. |
| `pointM` | 50 | Metres between the points of a road (doubled while all roads hold over `pointCap` points). |
| `lineMaxM` | 1200 | A road line is cut at a plain node when longer. |
| `deckClearM` | 1.0 + 0.05 × width, at most 4.0 | Height of a deck's ends over the highest water under it. |

- **Cost.** A step of the grid costs its metres × (1 + (slope / 0.04)²), × 1.5 next to the shore, + 300 m + 20 × the
  half-width of a river it steps onto; the sea, the lakes, steps from river to river and steps over `gridGradeMax`
  are closed. A step already laid costs 0.35 of its metres, so later roads share it.
- **Which sites.** `routeRegions` grows a region round every site at once; `regionLinks` gives the cheapest link
  between two touching regions. Every site keeps the link to its nearest neighbour, then the cheapest links join what
  is still apart (one tree per landmass). Where the closed steep steps wall sites off from the rest of their landmass,
  the tree goes on over the links of a second set of regions in which those steps are open at 8 × their cost (cheapest
  first, only what is still apart). A site with no link (alone on its landmass) is counted as without a road, never
  hidden; seed 725 has 7, each alone on its own island.
- **Paths and trunks.** Each kept link is searched inside its two regions over what is already laid, and only the
  part between the built-up rings (1.3 r) is kept. Shared steps make trunks between sites and junctions; a trunk ends
  at the gate nearest to where it leaves the ring, with points on the ring when the straight way would cross the
  settlement; a site without a gate gets a node on its radius.
- **Lines.** A trunk is smoothed (3 rounds, fewer while a point would lie in a lake or the sea or the line gets
  shorter than 0.8 of its control line). Where it comes within the bank of a river (shoulder of the river + 5 m + 1 m)
  and reaches its water, the trunk gets a deck between two new nodes; elsewhere it is a road.
- **Heights.** The nodes get the middle of the two cones the grade allows over the whole graph from the ground (a
  deck's ends at least `deckClearM` over the water), held within the cones of the gates; a road follows the ground
  between its node heights under the grade (`limitGrade`), a deck is straight. At a turn by θ a segment may climb only
  `gradeDesign` × cos(θ/2) (the sharper turn at its two ends, at a node the sharpest pass through it), so the grade holds
  measured straight between two points of a route with at most one turn between them, not only along it. Roads are cut into the ground like the
  lanes (profile 4, a low crown on a 0.15 m bed, a 5 m shoulder); decks are never carved, only drawn (profile 5, a
  skirt under each edge), and nothing of the wild stands within a metre of one.
- **Look** (`planned-cell.ts` packs it per vertex, the way shader of `shaders.ts` draws it; the plan is not touched).
  A road is a *main road* where it carries traffic: a route with at least `MAIN_ROAD_SITES` (8) sites on each side of
  it in the tree of routes, or a line two routes share (`mainRoadLines`, about 44 % of the road length). A main road is
  gravel: loose stones heaped between two pressed wheel bands per direction, damp stains. Any other road is a track:
  packed earth with two wandering ruts, grass on the hump between them and in patches toward the edges. Both end in a
  soft ragged verge inside the half-width, where the ground shows through. Setts (in rows across, running bond, dirt in
  the joints, kerbs along a wide paved edge) where the paving passes one half: the town's streets, a road from 40 m
  inside the town's radius to about 100 m outside it, a village's lanes and the road through it. A deck is planks
  across with gaps, two runners under the wheels, timber kerbs and the skirt. The ground of the shoulder turns to bare
  earth where the road cuts or fills more than 0.5 m (a bank, darker in a cut). The relief bends the normal; each
  detail fades to its mean once a pixel covers half of it, so nothing shimmers and from the air a road is a line.
  Rain darkens it, makes it glossy and fills the ruts and potholes with water that mirrors the sky; snow covers it,
  thinner and greyer in the wheel tracks.
- `M` draws the roads in pale yellow; the line at the bottom says how many routes and decks there are and how many
  sites have no road; `__wh.routes()` returns `routeStats` (counts, length, steepest grade, least deck clearance,
  longest deck, deepest cut).

Views of stage 4 in `__wh.presets()`: `world-roads-20km`, `world-roads-levels`, `world-road-gate`, `world-road-slope`,
`world-deck`, `world-deck-small`, `world-junction` and `world-roads-map`.

Not checked yet: anything of stage 4 run (the plan, the cells, the views), its time and memory, the golden recipes
of the routes, and whether every piece of road is long enough for the strip tool at its nodes.

## Stage 5: shade and lights

With `world=5` (the default) the relief casts its shade and the settlements light up at night. Nothing new is stored
in the plan and `planHash` does not change; a stage-5 cell is the stage-4 cell plus four bytes per vertex and per
instance (domain version 6).

- **Shade.** `shadeCodeAt` gives every point the skyline code of `horizonCodeAt` (`wallhammer-web/gen-plan`) over the
  plan's relief: four bytes, the height of the skyline toward four fixed directions, computed at the nodes of the
  level-9 grid and blended, so cells, levels and threads agree. The terrain carries it as the sphere patch's extra
  channel (`extraAt`), the strips per vertex, the objects per instance; the shaders multiply the sun by `horizonLit`.
  The far body carries the same codes (its shade is coarse: one code per vertex of a 32 × 32 patch).
- **Lights.** One point per site from afar (20 m over the pad, as large as the built-up radius), one per lit structure
  of `structureLights` for the sites within 10 km of the eye (at most 2000 points, nearest first). A light is on from
  a sun's sine of 0.02 − 0.12 · phase / 255 down (about 6° under its horizon fully on), the phase a byte of its hash,
  so the lights come on one by one. Points never light anything. One buffer, one additive draw (`LightsLayer`).
- `J` shows the shade alone in grey (with `L` the levels over it).

| Number | Value | What |
| --- | --- | --- |
| `SHADE.reachM` | 20 000 | How far the skyline is looked for. |
| `SHADE.steps` | 32 | Samples along each of the four directions. |
| `SHADE.floorM` | 0 | Heights under the sea count as the sea. |
| `SHADE.soft` | 0.02 | Half-width of the edge of the shade, in units of the sun's sine. |

Views of stage 5 in `__wh.presets()`: `world-shade-morning`, `world-shade-forenoon`, `world-shade-noon`,
`world-shade-view`, `world-shade-pole`, `world-shade-orbit`, `world-night-orbit`, `world-night-town`,
`world-night-lane` and `world-dusk-town`; at `world=4` the view `world-shade-4` (the morning view without the shade).
The morning views search the first 32 sites for a floor in shade with a ridge within 2.4 km lit.

| Time | Target | Measured |
| --- | --- | --- |
| skyline codes per cell (worker) | not set | not measured |
| node codes of the whole grid | not set | not measured |
| lights layer, rebuild of the near block | not set | not measured |

Not checked yet: anything of stage 5 run (the cells, the shade, the lights, the views), its time, the golden recipes
of the shade and the lights, and the pictures of the views above.

## Plan budget

Stage 1 of the plan of Hearth (`worldPlan(packSeed(725, 0), 1)`), seconds per phase. Hard limits: the whole `plan`
job at most 5 s in the worker, working memory at most 64 MB, bytes at most 12 MB.

| Phase | Target | Node in `dev` | Worker in the `shot` Chromium |
| --- | --- | --- | --- |
| heights | 2.2 | 2.30 (six faces in one thread; the page splits them into six `plan-heights` jobs) | not measured |
| drainage | 0.9 | 0.56 | not measured |
| channels and lines | 0.3 | 0.40 | not measured |
| tiles and bytes | 0.2 | 0.37 | not measured |
| moisture (stage 2) | 0.2 | 0.38 | not measured |
| sites (stage 3) | 1.0 | 1.35 | not measured |
| routes (stage 4) | 1.5 | 1.78 | not measured |
| whole job | at most 5 | stage 1 alone 3.63; stage 5 in one thread 7.14; the `plan` job of stage 5 with the heights given 4.83 | not measured |
| working memory | at most 64 MB | not measured as such; Node heap in use after the job 130 MB (the whole process, plans of earlier runs included) | — |
| bytes | at most 12 MB | stage 1 12.05 MB, stage 5 14.93 MB (both over the limit) | not measured |

Machine: Apple M4 Pro host, Node 22.23.5 in the `dev` container, one process, seed 725, 2026-11-15. Before the
index of tiles reused stage 3 at stage 4 (`plan-tiles.ts`) the stage 5 plan took 7.5–7.8 s with routes 2.1–2.3 s;
the bytes of every stage are unchanged by it.

## Checks

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm typecheck && pnpm check:layers'
```

The golden test (`pnpm test:golden`) holds two recipes of the example: "system example cells" and "system example
flights". They fly the legs of `flight.ts` through the running system without a browser. The plan of the world and
its cells have no recipe yet ("world cells: water" and "world river flight" are planned in
`tools/golden/world-cells-scenario.ts`); `window.__wh.planHash()` reads its fingerprint in the page. The picture itself (the
shaders, the hand-over between far and near, the frame time) needs a browser with a GPU.

## Structures of the settlements

From stage 3 every lot of a settlement gets a structure made by the structure generator of the engine (`gen-arch`),
in a frame of its own: up along the body's radius at its point, z toward its lane. The kinds are a cottage (thatch,
shutters), a house (a timber-framed upper storey over the lower one, standing out over a band with a closed
underside), a farmstead with a barn of boards, a workshop of stone, a hall (hip roof of slate, portal or arch, a
turret on the ridge), a mill (twelve-sided, stone, a fixed sail cross) and a tower; stone in tundra and rock. Every
site gets at least five kinds where its lots allow (`siteKinds`). A town gets a ring of line walls (`lineRing`) with
gaps where water, lanes or roads cross it, and a tower on every eighth node.

Within 250 m of the eye (out again at 280 m) at most 60 structures are built full on the page, within 3 ms per frame;
farther off the massing of the generator (`buildMassingMesh`, one mesh per cluster within 8 km, the walls of a town
included) stands for them, so every item is drawn once. Every entry of `RouteTable.spans` is a cluster of its own with
two abutments, piers every 14 m at most and a parapet on each side, cut into pieces by the grade. With `src=workers`
the worker builds both levels (`{ kind: 'site', level: 'massing' | 'full' }`); with `src=main` the same functions run
on the page within the budget; a damaged structure is always rebuilt on the page. `X` strikes the part in the middle
of the view: the parts that change fall (`fallPieces`, drawn in a `TransientLayer`) and leave rubble
(`buildRubbleMesh`) that grows as they land. The state lives only in the page (`__wh.damageHash()`), and `hit=1`
strikes the two nearest structures of a preset once they are built, without the fall. `__wh.stats().structures` gives
`{ full, massing, clusters, triangles, damaged }`. Presets: `world-village`, `world-lane`, `world-village-far`,
`world-town`, `world-village-b`, `world-span`.

## Creatures

From stage 3 (`life=1`, the default) creatures walk round the camera on Hearth: `creatures.ts` describes four rigs for
the engine's `RigLayer`, `life.ts` says who walks where and where each is at a time, `life-layer.ts` writes their
records every frame. Nothing is simulated and nothing is stored: a walk is a fixed path of plan lines walked there and
back for ever (stand, go, stand, return; the speed ramps over 1 s at both ends of a leg, the heading turns half a turn
to the right while standing), so the pose is a closed form of the system's time; a pause stops them, a jump poses at
once. `distanceM`, the phase of the gait, restarts with every leg.

| Who | Where | How many | Speed | Stands |
| --- | --- | --- | --- | --- |
| villagers (hood, pack, staff by hash) | lanes of every settlement, 1–3 lane lines from the home lot, at most 250 m | `clamp(round(0.6 · lots), 8, 24)` per village, `min(140, round(0.35 · lots))` in the town | 1.15–1.45 m/s | 20–90 s |
| a beast with its load and a villager 2.2 m ahead (60 %), or a lone villager with a pack (40 %) | roads, the whole route | `clamp(round(length / 800), 1, 12)` parties per route | 1.1–1.3 m/s | 120–600 s |
| a troop of three skeletons, 1.5 m apart | middle third of routes of 3 km or more | one per such route | 0.95–1.05 m/s | 5–10 s |
| grazers | ring 1.05–1.35 radii round a village, no water, no strip of a line | two groups of 3–6 per village | stand | always |

Walkers keep `sideM` (0.15–0.45 of the half-width) to the right of travel, so opposite walkers pass; they stand on the
drawn surface of their strip (grade plus the section at that offset, on a deck the deck). Only sites within their
radius + 450 m of the eye and routes in the tiles within 450 m take part (rebuilt after the eye moved 50 m), none when
the eye is more than 450 m above the surface; poses within 400 m are drawn, at most 300, per kind 200, 24, 40, 36.

`window.__wh.stats().life`: `near`, `far`, `hidden` (the layer's counts), `made`, `capped`, `logicMs`, `sites`,
`routes`. Views in `__wh.presets()`, each at a pinned time (the daylight time of its place, then the first moment
the walker of the scene is under way): `world-life-lane` and `world-life-lane-later` (3 s later), `world-road`,
`world-gait`, `world-troop`, `world-field`, `world-far-side`, `world-village-top`.

### Creatures budget

At `world-life-lane` and at the town centre, with `life=1` and `life=0`. Not measured yet; Docker draws with a
software renderer, so its frame times would say nothing of a graphics card, and the allowance of 0.3 ms on a real card
has not been checked.

| Measure | Limit | Measured |
| --- | --- | --- |
| instances | at most 300 | not measured (300 by construction) |
| draws of the creatures | at most 16 | not measured (4 kinds × 2 levels × body and contact by construction) |
| triangles per kind near / far | 300 / 130, 260 / 110, 420 / 160, 260 / 100 | not measured (estimated from the parts: 194 / 124, 108 / 86, 252 / 156, 124 / 88) |
| `logicMs` at the town centre, median of 200 frames | at most 0.15 ms | not measured |
| frame, `life=1` / `life=0` | — | not measured |

Not checked yet: the pictures of the views above (the only check that the new rig program compiles), the golden
recipes "creatures …" and "life …", and the budget.
