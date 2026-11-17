// Camera rig without perspective: 4 rotations by 90°, a table of fixed zoom levels, panning over a reference plane.
// It receives the angles and the zoom table from outside and holds no numbers itself. Implements `View` for the renderer.

import { DEG, clamp, crossInto, dot, orthoMatrix } from '../base/math.ts';
import type { OrthoFrame, Vec3 } from '../base/math.ts';
import type { CullVolume, Ray, View } from '../base/view.ts';

export interface CameraSetup {
  /** Rotation around the vertical axis at rotation 0, in degrees. 0 = we look from the south to the north. */
  yawDeg: number;
  /** Elevation above the horizon for each zoom level, in degrees. */
  pitchDegByZoom: readonly number[];
  /** Scale for each level: CSS pixels per metre in the horizontal direction that the camera does not foreshorten. */
  pxPerMeterByZoom: readonly number[];
}

export interface ViewState {
  rotation: number;
  zoom: number;
  center: { x: number; z: number };
}

export class SteppedOrthoRig implements View {
  private _setup: CameraSetup;
  rotation = 0;
  zoom = 0;
  centerX = 0;
  centerZ = 0;
  /** Height of the plane along which the view centre moves. */
  refHeight = 0;
  /** Canvas size in physical pixels. */
  width = 1;
  height = 1;
  /** Physical pixels per one CSS pixel. */
  dpr = 1;
  /** Limits of the view centre in the world. */
  bounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
  /** Scratch of the methods that take `out`, so they allocate nothing themselves. */
  private readonly scratch: OrthoFrame = { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
  private readonly scratchC: Vec3 = [0, 0, 0];
  /** The numbers the last `key` was made from (NaN: none yet) and that key. */
  private readonly keyOf = new Float64Array(6).fill(NaN);
  private keyText = '';

  constructor(setup: CameraSetup) {
    this._setup = SteppedOrthoRig.checked(setup);
  }

  private static checked(setup: CameraSetup): CameraSetup {
    if (setup.pitchDegByZoom.length !== setup.pxPerMeterByZoom.length) {
      throw new Error('The pitch table and the scale table must have the same number of levels');
    }
    return setup;
  }

  get setup(): CameraSetup {
    return this._setup;
  }

  /** Replaces the angle and zoom tables at run time. The zoom level is clamped to the new table. */
  setSetup(setup: CameraSetup): void {
    this._setup = SteppedOrthoRig.checked(setup);
    this.zoom = Math.max(0, Math.min(this.zoomLevels - 1, this.zoom));
  }

  get zoomLevels(): number {
    return this.setup.pxPerMeterByZoom.length;
  }

  get yaw(): number {
    return (this.setup.yawDeg + 90 * this.rotation) * DEG;
  }

  get pitch(): number {
    return this.setup.pitchDegByZoom[this.zoom]! * DEG;
  }

  /** Physical pixels per metre. */
  get scale(): number {
    return this.setup.pxPerMeterByZoom[this.zoom]! * this.dpr;
  }

  /** View: rotation around the vertical axis in radians. */
  get heading(): number {
    return this.yaw;
  }

  /** View: metres per physical pixel; constant over the image since there is no perspective. */
  get metresPerPixel(): number {
    return 1 / this.scale;
  }

  /** View: no perspective, the pixel size does not change with depth. */
  readonly pixelGrowth = 0;
  readonly refDepth = 0;

  axes(out?: OrthoFrame): OrthoFrame {
    return this.frame(out);
  }

  /** View: rays through the image corners, starting in the camera plane through the unsnapped view centre. */
  cornerRays(out?: Ray[]): Ray[] {
    const cam = this.frame(out ? this.scratch : undefined);
    const hw = this.width / (2 * this.scale);
    const hh = this.height / (2 * this.scale);
    const c0 = this.centerX;
    const c1 = this.refHeight;
    const c2 = this.centerZ;
    const rays: Ray[] = out ?? [];
    let i = 0;
    for (let a = 0; a < 2; a++) {
      const sx = a === 0 ? -1 : 1;
      for (let b = 0; b < 2; b++) {
        const sy = b === 0 ? -1 : 1;
        // right[1] is always 0 for this rig, so it is left out of the height.
        const x = c0 + cam.right[0] * hw * sx + cam.up[0] * hh * sy;
        const y = c1 + cam.up[1] * hh * sy;
        const z = c2 + cam.right[2] * hw * sx + cam.up[2] * hh * sy;
        if (out) {
          const r = out[i]!;
          r.origin[0] = x;
          r.origin[1] = y;
          r.origin[2] = z;
          r.dir[0] = cam.forward[0];
          r.dir[1] = cam.forward[1];
          r.dir[2] = cam.forward[2];
        } else rays.push({ origin: [x, y, z], dir: cam.forward });
        i++;
      }
    }
    return rays;
  }

  /** View: the visible rectangle in the camera plane. */
  cullVolume(): CullVolume {
    const cam = this.frame();
    const s = this.scale;
    const c: Vec3 = [this.centerX, this.refHeight, this.centerZ];
    return { kind: 'box', axes: cam, cx: dot(cam.right, c), cy: dot(cam.up, c), halfW: this.width / (2 * s), halfH: this.height / (2 * s) };
  }

  /** View: changes whenever the image of a static scene would. */
  key(): string {
    // The string is made again only when a number in it changed, so a still view allocates nothing.
    const k = this.keyOf;
    if (k[0] === this.rotation && k[1] === this.zoom && k[2] === this.centerX && k[3] === this.centerZ && k[4] === this.width && k[5] === this.height) return this.keyText;
    k[0] = this.rotation;
    k[1] = this.zoom;
    k[2] = this.centerX;
    k[3] = this.centerZ;
    k[4] = this.width;
    k[5] = this.height;
    this.keyText = `${this.rotation}|${this.zoom}|${this.centerX.toFixed(3)}|${this.centerZ.toFixed(3)}|${this.width}x${this.height}`;
    return this.keyText;
  }

  /** The view's axes. With `out` its arrays are written and `out` is returned. */
  frame(out?: OrthoFrame): OrthoFrame {
    const yaw = this.yaw;
    const p = this.pitch;
    const f = out ?? { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
    f.right[0] = Math.cos(yaw);
    f.right[1] = 0;
    f.right[2] = -Math.sin(yaw);
    f.forward[0] = -Math.sin(yaw) * Math.cos(p);
    f.forward[1] = -Math.sin(p);
    f.forward[2] = -Math.cos(yaw) * Math.cos(p);
    crossInto(f.right, f.forward, f.up);
    return f;
  }

  /** Horizontal direction "away from the viewer", along which the centre moves when dragging up and down. */
  private forwardOnGround(): Vec3 {
    const yaw = this.yaw;
    return [-Math.sin(yaw), 0, -Math.cos(yaw)];
  }

  /**
   * World → clip space matrix. The centre is snapped to whole pixels, so the image moves
   * in whole pixels when panning and nothing shimmers. Depth is relative to the scene centre and does not depend on panning.
   */
  viewProj(sceneCenter: Vec3, depthHalfRange: number, out?: Float32Array): Float32Array {
    const f = this.frame(out ? this.scratch : undefined);
    const s = this.scale;
    const c = this.scratchC;
    c[0] = this.centerX;
    c[1] = this.refHeight;
    c[2] = this.centerZ;
    const cx = Math.round(dot(f.right, c) * s) / s;
    const cy = Math.round(dot(f.up, c) * s) / s;
    return orthoMatrix(f, cx, cy, dot(f.forward, sceneCenter), this.width / (2 * s), this.height / (2 * s), depthHalfRange, out);
  }

  /** View centre in the camera plane snapped to whole pixels, same as in `viewProj`. */
  private snappedCenter(f: OrthoFrame): { cx: number; cy: number } {
    const s = this.scale;
    const c: Vec3 = [this.centerX, this.refHeight, this.centerZ];
    return { cx: Math.round(dot(f.right, c) * s) / s, cy: Math.round(dot(f.up, c) * s) / s };
  }

  /**
   * Ray under a screen point. `px`, `py` are physical canvas pixels from the top-left corner
   * (pixel centre is +0.5). The origin lies in the camera plane through the view centre, the direction is
   * the view direction: the camera has no perspective, all rays are parallel.
   */
  screenRay(px: number, py: number): { origin: Vec3; dir: Vec3 } {
    const f = this.frame();
    const s = this.scale;
    const { cx, cy } = this.snappedCenter(f);
    const a = cx + (px - this.width / 2) / s;
    const b = cy - (py - this.height / 2) / s;
    const d = dot(f.forward, [this.centerX, this.refHeight, this.centerZ]);
    return {
      origin: [f.right[0] * a + f.up[0] * b + f.forward[0] * d, f.right[1] * a + f.up[1] * b + f.forward[1] * d, f.right[2] * a + f.up[2] * b + f.forward[2] * d],
      dir: f.forward,
    };
  }

  /** Where a world point lands on the canvas: physical pixels from the top-left corner. Inverse of `screenRay`. */
  project(p: Vec3): [number, number] {
    const f = this.frame();
    const s = this.scale;
    const { cx, cy } = this.snappedCenter(f);
    return [(dot(f.right, p) - cx) * s + this.width / 2, this.height / 2 - (dot(f.up, p) - cy) * s];
  }

  /** Pan by screen pixels: the content follows the cursor. */
  panPixels(dx: number, dy: number): void {
    const f = this.frame();
    const g = this.forwardOnGround();
    const s = this.scale;
    const along = dy / (s * Math.sin(this.pitch));
    this.centerX += (-f.right[0] * dx) / s + g[0] * along;
    this.centerZ += (-f.right[2] * dx) / s + g[2] * along;
    this.clampCenter();
  }

  setZoom(z: number): void {
    this.zoom = clamp(Math.round(z), 0, this.zoomLevels - 1);
  }

  setRotation(r: number): void {
    this.rotation = ((Math.round(r) % 4) + 4) % 4;
  }

  clampCenter(): void {
    this.centerX = clamp(this.centerX, this.bounds.minX, this.bounds.maxX);
    this.centerZ = clamp(this.centerZ, this.bounds.minZ, this.bounds.maxZ);
  }

  state(): ViewState {
    return { rotation: this.rotation, zoom: this.zoom, center: { x: this.centerX, z: this.centerZ } };
  }

  /** Largest zoom level at which the world rectangle sizeX × sizeZ still fits entirely on the canvas. */
  fitZoom(sizeX: number, sizeZ: number, heightSpan: number): number {
    const keepRotation = this.zoom;
    let best = 0;
    for (let z = 0; z < this.zoomLevels; z++) {
      this.zoom = z;
      const f = this.frame();
      const s = this.scale;
      const w = (Math.abs(f.right[0]) * sizeX + Math.abs(f.right[2]) * sizeZ) * s;
      const h = (Math.abs(f.up[0]) * sizeX + Math.abs(f.up[2]) * sizeZ + f.up[1] * heightSpan) * s;
      if (w <= this.width && h <= this.height) best = z;
    }
    this.zoom = keepRotation;
    return best;
  }
}
