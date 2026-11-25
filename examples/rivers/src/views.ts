// What to look at: views chosen from the plan, shared by the page (its presets) and the picture script. A pure
// function of the plan; a view whose feature the seed lacks (no fall, no lake) is left out.

import { naturalHeight } from './land.ts';
import type { PathPlan } from './paths.ts';
import { STEP_M, type BrookPlan } from './brooks.ts';
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

/**
 * The views of the brooks: `brook`, one course from its spring to the water it runs into, seen from the air beside it,
 * and `brook-near`, the last stretch of that course from its bank at walking height, looking down it. The course
 * is the longest brook that ends in water up to 600 m long (or the shortest longer one); its tributaries enter it
 * along the way. None without such a course. Then the close views of `brookCloseViews`.
 */
export function brookViews(bp: BrookPlan, groundAt?: (x: number, z: number) => number): RiverView[] {
  const out: RiverView[] = [];
  // The longest brook into water up to 600 m long, or the shortest longer one.
  let best: number[] = [];
  let bestM = 0;
  bp.brooks.forEach((b, i) => {
    if (!b.intoWater) return;
    const lengthM = b.n * STEP_M;
    const better = bestM === 0 || (lengthM <= 600 ? bestM > 600 || lengthM > bestM : bestM > 600 && lengthM < bestM);
    if (better) {
      bestM = lengthM;
      best = [i];
    }
  });
  if (best.length === 0) return out;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const id of best) {
    const b = bp.brooks[id]!;
    for (let i = 0; i < b.n; i++) {
      xs.push(b.x[i]!);
      ys.push(b.bank[i]!);
      zs.push(b.z[i]!);
    }
  }
  const m = xs.length;
  const sx = xs[0]!;
  const sz = zs[0]!;
  const ex = xs[m - 1]!;
  const ez = zs[m - 1]!;
  const len = Math.hypot(ex - sx, ez - sz) || 1;
  const dx = (ex - sx) / len;
  const dz = (ez - sz) / len;
  const mid = Math.floor(m / 2);
  const reach = Math.max(45, 0.38 * len);
  // From the air, from the side of the course and a little behind its middle.
  add(out, 'brook', [xs[mid]! - dz * reach - dx * 0.25 * reach, Math.max(...ys) + 0.75 * reach, zs[mid]! + dx * reach - dz * 0.25 * reach], [xs[mid]!, ys[mid]!, zs[mid]!], 55);
  // At walking height on its bank some 36 m up from where it ends, looking down it at a slant.
  const i = Math.max(0, m - 1 - Math.round(36 / STEP_M));
  const k = Math.min(m - 1, i + Math.round(14 / STEP_M));
  const j = Math.max(0, i - Math.round(6 / STEP_M));
  const fx = xs[i]! - xs[j]!;
  const fz = zs[i]! - zs[j]!;
  const fl = Math.hypot(fx, fz) || 1;
  add(out, 'brook-near', [xs[i]! - (fz / fl) * 3.2 - (fx / fl) * 3, ys[i]! + 1.7, zs[i]! + (fx / fl) * 3.2 - (fz / fl) * 3], [xs[k]!, ys[k]! - 0.25, zs[k]!], 60);
  out.push(...brookCloseViews(bp, groundAt));
  return out;
}

/**
 * Close views of where brooks meet water and each other: `brook-mouth-1`, `brook-mouth-2` (the two mouths with the
 * largest basins at least 150 m apart) and `brook-join-1`, `brook-join-2` (the same for junctions, by the basin of the
 * tributary), each low and oblique from some 8 m and, with `-top`, from 22 m straight over it. The low
 * eye stands at least 1.6 m over `groundAt` where it is given.
 */
function brookCloseViews(bp: BrookPlan, groundAt?: (x: number, z: number) => number): RiverView[] {
  const out: RiverView[] = [];
  const pick = <T extends { x: number; z: number; flow: number }>(all: T[]): T[] => {
    const chosen: T[] = [];
    for (const c of [...all].sort((a, b) => b.flow - a.flow)) {
      if (chosen.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= 150)) chosen.push(c);
      if (chosen.length === 2) break;
    }
    return chosen;
  };
  // A place, its height and the direction the water runs there.
  type Spot = { x: number; z: number; y: number; dx: number; dz: number; flow: number };
  const dir = (b: BrookPlan['brooks'][number], i: number, j: number): [number, number] => {
    const dx = b.x[j]! - b.x[i]!;
    const dz = b.z[j]! - b.z[i]!;
    const d = Math.hypot(dx, dz) || 1;
    return [dx / d, dz / d];
  };
  const mouths: Spot[] = [];
  for (const b of bp.brooks) {
    if (!b.intoWater || !(b.shoreM < Infinity)) continue;
    const s = Math.min(b.n - 1, Math.round(b.shoreM / STEP_M));
    const [dx, dz] = dir(b, Math.max(0, s - 6), s);
    mouths.push({ x: b.x[s]!, z: b.z[s]!, y: b.water[s]!, dx, dz, flow: b.flow });
  }
  const joins: Spot[] = [];
  for (const n of bp.nodes) {
    const s = bp.brooks[n.stem]!;
    let e = 0;
    for (let i = 1; i < s.n; i++) if (Math.hypot(s.x[i]! - n.x, s.z[i]! - n.z) < Math.hypot(s.x[e]! - n.x, s.z[e]! - n.z)) e = i;
    const [dx, dz] = dir(s, Math.max(0, e - 3), Math.min(s.n - 1, e + 3));
    joins.push({ x: n.x, z: n.z, y: n.bank, dx, dz, flow: n.flow });
  }
  const shoot = (name: string, p: Spot, back: number): void => {
    // Low: from upstream of a mouth (looking out over the water), from downstream of a junction (looking up into its Y).
    const ex = p.x - p.dx * back * 7 - p.dz * 3;
    const ez = p.z - p.dz * back * 7 + p.dx * 3;
    add(out, name, [ex, Math.max(p.y + 2.2, (groundAt?.(ex, ez) ?? -Infinity) + 1.6), ez], [p.x + p.dx * back * 2, p.y - 0.2, p.z + p.dz * back * 2], 60);
    add(out, `${name}-top`, [p.x - p.dx * back * 2, p.y + 22, p.z - p.dz * back * 2], [p.x, p.y, p.z], 55);
  };
  pick(mouths).forEach((m, i) => shoot(`brook-mouth-${i + 1}`, m, 1));
  pick(joins).forEach((j, i) => shoot(`brook-join-${i + 1}`, j, -1));
  return out;
}

function add(out: RiverView[], name: string, eye: V3, target: V3, fov: number): void {
  out.push({ name, eye, target, fov });
}
