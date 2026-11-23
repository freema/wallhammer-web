# Marks

Marks are notes a developer pins to points of a scene while moving through it: press a key, click a fault, type a
note. Each mark keeps the picked point in world metres, the clicked pixel, a view that puts the camera back exactly,
a picture of the canvas with the pick circled and what the page can say about the place. Marks show in the page as
numbered pins coloured by their status, carry an append-only log with pictures taken after a repair, and agents read
and update them from the command line.

Marks ship in the package, split by where each part runs:

| Part | Where | What it is |
| --- | --- | --- |
| The record | `wallhammer-web/base` (`Mark`, `MarkDraft`, `MarkLogEntry`, `MarkPatch`, `PickHit`, `MarkView`, `MARK_STATUSES`, `MARK_CATEGORIES`, `statusOf`, `lastLog`, `lastAfterPicture`) | Plain data, shared by the page, the store and the command line. |
| The pick | `marchRay` in `wallhammer-web/world` | A ray marched against a signed gap function, pure. |
| The page's part | `wallhammer-web/platform` (`installMarking`, `MarkHost`, `MarkingOptions`, `MarkingApi`, `markStore`, `captureCanvas`, `MARK_STATUS_COLOURS`) | The mark mode, the pins, the panel, the picture and the store client (DOM). |
| The store | `marksStore` in `wallhammer-web/marks-store` (Node only) | A Vite dev-server plugin that keeps the marks in a folder. |
| The command line | the package's `bin` `wallhammer-marks` (`list`, `set`) | List the marks, change a status. |
| A page that uses it | `examples/planet/src/marks.ts` (in the repository, not in the package) | Key `N` in the free camera of the planet example. |

The record types are plain data in `base`, so every layer may read them. `MarkHost` holds the page's canvas
(`HTMLCanvasElement`) and `MarkingOptions` a key of the keyboard, so they sit in `platform` with the panel, the only
layer that touches the DOM. The picture is taken with `toBlob` alone; no 2D context is opened outside `gpu`. The store
and the command-line tool use Node's file system and run only in a dev server or a shell: they are an entry of their own
that nothing else in the engine imports and the root entry does not re-export. The panel's labels are the tool's own,
in English.

## The pick: `marchRay`

`marchRay(ray, gap, options)` walks a ray (`dir` a unit vector) against a function that says how far a point is from
a surface, positive on the eye's side. Each step is a share of the gap and never shorter than a floor that grows with
the distance; the first step that ends at or behind the surface is halved down to `toleranceM`. Unlike
`raycastHeightField`, which walks a sampled grid, it asks a function, so any surface a caller can measure works: a height
function over a sphere, a level, the lower of the two.

<!-- check: wrap -->
```ts
import type { Ray, Vec3 } from 'wallhammer-web/base';
import { SphereWorld, marchRay } from 'wallhammer-web/world';

declare const ray: Ray; // in world metres, from a camera's screen ray
declare function heightAt(direction: Vec3): number; // metres above the base sphere

const shape = new SphereWorld(100_000);
const hit = marchRay(ray, (p) => shape.altitude(p) - Math.max(0, heightAt(shape.directionOf(p))), {
  maxDistanceM: 50_000,
  // The least step: half a pixel at every distance for a 900-pixel canvas and a 50° field of view.
  stepPerM: (0.5 * 2 * Math.tan((50 * Math.PI) / 360)) / 900,
  // A ray above the highest ground that climbs meets nothing more.
  escaped: (p) => shape.altitude(p) > 8000,
});
if (hit) console.log(hit.point, hit.distanceM, hit.steps, hit.lastStepM);
```

The result says how coarse the search was where it found the surface (`lastStepM`) and how many times it asked the
function (`steps`). A part of the surface thinner than one step can be missed, and the pick sees only what the function
describes: instances, structures and effects drawn over the surface are not in it.

## In a page

A page installs the marks with `installMarking(host, options)` from `wallhammer-web/platform` and gets the script
interface `MarkingApi` back (`list`, `add`, `update`, `remove`, `goto`, `compare`, `mode`, `reload`, `snapshot`).
`options` are the store's URL path (`${import.meta.env.BASE_URL}__marks` in a Vite page), the key
(`KeyboardEvent.code`) and whether the pins are drawn. The `MarkHost` it hands over is small: the canvas and its size,
the ray under a pixel, where a world point lands on the canvas, the pick, the current view as a URL hash that restores
it, the facts of a place, a synchronous render, a frame hook and a way to put the camera at a view.
`examples/planet/src/marks.ts` in the repository is a complete host in under 200 lines.

The planet example loads its marks only when `import.meta.env.DEV` holds, so the static build of the live demos has
none of them, and a page driven by a script (`navigator.webdriver`: the picture and benchmark tools) has none unless
its hash says `marks=1`. Pictures and golden hashes are therefore unchanged.

The picture of a mark is the canvas alone: the page renders a frame and calls `toBlob` in the same task (a WebGL canvas
without `preserveDrawingBuffer` is empty once shown); the store circles the clicked pixel and refuses a picture that
reads back empty.

## Records

The store keeps one JSON line per mark in `marks.jsonl` of its folder, the picture as `<id>.png` and after-pictures as
`<id>-after-<n>.png`. A mark:

| Field | Meaning |
| --- | --- |
| `id`, `seq` | `m0007` and 7; the sequence never repeats. |
| `note`, `category` | The developer's text; `bug`, `look` or `idea`. |
| `page` | The page's path (`/planet/`). |
| `point` | `world` (metres), `distanceM`, `surface`, `place` (the host's coordinates), `accuracy` (how it was picked); null when the ray met nothing. |
| `pixel`, `canvas` | The click in physical canvas pixels; the canvas in physical and CSS pixels. |
| `view` | `hash` (restores the camera) and what else the host records. |
| `facts` | What the host can say about the place. |
| `picture`, `pictureNote` | The picture's path (relative to the dev server's working folder when the store's folder lies in it), or null and why. |
| `status` | `new` (also when missing), `seen`, `working`, `fixed`, `accepted`, `reopened`, `wontfix`. |
| `log` | Entries `{ seq, status, by, text, picture?, at, was? }`; it only grows. |

## The store and the command line

The store is a Vite plugin from the Node-only entry `wallhammer-web/marks-store`; it is active in the dev server only
(`apply: 'serve'`), and the package does not depend on Vite (the plugin types the hooks it uses itself):

<!-- check: skip -->
```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { marksStore } from 'wallhammer-web/marks-store';

export default defineConfig({ plugins: [marksStore()] });
```

Its folder is the environment variable `WH_MARKS_DIR` when set (a scratch folder for a test), else the option `dir`
(relative to Vite's root), else `.marks/` in Vite's root (`marksFolder`). This repository passes `internal/marks/`
(ignored by git) in the planet example's `vite.config.ts`. The store answers under the page's base (`/planet/__marks`):
`GET` lists, `POST` saves, `PATCH /<id>` changes a mark and appends to its log (`fixed` needs an after-picture in the
same request), `DELETE /<id>` removes a mark and its pictures. It takes only same-origin requests on localhost, and a
change needs the header `x-marks: 1`.

The command-line tool is the package's `bin`:

```sh
npx wallhammer-marks list --open                                  # the open marks (fixed ones stay listed)
npx wallhammer-marks list --md                                    # also marks.md with links, facts and logs
npx wallhammer-marks set m0007 --status seen --by agent:clouds    # through the dev server's store
npx wallhammer-marks set m0007 --status fixed --by agent:clouds --text "the edge fades over 200 m" --after after.png
```

The folder is `--dir`, else `WH_MARKS_DIR`, else `.marks` in the working folder; the dev server (for `set` and the links
of `list`) is `--url`, else `WH_MARKS_URL`, else `http://localhost:5173`. An agent sets `seen`, `working`, `fixed`
(with an after-picture of the same view) or `wontfix`; `accepted` and `reopened` are the developer's, in the panel.

## In this repository

`node tools/marks/list.mjs` and `set.mjs` run the same tool from the package's source with this repository's defaults
(`internal/marks/` and the example server on port 5281); `shoot.mjs` takes an after-picture of a mark's view on the
host GPU and is not part of the package. `pnpm test:marks` checks the store and the tool on a scratch folder. The
workflow for agents is the skill `wallhammer-marks` (`.claude/skills/wallhammer-marks/`).
