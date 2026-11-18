// The contract between the content modules of the village and the scene assembly (src/render/scene.ts).
// Every content module exports `build(ctx)` and returns a `Contribution`. The assembly owns the GPU: it merges static
// meshes by material into chunks, uploads part sets, packs the lights and the particle emitters, and calls `update`
// every frame. Modules never touch the renderer.
//
// These types are stable: other builders rely on them. Extend only by adding optional fields.
// The drawing side is the engine's: part sets are drawn as engine instance sets (`InstanceSetLayer`, same 16-float
// record), lights go into a `PointLightSet`, emitters into a `ParticleLayer` (see src/render/scene.ts).

import type { InstanceSet, PointLight as EnginePointLight } from 'wallhammer-web/render';
import { INSTANCE_SET_FLOATS } from 'wallhammer-web/render';
import type { Simulation } from 'wallhammer-web/sim';
import type { RGB } from './color.ts';
import type { Mat34, Vec3 } from './math.ts';
import type { MeshBuilder } from './mesh.ts';
import type { Stream } from './rng.ts';
import type { SolidDef } from './solids.ts';
import type { VillageLayout } from '../layout.ts';
import type { HeightField } from '../terrain/height.ts';

/** What a module gets to build with. */
export interface BuildContext {
  /** World seed (from the address, default 7). The same seed builds the same village. */
  readonly seed: number;
  /** The single source of truth for where things are (src/layout.ts). */
  readonly layout: VillageLayout;
  /** Terrain height at a point (src/terrain/height.ts): pure, cheap, valid everywhere. */
  heightAt(x: number, z: number): number;
  /** The whole height field: pad heights of structures (`padY('inn')`), the river at a point, the natural ground. */
  readonly field: HeightField;
  /** A named random stream of this seed: `ctx.stream('inn')`. Use one name per module or part. */
  stream(name: string): Stream;
  /**
   * The engine's fixed-step simulation (10 ticks per second), already running and paused together with the scene.
   * Modules that simulate (villagers) add their states and systems to it during `build`.
   */
  readonly sim: Simulation;
}

/**
 * A static mesh: merged by the assembly with every other static mesh of the same material into spatial chunks
 * (one draw call per visible chunk), so build big batches, never one piece per shingle.
 */
export interface StaticPiece {
  /** 'solid': the main painted material. 'water': the water material (flowing, foam, sky reflection; see below). */
  material: 'solid' | 'water';
  /** Geometry in world coordinates, in the kit vertex format. */
  mesh: MeshBuilder;
  /** Casts sun shadows (default true for solid, ignored for water). */
  castShadow?: boolean;
  /** For statistics and debugging. */
  name?: string;
}

// Water meshes use the same vertex format with these meanings:
//   a_color.rgb  water tint (deep blue-green in the middle, lighter at the banks), a_color.a opacity (0 at the banks)
//   a_flags.x    foam 0–1 (banks, stones, the foot of the weir)
//   a_flags.y    flow speed 0–1 (×4 m/s)
//   a_flags.z/w  flow direction x/z, packed as code = round((d * 0.5 + 0.5) * 255)  (use `waterFlags` in kit/parts.ts)

/**
 * Many copies of one part mesh, each with its own transform and tint, drawn with one instanced draw call and casting
 * shadows. For moving things (villagers' body parts, the mill wheel, windmill sails, chickens) and repeated props.
 * It is the engine's `InstanceSet` (render) with the part it was packed from and two village fields. The owner writes
 * `data` (16 floats per instance, see `writePart`) and `count`; a `dynamic` set is uploaded again in every frame in
 * which `dirty` is true (set it in `update`). Use few sets: every set is a draw call.
 */
export interface PartSet extends InstanceSet {
  readonly name: string;
  /** The part, in its own local coordinates (for example a unit-sized rounded box scaled per instance); `mesh` is it packed. */
  readonly part: MeshBuilder;
  /** Written every frame by `update`. */
  readonly dynamic: boolean;
  /** A group name the controls can address ('villagers', 'animals', …); the V key hides 'villagers'. */
  readonly group?: string;
}

/** Floats per part instance: the engine's instance record (`INSTANCE_SET_FLOATS`). */
export const PART_FLOATS = INSTANCE_SET_FLOATS;

/**
 * A warm point light for the evening (windows, lanterns, forge, hearths): the engine's `PointLight` with the village's
 * evening switch. Up to 32 shine at once. The assembly sets the engine's gain `group` from `when`.
 */
export interface PointLight extends EnginePointLight {
  /** World position; may be moved in `update`. */
  position: Vec3;
  color: RGB;
  /** Reach in metres: the light fades to zero there. */
  radius: number;
  /** Brightness multiplier (1 is a lantern). */
  intensity: number;
  /** 'evening' lights follow dusk (src/env.ts), 'always' lights shine always (fire). */
  when: 'evening' | 'always';
  /** Flicker 0–1 (fire 0.6, lanterns 0.15, windows 0.05). */
  flicker: number;
}

/**
 * A particle emitter. Particles are computed on the GPU from the animation time alone (closed form: no simulation,
 * no allocation, pausing freezes them). Each emitter owns `count` particles that are born one after the other over
 * `life` seconds and loop forever.
 */
export interface ParticleSource {
  /** Smoke, steam and dust blend over the scene; fire and sparks add light. */
  kind: 'smoke' | 'steam' | 'dust' | 'fire' | 'spark';
  position: Vec3;
  /** Particles alive at once (the emitter's share of the fixed budget). */
  count: number;
  /** Seconds a particle lives. */
  life: number;
  /** Size (metres, billboard diameter) at birth and at death. */
  size: readonly [number, number];
  /** Initial upward speed m/s. */
  rise: number;
  /** Radius of the birth disc, and of the random horizontal spread speed (m/s). */
  spread: readonly [number, number];
  /** Downward acceleration m/s² (sparks fall: 6; smoke 0, it rises with `rise`). */
  gravity?: number;
  /** How much the wind carries it (0–1; smoke 1). */
  wind?: number;
  /** Colour and opacity at birth and at death (rgb 0–1, a opacity; fire may exceed 1 in rgb for brightness). */
  colorStart: readonly [number, number, number, number];
  colorEnd: readonly [number, number, number, number];
  /** 'evening' emitters are only visible in the evening (e.g. extra hearth smoke); default 'always'. */
  when?: 'evening' | 'always';
}

/** Per-frame state handed to `update` (one object, reused: do not keep references to it). */
export interface FrameInfo {
  /** Animation time in seconds (stops while paused). */
  time: number;
  /** Seconds since the last frame (0 while paused). */
  dt: number;
  /** 0 in the afternoon … 1 in the evening (src/env.ts): drives windows, lanterns, lights. */
  evening: number;
  /** Interpolation share of the fixed-step simulation (engine `onExtract`). */
  alpha: number;
  /** Eye position of the camera. */
  eye: Vec3;
  /** Villagers shown (the V key). */
  villagersVisible: boolean;
}

/** What a content module returns from `build`. Every field is optional. */
export interface Contribution {
  statics?: StaticPiece[];
  parts?: PartSet[];
  lights?: PointLight[];
  particles?: ParticleSource[];
  /** Called every frame before rendering. Must not allocate (reuse arrays made in `build`). */
  update?(frame: FrameInfo): void;
  /** Numbers for the HUD and `__wh.stats()` (triangles are counted by the assembly). */
  stats?: Record<string, number>;
  /**
   * What a walking figure bumps into (walk mode, src/walk/): walls, trunks, posts, the bridge deck to stand on,
   * invisible limits. Plain data in world coordinates, made with the helpers of kit/solids.ts; nothing is drawn.
   */
  solids?: SolidDef[];
}

/** A content module: one file of the village (src/buildings/inn.ts, src/vegetation/index.ts, …). */
export interface ContentModule {
  readonly name: string;
  build(ctx: BuildContext): Contribution;
}

/** Re-exported for convenience of part writers. */
export type { Mat34, Vec3 };
