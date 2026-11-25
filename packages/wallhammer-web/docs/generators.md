# Generators

A generator is a pure function: input plus seed gives plain data ([Concepts](concepts.md#1-generators-return-plain-data)). Generators live in layers 2 and 3 and never touch the GPU.

## `gen-core`: randomness, fields, geometry

**Randomness.** `streamSeed(worldSeed, name)` derives a named stream. `hashInts(seed, ...keys)` hashes integer keys. `unit(h)` maps a hash to 0..1. `rand(seed, ...keys)` and `randRange(lo, hi, seed, ...keys)` combine both. `pickWeighted(options, r)` picks by weight. `hashString`, `hashInt` and `mix32` are the building blocks.

**Noise.** `valueNoise2(x, z, cellM, seed)` is smooth 2D value noise in 0..1.

`valueNoise3(x, y, z, cellM, seed)` is the same in space, and `fractalNoise3(x, y, z, { cellM, octaves, lacunarity?, gain? }, seed)` sums octaves of it (0..1, each octave with its own seed and offset). Sampled at the points of a curved surface they have no seam and no pole: the value depends on the point alone. Both are built from the integer hash, `Math.floor` and arithmetic, so the bits are the same everywhere.

**A cube blown up to a sphere.** `cube-sphere.ts` holds the geometry of a sphere made of six square grids, without any radius: `CUBE_FACE_AXES` (faces 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z, each with axes u and v, u × v outward), `cubeGrid(g, count)` (grid index to −1..1), `cubeWarp` / `cubeUnwarp` (the even-angle spacing, from reproducible trigonometry), `cubeDirection(face, s, t)` and `cubeDirectionWarped` (the unit direction of a grid point; a point shared by two faces gets the same bits from both), `cubeFaceOf(dir)` and `cubeFaceCoords(face, dir)` (back), `cubeNeighbour(face, level, x, y, dx, dy)` (the cell next to a cell, across an edge of the cube; null over a corner) and `directionTangents(dir)` (two directions across `dir` that depend on `dir` alone).

**Surface of a sphere cell.** `spherePatchMesh({ radiusM, face, level, x, y, quads, heightAt, colorAt?, skirtDepth })` builds the mesh of one cell (`SPHERE_PATCH_LAYOUT`, attribute locations `SPHERE_PATCH_ATTRIBS`) with normals, the blend attributes toward the level above and a skirt, and returns its origin, bounds, height range and error. `spherePatchRadius(options, dir, step)` is where a direction meets the triangles of that mesh (`step` 1) or of the level above (`step` 2). `SPHERE_PATCH_GLSL` is the blend factor for the vertex shader. See [A sphere world](streaming.md#a-sphere-world).

**Fields.** Spatial structures that generators query:

| Class | Use |
| --- | --- |
| `HeightField(step, cols, rows, heights)` | A regular height grid. `heightAt(x, z)` interpolates; `minY`, `maxY`. The static `HeightField.coarseSurface(cols, rows, values, n)` gives the surface of the grid thinned to every n-th vertex, evaluated at every vertex (the shape of a coarser level of detail). |
| `SegmentField(sizeX, sizeZ, bucketM?)` | Distance to the nearest of many segments (lines such as paths). |
| `OutlineField(polygons, sizeX, sizeZ, bucketM?)` | Inside tests and distance to polygon outlines. |
| `Occupancy(sizeX, sizeZ, step?)` | A grid that marks taken ground, for placement without overlap. |

**Geometry.** `Ring` is a flat `[x, z, x, z, …]` polygon. `ringSignedArea`, `ringsArea`, `pointInRings`, `insetRing`, `distToSegment`, `orientedBox`.

**Instance cells.** `splitInstanceCells(instances, { stride, bounds, cellM, tiers?, seed? })` sorts an instance stream into square cells of `cellM` metres by base point (x, z). Each cell gets a box that holds its instances (radius widened by the widest tier) and its data per tier: tier t keeps an instance when `hash(seed, index) % keep === 0` and multiplies its radius by `widen`. `DEFAULT_INSTANCE_TIERS` keeps all, one in 4 (×1.7) and one in 12 (×2.6). Cells come ordered by row, then column. Feed the result to `InstanceCellLayer` ([Rendering](rendering.md#layers)).

**Cells.** `CellId`, `FlatWorld`, `FACE_FLAT`, `LEVEL`, `cellKey`, `shapeHash` and friends describe streamed cells. They are in `gen-core` so that generators can produce `CellContent` without depending on `world`. See [World streaming](streaming.md).

```ts
import { HeightField, Occupancy, randRange, streamSeed, valueNoise2 } from 'wallhammer-web/gen-core';

const seed = streamSeed('7', 'stones');
const n = 33;
const heights = Float32Array.from({ length: n * n }, (_, k) => 8 * valueNoise2((k % n) * 4, Math.floor(k / n) * 4, 30, seed));
const field = new HeightField(4, n, n, heights);
const taken = new Occupancy(128, 128);
const stones: number[] = [];
for (let i = 0; i < 20; i++) {
  const x = randRange(8, 120, seed, i, 0);
  const z = randRange(8, 120, seed, i, 1);
  stones.push(x, field.heightAt(x, z), z);
}
```

## `gen-mesh`: meshes

| Export | Output |
| --- | --- |
| `heightFieldMesh(field, baseY)` | Surface plus a vertical skirt down to `baseY`. Layout `HEIGHT_FIELD_LAYOUT`: position as 3 floats, normal as 3 × int16 plus a kind (0 surface, 1 skirt). |
| `lineMesh(paths, heightAt, liftM?, maxSegmentM?)` | Line segments draped over a height function. Layout `LINE_LAYOUT`. |
| `cellSurfaceMesh({ originX, originZ, size, quads, heightAt, colorAt?, skirtDepth })` | One streamed cell's surface relative to its origin, with vertex colours and a skirt that hides cracks between levels. Layout `CELL_SURFACE_LAYOUT`. |
| `cellMorphMesh(options)` | The same surface (same options, `quads` even) that can blend into the cell one level coarser: per vertex also the distance to the coarser surface and its normal and colour. Returns `{ mesh, minY, maxY, error, skirtDepth }`; the skirt is at least `skirtDepth` and at least twice what its border needs (with `quads` a multiple of four also for a cell shown away from the viewer in its parent's shape). Layout `CELL_MORPH_LAYOUT`, shader part `CELL_MORPH_GLSL`. See [World streaming](streaming.md#blending-between-levels). |
| `drapeTiles(field, { rect?, liftM?, tileQuads?, every?, origin? })` | A sheet laid on a height field: the field's own surface again, lifted by `liftM` (0.15 m), positions only, in tiles of `tileQuads` quads with their boxes. With `every` > 1 it uses every n-th vertex and the highest height around it, so it never sinks below the surface. `drapeEvery(field, maxVertices, rect?)` gives the smallest `every` that fits a vertex count. Layout `DRAPE_LAYOUT`. |
| `prismMesh(shapes, { growM? })` | Upright prisms (walls and lid) over outlines; every vertex carries its prism's table row in `a_ref`. `growM` moves the walls outward so the shell stands clear of what it wraps. No normals: the shader takes the face direction from screen derivatives. Layout `PRISM_LAYOUT`. `triangulateRing(ring)` is the ear clipping it uses for lids. |
| `packMesh(mesh, frame, { spans? })` | The same mesh with positions as 16-bit steps of `frame` (`packFrame(edgeM, origin, heightOrigin, stepY)`: 16,384 steps along the edge, `stepY` metres per vertical step) and every other attribute byte for byte. Loose triangles become indexed, equal vertices once in the order of first use; with `spans` only inside each span, so one span packed alone has the bytes it has in the whole. Indices are 16-bit up to 65,536 vertices. Returns `{ mesh, spans, clamped }`. `packedLayout(layout)` is the resulting layout, `packedMaterial(desc)` the material that reads it. See [Packed meshes](streaming.md#packed-meshes). |
| `bisectSurface(heights, options)` | A square height grid (`quads` a power of two, one extra sample all round for the normals) as a packed mesh within `toleranceM` of the grid: flat ground becomes a few large triangles. Outer edges get a skirt `skirtM` deep; a side listed in `cuts` is a cut through the ground down to a height; `clip` cuts the square off at a rectangle. Returns `{ mesh, triangles, gridTriangles, minY, maxY }`. Layout `BISECT_SURFACE_LAYOUT` (packed position, normal as 3 × int16 plus a kind), drawn by a height field material through `packedMaterial`. See [A surface within a tolerance](streaming.md#a-surface-within-a-tolerance). |
| `chunkMeshes(meshes, { cellM?, cellKey?, position?, padM? })` | Static meshes cut into spatial chunks: every triangle goes to the cell of its centroid (square cells of `cellM`, 64 m, or any cell from `cellKey(x, y, z)`), the triangles of one cell from all meshes are merged with whole vertex records copied byte for byte. All meshes share one layout with a three-float position (`a_pos`). Returns `MeshChunk[]` (`{ key, min, max, data, triangles }`, boxes widened by `padM`), ready for `PieceLayer`: one draw per visible chunk. See [Point lights, particles and instance sets](rendering.md#point-lights-particles-and-instance-sets). |
| `PropBox` (type) | A small oriented box prop. `gen-arch` re-exports the same type. |
| `MeshBuilder<V>`, `VertexFormat<V>`, `faceNormal` | Building meshes by hand in a vertex format of the caller's: a transform stack, triangles, mirroring, `append`, bounds, the positions and indices for collisions and checks. See [Building meshes in your own vertex format](#building-meshes-in-your-own-vertex-format). |
| `revolve`, `sweep`, `extrude`, `polygon`, `gridSurface`, `box`, `cylinder`, `pathFrames`, `smoothPath` | Bare shapes for `MeshBuilder<V>` that ask the caller for every vertex payload. See [Bare shapes](#bare-shapes). |

## Building meshes in your own vertex format

What a vertex carries besides its position and normal decides what a material can draw, so it belongs to the game:
one game stores colour, occlusion and a few flag bytes, another stores panel coordinates for ink lines and a direction
for an outline. `MeshBuilder<V>` (`gen-mesh/mesh-builder.ts`) builds triangles in any such format. It knows only the
position, the normal, the transforms and the indices; the rest is a payload `V` per vertex, stored by reference and
handed back to the format when the mesh is packed. The engine never looks inside it.

<!-- check: skip -->
```ts
interface VertexFormat<V> {
  readonly layout: VertexLayout;   // attributes, including position and normal; layout.stride === stride
  readonly stride: number;         // bytes per vertex
  /** One vertex at `offset`; `p` and `n` are already in mesh space (n unit length). `index` is the vertex number. */
  write(view: DataView, offset: number, p: ArrayLike<number>, n: ArrayLike<number>, v: V, index: number): void;
}
```

| Member | What it does |
| --- | --- |
| `new MeshBuilder(format)` | An empty builder; throws when `format.layout.stride` differs from `format.stride`. |
| `push(m)`, `pop()`, `with(m, fn)` | The transform stack: `m` is a 3 × 4 matrix (12 numbers, column by column, as `Mat34` in [Concepts](concepts.md#3--4-matrices)); `push` multiplies the current transform by `m` (`m` applies first). `transform` and `mirrored` read the current state; `pop` without `push` throws. |
| `vertex(p, n, v)` | Adds a vertex through the current transform (normals by the cofactor matrix, unit length, outward also under a mirror); returns its index. |
| `tri(a, b, c)`, `quad(a, b, c, d)` | Triangles counter-clockwise seen from outside; under a mirroring transform the winding is reversed so faces stay outward. |
| `append(other, m?)` | Another builder's vertices (through the current transform, then `m`) and triangles; payloads are kept, a mirroring result flips the winding. |
| `bounds(first?)`, `vertexCount`, `indexCount`, `triangleCount` | Box and counts. |
| `position(i)`, `normal(i)`, `payload(i)`, `setPayload(i, v)`, `edit(fn, first?, end?)` | Read or change single vertices; `edit` visits a range with the position and normal to change in place and may return a new payload (displacing, recolouring, filling data that depends on the finished mesh). |
| `positions()`, `normals()`, `indices({ index? })` | New typed arrays: for collision solids (`addMeshSolid` in [Walking](walking.md)), checks ([Mesh checks](tools.md#mesh-checks)), or a second index order. |
| `positionData`, `normalData`, `indexData`, `setTriangle(t, a, b, c)` | The same numbers without a copy (read only, live), for passes over a large builder; `setTriangle` rewrites one triangle as given, for example to turn its winding after the fact (a triangle or vertex out of range throws `RangeError`). |
| `vertices()`, `build({ index? })` | The packed bytes (`write` once per vertex, in order) and the `MeshData`. Indices are 16-bit up to 65,536 vertices, else 32-bit; `index: 32` forces 32 bits. |
| `faceNormal(points, out?)` | The unit normal of a flat polygon given counter-clockwise from its front (Newell's method). |

A game defines its format once, next to its material:

```ts
import type { VertexLayout } from 'wallhammer-web/base';
import { MeshBuilder } from 'wallhammer-web/gen-mesh';
import type { VertexFormat } from 'wallhammer-web/gen-mesh';

/** This game's payload: an albedo and a glow strength. */
interface Paint {
  rgb: readonly [number, number, number];
  glow: number;
}

const LAYOUT: VertexLayout = {
  stride: 20,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i8', normalized: true, offset: 12 },
    { name: 'a_paint', size: 4, type: 'u8', normalized: true, offset: 16 },
  ],
};

const byte = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));

const FORMAT: VertexFormat<Paint> = {
  layout: LAYOUT,
  stride: 20,
  write(view, o, p, n, v) {
    for (let k = 0; k < 3; k++) view.setFloat32(o + k * 4, p[k]!, true);
    for (let k = 0; k < 3; k++) view.setInt8(o + 12 + k, Math.round(n[k]! * 127));
    for (let k = 0; k < 3; k++) view.setUint8(o + 16 + k, byte(v.rgb[k]!));
    view.setUint8(o + 19, byte(v.glow));
  },
};

const b = new MeshBuilder(FORMAT);
const red: Paint = { rgb: [0.8, 0.2, 0.1], glow: 0 };
const a = b.vertex([0, 0, 0], [0, 1, 0], red);
const c = b.vertex([1, 0, 0], [0, 1, 0], red);
const d = b.vertex([0, 0, -1], [0, 1, 0], red);
b.tri(a, c, d);
const mesh = b.build();
```

Data that depends on the finished mesh (a direction averaged over all faces meeting at a point, baked occlusion) is
filled afterwards: read `positions()` and `normals()`, compute, and write it into the payloads with `edit` or
`setPayload` before `build`. The format's `write` also gets the vertex number, for a format that keeps such data in an
array of its own.

### Bare shapes

`gen-mesh/bare-shapes.ts` writes plain geometry into a `MeshBuilder<V>` at its current transform. None of these shapes
carries a look: no colour, no seams, no bevels, no irregularity. For every vertex they call the caller's payload
function with its geometric facts, a `ShapeVertex` (one object reused for the whole call: read it, do not keep it):

| Field | Meaning |
| --- | --- |
| `p`, `n` | Position and unit normal in the shape's own frame (before the builder's transform). |
| `part` | `'side'`, `'start'` / `'end'` for the caps, `'cut'` for the two meridian planes of a partial revolution (`j` 0 at `from`, 1 at `to`). |
| `i`, `j` | Grid indices: `i` across (around a revolution, along a section or an outline), `j` along (profile point, path point, 0 / 1 at the two ends of an extrusion). On a cap `i` is the rim corner. |
| `u`, `v` | Shares 0–1 matching `i` and `j` (by angle around a revolution, by arc length elsewhere). On a cap `u` runs round the rim, `v` is 1 on the rim and 0 at a fan centre. |
| `face`, `corner` | On flat faces: the face number within the call and the corner 0, 1, 2, … in winding order; −1 on smooth surfaces. |
| `centre` | True for the centre vertex of a fan. |

| Function | Shape |
| --- | --- |
| `revolve(b, profile, payload, { segments?, from?, to?, smooth?, capStart?, capEnd?, capFan?, sides?, warp? })` | A surface of revolution about +y from `[radius, y]` points; a point is `(r sin θ, y, r cos θ)`, θ from +z toward +x. A profile from bottom to top faces outward. Radius 0 is an apex. A partial angle range is open unless `sides` closes its two meridian planes; caps close the profile's ends with discs. |
| `sweep(b, path, section, payload, { closed?, loop?, caps?, capFan?, scale?, twist?, up?, smooth?, subdivide?, warp? })` | A section (`[x, y]` in the frame u–v across the path) pulled along 3D points with rotation-minimising frames (`pathFrames`). `scale` and `twist` vary with the share of the length; `subdivide` first smooths the path (`smoothPath`, centripetal Catmull–Rom through the points); `loop` closes the path into a ring. A clockwise section is turned around, so faces point away from the path. |
| `extrude(b, outline, z0, z1, payload, { capStart?, capEnd?, capFan?, smooth? })` | An outline in the x–y plane pushed along +z; flat side quads with corners (p, z0) (q, z0) (q, z1) (p, z1), or smooth sides. Push a rotation first to extrude another way. |
| `polygon(b, points, payload, { fan?, part?, face? })` | A flat simple polygon: a fan from its first corner when convex, ear clipping when concave, or a fan from an extra centre vertex with `fan`. |
| `gridSurface(b, cols, rows, at, payload, { smooth?, wrapI?, wrapJ?, flip?, u?, v?, normalAt?, part?, faceBase? })` | Any parametric grid of points stitched into quads facing d/di × d/dj; the base of the others. |
| `box(b, min, max, payload)`, `cylinder(b, radius, y0, y1, payload, { radiusTop?, segments?, capStart?, capEnd?, smooth? })` | The two special cases: an extrusion of a rectangle and a revolution of two points. |

`smooth` picks the normals: `true` (shared vertices, normals from the grid), `false` (every cell a flat face of its
own) or `'along'` (`GridSmooth`: flat across, smooth along, a section with hard corners bent along a path). `warp(p, i,
j)` may move every grid point before the normals are taken: that is where a game adds its own irregularity, from its
own seeded stream. All functions return the index of the first vertex they wrote.

A styled shape of a game is a bare shape plus a payload function. Here a game adds panel lines around a body of
revolution (its shader draws a line where a coordinate crosses an integer) and paints its start cap darker:

```ts
import { MeshBuilder, revolve } from 'wallhammer-web/gen-mesh';
import type { ShapeVertex, VertexFormat } from 'wallhammer-web/gen-mesh';

/** This game's payload: panel coordinates and a palette index. */
interface Ink {
  line: readonly [number, number];
  colour: number;
}
declare const INK_FORMAT: VertexFormat<Ink>;

/** The game's styled shape: `ribs` vertical seams and a seam at every listed profile point. */
function seamedBody(b: MeshBuilder<Ink>, profile: readonly (readonly [number, number])[], ribs: number, seams: readonly number[], colour: number): void {
  const along = (j: number): number => seams.filter((s) => s <= j).length - 0.5;
  revolve(b, profile, (s: ShapeVertex): Ink => {
    if (s.part !== 'side') return { line: [0.5, 0.5], colour: colour + 1 };
    return { line: [s.u * ribs, along(s.j)], colour };
  }, { segments: 32, capStart: true });
}

const b = new MeshBuilder(INK_FORMAT);
seamedBody(b, [[1, 0], [1.2, 1], [0.6, 2], [0, 2.4]], 6, [1, 2], 3);
const mesh = b.build();
```

`pnpm check:mesh` (`tools/mesh/check.ts`) checks the core and the shapes without a browser ([Tools](tools.md)).

## Strips along a surface

Narrow, long things that follow a broken line over the ground of a streamed world, on a plane or on a sphere. The
engine does not know what a strip stands for; it gives three parts, each pure (output = input, no seed):

- **The net** (`gen-core`, `stripNet(input)`): lines of points on the base surface (`radiusM` 0 = the plane with up
  +y, else a sphere about the origin), a grade per point (the height of the section's zero above the base surface), a
  half-width, a profile and optional nodes at their ends. A profile is a section (pairs across, up: across in
  half-widths from −1 on the left to 1 on the right, points beyond ±1 are a hem hanging from the edge), a shoulder over
  which the ground returns to its own height, and a bed the ground keeps under the section. The net measures the
  lines, mitres their edges at every point and puts the corners where neighbouring lines of a node meet; it throws on
  input it cannot use.
- **The height function** (`gen-core`, `stripCarve(net, x, y, z, ownHeightM)`): the ground under the lines, cut and
  filled to the section minus the bed, returning to `ownHeightM` over the shoulder. It is continuous everywhere, also
  where lines meet, and returns `ownHeightM` with the same bits where no line reaches. A cell generator passes it its
  ground height; `stripTouches(net, x, y, z, radiusM)` says cheaply when a whole cell can skip it, and
  `stripNearest` gives the line that matters most at a point (to tint or clear the ground there).
- **The mesh** (`gen-mesh`, `stripMesh(net, surface, cell, options)`): the strips of one cell at its level. Every
  segment is cut where it meets the edges of the triangles the cell's level draws (`StripSurface.cuts`), so a section of
  vertices stands at each cut and the strip folds exactly where the ground folds. A vertex stands at
  `max(grade + up(a), drawn surface + liftM(level))`, so it is never under the ground of any level; `a_coarseShift`
  holds the same for the level one coarser, and the vertex shader blends with the surface's own blend factor. Sections
  on a cell border carry the same bits in both cells. `STRIP_GLSL` adds `stripWiden`, which moves the edge vertices
  outward until the strip is at least `minPx` pixels wide: from afar a strip stays a thin unbroken line instead of
  breaking up.

`flatStripSurface` and `sphereStripSurface` describe the surface the cells draw (`cellMorphMesh` on a `FlatWorld`,
`spherePatchMesh` on the sphere of six quadtrees). Give them the same height function as the surface mesh, the carved
one, so the strip and the ground agree.

<!-- check: wrap -->
```ts
import { FlatWorld, flatStripSurface, stripCarve, stripNet, stripTouches, valueNoise2 } from 'wallhammer-web/gen-core';
import type { CellId } from 'wallhammer-web/gen-core';
import { stripMesh } from 'wallhammer-web/gen-mesh';

const shape = new FlatWorld();
const ground = (x: number, z: number): number => 30 * valueNoise2(x, z, 400, 7);
const net = stripNet({
  radiusM: 0,
  profiles: [{ section: [-1.25, -1.2, -1, 0, 0, 0.25, 1, 0, 1.25, -1.2], shoulderM: 14, bedM: 0.3 }],
  nodes: [{ point: [600, 0, 400], heightM: 12 }],
  lines: [
    { points: [0, 0, 0, 300, 0, 150, 600, 0, 400], heights: [10, 11, 12], halfWidths: 8, profile: 0, to: 0 },
    { points: [600, 0, 400, 900, 0, 380], heights: [12, 14], halfWidths: 5, profile: 0, from: 0 },
    { points: [600, 0, 400, 760, 0, 700], heights: [12, 9], halfWidths: 5, profile: 0, from: 0 },
  ],
});
const carved = (x: number, z: number): number => stripCarve(net, x, 0, z, ground(x, z));
const surface = flatStripSurface({ shape, quads: 32, heightAt: carved });
const cell: CellId = shape.cellAt([300, 0, 150], 7);
const o = shape.origin(cell);
const edge = shape.edgeM(cell.level);
if (stripTouches(net, o[0] + edge / 2, 0, o[2] + edge / 2, edge * 0.71)) {
  // The surface mesh of the cell takes `carved` as its height; the strips are a second mesh of the cell.
  const strips = stripMesh(net, surface, cell, { coarsestLevel: 4, liftM: (level) => 0.05 + 0.08 * surface.spacingM(level) });
  if (strips) console.log(strips.mesh.count, strips.lengthM);
}
```

The material of the strips includes `<header>`, then `<noise>` (for `metresPerPixelAt`), the blend code of the surface
and `STRIP_GLSL`, with the attribute locations of `STRIP_ATTRIBS`:

<!-- check: skip -->
```ts
vec3 p = a_pos + u_cellOffset;
p += localUp(p) * (a_coarseShift * spherePatchMorph(p)); // on the plane: u_morphUp and cellMorph(p)
float grow;
p = stripWiden(p, a_side, a_strip, 1.6, grow);
```

Limits: nodes sit at line ends only and are flat at their height; lines do not pass through a corner of the cube and
do not close into loops; there is no spatial index (a linear scan with a bounding test per line). The examples
`planet` (a strip 50 km long over an edge of the cube, forking at its end) and `endless` (`#strip=1`) use all three
parts.

## Instances near the viewer

Small things seen only round the eye (a few per square metre, out to some tens of metres) are made per square of a fixed
fine grid by `nearScatter` (`gen-core/near-scatter.ts`). A square is named by integers, its `key`; every number of a
record is a hash of the seed, that key, the kind and the candidate's index, so a square gives the same bytes in any
order, on any thread, whatever else is made.

- Per kind, `candidates[k]` is rounded up to g², one candidate in each cell of a g × g grid over the square, jittered
  inside its cell. `densityAt(kind, u, v)` keeps a share (a higher density only adds records); `fill` writes a kept
  one: 12 floats (`NEAR_FLOATS`): x y z relative to the anchor of the set, order | width, height, turn, bend | r g b,
  variant. `NEAR_LAYOUT` is the matching instance layout (`i_base`, `i_shape`, `i_color`).
- Within a kind the records are sorted by their order 0–1, highest first. The fade by distance (`NearFade`: `reachM`,
  `band`, `softM`) lets each record leave at `nearLeaveM = gain · reach · (1 − band · (1 − order))`, shrinking over
  `softM`: the lowest order leaves first, so the density thins out toward the reach instead of stopping at a line.
- What can still be seen from a distance is therefore a prefix of the records: `nearCount` finds its length by a
  binary search, and a drawing layer copies only that. `NEAR_FADE_GLSL` is the same fade for a shader.

- `slope` (optional, default none) leaves out a candidate kept by its density where the ground is steeper than
  `maxDeg`: `slopeDegAt(kind, u, v)` gives the slope, usually `nearSlopeDeg(nearPatch(…))`. Every other record keeps
  its bytes.

On a sphere the squares are those of one level of the cube grid (`NearSquareGrid`, `gen-core/near-squares.ts`):
`key(square)`, `centre`, `distanceM(dir, square)` (to the nearest point a square can have, from half its diagonal),
and `near(dir, reachM, out)`, every square a reach round a direction touches, nearest first, across the cube's edges.
`keepStart` (default false) takes the square under the direction even when the warped grid puts its estimate out of
reach. The ground of a square is the caller's lattice of (sub + 1)² points with fields beside it: `nearLatticeValue`
reads a field between the points, `nearPatch` gives the point and outward normal of the ground at (u, v), and
`nearSlopeDeg` its angle to the place's up.

<!-- check: wrap -->
```ts
import { NearSquareGrid, nearLatticeValue, nearPatch, nearScatter, nearSlopeDeg, newNearPatchPoint } from 'wallhammer-web/gen-core';
import type { Vec3 } from 'wallhammer-web/base';
declare const dir: Vec3, seed: number;
declare const pos: Float64Array; // (sub + 1)² lattice points of a square, x y z from the centre
declare const density: Float64Array; // one number per lattice point

const grid = new NearSquareGrid({ level: 13, radiusM: 150_000, halfDiagM: 14.5 });
const sub = 4;
const at = newNearPatchPoint();
for (const square of grid.near(dir, 60, [])) {
  const records = nearScatter({
    seed,
    key: [square.face, square.i, square.j],
    candidates: [400],
    densityAt: (_kind, u, v) => nearLatticeValue(density, sub, 1, 0, u, v),
    slope: { maxDeg: 45, slopeDegAt: (_kind, u, v) => nearSlopeDeg(nearPatch(pos, sub, u, v, at)) },
    fill: (_kind, u, v, roll, out, i) => {
      const p = nearPatch(pos, sub, u, v, at).p;
      out.set([p[0], p[1], p[2], 0, 0.3, 0.5, roll(0) * 6.28, 1, 0.2, 0.5, 0.1, 0], i);
    },
  });
  console.log(grid.key(square), records.start);
}
```

`NearInstanceLayer` of `render` draws such sets ([Instances near the viewer](rendering.md#instances-near-the-viewer)),
and `NearDetailStream` of `runtime` streams them round the eye ([Details streamed round the eye](rendering.md#details-streamed-round-the-eye)).
The system example makes small details round the camera with them (`examples/system/src/details.ts`).

## `gen-tex`: textures

| Export | Output |
| --- | --- |
| `codeTexture(codes, cols, rows)` | An `r8ui` texture of integer class codes. |
| `colorTable(colors, fallback?)` | A 256-entry colour lookup by code. |
| `boxBlur(src, cols, rows, radius)` | A blurred `Float32Array` (CPU only). |
| `quantizeValues(values, min, max, out?)` | Numbers as 16-bit words for the value layers: `min` → 1, `max` → 65535, outside clamped, not finite → `NO_VALUE` (0). `wordValue(word, min, max)` turns a word back (NaN for `NO_VALUE`). |
| `wordTexture(words, width, height)` | Words as a two-byte `rg8` texture read with `texelFetch`. `valueTableSize(count)` is the size of a table texture for `count` rows (rows wrap at `VALUE_TABLE_WIDTH`, 1024). |
| `colorRamp(stops, bands?)` | A colour ramp as a 256 × 1 `rgba8` texture; `bands` > 0 gives that many flat steps. `rampColor(stops, t, bands?)` is the colour at one position (for a legend). `VALUE_RAMPS` holds `viridis`, `heat`, `blues`, `diverging` and `grey`. |
| `new SurfaceRaster(cols, rows, step, base?)`, `lightHorizon(surface, toLight)`, `horizonTexture(horizon, surface)` | The light horizon of a surface, the far term of the renderer's shadow modes ([Rendering](rendering.md#shadow-modes)). The raster holds a height per square cell over the x–z plane, from `base(x, z)` and raised by `raisePolygon(rings, top)` (even-odd, cell centres inside) and `raiseDisc(x, z, radius, top)`. `lightHorizon` sweeps it once, row by row away from the light: a cell's horizon is the higher of surface and horizon one row closer to the light, lowered by what the light gains in height over that step; `-Infinity` where nothing hides the cell. The cost does not depend on the light's height. `horizonTexture` packs it as two bytes per cell (`rg8`, linear) with `baseY` and `rangeM`. |
| `new CodeStamp(region, codes, seed)` | Stamps shapes into a rectangle (`CodeRegion`) of a byte raster of class codes: `polygon(rings, code, salt)` (even-odd, so later rings cut holes) and `disc(x, z, radius, code, salt)`. A cell takes the code with a probability equal to the share of it the shape covers, decided by a hash of seed, cell and salt. Many shapes smaller than a cell therefore keep their total area, and a raster stamped rectangle by rectangle (per tile, in workers) equals one stamped at once. |

## Content module `gen-arch`

Import from `wallhammer-web/gen-arch`. It turns structure recipes into one mesh with walls, roofs, façades, entrances, balconies, cornices and chimneys, and describes the material that draws it.

| Export | Purpose |
| --- | --- |
| `buildBuildingMesh(specs, props, groundAt, dims, options?)` | One `MeshData` (`BUILDING_LAYOUT`) for all specs. Returns `{ mesh, stats, anchored, structures, spans, interiors }`. Options: `describe` (destructible descriptions), `states` (draw in a damage state), `keepOut`, `only`, `interiors`, `byParts`. Without options the output is the plain mesh. |
| `BuildingSpec`, `FacadeRecipe`, `EntranceSpec`, `WindowRecipe`, … | The recipe the project fills in. Colours are palette rows. |
| `ArchDims` (`ArchMeshDims` and `ArchShadeDims`) | Sizes the generator and the shader take from the project. `fieldRoofMaxTriangles` (optional) is a triangle budget per `field` roof, see below. |
| `structureMaterial(dims, { damage? })`, `structureUniforms(rows)` | The `MaterialDesc` and its uniforms. The damage look is a separate program, so intact structures do not pay for it. |
| `BUILDING_VS`, `buildingFs(dims)`, `BUILDING_ATTRIBS` | Shader sources and attribute locations, for your own material. |
| `buildRubbleMesh`, `rubbleColours` | Rubble from the footprints that the destruction model returns. |
| `fallPieces`, `FALL_LAYOUT`, `FALL_ATTRIBS`, `fallingMaterial` | Falling pieces of one event, for `TransientLayer`. |
| `PART_RULE`, `*Key` functions, `describeKey` | Stable part keys of the destructible description. |
| `INTERIOR_DIM`, `ROOM_TYPE`, `cellAt`, `roomAt` | Interior plans, drawn only for damaged structures. |
| `STRUCTURE_MATERIAL(S)`, `DESTRUCT_DIM` | Destructible materials and description sizes. |
| `windowLightSlot`, `windowShare`, `DEFAULT_WINDOWS` | Environment slot for lit windows at night, in the free lanes `u_time.zw`. |

**Cost of `field` roofs.** A `field` roof (an irregular pitched roof: a plane rises from every footprint edge) is refined in rounds that halve every edge longer than 1.5 m. Without a budget a large or ragged footprint becomes very expensive: one hall of a test town came out at 396 000 triangles. With `dims.fieldRoofMaxTriangles` a round that would leave more triangles than the budget is not taken, so large roofs stop at coarser edges. Roofs that stay under the budget come out exactly as without one. The cuts where planes meet are added after the refinement, so the final roof may exceed the budget by a few per cent. The default is no budget, so existing output does not change. A whole town with 537 field roofs used a budget of 1000.

The colour shader uses `#include <snow>`. Register a slot named `snow`, for example `snowSlot()` from `gen-ground`.

### Compositions

A building made of several masses (a long body, a tall part beside it, a small part on its roof) is several ordinary `BuildingSpec`s that share a `group` number. Each part keeps its own footprint, heights, roof and façade recipe, so damage, descriptions, interiors, the massing mesh and the project's index rules treat it like any other structure. Members of a group ignore each other only in the shared-wall test (a wall toward a member keeps its windows); entrances still avoid a member, so a door never opens into a part. A part standing on another part's roof sets `groundMin = groundRef` to the height of its foot.

Roof kinds for compositions:

| Kind | Shape |
| --- | --- |
| `apex` | Every outline edge rises to one apex above the box centre (pyramid; a tall top gives a pointed roof). |
| `dome` | The same radial roof with the `ROOF_PROFILE.dome` height profile. |
| `mansard` | A hipped ridge roof with the `ROOF_PROFILE.mansard` profile (steep low, flat high). |

`BuildingSpec.roofProfile` (a `RoofProfile`: pairs of run share and height share from `[0, 0]` to `[1, 1]`) replaces the profile of `apex`, `dome` and `mansard`, and bends a `gable` or `hip` roof; a spec without it gives the bytes it gave before. `WindowRecipe.arch` rounds the head of a window; the entrance kind `arch` is a round-headed opening whose height is `FACADE_DIM.archHeightPerWidth` times its width.

Known limits:
- A part on a roof stands on its own foundation: the engine does not carry it on the roof under it. It falls only when the project's rule says so (for example when its owner is down), not when the roof under it is breached.
- A part on a neighbouring building is carried by the group it was given, not by the building it stands on.
- Coplanar walls of two members may flicker where their faces coincide.
- `apex` and `dome` need one convex outline with its box centre inside; any other footprint falls back to a flat roof and counts in `stats.roofFallbacks`.
- Bit 7 of the second `a_win` byte (arched window) and door kinds 4–7 were the last free bits of the vertex: a further opening shape needs a layout change.

`BuildingSpec.raised` marks a member that stands on other members of its group: the footprint tests of entrances, steps, balconies and bands of the other members ignore it, so a storey that stands out over the one under it does not take away the doors and the band below. `CorniceRecipe.underside` closes a band with a bottom face (two triangles per band), so the overhang reads from below. Both are off by default and give the bytes they gave before.

### Finishes and frames

Finishes are a code in the six free bits of the vertex byte `a_mat.z` (byte 50), drawn by the fragment program; the vertex layout is unchanged. Bits 0–1 hold the window style as before, bits 2–3 the wall finish, bits 4–5 the roof cover, bit 6 shutters. A spec that sets none of them writes the byte it wrote before.

| `WALL_FINISH` | Wall |
| --- | --- |
| `render` (0) | Plain, as before. |
| `frame` | Dark timber posts about every 1.2 m, rails at the storey lines, a diagonal brace in some fields. |
| `stone` | Courses of 0.3 m, stones about 0.55 m long with staggered joints. |
| `boards` | Upright boards of 0.18 m with dark joints. |

| `ROOF_COVER` | Pitched roof |
| --- | --- |
| `courses` (0) | As before. |
| `thatch` | Soft courses of 0.5 m, streaks down the fall line, a darker ragged eave. |
| `slate` | Small dark tiles in staggered rows. |
| `shingle` | Wooden shingles in staggered rows. |

`WindowRecipe.shutters` gives each window two leaves in the façade's accent colour. The finishes are drawn only by the shader variant `finishes: true` (`structureMaterial`, `fallingMaterial`, `buildingFs`); the default material ignores the new bits and compiles the text it compiled before.

`framed: true` draws a mesh in a frame of its own: the vertex stage multiplies by the uniform `u_frame` (the frame of the mesh into render space, set per draw), the patterns stay in the mesh's own coordinates and up is the frame's y axis. A structure is built where the generator expects it (y up, x and z in the plane) and stood on a curved body by its matrix, not by turning its vertices. Lighting, snow and fog follow the local up (`WH_LOCAL_UP`) as for any other material.

`lineRing(points, halfWidth)` (`gen-core`) is the ring round a polyline: a wall along a line is an ordinary structure over it, so it gets walls, massing and damage like any other.

Known limits:
- A breached wall along a line shows a hollow shell.
- A raised member is anchored by its own foundation.
- Structures change between the massing and the full mesh without a cross-fade.
- The massing level shows colours only, no finish.

### Distant levels of structures

A structure that covers a few pixels does not need its full mesh. `gen-arch` has two coarser levels, both made per tile:

| Level | Export | What it gives |
| --- | --- | --- |
| Middle | `buildMassingMesh(specs, dims, { only?, origin? })` | One indexed mesh (`MASSING_LAYOUT`, 28 bytes per vertex) with a prism per structure: walls from below the ground to the roof, the top flat (the roof surface of a flat roof, halfway up a pitched one), holes of the footprint kept. About 3 triangles per footprint point. Returns `{ mesh, spans, minY, maxY, structures }`. With `origin` the positions are relative to that point (a tile origin); draw with `u_cellOffset` = origin − render origin. |
| Middle | `massingMaterial(dims)` | The material: light, shadow, fog, wetness and snow as the full one, and the means of what the full shader draws (wall tint with the glazed share, mean glow of lit windows, roof covering). Uniforms `u_rows` (`structureUniforms`), `u_fade`, `u_cellOffset`. |
| Far | `stampFootprints(stamp, specs, codeOf, only?)` | Nothing to draw: the footprints go into a ground class raster through a `CodeStamp` (`gen-tex`), each with the class code `codeOf` gives it, and the ground bake paints them like any other class. |
| Far | `roofTones(color, albedoScale?)` | Three tones of a roof covering for such a class (the span of the per-structure tint of the full shader). |

The vertices of a structure are consecutive in the massing mesh (`spans`), and a structure built alone has exactly the bytes of its span. Hide one by writing zeros over its span, show it again by writing the bytes of `buildMassingMesh([spec], dims)`.

```ts
import { buildMassingMesh, massingMaterial, roofTones, stampFootprints } from 'wallhammer-web/gen-arch';
import type { ArchDims, BuildingSpec } from 'wallhammer-web/gen-arch';
import { CodeStamp } from 'wallhammer-web/gen-tex';

declare const specs: BuildingSpec[]; // the structures of one tile
declare const dims: ArchDims;
declare const tileOrigin: [number, number, number];
declare const tileCodes: Uint8Array; // the tile's part of the ground class raster: 64 × 64 cells of 5 m

// Middle level: one mesh for the tile, positions relative to the tile origin.
const massing = buildMassingMesh(specs, dims, { origin: tileOrigin });
const material = massingMaterial(dims);

// Far level: the footprints as class 40 in the tile's rectangle of the raster, and the look of that class.
const stamp = new CodeStamp({ col0: 128, row0: 64, cols: 64, rows: 64, step: 5 }, tileCodes, 1234);
const stamped = stampFootprints(stamp, specs, () => 40);
const look = { colors: roofTones([0.5, 0.3, 0.24], 0.84), patchM: 14, grain: 0.25 };
```

Which level is drawn, and the transition between two of them, is `LevelFade` with the screen-door fade: [Levels of detail with a fade](rendering.md#levels-of-detail-with-a-fade). The massing material already contains the fade; wrap the full structure material with `withFade`. The full material casts its shadow with the plain depth program, so its shadow does not thin out during a transition; the massing shadow does.

[Destruction](destruction.md) covers descriptions, damage and falling pieces.

Known weaknesses (from the project's own status notes): interiors divide every storey the same way; rooms are empty and dark by day; narrow rooms appear in irregular footprints.

## Content module `gen-ground`

Import from `wallhammer-web/gen-ground`. Ground and markings.

| Export | Purpose |
| --- | --- |
| `groundBake`, `buildOcclusionMask` | A `BakeDesc` that bakes ground colour and surface kind from a class raster; `renderer.bake` runs it. |
| `buildGroundMarkings` | Painted strips draped on the terrain. |
| `TERRAIN_MATERIAL`, `MARKING_MATERIAL`, `groundUniforms` | Materials and their uniforms. |
| `seasonSlot`, `seasonAt` | Environment slot: season in `u_season` (also a shadow key), read by the terrain and the vegetation shader. |
| `snowSlot` | Environment slot: the `snow` include. See [Seasons and snow](environment.md#seasons-and-snow). |
| `TERRAIN_VS/FS`, `MARKING_VS/FS` | Shader sources. |

The module holds no colour names and no project sizes.

## Content module `gen-vegetation`

Import from `wallhammer-web/gen-vegetation`. Vegetation and its placement.

| Export | Purpose |
| --- | --- |
| `plantTrees` | Deterministic placement from a canopy raster and placement rules. |
| `buildTreeBatches`, `buildTreeBatch`, `packTreeInstances`, `treeBatchUniforms` | Instanced vegetation with levels of detail, for `InstancedLayer`. |
| `VEGETATION_MATERIAL`, `vegetationUniforms`, `vegetationSieve` | Material and its uniforms. |
| `swaySlot`, `maxSway` | Environment slot: sway in `u_wind.zw`. |
| `TREE_VS/FS`, `DEPTH_TREE_VS/FS` | Shader sources. |

The vegetation shader reads the season slot and includes `<snow>`, both from `gen-ground`: register `seasonSlot`, `snowSlot` (from `gen-ground`) and `swaySlot` together. The module holds no colour names and no project sizes.

## `gen-plan`: the plan of a sphere

Import from `wallhammer-web/gen-plan`. A coarse plan over a whole sphere, made once before any cell is generated, so that a cell can ask what passes through it without knowing its neighbours. The module names nothing; the code that uses it gives the lines and hollows their meaning.

- **Grid.** `sphereGrid(radiusM, level)` is one node at the middle of every cell of one level of the cube sphere (`6 · 4^level` nodes, node = `face · n² + y · n + x`). `gridNeighbours` gives the up to eight neighbours, across the seams of the faces too (a corner of the cube has seven). `gridNodeAt` finds the node of a direction, `gridDirection` the direction of a node, `gridNodeArea` its area in m², and `gridSample` reads a field of one value per node bilinearly at any direction. `gridWeights` gives the nodes and weights behind that read (three at a corner of the cube, else four, summing to 1), so a caller can blend a share of its own, for example the part of a point that belongs to one region of nodes; the sum of weight times value in their order is `gridSample` bit for bit.
- **Drainage.** `drainGrid(grid, heights, options)` fills every hollow to its sill (a priority flood from the base nodes, the nodes at or under `baseLevel`) and returns per node the filled height, the node it drains to, an order in which every node comes before the one it drains to, the gathered flow and the pool it lies in. A filled hollow counts as a pool from `minPoolNodes` nodes and `minPoolDepth` depth on. `traceChannels(grid, drainage, { minFlow })` cuts the nodes with enough flow into chains; each ends in a base node, a pool or another chain. It reads only the node count of the grid and `to`, `flow`, `pool` and `order` of the drainage, so a drainage made elsewhere (over a plane grid, say) is traced the same way.
- **Channel classes.** `channelOrder(channels)` gives the Strahler order of every channel: 1 where nothing runs in, otherwise the highest order running in, plus 1 when two or more share it. `channelFlow(channels, flow)` copies the gathered flow to every entry of the chains (`along`) and gives per channel the flow it hands on (`out`: its last own node, the one before the node it shares with what it runs into). `classifyByThresholds(values, thresholds)` turns any values into classes: how many of the ascending thresholds each value reaches. Trace once from the smallest threshold of interest and classify the channels by `out`, or by order; the caller gives each class its meaning (its width, its profile, how it is drawn).
- **Lines.** `smoothLine(points, rounds)` smooths a line of unit directions and keeps its ends; `fallingGrade(heights, minDrop)` makes a profile that never rises along it.
- **Index.** `lineTiles({ level, radiusM, start, points, reachM })` lists per tile (a cell of `level`) every line that comes within its reach of it. `tileLinesAt` reads the lines of the tile at a direction, `tileLinesOfCell` those of any cell, finer or coarser than the tiles. A tile may list a line that does not reach it; it never misses one that does.

The results are typed arrays only, so a plan can go into a worker or a file as it is. The same inputs give the same bits.

```ts
import { channelFlow, channelOrder, classifyByThresholds, drainGrid, gridDirection, lineTiles, smoothLine, sphereGrid, tileLinesAt, traceChannels } from 'wallhammer-web/gen-plan';

const grid = sphereGrid(1_000_000, 5);
const heights = new Float32Array(grid.count);
for (let i = 0; i < grid.count; i++) {
  const [x, y, z] = gridDirection(grid, i);
  heights[i] = 400 * Math.sin(5 * x) * Math.cos(4 * y) + 300 * z;
}
const drainage = drainGrid(grid, heights, { baseLevel: 0, minPoolNodes: 4, minPoolDepth: 5 });
const channels = traceChannels(grid, drainage, { minFlow: 30 });
// Classes by the flow each channel hands on: 0 below 100, 1 from 100, 2 from 400. And the order of each.
const classes = classifyByThresholds(channelFlow(channels, drainage.flow).out, [100, 400]);
const order = channelOrder(channels);

// One line per channel: the directions of its nodes, smoothed.
const start = new Uint32Array(channels.start.length);
const parts: Float64Array[] = [];
for (let c = 0; c + 1 < channels.start.length; c++) {
  const from = channels.start[c]!;
  const to = channels.start[c + 1]!;
  const raw = new Float64Array(3 * (to - from));
  for (let k = from; k < to; k++) raw.set(gridDirection(grid, channels.nodes[k]!), 3 * (k - from));
  parts.push(smoothLine(raw, 4));
  start[c + 1] = start[c]! + (to - from);
}
const points = new Float64Array(3 * start[start.length - 1]!);
parts.forEach((p, c) => points.set(p, 3 * start[c]!));
const reachM = new Float64Array(parts.length).fill(2_000);
const tiles = lineTiles({ level: 4, radiusM: grid.radiusM, start, points, reachM });
const here = tileLinesAt(tiles, 0, 0, 1); // { from, to } in tiles.lines, or null
```

Choosing places and dividing them:

- **Steps and slope.** `gridSteps(grid, marks, maxSteps)` gives per node the steps over the eight neighbours to the nearest marked node, capped at `maxSteps` (at most 255). `gridSlopeAt(grid, heights, unitM, node)` is the steepest rise from a node to a neighbour, per metre of chord.
- **Picking.** `pickSites(grid, score, { count, spacingM, minScore, taken, accept })` takes nodes from the highest score down (ties: the lower node), skips any nearer than `spacingM` in a straight line to one already picked or `taken`, and asks `accept` only for a node that passed that; it stops at `count` or below `minScore`. The result is in the order of the picks.
- **Plots.** `plotsAlong(lines, { frontM, depthM, setbackM, gapM, seed, blocked })` walks both sides of each line (x z pairs in a plane, metres) and puts rectangles squared to it, `setbackM` from every line, `gapM` apart, sizes from the seed. `blocked(x, z)` refuses a plot whose middle or a corner it holds. Each plot carries its middle, the unit vector toward its line, its size and the line.

```ts
import { gridSlopeAt, gridSteps, pickSites, plotsAlong, sphereGrid } from 'wallhammer-web/gen-plan';

const g = sphereGrid(1_000_000, 4);
const heights = new Float32Array(g.count).map((_, i) => (i * 37) % 500);
const low = Uint8Array.from(heights, (h) => (h < 50 ? 1 : 0));
const steps = gridSteps(g, low, 6);
const score = Float32Array.from(heights, (h, i) => (h < 50 ? 0 : (1 / (1 + steps[i]!)) * (1 - Math.min(1, gridSlopeAt(g, heights, 1, i)))));
const picked = pickSites(g, score, { count: 10, spacingM: 50_000, minScore: 0.05, accept: (node) => heights[node]! < 400 });

const plots = plotsAlong([[0, 0, 200, 0, 200, 150]], { frontM: [12, 20], depthM: [20, 30], setbackM: 4, gapM: 1, seed: 7, blocked: (x, z) => x * x + z * z < 400 });
```

Joining places by ways:

- **Least cost.** A `StepCost` `(a, b) => number` prices the step from a node to its neighbour: finite and above 0, or `Infinity` for a closed step. `routeGrid(grid, { from, to, cost, maxNodes, scratch })` returns the nodes of the cheapest chain of steps, both ends included, or null when `to` cannot be reached or `maxNodes` nodes were settled first. It has no estimate of the rest of the way, so it is exact for any cost; `routeScratch(grid)` makes arrays it reuses between calls (a stamp per call, no clearing). Ties go by cost, then source, then node index, neighbours in the order of `gridNeighbours`; a predecessor changes only for a strictly lower cost.
- **Regions.** `routeRegions(grid, { sources, cost, maxNodes })` is one search from many nodes at once: per node the index of the source that reaches it most cheaply (`owner`, −1 none), that cost and the node it came from (`prev`, −1 at a source). `regionLinks(grid, regions, cost)` gives per pair of sources whose regions touch (a < b, sorted) the cheapest step between them, `regions.cost[nodeA] + cost(nodeA, nodeB) + regions.cost[nodeB]`: which places are near each other by the cost of getting there, from one pass.
- **Along a line.** `lineLengths(points, radiusM)` gives the metres along great arcs up to each point of a line of unit directions; `lineAt(points, lengths, alongM, out)` the direction and the unit heading there; `limitGrade(lengths, heights, maxGrade)` changes a profile as little as the rule allows so that no step is steeper than `maxGrade`, keeping both ends (a profile within the limit comes back unchanged; ends that break it give the straight ramp between them).

```ts
import { gridDirection, limitGrade, lineAt, lineLengths, regionLinks, routeGrid, routeRegions, routeScratch, sphereGrid } from 'wallhammer-web/gen-plan';
import type { Vec3 } from 'wallhammer-web/base';

const g = sphereGrid(1_000_000, 4);
const h = new Float32Array(g.count).map((_, i) => (i * 53) % 300);
const pos: Vec3 = [0, 0, 0];
const at: Vec3 = [0, 0, 0];
const cost = (a: number, b: number): number => {
  gridDirection(g, a, pos);
  gridDirection(g, b, at);
  const m = Math.hypot(at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]) * g.radiusM;
  const slope = Math.abs(h[b]! - h[a]!) / m;
  return slope > 0.3 ? Infinity : m * (1 + slope * 10);
};
const way = routeGrid(g, { from: 10, to: 900, cost, maxNodes: g.count, scratch: routeScratch(g) });
const regions = routeRegions(g, { sources: [10, 900, 5000], cost, maxNodes: g.count });
const links = regionLinks(g, regions, cost); // links.a[i], links.b[i], links.cost[i]

if (way) {
  const pts = new Float64Array(3 * way.length);
  way.forEach((n, k) => pts.set(gridDirection(g, n), 3 * k));
  const lengths = lineLengths(pts, g.radiusM);
  const profile = limitGrade(lengths, Array.from(way, (n) => h[n]!), 0.1);
  const out = { dir: [0, 0, 0] as Vec3, heading: [0, 0, 0] as Vec3 };
  lineAt(pts, lengths, lengths[lengths.length - 1]! / 2, out);
  console.log(profile.length, out.dir, out.heading);
}
```

- **Skyline.** `gridHorizon(grid, heights, unitM, x, y, z, options, out)` writes the sine of the skyline's elevation, seen from the field's own height at a direction, toward each of the four `HORIZON_AXES` (a tetrahedron in the grid's axes, laid into the tangent plane there): samples along each direction up to `reachM`, closer near the point, never under 0, heights under `floorM` counted as `floorM`. A code is one byte per direction, `horizonCode(sine)` = `round(255 · sqrt(sine))`. `horizonField(grid, heights, unitM, options)` computes node codes on first use into a table of `slots` entries (65 536 by default; it only saves time), and `horizonCodeAt(field, x, y, z, out)` blends the codes of the nodes round a direction with the weights of `gridSample`, so any caller gets the same four bytes for a point. `horizonLit(code, up, toLight, soft)` turns a code into 0 (hidden) … 1 (lit) for a light far away; `HORIZON_GLSL` is the same function for a shader, with the code read from a normalized u8 attribute. Carry the code to the GPU as the sphere patch's extra channel (`extraAt`, [Streaming](streaming.md)).

```ts
import { horizonCodeAt, horizonField, horizonLit, sphereGrid } from 'wallhammer-web/gen-plan';

const g = sphereGrid(100_000, 6);
const h = new Float32Array(g.count).map((_, i) => (i * 37) % 2000);
const field = horizonField(g, h, 1, { reachM: 20_000, steps: 32, floorM: 0 });
const code = new Uint8Array(4);
horizonCodeAt(field, 0, 0.6, 0.8, code);
const lit = horizonLit(code, [0, 0.6, 0.8], [0.6, 0, 0.8], 0.02);
console.log(code, lit);
```

## Rules for a new generator

1. Output plain data from `base`. No GPU, no DOM.
2. Take a seed and derive randomness with `hashInts` over **input** keys.
3. No `Math.random`, no `Date`, no `performance.now`. Not checked outside `sim`, so review it.
4. Put a generic generator in `gen-mesh` or `gen-tex` (no use-case words). Put a content generator in `gen-arch`, `gen-ground` or `gen-vegetation`. Content of one project (people, vehicles, street furniture) stays in the app.
5. Add a golden recipe ([Tools](tools.md#golden-hashes)).

[Recipes](recipes.md#add-a-generator) has a worked example.
