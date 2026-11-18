// The device: everything the modules above gpu may ask of the graphics card, without touching WebGL themselves.
// Draw state is cached, so setting the same state twice costs nothing.
//
// Depth. The device owns the depth convention of whatever target is bound, so nothing above it handles a depth mode
// (`DepthMode`, chosen once with `setDepthMode`):
// - A depth target (shadow map) always holds standard depth: 0 nearest, 1 farthest, clip z from −w to +w.
// - The main target in the standard mode is the canvas with its own depth buffer, exactly as without depth modes.
// - In the reversed and logarithmic modes the main target is an offscreen multisampled target with a 32-bit float
//   depth buffer (a canvas cannot have one); `present` copies it to the canvas. Reversed: clip z from 0 to w (`EXT_clip_control`), 1 nearest,
//   0 farthest, so the device clears depth to 0, turns `'less'` into "greater" and flips the sign of the polygon offset.
//   Logarithmic: standard convention, but programs write their own depth, which takes the pipeline's polygon offset
//   out of play; the device hands the offset to the program instead (`Program.depthBias`).
// `DrawState` keeps one meaning in every mode: `'less'` passes what is nearer, a positive polygon offset pushes away.
// Samples (`setMainSamples`): with 2 samples the standard mode draws into the offscreen target too (standard depth
// convention, 32-bit float depth), as a canvas cannot be asked for a sample count.

import { texelBytes } from '../base/data.ts';
import type { InstanceData, MeshData, ScalarType, TextureData, TextureFormat, TextureSampling, VertexLayout } from '../base/data.ts';
import type { BlendFactor, BlendSpec, CullMode, DrawState, Uniforms } from '../base/material.ts';
import type { DepthMode } from '../base/view.ts';
import type { GL, GpuBuffer, MainSamples, Mesh, Texture } from './gl.ts';
import { Program, bindAttribs, createBuffer, createTexture, drawMesh, forgetContextExtensions, rendererName } from './gl.ts';
import type { AttribSpec } from './gl.ts';

/** A per-instance buffer shared by several meshes; culling rewrites its start. */
export interface InstanceBuffer {
  readonly buffer: GpuBuffer;
  readonly layout: VertexLayout;
  /** Floats in the buffer. */
  readonly floats: number;
}

/**
 * Bytes of GPU memory the device has allocated and not yet deleted, by kind. `buffers`: vertex, index, instance and
 * uniform buffers. `textures`: uploaded and baked textures (mipmaps included). `targets`: depth and colour render targets.
 * The canvas's own drawing buffer is not counted (the browser owns it).
 */
export interface GpuMemory {
  buffers: number;
  textures: number;
  targets: number;
  total: number;
}

type MemoryKind = 'buffers' | 'textures' | 'targets';

/** One input of a bake, bound to the unit of its position in the list. */
export interface BakeInput {
  sampler: string;
  texture: TextureData;
}

/** Full-screen triangle without vertex data, built from `gl_VertexID`. */
const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  // One triangle across the whole target.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** A uniform block shared by all programs at a fixed binding point. */
export interface UniformBlock {
  readonly floats: number;
  update(data: Float32Array): void;
}

/** Depth-only render target with a comparison sampler, for shadow maps. */
export interface DepthTarget {
  readonly size: number;
  readonly texture: Texture;
}

interface DepthTargetImpl extends DepthTarget {
  fbo: WebGLFramebuffer;
  repeat: boolean;
}

/** What a colour target stores per texel. `'rgba16f'` holds values outside 0–1 with about three decimal digits. */
export type ColorTargetFormat = 'rgba8' | 'rgba16f';

/**
 * Colour render target: textures of one size and format that a program draws into again and again (`Device.fill`),
 * for a table a layer keeps up to date on the graphics card. The textures are read with linear filtering and
 * clamped coordinates.
 */
export interface ColorTarget {
  readonly width: number;
  readonly height: number;
  readonly format: ColorTargetFormat;
  /** One texture per output of the fragment shader, in order. Read them when they are used: a restore replaces them. */
  readonly textures: readonly Texture[];
}

interface ColorTargetImpl extends ColorTarget {
  fbo: WebGLFramebuffer;
  textures: Texture[];
}

/** How a mesh was made, kept (with `retainUploads`) so it can be made again after a context loss. */
interface MeshRecipe {
  /** The data of an uploaded mesh, or the mesh whose buffers a shared mesh draws. */
  data: MeshData | null;
  base: Mesh | null;
  locations: Readonly<Record<string, number>>;
  instances: InstanceBuffer | undefined;
  /** Bytes written into the vertex buffer since the upload, by offset (the last write at an offset counts). */
  patches: Map<number, Uint8Array> | null;
}

/** A bake that can be run again: the textures it stands behind and the call that makes them. */
interface BakeRecipe {
  keys: Texture[];
  alive: number;
  run: () => WebGLTexture[];
}

/** The `WEBGL_lose_context` extension object. */
interface LoseContext {
  loseContext(): void;
  restoreContext(): void;
}

/** The `EXT_clip_control` extension object (typed here: not every DOM library version knows it). */
interface ClipControl {
  readonly LOWER_LEFT_EXT: number;
  readonly NEGATIVE_ONE_TO_ONE_EXT: number;
  readonly ZERO_TO_ONE_EXT: number;
  clipControlEXT(origin: number, depth: number): void;
}

/**
 * The offscreen main target of the reversed and logarithmic depth modes: a multisampled colour and depth buffer to
 * draw into, and a plain texture the samples are resolved to before the copy to the canvas.
 */
interface SceneTarget {
  fbo: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depth: WebGLRenderbuffer;
  resolveFbo: WebGLFramebuffer;
  resolved: Texture;
  width: number;
  height: number;
}

/** Copies the resolved main target to the canvas, pixel for pixel. */
const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_src;
out vec4 o_color;
void main() {
  o_color = vec4(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}`;

/** Samples per pixel of the offscreen main target (what a canvas with antialiasing usually has). */
const SCENE_SAMPLES = 4;

export class Device {
  private readonly gl: GL;
  readonly name: string;
  private emptyVao: WebGLVertexArrayObject;
  private readonly state: Required<Omit<DrawState, 'cullBack' | 'cull'>> & { cull: CullMode } = {
    depthTest: false,
    depthFunc: 'less',
    depthWrite: true,
    cull: 'none',
    blend: null,
    alphaToCoverage: false,
    polygonOffset: null,
  };
  /** The face `gl.cullFace` names now; it is switched only when a draw culls the other one. */
  private cullSide: 'back' | 'front' = 'back';

  private depth: DepthMode = 'standard';
  /** Samples of the offscreen main target, and whether the standard mode draws offscreen too (`setMainSamples`). */
  private sceneSamples = SCENE_SAMPLES;
  private standardOffscreen = false;
  private clip: ClipControl | null = null;
  private scene: SceneTarget | null = null;
  private presentProgram: Program | null = null;
  /** Depth convention of the bound target: true = 1 nearest, 0 farthest (the main target in the reversed mode). */
  private reversedNow = false;
  /** True while the bound program applies the polygon offset itself (the main target in the logarithmic mode). */
  private biasInProgram = false;
  /** The program in use, as far as the device knows (null after code that uses a program behind its back). */
  private current: Program | null = null;
  /** The framebuffer `target` bound last (null: the canvas), so a bake in the middle of a pass can put it back. */
  private boundFbo: WebGLFramebuffer | null = null;
  /** Sampler uniforms with a fixed texture unit (`fixSampler`) and the programs that already have them set. */
  private readonly fixedSamplers: Record<string, number> = {};
  private hasFixedSamplers = false;
  private samplersSet = new WeakSet<Program>();

  /**
   * Context loss (see `contextRestored`). Off by default. When on, the device keeps what every mesh, instance buffer
   * and texture was made from (references to the caller's arrays, not copies; for a bake its inputs) and makes all of
   * them again, in place, in the fresh context: holders of a `Mesh`, `InstanceBuffer` or `Texture` notice nothing.
   * The price is memory: uploaded data stays reachable for as long as its GPU object lives. Set it before anything
   * is uploaded; what was uploaded before is not kept.
   */
  retainUploads = false;
  private readonly programs: Program[] = [];
  private readonly blocks: (() => void)[] = [];
  private readonly depthTargets = new Set<DepthTargetImpl>();
  private readonly colorTargets = new Set<ColorTargetImpl>();
  private readonly meshRecipes = new Map<Mesh, MeshRecipe>();
  /** Vertex buffer → the mesh that owns it, for `writeBuffer`. */
  private readonly vertexOwner = new Map<GpuBuffer, Mesh>();
  private readonly instanceRecipes = new Map<InstanceBuffer, InstanceData>();
  /** The handle a caller holds → how to make the texture again (not for baked ones, see `bakeOf`). */
  private readonly textureRecipes = new Map<Texture, () => WebGLTexture>();
  private readonly bakeOf = new Map<Texture, BakeRecipe>();
  /** The handle a caller holds → the texture that stands behind it now (only once the two differ). */
  private readonly liveTexture = new Map<Texture, WebGLTexture | null>();
  private readonly restoredListeners: (() => void)[] = [];
  private loseExt: LoseContext | null = null;

  /** Bytes per live GPU object, so a delete subtracts what its create added. */
  private compilingPrograms: Program[] = [];
  private readonly allocated = new Map<object, { kind: MemoryKind; bytes: number }>();
  private readonly totals: Record<MemoryKind, number> = { buffers: 0, textures: 0, targets: 0 };

  constructor(gl: GL) {
    this.gl = gl;
    this.name = rendererName(gl);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Cannot create a VAO');
    this.emptyVao = vao;
    gl.cullFace(gl.BACK);
    this.cullSide = 'back';
    this.setState({ ...this.state }, true);
  }

  /** The depth mode in effect (see `setDepthMode`). */
  get depthMode(): DepthMode {
    return this.depth;
  }

  /**
   * Chooses how the main target stores depth. Call it once, before the first frame and before anything is drawn.
   * Returns the mode in effect: `'reversed'` becomes `'logarithmic'` when the browser lacks `EXT_clip_control`.
   * For the two modes other than `'standard'` create the context with `createContext(canvas, mode)`: the device
   * brings its own multisampled target, so the canvas needs neither antialiasing nor a depth buffer.
   */
  setDepthMode(requested: DepthMode): DepthMode {
    const gl = this.gl;
    let mode = requested;
    if (mode === 'reversed') {
      this.clip ??= gl.getExtension('EXT_clip_control') as ClipControl | null;
      if (!this.clip) mode = 'logarithmic';
    }
    if (mode === this.depth) return mode;
    this.depth = mode;
    if (!this.offscreen()) this.dropScene();
    // The convention flags describe the bound target; until the next `target` call that is the main one.
    this.convention(true);
    return mode;
  }

  /**
   * Chooses the samples per pixel of the main target: 0 (no antialiasing), 2 or 4. Call it once, before the first
   * frame, and create the context with the same count (`createContext(canvas, mode, samples)`). Without this call
   * nothing changes: the canvas's own antialiasing in the standard mode, 4 samples in the others. In the standard
   * mode 0 and 4 keep drawing into the canvas (made without or with antialiasing); 2 draws into an offscreen target
   * as the other modes do, as a canvas cannot be asked for a sample count.
   */
  setMainSamples(samples: MainSamples): void {
    if (samples === this.sceneSamples && this.standardOffscreen === (samples === 2)) return;
    this.dropScene();
    this.sceneSamples = samples;
    this.standardOffscreen = samples === 2;
  }

  /** True when the main target is the device's offscreen target rather than the canvas. */
  private offscreen(): boolean {
    return this.depth !== 'standard' || this.standardOffscreen;
  }

  /** Switches clip range, depth comparison and polygon offset to the convention of the target just bound. */
  private convention(main: boolean): void {
    const reversed = main && this.depth === 'reversed';
    const biasInProgram = main && this.depth === 'logarithmic';
    if (reversed === this.reversedNow && biasInProgram === this.biasInProgram) return;
    this.reversedNow = reversed;
    this.biasInProgram = biasInProgram;
    const clip = this.clip;
    if (clip) clip.clipControlEXT(clip.LOWER_LEFT_EXT, reversed ? clip.ZERO_TO_ONE_EXT : clip.NEGATIVE_ONE_TO_ONE_EXT);
    // The cached draw state keeps its meaning; what it maps to in WebGL has just changed.
    this.gl.depthFunc(this.depthFunc(this.state.depthFunc));
    this.applyPolygonOffset(this.state.polygonOffset);
  }

  /** WebGL comparison for "nearer" (`'less'`) or "nearer or equal" (`'lequal'`) in the bound target's convention. */
  private depthFunc(f: 'less' | 'lequal'): number {
    const gl = this.gl;
    if (this.reversedNow) return f === 'less' ? gl.GREATER : gl.GEQUAL;
    return f === 'less' ? gl.LESS : gl.LEQUAL;
  }

  /** Polygon offset in the bound target's convention: positive always pushes away from the viewer. */
  private applyPolygonOffset(o: readonly [number, number] | null): void {
    const gl = this.gl;
    // A program that writes its own depth takes the offset as a uniform right before the draw (`syncDepthBias`).
    if (o && !this.biasInProgram) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      if (this.reversedNow) gl.polygonOffset(-o[0], -o[1]);
      else gl.polygonOffset(o[0], o[1]);
    } else gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  /** Hands the polygon offset of the draw state to the program in use, for programs that write their own depth. */
  private syncDepthBias(): void {
    const p = this.current;
    if (!p) return;
    const o = this.state.polygonOffset;
    p.depthBias(o ? o[0] : 0, o ? o[1] : 0);
  }

  /** The offscreen main target, (re)allocated to the size of the drawing surface. */
  private sceneTarget(): SceneTarget {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (this.scene && this.scene.width === width && this.scene.height === height) return this.scene;
    this.dropScene();
    const fbo = gl.createFramebuffer();
    const resolveFbo = gl.createFramebuffer();
    const color = gl.createRenderbuffer();
    const depth = gl.createRenderbuffer();
    if (!fbo || !resolveFbo || !color || !depth) throw new Error('Cannot create the offscreen main target');
    const samples = Math.min(this.sceneSamples, gl.getParameter(gl.MAX_SAMPLES) as number);
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT32F, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The offscreen main target is incomplete');
    // The texture is created on the active unit; the renderer and the layers bind what they need before every draw.
    const resolved = createTexture(gl, { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, width, height });
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resolved, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The resolve target is incomplete');
    const s: SceneTarget = { fbo, color, depth, resolveFbo, resolved, width, height };
    // Four bytes of colour and four of depth per sample, and the resolved colour.
    this.track(s, 'targets', width * height * (Math.max(1, samples) * 8 + 4));
    this.presentProgram ??= this.program('present', FULLSCREEN_VS, PRESENT_FS);
    this.scene = s;
    return s;
  }

  private dropScene(): void {
    const s = this.scene;
    if (!s) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.boundFbo = null;
    gl.deleteFramebuffer(s.fbo);
    gl.deleteFramebuffer(s.resolveFbo);
    gl.deleteRenderbuffer(s.color);
    gl.deleteRenderbuffer(s.depth);
    gl.deleteTexture(s.resolved);
    this.untrack(s);
    this.scene = null;
  }

  /**
   * Shows the frame. In the reversed and logarithmic depth modes this resolves the samples of the offscreen main
   * target and copies the result to the canvas; in the standard mode the canvas was drawn directly and nothing
   * happens. Afterwards the canvas is the bound framebuffer in every mode, so `finish` reads from it. The copy changes
   * the viewport, the draw state and the texture on unit 0; the next frame sets them again.
   */
  present(): void {
    const s = this.scene;
    const program = this.presentProgram;
    if (!s || !program || !this.offscreen()) return;
    const gl = this.gl;
    // Samples → one colour per pixel. Same size and same format on both sides, as a multisample resolve requires.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.resolveFbo);
    gl.blitFramebuffer(0, 0, s.width, s.height, 0, 0, s.width, s.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    // Resolved colour → canvas, as a plain draw: valid whatever format and antialiasing the canvas has.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.boundFbo = null;
    gl.viewport(0, 0, s.width, s.height);
    this.setState({ depthTest: false, cullBack: false, blend: null, alphaToCoverage: false, polygonOffset: null });
    this.use(program);
    this.texture(0, s.resolved);
    program.int('u_src', 0);
    this.drawFullscreen();
    this.texture(0, null);
    gl.bindVertexArray(null);
  }

  /** True while the graphics context is lost: nothing can be drawn or uploaded until it is restored. */
  get lost(): boolean {
    return this.gl.isContextLost();
  }

  /**
   * Registers a function called at the end of `contextRestored`, when the device's own objects exist again. For
   * owners of GPU objects the device could not make again itself (everything uploaded without `retainUploads`) and
   * for whatever depends on GPU contents that are gone (a rendered shadow map). Returns a function that unregisters.
   */
  onRestored(fn: () => void): () => void {
    this.restoredListeners.push(fn);
    return () => {
      const i = this.restoredListeners.indexOf(fn);
      if (i >= 0) this.restoredListeners.splice(i, 1);
    };
  }

  /**
   * The browser handed back a fresh context after a loss (the platform's `watchContextLoss` reports it): every object
   * of the old one is void. The device puts the context state back and makes again, in place, what it knows how to
   * make: every program (same `Program` objects), uniform block and depth target, and with `retainUploads` every
   * mesh, instance buffer, texture and bake. Then the `onRestored` listeners run. Contents drawn on the GPU (shadow
   * maps) are not kept; whoever drew them draws them again.
   */
  contextRestored(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    forgetContextExtensions(gl);
    this.loseExt = null;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Cannot create a VAO');
    this.emptyVao = vao;
    gl.cullFace(gl.BACK);
    this.cullSide = 'back';
    // The offscreen main target is gone with the context; `target` allocates it again.
    if (this.scene) {
      this.untrack(this.scene);
      this.scene = null;
    }
    // The old context took every object with it. What is made again below is counted again there; what nobody can
    // make again (uploaded without `retainUploads`) must leave the memory count, or `memory()` would report it for
    // ever. A texture that is made again keeps its entry: it is counted under the handle its holder has.
    for (const [obj, a] of this.allocated) {
      if (a.kind === 'textures' && (this.textureRecipes.has(obj as Texture) || this.bakeOf.has(obj as Texture))) continue;
      this.totals[a.kind] -= a.bytes;
      this.allocated.delete(obj);
    }
    this.boundFbo = null;
    this.current = null;
    this.samplersSet = new WeakSet<Program>();
    this.clip = this.depth === 'reversed' ? (gl.getExtension('EXT_clip_control') as ClipControl | null) : null;
    // A fresh context has the standard convention; the next `target` call switches to the depth mode's own.
    this.reversedNow = false;
    this.biasInProgram = false;
    this.setState({ ...this.state }, true);

    for (const p of this.programs) p.restore();
    this.compilingPrograms = [...this.programs];
    for (const fill of this.blocks) fill();
    for (const t of this.depthTargets) {
      if (t.texture) this.untrack(t.texture);
      Object.assign(t, this.makeDepthTarget(t.size, t.repeat));
    }
    for (const t of this.colorTargets) {
      this.untrack(t);
      const made = this.makeColorTarget(t.width, t.height, t.textures.length, t.format);
      // A fresh context that cannot hold the format any more leaves the target without textures; fills are skipped.
      Object.assign(t, made ?? { fbo: null, textures: t.textures.map(() => null as unknown as Texture) });
      if (made) this.track(t, 'targets', colorTargetBytes(t));
    }
    for (const [b, data] of this.instanceRecipes) {
      if (b.buffer) this.untrack(b.buffer);
      const buffer = createBuffer(gl, gl.ARRAY_BUFFER, data.data, gl.DYNAMIC_DRAW);
      this.track(buffer, 'buffers', data.data.byteLength);
      (b as { buffer: GpuBuffer }).buffer = buffer;
    }
    // In the order they were made: a mesh that shares buffers comes after the mesh that owns them.
    for (const [m, r] of this.meshRecipes) {
      for (const b of m.buffers ?? []) {
        this.untrack(b);
        this.vertexOwner.delete(b);
      }
      const fresh = r.data ? this.buildMesh(r.data, r.locations, r.instances) : r.base ? this.buildShared(r.base, r.locations, r.instances) : null;
      if (!fresh) continue;
      // Meshes that share this one's buffers hold its `source` object: it is refilled, not replaced.
      const source = m.source;
      Object.assign(m, fresh);
      if (r.data && source && fresh.source) {
        Object.assign(source, fresh.source);
        m.source = source;
      }
      const vb = r.data ? m.buffers?.[0] : undefined;
      if (!vb) continue;
      this.vertexOwner.set(vb, m);
      if (r.patches) {
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        for (const [offset, bytes] of r.patches) gl.bufferSubData(gl.ARRAY_BUFFER, offset, bytes);
      }
    }
    for (const [key, make] of this.textureRecipes) this.liveTexture.set(key, make());
    for (const recipe of new Set(this.bakeOf.values())) {
      if (recipe.alive <= 0) continue;
      const made = recipe.run();
      recipe.keys.forEach((key, i) => {
        if (this.bakeOf.get(key) === recipe) this.liveTexture.set(key, made[i]!);
        else gl.deleteTexture(made[i]!);
      });
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    for (const fn of [...this.restoredListeners]) fn();
  }

  /**
   * Takes the context away on purpose (`WEBGL_lose_context`), as a driver reset would: for tests of the recovery.
   * Returns false when the browser lacks the extension. `restoreContext` asks the browser to hand a fresh one back.
   */
  loseContext(): boolean {
    this.loseExt ??= this.gl.getExtension('WEBGL_lose_context') as LoseContext | null;
    if (!this.loseExt || this.gl.isContextLost()) return false;
    this.loseExt.loseContext();
    return true;
  }

  restoreContext(): boolean {
    if (!this.loseExt || !this.gl.isContextLost()) return false;
    this.loseExt.restoreContext();
    return true;
  }

  /** GPU memory allocated through this device and not deleted, by kind. */
  memory(): GpuMemory {
    const t = this.totals;
    return { buffers: t.buffers, textures: t.textures, targets: t.targets, total: t.buffers + t.textures + t.targets };
  }

  private track(obj: object, kind: MemoryKind, bytes: number): void {
    this.allocated.set(obj, { kind, bytes });
    this.totals[kind] += bytes;
  }

  private untrack(obj: object): void {
    const a = this.allocated.get(obj);
    if (!a) return;
    this.totals[a.kind] -= a.bytes;
    this.allocated.delete(obj);
  }

  uniformBlock(binding: number, data: Float32Array, dynamic: boolean): UniformBlock {
    const gl = this.gl;
    let b = gl.createBuffer();
    if (!b && !gl.isContextLost()) throw new Error('Cannot create a uniform buffer');
    // The data last handed over (a reference), so the block can be filled again after a context loss.
    let last = data;
    const fill = (): void => {
      gl.bindBuffer(gl.UNIFORM_BUFFER, b);
      gl.bufferData(gl.UNIFORM_BUFFER, data.byteLength, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, last);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, binding, b);
    };
    if (b) {
      this.track(b, 'buffers', data.byteLength);
      gl.bindBuffer(gl.UNIFORM_BUFFER, b);
      gl.bufferData(gl.UNIFORM_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, binding, b);
    }
    this.blocks.push(() => {
      if (b) this.untrack(b);
      b = gl.createBuffer();
      if (!b) return;
      this.track(b, 'buffers', data.byteLength);
      fill();
    });
    return {
      floats: data.length,
      update(next: Float32Array): void {
        last = next;
        gl.bindBuffer(gl.UNIFORM_BUFFER, b);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, next);
      },
    };
  }

  /** `repeat`: texture coordinates outside 0–1 wrap around instead of clamping to the edge (default off). */
  depthTarget(size: number, repeat = false): DepthTarget {
    if (this.gl.isContextLost()) {
      // Made in the fresh context by `contextRestored`.
      const t: DepthTargetImpl = { size, repeat, texture: null as unknown as Texture, fbo: null as unknown as WebGLFramebuffer };
      this.depthTargets.add(t);
      return t;
    }
    const t: DepthTargetImpl = { size, repeat, ...this.makeDepthTarget(size, repeat) };
    this.depthTargets.add(t);
    return t;
  }

  /** The texture and framebuffer of a depth target. Read `DepthTarget.texture` when it is used: a restore replaces it. */
  private makeDepthTarget(size: number, repeat: boolean): { texture: Texture; fbo: WebGLFramebuffer } {
    const gl = this.gl;
    const texture = createTexture(gl, {
      internalFormat: gl.DEPTH_COMPONENT24,
      format: gl.DEPTH_COMPONENT,
      type: gl.UNSIGNED_INT,
      width: size,
      height: size,
      minFilter: gl.LINEAR,
      magFilter: gl.LINEAR,
      ...(repeat ? { wrap: gl.REPEAT } : {}),
    });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Cannot create a depth target');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Depth target is incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.track(texture, 'targets', size * size * 4);
    return { texture, fbo };
  }

  /**
   * A colour target of `count` textures (one per output of the fragment shader that fills it). Returns null where
   * the format cannot be drawn into: `'rgba16f'` needs `EXT_color_buffer_float` or `EXT_color_buffer_half_float`,
   * and nothing can be made while the context is lost. The caller then does without the target.
   */
  colorTarget(width: number, height: number, count: number, format: ColorTargetFormat): ColorTarget | null {
    if (this.gl.isContextLost()) return null;
    const made = this.makeColorTarget(width, height, count, format);
    if (!made) return null;
    const t: ColorTargetImpl = { width, height, format, ...made };
    this.colorTargets.add(t);
    this.track(t, 'targets', colorTargetBytes(t));
    return t;
  }

  /** The textures and framebuffer of a colour target, or null when the format cannot be drawn into. */
  private makeColorTarget(width: number, height: number, count: number, format: ColorTargetFormat): { textures: Texture[]; fbo: WebGLFramebuffer } | null {
    const gl = this.gl;
    // Asking for the extension is what switches it on, also in a context made again after a loss.
    if (format === 'rgba16f' && !gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null;
    const f = format === 'rgba16f' ? { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const textures: Texture[] = [];
    for (let i = 0; i < count; i++) textures.push(createTexture(gl, { ...f, width, height, minFilter: gl.LINEAR, magFilter: gl.LINEAR }));
    gl.bindTexture(gl.TEXTURE_2D, null);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Cannot create a colour target');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundFbo);
    if (complete) return { textures, fbo };
    gl.deleteFramebuffer(fbo);
    for (const t of textures) gl.deleteTexture(t);
    return null;
  }

  /**
   * Draws one triangle across the whole of a colour target with `program`: its fragment shader has one output per
   * texture of the target and writes every texel, so nothing is cleared. Afterwards the target bound before is
   * bound again. The viewport and the draw state are changed: call it between passes (`Layer.prepare` of render),
   * where the next pass sets both, not in the middle of one.
   */
  fill(t: ColorTarget, program: Program, uniforms: Uniforms = {}): void {
    const fbo = (t as ColorTargetImpl).fbo;
    if (!fbo) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, t.width, t.height);
    this.setState({ depthTest: false, depthWrite: false, cullBack: false, blend: null, alphaToCoverage: false, polygonOffset: null });
    this.use(program);
    for (const name in uniforms) program.set(name, uniforms[name]!);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundFbo);
  }

  /** A 1 × 1 RGBA8 texture. */
  pixelTexture(rgba: readonly [number, number, number, number]): Texture {
    const gl = this.gl;
    const make = (): WebGLTexture => createTexture(gl, { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, width: 1, height: 1, data: new Uint8Array(rgba) });
    const t = this.newTexture(make);
    this.track(t, 'textures', 4);
    return t;
  }

  /**
   * A texture made by `make`. With `retainUploads` the call is kept so the texture can be made again; while the
   * context is lost the caller gets a handle with nothing behind it yet.
   */
  private newTexture(make: () => WebGLTexture): Texture {
    if (!this.retainUploads) return make();
    let t: Texture;
    if (this.gl.isContextLost()) {
      t = {} as Texture;
      this.liveTexture.set(t, null);
    } else t = make();
    this.textureRecipes.set(t, make);
    return t;
  }

  /**
   * Draws into a depth target, or into the main target with `null`: the canvas, or in the reversed and logarithmic
   * depth modes the offscreen target that `present` copies to the canvas. Also switches the depth convention (clip
   * range, comparison, polygon offset sign, clear value) to that of the target, see the top of this file.
   */
  target(t: DepthTarget | null): void {
    const gl = this.gl;
    this.boundFbo = t ? (t as DepthTargetImpl).fbo : this.offscreen() ? this.sceneTarget().fbo : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundFbo);
    this.convention(t === null);
  }

  /**
   * Copies the depth of the square `0…size` (pixels from the lower left corner) of one depth target into the same
   * square of another of the same size. Nothing else of `to` changes. Afterwards the target bound before is bound again.
   */
  copyDepth(from: DepthTarget, to: DepthTarget, size: number): void {
    const a = (from as DepthTargetImpl).fbo;
    const b = (to as DepthTargetImpl).fbo;
    if (!a || !b || size <= 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, a);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b);
    gl.blitFramebuffer(0, 0, size, size, 0, 0, size, size, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundFbo);
  }

  viewport(x: number, y: number, w: number, h: number): void {
    this.gl.viewport(x, y, w, h);
  }

  /** Clears colour (when given) and depth (to the farthest value of the bound target: 1, or 0 with reversed depth). */
  clear(color: readonly [number, number, number] | null, depth: boolean): void {
    const gl = this.gl;
    let bits = 0;
    if (color) {
      gl.clearColor(color[0], color[1], color[2], 1);
      bits |= gl.COLOR_BUFFER_BIT;
    }
    if (depth) {
      gl.clearDepth(this.reversedNow ? 0 : 1);
      bits |= gl.DEPTH_BUFFER_BIT;
    }
    gl.clear(bits);
  }

  /**
   * Clears depth (to the farthest value of the bound target) inside one rectangle of the target, given in pixels
   * from its lower left corner. Everything outside the rectangle is kept.
   */
  clearDepthRect(x: number, y: number, w: number, h: number): void {
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    gl.clearDepth(this.reversedNow ? 0 : 1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  texture(unit: number, tex: Texture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    // After a context loss a handle may stand for a texture made again (`retainUploads`).
    if (tex && this.liveTexture.size > 0) {
      const live = this.liveTexture.get(tex);
      if (live !== undefined) {
        gl.bindTexture(gl.TEXTURE_2D, live);
        return;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /**
   * Applies the given fields. `force` applies them even when the cache says they are set already: needed after code
   * outside the device (a texture bake) may have changed the context state.
   */
  setState(s: DrawState, force = false): void {
    const gl = this.gl;
    const c = this.state;
    if (force) {
      // Flip the cached copy of every given field, so each comparison below fails and the field is applied.
      if (s.depthTest !== undefined) c.depthTest = !s.depthTest;
      if (s.depthFunc !== undefined) c.depthFunc = s.depthFunc === 'less' ? 'lequal' : 'less';
      if (s.depthWrite !== undefined) c.depthWrite = !s.depthWrite;
      if (s.blend !== undefined) c.blend = s.blend ? null : { src: 'one', dst: 'one' };
      if (s.alphaToCoverage !== undefined) c.alphaToCoverage = !s.alphaToCoverage;
      if (s.polygonOffset !== undefined) c.polygonOffset = s.polygonOffset ? null : [0, 0];
    }
    if (s.depthTest !== undefined && s.depthTest !== c.depthTest) {
      if (s.depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      c.depthTest = s.depthTest;
    }
    if (s.depthFunc !== undefined && s.depthFunc !== c.depthFunc) {
      c.depthFunc = s.depthFunc;
      gl.depthFunc(this.depthFunc(s.depthFunc));
    }
    if (s.depthWrite !== undefined && s.depthWrite !== c.depthWrite) {
      gl.depthMask(s.depthWrite);
      c.depthWrite = s.depthWrite;
    }
    // `cull` wins over `cullBack`; true culls the back faces, false nothing. The face is switched only on a change.
    const cull = s.cull ?? (s.cullBack === undefined ? undefined : s.cullBack ? 'back' : 'none');
    if (cull !== undefined) {
      const on = cull !== 'none';
      if (force || on !== (c.cull !== 'none')) {
        if (on) gl.enable(gl.CULL_FACE);
        else gl.disable(gl.CULL_FACE);
      }
      if (on && (force || cull !== this.cullSide)) {
        gl.cullFace(cull === 'front' ? gl.FRONT : gl.BACK);
        this.cullSide = cull;
      }
      c.cull = cull;
    }
    if (s.blend !== undefined && !sameBlend(s.blend, c.blend)) {
      if (s.blend) {
        gl.enable(gl.BLEND);
        const f = (b: BlendFactor): number => blendFactor(gl, b);
        gl.blendFuncSeparate(f(s.blend.src), f(s.blend.dst), f(s.blend.srcAlpha ?? s.blend.src), f(s.blend.dstAlpha ?? s.blend.dst));
      } else gl.disable(gl.BLEND);
      c.blend = s.blend;
    }
    if (s.alphaToCoverage !== undefined && s.alphaToCoverage !== c.alphaToCoverage) {
      if (s.alphaToCoverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      c.alphaToCoverage = s.alphaToCoverage;
    }
    if (s.polygonOffset !== undefined && !samePair(s.polygonOffset, c.polygonOffset)) {
      c.polygonOffset = s.polygonOffset;
      this.applyPolygonOffset(s.polygonOffset);
    }
  }

  /**
   * Starts compiling and linking a program. `attribs` fixes attribute locations so one vertex array serves several
   * programs. The status is checked on first use; programs made together compile in parallel in the driver.
   */
  program(label: string, vs: string, fs: string, attribs: Record<string, number> = {}): Program {
    const p = new Program(this.gl, label, vs, fs, attribs);
    this.compilingPrograms.push(p);
    this.programs.push(p);
    return p;
  }

  /**
   * Number of programs the driver is still compiling (`KHR_parallel_shader_compile`; 0 without it). A loading screen
   * can poll it between frames; nothing blocks.
   */
  compiling(): number {
    this.compilingPrograms = this.compilingPrograms.filter((p) => !p.isComplete());
    return this.compilingPrograms.length;
  }

  use(p: Program): void {
    p.use();
    this.current = p;
    if (this.hasFixedSamplers && !this.samplersSet.has(p)) {
      // A sampler uniform keeps its unit for the life of the program, so once is enough.
      this.samplersSet.add(p);
      for (const name in this.fixedSamplers) p.int(name, this.fixedSamplers[name]!);
    }
  }

  /**
   * Gives a sampler uniform a fixed texture unit in every program used from now on (set once per program, at its
   * first `use`; a program without the uniform ignores it). For a texture the renderer binds itself for every layer.
   */
  fixSampler(name: string, unit: number): void {
    this.fixedSamplers[name] = unit;
    this.hasFixedSamplers = true;
  }

  draw(m: Mesh): void {
    if (this.biasInProgram) this.syncDepthBias();
    drawMesh(this.gl, m);
  }

  /** One triangle covering the whole viewport, without vertex data: the vertex shader builds it from `gl_VertexID`. */
  drawFullscreen(): void {
    if (this.biasInProgram) this.syncDepthBias();
    this.gl.bindVertexArray(this.emptyVao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /**
   * Overwrites an array buffer with `count` elements of `data` (floats, or bytes for a byte array), starting at the
   * start of the buffer or `offsetBytes` into it.
   */
  writeBuffer(buffer: GpuBuffer, data: Float32Array | Uint8Array, count: number, offsetBytes = 0): void {
    // A length of 0 would mean "everything from the offset on" to WebGL.
    if (count <= 0) return;
    const gl = this.gl;
    if (this.retainUploads) {
      // A write into a mesh's vertices is kept, so a restore after a context loss ends with the same bytes.
      const owner = this.vertexOwner.get(buffer);
      const recipe = owner ? this.meshRecipes.get(owner) : undefined;
      if (recipe) {
        // Taken out first, so the write goes to the end of the list: a restore replays the writes in their order,
        // which matters where two of them overlap.
        const patches = (recipe.patches ??= new Map());
        patches.delete(offsetBytes);
        patches.set(offsetBytes, new Uint8Array(data.buffer, data.byteOffset, count * data.BYTES_PER_ELEMENT).slice());
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, offsetBytes, data, 0, count);
  }

  /** Unbinds the vertex array, so later buffer uploads cannot change a mesh by accident. */
  unbindMesh(): void {
    this.gl.bindVertexArray(null);
  }

  /** Uploads a mesh. `locations` are the attribute locations of the material it is drawn with. */
  createMesh(data: MeshData, locations: Readonly<Record<string, number>>, instances?: InstanceBuffer): Mesh {
    if (!this.retainUploads) return this.buildMesh(data, locations, instances);
    const m = this.gl.isContextLost() ? this.emptyMesh(data, instances) : this.buildMesh(data, locations, instances);
    this.meshRecipes.set(m, { data, base: null, locations, instances, patches: null });
    const vb = m.buffers?.[0];
    if (vb) this.vertexOwner.set(vb, m);
    return m;
  }

  /** A mesh object with nothing behind it yet: what `createMesh` hands out while the context is lost. */
  private emptyMesh(data: MeshData, instances?: InstanceBuffer): Mesh {
    const gl = this.gl;
    const lines = data.primitive === 'lines';
    const indexType = data.indices ? (data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT) : null;
    const mode = lines ? { mode: gl.LINES } : {};
    const none = null as unknown as WebGLBuffer;
    return {
      vao: null as unknown as WebGLVertexArrayObject,
      count: data.count,
      indexType,
      triangles: lines ? 0 : data.count / 3,
      instances: instances ? (instances.floats * 4) / instances.layout.stride : 0,
      ...mode,
      buffers: [],
      bytes: data.vertices.byteLength + (data.indices?.byteLength ?? 0),
      source: { vertices: none, indices: null, layout: data.layout, indexType, count: data.count, ...mode },
    };
  }

  private buildMesh(data: MeshData, locations: Readonly<Record<string, number>>, instances?: InstanceBuffer): Mesh {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Cannot create a VAO');
    gl.bindVertexArray(vao);
    const vb = createBuffer(gl, gl.ARRAY_BUFFER, data.vertices);
    this.track(vb, 'buffers', data.vertices.byteLength);
    bindAttribs(gl, vb, data.layout.stride, this.attribSpecs(data.layout, locations, 0));
    if (instances) bindAttribs(gl, instances.buffer, instances.layout.stride, this.attribSpecs(instances.layout, locations, 1));
    const buffers = [vb];
    let ib: WebGLBuffer | null = null;
    if (data.indices) {
      ib = createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, data.indices);
      this.track(ib, 'buffers', data.indices.byteLength);
      buffers.push(ib);
    }
    gl.bindVertexArray(null);
    const lines = data.primitive === 'lines';
    const indexType = data.indices ? (data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT) : null;
    const mode = lines ? { mode: gl.LINES } : {};
    return {
      vao,
      count: data.count,
      indexType,
      triangles: lines ? 0 : data.count / 3,
      instances: instances ? (instances.floats * 4) / instances.layout.stride : 0,
      ...mode,
      buffers,
      bytes: data.vertices.byteLength + (data.indices?.byteLength ?? 0),
      source: { vertices: vb, indices: ib, layout: data.layout, indexType, count: data.count, ...mode },
    };
  }

  /**
   * A mesh that draws the vertex and index buffers of `base` (no new upload, `bytes` 0), with its own attribute
   * locations and optionally its own instance buffer. Deleting it leaves `base`'s buffers alone; delete `base` last.
   */
  shareMesh(base: Mesh, locations: Readonly<Record<string, number>>, instances?: InstanceBuffer): Mesh {
    const m = this.buildShared(base, locations, instances);
    if (this.retainUploads) this.meshRecipes.set(m, { data: null, base, locations, instances, patches: null });
    return m;
  }

  private buildShared(base: Mesh, locations: Readonly<Record<string, number>>, instances?: InstanceBuffer): Mesh {
    const src = base.source;
    if (!src) throw new Error('shareMesh: the base mesh has no source buffers');
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao && !(this.retainUploads && gl.isContextLost())) throw new Error('Cannot create a VAO');
    gl.bindVertexArray(vao);
    bindAttribs(gl, src.vertices, src.layout.stride, this.attribSpecs(src.layout, locations, 0));
    if (instances) bindAttribs(gl, instances.buffer, instances.layout.stride, this.attribSpecs(instances.layout, locations, 1));
    if (src.indices) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, src.indices);
    gl.bindVertexArray(null);
    return {
      vao: vao as WebGLVertexArrayObject,
      count: src.count,
      indexType: src.indexType,
      triangles: src.mode !== undefined ? 0 : src.count / 3,
      instances: instances ? (instances.floats * 4) / instances.layout.stride : 0,
      ...(src.mode !== undefined ? { mode: src.mode } : {}),
      buffers: [],
      bytes: 0,
      source: src,
    };
  }

  /** Uploads a per-instance stream that is rewritten often (culling). */
  createInstances(data: InstanceData): InstanceBuffer {
    const gl = this.gl;
    if (this.retainUploads && gl.isContextLost()) {
      const waiting: InstanceBuffer = { buffer: null as unknown as GpuBuffer, layout: data.layout, floats: data.data.length };
      this.instanceRecipes.set(waiting, data);
      return waiting;
    }
    const buffer = createBuffer(gl, gl.ARRAY_BUFFER, data.data, gl.DYNAMIC_DRAW);
    this.track(buffer, 'buffers', data.data.byteLength);
    const b: InstanceBuffer = { buffer, layout: data.layout, floats: data.data.length };
    if (this.retainUploads) this.instanceRecipes.set(b, data);
    return b;
  }

  deleteMesh(m: Mesh): void {
    this.gl.deleteVertexArray(m.vao);
    for (const b of m.buffers ?? []) {
      this.untrack(b);
      this.vertexOwner.delete(b);
      this.gl.deleteBuffer(b);
    }
    this.meshRecipes.delete(m);
  }

  deleteInstances(b: InstanceBuffer): void {
    this.untrack(b.buffer);
    this.instanceRecipes.delete(b);
    this.gl.deleteBuffer(b.buffer);
  }

  /** Uploads a texture. */
  createTexture(data: TextureData): Texture {
    const gl = this.gl;
    const make = (): WebGLTexture => {
      const f = textureFormat(gl, data.format);
      const made = createTexture(gl, { ...f, width: data.width, height: data.height, data: data.data, ...sampling(gl, data) });
      if (data.filter === 'mipmap') this.finishMipmaps(made, data);
      return made;
    };
    const t = this.newTexture(make);
    this.track(t, 'textures', textureBytes(data.width, data.height, texelBytes(data.format), data.filter === 'mipmap'));
    return t;
  }

  deleteTexture(t: Texture): void {
    this.untrack(t);
    this.textureRecipes.delete(t);
    const bake = this.bakeOf.get(t);
    if (bake) {
      this.bakeOf.delete(t);
      bake.alive--;
    }
    const live = this.liveTexture.get(t);
    if (live !== undefined) {
      this.liveTexture.delete(t);
      this.gl.deleteTexture(live);
    } else this.gl.deleteTexture(t);
  }

  /**
   * Runs `fs` once over a full-screen triangle of `width × height` into new RGBA8 targets and returns them.
   * Inputs are uploaded, bound to the units 0, 1, … and deleted afterwards.
   */
  bake(label: string, fs: string, width: number, height: number, inputs: readonly BakeInput[], uniforms: Uniforms, targets: readonly TextureSampling[]): Texture[] {
    const run = (): WebGLTexture[] => this.runBake(label, fs, width, height, inputs, uniforms, targets);
    const lost = this.retainUploads && this.gl.isContextLost();
    // While the context is lost the caller gets handles with nothing behind them; the bake runs on restore.
    const outs: Texture[] = lost ? targets.map(() => ({}) as Texture) : run();
    outs.forEach((t, i) => this.track(t, 'textures', textureBytes(width, height, 4, targets[i]!.filter === 'mipmap')));
    if (this.retainUploads) {
      const recipe: BakeRecipe = { keys: outs.slice(), alive: outs.length, run };
      for (const t of outs) {
        this.bakeOf.set(t, recipe);
        if (lost) this.liveTexture.set(t, null);
      }
    }
    return outs;
  }

  private runBake(label: string, fs: string, width: number, height: number, inputs: readonly BakeInput[], uniforms: Uniforms, targets: readonly TextureSampling[]): WebGLTexture[] {
    const gl = this.gl;
    const inputTextures = inputs.map((i) => this.createTexture(i.texture));
    const outs = targets.map((t) => createTexture(gl, { ...textureFormat(gl, 'rgba8'), width, height, ...sampling(gl, t) }));
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    outs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(outs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Bake target of ${label} is incomplete`);

    const prog = new Program(gl, label, FULLSCREEN_VS, fs);
    prog.use();
    // The bake program is used behind the device's back and deleted below.
    this.current = null;
    gl.viewport(0, 0, width, height);
    this.setState({ depthTest: false, cullBack: false, blend: null, alphaToCoverage: false, polygonOffset: null });
    inputs.forEach((input, unit) => {
      this.texture(unit, inputTextures[unit]!);
      prog.int(input.sampler, unit);
    });
    for (const [name, v] of Object.entries(uniforms)) prog.set(name, v);
    this.drawFullscreen();
    gl.bindVertexArray(null);

    // Back to the canvas, as ever. With an offscreen main target: back to whatever `target` bound, so a bake in the
    // middle of a pass does not send the rest of the pass to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.offscreen() ? this.boundFbo : null);
    gl.deleteFramebuffer(fbo);
    for (const t of inputTextures) this.deleteTexture(t);
    gl.deleteProgram(prog.handle);
    outs.forEach((t, i) => {
      if (targets[i]!.filter === 'mipmap') this.finishMipmaps(t, targets[i]!);
    });
    return outs;
  }

  private finishMipmaps(t: Texture, s: TextureSampling): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.generateMipmap(gl.TEXTURE_2D);
    const aniso = s.anisotropy ? gl.getExtension('EXT_texture_filter_anisotropic') : null;
    if (aniso && s.anisotropy) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(s.anisotropy, max));
    }
  }

  private attribSpecs(layout: VertexLayout, locations: Readonly<Record<string, number>>, divisor: number): AttribSpec[] {
    const specs: AttribSpec[] = [];
    for (const a of layout.attribs) {
      const loc = locations[a.name];
      if (loc === undefined) continue;
      specs.push({ loc, size: a.size, type: scalarType(this.gl, a.type), normalized: a.normalized ?? false, integer: a.integer ?? false, offset: a.offset, divisor });
    }
    return specs;
  }

  /** Hands the queued commands to the graphics card without waiting for them. */
  flush(): void {
    this.gl.flush();
  }

  /**
   * Samples per pixel of the main target: the offscreen target's in the reversed and logarithmic depth modes, the
   * canvas's otherwise (0 without antialiasing). Queries the context; meant for statistics, not for every frame.
   */
  mainSamples(): number {
    const gl = this.gl;
    if (this.offscreen()) return Math.min(this.sceneSamples, gl.getParameter(gl.MAX_SAMPLES) as number);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const samples = gl.getParameter(gl.SAMPLES) as number;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundFbo);
    return samples;
  }

  /**
   * Waits until the graphics card has finished all work (by reading one pixel). A read into a client array has to
   * return the pixel, so the call blocks until every command before it that the bound target depends on is done.
   */
  finish(): void {
    const px = new Uint8Array(4);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
  }
}

/** Bytes of a 2D texture; a full mipmap chain adds a third. */
function textureBytes(width: number, height: number, texel: number, mipmaps: boolean): number {
  const base = width * height * texel;
  return mipmaps ? Math.round((base * 4) / 3) : base;
}

/** Bytes of the textures of a colour target. */
function colorTargetBytes(t: ColorTarget): number {
  return t.width * t.height * t.textures.length * (t.format === 'rgba16f' ? 8 : 4);
}

function blendFactor(gl: GL, b: BlendFactor): number {
  switch (b) {
    case 'zero':
      return gl.ZERO;
    case 'one':
      return gl.ONE;
    case 'src-alpha':
      return gl.SRC_ALPHA;
    case 'one-minus-src-alpha':
      return gl.ONE_MINUS_SRC_ALPHA;
  }
}

function sameBlend(a: BlendSpec | null, b: BlendSpec | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.src === b.src && a.dst === b.dst && (a.srcAlpha ?? a.src) === (b.srcAlpha ?? b.src) && (a.dstAlpha ?? a.dst) === (b.dstAlpha ?? b.dst);
}

function samePair(a: readonly [number, number] | null, b: readonly [number, number] | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1];
}

function scalarType(gl: GL, t: ScalarType): number {
  switch (t) {
    case 'f32':
      return gl.FLOAT;
    case 'i8':
      return gl.BYTE;
    case 'u8':
      return gl.UNSIGNED_BYTE;
    case 'i16':
      return gl.SHORT;
    case 'u16':
      return gl.UNSIGNED_SHORT;
    case 'i32':
      return gl.INT;
    case 'u32':
      return gl.UNSIGNED_INT;
  }
}

function textureFormat(gl: GL, f: TextureFormat): { internalFormat: number; format: number; type: number } {
  switch (f) {
    case 'r8':
      return { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
    case 'r8ui':
      return { internalFormat: gl.R8UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_BYTE };
    case 'rg8':
      return { internalFormat: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE };
    case 'rgba8':
      return { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  }
}

function sampling(gl: GL, s: TextureSampling): { minFilter: number; magFilter: number } {
  if (s.filter === 'mipmap') return { minFilter: gl.LINEAR_MIPMAP_LINEAR, magFilter: gl.LINEAR };
  if (s.filter === 'linear') return { minFilter: gl.LINEAR, magFilter: gl.LINEAR };
  return { minFilter: gl.NEAREST, magFilter: gl.NEAREST };
}
