import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const FM = require(path.join(ROOT, 'engine', 'fm.js'));
const packed = new Uint8Array(readFileSync(path.join(ROOT, 'ref', 'packed128.bin')));
const SR = 44100;

import * as FFTLIB from './fft.mjs';

function peaks(buf, n = 12) {
  const N = 4096;
  const mag = FFTLIB.spectrum(buf, Math.round(0.3 * SR), N);
  const list = [];
  for (let i = 1; i < mag.length; i++) list.push([i, mag[i]]);
  list.sort((a, b) => b[1] - a[1]);
  return list.slice(0, n).map(([i]) => `${(i * SR / N).toFixed(0)}Hz`);
}

for (const slot of [1, 0, 3]) {
  const d = DX7.decodeVoice(packed.slice(slot*128, slot*128+128));
  const info = DX7.describe(d, FM);
  console.log(`\n=== 槽 ${slot} ${d.name} | 算法 ${info.algorithmPanel} | 载波 [${info.carriers}] | 反馈 ${d.feedback} ===`);
  for (const o of [...d.ops].reverse()) {   // 按 OP1..OP6 打印
    console.log(`  OP${o.num} lvl=${String(o.outputLevel).padStart(3)} coarse=${String(o.freqCoarse).padStart(2)}`
      + ` fine=${String(o.freqFine).padStart(3)} mode=${o.oscMode} detune=${o.detune-7}`
      + ` ratio=${FM.opRatio(o, 130.8).toFixed(3)}`);
  }
  const buf = FM.render(d, { sampleRate: SR, duration: 1.6, gate: 1.0, note: 48, normalize: false });
  let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x));
  console.log(`  未归一化峰值 ${peak.toExponential(3)}`);
  console.log(`  主要频谱峰：${peaks(buf).join(' ')}`);
}
