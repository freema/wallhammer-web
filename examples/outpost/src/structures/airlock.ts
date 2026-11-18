// The airlock portal: a chamfered box standing out of a dome wall (its back sunk into the shell), an orange trim
// round a teal double door raised above the ground, lamps by the door, steps up to the door with side stringers,
// and orange handrails on both sides. Built at the local origin: the wall surface at z = 0 (the back reaches to
// −`sink`), front toward +z, ground at y = 0.

import type { MeshBuilder } from '../kit/mesh.ts';
import { place } from '../kit/math.ts';
import { band, box, cylinder, panelGrid, pipeRun, polygon, prism } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

export interface AirlockOptions {
  /** Portal width, height and how far its front stands off the wall. */
  width: number;
  height: number;
  depth: number;
  /** How far the back sinks into the wall (enough to stay inside a curved shell). */
  sink: number;
  /** Door sill height (the top step), door width and height. */
  sill: number;
  doorW: number;
  doorH: number;
  /** Steps: count, width, run (total depth in front of the portal). */
  steps: number;
  stairW: number;
  stairRun: number;
}

export const AIRLOCK: AirlockOptions = { width: 5.4, height: 4.4, depth: 2.6, sink: 2.0, sill: 1.2, doorW: 2.5, doorH: 2.5, steps: 7, stairW: 2.5, stairRun: 3.6 };

/** Chamfered outline [x, y], counter-clockwise from +z: `w` wide, `h` high, top corners cut by `c`, from y = y0. */
function chamfered(w: number, h: number, c: number, y0 = 0): [number, number][] {
  const x = w / 2;
  return [[-x, y0], [x, y0], [x, y0 + h - c], [x - c, y0 + h], [-x + c, y0 + h], [-x, y0 + h - c]];
}

/** Front of the stairs (their foot), metres in front of the wall. */
export function stairFoot(o: AirlockOptions = AIRLOCK): number {
  return o.depth + o.stairRun;
}

export function airlock(b: MeshBuilder, o: AirlockOptions = AIRLOCK): void {
  const zf = o.depth;
  // Body: a lower concrete plinth course, then the off-white portal.
  b.paint(rgb('concreteDark'));
  prism(b, chamfered(o.width + 0.1, 0.7, 0), -o.sink, zf + 0.05);
  b.paint(rgb('shell'));
  prism(b, chamfered(o.width, o.height - 0.7, 0.85, 0.7), -o.sink, zf);
  // A raised frame round the door opening, standing 0.18 m proud of the front.
  const doorTop = o.sill + o.doorH;
  const opening = chamfered(o.doorW, o.doorH, 0.42, o.sill);
  const frame = chamfered(o.doorW + 0.9, o.doorH + 0.5, 0.7, o.sill - 0.1);
  b.paint(rgb('shellPanel'));
  prism(b, frame, zf - 0.05, zf + 0.18, { back: false });

  // Orange trim on the frame, teal door leaves inside it, a sign above: paint, no hull.
  const outline = b.outline;
  b.outline = false;
  b.paint(rgb('orange'));
  band(b, frame.map(([x, y]) => [x * 0.94, o.sill - 0.1 + (y - o.sill + 0.1) * 0.95] as [number, number]), opening.map(([x, y]) => [x * 1.08, o.sill + (y - o.sill) * 1.04 - 0.04] as [number, number]), zf + 0.19);
  b.paint(rgb('teal'));
  const half = o.doorW / 2;
  const leaf = (s: number): [number, number, number][] => {
    const pts: [number, number, number][] = [[0, o.sill, 0], [s * half, o.sill, 0], [s * half, doorTop - 0.42, 0], [s * (half - 0.42), doorTop, 0], [0, doorTop, 0]];
    return s > 0 ? pts : pts.reverse();
  };
  b.with(place(0, 0, zf + 0.2), () => {
    polygon(b, leaf(1));
    polygon(b, leaf(-1));
  });
  // Handles and a small window in each leaf.
  b.paint(rgb('tealLight'));
  for (const s of [-1, 1]) b.with(place(s * half * 0.5, o.sill + o.doorH * 0.62, zf + 0.21), () => panelGrid(b, 0.42, 0.55, 1, 1));
  b.outline = outline;
  b.paint(rgb('metal'));
  for (const s of [-1, 1]) b.with(place(s * 0.14, o.sill + o.doorH * 0.42, zf + 0.2), () => box(b, [0.06, 0.4, 0.06]));

  // Side lamps by the door.
  b.paint(rgb('orange'));
  for (const s of [-1, 1]) b.with(place(s * (o.doorW / 2 + 0.75), o.sill + o.doorH - 0.1, zf + 0.07), () => box(b, [0.22, 0.3, 0.16]));

  // Steps: blocks from the ground, each a riser higher; side stringers.
  const rise = o.sill / o.steps, run = o.stairRun / o.steps;
  b.paint(rgb('metalLight'));
  for (let k = 0; k < o.steps; k++) {
    const h = rise * (k + 1);
    const z = zf + o.stairRun - run * (k + 0.5) - run * 0.0;
    b.with(place(0, 0, z), () => box(b, [o.stairW, h, run]));
  }
  b.paint(rgb('concrete'));
  for (const s of [-1, 1]) {
    const x = s * (o.stairW / 2 + 0.09);
    // Profile in the y–z plane, extruded across x: a sloped stringer under the treads.
    b.with(place(x, 0, 0, Math.PI / 2), () =>
      prism(b, [[-zf - o.stairRun - 0.05, 0], [-zf, 0], [-zf, o.sill + 0.14], [-zf - 0.25, o.sill + 0.14], [-zf - o.stairRun - 0.05, 0.16]], -0.09, 0.09),
    );
  }

  // Handrails: posts at the foot, the middle and the top, a sloped rail and a mid rail, and a level run to the portal.
  b.paint(rgb('orange'));
  const railH = 1.0;
  for (const s of [-1, 1]) {
    const x = s * (o.stairW / 2 + 0.12);
    const footZ = zf + o.stairRun - 0.15;
    const topZ = zf + 0.35;
    const at = (z: number): number => o.sill * Math.min(1, Math.max(0, (zf + o.stairRun - z) / o.stairRun));
    const posts = [footZ, (footZ + topZ) / 2, topZ];
    for (const z of posts) b.with(place(x, at(z) + 0.1, z), () => cylinder(b, 0.05, railH, { segments: 8 }));
    pipeRun(b, [[x, at(footZ) + 0.1 + railH, footZ], [x, at(topZ) + 0.1 + railH, topZ], [x, at(topZ) + 0.1 + railH, zf + 0.02]], 0.055, { segments: 8, flange: 0.07 });
    pipeRun(b, [[x, at(footZ) + 0.1 + railH * 0.5, footZ], [x, at(topZ) + 0.1 + railH * 0.5, topZ]], 0.04, { segments: 6, flange: 0.055 });
  }
}
