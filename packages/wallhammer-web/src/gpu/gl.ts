// Thin layer over WebGL2: programs, buffers, textures. No fallback paths for older browsers.

import type { VertexLayout } from '../base/data.ts';
import type { UniformValue } from '../base/material.ts';
import type { DepthMode } from '../base/view.ts';

export type GL = WebGL2RenderingContext;
/** Opaque GPU objects, so modules above gpu can hold them without naming WebGL. */
export type Texture = WebGLTexture;
export type GpuBuffer = WebGLBuffer;

/** A surface that can hand out a WebGL2 context: an on-screen or offscreen canvas. */
export interface ContextSource {
  getContext(contextId: 'webgl2', options?: WebGLContextAttributes): WebGL2RenderingContext | null;
}

/** Samples per pixel of the main target that can be asked for (`Device.setMainSamples`). */
export type MainSamples = 0 | 2 | 4;

/**
 * Creates the WebGL2 context. `depth` is the depth mode the device will be asked for (`Device.setDepthMode`): in the
 * reversed and logarithmic modes the device draws into its own multisampled target with a 32-bit float depth buffer
 * and copies the result to the canvas, so the canvas itself is created without antialiasing and without depth.
 * `samples` is what the device will be asked for with `Device.setMainSamples`. Unset: the canvas's own antialiasing
 * (standard mode) or 4 samples (the other modes), as before. In the standard mode 0 makes the canvas without
 * antialiasing, 4 with it (the browser's usual count) and 2 makes it plain, as the device then draws offscreen.
 * `readableDepth` is what the device will be asked for with `Device.setReadableDepth`: true makes the canvas plain in
 * the standard mode too, as the device then draws offscreen.
 */
export function createContext(canvas: ContextSource, depth: DepthMode = 'standard', samples?: MainSamples, readableDepth = false): GL {
  const own = depth === 'standard' && samples !== 2 && !readableDepth;
  const gl = canvas.getContext('webgl2', {
    antialias: own && samples !== 0,
    alpha: false,
    depth: own,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('This browser does not support WebGL2.');
  return gl;
}

/** Name of the graphics device as reported by the browser. */
export function rendererName(gl: GL): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

function createShader(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Cannot create a shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

function shaderError(gl: GL, sh: WebGLShader, src: string, label: string): Error {
  const log = gl.getShaderInfoLog(sh) ?? '';
  const numbered = src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
    .join('\n');
  return new Error(`Shader ${label} failed to compile:\n${log}\n${numbered}`);
}

/** Uniform blocks shared by all programs and their fixed binding points. */
export const UBO_BINDING = { Frame: 0, Palette: 1, PointLights: 2 } as const;

/** `KHR_parallel_shader_compile` of a context, looked up once (null without the extension). */
const parallelCompile = new WeakMap<GL, { COMPLETION_STATUS_KHR: number } | null>();
function parallelExt(gl: GL): { COMPLETION_STATUS_KHR: number } | null {
  let e = parallelCompile.get(gl);
  if (e === undefined) {
    e = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
    parallelCompile.set(gl, e);
  }
  return e;
}

/** Forgets the extension objects looked up for a context: after a context loss they belong to the old context. */
export function forgetContextExtensions(gl: GL): void {
  parallelCompile.delete(gl);
}

/**
 * A shader program. Compiling and linking are only started here; the result is checked on first use (or by
 * `settle()`), so a batch of programs made together compiles in parallel in the driver instead of one after another.
 * With `KHR_parallel_shader_compile`, `isComplete()` tells without blocking whether the driver is done.
 */
export class Program {
  /** The WebGL program. Replaced by `restore` after a context loss, so read it when it is needed. */
  handle: WebGLProgram;
  /** What the program was made from, kept so it can be made again (`restore`). */
  private readonly made: { label: string; vs: string; fs: string; attribs: Record<string, number> };
  private readonly gl: GL;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();
  private pending: { label: string; vs: string; fs: string; v: WebGLShader; f: WebGLShader } | null;
  /** Last value of `u_whDepthBias` set on this program (a uniform starts at 0). */
  private biasFactor = 0;
  private biasUnits = 0;

  /** `attribs` assigns fixed numbers to attribute names so one VAO can be shared between programs. */
  constructor(gl: GL, label: string, vs: string, fs: string, attribs: Record<string, number> = {}) {
    this.gl = gl;
    this.made = { label, vs, fs, attribs };
    // A program made while the context is lost has nothing behind it until `restore`.
    if (gl.isContextLost()) {
      this.handle = null as unknown as WebGLProgram;
      this.pending = null;
      return;
    }
    const p = gl.createProgram();
    if (!p) throw new Error('Cannot create a program');
    const v = createShader(gl, gl.VERTEX_SHADER, vs);
    const f = createShader(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
    gl.linkProgram(p);
    this.handle = p;
    this.pending = { label, vs, fs, v, f };
  }

  /**
   * Makes the program again in a fresh context (after a context loss): compiles and links the same sources and
   * forgets every uniform location and value of the old one. As after construction, the status is checked on first use.
   */
  restore(): void {
    const gl = this.gl;
    const { label, vs, fs, attribs } = this.made;
    this.locations.clear();
    this.biasFactor = 0;
    this.biasUnits = 0;
    const p = gl.createProgram();
    if (!p) {
      this.pending = null;
      return;
    }
    const v = createShader(gl, gl.VERTEX_SHADER, vs);
    const f = createShader(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
    gl.linkProgram(p);
    this.handle = p;
    this.pending = { label, vs, fs, v, f };
  }

  /** True when the program is checked, or the driver reports it finished (always true without the extension). */
  isComplete(): boolean {
    if (!this.pending) return true;
    const ext = parallelExt(this.gl);
    return !ext || this.gl.getProgramParameter(this.handle, ext.COMPLETION_STATUS_KHR) === true;
  }

  /** Waits for the driver if needed, checks compile and link status (throws with the log) and binds uniform blocks. */
  settle(): void {
    const q = this.pending;
    if (!q) return;
    this.pending = null;
    const gl = this.gl;
    const p = this.handle;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (!gl.getShaderParameter(q.v, gl.COMPILE_STATUS)) throw shaderError(gl, q.v, q.vs, `${q.label} (vertex)`);
      if (!gl.getShaderParameter(q.f, gl.COMPILE_STATUS)) throw shaderError(gl, q.f, q.fs, `${q.label} (fragment)`);
      throw new Error(`Program ${q.label} failed to link: ${gl.getProgramInfoLog(p) ?? ''}`);
    }
    gl.deleteShader(q.v);
    gl.deleteShader(q.f);
    for (const [name, binding] of Object.entries(UBO_BINDING)) {
      const idx = gl.getUniformBlockIndex(p, name);
      if (idx !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, idx, binding);
    }
  }

  use(): void {
    if (this.pending) this.settle();
    this.gl.useProgram(this.handle);
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name);
    if (l === undefined) {
      if (this.pending) this.settle();
      l = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, l);
    }
    return l;
  }

  // Uniform setters for the program in use. A name the shader does not use is ignored, as in WebGL.
  int(name: string, v: number): void {
    this.gl.uniform1i(this.loc(name), v);
  }
  ivec4(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4i(this.loc(name), x, y, z, w);
  }
  float(name: string, v: number): void {
    this.gl.uniform1f(this.loc(name), v);
  }
  vec2(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.loc(name), x, y);
  }
  vec3(name: string, x: number, y: number, z: number): void {
    this.gl.uniform3f(this.loc(name), x, y, z);
  }
  vec3v(name: string, v: ArrayLike<number>): void {
    this.gl.uniform3fv(this.loc(name), v as Float32List);
  }
  /** A `vec4` array uniform (`uniform vec4 name[n]`): `v` holds 4 floats per element, as many elements as it fills. */
  vec4v(name: string, v: ArrayLike<number>): void {
    this.gl.uniform4fv(this.loc(name), v as Float32List);
  }
  mat4(name: string, m: Float32Array): void {
    this.gl.uniformMatrix4fv(this.loc(name), false, m);
  }

  /**
   * Depth offset `[factor, units]` for a program that writes its own depth (logarithmic depth mode) and so gets no
   * polygon offset from the pipeline: sets `u_whDepthBias` of the program in use, only when the value changes.
   * The device calls it before a draw.
   */
  depthBias(factor: number, units: number): void {
    if (factor === this.biasFactor && units === this.biasUnits) return;
    this.biasFactor = factor;
    this.biasUnits = units;
    this.gl.uniform2f(this.loc('u_whDepthBias'), factor, units);
  }

  /** Sets a uniform from its tagged value. */
  set(name: string, v: UniformValue): void {
    const gl = this.gl;
    const l = this.loc(name);
    if ('int' in v) gl.uniform1i(l, v.int);
    else if ('float' in v) gl.uniform1f(l, v.float);
    else if ('vec2' in v) gl.uniform2f(l, v.vec2[0], v.vec2[1]);
    else if ('vec3' in v) gl.uniform3f(l, v.vec3[0], v.vec3[1], v.vec3[2]);
    else if ('vec4' in v) gl.uniform4f(l, v.vec4[0], v.vec4[1], v.vec4[2], v.vec4[3]);
    else if ('ivec4' in v) gl.uniform4i(l, v.ivec4[0], v.ivec4[1], v.ivec4[2], v.ivec4[3]);
    else gl.uniformMatrix4fv(l, false, v.mat4);
  }
}

export function createBuffer(gl: GL, target: number, data: ArrayBufferView, usage: number = gl.STATIC_DRAW): WebGLBuffer {
  const b = gl.createBuffer();
  if (!b) throw new Error('Cannot create a buffer');
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage);
  return b;
}

/** Description of one attribute in an interleaved buffer. */
export interface AttribSpec {
  loc: number;
  size: number;
  type: number;
  normalized?: boolean;
  /** Integer attribute (ivec/uvec in the shader). */
  integer?: boolean;
  offset: number;
  /** 1 = one value per instance. */
  divisor?: number;
}

export function bindAttribs(gl: GL, buffer: WebGLBuffer, stride: number, specs: AttribSpec[]): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const s of specs) {
    gl.enableVertexAttribArray(s.loc);
    if (s.integer) gl.vertexAttribIPointer(s.loc, s.size, s.type, stride, s.offset);
    else gl.vertexAttribPointer(s.loc, s.size, s.type, s.normalized ?? false, stride, s.offset);
    if (s.divisor) gl.vertexAttribDivisor(s.loc, s.divisor);
  }
}

export interface TextureOptions {
  internalFormat: number;
  format: number;
  type: number;
  width: number;
  height: number;
  data?: ArrayBufferView | null;
  minFilter?: number;
  magFilter?: number;
  wrap?: number;
  mipmaps?: boolean;
}

export function createTexture(gl: GL, o: TextureOptions): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error('Cannot create a texture');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, o.internalFormat, o.width, o.height, 0, o.format, o.type, o.data ?? null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.minFilter ?? gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.magFilter ?? gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrap ?? gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrap ?? gl.CLAMP_TO_EDGE);
  if (o.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

/** A mesh ready to be drawn with a single call. */
export interface Mesh {
  vao: WebGLVertexArrayObject;
  /** Index count, or vertex count when the mesh has no indices. */
  count: number;
  indexType: number | null;
  triangles: number;
  /** Instance count, 0 = no instancing. */
  instances: number;
  /** Primitive kind, default is triangles (`gl.TRIANGLES`). Lines: `gl.LINES`. */
  mode?: number;
  /** Buffers owned by this mesh, deleted with it (a shared instance buffer is not among them). */
  buffers?: WebGLBuffer[];
  /** Bytes of the buffers this mesh owns (0 for a mesh that shares another mesh's buffers). */
  bytes: number;
  /** The vertex and index buffers it draws from and their layout, so another mesh can share them. */
  source?: MeshSource;
}

/** The buffers behind a mesh, for `Device.shareMesh`. */
export interface MeshSource {
  vertices: WebGLBuffer;
  indices: WebGLBuffer | null;
  layout: VertexLayout;
  indexType: number | null;
  count: number;
  mode?: number;
}

export function drawMesh(gl: GL, m: Mesh): void {
  const mode = m.mode ?? gl.TRIANGLES;
  gl.bindVertexArray(m.vao);
  if (m.instances > 0) {
    if (m.indexType !== null) gl.drawElementsInstanced(mode, m.count, m.indexType, 0, m.instances);
    else gl.drawArraysInstanced(mode, 0, m.count, m.instances);
  } else if (m.indexType !== null) gl.drawElements(mode, m.count, m.indexType, 0);
  else gl.drawArrays(mode, 0, m.count);
}
