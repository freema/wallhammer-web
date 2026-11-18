// The maintenance corner at the foot of the central dome, left of the airlock: a tool board and cabinets on the wall,
// pipes coming down the shell, a workbench with a tool chest, a floodlight on a tripod, a cable reel on its cart and
// equipment crates; two cooling units with fans on the right of the airlock.

import { MeshBuilder } from './kit/mesh.ts';
import { place } from './kit/math.ts';
import type { V3 } from './kit/math.ts';
import { pipeRun } from './kit/shapes.ts';
import type { BuildContext, Contribution, OutpostModule } from './kit/types.ts';
import { cableReel, coolingUnit, floodlight, toolBoard, wallCabinet, workbench } from './props/equipment.ts';
import { crate } from './props/crate.ts';
import { onWall, stationPlan } from './station.ts';
import { rgb } from './style/palette.ts';

/** Angles on the central dome wall (θ from +z toward +x) of the things mounted on it. */
export const WALL = { board: -0.31, pipes: [-0.475, -0.502, -0.529], cabinets: [-0.6, -0.69], cooling: [0.76, 1.0] } as const;

export const maintenanceModule: OutpostModule = {
  name: 'maintenance',
  build(ctx: BuildContext): Contribution {
    const plan = stationPlan(ctx.layout, ctx.heightAt);
    const c = plan.domes.central!;
    const R = c.site.radius;
    const wall = new MeshBuilder();

    // On the wall: the tool board above the bench, two cabinets, two cooling units right of the airlock.
    wall.with(onWall(c, WALL.board, -0.07, 1.25), () => toolBoard(wall, 2.2, 1.3));
    wall.with(onWall(c, WALL.cabinets[0], 0.14, 1.0), () => wallCabinet(wall, 0.75, 1.0, 0.32));
    wall.with(onWall(c, WALL.cabinets[1], 0.18, 0.35), () => wallCabinet(wall, 0.7, 1.5, 0.38));
    wall.with(onWall(c, WALL.cooling[0], 0.42), () => coolingUnit(wall));
    wall.with(onWall(c, WALL.cooling[1], 0.36), () => coolingUnit(wall, 1.2, 0.68));

    // Pipes: out of the shell under the window band, down the wall, out at knee height and into the ground.
    const W = (a: number, r: number, y: number): V3 => [c.at[0] + Math.sin(a) * r, c.at[1] + y, c.at[2] + Math.cos(a) * r];
    WALL.pipes.forEach((a, k) => {
      wall.paint(rgb(k === 1 ? 'metal' : 'metalMid'));
      const out = R + 0.22 + k * 0.02, top = 3.0 - k * 0.18, knee = 0.55 + k * 0.12, foot = R + 0.75 + k * 0.22;
      pipeRun(wall, [W(a, R - 0.15, top), W(a, out, top), W(a, out, knee), W(a, foot, knee), W(a, foot, -0.2)], 0.065);
    });
    const bench = new MeshBuilder();
    bench.with(onWall(c, WALL.board, 0.66), () => workbench(bench, 2.4, 0.85, 1.0));

    // Floodlight, cable reel and crates on the ground (the stacked one on top of the big crate).
    const ground = new MeshBuilder();
    const at = (x: number, z: number, yaw: number) => place(x, ctx.heightAt(x, z), z, yaw);
    ground.with(at(-6.6, 11.0, 0.35), () => floodlight(ground));
    ground.with(at(-4.8, 12.1, 0.55), () => cableReel(ground));
    for (const k of ctx.layout.crates) ground.with(at(k.x, k.z, k.yaw), () => crate(ground, k.size));
    const big = ctx.layout.crates[0]!;
    ground.with(place(big.x + 0.1, ctx.heightAt(big.x, big.z) + big.size[1], big.z - 0.05, big.yaw + 0.2), () => crate(ground, [0.85, 0.55, 0.7]));
    ground.with(at(-0.9, 8.1, -0.3), () => crate(ground, [0.7, 0.45, 0.5]));

    return {
      statics: [
        { name: 'wall kit', mesh: wall },
        { name: 'workbench', mesh: bench },
        { name: 'ground kit', mesh: ground },
      ],
    };
  },
};
