// Layer 7, tools: debugging aids. The data view (flat class colours, outlines), the frame profile, the wireframe of a collision world
// and checks of built geometry without a browser (parts hanging in the air, route clearance from solids).

export type { DataViewMask, DataViewSetup } from './debug-view.ts';
export { DataView } from './data-view-layers.ts';
export type { DataViewOptions } from './data-view-layers.ts';
export { DATA_TERRAIN_FS, LINE_FS, LINE_VS } from './data-view-glsl.ts';
export { formatProfile, profileFrame } from './profile.ts';
export type { FrameProfile, FrameTiming, LayerProfile, PassCost, ProfileOptions } from './profile.ts';
export { collisionLines } from './collision-lines.ts';
export type { CollisionLinesOptions } from './collision-lines.ts';
export { floatingParts, meshParts, routeClearance } from './mesh-checks.ts';
export type { FloatingOptions, MeshPart, MeshPartsOptions, RouteClearance, RouteClearanceOptions } from './mesh-checks.ts';
