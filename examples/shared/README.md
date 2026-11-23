# Shared example code

Code that more than one example uses. It is a private workspace package like the examples, but not a page: it has no
`index.html` and no Vite config, so the example server and the static build of the live demos do not list or build it.

Examples import its files by relative path with the `.ts` extension, for example
`import { PATHFINDERS } from '../../../shared/src/figures/pathfinder.ts';`. It may import only the engine, without its
content modules (`gen-arch`, `gen-ground`, `gen-vegetation`), and never another example; the layer check
(`tools/layers/check.ts`, rule `example-imports`) enforces both.

## `src/figures/`

The pathfinder, a walking figure built from code, and what it is built with:

- `pathfinder.ts`: the pathfinder kind of figure: its bones, its parts as flat-shaded meshes, its motions and the looks
  of its variants (`PATHFINDERS`, `PATHFINDER_TORCH`, `PATHFINDER_MIRROR`).
- `kind.ts`: what a kind of figure is (`FigureKind`, `FigureMotion`, `FigureLook`), the bone builder `Bones` and small
  helpers of poses and motions.
- `mesh.ts`: the mesh builder of the figures (`FigureMesh`, the materials `MAT`, rings and colours).
- `biped.ts`: what any two-legged figure shares: the two sides, the bones of a biped, the walk cycle and its step marks,
  and a kite (a lock of hair, a fringe).
- `glyphs.ts`: the six painted signs as flat polygons and `glyphFaces`, which lays a sign into a plane.

Each example keeps its own layer that draws the figures (its `cast.ts`), because the worlds they stand in differ.

## `src/marks/`

The page's part of the marks: notes a developer pins to points of a dev page (see
[Marks](../../packages/wallhammer-web/docs/marks.md)). DOM only, no WebGL context; the store is the dev-server plugin
`tools/vite/marks-store.ts`.

- `types.ts`: the record (`Mark`, `MarkDraft`, `MarkLogEntry`, the statuses and categories) and what a page hands over
  (`MarkHost`, `MarkingOptions`).
- `ui.ts`: `installMarking(host, options)`: the mark mode, the note box, the panel and the script interface
  (`MarkingApi`).
- `pins.ts`: the numbered pins over the canvas, coloured by status.
- `capture.ts`: the picture of the canvas (a render and `toBlob` in the same task).
- `store.ts`: the client of the store.

Each page keeps its own host (`examples/planet/src/marks.ts`): the pick, the view hash and the facts depend on its world.
