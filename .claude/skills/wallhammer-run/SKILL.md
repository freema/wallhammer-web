---
name: wallhammer-run
description: Start, stop and inspect the Wallhammer Web dev container and the example pages through Docker, build the live demos, and take pictures or measure the frame cost of a page (software renderer in Docker, real GPU on the host). Use when the user wants to run or see an example, check whether the container is up, read its logs, restart it, build or check the live demos, take a picture of a page or measure how much a frame costs. Typical requests "run the examples", "start an example", "how do I run it", "it does not run", "show the logs", "restart it", "where do I open it", "is docker running?", "build the demos", "is the live demo up?", "take a screenshot", "how does it look on the GPU", "how many ms is a frame", "is it faster now?".
---

# Run Wallhammer Web

Everything runs in Docker from the repository root (where `docker-compose.yml` is). Never install Node or packages on the host. Only the real-GPU tools (last sections) run on the host.

## Commands

```sh
docker compose up -d                  # one service, dev: installs dependencies, then serves every example
docker compose ps                     # status; dev should say "(healthy)"
docker compose logs --tail 50 dev     # recent log of the container
docker compose restart dev            # reinstall dependencies and restart the example server
docker compose down                   # stop (the dependency volumes stay)
```

Another host port: `EXAMPLES_PORT=5291 docker compose up -d` (5280 is left to the app of the city repository).

## Pages

- http://localhost:5281/ lists the examples; http://localhost:5281/<name>/ serves `examples/<name>`: `minimal-3d`, `destruction`, `endless` (second page `/endless/sphere.html`), `planet`, `system`, `fantasy-village`, `walk`, `outpost`, `rivers`.
- The live demos, built from `main`: https://freema.github.io/wallhammer-web/ and `/wallhammer-web/<name>/`.

Check that a page answers (prints `200`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5281/planet/
```

## What happens on start

The `dev` container runs `scripts/dev-entrypoint.sh`: `pnpm install --frozen-lockfile`, then `node tools/serve/serve.ts`, one HTTP server on port 5281. Each example gets its own Vite dev server (its `vite.config.ts`) in middleware mode with the base `/<name>/`, started on the first request for it. `dev` is healthy once the install is done and the server answers `/__health`. The examples import the engine (`packages/wallhammer-web`) through the pnpm workspace.

Source edits need no restart; the page reloads. Restart only after a change of dependencies, and update `pnpm-lock.yaml` first: `docker compose exec -T dev sh -c 'cd /app && pnpm install --no-frozen-lockfile --store-dir /pnpm-store'`. When the install fails, the container stays up without serving pages and the health check stays red; fix it inside (`docker compose exec dev sh`), then `docker compose restart dev`.

The index comes from `tools/serve/examples.ts`, shared with the static build: every folder in `examples/` with `index.html`, titled by its `<title>`, described by `description` in its `package.json`, with its other `.html` pages linked. A new example shows up by itself, but Docker needs a `node_modules` volume for it in `docker-compose.yml` (one line under `dev`, one under `volumes:`) and its directory in `Dockerfile.dev`, otherwise Docker creates the folder as root and the install fails. The rest of a new example (Vite config, workers): skill `wallhammer-extend`.

## Live demos

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm build:examples'                              # base /
docker compose exec -T dev sh -c 'cd /app && WH_PAGES_BASE=/wallhammer-web/ pnpm build:examples'  # as on GitHub Pages
```

`tools/pages/build.ts` builds each example with its own `vite.config.ts` into `dist-pages/<name>/` (ignored by git, `WH_PAGES_OUT` for another folder) and writes the index. Last line: `[pages] N examples under <base> in dist-pages/, … MB, … s`. Files an example's `.gitignore` keeps out of `public/` (the baked cells of `endless`) are left out.

`.github/workflows/pages.yml` runs the same build on a push to `main` that touches `examples/`, `packages/`, `tools/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or the workflow, and deploys it. By hand: `gh workflow run pages.yml`; status: `gh run list --workflow pages.yml --limit 3`.

## Pictures in Docker (software renderer)

The one-off `shot` service (profile `tools`, not started by `up`; it starts `dev` when needed) opens a page in headless Chromium on SwiftShader. Use it only to see whether a page starts without a WebGL error and whether the layout is right; it says nothing about colour precision or speed.

```sh
docker compose run --rm shot --url http://dev:5281/planet/ --presets @hash --size 960x540 --timeout 120000
```

Pictures go to `tools/shot/out/` (ignored by git). Last line: `shot: N pictures, M page errors`. One picture per page and a `--timeout` are enough. Options: header of `tools/shot/page-shot.mjs`.

The one-off `shaders` service (same image and profile) compiles and links every program the pages make instead of taking pictures: `docker compose run --rm shaders [--pages planet,walk] [--url …]`, last line `shaders: N programs on M pages, K failed, E page errors` (skill `wallhammer-verify`).

## Real GPU on the host: pictures and frame cost

The look and the frame times are judged only on the real GPU: the host's headless Chrome with `--enable-gpu --ignore-gpu-blocklist --use-angle=metal`, driven through `puppeteer-core` from `tools/shot/node_modules` (outside git, already installed; if it is missing, ask the user rather than installing on the host). Write the script in the scratchpad (or `internal/`), never in a tracked folder:

```js
// <scratchpad>/gpu.mjs; run with `node <scratchpad>/gpu.mjs` while dev is up
import { createRequire } from 'node:module';
const REPO = '/absolute/path/of/the/repository';
const puppeteer = createRequire(`${REPO}/tools/shot/package.json`)('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 }); // fixed size and pixel ratio
await page.goto('http://127.0.0.1:5281/walk/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__wh !== undefined, { timeout: 120000 });
await page.evaluate(async () => {
  const wh = window.__wh;
  await wh.ready;
  wh.setView(wh.presets().find((v) => v.name === 'steps'));
  await wh.settled?.();
});
await page.screenshot({ path: '<scratchpad>/walk-steps.png' });
console.log(await page.evaluate(() => window.__wh.stats().renderer)); // must name the GPU, not SwiftShader
console.log(await page.evaluate(() => window.__wh.profileText(20)));
await browser.close();
```

On the first open of an example the dev server may bundle dependencies and reload the page; retry the wait if the page context is destroyed (as `page-shot.mjs` does).

Every page exposes `window.__wh`. Read the object at the end of the page's `src/main.ts` (`src/sphere-main.ts` for `endless/sphere.html`) before relying on a member; as a guide:

| Member | Pages |
| --- | --- |
| `ready`, `presets()`, `setView(v)`, `getView()`, `stats()` | all |
| `settled()` | all but `destruction` and `minimal-3d` (wait two frames there) |
| `setTimeOfDay(h)` (hour), `setTime(s)` (freezes animation time) | `setTime` all but `walk`; `setTimeOfDay` all but `walk` and `outpost` |
| `profile(n)`, `profileText(n)` (frame and per-layer cost) | `walk`, `outpost`, `fantasy-village` |
| `measureFrame(n)` (ms of a frame, GPU work finished) | `planet`, `system`, `rivers` |
| `benchmark(n)` | `minimal-3d`, `endless`, `destruction` |
| `hold(input, s)`, `freeze(on)`, `walkTo`, `teleport`, `state()`, `setWire(on)`, `stations()` | `walk` |
| `kind` (a name of the page's kind, read by `tools/shot/shot.mjs`) | all |
| `hash()` (the URL hash of the current state) | `planet`, `endless`, `fantasy-village`, `walk`, `outpost` |
| `isSettled()` (the synchronous form of `settled()`) | `endless` (both pages), `planet`, `system` |
| `setTick(n)` (the simulation's tick) | all but `destruction`, `fantasy-village`, `walk` and `rivers` |
| `setWeather(w)` (a preset name, as `w` in the hash) | `minimal-3d`, `destruction`, `endless` |
| `hud()` (the text of the panel), `overlay()` (the debug overlay) | `hud`: `destruction`, `endless`, `planet`, `system`, `fantasy-village`, `walk`; `overlay`: `endless` (both pages), `planet`, `system` |
| `startFlight()`, `stopFlight()`, `setFlight(t)`, `flightSeconds()`, `flightReport()` | `planet`, `system` |
| `startRiverFlight()`, `setRiverFlight(t)`, `planHash()`, `routes()`, `strike(…)`, `damageHash()` | `system` |
| `setClouds(on)`, `weather()` (the frame's weather and that under the eye), `setAirReference(on)` | `planet` |
| `movieLength()`, `movieShots()`, `startMovie(t)`, `stopMovie()`, `movieFrame(t, warm)` | `planet` |
| `movie.start()`, `movie.stop()`, `movie.active()`, `movie.seek(t)`; `walk.start()`, `walk.stop()`, `walk.active()`; `setEvening(on)`, `inspect(filter)` | `fantasy-village` |
| `blast`, `blastAtScreen`, `reset`, `setState`, `debrisAt`, `collapseAt`, `falling`, `structures`, `regenCost` | `destruction` |
| `rigs` | `minimal-3d` |
| `checks()` (the water plan's numbers: lines, lakes, falls, stretches where a level rises), `mode()`, `setMode('orbit'\|'free')` (orbit or free flight, `F` or `#free`), `freeState()`, `progress()` (the loading `ProgressReport`) | `rivers` |
| `resetCamera()`, `setPaused(on)`, `tick()`, `inspect(filter)` | `outpost` |

Movie modes. Two pages have one, with different members; both hold the movie at a time `t` for a frame-by-frame recording:

- `planet` (7 shots, about 89 s): `await __wh.movieFrame(t, warm)` sets the camera, the hour and the animation time, renders until the streaming has settled and `warm` (32) more frames, and resolves with `{ shot, u, dark, settled }`. Take the picture after it resolves. `startMovie(t)` and `stopMovie()` play by the clock (key `M`, `#movie=1`).
- `fantasy-village` (a tour of 45 s): `__wh.movie.seek(t)` shows the tour at `t`; then `await __wh.settled()`. `movie.start()` and `movie.stop()` play it (key `M`, `#movie=1`).
- `system` has no movie members: `#movie=1` (key `V`) is a clean screen over its tour.

Presets of note in `planet` (`presets()` returns only those whose place exists for the seed): `planet-surface`, `planet-low`, `planet-limb`, `planet-whole`; `clouds-8km`, `clouds-below`, `clouds-rain`, `clouds-rain-8km`; `sea-above`, `sea-crossing`, `underwater`, `underwater-up`, `underwater-deep`. `#view=<name>` in the hash opens one.

Frame cost:

- Headless Chrome caps presentation at 30 fps, so measure cost per frame from synchronous renders (`profileText`, `measureFrame`, `benchmark`, or `tools/bench/bench.mjs`), never fps.
- Compare only A/B: same machine, same session, same fixed size and `deviceScaleFactor`, same view and frozen time. Alternate A and B a few times and compare medians; a difference within the spread is noise. One browser at a time.
- Report the GPU name, the size and pixel ratio, the view, and both medians.

Ready-made host tools: `tools/bench/bench.mjs` (pages `destruction`, `endless`, `village`; `profile --page village` calls `__wh.profile()`; results in `tools/bench/out/`, ignored) and `tools/shot/shot.mjs` (fixed views of the city app on port 5280; of the examples only an orbit page such as `minimal-3d`). Headers of both files list their options.

## When it does not start

- `docker compose ps` shows `dev` not healthy: read `docker compose logs --tail 50 dev`.
- Port 5281 is taken: another checkout may serve on it; stop those containers or use `EXAMPLES_PORT`.
- Other agents may be editing source at the same time. A transient error in files you did not touch is not yours to fix.

## Do not

- Do not run host tools unless the task needs the real GPU's look or timing.
- Do not leave temporary scripts, pictures or measurements in tracked paths: scratchpad, `internal/`, `tools/shot/out/` or `tools/bench/out/` only.
- Do not commit, push or publish unless the user asks (releases: skill `wallhammer-release`).

Docs: `packages/wallhammer-web/docs/getting-started.md`, `packages/wallhammer-web/docs/tools.md` (screenshots, benchmarks, frame profile).
