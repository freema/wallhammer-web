# Walking test course

A test course of about 120 × 120 m on rolling ground from a seed, for the engine's collision world
(`CollisionWorld`), walker (`Walker`) and follow camera (`FollowRig`, `bindWalkInput`). Nine pads, each trying one
ability of the walker; the HUD names the pad under the feet:

| Pad | Where (x, z) | What it tries |
| --- | --- | --- |
| Start | 60, 60 | flat ground, the place `R` returns to |
| Walls and a corner | 20, 20 | an L-shaped corner to rest in, a long wall to slide along |
| Pillars | 60, 20 | a row of cylinders with gaps 1.2, 1.0, 0.8, 0.7, 0.6 and 0.5 m (the body is 0.6 m wide) |
| Steps | 100, 20 | stairs of 0.2 m steps, one 0.3 m step (walks up), one 0.5 m step (stops) |
| Ramps | 100, 60 | ramps of 20°, 35° (both climbable) and 55° (slides back) onto a 3 m plateau |
| Platforms | 100, 100 | platforms at 0.6 and 1.0 m with gaps of 1, 1.5, 2 and 2.5 m to jump (running) |
| Passages | 60, 100 | a passage with a 1.5 m ceiling (too low) and one with a 2 m ceiling |
| Thin wall | 20, 100 | a wall 10 cm thick to run into |
| Footbridge | 20, 60 | a plank over a 3 m pit, a ramp out of the pit |

Everything is drawn from the collision world itself (`src/meshes.ts`), so what is seen is what stops the body. The
figure is eleven boxes in the engine's instance set (`InstanceSetLayer`) and casts a moving shadow. On the ground the
legs and arms swing with the distance walked. A jump keeps the speed and heading of take-off until landing (the
engine's `Walker` defaults; the view still turns), and the pose follows the vertical speed (`src/pose.ts`). It goes
from the push-off through the knees drawn up while rising to the legs reaching down before landing. Running, the lead
knee goes up first; standing, both legs move together. A squat as deep as the impact follows on landing and is gone
within half a second. There is no stride in the air. The example imports only `wallhammer-web` (`pnpm check:layers`
enforces that).

The course is pure data (`src/course.ts`) and the scripted walk is pure too (`src/drive.ts`): `pnpm check:walk` walks
every pad headless the same way the page's `__wh.walkTo` does, and the figure's poses through a jump
(`tools/walk/course-scenarios.ts`).

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://localhost:5281/walk/>. Another port: `EXAMPLES_PORT=5291 docker compose up -d`.

- `W A S D` or the arrows walk, `Shift` runs, space jumps; drag to turn the view, the wheel moves the camera in and out.
  A gamepad works too.
- `F` first person and back, `C` the wireframe of the collision solids (yellow standable, red blocking, violet the
  invisible edge of the course), `R` back to the start.
- `N` switches the mark mode (dev server only, not in the live demo): a click pins a note to the course, picked against
  the collision world (`collisionPick`), kept in `internal/marks/` by the dev server's store; one call to the engine's
  `installEngineMarking` in `src/main.ts` (Marks in the engine's docs). Opening a mark's view puts the walker back on
  its spot and the camera exactly where it was; the figure's heading comes from the page's own hash (`yaw`, to 0.1°).
  `marks=1` turns the marks on in a page driven by a script, `marks=0` hides the pins.
- URL hash: `#seed=7&x=60&z=60&yaw=0&fp=0&c=0&lock=0&pr=1.5`. `fp=1` first person, `c=1` the wireframe, `lock=1` a click
  locks the pointer, `pr` caps the canvas pixel ratio (default 1.5, `0` the device's own).

## Script interface

`window.__wh` after `await __wh.ready`:

| Member | Meaning |
| --- | --- |
| `state()` | Position, velocity, horizontal speed, heading, `grounded`, `steep`, the pad under the feet. |
| `walkTo(x, z, seconds, { run?, jump?, within? })` | Holds a direction toward the point for that many seconds of fixed steps (synchronously), then draws; `jump` jumps by itself at edges and ledges. Returns the state. |
| `hold({ forward?, right?, run?, jump? }, seconds)` | Holds that input (relative to the view, each −1 to 1; `jump` in the first step only) for that many seconds of fixed steps, then draws. Returns the state. |
| `freeze(on)` | Stops the page's own stepping and the keyboard, so `hold` alone moves the figure (for pictures of a pose). |
| `teleport(x, y?, z, yawDeg?)` | Puts the feet there (`y` omitted or `NaN`: on the ground). |
| `setView({ at?, yawDeg?, pitchDeg?, distance? })`, `getView()`, `presets()` | The view; `at: [x, z, yawDeg?]` puts the figure there first. One preset per pad. |
| `stats()`, `profile(frames?)`, `profileText(frames?)` | Draw statistics and measured frame times; the engine's frame profile while the figure walks in a circle. |
| `hud()`, `hash()`, `settled()`, `stations()`, `setWire(on)` | For the screenshot tool and scripts. |

Screenshots: `docker compose run --rm shot --url http://dev:5281/walk/ --presets start,pillars`. Frame times from a
container's software renderer say nothing about a real graphics card; measure in Chrome with `__wh.profileText()`.
