/* ============================================================================
   用真实出厂音色渲染试听音频
   ----------------------------------------------------------------------------
   运行：node tools/render_demo.mjs
   输出：demo/*.wav（单音色）+ demo/_medley.wav（串烧）
   同时打印每个音色的数值特征，作为"引擎在真实数据上确实在工作"的证据。
   ========================================================================= */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const FM = require(path.join(ROOT, 'engine', 'fm.js'));

const packed = new Uint8Array(readFileSync(path.join(ROOT, 'ref', 'packed128.bin')));
const SR = 44100;

const PICKS = [
  [0, 'PIANO 1', 48], [1, 'ORGAN 1', 48], [2, 'SYN LEAD 1', 60], [3, 'SYN PAD 1', 48],
  [34, 'BASS 1', 36], [40, 'GUITAR 3', 48], [64, 'BRASS 1', 48], [70, 'STRING 2', 48],
  [87, 'VOICE 6', 48], [109, 'TIMPANI', 36], [113, 'STEEL DRUM', 60], [127, 'WHAT IF', 48],
];

function decode(slot) { return DX7.decodeVoice(packed.slice(slot * 128, slot * 128 + 128)); }

/* 频谱重心走共享实现（原先在这里手抄了一份 FFT，漏了位反转置换，
   算出来的"亮度"全是错的 —— 见 tools/fft.mjs 顶部说明）。 */
import * as FFTLIB from './fft.mjs';
const centroidOf = (buf) => FFTLIB.centroidOf(buf, SR, Math.round(0.25 * SR));

mkdirSync(path.join(ROOT, 'demo'), { recursive: true });

console.log('槽  音色名        算法  载波  反馈  Hz    峰值    RMS     频谱重心');
console.log('─'.repeat(72));

const rendered = [];
let bad = 0;

for (const [slot, expectName, note] of PICKS) {
  const d = decode(slot);
  const info = DX7.describe(d, FM);
  const buf = FM.render(d, { sampleRate: SR, duration: 1.6, gate: 1.0, note });
  const wav = FM.encodeWav(buf, SR);

  let peak = 0, sq = 0, nan = 0;
  for (const x of buf) {
    if (!Number.isFinite(x)) { nan++; continue; }
    peak = Math.max(peak, Math.abs(x));
    sq += x * x;
  }
  const rms = Math.sqrt(sq / buf.length);
  const cen = centroidOf(buf);
  if (nan) bad++;
  if (d.name.trim() !== expectName) bad++;

  const file = `demo/${String(slot).padStart(3, '0')}_${d.name.trim().replace(/[^\w]+/g, '_')}.wav`;
  writeFileSync(path.join(ROOT, file), wav);
  rendered.push(buf);

  console.log(
    `${String(slot).padStart(3)} ${d.name.padEnd(13)} ${String(info.algorithmPanel).padStart(3)}` +
    ` ${String(info.carrierCount).padStart(4)}  ${String(d.feedback).padStart(4)}` +
    `  ${String(note).padStart(3)}  ${peak.toFixed(3)}  ${rms.toFixed(4)}  ${cen.toFixed(0).padStart(5)}`
  );
}

/* --- 串烧：12 个音色接在一起，每个之间留 0.25s 静音 --- */
{
  const gap = Math.round(0.25 * SR);
  const total = rendered.reduce((a, b) => a + b.length + gap, 0);
  const medley = new Float32Array(total);
  let off = 0;
  for (const buf of rendered) { medley.set(buf, off); off += buf.length + gap; }
  // 每个音色自带淡入淡出，接缝处再补一次短淡出
  writeFileSync(path.join(ROOT, 'demo', '_medley.wav'), FM.encodeWav(medley, SR));
  console.log(`\n串烧：${(total / SR).toFixed(1)} s → demo/_medley.wav`);
}

console.log(bad === 0 ? '\n全部音色渲染成功，无 NaN、名字与预期一致。' : `\n${bad} 处异常。`);
process.exit(bad === 0 ? 0 : 1);
