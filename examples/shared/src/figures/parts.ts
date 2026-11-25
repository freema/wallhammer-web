// The parts of one figure's look on the GPU: an instance set of one record per part (the engine's `InstanceSetLayer`),
// in one layer with the page's material, written from the solved bones (`BoneInstances`). The material takes the
// parts' vertices as mesh.ts writes them (position, normal, colour and material) and the instance record; the record's
// extra field carries the tint of the part's colour slot.

import { BoneInstances, InstanceSetLayer, instanceSet } from 'wallhammer-web/render';
import type { BonePart, InstanceSet, Material, Renderer } from 'wallhammer-web/render';
import type { FigureKind } from './kind.ts';

export class FigureParts {
  readonly sets: InstanceSet[] = [];
  readonly layer: InstanceSetLayer;
  private readonly bones: BoneInstances;
  private shown = false;

  constructor(renderer: Renderer, name: string, material: Material, kind: FigureKind, variant: number) {
    const layer = new InstanceSetLayer(renderer, { name, material });
    this.layer = layer;
    const look = kind.look(variant);
    const parts: BonePart[] = [];
    for (const part of kind.parts) {
      if (part.feature !== 0 && (look.features & part.feature) === 0) continue;
      const set = instanceSet(part.mesh, 1, { name: `${name} ${kind.skeleton.names[part.bone]}`, visible: false });
      set.count = 1;
      const tint = look.colors[part.slot] ?? [1, 1, 1];
      // The tint of the part's tinted vertices.
      set.data[12] = tint[0];
      set.data[13] = tint[1];
      set.data[14] = tint[2];
      set.data[15] = 1;
      layer.add(set);
      this.sets.push(set);
      parts.push({ bone: part.bone, set, record: 0 });
    }
    this.bones = new BoneInstances(parts);
  }

  get visible(): boolean {
    return this.shown;
  }

  set visible(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    for (const s of this.sets) {
      s.visible = on;
      s.dirty = true;
    }
  }

  /** The solved bones (12 numbers each, in the frame the parts are drawn in). */
  write(bones: Float64Array): void {
    this.bones.write(bones);
  }
}
