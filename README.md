# Wallhammer Web

A web 3D engine in which the whole world is made by code: plain WebGL2, no graphics library, no loaded images. Strict TypeScript, modules in layers, a deterministic simulation, a streamed world from one house up to a solar system.

The repository is a pnpm workspace:

- `packages/wallhammer-web/`: the engine, npm package `wallhammer-web`. Its [`README.md`](packages/wallhammer-web/README.md) describes it, the documentation is in [`docs/`](packages/wallhammer-web/docs/) (code samples there are type-checked).
- `examples/`: example pages built on the engine. Each has its own `README.md`.
  - `minimal-3d`: a perspective orbit view of an island with standing stones. Engine only.
  - `destruction`: generated structures on plain ground that break part by part. Uses the content modules (`gen-arch`, `sim/destruction`).
  - `endless`: an endless streamed world in quadtree cells, generated in workers or read from baked files. Engine only. A second page, `sphere.html`, shows the sphere world.
  - `planet`: a flight from the surface of a small planet up to orbit and back. Engine only.
  - `system`: a sun and several bodies on orbits, with one continuous flight from the surface of one body to another. Uses the content modules for its structures and their destruction.
  - `fantasy-village`: a living fantasy village made by code (architecture, terrain, vegetation, villagers, smoke and fire, late afternoon to evening). Engine only, with its own content modules in the example. Engine layers draw it (`PieceLayer`, `InstanceSetLayer`, `PointLightSet`, `ParticleLayer`); it has only two materials of its own. Its `README.md` describes the measurement parameters of the address (`pr=`, `sh=`, `sky=`, `aa=`) and `__wh.profileText()`.
  - `walk`: a walking test course: a collision world, a walker and a follow camera.
  - `outpost`: a lunar research station in a comic look (flat colours, outlines, hard shadows). Engine only, with its own materials, a rover and astronauts on a skeleton.
- `tools/`: checks (`layers`, `golden`, `docs`, `pack`, `mesh`, `motion`, `walk`, `follow-check`), the example server (`serve`) with its Vite plugin (`vite`), pictures in Docker (`shot/page-shot.mjs`) and host tools (`shot/shot.mjs`, `bench`).
- `docker-compose.yml`, `Dockerfile.dev`, `scripts/dev-entrypoint.sh`: the dev container.
- `.claude/skills/` and `CLAUDE.md`: rules and procedures for working with an agent (running, checks, extending).
- `internal/`: internal working material, ignored by git (see [Internal notes](#internal-notes)).

## Running

Everything runs in Docker. The host needs Docker with `docker compose` and git, no Node.

```sh
docker compose up -d     # from the repository root
docker compose ps        # dev should be (healthy)
```

The one service `dev` installs the dependencies, serves every example on one port and stays up for the checks:

| Address | What |
| --- | --- |
| <http://localhost:5281/> | index of the examples |
| <http://localhost:5281/minimal-3d/> | `examples/minimal-3d` |
| <http://localhost:5281/destruction/> | `examples/destruction` |
| <http://localhost:5281/endless/> | `examples/endless` (second page: `/endless/sphere.html`) |
| <http://localhost:5281/planet/> | `examples/planet` |
| <http://localhost:5281/system/> | `examples/system` |
| <http://localhost:5281/fantasy-village/> | `examples/fantasy-village` |
| <http://localhost:5281/walk/> | `examples/walk` |
| <http://localhost:5281/outpost/> | `examples/outpost` |

In general `http://localhost:5281/<name>/` serves `examples/<name>`. Another host port: `EXAMPLES_PORT=5291 docker compose up -d`. Port 5280 is left to the app of the city repository. The service is healthy once the dependencies are installed and the server answers. Stop it with `docker compose down`.

How it works: after the install, `scripts/dev-entrypoint.sh` starts `tools/serve/serve.ts`, one Node process with one HTTP server. Each example has its own Vite dev server in it (with its own `vite.config.ts`), in middleware mode with the base path `/<name>/`. That server starts when the example is first opened, so examples nobody opens cost nothing (no file watching). Source edits reload the page. A restart (`docker compose restart dev`) is needed only after a change of dependencies. Dependencies live in named volumes; nothing is installed on the host disk.

A new example (a folder with `index.html`) shows up in the index by itself. It still needs a volume for its `node_modules` in `docker-compose.yml` and a directory in `Dockerfile.dev`.

## Checks

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'          # types of the engine and the examples; no error
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers'       # layers: 0 violation(s)
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers:test'  # ok: known-bad fixture fails with all 16 expected findings
docker compose exec -T dev sh -c 'cd /app && pnpm test:golden'        # golden: 72 of 72 …, then golden: 25 of 25 generators unchanged
docker compose exec -T dev sh -c 'cd /app && pnpm check:docs'         # docs: … 0 finding(s)
docker compose exec -T dev sh -c 'cd /app && pnpm check:mesh'         # check:mesh: 27/27 ok in … ms
docker compose exec -T dev sh -c 'cd /app && pnpm check:motion'       # motion: 26 of 26 scenarios ok, … ms
docker compose exec -T dev sh -c 'cd /app && pnpm check:walk'         # walk: N of N scenarios ok, … ms
docker compose exec -T dev sh -c 'cd /app && pnpm check:follow'       # N/N follow cases passed in … ms
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'         # ok: the packed package installs, loads and type-checks
```

- `check:layers` guards the module layers, the boundary between the engine, the content modules and the examples, and that WebGL is only in `gpu` and DOM only in `platform`. There are no exceptions.
- `test:golden` runs two sets of fixed recipes and compares the hash of each output with the stored one. First the engine alone (`tools/golden/engine/golden.ts`, hashes in `tools/golden/engine/hashes.json`), then the recipes that need example code (`tools/golden/golden.ts`, hashes in `tools/golden/hashes.json`); the second set runs only when the first passes. `test:golden:engine` and `test:golden:examples` run one set. To accept a deliberate change, run `node tools/golden/engine/golden.ts --accept` or `node tools/golden/golden.ts --accept` in the container. Each rewrites all hashes of its set at once, so read first what changed. Rules: [`docs/tools.md`](packages/wallhammer-web/docs/tools.md).
- `check:docs` type-checks the code samples in the documentation and checks the links.
- `check:mesh` and `check:motion` test, in plain Node, the mesh builder with bare shapes (`gen-mesh`) and the motion module (`motion`).
- `check:walk` tests, in plain Node, the collision world, the walker, the follow camera and the course of `examples/walk`. It fails also when the run takes over 5 s. `check:follow` tests the follow camera (`FollowRig`).
- `check:pack` checks the package in the shape it is published to npm (see below). It needs the network.

## Pictures

No check compiles the GLSL shaders. The one-off `shot` service shows whether a page starts in a browser without a WebGL error. It runs headless Chromium on the software renderer (profile `tools`, so `up` does not start it; it starts `dev` first when that does not run):

```sh
docker compose run --rm shot --url http://dev:5281/planet/ --presets @hash --size 960x540 --timeout 120000
```

Pictures go to `tools/shot/out/` (ignored by git). The last line is `shot: N pictures, M page errors`. The software renderer is slow: one picture per page and a `--timeout` are enough. The options are in the header of `tools/shot/page-shot.mjs`, the image is built from `tools/shot/Dockerfile`.

`tools/shot/shot.mjs` and `tools/bench/` run on the host instead, because the real graphics card decides the picture and the frame times. See [`docs/tools.md`](packages/wallhammer-web/docs/tools.md).

## npm package

In the workspace the package exports the TypeScript sources (`exports` → `src/`), so the examples see an engine change at once. The published package contains built JavaScript with type declarations (`dist/`), the documentation, `README.md` and `LICENSE`. `prepack` builds it (`tsc -p tsconfig.build.json`), and `publishConfig.exports` in [`package.json`](packages/wallhammer-web/package.json) swaps the entries.

Only `packages/wallhammer-web` is published. The examples are private workspace packages: they are never published and import the engine source through the workspace.

A person with an npm account publishes. Login and publishing run in the container; the host has no Node:

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'                          # check first
docker compose exec dev sh -c 'cd /app/packages/wallhammer-web && npm login'           # once; the login stays in the container
docker compose exec dev sh -c 'cd /app/packages/wallhammer-web && pnpm publish --no-git-checks'
```

- Publish with `pnpm publish`, not `npm publish`: only pnpm applies `publishConfig.exports`. A package from `npm publish` would point to `src/`, which it does not contain.
- Set the version beforehand in `packages/wallhammer-web/package.json` (now `0.4.0`). A version once published cannot be overwritten on npm.
- `--no-git-checks`: the container has no git, so pnpm cannot check the branch there. Check on the host beforehand that the working tree is clean and on `main` (`git status`).
- A new entry `wallhammer-web/<module>` is written twice: in `exports` and in `publishConfig.exports`. `check:pack` finds a missing twin.

## Origin

The engine started in the repository of the Ústí city model, in `web/packages/wallhammer-web`. This repository began as a hard copy of it at commit `aba73fe` (version 0.4.0, including walking through the world) and is now the only place where the engine is developed. After that, work left unfinished in the city repository on top of this version moved here as well: the motion module `motion` (skeletons, poses, motion graph), the mesh builder with bare shapes (`gen-mesh`), 3×4 matrices (`base`), bone-driven instances (`render`), solid bodies from meshes and saved walker state (`world`), and the checks `check:mesh` and `check:motion`.

The examples and their tools were developed in a sibling folder that mounted the engine from the city repository. They now live here too.

The golden hashes guard the copy: the 72 engine recipes give the same hashes here as in the original repository. Four recipes there depended on code of the city app (people, vehicles, stops, landmark buildings) and stayed with the app.

## Copy in the city repository

The Ústí city model repository keeps a hard copy of version 0.4.0 in `web/packages/wallhammer-web` for its app and may change it for its own needs. So that the two copies do not drift apart unseen, a rule applies there: every change to that copy is also sent here as an issue or a pull request (what changed, why, a link to the commit). This repository decides whether the engine takes it over, and the answer goes into the same issue. In the other direction, a newer engine is taken into the city repository only deliberately, in one pull request with the checks of that repository.

The two copies are synchronised by hand, never automatically, and only when the owner asks for it. Work in this repository does not edit the city repository.

## Internal notes

`internal/` at the repository root is ignored by git, as are files named `*.local.md`. Internal working material goes there: notes, plans, research, reports and drafts. It is never committed.

## Licence

MIT, full text in [`LICENSE`](LICENSE). The same file is in the package (`packages/wallhammer-web/LICENSE`).
