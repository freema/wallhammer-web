// Precision test scene of the endless example, and the two renderer options it exists for. Everything here is off
// unless the URL hash asks for it; without these keys the example is exactly what it was.
//
// URL hash keys:
//   depth=standard|reversed|logarithmic   depth mode of the renderer (default standard). `reversed` falls back to
//                                         `logarithmic` where the browser lacks EXT_clip_control.
//   origin=horizontal|all                 axes on which the render origin follows the camera (default horizontal).
//                                         Only the free camera changes its height, so `all` matters with cam=free.
//   scene=precision                       the test scene. It switches the free camera on, starts 1,000 km from the
//                                         world origin and 400 km above the surface, and defaults to depth=reversed
//                                         and origin=all. Give depth= or origin= explicitly to compare.
//
// The scene has two objects, both fixed to the world (positions in doubles, handed to the GPU relative to the render
// origin):
// - a small cube with a rod through it, 1 m in front of where the camera starts (key P puts it in front again);
// - a group of peaks on a plateau with raised tiles 25 m above it, 1,000 km away along the start heading.
// What to look for: with origin=all nothing shakes while the camera turns or creeps; with depth=reversed or
// depth=logarithmic the cube and the peaks are both there and the tiles do not flicker against the plateau. With
// depth=standard the near plane is hundreds of metres out and the cube is cut away; with origin=horizontal the cube
// jumps in steps of a few centimetres.

import type { DepthMode, MaterialDesc, MeshData, OriginAxes, Vec3, VertexLayout } from 'wallhammer-web/base';
import type { FreeRig } from 'wallhammer-web/camera';
import type { Mesh } from 'wallhammer-web/gpu';
import type { DrawContext, Layer, Material, Renderer } from 'wallhammer-web/render';

/** Where the scene starts: metres from the world origin along x, metres above the surface, and the pitch that looks at the far object. */
export const PRECISION_START = { x: 1_000_000, z: 0, alt: 400_000, pitchDeg: 23.5 } as const;
/** Distance from the start pose to the near object and to the far one, in metres. */
const NEAR_M = 1;
const FAR_M = 1_000_000;
/** World height of the plateau the peaks stand on: above every summit of the streamed surface near it. */
const PLATEAU_Y = 6000;
/** The raised tiles float this far above the plateau: two surfaces 25 m apart, seen from 1,000 km. */
const TILE_LIFT_M = 25;

export interface PrecisionOptions {
  /** True with `scene=precision`. */
  scene: boolean;
  depth: DepthMode;
  originAxes: OriginAxes;
  /** The keys read here as given, to append to the hash the example keeps up to date (starts with `&` or is empty). */
  hash: string;
}

/** Reads `scene`, `depth` and `origin` from the URL hash. */
export function precisionOptions(q: URLSearchParams): PrecisionOptions {
  const scene = q.get('scene') === 'precision';
  const d = q.get('depth');
  const depth: DepthMode = d === 'standard' || d === 'reversed' || d === 'logarithmic' ? d : scene ? 'reversed' : 'standard';
  const o = q.get('origin');
  const originAxes: OriginAxes = o === 'horizontal' || o === 'all' ? o : scene ? 'all' : 'horizontal';
  const hash = `${scene ? '&scene=precision' : ''}${d !== null ? `&depth=${depth}` : ''}${o !== null ? `&origin=${originAxes}` : ''}`;
  return { scene, depth, originAxes, hash };
}

/** Views for the shot tool: the start pose, and the same place turned a little (the near object moves across the image). */
export const PRECISION_PRESETS = [
  { name: 'precision', x: PRECISION_START.x, z: PRECISION_START.z, yawDeg: 30, pitchDeg: PRECISION_START.pitchDeg, height: PRECISION_START.alt },
  { name: 'precision-turned', x: PRECISION_START.x, z: PRECISION_START.z, yawDeg: 35, pitchDeg: PRECISION_START.pitchDeg + 3, height: PRECISION_START.alt },
] as const;

export const PRECISION_HELP = 'P puts the cube 1 m in front of the camera again';

const ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2 } as const;
const LAYOUT: VertexLayout = {
  stride: 36,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
    { name: 'a_color', size: 3, type: 'f32', offset: 24 },
  ],
};

// Plain lit colour, without haze: at these distances the example's own haze would hide the far object.
const VS = /* glsl */ `#include <header>
uniform vec3 u_anchor; // anchor of the mesh minus the render origin, subtracted in doubles on the CPU
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_color;
out vec3 v_normal;
out vec3 v_color;
void main() {
  v_normal = a_normal;
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos + u_anchor, 1.0);
}`;

const FS = /* glsl */ `#include <header>
in vec3 v_normal;
in vec3 v_color;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  float light = 0.4 + 0.6 * max(dot(n, u_sunDir.xyz), 0.0);
  o_color = vec4(v_color * light, 1.0);
}`;

const MATERIAL: MaterialDesc = {
  name: 'precision scene',
  attribs: ATTRIBS,
  passes: { color: { vs: VS, fs: FS } },
  // Both sides are drawn, so the winding of the hand-built triangles does not matter.
  state: { color: { cullBack: false } },
};

type P3 = readonly [number, number, number];

/** Collects flat-shaded triangles (position, face normal, colour per vertex) and their extent. */
class Triangles {
  private readonly v: number[] = [];
  readonly min: Vec3 = [Infinity, Infinity, Infinity];
  readonly max: Vec3 = [-Infinity, -Infinity, -Infinity];

  tri(a: P3, b: P3, c: P3, color: P3): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const wx = c[0] - a[0];
    const wy = c[1] - a[1];
    const wz = c[2] - a[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const p of [a, b, c]) {
      this.v.push(p[0], p[1], p[2], nx, ny, nz, color[0], color[1], color[2]);
      for (let i = 0; i < 3; i++) {
        this.min[i] = Math.min(this.min[i]!, p[i]!);
        this.max[i] = Math.max(this.max[i]!, p[i]!);
      }
    }
  }

  quad(a: P3, b: P3, c: P3, d: P3, color: P3): void {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  /** Axis-aligned box round `c` with half extents `h`; each pair of opposite faces a little darker than the last. */
  box(c: P3, h: P3, color: P3): void {
    const p = (sx: number, sy: number, sz: number): P3 => [c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]];
    const shade = (k: number): P3 => [color[0] * k, color[1] * k, color[2] * k];
    for (const s of [-1, 1]) {
      this.quad(p(s, -1, -1), p(s, 1, -1), p(s, 1, 1), p(s, -1, 1), shade(0.85));
      this.quad(p(-1, s, -1), p(1, s, -1), p(1, s, 1), p(-1, s, 1), shade(1));
      this.quad(p(-1, -1, s), p(1, -1, s), p(1, 1, s), p(-1, 1, s), shade(0.7));
    }
  }

  /** Upright cone on `base`: `lower` colour up to `capFrom` of its height, `cap` colour above; facets alternate in tone. */
  cone(base: P3, radius: number, height: number, segments: number, lower: P3, cap: P3, capFrom: number): void {
    const apex: P3 = [base[0], base[1] + height, base[2]];
    const ring = (i: number, f: number): P3 => {
      const a = (i / segments) * Math.PI * 2;
      const r = radius * (1 - f);
      return [base[0] + Math.cos(a) * r, base[1] + height * f, base[2] + Math.sin(a) * r];
    };
    for (let i = 0; i < segments; i++) {
      const k = i % 2 === 0 ? 1 : 0.88;
      this.quad(ring(i, 0), ring(i + 1, 0), ring(i + 1, capFrom), ring(i, capFrom), [lower[0] * k, lower[1] * k, lower[2] * k]);
      this.tri(ring(i, capFrom), ring(i + 1, capFrom), apex, [cap[0] * k, cap[1] * k, cap[2] * k]);
    }
  }

  data(): MeshData {
    return { layout: LAYOUT, vertices: new Float32Array(this.v), indices: null, count: this.v.length / 9 };
  }
}

/** The near object: a cube of 16 cm with a thin rod through it. Local metres round its anchor. */
function nearObject(): Triangles {
  const t = new Triangles();
  t.box([0, 0, 0], [0.08, 0.08, 0.08], [0.92, 0.42, 0.16]);
  t.box([0, 0, 0], [0.012, 0.2, 0.012], [0.95, 0.95, 0.9]);
  t.box([0, 0, 0], [0.2, 0.012, 0.012], [0.2, 0.55, 0.9]);
  return t;
}

/** The far object: a plateau of 400 km, raised tiles a little above it and five peaks. Local metres round its anchor. */
function farObject(): Triangles {
  const t = new Triangles();
  const half = 200_000;
  t.quad([-half, 0, -half], [half, 0, -half], [half, 0, half], [-half, 0, half], [0.42, 0.38, 0.3]);
  // Every other field of a 10 × 10 board, lifted: wherever depth cannot tell 25 m at this distance, they flicker.
  const n = 10;
  const step = (half * 2) / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i + j) % 2 !== 0) continue;
      const x0 = -half + i * step;
      const z0 = -half + j * step;
      t.quad([x0, TILE_LIFT_M, z0], [x0 + step, TILE_LIFT_M, z0], [x0 + step, TILE_LIFT_M, z0 + step], [x0, TILE_LIFT_M, z0 + step], [0.3, 0.46, 0.3]);
    }
  }
  const rock: P3 = [0.5, 0.46, 0.42];
  const snow: P3 = [0.95, 0.96, 0.98];
  t.cone([0, 0, 0], 70_000, 46_000, 48, rock, snow, 0.6);
  t.cone([-85_000, 0, 30_000], 50_000, 28_000, 40, rock, snow, 0.7);
  t.cone([90_000, 0, -20_000], 55_000, 32_000, 40, rock, snow, 0.68);
  t.cone([30_000, 0, 95_000], 42_000, 22_000, 36, rock, snow, 0.75);
  t.cone([-40_000, 0, -90_000], 46_000, 25_000, 36, rock, snow, 0.72);
  return t;
}

interface Anchored {
  mesh: Mesh;
  /** World position of the mesh's local zero, in doubles. */
  anchor: [number, number, number];
  /** Local extent of the mesh. */
  min: Vec3;
  max: Vec3;
}

export interface PrecisionSceneOptions {
  renderer: Renderer;
  rig: FreeRig;
  /** The render origin in world metres, as the layers of this frame use it. */
  origin: () => readonly [number, number, number];
}

/**
 * The test scene as a renderer layer. Add it after the streamed world: its `beforeFrame` hook widens the scene bounds
 * the streamed world has just set, so the far object lies inside the depth range of the view.
 */
export class PrecisionScene implements Layer {
  private readonly material: Material;
  private readonly near: Anchored;
  private readonly far: Anchored;
  private readonly rig: FreeRig;
  private readonly origin: () => readonly [number, number, number];

  constructor(o: PrecisionSceneOptions) {
    const r = o.renderer;
    this.rig = o.rig;
    this.origin = o.origin;
    this.material = r.material(MATERIAL);
    const nearT = nearObject();
    const farT = farObject();
    this.near = { mesh: r.createMesh(nearT.data(), this.material), anchor: [0, 0, 0], min: nearT.min, max: nearT.max };
    this.far = { mesh: r.createMesh(farT.data(), this.material), anchor: [0, 0, 0], min: farT.min, max: farT.max };
    this.placeNear();
    // The far object: on the plateau level, 1,000 km from the start along the start heading (in a straight line).
    const p = this.rig.position;
    const h = this.rig.headingDir();
    const drop = p[1] - PLATEAU_Y;
    const along = Math.sqrt(Math.max(FAR_M * FAR_M - drop * drop, (FAR_M * 0.2) ** 2));
    this.far.anchor = [p[0] + h[0] * along, PLATEAU_Y, p[2] + h[2] * along];
    r.beforeFrame.push(() => this.widenBounds(r));
  }

  /** Puts the near object 1 m in front of the camera as it is now, a little left of and below the image centre. */
  placeNear(): void {
    const p = this.rig.position;
    const { right, up, forward } = this.rig.axes();
    const at = (i: number): number => p[i]! + forward[i]! * NEAR_M - right[i]! * 0.22 - up[i]! * 0.1;
    this.near.anchor = [at(0), at(1), at(2)];
  }

  /** One overlay line: how far the two objects are from the camera right now. */
  overlayLine(): string {
    const p = this.rig.position;
    const dist = (a: readonly [number, number, number]): number => Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
    return `scene  precision: near object ${dist(this.near.anchor).toFixed(2)} m, far object ${(dist(this.far.anchor) / 1000).toFixed(1)} km`;
  }

  /** Anchor minus render origin: the only place where the large numbers meet, in doubles. */
  private offset(a: Anchored): Vec3 {
    const o = this.origin();
    return [a.anchor[0] - o[0], a.anchor[1] - o[1], a.anchor[2] - o[2]];
  }

  private widenBounds(r: Renderer): void {
    const b = r.bounds;
    const min: Vec3 = b ? [b.min[0], b.min[1], b.min[2]] : [Infinity, Infinity, Infinity];
    const max: Vec3 = b ? [b.max[0], b.max[1], b.max[2]] : [-Infinity, -Infinity, -Infinity];
    for (const a of [this.near, this.far]) {
      const off = this.offset(a);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, off[i]! + a.min[i]!);
        max[i] = Math.max(max[i]!, off[i]! + a.max[i]!);
      }
    }
    r.bounds = { min, max };
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color' && ctx.pass !== 'data') return;
    const program = this.material.program(ctx.pass);
    if (!program) return;
    const state = this.material.state[ctx.pass] ?? this.material.state.color;
    if (state) ctx.device.setState(state);
    ctx.device.use(program);
    // The far object first, the near one last: the order must not matter, depth decides.
    for (const a of [this.far, this.near]) {
      const off = this.offset(a);
      program.vec3('u_anchor', off[0], off[1], off[2]);
      ctx.device.draw(a.mesh);
      ctx.count(a.mesh.triangles);
    }
  }
}
