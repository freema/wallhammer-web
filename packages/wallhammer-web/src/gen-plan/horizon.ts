// The skyline of a height field over a sphere grid: how high the relief round a point rises, seen from the point's own
// height, toward four directions laid into its tangent plane. The four directions are those of a tetrahedron in the
// axes of the grid, projected: no spin axis is needed, a direction is lost only where the light gives it no weight,
// and every point (the poles of any axis included) keeps at least three of them.
//
// A skyline is kept as a code of four bytes (the square root of the sine, so low skylines get the finer steps). Codes
// are computed at the nodes of the grid and blended to any point with the weights `gridSample` uses, so a point gets
// the same code from whichever caller asks. `horizonLit` and its GLSL twin turn a code, the point's up and a direction
// toward a light into a factor from hidden (0) to lit (1). Arithmetic and `Math.sqrt/floor/abs/min/max/round` only.

import type { Vec3 } from '../base/math.ts';
import { gridDirection, gridSample, gridWeights } from './grid.ts';
import type { SphereGrid } from './grid.ts';

const AXIS = 0.5773502691896258;

/** Four unit directions of a tetrahedron, in the axes of the grid: (1,1,1), (1,−1,−1), (−1,1,−1), (−1,−1,1) × 1/√3. */
export const HORIZON_AXES: readonly Vec3[] = [
  [AXIS, AXIS, AXIS],
  [AXIS, -AXIS, -AXIS],
  [-AXIS, AXIS, -AXIS],
  [-AXIS, -AXIS, AXIS],
];

export interface HorizonOptions {
  /** How far along the surface the skyline is looked for, metres. */
  reachM: number;
  /** Samples along each direction; they lie closer near the point and farther apart toward `reachM`. */
  steps: number;
  /** Heights under this (metres) count as this, at the point and at the samples. Default: none. */
  floorM?: number;
}

/**
 * Sine of the skyline's elevation (never under 0) seen from the field's own height at the point (x, y, z) (any length,
 * not zero), toward each of `HORIZON_AXES` laid into the tangent plane there. `heights` is one value per node of `g`,
 * in units of `unitM` metres, read with `gridSample`. Writes four values to `out`. Where an axis is (nearly) the
 * point's up, its value is 0.
 */
export function gridHorizon(g: SphereGrid, heights: ArrayLike<number>, unitM: number, x: number, y: number, z: number, o: HorizonOptions, out: Float32Array): void {
  const R = g.radiusM;
  const len = Math.sqrt(x * x + y * y + z * z);
  const ux = x / len;
  const uy = y / len;
  const uz = z / len;
  const floor = o.floorM;
  const heightAt = (dx: number, dy: number, dz: number): number => {
    const h = gridSample(g, heights, dx, dy, dz) * unitM;
    return floor !== undefined && h < floor ? floor : h;
  };
  const r0 = R + heightAt(ux, uy, uz);
  const steps = o.steps;
  for (let k = 0; k < 4; k++) {
    const a = HORIZON_AXES[k]!;
    const au = a[0] * ux + a[1] * uy + a[2] * uz;
    let tx = a[0] - au * ux;
    let ty = a[1] - au * uy;
    let tz = a[2] - au * uz;
    const tt = tx * tx + ty * ty + tz * tz;
    if (tt < 1e-12) {
      out[k] = 0;
      continue;
    }
    const tl = Math.sqrt(tt);
    tx /= tl;
    ty /= tl;
    tz /= tl;
    let best = 0;
    for (let j = 0; j < steps; j++) {
      const tau = (j + 1) / steps;
      const d = o.reachM * tau * (0.3 + 0.7 * tau);
      const q = d / R;
      let sx = ux + tx * q;
      let sy = uy + ty * q;
      let sz = uz + tz * q;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const c = 1 / Math.sqrt(1 + q * q);
      const s = q * c;
      const r = R + heightAt(sx, sy, sz);
      const rise = r * c - r0;
      if (rise <= 0) continue;
      const run = r * s;
      const sine = rise / Math.sqrt(rise * rise + run * run);
      if (sine > best) best = sine;
    }
    out[k] = best;
  }
}

/** One byte of a skyline: `round(255 · sqrt(clamp(sine, 0, 1)))`. */
export function horizonCode(sine: number): number {
  const s = sine < 0 ? 0 : sine > 1 ? 1 : sine;
  return Math.round(255 * Math.sqrt(s));
}

/** Skyline codes of a height field, computed at the grid's nodes on demand. Opaque; build it with `horizonField`. */
export interface HorizonField {
  readonly grid: SphereGrid;
}

interface FieldState extends HorizonField {
  heights: ArrayLike<number>;
  unitM: number;
  options: HorizonOptions;
  /** Per slot: the node whose codes it holds, −1 for none. */
  keys: Int32Array;
  /** Per slot: four codes. */
  codes: Uint8Array;
}

/**
 * A field of skyline codes over `heights` (one value per node of `g`, units of `unitM` metres). Node codes are
 * computed when first asked for and kept in a table of `slots` entries (default 65 536, five bytes each); a newer
 * node replaces an older one in its slot. The table only saves time: results never depend on what it holds.
 */
export function horizonField(g: SphereGrid, heights: ArrayLike<number>, unitM: number, o: HorizonOptions & { slots?: number }): HorizonField {
  if (heights.length !== g.count) throw new Error(`horizonField: ${heights.length} heights for ${g.count} nodes`);
  const slots = o.slots ?? 65_536;
  if (!(slots >= 1 && Number.isInteger(slots))) throw new Error(`horizonField: slots ${slots} must be a positive integer`);
  const options: HorizonOptions = { reachM: o.reachM, steps: o.steps };
  if (o.floorM !== undefined) options.floorM = o.floorM;
  const state: FieldState = { grid: g, heights, unitM, options, keys: new Int32Array(slots).fill(-1), codes: new Uint8Array(slots * 4) };
  return state;
}

const NODE_DIR: Vec3 = [0, 0, 0];
const NODE_SINES = new Float32Array(4);
const AT_NODES = new Int32Array(4);
const AT_WEIGHTS = new Float64Array(4);

/** The four codes of one node, from the table or computed into it. Returns the slot's offset into `codes`. */
function nodeCodes(f: FieldState, node: number): number {
  const slot = node % f.keys.length;
  const off = slot * 4;
  if (f.keys[slot] === node) return off;
  gridDirection(f.grid, node, NODE_DIR);
  gridHorizon(f.grid, f.heights, f.unitM, NODE_DIR[0], NODE_DIR[1], NODE_DIR[2], f.options, NODE_SINES);
  for (let k = 0; k < 4; k++) f.codes[off + k] = horizonCode(NODE_SINES[k]!);
  f.keys[slot] = node;
  return off;
}

/**
 * Four codes at the direction (x, y, z) (any length, not zero): the codes of the nodes round it, weighted as
 * `gridSample` weights them, rounded. At a node it is that node's code.
 */
export function horizonCodeAt(field: HorizonField, x: number, y: number, z: number, out: Uint8Array): void {
  const f = field as FieldState;
  const count = gridWeights(f.grid, x, y, z, AT_NODES, AT_WEIGHTS);
  let c0 = 0;
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  for (let k = 0; k < count; k++) {
    const off = nodeCodes(f, AT_NODES[k]!);
    const w = AT_WEIGHTS[k]!;
    c0 += w * f.codes[off]!;
    c1 += w * f.codes[off + 1]!;
    c2 += w * f.codes[off + 2]!;
    c3 += w * f.codes[off + 3]!;
  }
  out[0] = Math.min(255, Math.round(c0));
  out[1] = Math.min(255, Math.round(c1));
  out[2] = Math.min(255, Math.round(c2));
  out[3] = Math.min(255, Math.round(c3));
}

/**
 * How lit a point is by a light far away: 0 hidden by the skyline … 1 lit. `code` is four bytes 0–255 (as
 * `horizonCodeAt` gives them), `up` and `toLight` unit vectors in the axes of the grid; `soft` (> 0) is the half-width
 * of the edge in units of the sine. The skyline toward the light is the codes' sines blended by the squared share of
 * each axis in the light's direction along the surface. The same formula as `HORIZON_GLSL`.
 */
export function horizonLit(code: ArrayLike<number>, up: Vec3, toLight: Vec3, soft: number): number {
  const s = up[0] * toLight[0] + up[1] * toLight[1] + up[2] * toLight[2];
  const tx = toLight[0] - up[0] * s;
  const ty = toLight[1] - up[1] * s;
  const tz = toLight[2] - up[2] * s;
  let sw = 0;
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const a = HORIZON_AXES[k]!;
    const d = Math.max(0, tx * a[0] + ty * a[1] + tz * a[2]);
    const w = d * d;
    const c = code[k]! / 255;
    sw += w;
    sum += w * c * c;
  }
  const skyline = sw < 1e-12 ? 0 : sum / sw;
  const t = Math.min(1, Math.max(0, (s - skyline + soft) / (2 * soft)));
  return t * t * (3 - 2 * t);
}

const glslAxis = (k: number): string => {
  const a = HORIZON_AXES[k]!;
  return `vec3(${a.map((v) => v.toFixed(16)).join(', ')})`;
};

/**
 * GLSL of `horizonLit`: `float horizonLit(vec4 code, vec3 up, vec3 toLight, float soft)`, with `code` read from a
 * normalized u8 attribute (0–1). Needs no include and no uniform; paste it into either stage.
 */
export const HORIZON_GLSL = /* glsl */ `
float horizonLit(vec4 code, vec3 up, vec3 toLight, float soft) {
  float s = dot(up, toLight);
  vec3 t = toLight - up * s;
  vec4 d = max(vec4(dot(t, ${glslAxis(0)}), dot(t, ${glslAxis(1)}), dot(t, ${glslAxis(2)}), dot(t, ${glslAxis(3)})), 0.0);
  vec4 w = d * d;
  float sw = w.x + w.y + w.z + w.w;
  float skyline = sw < 1e-12 ? 0.0 : dot(w, code * code) / sw;
  return smoothstep(-soft, soft, s - skyline);
}
`;
