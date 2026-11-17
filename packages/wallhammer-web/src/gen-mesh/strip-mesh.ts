// Mesh of the strips of a net (gen-core's `stripNet`) inside one streamed cell, at the cell's level, able to blend
// into the shape of the level one coarser like the surface under it.
//
// - Pieces: every station pair of a line is cut where its centre way meets an edge of the triangles the cell's level
//   draws (`StripSurface.cuts`). A section of vertices stands at every share, shared by the pieces that meet there;
//   a section point at across a lies at `centre + |a| · (edge − centre)` on its side, put back on the base surface.
// - Height of a section point with |a| ≤ 1 at level L: `max(grade + camber · up(a), heightOn(L, p) + liftM(L))`, so a
//   vertex never lies under the ground any level draws there. A hem point hangs from its edge point by the
//   difference of their `up`. `a_coarseShift` is the same rule at level L − 1 minus the own height, along local up.
// - The strip is drawn at least a given number of pixels wide: the vertex shader moves an edge vertex outward by
//   `stripWiden` (the same rule in TS: `stripGrow`), so a far strip stays an unbroken line without a second kind of
//   geometry.
//
// Positions are relative to `surface.origin(cell)`; the bytes depend on the net, the surface, the cell and the
// options only, never on other cells or the order of generation.

import type { MeshData, VertexLayout } from '../base/data.ts';
import type { CellId, LocalBounds } from '../gen-core/cell.ts';
import { STRIP_STATION_FLOATS, stripUp } from '../gen-core/strip.ts';
import type { StripNet } from '../gen-core/strip.ts';
import type { StripSurface } from '../gen-core/strip-surface.ts';

/** Locations a material should give the attributes. */
export const STRIP_ATTRIBS = { a_pos: 0, a_coarseShift: 1, a_side: 2, a_strip: 3 } as const;

/**
 * Position 3× float relative to the cell origin; `a_coarseShift`, metres along local up to the shape of the level one
 * coarser; `a_side`, unit vector from the centre of the section to the vertex's edge (zero on the centre); `a_strip`:
 * across a (half-widths), metres along the line, half-width of the section on the vertex's side in metres, index of
 * the line.
 */
export const STRIP_LAYOUT: VertexLayout = {
  stride: 44,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_coarseShift', size: 1, type: 'f32', offset: 12 },
    { name: 'a_side', size: 3, type: 'f32', offset: 16 },
    { name: 'a_strip', size: 4, type: 'f32', offset: 28 },
  ],
};

/**
 * GLSL for a strip vertex shader: include `<header>`, then `<noise>` (for `metresPerPixelAt`), then this, after the
 * morph code of the surface. `stripWiden` moves an edge vertex outward so the strip is at least `minPx` pixels wide;
 * `grow` is the metres it added per side.
 *
 *   vec3 p = a_pos + u_cellOffset;
 *   p += localUp(p) * (a_coarseShift * spherePatchMorph(p)); // or u_morphUp and cellMorph(p) on the plane
 *   float grow;
 *   p = stripWiden(p, a_side, a_strip, 1.6, grow);
 */
export const STRIP_GLSL = /* glsl */ `
vec3 stripWiden(vec3 p, vec3 side, vec4 strip, float minPx, out float grow) {
  grow = max(0.0, 0.5 * minPx * metresPerPixelAt(p) - strip.z);
  return p + side * (grow * min(abs(strip.x), 1.0));
}
`;

/** Metres `stripWiden` adds to each side of a strip `halfWidthM` wide where a pixel covers `metresPerPixel`. */
export function stripGrow(halfWidthM: number, metresPerPixel: number, minPx: number): number {
  return Math.max(0, 0.5 * minPx * metresPerPixel - halfWidthM);
}

export interface StripMeshOptions {
  /** The coarsest level that draws the strips: it has nothing to blend into (`a_coarseShift` 0). */
  coarsestLevel: number;
  /** Metres a level lifts the strip above its own triangles at least. */
  liftM: (level: number) => number;
}

export interface StripMesh {
  mesh: MeshData;
  /** Extent relative to `surface.origin(cell)`, at any blend factor, without the shader's widening. */
  bounds: LocalBounds;
  /** Per line: metres of its centre line this cell holds. */
  lengthM: Float64Array;
}

const FLOATS = STRIP_LAYOUT.stride / 4;

export function stripMesh(net: StripNet, surface: StripSurface, cell: CellId, o: StripMeshOptions): StripMesh | null {
  if (surface.radiusM !== net.radiusM) throw new Error(`stripMesh: the surface (radius ${surface.radiusM}) and the net (radius ${net.radiusM}) differ`);
  const R = net.radiusM;
  const sphere = R > 0;
  const level = cell.level;
  const coarse = level > o.coarsestLevel;
  const liftOwn = o.liftM(level);
  const liftCoarse = coarse ? o.liftM(level - 1) : 0;
  const origin = surface.origin(cell);
  const lengthM = new Float64Array(net.lineCount);
  const verts: number[] = [];
  const idx: number[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  /** Point at share t of the straight way between two points, put on the base surface. */
  const way = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, out: number[]): void => {
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    if (sphere) {
      const l = Math.sqrt(x * x + y * y + z * z);
      out[0] = (x / l) * R;
      out[1] = (y / l) * R;
      out[2] = (z / l) * R;
    } else {
      out[0] = x;
      out[1] = 0;
      out[2] = z;
    }
  };
  const C: [number, number, number] = [0, 0, 0];
  const L: [number, number, number] = [0, 0, 0];
  const Rt: [number, number, number] = [0, 0, 0];
  const P: [number, number, number] = [0, 0, 0];

  for (let li = 0; li < net.lineCount; li++) {
    const line = net.lines[li]!;
    const profile = net.profiles[line.profile]!;
    const sec = profile.section;
    const m = sec.length / 2;
    // Index of the edge points −1 and 1 in the section.
    let iL = -1;
    let iR = -1;
    for (let k = 0; k < m; k++) {
      if (sec[k * 2] === -1 && iL < 0) iL = k;
      if (sec[k * 2] === 1) iR = k;
    }
    const st = line.stations;
    let prevBase = -1;
    let prevPiece = -2;
    let prevShare = NaN;
    const hOwn = new Float64Array(m);
    const hCoarse = new Float64Array(m);

    /** One section of vertices at share t of piece k; returns the index of its first vertex. */
    const section = (k: number, t: number): number => {
      const s0 = k * STRIP_STATION_FLOATS;
      const s1 = s0 + STRIP_STATION_FLOATS;
      // The stations themselves at t = 0 and t = 1.
      const at = t === 0 ? s0 : t === 1 ? s1 : -1;
      for (let c = 0; c < 3; c++) {
        if (at >= 0) {
          C[c] = st[at + c]!;
          L[c] = st[at + 3 + c]!;
          Rt[c] = st[at + 6 + c]!;
        }
      }
      if (at < 0) {
        way(st[s0]!, st[s0 + 1]!, st[s0 + 2]!, st[s1]!, st[s1 + 1]!, st[s1 + 2]!, t, C);
        way(st[s0 + 3]!, st[s0 + 4]!, st[s0 + 5]!, st[s1 + 3]!, st[s1 + 4]!, st[s1 + 5]!, t, L);
        way(st[s0 + 6]!, st[s0 + 7]!, st[s0 + 8]!, st[s1 + 6]!, st[s1 + 7]!, st[s1 + 8]!, t, Rt);
      }
      const mixAt = (f: number): number => (at >= 0 ? st[at + f]! : st[s0 + f]! + (st[s1 + f]! - st[s0 + f]!) * t);
      const grade = mixAt(9);
      const camber = mixAt(10);
      const along = mixAt(11);
      const base = verts.length / FLOATS;
      // Heights: first the points on the strip, then the hem from its edge point.
      const points: number[] = new Array(m * 3);
      for (let k2 = 0; k2 < m; k2++) {
        const a = sec[k2 * 2]!;
        const E = a >= 0 ? Rt : L;
        const s = Math.abs(a);
        if (a === 0) {
          P[0] = C[0]!;
          P[1] = C[1]!;
          P[2] = C[2]!;
        } else {
          way(C[0], C[1], C[2], E[0], E[1], E[2], s, P);
        }
        points[k2 * 3] = P[0];
        points[k2 * 3 + 1] = P[1];
        points[k2 * 3 + 2] = P[2];
        if (Math.abs(a) <= 1) {
          const design = grade + camber * stripUp(profile, a);
          hOwn[k2] = Math.max(design, surface.heightOn(level, P) + liftOwn);
          hCoarse[k2] = coarse ? Math.max(design, surface.heightOn(level - 1, P) + liftCoarse) : hOwn[k2]!;
        }
      }
      for (let k2 = 0; k2 < m; k2++) {
        const a = sec[k2 * 2]!;
        if (Math.abs(a) <= 1) continue;
        const e = a < 0 ? iL : iR;
        const drop = sec[k2 * 2 + 1]! - sec[e * 2 + 1]!;
        hOwn[k2] = hOwn[e]! + drop;
        hCoarse[k2] = hCoarse[e]! + drop;
      }
      for (let k2 = 0; k2 < m; k2++) {
        const a = sec[k2 * 2]!;
        const E = a >= 0 ? Rt : L;
        const px = points[k2 * 3]!;
        const py = points[k2 * 3 + 1]!;
        const pz = points[k2 * 3 + 2]!;
        let ux = 0;
        let uy = 1;
        let uz = 0;
        if (sphere) {
          ux = px / R;
          uy = py / R;
          uz = pz / R;
        }
        const h = hOwn[k2]!;
        const shift = coarse ? Math.fround(hCoarse[k2]! - h) : 0;
        const pos = sphere
          ? [Math.fround(px + ux * h - origin[0]), Math.fround(py + uy * h - origin[1]), Math.fround(pz + uz * h - origin[2])]
          : [Math.fround(px - origin[0]), Math.fround(h - origin[1]), Math.fround(pz - origin[2])];
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let hw = 0;
        if (a !== 0) {
          sx = E[0]! - C[0]!;
          sy = E[1]! - C[1]!;
          sz = E[2]! - C[2]!;
          hw = Math.sqrt(sx * sx + sy * sy + sz * sz);
          sx /= hw;
          sy /= hw;
          sz /= hw;
        } else {
          // The centre: the larger of the two sides, for the widening it does not use.
          const lx = L[0] - C[0];
          const ly = L[1] - C[1];
          const lz = L[2] - C[2];
          const rx = Rt[0] - C[0];
          const ry = Rt[1] - C[1];
          const rz = Rt[2] - C[2];
          hw = Math.sqrt(Math.max(lx * lx + ly * ly + lz * lz, rx * rx + ry * ry + rz * rz));
        }
        verts.push(pos[0]!, pos[1]!, pos[2]!, shift, sx, sy, sz, a, along, hw, li);
        const up = [ux, uy, uz];
        for (let c = 0; c < 3; c++) {
          const p0 = pos[c]!;
          const p1 = p0 + up[c]! * shift;
          min[c] = Math.min(min[c]!, p0 - 1e-3, p1 - 1e-3);
          max[c] = Math.max(max[c]!, p0 + 1e-3, p1 + 1e-3);
        }
      }
      return base;
    };

    for (let k = 0; k + 1 < line.count; k++) {
      const s0 = k * STRIP_STATION_FLOATS;
      const s1 = s0 + STRIP_STATION_FLOATS;
      const shares = surface.cuts(cell, [st[s0]!, st[s0 + 1]!, st[s0 + 2]!], [st[s1]!, st[s1 + 1]!, st[s1 + 2]!]);
      if (shares.length < 2) continue;
      lengthM[li] = lengthM[li]! + (shares[shares.length - 1]! - shares[0]!) * (st[s1 + 11]! - st[s0 + 11]!);
      for (let i = 0; i < shares.length; i++) {
        const t = shares[i]!;
        let base: number;
        // The station between two pieces: reuse the section the previous piece ended with.
        if (i === 0 && t === 0 && prevPiece === k - 1 && prevShare === 1) base = prevBase;
        else base = section(k, t);
        if (i > 0) {
          const b0 = prevBase;
          const b1 = base;
          for (let j = 0; j + 1 < m; j++) {
            // Left to right across, forward along: (S0[j], S0[j+1], S1[j]) winds anticlockwise seen from above.
            idx.push(b0 + j, b0 + j + 1, b1 + j, b0 + j + 1, b1 + j + 1, b1 + j);
          }
        }
        prevBase = base;
      }
      prevPiece = k;
      prevShare = shares[shares.length - 1]!;
    }
  }
  if (idx.length === 0) return null;
  const count = verts.length / FLOATS;
  const buf = new ArrayBuffer(count * STRIP_LAYOUT.stride);
  const view = new DataView(buf);
  for (let i = 0; i < verts.length; i++) view.setFloat32(i * 4, verts[i]!, true);
  const indices = count > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx);
  const bounds: LocalBounds = { min: [Math.fround(min[0]!), Math.fround(min[1]!), Math.fround(min[2]!)], max: [Math.fround(max[0]!), Math.fround(max[1]!), Math.fround(max[2]!)] };
  return { mesh: { layout: STRIP_LAYOUT, vertices: new Uint8Array(buf), indices, count: idx.length }, bounds, lengthM };
}
