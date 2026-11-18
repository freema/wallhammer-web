#!/bin/sh
# Dev container start: installs the dependencies of the whole workspace, then serves every example on one port
# (tools/serve/serve.ts). The checks run next to it: docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'.
set -e
cd /app
echo "[wallhammer] installing dependencies"
if ! pnpm install --frozen-lockfile --store-dir /pnpm-store; then
  # Stay up, so the cause can be fixed inside (docker compose exec dev sh); the health check stays red.
  echo "[wallhammer] install failed, the pages are not served; fix it in the container (docker compose exec dev sh) and run docker compose restart dev"
  exec sleep infinity
fi
echo "[wallhammer] ready, checks: docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'"
exec node tools/serve/serve.ts
