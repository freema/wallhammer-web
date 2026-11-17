// wallhammer-web/gen-vegetation: vegetation and its placement, the material that draws it and the sway slot (the
// season slot it reads is in gen-ground). Everything is plain data; the app uploads it through the engine.

export { TREE_KINDS, TREE_MAX_FLEX, TREE_SPECIES, plantTrees, plantTreesSteps } from './planting.ts';
export type { CanopyRaster, PlantedTree, CrownRule, PlantingInput, PlantingRules, PlantingStats, StreetLine, TreeKind, TreeSpecies } from './planting.ts';
export {
  TREE_ATTRIBS,
  TREE_INSTANCE_BOUNDS,
  TREE_INSTANCE_FLOATS,
  TREE_INSTANCE_LAYOUT,
  TREE_LOD_COUNT,
  TREE_VERTEX_LAYOUT,
  buildTreeBatch,
  buildTreeBatches,
  packTreeInstances,
  treeBatchUniforms,
} from './trees.ts';
export type { TreeBatch, TreeMaterial } from './trees.ts';
export { DEPTH_TREE_FS, DEPTH_TREE_VS, TREE_FS, TREE_VS } from './tree-shader.ts';
export { VEGETATION_MATERIAL, vegetationSieve, vegetationUniforms } from './materials.ts';
export { DEFAULT_SWAY, maxSway, swayAt, swaySlot } from './env-slots.ts';
export type { SwayConfig, SwayState } from './env-slots.ts';
