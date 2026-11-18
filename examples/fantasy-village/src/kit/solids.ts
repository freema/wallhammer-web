// Solids for the walking mode: what a content module hands over (`Contribution.solids`) so a walking figure and its
// camera bump into its things. Plain data in world coordinates; src/walk/world.ts turns them into the engine's
// `CollisionWorld` (an upright prism over an outline, or an upright cylinder). Build time only: the helpers allocate.
//
// Rules of thumb for module owners:
//   - a solid is the part of a thing the body must not enter (walls, trunks, posts, the base of a stall), not its
//     overhang (eaves, canopies, crowns): `hullSolid` with `below` takes the outline of the lower part only;
//   - low things a body could step onto (benches, crates, baskets, rocks) are `standable` (the default): a solid
//     that is not standable and lower than a step (0.35 m) is walked through by the engine's walker;
//   - invisible limits (the river, the edge of the map) set `blocksSight: false`, so the camera boom passes them.

import type { MeshBuilder } from './mesh.ts';
import { meshPrismFootprint } from 'wallhammer-web/world';
import { rotateY } from './math.ts';

interface SolidBase {
  /** Bottom and top of the solid, metres (world y). */
  minY: number;
  maxY: number;
  /** Its top can be stood on. Default true. */
  standable?: boolean;
  /** Stops the camera boom. Default true; false for invisible limits. */
  blocksSight?: boolean;
  /** What it is, for the debug view and checks ('inn', 'fence', 'river'). */
  label: string;
}

/** An upright prism over a closed outline (x, z pairs, either winding). */
export interface PrismSolid extends SolidBase {
  shape: 'prism';
  outline: number[];
}

/** An upright cylinder. */
export interface CylinderSolid extends SolidBase {
  shape: 'cylinder';
  x: number;
  z: number;
  radius: number;
}

export type SolidDef = PrismSolid | CylinderSolid;

type Flags = Pick<SolidBase, 'standable' | 'blocksSight'>;

/** A box of `w` × `d` (local x × local z) centred at (x, z), turned by the village yaw (kit/math.ts `rotateY`). */
export function boxSolid(label: string, x: number, z: number, yaw: number, w: number, d: number, minY: number, maxY: number, o: Flags = {}): PrismSolid {
  const outline: number[] = [];
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const) {
    const [dx, dz] = rotateY((sx * w) / 2, (sz * d) / 2, yaw);
    outline.push(x + dx, z + dz);
  }
  return { shape: 'prism', outline, minY, maxY, label, ...o };
}

/** A thin wall of thickness `thick` from (ax, az) to (bx, bz); null when the two points coincide. */
export function segmentSolid(label: string, ax: number, az: number, bx: number, bz: number, thick: number, minY: number, maxY: number, o: Flags = {}): PrismSolid | null {
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < 1e-3) return null;
  const nx = (-dz / L) * (thick / 2), nz = (dx / L) * (thick / 2);
  return { shape: 'prism', outline: [ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, ax - nx, az - nz], minY, maxY, label, ...o };
}

export function cylinderSolid(label: string, x: number, z: number, radius: number, minY: number, maxY: number, o: Flags = {}): CylinderSolid {
  return { shape: 'cylinder', x, z, radius, minY, maxY, label, ...o };
}

/** A prism over a ring of x, z pairs (a building footprint). */
export function ringSolid(label: string, ring: readonly number[], minY: number, maxY: number, o: Flags = {}): PrismSolid {
  return { shape: 'prism', outline: [...ring], minY, maxY, label, ...o };
}

export interface HullOptions extends Flags {
  /** First vertex of the mesh to take (a group appended to a shared builder). Default 0. */
  from?: number;
  /** Only vertices at most this far above the lowest one shape the outline (leave out overhangs). Default: all. */
  below?: number;
  /** Grows (positive) or shrinks (negative) the outline, metres. Default 0. */
  grow?: number;
}

/**
 * The convex outline of a mesh's vertices seen from above, as a prism from the lowest to the highest vertex: a fit for
 * compact things (rocks, barrels, a stall's counter). The engine's `meshPrismFootprint` (points rounded to 5 cm, so
 * the hull of a detailed rock does not need every vertex). Null for an empty mesh.
 */
export function hullSolid(label: string, mesh: MeshBuilder, o: HullOptions = {}): PrismSolid | null {
  const f = meshPrismFootprint(mesh.positionData, { from: o.from ?? 0, ...(o.below !== undefined ? { below: o.below } : {}), grow: o.grow ?? 0, snap: 0.05 });
  if (!f) return null;
  return { shape: 'prism', outline: f.outline, minY: f.minY, maxY: f.maxY, label, ...(o.standable !== undefined ? { standable: o.standable } : {}), ...(o.blocksSight !== undefined ? { blocksSight: o.blocksSight } : {}) };
}

/** Highest vertex y of a mesh from vertex `from` on; −Infinity when empty. */
export function meshTop(mesh: MeshBuilder, from = 0): number {
  return from < mesh.vertexCount ? mesh.bounds(from).max[1] : -Infinity;
}
