# Rigs and actors

A rig is an instanced, animated model made of rigid parts. The vertex shader poses every part from the instance record (position, heading, distance travelled, speed, turn rate, seed, state) with closed-form functions: legs swing in a gait, wheels roll and steer, bodies roll in curves and bob, people look around while they stand. Nothing is stored between frames, so a jump in time poses correctly at once, and thousands of instances cost one draw per kind and level of detail.

- The description is plain data in `base` (`RigDesc`, `RigPart`, `RIG_INSTANCE_FLOATS`, `writeRigInstance`).
- `gen-mesh` builds the part meshes; `render` draws them in `RigLayer`.
- Concrete rigs (people, vehicles, stop furniture) are content of the app, best kept in one folder of its own; the walking example has its rig in `examples/walk/src/`.

## The description

Local axes of every rig: x to the right of travel, y up, z forward, the origin on the ground under the anchor. A part has a shape (`box`, `frustum`, `roller`, `rod`), a place (`at`), an optional pivot and a motion:

| Motion | Meaning |
| --- | --- |
| `fixed` | Moves with the body (bob, roll, sway). |
| `spin`, `spin-steer` | Turns about x by distance / `amount` (a wheel of that radius); `spin-steer` also steers by the curvature (`steerBase`). |
| `limb` | A leg of length `amount`, swinging in the gait; the foot stays put during the stance half. `phase` 0 or 0.5 picks the side; with the free gait any phase. |
| `swing` | Swings in the gait by up to `amount` radians (arms, a bag). |
| `look` | Turns about y while standing, slowly. |
| `wobble` | Small noise about x and y. |
| `bend` | A link of a chain: turns about the chain's root, about its `axis`, more the farther it is from the root. See [Free gait and chains](#free-gait-and-chains). |

Colour comes from one of four instance colour slots times `tint`, or from `tint` alone. `finish` makes a part glass, a front or rear lamp (lit by `RigLayer.lamps`), a lit interior (`glow`) or a paved top (`tiles`, a world-aligned 0.5 m grid). `variant` shows a part only when the instance sets that bit (a backpack). `nearOnly` drops it from the far level of detail. A rig has one or two segments; the second (an articulated vehicle's trailer) gets its own anchor and heading in the record.

## Free gait and chains

Two optional parts of a description serve bodies on more than two limbs and long bodies. A description without them is drawn by the same program, with the same mesh bytes, as before they existed; one with them (`rigExtended(desc)` is true) is drawn by a second program that `RigLayer` makes when the first such kind is added.

- **Free gait** (`gait: 'free'`): every `limb` plants its own end point, for any `phase` and any `amount`. The end point is the point `amount` under the pivot at rest. With `f = fract(distance / (stride · scale) + seed + phase)` it lies on the ground and moves backward at exactly the speed of travel for `f < 0.5`, and comes forward on a smooth step, lifted by at most 0.22 · `amount`, for the rest of the cycle. The limb is aimed at its end point and stretched along its own length, so a pivot between 0.8 and 1.2 times `amount` above the ground still keeps the end point down; put the pivot at `amount` for a limb that is never stretched at rest. The body dips by `dip` twice per cycle and keeps the sway. The gait fades in between the two speeds of `walkSpeed` (times the height scale), so a slow or small rig walks without sliding. Standing and at the far level of detail every limb is at rest.
- **Chains** (`motion: 'bend'`): the links of one chain share their `pivot`, the root of the chain. Every vertex of a link turns about the root, about the link's `axis` (default `y`), by `amount · d · wave` radians, `d` its rest distance from the root in metres and `wave` a sine of the gait phase lagged by `phase` cycles per metre along the chain (a slow sway of 0.4 of it while standing). The turn is zero at the root and continuous along the chain, so the chain never leaves the body and its links stay joined; give the links of one chain the same `amount`, `phase` and `axis`.

Content rules: keep `stride ≤ 3.6 · amount` for every limb (the pair gait clamps the swing there), and with the free gait a stride near 2 · `amount` and a small `dip` keep the stretch of a limb low.

<!-- check: wrap -->
```ts
import { rigExtended } from 'wallhammer-web/base';
import type { RigDesc, RigPart } from 'wallhammer-web/base';

/** A body on four limbs of two lengths, with a chain of three links at the front that bends sideways. */
const limb = (x: number, z: number, length: number, phase: number): RigPart => ({
  shape: { kind: 'box', size: [0.1, length, 0.1] },
  at: [x, length / 2, z],
  pivot: [x, length, z],
  motion: 'limb',
  amount: length,
  phase,
  slot: 1,
});
const chain = (i: number): RigPart => ({
  shape: { kind: 'box', size: [0.2, 0.2, 0.3] },
  at: [0, 0.9, 0.7 + 0.3 * i],
  pivot: [0, 0.9, 0.55],
  motion: 'bend',
  axis: 'y',
  amount: 0.3,
  phase: 0.2,
  slot: 0,
});
const body: RigDesc = {
  name: 'four limbs',
  parts: [
    { shape: { kind: 'box', size: [0.5, 0.4, 1.2] }, at: [0, 0.95, 0], slot: 0 },
    limb(-0.2, 0.45, 0.8, 0),
    limb(0.2, 0.45, 0.8, 0.5),
    limb(-0.2, -0.45, 0.75, 0.25),
    limb(0.2, -0.45, 0.75, 0.75),
    chain(0),
    chain(1),
    chain(2),
  ],
  segments: [{ shadow: [0.4, 0.8, 0] }],
  stride: 1.6,
  gait: 'free',
  dip: 0.03,
  walkSpeed: [0.1, 0.6],
  height: 1.2,
  radius: 1.4,
};
console.log(rigExtended(body));
```

## Drawing instances

<!-- check: wrap -->
```ts
import { RIG_INSTANCE_FLOATS, packRgb, writeRigInstance } from 'wallhammer-web/base';
import type { RigDesc, RigInstance } from 'wallhammer-web/base';
import { RigLayer } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';
import { POSE_STRIDE } from 'wallhammer-web/sim';
import type { Movers } from 'wallhammer-web/sim';
declare const renderer: Renderer;
declare const people: Movers;
declare const groundAt: (x: number, z: number) => number;

/** A minimal walker: a body on two legs that swing in the gait, coloured from instance slots 0 and 1. */
const walker: RigDesc = {
  name: 'walker',
  parts: [
    { shape: { kind: 'frustum', r0: 0.18, r1: 0.14, height: 0.75, sides: 8 }, at: [0, 0.85, 0], slot: 0, tint: [1, 1, 1] },
    { shape: { kind: 'box', size: [0.12, 0.85, 0.14] }, at: [-0.1, 0.42, 0], pivot: [-0.1, 0.85, 0], motion: 'limb', amount: 0.85, phase: 0, slot: 1, tint: [1, 1, 1] },
    { shape: { kind: 'box', size: [0.12, 0.85, 0.14] }, at: [0.1, 0.42, 0], pivot: [0.1, 0.85, 0], motion: 'limb', amount: 0.85, phase: 0.5, slot: 1, tint: [1, 1, 1] },
  ],
  segments: [{ shadow: [0.3, 0.3, 0] }],
  height: 1.6,
  radius: 0.5,
};

const rigs = new RigLayer(renderer);
renderer.add(rigs);
const FIGURES = 2000;
const kind = rigs.addKind(walker, FIGURES);
const pose = new Float32Array(FIGURES * POSE_STRIDE);
// One look per person, keyed by the `tag` given at spawn (rows move around; tags do not).
const looks = Array.from({ length: FIGURES }, (_, i) => ({
  heightScale: 0.9 + 0.2 * ((i * 7) % 10) / 10,
  widthScale: 1,
  variants: 0,
  colors: [packRgb(0.3, 0.35, 0.5), packRgb(0.2, 0.2, 0.25), 0, 0] as const,
}));
const r: RigInstance = { x: 0, y: 0, z: 0, slope: 0, dirX: 0, dirZ: 1, x1: 0, y1: 0, z1: 0, slope1: 0, dirX1: 0, dirZ1: 1, distance: 0, speed: 0, turnRate: 0, seed: 0, state: 0, heightScale: 1, widthScale: 1, variants: 0, colors: [0, 0, 0, 0] };

/** Every frame: poses from the simulation into instance records. */
function frame(alpha: number, lamps: number): void {
  const n = people.extractPose(alpha, pose);
  const out = rigs.staging(kind);
  for (let i = 0; i < n; i++) {
    const o = i * POSE_STRIDE;
    const look = looks[people.table.col.tag[i]! % FIGURES]!;
    r.x = r.x1 = pose[o]!;
    r.z = r.z1 = pose[o + 1]!;
    r.y = r.y1 = groundAt(r.x, r.z);
    r.dirX = r.dirX1 = pose[o + 2]!;
    r.dirZ = r.dirZ1 = pose[o + 3]!;
    r.distance = pose[o + 4]!;
    r.speed = pose[o + 5]!;
    r.turnRate = pose[o + 6]!;
    r.state = r.speed > 0.05 ? 0 : 1;
    r.heightScale = look.heightScale;
    r.widthScale = look.widthScale;
    r.variants = look.variants;
    r.colors = look.colors;
    writeRigInstance(out, i, r);
  }
  rigs.commit(kind, n);
  rigs.lamps = lamps;
}
```

`RIG_INSTANCE_FLOATS` (24) floats per record; `staging` + `commit` fill in place, `set(kind, data, count)` copies. The layer culls each kind against the view every frame and splits it into near (all parts, animated), far (fewer parts, still) and hidden by the size on screen (`farPx`, `hidePx`). Rigs receive shadows and stand on a soft contact shadow; by default they do not cast into the shadow map (see below).

A rig that never moves (stop furniture, a parked vehicle) is written once with state 2 and committed once; the layer still culls it every frame.

The field `state` (float 16, `i_look.x` in GLSL) is **not read by any shader of the engine**: a standing rig stands because its speed is 0, not because of its state. It is kept in the record for the owner and for a game material that wants it.

## A material of the game, shadows into the map

The posing is a vertex include of its own, `RIG_POSE_GLSL`, which `RigLayer` registers as `<rig-pose>`. It declares the attributes and the instance record (`RIG_ATTRIBS`), the uniforms the layer sets (`u_rig`, `u_rig2`, and `u_rig3` where `WH_RIG_EXT` is defined) and two functions: `bool rigPose(out vec3 pos, out vec3 nrm)`, the world position and normal of the vertex in its instance's pose (false: the instance lacks the part's variant, collapse the vertex), and `vec3 rigColor()`, the part's colour times its instance colour slot. Write it after `<header>` and `<noise>`.

`new RigLayer(renderer, options)` takes `RigLayerOptions`:

- `material`: the game's `MaterialDesc` for the bodies (attributes `RIG_ATTRIBS`), with its own look in the fragment shader. Kinds with a free gait or chains get the same description with `WH_RIG_EXT` defined after the header line. Without it the engine's material draws exactly as before.
- `castShadow` (default false): the posed bodies are drawn into the shadow map, every instance at near detail, as a dynamic caster (`shadowCasters: 'dynamic'`, `shadowDirty()` true after `set` or `commit`). The depth program is the `shadow` pass of the game's material when it has one, otherwise the engine's (`rigPose` and `u_lightRender`).
- `contactShadows` (default true): the soft shadow under every rig.

<!-- check: wrap -->
```ts
import type { MaterialDesc } from 'wallhammer-web/base';
import { RIG_ATTRIBS } from 'wallhammer-web/base';
import { RigLayer } from 'wallhammer-web/render';
import type { Renderer } from 'wallhammer-web/render';
declare const renderer: Renderer;

const flat: MaterialDesc = {
  name: 'flat-rig',
  attribs: RIG_ATTRIBS,
  passes: {
    color: {
      vs: `#include <header>
#include <noise>
#include <rig-pose>
out vec3 v_color;
void main() {
  vec3 pos, nrm;
  if (!rigPose(pos, nrm)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v_color = rigColor() * (0.6 + 0.4 * max(nrm.y, 0.0));
  gl_Position = u_viewProj * vec4(pos, 1.0);
}`,
      fs: `#include <header>
in vec3 v_color;
out vec4 o_color;
void main() { o_color = vec4(v_color, 1.0); }`,
    },
  },
  state: { color: { depthTest: true, depthWrite: true, cullBack: true, blend: null, polygonOffset: null } },
};
const rigs = new RigLayer(renderer, { material: flat, castShadow: true });
renderer.add(rigs);
```

Vehicles with a trailing segment: the anchors sit on the rear axle of the leading segment and on the trailing segment's own axle. To place one, sample its path at the anchor and at the trailing distance behind it, and turn the trailing heading toward the joint.

See [Recipes](recipes.md#add-an-animated-rig) for adding a rig of your own.
