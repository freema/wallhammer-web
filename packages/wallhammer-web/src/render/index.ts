// Layer 5, render: the renderer (passes, shadow map, layers), materials, texture bakes, shared GLSL pieces, the
// shadow pass shaders, culled mesh pieces, instances in cells with levels of detail and instanced rigs.

export { NOISE, PIXEL_SIZE_GLSL, frameBlockFloats, shaderHeader } from './glsl.ts';
export type { FrameSlotSizes, FrameSlotsGlsl, HeaderExtra } from './glsl.ts';
export { DEPTH_FS, DEPTH_VS, SHADOW_AREAS_MAX, SHADOW_HORIZON_UNIT } from './shadow-glsl.ts';
export { InstancedLayer, Material, MeshLayer, Renderer, SHADOW_MAP_UNIT, cullInstances } from './renderer.ts';
export { PieceLayer } from './pieces.ts';
export type { MeshPiece, PieceLayerOptions } from './pieces.ts';
export { POINT_LIGHTS_BINDING, POINT_LIGHTS_PER_DRAW, PointLightSet, pointLightsGlsl } from './point-lights.ts';
export type { PointLight, PointLightSetOptions } from './point-lights.ts';
export { INSTANCE_SET_FLOATS, INSTANCE_SET_GLSL, INSTANCE_SET_LAYOUT, InstanceSetLayer, instanceSet, instanceSetAttribs, pushInstance, writeInstance } from './instance-sets.ts';
export type { InstanceSet, InstanceSetLayerOptions } from './instance-sets.ts';
export { ParticleLayer } from './particles.ts';
export type { ParticleCounts, ParticleLayerOptions, ParticleSource } from './particles.ts';
export { InstanceCellLayer, cellDetail } from './cells.ts';
export type { CellDetail, InstanceCellGroup, InstanceCellLayerOptions } from './cells.ts';
export type {
  DrawContext,
  FrameStats,
  InstanceBatch,
  InstanceBounds,
  InstancedLayerOptions,
  Layer,
  MeshLayerOptions,
  PassName,
  RenderProbe,
  RendererOptions,
  SceneBounds,
  ShadowHorizon,
  ShadowMode,
  ShadowOptions,
} from './renderer.ts';
export { DUST_LIFE_S, TransientLayer } from './transient.ts';
export type { TransientBatch, TransientStats } from './transient.ts';
export { RIG_POSE_GLSL, RigLayer } from './rig.ts';
export type { RigCounts, RigLayerOptions } from './rig.ts';
export { BoneInstances } from './bone-instances.ts';
export type { BonePart } from './bone-instances.ts';
export { POINT_VALUE_ATTRIBS, POINT_VALUE_MATERIAL, RASTER_VALUE_MATERIAL, SHAPE_VALUE_MATERIAL, VALUE_GLSL } from './value-glsl.ts';
export { POINT_VALUE_LAYOUT, PointValueLayer, RasterValueLayer, ShapeValueLayer, ValueSteps } from './value-layers.ts';
export type { PointValueOptions, RasterValueOptions, ShapeValueOptions, ValueGrid, ValueSheetTile, ValueStyle } from './value-layers.ts';
export { NEAR_INSTANCE_GLSL, NearInstanceLayer } from './near-instances.ts';
export type { NearInstanceLayerOptions, NearKindDraw, NearPart, NearWind } from './near-instances.ts';
