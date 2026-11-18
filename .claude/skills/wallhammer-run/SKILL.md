---
name: wallhammer-run
description: Start, stop and inspect the Wallhammer Web dev container and the example pages through Docker. Use when the user wants to run or see an example, check whether the container is up, read its logs, restart it or take a picture of a page. Typical requests "run the examples", "start an example", "how do I run it", "it does not run", "show the logs", "restart it", "where do I open it", "is docker running?".
---

# Run Wallhammer Web

Everything runs in Docker from the repository root (where `docker-compose.yml` is). Never install Node or packages on the host.

## Commands

Run from the repository root:

```sh
docker compose up -d                  # one service, dev: installs dependencies, then serves every example
docker compose ps                     # status; dev should say "(healthy)"
docker compose logs --tail 50 dev     # recent log of the container
docker compose restart dev            # reinstall dependencies and restart the example server
docker compose down                   # stop (the dependency volumes stay)
```

Another host port: `EXAMPLES_PORT=5291 docker compose up -d`.

## Services

| Service | URL | What |
| --- | --- | --- |
| dev | http://localhost:5281/ | Installs the workspace dependencies, serves every example on one port and stays up for the checks (skill `wallhammer-verify`) |
| shot | (no port) | One-off pictures of a page in headless Chromium (profile `tools`, not started by `up`) |

The pages of `dev`:

| URL | Example |
| --- | --- |
| http://localhost:5281/ | index of the examples |
| http://localhost:5281/minimal-3d/ | `examples/minimal-3d` |
| http://localhost:5281/destruction/ | `examples/destruction` |
| http://localhost:5281/endless/ | `examples/endless` (second page: `/endless/sphere.html`) |
| http://localhost:5281/planet/ | `examples/planet` |
| http://localhost:5281/system/ | `examples/system` |
| http://localhost:5281/fantasy-village/ | `examples/fantasy-village` |
| http://localhost:5281/walk/ | `examples/walk` |
| http://localhost:5281/outpost/ | `examples/outpost` |

In general `http://localhost:5281/<name>/` serves `examples/<name>`. Check that a page answers (prints `200`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5281/planet/
```

## What happens on start

The engine is `packages/wallhammer-web` in this repository; the examples import it through the pnpm workspace. The `dev` container runs `scripts/dev-entrypoint.sh`: `pnpm install --frozen-lockfile`, then `node tools/serve/serve.ts`, one HTTP server on port 5281. Each example gets its own Vite dev server (its `vite.config.ts`) in middleware mode with the base `/<name>/`, started on the first request for that example. `dev` is healthy once the dependencies are installed and the server answers (`/__health`).

Source edits need no restart; the page reloads. A restart is needed only after changing dependencies (and `pnpm-lock.yaml` must then be updated: `docker compose exec -T dev sh -c 'cd /app && pnpm install --no-frozen-lockfile --store-dir /pnpm-store'`). When the install fails, the container stays up without serving the pages and the health check stays red; fix it inside (`docker compose exec dev sh`), then `docker compose restart dev`.

A new example (a folder in `examples/` with `index.html`) appears in the index by itself. As a new workspace package it needs its own `node_modules` volume in `docker-compose.yml` (one line under `dev`, one under `volumes:`) and its directory in `Dockerfile.dev`, otherwise Docker creates the folder as root and the install fails.

## Pictures

The `shot` service opens a page of the running `dev` in headless Chromium on the software renderer and saves pictures. It shows whether a page starts without a WebGL error (no check compiles GLSL):

```sh
docker compose run --rm shot --url http://dev:5281/planet/ --presets @hash --size 960x540 --timeout 120000
```

Pictures go to `tools/shot/out/` (outside git). The last line is `shot: N pictures, M page errors`. The software renderer is slow: one picture per page and a `--timeout` are enough. Options are in the header of `tools/shot/page-shot.mjs`.

## When it does not start

- `docker compose ps` shows `dev` not healthy: read `docker compose logs --tail 50 dev`.
- Port 5281 is taken: another checkout may serve on it; stop those containers or use `EXAMPLES_PORT`.
- Other agents may be editing engine source at the same time. A transient type error in files you did not touch is not yours to fix.

## Do not

- Do not run host-only browser tools (`tools/shot/shot.mjs`, `tools/bench`) unless the user asks. They use the host GPU and Chrome.
- Do not commit, push or publish to npm unless the user asks.

Docs: `packages/wallhammer-web/docs/getting-started.md`.
