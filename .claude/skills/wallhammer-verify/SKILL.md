---
name: wallhammer-verify
description: Run the Wallhammer Web checks (TypeScript typecheck, layer check and its fixtures, golden hashes, documentation check, check of the published package) in Docker and interpret the results. Use after any change in this repository, before saying a change is done, or when the user asks whether things still work. Typical requests (Czech) "ověř to", "zkontroluj typy", "projdou testy?", "spusť kontroly", "rozbil jsem něco?", "zlatý test", "golden", "kontrola vrstev", "zkontroluj dokumentaci", "půjde to zveřejnit?".
---

# Verify Wallhammer Web

All checks run inside the `dev` container, workspace root `/app` (= the repository root on the host). Start the container first if `docker compose ps` shows nothing (skill `wallhammer-run`).

## The checks

Run from the repository root, in this order:

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers'
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers:test'
docker compose exec -T dev sh -c 'cd /app && pnpm test:golden'
docker compose exec -T dev sh -c 'cd /app && pnpm check:docs'
```

Expected when everything is fine:

| Check | Last line |
| --- | --- |
| typecheck | every package `typecheck: Done` or no output, exit 0 |
| `check:layers` | `layers: 0 violation(s)` |
| `check:layers:test` | `ok: known-bad fixture fails with all 16 expected findings` |
| `test:golden` | `golden: 72 of 72 generators unchanged` (the count grows when recipes are added) |
| `check:docs` | `docs: N files, M code blocks type-checked, 0 finding(s)` |

Before a release, or after a change to `package.json`, `tsconfig.build.json` or the entries of the package, also run the check of the published shape (needs the network):

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'    # ok: the packed package installs, loads and type-checks
```

## Reading failures

- **Layer check**: each finding has a rule id (`upward`, `webgl`, `use-case-word`, `example-imports`, …). Fix by moving code. There is no exception list. Rules: `packages/wallhammer-web/docs/architecture.md`.
- **Golden `CHANGED <name>`**: a generator's output changed. If the change was not intended, it is a regression. If it was intended, tell the user which recipes changed and ask before accepting. Accepting is `node tools/golden/engine/golden.ts --accept` in `/app`; it rewrites **all** hashes in `tools/golden/engine/hashes.json`, so never run it while other recipes are failing for other reasons. Rules: `packages/wallhammer-web/docs/tools.md`, section "When re-accepting is legitimate". Recipes that need example code live one folder up (`tools/golden/golden.ts` with its own `hashes.json`) and come with the examples.
- **Golden `MISSING <name>`**: a new recipe without a stored hash. Same accept step, with the user's approval.
- **`check:docs`**: `[code]` is a sample that does not type-check, `[link]` a broken relative link or anchor, `[subpath]` an unknown `wallhammer-web/<x>` entry. Debug a sample with `docker compose exec -T dev sh -c 'cd /app && node tools/docs/check.ts --keep'`, which prints the folder with the generated files.
- **`check:pack`**: `pack: FAIL …` names a file the tarball lacks or must not have (`files` in the package's `package.json`); an import error in `smoke` usually means an entry of `exports` without its twin in `publishConfig.exports`; a `tsc` error means the declarations in `dist/` do not resolve for a consumer.
- A failure in files you did not touch may come from another agent editing at the same time. Report it, do not fix it, retry later.

## Not covered here

- **Shader compile errors.** No check compiles GLSL. Open an example page and read the browser console.
- **Pictures.** There is no committed visual regression. Pictures of the example pages are ad hoc (`tools/shot`, with the examples).
- **Real GPU look.** How a picture looks on a real graphics card (precision, performance) is checked in the browser.

Docs: `packages/wallhammer-web/docs/tools.md`.
