# Planet example

A flight from the surface of a small planet up to where the whole sphere is in view, and back. The planet is a
sphere 100 km in radius with terrain from noise in space, biomes from latitude, height and moisture, woods of
several kinds of trees that read as a canopy from afar, an atmosphere and a sun
that stands where the hour puts it, clouds by place with their shadows, rain or snow under them, and a sea the camera
can dive into. The page joins the engine's large-scale options in one scene: the sphere world
shape, streaming by screen-space error with blended levels, the atmosphere, the free camera, a render origin on all
three axes and a depth mode that holds one metre and the whole sphere in one view.

It imports only `wallhammer-web` (no content modules; `pnpm check:layers` enforces that). The terrain, the objects,
the materials and the flight are the example's own files.

The engine documentation describes it in [docs/planet.md](../../packages/wallhammer-web/docs/planet.md).

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://127.0.0.1:5281/planet/>. Another port: `EXAMPLES_PORT=5291 docker compose up -d`.

- `F` starts the flight and stops it. `#fly=1` in the URL starts it as soon as the start view has loaded.
- `W` `A` `S` `D` fly along the view, `E` and `Q` up and down, `Shift` faster, drag looks around, the wheel changes
  the speed. `1` jumps to the top of the flight, `2` back to the surface.
- `[` and `]` move the hour by half an hour. `L` tints every cell by its quadtree level.
- `B` measures a frame of the current view with the graphics work finished. `H` hides the panel.
- `R` switches the air between its tables and the reference quality (every pixel integrates its own view ray), to
  compare the two pictures and their frame times.
- `C` hides and shows the clouds (and with them the rain and their shadows).
- `M` plays the movie and stops it (see [Movie mode](#movie-mode)).
- `N` (dev server only, free camera) switches the mark mode: a click pins a note to the point under the cursor, kept
  with the view, a picture and facts of the place in `internal/marks/` (see
  [Marks](../../packages/wallhammer-web/docs/marks.md)).
- The line at the bottom always shows the height, the speed, the patches drawn, the time of a frame and the GPU
  memory.

URL hash (kept up to date while flying by hand):
`#seed=2611&lat=..&lon=..&alt=3&yaw=..&pitch=3&hour=..`

| Key | Default | Meaning |
| --- | --- | --- |
| `seed` | 2611 | Seed of the terrain. Without `lat` and `lon` the start place is found from it. |
| `lat`, `lon`, `alt` | from the seed, 3 | Degrees on the sphere (the poles are on the y axis) and metres above the top of land or water (negative under the water). |
| `yaw`, `pitch` | toward the view, 3 | Degrees; a positive pitch looks down. |
| `hour` | morning at the start | Universal time; the sun stands over the longitude 180° − 15° × hour. |
| `fly` | 0 | `1` starts the flight once the start view has loaded. |
| `flyS` | 50 | Seconds of the way up (the way down takes the same, the rest at the top 6 s). |
| `top` | about 260 km | Height of the top in metres. The default is a quarter above the least height that shows the whole sphere with its air. |
| `atm` | 1 | `0` switches the atmosphere off, `ref` starts it in the reference quality. `air` is the thickness of the shell in metres (30000). |
| `depth` | `reversed` | Or `logarithmic`. |
| `src` | `workers` | Or `main`: cells generated on the main thread within a budget per frame. |
| `horizon` | 1 | `0` switches the culling behind the horizon off. |
| `px`, `cells` | 2, 900 | Tolerated error in pixels and the budget of cells. |
| `gpu` | 560 | Ceiling of GPU memory in MB; `0` for none. |
| `levels` | 0 | `1` tints the cells by level. |
| `strip` | 1 | `0` switches the strips off: the page without them (its generator, worker and materials). |
| `view` | none | Starts in one of the strip, cloud or sea views of `__wh.presets()`, for example `strip-node`, `clouds-rain` or `underwater`. |
| `clouds` | 1 | `0` builds the page without clouds, rain and cloud shadows. |
| `vol` | 1 | `0` keeps only the cloud shell: no volumetric clouds near the ground. |
| `cover` | none | `0`–`1`: one cloud cover over the whole planet in place of the profile and its patches (rain from 0.6). |
| `movie` | 0 | `1` plays the movie from the start as soon as the page has loaded. |
| `bars` | 1 | `0` plays the movie without the letterbox bars. |
| `time` | running | Seconds of animation time to start at, frozen (the exact view of a mark carries it). |
| `marks` | 1 | Dev server only. `0` hides the marks' pins; `1` turns the marks on in a page driven by a script, which has none otherwise. |

## Strips

The planet carries one strip 50 km long laid over an edge of the cube; at its far end it forks into two lines of 6
and 4 km (`src/strips.ts`, with the engine's strip tools). Without `lat` and `lon` the page starts 3 m above the main
line, 300 m from its start, looking along it, at the local noon. From the top of the flight the strip is a thin
unbroken line; from close by it is a band with a cross-section, cut through rises and filled across dips.

- `planetStrips(seed)`: the route is searched from the seed (stream `0x57a1`, arithmetic and `Math.sqrt` only): 64
  candidates, each a point on an edge of the cube and a heading 50°–70° to it, edges ordered from the one nearest to
  the start place of `findStart`; the first with land under 80 % of its points and no ground above 1800 m is taken.
  Half-widths 9 / 6 / 4.5 m, a section with a camber and hems, a shoulder of 14 m, a bed of 0.3 m. The grade is the
  ground smoothed along the line, at least 4 m above the sea and at most 6 m from the ground.
- `generatePlanetStripCell(seed, cell)`: `generatePlanetCell` through its hooks (`buildPlanetCell` in `world.ts`)
  with the ground cut and filled by `stripCarve`, no objects and no cover on the shoulders, the shoulders tinted as
  bare ground, and a second mesh of material `strip` (domain version 6; the plain generator has 5). A cell no line
  reaches is the plain cell under that domain version; its sea floor stays where it is. `src/strip-cell-worker.ts` runs it in the workers.
- `STRIP_MATERIAL` (`shaders.ts`) blends with the surface and keeps the strip at least 1.6 pixels wide.
- Views of `__wh.presets()`: `strip-orbit`, `strip-edge-20km`, `strip-edge-levels` (level tints), `strip-900m`,
  `strip-surface`, `strip-node`. `__wh.hash()` returns the URL hash of the current view. Pictures in Docker:

```sh
docker compose run --rm shot --url http://dev:5281/planet/ --hash 'strip=1' --presets strip-orbit,strip-node
```

## Plants and woods from afar

The surface is split into seven biomes by a temperature (latitude, height and a slow noise of the seed) and a
moisture (two noises of the seed, drier in belts around 25° of latitude): ice, tundra, taiga, broadleaf forest,
meadow, dry land and bare rock (`climate`, `landWeights`, `BIOME` in `src/world.ts`). The weights blend across their
borders; the colour of the ground is their mix, with sand at the shore, rock on steep and high ground and snow where
it is cold. Nothing grows above 1700 m (`PLANT_TOP_M`) nor below 4 m.

- **Plants.** One rule on a grid of level 13 places at most one plant per point, of four kinds drawn from the chances
  of the biomes there (`plantChances`): conifers (taiga, some in forest), broadleaf trees (forest), flat crowns (dry
  land and warm meadows) and shrubs (meadow, tundra, the edges). All meshes are generated (`src/shapes.ts`); trees
  have a near and a far mesh up to 700 m and 5 km, shrubs up to 900 m. Rocks stay as they were.
- **Thinned trees.** Every tree carries a rank (stream `0x716`). The cells of level 10 hold every plant; levels 9, 8
  and 7 hold the trees of the top 25 %, 6 % and 1.6 % of the rank (`THIN_RANK`), so a far wood still shows its
  tallest trees as dots. Each of them is one of a child cell's (same id). Shrubs and rocks stay at level 10.
- **The canopy.** The surface carries the far look of the plants as its cover (`surfaceCover`: their colour and the
  share of the ground they hide). In `TERRAIN_MATERIAL` the share of the cover that stands for trees already gone
  (`coverShareAt`, by rank, in step with the thinning) lifts the ground of a wood by up to 13 m (`CANOPY_M`), in the
  colour pass and in the shadow pass alike, so a wood has a relief and casts a shadow. The share the canopy hides
  grows as the view grazes (the gap fraction to the power of the path through the crowns), the crowns darken by the
  same share (`THIN_SHADE`), the floor under them is litter and moss in their shade, and the line where a wood ends
  wanders with three octaves of noise fixed to the planet instead of following the cells' triangles, where the wood
  ends sharply; across a wide band of thin cover (where the tundra meets the taiga) it follows the cover smoothly, so
  the band does not break into dark islands of wood from a few kilometres up. The tree line
  ends the canopy in the same way. The same share shrinks each tree away as it leaves, so the far look takes over
  without a jump in tone. The strips are pulled up over the canopy where they cross a wood.
- **Cost.** A cell of level 10 in a forest takes 3–4 ms in Node; the coarse levels add about 50 thinned trees per
  cell. On the host GPU (1600×900, no clouds) the frame from 2 km and from 20 km up costs about 0.2–0.3 ms more than
  before the woods, near the ground in a forest about 0.5 ms more with three times the instances.

## Clouds

The clouds use the engine's cloud cover by place, volumetric clouds and cloud shell
([Clouds](../../packages/wallhammer-web/docs/environment.md#clouds)); the cover is the example's own (`src/weather.ts`).

- `planetCloudField(seed, timeS, cover)`: the field for `cloudFieldSlot`. A profile of eight covers by latitude (wetter
  round the equator and in the middle latitudes, drier belts, clearer poles), each moved by up to ±0.06 by the seed
  (stream `0x3e47`), and value-noise patches about 32 km across that carry it from clear sky to a closed deck. The
  patches start at a place given by the seed and drift with the page's wind (from 240°, 6 m/s) at half the speed of
  the cloud pattern. A pure function of the seed and the animation time.
- `planetWeatherAt(seed, dir, groundM, timeS, cover)`: the weather at a place, from `cloudFieldCover`: rain or snow
  from a cover of 0.6 (snow where the place is cold: toward the poles and on high ground), a little fog and wet ground.
- The page sets the weather under the eye as `env.weather` every frame, the cover and fog faded out between 4 and 8 km
  up, the falling rain or snow between 1.5 and 2 km. The volumetric clouds lie 1.5–4 km above the sea (the mountains
  reach into them); the cloud shell draws them beyond 20–40 km and alone from 15–30 km up. The rain stops where no
  cloud stands over the eye. The cloud shadows come from a texture.
- The materials multiply the sun share by `u_cloudFieldLight.y` under the atmosphere (`src/shaders.ts`).
- Views of `__wh.presets()`, at animation time 600 s in the local morning: `clouds-8km` and `clouds-below` (broken
  cloud over low land), `clouds-rain` and `clouds-rain-8km` (a raining deck). `__wh.weather()` returns the frame's
  weather and the weather under the eye; `__wh.setClouds(on)` is key `C`.

## The sea

Everything below the base sphere is sea. Its floor is the terrain (`groundHeight` below 0) in the colours of a sea
floor: wet sand near the shore, rock in patches, paler silt further down. Every cell whose ground goes under 0 carries
a second mesh at height 0 of material `water` (`WATER_MATERIAL`), drawn after the others with blending; its colour
holds the depth of the floor under it (`waterDepthByte`) for the foam of the shore.

- **Waves.** The surface moves: a sum of eight trochoidal trains raised by the page's wind (`PLANET_WIND`), from the
  engine's `waveTrains` ([A moving surface of waves](../../packages/wallhammer-web/docs/rendering.md#a-moving-surface-of-waves)).
  Their plane is a chart of the sphere: the face of a cube under the eye, its coordinates the angles along the face's
  axes times the radius (`src/sea.ts`); the shaders compute a point's place in it from differences to the eye's foot,
  and the phases at the foot come from the CPU in double, so the surface is a pure function of position and time.
  While the eye is lower than 60–120 m a grid of rings round its foot (`SeaSurfaceLayer`, 500 m across) is moved by the
  waves in its vertex shader, each train faded where the rings are too far apart for it; the water of the cells leaves
  out that disc and is flat, with the waves' normal per pixel. The grid is drawn from its outer ring inward, so a near
  crest lies over the water behind it, and a crest that stands in front of the land or the sky is opaque water, not a
  veil. Every pixel takes the normal of the trains it can hold plus ripples down to a few centimetres (octaves of
  simplex noise, `SEA_RIPPLES` in `src/shaders.ts`, placed on the water from the CPU like the trains), each faded by
  the pixel's footprint; the rest widens the sun's glint. Foam lies on the crests the waves squeeze together and
  in a band of swashes along the shore. The CPU computes the eye's height above the moving surface with the same
  trains (`seaSurfaceHeight`), so above and below never disagree with the picture.
- **On the way through the water.** Every material takes `u_sea` (the eye's height above the waves and above the
  level) and applies the water between the eye and a fragment with the engine's `mediumPath` and `mediumApply`
  ([A medium below a level](../../packages/wallhammer-web/docs/rendering.md#a-medium-below-a-level)): blue-green,
  about 85 m of sight (`SEA_EXTINCTION`). The light at the floor is what is left of the surface's light at its depth
  (`SEA_LIGHT_LOSS`), with soft moving caustics, strong in the top two metres and blurred and faint below.
- **From above.** The water shows the floor through it near the shore (turquoise over sand) and the sea's colours by
  depth from higher up, the sky it reflects by the Fresnel share (lighter where a wave tilts the reflection up), and
  the sun's glint broken by the waves.
- **From below.** Inside the window of refraction (about 48.6° round the zenith, bent and broken by the waves and the
  ripples, its edge soft over the spread of the facets in a pixel) the sky and the sun, the sun as the glitter of the
  facets that bend it toward the eye; beyond it the surface mirrors the water under it; foam is grey from below. `SeaBackdrop` (`src/sea.ts`) stands
  a quad at the distance where the water hides everything (`mediumClearDistance`), drawn before the cells, in place of
  the sky, the air and the clouds, with a glow toward the sun. `SeaShaftsLayer` adds light shafts along every view
  ray: the caustics' pattern carried down along the refracted sun. The eye gets used to the dim light in part, so the
  deep water is darker but not black. No rain falls on an eye under the water.
- **The waterline.** Within a few decimetres of the surface `SeaLensLayer` splits the picture where the surface meets
  a lens 25 cm in front of the eye: the part on the other side shows the water (or the bright sky), with a dark line
  along the waterline.
- **The camera** may go under the water down to 2 m over the floor; its speed follows the distance to the water or the
  floor, whichever is nearer.
- **Views.** `findSeaPlaces(seed)` (`world.ts`, a golden-ratio sequence over latitudes under 50°) finds a shallow
  place 5–10 m deep in a warm sea with the floor rising toward the shore and a deeper one 70–120 m deep on a slope.
  `__wh.presets()` adds `sea-above` (40 m over the shallow place), `sea-crossing` (riding the waves 4 cm above them,
  the waterline across the lens), `underwater` (3 m down), `underwater-up` (4 m down looking up toward the sun) and
  `underwater-deep` (8 m over the deep floor), each at the local late morning; `#view=underwater` opens one. The
  panel shows the eye's height above the waves while the near surface is on.

## Movie mode

A hands-off show of the planet in seven shots, about 90 s, looping (`src/movie.ts`). `M` or `#movie=1` plays it; the
panels are hidden and letterbox bars frame the picture at 2.39 : 1 (`bars=0` leaves them out). Every shot is data in
`MOVIE_SHOTS` (its kind, length, fades and the height of the sun it asks for), turned by `planMovie` into a pose that
is a pure function of the time into the shot: the eye, the view, the hour and the animation time of the clouds. The
places are found from the seed, the hours solved from the sun's height at each place, so the movie works for every
seed. The eye moves with eased speed and keeps above a smoothed envelope of the ground along its path (under the
sea above the floor and under the troughs; the check `pnpm verify` measures both).

| Shot | Place | Light | Seconds |
| --- | --- | --- | --- |
| `limb` | 45 km above the start place, looking at the edge of the planet | the sun rising over the limb | 10 |
| `descent` | the way down of the flight from the top to 220 m over the start place | morning, sun 24° | 14 |
| `valley` | 40 m over the woods of the start place, toward its high ground | morning, sun 26°, from behind and the side | 12 |
| `sea` | a glide 1.6–3 m under the waves of the shallow sea place over its sand (at least 1.5 m over the floor), then a tilt up to the window of the surface | sun 50°, ahead and to the side | 10 |
| `peak` | part of an orbit round a summit under a clear sky: the one under 1300 m (below the clouds' base, in air thick enough for a blue sky) that stands highest over the land 3 km round it | afternoon, sun 32°, from the side and behind the eye | 11 |
| `rain` | 5 m above low land under a raining deck | morning | 8 |
| `rise` | from 120 m under broken cloud through the deck to the top | sunset, the terminator across the sphere | 24 |

Playing by the clock, the movie waits in black at every cut until the streaming has settled at the new place (at
most 5 s). For a recording frame by frame, `window.__wh` has:

- `movieLength()`: seconds of one pass; `movieShots()`: the shots with their length and place.
- `movieFrame(t, warm = 32)`: holds the movie at time `t` (camera, hour and animation time), renders until the
  streaming has settled and `warm` more frames at the same pose (the volumetric clouds average over frames), and
  resolves with the shot, the time into it and the share of black of the fades. Take the picture after it resolves;
  any frame rate works.
- `startMovie(t)`, `stopMovie()`: as key `M`.

## Files

| File | What |
| --- | --- |
| `src/world.ts` | The planet: constants, the height and colour of the surface, the cover, the rules of the objects, `generatePlanetCell`, `findStart`, `findSeaPlaces`. Pure, runs in Node and in a worker. |
| `src/shapes.ts` | Unit meshes of the plants (conifer, broadleaf, flat crown, shrub) and the rock. |
| `src/shaders.ts` | The materials (surface with the canopy of the woods and the sea floor, objects, thinned trees, strips, water). |
| `src/sea.ts` | The moving sea: the waves' plane and trains (`seaTrains`, `seaSurfaceHeight`, `seaUniforms`), the near surface (`SeaSurfaceLayer`), the backdrop under the water (`SeaBackdrop`), the light shafts (`SeaShaftsLayer`) and the waterline (`SeaLensLayer`). |
| `src/weather.ts` | The cloud cover by place and the weather at a place: `planetCloudField`, `planetWeatherAt`. Pure. |
| `src/flight.ts` | The flight: `flightPose(plan, radius, t)`, a pure function of time. |
| `src/movie.ts` | The movie: `MOVIE_SHOTS`, `planMovie`, `movieFrame(movie, t)` (pure) and the player behind key `M`. |
| `src/flight-check.ts` | The flight run through the streaming manager without a browser; the streaming configuration shared with the page. |
| `src/main.ts` | The page: engine, streaming, flight driver, line and panel, script interface `window.__wh`. |
| `src/marks.ts` | The marks' host (dev server only): the pick against the height and the sea level with `marchRay`, the exact view, the facts of a place; installs `installMarking` of `wallhammer-web/platform` behind key `N` as `__wh.marks`. The store is `marksStore` of `wallhammer-web/marks-store` in `vite.config.ts`, with the folder `internal/marks/`. |
| `src/cell-worker.ts` | The worker that runs the generator. |
| `src/strips.ts` | The strips: `planetStrips`, `generatePlanetStripCell`. |
| `src/strip-cell-worker.ts` | The worker that runs the generator with the strips. |
| `scripts/verify.ts` | The headless checks. |

## Budget

The example is built for a frame under 8 ms and under 600 MB of GPU memory at 1920×1080.

- The panel shows a report of the last flight: the time between frames (mean and worst), the display's refresh
  interval and how many frames missed a refresh, the main thread's part and how often it alone was above 8 ms, the
  peak of GPU memory, of patches and of holes, and one frame at the landing measured with the graphics work finished.
- The time between frames cannot fall under the display's refresh interval, so the report counts missed refreshes
  and not frames above 8 ms. Read `cpu` and the measured frame (`B`) to see the room under the refresh interval.
- The GPU ceiling (`gpu`) keeps the cells under the budget: over it the least needed cells leave.

## Checks without a browser

```sh
docker compose exec -T dev sh -c 'cd /app/examples/planet && pnpm verify'
```

It checks the generator (bytes independent of the order of generation, round trip through the cell format, every
object in exactly one child cell, the thinned trees of levels 7 to 9 too), the flight (ends where it starts, the top shows the whole sphere, the height
changes by less than 2 % per frame at 60 Hz, the way down mirrors the way up) and the streaming along the flight with
the real generator (the sphere covered exactly once at every step, the budget of cells held, an estimate of the GPU
memory against 600 MB) and the movie (every shot keeps at least 3 m above the ground with the strips, under the sea
at least 1 m above the floor and 1.5 m under the level, and the eye never jumps inside a shot). It ends with
`planet: all checks passed`; a problem prints a line `FAILED: …` and the exit code is 1. CI runs it after the other
checks.

The golden test of the workspace holds the generator and the flight as "planet example cells" and "planet example
flight", and fingerprints of the other pure parts: "planet example weather" (`planetCloudField`, `planetWeatherAt`),
"planet example sea places" (`findSeaPlaces`) and "planet example movie" (`planMovie`, `movieFrame`: the poses of
every shot twice a second). The waves and the medium of the sea are engine code with their own recipes ("gen-core
waves", "core medium").
