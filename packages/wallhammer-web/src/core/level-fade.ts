// Level of detail picked from one scalar (for example screen pixels per metre), with a dead band around every
// threshold and a timed transition between neighbouring levels, and the screen-door fade that draws the transition:
// during it both levels are drawn, each fragment by exactly one of them, so nothing pops and nothing needs blending.
// Pure logic and GLSL text: no clock inside (the caller passes the elapsed time), no GPU.

import type { MaterialDesc, PassName, ShaderSource, Uniforms } from '../base/index.ts';

export interface LevelFadeOptions {
  /**
   * Thresholds in descending order. Level 0 is the most detailed; level k + 1 takes over once the value drops below
   * `below[k]`. There are `below.length + 1` levels.
   */
  below: readonly number[];
  /** Dead band around a threshold as a share of it (default 0.15): coarser below `t × (1 − h)`, finer above `t × (1 + h)`. */
  hysteresis?: number;
  /** Seconds a transition between two neighbouring levels takes (default 0.35). 0 switches at once. */
  seconds?: number;
}

/**
 * Chooses a level from a value and moves a continuous position towards it. Position 1.3 means: 30 % of the way from
 * level 1 to level 2. What is drawn at a position comes from `fade` (the `u_fade` value of a layer) and `shown`.
 */
export class LevelFade {
  /** Number of levels. */
  readonly count: number;
  /** Highest level that may be shown now. Lower it while a coarser level is not ready; the position follows. */
  limit: number;
  private readonly below: readonly number[];
  private readonly hysteresis: number;
  private readonly seconds: number;
  private target = 0;
  private pos = 0;
  private started = false;

  constructor(o: LevelFadeOptions) {
    for (let k = 1; k < o.below.length; k++) {
      if (!(o.below[k]! < o.below[k - 1]!)) throw new Error('LevelFade: thresholds must descend');
    }
    this.below = [...o.below];
    this.count = o.below.length + 1;
    this.limit = o.below.length;
    this.hysteresis = o.hysteresis ?? 0.15;
    this.seconds = o.seconds ?? 0.35;
  }

  /** The level the value asks for (ignores `limit` and the transition). */
  get level(): number {
    return this.target;
  }

  /** Where the transition is: a whole number when at rest, between two levels while moving. */
  get position(): number {
    return this.pos;
  }

  /** Whether a transition is under way. */
  get moving(): boolean {
    return this.started && this.pos !== Math.min(this.target, this.limit);
  }

  /**
   * Takes the current value and the time since the last call. The first call places the position on its level without
   * a transition. Returns whether the position still has to move, that is, whether another frame is needed.
   */
  update(value: number, dtSeconds: number): boolean {
    let t = this.target;
    while (t < this.below.length && value < this.below[t]! * (1 - this.hysteresis)) t++;
    while (t > 0 && value > this.below[t - 1]! * (1 + this.hysteresis)) t--;
    this.target = t;
    const goal = Math.min(t, this.limit);
    if (!this.started) {
      this.started = true;
      this.pos = goal;
      return false;
    }
    if (this.pos === goal) return false;
    const step = this.seconds > 0 ? Math.max(0, dtSeconds) / this.seconds : Infinity;
    this.pos = this.pos < goal ? Math.min(goal, this.pos + step) : Math.max(goal, this.pos - step);
    return this.pos !== goal;
  }

  /** Ends the transition at once (after a jump of the view, for example). */
  snap(): void {
    this.pos = Math.min(this.target, this.limit);
    this.started = true;
  }

  /** Whether anything drawn on the levels `first`…`last` is visible at the current position. */
  shown(first: number, last: number = first): boolean {
    return this.pos > first - 1 && this.pos < last + 1;
  }

  /**
   * `u_fade` of something drawn on the levels `first`…`last`: x the share of fragments left out (0 inside the span,
   * growing to 1 one level away), y the side of the pattern (0 when leaving towards coarser levels, 1 towards finer
   * ones). Two neighbouring spans get complementary patterns, so together they cover every fragment exactly once.
   */
  fade(first: number, last: number = first): [number, number] {
    if (this.pos > last) return [Math.min(1, this.pos - last), 0];
    if (this.pos < first) return [Math.min(1, first - this.pos), 1];
    return [0, 0];
  }

  /** The same as a uniform set: `{ u_fade }`. */
  uniforms(first: number, last: number = first): Uniforms {
    return { u_fade: { vec2: this.fade(first, last) } };
  }
}

/**
 * GLSL of the screen-door fade (fragment shader): `uniform vec2 u_fade` (x share of fragments left out 0–1, y > 0.5
 * the complementary side of the pattern) and `bool fadeHidden(vec2 frag)`, called with `gl_FragCoord.xy`. A uniform
 * that is never set is zero: everything is drawn. The threshold is interleaved gradient noise of the fragment
 * position, so the pattern is even at every share and the same in every program.
 */
export const FADE_GLSL = /* glsl */ `uniform vec2 u_fade;
bool fadeHidden(vec2 frag) {
  float t = fract(52.9829189 * fract(dot(floor(frag), vec2(0.06711056, 0.00583715))));
  return (u_fade.y > 0.5 ? 1.0 - t : t) < u_fade.x;
}
`;

const MAIN = 'void main() {';

/** A fragment shader with the screen-door fade added in front of everything else in `main`. */
export function fadeFragment(fs: string): string {
  const at = fs.indexOf(MAIN);
  if (at < 0 || fs.indexOf(MAIN, at + MAIN.length) >= 0) throw new Error('fadeFragment: the shader must have exactly one "void main() {"');
  return `${fs.slice(0, at)}${FADE_GLSL}${MAIN}\n  if (fadeHidden(gl_FragCoord.xy)) discard;${fs.slice(at + MAIN.length)}`;
}

/**
 * The material with the screen-door fade in every pass that has its own program (`u_fade`, see `FADE_GLSL`). A pass
 * drawn by the plain depth program (`'depth'`) stays as it is. The original description is not touched.
 */
export function withFade(desc: MaterialDesc): MaterialDesc {
  const passes: Partial<Record<PassName, ShaderSource | 'depth'>> = {};
  for (const name of Object.keys(desc.passes) as PassName[]) {
    const src = desc.passes[name]!;
    passes[name] = src === 'depth' ? src : { vs: src.vs, fs: fadeFragment(src.fs) };
  }
  return { ...desc, name: `${desc.name}+fade`, passes };
}
