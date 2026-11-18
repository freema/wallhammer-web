## What and why

<!-- What does this change do, and why is it needed? Link the issue, for example "Fixes #123". -->

## Checks

Run in the dev container: `docker compose exec -T dev sh -c 'cd /app && pnpm <check>'`.

- [ ] `pnpm typecheck`
- [ ] `pnpm check:layers`
- [ ] `pnpm test:golden`
- [ ] `pnpm check:docs`
- [ ] Others as relevant: `check:layers:test` (layer check changed), `check:mesh` (`gen-mesh`), `check:motion` (`motion`), `check:walk` and `check:follow` (walking, `FollowRig`), `check:pack` (entries, `package.json`, build), the `shot` service (shaders)

## Golden hashes

- [ ] No hash changed.
- [ ] Hashes changed. Which recipes and why:

<!-- List every recipe that prints CHANGED and say why its output changed. Do not run --accept; the maintainer accepts new hashes. -->

## Public API

- [ ] The public API did not change.
- [ ] The public API changed: `docs/reference.md` and `CHANGELOG.md` (Unreleased) are updated.
