// Maintenance equipment: a tool board, a workbench with a rolling tool chest, a wall cabinet, a cooling unit with
// fans, a floodlight on a tripod and a cable reel on a cart. Each builder stands at the local origin, ground (or the
// wall, for wall-mounted things: the wall at z = 0) at y = 0, front toward +z.

import type { MeshBuilder } from '../kit/mesh.ts';
import { compose, place, rotateX, rotateZ } from '../kit/math.ts';
import { box, cylinder, panelGrid, polygon, tube } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

/** Paint without a hull (markings on a face). */
function decal(b: MeshBuilder, fn: () => void): void {
  const o = b.outline;
  b.outline = false;
  try {
    fn();
  } finally {
    b.outline = o;
  }
}

/** A perforated board on the wall with wrenches and orange-handled tools hung on it; its foot at y = 0. */
export function toolBoard(b: MeshBuilder, w = 1.9, h = 1.1): void {
  b.paint(rgb('metalLight'));
  b.with(place(0, 0, 0.035), () => box(b, [w, h, 0.07]));
  decal(b, () => {
    b.paint(rgb('metalMid'));
    b.with(place(0, 0.08, 0.075), () => panelGrid(b, w - 0.16, h - 0.16, 1, 1));
  });
  // Wrenches: a handle and a head ring; pliers and screwdrivers with orange grips.
  const n = 4;
  for (let k = 0; k < n; k++) {
    const x = -w / 2 + 0.25 + k * 0.24;
    b.paint(rgb('metal'));
    b.with(place(x, h * 0.22, 0.08), () => box(b, [0.06, h * 0.5, 0.03]));
    b.with(compose(place(x, h * 0.72, 0.08), rotateX(Math.PI / 2)), () => cylinder(b, 0.07, 0.03, { segments: 8, bottom: true }));
  }
  for (let k = 0; k < 3; k++) {
    const x = w * 0.12 + k * 0.22;
    b.paint(rgb('metal'));
    b.with(place(x, h * 0.55, 0.08), () => box(b, [0.04, h * 0.25, 0.03]));
    b.paint(rgb('orange'));
    b.with(place(x, h * 0.25, 0.08), () => box(b, [0.08, h * 0.3, 0.04]));
  }
}

/** A workbench: a steel top on four legs with a shelf, an orange rolling tool chest under one end, a case on top. */
export function workbench(b: MeshBuilder, w = 2.1, d = 0.8, h = 0.95): void {
  b.paint(rgb('metal'));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.with(place(sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08)), () => box(b, [0.07, h - 0.06, 0.07]));
  b.with(place(0, 0.25, 0), () => box(b, [w - 0.1, 0.04, d - 0.1]));
  b.paint(rgb('metalLight'));
  b.with(place(0, h - 0.06, 0), () => box(b, [w, 0.06, d]));
  // Rolling chest under the left end: drawers as panel lines, castors.
  const cw = 0.75, ch = h - 0.24, cx = -w / 2 + cw / 2 + 0.12;
  b.paint(rgb('orange'));
  b.with(place(cx, 0.12, 0.04), () => box(b, [cw, ch, d - 0.22]));
  decal(b, () => {
    b.paint(rgb('orangeDark'));
    b.with(place(cx, 0.18, 0.04 + (d - 0.22) / 2 + 0.005), () => panelGrid(b, cw - 0.1, ch - 0.12, 1, 4));
  });
  b.paint(rgb('rubber'));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.with(place(cx + sx * (cw / 2 - 0.08), 0, 0.04 + sz * ((d - 0.22) / 2 - 0.06)), () => box(b, [0.08, 0.12, 0.08]));
  // A tool case and a meter on top.
  b.paint(rgb('metalMid'));
  b.with(place(-w * 0.18, h, -0.05), () => box(b, [0.6, 0.24, 0.32]));
  b.paint(rgb('metal'));
  b.with(place(-w * 0.18, h + 0.24, -0.05), () => box(b, [0.25, 0.05, 0.04]));
  b.paint(rgb('shellPanel'));
  b.with(place(w * 0.3, h, 0.05), () => box(b, [0.22, 0.3, 0.14]));
  b.paint(rgb('orange'));
  b.with(place(w * 0.3, h + 0.3, 0.05), () => cylinder(b, 0.03, 0.18, { segments: 6 }));
}

/** A wall cabinet (an electrical box): a body, a door frame line, a small grille and an orange tag. */
export function wallCabinet(b: MeshBuilder, w = 0.8, h = 1.1, d = 0.35): void {
  b.paint(rgb('metalLight'));
  box(b, [w, h, d]);
  decal(b, () => {
    b.paint(rgb('shellPanel'));
    b.with(place(0, 0.06, d / 2 + 0.005), () => panelGrid(b, w - 0.12, h - 0.12, 1, 1));
    b.paint(rgb('metalMid'));
    b.with(place(0, h * 0.12, d / 2 + 0.01), () => panelGrid(b, w * 0.5, h * 0.18, 4, 1));
    b.paint(rgb('orange'));
    b.with(place(w * 0.22, h * 0.7, d / 2 + 0.01), () => panelGrid(b, w * 0.16, h * 0.1, 1, 1));
  });
  b.paint(rgb('metal'));
  b.with(place(-w * 0.32, h * 0.45, d / 2), () => box(b, [0.04, 0.18, 0.04]));
}

/** A fan in a round frame (facing +z): a dark disc, a hub and blades. */
function fan(b: MeshBuilder, r: number): void {
  b.paint(rgb('metalMid'));
  b.with(rotateX(Math.PI / 2), () => cylinder(b, r, 0.04, { segments: 20 }));
  decal(b, () => {
    b.paint(rgb('rubber'));
    b.with(compose(place(0, 0, 0.045), rotateX(Math.PI / 2)), () => cylinder(b, r * 0.86, 0.005, { segments: 20, rims: true }));
    b.paint(rgb('metalLight'));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      b.with(compose(place(0, 0, 0.055), rotateZ(a)), () =>
        polygon(b, [[0, 0, 0], [r * 0.3, r * 0.72, 0], [-r * 0.05, r * 0.8, 0]], false),
      );
    }
  });
  b.paint(rgb('metal'));
  b.with(compose(place(0, 0, 0.05), rotateX(Math.PI / 2)), () => cylinder(b, r * 0.18, 0.04, { segments: 10 }));
}

/** A cooling unit: a louvred lower box and an upper box with two fans, on short feet; its back against the wall. */
export function coolingUnit(b: MeshBuilder, w = 1.6, d = 0.8): void {
  b.paint(rgb('metal'));
  for (const sx of [-1, 1]) b.with(place(sx * (w / 2 - 0.15), 0, 0), () => box(b, [0.14, 0.12, d]));
  b.paint(rgb('shellPanel'));
  b.with(place(0, 0.12, 0), () => box(b, [w, 0.75, d]));
  b.paint(rgb('shell'));
  b.with(place(0, 0.87, 0), () => box(b, [w, 0.95, d]));
  decal(b, () => {
    b.paint(rgb('metalMid'));
    b.with(place(0, 0.2, d / 2 + 0.005), () => panelGrid(b, w * 0.82, 0.55, 1, 6));
  });
  for (const sx of [-1, 1]) b.with(place((sx * w) / 4.2, 1.34, d / 2 + 0.01), () => fan(b, 0.34));
}

/** A floodlight: an orange tripod, a mast and a bar with two lamp heads facing +z. */
export function floodlight(b: MeshBuilder, h = 2.2): void {
  const hub = h * 0.55;
  b.paint(rgb('orange'));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.5;
    tube(b, [0, hub, 0], [Math.sin(a) * 0.75, 0, Math.cos(a) * 0.75], 0.035, { segments: 6, top: true, bottom: true });
  }
  b.paint(rgb('metal'));
  b.with(place(0, hub - 0.1, 0), () => cylinder(b, 0.05, h - hub + 0.1, { segments: 8 }));
  b.with(place(0, h, 0), () => box(b, [0.95, 0.06, 0.06]));
  for (const s of [-1, 1]) {
    b.paint(rgb('metal'));
    b.with(compose(place(s * 0.27, h + 0.03, 0), rotateX(-0.25)), () => box(b, [0.4, 0.32, 0.18]));
    decal(b, () => {
      b.paint(rgb('lamp'));
      b.with(compose(place(s * 0.27, h + 0.03, 0), rotateX(-0.25), place(0, 0.04, 0.095)), () => panelGrid(b, 0.32, 0.24, 2, 1));
    });
  }
}

/** A cable reel on a small cart: an orange frame on four castors, a push handle, a drum wound with dark cable. */
export function cableReel(b: MeshBuilder, r = 0.42, width = 0.5): void {
  b.paint(rgb('rubber'));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.with(compose(place(sx * 0.34, 0.07, sz * 0.38), rotateZ(Math.PI / 2), place(0, -0.03, 0)), () => cylinder(b, 0.07, 0.06, { segments: 8, bottom: true }));
  b.paint(rgb('orange'));
  b.with(place(0, 0.12, 0), () => box(b, [0.8, 0.06, 0.95]));
  const axleY = 0.18 + r;
  for (const sx of [-1, 1]) {
    tube(b, [sx * (width / 2 + 0.06), 0.15, -0.3], [sx * (width / 2 + 0.06), axleY, 0], 0.03, { segments: 6, top: true });
    tube(b, [sx * (width / 2 + 0.06), 0.15, 0.3], [sx * (width / 2 + 0.06), axleY, 0], 0.03, { segments: 6, top: true });
  }
  // Push handle at the back.
  tube(b, [-0.3, 0.15, -0.45], [-0.3, 1.0, -0.62], 0.025, { segments: 6, top: true });
  tube(b, [0.3, 0.15, -0.45], [0.3, 1.0, -0.62], 0.025, { segments: 6, top: true });
  tube(b, [-0.32, 1.0, -0.62], [0.32, 1.0, -0.62], 0.03, { segments: 6, top: true, bottom: true });
  // Drum: two orange flanges and the wound cable between them, axis along x.
  b.with(compose(place(0, axleY, 0), rotateZ(Math.PI / 2)), () => {
    b.paint(rgb('orangeDark'));
    for (const s of [-1, 1]) b.with(place(0, s * (width / 2) - 0.02, 0), () => cylinder(b, r, 0.04, { segments: 20, bottom: true }));
    b.paint(rgb('cable'));
    b.with(place(0, -width / 2 + 0.02, 0), () => cylinder(b, r * 0.78, width - 0.04, { segments: 20, ribs: 0 }));
  });
}
