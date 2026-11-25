---
name: wallhammer-marks
description: Work through the marks a developer pins to points of a scene in a project built on the wallhammer-web npm package - list the open marks, read each note, picture and view, set seen or working, fix the cause, attach an after-picture of the same view and set fixed, and never accept for the developer. Also how to set marks up in a Vite project (the marksStore plugin and installEngineMarking) and their limits. Typical requests "look at my marks", "what did I mark", "work through the marks", "fix mark 7", "is m0003 fixed?", "add marks to the page", "the marks do not save".
---

# Marks in a Wallhammer Web project

A mark is a note the developer pinned to a point of the running page: the picked point, the clicked pixel, a view
that puts the camera back exactly, a picture of the canvas with the pick circled, and facts the page could say about
the place. Each mark has a status and an append-only log. The full description is
`node_modules/wallhammer-web/docs/marks.md`; read it once.

## Setting it up (once per project)

1. `vite.config.ts`: `import { marksStore } from 'wallhammer-web/marks-store';` and `plugins: [marksStore()]`. The
   marks go to `.marks/` in Vite's root (option `dir`, or `WH_MARKS_DIR`). Add `.marks/` to `.gitignore`.
2. In the page, after the engine is made, only in the dev server:

   ```ts
   if (import.meta.env.DEV) {
     const { heightPick, installEngineMarking } = await import('wallhammer-web/runtime');
     installEngineMarking(engine, { pick: heightPick(heightAt) }); // or collisionPick(world), placeTarget for a walker
   }
   ```

   This host works while the engine draws through a `FreeRig`, a `FollowRig` or a `PerspectiveOrbitRig` (an orbit
   view comes back with its own target, yaw, pitch and distance; its drag and wheel wait while the mark mode is on).
   Another view (`ChartFollowView`, `SteppedOrthoRig`, a camera of the project's) needs a host of its own
   (`installMarking` of `wallhammer-web/platform`, or `engineMarkHost` of `runtime` with parts replaced, described in
   `marks.md`). State the page keeps outside the camera and the clocks (a seed, a toggled layer) goes in the `hash`
   option so a mark's link restores it; a page with a clock of its own passes `clocks: false` and its time in `hash`.
3. Key N in the page switches the mark mode (option `key` when the page uses N). A page driven by a script
   (webdriver) has marks only with `#marks=1`.

## The developer's part

Move to the fault, press N, click it, type a note, Enter. The panel lists the marks with `go` (back to the view),
`compare` (the picture beside the newest after-picture), `accept`, `reopen`, `wontfix` and delete. The panel reads
the store every few seconds, so the agent's changes show without a reload.

## The agent's part

With the dev server running (the command reads `.marks/` and sends changes through the server):

```sh
npx wallhammer-marks list --open                  # open marks; fixed ones stay listed until accepted
npx wallhammer-marks list --md                    # also .marks/marks.md: links to each view, facts, logs
npx wallhammer-marks set m0007 --status seen --by agent:<topic>
npx wallhammer-marks set m0007 --status working --by agent:<topic> --text "what I am changing"
npx wallhammer-marks set m0007 --status fixed --by agent:<topic> --text "what changed" --after after.png
npx wallhammer-marks set m0007 --status wontfix --by agent:<topic> --text "why"
```

`--dir` (or `WH_MARKS_DIR`) names another folder, `--url` (or `WH_MARKS_URL`) another dev server than
`http://localhost:5173`.

1. `list --open`. For each mark read the note, look at its picture (`.marks/<id>.png`, the pick is circled) and its
   facts. The link in `marks.md` opens the page at the mark's view.
2. Set `seen` once read, `working` when you change something for it. `--by agent:<topic>` names you in the log.
3. Find the cause in the project's code (a generator, a material, data), fix it, run the project's checks.
4. Set `fixed` only with an after-picture of the **same view**, and look at that picture yourself first.
5. Never set `accepted` or `reopened`; the command refuses both. A fixed mark is not done until the developer accepts
   it. Never report a mark as solved on your own picture alone.

## Making the after-picture

`--after` takes a PNG of the canvas at the mark's view. A file named `<id>-after-<n>.png` already in `.marks/` is
referred to; any other PNG is copied there. Ways to make one:

- **In the page, through a browser tool** (Chrome DevTools, Playwright, a browser extension), when the project keeps
  the value `installEngineMarking` returns (a `MarkingApi`, or `null` when marks are off), for example on
  `window.__marks` in the dev server. Then in the page's console:

  ```js
  __marks.goto('m0007');                          // the camera back at the mark's view
  const shot = await __marks.snapshot();          // { png: base64 or null, note }
  await __marks.update('m0007', { by: 'agent:<topic>', status: 'fixed', text: 'what changed', png: shot.png });
  ```

  Wait for the view to settle (streamed detail loaded) before `snapshot`.
- **Without access to the page**: open the mark's link from `marks.md` in a browser at the same canvas size, save the
  canvas as PNG, and pass it to `set … --after <file>`.
- If neither is possible, leave the mark `working`, say what changed and ask the developer to look and accept.

## Limits

- The pick is a ray marched on the CPU against the page's height function or collision world. Trees, rocks, figures,
  water and clouds are not in it: a mark on one stores the ground behind; the note and the picture say what was meant.
- The picture is the canvas alone, without the page's HTML.
- The view restores the camera, the hour and the animation time (unless `clocks: false`); state the page does not put
  in its hash may differ.
- Never edit `.marks/marks.jsonl` by hand while the dev server runs; go through the command or the page.
- Do not test the tools on the developer's real marks: point `WH_MARKS_DIR` at a scratch folder.
