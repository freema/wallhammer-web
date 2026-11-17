// Placement of shadow areas: pure arithmetic, no GPU. A shadow area is a square of the light's plane kept in the shadow
// map. It is divided into blocks and lies on the world's block grid, so its texels never move against the world, and it
// follows a focus point in whole blocks only: while the focus stays within the middle of the area nothing has to be
// redrawn, and when the area steps, only the blocks it newly covers do. With a single area the map is addressed
// around its edges (a texel's place is its world texel number modulo the map size), so a step leaves every kept texel
// where it is.

import { cross, normalize } from '../base/math.ts';
import type { OrthoFrame, Vec3 } from '../base/math.ts';

/** Blocks along the edge of an area. */
export const AREA_BLOCKS = 16;
/**
 * Blocks from the focus that an area covers whatever its position on the grid: half its edge, less the slack that
 * lets the focus move without the area following at once.
 */
export const AREA_REACH_BLOCKS = 7;
/** The area follows the focus only when it is this many blocks beyond the middle block (so a focus resting on a block border does not make the area step back and forth). */
const STEP_SLACK_BLOCKS = 0.25;

/** One shadow area: where it lies on the block grid and where its first block is kept in its part of the map. */
export interface ShadowArea {
  /** Edge of a block in metres. 0: not placed yet. */
  blockM: number;
  /** The area's first block along the light plane's two axes, counted from the world origin. */
  bx: number;
  by: number;
  /** Block of its part of the map that holds the area's first block (0 unless the map is addressed around its edges). */
  startX: number;
  startY: number;
}

/** A rectangle of an area to draw: blocks relative to the area's first block, and the block of the map part it starts at. */
export interface AreaRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  tx: number;
  ty: number;
}

export function newShadowArea(): ShadowArea {
  return { blockM: 0, bx: 0, by: 0, startX: 0, startY: 0 };
}

/**
 * Axes of the light's plane for a unit direction toward the light. Fixed to the world and well defined for every
 * direction, straight above included (there the plane's second axis is taken from z instead of y).
 */
export function lightFrame(toLight: Vec3): OrthoFrame {
  const forward: Vec3 = [-toLight[0], -toLight[1], -toLight[2]];
  const ref: Vec3 = Math.abs(forward[1]) < 0.99 ? [0, 1, 0] : [0, 0, 1];
  const right = normalize(cross(forward, ref));
  const up = cross(right, forward);
  return { right, up, forward };
}

/** The first block of an area centred on a coordinate of the light's plane (metres from the world origin). */
function centred(coord: number, blockM: number): number {
  return Math.round(coord / blockM) - AREA_BLOCKS / 2;
}

/** Whether the focus coordinate is still within the middle of an area that starts at block `first`. */
function holds(coord: number, blockM: number, first: number): boolean {
  return Math.abs(coord / blockM - (first + AREA_BLOCKS / 2)) <= 0.5 + STEP_SLACK_BLOCKS;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Splits blocks [a0, a1) of an area whose first block is kept at block `start` of the map part where the address wraps around. */
function wrapped(a0: number, a1: number, start: number): [from: number, to: number, at: number][] {
  if (a1 <= a0) return [];
  const at = mod(start + a0, AREA_BLOCKS);
  const room = AREA_BLOCKS - at;
  if (a1 - a0 <= room) return [[a0, a1, at]];
  return [
    [a0, a0 + room, at],
    [a0 + room, a1, 0],
  ];
}

function rects(x0: number, x1: number, y0: number, y1: number, a: ShadowArea): AreaRect[] {
  const out: AreaRect[] = [];
  for (const [bx0, bx1, tx] of wrapped(x0, x1, a.startX)) for (const [by0, by1, ty] of wrapped(y0, y1, a.startY)) out.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, tx, ty });
  return out;
}

/**
 * Moves an area to follow the focus (`fx`, `fy`: its coordinates in the light's plane, metres from the world origin)
 * with blocks of `blockM`, and returns the rectangles of it that must be drawn: none while the focus stays within the
 * middle of the area, the newly covered blocks after a step, all of it when `redraw` is set, the block size changed or
 * the step is as long as the area. `around`: the area's part of the map is addressed around its edges, so a step
 * keeps what it still covers; without it every step draws the whole area.
 */
export function followFocus(a: ShadowArea, fx: number, fy: number, blockM: number, redraw: boolean, around: boolean): AreaRect[] {
  const N = AREA_BLOCKS;
  if (redraw || a.blockM !== blockM) {
    a.blockM = blockM;
    a.bx = centred(fx, blockM);
    a.by = centred(fy, blockM);
    a.startX = 0;
    a.startY = 0;
    return rects(0, N, 0, N, a);
  }
  const bx = holds(fx, blockM, a.bx) ? a.bx : centred(fx, blockM);
  const by = holds(fy, blockM, a.by) ? a.by : centred(fy, blockM);
  const dx = bx - a.bx;
  const dy = by - a.by;
  if (dx === 0 && dy === 0) return [];
  a.bx = bx;
  a.by = by;
  if (!around || Math.abs(dx) >= N || Math.abs(dy) >= N) {
    a.startX = 0;
    a.startY = 0;
    return rects(0, N, 0, N, a);
  }
  a.startX = mod(a.startX + dx, N);
  a.startY = mod(a.startY + dy, N);
  // The strip the step along the first axis uncovered, over the whole height; then the strip of the other axis over
  // the columns that are left.
  const out: AreaRect[] = [];
  const keepX0 = dx < 0 ? -dx : 0;
  const keepX1 = dx > 0 ? N - dx : N;
  if (dx > 0) out.push(...rects(N - dx, N, 0, N, a));
  else if (dx < 0) out.push(...rects(0, -dx, 0, N, a));
  if (dy > 0) out.push(...rects(keepX0, keepX1, N - dy, N, a));
  else if (dy < 0) out.push(...rects(keepX0, keepX1, 0, -dy, a));
  return out;
}

/**
 * Block sizes of a single area that follows the scale of the view: the ladder `baseBlockM × 2^(k/2)`, k = 0 … `top`.
 * Returns the step for a view whose half extent around the focus is `halfSpanM`, of which the area must cover
 * `shownShare` of its reach without fading. `current` (−1: none yet) is kept while it still fits and is not more
 * than one step too coarse, so a zoom resting on a border does not switch back and forth.
 */
export function ladderStep(halfSpanM: number, baseBlockM: number, top: number, shownShare: number, current: number): number {
  const fit = (half: number): number => {
    let k = 0;
    while (k < top && baseBlockM * 2 ** (k / 2) * AREA_REACH_BLOCKS * shownShare < half) k++;
    return k;
  };
  const needed = fit(halfSpanM);
  if (current < 0 || current < needed) return needed;
  const relaxed = fit(halfSpanM * 1.3);
  return current > relaxed ? relaxed : current;
}
