# Flying body

`FlyingBody` (in `wallhammer-web/world`) is a body that crawls on the ground and flies through the air over the same
`CollisionWorld` the walker uses. On the ground it moves along its heading at its own crawl and leaves the ground with
a leap; in the air it is a glider whose height and speed are traded by forces only (lift, drag, gravity, the push of
beats, a flare), banks into turns and touches down when it comes to the ground. A hull of spheres keeps it out of the
ground and every solid, however thin. It runs in fixed steps, deterministically, without allocating, in plain Node.
The same body with other numbers is a glider, a hang-glider, a flying animal, a paper plane or a drone that only
glides; the movement example flies a large animal with the build of a ray on it (`examples/movement`, key `E` behind
its left wing).

## Frames and units

- `position` is the point under the middle of the body (on the ground while it is grounded). The body's frame has its
  origin there, +x to the right, +y up and **−z forward**; yaw 0 faces −z, as for a view, the walker and `FollowRig`.
- `pitch` turns the nose up (+), `bank` rolls the right side down (+, a right turn). Both are drawn: the body is a
  point mass with a heading; the attitude turns the hull and the picture, not the physics.
- Metres, seconds, radians. Gravity is along −y.

## Setup and the frame loop

<!-- check: wrap -->
```ts
import { CollisionWorld, FlyingBody, newFlyingIntent } from 'wallhammer-web/world';
import { mat34Identity } from 'wallhammer-web/base';

const world = new CollisionWorld({ heightAt: (x, z) => 0.3 * Math.sin(x * 0.05) + 0.2 * Math.sin(z * 0.07) });
world.addBox(0, -60, 8, 0.3, 0, 0, 12); // a wall across the way

// Any field left out takes DEFAULT_FLYING_BODY's value (a reference set; a game passes its own body's numbers).
const body = new FlyingBody(world, {
  hull: [0, 0.6, 0, 0.45, -1.6, 0.8, 0, 0.35, 1.6, 0.8, 0, 0.35], // a trunk and two wings
  groundHull: [0, 0.6, 0, 0.45], // folded on the ground
  groundSpeed: 2.3,
  trimSpeed: 11,
  glideRatio: 9,
  stallSpeed: 7.5,
});
body.teleport(0, world.groundAt(0, 0, 1e4, 0), 0, 0);

const intent = newFlyingIntent();
const m = mat34Identity();
function frame(dt: number, keys: { up: boolean; down: boolean; left: boolean; right: boolean; space: boolean; shift: boolean }, leap: boolean): void {
  const air = !body.grounded;
  intent.forward = air ? 0 : (keys.up ? 1 : 0) - (keys.down ? 1 : 0); // the crawl
  intent.pitch = air ? (keys.down ? 1 : 0) - (keys.up ? 1 : 0) : 0; // nose up and down
  intent.turn = (keys.right ? 1 : 0) - (keys.left ? 1 : 0); // a turn on the ground, a bank in the air
  intent.beat = keys.space ? 1 : 0; // beats push along the path and up
  intent.brake = air && keys.shift ? 1 : 0; // a flare
  intent.takeOff ||= leap && !air; // a leap off the ground, used once
  body.advance(dt, intent); // fixed steps (60 Hz); the leftover carries over
  intent.takeOff = false;
  body.renderMatrix(m, body.alpha); // the drawn frame between the last two steps
}
frame(1 / 60, { up: true, down: false, left: false, right: false, space: false, shift: false }, false);
```

`renderPosition`, `renderYaw`, `renderPitch`, `renderBank` and `renderBeatPhase` give the drawn state one part at a
time (a skeleton posed from the beat and the bank, say). `grounded`, `perched`, `speed`, `forwardSpeed`, `altitude`
(above the ground under it), `liftCoefficient`, `load` (the lift in weights), `stalled`, `beatEffort`, `flare`,
`takeOffs`, `touchDowns`, `touchDownSpeed`, `contacts` and `impactSpeed` are read after a step.

## On the ground

The crawl speeds up and brakes along the heading (`groundSpeed`, `groundBackSpeed`, `groundAcceleration`,
`groundDeceleration`), turns at `groundTurnSpeed`, follows the ground under the position (up steps to `maxStepUp`; a
drop deeper than `maxStepDown` ends the ground) and is held back sideways by solids (the hull, or `groundHull` when the
body folds itself to crawl). `takeOff` leaps: `leapSpeed` up and `leapForwardSpeed` forward, added to the crawl. A body
that touches down keeps its speed along the heading and brakes it at `landingDeceleration`.

## In the air

A polar of one parameter, the lift coefficient `cl` (1 at trim):

- lift = g · (V / `trimSpeed`)² · cl, along the path's up turned by the bank: a level glide at `trimSpeed` is held;
- drag = g / `glideRatio` · (V / `trimSpeed`)² · (1 + cl²) / 2, so lift over drag is `glideRatio` at cl 1 (the best
  glide) and a steeper or flatter attitude costs height;
- the pitch input moves cl between `minLift` and `maxLift`; a bank asks extra lift to hold the turn level
  (`turnLift`), the most is `maxLoad` weights; the horizontal share of the lift turns the path (r = V² / (g tan φ) in a
  level turn) and the heading follows the path;
- below `stallSpeed` (over `stallBand`) the lift falls to `stallLift` of itself and the drag stays: a stall, out of
  which the body dives to speed again;
- beats push along the path (`beatThrust`) and up (`beatLift`), eased in and out over `beatEase`, in a cycle of
  `beatRate` a second (`beatPhase`); `beatPulse` puts the push into the down stroke;
- a flare (`brake`) adds `flareDrag` and `flareLift`, for a landing;
- `pathDamping` damps the slow swing between climbing and diving of a free glider;
- over `ceilingY` the lift fades out over `ceilingBand`: the body cannot climb past it.

No speed is ever set: a climb bleeds speed, a dive gains it.

`softBeatRate` (when set) makes light beats slower: the cycle runs from `softBeatRate` at the lightest effort to
`beatRate` at full. `fastDrag` adds drag growing with (q − 1)² above the trim speed (q = (V / `trimSpeed`)²), so beats
reach a top speed instead of pushing on. Both are off by default.

## Flight assist

`FlightAssist` (in `wallhammer-web/world`) flies a `FlyingBody` from what a player means: a wanted speed (moved by a
throttle and kept when it is let go), a climb or descent (−1..1) and a turn (−1..1). It writes the body's
`FlyingIntent` before every fixed step; the body stays the same glider with the same forces and bits.

<!-- check: wrap -->
```ts
import { CollisionWorld, FlightAssist, FlyingBody, newFlightAssistInput, newFlyingIntent } from 'wallhammer-web/world';

const world = new CollisionWorld({ heightAt: () => 0 });
const body = new FlyingBody(world, { trimSpeed: 11, stallSpeed: 7.5 });
body.teleport(0, 0, 0, 0);
// Any field left out takes DEFAULT_FLIGHT_ASSIST's value (a reference set for DEFAULT_FLYING_BODY).
const assist = new FlightAssist(body, { minSpeed: 8.7, cruiseSpeed: 13, maxSpeed: 20, climbRate: 3.5 });

const intent = newFlyingIntent();
const input = newFlightAssistInput();
function frame(dt: number, keys: { w: boolean; s: boolean; a: boolean; d: boolean; space: boolean; shift: boolean }, leap: boolean): void {
  const air = !body.grounded;
  intent.forward = air ? 0 : (keys.w ? 1 : 0) - (keys.s ? 1 : 0); // the crawl stays the caller's
  intent.takeOff ||= leap && !air; // and the leap
  input.throttle = air ? (keys.w ? 1 : 0) - (keys.s ? 1 : 0) : 0; // faster, slower
  input.climb = air ? (keys.space ? 1 : 0) - (keys.shift ? 1 : 0) : 0; // up, down (and a landing)
  input.turn = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  assist.advance(dt, input, intent); // in place of body.advance: pitch, beat, brake and turn written every step
  intent.takeOff = false;
}
frame(1 / 60, { w: true, s: false, a: false, d: false, space: false, shift: false }, false);
const shown = `${assist.wantedSpeed.toFixed(1)} m/s wanted, ${body.speed.toFixed(1)} m/s flown`;
```

- **Speed.** The throttle moves `wantedSpeed` at `speedChange` m/s a second between `minSpeed` and `maxSpeed` (never
  under `safeSpeed`); the speed follows over `speedTime`, with beats to speed up and a flare (up to `maxBrake`, at most
  `maxDeceleration`) to slow down. Hands off it keeps its speed and height, beating as much as that needs.
- **Height.** With no climb asked the height of the moment is held (`holdGain`); a climb or a descent is held at
  `climbRate` or `descentRate` over `climbTime`, capped at `maxVerticalAcceleration`, the speed held meanwhile. Under
  the ceiling (`ceilingY − ceilingBand`) it does not climb.
- **Turn.** The bank asked, held level with the speed kept, but no steeper than the lift at `maxLift` holds at the
  speed with `turnReserve` of its margin kept back.
- **Stall.** `safeSpeed` is the highest of `minSpeed`, `stallSpeed + stallMargin` and the speed at which 80 % of the
  lift at `maxLift` holds the weight. More than `stallMargin / 2` under it, no climb and a dive (`stallDive`) back to
  speed.
- **Ground.** On the ground it writes the turn only (pitch, beat and brake 0); the crawl and the leap stay the
  caller's. After a take-off the held height is at least `departHeight` over the ground. Under `landingHeight` a descent
  eases to `landingSink` and the wings level out, so coming down slowly lands.
- **Solids.** Touching something (`contacts`) while the speed stays under `blockShare` of the wanted one for
  `blockTime`, it is `blocked`: no beats and no flare and the held height let go, so the body slides off the solid or
  settles down and lands instead of pushing against it. It is cleared after `blockTime` with no contact.

`step(input, intent)` is one fixed step for a script; `steer(input, intent)` only writes the intent (the body's
`advance(dt, intent, prepare)` calls a `prepare(intent)` before every fixed step, where a game can call it with its own
changes on top). `reset(speed?)` puts the wanted speed back to `cruiseSpeed` and the held height to where the body is.
`wantedSpeed` and `holdY` are plain numbers to save beside the body's state. Deterministic, no allocation per step
(`pnpm check:walk`, the `flying-assist-*` scenarios).

## Contacts

Every step moves in sub-steps no longer than half the smallest sphere's radius and pushes the hull's spheres out of the
ground and every solid (`CollisionWorld.sphereContacts`; solids tagged `skipTag` are left out). The speed into a contact
is taken away (`restitution` gives a share back, `scrapeFriction` slows the slide along it). A body that comes to rest in
the air held up by its hull (on top of a solid that is not ground, or on the ground at a slant) is put down there:
`perched`, standing on that hold until it crawls off it. Levelling out there, it sinks with the levelling so the hull
stays on the hold (or comes down on the ground under it) instead of hopping off it.

## Saving and restoring

`saveState(out?, offset?)` writes the whole moving state (`FLYING_BODY_STATE_BYTES`, 320 bytes) and `loadState(bytes,
offset?)` restores it into a body with the same setup; `simState(name)` makes the body a part of a simulation's state.
Two runs with the same intents are bit-equal (`pnpm check:walk`, the `flying-*` scenarios).

## Limits

- A flat world with +y up: no chart form for a sphere yet (the places are marked `UP:` in the source).
- A point mass: the attitude is drawn, not simulated; there is no wind, no lift of the ground, no rotation of the hull
  by a contact.
- One body: two flying bodies pass through each other unless the game keeps them apart.
