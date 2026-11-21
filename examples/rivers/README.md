# Rivers and paths example

An island of 3.2 km with mountains, a plain and cliff benches, and the water on it: the sea, lakes in the hollows and
lines of running water from the springs to the sea, with bends where the ground is level and falls where it is
steep. Footpaths join its places (trodden earth, stepping stones, flags, steps, boards, fords and footbridges),
and walkers walk them. Everything comes from code and a seed; it imports only `wallhammer-web`, without the content modules
(`pnpm check:layers` enforces that).

## The rule

Water is never a ribbon drawn on the ground. The plan (`src/plan.ts`) gives a level of water along every line and
for every lake; the ground (`src/ground.ts`) is only ever cut down to it, never raised; and water is wherever the
ground lies under the level that may stand there. The sea (level 0), the lakes and the rivers follow the same rule,
so a river cannot stand above its banks or run uphill, and every shore is the real contour of the ground.

The page draws exactly that. The ground is a grid of 1281 × 1281 points every 2.5 m (`src/ground-mesh.ts`). The
water is one sheet over the same grid (`src/water-mesh.ts`): a cell is drawn where one of its corners is wet, a wet
point lies at its level, a dry one at the highest level of its wet neighbours, so the sheet runs on level under the
bank and the ground cuts the shoreline. One material draws all of it in a single blended draw
(`src/water-material.ts`): the water's own colour by the depth to the bed, the mirror of the sky, small waves that
are carried along where the water runs, a white veil where the sheet hangs as a fall, foam on steep running water
a boil of foam in the pool under a fall and a line of foam on the sea's shore. The bank (wet gravel, sand, silt under
the water) is drawn by the ground's material from each point's height over the water (`src/ground-material.ts`).

Two things stand on top of that so the island is not bare. Mist rises from the foot of every fall higher than 3 m
(`src/mist.ts`: looping sources for the engine's `ParticleLayer`). Woods grow in patches and in a belt along the
water, not on steep ground, on the beach, above the tree line or on a path (`src/trees.ts`): about 30 000 trees of a
few triangles each, baked into chunked meshes that the ground's material draws; the grass is lusher near water and
darker under the trees.

## Paths

Footpaths follow the same order as the water: a plan first, then the ground shaped to it, then what each stretch is
made of. The plan (`src/paths.ts`, `pathPlan`) is a pure function of the water plan and the field of the whole square;
`layPaths` (`src/path-ground.ts`) then cuts the treads into the field; `pathKinds` (`src/path-kinds.ts`) gives every
station a kind; and `pathProps` (`src/path-props.ts`) builds what lies and stands there. The ground's material
(`src/ground-material.ts`) draws only the trodden earth. Everything with a height is faceted geometry in the ground's
own vertex layout, drawn by the ground's material, so it is lit, shadowed and casts shadows like the trees.

The places come from the water plan: beside the mouth of the main line, beside its widest bend, below the highest
fall, on the shore of the largest lake and beside the mouth of another line that reaches the sea, each on dry ground
that is not steep, clear of the water. A leg between two places is the cheapest route over a grid of every fourth
point of the field (10 m); a move costs its length and more the steeper it is, and none may be steeper than a set
grade. It never touches the sea or a lake, and every wet point of a line costs as much as a long detour, more the
deeper the water, so a path fords a brook where it likes and a river rarely and squarely. Later legs pay little for
ground an earlier leg took, so they join it and fork from it at junctions. Each path is then rounded and resampled
into stations every `PATH_STATION_M` (2 m), each with the height of its tread. A walked line is not ruled: where the
ground is gentle (a grade under 6 % over 8 m, the wander gone by 16 %) the rounded line wanders to either side in two
waves of 74 m and 23 m, scaled by `WANDER_M` (3.2 m). It eases in over `WANDER_EASE_M` (26 m) from the path's ends and
from its crossings of water, which stay straight, and on a slope it keeps to the grade the route found.

Within 1.2 m of a centreline the ground is brought to the path's height, easing back to its own by 4.2 m, so a path
across a slope lies on a narrow bench; nothing is moved under or within 0.5 m above water, and a ford has no tread. No
tree stands within 2.6 m of a centreline.

What a station is made of (`KIND`) is decided in this order, a later rule over an earlier one: steps, boards, stones,
flags, and the crossings of water last, over whatever lies there. Grades are taken over two stations either side
(8 m). A run of steps, boards or stones shorter than its least length goes back to earth, after short gaps of earth
inside it are filled.

| Kind | Where | What is built |
| --- | --- | --- |
| earth | wherever no other rule applies | the trodden earth only, now and then a small stone in it |
| stones | in the open (wood cover under 0.35), in stretches chosen by a noise of 46 m; at least 6 stations | stepping stones a stride (0.7 m) apart, alternately left and right of the middle, each in a ring of bare soil |
| flags | within `FLAGS_M` (14 m) of a named place, over earth or stones | rows of two or three laid flags across the path, a row every 0.52 m |
| steps | a grade over `STEP_GRADE` (0.2); at least 3 stations | stone steps 0.5 m deep with level tops, each standing out of the slope by its rise; boulders beside them |
| boards | earth with a grade up to `BOARD_GRADE` (0.06) where the cover's `damp` is over `BOARD_DAMP` (0.8), in stretches chosen by a noise of 70 m; at least 7 stations | boards every 0.33 m on two beams, their top `BOARD_LIFT_M` (0.16 m) over the ground, ramped over `BOARD_RAMP_M` (3 m) at each end |
| ford | a crossing wider than `BRIDGE_MAX_M` (19 m), or one of 2 m or less | stones every 0.78–0.94 m standing on the river bed, their tops about `FORD_TOP_M` (0.13 m) over the level; flat stones on the banks |
| bridge | a crossing wider than 2 m and up to `BRIDGE_MAX_M` | a footbridge (`Bridge`) straight from bank to bank: two beams, boards, posts and rails on both sides, piles; its deck (`deckAt`) arched by at least 0.16 m plus 1.4 % of its length, and enough to stand 0.6 m over the water in the middle |

A crossing is a run of stations in a line's water with one station of bank either side, carried up to three stations
farther each way until the ground stands 0.3 m over the water. Every station also has a `wear`, how much trodden earth
the ground shows (earth 1, steps 0.85, flags 0.75, bridge 0.5, stones 0.3, boards 0.12, ford 0), averaged over two
stations either side so no kind begins on a line; a `lift`, the height of what is walked on over the ground (0.05 m on
stones, 0.045 m on flags, the boards' top with its ramps); and on a bridge its `deck`. `treadAt` gives the height of
what is walked on at a point: a bridge's deck, the tops of a ford's stones, or the ground plus the lift, where the
ground is `groundHeightAt` (`src/ground-mesh.ts`), the ground exactly as its mesh draws it.

Each ground vertex carries the vector to the nearest point of a centreline, one for each of the plan's two sides, and
the `wear` of that path there (`a_pathOn` z, w); the material takes the vector's length per pixel as the distance from
the path (`src/ground-mesh.ts`). A vector, not a distance: the distance has a crease along the centreline that a mesh
coarser than the path cannot interpolate, while the vector runs through zero in a straight line. Two paths that come
near each other get different sides, so the vectors to two paths are never interpolated into one that points at
nothing. The tread reaches 0.5 m to either side of the centreline at full wear and 0.24 m at none, both varied by 30 %
with a noise, and is fainter where the wear is low; beside it the grass is worn. A path that ends on another (a
junction) is drawn `JOIN_PAST_M` (0.35 m) past its end (`pastJunction`), so its tread runs into the other path's
instead of thinning to a point a cell short of it.

The verge is built along both sides every 0.5 m, except on bridges and in fords: tufts of grass in clumps, taller
where it is damp, with a flower now and then; ferns instead under trees; stones, a few everywhere and many larger ones
beside steps; and now and then a fallen trunk beside a trodden line in a wood. Nothing of it stands nearer to the
centreline than the feet keep clear (0.5 to 0.82 m by kind) or on ground less than 0.12 m over the water. A cairn of
four or five stones stands 1.9 m from every named place and a signpost 1.7 m from every junction, each at the dry spot
round it that lies farthest from every path; the signpost has up to three arms, along the paths that leave the
junction and both ways along a path that runs through it.

What it does not do yet:

- Where a leg climbs a steep mountainside (a move of a route may climb 45 %, and 70 % where no gentler route can turn
  back on itself: its hairpins), the narrow tread on the 2.5 m mesh looks rough.
- From far above a path is not seen: the edge of its tread is as soft as a pixel is wide, so with distance it thins
  into a faint line and then disappears, by design rather than flickering.

## Walkers

Little travelling figures walk the paths (`src/walkers.ts`): the pathfinder figure, a stocky traveller in a poncho
with a pack, a bedroll and a lantern on a pole (`examples/shared/src/figures/`, shared with other examples). It is built from code as flat-shaded parts on the
bones of a skeleton of the engine's motion module; its motions are pure functions of a time, sampled on the CPU every
frame, and each part is one instance set of the engine, lit like the ground and the trees and drawn into the shadow
map (`src/figures/cast.ts`). Its looks differ in colours, neckwear, hair and the sign on the chest.

There are 7 to 10 walkers, chosen from the seed: mostly alone, one or two pairs (the second 3.5 m behind the first),
one of them carrying a torch. A walker walks what the path is made of: the trodden line, the stones and flags, the
steps, the boards, a bridge's deck and the stones of a ford. A path is cut only where its stations come within
`CROWD_M` (3.5 m) of a station of an earlier path, so at a junction the walkers of the later path turn back before they
reach those of the earlier one; only stretches of at least `MIN_STRETCH_M` (80 m) take walkers. A walker's route is a
closed loop over its stretch: out along the middle of the path, `SIDE_M` (0.12 m) right of the centreline, swinging
out over the last `END_EASE_M` (9 m) to `END_SIDE_M` (0.58 m), a half-circle of that radius at the end, back along
the other side, a half-circle at the start. Everybody walks at the same speed, so nobody overtakes and nobody appears
or vanishes. Two walkers of one loop that come toward each other step aside, each to its right, by up to `ASIDE_M`
(0.46 m) more, beginning `PASS_M` (7 m) apart and fully from `PASS_NEAR_M` (2.6 m), as much as they face each other,
and come back to the middle behind each other. Where the path is narrow there is less room (`ROOM`: 0.9 of that on
steps, 0.75 on boards, 0.6 in a ford, 0.55 on a bridge), and none near the ends, where the walker has swung out
already. Every walker carries its pole on the right, the outer side.

The feet follow the metres: a walker moves at the walk motion's own speed (one pass, two steps, carries it 1 m in
0.8 s), and the motion's time is the metres walked, so no foot slides. The height is that of what is walked on under
the figure (`treadAt`), sampled every 0.5 m along the loop and smoothed over 1 m either side, so the figure does not
jitter on the 2.5 m mesh; the figures stand upright. Where they are is a pure function of the page's animation time,
so `__wh.setTime(s)` freezes them with everything else.

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://localhost:5281/rivers/>. Building the island takes two to three seconds; a bar in the middle of the
page shows its stages (the engine's `Progress`): the build runs in slices of about 40 ms that give the browser the
main thread between them, so the page stays responsive and the bar moves.

- Two cameras; `F` switches between them, and the new one starts from what the other one shows.
  - Orbit (default): drag to orbit, use the wheel to zoom.
  - Free flight (`FreeRig`): drag to look, `W` `A` `S` `D` or the arrows to fly, `E` / `Space` up, `Q` / `C` down,
    `Shift` faster, the wheel sets the speed (which also grows with the height). The eye stays at least 1.5 m above
    the ground and above any water. Back in orbit, the target is where the view meets the ground or the water.
- Keys `1`–`9` and `0` jump to the views listed in the panel (`island`, `fall`, `fall-above`, `bends`, `bank`,
  `mouth`, `upper`, `lake`, `path`, `path-above`; a view whose feature the seed lacks is left out), in both modes.
  `path` looks along the first path from a walker's eyes, `path-above` at the same place from 24 m over it.
- The view `walker` (last in the list) looks at the first walker from behind, about 6 m away, and follows it: while
  it is active the orbit's target tracks the walker every frame, and dragging and the wheel still orbit and zoom round
  it. `K` follows the walkers in turn (the first, the second, …, then none); any other view, or free flight, stops
  following.
- The panel shows the plan's numbers, among them the count of paths and their total length, and the count of
  walkers.
- URL hash: `#seed=3&view=fall&free` (`seed` default 1, `view` one of the names above, default `island`; `free` or
  `mode=free` opens in free flight).
- `window.__wh`: `ready`, `presets()`, `setView(v)` and `getView()` (orbit states; in free flight `getView()` gives
  the orbit `F` would return to), `mode()` and `setMode('orbit' | 'free')`, `freeState()` (the free camera's position,
  yaw, pitch and clearance), `progress()` (the loading `ProgressReport`), `settled()`, `setTimeOfDay(h)`,
  `setTime(s)`, `stats()` (with `buildMs` and `loadMs`), `measureFrame(n)` (milliseconds of one frame of the
  current view, the mean of `n` synchronous renders), `checks()`, the plan's numbers (lines, lakes, falls,
  stretches where a level rises: 0), `paths()`, per path the places it joins, its length, its steepest grade over
  10 m, its fords and the widest of them, `walkers()`, per walker at the current time its position, heading
  (degrees, 0 toward −z, 90 toward +x), look (`variant`), motion, path, the stations of its stretch, the length
  of its loop, the metres along it and the walker it follows in a pair (`leader`, −1: none), and `following()` and
  `follow(i)`, the walker the `walker` view follows (−1: none).

## Pictures without a browser

`scripts/pictures.ts` draws the same plan on the CPU: a map with the paths on it (centrelines yellow, fords magenta,
places as small squares), the profile of the largest line, the same views as the page (the ground within 0.6 m of a
centreline tinted earth) and two close-up maps, into `tools/shot/out/rivers/` (ignored by git). It prints the checks
of the water, one line per path (its places, length, steepest grade, fords) and the time the path plan took. In the
container:

```sh
docker compose exec -T dev sh -c 'cd /app && node examples/rivers/scripts/pictures.ts 1'        # seed 1
docker compose exec -T dev sh -c 'cd /app && node examples/rivers/scripts/pictures.ts --stats'  # numbers of seeds 1–8
```
