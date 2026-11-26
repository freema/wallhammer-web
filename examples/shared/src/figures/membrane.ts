// A skin of triangles whose corners follow several bones at once (the glider's wings): each frame every corner is put
// where its bones carry it (the weighted sum of its point in each bone's frame) and each triangle is written as one
// instance record of a unit triangle, the record's linear part taking the unit triangle's corners to the skinned ones.
// One instance set in a figure's layer (parts.ts), so it is lit, tinted and shadowed like the figure's rigid parts.
//
// The unit mesh is two triangles on the corners (0,0,0), (1,0,0), (0,0,1): its top (+y) with the vertex colour 1 and
// its underside with `under`, both tinted by the record (the tone of the triangle). The record's columns are P1 − P0,
// the triangle's unit normal and P2 − P0, so the top faces along (P2 − P0) × (P1 − P0).

import { instanceSet } from 'wallhammer-web/render';
import type { InstanceSet, InstanceSetLayer } from 'wallhammer-web/render';
import { FigureMesh, MAT } from './mesh.ts';
import type { RGB } from './mesh.ts';

/** What a membrane is made of: corners with their bones and triangles between them (glider.ts `GliderMembrane`). */
export interface MembraneData {
  readonly corners: readonly (readonly number[])[];
  readonly triangles: readonly number[];
}

export class Membrane {
  readonly set: InstanceSet;
  private readonly influences: Float64Array;
  /** Per corner: the first influence's index in `influences` and how many. */
  private readonly first: Int32Array;
  private readonly count: Int32Array;
  private readonly tris: Int32Array;
  private readonly tones: Float32Array;
  private readonly at: Float64Array;
  private readonly rec = new Float64Array(12);

  constructor(layer: InstanceSetLayer, name: string, data: MembraneData, tones: readonly RGB[], under: RGB) {
    const unit = new FigureMesh(1);
    unit.paint([1, 1, 1], MAT.tint, 0).tri([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    unit.paint(under, MAT.tint, 0).tri([0, 0, 0], [1, 0, 0], [0, 0, 1]);
    const n = data.triangles.length / 4;
    this.set = instanceSet(unit.mesh(), n, { name, visible: false });
    this.set.count = n;
    layer.add(this.set);
    let total = 0;
    for (const c of data.corners) total += c.length / 5;
    this.influences = new Float64Array(total * 5);
    this.first = new Int32Array(data.corners.length);
    this.count = new Int32Array(data.corners.length);
    let k = 0;
    data.corners.forEach((c, i) => {
      this.first[i] = k;
      this.count[i] = c.length / 5;
      for (const x of c) this.influences[k++] = x;
    });
    this.tris = Int32Array.from(data.triangles);
    this.tones = new Float32Array(tones.length * 3);
    tones.forEach((t, i) => this.tones.set(t, i * 3));
    this.at = new Float64Array(data.corners.length * 3);
  }

  get visible(): boolean {
    return this.set.visible;
  }

  set visible(on: boolean) {
    if (on === this.set.visible) return;
    this.set.visible = on;
    this.set.dirty = true;
  }

  /** Skins the corners from the solved bones (12 numbers each) and writes every triangle's record. */
  write(bones: Float64Array): void {
    const inf = this.influences, at = this.at;
    for (let i = 0; i < this.first.length; i++) {
      let x = 0, y = 0, z = 0;
      for (let j = 0, k = this.first[i]!; j < this.count[i]!; j++, k += 5) {
        const o = inf[k]! * 12, w = inf[k + 1]!, lx = inf[k + 2]!, ly = inf[k + 3]!, lz = inf[k + 4]!;
        x += w * (bones[o]! * lx + bones[o + 3]! * ly + bones[o + 6]! * lz + bones[o + 9]!);
        y += w * (bones[o + 1]! * lx + bones[o + 4]! * ly + bones[o + 7]! * lz + bones[o + 10]!);
        z += w * (bones[o + 2]! * lx + bones[o + 5]! * ly + bones[o + 8]! * lz + bones[o + 11]!);
      }
      at[i * 3] = x;
      at[i * 3 + 1] = y;
      at[i * 3 + 2] = z;
    }
    const t = this.tris, r = this.rec, out = this.set.data, tones = this.tones;
    for (let q = 0, rec = 0; q < t.length; q += 4, rec++) {
      const a = t[q]! * 3, b = t[q + 1]! * 3, c = t[q + 2]! * 3, tone = t[q + 3]! * 3;
      const ax = at[a]!, ay = at[a + 1]!, az = at[a + 2]!;
      const ux = at[b]! - ax, uy = at[b + 1]! - ay, uz = at[b + 2]! - az;
      const vx = at[c]! - ax, vy = at[c + 1]! - ay, vz = at[c + 2]! - az;
      // Normal = v × u (the top of the unit triangle).
      let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l > 1e-12) {
        nx /= l;
        ny /= l;
        nz /= l;
      } else (nx = 0), (ny = 1), (nz = 0);
      r[0] = ux, r[1] = uy, r[2] = uz;
      r[3] = nx, r[4] = ny, r[5] = nz;
      r[6] = vx, r[7] = vy, r[8] = vz;
      r[9] = ax, r[10] = ay, r[11] = az;
      const o = rec * 16;
      for (let k = 0; k < 12; k++) out[o + k] = r[k]!;
      out[o + 12] = tones[tone]!;
      out[o + 13] = tones[tone + 1]!;
      out[o + 14] = tones[tone + 2]!;
      out[o + 15] = 1;
    }
    this.set.dirty = true;
  }
}
