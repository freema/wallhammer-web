# Fantasy village

A living fantasy village on Wallhammer Web, in a hand-painted classic MMORPG style. It has half-timbered houses, an
inn on a cobbled square, an open forge, a water mill with a turning wheel on the river, a weir and a stone bridge, a
windmill on the hill and a castle on the ridge behind. Villagers, children, animals, smoke, fire and sparks move
through it, and the light goes from late afternoon to evening.

Everything is generated from code: there are no textures and no model files. The painted look comes from vertex
colours, baked ambient occlusion and the shader's per-material colour breakup. Every random choice is drawn from a
named hash stream of the seed, so the same seed always gives the same village.

The example uses only the engine core (`wallhammer-web`). Its content modules live in this folder.

## Run

```sh
docker compose up -d     # from the repository root: one service for all examples; the village is at http://localhost:5281/fantasy-village/ (EXAMPLES_PORT)
```

Checks without a browser, in the dev container:

```sh
docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm typecheck'
docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm inspect'      # layout, meshes, flipped faces, walking graph, triangles per module
docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm collisions'   # geometry inside buildings, crowns in roofs, fences on streets, floating parts
```

Each part also has its own check script (`src/*/check.ts`). Its header gives the command.

## Controls

| Input | Action |
| --- | --- |
| drag / wheel | orbit / zoom |
| 1 | overview of the inn and the square |
| 2 | street level on the square, facing the inn |
| E | afternoon / evening, as a smooth change |
| P or space | pause the animation (villagers, smoke, water, wind, wheel, sails) |
| V | show or hide the villagers |
| M | movie mode on / off: a looping tour of the village (below) |
| Escape | leave movie mode (a drag or the wheel on the picture does the same) or walk mode |
| G | walk mode on / off: a figure on the square (below) |
| F | in walk mode: first person and back |
| N | in the orbit view, dev server only: the mark mode on / off (below) |

In walk mode: W A S D or the arrows walk, Shift runs, space jumps (it does not pause there), a drag turns the view,
the wheel moves the camera in and out, a gamepad works too (left stick, right stick, A, RT).

Marks (dev server only, not in the live demo): `N` in the orbit view (not in walk mode nor during the movie) switches
the mark mode; a click pins a note to the ground, picked against the terrain's height function (`heightPick`; the
buildings, trees, props, villagers and the water's surface are not in it), kept in `internal/marks/` by the dev
server's store; one call to the engine's `installEngineMarking` in `src/main.ts` (Marks in the engine's docs). The drag
and the wheel do not orbit while the mode is on; `N` or Escape leaves it. A mark's hash is the page's own (`hash()`)
plus the exact view and the clocks (`mkview=`, `mkclock=`). `marks=1` turns the marks on in a page driven by a
script, `marks=0` hides the pins.

The URL hash keeps the view, the mood and the toggles (`#seed=7&yaw=…&pitch=…&dist=…&tx=…&e=1&p=0&v=1`), so a link
reopens the same picture. Measuring parameters are kept in the hash when given:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `pr=` | `1.5` | cap of the canvas pixel ratio (`createEngine({ maxPixelRatio })`); `0` = the device's own ratio |
| `sh=` | `0` | shadow redraws per second of animation time caused by moving parts; `0` = in every frame they move |
| `sky=` | `behind` | `first` draws the sky before the scene (shades every pixel); `behind` only where the scene left gaps |
| `aa=` | browser | `0`, `2` or `4` samples per pixel (`renderer.samples`) |
| `cs=` | `1` | `0` computes the cloud shadows in every lit fragment instead of reading them from the engine's cloud shadow texture (`createEngine({ cloudShadows: true })`) |

The cloud shadows come from the engine's cloud shadow texture: the same pattern, drawn into a texture every few frames
instead of three noise lookups in every lit fragment. The picture is the same (a mean difference under 0.2 of 255 in
the presets); on an Apple M4 Pro at 2560 × 1440 the frame (`profile(30)`, the shadow kept) fell from 5.4–5.6 to
4.9–5.1 ms in `overview`, from 4.0 to 3.5 ms in `street` and from 5.1 to 4.5 ms in `far`.

The engine's volumetric clouds (`cloudVolume`) are not used here. The sky of the village is a painted gradient seen
through a haze of 450 m, mostly behind hills; clouds 1.5 to 4 km up disappear into that haze, so they were not to be
seen in any preset, from the castle or in the tour, while they cost 0.2–0.9 ms more per frame at 2560 × 1440. Their
shadows are kilometres wide and would darken the whole village at once.

`movie=1` in the hash starts movie mode once the village is built, `walk=1` walk mode. Neither is written back: the
hash is rewritten when the mode ends or a key is pressed, and then it is gone.

`window.__wh` serves the screenshot tool and scripts:

- `ready`, `presets()`, `setView`, `getView`, `hash()`, `settled()`;
- `setEvening`, `setTimeOfDay`, `setTime`;
- `hud()`, `stats()` (the counts below and the measured frame times), `inspect(filter)`;
- `movie.start()`, `movie.stop()`, `movie.active()`, `movie.seek(t)` (show the tour at `t` seconds, camera and mood at
  once, also outside the mode; inside it the tour runs on from there);
- `walk.start()`, `walk.stop()`, `walk.active()`, `walk.state()` (feet, speed, `grounded`, `steep`, heading,
  `firstPerson`, boom length, solid count; null before the first start), `walk.walkTo(x, z, seconds, { run })` (fixed
  walker steps toward a point, synchronously, the same path as `pnpm collisions`; then draws), `walk.teleport(x, y, z,
  yawDeg?)` (`y` NaN or undefined: on the ground there), `walk.firstPerson()` (toggles) and `walk.solids()` (solids
  per label). `walkTo` and `teleport` start the mode when it is off;
- `profile(frames = 20)` and `profileText(frames)`: the engine's frame profile of the current view (`profileFrame`):
  frame time with the shadow kept, with it redrawn every frame, while the animation runs, and the cost of every layer
  (`statics-casting`, `statics-flat`, `parts`, `water`, `particles`, the sky). It waits for the GPU after each frame,
  so run it in a real browser on the machine you care about; the page stalls for a few seconds.

The HUD (top left) shows:

- the triangles drawn in the last frame and the scene's total;
- the draw calls, and the shadow pass (its triangles and draws, `(moving parts only)` when only the parts were drawn
  over the kept map of the static casters, or `cached`);
- the measured frame time over the last 120 frames (mean, worst and CPU time);
- the lights in use, the particles, the drawing buffer size with its pixel ratio and the build time.

## Movie mode

`M` starts a looping tour of 45 s (`src/movie.ts`, on the engine's `OrbitPath`): from the overview down over the
south street to the square and the inn, along the street to the mill and its wheel, round over the weir, down the
river past the forge to the bridge, up over the village to the castle on its ridge, and back to the overview. From
19 s the light turns to evening, from 39 s back to afternoon, so the loop starts in the afternoon again. `M` blends
from the current view into the tour over 2.5 s.

While it runs the HUD and the cursor are hidden, the animation runs (a pause is lifted, `P` and space do nothing),
and the hash is not touched. `Escape`, `M`, `1`, `2` or a drag or the wheel on the picture leave it: the orbit
controls go on from where the tour left the camera, without a jump.

## How the scene is organised

- `src/layout.ts` holds the composition, which every module reads: the structures with their footprints and doors,
  the streets, the river, weir and bridge, the trees, lanterns, gardens and stalls, the points of interest and the
  walking graph.
- `src/terrain/height.ts` is the height field. It levels a pad under each building, dips the square and paths, and
  carves the river bed.
- `src/env.ts` sets the sun, the sky and the evening glow channels, and drives the afternoon/evening change.
- `src/kit/` is a small modelling kit:
  - the mesh builder and its shapes (bevelled boxes, crooked beams, lathe, sweep, tube, rock);
  - colours, hash streams and baked occlusion;
  - instanced part sets and mesh inspection.
- The content modules (`src/modules.ts`) each turn the layout into static meshes, part sets, point lights, particle
  emitters and an optional per-frame `update`. In build order:
  - `terrain/*`: ground, water, paving, bridge, weir and rocks;
  - `buildings/*`: inn, cottages, forge, mill, windmill and castle, built with the architecture kit in `src/arch/`
    (walls, timber frames, openings, roofs, details);
  - `vegetation`, `props`, `villagers` and `fx` (fire, smoke, night lights).
  - Each may also hand over `solids` for the walk mode (`src/kit/solids.ts`), plain data that is never drawn.
- `src/walk/` is the walk mode: the collision world from those solids and the scripted walk (`world.ts`), the
  walking figure (`player.ts`) and the mode itself with its follow view and input (`mode.ts`).
- `src/render/` turns those contributions into engine layers (`scene.ts`) and holds the two materials
  (`materials.ts`); everything else is the engine:
  - statics are merged by material and cut into spatial chunks (56 m near the village, 256 m beyond) by
    `chunkMeshes`, drawn front to back by `PieceLayer`;
  - each part set is one instanced draw of an `InstanceSetLayer`;
  - `PointLightSet` picks the 32 lights that matter most to the eye each frame;
  - particles are one `ParticleLayer`, two draws.

How to write a module is described in [BUILDING.md](BUILDING.md), and the architecture kit in [src/arch/README.md](src/arch/README.md).

## Techniques

- **Painted look without textures.** Each vertex carries a colour, a material class and baked occlusion: rays against
  the mesh itself, plus a ground term. The solid shader adds the stylised parts per material: breakup of stone,
  plaster, timber and roof colours, a warm rim, soft banded light and the evening glow of windows and lanterns.
- **Architecture from a site tree.** A building is a tree of local frames (`Site`): walls, openings, timber frames,
  roofs with holes for chimneys and dormers, and details such as signs, banners, window boxes and lanterns. Each
  part gets its own hash stream.
- **Instanced parts.** Trees, bushes, villagers, animals, the mill wheel, the windmill sails and the swinging inn and
  forge signs are part sets: one mesh, a 16-float record per instance (matrix, tint, glow) and one draw per set. Only
  sets whose records changed are uploaded.
- **Villagers.** Agents walk a navigation graph between points of interest on a fixed-step simulation and do their
  routines: talk, sweep, hammer at the forge, sit on benches, go in and out of doors. Children play, and chickens,
  dogs and cats wander. Bodies are rigid parts posed per frame.
- **Particles in closed form.** Smoke, fire, sparks and water spray are computed on the GPU from the animation time,
  so pausing or scrubbing shows the same frame and nothing is integrated on the CPU.
- **Lights.** Each module declares point lights (windows, lanterns, forge, fires). Each frame the engine's
  `PointLightSet` packs the 32 that matter most to the eye into one uniform block, without allocation. Evening lights
  are gain group 1, faded with dusk. Each chunk visits only the (at most 8) lights that reach its box; a chunk that
  more reach visits all 32 (`__wh.stats().lightsCrowded` counts those draws).
- **Shadows.** One shadow map fitted to the view, kept until something asks for a refit. The parts are dynamic
  casters: in a frame where only they moved, the engine copies the kept map of the static casters and draws just the
  parts over it. A still or paused frame draws no shadow pass. `sh=` can limit how often the moving parts redraw it.
- **Cheaper shading.** The noise layers that `detailVisibleAt` fades to exactly zero (fine breakup far away, the water
  ripples) are not computed at all, so far pixels cost less with the same image. With `sky=behind` the sky is drawn
  after the opaque layers and shades only the gaps.

## Performance

Measured with the screenshot tool (headless Chromium with the SwiftShader software renderer, 1600 × 900, seed 7):

| View | Triangles drawn | Draw calls | Shadow pass | Lights |
| --- | --- | --- | --- | --- |
| street (preset 2), afternoon | 1.40 M | 46 | cached | 1 of 48 |
| overview (preset 1), evening | 1.41 M | 47 | 1.32 M in 35 draws | 32 of 48 |

- The scene totals 1.52 M triangles (`pnpm inspect` lists them per module) and 1026 particles.
- The build takes about 5 s in that container.
- The budget was about 1.5 M triangles and fewer than 60 draw calls.
- The per-frame code of the example allocates nothing: the camera, lights, part records and particle uniforms reuse
  preallocated arrays.
- The engine itself still makes a few small objects per frame (the view matrices and a cache key string).
- The table above was measured before the switch to the engine's layers (2026-11-16); the counts change little (the
  static chunks are the same cells), the cost per pixel does: fewer lights per chunk, no far noise, the sky behind.
  To compare on a real GPU, open the same view and run `__wh.profileText()` with `pr=1`, `pr=1.5`, `pr=2` and with
  `sky=first`.

No frame rate is claimed for real hardware. The software renderer is not a GPU, and the HUD's frame time there
reflects the screenshot setup, not a target machine. To see the frame time on your own machine, open the example and
read the HUD's `ms/frame` line, or call `__wh.stats().frameTimes`. The `worst` value includes shader compilation and
mood changes.

## Walk mode

`G` puts a figure on the square, south of the well, looking where the camera looked, and switches to the engine's
follow view (`FollowRig`) with its walker over a collision world (`CollisionWorld`). `G` or `Escape` brings the orbit
view back above the figure, looking the same way; `M`, `R`, `1` and `2` leave the walk mode too. The figure is a
villager in their own colours (saffron hood and cloak, bright blue tunic): the same body, rig and walk cycle
(`villagers/looks.ts` `makePlayer`, `villagers/rig.ts`), its stride driven by the ground actually covered.

The collision world (`src/walk/world.ts`) is built on the first `G` (about 5 ms) from what the modules hand over in
`Contribution.solids` (helpers in `src/kit/solids.ts`; every module owns its solids, nothing guesses positions):

| Module | Solids |
| --- | --- |
| buildings (inn, cottages, forge, mill, windmill) | a prism per footprint ring up to the highest vertex; the open forge is closed as a whole |
| castle | curtain walls, the round towers, gatehouse, keep, hall, chapel turret (the gate is shut) |
| vegetation | the giant trunks, a trunk per tree, a low round mass per bush |
| props | lantern posts, the well, a thin wall per railed fence span (the open gate stays passable), stall counters (not the canopies), trough, benches and baskets (standable), clutter, carts and woodpiles |
| rocks | the outline of every cluster, standable |
| bridge | the deck as standable slabs following its hump, the parapets |
| water | the river as an invisible limit 0.2 m inside its edges, cut back beside the bridge's corridor |
| ground | the edge of the map: invisible walls on a circle of 108 m (the detailed terrain ends at 112 m) |

`pnpm collisions` builds the same world and walks a figure (fixed walker steps, `driveTo`) from the square to the inn,
over the bridge and to the forge along the villagers' paths: it must arrive without getting stuck, never inside a
building or in the river; then it pushes for 8 s straight at the middle of the inn, the forge, two cottages and the
river up- and downstream of the bridge, none of which may let it in.

## Known limits

- Far trees and far chunks are not culled separately beyond the engine's per-chunk culling.
- Villagers have no inverse kinematics on stairs: feet follow the ground height, not individual steps.
- The castle stands as a backdrop on the ridge, without a road to it.
- Walk mode: villagers do not step aside for the walking figure and it passes through them (not built). The castle
  lies beyond the edge of the walk; the mill race, the weir and the washing line have no solids; a solid is an upright
  prism or cylinder, so roofs, eaves and crowns are not stood on and nothing is climbed but steps of up to 0.35 m.
- The mill wheel is turned slightly against the river's flow (about 27°) to stay clear of the bank.
