// A minimal PNG reader and writer for the dev tools, on node:zlib alone: 8-bit truecolour with or without alpha, not
// interlaced (what a browser's canvas encoder writes). Used by the marks store (marks-store.ts) to circle a point in a
// picture and to tell an empty read-back of a canvas from a picture.

import { deflateSync, inflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Picture {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA). */
  channels: 3 | 4;
  /** Rows top to bottom, `width * channels` bytes each. */
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The pixels of a PNG, or a message why it cannot be read here. */
export function readPng(png: Buffer): Picture | string {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return 'not a PNG';
  let at = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 4;
  const idat: Buffer[] = [];
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) return `unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`;
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!width || !height || !idat.length) return 'PNG without a header or image data';
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return 'PNG image data too short';
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? data[row + x - channels]! : 0;
      const b = y > 0 ? data[prev + x]! : 0;
      const c = x >= channels && y > 0 ? data[prev + x - channels]! : 0;
      data[row + x] = (filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
    }
  }
  return { width, height, channels, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** A PNG of the pixels (every row with the `up` filter). */
export function writePng(p: Picture): Buffer {
  const stride = p.width * p.channels;
  const raw = Buffer.alloc(p.height * (stride + 1));
  for (let y = 0; y < p.height; y++) {
    raw[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = (p.data[y * stride + x]! - (y > 0 ? p.data[(y - 1) * stride + x]! : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(p.width, 0);
  ihdr.writeUInt32BE(p.height, 4);
  ihdr[8] = 8;
  ihdr[9] = p.channels === 4 ? 6 : 2;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

/** True when every byte of the picture is 0: a canvas read after its drawing buffer was cleared. */
export function isBlank(p: Picture): boolean {
  for (const v of p.data) if (v !== 0) return false;
  return true;
}

/** Draws a ring round (`cx`, `cy`) into the picture: a dark rim, then a red line (radius from the picture's height). */
export function ring(p: Picture, cx: number, cy: number): void {
  const r = Math.max(14, Math.round(p.height / 40));
  const line = Math.max(2, Math.round(r / 6));
  const paint = (half: number, rgb: readonly [number, number, number], alpha: number): void => {
    const reach = Math.ceil(r + half + 1);
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(p.height - 1, Math.ceil(cy + reach)); y++)
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(p.width - 1, Math.ceil(cx + reach)); x++) {
        if (Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r) > half) continue;
        const i = (y * p.width + x) * p.channels;
        for (let k = 0; k < 3; k++) p.data[i + k] = Math.round(p.data[i + k]! * (1 - alpha) + rgb[k]! * alpha);
        if (p.channels === 4) p.data[i + 3] = 255;
      }
  };
  paint((line + 2) / 2, [0, 0, 0], 0.75);
  paint(line / 2, [0xff, 0x3b, 0x30], 1);
}
