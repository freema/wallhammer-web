// Scene assembly: turns the contributions of all content modules into engine layers and drives them every frame.
// Everything drawn here is an engine layer; the village only maps its content contract (kit/types.ts) onto them.
//
//   statics   merged by material (solid with shadows, solid without, water) and cut into spatial chunks
//             (`chunkMeshes` from gen-mesh), drawn by `PieceLayer` front to back, each chunk with its own lights
//   parts     `InstanceSetLayer`: one instanced draw per part set, uploaded when dirty, a dynamic shadow caster
//   lights    `PointLightSet`: up to 32 per frame, nearest to the eye first; evening lights in gain group 1
//   particles `ParticleLayer`: two draws (puffs, fire), computed on the GPU from the animation time
//
// Layer order: solids, parts, (the sky, behind the scene), water (blended over the river bed), particles. The
// per-frame work allocates nothing: the frame record, the light arrays and the part sets' own buffers are reused.
//
// Shadows: the part layer casts as `shadowCasters: 'dynamic'`, so a frame in which only parts moved draws just the
// parts over the kept map of the static casters (engine, mode 'single'). `shadowHz` can still limit how often the
// moving parts redraw it (address parameter `sh=`; default 0 = in every frame they moved).

import { newCornerRays } from 'wallhammer-web/base';
import type { MeshData, View } from 'wallhammer-web/base';
import { chunkMeshes } from 'wallhammer-web/gen-mesh';
import { InstanceSetLayer, ParticleLayer, PieceLayer, PointLightSet } from 'wallhammer-web/render';
import type { Layer, ParticleSource as EngineParticleSource, Renderer } from 'wallhammer-web/render';
import type { Contribution, FrameInfo, PartSet, ParticleSource } from '../kit/types.ts';
import { MAX_LIGHTS, PART_MATERIAL, SOLID_MATERIAL, WATER_MATERIAL } from './materials.ts';

/** Cell size inside the village and in the backdrop; the border between them (metres from the origin). */
const CELL_NEAR = 56;
const CELL_FAR = 256;
const NEAR_REACH = 112;

/** Gain groups of the lights and particles. */
const GROUP = { always: 0, evening: 1, fire: 2, eveningFire: 3 } as const;

export interface SceneHost {
  readonly renderer: Renderer;
  add(layer: Layer): void;
  /** The example's glow values for the frame being drawn (src/env.ts slot), undefined before the first one. */
  glow(): { evening: number; fire: number } | undefined;
}

export interface SceneOptions {
  /** Most shadow redraws per second of animation time caused by moving parts; 0 (default) = no limit. */
  shadowHz?: number;
}

export interface ParticleCounts {
  emitters: number;
  particles: number;
  /** Particles left out because the budget was full. */
  dropped: number;
}

export interface SceneStats {
  staticTriangles: number;
  chunks: number;
  partSets: number;
  partTriangles: number;
  lights: number;
  lightsActive: number;
  /** Chunk draws of the last frame that more than 8 lights reached (they visit the whole selection). */
  lightsCrowded: number;
  particles: ParticleCounts;
  modules: Record<string, { triangles: number; parts: number; lights: number; particles: number }>;
}

/** The village's emitter as an engine particle source: puffs blend, fire adds; evening ones follow dusk. */
function asParticleSource(s: ParticleSource): EngineParticleSource {
  const fire = s.kind === 'fire' || s.kind === 'spark';
  const evening = s.when === 'evening';
  return {
    position: s.position,
    count: s.count,
    life: s.life,
    size: s.size,
    rise: s.rise,
    spread: s.spread,
    gravity: s.gravity ?? 0,
    // The village's defaults by kind: fire and sparks hardly drift with the wind.
    wind: s.wind ?? (fire ? 0.15 : 1),
    colorStart: s.colorStart,
    colorEnd: s.colorEnd,
    blend: fire ? 'add' : 'blend',
    shape: fire ? 'core' : 'soft',
    group: fire ? (evening ? GROUP.eveningFire : GROUP.fire) : evening ? GROUP.evening : GROUP.always,
  };
}

function cellKey(x: number, _y: number, z: number): string {
  if (Math.abs(x) < NEAR_REACH && Math.abs(z) < NEAR_REACH) return `n${Math.floor(x / CELL_NEAR)},${Math.floor(z / CELL_NEAR)}`;
  return `f${Math.floor(x / CELL_FAR)},${Math.floor(z / CELL_FAR)}`;
}

/**
 * The part layer, with an optional limit on how often moving parts redraw the shadow (`shadowHz`). A change that is
 * held back stays pending in the engine layer and is drawn when due; a paused frame draws it at once.
 */
class PartLayer extends InstanceSetLayer {
  /** Smallest animation time between two shadow redraws caused by the parts; 0 = no limit. */
  minShadowInterval = 0;
  /** Animation time of this frame, and whether the animation stands. Set by the scene. */
  time = 0;
  still = true;
  private lastShadow = -Infinity;

  override shadowDirty(): boolean {
    if (!super.shadowDirty()) return false;
    if (this.minShadowInterval > 0 && !this.still && Math.abs(this.time - this.lastShadow) < this.minShadowInterval - 1e-4) return false;
    this.lastShadow = this.time;
    return true;
  }
}

export class VillageScene {
  readonly lights: PointLightSet;
  private readonly solid: PieceLayer;
  private readonly flat: PieceLayer;
  private readonly water: PieceLayer;
  private readonly parts: PartLayer;
  private readonly particleLayer: ParticleLayer;
  private readonly updates: ((frame: FrameInfo) => void)[] = [];
  private readonly groups = new Map<string, PartSet[]>();
  private lastTime = Number.NaN;
  private readonly moduleStats: SceneStats['modules'] = {};
  private staticTriangles = 0;
  private crowded = 0;
  private readonly rays = newCornerRays();

  private readonly host: SceneHost;

  constructor(host: SceneHost, contributions: readonly { name: string; c: Contribution }[], o: SceneOptions = {}) {
    this.host = host;
    const { renderer } = host;
    // The light set registers `<point-lights>`: before the materials that include it are compiled.
    this.lights = new PointLightSet(renderer, { max: MAX_LIGHTS });
    const lights = this.lights;
    const solidMat = renderer.material(SOLID_MATERIAL);
    const partMat = renderer.material(PART_MATERIAL);
    const waterMat = renderer.material(WATER_MATERIAL);
    this.solid = new PieceLayer({ material: solidMat, lights, order: 'front-to-back', name: 'statics-casting' });
    this.flat = new PieceLayer({ material: solidMat, lights, order: 'front-to-back', passes: ['color'], name: 'statics-flat' });
    this.water = new PieceLayer({ material: waterMat, lights, name: 'water' });
    this.parts = new PartLayer(renderer, { material: partMat, lights, name: 'parts' });
    const hz = o.shadowHz ?? 0;
    this.parts.minShadowInterval = hz > 0 ? 1 / hz : 0;

    const casting: MeshData[] = [];
    const flat: MeshData[] = [];
    const water: MeshData[] = [];
    const particles: EngineParticleSource[] = [];
    for (const { name, c } of contributions) {
      let tris = 0;
      for (const p of c.statics ?? []) {
        if (p.mesh.triangleCount === 0) continue;
        tris += p.mesh.triangleCount;
        const data = p.mesh.build();
        if (p.material === 'water') water.push(data);
        else if (p.castShadow === false) flat.push(data);
        else casting.push(data);
      }
      for (const set of c.parts ?? []) {
        this.parts.add(set);
        if (set.group) {
          let list = this.groups.get(set.group);
          if (!list) this.groups.set(set.group, (list = []));
          list.push(set);
        }
      }
      for (const l of c.lights ?? []) {
        l.group = l.when === 'evening' ? GROUP.evening : GROUP.always;
        lights.add(l);
      }
      for (const s of c.particles ?? []) particles.push(asParticleSource(s));
      if (c.update) this.updates.push(c.update.bind(c));
      this.moduleStats[name] = {
        triangles: tris,
        parts: (c.parts ?? []).reduce((s, p) => s + p.part.triangleCount * p.count, 0),
        lights: (c.lights ?? []).length,
        particles: (c.particles ?? []).reduce((s, p) => s + p.count, 0),
      };
    }

    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const [layer, meshes] of [[this.solid, casting], [this.flat, flat], [this.water, water]] as const) {
      // Room for wind sway and the shadow lookup's normal offset around every chunk.
      for (const ch of chunkMeshes(meshes, { cellKey, padM: 0.5 })) {
        layer.add({ mesh: renderer.createMesh(ch.data, layer.material), min: ch.min, max: ch.max });
        this.staticTriangles += ch.triangles;
        for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k]!, ch.min[k]!)), (max[k] = Math.max(max[k]!, ch.max[k]!));
      }
    }
    renderer.bounds = { min, max };

    this.particleLayer = new ParticleLayer(renderer, particles, { name: 'particles' });

    host.add(this.solid);
    host.add(this.flat);
    host.add(this.parts);
    host.add(this.water);
    host.add(this.particleLayer);

    // Per rendered frame, after the environment of the frame is computed (the link's hook was added before this one):
    // the gains of lights and particles from the glow of this very frame, and the lights for the eye of the view.
    renderer.beforeFrame.push((view) => this.beforeFrame(view));
  }

  /** The layer to draw the sky behind (the first one that blends): everything added before it is opaque. */
  get firstBlendedLayer(): Layer {
    return this.water;
  }

  private beforeFrame(view: View): void {
    const g = this.host.glow();
    const evening = g?.evening ?? 0;
    const fire = g?.fire ?? 0;
    // Draws of the frame that just ended (the counter is reset by `update`).
    this.crowded = this.lights.crowdedDraws;
    this.lights.gains[GROUP.evening] = evening;
    const pg = this.particleLayer.gains;
    pg[GROUP.evening] = evening;
    pg[GROUP.fire] = fire;
    pg[GROUP.eveningFire] = evening * fire;
    // The eye: where the corner rays of the (perspective) view start.
    const eye = view.cornerRays(this.rays)[0]!.origin;
    this.lights.update(eye[0], eye[1], eye[2]);
  }

  /**
   * Adds part sets after the build (the walk mode's figure, on its first start). They are drawn from the next frame;
   * they are not counted in any module's stats and have no group.
   */
  addParts(sets: readonly PartSet[]): void {
    for (const set of sets) this.parts.add(set);
  }

  /** Shows or hides the part sets of a group ('villagers'); returns the new state. */
  setGroupVisible(group: string, visible: boolean): boolean {
    for (const s of this.groups.get(group) ?? []) s.visible = visible;
    return visible;
  }

  /**
   * Runs the modules' updates (only when the animation time moved, or on the first frame and when `force` is set).
   * Dirty part sets are uploaded by the engine at the start of the frame, and the lights are chosen there too.
   */
  update(frame: FrameInfo, force = false): void {
    if (force || frame.time !== this.lastTime) {
      this.lastTime = frame.time;
      for (const u of this.updates) u(frame);
    }
    this.parts.time = frame.time;
    this.parts.still = force || frame.dt === 0;
  }

  stats(): SceneStats {
    const pc = this.particleLayer.counts;
    return {
      staticTriangles: this.staticTriangles,
      chunks: this.solid.pieces.length + this.flat.pieces.length + this.water.pieces.length,
      partSets: this.parts.sets.length,
      partTriangles: this.parts.triangles,
      lights: this.lights.lights.length,
      lightsActive: this.lights.count,
      lightsCrowded: this.crowded,
      particles: { emitters: pc.sources, particles: pc.particles, dropped: pc.dropped },
      modules: this.moduleStats,
    };
  }
}
