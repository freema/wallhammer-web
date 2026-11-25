# Walking

Moving a body over a world: the collision world answers where the ground and the sides are, a walker moves over it
in fixed steps, a follow camera stays behind it ([`FollowRig`](cameras.md#followrig)). Everything here runs in plain
Node: no DOM, no graphics. `pnpm check:walk` checks it without a browser
(`tools/walk/`).

## Collision world

`CollisionWorld` (`wallhammer-web/world`) is a base surface given as a height function plus upright solids: prisms
over an outline, cylinders and turned boxes (a box is a prism with four corners). Solids are listed in a uniform grid
of cells (`cellSize`, default 8 m); a query visits only the cells it touches. Queries allocate nothing: results go
into an object the caller passes and reuses. The hot paths use only `+ − × ÷` and `Math.sqrt`, so the same inputs
give the same bits.

<!-- check: wrap -->
```ts
import { CollisionWorld, newRayHit, newSlideResult } from 'wallhammer-web/world';
import { HeightField } from 'wallhammer-web/gen-core';

declare const field: HeightField;

const world = new CollisionWorld({
  heightAt: (x, z) => field.heightAt(x, z),
  baseMinY: field.minY, // optional: a ray only searches for the base between these
  baseMaxY: field.maxY,
});
const block = world.addBox(10, 10, 2, 1, 0.3, 0, 3, { tag: 1 }); // centre, half extents, yaw, minY, maxY
world.addCylinder(14, 10, 0.4, 0, 4);
world.addPrism([0, 0, 4, 0, 4, 1, 0, 1], 0, 0.3); // a step 0.3 m high
world.addPrism([20, 0, 30, 0, 30, 30, 20, 30], -1, 50, { standable: false, blocksSight: false }); // an invisible limit

// Per step of a mover: ground under the feet, sides at the height of the body above the step height.
const slid = newSlideResult();
let x = 1;
let z = -1;
let y = world.groundAt(x, z, 0, 0.35, 0.3);
world.slide(x, z, 0.3, y + 0.35, y + 1.7, 0.05, 0.02, slid);
x = slid.x;
z = slid.z;
y = world.groundAt(x, z, y, 0.35, 0.3);
const headroom = world.ceilingAt(x, z, y + 1.7, 0.3); // Infinity when open

// A ray and a camera boom.
const hit = newRayHit();
if (world.raycast(x, y + 1.6, z, 1, -0.2, 0, 50, hit)) console.log(hit.t, hit.solid, hit.tag, hit.nx, hit.ny, hit.nz);
const boom = world.clearance(x, y + 1.6, z, -1, 0.5, 0, 4, 0.2); // how far a sphere of 0.2 m gets, at most 4 m

world.remove(block); // other ids stay valid
```

| Member | Meaning |
| --- | --- |
| `new CollisionWorld({ heightAt, cellSize?, baseMinY?, baseMaxY?, baseStep?, baseExtent? })` | The base surface as a height function. `baseMinY`/`baseMaxY` bound it (a ray above the highest point skips the search); `baseStep` is the horizontal step of the ray search on it (default 0.5 m); `baseExtent` (`[minX, minZ, maxX, maxZ]`) is where the base exists, so a ray that leaves it stops searching. Without an extent and without a finite `maxT`, a ray that misses everything searches the base for 1e5 lengths, which takes milliseconds. |
| `baseHeightAt(x, z)`, `baseSlopeAt(x, z, out)` | The base height at a point; its gradient (rise per metre along x and z) into `out` and its length, the tangent of the slope (central differences 0.05 m apart). |
| `addPrism(outline, minY, maxY, options?)` | Upright prism over a closed outline of x, z pairs (either winding, may be concave, a repeated closing point is dropped). Returns the id. |
| `addCylinder(x, z, radius, minY, maxY, options?)`, `addBox(x, z, halfX, halfZ, yawRad, minY, maxY, options?)` | A cylinder; a turned box (local +x points to (cos yaw, −sin yaw), as a view's yaw turns). |
| `SolidOptions` | `standable` (default true: its top is ground), `blocksSight` (default true: stops rays and booms; false for invisible limits), `tag` (the caller's number, returned in hits). |
| `remove(id)`, `has(id)`, `solidCount` | Ids are never reused, so removing one leaves the others valid. A removed or unknown id is ignored. |
| `groundAt(x, z, y, maxStepUp, radius?)` | The highest of the base and of the standable tops at most `y + maxStepUp`. The base counts always. With `radius`, a top counts when the solid reaches within that distance of the point (a body stands on an edge). |
| `ceilingAt(x, z, y, radius?)` | The lowest underside at or above `y`; Infinity when open. Every solid counts. |
| `slide(x, z, radius, minY, maxY, dx, dz, out)` | Moves a circle against the sides of the solids whose height span overlaps `minY`..`maxY` (touching does not count; the base is not a side). It slides along a side, stops in a corner, never ends inside a solid: a circle that starts inside is pushed out the shortest way first. The move is split into sub-steps of at most half the radius, so it does not pass a side thinner than that. `out.hit`, `out.nx`, `out.nz`, `out.solid` tell the last contact. |
| `raycast(ox, oy, oz, dx, dy, dz, maxT, out)` | The first hit with the base and the solids that block sight, for t in 0..`maxT` (t in lengths of the direction). The normal is unit and turned against the ray; `solid` and `tag` are −1 for the base. |
| `clearance(ox, oy, oz, dx, dy, dz, maxDist, radius)` | How far a sphere gets along the direction, in metres, at most `maxDist`: the centre line is cast as a ray first, then the sphere is tested every `radius` metres and the contact refined by bisection. 0 when the sphere overlaps something at the origin. Pass it to `FollowRig` as the boom clearance. |
| `query(x, z, radius, visit)` | Every solid whose outline comes within `radius` of the point horizontally, whatever its height span and options: `visit(id, tag, distance)` with the signed horizontal distance (negative inside). Returns the count; allocates nothing; `visit` must not query the same world. |
| `forEachSolid(fn)`, type `SolidInfo` | Every solid with its shape and options, for debug drawing (allocates). |
| `newRayHit()`, `newSlideResult()` | Result objects to allocate once and reuse. |

The base surface is not a side: a mover decides by itself what slope it climbs. Tops count only through `groundAt`, so
a step lower than the mover's step height is left out of `slide` by passing `minY` above it.

The ray search of the base steps along the ray `baseStep` metres at a time and refines the intersection by bisection, the
same search as `raycastHeightField` (both use one function). A ridge narrower than the step can be missed.

CPU time in plain Node in the development container, a world of 2,000 solids on a height field, mean of 10,000
calls (`pnpm check:walk` prints it each run): a 30 m `raycast` about 2 µs on a quiet machine (up to 8 µs measured
while the machine was busy), a `slide` of one step 1–3 µs, `groundAt` under 1 µs, a 4 m `clearance` 5–15 µs.

## Walker

`Walker` (`wallhammer-web/world`) is a kinematic body, an upright cylinder of `radius` and `height` with its feet at
`position`, that moves over a `CollisionWorld` in fixed steps of `1 / stepHz` seconds. Each step:

1. The wanted velocity is the intent's direction (clamped to length 1) times `walkSpeed` or `runSpeed`. The horizontal
   velocity moves toward it by at most `acceleration` per second (by default braking the same way; see
   [Momentum](#momentum) for a separate braking, a slower run-up and a turn that widens with speed); in the air only
   `airControl` of it. The default `airControl` is 0: once off the ground (a jump or a fall from an edge) the body keeps
   the horizontal velocity it left with until it lands, whatever is asked in the air; only a side it touches takes
   away the velocity into it. A small share (0.05–0.1) allows a slight correction, at most `airControl × acceleration`
   per second, whether it speeds up, brakes or turns (`deceleration` and `runAcceleration` are the grip of the feet
   and apply only on the ground). A step counts as in the air when it starts with the feet above the ground, so the step of a take-off
   still steers as on the ground and the step of a landing does not.
2. A jump (`intent.jump`) starts only from the ground, not from a slope too steep to stand on: the vertical speed
   becomes `jumpSpeed`.
3. The body slides by its velocity with `slide`, against the sides of solids between `maxStepUp` above the feet and
   the head, so a step up to `maxStepUp` is not a side. Velocity into the touched side is dropped: the body slides
   along a wall and rests in a corner. A base surface steeper than `maxSlopeDeg` that rises ahead takes the uphill
   part of the move away. The slide runs even standing still, so a solid that appears over the body pushes it out.
4. On the ground the feet follow `groundAt` (the highest base or standable top within `maxStepUp` above, the body
   standing on an edge while its circle touches the top). The ground may also drop by up to `maxStepUp` plus the drop
   of the base over the move, so the body walks down steps and slopes; a bigger drop starts a fall. In the air the
   height follows gravity exactly (the top of a jump is `jumpSpeed² / (2 gravity)` at any step rate), the head stops
   at `ceilingAt`, and the body lands on the first ground it meets.
5. On a base surface steeper than `maxSlopeDeg` (`steep`), the body slides downhill (the horizontal part of gravity
   along the incline); the intent steers it across and may speed it downhill but not brake or climb. The slope is
   steep only when the base rises steeply on both sides of the feet (over 5 cm each way along the gradient): at the
   flat lip of a cliff or a pit the central slope straddles the kink, and the body must still be able to walk away.
6. `yaw` turns toward the wanted direction (or, without an intent, the direction moved) at most `turnSpeed` rad/s
   (with `turnSpeedAtRun`, the turn rate at the current speed) on the ground and `airTurnSpeed` rad/s in the air. The default `airTurnSpeed` is 0: the body keeps the heading it took
   off with until it lands, so a figure drawn with `renderYaw` does not spin in the air (a camera may still orbit it).

`advance(dt, intent)` takes real seconds, runs the steps due and carries the rest to the next call, so the path does not
depend on the frame rate: one call of 1/30 s and two of 1/60 s end in the same place. At most `maxStepsPerAdvance`
steps run per call (the rest of a long stall is dropped). A jump asked while no step is due is kept for the next one.
`renderPosition(out)` and `renderYaw()` give the pose between the last two steps for drawing; a step up or down is
eased in the drawn height over `stepSmoothing` seconds, the simulated position is not. Only `+ − × ÷`, `Math.sqrt` and
the reproducible `detAtan2` run in a step, so the same inputs give the same path bit for bit.

The heading has the convention of a view's yaw: yaw 0 faces −z, the facing direction is (−sin yaw, −cos yaw). A
`FollowRig` with `yawDeg` equal to the walker's yaw in degrees looks the way the body faces, and the rig's `forward`
turns a "forward and right" input into the world direction of the intent.

<!-- check: wrap -->
```ts
import { CollisionWorld, Walker, newWalkIntent } from 'wallhammer-web/world';

const world = new CollisionWorld({ heightAt: (x, z) => 0.1 * x + 0.05 * Math.sin(z) });
world.addBox(6, 0, 2, 2, 0, 0, 0.3); // a step the body walks up
world.addBox(6, 6, 0.2, 4, 0, 0, 3); // a wall it slides along

const body = new Walker(world, { runSpeed: 5, jumpSpeed: 4 }); // the rest from DEFAULT_WALKER
body.teleport(0, 0, 0);
const intent = newWalkIntent(); // allocate once, reuse every frame
const drawAt = new Float64Array(3);

// Once per frame: the intent from the input, the walker advanced by the frame's real seconds.
function frame(dtSeconds: number, forward: number, right: number, cameraYawRad: number): void {
  // Forward and right in the camera's frame to a world direction (yaw 0 faces −z).
  const s = Math.sin(cameraYawRad);
  const c = Math.cos(cameraYawRad);
  intent.moveX = -s * forward + c * right;
  intent.moveZ = -c * forward - s * right;
  intent.run = false;
  intent.jump = false;
  body.advance(dtSeconds, intent);
  body.renderPosition(drawAt); // draw the figure here, turned by body.renderYaw()
}
frame(1 / 60, 1, 0, 0);
console.log(body.position, body.velocity, body.grounded, body.steep, body.yaw, body.travelled);
```

| Member | Meaning |
| --- | --- |
| `new Walker(world, setup?)`, `setup` | `WalkerSetup` over `DEFAULT_WALKER`: `radius` 0.3, `height` 1.7, `walkSpeed` 1.6, `runSpeed` 4.5 m/s, `acceleration` 20 m/s², `airControl` 0 (no steering in the air), `airTurnSpeed` 0 rad/s (no turning in the air), `jumpSpeed` 4.2 m/s (0: no jumps; a jump 0.9 m high, 0.86 s in the air), `gravity` 9.81, `maxStepUp` 0.35 m, `maxSlopeDeg` 45, `stepHz` 60, `turnSpeed` 12 rad/s, `stepSmoothing` 0.1 s, `maxStepsPerAdvance` 15; `deceleration`, `runAcceleration`, `turnSpeedAtRun` 0 (off, see [Momentum](#momentum)). |
| `retune(tuning)`; type `WalkerTuning`, `WALKER_TUNING_KEYS` | Changes the speeds, rates and jump (`walkSpeed`, `runSpeed`, `acceleration`, `deceleration`, `runAcceleration`, `turnSpeed`, `turnSpeedAtRun`, `airControl`, `airTurnSpeed`, `jumpSpeed`) from the next step on, keeping the state; a field left out keeps its value. The size, step rate and ground limits are fixed at construction. `ChartWalker.retune` does the same and keeps it over recharts. |
| `position`, `velocity` | Feet and velocity (x, y, z), `Float64Array`s; read them, change them through `teleport`. |
| `yaw`, `grounded`, `steep` | Heading in radians; standing on ground; standing on a base too steep to climb (sliding). |
| `travelled`, `steps` | Horizontal metres moved (for the stride of an animation); fixed steps since the last `teleport`. |
| `renderTravelled(alpha?)`, `lastStepDistance` | `travelled` between the last two steps for drawing (a stride in step with `renderPosition`); horizontal metres of the last step (÷ `stepSeconds`: the speed), 0 after a `teleport`. |
| `advance(dt, intent)` | Runs the fixed steps due in `dt` real seconds; returns how many ran. |
| `step(intent)`, `stepSeconds` | One fixed step, for scripts and tests; its length in seconds. |
| `renderPosition(out)`, `renderYaw()`, `alpha` | The pose between the last two steps for drawing; the share of the way to the next step. |
| `teleport(x, y, z, yaw?)` | Puts the feet at a point with no velocity; the body settles onto the ground in the next step. |
| `WalkIntent`, `newWalkIntent()` | `moveX`, `moveZ` (world direction, length at most 1), `run`, `jump` (true in the step a jump is asked). |

### Momentum

Three options of `WalkerSetup` give a body weight. Each is 0 by default, and with all three at 0 a step is the same,
bit for bit, as without them (`pnpm check:walk`, `walker-momentum-defaults-unchanged`).

| Option | Effect |
| --- | --- |
| `deceleration` | The rate, m/s², at which the velocity changes when the wanted speed is lower than the current one (letting go, slowing from a run to a walk). A body at `runSpeed` v stops in v² / (2 deceleration) metres in the continuous limit; in fixed steps of dt a little sooner, in v² / (2 deceleration) − v · dt / 2 (exactly when v / (deceleration · dt) is a whole number of steps, otherwise at most deceleration · dt² / 8 more). Only on the ground. 0: `acceleration`. |
| `runAcceleration` | The rate while running and speeding up: a run-up slower than a start to a walk. Only on the ground. 0: `acceleration`. |
| `turnSpeedAtRun` | The fastest turn on the ground at `runSpeed`, rad/s. The turn rate falls linearly from `turnSpeed` at `walkSpeed` (and below) to this at `runSpeed` (and above), and on the ground the direction of the velocity turns no faster than that, so a runner turns in an arc of radius speed / rate instead of on the spot. The yaw turns at the same rate. At an unchanged speed the velocity changes by the larger of `acceleration` and `deceleration`, so the arc is no tighter than speed² / that. 0: `turnSpeed` at every speed, and the velocity moves straight toward the wanted one. |

Measured on flat ground at 60 steps per second (`pnpm check:walk`): from 4.5 m/s the default setup stops in 0.47 m,
`deceleration` 9 in 1.09 m, `deceleration` 5 in 1.99 m (v²/2d is 2.025 m; less half a step's travel, v · dt / 2,
1.9875 m, which a whole number of steps gives exactly); in the air every option but `airControl` is set aside and the
velocity changes at `airControl × acceleration` (`walker-air-control-rate-is-acceleration`); with `turnSpeedAtRun` 3 a run reversed from 4.5 m/s swings
3.0 m sideways (2 × speed / rate). The examples' movement profiles (`examples/shared/src/figures/profiles.ts`) are
worked sets of these numbers; switch them while walking with `retune`.

```ts
import { CollisionWorld, Walker } from 'wallhammer-web/world';

const world = new CollisionWorld({ heightAt: () => 0 });
// A loaded body: a slow run-up, a long stop, wide turns at a run.
const body = new Walker(world, { walkSpeed: 1.2, runSpeed: 3.8, acceleration: 6, runAcceleration: 3.5, deceleration: 6, turnSpeed: 5, turnSpeedAtRun: 1.5 });
// Lighter after putting the load down; the state is kept.
body.retune({ runSpeed: 4.6, acceleration: 12, runAcceleration: 7, deceleration: 12, turnSpeed: 8, turnSpeedAtRun: 2.5 });
```

CPU time of one step in plain Node in the development container, in a world of 2,000 solids, mean of 10,000 steps
(`pnpm check:walk` prints it each run): 3–4 µs, up to 15 µs measured while the machine was heavily loaded (target 20 µs).

### Saving and restoring

`saveState(out?, offset?)` writes the walker's whole moving state (position, velocity, yaw, ground and jump flags,
travelled distance, step count, the previous pose and distance for interpolation and the step remainder) as `WALKER_STATE_BYTES`
(160) bytes: 20 doubles, the first a format version. `loadState(bytes, offset?)` restores it into a walker of the same
setup and world. Without `out` the bytes are the walker's own scratch: copy them to keep them.

`simState(name)` wraps both as a part of a fixed-step simulation's state (the shape of `SimState` of `sim`; `world`
does not import `sim`, the two only agree on `bytes` and `into`), so `Simulation.addState(walker.simState('walker'))`
saves, restores and hashes it with the rest. Step the walker from a system of that simulation with `step(intent)`, one
step per tick, and draw it with the simulation's alpha: `renderPosition(out, alpha)`, `renderYaw(alpha)` and
`renderTravelled(alpha)` take an external share of the way (clamped to 0..1) in place of the walker's own `alpha`. A
stride animation reads its phase from `renderTravelled` and its weight from the speed of the last step,
`lastStepDistance / stepSeconds`, so nothing outside the simulation's state has to be kept or reset.

<!-- check: wrap -->
```ts
import { Simulation } from 'wallhammer-web/sim';
import { CollisionWorld, Walker, newWalkIntent } from 'wallhammer-web/world';

const world = new CollisionWorld({ heightAt: () => 0 });
const walker = new Walker(world, { stepHz: 60 });
const sim = new Simulation({ seed: 'walk', hz: 60 });
sim.addState(walker.simState('walker'));
const intent = newWalkIntent();
intent.moveX = 1;
sim.addSystem('walk', () => walker.step(intent));
const kept = walker.saveState().slice();
walker.loadState(kept);
const at = [0, 0, 0];
walker.renderPosition(at, sim.alpha);
const stride = walker.renderTravelled(sim.alpha) / 1.4; // passes of a 1.4 m walk cycle
const speed = walker.lastStepDistance / walker.stepSeconds; // m/s over the last tick
```

### Solids from a mesh

For compact things whose solid is roughly their footprint, `meshPrismFootprint(positions, options?)` gives the
upright prism over the convex hull (in x, z) of a mesh's vertices, from its lowest to its highest vertex, and
`meshCylinderFootprint` the upright cylinder round the centroid of that hull reaching its farthest corner.
`addMeshSolid(world, positions, options?)` adds either (`shape: 'prism'` default, or `'cylinder'`) to a
`CollisionWorld` with the usual `SolidOptions` and returns the id (−1 for no footprint). Options (`MeshFootprintOptions`):

| Option | Default | Meaning |
| --- | --- | --- |
| `stride` | 3 | Numbers per vertex, the position first. |
| `indices` | none | Only the vertices these name count. |
| `from`, `to` | whole buffer | A vertex range (a group in a shared buffer); ignored with `indices`. |
| `transform` | none | 12 numbers, mesh → world (a `Mat34`, the same layout as an instance record). |
| `below` | all | Only vertices at most this far above the lowest one shape the outline: an overhang the body passes under is left out. |
| `grow` | 0 | Moves the corners outward (negative: inward), metres. |
| `snap` | 0.05 | Outline points are rounded to this grid before the hull (0: exact). |

`convexHullXZ(points)` is the hull itself (x, z pairs, counter-clockwise, no collinear points). These run at build time
and allocate. A hull fills in concave shapes: an L-shaped thing needs one solid per arm.

<!-- check: wrap -->
```ts
import { mat34Translation } from 'wallhammer-web/base';
import { CollisionWorld, addMeshSolid, meshCylinderFootprint } from 'wallhammer-web/world';
declare const positions: Float32Array; // x, y, z per vertex

const world = new CollisionWorld({ heightAt: () => 0 });
const place = mat34Translation(10, 0, 4);
const id = addMeshSolid(world, positions, { transform: place, below: 2.2, grow: 0.05, standable: false });
const round = meshCylinderFootprint(positions, { transform: place });
if (round) world.addCylinder(round.x + 3, round.z, round.radius, round.minY, round.maxY);
console.log(id);
```

### Seeing the solids

`collisionLines(world, options?)` in `wallhammer-web/tools` draws the solids of a collision world as a wireframe
(`LINE_LAYOUT` lines, drawn with a one-colour line material): a prism as its outline at the bottom and the top with an
upright at each corner, a cylinder as two circles with four uprights. `select(info, id)` keeps only some solids (draw
standable, blocking and invisible ones in different colours), `segments` sets the circle (default 16), `floorY` cuts
off the bottom of solids that reach far below the ground. Build it once, after the solids are added; it is a debugging
view, not drawn in normal use. The walking example (`examples/walk`, key `C`) shows it.

<!-- check: wrap -->
```ts
import { CollisionWorld } from 'wallhammer-web/world';
import { collisionLines } from 'wallhammer-web/tools';

const world = new CollisionWorld({ heightAt: () => 0 });
world.addBox(0, 0, 1, 1, 0, 0, 2, { standable: false });
const standable = collisionLines(world, { select: (s) => s.standable });
const blocking = collisionLines(world, { select: (s) => !s.standable, segments: 24, floorY: -1 });
console.log(standable.count, blocking.count);
```

## Walking on a sphere

`ChartWalker` (`wallhammer-web/world`) walks a body on a sphere with the flat `CollisionWorld` and `Walker` as they are.
It keeps a **local chart** (`SurfaceChart`, `wallhammer-web/base`): flat coordinates round one point of the sphere, the
exponential map, in which chart `x` and `z` are metres along the sphere from the chart's origin and chart `y` is the
height above a reference radius. The ground of the chart's collision world is `radiusAt(direction) − radius`, so the
feet stand exactly on the world's ground. When the body gets farther than `rechartM` from the chart's origin (default
the smaller of 48 m and radius / 64), a new chart is anchored under it at the next step boundary: position, velocity,
heading and the drawing's interpolation are carried through world space, the new chart's axes are the old ones moved
along the great circle (a heading keeps its numbers), a new collision world is made, and `onRechart(chart, world)` lets
you add the solids near the body again. A rechart is a pure function of the state, so the walk stays deterministic and
independent of how the time is cut into frames.

<!-- check: wrap -->
```ts
import { ChartWalker, newWalkIntent } from 'wallhammer-web/world';

const R = 2000;
// The ground's distance from the centre in a unit direction: here a sphere with gentle bumps.
const radiusAt = (x: number, y: number, z: number): number => R + 3 * Math.sin((x * R) / 97) * Math.cos((z * R) / 131);
const tower: [number, number, number] = [0, R, -120]; // a world point the solids are kept at
const walker = new ChartWalker({
  radiusM: R,
  radiusAt,
  // Called for every new chart, the first one (made in the constructor) included.
  onRechart: (chart, world) => {
    const at = chart.fromWorld(tower[0], tower[1], tower[2], [0, 0, 0] as [number, number, number]);
    // Only what lies near the new chart's origin; x and z are metres along the sphere.
    if (Math.hypot(at[0], at[2]) < 500) world.addCylinder(at[0], at[2], 3, at[1] - 1, at[1] + 6);
  },
}, [0, 1, 0]);
walker.teleportDirection([0.1, 1, 0], 0, [0, 0, -1]); // on the ground in that direction, facing world −z

const intent = newWalkIntent();
intent.moveZ = -1; // in the chart: the walker's input is the flat walker's
walker.advance(1 / 60, intent);

const at = walker.renderPosition([0, 0, 0]); // world metres, drawn between the last two steps
const up = walker.renderUp([0, 0, 0]);
console.log(at, up, walker.chart.anchor, walker.recharts, walker.grounded);
```

`onRechart` is called for every new chart: the constructor's, a teleport's, a loaded state's and every rechart's. In
the constructor's call the walker is not built yet, so use the `chart` it is given (`toChart` of the walker does the same
later, with a reach). Members besides the walker's own: `chart`, `world` and `walker` (the current
ones; do not keep them across a frame), `position`, `velocity`, `renderPosition`, `renderChartPosition`, `renderUp`,
`renderYaw`, `renderFacing`, `renderFrame(out, alpha?, origin?)` (the body's 3 × 4 matrix in world space or relative to
a render origin: x right, y up, −z facing), `teleport(point, facing?)`, `teleportDirection(dir, above?, facing?)`,
`toChart(point, out, reach?)`, `rechart()`, `heightAboveGround`, `chartDistance`, `recharts`. `saveState` and
`loadState` hold the chart's anchor and axes with the walker's own state (`CHART_WALKER_STATE_BYTES`); a loaded state
rebuilds the same chart bit for bit and calls `onRechart` (with the loaded walker in place). The whole state is checked
first: one that is refused throws and leaves the walker, its chart and its world as they were. A chart's frame is
orthonormal for every anchor, also next to the sphere's −y pole, where `upFrame` alone is not. The point straight
opposite a chart's origin is π · radius away along the sphere; `fromWorld` puts it there, on the chart's +x axis, and
`toChart` takes it as within reach only of a reach that long.

The view of a walking body on a sphere is `ChartFollowView` (`wallhammer-web/camera`, see Cameras): a `FollowRig` in the
chart's coordinates shown in world space.

Limits of the method (measured by `pnpm check:walk`, scenarios `sphere-*`):

- Exact in height: the feet stand on `radiusAt` to 1e-10 m on spheres of 2 km and 100 km.
- Along the ground a chart stretches lengths across the direction from its origin by about θ² / 6 (θ = distance /
  radius): 1e-4 at 48 m on a sphere of 2 km, so a speed or a solid's size is off by that much near the edge of a chart.
  It is meant for a radius much larger than `rechartM`; a sphere smaller than about 300 m makes charts so short that
  solids near the body are added again very often.
- Solids live in one chart: a solid is laid flat in the chart, so a long one far from the chart's origin does not bend
  with the sphere, and one that the body is touching at a rechart may be met a few millimetres off where it was. Add
  them again in `onRechart`, from world positions.
- Slopes are measured in the chart: the ground of a perfect sphere is flat there (chart y is the height above the
  sphere), and a slope's angle is off by the stretch above and by height / radius. Gravity is the chart's −y, which at
  the foot is the local down.
- One chart per walker: two bodies walking near each other each have their own chart and do not see each other.

## Solids of streamed cells

The instances of streamed cells (houses, trees, rocks of a game) are plain records in their cells; a walker does not
meet them until they are solids of its collision world. Three parts make them so, all in plain Node:

1. **A descriptor per archetype**, `InstanceSolid` (`wallhammer-web/base`, plain data next to `InstanceBounds`): which
   floats of an instance record are the base point, the radius and the height (or constants `radiusM`, `heightM`),
   factors on them (`radiusScale`, `heightScale`), how far the solid reaches under its base (`belowM`), which way it
   stands (`up: 'y'` on a flat world, `'radial'` on a sphere), `standable`, `blocksSight`, and `minRadiusM` to skip small
   ones. With `box: { turn, sizeX, sizeZ?, scale? }` it is an upright box turned about up the way `addBox` turns (in the
   frame `upFrame(up)` on a sphere, the shaders' `localFrame`); a `sizeZ` of 0 takes `sizeX`, and a half extent is the
   size times `scale` (default 0.5). An archetype without a descriptor is not solid.
2. **`SolidIndex`** (`wallhammer-web/world`): the solids of the cells added to it, in world metres (double precision),
   kept in a spatial hash of cubes (`bucketM`, default 32 m) keyed on the middle of each solid's axis. `addCell(content)`
   reads the records (new content of a cell replaces its solids; all or nothing: a layout whose stride is not a
   positive multiple of 4 bytes, or a solid outside the hash's range of ±65,536 cubes, throws and leaves the index and
   the cell's earlier content as they were), `removeCell(cell)` drops them. `within(point, radius,
   visit)` is the general question "what stands within a radius of this point": every solid whose axis comes within
   `radius` plus its own radius of the point, with its base point, up, radius, height, box, archetype, instance id
   (`idHigh`, `idLow`), cell and `distance` (to the axis, less its radius). It works the same on a flat world and on a
   sphere, allocates nothing and hands one reused `SolidHit` to `visit`. Its cost is bounded by the solids in the
   index: a query that would visit more cubes than there are solids (a huge solid, a wide radius) looks at every solid
   instead, and the margin a query is grown by follows the largest solid in the index, not the largest ever added. A
   listener (`listen`) may stop itself while it is told. `keep(archetype, data, offset)` in the options
   filters instances by their record. Fed by hand, or from a `StreamedWorld` with `streamSolids` of `runtime` (see
   [Solids of resident cells](streaming.md#solids-of-resident-cells)).
3. **`SolidFeed`** (`wallhammer-web/world`): keeps a `CollisionWorld` in step with the index, one upright cylinder or
   turned box per solid (`tag` = the slot in the index, `index.get(slot, hit)` reads it back). On a flat world
   `feed.attach(world)` once (attaching again first takes this feed's solids out of the world attached before, the same
   one or another, so nothing is added twice). On a sphere call `feed.attach(world, chart)` from the `ChartWalker`'s
   `onRechart`: the solids within `reachM` (default 160 m) of the chart's origin are added in chart coordinates, and
   cells that arrive or leave before the next rechart are added to or taken from that chart's world. The camera boom
   (`world.clearance`) sees them as well.

<!-- check: wrap -->
```ts
import type { InstanceSolid } from 'wallhammer-web/base';
import { SphereWorld } from 'wallhammer-web/world';
import { ChartWalker, SolidFeed, SolidIndex } from 'wallhammer-web/world';
import type { CellContent } from 'wallhammer-web/gen-core';
declare const arrived: CellContent; // a cell's content, from your streaming

const shape = new SphereWorld(100_000);
// Records of 8 floats: base x, y, z, reach | height, turn, width, depth.
const solids: Record<string, InstanceSolid> = {
  column: { position: 0, radius: 3, radiusScale: 0.1, height: 4, belowM: 1, up: 'radial', standable: false },
  block: { position: 0, height: 4, belowM: 1, up: 'radial', box: { turn: 5, sizeX: 6, sizeZ: 7 } },
};
const index = new SolidIndex({ solids, shape, center: shape.centerM });
index.addCell(arrived); // and index.removeCell(cell) when it leaves

const feed = new SolidFeed(index);
const walker = new ChartWalker({
  radiusM: 100_000,
  center: shape.centerM,
  radiusAt: () => 100_000,
  onRechart: (chart, world) => void feed.attach(world, chart),
});

// What stands within 5 m of the feet?
const feet = walker.position([0, 0, 0] as [number, number, number]);
index.within(feet, 5, (hit) => console.log(hit.archetype, hit.distance, hit.radius, hit.idHigh, hit.idLow, hit.cell));
```

A flat world takes the same index with `up: 'y'` descriptors and a `CollisionWorld` in world coordinates:

<!-- check: wrap -->
```ts
import { FlatWorld } from 'wallhammer-web/gen-core';
import { CollisionWorld, SolidFeed, SolidIndex } from 'wallhammer-web/world';
declare const groundAt: (x: number, z: number) => number;

const index = new SolidIndex({ solids: { post: { position: 0, radiusM: 0.4, heightM: 3 } }, shape: new FlatWorld() });
const world = new CollisionWorld({ heightAt: groundAt });
const feed = new SolidFeed(index);
feed.attach(world); // every indexed solid now, and every cell's solids as the cell comes and goes
```

Measured by `pnpm check:walk` (scenarios `solids-*`): `within` agrees with a brute-force answer, a walker stops at a
cylinder's radius and at a turned box's face to 1e-4 m on a flat world and on a sphere of 2 km (through recharts and a
rechart forced while touching), a cell arriving between recharts stops the body and one leaving lets it pass, and at
1e5 m from the centre a distance is right to 1e-5 m. CPU time in the development container: removing and adding a cell
of 500 solids about 50 µs, a `within` of 2 m about 2 µs among 12,500 solids, a chart's feed of about 1,400 solids
0.5 ms. The planet example (`examples/planet`, walk mode) makes its trees and rocks solid this way.

## Not built

- A general up inside the collision world and the walker. A sphere is walked through a moving chart (below); the places
  where a local up would replace y in the flat code are still marked `UP:` in `src/world/collide.ts` and
  `src/world/walker.ts`, for a world that a chart does not fit (a body walking round a small asteroid, inside a ring).
- Sloped or shaped tops: the top of a solid is flat at `maxY`. Ramps are made of the base surface or of thin steps.
- Solids of streamed cells are upright cylinders and turned boxes read from instance records, not the drawn meshes of
  their archetypes; a footprint of several parts (an L-shaped structure) or a prism over an outline from a record is
  not built, and a long box on a sphere is laid flat in its chart like any chart solid. An index holds the cells of the
  levels it is fed; which level holds the solids near a walker is the application's choice (`streamSolids`).
- Moving solids. Remove and add again to move one (the grid lists are updated each time). A walker standing on a
  solid is not carried with it.
- Jump timing aids: a jump asked a step after running off an edge is dropped (no grace time, "coyote time"), and so
  is one asked a step before landing (no buffer). A game can buffer by itself, keeping `intent.jump` set for a few
  frames until `grounded`; a grace time after an edge would need the walker.
- For the walker: sloped tops of solids (a ramp is the base surface), crouching, swimming, ledges to hang from,
  being pushed by other bodies (two walkers do not see each other), and a solid lower than `maxStepUp` that cannot be
  stood on (`standable: false`) is neither a side nor ground, so the body walks through it. A step up is not checked
  against a ceiling over the step.
