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
   velocity moves toward it by at most `acceleration` per second (braking the same way); in the air only
   `airControl` of it.
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
6. `yaw` turns toward the wanted direction (or, without an intent, the direction moved) at most `turnSpeed` rad/s.

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
| `new Walker(world, setup?)`, `setup` | `WalkerSetup` over `DEFAULT_WALKER`: `radius` 0.3, `height` 1.7, `walkSpeed` 1.6, `runSpeed` 4.5 m/s, `acceleration` 20 m/s², `airControl` 0.3, `jumpSpeed` 4.2 m/s (0: no jumps), `gravity` 9.81, `maxStepUp` 0.35 m, `maxSlopeDeg` 45, `stepHz` 60, `turnSpeed` 12 rad/s, `stepSmoothing` 0.1 s, `maxStepsPerAdvance` 15. |
| `position`, `velocity` | Feet and velocity (x, y, z), `Float64Array`s; read them, change them through `teleport`. |
| `yaw`, `grounded`, `steep` | Heading in radians; standing on ground; standing on a base too steep to climb (sliding). |
| `travelled`, `steps` | Horizontal metres moved (for the stride of an animation); fixed steps since the last `teleport`. |
| `advance(dt, intent)` | Runs the fixed steps due in `dt` real seconds; returns how many ran. |
| `step(intent)`, `stepSeconds` | One fixed step, for scripts and tests; its length in seconds. |
| `renderPosition(out)`, `renderYaw()`, `alpha` | The pose between the last two steps for drawing; the share of the way to the next step. |
| `teleport(x, y, z, yaw?)` | Puts the feet at a point with no velocity; the body settles onto the ground in the next step. |
| `WalkIntent`, `newWalkIntent()` | `moveX`, `moveZ` (world direction, length at most 1), `run`, `jump` (true in the step a jump is asked). |

CPU time of one step in plain Node in the development container, in a world of 2,000 solids, mean of 10,000 steps
(`pnpm check:walk` prints it each run): 3–4 µs, up to 15 µs measured while the machine was heavily loaded (target 20 µs).

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

### Not built

- A curved world (a sphere, up pointing away from a centre). The world is flat with +y up. The places where a local
  up would replace y are marked `UP:` in `src/world/collide.ts`: the vertical span of a solid in `slide`, the base
  height in `groundAt`, the height above the base in `clearance`; and in `src/world/walker.ts`: gravity, the height
  span of the body, the slope of the base and the plane of the heading.
- Sloped or shaped tops: the top of a solid is flat at `maxY`. Ramps are made of the base surface or of thin steps.
- Moving solids. Remove and add again to move one (the grid lists are updated each time). A walker standing on a
  solid is not carried with it.
- For the walker: sloped tops of solids (a ramp is the base surface), crouching, swimming, ledges to hang from,
  being pushed by other bodies (two walkers do not see each other), and a solid lower than `maxStepUp` that cannot be
  stood on (`standable: false`) is neither a side nor ground, so the body walks through it. A step up is not checked
  against a ceiling over the step.
