// Scenarios for the golden hashes of the strip tools: the net and its height function (gen-core), and the strip mesh
// per streamed cell on a plane and on a sphere (gen-mesh). Each returns plain data to hash and throws when a property
// that must hold does not. Heights come from the engine's own noise.

import { FlatWorld, STRIP_STATION_FLOATS, cellKey, cubeDirection, cubeFaceOf, cubeNeighbour, flatStripSurface, fractalNoise3, sphereStripSurface, stripCarve, stripLength, stripNearest, stripNet, stripTouches, stripUp, valueNoise2 } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import type { CellId, StripInput, StripNet, StripSurface } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { STRIP_GLSL, STRIP_LAYOUT, stripGrow, stripMesh } from '../../../packages/wallhammer-web/src/gen-mesh/index.ts';
import type { StripMesh } from '../../../packages/wallhammer-web/src/gen-mesh/index.ts';

type V3 = [number, number, number];

const PROFILE = { section: [-1.25, -1.2, -1, 0, 0, 0.25, 1, 0, 1.25, -1.2], shoulderM: 14, bedM: 0.3 };
const QUADS = 32;

// --- Fixed nets -------------------------------------------------------------------------------------------------------

const FLAT = new FlatWorld();
const flatGround = (x: number, z: number): number => 4 * valueNoise2(x, z, 230, 71) + 0.8 * valueNoise2(x, z, 41, 72);

/**
 * A plane net of three lines: line 0 bends three times and ends at a node; line 1 leaves the node along the border
 * x = 256 of the cells of levels 9 and 10; line 2 leaves it eastward. Grades lie up to 2 m off the ground.
 */
function flatInput(): StripInput {
  const node: V3 = [256, 0, 300];
  const l0: number[] = [];
  const g0: number[] = [];
  const path0: [number, number][] = [[20, 40], [70, 80], [120, 150], [180, 200], [225, 262], [node[0], node[2]]];
  for (const [x, z] of path0) {
    l0.push(x, 0, z);
    g0.push(flatGround(x, z) + 1.5 * valueNoise2(x, z, 90, 73) - 0.5);
  }
  const l1: number[] = [];
  const g1: number[] = [];
  for (let k = 0; k <= 6; k++) {
    const z = 300 + k * 45;
    l1.push(256, 0, z);
    g1.push(flatGround(256, z) + 1);
  }
  const l2: number[] = [];
  const g2: number[] = [];
  for (const [x, z] of [[256, 300], [300, 296], [350, 280], [410, 250]] as const) {
    l2.push(x, 0, z);
    g2.push(flatGround(x, z) - 1);
  }
  return {
    radiusM: 0,
    profiles: [PROFILE],
    nodes: [{ point: node, heightM: flatGround(node[0], node[2]) + 0.5 }],
    lines: [
      { points: l0, heights: g0, halfWidths: 9, profile: 0, to: 0 },
      { points: l1, heights: g1, halfWidths: 6, profile: 0, from: 0 },
      { points: l2, heights: g2, halfWidths: Array.from({ length: 4 }, (_, k) => 4.5 + 0.5 * k), profile: 0, from: 0 },
    ],
  };
}

const SPHERE_R = 20_000;
const sphereGround = (x: number, y: number, z: number): number => 30 * fractalNoise3(x, y, z, { cellM: 900, octaves: 3 }, 81) - 10;

/** Unit direction of (x, y, z). */
function unit(x: number, y: number, z: number): V3 {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

/**
 * A sphere net over the edge of the cube between faces 0 (+x) and 4 (+z): line 0 runs across the edge with a gentle
 * bend and ends at a node, lines 1 and 2 leave the node 50° apart. Grades follow the ground, at least 2 m.
 */
function sphereInput(): StripInput {
  const pts = (from: V3, to: V3, n: number, wave: number): { points: number[]; heights: number[] } => {
    const points: number[] = [];
    const heights: number[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const bend = wave * t * (1 - t);
      const d = unit(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t + bend, from[2] + (to[2] - from[2]) * t);
      points.push(d[0] * SPHERE_R, d[1] * SPHERE_R, d[2] * SPHERE_R);
      heights.push(Math.max(2, sphereGround(d[0] * SPHERE_R, d[1] * SPHERE_R, d[2] * SPHERE_R)));
    }
    return { points, heights };
  };
  const a = unit(1, 0.05, 0.93);
  const node = unit(0.94, 0.08, 1);
  const b1 = unit(0.9, 0.095, 1);
  const b2 = unit(0.935, 0.11, 1);
  const main = pts(a, node, 40, 0.01);
  const one = pts(node, b1, 12, 0);
  const two = pts(node, b2, 10, 0);
  const nodePoint: V3 = [node[0] * SPHERE_R, node[1] * SPHERE_R, node[2] * SPHERE_R];
  return {
    radiusM: SPHERE_R,
    profiles: [PROFILE],
    nodes: [{ point: nodePoint, heightM: main.heights[main.heights.length - 1]! }],
    lines: [
      { ...main, halfWidths: 9, profile: 0, to: 0 },
      { ...one, halfWidths: 6, profile: 0, from: 0 },
      { ...two, halfWidths: 4.5, profile: 0, from: 0 },
    ],
  };
}

// --- Shared checks ----------------------------------------------------------------------------------------------------

/** Points of the centre of piece k of a line at share t (the straight way between its stations). */
function centreAt(net: StripNet, line: number, k: number, t: number): V3 {
  const st = net.lines[line]!.stations;
  const s0 = k * STRIP_STATION_FLOATS;
  const s1 = s0 + STRIP_STATION_FLOATS;
  const x = st[s0]! + (st[s1]! - st[s0]!) * t;
  const y = st[s0 + 1]! + (st[s1 + 1]! - st[s0 + 1]!) * t;
  const z = st[s0 + 2]! + (st[s1 + 2]! - st[s0 + 2]!) * t;
  if (net.radiusM === 0) return [x, 0, z];
  const d = unit(x, y, z);
  return [d[0] * net.radiusM, d[1] * net.radiusM, d[2] * net.radiusM];
}

/** Grade and camber of a line at metres along it. */
function designAt(net: StripNet, line: number, along: number, a: number): number {
  const l = net.lines[line]!;
  const st = l.stations;
  let k = 0;
  while (k + 2 < l.count && st[(k + 1) * STRIP_STATION_FLOATS + 11]! < along) k++;
  const s0 = k * STRIP_STATION_FLOATS;
  const s1 = s0 + STRIP_STATION_FLOATS;
  const span = st[s1 + 11]! - st[s0 + 11]!;
  const t = Math.min(1, Math.max(0, (along - st[s0 + 11]!) / span));
  const grade = st[s0 + 9]! + (st[s1 + 9]! - st[s0 + 9]!) * t;
  const camber = st[s0 + 10]! + (st[s1 + 10]! - st[s0 + 10]!) * t;
  return grade + camber * stripUp(net.profiles[l.profile]!, a);
}

interface Section {
  cell: string;
  line: number;
  along: number;
  /** World positions at blend 0 and 1, per vertex. */
  p0: V3[];
  p1: V3[];
  side: V3[];
  strip: number[][];
  /** Base points (on the base surface) per vertex. */
  base: V3[];
  /** Links to the neighbouring sections of the same cell (count). */
  links: number;
}

/** Splits a strip mesh into its sections. */
function sectionsOf(net: StripNet, surface: StripSurface, cell: CellId, m: StripMesh): { sections: Section[]; tri: number[][]; vertexSection: number[] } {
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
    const s: Section = { cell: cellKey(cell), line, along: f.getFloat32(v * stride + 32, true), p0: [], p1: [], side: [], strip: [], base: [], links: 0 };
    for (let k = 0; k < n; k++, v++) {
      const off = v * stride;
      const g = (i: number): number => f.getFloat32(off + i * 4, true);
      const p0: V3 = [g(0) + o[0], g(1) + o[1], g(2) + o[2]];
      const shift = g(3);
      const up = R > 0 ? unit(p0[0], p0[1], p0[2]) : ([0, 1, 0] as V3);
      s.p0.push(p0);
      s.p1.push([p0[0] + up[0] * shift, p0[1] + up[1] * shift, p0[2] + up[2] * shift]);
      s.side.push([g(4), g(5), g(6)]);
      s.strip.push([g(7), g(8), g(9), g(10)]);
      s.base.push(R > 0 ? [up[0] * R, up[1] * R, up[2] * R] : [p0[0], 0, p0[2]]);
      vertexSection.push(sections.length);
    }
    sections.push(s);
  }
  const idx = m.mesh.indices!;
  const tri: number[][] = [];
  const linked = new Set<string>();
  for (let i = 0; i < m.mesh.count; i += 3) {
    tri.push([idx[i]!, idx[i + 1]!, idx[i + 2]!]);
    const a = vertexSection[idx[i]!]!;
    for (const b of [vertexSection[idx[i + 1]!]!, vertexSection[idx[i + 2]!]!]) {
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (linked.has(key)) continue;
      linked.add(key);
      sections[a]!.links++;
      sections[b]!.links++;
    }
  }
  return { sections, tri, vertexSection };
}

const dist = (a: readonly number[], b: readonly number[]): number => Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);

/** True when two triangles (2D) overlap by more than `eps` (separating axes). */
function trianglesOverlap(a: [number, number][], b: [number, number][], eps: number): boolean {
  for (const t of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const p = t[i]!;
      const q = t[(i + 1) % 3]!;
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      const l = Math.sqrt(nx * nx + ny * ny);
      if (l === 0) return false;
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (const r of a) {
        const d = (r[0] * nx + r[1] * ny) / l;
        a0 = Math.min(a0, d);
        a1 = Math.max(a1, d);
      }
      for (const r of b) {
        const d = (r[0] * nx + r[1] * ny) / l;
        b0 = Math.min(b0, d);
        b1 = Math.max(b1, d);
      }
      if (Math.min(a1, b1) - Math.max(a0, b0) <= eps) return false;
    }
  }
  return true;
}

export interface StripMeshCheck {
  net: StripNet;
  surface: StripSurface;
  /** Neighbouring levels, coarse first. */
  levels: readonly [number, number];
  coarsestLevel: number;
  liftM: (level: number) => number;
  neighbours: (c: CellId) => CellId[];
  /** Node points to check for overlap, with the radius to look in. */
  nodes: { point: V3; radiusM: number }[];
  name: string;
}

/**
 * The strip mesh at two neighbouring levels over every cell the lines pass: (a) lengths add up to the line; (b)
 * sections of neighbouring cells at a shared share agree, and every section where a cell's part of a line ends has a
 * partner; (c) the child at blend 1 follows the rule at the parent's level, and the parent's own vertices where they
 * share a section; (d) nothing on the strip lies under the drawn ground plus the lift; (e) node corners shared bit for
 * bit, no two top triangles of a node overlap seen from above; (f) the bytes do not depend on the order.
 */
export function checkStripMeshes(c: StripMeshCheck): unknown[] {
  const { net, surface } = c;
  const R = net.radiusM;
  const out: unknown[] = [c.name];
  const perLevel = new Map<number, { cells: CellId[]; meshes: (StripMesh | null)[]; sections: Section[]; parsed: ReturnType<typeof sectionsOf>[] }>();
  for (const level of c.levels) {
    // Cells the centre lines pass, found by walking them in steps of a quarter of the vertex spacing, and their
    // neighbours.
    const found = new Map<string, CellId>();
    const step = surface.spacingM(level) / 4;
    for (let li = 0; li < net.lineCount; li++) {
      const l = net.lines[li]!;
      for (let k = 0; k + 1 < l.count; k++) {
        const a = centreAt(net, li, k, 0);
        const b = centreAt(net, li, k, 1);
        const n = Math.max(2, Math.ceil(dist(a, b) / step));
        for (let i = 0; i <= n; i++) {
          const cell = surface.cellAt(level, centreAt(net, li, k, i / n));
          for (const x of [cell, ...c.neighbours(cell)]) found.set(cellKey(x), x);
        }
      }
    }
    const cells = [...found.keys()].sort().map((k) => found.get(k)!);
    const opts = { coarsestLevel: c.coarsestLevel, liftM: c.liftM };
    const meshes = cells.map((cell) => stripMesh(net, surface, cell, opts));
    // (f) The reversed order gives the same bytes.
    const reversed = [...cells].reverse().map((cell) => stripMesh(net, surface, cell, opts)).reverse();
    meshes.forEach((m, i) => {
      const r = reversed[i];
      const same = m === null ? r === null : r !== null && r !== undefined && Buffer.compare(Buffer.from(m.mesh.vertices.buffer, m.mesh.vertices.byteOffset, m.mesh.vertices.byteLength), Buffer.from(r.mesh.vertices.buffer, r.mesh.vertices.byteOffset, r.mesh.vertices.byteLength)) === 0;
      if (!same) throw new Error(`${c.name}: cell ${cellKey(cells[i]!)} differs with the order of generation`);
    });
    // (a) Lengths.
    for (let li = 0; li < net.lineCount; li++) {
      let sum = 0;
      for (const m of meshes) if (m) sum += m.lengthM[li]!;
      const want = stripLength(net, li);
      if (Math.abs(sum - want) > 1e-9 * want) throw new Error(`${c.name}: level ${level} holds ${sum} m of line ${li}, the line is ${want} m`);
      out.push(Math.round(sum * 1e6));
    }
    const parsed = meshes.map((m, i) => (m ? sectionsOf(net, surface, cells[i]!, m) : null));
    const sections = parsed.flatMap((p) => (p ? p.sections : []));
    perLevel.set(level, { cells, meshes, sections, parsed: parsed.filter((p): p is ReturnType<typeof sectionsOf> => p !== null) });
    // (b) Shared sections.
    const byKey = new Map<string, Section[]>();
    for (const s of sections) {
      const key = `${s.line}:${s.along}`;
      const list = byKey.get(key) ?? [];
      list.push(s);
      byKey.set(key, list);
    }
    let shared = 0;
    for (const list of byKey.values()) {
      for (let i = 1; i < list.length; i++) {
        const x = list[0]!;
        const y = list[i]!;
        if (x.cell === y.cell) throw new Error(`${c.name}: cell ${x.cell} holds two sections at one share`);
        shared++;
        for (let v = 0; v < x.p0.length; v++) {
          if (dist(x.p0[v]!, y.p0[v]!) > 1e-3 || dist(x.p1[v]!, y.p1[v]!) > 1e-3) throw new Error(`${c.name}: cells ${x.cell} and ${y.cell} disagree at line ${x.line}, ${x.along} m`);
          if (x.side[v]!.some((q, k) => q !== y.side[v]![k]) || x.strip[v]!.some((q, k) => q !== y.strip[v]![k])) throw new Error(`${c.name}: cells ${x.cell} and ${y.cell} disagree on a_side or a_strip at line ${x.line}, ${x.along} m`);
        }
      }
    }
    for (const s of sections) {
      if (s.links >= 2) continue;
      const length = stripLength(net, s.line);
      if (Math.abs(s.along) < 1e-3 || Math.abs(s.along - length) < 1e-2) continue;
      if ((byKey.get(`${s.line}:${s.along}`) ?? []).length < 2) throw new Error(`${c.name}: level ${level}: line ${s.line} stops at ${s.along} m in cell ${s.cell} with no neighbour going on`);
    }
    out.push(sections.length, shared);
    // (d) Nothing on the strip under the drawn ground plus the lift, at either end of the blend.
    for (const s of sections) {
      for (let v = 0; v < s.p0.length; v++) {
        if (Math.abs(s.strip[v]![0]!) > 1) continue;
        const h0 = R > 0 ? Math.sqrt(s.p0[v]![0] ** 2 + s.p0[v]![1] ** 2 + s.p0[v]![2] ** 2) - R : s.p0[v]![1];
        const h1 = R > 0 ? Math.sqrt(s.p1[v]![0] ** 2 + s.p1[v]![1] ** 2 + s.p1[v]![2] ** 2) - R : s.p1[v]![1];
        if (h0 < surface.heightOn(level, s.base[v]!) + c.liftM(level) - 1e-3) throw new Error(`${c.name}: level ${level}: a vertex of line ${s.line} at ${s.along} m lies under the ground`);
        if (level > c.coarsestLevel && h1 < surface.heightOn(level - 1, s.base[v]!) + c.liftM(level - 1) - 1e-3) throw new Error(`${c.name}: level ${level}: a vertex of line ${s.line} at ${s.along} m lies under the coarser ground at blend 1`);
      }
    }
    // (e) Node corners bit for bit, and no overlap of top triangles around a node.
    for (const nd of c.nodes) {
      const tris: [number, number][][] = [];
      let e1: V3 = [0, 0, 1];
      let e2: V3 = [1, 0, 0];
      if (R > 0) {
        const u = unit(nd.point[0], nd.point[1], nd.point[2]);
        const t = Math.abs(u[1]) < 0.9 ? unit(-u[2], 0, u[0]) : unit(0, u[2], -u[1]);
        e1 = t;
        e2 = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]];
      }
      for (const p of perLevel.get(level)!.parsed) {
        const flat = p.sections.flatMap((s) => s.base.map((b, k) => ({ b, a: s.strip[k]![0]! })));
        for (const t of p.tri) {
          const vs = t.map((i) => flat[i]!);
          if (vs.some((q) => Math.abs(q.a) > 1 || dist(q.b, nd.point) > nd.radiusM)) continue;
          tris.push(vs.map((q) => [(q.b[0] - nd.point[0]) * e1[0] + (q.b[1] - nd.point[1]) * e1[1] + (q.b[2] - nd.point[2]) * e1[2], (q.b[0] - nd.point[0]) * e2[0] + (q.b[1] - nd.point[1]) * e2[1] + (q.b[2] - nd.point[2]) * e2[2]] as [number, number]));
        }
      }
      for (let i = 0; i < tris.length; i++) for (let j = i + 1; j < tris.length; j++) if (trianglesOverlap(tris[i]!, tris[j]!, 1e-4)) throw new Error(`${c.name}: level ${level}: two triangles overlap at a node`);
      if (tris.length < 6) throw new Error(`${c.name}: level ${level}: only ${tris.length} triangles at a node`);
      out.push(tris.length);
    }
  }
  // (e) Corners of the node stations: every corner is held by exactly two lines, with the same bits.
  const corners = new Map<string, number>();
  for (const l of net.lines) {
    for (const si of [0, l.count - 1]) {
      const s = si * STRIP_STATION_FLOATS;
      if (l.stations[s + 10] !== 0) continue;
      for (const e of [3, 6]) {
        const key = `${l.stations[s + e]},${l.stations[s + e + 1]},${l.stations[s + e + 2]}`;
        corners.set(key, (corners.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [k, n] of corners) if (n !== 2) throw new Error(`${c.name}: node corner ${k} is held by ${n} lines`);
  out.push(corners.size);
  // (c) Child at blend 1 = the rule at the parent's level, and = the parent's own vertices on shared sections.
  const [coarseL, fineL] = c.levels;
  const parent = perLevel.get(coarseL)!;
  const child = perLevel.get(fineL)!;
  const parentByKey = new Map<string, Section>();
  for (const s of parent.sections) parentByKey.set(`${s.line}:${s.along}`, s);
  let matched = 0;
  const heightOf = (p: V3): number => (R > 0 ? Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) - R : p[1]);
  for (const s of child.sections) {
    const profile = net.profiles[net.lines[s.line]!.profile]!;
    const sec = profile.section;
    const rule = (level: number): number[] => {
      const h: number[] = [];
      for (let v = 0; v < s.p0.length; v++) {
        const a = sec[v * 2]!;
        if (Math.abs(a) <= 1) h[v] = Math.max(designAt(net, s.line, s.along, a), surface.heightOn(level, s.base[v]!) + c.liftM(level));
      }
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
      if (Math.abs(heightOf(s.p0[v]!) - own[v]!) > 1e-3) throw new Error(`${c.name}: level ${fineL}: line ${s.line} at ${s.along} m: vertex ${v} at ${heightOf(s.p0[v]!)} m, the rule gives ${own[v]} m`);
      if (Math.abs(heightOf(s.p1[v]!) - coarse[v]!) > 1e-3) throw new Error(`${c.name}: level ${fineL}: line ${s.line} at ${s.along} m: vertex ${v} at blend 1 at ${heightOf(s.p1[v]!)} m, the parent's rule gives ${coarse[v]} m`);
    }
    const p = parentByKey.get(`${s.line}:${s.along}`);
    if (!p) continue;
    matched++;
    for (let v = 0; v < s.p0.length; v++) if (dist(s.p1[v]!, p.p0[v]!) > 1e-3) throw new Error(`${c.name}: line ${s.line} at ${s.along} m: the child at blend 1 misses the parent by ${dist(s.p1[v]!, p.p0[v]!)} m`);
  }
  if (matched === 0) throw new Error(`${c.name}: no section shared by the two levels`);
  out.push(matched);
  // The bytes, by level and cell.
  for (const level of c.levels) {
    const e = perLevel.get(level)!;
    e.meshes.forEach((m, i) => {
      if (!m) return;
      out.push(cellKey(e.cells[i]!), m.mesh.vertices, m.mesh.indices, m.bounds.min, m.bounds.max);
    });
  }
  return out;
}

const flatNeighbours = (c: CellId): CellId[] => FLAT.neighbours(c);
const sphereNeighbours = (c: CellId): CellId[] => {
  const out: CellId[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const n = cubeNeighbour(c.face, c.level, c.x, c.y, dx, dy);
      if (n) out.push({ face: n.face, level: c.level, x: n.x, y: n.y });
    }
  }
  return out;
};

// --- Recipe 1: the net and the height function --------------------------------------------------------------------------

/**
 * Lengths and a table of `stripCarve` on the plane and the sphere net. Checks: on the centre line the result is the
 * grade + up(0) − bed; past the shoulder the input comes back bit for bit; steps between samples 5 cm apart stay under
 * 2 cm across a line, across a bend and around the node; `stripTouches` false means the input comes back.
 */
export function stripNetScript(): unknown[] {
  const out: unknown[] = [];
  for (const input of [flatInput(), sphereInput()]) {
    const net = stripNet(input);
    const R = net.radiusM;
    const ground = (p: V3): number => (R > 0 ? sphereGround(p[0], p[1], p[2]) : flatGround(p[0], p[2]));
    const name = R > 0 ? 'sphere' : 'plane';
    for (let li = 0; li < net.lineCount; li++) out.push(Math.round(stripLength(net, li) * 1e6), net.lines[li]!.count);
    out.push(Math.round(net.reachM * 1e6));
    /** A point `across` metres to the right of the centre of piece k of line li at share t. */
    const offset = (li: number, k: number, t: number, across: number): V3 => {
      const c = centreAt(net, li, k, t);
      const d = centreAt(net, li, k, Math.min(1, t + 1e-3));
      const e = centreAt(net, li, k, Math.max(0, t - 1e-3));
      const up = R > 0 ? unit(c[0], c[1], c[2]) : ([0, 1, 0] as V3);
      const tx = d[0] - e[0];
      const ty = d[1] - e[1];
      const tz = d[2] - e[2];
      const r = unit(ty * up[2] - tz * up[1], tz * up[0] - tx * up[2], tx * up[1] - ty * up[0]);
      const x = c[0] + r[0] * across;
      const y = c[1] + r[1] * across;
      const z = c[2] + r[2] * across;
      if (R === 0) return [x, 0, z];
      const u = unit(x, y, z);
      return [u[0] * R, u[1] * R, u[2] * R];
    };
    for (let li = 0; li < net.lineCount; li++) {
      const l = net.lines[li]!;
      for (let k = 2; k + 3 < l.count; k++) {
        const st = l.stations;
        const s0 = k * STRIP_STATION_FLOATS;
        if (st[s0 + 10] !== 1 || st[s0 + STRIP_STATION_FLOATS + 10] !== 1) continue;
        const p = centreAt(net, li, k, 0.5);
        const grade = st[s0 + 9]! + (st[s0 + STRIP_STATION_FLOATS + 9]! - st[s0 + 9]!) * 0.5;
        const want = grade + stripUp(PROFILE, 0) - PROFILE.bedM;
        // Only where no other line reaches.
        const hit = stripNearest(net, p[0], p[1], p[2]);
        if (!hit || hit.line !== li) throw new Error(`strip net (${name}): the centre of line ${li} is nearest to another line`);
        const got = stripCarve(net, p[0], p[1], p[2], ground(p));
        let others = false;
        for (let o = 0; o < net.lineCount; o++) if (o !== li && net.lines[o]!.box[0]! - 30 < p[0] && p[0] < net.lines[o]!.box[3]! + 30 && net.lines[o]!.box[2]! - 30 < p[2] && p[2] < net.lines[o]!.box[5]! + 30) others = true;
        if (!others && Math.abs(got - want) > 1e-6) throw new Error(`strip net (${name}): on the centre of line ${li} the ground is ${got}, want ${want}`);
        // Past the shoulder on both sides.
        for (const side of [-1, 1]) {
          const q = offset(li, k, 0.5, side * (stripNearestHalf(net, li, p) + PROFILE.shoulderM + 1));
          const own = ground(q) + 0.123456789;
          const back = stripCarve(net, q[0], q[1], q[2], own);
          const near = stripNearest(net, q[0], q[1], q[2]);
          if (!near && back !== own) throw new Error(`strip net (${name}): past the shoulder of line ${li} the ground changed`);
        }
      }
    }
    // Steps of 5 cm: across line 0 in the middle of a piece, along line 0 through a bend on both sides, a circle
    // around the node.
    const walk = (points: V3[], what: string): number => {
      let worst = 0;
      let prev = NaN;
      for (const p of points) {
        const h = stripCarve(net, p[0], p[1], p[2], ground(p));
        if (prev === prev) worst = Math.max(worst, Math.abs(h - prev));
        prev = h;
      }
      if (worst >= 0.02) throw new Error(`strip net (${name}): a step of ${worst} m between samples 5 cm apart ${what}`);
      return Math.round(worst * 1e9);
    };
    const l0 = net.lines[0]!;
    const mid = Math.floor(l0.count / 2);
    const across: V3[] = [];
    for (let s = -30; s <= 30; s += 0.05) across.push(offset(0, mid, 0.5, s));
    walk(across, 'across line 0');
    for (const side of [-12, -9.5, -5, 5, 9.5, 12, 20]) {
      const along: V3[] = [];
      for (let k = mid - 1; k <= mid; k++) {
        const len = dist(centreAt(net, 0, k, 0), centreAt(net, 0, k, 1));
        const n = Math.ceil(len / 0.05);
        // Off the centre along the stations' own edge directions (mitred), blended along the piece: a path that
        // keeps its distance through the bend without a jump.
        const st = l0.stations;
        const dirAt = (s: number): V3 => unit(st[s + 6]! - st[s]!, st[s + 7]! - st[s + 1]!, st[s + 8]! - st[s + 2]!);
        const d0 = dirAt(k * STRIP_STATION_FLOATS);
        const d1 = dirAt((k + 1) * STRIP_STATION_FLOATS);
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const c = centreAt(net, 0, k, t);
          const d = unit(d0[0] + (d1[0] - d0[0]) * t, d0[1] + (d1[1] - d0[1]) * t, d0[2] + (d1[2] - d0[2]) * t);
          const x = c[0] + d[0] * side;
          const y = c[1] + d[1] * side;
          const z = c[2] + d[2] * side;
          if (R === 0) along.push([x, 0, z]);
          else {
            const u = unit(x, y, z);
            along.push([u[0] * R, u[1] * R, u[2] * R]);
          }
        }
      }
      walk(along, `along line 0 through a bend, ${side} m off`);
    }
    const node = input.nodes![0]!.point;
    for (const radius of [3, 12, 25, 40]) {
      const ring: V3[] = [];
      const up = R > 0 ? unit(node[0], node[1], node[2]) : ([0, 1, 0] as V3);
      const t1 = R > 0 ? unit(-up[2], 0, up[0]) : ([0, 0, 1] as V3);
      const t2: V3 = [up[1] * t1[2] - up[2] * t1[1], up[2] * t1[0] - up[0] * t1[2], up[0] * t1[1] - up[1] * t1[0]];
      const n = Math.ceil((2 * Math.PI * radius) / 0.05);
      for (let i = 0; i <= n; i++) {
        const a = (2 * Math.PI * i) / n;
        const x = node[0] + (t1[0] * Math.cos(a) + t2[0] * Math.sin(a)) * radius;
        const y = node[1] + (t1[1] * Math.cos(a) + t2[1] * Math.sin(a)) * radius;
        const z = node[2] + (t1[2] * Math.cos(a) + t2[2] * Math.sin(a)) * radius;
        if (R === 0) ring.push([x, 0, z]);
        else {
          const u = unit(x, y, z);
          ring.push([u[0] * R, u[1] * R, u[2] * R]);
        }
      }
      walk(ring, `around the node at ${radius} m`);
    }
    // A table over the net's box, and stripTouches false ⇒ the input.
    const table: number[] = [];
    let skipped = 0;
    for (let j = 0; j <= 40; j++) {
      for (let i = 0; i <= 40; i++) {
        let p: V3;
        if (R === 0) p = [-20 + i * 12, 0, 0 + j * 16];
        else {
          const u = unit(1 - 0.06 * (i / 40), 0.02 + 0.12 * (j / 40), 0.9 + 0.12 * (i / 40));
          p = [u[0] * R, u[1] * R, u[2] * R];
        }
        const own = ground(p);
        const h = stripCarve(net, p[0], p[1], p[2], own);
        table.push(h);
        if (!stripTouches(net, p[0], p[1], p[2], 0)) {
          skipped++;
          if (h !== own) throw new Error(`strip net (${name}): stripTouches says no, the ground changed`);
        }
      }
    }
    if (skipped === 0 || skipped === 41 * 41) throw new Error(`strip net (${name}): the table does not test stripTouches (${skipped})`);
    out.push(Float64Array.from(table), skipped);
  }
  return out;
}

/** Half-width of line li near point p (from the nearest hit). */
function stripNearestHalf(net: StripNet, li: number, p: V3): number {
  const h = stripNearest(net, p[0], p[1], p[2]);
  if (!h || h.line !== li) return 9;
  return h.halfWidthM;
}

// --- Recipes 2 and 3: the mesh ----------------------------------------------------------------------------------------

const lift = (surface: StripSurface) => (level: number): number => 0.05 + 0.08 * surface.spacingM(level);

/** The plane net over levels 9 and 10 of a flat world, the ground carved by the net. */
export function stripPlaneScript(): unknown[] {
  const net = stripNet(flatInput());
  const surface = flatStripSurface({ shape: FLAT, quads: QUADS, heightAt: (x, z) => stripCarve(net, x, 0, z, flatGround(x, z)) });
  const grow: number[] = [];
  for (const hw of [0.5, 4.5, 9]) for (const mpp of [0.01, 0.5, 3, 20]) for (const px of [1, 1.6, 3]) grow.push(stripGrow(hw, mpp, px));
  if (stripGrow(9, 0.01, 1.6) !== 0 || stripGrow(1, 10, 1) !== 4) throw new Error('stripGrow: the rule is max(0, minPx·mpp/2 − half-width)');
  return [
    STRIP_GLSL,
    Float64Array.from(grow),
    checkStripMeshes({ net, surface, levels: [9, 10], coarsestLevel: 4, liftM: lift(surface), neighbours: flatNeighbours, nodes: [{ point: [256, 0, 300], radiusM: 40 }], name: 'strip mesh (plane)' }),
  ];
}

/** The sphere net over the edge of faces 0 and 4, at levels 3–4 and 9–10. */
export function stripSphereScript(): unknown[] {
  const input = sphereInput();
  const net = stripNet(input);
  const surface = sphereStripSurface({ radiusM: SPHERE_R, quads: QUADS, heightAt: (x, y, z) => Math.max(0, stripCarve(net, x, y, z, sphereGround(x, y, z))) });
  // The line really changes face.
  const st = net.lines[0]!.stations;
  const first = cubeFaceOf(unit(st[0]!, st[1]!, st[2]!)).face;
  const lastAt = (net.lines[0]!.count - 1) * STRIP_STATION_FLOATS;
  const last = cubeFaceOf(unit(st[lastAt]!, st[lastAt + 1]!, st[lastAt + 2]!)).face;
  if (first === last) throw new Error(`strip mesh (sphere): line 0 stays on face ${first}`);
  const mid = cubeDirection(0, 0, 0);
  const node = input.nodes![0]!.point as V3;
  return [
    first,
    last,
    mid,
    checkStripMeshes({ net, surface, levels: [3, 4], coarsestLevel: 0, liftM: lift(surface), neighbours: sphereNeighbours, nodes: [], name: 'strip mesh (sphere, levels 3–4)' }),
    checkStripMeshes({ net, surface, levels: [9, 10], coarsestLevel: 0, liftM: lift(surface), neighbours: sphereNeighbours, nodes: [{ point: node, radiusM: 40 }], name: 'strip mesh (sphere, levels 9–10)' }),
  ];
}
