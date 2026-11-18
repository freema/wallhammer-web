// Golden scenarios of the sphere world shape (engine modules base, gen-core, world; generator of the sphere page of
// examples/endless). Each check throws on a violation; the returned values go into the golden hash.
//   - noise in space: a table of values, their range and their continuity across the lattice;
//   - the shape: cells of six quadtrees, neighbours across the edges and at the corners of the cube, parents and
//     children, the cell at a point, distances and the cells near a point against a search of all cells; the frame of
//     an upright object at any direction of up;
//   - seams: border vertices of neighbouring cells of one level agree in every attribute, inside a face and across
//     the edges of the cube; a cell blended fully into its parent's shape lies on the parent's triangles and, on the
//     border of a coarser neighbour, on that neighbour's border; the skirt hangs at least twice as deep as the border
//     can be away from the coarser shape;
//   - cells of the generator: bytes independent of the order of generation, shape hash and error stated, instances
//     inside their cell and owned by one cell of every level;
//   - the horizon test never hides what a straight line of sight reaches;
//   - coverage: a viewer comes down from far above the sphere to its surface next to an edge of the cube and climbs
//     back; the manager covers all six faces exactly once at every step once they are loaded.

import { radialUpAt, upFrame } from '../../packages/wallhammer-web/src/base/index.ts';
import type { CellId } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { SPHERE_PATCH_LAYOUT, cellKey, cubeDirection, cubeFaceOf, fractalNoise3, hashInts, shapeHash, spherePatchRadius, unit, valueNoise3 } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { CELL_FORMAT_VERSION_SHAPED, DEFAULT_STREAMING, GeneratorCellProvider, SphereWorld, StreamingManager, boxMaxRadius, decodeCell, encodeCell, horizonHidden } from '../../packages/wallhammer-web/src/world/index.ts';
import type { CellRequest, StreamingConfig, Ticket } from '../../packages/wallhammer-web/src/world/index.ts';
import { LEAF_LEVEL, QUADS, RADIUS_M, ROOT_LEVEL, RULES, SELECTION, SHAPE, generateSphereCell, surfaceHeight } from '../../examples/endless/src/sphere-world.ts';

const SEED = 7;
type V3 = readonly [number, number, number];

const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const len = (v: V3): number => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: V3): [number, number, number] => {
  const l = len(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const sameCell = (a: CellId, b: CellId): boolean => a.face === b.face && a.level === b.level && a.x === b.x && a.y === b.y;
/** True when `b` is `a` or lies under it in the quadtree. */
const covers = (a: CellId, b: CellId): boolean => a.face === b.face && b.level >= a.level && b.x >> (b.level - a.level) === a.x && b.y >> (b.level - a.level) === a.y;
/** A deterministic direction number k of a stream. */
function direction(stream: number, k: number): [number, number, number] {
  for (let t = 0; ; t++) {
    const v: V3 = [2 * unit(hashInts(stream, k, t, 1)) - 1, 2 * unit(hashInts(stream, k, t, 2)) - 1, 2 * unit(hashInts(stream, k, t, 3)) - 1];
    const l = len(v);
    if (l > 0.2 && l <= 1) return norm(v);
  }
}

/** (a) Noise in space: values at fixed points, inside 0–1, continuous across lattice planes, the same in any order. */
export function noiseTable(): Float64Array {
  const points: V3[] = [[0, 0, 0], [12.5, -7.25, 3], [-0.001, -0.001, -0.001], [99999.5, -100000.25, 31.75], [-6371000, 12, 5e6], [1e7 + 0.5, -1e7 - 0.5, 0.125]];
  for (let k = 0; k < 40; k++) {
    const d = direction(0x901, k);
    points.push([d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M]);
  }
  const fractal = { cellM: 900, octaves: 4, lacunarity: 2.3, gain: 0.45 };
  const out: number[] = [];
  for (const p of points) {
    for (const [cellM, seed] of [[1, 1], [37.5, 2], [26000, 0x7fffffff]] as const) {
      const v = valueNoise3(p[0], p[1], p[2], cellM, seed);
      if (!(v >= 0 && v <= 1)) throw new Error(`noise3: value ${v} outside 0–1`);
      out.push(v);
    }
    const f = fractalNoise3(p[0], p[1], p[2], fractal, 11);
    if (!(f >= 0 && f <= 1)) throw new Error(`noise3: fractal value ${f} outside 0–1`);
    out.push(f, fractalNoise3(p[0], p[1], p[2], { cellM: 50, octaves: 1 }, 5));
  }
  // The second pass in reverse order gives the same bits (no state between calls).
  const again: number[] = [];
  for (const p of [...points].reverse()) again.unshift(fractalNoise3(p[0], p[1], p[2], fractal, 11));
  points.forEach((_, i) => {
    if (again[i] !== out[i * 5 + 3]) throw new Error('noise3: a value depends on the order of the calls');
  });
  // Continuous across the planes of the lattice, on each axis, on both sides of zero.
  for (const c of [-3, 0, 5]) {
    for (let axis = 0; axis < 3; axis++) {
      const at = (off: number): number => {
        const p = [7.3, -2.6, 4.1];
        p[axis] = c * 10 + off;
        return valueNoise3(p[0]!, p[1]!, p[2]!, 10, 3);
      };
      if (Math.abs(at(-1e-7) - at(1e-7)) > 1e-6) throw new Error(`noise3: a step across the lattice plane ${c} of axis ${axis}`);
      out.push(at(0));
    }
  }
  // One octave is the plain noise with the octave's seed; different seeds give different fields.
  if (valueNoise3(1.5, 2.5, 3.5, 1, 1) === valueNoise3(1.5, 2.5, 3.5, 1, 2)) throw new Error('noise3: the seed has no effect');
  return Float64Array.from(out);
}

/** All cells of a level. */
function allCells(level: number): CellId[] {
  const out: CellId[] = [];
  const n = 2 ** level;
  for (let face = 0; face < 6; face++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out.push({ face, level, x, y });
  return out;
}

/** (b) The shape: quadtrees, neighbours, points, distances; and the frame of an upright object. */
export function shapeScript(): (string | number)[] {
  const out: (string | number)[] = [SHAPE.hashKey, shapeHash(SHAPE), SHAPE.edgeM(0), SHAPE.edgeM(7), SHAPE.facetDropM(0, 32)];
  if (shapeHash(new SphereWorld(RADIUS_M + 1)) === shapeHash(SHAPE) || shapeHash(new SphereWorld(RADIUS_M, [1, 0, 0])) === shapeHash(SHAPE)) throw new Error('sphere: shapes of another radius or centre share the hash');
  for (let level = 0; level <= 3; level++) {
    const n = 2 ** level;
    const cells = allCells(level);
    const keys = new Set(cells.map(cellKey));
    if (keys.size !== cells.length) throw new Error(`sphere: cells of level ${level} share keys`);
    let corners = 0;
    for (const c of cells) {
      const ring = SHAPE.neighbours(c);
      const ringKeys = new Set(ring.map(cellKey));
      const atCorner = (c.x === 0 || c.x === n - 1) && (c.y === 0 || c.y === n - 1);
      // A whole face touches four faces; a cell at a corner of the cube has one diagonal neighbour less.
      const expected = level === 0 ? 4 : atCorner ? 7 : 8;
      if (atCorner) corners++;
      if (ring.length !== expected || ringKeys.size !== expected || ringKeys.has(cellKey(c))) throw new Error(`sphere: ${cellKey(c)} has ${ring.length} neighbours, expected ${expected}`);
      for (const b of ring) {
        if (b.level !== level || !keys.has(cellKey(b))) throw new Error(`sphere: ${cellKey(c)} has the neighbour ${cellKey(b)}, which is no cell`);
        if (!SHAPE.neighbours(b).some((a) => sameCell(a, c))) throw new Error(`sphere: ${cellKey(b)} is a neighbour of ${cellKey(c)} but not the other way round`);
        // Neighbours touch: the middle of one is at most its diagonal away from the other.
        const d = SHAPE.distanceM(b, SHAPE.center(c));
        if (!(d > 0 && d < SHAPE.edgeM(level) * 1.5)) throw new Error(`sphere: the neighbour ${cellKey(b)} is ${d} m from the middle of ${cellKey(c)}`);
      }
      const mid = SHAPE.center(c);
      if (Math.abs(len(mid) - RADIUS_M) > 1e-6) throw new Error(`sphere: the middle of ${cellKey(c)} is not on the sphere`);
      if (!sameCell(SHAPE.cellAt(mid, level), c) || SHAPE.distanceM(c, mid) !== 0) throw new Error(`sphere: the middle of ${cellKey(c)} is not inside it`);
      // The same point high above and below the surface belongs to the same cell.
      if (!sameCell(SHAPE.cellAt([mid[0] * 3, mid[1] * 3, mid[2] * 3], level), c)) throw new Error(`sphere: ${cellKey(c)} does not reach above the surface`);
      const kids = SHAPE.children(c);
      if (kids.length !== 4 || kids.some((k) => !sameCell(SHAPE.parent(k)!, c) || !covers(c, k))) throw new Error(`sphere: children of ${cellKey(c)}`);
      if (level === 0 ? SHAPE.parent(c) !== null : !covers(SHAPE.parent(c)!, c)) throw new Error(`sphere: parent of ${cellKey(c)}`);
      const up = SHAPE.upAt(mid);
      const dom = SHAPE.noiseDomain(mid);
      if (Math.abs(len(up) - 1) > 1e-12 || Math.abs(dot(up, norm(mid)) - 1) > 1e-12) throw new Error(`sphere: up at ${cellKey(c)}`);
      if (Math.abs(len([dom[0]!, dom[1]!, dom[2]!]) - RADIUS_M) > 1e-6) throw new Error(`sphere: the noise domain of ${cellKey(c)} is not on the base sphere`);
      const local = SHAPE.toLocal(c, [mid[0] + 5, mid[1] - 7, mid[2] + 11]);
      const back = SHAPE.toWorld(c, local);
      if (Math.abs(back[0] - mid[0] - 5) > 1e-6 || Math.abs(back[1] - mid[1] + 7) > 1e-6 || Math.abs(back[2] - mid[2] - 11) > 1e-6) throw new Error(`sphere: local coordinates of ${cellKey(c)} do not round-trip`);
      if (level <= 2) out.push(`${cellKey(c)}>${ring.map(cellKey).join(',')}`);
    }
    if (level > 0 && corners !== 24) throw new Error(`sphere: level ${level} has ${corners} cells at corners of the cube`);
    // Cells near a point: exactly the cells a search of all of them finds.
    for (let k = 0; k < 12; k++) {
      const d = direction(0x902 + level, k);
      const h = RADIUS_M * (0.5 + 2 * unit(hashInts(0x903, level, k)));
      const p: [number, number, number] = [d[0] * h, d[1] * h, d[2] * h];
      const home = SHAPE.cellAt(p, level);
      if (cubeFaceOf(d).face !== home.face || SHAPE.distanceM(home, p) !== 0) throw new Error(`sphere: point ${k} of level ${level} is not in its cell`);
      for (const reach of [0, SHAPE.edgeM(level) * 0.7, RADIUS_M * 1.3, Infinity]) {
        const near = SHAPE.cellsNear(p, reach, level).map(cellKey).sort();
        const brute = cells.filter((c) => SHAPE.distanceM(c, p) <= reach).map(cellKey).sort();
        if (near.join(' ') !== brute.join(' ')) throw new Error(`sphere: cells within ${reach} m of point ${k} at level ${level}: ${near.length} found, ${brute.length} by search`);
        if (reach === Infinity && near.length !== cells.length) throw new Error('sphere: an unlimited reach must give every cell');
        if (reach === 0 && !near.includes(cellKey(home))) throw new Error('sphere: reach 0 must give the cell of the point');
        out.push(near.length);
      }
      // No point is farther from a cell than half the way round.
      for (const c of cells) if (!(SHAPE.distanceM(c, p) <= Math.PI * RADIUS_M + 1e-6)) throw new Error('sphere: a distance longer than half the way round');
    }
  }
  // Distance along the surface: from the middle of a face, the nearest points of the opposite face are its corners.
  const opposite = SHAPE.distanceM({ face: 1, level: 0, x: 0, y: 0 }, [RADIUS_M, 0, 0]);
  if (Math.abs(opposite - Math.acos(-1 / Math.sqrt(3)) * RADIUS_M) > 1e-3) throw new Error(`sphere: the opposite face is ${opposite} m away`);
  // Heights.
  if (Math.abs(SHAPE.altitude([0, RADIUS_M + 250, 0]) - 250) > 1e-9 || Math.abs(len(SHAPE.atHeight([3, -4, 12], 40)) - RADIUS_M - 40) > 1e-9) throw new Error('sphere: altitude and atHeight disagree with the radius');

  // The frame of an upright object: orthonormal, right-handed, y along up; at any direction, the poles included.
  const ups: V3[] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, -1], [1e-9, -1, 1e-9], norm([1, 1, 1]), norm([-0.3, -0.999, 0.02])];
  for (let k = 0; k < 30; k++) ups.push(direction(0x904, k));
  for (const up of ups) {
    const f = upFrame(radialUpAt([10, 20, 30], [10 + up[0] * 500, 20 + up[1] * 500, 30 + up[2] * 500]));
    const cross: V3 = [f.z[1] * f.x[2] - f.z[2] * f.x[1], f.z[2] * f.x[0] - f.z[0] * f.x[2], f.z[0] * f.x[1] - f.z[1] * f.x[0]];
    if (Math.abs(dot(f.y, up) - 1) > 1e-9 || Math.abs(dot(f.x, f.y)) > 1e-9 || Math.abs(dot(f.z, f.y)) > 1e-9 || Math.abs(dot(f.x, f.z)) > 1e-9 || Math.abs(len(f.x) - 1) > 1e-9 || Math.abs(len(f.z) - 1) > 1e-9 || Math.abs(dot(cross, f.y) - 1) > 1e-9) {
      throw new Error(`sphere: the frame at up ${up.join(', ')} is not orthonormal and right-handed`);
    }
    out.push(...f.x.map((v) => Math.round(v * 1e9)), ...f.z.map((v) => Math.round(v * 1e9)));
  }
  const flat = upFrame([0, 1, 0]);
  if (flat.x[0] !== 1 || flat.x[1] !== 0 || flat.x[2] !== 0 || flat.z[0] !== 0 || flat.z[1] !== 0 || flat.z[2] !== 1) throw new Error('sphere: with up along +y the frame must be the world axes');
  return out;
}

interface Surface {
  cell: CellId;
  n: number;
  bytes: Uint8Array;
  /** World position of each surface vertex (double: cell origin + stored float). */
  world: Float64Array;
  /** `a_coarseShift` of each surface vertex. */
  shift: Float32Array;
  /** Per skirt pair: grid vertex (i, j) and the depth the lower vertex hangs. */
  skirt: { i: number; j: number; drop: number }[];
}

const STRIDE = SPHERE_PATCH_LAYOUT.stride;
const surfaces = new Map<string, Surface>();

/** Decoded surface of a generated cell; checks the structure of the mesh on the way. */
function surface(c: CellId): Surface {
  const key = cellKey(c);
  const known = surfaces.get(key);
  if (known) return known;
  const content = decodeCell(encodeCell(generateSphereCell(SEED, c)));
  const m = content.meshes[0]!.mesh;
  if (m.layout.stride !== STRIDE) throw new Error(`sphere seams: ${key} has vertex stride ${m.layout.stride}`);
  const v = m.vertices as Uint8Array;
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const n = QUADS + 1;
  const total = v.byteLength / STRIDE;
  if (total !== n * n + 8 * n) throw new Error(`sphere seams: ${key} has ${total} vertices, expected a surface and a skirt`);
  const o = SHAPE.origin(c);
  const world = new Float64Array(total * 3);
  for (let k = 0; k < total; k++) for (let a = 0; a < 3; a++) world[k * 3 + a] = o[a]! + dv.getFloat32(k * STRIDE + a * 4, true);
  const shift = new Float32Array(n * n);
  const tol = 1e-3 + 1e-6 * SHAPE.edgeM(c.level);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (dv.getInt16(k * STRIDE + 18, true) !== 0) throw new Error(`sphere seams: ${key} vertex ${i}, ${j} is not a surface vertex`);
      shift[k] = dv.getFloat32(k * STRIDE + 24, true);
      // Where the grid of the face has it, at the height the content gives.
      const g = QUADS * 2 ** c.level;
      const d = cubeDirection(c.face, (2 * (c.x * QUADS + i) - g) / g, (2 * (c.y * QUADS + j) - g) / g);
      const r = RADIUS_M + surfaceHeight(SEED, d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M);
      if (Math.hypot(world[k * 3]! - d[0] * r, world[k * 3 + 1]! - d[1] * r, world[k * 3 + 2]! - d[2] * r) > tol) throw new Error(`sphere seams: ${key} vertex ${i}, ${j} is not where the grid has it`);
      const nx = dv.getInt16(k * STRIDE + 12, true);
      const ny = dv.getInt16(k * STRIDE + 14, true);
      const nz = dv.getInt16(k * STRIDE + 16, true);
      if (Math.abs(Math.hypot(nx, ny, nz) / 32767 - 1) > 1e-3 || nx * d[0] + ny * d[1] + nz * d[2] <= 0) throw new Error(`sphere seams: ${key} vertex ${i}, ${j} has a normal that is not a unit vector pointing outward`);
    }
  }
  // The skirt: pairs of the border vertex and one below it toward the centre, with the border vertex's attributes.
  const skirt: Surface['skirt'] = [];
  const sides: ((k: number) => [number, number])[] = [(k) => [k, 0], (k) => [k, QUADS], (k) => [0, k], (k) => [QUADS, k]];
  sides.forEach((vertex, s) => {
    for (let k = 0; k < n; k++) {
      const [i, j] = vertex(k);
      const src = (j * n + i) * STRIDE;
      const top = (n * n + (s * n + k) * 2) * STRIDE;
      const low = top + STRIDE;
      if (dv.getInt16(top + 18, true) !== 1 || dv.getInt16(low + 18, true) !== 1) throw new Error(`sphere seams: ${key} skirt vertex ${s}, ${k} is not marked as skirt`);
      if (!eq(v.subarray(top, top + 12), v.subarray(src, src + 12)) || !eq(v.subarray(top + 20, top + STRIDE), v.subarray(src + 20, src + STRIDE)) || !eq(v.subarray(low + 12, low + STRIDE), v.subarray(top + 12, top + STRIDE))) {
        throw new Error(`sphere seams: ${key} skirt pair ${s}, ${k} does not follow its border vertex`);
      }
      const t = (n * n + (s * n + k) * 2) * 3;
      const up: V3 = [world[t]!, world[t + 1]!, world[t + 2]!];
      const down: V3 = [world[t + 3]!, world[t + 4]!, world[t + 5]!];
      const drop = len(up) - len(down);
      // Straight toward the centre.
      const side = len([up[0] - down[0], up[1] - down[1], up[2] - down[2]]);
      if (!(drop > 0) || side - drop > tol) throw new Error(`sphere seams: ${key} skirt pair ${s}, ${k} does not hang toward the centre`);
      skirt.push({ i, j, drop });
    }
  });
  // Triangles of the surface wind anticlockwise seen from outside.
  const idx = m.indices!;
  for (let t = 0; t < QUADS * QUADS * 6; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const cc = idx[t + 2]! * 3;
    const e1: V3 = [world[b]! - world[a]!, world[b + 1]! - world[a + 1]!, world[b + 2]! - world[a + 2]!];
    const e2: V3 = [world[cc]! - world[a]!, world[cc + 1]! - world[a + 1]!, world[cc + 2]! - world[a + 2]!];
    const nrm: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (!(dot(nrm, [world[a]!, world[a + 1]!, world[a + 2]!]) > 0)) throw new Error(`sphere seams: ${key} has a triangle facing the centre`);
  }
  const s: Surface = { cell: c, n, bytes: v, world, shift, skirt };
  surfaces.set(key, s);
  return s;
}

const patchOf = (c: CellId): Parameters<typeof spherePatchRadius>[0] => ({
  radiusM: RADIUS_M,
  face: c.face,
  level: c.level,
  x: c.x,
  y: c.y,
  quads: QUADS,
  heightAt: (x, y, z) => surfaceHeight(SEED, x, y, z),
});

/** Cells the seams are tested at: corners and edges of the cube and the inside of a face, at three levels. */
function seamCells(): CellId[] {
  const out: CellId[] = [];
  for (const level of [2, 6, LEAF_LEVEL]) {
    const last = 2 ** level - 1;
    const mid = 2 ** (level - 1);
    out.push({ face: 0, level, x: 0, y: 0 }, { face: 2, level, x: last, y: mid - 1 }, { face: 5, level, x: mid, y: last }, { face: 3, level, x: last, y: last }, { face: 1, level, x: mid - 1, y: mid }, { face: 4, level, x: 0, y: mid });
  }
  return out;
}

/**
 * (c) Seams. Neighbours of one level: the vertices of the shared border are the same points and agree in every byte
 * after the position. Levels: a cell moved by its whole blend shift lies on its parent's triangles, and where its
 * border runs along a neighbour of the parent, on that neighbour's border.
 */
export function sphereSeams(): (Uint8Array | number | string)[] {
  const out: (Uint8Array | number | string)[] = [];
  const n = QUADS + 1;
  const rim: number[] = [];
  for (let k = 0; k < n; k++) rim.push(k, QUADS * n + k);
  for (let k = 1; k < QUADS; k++) rim.push(k * n, k * n + QUADS);
  let across = 0;
  let worstParent = 0;
  let worstBorder = 0;
  let moved = 0;
  let coarserChecked = 0;
  for (const A of seamCells()) {
    const a = surface(A);
    const edge = SHAPE.edgeM(A.level);
    const tol = 1e-3 + 2e-6 * edge;
    // Same level: every neighbour shares a whole side (33 vertices) or one corner.
    let sides = 0;
    for (const B of SHAPE.neighbours(A)) {
      const b = surface(B);
      let shared = 0;
      for (const ka of rim) {
        for (const kb of rim) {
          if (Math.hypot(a.world[ka * 3]! - b.world[kb * 3]!, a.world[ka * 3 + 1]! - b.world[kb * 3 + 1]!, a.world[ka * 3 + 2]! - b.world[kb * 3 + 2]!) > tol) continue;
          shared++;
          if (!eq(a.bytes.subarray(ka * STRIDE + 12, (ka + 1) * STRIDE), b.bytes.subarray(kb * STRIDE + 12, (kb + 1) * STRIDE))) {
            throw new Error(`sphere seams: ${cellKey(A)} and ${cellKey(B)} differ at a shared vertex (${ka % n}, ${Math.floor(ka / n)}) / (${kb % n}, ${Math.floor(kb / n)})`);
          }
        }
      }
      if (shared !== n && shared !== 1) throw new Error(`sphere seams: ${cellKey(A)} and ${cellKey(B)} share ${shared} vertices`);
      if (shared === n) {
        sides++;
        if (B.face !== A.face) across++;
      }
    }
    if (sides !== 4) throw new Error(`sphere seams: ${cellKey(A)} shares a side with ${sides} neighbours`);

    // Against the parent: even vertices are the parent's vertices; every vertex moved by its shift is on its triangles.
    const P = SHAPE.parent(A)!;
    const p = surface(P);
    const ox = (A.x & 1) * (QUADS / 2);
    const oy = (A.y & 1) * (QUADS / 2);
    const parentPatch = patchOf(P);
    const ptol = 1e-3 + 2e-6 * SHAPE.edgeM(P.level);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const w: V3 = [a.world[k * 3]!, a.world[k * 3 + 1]!, a.world[k * 3 + 2]!];
        const r = len(w);
        if (i % 2 === 0 && j % 2 === 0) {
          const pk = (oy + j / 2) * n + ox + i / 2;
          if (a.shift[k] !== 0 || Math.hypot(w[0] - p.world[pk * 3]!, w[1] - p.world[pk * 3 + 1]!, w[2] - p.world[pk * 3 + 2]!) > ptol) throw new Error(`sphere seams: ${cellKey(A)} vertex ${i}, ${j} is not the parent's vertex`);
          // The blend target carries the parent's own normal and colour.
          if (!eq(a.bytes.subarray(k * STRIDE + 28, k * STRIDE + 34), p.bytes.subarray(pk * STRIDE + 12, pk * STRIDE + 18)) || !eq(a.bytes.subarray(k * STRIDE + 36, k * STRIDE + 40), p.bytes.subarray(pk * STRIDE + 20, pk * STRIDE + 24))) {
            throw new Error(`sphere seams: ${cellKey(A)} vertex ${i}, ${j} does not carry the normal and colour of ${cellKey(P)}`);
          }
          continue;
        }
        const target = spherePatchRadius(parentPatch, norm(w), 1);
        const miss = Math.abs(r + a.shift[k]! - target);
        if (miss > worstParent) worstParent = miss;
        if (!(miss <= ptol)) throw new Error(`sphere seams: ${cellKey(A)} vertex ${i}, ${j} blended fully is ${miss} m off the surface of ${cellKey(P)}`);
        if (Math.abs(a.shift[k]!) > moved) moved = Math.abs(a.shift[k]!);
      }
    }
    // Against the neighbours of the parent (the coarser cells this cell can lie next to), across the cube as well.
    for (const C of SHAPE.neighbours(P)) {
      const coarsePatch = patchOf(C);
      for (const k of rim) {
        const w: V3 = [a.world[k * 3]!, a.world[k * 3 + 1]!, a.world[k * 3 + 2]!];
        if (SHAPE.distanceM(C, w) > 1e-9 * RADIUS_M) continue;
        const miss = Math.abs(len(w) + a.shift[k]! - spherePatchRadius(coarsePatch, norm(w), 1));
        if (miss > worstBorder) worstBorder = miss;
        if (!(miss <= ptol)) throw new Error(`sphere seams: the border of ${cellKey(A)} blended fully is ${miss} m off the border of ${cellKey(C)}`);
        coarserChecked++;
      }
    }
    // The skirt covers twice the step the border can show against another level.
    for (const s of a.skirt) {
      const sh = Math.abs(a.shift[s.j * n + s.i]!);
      if (s.drop < 2 * sh - tol) throw new Error(`sphere seams: the skirt of ${cellKey(A)} hangs ${s.drop} m where the border moves ${sh} m`);
    }
    out.push(a.bytes);
  }
  if (across < 12) throw new Error(`sphere seams: only ${across} seams across an edge of the cube were tested`);
  if (!(moved > 0) || coarserChecked < 200) throw new Error(`sphere seams: nothing was tested between levels (largest shift ${moved}, ${coarserChecked} border vertices against coarser cells)`);
  out.push(across, coarserChecked, worstParent < 0.01 ? 'parent ok' : 'parent off', worstBorder < 0.01 ? 'border ok' : 'border off');
  return out;
}

/** (d) Cells of the generator: bytes independent of order, format, and instances owned by one cell per level. */
export function sphereCells(): (Uint8Array | number | string)[] {
  const out: (Uint8Array | number | string)[] = [];
  const shape = shapeHash(SHAPE);
  const version = (b: Uint8Array): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(4, true);
  for (const c of [{ face: 0, level: 0, x: 0, y: 0 }, { face: 3, level: 4, x: 15, y: 0 }, { face: 4, level: LEAF_LEVEL, x: 700, y: 2047 }]) {
    const alone = new GeneratorCellProvider(SEED, generateSphereCell).bytes(c);
    const ring = SHAPE.neighbours(c);
    for (const order of [ring, [...ring].reverse(), [{ face: (c.face + 3) % 6, level: 3, x: 1, y: 6 }, ...SHAPE.children(c)]]) {
      const p = new GeneratorCellProvider(SEED, generateSphereCell);
      for (const o of order) p.bytes(o);
      if (!eq(p.bytes(c), alone)) throw new Error(`sphere cells: cell ${cellKey(c)} differs after generating ${order.length} other cells first`);
    }
    if (version(alone) !== CELL_FORMAT_VERSION_SHAPED) throw new Error(`sphere cells: ${cellKey(c)} is written in format ${version(alone)}`);
    const back = decodeCell(alone);
    if (!sameCell(back.cell, c)) throw new Error(`sphere cells: ${cellKey(c)} comes back as ${cellKey(back.cell)}`);
    if (back.shapeHash !== shape) throw new Error(`sphere cells: ${cellKey(c)} states shape ${back.shapeHash}, expected ${shape}`);
    if (back.error === undefined || !(back.error > 0)) throw new Error(`sphere cells: ${cellKey(c)} states no error`);
    if (!eq(encodeCell(back), alone)) throw new Error(`sphere cells: ${cellKey(c)} does not round-trip`);
    out.push(alone);
  }
  // The error of a level is about a quarter of the level above it (the bulge of the sphere alone guarantees one).
  const e0 = generateSphereCell(SEED, { face: 2, level: 0, x: 0, y: 0 }).error!;
  const e1 = generateSphereCell(SEED, { face: 2, level: 1, x: 1, y: 1 }).error!;
  if (!(e0 > e1 && e1 > 0)) throw new Error(`sphere cells: the error does not fall with the level (${e0}, ${e1})`);

  // Instances: find cells that hold some, then check ownership between the levels.
  const first = RULES.reduce((m, r) => Math.max(m, r.minLevel), 0);
  let found = 0;
  let instances = 0;
  for (let k = 0; k < 400 && found < 3; k++) {
    const d = direction(0x905, k);
    const c = SHAPE.cellAt([d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M], first);
    const content = generateSphereCell(SEED, c);
    if (content.instances.length < RULES.length && !(content.instances.length > 0 && found === 2)) continue;
    found++;
    const o = SHAPE.origin(c);
    const kids = SHAPE.children(c).map((kid) => ({ kid, content: generateSphereCell(SEED, kid) }));
    for (const set of content.instances) {
      const f = set.data.data as Float32Array;
      const stride = set.data.layout.stride / 4;
      const ids = set.ids!;
      const count = f.length / stride;
      if (ids.length !== count * 2) throw new Error(`sphere cells: ${cellKey(c)} has ${count} instances of ${set.archetype} and ${ids.length} id words`);
      const childIds = new Map<string, number>();
      kids.forEach(({ content: kc }, q) => {
        const ks = kc.instances.find((s) => s.archetype === set.archetype);
        if (!ks) return;
        for (let t = 0; t < ks.ids!.length; t += 2) {
          const id = `${ks.ids![t]}:${ks.ids![t + 1]}`;
          if (childIds.has(id)) throw new Error(`sphere cells: instance ${id} is in two children of ${cellKey(c)}`);
          childIds.set(id, q);
        }
      });
      if (childIds.size !== count) throw new Error(`sphere cells: ${cellKey(c)} has ${count} instances of ${set.archetype}, its children ${childIds.size}`);
      for (let t = 0; t < count; t++) {
        const base: V3 = [o[0] + f[t * stride]!, o[1] + f[t * stride + 1]!, o[2] + f[t * stride + 2]!];
        const id = `${ids[t * 2]}:${ids[t * 2 + 1]}`;
        if (SHAPE.distanceM(c, base) !== 0) throw new Error(`sphere cells: instance ${id} of ${cellKey(c)} stands outside the cell`);
        const q = childIds.get(id);
        if (q === undefined || SHAPE.distanceM(kids[q]!.kid, base) > 1e-6) throw new Error(`sphere cells: instance ${id} of ${cellKey(c)} is not in the child it stands in`);
        // On the surface: at most a few metres under the ground (it is sunk a little and stands on the triangles).
        const h = SHAPE.altitude(base) - surfaceHeight(SEED, ...scaled(base));
        if (!(h <= 1e-3 && h > -60)) throw new Error(`sphere cells: instance ${id} of ${cellKey(c)} stands ${h} m above the ground`);
        // Inside the stated bounds with its whole reach.
        for (let a = 0; a < 3; a++) {
          if (f[t * stride + a]! - f[t * stride + 3]! < content.bounds.min[a]! || f[t * stride + a]! + f[t * stride + 3]! > content.bounds.max[a]!) throw new Error(`sphere cells: instance ${id} of ${cellKey(c)} reaches out of the bounds`);
        }
        instances++;
      }
    }
    out.push(cellKey(c), encodeCell(content));
  }
  if (found < 3 || instances < 10) throw new Error(`sphere cells: found ${found} cells with ${instances} instances`);
  out.push(instances);
  return out;
}

/** The point of the base sphere under a point, as the generator's functions take it. */
function scaled(p: V3): [number, number, number] {
  const d = norm(p);
  return [d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M];
}

/**
 * (e) The horizon test against straight lines of sight: whatever it hides is behind the hiding sphere for every point
 * of the tested shell; and it does hide the far side.
 */
export function horizonSamples(): number[] {
  const occluder = RADIUS_M - 50;
  let hidden = 0;
  let visible = 0;
  const out: number[] = [];
  for (let k = 0; k < 4000; k++) {
    const u = (q: number): number => unit(hashInts(0x906, k, q));
    const e = direction(0x907, k);
    const eyeR = RADIUS_M + 2 + 10 ** (u(1) * 5.5);
    const eye: V3 = [e[0] * eyeR, e[1] * eyeR, e[2] * eyeR];
    // A point of the surface or above it, up to 3 km.
    const d = direction(0x908, k);
    const pr = RADIUS_M + (u(2) < 0.3 ? 0 : 3000 * u(3));
    // Half of the points close to the viewer, where the horizon runs.
    const near = u(4) < 0.5 ? norm([e[0] + d[0] * u(5) * 0.6, e[1] + d[1] * u(5) * 0.6, e[2] + d[2] * u(5) * 0.6]) : d;
    const p: V3 = [near[0] * pr, near[1] * pr, near[2] * pr];
    const seg: V3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const dist = len(seg);
    // Closest approach of the line of sight to the centre.
    const t = Math.min(1, Math.max(0, -dot(eye, seg) / (dist * dist)));
    const closest = len([eye[0] + seg[0] * t, eye[1] + seg[1] * t, eye[2] + seg[2] * t]);
    const h = horizonHidden(eye, occluder, dist, pr);
    if (h && closest >= occluder) throw new Error(`horizon: sample ${k} is hidden although its line of sight clears the sphere by ${closest - occluder} m`);
    // The other way round it may keep a little too much, never by more than a rounding.
    if (!h && closest < occluder - 1e-3 && t > 0 && t < 1 && dot(p, seg) > 0) throw new Error(`horizon: sample ${k} is kept although the sphere hides it (${occluder - closest} m)`);
    if (h) hidden++;
    else visible++;
    if (k < 64) out.push(h ? 1 : 0);
  }
  if (hidden < 500 || visible < 500) throw new Error(`horizon: the samples do not exercise both answers (${hidden} hidden, ${visible} visible)`);
  // A viewer inside the hiding sphere hides nothing; the far radius of a box is that of its farthest corner.
  if (horizonHidden([0, occluder - 10, 0], occluder, 5 * RADIUS_M, RADIUS_M)) throw new Error('horizon: a viewer under the hiding sphere must see everything');
  const far = boxMaxRadius([-10, 20, -30], [40, 60, 5], [0, -100, 0]);
  if (Math.abs(far - Math.hypot(40, 160, 30)) > 1e-9) throw new Error(`horizon: the far radius of a box is ${far}`);
  out.push(hidden, visible);
  return out;
}

/**
 * (f) Coverage on the sphere. The viewer starts 300 km above an edge of the cube, comes down to 30 m, moves across
 * the edge along the surface and climbs back. A fake executor finishes a fixed number of jobs per step. Checked at
 * every step: no drawn cell covers another, a face once covered stays covered exactly (no hole, nothing twice), no
 * request below a cell that is not loaded, the budgets hold. At the end all six faces are covered.
 */
export function sphereCoverage(): string[] {
  const budget = 260;
  const config: StreamingConfig = { ...DEFAULT_STREAMING, shape: SHAPE, rootLevel: ROOT_LEVEL, leafLevel: LEAF_LEVEL, rootRange: Infinity, prefetch: 0.2, hysteresis: 0.3, maxInFlight: 8, memoryBudgetBytes: 1e9, screenError: { ...SELECTION, maxCells: budget } };
  const m = new StreamingManager(config);
  const error = (c: CellId): number => {
    const u = unit(hashInts(SEED, 0x5e1ec7, c.face, c.level, c.x, c.y));
    return SHAPE.edgeM(c.level) * SELECTION.errorPerEdge * (0.4 + 1.1 * u);
  };
  const queue: { req: CellRequest; due: number }[] = [];
  const trace: string[] = [];
  let covered = new Set<string>();
  let finest = ROOT_LEVEL;
  let lowestDetail = 1;
  let facesSeen = 0;
  const steps = 520;
  for (let s = 0; s < steps; s++) {
    const down = Math.min(1, s / 170);
    const up = Math.min(1, Math.max(0, (s - 330) / 110));
    const altitude = 300_000 * (30 / 300_000) ** down * (300_000 / 30) ** up;
    // On the edge between the faces +x and +y, then across it: the direction turns about z.
    const turn = 0.012 * Math.min(1, Math.max(0, (s - 180) / 120)) - 0.004;
    const dir = norm([1 + turn, 1 - turn, 0.31]);
    const r = RADIUS_M + altitude;
    const tickets: Ticket[] = [{ id: 'camera', kind: 'camera', center: [dir[0] * r, dir[1] * r, dir[2] * r], altitude, base: 0, dir: norm([1, -1, 0]) }];
    const a = m.update(tickets);
    for (const c of a.cancels) {
      const i = queue.findIndex((j) => j.req.key === c.key && j.req.epoch === c.epoch);
      if (i >= 0) queue.splice(i, 1);
    }
    for (const req of a.requests) {
      if (req.cell.level > ROOT_LEVEL) {
        const ps = m.state(SHAPE.parent(req.cell)!);
        if (ps !== 'MESHED' && ps !== 'RESIDENT') throw new Error(`sphere coverage: step ${s} requests ${req.key} while its parent is ${ps}`);
      }
      queue.push({ req, due: s + 2 });
    }
    for (const c of a.uploads.slice(0, 4)) m.resident(c, 20_000);
    let done = 0;
    for (let i = 0; i < queue.length && done < 5; ) {
      if (queue[i]!.due > s) {
        i++;
        continue;
      }
      const { req } = queue.splice(i, 1)[0]!;
      m.complete(req, 30_000, error(req.cell));
      done++;
    }
    const c = m.counters();
    if (c.wanted > budget) throw new Error(`sphere coverage: step ${s} wants ${c.wanted} cells, the budget is ${budget}`);
    if (c.inFlight > config.maxInFlight) throw new Error(`sphere coverage: step ${s} has ${c.inFlight} jobs in flight`);
    if (c.detail < lowestDetail) lowestDetail = c.detail;
    const drawn = m.drawn();
    for (let i = 0; i < drawn.length; i++) {
      for (let j = 0; j < drawn.length; j++) {
        if (i !== j && covers(drawn[i]!, drawn[j]!)) throw new Error(`sphere coverage: step ${s} draws ${cellKey(drawn[i]!)} and ${cellKey(drawn[j]!)} on top of each other`);
      }
    }
    const roots = m.wanted().filter((w) => w.level === ROOT_LEVEL);
    if (roots.length !== 6) throw new Error(`sphere coverage: step ${s} wants ${roots.length} faces of the cube`);
    // Share of each face that is drawn, in units of the finest level (exact in doubles).
    const now = new Set<string>();
    for (const root of roots) {
      let share = 0;
      for (const d of drawn) if (covers(root, d)) share += 4 ** (LEAF_LEVEL - d.level);
      const key = cellKey(root);
      if (share === 4 ** LEAF_LEVEL) now.add(key);
      else if (share !== 0) throw new Error(`sphere coverage: step ${s} covers ${share / 4 ** LEAF_LEVEL} of face ${key}`);
      else if (covered.has(key)) throw new Error(`sphere coverage: step ${s} lost the cover of face ${key}`);
    }
    covered = now;
    if (covered.size > facesSeen) facesSeen = covered.size;
    for (const d of drawn) if (d.level > finest) finest = d.level;
    trace.push(`${s}|${drawn.map(cellKey).join(';')}|${c.holes}|${c.settled}|${c.detail}`);
  }
  const c = m.counters();
  if (!c.settled || c.holes !== 0 || covered.size !== 6) throw new Error(`sphere coverage: not settled at the end (holes ${c.holes}, wanted ${c.wanted}, drawn ${c.drawn}, faces covered ${covered.size})`);
  if (finest !== LEAF_LEVEL) throw new Error(`sphere coverage: the descent reached level ${finest} only, expected ${LEAF_LEVEL}`);
  const { requested, completed, cancelled, stale, failed, evicted } = c;
  return [...m.log, ...trace, JSON.stringify({ requested, completed, cancelled, stale, failed, evicted, lowestDetail, facesSeen })];
}
