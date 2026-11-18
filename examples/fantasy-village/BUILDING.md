# Building the village: a guide for builders

The base is done. It holds the layout, the terrain height, the light, the kit, the materials, the scene assembly, the
camera, the keys and `__wh`. Every part of the village is a **content module**: one file with placeholder content
that you rewrite. The placeholder shows the right signature and the right place. You do not change the scene
assembly, the materials or `main.ts`. When you miss something, say so in your report to integration.

## Who owns what (B5)

| Builder | Files |
| --- | --- |
| architecture | `src/arch/**`, `src/buildings/inn.ts` |
| buildings | `src/buildings/{cottages,forge,mill,windmill,castle}.ts` |
| terrain | `src/terrain/**` except `height.ts` (`ground`, `water`, `weir`, `bridge`, `paving`, `rocks`) |
| vegetation | `src/vegetation/**` |
| villagers | `src/villagers/**` |
| props and effects | `src/props/**`, `src/fx/**` |
| integration | everything else, `src/layout.ts`, `src/terrain/height.ts`, `src/env.ts`, `src/render/**`, `src/kit/**`, README |

You may create a new file only in your own folder. The modules registered in `src/modules.ts` have fixed names
(`inn`, `cottages`, `forge`, `mill`, `windmill`, `castle`, `ground`, `water`, `paving`, `bridge`, `weir`, `rocks`,
`vegetation`, `props`, `villagers`, `fx`). When you need another module, say so in your report and integration adds
the registration. Buildings may use the shared parts of the architecture (`src/arch/**`), but must not change them.

## Module

```ts
import type { ContentModule } from '../kit/index.ts';
export const forge: ContentModule = {
  name: 'forge',
  build(ctx) {            // runs once at start
    return { statics, parts, lights, particles, update, stats };   // every field is optional
  },
};
```

`ctx` (`kit/types.ts` BuildContext):

- `ctx.layout` is the layout from `src/layout.ts` and the single source of truth about where everything stands. Do not
  make up positions, take them from here.
- `ctx.heightAt(x, z)` returns the terrain height. `ctx.field.padY(id)` returns the floor height of a structure (its
  pad is levelled). `ctx.field.river(x, z)` returns the distance from the river and the nearest point of the river.
- `ctx.stream('name')` is a named random stream of the seed. **No `Math.random`.** Use one name per module or per
  part, for example `s.range(lo, hi, i, k)`, `s.chance(p, i)`, `s.child(i)` or, in sequence, `s.next()`.
- `ctx.sim` is the engine's simulation at 10 steps per second. The villagers may add systems to it.

## Coordinates

- The x axis points east, y up and z south. The unit is 1 m.
- `yaw` 0 faces +z (south). `rotateY(x, z, yaw)` and `yawOf(dx, dz)` are in `kit/math.ts`.
- A structure has its centre `s.x, s.z`, its `s.yaw` and the local rectangles `s.body` and `s.wings` (x, z, w, d),
  where local +z is the front. The door is in `s.door` (world x, z). `toWorld(s, lx, lz)` and `toLocal` convert the
  coordinates.
- `s.stories` × `STOREY` (3 m) gives the height of the walls. The floor lies at `ctx.field.padY(s.id)`. Take the
  plinth at least 0.6 m below the floor, because the terrain falls away around the pad.
- `Mat34` matrices are composed with `compose34(t, yaw, pitch?, roll?, scale?, out?)`.

## Geometry (kit)

- `MeshBuilder`: `b.set({cls, glow, sway, channel})`, `b.paint(rgb)`, `b.with(matrix, fn)`, `vertex`, `tri`,
  `quad`, `face`, `grid`, `append` and `bounds`. A vertex carries a position, a normal, an RGB colour, AO and flags.
- Shapes in `kit/shapes.ts`:
  - `bevelBox` is a box with a bevel, taper, lean and jitter.
  - `crookedBeam` is a crooked beam of octagonal section with sag and twist.
  - `lathe` is a solid of revolution (barrels, towers, trunks).
  - `sweep` drags a profile along a curve (ridges, cornices).
  - `tube` is a tube with a varying radius (branches, roots).
  - `rock` is a faceted stone.
  - The colour `Paint` is either RGB or a function `(p, n) => RGB`.
- Colours: `PALETTE` (`kit/color.ts`), `vary(c, VARY_RICH, s, i)`, `heightRamp`, `gradient` and `mixRgb`. The
  hand-painted look comes from the vertex colours, so vary the colours piece by piece (plank by plank, stone by
  stone, tile by tile) and darken them downward and into the corners.
- Bake the occlusion with `bakeAo(b, { ground: ctx.heightAt })` (rays in voxels, use it on the whole structure)
  and `groundAo(b, ctx.heightAt)` (darkening near the ground).
- The material class `MAT.*` drives the painted breakup in the shader: wood grain, stone blotches, plaster mottling,
  leaf clusters, fabric weave and metal sheen. Set it on every part.
- Glow: `glow` 0–1 goes into the vertex flags, and the channel `GLOW.evening` (windows, lanterns) comes on at dusk.
  `GLOW.fire` flickers all the time (forge, hearth). `GLOW.steady` glows all the time.
- `sway` 0–1 bends a vertex in the wind (leaves, grass, banners, sails). Leave trunks and walls at 0.

## What a module returns

- **`statics`**: `{ material: 'solid' | 'water', mesh, castShadow?, name }`. The static assembly merges them by
  material into spatial tiles (56 m, 256 m further out), so one tile and material come to one draw call. Build large
  batches, for example a whole cottage as one MeshBuilder. Never make one piece per shingle. A small item without a
  shadow gets `castShadow: false`. For water see the notes in `kit/types.ts` and `waterFlags`.
- **`parts`**: instanced sets (`createPartSet(name, mesh, capacity, {dynamic, castShadow, group})`, `pushPart`
  and `writePart`). One set means one draw call. Sets suit repeated pieces (trees, barrels, chickens) and everything
  that moves (villagers, the mill wheel, the windmill sails). Motion: in `update` rewrite `set.data` with
  `writePart` and set `set.dirty = true`. Villagers belong to the group `group: 'villagers'`, which the V key hides.
- **`lights`**: `PointLight` with `when: 'evening' | 'always'`. The 32 lights nearest the eye shine at once. You may
  move a light in `update`.
- **`particles`**: `ParticleSource` (smoke, steam, dust, fire, spark). They are computed on the GPU from the time;
  the total budget is 4096 particles.
- **`update(frame)`** runs every frame. **It must not allocate**, so prepare the arrays and matrices in `build`. It
  gets `time`, `dt`, `evening` (0–1), `eye` and `villagersVisible`. While paused the time stops and update is not
  called.

## Budget

In total about 1.5 M triangles and fewer than 60 draw calls. With the placeholders the scene has about 0.1 M
triangles and 25 draw calls.

| Area | Triangles | Draw calls |
| --- | --- | --- |
| inn | up to 120 k | in the statics |
| 6 cottages, forge, mill | up to 60 k per building | in the statics, plus sets for the wheel and its paddles |
| windmill, castle | up to 60 k and 120 k | in the statics, the sails as 1 set |
| terrain, water, paving, bridge, rocks | up to 300 k | in the statics |
| vegetation | up to 450 k (instances) | at most 8 sets |
| villagers and animals | up to 120 k | at most 4 sets |
| props and effects | up to 150 k | at most 6 sets |

## Checks

From the repository root:

- Typecheck: `docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'`
- Numbers: `docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && pnpm inspect'` prints the size,
  triangles, share of flipped faces and volume of every mesh and every module, and a check of the layout. Compare
  the sizes with B4. Nothing may be 10× too large, under the ground or inside out (flipped around 0 %). In the
  browser `__wh.inspect('forge')` returns the same.
- Pictures: `docker compose run --rm shot --url http://dev:5281/fantasy-village/ --presets overview,street` (presets: overview,
  street, overview-evening, street-evening, river, mill, far). They are written to `tools/shot/out/`.

## Notes on places

- **Mill** (`mill`, 33, −24) stands with its east wall on the bank above the water. Under that wall build a stone
  footing down into the river (about 3.5 m below the floor). The wheel is in `layout.millWheel` (axis, radius 2.3 m,
  bottom in the water) and the mill race runs from the weir (`layout.weir`).
- **Bridge** (`layout.bridge`): the deck lies at `deckY`, its ends are on the ground. Terrain builds the arched stone
  bridge.
- **River**: `layout.river.dense` holds points with `x, z, y` (the water level), `width` and `along`. The weir makes a
  drop of 1.9 m. The bed is 1 m below the water level. The banks are in `height.ts`.
- **Giant trees** stand in `layout.trees` with `kind: 'giant'` (4 of them). Their roots may reach 6 m from the trunk,
  but not into houses (the nearest house is 6.1 m from a trunk).
- **Points of interest** (`layout.pois`) with `kind` and `yaw` are places for the villagers: the anvil, the stalls,
  the gardens, the well, the doors and the bridge. Walking follows `layout.nav` (`new NavGraph('village.nav', layout.nav)`).
- The engine modules `gen-arch`, `gen-ground` and `gen-vegetation` are **not used**. `gen-core` and `gen-mesh` may be
  used.
