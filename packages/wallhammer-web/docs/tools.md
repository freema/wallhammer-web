# Tools

Dev tools live in `tools/`. Run the checks inside the `dev` container from the repository root. The workspace root is `/app` there.

| Command (in `/app`) | What it checks | Exit code |
| --- | --- | --- |
| `pnpm typecheck` | Types of every workspace package (each package's `typecheck` script). | non-zero on a type error |
| `pnpm check:layers` | Module layers and boundaries ([Architecture](architecture.md#what-pnpm-checklayers-enforces)). | 1 on any violation |
| `pnpm check:layers:test` | The layer check against its good and bad fixtures. | 1 if the check misbehaves |
| `pnpm test:golden` | Output hashes of the engine's generators and deterministic systems (`tools/golden/engine/`), then of those that need example code (`tools/golden/`). `pnpm test:golden:engine` and `pnpm test:golden:examples` run one set. | 1 on `CHANGED` or `MISSING` |
| `pnpm check:docs` | This documentation: code samples, links, entry names. | 1 on any finding |
| `pnpm check:pack` | The package as it would be published: it packs, installs into an empty project, loads in Node and type-checks. | 1 when a step fails |
| `pnpm check:mesh` | The mesh builder core and the bare shapes in plain Node: vertex and index counts, closed shapes (every edge twice, once each way), outward winding (positive volume near the analytic one), mirroring flips the winding, `append` keeps payloads, two different vertex formats, determinism (`tools/mesh/check.ts`; see [Generators](generators.md#building-meshes-in-your-own-vertex-format)). | 1 when a case fails |
| `pnpm check:motion` | The motion module in plain Node on made-up bone chains: blends and masks, automatic weights, transitions, marks and events, reach and ground fit, saved state, determinism, layer stacks, processor time for many figures (`tools/motion/check.ts`; see [Motion](motion.md)). | 1 when a scenario fails or the run takes over 5 s |
| `pnpm check:walk` | The collision world, the walker and the movement example's course in plain Node (comes with the examples, `tools/walk`). | 1 when a scenario fails |
| `pnpm check:follow` | The following view (`FollowRig`) in plain Node: the boom cut to the clearance, its smooth return, the pivot reaching its target, `forward` against the heading, first person, the cached key, processor time per frame (comes with the examples, `tools/follow-check`; `runFollowChecks()` is exported for other check scripts). | 1 when a case fails |

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers'
```

## Layer check

`tools/layers/check.ts`. Output ends with `layers: N violation(s)`. Each finding names the rule id, the file and the import. Options: `--root <dir>` checks another tree (used by the fixtures), `--list` prints every module with its layer.

Fix a finding by moving code, not by adding an exception. There is no exception list.

## Golden hashes

`tools/golden/engine/golden.ts` runs small fixed recipes, each through one generator or deterministic system, hashes the output bytes and compares with `tools/golden/engine/hashes.json`. A generator is pure, so a difference is a real change in output.

Output: one line per recipe, `ok <name>`, `CHANGED <name>: … (old → new)` or `MISSING <name>`, then `golden: N of M generators unchanged`.

The recipes import engine sources by relative path. Scenarios that are too long for one line live next to it in `tools/golden/engine/`: `sim-scenario.ts`, `behaviour-scenario.ts`, `destruction-scenario.ts`, `frames-scenario.ts`, `depth-scenario.ts`, `tiles-scenario.ts`, `flow-scenario.ts`, `shadow-scenario.ts`.

Recipes that need the code of an example (the streaming generator of the endless example, the sphere, the planet and the system) are not here. They live in the golden test of the examples one folder up (`tools/golden/golden.ts`, with `streaming-scenario.ts`, `sphere-scenario.ts`, `planet-scenario.ts`, `system-scenario.ts` and its own `hashes.json`). The same rules apply to both. A change to the engine is checked against both sets.

### Add an entry

1. Add a recipe to the `RECIPES` map in `golden.ts`: a name and a function that returns `hash(...)` over the output arrays.
2. Run the test. It prints `MISSING <name>` with the new hash and exits 1.
3. Store it: `docker compose exec -T dev sh -c 'cd /app && node tools/golden/engine/golden.ts --accept'`.
4. Run the test again. It must pass.

Keep inputs small and fixed. Do not read data files from outside the tool's folder; the test must run from a clean checkout.

### When re-accepting is legitimate

`--accept` rewrites **every** hash at once, not only the changed one. Before running it:

- Run the test without `--accept` and read which recipes changed.
- Accept only when every `CHANGED` line is an output change you intended. Then look at the result in the browser or with screenshots, and commit `hashes.json` together with the code change.
- Do not accept when a recipe changed that your change should not touch. That is a regression or hidden nondeterminism (for example `Math.random` in a generator, or iteration order of a `Map` built from unordered input).
- Do not accept to silence a flaky result. A golden recipe must give the same hash on every run.
- A refactor that should not change output must leave all hashes unchanged.

## Docs check

`tools/docs/check.ts` reads `packages/wallhammer-web/README.md` and every `.md` under `packages/wallhammer-web/docs/`.

- **Code.** Every ` ```ts ` block is written to a temporary file and type-checked with the package's `tsc`, strict, with imports resolved like the package exports. Unused locals are allowed. An HTML comment on the line before the fence changes this: `<!-- check: wrap -->` treats the block as a fragment (imports stay on top, the rest becomes a function body; declare what the fragment uses with `declare const x: T;`), `<!-- check: skip -->` skips it. Use `sh` or `text` fences for shell and layouts.
- **Links.** Every relative link must point to an existing file. A `#anchor` into a Markdown file must match one of its headings. This rule alone also runs over the other Markdown files of the repository: the root `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CLAUDE.md`, every `examples/<name>/README.md` and every skill.
- **Entries.** Every `wallhammer-web/<subpath>` in the text must be an export of the package.
- **Reference.** Every name in the `export { … }` lists of an entry's `index.ts` must be named in `reference.md` (finding `[reference]`).

`node tools/docs/check.ts --keep` keeps the generated files and prints their folder, for debugging a failing sample.

If the package source itself has a type error, the samples cannot be checked; such findings say "in the package source, not a sample". Fix the package (or wait for whoever is editing it) and run again.

What it does not check: that samples run, that GLSL inside samples compiles (the [Shader check](#shader-check) compiles the programs a page makes, not samples), or that prose is true.

## Walking check

`pnpm check:walk` (`tools/walk/check.ts`) comes with the examples, because it walks the course of the movement example. It checks the collision world, the walker (`tools/walk/walker-scenarios.ts`: wall, corner, steps, slopes, jump and ceiling, fall, thin wall, determinism, a solid that appears, CPU time), the follow camera, and the stations of the movement example's test course (`tools/walk/course-scenarios.ts` over `examples/movement/src/course.ts`, walked by the same `driveTo` as the page's `__wh.walkTo`) in plain Node, prints one line per scenario (`ok`, `FAIL`, or `slow` for a CPU-time measurement that missed its target, which does not fail the run) and exits 1 when a scenario fails or the run takes over 5 seconds. `node tools/walk/check.ts <text>` runs only the scenarios whose name contains the text.

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm check:walk'
```

A package of scenarios is a file `tools/walk/<package>-scenarios.ts` exporting an array of `Scenario` (`tools/walk/scenario.ts`: a unique name, an optional `kind: 'timing'` and `run()` returning `{ ok, detail }`), imported in `check.ts` and appended to its `PACKAGES`. See [Walking](walking.md).

## Mesh checks

Checks of built geometry without a browser, in `wallhammer-web/tools`, for a project's own inspection script (plain
Node, they allocate):

- `meshParts(positions, indices, { heightAt, label?, stride?, transform?, weld? })` splits a triangle mesh into
  connected parts (triangles sharing a vertex, or vertices within `weld`, default 1 cm, of each other). Each
  `MeshPart` has its world bounds, its lowest `gap` over the ground and where (`at`), its vertex count and `label`.
- `floatingParts(parts, { groundTolerance?, touchTolerance? })` returns the parts that hang in the air: neither within
  `groundTolerance` (5 cm) of the ground nor touching (bounds within `touchTolerance`, 2 cm), directly or through a
  chain, a part that is. Pass the parts of every mesh that may hold another up.
- `routeClearance(world, route, { closed?, step?, minY?, maxY?, ignore? })` samples a route (x, z pairs) every `step`
  (25 cm) and returns the least horizontal distance to the side of a solid of a `CollisionWorld` (negative: inside),
  with the point, the solid's id and tag. `minY`/`maxY` keep only solids that overlap the walking body's height;
  `ignore(id, tag)` leaves some out.

<!-- check: wrap -->
```ts
import { CollisionWorld } from 'wallhammer-web/world';
import { floatingParts, meshParts, routeClearance } from 'wallhammer-web/tools';
declare const positions: Float32Array;
declare const indices: Uint32Array;
declare const heightAt: (x: number, z: number) => number;

const parts = meshParts(positions, indices, { heightAt, label: 'props' });
for (const p of floatingParts(parts)) console.log(`${p.label}: ${p.gap.toFixed(2)} m over the ground at ${p.at.join(', ')}`);

const world = new CollisionWorld({ heightAt });
world.addCylinder(5, 0, 0.5, 0, 2);
const near = routeClearance(world, [0, 0, 10, 0, 10, 10], { minY: 0, maxY: 1.8 });
console.log(near.distance, near.solid);
```

## Pack check

`pnpm check:pack` (`tools/pack/check.sh`) checks the package in the shape npm would get. It runs `pnpm pack` in `packages/wallhammer-web` (which builds `dist/` first: JavaScript and type declarations from `tsconfig.build.json`, and swaps the package's `exports` for the ones in `publishConfig`), installs the tarball into an empty project outside the workspace, imports every entry in plain Node and type-checks a small program against the packed declarations. It needs the network for the package's own dependency. Its last line is `ok: the packed package installs, loads and type-checks`.

In the workspace the package exports its TypeScript sources (`exports` → `src/`); only the packed package points at `dist/`. Publish with `pnpm publish`, not `npm publish`: only pnpm applies `publishConfig.exports`.

## Screenshots

`tools/shot/shot.mjs` takes reproducible screenshots of fixed views of the example pages. It runs **on the host**, not in Docker, because the real GPU decides the image. It drives the host's installed Chrome through `puppeteer-core` against the example pages that the `dev` container serves. Its own `node_modules` must be installed in `tools/shot/`.

```sh
cd tools/shot
node shot.mjs --url http://127.0.0.1:5281/minimal-3d/ --tod 13,21   # the minimal-3d example
```

Pictures in Docker, on the software renderer and independent of the host's graphics card, come from `tools/shot/page-shot.mjs` in the `shot` service (options in its header).

## Shader check

`tools/shot/shader-check.mjs` compiles and links the shaders of a page in headless Chromium on the software renderer (SwiftShader), with no graphics card. The engine checks a program only on its first use, so a broken shader of a program that is made but not drawn stays silent in the browser. The tool does not rely on the page: before the page's scripts run it wraps the WebGL2 calls that make programs, and after the load it asks the context for the compile and link status of every program made. It works for any page, also one that throws on the way. In this repository it is the compose service `shaders` (profile `tools`):

```sh
docker compose run --rm shaders                                # every example page the dev server lists, about 1 min
docker compose run --rm shaders --pages planet,movement        # only these
docker compose run --rm shaders --pages 'planet#strip=0'       # a page with a hash
docker compose run --rm shaders --url http://host:port/page/   # any page by its whole address
```

Options: `--base` (the examples' server, default `http://dev:5281`), `--pages`, `--url`, `--timeout` (one attempt at a page, ms, default 180000), `--wait` (after the page is ready, ms, default 1500). Each page runs in a browser of its own: the software renderer's GPU process is shared by the pages of one browser, and a page that draws more than it can render leaves work there that the next page would wait for (70–85 s were measured after `rivers`). Each page prints its time and phases (load, `__wh.ready`, programs read). A page that fails for a reason other than a broken shader (an exception, a console error, no program, over `--timeout`) is tried once more in a fresh browser and counts only when it fails again; a broken shader is not retried. A failed program prints its info log with the lines of the source it names. The last line is `shaders: N programs on M pages, K failed, E page errors (T s)`; the exit code is 1 when K or E is not 0. A full run takes about a minute, the `system` page about 11 s of it. CI runs it on every example page (`checks.yml`, job `shaders`).

Limits: only the programs a page makes with the options it starts with are seen; a program made later, by a key or a mode, needs a `#hash` that turns it on. Contexts made in workers are not seen. The GLSL is validated by Chromium's translator (ANGLE), the same in every Chromium, but a fault of one graphics driver's own compiler cannot show. It does not judge the look.

A project built on the package can run the script against its own dev server with `--url` (Node with `playwright-core` and a Chromium, as in `tools/shot/Dockerfile`).

Animation time is frozen at the given value, so the same input gives the same image. Pages expose a small script interface on `window.__wh` (views, time, weather, stats, benchmark) that the tool uses.

## Marks

Notes a developer pins to points of a dev page (key `N` in the planet example): the panel `installMarking` in `wallhammer-web/platform`, the dev-server store `marksStore` in `wallhammer-web/marks-store` (this repository keeps the records in `internal/marks/`) and the package's command-line tool `wallhammer-marks` (`list`, `set`); in this repository `tools/marks/list.mjs` and `set.mjs` run it with the repository's defaults, `shoot.mjs` takes after-pictures on the host GPU and `pnpm test:marks` checks the store and the tool on a scratch folder. See [Marks](marks.md).

## Benchmarks

`tools/bench/` measures cost per frame, startup, hitches, memory and streaming. Like the screenshot tool it runs on the host and reuses its `puppeteer-core` and Chrome. `bench.mjs` has the commands (`frames`, `counts`, `startup`, `hitches`, `memory`, `scale`, `shadow`, `hit`, `flight`, `profile`); `run-all.sh` runs the whole set one after another. Results go to `tools/bench/out/`, which git ignores. Headless Chrome caps presentation at 30 fps, so results are cost per frame from synchronous renders, never fps.

Do not run two browser tools at once; they compete for the GPU.

## Frame profile

`profileFrame(renderer, view, options?)` from `wallhammer-web/tools` answers "what is slow" with numbers, inside the page, on whatever graphics card the page runs on. It renders the current view synchronously, waits for the graphics after every frame (`Device.finish`, which reads one pixel and so blocks until the frame is done) and keeps the median of `frames` frames (default 20, after two warm-up frames) per measurement:

| Field | Measurement |
| --- | --- |
| `empty` | Only clearing and presenting the main target (no bounds, no layers). |
| `kept` | The current frame; the shadow map is kept as the renderer keeps it. `shadowFrames` says in how many frames it was redrawn anyway (a layer's `cullStale`, `invalidateShadows` from the app). |
| `shadow` | The current frame with the shadow map redrawn in every frame. |
| `running` | Only with `options.step`: `step(i)` advances the scene before every frame (clocks, extraction), so this is the frame of a moving scene with the shadow updates the motion causes. The step's own time is part of it. |
| `layers` | Per layer in drawing order: `name` (`Layer.name`, else the class name and the material name), `passes` it drew in, and for `color` (the main passes with `prepare`) and `shadow` its triangles, calls and `ms`: the frame time with the layer minus the frame time without it (`kept` for colour, `shadow` for the shadow pass). Every layer is measured, also one that does not count its draws (`DrawContext.count`); its counts are then 0. `ms` is null only with `options.layers: false`. |

Besides that the profile holds the target size in physical pixels, `dpr`, `samples` of the main target, `shadowMapEdgePx` and `shadowMapPx` (texture edge and the part in use), the GPU name, `syncMs` (the wait with nothing pending, included in every time), the `FrameStats` of a frame with the shadow map redrawn, and `spreadMs` (interquartile range) for every timing: a layer cost below the spread is noise and may even come out negative.

`formatProfile(profile)` returns the same as a fixed-width text table. A sample, given an app's renderer and view:

<!-- check: wrap -->
```ts
import type { View } from 'wallhammer-web/base';
import type { Renderer } from 'wallhammer-web/render';
import { formatProfile, profileFrame } from 'wallhammer-web/tools';
declare const renderer: Renderer;
declare const view: View;

const profile = profileFrame(renderer, view, { frames: 20 });
console.log(formatProfile(profile));
const worst = [...profile.layers].sort((a, b) => (b.color.ms ?? 0) - (a.color.ms ?? 0))[0];
```

Rules for reading it:

- The page is blocked while it runs: about `frames × (3 + 2 × layers)` frames plus warm-ups. `options.layers: false` skips the per-layer measurements (counts stay).
- Frames are waited for one by one, so a time is the frame's latency, processor and graphics in series. With the processor time per frame small (`cpuMs`), that is the graphics cost.
- Leaving a layer out changes only that layer's draws; culling runs as before. The shadow map is marked for a redraw at the end, so the next normal frame is whole again.
- Numbers from a software renderer (headless Chrome in Docker, SwiftShader) say nothing about a real graphics card. Profile in a browser on the machine in question.

It uses two renderer hooks that are idle in normal use: `Layer.name` and `Renderer.probe` ([Rendering](rendering.md#statistics-and-benchmarks)). An example exposes it on `window.__wh` (the fantasy village: `__wh.profile(frames?)` and `__wh.profileText(frames?)`), so a browser tool or a person in the console can call it. The host-side benchmark tool (`tools/bench`) patches the renderer from outside for per-pass timer queries; it names layers by `Layer.name` when set.
