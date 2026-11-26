# Wheeled body

`WheeledBody` (in `wallhammer-web/world`) is one rigid body carried on wheel rays over the same `CollisionWorld` the
walker uses: springs and dampers along the ground's normal, tyres with a slip curve and a friction circle, a drive
force that falls to a top speed, brakes, a handbrake, steering eased and reduced with speed, and a hull of spheres that
hits solids and the ground without passing through them. It runs in fixed steps, deterministically, without allocating,
in plain Node. The same body with other numbers is a cart, a sled on runners (no driven wheels), a trolley or a
six-wheeled hauler. The movement example drives two such bodies in a `WheeledGroup` (`examples/movement`).

## Frames and units

- The body's frame has its origin at the **centre of mass**, +x to the right, +y up, **−z forward**. Yaw 0 faces −z,
  as for a view, the walker and `FollowRig`; `yaw` is that angle in radians.
- `steer` positive turns right; `throttle` positive drives forward.
- Metres, seconds, kilograms, newtons. Gravity is along −y.

## Setup and the frame loop

<!-- check: wrap -->
```ts
import { CollisionWorld, WheeledBody, fourWheels, newWheeledIntent } from 'wallhammer-web/world';
import { mat34Identity } from 'wallhammer-web/base';

const world = new CollisionWorld({ heightAt: (x, z) => 0.02 * x + 0.3 * Math.sin(z * 0.05) });
world.addBox(0, -40, 6, 0.3, 0, 0, 2); // a wall across the way

// Any field left out takes DEFAULT_WHEELED_BODY's value (a 1,200 kg body 4.2 m long on four wheels).
const body = new WheeledBody(world, {
  mass: 1100,
  wheels: fourWheels({ drive: 'all', frontGrip: 0.95 }),
});
body.setUpright(); // upright at rest height over the ground at its position (teleport(x, y, z, yaw?) sets one)

const intent = newWheeledIntent(); // allocate once, reuse every frame
const pose = mat34Identity();

function frame(dt: number, keys: { up: boolean; down: boolean; left: boolean; right: boolean; space: boolean }): void {
  intent.throttle = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  intent.steer = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  intent.handbrake = keys.space;
  intent.brake = 0;
  body.advance(dt, intent); // the fixed steps due; the rest of dt is kept for the next frame
  body.renderMatrix(pose); // between the last two steps (body.alpha)
  // draw the hull mesh with `pose`
}
frame(1 / 60, { up: true, down: false, left: false, right: false, space: false });
```

`advance(dt, intent)` runs the steps due (at most `maxStepsPerAdvance`, the rest of a long pause dropped) and returns
their number; `step(intent)` runs exactly one, for scripts and checks. Cut the same seconds into frames of 1/30, 1/60
or 1/144 s and the body takes the same steps with the same bits, as long as the intent changes only between steps.

**Throttle and brake.** `throttle` forward drives forward; while the body rolls backward faster than 1 m/s it brakes
instead. `throttle` backward brakes while the body rolls forward faster than 1 m/s and drives backward below that, so
one stick or two keys both work. `brake` (0–1) is a share of `brakeForce` on every wheel. With no throttle the driven
wheels feel `engineBrake`; every wheel has `rollingResistance`; the body has air `drag`. `handbrake` locks the wheels
marked `handbrake` (the rear ones of `fourWheels`): they hold along their rolling and lose most of their sideways grip
(`handbrakeGrip`), so the rear slides out.

A body that stood still for `sleepSeconds` without throttle sleeps (`asleep`): it does not move by a bit until the
throttle, a released brake, `wake()`, `applyImpulse` or a change of the ground under a wheel. Parked with the brake or
the handbrake on a slope of 15° it settles within a centimetre and stays.

## Drawing the wheels

`wheelMatrix(i, out)` gives wheel `i` at its centre, turned by its steer and rolled by its spin, between the last two
steps. A wheel mesh modelled round its centre with the axle along x is drawn with it as it is.

<!-- check: wrap -->
```ts
import { CollisionWorld, WheeledBody } from 'wallhammer-web/world';
import { mat34Identity } from 'wallhammer-web/base';

declare const body: WheeledBody;
declare function drawWheel(matrix: Float64Array, radius: number): void;

const wheelPose = mat34Identity();
for (let i = 0; i < body.wheels.length; i++) {
  body.wheelMatrix(i, wheelPose);
  drawWheel(wheelPose, body.wheels[i]!.spec.radius);
}
// Per wheel after the last step: grounded, compression (m), contact point and normal, load (N), slip (m/s sliding at
// the contact: tyre marks and sound), spin (radians rolled), steer (radians), surface (the solid's id, −1 the base).
const skidding = body.wheels.some((w) => w.grounded && w.slip > 2);
void skidding;
void CollisionWorld;
```

## A follow camera

`FollowRig` follows a point and a yaw in degrees; `renderYaw(alpha)` is the body's heading between the last two
steps in radians.

<!-- check: wrap -->
```ts
import { FollowRig } from 'wallhammer-web/camera';
import { WheeledBody } from 'wallhammer-web/world';

declare const body: WheeledBody;
// The yaw eases behind the body (95 % in 0.8 s) and waits 1 s after the player turns the view.
const rig = new FollowRig({ pivotHeight: 0.8, followLag: 0.15, headingLag: 0.8, headingPause: 1 });
const at = new Float64Array(7);

function frameCamera(dt: number): void {
  body.renderTransform(at); // x, y, z, then the orientation quaternion
  rig.follow(at[0]!, at[1]!, at[2]!);
  rig.followHeading((body.renderYaw() * 180) / Math.PI);
  rig.update(dt);
}
frameCamera(1 / 60);
```

Small gaps: the yaw follows the heading with a lag (`headingLag`), so a spin or a handbrake turn does not turn the
picture as fast as the body (set `yawDeg` yourself for a rigid view); it has no pitch or roll of the body. The boom is cut by solids that
block sight, and the body's own obstacle box does not block sight, so the boom never collides with its own body.

One rig for a figure that gets in, drives and gets out (the point blended from the figure to the body by the game's
weight of getting in, a longer boom, the yaw eased behind the heading unless the view is dragged):
[A follow camera for a carried or driven body](cookbook.md#a-follow-camera-for-a-carried-or-driven-body). Getting in
and out is the game's; put the figure's walker beside the door when getting out starts, not when it ends, or
everything blended toward the walker (the camera) looks back to where it got in.

## Obstacles and other bodies

The body's hull hits the base surface and every solid of the world, standable or not, except those tagged with its
`obstacleTag` (default `WHEELED_OBSTACLE_TAG`, −7). Its wheels stand on what a ray hits: the base and the solids that
block sight.

For a **walker** (and any mover that slides along solids) the body keeps a box round its hull in the world:
`syncObstacle()` adds an upright box turned with the heading (`standable: false`, `blocksSight: false`, tagged
`obstacleTag`) on the first call and moves it in place (`CollisionWorld.setBox`) on the next ones; call it after the
steps of a frame, or once when the body is parked. The body's own hull and wheels do not see it.

Two or more bodies meet through `WheeledGroup`: it steps every body, then pushes apart every pair whose hulls overlap,
with equal and opposite impulses (restitution and friction) and the overlap shared by mass, in a fixed order of pairs.

<!-- check: wrap -->
```ts
import { CollisionWorld, Walker, WheeledBody, WheeledGroup, newWalkIntent, newWheeledIntent } from 'wallhammer-web/world';

const world = new CollisionWorld({ heightAt: () => 0 });
const mine = new WheeledBody(world);
mine.teleport(0, mine.restHeight, 0, 0);
const parked = new WheeledBody(world);
parked.teleport(0.5, parked.restHeight, -12, 0);
const group = new WheeledGroup([mine, parked]);
const walker = new Walker(world);
walker.teleport(5, 0, -12);

const drive = newWheeledIntent();
drive.throttle = 1;
const walk = newWalkIntent();

function frame(dt: number): void {
  group.advance(dt, [drive, null]); // null: idle
  for (const b of group.bodies) b.syncObstacle(); // where the walker meets them
  walker.advance(dt, walk);
  // draw each body with b.renderMatrix(out, group.alpha)
}
frame(1 / 60);
```

**Something to do after every step.** `group.advance(dt, intents, afterStep)` calls `afterStep(touching)` once after
each step (after the pairs were pushed apart; `touching` is the number of pairs that touched), before the next step
runs. It may change `intents` for the next step: a script that holds a body until a moment, a seat that becomes empty,
a sensor that reads the bodies at the step rate. The same frames cut into steps of a frame loop and by hand
(`group.step(intents)` then the hook) give the same bits. `group.fixed` is the group's `FixedSteps` (core),
`group.stepSeconds` its step and `group.alpha` the share of the way to the next step for drawing. A body belongs to
one group: from then on its own `alpha` (the default of `renderMatrix` and the other drawing calls) is the group's, and
its own `advance` throws, so a body cannot be stepped twice or drawn at a stale share by mistake.

`collideWheeledBodies(a, b)` (or `a.collide(b)`) is the pair step alone, for a game that steps its bodies itself; call
it after both took the same step.

## Tuning

`DEFAULT_WHEELED_BODY` (and the options of `fourWheels`) are a reference set, not a vehicle of the engine: a body of
1,200 kg and 4.2 m on four wheels, rear-driven, to start from and to measure against. A game passes its own numbers,
above all the hull box, the mass and the wheels' places of the mesh it draws (the movement example's cars take them
from their mesh's measures, `COMPACT_CAR`). Its numbers, measured by
`pnpm check:walk` on flat ground at 60 Hz: 0–100 km/h in 8.75 s, a top speed of 45.7 m/s, from 100 km/h to a stop in
46.8 m, a turning circle of 11.8 m at walking pace, mild understeer at speed (at 25 m/s and full steer the front slides
more than the rear, 0.92 g), and a handbrake turn of about twice the heading change of a plain one.

| Field | Default | What it does |
| --- | --- | --- |
| `mass`, `halfWidth`, `halfHeight`, `halfLength`, `inertiaScale` | 1200, 0.9, 0.6, 2.1, 1 | The box of mass and its inertia; more `inertiaScale` turns and rolls slower. |
| `hullY`, `hullRadius` | 0.3, 0 (auto 0.45) | Height of the hull box over the centre of mass; the radius of its spheres. |
| `wheels` | `fourWheels()` | Mount, radius 0.33, `restLength` 0.35, `travel` 0.22, `stiffness` 30,000, `damping` 2,200, `grip` 1 front / 1.05 rear. |
| `driveForce`, `topSpeed` | 4600, 52 | Drive force at a standstill, falling as 1 − (v / topSpeed)²; drag keeps the real top speed lower. |
| `reverseForce`, `reverseSpeed` | 3000, 9 | The same backward. |
| `brakeForce`, `engineBrake` | 11000, 500 | All wheels at `brake` 1 (each limited by its grip); against rolling without throttle. |
| `rollingResistance`, `drag` | 0.015, 0.42 | A share of each wheel's load; N per (m/s)². |
| `grip`, `peakSlip`, `slideGrip` | 1, 0.15, 0.8 | Peak friction, the slip angle of the peak (rad), the share left when sliding (from 3 × `peakSlip`). |
| `handbrakeGrip`, `loadSensitivity`, `lowSpeed` | 0.4, 0.1, 2 | Sideways grip of a locked wheel; grip lost per extra share of load; below this speed (m/s) a full static hold. |
| `maxSteer`, `steerRate`, `steerFallSpeed` | 0.45, 2.5, 14 | Steer angle (rad) at full steer, its fastest change (rad/s), the speed (m/s) where it is halved. |
| `restitution`, `hullFriction` | 0.2, 0.4 | Of the hull against solids, the ground and other bodies (impacts faster than `bounceSpeed` bounce). |
| `bounceSpeed` | 1 | Impacts of the hull slower than this (m/s) do not bounce; between two bodies the larger of their two. |
| `bumpStopFactor` | 10 | Stiffness of the bump stop past a spring's `travel`, as a multiple of the spring's stiffness. |
| `wheelSphereShare` | 0.8 | Radius of the hull sphere at each wheel's bump stop, as a share of the wheel's radius. |
| `reverseEngageSpeed` | 1 | Forward speed (m/s) below which a throttle against the motion reverses (or drives forward again) rather than brakes. |
| `uprightProbeHeight` | 1 | Height above the centre of mass that `setUpright` looks down for the ground from (m). |
| `sleepSpeed`, `sleepSeconds` | 0.03, 0.5 | Still below this for this long without throttle: asleep. |
| `stepHz`, `maxStepsPerAdvance`, `gravity` | 60, 15, 9.81 | Fixed steps. |
| `obstacleTag` | −7 | Tag of the obstacle boxes the hull ignores. |

`retune(tuning)` changes the drive, brake, tyre, steering and hull numbers while the body lives (`WHEELED_TUNING_KEYS`,
type `WheeledTuning`); the mass, the box and the wheels are fixed at construction, and so are `bounceSpeed`,
`bumpStopFactor`, `wheelSphereShare`, `reverseEngageSpeed` and `uprightProbeHeight` (setup only). A front-heavy grip (`frontGrip`
below `rearGrip`) understeers more; a lower `handbrakeGrip` or `slideGrip` slides further.

## Saving and restoring

`saveState(out?, offset?)` writes the whole moving state (pose, velocities, the pose before for drawing, the leftover
time, steering, sleep and every wheel), `stateBytes` long (880 bytes with four wheels); `loadState(bytes, offset?)`
puts it back, into this body or another of the same setup, and the steps after it are the same bits.
`simState(name)` makes it a part of a `Simulation`'s state, as for the walker.

## Limits

- **Flat worlds only.** The body runs in a local frame with +y up and gravity along −y. On a sphere it would be wrapped
  in a moving chart the way `ChartWalker` wraps `Walker`: a `ChartWheeledBody` would own a `SurfaceChart`, a flat
  `CollisionWorld` of the chart's ground and solids, and this body inside it; at a step boundary past a distance it
  would rechart under the body and carry the position, the orientation (turned by the change of the chart's frame),
  both velocities and the previous pose (so drawing does not jump) into the new chart, and hand out world positions
  and a render frame. Gravity stays along the chart's −y, which is the local down within a chart's reach.
- **Body against body is sphere against sphere** after each step: fast bodies meeting head-on can overlap by a few
  centimetres for a step before they are pushed apart, and there is no sweep between two bodies (each body's sweep is
  only against the world). Bodies in a `WheeledGroup` do not see each other's obstacle boxes; a body not in a group
  passes through another body unless the game calls `collideWheeledBodies`.
- **Obstacle boxes are upright.** A body on its side or upside down keeps an upright box round its whole extent, a little
  larger than the hull. Walkers do not stand on it (`standable: false`); the box follows only when `syncObstacle` is
  called.
- **Wheels are rays**: a wheel finds the ground straight below its mount, not the front of a step it rolls into. A
  low kerb (0.15 m is checked) is driven onto by the springs; a step higher than the suspension can take is met by the
  hull's spheres (one sits at each wheel's bump stop), which push the body back or up rather than rolling it over.
- **No drivetrain**: no gears, clutch, differential, wheel inertia or anti-roll bar; the drive force is split evenly
  among the driven wheels, the steer angle is the same for both steered wheels (no Ackermann).
- **A constant of the step.** A wheel in the air loses 1 % of its spin per step, so the decay per second depends on
  `stepHz` (at 60 Hz about 45 % a second). It only changes how a wheel in the air turns down, which is drawn, not the
  motion; it stays a constant so that existing bodies keep their bits.
- **Sleeping** wakes on the intent, on `applyImpulse` and on a change of the ground under a wheel; a solid moved into a
  sleeping body's hull (not under its wheels) does not wake it: call `wake()`.
