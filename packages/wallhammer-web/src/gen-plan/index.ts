// Layer 3, gen-plan: coarse plans over a whole sphere. A grid of nodes at the middles of the cells of one level of the
// cube sphere, drainage of a height field over it (filled hollows, pools, flow, channels), lines over the sphere
// (smoothing, a profile that never rises, a limited grade, lengths and points along them), least-cost ways and regions
// over the grid, picks of nodes by a score (sites), plots along lines on a plane, an index from tiles to the lines that
// can reach them and the skyline (horizon) of a height field. Imports only `base` and `gen-core`. Pure, run anywhere.

export { gridDirection, gridNeighbours, gridNodeArea, gridNodeAt, gridSample, gridWeights, sphereGrid } from './grid.ts';
export type { SphereGrid } from './grid.ts';
export { drainGrid, traceChannels } from './drain.ts';
export type { Channels, DrainOptions, Drainage } from './drain.ts';
export { fallingGrade, limitGrade, lineAt, lineLengths, smoothLine } from './lines.ts';
export { regionLinks, routeGrid, routeRegions, routeScratch } from './route.ts';
export type { RegionLinks, RouteRegions, RouteScratch, StepCost } from './route.ts';
export { lineTiles, tileLinesAt, tileLinesOfCell } from './line-tiles.ts';
export type { LineTiles, LineTilesOptions } from './line-tiles.ts';
export { gridSlopeAt, gridSteps, pickSites } from './sites.ts';
export type { PickOptions } from './sites.ts';
export { plotsAlong } from './plots.ts';
export type { Plot, PlotOptions } from './plots.ts';
export { HORIZON_AXES, HORIZON_GLSL, gridHorizon, horizonCode, horizonCodeAt, horizonField, horizonLit } from './horizon.ts';
export type { HorizonField, HorizonOptions } from './horizon.ts';
