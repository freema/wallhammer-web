// The walking figure of the walk mode: one person built like the villagers (looks.ts `makePlayer`) and posed by the
// same motion graph and parts writer as they are (villagers/figure.ts), from the walker every frame. Its four part
// sets are its own (not in the 'villagers' group, so V does not hide it) and are added to the scene only when the walk
// mode first starts.

import { Stream, createPartSet } from '../kit/index.ts';
import type { PartSet } from '../kit/index.ts';
import { FigureParts, HumanFigure } from '../villagers/figure.ts';
import { makePlayer } from '../villagers/looks.ts';
import type { Person } from '../villagers/looks.ts';
import { ACT, HOLD, poseIn } from '../villagers/rig.ts';
import { blobMesh, blockMesh, headMesh, segmentMesh } from '../villagers/shapes.ts';

const TAU = Math.PI * 2;

export class PlayerFigure {
  readonly person: Person;
  readonly sets: PartSet[];
  private readonly figure: HumanFigure;
  private readonly stride: number;
  private gait = 0;
  private lastTravelled = Number.NaN;
  private hidden = false;

  constructor(seed: number) {
    const p = makePlayer(Stream.of(seed, 'walk-player'));
    this.person = p;
    const counts = [0, 0, 0, 0];
    for (const q of p.parts) counts[q.set]!++;
    const meshes = [headMesh(), blobMesh(), segmentMesh(), blockMesh()];
    const names = ['walker-heads', 'walker-blobs', 'walker-limbs', 'walker-blocks'];
    this.sets = meshes.map((m, k) => createPartSet(names[k]!, m, Math.max(1, counts[k]!), { dynamic: true, castShadow: true }));
    for (let k = 0; k < 4; k++) this.sets[k]!.count = counts[k]!;
    const parts = new FigureParts(p.parts, this.sets, [0, 0, 0, 0]);
    const s = poseIn();
    s.energy = p.energy;
    s.holdL = HOLD.none;
    s.holdR = HOLD.none;
    s.listen = p.listen;
    s.armOut = p.body.armOut;
    s.cycle = p.cycle;
    s.ph = 0.37;
    this.figure = new HumanFigure(p, parts, s);
    this.stride = (p.body.thigh + p.body.shin) * 1.55;
  }

  /** Shows or hides the whole figure (first person, walk mode off). */
  setVisible(on: boolean): void {
    for (const s of this.sets) {
      if (s.visible !== on) (s.visible = on), (s.dirty = true);
    }
    this.hidden = !on;
  }

  /**
   * Poses the figure: feet at (x, y, z), heading `yaw` in the engine's convention (0 faces −z), horizontal speed
   * `speed`, `travelled` the walker's distance so far (drives the stride), `t` seconds of the clock, `airborne` while
   * jumping or falling.
   */
  pose(x: number, y: number, z: number, yaw: number, speed: number, travelled: number, run: boolean, airborne: boolean, t: number): void {
    if (this.hidden) return;
    const p = this.person;
    const act = speed < 0.08 && !airborne ? ACT.stand : run && speed > 2.2 ? ACT.run : ACT.walk;
    // The stride follows the ground actually covered (a figure pushing against a wall does not walk on the spot).
    const step = Number.isFinite(this.lastTravelled) ? Math.max(0, travelled - this.lastTravelled) : 0;
    this.lastTravelled = travelled;
    if (!airborne) this.gait = (this.gait + (step / (act === ACT.run ? this.stride * 1.7 : this.stride)) * TAU) % (TAU * 1000);
    const s = this.figure.input;
    s.t = t;
    s.walk = Math.min(1, speed / (p.speed * 0.85));
    s.run = act === ACT.run ? Math.min(1, Math.max(0, (speed - 1.2) / 0.8)) : 0;
    s.gait = this.gait;
    s.lookYaw = 0;
    s.lookPitch = 0;
    s.speak = 0;
    // The village turns a figure by its own yaw (0 faces +z): half a turn from the engine's.
    this.figure.pose(x, y, z, yaw + Math.PI, act, 0, t, 0);
  }
}
