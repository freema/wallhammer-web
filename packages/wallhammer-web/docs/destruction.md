# Destruction

Destruction has three parts in three places:

| Part | Where | What |
| --- | --- | --- |
| Data types | `wallhammer-web/base` (`destructible.ts`) | `StructureDesc`, `StructureState`, `DAMAGE`, `PART_FLAG`, `PART_ROLE`, damage entries. |
| The model | `wallhammer-web/sim/destruction` | Pure functions: what an event breaks, what loses support, where rubble lies, the hashable state. |
| The look | `wallhammer-web/gen-arch` and `wallhammer-web/render` | Damaged meshes, rubble meshes, falling pieces (`fallPieces`) drawn by `TransientLayer`. |

The model runs in Node. It has no clock and no GPU.

## Descriptions

A `StructureDesc` describes one structure as convex parts and bonds. All lengths are integer **centimetres**.

- `parts` (sorted by `key`): `role` (`PART_ROLE`: foundation, bearing, span, attached, fixture), `material` (index into `materials`), `mass` in kg, `piece` (a vertical prism over a convex polygon: `xz` corners counter-clockwise, `y0`, `y1`), `flags` (`PART_FLAG.anchor`, `indestructible`, `inner`), `maxSpan`.
- `bonds` (sorted by `a`, then `b`): `bearing` true when `b` rests on `a`; false for a lateral tie. Centre and area of the shared face.
- `materials`: `crack`, `breach`, `gone` energy thresholds and `density`.
- `keepOut`: events never change the structure.

Part keys must come from the input (a rule id and the part's path in the recipe), never from emission order. `gen-arch` builds descriptions with `buildBuildingMesh(..., { describe: true })` and stable keys (`PART_RULE`, `bayKey`, `slabKey`, …).

You can also write a description by hand. [Recipes](recipes.md#add-a-destructible-structure) shows a two-part structure.

## Events and results

<!-- check: wrap -->
```ts
import type { StructureDesc, StructureState } from 'wallhammer-web/base';
import { applyEventToAll, compileStructure, destructionEvent, encodeStates, stateHash } from 'wallhammer-web/sim/destruction';
declare const descs: StructureDesc[];

const compiled = descs.map((d) => compileStructure(d)); // cached per description
let states = new Map<number, StructureState>();
const ev = destructionEvent({ position: [12, 4, 30], radius: 3, energy: 900, seed: 77, tick: 1 });
const res = applyEventToAll(compiled, states, ev);
states = res.states;
// res.changes: parts that changed rung; res.rubble: new rubble footprints; res.timeline: when each change lets go
const saved = encodeStates(states.values()); // URL-safe text
const hash = stateHash([...states.values()]);
```

`destructionEvent` converts metres to integer centimetres. `applyEvent` works on one structure:

1. Hit test: parts whose piece lies within the radius, in key order.
2. Damage: energy × (r² − d²) / r² against the part's thresholds, each jittered ±20 % by the event seed. A part hit again moves at least one rung.
3. Support: connectivity from the anchors. A part with no supported path falls (gone).
4. Rubble: each newly gone part gets a footprint.
5. Budget: a structure with more than `maxEntries` (default 600) damaged parts becomes a ruin.
6. Timeline: per change, ticks after the event (`TIMELINE_TICK_S` = 0.05 s) at which the part lets go.

The state is committed at once. The timeline is presentation only: a state saved mid-collapse loads as the final state.

Other helpers: `intactState`, `isIntact`, `decodeStates`, `sortedEntries`, `solveSupport`, `rubbleFootprints`, `partRubble`, `ruinRubble`, `raycastParts` (pick a part with a ray).

## Feeding events from the simulation

The module header says that feeding events from the simulation queue is "a later step". Nothing in the engine does it. There are two ways to do it:

- The destruction example (`examples/destruction`) calls `applyEventToAll` directly from input handlers.
- An app with a simulation registers simulation commands for hit, set and reset and calls the pure functions from those handlers. That gives replay and seeking for free.

If you add destruction to a project with a simulation, take the second pattern: one command per event, the state as simulation state.

## State in streamed cells

In a streamed world a cell is built again whenever it comes back, so damage cannot live in the cell. `CellStates` keeps it apart: the changed structure states of the whole world, keyed by the home cell of each structure (the one cell that owns it; the content decides at which level) and the structure's id.

- `commit(home, states)` replaces the states of a home cell. Intact states are dropped, a ruin keeps no entries. `of(home)` reads them back.
- `text(under?)` is the canonical URL-safe text of the store, or of the home cells at or under one cell. Hand it to the generator of a cell as its edits (see [Edits and refresh](streaming.md#edits-and-refresh)), so the cell is built with the damage. `decodeCellStates(text)` reads it back; malformed, repeated or refused cells are skipped and reported in `errors`.
- `hash()` is a 64-bit hash of the store. Text and hash depend only on the content, never on the order of the commits or of a map.
- Ceiling: `units` (1 per changed structure plus its part entries, 1 per ruin) stays at most `maxUnits` (default `DEFAULT_MAX_UNITS` = 20,000). Over it, the structure with the most entries becomes a ruin (ties: the earlier cell, then the lower id); `commit` returns which ones in `ruined`. A commit that would leave more changed structures than `maxUnits` is refused (`accepted: false`) and changes nothing. The rule reads only the store, never what is loaded or where a viewer is, so the same events give the same store. The text is at most `CELL_STATES_CHARS_PER_UNIT` (40) characters per unit.

<!-- check: wrap -->
```ts
import type { CellId } from 'wallhammer-web/gen-core';
import type { DestructionEvent, StructureDesc } from 'wallhammer-web/base';
import { CellStates, applyEventToAll, decodeCellStates } from 'wallhammer-web/sim/destruction';

declare const home: CellId;
declare const structures: StructureDesc[]; // the structures this home cell owns, from the generator
declare const ev: DestructionEvent;
const store = new CellStates({ maxUnits: 2000 });
const r = applyEventToAll(structures, store.of(home), ev);
const { accepted, ruined } = store.commit(home, r.states); // then refresh the cells that draw `home` and `ruined`
const saved = store.text(); // survives a reload, e.g. in the URL
const { store: loaded, errors } = decodeCellStates(saved, { maxUnits: 2000 });
```

The endless example (`dmg=1`) wires it: structures in home cells of level 9, drawn by the cells of levels 7–9 over them, hits by click, the state in the URL. Its golden recipe ("endless example damage") checks that the cells come back as the same bytes after leaving and after a reload.

## Drawing damage

- `buildBuildingMesh(specs, props, groundAt, dims, { states })` draws structures in a damage state: cracked parts through the damage shader, breached walls as holes with reveals, gone parts as cut faces, a ruin as stubs.
- `structureMaterial(dims, { damage: true })` is the damage program. Intact structures can keep the plain material.
- `buildRubbleMesh(footprints, rubbleColours(specs), groundAt, arrival?)` draws rubble. `arrival` lets heaps grow in when pieces land.
- `fallPieces({ desc, state, before, changes, event, at, groundAt, budget })` cuts the gone parts out of the structure as it stood before the event. Each piece gets a closed-form track. Draw the batch with `fallingMaterial` in a `TransientLayer` (`maxPieces` default 320). Over budget, pieces turn into dust.
- `retimeFall(out, dt)` moves a prepared batch `dt` seconds later on the clock: tracks in the vertices, puffs, rubble arrivals, start and end. Use it when the batch is made some time before it is shown.

`examples/destruction/src/main.ts` wires all of this.

### How the pieces look and move

- Solid pieces (masonry, floors, partitions) get a closed shell just inside their outline. Faces narrower than 0.8 m (a broken edge, the thickness of a slab or a wall) show the dark broken core (damage 3). Broad faces show what the part had inside, in the interior shading (`KIND.interior`): a slab has its floor on top and its ceiling below, a partition and the back of a wall have room paint. The room hash comes from the part key, so all pieces of one slab match. A broad face covers only what the piece's own surface parallel to it covers, so an opening through the part (a torn hole in a wall, a door in a partition, a stair hole in a slab) stays open in the flying piece, lined by its own reveals.
- Patterns stay on a moving piece. `BUILDING_VS` passes the rest position and rest normal (`v_pat`, `v_patN`); `fallingMaterial` sets them from the vertex before its track moves it. The damage pattern, the roof noise and the door heights read them. For a static mesh they equal the world position, so intact structures draw the same as before.
- Fallen roof reads as roof. Rubble of a roof span is a dust mound in the wall colour with three to five roof sections on it: a core slab with the roof covering on top (`KIND.roofPitched`, courses along its tilt). Floor spans get concrete sections in the trim colour.
- Tracks stay out of standing parts, without collision state. A piece that lost its support leans away from the structure's centre (0.35–1.05 m/s) and lets go within 0.14 s of its timeline time. Before a track is kept, its landing spot and the middle of its flight are tested against standing parts (grid lookup, point in footprint). When one lies inside, the horizontal velocity is tried at 0.6, 0.3, −0.4 and 0 of its value. The landing height follows the spot: the highest standing top under it, else the ground. Every landing still makes a dust puff.

### Keeping a hit cheap

A hit on a large structure, done in one task, can block the main thread for well over 100 ms: describe the structure, apply the event, draw the before mesh by parts, cut the pieces, regenerate the damaged mesh. An app with large structures can split it this way (the pattern comes from an app outside this repository; the engine's part of it is the caches of `buildBuildingMesh`, `retimeFall` and the pure functions):

- Descriptions are made in idle time after the buildings are set, largest footprint first, a few per idle slot (`requestIdleCallback`, at most ~8 ms of work per slot unless one structure takes longer). A hit before that finishes describes on the spot.
- `buildBuildingMesh` keeps the footprint index of a spec array (`WeakMap`, checked against every ring), and the cut roof cells of a spec (checked against its box, grid and roof triangles).
- The hit commits the state at once (`destroy()` returns the new state), then queues the rest, one job per task: the before mesh by parts (reused from the last drawn mesh when its state hash matches), `fallPieces`, the new damaged mesh. A last task moves the prepared falls to the current clock time with `retimeFall`, uploads everything and shows it. The picture changes about 0.1 s after the hit.
- A promise for scripts resolves when the picture is shown, and anything that needs the final state (such as `collapseAt`) flushes the queue first.

## Known weaknesses

- A hit on a large structure is not cheap by itself. `fallPieces` is the longest single step, and describing the structure on the spot adds to it; an app keeps its tasks short only by splitting the hit as in [Keeping a hit cheap](#keeping-a-hit-cheap).
- Pieces can still pass through each other: there is no piece-to-piece test, only the lean away from the centre and the stagger. A large roof section can sweep through wall pieces as it tilts.
- A piece is tested against standing parts at two points of its flight only. A fast piece can clip a corner between them.
- The look of the pieces was judged mostly on the destruction example (`examples/destruction`), at its zooms.
- Interiors are generic: the same division on every storey, empty rooms, dark by day.
