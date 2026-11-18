// What moves at the outpost: the rover driving its loop along the tyre tracks, one astronaut walking between the foot
// of the airlock stairs and the maintenance corner, the other standing by the stairs talking with a hand held out.
//
// Engine systems used:
//   Simulation (fixed step)  both movers run in its ticks and keep their state in it (the walker and its route
//                            too), so the motion does not depend on the frame rate and the page can jump to any tick
//                            by restoring tick 0 and stepping (`sim.rebase`, `sim.step(n)`, __wh.setTick)
//   Movers + PathSet         the rover's distance along its loop: acceleration, cruising and a dwell at one stop
//   CollisionWorld + Walker  the walking astronaut: a kinematic body steered toward the route's points, sliding along
//                            the airlock, the stairs with their handrails, the bench and the crates instead of passing
//                            through them
//   Skeleton + MotionGraph   the figures: the suit skeleton, the idle stance and over it the walk cycle by speed,
//                            its phase following the distance walked (footfall marks are reported, nothing listens
//                            yet); `BoneInstances` writes the bones into the part records
// Written here: the rover's ground following and wheel turn (rover.ts), the motions of the suit (astronaut.ts) and
// the route steering of the walker.

import { MotionGraph, Pose, solvePose } from 'wallhammer-web/motion';
import { Movers, POSE_STRIDE } from 'wallhammer-web/sim';
import type { Simulation } from 'wallhammer-web/sim';
import { CollisionWorld, Walker, newWalkIntent } from 'wallhammer-web/world';
import { transformPoint } from '../kit/math.ts';
import type { V3 } from '../kit/math.ts';
import type { BuildContext, Contribution, FrameInfo, OutpostModule } from '../kit/types.ts';
import { WALL } from '../maintenance.ts';
import { onWall, stationPlan } from '../station.ts';
import { SUIT, SUIT_MOTION, SUIT_SKELETON, astronauts, figureRoot } from './astronaut.ts';
import type { FigureInput } from './astronaut.ts';
import { ROVER, poseRover, roverParts } from './rover.ts';

/** Rover cruising speed (m/s) and its stop on the loop (seconds parked in front of the camera). */
const ROVER_CRUISE = 1.3;
const ROVER_DWELL = 7;
/** Where on the loop the rover parks (the point of the loop nearest to this). */
const ROVER_STOP: [number, number] = [16.7, 9.0];
/** Walking speed of the astronaut (slow, in a suit) and how long it stays at each end of its route, seconds. */
const WALK_SPEED = 0.95;
const WALK_DWELL = [3.5, 5];

/** Yaw of the walker (0 faces −z) to a figure heading (0 faces +z). */
const headingOfYaw = (yaw: number): number => yaw + Math.PI;

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

export function lifeModule(sim: Simulation): OutpostModule {
  return {
    name: 'life',
    build(ctx: BuildContext): Contribution {
      const { layout, heightAt } = ctx;
      const hz = sim.hz;

      // --- Rover on the loop (driven clockwise, so it faces the station when it passes in front) --------------------
      const loop = [...layout.roverLoop].reverse();
      let stopAt = 0;
      loop.forEach(([x, z], i) => {
        const [sx, sz] = loop[stopAt]!;
        if (Math.hypot(x - ROVER_STOP[0], z - ROVER_STOP[1]) < Math.hypot(sx - ROVER_STOP[0], sz - ROVER_STOP[1])) stopAt = i;
      });
      let loopLength = 0;
      let stopDistance = 0;
      for (let i = 0; i < loop.length; i++) {
        if (i === stopAt) stopDistance = loopLength;
        const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
        loopLength += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      const movers = new Movers('rover', { hz, collision: 'none', width: 2.3 });
      const path = movers.paths.add({ points: loop.flat(), loop: true, stops: [{ vertex: stopAt, dwell: ROVER_DWELL }] });
      // The rover starts just after its stop, so the opening shot shows it rolling off toward the station.
      movers.spawn({ path, at: stopDistance + 0.6, cruise: ROVER_CRUISE, accel: 0.4, decel: 0.5, speed: 0.6 });
      sim.addState(movers);
      sim.addSystem('rover', movers.system);
      // The wheel turn repeats once per lap: a radius very near the wheel's own, fitted to whole turns per lap.
      const wheelR = ROVER.wheelR * ROVER.size;
      const spinRadius = loopLength / (2 * Math.PI * Math.round(loopLength / (2 * Math.PI * wheelR)));
      const rover = roverParts();
      const rover0 = new Float32Array(POSE_STRIDE);

      // --- The walking astronaut over a collision world of what stands near its route --------------------------------
      const plan = stationPlan(layout, heightAt);
      const c = plan.domes.central!;
      const world = new CollisionWorld({ heightAt, cellSize: 4 });
      world.addCylinder(c.at[0], c.at[2], c.site.radius + 0.25, -1, 12);
      const A = plan.airlock;
      const al = A.options;
      const fwd: V3 = [Math.sin(A.angle), 0, Math.cos(A.angle)];
      const portalMid = al.depth / 2 - 0.2, stairMid = al.depth + al.stairRun / 2;
      // The portal, then the stairs with the handrails as one block 0.2 m wider than the steps on each side.
      world.addBox(A.at[0] + fwd[0] * portalMid, A.at[2] + fwd[2] * portalMid, al.width / 2 + 0.05, al.depth / 2 + 0.2, A.angle, -1, al.height);
      world.addBox(A.at[0] + fwd[0] * stairMid, A.at[2] + fwd[2] * stairMid, al.stairW / 2 + 0.2, al.stairRun / 2, A.angle, -1, al.sill + 1.0);
      const bench = transformPoint(onWall(c, WALL.board, 0.66), [0, 0, 0]);
      world.addBox(bench[0], bench[2], 1.25, 0.5, WALL.board, -1, 1.2);
      for (const k of layout.crates) world.addBox(k.x, k.z, k.size[0] / 2 + 0.05, k.size[2] / 2 + 0.05, k.yaw, -1, k.size[1]);
      world.addBox(-0.9, 8.1, 0.4, 0.3, -0.3, -1, 0.5);
      world.addCylinder(-6.6, 11.0, 0.7, -1, 2.3);
      world.addCylinder(-4.8, 12.1, 0.65, -1, 1.2);

      const route = layout.walkerPath;
      const walker = new Walker(world, { radius: 0.3, height: SUIT.hip + 0.9, walkSpeed: WALK_SPEED, acceleration: 3, turnSpeed: 2.6, jumpSpeed: 0, stepHz: hz });
      const intent = newWalkIntent();
      /** Route state: the point aimed at, the direction along the route and ticks left at an end. */
      const st = { target: 1, dir: 1, wait: Math.round(1.5 * hz) };
      const [rx, rz] = route[0]!;
      walker.teleport(rx, heightAt(rx, rz), rz, Math.atan2(-(route[1]![0] - rx), -(route[1]![1] - rz)));
      sim.addState(walker.simState('walker'));
      sim.addState({
        name: 'walker route',
        save: (w) => (w.i32(st.target), w.i32(st.dir), w.i32(st.wait)),
        load: (r) => ((st.target = r.i32()), (st.dir = r.i32()), (st.wait = r.i32())),
      });
      sim.addSystem('walker', () => {
        intent.moveX = 0;
        intent.moveZ = 0;
        if (st.wait > 0) st.wait--;
        else {
          const [tx, tz] = route[st.target]!;
          const dx = tx - walker.position[0]!, dz = tz - walker.position[2]!;
          const d = Math.sqrt(dx * dx + dz * dz);
          const end = st.target === 0 || st.target === route.length - 1;
          if (d < (end ? 0.12 : 0.45)) {
            if (end) {
              st.wait = Math.round(WALK_DWELL[st.target === 0 ? 0 : 1]! * hz);
              st.dir = -st.dir;
            }
            st.target += st.dir;
          } else {
            // Ease in toward the ends of the route; full speed between.
            const k = (end ? Math.min(1, d / 0.8) : 1) / d;
            intent.moveX = dx * k;
            intent.moveZ = dz * k;
          }
        }
        walker.step(intent);
      });

      // --- Figures ---------------------------------------------------------------------------------------------------
      const suits = astronauts(2);
      const [walkingParts, standingParts] = suits.figures as [(typeof suits.figures)[number], (typeof suits.figures)[number]];
      const walking = new MotionGraph<FigureInput>(SUIT_MOTION, { time: 0, seed: 1.3, gesture: 0 });
      const standing = new MotionGraph<FigureInput>(SUIT_MOTION, { time: 0, seed: 4.1, gesture: 0 });
      const pose = new Pose(SUIT_SKELETON);
      const bones = new Float32Array(SUIT_SKELETON.count * 12);
      const at: [number, number, number] = [0, 0, 0];
      const [sx, sz] = layout.standSpot;
      const standAt: V3 = [sx, heightAt(sx, sz), sz];
      // The standing one faces the foot of the stairs, turned a little toward the camera.
      const standHeading = Math.atan2(route[0]![0] - sx, route[0]![1] + 1.2 - sz);
      /** Footfalls reported by the walk cycle's marks (nothing listens to them yet; `pnpm inspect` counts them). */
      const steps = { left: 0, right: 0 };
      const onEvent = (kind: string, name: string): void => {
        if (kind !== 'mark') return;
        if (name === 'step.l') steps.left++;
        else if (name === 'step.r') steps.right++;
      };
      let last = 0;

      const update = (f: FrameInfo): void => {
        const a = sim.alpha;
        // Rover.
        movers.extractPose(a, rover0);
        const heading = Math.atan2(rover0[2]!, rover0[3]!);
        poseRover(rover, rover0[0]!, rover0[1]!, heading, rover0[4]! / spinRadius, 0.9 * Math.sin(f.time * 0.35), heightAt);

        // Walker: between the last two ticks; the walk weighs in with the speed of the last tick.
        const dt = Math.max(0, f.time - last);
        last = f.time;
        walker.renderPosition(at, a);
        walking.input.time = f.time;
        walking.setParam('distance', walker.renderTravelled(a));
        walking.setParam('walk', smooth((walker.lastStepDistance * hz) / (WALK_SPEED * 0.6)));
        walking.update(dt);
        walking.drainEvents(onEvent);
        walking.evaluate(pose);
        solvePose(SUIT_SKELETON, pose, figureRoot(at, headingOfYaw(walker.renderYaw(a))), bones);
        walkingParts.write(bones);

        // Standing: a hand held out for a few seconds every ten or so.
        const cyc = f.time % 11;
        standing.input.time = f.time;
        standing.input.gesture = smooth((cyc - 2) / 0.8) * (1 - smooth((cyc - 6.5) / 0.9));
        standing.update(dt);
        standing.evaluate(pose);
        solvePose(SUIT_SKELETON, pose, figureRoot(standAt, standHeading), bones);
        standingParts.write(bones);
      };
      update({ time: 0, dt: 0, alpha: 0, eye: [0, 0, 0] });

      return {
        parts: [rover.body, rover.wheels, rover.arms, rover.sensor, ...suits.sets],
        update,
        counters: steps,
      };
    },
  };
}
