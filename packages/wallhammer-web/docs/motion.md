# Motion

`wallhammer-web/motion` (layer 2, imports nothing but itself) moves skeletons on the CPU: poses as data, blending, a motion graph of states and layers, events at named points of a motion, and two post steps (a two-bone reach and ends kept on the ground). It holds **no motion of its own**: every pose comes from a function the game writes, a `MotionSource`. Nothing reads the clock or `Math.random`; the same calls give the same poses.

The pieces, in the order a frame uses them:

1. `Skeleton`: bones with a parent and a joint offset in the parent's frame. `Pose`: per bone a rotation (quaternion x, y, z, w) and an offset added to the joint. `boneMask` picks bones (with their descendants by default) for a layer or a blend.
2. `MotionSource`: `sample(out, t, input)` writes a pose at time or phase `t`; optional `duration`, `loop`, `marks`, `speed`, `unit`.
3. `MotionGraph`: per figure, a few hundred bytes of state over a shared `MotionGraphDef`. `setParam`, `trigger`, `update(dt)`, `evaluate(pose)`, `drainEvents(fn)`, `setState`, `save`/`restore`.
4. `solvePose(skeleton, pose, root, world)`: 3 × 4 world matrices, 12 floats per bone, column by column (the first 12 floats of an instance record).
5. Post steps on the solved pose: `reachTwoBone`, `fitToGround`.
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

`reachTwoBone(skeleton, pose, root, world, { upper, lower, end }, target, weight?, pole?)` turns two bones so that the `end` joint lies on `target` (as far as the chain reaches; it then points at it) and returns the distance left. `bend` names the axis a straight chain bends about; `pole` a point the middle joint turns toward. `fitToGround(…, chains, { heightAt, planeY, lower? })` moves every chain end by the ground height under it and reaches it, lowering the bone `lower` by the deepest drop. Both re-solve the bones below the chain, so `world` stays in step with `pose`.

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
