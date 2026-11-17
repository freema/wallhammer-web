#!/bin/sh
# Dev container start: installs the dependencies of the whole workspace, then stays up for the checks.
# Services of examples wait until this one is healthy (the marker below exists).
set -e
cd /app
rm -f /tmp/wallhammer-ready
echo "[wallhammer] instaluji závislosti"
pnpm install --frozen-lockfile --store-dir /pnpm-store
touch /tmp/wallhammer-ready
echo "[wallhammer] připraveno, kontroly: docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'"
exec sleep infinity
