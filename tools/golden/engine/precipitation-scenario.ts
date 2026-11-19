// Golden scenario of the precipitation model (env/precipitation.ts): the fall vector on flat and radial ground with
// and without wind, the drops of the visible tiles at three eyes and two times (they belong to the world: a drop is at
// the same world place whichever eye sees it), the landing marks over a patch of ground (the same after a move by the
// period), and the ground that follows the weather (`weatherGround`). Throws when an invariant breaks.

import {
  PRECIPITATION_GLSL,
  PRECIPITATION_IMPACT_PERIOD_M,
  RAIN_FALL,
  RAIN_RINGS,
  RAIN_SHELLS,
  RAIN_SPLASHES,
  SNOW_FALL,
  SNOW_SHELLS,
  SNOW_SPECKS,
  precipitationClock,
  precipitationCount,
  precipitationDown,
  precipitationDrop,
  precipitationEyeOffset,
  precipitationImpactAt,
  precipitationImpactClock,
  precipitationTiles,
  precipitationVelocity,
  weatherGround,
} from '../../../packages/wallhammer-web/src/env/index.ts';
import type { PrecipitationFall, PrecipitationShell, WeatherState } from '../../../packages/wallhammer-web/src/env/index.ts';
import type { Vec3 } from '../../../packages/wallhammer-web/src/base/index.ts';

const micro = (v: number): number => Math.round(v * 1e6);

export function precipitationScript(): unknown[] {
  const out: unknown[] = [PRECIPITATION_GLSL];

  // The fall: along the local down at the kind's speed, the drift across it within its limit.
  const center: Vec3 = [0, -6_000_000, 0];
  for (const fall of [RAIN_FALL, SNOW_FALL]) {
    for (const eye of [[0, 2, 0], [4_000_000, 1_000_000, -2_500_000]] as Vec3[]) {
      const down = precipitationDown(eye, eye[0] === 0 ? null : center);
      for (const wind of [0, 3, 30]) {
        const v = precipitationVelocity(fall, down, 0.6, 0.8, wind);
        const along = v[0] * down[0] + v[1] * down[1] + v[2] * down[2];
        const across = Math.hypot(v[0] - down[0] * along, v[1] - down[1] * along, v[2] - down[2] * along);
        if (Math.abs(along - fall.fallMs) > 1e-9) throw new Error('precipitation: the fall along down is not the kind\'s speed');
        if (across > fall.maxDriftMs + 1e-9) throw new Error('precipitation: the drift is past its limit');
        out.push(...v.map(micro));
      }
    }
  }

  // Counts: none without strength, the shell's own at full strength, the density scales.
  for (const s of [-1, 0, 0.004, 0.5, 1, 2]) for (const d of [0, 0.5, 1, 2]) out.push(micro(precipitationCount(RAIN_SHELLS[0]!, s, d)));

  // Drops: the same world place from three eyes (a move of 0.5 m and of 5 m), no tile past the range, nearest first.
  const cases: [PrecipitationFall, readonly PrecipitationShell[]][] = [[RAIN_FALL, RAIN_SHELLS], [SNOW_FALL, SNOW_SHELLS]];
  for (const [fall, shells] of cases) {
    const v = precipitationVelocity(fall, [0, -1, 0], 1, 0, 6);
    for (const shell of shells) {
      for (const time of [100.37, 100.52, 86_400.01]) {
        const clock = precipitationClock(time, fall.lifeS);
        const count = precipitationCount(shell, 0.7);
        const seen = new Map<string, Vec3>();
        let moved = 0;
        for (const eye of [[1000.25, 3.7, -2000.5], [1000.75, 3.7, -2000.5], [1005.25, 4.2, -2003.5]] as Vec3[]) {
          const tiles = precipitationTiles(shell, fall, v, eye);
          if (tiles.length === 0 || tiles.length % 4) throw new Error('precipitation: no visible tile');
          const reach = 0.5 * fall.lifeS * Math.hypot(v[0], v[1], v[2]) + fall.swayM;
          let last = -1;
          for (let t = 0; t < tiles.length; t += 4) {
            const corner: Vec3 = [tiles[t]! + eye[0], tiles[t + 1]! + eye[1], tiles[t + 2]! + eye[2]];
            // Distance from the eye to the tile grown by the reach of a life: within the range, never decreasing.
            let dd = 0;
            for (let j = 0; j < 3; j++) {
              const lo = tiles[t + j]! - reach, hi = tiles[t + j]! + shell.tileM + reach;
              const g = lo > 0 ? lo : hi < 0 ? -hi : 0;
              dd += g * g;
            }
            const d = Math.sqrt(dd);
            if (d > shell.farM[1] + 1e-9) throw new Error('precipitation: a tile past the range');
            if (d < last - 1e-9) throw new Error('precipitation: the tiles are not nearest first');
            last = d;
            const tile = [tiles[t]!, tiles[t + 1]!, tiles[t + 2]!, tiles[t + 3]!] as const;
            for (let i = 0; i < 64; i += 7) {
              const drop = precipitationDrop(i, tile, shell, fall, v, clock, count);
              const world: Vec3 = [drop.rel[0] + eye[0], drop.rel[1] + eye[1], drop.rel[2] + eye[2]];
              const key = `${corner.map((c) => Math.round(c)).join(',')}#${i}`;
              const before = seen.get(key);
              if (before) {
                if (Math.hypot(world[0] - before[0], world[1] - before[1], world[2] - before[2]) > 1e-6) throw new Error('precipitation: a drop moved with the eye');
                moved++;
              } else seen.set(key, world);
              if (!(drop.alpha >= 0 && drop.alpha <= 1) || !(drop.age >= 0 && drop.age < 1)) throw new Error('precipitation: alpha or age outside 0–1');
            }
          }
        }
        if (moved === 0) throw new Error('precipitation: the eyes share no tile');
        const keys = [...seen.keys()].sort();
        for (const k of keys.slice(0, 40)) out.push(k, ...seen.get(k)!.map(micro));
        out.push(seen.size, moved);
      }
    }
  }

  // Within one life a drop moves by the velocity times the time.
  {
    const shell = RAIN_SHELLS[0]!;
    const v = precipitationVelocity(RAIN_FALL, [0, -1, 0], 0, 1, 4);
    const tile = [-4, -2, 3, 12345] as const;
    for (let i = 0; i < 32; i++) {
      const a = precipitationDrop(i, tile, shell, RAIN_FALL, v, precipitationClock(50, RAIN_FALL.lifeS), 4096);
      const dt = 0.01;
      const b = precipitationDrop(i, tile, shell, RAIN_FALL, v, precipitationClock(50 + dt, RAIN_FALL.lifeS), 4096);
      if (b.age > a.age) {
        for (let j = 0; j < 3; j++) if (Math.abs(b.rel[j]! - a.rel[j]! - v[j]! * dt) > 1e-6) throw new Error('precipitation: a drop does not move with the velocity');
      }
      out.push(micro(a.age), ...a.rel.map(micro));
    }
  }

  // Landing marks over a patch: the same after a move of the eye by the period; counted per kind.
  for (const impact of [RAIN_SPLASHES, RAIN_RINGS, SNOW_SPECKS]) {
    for (const time of [100.37, 100.61, 7_200.2]) {
      const clock = precipitationImpactClock(impact, time);
      let marks = 0;
      const row: number[] = [];
      for (const [e, eye] of ([[12.3, 0, -40.7], [12.3 + PRECIPITATION_IMPACT_PERIOD_M, 0, -40.7 - 3 * PRECIPITATION_IMPACT_PERIOD_M]] as Vec3[]).entries()) {
        const off = precipitationEyeOffset(eye, PRECIPITATION_IMPACT_PERIOD_M);
        let n = 0;
        for (let i = 0; i < 219; i++) {
          for (let j = 0; j < 81; j++) {
            const m = precipitationImpactAt(impact, off[0] + i * 0.0137, off[2] + j * 0.0371, [0, 0, 1], clock, 0.8);
            if (m && m.distanceM < impact.radiusM) {
              n++;
              if (e === 0 && row.length < 60) row.push(micro(m.age), micro(m.distanceM), micro(m.weight));
            }
          }
        }
        if (marks && n !== marks) throw new Error('precipitation: the marks change with a move by the period');
        marks = n;
      }
      if (marks === 0) throw new Error('precipitation: no landing mark');
      out.push(marks, ...row);
    }
    // No strength, no mark.
    const clock = precipitationImpactClock(impact, 100.37);
    for (let a = 0; a < 2; a += 0.05) if (precipitationImpactAt(impact, a, 0.3, [0, 0, 1], clock, 0)) throw new Error('precipitation: a mark without precipitation');
  }

  // The ground that follows the weather: covered by heavy snow within a few minutes, wet within half a minute of rain,
  // dry again after a few minutes; the input is left as it was.
  const clear: WeatherState = { cloudCover: 0.3, fog: 0, precipitation: 0, precipitationKind: 'rain', snowCover: 0, wetness: 0 };
  const snow: WeatherState = { ...clear, precipitation: 1, precipitationKind: 'snow' };
  const rain: WeatherState = { ...clear, precipitation: 1, precipitationKind: 'rain' };
  let w: WeatherState = { ...snow };
  const track: number[] = [];
  const step = (base: WeatherState, seconds: number): void => {
    for (let t = 0; t < seconds; t += 0.5) {
      const next = weatherGround({ ...base, snowCover: w.snowCover, wetness: w.wetness }, 0.5);
      if (next.snowCover < 0 || next.snowCover > 1 || next.wetness < 0 || next.wetness > 1) throw new Error('weatherGround: outside 0–1');
      w = next;
    }
    track.push(micro(w.snowCover), micro(w.wetness));
  };
  step(snow, 60);
  step(snow, 150);
  if (w.snowCover < 0.99) throw new Error('weatherGround: heavy snow does not cover the ground within a few minutes');
  step(rain, 30);
  if (w.wetness < 0.99) throw new Error('weatherGround: rain does not wet the ground within half a minute');
  step(clear, 300);
  if (w.wetness > 0.01) throw new Error('weatherGround: the ground does not dry within a few minutes');
  step({ ...clear }, 10);
  const thaw = weatherGround({ ...clear, snowCover: 0.5, wetness: 0 }, 10, { thawPerS: 0.01 });
  track.push(micro(thaw.snowCover), micro(thaw.wetness));
  const input = { ...rain, snowCover: 0.4, wetness: 0.2 };
  const copy = JSON.stringify(input);
  weatherGround(input, 5);
  if (JSON.stringify(input) !== copy) throw new Error('weatherGround: the input changed');
  if (JSON.stringify(weatherGround(input, -3)) !== JSON.stringify({ ...input })) throw new Error('weatherGround: a negative step changed the weather');
  out.push(...track);
  return out;
}
