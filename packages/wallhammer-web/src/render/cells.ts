// Instances split into cells (gen-core `splitInstanceCells`), drawn with a level of detail and a thinning tier chosen
// per cell. `InstancedLayer` culls every instance and picks one level of detail for the whole layer, which costs
// time per refit and draws the finest shape everywhere. Here each cell has fixed GPU buffers, is culled as one box
// and picks its level and tier by its own distance from the eye. Nothing is rewritten on the GPU after upload.

import type { MeshData, VertexLayout } from '../base/data.ts';
import type { Vec3 } from '../base/math.ts';
import type { Uniforms } from '../base/material.ts';
import type { CullVolume, View } from '../base/view.ts';
import { boxInVolume, distanceToBox } from '../base/view.ts';
import type { InstanceCell } from '../gen-core/index.ts';
import type { Device, InstanceBuffer, Mesh } from '../gpu/index.ts';
import { MeshLayer } from './renderer.ts';
import type { DrawContext, MeshLayerOptions } from './renderer.ts';

/**
 * Distances (metres from the eye to the cell box) at which a cell switches detail. Each distance in a list that the
 * cell is at or beyond counts one step.
 */
export interface CellDetail {
  /** Colour and data passes: each step drops one level of detail, starting from the finest (the last in `lods`). */
  lodSteps: readonly number[];
  /** Colour and data passes: each step moves one thinning tier on (tier 0 is every instance). */
  tierSteps: readonly number[];
  /** Shadow pass: as `tierSteps`. Default `tierSteps`. The shadow pass always draws level 0 (the coarsest). */
  shadowTierSteps?: readonly number[];
}

/** Level of detail and tier for a cell at `distance`, clamped to what the cell has. Pure. */
export function cellDetail(distance: number, purpose: 'shadow' | 'view', d: CellDetail, lodCount: number, tierCount: number): { lod: number; tier: number } {
  const steps = (list: readonly number[]): number => list.reduce((n, at) => (distance >= at ? n + 1 : n), 0);
  const tierSteps = purpose === 'shadow' ? (d.shadowTierSteps ?? d.tierSteps) : d.tierSteps;
  const tier = Math.min(tierCount - 1, steps(tierSteps));
  const lod = purpose === 'shadow' ? 0 : Math.max(0, lodCount - 1 - steps(d.lodSteps));
  return { lod, tier };
}

export interface InstanceCellLayerOptions extends Omit<MeshLayerOptions, 'mesh'> {
  detail: CellDetail;
  /**
   * The distance an orthographic view (no eye, `pixelGrowth` 0) uses for every cell. Default: the distance at which a
   * 45° perspective view about 1100 pixels high has the same CSS pixel size, `metresPerPixel · dpr · 1100`.
   */
  orthoDistance?: (view: View) => number;
}

/** One shape (its levels of detail, coarsest first) with its cells. */
export interface InstanceCellGroup {
  /** Set before this group's draws, after the layer's uniforms. May be replaced at any time. */
  uniforms: Uniforms;
  /** Instances in tier 0 over all cells. */
  readonly instances: number;
  /** Bytes this group holds on the GPU: each level of detail once, plus the instance buffers. */
  readonly bytes: number;
}

interface GroupImpl extends InstanceCellGroup {
  base: Mesh[];
  buffers: InstanceBuffer[];
  cells: CellDraw[];
}

interface CellDraw {
  min: Vec3;
  max: Vec3;
  /** meshes[tier][lod]; an empty list for a tier without instances in this cell. */
  meshes: Mesh[][];
}

interface DrawEntry {
  mesh: Mesh;
  group: GroupImpl;
}

/**
 * Groups of instanced shapes split into cells. Each (cell, tier, level of detail) is one instanced mesh sharing the
 * level's vertex buffer; a refit culls cells by box and picks per cell what to draw. `cull` returns the instances kept
 * for the view (the `instancesVisible` statistic).
 */
export class InstanceCellLayer extends MeshLayer {
  detail: CellDetail;
  private readonly device: Device;
  private readonly orthoDistance: (view: View) => number;
  private readonly list: GroupImpl[] = [];
  private viewList: DrawEntry[] = [];
  private shadowList: DrawEntry[] = [];
  private stale = false;
  /** Instances drawn in the last colour (or data) pass. */
  drawnInstances = 0;

  constructor(device: Device, o: InstanceCellLayerOptions) {
    super(o);
    this.device = device;
    this.detail = o.detail;
    this.orthoDistance = o.orthoDistance ?? ((view): number => view.metresPerPixel * view.dpr * 1100);
  }

  get groups(): readonly InstanceCellGroup[] {
    return this.list;
  }

  get bytes(): number {
    return this.list.reduce((b, g) => b + g.bytes, 0);
  }

  /**
   * Uploads one shape and its cells. `lods` go coarsest first; `layout` is the instance layout of the cells' tier data.
   * Each level is uploaded once and shared by every cell and tier.
   */
  addGroup(lods: readonly MeshData[], cells: readonly InstanceCell[], layout: VertexLayout, uniforms: Uniforms = {}): InstanceCellGroup {
    const attribs = this.material.attribs;
    const base = lods.map((m) => this.device.createMesh(m, attribs));
    let bytes = base.reduce((b, m) => b + m.bytes, 0);
    const buffers: InstanceBuffer[] = [];
    let instances = 0;
    const draws: CellDraw[] = cells.map((c) => {
      instances += (c.tiers[0]?.length ?? 0) / (layout.stride / 4);
      const meshes = c.tiers.map((data) => {
        if (data.length === 0) return [];
        const inst = this.device.createInstances({ layout, data });
        buffers.push(inst);
        bytes += data.byteLength;
        return base.map((m) => this.device.shareMesh(m, attribs, inst));
      });
      return { min: c.min, max: c.max, meshes };
    });
    const g: GroupImpl = { uniforms, instances, bytes, base, buffers, cells: draws };
    this.list.push(g);
    this.stale = true;
    return g;
  }

  /** Removes a group and deletes its GPU objects. */
  removeGroup(group: InstanceCellGroup): void {
    const i = this.list.indexOf(group as GroupImpl);
    if (i < 0) return;
    const g = this.list[i]!;
    this.list.splice(i, 1);
    for (const c of g.cells) for (const tier of c.meshes) for (const m of tier) this.device.deleteMesh(m);
    for (const b of g.buffers) this.device.deleteInstances(b);
    for (const m of g.base) this.device.deleteMesh(m);
    this.viewList = this.viewList.filter((e) => e.group !== g);
    this.shadowList = this.shadowList.filter((e) => e.group !== g);
    this.stale = true;
  }

  cullStale(): boolean {
    return this.stale;
  }

  cull(volume: CullVolume, purpose: 'shadow' | 'view', view?: View): number {
    // A perspective view's corner rays start at the eye; an orthographic view has none and uses one distance for all.
    const eye = view && view.pixelGrowth > 0 ? view.cornerRays()[0]!.origin : null;
    const flat = view && !eye ? this.orthoDistance(view) : 0;
    const out: DrawEntry[] = [];
    let kept = 0;
    for (const g of this.list) {
      for (const c of g.cells) {
        if (!boxInVolume(c, volume)) continue;
        const d = eye ? distanceToBox(eye, c) : flat;
        const { tier, lod } = cellDetail(d, purpose, this.detail, g.base.length, c.meshes.length);
        const lods = c.meshes[tier]!;
        const mesh = lods[Math.min(lod, lods.length - 1)];
        if (!mesh) continue;
        out.push({ mesh, group: g });
        kept += mesh.instances;
      }
    }
    if (purpose === 'shadow') this.shadowList = out;
    else {
      this.viewList = out;
      this.stale = false;
    }
    return purpose === 'view' ? kept : 0;
  }

  override draw(ctx: DrawContext): void {
    const list = ctx.pass === 'shadow' ? this.shadowList : this.viewList;
    const colour = ctx.pass === 'color' || ctx.pass === 'data';
    if (colour) this.drawnInstances = 0;
    if (list.length === 0) return;
    const program = this.begin(ctx);
    if (!program) return;
    let group: GroupImpl | null = null;
    let n = 0;
    for (const e of list) {
      if (e.group !== group) {
        group = e.group;
        for (const name in group.uniforms) program.set(name, group.uniforms[name]!);
      }
      ctx.device.draw(e.mesh);
      ctx.count(e.mesh.triangles * e.mesh.instances);
      n += e.mesh.instances;
    }
    if (colour) this.drawnInstances = n;
  }
}
