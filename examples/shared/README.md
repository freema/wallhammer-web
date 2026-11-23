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
