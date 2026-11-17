// Many meshes drawn with one material, each with its own box, culled per box. For a scene built in separately
// generated pieces (tiles, chunks): only the pieces that reach into the view are drawn in the colour passes, and only
// those that reach into the light's volume in the shadow pass. Works with any view (frustum or box volume).
//
// The culled sets live in arrays that grow only when pieces are added, so culling (which runs on every refit, in
// every frame while the view moves) allocates nothing. Optionally the view set is sorted front to back, and each
// piece gets its own short list of point lights (`PointLightSet.bindFor`).

import type { Box3, CullVolume, View } from '../base/view.ts';
import { boxInVolume, newOrthoFrame } from '../base/view.ts';
import type { Mesh } from '../gpu/index.ts';
import type { PointLightSet } from './point-lights.ts';
import { MeshLayer } from './renderer.ts';
import type { DrawContext, MeshLayerOptions } from './renderer.ts';

/** One mesh and the axis-aligned box that holds all of it (in the coordinates the renderer draws in). */
export interface MeshPiece extends Box3 {
  mesh: Mesh;
}

export interface PieceLayerOptions extends Omit<MeshLayerOptions, 'mesh'> {
  /**
   * Order of the pieces in the colour and data passes. `'added'` (default): the order they were added in.
   * `'front-to-back'`: nearest box centre along the view direction first, sorted when the view set is culled, so
   * opaque pieces hide what is behind them before it is shaded.
   */
  order?: 'added' | 'front-to-back';
  /**
   * Point lights: in the colour pass each piece's draw names the selected lights whose sphere reaches its box
   * (`POINT_LIGHTS_PER_DRAW` at most). The material includes `<point-lights>`. Default none.
   */
  lights?: PointLightSet | null;
}

/**
 * A `MeshLayer` with a list of pieces instead of one mesh. Material, uniforms, textures, passes and draw state are
 * shared and set once per pass; each piece is one draw call. Adding or removing a piece marks the culled sets stale,
 * so the renderer refits and culls again on the next frame.
 */
export class PieceLayer extends MeshLayer {
  /** Order of the pieces in the colour and data passes (`PieceLayerOptions.order`). */
  order: 'added' | 'front-to-back';
  /** Point lights per piece in the colour pass (`PieceLayerOptions.lights`). */
  lights: PointLightSet | null;
  private list: MeshPiece[] = [];
  private shadowSet: MeshPiece[] = [];
  private viewSet: MeshPiece[] = [];
  private shadowCount = 0;
  private viewCount = 0;
  /** Sort keys of the view set (depth of the box centre along the view). */
  private keys = new Float64Array(0);
  /** Scratch for the view's axes while sorting. */
  private readonly axes = newOrthoFrame();
  private stale = false;
  /** Pieces drawn in the last colour (or data) pass. */
  drawn = 0;

  constructor(o: PieceLayerOptions) {
    super(o);
    this.order = o.order ?? 'added';
    this.lights = o.lights ?? null;
  }

  get pieces(): readonly MeshPiece[] {
    return this.list;
  }

  /** Bytes of GPU buffers the pieces' meshes own. */
  get bytes(): number {
    let b = 0;
    for (const p of this.list) b += p.mesh.bytes;
    return b;
  }

  add(piece: MeshPiece): void {
    this.list.push(piece);
    // Grow the culled sets here, never while culling.
    if (this.viewSet.length < this.list.length) {
      const n = Math.max(16, this.list.length * 2);
      this.shadowSet.length = n;
      this.viewSet.length = n;
      const keys = new Float64Array(n);
      keys.set(this.keys.subarray(0, Math.min(this.keys.length, n)));
      this.keys = keys;
    }
    this.stale = true;
  }

  /** Takes a piece out (the caller deletes its mesh). Returns whether it was there. */
  remove(piece: MeshPiece): boolean {
    const i = this.list.indexOf(piece);
    if (i < 0) return false;
    this.list.splice(i, 1);
    // Until the next cull the sets must not draw the piece (its mesh may be gone).
    this.shadowCount = dropFrom(this.shadowSet, this.shadowCount, piece);
    this.viewCount = dropFrom(this.viewSet, this.viewCount, piece);
    this.stale = true;
    return true;
  }

  cullStale(): boolean {
    return this.stale;
  }

  cull(volume: CullVolume, purpose: 'shadow' | 'view', view?: View): number {
    const shadow = purpose === 'shadow';
    const set = shadow ? this.shadowSet : this.viewSet;
    const list = this.list;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      if (boxInVolume(p, volume)) set[n++] = p;
    }
    if (shadow) this.shadowCount = n;
    else {
      if (this.order === 'front-to-back' && view && n > 1) this.sortView(view, n);
      this.viewCount = n;
      this.stale = false;
    }
    return 0;
  }

  /** Insertion sort of the first `n` entries of the view set by depth along the view (stable, in place). */
  private sortView(view: View, n: number): void {
    const f = view.axes(this.axes).forward;
    const set = this.viewSet;
    const keys = this.keys;
    for (let i = 0; i < n; i++) {
      const p = set[i]!;
      const key = f[0] * (p.min[0] + p.max[0]) + f[1] * (p.min[1] + p.max[1]) + f[2] * (p.min[2] + p.max[2]);
      let k = i;
      while (k > 0 && keys[k - 1]! > key) {
        keys[k] = keys[k - 1]!;
        set[k] = set[k - 1]!;
        k--;
      }
      keys[k] = key;
      set[k] = p;
    }
  }

  override draw(ctx: DrawContext): void {
    const shadow = ctx.pass === 'shadow';
    const set = shadow ? this.shadowSet : this.viewSet;
    const count = shadow ? this.shadowCount : this.viewCount;
    const main = ctx.pass === 'color' || ctx.pass === 'data';
    if (main) this.drawn = 0;
    if (count === 0) return;
    const program = this.begin(ctx);
    if (!program) return;
    const lights = ctx.pass === 'color' ? this.lights : null;
    for (let i = 0; i < count; i++) {
      const p = set[i]!;
      if (lights) lights.bindFor(program, p);
      ctx.device.draw(p.mesh);
      ctx.count(p.mesh.triangles);
    }
    // Leave the program as a fresh one: whole selection for draws that set no list.
    if (lights) lights.bindAll(program);
    if (main) this.drawn = count;
  }
}

/** Removes `piece` from the first `count` entries of `set` in place; returns the new count. */
function dropFrom(set: MeshPiece[], count: number, piece: MeshPiece): number {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const p = set[i]!;
    if (p !== piece) set[n++] = p;
  }
  for (let i = n; i < count; i++) set[i] = undefined as unknown as MeshPiece;
  return n;
}
