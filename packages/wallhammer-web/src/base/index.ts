// Layer 0, base: types and the smallest vector and matrix math. No browser, no GPU, no time.

export { DEG, add, clamp, cross, crossInto, dot, lerp, normalize, orthoMatrix, scale, smoothstep } from './math.ts';
export type { OrthoFrame, RGB, Vec3 } from './math.ts';
export {
  MAT34_FLOATS,
  mat34Copy,
  mat34Determinant,
  mat34Direction,
  mat34FromQuat,
  mat34Identity,
  mat34Invert,
  mat34Multiply,
  mat34Normal,
  mat34Point,
  mat34RotationAxis,
  mat34RotationX,
  mat34RotationY,
  mat34RotationZ,
  mat34Scaling,
  mat34Translation,
} from './mat34.ts';
export type { Mat34, Vec3Out } from './mat34.ts';
export { boxInVolume, depthViewProj, distanceToBox, newCornerRays, newOrthoFrame, snapRenderOrigin, toRenderSpace } from './view.ts';
export type { Box3, CullBox, CullFrustum, CullVolume, DepthMode, DepthProjection, OriginAxes, Ray, View } from './view.ts';
export { primitiveCount, texelBytes } from './data.ts';
export type { InstanceBounds, InstanceData, MeshData, Primitive, ScalarType, TextureData, TextureFormat, TextureSampling, VertexAttrib, VertexLayout } from './data.ts';
export type { BakeDesc, BakeTarget, BlendFactor, BlendSpec, CullMode, DrawState, MaterialDesc, PassName, ShaderSource, UniformValue, Uniforms } from './material.ts';
export type { EnvSlot, FogLayer, FrameEnvironment, FrameField, FrameRegion, LightMode } from './env-slot.ts';
export { DAMAGE, PART_FLAG, PART_ROLE, RUBBLE, entryDir, entryRung, entryVariant, packEntry } from './destructible.ts';
export type { ConvexPiece, DamageEntry, DamageRung, DestructibleMaterial, DestructionEvent, PartRole, RubbleArchetype, RubbleFootprint, StructureBond, StructureDesc, StructurePart, StructureState } from './destructible.ts';
export { RIG_ATTRIBS, RIG_BEND_AXIS, RIG_CLOCK_STEP, RIG_FINISH, RIG_INSTANCE_FLOATS, RIG_INSTANCE_LAYOUT, RIG_MAX_CLOCKS, RIG_MOTION, RIG_SWING_KIND, RIG_VERTEX_FLOATS, RIG_VERTEX_LAYOUT, packRgb, rigClockPhase, rigClockRates, rigExtended, writeRigFrame, writeRigInstance } from './rig.ts';
export type { RigDesc, RigFinish, RigInstance, RigMotion, RigPart, RigSegment, RigShape } from './rig.ts';
export { Progress } from './progress.ts';
export type { ProgressReport, ProgressStage } from './progress.ts';
export { RAD_PER_TURN, detAcos, detAsin, detAtan, detAtan2, detCos, detCosTurns, detSin, detSinCos, detSinCosTurns, detSinTurns } from './trig.ts';
export { FRAME_NONE, FrameSet, directionFromDeg, directionToDeg, quatAxisTurns, quatConj, quatFromAxes, quatIdentity, quatMul, quatNormalize, quatRotate, relativeMatrix, relativePoints, tangentPose } from './frames.ts';
export type { FrameBearing, FramePose, FrameState, Quat } from './frames.ts';
export { radialHeight, radialUpAt, toFramePlane, upFrame } from './up.ts';
export type { RadialUp, UpFrame } from './up.ts';
export { MARK_CATEGORIES, MARK_STATUSES, lastAfterPicture, lastLog, statusOf } from './marks.ts';
export type { Mark, MarkCategory, MarkDraft, MarkLogEntry, MarkPatch, MarkStatus, MarkView, PickHit } from './marks.ts';
