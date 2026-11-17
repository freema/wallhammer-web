// Scenarios for the golden hashes of streamed tiles: the bisected surface (gen-mesh), packed meshes (gen-mesh) and the
// GPU ceiling of the streaming manager (world). Each returns plain data to hash and throws when a property that must
// hold does not.

import type { MeshData, VertexLayout } from '../../../packages/wallhammer-web/src/base/index.ts';
import { FlatWorld, cellKey } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { BISECT_SURFACE_LAYOUT, bisectSurface, packFrame, packMesh, packUniform, packedLayout, packedMaterial } from '../../../packages/wallhammer-web/src/gen-mesh/index.ts';
import { DEFAULT_STREAMING, StreamingManager } from '../../../packages/wallhammer-web/src/world/index.ts';
import type { CellRequest, StreamingConfig } from '../../../packages/wallhammer-web/src/world/index.ts';

/** A fixed rolling surface with a flat part: height at grid point (i, j) of a square with `quads` quads. */
function surfaceHeights(quads: number): Float32Array {
  const wide = quads + 3;
  const h = new Float32Array(wide * wide);
  for (let j = 0; j < wide; j++) {
    for (let i = 0; i < wide; i++) {
      const x = (i - 1) / quads;
      const z = (j - 1) / quads;
      // Flat in one quarter, a ridge and a dip elsewhere.
      h[j * wide + i] = x < 0.5 && z < 0.5 ? 120 : 120 + 18 * Math.fround(Math.sin(x * 5.1) * Math.cos(z * 3.7)) + 6 * (x - 0.5) * (z - 0.5);
    }
  }
  return h;
}

/**
 * The bisected surface at three tolerances, whole and cut off, with skirts and one cut side. Checks: fewer triangles
 * with a larger tolerance, every index in range, every surface vertex within the tolerance of the grid where it sits.
 */
export function bisectScript(): unknown[] {
  const quads = 32;
  const edgeM = 256;
  const heights = surfaceHeights(quads);
  const out: unknown[] = [BISECT_SURFACE_LAYOUT];
  let last = Infinity;
  for (const toleranceM of [0, 0.25, 2]) {
    const s = bisectSurface(heights, { quads, edgeM, toleranceM, stepY: 1 / 64, heightOrigin: 128, skirtM: 4 });
    if (s.triangles > last) throw new Error(`bisectSurface: tolerance ${toleranceM} gave more triangles (${s.triangles}) than a smaller one (${last})`);
    last = s.triangles;
    if (s.triangles > s.gridTriangles) throw new Error(`bisectSurface: ${s.triangles} triangles, the full grid has ${s.gridTriangles}`);
    const vertices = s.mesh.vertices.byteLength / BISECT_SURFACE_LAYOUT.stride;
    for (const i of s.mesh.indices!) if (i >= vertices) throw new Error(`bisectSurface: index ${i} of ${vertices} vertices`);
    if (s.mesh.count !== s.mesh.indices!.length || s.mesh.count % 3 !== 0) throw new Error('bisectSurface: index count');
    out.push(s.mesh.vertices, s.mesh.indices, s.triangles, s.gridTriangles, Math.round(s.minY * 64), Math.round(s.maxY * 64));
  }
  // Cut off at 200 m × 136 m, the far x side a cut down to 90 m.
  const cut = bisectSurface(heights, { quads, edgeM, toleranceM: 0.25, stepY: 1 / 64, heightOrigin: 128, skirtM: 4, cuts: [null, 90, null, null], clip: [0, 0, 200, 136] });
  const v = new Int16Array(cut.mesh.vertices.buffer, cut.mesh.vertices.byteOffset, cut.mesh.vertices.byteLength / 2);
  const maxX = Math.round((200 / edgeM) * 16384);
  const maxZ = Math.round((136 / edgeM) * 16384);
  for (let k = 0; k < v.length; k += 8) {
    if (v[k]! < 0 || v[k]! > maxX || v[k + 2]! < 0 || v[k + 2]! > maxZ) throw new Error(`bisectSurface: vertex ${k / 8} lies outside the clip (${v[k]}, ${v[k + 2]})`);
  }
  out.push(cut.mesh.vertices, cut.mesh.indices, cut.triangles);
  return out;
}

const SOUP_LAYOUT: VertexLayout = {
  stride: 20,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_tone', size: 4, type: 'u8', normalized: true, offset: 12 },
    { name: 'a_part', size: 1, type: 'f32', offset: 16 },
  ],
};

/** Three boxes as loose triangles (36 vertices each, corners repeated), one span per box. */
function boxSoup(): { mesh: MeshData; spans: number[] } {
  const corners = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  const boxes = 3;
  const data = new DataView(new ArrayBuffer(boxes * corners.length * SOUP_LAYOUT.stride));
  let o = 0;
  for (let b = 0; b < boxes; b++) {
    for (const c of corners) {
      data.setFloat32(o, 1000 + b * 31.5 + (c & 1) * 12.25, true);
      data.setFloat32(o + 4, 140 + ((c >> 1) & 1) * (9 + b), true);
      data.setFloat32(o + 8, 2000 + b * 7 + ((c >> 2) & 1) * 20.5, true);
      data.setUint8(o + 12, 40 * b);
      data.setUint8(o + 13, 200);
      data.setUint8(o + 14, 17);
      data.setUint8(o + 15, 255);
      data.setFloat32(o + 16, b, true);
      o += SOUP_LAYOUT.stride;
    }
  }
  return { mesh: { layout: SOUP_LAYOUT, vertices: new Uint8Array(data.buffer), indices: null, count: boxes * corners.length }, spans: [0, 36, 72, 108] };
}

/**
 * Packed meshes: loose triangles become indexed (eight vertices per box), a span packed alone has the bytes it has in
 * the whole, an indexed mesh keeps its vertices, positions come back within half a step; the layout and the rewritten
 * shader of the packed material.
 */
export function packScript(): unknown[] {
  const frame = packFrame(256, [768, 0, 1792], 128, 1 / 64);
  const soup = boxSoup();
  const whole = packMesh(soup.mesh, frame, { spans: soup.spans });
  const stride = SOUP_LAYOUT.stride - 4;
  if (whole.clamped !== 0) throw new Error(`packMesh: ${whole.clamped} positions clamped`);
  if (whole.mesh.vertices.byteLength !== 3 * 8 * stride) throw new Error(`packMesh: ${whole.mesh.vertices.byteLength / stride} vertices, 24 expected`);
  if (whole.mesh.count !== 108 || !(whole.mesh.indices instanceof Uint16Array)) throw new Error('packMesh: index count or type');
  const all = new Uint8Array(whole.mesh.vertices.buffer, whole.mesh.vertices.byteOffset, whole.mesh.vertices.byteLength);
  for (let s = 0; s < 3; s++) {
    // The middle box alone, as a page would pack one object again.
    const src = new Uint8Array(soup.mesh.vertices.buffer, soup.spans[s]! * SOUP_LAYOUT.stride, 36 * SOUP_LAYOUT.stride);
    const one = packMesh({ layout: SOUP_LAYOUT, vertices: src, indices: null, count: 36 }, frame, { spans: [0, 36] });
    const own = new Uint8Array(one.mesh.vertices.buffer, one.mesh.vertices.byteOffset, one.mesh.vertices.byteLength);
    const first = whole.spans[s]! * stride;
    if (own.length !== (whole.spans[s + 1]! - whole.spans[s]!) * stride) throw new Error(`packMesh: span ${s} alone has another size`);
    for (let k = 0; k < own.length; k++) if (own[k] !== all[first + k]) throw new Error(`packMesh: span ${s} alone differs at byte ${k}`);
  }
  // Positions back from the steps.
  const packed = new DataView(all.buffer, all.byteOffset, all.byteLength);
  const source = new DataView(soup.mesh.vertices.buffer);
  for (let i = 0; i < 108; i++) {
    const at = whole.mesh.indices![i]! * stride;
    const x = frame.origin[0] + packed.getInt16(at, true) * frame.stepXZ;
    const y = frame.origin[1] + packed.getInt16(at + 2, true) * frame.stepY;
    const z = frame.origin[2] + packed.getInt16(at + 4, true) * frame.stepXZ;
    const o = i * SOUP_LAYOUT.stride;
    if (Math.abs(x - source.getFloat32(o, true)) > frame.stepXZ / 2 + 1e-6 || Math.abs(y - source.getFloat32(o + 4, true)) > frame.stepY / 2 + 1e-6 || Math.abs(z - source.getFloat32(o + 8, true)) > frame.stepXZ / 2 + 1e-6) {
      throw new Error(`packMesh: vertex ${i} moved by more than half a step`);
    }
  }
  // An indexed mesh keeps its vertices and their order.
  const indexed = packMesh({ layout: SOUP_LAYOUT, vertices: soup.mesh.vertices, indices: Uint32Array.from({ length: 108 }, (_, i) => 107 - i), count: 108 }, frame);
  if (indexed.mesh.vertices.byteLength !== 108 * stride || !(indexed.mesh.indices instanceof Uint16Array)) throw new Error('packMesh: an indexed mesh changed its vertices');
  const material = packedMaterial({
    name: 'probe',
    attribs: { a_pos: 0, a_tone: 1, a_part: 2 },
    passes: { shadow: 'depth', color: { vs: '#include <header>\nin vec3 a_pos;\nin vec4 a_tone;\nout vec4 v_tone;\nvoid main() {\n  v_tone = a_tone;\n  gl_Position = u_viewProj * vec4(a_pos, 1.0);\n}', fs: 'void main() {}' } },
  });
  return [whole.mesh.vertices, whole.mesh.indices, whole.spans, indexed.mesh.vertices, indexed.mesh.indices, packedLayout(SOUP_LAYOUT), packUniform(65536, 1 / 64, 128), material];
}

/**
 * The GPU ceiling of the streaming manager on a long pan: a fake executor finishes jobs and uploads cells of a fixed
 * size. After every step the cells hold no more GPU bytes than the ceiling leaves (the coarsest level is exempt and
 * small), and the cover never has a hole once it was whole. Returns the trace of every step.
 */
export function ceilingScript(): string[] {
  const shape = new FlatWorld();
  const cellBytes = 40_000;
  const ceiling = 2_400_000;
  const reserve = 800_000;
  const config: StreamingConfig = { ...DEFAULT_STREAMING, shape, rootLevel: 4, leafLevel: 8, maxInFlight: 8, memoryBudgetBytes: 64_000_000, gpuBudgetBytes: ceiling };
  const m = new StreamingManager(config);
  m.gpuReserveBytes = reserve;
  const queue: { req: CellRequest; due: number }[] = [];
  const onGpu = new Set<string>();
  const trace: string[] = [];
  let whole = false;
  let pressed = 0;
  for (let s = 0; s < 400; s++) {
    // Stand, pan east for 18 km, stand again.
    const x = 500 + Math.max(0, Math.min(300, s - 40)) * 60;
    const a = m.update([{ id: 'view', kind: 'camera', center: [x, 0, 700], altitude: 120, base: 0, dir: [1, 0] }]);
    for (const c of a.cancels) {
      const i = queue.findIndex((j) => j.req.key === c.key && j.req.epoch === c.epoch);
      if (i >= 0) queue.splice(i, 1);
    }
    for (const c of [...a.releases, ...a.evictions]) onGpu.delete(cellKey(c));
    for (const r of a.requests) queue.push({ req: r, due: s + 1 });
    for (const c of a.uploads.slice(0, 4)) {
      m.resident(c, cellBytes);
      onGpu.add(cellKey(c));
    }
    let done = 0;
    for (let i = 0; i < queue.length && done < 6; ) {
      if (queue[i]!.due > s) {
        i++;
        continue;
      }
      m.complete(queue.splice(i, 1)[0]!.req, cellBytes);
      done++;
    }
    const c = m.counters();
    if (c.gpuBytes !== onGpu.size * cellBytes) throw new Error(`gpu ceiling: step ${s}: the manager counts ${c.gpuBytes} bytes, the executor holds ${onGpu.size * cellBytes}`);
    // What the ceiling leaves, plus the uploads of this step (they are counted before they are made) and the exempt coarsest cells.
    let coarsest = 0;
    for (const k of onGpu) if (k.split('/')[1] === '4') coarsest++;
    if (c.gpuBytes > ceiling - reserve + coarsest * cellBytes) throw new Error(`gpu ceiling: step ${s} holds ${c.gpuBytes} bytes on the GPU, ${ceiling - reserve} allowed`);
    if (c.holes === 0 && c.drawn > 0) whole = true;
    else if (whole && s < 40) throw new Error(`gpu ceiling: step ${s}: the cover lost a cell while the view stood still`);
    const p = m.gpuPressure();
    pressed += p.released + p.deferred;
    trace.push(`${s}|${c.gpuBytes}|${p.released}|${p.deferred}|${c.drawn}|${c.holes}`);
  }
  if (pressed === 0) throw new Error('gpu ceiling: the scenario never reached the ceiling');
  if (m.counters().holes !== 0) throw new Error('gpu ceiling: the cover has a hole at the end');
  return trace;
}
