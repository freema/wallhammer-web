# Concepts

Six ideas explain most of the engine.

## 1. Generators return plain data

A generator is a pure function. Input plus seed gives data. It never touches the GPU. The data contracts live in `wallhammer-web/base`:

| Type | Shape |
| --- | --- |
| `VertexLayout` | `{ stride, attribs: VertexAttrib[] }`. An attribute has `name`, `size` (1–4), `type` (`f32`, `i8`, `u8`, `i16`, `u16`, `i32`, `u32`), `offset`, and optional `normalized` and `integer`. |
| `MeshData` | `{ layout, vertices, indices, count, primitive? }`. `indices` may be `null`. |
| `InstanceData` | `{ layout, data: Float32Array }`. One record per instance. |
| `TextureData` | `{ width, height, format, data: Uint8Array, filter?, anisotropy? }`. Formats: `r8`, `r8ui`, `rg8`, `rgba8`. |
| `MaterialDesc` | `{ name, attribs, passes, state? }`. GLSL per pass, or `'depth'` for the shared shadow programs. |
| `BakeDesc` | A fragment shader with input textures, uniforms and targets that the GPU runs once into textures. |

The app hands this data to the renderer: `renderer.createMesh`, `createInstances`, `createTexture`, `bake`. That is the only upload path.

Because generators are pure, their output can be hashed. The golden test does exactly that ([Tools](tools.md#golden-hashes)).

## 2. Determinism

Randomness comes from hashes, not from a generator state.

```ts
import { hashInts, rand, randRange, streamSeed, unit } from 'wallhammer-web/gen-core';

const s = streamSeed('world-7', 'stones'); // a named stream of a world seed
const a = rand(s, 12, 4); // 0..1 for the keys (12, 4), always the same
const b = randRange(2, 5, s, 12, 4, 1); // 2..5
const c = unit(hashInts(s, 99)); // the same thing by hand
```

Keys are integers from the input: a grid cell, a recipe index, an object id. They are never a loop counter over output. Then the result does not depend on generation order.

The simulation goes further. It runs on integer millimetres and integer ticks and avoids transcendental `Math` functions, so the same commands give the same state hash on every machine ([Simulation](simulation.md)).

Where an angle is needed and the result must agree between machines, use the reproducible functions of `base` (`detSinCosTurns` and relatives) instead of `Math.sin`. Orbits and nested frames are built on them ([Bodies on rails and nested frames](frames.md)).

Weak spot: only `sim` is checked for `Math.random` and clocks. In generators it is a convention. See [Architecture](architecture.md#conventions-the-check-does-not-enforce).

## 3. The palette

The project names its colours. The engine turns them into a uniform table of up to 64 rows (`PALETTE_CAPACITY`).

```ts
import { definePalette } from 'wallhammer-web/core';

const palette = definePalette({ ground: '#4d4335', sky: '#6795b1' });
palette.index('sky'); // 1: the row a shader reads as u_palette[1]
palette.color('sky'); // [r, g, b] in 0..1
palette.data(); // Float32Array for the renderer
```

Rows keep insertion order. The engine has no global palette and no colour names. Content modules take row indices or RGB values.

## 4. The Frame block and environment slots

Every program sees one uniform block, `Frame`. The renderer owns the view and light matrices in it. The environment owns the rest: light colours, time, wind, clouds, weather, fog. Projects and content modules add their own members through **environment slots** (`EnvSlot`). A slot has parameters, a pure `compute` from the generic `FrameEnvironment`, and a mapping of its values to vec4 lanes. The block layout is fixed when the engine is created. See [The environment](environment.md) and [Rendering](rendering.md#environment-slots).

## 5. Layers and passes

The renderer draws a list of layers in the order they were added. A layer implements `draw(ctx)` and is called once per pass. The passes are `shadow`, `color`, `data` and `overlay`. `ctx.pass` says which one is running. `MeshLayer`, `PieceLayer`, `InstancedLayer` and `InstanceCellLayer` cover most needs. The engine's own layers keep their places round the app's: the sky or the atmosphere first (or where `engine.moveSkyBefore` puts the sky), then the layers added through `engine.add`, then the volumetric clouds (or where `engine.moveCloudsBefore` puts them, before the layers that blend over them), and the precipitation last. See [Rendering](rendering.md).

## 6. The frame order

`createEngine` owns the order. Init:

1. simulation, 2. environment, 3. canvas and device, 4. Frame block from the slots, 5. renderer, 6. environment link, 7. view size, 8. input, 9. frame loop.

One frame:

1. input hooks (`engine.onInput`). They queue commands.
2. Whole fixed ticks of the simulation.
3. Environment clocks.
4. Extraction hooks (`engine.onExtract(alpha)`). They write interpolated transforms into layer data.
5. The environment frame (Frame block values).
6. Render.

`dispose()` runs the init order in reverse.

The loop draws on demand. It runs continuously only while the simulation or an environment clock is animating. Otherwise it draws on input, resize and `engine.invalidate()`.

The simulation never reads anything the image side owns. The image side reads the simulation only in extraction hooks.

A body of its own rate (a `Walker`, a `WheeledBody`, a `WheeledGroup`) takes its steps from the frame's seconds through `FixedSteps` (`wallhammer-web/core`): the seconds add up, as many whole steps run as are due (at most `maxSteps`; the rest of a longer pause is dropped), the rest carries over, and `alpha` is the share of the way to the next step for drawing. Frames of 1/30 s and of 1/60 s run the same steps. A game's own fixed-rate system uses one too: `fixed.advance(dt, step)`.

## 3 × 4 matrices

An affine transform (rotation, scale, shear, then translation) on the CPU is a `Mat34` of `wallhammer-web/base`: 12
numbers column by column, the three columns of the linear part and then the translation, the same layout as the first
12 floats of an instance record (`writeInstance`). Every function takes `out` last and returns it; without `out` it
returns a new `Float64Array` (or a `[x, y, z]` for points). `out` may be one of the inputs. Angles are radians,
rotations right-handed, quaternions `[x, y, z, w]` as in `frames`.

| Function | Result |
| --- | --- |
| `mat34Identity(out?)`, `mat34Copy(m, out?)` | Identity; a copy. |
| `mat34Translation(x, y, z, out?)`, `mat34Scaling(sx, sy, sz, out?)` | Translation; scale. |
| `mat34RotationX/Y/Z(rad, out?)`, `mat34RotationAxis(ax, ay, az, rad, out?)` | Rotation about an axis (normalised; a zero axis gives the identity). |
| `mat34FromQuat(q, out?, tx?, ty?, tz?)` | Rotation of a unit quaternion, with an optional translation. |
| `mat34Multiply(a, b, out?)` | `a · b`: `b` applied first. |
| `mat34Determinant(m)`, `mat34Invert(m, out?)` | Determinant of the linear part; inverse, `null` when singular. |
| `mat34Point(m, x, y, z, out?)`, `mat34Direction(m, x, y, z, out?)`, `mat34Normal(m, x, y, z, out?)` | A point (with translation); a direction (without); a normal (cofactor matrix, normalised, sign kept for mirrors, the same rule as `instanceNormal` in GLSL). |

<!-- check: wrap -->
```ts
import { mat34Invert, mat34Multiply, mat34Point, mat34RotationY, mat34Scaling, mat34Translation } from 'wallhammer-web/base';

const local = mat34Multiply(mat34RotationY(Math.PI / 4), mat34Scaling(2, 1, 2));
const world = mat34Multiply(mat34Translation(10, 0, 5), local);
const p = mat34Point(world, 1, 0, 0);
const back = mat34Invert(world);
const scratch = new Float32Array(12);
mat34Multiply(world, mat34RotationY(0.1), scratch); // allocation-free with out
console.log(p, back !== null && mat34Point(back, p[0], p[1], p[2]));
```

## Units and axes

- One unit is one metre. y is up.
- Inside the simulation, lengths are integer millimetres.
- In destructible descriptions, lengths are integer centimetres.
- Angles in public options are degrees (`yawDeg`, `pitchDeg`). Inside rigs and shaders they are radians.
