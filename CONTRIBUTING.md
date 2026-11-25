# Contributing

Thank you for helping with Wallhammer Web. This file says how to set up, what to check and which rules a change must follow.

## Before you start

- Small fixes (a bug, a typo, a wrong sentence in the docs) can go straight to a pull request.
- For anything larger, open an issue first: a new module or entry, a new layer, a change to the public API, a change of the rules below. Agree on the approach before you write the code.
- Security problems are not reported in issues. See [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Everything runs in Docker. The host needs Docker with `docker compose` and git. Do not install Node or packages on the host.

```sh
docker compose up -d     # from the repository root
docker compose ps        # dev should be (healthy)
```

The `dev` service installs the dependencies and serves every example at <http://localhost:5281/>. Stop it with `docker compose down`. [README.md](README.md) has the details.

## Checks

Run these in the container before you open a pull request. CI runs the same checks on every pull request ([checks.yml](.github/workflows/checks.yml)).

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
docker compose exec -T dev sh -c 'cd /app && pnpm test:marks'         # marks: N of N cases ok
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'         # ok: the packed package installs, loads and type-checks
```

`check:pack` needs the network. If you changed a shader, run the one-off `shaders` service, which compiles and links every program the example pages make (`docker compose run --rm shaders --pages <names>`, a `#hash` for a program made only in a mode; [Shader check](README.md#shader-check) in the README), and use the `shot` service to see that a page starts without a WebGL error.

[Tools](packages/wallhammer-web/docs/tools.md) explains each check.

## Rules

These are hard rules. A pull request that breaks one is not merged.

- **Layers.** A module imports only modules of a lower layer, never one of its own layer. `pnpm check:layers` enforces this. There are no exceptions: fix a finding by moving code, not by adding an exception. See [Architecture](packages/wallhammer-web/docs/architecture.md).
- **WebGL only in `gpu`, DOM only in `platform`.** The Worker API is also only in `platform`.
- **The engine stays abstract.** Only the content modules `gen-arch`, `gen-ground` and `gen-vegetation` may name what they generate. Every other module describes its features in neutral terms. See [The engine stays abstract](packages/wallhammer-web/docs/architecture.md#the-engine-stays-abstract).
- **No 3D or graphics library, no loaded images.** All graphics come from code.
- **Determinism.** Generators are pure functions: input and seed in, plain data out. Randomness comes only from named hash streams (`hashInts`), never from `Math.random` or the clock. See [Rules for a new generator](packages/wallhammer-web/docs/generators.md#rules-for-a-new-generator).
- **English only.** Code, comments, documentation, commit messages and pull requests are in English.
- **Nothing project-specific in the engine.** Data of a particular place, interface texts and the content of one game belong in the project that uses the engine, or in an example.

## Golden hashes

`pnpm test:golden` runs fixed recipes and compares the hash of each output with the stored one. A refactor must leave every hash unchanged.

If your change alters the output on purpose, do not run `--accept` yourself: it rewrites every hash of a set at once. Instead, say in the pull request which recipes print `CHANGED` and why their output changed. The maintainer reviews that and accepts the new hashes. Rules: [Golden hashes](packages/wallhammer-web/docs/tools.md#golden-hashes).

## Where things go

- [Architecture](packages/wallhammer-web/docs/architecture.md) lists every module with its layer and the rules the layer check enforces. Start there to find the module a change belongs to.
- [Recipes](packages/wallhammer-web/docs/recipes.md) shows how to add a layer, a material, an environment slot, a generator, a destructible structure, a streamed cell provider or an animated rig.
- Code that only one example needs stays in that example, under `examples/<name>/`.
- The documentation is in [`packages/wallhammer-web/docs/`](packages/wallhammer-web/docs/). Its code samples are type-checked by `pnpm check:docs`, so keep them compiling.

## Public API

If you add, remove or change anything exported from an entry (`packages/wallhammer-web/src/<module>/index.ts`):

- update [`docs/reference.md`](packages/wallhammer-web/docs/reference.md);
- add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).

A new entry `wallhammer-web/<module>` is written twice in [`package.json`](packages/wallhammer-web/package.json): in `exports` and in `publishConfig.exports`. `check:pack` finds a missing twin.

## Versions and releases

Do not change the version in `package.json`. The maintainer sets the version and publishes each release through a GitHub release, which runs the checks and publishes the package to npm.

## Licence

The project is under the MIT licence ([LICENSE](LICENSE)). By contributing, you agree that your contribution is licensed under the same terms.
