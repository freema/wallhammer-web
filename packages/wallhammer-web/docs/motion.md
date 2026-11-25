# Motion

`wallhammer-web/motion` (layer 2, imports nothing but itself) moves skeletons on the CPU: poses as data, blending, a motion graph of states and layers, events at named points of a motion, and post steps on the solved pose (a two-bone reach, ends kept on the ground, a chain aimed at a point, sockets that things are held at). It holds **no motion of its own**: every pose comes from a function the game writes, a `MotionSource`. Nothing reads the clock or `Math.random`; the same calls give the same poses.

The pieces, in the order a frame uses them:

1. `Skeleton`: bones with a parent and a joint offset in the parent's frame. `Pose`: per bone a rotation (quaternion x, y, z, w) and an offset added to the joint. `boneMask` picks bones (with their descendants by default) for a layer or a blend.
2. `MotionSource`: `sample(out, t, input)` writes a pose at time or phase `t`; optional `duration`, `loop`, `marks`, `speed`, `unit`.
3. `MotionGraph`: per figure, a few hundred bytes of state over a shared `MotionGraphDef`. `setParam`, `trigger`, `update(dt)`, `evaluate(pose)`, `drainEvents(fn)`, `setState`, `save`/`restore`.
4. `solvePose(skeleton, pose, root, world)`: 3 × 4 world matrices, 12 floats per bone, column by column (the first 12 floats of an instance record).
5. Post steps on the solved pose, in this order: `fitToGround`, then aims (`aimChain`, `ChainAim`), then reaches (`reachTwoBone`, `TwoBoneReach`), then sockets (`socketTransform`, `SocketBlend`). Each reads the bones the one before moved: an arm reaches from the trunk as the aim turned it, a held thing follows the hand as the reach put it.
6. Drawing: `BoneInstances` of `wallhammer-web/render` writes the matrices into instance records; or the game writes them anywhere else.

## Writing a source

A source is a pure function of `t` (and of the input object the game gives the graph). The example skeleton here is made up: a base, a link and a tip.

<!-- check: wrap -->
```ts
import { Pose, Skeleton, setBoneAxisAngle } from 'wallhammer-web/motion';
import type { MotionSource } from 'wallhammer-web/motion';

const chain = new Skeleton([
  { name: 'base', parent: -1, joint: [0, 0, 0] },
  { name: 'link', parent: 0, joint: [0, 0.6, 0] },
  { name: 'tip', parent: 1, joint: [0, 0.5, 0] },
]);
const LINK = chain.index('link');
const TIP = chain.index('tip');

/** Swings the link back and forth once a second; the tip follows half as far. `t` is seconds into the pass. */
const swing: MotionSource = {
  duration: 1,
  marks: [{ name: 'apex', at: 0.25 }],
  sample(out: Pose, t: number) {
    const a = 0.6 * Math.sin(2 * Math.PI * t);
    setBoneAxisAngle(out, LINK, 0, 0, 1, a);
    setBoneAxisAngle(out, TIP, 0, 0, 1, 0.5 * a);
  },
};

/** Holds still, bent a little. */
const rest: MotionSource = { sample: (out) => setBoneAxisAngle(out, LINK, 0, 0, 1, 0.2) };
```

`sample` gets a pose reset to the rest pose (identity rotations, zero offsets) and writes only the bones it moves. `unit: 'phase'` gives `t` as the share 0–1 of one pass instead of seconds. `speed: [min, ideal, max]` lets one state hold several sources weighted by a parameter (below). `loop: false` holds the end.

## A graph with two states and a layer

<!-- check: wrap -->
```ts
import { MotionGraph, Pose, Skeleton, boneMask, compileMotionGraph, setBoneAxisAngle, solvePose } from 'wallhammer-web/motion';
import type { MotionSource } from 'wallhammer-web/motion';
declare const chain: Skeleton;
declare const swing: MotionSource;
declare const rest: MotionSource;

const tilt: MotionSource = { sample: (out, t) => setBoneAxisAngle(out, 0, 1, 0, 0, 0.1 * Math.sin(t)) };

const def = compileMotionGraph({
  skeleton: chain,
  params: { moving: 0, tilt: 1 },
  layers: [
    {
      name: 'main',
      states: [
        { name: 'rest', source: rest },
        { name: 'swing', source: swing },
      ],
      transitions: [
        { from: 'rest', to: 'swing', seconds: 0.3, when: [{ param: 'moving', op: '>', value: 0.5 }] },
        { from: 'swing', to: 'rest', seconds: 0.45, ease: 'smooth', when: [{ param: 'moving', op: '<=', value: 0.5 }] },
      ],
    },
    // Added on top, only on the base and below, with a weight read from a parameter.
    { name: 'lean', mode: 'additive', mask: boneMask(chain, ['base']), weight: 'tilt', states: [{ name: 'tilt', source: tilt }] },
  ],
});

// One description, any number of figures.
const graph = new MotionGraph(def);
const pose = new Pose(chain);
const world = new Float32Array(chain.count * 12);
const root = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 4, 0, 2]); // the figure's place: a 3 × 4 matrix

function frame(dt: number, moving: boolean): void {
  graph.setParam('moving', moving ? 1 : 0);
  graph.update(dt);
  graph.evaluate(pose);
  solvePose(chain, pose, root, world);
}
```

What the graph does:

- **Layers** are evaluated in order. An `override` layer blends its pose over what is below by its weight (and mask); an `additive` layer adds its pose (a rotation in the bone's frame, an offset) scaled by its weight. A state with no source passes the layer below through (override) or adds nothing (additive).
- **Transitions** are checked in order every `update`: `from` a state or `'*'`, all `when` conditions true, the `trigger` set, or `after` passes of the current state. The new state fades in over `seconds` (`'linear'` or `'smooth'`); a transition taken while another still fades adds a third state at weight 0, so nothing jumps. At most `maxBlend` (4) states are active per layer; when a fifth is needed the one with the least weight is dropped.
- **Triggers** (`graph.trigger(name)`) last one `update`: a trigger no transition takes is gone afterwards.
- **Phase**: a state advances by `dt × rate / duration` (`rate` a number or a parameter's name). `drive: { param, per }` sets the phase from a parameter instead, `param / per` (a distance travelled and a stride: the phase never slides). `sync: 'group'` makes a state entered from another of the same group start at its phase.
- **Several sources in one state** with `by: 'param'`: every source names its `speed` range; the weights come from where the parameter lies between the ideal speeds (`speedWeights`), always summing to 1, and the phase advances by the weighted rates, so loops of different lengths stay in step.
- `save()` gives the state as bytes (`byteLength`), `restore(bytes)` continues the same run exactly; `reset()` starts over.
- `setState(state, layer?, time?)` puts a layer straight into one state, `time` seconds into it (no fade, no events): for a figure that starts or comes back into view in the middle of something, so many figures do not all begin their loops together.

## Events from marks

<!-- check: wrap -->
```ts
import type { MotionEventKind, MotionGraph } from 'wallhammer-web/motion';
declare const graph: MotionGraph;
declare function flash(): void;

let apexes = 0;
function onEvent(kind: MotionEventKind, name: string, state: string, layer: string): void {
  if (kind === 'mark' && name === 'apex' && state === 'swing' && layer === 'main') {
    apexes++;
    flash();
  }
}

function afterUpdate(): void {
  graph.drainEvents(onEvent); // marks, 'enter' and 'leave', in the order they happened
}
```

A mark is reported every time the phase of the newest state of a layer crosses it, in either direction, in order, however large `dt` is (a loop passed three times in one update gives its marks three times). A phase that lands exactly on a mark reports it once. Events wait until `drainEvents`; more than `maxEvents` (32) are counted in `droppedEvents`.

## Reaching and the ground

`reachTwoBone(skeleton, pose, root, world, { upper, lower, end }, target, weight?, pole?)` turns two bones so that the `end` joint lies on `target` (as far as the chain reaches; it then points at it) and returns the distance left. `bend` names the axis a straight chain bends about; `pole` a point the middle joint turns toward. `fitToGround(…, chains, { heightAt, planeY, lower? })` moves every chain end by the ground height under it and reaches it, lowering the bone `lower` by the deepest drop; `align` (0–1) also turns every end bone about its joint by the tilt of the ground under it (the normal from `heightAt` at `alignStep` on either side, at most `maxAlign` radians), so a sole lies on a slope. Both re-solve the bones below the chain, so `world` stays in step with `pose`.

## Reaching, aiming and holding over time

`reachTwoBone` and `aimChain` are single calls. Their stateful forms keep what a game sets every frame and ease their weight in and out; `WeightFade` is that weight on its own (`to(goal, seconds)` from the value it has now, smoothstep, `update(dt)`; asking again for the goal it is already moving to changes nothing).

- `TwoBoneReach(chain, { soft?, pole? })`: `setTarget(x, y, z)` every frame, `on(seconds)` / `off(seconds)`, `update(dt)`, then `apply(skeleton, pose, root, world)` (returns the distance left). A target farther than `soft` (default 0.92) of the chain's length is pulled in along the line from the upper joint, `d' = s + (L − s)(1 − e^(−(d − s)/(L − s)))` with `s = soft · L`, so the chain straightens toward its length without reaching it and nothing pops as the target crosses it. `usePole` with `pole` turns the middle joint toward a point; `useEndRotation` with `endRotation` (a quaternion in the solved frame) also turns the end bone, by the same weight.
- `aimChain(skeleton, pose, root, world, { bones, shares, forward?, eye?, maxYaw, maxUp, maxDown }, target, weight?)` turns a short chain (the trunk and the head, say) so that the last bone's `forward` axis points at `target`: a yaw about the root's up and a pitch about the side across the facing, shared out by `shares`. The angles are measured in the root's frame, held within the limits, and a target behind fades the turn back to none on its way round (smoothly from `maxYaw` to straight behind), so a point passing behind never flips the chain from one side to the other. It returns the angle left to the limited goal (at weight 0 the whole angle, nothing turned). `aimAngles(…)` measures without turning. `ChainAim` keeps a target and an eased weight as `TwoBoneReach` does; its `left` is the same angle, also while the weight is 0.
- `socketTransform(world, { bone, local }, out)` is a point on a bone with its own turn: the bone's matrix times `local`, 12 numbers, ready for `BoneInstances` or anything else drawn there. `SocketBlend` moves a held thing between two sockets of one figure or of two over set seconds (`to(1, seconds)`, `update(dt)`, `write(worldA, a, worldB, b, out)`): positions in a line, rotations along the shortest arc, and a mirrored transform (determinant below 0) stays mirrored (`blendTransform`; ends of different handedness take the first's below 0.5 and the second's from 0.5, where the first axis turns over in one step). Read sockets last.

<!-- check: wrap -->
```ts
import { ChainAim, SocketBlend, TwoBoneReach, fitToGround, solvePose } from 'wallhammer-web/motion';
import type { AimChain, GroundFitOptions, MotionGraph, Pose, Skeleton, Socket, TwoBoneChain } from 'wallhammer-web/motion';
declare const skeleton: Skeleton;
declare const graph: MotionGraph;
declare const pose: Pose;
declare const root: Float64Array; // the figure's place, 3 × 4
declare const legs: TwoBoneChain[];
declare const fit: GroundFitOptions;
declare const arm: TwoBoneChain;
declare const gaze: AimChain;
declare const hand: Socket;
declare const otherHand: Socket;
declare const otherWorld: Float64Array; // another figure's solved bones
declare const box: Float64Array; // 12 numbers: where the held thing is drawn

const world = new Float64Array(skeleton.count * 12);
const reach = new TwoBoneReach(arm, { soft: 0.94 });
const look = new ChainAim(gaze);
const pass = new SocketBlend();

/** Starts handing the thing over: the arm comes out in 0.8 s, the thing goes from hand to hand in 0.25 s. */
function give(): void {
  reach.on(0.8);
  look.on(0.5);
  pass.to(1, 0.25);
}

function frame(dt: number, meet: readonly number[], eyes: readonly number[]): void {
  graph.update(dt);
  graph.evaluate(pose);
  solvePose(skeleton, pose, root, world);
  fitToGround(skeleton, pose, root, world, legs, fit);
  for (const step of [reach, look, pass]) step.update(dt);
  look.setTarget(eyes[0]!, eyes[1]!, eyes[2]!);
  look.apply(skeleton, pose, root, world);
  reach.setTarget(meet[0]!, meet[1]!, meet[2]!);
  reach.apply(skeleton, pose, root, world);
  pass.write(world, hand, otherWorld, otherHand, box);
}
```

## A chain that lags behind

`ChainLag(skeleton, { bones, end, stiffness, damping, gravity, maxAngle }, options?)` is secondary motion: a short chain of bones (a ponytail, a strap, a tail, an antenna) that is left behind when what it hangs on starts, stops, turns or jumps, swings and settles back onto its posed shape. `bones` run outward from the one hung on the rest of the skeleton, each the child of the one before; `end` is the free end of the last bone in its own frame. A point at the end of every bone keeps its own velocity; a spring (`stiffness`, 1/s², about the square of the swing's angular frequency) pulls it toward where the posed bone points, damping (`damping`, 1/s) takes away its speed against the joint's, `gravity` (0–1) is the share of gravity along the root's −y, and no bone leaves its posed direction by more than `maxAngle` radians. The step is fixed (`stepHz`, default 60) as the walker's: a frame's seconds are cut into steps and the rest carried, so the swing does not depend on the frame rate and the same inputs give the same bits. A frame of more than `maxSteps` (default 8) steps puts the chain on the posed shape, moving with its joint, and runs only the last steps; a frame shorter than a step runs none and draws the chain carried along with its joint (each link's direction as at the last step, held within `maxAngle` of the pose now), and the next step takes up all of the joint's motion since the last one; a joint moving faster than `resetSpeedMs` (default 30 m/s, a teleport) puts it on the posed shape at rest, as `reset()` does.

`apply(dt, skeleton, pose, root, world, motion?)` runs last among the post steps, after the ground fit, the aims and the reaches (it hangs on what they moved): it turns the chain's bones in `pose` and re-solves them in `world`, and returns the largest angle from the posed shape (per bone in `angles`). The chain's velocity is kept in the frame of `motion`, the same root in a frame that does not move with the figure; it defaults to `root`, right on a flat world. Where the frame the pose is solved in jumps (a new chart on a sphere), pass the root in the world as `motion` (the chart's `frameAt` at the feet times the root's columns, its translation the frame's): the swing is then the same as in one steady frame. Nothing allocates per frame.

<!-- check: wrap -->
```ts
import { ChainLag, fitToGround, solvePose } from 'wallhammer-web/motion';
import type { GroundFitOptions, Pose, Skeleton, TwoBoneChain } from 'wallhammer-web/motion';
declare const skeleton: Skeleton;
declare const pose: Pose;
declare const root: Float64Array; // the figure's place, 3 × 4
declare const legs: TwoBoneChain[];
declare const fit: GroundFitOptions;
declare const tail: readonly number[]; // three bones, each the child of the one before

const world = new Float64Array(skeleton.count * 12);
const lag = new ChainLag(skeleton, { bones: tail, end: [0, -0.14, 0], stiffness: 90, damping: 7, gravity: 0.25, maxAngle: 1 });

function frame(dt: number): void {
  solvePose(skeleton, pose, root, world);
  fitToGround(skeleton, pose, root, world, legs, fit);
  lag.apply(dt, skeleton, pose, root, world); // last: it hangs on the posed head
}
```

## An upper body over a gait

Nothing more than a mask and a layer is needed for an act of the arms over walking, running or standing: an `override` layer with `mask: boneMask(skeleton, ['armR'])` (or both arms) above the gait's layer, a state with no source (`'off'`, it passes the gait through) and a state per act, entered on a parameter or a trigger from `'*'`, left on the parameter or after a few passes (`after`). The legs, the trunk and the other arm keep the gait; the masked bones fade in and out of the act over the transition's seconds. A reach on the same arm then moves the hand from wherever the act left it, by its own weight.

<!-- check: wrap -->
```ts
import { boneMask } from 'wallhammer-web/motion';
import type { MotionLayerDesc, MotionSource, Skeleton } from 'wallhammer-web/motion';
declare const skeleton: Skeleton;
declare const wave: MotionSource; // a pass of the raised arm, `duration` set

const waving: MotionLayerDesc = {
  name: 'wave',
  mask: boneMask(skeleton, ['armR']),
  states: [{ name: 'off' }, { name: 'wave', source: wave }],
  transitions: [
    { from: '*', to: 'wave', seconds: 0.25, trigger: 'wave' },
    { from: 'wave', to: 'off', seconds: 0.4, after: 4 }, // four passes, then back to the gait
  ],
};
```

## Curved worlds

On a sphere (`radialUp`) a figure is solved in a chart of the surface, where +y is up and the ground is a height field, and only the result is stood on the sphere. `SurfaceChart` (in `wallhammer-web/base`) gives the chart point of a world point, and `frameAt` the frame that stands the chart's flat space on the sphere at that point; within a few hundred metres of the chart's anchor the error is far under a millimetre. The motion steps run unchanged in the chart: the root is the chart heading, `fitToGround` reads the chart's heights, aims measure up as the root's up. A chart walker (`ChartWalker` of `wallhammer-web/world`) keeps such a chart under the walker and moves to a new one as it goes.

<!-- check: wrap -->
```ts
import type { SurfaceChart } from 'wallhammer-web/base';
import { fitToGround, solvePose } from 'wallhammer-web/motion';
import type { GroundFitOptions, Pose, Skeleton, TwoBoneChain } from 'wallhammer-web/motion';
declare const chart: SurfaceChart;
declare const skeleton: Skeleton;
declare const pose: Pose;
declare const legs: TwoBoneChain[];
declare function chartGround(x: number, z: number): number; // the ground's height in the chart

const chartBones = new Float64Array(skeleton.count * 12);
const drawn = new Float64Array(skeleton.count * 12);
const frame = new Float64Array(12);

/** Poses the figure with its feet at chart point `p`, facing chart heading `yaw`, and stands it on the sphere. */
function place(p: readonly [number, number, number], yaw: number, origin: readonly [number, number, number]): Float64Array {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const root = [c, 0, -s, 0, 1, 0, s, 0, c, p[0], p[1], p[2]];
  solvePose(skeleton, pose, root, chartBones);
  const fit: GroundFitOptions = { heightAt: chartGround, planeY: p[1] };
  fitToGround(skeleton, pose, root, chartBones, legs, fit);
  chart.frameAt(p[0], p[1], p[2], frame, origin);
  // Each bone: the frame times the bone less the feet (the frame already holds the feet's place on the sphere).
  for (let b = 0; b < skeleton.count; b++) {
    for (let col = 0; col < 4; col++) {
      const o = b * 12 + col * 3;
      const x = chartBones[o]! - (col === 3 ? p[0] : 0), y = chartBones[o + 1]! - (col === 3 ? p[1] : 0), z = chartBones[o + 2]! - (col === 3 ? p[2] : 0);
      for (let i = 0; i < 3; i++) drawn[o + i] = frame[i]! * x + frame[3 + i]! * y + frame[6 + i]! * z + (col === 3 ? frame[9 + i]! : 0);
    }
  }
  return drawn;
}
```

The planet example's walk mode (`examples/planet/src/walk-scene.ts`) does this for two figures, a box passed between their hands and a book.

## Writing to instances

A figure drawn as rigid parts keeps one record per part in an instance set. `BoneInstances` (in `wallhammer-web/render`) holds the table bone → set, record and an optional fixed matrix of the part in the bone's frame, and writes world · part into the first 12 floats of every record without allocating.

<!-- check: wrap -->
```ts
import type { MeshData } from 'wallhammer-web/base';
import { BoneInstances, instanceSet } from 'wallhammer-web/render';
declare const rod: MeshData;
declare const world: Float32Array; // from solvePose

// The set goes into an `InstanceSetLayer` as any other (Instance sets in the rendering guide).
const set = instanceSet(rod, 3, { name: 'parts' });
set.count = 3;
const parts = new BoneInstances([
  { bone: 0, set, record: 0 },
  { bone: 1, set, record: 1, local: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.25, 0] }, // the part's middle, a quarter metre up the bone
  { bone: 2, set, record: 2 },
]);

function draw(): void {
  parts.write(world); // marks the set dirty
}
```

`write(world, first)` reads bone `first + bone`, so one array may hold the bones of many figures. `hide()` collapses every part.

Rigs posed in the vertex shader ([Rigs](rigs.md)) are a different path: no skeleton on the CPU, closed-form gait from the instance record. Motion is for figures the game poses itself.

`pnpm check:motion` (`tools/motion/check.ts`) runs the module on made-up bone chains without a browser ([Tools](tools.md)).
