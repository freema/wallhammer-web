// Layer 5, sim: fixed-step simulation (determinism tier A). Tick counter, command log, systems, snapshots and the
// state hash; dense entity tables with own ids; the event queue; paths, the navigation graph with A*, movers with
// stops and collision modes (following, conflict zones, obstacles, crowd avoidance), shared areas between mover sets,
// agendas and a state machine; a coarse queue model over a whole network with individual movers in a focus area,
// and a route search on two levels (regions and gates) with a cache. Imports only base, core and gen-core: it runs headless in plain Node.

export { ByteReader, ByteWriter, hashBytes } from './bytes.ts';
export { EntityTable } from './table.ts';
export type { ColumnSpec, ColumnType, Columns } from './table.ts';
export { EventQueue } from './events.ts';
export type { SimData, SimEvent, SimValue } from './events.ts';
export { Simulation } from './simulation.ts';
export type { Command, CommandHandler, SimState, SimulationOptions, System } from './simulation.ts';
export { approachSpeed, brakeSpeed, isqrt, mm, mmPerTick, mmPerTick2, stoppingDistance } from './fixed.ts';
export { PathSet } from './paths.ts';
export type { Path, PathDef, PathStop } from './paths.ts';
export { NavGraph } from './nav.ts';
export type { NavEdgeInput, NavGraphInput, RouteOptions } from './nav.ts';
export { MOVER_STATE, Movers, POSE_STRIDE, TRANSFORM_STRIDE, capsuleDist2 } from './movers.ts';
export type { Capsule, CollisionMode, KnownObstacles, MoversOptions, SpawnOptions } from './movers.ts';
export { buildZoneIntervals } from './zones.ts';
export type { ZoneIntervals } from './zones.ts';
export { Interlock } from './interlock.ts';
export type { InterlockOptions, SharedArea } from './interlock.ts';
export { StateMachine } from './states.ts';
export type { StateDef } from './states.ts';
export { Agendas } from './agenda.ts';
export type { AgendaActivity, AgendaEntity, AgendaOptions, AgendaPlace } from './agenda.ts';
export { RegionNav } from './regions.ts';
export type { RegionNavOptions } from './regions.ts';
export { FLOW_STATE, FlowNetwork } from './flow.ts';
export type { FlowCensus, FlowMoverOptions, FlowOptions, FlowTrip } from './flow.ts';
export { createFlowProbe, flowProbeLine } from './flow-probe.ts';
export type { FlowProbe, FlowProbeOptions, FlowProbeResult } from './flow-probe.ts';
