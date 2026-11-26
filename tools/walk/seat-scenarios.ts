// Scenarios of the engine's pieces for bodies that carry other bodies, on made-up worlds (no example code): free places
// to stand beside a carrier (`CollisionWorld.standSpot`, `firstStandSpot`), getting off with the walker put where it
// will stand at once (`releaseToWalker`), fixed steps out of frame times (`FixedSteps` in core, behind `Walker` and
// `WheeledGroup`) and the group's hook after every step.

import { FixedSteps } from '../../packages/wallhammer-web/src/core/fixed-steps.ts';
import { SeatTransition } from '../../packages/wallhammer-web/src/motion/seat-transition.ts';
import { CollisionWorld } from '../../packages/wallhammer-web/src/world/collide.ts';
import type { StandSpotOptions } from '../../packages/wallhammer-web/src/world/collide.ts';
import { attachFromWalker, releaseToWalker } from '../../packages/wallhammer-web/src/world/seat-walker.ts';
import { Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import { WheeledBody, WheeledGroup, newWheeledIntent } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import type { WheeledIntent } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

const flat = (): CollisionWorld => new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
const BODY: StandSpotOptions = { radius: 0.3, height: 1.7, maxStepUp: 0.35 };

export const SEAT_SCENARIOS: Scenario[] = [
  {
    name: 'stand-spot-wall-drop-step',
    run() {
      // A carrier at the origin (its own box 1 × 2 m, a solid); candidates 1.2 m to each side. A wall 0.9 m to the
      // left blocks the left; a pit to the right is too deep, a low box (0.2 m) still stands, a high one (0.6 m) not.
      const w = flat();
      w.addBox(0, 0, 0.5, 1, 0, 0, 1.5);
      const left = [-0.85, 0, -1.2, 0];
      const right = [0.85, 0, 1.2, 0];
      const free = { l: w.standSpot(-0.85, 0, -1.2, 0, 0, BODY), r: w.standSpot(0.85, 0, 1.2, 0, 0, BODY) };
      const wall = w.addBox(-0.95, 0, 0.05, 3, 0, 0, 2);
      const walled = w.standSpot(-0.85, 0, -1.2, 0, 0, BODY);
      const out = new Float64Array(3);
      const first = w.firstStandSpot([...left, ...right], 0, BODY, out);
      w.remove(wall);
      const low = w.addBox(1.2, 0, 0.5, 0.5, 0, 0, 0.2, { standable: true });
      const onLow = w.standSpot(0.85, 0, 1.2, 0, 0, BODY);
      w.remove(low);
      const high = w.addBox(1.2, 0, 0.5, 0.5, 0, 0, 0.6, { standable: true });
      const onHigh = w.standSpot(0.85, 0, 1.2, 0, 0, BODY);
      w.remove(high);
      const pit = new CollisionWorld({ heightAt: (x) => (x > 1 ? -0.8 : 0) });
      const overPit = pit.standSpot(0.85, 0, 1.2, 0, 0, BODY);
      const none = pit.firstStandSpot([0.85, 0, 1.2, 0], 0, BODY);
      const ok = free.l === 0 && free.r === 0 && Number.isNaN(walled) && first === 1 && out[0] === 1.2 && out[1] === 0 && Math.abs(onLow - 0.2) < 1e-12 && Number.isNaN(onHigh) && Number.isNaN(overPit) && none === -1;
      return verdict(ok, `open sides ${f(free.l)}/${f(free.r)}, left by the wall ${f(walled)}, first free ${first} at (${f(out[0]!)}, ${f(out[1]!)}), on a 0.2 m box ${f(onLow)}, on a 0.6 m box ${f(onHigh)}, over a 0.8 m pit ${f(overPit)} (none: ${none})`);
    },
  },
  {
    name: 'release-walker-at-once',
    run() {
      // Getting on from the walker's place, then off: the walker is at the place it will stand from the first moment
      // of getting off, and a release while not held changes nothing.
      const w = flat();
      const walker = new Walker(w);
      walker.teleport(2, 0, 3, 0.5);
      const tr = new SeatTransition({ attach: { seconds: 1 }, release: { seconds: 1 } });
      const early = releaseToWalker(tr, walker, 9, 0, 9, 0);
      const stayed = walker.position[0] === 2 && walker.position[2] === 3;
      attachFromWalker(tr, walker, 0.5);
      const from = tr.from[0] === 2 && tr.from[2] === 3 && tr.from[3] === 0.5;
      for (let i = 0; i < 120; i++) tr.advance(1 / 60);
      const held = tr.phase === 'held';
      const released = releaseToWalker(tr, walker, 5, 0, 6, 1);
      const there = walker.position[0] === 5 && walker.position[2] === 6 && walker.yaw === 1 && tr.phase === 'release';
      return verdict(!early && stayed && from && held && released && there, `release before getting on refused ${!early} (walker kept ${stayed}), getting on from the walker ${from}, held ${held}, walker at the place as getting off starts ${there}`);
    },
  },
  {
    name: 'fixed-steps-frame-times',
    run() {
      // The same 2 s of frames at 1/30, 1/60 and uneven times run the same number of steps; a walker advanced by them
      // ends bit-equal to one stepped by hand; a pause of 1 s runs at most `maxSteps`.
      const count = (dts: number[]): number => {
        const fs = new FixedSteps(1 / 60, 15);
        let n = 0;
        for (const dt of dts) fs.advance(dt, () => n++);
        return n;
      };
      const uneven: number[] = [];
      for (let t = 0, i = 0; t < 2 - 1e-9; i++) {
        const dt = Math.min(2 - t, [0.011, 0.023, 0.0167, 0.031][i % 4]!);
        uneven.push(dt);
        t += dt;
      }
      const a = count(new Array(60).fill(1 / 30)), b = count(new Array(120).fill(1 / 60)), c = count(uneven);
      const stalled = count([1]);
      const w = flat();
      const i = newWalkIntent();
      i.moveZ = -1;
      const p = new Walker(w), q = new Walker(w);
      for (let k = 0; k < 60; k++) p.advance(1 / 30, i);
      for (let k = 0; k < 120; k++) q.step(i);
      const same = p.position[2] === q.position[2] && p.velocity[2] === q.velocity[2];
      return verdict(a === 120 && b === 120 && c === 120 && stalled === 15 && same, `steps of 2 s at 1/30 ${a}, at 1/60 ${b}, uneven ${c}; a 1 s stall ${stalled}; a walker by frames equals one by steps ${same} (z ${f(p.position[2]!)})`);
    },
  },
  {
    name: 'wheeled-group-after-step',
    run() {
      // The hook runs once after every step and may change the intents of the next one: a group advanced by frames
      // with a hook that switches the throttle on at step 30 ends bit-equal to one stepped by hand the same way.
      const run = (frames: boolean): { state: Uint8Array; calls: number; steps: number } => {
        const w = flat();
        const bodies = [new WheeledBody(w), new WheeledBody(w)];
        bodies[0]!.teleport(0, bodies[0]!.restHeight, 0, 0);
        bodies[1]!.teleport(4, bodies[1]!.restHeight, 0, 0);
        const g = new WheeledGroup(bodies);
        const go = newWheeledIntent();
        go.throttle = 1;
        const intents: (WheeledIntent | null)[] = [null, null];
        let calls = 0, steps = 0;
        const after = (): void => {
          calls++;
          if (calls === 30) intents[0] = go;
        };
        if (frames) for (let k = 0; k < 45; k++) steps += g.advance(1 / 30, intents, after);
        else
          for (let k = 0; k < 90; k++) {
            g.step(intents);
            after();
            steps++;
          }
        const s0 = bodies[0]!.saveState(), s1 = bodies[1]!.saveState();
        const state = new Uint8Array(s0.length + s1.length);
        state.set(s0);
        state.set(s1, s0.length);
        return { state, calls, steps };
      };
      const a = run(true), b = run(false);
      let same = a.state.length === b.state.length;
      for (let i = 0; same && i < a.state.length; i++) same = a.state[i] === b.state[i];
      return verdict(same && a.calls === 90 && a.steps === 90, `hook called ${a.calls} times in ${a.steps} steps; by frames equal to by hand ${same}`);
    },
  },
];
