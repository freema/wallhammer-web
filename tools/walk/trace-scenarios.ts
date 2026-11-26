// Scenarios of ground contacts and what they leave: the engine's contact trail (core `contact-trail.ts`: ring, changed
// span, fade, chains of marks), one-shot particle bursts (gen-core `particle-burst.ts`: deterministic by seed, ring)
// and surface tags of the collision world (`baseTagAt`, `groundTagAt`, a wheel's `surfaceTag`). Pure data, no GPU.

import { CONTACT_TRAIL_FADE_FROM, CONTACT_TRAIL_FLOATS, ContactStreaks, ContactTrail, contactTrailFade } from '../../packages/wallhammer-web/src/core/contact-trail.ts';
import { PARTICLE_FLOATS, ParticleBurstRing } from '../../packages/wallhammer-web/src/gen-core/particle-burst.ts';
import type { ParticleBurst } from '../../packages/wallhammer-web/src/gen-core/particle-burst.ts';
import { CollisionWorld, newRayHit } from '../../packages/wallhammer-web/src/world/collide.ts';
import { WheeledBody, newWheeledIntent } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

/** A plain mark of `kind` at x laid at `time`, living `life`. */
function lay(t: ContactTrail, x: number, kind: number, time: number, life: number): number {
  return t.layRaw(x, 0, 0, 0, 1, 0, 0, 0.2, 0.3, kind, time, life);
}

const trailWrap: Scenario = {
  name: 'trace-trail-ring-wrap',
  run() {
    const t = new ContactTrail(8);
    const slots: number[] = [];
    const spans: string[] = [];
    // Five marks: one span 0–5.
    for (let i = 0; i < 5; i++) slots.push(lay(t, i, 0, i, 10));
    spans.push(`${t.dirtyFrom}-${t.dirtyTo}`);
    const firstSpan = t.dirtyFrom === 0 && t.dirtyTo === 5;
    t.clean();
    // Two more: the span 5–7, right after the clean.
    for (let i = 5; i < 7; i++) slots.push(lay(t, i, 0, i, 10));
    spans.push(`${t.dirtyFrom}-${t.dirtyTo}`);
    const nextSpan = t.dirtyFrom === 5 && t.dirtyTo === 7;
    t.clean();
    // Three more wrap past the end: the whole ring; the oldest two are replaced.
    for (let i = 7; i < 10; i++) slots.push(lay(t, i, 0, i, 10));
    spans.push(`${t.dirtyFrom}-${t.dirtyTo}`);
    const wrapSpan = t.dirtyFrom === 0 && t.dirtyTo === 8;
    const slotsOk = slots.every((s, i) => s === i % 8);
    const newest = t.data[1 * CONTACT_TRAIL_FLOATS]! === 9 && t.data[0]! === 8 && t.data[2 * CONTACT_TRAIL_FLOATS]! === 2;
    const counts = t.count === 8 && t.laid === 10;
    t.clear();
    const cleared = t.count === 0 && t.laid === 0 && t.dirtyFrom === 0 && t.dirtyTo === 8 && !t.busy(0);
    return verdict(firstSpan && nextSpan && wrapSpan && slotsOk && newest && counts && cleared, `slots ${slots.join(',')}; changed spans ${spans.join(', ')}; newest over the oldest ${newest}; count ${8}/${10} ${counts}; clear ${cleared}`);
  },
};

const trailFade: Scenario = {
  name: 'trace-trail-fade',
  run() {
    const life = 10;
    const at = (age: number): number => contactTrailFade(age, life);
    const before = at(-0.01), born = at(0), held = at(CONTACT_TRAIL_FADE_FROM * life), half = at(0.7 * life), late = at(0.99 * life), gone = at(life);
    let monotone = true;
    for (let a = 0, last = 1; a <= life; a += 0.05) {
      const v = at(a);
      if (v > last + 1e-12) monotone = false;
      last = v;
    }
    const t = new ContactTrail(4);
    lay(t, 0, 0, 0, 2);
    lay(t, 1, 0, 1, 5);
    const visible = [t.visible(0.5), t.visible(1.5), t.visible(3), t.visible(6.5)];
    const busy = [t.busy(5.9), t.busy(6)];
    const ok = before === 0 && born === 1 && held === 1 && Math.abs(half - 0.5) < 1e-9 && late > 0 && late < 0.01 && gone === 0 && monotone && visible.join() === '1,2,1,0' && busy[0] === true && busy[1] === false;
    return verdict(ok, `strength at age −0.01 ${before}, 0 ${born}, ${CONTACT_TRAIL_FADE_FROM * life} ${held}, ${0.7 * life} ${f(half)}, ${0.99 * life} ${f(late, 4)}, ${life} ${gone}; never grows ${monotone}; visible at 0.5/1.5/3/6.5 s ${visible.join('/')}; busy at 5.9/6 s ${busy.join('/')}`);
  },
};

const trailStreaks: Scenario = {
  name: 'trace-trail-streaks',
  run() {
    const t = new ContactTrail(64);
    const s = new ContactStreaks(t, 2, { minLength: 0.5, maxLength: 2 });
    let laid = 0;
    // Source 0 moves 0.25 m a sample along −z: a mark every second sample, centred between its ends, heading 0.
    for (let i = 0; i <= 8; i++) if (s.touch(0, true, 3, 0, -0.25 * i, 0, 1, 0, 0.2, 7, i, 5)) laid++;
    const d = t.data;
    const first = { z: d[2]!, heading: d[7]!, length: d[9]!, kind: d[10]! };
    const chainOk = laid === 4 && Math.abs(first.z + 0.25) < 1e-6 && Math.abs(first.heading) < 1e-6 && Math.abs(first.length - 0.5) < 1e-6 && first.kind === 7;
    // Lifting ends the chain: the next touch starts a new one and lays nothing.
    s.touch(0, false, 0, 0, 0, 0, 1, 0, 0.2, 7, 9, 5);
    const restart = !s.touch(0, true, 3, 0, -10, 0, 1, 0, 0.2, 7, 10, 5);
    // A jump past maxLength lays nothing and starts over from there.
    const jump = !s.touch(0, true, 3, 0, -15, 0, 1, 0, 0.2, 7, 11, 5);
    // Source 1 moving along +x: heading −90°.
    s.touch(1, true, 0, 0, 0, 0, 1, 0, 0.2, 1, 0, 5);
    s.touch(1, true, 1, 0, 0, 0, 1, 0, 0.2, 1, 1, 5);
    const h = d[(t.laid - 1) * CONTACT_TRAIL_FLOATS + 7]!;
    const sideOk = Math.abs(h + Math.PI / 2) < 1e-6;
    return verdict(chainOk && restart && jump && sideOk && t.laid === 5, `marks laid ${laid} of 8 samples 0.25 m apart (min 0.5 m), first at z ${f(first.z)} heading ${f(first.heading)} length ${f(first.length)}; lift then touch lays none ${restart}; jump of 5 m lays none ${jump}; heading along +x ${f(h)} (−π/2)`);
  },
};

function dust(seed: number, time = 0): ParticleBurst {
  return { position: [1, 2, 3], time, count: 12, life: 1.5, size: [0.2, 1], rise: 0.6, spread: [0.3, 0.8], velocity: [0.5, 0, -0.2], gravity: 0.4, wind: 0.5, colorStart: [0.5, 0.4, 0.3, 0.6], colorEnd: [0.6, 0.5, 0.4, 0], seed };
}

const burstDeterministic: Scenario = {
  name: 'trace-burst-deterministic',
  run() {
    const a = new ParticleBurstRing(64), b = new ParticleBurstRing(64), c = new ParticleBurstRing(64);
    a.fire(dust(42));
    b.fire(dust(42));
    c.fire(dust(43));
    const same = a.data.every((v, i) => v === b.data[i]);
    let differ = 0;
    for (let i = 0; i < 12 * PARTICLE_FLOATS; i++) if (a.data[i] !== c.data[i]) differ++;
    // Within the disc, the lives within 80–120 %, every record a fired-once one.
    let inDisc = true, lives = true, once = true;
    for (let i = 0; i < 12; i++) {
      const o = i * PARTICLE_FLOATS, d = a.data;
      if (Math.hypot(d[o]! - 1, d[o + 2]! - 3) > 0.3 + 1e-6 || d[o + 1] !== 2) inDisc = false;
      if (d[o + 4]! < 1.2 - 1e-6 || d[o + 4]! > 1.8 + 1e-6) lives = false;
      if (d[o + 23] !== 1) once = false;
    }
    const p = new Float64Array(3);
    const aliveHalf = a.positionAt(0, 0.5, p);
    const rose = p[1]! > 2;
    const aliveLate = a.positionAt(0, 5, p);
    return verdict(same && differ >= 12 * 6 && inDisc && lives && once && aliveHalf && rose && !aliveLate && a.alive(0.5) === 12 && a.alive(5) === 0, `seed 42 twice bit-equal ${same}; seed 43 differs in ${differ} of ${12 * PARTICLE_FLOATS} floats; births in the disc ${inDisc}; lives 80–120 % ${lives}; fired-once records ${once}; alive at 0.5 s ${a.alive(0.5)}, risen ${rose}; at 5 s ${a.alive(5)}`);
  },
};

const burstWrap: Scenario = {
  name: 'trace-burst-ring-wrap',
  run() {
    const r = new ParticleBurstRing(30);
    const spans: string[] = [];
    r.fire(dust(1, 0));
    spans.push(`${r.dirtyFrom}-${r.dirtyTo}`);
    r.fire(dust(2, 0.1));
    spans.push(`${r.dirtyFrom}-${r.dirtyTo}`);
    const joined = r.dirtyFrom === 0 && r.dirtyTo === 24;
    r.clean();
    r.fire(dust(3, 0.2));
    spans.push(`${r.dirtyFrom}-${r.dirtyTo}`);
    const wrapped = r.dirtyFrom === 0 && r.dirtyTo === 30 && r.fired === 36 && r.count === 30 && r.bursts === 3;
    // The third burst's last six particles went to slots 0–5 over the first burst's.
    const over = r.data[3] === Math.fround(0.2) && r.data[6 * PARTICLE_FLOATS + 3] === 0;
    const big = new ParticleBurstRing(5);
    const wrote = big.fire(dust(4));
    r.clear();
    const cleared = r.count === 0 && !r.busy(0) && r.dirtyTo === 30;
    return verdict(joined && wrapped && over && wrote === 5 && cleared, `changed spans ${spans.join(', ')}; fired ${36} in a ring of 30, oldest replaced ${over}; a burst of 12 into a ring of 5 writes ${wrote}; clear ${cleared}`);
  },
};

const surfaceTags: Scenario = {
  name: 'trace-surface-tags',
  run() {
    const loose = (x: number): number => (x > 10 ? 201 : 200);
    const w = new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0, baseTagAt: (x) => loose(x) });
    w.addBox(0, 0, 1, 1, 0, 0, 0.5, { tag: 7 });
    const onBox = w.groundTagAt(0, 0, 1, 0.6);
    const grass = w.groundTagAt(5, 0, 0.1, 0.6);
    const sand = w.groundTagAt(15, 0, 0.1, 0.6);
    const under = w.baseTagAt(0, 0);
    const hit = newRayHit();
    w.raycast(15, 5, 0, 0, -1, 0, 10, hit);
    const rayTag = hit.tag;
    const plain = new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
    const none = plain.groundTagAt(0, 0, 0.1, 0.6);
    plain.raycast(0, 5, 0, 0, -1, 0, 10, hit);
    const noneRay = hit.tag;
    // A wheeled body on the loose half: its wheels report the tag; the same body on grass reports grass.
    const body = new WheeledBody(w);
    const still = newWheeledIntent();
    body.teleport(15, body.restHeight, 5, 0);
    for (let i = 0; i < 30; i++) body.step(still);
    const wheelTags = body.wheels.map((ws) => ws.surfaceTag).join(',');
    body.teleport(5, body.restHeight, 5, 0);
    for (let i = 0; i < 30; i++) body.step(still);
    const grassTags = body.wheels.map((ws) => ws.surfaceTag).join(',');
    const ok = onBox === 7 && grass === 200 && sand === 201 && under === 200 && rayTag === 201 && none === -1 && noneRay === -1 && wheelTags === '201,201,201,201' && grassTags === '200,200,200,200';
    return verdict(ok, `ground tag on a box 7 → ${onBox}, on grass ${grass}, on loose ${sand}; base under the box ${under}; ray onto the base ${rayTag}; without baseTagAt ${none} and ray ${noneRay}; wheels on loose ${wheelTags}, on grass ${grassTags}`);
  },
};

export const TRACE_SCENARIOS: Scenario[] = [trailWrap, trailFade, trailStreaks, burstDeterministic, burstWrap, surfaceTags];
