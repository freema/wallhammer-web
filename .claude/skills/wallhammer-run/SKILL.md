---
name: wallhammer-run
description: Start, stop and inspect the Wallhammer Web dev container and the example pages through Docker. Use when the user wants to run or see an example, check whether the containers are up, read their logs or restart them. Typical requests (Czech) "spusť příklady", "pusť příklad", "jak to spustím", "neběží mi to", "ukaž logy", "restartuj", "kde to otevřu", "běží docker?".
---

# Run Wallhammer Web

Everything runs in Docker from the repository root (where `docker-compose.yml` is). Never install Node or packages on the host.

## Commands

Run from the repository root:

```sh
docker compose up -d                  # dev first (installs dependencies), example services wait until it is healthy
docker compose ps                     # status; dev should say "(healthy)"
docker compose logs --tail 50 dev     # recent log of the dependency/check container
docker compose restart dev            # reinstall dependencies
docker compose down                   # stop (the dependency volumes stay)
```

## Services

| Service | URL | What |
| --- | --- | --- |
| dev | (no page, no port) | Installs the workspace dependencies and stays up for the checks (skill `wallhammer-verify`) |

The examples are being moved into this repository (`README.md`, section "Co zbývá přenést"). Once `examples/` is here, each example is one more service with its own port on `127.0.0.1` (5281 `minimal-3d`, 5282 `destruction`, 5283 `endless`, 5284 `planet`, 5285 `system`, 5286 `fantasy-village`, 5287 `walk`), started after `dev` is healthy. Check that a page answers (prints `200`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5281/
```

Add a row to the table above for every example service you add to `docker-compose.yml`.

## What happens on start

The engine is `packages/wallhammer-web` in this repository; the examples import it through the pnpm workspace. The `dev` container runs `scripts/dev-entrypoint.sh`: `pnpm install --frozen-lockfile`, then it waits. Source edits need no restart; a restart is needed only after changing dependencies (and `pnpm-lock.yaml` must then be updated: `docker compose exec -T dev sh -c 'cd /app && pnpm install --no-frozen-lockfile --store-dir /pnpm-store'`).

A new workspace package (an example) needs its own `node_modules` volume in `docker-compose.yml` and its directory in `Dockerfile.dev`, otherwise Docker creates the folder as root and the install fails.

## When it does not start

- `docker compose ps` shows `dev` not healthy: read `docker compose logs --tail 50 dev`.
- A port is taken: another checkout of the examples may run on the same ports; stop those containers first.
- Other agents may be editing engine source at the same time. A transient type error in files you did not touch is not yours to fix.

## Do not

- Do not run host-only browser tools (`tools/shot/shot.mjs`, `tools/bench`) unless the user asks. They use the host GPU and Chrome.
- Do not commit, push or publish to npm unless the user asks.

Docs: `packages/wallhammer-web/docs/getting-started.md`.
