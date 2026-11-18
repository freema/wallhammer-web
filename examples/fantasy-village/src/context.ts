// The build context every content module receives (kit/types.ts BuildContext).

import { Simulation } from 'wallhammer-web/sim';
import type { BuildContext } from './kit/types.ts';
import { Stream } from './kit/rng.ts';
import type { VillageLayout } from './layout.ts';
import type { HeightField } from './terrain/height.ts';

/** Ticks per second of the village simulation (villagers). */
export const SIM_HZ = 10;

export function createBuildContext(seed: number, layout: VillageLayout, field: HeightField, sim?: Simulation): BuildContext {
  return {
    seed,
    layout,
    heightAt: field.heightAt,
    field,
    stream: (name) => Stream.of(seed, name),
    sim: sim ?? new Simulation({ seed: `village-${seed}`, hz: SIM_HZ }),
  };
}
