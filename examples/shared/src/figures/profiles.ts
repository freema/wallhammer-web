// Movement profiles: how a figure carries its weight, as plain numbers. Each names the walker's speeds and rates (the
// engine's `WalkerTuning`: a run-up, braking, a turn that widens with speed) and the gait's stride and lean
// (`GaitOptions`). A page builds its walker and its figure's gait from one profile and may switch between them
// (`Walker.retune` and a new gait).
//
//   default   brisk: a run-up of two thirds of a second, a stop in under a metre from a run, a running turn of 1.8 m
//   heavy     a loaded body: slower, a long run-up and a long stop, wide turns at a run, long slow steps, a deep lean
//   light     quick: fast starts and stops, tight turns, short steps, little lean
//
// The distance of a stop from a run is runSpeed² / (2 deceleration); the radius of a turn at a run is
// runSpeed / turnSpeedAtRun, and no tighter than runSpeed² / max(acceleration, deceleration), which these keep.

import type { WalkerTuning } from 'wallhammer-web/world';

export interface MoveProfile {
  readonly name: string;
  /** The walker's numbers (over the page's own setup). */
  readonly walker: Readonly<WalkerTuning>;
  /** The gait's numbers: `GaitOptions.strideScale` and `GaitOptions.lean`. */
  readonly gait: { readonly strideScale: number; readonly lean: number };
}

export const MOVE_PROFILES: Readonly<Record<'default' | 'heavy' | 'light', MoveProfile>> = {
  default: {
    name: 'default',
    walker: { walkSpeed: 1.4, runSpeed: 4.6, acceleration: 12, runAcceleration: 7, deceleration: 12, turnSpeed: 8, turnSpeedAtRun: 2.5, airControl: 0, airTurnSpeed: 0, jumpSpeed: 4.2 },
    gait: { strideScale: 1, lean: 0.8 },
  },
  heavy: {
    name: 'heavy',
    walker: { walkSpeed: 1.2, runSpeed: 3.8, acceleration: 6, runAcceleration: 3.5, deceleration: 6, turnSpeed: 5, turnSpeedAtRun: 1.5, airControl: 0, airTurnSpeed: 0, jumpSpeed: 3.6 },
    gait: { strideScale: 1.12, lean: 1.2 },
  },
  light: {
    name: 'light',
    walker: { walkSpeed: 1.6, runSpeed: 5.2, acceleration: 16, runAcceleration: 11, deceleration: 18, turnSpeed: 12, turnSpeedAtRun: 3.4, airControl: 0.05, airTurnSpeed: 1, jumpSpeed: 4.6 },
    gait: { strideScale: 0.9, lean: 0.6 },
  },
};

/** The profile names in the order a key cycles them. */
export const MOVE_PROFILE_NAMES = ['default', 'heavy', 'light'] as const;
export type MoveProfileName = (typeof MOVE_PROFILE_NAMES)[number];

/** The profile of a name (a hash parameter), or the default one. */
export function moveProfile(name: string | null | undefined): MoveProfile {
  return (MOVE_PROFILES as Record<string, MoveProfile>)[name ?? ''] ?? MOVE_PROFILES.default;
}

/** The profile after `name` in `MOVE_PROFILE_NAMES`. */
export function nextMoveProfile(name: string): MoveProfile {
  const i = MOVE_PROFILE_NAMES.indexOf(name as MoveProfileName);
  return MOVE_PROFILES[MOVE_PROFILE_NAMES[(i + 1) % MOVE_PROFILE_NAMES.length]!];
}
