// The brooks' strips as meshes over the ground as it is drawn: the engine's `stripMesh` on a surface that is the
// field's own triangles (`flatStripSurface` over a flat world whose cells are squares of `CELL_QUADS` cells of the
// field). Every piece of a strip is cut where it crosses an edge of those triangles and every vertex lies at its
// section's height or a little over the triangle under it, whichever is higher: so a bed never sinks under the ground
// and the water never under the bed. Pure data; positions are in world metres.
//
// Vertex layout: `STRIP_LAYOUT` of the engine (`a_pos` world metres here; in place of `a_coarseShift`, which a flat
// surface of one level leaves 0, −1 along a brook, rising to 0 as its water takes the colour of the water it runs
// into before a mouth, then how far the strip has faded out past a mouth or a tributary's entry, 0 to 1; `a_side`
// the unit vector toward the vertex's edge; `a_strip` across in half-widths, metres along the line from its first
// point, the half-width on the vertex's side, and in place of the line's index the bend: how far the vertex's side lies
// toward the inside of a bend, 1/radius in metres, positive on the inside and negative on the outside).

import { FACE_FLAT, FlatWorld, cellId, flatStripSurface } from 'wallhammer-web/gen-core';
import type { StripNet } from 'wallhammer-web/gen-core';
import { STRIP_LAYOUT, stripMesh } from 'wallhammer-web/gen-mesh';
import type { MeshData } from 'wallhammer-web/base';
import { STEP_M, type BrookPlan } from './brooks.ts';
import type { Field } from './field.ts';
import { SEA_FLOOR_M } from './ground-mesh.ts';
import { nearestOn } from './plan.ts';

/** Field cells along one edge of a cell of the strips' surface, and the level of those cells. */
const CELL_QUADS = 128;
const LEVEL = 4;
/** The bed lies at least this far over the drawn ground, the water this far: the water always over the bed. */
export const BED_LIFT_M = 0.02;
export const WATER_LIFT_M = 0.035;

/** A brook starts to fade out this many metres past its shore (the water it runs into is drawn a little beyond); a
 * tributary from its shore, where it reaches its stem's edge, so no two waters lie over each other. */
const FADE_FROM_M = 1.5;
/** Over this many metres before that a brook's water takes the look of the water it runs into (calm, deeper). */
const TO_RIVER_M = 7;
/** A tributary fades out over this many metres; over its last `OVER_FROM_M` it fades wherever it lies over its stem. */
const TRIB_FADE_M = 1;
const OVER_FROM_M = 30;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface BrookPiece {
  data: MeshData;
  min: [number, number, number];
  max: [number, number, number];
}

/** The pieces of one strip net of the brooks (`bp.bed` or `bp.water`), one per cell of the surface it touches. */
export function brookPieces(f: Field, bp: BrookPlan, net: StripNet, liftM: number): BrookPiece[] {
  const edgeM = CELL_QUADS * f.step;
  const world = new FlatWorld(edgeM * 2 ** LEVEL);
  const heightAt = (x: number, z: number): number => {
    const i = Math.round((x - f.x0) / f.step);
    const j = Math.round((z - f.z0) / f.step);
    if (i < 0 || j < 0 || i >= f.n || j >= f.n) return SEA_FLOOR_M;
    return f.ground[j * f.n + i]!;
  };
  const surface = flatStripSurface({ shape: world, quads: CELL_QUADS, heightAt });
  // The cells any line's box touches.
  const cells = new Set<string>();
  for (const line of net.lines) {
    const b = line.box;
    for (let cy = Math.floor(b[2]! / edgeM); cy <= Math.floor(b[5]! / edgeM); cy++) for (let cx = Math.floor(b[0]! / edgeM); cx <= Math.floor(b[3]! / edgeM); cx++) cells.add(`${cx},${cy}`);
  }
  const keys = [...cells].map((k) => k.split(',').map(Number) as [number, number]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const pieces: BrookPiece[] = [];
  const stride = STRIP_LAYOUT.stride;
  for (const [cx, cy] of keys) {
    const cell = cellId(FACE_FLAT, LEVEL, cx, cy);
    const m = stripMesh(net, surface, cell, { coarsestLevel: LEVEL, liftM: () => liftM });
    if (!m) continue;
    // Positions relative to the cell's origin → world metres.
    const o = world.origin(cell);
    const view = new DataView(m.mesh.vertices.buffer, m.mesh.vertices.byteOffset, m.mesh.vertices.byteLength);
    const count = m.mesh.vertices.byteLength / stride;
    for (let v = 0; v < count; v++) {
      const at = v * stride;
      view.setFloat32(at, view.getFloat32(at, true) + o[0], true);
      view.setFloat32(at + 8, view.getFloat32(at + 8, true) + o[2], true);
      // The bend at the vertex's station, seen from its side.
      const line = Math.round(view.getFloat32(at + 40, true));
      const b = bp.brooks[line]!;
      const along = view.getFloat32(at + 32, true);
      const alongM = bp.starts[line]! + along;
      const i = Math.min(b.n - 1, Math.max(0, Math.round(alongM / STEP_M)));
      view.setFloat32(at + 40, view.getFloat32(at + 16, true) * b.bend[2 * i]! + view.getFloat32(at + 24, true) * b.bend[2 * i + 1]!, true);
      // −1 along the brook, rising to 0 over the last `TO_RIVER_M` before it fades out at a mouth (its water takes the
      // look of the water it runs into), then the fade itself, 0 to 1. A tributary keeps its own look: 2 along it,
      // then 2 + its fade past where it reaches its stem's water.
      let mark = -1;
      if (b.shoreM < Infinity) {
        const endM = (b.n - 1) * STEP_M;
        // A tributary is gone soon after it reaches the stem's edge (two waters over each other read as a patch).
        const from = b.to >= 0 ? Math.min(b.shoreM, endM - 0.5) : b.shoreM + FADE_FROM_M;
        const fade = smooth(from, b.to >= 0 ? Math.min(endM - 0.05, from + TRIB_FADE_M) : Math.max(from + 0.5, endM - 0.3), alongM);
        // A tributary also fades wherever it lies over its stem's water, at its edges too: it meets the stem at an
        // angle, so one edge of its end lies over the stem well before its middle reaches the stem.
        let over = 0;
        if (b.to >= 0 && alongM > endM - OVER_FROM_M) {
          const S = bp.brooks[bp.nodes[b.to]!.stem]!;
          const h = nearestOn(S.x, S.z, view.getFloat32(at, true), view.getFloat32(at + 8, true));
          const k = Math.min(S.n - 1, h.i + 1);
          const half = (S.half[h.i]! + (S.half[k]! - S.half[h.i]!) * h.t) * S.share[h.i]!;
          over = 1 - smooth(0.6 * half, half, h.d);
        }
        mark = b.to >= 0 ? 2 + Math.max(fade, over) : fade > 0 ? fade : -1 + smooth(from - TO_RIVER_M, from, alongM);
      }
      view.setFloat32(at + 12, mark, true);
      // The grade of its water along it at the vertex's station, over a few steps, in the side's up component (the
      // side of a strip on the plane is level; brook-material.ts takes it out of it): its riffles come and go smoothly,
      // not by the faces of the strip.
      const lo = Math.max(0, i - 2);
      const hi = Math.min(b.n - 1, i + 2);
      view.setFloat32(at + 20, hi > lo ? Math.max(0, b.water[lo]! - b.water[hi]!) / ((hi - lo) * STEP_M) : 0, true);
    }
    pieces.push({
      data: m.mesh,
      min: [m.bounds.min[0] + o[0], m.bounds.min[1], m.bounds.min[2] + o[2]],
      max: [m.bounds.max[0] + o[0], m.bounds.max[1], m.bounds.max[2] + o[2]],
    });
  }
  return pieces;
}
