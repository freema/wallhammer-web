# Architecture kit (`src/arch`)

The kit has reusable generators for the village's buildings. It covers stone plinths, half-timbered plaster walls, windows and doors, curved shingle roofs, dormers, chimneys, signs, banners, lanterns and barrels. Each generator takes its dimensions, proportions, palette and random stream as parameters. It writes into one shared `MeshBuilder`, so a whole building becomes one static mesh (one batch). Nothing calls `Math.random`: the randomness comes from the site's named stream, so the same seed builds the same building.

The inn (`src/buildings/inn.ts`) is the full worked example.

## Files

| file | what |
|---|---|
| `site.ts` | `Site` (the working frame), wall frames, `Rect` and `rectWalls`, openings, paints (`woodPaint`, `stonePaint`, `plasterColor`), `faceOut` and `ringFace`, `cachedGround` |
| `palette.ts` | `ArchPalette` and the presets `INN_PALETTE`, `COTTAGE_RED`, `COTTAGE_RUST`, `THATCH_PALETTE`, `FORGE_PALETTE`; `paletteFor(structure)` |
| `stone.ts` | `stoneBlock`, `stonePlinth` (irregular big blocks, asymmetric piers, gaps), `buttress`, `stoneChimney` (with breast, cap, pots, smoke), `stoneSteps`, `stoneArch` |
| `timber.ts` | `timber` (one crooked hewn beam), `curvedTimber`, `timberFrame` and `frameInWall` (a storey of half-timbering with braces and overhanging plate heads), `jettyJoists`, `jettyBracket` |
| `walls.ts` | `plasterWall` and `plasterPanel` (uneven, mottled plaster with holes and an optional gable profile), `planks` |
| `openings.ts` | `windowAt` (square, arched or round; frame, reveal, glowing pane, bars, sill, shutters, flower box, light), `doorAt` (arched or square; plank leaf, ironwork, stone or timber surround, steps), `shutters`, `flowerBox`, `stud`, `blob` |
| `roof.ts` | `roofShape` (pure curve math), `buildRoof` (deck, rafters, shingles, ridge caps, bargeboards with horns), `dormer` and `dormerHole`, `roofHoleFor`, `shingle`, `board` |
| `details.ts` | `hangingSign`, `banner`, `wallLantern`, `barrel` |
| `house.ts` | `buildHouse(site, spec)`: the composer. It builds a whole body from a declarative `HouseSpec`. |
| `check.ts` | A numeric check: sizes, triangles, flipped share, and the inn's breakdown. It is not part of the app. |

## Frames and coordinates

- **Site.** A builder, the local-to-world matrix `m`, a stream `s`, a palette `pal`, and the `out` lists of lights and particles.
  - `site.at(matrix, fn)` enters a sub-frame. Geometry, lights (`site.light`) and particles (`site.emit`) placed inside it land in the right world spot.
  - `site.child('name')` gives the same frame with an independent sub-stream. Adding detail to one part then does not reshuffle another part.
- **Structure frame.** Open the site with the structure's transform: `compose34([s.x, ctx.field.padY(s.id), s.z], s.yaw)`.
  - x runs along the front and +z points out of the front.
  - y = 0 is the pad. The floor (the top of the plinth) is at `floorY`, which defaults to 0.75.
- **Wall frame** (`wallFrame(a, b, y)` or `rectWalls(rect, y)[side]`):
  - u runs along the wall, to the right as seen from outside.
  - v runs up from the wall's base.
  - w points out of the wall. The plaster surface is at w ≈ 0 and timbers stand 0.1 proud.
  - The four sides are `front` (+z), `right` (+x), `back` and `left`. Each wall runs to the right as seen from outside. Every wall builds the corner post at its start, so each corner gets exactly one post.
- **Roof frame** (`RoofShape`):
  - s runs along the ridge.
  - q runs across it, signed: +q is the frame's +z (the front for `axis: 'x'`).
  - y is the height above the wall plate.
  - `shape.heightAt(x, z)` and `shape.underside(x, z)` answer in site coordinates. Use them to cut gables, seat chimneys and place things on the roof.

## Quick start: a whole body from a spec

```ts
import { COTTAGE_RED, buildHouse, emitters, openSite } from '../arch/index.ts';
import { MeshBuilder, bakeAo, compose34, groundAo } from '../kit/index.ts';
import { chimneySmoke } from '../fx/smoke.ts';
import { cachedGround } from '../arch/index.ts';

const b = new MeshBuilder();
const out = emitters();
const m = compose34([s.x, ctx.field.padY(s.id), s.z], s.yaw);
openSite(b, m, ctx.stream(`cottage:${s.id}`), COTTAGE_RED, out, (site) => {
  const house = buildHouse(site.child('body'), {
    rect: s.body,                         // { x, z, w, d } in the structure frame
    floorY: 0.7,
    storeys: [2.8],                       // add 0.8 for a knee wall under the roof
    plinth: { rises: [{ side: 'front', u0: 0, u1: 0.8, top: 1.3 }] },
    openings: [
      { side: 'front', storey: 0, at: 0, door: { w: 1.1, h: 2.2, shape: 'arched' } },
      { side: 'front', storey: 0, at: 2.0, window: { w: 0.8, h: 1.0, shutters: true, box: true } },
      { side: 'left', storey: 'gable', at: 0, window: { shape: 'round', w: 0.7, h: 0.7, sill: false } },
    ],
    roof: { axis: 'x', pitch: 0.65, dormers: [{ facing: 'front', at: -1.6 }] },
    chimneys: [{ x: s.body.x + 1.8, z: s.body.z - 1, above: 0.8, smoke: false }],
  });
  for (const t of house.chimneyTops) out.particles.push(...chimneySmoke(site.world(t[0], t[1], t[2])));
});
const ground = cachedGround(ctx.heightAt, s.x - 12, s.z - 12, s.x + 12, s.z + 12);
bakeAo(b, { ground, cell: 0.2, rays: 12 });
groundAo(b, ground, 1.0, 0.35);
return { statics: [{ material: 'solid', mesh: b, name: s.id }], lights: out.lights, particles: out.particles };
```

### `HouseSpec` fields

| field | meaning |
|---|---|
| `rect`, `floorY`, `storeys` | The footprint, the floor height (= plinth top) and the storey heights from the bottom up. A storey under 1.6 m is a knee wall: no rail and no braces. |
| `jetty` | `{ front: 0.45 }`: every storey above the ground one stands out on that side. The ground storey gets joists, curved brackets and a plank soffit there. |
| `walls`, `storeyWalls` | Leave a wall out (`false`), or build only `{ from, to }` along it where another body joins. `storeyWalls[k]` overrides this for storey k. |
| `plinth` | `rises` (piers on a side, u range and top height), `gaps`, `buttresses` (foot x and z and outward yaw), and `below` (how deep it reaches into the ground). |
| `frame` | Options passed to `frameInWall`: `spacing`, `width`, `corner`, `braces` (`'auto' \| 'diagonal' \| 'cross' \| 'none'`), `plateOverhang` and so on. |
| `openings` | `{ side, storey: k \| 'gable', at, window \| door }`. `at` is the offset from the wall's middle along u. A window's `v` defaults to 1.0 on the ground floor, 0.85 above and 0.5 in a gable. A door's `steps` default to the floor height. |
| `roof` | Fields:<ul><li>`axis` (the ridge runs along x or z)</li><li>`pitch` (rise as a share of the span)</li><li>`eave`, `gable` (overhangs)</li><li>`ends` (`'gable'` or `'open'`)</li><li>`sag`, `flare`, `curl`, `dip` (the curve)</li><li>`shingles`</li><li>`dormers` (`{ facing, at, width, height, window }`)</li><li>`holes` (extra house-local rectangles with no shingles, e.g. where a roof runs into another body)</li><li>`gableFrame`</li></ul>`false` means no roof. |
| `chimneys` | `{ x, z, w, d, above \| y1, y0?, pots, breast, smoke }`. A chimney inside the walls starts under the roof; one outside starts in the ground. Each chimney cuts its own hole in the shingles. |

`buildHouse` returns `{ storeyY, eaveY, rects, walls, roof, chimneyTops }`. Use the returned `walls[k][side]` to put details on a façade: `site.onWall(house.walls[0].front, (w) => wallLantern(w, { u, v }))`.

## The generators alone

Everything `buildHouse` does is open to use directly. That is what the forge's open front, the mill's tall stone body or a shed need.

```ts
// A stone plinth along any closed outline (wall order), with a pier and a gap for a joining wall.
stonePlinth(site, { ring: rectRing(rect), top: 0.8, rises: [{ edge: 0, u0: 0, u1: 1.2, top: 1.6 }], gaps: [{ edge: 1, u0: 2, u1: 5 }] });

// One storey of half-timbered wall in a wall frame: plaster with holes, then the frame, then the openings.
const wall = rectWalls(rect, 0.8).front;
const win = { u: 2.0, v: 1.0, w: 0.9, h: 1.1, shape: 'round' as const, box: true };
site.onWall(wall, (w) => {
  plasterPanel(w, { height: 2.8, to: wall.length, openings: [windowOpening(win)] });
  frameInWall(w, wall.length, { height: 2.8, openings: [windowOpening(win)], braces: 'cross' });
  windowAt(w, win);
});

// A roof on its own: shape first (pure math), then the covering, with holes for dormers and chimneys.
const shape = roofShape({ x: 0, z: 0, y: 3.6, axis: 'x', length: 8, span: 6, rise: 4, sag: 0.3, curl: 0.4 });
const d = { s: 1.2, side: 1 as const };
buildRoof(site, shape, { holes: [dormerHole(shape, d), roofHoleFor(shape, 2, -1, 1.1, 0.9)] });
dormer(site, shape, d);
stoneChimney(site, { x: 2, z: -1, y0: shape.heightAt(2, -1) - 1, y1: shape.ridgeY + 1, smoke: false });

// Gable infill under any roof: the plaster's `top` follows the roof's underside.
const g = rectWalls(rect, 3.6).left;
site.onWall(g, (w) => plasterPanel(w, { height: 5, to: g.length, breaks: [g.length / 2],
  top: (u) => { const p = wallPoint(g, u, 0); return shape.underside(p[0], p[2]) - 3.6; } }));
```

### Hints for the other buildings

- **Cottages:**
  - Use `buildHouse` with one storey, or with a storey and a knee wall.
  - Use `COTTAGE_RED`, `COTTAGE_RUST` or `THATCH_PALETTE` (via `paletteFor(s)`).
  - An L plan is two bodies: give the second one `walls` and `storeyWalls` ranges where it meets the first, and a roof `holes` entry where its roof runs into the first body (see the inn's wing).
  - A thatch roof is not in the kit yet. A `roofShape` with your own covering over its surface (`shape.point(s, q)`) is the way.
- **Forge:**
  - Use `FORGE_PALETTE`.
  - For an open front, leave out the front wall (`walls: { front: false }`) and set `timber` posts on stone pads (`stoneBlock`) under the plate yourself.
  - Give it a big `stoneChimney` with a `breast`, and use the forge-fire effects from `src/fx` for the smoke (`smoke: false`).
- **Mill:**
  - For the stone ground storey, set high plinth `rises` all around (`top` = the storey height). For a fully stone storey, build `stonePlinth` with `top` at the first floor and give `buildHouse` that `floorY`.
  - Add a timber upper storey and a roof with `pitch` around 0.7.
  - `jetty` works on any side.

## Shingles (B2)

- Rows run from the eave up the slope, about 0.44 m apart. Shingles are 0.5–0.7 m wide, and each row is offset by half a shingle.
- Every shingle is its own slab (16 triangles): cut lower corners, a bevelled bottom edge, lighter where exposed and darker where overlapped.
- The bottom edges are ragged and the first row more so. About 2 % are missing, about 7 % are visibly skewed, and 22 % take an accent colour. A slow weathering noise runs over the whole roof.
- The surface curves:
  - The ridge sags in the middle.
  - The slopes are bell-cast: steep at the ridge and flatter toward the eaves, with a slight dip.
  - The eave corners lift and the ridge ends rise at the gables.
- Ridge caps lie in an inverted V. The bargeboards cross above the ridge as horns.
- The roof is about 20–30k triangles for an 11 × 9 m body. Lower the count with `shingles: { exposure: 0.5, width: [0.6, 0.8] }`.

## Moving parts and light

- **Lights:** `windowAt({ light: true })` and `wallLantern` add warm `PointLight`s with `when: 'evening'` to `site.out.lights`. Panes and lantern glass glow on the evening channel.
- **Moving parts:** the sign's board and chains, the banner's cloth and the flower boxes use the vertex `sway` flag, which is the wind sway of foliage, weighted by how far they hang. They move with no part set, no draw call and no per-frame work.
- **Smoke:** `stoneChimney` can emit its own smoke. Buildings use `chimneySmoke` from `src/fx/smoke.ts` (`smoke: false`) so that all chimneys look alike.

## Budget

Bake AO once per building with a `cachedGround`. Asking the terrain directly makes `bakeAo` take minutes.

| piece | triangles |
|---|---|
| inn | about 117k (main body 83k, wing 28k, front details about 5k) |
| window with shutters and a box | about 1.5–2.4k |
| arched door with steps | about 1.9k |
| chimney | 1.5–6k |
| 8 × 6 roof with a dormer | about 15k |
| simple cottage | about 26k |
