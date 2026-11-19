// Generic renderer: a shadow map pass from the main directional light, then the main pass, then an overlay pass.
// It knows meshes, materials and passes, nothing about what they show. Everything drawn comes from layers registered
// from outside, drawn in registration order in every pass. The shadow map is refitted only when the view, the light
// direction or `shadowKeyExtra` changes, so a static frame is a single pass. Layers whose casters move
// (`shadowCasters: 'dynamic'`) are drawn over a kept copy of the static casters' depth in the frames where they
// changed (`shadowDirty`), so a moving part costs its own triangles, not the whole scene's (mode `'single'`).
//
// Depth. The shadow pass always draws standard depth into its depth target. The main passes (`color`, `data`,
// `overlay`) follow the renderer's depth mode (`RendererOptions.depth`, default `'standard'`): the device owns the
// convention of the bound target (clear value, comparison, sign of the polygon offset, clip range), the renderer
// builds the matching view matrix (`depthViewProj`) and, in the logarithmic mode, wraps every fragment shader of the
// main target so that it writes its depth itself (`resolve`). Layers and materials are the same in every mode.
//
// Shadow modes (`RendererOptions.shadows`, default `'single'`: the one fitted map described above). `'snapped'` and
// `'cascades'` keep square areas of the light's plane in the map instead (shadow-areas.ts): fixed to the world's texel
// grid, following a focus in whole blocks and redrawn only where they newly cover something, or as a whole when the
// light or the scene changes. Beyond their reach the lookup falls back to a term baked by the material or to the
// scene's light horizon texture (`shadowHorizon`). The lookup lives in the program header (shadow-glsl.ts).

import { cross, dot, normalize, orthoMatrix } from '../base/math.ts';
import type { OrthoFrame, RGB, Vec3 } from '../base/math.ts';
import { depthViewProj, newCornerRays, newOrthoFrame } from '../base/view.ts';
import type { CullVolume, DepthMode, DepthProjection, Ray, View } from '../base/view.ts';
import type { InstanceBounds, InstanceData, MeshData, TextureData } from '../base/data.ts';
import type { BakeDesc, DrawState, MaterialDesc, PassName, ShaderSource, Uniforms } from '../base/material.ts';
import type { DepthTarget, Device, InstanceBuffer, MainSamples, Mesh, Program, Texture, UniformBlock } from '../gpu/index.ts';
import { UBO_BINDING } from '../gpu/index.ts';
import { LOCAL_UP_DEFINE, LOCAL_UP_FLOATS, LOCAL_UP_GLSL, LOCAL_UP_MEMBER, LOG_DEPTH_EPILOGUE, LOG_DEPTH_PRELUDE, NOISE, PIXEL_SIZE_GLSL, frameBlockFloats, shaderHeader } from './glsl.ts';
import type { RadialUp } from '../base/up.ts';
import type { FrameSlotSizes, FrameSlotsGlsl } from './glsl.ts';
import { DEPTH_FS, DEPTH_VS, SHADOW_AREAS_GLSL, SHADOW_AREAS_MAX, SHADOW_HORIZON_UNIT, shadowAreaFloats, shadowAreaMembers } from './shadow-glsl.ts';
import { AREA_BLOCKS, AREA_REACH_BLOCKS, followFocus, ladderStep, lightFrame, newShadowArea } from './shadow-areas.ts';
import type { AreaRect, ShadowArea } from './shadow-areas.ts';

export type { InstanceBounds, PassName };

/** Texture unit that holds the shadow map during the `color` and `data` passes. */
export const SHADOW_MAP_UNIT = 0;

export interface DrawContext {
  readonly device: Device;
  readonly pass: PassName;
  readonly view: View;
  /** World → light clip matrix of the shadow pass. Depth programs read it as `u_lightRender`. */
  readonly lightRender: Float32Array;
  /** Records one draw call with this many triangles in the frame statistics. */
  count(triangles: number): void;
}

export interface Layer {
  /** Optional name for profiles and statistics (`profileFrame` in `tools`). Nothing else reads it. */
  name?: string;
  /**
   * `'dynamic'`: this layer's shadow casters move; they are redrawn over the kept static shadow map. Default
   * `'static'`. With at least one dynamic layer the shadow mode `'single'` keeps a second depth map with the static
   * casters only and, in a frame where a dynamic layer reports `shadowDirty`, copies it into the map that is sampled
   * and draws only the dynamic layers over it. Around that draw a dynamic layer's `cull` is called with the light's
   * volume and then with the view's, as at a refit. The other shadow modes redraw the whole map instead.
   */
  shadowCasters?: 'static' | 'dynamic';
  /**
   * Dynamic layers only: asked once per frame; true when what the layer casts changed since it was last drawn into the
   * shadow map. The application never needs `invalidateShadows` for such a layer.
   */
  shadowDirty?(): boolean;
  /** Draws whatever this layer has for `ctx.pass`. The pass base state is set before and restored after. */
  draw(ctx: DrawContext): void;
  /**
   * Called when the shadow map is refitted: first with the light's volume (`'shadow'`) right before the shadow pass,
   * then with the view's volume (`'view'`) for the passes that follow. Returns how many instances were kept.
   * `view` is the view of the frame (for choices by distance or pixel size).
   */
  cull?(volume: CullVolume, purpose: 'shadow' | 'view', view: View): number;
  /**
   * Optional. True when the layer's culled sets are out of date (something was added or removed since the last
   * `cull`). The renderer then refits the shadow map and culls every layer again in the same frame.
   */
  cullStale?(): boolean;
  /**
   * Optional. Called once in every frame that draws the scene, after the Frame block of the frame is uploaded and
   * before the first pass: the place to draw into the layer's own targets (`Device.fill`), so that no pass is
   * interrupted for it. Programs used here see the Frame block of this frame.
   */
  prepare?(device: Device, view: View): void;
}

/**
 * Hooks for measuring frames (`Renderer.probe`, used by `profileFrame` in `tools`). Unset in normal use; then the
 * renderer calls nothing of it and does no extra work.
 */
export interface RenderProbe {
  /**
   * Asked for every layer before its `draw` in a pass, and before its `prepare` (`'prepare'`). False leaves the layer
   * out of that call in this frame. Culling is not affected.
   */
  draws?(layer: Layer, pass: PassName | 'prepare'): boolean;
  /** Called after every `draw` of a layer with the triangles and calls it counted in that pass. */
  drawn?(layer: Layer, pass: PassName, triangles: number, calls: number): void;
}

/**
 * How the shadow map is laid out.
 * - `'single'` (default): one map fitted to what the view sees, redrawn whenever the view changes.
 * - `'snapped'`: one map over a square of the light's plane around the centre of the view, fixed to the world's texel
 *   grid. It is kept between frames: nothing is drawn while neither the light nor the scene changes, and a pan
 *   draws only the border it uncovers. Its size follows the scale of the view up to `reachM`. For views from above
 *   over a large scene.
 * - `'cascades'`: several maps around the eye, each reaching farther and coarser than the one before, blended into
 *   each other. Sharp shadows near the eye and shadows kilometres away in one perspective view; each map is kept
 *   until the eye has moved a sixteenth of its edge.
 * In the last two modes the light may stand straight above, and beyond the reach the lookup falls back to
 * `sunVisibilityBaked`'s term and to `Renderer.shadowHorizon`.
 */
export type ShadowMode = 'single' | 'snapped' | 'cascades';

/** Settings of the shadow modes other than `'single'`. */
export interface ShadowOptions {
  /** Default `'single'`: the renderer behaves exactly as without this object. */
  mode?: ShadowMode;
  /**
   * How far from the focus (the centre of the view; the eye in `'cascades'` with a perspective view) the maps reach,
   * metres. `'snapped'`: the largest reach the map grows to when the view zooms out, default 2048 (never less than
   * the reach of the finest map, which the softness and the map size give). `'cascades'`: the reach of the last
   * map, default `shadowDistanceM` when that is set, else 4000.
   */
  reachM?: number;
  /** `'cascades'`: number of maps, 2–4. Default 4. They share the shadow map, each a quarter of it. */
  cascades?: number;
  /** `'cascades'`: reach of the first map, metres. Default 48. The others follow in equal ratios up to `reachM`. */
  firstReachM?: number;
}

/**
 * The light horizon of the scene, the far term of the shadow modes `'snapped'` and `'cascades'`: a texture over a
 * rectangle of the x–z plane that holds, per texel, the height below which a point is hidden from the light
 * (`lightHorizon` and `horizonTexture` in `gen-tex` make one). Positions are in world coordinates (the renderer
 * subtracts `worldOrigin`). It belongs to one light direction: make a new one when the light has moved.
 */
export interface ShadowHorizon {
  /** `rg8`, linear: the height is `baseY + code / 65535 × rangeM` (high byte in red). Code 0: nothing hides a point there, whatever its height. */
  texture: Texture;
  /** World x and z of the texture's corner at coordinate (0, 0). */
  originX: number;
  originZ: number;
  /** Extent of the texture along x and z, metres. */
  sizeX: number;
  sizeZ: number;
  baseY: number;
  rangeM: number;
  /** Height over which the term fades from lit (at the horizon) to hidden (below it), metres. Default 2. */
  blendM?: number;
}

export interface RendererOptions {
  /** Penumbra width in metres. Limited by the shadow map resolution. */
  shadowSoftnessM?: number;
  /** Shadow map edge in pixels. */
  shadowMapSize?: number;
  /** Perspective views only: how far from the eye shadows reach, in metres. Default: the whole scene. */
  shadowDistanceM?: number;
  /** Layout of the shadow map (`ShadowOptions`). Default: the single fitted map, unchanged. */
  shadows?: ShadowOptions;
  /** Colour table for the Palette block (vec4 rows). */
  palette: Float32Array;
  /** The owner's slots in the Frame block: sizes in vec4 and their GLSL member declarations. Default none. */
  frameSlots?: FrameSlotSizes & { glsl: FrameSlotsGlsl };
  /**
   * How the main passes store depth (`DepthMode`). `'reversed'` and `'logarithmic'` let one perspective view hold
   * a metre and a thousand kilometres; `'reversed'` falls back to `'logarithmic'` where the browser lacks
   * `EXT_clip_control` (`Renderer.depthMode` tells which is in effect). For these two create the context with
   * `createContext(canvas, mode)`. Default: the device's mode, which is `'standard'` unless it was changed.
   */
  depth?: DepthMode;
  /** Reversed and logarithmic depth with a perspective view: distance of the near plane in metres. Default 0.1. */
  depthNearM?: number;
  /**
   * Samples per pixel of the main target: 0 (no antialiasing), 2 or 4 (`Device.setMainSamples`). Create the context
   * with the same count, `createContext(canvas, depth, samples)` (the engine does). Default: unchanged, the canvas's
   * own antialiasing in the standard depth mode, 4 samples in the others.
   */
  samples?: MainSamples;
  /**
   * Makes the depth of the main target readable in the standard depth mode (`Device.setReadableDepth`): the frame is
   * drawn offscreen and copied to the canvas, so `Device.sceneDepth()` works there too. Create the context with
   * `createContext(canvas, depth, samples, true)` (the engine does). Default off; the other depth modes can always
   * read it.
   */
  readableDepth?: boolean;
  /**
   * Up that points away from a point instead of along +y, for a world wrapped round that point (`center` in world
   * metres, as `worldOrigin` is). Program headers then define `WH_LOCAL_UP` and the Frame block ends with
   * `u_upCenter`; the header functions `localUp`, `localHeight` and `localFrame`, the lighting include, rigs and
   * instance culling follow it. Default: unset, up is +y everywhere and nothing changes.
   */
  radialUp?: RadialUp;
}

/** Axis-aligned extent of everything drawn. */
export interface SceneBounds {
  min: Vec3;
  max: Vec3;
}

export interface FrameStats {
  /** Triangles and calls of the main passes. */
  triangles: number;
  drawCalls: number;
  /** Triangles and calls of the shadow pass when it was recomputed in this frame, otherwise 0. */
  shadowTriangles: number;
  shadowDrawCalls: number;
  /**
   * The part of `shadowTriangles` and `shadowDrawCalls` drawn by layers with `shadowCasters: 'dynamic'` over the kept
   * static map (mode `'single'`). 0 without such layers or in a frame that did not redraw them.
   */
  dynamicShadowTriangles: number;
  dynamicShadowDrawCalls: number;
  /** Processor time to assemble the frame in ms (without waiting for the graphics). */
  cpuMs: number;
  shadowMapPx: number;
  /** Instances kept by the layers' last view culling. */
  instancesVisible: number;
  /**
   * Rectangles of the shadow map drawn in this frame: 0 when the map was kept as it is, 1 for a whole map in the
   * mode `'single'`, in the other modes the number of whole areas and border strips drawn.
   */
  shadowUpdates: number;
}

/** A compiled material: a program per pass, its attribute locations and draw state. */
export class Material {
  readonly name: string;
  readonly attribs: Readonly<Record<string, number>>;
  readonly state: Partial<Record<PassName, DrawState>>;
  private readonly programs = new Map<PassName, Program>();

  /** `resolve` turns a shader source of the given pass into what is compiled (includes, see `Renderer.resolve`). */
  constructor(device: Device, desc: MaterialDesc, resolve: (src: string, pass: PassName) => string = (src) => src) {
    this.name = desc.name;
    this.attribs = desc.attribs;
    this.state = desc.state ?? {};
    for (const [pass, src] of Object.entries(desc.passes) as [PassName, ShaderSource | 'depth'][]) {
      const s = src === 'depth' ? { vs: DEPTH_VS, fs: DEPTH_FS } : { vs: resolve(src.vs, pass), fs: resolve(src.fs, pass) };
      this.programs.set(pass, device.program(`${desc.name} ${pass}`, s.vs, s.fs, desc.attribs));
    }
  }

  /** Passes this material has a program for. */
  get passes(): PassName[] {
    return [...this.programs.keys()];
  }

  /** Program for a pass. The `data` pass falls back to the `color` program. */
  program(pass: PassName): Program | null {
    return this.programs.get(pass) ?? (pass === 'data' ? (this.programs.get('color') ?? null) : null);
  }
}

/** The penumbra should cover at least this many shadow map texels. Fewer gives stair-steps, more wastes resolution. */
const PENUMBRA_TEXELS = 4.5;
const SHADOW_MIN_PX = 512;
/** Step by which the shadow map viewport size changes. Keeps the texel size constant when panning. */
const SHADOW_SIZE_STEP_M = 16;
/** Depth offset of the shadow pass, scaled by the surface slope, so a surface does not shadow itself. */
const SHADOW_OFFSET: readonly [number, number] = [2.0, 4.0];

/** Shadow areas: share of an area's reach over which it blends into the next area, and the last one into the far term. */
const AREA_BLEND = 0.15;
const AREA_BLEND_LAST = 0.25;
/** Shadow areas: the depth range along the light follows the scene extent in steps of this many metres. */
const AREA_DEPTH_STEP_M = 16;

/** State of the shadow modes that keep areas in the map (`'snapped'`, `'cascades'`). */
interface AreaState {
  mode: 'snapped' | 'cascades';
  areas: ShadowArea[];
  /** Texels along the edge of one area in the map, and texels per block. */
  px: number;
  blockPx: number;
  reachM: number;
  firstReachM: number;
  /** `'snapped'`: the current step of the block size ladder, −1 before the first frame. */
  step: number;
  /** View key at the last view culling. */
  viewKey: string;
  /** What the areas add to the end of the Frame block. */
  tail: Float32Array;
  /** Bound in place of a light horizon texture while there is none. */
  noHorizon: Texture;
}

/** What one frame does with the shadow areas. */
interface AreaPlan {
  frame: OrthoFrame;
  /** Coordinates of the render origin along the light plane's axes and along the light, metres from the world origin. */
  ox: number;
  oy: number;
  /** Centre and half extent of the depth range along the light, in render space. */
  cz: number;
  halfD: number;
  /** Rectangles to draw, per area. */
  draws: { area: number; rects: AreaRect[] }[];
  /** The view's own culled sets must be made anew. */
  viewStale: boolean;
  key: string;
  viewKey: string;
}

const BASE_STATE: Required<DrawState> = {
  depthTest: true,
  depthFunc: 'less',
  depthWrite: true,
  cullBack: true,
  cull: 'back',
  blend: null,
  alphaToCoverage: false,
  polygonOffset: null,
};
const SHADOW_STATE: Required<DrawState> = { ...BASE_STATE, polygonOffset: SHADOW_OFFSET };

export class Renderer {
  readonly device: Device;
  readonly layers: Layer[] = [];
  /** Called at the start of every frame, before anything is read from the renderer's fields. */
  readonly beforeFrame: ((view: View) => void)[] = [];
  /** Extent of the scene; `null` draws only the background. */
  bounds: SceneBounds | null = null;
  /**
   * World position of the render-space origin, for a world drawn relative to a moving origin (double precision, CPU
   * only). Shadow map texels snap to the world grid instead of the render-space grid, so a rebase does not shift them.
   */
  worldOrigin: Vec3 = [0, 0, 0];
  background: RGB = [0, 0, 0];
  /** Unit direction toward the main directional light. */
  lightDirection: Vec3 = [0, 1, 0];
  /** Anything besides the view and the light direction that changes shadows (environment slots contribute to it). */
  shadowKeyExtra = '';
  /** `'data'` draws the `data` pass instead of `color` and skips `overlay`. */
  mode: 'color' | 'data' = 'color';
  /** Contents of the owner's slots in the Frame block, uploaded every frame. */
  readonly frameSlots: { afterLight: Float32Array; afterView: Float32Array };
  /** Shader includes by name (`#include <name>` on a line of its own). `header` and `noise` are built in. */
  readonly includes = new Map<string, string>();
  lastStats: FrameStats = { triangles: 0, drawCalls: 0, shadowTriangles: 0, shadowDrawCalls: 0, dynamicShadowTriangles: 0, dynamicShadowDrawCalls: 0, cpuMs: 0, shadowMapPx: 0, instancesVisible: 0, shadowUpdates: 0 };
  /** The depth mode of the main passes in effect (after the fallback from `'reversed'` to `'logarithmic'`). */
  readonly depthMode: DepthMode;
  /** Reversed and logarithmic depth with a perspective view: distance of the near plane in metres. */
  depthNearM: number;
  /** Measuring hooks (`RenderProbe`). Null in normal use; set only while profiling and reset afterwards. */
  probe: RenderProbe | null = null;

  private readonly shadowSoftnessM: number;
  private shadowMapSize: number;
  private readonly shadowDistanceM: number;
  private readonly frameBlock: UniformBlock;
  private readonly frameData: Float32Array;
  private readonly shadowTarget: DepthTarget;
  private shadowKey = '';
  private lightRender: Float32Array = new Float32Array(16);
  private lightSample: Float32Array = new Float32Array(16);
  private shadowPx = 0;
  private shadowTexelM = 1;
  private instancesVisible = 0;
  private lightFit: { frame: OrthoFrame; cx: number; cy: number; half: number } | null = null;
  /** The shadow mode in effect. */
  readonly shadowMode: ShadowMode;
  /**
   * Shadow modes `'snapped'` and `'cascades'`: the scene's light horizon, used beyond the reach of the shadow map, or
   * null for none (points out there are then lit unless the material bakes its own term). May be replaced at any
   * time; the texture stays the caller's to delete.
   */
  shadowHorizon: ShadowHorizon | null = null;
  private readonly areaState: AreaState | null = null;
  /** The radial up this renderer was made with, or null when up is +y. */
  readonly radialUp: RadialUp | null;

  /** Mode `'single'` with dynamic casters: the depth map that holds only the static casters; made with the first dynamic layer. */
  private staticShadow: DepthTarget | null = null;
  /** Whether the last frame had a dynamic layer. */
  private hadDynamic = false;
  /** Mode `'single'`: what the kept map was fitted to (view key, light direction in 1e-4 steps, `shadowKeyExtra`). */
  private singleKeyValid = false;
  private singleKeyView = '';
  private readonly singleKeyLight = new Float64Array(3);
  private singleKeyExtra = '';
  /** Instances kept by the static layers at the last view culling of a refit. */
  private staticVisible = 0;
  /** The light's volume of the last refit (mode `'single'`), and the view's volume of the last culling with its key. */
  private lightVolume: CullVolume | null = null;
  private viewVolume: CullVolume | null = null;
  private viewVolumeKey = '';
  /** Preallocated per-frame scratch, so a frame that changes nothing allocates nothing here. */
  private readonly proj: DepthProjection = { viewProj: new Float32Array(16), logScale: 0 };
  private readonly camAxes: OrthoFrame = newOrthoFrame();
  private readonly rays: Ray[] = newCornerRays();
  private readonly sceneCenter: Vec3 = [0, 0, 0];
  private readonly singleRender = new Float32Array(16);
  private readonly singleSample = new Float32Array(16);
  private readonly countMain = { tris: 0, calls: 0 };
  private readonly countShadow = { tris: 0, calls: 0 };
  private readonly countDynamic = { tris: 0, calls: 0 };
  /** The draw context handed to the layers, refilled for every pass. */
  private readonly ctx: { device: Device; pass: PassName; view: View; lightRender: Float32Array; count(triangles: number): void };
  private counting: { tris: number; calls: number } = this.countMain;

  constructor(device: Device, options: RendererOptions) {
    this.device = device;
    this.shadowSoftnessM = options.shadowSoftnessM ?? 0.9;
    this.shadowMapSize = options.shadowMapSize ?? 4096;
    this.shadowDistanceM = options.shadowDistanceM ?? Infinity;
    this.depthMode = options.depth !== undefined ? device.setDepthMode(options.depth) : device.depthMode;
    if (options.samples !== undefined) device.setMainSamples(options.samples);
    if (options.readableDepth) device.setReadableDepth(true);
    this.depthNearM = options.depthNearM ?? 0.1;
    const slots = options.frameSlots ?? { afterLight: 0, afterView: 0, glsl: { afterLight: '', afterView: '' } };
    this.shadowMode = options.shadows?.mode ?? 'single';
    // Local up: with `radialUp` one more member closes the Frame block; without it the header text is unchanged.
    this.radialUp = options.radialUp ?? null;
    const upDefines = this.radialUp ? LOCAL_UP_DEFINE : '';
    const upMember = this.radialUp ? LOCAL_UP_MEMBER : '';
    const upFloats = this.radialUp ? LOCAL_UP_FLOATS : 0;
    if (this.shadowMode === 'single') {
      this.includes.set('header', shaderHeader(slots.glsl, this.depthMode, this.radialUp ? { defines: upDefines, frameTail: upMember } : {}) + LOCAL_UP_GLSL + PIXEL_SIZE_GLSL);
      this.frameData = new Float32Array(frameBlockFloats(slots) + upFloats);
    } else {
      // One area fills the map and is addressed around its edges; several share it in a 2 × 2 grid of parts.
      const o = options.shadows ?? {};
      const count = this.shadowMode === 'snapped' ? 1 : Math.max(2, Math.min(SHADOW_AREAS_MAX, Math.round(o.cascades ?? SHADOW_AREAS_MAX)));
      const px = Math.max(AREA_BLOCKS, Math.floor(this.shadowMapSize / (count === 1 ? 1 : 2) / AREA_BLOCKS) * AREA_BLOCKS);
      this.shadowMapSize = count === 1 ? px : px * 2;
      const reachM = o.reachM ?? (this.shadowMode === 'snapped' ? 2048 : Number.isFinite(this.shadowDistanceM) ? this.shadowDistanceM : 4000);
      const firstReachM = Math.min(Math.max(1, o.firstReachM ?? 48), reachM);
      this.areaState = {
        mode: this.shadowMode,
        areas: Array.from({ length: count }, newShadowArea),
        px,
        blockPx: px / AREA_BLOCKS,
        reachM,
        firstReachM,
        step: -1,
        viewKey: '',
        tail: new Float32Array(shadowAreaFloats(count)),
        noHorizon: device.pixelTexture([0, 0, 0, 0]),
      };
      const header = shaderHeader(slots.glsl, this.depthMode, { defines: `#define WH_SHADOW_AREAS ${count}\n` + upDefines, frameTail: shadowAreaMembers(count) + upMember });
      this.includes.set('header', header + LOCAL_UP_GLSL + PIXEL_SIZE_GLSL + SHADOW_AREAS_GLSL);
      this.frameData = new Float32Array(frameBlockFloats(slots) + shadowAreaFloats(count) + upFloats);
      device.fixSampler('u_shadowHorizonMap', SHADOW_HORIZON_UNIT);
    }
    this.includes.set('noise', NOISE);
    this.frameSlots = { afterLight: new Float32Array(slots.afterLight * 4), afterView: new Float32Array(slots.afterView * 4) };
    this.frameBlock = device.uniformBlock(UBO_BINDING.Frame, this.frameData, true);
    device.uniformBlock(UBO_BINDING.Palette, options.palette, false);
    this.shadowTarget = device.depthTarget(this.shadowMapSize, this.areaState?.areas.length === 1);
    // After a context loss the shadow map is empty: draw it again.
    device.onRestored(() => this.invalidateShadows());
    const self = this;
    this.ctx = {
      device,
      pass: 'color',
      view: null as unknown as View,
      lightRender: this.lightRender,
      count(triangles: number): void {
        self.counting.tris += triangles;
        self.counting.calls++;
      },
    };
  }

  /** Edge of the shadow map texture in pixels (`FrameStats.shadowMapPx` is the part of it in use). */
  get shadowMapEdgePx(): number {
    return this.shadowMapSize;
  }

  /**
   * The depth projection of the frame being drawn (from the start of `render` on; the last frame's between frames):
   * the world → clip matrix in render space and the logarithmic scale, see `depthViewProj` of base. Read only; the
   * object is overwritten by the next frame, so a layer that needs it later copies what it needs.
   */
  get projection(): Readonly<DepthProjection> {
    return this.proj;
  }

  /**
   * With `radialUp`: the point up points away from, in render space (relative to `worldOrigin`). Null when up is +y.
   * Layers that place or cull upright things on the CPU read it.
   */
  upCenter(): Vec3 | null {
    const u = this.radialUp;
    if (!u) return null;
    return [u.center[0] - this.worldOrigin[0], u.center[1] - this.worldOrigin[1], u.center[2] - this.worldOrigin[2]];
  }

  /**
   * Replaces include lines with the registered snippets. `into` says where the program draws: `'main'` (default) for
   * the main target, `'other'` for a depth target (the shadow pass) or a bake.
   *
   * In the logarithmic depth mode a fragment shader of the main target that starts from `<header>` is also wrapped
   * (`LOG_DEPTH_PRELUDE`, `LOG_DEPTH_EPILOGUE`), so that it writes its depth itself. A source that never mentions
   * `gl_Position` counts as a fragment shader. A fragment shader with its own `#version` line instead of `<header>`
   * is left alone and keeps the depth of the pipeline: use it only for draws without the depth test.
   */
  resolve(src: string, into: 'main' | 'other' = 'main'): string {
    const expand = (afterHeader: string): string =>
      src.replace(/^#include <([\w-]+)>\n/gm, (_, name: string) => {
        const text = this.includes.get(name);
        if (text === undefined) throw new Error(`Unknown shader include <${name}>`);
        return name === 'header' ? text + afterHeader : text;
      });
    const plain = expand('');
    if (this.depthMode !== 'logarithmic' || into !== 'main') return plain;
    // Only a fragment shader that starts from the header is wrapped (the wrapper reads the Frame block).
    if (/\bgl_Position\b/.test(plain) || !/^#include <header>\n/m.test(src)) return plain;
    return expand(LOG_DEPTH_PRELUDE) + LOG_DEPTH_EPILOGUE;
  }

  /** Compiles a material description. */
  material(desc: MaterialDesc): Material {
    return new Material(this.device, desc, (src, pass) => this.resolve(src, pass === 'shadow' ? 'other' : 'main'));
  }

  /** Uploads a mesh for a material (the material fixes attribute locations). */
  createMesh(data: MeshData, material: Material, instances?: InstanceBuffer): Mesh {
    return this.device.createMesh(data, material.attribs, instances);
  }

  createInstances(data: InstanceData): InstanceBuffer {
    return this.device.createInstances(data);
  }

  createTexture(data: TextureData): Texture {
    return this.device.createTexture(data);
  }

  /** Runs a texture bake on the graphics card and returns its targets. */
  bake(desc: BakeDesc): Texture[] {
    return this.device.bake(desc.name, this.resolve(desc.fs, 'other'), desc.width, desc.height, desc.inputs, desc.uniforms ?? {}, desc.targets);
  }

  add(layer: Layer): void {
    this.layers.push(layer);
  }

  /** Registers a layer to draw just before `before` (at the end when `before` is not registered). */
  addBefore(layer: Layer, before: Layer): void {
    const i = this.layers.indexOf(before);
    if (i < 0) this.layers.push(layer);
    else this.layers.splice(i, 0, layer);
  }

  remove(layer: Layer): void {
    const i = this.layers.indexOf(layer);
    if (i >= 0) this.layers.splice(i, 1);
  }

  /** After a scene or light change forces a new shadow computation. */
  invalidateShadows(): void {
    this.shadowKey = '';
    this.singleKeyValid = false;
  }

  /**
   * Fits the light's orthographic projection to what the view sees: the projection of the visible volume (corner rays cut by
   * the bottom and top of the scene) onto the plane perpendicular to the light, clipped by the scene extent and snapped
   * to texels so shadows do not shimmer when panning.
   */
  private fitLight(view: View, bounds: SceneBounds, toLight: Vec3): { frame: OrthoFrame; cx: number; cy: number; cz: number; half: number; halfD: number } {
    const forward: Vec3 = [-toLight[0], -toLight[1], -toLight[2]];
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const frame: OrthoFrame = { right, up, forward };

    let vMinX = Infinity;
    let vMaxX = -Infinity;
    let vMinY = Infinity;
    let vMaxY = -Infinity;
    // A perspective corner ray starts at the eye: where it never reaches a plane (or reaches it behind the eye), it runs
    // on to the far end of the scene (or to `shadowDistanceM`). An orthographic corner ray is a line and is used both ways.
    const perspective = view.pixelGrowth > 0;
    for (const ray of view.cornerRays(this.rays)) {
      const reach = perspective ? Math.min(farthestCorner(ray.origin, bounds), this.shadowDistanceM) : 0;
      // In perspective the eye itself (the apex of the visible volume) counts too, as the third target with t = 0.
      for (let target = 0; target < (perspective ? 3 : 2); target++) {
        const yTarget = target === 0 ? bounds.min[1] : target === 1 ? bounds.max[1] : NaN;
        let t = (yTarget - ray.origin[1]) / ray.dir[1];
        if (perspective) t = Number.isNaN(yTarget) ? 0 : t >= 0 && t <= reach ? t : reach;
        const p: Vec3 = [ray.origin[0] + ray.dir[0] * t, perspective ? ray.origin[1] + ray.dir[1] * t : yTarget, ray.origin[2] + ray.dir[2] * t];
        const lx = dot(right, p);
        const ly = dot(up, p);
        vMinX = Math.min(vMinX, lx);
        vMaxX = Math.max(vMaxX, lx);
        vMinY = Math.min(vMinY, ly);
        vMaxY = Math.max(vMaxY, ly);
      }
    }
    let sMinX = Infinity;
    let sMaxX = -Infinity;
    let sMinY = Infinity;
    let sMaxY = -Infinity;
    let sMinZ = Infinity;
    let sMaxZ = -Infinity;
    for (let k = 0; k < 8; k++) {
      const p: Vec3 = [k & 1 ? bounds.max[0] : bounds.min[0], k & 2 ? bounds.max[1] : bounds.min[1], k & 4 ? bounds.max[2] : bounds.min[2]];
      const lx = dot(right, p);
      const ly = dot(up, p);
      const lz = dot(forward, p);
      sMinX = Math.min(sMinX, lx);
      sMaxX = Math.max(sMaxX, lx);
      sMinY = Math.min(sMinY, ly);
      sMaxY = Math.max(sMaxY, ly);
      sMinZ = Math.min(sMinZ, lz);
      sMaxZ = Math.max(sMaxZ, lz);
    }
    const minX = Math.max(vMinX, sMinX);
    const maxX = Math.min(vMaxX, sMaxX);
    const minY = Math.max(vMinY, sMinY);
    const maxY = Math.min(vMaxY, sMaxY);
    const span = Math.max(maxX - minX, maxY - minY, SHADOW_SIZE_STEP_M);
    const size = Math.ceil(span / SHADOW_SIZE_STEP_M) * SHADOW_SIZE_STEP_M + SHADOW_SIZE_STEP_M;
    // Resolution: the penumbra should come out at a fixed number of texels, more is not needed.
    const wanted = Math.ceil(size / (this.shadowSoftnessM / PENUMBRA_TEXELS));
    this.shadowPx = Math.max(SHADOW_MIN_PX, Math.min(this.shadowMapSize, wanted));
    const texel = size / this.shadowPx;
    this.shadowTexelM = texel;
    const wo = this.worldOrigin;
    const atZero = wo[0] === 0 && wo[1] === 0 && wo[2] === 0;
    const ox = atZero ? 0 : dot(right, wo);
    const oy = atZero ? 0 : dot(up, wo);
    const cx = Math.round(((minX + maxX) / 2 + ox) / texel) * texel - ox;
    const cy = Math.round(((minY + maxY) / 2 + oy) / texel) * texel - oy;
    return { frame, cx, cy, cz: (sMinZ + sMaxZ) / 2, half: size / 2, halfD: (sMaxZ - sMinZ) / 2 + 10 };
  }

  /**
   * What the view sees and what the scene spans, along the axes of a light frame (render space): the rectangle of the
   * light's plane the visible volume projects to, cut to the scene extent, the scene's range along the light, and the
   * eye of a perspective view. The visible volume is taken as in `fitLight`; `reachM` limits a perspective view.
   */
  private viewFootprint(view: View, bounds: SceneBounds, frame: OrthoFrame, reachM: number): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; eye: Vec3 | null } {
    const { right, up, forward } = frame;
    let vMinX = Infinity;
    let vMaxX = -Infinity;
    let vMinY = Infinity;
    let vMaxY = -Infinity;
    const perspective = view.pixelGrowth > 0;
    const rays = view.cornerRays(this.rays);
    for (const ray of rays) {
      const reach = perspective ? Math.min(farthestCorner(ray.origin, bounds), reachM) : 0;
      for (let target = 0; target < (perspective ? 3 : 2); target++) {
        const yTarget = target === 0 ? bounds.min[1] : target === 1 ? bounds.max[1] : NaN;
        let t = (yTarget - ray.origin[1]) / ray.dir[1];
        if (perspective) t = Number.isNaN(yTarget) ? 0 : t >= 0 && t <= reach ? t : reach;
        else if (!Number.isFinite(t)) continue;
        const p: Vec3 = [ray.origin[0] + ray.dir[0] * t, perspective ? ray.origin[1] + ray.dir[1] * t : yTarget, ray.origin[2] + ray.dir[2] * t];
        const lx = dot(right, p);
        const ly = dot(up, p);
        vMinX = Math.min(vMinX, lx);
        vMaxX = Math.max(vMaxX, lx);
        vMinY = Math.min(vMinY, ly);
        vMaxY = Math.max(vMaxY, ly);
      }
    }
    let sMinX = Infinity;
    let sMaxX = -Infinity;
    let sMinY = Infinity;
    let sMaxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < 8; k++) {
      const p: Vec3 = [k & 1 ? bounds.max[0] : bounds.min[0], k & 2 ? bounds.max[1] : bounds.min[1], k & 4 ? bounds.max[2] : bounds.min[2]];
      const lx = dot(right, p);
      const ly = dot(up, p);
      const lz = dot(forward, p);
      sMinX = Math.min(sMinX, lx);
      sMaxX = Math.max(sMaxX, lx);
      sMinY = Math.min(sMinY, ly);
      sMaxY = Math.max(sMaxY, ly);
      minZ = Math.min(minZ, lz);
      maxZ = Math.max(maxZ, lz);
    }
    const eye: Vec3 | null = perspective ? [rays[0]!.origin[0], rays[0]!.origin[1], rays[0]!.origin[2]] : null;
    if (!(vMinX <= vMaxX) || !(vMinY <= vMaxY)) return { minX: sMinX, maxX: sMaxX, minY: sMinY, maxY: sMaxY, minZ, maxZ, eye };
    // A view that looks past the scene keeps its own rectangle: there is nothing to cut it to.
    const cut = Math.max(vMinX, sMinX) <= Math.min(vMaxX, sMaxX) && Math.max(vMinY, sMinY) <= Math.min(vMaxY, sMaxY);
    if (!cut) return { minX: vMinX, maxX: vMaxX, minY: vMinY, maxY: vMaxY, minZ, maxZ, eye };
    return { minX: Math.max(vMinX, sMinX), maxX: Math.min(vMaxX, sMaxX), minY: Math.max(vMinY, sMinY), maxY: Math.min(vMaxY, sMaxY), minZ, maxZ, eye };
  }

  /**
   * Shadow areas, first half of a frame: places every area around the focus of the view, decides what of the map
   * must be drawn and fills the areas' part of the Frame block. Positions on the block grid are counted from the
   * world origin (`worldOrigin`), so neither a moving render origin nor a pan shifts a texel against the world.
   */
  private planAreas(st: AreaState, view: View, bounds: SceneBounds, toLight: Vec3): AreaPlan {
    // The light's plane is laid by the direction as the cache key holds it (4 decimals), not by the exact one: a light
    // that drifts by less than the key resolves must not turn the plane under a map that is kept as it is.
    const lightKey = `${toLight[0].toFixed(4)},${toLight[1].toFixed(4)},${toLight[2].toFixed(4)}`;
    const [kx, ky, kz] = lightKey.split(',').map(Number) as [number, number, number];
    const frame = lightFrame(kx === 0 && ky === 0 && kz === 0 ? toLight : normalize([kx, ky, kz]));
    const wo = this.worldOrigin;
    const ox = dot(frame.right, wo);
    const oy = dot(frame.up, wo);
    const oz = dot(frame.forward, wo);
    const fp = this.viewFootprint(view, bounds, frame, st.reachM);
    // The depth range follows the scene extent in coarse steps, so that it rarely changes (a change redraws the map).
    const q = AREA_DEPTH_STEP_M;
    const zMin = Math.floor((fp.minZ + oz) / q) * q - 10;
    const zMax = Math.ceil((fp.maxZ + oz) / q) * q + 10;
    const key = `${lightKey}|${this.shadowKeyExtra}|${zMin},${zMax}`;
    let redraw = key !== this.shadowKey;
    for (const layer of this.layers) if (layer.cullStale?.()) redraw = true;

    // The focus (render space, in the light's plane) and the block size of every area.
    const n = st.areas.length;
    let fx = (fp.minX + fp.maxX) / 2;
    let fy = (fp.minY + fp.maxY) / 2;
    const blocks: number[] = [];
    if (st.mode === 'snapped') {
      // The finest map has the texel the softness asks for; from there the map grows with the view.
      const base = (st.px * (this.shadowSoftnessM / PENUMBRA_TEXELS)) / AREA_BLOCKS;
      const top = Math.max(0, Math.floor(2 * Math.log2(st.reachM / (base * AREA_REACH_BLOCKS))));
      const halfSpan = Math.max(fp.maxX - fp.minX, fp.maxY - fp.minY) / 2;
      const shown = 1 - AREA_BLEND_LAST;
      st.step = ladderStep(halfSpan, base, top, shown, redraw && st.step >= 0 ? -1 : st.step);
      const blockM = base * 2 ** (st.step / 2);
      // A perspective view that sees more than the map holds keeps the map around the eye.
      if (fp.eye && halfSpan > blockM * AREA_REACH_BLOCKS * shown) {
        fx = dot(frame.right, fp.eye);
        fy = dot(frame.up, fp.eye);
      }
      blocks.push(blockM);
    } else {
      if (fp.eye) {
        fx = dot(frame.right, fp.eye);
        fy = dot(frame.up, fp.eye);
      }
      for (let i = 0; i < n; i++) blocks.push((st.firstReachM * (st.reachM / st.firstReachM) ** (i / (n - 1))) / AREA_REACH_BLOCKS);
    }

    const draws: AreaPlan['draws'] = [];
    for (let i = 0; i < n; i++) {
      const rects = followFocus(st.areas[i]!, fx + ox, fy + oy, blocks[i]!, redraw, n === 1);
      if (rects.length > 0) draws.push({ area: i, rects });
    }

    // The areas' part of the Frame block, in the member order of `shadowAreaMembers`.
    const cz = (zMin + zMax) / 2 - oz;
    const halfD = (zMax - zMin) / 2;
    const t = st.tail;
    const mapPx = this.shadowMapSize;
    for (let i = 0; i < n; i++) {
      const a = st.areas[i]!;
      const size = a.blockM * AREA_BLOCKS;
      const m = orthoMatrix(frame, a.bx * a.blockM + size / 2 - ox, a.by * a.blockM + size / 2 - oy, cz, size / 2, size / 2, halfD);
      if (i === 0) this.lightSample = m.slice();
      // From clip space (−1…1) to 0…1 on all three axes.
      for (let c = 0; c < 16; c += 4) for (let r = 0; r < 3; r++) m[c + r] = m[c + r]! * 0.5;
      m[12] = m[12]! + 0.5;
      m[13] = m[13]! + 0.5;
      m[14] = m[14]! + 0.5;
      t.set(m, i * 16);
      const texel = size / st.px;
      const soft = Math.min(Math.max(0.6, (this.shadowSoftnessM / texel - 1) / 3), 1.3);
      const partX = n === 1 ? 0 : (i % 2) * st.px;
      const partY = n === 1 ? 0 : Math.floor(i / 2) * st.px;
      t.set([(partX + a.startX * st.blockPx) / mapPx, (partY + a.startY * st.blockPx) / mapPx, st.px / mapPx, soft / mapPx], n * 16 + i * 4);
      const reach = a.blockM * AREA_REACH_BLOCKS;
      const blend = (i === n - 1 ? AREA_BLEND_LAST : AREA_BLEND) * reach;
      t.set([reach, 1 / blend, texel, 0], n * 20 + i * 4);
      if (i === 0) this.shadowTexelM = texel;
    }
    const o = n * 24;
    t.set([fx, fy, 0, 0], o);
    t.set([frame.right[0], frame.right[1], frame.right[2], 0], o + 4);
    t.set([frame.up[0], frame.up[1], frame.up[2], 0], o + 8);
    const h = this.shadowHorizon;
    if (h) {
      t.set([(wo[0] - h.originX) / h.sizeX, (wo[2] - h.originZ) / h.sizeZ, 1 / h.sizeX, 1 / h.sizeZ], o + 12);
      t.set([h.baseY - wo[1], h.rangeM, 1 / Math.max(h.blendM ?? 2, 1e-3), 1], o + 16);
    } else t.fill(0, o + 12, o + 20);
    this.shadowPx = mapPx;
    const viewKey = view.key();
    return { frame, ox, oy, cz, halfD, draws, viewStale: redraw || draws.length > 0 || viewKey !== st.viewKey, key, viewKey };
  }

  /**
   * Shadow areas, second half of a frame: draws the planned rectangles into the map (each with the casters the
   * light's volume over that rectangle selects), then lets the layers select for the view again.
   * Returns the number of rectangles drawn.
   */
  private drawAreas(st: AreaState, plan: AreaPlan, view: View, stats: { tris: number; calls: number }): number {
    const device = this.device;
    const n = st.areas.length;
    let drawn = 0;
    if (plan.draws.length > 0) device.target(this.shadowTarget);
    for (const d of plan.draws) {
      const a = st.areas[d.area]!;
      const partX = n === 1 ? 0 : (d.area % 2) * st.px;
      const partY = n === 1 ? 0 : Math.floor(d.area / 2) * st.px;
      for (const r of d.rects) {
        const halfW = ((r.x1 - r.x0) * a.blockM) / 2;
        const halfH = ((r.y1 - r.y0) * a.blockM) / 2;
        const cx = (a.bx + r.x0) * a.blockM + halfW - plan.ox;
        const cy = (a.by + r.y0) * a.blockM + halfH - plan.oy;
        this.lightRender = orthoMatrix(plan.frame, cx, cy, plan.cz, halfW, halfH, plan.halfD);
        const volume: CullVolume = { kind: 'box', axes: plan.frame, cx, cy, halfW, halfH };
        for (const layer of this.layers) layer.cull?.(volume, 'shadow', view);
        const x = partX + r.tx * st.blockPx;
        const y = partY + r.ty * st.blockPx;
        const w = (r.x1 - r.x0) * st.blockPx;
        const hgt = (r.y1 - r.y0) * st.blockPx;
        device.clearDepthRect(x, y, w, hgt);
        device.viewport(x, y, w, hgt);
        this.drawPass('shadow', view, stats);
        drawn++;
      }
    }
    this.shadowKey = plan.key;
    if (plan.viewStale) {
      const viewVolume = view.cullVolume();
      let visible = 0;
      for (const layer of this.layers) visible += layer.cull?.(viewVolume, 'view', view) ?? 0;
      this.instancesVisible = visible;
      st.viewKey = plan.viewKey;
    }
    return drawn;
  }

  /**
   * Draws one pass of every layer. `casters` (shadow pass only) limits it to the layers with that `shadowCasters`
   * (unset counts as `'static'`); `'all'` draws every layer.
   */
  private drawPass(pass: PassName, view: View, stats: { tris: number; calls: number }, casters: 'all' | 'static' | 'dynamic' = 'all'): void {
    const device = this.device;
    const base = pass === 'shadow' ? SHADOW_STATE : BASE_STATE;
    const ctx = this.ctx;
    ctx.pass = pass;
    ctx.view = view;
    ctx.lightRender = this.lightRender;
    this.counting = stats;
    const probe = this.probe;
    for (const layer of this.layers) {
      if (casters !== 'all' && (layer.shadowCasters === 'dynamic') !== (casters === 'dynamic')) continue;
      if (probe) {
        this.drawProbed(probe, layer, ctx, base, stats);
        continue;
      }
      device.setState(base);
      layer.draw(ctx);
    }
    device.setState(base);
  }

  /** `drawPass` for one layer while a probe is set: may leave the layer out, reports what it counted. */
  private drawProbed(probe: RenderProbe, layer: Layer, ctx: DrawContext, base: Required<DrawState>, stats: { tris: number; calls: number }): void {
    if (probe.draws && !probe.draws(layer, ctx.pass)) return;
    const tris = stats.tris;
    const calls = stats.calls;
    this.device.setState(base);
    layer.draw(ctx);
    probe.drawn?.(layer, ctx.pass, stats.tris - tris, stats.calls - calls);
  }

  /** Renders one frame. Called synchronously, independent of the browser's timer. */
  render(view: View): FrameStats {
    const device = this.device;
    // Without a graphics context there is nothing to draw into; the frame after its restore draws everything again.
    if (device.lost) return this.lastStats;
    const t0 = performance.now();
    for (const hook of this.beforeFrame) hook(view);
    const bounds = this.bounds;
    const bg = this.background;
    // Code outside the device (texture bakes) may have changed the context state since the last frame.
    device.setState(BASE_STATE, true);
    if (!bounds) {
      device.target(null);
      device.viewport(0, 0, view.width, view.height);
      device.clear(bg, true);
      device.present();
      return this.lastStats;
    }

    const toLight = this.lightDirection;
    const mapSize = this.shadowMapSize;
    const sceneCenter = this.sceneCenter;
    sceneCenter[0] = (bounds.min[0] + bounds.max[0]) / 2;
    sceneCenter[1] = (bounds.min[1] + bounds.max[1]) / 2;
    sceneCenter[2] = (bounds.min[2] + bounds.max[2]) / 2;
    const radius = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2;
    // Standard depth: the view's own matrix, untouched. Reversed and logarithmic depth: see `depthViewProj`.
    const proj = depthViewProj(view, this.depthMode, sceneCenter, radius + 10, this.depthNearM, this.proj);
    const viewProj = proj.viewProj;

    // Layers whose casters move: asked once per frame whether their shadow changed (and whether their culled sets
    // are out of date). Without such layers nothing here is asked and the frame is exactly as before.
    let hasDynamic = false;
    let dynamicDirty = false;
    for (const layer of this.layers) {
      if (layer.shadowCasters !== 'dynamic') continue;
      hasDynamic = true;
      if (layer.shadowDirty?.()) dynamicDirty = true;
      if (layer.cullStale?.()) dynamicDirty = true;
    }

    // The shadow modes with areas plan their own updates; the single fitted map below is then skipped. They have no
    // static map of their own: a dynamic layer's change redraws all of it, as `invalidateShadows` would.
    const areaState = this.areaState;
    if (areaState && dynamicDirty) this.shadowKey = '';
    const plan = areaState ? this.planAreas(areaState, view, bounds, toLight) : null;
    // Shadows depend on the view, the light direction and whatever the owner adds. Animation time is not in the key.
    let shadowStale = !plan && !this.singleKeyHolds(view, toLight);
    if (!plan && !shadowStale) for (const layer of this.layers) if (layer.shadowCasters !== 'dynamic' && layer.cullStale?.()) shadowStale = true;
    // The first dynamic layer (the kept static map is still empty) and the last one gone (the sampled map still
    // holds its casters) both need a whole new map.
    if (!plan && hasDynamic !== this.hadDynamic) shadowStale = true;
    this.hadDynamic = hasDynamic;
    if (shadowStale) {
      const fit = this.fitLight(view, bounds, toLight);
      this.lightRender = orthoMatrix(fit.frame, fit.cx, fit.cy, fit.cz, fit.half, fit.half, fit.halfD, this.singleRender);
      // Reading matrix: the same projection, just squeezed into the used part of the texture.
      const k = this.shadowPx / mapSize;
      const s = this.singleSample;
      s.set(this.lightRender);
      for (let col = 0; col < 16; col += 4) {
        s[col] = s[col]! * k;
        s[col + 1] = s[col + 1]! * k;
      }
      s[12] = s[12]! + (k - 1);
      s[13] = s[13]! + (k - 1);
      this.lightSample = s;
      this.lightFit = fit;
      this.lightVolume = { kind: 'box', axes: fit.frame, cx: fit.cx, cy: fit.cy, halfW: fit.half, halfH: fit.half };
    }

    // Frame block, in the member order of `shaderHeader`.
    const f = this.frameData;
    const cam = view.axes(this.camAxes);
    f.set(viewProj, 0);
    f.set(this.lightSample, 16);
    f[32] = toLight[0];
    f[33] = toLight[1];
    f[34] = toLight[2];
    f[35] = this.shadowPx / mapSize;
    f.set(this.frameSlots.afterLight, 36);
    let o = 36 + this.frameSlots.afterLight.length;
    const softTexels = Math.max(0.6, (this.shadowSoftnessM / this.shadowTexelM - 1) / 3);
    putVec4(f, o, view.metresPerPixel, this.shadowTexelM, Math.min(softTexels, 1.3), 1 / mapSize);
    putVec4(f, o + 4, cam.right[0], cam.right[1], cam.right[2], view.pixelGrowth);
    putVec4(f, o + 8, cam.up[0], cam.up[1], cam.up[2], proj.logScale);
    putVec4(f, o + 12, cam.forward[0], cam.forward[1], cam.forward[2], view.refDepth);
    o += 16;
    f.set(this.frameSlots.afterView, o);
    if (areaState) f.set(areaState.tail, o + this.frameSlots.afterView.length);
    // Local up: the last member, the centre in render space (a difference of doubles) and the base radius.
    const ru = this.radialUp;
    if (ru) {
      const wo = this.worldOrigin;
      putVec4(f, f.length - LOCAL_UP_FLOATS, ru.center[0] - wo[0], ru.center[1] - wo[1], ru.center[2] - wo[2], ru.radiusM);
    }
    this.frameBlock.update(f);
    // Layers draw their own targets now, with the block of this frame and before any pass has begun.
    const probe = this.probe;
    for (const layer of this.layers) if (layer.prepare && !(probe?.draws && !probe.draws(layer, 'prepare'))) layer.prepare(device, view);
    // A layer that filled a target changed the draw state; the clears below need the depth mask of the base state.
    device.setState(BASE_STATE);

    const shadow = this.countShadow;
    const dynamic = this.countDynamic;
    shadow.tris = shadow.calls = 0;
    dynamic.tris = dynamic.calls = 0;
    let shadowUpdates = 0;
    const lightVolume = this.lightVolume;
    if (!plan && this.lightFit && lightVolume && (shadowStale || (hasDynamic && dynamicDirty))) {
      // A refit culls and draws everything; a frame where only dynamic casters changed touches only those layers.
      const all = shadowStale;
      // Whatever casts shadows into the image may stand outside it, so the light's volume selects for the shadow pass.
      for (const layer of this.layers) if (all || layer.shadowCasters === 'dynamic') layer.cull?.(lightVolume, 'shadow', view);
      if (!hasDynamic) {
        device.target(this.shadowTarget);
        device.viewport(0, 0, mapSize, mapSize);
        device.clear(null, true);
        device.viewport(0, 0, this.shadowPx, this.shadowPx);
        this.drawPass('shadow', view, shadow);
      } else {
        const kept = (this.staticShadow ??= device.depthTarget(mapSize));
        if (all) {
          // The static casters alone, into the map that is kept.
          device.target(kept);
          device.viewport(0, 0, mapSize, mapSize);
          device.clear(null, true);
          device.viewport(0, 0, this.shadowPx, this.shadowPx);
          this.drawPass('shadow', view, shadow, 'static');
        }
        // The sampled map: the kept static depth, then the dynamic casters over it.
        device.target(this.shadowTarget);
        if (all) {
          device.viewport(0, 0, mapSize, mapSize);
          device.clear(null, true);
        }
        device.copyDepth(kept, this.shadowTarget, this.shadowPx);
        device.viewport(0, 0, this.shadowPx, this.shadowPx);
        this.drawPass('shadow', view, dynamic, 'dynamic');
        shadow.tris += dynamic.tris;
        shadow.calls += dynamic.calls;
      }
      if (all) this.keepSingleKey(view, toLight);
      // For the passes that follow only what is actually in the image.
      const key = view.key();
      if (all || !this.viewVolume || key !== this.viewVolumeKey) {
        this.viewVolume = view.cullVolume();
        this.viewVolumeKey = key;
      }
      const viewVolume = this.viewVolume;
      let staticVisible = 0;
      let dynamicVisible = 0;
      for (const layer of this.layers) {
        if (layer.shadowCasters === 'dynamic') dynamicVisible += layer.cull?.(viewVolume, 'view', view) ?? 0;
        else if (all) staticVisible += layer.cull?.(viewVolume, 'view', view) ?? 0;
      }
      if (all) this.staticVisible = staticVisible;
      this.instancesVisible = this.staticVisible + dynamicVisible;
      shadowUpdates = 1;
    }
    if (areaState && plan) shadowUpdates = this.drawAreas(areaState, plan, view, shadow);

    // Main passes.
    const main = this.countMain;
    main.tris = main.calls = 0;
    device.target(null);
    device.viewport(0, 0, view.width, view.height);
    device.clear(bg, true);
    if (areaState) device.texture(SHADOW_HORIZON_UNIT, this.shadowHorizon?.texture ?? areaState.noHorizon);
    device.texture(SHADOW_MAP_UNIT, this.shadowTarget.texture);
    if (this.mode === 'data') this.drawPass('data', view, main);
    else {
      this.drawPass('color', view, main);
      this.drawPass('overlay', view, main);
    }

    device.unbindMesh();
    // Reversed and logarithmic depth draw into the device's own target; this copies it to the drawing surface.
    device.present();
    this.lastStats = {
      triangles: main.tris,
      drawCalls: main.calls,
      shadowTriangles: shadow.tris,
      shadowDrawCalls: shadow.calls,
      dynamicShadowTriangles: dynamic.tris,
      dynamicShadowDrawCalls: dynamic.calls,
      cpuMs: performance.now() - t0,
      shadowMapPx: this.shadowPx,
      instancesVisible: this.instancesVisible,
      shadowUpdates,
    };
    return this.lastStats;
  }

  /** Mode `'single'`: is the kept map still fitted to this view, light direction and `shadowKeyExtra`? */
  private singleKeyHolds(view: View, toLight: Vec3): boolean {
    if (!this.singleKeyValid) return false;
    const l = this.singleKeyLight;
    // The light direction counts in steps of 1e-4, as it always did.
    if (Math.round(toLight[0] * 1e4) !== l[0] || Math.round(toLight[1] * 1e4) !== l[1] || Math.round(toLight[2] * 1e4) !== l[2]) return false;
    return this.shadowKeyExtra === this.singleKeyExtra && view.key() === this.singleKeyView;
  }

  private keepSingleKey(view: View, toLight: Vec3): void {
    this.singleKeyValid = true;
    this.singleKeyView = view.key();
    this.singleKeyLight[0] = Math.round(toLight[0] * 1e4);
    this.singleKeyLight[1] = Math.round(toLight[1] * 1e4);
    this.singleKeyLight[2] = Math.round(toLight[2] * 1e4);
    this.singleKeyExtra = this.shadowKeyExtra;
  }

  /**
   * Renders n frames and waits for the graphics. Returns the average time of one frame in ms including the graphics work.
   * `beforeFrame` is called before each frame, typically advances the clocks by a fixed step so that animation is measured.
   */
  benchmark(view: View, n: number, beforeFrame?: (index: number) => void): number {
    this.render(view);
    this.device.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      beforeFrame?.(i);
      this.render(view);
      this.device.flush();
    }
    this.device.finish();
    return (performance.now() - t0) / n;
  }
}

export interface MeshLayerOptions {
  material: Material;
  /** Name for profiles and statistics (`Layer.name`). */
  name?: string;
  mesh?: Mesh | null;
  /** Passes the layer draws in. Default: every pass the material has a program for. */
  passes?: Iterable<PassName>;
  /** Extra draw state per pass, on top of the material's state. */
  state?: Partial<Record<PassName, DrawState>>;
  /** Uniforms set before every draw. May be replaced at any time. */
  uniforms?: Uniforms;
  /** Samplers bound before every draw, to the units 1, 2, … in order (unit 0 holds the shadow map). */
  textures?: Record<string, Texture | null>;
  /** Sets anything else for the program of the current pass, right before the draw. */
  bind?: (program: Program, ctx: DrawContext) => void;
}

/** Sets the shared uniforms and binds samplers for one draw. */
export function applyInputs(ctx: DrawContext, program: Program, uniforms: Uniforms, textures: Record<string, Texture | null>): void {
  if (ctx.pass === 'shadow') program.mat4('u_lightRender', ctx.lightRender);
  else program.int('u_shadowMap', SHADOW_MAP_UNIT);
  let unit = SHADOW_MAP_UNIT + 1;
  for (const name in textures) {
    ctx.device.texture(unit, textures[name]!);
    program.int(name, unit++);
  }
  for (const name in uniforms) program.set(name, uniforms[name]!);
}

/**
 * One mesh drawn with one material. In the shadow pass the program gets `u_lightRender`, in the others `u_shadowMap`.
 */
export class MeshLayer implements Layer {
  name?: string;
  readonly material: Material;
  mesh: Mesh | null;
  passes: Set<PassName>;
  uniforms: Uniforms;
  textures: Record<string, Texture | null>;
  readonly state: Partial<Record<PassName, DrawState>>;
  private readonly bind: ((program: Program, ctx: DrawContext) => void) | undefined;

  constructor(o: MeshLayerOptions) {
    this.material = o.material;
    this.mesh = o.mesh ?? null;
    this.passes = new Set(o.passes ?? o.material.passes);
    this.state = { ...o.material.state, ...o.state };
    this.uniforms = o.uniforms ?? {};
    this.textures = o.textures ?? {};
    this.bind = o.bind;
    if (o.name !== undefined) this.name = o.name;
  }

  draw(ctx: DrawContext): void {
    const mesh = this.mesh;
    if (!mesh) return;
    if (!this.begin(ctx)) return;
    ctx.device.draw(mesh);
    ctx.count(mesh.triangles);
  }

  /**
   * Sets this layer's draw state, program, uniforms and textures for `ctx.pass`. Returns the program, or null when the
   * layer does not draw in this pass. Subclasses that draw several meshes call it once and then draw each mesh.
   */
  protected begin(ctx: DrawContext): Program | null {
    if (!this.passes.has(ctx.pass)) return null;
    const program = this.material.program(ctx.pass);
    if (!program) return null;
    const state = this.state[ctx.pass];
    if (state) ctx.device.setState(state);
    ctx.device.use(program);
    applyInputs(ctx, program, this.uniforms, this.textures);
    this.bind?.(program, ctx);
    return program;
  }
}

/** A shape drawn many times: levels of detail sharing one instance buffer, and that buffer's full contents. */
export interface InstanceBatch {
  /** Meshes from the coarsest to the finest, all bound to `instances`. */
  lods: Mesh[];
  instances: InstanceBuffer;
  /** Every instance; culling copies the kept ones into the buffer. */
  all: Float32Array;
  /** Uniforms of this batch, set before its draw. May be replaced at any time. */
  uniforms: Uniforms;
}

export interface InstancedLayerOptions {
  material: Material;
  /** Name for profiles and statistics (`Layer.name`). */
  name?: string;
  bounds: InstanceBounds;
  /** Level of detail for the colour pass, asked whenever the visible set is recomputed. The shadow pass uses level 0. */
  levelOfDetail?: () => number;
  passes?: Iterable<PassName>;
  uniforms?: Uniforms;
  /**
   * For a renderer with radial up: the render-space point the instances stand away from, asked at every culling
   * (pass `() => renderer.upCenter()`). Default: unset, instances stand along +y.
   */
  upCenter?: () => readonly [number, number, number] | null;
}

/**
 * Instanced batches with per-volume culling. An instance is an upright segment from its base point up by its height,
 * widened by its radius; whatever reaches into the volume is kept.
 */
export class InstancedLayer implements Layer {
  name?: string;
  readonly material: Material;
  batches: InstanceBatch[] = [];
  passes: Set<PassName>;
  uniforms: Uniforms;
  /** Extra draw state per pass, on top of the material's state. May be replaced at any time. */
  state: Partial<Record<PassName, DrawState>>;
  private readonly device: Device;
  private readonly bounds: InstanceBounds;
  private readonly levelOfDetail: () => number;
  private readonly upCenter: (() => readonly [number, number, number] | null) | null;
  private scratch = new Float32Array(0);
  private lodNow = 0;

  constructor(device: Device, o: InstancedLayerOptions) {
    this.device = device;
    this.material = o.material;
    this.bounds = o.bounds;
    this.levelOfDetail = o.levelOfDetail ?? ((): number => 0);
    this.upCenter = o.upCenter ?? null;
    this.passes = new Set(o.passes ?? o.material.passes);
    this.uniforms = o.uniforms ?? {};
    this.state = {};
    if (o.name !== undefined) this.name = o.name;
  }

  cull(volume: CullVolume, purpose: 'shadow' | 'view'): number {
    if (purpose === 'view') this.lodNow = this.levelOfDetail();
    let total = 0;
    for (const batch of this.batches) {
      const stride = batch.instances.layout.stride / 4;
      if (this.scratch.length < batch.all.length) this.scratch = new Float32Array(batch.all.length);
      const n = cullInstances(volume, batch.all, stride, this.bounds, this.scratch, this.upCenter ? this.upCenter() : null);
      this.device.writeBuffer(batch.instances.buffer, this.scratch, n);
      const count = n / stride;
      for (const m of batch.lods) m.instances = count;
      total += count;
    }
    return total;
  }

  draw(ctx: DrawContext): void {
    if (!this.passes.has(ctx.pass)) return;
    const program = this.material.program(ctx.pass);
    if (!program) return;
    // The material's state, then the layer's own on top: the same fields end up set as with one merged object.
    const ms = this.material.state[ctx.pass];
    const ls = this.state[ctx.pass];
    if (ms) ctx.device.setState(ms);
    if (ls) ctx.device.setState(ls);
    ctx.device.use(program);
    applyInputs(ctx, program, this.uniforms, {});
    const lod = ctx.pass === 'shadow' ? 0 : this.lodNow;
    for (const batch of this.batches) {
      const m = batch.lods[Math.min(lod, batch.lods.length - 1)]!;
      if (m.instances === 0) continue;
      for (const name in batch.uniforms) program.set(name, batch.uniforms[name]!);
      ctx.device.draw(m);
      ctx.count(m.triangles * m.instances);
    }
  }
}

/** Writes four floats at `o`. */
function putVec4(f: Float32Array, o: number, x: number, y: number, z: number, w: number): void {
  f[o] = x;
  f[o + 1] = y;
  f[o + 2] = z;
  f[o + 3] = w;
}

/** Distance from a point to the farthest corner of the scene bounds. */
function farthestCorner(p: Vec3, b: SceneBounds): number {
  const dx = Math.max(Math.abs(p[0] - b.min[0]), Math.abs(p[0] - b.max[0]));
  const dy = Math.max(Math.abs(p[1] - b.min[1]), Math.abs(p[1] - b.max[1]));
  const dz = Math.max(Math.abs(p[2] - b.min[2]), Math.abs(p[2] - b.max[2]));
  return Math.hypot(dx, dy, dz);
}

/**
 * Copies the instances that reach into the volume into `out`; returns the number of floats written. With `upCenter`
 * (a point in the space of the instance positions) every instance stands away from that point instead of along +y.
 */
export function cullInstances(volume: CullVolume, src: Float32Array, stride: number, b: InstanceBounds, out: Float32Array, upCenter: readonly [number, number, number] | null = null): number {
  if (upCenter) return cullInstancesRadial(volume, src, stride, b, out, upCenter);
  if (volume.kind === 'frustum') return cullInstancesFrustum(volume.planes, src, stride, b, out);
  const { right, up } = volume.axes;
  const { cx, cy, halfW, halfH } = volume;
  let n = 0;
  for (let i = 0; i < src.length; i += stride) {
    const x = src[i + b.position]!;
    const y = src[i + b.position + 1]!;
    const z = src[i + b.position + 2]!;
    const r = src[i + b.radius]!;
    const h = src[i + b.height]!;
    const lx = right[0] * x + right[1] * y + right[2] * z - cx;
    if (Math.abs(lx + right[1] * h * 0.5) > halfW + r + Math.abs(right[1]) * h * 0.5) continue;
    const ly0 = up[0] * x + up[1] * y + up[2] * z - cy;
    const ly1 = ly0 + up[1] * h;
    if (Math.max(ly0, ly1) < -halfH - r || Math.min(ly0, ly1) > halfH + r) continue;
    for (let k = 0; k < stride; k++) out[n + k] = src[i + k]!;
    n += stride;
  }
  return n;
}

/** `cullInstances` for instances that stand away from a point: the segment runs from the base along the local up. */
function cullInstancesRadial(volume: CullVolume, src: Float32Array, stride: number, b: InstanceBounds, out: Float32Array, c: readonly [number, number, number]): number {
  let n = 0;
  outer: for (let i = 0; i < src.length; i += stride) {
    const x = src[i + b.position]!;
    const y = src[i + b.position + 1]!;
    const z = src[i + b.position + 2]!;
    const r = src[i + b.radius]!;
    const h = src[i + b.height]!;
    let ux = x - c[0];
    let uy = y - c[1];
    let uz = z - c[2];
    const l = Math.sqrt(ux * ux + uy * uy + uz * uz);
    // The segment from the base to the top, as a vector.
    const k = l > 0 ? h / l : 0;
    ux *= k;
    uy = l > 0 ? uy * k : h;
    uz *= k;
    if (volume.kind === 'frustum') {
      for (const [nx, ny, nz, d] of volume.planes) {
        const s0 = nx * x + ny * y + nz * z + d;
        if (Math.max(s0, s0 + nx * ux + ny * uy + nz * uz) < -r) continue outer;
      }
    } else {
      const { right, up } = volume.axes;
      const lx0 = right[0] * x + right[1] * y + right[2] * z - volume.cx;
      const lx1 = lx0 + right[0] * ux + right[1] * uy + right[2] * uz;
      if (Math.max(lx0, lx1) < -volume.halfW - r || Math.min(lx0, lx1) > volume.halfW + r) continue;
      const ly0 = up[0] * x + up[1] * y + up[2] * z - volume.cy;
      const ly1 = ly0 + up[0] * ux + up[1] * uy + up[2] * uz;
      if (Math.max(ly0, ly1) < -volume.halfH - r || Math.min(ly0, ly1) > volume.halfH + r) continue;
    }
    for (let q = 0; q < stride; q++) out[n + q] = src[i + q]!;
    n += stride;
  }
  return n;
}

/** Frustum variant of `cullInstances`: the upright segment, widened by its radius, must not lie wholly outside a plane. */
function cullInstancesFrustum(
  planes: readonly (readonly [number, number, number, number])[],
  src: Float32Array,
  stride: number,
  b: InstanceBounds,
  out: Float32Array,
): number {
  let n = 0;
  outer: for (let i = 0; i < src.length; i += stride) {
    const x = src[i + b.position]!;
    const y = src[i + b.position + 1]!;
    const z = src[i + b.position + 2]!;
    const r = src[i + b.radius]!;
    const h = src[i + b.height]!;
    for (const [nx, ny, nz, d] of planes) {
      const s0 = nx * x + ny * y + nz * z + d;
      if (Math.max(s0, s0 + ny * h) < -r) continue outer;
    }
    for (let k = 0; k < stride; k++) out[n + k] = src[i + k]!;
    n += stride;
  }
  return n;
}
