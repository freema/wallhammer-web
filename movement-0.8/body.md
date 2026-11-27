Before version 0.8.0 a figure in [Wallhammer Web](https://github.com/freema/wallhammer-web) could walk on a flat test course. It started and stopped in one frame, turned on the spot at any speed, and could not stand on the planet the engine draws.

Now the same figure walks on that planet, hands a box to a second figure, rides a four-legged runner at a gallop, drives a car over a ramp and flies a huge ray that pants after it lands. This is an account of what was added in versions 0.8.0 and 0.8.2, and of the reason behind each piece.

Wallhammer Web is a 3D engine for the browser where everything is written in code: plain WebGL2, no graphics library, no model files, no textures. Every animal and car in the pictures is a function.

## Why movement, and why now

The engine could already make a world: a planet you can fly down to, rivers, a village, an endless streamed land. What it could not do was let you be in that world as something with weight. A camera that flies is a viewer. A body that needs four metres to stop is a game.

So the goal of these two versions was one sentence: **every way of moving that a small open world needs, as engine parts a game configures, never as code of one example.** The examples only prove the parts work.

Three rules held through all of it:

- **Fixed steps, same bits.** Every body advances in fixed steps. Cut the same seconds into frames of 30, 60 or 144 Hz and the body ends in the same place with the same bits. Every body saves and loads its state.
- **Every number is a setup field.** The engine ships a reference set and the game replaces it. No constant of one car hides in the step.
- **A check for every behaviour.** Stop distances, turning circles, sink rates and footfalls are measured by scenarios that run headless. There are 151 of them for walking, riding, driving and flying, and 64 for motion.

## 0.8.0: a walker with momentum, on a sphere

### Momentum

The walker got three numbers: braking on the ground, a slower run-up, and a turn rate that falls with speed. A runner now stops in `v² / (2 · deceleration)` metres and turns in an arc instead of on a coin. All three default to zero, so every existing game steps bit for bit as before. That is a pattern for the whole release: new behaviour is off until asked for.

On top of that sit movement profiles in the examples (`default`, `heavy`, `light`), a gait that leans into the run-up and back against braking, and `ChainLag`, a small spring chain for things that trail behind a body. The figure's ponytail is three bones of it.

### Walking on a sphere without a sphere walker

The planet is a sphere of 100 km radius. Writing a second walker for curved ground would mean two walkers to keep equal for ever. Instead the flat walker and the flat collision world run unchanged inside a **chart**: a flat map of the ground round an anchor (the exponential map). Within a few hundred metres the error is far under a millimetre. When the body walks away, the chart moves under it at a step boundary, and the camera is carried across so the picture does not move.

![Two figures on the planet's ground: one hands a box to the other, trees and rocks behind them, the sea below](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/o4dlwpzqv7w2miesv2zu.png)

The trees and rocks in that picture are instances of streamed cells, drawn by the thousand. They now also stop the walker and the camera's boom: each archetype says in plain data where its solid footprint is, and an index answers "what is solid within this radius" without allocating.

### Hands that reach

The handover above needs more than a played clip, because the two figures never stand in the same place twice. `TwoBoneReach` moves a hand to a target set every frame, with a soft pull so nothing pops when the target is out of reach. `ChainAim` turns a head and chest toward a point. Sockets carry a held thing from one hand to another over set seconds. The order in a frame is fixed: the ground fit, aims, reaches, sockets.

## 0.8.2: four legs, four wheels, two wings

### Steps of several legs

A four-legged animal cannot use a walk cycle made for two legs, and three hand-made clips (walk, trot, gallop) slide their feet whenever the speed sits between them. `StepCycle` takes the gaits as data instead: per leg an offset in the cycle, how long it stays down, how high it lifts, and a stride.

```ts
const patterns: StepPattern[] = [
  { speed: 0.8, stride: 0.9, offsets: [0, 0.5, 0.75, 0.25], duty: 0.75, lift: 0.08 }, // one leg at a time
  { speed: 2.5, stride: 1.6, offsets: [0, 0.5, 0.5, 0], duty: 0.5, lift: 0.12 }, // diagonal pairs
  { speed: 6, stride: 2.8, offsets: [0, 0.1, 0.55, 0.65], duty: 0.35, lift: 0.16 }, // a bound with a flight
];
const steps = new StepCycle({ homes, patterns, reach: 0.5 });
```

The cycle is driven by the distance travelled, not by time. A planted foot does not move until it lifts. A swing lands where the ground will be. The patterns blend by speed with their offsets on a circle, so a walk becomes a trot without a jump. The check of the ray's crawl measures the drift of its planted paws: 0.00 mm a step.

![The runner at a gallop with its rider, all four legs stretched in the flight phase, its shadow on the ground](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/sk8fxx90r7br2toc9k56.png)

### A body carried by another

The rider is not a second animation glued on. `SocketSeat` gives the root of one body from a socket on another, with a weight from 0 (where the game put it) to 1 (in the seat), and a share of the mount's tilt. Hands and feet are held at sockets on the reins and the rug with the same reach as the handover.

### A wheeled body

`WheeledBody` is one rigid body on wheel rays: springs and dampers, tyres with a slip curve and a friction circle, a handbrake that lets the rear slide, steering that eases with speed, and a hull of spheres that does not pass through thin walls.

```ts
const body = new WheeledBody(world, {
  mass: 1100,
  wheels: fourWheels({ drive: 'all', frontGrip: 0.95 }),
});
const intent = newWheeledIntent();

intent.throttle = 1;
intent.steer = 0.3;
body.advance(dt, intent); // the fixed steps due; the rest of dt waits for the next frame
body.renderMatrix(pose); // between the last two steps
```

![A red car in the air after a ramp, its shadow under it](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/8a0lhsixe1bnqwgdih81.png)

A raycast car is easy to get driving and hard to get right at rest, so most of its scenarios are about the dull cases: parked on a slope of 15° it settles within a centimetre and stays; it sleeps and wakes; a walker is blocked by it.

### A flying body, and the assist that makes it playable

`FlyingBody` crawls on the ground, leaps, and in the air is a glider with one lift coefficient: lift and drag from a trim speed and a glide ratio, banked turns with a load limit, a stall, beats that push, a flare.

It flew correctly and nobody could fly it. Holding height meant pumping two keys, and every slow turn ended in a stall. The first idea was to soften the physics. I kept the physics and added `FlightAssist` instead: the player asks for a speed, a climb and a turn, and the assist writes the body's raw controls before every step **by inverting the body's own model**. Hands off, it holds speed and height. It reaches a new speed in about two seconds, turns level, never stalls and lands from a slow descent. With `assist=0` the raw controls are still there.

![The flying ray in a steep banked turn seen from behind, its rider small on its back](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/ir6bqwdi6h98yi2hgisa.png)

### One mechanism for getting on

The horse and the car first had their own code for getting on and off. They are now two configurations of one `SeatTransition`: an approach, a seat weight and a rise eased per phase, with cues at times (the door opens, the hand takes the rein). The engine also answers where a body may stand when it gets off, so nobody dismounts into a wall.

### Traces on the ground

A world that takes no mark from you feels like a backdrop. `ContactTrail` keeps marks in a ring of fixed size and draws them in one instanced draw; only the changed span is uploaded each frame. Boot prints, hoof prints, ruts and skid marks share it. Particle bursts are fired once from a seed and simulated in the vertex shader, and the ground carries a surface tag so a wheel knows it is on loose dirt.

![A red car sliding on loose ground with the handbrake on, dust behind it and skid marks on the dirt](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/bkiqsud2io0yvzgu20os.png)

## The animals are code too

The runner and the ray have no model file. Each is a function that builds a skinned mesh from numbers, and that makes small life cheap to add: a jaw, a tongue, eyelids and a few named random streams give panting after a gallop, a yawn, a lick and a blink. The streams are seeded, so the same seed yawns at the same moment on every machine.

![The runner at a gallop on the loose patch, dust puffs and hoof prints behind it](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/aqpmwfjjzpch6cdxu9lr.png)

## What is still weak

- **A body on a car has no weight.** The walker is a capsule without mass, so the car does not sink when somebody gets in, and nobody can stand on its roof. That is the next piece of work: a force at a point and a payload for the wheeled body, then a car that meets a walker, then moving ground for the walker.
- **The ray's wing on the ground is a flat plank.** It should fold like a fan, and that needs a third joint in the arm.
- **The rider sits still.** At a gallop the body should move with the mount.
- **There is no adaptive resolution.** A frame of the village costs 3.4 ms on an M4 Pro at 1600×900, but the dust of the destruction example costs 2.9 ms for about two thousand triangles, all of it overdraw. Quality tiers and cheaper dust are on the list.
- **There is no 0.8.1.** Its release failed in CI on two faults that never show locally: a time limit of 5 s that the walking scenarios missed by 0.2 s on the slower CI machine, and a file permission in a job that ran in CI for the first time. Nothing reached npm, the fixes went in, and the changes shipped as 0.8.2.

## Try it

- **Live:** [the movement course](https://freema.github.io/wallhammer-web/movement/). `E` gets on and off the runner, the cars and the ray. On the [planet](https://freema.github.io/wallhammer-web/planet/), `G` drops you to the ground.
- **The engine:** [Wallhammer Web on GitHub](https://github.com/freema/wallhammer-web), `npm install wallhammer-web`, MIT licensed. About 67 thousand lines of TypeScript, 1.3 MB as an npm package, and one runtime dependency (`earcut`, for triangulation).
- **The full list:** the [changelog](https://github.com/freema/wallhammer-web/blob/main/CHANGELOG.md) names every new export of both versions.

If you have written a raycast car or a quadruped gait and know where mine will break, I would like to hear it.
