# The environment

The environment is everything in the picture that does not belong to one object: the time of day, the sun and the moon, the sky, the weather, the wind, the clouds and their shadows, fog, the seasons and snow. This page describes all of it in one place. [Rendering](rendering.md) has the renderer, the passes and the shadow map; this page links to it where a detail lives there.

## What the environment is

Three parts work together:

| Part | Module | What it does |
| --- | --- | --- |
| `Environment` | `env` (layer 5) | Holds the settings and two clocks. `frame(view)` computes one `FrameEnvironment` from them: the light direction and colours, the sky colours, wind, clouds and weather. It draws nothing. |
| `EnvironmentLink` | `runtime` (layer 6) | Every frame calls `env.frame(view)`, hands the light direction and the background to the renderer and writes the values of every environment slot into the Frame block. |
| Environment slots (`EnvSlot`) | contract in `base` | Turn the generic frame into what content needs: the sky, the atmosphere, the cloud cover by place, the season, snow, sway, lit windows, or your own values. See [Environment slots](#environment-slots). |

The layers that draw the environment are in `runtime`: `SkyLayer`, `AtmosphereLayer`, `PrecipitationLayer`, `CloudShellLayer`, `CloudVolumeLayer` and `CloudShadowLayer`; `CloudWeatherMap` is a layer that draws nothing on screen and keeps the map the cloud layers read (see [Clouds](#clouds)). Everything else reaches the screen through the materials: they include `<lighting>` and call its functions (see [Shaders](#shaders)).

`frame(view)` is a pure function of the two clocks, the settings and, in studio light only, the view's heading. The same values give the same frame. The app never computes light itself; it sets numbers and runs the clocks.

`createEngine` builds all of it. In a frame it runs the input hooks, the simulation ticks, the environment clocks, the extraction hooks, then the environment frame, then the render ([The frame order](concepts.md#6-the-frame-order)).

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;

const engine = createEngine({
  canvas,
  view: new PerspectiveOrbitRig(),
  palette: definePalette({ sky: '#8fb2c9' }),
  background: [0.56, 0.7, 0.79],
  environment: { mode: 'day', hour: 9.5, site: { latitudeDeg: 48, dayOfYear: 120 }, weather: { cloudCover: 0.4 } },
  sky: true,
  precipitation: true,
});
// The frame for any view, on demand.
const f = engine.env.frame(engine.view);
console.log(f.sunElevationDeg, f.cloudCover, f.fogColor);
// What the link used in the last frame (null before the first one).
console.log(engine.link.frame?.toSun);
```

### The Frame block

Every program sees one uniform block, `Frame`. The renderer owns its matrices and `u_sunDir`. The environment's own members come from `ENV_CORE_SLOT`, always first:

| Member | Lanes |
| --- | --- |
| `u_sunColor`, `u_ambient`, `u_skyFill`, `u_bounce` | rgb: direct sun, ambient light, light from the sky above, warm bounce from below. Multiples of the surface colour. |
| `u_warmTint` | rgb multiplies the surface colour, w exposure |
| `u_time` | x animation time in seconds, y hour of day; zw free (`gen-arch`'s window light uses them) |
| `u_wind` | xy direction the wind blows toward (x, z); zw free (`gen-vegetation`'s sway uses them) |
| `u_gust` | x 2π / gust length (70 m), y gust speed in m/s |
| `u_cloud` | xy cloud pattern offset in metres, z darkening under a cloud, w 1 / cloud size |
| `u_cloudEdge` | xy noise thresholds of the cloud shadow's edge |
| `u_weather` | x snow cover, y wetness, z fog, w precipitation |
| `u_fogColor` | rgb fog colour (screen space), w precipitation kind (0 rain, 1 snow) |
| `u_snow` | rgb snow albedo, w cloud cover |
| `u_fogShape` | x floor of the fog layer, y 1 / (0.8 × its height), z day of year |

The full layout, with the renderer's members and the shadow areas, is in [The Frame block](rendering.md#the-frame-block). Read `assembleFrameBlock(slots).glsl` when in doubt.

## Time and light

### The clocks

| Clock | Unit | Default | What it drives |
| --- | --- | --- | --- |
| `env.time` | seconds | 0, playing (`animate: false` starts it paused) | wind, gusts, cloud drift, fog wisps, rain and snow, and whatever else reads `u_time.x` (particles, transient pieces, rigs, point lights, your materials) |
| `env.day` | hour of day, wraps at 24 | `hour` 13, paused, `hoursPerSecond` 1 | the sun, and through it the light, the sky and everything slots derive from the hour |

Both are `Clock`s from `core`: `play()`, `pause()`, `toggle()`, `set(t)`, `setRate(r)`, `time`, `rate`, `playing`. The frame loop advances them with real time (`env.clocks`); nothing else does. The loop draws continuously only while a clock plays with a rate other than 0, so pausing `time` makes a still scene cost nothing between frames.

<!-- check: wrap -->
```ts
import { Environment, dayOfYear } from 'wallhammer-web/env';

const env = new Environment({ mode: 'day', hour: 6, hoursPerSecond: 0.25 });
env.setDate(dayOfYear(10, 21), 2); // 21 October, clocks at UTC+2
env.day.play();                    // a quarter of an hour per second
env.day.set(19.5);                 // or jump to an hour
env.time.pause();                  // freezes wind, clouds, rain and snow
const s = env.sun();               // azimuth from north clockwise, height in degrees
console.log(s.azimuthDeg, s.elevationDeg, env.dayOfYear);
```

### Light modes

| `mode` | The light | The hour |
| --- | --- | --- |
| `'studio'` (default) | Turns with the camera: 44° high, 80° from the view direction (`studio`, `DEFAULT_STUDIO`). The scene is always lit from the left. | Has no effect. |
| `'day'` | The sun of `site` at `day.time`, its colours by its height; the moon at night. | Moves the sun. |
| `'fixed'` | One world direction with the colours given in `fixed` ([A fixed light](#a-fixed-light)). | Has no effect. |

`setMode(mode)` switches. Outside `'day'` it pauses the day clock. Weather, wind and clouds apply in every mode. In studio and fixed light the sky keeps its day colours and the fog its day colour.

### Place and date

`site` (`SunSite`) is `latitudeDeg` (north positive), `longitudeDeg` (east positive), `dayOfYear` (1–366) and `utcOffsetHours`. The default, `DEFAULT_SITE`, is 50° N, 15° E, day 172, UTC+2. `env.setDate(dayOfYear, utcOffsetHours?)` changes the date; `dayOfYear(month, day)` converts a date (a year of 365 days). The same `dayOfYear` drives the season slot, so one call moves the sun's path and the foliage together.

`sunPosition(site, hour)` gives the azimuth and the height. The declination and the equation of time come from a short Fourier series of the day of the year. `skyDirection(azimuthDeg, elevationDeg)` turns them into a world direction: x is east, y up, z south.

### The light by the height of the sun

In day mode the light follows the sun's height `e` in degrees. The colours are the fields of `DayLight` (`DEFAULT_DAY`, changed through `environment.day`).

| Sun height | What changes |
| --- | --- |
| −6 to 6 | Night to day: ambient light, sky light, tint, sky colours, fog colour, background. |
| −1.5 to 9 | The sun gains its strength. |
| 2 to 30 | The sun's colour goes from `sunLow` (orange) to `sunHigh`. |
| around 0 (± 6) | `twilight` is added to the ambient light, `skyTwilight` to the horizon. |
| 3 to 36 | `lowSunFill`: the sky light from above grows as the sun sinks, so the ground does not go black. |
| 10 to 55 | `lowSunExposure`: the exposure rises a little as the sun sinks. |
| below −3.5 (full at −9) | The moon shines: `moon` colour from a fixed direction. |
| below −2.5 | The light direction (and the shadow map) swaps from the sun to the moon. |

The light direction is never lower than `minLightElevationDeg` (3°): a lower light would make shadows endless. At night the exposure is `exposureNight` (1.45), so the night stays readable.

### The moon and the stars

The moon stands still at `moonAzimuthDeg` and `moonElevationDeg` (135°, 40° by default). It has no path and no phase. It lights the scene at night in day mode, and the sky layer draws its disc. The stars are a pattern of the sky layer: they come out below a sun height of −4° and are full at −14°, in day mode only, and cloud cover and fog hide them.

### A world on a sphere

The site assumes one up, +y. For a sphere, set `env.observer = { up, sunDir }` every frame from the eye's place. The sun then stands in the world direction `sunDir`, and everything that follows its height (colours, exposure, the swap to the moon, the shadow map's direction) is computed for an observer whose up is `up`. `sphereSunDirection(dayOfYear, utcHour)` is the sun over a sphere that turns about +y.

<!-- check: wrap -->
```ts
import type { Vec3 } from 'wallhammer-web/base';
import { sphereSunDirection } from 'wallhammer-web/env';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine;
declare const upAtEye: () => Vec3; // unit up under the eye

engine.renderer.beforeFrame.unshift(() => {
  engine.env.observer = { up: upAtEye(), sunDir: sphereSunDirection(engine.env.dayOfYear, engine.env.day.time) };
});
```

There is still one light direction for the whole frame. The night side of a sphere goes dark through the up of each point: `lightOnAt` (or `lightOn` after `sunVisibility`) and `atmosphereLight` do that (see [Local up](rendering.md#local-up)).

### A fixed light

`env.setFixedLight(toLight, light?)` switches to `mode: 'fixed'`: the sun stands in the world direction `toLight` (toward the light, need not be unit, normalised each frame; the sun's height is its angle over the horizontal plane) and the colours and strengths are the ones given, not derived from a sun position. `light` (type `FixedLight` without `toLight`) may set `sun`, `ambient`, `skyFill`, `bounce`, `warmTint` (RGB), `exposure` and `backdrop`; what it leaves out keeps its value. Call it again at any time to move or recolour the light (a new direction refits the shadow map as any sun movement does). `EnvironmentConfig.fixed` gives the starting values (`DEFAULT_FIXED`); the day clock is paused in this mode. Sky colour and fog are the day values of the weather.

<!-- check: wrap -->
```ts
import { Environment } from 'wallhammer-web/env';

const env = new Environment({ fixed: { exposure: 1.1 } });
env.setFixedLight([-0.4, 0.8, 0.3], { sun: [1.0, 0.95, 0.85], ambient: [0.30, 0.32, 0.38] });
env.setFixedLight([0.6, 0.5, -0.2]); // later: only the direction
console.log(env.mode, env.fixed.exposure);
```

## Sky and atmosphere

There are two skies. Pick one per scene.

| | The sky (`sky`) | The atmosphere (`atmosphere`) |
| --- | --- | --- |
| Turn on | `createEngine({ sky: true })` or `sky: { … }` | `createEngine({ atmosphere: true })` or `atmosphere: { … }` |
| What it draws | A gradient from horizon to zenith, the glow round the sun, sun and moon discs, stars, a cloud deck. | The light scattered in a shell of air, integrated along each view ray: from the ground, in flight and from orbit. A sun disc and stars; no moon and no clouds of its own (the clouds over it are the [cloud shell](#the-cloud-shell) or the [volumetric clouds](#volumetric-clouds)). |
| The world | Up is +y. | A sphere (the renderer's `radialUp`), or the plane `groundY` under air curved as on a sphere. |
| Weather | Cloud cover closes the deck, fog veils the horizon, fog and precipitation shorten the haze. | Cloud cover over the eye greys and dims its light and air (`atmosphereOvercast`, see [Weather](#weather)); fog and precipitation do not change it. |
| In materials | `aerialPerspective(display, worldPos)`: distant geometry fades into the sky colour behind it. | `atmosphereApply(…)`: the air between eye and surface; `atmosphereLight(…)` in the place of `lightOn`. |
| Views | Perspective only. | Perspective only. |

Both draw first, as a full-screen layer. Without either, the renderer clears to the background colour, which the environment darkens at night.

### The sky

The sky's colours are the frame's `skyZenith`, `skyHorizon` and `sunGlow`, so the sky changes with the light on the scene. Its params (`SkyParams`, `DEFAULT_SKY`), all changeable through `engine.sky.slot.params` at any time:

| Param | Default | Meaning |
| --- | --- | --- |
| `hazeDistanceM` | 1400 | Distance at which geometry has faded about two thirds of the way into the sky (`1 − exp(−(d / hazeDistanceM)²)`). 0 turns the haze off. |
| `fogHaze` | 0.8 | How much fog 1 shortens the haze distance. |
| `precipitationHaze` | 0.35 | How much precipitation 1 shortens it. |
| `cloudHeightM` | 1200 | Height of the cloud deck. |
| `cloudFadeHeights` | 70 | The clouds sink into the horizon haze at this many deck heights along the view ray. |

The deck is a plane at `cloudHeightM`. Each point of it is looked up in the same pattern as the cloud shadows, at the place its shadow falls, so a cloud in the sky stands over its shadow on the ground. Octaves smaller than about a pixel give way to their mean, so the horizon does not shimmer. The deck closes into an even layer between cloud cover 0.45 and 0.78, a little before the light goes fully diffuse. `engine.moveSkyBefore(layer)` draws the sky only where the scene left gaps ([The sky](rendering.md#the-sky)).

Without the sky slot, `<sky>` still resolves to stand-ins: `skyColorDir` returns the fog colour and `aerialPerspective` returns its input. A material that calls them works in every scene.

### The atmosphere

The atmosphere is a model of real air: molecules, particles and an absorbing layer (`AtmosphereMedium`, the Earth's by default), with tables computed once on the CPU when the slot is made. `atmosphereFor(radiusM, heightM)` fits the same air to another sphere. [The atmosphere](rendering.md#the-atmosphere) describes the tables, the sky table, the reference quality and the params.

Which to call in a material:

- `applyFog` is the weather's fog: a mix toward the fog colour by height, with no term for distance (see [Fog](#fog)). It reads `weather.fog` and works with or without the atmosphere.
- `atmosphereApply` is the air between the eye and the surface: it grows with the distance and follows the sun, from the ground up to orbit. Of the weather, only the overcast over the eye changes it (see [Weather](#weather)).
- A material may call both: `atmosphereApply(applyFog(toDisplay(lit), v_world), v_world, v_air, v_airThrough)`.

At the scale of a planet `applyFog` has two catches. The fog layer is measured above the base sphere (`env.fogLayer = { bottomY: 0, topY: 1500 }` is 0–1500 m over it). And fog is applied by height, not distance, so fog that suits the ground also covers the planet seen from orbit: set `weather.fog` from the eye's place and fade it out with the eye's height, as the system example does.

## Weather

`env.weather` (`WeatherState`) is six numbers. The engine does not simulate weather: the app sets them, from a preset, from data or from its own rules.

| Field | Range | Default |
| --- | --- | --- |
| `cloudCover` | 0 clear, 0.5 partly cloudy, 1 overcast | 0 |
| `precipitation` | 0–1 strength | 0 |
| `precipitationKind` | `'rain'` or `'snow'` | `'rain'` |
| `snowCover` | 0–1 snow lying on the ground | 0 |
| `wetness` | 0–1 wet surfaces | 0 |
| `fog` | 0–1 fog and haze | 0 |

A change applies from the next frame. Replace the object or change its fields; values outside 0–1 are clamped.

<!-- check: wrap -->
```ts
import { DEFAULT_WEATHER } from 'wallhammer-web/env';
import type { WeatherState } from 'wallhammer-web/env';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine;

const RAIN: WeatherState = { cloudCover: 0.8, precipitation: 0.7, precipitationKind: 'rain', snowCover: 0, wetness: 0.8, fog: 0.25 };

// At once.
engine.env.weather = { ...DEFAULT_WEATHER, cloudCover: 0.45 };

// Or over a minute of animation time: the app's own rule, a pure function of the clock.
const from = { ...engine.env.weather };
const start = engine.env.time.time;
engine.onExtract(() => {
  const t = Math.min(1, (engine.env.time.time - start) / 60);
  const mix = (a: number, b: number): number => a + (b - a) * t;
  engine.env.weather = {
    cloudCover: mix(from.cloudCover, RAIN.cloudCover),
    precipitation: mix(from.precipitation, RAIN.precipitation),
    precipitationKind: RAIN.precipitationKind,
    snowCover: mix(from.snowCover, RAIN.snowCover),
    wetness: mix(from.wetness, RAIN.wetness),
    fog: mix(from.fog, RAIN.fog),
  };
});
```

What each value does on screen, and what it needs:

| Value | Effect | Needs |
| --- | --- | --- |
| `cloudCover` | Cloud shadows drift over the scene, strongest round 0.55. From 0.55 to 1 the deck closes: the direct sun falls to a fifth, its light goes into the ambient and sky light, cooler; the bounce goes; the sky turns an even grey; the glow round the sun fades; the fog colour darkens a little. `applyFog` takes up to 28 % of the colour's saturation (0.28 × cover²), even without fog. The sky layer closes its deck, hides the sun disc, the moon and the stars. With the atmosphere, from 0.5 to 0.9 the sky's light on surfaces turns grey and even and the air's light dims and greys (see below). | Materials that call `sunVisibility` (or `cloudLight`) and `lightOn`, or `atmosphereLight` and `atmosphereApply` with the atmosphere; the sky slot for the deck. |
| `precipitation`, `precipitationKind` | Rain streaks or snow flakes in the world round the eye, falling along the local down and carried by the wind, hidden behind what stands in front of them and ending at the ground; splashes and rings of rain, specks of snow where they land (see [Rain and snow](#rain-and-snow)). Shorter haze. Drawn above 0.005. With the volumetric clouds only under a cloud (`rainShare`, see [Volumetric clouds](#volumetric-clouds)). | `createEngine({ precipitation: true })` (`PrecipitationLayer`, kept the last layer). |
| `fog` | `applyFog` mixes toward the fog colour, more at the floor of the fog layer, with wisps drifting. The sky's horizon (85 %) and zenith (55 %) move toward the fog colour, and the glow round the sun fades (by 60 %). The haze distance shortens, the sun disc and the stars fade. | Materials that call `applyFog`. Set `env.fogLayer`. |
| `wetness` | Nothing by itself: it is `u_weather.y`. | Content: the terrain of `gen-ground` darkens and gets puddles; trees and buildings darken. |
| `snowCover` | Nothing by itself: it is `u_weather.x`, with the colour `u_snow.rgb` (`snowAlbedo`). | Content: `snowOn` from `snowSlot`, or the material's own rule. |

Wetness and snow cover do not follow the precipitation by themselves. Rain does not make the ground wet unless the app raises `wetness` too. `weatherGround(weather, dtS, rates?)` (in `env`) is that step for an app that wants it: a pure function that returns the weather after `dtS` seconds, with snowfall raising `snowCover` by its strength, rain raising `wetness` and washing the snow away, and the ground drying (and, with `thawPerS`, the snow melting into wetness) while nothing falls. The values stay within 0–1. The default rates (`DEFAULT_WEATHER_GROUND`) cover the ground after three minutes of heavy snow, wet it within 20 seconds of heavy rain and dry it over four minutes; the snow stays without a thaw. Step it with the simulation's or the animation's clock, never the wall clock, so a replay gives the same ground:

<!-- check: wrap -->
```ts
import { weatherGround } from 'wallhammer-web/env';
import type { Engine, EngineView } from 'wallhammer-web/runtime';
declare const engine: Engine<EngineView>;

let last = engine.env.time.time;
engine.renderer.beforeFrame.push(() => {
  const dt = engine.env.time.time - last; // the animation clock: paused, it changes nothing
  last = engine.env.time.time;
  if (dt > 0) engine.env.weather = weatherGround(engine.env.weather, Math.min(dt, 1), { thawPerS: 1 / 600 });
});
```

The minimal example does this with `ground=follow` in its URL hash.

**Overcast with the atmosphere.** With the atmosphere slot the light of a place comes from the air's tables, which know nothing of clouds. So the slot carries how overcast the sky over the eye is (`atmosphereOvercast`: the frame's `cloudCover` from 0.5 to 0.9, fading out as the eye rises from the clouds' top, the param `cloudTopM` (4000 m), to twice that height; `u_atmCloud.x`). Under it:

- `atmosphereLight` replaces the sky's light on a surface by the light the clouds pass on: grey, 30 % of the sun and the sky above them, nearly the same from every side, so the ground is lit flat and without colour; the sun through a gap still comes in through its `sun` argument (the cloud shadows);
- `atmosphereApply` (both forms) greys the air's light by up to 75 % and dims it by up to 60 %, so the far hills fade into a grey haze instead of a blue one.

A material gets this by calling `atmosphereLight` for its light and `atmosphereApply` for the air, as the [atmosphere](rendering.md#the-atmosphere) asks anyway. A material that lights itself (water with its own sky reflection, for example) does not grey under the clouds. Set `cloudTopM` to the clouds' top (the volume's `topM`) when the clouds are not the default ones. The value follows the frame's cover over the eye, so with a cover by place it changes as the eye moves under and out from under a deck.

**Determinism.** The weather is input. Everything drawn from it is a pure function of the weather, the clocks and the pixel: the cloud pattern is the wind times the animation time, the drops and flakes a function of the animation time and their tile of the world, the landing marks of the animation time and their cell. Two runs with the same clock values and the same weather give the same picture. Nothing reads `Math.random` or the wall clock.

### Rain and snow

`createEngine({ precipitation: true })` adds the `PrecipitationLayer`; `precipitation: { density, impacts, look }` sets it up (`PrecipitationOptions`). In a perspective view the drops and flakes are in the world round the eye:

- **Drops of the world.** The world is split into cubic tiles; the drops of a tile are hashed from the tile's coordinates, each lives for a short time (0.8 s for rain, 4 s for snow) and starts again at another place. A drop is where it is whichever way the eye looks or moves: nothing repeats, there is no box round the eye and no step in density. Two ranges: small tiles of 8 m to about 16 m from the eye, large tiles of 24 m with larger drops to about 60 m. Only the tiles in the view are drawn, at most 160 per range, nearest first; drops fade in near the eye, out at the far end of their range and at both ends of their life, so none pops. The model is `env` (`precipitationTiles`, `precipitationDrop`, `PRECIPITATION_GLSL`); the vertex shader places every drop from its index, its tile and the animation time.
- **The fall.** Along the local down (toward the centre under radial up), rain at 8.5 m/s and snow at 1.2 m/s; the wind adds a drift across it, a third of its speed for rain (at most 4 m/s) and 60 % for snow (at most 2.5 m/s), and flakes sway. Rain is a streak along its motion over a short exposure; snow is a soft disc. Neither is drawn thinner than about a pixel: a drop far away gets fainter instead.
- **Occlusion.** The drops are depth tested against the scene: they end at the ground and disappear behind walls. They do not know a roof: under a roof it still rains (see [Limits](#limits)).
- **Landing marks.** Where the scene's depth can be read, one pass over the screen draws marks on surfaces that face up within 30 m of the eye: bright splashes and, on wet ground (`wetness`), rings for rain; specks that appear and fade for snow, fewer on snow cover. Each cell of a grid on the ground has at most one mark at a time, hashed from the cell and a slot of time, so the marks belong to the world like the drops. Walls and steep slopes get none.
- **Light.** Rain takes the colour of the fog lifted a little, snow the lit snow colour (`u_snow`) under the light at the eye, so both dim at night and under a closed deck.

`impacts` (default true) needs the scene's depth: in the standard depth mode `createEngine` then draws into an offscreen target and copies it to the canvas, as the reversed and logarithmic modes always do (`RendererOptions.readableDepth`, see [Rendering](rendering.md)). The antialiasing and the colour of the picture are the same; the copy costs about 0.15–0.3 ms a frame at 1600 × 900 even with nothing falling. `impacts: false` keeps the canvas path. `look: 'screen'` draws the old pattern over the whole image instead (streaks and flakes as a function of the time and the pixel); an orthographic view always draws that pattern.

What it costs at 1600 × 900 on an Apple M4 Pro, heavy rain at eye height: the drops 0.12–0.35 ms (about 180,000 drops in two draw calls), the marks 0.25–0.35 ms (the depth copy and one pass over the screen), so 0.45–0.5 ms in all, plus the offscreen copy above in the standard depth mode. `density` scales the drops; `layer.impacts = false` at run time drops the marks.

## Clouds

The clouds come in pieces that build on one another. Start from the table, then read the section of each piece you turn on.

| Piece | Turn on | World | What it draws or feeds | Cost |
| --- | --- | --- | --- | --- |
| [Cloud pattern and its shadows](#cloud-shadows) | Always there; `weather.cloudCover` above 0 and `clouds.darkness` above 0. | Flat and sphere | The share of the sun in `cloudLight` and `sunVisibility` of every lit material. | Three value-noise lookups per lit fragment. |
| Sky deck ([The sky](#the-sky)) | `createEngine({ sky: true })` | Flat | The flat clouds of the pattern in the sky, over their shadows. Left out with `cloudVolume`. | Part of the sky's one full-screen draw. |
| [Cloud cover by place](#cloud-cover-by-place) | `cloudFieldSlot(field)` in `createEngine({ slots })` | Sphere (radial up) | A cover that differs from place to place, for the shadows, the shell, the weather map and the volume. | Two or three more lookups per lit fragment. |
| [Cloud shell](#the-cloud-shell) | `new CloudShellLayer(…)`, `engine.add(shell)`; needs the cover by place | Sphere | The flat clouds of the pattern over a sphere; as `cloudVolume.shell`, the far clouds of the volume. | About 0.6–1.3 ms at 3456 × 2000 from inside the air (Apple M4 Pro). |
| [Cloud shadow texture](#cloud-shadows-from-a-texture) | `createEngine({ cloudShadows: true })` | Flat and sphere | One texture lookup in the place of the noise in every lit material; with `cloudVolume`, the shadows of the volume's clouds. | 1 MB; one small draw every fourth frame (about 0.1 ms). It took a frame of the `system` example from about 7.9 to 5.0 ms. |
| [Cloud weather map](#the-cloud-weather-map) | Made by `cloudVolume`; `new CloudWeatherMap(…)` by hand | Flat and sphere | Cover, deck share and precipitation over every place, for the volume and the shell. | 1.5 MB on a sphere; about 0.03 ms per refreshed face. |
| [Volumetric clouds](#volumetric-clouds) | `createEngine({ cloudVolume: true })` | Flat and sphere | Clouds with a body, from the ground, from inside and from above; rain shafts; where the rain falls (`rainShare`). | About 0.7–2.1 ms at 3200 × 1800 by quality and view. |

Two setups cover most scenes.

**A flat scene with volumetric clouds.** The sky, the volume, its shadows and rain that falls only under a cloud:

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { DEFAULT_WEATHER } from 'wallhammer-web/env';
import { createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;

const engine = createEngine({
  canvas,
  view: new PerspectiveOrbitRig(),
  palette: definePalette({ ground: '#4d4335' }),
  background: [0.6, 0.7, 0.8],
  environment: { mode: 'day', hour: 15, clouds: { sizeM: 2400 } },
  sky: true, // no flat deck: the volume draws the clouds
  cloudVolume: true,
  cloudShadows: true, // the shadows of the volume's clouds
  precipitation: true, // falls only under a cloud (rainShare)
});
engine.env.weather = { ...DEFAULT_WEATHER, cloudCover: 0.45 };
```

**A planet.** The atmosphere, a cover by place, the volume near the eye and the cloud shell as its far layer up to orbit, as the `planet` and `system` examples do:

<!-- check: wrap -->
```ts
import { atmosphereFor, cloudFieldCover, cloudFieldSlot } from 'wallhammer-web/env';
import type { Layer } from 'wallhammer-web/render';
import { CloudShellLayer, createEngine } from 'wallhammer-web/runtime';
import type { EngineOptions, EngineView } from 'wallhammer-web/runtime';
declare const options: EngineOptions<EngineView>; // canvas, view, palette, background, renderer: { radialUp }
declare const blended: Layer; // the first layer that blends: a surface seen through, far air shells

const RADIUS_M = 600_000;
const slot = cloudFieldSlot({ axis: [0, 1, 0], zonal: [0.6, 0.5, 0.3, 0.3, 0.4, 0.5, 0.5, 0.3], patchAmount: 0.4, patchSizeM: 45_000, patchWarp: 0.6, patchOffset: [0, 0, 0], darkness: 0.3 });
const engine = createEngine({
  ...options,
  slots: [slot],
  atmosphere: { ...atmosphereFor(RADIUS_M, 30_000) },
  cloudShadows: true,
  cloudVolume: true,
  precipitation: true,
});
const shell = new CloudShellLayer(engine.renderer, engine.link);
shell.baseRadiusM = RADIUS_M;
shell.center = [0, -RADIUS_M, 0]; // the sphere's centre in render space, every frame
engine.add(shell);
if (engine.cloudVolume) engine.cloudVolume.shell = shell; // the far clouds, and all of them from 15–30 km up
engine.add(blended);
engine.moveCloudsBefore(blended); // opaque layers, then the clouds, then what blends over them
// Each frame: the frame's cover is the cover under the eye (here with up = +y at the eye).
engine.env.weather = { ...engine.env.weather, cloudCover: cloudFieldCover(slot.params, [0, 1, 0], RADIUS_M) };
```

Water or haze below a level, seen from above and from inside, and a surface moved by waves are not part of the environment: see [A medium below a level](rendering.md#a-medium-below-a-level) and [A moving surface of waves](rendering.md#a-moving-surface-of-waves). The `planet` example builds its sea from the two.

The flat clouds share one pattern: three octaves of value noise (`CLOUD_OCTAVES`) of size `clouds.sizeM`, anchored in the world and drifting with the wind. The cloud shadows, the sky's deck and the cloud shell all read it, so they agree with one another. The volumetric clouds have their own noise volumes and the cloud weather map; with them the shadow texture holds their shadows, and under radial up the shell draws their clouds.

| `clouds` (`CloudConfig`) | Default | Meaning |
| --- | --- | --- |
| `darkness` | 0.3 | How much direct sun a cloud takes away at a partly cloudy sky. 0 turns cloud shadows off. |
| `sizeM` | 320 | Size of the clouds in metres. |
| `speedFactor` | 1.5 | How many times faster than the ground wind the clouds drift. |

How many clouds there are is `weather.cloudCover`. The cover moves the noise thresholds of the pattern's edge from 0.92 (a few small clouds) to 0.12 at 0.55 (nearly closed), and the darkness grows up to 2.4 times by then. From 0.55 on the pattern fades into the even overcast, which dims the light itself. Between 0.7 and 0.78 the gaps of the shadow pattern close: from 0.78, where the sky's deck is closed, every place lies in the deck's shade. At cover 1 there is no pattern left. `cloudCoverTerms(cover, darkness)` returns these terms on the CPU.

### Cloud shadows

`cloudLight(worldPos)` is the share of direct sun a point keeps under the clouds: 1 in full sun, less under a cloud. `sunVisibility(worldPos, n, offsetTexels)` multiplies it with the shadow map, so every material that takes its sun from `sunVisibility` gets cloud shadows without asking. Under radial up the pattern is a field in space round the sphere.

The pattern is computed per fragment of every lit material: three value-noise lookups wherever the cover is between 0.01 and 1 and `clouds.darkness` is above 0, nothing elsewhere. The shadow map does not hold the clouds, so moving clouds never redraw it. With `createEngine({ cloudShadows: true })` one texture lookup takes the place of the noise (see [Cloud shadows from a texture](#cloud-shadows-from-a-texture)).

<!-- check: wrap -->
```ts
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine;

engine.env.weather = { ...engine.env.weather, cloudCover: 0.5 };
engine.env.clouds = { darkness: 0.35, sizeM: 600, speedFactor: 1.5 };
engine.env.wind = { fromDeg: 230, speedMs: 6 }; // the clouds drift toward the north-east
```

### Cloud cover by place

`weather.cloudCover` is one number for the whole world. Under radial up (see [Local up](rendering.md#local-up)) `cloudFieldSlot(field)` (in `env`) makes the cover vary by place instead:

| `CloudCoverField` | Meaning |
| --- | --- |
| `axis` | Unit axis in the frame the field is fixed in. |
| `zonal` | 8 covers by `abs(dot(up, axis))`: `zonal[0]` where up is across the axis, `zonal[7]` along it, linear between. |
| `patchAmount` | 0–1: how far value-noise patches move the cover up and down. |
| `patchSizeM` | Size of the patches. |
| `patchWarp` | 0 for none; one more lookup bends the patches, in patch sizes. |
| `patchOffset` | Metres the patches have drifted. The app moves it with its own time. |
| `darkness` | Darkness of the cloud shadows, as `clouds.darkness`. |

The field is fixed in one frame; `axis` and the up the shader reads are in that frame. The slot has no include of its own: when the frame block holds a slot named `CLOUD_FIELD_SLOT`, the environment link registers `lightingGlsl({ cloudField: true })` as `lighting` (and `shadowGlsl({ cloudField: true })` as `shadow`). Its `cloudLight` then reads the cover at the point and gives the share of the sun there. Every cover 0 (`active` 0) means full sun without a lookup. Without the slot `LIGHTING` is the include, unchanged.

The frame's light stays dimmed by the global `weather.cloudCover`. So the shader divides the share by that dimming (`u_cloudFieldLight.y`), and `u_sunColor × cloudLight` is the right sun at every place. Set `weather.cloudCover` to the cover under the eye: the ambient light, the sky colours and the fog then match the sky the eye stands under. A material whose light does not carry that dimming (`atmosphereLight` does not) multiplies `sunVisibility` by `u_cloudFieldLight.y`.

`cloudFieldCover(field, up, radiusM)` and `cloudFieldSun(cover, noise, darkness)` are the same functions on the CPU: the app asks them for the weather under the eye.

Cost per fragment of a lit material: the cover (two `vnoise3` lookups, three with `patchWarp`) and, where the cover is above 0.01 and below 1, the three octaves of the pattern. Under a clear sky and under a cover of 1 the pattern is left out, because it has no part in the share there.

### The cloud shell

`CloudShellLayer` (in `runtime`) draws the clouds of the cover by place as a shell `heightM` (3000 m) above a sphere (`center`, `baseRadiusM`, render space), from the same field, so the clouds sit over their shadows. `toField` (3 × 3, row-major) turns render directions into the field's frame, `light` is the direction to the sun, `opacity` 0 draws nothing. It throws without the slot. One draw in the colour pass, both sides, with the depth test and without depth writes: peaks and the sphere hide it. Add it before transparent layers that should be drawn over it.

From above, the top of a cloud is lit by the sun of the place: darker where the cover is high, brighter where the pattern is thick. From below, the base shows what comes through: the sun share under it and less of the sky's light the higher the cover, darker where thick. The two are eased over ±200 m round the shell's height. The pattern shows inside a closed deck too, so a deck seen from the ground is a grey sky with structure.

**As the far layer of the volumetric clouds.** Handed to `CloudVolumeLayer` as its `shell` on a world with radial up, the shell stops drawing the pattern and draws the volume's own clouds: the same cloud weather map, the same shape noise at the same places drifting the same way, lit by the same functions (`volume`, set by the volume in every frame; `null` while the volume is off or its noise is not made yet). It is then drawn at the layer's top (`topM`), and with the eye inside the layer also at its base. A view ray is drawn once, where it first enters the layer (from inside the layer, where it first leaves it), and that fragment integrates the ray's whole span in the layer:

- five samples of the shape spread evenly over the span, each weighted by the shell's share of the clouds at its distance (1 − `cloudVolumeNearShare`, see [From the ground to orbit](#volumetric-clouds));
- where the samples lie far apart across the view, or a pixel covers several texels of the noise, the shape gives way to its mean density over its spread, as in the march; such a sample stands for the clouds and the gaps between them, and lets the light through the gaps, so a low cover stays scattered clouds out to the limb instead of turning into a white haze;
- the light toward the sun comes from the sample's own density and its height under the clouds' top, without samples toward the light; seen from above, the light that reached a sample is that which the clouds in front of it along the view let through.

So the volume and the shell draw the same clouds, and the hand-over changes the detail, not the shapes. On a flat world the shell keeps the pattern and the opacity 1 − `weight`.

Cost. Seen from inside the air the shell covers the whole picture, so its fragments do only what must be sharp:

| Where | Work |
| --- | --- |
| Per vertex (a cube sphere of `segments` quads along each face edge, 48 by default: 27 648 triangles) | The cover over the vertex's shadow point, and the air between the eye and the vertex (`atmosphereAir`, `airSteps` steps with the atmosphere, none without it), carried per metre of the view ray. |
| Per fragment | Discarded where the carried cover is 0. Otherwise the ray to the base sphere, three octaves of `vnoise3` (octaves under about two pixels replaced by their mean), the light, and the air: the carried value times the fragment's own distance, so it stays right under a deck a few hundred metres overhead. Discarded where the cloud is nearly clear. |

On an Apple M4 Pro at 3456 × 2000 this took the shell's part of a frame from about 2.5–4.9 ms to 0.6–1.3 ms below 10 km. Because the cover is carried from the vertices, it changes linearly across a quad: about 1.9° of arc at 48 segments, 20 km on a sphere of 600 km. Patches smaller than a few quads lose their shape; raise `segments` for them.

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { cloudFieldCover, cloudFieldSlot } from 'wallhammer-web/env';
import { CloudShellLayer, createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;

const slot = cloudFieldSlot({ axis: [0, 1, 0], zonal: [0.6, 0.5, 0.3, 0.3, 0.4, 0.5, 0.5, 0.3], patchAmount: 0.4, patchSizeM: 45_000, patchWarp: 0.6, patchOffset: [0, 0, 0], darkness: 0.3 });
const engine = createEngine({ canvas, view: new PerspectiveOrbitRig(), palette: definePalette({ ground: '#4d4335' }), background: [0.6, 0.7, 0.8], slots: [slot] });
const shell = new CloudShellLayer(engine.renderer, engine.link);
shell.baseRadiusM = 600_000;
shell.center = [0, -600_000, 0];
engine.add(shell);
// Each frame: drift the patches with the time of the app, and give the frame the cover under the eye.
slot.params.patchOffset = [0, 0, 3 * engine.env.time.time];
const cover = cloudFieldCover(slot.params, [0, 1, 0], shell.baseRadiusM);
engine.env.weather = { ...engine.env.weather, cloudCover: cover };
```

### Cloud shadows from a texture

`createEngine({ cloudShadows: true })` (or the options `{ extentM, size, interval }`) adds the slot `cloudShadowSlot()` to the Frame block and the layer `engine.cloudShadows` (`CloudShadowLayer`, in `runtime`). It works on a flat world and under radial up, with or without the cover by place. Off by default; materials do not change.

The layer draws the share of the sun into a texture seen along the light. Its parts:

| Part | Default |
| --- | --- |
| Texture | 512 × 512 texels, RGBA8 (1 MB), R the share. |
| Square | 24 cloud sizes across the light (`CLOUD_SHADOW_EXTENT_CLOUDS`): 57.6 km with a texel of 112.5 m for clouds of 2400 m. Centred on the base surface under the eye. |
| Redraw | Every `interval` frames (4), and at once when the eye has moved an eighth of the square from its centre, after `invalidate()` and after a context restore. |
| Between redraws | The lookup moves with the clouds' drift, so the shadows move every frame. |
| Edge | From 80 % to 96 % of the half edge the texture blends into the computed share; beyond, the share is computed as before. |

With the slot in the block the environment link registers the texture variant of `cloudLight` (`lightingGlsl({ cloudShadow: true })`, `shadowGlsl` alike) and fixes `u_cloudShadow` to texture unit `CLOUD_SHADOW_UNIT` (12).

**Snapped to the world.** The square's centre is snapped to whole texels of a lattice across the light. The lattice is fixed to the sphere's centre under radial up and to the world's origin on a flat world. While the light stands still, a redraw keeps every texel on the same line through the world, so the shadows do not swim when the eye moves. When the light moves, the lattice turns with it.

**Along the light.** A texel is a line along the light. Its value is the share where that line meets the base surface: the base sphere under radial up, the world's y = 0 on a flat world. A point above that surface, such as a hill or a roof, gets the shadow of the cloud the light comes through, which is where the sky deck and the cloud shell draw it. The computed `cloudLight` without the texture takes the cloud straight above. Beyond the texture, the computed share of this variant follows the light too. A low sun stretches the square along the ground by 1 / sin(sun elevation): about 5.8 times at 10°.

**Cost.** In the `system` example on an Apple M4 Pro, at 3200 × 1800, with the clouds by place and the cloud shell, the frames compared as follows (median of 6 interleaved runs of 30 frames):

| View | Computed | Texture |
| --- | --- | --- |
| 8 km up | 7.9 ms | 5.0 ms |
| 2 km up | 7.9 ms | 4.8 ms |
| 40 m up | 7.4 ms | 5.1 ms |
| Orbit, 260 km | 3.3 ms | 3.3 ms |

From orbit the square covers little of the picture. Where the terrain lies near the base surface, the picture matches the computed shadows to within one or two steps of 8 bits.

`enabled = false` makes `cloudLight` compute the share everywhere again, at run time: the same picture at the old cost, for comparisons. `texture` is the texture. `cloudShadowProjection` is the projection on the CPU. `source` (a `CloudShadowSource`) puts the shadows of other clouds into the texture: `createEngine` sets the [volumetric clouds](#volumetric-clouds) there.

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;

const engine = createEngine({ canvas, view: new PerspectiveOrbitRig(), palette: definePalette({ ground: '#4d4335' }), background: [0.6, 0.7, 0.8], sky: true, cloudShadows: true });
engine.env.weather = { ...engine.env.weather, cloudCover: 0.5 };
engine.env.clouds = { darkness: 0.35, sizeM: 2400, speedFactor: 1.5 }; // a square of 57.6 km
// After a jump of the light or of the clouds, draw the texture in the next frame:
engine.cloudShadows?.invalidate();
```

### The cloud weather map

`CloudWeatherMap` (in `runtime`) holds the cloud weather over every place. The [volumetric clouds](#volumetric-clouds) and the cloud shell as their far layer read it (`CloudVolumeLayer` makes its own); `createEngine` does not add one by itself.

| Channel | What | From the cover by `rules` (`CloudWeatherRules`, default `DEFAULT_CLOUD_WEATHER_RULES`) |
| --- | --- | --- |
| R | The cover, 0–1. | The cover by place of `cloudFieldSlot`, or the frame's `weather.cloudCover`. |
| G | The deck share: 0 heaped clouds (cumulus), 1 a flat, lower deck (stratus, up to 45 % of the layer). | Rises over `deckCover` (0.6 to 0.95), less by `convection` times the precipitation. |
| B | The precipitation, 0–1. | Rises over `rainCover` (0.6 to 0.9). |

`cloudWeatherKind(cover, rules)` (in `env`) gives [G, B] on the CPU. Where it rains, the part that is not deck (B · (1 − G), so with the default `convection` of 0 only where the cover has not yet closed into a deck) grows into tall clouds that fill the layer to its top (`cloudVolumeTypedProfile`), and a raining deck thickens from 45 % to 85 % of the layer. Rain also closes the sky over it: the shape is cut at a cover closed toward 1 by the square root of the precipitation (`cloudVolumeRainCover`), the wide lookup moves it less and the shape's low values fill up (`cloudVolumeRainShape`), so rain never falls out of broken cloud with blue gaps. A raining cloud is up to three times as dense (`CLOUD_RAIN_DENSITY`) and its light is greyer and darker: at the base it keeps a little more than a quarter of the light of a dry cloud under the heaviest rain, at the top 60 %. The map does not decide whether it rains on the ground; that is the frame's `weather.precipitation` (see [Weather](#weather)). `rules` may change at any time, like the cover. An app with its own weather model (fronts, showers) raises `convection` to turn the rain of a place into towering clouds.

| World | Map |
| --- | --- |
| Radial up | A cube map indexed by the up in render space: 6 × 256² texels, RGBA8 (1.5 MB). The cover by place of `cloudFieldSlot` when the block holds it, the frame's cover otherwise. The faces are filtered across their edges, so it has no seam and no pole. |
| Flat | A tile of 64 km around the eye (128², `tile` holds its centre x, z and its edge), with the frame's cover. |

It is made whole in the first frame and after a context loss. While what it is made of changes, it is refreshed every `interval` frames (30), one cube face per frame. A face costs about 0.03 ms of GPU time on an Apple M4 Pro. Sampled by direction, the map matched `cloudFieldCover` on the CPU to within 0.006. Bind it with `bind(device, unit)` to a unit of its own and read it with the functions of `CLOUD_WEATHER_GLSL`: `cloudWeatherCube(map, up)` or `cloudWeatherTile(map, tile, xz)`.

<!-- check: wrap -->
```ts
import { CloudWeatherMap } from 'wallhammer-web/runtime';
import type { Engine } from 'wallhammer-web/runtime';
declare const engine: Engine;

const weather = new CloudWeatherMap(engine.renderer, engine.link, { interval: 30 });
engine.add(weather);
```

### Volumetric clouds

`createEngine({ cloudVolume: true })` (or `CloudVolumeOptions`) adds `CloudVolumeLayer` (in `runtime`) as `engine.cloudVolume`: a layer of heaped clouds with a body, light through it and gaps between them, seen from the ground, from inside and from above. Off by default. It works under radial up and on a flat world, with or without the atmosphere and the cover by place. With `sky` the sky draws no flat deck (`SkyLayer` with `{ clouds: false }`); with `cloudShadows` the cloud shadow texture holds the shadows of the volume's clouds (see below).

**The model** (in `env`, on the CPU and in `CLOUD_VOLUME_GLSL`):

| Part | What |
| --- | --- |
| Layer | Between `baseM` (1500 m) and `topM` (4000 m) above the ground: two spheres round the centre of up, or two planes of world height on a flat world. |
| Cover | The cloud weather map at the place: the cover by place with `cloudFieldSlot`, the frame's `weather.cloudCover` otherwise. A second lookup of the shape volume at `wideSizeM` (41.7 km) moves it by up to ±`wideCover` / 2, so an even cover still has fields and holes. |
| Shape | The shape volume, one tile per `shapeSizeM` (9.6 km), times a height profile by the place's type from the cloud weather map (`cloudVolumeTypedProfile`: flat bases, tops that narrow; the deck share flattens the clouds into the lower 45 % of the layer, tall raining clouds fill it to the top with full tops; `cloudVolumeProfile` is the profile by the cover alone), cut at a threshold that falls with the cover (`cloudVolumeThreshold`, 0.9 at 0 to 0.1 at 1). Seen from below, columns of an optical depth over 1 cover about a tenth of the sky at 0.2, 38 % at 0.35, 69 % at 0.5 and nearly all of it from 0.7. |
| Detail | The detail volume, one tile per `detailSizeM` (1.7 km), eats into the edges by `erosion` (0.45). |
| Density | `cloudVolumeDensity`, 0 … 1, times `extinctionPerM` (0.03 per metre), up to three times that where it rains (`CLOUD_RAIN_DENSITY`). |
| Drift | The noise is fixed to the world and drifts with the cloud pattern (`u_cloud`, the wind times the time times `clouds.speedFactor`). |

**The scene inside the layer.** Where the main target's depth can be read (the reversed and logarithmic depth modes, or a canvas drawn with two samples), `prepare` first copies the depth the last frame drew (`Device.sceneDepth`). A ray's march ends where that scene lies along it: the last frame's depth reprojected to this frame's eye. So a mountain that reaches into the layer has the clouds in front of it and none from behind it, with no bands where the two cross, also with multisampling.

**The march.** In `prepare` one full-screen draw fills a target of `quality.scale` of the screen's width and height (`rgba16f`; where float targets cannot be drawn into, `rgba8` with the colour stored as its square root). With `history` (the default) it marches one texel of every 2 × 2 block per frame, in turn (`cloudVolumeBayer`), into a target a quarter that size. Each texel:

- takes its view ray's span in the layer (`cloudVolumeSpan`), up to `maxDistanceM` (120 km), and stops at the ground sphere or plane, or at the scene;
- puts `steps` samples along it, fewer on short spans and more on a span that runs far through the layer (toward the horizon, or with the eye inside the layer): as many as keep the farthest samples within half a cell of the shape, up to four times `steps`. Inside the layer and along long rays they crowd toward the eye. A jitter per pixel (`cloudVolumeJitter`: interleaved gradient noise, moved on by the golden ratio with every `frameIndex`, so a few frames in a row sample each pixel at evenly spread places) shifts them. Through clear air every second sample is taken, the march steps back at the first cloud, and it stops once less than 1 % of the light behind gets through;
- where samples lie more than half a cell of the shape apart (beyond what the extra samples reach, or out to `maxDistanceM` without a far layer), the shape gives way to its mean density over its spread, and the step lets the light through the share of that spread that is clear, so far clouds become a soft layer that still lets through as much as the gaps between them, instead of scattered dots or a closed haze;
- from every sample in a cloud takes `lightSteps` samples toward the sun, ever longer, reaching about two thirds of the layer (at most 2 km).

The light of a sample is the sun at the clouds (with the atmosphere `atmosphereSun`, otherwise the frame's sun or moon without the overcast's dimming) through what lies toward it (Beer–Lambert in three octaves of ever less extinction, for light scattered many times). A two-lobe Henyey–Greenstein phase brightens the rim toward the sun, edges that face away from the eye toward the sun are darker, and light diffused through the cloud falls off slowly. To this come the sky's light (grey at the tops, bluish at the bases, and dimmer toward the bases, the more so under a closing deck) and the ground's from below; with the atmosphere both are those the atmosphere gives the ground, so the clouds turn dark at night like the land. The texel stores the colour after exposure, the air and the haze at the clouds' mean distance, premultiplied by the opacity, and that mean distance.

**The history.** With `history` a second draw (the accumulation) makes the picture the composite reads, at the full size of the layer's target. Every texel takes its place in the last frame's picture: reprojected at the clouds' mean distance (`cloudVolumeReproject`), moved with the eye (the render origin's shifts of a streamed world included) and with the drifting clouds. Where it was marched now, the new sample is averaged in: up to 12 samples per texel while the eye holds still, 4 while it moves. The last picture is held within the range of the new samples around (widened a little), so moving clouds leave no trails, and it is left out:

- where the place fell off the last screen, or where the ray's entry into the layer or its end moved (a surface came in front or went away, the edge of the layer or of a mountain);
- after a cut or a jump of the eye (`cloudVolumeKeepHistory`: a turn over 30°, or a move over a quarter of the distance to the layer and over 100 m), after `resetHistory()` and after `frameIndex` was set.

A texel without a history takes the new samples around it (a tent two texels wide). A still view settles within about a second; a fast descent or pan shows no trails, only a softer picture for a few frames where the view revealed new clouds. `history = false` marches every texel every frame and keeps nothing: a frame is then a function of the view, the environment and `frameIndex` alone (for tests). Where float targets cannot be drawn into, there is no history.

**The composite.** In the colour pass one quad per 8 × 8 texels of the picture puts the clouds over the scene, none where the layer is out of view; pixels without cloud are discarded. Where the nearest texels saw the same surface (the ray's entry into the layer and its end) as the pixel's ray, the pixel takes a tent over 3 × 3 texels; at the edge of the planet, of the layer or of a mountain it keeps only texels whose entry and end match its own, so that edge stays sharp. Where the scene's depth is copied, each quad lies where the layer begins along its view, so the depth test keeps the clouds off whatever is nearer and the early depth test skips the pixels behind it. Elsewhere (the standard depth mode drawing into the canvas) the pixel writes the clouds' mean distance as its depth. Terrain in front hides the clouds, and an eye inside a cloud sees a white-out.

**Shadows.** `CloudVolumeLayer` is a `CloudShadowSource`: with `cloudShadows`, `createEngine` sets it as `engine.cloudShadows.source`, and the cloud shadow texture holds the shadows of the volume's clouds. Each texel sums the shape's density (without the erosion) at `shadowSamples` (12) points where the light's line crosses the layer; the share of the sun then lies between that under a clear sky and that under a cloud no sun gets through, as with the pattern. It is blended with the pattern's by the layer's `weight`, and beyond the texture's square the shadows are the pattern's. The texture is drawn every fourth frame as before, about 0.1 ms per draw.

**From the ground to orbit.** The march covers the near clouds, a far layer handed in as `shell` (a `CloudFarLayer`: the cloud shell) the far ones and the view from high up. Under radial up the shell draws the volume's own clouds (see [The cloud shell](#the-cloud-shell)), and the two hand over by distance as well as by height:

- by distance: along every view ray the volume draws all the clouds up to `handoverFromM` (20 km) and none from `handoverToM` (40 km), the shell the rest (`cloudVolumeNearShare`), so there is no edge where the march ends and no flat band beyond it;
- by height: between eye heights `fadeFromM` (15 km) and `fadeToM` (30 km) the volume's share falls to 0 at every distance (`weight`); above `fadeToM` nothing is marched and the shell draws everything.

Because both draw the same clouds, the climb sharpens or softens them and does not swap them for others. Without radial up (a flat world), or while the noise is being made, the shell gets the opacity 1 − `weight` and draws its pattern as before, and the march fades its clouds out over the last fifth of `maxDistanceM`.

**Rain shafts.** With the eye under the base, the march also draws the rain falling out of raining clouds (`rainShafts`, 1 by default, 0 off): grey curtains between the ground and the base wherever the weather map's precipitation falls out of cloud, heavier under the clouds' cores. Six samples per ray up to where it meets the layer, the ground, the scene or 30 km (at most the hand-over distance); the heaviest rain under a core hides what lies about 5 km behind it. Under the base the composite then takes the path that writes the depth per pixel (shafts lie in front of the layer). There are no shafts from above the base or in the cloud shell.

**Rain under the clouds.** `rainShare` (0–1) is how much of the frame's precipitation falls at the eye: in `prepare` the layer sums the shape's density straight up through the layer at the eye (`cloudVolumeColumnDepth`, four samples on the CPU, the same noise as on the GPU) and turns it into a share (`cloudVolumeRainShare`): none under a gap, all under a column of an optical depth of 3 or more. `createEngine` hands the layer to the precipitation (`PrecipitationLayer.source`), which multiplies `weather.precipitation` by it, so walking out from under a raining cloud the rain stops. The app still says that, and how hard, it rains (`weather.precipitation`, for example from the cover under the eye); the volume only takes it away where there is no cloud overhead. Without the volume, or with `enabled = false`, the share is 1.

| `quality` | `scale` | `steps` | `lightSteps` | `detail` |
| --- | --- | --- | --- | --- |
| `'low'` | 0.35 | 16 | 3 | off |
| `'medium'` (default) | 0.5 | 20 | 4 | on |
| `'high'` | 0.5 | 40 | 5 | on |

**Cost.** In the `system` example on an Apple M4 Pro, with the clouds by place and the cloud shadows, the frames cost this much more than the same frame without any clouds (median of 6 interleaved runs of 20 frames each; runs on different occasions differ by up to 0.15 ms, looking up by more). The shell column is the cloud shell alone with its own pattern (the volume off). In the other columns the shell draws the volume's clouds as its far layer; from 30 km up the volume is faded out and only the shell draws, at the cost of the pattern. Without a history (`history = false`) `'medium'` cost 0.2–1.5 ms more below 10 km in an earlier measurement.

| View | Shell | `'low'` | `'medium'` | `'high'` |
| --- | --- | --- | --- | --- |
| 3200 × 1800: orbit, 260 km | 0.9 ms | 1.0 ms | 1.0 ms | 1.0 ms |
| 150 km up | 1.1 ms | 1.1 ms | 1.1 ms | 1.1 ms |
| 30 km up | 0.8 ms | 0.9 ms | 0.8 ms | 0.9 ms |
| 20 km up | 1.1 ms | 1.1 ms | 1.1 ms | 1.2 ms |
| 8 km up, looking down | 0.9 ms | 0.9 ms | 1.1 ms | 1.3 ms |
| 2 km up, in the layer | 1.0 ms | 0.9 ms | 1.6 ms | 2.1 ms |
| On the ground, to the horizon | 0.1 ms | 0.7 ms | 0.9 ms | 1.2 ms |
| On the ground, looking up | 0.5 ms | 0.4 ms | 1.1 ms | 1.5 ms |
| 1600 × 900: orbit | 0.8 ms | 0.9 ms | 0.9 ms | 0.8 ms |
| 20 km up | 0.3 ms | 0.4 ms | 0.4 ms | 0.4 ms |
| 8 km up | 0.3 ms | 0.3 ms | 0.4 ms | 0.5 ms |
| 2 km up | 0.2 ms | 0.2 ms | 0.3 ms | 0.4 ms |
| To the horizon | 0.1 ms | 0.1 ms | 0.3 ms | 0.4 ms |

From orbit the shell costs nearly the same at both sizes: there its part of a frame does not grow with the pixels.

With a history, at 3200 × 1800 and 8 km up, about 0.3 ms is the depth copy, 0.35 ms the march of a quarter of the texels, 0.5 ms the accumulation and 0.3 ms the composite; the cloud shadow texture adds about 0.1 ms every fourth frame. The depth copy, the accumulation and the composite cost about the same at every quality, so `'low'` saves less than its smaller march would suggest; `scale` sets most of what remains.

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { CloudShellLayer, createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;
declare const shell: CloudShellLayer; // the far clouds over a sphere, added through engine.add

const engine = createEngine({ canvas, view: new PerspectiveOrbitRig(), palette: definePalette({ ground: '#4d4335' }), background: [0.6, 0.7, 0.8], sky: true, cloudShadows: true, cloudVolume: { quality: 'medium', baseM: 1200, topM: 3500 } });
engine.env.weather = { ...engine.env.weather, cloudCover: 0.45 };
if (engine.cloudVolume) {
  engine.cloudVolume.shell = shell; // the clouds from 20–40 km away, and all of them from 15–30 km up
  engine.cloudVolume.quality = { ...engine.cloudVolume.quality, lightSteps: 3 }; // at any time
}
```

`createEngine` keeps the layer after every layer added through `engine.add`, before the precipitation; `engine.moveCloudsBefore(layer)` puts it before `layer` (water, glass, the air shells of a planet) and keeps it there. `enabled = false` turns it off at run time and shows the shell in full. `noise` and `weather` are its noise volumes and cloud weather map.

## Fog

Fog is `weather.fog` inside a height layer, `env.fogLayer = { bottomY, topY }`. The default layer is 0 to 1 m, so set it when the scene is known (for example from the terrain's lowest and highest point). `applyFog(display, worldPos)` mixes the colour toward the fog colour by `fog × (0.5 + 0.38 × valley + 0.24 × (wisp − 0.5))`, at most 0.94:

- `valley` is 1 at `bottomY` and 0 from 80 % of the layer's height up, so fog gathers low.
- The wisps are value noise 140 m across, drifting at 0.4 times the cloud drift.
- The fog colour is light grey by day, dark blue at night and reddish at dusk, a little darker under overcast.
- Under radial up the heights are above the base sphere and the wisps are a field in space.

`applyFog` comes after `toDisplay`: it works on screen colours. It has no term for distance: a near and a far surface at the same height get the same fog. Distance comes from the sky's haze (`aerialPerspective`), which fog shortens, or from the atmosphere.

**Fog and the volumetric clouds.** The volume does not draw fog: its layer starts at `baseM`, and `weather.fog` reaches the clouds only through the haze at their mean distance (`aerialPerspective`). A cloud lying on a mountain is the terrain reaching into the layer, which the march handles. Fog as a low cloud would be a second, thin layer in the same march:

- the layer from the ground to `fogLayer.topY` (under radial up, heights above the base sphere), with the density `weather.fog` times an extinction of about 0.003 per metre (a visibility of about 1 km at full fog), thinning toward its top as `applyFog`'s valley term does and broken up by the shape volume at a scale of a few hundred metres;
- marched along the part of the ray in that layer, from the eye where the eye is in it, before the cloud layer and with the same scene depth, so it ends at the terrain;
- lit without samples toward the light: the sun share of the cloud shadows over the point times the sun through the fog above it, and the sky's light greyed by the overcast;
- kept in the same picture, history and composite as the clouds.

It is not part of the engine because the march then starts at the eye for every pixel that looks through fog, about the whole picture on the ground, which would roughly double the march's cost there and take `'medium'` over its budget on the ground. `applyFog` would also have to stay for materials on a flat world and without the volume, and the two would have to agree.

## Wind

`env.wind` (`WindConfig`) is `fromDeg`, where the wind blows from (0 from the north, 90 from the east), and `speedMs`. The default is 3 m/s from the west. The frame turns it into the direction it blows toward, `u_wind.xy`, and a gust wave: waves 70 m apart travelling with the wind at its speed (at least 0.5 m/s), `u_gust`.

What uses it:

| User | How |
| --- | --- |
| Clouds and their shadows | Drift with the wind at `speedFactor` times its speed. |
| Fog wisps | Drift at 0.4 times the cloud drift. |
| Rain and snow | Drift with the wind across the fall: rain a third of its speed (at most 4 m/s), snow 60 % (at most 2.5 m/s). |
| Trees (`gen-vegetation`) | `swaySlot` fills `u_wind.zw` with the bend of a tree top and the flutter of leaves in metres (0.075 m per m/s, at most 0.28 m, flutter a fifth of it); the tree shader bends along the wind and lets the gusts run through. |
| Your materials | Read `u_wind`, `u_gust` and `u_time.x`. |

`NearInstanceLayer` has a wind of its own (`layer.wind`), set by the app (see [Rendering](rendering.md)).

## Seasons and snow

The season and snow are slots of `gen-ground`, read by the terrain of `gen-ground` and the trees of `gen-vegetation`. The engine itself only carries the date and the snow cover.

- **`seasonSlot(phenology?)`** puts `u_season` into the Frame block: x broadleaf foliage (1 full, 0 bare), y autumn colour, z fresh spring green, w grass outside its growing season. It is a pure function of `env.dayOfYear` and a `PhenologyConfig` (`DEFAULT_PHENOLOGY`: Central European lowlands; leaf-out days 95–132, colour from 262, bare by 322). `seasonAt(dayOfYear, phenology)` gives the same four numbers on the CPU. The foliage changes how much light passes a canopy, so it is part of the shadow key: a new date redraws the shadow map.
- **`snowSlot()`** has no members. Its include `<snow>` gives `snowOn(worldPos, n, bias)`: 0–1 snow on a surface with normal `n`, from `weather.snowCover`. Snow lies only on surfaces that face up (by the local up under radial up), its edge follows world-anchored noise, and `bias` keeps it longer (positive, a roof) or shorter (negative, a road).
- **`windowLightSlot()`** (`gen-arch`) is the third content slot that follows the time: a glow from a sun height of 8° down to −4° and a share of lit windows by hour, in `u_time.zw`. Day mode only.

The vegetation shader reads `u_season`, `<snow>` and `u_wind.zw`: register `seasonSlot`, `snowSlot` and `swaySlot` together when you draw its trees ([gen-vegetation](generators.md#content-module-gen-vegetation)).

## Environment slots

A slot (`EnvSlot<P, V>` in `base`) is how content adds to the environment without the engine knowing about it:

| Field | Meaning |
| --- | --- |
| `name` | Unique. Also the name of its include. |
| `params` | Plain, mutable parameters. A change applies from the next frame. |
| `fields` | The vec4 members it declares (`member`, `order`, `lanes`, `doc`, `region`, default `'afterView'`), or lanes of a member another slot declares (no `order`). |
| `compute(env, params)` | A pure function of the generic `FrameEnvironment` and the params. |
| `lanes(values)` | The values as numbers, in the order of the fields' lanes. |
| `glsl` | Optional. Registered as `#include <name>`. |
| `shadowKey(values)` | Optional. Part of the shadow map's key: when it changes, the shadow map is redrawn. |

`assembleFrameBlock(slots)` puts `ENV_CORE_SLOT` first and sorts members by `order` within their region; equal orders go by member name. It throws on a duplicate slot name, a member declared twice, a lane filled twice, a field on a member nobody declares, and a member placed in another region. The block is fixed when the engine is created, so pass every slot to `createEngine({ slots })`. `engine.link.value(slot)` returns a slot's values for the last frame.

The slots of the engine and its content modules:

| Slot | From | Members (order) | Computed from |
| --- | --- | --- | --- |
| `sky` | `env`, `createEngine({ sky })` | `u_sky…` (1000–1070) | sky colours, sun and moon, cover, fog, precipitation, eye |
| `atmosphere` | `env`, `createEngine({ atmosphere })` | `u_atm…` (1100–1180) | sun direction, eye, its params |
| `cloudField` | `env`, `cloudFieldSlot` | `u_cloudField…` (1200–1240) | its params, the global cover |
| `cloudShadow` | `env`, `createEngine({ cloudShadows })` | `u_cloudShadow…` (1300–1340) | the light, the eye, the clouds' drift, the projection of the last draw |
| `season` | `gen-ground` | `u_season` (65) | day of year |
| `snow` | `gen-ground` | none, include `<snow>` | reads `u_weather.x` |
| `sway` | `gen-vegetation` | `u_wind.zw` | wind speed |
| `window-light` | `gen-arch` | `u_time.zw` | hour and sun height |

The engine's own members use the orders 10 to 90. Pick another order for yours (the minimal example's glow slot uses 100, the haze slot of [Recipes](recipes.md#add-an-environment-slot) 110).

A complete slot of your own: frost on cold mornings, in its own member, with a function for shaders.

```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import type { EnvSlot } from 'wallhammer-web/base';
import { createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;

export interface FrostParams {
  /** Days of the year between which frost may form, over the new year. */
  fromDay: number;
  toDay: number;
  /** Sun height in degrees at which the frost has gone. */
  goneAtDeg: number;
}

/** `u_frost.x`: frost 0–1 on surfaces that face up, before the morning sun and under a clear sky. */
export function frostSlot(params: Partial<FrostParams> = {}): EnvSlot<FrostParams, number> {
  return {
    name: 'frost',
    params: { fromDay: 300, toDay: 80, goneAtDeg: 15, ...params },
    fields: [{ member: 'u_frost', order: 120, lanes: 'x', doc: 'x frost 0–1' }],
    compute: (env, p) => {
      if (env.mode !== 'day') return 0;
      const season = env.dayOfYear >= p.fromDay || env.dayOfYear <= p.toDay ? 1 : 0;
      const morning = env.hour < 12 ? 1 - Math.min(1, Math.max(0, env.sunElevationDeg / p.goneAtDeg)) : 0;
      return season * morning * (1 - env.cloudCover) * (1 - env.wetness);
    },
    lanes: (v) => [v],
    glsl: `float frostOn(vec3 n) { return u_frost.x * smoothstep(0.5, 0.9, n.y); }`,
  };
}

const frost = frostSlot();
const engine = createEngine({
  canvas,
  view: new PerspectiveOrbitRig(),
  palette: definePalette({ ground: '#4d4335' }),
  background: [0.6, 0.7, 0.8],
  environment: { mode: 'day', hour: 7.5, site: { dayOfYear: 20 } },
  slots: [frost],
});
// In a material: #include <frost> after <lighting>, then albedo = mix(albedo, vec3(0.85), frostOn(n));
engine.start();
console.log(engine.link.value(frost)); // undefined before the first frame
```

## Shaders

A material reads the environment through includes. They do not nest, so list them in this order:

| Include | Gives |
| --- | --- |
| `header` | The `Frame` block with every member above, `localUp`, `localHeight`, `localFrame`, the pixel size helpers. |
| `noise` | `vnoise`, `vnoise3` and the hashes; `<lighting>` and `<shadow>` need it. |
| `lighting` | The sun visibility of `<shadow>`, plus `lightOn`, `lightOnAt`, `applyFog`, `toDisplay`. |
| `shadow` | Only the sun visibility, for a material with its own light model. Guarded, so it combines with `<lighting>`. |
| `sky` or `atmosphere` | `aerialPerspective`, `skyColorDir`, `skyToEye`; or `atmosphereAir`, `atmosphereApply`, `atmosphereLight`, `atmosphereSun`. Stand-ins when the slot is missing. |
| a slot's name | Its `glsl`, for example `<snow>`. |

The functions:

| Function | Returns |
| --- | --- |
| `sunVisibility(worldPos, n, offsetTexels)` | Share of the direct sun, 0–1: the shadow map (4 × 4 filtered) times `cloudLight`. The point is moved along the normal by `offsetTexels` shadow texels first. `sunVisibilitySharp`, `sunVisibilityBaked(…, baked)` and `sunVisibilityBakedSharp` are the variants of [Shadow modes](rendering.md#shadow-modes). |
| `cloudLight(worldPos)` | The cloud shadow alone. |
| `lightOn(n, sun, ao)` | The light as a multiple of the surface colour: `u_sunColor × max(n · sun direction, 0) × sun + (u_ambient + u_skyFill × (n.y × 0.5 + 0.5) + u_bounce × (1 − n.y)) × ao`. |
| `lightOnAt(worldPos, n, sun, ao)` | `lightOn` for the up of that point (under radial up the night side goes dark). |
| `toDisplay(c)` | Times the exposure (`u_warmTint.a`), then a soft knee above 0.8, so light surfaces do not burn out. |
| `applyFog(display, worldPos)` | The overcast's loss of saturation and the fog. On screen colours. |
| `aerialPerspective(display, worldPos)` | The haze toward the sky behind. On screen colours. |

The order in a fragment shader is: surface colour × `u_warmTint.rgb` × light, then `toDisplay`, then `applyFog`, then `aerialPerspective` (or `atmosphereApply`). A minimal material that is lit, shaded by clouds, fogged and hazed, with wet ground and snow by its own rule:

```ts
import { HEIGHT_FIELD_ATTRIBS } from 'wallhammer-web';
import type { MaterialDesc } from 'wallhammer-web/base';

export const GROUND: MaterialDesc = {
  name: 'ground',
  attribs: HEIGHT_FIELD_ATTRIBS,
  passes: {
    shadow: 'depth',
    color: {
      vs: `#include <header>
in vec3 a_pos;
in vec4 a_normal;
out vec3 v_world;
out vec3 v_normal;
void main() {
  v_world = a_pos;
  v_normal = a_normal.xyz;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`,
      fs: `#include <header>
#include <noise>
#include <lighting>
#include <sky>
in vec3 v_world;
in vec3 v_normal;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 albedo = vec3(0.45, 0.47, 0.3);
  albedo *= 1.0 - 0.35 * u_weather.y;                                       // wet: darker
  albedo = mix(albedo, u_snow.rgb, u_weather.x * smoothstep(0.6, 0.9, n.y)); // snow on what faces up
  float sun = sunVisibility(v_world, n, 1.0);                               // shadow map × cloud shadow
  vec3 c = toDisplay(albedo * u_warmTint.rgb * lightOn(n, sun, 1.0));
  o_color = vec4(aerialPerspective(applyFog(c, v_world), v_world), 1.0);
}`,
    },
  },
};
```

With the atmosphere, light with `atmosphereLight` and take the air at the vertices; [The atmosphere](rendering.md#the-atmosphere) has that shader.

## Recipes

**Turn on the sky.** `createEngine({ …, sky: true })`, or `sky: { hazeDistanceM: 900, cloudHeightM: 1000 }`. Use a perspective view, and end every material with `aerialPerspective(…)`. Set the haze to a distance at which the far edge of your scene should be mostly gone.

**Set the hour and the date.** `environment: { mode: 'day', hour: 18.5, site: { latitudeDeg: 51, longitudeDeg: 0, dayOfYear: 250, utcOffsetHours: 0 } }`. Later: `env.day.set(7)`, `env.setDate(dayOfYear(3, 21))`, `env.day.play()` to let the day run at `hoursPerSecond`.

**Make it rain.**

<!-- check: wrap -->
```ts
import { DEFAULT_WEATHER } from 'wallhammer-web/env';
import { createEngine } from 'wallhammer-web/runtime';
import type { EngineOptions, EngineView } from 'wallhammer-web/runtime';
declare const options: EngineOptions<EngineView>;

const engine = createEngine({ ...options, precipitation: true, sky: true });
engine.env.weather = { ...DEFAULT_WEATHER, cloudCover: 0.8, precipitation: 0.7, precipitationKind: 'rain', wetness: 0.8, fog: 0.25 };
engine.env.wind = { fromDeg: 230, speedMs: 5 }; // slanted rain
```

For snow: `precipitationKind: 'snow'`, `snowCover: 0.8`, `wetness: 0`, and `snowSlot()` (or the material's own rule) to show it lying.

**Overcast with cloud shadows.** Cloud shadows are strongest round a cover of 0.55 and gone at 1. For a heavy sky that still has moving shadows take 0.5–0.65 and raise `clouds.darkness` (for example 0.45). For a flat grey day without shadows take 0.9–1.

**A season.** Register `seasonSlot()` (and `snowSlot()`, `swaySlot()` for trees); then the date alone moves the foliage.

<!-- check: wrap -->
```ts
import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { dayOfYear } from 'wallhammer-web/env';
import { seasonAt, seasonSlot, snowSlot } from 'wallhammer-web/gen-ground';
import { swaySlot } from 'wallhammer-web/gen-vegetation';
import { createEngine } from 'wallhammer-web/runtime';
declare const canvas: HTMLCanvasElement;

const season = seasonSlot({ colorStart: 250, colorPeak: 285 }); // an earlier autumn than the default
const engine = createEngine({
  canvas,
  view: new PerspectiveOrbitRig(),
  palette: definePalette({ ground: '#4d4335' }),
  background: [0.6, 0.7, 0.8],
  environment: { mode: 'day', hour: 14 },
  slots: [season, snowSlot(), swaySlot()],
});
engine.env.setDate(dayOfYear(10, 20)); // 20 October: the sun's path and the foliage move together
console.log(seasonAt(engine.env.dayOfYear, season.params)); // { leafDensity, autumn, fresh, dormancy }
```

## Limits

- **No weather model.** The weather is six numbers the app sets. There are no fronts and no transitions unless the app writes them; the ground follows the precipitation only through `weatherGround`, one value for the whole scene.
- **Flat clouds without `cloudVolume`.** The sky's deck and the cloud shell are a noise pattern on a plane or a shell, with no thickness, no light through them and no shadows on each other (with `cloudVolume` under radial up the shell draws the volume's clouds).
- **Volumetric clouds.** One layer of clouds between two heights: heaped clouds, a flat deck and tall raining clouds that reach the layer's top, no other types (no cirrus, no anvils above the layer, no light shafts, no fog). Rain shafts are drawn only with the eye under the base, not from above it and not in the cloud shell. The first second of a still view, and thin edges while the eye moves, keep a trace of the samples' jitter; a frame that reveals much new sky is softer for a few frames. The scene inside the layer is the last frame's: something that moves fast through a cloud lags it by a frame. Without a readable depth (the standard depth mode drawing into the canvas with one sample) the march ignores the terrain. Beyond the cloud shadow texture's square (24 cloud sizes) the shadows come from the cloud pattern. Under radial up the cloud shell draws the volume's clouds with five samples a pixel and no light samples: from 20 to 40 km away and from 15 km up they lose their fine shape and their self-shadowing, which shows on large heaped clouds lit from the side; near the terminator their tops keep the red of a low sun over a wider band than the pattern did. On a flat world the volume and the cloud shell are different clouds and between 15 and 30 km one fades into the other. The rain stops under a gap only by the column straight over the eye: the drops round the eye fall or stop all at once; the rain under the clouds around shows only as the shafts.
- **The cloud shadow texture is one square.** It reaches 24 cloud sizes around the eye; beyond, the shadows are computed per fragment. A low sun stretches its texels along the ground. Its shadow is that of a thin layer where the light meets the base surface, not of a body of cloud.
- **Two cloud worlds.** On a flat world the cover is one number. A cover by place needs radial up; its clouds are the cloud shell or the volumetric clouds, while the sky layer draws only the flat deck.
- **The cloud pattern follows wind × time.** A change of the wind's direction or speed moves the whole cloud pattern (and the fog wisps) at once, by the new wind times the time elapsed.
- **The moon stands still.** It has no path and no phase, shines only in day mode and is not drawn by the atmosphere.
- **Fog by height only.** `applyFog` has no distance term and no light in it (no shafts, no glow round lamps). Distance comes from the haze or the atmosphere.
- **The atmosphere sees little of the weather.** Only the cloud cover over the eye changes it (the overcast: one value for the whole picture, see [Weather](#weather)); fog and precipitation do not. The cloud shadows reach `atmosphereLight` only through the `sun` share passed to it.
- **The sky assumes up along +y.** On a sphere use the atmosphere; without it a sphere has a plain background.
- **Precipitation knows no roof.** The drops end at whatever is in front of them and the marks lie only on surfaces that face up, but under a roof or a tree it still rains: nothing yet tells the drops where the sky is covered (a height map of covers over the eye would, read in the vertex shader like the depth). Drops cast nothing and reach about 60 m from the eye; seen from high above, the rain is only round the eye. In an orthographic view and with `look: 'screen'` it is the pattern over the image.
- **One wind.** The same vector everywhere; terrain does not bend it.
- **One climate of seasons.** The phenology is one table by day of year. It does not follow latitude or the hemisphere.
- **Shadows and time.** A running day clock moves the sun every frame, and every new light direction redraws the shadow map. So does every new date with `seasonSlot`.
- **Not physically based.** The light is colours as multiples of the surface colour with a soft knee, tuned by eye. Only the atmosphere models real air.
- **Allocation.** `Environment.frame` and the slots' `pack` allocate a little every frame.

## See it live

Every example runs at <https://freema.github.io/wallhammer-web/>. Their URL hash sets the time and the weather:

| Link | What to look at |
| --- | --- |
| [minimal-3d, rain at dusk](https://freema.github.io/wallhammer-web/minimal-3d/#hour=18.5&day=250&w=rain) | The sky, the haze, rain, the moon low in the south and the example's own glow slot. `w` is `clear`, `clouds`, `rain`, `snow` or `fog`; `[` and `]` move the hour, space runs the day. |
| [minimal-3d, fog](https://freema.github.io/wallhammer-web/minimal-3d/#hour=8&w=fog) | Fog gathering in the low ground of the island. |
| [endless, snow](https://freema.github.io/wallhammer-web/endless/#hour=15&w=snow) | The same weather presets over a large streamed landscape: clouds 2.4 km across, haze at 7 km. |
| [destruction, rain](https://freema.github.io/wallhammer-web/destruction/#hour=14&day=250&w=rain) | `snowSlot` and `windowLightSlot` on generated buildings; try `w=snow` and `hour=21`. |
| [fantasy-village, evening](https://freema.github.io/wallhammer-web/fantasy-village/#e=1) | Late light at 18:33 with lit windows and lanterns; `E` switches to the afternoon (16:24) and back. The cloud shadows come from the texture; `#cs=0` computes them per fragment. |
| [outpost](https://freema.github.io/wallhammer-web/outpost/) | A fixed light (`mode: 'fixed'`) without weather. |
| [planet](https://freema.github.io/wallhammer-web/planet/) | The atmosphere and the volumetric clouds from the ground to orbit, over a cover by place; `#fly=1` starts the flight, `#atm=ref` the reference quality of the air, `#vol=0` keeps the cloud shell alone, `#clouds=0` builds the page without clouds. |
| [planet, rain](https://freema.github.io/wallhammer-web/planet/#view=clouds-rain) | Under a raining deck: overcast light with the atmosphere, rain shafts, rain only under the cloud. |
| [planet, under water](https://freema.github.io/wallhammer-web/planet/#view=underwater) | The [medium below a level](rendering.md#a-medium-below-a-level) from inside, under a [surface of waves](rendering.md#a-moving-surface-of-waves); `#view=sea-above` and `#view=sea-crossing` show it from above and at the waterline. |
| [planet, movie](https://freema.github.io/wallhammer-web/planet/#movie=1) | The movie mode: a hands-off show of the planet in several shots. |
| [endless](https://freema.github.io/wallhammer-web/endless/#hour=15&w=clouds) | Volumetric clouds and their shadows over a flat streamed landscape, on by default; `#vol=0` goes back to the flat deck. |
| [endless, sphere with air](https://freema.github.io/wallhammer-web/endless/sphere.html#atm=1) | The atmosphere and `Environment.observer` on a sphere of 100 km; `[` and `]` move the sun. |
| [system, clouds of Hearth](https://freema.github.io/wallhammer-web/system/#body=Hearth&alt=8000&pitch=28) | The cloud cover by place, the volumetric clouds with the cloud shell as their far layer, and their shadows from a texture; `&volume=0` keeps the cloud shell alone. Add `&cover=0.8` for one closed deck over the whole planet (rain from 0.6), `&clouds=0` to hide the clouds; `C` toggles them. Whether the place is in daylight depends on the time of the system, `t`. |
