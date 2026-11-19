---
name: wallhammer-verify
description: Run the Wallhammer Web checks (TypeScript typecheck, layer check and its fixtures, golden hashes of the engine and of the examples, documentation check, mesh, motion, walking and follow-camera checks, check of the published package, build of the live demos) in Docker and interpret the results. Use after any change in this repository, before saying a change is done, or when the user asks whether things still work. Typical requests "verify it", "check the types", "do the tests pass?", "run the checks", "did I break something?", "golden test", "golden", "layer check", "check the docs", "can it be published?", "does the demo build?".
---

# Verify Wallhammer Web

All checks run inside the `dev` container, workspace root `/app` (= the repository root on the host). Start the container first if `docker compose ps` shows nothing (skill `wallhammer-run`). CI (`.github/workflows/checks.yml`) runs the same list, in the same order, on every push to `main` and every pull request; `publish.yml` runs it before it publishes.

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
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'     # needs the network
docker compose exec -T dev sh -c 'cd /app/examples/planet && pnpm verify'
```

## Reading a pass

A check passes when it exits 0 and its last line counts every case as passed: both numbers of `N of N` or `N/N` are equal, and no line says `FAIL`, `CHANGED` or `MISSING`. The counts grow as cases are added, so never compare them with a remembered number; report "all scenarios ok", not a count.

| Check | Last line when it passes |
| --- | --- |
| typecheck | every package (engine and examples) prints `typecheck: Done` |
| `check:layers` | `layers: 0 violation(s)` |
| `check:layers:test` | `ok: known-bad fixture fails with all … expected findings` (after `ok: valid fixture passes`) |
| `test:golden` | `golden: N of N generators unchanged` twice: the engine set, then the examples set (which runs only when the first passes) |
| `check:docs` | `docs: … files (and … more for links), … code blocks type-checked, 0 finding(s)` |
| `check:mesh` | `check:mesh: N/N ok in … ms` |
| `check:motion` | `motion: N of N scenarios ok, … ms` |
| `check:walk` | `walk: N of N scenarios ok, … ms` |
| `check:follow` | `N/N follow cases passed in … ms` |
| `check:pack` | `ok: the packed package installs, loads and type-checks` |
| planet `pnpm verify` | `planet: all checks passed` |

Parts: `pnpm test:golden:engine`, `pnpm test:golden:examples`; `node tools/walk/check.ts <text>` (also `tools/motion/check.ts`, `tools/mesh/check.ts`) in `/app` runs only the cases whose name contains the text.

## Reading failures

- **Layer check**: each finding has a rule id (`upward`, `webgl`, `use-case-word`, `example-imports`, `subfolder-order`, …). Fix by moving code. There is no exception list. Rules: `packages/wallhammer-web/docs/architecture.md`.
- **Golden `CHANGED <name>`**: a generator's output changed. Not intended: a regression. Intended: tell the user which recipes changed and why, and wait for approval before accepting. Each set has its own accept command and `hashes.json`:
  - engine recipes: `node tools/golden/engine/golden.ts --accept` in `/app`, rewrites `tools/golden/engine/hashes.json`;
  - recipes that need example code: `node tools/golden/golden.ts --accept` in `/app`, rewrites `tools/golden/hashes.json`.

  Each accept rewrites **all** hashes of its set, so never run it while other recipes of that set fail for other reasons. Rules: `packages/wallhammer-web/docs/tools.md`, section "When re-accepting is legitimate".
- **Golden `MISSING <name>`**: a new recipe without a stored hash. Same accept step, with the user's approval.
- **`check:docs`**: `[code]` is a sample that does not type-check, `[link]` a broken relative link or anchor, `[subpath]` an unknown `wallhammer-web/<x>` entry, `[reference]` an export of an entry that `docs/reference.md` does not name. The link rule also covers the root README, CHANGELOG, CONTRIBUTING, CLAUDE.md, the examples' READMEs and the skills. `node tools/docs/check.ts --keep` in `/app` keeps the generated files and prints their folder.
- **`check:motion`, `check:walk`**: one line per scenario, `ok`, `FAIL` or `slow`. `slow` is a missed CPU-time target and does not fail; the run fails also when it takes over 5 s. `check:walk` has three groups: `# collision world` (including the camera boom's clearance), `# walker`, `# test course (examples/walk)`. The follow camera itself (`FollowRig`) is `check:follow`: one line per case, `ok` or `FAIL follow: <name> — <detail>`.
- **`check:pack`**: `pack: FAIL …` names a file the tarball lacks or must not have (`files` in the package's `package.json`); an import error in `smoke` usually means an entry of `exports` without its twin in `publishConfig.exports`; a `tsc` error means the declarations in `dist/` do not resolve for a consumer. Without network it cannot run; say so.
- A failure in files you did not touch may come from another agent editing at the same time. Report it, do not fix it, retry later.

## The examples' own checks

Two examples have a headless check of their own (`scripts/verify.ts`, plain Node):

```sh
docker compose exec -T dev sh -c 'cd /app/examples/planet && pnpm verify'            # in CI; about 10 s
docker compose exec -T dev sh -c 'cd /app/examples/endless && pnpm verify --seed 7'  # not in CI: needs the baked cells
```

- `planet`: the generator (cells independent of the order, the cell format, one owner per object), the flight, the streaming along the flight within its budgets, and the movie (every shot above the ground and without a jump). Passes with `planet: all checks passed`; a failure prints `FAILED: …` lines and exits 1. Run it after a change in `examples/planet` or in what it uses (`world`, `gen-core`, the streaming).
- `endless`: every baked cell file equals the generator's bytes (`N of N baked cells equal the generator's bytes`). The baked cells (`examples/endless/public/cells/`) are not in git, so it runs only where `pnpm bake` has run; with `--smooth` it checks the smooth levels. Run it after a change of the endless generator or of the cell format.

## Build of the live demos

Not part of `checks.yml`; the Pages workflow runs it only after a push to `main`. Run it when an example's `vite.config.ts`, `.html` pages, workers or `public/` changed, or `tools/pages/`, `tools/serve/examples.ts`, `tools/vite/`:

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm build:examples'
```

Passes with `[pages] N examples under / in dist-pages/, … MB, … s`. A worker handed to the engine must appear as its own `<worker-name>-<hash>.js` in `dist-pages/<example>/assets/`; without `workerUrls()` the build still passes but the worker never starts (skill `wallhammer-extend`).

## Not covered here

- **Shader compile errors.** No check compiles GLSL. Open the page and read the browser console, or take a picture with the `shot` service; its last line counts the page errors (skill `wallhammer-run`).
- **Look and frame cost.** There is no committed visual regression. Pictures and timings on the real GPU: skill `wallhammer-run`, section "Real GPU on the host".

## Report

Name every check you ran with its result, what failed, and what was not run (and why).

Docs: `packages/wallhammer-web/docs/tools.md`.
