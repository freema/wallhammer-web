// Layer 5, world: spatial queries over a built scene (picking against height fields, prisms and gap functions, the collision world, a walker and
// a rigid body carried on wheel rays over it, free places to stand and a walker getting onto a seat and off it,
// an index of the solids of loaded cells and a feed of it into a collision world)
// and world streaming: the streaming manager (cell states, tickets, epochs, levels of detail, budgets), the provider port with a generator
// and a file implementation, and the binary cell format they share.

export { raycastHeightField, raycastPrisms } from './pick.ts';
export type { Prism } from './pick.ts';
export { marchRay } from './march.ts';
export type { RayMarchHit, RayMarchOptions } from './march.ts';
export { CollisionWorld, newRayHit, newSlideResult, newSphereContacts } from './collide.ts';
export type { CollisionWorldOptions, RayHit, SlideResult, SolidInfo, SolidOptions, SphereContacts, StandSpotOptions } from './collide.ts';
export { addMeshSolid, convexHullXZ, meshCylinderFootprint, meshPrismFootprint } from './mesh-solids.ts';
export type { MeshCylinderFootprint, MeshFootprintOptions, MeshPrismFootprint } from './mesh-solids.ts';
export { DEFAULT_WALKER, WALKER_STATE_BYTES, WALKER_TUNING_KEYS, Walker, newWalkIntent } from './walker.ts';
export type { ByteSink, ByteSource, WalkIntent, WalkerSetup, WalkerSimState, WalkerTuning } from './walker.ts';
export { DEFAULT_WHEELED_BODY, WHEELED_OBSTACLE_TAG, WHEELED_TUNING_KEYS, WheelState, WheeledBody, WheeledGroup, collideWheeledBodies, fourWheels, newWheeledIntent } from './wheeled.ts';
export type { FourWheelsOptions, WheelSpec, WheeledBodySetup, WheeledIntent, WheeledTuning } from './wheeled.ts';
export { DEFAULT_FLYING_BODY, FLYING_BODY_STATE_BYTES, FlyingBody, newFlyingIntent } from './flying.ts';
export type { FlyingBodySetup, FlyingIntent } from './flying.ts';
export { DEFAULT_FLIGHT_ASSIST, FlightAssist, newFlightAssistInput } from './flight-assist.ts';
export type { FlightAssistInput, FlightAssistSetup } from './flight-assist.ts';
export { CELL_FILE_EXT, CELL_FORMAT_VERSION, CELL_FORMAT_VERSION_SHAPED, CELL_MAGIC, cellFilePath, decodeCell, encodeCell } from './cell-format.ts';
export { FileCellProvider, GeneratorCellProvider } from './providers.ts';
export type { BytesFetcher, CellEdits, CellGenerator, CellOrigin, CellProvider, CellResult, EditableCellGenerator } from './providers.ts';
export { CELL_STATES, DEFAULT_STREAMING, StreamingManager, pixelsPerRadian } from './streaming.ts';
export type { CellRequest, CellState, ScreenErrorConfig, StreamingActions, StreamingConfig, StreamingCounters, Ticket, TicketKind } from './streaming.ts';
export { SphereWorld, boxMaxRadius, horizonHidden } from './sphere.ts';
export { CachedCellProvider } from './cell-cache.ts';
export type { CellCacheStats, CellStore } from './cell-cache.ts';
export { CHART_WALKER_STATE_BYTES, ChartWalker } from './chart-walker.ts';
export type { ChartWalkerOptions, RadiusAt } from './chart-walker.ts';
export { SolidIndex, newSolidHit } from './solid-index.ts';
export type { SolidCellListener, SolidHit, SolidIndexOptions } from './solid-index.ts';
export { SolidFeed } from './solid-feed.ts';
export { attachFromWalker, releaseToWalker } from './seat-walker.ts';
export type { SolidFeedOptions } from './solid-feed.ts';
