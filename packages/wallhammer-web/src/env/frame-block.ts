// Assembles the environment's part of the Frame block from slots: the engine's own slot (`ENV_CORE_SLOT`) first, then
// the registered slots in the given order. Members are sorted by their `order` within each region, so the layout does
// not depend on registration order. Each frame, every slot computes its values from the generic environment and
// writes them into its lanes.

import type { EnvSlot, FrameEnvironment, FrameRegion } from '../base/env-slot.ts';

const LANES = 'xyzw';
const REGIONS: readonly FrameRegion[] = ['afterLight', 'afterView'];

/** The engine's members: light colours, time, wind, clouds, weather, fog and snow colour. */
export const ENV_CORE_SLOT: EnvSlot<null, FrameEnvironment> = {
  name: 'env',
  params: null,
  fields: [
    { member: 'u_sunColor', order: 10, lanes: 'xyz', doc: '', region: 'afterLight' },
    { member: 'u_ambient', order: 20, lanes: 'xyz', doc: '', region: 'afterLight' },
    { member: 'u_skyFill', order: 30, lanes: 'xyz', doc: '', region: 'afterLight' },
    { member: 'u_bounce', order: 40, lanes: 'xyz', doc: 'warm bounce from the ground', region: 'afterLight' },
    { member: 'u_warmTint', order: 50, lanes: 'xyzw', doc: 'rgb surface colour shift, and exposure', region: 'afterLight' },
    { member: 'u_time', order: 10, lanes: 'xy', doc: 'x animation time in seconds, y hour of day' },
    { member: 'u_wind', order: 20, lanes: 'xy', doc: 'xy direction the wind blows toward (x, z)' },
    { member: 'u_gust', order: 30, lanes: 'xy', doc: 'x 2π / gust length, y gust speed in m/s' },
    { member: 'u_cloud', order: 40, lanes: 'xyzw', doc: 'xy cloud pattern offset in metres, z darkening under a cloud 0–1, w 1 / cloud size' },
    { member: 'u_cloudEdge', order: 50, lanes: 'xy', doc: 'x, y noise thresholds between which the cloud shadow fades in' },
    { member: 'u_weather', order: 60, lanes: 'xyzw', doc: 'x snow cover, y wetness, z fog, w precipitation strength (all 0–1)' },
    { member: 'u_fogColor', order: 70, lanes: 'xyzw', doc: 'rgb fog colour in screen space, w precipitation kind (0 rain, 1 snow)' },
    { member: 'u_snow', order: 80, lanes: 'xyzw', doc: 'rgb snow albedo, w cloud cover' },
    { member: 'u_fogShape', order: 90, lanes: 'xyz', doc: 'x fog layer floor height, y 1 / fog layer height, z day of year' },
  ],
  compute: (env) => env,
  lanes: (E) => [
    ...E.sun,
    ...E.ambient,
    ...E.skyFill,
    ...E.bounce,
    ...E.warmTint,
    E.exposure,
    E.time,
    E.hour,
    E.windX,
    E.windZ,
    (2 * Math.PI) / E.gustLengthM,
    E.gustSpeed,
    E.cloudX,
    E.cloudZ,
    E.cloudDarkness,
    1 / E.cloudSizeM,
    E.cloudLo,
    E.cloudHi,
    E.snowCover,
    E.wetness,
    E.fog,
    E.precipitation,
    ...E.fogColor,
    E.precipitationKind,
    ...E.snowAlbedo,
    E.cloudCover,
    E.fogLayer.bottomY,
    1 / Math.max(1, (E.fogLayer.topY - E.fogLayer.bottomY) * 0.8),
    E.dayOfYear,
  ],
};

/** Float buffers of the two regions, as `Renderer.frameSlots` holds them. */
export interface FrameRegions {
  afterLight: Float32Array;
  afterView: Float32Array;
}

/** Result of one frame: each slot's values (by slot) and the combined shadow key. */
export interface FrameBlockValues {
  values: Map<EnvSlot<any, any>, unknown>;
  shadowKey: string;
}

/** The assembled block. Pass it as `RendererOptions.frameSlots` and to `EnvironmentLink`. */
export interface EnvFrameBlock {
  /** Number of vec4 members per region. */
  afterLight: number;
  afterView: number;
  /** GLSL member declarations per region. */
  glsl: { afterLight: string; afterView: string };
  /** All slots, the engine's own first. */
  slots: readonly EnvSlot<any, any>[];
  /** Computes every slot for one frame and writes the lanes into `out`. */
  pack(env: FrameEnvironment, out: FrameRegions): FrameBlockValues;
}

interface Member {
  name: string;
  region: FrameRegion;
  order: number;
  docs: { lane: number; doc: string }[];
  used: boolean[];
  index: number;
}

export function assembleFrameBlock(slots: readonly EnvSlot<any, any>[] = []): EnvFrameBlock {
  const all = [ENV_CORE_SLOT as EnvSlot<any, any>, ...slots];
  const names = new Set<string>();
  for (const s of all) {
    if (names.has(s.name)) throw new Error(`Two environment slots are named "${s.name}"`);
    names.add(s.name);
  }
  // Members: declared by the field that gives `order`.
  const members = new Map<string, Member>();
  for (const s of all) {
    for (const f of s.fields) {
      if (f.order === undefined) continue;
      if (members.has(f.member)) throw new Error(`Frame member ${f.member} is declared twice (slot "${s.name}")`);
      members.set(f.member, { name: f.member, region: f.region ?? 'afterView', order: f.order, docs: [], used: [false, false, false, false], index: 0 });
    }
  }
  const sizes = { afterLight: 0, afterView: 0 };
  const glsl = { afterLight: '', afterView: '' };
  const sorted = [...members.values()].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Lane offsets of every slot, in field order.
  const offsets: { region: FrameRegion; at: number }[][] = [];
  for (const s of all) {
    const list: { region: FrameRegion; at: number }[] = [];
    for (const f of s.fields) {
      const m = members.get(f.member);
      if (!m) throw new Error(`Slot "${s.name}" writes to frame member ${f.member}, which no slot declares (give it an order)`);
      if (f.region !== undefined && f.region !== m.region) throw new Error(`Slot "${s.name}" places ${f.member} in another region`);
      for (const ch of f.lanes) {
        const lane = LANES.indexOf(ch);
        if (lane < 0) throw new Error(`Slot "${s.name}": unknown lane "${ch}" in ${f.member}`);
        if (m.used[lane]) throw new Error(`Slot "${s.name}": lane ${f.member}.${ch} is already taken`);
        m.used[lane] = true;
        list.push({ region: m.region, at: lane });
      }
      if (f.doc) m.docs.push({ lane: LANES.indexOf(f.lanes[0]!), doc: f.doc });
    }
    offsets.push(list);
  }
  for (const region of REGIONS) {
    for (const m of sorted) {
      if (m.region !== region) continue;
      m.index = sizes[region]++;
      const doc = [...m.docs].sort((a, b) => a.lane - b.lane).map((d) => d.doc).join(', ');
      glsl[region] += `  ${`vec4 ${m.name};`.padEnd(18)}${doc ? `  // ${doc}` : ''}`.trimEnd() + '\n';
    }
  }
  // Resolve lane offsets to float positions now that member indices are known.
  for (let i = 0; i < all.length; i++) {
    const list = offsets[i]!;
    let j = 0;
    for (const f of all[i]!.fields) {
      const m = members.get(f.member)!;
      for (let c = 0; c < f.lanes.length; c++) list[j + c]!.at += m.index * 4;
      j += f.lanes.length;
    }
  }

  const values = new Map<EnvSlot<any, any>, unknown>();
  return {
    ...sizes,
    glsl,
    slots: all,
    pack(env, out) {
      values.clear();
      const keys: string[] = [];
      for (let i = 0; i < all.length; i++) {
        const s = all[i]!;
        const v = s.compute(env, s.params);
        values.set(s, v);
        const list = offsets[i]!;
        if (list.length > 0) {
          const lanes = s.lanes(v);
          if (lanes.length !== list.length) throw new Error(`Slot "${s.name}" gave ${lanes.length} lanes, its fields have ${list.length}`);
          for (let j = 0; j < list.length; j++) out[list[j]!.region][list[j]!.at] = lanes[j]!;
        }
        if (s.shadowKey) keys.push(s.shadowKey(v));
      }
      return { values, shadowKey: keys.join('|') };
    },
  };
}
