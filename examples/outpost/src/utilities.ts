// The outlying equipment of the outpost: the lattice tower (back left), the generators with their antenna masts
// (behind the station, right of the central dome), two groups of tilted solar panels (instanced) and the octagonal
// landing pad with its markings, ramp and edge lights (instanced).

import { MeshBuilder } from './kit/mesh.ts';
import { compose, place, transformPoint } from './kit/math.ts';
import { instanceSet, pushInstance } from 'wallhammer-web/render';
import type { BuildContext, Contribution, OutpostModule } from './kit/types.ts';
import type { Site } from './layout.ts';
import { PAD, landingPad, padLight, padLightSpots, padMarkings } from './structures/landing-pad.ts';
import type { PadOptions } from './structures/landing-pad.ts';
import { antennaMast, latticeTower } from './structures/masts.ts';
import { generator, solarPanel, utilityBox } from './structures/power.ts';

/** Solar fields: panels per row and rows, spacing across and between rows (metres). */
const SOLAR_FIELDS: Record<string, { cols: number; rows: number; across: number; between: number }> = {
  'solar-west': { cols: 3, rows: 2, across: 3.75, between: 3.4 },
  'solar-north': { cols: 4, rows: 1, across: 3.75, between: 3.4 },
};

/** Panel positions of a solar field site (world x, z) and the field's yaw. */
export function solarSpots(s: Site): { x: number; z: number; yaw: number }[] {
  const f = SOLAR_FIELDS[s.id] ?? { cols: 3, rows: 1, across: 3.75, between: 3.4 };
  const out: { x: number; z: number; yaw: number }[] = [];
  for (let r = 0; r < f.rows; r++) {
    for (let c = 0; c < f.cols; c++) {
      const lx = (c - (f.cols - 1) / 2) * f.across, lz = (r - (f.rows - 1) / 2) * f.between;
      const [x, , z] = transformPoint(place(s.x, 0, s.z, s.yaw), [lx, 0, lz]);
      out.push({ x, z, yaw: s.yaw });
    }
  }
  return out;
}

export const utilitiesModule: OutpostModule = {
  name: 'utilities',
  build(ctx: BuildContext): Contribution {
    const L = ctx.layout;
    const ground = (x: number, z: number): number => ctx.heightAt(x, z);

    // Lattice tower.
    const tower = new MeshBuilder();
    tower.with(place(L.tower.x, ground(L.tower.x, L.tower.z), L.tower.z, L.tower.yaw), () => latticeTower(tower, { height: 15, base: 1.35, top: 0.5, bays: 7 }));

    // Generators in a row with a cabinet, and the antenna masts among them.
    const gen = new MeshBuilder();
    const g = L.generators;
    const gy = ground(g.x, g.z);
    gen.with(place(g.x, gy, g.z, g.yaw), () => {
      for (const [x, z, s] of [[-3.0, 0, [2.4, 1.6, 1.5]], [0, 0.2, [2.6, 1.8, 1.6]], [3.0, -0.1, [2.2, 1.5, 1.4]]] as const) gen.with(place(x, 0, z), () => generator(gen, s));
      gen.with(place(-1.4, 0, 2.0, 0.2), () => utilityBox(gen, [0.8, 0.9, 0.5]));
    });
    const a = L.antennas;
    const ay = ground(a.x, a.z);
    gen.with(place(a.x, ay, a.z), () => antennaMast(gen, { height: 9.5, panelRows: [0.68, 0.85], crossarm: 0.5 }));
    gen.with(place(a.x - 8.5, ground(a.x - 8.5, a.z - 1.5), a.z - 1.5), () => antennaMast(gen, { height: 7.0, panelRows: [0.8] }));
    gen.with(place(a.x + 2.5, ground(a.x + 2.5, a.z + 2.2), a.z + 2.2), () => antennaMast(gen, { height: 5.0, panelRows: [0.75], panel: [0.18, 0.8] }));

    // Solar fields: one panel mesh, one record per panel.
    const panelMesh = new MeshBuilder();
    solarPanel(panelMesh);
    const spots = L.solar.flatMap((s) => solarSpots(s));
    const panels = instanceSet(panelMesh.build(), spots.length, { name: 'solar panels' });
    for (const p of spots) pushInstance(panels, place(p.x, ground(p.x, p.z), p.z, p.yaw));

    // Landing pad, markings, edge lights.
    const P = L.landingPad;
    const po: PadOptions = { ...PAD, radius: P.radius };
    const py = ground(P.x, P.z);
    const pad = new MeshBuilder();
    pad.with(place(P.x, py, P.z, P.yaw), () => landingPad(pad, po));
    const marks = new MeshBuilder();
    marks.with(place(P.x, py, P.z, P.yaw), () => padMarkings(marks, po));
    const lightMesh = new MeshBuilder();
    padLight(lightMesh);
    const lightSpots = padLightSpots(po);
    const lights = instanceSet(lightMesh.build(), lightSpots.length, { name: 'pad lights' });
    for (const s of lightSpots) pushInstance(lights, compose(place(P.x, py, P.z, P.yaw), place(s[0], s[1], s[2])));

    return {
      statics: [
        { name: 'tower', mesh: tower },
        { name: 'generators', mesh: gen },
        { name: 'landing pad', mesh: pad },
        { name: 'pad markings', mesh: marks, kind: 'decal' },
      ],
      parts: [panels, lights],
    };
  },
};
