# Destruction example

Five structures from the structure generator (`wallhammer-web/gen-arch`) on a plain: a flat-roofed block with balconies
and an entrance canopy, two gable houses with chimneys, a hip-roofed house and an L-shaped block. A click sends a
destruction event into the destruction model (`wallhammer-web/sim/destruction`): integers only, so the same events
always give the same state. The state is the only truth. A structure whose state changed is regenerated from its
recipe, its seed and that state, and uploaded again; nothing else is touched. Gone parts leave rubble, drawn from the
footprints the model decided at the moment of the event.

Damage has four rungs per part: intact, cracked (drawn by the damage shader), breached (a torn hole with reveals, walls
only) and gone (cut faces, rubble). A part that loses its support falls in the same event. Ground and foundations
never break. Thrown chunks are cosmetic: seeded from the event, never saved, never read by the model.

A collapse is presented over a second or two, while the state is final at once. The parts the event took away come
down as pieces in the order of the event's timeline (blown parts fly out from the centre, unsupported ones let go
storey by storey and tilt as they drop), crumble and raise dust where they land, and their rubble grows in from the
ground. The pieces are cut out of the structure as it stood, so a falling wall bay keeps its windows and a roof section
its covering; until a piece's time it stands where it stood. Events at one clock time (a scripted scenario) are
presented as one. All of it is a function of the engine clock, so pausing or setting the clock, also back, shows the
same frame. The text shows the pieces in flight and how many went over the budget (drawn only as dust).

Every structure has an interior: floor slabs, partitions with doors, a stair core with dog-leg flights, and rooms along
the outer walls (the flat block has a central corridor). It is drawn only where damage opens a view into it, and its
slabs, partitions and stairs are parts of their own: a slab whose supports are gone falls, and takes what stands on it.
At night a room glows when its window is lit.

The example imports the engine and the content packages, never an app (`pnpm check:layers` enforces that).

## Run

```sh
docker compose up -d     # from the repository root: one service serves every example
```

Then open <http://localhost:5281/destruction/>. Another port: `EXAMPLES_PORT=5291 docker compose up -d`.

- Click: an event at the point under the cursor (the first part the ray meets, else the ground). Drag orbits, the wheel zooms.
- `[` and `]` change the radius, `-` and `=` the energy. `Z` takes back the last event, `R` resets everything.
- `D` turns thrown chunks on or off, `H` hides the text, space runs the day.
- `N` switches the mark mode (dev server only, not in the live demo): while it is on, a click pins a note instead of
  blasting, picked like the blast (the standing parts, else the ground; rubble, debris and falling pieces are not in
  it), kept in `internal/marks/` by the dev server's store; one call to the engine's `installEngineMarking` in
  `src/main.ts` (Marks in the engine's docs). The drag and the wheel do not orbit while it is on; `N` or Escape leaves
  it. A mark's hash is the page's own (with the state `d`) plus the exact view (`mkview=`), so it reopens the same
  ruin from the same eye. `marks=1` turns the marks on in a page driven by a script, `marks=0` hides the pins.
- URL hash: `#r=3&e=900&d=<state>&yaw=35&pitch=24&dist=95&tx=60&ty=4&tz=60&hour=14&day=250&w=rain`.
  `d` is the compact state (`encodeStates`), `s=cracked,corner,collapse,cut,roof,fall` applies scripted events (`cut`: three storeys of the flat block opened down to the stairs; `roof`: the same plus a roof section gone over the top storey; `fall`: the whole ground storey of the long block taken out, everything above comes down), `hud=0` hides the text.
  Scripted events load as their final state. With `at=<seconds>` they are presented and the clock stops that long
  after the event: `#s=fall&at=0.5` (early), `at=2` (mid), `at=6` (settled). `budget=<n>` caps the pieces in flight.

Screenshots (on the host, against the running container):

```sh
cd tools/shot
node shot.mjs --url 'http://127.0.0.1:5281/destruction/#s=corner&hud=0' --format jpeg
```

`window.__wh` also offers `blast(x, y, z, r, e)`, `setState(text)`, `reset()`, `debrisAt(age)`, `collapseAt(t)` (stop
the clock `t` s after the last event, `null` runs it again), `falling()`, `regenCost(id, n)`, `stats()` and
`benchmark(n, dt)` (with `dt` the clock steps by `dt` per frame).

## Files

| File | Contents |
| --- | --- |
| `src/scene.ts` | The scene as pure data: palette, sizes, flat ground, the five structure recipes and the scripted scenarios. |
| `src/debris.ts` | Thrown chunks: instanced cubes on ballistic arcs, seeded from the event and its age on the engine clock. |
| `src/main.ts` | Wiring through `createEngine`: one layer per structure with the damage material, the rubble layer, falling pieces (`TransientLayer`), picking, keys, URL and `window.__wh`. |
