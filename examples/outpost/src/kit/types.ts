// The content contract of the outpost. A content module (src/modules.ts lists them) gets a BuildContext and returns
// a Contribution: static pieces, instanced part sets that may move, and an optional per-frame update. Simulation-side
// state is registered on the simulation itself (`sim.addState`), so a jump to a tick needs nothing from the module. The scene
// (render/scene.ts) turns contributions into engine layers; a module never touches the renderer.

import type { InstanceSet } from 'wallhammer-web/render';
import type { Layout } from '../layout.ts';
import type { MeshBuilder } from './mesh.ts';
import type { Stream } from './rng.ts';

/**
 * How a static piece is drawn:
 *   'solid'    casts and receives shadows; its triangles marked `outline` get the outline hull (the default)
 *   'decal'    lies on another surface (tracks, pad markings): pulled toward the eye by a depth offset, casts no
 *              shadow, no outline hull (its panel lines still draw)
 *   'backdrop' far away (the ridges on the horizon): no shadow casting, outline hull as marked
 */
export type PieceKind = 'solid' | 'decal' | 'backdrop';

export interface StaticPiece {
  /** For statistics and `pnpm inspect`. */
  name: string;
  mesh: MeshBuilder;
  kind?: PieceKind;
}

export interface FrameInfo {
  /** Animation time, seconds: the simulation's ticks and the share of the next one (stands while paused). */
  time: number;
  /** Animation time since the last update (0 while paused). */
  dt: number;
  /** Interpolation share of the simulation tick (engine extraction). */
  alpha: number;
  /** The eye of the current view. */
  eye: [number, number, number];
}

export interface Contribution {
  statics?: StaticPiece[];
  /**
   * Instance sets of the engine (render): one mesh, a record per copy (the 3 × 4 transform, then a tint r, g, b that
   * multiplies the vertex colours, and a free number). A module that rewrites records sets `dirty`.
   */
  parts?: InstanceSet[];
  /** Runs once per drawn frame in which the animation time moved (and once at the start). */
  update?(frame: FrameInfo): void;
  /** Named counts the module keeps up to date (footfalls, …), for `__wh.stats` and `pnpm inspect`. */
  counters?: Readonly<Record<string, number>>;
}

export interface BuildContext {
  readonly seed: number;
  readonly layout: Layout;
  /** Ground height at a point (terrain/height.ts), including craters and flattened pads. */
  heightAt(x: number, z: number): number;
  /** A named seeded stream of the world seed. */
  rng(name: string): Stream;
}

export interface OutpostModule {
  name: string;
  build(ctx: BuildContext): Contribution;
}
