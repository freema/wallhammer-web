import type { Device } from '../gpu/device.ts';
import { add } from '../base/math.ts';
const SHADER = /* glsl */ `#version 300 es
void main() { gl_Position = vec4(${add(1, 2)}.0); }`;
export class Renderer {
  constructor(readonly device: Device) {}
  source(): string {
    return SHADER;
  }
}
