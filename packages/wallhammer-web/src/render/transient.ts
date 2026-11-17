// Transient things that move on closed-form tracks (core/ballistic.ts) driven by the clock time in the Frame block
// (`u_time.x`), and dust puffs. Nothing is integrated per frame, so pausing or scrubbing the clock shows the same pose,
// also back to before a piece landed (a batch is kept `keepS` seconds after it finished).
//
// A batch is any mesh with any material whose vertex shader places vertices with `TRACK_GLSL`; its pieces stand
// exactly where they are until they let go. The content module that makes the batch decides what its pieces look
// like and which of them go to dust when the budget is short (`room`). Dust is drawn as camera-facing quads whose
// cloud is made in the fragment shader from noise, blended over the scene without writing depth.
//
// While a batch moves (its clock span contains a changed clock time) the shadow map is redrawn every frame, so pieces
// cast moving shadows; outside that span the shadow map is left alone.

import type { MaterialDesc, MeshData, Uniforms, VertexLayout } from '../base/index.ts';
import type { DustPuff } from '../core/index.ts';
import type { Mesh } from '../gpu/index.ts';
import type { DrawContext, Layer, Material, Renderer } from './renderer.ts';
import { MeshLayer } from './renderer.ts';

const f = (v: number): string => v.toFixed(4);

/** Seconds a dust puff lives. */
export const DUST_LIFE_S = 2.2;

const DUST_LAYOUT: VertexLayout = {
  stride: 32,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_corner', size: 2, type: 'f32', offset: 12 },
    { name: 'a_puff', size: 3, type: 'f32', offset: 20 },
  ],
};
const DUST_ATTRIBS = { a_pos: 0, a_corner: 1, a_puff: 2 } as const;

const DUST_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec2 a_corner;
in vec3 a_puff;
out vec3 v_world;
out vec2 v_corner;
flat out float v_age;
flat out float v_seed;
void main() {
  // a_puff: start, size, seed. The cloud swells fast, then slowly, and rises a little.
  float age = u_time.x - a_puff.x;
  float k = clamp(age / ${f(DUST_LIFE_S)}, 0.0, 1.0);
  float r = a_puff.y * (0.35 + 1.1 * (1.0 - (1.0 - k) * (1.0 - k)));
  vec3 c = a_pos + vec3(0.0, a_puff.y * 0.25 + 0.6 * k, 0.0);
  bool live = age > 0.0 && age < ${f(DUST_LIFE_S)};
  v_world = c + (u_camRight.xyz * a_corner.x + u_camUp.xyz * a_corner.y) * r;
  v_corner = a_corner;
  v_age = k;
  v_seed = a_puff.z;
  gl_Position = live ? u_viewProj * vec4(v_world, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}`;
const DUST_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
in vec3 v_world;
in vec2 v_corner;
flat in float v_age;
flat in float v_seed;
out vec4 o_color;
void main() {
  float d = length(v_corner);
  uint s = uint(v_seed * 65535.0);
  float billow = vnoise(v_corner * 2.6 + v_age * 1.5, s) * 0.6 + vnoise(v_corner * 5.3 - v_age, s + 1u) * 0.4;
  float a = (1.0 - smoothstep(0.35, 1.0, d + 0.35 * (billow - 0.5))) * (1.0 - v_age) * (1.0 - v_age) * 0.85;
  if (a < 0.01) discard;
  vec3 col = vec3(0.66, 0.63, 0.58) * (0.85 + 0.3 * billow);
  vec3 light = lightOn(vec3(0.0, 1.0, 0.0), 1.0, 1.0) * 0.8;
  o_color = vec4(applyFog(toDisplay(col * u_warmTint.rgb * light), v_world), a);
}`;

const DUST_MATERIAL: MaterialDesc = {
  name: 'transient-dust',
  attribs: DUST_ATTRIBS,
  passes: { color: { vs: DUST_VS, fs: DUST_FS } },
  state: { color: { depthWrite: false, cullBack: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha', srcAlpha: 'one', dstAlpha: 'one-minus-src-alpha' } } },
};


export interface TransientBatch {
  data: MeshData;
  material: Material;
  uniforms?: Uniforms;
  /** Clock span in which something of the batch moves (first letting go, last thing settled). */
  start: number;
  end: number;
  /** Pieces that fly, and pieces shown only as dust. */
  pieces: number;
  dust: number;
  /** Dust puffs that belong to the batch (removed with it). */
  puffs?: readonly DustPuff[];
}

export interface TransientStats {
  /** Pieces of the batches still moving at the given time. */
  pieces: number;
  /** Pieces of those batches shown only as dust (over the budget). */
  coarsened: number;
  puffs: number;
  batches: number;
}

interface Held {
  id: number;
  layer: MeshLayer;
  puffs: readonly DustPuff[];
  start: number;
  end: number;
  pieces: number;
  dust: number;
}

/** Batches of pieces and dust puffs on closed-form tracks; add it to the renderer after the opaque layers. */
export class TransientLayer implements Layer {
  readonly maxPieces: number;
  readonly keepS: number;
  private readonly renderer: Renderer;
  private readonly dustLayer: MeshLayer;
  private held: Held[] = [];
  private puffs: DustPuff[] = [];
  private lastT = NaN;
  private nextId = 1;

  /** `clock` gives the time the frame is drawn at (the clock behind `u_time.x`), for the shadow refresh. */
  constructor(renderer: Renderer, o: { maxPieces?: number; keepS?: number; clock?: () => number } = {}) {
    this.renderer = renderer;
    this.maxPieces = o.maxPieces ?? 320;
    this.keepS = o.keepS ?? 30;
    this.dustLayer = new MeshLayer({ material: renderer.material(DUST_MATERIAL) });
    const clock = o.clock;
    if (clock) {
      renderer.beforeFrame.push(() => {
        const t = clock();
        if (t !== this.lastT && this.moving(Math.min(t, this.lastT), Math.max(t, this.lastT))) renderer.invalidateShadows();
        this.lastT = t;
      });
    }
  }

  draw(ctx: DrawContext): void {
    for (const h of this.held) h.layer.draw(ctx);
    this.dustLayer.draw(ctx);
  }

  /** How many more pieces may fly at clock time `now` (the budget minus the pieces of batches still moving). */
  room(now: number): number {
    let n = 0;
    for (const h of this.held) if (h.end > now) n += h.pieces;
    return Math.max(0, this.maxPieces - n);
  }

  /** Adds a batch (its puffs with it); returns a handle for `remove`. */
  addBatch(b: TransientBatch): number {
    const layer = new MeshLayer({ material: b.material, uniforms: b.uniforms ?? {} });
    layer.mesh = b.data.count > 0 ? this.renderer.createMesh(b.data, b.material) : null;
    const id = this.nextId++;
    this.held.push({ id, layer, puffs: b.puffs ?? [], start: b.start, end: b.end, pieces: b.pieces, dust: b.dust });
    if (b.puffs?.length) this.uploadDust();
    this.renderer.invalidateShadows();
    return id;
  }

  /** Takes a batch away (to replace it with a new one). */
  remove(id: number): void {
    const h = this.held.find((x) => x.id === id);
    if (!h) return;
    this.release(h);
    this.held = this.held.filter((x) => x !== h);
    if (h.puffs.length) this.uploadDust();
    this.renderer.invalidateShadows();
  }

  addPuffs(puffs: readonly DustPuff[]): void {
    if (puffs.length === 0) return;
    this.puffs.push(...puffs);
    this.uploadDust();
  }

  /** Is anything moving or visible as dust at `now`? */
  busy(now: number): boolean {
    return this.held.some((h) => now >= h.start && now < h.end) || this.allPuffs().some((p) => now >= p.start && p.start + DUST_LIFE_S > now);
  }

  /** Drops what finished more than `keepS` before `now`. */
  drop(now: number): void {
    const keep = now - this.keepS;
    const gone = this.held.filter((h) => h.end <= keep && h.puffs.every((p) => p.start + DUST_LIFE_S <= keep));
    for (const h of gone) this.release(h);
    this.held = this.held.filter((h) => !gone.includes(h));
    const n = this.puffs.length;
    this.puffs = this.puffs.filter((p) => p.start + DUST_LIFE_S > keep);
    if (this.puffs.length !== n || gone.some((h) => h.puffs.length > 0)) this.uploadDust();
  }

  clear(): void {
    for (const h of this.held) this.release(h);
    this.held = [];
    this.puffs = [];
    this.uploadDust();
    this.renderer.invalidateShadows();
  }

  stats(now: number): TransientStats {
    let pieces = 0;
    let coarsened = 0;
    for (const h of this.held) {
      if (h.end <= now) continue;
      pieces += h.pieces;
      coarsened += h.dust;
    }
    return { pieces, coarsened, puffs: this.allPuffs().filter((p) => p.start + DUST_LIFE_S > now).length, batches: this.held.length };
  }

  private moving(a: number, b: number): boolean {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return this.held.length > 0;
    return this.held.some((h) => h.start <= b && h.end >= a);
  }

  private allPuffs(): DustPuff[] {
    return this.held.length ? [...this.puffs, ...this.held.flatMap((h) => h.puffs)] : this.puffs;
  }

  private release(h: Held): void {
    const m: Mesh | null = h.layer.mesh;
    if (m) this.renderer.device.deleteMesh(m);
    h.layer.mesh = null;
  }

  private uploadDust(): void {
    const old: Mesh | null = this.dustLayer.mesh;
    const data = dustMesh(this.allPuffs());
    this.dustLayer.mesh = data.count > 0 ? this.renderer.createMesh(data, this.dustLayer.material) : null;
    if (old) this.renderer.device.deleteMesh(old);
  }
}

function dustMesh(puffs: readonly DustPuff[]): MeshData {
  const v = new Float32Array(puffs.length * 6 * 8);
  let o = 0;
  for (const p of puffs) {
    // Noise seed from the puff itself, so it keeps its look when other puffs come and go.
    const seed = (Math.imul(Math.round(p.x * 100) ^ Math.imul(Math.round(p.z * 100), 0x85ebca6b) ^ Math.round(p.start * 1000), 0x9e3779b1) >>> 16) / 65535;
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      v.set([p.x, p.y, p.z, cx, cy, p.start, p.size, seed], o);
      o += 8;
    }
  }
  return { layout: DUST_LAYOUT, vertices: v, indices: null, count: puffs.length * 6 };
}
