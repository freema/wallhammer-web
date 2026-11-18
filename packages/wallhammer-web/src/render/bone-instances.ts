// Bone matrices into instance records. A figure drawn as rigid parts has one record per part in some instance set;
// each part follows one bone, optionally through a fixed part matrix (the part's placement in the bone's frame).
// `BoneInstances` holds that table as flat arrays and writes world · part into the records' first 12 floats (the
// four free numbers stay as the owner wrote them), marking the touched sets dirty. Nothing is allocated per call.
// World matrices come from anywhere (`solvePose` of motion fills them): 12 numbers per bone, column by column.

import { INSTANCE_SET_FLOATS } from './instance-sets.ts';
import type { InstanceSet } from './instance-sets.ts';

/** One part: the bone it follows, its set and record, and its matrix in the bone's frame (default identity). */
export interface BonePart {
  bone: number;
  set: InstanceSet;
  record: number;
  local?: ArrayLike<number> | null;
}

export class BoneInstances {
  readonly count: number;
  private readonly bone: Int32Array;
  private readonly record: Int32Array;
  private readonly setOf: Int32Array;
  private readonly local: Float64Array;
  private readonly sets: InstanceSet[] = [];

  constructor(parts: readonly BonePart[]) {
    const n = parts.length;
    this.count = n;
    this.bone = new Int32Array(n);
    this.record = new Int32Array(n);
    this.setOf = new Int32Array(n);
    this.local = new Float64Array(n * 12);
    parts.forEach((p, k) => {
      if (p.record < 0 || p.record >= p.set.capacity) throw new Error(`BoneInstances: record ${p.record} outside its set`);
      let s = this.sets.indexOf(p.set);
      if (s < 0) s = this.sets.push(p.set) - 1;
      this.bone[k] = p.bone;
      this.record[k] = p.record;
      this.setOf[k] = s;
      const m = p.local;
      for (let i = 0; i < 12; i++) this.local[k * 12 + i] = m ? m[i]! : i === 0 || i === 4 || i === 8 ? 1 : 0;
    });
  }

  /**
   * Writes every part from the bone matrices in `world` (12 per bone, starting at bone `first`, so one array may hold
   * several figures) and marks the sets dirty.
   */
  write(world: ArrayLike<number>, first = 0): void {
    const L = this.local;
    for (let k = 0; k < this.count; k++) {
      const set = this.sets[this.setOf[k]!]!;
      const out = set.data;
      const o = this.record[k]! * INSTANCE_SET_FLOATS;
      const a = (first + this.bone[k]!) * 12;
      const l = k * 12;
      const a0 = world[a]!, a1 = world[a + 1]!, a2 = world[a + 2]!, a3 = world[a + 3]!, a4 = world[a + 4]!, a5 = world[a + 5]!;
      const a6 = world[a + 6]!, a7 = world[a + 7]!, a8 = world[a + 8]!;
      for (let c = 0; c < 3; c++) {
        const x = L[l + c * 3]!, y = L[l + c * 3 + 1]!, z = L[l + c * 3 + 2]!;
        out[o + c * 3] = a0 * x + a3 * y + a6 * z;
        out[o + c * 3 + 1] = a1 * x + a4 * y + a7 * z;
        out[o + c * 3 + 2] = a2 * x + a5 * y + a8 * z;
      }
      const x = L[l + 9]!, y = L[l + 10]!, z = L[l + 11]!;
      out[o + 9] = a0 * x + a3 * y + a6 * z + world[a + 9]!;
      out[o + 10] = a1 * x + a4 * y + a7 * z + world[a + 10]!;
      out[o + 11] = a2 * x + a5 * y + a8 * z + world[a + 11]!;
    }
    for (let i = 0; i < this.sets.length; i++) this.sets[i]!.dirty = true;
  }

  /** Collapses every part to a point (zero matrix at the origin: nothing is drawn) and marks the sets dirty. */
  hide(): void {
    for (let k = 0; k < this.count; k++) {
      const out = this.sets[this.setOf[k]!]!.data;
      const o = this.record[k]! * INSTANCE_SET_FLOATS;
      for (let i = 0; i < 12; i++) out[o + i] = 0;
    }
    for (let i = 0; i < this.sets.length; i++) this.sets[i]!.dirty = true;
  }
}
