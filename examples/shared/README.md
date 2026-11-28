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
- `mesh.ts`: the mesh builder of the figures (`FigureMesh`, the materials `MAT`, rings and colours; `tone` paints
  faces by their place, for two tones on one skin).
- `biped.ts`: what any two-legged figure shares: the two sides, the bones of a biped, the walk cycle and its step marks,
  and a kite (a lock of hair, a fringe).
- `glyphs.ts`: the six painted signs as flat polygons and `glyphFaces`, which lays a sign into a plane.
- `steed.ts`: the steed, a slender long-legged runner (half fox, half antelope) of the same kind of build: a trunk of
  four bones (body, chest, loin, croup), a neck of two, a fox's head (a lower jaw that opens, a tongue of two bones, an eyelid over each eye) with two long narrow leaf feathers of two bones
  each instead of ears, four legs (a shoulder blade over the fore legs, upper, lower, cannon, pastern, paw and a toe
  bone the paw turns about) and a long tail of five bones ending in two leaves; a russet coat and cream under the belly,
  on the throat and down the inside and back of the legs by the faces' place, parted along one clean edge
  (`FigureMesh.tone`); the shoulders and the haunches are the trunk's own surface, the legs growing out of it, a woven rug with a zigzag band and tassels, a braided
  rope harness with a soft rein lying over the withers and stirrup loops, and a glowing lantern; motions of the trunk, neck, head, feathers and
  tail for standing (with twitches from named hash streams), walk, trot and a rotary gallop; sockets for a rider
  (`seat`, `gripL`/`gripR`, `stirrupL`/`stirrupR`); its ways of stepping (`STEED_STEPS`, with the gallop's stretch of
  the legs), its speeds (`STEED_SPEEDS`, the one source) and their bands (`gaitBands`).
- `quad-gait.ts`: `QuadGait`, what moves the steed: the engine's `StepCycle` for the hooves (its `reach` narrowed
  each frame for a hoof standing below its pivot, a stair lower, so it is lifted before the leg runs out), a
  `TwoBoneReach` per leg (at a gallop the legs stretched out beyond their path and folded only in part of the swing;
  optional per leg: a heel that rises about the toe, a swing raised rather than pulled in when out of reach; per
  pattern a share of the fold), the trunk lowered
  and tilted onto the ground under the hooves, its graph blended by speed on the cycle's phase,
  the head turning to look and the tail lagging; it keeps the steed's clock, effort and breath (`life`), from which
  the kind's optional `steps.life` moves the face (panting after a gallop, a yawn, a lick, blinks).

Each example keeps its own layer that draws the figures (its `cast.ts`), because the worlds they stand in differ.

## `src/vehicles/`

- `compact.ts`: a compact car of the same chunky build, about 4.2 × 1.8 × 1.4 m, without badges: `compactCarMeshes`
  gives the body (lofted sections with wheel arches, framed windows, bumpers, lamps, mirrors and an interior), a left
  front door to be mirrored for the right, and a wheel (tyre, five-spoke rim, hub) with its outer face at +x; the
  materials `CAR_MAT` (flat, paint, glass, head, tail and reversing lamps); `COMPACT_CAR`, its sizes, the axles and track
  the wheels are set at, the door's hinge, the seat and the spot beside the door; `doorHinge`, the door's turn about
  its hinge; `compactRoofLoadMesh`, a load for its roof in the body's frame (a rack on four feet with three strapped
  wooden crates and a rolled bundle of canvas), and `COMPACT_ROOF_LOAD`, where that load's mass is. Meshes only: the
  example that drives it chooses the physics and draws it.
