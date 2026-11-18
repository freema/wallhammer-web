// The structures of Hearth round the eye (stage 3; spans from stage 4), in two levels per cluster (structures.ts: a
// site, or a span of the routes):
// - Massing: the prisms of every item of the clusters whose centre lies within `BUILD_M` + their radius of the eye (at
//   most `MAX_CLUSTERS`, freed beyond `FREE_M` + radius), one mesh per cluster in the body's axes from its centre, drawn
//   with the engine's massing material and `u_cellOffset` = centre - render origin. The bytes come from a worker job
//   (`clusterMassing`) once; when the set of full items or ruins changes, the mesh is joined again from the cached
//   bytes without them (only the index list changes), so every item is drawn exactly once.
// - Full: at most `FULL_MAX` structures within `FULL_IN_M` (out again at `FULL_OUT_M`), each drawn in its own frame
//   with the structure material (`u_frame` set per draw in doubles). Intact meshes come from worker jobs
//   (`clusterFull`), with `src=main` from the same function on the page within a time budget per frame; damaged ones
//   are rebuilt on the page from the damage table, with the rubble of their gone parts.
// A strike commits the state at once; the parts it took away fall as pieces on closed-form tracks (`fallPieces`,
// `TransientLayer`, the framed falling material) and their rubble grows in where they land.

import type { StructureDesc, StructureState } from 'wallhammer-web';
import { DAMAGE } from 'wallhammer-web/base';
import type { MeshData, Vec3 } from 'wallhammer-web/base';
import { buildBuildingMesh, buildRubbleMesh, fallingMaterial, fallPieces, massingMaterial, rubbleColours, structureMaterial, structureUniforms } from 'wallhammer-web/gen-arch';
import type { FallChange } from 'wallhammer-web/gen-arch';
import { TIMELINE_TICK_S, compileStructure, raycastParts, rubbleFootprints } from 'wallhammer-web/sim/destruction';
import type { CompiledStructure } from 'wallhammer-web/sim/destruction';
import { STRIKE_ENERGY, STRIKE_RADIUS_M, createDamage } from './damage.ts';
import type { Damage } from './damage.ts';
import { KEY_ITEMS, STRUCTURE_DIMS, buildStructure, clusterCentre, clusterCount, clusterFull, clusterMassing, clusterRecipes, frameGround, frameMatrix, recipeByKey, row, structureScope } from './structures.ts';
import type { ClusterMassing, StructureRecipe } from './structures.ts';
import type { Mesh } from 'wallhammer-web/gpu';
import type { WorkerPool } from 'wallhammer-web/platform';
import { MeshLayer, TransientLayer } from 'wallhammer-web/render';
import type { DrawContext, Material, Renderer } from 'wallhammer-web/render';
import type { WorldPlan } from './plan.ts';

/** The centres of every cluster of a plan, computed once per plan (a span's centre walks its deck line). */
const centresOf = new WeakMap<WorldPlan, ReturnType<typeof clusterCentre>[]>();
function clusterCentres(plan: WorldPlan): ReturnType<typeof clusterCentre>[] {
  let list = centresOf.get(plan);
  if (!list) {
    const n = clusterCount(plan);
    list = [];
    for (let c = 0; c < n; c++) list.push(clusterCentre(plan, c));
    centresOf.set(plan, list);
  }
  return list;
}

/** Clusters whose centre is nearer to the eye than this plus their radius get their massing; beyond `FREE_M` it is freed. */
const BUILD_M = 8000;
const FREE_M = 10_000;
const MAX_CLUSTERS = 12;
/** Worker jobs in flight at once (massing and full), and items per full job. */
const JOBS_IN_FLIGHT = 2;
const ITEMS_PER_JOB = 6;
/** Pieces that may fly at once. */
const MAX_PIECES = 320;

interface Held {
  cluster: number;
  /** Centre of the cluster in the body's frame, metres, and its radius. */
  centre: Vec3;
  radiusM: number;
  /** The bytes of its massing (null until they arrive). */
  massing: ClusterMassing | null;
  pending: boolean;
  mesh: Mesh | null;
  /** The keys left out of the massing, as text, to see when it must be joined again. */
  skip: string;
}

/** A full structure held on the GPU: its mesh in its own frame and its parts (for strikes and the pick). */
interface Full {
  recipe: StructureRecipe;
  mesh: Mesh | null;
  /** Rubble of its gone parts (damaged structures only). */
  rubble: Mesh | null;
  triangles: number;
  damaged: boolean;
  descs: readonly StructureDesc[];
  compiled: CompiledStructure[] | null;
  /** Frame into render space, written every frame. */
  frame: Float32Array;
}

/** Full structures nearer than `FULL_IN_M` come in, beyond `FULL_OUT_M` they go back to the massing. */
const FULL_IN_M = 250;
const FULL_OUT_M = 280;
const FULL_MAX = 60;
/** Full meshes kept on the GPU, least recently used out. */
const FULL_KEEP = 120;
/** Time for building full structures per frame on the page, ms (at least one is built). */
const BUILD_BUDGET_MS = 3;

/** Draws a list of full structures with one structure material, each with its own `u_frame`. */
export class StructureLayer extends MeshLayer {
  items: Full[] = [];

  override draw(ctx: DrawContext): void {
    if (this.items.length === 0) return;
    const program = this.begin(ctx);
    if (!program) return;
    for (const f of this.items) {
      if (!f.mesh && !f.rubble) continue;
      program.mat4('u_frame', f.frame);
      for (const m of [f.mesh, f.rubble]) {
        if (!m) continue;
        ctx.device.draw(m);
        ctx.count(m.triangles);
      }
    }
  }
}

export interface StructureStats {
  full: number;
  massing: number;
  clusters: number;
  triangles: number;
  damaged: number;
}

/** Where the jobs of the structures run, the clock of the falling parts, and a call when something arrived to be drawn. */
export interface SettlementOptions {
  /** The pool of workers; null or absent: the same functions on the page (`src=main`). */
  pool?: WorkerPool | null;
  /** Stage of the plan the workers hold (sent with the jobs). */
  stage?: number;
  /** The clock behind `u_time.x` (seconds); without it a strike shows no falling parts. */
  clock?: () => number;
  onChange?: () => void;
}

/** The layer of the massing, and the full structures near the eye. `update` once per frame; draws only while Hearth is the body the eye is at. */
export class SettlementLayer extends MeshLayer {
  private readonly renderer: Renderer;
  private readonly held = new Map<number, Held>();
  private origin: Vec3 = [0, 0, 0];
  private active = false;
  private plan: WorldPlan | null = null;
  /** Full structures by key, in order of last use. */
  private readonly fulls = new Map<number, Full>();
  /** The near set of the last frame (nearest first, ties by key). */
  private nearSet: StructureRecipe[] = [];
  private nearKeys = new Set<number>();
  private missing = 0;
  private readonly packed: number;
  private readonly pool: WorkerPool | null;
  private readonly stage: number;
  private readonly clock: (() => number) | null;
  private readonly onChange: () => void;
  /** Keys asked of the workers and not answered yet; jobs in flight; bumped when the plan changes (late replies are dropped). */
  private readonly asked = new Set<number>();
  private jobs = 0;
  private generation = 0;
  private readonly structUniforms: ReturnType<typeof structureUniforms>;
  private readonly fallMat: Material;
  /** Batches of falling parts with their frames (written every frame); clock time and length of the rubble growth by `key:id:part`. */
  private batches: { id: number; recipe: StructureRecipe; frame: Float32Array; end: number }[] = [];
  private readonly arrivals = new Map<string, { start: number; seconds: number }>();
  /** Intact full structures, damaged ones and the falling parts. Add all three to the renderer next to this layer. */
  readonly intact: StructureLayer;
  readonly damaged: StructureLayer;
  readonly transient: TransientLayer;
  readonly damage: Damage;

  constructor(renderer: Renderer, packed: number, o: SettlementOptions = {}) {
    const uniforms = structureUniforms({ glass: row('glass'), glassLit: row('glassLit'), plinth: row('plinth') });
    super({ material: renderer.material(massingMaterial(STRUCTURE_DIMS)), uniforms });
    this.renderer = renderer;
    this.packed = packed;
    this.pool = o.pool ?? null;
    this.stage = o.stage ?? 0;
    this.clock = o.clock ?? null;
    this.onChange = o.onChange ?? ((): void => {});
    this.structUniforms = uniforms;
    this.intact = new StructureLayer({ material: renderer.material(structureMaterial(STRUCTURE_DIMS, { framed: true, finishes: true })), uniforms });
    this.damaged = new StructureLayer({ material: renderer.material(structureMaterial(STRUCTURE_DIMS, { damage: true, framed: true, finishes: true })), uniforms });
    this.fallMat = renderer.material(fallingMaterial(STRUCTURE_DIMS, { framed: true, finishes: true }));
    this.transient = new TransientLayer(renderer, { maxPieces: MAX_PIECES, ...(o.clock ? { clock: o.clock } : {}) });
    this.damage = createDamage({
      packed,
      plan: () => this.plan,
      near: () => this.nearSet.filter((r) => this.fulls.get(r.key)?.mesh),
      descs: (key) => this.fulls.get(key)?.descs ?? [],
    });
  }

  /** Clusters whose massing is held. */
  get sites(): number {
    return this.held.size;
  }

  /** True once every structure of the near set has its full mesh. */
  get settled(): boolean {
    return this.active && this.missing === 0;
  }

  /** The near set (full structures and those still waiting for their mesh). */
  near(): readonly StructureRecipe[] {
    return this.nearSet;
  }

  /**
   * With the plan, the eye in the body's frame (or null when Hearth is not the body near) and the render origin in that
   * frame: asks for at most one more cluster per frame (the nearest missing), frees the far ones; then the full
   * structures, the frames of the falling parts and the massing without the full items and the ruins.
   */
  update(plan: WorldPlan | null, eye: Vec3 | null, origin: Vec3): void {
    this.origin = origin;
    this.active = eye !== null && plan !== null && plan.sites !== null;
    if (plan !== this.plan) {
      this.dropFulls();
      for (const h of this.held.values()) if (h.mesh) this.renderer.device.deleteMesh(h.mesh);
      this.held.clear();
      this.damage.clear();
      this.arrivals.clear();
      this.plan = plan;
      this.generation++;
      this.jobs = 0;
      this.asked.clear();
    }
    if (!this.active || !plan?.sites || !eye) {
      this.intact.items = [];
      this.damaged.items = [];
      if (this.batches.length) this.clearFalling();
      return;
    }
    const R = plan.grid.radiusM;
    const dist = (c: Vec3): number => Math.sqrt((c[0] - eye[0]) ** 2 + (c[1] - eye[1]) ** 2 + (c[2] - eye[2]) ** 2);
    for (const [c, h] of this.held) {
      if (dist(h.centre) > FREE_M + h.radiusM) {
        if (h.mesh) this.renderer.device.deleteMesh(h.mesh);
        this.held.delete(c);
      }
    }
    if (this.held.size < MAX_CLUSTERS) {
      let best: Held | null = null;
      let bestD = Infinity;
      const centres = clusterCentres(plan);
      const n = centres.length;
      for (let c = 0; c < n; c++) {
        if (this.held.has(c)) continue;
        const cc = centres[c]!;
        const r = R + cc.heightM;
        const centre: Vec3 = [cc.dir[0] * r, cc.dir[1] * r, cc.dir[2] * r];
        const d = dist(centre) - cc.radiusM;
        if (d < BUILD_M && d < bestD) {
          bestD = d;
          best = { cluster: c, centre, radiusM: cc.radiusM, massing: null, pending: false, mesh: null, skip: '-' };
        }
      }
      if (best) {
        this.held.set(best.cluster, best);
        this.askMassing(plan, best);
      }
    }
    this.updateFulls(plan, eye);
    this.updateFalling(plan);
    // The massing of every held cluster without the items drawn full and without the ruins.
    const skips = new Map<number, number[]>();
    const add = (key: number): void => {
      const c = Math.floor(key / KEY_ITEMS);
      const l = skips.get(c) ?? [];
      l.push(key);
      skips.set(c, l);
    };
    for (const r of this.nearSet) if (this.fulls.has(r.key)) add(r.key);
    for (const key of this.damage.keys()) if (!this.nearKeys.has(key) && isRuin(this.damage.states(key), recipeByKey(plan, key))) add(key);
    for (const [c, h] of this.held) {
      if (!h.massing) continue;
      const list = (skips.get(c) ?? []).sort((a, b) => a - b);
      const sig = list.join(',');
      if (sig === h.skip) continue;
      const data = joinMassing(h.massing, new Set(list));
      if (h.mesh) this.renderer.device.deleteMesh(h.mesh);
      h.mesh = data.count > 0 ? this.renderer.createMesh(data, this.material) : null;
      h.skip = sig;
    }
  }

  /** The massing of a cluster: a worker job, or on the page at once with `src=main`. */
  private askMassing(plan: WorldPlan, h: Held): void {
    if (!this.pool) {
      h.massing = clusterMassing(plan, h.cluster);
      return;
    }
    h.pending = true;
    const gen = this.generation;
    this.jobs++;
    this.pool
      .run<ClusterMassing>({ kind: 'site', seed: this.packed, stage: this.stage, cluster: h.cluster, level: 'massing' })
      .promise.then(
        (m) => {
          if (gen !== this.generation || this.held.get(h.cluster) !== h) return;
          h.massing = m;
          h.pending = false;
          this.onChange();
        },
        (e: unknown) => console.warn('structures: massing job failed', e),
      )
      .finally(() => {
        if (gen === this.generation) this.jobs--;
      });
  }

  /** The near set, the full meshes it lacks (within the budget), the frames and the draw lists. */
  private updateFulls(plan: WorldPlan, eye: Vec3): void {
    const R = plan.grid.radiusM;
    const cand: { r: StructureRecipe; d: number; item: number }[] = [];
    for (const h of this.held.values()) {
      if (Math.sqrt((h.centre[0] - eye[0]) ** 2 + (h.centre[1] - eye[1]) ** 2 + (h.centre[2] - eye[2]) ** 2) > FULL_OUT_M + h.radiusM + 50) continue;
      clusterRecipes(plan, h.cluster).forEach((r, item) => {
        const f = r.frame;
        const rr = R + f.heightM;
        const d = Math.sqrt((f.origin[0] * rr - eye[0]) ** 2 + (f.origin[1] * rr - eye[1]) ** 2 + (f.origin[2] * rr - eye[2]) ** 2);
        if (d < FULL_IN_M || (d < FULL_OUT_M && this.nearKeys.has(r.key))) cand.push({ r, d, item });
      });
    }
    cand.sort((a, b) => a.d - b.d || a.r.key - b.r.key);
    const near = cand.slice(0, FULL_MAX);
    this.nearSet = near.map((c) => c.r);
    this.nearKeys = new Set(this.nearSet.map((r) => r.key));
    const t0 = performance.now();
    let built = 0;
    this.missing = 0;
    /** Items still to ask the workers for, by cluster, nearest first. */
    const ask = new Map<number, number[]>();
    for (const { r, item } of near) {
      let f = this.fulls.get(r.key);
      if (!f) {
        this.missing++;
        if (this.damage.states(r.key)) {
          // Damaged: always rebuilt here from the damage table.
          f = this.build(plan, r);
        } else if (this.pool) {
          if (!this.asked.has(r.key)) {
            const c = Math.floor(r.key / KEY_ITEMS);
            const l = ask.get(c) ?? [];
            l.push(item);
            ask.set(c, l);
          }
          continue;
        } else {
          if (built > 0 && performance.now() - t0 > BUILD_BUDGET_MS) continue;
          const [one] = clusterFull(plan, Math.floor(r.key / KEY_ITEMS), [item]);
          f = one ? this.adopt(r, one.mesh, one.descs) : this.build(plan, r);
          built++;
        }
        this.missing--;
      }
      // Last used now.
      this.fulls.delete(r.key);
      this.fulls.set(r.key, f);
    }
    for (const [c, items] of ask) {
      for (let i = 0; i < items.length && this.jobs < JOBS_IN_FLIGHT; i += ITEMS_PER_JOB) this.askFull(plan, c, items.slice(i, i + ITEMS_PER_JOB));
    }
    while (this.fulls.size > FULL_KEEP) {
      const [key, f] = this.fulls.entries().next().value as [number, Full];
      if (this.nearKeys.has(key)) break;
      if (f.mesh) this.renderer.device.deleteMesh(f.mesh);
      if (f.rubble) this.renderer.device.deleteMesh(f.rubble);
      this.fulls.delete(key);
    }
    const intact: Full[] = [];
    const damaged: Full[] = [];
    for (const r of this.nearSet) {
      const f = this.fulls.get(r.key);
      if (!f || (!f.mesh && !f.rubble)) continue;
      frameMatrix(plan, r.frame, this.origin, f.frame);
      (f.damaged ? damaged : intact).push(f);
    }
    this.intact.items = intact;
    this.damaged.items = damaged;
  }

  /** Intact full meshes of some items of a cluster from a worker; late or stale replies are dropped. */
  private askFull(plan: WorldPlan, cluster: number, items: number[]): void {
    const pool = this.pool!;
    const gen = this.generation;
    const recipes = clusterRecipes(plan, cluster);
    const keys = items.map((i) => recipes[i]!.key);
    for (const k of keys) this.asked.add(k);
    this.jobs++;
    pool
      .run<{ item: number; key: number; mesh: MeshData; descs: StructureDesc[] }[]>({ kind: 'site', seed: this.packed, stage: this.stage, cluster, level: 'full', items })
      .promise.then(
        (list) => {
          if (gen !== this.generation) return;
          for (const one of list) {
            const r = recipes[one.item];
            if (!r || r.key !== one.key || this.fulls.has(r.key)) continue;
            // A structure damaged meanwhile is built here from the damage table.
            const f = this.damage.states(r.key) ? this.build(plan, r) : this.adopt(r, one.mesh, one.descs);
            this.fulls.set(r.key, f);
          }
          this.onChange();
        },
        (e: unknown) => console.warn('structures: full job failed', e),
      )
      .finally(() => {
        if (gen !== this.generation) return;
        this.jobs--;
        for (const k of keys) this.asked.delete(k);
      });
  }

  /** An intact full structure from its mesh and part descriptions. */
  private adopt(r: StructureRecipe, data: MeshData, descs: readonly StructureDesc[]): Full {
    const mesh = data.count > 0 ? this.renderer.createMesh(data, this.intact.material) : null;
    const f: Full = { recipe: r, mesh, rubble: null, triangles: data.count / 3, damaged: false, descs, compiled: null, frame: new Float32Array(16) };
    this.fulls.set(r.key, f);
    return f;
  }

  /** Builds (or rebuilds after damage) the full mesh of a structure on the page, with the rubble of its gone parts. */
  private build(plan: WorldPlan, r: StructureRecipe): Full {
    const old = this.fulls.get(r.key);
    const states = this.damage.states(r.key);
    const damaged = states !== undefined && [...states.values()].some((s) => s.ruin || s.parts.size > 0);
    const scope = structureScope(plan);
    const out = buildStructure(r, plan, scope, { describe: true, ...(damaged ? { states } : {}) }, !isRuin(states, r));
    const material = damaged ? this.damaged.material : this.intact.material;
    if (old?.mesh) this.renderer.device.deleteMesh(old.mesh);
    if (old?.rubble) this.renderer.device.deleteMesh(old.rubble);
    const mesh = out.mesh.count > 0 ? this.renderer.createMesh(out.mesh, material) : null;
    const descs = old?.descs ?? out.structures;
    const compiled = old?.compiled ?? (damaged ? descs.map((d) => compileStructure(d)) : null);
    let rubble: Mesh | null = null;
    let rubbleTris = 0;
    if (damaged && states && compiled) {
      const footprints = compiled.flatMap((s) => {
        const st = states.get(s.desc.id);
        return st ? rubbleFootprints(s, st) : [];
      });
      const key = r.key;
      const data = buildRubbleMesh(footprints, rubbleColours(r.specs), frameGround(plan, scope, r.frame), (fp) => this.arrivals.get(`${key}:${fp.structure}:${fp.part}`));
      if (data.count > 0) rubble = this.renderer.createMesh(data, this.damaged.material);
      rubbleTris = data.count / 3;
    }
    const f: Full = { recipe: r, mesh, rubble, triangles: out.mesh.count / 3 + rubbleTris, damaged, descs, compiled, frame: old?.frame ?? new Float32Array(16) };
    this.fulls.set(r.key, f);
    return f;
  }

  /** Frames of the batches of falling parts; batches long done are forgotten. */
  private updateFalling(plan: WorldPlan): void {
    if (!this.clock || this.batches.length === 0) return;
    const now = this.clock();
    this.transient.drop(now);
    this.batches = this.batches.filter((b) => b.end > now - this.transient.keepS);
    for (const b of this.batches) frameMatrix(plan, b.recipe.frame, this.origin, b.frame);
  }

  private clearFalling(): void {
    this.transient.clear();
    this.batches = [];
  }

  /**
   * Presentation of the last strike at clock time `at`: the parts it took away become pieces that fall in the frame of
   * their structure, in the order of the strike's timeline, and their rubble grows in where they land. The state is
   * already final; this only schedules what the clock will show.
   */
  private present(plan: WorldPlan, at: number): void {
    const scope = structureScope(plan);
    let room = this.transient.room(at);
    for (const c of this.damage.last()) {
      const f = this.fulls.get(c.key);
      const after = this.damage.states(c.key);
      if (!f || !after) continue;
      const r = f.recipe;
      const ground = frameGround(plan, scope, r.frame);
      const frame = frameMatrix(plan, r.frame, this.origin, new Float32Array(16));
      for (const p of c.parts) {
        const list: FallChange[] = [];
        p.changes.forEach((ch, k) => {
          if (ch.to === DAMAGE.gone) list.push({ part: ch.part, hit: ch.cause === 'damage', delay: (p.timeline[k] ?? 0) * TIMELINE_TICK_S });
        });
        const index = r.specs.findIndex((s) => s.id === p.id);
        const desc = f.descs.find((d) => d.id === p.id);
        const state = after.get(p.id);
        if (list.length === 0 || index < 0 || !desc || !state) continue;
        // The part as it stood, drawn part by part: the pieces are cut out of it.
        const before = buildBuildingMesh(r.specs, [], ground, STRUCTURE_DIMS, { states: c.before, byParts: true, only: new Set([index]) }).mesh;
        const out = fallPieces({ desc, state, before, changes: list, event: c.event, at, groundAt: ground, budget: room });
        room = Math.max(0, room - out.pieces);
        if (out.mesh.count > 0) {
          const id = this.transient.addBatch({ data: out.mesh, material: this.fallMat, uniforms: { ...this.structUniforms, u_frame: { mat4: frame } }, start: out.start, end: out.end, pieces: out.pieces, dust: out.dust });
          this.batches.push({ id, recipe: r, frame, end: out.end });
        }
        let last = { start: at, seconds: 0.7 };
        for (const [part, a] of out.arrivals) {
          this.arrivals.set(`${c.key}:${p.id}:${part}`, a);
          if (a.start > last.start) last = a;
        }
        // A ruin leaves one heap (part 0): it grows in with the last piece.
        if (state.ruin) this.arrivals.set(`${c.key}:${p.id}:0`, last);
      }
    }
  }

  /**
   * The structure part hit by a ray from `from` along `dir` (both in the body's frame), among the near structures:
   * its key and the point in the body's frame. Null when the ray hits none.
   */
  pick(from: Vec3, dir: Vec3): { key: number; point: Vec3 } | null {
    const plan = this.plan;
    if (!plan) return null;
    const R = plan.grid.radiusM;
    let best: { key: number; point: Vec3; t: number } | null = null;
    for (const r of this.nearSet) {
      const f = this.fulls.get(r.key);
      if (!f?.mesh) continue;
      const fr = r.frame;
      const rr = R + fr.heightM;
      const P: Vec3 = [fr.origin[0] * rr, fr.origin[1] * rr, fr.origin[2] * rr];
      const d: Vec3 = [from[0] - P[0], from[1] - P[1], from[2] - P[2]];
      const into = (v: Vec3): [number, number, number] => [v[0] * fr.x[0] + v[1] * fr.x[1] + v[2] * fr.x[2], v[0] * fr.y[0] + v[1] * fr.y[1] + v[2] * fr.y[2], v[0] * fr.z[0] + v[1] * fr.z[1] + v[2] * fr.z[2]];
      const hit = raycastParts(f.descs, into(d), into(dir));
      if (!hit || (best && hit.t >= best.t)) continue;
      const [x, y, z] = hit.point;
      best = { key: r.key, t: hit.t, point: [P[0] + fr.x[0] * x + fr.y[0] * y + fr.z[0] * z, P[1] + fr.x[1] * x + fr.y[1] * y + fr.z[1] * z, P[2] + fr.x[2] * x + fr.y[2] * y + fr.z[2] * z] };
    }
    return best ? { key: best.key, point: best.point } : null;
  }

  /**
   * A strike at a point of the body's frame with the example's radius and energy; the parts it took away fall (unless
   * `present` is false: then the structures show at once how they end, rubble grown), the rest is rebuilt. Keys changed.
   */
  strikeAt(point: Vec3, radiusM = STRIKE_RADIUS_M, energy = STRIKE_ENERGY, present = true): number[] {
    const plan = this.plan;
    if (!plan) return [];
    const l = Math.sqrt(point[0] ** 2 + point[1] ** 2 + point[2] ** 2);
    const changed = this.damage.strike([point[0] / l, point[1] / l, point[2] / l], l - plan.grid.radiusM, radiusM, energy);
    if (present && this.clock && changed.length > 0) this.present(plan, this.clock());
    this.rebuild(changed);
    return changed;
  }

  /** Rebuilds the held full meshes of the given keys from the damage table (after a strike, a decode or a clear). */
  rebuild(keys: Iterable<number>): void {
    const plan = this.plan;
    if (!plan) return;
    for (const key of keys) {
      const f = this.fulls.get(key);
      if (f) this.build(plan, f.recipe);
    }
    // The massing is checked again on the next update.
    for (const h of this.held.values()) h.skip = '-';
  }

  /** Every held full mesh back to its intact state. */
  clearDamage(): void {
    const keys = this.damage.keys();
    this.damage.clear();
    this.arrivals.clear();
    this.clearFalling();
    this.rebuild(keys);
  }

  stats(): StructureStats {
    let triangles = 0;
    for (const f of [...this.intact.items, ...this.damaged.items]) triangles += f.triangles;
    for (const h of this.held.values()) triangles += h.mesh?.triangles ?? 0;
    return {
      full: this.intact.items.length + this.damaged.items.length,
      massing: this.held.size,
      clusters: this.plan ? clusterCount(this.plan) : 0,
      triangles,
      damaged: this.damage.keys().length,
    };
  }

  override draw(ctx: DrawContext): void {
    if (!this.active || this.held.size === 0) return;
    const program = this.begin(ctx);
    if (!program) return;
    const o = this.origin;
    for (const h of this.held.values()) {
      if (!h.mesh) continue;
      program.vec3v('u_cellOffset', [h.centre[0] - o[0], h.centre[1] - o[1], h.centre[2] - o[2]]);
      ctx.device.draw(h.mesh);
      ctx.count(h.mesh.triangles);
    }
  }

  private dropFulls(): void {
    for (const f of this.fulls.values()) {
      if (f.mesh) this.renderer.device.deleteMesh(f.mesh);
      if (f.rubble) this.renderer.device.deleteMesh(f.rubble);
    }
    this.fulls.clear();
    this.clearFalling();
    this.nearSet = [];
    this.nearKeys = new Set();
    this.intact.items = [];
    this.damaged.items = [];
  }

  dispose(): void {
    for (const h of this.held.values()) if (h.mesh) this.renderer.device.deleteMesh(h.mesh);
    this.held.clear();
    this.dropFulls();
  }
}

/** The massing of a cluster without the items of the given keys: the same vertices, the index list of the rest. */
function joinMassing(m: ClusterMassing, skip: ReadonlySet<number>): MeshData {
  const src = m.mesh.indices as Uint32Array;
  if (skip.size === 0) return m.mesh;
  let n = 0;
  for (let i = 0; i < m.keys.length; i++) if (!skip.has(m.keys[i]!)) n += m.indexSpans[i + 1]! - m.indexSpans[i]!;
  const out = new Uint32Array(n);
  let at = 0;
  for (let i = 0; i < m.keys.length; i++) {
    if (skip.has(m.keys[i]!)) continue;
    const part = src.subarray(m.indexSpans[i]!, m.indexSpans[i + 1]!);
    out.set(part, at);
    at += part.length;
  }
  return { layout: m.mesh.layout, vertices: m.mesh.vertices, indices: out, count: n };
}

/** Whether every part of a structure is a ruin by the damage table. */
function isRuin(states: ReadonlyMap<number, StructureState> | undefined, r: StructureRecipe | null | undefined): boolean {
  if (!states || !r) return false;
  return r.specs.every((s) => states.get(s.id)?.ruin === true);
}
