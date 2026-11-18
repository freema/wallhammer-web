# Reference

Every entry of the package, with its main names, checked against each `src/<module>/index.ts`. Rows starting with "types" list type-only exports. For full signatures, read the doc comments in the source.

## `wallhammer-web` (root)

Re-exports `base`, `platform`, `core`, `gen-core`, `gen-mesh`, `gen-tex`, `gpu`, `camera`, `env`, `world` and `tools`. Not `render`, `sim`, `sim/destruction`, `runtime`, `gen-arch`, `gen-ground`, `gen-vegetation`.

## `wallhammer-web/base` (layer 0)

| Name | One line |
| --- | --- |
| `DEG`, `add`, `clamp`, `cross`, `dot`, `lerp`, `normalize`, `orthoMatrix`, `scale`, `smoothstep` | Small vector and scalar math. |
| `primitiveCount`, `texelBytes` | Sizes derived from mesh and texture data. |
| `DAMAGE`, `PART_FLAG`, `PART_ROLE`, `RUBBLE`, `packEntry`, `entryRung`, `entryDir`, `entryVariant` | Destructible structure constants and the packed damage entry. |
| types `Vec3`, `RGB`, `OrthoFrame` | Math types. |
| `MAT34_FLOATS`, `mat34Identity`, `mat34Copy`, `mat34Translation`, `mat34Scaling`, `mat34RotationX`, `mat34RotationY`, `mat34RotationZ`, `mat34RotationAxis`, `mat34FromQuat`, `mat34Multiply`, `mat34Determinant`, `mat34Invert`, `mat34Point`, `mat34Direction`, `mat34Normal`; types `Mat34`, `Vec3Out` | Affine 3 × 4 matrices, 12 numbers column by column (the instance record layout); `out` last, may alias. See [3 × 4 matrices](concepts.md#3--4-matrices). |
| `boxInVolume`, `distanceToBox` | Box tests shared by culling layers: does an axis-aligned box reach into a cull volume; distance from a point to a box. |
| types `View`, `CullVolume`, `CullBox`, `CullFrustum`, `Ray`, `Box3` | The view contract the renderer reads. |
| `View.axes(out?)`, `View.cornerRays(out?)`, `View.viewProj(…, out?)`; `newOrthoFrame`, `newCornerRays`, `crossInto`, `orthoMatrix(…, out?)`, `depthViewProj(…, out?)` | Optional `out` arguments: a rig may write into the given frame, rays or matrix instead of allocating (always use the returned value). The renderer passes its own scratch, so a still frame allocates nothing there. See [Allocation-free frames](rendering.md#allocation-free-frames). |
| `depthViewProj`, types `DepthMode`, `DepthProjection` | The depth mode of the main passes (`'standard'`, `'reversed'`, `'logarithmic'`) and the world → clip matrix of a view in a mode, with the logarithmic scale. See [Depth modes](rendering.md#depth-modes). |
| `snapRenderOrigin`, `toRenderSpace`, type `OriginAxes` | The render origin for a focus point: the grid point at or below it on the horizontal axes or on all three; a world position relative to an origin, subtracted in doubles. |
| types `MeshData`, `InstanceData`, `InstanceBounds`, `TextureData`, `VertexLayout`, `VertexAttrib`, `ScalarType`, `Primitive`, `TextureFormat`, `TextureSampling` | Plain data between generators and the GPU. |
| type `CullMode`; `DrawState.cull` | Face culling `'none'`, `'back'`, `'front'`; wins over `cullBack` in the same state. See [Materials](rendering.md#materials). |
| types `MaterialDesc`, `PassName`, `ShaderSource`, `DrawState`, `BlendSpec`, `BlendFactor`, `UniformValue`, `Uniforms`, `BakeDesc`, `BakeTarget` | Materials, draw state, uniforms, bakes as data. |
| types `EnvSlot`, `FrameField`, `FrameRegion`, `FrameEnvironment`, `FogLayer`, `LightMode` | The environment slot contract. |
| `RIG_INSTANCE_FLOATS`, `RIG_INSTANCE_LAYOUT`, `RIG_VERTEX_LAYOUT`, `RIG_VERTEX_FLOATS`, `RIG_ATTRIBS`, `RIG_MOTION`, `RIG_BEND_AXIS`, `RIG_FINISH`, `packRgb`, `writeRigInstance`, `rigExtended`; types `RigDesc`, `RigPart`, `RigShape`, `RigMotion`, `RigFinish`, `RigSegment`, `RigInstance` | Rigs as plain data and their instance record. `rigExtended` tells whether a description uses the free gait or chains of links (`bend`). See [Rigs](rigs.md#free-gait-and-chains). |
| `Progress`; types `ProgressStage`, `ProgressReport` | Progress of long work in named, weighted stages (loading a map): workers, uploads and shader compiles advance it, a loading screen subscribes. No DOM, no clock. See [Recipes](recipes.md#report-loading-progress). |
| types `StructureDesc`, `StructurePart`, `StructureBond`, `StructureState`, `ConvexPiece`, `DestructibleMaterial`, `DestructionEvent`, `DamageEntry`, `DamageRung`, `PartRole`, `RubbleFootprint`, `RubbleArchetype` | Destructible descriptions and states. |
| `detSinCosTurns`, `detSinTurns`, `detCosTurns`, `detSinCos`, `detSin`, `detCos`, `detAtan`, `detAtan2`, `detAsin`, `detAcos`, `RAD_PER_TURN` | Reproducible trigonometry: the same bits on every machine, built from `+ − × ÷` and `Math.sqrt` only. Angles in turns or radians. See [Bodies on rails and nested frames](frames.md#reproducible-trigonometry). |
| `FrameSet`, `FRAME_NONE`; types `FramePose`, `FrameState`, `FrameBearing` | A hierarchy of reference frames with 64-bit poses: conversion of points, directions, orientations and velocities between frames, `reparent`, `directionTo`, `fingerprint`. See [Nested frames](frames.md#nested-frames). |
| `relativeMatrix`, `relativePoints` | 64-bit poses and points to 32-bit numbers relative to the eye, for the GPU. |
| `tangentPose`, `directionFromDeg`, `directionToDeg` | A frame that touches a sphere (x east, y up, z south); unit direction from latitude and longitude and back. |
| `quatIdentity`, `quatAxisTurns`, `quatMul`, `quatConj`, `quatNormalize`, `quatRotate`, `quatFromAxes`; type `Quat` | Rotations as unit quaternions `[x, y, z, w]`. |
| `radialUpAt`, `radialHeight`, `upFrame`, `toFramePlane`; types `RadialUp`, `UpFrame` | Up that points away from a centre: the unit up and the height of a point above a base radius; the frame of an upright object for an up (the shortest rotation from +y, the CPU twin of the shader's `localFrame`) and a direction as the (x, z) pair of that frame. See [Local up](rendering.md#local-up). |

## `wallhammer-web/platform` (layer 1)

| Name | One line |
| --- | --- |
| `observeCanvasSize`, `resizeCanvas`, `syncCanvasSize` | Keep a canvas and a view sized to the element. |
| `canvasPixelRatio(max?)`; `observeCanvasSize(…, maxPixelRatio?)`, `syncCanvasSize(…, maxPixelRatio?)`, `resizeCanvas(…, pixelRatio?)` | A cap on the canvas's pixels per CSS pixel (default none): fewer pixels drawn, the browser scales the canvas up; the view's `dpr` is the ratio in effect. See [Resolution and antialiasing](rendering.md#resolution-and-antialiasing). |
| `bindCameraInput` | Pan, zoom, rotation steps and home key for a stepped view. |
| `bindOrbitInput` | Drag orbit and wheel zoom for an orbit view. |
| `bindFreeInput`, `DEFAULT_FREE_KEYS` | Held keys move, drag or locked pointer turns, wheel changes the speed of a free view (`FreeControl`); returns a `FreeInput` to step every frame. |
| `trackHeldKeys` | A live set of held keys (`HeldKeys`). |
| `bindWalkInput`, `DEFAULT_WALK_KEYS`; types `WalkInput`, `WalkInputOptions`, `WalkInputState`, `WalkKeys`, `WalkView` | Walk controls: keys, drag or locked pointer and a standard gamepad give the wanted movement in the view's frame (`read(state)` once per frame), turns and wheel zoom go to the view; `enabled = false` hands the view over (releases keys, drag and pointer lock). See [Walk controls](cameras.md#walk-controls). |
| `HeldKeys.clear()` | Forgets every held key (a hand-over of the controls). |
| `FrameLoop` | The on-demand frame loop with real time. |
| `WorkerPool`, `serveWorker`, `workersAvailable`, `hardwareThreads` | Workers: a pool on the page side, a message handler on the worker side. `WorkerPool.broadcast(message)` sends one copy to every worker ahead of the queued jobs and resolves when all have answered. |
| `fetchBytes` | Fetch a URL as bytes (a `BytesFetcher` for `FileCellProvider`). |
| `openByteStore`; type `ByteStore` | Byte arrays by key in the browser's storage (IndexedDB) that outlive the page: `get`, `put`, `keepOnly(prefix)`, `clear`, `usage`, `close`. Resolves to `null` where the browser gives no storage; reads and writes never reject. See [A cache in the browser's storage](streaming.md#a-cache-in-the-browsers-storage). |
| `watchContextLoss`; type `ContextLossHandlers` | Calls `lost` and `restored` when a canvas loses its graphics context and gets a fresh one (and tells the browser that a restore is wanted). Returns a function that stops. See [Loss of the graphics context](rendering.md#loss-of-the-graphics-context). |
| types `Canvas`, `CanvasSizeTarget`, `CameraInputOptions`, `OrbitInputOptions`, `OrbitControl`, `ViewControl`, `ViewChangeKind`, `FrameLoopOptions`, `LoopClock`, `WorkerJob`, `WorkerAnswer`, `HeldKeys`, `FreeControl`, `FreeInput`, `FreeInputOptions`, `FreeKeys` | |

## `wallhammer-web/core` (layer 2)

| Name | One line |
| --- | --- |
| `Clock` | A playable, steppable time value with a rate and change listeners. |
| `definePalette`, `PALETTE_CAPACITY` | Named colours to a 64-row uniform table with typed keys. |
| `trackPose`, `trackFlightTime`, `trackLifetime`, `writeTrack`, `trackAttribs`, `TRACK_GLSL`, `TRACK_FLOATS`, `TRACK_GRAVITY`, `TRACK_CRUMBLE_S`, `TRACK_MAX_FLIGHT_S` | Closed-form ballistic tracks of falling pieces, on the CPU and in GLSL. |
| `prepareOrbit`, `orbitPosition`, `orbitVelocity`, `solveKepler`, `ORBIT_SOLVER_STEPS`, `ORBIT_MAX_ECCENTRICITY` | A Kepler ellipse as a pure function of time, solved with a fixed number of steps. See [Orbits and spin from time](frames.md#orbits-and-spin-from-time). |
| `prepareSpin`, `spinRotation`, `spinRate` | Turning about a fixed, tilted axis as a pure function of time. |
| `BodySystem`, `BODY_INFLUENCE_RADII` | Bodies on rails placed in a `FrameSet`: `setTime`, `setTick`, `dominantBody`, `subPoint`, `fingerprint`. See [A system of bodies](frames.md#a-system-of-bodies). |
| types `ClockOptions`, `Palette`, `BallisticTrack`, `DustPuff`, `TrackPose` | |
| types `OrbitElements`, `Orbit`, `SpinElements`, `Spin`, `BodyDef`, `Body`, `SubPoint` | |
| `LevelFade`; type `LevelFadeOptions` | A level of detail chosen from one scalar with a dead band around every threshold and a timed transition: `update`, `position`, `moving`, `limit`, `shown`, `fade`, `uniforms`, `snap`. No clock inside. See [Levels of detail with a fade](rendering.md#levels-of-detail-with-a-fade). |
| `FADE_GLSL`, `fadeFragment`, `withFade` | The screen-door fade that draws a transition: the GLSL (`u_fade`, `fadeHidden`), a fragment shader with it added, a `MaterialDesc` with it in every pass that has its own program. |
| `COVER_FADE_GLSL`, `coverFade`, `coverKeep` | Content drawn as objects near the viewer and carried by the surface colour farther away: the share of the far look for a cell (`coverFade(objectLevel, cellLevel, morph)`) and the size of one object at that share (`coverKeep(fade, order)`), as functions and as GLSL of the same names. See [Content beyond its levels](streaming.md#content-beyond-its-levels). |

## `wallhammer-web/gen-core` (layer 2)

| Name | One line |
| --- | --- |
| `hashInt`, `hashInts`, `hashString`, `mix32`, `unit`, `rand`, `randRange`, `pickWeighted`, `streamSeed` | Stateless randomness with named streams. |
| `valueNoise2` | 2D value noise. |
| `distToSegment`, `insetRing`, `lineRing`, `orientedBox`, `pointInRings`, `ringSignedArea`, `ringsArea` | Planar polygon geometry; `lineRing` is the ring round a polyline at a half-width (null when a segment is shorter than the half-width or a mitre exceeds 3×). |
| `HeightField`, `SegmentField`, `OutlineField`, `Occupancy` | Spatial fields that generators query. |
| `splitInstanceCells`, `DEFAULT_INSTANCE_TIERS` | Instances sorted into square ground cells, with thinned tiers for distance. |
| `FACE_FLAT`, `FLAT_ROOT_EDGE_M`, `FlatWorld`, `LEVEL`, `cellId`, `cellKey`, `parseCellKey`, `cellBits`, `cellFromBits`, `compareCells`, `sameCell`, `cellContentBytes` | Cell ids and the flat world shape for streaming. |
| `shapeHash` | A world shape's `hashKey` as a 32-bit number for cell files and their paths. |
| types `Ring`, `OrientedBox`, `InstanceCell`, `InstanceCellOptions`, `InstanceTier`, `CellId`, `CellContent`, `CellMesh`, `CellInstances`, `LocalBounds`, `WorldPos`, `WorldShape` | |
| `valueNoise3`, `fractalNoise3`; type `FractalNoise3` | Value noise in space and a sum of its octaves, 0..1: no seam and no pole on a curved surface. |
| `CUBE_FACE_AXES`, `cubeGrid`, `cubeWarp`, `cubeUnwarp`, `cubeDirection`, `cubeDirectionWarped`, `cubeFaceOf`, `cubeFaceCoords`, `cubeNeighbour`, `directionTangents` | A cube blown up to a sphere: the six faces and their axes, grid index to face coordinate, the even-angle spacing, direction of a grid point and back, the neighbouring cell across an edge of the cube, two directions across a direction that depend on it alone. |
| `spherePatchMesh`, `spherePatchRadius`, `SPHERE_PATCH_LAYOUT`, `SPHERE_PATCH_ATTRIBS`, `SPHERE_PATCH_GLSL`; types `SpherePatch`, `SpherePatchOptions` | The surface mesh of one cell of a sphere of six quadtrees, with blend attributes toward the coarser level and a skirt; where a direction meets its triangles; the vertex layout and the GLSL of the blend factor (`spherePatchMorph`). See [A sphere world](streaming.md#a-sphere-world). |
| `stripNet`, `stripLength`, `stripNearest`, `stripCarve`, `stripTouches`, `stripUp`, `STRIP_STATION_FLOATS`; types `StripProfile`, `StripNode`, `StripLine`, `StripInput`, `StripNet`, `StripNetLine`, `StripHit` | Strips along broken lines on a plane or a sphere: the net (measured, mitred, node corners), the nearest line at a point, the ground height cut and filled under the lines, a cheap test whether a line reaches a cell. See [Strips along a surface](generators.md#strips-along-a-surface). |
| `flatStripSurface`, `sphereStripSurface`; type `StripSurface` | What the strip mesher needs from the surface the cells draw: the cell of a level at a point, its origin, the vertex spacing, where a straight way meets the edges of the cell's triangles, the height of the drawn triangles. |
| `SpherePatchOptions.coverAt`, `SPHERE_PATCH_COVER_LAYOUT`, `SPHERE_PATCH_COVER_ATTRIBS` | The baked cover of a sphere patch (off by default): `coverAt(x, y, z, height)` returns RGBA bytes, rgb what the content on the surface looks like from afar and a the share of the surface it hides. The mesh then uses the cover layout: the plain one plus `a_cover` and `a_coarseCover` (locations 6 and 7). Without `coverAt` the bytes are unchanged. |
| `SpherePatchOptions.extraAt`, `SPHERE_PATCH_EXTRA_LAYOUT`, `SPHERE_PATCH_EXTRA_ATTRIBS`, `SPHERE_PATCH_COVER_EXTRA_LAYOUT`, `SPHERE_PATCH_COVER_EXTRA_ATTRIBS` | Four more bytes per vertex of a sphere patch (off by default) that the content gives a meaning, `extraAt(x, y, z, height)`: `a_extra` and `a_coarseExtra` (the level one coarser), after the plain attributes (locations 6 and 7, stride 48) or after the cover (8 and 9, stride 56). Without `extraAt` the bytes are unchanged. |
| `nearScatter`, `nearKeep`, `nearLeaveM`, `nearCount`, `NEAR_FLOATS`, `NEAR_LAYOUT`, `NEAR_FADE_GLSL`; types `NearScatterOptions`, `NearRecords`, `NearFade` | Small instances per square of a fixed fine grid: records hashed from the seed, the square's key, the kind and the candidate alone, a density callback that keeps a share, sorted by an order so the fade by distance removes the lowest first and what can be seen is a prefix (`nearCount`); the fade in TypeScript and GLSL. See [Instances near the viewer](generators.md#instances-near-the-viewer). |

## `wallhammer-web/motion` (layer 2)

Not re-exported from the root entry. See [Motion](motion.md).

| Name | One line |
| --- | --- |
| `Skeleton`, `Pose`, `boneMask`; types `BoneSpec`, `BoneMask`, `BoneMaskOptions` | Bones with a parent and a joint offset; per bone a rotation (quaternion x, y, z, w) and an offset; a weight per bone (named bones with their descendants by default). |
| `blendPose`, `addPose`, `subtractPose`, `nlerpInto` | Blend two poses (shortest arc, optional mask), add a pose in the bones' frames by a weight, the difference that `addPose` turns back, quaternion blend into an array. |
| `setBoneRotation`, `setBoneAxisAngle`, `setBoneEuler`; type `EulerOrder` | Writing a bone's rotation in a source. |
| `solvePose`, `solvePoseBelow` | World matrices, 3 × 4 column by column, 12 floats per bone, from a root matrix; again for one bone and its descendants. |
| `MotionGraph`, `MotionGraphDef`, `compileMotionGraph`; types `MotionSource`, `MotionGraphDesc`, `MotionLayerDesc`, `MotionStateDesc`, `MotionTransitionDesc`, `MotionCondition`, `MotionEase`, `MotionEventKind` | States, transitions (conditions, triggers, after a pass; fades without a jump), override and additive layers with masks and weights, phase from time, a rate or a driving parameter, sync groups, events at marks and on entering and leaving, `setState` (straight into a state part-way, no fade), `save`/`restore`. One compiled description shared by every figure. |
| `speedWeights` | Weights of motions by their speed ranges [min, ideal, max] at a value: continuous, summing to 1. |
| `reachTwoBone`, `fitToGround`; types `TwoBoneChain`, `GroundFitOptions` | Post steps on a solved pose: two bones put the end on a target (bend axis, pole, weight); chain ends moved to the ground height of a function of the game. |

## `wallhammer-web/gen-mesh` (layer 3)

| Name | One line |
| --- | --- |
| `heightFieldMesh`, `HEIGHT_FIELD_LAYOUT`, `HEIGHT_FIELD_ATTRIBS` | A height field as a mesh with a skirt. |
| `lineMesh`, `LINE_LAYOUT` | Lines draped over a height function. |
| `spaceLineMesh`; type `SpaceLinePath` | Polylines through given 3D points (open or closed) as `LINE_LAYOUT` lines. |
| `cellSurfaceMesh`, `CELL_SURFACE_LAYOUT`, `CELL_SURFACE_ATTRIBS` | One streamed cell's surface with vertex colours and a skirt. |
| `cellMorphMesh`, `CELL_MORPH_LAYOUT`, `CELL_MORPH_ATTRIBS`, `CELL_MORPH_GLSL`; types `CellMorphOptions`, `CellMorphSurface` | The cell surface with, per vertex, the shape of the level one coarser, and the GLSL that blends the two by distance. See [Blending between levels](streaming.md#blending-between-levels). |
| `rigMesh`, `rigShadowMesh` | The part mesh of a rig (near or far level) and its contact shadow. |
| `drapeTiles`, `drapeEvery`, `DRAPE_LAYOUT`, `DRAPE_ATTRIBS`; types `DrapeOptions`, `DrapeTile` | A sheet laid on a height field, in tiles with their boxes (positions only); `drapeEvery` picks the thinning that keeps it under a vertex count. See [Value layers](rendering.md#value-layers). |
| `packMesh`, `packFrame`, `packUniform`, `packedLayout`, `packedMaterial`, `PACKED_POSITION`, `PACK_STEPS_PER_EDGE`; types `PackFrame`, `PackOptions`, `PackedMesh` | Compact meshes for streamed cells: positions as 16-bit steps from the cell's corner, loose triangles indexed (per span, so one span can be rewritten alone), and the material that reads them. See [Packed meshes](streaming.md#packed-meshes). |
| `bisectSurface`, `BISECT_SURFACE_LAYOUT`, `BISECT_SURFACE_ATTRIBS`; types `BisectSurfaceOptions`, `BisectSurface` | A square height grid as a packed mesh with as few triangles as an error tolerance allows (right-triangle bisection), with a skirt, cut sides and a clip rectangle. See [A surface within a tolerance](streaming.md#a-surface-within-a-tolerance). |
| `prismMesh`, `triangulateRing`, `PRISM_LAYOUT`, `PRISM_ATTRIBS`; types `PrismShape`, `PrismMeshOptions` | Upright prisms over outlines, each vertex carrying the table row of its prism (`a_ref`); ear clipping of a simple polygon. |
| `stripMesh`, `stripGrow`, `STRIP_LAYOUT`, `STRIP_ATTRIBS`, `STRIP_GLSL`; types `StripMesh`, `StripMeshOptions` | The mesh of the strips in one streamed cell at its level, with the shift to the level one coarser, and the vertex shader rule (`stripWiden`) that keeps a strip a least number of pixels wide; `stripGrow` is the same rule in TypeScript. See [Strips along a surface](generators.md#strips-along-a-surface). |
| `chunkMeshes`; types `ChunkOptions`, `MeshChunk` | Static meshes cut into spatial chunks by triangle centroid and merged per cell, each with its box, for `PieceLayer`. See [Generators](generators.md#gen-mesh-meshes). |
| `MeshBuilder`, `faceNormal`; types `VertexFormat`, `VertexEdit`, `MeshBounds`, `MeshBuildOptions` | Building meshes by hand in a vertex format the caller supplies (payload `V` per vertex, never read by the engine): transform stack with mirroring, `vertex`/`tri`/`quad`/`append`/`bounds`, `positions`/`normals`/`indices` for collisions and checks (`positionData`/`normalData`/`indexData` without a copy, `setTriangle`), `edit` and `setPayload` for data that depends on the finished mesh. See [Building meshes in your own vertex format](generators.md#building-meshes-in-your-own-vertex-format). |
| `revolve`, `sweep`, `extrude`, `polygon`, `gridSurface`, `box`, `cylinder`, `pathFrames`, `smoothPath`; types `ShapeVertex`, `ShapePayload`, `ShapePart`, `ShapeWarp`, `GridSmooth`, `RevolveOptions`, `SweepOptions`, `ExtrudeOptions`, `PolygonOptions`, `GridOptions`, `CylinderOptions`, `PathFrame` | Bare shapes for `MeshBuilder<V>` without any look: each asks the caller for every vertex payload with its geometric facts (`ShapeVertex`); smooth, flat or `'along'` normals; a `warp` hook for the caller's own irregularity. See [Bare shapes](generators.md#bare-shapes). |
| types `LinePath`, `PropBox`, `CellSurface`, `CellSurfaceOptions` | |

## `wallhammer-web/gen-tex` (layer 3)

| Name | One line |
| --- | --- |
| `codeTexture` | Byte codes as an `r8ui` texture. |
| `colorTable` | A 256-entry colour lookup by code. |
| `boxBlur` | Blur a float raster on the CPU. |
| `quantizeValues`, `wordValue`, `NO_VALUE`, `VALUE_WORD_MAX` | Numbers as 16-bit words: `min` → 1, `max` → 65535, not finite → 0 (`NO_VALUE`); and back. |
| `wordTexture`, `valueTableSize`, `VALUE_TABLE_WIDTH` | Words as a two-byte `rg8` texture; the size of the table texture that holds a number of rows (wraps at 1024). |
| `colorRamp`, `rampColor`, `VALUE_RAMPS`; types `RampStop`, `ValueRampName` | A colour ramp as a 256 × 1 texture (smooth or in flat bands), its colour at a position, and five ready-made ramps (`viridis`, `heat`, `blues`, `diverging`, `grey`). |
| `SurfaceRaster`, `lightHorizon`, `horizonTexture`; type `HorizonTexture` | The light horizon of a surface: a raster of surface heights (`raisePolygon`, `raiseDisc` raise it under outlines and discs), per cell the height below which a point is hidden from a directional light (one sweep, `-Infinity` where nothing hides), and that packed as an `rg8` texture with `baseY` and `rangeM` for `Renderer.shadowHorizon`. |
| `CodeStamp`; type `CodeRegion` | Stamps outlines (`polygon`, with holes) and discs (`disc`) into a rectangle of a byte raster of class codes. A cell takes the code with a probability equal to its covered share, so shapes smaller than a cell keep their total area; rectangles stamped one by one equal the raster stamped at once. |

## `wallhammer-web/gen-arch` (layer 3, content)

| Name | One line |
| --- | --- |
| `buildBuildingMesh`, `BUILDING_LAYOUT`, `BUILDING_ATTRIBS`, `WINDOW_STYLE` | Structures from recipes as one mesh; optional descriptions, states, interiors. |
| `WALL_FINISH`, `ROOF_COVER` | Codes of `BuildingSpec.wallFinish` and `BuildingSpec.roofCover`, drawn by the `finishes` shader variant. See [Finishes and frames](generators.md#finishes-and-frames). |
| `FACADE_DIM`, `DOOR_KIND`, `GROUND_FLOOR` | Façade proportions and enumerations (door kind `arch`, `FACADE_DIM.archHeightPerWidth`). |
| `ROOF_PROFILE`; type `RoofProfile` | Height profiles of the `dome` and `mansard` roofs; a spec may give its own (`BuildingSpec.roofProfile`). See [Compositions](generators.md#compositions). |
| `BUILDING_VS`, `buildingVs`, `buildingFs`; type `StructureShaderOptions` | Shader sources of the structure material; `buildingVs(o)` and `buildingFs(dims, damage, o)` with `o.framed` (the mesh in its own frame, uniform `u_frame`) and `o.finishes`. Without options the text of `BUILDING_VS` and of the plain fragment program. |
| `structureMaterial`, `structureUniforms`, `fallingMaterial` | Materials for structures and falling pieces; `structureMaterial(dims, { damage, framed, finishes })` and `fallingMaterial(dims, { framed, finishes })`, each variant with its own name. |
| `windowLightSlot`, `windowShare`, `DEFAULT_WINDOWS` | Environment slot for lit windows. |
| `DESTRUCT_DIM`, `PART_RULE`, `STRUCTURE_MATERIAL`, `STRUCTURE_MATERIALS`, `bayKey`, `canopyKey`, `chimneyKey`, `foundationKey`, `partitionKey`, `roofKey`, `roofTopKey`, `slabKey`, `stairKey`, `describeKey` | Destructible description: part keys, materials, sizes. |
| `INTERIOR_DIM`, `ROOM_TYPE`, `cellAt`, `roomAt` | Interior plans. |
| `buildRubbleMesh`, `rubbleColours` | Rubble meshes. |
| `fallPieces`, `retimeFall`, `FALL_LAYOUT`, `FALL_ATTRIBS` | Falling pieces of one event; `retimeFall` moves a prepared batch later on the clock. |
| `buildMassingMesh`, `massingMaterial`, `MASSING_LAYOUT`, `MASSING_ATTRIBS`; types `MassingMesh`, `MassingOptions` | The middle distant level: every structure as a prism with a flat top, all in one small indexed mesh (per tile, optionally relative to a tile origin), and the material that shades it with the means of the full one. See [Distant levels](generators.md#distant-levels-of-structures). |
| `stampFootprints`, `roofTones` | The far distant level: footprints stamped into a ground class raster (`CodeStamp`) with a class per structure, and the three tones of a roof covering for such a class. |
| types `BuildingSpec`, `BuildingMeshStats`, `PropBox`, `RoofKind`, `StructureOptions`, `FacadeRecipe`, `WindowRecipe`, `EntranceSpec`, `BalconyRecipe`, `CorniceRecipe`, `RoofBoxSpec`, `DoorKind`, `GroundFloorKind`, `ArchDims`, `ArchMeshDims`, `ArchShadeDims`, `StructureRows`, `WindowLight`, `WindowLightState`, `InteriorPlan`, `InteriorCell`, `InteriorRoom`, `InteriorPartition`, `PartitionSeg`, `StairCore`, `FallInput`, `FallOutput`, `FallChange`, `FallEvent` | |

## `wallhammer-web/gen-ground` (layer 3, content)

| Name | One line |
| --- | --- |
| `groundBake`, `buildOcclusionMask` | Ground colour and kind bake from a class raster. |
| `buildGroundMarkings`, `MARKING_LAYOUT`, `MARKING_ATTRIBS` | Painted strips on the terrain. |
| `TERRAIN_MATERIAL`, `MARKING_MATERIAL`, `GROUND_SAMPLERS`, `groundUniforms` | Materials and uniforms. |
| `TERRAIN_VS`, `TERRAIN_FS`, `MARKING_VS`, `MARKING_FS` | Shader sources. |
| `seasonSlot`, `snowSlot`, `seasonAt`, `DEFAULT_PHENOLOGY` | Environment slots: season, snow. |
| types `GroundInput`, `GroundMaterial`, `GroundSurface`, `OcclusionInput`, `OcclusionMask`, `GroundMarking`, `MarkingPattern`, `GroundShading`, `PhenologyConfig`, `SeasonState` | |

## `wallhammer-web/gen-vegetation` (layer 3, content)

| Name | One line |
| --- | --- |
| `plantTrees`, `plantTreesSteps`, `TREE_KINDS`, `TREE_SPECIES`, `TREE_MAX_FLEX` | Deterministic vegetation placement; `plantTreesSteps` is the same as a generator that pauses between pieces, for slicing over tasks. |
| `buildTreeBatches`, `buildTreeBatch`, `packTreeInstances`, `treeBatchUniforms`, `TREE_ATTRIBS`, `TREE_VERTEX_LAYOUT`, `TREE_INSTANCE_LAYOUT`, `TREE_INSTANCE_BOUNDS`, `TREE_INSTANCE_FLOATS`, `TREE_LOD_COUNT` | Instanced vegetation with levels of detail. |
| `VEGETATION_MATERIAL`, `vegetationUniforms`, `vegetationSieve` | Material and uniforms. |
| `TREE_VS`, `TREE_FS`, `DEPTH_TREE_VS`, `DEPTH_TREE_FS` | Shader sources. |
| `swaySlot`, `swayAt`, `maxSway`, `DEFAULT_SWAY` | Environment slot: sway. |
| types `CanopyRaster`, `PlantedTree`, `CrownRule`, `PlantingInput`, `PlantingRules`, `PlantingStats`, `StreetLine`, `TreeKind`, `TreeSpecies`, `TreeBatch`, `TreeMaterial`, `SwayConfig`, `SwayState` | |

## `wallhammer-web/gen-plan` (layer 3)

See [The plan of a sphere](generators.md#gen-plan-the-plan-of-a-sphere).

| Name | One line |
| --- | --- |
| `sphereGrid` | The grid of nodes at the middles of the cells of one cube-sphere level (`SphereGrid`: `radiusM`, `level`, `n`, `count`). |
| `gridNodeAt`, `gridDirection`, `gridNeighbours`, `gridNodeArea`, `gridSample`, `gridWeights` | The node of a direction, the direction of a node, up to eight neighbours across face seams, the area of a node in m², a bilinear read of a field of one value per node, and the nodes and weights of that read (3 at a corner of the cube, else 4; their sum in order is `gridSample` bit for bit). |
| `drainGrid` | Fills the hollows to their sills from the base nodes and returns the drainage (`Drainage`): filled height, the node each drains to, an upstream-first order, gathered flow, pools. |
| `traceChannels` | Chains of nodes with at least a given flow along the drainage (`Channels`), each ending in a base node, a pool or another chain. |
| `smoothLine`, `fallingGrade` | Smooths a line of unit directions keeping its ends; a profile that never rises. |
| `lineTiles`, `tileLinesAt`, `tileLinesOfCell` | An index from the cells of one level to the lines within reach of them (`LineTiles`); the lines of the tile at a direction, the lines of any cell. |
| `gridSteps`, `gridSlopeAt` | Per node the steps over the grid to the nearest marked node (capped); the steepest slope at a node from a field of heights. |
| `pickSites` | Best-first pick of nodes by a score with a least straight distance between them, nodes already taken and a test of the caller (`accept`). |
| `plotsAlong` | Rectangles along both sides of lines in a plane, squared to the line, never overlapping each other or the lines (`Plot`). |
| `routeGrid`, `routeScratch` | The nodes of the least-cost chain of neighbour steps between two nodes under a cost of the caller (null when unreachable or over `maxNodes`); reusable per-node arrays for it. |
| `routeRegions`, `regionLinks` | One search from many sources: per node its cheapest source, the cost and the node it came from (`RouteRegions`); per pair of touching regions the cheapest step between them (`RegionLinks`). |
| `lineLengths`, `lineAt`, `limitGrade` | Metres along great arcs to each point of a line; the direction and heading at a distance along it; a profile changed so that no step is steeper than a limit, ends kept. |
| `HORIZON_AXES`, `gridHorizon`, `horizonCode`, `horizonField`, `horizonCodeAt`, `horizonLit`, `HORIZON_GLSL` | The skyline of a height field: four tetrahedron directions, the sine of the skyline toward each at a point, its byte (`round(255 · sqrt)`), a field of node codes made on demand and blended to any point with the weights of `gridSample`, and how lit a point is by a far light (JS and GLSL, the same formula). |
| types `SphereGrid`, `Drainage`, `DrainOptions`, `Channels`, `LineTiles`, `LineTilesOptions` | |
| types `PickOptions`, `Plot`, `PlotOptions`, `StepCost`, `RouteScratch`, `RouteRegions`, `RegionLinks`, `HorizonField`, `HorizonOptions` | |

## `wallhammer-web/gpu` (layer 4)

| Name | One line |
| --- | --- |
| `Device` | The WebGL2 device: cached state, uniform blocks, depth targets, draws, uploads, bakes. `memory()` totals what it allocated; `shareMesh` draws another mesh's buffers; `flush`; `compiling()` counts programs the driver still compiles in parallel. `setDepthMode(mode)` chooses the depth convention of the main target (returns the mode in effect, `depthMode` reads it); `present()` copies the offscreen main target of the reversed and logarithmic modes to the canvas. `depthTarget(size, repeat?)` makes a depth target (with `repeat` its texture wraps around its edges); `clearDepthRect(x, y, w, h)` clears a rectangle of the bound depth target; `fixSampler(name, unit)` binds a sampler name to one texture unit in every program used from then on. `colorTarget(width, height, count, format)` makes a target of `count` colour textures (`'rgba8'` or `'rgba16f'`, `null` where the format cannot be drawn into) and `fill(target, program, uniforms?)` draws one triangle over all of it, between passes (`Layer.prepare`). |
| `Program` | A program with typed uniform setters (`int`, `float`, `vec3`, …; arrays with `vec3v` and `vec4v`, e.g. a list of point lights as `uniform vec4 u_lights[64]`). Compile and link start at creation; the status is checked on first use (`settle()`), and `isComplete()` asks the driver without blocking (`KHR_parallel_shader_compile`). |
| `Device.retainUploads`, `Device.lost`, `Device.onRestored(fn)`, `Device.contextRestored()`, `Device.loseContext()`, `Device.restoreContext()`; `Program.restore()` | Recovery from a lost graphics context (off by default). With `retainUploads` set before the first upload the device keeps what every mesh, instance buffer, texture and bake was made from; `contextRestored()` makes programs, uniform blocks, depth targets and all of those again in place and then calls the `onRestored` listeners. `lost` is true while there is no context. `loseContext` and `restoreContext` trigger a loss and a restore through `WEBGL_lose_context`, for tests. See [Loss of the graphics context](rendering.md#loss-of-the-graphics-context). |
| `Device.mainSamples()` | Samples per pixel of the main target (the offscreen target's, or the canvas's in the standard depth mode; 0 without antialiasing). For statistics. |
| `createContext`, `rendererName` | Create the WebGL2 context (`createContext(canvas, depthMode)`: for reversed and logarithmic depth the canvas gets no depth buffer of its own); name the GPU. |
| `Device.setMainSamples(samples)`, `createContext(canvas, depthMode, samples?)`, type `MainSamples` | Samples per pixel of the main target, 0, 2 or 4 (default unchanged). In the standard depth mode 0 and 4 keep the canvas (without or with antialiasing), 2 draws offscreen and copies in `present`. See [Resolution and antialiasing](rendering.md#resolution-and-antialiasing). |
| `Device.copyDepth(from, to, size)` | Copies the lower left `size × size` square of one depth target into another of the same size (`blitFramebuffer`); the static shadow map of dynamic casters. |
| `createBuffer`, `createTexture`, `bindAttribs`, `drawMesh`, `UBO_BINDING` | Low-level helpers. `UBO_BINDING` holds the fixed binding points of the shared uniform blocks (`Frame` 0, `Palette` 1, `PointLights` 2), bound in every program that declares them. |
| types `GL`, `Mesh`, `MeshSource`, `Texture`, `TextureOptions`, `GpuBuffer`, `AttribSpec`, `ContextSource`, `InstanceBuffer`, `UniformBlock`, `DepthTarget`, `ColorTarget`, `ColorTargetFormat`, `BakeInput`, `GpuMemory` | |

## `wallhammer-web/render` (layer 5)

| Name | One line |
| --- | --- |
| `Renderer` | Passes, shadow map, layers, materials, the upload path. Options `depth` and `depthNearM` choose the depth mode of the main passes; `depthMode` tells the one in effect; `resolve(src, into)` resolves includes (and adds logarithmic depth to fragment shaders of the main target). |
| `Material` | A compiled `MaterialDesc`. |
| `MeshLayer`, `InstancedLayer`, `cullInstances` | Ready-made layers and instance culling. |
| `PieceLayer`; type `PieceLayerOptions` | Many meshes of one material, each culled by its box against the view and the light, without allocation. Options `order: 'front-to-back'` (sorted when culled) and `lights` (each piece's draw names the point lights that reach its box). |
| `PointLightSet`, `pointLightsGlsl`, `POINT_LIGHTS_BINDING`, `POINT_LIGHTS_PER_DRAW`; types `PointLight`, `PointLightSetOptions` | Point lights as plain records with gain groups; per frame `update(x, y, z)` selects up to `max` for the eye into the `PointLights` uniform block; the include `<point-lights>` gives `pointLights(world, normal, wrap)`; per-draw lists of at most 8 lights (`bindFor`, `bindAll`, `bindNone`; a box more lights reach gets the whole selection, counted in `crowdedDraws`). See [Point lights](rendering.md#point-lights). |
| `ParticleLayer`; types `ParticleSource`, `ParticleCounts`, `ParticleLayerOptions` | Looping particle sources computed in the vertex shader from the clock: fixed budget, two draws (blended, added), shapes `'soft'` and `'core'`, gain groups. See [Particles](rendering.md#particles). |
| `InstanceSetLayer`, `instanceSet`, `writeInstance`, `pushInstance`, `instanceSetAttribs`, `INSTANCE_SET_GLSL`, `INSTANCE_SET_LAYOUT`, `INSTANCE_SET_FLOATS`; types `InstanceSet`, `InstanceSetLayerOptions` | One mesh per set, a 3 × 4 matrix and four free numbers per instance, one instanced draw per set; casts shadows as a dynamic caster (`shadowCasters: 'dynamic'`, `shadowDirty()`). See [Instance sets](rendering.md#instance-sets). |
| `InstanceSetLayer.cull()`; shared sets | Returns the records of the visible sets (counted in `instancesVisible`). One set in several layers of a renderer shares one GPU instance buffer, uploaded once per change; `shadowDirty()` is never true for a layer without a shadow pass. See [Instance sets](rendering.md#instance-sets). |
| `PIXEL_SIZE_GLSL` | `detailVisible`, `metresPerPixelAt`, `detailVisibleAt`, now part of the header (guard `WH_PIXEL_SIZE`); `<noise>` no longer needed for them. See [Shader includes](rendering.md#shader-includes). |
| `InstanceCellLayer`, `cellDetail` | Instances in cells: per-cell culling, level of detail and thinning tier by distance. |
| `TransientLayer`, `DUST_LIFE_S` | Pieces on closed-form tracks and dust puffs. |
| `RigLayer` | Instanced rigs posed in the vertex shader; near, far and hidden by size on screen; `lamps`. Kinds with a free gait or chains get a second program (`rig-ext`), made when the first such kind is added. See [Rigs](rigs.md). |
| `RIG_POSE_GLSL`; type `RigLayerOptions` | The rig posing as a vertex include (`<rig-pose>`: `rigPose`, `rigColor`). `new RigLayer(renderer, { material, castShadow, contactShadows })`: the game's material for the bodies, the posed bodies in the shadow map (default off), the contact shadows (default on). Without options the layer draws as before. See [Rigs](rigs.md#a-material-of-the-game-shadows-into-the-map). |
| `BoneInstances`; type `BonePart` | Bone matrices (`solvePose`) into instance set records: a table bone → set, record and part matrix; `write(world, first)`, `hide()`; no allocation. See [Motion](motion.md#writing-to-instances). |
| `RasterValueLayer`, `PointValueLayer`, `ShapeValueLayer`, `ValueSteps` | Numbers over a scene through a colour ramp: a grid on a sheet over the ground (or cells that name table rows), discs per point, prisms tinted by a table row. Two time steps blended. See [Value layers](rendering.md#value-layers). |
| `RASTER_VALUE_MATERIAL`, `POINT_VALUE_MATERIAL`, `SHAPE_VALUE_MATERIAL`, `POINT_VALUE_ATTRIBS`, `POINT_VALUE_LAYOUT`, `VALUE_GLSL` | The value layers' materials, the disc instance layout (x, y, z, radius) and the GLSL helpers that read value words. |
| `NearInstanceLayer`, `NEAR_INSTANCE_GLSL`; types `NearInstanceLayerOptions`, `NearKindDraw`, `NearPart`, `NearWind` | Records of `nearScatter` round the eye: one instance buffer per kind with a hard ceiling, refilled nearest set first when the eye has moved `stepM`, the exact fade per instance in the vertex shader, a bend in the wind along two waves fixed to the world. The vertex include gives `nearBase`, `nearScale`, `nearAxes`, `nearPoint`; the app's material lights it. See [Instances near the viewer](rendering.md#instances-near-the-viewer). |
| `NOISE`, `shaderHeader`, `frameBlockFloats` | Built-in GLSL and the Frame block size. `shaderHeader(slots, depthMode)` also defines `WH_DEPTH_REVERSED` or `WH_DEPTH_LOGARITHMIC`. |
| `DEPTH_VS`, `DEPTH_FS`, `SHADOW_MAP_UNIT` | Shared shadow programs; texture unit 0. |
| types `ShadowMode`, `ShadowOptions` | `RendererOptions.shadows`: the layout of the shadow map, `'single'` (default, as without the option), `'snapped'` (one map fixed to the world's texel grid, kept between frames, a pan draws only the uncovered border) or `'cascades'` (2–4 maps around the eye); `reachM`, `cascades`, `firstReachM`. `Renderer.shadowMode` tells the mode; `FrameStats.shadowUpdates` counts the parts of the map drawn in a frame (0: kept). See [Shadow modes](rendering.md#shadow-modes). |
| type `ShadowHorizon`; `SHADOW_HORIZON_UNIT` | `Renderer.shadowHorizon` (default null): the scene's light horizon texture with its extent and height range, the far term of the modes `'snapped'` and `'cascades'`; the fixed texture unit (15) it is sampled on. |
| `SHADOW_AREAS_MAX`; type `HeaderExtra` | The largest number of shadow areas (4). `shaderHeader(slots, depthMode, extra)`: `extra.defines` are added after the depth define, `extra.frameTail` members at the end of the Frame block. |
| types `Layer`, `DrawContext`, `PassName`, `FrameStats`, `SceneBounds`, `RendererOptions`, `MeshLayerOptions`, `InstancedLayerOptions`, `InstanceBatch`, `InstanceBounds`, `MeshPiece`, `CellDetail`, `InstanceCellGroup`, `InstanceCellLayerOptions`, `TransientBatch`, `TransientStats`, `RigCounts`, `FrameSlotSizes`, `FrameSlotsGlsl`, `ValueGrid`, `ValueStyle`, `ValueSheetTile`, `RasterValueOptions`, `PointValueOptions`, `ShapeValueOptions` | |
| `Layer.name`, `MeshLayerOptions.name`, `InstancedLayerOptions.name` | Optional layer name for profiles and statistics; nothing else reads it. |
| `Layer.shadowCasters`, `Layer.shadowDirty()`; `FrameStats.dynamicShadowTriangles`, `FrameStats.dynamicShadowDrawCalls` | Moving shadow casters: a layer with `shadowCasters: 'dynamic'` is redrawn over a kept map of the static casters in a frame where its `shadowDirty()` is true (mode `'single'`; the other modes redraw the whole map). The counts of that part. See [Moving casters](rendering.md#moving-casters). |
| `RendererOptions.samples` | Samples per pixel of the main target, 0, 2 or 4 (`Device.setMainSamples`); default unchanged. |
| `Renderer.probe`, type `RenderProbe`; `Renderer.shadowMapEdgePx` | Measuring hooks, null in normal use: `draws(layer, pass)` may leave a layer out of a pass (or out of `prepare`), `drawn(layer, pass, triangles, calls)` reports what it counted. The edge of the shadow map texture. Used by `profileFrame`. |
| `RendererOptions.radialUp`, `Renderer.radialUp`, `Renderer.upCenter()`, `InstancedLayerOptions.upCenter`, `cullInstances(…, upCenter)` | Local up (off by default): up points away from a centre. The header then defines `WH_LOCAL_UP`, the Frame block ends with `u_upCenter`, and the header functions `localUp`, `localHeight`, `localFrame` (always present) follow it. `upCenter()` is the centre in render space; instance culling takes it to extend boxes along the local up. See [Local up](rendering.md#local-up). |

## `wallhammer-web/camera` (layer 5)

| Name | One line |
| --- | --- |
| `SteppedOrthoRig` | Orthographic view, four rotations, fixed zoom levels. |
| `PerspectiveOrbitRig`, `DEFAULT_ORBIT` | Perspective view orbiting a target. |
| `OrbitSetup.groundAt`, `OrbitSetup.minEyeHeight`, `PerspectiveOrbitRig.keepAboveGround()` | The eye kept at least `minEyeHeight` over `groundAt` by raising the pitch, on `setState`, `orbitPixels`, `zoomBy`. See [Keeping the eye above the ground](cameras.md#keeping-the-eye-above-the-ground). |
| `OrbitPath`, `writeOrbitState`, `blendOrbitState`; types `OrbitKey`, `OrbitPathOptions` | Keyframed orbit states sampled as a smooth curve (Catmull-Rom tangents, yaw the shorter way, distance in log space, open or looping), written into a caller's state or a rig without allocating; a state written into a rig in place; a blend of two states. See [Orbit paths](cameras.md#orbit-paths). |
| `FreeRig`, `DEFAULT_FREE` | Perspective view that moves freely: world position in doubles, up from a world shape, clearance and speed from a height callback. |
| `FollowRig`, `DEFAULT_FOLLOW`; types `FollowSetup`, `FollowOptions`, `BoomClearance` | Perspective view that follows a moving point: a lagging pivot, a boom turned by yaw and pitch, cut at once by a clearance callback and growing back smoothly; distance 0 is first person; `forward(out)` for turning input into world movement. See [`FollowRig`](cameras.md#followrig). |
| types `CameraSetup`, `ViewState`, `OrbitSetup`, `OrbitState`, `FreeSetup`, `FreeState`, `FreeOptions`, `UpSource`, `HeightAbove` | |

## `wallhammer-web/env` (layer 5)

| Name | One line |
| --- | --- |
| `Environment` | Clocks, sun, light, weather, wind, clouds, fog; `frame(view)`. |
| `Environment.setFixedLight(toLight, light?)`, `Environment.fixed`, `EnvironmentConfig.fixed`, `DEFAULT_FIXED`; type `FixedLight`; `LightMode` `'fixed'` | A light in a fixed world direction with colours and strengths given directly, changeable at any time. See [A fixed light](rendering.md#a-fixed-light). |
| `SHADOW_QUERY`, `shadowGlsl(options?)` | The `<shadow>` include (registered by `EnvironmentLink`): sun visibility only, with `sunVisibilitySharp` and `sunVisibilityBakedSharp`; guarded, so it combines with `<lighting>`. See [Shader includes](rendering.md#shader-includes). |
| `DEFAULT_STUDIO`, `DEFAULT_SITE`, `DEFAULT_DAY`, `DEFAULT_WIND`, `DEFAULT_CLOUDS`, `DEFAULT_WEATHER`, `DEFAULT_SNOW_ALBEDO`, `studioLightDirection` | Defaults. |
| `LIGHTING`, `CLOUD_NOISE`, `CLOUD_OCTAVES` | The `lighting` GLSL and the cloud field. |
| `skySlot`, `computeSky`, `SKY_GLSL`, `SKY_FALLBACK`, `DEFAULT_SKY` | The sky slot and its stand-ins. |
| `assembleFrameBlock`, `ENV_CORE_SLOT` | Build the Frame block from slots. |
| `sunPosition`, `skyDirection`, `dayOfYear` | Sun position for a site and time. |
| types `EnvironmentConfig`, `StudioLight`, `DayLight`, `WeatherState`, `WindConfig`, `CloudConfig`, `SkyParams`, `SkyValues`, `EnvFrameBlock`, `FrameBlockValues`, `FrameRegions`, `SunPosition`, `SunSite` | |
| `CLOUD_NOISE_RADIAL` | The cloud field in space, used by `LIGHTING` when the renderer has `radialUp`. `LIGHTING` also provides `lightOnAt(worldPos, n, sun, ao)`: `lightOn` with the up of a named point. |
| `atmosphereSlot`, `atmosphereTables`, `atmosphereFor`, `computeAtmosphere`, `atmosphereGlsl`, `ATMOSPHERE_FALLBACK`, `DEFAULT_ATMOSPHERE`, `DEFAULT_ATMOSPHERE_MEDIUM`, `ATMOSPHERE_TABLE_LAYOUT`, `ATMOSPHERE_TABLE_UNIT` | Air as a shell round a sphere: the slot (Frame members `u_atm…`, include `<atmosphere>`), its lookup tables computed at creation (one 160 × 32 RGBA8 texture, no files), the default air and the same air fitted to another sphere, the stand-in include, and the texture unit (14) the tables are bound to. The include gives `atmosphereAir` (the air to a vertex) and `atmosphereApply` (applied to a fragment, or integrated there). See [The atmosphere](rendering.md#the-atmosphere). |
| types `AtmosphereMedium`, `AtmosphereParams`, `AtmosphereSlot`, `AtmosphereTables`, `AtmosphereValues` | The air itself (read once), the params that may change every frame (`reference` among them: every pixel integrates its own ray, to compare against), the slot with its `medium` and `tables`, the tables, the packed values. |
| `Environment.observer`; type `SunObserver`; `sphereSunDirection` | The sun for a world whose up depends on the place (default `null`: unchanged). `observer = { up, sunDir }` puts the sun in a world direction and computes everything that follows its height for the place with that up. `sphereSunDirection(dayOfYear, utcHour)` is the direction to the sun in the axes of a sphere turning about +y. |
| `cloudFieldSlot`, `CLOUD_FIELD_SLOT`, `cloudFieldCover`, `cloudFieldSun`, `lightingGlsl`, `cloudCoverTerms`; types `CloudCoverField`, `CloudFieldValues` | A cloud cover by place under radial up (opt-in slot, Frame members `u_cloudField…`): a profile by the angle to an axis plus drifting patches. With the slot the link registers `lightingGlsl({ cloudField: true })` as `lighting` (`lightingGlsl()` is `LIGHTING`). `cloudFieldCover` and `cloudFieldSun` are the same cover and share of the sun on the CPU; `cloudCoverTerms(cover, darkness)` the terms `frame()` derives from one cover. See [Cloud cover by place](rendering.md#cloud-cover-by-place). |

## `wallhammer-web/world` (layer 5)

| Name | One line |
| --- | --- |
| `raycastHeightField`, `raycastPrisms` | Picking against a height field and prisms. |
| `CollisionWorld`, `newRayHit`, `newSlideResult`; types `CollisionWorldOptions`, `SolidOptions`, `SolidInfo`, `RayHit`, `SlideResult` | A base height function plus upright solids (prisms, cylinders, turned boxes) in a grid of cells: `groundAt`, `ceilingAt`, `slide` (a circle sliding along sides, never ending inside), `raycast`, `clearance` (a sphere along a boom), `remove` that keeps ids. No allocation per query, plain Node. See [Collision world](walking.md#collision-world). |
| `Walker`, `DEFAULT_WALKER`, `newWalkIntent`; types `WalkerSetup`, `WalkIntent` | A kinematic upright body over a `CollisionWorld` in fixed steps (60 Hz): walk and run with acceleration, sliding along sides, steps up to `maxStepUp`, falling, no climbing of base slopes over `maxSlopeDeg` (it slides down them), jumps with limited air control stopped by undersides, a smoothly turning `yaw`; `advance(dt, intent)`, `step`, `renderPosition`, `teleport`. Deterministic, plain Node. See [Walker](walking.md#walker). |
| `Walker.saveState(out?, offset?)`, `loadState(bytes, offset?)`, `simState(name)`, `renderPosition(out, alpha?)`, `renderYaw(alpha?)`, `renderTravelled(alpha?)`, `lastStepDistance`, `WALKER_STATE_BYTES`; types `ByteSink`, `ByteSource`, `WalkerSimState` | The walker's state as 160 bytes, as a part of a simulation's state, drawn with an external alpha (position, heading and the distance travelled, for a stride); the distance of the last step. See [Saving and restoring](walking.md#saving-and-restoring). |
| `meshPrismFootprint`, `meshCylinderFootprint`, `addMeshSolid`, `convexHullXZ`; types `MeshFootprintOptions`, `MeshPrismFootprint`, `MeshCylinderFootprint` | Collision solids from a mesh: an upright prism over the hull of its vertices or a cylinder round it. See [Solids from a mesh](walking.md#solids-from-a-mesh). |
| `CollisionWorld.baseHeightAt`, `baseSlopeAt`; option `baseExtent` | The base height and its gradient at a point; the rectangle where the base exists, which ends the base search of a ray. See [Collision world](walking.md#collision-world). |
| `StreamingManager`, `DEFAULT_STREAMING`, `CELL_STATES` | Which cells are wanted, without I/O. |
| `pixelsPerRadian`; type `ScreenErrorConfig` | Selection of levels by screen-space error with a budget of cells (`StreamingConfig.screenError`, off by default). See [Selection by screen-space error](streaming.md#selection-by-screen-space-error). |
| `GeneratorCellProvider`, `FileCellProvider` | Cell providers without workers. |
| `StreamingManager.refresh(cells)`, `swapped(cell, gpuBytes)`, `refreshes()`; `GeneratorCellProvider(seed, gen, edits?)`; types `EditableCellGenerator`, `CellEdits` | Content that went out of date: a refreshed RESIDENT cell stays drawn until its new content is swapped in, a MESHED one is forgotten, a job in flight restarts; `refreshes()` counts pending and touched cells. Generators that take edits text per cell. See [Edits and refresh](streaming.md#edits-and-refresh). |
| `CachedCellProvider`; types `CellStore`, `CellCacheStats` | A provider in front of another that keeps finished cells in a byte store under a caller-given version (`prefix`, `key(cell)`, `stats`). See [A cache in the browser's storage](streaming.md#a-cache-in-the-browsers-storage). |
| `StreamingConfig.gpuBudgetBytes`, `StreamingManager.gpuReserveBytes`, `gpuPressure()`, `dropResident()` | A ceiling of GPU bytes (off by default): over it cells leave the GPU, least recently wanted first, and uploads wait; the coarsest level is exempt. `gpuReserveBytes` is what everything else holds, `gpuPressure()` the cells released and uploads held back in the last step. `dropResident()` marks every cell on the GPU as not uploaded (after a context loss without retained uploads). See [A ceiling of GPU memory](streaming.md#a-ceiling-of-gpu-memory). |
| `encodeCell`, `decodeCell`, `cellFilePath`, `CELL_MAGIC`, `CELL_FORMAT_VERSION`, `CELL_FORMAT_VERSION_SHAPED`, `CELL_FILE_EXT` | The WHC1 cell file format: version 1, and version 2 for cells that state their shape hash or error. |
| types `Prism`, `CellProvider`, `CellGenerator`, `CellResult`, `CellOrigin`, `BytesFetcher`, `StreamingConfig`, `StreamingActions`, `StreamingCounters`, `CellRequest`, `CellState`, `Ticket`, `TicketKind` | |
| `SphereWorld`, `horizonHidden`, `boxMaxRadius` | The sphere world shape: six quadtrees on a cube, neighbours across its edges, radial up; fields `radiusM`, `centerM`, `radial`, methods `directionOf`, `altitude`, `atHeight`, `facetDropM` besides the `WorldShape` port. The horizon test of a hiding sphere and the largest distance of a box from a centre. See [A sphere world](streaming.md#a-sphere-world). |

## `wallhammer-web/sim` (layer 5)

| Name | One line |
| --- | --- |
| `Simulation` | Fixed-step deterministic simulation with commands, checkpoints, hashes. |
| `EventQueue` | Per-tick events. |
| `EntityTable` | Dense typed columns with stable ids. |
| `NavGraph`, `PathSet` | A* navigation and paths. |
| `Movers`, `MOVER_STATE`, `TRANSFORM_STRIDE`, `POSE_STRIDE`, `capsuleDist2` | Entities moving along paths with collision modes (`follow`, `static`, `lanes`, `agents`); extraction strides. |
| `buildZoneIntervals` | Conflict zones between lanes (`Movers.buildZones` uses it). |
| `Interlock` | Shared areas where two mover sets cross, with a priority side. |
| `Agendas` | Entities that follow activities (place, time, stay) through a graph, with app states. |
| `StateMachine` | Named states with `enter` and `update`; the state lives in the owner's table. |
| `RegionNav` | Route search on two levels: regions with gates, tables between gates built ahead or on demand, a route cache. |
| `FlowNetwork`, `FLOW_STATE` | Coarse movement over a whole graph: every edge a queue of trips; individual movers only inside a focus circle. |
| `createFlowProbe`, `flowProbeLine` | Reference run of the flow model with a state hash, and its one-line report. |
| `mm`, `mmPerTick`, `mmPerTick2`, `isqrt`, `approachSpeed`, `brakeSpeed`, `stoppingDistance` | Fixed-point helpers. |
| `ByteWriter`, `ByteReader`, `hashBytes` | Snapshot streams and the state hash. |
| types `SimulationOptions`, `System`, `Command`, `CommandHandler`, `SimState`, `SimEvent`, `SimData`, `SimValue`, `ColumnSpec`, `ColumnType`, `Columns`, `Path`, `PathDef`, `PathStop`, `NavEdgeInput`, `NavGraphInput`, `RouteOptions`, `CollisionMode`, `SpawnOptions`, `MoversOptions`, `Capsule`, `KnownObstacles`, `ZoneIntervals`, `InterlockOptions`, `SharedArea`, `StateDef`, `AgendaActivity`, `AgendaEntity`, `AgendaOptions`, `AgendaPlace`, `RegionNavOptions`, `FlowOptions`, `FlowTrip`, `FlowMoverOptions`, `FlowCensus`, `FlowProbe`, `FlowProbeOptions`, `FlowProbeResult` | |

## `wallhammer-web/sim/destruction` (part of `sim`)

| Name | One line |
| --- | --- |
| `destructionEvent`, `applyEvent`, `applyEventToAll`, `fallTimeline`, `TIMELINE`, `TIMELINE_TICK_S` | Apply an event; staged collapse timing. |
| `compileStructure`, `solveSupport`, `UNSUPPORTED` | Precompiled structures and the support solver. |
| `rubbleFootprints`, `partRubble`, `ruinRubble` | Where rubble lies. |
| `intactState`, `isIntact`, `sortedEntries`, `stateHash`, `encodeStates`, `decodeStates` | State helpers, hashing, text encoding. |
| `raycastParts` | Pick a part with a ray. |
| `CellStates`, `decodeCellStates`, `DEFAULT_MAX_UNITS`, `CELL_STATES_CHARS_PER_UNIT`; type `CommitResult` | Changed structure states of a streamed world by home cell: `commit`, `of`, `cells`, `under`, `clear`, `hash`, `text`, `units`, `structures`, a ceiling in units (`maxUnits`) with one fixed rule. See [State in streamed cells](destruction.md#state-in-streamed-cells). |
| `octant`, `pieceDistSq` | Integer geometry helpers. |
| types `DestructionResult`, `DestructionOptions`, `PartChange`, `ChangeCause`, `CompiledStructure`, `PartHit` | |

## `wallhammer-web/runtime` (layer 6)

| Name | One line |
| --- | --- |
| `createEngine`, `Engine` | The mediator: init order, frame order, dispose. |
| `createHeadlessEngine`, `HeadlessEngine` | The same without canvas and GPU. |
| `Engine.setView(view)`, `Engine.animateWhile(fn)`, `HeadlessEngine.frameSeconds` | Draw through another view from the next frame (it takes the canvas size; `orbitControls` act only while their own view is current); keep the loop drawing while a condition holds (returns a remover); the real seconds of the frame being made, for the input and extraction hooks. See [Walk controls](cameras.md#walk-controls). |
| `EnvironmentLink` | Computes the environment and slots each frame and fills the Frame block. |
| `SkyLayer`, `SKY_VS`, `SKY_FS` | The sky behind a perspective view. |
| `SkyLayer.behindScene`, `Engine.moveSkyBefore(layer)` | The sky drawn after the opaque layers, only where nothing was drawn (depth-tested at the far end), instead of over the whole screen first; the same image when every layer before it is opaque. Off by default. See [The sky](rendering.md#the-sky). |
| `EngineOptions.maxPixelRatio`, `Engine.maxPixelRatio` | Cap of the canvas's pixels per CSS pixel (default none). See [Resolution and antialiasing](rendering.md#resolution-and-antialiasing). |
| `AtmosphereLayer`, `ATMOSPHERE_FS`, `ATMOSPHERE_TABLE_FS`, `ATMOSPHERE_SKY_TABLE`; `EngineOptions.atmosphere`, `Engine.atmosphere` | The air behind a perspective view, from the ground to orbit, and the binding of its tables for the layers after it. The sky is read from the sky table (64 × 128 texels), which the layer fills in `prepare` when the environment or the eye has changed; `usesSkyTable` tells whether it does in this frame. `createEngine({ atmosphere })` (off by default; `true` or the params) adds the slot and the layer. |
| `PrecipitationLayer`, `PRECIP_VS`, `PRECIP_FS` | Screen-space rain and snow; under radial up they fall along the up under the eye. |
| `CloudShellLayer`, `CLOUD_SHELL_VS`, `CLOUD_SHELL_FS` | The clouds of the cloud cover by place as a shell over a sphere, over their own shadows; needs `cloudFieldSlot`. |
| `StreamedWorld`, `WorkerCellProvider`, `serveCellGenerator`, `viewTickets`, `viewerTickets`, `boxInVolume` | Streaming on the GPU side. `viewerTickets` takes world directions and the viewer's pixels per radian. `StreamedWorldOptions.originAxes: 'all'` makes the render origin follow the height of the focus too. |
| types `EngineOptions`, `EngineView`, `HeadlessEngineOptions`, `EnvironmentLinkOptions`, `StreamedWorldOptions`, `StreamedWorldStats`, `StreamArchetype` | |
| `StreamedWorldOptions.textures`, `materialUniforms`, `gpuCeilingBytes`, `onResident`, `onReleased`; `StreamedWorld.reupload()` | Per-material textures and uniforms of streamed cells (also fields of the layer, changeable at any time); the GPU ceiling measured on the device (`Device.memory().total`), off by default; callbacks when a cell reaches or leaves the GPU (its meshes in the order of `content.meshes`); `reupload()` uploads every cell again from its CPU data. |
| `EngineOptions.contextRecovery` | Recovery from a lost graphics context (off by default): the device keeps its uploads, the engine watches the canvas and, when the browser hands a fresh context back, has the device make everything again and draws a frame. |
| `StreamedWorldOptions.horizon`, `StreamedWorldStats.horizonCulled` | Horizon culling of streamed cells (off by default): `{ center, radiusM }` of a sphere that hides what lies behind it; the number of cells it skipped in the last frame. |
| `StreamedWorld.refresh(cells)`; `WorkerCellProvider(url, seed, size?, edits?)`, `serveCellGenerator(gen)` with an `EditableCellGenerator` | Rebuilds cells whose content went out of date and swaps them in on the GPU without a gap; edits text per cell through workers. See [Edits and refresh](streaming.md#edits-and-refresh). |

## `wallhammer-web/tools` (layer 7)

| Name | One line |
| --- | --- |
| `DataView` | The data view: ground in class colours and lines on top. The name shadows the global `DataView` of JavaScript. |
| `DATA_TERRAIN_FS`, `LINE_VS`, `LINE_FS` | Its shaders. |
| types `DataViewSetup`, `DataViewMask`, `DataViewOptions` | |
| `collisionLines(world, options?)`; type `CollisionLinesOptions` | The solids of a collision world as a wireframe (`LINE_LAYOUT` lines), filtered by `select`. See [Walking](walking.md#seeing-the-solids). |
| `profileFrame(renderer, view, options?)`, `formatProfile(profile)`; types `FrameProfile`, `FrameTiming`, `LayerProfile`, `PassCost`, `ProfileOptions` | Frame profile on the graphics card at hand: target size, samples, shadow map size, GPU name; median frame time empty, with the shadow map kept, redrawn every frame and (with `step`) animated; per layer its passes, triangles, calls and cost in ms in the colour and the shadow pass. `formatProfile` makes a text table. See [Tools](tools.md#frame-profile). |
| `meshParts`, `floatingParts`, `routeClearance`; types `MeshPart`, `MeshPartsOptions`, `FloatingOptions`, `RouteClearance`, `RouteClearanceOptions` | Checks of built geometry without a browser: connected parts of a mesh and those hanging in the air; the least distance of a route from the solids of a collision world. See [Mesh checks](tools.md#mesh-checks). |
