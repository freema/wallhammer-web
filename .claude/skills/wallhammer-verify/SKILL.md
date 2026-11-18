---
name: wallhammer-verify
description: Run the Wallhammer Web checks (TypeScript typecheck, layer check and its fixtures, golden hashes of the engine and of the examples, documentation check, mesh, motion, walking and follow-camera checks, check of the published package) in Docker and interpret the results. Use after any change in this repository, before saying a change is done, or when the user asks whether things still work. Typical requests "verify it", "check the types", "do the tests pass?", "run the checks", "did I break something?", "golden test", "golden", "layer check", "check the docs", "can it be published?".
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
docker compose exec -T dev sh -c 'cd /app && pnpm check:mesh'
docker compose exec -T dev sh -c 'cd /app && pnpm check:motion'
docker compose exec -T dev sh -c 'cd /app && pnpm check:walk'
docker compose exec -T dev sh -c 'cd /app && pnpm check:follow'
```

Expected when everything is fine:

| Check | Last line |
| --- | --- |
| typecheck | every package (engine and examples) `typecheck: Done` or no output, exit 0 |
| `check:layers` | `layers: 0 violation(s)` |
| `check:layers:test` | `ok: known-bad fixture fails with all 16 expected findings` |
| `test:golden` | two sets, each ending with `golden: N of N generators unchanged`: first the engine (`golden: 72 of 72 …` with the 72 hashes stored now), then the examples (`golden: 25 of 25 …`). The counts grow when recipes are added. |
| `check:docs` | `docs: N files, M code blocks type-checked, 0 finding(s)` |
| `check:mesh` | `check:mesh: N/N ok in … ms` (mesh builder and bare shapes) |
| `check:motion` | `motion: N of N scenarios ok, … ms` (fails also over 5 s; a `slow` line is a missed timing target and does not fail) |
| `check:walk` | `walk: N of N scenarios ok, … ms` (collision world, walker, follow camera, course of `examples/walk`; fails also over 5 s; a `slow` line does not fail) |
| `check:follow` | `N/N follow cases passed in … ms` (the follow camera, `FollowRig`) |

`test:golden` runs `tools/golden/engine/golden.ts` and then `tools/golden/golden.ts`; the second set runs only when the first passes. Run one set alone with `pnpm test:golden:engine` or `pnpm test:golden:examples`.

Before a release, or after a change to `package.json`, `tsconfig.build.json` or the entries of the package, also run the check of the published shape (needs the network):

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'    # ok: the packed package installs, loads and type-checks
```

## Reading failures

- **Layer check**: each finding has a rule id (`upward`, `webgl`, `use-case-word`, `example-imports`, …). Fix by moving code. There is no exception list. Rules: `packages/wallhammer-web/docs/architecture.md`.
- **Golden `CHANGED <name>`**: a generator's output changed. If the change was not intended, it is a regression. If it was intended, tell the user which recipes changed and ask before accepting. There are two sets, each with its own accept command and its own `hashes.json`:
  - engine recipes: `node tools/golden/engine/golden.ts --accept` in `/app`, rewrites `tools/golden/engine/hashes.json`;
  - recipes that need example code: `node tools/golden/golden.ts --accept` in `/app`, rewrites `tools/golden/hashes.json`.

  Each accept rewrites **all** hashes of its set, so never run it while other recipes of that set fail for other reasons. Rules: `packages/wallhammer-web/docs/tools.md`, section "When re-accepting is legitimate".
- **Golden `MISSING <name>`**: a new recipe without a stored hash. Same accept step for its set, with the user's approval.
- **`check:docs`**: `[code]` is a sample that does not type-check, `[link]` a broken relative link or anchor, `[subpath]` an unknown `wallhammer-web/<x>` entry. Debug a sample with `docker compose exec -T dev sh -c 'cd /app && node tools/docs/check.ts --keep'`, which prints the folder with the generated files.
- **`check:walk`**: one line per scenario, `ok`, `FAIL` or `slow`. `node tools/walk/check.ts <text>` in `/app` runs only the scenarios whose name contains the text.
- **`check:follow`**: one line per case, `ok` or `FAIL follow: <name> — <detail>`.
- **`check:pack`**: `pack: FAIL …` names a file the tarball lacks or must not have (`files` in the package's `package.json`); an import error in `smoke` usually means an entry of `exports` without its twin in `publishConfig.exports`; a `tsc` error means the declarations in `dist/` do not resolve for a consumer.
- A failure in files you did not touch may come from another agent editing at the same time. Report it, do not fix it, retry later.

## Not covered here

- **Shader compile errors.** No check compiles GLSL. Open an example page and read the browser console, or take a picture with the `shot` service (skill `wallhammer-run`): its last line counts the page errors.
- **Pictures.** There is no committed visual regression. Pictures of the example pages are ad hoc (`shot` service, pictures in `tools/shot/out/`).
- **Real GPU look.** How a picture looks on a real graphics card (precision, performance) is checked in the browser.

Docs: `packages/wallhammer-web/docs/tools.md`.
