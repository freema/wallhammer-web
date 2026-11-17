# Cameras and views

The renderer reads only the `View` contract from `wallhammer-web/base`. A rig in `wallhammer-web/camera` produces a view. Input binding is in `wallhammer-web/platform`.

## The `View` contract

| Member | Meaning |
| --- | --- |
| `width`, `height`, `dpr` | Drawing surface in physical pixels; physical pixels per CSS pixel. |
| `heading` | Rotation around the vertical axis in radians. 0 looks toward −z. |
| `metresPerPixel` | World size of one screen pixel at the view centre. |
| `pixelGrowth`, `refDepth` | How pixel size grows with depth. Both 0 for an orthographic view. Shaders use them through `metresPerPixelAt` and `detailVisibleAt` in `<noise>`. |
| `axes()` | Unit screen right, screen up and view direction. |
| `viewProj(center, halfRange)` | World to clip matrix. |
| `cornerRays()` | Rays through the four image corners. The shadow map is fitted with them. |
| `cullVolume()` | A box (orthographic) or a frustum (perspective). `InstancedLayer`, `PieceLayer` and `InstanceCellLayer` cull against both (`boxInVolume` in `base`). |
| `key()` | Changes whenever the image of a static scene would change. Part of the shadow key. |

A custom rig only has to implement this, plus `width`, `height` and `dpr` being writable if you use `createEngine` (`EngineView = View & CanvasSizeTarget`).

## `SteppedOrthoRig`

An orthographic view with four rotations in 90° steps and a table of fixed zoom levels. It holds no numbers of its own; you pass them.

<!-- check: wrap -->
```ts
import { SteppedOrthoRig } from 'wallhammer-web/camera';

const view = new SteppedOrthoRig({ yawDeg: 22.5, pitchDegByZoom: [30, 35, 40], pxPerMeterByZoom: [1, 2, 4] });
view.bounds = { minX: 0, maxX: 800, minZ: 0, maxZ: 600 }; // the default is 0..1, which clamps the centre
view.centerX = 400;
view.centerZ = 300;
view.setZoom(view.fitZoom(800, 600, 40));
view.setRotation(1); // 90°
const ray = view.screenRay(100, 100); // for picking
```

Fields: `rotation` (0–3), `zoom`, `centerX`, `centerZ`, `refHeight` (the reference plane), `bounds`. Methods: `panPixels`, `setZoom`, `setRotation`, `state`, `fitZoom`, `screenRay`, `project`.

Weak spot: `bounds` defaults to a 1 × 1 m rectangle. If you forget to set it, the centre is clamped and panning seems broken.

`bindCameraInput(canvas, view, { onChange })` binds drag pan, wheel and `+`/`−` zoom, `Q`/`E` rotation, arrow keys and `0` (home, through `onHome`). It returns an unbind function.

## `PerspectiveOrbitRig`

A perspective view that orbits a target.

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig } from 'wallhammer-web/camera';

const view = new PerspectiveOrbitRig({ fovYDeg: 40, minDistance: 25, maxDistance: 260 }, { yawDeg: 35, pitchDeg: 24, distance: 105 });
view.target = [64, 6, 64];
view.setState({ yawDeg: 200 });
const eye = view.eye();
view.orbitPixels(40, 0); // as a drag would
view.zoomBy(1.15);
```

Setup (`OrbitSetup`, defaults in `DEFAULT_ORBIT`): `fovYDeg` 45, `minPitchDeg` 5, `maxPitchDeg` 85, `minDistance` 2, `maxDistance` 500, `turnPerPx` 0.006. Public state options are in degrees; the fields `yaw` and `pitch` are radians.

`createEngine({ orbitControls: true })` calls `bindOrbitInput` for you: drag orbits, the wheel zooms.

### Orbit paths

`OrbitPath` moves an orbit rig along keyframes: orbit states (`OrbitKey`: `target`, `yawDeg`, `pitchDeg`, `distance`) at times `t` in seconds. Between the keys every channel is a cubic Hermite curve with Catmull-Rom tangents for uneven key spacing, so the velocity is continuous at every key. The yaw takes the shorter way round between neighbouring keys (more than 180° between two keys needs a key in between). The distance is interpolated in log space: equal zoom factors take equal time, and it never reaches zero. The target, pitch and distance may overshoot a little between keys, as any spline through the keys does; keep a margin to the limits that matter (the ground, the rig's pitch range, which `apply` clamps to).

- **Open** (default): the path starts and ends at rest, and times outside `0 … duration` are clamped. `duration` is the last key time less the first.
- **Looping** (`{ loop: true, duration }`): the path repeats every `duration` seconds and closes from the last key back to the first with the same smoothness. `duration` must be later than the last key; the closing segment takes the rest. A loop may turn the yaw by whole turns; the sampled yaw then grows from loop to loop, which the rig does not mind.

Time is relative to the first key. `sample(t, out)` writes the state at `t` into a state you own, `apply(rig, t)` writes it straight into a rig, `wrap(t)` folds a time into the path. Neither allocates, so both can run every frame.

<!-- check: wrap -->
```ts
import { OrbitPath, PerspectiveOrbitRig, blendOrbitState, writeOrbitState } from 'wallhammer-web/camera';
import type { OrbitState } from 'wallhammer-web/camera';
declare const view: PerspectiveOrbitRig;
declare const seconds: number;

const path = new OrbitPath(
  [
    { t: 0, target: [0, 5, 0], yawDeg: 20, pitchDeg: 30, distance: 60 },
    { t: 6, target: [10, 4, -8], yawDeg: -30, pitchDeg: 12, distance: 20 },
    { t: 12, target: [0, 20, -60], yawDeg: 10, pitchDeg: 20, distance: 100 },
  ],
  { loop: true, duration: 18 },
);
path.apply(view, seconds); // every frame, before rendering

// Sampling into an own state, and easing from where the view was into the path.
const from: OrbitState = view.state();
const at: OrbitState = { target: [0, 0, 0], yawDeg: 0, pitchDeg: 0, distance: 1 };
path.sample(seconds, at);
writeOrbitState(view, blendOrbitState(from, at, 0.5, at));
```

`writeOrbitState(rig, state)` is `setState` without allocating: the target is copied into the rig's own array, pitch and distance are clamped to its setup. `blendOrbitState(a, b, x, out)` lies between two states (yaw the shorter way, distance in log space); `out` may be `a` or `b`. Leaving a path is free: stop calling `apply`, and `bindOrbitInput` turns the rig on from where the path left it.

## Sizing

`createEngine` keeps the canvas and the view sized (`observeCanvasSize`). Without it, call `syncCanvasSize(canvas, view)` before rendering. A rig starts at 1 × 1 pixels.

## `FreeRig`

A perspective view that moves freely: a position, a heading along the local horizon and a pitch. It is an option; nothing uses it unless you create it.

- **Position in double precision.** `position` is in world metres. Everything the `View` contract hands to the renderer (`eye()`, rays, the cull volume, the matrix) is relative to `origin`, which you keep near the eye and equal to the origin your layers are drawn with (for a `StreamedWorld` that is `world.origin`). Only the difference of the two becomes a float.
- **Up comes from the world shape.** Pass a `WorldShape` (or anything with `upAt`) as `shape`. The rig asks it at its position every time, so the same rig works on a flat world and on a curved one. The heading is kept in the local horizon and carried along when up changes. Without `shape`, up is +y.
- **Height above the surface is your callback.** `heightAbove(p)` returns the height of a world position above the surface under it, measured along the local up (on a flat world `p[1] - groundAt(p[0], p[2])`). The rig never goes below `minClearance`, its cruise speed is `height × speedPerHeight` clamped to `minSpeed … maxSpeed`, and the near plane comes no farther than `nearPerHeight` of the height. Without the callback there is no clearance and the rig cruises at `minSpeed`.

<!-- check: wrap -->
```ts
import { FreeRig } from 'wallhammer-web/camera';
import { FlatWorld } from 'wallhammer-web/gen-core';
import { bindFreeInput } from 'wallhammer-web/platform';
import type { Renderer } from 'wallhammer-web/render';
declare const canvas: HTMLCanvasElement;
declare const renderer: Renderer;
declare const world: { origin: readonly [number, number, number] }; // whatever owns the render origin
declare function groundAt(x: number, z: number): number;
declare function invalidate(): void;

const view = new FreeRig(
  { fovYDeg: 50, minClearance: 2 },
  { shape: new FlatWorld(), heightAbove: (p) => p[1] - groundAt(p[0], p[2]) },
  { position: [0, 30, 0], yawDeg: 30, pitchDeg: 10 },
);
const input = bindFreeInput(canvas, view, { onChange: invalidate });
renderer.beforeFrame.unshift(() => {
  input.step(); // held keys move the rig by the real time since the last frame
  view.origin = [world.origin[0], world.origin[1], world.origin[2]];
});

// Without input: the same calls the binding makes.
view.turnPixels(40, 0); // look right
view.move(1, 0, 0, 1 / 60, false); // forward for one frame
view.lookAt([100, 0, -100]);
view.setState({ position: [500, 80, 500] }); // a jump; the clearance is applied
```

Setup (`FreeSetup`, defaults in `DEFAULT_FREE`):

| Field | Default | Meaning |
| --- | --- | --- |
| `fovYDeg` | 50 | Vertical field of view. |
| `maxPitchDeg` | 89 | Limit of the pitch on both sides of the horizon. |
| `turnPerPx` | 0.004 | Radians of turn per CSS pixel. |
| `minClearance` | 2 | Metres kept above the surface. |
| `followSurface` | `false` | `true` holds the height above the surface while moving: the rig follows the surface up and down and only the part of a move along the local up changes the height. Needs the height callback. |
| `speedPerHeight` | 1 | Cruise speed per metre of height (1/s). |
| `minSpeed`, `maxSpeed` | 5, 5000 | Limits of the cruise speed in m/s. |
| `boost` | 6 | Speed factor while the boost key is held. |
| `inertiaS` | 0.12 | Time constant with which the velocity follows the input; 0 is immediate. |
| `levelMove` | `false` | `true` moves "forward" along the horizon instead of along the view direction. |
| `depthRatio` | 2000 | Largest far / near ratio of the projection. |
| `nearPerHeight` | 0.25 | The near plane is at most this fraction of the height above the surface. |
| `minNear` | 0.1 | Smallest near distance in metres. |

Fields: `position`, `origin`, `pitch` (radians, positive looks down), `yaw` (radians, accessor), `speedScale`, `velocity` (world m/s after the last `move`), `clearance` (height at the last `keepClear`, NaN without a callback), `focusDistance`, `heightAbove`. Methods: `setState`, `state` (degrees, as the orbit rig), `turn`, `turnPixels`, `lookAt`, `move`, `scaleSpeed`, `keepClear`, `up`, `headingDir`, `eye`, `screenRay`, `project`.

The heading is measured in the local horizon from the world −z axis (yaw 0 looks toward −z on a flat world, positive turns left, as for the orbit rig). Where up runs along z the +x axis is the reference instead.

`bindFreeInput(canvas, view, { onChange })` binds `W` `A` `S` `D` and the arrows (move), `E` / `Space` and `Q` / `C` (up, down), `Shift` (boost), a drag (turn) and the wheel (speed). It returns a `FreeInput`: call `step()` once per frame before rendering, and `dispose()` to detach. Options: `keys` (replace single entries of `DEFAULT_FREE_KEYS`), `pointerLock` (a press locks the pointer and its movement turns the view), `grab` (a drag pulls the image instead of turning toward the pointer), `wheelFactor`. It drives anything that implements `FreeControl`, not only `FreeRig`. `createEngine` has no switch for it; leave `orbitControls` off and bind it yourself.

Weak spots:

- `followSurface` holds the height measured at the last `move`, `setState` or `keepClear()`, and it follows every bump of the callback at the speed of the rig. High above a rough surface leave it off, or give the rig a smoothed height. `setup.followSurface` may be switched at any time.
- Write `position` directly only together with `keepClear()`; `setState({ position })` does both and drops the velocity.
- With a low eye and a far scene the near plane moves in (`nearPerHeight`), which spends depth precision far away. Raise `minClearance` or lower the scene's depth range if distant surfaces flicker.
- `origin` must match the origin the layers draw with in the same frame. Set it in `renderer.beforeFrame`, after the code that moves the render origin.

The endless example uses the rig behind `#cam=free` (`examples/endless/src/free-camera.ts`); its default is still an orbit rig whose target is moved with held keys (`trackHeldKeys`).

## `FollowRig`

A perspective view that follows a moving point, typically a body that walks (`Walker` in `wallhammer-web/world`). A pivot sits `pivotHeight` above the followed point and trails it by `followLag`; a boom runs from the pivot back to the eye, turned by `yawDeg` (0 looks toward −z, positive turns left) and `pitchDeg` (positive looks down). `distance` is the wanted boom length; at 0 the eye is the pivot itself (first person). It is an option; nothing uses it unless you create it.

- **The boom never goes through things.** Pass a `BoomClearance` callback: from the pivot along a unit direction, how far may the boom reach (at most `maxDist`). `CollisionWorld.clearance` is made for it; close over the radius of the sphere you cast, a little more than the near plane's corner distance (0.25 m for `near` 0.1). The rig cuts the boom to that length at once and lets it grow back over `boomReturn` seconds, so the view does not jump back and forth at an edge. `boom` is the length drawn this frame.
- **Call `follow` and `update` once per frame**, in that order, after the body has moved: `follow(x, y, z)` with the body's render position, `update(dt)` with the real seconds of the frame. The first `follow` places the pivot at once; after a jump of the body call `snap()` to do the same.
- **`forward(out)` turns input into world movement**: the unit direction on the ground the view looks along. Screen right is `(−forward.z, 0, forward.x)`.

The camera module does not import `world`; the clearance comes in as a plain function. The wiring of one frame with a walking body (the body's own calls are those of `Walker`):

<!-- check: wrap -->
```ts
import { FollowRig } from 'wallhammer-web/camera';
import { bindWalkInput } from 'wallhammer-web/platform';
import type { WalkInputState } from 'wallhammer-web/platform';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine<FollowRig>; // createEngine({ view: rig, … }) without orbitControls
declare const world: { clearance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, radius: number): number };
declare const walker: { advance(dt: number, intent: { moveX: number; moveZ: number; run: boolean; jump: boolean }): number; renderPosition(out: number[]): void };

const rig = new FollowRig(
  { pivotHeight: 1.5, minDistance: 0, maxDistance: 10, followLag: 0.12 },
  { clearance: (ox, oy, oz, dx, dy, dz, max) => world.clearance(ox, oy, oz, dx, dy, dz, max, 0.25) },
);
const input = bindWalkInput(engine.canvas, rig, { onChange: () => engine.invalidate() });

// Made once, written every frame: nothing is allocated per frame.
const state: WalkInputState = { forward: 0, right: 0, run: false, jump: false };
const intent = { moveX: 0, moveZ: 0, run: false, jump: false };
const fw = [0, 0, 0];
const at = [0, 0, 0];
let moving = false;

engine.onInput(() => {
  input.read(state); // keys, pointer turns and the gamepad; the turns already went to the rig
  rig.forward(fw);
  // Forward along the view's heading, right along screen right (−fw.z, fw.x).
  intent.moveX = fw[0]! * state.forward - fw[2]! * state.right;
  intent.moveZ = fw[2]! * state.forward + fw[0]! * state.right;
  intent.run = state.run;
  intent.jump = state.jump;
  walker.advance(engine.frameSeconds, intent);
  moving = state.forward !== 0 || state.right !== 0;
});
engine.onExtract(() => {
  walker.renderPosition(at);
  rig.follow(at[0]!, at[1]!, at[2]!);
  rig.update(engine.frameSeconds);
});
// The loop draws on demand; while the body or the view still moves it has to keep going.
engine.animateWhile(() => moving || input.gamepadConnected);

rig.distance = 0; // first person (a toggle key); the boom shortens at once
rig.distance = 4; // and grows back smoothly
```

Setup (`FollowSetup`, defaults in `DEFAULT_FOLLOW`):

| Field | Default | Meaning |
| --- | --- | --- |
| `fovDeg` | 60 | Vertical field of view. |
| `near`, `far` | 0.1, 2000 | Near and far plane in metres; the scene's depth range only pulls them closer together. |
| `minDistance`, `maxDistance` | 1, 12 | Limits of the wheel zoom (`zoomBy`). `distance = 0` is allowed directly whatever `minDistance` is; with `minDistance` 0 zooming in below 0.5 m snaps to 0 and zooming out of 0 starts at 0.5 m. |
| `minPitchDeg`, `maxPitchDeg` | −40, 80 | Pitch limits; negative looks up from below the pivot. |
| `pivotHeight` | 1.5 | Pivot above the followed point. |
| `followLag` | 0.15 | Seconds in which the pivot closes 95 % of the gap to the followed point; 0 follows rigidly. The smoothing is the same at every frame rate. |
| `boomReturn` | 0.3 | Seconds in which a cut boom regains 95 % of its length; 0 springs back at once. |
| `turnPerPx` | 0.004 | Radians of turn per CSS pixel. |
| `minFocus` | 2 | Smallest distance in front of the eye that counts as the centre of the view (`metresPerPixel`, `refDepth`), for a short boom and first person. |

Members: `yawDeg`, `pitchDeg`, `distance` (wanted), `boom` (drawn, read only), `target` (the followed point), `pivot` (smoothed), `clearance` (replaceable), `follow`, `update`, `snap`, `turnPixels`, `zoomBy`, `forward`, `eye`, `screenRay`, `project`, and the `View` contract. `axes`, `viewProj` and `cornerRays` write into the `out` they are given; a still view keeps its `key()` string.

Weak spots:

- Flat world only: up is +y. On a curved world the pivot height, the horizon of `axes` and `forward` would be laid along the local up taken from an up source at the pivot, as `FreeRig` does; the places are marked in `camera/follow.ts`. Not built yet.
- No render origin: positions go to the renderer as they are, so keep the walking area within a few kilometres of the world origin.
- In first person the followed body is inside the near plane; hide it yourself. `followLag` still applies to the pivot; set it to 0 for a stiff head.

### Walk controls

`bindWalkInput(canvas, view, options?)` drives anything with `dpr`, `turnPixels` and `zoomBy` (`WalkView`), `FollowRig` among them. It binds `W` `A` `S` `D` and the arrows (move), `Shift` (run), `Space` (jump, once per press), a drag (turn) and the wheel (boom length). A gamepad with the standard layout: the left stick moves, the right stick turns (`stickTurnPx` CSS pixels per second at full deflection, default 600), `A` jumps, pressing the left stick or `RT` runs; both sticks have a radial dead zone of `deadZone` (0.15). Options: `onChange` (request a frame; it is called on key changes, turns, and from `read` while movement is asked for), `keys` (replace single entries of `DEFAULT_WALK_KEYS`), `pointerLock` (a click locks the pointer and its movement turns the view; Escape lets it go), `wheelFactor`, `draggingClass`, `gamepad: false`.

It returns a `WalkInput`. Call `read(state)` once per frame: it writes `forward` and `right` (−1…1, in the view's frame), `run` and `jump` into your `WalkInputState` and returns it; the right stick turns the view by the real time since the previous call, or by the `dtSeconds` you pass. `pointerLocked` and `gamepadConnected` tell the state of the devices. A gamepad sends no events for its sticks, so while one is connected keep frames coming (`Engine.animateWhile`).

**Hand-over.** `input.enabled = false` hands the view to someone else, a scripted camera or another rig: held keys are released (a key still held counts again on its next key-down), a drag ends, a locked pointer is let go, a held gamepad button does not count as a new press afterwards, and nothing touches the view; `read` returns no movement. `true` takes it back. To switch the engine to another view use `Engine.setView(view)`: the new view gets the canvas size at once, and `createEngine({ orbitControls: true })` controls act only while their own view is the current one.

<!-- check: wrap -->
```ts
import { FollowRig, PerspectiveOrbitRig } from 'wallhammer-web/camera';
import { bindWalkInput } from 'wallhammer-web/platform';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine<PerspectiveOrbitRig | FollowRig>; // created with the orbit rig and orbitControls: true
declare const orbit: PerspectiveOrbitRig;

const rig = new FollowRig({ minDistance: 0 });
const input = bindWalkInput(engine.canvas, rig, { onChange: () => engine.invalidate(), pointerLock: true });
input.enabled = false; // start in the orbit view

function startWalking(): void {
  rig.yawDeg = orbit.yaw / (Math.PI / 180);
  engine.setView(rig);
  input.enabled = true;
}
function stopWalking(): void {
  input.enabled = false;
  orbit.setState({ target: [rig.pivot[0], rig.pivot[1], rig.pivot[2]], yawDeg: rig.yawDeg });
  engine.setView(orbit); // the orbit drag works again
}
```

Touch is not built yet: a touch drag turns the view like a mouse drag, but there is no on-screen stick to walk with.
