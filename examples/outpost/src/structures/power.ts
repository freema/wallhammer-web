// Power and service units: a tilted solar panel on its stand (one instanced part per panel), a generator unit, a
// roof service unit and a small utility box. Built at the local origin, ground at y = 0, front toward +z.

import type { MeshBuilder } from '../kit/mesh.ts';
import { compose, place, rotateX } from '../kit/math.ts';
import { box, cylinder, panelGrid, tube } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

export interface SolarOptions {
  /** Panel width (x) and length up the slope. */
  width: number;
  length: number;
  /** Tilt from the horizontal, radians (the face looks toward +z and up). */
  tilt: number;
  /** Height of the low edge above the ground. */
  clearance: number;
  /** Cells across and up the slope. */
  cols: number;
  rows: number;
}

export const SOLAR: SolarOptions = { width: 3.4, length: 2.2, tilt: 0.66, clearance: 0.5, cols: 6, rows: 4 };

/** One solar panel: a metal frame tray, teal cells divided by panel lines, two short and two tall legs, a cross brace. */
export function solarPanel(b: MeshBuilder, o: SolarOptions = SOLAR): void {
  const { width: W, length: L, tilt } = o;
  const rise = Math.sin(tilt) * L, run = Math.cos(tilt) * L;
  // Panel frame: the low edge at +z, the high edge at −z.
  const zLow = run / 2, zHigh = -run / 2;
  const yLow = o.clearance, yHigh = o.clearance + rise;
  b.with(compose(place(0, yLow, zLow), rotateX(-(Math.PI / 2 - tilt))), () => {
    // In this frame the panel lies in the x–y plane facing +z, from y = 0 (low edge) to y = L.
    b.paint(rgb('metalLight'));
    b.with(place(0, -0.04, -0.045), () => box(b, [W + 0.1, L + 0.08, 0.09]));
    const outline = b.outline;
    b.outline = false;
    b.paint(rgb('teal'));
    b.with(place(0, 0.02, 0.005), () => panelGrid(b, W - 0.08, L - 0.04, o.cols, o.rows));
    b.outline = outline;
  });
  // Legs under the four corners and a brace between the tall ones.
  b.paint(rgb('metal'));
  for (const s of [-1, 1]) {
    const x = s * (W / 2 - 0.25);
    tube(b, [x, -0.1, zLow - 0.1], [x, yLow - 0.02, zLow - 0.1], 0.05, { segments: 6, top: true });
    tube(b, [x, -0.1, zHigh + 0.2], [x, yHigh - 0.08, zHigh + 0.2], 0.05, { segments: 6, top: true });
    tube(b, [x, 0.15, zLow - 0.1], [x, yHigh - 0.3, zHigh + 0.2], 0.03, { segments: 5, rims: false });
  }
  tube(b, [-(W / 2 - 0.25), yHigh * 0.55, zHigh + 0.2], [W / 2 - 0.25, yHigh * 0.55, zHigh + 0.2], 0.03, { segments: 5, rims: false });
  b.paint(rgb('concrete'));
  for (const s of [-1, 1]) for (const z of [zLow - 0.1, zHigh + 0.2]) b.with(place(s * (W / 2 - 0.25), -0.08, z), () => box(b, [0.3, 0.2, 0.3]));
}

/** A generator unit: a skid, an off-white body with a grille, an orange band, a roof vent and an exhaust stack. */
export function generator(b: MeshBuilder, size: readonly [number, number, number]): void {
  const [w, h, d] = size;
  b.paint(rgb('metal'));
  box(b, [w + 0.2, 0.18, d + 0.2]);
  b.paint(rgb('shell'));
  b.with(place(0, 0.18, 0), () => box(b, [w, h, d]));
  b.paint(rgb('shellPanel'));
  b.with(place(w * 0.18, 0.18 + h, -d * 0.1), () => box(b, [w * 0.45, 0.22, d * 0.55]));
  const outline = b.outline;
  b.outline = false;
  b.paint(rgb('metalMid'));
  b.with(place(-w * 0.18, 0.18 + h * 0.2, d / 2 + 0.01), () => panelGrid(b, w * 0.42, h * 0.55, 7, 1));
  b.paint(rgb('orange'));
  b.with(place(0, 0.18 + h * 0.82, d / 2 + 0.01), () => panelGrid(b, w, h * 0.08, 1, 1));
  b.with(place(w * 0.3, 0.18 + h * 0.3, d / 2 + 0.01), () => panelGrid(b, w * 0.18, h * 0.22, 1, 2));
  b.outline = outline;
  b.paint(rgb('metal'));
  b.with(place(-w * 0.32, 0.18 + h, -d * 0.2), () => cylinder(b, 0.1, 0.6, { segments: 8 }));
}

/** The roof service unit on the central dome: a box with a louvred front and a fan on top. */
export function serviceUnit(b: MeshBuilder, size: readonly [number, number, number]): void {
  const [w, h, d] = size;
  b.paint(rgb('shellPanel'));
  box(b, [w, h, d]);
  const outline = b.outline;
  b.outline = false;
  b.paint(rgb('metalMid'));
  b.with(place(0, h * 0.15, d / 2 + 0.01), () => panelGrid(b, w * 0.8, h * 0.6, 1, 6));
  b.outline = outline;
  b.paint(rgb('metal'));
  b.with(place(0, h, 0), () => cylinder(b, Math.min(w, d) * 0.3, 0.1, { segments: 14 }));
}

/** A small utility box on legs (a junction box, a vent) with a grille door. */
export function utilityBox(b: MeshBuilder, size: readonly [number, number, number], accent = true): void {
  const [w, h, d] = size;
  b.paint(rgb('metalMid'));
  box(b, [w * 0.9, 0.12, d * 0.9]);
  b.paint(rgb('shellPanel'));
  b.with(place(0, 0.12, 0), () => box(b, [w, h, d]));
  const outline = b.outline;
  b.outline = false;
  b.paint(rgb('metalMid'));
  b.with(place(0, 0.12 + h * 0.2, d / 2 + 0.01), () => panelGrid(b, w * 0.7, h * 0.35, 5, 1));
  if (accent) {
    b.paint(rgb('orange'));
    b.with(place(w * 0.25, 0.12 + h * 0.66, d / 2 + 0.01), () => panelGrid(b, w * 0.2, h * 0.14, 1, 1));
  }
  b.outline = outline;
}
