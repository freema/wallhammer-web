// Layer 2, motion: skeletons and poses as data, blend and additive operations, a motion graph of states, transitions,
// layers, parameters, triggers, marks and events over motions the game writes, and post steps (two-bone reach, ends
// kept on the ground, a reach with its own eased weight (also at a socket of another body), a chain aimed at a point,
// a chain that lags behind the motion of what it hangs on, sockets and blends between them), a body carried at a
// socket of another (its root on the socket by an eased weight), the timeline of getting onto such a seat and off it
// (an approach, phases with eased weights and a rising free root, cues as times), and a cycle of steps of several legs driven by the
// distance travelled (where each leg's end should be, for a reach per leg).
// Imports nothing outside itself (it may use base): no GPU, no browser, no clock. The engine holds no motion: every
// pose comes from a `MotionSource` of the game.

export { Pose, Skeleton, boneMask } from './skeleton.ts';
export type { BoneMask, BoneMaskOptions, BoneSpec } from './skeleton.ts';
export { addPose, blendPose, nlerpInto, setBoneAxisAngle, setBoneEuler, setBoneRotation, solvePose, solvePoseBelow, subtractPose } from './pose-ops.ts';
export type { EulerOrder } from './pose-ops.ts';
export { MotionGraph, MotionGraphDef, compileMotionGraph, speedWeights } from './graph.ts';
export type { MotionCondition, MotionEase, MotionEventKind, MotionGraphDesc, MotionLayerDesc, MotionSource, MotionStateDesc, MotionTransitionDesc } from './graph.ts';
export { fitToGround, reachTwoBone } from './reach.ts';
export type { GroundFitOptions, TwoBoneChain } from './reach.ts';
export { WeightFade } from './fade.ts';
export { TwoBoneReach } from './reach-target.ts';
export type { TwoBoneReachOptions } from './reach-target.ts';
export { ChainAim, aimAngles, aimChain } from './aim.ts';
export type { AimAngles, AimChain } from './aim.ts';
export { ChainLag } from './chain-lag.ts';
export type { ChainLagOptions, LagChain } from './chain-lag.ts';
export { IDENTITY_34, SocketBlend, blendTransform, socketTransform } from './socket.ts';
export type { Socket } from './socket.ts';
export { SocketSeat, uprightTransform } from './seat.ts';
export type { SocketSeatOptions } from './seat.ts';
export { SEAT_TRANSITION_STATE_BYTES, SeatTransition, headingRoot } from './seat-transition.ts';
export type { SeatPhase, SeatTransitionOptions, SeatTransitionPhase } from './seat-transition.ts';
export { StepCycle } from './step-cycle.ts';
export type { StepCycleDesc, StepPattern } from './step-cycle.ts';
