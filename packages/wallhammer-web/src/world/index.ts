// Layer 5, world: spatial queries over a built scene (picking against height fields and prisms, the collision world and a walker over it)
// and world streaming: the streaming manager (cell states, tickets, epochs, levels of detail, budgets), the provider port with a generator
// and a file implementation, and the binary cell format they share.

export { raycastHeightField, raycastPrisms } from './pick.ts';
export type { Prism } from './pick.ts';
export { CollisionWorld, newRayHit, newSlideResult } from './collide.ts';
export type { CollisionWorldOptions, RayHit, SlideResult, SolidInfo, SolidOptions } from './collide.ts';
export { DEFAULT_WALKER, Walker, newWalkIntent } from './walker.ts';
export type { WalkIntent, WalkerSetup } from './walker.ts';
export { CELL_FILE_EXT, CELL_FORMAT_VERSION, CELL_FORMAT_VERSION_SHAPED, CELL_MAGIC, cellFilePath, decodeCell, encodeCell } from './cell-format.ts';
export { FileCellProvider, GeneratorCellProvider } from './providers.ts';
export type { BytesFetcher, CellEdits, CellGenerator, CellOrigin, CellProvider, CellResult, EditableCellGenerator } from './providers.ts';
export { CELL_STATES, DEFAULT_STREAMING, StreamingManager, pixelsPerRadian } from './streaming.ts';
export type { CellRequest, CellState, ScreenErrorConfig, StreamingActions, StreamingConfig, StreamingCounters, Ticket, TicketKind } from './streaming.ts';
export { SphereWorld, boxMaxRadius, horizonHidden } from './sphere.ts';
export { CachedCellProvider } from './cell-cache.ts';
export type { CellCacheStats, CellStore } from './cell-cache.ts';
