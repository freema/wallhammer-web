// Skeletons, poses and bone masks as plain data. A skeleton is a list of bones, parents before children, each hung
// off its parent at a fixed joint. A pose holds per bone a local rotation (unit quaternion [x, y, z, w]) and an
// offset added to the joint; the rest pose is the identity rotation and a zero offset. A mask holds a weight 0–1 per
// bone. Nothing here knows what a skeleton stands for: the game names its bones and writes its own motions.

/** One bone: its name, the index of its parent (−1 for a root) and its joint in the parent's frame. */
export interface BoneSpec {
  name: string;
  /** Index of the parent bone, earlier in the list; −1 for a root (placed by the `root` matrix of `solvePose`). */
  parent: number;
  /** Joint position in the parent's frame (for a root: in the frame of the `root` matrix). */
  joint: readonly [number, number, number];
}

/** Bones in parent-before-child order, as typed arrays. Built once; shared by every figure of that build. */
export class Skeleton {
  readonly count: number;
  readonly names: readonly string[];
  /** Parent of every bone, −1 for roots. */
  readonly parent: Int16Array;
  /** Joint of every bone in its parent's frame, 3 numbers per bone. */
  readonly joint: Float32Array;
  private readonly byName = new Map<string, number>();

  constructor(bones: readonly BoneSpec[]) {
    const n = bones.length;
    if (n > 32767) throw new Error('Skeleton: too many bones');
    this.count = n;
    this.names = bones.map((b) => b.name);
    this.parent = new Int16Array(n);
    this.joint = new Float32Array(n * 3);
    bones.forEach((b, i) => {
      if (b.parent >= i || b.parent < -1) throw new Error(`Skeleton: bone ${b.name} must come after its parent`);
      if (this.byName.has(b.name)) throw new Error(`Skeleton: two bones named ${b.name}`);
      this.byName.set(b.name, i);
      this.parent[i] = b.parent;
      this.joint[i * 3] = b.joint[0];
      this.joint[i * 3 + 1] = b.joint[1];
      this.joint[i * 3 + 2] = b.joint[2];
    });
  }

  /** Index of a bone by name; throws when there is none. */
  index(name: string): number {
    const i = this.byName.get(name);
    if (i === undefined) throw new Error(`Skeleton: no bone ${name}`);
    return i;
  }

  /** Index of a bone by name, or −1. */
  find(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /** True when `bone` is `ancestor` or lies below it. */
  isBelow(bone: number, ancestor: number): boolean {
    for (let b = bone; b >= 0; b = this.parent[b]!) if (b === ancestor) return true;
    return false;
  }
}

/** Local pose: per bone a rotation (quaternion x, y, z, w) and an offset added to the joint. Plain typed arrays. */
export class Pose {
  readonly skeleton: Skeleton;
  /** 4 numbers per bone, [x, y, z, w]. */
  readonly rot: Float32Array;
  /** 3 numbers per bone, added to the bone's joint. */
  readonly offset: Float32Array;

  constructor(skeleton: Skeleton) {
    this.skeleton = skeleton;
    this.rot = new Float32Array(skeleton.count * 4);
    this.offset = new Float32Array(skeleton.count * 3);
    this.reset();
  }

  /** The rest pose: identity rotations, zero offsets. */
  reset(): void {
    const r = this.rot;
    for (let i = 0; i < r.length; i += 4) {
      r[i] = 0;
      r[i + 1] = 0;
      r[i + 2] = 0;
      r[i + 3] = 1;
    }
    this.offset.fill(0);
  }

  copy(from: Pose): void {
    this.rot.set(from.rot);
    this.offset.set(from.offset);
  }
}

/** Per-bone weights 0–1, built from bone names (with or without descendants). */
export type BoneMask = Float32Array;

export interface BoneMaskOptions {
  /** Also the bones below each named bone. Default true. */
  descendants?: boolean;
  /** Weight given to the named bones. Default 1. */
  weight?: number;
  /** Start from this mask instead of zeros (it is copied, not changed). */
  from?: BoneMask;
}

/** A mask with `weight` on the named bones (and by default everything below them), 0 elsewhere. For setup. */
export function boneMask(skeleton: Skeleton, names: readonly string[], o: BoneMaskOptions = {}): BoneMask {
  const m = new Float32Array(skeleton.count);
  if (o.from) m.set(o.from);
  const w = o.weight ?? 1;
  const deep = o.descendants ?? true;
  const picked = names.map((n) => skeleton.index(n));
  for (let b = 0; b < skeleton.count; b++) {
    for (const p of picked) {
      if (b === p || (deep && skeleton.isBelow(b, p))) {
        m[b] = w;
        break;
      }
    }
  }
  return m;
}
