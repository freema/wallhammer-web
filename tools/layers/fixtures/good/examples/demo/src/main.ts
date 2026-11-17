// An example owns its page: DOM is fine, WebGL goes through the engine.
import { Renderer } from 'wallhammer-web/render';
import { add } from 'wallhammer-web';
import { scene } from './scene.ts';
// Examples other than minimal-3d and endless may use the content modules.
import { shape } from 'wallhammer-web/gen-ground';
const canvas = document.querySelector('canvas');
console.log(canvas, new Renderer({} as never), add(1, scene), shape());
