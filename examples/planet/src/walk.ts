// Walking on the planet (key G, `walk=1`): the engine's `ChartWalker` on the ground the cells draw, seen through a
// `ChartFollowView`, with the shared pathfinder figure for the body.
//
// The figures (walk-scene.ts). `WalkBody`: a `FigureGait` of examples/shared, the engine's `MotionGraph` over the
// figure's own motions: stand ↔ walk ↔ run cross-fade on the walker's ground speed, a state in the air (`leap`) after a
// short time off the ground or at once on a jump, and back by the speed on landing. Walk and run take their phase from
// the distance the walker has travelled over the stride of the speed, so the feet do not slide; the walker turns toward
// its heading at `WALK_SETUP.turnSpeed` and the figure faces where it is drawn. The pose is solved in the walker's
// chart, where +y is up, and stood on the sphere with the chart's frame at the feet. `WalkScene` adds a second figure
// standing near the start (solid for the walker), a box and a book, and the acts (keys E, T, J, X: greet and give the
// box, wave, read, sit). The parts are instance sets of one layer per figure and one for the props, lit as the
// planet's objects are (sun, shadows, sky light, the air) and drawn into the shadow map. `drive` (`__wh.walkFor`)
// advances the walker, the motion and the acts by the same fixed frames.
//
// The ground. The walker stands on the triangles of the finest level of the
// terrain (level 11, a vertex every 2.4 m), found by `spherePatchRadius` from the same height function and grid as the
// cells, and on the level of the sea where the ground lies under it. The heights of the mesh's vertices are kept in a
// small memo: each is about fourteen octaves of noise, and a step asks for the same few vertices again and again.
//
// Trees and rocks are solid (`OBJECT_SOLIDS` of world.ts): the page keeps an index of the objects of the resident cells
// of `OBJECT_LEVEL` (main.ts, `streamSolids`), and a `SolidFeed` puts those near the walker into every new chart's
// collision world and keeps it in step while cells come and go, so the body and the camera's boom stop at them.
//
// Limits: shrubs and the strips' own meshes are not solid; a solid is laid flat in its chart and is a trunk or a box,
// not the shape that is drawn; where the view shows a coarser level than the finest
// (farther than a few hundred metres), the feet may stand off that coarser mesh by its screen error; `extra=lift`
// raises cliffs in the shader only, so the feet stand on the unlifted ground there.

import type { MaterialDesc, Vec3 } from 'wallhammer-web/base';
import { ChartFollowView, FollowRig } from 'wallhammer-web/camera';
import { cubeFaceOf, spherePatchRadius } from 'wallhammer-web/gen-core';
import type { SpherePatchSplit } from 'wallhammer-web/gen-core';
import { bindWalkInput } from 'wallhammer-web/platform';
import type { WalkInput, WalkInputState } from 'wallhammer-web/platform';
import { BoneInstances, DEPTH_FS, INSTANCE_SET_GLSL, InstanceSetLayer, instanceSet, instanceSetAttribs } from 'wallhammer-web/render';
import type { BonePart, InstanceSet, Renderer } from 'wallhammer-web/render';
import type { MeshData } from 'wallhammer-web/base';
import { ChartWalker, SolidFeed, newWalkIntent } from 'wallhammer-web/world';
import type { RadiusAt, SolidIndex } from 'wallhammer-web/world';
import { FigureParts } from '../../shared/src/figures/parts.ts';
import { PATHFINDER_TAIL } from '../../shared/src/figures/pathfinder.ts';
import { moveProfile } from '../../shared/src/figures/profiles.ts';
import type { MoveProfile } from '../../shared/src/figures/profiles.ts';
import { WALK_SETUP, WalkBody, WalkScene, meetPlace } from './walk-scene.ts';
import type { WalkActName } from './walk-scene.ts';
import { LEAF_LEVEL, QUADS, RADIUS_M, SHAPE, latLonOf } from './world.ts';

export { WALK_SETUP, WalkBody, WalkScene, meetPlace };

/** Vertex heights kept by `drawnGroundRadius` before the memo starts over. */
const MEMO_SIZE = 4096;

/**
 * Distance from the centre of the ground the walker stands on in a unit direction: the triangles of the finest level's
 * mesh built from `heightAt` (the cells' own height function, with their `split`), or the sea's level where that lies
 * lower. Counts its calls of `heightAt` in `stats`.
 */
export function drawnGroundRadius(heightAt: (x: number, y: number, z: number) => number, split?: SpherePatchSplit): { radiusAt: RadiusAt; stats: { calls: number; heights: number } } {
  const memo = new Map<string, number>();
  const stats = { calls: 0, heights: 0 };
  const cached = (x: number, y: number, z: number): number => {
    const k = `${x},${y},${z}`;
    let h = memo.get(k);
    if (h === undefined) {
      if (memo.size >= MEMO_SIZE) memo.clear();
      h = heightAt(x, y, z);
      stats.heights++;
      memo.set(k, h);
    }
    return h;
  };
  const cells = 2 ** LEAF_LEVEL;
  const o = { radiusM: RADIUS_M, face: 0, level: LEAF_LEVEL, x: 0, y: 0, quads: QUADS, heightAt: cached, ...(split && split !== 'fixed' ? { split } : {}) };
  const d: [number, number, number] = [0, 0, 0];
  const radiusAt: RadiusAt = (x, y, z) => {
    stats.calls++;
    d[0] = x;
    d[1] = y;
    d[2] = z;
    const f = cubeFaceOf(d);
    o.face = f.face;
    o.x = Math.min(cells - 1, Math.max(0, Math.floor(((f.s + 1) / 2) * cells)));
    o.y = Math.min(cells - 1, Math.max(0, Math.floor(((f.t + 1) / 2) * cells)));
    return Math.max(RADIUS_M, spherePatchRadius(o, d, 1));
  };
  return { radiusAt, stats };
}

/**
 * The looks of the walking figure and of the one standing near the start (`PATHFINDER` looks: 0 is the red cloak with
 * the lantern on its pole, here with a ponytail behind its spiky hair, which lags behind its motion).
 */
const FIGURE_VARIANT = 0 + PATHFINDER_TAIL;
const OTHER_VARIANT = 2;
/** Light of the lantern's glass against a white face in full sun. */
const FIGURE_GLOW = 2.4;

const FIGURE_VS = /* glsl */ `#include <header>
#include <atmosphere>
in vec3 a_pos;
in vec3 a_normal;
in vec4 a_color; // rgb colour, w material: 0 plain, 1 times the instance's tint, 2 a light
${INSTANCE_SET_GLSL}
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_material;
out vec3 v_air;
out vec3 v_airThrough;
void main() {
  vec3 w = instancePoint(a_pos);
  v_world = w;
  v_normal = instanceNormal(a_normal);
  v_color = a_color.w > 0.5 && a_color.w < 1.5 ? a_color.rgb * i_extra.rgb : a_color.rgb;
  v_material = a_color.w;
  v_air = atmosphereAir(w, v_airThrough);
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

const FIGURE_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
${INSTANCE_SET_GLSL}
void main() {
  gl_Position = u_lightRender * vec4(instancePoint(a_pos), 1.0);
}`;

const FIGURE_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <atmosphere>
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_material;
in vec3 v_air;
in vec3 v_airThrough;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float sun = sunVisibility(v_world, n, 1.0);
#ifdef WH_ATMOSPHERE
  sun *= u_cloudFieldLight.y;
  vec3 lit = v_color * atmosphereLight(v_world, n, sun, 1.0);
#else
  vec3 lit = v_color * u_warmTint.rgb * lightOnAt(v_world, n, sun, 1.0);
#endif
  // The lantern's glass shines by day and more once the sun is down at this place.
  float dark = 1.0 - smoothstep(-0.06, 0.3, dot(u_sunDir.xyz, localUp(v_world)));
  if (v_material > 1.5) lit = mix(lit, v_color * ${FIGURE_GLOW.toFixed(2)}, 0.55 + 0.45 * dark);
  o_color = vec4(atmosphereApply(applyFog(toDisplay(lit), v_world), v_world, v_air, v_airThrough), 1.0);
}`;

/** The walking figure's parts: position, normal, colour and material per vertex, then the engine's instance record. Lit like the planet's objects. */
export const FIGURE_MATERIAL: MaterialDesc = {
  name: 'walk-figure',
  attribs: { a_pos: 0, a_normal: 1, a_color: 2, ...instanceSetAttribs(3) },
  passes: { shadow: { vs: FIGURE_DEPTH_VS, fs: DEPTH_FS }, color: { vs: FIGURE_VS, fs: FIGURE_FS } },
};

/** Held things as instance sets in one layer: a mesh per transform of an array (12 numbers each). */
class PropParts {
  readonly sets: InstanceSet[] = [];
  private readonly bones: BoneInstances;

  constructor(renderer: Renderer, meshes: readonly MeshData[]) {
    const layer = new InstanceSetLayer(renderer, { name: 'walk-props', material: renderer.material(FIGURE_MATERIAL) });
    const parts: BonePart[] = meshes.map((mesh, i) => {
      const set = instanceSet(mesh, 1, { name: `walk-prop ${i}`, visible: false });
      set.count = 1;
      set.data[12] = 1;
      set.data[13] = 1;
      set.data[14] = 1;
      set.data[15] = 1;
      layer.add(set);
      this.sets.push(set);
      return { bone: i, set, record: 0 };
    });
    this.bones = new BoneInstances(parts);
    renderer.add(layer);
  }

  /** Shows the props whose bit is set in `mask` (bit i: prop i). */
  show(mask: number): void {
    this.sets.forEach((s, i) => {
      const on = (mask & (1 << i)) !== 0;
      if (s.visible !== on) {
        s.visible = on;
        s.dirty = true;
      }
    });
  }

  write(transforms: Float64Array): void {
    this.bones.write(transforms);
  }
}

/** The walk mode of the page: walker, following view, controls and marker. */
export class PlanetWalk {
  readonly walker: ChartWalker;
  readonly rig: FollowRig;
  readonly view: ChartFollowView;
  readonly input: WalkInput;
  /** The figure: its gait and pose (`WalkBody`) and its parts on the GPU. */
  readonly body: WalkBody;
  /** Both figures, the box and the book, and the acts. */
  readonly scene: WalkScene;
  private readonly parts: FigureParts;
  private readonly otherParts: FigureParts;
  private readonly props: PropParts;
  /** The objects of the resident cells, and the feed that puts those near the walker into the current chart's world. */
  readonly solids: SolidIndex | null;
  readonly feed: SolidFeed | null;
  /** Calls of the ground's radius and heights computed since the start (the memo's misses). */
  readonly ground: { calls: number; heights: number };
  private on = false;
  private readonly radiusAt: RadiusAt;
  private readonly state: WalkInputState = { forward: 0, right: 0, run: false, jump: false };
  private readonly intent = newWalkIntent();
  private readonly fw = [0, 0, 0];
  private readonly at = new Float64Array(3);

  constructor(o: {
    renderer: Renderer;
    canvas: HTMLCanvasElement;
    heightAt: (x: number, y: number, z: number) => number;
    split?: SpherePatchSplit;
    fovDeg: number;
    onChange: () => void;
    solids?: SolidIndex;
    /** Where the second figure stands: the walk's start (feet, world) and the way the walker faces there. */
    meet: { feet: readonly number[]; toward: readonly number[] };
    /** The walker's movement profile (profiles.ts of examples/shared; `profile=`). Default the default one. */
    profile?: MoveProfile;
  }) {
    const g = drawnGroundRadius(o.heightAt, o.split);
    this.ground = g.stats;
    this.radiusAt = g.radiusAt;
    this.solids = o.solids ?? null;
    const feed = o.solids ? new SolidFeed(o.solids) : null;
    this.feed = feed;
    const profile = o.profile ?? moveProfile(null);
    const scene = new WalkScene({ center: SHAPE.centerM, radiusAt: g.radiusAt, place: meetPlace(o.meet.feet, o.meet.toward, SHAPE.centerM), profile });
    this.scene = scene;
    // Every new chart: the objects near the walker and the second figure as solids.
    this.walker = new ChartWalker({
      radiusM: RADIUS_M,
      center: SHAPE.centerM,
      radiusAt: g.radiusAt,
      walker: { ...WALK_SETUP, ...profile.walker },
      onRechart: (chart, world) => {
        if (feed) feed.attach(world, chart);
        scene.attach(chart, world);
      },
    });
    const w = this.walker;
    this.rig = new FollowRig(
      // The pivot a little over the head, so a low boom keeps the figure in the lower third and the horizon in frame.
      { fovDeg: o.fovDeg, near: 0.1, far: 1e7, minDistance: 0, maxDistance: 40, pivotHeight: 2.1 },
      // The boom stops 0.25 m short of the ground of the current chart.
      { clearance: (ox, oy, oz, dx, dy, dz, max) => w.world.clearance(ox, oy, oz, dx, dy, dz, max, 0.25) },
    );
    this.rig.distance = 6.5;
    this.rig.pitchDeg = 8;
    this.view = new ChartFollowView(this.rig, w.chart);
    this.input = bindWalkInput(o.canvas, this.rig, { onChange: o.onChange });
    this.input.enabled = false;
    this.body = scene.hero;
    const mat = o.renderer.material(FIGURE_MATERIAL);
    this.parts = new FigureParts(o.renderer, 'walk-figure', mat, this.body.kind, FIGURE_VARIANT);
    this.otherParts = new FigureParts(o.renderer, 'walk-other', mat, scene.other.kind, OTHER_VARIANT);
    o.renderer.add(this.parts.layer);
    o.renderer.add(this.otherParts.layer);
    const pr = this.body.kind.props!;
    this.props = new PropParts(o.renderer, [pr['box']!, pr['bookBack']!, pr['bookFront']!]);
  }

  get active(): boolean {
    return this.on;
  }

  /**
   * Puts the body on the ground under a world point, facing the horizontal part of `forward`, and the view behind it
   * with `pitchDeg`; the walk mode starts.
   */
  enter(point: readonly number[], forward: readonly number[], pitchDeg = 12): void {
    const w = this.walker;
    const c = SHAPE.centerM;
    w.teleportDirection([point[0]! - c[0], point[1]! - c[1], point[2]! - c[2]], 0, [forward[0]!, forward[1]!, forward[2]!]);
    this.view.setChart(w.chart);
    this.rig.yawDeg = (w.yaw * 180) / Math.PI;
    this.rig.pitchDeg = pitchDeg;
    w.renderChartPosition(this.at);
    this.rig.setState({ target: [this.at[0]!, this.at[1]!, this.at[2]!], pivot: [this.at[0]!, this.at[1]! + this.rig.setup.pivotHeight, this.at[2]!] });
    this.rig.snap();
    this.scene.reset(w);
    this.input.enabled = true;
    this.parts.visible = true;
    this.otherParts.visible = true;
    this.on = true;
  }

  /** Ends the walk mode (the page puts its free camera back). */
  exit(): void {
    this.on = false;
    this.input.enabled = false;
    this.parts.visible = false;
    this.otherParts.visible = false;
    this.props.show(0);
  }

  /** The walker's movement profile. */
  get profile(): MoveProfile {
    return this.body.profile;
  }

  /** Another movement profile: the walker is retuned and the figure gets a gait of the profile's build. */
  setProfile(p: MoveProfile): void {
    this.walker.retune(p.walker);
    this.body.setProfile(p);
    this.body.reset(this.walker);
  }

  /** An act of the walker (`WalkScene.act`); returns what came of it. */
  act(name: WalkActName | 'meet'): string {
    return name === 'meet' ? this.scene.meetKey(this.walker) : this.scene.act(name, this.walker);
  }

  /** One frame: controls → walker → view. `dt` in seconds. Returns whether anything still moves. */
  frame(dt: number): boolean {
    return this.step(this.input.read(this.state, dt), dt);
  }

  /**
   * Frames of `dt` for `seconds` with fixed controls (a script's walk; the keys are not read). The figure's motion
   * advances by the same frames, so the pose after a drive is a function of the drives alone.
   */
  drive(seconds: number, forward: number, right: number, run: boolean, dt: number): void {
    const s: WalkInputState = { forward, right, run, jump: false };
    const n = Math.max(0, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) this.step(s, dt);
  }

  /** The state of the walk for a script: feet, height above the ground, recharts, the view and the ground's cost. */
  report(): Record<string, unknown> {
    const w = this.walker;
    const feet = w.position([0, 0, 0] as Vec3);
    const [lat, lon] = latLonOf(SHAPE.directionOf(feet));
    const eye = this.view.worldEye();
    return {
      active: this.on,
      lat,
      lon,
      feet,
      heightAboveGroundM: w.heightAboveGround,
      grounded: w.grounded,
      travelledM: w.travelled,
      recharts: w.recharts,
      chartDistanceM: w.chartDistance,
      eye,
      boomM: this.rig.boom,
      distanceM: this.rig.distance,
      eyeAboveDrawnGroundM: SHAPE.altitude(eye) - (this.radiusAt(...SHAPE.directionOf(eye)) - RADIUS_M),
      ground: { ...this.ground },
      solids: { indexed: this.solids?.solidCount ?? 0, cells: this.solids?.cellCount ?? 0, inChart: this.feed?.count ?? 0 },
      figure: this.figureReport(),
      acts: this.scene.report(w),
    };
  }

  /** The figure: the graph's state and the weights of its states, the smoothed speed, the stride, the fit and the stance foot's gap. */
  figureReport(): { state: string; weights: Record<string, number>; speedMs: number; stride: number; airS: number; fit: number; footGapM: number; profile: string; accelMs2: number; push: number; brace: number; tailDeg: number } {
    const g = this.body.gait;
    const weights: Record<string, number> = {};
    for (const st of ['stand', 'walk', 'run', 'air', 'sitDown', 'sit', 'standUp']) weights[st] = g.graph.weightOf(st, 'body');
    return { state: g.state, weights, speedMs: g.speed, stride: g.stride, airS: g.airSeconds, fit: g.fit, footGapM: this.body.footGap, profile: this.body.profile.name, accelMs2: g.accel, push: g.graph.getParam('push'), brace: g.graph.getParam('brace'), tailDeg: (this.body.lagAngle * 180) / Math.PI };
  }

  /** The walk's part of the page's HUD line: the figure's state and speed, on the ground or not, the solids near. */
  hudText(): string {
    const g = this.body.gait;
    const near = this.solids ? this.solidsNear(10).count : 0;
    const sc = this.scene;
    const act = sc.meet ? `meeting: ${sc.meet.phase}` : sc.read ? `book: ${sc.read.phase}` : sc.note;
    return `walk ${g.state}  ·  ${g.speed.toFixed(1)} m/s  ·  ${this.body.profile.name} (P)  ·  ${this.walker.grounded ? 'on the ground' : 'in the air'}  ·  ${near} solid${near === 1 ? '' : 's'} within 10 m  ·  the other ${sc.distance(this.walker).toFixed(1)} m${act ? `  ·  ${act}` : ''}`;
  }

  /**
   * The solids within `radius` metres of the feet (of `point` when given), nearest first: archetype, distance past
   * their radius, radius, height, and whether they are boxes.
   */
  solidsNear(radius: number, point?: readonly [number, number, number]): { count: number; list: { archetype: string; distanceM: number; radiusM: number; heightM: number; box: boolean; id: string }[] } {
    const list: { archetype: string; distanceM: number; radiusM: number; heightM: number; box: boolean; id: string }[] = [];
    if (!this.solids) return { count: 0, list };
    const at = point ?? (this.walker.position([0, 0, 0]) as [number, number, number]);
    const count = this.solids.within(at, radius, (h) => list.push({ archetype: h.archetype, distanceM: h.distance, radiusM: h.radius, heightM: h.height, box: h.halfX > 0, id: `${h.idHigh}:${h.idLow}` }));
    list.sort((a, b) => a.distanceM - b.distanceM);
    return { count, list };
  }

  private step(s: WalkInputState, dt: number): boolean {
    const rig = this.rig;
    const w = this.walker;
    rig.forward(this.fw);
    const fw = this.fw;
    this.intent.moveX = fw[0]! * s.forward - fw[2]! * s.right;
    this.intent.moveZ = fw[2]! * s.forward + fw[0]! * s.right;
    this.intent.run = s.run;
    this.intent.jump = s.jump;
    this.scene.steer(w, this.intent, s.forward !== 0 || s.right !== 0, s.run && (s.forward !== 0 || s.right !== 0), s.jump);
    w.advance(dt, this.intent);
    this.scene.update(dt, w);
    // A rechart moves the view into the new chart without moving the picture.
    this.view.setChart(w.chart);
    w.renderChartPosition(this.at);
    rig.follow(this.at[0]!, this.at[1]!, this.at[2]!);
    rig.update(dt);
    const v = w.walker.velocity;
    const t = rig.target;
    const p = rig.pivot;
    // The pivot's lag and a boom growing back also need frames.
    const settling = Math.abs(p[0] - t[0]) + Math.abs(p[1] - t[1] - rig.setup.pivotHeight) + Math.abs(p[2] - t[2]) > 1e-4 || rig.boom < rig.distance;
    // The figure moves on its own while standing (breath, the cloak in the wind): the page draws on while walking.
    // The figure moves on its own while standing (breath, the cloak in the wind): the page draws on while walking or
    // while an act plays.
    return s.forward !== 0 || s.right !== 0 || s.jump || !w.grounded || settling || Math.hypot(v[0]!, v[1]!, v[2]!) > 1e-3 || this.body.gait.speed > 1e-3 || this.body.gait.state !== 'stand' || this.scene.busy;
  }

  /** Poses the figure and places its parts for the render origin `origin` (after the page has moved it this frame). */
  draw(origin: readonly [number, number, number]): void {
    this.view.origin = [origin[0], origin[1], origin[2]];
    const sc = this.scene;
    sc.pose(this.walker);
    sc.toRender(this.walker, origin);
    this.parts.write(sc.hero.bones);
    this.otherParts.write(sc.other.bones);
    this.props.write(sc.propsRender);
    this.props.show(1 | (sc.bookOut ? 6 : 0));
  }
}
