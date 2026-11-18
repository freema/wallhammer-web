// The village's collision world for the walk mode: the solids every content module hands over
// (`Contribution.solids`, kit/solids.ts) on top of the terrain. Pure, no DOM: the page (src/walk/mode.ts) and the
// headless check (scripts/collisions.ts) build the same world from the same modules, and walk it the same way
// (`driveTo` below, fixed walker steps).

import { CollisionWorld, newWalkIntent } from 'wallhammer-web/world';
import type { WalkIntent, Walker } from 'wallhammer-web/world';
import type { Contribution } from '../kit/index.ts';

/** Edge of the terrain the collision world searches the ground in, metres (the detailed core, ground.ts). */
const EXTENT_M = 112;

export interface WalkWorld {
  world: CollisionWorld;
  /** Label of each solid by its tag (`world.forEachSolid` → `info.tag`). */
  labels: string[];
  /** Solids per label, for the HUD and the check. */
  counts: Record<string, number>;
  /** Build time, ms. */
  ms: number;
}

/**
 * Builds the collision world from the modules' contributions over the terrain `heightAt`. A ray searches the ground
 * only inside the terrain core and between the given heights, so a camera boom ray costs microseconds.
 */
export function buildWalkWorld(contributions: readonly { name: string; c: Contribution }[], heightAt: (x: number, z: number) => number, minY: number, maxY: number): WalkWorld {
  const t0 = performance.now();
  const world = new CollisionWorld({ heightAt, cellSize: 6, baseMinY: minY, baseMaxY: maxY, baseExtent: [-EXTENT_M, -EXTENT_M, EXTENT_M, EXTENT_M] });
  const labels: string[] = [];
  const tagOf = new Map<string, number>();
  const counts: Record<string, number> = {};
  for (const { c } of contributions) {
    for (const s of c.solids ?? []) {
      let tag = tagOf.get(s.label);
      if (tag === undefined) {
        tag = labels.length;
        labels.push(s.label);
        tagOf.set(s.label, tag);
      }
      const o = { standable: s.standable ?? true, blocksSight: s.blocksSight ?? true, tag };
      if (s.shape === 'cylinder') world.addCylinder(s.x, s.z, s.radius, s.minY, s.maxY, o);
      else world.addPrism(s.outline, s.minY, s.maxY, o);
      counts[s.label] = (counts[s.label] ?? 0) + 1;
    }
  }
  return { world, labels, counts, ms: performance.now() - t0 };
}

/** What a page or a check reads back about the walking figure. */
export interface WalkState {
  x: number;
  y: number;
  z: number;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Heading in the engine's convention (0 faces −z), degrees. */
  yawDeg: number;
  grounded: boolean;
  steep: boolean;
  /** Fixed steps since the last teleport. */
  steps: number;
}

export function walkState(w: Walker): WalkState {
  const p = w.position;
  const v = w.velocity;
  return { x: p[0]!, y: p[1]!, z: p[2]!, speed: Math.sqrt(v[0]! * v[0]! + v[2]! * v[2]!), yawDeg: (w.yaw * 180) / Math.PI, grounded: w.grounded, steep: w.steep, steps: w.steps };
}

const scratch: WalkIntent = newWalkIntent();

/**
 * Walks `walker` toward (x, z) for `seconds` of fixed steps, the way a player holds a direction (it keeps pushing when
 * blocked). `each` sees the walker after every step. Returns the state at the end. `run` runs, `within` stops asking
 * for movement that close to the goal (default 0.05 m).
 */
export function driveTo(walker: Walker, x: number, z: number, seconds: number, o: { run?: boolean; within?: number } = {}, each?: (w: Walker) => void): WalkState {
  const n = Math.max(0, Math.round(seconds * walker.setup.stepHz));
  const within = o.within ?? 0.05;
  const it = scratch;
  it.run = o.run ?? false;
  it.jump = false;
  for (let i = 0; i < n; i++) {
    const p = walker.position;
    const dx = x - p[0]!, dz = z - p[2]!;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= within) {
      it.moveX = 0;
      it.moveZ = 0;
    } else {
      const k = Math.min(1, d / 0.5) / d;
      it.moveX = dx * k;
      it.moveZ = dz * k;
    }
    walker.step(it);
    each?.(walker);
  }
  return walkState(walker);
}
