// The registry of content modules: everything in the village comes from one of these. Each is built once at start
// (`build(ctx)`), its contribution goes to the scene assembly (src/render/scene.ts), its `update` runs every frame.
// Add a new module here; the order does not matter for drawing (statics are merged by material and place).

import type { ContentModule } from './kit/types.ts';
import { ground } from './terrain/ground.ts';
import { water } from './terrain/water.ts';
import { paving } from './terrain/paving.ts';
import { bridge } from './terrain/bridge.ts';
import { weir } from './terrain/weir.ts';
import { rocks } from './terrain/rocks.ts';
import { inn } from './buildings/inn.ts';
import { cottages } from './buildings/cottages.ts';
import { forge } from './buildings/forge.ts';
import { mill } from './buildings/mill.ts';
import { windmill } from './buildings/windmill.ts';
import { castle } from './buildings/castle.ts';
import { vegetation } from './vegetation/index.ts';
import { props } from './props/index.ts';
import { villagers } from './villagers/index.ts';
import { fx } from './fx/index.ts';

export const MODULES: readonly ContentModule[] = [
  ground, water, paving, bridge, weir, rocks,
  inn, cottages, forge, mill, windmill, castle,
  vegetation, props, villagers, fx,
];
