# Lunar research outpost

A small research station on a grey moon, in a comic look: flat palette colours, three hard light steps, dark
outlines and long hard shadows from one low sun, a black sky and the home planet low over the horizon. A central
two-tier dome and three smaller domes are joined by corridors on legs. In front of the airlock one astronaut walks
between the stairs and the maintenance corner while the other stands and talks. A six-wheeled rover drives a slow
loop along its tyre tracks, and the dish on the roof re-aims now and then.

Everything is generated from code: no textures, no model files, no images. The concept art the scene follows is
reference only and is not shown. Every random choice comes from a named stream of the seed, so the same seed always
gives the same outpost.

The example uses only the engine core (`wallhammer-web`). Its look (materials), its builders and its moving things
all live in this folder. It deliberately does not use the engine's light model or the engine's rig layer (see
[How the look is made](#how-the-look-is-made) and [What moves](#what-moves)).

## Run

```sh
docker compose up -d     # from the repository root: http://localhost:5281/outpost/ (EXAMPLES_PORT)
```

Checks without a browser, in the dev container:

```sh
docker compose exec -T dev sh -c 'cd /app/examples/outpost && pnpm typecheck'
docker compose exec -T dev sh -c 'cd /app/examples/outpost && pnpm inspect'
```

`pnpm inspect` builds the scene in Node and prints the triangles per module and per piece. It then checks that:

- no part floats: every connected part of every solid piece and every part record reaches the ground or touches
  something that does (the engine's `meshParts` and `floatingParts` from `wallhammer-web/tools`);
- the corridor ends sit inside the shells they join, and no window meets a corridor or the airlock;
- the rover loop and the walking route keep clear of every structure;
- the motion is sound over 120 s of simulation: the walker reaches both ends of its route and keeps clear of the
  structures, the boots and the rover wheels stay on the ground, the rover drives its loop, and the walk cycle reports
  one footfall per step.

## Controls

| Input | Action |
| --- | --- |
| drag | orbit |
| wheel | zoom (6–180 m) |
| R or Home, button "Default view" | back to the default view |
| space | pause / resume the motion |

The pitch is limited to 4–86°. The orbit rig keeps the eye at least 1.5 m over the ground (its `groundAt` and
`minEyeHeight`), so the camera never goes under the terrain.

The address keeps the view: `#seed=1&yaw=0&pitch=18&dist=33&tx=3.5&ty=2&tz=0&p=0`.

| Parameter | Meaning |
| --- | --- |
| `seed` | World seed. |
| `yaw`, `pitch`, `dist`, `tx` `ty` `tz` | The view. |
| `p=1` | Start paused. |
| `pr` | Cap of the canvas pixel ratio (default 1.5; `pr=0` uses the device ratio). |
| `views=default,crew` | Limits the views that `__wh.presets()` lists. |

## Script interface (`window.__wh`)

| Member | Meaning |
| --- | --- |
| `kind` | `'orbit'`. |
| `ready` | A promise that resolves once the loading screen is gone. |
| `presets()` | Named views: `default`, `dome`, `maintenance`, `roof`, `pad`, `low`, `high`, `crew` (the astronauts) and `rover`. |
| `setView(v)`, `getView()`, `hash()`, `resetCamera()` | Set, read and reset the view. |
| `setPaused(on)` | Pause or resume the motion. |
| `setTick(n)`, `setTime(s)` | Pause and show the state at simulation tick `n` (30 per second) or at `s` seconds. The world is set up again from tick 0 and stepped, so the same tick always gives the same image. |
| `tick()` | The current simulation tick. |
| `settled()` | Resolves when the frame shows the current state. |
| `stats()` | Renderer statistics, the seed, the build time and the scene's triangles per module. |
| `inspect(filter)` | Triangles, vertices and size of every static mesh and part mesh. |
| `profile(frames)`, `profileText(frames)` | Per-layer GPU and CPU times. |

The screenshot tool runs on the host and takes all listed views at the given times (from the repository root):

```sh
cd tools/shot && node shot.mjs --url 'http://127.0.0.1:5281/outpost/#views=default,crew,rover' --size 1920x1080 --time 0,12
```

## How the look is made

All of the look is in `src/style/`. The engine supplies only the sun direction (a fixed light set from the layout) and
the shadow map with its `<shadow>` shader include.

- **Palette.** `palette.ts` is the only place with colour values: grey ground, warm off-white shells, orange trim,
  teal glass, dark metal and rubber, and the planet. Each colour is a display (sRGB) value and appears on the screen
  as written.
- **Three hard light steps.** The toon material multiplies the palette colour by one of three steps:
  - lit,
  - a mid step on the grazing band of curved shells,
  - shadow, with a slightly cool cast, for faces turned away from the sun and for cast shadows.

  The cast shadow is a hard `step` at one half over `sunVisibility` of the engine's `<shadow>` include. Step edges are antialiased over one pixel; nothing
  else is smooth. There is no fog, haze, bloom, noise or specular light.
- **Outlines.** Every vertex of an outlined triangle carries a hull direction, a welded normal; other vertices carry
  zero. The same mesh is drawn a second time with the outline material: the vertices pushed out along that direction
  and front faces culled (`cull: 'front'`), so only a dark rim around the silhouette shows; triangles without a hull
  collapse to nothing. Its width is a fixed number of pixels (2.1 px at 1080 lines), computed from
  the depth with the engine's `metresPerPixelAt`. Far away it thins to half, so small distant rocks do not turn into
  ink blots.
- **Panel lines.** Each vertex carries panel coordinates. The toon pass draws a thin dark line wherever one of them
  crosses an integer. The shapes in `src/kit/shapes.ts` set these coordinates for box edges, dome ribs and rings,
  cylinder rims, window panes and solar cells.
- **Tone patches.** Regolith patches and crater floors use a tone value that is interpolated across the triangle and
  cut at two levels. This gives them crisp, smooth edges even on a coarse ground mesh.
- **Sky and planet.** The sky is the black background; the engine's sky is off. The planet is drawn first, on one
  triangle that covers the screen. Each pixel's ray is tested against a disc fixed in the sky. Its continents and
  oceans are flat colours from a noise function, with a crescent of shadow and an outline.

## What moves

The motion runs in the engine's fixed-step `Simulation` at 30 ticks per second. It does not depend on the frame rate
and pauses with the space bar.

| Thing | Engine system | Written in the example |
| --- | --- | --- |
| Rover | `Movers` on a looping `PathSet` path gives the distance along the loop, the speed and a dwell at one stop. | Ground following in `life/rover.ts`: each wheel stands on the ground under it, the body pitches and rolls to the wheels, the swing arms reach from the body to each hub, the wheels turn by the distance driven and the sensor head scans. |
| Walking astronaut | `Walker` over a `CollisionWorld`, stepped once per simulation tick. The solids are the dome, the airlock, the stairs with their handrails, the bench, the crates, the floodlight and the cable reel, so the walker slides along them and never passes through. | Steering along the route with a dwell at each end (`life/life.ts`); the walker's state is part of the simulation's state. The skeleton and the motion graph come from the engine's `motion`; the walk cycle and the idle stance are motion sources in `life/astronaut.ts`. |
| Standing astronaut | none | An idle clip: breathing, a weight shift, the head looking round, and a hand held out every eleven seconds. |
| Dish | none | A fixed cycle of headings, each held and then turned to the next (`station.ts`). |

Moving things are the engine's instance sets (`instanceSet`, `writeInstance`): records of one mesh each, drawn by
`InstanceSetLayer` with the
example's own toon and outline materials. That layer is a dynamic shadow caster, so the rover, the astronauts and
the dish cast shadows that move with them.

The engine's `RigLayer` is not used. It poses the parts in its own shader with its own material, and its rigs do not
cast into the shadow map. This look needs its own material, outlines and cast shadows.

An astronaut is ten bone records. The bones are the body, the helmet, two upper arms, two forearms, two thighs and
two shins, a `Skeleton` of the engine's `motion`. The walk cycle and the idle stance are motion sources: functions
from a phase or a time to joint turns. A `MotionGraph` puts the walk over the idle stance with a weight by the speed,
drives the walk's phase by the distance walked and reports the footfalls as marks; `solvePose` and `BoneInstances`
turn the pose into records. The rover and the dish stay plain code: a wheel stands on the ground under it and an arm
reaches between two points, which a skeleton of fixed joints does not express.

## Layout of the code

| Path | Contents |
| --- | --- |
| `src/main.ts` | Engine, camera, HUD, keys, `__wh`. |
| `src/layout.ts` | Where everything stands, the rover loop, the walking route; the shared ground truth. |
| `src/modules.ts` | The content modules in build order. |
| `src/kit/` | Mesh builder (vertex format with hull and panel lines), shapes (styled over the engine's bare shapes), transforms, seeded streams. |
| `src/style/` | Palette and materials. |
| `src/terrain/`, `src/sky/` | Ground, craters, rocks, tracks and far ridges; the planet. |
| `src/structures/`, `src/props/`, `src/station.ts`, `src/maintenance.ts`, `src/utilities.ts` | Builders and their placement. |
| `src/life/` | Rover, astronauts and their motion. |
| `src/render/scene.ts` | Turns the modules' contributions into engine layers. |
| `scripts/inspect.ts` | The checks without a browser. |
