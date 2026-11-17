// Layer 3, gen-mesh: mesh generators and shapes shared by them. Height field mesh, line mesh, the box primitive, rig
// part meshes.

export { HEIGHT_FIELD_ATTRIBS, HEIGHT_FIELD_LAYOUT, heightFieldMesh } from './height-field-mesh.ts';
export { LINE_LAYOUT, lineMesh, spaceLineMesh } from './line-mesh.ts';
export type { SpaceLinePath } from './line-mesh.ts';
export type { LinePath } from './line-mesh.ts';
export type { PropBox } from './box.ts';
export { CELL_SURFACE_ATTRIBS, CELL_SURFACE_LAYOUT, cellSurfaceMesh } from './cell-surface-mesh.ts';
export type { CellSurface, CellSurfaceOptions } from './cell-surface-mesh.ts';
export { CELL_MORPH_ATTRIBS, CELL_MORPH_GLSL, CELL_MORPH_LAYOUT, cellMorphMesh } from './cell-morph-mesh.ts';
export type { CellMorphOptions, CellMorphSurface } from './cell-morph-mesh.ts';
export { rigMesh, rigShadowMesh } from './rig-mesh.ts';
export { DRAPE_ATTRIBS, DRAPE_LAYOUT, drapeEvery, drapeTiles } from './drape-mesh.ts';
export type { DrapeOptions, DrapeTile } from './drape-mesh.ts';
export { PRISM_ATTRIBS, PRISM_LAYOUT, prismMesh, triangulateRing } from './prism-mesh.ts';
export type { PrismMeshOptions, PrismShape } from './prism-mesh.ts';
export { PACKED_POSITION, PACK_STEPS_PER_EDGE, packFrame, packMesh, packUniform, packedLayout, packedMaterial } from './packed-mesh.ts';
export type { PackFrame, PackOptions, PackedMesh } from './packed-mesh.ts';
export { BISECT_SURFACE_ATTRIBS, BISECT_SURFACE_LAYOUT, bisectSurface } from './bisect-surface.ts';
export type { BisectSurface, BisectSurfaceOptions } from './bisect-surface.ts';
export { STRIP_ATTRIBS, STRIP_GLSL, STRIP_LAYOUT, stripGrow, stripMesh } from './strip-mesh.ts';
export type { StripMesh, StripMeshOptions } from './strip-mesh.ts';
export { chunkMeshes } from './chunk-mesh.ts';
export type { ChunkOptions, MeshChunk } from './chunk-mesh.ts';
