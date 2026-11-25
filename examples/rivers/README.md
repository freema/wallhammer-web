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

## Brooks

The lines are drawn into the ground's 2.5 m mesh and start from a basin of 220 nodes of the plan's 20 m grid; the small
watercourses above them are brooks and streams (`src/brooks.ts`), 0.8 to about 2.3 m of water, narrower than the mesh
can carve. The engine finds and sorts them: `traceChannels` traces the plan's drainage from the brooks' threshold
(default 40 nodes, 1.6 ha), `channelOrder` gives each channel its Strahler order, `channelFlow` the flow it hands on,
and `classifyByThresholds` its class from that flow: a brook, from 110 nodes a stream (deeper, its water further under
its banks), and from 220 the lines' own. A brook runs from its spring down its channel into another brook,
or to the water of a line, a lake or the sea, which it ends a little inside.

- Its course is the chain of nodes smoothed and slid into the lowest ground within 6 m. On level ground it meanders: a
  chain of bends, each with its own length (8 to 15 widths of the water, the whole bend) and depth (1 to 2.5 widths)
  from the brook's own hashes, mostly to alternate sides, never tighter than 2.2 widths; the meander fades out as the
  ground steepens and toward both ends. Its shore is the first point where the ground lies under the water's level;
  it goes on 6 m past it, under that water.
- Where brooks meet there is no junction of strips. At each meeting of the channels the larger brook in and the one
  out are one brook, the stem, one strip through it; every other brook in is a tributary, a strip of its own that
  runs to the stem's middle and ends there. Its last stretch curves to meet the stem at about 45°, pointing
  downstream (`ENTRY_ANGLE`); it leaves its own course before it comes within three of the larger width of the two of
  the stem, so the two never run side by side. Its entry lies a little down the stem, at least four of the stem's
  widths (8 m) from another tributary's and clear of the stem's end and of the last metres before its mouth. Below
  the entry the stem's basin, and so its width, grows by the tributary's over 10 m (`ENTRY_GROW_M`), and the stem is
  never more than 1.3 times as wide there as above it (`JOIN_WIDEN`). So three brooks in and one out are a stem and
  two tributaries entering a few widths apart. A tributary that cannot be led in so ends where it came near (or is
  left out when too short); no brook is led into one that drains into it. Brooks that run together for more than
  6 m above their meeting meet further up instead, and several brooks that would end in one hollow (at the head of a
  line) end as one, at one mouth.
- The top of its banks is the lowest ground across it and never rises downstream. Over the 6 m before its shore its
  water comes down to the level of the water it runs into, and past the shore sinks 6 cm under it; the banks come down
  with it. A tributary's banks come down to the stem's at the stem's edge at no more than 6 %, and its bed to the
  stem's, so the cut ground has no step there; where its own banks lie lower than the stem's there, the stem's come
  down to them instead (gently above, level below). Past the stem's edge its water sinks a few centimetres under the
  stem's.
- It is drawn as two strips of the engine (`stripNet`, `stripMesh` in `src/brook-mesh.ts`): the bed, a cut bank and a
  dished bed (0.4 m deep for a brook, 0.55 m for a stream), and the water 0.15 or 0.2 m under the top of the bank, 0.7
  of the bed's width. The strips have no nodes; every line ends square. The width narrows to 45 % at a spring and wanders up to ±35 %
  along, wider on level stretches (pools) and narrower on steeper ones (riffles); the water's share of the bed wanders
  on its own (±12 %), so its edges and the bank's are never parallel. Its half-width is never more than 0.8 of the
  radius of its bend, so a strip never folds over itself on the inside of a tight bend. Near a mouth the water spreads
  over the whole bed. Past its shore the brook fades out under the water it runs into, and a tributary fades out
  wherever it lies over its stem's water, at its edges too (`a_coarseShift` of the strip's layout carries the fade),
  so no end of a brook is seen from any side and no two waters lie over each other.
- The ground is cut under the bed (`stripCarve`), and every corner of a mesh cell the bed touches is cut under the
  water, so the coarse mesh never rises through it; never across a path's tread, where the brook runs over the path,
  and never under the water that may stand there (a line's, a lake's or the sea's): it would flood, and that water
  would spread up the brook's channel as a sheet. Beside the last metres before a shore no shoulder is cut, only the
  cells the strip touches, so the bank of the water is notched, not flattened to a shelf; the bank of that water is
  drawn from the ground as it was before the brook cut it (`carveBrooks` hands it to `groundPieces`).
- The materials (`src/brook-material.ts`): silt and gravel on the bed; on each bank damp grass reaching down to a
  ragged line of its own, earth only in patches, a pale gravel bar on the inside of a bend and a darker cut on its
  outside (the mesh writes each vertex's bend into the strip's attributes); toward a mouth the earth and the bar give
  way to grass. The water has the colour of the lines' shallows and is clear, the bed showing through it, a little
  darker in a pool; fine soft ripples drawn out along the flow and carried down it, and short white streaks only on a
  riffle. Over the last 7 m before a mouth it takes the look of the water it runs into: calm, deeper, all the sky's
  mirror. The strips lie on the ground's triangles, so the water is drawn level but for its ripples and the bed under
  it lit as level, and the grade that makes a riffle is the water's along the brook, smooth between its points (the
  mesh writes it into the strip's attributes): no facets show. A far brook stays at least about a pixel wide
  (`stripWiden`).
- Small faceted stones (`src/brook-stones.ts`) lie on the bed and its edges, a few half out of the water: more on a
  riffle and on the inside of a bend, few in a pool; none in the last 2 m before its shore or where the water of a
  line, a lake or the sea stands. They use the ground's layout and material.
- Paths cross a brook anywhere (a point of a brook costs a few metres, so they do not run along one); no tree stands
  within 1.5 m of one.

Hash `brooks=0` (or `off`) leaves them out and the page is as it was without them; `brooks=<nodes>` sets the threshold
(8 to 219: 15 gives a brook in nearly every hollow, 120 only the larger streams). The views `brook` (one course from
its spring to the water it runs into, from the air) and `brook-near` (its last stretch from the bank at walking height)
come after the others, then the close views `brook-mouth-1`, `brook-mouth-2` (the two mouths with the largest basins at
least 150 m apart) and `brook-join-1`, `brook-join-2` (the same for tributaries' entries), each low and oblique from about 8 m and,
with `-top`, from 22 m straight over it. The panel gives their numbers; `__wh.brooks()` adds `brookCrowding`: mouths
within 15 m of another, and twins, brooks side by side for more than 6 m (a tributary's curve into its stem left out).
`node scripts/pictures.ts --brooks` prints both for seeds 1 to 4 and fails on a twin longer than 8 m or more than two
crowded mouths.

What it does not do yet: a brook that crosses a steep drop runs down it as a steep chute with foam, not a fall; a brook
that the mesh's water cannot be kept under (a ford, a few points on a cliff) lies on the ground there. A tributary's
fade over its stem follows the strip's vertices, so from straight above a faint edge of it can show. The entry angle
is aimed at, not enforced: a few entries meet their stem at 25 to 70°. A mouth on a steep bank is a notch in the bank
down to the water.

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
  The brooks' views `brook` and `brook-near` follow them (from the hash when they are past the tenth).
  `path` looks along the first path from a walker's eyes, `path-above` at the same place from 24 m over it.
- The view `walker` (last in the list) looks at the first walker from behind, about 6 m away, and follows it: while
  it is active the orbit's target tracks the walker every frame, and dragging and the wheel still orbit and zoom round
  it. `K` follows the walkers in turn (the first, the second, …, then none); any other view, or free flight, stops
  following.
- The panel shows the plan's numbers, among them the count of paths and their total length, and the count of
  walkers.
- `N` switches the mark mode in both cameras (dev server only, not in the live demo): a click pins a note to the
  ground or the water, picked against the surface the free camera keeps clear of (`heightPick` over `surfaceAt`; trees,
  props, walkers and the mist are not in it), kept in `internal/marks/` by the dev server's store; one call to the
  engine's `installEngineMarking` in `src/main.ts`, made once the build has set its first view (Marks in the engine's
  docs). The drag and the wheel do not orbit or look while it is on; the flying keys still work; `N` or Escape leaves
  it. A mark's hash is the seed, `free=1` in free flight and the field of view (`fov=`) plus the exact view and the
  clocks (`mkview=`, `mkclock=`); a mark made while the orbit follows a walker comes back without the following.
  `marks=1` turns the marks on in a page driven by a script, `marks=0` hides the pins.
- URL hash: `#seed=3&view=fall&free` (`seed` default 1, `view` one of the names above, default `island`; `free` or
  `mode=free` opens in free flight; `fov=<degrees>` sets the field of view after the view; `brooks=0` leaves the
  brooks out, `brooks=<nodes>` sets their threshold, see Brooks).
- `window.__wh`: `ready`, `presets()`, `setView(v)` and `getView()` (orbit states; in free flight `getView()` gives
  the orbit `F` would return to), `mode()` and `setMode('orbit' | 'free')`, `freeState()` (the free camera's position,
  yaw, pitch and clearance), `progress()` (the loading `ProgressReport`), `settled()`, `setTimeOfDay(h)`,
  `setTime(s)`, `stats()` (with `buildMs` and `loadMs`), `measureFrame(n)` (milliseconds of one frame of the
  current view, the mean of `n` synchronous renders), `checks()`, the plan's numbers (lines, lakes, falls,
  stretches where a level rises: 0), `paths()`, per path the places it joins, its length, its steepest grade over
  10 m, its fords and the widest of them, `walkers()`, per walker at the current time its position, heading
  (degrees, 0 toward −z, 90 toward +x), look (`variant`), motion, path, the stations of its stretch, the length
  of its loop, the metres along it and the walker it follows in a pair (`leader`, −1: none), and `following()` and
  `follow(i)`, the walker the `walker` view follows (−1: none), and `brooks()`, the brooks' threshold and numbers
  (null without brooks).

## Pictures without a browser

`scripts/pictures.ts` draws the same plan on the CPU: a map with the paths on it (centrelines yellow, fords magenta,
places as small squares), the profile of the largest line, the same views as the page (the ground within 0.6 m of a
centreline tinted earth) and two close-up maps, into `tools/shot/out/rivers/` (ignored by git). It prints the checks
of the water, one line per path (its places, length, steepest grade, fords) and the time the path plan took. In the
container:

```sh
docker compose exec -T dev sh -c 'cd /app && node examples/rivers/scripts/pictures.ts 1'        # seed 1
docker compose exec -T dev sh -c 'cd /app && node examples/rivers/scripts/pictures.ts --stats'  # numbers of seeds 1–8
docker compose exec -T dev sh -c 'cd /app && node examples/rivers/scripts/pictures.ts --brooks' # brooks of seeds 1–4
```
