// wallhammer-web/gen-ground: ground from surface classes, markings on the surface, the materials that draw them and the
// season and snow slots. Everything is plain data; the app uploads it through the engine.

export { buildOcclusionMask, groundBake } from './ground.ts';
export type { GroundInput, GroundMaterial, GroundSurface, OcclusionInput, OcclusionMask } from './ground.ts';
export { MARKING_ATTRIBS, MARKING_LAYOUT, buildGroundMarkings } from './markings.ts';
export type { GroundMarking, MarkingPattern } from './markings.ts';
export { MARKING_FS, MARKING_VS, TERRAIN_FS, TERRAIN_VS } from './terrain-shader.ts';
export { GROUND_SAMPLERS, MARKING_MATERIAL, TERRAIN_MATERIAL, groundUniforms } from './materials.ts';
export type { GroundShading } from './materials.ts';
export { DEFAULT_PHENOLOGY, seasonAt, seasonSlot, snowSlot } from './env-slots.ts';
export type { PhenologyConfig, SeasonState } from './env-slots.ts';
