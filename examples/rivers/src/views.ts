// What to look at: views chosen from the plan, shared by the page (its presets) and the picture script. A pure
// function of the plan; a view whose feature the seed lacks (no fall, no lake) is left out.

import { naturalHeight } from './land.ts';
import type { PathPlan } from './paths.ts';
import type { Line, Plan } from './plan.ts';

export interface RiverView {
  name: string;
  eye: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view, degrees. */
  fov: number;
}

type V3 = [number, number, number];

/** Unit direction of a line's valley around station `i`, over `back` stations each way. */
function along(l: Line, i: number, back: number): V3 {
  const a = Math.max(0, Math.min(l.n - 1, i - back));
  const b = Math.max(0, Math.min(l.n - 1, i + back));
  const dx = l.ax[b]! - l.ax[a]!;
  const dz = l.az[b]! - l.az[a]!;
  const d = Math.hypot(dx, dz) || 1;
  return [dx / d, 0, dz / d];
}

/** The highest fall of all lines: its line, its station and its height, or null without a fall. */
export function highestFall(plan: Plan): { line: Line; i: number; drop: number } | null {
  let best: { line: Line; i: number; drop: number } | null = null;
  for (const l of plan.lines)
    for (let i = 0; i + 1 < l.n; i++)
      if (l.fall[i] && l.level[i]! - l.level[i + 1]! > (best?.drop ?? 0)) best = { line: l, i, drop: l.level[i]! - l.level[i + 1]! };
  return best;
}

/** The station where the channel of a line swings farthest from the valley's middle. */
export function widestSwing(l: Line): number {
  let mi = 0;
  let ms = 0;
  for (let i = 0; i < l.n; i++) {
    const s = Math.hypot(l.cx[i]! - l.ax[i]!, l.cz[i]! - l.az[i]!);
    if (s > ms) {
      ms = s;
      mi = i;
    }
  }
  return mi;
}

/**
 * The views of a plan, in the order `island`, `fall`, `fall-above`, `bends`, `bank`, `mouth`, `upper`, `lake`, and
 * with paths `path` and `path-above`.
 */
export function viewsOf(plan: Plan, paths?: PathPlan): RiverView[] {
  const out: RiverView[] = [];
  const add = (name: string, eye: V3, target: V3, fov = 58): void => void out.push({ name, eye, target, fov });
  // The whole island.
  add('island', [1500, 1100, 2300], [-100, 0, -100], 50);
  const main = plan.lines[0];
  if (main) {
    // The highest fall of all lines, from downstream and from above the lip.
    const top = highestFall(plan);
    if (top) {
      const { line: fl, i: fi, drop: fd } = top;
      const d = along(fl, fi, 6);
      const low = fl.level[fi + 1]!;
      add('fall', [fl.cx[fi]! + d[0] * 70 - d[2] * 18, low + 9, fl.cz[fi]! + d[2] * 70 + d[0] * 18], [fl.cx[fi]!, low + fd * 0.45, fl.cz[fi]!]);
      add('fall-above', [fl.cx[fi]! - d[0] * 60 + d[2] * 30, fl.level[fi]! + 30, fl.cz[fi]! - d[2] * 60 - d[0] * 30], [fl.cx[fi]! + d[0] * 20, low, fl.cz[fi]! + d[2] * 20]);
    }
    // The widest swing of the largest line: from the air and from the bank.
    const mi = widestSwing(main);
    {
      const d = along(main, mi, 10);
      const lv = main.level[mi]!;
      add('bends', [main.ax[mi]! + d[0] * 230 + d[2] * 120, lv + 150, main.az[mi]! + d[2] * 230 - d[0] * 120], [main.ax[mi]! - d[0] * 40, lv, main.az[mi]! - d[2] * 40]);
      add('bank', [main.cx[mi]! + d[0] * 60 + d[2] * 14, lv + 3.2, main.cz[mi]! + d[2] * 60 - d[0] * 14], [main.cx[mi]! - d[0] * 40, lv, main.cz[mi]! - d[2] * 40], 64);
    }
    // The mouth, from over the sea.
    {
      const i = main.n - 12;
      const d = along(main, i, 8);
      add('mouth', [main.ax[i]! + d[0] * 260 + d[2] * 60, 75, main.az[i]! + d[2] * 260 - d[0] * 60], [main.ax[i]! - d[0] * 60, 0, main.az[i]! - d[2] * 60]);
    }
    // The steep upper part of the largest line, from the bank looking upstream.
    {
      const i = Math.round(main.n * 0.22);
      const d = along(main, i, 8);
      const lv = main.level[i]!;
      add('upper', [main.cx[i]! + d[0] * 50 + d[2] * 10, lv + 4, main.cz[i]! + d[2] * 50 - d[0] * 10], [main.cx[i]! - d[0] * 40, lv + 6, main.cz[i]! - d[2] * 40], 64);
    }
  }
  // The largest lake.
  const lake = [...plan.lakes].sort((a, b) => b.nodes - a.nodes)[0];
  if (lake) {
    // From as far as the lake is large, and from the side on which the sight line clears the ground best: a lake in
    // the mountains has a ridge on some of its sides.
    const reach = Math.min(330, Math.max(150, 2.4 * Math.sqrt(lake.nodes * 400)));
    let eye: V3 = [0, 0, 0];
    let clear = -Infinity;
    for (let a = 0; a < 12; a++) {
      const turn = 0.66 + (a * Math.PI) / 6;
      const from: V3 = [lake.x + reach * Math.cos(turn), lake.level + 0.34 * reach, lake.z + reach * Math.sin(turn)];
      let over = 25;
      for (let t = 0; t < 0.85; t += 0.05) {
        const y = from[1] + (lake.level - from[1]) * t;
        over = Math.min(over, y - naturalHeight(plan.seed, from[0] + (lake.x - from[0]) * t, from[2] + (lake.z - from[2]) * t));
      }
      if (over > clear) {
        clear = over;
        eye = from;
      }
    }
    add('lake', eye, [lake.x, lake.level, lake.z]);
  }
  // The first path: from a walker's eyes along it, and from the air over the same place.
  const way = paths?.paths[0];
  if (way && way.n > 80) {
    const i = Math.round(way.n * 0.35);
    const j = Math.min(way.n - 1, i + 10);
    const dx = way.x[j]! - way.x[i]!;
    const dz = way.z[j]! - way.z[i]!;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d;
    const uz = dz / d;
    add('path', [way.x[i]! - ux * 4 + uz * 0.8, way.y[i]! + 1.6, way.z[i]! - uz * 4 - ux * 0.8], [way.x[j]!, way.y[j]! + 0.3, way.z[j]!], 62);
    add('path-above', [way.x[i]! - ux * 34 + uz * 16, way.y[i]! + 24, way.z[i]! - uz * 34 - ux * 16], [way.x[j]!, way.y[j]!, way.z[j]!]);
  }
  return out;
}

/** How high over a walker's feet the `walker` view looks, metres: about the middle of the figure. */
export const WALKER_LOOK_M = 0.85;

/**
 * The view `walker`: a walker (its place on the ground and its heading) from behind and a little to its left, the
 * middle of the path's side, about 6 m away and 1.8 m up, so the whole figure and some path ahead are in the picture.
 */
export function walkerView(position: readonly number[], forward: readonly number[]): RiverView {
  const [x, y, z] = position as [number, number, number];
  const fx = forward[0]!;
  const fz = forward[2]!;
  // Right of the heading with y up: (−fz, fx).
  const rx = -fz;
  const rz = fx;
  return { name: 'walker', eye: [x - fx * 5.6 - rx * 1.9, y + 1.8, z - fz * 5.6 - rz * 1.9], target: [x, y + WALKER_LOOK_M, z], fov: 55 };
}
