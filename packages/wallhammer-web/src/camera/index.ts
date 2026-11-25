// Layer 5, camera: views, camera rigs and keyframed paths (orbit and free).

export { SteppedOrthoRig } from './camera.ts';
export type { CameraSetup, ViewState } from './camera.ts';
export { DEFAULT_ORBIT, PerspectiveOrbitRig } from './orbit.ts';
export type { OrbitSetup, OrbitState } from './orbit.ts';
export { OrbitPath, blendOrbitState, writeOrbitState } from './path.ts';
export type { OrbitKey, OrbitPathOptions } from './path.ts';
export { DEFAULT_FREE, FreeRig } from './free.ts';
export type { FreeOptions, FreeSetup, FreeState, HeightAbove, UpSource } from './free.ts';
export { FreePath, newFreePose, writeFreePose } from './free-path.ts';
export type { FreeKey, FreePathEase, FreePathOptions, FreePathUp, FreePose } from './free-path.ts';
export { DEFAULT_FOLLOW, FollowRig } from './follow.ts';
export type { BoomClearance, FollowOptions, FollowSetup, FollowState } from './follow.ts';
export { ChartFollowView } from './chart-follow.ts';
