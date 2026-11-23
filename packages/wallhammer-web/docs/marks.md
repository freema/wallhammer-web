# Marks

Marks are notes a developer pins to points of a scene while moving through it: press a key, click a fault, type a
note. Each mark keeps the picked point in world metres, the clicked pixel, a view that puts the camera back exactly,
a picture of the canvas with the pick circled and what the page can say about the place. Marks show in the page as
numbered pins coloured by their status, carry an append-only log with pictures taken after a repair, and agents read
and update them from the command line.

Only one piece of this lives in the package: `marchRay` in `wallhammer-web/world`, the pick against a height function.
The rest is workspace tooling and is never published:

| Part | Where | What it is |
| --- | --- | --- |
| The pick | `marchRay` in `wallhammer-web/world` | A ray marched against a signed gap function, pure. |
| The page's part | `examples/shared/src/marks/` | The mark mode, the pins, the panel, the picture and the store client (DOM), and the record types. |
| The store | `tools/vite/marks-store.ts` (with `tools/vite/png.ts`) | A dev-server plugin that keeps the marks in `internal/marks/`. |
| Readers and updaters | `tools/marks/list.mjs`, `set.mjs`, `shoot.mjs` | List, change a status, take an after-picture on the host GPU. |
| A page that uses it | `examples/planet/src/marks.ts` | Key `N` in the free camera of the planet example. |

Why the page's part is not in the package: the browser DOM belongs to `platform` alone, which holds the plumbing of
input, canvas and frame loop, not a review panel with its texts; a 2D canvas context is opened only in `gpu`; and the
store it talks to exists only in the workspace's dev server. The record types travel with the page's part, the store
and the command-line tools that share them, so the package gains no format it cannot store.

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

A page installs the marks with `installMarking(host, options)` from `examples/shared/src/marks/ui.ts` and gets the
script interface `MarkingApi` back (`list`, `add`, `update`, `remove`, `goto`, `compare`, `mode`, `reload`,
`snapshot`). The `MarkHost` it hands over is small: the canvas and its size, the ray under a pixel, where a world point
lands on the canvas, the pick, the current view as a URL hash that restores it, the facts of a place, a synchronous
render, a frame hook and a way to put the camera at a view. `examples/planet/src/marks.ts` is a complete host in under
200 lines.

The planet example loads its marks only when `import.meta.env.DEV` holds, so the static build of the live demos has
none of them, and a page driven by a script (`navigator.webdriver`: the picture and benchmark tools) has none unless
its hash says `marks=1`. Pictures and golden hashes are therefore unchanged.

The picture of a mark is the canvas alone: the page renders a frame and calls `toBlob` in the same task (a WebGL canvas
without `preserveDrawingBuffer` is empty once shown); the store circles the clicked pixel and refuses a picture that
reads back empty.

## Records

The store keeps one JSON line per mark in `internal/marks/marks.jsonl` (git ignores `internal/`), the picture as
`<id>.png` and after-pictures as `<id>-after-<n>.png`. A mark:

| Field | Meaning |
| --- | --- |
| `id`, `seq` | `m0007` and 7; the sequence never repeats. |
| `note`, `category` | The developer's text; `bug`, `look` or `idea`. |
| `page` | The page's path (`/planet/`). |
| `point` | `world` (metres), `distanceM`, `surface`, `place` (the host's coordinates), `accuracy` (how it was picked); null when the ray met nothing. |
| `pixel`, `canvas` | The click in physical canvas pixels; the canvas in physical and CSS pixels. |
| `view` | `hash` (restores the camera) and what else the host records. |
| `facts` | What the host can say about the place. |
| `picture`, `pictureNote` | The picture's path, or null and why. |
| `status` | `new` (also when missing), `seen`, `working`, `fixed`, `accepted`, `reopened`, `wontfix`. |
| `log` | Entries `{ seq, status, by, text, picture?, at, was? }`; it only grows. |

The store answers under the page's base (`/planet/__marks`): `GET` lists, `POST` saves, `PATCH /<id>` changes a mark
and appends to its log (`fixed` needs an after-picture in the same request), `DELETE /<id>` removes a mark and its
pictures. It takes only same-origin requests on localhost, and a change needs the header `x-marks: 1`.

## From the command line

```sh
node tools/marks/list.mjs --open                                            # the open marks
node tools/marks/set.mjs m0007 --status seen --by agent:clouds              # read
node tools/marks/shoot.mjs m0007 --attach --by agent:clouds --status fixed --text "the edge fades over 200 m"
```

`list.mjs` (`--open`, `--md`, `--json`) and `set.mjs` run on the host or in the container; `shoot.mjs` runs on the
host, on the real GPU. The workflow for agents is the skill `wallhammer-marks` (`.claude/skills/wallhammer-marks/`).
