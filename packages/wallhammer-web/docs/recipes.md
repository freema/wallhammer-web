# Recipes

Short, type-checked samples for common extensions. Each says where the code belongs. After any of them, run the checks in [Tools](tools.md).

## Add a layer

Most layers are a `MeshLayer` or an `InstancedLayer` ([Rendering](rendering.md#layers)). Write your own `Layer` when the draw needs logic: several meshes, a uniform per draw, a pass-specific mesh.

Where: the app or example that needs it. A generic layer may go into `render` (no use-case words).

<!-- check: wrap -->
```ts
import type { MeshData } from 'wallhammer-web/base';
import type { Mesh } from 'wallhammer-web/gpu';
import { SHADOW_MAP_UNIT } from 'wallhammer-web/render';
import type { DrawContext, Layer, Material, Renderer } from 'wallhammer-web/render';
declare const renderer: Renderer;
declare const material: Material;
declare const shapes: MeshData[];

/** Draws each mesh with its own brightness. */
class StripLayer implements Layer {
  readonly meshes: Mesh[];
  readonly material: Material;
  constructor(r: Renderer, m: Material, data: readonly MeshData[]) {
    this.material = m;
    this.meshes = data.map((d) => r.createMesh(d, m));
  }
  draw(ctx: DrawContext): void {
    const p = this.material.program(ctx.pass);
    if (!p) return;
    const state = this.material.state[ctx.pass];
    if (state) ctx.device.setState(state);
    ctx.device.use(p);
    // MeshLayer does the same two lines: depth programs need the light matrix, others the shadow map unit.
    if (ctx.pass === 'shadow') p.mat4('u_lightRender', ctx.lightRender);
    else p.int('u_shadowMap', SHADOW_MAP_UNIT);
    this.meshes.forEach((mesh, i) => {
      p.float('u_brightness', 0.5 + 0.1 * i);
      ctx.device.draw(mesh);
      ctx.count(mesh.triangles);
    });
  }
}
renderer.add(new StripLayer(renderer, material, shapes));
```

Checklist:

- Return early for passes you do not draw in.
- If the layer culls, implement `cull` and remember it runs only when the shadow map is refitted.
- Call `engine.invalidate()` after changing what the layer draws.

## Add a material

A material is a `MaterialDesc`. Instanced or displaced geometry needs its own shadow program, because `'depth'` only transforms `a_pos`.

Where: next to the generator whose layout it draws (content module or app).

```ts
import type { MaterialDesc, VertexLayout } from 'wallhammer-web/base';
import { DEPTH_FS } from 'wallhammer-web/render';

/** One instance: base x, y, z and a height. */
export const POST_INSTANCE: VertexLayout = { stride: 16, attribs: [{ name: 'i_base', size: 4, type: 'f32', offset: 0 }] };
export const POST_ATTRIBS = { a_pos: 0, a_normal: 1, i_base: 2 } as const;

const PLACE = `vec3 placed(vec3 p) { return i_base.xyz + vec3(p.x, p.y * i_base.w, p.z); }`;

export const POST_MATERIAL: MaterialDesc = {
  name: 'post',
  attribs: POST_ATTRIBS,
  passes: {
    shadow: {
      vs: `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
in vec4 i_base;
${PLACE}
void main() { gl_Position = u_lightRender * vec4(placed(a_pos), 1.0); }`,
      fs: DEPTH_FS,
    },
    color: {
      vs: `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_base;
out vec3 v_world;
out vec3 v_normal;
${PLACE}
void main() {
  v_world = placed(a_pos);
  v_normal = a_normal;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`,
      fs: `#include <header>
#include <noise>
#include <lighting>
uniform vec3 u_albedo;
in vec3 v_world;
in vec3 v_normal;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 c = toDisplay(u_albedo * lightOn(n, sunVisibility(v_world, n, 1.0), 1.0));
  o_color = vec4(applyFog(c, v_world), 1.0);
}`,
    },
  },
};
```

Draw it with an `InstancedLayer` whose `bounds` is `{ position: 0, radius: 0.3, height: 3 }` for this layout. GLSL errors appear only in the browser; the type check does not see them.

## Add an environment slot

Where: the content module or app that uses the value. Slots are fixed when the engine is created.

```ts
import type { EnvSlot } from 'wallhammer-web/base';
import type { Engine } from 'wallhammer-web/runtime';

export interface HazeParams {
  strength: number;
}

/** `u_haze.x`: haze strength that grows with fog and at low sun. */
export function hazeSlot(params: Partial<HazeParams> = {}): EnvSlot<HazeParams, number> {
  return {
    name: 'haze',
    params: { strength: 1, ...params },
    fields: [{ member: 'u_haze', order: 110, lanes: 'x', doc: 'x haze 0–1' }],
    compute: (env, p) => p.strength * Math.min(1, env.fog + Math.max(0, 10 - env.sunElevationDeg) / 30),
    lanes: (v) => [v],
    glsl: `float hazeAmount() { return u_haze.x; }`,
  };
}

export function readHaze(engine: Engine, slot: EnvSlot<HazeParams, number>): number {
  return engine.link.value(slot) ?? 0;
}
```

Register it with `createEngine({ slots: [hazeSlot()] })`. Shaders then read `u_haze` directly, or `#include <haze>` for `hazeAmount()`.

- `order` places the member within its region. The engine's own members use 10 to 90; the minimal example's glow slot uses 100. Equal orders are sorted by member name. A member declared twice, or a lane filled twice, throws.
- To fill a free lane of an engine member instead, set `member: 'u_wind', lanes: 'zw'` and leave out `order`.
- If the value changes shadows, add `shadowKey`.

## Add a generator

Where: `gen-mesh` or `gen-tex` if it is generic and names no use case; `gen-arch`, `gen-ground` or `gen-vegetation` if it is content; the app otherwise.

```ts
import type { InstanceData, VertexLayout } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';
import type { HeightField } from 'wallhammer-web/gen-core';

export const MARKER_LAYOUT: VertexLayout = { stride: 16, attribs: [{ name: 'i_base', size: 4, type: 'f32', offset: 0 }] };

/**
 * One marker per grid cell where the hash allows it. Keys are the cell indices (input), never a running counter,
 * so a cell's marker does not depend on its neighbours or on iteration order.
 */
export function scatterMarkers(field: HeightField, seed: number, gridM: number, share: number): InstanceData {
  const out: number[] = [];
  const cols = Math.floor(((field.cols - 1) * field.step) / gridM);
  const rows = Math.floor(((field.rows - 1) * field.step) / gridM);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (unit(hashInts(seed, i, j, 0)) > share) continue;
      const x = (i + 0.2 + 0.6 * unit(hashInts(seed, i, j, 1))) * gridM;
      const z = (j + 0.2 + 0.6 * unit(hashInts(seed, i, j, 2))) * gridM;
      out.push(x, field.heightAt(x, z), z, 1 + 2 * unit(hashInts(seed, i, j, 3)));
    }
  }
  return { layout: MARKER_LAYOUT, data: Float32Array.from(out) };
}
```

Then pin its output with a golden recipe. In `tools/golden/engine/golden.ts`, import it by relative path and add an entry to `RECIPES` (the file has a local `hash` helper):

<!-- check: skip -->
```ts
'gen-mesh scatterMarkers': () => hash(scatterMarkers(ground, 7, 8, 0.4).data),
```

Run the golden test, read the `MISSING` line, accept as described in [Tools](tools.md#add-an-entry).

## Add a destructible structure

A `StructureDesc` can come from `gen-arch` or be written by hand. Lengths are integer centimetres; parts and bonds must be sorted.

```ts
import { PART_FLAG, PART_ROLE } from 'wallhammer-web/base';
import type { StructureDesc } from 'wallhammer-web/base';
import { applyEvent, destructionEvent, intactState, stateHash } from 'wallhammer-web/sim/destruction';

/** An axis-aligned box piece in centimetres, corners counter-clockwise. */
const box = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number) => ({ xz: Int32Array.from([x0, z0, x1, z0, x1, z1, x0, z1]), y0, y1 });

const pier: StructureDesc = {
  id: 1,
  keepOut: false,
  groundY: 0,
  cx: 50,
  cz: 50,
  outline: Int32Array.from([0, 0, 100, 0, 100, 100, 0, 100]),
  materials: [{ crack: 200, breach: 500, gone: 900, density: 2000 }],
  parts: [
    { key: 1, role: PART_ROLE.foundation, material: 0, mass: 2000, piece: box(0, 0, 100, 100, -50, 0), flags: PART_FLAG.anchor | PART_FLAG.indestructible, maxSpan: 255 },
    { key: 2, role: PART_ROLE.bearing, material: 0, mass: 1200, piece: box(0, 0, 100, 30, 0, 300), flags: 0, maxSpan: 255 },
  ],
  bonds: [{ a: 1, b: 2, bearing: true, x: 50, y: 0, z: 15, area: 3000 }],
};

const ev = destructionEvent({ position: [0.5, 1.5, 0.15], radius: 1, energy: 1000, seed: 3, tick: 1 });
const res = applyEvent(pier, intactState(pier.id), ev);
console.log(res.changes.map((c) => `${c.part}: ${c.from} → ${c.to}`), stateHash(res.state));
```

To draw a hand-written structure you need your own mesh; `gen-arch`'s damage drawing works only for structures it generated. Test the description in Node first ([Headless use](headless.md)).

## Add a streamed cell provider

A provider delivers `CellContent` for a cell id. Write one when cells come from somewhere new: a server, an IndexedDB cache, a different file layout. Where: the app or example.

```ts
import type { CellId } from 'wallhammer-web/gen-core';
import { cellKey } from 'wallhammer-web/gen-core';
import { decodeCell } from 'wallhammer-web/world';
import type { CellProvider, CellResult } from 'wallhammer-web/world';

/** Reads cells from an HTTP endpoint that serves WHC1 bytes under `<base>?cell=<key>`, caching them in memory. */
export class EndpointCellProvider implements CellProvider {
  readonly name = 'endpoint';
  readonly blocking = false;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly base: string;
  constructor(base: string) {
    this.base = base;
  }
  async request(cell: CellId, signal: AbortSignal): Promise<CellResult> {
    const key = cellKey(cell);
    const hit = this.cache.get(key);
    if (hit) return { content: decodeCell(hit), bytes: hit, origin: 'memory' };
    const res = await fetch(`${this.base}?cell=${encodeURIComponent(key)}`, { signal });
    if (!res.ok) throw new Error(`cell ${key}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.cache.set(key, bytes);
    return { content: decodeCell(bytes), bytes, origin: 'file' };
  }
}
```

Rules:

- `request` must reject with an error named `AbortError` when the signal fires first. `fetch` does that for you.
- Set `blocking: true` only if `request` does its work synchronously; the streamer then calls it within a frame budget.
- Content must be byte-identical to what the generator would produce, or seams and level changes break. Compare with `GeneratorCellProvider.bytes(cell)` in a Node script, as `examples/endless/scripts/verify.ts` does.

`fetch` in a provider is browser code. Keep such a provider in the app, or in `platform` if it becomes generic.

## Add an animated rig

Where: the app (the campus app keeps its rigs in one folder of its own). A rig is plain data; the layer animates it.

```ts
import type { RigDesc, RigPart } from 'wallhammer-web/base';

/** A two-wheeled handcart pushed by nobody: a box on an axle, wheels that roll, a handle that sways a little. */
export function handcartRig(): RigDesc {
  const wood: readonly [number, number, number] = [0.52, 0.38, 0.24];
  const parts: RigPart[] = [
    { shape: { kind: 'box', size: [0.9, 0.35, 1.3] }, at: [0, 0.62, 0], slot: 0, tint: [1, 1, 1] },
    { shape: { kind: 'roller', radius: 0.32, width: 0.08, sides: 10 }, at: [-0.52, 0.32, 0], motion: 'spin', amount: 0.32, tint: [0.2, 0.2, 0.2] },
    { shape: { kind: 'roller', radius: 0.32, width: 0.08, sides: 10 }, at: [0.52, 0.32, 0], motion: 'spin', amount: 0.32, tint: [0.2, 0.2, 0.2] },
    { shape: { kind: 'rod', dir: [0, 0.35, -0.94], length: 1.1, thickness: 0.05 }, at: [0, 0.75, -0.6], motion: 'wobble', amount: 0.03, tint: wood, nearOnly: true },
  ];
  return { name: 'handcart', parts, segments: [{ shadow: [0.5, 0.75, 0] }], height: 1.1, radius: 1.4, bob: 0.01 };
}
```

1. Local axes: x right, y up, z forward, origin on the ground under the anchor (where the mover's position is).
2. Give every wheel `spin` with its radius as `amount`, so it rolls without slipping at any speed.
3. Draw it with `RigLayer.addKind(rig, capacity)` and records from `extractPose` ([Rigs](rigs.md#drawing-instances)).
4. Pin it with a golden recipe that hashes `rigMesh(desc, false)` and `rigMesh(desc, true)` from `gen-mesh`, as the `gen-actor rigs` entry does.

## Drive entities with agendas

Where: the app. The engine routes, moves and times; the app says what places are and what happens there. This one gives people a ride: they walk to a stop, wait there until a vehicle of a replayed timetable dwells, get carried to the next place and walk from there.

<!-- check: wrap -->
```ts
import { Agendas, Movers, NavGraph, Simulation } from 'wallhammer-web/sim';
import type { AgendaPlace } from 'wallhammer-web/sim';
declare const nav: NavGraph;
declare const places: AgendaPlace[];
/** Is a vehicle dwelling at this place at agenda time `t` (seconds)? From the app's timetable. */
declare const dwelling: (place: number, t: number) => boolean;

const hz = 10;
const MODE = { walk: 0, board: 1, alight: 2 } as const;
const sim = new Simulation({ seed: 'rides', hz });
const people = new Movers('people', { hz, collision: 'agents', width: 0.5 });
let WAITING = -1;
let RIDING = -1;
const agendas = new Agendas('people.agendas', {
  movers: people,
  nav,
  places,
  origin: 7 * 3600,
  spawn: () => ({ cruise: 1.3, gap: 0.8 }),
  // Somebody whose agenda starts with getting off is on board, not standing at the stop.
  onAppear: (e, a) => (a.activity(e).mode === MODE.alight ? RIDING : undefined),
  onArrive: (e, a) => (a.activity(e).mode === MODE.board ? WAITING : undefined),
});
WAITING = agendas.states.define('waiting', {
  update: (e, a) => {
    if (!dwelling(a.activity(e).place, a.time)) return;
    a.hide(e);
    return a.arriveNext(e); // carried to the next activity: its `onArrive` runs (or `stay`)
  },
});
RIDING = agendas.states.define('riding', {
  enter: (e, a) => a.hide(e),
  update: (e, a) => {
    const act = a.activity(e);
    if (a.now < act.at || !dwelling(act.place, a.time)) return;
    const p = a.places[act.place]!;
    a.show(e, p.x ?? 0, p.z ?? 0);
    return a.leave(e); // walk on to the next activity
  },
});
sim.addState(people);
sim.addState(agendas);
sim.addSystem('people', people.system);
sim.addSystem('agendas', agendas.system);
```

- Add every entity (`agendas.add`) before the first tick; a snapshot holds the table, not the activity lists.
- Keep app state that matters for the outcome in the agenda table (`setData`, `setTimer`) or recompute it from the tick; anything else breaks `seek` and snapshots.
- Places marked `inside` cost nothing while people stay there. Thousands of entities with a few hundred out of doors run at about a millisecond per tick.
- Listen to `agenda.unreachable` (a place off the graph's largest component) and count it.

## Feed agendas from external data

Where: a preparation script in the app writes a file; the app reads it. The engine never parses files. A format that keeps the external model out of the app: places as kinds and points in local metres, people as activities in seconds of the day.

<!-- check: skip -->
```ts
{
  "version": 1,
  "source": "what produced it",
  "notes": ["what was assumed, one line each"],
  "places": [{ "kind": "entrance", "x": 412.5, "z": 88.0 }, { "kind": "stop", "x": 520.1, "z": 131.4, "stop": "Name" }],
  "people": [{ "activities": [
    { "place": 1, "at": 27000, "stay": 0, "mode": "alight" },
    { "place": 0, "at": 27090, "stay": 30600 },
    { "place": 1, "at": 57700, "stay": 0, "mode": "board" }
  ] }]
}
```

The app maps it onto the engine:

<!-- check: wrap -->
```ts
import type { AgendaEntity, AgendaPlace } from 'wallhammer-web/sim';
declare const file: { places: { kind: string; x: number; z: number }[]; people: { activities: { place: number; at: number; stay: number; mode?: string }[] }[] };
/** Nearest node of the walking graph to a point (the app's own lookup). */
declare const nearestNode: (x: number, z: number) => number;

const MODES: Record<string, number> = { walk: 0, board: 1, alight: 2 };
const places: AgendaPlace[] = file.places.map((p) => ({ node: nearestNode(p.x, p.z), x: p.x, z: p.z, inside: p.kind === 'entrance' }));
const entities: AgendaEntity[] = file.people.map((person, i) => ({
  tag: i,
  activities: person.activities.map((a) => ({ place: a.place, at: a.at, stay: a.stay, mode: MODES[a.mode ?? 'walk'] ?? 0 })),
}));
```

- Snap points to the graph in the app (doors to path ends at houses, parking to bays, the border to graph nodes near the edge) and say how far each moved.
- Write down in `notes` what the source does not have (stay lengths, the way back, which vehicle someone rides) and what was assumed instead. The campus app has such a preparation script for its synthetic population.
- Keep a synthetic fallback for when the file is missing, so the app runs without the external model.

## Report loading progress

A `Progress` is a list of named stages with weights. Whoever does the work advances its stage; whoever shows it
subscribes. It has no DOM and no clock, so a worker job, an upload or a shader compile can feed it, and the page turns
the report into a bar.

Where: the app. The engine only provides the report; the stages, their labels (in the app's language) and the screen
belong to the app.

<!-- check: wrap -->
```ts
import { Progress } from 'wallhammer-web/base';
import type { Device } from 'wallhammer-web/gpu';
declare const device: Device;
declare const pieces: Promise<unknown>[];
declare function showBar(fraction: number, label: string): void;

const progress = new Progress([
  { key: 'data', label: 'Loading data', weight: 1 },
  { key: 'pieces', label: 'Building pieces', weight: 6 },
  { key: 'shaders', label: 'Compiling shaders', weight: 1 },
]);
const stop = progress.subscribe((r) => showBar(r.fraction, r.of > 1 ? `${r.label} (${r.units}/${r.of})` : r.label));

// ... fetch the data, then:
progress.complete('data');
// Worker jobs: one unit each, advanced as each settles.
await progress.track('pieces', pieces);
// Programs compile in parallel in the driver; poll between frames instead of blocking on the status.
const total = device.compiling();
progress.total('shaders', total);
for (let left = total, done = 0; left > 0; left = device.compiling()) {
  progress.advance('shaders', total - left - done);
  done = total - left;
  await new Promise((r) => requestAnimationFrame(r));
}
progress.complete('shaders');
stop();
```

- Keep a step that runs on the main thread shorter than a frame budget: write it as a generator that `yield`s between
  pieces (as `plantTreesSteps` does) and let the app run it in slices. The result must not depend on where it pauses.
- Weights are relative; set them from measured times, not from the number of units.
