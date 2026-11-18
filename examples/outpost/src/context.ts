// The BuildContext every content module gets: the world seed, the layout, the ground height and named seeded streams.

import { Stream } from './kit/rng.ts';
import type { BuildContext } from './kit/types.ts';
import type { Layout } from './layout.ts';
import type { Terrain } from './terrain/height.ts';

export function buildContext(seed: number, layout: Layout, terrain: Terrain): BuildContext {
  return {
    seed,
    layout,
    heightAt: terrain.heightAt,
    rng: (name) => new Stream(seed, name),
  };
}
