// Frame profile: what a frame costs on the graphics card at hand, as numbers. Renders the current view synchronously,
// waits for the graphics after every frame (`Device.finish`) and takes the median frame time of several measurements:
// the empty frame, the frame with the shadow map kept, the frame with the shadow map redrawn, optionally the animated
// frame, and per layer the same frames without that layer (`Renderer.probe`). A layer's cost is the difference.
// Nothing here runs outside a profile; the renderer's normal frame is unchanged.

import type { View } from '../base/view.ts';
import type { FrameStats, Layer, PassName, Renderer } from '../render/index.ts';

export interface ProfileOptions {
  /** Measured frames per measurement (each preceded by two warm-up frames). Default 20. */
  frames?: number;
  /** Measure the cost of every layer: two measurements per layer. Default true. */
  layers?: boolean;
  /**
   * Advances the scene by one frame (clocks, animation, layer data) right before a render. When given, the profile
   * also measures `running`: frames while the scene moves, with whatever shadow updates that causes. Its time is
   * part of the measured frame. The other measurements do not call it and render the scene as it stands.
   */
  step?: (index: number) => void;
}

/** Times of one measurement, ms per frame, each frame rendered and waited for. */
export interface FrameTiming {
  /** Median frame time. */
  ms: number;
  /** Interquartile range: a difference below it is noise. */
  spreadMs: number;
  minMs: number;
  maxMs: number;
  /** Measured frames that drew into the shadow map (`FrameStats.shadowUpdates` > 0). */
  shadowFrames: number;
  /** Mean processor time of `Renderer.render` per frame (`FrameStats.cpuMs`). */
  cpuMs: number;
}

/** What a layer does in one group of passes and what it costs there. */
export interface PassCost {
  /** Triangles and calls the layer counted in one frame. */
  triangles: number;
  drawCalls: number;
  /** Frame time with the layer minus frame time without it, ms. Null when layers were not measured (`ProfileOptions.layers`). */
  ms: number | null;
}

export interface LayerProfile {
  /** Position in `Renderer.layers` (the drawing order). */
  index: number;
  /** `Layer.name`, else the class name with the material name when there is one. */
  name: string;
  /** Passes in which the layer counted at least one call (a layer that never calls `DrawContext.count` has none). */
  passes: PassName[];
  /** The main passes (`color` and `overlay`, or `data`), measured with the shadow map kept; includes `prepare`. */
  color: PassCost;
  /** The shadow pass, measured with the shadow map redrawn in every frame. */
  shadow: PassCost;
}

export interface FrameProfile {
  /** Graphics device as the browser names it. */
  gpu: string;
  /** Main target in physical pixels and the physical pixels per CSS pixel. */
  width: number;
  height: number;
  dpr: number;
  /** Samples per pixel of the main target (0: no antialiasing). */
  samples: number;
  /** Edge of the shadow map texture and the part of it the fitted map used, pixels. */
  shadowMapEdgePx: number;
  shadowMapPx: number;
  frames: number;
  /** Time of `Device.finish` with nothing pending: contained in every frame time below. */
  syncMs: number;
  /** Only clearing and presenting the main target (no scene; `shadowFrames` and `cpuMs` are 0). */
  empty: FrameTiming;
  /** The current frame, shadow map kept as the renderer keeps it (redrawn only when the scene asks for it). */
  kept: FrameTiming;
  /** The current frame with the shadow map redrawn in every frame. */
  shadow: FrameTiming;
  /** Frames while `step` advances the scene; null without `step`. */
  running: FrameTiming | null;
  /** Statistics of one frame with the shadow map redrawn (main and shadow counts). */
  stats: FrameStats;
  /** One entry per layer in drawing order (empty when layers were not measured and counted). */
  layers: LayerProfile[];
  /** Wall time the whole profile took, ms. */
  profileMs: number;
}

const WARMUP_FRAMES = 2;

/**
 * Measures the current frame of `renderer` from `view` (synchronous; the page is blocked meanwhile, about
 * `frames × (3 + 2 × layers)` frames). Leaves the renderer as it was, with the shadow map marked for a redraw.
 * Throws while the graphics context is lost.
 */
export function profileFrame(renderer: Renderer, view: View, options: ProfileOptions = {}): FrameProfile {
  const device = renderer.device;
  if (device.lost) throw new Error('profileFrame: the graphics context is lost');
  const frames = Math.max(1, Math.round(options.frames ?? 20));
  const started = performance.now();
  const wall = new Float64Array(frames);

  const measure = (forceShadow: boolean, step: ((index: number) => void) | null): FrameTiming => {
    renderer.invalidateShadows();
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      if (forceShadow) renderer.invalidateShadows();
      renderer.render(view);
    }
    device.finish();
    let shadowFrames = 0;
    let cpu = 0;
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      step?.(i);
      if (forceShadow) renderer.invalidateShadows();
      const st = renderer.render(view);
      device.finish();
      wall[i] = performance.now() - t0;
      if (st.shadowUpdates > 0) shadowFrames++;
      cpu += st.cpuMs;
    }
    return timing(wall, shadowFrames, cpu / frames);
  };

  const savedProbe = renderer.probe;
  const savedBounds = renderer.bounds;
  try {
    // The cost of the wait itself, with nothing pending.
    device.finish();
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      device.finish();
      wall[i] = performance.now() - t0;
    }
    const syncMs = timing(wall, 0, 0).ms;

    renderer.probe = null;
    renderer.bounds = null;
    // Without bounds the renderer only clears and presents; its statistics are those of the last real frame.
    const empty = { ...measure(false, null), shadowFrames: 0, cpuMs: 0 };
    renderer.bounds = savedBounds;

    // Counts per layer and pass from one frame with the shadow map redrawn.
    const counts = new Map<Layer, Map<PassName, { triangles: number; calls: number }>>();
    renderer.probe = {
      drawn(layer, pass, triangles, calls): void {
        let byPass = counts.get(layer);
        if (!byPass) counts.set(layer, (byPass = new Map()));
        const c = byPass.get(pass) ?? { triangles: 0, calls: 0 };
        c.triangles += triangles;
        c.calls += calls;
        byPass.set(pass, c);
      },
    };
    renderer.invalidateShadows();
    const stats = { ...renderer.render(view) };
    renderer.probe = null;

    const kept = measure(false, null);
    const shadow = measure(true, null);
    const running = options.step ? measure(false, options.step) : null;

    const layers: LayerProfile[] = [];
    const measureLayers = options.layers ?? true;
    renderer.layers.forEach((layer, index) => {
      const byPass = counts.get(layer);
      const passes: PassName[] = [];
      const color = { triangles: 0, drawCalls: 0, ms: null as number | null };
      const shadowCost = { triangles: 0, drawCalls: 0, ms: null as number | null };
      for (const [pass, c] of byPass ?? []) {
        if (c.calls > 0) passes.push(pass);
        const into = pass === 'shadow' ? shadowCost : color;
        into.triangles += c.triangles;
        into.drawCalls += c.calls;
      }
      // Every layer is measured: a layer that does not count its draws (`DrawContext.count`) still costs time.
      if (measureLayers) {
        renderer.probe = { draws: (l, pass) => l !== layer || pass === 'shadow' };
        color.ms = kept.ms - measure(false, null).ms;
      }
      if (measureLayers) {
        renderer.probe = { draws: (l, pass) => l !== layer || pass !== 'shadow' };
        shadowCost.ms = shadow.ms - measure(true, null).ms;
      }
      renderer.probe = null;
      layers.push({ index, name: layerName(layer), passes, color, shadow: shadowCost });
    });

    return {
      gpu: device.name,
      width: view.width,
      height: view.height,
      dpr: view.dpr,
      samples: device.mainSamples(),
      shadowMapEdgePx: renderer.shadowMapEdgePx,
      shadowMapPx: stats.shadowMapPx,
      frames,
      syncMs,
      empty,
      kept,
      shadow,
      running,
      stats,
      layers,
      profileMs: performance.now() - started,
    };
  } finally {
    renderer.probe = savedProbe;
    renderer.bounds = savedBounds;
    // A measurement may have left a layer out of the shadow map: the next frame draws it whole again.
    renderer.invalidateShadows();
  }
}

/** The profile as a plain-text table (fixed-width columns). */
export function formatProfile(p: FrameProfile): string {
  const ms = (v: number | null): string => (v === null ? '-' : v.toFixed(2));
  const kilo = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} k` : String(v));
  const row = (label: string, t: FrameTiming): string =>
    `${label.padEnd(24)}${ms(t.ms).padStart(8)}${`±${t.spreadMs.toFixed(2)}`.padStart(9)}${ms(t.minMs).padStart(8)}${ms(t.maxMs).padStart(8)}${`${t.shadowFrames}/${p.frames}`.padStart(9)}${t.cpuMs.toFixed(2).padStart(8)}`;
  const out = [
    `Frame profile  ${p.gpu}`,
    `target ${p.width} × ${p.height} px (dpr ${p.dpr}), ${p.samples} samples, shadow map ${p.shadowMapEdgePx} px (used ${p.shadowMapPx}), ${p.frames} frames, wait ${p.syncMs.toFixed(2)} ms, took ${(p.profileMs / 1000).toFixed(1)} s`,
    `main ${kilo(p.stats.triangles)} tris in ${p.stats.drawCalls} calls, shadow ${kilo(p.stats.shadowTriangles)} tris in ${p.stats.shadowDrawCalls} calls`,
    '',
    `${'frame'.padEnd(24)}${'ms'.padStart(8)}${'spread'.padStart(9)}${'min'.padStart(8)}${'max'.padStart(8)}${'shadow'.padStart(9)}${'cpu'.padStart(8)}`,
    row('empty (clear, present)', p.empty),
    row('shadow kept', p.kept),
    row('shadow every frame', p.shadow),
  ];
  if (p.running) out.push(row('running', p.running));
  if (p.layers.length > 0) {
    out.push('', `${'layer'.padEnd(30)}${'passes'.padEnd(22)}${'color tris'.padStart(11)}${'calls'.padStart(7)}${'ms'.padStart(8)}${'shadow tris'.padStart(13)}${'calls'.padStart(7)}${'ms'.padStart(8)}`);
    for (const l of p.layers) {
      out.push(
        `${`${l.index} ${l.name}`.slice(0, 29).padEnd(30)}${l.passes.join(',').slice(0, 21).padEnd(22)}${kilo(l.color.triangles).padStart(11)}${String(l.color.drawCalls).padStart(7)}${ms(l.color.ms).padStart(8)}${kilo(l.shadow.triangles).padStart(13)}${String(l.shadow.drawCalls).padStart(7)}${ms(l.shadow.ms).padStart(8)}`,
      );
    }
    out.push(`(layer ms: frame with the layer minus frame without it; color with the shadow map kept, shadow with it redrawn every frame)`);
  }
  return out.join('\n');
}

/** `Layer.name`, else the class name, with the material name when the layer has one. */
function layerName(layer: Layer): string {
  if (layer.name) return layer.name;
  const cls = (layer as { constructor?: { name?: string } }).constructor?.name || 'Layer';
  const material = (layer as { material?: { name?: unknown } }).material?.name;
  return typeof material === 'string' ? `${cls}(${material})` : cls;
}

function timing(wall: Float64Array, shadowFrames: number, cpuMs: number): FrameTiming {
  const s = Float64Array.from(wall).sort();
  const q = (f: number): number => {
    const x = f * (s.length - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, s.length - 1);
    return s[i]! + (s[j]! - s[i]!) * (x - i);
  };
  return { ms: q(0.5), spreadMs: q(0.75) - q(0.25), minMs: s[0]!, maxMs: s[s.length - 1]!, shadowFrames, cpuMs };
}
