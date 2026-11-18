// Colour debugging helper: prints the mean colour of squares in a shot and the share of area by brightness.
//   node probe.mjs out/kampus.png 820,180 1500,560     (on the host, in tools/shot after npm install)
import fs from 'node:fs';
import { decode } from 'fast-png';

const [file, ...points] = process.argv.slice(2);
const png = decode(fs.readFileSync(file));
const { width: W, height: H, channels: C, data } = png;
const HALF = 3;
for (const p of points) {
  const [px, py] = p.split(',').map(Number);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = py - HALF; y <= py + HALF; y++) {
    for (let x = px - HALF; x <= px + HALF; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      for (let k = 0; k < 3; k++) sum[k] += data[(y * W + x) * C + k];
      n++;
    }
  }
  console.log(`${p}: rgb(${sum.map((v) => Math.round(v / n)).join(', ')})`);
}
// Share of scene pixels (without background) with brightness below 50 % and the mean colour.
let dark = 0;
let total = 0;
const mean = [0, 0, 0];
let satSum = 0;
for (let i = 0; i < W * H; i++) {
  const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
  if (Math.abs(r - 21) < 3 && Math.abs(g - 22) < 3 && Math.abs(b - 26) < 3) continue;
  total++;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 128) dark++;
  satSum += mx > 0 ? (mx - mn) / mx : 0;
  mean[0] += r; mean[1] += g; mean[2] += b;
}
console.log(`scene: ${((100 * total) / (W * H)).toFixed(0)} % of the shot, brightness below 50 %: ${((100 * dark) / total).toFixed(0)} %, mean rgb(${mean.map((v) => Math.round(v / total)).join(', ')}), mean saturation ${((100 * satSum) / total).toFixed(0)} %`);
