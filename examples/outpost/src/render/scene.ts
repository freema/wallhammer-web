// Turns the contributions of the content modules into engine layers, in drawing order:
//
//   planet       the disc over the horizon (sky/planet.ts), first, under everything
//   solid        static pieces that cast shadows: chunked by area (`chunkMeshes`), `PieceLayer` front to back
//   backdrop     the far ridges: colour pass only (they would only stretch the shadow map)
//   parts        instanced part sets (`InstanceSetLayer`), toon, dynamic shadow casters
//   decals       tracks and markings: colour pass only, pulled toward the eye by a depth offset
//   outlines     the hulls of solid and backdrop pieces, then of the part sets: colour pass only, front faces culled
//
// The outlines draw the same vertices as the toon pass (kit/mesh.ts): the material pushes them out along a_hull and
// culls front faces, so only the far side of the hull shows as a rim round the silhouette. A part set is one engine
// instance set added to two layers, which share its records and its GPU buffer.

import type { MeshData } from 'wallhammer-web/base';
import { chunkMeshes } from 'wallhammer-web/gen-mesh';
import { InstanceSetLayer, PieceLayer } from 'wallhammer-web/render';
import type { InstanceSet, Layer, Renderer } from 'wallhammer-web/render';
import type { MeshBuilder } from '../kit/mesh.ts';
import type { Contribution, FrameInfo } from '../kit/types.ts';
import type { V3 } from '../kit/math.ts';
import { PlanetLayer } from '../sky/planet.ts';
import { OUTLINE_MATERIAL, OUTLINE_PARTS_MATERIAL, STYLE, TOON_MATERIAL, TOON_PARTS_MATERIAL } from '../style/materials.ts';

/** Chunk edge near the station and farther out, metres. */
const CELL_NEAR = 24;
const CELL_FAR = 96;

function cellKey(x: number, z: number): string {
  if (Math.abs(x) < 72 && Math.abs(z) < 72) return `n${Math.floor(x / CELL_NEAR)},${Math.floor(z / CELL_NEAR)}`;
  return `f${Math.floor(x / CELL_FAR)},${Math.floor(z / CELL_FAR)}`;
}

/** Whether any vertex of the mesh takes part in the outline hull. */
function outlined(b: MeshBuilder): boolean {
  for (let i = 0; i < b.vertexCount; i++) if (b.payload(i).outline) return true;
  return false;
}

export interface SceneStats {
  staticTriangles: number;
  outlineTriangles: number;
  chunks: number;
  partSets: number;
  partTriangles: number;
  modules: Record<string, { triangles: number; parts: number }>;
}

export class OutpostScene {
  readonly planet: PlanetLayer;
  private readonly solid: PieceLayer;
  private readonly backdrop: PieceLayer;
  private readonly decals: PieceLayer;
  private readonly hulls: PieceLayer;
  private readonly parts: InstanceSetLayer;
  private readonly partHulls: InstanceSetLayer;
  private readonly sets: InstanceSet[] = [];
  /** Every static piece's mesh as built for drawing, by module and name. */
  readonly built: { name: string; mesh: MeshData }[] = [];
  private readonly updates: ((frame: FrameInfo) => void)[] = [];
  private readonly moduleStats: SceneStats['modules'] = {};
  private staticTriangles = 0;
  private outlineTriangles = 0;
  private lastTime = Number.NaN;
  private lastHeight = 0;

  constructor(renderer: Renderer, add: (layer: Layer) => void, contributions: readonly { name: string; c: Contribution }[], planet: { dir: V3; radiusDeg: number }) {
    const toon = renderer.material(TOON_MATERIAL);
    const outline = renderer.material(OUTLINE_MATERIAL);
    this.planet = new PlanetLayer(renderer, planet.dir, planet.radiusDeg);
    this.solid = new PieceLayer({ material: toon, order: 'front-to-back', name: 'solid' });
    this.backdrop = new PieceLayer({ material: toon, passes: ['color'], name: 'backdrop' });
    // Reversed depth in the engine: the device turns the offset round, so a negative one always pulls toward the eye.
    this.decals = new PieceLayer({ material: toon, passes: ['color'], state: { color: { polygonOffset: [-1, -2] } }, name: 'decals' });
    this.hulls = new PieceLayer({ material: outline, passes: ['color'], name: 'outlines' });
    this.parts = new InstanceSetLayer(renderer, { material: renderer.material(TOON_PARTS_MATERIAL), name: 'parts' });
    this.partHulls = new InstanceSetLayer(renderer, { material: renderer.material(OUTLINE_PARTS_MATERIAL), passes: ['color'], name: 'part-outlines' });

    const solid: MeshData[] = [];
    const backdrop: MeshData[] = [];
    const decals: MeshData[] = [];
    const hulls: MeshData[] = [];
    for (const { name, c } of contributions) {
      let tris = 0;
      for (const p of c.statics ?? []) {
        if (p.mesh.triangleCount === 0) continue;
        tris += p.mesh.triangleCount;
        const kind = p.kind ?? 'solid';
        const mesh = p.mesh.build();
        this.built.push({ name: `${name}/${p.name}`, mesh });
        if (kind === 'decal') {
          decals.push(mesh);
          continue;
        }
        (kind === 'backdrop' ? backdrop : solid).push(mesh);
        if (outlined(p.mesh)) hulls.push(mesh);
      }
      for (const set of c.parts ?? []) {
        // One set, two layers: the toon pass and the outline (which has no shadow pass) share its records.
        this.parts.add(set);
        this.partHulls.add(set);
        this.sets.push(set);
      }
      if (c.update) this.updates.push(c.update.bind(c));
      this.moduleStats[name] = { triangles: tris, parts: (c.parts ?? []).reduce((s, p) => s + (p.mesh.count / 3) * p.count, 0) };
    }

    // Shadows are fitted to the solid pieces only (the ridges stand far out and cast none).
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const fill = (layer: PieceLayer, meshes: MeshData[], bounds: boolean): number => {
      let tris = 0;
      for (const ch of chunkMeshes(meshes, { cellKey, padM: 0.5 })) {
        layer.add({ mesh: renderer.createMesh(ch.data, layer.material), min: ch.min, max: ch.max });
        tris += ch.triangles;
        if (bounds) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k]!, ch.min[k]!)), (max[k] = Math.max(max[k]!, ch.max[k]!));
      }
      return tris;
    };
    this.staticTriangles = fill(this.solid, solid, true) + fill(this.backdrop, backdrop, false) + fill(this.decals, decals, false);
    this.outlineTriangles = fill(this.hulls, hulls, false);
    renderer.bounds = { min: [...min], max: [...max] };

    for (const layer of [this.planet, this.solid, this.backdrop, this.parts, this.decals, this.hulls, this.partHulls]) add(layer);
    this.setInk(1080);
  }

  /** Line widths for a canvas `height` pixels high (the style is given for 1080). */
  setInk(height: number): void {
    if (height === this.lastHeight) return;
    this.lastHeight = height;
    const k = Math.max(0.5, height / 1080);
    const ink = { u_ink: { vec4: [STYLE.linePx * k, STYLE.outlinePx * k, 0, 0] as [number, number, number, number] } };
    for (const l of [this.solid, this.backdrop, this.decals, this.hulls, this.parts, this.partHulls]) l.uniforms = ink;
    this.planet.outlinePx = STYLE.outlinePx * k;
  }

  /** Runs the modules' updates when the animation time moved (or when forced); they mark the sets they change. */
  update(frame: FrameInfo, force = false): void {
    if (!force && frame.time === this.lastTime) return;
    this.lastTime = frame.time;
    for (const u of this.updates) u(frame);
  }

  stats(): SceneStats {
    return {
      staticTriangles: this.staticTriangles,
      outlineTriangles: this.outlineTriangles,
      chunks: this.solid.pieces.length + this.backdrop.pieces.length + this.decals.pieces.length + this.hulls.pieces.length,
      partSets: this.sets.length,
      partTriangles: this.parts.triangles,
      modules: this.moduleStats,
    };
  }

  dispose(): void {
    this.parts.dispose();
    this.partHulls.dispose();
  }
}
