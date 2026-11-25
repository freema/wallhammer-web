// The post steps of one figure after its gait has solved it: the gaze (trunk and head turned to a point, `ChainAim`)
// and the two arms (`TwoBoneReach`, the elbows turned toward the kind's poles), each with its own eased weight, and the
// transforms of the kind's sockets. The engine's order: the gait's `solve` (graph, solve, ground fit), then the gaze,
// then the reaches (a hand hangs off the turned trunk), then the sockets (they read the bones the reaches moved).
//
// Targets are points of the frame the figure is solved in. Nothing is allocated per frame.

import { ChainAim, TwoBoneReach, socketTransform } from 'wallhammer-web/motion';
import type { FigureGait } from './gait.ts';
import type { FigureArm, FigureKind } from './kind.ts';

/** The gaze and the arms of one figure. */
export class FigureActs {
  readonly kind: FigureKind;
  readonly gaze: ChainAim | null;
  readonly left: TwoBoneReach | null;
  readonly right: TwoBoneReach | null;
  private readonly poles: (readonly [FigureArm, TwoBoneReach])[] = [];

  constructor(kind: FigureKind) {
    this.kind = kind;
    this.gaze = kind.gaze ? new ChainAim(kind.gaze) : null;
    this.left = kind.arms ? new TwoBoneReach(kind.arms.left.chain, { soft: 0.94 }) : null;
    this.right = kind.arms ? new TwoBoneReach(kind.arms.right.chain, { soft: 0.94 }) : null;
    if (kind.arms) {
      this.poles.push([kind.arms.left, this.left!], [kind.arms.right, this.right!]);
      this.left!.usePole = true;
      this.right!.usePole = true;
    }
  }

  /** Advances the eased weights by `dt` seconds. */
  update(dt: number): void {
    this.gaze?.update(dt);
    this.left?.update(dt);
    this.right?.update(dt);
  }

  /** After `gait.solve(root, …)`: the gaze, then the reaches, on the gait's bones. */
  apply(gait: FigureGait, root: ArrayLike<number>): void {
    this.aim(gait, root);
    this.reach(gait, root);
  }

  /** The gaze alone (a caller that sets the arms' targets from the turned trunk calls `reach` next). */
  aim(gait: FigureGait, root: ArrayLike<number>): void {
    if (this.gaze) this.gaze.apply(this.kind.skeleton, gait.pose, root, gait.world);
  }

  /** The reaches alone, after `aim`. */
  reach(gait: FigureGait, root: ArrayLike<number>): void {
    const sk = this.kind.skeleton;
    for (const [arm, r] of this.poles) {
      if (r.weight <= 0) continue;
      const p = arm.pole;
      for (let i = 0; i < 3; i++) r.pole[i] = root[i]! * p[0] + root[3 + i]! * p[1] + root[6 + i]! * p[2] + root[9 + i]!;
      r.apply(sk, gait.pose, root, gait.world);
    }
  }

  /** The transform of the kind's socket `name` from the solved bones `world`, into `out` (12 numbers). */
  socket<T extends Float32Array | Float64Array>(world: ArrayLike<number>, name: string, out: T): T {
    const s = this.kind.sockets?.[name];
    if (!s) throw new Error(`figure ${this.kind.name}: no socket ${name}`);
    return socketTransform(world, s, out);
  }
}
