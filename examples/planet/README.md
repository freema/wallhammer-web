# Planet example

A flight from the surface of a small planet up to where the whole sphere is in view, and back. The planet is a
sphere 100 km in radius with terrain from noise in space, trees and rocks near the ground, an atmosphere and a sun
that stands where the hour puts it. The page joins the engine's large-scale options in one scene: the sphere world
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
- The line at the bottom always shows the height, the speed, the patches drawn, the time of a frame and the GPU
  memory.

URL hash (kept up to date while flying by hand):
`#seed=2611&lat=..&lon=..&alt=3&yaw=..&pitch=3&hour=..`

| Key | Default | Meaning |
| --- | --- | --- |
| `seed` | 2611 | Seed of the terrain. Without `lat` and `lon` the start place is found from it. |
| `lat`, `lon`, `alt` | from the seed, 3 | Degrees on the sphere (the poles are on the y axis) and metres above the surface. |
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
| `view` | none | Starts in one of the strip views of `__wh.presets()`, for example `strip-node`. |

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
  bare ground, and a second mesh of material `strip` (domain version 2). A cell no line reaches is the plain cell
  under that domain version. `src/strip-cell-worker.ts` runs it in the workers.
- `STRIP_MATERIAL` (`shaders.ts`) blends with the surface and keeps the strip at least 1.6 pixels wide.
- Views of `__wh.presets()`: `strip-orbit`, `strip-edge-20km`, `strip-edge-levels` (level tints), `strip-900m`,
  `strip-surface`, `strip-node`. `__wh.hash()` returns the URL hash of the current view. Pictures in Docker:

```sh
docker compose run --rm shot --url http://dev:5281/planet/ --hash 'strip=1' --presets strip-orbit,strip-node
```

## Files

| File | What |
| --- | --- |
| `src/world.ts` | The planet: constants, the height and colour of the surface, the cover, the rules of the objects, `generatePlanetCell`, `findStart`. Pure, runs in Node and in a worker. |
| `src/shapes.ts` | Unit meshes of the tree and the rock. |
| `src/shaders.ts` | The two materials (surface and objects). |
| `src/flight.ts` | The flight: `flightPose(plan, radius, t)`, a pure function of time. |
| `src/flight-check.ts` | The flight run through the streaming manager without a browser; the streaming configuration shared with the page. |
| `src/main.ts` | The page: engine, streaming, flight driver, line and panel, script interface `window.__wh`. |
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
object in exactly one child cell), the flight (ends where it starts, the top shows the whole sphere, the height
changes by less than 2 % per frame at 60 Hz, the way down mirrors the way up) and the streaming along the flight with
the real generator (the sphere covered exactly once at every step, the budget of cells held, an estimate of the GPU
memory against 600 MB). The golden test of the workspace holds the same checks as "planet example cells" and "planet
example flight".
