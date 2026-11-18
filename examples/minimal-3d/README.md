# Minimal 3D example

A small island with a ring of standing stones, boulders and a ring sculpture, seen through a perspective orbit
camera and lit by the sun of a chosen day and hour. Robed figures live among the stones through the engine's
fixed-step simulation (`wallhammer-web/sim`): a procession walks half the ring and across past the sculpture, keeping
its distance and queueing while each figure stops at the sculpture; wanderers walk A* routes from stone to stone and
linger at each. On a track round the ring a two-part cart with a hitched trailer and a few porters move as rigs
of the engine's instanced rig layer (`RigLayer` in `wallhammer-web/render`): rigid parts posed in the vertex shader by
closed-form motions (wheel spin and steering, leg and arm swing, bob and sway), one draw call per kind, a cheaper far
mesh by screen size and a contact shadow. The cart stops at the gap and the porters queue behind it. The rigs are
defined locally in `src/rigs.ts`, not taken from a content module. The engine's sky (`createEngine({ sky })`) stands behind it: sun, moon, stars and the same clouds whose
shadows cross the island; the sea mirrors it and fades into it at the horizon. Everything is built from code: no image assets and no libraries besides `wallhammer-web`. The same
seed, tick, hour and view always give the same image.

The example proves that the engine has no built-in assumption about cities or orthographic views. It imports only
`wallhammer-web`, without the content modules `gen-arch`, `gen-ground` and `gen-vegetation` (`pnpm check:layers`
enforces that).

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://localhost:5281/minimal-3d/>. Another port: `EXAMPLES_PORT=5291 docker compose up -d`.

- Drag to orbit, use the wheel to zoom.
- `[` and `]` move the hour by half an hour, space runs the day.
- `P` pauses the figures, `.` steps one tick, `-` and `=` halve and double their speed, `C` calls the wanderers to the gap in the ring.
- URL hash: `#seed=7&tick=900&hour=18.5&day=250&yaw=35&pitch=24&dist=105&w=rain` (`w` is `clear`, `clouds`, `rain`, `snow` or `fog`; `tick` freezes the simulation at that tick).

Screenshots (on the host, against the running container):

```sh
cd tools/shot
node shot.mjs --url http://127.0.0.1:5281/minimal-3d/ --tod 13,20.5 --tick 300,900 --format jpeg
node shot.mjs --url http://127.0.0.1:5281/minimal-3d/ --tod 15 --tick 1700,1900,2000 --format jpeg   # includes the track views
```

Besides the two orbit views the shot run takes `track` and `track-b`, two close views of the track at the gap where
the cart halts.

## Files

| File | Contents |
| --- | --- |
| `src/scene.ts` | The scene as pure data from the seed: height field, slab, boulder, ring and sea meshes, stone instances. |
| `src/shaders.ts` | Three materials as `MaterialDesc`: ground, instanced stones (with their own shadow vertex shader) and plain solids (polished stone, or water that mirrors the sky). All end with `aerialPerspective`. |
| `src/glow.ts` | An environment slot (`u_glow`): the stone tops glow after dusk. |
| `src/life.ts` | The simulation: navigation graph among the stones, the procession, the wanderers, the `wander` system and the `call` command; the `track` movers (two loop paths round the ring, a stop at the gap, the cart and porters). |
| `src/figures.ts` | The figures as an image: instanced robed shapes with lanterns and contact shadows, filled from `Movers.extract`. |
| `src/rigs.ts` | Two local rigs as `RigDesc` (a cart of two segments with steered wheels, and a porter with swinging limbs and a staff) and `TrackRigs`, which writes their instances from `Movers.extractPose` each frame and places the trailer behind the hitch. |
| `src/main.ts` | Wiring through `createEngine`: scene layers, figures, keys and the `window.__wh` script interface (`setTick` included). |
