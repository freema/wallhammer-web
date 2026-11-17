// Layer 1, platform: the only place that touches the browser. Canvas size, raw input, the frame loop and real time.

export { canvasPixelRatio, observeCanvasSize, resizeCanvas, syncCanvasSize } from './canvas.ts';
export type { Canvas, CanvasSizeTarget } from './canvas.ts';
export { bindCameraInput, bindOrbitInput } from './input.ts';
export type { CameraInputOptions, OrbitControl, OrbitInputOptions, ViewChangeKind, ViewControl } from './input.ts';
export { FrameLoop } from './loop.ts';
export type { FrameLoopOptions, LoopClock } from './loop.ts';
export { WorkerPool, fetchBytes, hardwareThreads, serveWorker, workersAvailable } from './worker.ts';
export type { WorkerAnswer, WorkerJob } from './worker.ts';
export { trackHeldKeys } from './keys.ts';
export type { HeldKeys } from './keys.ts';
export { DEFAULT_FREE_KEYS, bindFreeInput } from './free-input.ts';
export type { FreeControl, FreeInput, FreeInputOptions, FreeKeys } from './free-input.ts';
export { openByteStore } from './byte-store.ts';
export type { ByteStore } from './byte-store.ts';
export { watchContextLoss } from './context-loss.ts';
export type { ContextLossHandlers } from './context-loss.ts';
export { DEFAULT_WALK_KEYS, bindWalkInput } from './walk-input.ts';
export type { WalkInput, WalkInputOptions, WalkInputState, WalkKeys, WalkView } from './walk-input.ts';
