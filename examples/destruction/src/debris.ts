// Cosmetic debris: chunks thrown on ballistic arcs when parts break. Instanced cubes, deterministic from the event seed
// and the age of the burst on the engine clock, never saved and never read by the destruction model. No physics: a chunk flies, lands
// on the ground plane and stays until the burst fades.

import { hashInts, unit } from 'wallhammer-web/gen-core';
import type { InstanceData, MaterialDesc, MeshData, VertexLayout } from 'wallhammer-web/base';
import { InstancedLayer } from 'wallhammer-web/render';
import type { InstanceBatch, Renderer } from 'wallhammer-web/render';

/** One chunk instance: base x, y, z, reach | size, yaw, tilt, shade. */
const DEBRIS_LAYOUT: VertexLayout = {
  stride: 32,
  attribs: [
    { name: 'i_base', size: 4, type: 'f32', offset: 0 },
    { name: 'i_shape', size: 4, type: 'f32', offset: 16 },
  ],
};
const CUBE_LAYOUT: VertexLayout = {
  stride: 24,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
  ],
};
const MAX_CHUNKS = 600;
/** Seconds a burst lives; chunks fade into the ground over the last half second. */
const LIFE_S = 3.2;
const GRAVITY = 9.81;

const VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_base;
in vec4 i_shape;
out vec3 v_world;
out vec3 v_normal;
flat out float v_shade;
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
void main() {
  mat3 r = rotY(i_shape.y) * rotX(i_shape.z);
  vec3 s = vec3(1.0, 0.6, 0.8) * i_shape.x;
  v_world = i_base.xyz + r * (a_pos * s);
  v_normal = r * a_normal;
  v_shade = i_shape.w;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;
const FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
in vec3 v_world;
in vec3 v_normal;
flat in float v_shade;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 col = mix(vec3(0.42, 0.38, 0.33), vec3(0.66, 0.6, 0.52), v_shade);
  float sun = sunVisibility(v_world, n, 1.0);
  o_color = vec4(applyFog(toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0)), v_world), 1.0);
}`;
const MATERIAL: MaterialDesc = { name: 'debris', attribs: { a_pos: 0, a_normal: 1, i_base: 2, i_shape: 3 }, passes: { color: { vs: VS, fs: FS } } };

function cube(): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, a, b] of faces) {
    const base = v.length / 6;
    for (const [sa, sb] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      v.push(0.5 * (n[0]! + a[0]! * sa + b[0]! * sb), 0.5 * (n[1]! + a[1]! * sa + b[1]! * sb), 0.5 * (n[2]! + a[2]! * sa + b[2]! * sb), n[0]!, n[1]!, n[2]!);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { layout: CUBE_LAYOUT, vertices: new Float32Array(v), indices: new Uint32Array(idx), count: idx.length };
}

interface Chunk {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  spin: number;
  yaw: number;
  shade: number;
  /** Ground height where it lands. */
  floor: number;
}
interface Burst {
  chunks: Chunk[];
  /** Clock time of the burst. */
  start: number;
  age: number;
}

/** A source of chunks: the centre of a broken part and the direction it was pushed (metres). */
export interface DebrisSource {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  size: number;
}

export class Debris {
  readonly layer: InstancedLayer;
  private readonly batch: InstanceBatch;
  private bursts: Burst[] = [];
  private readonly renderer: Renderer;
  private count = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    const material = renderer.material(MATERIAL);
    this.layer = new InstancedLayer(renderer.device, { material, bounds: { position: 0, radius: 3, height: 4 } });
    const data: InstanceData = { layout: DEBRIS_LAYOUT, data: new Float32Array(MAX_CHUNKS * 8) };
    const instances = renderer.createInstances(data);
    this.batch = { lods: [renderer.createMesh(cube(), material, instances)], instances, all: new Float32Array(0), uniforms: {} };
    this.layer.batches = [this.batch];
    // The renderer culls instances only when its shadow view changes; debris moves every frame, so it uploads its
    // instances itself (all of them, there are few) and skips culling.
    this.layer.cull = (): number => this.count;
  }

  get active(): boolean {
    return this.bursts.length > 0;
  }

  /** Throws chunks from the sources at clock time `start`; every number comes from the seed. */
  burst(seed: number, sources: readonly DebrisSource[], floor: number, start: number): void {
    const chunks: Chunk[] = [];
    sources.forEach((s, i) => {
      const n = Math.min(14, 4 + Math.round(s.size * 3));
      for (let k = 0; k < n; k++) {
        const r = (j: number): number => unit(hashInts(seed, i, k, j));
        const speed = 3 + 6 * r(1);
        const side = (r(2) - 0.5) * 1.4;
        chunks.push({
          x: s.x + (r(3) - 0.5) * s.size,
          y: s.y + (r(4) - 0.5) * s.size * 0.6,
          z: s.z + (r(5) - 0.5) * s.size,
          vx: (s.dx - s.dz * side) * speed,
          vy: 2 + 5 * r(6),
          vz: (s.dz + s.dx * side) * speed,
          size: 0.15 + 0.45 * r(7) ** 2,
          spin: (r(8) - 0.5) * 14,
          yaw: r(9) * 6.283,
          shade: r(10),
          floor,
        });
      }
    });
    this.bursts.push({ chunks, start, age: 0 });
  }

  clear(): void {
    this.bursts = [];
    this.upload(new Float32Array(0));
  }

  private upload(all: Float32Array): void {
    this.batch.all = all;
    if (all.length) this.renderer.device.writeBuffer(this.batch.instances.buffer, all, all.length);
    this.count = all.length / 8;
    for (const m of this.batch.lods) m.instances = this.count;
  }

  /** Poses every burst at clock time `now` (or at a fixed age) and refreshes the instances. No state carries over. */
  update(now: number, setAge?: number): void {
    for (const b of this.bursts) b.age = setAge ?? now - b.start;
    this.bursts = this.bursts.filter((b) => b.age < LIFE_S);
    const live = this.bursts.filter((b) => b.age >= 0);
    const out: number[] = [];
    for (const b of live) {
      const t = b.age;
      const sink = Math.max(0, t - (LIFE_S - 0.5)) / 0.5;
      for (const c of b.chunks) {
        if (out.length >= MAX_CHUNKS * 8) break;
        // Time of landing on the floor: solve y + vy t − g t²/2 = floor.
        const a = GRAVITY / 2;
        const disc = c.vy * c.vy + 4 * a * (c.y - c.floor);
        const land = (c.vy + Math.sqrt(Math.max(0, disc))) / (2 * a);
        const tt = Math.min(t, land);
        const x = c.x + c.vx * tt;
        const z = c.z + c.vz * tt;
        const y = Math.max(c.floor, c.y + c.vy * tt - a * tt * tt) + c.size * 0.3 - sink * c.size;
        out.push(x, y, z, c.size, c.size, c.yaw + c.spin * tt * 0.3, c.spin * tt, c.shade);
      }
    }
    this.upload(new Float32Array(out));
  }
}
