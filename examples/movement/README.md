# Movement test course

A test course of about 120 × 120 m on rolling ground from a seed for the ways a figure moves: walking, riding an animal,
driving a car and flying. It exercises the engine's collision world (`CollisionWorld`), walker (`Walker`), follow camera
(`FollowRig`, `bindWalkInput`), step cycle and seats (`StepCycle`, `SocketSeat`, `SeatTransition`) and wheeled bodies (`WheeledBody`,
`WheeledGroup`) and its flying body (`FlyingBody`). The figure walks the course on foot ([Walking](#walking) below), gets on a long-legged runner
([Riding](#riding)) or into one of two compact cars ([Driving](#driving)) or onto a large flying animal ([Gliding](#gliding)) with `E`.

## Walking

Nine pads, each trying one ability of the walker; the HUD names the pad under the feet:

| Pad | Where (x, z) | What it tries |
| --- | --- | --- |
| Start | 60, 60 | flat ground, the place `R` returns to |
| Walls and a corner | 20, 20 | an L-shaped corner to rest in, a long wall to slide along |
| Pillars | 60, 20 | a row of cylinders with gaps 1.2, 1.0, 0.8, 0.7, 0.6 and 0.5 m (the body is 0.6 m wide) |
| Steps | 100, 20 | stairs of 0.2 m steps, one 0.3 m step (walks up), one 0.5 m step (stops) |
| Ramps | 100, 60 | ramps of 20°, 35° (both climbable) and 55° (slides back) onto a 3 m plateau |
| Platforms | 100, 100 | platforms at 0.6 and 1.0 m with gaps of 1, 1.5, 2 and 2.5 m to jump (running) |
| Passages | 60, 100 | a passage with a 1.5 m ceiling (too low) and one with a 2 m ceiling |
| Thin wall | 20, 100 | a wall 10 cm thick to run into |
| Footbridge | 20, 60 | a plank over a 3 m pit, a ramp out of the pit |

Everything is drawn from the collision world itself (`src/meshes.ts`), so what is seen is what stops the body.

The figure is the shared pathfinder (`examples/shared`, posed in `src/body.ts`) by default: its gait cross-fades stand,
walk and run on the ground speed, the steps follow the distance moved (so the feet keep their place while the body
speeds up or brakes), it leans into a run-up and back against braking, and a three-bone ponytail lags behind its motion
(the engine's `ChainLag`). How the body carries its weight is a movement profile (`profile=`, key `P`):

| Profile | Walk / run | Run-up to a run | Stop from a run | Turn at a run (radius) | Steps, lean |
| --- | --- | --- | --- | --- | --- |
| `default` | 1.4 / 4.6 m/s | 0.67 s | 0.84 m | 1.8 m | as drawn, some lean |
| `heavy` | 1.2 / 3.8 m/s | 1.1 s | 1.2 m | 2.5 m | 12 % longer, deep lean |
| `light` | 1.6 / 5.2 m/s | 0.48 s | 0.71 m | 1.5 m | 10 % shorter, little lean |
| `engine` | 1.6 / 4.5 m/s | 0.23 s | 0.47 m | on the spot | the engine's `DEFAULT_WALKER`; the walker of `pnpm check:walk` |

(Measured on flat ground; the turn is half the sideways swing of a reversed run.)

The three shared profiles also feel the slope (the engine's `uphillSpeedLoss`, `downhillSpeedGain`,
`downhillSpeedLoss`, `slopeSpeedFloor`): uphill slower, on gentle descents a little faster, on steep ones slower; the
`engine` profile keeps the engine's default of no slope effect. Horizontal speeds on the course, walk / run:

| Profile | Flat | Up the 20° ramp | Down the 20° ramp | Up stairs of 0.2 m steps on 0.4 m treads (a long flight) |
| --- | --- | --- | --- | --- |
| `default` | 1.4 / 4.6 m/s | 0.97 / 3.2 m/s | 1.32 / 4.3 m/s | 0.8 / 2.7 m/s |
| `heavy` | 1.2 / 3.8 m/s | 0.76 / 2.4 m/s | 1.06 / 3.4 m/s | 0.6 / 1.9 m/s |
| `light` | 1.6 / 5.2 m/s | 1.19 / 3.9 m/s | 1.61 / 5.2 m/s | 1.04 / 3.4 m/s |

`figure=boxes` draws the older figure instead: eleven boxes in the engine's instance set (`InstanceSetLayer`) that
cast a moving shadow. On the ground the
legs and arms swing with the distance walked. A jump keeps the speed and heading of take-off until landing (the
engine's `Walker` defaults; the view still turns), and the pose follows the vertical speed (`src/pose.ts`). It goes
from the push-off through the knees drawn up while rising to the legs reaching down before landing. Running, the lead
knee goes up first; standing, both legs move together. A squat as deep as the impact follows on landing and is gone
within half a second. There is no stride in the air. The example imports only `wallhammer-web` and the shared figure
code of `examples/shared` (`pnpm check:layers` enforces that).

## Riding

The steed (the shared `steed.ts`, moved by `quad-gait.ts`) is a slender runner, half fox, half antelope: a russet
coat over cream under the belly, on the breast, the throat and down the inside and the back of the legs, a deep chest
with broad shoulders, a tucked waist and a full croup whose haunches run down into the thighs, a muscled forearm,
slender tapering cannons on small dark paws, a short thick neck carried forward (low at a gallop), a fox's head (a long fine muzzle, wide cheeks, almond eyes),
two long narrow teal leaf feathers instead of ears and a long curved tail, thick at the root, ending in two leaves of the same
kind. It wears a woven rug with a zigzag band and tassels, a braided
rope harness round the chest and the neck with a soft rope rein over the withers and stirrup loops, and a lit lantern on the rug's front
corner. It stands a few steps ahead of the start with its left side to the default view, idling: it breathes, shifts
its weight, now and then twitches a feather, swishes its tail or looks aside (at times drawn from named hash streams),
and turns its head toward the figure when it comes near. `E` within 3.2 m of it gets on (the HUD says so): the figure
steps to the steed's left side, climbs onto the rug over a second as the seat's weight eases in, and its hands then
its feet take hold of the rein low over the withers and the stirrup loops. Riding, `W A S D` steer the steed relative to the view, `Shift` gallops and `T`
switches the slower gait between walk and trot; there is no jump. `E` again gets off to the left, or to the right when
the left is blocked by a solid or a drop (tested in the collision world), and the figure's walker is put there. The
steed stays where it was left.

- The steed has its own `Walker` (radius 0.75 m, height 3.1 m, walk 1.7 m/s, trot 3.8 m/s, gallop 9 m/s, a slow
  run-up, braking of 4.5 m/s², a turn rate of 1.4 rad/s falling to 0.5 rad/s at a gallop, so it rides in arcs; steps
  up to 0.35 m and slopes up to 38°; four legs lose less uphill than two). The speeds have one source,
  `STEED_SPEEDS` in `steed.ts`: its patterns of steps, its walker (`steedWalker` in `src/ride.ts`) and the bands of the
  rider's seat motions (`gaitBands`) all come from them. The figure's own walker is parked while it rides.
- The legs are stepped by the engine's `StepCycle`: a four-beat walk, a trot in diagonal pairs and a rotary gallop
  with two flights (a gathered one with the legs under the body and a stretched one with the fore legs reaching far
  forward and the hind legs trailing), blended by speed; a `TwoBoneReach` per leg puts each toe on its target (aimed
  at the joint above the paw, so the paw can turn about the toe), the carpus or hock folds in the swing (less at a
  walk than at a trot; at a gallop only in part of it, so the legs reach out straight; a swinging foot out of reach
  is raised toward the shoulder's or hip's height rather than pulled in), the heel rises about the toe as a leg
  trails at the end of a stance and the paw is otherwise kept level. The trunk follows the ground under the hooves (`supportHeight`,
  `pitch`, `roll`) and dips a little where a standing hoof would be out of reach (on the stairs, at the ends of a
  stride). The motions of the trunk (four bones: the back rounds over the loin and the croup in the gathered
  flight and lies long in the stretch; at a walk the shoulders settle onto each fore leg as it lands), neck, head (kept level), feathers and tail run on the cycle's phase; the feathers, the tail and the
  lantern lag behind the motion (`ChainLag`) and stream more the faster it runs.
- Getting on and off, for the steed and for the cars alike, is the engine's `SeatTransition` with the example's numbers
  (`RIDE_SEAT` in `src/ride.ts`, `CAR_SEAT` in `src/car.ts`): the approach, the climb's rise and the seat's weight are
  its phases, the hands, feet, gaze and doors are cues at times of it, the side to get off at is the first free one
  from `CollisionWorld.firstStandSpot`, and `releaseToWalker` puts the figure's walker where it will stand as getting
  off begins.
- The rider sits on the engine's `SocketSeat` on the steed's `seat` socket with 45 % of the saddle's tilt, in the
  pathfinder's astride motions (upright at a walk, a rising trot, crouched low and forward at the gallop), looks into the
  turn, and its ponytail keeps lagging. The camera follows the steed with a longer boom and a higher pivot, eased.

Hash: `ride=1` starts in the saddle; `hx`, `hz`, `hyaw` put the steed (its place and heading in degrees). Presets
`ride-stand`, `ride-walk`, `ride-trot`, `ride-gallop`, `ride-turn` (a trot into a right turn), `ride-slope` (up the 20°
ramp) and `ride-steps` (up the stairs) each put the steed down at a fixed place, the figure in the saddle, freeze the
page and hold the inputs for fixed steps, so they draw the same picture every time.

## Driving

Two compact cars stand on the course: a red one beside the steed near the start and a blue one parked a little further
on. Each is the engine's `WheeledBody` (the shared `src/vehicles/compact.ts` draws it), and the two are stepped together
in a `WheeledGroup`, so they push each other and never sink into one another; `syncObstacle` keeps a box round each
one, so the walker cannot walk through a car. `E` within 2 m of a driver's door gets in (the HUD says `E: get in`; `E`
takes the nearest of the steed and the cars): the figure walks to the door, the door swings open, the figure slides
across into the seat and the door shuts, all eased over about two seconds. A car cannot be entered through a wall: the
door's place must be reachable from where the figure stands. Driving, `W`/`S` are the throttle (`S` brakes, then
reverses), `A`/`D` steer, space pulls the handbrake, `R` rights an overturned car on the spot, and a gamepad's left
stick drives too. `E` gets out when the car is nearly stopped (under 1 m/s): to the driver's side, or to the other side
when a solid or a drop blocks it; the figure's walker is put down there, on free ground beside the car.

- The car is about 4.2 × 1.8 × 1.4 m: a body of lofted sections with wheel arches, framed windows, bumpers, lamps,
  mirrors and a simple interior; two front doors on hinges (the right door is the left one mirrored); wheels of a
  tyre, a five-spoke rim and a hub, mirrored on the left so the spokes face out. All meshes are made by code.
- Setup: the hull box, the mass and the wheels' places of the mesh (`COMPACT_CAR`: 1 200 kg, 4.2 × 1.8 m, wheels at
  ±0.78 m and ±1.3 m, radius 0.33 m), a lower hull (`hullY` 0.22) and soft, well damped springs (`mountY` −0.06,
  stiffness 26 000, damping 3 200), so braking dives, accelerating squats and a turn rolls the body visibly
  (about 2° and 6°) without wobbling. The wheels turn, steer and ride their suspension from `wheelMatrix`.
- Loads (the engine's `WheeledBody.setLoad`, the numbers in `src/car.ts`): the figure at the wheel is 80 kg at the
  seat, its mass moving onto the car with the seat's weight as it sits down and off again as it gets up, so the car
  sinks 7.5 mm and leans 0.3° to the driver's side. `L` while driving puts a load on the roof or takes it off: a rack
  with three strapped crates and a rolled bundle of canvas (the shared `compactRoofLoadMesh`), 180 kg at 1.66 m over
  the ground with the heavier crate across from the driver. With it the car sits 17 mm lower, covers 1.53 m instead of
  1.75 m in the first second of full throttle with its nose 1.2° up instead of 1.0°, rolls 7.2° instead of 6.1° in the
  same turn and lifts its inner wheels in a hard turn at speed, but stays on them; the HUD's line of the car names
  the load.
- The tail lamps brighten while braking and white reversing lamps light while going backward. A wheel that slides
  faster than 2.5 m/s lays a dark tyre mark (fading over 8 s), and one rolling on loose ground a rut (14 s), both on
  the page's contact trail (Traces, below).
- The camera follows the car with a boom 2.5 m longer and a pivot 0.2 m higher (the rig's `extraBoom` and
  `extraPivot`, kept apart from the wheel's zoom), its yaw eased toward the car's `renderHeading` (`followHeading`,
  95 % in 1.2 s) and waiting 1.2 s after the view is turned; the boom is cleared against the world as on foot, and the
  follow eases between the setups on foot, riding and driving.

Hash: `drive=0` (or `1`) starts in that car; `car0` and `car1` put the cars (`x,z,yawDeg`, default
`car0=66,54.5,90&car1=51,50,0`); `roof=0` (or `roof=0,1`) starts with the roof load on those cars. Presets `car-stand`,
`car-accelerate`, `car-brake`, `car-turn`, `car-handbrake`, `car-ramp` (up the ramp), `car-jump` (off the plateau's
edge), `car-bump` (into the parked car) and `car-get-in` (half way into the seat), and with the roof load
`car-load-stand`, `car-load-accelerate` and `car-load-turn` (the same drives as their namesakes without it, seen from
nearer), each put
the car down at a fixed place, freeze the page and hold the inputs for fixed steps, so they draw the same picture
every time.

The course is pure data (`src/course.ts`) and the scripted walk is pure too (`src/drive.ts`): `pnpm check:walk` walks
every pad headless the same way the page's `__wh.walkTo` does with `profile=engine`, and the figure's poses through a jump
(`tools/walk/course-scenarios.ts`); and the riding (`tools/walk/ride-scenarios.ts`): standing hooves stay put and within
reach on the flat, the ramp and the stairs, hands and feet stay on their holds at a walk, trot and gallop, getting on
and off ends standing on free ground, and two runs are bit-equal; and the driving (`tools/walk/car-scenarios.ts`):
getting in, driving and getting out ends standing on free ground beside the car, the walker stops at a parked car, a
car cannot be entered through a wall and beside one the figure gets out on the other side, one car pushed into the
other does not sink into it, a lap under scripted input is bit-equal twice, a car across the loose patch lays ruts
there and nothing on grass, the figure's mass comes onto the car as it sits down and leaves as it gets up, and with
the roof load the car sits lower, pulls away more slowly, rolls further in the same turn and stays on its wheels; and
the gliding (`tools/walk/glide-scenarios.ts`): the planted paws of a crawl do not
slide, getting on and off ends standing on free ground behind the wing, a take-off, a turn back and a landing under
scripted raw input never take the hull into the ground and are bit-equal twice, and a flight through the assist with
the page's keys (take-off, faster to the fast flight, slower to the slow one, turns, a descent that lands) reaches and
holds its speeds, never stalls after the launch and is bit-equal twice, the climb and descent rates hold 3.5 m/s at the
slow, cruise and fast speeds, `W` held on a straight heading for 30 s flies out over the land at the top speed and is
turned back without a stall or a contact, and a descent held outside the course keeps over the floor there and lands on
the course where the figure can get off; and the traces' mechanisms (`tools/walk/trace-scenarios.ts`).

## Gliding

The glider (the shared `glider.ts`, stepped by `glider-gait.ts`, its wing membranes drawn by `membrane.ts`) is a huge
flying animal with the build of a ray, the rider small on its back: a fat, rounded body like a whale's, 7.1 m long (8.1 m
from the nose to the fork of the tails) and 3.2 m wide, rising as a dome behind the head (its back 2.4 m above the ground), of deep
indigo with soft darker bands across it over a pale lilac belly, running without a neck into a big broad blunt head with
a large dark glossy eye on each side under a lid that blinks, two nostrils, and a wide smiling mouth whose pale lower
jaw opens on a dark cavity with a broad pink tongue (it pants with its tongue out after a leap, in a climb and after a
touch-down, opens its mouth in fast flight, and standing still now and then yawns, licks its lips or hangs its tongue
out, timed from named streams over simulation time); two long swept wings 16 m from tip to tip, each one
thick fleshy fin (a closed skin of triangles spanned between the flank, the leading edge and a scalloped trailing
edge, thickest along the arm, its corners weighted along the span and across the chord) that leaves the flank as a
broad shoulder, runs out over a fat four-toed paw on its leading edge into a long tapering outer fin with a pointed
tip, lilac to pink with bands running out from the flank to the edge and a pink rim; two short thick pelvic fins under
the hips with smaller paws of the same kind; and one tapering tail base that forks into two long whip filaments, lilac
to pink toward their tips (tubes of the same skin as the wings, bending over their joints without steps). It wears a rug with a diamond pattern and a fringe behind the head, a rope harness with a
halter round the head and reins, a lantern hung under the chin, a bedroll and bags. It rests behind the cars with its
take-off run toward −z along x 76, idling. On the ground it crawls on four paws at its own slow cadence, the wings'
paws (each wing sloping down from a broad low shoulder in one curve to its paw, the trailing fin and the point
lying low behind it) and the pelvic fins' at the rear of the body, behind the trailing fins, the chest shifting over the planted fin, in a stepped gait
whose planted paws do not slide, the tails rising behind in a long S; in the air the wings beat and glide (a deep power
stroke and a recovery with the outer fin unloaded and twisted, the trailing edge lagging the arm, the two wings
stroking a little differently while it rolls into or out of a bank), the body banks into turns and pitches with the
climb, the tails trail and curve. Landing, it carries the flare's nose-up pitch through the first contact and puts its
paws down one after another, the hind paws first, on the slope of the ground under them.

`E` within 4.8 m of it gets on: the figure walks behind the left wing and climbs onto the rug as on the steed, its hands
and feet then on the reins and the rope loops. On the ground `W` and `S` crawl forward and back and `A` and `D` turn;
space leaps off (it crouches for a moment first, no deeper than its belly clears the ground, then pushes off, the
wings' paws pushing on the ground a moment after the body leaves it, the nose thrown up, the first strokes deep on the
body's own beat, the hind paws tucking back and the tails whipping down).

In the air it is flown through the engine's flight assist (`FlightAssist`, `GLIDER_ASSIST` in `src/glide.ts`) by
default: `W` faster and `S` slower (a throttle: the wanted speed moves while the key is held and stays when it is let
go, shown in the status line as km/h with slow, cruise or fast), `A` and `D` turn, held space climbs and `Shift`
descends. Hands off it holds its speed and height, beating by itself as much as that needs. Coming down slowly it
lands by itself: near the ground the descent eases and the wings level out. The assist never lets it stall. Slow flight
(8.7 m/s) is light, slow beats with the wings cupped; fast flight (20 m/s) is hard, fast beats with the wings swept
back, and the camera's boom grows by up to 3 m more with the wanted speed. Held against a solid in the air, the assist
stops beating and lets it slide off or come down instead of pushing on.

Round the 120 m course lies open land, 402 m on every side, drawn without the grid and rising to low hills far out.
The fence stops walkers, riders, cars and the glider on the ground, but not the glider in the air under the assist: it
flies out over the land, and 60 m beyond the course a soft turn back begins (fully within another 70 m), so held `W`
never ends at an invisible wall. Outside the course the assist keeps it at least 6 m over the ground (a held descent
levels out there), so it lands only on the course, and the figure gets off only where its spot is on the course (near
the fence the glider's line in the HUD says that the spots behind the wings are too near the course's edge). With
`assist=0` the fence stops it in the air too, as before. `assist=0` in the hash keeps the raw
controls: `W` puts the nose down and `S` up, `A` and `D` bank, held space beats and `Shift` flares.

Low and sinking, or flaring, it makes ready to land: the nose up, the wings swept forward and
cupped with short beats back, the paws reaching down. It touches down when it comes to the ground (the body sinks deep
onto its paws and springs back, the wings fold down over about a second), brakes and crawls on; `E` gets off once it has stopped
on the ground, behind the left wing (or the right when the left is blocked). In the air the seat takes the whole tilt
of the body, and the rider leans forward. The camera's boom grows by 7 m on the glider and 7 m more in the air (about 18.5 m behind at the cruise,
21.5 m fast; the wings then a third to two fifths of the picture's width), its pivot 1.8 m lower in the air than on the ground so the back and
the rider are seen, and it follows the heading.

- The glider is the engine's `FlyingBody` with its own numbers (`GLIDER_BODY` in `src/glide.ts`): a crawl of 2.3 m/s,
  a leap of 6.5 m/s up and 4 m/s forward, a glide ratio of 9 at a trim speed of 11 m/s, a stall below 7.5 m/s, beats
  of 0.8 a second when light up to 1.5 at full effort that push mostly on the down stroke, drag rising fast above the
  trim speed (`fastDrag`), banks up to 54°, a flare, a hull of sixteen spheres in the air and ten on the ground. Nothing passes through the ground or a solid; the course's ceiling is the terrain's top plus
  `FLIGHT_CEILING_M`.
- The assist (`GLIDER_ASSIST`): a wanted speed from 8.7 m/s through a cruise of 13 m/s to 20 m/s, moved at 8 m/s a
  second; a new speed is reached (90 %) in about 1.3–2.3 s; climbs and descents of 3.5 m/s (measured 3.44–3.48 m/s at
  all three speeds); level turns about 19 m across at the slow speed, 27 m at the cruise and 75 m at the fast one.
- The presets `glide-stand`, `glide-crawl`, `glide-takeoff`, `glide-fly`, `glide-beat`, `glide-turn`, `glide-land`,
  `glide-mount` and `glide-dismount` put the glider down or in the air by the raw controls, freeze the page and hold
  their inputs; `glide-assist-slow`, `glide-assist-cruise`, `glide-assist-fast`, `glide-assist-slowing`,
  `glide-assist-turn`, `glide-assist-climb` and `glide-assist-land` do the same through the assist.

## Traces

Feet, hooves and wheels leave marks, and loose ground throws up dust (`src/traces.ts`, the looks in `src/shaders.ts`,
the kinds and their lives in `src/trace-kinds.ts`). The course's base surface is grass, except a patch of loose ground
across the start pad in front of the start (`LOOSE_PATCHES` in `src/course.ts`, bare earth on the ground), told apart by
the collision world's surface tags (`SURFACE`; a solid's top leaves no print).

- The figure's boots leave a sole print where each foot is put down (its gait's `step.l` and `step.r` marks): faint
  on grass (10 s), deep with a heel on loose ground (20 s).
- The steed's hooves leave a round print with a frog where each is put down (its step cycle's `downs`), faint on grass,
  deep on loose ground; at a trot or a gallop on loose ground each hoof throws a puff of dust back (more at a gallop).
- The cars' wheels lay dark streaks where they slide and ruts on loose ground (`ContactStreaks` in `src/car.ts`), and
  puff dust on loose ground above 2 m/s or wherever they slide (a pale haze on grass).
- Everything is the engine's: one `ContactTrail` of 2 048 marks drawn by a `ContactTrailLayer`, one-shot bursts of a
  `ParticleLayer` (seeded from the step and the source, so the same steps give the same dust). Both are drawn at the
  cars' clock, which every step of the page advances, so a script's `hold` shows marks and dust of the right age.
- Presets `trace-trot`, `trace-gallop` (the steed across the patch), `trace-car` (a car across it) and
  `trace-handbrake` (a handbrake turn on it).

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://localhost:5281/movement/>. Another port: `EXAMPLES_PORT=5291 docker compose up -d`.

- `W A S D` or the arrows walk, `Shift` runs, space jumps; drag to turn the view, the wheel moves the camera in and out.
  A gamepad works too.
- `E` gets on the steed or into a car when near, and off or out again; riding, `T` switches walk and trot, `Shift`
  gallops; driving, `W`/`S` throttle, brake and reverse, `A`/`D` steer, space the handbrake, `L` puts the roof load
  on or takes it off, `R` rights the car. `E`
  also gets on the glider and off it (stopped on the ground); on the ground `W`/`S` crawl, `A`/`D` turn, space leaps;
  in the air `W`/`S` faster and slower, `A`/`D` turn, space climbs, `Shift` descends (and lands when low and slow);
  with `assist=0` in the air `W`/`S` nose down and up, `A`/`D` bank, held space beats, `Shift` flares.
- `F` first person and back, `C` the wireframe of the collision solids (yellow standable, red blocking, violet the
  invisible edge of the course), `R` back to the start, `P` the next movement profile.
- `N` switches the mark mode (dev server only, not in the live demo): a click pins a note to the course, picked against
  the collision world (`collisionPick`), kept in `internal/marks/` by the dev server's store; one call to the engine's
  `installEngineMarking` in `src/main.ts` (Marks in the engine's docs). Opening a mark's view puts the walker back on
  its spot and the camera exactly where it was; the figure's heading comes from the page's own hash (`yaw`, to 0.1°).
  `marks=1` turns the marks on in a page driven by a script, `marks=0` hides the pins.
- URL hash: `#seed=7&x=60&z=60&yaw=0&fp=0&c=0&lock=0&pr=1.5&profile=default&figure=pathfinder`. `fp=1` first person,
  `c=1` the wireframe, `lock=1` a click locks the pointer, `pr` caps the canvas pixel ratio (default 1.5, `0` the
  device's own), `profile` the movement profile (`default`, `heavy`, `light`, `engine`), `figure=boxes` the box figure (no steed),
  `ride=1` in the saddle, `hx`, `hz`, `hyaw` the steed's place, `drive=0` in a car, `car0`, `car1` the cars' places, `roof=0` the roof load on a car, `glide=1` on the glider, `gx`, `gz`, `gyaw` the glider's place, `assist=0` the glider's raw controls in the air.

## Script interface

`window.__wh` after `await __wh.ready`:

| Member | Meaning |
| --- | --- |
| `state()` | Position, velocity, horizontal speed, heading, `grounded`, `steep`, the pad under the feet. |
| `walkTo(x, z, seconds, { run?, jump?, within? })` | Holds a direction toward the point for that many seconds of fixed steps (synchronously), then draws; `jump` jumps by itself at edges and ledges. Returns the state. |
| `hold({ forward?, right?, run?, jump?, trot?, throttle?, brake?, steer?, handbrake? }, seconds)` | Holds that input (relative to the view, each −1 to 1; `jump` in the first step only) for that many seconds of fixed steps, then draws. Riding, it steers the steed (`trot` sets its slower gait); driving, `throttle` (−1 to 1), `brake` (0 to 1), `steer` (−1 to 1, right positive) and `handbrake` drive the car; on the glider `forward` (the crawl; in the air the assist's throttle, or the raw pitch), `right`, `jump` (the leap), `beat` (in the air the assist's climb, or the raw beats), `flare` (the assist's descent, or the raw flare) and `use` (the key `E`). Returns the state (the steed's while riding, `driving()` while driving). |
| `moveProfile(name?)` | The movement profile; with a name, switches to it first (the walker is retuned, the figure gets the profile's gait). Returns the name. |
| `figure()` | The pathfinder's gait: state, speed, smoothed acceleration, the `push` and `brace` weights, the stride, the ponytail's largest angle (`tailDeg`), the profile. `null` with `figure=boxes`. |
| `ride(on?, instant?)` | Gets on (`true`; within 3.2 m of the steed unless `instant`), off (`false`) or toggles (no argument), as the key `E`; `instant` skips the climb. Returns `riding()`. `null` with `figure=boxes`. |
| `riding()` | The ride: `mode` (`off`, `mounting`, `on`, `dismounting`), the `seat` weight, the `holds` of the hands and feet, `trot`, the steed's place, heading and `speed`, its step cycle (`phase`, `rate`, the `patterns` weights of walk, trot and gallop), `downs` (footfalls) and `planted` per leg (front left, front right, hind left, hind right), the trunk's `dip`, the steed's own clock `time` and its `effort` (0–1, which opens its mouth and quickens its breath), and `reachM`. |
| `drive(car?, on?, instant?)` | Gets into car `car` (default the nearest in reach, else 0; `true`, within 2 m of its door unless `instant`), out (`false`, when nearly stopped) or toggles, as the key `E`; `instant` skips the walk and the doors. Returns `driving()`. `null` with `figure=boxes`. |
| `driving()` | The drive: `mode` (`off`, `entering`, `on`, `exiting`), the `car` the figure is in, the `side` it gets in or out at, the camera's `weight`, per car its place, heading, `speed`, `up`, `asleep`, `steerDeg`, per wheel `compression`, `slip` and `grounded`, the `doors`, `brake` and `reversing` lamps, `roofLoad` (whether it carries the roof load) and `loadKg` (the mass of its loads: the figure in the seat, the roof load); the tyre `marks` laid, and `reachM`. |
| `roofLoad(on?, car?)` | Puts the roof load on car `car` (default the car driven, else 0), takes it off (`false`) or toggles it, as the key `L` does for the car driven. Returns `driving()`. `null` with `figure=boxes`. |
| `glide(on?, instant?)` | Gets on the glider (`true`; within 4.8 m unless `instant`), off (`false`; stopped on the ground unless `instant`) or toggles, as the key `E`. Returns `gliding()`. `null` with `figure=boxes`. |
| `gliding()` | The glider: `mode`, `offRefused` (while the figure is on it, why it cannot get off now: `air`, `moving` or `edge`, the spots behind the wings too near the course's edge; `null` when it can), the `seat` weight, the `holds`, its place, heading, `pitchDeg`, `bankDeg`, `speed`, `climb`, `altitude`, the `beat`'s effort, the `flare`, the `load`, `stalled`, `takeOffs`, `touchDowns`, `assisted`, the assist's `wantedSpeed` and `askedClimb`, its step cycle on the ground (`phase`, `downs`, `planted`: left wing, right wing, hind left, hind right), its `face` (how far the mouth is open, the tongue out and the lids shut, each 0–1) and `reachM`. |
| `traces(clear?)` | The traces: marks laid in all and still `visible`, `prints` of feet and hooves, the `dust` bursts and particles fired and alive, the `time` they are drawn at; `clear` forgets them first. |
| `freeze(on)` | Stops the page's own stepping and the keyboard, so `hold` alone moves the figure (for pictures of a pose). |
| `teleport(x, y?, z, yawDeg?)` | Puts the feet there (`y` omitted or `NaN`: on the ground). |
| `setView({ at?, yawDeg?, pitchDeg?, distance?, ride?, drive? })`, `getView()`, `presets()` | The view; `at: [x, z, yawDeg?]` puts the figure there first, `ride` a riding scene (as the `ride-*` presets), `drive` a driving scene (as the `car-*` presets), `glide` a gliding scene (as the `glide-*` presets). One preset per pad, then the riding, driving and gliding presets. `distance` is the user's own boom in both: riding and driving add `extraBoom` (in `getView()` too) on top. |
| `stats()`, `profile(frames?)`, `profileText(frames?)` | Draw statistics and measured frame times; the engine's frame profile while the figure walks in a circle. |
| `hud()`, `hash()`, `settled()`, `stations()`, `setWire(on)` | For the screenshot tool and scripts. |

Screenshots: `docker compose run --rm shot --url http://dev:5281/movement/ --presets start,pillars`. Frame times from a
container's software renderer say nothing about a real graphics card; measure in Chrome with `__wh.profileText()`.
