// Golden scenarios of world streaming (engine modules gen-core, gen-mesh, world; generator of examples/endless):
//   - a cell's bytes do not depend on which cells were generated before it, or in which order;
//   - border vertices of neighbouring cells agree exactly (position, normal, colour), near the origin and 10,000 km out;
//   - a file provider hands over exactly the generator's bytes (and the format round-trips);
//   - the streaming manager issues the same requests for a scripted camera path, and its drawn cover never overlaps
//     and, when settled, covers every root completely.
// Each check throws on a violation; the returned values go into the golden hash.
//
// Smooth levels of detail (the example's second generator, cell format 2, selection by screen-space error):
//   - its cells are order-independent too, state the shape hash and their error, round-trip through format 2, and a
//     file provider reads them from the folder of their shape and refuses cells of another shape;
//   - seams between levels: a cell blended fully into its parent's shape lies on the parent's surface, and on the
//     border of a coarser neighbour it lies on that neighbour's border; same-level neighbours agree in every attribute;
//     the skirt hangs at least twice as deep as the border can be away from the coarser shape;
//   - coverage: on a scripted zoom the manager never asks for a cell below one that is not loaded, stays within its
//     budgets of cells and jobs, starts with what lies ahead, and a root once covered stays covered without a hole.

import type { CellId } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { cellId, cellKey, hashInts, shapeHash, unit } from '../../packages/wallhammer-web/src/gen-core/index.ts';
import { CELL_MORPH_LAYOUT, CELL_SURFACE_LAYOUT } from '../../packages/wallhammer-web/src/gen-mesh/index.ts';
import { CELL_FORMAT_VERSION, CELL_FORMAT_VERSION_SHAPED, DEFAULT_STREAMING, FileCellProvider, GeneratorCellProvider, StreamingManager, decodeCell, encodeCell } from '../../packages/wallhammer-web/src/world/index.ts';
import type { CellRequest, StreamingConfig, Ticket } from '../../packages/wallhammer-web/src/world/index.ts';
import { FACE, LEAF_LEVEL, PROP_MORPH_LAYOUT, QUADS, ROOT_LEVEL, RULES, SHAPE, SMOOTH_SELECTION, SMOOTH_STREAMING, generateCell, generateSmoothCell } from '../../examples/endless/src/terrain.ts';

const SEED = 7;
const FAR_X = 10_000_000;

const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const at = (x: number, z: number, level: number): CellId => SHAPE.cellAt([x, 0, z], level);

/** (a) Bytes of a cell alone, after its neighbours in two orders, and after a far cell: all equal. */
export function orderIndependence(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const c of [at(300, -200, LEAF_LEVEL), at(FAR_X + 300, 5000, 8), at(-9000, 7000, ROOT_LEVEL + 1)]) {
    const alone = new GeneratorCellProvider(SEED, generateCell).bytes(c);
    const ring = SHAPE.neighbours(c);
    for (const order of [ring, [...ring].reverse(), [at(FAR_X * 2, -FAR_X, 6), ...SHAPE.children(c)]]) {
      const p = new GeneratorCellProvider(SEED, generateCell);
      for (const n of order) p.bytes(n);
      if (!eq(p.bytes(c), alone)) throw new Error(`streaming: cell ${cellKey(c)} differs after generating ${order.length} other cells first`);
    }
    out.push(alone);
  }
  return out;
}

interface Border {
  /** World x, z of each border vertex (double), and its bytes after the position (height, normal, colour). */
  x: number[];
  z: number[];
  rest: Uint8Array[];
}

/** Surface (not skirt) vertices of a cell on one side: 'w', 'e', 'n' (−z) or 's'. */
function border(c: CellId, side: 'w' | 'e' | 'n' | 's'): Border {
  const content = decodeCell(encodeCell(generateCell(SEED, c)));
  const m = content.meshes[0]!.mesh;
  const v = m.vertices as Uint8Array;
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const stride = CELL_SURFACE_LAYOUT.stride;
  const size = SHAPE.edgeM(c.level);
  const o = SHAPE.origin(c);
  const b: Border = { x: [], z: [], rest: [] };
  for (let i = 0; i < v.byteLength / stride; i++) {
    const off = i * stride;
    if (dv.getInt16(off + 18, true) !== 0) continue;
    const lx = dv.getFloat32(off, true);
    const lz = dv.getFloat32(off + 8, true);
    const on = side === 'w' ? lx === 0 : side === 'e' ? lx === size : side === 'n' ? lz === 0 : lz === size;
    if (!on) continue;
    b.x.push(o[0] + lx);
    b.z.push(o[2] + lz);
    // Height, normal and colour: bytes 4–8 and 12–24.
    b.rest.push(Uint8Array.from([...v.subarray(off + 4, off + 8), ...v.subarray(off + 12, off + stride)]));
  }
  // Same order on both sides: by world position.
  const idx = b.x.map((_, i) => i).sort((p, q) => b.x[p]! - b.x[q]! || b.z[p]! - b.z[q]!);
  return { x: idx.map((i) => b.x[i]!), z: idx.map((i) => b.z[i]!), rest: idx.map((i) => b.rest[i]!) };
}

/** (b) Shared borders of horizontal and vertical neighbours agree vertex for vertex, near and far from the origin. */
export function borderSeams(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const [x, z, level] of [
    [100, 100, LEAF_LEVEL],
    [-3000, 2500, 7],
    [FAR_X + 100, -100, LEAF_LEVEL],
    [FAR_X, FAR_X, ROOT_LEVEL],
  ] as const) {
    const a = at(x, z, level);
    const east = cellId(a.face, a.level, a.x + 1, a.y);
    const south = cellId(a.face, a.level, a.x, a.y + 1);
    for (const [p, q, sp, sq] of [
      [a, east, 'e', 'w'],
      [a, south, 's', 'n'],
    ] as const) {
      const bp = border(p, sp);
      const bq = border(q, sq);
      const n = bp.x.length;
      if (n === 0 || n !== bq.x.length) throw new Error(`streaming: border of ${cellKey(p)} has ${n} vertices, ${cellKey(q)} has ${bq.x.length}`);
      for (let i = 0; i < n; i++) {
        if (bp.x[i] !== bq.x[i] || bp.z[i] !== bq.z[i] || !eq(bp.rest[i]!, bq.rest[i]!)) {
          throw new Error(`streaming: seam between ${cellKey(p)} and ${cellKey(q)} differs at vertex ${i} (${bp.x[i]}, ${bp.z[i]})`);
        }
      }
      out.push(...bp.rest);
    }
  }
  return out;
}

/** File provider over an in-memory "server" of baked bytes: hands over exactly the generator's bytes. */
export async function fileEqualsGenerator(): Promise<Uint8Array[]> {
  const gen = new GeneratorCellProvider(SEED, generateCell);
  const cells = [at(0, 0, ROOT_LEVEL), at(-700, 300, 6), at(FAR_X + 40, 40, LEAF_LEVEL)];
  const server = new Map<string, Uint8Array>();
  const files = new FileCellProvider('mem://cells', async (url) => {
    const b = server.get(url);
    if (!b) throw new Error(`404 ${url}`);
    return b.slice().buffer;
  });
  for (const c of cells) server.set(files.url(c), gen.bytes(c));
  const out: Uint8Array[] = [];
  for (const c of cells) {
    const r = await files.request(c, new AbortController().signal);
    const g = gen.bytes(c);
    if (!eq(r.bytes!, g) || !eq(encodeCell(r.content), g)) throw new Error(`streaming: file and generator differ for ${cellKey(c)}`);
    out.push(g);
  }
  return out;
}

/** True when a is b or an ancestor of b. */
function covers(a: CellId, b: CellId): boolean {
  if (b.level < a.level) return false;
  const k = b.level - a.level;
  return Math.floor(b.x / 2 ** k) === a.x && Math.floor(b.y / 2 ** k) === a.y;
}

/**
 * (c) The manager on a scripted camera path, with a fake executor that finishes a fixed number of jobs per step after
 * a fixed delay and uploads a fixed number per step. Returns the request log and the drawn cover of every step.
 */
export function managerScript(): string[] {
  const config: StreamingConfig = { ...DEFAULT_STREAMING, shape: SHAPE, face: FACE, rootLevel: ROOT_LEVEL, leafLevel: LEAF_LEVEL, maxInFlight: 6, memoryBudgetBytes: 12_000_000 };
  const m = new StreamingManager(config);
  const queue: { req: CellRequest; due: number }[] = [];
  const trace: string[] = [];
  const steps = 260;
  for (let s = 0; s < steps; s++) {
    // Stand still, fly east fast, turn, then jump 10,000 km and stand still until settled.
    const t = Math.min(s, 120);
    const x = s < 30 ? 0 : s < 120 ? (t - 30) * 90 : s < 160 ? 8100 : FAR_X;
    const z = s < 120 ? 0 : s < 160 ? (s - 120) * -60 : 0;
    const moving = s >= 30 && s < 160;
    const tickets: Ticket[] = [{ id: 'camera', kind: 'camera', center: [x, 0, z], altitude: 150, base: 0, dir: s < 120 ? [1, 0] : [0, -1] }];
    if (moving) tickets.push({ id: 'predict', kind: 'predict', center: [x + (s < 120 ? 400 : 0), 0, z + (s < 120 ? 0 : -400)], altitude: 150, base: 1, dir: s < 120 ? [1, 0] : [0, -1] });
    const a = m.update(tickets);
    // The budget is enforced in update: right after it the cells hold no more than the budget.
    const held = m.counters();
    if (held.cpuBytes + held.gpuBytes > config.memoryBudgetBytes) throw new Error(`streaming: step ${s} holds ${held.cpuBytes + held.gpuBytes} bytes over the budget`);
    for (const c of a.cancels) {
      const i = queue.findIndex((j) => j.req.key === c.key && j.req.epoch === c.epoch);
      if (i >= 0) queue.splice(i, 1);
    }
    for (const r of a.requests) queue.push({ req: r, due: s + 2 });
    // Uploads: two per step, in the manager's order.
    for (const c of a.uploads.slice(0, 2)) m.resident(c, 20_000);
    // Jobs: three finish per step once due (while flying, one in every 37 fails and is retried later).
    let done = 0;
    for (let i = 0; i < queue.length && done < 3; ) {
      if (queue[i]!.due > s) {
        i++;
        continue;
      }
      const { req } = queue.splice(i, 1)[0]!;
      if (s < 150 && (s + done) % 37 === 0) m.fail(req);
      else m.complete(req, 30_000);
      done++;
    }
    const drawn = m.drawn();
    for (let i = 0; i < drawn.length; i++) {
      for (let j = 0; j < drawn.length; j++) {
        if (i !== j && covers(drawn[i]!, drawn[j]!)) throw new Error(`streaming: step ${s} draws ${cellKey(drawn[i]!)} and ${cellKey(drawn[j]!)} on top of each other`);
      }
    }
    const c = m.counters();
    trace.push(`${s}|${drawn.map(cellKey).join(';')}|${c.holes}|${c.settled}`);
  }
  // At the end the camera stood still long enough: settled, no hole, the cover fills every wanted root.
  const c = m.counters();
  if (!c.settled || c.holes !== 0) throw new Error(`streaming: not settled at the end (holes ${c.holes}, wanted ${c.wanted}, drawn ${c.drawn})`);
  let area = 0;
  for (const d of m.drawn()) area += SHAPE.edgeM(d.level) ** 2;
  const roots = m.wanted().filter((w) => w.level === ROOT_LEVEL).length;
  if (area !== roots * SHAPE.edgeM(ROOT_LEVEL) ** 2) throw new Error(`streaming: settled cover has area ${area}, roots ${roots}`);
  const { requested, completed, cancelled, stale, failed, evicted } = c;
  if (cancelled === 0 || failed === 0 || evicted === 0) throw new Error(`streaming: the script must exercise cancelling, failures and eviction (${cancelled}, ${failed}, ${evicted})`);
  return [...m.log, ...trace, JSON.stringify({ requested, completed, cancelled, stale, failed, evicted })];
}

// --- Smooth levels of detail -----------------------------------------------------------------------------------------

/**
 * (d) Cells of the smooth generator: bytes alone = after other cells in any order; written in format 2 with the shape
 * hash and the error, and round-tripping; the plain generator still writes format 1; a file provider with the shape
 * hash reads them from the shape's folder and refuses a cell built for another shape.
 */
export async function smoothCells(): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const shape = shapeHash(SHAPE);
  const version = (b: Uint8Array): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true);
  // Open water near and far, land without instances, and two cells with land and instances (old and new at their level).
  const cells = [at(300, -200, LEAF_LEVEL), at(FAR_X + 300, 5000, 8), at(-9000, 7000, ROOT_LEVEL + 1), at(1100, 700, 8), at(1100, 700, LEAF_LEVEL)];
  const gen = new GeneratorCellProvider(SEED, generateSmoothCell);
  // Instances: one that the parent's level holds too stands, fully blended, where the parent has it; one that is new at
  // this level has size 0 on the coarser level (it grows with the blend).
  const seen = { kept: 0, fresh: 0 };
  for (const c of cells) {
    const parent = generateSmoothCell(SEED, SHAPE.parent(c)!);
    for (const batch of generateSmoothCell(SEED, c).instances) {
      const rule = RULES.find((r) => r.name === batch.archetype)!;
      const floats = PROP_MORPH_LAYOUT.stride / 4;
      if (batch.data.layout !== PROP_MORPH_LAYOUT || batch.data.data.length !== (batch.ids.length / 2) * floats) throw new Error(`smooth cells: instances of ${cellKey(c)} are not in the blend layout`);
      const above = parent.instances.find((b) => b.archetype === batch.archetype);
      for (let i = 0; i < batch.ids.length / 2; i++) {
        const y = batch.data.data[i * floats + 1]!;
        const shift = batch.data.data[i * floats + 12]!;
        const size = batch.data.data[i * floats + 13]!;
        if (size !== (c.level > rule.minLevel ? 1 : 0)) throw new Error(`smooth cells: ${batch.archetype} in ${cellKey(c)} has size ${size} on the coarser level`);
        if (size === 0) {
          seen.fresh++;
          continue;
        }
        let k = -1;
        for (let j = 0; above && j < above.ids.length / 2; j++) if (above.ids[j * 2] === batch.ids[i * 2] && above.ids[j * 2 + 1] === batch.ids[i * 2 + 1]) k = j;
        if (k < 0) throw new Error(`smooth cells: ${batch.archetype} of ${cellKey(c)} is missing in the parent cell`);
        const py = above!.data.data[k * floats + 1]!;
        if (!(Math.abs(y + shift - py) <= SEAM_TOLERANCE_M)) throw new Error(`smooth cells: ${batch.archetype} of ${cellKey(c)} blends to ${y + shift}, the parent has it at ${py}`);
        seen.kept++;
      }
    }
  }
  if (seen.kept === 0 || seen.fresh === 0) throw new Error(`smooth cells: the cells tested hold no instances of both kinds (${seen.kept} kept, ${seen.fresh} new)`);
  for (const c of cells) {
    const alone = new GeneratorCellProvider(SEED, generateSmoothCell).bytes(c);
    const ring = SHAPE.neighbours(c);
    for (const order of [ring, [SHAPE.parent(c)!, ...[...ring].reverse(), ...SHAPE.children(c)]]) {
      const p = new GeneratorCellProvider(SEED, generateSmoothCell);
      for (const n of order) p.bytes(n);
      if (!eq(p.bytes(c), alone)) throw new Error(`smooth cells: cell ${cellKey(c)} differs after generating ${order.length} other cells first`);
    }
    if (version(alone) !== CELL_FORMAT_VERSION_SHAPED) throw new Error(`smooth cells: ${cellKey(c)} is written in format ${version(alone)}`);
    const back = decodeCell(alone);
    if (back.shapeHash !== shape) throw new Error(`smooth cells: ${cellKey(c)} states shape ${back.shapeHash}, expected ${shape}`);
    if (back.error === undefined || !(back.error >= 0)) throw new Error(`smooth cells: ${cellKey(c)} states no error`);
    if (!eq(encodeCell(back), alone)) throw new Error(`smooth cells: ${cellKey(c)} does not round-trip`);
    if (version(new GeneratorCellProvider(SEED, generateCell).bytes(c)) !== CELL_FORMAT_VERSION) throw new Error(`smooth cells: the plain generator left format ${CELL_FORMAT_VERSION}`);
    out.push(alone);
  }
  // Files: the shape hash is part of the path, and a provider for another shape does not accept the cell.
  const server = new Map<string, Uint8Array>();
  const fetch = async (url: string): Promise<ArrayBuffer> => {
    const b = server.get(url);
    if (!b) throw new Error(`404 ${url}`);
    return b.slice().buffer;
  };
  const files = new FileCellProvider('mem://cells', fetch, { shapeHash: shape });
  const plain = new FileCellProvider('mem://cells', fetch);
  const other = new FileCellProvider('mem://cells', fetch, { shapeHash: (shape ^ 0x5a5a5a5a) >>> 0 || 1 });
  const none = new AbortController().signal;
  for (const c of cells) {
    if (files.url(c) === plain.url(c) || !files.url(c).endsWith(plain.url(c).slice('mem://cells/'.length))) throw new Error(`smooth cells: unexpected file path ${files.url(c)}`);
    server.set(files.url(c), gen.bytes(c));
    server.set(other.url(c), gen.bytes(c));
    const r = await files.request(c, none);
    if (!eq(r.bytes!, gen.bytes(c)) || !eq(encodeCell(r.content), gen.bytes(c))) throw new Error(`smooth cells: file and generator differ for ${cellKey(c)}`);
    let refused = false;
    await other.request(c, none).catch(() => (refused = true));
    if (!refused) throw new Error(`smooth cells: a provider of another shape accepted ${cellKey(c)}`);
    out.push(new TextEncoder().encode(files.url(c)));
  }
  return out;
}

/** Surface of a smooth cell as a grid, and its skirt. */
interface SmoothGrid {
  cell: CellId;
  n: number;
  step: number;
  /** World origin (double). */
  ox: number;
  oz: number;
  y: Float32Array;
  shift: Float32Array;
  /** Bytes of vertex k from `from` to `to` (offsets inside the vertex). */
  bytes: (k: number, from: number, to: number) => Uint8Array;
  /** Per skirt pair: the surface vertex it hangs from, and how far the lower vertex hangs below the upper. */
  skirt: { drop: number; shift: number }[];
}

const MORPH = { height: [4, 8], ownNormal: [12, 18], coarseNormal: [28, 34], ownColor: [20, 24], coarseColor: [36, 40], rest: [12, 40] } as const;

function smoothGrid(c: CellId): SmoothGrid {
  const m = decodeCell(encodeCell(generateSmoothCell(SEED, c))).meshes[0]!.mesh;
  const v = m.vertices as Uint8Array;
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const stride = CELL_MORPH_LAYOUT.stride;
  if (m.layout.stride !== stride) throw new Error(`level seams: ${cellKey(c)} has vertex stride ${m.layout.stride}`);
  const n = QUADS + 1;
  const step = SHAPE.edgeM(c.level) / QUADS;
  const o = SHAPE.origin(c);
  const g: SmoothGrid = { cell: c, n, step, ox: o[0], oz: o[2], y: new Float32Array(n * n), shift: new Float32Array(n * n), bytes: (k, from, to) => v.slice(k * stride + from, k * stride + to), skirt: [] };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const off = (j * n + i) * stride;
      if (dv.getInt16(off + 18, true) !== 0 || dv.getFloat32(off, true) !== i * step || dv.getFloat32(off + 8, true) !== j * step) throw new Error(`level seams: ${cellKey(c)} vertex ${i}, ${j} is not where the grid has it`);
      g.y[j * n + i] = dv.getFloat32(off + 4, true);
      g.shift[j * n + i] = dv.getFloat32(off + 24, true);
    }
  }
  const total = v.byteLength / stride;
  if (total !== n * n + 8 * n) throw new Error(`level seams: ${cellKey(c)} has ${total} vertices, expected a surface and a skirt`);
  for (let k = n * n; k < total; k += 2) {
    const top = k * stride;
    const low = top + stride;
    if (dv.getInt16(top + 18, true) !== 1 || dv.getInt16(low + 18, true) !== 1) throw new Error(`level seams: ${cellKey(c)} vertex ${k} is not a skirt vertex`);
    if (dv.getFloat32(top, true) !== dv.getFloat32(low, true) || dv.getFloat32(top + 8, true) !== dv.getFloat32(low + 8, true)) throw new Error(`level seams: ${cellKey(c)} skirt pair ${k} is not vertical`);
    if (!eq(v.subarray(top + 12, top + 18), v.subarray(low + 12, low + 18)) || !eq(v.subarray(top + 20, top + stride), v.subarray(low + 20, low + stride))) throw new Error(`level seams: ${cellKey(c)} skirt pair ${k} does not blend as one`);
    g.skirt.push({ drop: dv.getFloat32(top + 4, true) - dv.getFloat32(low + 4, true), shift: dv.getFloat32(top + 24, true) });
  }
  return g;
}

/** Height the grid's mesh draws at a point given in its vertex steps (the triangles of the mesh). */
function drawnHeight(g: SmoothGrid, u: number, v: number): number {
  const i = Math.min(Math.floor(u), g.n - 2);
  const j = Math.min(Math.floor(v), g.n - 2);
  const fu = u - i;
  const fv = v - j;
  const a = g.y[j * g.n + i]!;
  const b = g.y[j * g.n + i + 1]!;
  const c = g.y[(j + 1) * g.n + i]!;
  const d = g.y[(j + 1) * g.n + i + 1]!;
  return fu + fv <= 1 ? a + (b - a) * fu + (c - a) * fv : d + (c - d) * (1 - fu) + (b - d) * (1 - fv);
}

/** Largest allowed distance in metres between two surfaces that must coincide (32-bit rounding of heights up to 2 km). */
const SEAM_TOLERANCE_M = 1e-3;

/**
 * (e) Seams between levels of the smooth generator. For a cell A, its parent P and the coarser cells next to P:
 * A blended fully into the parent's shape lies on P's surface everywhere (so replacing P by its children shows no
 * jump), carries P's normals and colours at P's vertices, and on a border shared with a coarser neighbour it lies on
 * that neighbour's border (no crack). Same-level neighbours agree in every attribute, also in the blended ones.
 */
export function levelSeams(): (Uint8Array | number)[] {
  const out: (Uint8Array | number)[] = [];
  let worst = 0;
  const near = (a: number, b: number, what: string): void => {
    const d = Math.abs(a - b);
    if (!(d <= SEAM_TOLERANCE_M)) throw new Error(`level seams: ${what}: ${a} against ${b}`);
    if (d > worst) worst = d;
  };
  for (const [x, z, level] of [
    [100, 100, LEAF_LEVEL],
    [-3000, 2500, 7],
    [FAR_X + 100, -100, LEAF_LEVEL],
    [FAR_X + 5000, FAR_X - 5000, ROOT_LEVEL + 1],
  ] as const) {
    const a = smoothGrid(at(x, z, level));
    const A = a.cell;
    const n = a.n;
    const q = n - 1;
    const P = SHAPE.parent(A)!;
    const p = smoothGrid(P);
    // Offset of A inside P, in A's vertex steps.
    const ou = (a.ox - p.ox) / a.step;
    const ov = (a.oz - p.oz) / a.step;

    // 1. A at blend 1 is P's surface; at P's vertices it carries P's normal and colour.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        near(a.y[k]! + a.shift[k]!, drawnHeight(p, (ou + i) / 2, (ov + j) / 2), `${cellKey(A)} vertex ${i}, ${j} blended into ${cellKey(P)}`);
        if (i % 2 === 0 && j % 2 === 0) {
          const pk = ((ov + j) / 2) * n + (ou + i) / 2;
          if (a.shift[k] !== 0 || a.y[k] !== p.y[pk]) throw new Error(`level seams: ${cellKey(A)} vertex ${i}, ${j} is not the parent's vertex`);
          if (!eq(a.bytes(k, ...MORPH.coarseNormal), p.bytes(pk, ...MORPH.ownNormal)) || !eq(a.bytes(k, ...MORPH.coarseColor), p.bytes(pk, ...MORPH.ownColor))) {
            throw new Error(`level seams: ${cellKey(A)} vertex ${i}, ${j} does not carry the normal and colour of ${cellKey(P)}`);
          }
        }
      }
    }

    // 2. Same-level neighbours: every attribute of the shared border agrees, own and blended.
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const b = smoothGrid(cellId(A.face, A.level, A.x + dx, A.y + dy));
      for (let t = 0; t < n; t++) {
        const ka = dx ? t * n + q : q * n + t;
        const kb = dx ? t * n : t;
        // Everything but the cell-local x and z: the height, and all that follows the position.
        if (!eq(a.bytes(ka, ...MORPH.height), b.bytes(kb, ...MORPH.height)) || !eq(a.bytes(ka, ...MORPH.rest), b.bytes(kb, ...MORPH.rest))) {
          throw new Error(`level seams: ${cellKey(A)} and ${cellKey(b.cell)} differ on their border at vertex ${t}`);
        }
        out.push(a.bytes(ka, ...MORPH.height), a.bytes(ka, ...MORPH.rest));
      }
    }

    // 3. Coarser neighbours: the two sides of A that lie on P's border, against the cell of P's level across them.
    const sides: { dx: number; dy: number }[] = [{ dx: A.x % 2 === 0 ? -1 : 1, dy: 0 }, { dx: 0, dy: A.y % 2 === 0 ? -1 : 1 }];
    for (const { dx, dy } of sides) {
      const b = smoothGrid(cellId(P.face, P.level, P.x + dx, P.y + dy));
      for (let t = 0; t < n; t++) {
        // Vertex of A on that side, and the same world point on B's border in B's vertex steps.
        const i = dx ? (dx < 0 ? 0 : q) : t;
        const j = dy ? (dy < 0 ? 0 : q) : t;
        const k = j * n + i;
        const bu = (a.ox + i * a.step - b.ox) / b.step;
        const bv = (a.oz + j * a.step - b.oz) / b.step;
        if (bu < 0 || bu > q || bv < 0 || bv > q) throw new Error(`level seams: ${cellKey(A)} vertex ${i}, ${j} is not on the border of ${cellKey(b.cell)}`);
        if (t % 2 === 0) {
          const bk = bv * n + bu;
          if (a.shift[k] !== 0 || a.y[k] !== b.y[bk] || !eq(a.bytes(k, ...MORPH.coarseNormal), b.bytes(bk, ...MORPH.ownNormal)) || !eq(a.bytes(k, ...MORPH.coarseColor), b.bytes(bk, ...MORPH.ownColor))) {
            throw new Error(`level seams: ${cellKey(A)} vertex ${i}, ${j} differs from the vertex of the coarser ${cellKey(b.cell)}`);
          }
        } else near(a.y[k]! + a.shift[k]!, drawnHeight(b, bu, bv), `${cellKey(A)} vertex ${i}, ${j} on the border of the coarser ${cellKey(b.cell)}`);
      }
    }

    // 4. The skirt: at every border vertex it hangs at least twice as deep as the blend can move the border.
    let deepest = 0;
    for (const s of a.skirt) {
      if (!(s.drop > 0) || s.drop < 2 * Math.abs(s.shift) - SEAM_TOLERANCE_M) throw new Error(`level seams: the skirt of ${cellKey(A)} hangs ${s.drop} m where the border moves ${s.shift} m`);
      if (s.drop > deepest) deepest = s.drop;
    }
    out.push(Math.fround(deepest));
  }
  if (!(worst > 0)) throw new Error('level seams: the cells tested have no vertex between the parent\'s vertices that differs (nothing was tested)');
  return out;
}

/** Deterministic stand-in for a cell's measured error: a fifth of the cells are flat, the rest around the default. */
function scriptedError(c: CellId): number {
  const u = unit(hashInts(SEED, 0x5e1ec7, c.level, c.x, c.y));
  return u < 0.2 ? 0 : SHAPE.edgeM(c.level) * SMOOTH_SELECTION.errorPerEdge * (0.3 + 1.2 * u);
}

/**
 * (f) Coverage with selection by screen-space error. The camera comes down from 6 km to 20 m above the ground while
 * drifting east, stays, and climbs back. A fake executor finishes a fixed number of jobs and uploads per step.
 * Checked at every step: no drawn cell covers another; a root that was covered and is still wanted stays covered
 * completely (no hole, no flicker to empty); no request for a cell whose parent is not loaded; the budgets of cells and
 * jobs hold. A second, short script checks that with more work than free jobs the cells ahead of the view go first.
 */
export function selectionScript(): string[] {
  const budget = 160;
  const config: StreamingConfig = { ...DEFAULT_STREAMING, ...SMOOTH_STREAMING, shape: SHAPE, face: FACE, rootLevel: ROOT_LEVEL, leafLevel: LEAF_LEVEL, maxInFlight: 6, memoryBudgetBytes: 1e9, screenError: { ...SMOOTH_SELECTION, maxCells: budget } };
  const m = new StreamingManager(config);
  const queue: { req: CellRequest; due: number }[] = [];
  const trace: string[] = [];
  const rootArea = SHAPE.edgeM(ROOT_LEVEL) ** 2;
  let covered = new Set<string>();
  let lowestDetail = 1;
  let finest = ROOT_LEVEL;
  let settledAt = -1;
  const steps = 420;
  for (let s = 0; s < steps; s++) {
    // Down (exponentially, so the zoom is even on the screen), stay, up, stay.
    const down = Math.min(1, s / 140);
    const up = Math.min(1, Math.max(0, (s - 200) / 80));
    const altitude = 6000 * (20 / 6000) ** down * (3000 / 20) ** up;
    const x = Math.min(s, 280) * 9;
    const tickets: Ticket[] = [{ id: 'camera', kind: 'camera', center: [x, 0, 300], altitude, base: 0, dir: [1, 0] }];
    const a = m.update(tickets);
    for (const c of a.cancels) {
      const i = queue.findIndex((j) => j.req.key === c.key && j.req.epoch === c.epoch);
      if (i >= 0) queue.splice(i, 1);
    }
    for (const r of a.requests) {
      // Never below a cell that is not loaded.
      if (r.cell.level > ROOT_LEVEL) {
        const ps = m.state(SHAPE.parent(r.cell)!);
        if (ps !== 'MESHED' && ps !== 'RESIDENT') throw new Error(`selection: step ${s} requests ${r.key} while its parent is ${ps}`);
      }
      queue.push({ req: r, due: s + 2 });
    }
    for (const c of a.uploads.slice(0, 3)) m.resident(c, 20_000);
    let done = 0;
    for (let i = 0; i < queue.length && done < 4; ) {
      if (queue[i]!.due > s) {
        i++;
        continue;
      }
      const { req } = queue.splice(i, 1)[0]!;
      m.complete(req, 30_000, scriptedError(req.cell));
      done++;
    }
    const c = m.counters();
    if (c.wanted > budget) throw new Error(`selection: step ${s} wants ${c.wanted} cells, the budget is ${budget}`);
    if (c.inFlight > config.maxInFlight) throw new Error(`selection: step ${s} has ${c.inFlight} jobs in flight`);
    if (c.detail < lowestDetail) lowestDetail = c.detail;
    const drawn = m.drawn();
    for (let i = 0; i < drawn.length; i++) {
      for (let j = 0; j < drawn.length; j++) {
        if (i !== j && covers(drawn[i]!, drawn[j]!)) throw new Error(`selection: step ${s} draws ${cellKey(drawn[i]!)} and ${cellKey(drawn[j]!)} on top of each other`);
      }
    }
    // Coverage per wanted root: either nothing of it is loaded yet, or the drawn cells under it fill it exactly.
    const now = new Set<string>();
    for (const root of m.wanted().filter((w) => w.level === ROOT_LEVEL)) {
      let area = 0;
      for (const d of drawn) if (covers(root, d)) area += SHAPE.edgeM(d.level) ** 2;
      const key = cellKey(root);
      if (area === rootArea) now.add(key);
      else if (area !== 0) throw new Error(`selection: step ${s} covers ${area} m² of root ${key}`);
      else if (covered.has(key)) throw new Error(`selection: step ${s} lost the cover of root ${key}`);
    }
    covered = now;
    for (const d of drawn) if (d.level > finest) finest = d.level;
    if (c.settled && settledAt < 0 && s > 280) settledAt = s;
    trace.push(`${s}|${drawn.map(cellKey).join(';')}|${c.holes}|${c.settled}|${c.detail}`);
  }
  const c = m.counters();
  if (!c.settled || c.holes !== 0 || covered.size === 0 || covered.size !== m.wanted().filter((w) => w.level === ROOT_LEVEL).length) {
    throw new Error(`selection: not settled at the end (holes ${c.holes}, wanted ${c.wanted}, drawn ${c.drawn}, roots covered ${covered.size})`);
  }
  if (finest !== LEAF_LEVEL) throw new Error(`selection: the zoom reached level ${finest} only, expected ${LEAF_LEVEL}`);
  if (!(lowestDetail < 1)) throw new Error('selection: the script must exercise the budget of cells (detail never went down)');
  if (c.detail !== 1) throw new Error(`selection: the detail did not come back after the climb (${c.detail})`);

  // Ahead first: a viewer in the middle of a root looks east; four jobs are free and more roots are wanted.
  const few = new StreamingManager({ ...config, maxInFlight: 4 });
  const eyeX = SHAPE.edgeM(ROOT_LEVEL) / 2;
  const first = few.update([{ id: 'camera', kind: 'camera', center: [eyeX, 0, eyeX], altitude: 100, base: 0, dir: [1, 0] }]);
  const asked = new Set(first.requests.map((r) => r.key));
  if (first.requests.length !== 4 || first.requests.some((r) => SHAPE.center(r.cell)[0] < eyeX)) throw new Error(`selection: the first jobs are not ahead of the view (${[...asked].join(' ')})`);
  if (!few.wanted().some((w) => !asked.has(cellKey(w)) && SHAPE.center(w)[0] < eyeX)) throw new Error('selection: the ahead-first script wants nothing behind the viewer');

  // Preloading: a second ticket far ahead that only preloads leaves the drawn cells exactly as the viewer alone has
  // them, and its cells are fetched all the same; the same ticket without the flag changes what is drawn.
  const run = (extra: Ticket[]): { drawn: string; fetched: string[] } => {
    const one = new StreamingManager({ ...config, maxInFlight: 1 << 20, screenError: { ...SMOOTH_SELECTION } });
    const tickets: Ticket[] = [{ id: 'camera', kind: 'camera', center: [0, 0, 300], altitude: 150, base: 0, dir: [1, 0] }, ...extra];
    for (let s = 0; s < 60; s++) {
      const a = one.update(tickets);
      for (const r of a.requests) one.complete(r, 30_000, scriptedError(r.cell));
      for (const u of a.uploads) one.resident(u, 20_000);
      if (one.settled && !one.stale && a.requests.length === 0 && a.uploads.length === 0) break;
    }
    if (!one.settled) throw new Error('selection: the preload script did not settle');
    if (one.viewer()?.id !== 'camera') throw new Error('selection: the viewer is not the camera ticket');
    return { drawn: one.drawn().map(cellKey).join(';'), fetched: one.log.map((l) => l.slice(l.indexOf(':') + 1)).sort() };
  };
  // 3 km ahead: the coarsest cells near it are also within the viewer's reach, so only the splits can differ.
  const aheadTicket: Ticket = { id: 'predict', kind: 'predict', center: [3000, 0, 300], altitude: 150, base: 1, dir: [1, 0] };
  const alone = run([]);
  const preloaded = run([{ ...aheadTicket, preload: true }]);
  const both = run([aheadTicket]);
  if (preloaded.drawn !== alone.drawn) throw new Error('selection: a preloading ticket changed the drawn cells');
  if (both.drawn === alone.drawn) throw new Error('selection: the preload script needs a second ticket that changes the drawn cells');
  // Everything the same ticket would put on the screen is already fetched by the preloading one, and nothing else.
  const ready = new Set(preloaded.fetched);
  const known = new Set(both.fetched);
  if (preloaded.fetched.length <= alone.fetched.length || both.drawn.split(';').some((k) => !ready.has(k)) || preloaded.fetched.some((k) => !known.has(k))) {
    throw new Error(`selection: a preloading ticket fetched ${preloaded.fetched.length} cells, the same ticket without the flag ${both.fetched.length}, the viewer alone ${alone.fetched.length}`);
  }

  const { requested, completed, cancelled, stale, failed, evicted } = c;
  return [...m.log, ...trace, ...few.log, ...preloaded.fetched, JSON.stringify({ requested, completed, cancelled, stale, failed, evicted, lowestDetail, settledAt })];
}
