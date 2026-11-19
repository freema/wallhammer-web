# Endless world example

An endless noise world streamed in quadtree cells around the camera: continents, lakes, ridged mountains and
climate bands, with conifers, boulders and rock pillars placed as instances. Cells are generated in web workers (or on
the main thread within a per-frame budget) or read from baked files over HTTP; all three give the same bytes. The
engine's sky, time of day and weather stand behind it. It looks the same 10,000 km from the origin as at it: cell data
are cell-local and the render origin moves in whole 1,024 m steps.

It imports only `wallhammer-web` (no `gen-arch`, `gen-ground` or `gen-vegetation`; `pnpm check:layers` enforces that).

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://127.0.0.1:5281/endless/>. Another port: `EXAMPLES_PORT=5291 docker compose up -d`.

- `W` `A` `S` `D` fly, `Shift` six times faster (up to 18 km/s), drag orbits, the wheel changes the height.
- `[` and `]` move the hour by half an hour.
- `L` tints every cell by its quadtree level, `H` hides the overlay.
- URL hash (kept up to date while flying):
  `#seed=7&x=10000000&z=0&yaw=30&pitch=14&dist=260&hour=15&w=clear&src=workers&levels=1`
  - `w`: `clear`, `clouds`, `rain`, `snow` or `fog`;
  - `src`: `workers` (default), `main` (main thread, blocking jobs under a ms budget) or `files` (baked cells).

The overlay shows the cell states, the work queue, generation and upload time per cell, memory and draw calls.

### Free camera

`#cam=free` swaps the orbit camera for the engine's `FreeRig` (`src/free-camera.ts`); without it nothing changes.

- `W` `A` `S` `D` or the arrows fly along the view, `E` / `Space` and `Q` / `C` go up and down, `Shift` is six times
  faster, a drag looks around, the wheel changes the speed.
- The speed follows the height above the surface (5 m/s near the ground, up to 3 km/s high above it) and the camera
  never comes closer to the terrain or the water than 3 m.
- `F` or `follow=1` in the hash (off by default) makes the camera hold its height above the surface while it moves:
  it follows the terrain up and down and only `E` / `Q` or flying along a tilted view change the height. Without it
  the camera keeps its course and is only pushed up where the terrain comes closer than 3 m.
- URL hash: `#cam=free&x=0&z=0&alt=60&yaw=30&pitch=14` (`alt`: metres above the surface at the start, `pitch`:
  positive looks down). `dist` is not used.
- Shot presets in this mode: `free-low`, `free-mid`, `free-high`, `free-down`, `free-far-low`
  (`node shot.mjs --url http://127.0.0.1:5281/endless/ --hash cam=free`).

### Smooth levels of detail

`#lod=smooth` switches on two engine options together; without it nothing changes.

- **Selection by screen-space error.** A cell is split while its error covers more than `px` pixels on the screen
  (default 2, CSS pixels) and at most `cells` cells are wanted at once (default 800). The manager never asks for a
  cell below one that is not loaded, and starts with what lies ahead of the view.
- **Blending between levels.** Cells come from a second generator (`generateSmoothCell`, cell format 2 with the hash
  of the world shape and the cell's error). Every vertex and every instance also carries its place on the level one
  coarser, and the shaders blend the two by distance, so a level change is not a jump. A skirt covers what is left.
  An object that the coarser level does not hold grows with the same blend instead of appearing at once.
  Every cell with land reports the full error of its level, so it is split exactly where the blend ends; only open
  water, flat at every level, is split later.
  The predicted point ahead of a moving camera only preloads cells (`Ticket.preload`): what is drawn follows the
  viewer alone.
- URL hash: `#lod=smooth&px=2&cells=800`. It combines with `cam=free`, `src=main` and `src=files`.
- The overlay gains a line: the tolerance, the wanted cells against the budget, and the detail in use (below 100 %
  while the budget holds it down).
- `L` shows the levels as before; fly or zoom slowly towards the ground to watch a level change.

### Depth modes, origin on all axes and the precision scene

Three more keys in the URL hash, all off by default (`src/precision-scene.ts`):

- `depth=reversed` or `depth=logarithmic`: the renderer's depth mode (default `standard`). `reversed` falls back to
  `logarithmic` where the browser lacks `EXT_clip_control`; the overlay shows the mode in effect. Works with every view.
- `origin=all`: the render origin follows the height of the camera too (default `horizontal`). It matters with the free
  camera, the only one that changes its height.
- `scene=precision`: the test scene. It switches the free camera on, starts 1,000 km from the world origin and 400 km
  above the surface, and defaults to `depth=reversed&origin=all`. A cube with a rod through it stands 1 m in front of
  the start pose (`P` puts it in front of the camera again); a group of peaks on a plateau, with tiles 25 m above the
  plateau, stands 1,000 km away along the start heading.

What to compare:

| URL hash | Expected |
| --- | --- |
| `#scene=precision` | Cube and peaks both visible; nothing shakes while turning or creeping; the tiles do not flicker. |
| `#scene=precision&depth=logarithmic` | The same image through the fallback. |
| `#scene=precision&depth=standard` | The cube is cut away by the near plane (the far : near ratio is at most 2000). |
| `#scene=precision&origin=horizontal` | The cube jumps in steps of a few centimetres when the camera moves or turns. |

Shot presets in this mode: `precision` and `precision-turned`
(`node shot.mjs --url http://127.0.0.1:5281/endless/ --hash scene=precision`).

### Shadow modes

`#shadows=cascades` or `#shadows=snapped`, off by default (without the key the renderer gets the options it always had).

- `cascades`: four maps around the eye in one shadow texture, the first reaching 48 m, the last as far as the shadow
  distance (2,500 m). Shadows are sharp at the feet and still there on the far ridges; each map is kept until the eye
  has moved a sixteenth of its edge. Made for `cam=free`; it works with the orbit camera too.
- `snapped`: one map fixed to the world's texel grid around the centre of the view, kept while neither the sun nor
  the scene changes; a move draws only the border it uncovers.
- The overlay gains a line: the mode, the map size, how many parts of the map the last frame drew (0: all kept) and
  the cost of the shadow pass. While cells stream in, or the hour runs, every map is drawn anew each frame.
- It combines with every other key, for example `#cam=free&shadows=cascades&depth=reversed`.

### Strips (`#strip=1`)

`#strip=1` adds strips laid along broken lines over the ground, with the engine's strip tools (off by default; the
default page serves baked cells of the plain generator). It implies `lod=smooth` and cells from the workers (or
`src=main`; baked files hold no strips).

- `src/strips.ts`: `endlessStrips(seed)` is a line about 6 km long from near the start place, whose far end is a node
  from which two lines of 2 and 1.5 km leave (half-widths 8 and 5 m), a pure function of the seed. The grade is the
  ground smoothed along the line, at least 1.5 m above the water and at most 6 m from the ground.
- `generateStripCell` is `generateSmoothCell` through its hooks (`buildSmoothCell` in `terrain.ts`): the ground cut
  and filled under the strips with `stripCarve`, no objects on the shoulders, the shoulders tinted as bare ground, and
  the strip mesh as a second mesh of material `strip` (domain version 2). A cell no line reaches is the smooth cell
  under that domain version. `src/strip-cell-worker.ts` runs it in the workers.
- The strip material (`STRIP_MATERIAL` in `shaders.ts`) blends with the surface (`cellMorph`) and keeps the strip at
  least 1.6 pixels wide.
- Presets `strip-far` (the main line out to the far cells), `strip-near` (the node from close by) and `strip-levels`
  (level tints over the main line).

### Damage in streamed cells (`#dmg=1`)

`#dmg=1` scatters destructible structures over the ground and keeps what was destroyed when cells leave and come
back (off by default; not together with `#strip=1`). It implies `lod=smooth` and cells from the workers (or
`src=main`; baked files hold no structures).

- `src/structures.ts`: structures are owned by home cells of level 9 (128 m), about one in three, 24 m inside the
  cell, on ground at least 2 m above the water, nearly level and away from the pillars. Each is a ring of blocks in four to six tiers
  on a plinth, described for the engine's destruction (`StructureDesc`), a pure function of the seed and the home cell.
- The damage lives outside the cells, in a `CellStates` store of the engine. `generateDamageCell(seed, cell, edits)`
  draws the structures of every home cell at or under a cell of levels 7–9 in the state the edits text gives (the
  store's `text(cell)`), as a second mesh of material `structure` (domain version 3); coarser cells draw none, and no
  object stands within 12 m of a structure. `src/damage-cell-worker.ts` runs it in the workers.
- A click (a press that does not drag) hits the structure under the pointer within 400 m; the hit home cell and the
  ones the ceiling ruined are refreshed (`StreamedWorld.refresh`), and the cells swap their meshes without a gap.
  `R` clears the damage.
- The state is in the URL hash (`d=`, the store's text), so a reload brings it back. `cap=` sets the ceiling in units
  (default 2000); over it the largest structures become ruins, by the engine's fixed rule.
- The overlay shows the changed structures, the units against the ceiling, the store hash, the ruins the ceiling
  made and refused hits, and for the demo structure its state, how often its home cell was built, the hash of that
  content, which cell draws it and whether the cover changed during a swap.
- Presets `dmg-intact` (the demo structure of the seed), `dmg-hit` (the same after the two fixed events),
  `dmg-away` (30 km away; its cells are forgotten), `dmg-back` (back: the same picture and hash as `dmg-hit`),
  `dmg-far` (700 m) and `dmg-levels` (level tints, 400 m).

### Volumetric clouds and their shadows (`#vol=0` switches them off)

The clouds are the engine's volumetric clouds (`createEngine({ cloudVolume: true })`): heaped clouds from 1.5 to 4 km
above the plane, with light through them, in place of the sky's flat deck. Their shadows on the ground come from the
engine's cloud shadow texture (`cloudShadows: true`), so they lie under the clouds that are drawn, and rain falls only
under a cloud (`w=rain`). They follow the weather's cloud cover (`w=clouds`, `w=rain`, …) and the hour; `w=clear`
(the default) has none and costs nothing extra. The orbit camera reaches up to about 4 km, into the layer.

`#vol=0` switches both off: the sky's flat deck and the cloud shadows computed per fragment, as before. On an Apple
M4 Pro at 2560 × 1440 (`__wh.benchmark(60)`, frozen time, `w=clouds`) a frame cost the same at `origin`, 0.2 ms more
looking low over the lake toward the clouds (2.15 ms against 1.95 ms) and 0.3 ms less looking down from 1.4 km (1.6 ms
against 1.9 ms), where the texture is cheaper than the computed shadows. The cost of the clouds themselves is in the
engine's documentation (`docs/environment.md`, "Volumetric clouds").

### Sphere world (`sphere.html`)

A second page of the same dev server: <http://127.0.0.1:5281/endless/sphere.html>. It is its own entry (`src/sphere-main.ts`),
so the page above is not touched by it. A sphere of radius 100 km: the `SphereWorld` shape (six quadtrees on a cube),
terrain from 3D noise sampled on the sphere (no seam, no pole), a free camera that takes up from the shape, the render
origin on all three axes, reversed depth, blending between levels and culling behind the horizon.

- Keys: `W` `A` `S` `D`, `E` / `Q`, drag, wheel (the free camera); `1` far view from 180 km, `2` down to 3 m above the
  surface; `[` `]` hour; `L` tint by level; `H` overlay.
- URL: `#seed=7&lat=35&lon=20&alt=180000&yaw=0&pitch=89&hour=13`. `alt` is metres above the surface, `pitch` 89 looks
  straight down. `depth=logarithmic` (default `reversed`), `horizon=0` (horizon culling off), `src=main` (generate on
  the main thread), `px` (tolerance in pixels, default 2), `cells` (budget of cells, default 900), `levels=1`.
- Files: `src/sphere-world.ts` (the generator: heights, colours and the rules for objects, all functions of the point on
  the sphere), `src/sphere-shaders.ts` (materials that use `localUp` and `localFrame`), `src/sphere-cell-worker.ts`.
- `atm=1` (default off) switches the engine's atmosphere on (`createEngine({ atmosphere })` with the default air
  fitted to this sphere by `atmosphereFor`): the sky is the light scattered in a shell of air, the same from the
  ground, in flight and from orbit, where the shell shows as a rim and the line between day and night crosses the
  sphere; the terrain and the objects get the air in front of them and the light of their own place. The sun stands
  where the hour puts it over the turning sphere (`sphereSunDirection`, `Environment.observer`). `air` sets the
  thickness of the shell in metres (default 30000).
- `cover=1` (default off) switches the distant content on: cells are generated with the baked cover of the surface
  (what the conifers look like from afar and how much of the ground they hide, `surfaceCover`), the terrain mixes it
  in where the conifers are no longer drawn, and the conifers leave one by one across the blend band of level 10
  instead of all at once. Both options combine with every other key.
- Objects (pillars from level 5, conifers from level 10) stand along the local up of their base anywhere on the
  sphere; their record holds only the base and a turn about that up.
- The overlay shows how many cells the horizon hides.
- Limits: without `atm=1` the sky is a plain colour (the sky layer assumes up along +y) and there is one sun
  direction for the whole sphere; shadows use the default single map with a reach of 4 km, and `vite build` builds only `index.html`.

## Baked cells

```sh
docker compose exec -T dev sh -c 'cd /app/examples/endless && pnpm bake --seed 7 --x 0 --z 0'
docker compose exec -T dev sh -c 'cd /app/examples/endless && pnpm verify --seed 7'
docker compose restart dev   # Vite lists public files at start-up
```

`bake` runs the streaming manager headless over a grid of viewers around (x, z) (`--steps`, `--spacing`,
`--altitude`) and writes every cell it would request to `public/cells/<seed>/<face>/<level>/<x>/<y>.whc` (ignored by
git). `verify` checks that each file equals the generator's bytes and re-encodes to itself. Then open
`#src=files&seed=7`. A missing file is a failed job; the manager retries it later and keeps the coarser parent.

Cells of smooth levels are baked and verified with `--smooth` (`pnpm bake --seed 7 --smooth`, `pnpm verify --seed 7
--smooth`). They go to `public/cells/<seed>/s<shape hash>/…`, next to the plain ones, and are read with
`#src=files&lod=smooth`. The plan is made for a 1080 pixel high view; a larger view asks for cells that were not baked.

## Screenshots

`__wh` supports the shot tool (`settled()` waits until every wanted cell is drawn). Presets: `origin`, `far`,
`far-close`, `flight` (a fast flight frozen mid-way, with level tint and overlay) and `night`; with `#strip=1` also
`strip-far`, `strip-near` and `strip-levels`; with `#dmg=1` also `dmg-intact`, `dmg-hit`, `dmg-away`, `dmg-back`,
`dmg-far` and `dmg-levels` (in this order: `dmg-back` checks what `dmg-hit` left). `__wh.hash()` returns the URL hash of the current view.

Pictures in Docker, without a browser on the host (the `shot` service of the repository, profile `tools`):

```sh
docker compose run --rm shot --url http://dev:5281/endless/ --hash 'strip=1' --presets strip-far,strip-near,strip-levels
```

```sh
cd tools/shot
node shot.mjs --url http://127.0.0.1:5281/endless/ --out /tmp/endless --format jpeg
```
