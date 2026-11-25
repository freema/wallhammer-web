// Layer 2, gen-core: stateless randomness with named streams, value noise, planar polygon geometry and the spatial
// structures generators query (height field, distance fields, occupancy grid), and the split of instance streams into
// thinned cells, and a field of moving waves. Pure, run anywhere.

export { hashInt, hashInts, hashString, mix32, pickWeighted, rand, randRange, streamSeed, unit } from './hash.ts';
export { valueNoise2 } from './noise.ts';
export { fractalNoise3, valueNoise3 } from './noise.ts';
export type { FractalNoise3 } from './noise.ts';
export { CUBE_FACE_AXES, cubeDirection, cubeDirectionWarped, cubeFaceCoords, cubeFaceOf, cubeGrid, cubeNeighbour, cubeUnwarp, cubeWarp, directionTangents } from './cube-sphere.ts';
export { SPHERE_PATCH_ATTRIBS, SPHERE_PATCH_COVER_ATTRIBS, SPHERE_PATCH_COVER_EXTRA_ATTRIBS, SPHERE_PATCH_COVER_EXTRA_LAYOUT, SPHERE_PATCH_COVER_LAYOUT, SPHERE_PATCH_EXTRA_ATTRIBS, SPHERE_PATCH_EXTRA_LAYOUT, SPHERE_PATCH_GLSL, SPHERE_PATCH_LAYOUT, spherePatchMesh, spherePatchRadius, spherePatchSplitsAD } from './sphere-patch.ts';
export type { SpherePatch, SpherePatchOptions, SpherePatchSplit } from './sphere-patch.ts';
export { distToSegment, insetRing, lineRing, orientedBox, pointInRings, ringSignedArea, ringsArea } from './geometry.ts';
export type { OrientedBox, Ring } from './geometry.ts';
export { HeightField } from './height-field.ts';
export { OutlineField, SegmentField } from './field.ts';
export { Occupancy } from './occupancy.ts';
export { FACE_FLAT, FLAT_ROOT_EDGE_M, FlatWorld, LEVEL, cellBits, cellContentBytes, cellFromBits, cellId, cellKey, compareCells, parseCellKey, sameCell, shapeHash } from './cell.ts';
export type { CellContent, CellId, CellInstances, CellMesh, LocalBounds, WorldPos, WorldShape } from './cell.ts';
export { DEFAULT_INSTANCE_TIERS, splitInstanceCells } from './instance-cells.ts';
export type { InstanceCell, InstanceCellOptions, InstanceTier } from './instance-cells.ts';
export { STRIP_STATION_FLOATS, stripCarve, stripLength, stripNearest, stripNet, stripTouches, stripUp } from './strip.ts';
export type { StripHit, StripInput, StripLine, StripNet, StripNetLine, StripNode, StripProfile } from './strip.ts';
export { flatStripSurface, sphereStripSurface } from './strip-surface.ts';
export type { StripSurface } from './strip-surface.ts';
export { NEAR_FADE_GLSL, NEAR_FLOATS, NEAR_LAYOUT, nearCount, nearKeep, nearLeaveM, nearScatter } from './near-scatter.ts';
export type { NearFade, NearRecords, NearScatterOptions } from './near-scatter.ts';
export { NearSquareGrid, nearLatticeValue, nearPatch, nearSlopeDeg, newNearPatchPoint } from './near-squares.ts';
export type { NearPatchPoint, NearSquare, NearSquareGridOptions } from './near-squares.ts';
export { WAVES_GLSL, WAVE_GRAVITY, WAVE_TRAINS_MAX, waveDisplace, waveFade, waveHeight, waveNormal, waveTrains, waveUniforms, waveUnresolved } from './waves.ts';
export type { WaveFieldOptions, WaveTrain } from './waves.ts';
