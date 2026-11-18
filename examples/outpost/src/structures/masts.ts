// Masts and the communications dish: a tapered lattice tower with a platform and equipment on top, a pole antenna mast
// with sector panels, and a parabolic dish on a fork (a part: its record turns it, see `dishTransform`). Built at the
// local origin, ground at y = 0.

import type { MeshBuilder } from '../kit/mesh.ts';
import { compose, place, rotateX, rotateY } from '../kit/math.ts';
import type { Mat, V3 } from '../kit/math.ts';
import { box, cylinder, lathe, tube } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

export interface LatticeOptions {
  height: number;
  /** Half the leg spread at the foot and at the top. */
  base: number;
  top: number;
  /** Bays (levels of bracing). */
  bays: number;
}

/** A four-legged lattice tower: legs, a horizontal ring and an X brace on every face of every bay, a platform and kit on top. */
export function latticeTower(b: MeshBuilder, o: LatticeOptions): void {
  const H = o.height;
  const half = (y: number): number => o.base + ((o.top - o.base) * y) / H;
  const corner = (k: number, y: number): V3 => {
    const s = half(y);
    const cs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    return [cs[k]![0] * s, y, cs[k]![1] * s];
  };
  b.paint(rgb('orangeDark'));
  for (let k = 0; k < 4; k++) tube(b, corner(k, 0), corner(k, H), 0.08, { segments: 6, rims: false });
  for (let i = 0; i <= o.bays; i++) {
    const y0 = (H * i) / o.bays, y1 = (H * (i + 1)) / o.bays;
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      if (i > 0) tube(b, corner(k, y0), corner(k1, y0), 0.045, { segments: 5, rims: false });
      if (i < o.bays) {
        tube(b, corner(k, y0), corner(k1, y1), 0.035, { segments: 5, rims: false });
        tube(b, corner(k1, y0), corner(k, y1), 0.035, { segments: 5, rims: false });
      }
    }
  }
  // Concrete feet.
  b.paint(rgb('concrete'));
  for (let k = 0; k < 4; k++) {
    const c = corner(k, 0);
    b.with(place(c[0], -0.1, c[2]), () => box(b, [0.5, 0.35, 0.5]));
  }
  // Platform, equipment box, antennas and a beacon.
  const s = o.top + 0.35;
  b.paint(rgb('metal'));
  b.with(place(0, H, 0), () => box(b, [s * 2, 0.14, s * 2]));
  b.paint(rgb('shell'));
  b.with(place(0.15, H + 0.14, 0.1), () => box(b, [0.8, 0.9, 0.6]));
  b.paint(rgb('orange'));
  b.with(place(-0.35, H + 0.14, -0.3), () => box(b, [0.3, 0.55, 0.3]));
  b.paint(rgb('metalMid'));
  b.with(place(-0.2, H + 0.14, 0.3), () => cylinder(b, 0.05, 3.2, { segments: 6 }));
  b.paint(rgb('shell'));
  for (const [a, y] of [[0, 2.0], [2.1, 2.3], [4.2, 1.7]] as const)
    b.with(compose(place(-0.2, H + 0.14 + y, 0.3, a), place(0, 0, 0.1)), () => box(b, [0.16, 0.7, 0.08]));
  b.paint(rgb('orange'));
  b.with(place(-0.2, H + 3.34, 0.3), () => cylinder(b, 0.09, 0.18, { segments: 8 }));
}

export interface MastOptions {
  height: number;
  /** Rows of three sector panels (heights as a share of the mast). */
  panelRows?: readonly number[];
  /** Panel size [width, height]. */
  panel?: readonly [number, number];
  /** Crossarm with small whips at this share of the height. */
  crossarm?: number;
}

/** A pole mast with a guyed foot plate, rows of sector panels round it, an optional crossarm and an orange beacon. */
export function antennaMast(b: MeshBuilder, o: MastOptions): void {
  const H = o.height;
  b.paint(rgb('concrete'));
  box(b, [0.7, 0.25, 0.7]);
  b.paint(rgb('metalMid'));
  b.with(place(0, 0.25, 0), () => cylinder(b, 0.1, H - 0.25, { segments: 8, rTop: 0.07 }));
  const [pw, ph] = o.panel ?? [0.22, 1.0];
  for (const [i, f] of (o.panelRows ?? [0.82]).entries()) {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + i * 0.5;
      b.paint(rgb('metal'));
      b.with(compose(place(0, H * f, 0, a), place(0, ph * 0.4, 0.09)), () => box(b, [0.08, 0.08, 0.12]));
      b.paint(rgb('shell'));
      b.with(compose(place(0, H * f, 0, a), place(0, 0, 0.17)), () => box(b, [pw, ph, 0.09]));
    }
  }
  if (o.crossarm !== undefined) {
    const y = H * o.crossarm;
    b.paint(rgb('metal'));
    b.with(place(0, y, 0), () => box(b, [1.4, 0.07, 0.07]));
    b.paint(rgb('metalLight'));
    for (const x of [-0.65, 0.65]) b.with(place(x, y + 0.05, 0), () => cylinder(b, 0.025, 0.9, { segments: 5 }));
  }
  b.paint(rgb('orange'));
  b.with(place(0, H, 0), () => cylinder(b, 0.11, 0.2, { segments: 8 }));
}

/** Dish radius and the pivot height of the fork over its pedestal top. */
export const DISH = { radius: 1.05, depth: 0.32 } as const;

/**
 * The dish with its fork, about a pivot at the origin: the dish faces +z tipped up by `elevation` radians between the
 * fork arms. One part: its record turns the whole head about +y (`dishTransform`).
 */
export function dish(b: MeshBuilder, elevation = 0.45): void {
  const R = DISH.radius, D = DISH.depth;
  // Fork: a turntable and two arms either side of the dish.
  b.paint(rgb('metal'));
  cylinder(b, 0.22, 0.14, { segments: 12 });
  for (const s of [-1, 1]) b.with(place(s * (R * 0.55), 0.1, 0), () => box(b, [0.08, 0.35, 0.16]));
  b.paint(rgb('metalMid'));
  tube(b, [-R * 0.55, 0.4, 0], [R * 0.55, 0.4, 0], 0.05, { segments: 6, top: true, bottom: true });
  // The bowl: a closed lathe (the back cone out to the rim, then the concave front back to the centre), axis +z.
  const prof: [number, number][] = [[0, -0.18], [R * 0.45, -0.14], [R * 0.9, 0.05], [R, D]];
  const front: [number, number][] = [];
  for (let k = 0; k <= 6; k++) {
    const r = R * (1 - k / 6);
    front.push([r, D * (r / R) ** 2 + 0.02]);
  }
  b.with(compose(place(0, 0.4, 0), rotateX(-elevation), place(0, 0, 0.12), rotateX(Math.PI / 2)), () => {
    b.paint(rgb('shell'));
    lathe(b, [...prof, ...front], { segments: 24, rings: [3] });
    // Feed on three struts.
    b.paint(rgb('metal'));
    const fy = D + 0.75;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      tube(b, [Math.sin(a) * R * 0.93, D, Math.cos(a) * R * 0.93], [0, fy, 0], 0.02, { segments: 4, rims: false });
    }
    b.paint(rgb('metalMid'));
    b.with(place(0, fy - 0.05, 0), () => cylinder(b, 0.09, 0.2, { segments: 8, bottom: true }));
  });
}

/** Record transform of the dish head at pivot `p` (the pedestal top), turned `yaw` radians about +y. */
export function dishTransform(p: V3, yaw: number): Mat {
  return compose(place(p[0], p[1], p[2]), rotateY(yaw));
}
