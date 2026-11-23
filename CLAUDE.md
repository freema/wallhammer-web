# Wallhammer Web

A web 3D engine on plain WebGL2 (`packages/wallhammer-web`, npm package `wallhammer-web`), its checks (`tools/`) and its examples (`examples/`). Everything in the repository is English: code, comments, documentation, READMEs, skills, user-facing strings in examples, commit messages. In chat, reply in the language the user writes in (usually Czech).

## Rules

- **Docker only.** Development and checks run in the `dev` container (`docker compose up -d`). Never install Node or packages on the host.
- **Checks before "done".** After every change run the checks (skill `wallhammer-verify`) and report their result. Say what failed or was not run.
- **Golden hashes are not accepted without consent.** `--accept` rewrites all hashes of its set at once. First say which recipes changed and why, then wait for the user's approval.
- **Layers.** A module imports only lower layers. WebGL only in `gpu`, DOM only in `platform`. Modules other than the content modules (`gen-arch`, `gen-ground`, `gen-vegetation`) must not name a use case. There are no exceptions; a finding is fixed by moving code (`packages/wallhammer-web/docs/architecture.md`).
- **No 3D or graphics library, no loaded images.** All graphics are made by code.
- **Determinism.** Generators are pure functions (input and seed → data). Randomness only from named streams (`hashInts`), never `Math.random` or time.
- **English only.** Every tracked file (code, comments, documentation, READMEs, skills, strings shown by the examples) and every commit message is English. Only the chat follows the user's language.
- **Nothing project-specific in the engine.** The data of a concrete place, texts of a user interface and the content of one game belong in the project that uses the engine, or in an example. Only `packages/wallhammer-web` is published to npm; the examples are private workspace packages and are never published.
- **Internal material stays out of git.** Notes, plans, research, reports and drafts go to `internal/` (gitignored, as is `*.local.md`), never into tracked files. Never stage them with `git add -f`.
- **The copy in the Ústí repository is not edited from here.** The city model repository keeps a frozen hard copy of engine 0.4.0 in its `web/packages/wallhammer-web`. Do not edit a local checkout of that repository, wherever it lies on the machine. The two copies are synchronised by hand, deliberately, only on the user's instruction.
- **Commit, push and npm publishing only on an explicit instruction.** The package version is the user's to change.

## Where things are

- `packages/wallhammer-web/src/<module>/`: engine modules. `packages/wallhammer-web/docs/`: documentation (its samples are type-checked).
- `examples/<name>/`: example pages (`minimal-3d`, `destruction`, `endless`, `planet`, `system`, `fantasy-village`, `walk`, `outpost`, `rivers`), served by `dev` at http://localhost:5281/<name>/.
- `examples/shared/`: code used by more than one example (the pathfinder figure, the marks' page part), imported by relative path; not a page, not listed or built.
- `tools/layers`, `tools/docs`, `tools/pack`, `tools/mesh`, `tools/motion`: checks of the engine.
- `tools/golden/engine/` (engine recipes) and `tools/golden/` (recipes that need example code): golden hashes, each set with its own `hashes.json`.
- `tools/walk`, `tools/follow-check`: checks of walking and the follow camera (`check:walk`, `check:follow`).
- `tools/marks`: the marks made in a dev page (key `N` in `planet`; records in `internal/marks/`): `list.mjs`, `set.mjs`, `shoot.mjs` (after-pictures on the host GPU); the store is the dev-server plugin `tools/vite/marks-store.ts`.
- `tools/serve` (one server for all examples), `tools/vite` (dev-server plugins), `tools/shot` (pictures: `page-shot.mjs` in the `shot` service, `shot.mjs` on the host), `tools/bench` (performance, on the host).
- `tools/pages`: the static build of the examples for the live demos (`pnpm build:examples`).
- `examples/planet/scripts/verify.ts`, `examples/endless/scripts/verify.ts`: the examples' own headless checks (`pnpm verify` in the example's folder).
- `.claude/skills/`: `wallhammer-run` (running), `wallhammer-verify` (checks), `wallhammer-extend` (where things go when extending), `wallhammer-release` (releasing a version), `wallhammer-marks` (reading and updating the marks made in a dev page).
- `internal/`: internal working material, never committed.
- `.github/workflows/`: `checks.yml` (all checks on push and pull request), `publish.yml` (npm publish when a GitHub release is published), `pages.yml` (live demos: the examples built to GitHub Pages on push to `main`).
- `README.md`: running, checks, pictures, npm publishing and release, origin, the copy in the city repository.
