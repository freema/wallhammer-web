// Part sets are the engine's instance sets (render `instanceSet`, `writeInstance`, `pushInstance`) with a few village
// fields (see PartSet in kit/types.ts); and the water flags.

import { instanceSet, pushInstance, writeInstance } from 'wallhammer-web/render';
import type { MeshBuilder } from './mesh.ts';
import type { PartSet } from './types.ts';

export interface PartSetOptions {
  /** Rewritten in `update` (default false: written once in `build`). */
  dynamic?: boolean;
  /** Casts sun shadows (default true). */
  castShadow?: boolean;
  group?: string;
}

/**
 * A part set with room for `capacity` instances, none in use yet: an engine instance set over `part` packed now
 * (the part must be complete when the set is made).
 */
export function createPartSet(name: string, part: MeshBuilder, capacity: number, o: PartSetOptions = {}): PartSet {
  return {
    ...instanceSet(part.build(), capacity, { name, castShadow: o.castShadow ?? true }),
    name,
    part,
    dynamic: o.dynamic ?? false,
    ...(o.group ? { group: o.group } : {}),
  };
}

/**
 * Writes instance `index`: the transform (Mat34, local part → world) and a tint (multiplies the part's vertex colours)
 * plus extra glow (0–1 adds emission with the evening channel; 1–2 shines always with glow − 1, e.g. sparks in
 * daylight). The engine's `writeInstance`. No allocation.
 */
export const writePart = writeInstance;

/** Appends an instance (count grows, dirty is set); returns its index, or −1 when the set is full. `pushInstance`. */
export const pushPart = pushInstance;

/** Flags for a water vertex (see the water notes in kit/types.ts): foam, speed and flow direction. */
export function waterFlags(foam: number, speed: number, dirX: number, dirZ: number): { glow: number; sway: number; cls: number; channel: number } {
  const l = Math.hypot(dirX, dirZ) || 1;
  return {
    glow: foam,
    sway: speed,
    cls: Math.round(((dirX / l) * 0.5 + 0.5) * 255),
    channel: Math.round(((dirZ / l) * 0.5 + 0.5) * 255),
  };
}
