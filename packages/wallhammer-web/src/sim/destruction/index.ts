// sim/destruction: tier A destruction. Pure functions over structure descriptions (base/destructible.ts) and their
// damage states: what an event breaks, what loses support, where rubble lies, and the compact, hashable state.
// No GPU, no DOM, no clock; runs in Node. Feeding events from the simulation's queue is a later step.

export { TIMELINE, TIMELINE_TICK_S, applyEvent, applyEventToAll, destructionEvent, fallTimeline } from './apply.ts';
export type { ChangeCause, DestructionOptions, DestructionResult, PartChange } from './apply.ts';
export { compileStructure, solveSupport, UNSUPPORTED } from './structure.ts';
export type { CompiledStructure } from './structure.ts';
export { partRubble, rubbleFootprints, ruinRubble } from './rubble.ts';
export { decodeStates, encodeStates, intactState, isIntact, sortedEntries, stateHash } from './state.ts';
export { raycastParts } from './pick.ts';
export type { PartHit } from './pick.ts';
export { octant, pieceDistSq } from './int-geometry.ts';
export { CELL_STATES_CHARS_PER_UNIT, CellStates, DEFAULT_MAX_UNITS, decodeCellStates } from './cell-states.ts';
export type { CommitResult } from './cell-states.ts';
