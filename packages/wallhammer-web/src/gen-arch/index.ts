// wallhammer-web/gen-arch: structures from recipes. Walls, roofs and façades as one mesh (plain data), and the material
// that draws them.

export { BUILDING_ATTRIBS, BUILDING_LAYOUT, ROOF_COVER, WALL_FINISH, WINDOW_STYLE } from './structure/buildings.ts';
export { buildBuildingMesh } from './build.ts';
export type { BuildingMeshStats, BuildingSpec, PropBox, RoofKind } from './structure/buildings.ts';
export { ROOF_PROFILE } from './structure/roof.ts';
export type { RoofProfile } from './structure/roof.ts';
export { DOOR_KIND, FACADE_DIM, GROUND_FLOOR } from './structure/facade.ts';
export type { BalconyRecipe, CorniceRecipe, DoorKind, EntranceSpec, FacadeRecipe, GroundFloorKind, RoofBoxSpec, WindowRecipe } from './structure/facade.ts';
export { BUILDING_VS, buildingFs, buildingVs } from './structure/building-shader.ts';
export type { StructureShaderOptions } from './structure/building-shader.ts';
export { structureMaterial, structureUniforms } from './structure/structure-material.ts';
export { fallingMaterial } from './damage/fall-material.ts';
export type { StructureRows } from './structure/structure-material.ts';
export type { ArchDims, ArchMeshDims, ArchShadeDims } from './structure/dims.ts';
export { DEFAULT_WINDOWS, windowLightSlot, windowShare } from './structure/env-slots.ts';
export type { WindowLight, WindowLightState } from './structure/env-slots.ts';
export type { StructureOptions } from './structure/buildings.ts';
export { DESTRUCT_DIM, PART_RULE, STRUCTURE_MATERIAL, STRUCTURE_MATERIALS, bayKey, canopyKey, chimneyKey, describeKey, foundationKey, partitionKey, roofKey, roofTopKey, slabKey, stairKey } from './damage/damaged.ts';
export { INTERIOR_DIM } from './structure/dims.ts';
export { ROOM_TYPE, cellAt, roomAt } from './interior/interior-plan.ts';
export type { InteriorCell, InteriorPartition, InteriorPlan, InteriorRoom, PartitionSeg, StairCore } from './interior/interior-plan.ts';
export { buildRubbleMesh, rubbleColours } from './damage/rubble.ts';
export { FALL_ATTRIBS, FALL_LAYOUT, fallPieces, retimeFall } from './damage/fall.ts';
export type { FallChange, FallEvent, FallInput, FallOutput } from './damage/fall.ts';
export { MASSING_ATTRIBS, MASSING_LAYOUT, buildMassingMesh, massingMaterial, roofTones, stampFootprints } from './structure/distant.ts';
export type { MassingMesh, MassingOptions } from './structure/distant.ts';
