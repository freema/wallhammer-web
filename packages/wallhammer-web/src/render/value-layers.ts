// Value layers: numbers shown over a scene through a colour ramp, in three shapes. `RasterValueLayer` lays a grid of
// values on a sheet over the ground, `PointValueLayer` draws discs, `ShapeValueLayer` tints prisms by a table row.
// All three take their values as 16-bit words (`quantizeValues`), one array per time step, and blend two steps.
// What the numbers mean, where they come from and how a legend looks is the caller's business.

import type { InstanceData, MeshData, TextureData, VertexLayout } from '../base/data.ts';
import type { DrawState } from '../base/material.ts';
import type { RGB, Vec3 } from '../base/math.ts';
import { valueTableSize, wordTexture } from '../gen-tex/index.ts';
import type { Device, InstanceBuffer, Texture } from '../gpu/index.ts';
import { PieceLayer } from './pieces.ts';
import { MeshLayer } from './renderer.ts';
import type { DrawContext, Material, Renderer } from './renderer.ts';
import { POINT_VALUE_MATERIAL, RASTER_VALUE_MATERIAL, SHAPE_VALUE_MATERIAL } from './value-glsl.ts';

/** Programs are compiled once per renderer and shared by every value layer on it. */
const MATERIALS = new WeakMap<Renderer, { raster?: Material; points?: Material; shapes?: Material }>();

function materialOf(renderer: Renderer, kind: 'raster' | 'points' | 'shapes'): Material {
  let set = MATERIALS.get(renderer);
  if (!set) {
    set = {};
    MATERIALS.set(renderer, set);
  }
  let m = set[kind];
  if (!m) {
    m = renderer.material(kind === 'raster' ? RASTER_VALUE_MATERIAL : kind === 'points' ? POINT_VALUE_MATERIAL : SHAPE_VALUE_MATERIAL);
    set[kind] = m;
  }
  return m;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * The two time steps a value layer shows, as textures of `width` × `height` words. A step is recognised by its array:
 * showing an array that is already loaded costs nothing, so walking through steps in order uploads one texture per
 * step. Pass a new array when the values of a step change.
 */
export class ValueSteps {
  readonly width: number;
  readonly height: number;
  /** Blend between the two shown steps, 0–1. */
  mix = 0;
  private readonly device: Device;
  private held: { words: Uint16Array | null; texture: Texture | null }[] = [
    { words: null, texture: null },
    { words: null, texture: null },
  ];
  private second = 0;

  constructor(device: Device, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;
  }

  /** False until the first `show`. */
  get ready(): boolean {
    return this.held[0]!.texture !== null;
  }

  /** Texture of the first shown step (null before the first `show`). */
  get a(): Texture | null {
    return this.held[0]!.texture;
  }

  /** Texture of the second shown step; the first one again when only one step is shown. */
  get b(): Texture | null {
    return this.held[this.second]!.texture;
  }

  /** Shows step `a`, or a blend from `a` to `b` by `mix` (0–1). Each array holds `width` × `height` words, row by row. */
  show(a: Uint16Array, b: Uint16Array = a, mix = 0): void {
    if (this.held[0]!.words !== a) {
      if (this.held[1]!.words === a) this.held.reverse();
      else this.load(0, a);
    }
    if (b === a) this.second = 0;
    else {
      if (this.held[1]!.words !== b) this.load(1, b);
      this.second = 1;
    }
    this.mix = b === a ? 0 : clamp01(mix);
  }

  private load(slot: number, words: Uint16Array): void {
    const h = this.held[slot]!;
    if (h.texture) this.device.deleteTexture(h.texture);
    h.texture = this.device.createTexture(wordTexture(words, this.width, this.height));
    h.words = words;
  }

  dispose(): void {
    for (const h of this.held) {
      if (h.texture) this.device.deleteTexture(h.texture);
      h.texture = null;
      h.words = null;
    }
    this.second = 0;
  }
}

/** What all value layers let the caller change while they are shown. */
export interface ValueStyle {
  /** 0–1. */
  opacity?: number;
  /** The part of the value range the ramp spans, both ends 0–1 of the range the words were quantised to. Default [0, 1]. */
  range?: readonly [number, number];
}

/** A regular grid in the plane of the ground: cell (0, 0) starts at (`x0`, `z0`), rows run toward +z. */
export interface ValueGrid {
  x0: number;
  z0: number;
  /** Cell size in metres. */
  cellX: number;
  cellZ: number;
  cols: number;
  rows: number;
}

export interface RasterValueOptions extends ValueStyle {
  grid: ValueGrid;
  /** Colour ramp (`colorRamp`). */
  ramp: TextureData;
  /** Blend values between cell centres instead of showing flat cells. Default true. Not used with `lookup`. */
  smooth?: boolean;
  /**
   * Cells that name table rows instead of holding values: `cells` has one word per grid cell (row + 1, 0 = nothing
   * here), and a time step is then a table of `rows` words (laid out by `valueTableSize`). Borders between rows are
   * darkened by `outline` (0–1, default 0.35).
   */
  lookup?: { cells: Uint16Array; rows: number; outline?: number };
}

/** A sheet tile as `drapeTiles` returns it. */
export interface ValueSheetTile {
  mesh: MeshData;
  min: Vec3;
  max: Vec3;
}

/**
 * A grid of values on a sheet over the ground. The sheet (tiles from `drapeTiles`) only carries the surface; which
 * cell a fragment shows follows from its position, so the grid and the sheet need not match in size or density.
 * Outside the grid and in cells without a value nothing is drawn. Draws in the `color` and `data` passes, blended,
 * without writing depth; register it after the layers it should lie on.
 */
export class RasterValueLayer extends PieceLayer {
  readonly steps: ValueSteps;
  readonly grid: ValueGrid;
  private readonly renderer: Renderer;
  private rampTexture: Texture;
  private readonly cellTexture: Texture;
  private readonly lookup: boolean;
  private readonly outline: number;
  private opacity: number;
  private range: readonly [number, number];
  private smooth: boolean;

  constructor(renderer: Renderer, o: RasterValueOptions) {
    super({ material: materialOf(renderer, 'raster'), passes: ['color', 'data'] });
    this.renderer = renderer;
    this.grid = o.grid;
    this.lookup = o.lookup !== undefined;
    this.outline = o.lookup?.outline ?? 0.35;
    this.opacity = o.opacity ?? 0.75;
    this.range = o.range ?? [0, 1];
    this.smooth = o.smooth ?? true;
    const table = o.lookup ? valueTableSize(o.lookup.rows) : { width: o.grid.cols, height: o.grid.rows };
    this.steps = new ValueSteps(renderer.device, table.width, table.height);
    this.rampTexture = renderer.createTexture(o.ramp);
    this.cellTexture = o.lookup ? renderer.createTexture(wordTexture(o.lookup.cells, o.grid.cols, o.grid.rows)) : renderer.device.pixelTexture([0, 0, 0, 0]);
    this.sync();
  }

  /** Uploads sheet tiles and adds them as pieces. */
  addTiles(tiles: readonly ValueSheetTile[]): void {
    for (const t of tiles) this.add({ mesh: this.renderer.createMesh(t.mesh, this.material), min: t.min, max: t.max });
  }

  /** Shows one time step, or a blend of two (see `ValueSteps.show`). */
  show(a: Uint16Array, b?: Uint16Array, mix?: number): void {
    this.steps.show(a, b, mix);
    this.sync();
  }

  setStyle(s: ValueStyle & { smooth?: boolean }): void {
    if (s.opacity !== undefined) this.opacity = s.opacity;
    if (s.range !== undefined) this.range = s.range;
    if (s.smooth !== undefined) this.smooth = s.smooth;
    this.sync();
  }

  /** Replaces the colour ramp. */
  setRamp(ramp: TextureData): void {
    this.renderer.device.deleteTexture(this.rampTexture);
    this.rampTexture = this.renderer.createTexture(ramp);
    this.sync();
  }

  private sync(): void {
    const g = this.grid;
    this.textures = { u_valuesA: this.steps.a, u_valuesB: this.steps.b, u_ramp: this.rampTexture, u_cells: this.cellTexture };
    this.uniforms = {
      u_grid: { vec4: [g.x0, g.z0, 1 / g.cellX, 1 / g.cellZ] },
      u_size: { vec4: [g.cols, g.rows, this.steps.width, 0] },
      u_style: { vec4: [this.steps.mix, clamp01(this.opacity), this.smooth ? 1 : 0, this.lookup ? 1 : 0] },
      u_range: { vec4: [this.range[0], this.range[1], this.outline, 0] },
    };
  }

  override draw(ctx: DrawContext): void {
    if (!this.steps.ready) return;
    super.draw(ctx);
  }

  /** Frees the sheet, the ramp and the step textures. The caller takes the layer out of the renderer. */
  dispose(): void {
    for (const p of [...this.pieces]) {
      this.remove(p);
      this.renderer.device.deleteMesh(p.mesh);
    }
    this.steps.dispose();
    this.renderer.device.deleteTexture(this.rampTexture);
    this.renderer.device.deleteTexture(this.cellTexture);
  }
}

const QUAD_LAYOUT: VertexLayout = { stride: 8, attribs: [{ name: 'a_corner', size: 2, type: 'f32', offset: 0 }] };
const QUAD: MeshData = {
  layout: QUAD_LAYOUT,
  vertices: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  count: 6,
};

/** One point per instance: centre x, y, z and radius in metres (`a_point`). */
export const POINT_VALUE_LAYOUT: VertexLayout = { stride: 16, attribs: [{ name: 'a_point', size: 4, type: 'f32', offset: 0 }] };

export interface PointValueOptions extends ValueStyle {
  /** x, y, z and radius in metres for every point; point i takes row i of the value table. */
  points: Float32Array;
  /** Colour ramp (`colorRamp`). */
  ramp: TextureData;
  /** How much the value sets the size, 0 (all points keep their radius) to 1 (area follows the value). Default 0. */
  sizeByValue?: number;
  /** No disc gets smaller than this many pixels in radius. Default 2. */
  minRadiusPx?: number;
  /** Multiplies every radius. Default 1. */
  radiusScale?: number;
  /** Hide discs behind nearer surfaces. Default false: the discs lie over the whole image. */
  depthTest?: boolean;
}

/**
 * Discs that face the view, coloured (and optionally sized) by a value per point; one instanced draw call. A time
 * step is a table of one word per point (laid out by `valueTableSize`); points without a value are not drawn.
 */
export class PointValueLayer extends MeshLayer {
  readonly steps: ValueSteps;
  readonly count: number;
  private readonly renderer: Renderer;
  private readonly instances: InstanceBuffer | null;
  private rampTexture: Texture;
  private opacity: number;
  private range: readonly [number, number];
  private sizeByValue: number;
  private minRadiusPx: number;
  private radiusScale: number;

  constructor(renderer: Renderer, o: PointValueOptions) {
    // A layer's state for a pass replaces the material's, so the tested variant repeats the rest of it.
    const tested: DrawState = { ...POINT_VALUE_MATERIAL.state?.color, depthTest: true, depthFunc: 'lequal' };
    super({ material: materialOf(renderer, 'points'), passes: ['color', 'data'], state: o.depthTest ? { color: tested, data: tested } : {} });
    this.renderer = renderer;
    this.count = Math.floor(o.points.length / 4);
    this.opacity = o.opacity ?? 0.9;
    this.range = o.range ?? [0, 1];
    this.sizeByValue = o.sizeByValue ?? 0;
    this.minRadiusPx = o.minRadiusPx ?? 2;
    this.radiusScale = o.radiusScale ?? 1;
    const table = valueTableSize(this.count);
    this.steps = new ValueSteps(renderer.device, table.width, table.height);
    this.rampTexture = renderer.createTexture(o.ramp);
    if (this.count > 0) {
      const data: InstanceData = { layout: POINT_VALUE_LAYOUT, data: o.points.subarray(0, this.count * 4) };
      this.instances = renderer.createInstances(data);
      this.mesh = renderer.createMesh(QUAD, this.material, this.instances);
    } else this.instances = null;
    this.sync();
  }

  /** Shows one time step, or a blend of two (see `ValueSteps.show`). */
  show(a: Uint16Array, b?: Uint16Array, mix?: number): void {
    this.steps.show(a, b, mix);
    this.sync();
  }

  setStyle(s: ValueStyle & { sizeByValue?: number; minRadiusPx?: number; radiusScale?: number }): void {
    if (s.opacity !== undefined) this.opacity = s.opacity;
    if (s.range !== undefined) this.range = s.range;
    if (s.sizeByValue !== undefined) this.sizeByValue = s.sizeByValue;
    if (s.minRadiusPx !== undefined) this.minRadiusPx = s.minRadiusPx;
    if (s.radiusScale !== undefined) this.radiusScale = s.radiusScale;
    this.sync();
  }

  private sync(): void {
    this.textures = { u_valuesA: this.steps.a, u_valuesB: this.steps.b, u_ramp: this.rampTexture };
    this.uniforms = {
      u_style: { vec4: [this.steps.mix, clamp01(this.opacity), this.steps.width, clamp01(this.sizeByValue)] },
      u_range: { vec4: [this.range[0], this.range[1], this.minRadiusPx, this.radiusScale] },
    };
  }

  override draw(ctx: DrawContext): void {
    const mesh = this.mesh;
    if (!mesh || mesh.instances === 0 || !this.steps.ready) return;
    if (!this.begin(ctx)) return;
    ctx.device.draw(mesh);
    ctx.count(mesh.triangles * mesh.instances);
  }

  /** Frees the points, the ramp and the step textures. The caller takes the layer out of the renderer. */
  dispose(): void {
    if (this.mesh) this.renderer.device.deleteMesh(this.mesh);
    this.mesh = null;
    if (this.instances) this.renderer.device.deleteInstances(this.instances);
    this.steps.dispose();
    this.renderer.device.deleteTexture(this.rampTexture);
  }
}

export interface ShapeValueOptions extends ValueStyle {
  /** Number of table rows the prisms refer to (largest `ref` + 1). */
  rows: number;
  /** Colour ramp (`colorRamp`). */
  ramp: TextureData;
  /** Colour of prisms whose row has no value. Default: they are not drawn. */
  neutral?: RGB | null;
}

/**
 * Prisms tinted by a value per table row (`prismMesh`: every prism carries its row). A time step is a table of one
 * word per row (laid out by `valueTableSize`). Blended over what is already drawn, with depth, so register it after
 * the layers it wraps. Meshes are added as pieces and culled per box.
 */
export class ShapeValueLayer extends PieceLayer {
  readonly steps: ValueSteps;
  private readonly renderer: Renderer;
  private rampTexture: Texture;
  private opacity: number;
  private range: readonly [number, number];
  private neutral: RGB | null;

  constructor(renderer: Renderer, o: ShapeValueOptions) {
    super({ material: materialOf(renderer, 'shapes'), passes: ['color', 'data'] });
    this.renderer = renderer;
    this.opacity = o.opacity ?? 0.9;
    this.range = o.range ?? [0, 1];
    this.neutral = o.neutral ?? null;
    const table = valueTableSize(o.rows);
    this.steps = new ValueSteps(renderer.device, table.width, table.height);
    this.rampTexture = renderer.createTexture(o.ramp);
    this.sync();
  }

  /** Uploads a prism mesh and adds it as one piece with its box. */
  addShapes(shapes: ValueSheetTile): void {
    if (shapes.mesh.count === 0) return;
    this.add({ mesh: this.renderer.createMesh(shapes.mesh, this.material), min: shapes.min, max: shapes.max });
  }

  /** Shows one time step, or a blend of two (see `ValueSteps.show`). */
  show(a: Uint16Array, b?: Uint16Array, mix?: number): void {
    this.steps.show(a, b, mix);
    this.sync();
  }

  setStyle(s: ValueStyle & { neutral?: RGB | null }): void {
    if (s.opacity !== undefined) this.opacity = s.opacity;
    if (s.range !== undefined) this.range = s.range;
    if (s.neutral !== undefined) this.neutral = s.neutral;
    this.sync();
  }

  private sync(): void {
    const n = this.neutral;
    this.textures = { u_valuesA: this.steps.a, u_valuesB: this.steps.b, u_ramp: this.rampTexture };
    this.uniforms = {
      u_style: { vec4: [this.steps.mix, clamp01(this.opacity), this.steps.width, n ? 1 : 0] },
      u_range: { vec4: [this.range[0], this.range[1], 0, 0] },
      u_neutral: { vec4: [n?.[0] ?? 0, n?.[1] ?? 0, n?.[2] ?? 0, 1] },
    };
  }

  override draw(ctx: DrawContext): void {
    if (!this.steps.ready) return;
    super.draw(ctx);
  }

  /** Frees the prisms, the ramp and the step textures. The caller takes the layer out of the renderer. */
  dispose(): void {
    for (const p of [...this.pieces]) {
      this.remove(p);
      this.renderer.device.deleteMesh(p.mesh);
    }
    this.steps.dispose();
    this.renderer.device.deleteTexture(this.rampTexture);
  }
}
