// 诊断：为什么载波电平 99（振幅应为 1.0）的音色，渲染峰值只有 0.387？
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = 'D:/wb/2026-10-15-00-50-04/fm1-tone-engine';
const require = createRequire(import.meta.url);
const DX7 = require(ROOT + '/engine/dx7.js');
const FM = require(ROOT + '/engine/fm.js');

const sandbox = {};
new Function('window', readFileSync(ROOT + '/data/starter.js', 'utf8'))(sandbox);
const packed = Buffer.from(sandbox.FM1_STARTER.banks[0], 'base64');
const SR = 44100;

for (const slot of [0, 1, 13, 22]) {
  const d = DX7.decodeVoice(new Uint8Array(packed.slice(slot * 128, slot * 128 + 128)));
  const info = DX7.describe(d, FM);
  console.log(`\n槽 ${slot}  ${JSON.stringify(d.name)}   算法 ${d.algorithm + 1}`);
  console.log('  算子:  ' + d.ops.map(o => `OP${o.num}=${o.outputLevel}`).join('  '));
  console.log('  载波(carriers 数组): ' + JSON.stringify(info.carriers));

  const raw = FM.render(d, { sampleRate: SR, duration: 1.0, gate: 0.9, note: 48, normalize: false });
  const norm = FM.render(d, { sampleRate: SR, duration: 1.0, gate: 0.9, note: 48 });

  const win = Math.round(SR * 0.01);      // 10 ms
  const seg = [];
  for (let i = 0; i < 20; i++) {
    let p = 0;
    for (let j = 0; j < win; j++) { const x = Math.abs(raw[i * win + j] || 0); if (x > p) p = x; }
    seg.push(p.toFixed(3));
  }
  const peakOf = (b) => { let p = 0; for (const x of b) { const a = Math.abs(x); if (a > p) p = a; } return p; };
  console.log('  前 200ms 每 10ms 峰值: ' + seg.join(' '));
  console.log(`  全局峰值  normalize:false → ${peakOf(raw).toFixed(4)}   normalize:true → ${peakOf(norm).toFixed(4)}`);
}

// 包络轨迹：直接暴露给 render 的算子参数，手算一遍 levelToAmp
console.log('\n--- levelToAmp 参考值 ---');
for (const l of [0, 46, 60, 78, 88, 92, 99]) {
  const f = (x) => (x <= 0 ? 0 : x >= 99 ? 1 : Math.pow(10, -((99 - x) * 0.75) / 20));
  console.log(`  level ${String(l).padStart(2)} → 振幅 ${f(l).toFixed(4)}`);
}
console.log('  rateFullScaleSeconds: r=72 → ' + (0.005 * Math.pow(2, 27 / 8)).toFixed(4) + 's');
