// Headless cases of the marks for the engine's own cameras (runtime/marks.ts), run by check:follow next to the cases
// of the following view and of the free path. Plain Node, no DOM and no GPU: an engine stand-in with the parts the
// marks use. A view recorded and restored puts the three rigs (free, following, orbit) back exactly (text, eye, axes,
// key), the URL hash carries the page's own hash plus the view, a pick through a height function and through a
// collision world lands on the surface, and the pixel of a picked point comes back from `toScreen`. The DOM side (`installMarking`: the panel, the pins,
// the picture) is not exercised here; it needs a browser.

import type { Vec3 } from '../../packages/wallhammer-web/src/base/math.ts';
import type { View } from '../../packages/wallhammer-web/src/base/view.ts';
import { SteppedOrthoRig } from '../../packages/wallhammer-web/src/camera/camera.ts';
import { FollowRig } from '../../packages/wallhammer-web/src/camera/follow.ts';
import { FreeRig } from '../../packages/wallhammer-web/src/camera/free.ts';
import { PerspectiveOrbitRig } from '../../packages/wallhammer-web/src/camera/orbit.ts';
import { Clock } from '../../packages/wallhammer-web/src/core/clock.ts';
import type { Canvas } from '../../packages/wallhammer-web/src/platform/canvas.ts';
import { hashParam } from '../../packages/wallhammer-web/src/platform/marks/page.ts';
import { collisionPick, engineMarkHost, heightPick, restoreRigView, rigViewText } from '../../packages/wallhammer-web/src/runtime/marks.ts';
import type { MarkEngine } from '../../packages/wallhammer-web/src/runtime/marks.ts';
import { CollisionWorld } from '../../packages/wallhammer-web/src/world/collide.ts';
import type { FollowCase } from './check.ts';

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** A rolling surface over a flat world. */
const ground = (x: number, z: number): number => 12 * Math.sin(x / 40) + 7 * Math.cos(z / 25) + 30;

/** The parts of an engine the marks use; `view` is switched by the cases. */
function fakeEngine(view: View & { width: number; height: number }): MarkEngine & { view: View; frames: number } {
  return {
    canvas: {} as Canvas,
    view,
    env: { day: new Clock({ time: 13.25, wrap: 24 }), time: new Clock({ time: 41.5 }) },
    renderer: { beforeFrame: [] },
    frames: 0,
    renderNow() {
      this.frames++;
    },
    invalidate() {},
  };
}

function freeRig(): FreeRig {
  const r = new FreeRig({ fovYDeg: 50, minClearance: 2 }, { heightAbove: (p) => p[1] - ground(p[0], p[2]) }, { position: [1_000_123.456, 80, -2_000_765.25], yawDeg: 37.123, pitchDeg: 14.7 });
  r.roll = 0.0125;
  r.origin = [1_000_000, 0, -2_000_000];
  r.width = 1280;
  r.height = 720;
  return r;
}

function followRig(clearance: FollowRig['clearance'] = null): FollowRig {
  const r = new FollowRig({ followLag: 0.15, boomReturn: 0.3, pivotHeight: 1.5, minDistance: 0, maxDistance: 12 }, clearance ? { clearance } : {});
  r.width = 1280;
  r.height = 720;
  r.distance = 6;
  r.yawDeg = -25.5;
  r.pitchDeg = 18.25;
  r.follow(10, 2, -4);
  return r;
}

export function runMarkChecks(): FollowCase[] {
  const out: FollowCase[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void out.push({ name: `marks: ${name}`, ok, detail });

  // 1. A free view as text comes back exactly: the same position, axes within rounding of the heading, the same key.
  {
    const a = freeRig();
    const text = rigViewText(a);
    const b = new FreeRig({ fovYDeg: 50, minClearance: 2 }, { heightAbove: (p) => p[1] - ground(p[0], p[2]) });
    b.origin = a.origin;
    b.width = a.width;
    b.height = a.height;
    const ok = restoreRigView(b, text);
    const ax = a.axes();
    const bx = b.axes();
    const axErr = Math.max(dist(ax.forward, bx.forward), dist(ax.right, bx.right), dist(ax.up, bx.up));
    add('free view round trip', ok && same(a.position, b.position) && b.roll === a.roll && axErr < 1e-12 && a.key() === b.key(), `restored ${ok}, position ${same(a.position, b.position) ? 'same' : `${dist(a.position, b.position)} m off`}, axes ${axErr.toExponential(1)}, key ${a.key() === b.key() ? 'same' : 'differs'}`);
  }

  // 2. A following view whose pivot trails a moving point comes back bit for bit, and the followed point is handed to
  //    the caller first; the next follow and update move on from there as they would have from the original.
  {
    const clear: FollowRig['clearance'] = (_ox, _oy, _oz, _dx, _dy, _dz, max) => Math.min(max, 4.25);
    const a = followRig(clear);
    for (let i = 0; i < 5; i++) {
      a.follow(10 + i * 0.4, 2, -4 - i * 0.3);
      a.update(1 / 60);
    }
    const text = rigViewText(a);
    const b = followRig(clear);
    let placed: Vec3 | null = null;
    const ok = restoreRigView(b, text, (t) => void (placed = t));
    const sa = a.state();
    const sb = b.state();
    const exact = same(sa.target, sb.target) && same(sa.pivot, sb.pivot) && sa.yawDeg === sb.yawDeg && sa.pitchDeg === sb.pitchDeg && sa.distance === sb.distance && sa.boom === sb.boom && same(a.eye(), b.eye()) && a.key() === b.key();
    a.update(1 / 60);
    b.update(1 / 60);
    const next = same(a.eye(), b.eye());
    add('follow view round trip', ok && exact && next && placed !== null && same(placed, sa.target), `restored ${ok}, state ${exact ? 'exact' : 'differs'}, next frame ${next ? 'same' : 'differs'}, target handed ${placed ? `[${(placed as Vec3).join(', ')}]` : 'no'}`);
  }

  // 3. A view of the other kind of rig, or a broken text, changes nothing.
  {
    const f = followRig();
    const before = f.key();
    const r1 = restoreRigView(f, rigViewText(freeRig()));
    const r2 = restoreRigView(f, 'follow,1,2,x');
    add('foreign view refused', !r1 && !r2 && f.key() === before, `free text into follow ${r1}, broken text ${r2}, key ${f.key() === before ? 'kept' : 'changed'}`);
  }

  // 4. The host of a free rig: its view carries the page's hash (an old view in it replaced) and the exact view and
  //    clocks; going to it after moving puts the rig and the clocks back.
  {
    const rig = freeRig();
    const eng = fakeEngine(rig);
    const host = engineMarkHost(eng, { pick: heightPick(ground), hash: () => 'seed=7&cam=free&mkview=free,0,0,0,0,0,0&x=1' });
    const v = host.view();
    const text = rigViewText(rig);
    const hashOk = v.hash.startsWith('seed=7&cam=free&x=1&') && hashParam(v.hash, 'mkview') === text && hashParam(v.hash, 'mkclock') === '13.25,41.5';
    const key = rig.key();
    rig.setState({ position: [1_000_500, 300, -2_000_100], yawDeg: -120, pitchDeg: 40 });
    rig.roll = 0;
    eng.env.day.set(20);
    eng.env.time.set(3);
    host.goto(v);
    const back = rig.key() === key && eng.env.day.time === 13.25 && eng.env.time.time === 41.5;
    add('free host view and goto', hashOk && back && host.allowed(), `hash ${hashOk ? 'ok' : v.hash}, back ${back}, allowed ${host.allowed()}`);
  }

  // 5. The pick through a height function lands on the surface, and the picked point's pixel comes back (a render
  //    origin far from zero included).
  {
    const rig = freeRig();
    const host = engineMarkHost(fakeEngine(rig), { pick: heightPick(ground, { topM: 60 }) });
    const px = 700;
    const py = 520;
    const ray = host.ray(px, py);
    const hit = host.pick(ray);
    const s = hit ? host.toScreen(hit.world) : null;
    const gap = hit ? Math.abs(hit.world[1] - ground(hit.world[0], hit.world[2])) : NaN;
    const pxErr = s ? Math.hypot(s[0] - px, s[1] - py) : NaN;
    const sky = host.pick(host.ray(640, 0));
    add('height pick and pixel', !!hit && gap < 0.01 && pxErr < 0.01 && sky === null, hit ? `${hit.distanceM} m away, off the surface ${gap.toExponential(1)} m, pixel ${pxErr.toExponential(1)} px off, ${hit.accuracy.steps} steps; a ray into the sky ${sky ? 'hit' : 'met nothing'}` : 'no hit');
  }

  // 6. The host of a following view picks against a collision world (a box in the middle of the view) and the pixel
  //    comes back; the default facts name the camera.
  {
    const world = new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
    const rig = followRig();
    const centre = rig.screenRay(640, 360);
    // A box 8 m ahead of the eye along the centre ray, 1 m on each side.
    const c: Vec3 = [centre.origin[0] + centre.dir[0] * 8, centre.origin[1] + centre.dir[1] * 8, centre.origin[2] + centre.dir[2] * 8];
    const id = world.addBox(c[0], c[2], 1, 1, 0, 0, c[1] + 1, { tag: 7 });
    const host = engineMarkHost(fakeEngine(rig), { pick: collisionPick(world) });
    const ray = host.ray(640, 360);
    const hit = host.pick(ray);
    const s = hit ? host.toScreen(hit.world) : null;
    const pxErr = s ? Math.hypot(s[0] - 640, s[1] - 360) : NaN;
    const facts = host.facts(hit, ray);
    const below = host.pick(host.ray(640, 700));
    add('collision pick and pixel', !!hit && hit.place.solid === id && hit.place.tag === 7 && hit.distanceM < 8 && pxErr < 0.01 && facts.camera === 'follow' && below?.surface === 'base surface', hit ? `${hit.surface} tag ${hit.place.tag} at ${hit.distanceM} m, pixel ${pxErr.toExponential(1)} px off, lower ray: ${below?.surface ?? 'nothing'}` : 'no hit');
  }

  // 7. An orbit view comes back bit for bit (its own fields, past the clamps of `setState`); its host's view names the
  //    camera, picks through a height function and gives the picked point's pixel back.
  {
    const orbitRig = (): PerspectiveOrbitRig => {
      const r = new PerspectiveOrbitRig({ fovYDeg: 40, minDistance: 5, maxDistance: 400, groundAt: ground, minEyeHeight: 1 });
      r.width = 1280;
      r.height = 720;
      return r;
    };
    const a = orbitRig();
    a.setState({ target: [12.345, 31.5, -7.25], yawDeg: 37.123, pitchDeg: 24.7, distance: 95.5 });
    const text = rigViewText(a);
    const b = orbitRig();
    const ok = restoreRigView(b, text);
    const exact = same(a.target, b.target) && a.yaw === b.yaw && a.pitch === b.pitch && a.distance === b.distance && same(a.eye(), b.eye()) && a.key() === b.key();
    const refused = !restoreRigView(b, rigViewText(freeRig())) && !restoreRigView(freeRig(), text);
    const eng = fakeEngine(a);
    const host = engineMarkHost(eng, { pick: heightPick(ground), hash: () => 'seed=7&yaw=37' });
    const v = host.view();
    const hashOk = v.hash.startsWith('seed=7&yaw=37&') && hashParam(v.hash, 'mkview') === text && v.camera === 'orbit';
    const ray = host.ray(640, 360);
    const hit = host.pick(ray);
    const s = hit ? host.toScreen(hit.world) : null;
    const gap = hit ? Math.abs(hit.world[1] - ground(hit.world[0], hit.world[2])) : NaN;
    const pxErr = s ? Math.hypot(s[0] - 640, s[1] - 360) : NaN;
    a.setState({ yawDeg: -100, pitchDeg: 60, distance: 20 });
    host.goto(v);
    const back = rigViewText(a) === text;
    add('orbit view round trip and host', ok && exact && refused && hashOk && host.allowed() && !!hit && gap < 0.01 && pxErr < 0.01 && back && host.facts(hit, ray).camera === 'orbit', `restored ${ok}, state ${exact ? 'exact' : 'differs'}, foreign texts ${refused ? 'refused' : 'taken'}, hash ${hashOk ? 'ok' : v.hash}, pick ${hit ? `${hit.distanceM} m, off the surface ${gap.toExponential(1)} m, pixel ${pxErr.toExponential(1)} px off` : 'none'}, goto ${back ? 'back' : 'differs'}`);
  }

  // 8. While the engine draws through another kind of view marking is not possible and pins are not placed.
  {
    const ortho = new SteppedOrthoRig({ yawDeg: 0, pitchDegByZoom: [45], pxPerMeterByZoom: [4] });
    ortho.width = 800;
    ortho.height = 600;
    const host = engineMarkHost(fakeEngine(ortho), { pick: heightPick(ground) });
    add('other view not allowed', !host.allowed() && host.toScreen([0, 0, 0]) === null, `allowed ${host.allowed()}`);
  }

  return out;
}
