// Golden scenarios of the shadow modes that keep areas in the map, as far as they run without a GPU:
// the placement of an area on the block grid (which rectangles a scripted focus path makes it draw, checked against
// a model of the map), whole frames of a renderer with a stand-in device (every lookup of a frame lands where the
// point was drawn) and the light horizon of a small surface.
//
//   node tools/golden/shadow-scenario.ts    prints the results

import type { Vec3 } from '../../../packages/wallhammer-web/src/base/math.ts';
import type { View } from '../../../packages/wallhammer-web/src/base/view.ts';
import type { Device } from '../../../packages/wallhammer-web/src/gpu/index.ts';
import { PerspectiveOrbitRig, SteppedOrthoRig } from '../../../packages/wallhammer-web/src/camera/index.ts';
import { Renderer } from '../../../packages/wallhammer-web/src/render/renderer.ts';
import { AREA_BLOCKS, AREA_REACH_BLOCKS, followFocus, ladderStep, lightFrame, newShadowArea } from '../../../packages/wallhammer-web/src/render/shadow-areas.ts';
import { SurfaceRaster, horizonTexture, lightHorizon } from '../../../packages/wallhammer-web/src/gen-tex/index.ts';

const N = AREA_BLOCKS;

/**
 * One area follows a scripted focus path. A model of the map remembers which world block every map block holds;
 * after every step each block of the area must be found at its address, the focus must be within the reach, and a
 * step must draw exactly the blocks the area did not cover before.
 */
export function areaScript(): number[] {
  const out: number[] = [];
  for (const around of [true, false]) {
    const a = newShadowArea();
    const blockM = 51.2;
    // World block (x, y) kept at each map block, as x * 100000 + y; −1: nothing drawn yet.
    const map = new Float64Array(N * N).fill(-1);
    const id = (x: number, y: number): number => (x + 50000) * 100000 + (y + 50000);
    let fx = 1234.5;
    let fy = -987.6;
    // Small steps, a rest, a diagonal run, steps longer than a block, a jump farther than the area, the way back.
    const moves: [dx: number, dy: number, times: number][] = [[9, 0, 30], [0, 0, 3], [7, 11, 40], [-80, 20, 6], [0, -130, 4], [3000, 0, 1], [-13, -13, 30], [-0.5, 0.5, 200]];
    let first = true;
    let stepsDrawn = 0;
    let blocksDrawn = 0;
    for (const [dx, dy, times] of moves) {
      for (let k = 0; k < times; k++) {
        if (!first) {
          fx += dx;
          fy += dy;
        }
        const before = { bx: a.bx, by: a.by };
        const rects = followFocus(a, fx, fy, blockM, first, around);
        // Everything is drawn at the start and after a step as long as the area; otherwise only the uncovered blocks.
        const whole = first || !around || Math.abs(a.bx - before.bx) >= N || Math.abs(a.by - before.by) >= N;
        first = false;
        let drawn = 0;
        const fresh = new Uint8Array(N * N);
        for (const r of rects) {
          if (r.x1 <= r.x0 || r.y1 <= r.y0 || r.tx + (r.x1 - r.x0) > N || r.ty + (r.y1 - r.y0) > N) throw new Error('shadow areas: a rectangle leaves the map');
          for (let y = r.y0; y < r.y1; y++) {
            for (let x = r.x0; x < r.x1; x++) {
              const at = (r.ty + y - r.y0) * N + r.tx + x - r.x0;
              if (fresh[at]) throw new Error('shadow areas: a block is drawn twice in one step');
              fresh[at] = 1;
              map[at] = id(a.bx + x, a.by + y);
              drawn++;
              const held = a.bx + x >= before.bx && a.bx + x < before.bx + N && a.by + y >= before.by && a.by + y < before.by + N;
              if (!whole && held) throw new Error('shadow areas: a kept block is drawn again');
            }
          }
        }
        // Every block of the area is in the map where the lookup will read it.
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const at = ((a.startY + y) % N) * N + ((a.startX + x) % N);
            if (map[at] !== id(a.bx + x, a.by + y)) throw new Error(`shadow areas: block ${x}, ${y} is not where the lookup reads it`);
          }
        }
        // The reach around the focus lies inside the area.
        for (const [f, b] of [[fx, a.bx], [fy, a.by]] as const) {
          const c = f / blockM - b;
          if (c - AREA_REACH_BLOCKS < 0 || c + AREA_REACH_BLOCKS > N) throw new Error('shadow areas: the reach leaves the area');
        }
        if (drawn > 0) stepsDrawn++;
        blocksDrawn += drawn;
        out.push(a.bx, a.by, a.startX, a.startY, drawn);
      }
    }
    // Following the path around the map's edges must draw far fewer blocks than drawing the area anew at each step.
    if (around && blocksDrawn >= stepsDrawn * N * N * 0.5) throw new Error('shadow areas: steps redraw too much');
    out.push(stepsDrawn, blocksDrawn);
  }
  // The ladder of block sizes: grows with the view, keeps its step inside the dead band, never passes the top.
  let step = -1;
  for (const half of [100, 250, 400, 420, 380, 300, 900, 1500, 5000, 20000, 6000, 1500, 200, 60]) {
    step = ladderStep(half, 51.2, 6, 0.75, step);
    const shown = 51.2 * 2 ** (step / 2) * AREA_REACH_BLOCKS * 0.75;
    if (step < 6 && shown < half) throw new Error('shadow areas: the ladder step does not hold the view');
    out.push(step);
  }
  // Light frames: unit, perpendicular axes for every direction, straight above included.
  for (const d of [[0, 1, 0], [0.6, 0.8, 0], [0, 0.995, 0.0998749], [-0.3, 0.2, 0.9327379], [0, 0.99, 0.1410674]] as [number, number, number][]) {
    const f = lightFrame(d);
    const dots = [f.right, f.up, f.forward].flatMap((u, i, all) => all.map((v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).map((v, j) => Math.abs(v - (i === j ? 1 : 0))));
    if (dots.some((e) => !(e < 1e-6))) throw new Error('shadow areas: the light frame is not a set of unit perpendicular axes');
    out.push(...[...f.right, ...f.up].map((v) => Math.round(v * 1e6)));
  }
  return out;
}

/** A sloped surface with a block, a ring-shaped block and a disc on it, lit from four directions. */
export function horizonScript(): unknown[] {
  const s = new SurfaceRaster(48, 40, 4, (x, z) => 100 + x * 0.02 + z * 0.01);
  const raised = [
    s.raisePolygon([Float32Array.of(60, 60, 84, 60, 84, 92, 60, 92)], 130),
    s.raisePolygon([Float32Array.of(108, 28, 148, 28, 148, 68, 108, 68), Float32Array.of(120, 40, 136, 40, 136, 56, 120, 56)], 118),
    s.raiseDisc(40, 120, 9, 112),
  ];
  if (raised[0] !== 6 * 8 || raised[1] !== 10 * 10 - 4 * 4) throw new Error('light horizon: an outline raised the wrong cells');
  const at = (x: number, z: number): number => Math.floor(z / 4) * s.cols + Math.floor(x / 4);
  const out: unknown[] = [raised, s.heights];
  // Light from +x, 45° up: the ground right behind the 30 m block (toward −x) is hidden, the ground in front is lit.
  const east = lightHorizon(s, [Math.SQRT1_2, Math.SQRT1_2, 0]);
  if (!(east[at(50, 74)]! > s.heights[at(50, 74)]! + 5)) throw new Error('light horizon: the ground behind the block is not hidden');
  if (!(east[at(94, 74)]! < s.heights[at(94, 74)]!)) throw new Error('light horizon: the ground in front of the block is hidden');
  // Far behind the block the light has risen above it: 30 m at 45° reach about 30 m.
  if (!(east[at(10, 74)]! < s.heights[at(10, 74)]!)) throw new Error('light horizon: the shadow does not end');
  // The top of the block is lit by its own cells.
  if (!(east[at(70, 74)]! < 130)) throw new Error('light horizon: the top of the block hides itself');
  for (const dir of [[Math.SQRT1_2, Math.SQRT1_2, 0], [-0.5, 0.4, 0.7681146], [0.2, 0.3, -0.9327379], [0, 1, 0]] as [number, number, number][]) {
    const h = lightHorizon(s, dir);
    const t = horizonTexture(h, s);
    if (t.texture.data.length !== 48 * 40 * 2) throw new Error('light horizon: wrong texture size');
    out.push(t.texture.data, Math.round(t.baseY * 1000), Math.round(t.rangeM * 1000));
  }
  // Straight from above nothing is hidden.
  if (lightHorizon(s, [0, 1, 0]).some((v) => v !== -Infinity)) throw new Error('light horizon: light from straight above hides something');
  return out;
}

/** A stand-in device: answers what the renderer asks at creation and records what a frame does to the shadow map. */
interface DeviceLog {
  frame: Float32Array;
  viewport: [number, number, number, number];
  cleared: string;
}

function recordingDevice(log: DeviceLog): Device {
  const known: Record<string, unknown> = {
    lost: false,
    depthMode: 'standard',
    setDepthMode: (m: string) => m,
    uniformBlock: () => ({ update: (f: Float32Array) => void (log.frame = Float32Array.from(f)) }),
    depthTarget: () => ({ texture: {} }),
    pixelTexture: () => ({}),
    viewport: (x: number, y: number, w: number, h: number) => void (log.viewport = [x, y, w, h]),
    clearDepthRect: (x: number, y: number, w: number, h: number) => void (log.cleared = [x, y, w, h].join()),
  };
  return new Proxy(known, { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : () => undefined) }) as unknown as Device;
}

/** What one draw into the shadow map did: its matrix, its rectangle of the map and the render origin it was drawn with. */
interface MapDraw {
  m: Float32Array;
  vp: [number, number, number, number];
  origin: Vec3;
}

const transform = (m: ArrayLike<number>, p: Vec3): Vec3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];

/**
 * A renderer of one area mode draws a scripted run of frames into a model of the shadow map (per block of the map
 * the draw that last covered it). After every frame, for points scattered over the view, the lookup of the frame
 * (the areas' members of the Frame block, read as the shader reads them) must land on the texel and the depth the
 * point was drawn to, however long ago and with whatever render origin that was.
 */
function areaRun(mode: 'snapped' | 'cascades', count: number, frames: ((r: Renderer) => { view: View; points: Vec3[] })[]): number[] {
  const log: DeviceLog = { frame: new Float32Array(0), viewport: [0, 0, 0, 0], cleared: '' };
  const mapPx = 4096;
  const r = new Renderer(recordingDevice(log), { palette: new Float32Array(4), shadowMapSize: mapPx, shadowSoftnessM: 0.9, shadowDistanceM: 2500, shadows: { mode, cascades: count } });
  const n = mode === 'snapped' ? 1 : count;
  const blockPx = (n === 1 ? mapPx : mapPx / 2) / N;
  const model = new Map<number, MapDraw>();
  let draws = 0;
  r.add({
    draw(ctx): void {
      if (ctx.pass !== 'shadow') return;
      const vp = log.viewport;
      if (vp.some((v) => v % blockPx !== 0) || vp[0] < 0 || vp[1] < 0 || vp[0] + vp[2] > mapPx || vp[1] + vp[3] > mapPx) throw new Error('shadow frames: a part is off the block grid or leaves the map');
      if (log.cleared !== vp.join()) throw new Error('shadow frames: a part is drawn without being cleared');
      const d: MapDraw = { m: Float32Array.from(ctx.lightRender), vp: [...vp], origin: [...r.worldOrigin] };
      for (let y = vp[1] / blockPx; y < (vp[1] + vp[3]) / blockPx; y++) for (let x = vp[0] / blockPx; x < (vp[0] + vp[2]) / blockPx; x++) model.set(y * 1024 + x, d);
      draws++;
    },
    cull: () => 0,
  });
  r.bounds = { min: [0, 100, 0], max: [12000, 400, 9000] };
  const out: number[] = [];
  // Where the areas' members start in the Frame block of a renderer without slots, and their layout (shadowAreaMembers).
  const T = 52;
  for (const [s, step] of frames.entries()) {
    const { view, points } = step(r);
    draws = 0;
    const stats = r.render(view);
    if (stats.shadowUpdates !== draws) throw new Error('shadow frames: shadowUpdates does not count the parts drawn');
    const f = log.frame;
    const o = T + n * 24;
    const wo = r.worldOrigin;
    let beyond = 0;
    for (const pw of points) {
      const p: Vec3 = [pw[0] - wo[0], pw[1] - wo[1], pw[2] - wo[2]];
      const lx = f[o + 4]! * p[0] + f[o + 5]! * p[1] + f[o + 6]! * p[2] - f[o]!;
      const ly = f[o + 8]! * p[0] + f[o + 9]! * p[1] + f[o + 10]! * p[2] - f[o + 1]!;
      const d = Math.max(Math.abs(lx), Math.abs(ly));
      let i = 0;
      while (i < n && d >= f[T + n * 20 + i * 4]!) i++;
      if (i === n) {
        beyond++;
        continue;
      }
      // The area that answers and the one it blends into.
      for (const j of i + 1 < n ? [i, i + 1] : [i]) {
        const sc = transform(f.subarray(T + j * 16, T + j * 16 + 16), p);
        const part = f.subarray(T + n * 16 + j * 4, T + n * 16 + j * 4 + 4);
        if (sc[0] < 0 || sc[0] > 1 || sc[1] < 0 || sc[1] > 1) throw new Error(`shadow frames: a point within the reach of area ${j} lies outside it (frame ${s})`);
        const wrap = (v: number): number => v - Math.floor(v);
        const tx = (n === 1 ? wrap(sc[0] + part[0]!) : part[0]! + sc[0] * part[2]!) * mapPx;
        const ty = (n === 1 ? wrap(sc[1] + part[1]!) : part[1]! + sc[1] * part[2]!) * mapPx;
        const e = model.get(Math.floor(ty / blockPx) * 1024 + Math.floor(tx / blockPx));
        if (!e) throw new Error(`shadow frames: the lookup reads a block that was never drawn (frame ${s})`);
        const c = transform(e.m, [pw[0] - e.origin[0], pw[1] - e.origin[1], pw[2] - e.origin[2]]);
        const off = Math.max(Math.abs(e.vp[0] + (c[0] * 0.5 + 0.5) * e.vp[2] - tx), Math.abs(e.vp[1] + (c[1] * 0.5 + 0.5) * e.vp[3] - ty));
        if (!(off < 0.02)) throw new Error(`shadow frames: area ${j} reads a point ${off.toFixed(3)} texels from where it was drawn (frame ${s})`);
        if (!(Math.abs(c[2] * 0.5 + 0.5 - sc[2]) < 1e-4)) throw new Error(`shadow frames: area ${j} reads another depth than was drawn (frame ${s})`);
      }
    }
    out.push(draws, beyond);
  }
  return out;
}

/** Frame scripts for `areaRun`: a view from above that pans and zooms, and an eye that flies, with a moved render origin. */
export function areaFrames(): number[] {
  let seed = 20261113;
  const rnd = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const out: number[] = [];
  {
    const cam = new SteppedOrthoRig({ yawDeg: 22.5, pitchDegByZoom: [30, 30, 35, 40, 45], pxPerMeterByZoom: [0.05, 0.19, 0.38, 1.53, 6.98] });
    cam.width = 1600;
    cam.height = 900;
    cam.bounds = { minX: 0, maxX: 12000, minZ: 0, maxZ: 9000 };
    cam.refHeight = 150;
    cam.centerX = 4000;
    cam.centerZ = 3000;
    const frames: ((r: Renderer) => { view: View; points: Vec3[] })[] = [];
    const add = (times: number, change: (r: Renderer, k: number) => void): void => {
      for (let k = 0; k < times; k++) {
        frames.push((r) => {
          change(r, k);
          const half = (cam.width * cam.metresPerPixel) / 2;
          return { view: cam, points: Array.from({ length: 120 }, (): Vec3 => [cam.centerX + (rnd() * 2 - 1) * half * 1.5, 100 + rnd() * 300, cam.centerZ + (rnd() * 2 - 1) * half * 1.5]) };
        });
      }
    };
    const pan = (dx: number, dz: number) => (): void => void ((cam.centerX += dx), (cam.centerZ += dz));
    add(1, (r) => void ((r.lightDirection = [0.5, 0.7, 0.5099]), (cam.zoom = 3)));
    add(40, pan(13.7, -7.3));
    add(3, pan(0, 0));
    add(1, () => void (cam.zoom = 2));
    add(20, pan(-90, 55));
    add(1, () => void (cam.zoom = 1));
    add(10, pan(300, 0));
    add(1, () => void (cam.zoom = 0));
    add(5, pan(0, 500));
    add(1, () => void (cam.zoom = 4));
    add(10, pan(3, 0));
    // The light straight above, then one that drifts by less than the cache key resolves: the map is kept and must
    // still be read where it was drawn.
    add(1, (r) => void (r.lightDirection = [0, 1, 0]));
    add(5, pan(30, 30));
    add(1, (r) => void ((r.lightDirection = [0.5, 0.7, 0.5099]), (cam.zoom = 1)));
    add(6, (r, k) => void ((r.lightDirection = [0.5 + 0.000008 * (k + 1), 0.7, 0.5099]), (cam.centerX += 1)));
    out.push(...areaRun('snapped', 1, frames));
  }
  for (const count of [4, 2]) {
    const cam = new PerspectiveOrbitRig({ maxDistance: 1e5, fovYDeg: 60 }, { target: [5000, 150, 4000], yawDeg: 30, pitchDeg: 20, distance: 60 });
    cam.width = 1600;
    cam.height = 900;
    // World position of the render origin; the rig works in render space.
    let origin: Vec3 = [0, 0, 0];
    const frames: ((r: Renderer) => { view: View; points: Vec3[] })[] = [];
    const add = (times: number, change: (r: Renderer) => void): void => {
      for (let k = 0; k < times; k++) {
        frames.push((r) => {
          change(r);
          const eye = cam.cornerRays()[0]!.origin;
          const points = Array.from({ length: 120 }, (): Vec3 => {
            const d = 10 ** (rnd() * 3.6);
            const a = rnd() * 6.283;
            return [eye[0] + origin[0] + Math.cos(a) * d, 100 + rnd() * 300, eye[2] + origin[2] + Math.sin(a) * d];
          });
          return { view: cam, points };
        });
      }
    };
    const fly = (dx: number, dz: number, turn: number) => (): void => void ((cam.target = [cam.target[0] + dx, 150, cam.target[2] + dz]), (cam.yaw += turn));
    add(1, (r) => void (r.lightDirection = [0.3, 0.8, 0.5196]));
    add(40, fly(3.1, 1.7, 0.01));
    add(1, (r) => {
      origin = [4096, 0, 4096];
      r.worldOrigin = origin;
      r.bounds = { min: [-4096, 100, -4096], max: [12000 - 4096, 400, 9000 - 4096] };
      cam.target = [cam.target[0] - 4096, 150, cam.target[2] - 4096];
    });
    add(20, fly(40, -25, 0));
    add(1, (r) => void (r.lightDirection = [0, 1, 0]));
    add(8, fly(40, -25, 0));
    out.push(...areaRun('cascades', count, frames));
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  const a = areaScript();
  console.log(`shadow areas: ${a.length} numbers, ok`);
  const fr = areaFrames();
  console.log(`shadow frames: ${fr.length / 2} frames, ok`);
  const h = horizonScript();
  console.log(`light horizon: ${h.length} parts, ok`);
}
