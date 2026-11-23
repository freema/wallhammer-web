---
name: wallhammer-release
description: Release a new version of the npm package wallhammer-web (packages/wallhammer-web) - choose the version, update package.json, README and CHANGELOG, commit, push, create the GitHub release that publishes to npm, watch the publish run and verify the result - plus the rules of the GitHub side (protected main, Dependabot, English). Use only when the user explicitly asks for a release, or to explain or repair one. Typical requests "release a version", "publish to npm", "bump the version", "cut 0.4.2", "make a release", "tag a release", "is it on npm?", "the publish failed".
---

# Release wallhammer-web

Only on the user's explicit instruction. The version is the user's to choose; propose one, never pick it alone. While the version is 0.x a minor (0.4 → 0.5) may break and a patch may not (`CHANGELOG.md`, header). Read `Unreleased` first: a removed or renamed export, a changed signature or a changed default of the published package is not a patch. If the user asks for a patch over such an entry, say so and ask.

Publishing is npm trusted publishing (OIDC) from `.github/workflows/publish.yml`: no token, no secret, no `npm login`, no OTP. Never publish by hand unless the workflow is broken and the user asks (then README, section "npm package", "By hand"). A published version can never be overwritten or published again, not even after an unpublish.

## Steps

1. **Clean, current `main`.** Stop and ask if anything is uncommitted (other agents may be working in the tree).

   ```sh
   git status -sb                                             # "## main...origin/main" and no file lines
   git pull --ff-only                                         # up to date with origin/main
   gh run list --workflow checks.yml --branch main --limit 1  # the last CI run on main is green
   ```

2. **All checks**, `check:pack` included (skill `wallhammer-verify`). Report the result before going on.

3. **Set the version** `X.Y.Z` (from `OLD`):
   - `"version"` in `packages/wallhammer-web/package.json` and in the root `package.json` (kept equal);
   - `"version"` in `plugins/wallhammer/.claude-plugin/plugin.json`, the users' Claude Code plugin, to the same `X.Y.Z` (`pnpm check:docs` fails with a `[plugin]` finding while it differs; the marketplace entry in `.claude-plugin/marketplace.json` carries no version);
   - `README.md`, the two mentions of the current version: `gh release create vOLD` (section "Release") and `(now OLD)` (section "By hand"). Find them with `grep -n 'OLD' README.md`; leave the historical `0.4.0` of "Origin" and "Copy in the city repository" alone;
   - `CHANGELOG.md`: a heading `## X.Y.Z` (no date) right under `## Unreleased`, every Unreleased entry moved under it, `## Unreleased` left empty.

4. **Commit and push.** The message is English, `Release X.Y.Z`, a body of one or two sentences on what the version brings, and the attribution trailer the session prescribes.

   ```sh
   git add package.json packages/wallhammer-web/package.json plugins/wallhammer/.claude-plugin/plugin.json README.md CHANGELOG.md
   git commit    # "Release X.Y.Z" + body + trailer
   git push origin main
   ```

   The push also starts Checks and Pages (the live demos).

5. **Create the release.** The tag must be `v` + the version of `packages/wallhammer-web/package.json` at the tagged commit. `gh` creates the tag on the remote `main`, so push first. Notes: the version's CHANGELOG section and a link to the changelog, as for v0.4.1; write the file in the scratchpad.

   ```sh
   gh release create vX.Y.Z --target main --title vX.Y.Z --notes-file <scratchpad>/notes.md
   ```

   A prerelease version (`X.Y.Z-beta.N`): add `--prerelease`. The workflow puts any version with a `-` under the npm dist-tag `beta`, so `latest` stays the stable one. Never `--draft`: only a published release starts the workflow.

6. **Watch the run** `Publish to npm`: job `checks` (calls `checks.yml`), then `publish` (tag check, `pnpm pack`, `npm publish package.tgz --access public`).

   ```sh
   gh run list --workflow publish.yml --limit 1      # wait a few seconds after the release
   gh run watch <run-id> --exit-status
   ```

7. **Verify** in the container. The registry JSON over HTTP (and the npm badge) can lag by minutes; trust `npm view`.

   ```sh
   docker compose exec -T dev sh -c 'npm view wallhammer-web version dist-tags --json'   # X.Y.Z, latest (or beta) = X.Y.Z
   ```

   Report the version, the release URL and the run result.

## When the run fails

Nothing reaches npm unless the `Publish` step succeeds; check with `docker compose exec -T dev sh -c 'npm view wallhammer-web versions'`. A tag is never moved, recreated or reused: a fix ships as a new version with a new tag.

| Failure | What to do |
| --- | --- |
| Job `checks` fails | A transient failure (network in `check:pack`): `gh run rerun <run-id> --failed`. A real fault: fix it on `main` and release the next version; the failed tag stays where it is. Delete or edit the failed GitHub release only with the user's consent. |
| Step "The tag matches the package version" fails | The tag is not `v` + the version at the tagged commit. Nothing is published. A mistyped tag: with the user's consent delete that release and its tag (`gh release delete <tag> --cleanup-tag --yes`) and create `vX.Y.Z`. The right tag on a commit without the version (release created before the push): bump again. |
| `npm publish` says the version exists (E403, "cannot publish over") | That version is on npm already. Bump again (the user picks it), new CHANGELOG heading, new release commit, new tag. |
| `npm publish` fails to authenticate (E404, ENEEDAUTH, OIDC) | Trusted publishing is set on npmjs.com (package settings, "Trusted Publisher": GitHub Actions, owner `freema`, repository `wallhammer-web`, workflow `publish.yml`); the job needs `id-token: write` and npm 11.5.1 or newer (it installs `npm@latest`). Report to the user; do not fall back to publishing by hand unasked. |

## GitHub side

- `main` is protected by the ruleset "Protect main" against force push and deletion; direct pushes are allowed. Never force-push or rewrite pushed history.
- Commit, push and release only on the user's instruction.
- Dependabot (`.github/dependabot.yml`): weekly on Monday, every update of the week grouped, at most one pull request per ecosystem (npm, GitHub Actions); major updates of `@types/node` are ignored. Do not widen it unasked.
- Issues, pull requests, release notes and commit messages are in English. Pull requests follow `.github/PULL_REQUEST_TEMPLATE.md` (checks, golden hashes, public API).
