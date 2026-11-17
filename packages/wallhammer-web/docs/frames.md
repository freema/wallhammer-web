# Bodies on rails and nested frames

This page covers scenes that are far larger than a flat map: several bodies that move round each other, each with a surface you can stand on. Three parts work together. All of them are plain math, run in Node, and change nothing in a scene that does not use them.

| Part | Entry | What it is |
| --- | --- | --- |
| Reproducible trigonometry | `wallhammer-web/base` | `detSinCosTurns` and relatives: the same bits on every machine. |
| Nested frames | `wallhammer-web/base` | `FrameSet`: positions in 64 bits, conversion between frames, 32-bit numbers relative to the eye for the GPU. |
| Orbits and spin from time | `wallhammer-web/core` | `prepareOrbit`, `orbitPosition`, `spinRotation`, and `BodySystem`, which places a whole system in a `FrameSet`. |

Axes are those of the rest of the engine: one unit is one metre, y is up. On a surface patch x points east and z south, as on a flat map.

## Scale

The engine is built and tested for a reduced scale, not for real astronomical sizes:

| Quantity | Range |
| --- | --- |
| Radius of a body | 50 km to 300 km |
| Distance between bodies | tens of thousands of km; tested up to 100,000 km from the centre |
| Day and year | free; periods are given directly, not derived from masses, so a day can last minutes |

Travel between bodies is short enough to need no special mode, and time can be sped up. Nothing in the code enforces these ranges. Positions are 64-bit, so at 100,000 km from the centre one step of a coordinate is 0.00001 mm.

## Reproducible trigonometry

`Math.sin` and its relatives may differ in the last bit between machines, and between Node and a browser. Anything whose result must agree everywhere uses the `det` functions instead. They are built only from `+ − × ÷` and `Math.sqrt` in a fixed order.

```ts
import { detAtan2, detSinCos, detSinCosTurns } from 'wallhammer-web/base';

const [s, c] = detSinCosTurns(0.125); // 45°, the angle in turns
const [s2, c2] = detSinCos(Math.PI / 4); // the same in radians
const angle = detAtan2(s, c); // radians, −π … π
```

Keep an angle that grows with time in turns (`phase + t / period`). The whole turns are dropped without rounding, so the angle stays precise after any number of turns. `detSinCos` takes radians and keeps an absolute error near 1e-16 up to about a million radians; a result close to zero then has fewer correct digits than one in turns, and beyond that range the accuracy drops further.

The functions are accurate to about one unit in the last place. They are not the correctly rounded values and they are not bit-equal to `Math.sin`; they are equal to themselves everywhere.

## Orbits and spin from time

An orbit is a Kepler ellipse round the origin of the parent. `prepareOrbit` checks the elements and works out the constant part. `orbitPosition` and `orbitVelocity` are then pure functions of time: no state is kept, so stepping through time and jumping to a moment give the same bits.

```ts
import { orbitPosition, orbitVelocity, prepareOrbit, prepareSpin, spinRotation } from 'wallhammer-web/core';

const orbit = prepareOrbit({
  semiMajorAxis: 40_000_000, // metres
  periodS: 5400, // one round; negative goes the other way
  eccentricity: 0.2, // 0 … ORBIT_MAX_ECCENTRICITY (0.9)
  inclinationDeg: 12,
  ascendingNodeDeg: 75,
  periapsisDeg: 200,
  phase: 0.3, // turns of mean anomaly at time 0
});
const p = orbitPosition(orbit, 1234.5); // metres, in the parent frame
const v = orbitVelocity(orbit, 1234.5); // m/s

const spin = prepareSpin({ periodS: 600, tiltDeg: 23.5, tiltLongitudeDeg: 40 });
const q = spinRotation(spin, 1234.5); // a unit quaternion [x, y, z, w]
```

The reference plane is the xz plane. Longitudes are measured in it from +x toward −z (anticlockwise seen from +y). Kepler's equation is solved with exactly `ORBIT_SOLVER_STEPS` Newton steps, never "until it converges", so the result does not depend on a tolerance. `solveKepler` is exported for code that needs the anomaly itself.

## A system of bodies

`BodySystem` takes a list of bodies and owns a `FrameSet`. Each body gets two frames:

- `carriedFrame`: the origin is the centre of the body, the axes stay parallel to the system. Bodies that go round this one hang under it, so they do not turn with it.
- `turningFrame`: the same origin, turned by the spin. +y is the axis of the body. Everything that stands on the body hangs under it.

```ts
import { BodySystem } from 'wallhammer-web/core';

const system = new BodySystem([
  { name: 'light', radius: 300_000 },
  { name: 'home', radius: 100_000, orbit: { semiMajorAxis: 20_000_000, periodS: 5400 }, spin: { periodS: 600, tiltDeg: 23.5 } },
  { name: 'companion', parent: 'home', radius: 50_000, orbit: { semiMajorAxis: 1_200_000, periodS: 900, inclinationDeg: 12 } },
]);

const HZ = 20;
system.setTick(36_000, HZ); // the state 30 minutes in, however the clock got there
const home = system.body('home');
const centre = system.frames.pose(home.carriedFrame).origin; // 64-bit, in the frame of the system
```

A parent must come before its children in the list. A body without an orbit stays at the centre of its parent.

**Keep time as a whole number of ticks.** `setTime(t)` depends on `t` alone, but a `t` that was summed from fractional steps is itself different from a `t` computed in one go. `setTick(tick, hz)` divides once. The golden test steps a system 40,000 ticks and compares it bit for bit with a system that jumps.

`fingerprint()` returns a 32-bit digest of every frame. Print it in the browser and in Node for the same tick to check that both agree.

The golden scenarios have one digest of their own for the same purpose. It must print the same text in Node and in the console of a page served by the dev server:

```sh
docker compose exec -T web sh -c 'cd /app && node --input-type=module -e "import(\"/app/tools/golden/frames-scenario.ts\").then((m) => console.log(m.framesDigest()))"'
```

```js
(await import('/@fs/app/tools/golden/frames-scenario.ts')).framesDigest();
```

### Day, night and seasons

They need no code of their own. They follow from the spin and the tilt:

```ts
import { directionFromDeg } from 'wallhammer-web/base';
import { BodySystem } from 'wallhammer-web/core';

declare const system: BodySystem;
const home = system.body('home');
const light = system.body('light').carriedFrame;

// Direction toward the light, in the turning frame of the body.
const { direction } = system.frames.directionTo(light, home.turningFrame);
const up = directionFromDeg(50, 14); // a place: latitude 50°, longitude 14°
const isDay = direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2] > 0;

// The place that has the light overhead. Its latitude is the season: it swings between
// plus and minus the tilt over one round. Its longitude is where it is noon.
const under = system.subPoint(home.index, light);
const hour = ((((14 - under.longitudeDeg) / 360 + 0.5) % 1) + 1) % 1 * 24; // local solar time at longitude 14°
```

To light a scene drawn in a surface patch, ask for the direction in the frame of that patch: `system.frames.directionTo(light, patch).direction` is a unit vector with y up, ready for `Renderer.lightDirection`.

## Nested frames

A frame is an origin and a rotation in its parent. `FrameSet` stores them as 64-bit numbers and converts between any two frames under the same top frame. A conversion climbs to the lowest frame the two share and descends again, so the large numbers of the upper levels never enter a conversion between neighbours.

```ts
import { directionFromDeg, relativeMatrix, relativePoints, tangentPose } from 'wallhammer-web/base';
import { BodySystem } from 'wallhammer-web/core';

declare const system: BodySystem;
const frames = system.frames;
const home = system.body('home');

// A patch of the surface: origin on the sphere, x east, y up, z south.
const patch = frames.add('patch', home.turningFrame, tangentPose(directionFromDeg(50, 14), home.radius));
const neighbour = frames.add('neighbour', home.turningFrame, tangentPose(directionFromDeg(50.5, 14), home.radius));

// The image is drawn in the frame the camera is in; the eye is a 64-bit point of that frame.
const drawIn = patch;
const eye: [number, number, number] = [812.5, 1.7, -1340];

// Model matrix of another frame for the GPU: 32-bit, relative to the eye.
const model = relativeMatrix(frames.relativePose(neighbour, drawIn), eye);

// Or many 64-bit points at once (x, y, z triples local to `neighbour`).
const centres = new Float64Array([0, 0, 0, 512, 3, -128]);
const forGpu = relativePoints(centres, frames.relativePose(neighbour, drawIn), eye);
```

Rules that keep the image steady:

- Keep every position in the frame where it is small: a thing on the ground in its patch, a body in the frame of its parent.
- Never send an absolute position to the GPU. Send `relativeMatrix` or `relativePoints`; both subtract the eye in 64 bits and round once.
- The eye passed here and the origin the view matrix is built round must be the same point (`Renderer.worldOrigin` for a renderer that draws relative to a moving origin).

The golden test puts an object on a turning body 100,000 km from the centre. The position the GPU gets is within 0.001 mm of the truth in every drawing frame. Absolute 32-bit coordinates are off by four metres there.

`convertPoint`, `convertDirection` and `convertRotation` convert a single value. `directionTo(target, frame, at)` gives the unit direction and the distance from a point to the origin of another frame.

### Moving frames and reparenting

A frame may carry its motion: the velocity of its origin and its angular velocity (`setMotion`). `BodySystem.setTime` sets both for every body frame. `convertState` converts a point together with its velocity and accounts for the motion of the frames on the way: a thing that stands on a turning body moves when seen from outside.

`reparent(id, parent)` hands a frame to another parent without moving it. Its pose, velocity and angular velocity are rewritten. Use it when something travels from one body to another:

```ts
import { BodySystem } from 'wallhammer-web/core';

declare const system: BodySystem;
const frames = system.frames;
const craft = frames.add('craft', system.root, { origin: [0, 0, 30_000_000] });

// Index of the body the craft is kept by; −1 while it is in the frame of the whole system.
let attached = -1;

// On a simulation step, never between steps. The point [0, 0, 0] of the craft's own frame is the craft.
const enter = system.dominantBody([0, 0, 0], craft); // the body whose reach holds the craft, or −1
const keep = system.dominantBody([0, 0, 0], craft, 1.1); // the same with every reach 10 % larger
// Stay with the current body while its enlarged reach still wins; otherwise go where the plain reaches say.
// A body is entered at its reach and left only 10 % beyond, so the answer does not flip on the boundary.
const next = keep === attached ? attached : enter;
if (next !== attached) {
  frames.reparent(craft, next >= 0 ? system.bodies[next]!.carriedFrame : system.root);
  attached = next;
}
```

`dominantBody` picks the most deeply nested body whose reach (`BodyDef.influence`, by default `BODY_INFLUENCE_RADII` radii) holds the point. A frame that follows a camera can be reparented the same way; convert the camera's own position and orientation with `convertPoint` and `convertRotation` before the frame they were given in changes.

## Checks

Three golden recipes cover this page (`tools/golden/engine/frames-scenario.ts`): a fixed table of the `det` functions, a system stepped against a system that jumps, and the far surface object with reparenting. See [Tools](tools.md#golden-hashes).
