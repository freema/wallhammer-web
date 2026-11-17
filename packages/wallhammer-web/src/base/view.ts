// What a renderer needs to know about a view, independent of the camera rig that produced it.
// Rigs (module camera) implement `View`, the renderer (module render) and the environment (module env) read it.
// Besides the types, two small pure tests on axis-aligned boxes that every culling layer shares, the projection of a
// view in each depth mode (`depthViewProj`) and the render origin that follows a focus point (`snapRenderOrigin`).

import type { OrthoFrame, Vec3 } from './math.ts';

/** A ray in world space. */
export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/**
 * Box-shaped visible volume: a rectangle in the plane spanned by `axes.right` and `axes.up`, unbounded along `axes.forward`.
 * `cx`, `cy` are the rectangle centre measured along `right` and `up` from the world origin. This is what an orthographic
 * view or a directional light sees.
 */
export interface CullBox {
  kind: 'box';
  axes: OrthoFrame;
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
}

/**
 * Convex volume bounded by planes, what a perspective view sees. A point p is inside when
 * `n·p + d >= 0` for every plane `[nx, ny, nz, d]` (normals point inward, unit length).
 */
export interface CullFrustum {
  kind: 'frustum';
  planes: readonly (readonly [number, number, number, number])[];
}

/** Volume used to select what is worth drawing. */
export type CullVolume = CullBox | CullFrustum;

export interface View {
  /** Drawing surface in physical pixels. */
  readonly width: number;
  readonly height: number;
  /** Physical pixels per CSS pixel. */
  readonly dpr: number;
  /** Rotation of the view around the vertical axis in radians; 0 looks toward −z. */
  readonly heading: number;
  /** World size of one screen pixel at the point the view is centred on, in metres. */
  readonly metresPerPixel: number;
  /**
   * How the pixel size grows with depth: at a point p the pixel measures
   * `metresPerPixel + pixelGrowth * (forward·p − refDepth)` metres. Both are 0 for an orthographic view.
   */
  readonly pixelGrowth: number;
  readonly refDepth: number;
  /**
   * Unit axes of the view: screen right, screen up and the viewing direction. With `out` a rig may write into it (its
   * three arrays) and return it instead of allocating; always use the returned frame, a rig may ignore `out`.
   */
  axes(out?: OrthoFrame): OrthoFrame;
  /**
   * World → clip matrix with standard depth (clip z from −w at the near plane to +w at the far plane). The depth range
   * covers a sphere of `depthHalfRange` around `sceneCenter`. In the reversed and logarithmic depth modes the renderer
   * does not use this matrix for a perspective view: it builds its own from `axes`, `pixelGrowth`, `width`, `height`
   * and the eye (the origin of `cornerRays`), see `depthViewProj`. A rig therefore needs no code per depth mode.
   * With `out` (16 floats) a rig may write the matrix into it and return it; always use the returned array.
   */
  viewProj(sceneCenter: Vec3, depthHalfRange: number, out?: Float32Array): Float32Array;
  /**
   * Rays through the four image corners (left-bottom, left-top, right-bottom, right-top). Used to fit the shadow map.
   * For an orthographic view they are lines (the view sees both ways); with `pixelGrowth > 0` they start at the eye.
   * With `out` (four rays, each with its own `origin` and `dir` arrays, see `newCornerRays`) a rig may write into it
   * and return it instead of allocating; always use the returned rays.
   */
  cornerRays(out?: Ray[]): Ray[];
  /** What the view can see, for culling. */
  cullVolume(): CullVolume;
  /** Changes whenever the image of a static scene would change (position, orientation, zoom, size). */
  key(): string;
}

/** A frame of three zero vectors to hand to `View.axes(out)` again and again. */
export function newOrthoFrame(): OrthoFrame {
  return { right: [0, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] };
}

/** Four rays with arrays of their own, to hand to `View.cornerRays(out)` again and again. */
export function newCornerRays(): Ray[] {
  const rays: Ray[] = [];
  for (let i = 0; i < 4; i++) rays.push({ origin: [0, 0, 0], dir: [0, 0, -1] });
  return rays;
}

/** An axis-aligned box. */
export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/** Does an axis-aligned box reach into the volume? */
export function boxInVolume(b: Box3, v: CullVolume): boolean {
  if (v.kind === 'frustum') {
    for (const [nx, ny, nz, d] of v.planes) {
      // The box corner farthest along the plane normal.
      const px = nx >= 0 ? b.max[0] : b.min[0];
      const py = ny >= 0 ? b.max[1] : b.min[1];
      const pz = nz >= 0 ? b.max[2] : b.min[2];
      if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
  }
  const { right, up } = v.axes;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const hx = (b.max[0] - b.min[0]) / 2;
  const hy = (b.max[1] - b.min[1]) / 2;
  const hz = (b.max[2] - b.min[2]) / 2;
  const rx = right[0] * cx + right[1] * cy + right[2] * cz - v.cx;
  const rr = Math.abs(right[0]) * hx + Math.abs(right[1]) * hy + Math.abs(right[2]) * hz;
  if (Math.abs(rx) > v.halfW + rr) return false;
  const uy = up[0] * cx + up[1] * cy + up[2] * cz - v.cy;
  const ur = Math.abs(up[0]) * hx + Math.abs(up[1]) * hy + Math.abs(up[2]) * hz;
  return Math.abs(uy) <= v.halfH + ur;
}

/** Distance from a point to an axis-aligned box (0 inside). */
export function distanceToBox(p: Vec3, b: Box3): number {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const d = p[i]! < b.min[i]! ? b.min[i]! - p[i]! : p[i]! > b.max[i]! ? p[i]! - b.max[i]! : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * How the main passes (`color`, `data`, `overlay`) store depth. The shadow pass always uses standard depth.
 * - `'standard'`: the usual depth buffer of the drawing surface. A perspective view is limited to a far : near ratio of
 *   a few thousand.
 * - `'reversed'`: clip z runs from 1 at the near plane to 0 at infinity, in a 32-bit float depth buffer. Precision is
 *   then about the same relative to the distance at every distance, so one view holds a metre and a thousand
 *   kilometres. Needs the `EXT_clip_control` extension.
 * - `'logarithmic'`: the fragment shader writes the logarithm of the distance as depth. Works everywhere, costs the
 *   early depth test. The fallback when `'reversed'` is asked for and the extension is missing.
 */
export type DepthMode = 'standard' | 'reversed' | 'logarithmic';

/** The projection of the main passes for one frame. */
export interface DepthProjection {
  /** World → clip matrix, column-major. */
  viewProj: Float32Array;
  /**
   * Logarithmic mode with a perspective view: `1 / log2(1 + far)`, so that `log2(1 + distance) * logScale` is the
   * depth 0–1 the fragment shader writes. 0 in every other case (the depth of the matrix is used as it is).
   */
  logScale: number;
}

/**
 * World → clip matrix of a view for a depth mode. `'standard'` returns the view's own matrix untouched.
 *
 * A perspective view (`pixelGrowth > 0`) in the other modes gets a matrix built here from the view's axes, pixel
 * growth, size and eye, with the near plane at `nearM` and no far plane. Reversed: clip z = `nearM`, so depth is
 * `nearM / distance`. Logarithmic: clip z only clips at the near plane; the scale of the logarithm comes from the far
 * end of the sphere of `depthHalfRange` around `sceneCenter`, and what lies beyond it is drawn at depth 1.
 *
 * An orthographic view has linear depth, which needs no help: reversed mode flips its depth to 1 near, 0 far, and
 * logarithmic mode leaves it as it is.
 */
export function depthViewProj(view: View, mode: DepthMode, sceneCenter: Vec3, depthHalfRange: number, nearM: number, out?: DepthProjection): DepthProjection {
  // With `out` its `viewProj` (16 floats) is written in place and `out` is returned: nothing is allocated by this
  // function (the view may still allocate when its methods ignore their `out`).
  const res: DepthProjection = out ?? { viewProj: new Float32Array(16), logScale: 0 };
  res.logScale = 0;
  if (mode === 'standard') {
    const vp = view.viewProj(sceneCenter, depthHalfRange, res.viewProj);
    if (vp !== res.viewProj) res.viewProj.set(vp);
    return res;
  }
  if (!(view.pixelGrowth > 0)) {
    const m = res.viewProj;
    const vp = view.viewProj(sceneCenter, depthHalfRange, m);
    if (vp !== m) m.set(vp);
    // z' = (w − z) / 2 on every column: −w…+w becomes 1…0 (w is 1 for a matrix without perspective).
    if (mode === 'reversed') for (let c = 0; c < 16; c += 4) m[c + 2] = (m[c + 3]! - m[c + 2]!) / 2;
    return res;
  }
  const { right: r, up: u, forward: w } = view.axes(scratchFrame);
  const eye = view.cornerRays(scratchRays)[0]!.origin;
  // pixelGrowth = 2 tan(fovY / 2) / height.
  const fy = 2 / (view.pixelGrowth * view.height);
  const fx = (fy * view.height) / view.width;
  const re = r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2];
  const ue = u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2];
  const we = w[0] * eye[0] + w[1] * eye[1] + w[2] * eye[2];
  const m = res.viewProj;
  m.fill(0);
  for (let i = 0; i < 3; i++) {
    m[i * 4 + 0] = fx * r[i]!;
    m[i * 4 + 1] = fy * u[i]!;
    m[i * 4 + 3] = w[i]!;
  }
  m[12] = -fx * re;
  m[13] = -fy * ue;
  m[15] = -we;
  if (mode === 'reversed') {
    // Clip z is the constant `nearM`: after the division by w (the distance along the view) depth is nearM / distance.
    m[14] = nearM;
    return res;
  }
  // Clip z only clips here, the fragment shader writes the depth: z = distance − 2 nearM puts the near plane at nearM
  // and leaves no far plane (a far plane a million times the near one would not survive 32-bit floats in the matrix).
  for (let i = 0; i < 3; i++) m[i * 4 + 2] = w[i]!;
  m[14] = -we - 2 * nearM;
  // The far end of the scene sets only the scale of the logarithm; whatever lies beyond it is drawn at depth 1.
  const dc = w[0] * sceneCenter[0] + w[1] * sceneCenter[1] + w[2] * sceneCenter[2] - we;
  const far = Math.max(dc + depthHalfRange, nearM * 2, 1);
  res.logScale = 1 / Math.log2(1 + far);
  return res;
}

/** Scratch for `depthViewProj` (single-threaded: read right after the call). */
const scratchFrame = newOrthoFrame();
const scratchRays = newCornerRays();

/** Which axes a render origin follows: the two horizontal ones (its height stays 0), or all three. */
export type OriginAxes = 'horizontal' | 'all';

/**
 * Render origin for a focus point (typically the eye or what it looks at): the grid point at or below the focus on
 * every followed axis. Positions are kept in 64-bit numbers on the CPU and only their difference to this origin is
 * handed to the GPU as 32-bit floats (`toRenderSpace`), so the numbers there stay below `gridM` near the focus
 * wherever it is in the world. Because the origin depends only on the focus, the same place gives the same image
 * however the focus got there; a coarse grid keeps patterns that repeat with the grid fixed to the world.
 */
export function snapRenderOrigin(focus: readonly [number, number, number], gridM: number, axes: OriginAxes = 'horizontal'): Vec3 {
  return [Math.floor(focus[0] / gridM) * gridM, axes === 'all' ? Math.floor(focus[1] / gridM) * gridM : 0, Math.floor(focus[2] / gridM) * gridM];
}

/** A world position relative to a render origin. Subtract here, in 64 bits, never on the GPU. */
export function toRenderSpace(p: readonly [number, number, number], origin: readonly [number, number, number]): Vec3 {
  return [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
}
