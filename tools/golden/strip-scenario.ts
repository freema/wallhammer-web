// Golden scenarios of the strips of the examples (examples/planet/src/strips.ts, examples/endless/src/strips.ts). Each
// check throws on a violation; the returned values go into the golden hash.
//   - planet: the main line is 50 km long within 250 m, changes face between km 5 and km 45, its node holds three
//     lines; the strip mesh along all lines at levels 0, 4 and 8 and near the edge and the node at levels 10–11:
//     (a) lengths add up, (b) shared sections agree, (c) a child at blend 1 follows its parent, (d) nothing under the
//     ground; `sphereStripSurface` agrees with the shape; whole cells: order-independent bytes, round trip;
//   - endless: the same at levels 6 and 9, and off the strips the cell of `generateStripCell` differs from the one of
//     `generateSmoothCell` in the domain version only.
// The mesh checks are those of the engine's own recipe (tools/golden/engine/strip-scenario.ts in this repository), run
// on the nets of the examples.

import { STRIP_STATION_FLOATS, cellKey, cubeFaceOf, stripLength, stripUp } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import type { CellContent, CellId, StripNet, StripSurface } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { STRIP_LAYOUT, stripMesh } from '../../packages/wallhammer-web/src/gen-mesh/index.ts';
import type { StripMesh } from '../../packages/wallhammer-web/src/gen-mesh/index.ts';
import { decodeCell, encodeCell } from '../../packages/wallhammer-web/src/world/index.ts';
import { DEFAULT_SEED, SHAPE as PLANET_SHAPE } from '../../examples/planet/src/world.ts';
import { STRIP_LENGTHS, generatePlanetStripCell, planetStripSurface, planetStrips, stripLiftM as planetLift } from '../../examples/planet/src/strips.ts';
import { SHAPE as FLAT_SHAPE, generateSmoothCell } from '../../examples/endless/src/terrain.ts';
import { endlessStripSurface, endlessStrips, generateStripCell, stripLiftM as endlessLift } from '../../examples/endless/src/strips.ts';

type V3 = [number, number, number];
const F = STRIP_STATION_FLOATS;
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const dist = (a: readonly number[], b: readonly number[]): number => Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
const unit3 = (x: number, y: number, z: number): V3 => {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
};

/** Point of the centre of piece k of a line at share t (the straight way between its stations). */
function centreAt(net: StripNet, line: number, k: number, t: number): V3 {
  const st = net.lines[line]!.stations;
  const s0 = k * F;
  const s1 = s0 + F;
  const x = st[s0]! + (st[s1]! - st[s0]!) * t;
  const y = st[s0 + 1]! + (st[s1 + 1]! - st[s0 + 1]!) * t;
  const z = st[s0 + 2]! + (st[s1 + 2]! - st[s0 + 2]!) * t;
  if (net.radiusM === 0) return [x, 0, z];
  const d = unit3(x, y, z);
  return [d[0] * net.radiusM, d[1] * net.radiusM, d[2] * net.radiusM];
}

/** Grade plus camber of a line at metres along it, at across `a`. */
function designAt(net: StripNet, line: number, along: number, a: number): number {
  const l = net.lines[line]!;
  const st = l.stations;
  let k = 0;
  while (k + 2 < l.count && st[(k + 1) * F + 11]! < along) k++;
  const s0 = k * F;
  const s1 = s0 + F;
  const t = Math.min(1, Math.max(0, (along - st[s0 + 11]!) / (st[s1 + 11]! - st[s0 + 11]!)));
  return st[s0 + 9]! + (st[s1 + 9]! - st[s0 + 9]!) * t + (st[s0 + 10]! + (st[s1 + 10]! - st[s0 + 10]!) * t) * stripUp(net.profiles[l.profile]!, a);
}

interface Section {
  cell: string;
  line: number;
  along: number;
  p0: V3[];
  p1: V3[];
  side: V3[];
  strip: number[][];
  base: V3[];
  /**
   * What the vertex may be off by: 1 mm, or three float32 steps of its numbers relative to the cell origin where they
   * are coarser (a cell of level 0 on a sphere 100 km in radius holds positions up to 70 km from its origin, whose
   * float32 step is 7.8 mm).
   */
  tol: number[];
  links: number;
}

/** True when two sections stand at one point of the line (their middle vertices within what they may be off by). */
function sameShare(x: Section, y: Section): boolean {
  const m = x.base.length >> 1;
  return dist(x.base[m]!, y.base[m]!) <= Math.max(x.tol[m]!, y.tol[m]!);
}

/** Spacing of float32 values around |v|. */
function ulp32(v: number): number {
  const a = Math.abs(v);
  if (a === 0) return 0;
  return 2 ** (Math.floor(Math.log2(a)) - 23);
}

/** Splits a strip mesh into its sections (world positions at blend 0 and 1). */
function sectionsOf(net: StripNet, surface: StripSurface, cell: CellId, m: StripMesh): Section[] {
  const R = net.radiusM;
  const o = surface.origin(cell);
  const f = new DataView(m.mesh.vertices.buffer, m.mesh.vertices.byteOffset, m.mesh.vertices.byteLength);
  const stride = STRIP_LAYOUT.stride;
  const count = m.mesh.vertices.byteLength / stride;
  const sections: Section[] = [];
  const vertexSection: number[] = [];
  let v = 0;
  while (v < count) {
    const line = Math.round(f.getFloat32(v * stride + 40, true));
    const n = net.profiles[net.lines[line]!.profile]!.section.length / 2;
    const s: Section = { cell: cellKey(cell), line, along: f.getFloat32(v * stride + 32, true), p0: [], p1: [], side: [], strip: [], base: [], tol: [], links: 0 };
    for (let k = 0; k < n; k++, v++) {
      const g = (i: number): number => f.getFloat32(v * stride + i * 4, true);
      const p0: V3 = [g(0) + o[0], g(1) + o[1], g(2) + o[2]];
      const up: V3 = R > 0 ? unit3(p0[0], p0[1], p0[2]) : [0, 1, 0];
      s.p0.push(p0);
      s.p1.push([p0[0] + up[0] * g(3), p0[1] + up[1] * g(3), p0[2] + up[2] * g(3)]);
      s.side.push([g(4), g(5), g(6)]);
      s.strip.push([g(7), g(8), g(9), g(10)]);
      s.base.push(R > 0 ? [up[0] * R, up[1] * R, up[2] * R] : [p0[0], 0, p0[2]]);
      s.tol.push(Math.max(1e-3, 3 * Math.max(ulp32(g(0)), ulp32(g(1)), ulp32(g(2)), ulp32(g(3)))));
      vertexSection.push(sections.length);
    }
    sections.push(s);
  }
  const idx = m.mesh.indices!;
  const linked = new Set<string>();
  for (let i = 0; i < m.mesh.count; i += 3) {
    const a = vertexSection[idx[i]!]!;
    for (const b of [vertexSection[idx[i + 1]!]!, vertexSection[idx[i + 2]!]!]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (a === b || linked.has(key)) continue;
      linked.add(key);
      sections[a]!.links++;
      sections[b]!.links++;
    }
  }
  return sections;
}

interface MeshCheck {
  net: StripNet;
  surface: StripSurface;
  /** Neighbouring levels, coarse first. */
  levels: readonly [number, number];
  coarsestLevel: number;
  liftM: (level: number) => number;
  neighbours: (c: CellId) => CellId[];
  /** Only the cells of the lines within these balls (none: every cell the lines pass). */
  near?: { point: V3; radiusM: number }[];
  name: string;
}

/**
 * (a) per level the lengths of all cells add up to the line (when every cell is taken); (b) sections of neighbouring
 * cells at one share agree within 1 mm with equal `a_side` and `a_strip`, and a cell's part of a line never ends
 * without a neighbour going on; (c) the child at blend 1 follows the height rule at the parent's level and meets the
 * parent's own sections; (d) no vertex with |a| ≤ 1 under the drawn ground plus the lift at blend 0 or 1; the bytes do
 * not depend on the order of generation.
 */
function checkMeshes(c: MeshCheck): unknown[] {
  const { net, surface } = c;
  const R = net.radiusM;
  const out: unknown[] = [c.name];
  const per = new Map<number, { cells: CellId[]; meshes: (StripMesh | null)[]; sections: Section[] }>();
  for (const level of c.levels) {
    const core = new Map<string, CellId>();
    const found = new Map<string, CellId>();
    const step = surface.spacingM(level) / 4;
    for (let li = 0; li < net.lineCount; li++) {
      const l = net.lines[li]!;
      for (let k = 0; k + 1 < l.count; k++) {
        const a = centreAt(net, li, k, 0);
        const b = centreAt(net, li, k, 1);
        const n = Math.max(2, Math.ceil(dist(a, b) / step));
        for (let i = 0; i <= n; i++) {
          const p = centreAt(net, li, k, i / n);
          if (c.near && !c.near.some((b) => dist(b.point, p) <= b.radiusM)) continue;
          const cell = surface.cellAt(level, p);
          core.set(cellKey(cell), cell);
          for (const x of [cell, ...c.neighbours(cell)]) found.set(cellKey(x), x);
        }
      }
    }
    const cells = [...found.keys()].sort().map((k) => found.get(k)!);
    const opts = { coarsestLevel: c.coarsestLevel, liftM: c.liftM };
    const meshes = cells.map((cell) => stripMesh(net, surface, cell, opts));
    const reversed = [...cells].reverse().map((cell) => stripMesh(net, surface, cell, opts)).reverse();
    meshes.forEach((m, i) => {
      const r = reversed[i];
      if (m === null ? r !== null : r === null || r === undefined || !eq(m.mesh.vertices, r.mesh.vertices)) throw new Error(`${c.name}: cell ${cellKey(cells[i]!)} differs with the order of generation`);
    });
    // (a)
    if (!c.near) {
      for (let li = 0; li < net.lineCount; li++) {
        let sum = 0;
        for (const m of meshes) if (m) sum += m.lengthM[li]!;
        const want = stripLength(net, li);
        if (Math.abs(sum - want) > 1e-9 * want) throw new Error(`${c.name}: level ${level} holds ${sum} m of line ${li}, the line is ${want} m`);
        out.push(Math.round(sum * 1e3));
      }
    }
    const sections = meshes.flatMap((m, i) => (m ? sectionsOf(net, surface, cells[i]!, m) : []));
    per.set(level, { cells, meshes, sections });
    // (b)
    const byKey = new Map<string, Section[]>();
    for (const s of sections) byKey.set(`${s.line}:${s.along}`, [...(byKey.get(`${s.line}:${s.along}`) ?? []), s]);
    let shared = 0;
    for (const list of byKey.values()) {
      for (let i = 1; i < list.length; i++) {
        const x = list[0]!;
        const y = list[i]!;
        // Metres along are float32: two shares a few millimetres apart far along a line can carry the same value.
        if (!sameShare(x, y)) continue;
        if (x.cell === y.cell) throw new Error(`${c.name}: cell ${x.cell} holds two sections at one share`);
        shared++;
        for (let v = 0; v < x.p0.length; v++) {
          const tol = Math.max(x.tol[v]!, y.tol[v]!);
          if (dist(x.p0[v]!, y.p0[v]!) > tol || dist(x.p1[v]!, y.p1[v]!) > tol) throw new Error(`${c.name}: cells ${x.cell} and ${y.cell} disagree at line ${x.line}, ${x.along} m by ${dist(x.p0[v]!, y.p0[v]!)} m`);
          if (x.side[v]!.some((q, k) => q !== y.side[v]![k]) || x.strip[v]!.some((q, k) => q !== y.strip[v]![k])) throw new Error(`${c.name}: cells ${x.cell} and ${y.cell} disagree on a_side or a_strip at line ${x.line}, ${x.along} m`);
        }
      }
    }
    for (const s of sections) {
      if (s.links >= 2 || !core.has(s.cell)) continue;
      if (Math.abs(s.along) < 1e-3 || Math.abs(s.along - stripLength(net, s.line)) < 1e-2) continue;
      if ((byKey.get(`${s.line}:${s.along}`) ?? []).length < 2) throw new Error(`${c.name}: level ${level}: line ${s.line} stops at ${s.along} m in cell ${s.cell} with no neighbour going on`);
    }
    out.push(cells.length, sections.length, shared);
    // (d)
    const heightOf = (p: V3): number => (R > 0 ? Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) - R : p[1]);
    for (const s of sections) {
      for (let v = 0; v < s.p0.length; v++) {
        if (Math.abs(s.strip[v]![0]!) > 1) continue;
        if (heightOf(s.p0[v]!) < surface.heightOn(level, s.base[v]!) + c.liftM(level) - s.tol[v]!) throw new Error(`${c.name}: level ${level}: a vertex of line ${s.line} at ${s.along} m lies under the ground`);
        if (level > c.coarsestLevel && heightOf(s.p1[v]!) < surface.heightOn(level - 1, s.base[v]!) + c.liftM(level - 1) - s.tol[v]!) throw new Error(`${c.name}: level ${level}: a vertex of line ${s.line} at ${s.along} m lies under the coarser ground at blend 1`);
      }
    }
  }
  // (c)
  const [coarseL, fineL] = c.levels;
  const parentByKey = new Map<string, Section>();
  for (const s of per.get(coarseL)!.sections) parentByKey.set(`${s.line}:${s.along}`, s);
  let matched = 0;
  const heightOf = (p: V3): number => (R > 0 ? Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) - R : p[1]);
  for (const s of per.get(fineL)!.sections) {
    const sec = net.profiles[net.lines[s.line]!.profile]!.section;
    const rule = (level: number): number[] => {
      const h: number[] = [];
      for (let v = 0; v < s.p0.length; v++) if (Math.abs(sec[v * 2]!) <= 1) h[v] = Math.max(designAt(net, s.line, s.along, sec[v * 2]!), surface.heightOn(level, s.base[v]!) + c.liftM(level));
      for (let v = 0; v < s.p0.length; v++) {
        const a = sec[v * 2]!;
        if (Math.abs(a) <= 1) continue;
        let e = 0;
        for (let k = 0; k < sec.length; k += 2) if (sec[k] === (a < 0 ? -1 : 1) && (a > 0 || e === 0)) e = k / 2;
        h[v] = h[e]! + sec[v * 2 + 1]! - sec[e * 2 + 1]!;
      }
      return h;
    };
    const own = rule(fineL);
    const coarse = rule(coarseL);
    for (let v = 0; v < s.p0.length; v++) {
      if (Math.abs(heightOf(s.p0[v]!) - own[v]!) > s.tol[v]!) throw new Error(`${c.name}: level ${fineL}: line ${s.line} at ${s.along} m: vertex ${v} at ${heightOf(s.p0[v]!)} m, the rule gives ${own[v]} m`);
      if (Math.abs(heightOf(s.p1[v]!) - coarse[v]!) > s.tol[v]!) throw new Error(`${c.name}: level ${fineL}: line ${s.line} at ${s.along} m: vertex ${v} at blend 1 at ${heightOf(s.p1[v]!)} m, the parent's rule gives ${coarse[v]} m`);
    }
    const p = parentByKey.get(`${s.line}:${s.along}`);
    if (!p || !sameShare(s, p)) continue;
    matched++;
    for (let v = 0; v < s.p0.length; v++) if (dist(s.p1[v]!, p.p0[v]!) > Math.max(s.tol[v]!, p.tol[v]!)) throw new Error(`${c.name}: line ${s.line} at ${s.along} m: the child at blend 1 misses the parent by ${dist(s.p1[v]!, p.p0[v]!)} m`);
  }
  if (matched === 0) throw new Error(`${c.name}: no section shared by the two levels`);
  out.push(matched);
  for (const level of c.levels) {
    const e = per.get(level)!;
    e.meshes.forEach((m, i) => void (m && out.push(cellKey(e.cells[i]!), m.mesh.vertices, m.mesh.indices, m.bounds.min, m.bounds.max)));
  }
  return out;
}

/** Whole cells: the same bytes alone and after the others in reverse order, and a round trip through the cell format. */
function wholeCells(name: string, cells: CellId[], gen: (c: CellId) => CellContent): unknown[] {
  const out: unknown[] = [];
  const alone = cells.map((c) => encodeCell(gen(c)));
  const reversed = [...cells].reverse().map((c) => encodeCell(gen(c))).reverse();
  cells.forEach((c, i) => {
    if (!eq(alone[i]!, reversed[i]!)) throw new Error(`${name}: cell ${cellKey(c)} differs with the order of generation`);
    if (!eq(encodeCell(decodeCell(alone[i]!)), alone[i]!)) throw new Error(`${name}: cell ${cellKey(c)} does not survive a round trip through the cell format`);
    const content = gen(c);
    if (!content.meshes.some((m) => m.material === 'strip')) throw new Error(`${name}: cell ${cellKey(c)} has no strip mesh`);
    out.push(cellKey(c), alone[i]!);
  });
  return out;
}

// --- Recipe 4: the planet -------------------------------------------------------------------------------------------

export function planetStripScript(): unknown[] {
  const seed = DEFAULT_SEED;
  const net = planetStrips(seed);
  const surface = planetStripSurface(seed);
  const liftM = (level: number): number => planetLift(surface, level);
  const out: unknown[] = [];
  const length = stripLength(net, 0);
  if (Math.abs(length - STRIP_LENGTHS[0]) > 250) throw new Error(`planet strips: the main line is ${length} m long`);
  // Faces along the main line: one change, between km 5 and km 45.
  const l0 = net.lines[0]!;
  const changes: number[] = [];
  let face = cubeFaceOf(unit3(l0.stations[0]!, l0.stations[1]!, l0.stations[2]!)).face;
  const faces = [face];
  for (let k = 1; k < l0.count; k++) {
    const f = cubeFaceOf(unit3(l0.stations[k * F]!, l0.stations[k * F + 1]!, l0.stations[k * F + 2]!)).face;
    if (f !== face) (changes.push(l0.stations[k * F + 11]!), faces.push(f), (face = f));
  }
  if (changes.length !== 1 || changes[0]! < 5000 || changes[0]! > 45_000) throw new Error(`planet strips: the main line changes face at ${changes.join(', ')} m`);
  // The node: the main line ends there, two lines start there.
  const node = centreAt(net, 0, l0.count - 2, 1);
  let atNode = 0;
  for (let li = 0; li < net.lineCount; li++) {
    const l = net.lines[li]!;
    for (const k of [0, l.count - 1]) if (dist(centreAt(net, li, Math.max(0, Math.min(l.count - 2, k)), k === 0 ? 0 : 1), node) < 1e-6) atNode++;
  }
  if (atNode !== 3) throw new Error(`planet strips: the node holds ${atNode} lines`);
  out.push(Math.round(length * 1e3), faces, Math.round(changes[0]!), net.lineCount, [1, 2].map((l) => Math.round(stripLength(net, l) * 1e3)));
  // The edge crossing: the station where the face changes.
  let ke = 1;
  while (ke < l0.count && l0.stations[ke * F + 11]! < changes[0]!) ke++;
  const edge = centreAt(net, 0, ke - 1, 0.5);
  // The surface agrees with the shape on cells and origins, along all lines.
  for (const level of [0, 4, 8, 11]) {
    for (let li = 0; li < net.lineCount; li++) {
      const l = net.lines[li]!;
      for (let k = 0; k < l.count - 1; k += 3) {
        const p = centreAt(net, li, k, 0.37);
        const a = surface.cellAt(level, p);
        const b = PLANET_SHAPE.cellAt(p, level);
        if (cellKey(a) !== cellKey(b)) throw new Error(`planet strips: cellAt ${cellKey(a)} ≠ ${cellKey(b)}`);
        const oa = surface.origin(a);
        const ob = PLANET_SHAPE.origin(b);
        if (oa[0] !== ob[0] || oa[1] !== ob[1] || oa[2] !== ob[2]) throw new Error(`planet strips: origin of ${cellKey(a)} differs from the shape's`);
      }
    }
  }
  const neighbours = (c: CellId): CellId[] => PLANET_SHAPE.neighbours(c);
  const near = [
    { point: edge, radiusM: 1000 },
    { point: node, radiusM: 1000 },
  ];
  out.push(
    checkMeshes({ net, surface, levels: [0, 1], coarsestLevel: 0, liftM, neighbours, name: 'planet strips, levels 0–1' }),
    checkMeshes({ net, surface, levels: [3, 4], coarsestLevel: 0, liftM, neighbours, name: 'planet strips, levels 3–4' }),
    checkMeshes({ net, surface, levels: [7, 8], coarsestLevel: 0, liftM, neighbours, name: 'planet strips, levels 7–8' }),
    checkMeshes({ net, surface, levels: [10, 11], coarsestLevel: 0, liftM, neighbours, near, name: 'planet strips, levels 10–11 at the edge and the node' }),
  );
  // Whole cells at the edge on both faces and at the node.
  const cells: CellId[] = [];
  for (const level of [9, 11]) {
    const a = PLANET_SHAPE.cellAt(centreAt(net, 0, ke - 2, 0.5), level);
    const b = PLANET_SHAPE.cellAt(centreAt(net, 0, ke, 0.5), level);
    if (a.face === b.face) throw new Error(`planet strips: cells ${cellKey(a)} and ${cellKey(b)} lie on one face`);
    cells.push(a, b, PLANET_SHAPE.cellAt(node, level));
  }
  out.push(wholeCells('planet strip cells', cells, (c) => generatePlanetStripCell(seed, c)));
  return out;
}

// --- Recipe 5: the endless world --------------------------------------------------------------------------------------

export function endlessStripScript(): unknown[] {
  const seed = 7;
  const net = endlessStrips(seed);
  const surface = endlessStripSurface(seed);
  const liftM = (level: number): number => endlessLift(surface, level);
  const neighbours = (c: CellId): CellId[] => FLAT_SHAPE.neighbours(c);
  const out: unknown[] = [[0, 1, 2].map((l) => Math.round(stripLength(net, l) * 1e3))];
  out.push(
    checkMeshes({ net, surface, levels: [5, 6], coarsestLevel: 4, liftM, neighbours, name: 'endless strips, levels 5–6' }),
    checkMeshes({ net, surface, levels: [8, 9], coarsestLevel: 4, liftM, neighbours, name: 'endless strips, levels 8–9' }),
  );
  const l0 = net.lines[0]!;
  const node = centreAt(net, 0, l0.count - 2, 1);
  const cells: CellId[] = [];
  for (const level of [6, 9]) cells.push(FLAT_SHAPE.cellAt(centreAt(net, 0, 3, 0.5), level), FLAT_SHAPE.cellAt(centreAt(net, 0, Math.floor(l0.count / 2), 0.5), level), FLAT_SHAPE.cellAt(node, level));
  out.push(wholeCells('endless strip cells', cells, (c) => generateStripCell(seed, c)));
  // Off the strips: the smooth cell under another domain version.
  for (const [level, x, z] of [[6, -20_000, 9000], [9, 10_000_000, 0], [9, -3000, -3000]] as const) {
    const c = FLAT_SHAPE.cellAt([x, 0, z], level);
    const strip = generateStripCell(seed, c);
    const plain = generateSmoothCell(seed, c);
    if (strip.domainVersion === plain.domainVersion) throw new Error(`endless strips: cell ${cellKey(c)} keeps the domain version`);
    if (!eq(encodeCell({ ...strip, domainVersion: plain.domainVersion }), encodeCell(plain))) throw new Error(`endless strips: cell ${cellKey(c)} off the strips differs from the smooth cell`);
    out.push(cellKey(c), strip.domainVersion);
  }
  return out;
}
