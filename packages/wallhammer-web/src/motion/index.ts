// Layer 2, motion: skeletons and poses as data, blend and additive operations, a motion graph of states, transitions,
// layers, parameters, triggers, marks and events over motions the game writes, and post steps (two-bone reach, ends
// kept on the ground). Imports nothing outside itself (it may use base): no GPU, no browser, no clock. The engine holds no
// motion: every pose comes from a `MotionSource` of the game.

export { Pose, Skeleton, boneMask } from './skeleton.ts';
export type { BoneMask, BoneMaskOptions, BoneSpec } from './skeleton.ts';
export { addPose, blendPose, nlerpInto, setBoneAxisAngle, setBoneEuler, setBoneRotation, solvePose, solvePoseBelow, subtractPose } from './pose-ops.ts';
export type { EulerOrder } from './pose-ops.ts';
export { MotionGraph, MotionGraphDef, compileMotionGraph, speedWeights } from './graph.ts';
export type { MotionCondition, MotionEase, MotionEventKind, MotionGraphDesc, MotionLayerDesc, MotionSource, MotionStateDesc, MotionTransitionDesc } from './graph.ts';
export { fitToGround, reachTwoBone } from './reach.ts';
export type { GroundFitOptions, TwoBoneChain } from './reach.ts';
