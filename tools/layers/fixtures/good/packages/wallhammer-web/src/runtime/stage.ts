import { Renderer } from '../render/renderer.ts';
import { rig } from '../camera/rig.ts';
import type { Device } from 'wallhammer-web/gpu';
export function stage(d: Device): number {
  return new Renderer(d).source().length + rig.window;
}
