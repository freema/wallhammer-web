// Headless check of the mesh builder core and the bare shapes of the engine (`gen-mesh/mesh-builder.ts`,
// `gen-mesh/bare-shapes.ts`), in plain Node, without a browser or graphics. One line per case; exit code 1 when a
// case fails.
//
//   node tools/mesh/check.ts            all cases      (pnpm check:mesh)
//   node tools/mesh/check.ts revolve    only cases whose name contains "revolve"
//
// What it checks: vertex and index counts, closed shapes (every edge used by exactly two triangles, once in each
// direction, after welding equal positions), outward winding (positive volume, close to the analytic one), that a
// mirroring transform flips the winding and keeps the volume positive, that `append` keeps payloads, determinism,
// and that two very different vertex formats (52 bytes with a per-vertex direction computed after building, panel
// coordinates and a tone; 24 bytes with an 8-bit normal, colour with occlusion and four flag bytes) can be written.

import type { VertexLayout } from '../../packages/wallhammer-web/src/base/data.ts';
import { mat34Multiply, mat34RotationY, mat34Scaling, mat34Translation } from '../../packages/wallhammer-web/src/base/mat34.ts';
import { box, cylinder, extrude, polygon, revolve, sweep } from '../../packages/wallhammer-web/src/gen-mesh/bare-shapes.ts';
import type { ShapeVertex } from '../../packages/wallhammer-web/src/gen-mesh/bare-shapes.ts';
import { MeshBuilder } from '../../packages/wallhammer-web/src/gen-mesh/mesh-builder.ts';
import type { VertexFormat } from '../../packages/wallhammer-web/src/gen-mesh/mesh-builder.ts';

// --- Two vertex formats of imagined games ------------------------------------------------------------------------------

/** Format A, 52 bytes: position, normal, an offset direction filled after building, panel coordinates, rgba bytes. */
interface PayloadA {
  dir: [number, number, number];
  line: [number, number, number];
  rgba: [number, number, number, number];
}
const LAYOUT_A: VertexLayout = {
  stride: 52,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
    { name: 'a_dir', size: 3, type: 'f32', offset: 24 },
    { name: 'a_line', size: 3, type: 'f32', offset: 36 },
    { name: 'a_color', size: 4, type: 'u8', offset: 48, normalized: true },
  ],
};
const FORMAT_A: VertexFormat<PayloadA> = {
  layout: LAYOUT_A,
  stride: 52,
  write(view, o, p, n, v) {
    for (let k = 0; k < 3; k++) {
      view.setFloat32(o + k * 4, p[k]!, true);
      view.setFloat32(o + 12 + k * 4, n[k]!, true);
      view.setFloat32(o + 24 + k * 4, v.dir[k]!, true);
      view.setFloat32(o + 36 + k * 4, v.line[k]!, true);
    }
    for (let k = 0; k < 4; k++) view.setUint8(o + 48 + k, v.rgba[k]!);
  },
};

/** Format B, 24 bytes: position, 8-bit normal, rgb + occlusion bytes, four flag bytes. */
interface PayloadB {
  rgb: readonly [number, number, number];
  ao: number;
  flags: readonly [number, number, number, number];
}
const LAYOUT_B: VertexLayout = {
  stride: 24,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i8', normalized: true, offset: 12 },
    { name: 'a_color', size: 4, type: 'u8', normalized: true, offset: 16 },
    { name: 'a_flags', size: 4, type: 'u8', normalized: true, offset: 20 },
  ],
};
const byte = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
const FORMAT_B: VertexFormat<PayloadB> = {
  layout: LAYOUT_B,
  stride: 24,
  write(view, o, p, n, v) {
    for (let k = 0; k < 3; k++) view.setFloat32(o + k * 4, p[k]!, true);
    for (let k = 0; k < 3; k++) view.setInt8(o + 12 + k, Math.max(-127, Math.min(127, Math.round(n[k]! * 127))));
    view.setInt8(o + 15, 0);
    for (let k = 0; k < 3; k++) view.setUint8(o + 16 + k, byte(v.rgb[k]!));
    view.setUint8(o + 19, byte(v.ao));
    for (let k = 0; k < 4; k++) view.setUint8(o + 20 + k, v.flags[k]!);
  },
};

/** Format C, positions and normals only (for geometry cases). */
const FORMAT_C: VertexFormat<null> = {
  layout: { stride: 24, attribs: [{ name: 'a_pos', size: 3, type: 'f32', offset: 0 }, { name: 'a_normal', size: 3, type: 'f32', offset: 12 }] },
  stride: 24,
  write(view, o, p, n) {
    for (let k = 0; k < 3; k++) {
      view.setFloat32(o + k * 4, p[k]!, true);
      view.setFloat32(o + 12 + k * 4, n[k]!, true);
    }
  },
};
const none = (): null => null;
const geo = (): MeshBuilder<null> => new MeshBuilder(FORMAT_C);

// --- Measures ----------------------------------------------------------------------------------------------------------

/** Welded topology: every undirected edge used exactly twice, once in each direction. Degenerate triangles skipped. */
function closedness(b: MeshBuilder<unknown>): { ok: boolean; edges: number; bad: number } {
  const P = b.positions();
  const I = b.indices({ index: 32 });
  const id = new Map<string, number>();
  const weld: number[] = [];
  for (let i = 0; i < P.length / 3; i++) {
    const k = `${Math.round(P[i * 3]! * 1e5)},${Math.round(P[i * 3 + 1]! * 1e5)},${Math.round(P[i * 3 + 2]! * 1e5)}`;
    let w = id.get(k);
    if (w === undefined) id.set(k, (w = id.size));
    weld.push(w);
  }
  const directed = new Map<string, number>();
  for (let t = 0; t < I.length; t += 3) {
    const a = weld[I[t]!]!, c = weld[I[t + 1]!]!, d = weld[I[t + 2]!]!;
    if (a === c || c === d || d === a) continue;
    for (const [x, y] of [[a, c], [c, d], [d, a]] as const) directed.set(`${x}>${y}`, (directed.get(`${x}>${y}`) ?? 0) + 1);
  }
  let bad = 0;
  for (const [k, n] of directed) {
    const [x, y] = k.split('>');
    if (n !== 1 || directed.get(`${y}>${x}`) !== 1) bad++;
  }
  return { ok: bad === 0 && directed.size > 0, edges: directed.size / 2, bad };
}

/** Signed volume of the triangles (positive when they face outward). */
function volume(b: MeshBuilder<unknown>): number {
  const P = b.positions();
  const I = b.indices({ index: 32 });
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3, c = I[t + 1]! * 3, d = I[t + 2]! * 3;
    const ax = P[a]!, ay = P[a + 1]!, az = P[a + 2]!, bx = P[c]!, by = P[c + 1]!, bz = P[c + 2]!, cx = P[d]!, cy = P[d + 1]!, cz = P[d + 2]!;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Triangle normals agree with vertex normals (no face wound against its normal). */
function windingAgrees(b: MeshBuilder<unknown>): number {
  const P = b.positions();
  const N = b.normals();
  const I = b.indices({ index: 32 });
  let bad = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]!, c = I[t + 1]!, d = I[t + 2]!;
    const e1 = [P[c * 3]! - P[a * 3]!, P[c * 3 + 1]! - P[a * 3 + 1]!, P[c * 3 + 2]! - P[a * 3 + 2]!];
    const e2 = [P[d * 3]! - P[a * 3]!, P[d * 3 + 1]! - P[a * 3 + 1]!, P[d * 3 + 2]! - P[a * 3 + 2]!];
    const fn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (Math.hypot(fn[0]!, fn[1]!, fn[2]!) < 1e-9) continue;
    let s = 0;
    for (const v of [a, c, d]) s += fn[0]! * N[v * 3]! + fn[1]! * N[v * 3 + 1]! + fn[2]! * N[v * 3 + 2]!;
    if (s <= 0) bad++;
  }
  return bad;
}

// --- Cases -------------------------------------------------------------------------------------------------------------

interface Result {
  ok: boolean;
  detail: string;
}
const f = (x: number, d = 4): string => x.toFixed(d);
const near = (a: number, b: number, rel: number): boolean => Math.abs(a - b) <= rel * Math.abs(b);

function solid(name: string, make: (b: MeshBuilder<null>) => void, expected: number, rel: number): [string, () => Result] {
  return [name, () => {
    const b = geo();
    make(b);
    const c = closedness(b);
    const v = volume(b);
    const w = windingAgrees(b);
    return { ok: c.ok && v > 0 && (Number.isNaN(expected) || near(v, expected, rel)) && w === 0, detail: `v ${b.vertexCount} i ${b.indexCount} edges ${c.edges} open ${c.bad} volume ${f(v)} (expect ${Number.isNaN(expected) ? 'positive' : f(expected)}) against-normal ${w}` };
  }];
}

const PI = Math.PI;
const cases: [string, () => Result][] = [
  ['revolve-counts', () => {
    const b = geo();
    revolve(b, [[1, 0], [1.2, 1], [0.8, 2]], none, { segments: 8, capStart: true, capEnd: true });
    // Sides: (8 + 1) columns × 3 rows; 8 × 2 cells × 2 triangles. Caps: centre + 8 rim, 8 triangles each.
    const ok = b.vertexCount === 27 + 18 && b.indexCount === 96 + 48;
    return { ok, detail: `vertices ${b.vertexCount} (45) indices ${b.indexCount} (144)` };
  }],
  solid('revolve-cylinder-closed', (b) => revolve(b, [[1, 0], [1, 2]], none, { segments: 64, capStart: true, capEnd: true }), 2 * PI, 0.01),
  solid('revolve-cylinder-flat-closed', (b) => revolve(b, [[1, 0], [1, 2]], none, { segments: 64, smooth: false, capStart: true, capEnd: true, capFan: false }), 2 * PI, 0.01),
  solid('revolve-cone-apex-closed', (b) => revolve(b, [[1, 0], [0, 3]], none, { segments: 64, capStart: true }), PI, 0.01),
  solid('revolve-sphere-closed', (b) => {
    const prof: [number, number][] = [];
    for (let k = 0; k <= 32; k++) prof.push([Math.sin((PI * k) / 32), -Math.cos((PI * k) / 32)]);
    revolve(b, prof, none, { segments: 64 });
  }, (4 / 3) * PI, 0.01),
  solid('revolve-partial-sides-closed', (b) => revolve(b, [[1, 0], [1.5, 1], [1, 2]], none, { segments: 32, from: 0.3, to: 0.3 + PI, sides: true, capStart: true, capEnd: true }), PI * (1 + 0.5 + 0.25 / 3), 0.01),
  solid('revolve-warp-closed', (b) => revolve(b, [[1, 0], [1, 1], [1, 2]], none, { segments: 32, capStart: true, capEnd: true, warp: (p, i, j) => { const k = 1 + 0.1 * Math.sin(i * 1.7 + j); p[0] *= k; p[2] *= k; } }), 2 * PI, 0.2),
  solid('sweep-tube-caps-closed', (b) => {
    const sec: [number, number][] = [];
    for (let k = 0; k < 32; k++) sec.push([0.5 * Math.cos((2 * PI * k) / 32), 0.5 * Math.sin((2 * PI * k) / 32)]);
    sweep(b, [[0, 0, 0], [0, 0, 2], [1, 0, 3], [2, 0, 3]], sec, none, { caps: true });
  }, 0.25 * PI * (3 + Math.SQRT2), 0.1),
  solid('sweep-clockwise-section-closed', (b) => {
    sweep(b, [[0, 0, 0], [0, 1, 0], [0, 2, 0.5]], [[0.2, 0.2], [0.2, -0.2], [-0.2, -0.2], [-0.2, 0.2]], none, { caps: true, smooth: false, capFan: true });
  }, 0.16 * (1 + Math.sqrt(1.25)), 0.1),
  solid('sweep-smooth-path-closed', (b) => {
    sweep(b, [[0, 0, 0], [1, 1, 0], [2, 0, 1], [3, 1, 1]], [[0.2, 0], [0, 0.2], [-0.2, 0], [0, -0.2]], none, { caps: true, subdivide: 6, twist: (t) => t * PI, scale: (t) => 1 - 0.5 * t });
  }, NaN, 0),
  solid('sweep-loop-torus-closed', (b) => {
    const path: [number, number, number][] = [];
    for (let k = 0; k < 64; k++) path.push([2 * Math.cos((2 * PI * k) / 64), 0, 2 * Math.sin((2 * PI * k) / 64)]);
    const sec: [number, number][] = [];
    for (let k = 0; k < 24; k++) sec.push([0.5 * Math.cos((2 * PI * k) / 24), 0.5 * Math.sin((2 * PI * k) / 24)]);
    sweep(b, path, sec, none, { loop: true });
  }, 2 * PI * PI * 2 * 0.25, 0.02),
  solid('sweep-along-octagon-closed', (b) => {
    const sec: [number, number][] = [];
    for (let k = 0; k < 8; k++) sec.push([0.3 * Math.cos((2 * PI * k) / 8), 0.3 * Math.sin((2 * PI * k) / 8)]);
    sweep(b, [[0, 0, 0], [1, 0.2, 0], [2, 0, 0], [3, -0.1, 0.2]], sec, none, { caps: true, smooth: 'along' });
  }, NaN, 0),
  solid('revolve-along-cone-closed', (b) => revolve(b, [[1, 0], [0.6, 1], [0, 2]], none, { segments: 12, smooth: 'along', capStart: true }), NaN, 0),
  solid('extrude-concave-closed', (b) => extrude(b, [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]], 0, 1, none), 3, 1e-6),
  solid('extrude-smooth-closed', (b) => extrude(b, [[0, 0], [2, 0], [2, 1], [0, 1]], -1, 1, none, { smooth: true, capFan: true }), 4, 1e-6),
  solid('box-closed', (b) => box(b, [-1, 0, -2], [1, 3, 2], none), 24, 1e-6),
  solid('cylinder-frustum-closed', (b) => cylinder(b, 1, 0, 1, none, { radiusTop: 0.5, segments: 96 }), (PI / 3) * (1 + 0.5 + 0.25), 0.01),
  ['polygon-concave-area', () => {
    const b = geo();
    const pts: [number, number, number][] = [[0, 0, 0], [3, 0, 0], [3, 3, 0], [2, 3, 0], [2, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]];
    polygon(b, pts, none);
    const P = b.positions(), I = b.indices();
    let area = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3, c = I[t + 1]! * 3, d = I[t + 2]! * 3;
      area += ((P[c]! - P[a]!) * (P[d + 1]! - P[a + 1]!) - (P[c + 1]! - P[a + 1]!) * (P[d]! - P[a]!)) / 2;
    }
    return { ok: Math.abs(area - 7) < 1e-9, detail: `area ${f(area)} (7), all triangles counter-clockwise about +z` };
  }],
  ['mirror-flips-winding', () => {
    const plain = geo();
    box(plain, [0, 0, 0], [1, 1, 1], none);
    const mir = geo();
    mir.with(mat34Scaling(-1, 1, 1), () => box(mir, [0, 0, 0], [1, 1, 1], none));
    const a = plain.indices(), c = mir.indices();
    const flipped = a[0] === c[0] && a[1] === c[2] && a[2] === c[1];
    const v = volume(mir);
    const cl = closedness(mir);
    const w = windingAgrees(mir);
    // The same through append: a mirrored append flips too.
    const app = geo();
    app.append(plain, mat34Scaling(1, -1, 1));
    const va = volume(app);
    return { ok: flipped && cl.ok && near(v, 1, 1e-6) && w === 0 && near(va, 1, 1e-6) && mir.mirrored === false, detail: `first triangle ${a[0]},${a[1]},${a[2]} -> ${c[0]},${c[1]},${c[2]} volume ${f(v)} appended ${f(va)} against-normal ${w}` };
  }],
  ['transform-stack', () => {
    const b = geo();
    b.push(mat34Translation(10, 0, 0)).push(mat34RotationY(PI / 2));
    const i = b.vertex([1, 0, 0], [1, 0, 0], null);
    b.pop().pop();
    const j = b.vertex([1, 0, 0], [1, 0, 0], null);
    const p = b.position(i), n = b.normal(i), q = b.position(j);
    let threw = false;
    try {
      b.pop();
    } catch {
      threw = true;
    }
    const ok = Math.abs(p[0] - 10) < 1e-12 && Math.abs(p[2] + 1) < 1e-12 && Math.abs(n[2] + 1) < 1e-12 && q[0] === 1 && threw;
    return { ok, detail: `p ${p.map((x) => f(x, 3))} n ${n.map((x) => f(x, 3))} after pop ${q.map((x) => f(x, 3))} pop-underflow throws ${threw}` };
  }],
  ['append-keeps-payload', () => {
    const red: PayloadB = { rgb: [1, 0, 0], ao: 1, flags: [0, 0, 2, 1] };
    const blue: PayloadB = { rgb: [0, 0, 1], ao: 0.5, flags: [255, 0, 6, 0] };
    const part = new MeshBuilder(FORMAT_B);
    box(part, [0, 0, 0], [1, 1, 1], (s) => (s.part === 'side' ? red : blue));
    const all = new MeshBuilder(FORMAT_B);
    cylinder(all, 1, 0, 1, () => red, { segments: 6 });
    const base = all.vertexCount;
    all.append(part, mat34Multiply(mat34Translation(3, 0, 0), mat34RotationY(0.4)));
    let same = 0;
    for (let i = 0; i < part.vertexCount; i++) if (all.payload(base + i) === part.payload(i)) same++;
    const bytes = all.vertices();
    const view = new DataView(bytes.buffer);
    let bytesOk = true;
    for (let i = 0; i < part.vertexCount; i++) {
      const v = part.payload(i);
      const o = (base + i) * 24;
      if (view.getUint8(o + 16) !== byte(v.rgb[0]) || view.getUint8(o + 22) !== v.flags[2] || view.getUint8(o + 19) !== byte(v.ao)) bytesOk = false;
    }
    const ok = same === part.vertexCount && bytesOk && all.indexCount === 6 * 2 * 3 + 2 * 6 * 3 + part.indexCount;
    return { ok, detail: `payloads kept ${same}/${part.vertexCount}, bytes ${bytesOk ? 'match' : 'differ'}, indices ${all.indexCount}` };
  }],
  ['format-52-direction-after-build', () => {
    // A game format whose per-vertex direction depends on all faces meeting at a position: computed after building
    // from positions() and normals(), written back through edit(). Panel coordinates come from the shape callback.
    const b = new MeshBuilder(FORMAT_A);
    const corner: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const pay = (s: ShapeVertex): PayloadA => ({ dir: [0, 0, 0], line: s.corner >= 0 ? [corner[s.corner % 4]![0], corner[s.corner % 4]![1], 0.5] : [0.5, 0.5, 0.5], rgba: [200, 100, 50, 128] });
    box(b, [-1, 0, -1], [1, 2, 1], pay);
    const P = b.positions(), N = b.normals();
    const sum = new Map<string, [number, number, number]>();
    const key = (i: number): string => `${Math.round(P[i * 3]! * 1000)},${Math.round(P[i * 3 + 1]! * 1000)},${Math.round(P[i * 3 + 2]! * 1000)}`;
    for (let i = 0; i < b.vertexCount; i++) {
      const s = sum.get(key(i)) ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) s[k] += N[i * 3 + k]!;
      sum.set(key(i), s);
    }
    b.edit((_p, _n, v, i) => ({ ...v, dir: sum.get(key(i))! }));
    const mesh = b.build();
    const view = new DataView((mesh.vertices as Uint8Array).buffer);
    // Every box corner vertex sums three axis normals: |dir| = √3.
    let ok = mesh.layout.stride === 52 && mesh.indices instanceof Uint16Array && b.vertexCount === 24;
    for (let i = 0; i < b.vertexCount; i++) {
      const d = Math.hypot(view.getFloat32(i * 52 + 24, true), view.getFloat32(i * 52 + 28, true), view.getFloat32(i * 52 + 32, true));
      if (Math.abs(d - Math.sqrt(3)) > 1e-5 || view.getUint8(i * 52 + 51) !== 128) ok = false;
    }
    return { ok, detail: `vertices ${b.vertexCount}, stride ${mesh.layout.stride}, direction length √3 at every corner, tone byte kept` };
  }],
  ['live-views-and-set-triangle', () => {
    // positionData/normalData/indexData read the builder without a copy and follow it; setTriangle turns a winding.
    const b = geo();
    box(b, [-1, 0, -1], [1, 2, 1], () => null);
    const P = b.positionData, I = b.indexData;
    const copy = b.positions();
    let same = P.length === copy.length && b.normalData.length === copy.length && I.length === b.indexCount;
    for (let i = 0; i < copy.length; i++) if (Math.abs(P[i]! - copy[i]!) > 1e-6) same = false;
    const before = windingAgrees(b);
    b.setTriangle(0, I[0]!, I[2]!, I[1]!);
    const turned = windingAgrees(b);
    b.vertex([0, 0, 0], [0, 1, 0], null);
    const live = P.length === copy.length + 3 && I.length === b.indexCount;
    let threw = false;
    try {
      b.setTriangle(b.triangleCount, 0, 1, 2);
    } catch {
      threw = true;
    }
    let threwVertex = false;
    try {
      b.setTriangle(0, 0, 1, b.vertexCount);
    } catch {
      threwVertex = true;
    }
    const ok = same && before === 0 && turned === 1 && live && threw && threwVertex;
    return { ok, detail: `views equal the copies: ${same}; wrong windings ${before} → ${turned} after turning one; views follow new vertices: ${live}; out of range throws: triangle ${threw}, vertex ${threwVertex}` };
  }],
  ['format-24-normal-bytes', () => {
    const b = new MeshBuilder(FORMAT_B);
    b.with(mat34Scaling(2, 1, 1), () => revolve(b, [[1, 0], [1, 1]], (s) => ({ rgb: [s.u, s.v, 0], ao: 1, flags: [0, 0, 1, 0] }), { segments: 12 }));
    const mesh = b.build({ index: 32 });
    const view = new DataView((mesh.vertices as Uint8Array).buffer);
    let ok = mesh.indices instanceof Uint32Array;
    for (let i = 0; i < b.vertexCount; i++) {
      const n = [view.getInt8(i * 24 + 12) / 127, view.getInt8(i * 24 + 13) / 127, view.getInt8(i * 24 + 14) / 127];
      if (Math.abs(Math.hypot(n[0]!, n[1]!, n[2]!) - 1) > 0.02) ok = false;
    }
    return { ok, detail: `vertices ${b.vertexCount}, normals unit after a non-uniform scale, 32-bit indices on request` };
  }],
  ['sweep-normals-outward', () => {
    const b = geo();
    const path: [number, number, number][] = [[0, 0, 0], [0, 1, 0], [1, 2, 0], [2, 2, 1]];
    let bad = 0;
    sweep(b, path, [[0.3, 0], [0, 0.3], [-0.3, 0], [0, -0.3]].reverse() as [number, number][], (s) => {
      if (s.part === 'side') {
        const c = path[s.j]!;
        if ((s.p[0] - c[0]) * s.n[0] + (s.p[1] - c[1]) * s.n[1] + (s.p[2] - c[2]) * s.n[2] <= 0) bad++;
      }
      return null;
    });
    return { ok: bad === 0, detail: `side normals pointing in: ${bad} (clockwise section turned around)` };
  }],
  ['facts-reported', () => {
    const seen = { side: 0, start: 0, end: 0, cut: 0, centre: 0, maxU: 0, faces: new Set<number>() };
    const b = geo();
    revolve(b, [[1, 0], [1, 1]], (s) => {
      seen[s.part]++;
      if (s.centre) seen.centre++;
      if (s.part === 'side') seen.maxU = Math.max(seen.maxU, s.u);
      if (s.face >= 0) seen.faces.add(s.face);
      return null;
    }, { segments: 8, smooth: false, capStart: true, capEnd: true });
    const ok = seen.side === 8 * 4 && seen.start === 9 && seen.end === 9 && seen.centre === 2 && seen.maxU === 1 && seen.faces.size === 10;
    return { ok, detail: `side ${seen.side} start ${seen.start} end ${seen.end} centres ${seen.centre} max u ${seen.maxU} faces ${seen.faces.size}` };
  }],
  ['deterministic', () => {
    const make = (): Uint8Array => {
      const b = new MeshBuilder(FORMAT_B);
      sweep(b, [[0, 0, 0], [1, 2, 0], [3, 2, 1]], [[0.2, 0], [0, 0.2], [-0.2, 0]], (s) => ({ rgb: [s.u, s.v, 0.5], ao: 1, flags: [s.i, s.j, 0, 0] }), { subdivide: 5, caps: true });
      return b.vertices();
    };
    const a = make(), c = make();
    let same = a.length === c.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== c[i]) same = false;
    return { ok: same, detail: `${a.length} bytes, two runs ${same ? 'identical' : 'differ'}` };
  }],
];

const filter = process.argv[2] ?? '';
let failed = 0;
let run = 0;
const t0 = performance.now();
for (const [name, fn] of cases) {
  if (filter && !name.includes(filter)) continue;
  run++;
  let r: Result;
  try {
    r = fn();
  } catch (e) {
    r = { ok: false, detail: `threw ${(e as Error).stack ?? e}` };
  }
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${r.detail}`);
}
console.log(`check:mesh: ${run - failed}/${run} ok in ${f(performance.now() - t0, 0)} ms`);
process.exit(failed ? 1 : 0);
