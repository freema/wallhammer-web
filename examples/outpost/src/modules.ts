// The content modules of the outpost, in build order. A module gets the shared BuildContext (layout, ground height,
// seeded streams; src/context.ts) and returns its Contribution (kit/types.ts); the scene draws whatever the modules
// return. Adding a structure: write a builder (structures/, props/), place it in a module from its site in layout.ts,
// list the module here.

import type { Simulation } from 'wallhammer-web/sim';
import type { OutpostModule } from './kit/types.ts';
import { lifeModule } from './life/life.ts';
import { maintenanceModule } from './maintenance.ts';
import { stationModule } from './station.ts';
import { terrainModule } from './terrain/ground.ts';
import type { Terrain } from './terrain/height.ts';
import { utilitiesModule } from './utilities.ts';

/** The modules; the moving ones (life/) register their movers and systems on `sim`. */
export function outpostModules(terrain: Terrain, sim: Simulation): OutpostModule[] {
  return [terrainModule(terrain), stationModule, maintenanceModule, utilitiesModule, lifeModule(sim)];
}
