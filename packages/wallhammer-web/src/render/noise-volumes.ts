// The tileable noise volumes (`NOISE_VOLUME_SHAPE`, `NOISE_VOLUME_DETAIL` in gen-tex) made on the graphics card: one
// full-screen draw per layer of a volume target, from the integer hash of the include `noise` and a seed. The recipe
// and the same texel function on the CPU (`noiseVolumeData`) live in gen-tex; the shader below repeats that function
// line for line. Once the two programs are compiled, both volumes take a few milliseconds of GPU time; the work can
// still be spread over frames (`layersPerStep`).

import type { View } from '../base/view.ts';
import type { Device, Program, VolumeTarget } from '../gpu/index.ts';
import { NOISE_SEED_DETAIL, NOISE_SEED_PERLIN, NOISE_SEED_WORLEY, NOISE_VOLUME_DETAIL, NOISE_VOLUME_SHAPE, PERLIN_GRADIENTS, WORLEY_WEIGHTS } from '../gen-tex/index.ts';
import type { NoiseVolumeRecipe } from '../gen-tex/index.ts';
import { NOISE } from './glsl.ts';
import type { DrawContext, Layer } from './renderer.ts';

const FILL_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** The tileable cellular and gradient noise of gen-tex's `worleyTile` and `perlinTile`, in GLSL. */
export const NOISE_VOLUME_GLSL = /* glsl */ `
const vec3 WH_GRADIENTS[12] = vec3[12](${PERLIN_GRADIENTS.map((g) => `vec3(${g.map(f).join(', ')})`).join(', ')});
uint whCellHash(ivec3 p, uint seed) {
  return hashU(uint(p.x) * 0x9e3779b1U ^ hashU(uint(p.y) * 0xc2b2ae35U ^ hashU(uint(p.z) + seed)));
}
uint whOctaveSeed(uint seed, int k) { return hashU(seed + uint(k) * 0x68e31da4U); }
// 1 at a feature point, 0 one cell or more away; p in cells, periodic over period cells.
float worleyTile(vec3 p, int period, uint seed) {
  vec3 c = floor(p);
  vec3 fr = p - c;
  ivec3 ic = ivec3(c);
  float best = 1e9;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 n = ic + ivec3(dx, dy, dz);
        uint h = whCellHash((n + period) % period, seed);
        vec3 e = vec3(float(dx), float(dy), float(dz)) + vec3(float(h & 1023U), float((h >> 10) & 1023U), float((h >> 20) & 1023U)) * (1.0 / 1024.0) - fr;
        best = min(best, dot(e, e));
      }
    }
  }
  return 1.0 - min(sqrt(best), 1.0);
}
float whGradDot(ivec3 i, vec3 d, int period, uint seed) {
  return dot(WH_GRADIENTS[int(whCellHash(i % period, seed) % 12U)], d);
}
// About -1 … 1; p in cells (not negative), periodic over period cells.
float perlinTile(vec3 p, int period, uint seed) {
  vec3 c = floor(p);
  ivec3 i = ivec3(c);
  vec3 x = p - c;
  vec3 u = x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
  float x0 = mix(whGradDot(i, x, period, seed), whGradDot(i + ivec3(1, 0, 0), x - vec3(1.0, 0.0, 0.0), period, seed), u.x);
  float x1 = mix(whGradDot(i + ivec3(0, 1, 0), x - vec3(0.0, 1.0, 0.0), period, seed), whGradDot(i + ivec3(1, 1, 0), x - vec3(1.0, 1.0, 0.0), period, seed), u.x);
  float x2 = mix(whGradDot(i + ivec3(0, 0, 1), x - vec3(0.0, 0.0, 1.0), period, seed), whGradDot(i + ivec3(1, 0, 1), x - vec3(1.0, 0.0, 1.0), period, seed), u.x);
  float x3 = mix(whGradDot(i + ivec3(0, 1, 1), x - vec3(0.0, 1.0, 1.0), period, seed), whGradDot(i + ivec3(1, 1, 1), x - vec3(1.0, 1.0, 1.0), period, seed), u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}
`;

/** Fragment shader of one layer of a volume: gen-tex's `shapeNoiseAt` or `detailNoiseAt` at the texel's centre. */
function volumeFs(kind: 'shape' | 'detail', r: NoiseVolumeRecipe, seed: number): string {
  const [a, b, c] = WORLEY_WEIGHTS.map(f);
  const worley = (cells: number, k: number, offset: number): string => `worleyTile(u * ${f(cells)}, ${cells}, whOctaveSeed(SEED, ${offset + k}))`;
  const body =
    kind === 'shape'
      ? `  float n = 0.0;
${Array.from({ length: r.perlinOctaves }, (_, k) => `  n += ${f(0.5 ** k)} * perlinTile(u * ${f(r.perlinCells << k)}, ${r.perlinCells << k}, whOctaveSeed(SEED, ${NOISE_SEED_PERLIN + k}));`).join('\n')}
  float perlin = clamp(0.5 + 0.9 * (n / ${f(Array.from({ length: r.perlinOctaves }, (_, k) => 0.5 ** k).reduce((s, x) => s + x, 0))}), 0.0, 1.0);
  float w0 = ${worley(r.worleyCells, 0, NOISE_SEED_WORLEY)};
  float w1 = ${worley(r.worleyCells * 2, 1, NOISE_SEED_WORLEY)};
  float w2 = ${worley(r.worleyCells * 4, 2, NOISE_SEED_WORLEY)};
  float w3 = ${worley(r.worleyCells * 8, 3, NOISE_SEED_WORLEY)};
  float dilate = ${a} * w0 + ${b} * w1 + ${c} * w2;
  float erode = ${a} * w1 + ${b} * w2 + ${c} * w3;
  float pw = dilate + perlin * (1.0 - dilate);
  float raw = (pw + 1.0 - erode) / (2.0 - erode);
  float v = clamp((raw - ${f(r.low)}) / ${f(1 - r.low)}, 0.0, 1.0);`
      : `  float v = ${a} * ${worley(r.worleyCells, 0, NOISE_SEED_DETAIL)} + ${b} * ${worley(r.worleyCells * 2, 1, NOISE_SEED_DETAIL)} + ${c} * ${worley(r.worleyCells * 4, 2, NOISE_SEED_DETAIL)};`;
  return `#version 300 es
precision highp float;
precision highp int;
#define WH_PIXEL_SIZE 1
${NOISE}
${NOISE_VOLUME_GLSL}
const uint SEED = ${seed >>> 0}U;
uniform int u_layer;
out vec4 o_value;
void main() {
  vec3 u = vec3(gl_FragCoord.xy, float(u_layer) + 0.5) * ${f(1 / r.size)};
${body}
  o_value = vec4(v, v, v, 1.0);
}`;
}

export interface NoiseVolumesOptions {
  /** Seed of both volumes (an unsigned 32-bit integer). Default 0. */
  seed?: number;
  /**
   * Layers made per `prepare` (per frame) over both volumes, shape first. Default: all at once in the first frame.
   * A smaller number spreads the work: the volumes are `ready` after (128 + 32) / layersPerStep frames.
   */
  layersPerStep?: number;
}

/**
 * The shape volume (128³, R8, Perlin-Worley) and the detail volume (32³, R8, Worley octaves), made on the GPU from a
 * seed. Add it as a layer (it draws nothing; its `prepare` makes the layers still missing) or call `step` yourself.
 * Bind the volumes with `bind`. After a context loss the volumes are made again from their first layer.
 */
export class NoiseVolumes implements Layer {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'noise-volumes';
  readonly seed: number;
  /** Null where the device cannot make the volume (see `Device.volumeTarget`). */
  readonly shape: VolumeTarget | null;
  readonly detail: VolumeTarget | null;
  layersPerStep: number;
  private readonly programs: [Program, Program];
  /** Layers made so far, over the shape volume and then the detail volume. */
  private made = 0;
  private readonly unlisten: () => void;
  private readonly device: Device;

  constructor(device: Device, o: NoiseVolumesOptions = {}) {
    this.device = device;
    this.seed = (o.seed ?? 0) >>> 0;
    const s = NOISE_VOLUME_SHAPE;
    const d = NOISE_VOLUME_DETAIL;
    this.layersPerStep = Math.max(1, o.layersPerStep ?? s.size + d.size);
    this.shape = device.volumeTarget(s.size, s.size, s.size, 'r8');
    this.detail = device.volumeTarget(d.size, d.size, d.size, 'r8');
    this.programs = [device.program('noise volume shape', FILL_VS, volumeFs('shape', s, this.seed)), device.program('noise volume detail', FILL_VS, volumeFs('detail', d, this.seed))];
    this.unlisten = device.onRestored(() => (this.made = 0));
  }

  /** Layers over both volumes. */
  get layers(): number {
    return NOISE_VOLUME_SHAPE.size + NOISE_VOLUME_DETAIL.size;
  }

  /** True once every layer of both volumes is made. */
  get ready(): boolean {
    return this.made >= this.layers && this.shape !== null && this.detail !== null;
  }

  /** Makes up to `count` more layers; returns `ready`. Call it between passes (as `Device.fillLayer`). */
  step(count = this.layersPerStep): boolean {
    const shapeLayers = NOISE_VOLUME_SHAPE.size;
    for (let i = 0; i < count && this.made < this.layers; i++, this.made++) {
      const inShape = this.made < shapeLayers;
      const target = inShape ? this.shape : this.detail;
      if (!target) continue;
      this.device.fillLayer(target, inShape ? this.made : this.made - shapeLayers, this.programs[inShape ? 0 : 1], { u_layer: { int: inShape ? this.made : this.made - shapeLayers } });
    }
    return this.ready;
  }

  /** Binds the shape volume to `shapeUnit` and the detail volume to `detailUnit` (as `sampler3D`). */
  bind(device: Device, shapeUnit: number, detailUnit: number): void {
    device.volumeTexture(shapeUnit, this.shape);
    device.volumeTexture(detailUnit, this.detail);
  }

  /** Makes `layersPerStep` layers, once the driver has the programs ready (it compiles them in parallel where it can). */
  prepare(_device: Device, _view: View): void {
    if (this.made < this.layers && this.programs[0].isComplete() && this.programs[1].isComplete()) this.step();
  }

  draw(_ctx: DrawContext): void {}

  dispose(): void {
    this.unlisten();
    if (this.shape) this.device.deleteLayeredTarget(this.shape);
    if (this.detail) this.device.deleteLayeredTarget(this.detail);
  }
}
