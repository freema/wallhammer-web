// The free camera of the endless example, switched on with `cam=free` in the URL hash (the orbit camera stays the
// default). The engine's `FreeRig` does the work: it takes "up" from the world shape and the height above the surface
// from the callback below, which keeps it above the terrain and scales its speed with that height.
//
// URL hash: #cam=free&x=0&z=0&alt=60&yaw=30&pitch=14   (alt: metres above the surface, pitch: positive looks down)
//   follow=1: the camera holds its height above the surface while it moves (key F switches it; off by default)

import { FreeRig } from 'wallhammer-web/camera';
import { SHAPE, surfaceHeight } from './terrain.ts';

/** A place for the free camera. What is left out keeps its current value. */
export interface FreePlace {
  x?: number;
  z?: number;
  /** Metres above the surface. */
  height?: number;
  yawDeg?: number;
  pitchDeg?: number;
  /** Hold the height above the surface while moving (`FreeSetup.followSurface`). */
  follow?: boolean;
}

export const FREE_HELP = 'WASD fly · E/Q up/down · F follow surface · Shift fast · drag look · wheel speed · [ ] hour · L levels · H hide';

/** Views for the shot tool in free mode: from eye level to far above the terrain. */
export const FREE_PRESETS: readonly (FreePlace & { name: string })[] = [
  { name: 'free-low', x: 0, z: 0, yawDeg: 160, pitchDeg: 3, height: 4 },
  { name: 'free-mid', x: 0, z: 0, yawDeg: 160, pitchDeg: 12, height: 250 },
  { name: 'free-high', x: 0, z: 0, yawDeg: 160, pitchDeg: 35, height: 6000 },
  { name: 'free-down', x: 0, z: 0, yawDeg: 30, pitchDeg: 89, height: 1500 },
  { name: 'free-far-low', x: 10_000_000, z: 0, yawDeg: 30, pitchDeg: 5, height: 6 },
];

export function createFreeRig(seed: number, start: FreePlace): FreeRig {
  const rig = new FreeRig({ fovYDeg: 50, minClearance: 3, minSpeed: 5, maxSpeed: 3000 }, { shape: SHAPE, heightAbove: (p) => p[1] - surfaceHeight(seed, p[0], p[2]) });
  placeFreeRig(rig, seed, { height: 60, ...start });
  return rig;
}

/** Puts the rig over (x, z) at a height above the surface there. */
export function placeFreeRig(rig: FreeRig, seed: number, v: FreePlace): void {
  const p = rig.position;
  const x = v.x ?? p[0];
  const z = v.z ?? p[2];
  const height = v.height ?? (Number.isFinite(rig.clearance) ? rig.clearance : 60);
  if (v.follow !== undefined) rig.setup.followSurface = v.follow;
  rig.setState({ position: [x, surfaceHeight(seed, x, z) + height, z], yawDeg: v.yawDeg, pitchDeg: v.pitchDeg });
}

/** The camera part of the URL hash. */
export function freeHash(rig: FreeRig): string {
  const s = rig.state();
  return `cam=free&x=${s.position[0].toFixed(1)}&z=${s.position[2].toFixed(1)}&alt=${rig.clearance.toFixed(1)}&yaw=${s.yawDeg.toFixed(1)}&pitch=${s.pitchDeg.toFixed(1)}${rig.setup.followSurface ? '&follow=1' : ''}`;
}
