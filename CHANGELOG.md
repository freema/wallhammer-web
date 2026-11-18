# Changelog

All notable changes to the npm package `wallhammer-web` are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, a minor version (for example 0.4 to 0.5) may contain breaking changes. A patch version does not.

## Unreleased

## 0.4.0

First public release. Earlier versions were never published.

### Added

- A WebGL2 engine for the browser in strict TypeScript: plain WebGL2, no graphics library, no loaded images. One world unit is one metre, y points up.
- One entry per module, `wallhammer-web/<module>`. The root entry re-exports `base`, `platform`, `core`, `gen-core`, `gen-mesh`, `gen-tex`, `gpu`, `camera`, `env`, `world` and `tools`.
- Modules in layers; a module imports only lower layers:
  - `base`: vector math, quaternions, the `View` contract, plain-data contracts for meshes, instances, textures, materials and bakes, the environment slot contract, destructible structure types, reproducible trigonometry and nested 64-bit frames (`FrameSet`).
  - Affine 3 × 4 matrices in `base` (`mat34Identity`, `mat34Multiply`, `mat34Invert` and others), 12 numbers column by column, the layout of an instance record.
  - `platform`: the only module that touches the browser. Canvas size, orbit, stepped, free and walk controls (keys, pointer, gamepad), the frame loop, workers, `fetchBytes`, a byte store in the browser's storage, loss of the graphics context.
  - `core`: `Clock`, the palette, ballistic tracks of falling pieces, orbits and spin as functions of time (`BodySystem`), level-of-detail fades.
  - `gen-core`: hash-based randomness with named streams, value noise, polygon geometry, spatial fields, instance cells, cell ids and world shapes for streaming, a cube blown up to a sphere, strips along a surface, small instances near the viewer.
  - `motion` (layer 2): skeletons and poses as data, blend and additive operations, world matrices (`solvePose`), a motion graph of states, transitions, layers, parameters, triggers and events at marks, `save` and `restore`, a two-bone reach and ends kept on the ground. It holds no motion of its own; every pose comes from a source the game writes. Not re-exported from the root entry.
  - `gen-mesh`: height fields, lines, cell surfaces with blending between levels, packed meshes, surfaces within an error tolerance, prisms, strips and spatial chunks.
  - The mesh builder in `gen-mesh`: `MeshBuilder` builds meshes in a vertex format the caller supplies, with a transform stack and mirroring. Bare shapes for it (`revolve`, `sweep`, `extrude`, `polygon`, `gridSurface`, `box`, `cylinder`) ask the caller for every vertex payload and carry no look of their own.
  - `gen-tex`: textures from code (`codeTexture`, `colorTable`, `boxBlur`).
  - `gen-plan`: coarse plans over a whole sphere: a grid of nodes, drainage, lines, least-cost routes and regions, picks of sites, plots along lines, the skyline of a height field.
  - Content modules `gen-arch` (structures from recipes, destructible descriptions, damage, interiors, rubble), `gen-ground` (ground bake from surface classes, season and snow slots) and `gen-vegetation` (placement, meshes, the sway slot). Nothing else in the engine depends on them.
  - `gpu`: the only module with WebGL2. `Device`, programs, buffers, textures, bakes, depth modes (standard, reversed, logarithmic), antialiasing, recovery from a lost context, GPU memory accounting.
  - `render`: `Renderer` with passes and shadow modes (single, snapped, cascades), moving shadow casters, mesh, piece, instanced, instance cell, instance set, transient, rig, particle, value and near-instance layers, point lights, shader includes.
  - Bone-driven instances in `render`: `BoneInstances` writes the bone matrices of a solved pose into instance set records without allocation. `RigLayer` can draw with the game's own material and cast shadows into the shadow map.
  - `camera`: `SteppedOrthoRig`, `PerspectiveOrbitRig` (can keep the eye above the ground), keyframed `OrbitPath`, `FreeRig`, `FollowRig`.
  - `env`: `Environment` with clocks, sun, light, weather, wind, clouds and fog, a fixed light mode, the sky, an atmosphere round a sphere, cloud cover by place.
  - `world`: picking, streaming without the GPU (`StreamingManager`, cell providers, the WHC1 cell file format, a cache, a GPU memory ceiling) and the sphere world shape (`SphereWorld`).
  - Walking in `world`: `CollisionWorld` (a base height function plus upright solids), a `Walker` that moves over it in fixed steps, saving and restoring the walker's state, collision solids from a mesh. Deterministic and runs in plain Node.
  - `sim`: a deterministic fixed-step simulation that runs in plain Node: commands, checkpoints, state hashes, entity tables, navigation, movers with collision modes, shared areas, agendas, state machines, region navigation, a flow network. `sim/destruction` applies events to destructible structures.
  - `runtime`: `createEngine`, `createHeadlessEngine`, `EnvironmentLink`, sky, atmosphere, precipitation and cloud shell layers, `StreamedWorld` with worker cell providers.
  - `tools`: the data view, the frame profile, a wireframe of collision solids, checks of built geometry.
- Documentation in the package (`docs/`): getting started, architecture, concepts, guides, the reference of every entry and recipes.
- The published package holds compiled JavaScript with type declarations (`dist/`). Its only runtime dependency is `earcut`. MIT licence.
