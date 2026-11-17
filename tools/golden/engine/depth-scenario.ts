// Golden scenario of the depth modes and the render origin (base/view.ts). It returns the data that is hashed and
// throws when one of its own conditions does not hold: a metre and a thousand kilometres keep their order in depth as
// 32-bit floats, the standard mode is the view's own matrix, and a render origin on all axes keeps the numbers small.

import { depthViewProj, orthoMatrix, snapRenderOrigin, toRenderSpace } from '../../../packages/wallhammer-web/src/base/index.ts';
import type { DepthMode, OrthoFrame, Vec3, View } from '../../../packages/wallhammer-web/src/base/index.ts';

const f32 = Math.fround;
const AXES: OrthoFrame = { right: [0.8, 0, 0.6], up: [0, 1, 0], forward: [0.6, 0, -0.8] };
const EYE: Vec3 = [300, 700, -200];
const WIDTH = 1600;
const HEIGHT = 900;
/** Tangent of half the vertical field of view, as a constant (no library function enters the hash through it). */
const TAN_HALF = 0.4663;

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** A perspective view with the standard matrix every rig of the engine builds (far : near at most 2000). */
function perspectiveView(): View {
  return {
    width: WIDTH,
    height: HEIGHT,
    dpr: 1,
    heading: 0,
    metresPerPixel: (50 * 2 * TAN_HALF) / HEIGHT,
    pixelGrowth: (2 * TAN_HALF) / HEIGHT,
    refDepth: dot(AXES.forward, EYE) + 50,
    axes: () => AXES,
    viewProj(sceneCenter: Vec3, depthHalfRange: number): Float32Array {
      const { right: r, up: u, forward: w } = AXES;
      const dc = dot(w, sceneCenter) - dot(w, EYE);
      const far = Math.max(dc + depthHalfRange, 1);
      const near = Math.max(dc - depthHalfRange, far / 2000, 0.05);
      const fy = 1 / TAN_HALF;
      const fx = fy / (WIDTH / HEIGHT);
      const a = (far + near) / (far - near);
      const b = (-2 * far * near) / (far - near);
      const m = new Float32Array(16);
      for (let i = 0; i < 3; i++) {
        m[i * 4 + 0] = fx * r[i]!;
        m[i * 4 + 1] = fy * u[i]!;
        m[i * 4 + 2] = a * w[i]!;
        m[i * 4 + 3] = w[i]!;
      }
      m[12] = -fx * dot(r, EYE);
      m[13] = -fy * dot(u, EYE);
      m[14] = -a * dot(w, EYE) + b;
      m[15] = -dot(w, EYE);
      return m;
    },
    cornerRays: () => [-1, 1].flatMap(() => [-1, 1].map(() => ({ origin: EYE, dir: AXES.forward }))),
    cullVolume: () => ({ kind: 'frustum', planes: [] }),
    key: () => 'depth scenario',
  };
}

/** An orthographic view: 400 m wide, depth from the matrix alone. */
function orthoView(): View {
  return {
    ...perspectiveView(),
    metresPerPixel: 0.25,
    pixelGrowth: 0,
    refDepth: 0,
    viewProj: (sceneCenter: Vec3, depthHalfRange: number): Float32Array => orthoMatrix(AXES, dot(AXES.right, EYE), dot(AXES.up, EYE), dot(AXES.forward, sceneCenter), 200, 112.5, depthHalfRange),
  };
}

/** Clip coordinates of a point, computed in 32-bit floats as a vertex shader would. */
function clip(m: Float32Array, p: Vec3): [number, number, number, number] {
  const row = (r: number): number => f32(f32(f32(m[r]! * f32(p[0])) + f32(m[4 + r]! * f32(p[1]))) + f32(f32(m[8 + r]! * f32(p[2])) + m[12 + r]!));
  return [row(0), row(1), row(2), row(3)];
}

/** Distances along the view, in metres: pairs that depth has to tell apart, from the near plane to 1,000 km. */
const DISTANCES = [0.11, 0.5, 1, 1.002, 10, 1000, 1000.5, 100_000, 100_010, 1_000_000, 1_000_050, 1_900_000];

export function depthModes(): unknown[] {
  const out: unknown[] = [];
  const center: Vec3 = [EYE[0] + AXES.forward[0] * 1_000_000, EYE[1], EYE[2] + AXES.forward[2] * 1_000_000];
  const halfRange = 1_000_000;
  const nearM = 0.1;
  const view = perspectiveView();
  const ahead = (d: number): Vec3 => [EYE[0] + AXES.forward[0] * d, EYE[1] + AXES.forward[1] * d + 0.01 * d, EYE[2] + AXES.forward[2] * d];

  // Standard: the view's own matrix, value for value.
  const standard = depthViewProj(view, 'standard', center, halfRange, nearM);
  const own = view.viewProj(center, halfRange);
  if (standard.logScale !== 0 || standard.viewProj.some((v, i) => v !== own[i])) throw new Error('depth: the standard mode must return the matrix of the view unchanged');
  out.push(standard.viewProj);

  for (const mode of ['reversed', 'logarithmic'] as DepthMode[]) {
    const p = depthViewProj(view, mode, center, halfRange, nearM);
    if ((mode === 'logarithmic') !== p.logScale > 0) throw new Error(`depth: ${mode} has the logarithmic scale ${p.logScale}`);
    let last = mode === 'reversed' ? Infinity : -Infinity;
    const depths: number[] = [];
    for (const d of DISTANCES) {
      const c = clip(p.viewProj, ahead(d));
      const s = clip(own, ahead(d));
      // The image position is the same in every mode; only depth differs.
      for (const i of [0, 1, 3]) if (Math.abs(c[i]! - s[i]!) > 1e-4 * Math.max(1, Math.abs(s[i]!))) throw new Error(`depth: ${mode} moves the image at ${d} m (${c[i]} against ${s[i]})`);
      // Reversed: depth is clip z / w, 1 at the near plane and 0 at infinity. Logarithmic: the fragment shader's formula.
      const depth = mode === 'reversed' ? f32(c[2] / c[3]) : f32(f32(Math.log2(1 + c[3])) * f32(p.logScale));
      if (!(depth >= 0 && depth <= 1)) throw new Error(`depth: ${mode} leaves 0–1 at ${d} m (${depth})`);
      if (mode === 'reversed' ? !(depth < last) : !(depth > last)) throw new Error(`depth: ${mode} cannot tell ${d} m from the distance before it`);
      last = depth;
      depths.push(depth);
    }
    out.push(p.viewProj, Float32Array.from(depths), f32(p.logScale));
  }

  // Orthographic: reversed flips the linear depth to 1 near, 0 far (clip z from 0 to w); logarithmic leaves it alone.
  const ortho = orthoView();
  const oc: Vec3 = [EYE[0], EYE[1], EYE[2]];
  const flat = ortho.viewProj(oc, 500);
  const flipped = depthViewProj(ortho, 'reversed', oc, 500, nearM);
  const kept = depthViewProj(ortho, 'logarithmic', oc, 500, nearM);
  if (kept.logScale !== 0 || kept.viewProj.some((v, i) => v !== flat[i])) throw new Error('depth: logarithmic must leave an orthographic view alone');
  const along = (d: number): Vec3 => [oc[0] + AXES.forward[0] * d, oc[1], oc[2] + AXES.forward[2] * d];
  const nearZ = clip(flipped.viewProj, along(-500))[2];
  const farZ = clip(flipped.viewProj, along(500))[2];
  if (Math.abs(nearZ - 1) > 1e-5 || Math.abs(farZ) > 1e-5 || flipped.logScale !== 0) throw new Error(`depth: reversed orthographic depth runs from ${nearZ} to ${farZ}, not from 1 to 0`);
  out.push(flipped.viewProj);

  // Render origin: 1,000 km out and 400 km up. On all axes the eye is a small number on the GPU, exact to 0.1 mm.
  const focus = [1_000_300.7, 400_123.3, -77.9] as const;
  const flatOrigin = snapRenderOrigin(focus, 1024);
  const fullOrigin = snapRenderOrigin(focus, 1024, 'all');
  if (flatOrigin[0] !== 999_424 || flatOrigin[1] !== 0 || flatOrigin[2] !== -1024) throw new Error(`origin: horizontal snap gives ${flatOrigin.join(', ')}`);
  if (fullOrigin[0] !== 999_424 || fullOrigin[1] !== 399_360 || fullOrigin[2] !== -1024) throw new Error(`origin: snap on all axes gives ${fullOrigin.join(', ')}`);
  const error = (origin: Vec3): number => {
    const p = toRenderSpace(focus, origin);
    return Math.max(...p.map((v) => Math.abs(f32(v) - v)));
  };
  if (!(error(fullOrigin) < 1e-4)) throw new Error(`origin: on all axes the eye is off by ${error(fullOrigin)} m as a 32-bit float`);
  if (!(error(flatOrigin) > 10 * error(fullOrigin))) throw new Error('origin: the horizontal origin should be visibly less exact at this height');
  out.push(flatOrigin, fullOrigin, Float32Array.from(toRenderSpace(focus, fullOrigin)));
  return out;
}
