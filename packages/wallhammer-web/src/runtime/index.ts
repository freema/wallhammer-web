// Layer 6, runtime: the mediator (`createEngine`, `createHeadlessEngine`: init order, the frame, dispose), the wiring of
// environment → renderer and the screen-space precipitation.

export { EnvironmentLink } from './environment-link.ts';
export type { EnvironmentLinkOptions } from './environment-link.ts';
export { PrecipitationLayer } from './precipitation.ts';
export { PRECIP_FS, PRECIP_VS } from './precipitation-glsl.ts';
export { CLOUD_SHELL_FS, CLOUD_SHELL_VS, CloudShellLayer } from './cloud-shell.ts';
export { SKY_FS, SKY_VS, SkyLayer } from './sky.ts';
export { ATMOSPHERE_FS, ATMOSPHERE_SKY_TABLE, ATMOSPHERE_TABLE_FS, AtmosphereLayer } from './atmosphere.ts';
export { Engine, HeadlessEngine, createEngine, createHeadlessEngine } from './engine.ts';
export type { EngineOptions, EngineView, HeadlessEngineOptions } from './engine.ts';
export { StreamedWorld, WorkerCellProvider, serveCellGenerator, viewTickets, viewerTickets } from './streaming.ts';
/** Kept here for older imports; it lives in base. */
export { boxInVolume } from '../base/view.ts';
export type { StreamArchetype, StreamedWorldOptions, StreamedWorldStats } from './streaming.ts';
