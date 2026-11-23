---
name: wallhammer-marks
description: Read, follow up and close the marks a developer pins to points of a Wallhammer Web example page in the dev server (key N in the planet, endless and walk examples) - list the open ones, look at their pictures and views, set seen or working, attach an after-picture of the same view and set fixed, and never accept for the developer. Also how the mark mode works in the page, the record format, the limits of the pick and how to test the tools without touching real marks. Typical requests "look at my marks", "what did I mark", "work through the marks", "the marks in the planet", "fix mark 7", "take an after-picture", "is mark m0003 fixed?", "the mark tool does not save", "add marks to another example".
---

# Marks in Wallhammer Web

A mark is a note the developer pinned to a point of an example page while moving through it: the picked point, the clicked pixel, a view that puts the camera back exactly, a picture of the canvas with the pick circled, and facts the page could say about the place. Marks are tracked with a status and an append-only log. Read [Marks](../../../packages/wallhammer-web/docs/marks.md) once for the parts and the record format.

Where things are (all of it but the host and `shoot` ships in the npm package): the record types in `packages/wallhammer-web/src/base/marks.ts`, the page's part (`installMarking`) in `packages/wallhammer-web/src/platform/marks/`, the store (`marksStore`) and the command-line tool `wallhammer-marks` in the Node-only entry `packages/wallhammer-web/src/marks-store/`, this repository's wrappers and `shoot.mjs` in `tools/marks/`, the records in `internal/marks/` (git ignores it; the `vite.config.ts` of planet, endless and walk pass that folder), the ready host for the engine's `FreeRig` and `FollowRig` (`installEngineMarking`, picks `heightPick`, `gapPick`, `collisionPick`) in `packages/wallhammer-web/src/runtime/marks.ts`, used by `examples/endless/src/main.ts` and `examples/walk/src/main.ts`, and the planet's own host in `examples/planet/src/marks.ts`.

## When to use

- The developer says they marked something, or asks to work through the marks.
- Before reporting a fault from a mark as fixed.
- When the mark mode, the store or a reader misbehaves, or when another example should get marks (with a `FreeRig` or `FollowRig`: one call `installEngineMarking(engine, { pick, hash })` of `wallhammer-web/runtime` inside `if (import.meta.env.DEV)`, as endless and walk do; another camera needs a host of its own like `examples/planet/src/marks.ts`; and `marksStore({ dir: <repo>/internal/marks })` from `wallhammer-web/marks-store` in its `vite.config.ts`).

## The developer's workflow in the page

1. `docker compose up -d`, open http://localhost:5281/planet/, http://localhost:5281/endless/#cam=free or http://localhost:5281/walk/ (marks exist only in the dev server, never in the live demos). All pages share `internal/marks/`; each page lists and pins only its own marks (`page`), `list` shows every page's.
2. Fly the free camera (or walk the figure) to the fault. `N` switches the mark mode (planet: not during the flight or the movie; endless: the free camera only): a crosshair, the panel on the right, the movement keys still work.
3. Click the fault, type a note, Enter saves (Escape drops it). A numbered pin appears, coloured by status.
4. The panel lists the marks (filters: open, fixed, all): `go` puts the camera at a mark's view, `note` edits the note, a category (`bug`, `look`, `idea`), `accept`, `reopen`, `wontfix`, `×` deletes, `compare` shows the picture beside the newest after-picture. The panel reads the store again every few seconds, so an agent's change shows without a reload.
5. `#marks=0` hides the pins. A page driven by a script has no marks unless `#marks=1`.

## The agent's workflow

```sh
# In this repository: the package's `wallhammer-marks` with internal/marks/ and the example server as defaults.
node tools/marks/list.mjs --open                    # host or container: the open marks (fixed ones stay listed)
node tools/marks/list.mjs --md                      # also internal/marks/marks.md with the links, the facts and the logs
node tools/marks/set.mjs m0007 --status seen --by agent:<topic>
node tools/marks/set.mjs m0007 --status working --by agent:<topic> --text "what I am changing"
node tools/marks/shoot.mjs m0007 --attach --by agent:<topic> --status fixed --text "what changed"   # host GPU
```

In another project that installed `wallhammer-web` the same commands are `npx wallhammer-marks list --open` and `npx wallhammer-marks set …` (folder `--dir`, `WH_MARKS_DIR` or `.marks/`; dev server `--url`, `WH_MARKS_URL` or `http://localhost:5173`); `shoot` is only in this repository.

1. `list --open`; read each mark's note, its picture (`internal/marks/<id>.png`, the pick is circled) and its facts. Open its view: the link in `marks.md` (`http://127.0.0.1:5281/<page>#<hash>`) puts the camera back.
2. Set `seen` when you have read a mark, `working` when you change something for it. `--by agent:<topic>` names you in the log.
3. `fixed` only with an after-picture of the **same view**: `shoot.mjs` re-opens the mark's page at its hash, canvas size and pixel ratio on the host GPU and copies the canvas as the page does. Look at the after-picture yourself before attaching it; a picture with page errors is kept but not attached. `set.mjs --status fixed` refuses without `--after`.
4. Only the developer sets `accepted` and `reopened` (in the page's panel); `set.mjs` refuses both. A fixed mark is not done until the developer accepts it. Never report a mark as solved on your own picture alone.
5. `wontfix` with a reason in `--text`, when the fault is not one or is out of scope.

`shoot.mjs` needs `puppeteer-core` in `tools/shot/node_modules` (outside git, as for the other host picture tools). One browser at a time; check afterwards that no headless Chrome is left (`pgrep -fl 'Google Chrome.*headless'`).

A mark made through `installEngineMarking` (endless, walk) has `view.rig` (the rig's exact state as text), `view.hour`, `view.timeS`, and a hash of the page's own parameters plus `mkview=` and `mkclock=`; opening it restores the camera exactly. In walk the walker is put back on the recorded spot; its heading comes from the page's `yaw` (0.1°), and a camera that was still trailing a moving figure settles after the first frames.

## The record format

One JSON line per mark in `internal/marks/marks.jsonl`: `id` (`m0007`), `seq`, `note`, `category`, `page` (`/planet/`), `point` (`world`, `distanceM`, `surface`, `place`, `accuracy`; null when the ray met nothing), `pixel` (physical canvas pixels), `canvas`, `view` (`hash` and what the host records), `facts`, `picture` / `pictureNote`, `savedAt`, `status` (missing = `new`), `log` (`{ seq, status, by, text, picture?, at, was? }`, append only). Pictures: `<id>.png`, `<id>-after-<n>.png`. The store's routes and checks are in the header of `packages/wallhammer-web/src/marks-store/store.ts`. Never edit `marks.jsonl` by hand while the dev server runs; go through the store.

## Limits

- The pick is a ray marched on the CPU (`marchRay`) against the host's height and water functions. It goes through objects: plants, rocks, structures, figures, waves and clouds are not in it, and a coarse level of the drawn mesh may stand off the height function. A mark on an object stores the ground behind it; the picture and the note say what was meant. `point.accuracy` says how the pick was made.
- The facts are what the host can compute cheaply; `unknown` means unknown.
- The picture is the canvas alone, without the page's DOM (pins, panels, HUD).
- The view hash restores the camera, the hour and the animation time; state the hash does not hold (streaming detail still loading, a toggled layer) may differ.

## Testing the tools

Never test on a developer's real marks. Back up `internal/marks/` first (`cp -a internal/marks internal/marks.bak-<date>`), or point the tools at a scratch folder: `WH_MARKS_DIR=<scratch>` for the readers, and for the store `WH_MARKS_DIR` in the dev server's environment (it wins over the `dir` the planet passes). A scratch mark made through the page (`__wh.marks.add(note)` with `#marks=1`) is removed with `__wh.marks.remove(id)` or `DELETE <page>__marks/<id>`; say in the report that you made and removed it. Run the checks afterwards (skill `wallhammer-verify`); `pnpm test:marks` checks the store and `wallhammer-marks` on a scratch folder of its own.
