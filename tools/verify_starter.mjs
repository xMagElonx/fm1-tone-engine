// 验证随附入门音色库（starter bank）。
//
// 打包成功 ≠ 音色可用。一个载波电平写成 0 的音色，格式完全合法、校验和也对，
// 但它就是哑的。所以这里不只查格式，还要把它真的渲染一遍。
//
//   ① starter/*.syx 与 data/starter.js 是不是同一份字节
//   ② 每个音色的载波电平是否非零（载波电平为 0 = 静音）
//   ③ 每个音色真的渲染一遍：有限值、峰值、频谱重心、衰减时长
//   ④ 全部参数是否落在 packed 格式与 DX7 面板区间内
//
// 最后输出一张实测表，用来核对每个音色的设计说明是不是真的做到了。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { centroidOf } from './fft.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const FM = require(path.join(ROOT, 'engine', 'fm.js'));

const SR = 44100;
let fails = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `\n        ${extra}` : ''}`);
  if (!cond) fails++;
  return cond;
};

/* ---------------------------------------------------------------- 载入 */
const sandbox = {};
new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(sandbox);
const S = sandbox.FM1_STARTER;
if (!S) { console.log('FAIL  无法从 data/starter.js 取到 window.FM1_STARTER'); process.exit(1); }

/* ---------------------------------------------- ① 两个产物同源 */
console.log('① 两个产物是不是同一份字节');
// data/starter.js 里嵌的是完整 SysEx（4104 字节），与 data/factory.js 的格式一致，
// 页面两个数据源因此走同一条解析路径，不需要分支。
const fromJs = new Uint8Array(Buffer.from(S.banks[0], 'base64'));
const syx = new Uint8Array(readFileSync(path.join(ROOT, 'starter', 'FM-1_starter_bank.syx')));
check(fromJs.length === 4104, `data/starter.js 内嵌的是完整 SysEx（4104 字节）`, `实际 ${fromJs.length}`);
check(syx.length === 4104, `starter/*.syx 是 4104 字节`, `实际 ${syx.length}`);
check(DX7.hex(fromJs) === DX7.hex(syx),
  'data/starter.js 与 starter/*.syx 逐字节一致（页面载入的与用户导入 Dexed 的是同一份）');

let packed = null;
try {
  packed = DX7.parseBank(syx);          // 会校验 SysEx 头与校验和，失败会抛
  check(true, `SysEx 头与校验和通过校验（校验和 0x${syx[4102].toString(16)}）`);
} catch (e) {
  check(false, `SysEx 结构校验`, e.message);
}
check(S.names.length === 32 && S.design.length === 32,
  `starter.js 带 32 个名字与 32 条设计说明`, `names=${S.names.length} design=${S.design.length}`);
check(S.licence === 'CC0-1.0', `许可证标注为 ${S.licence}（可随仓库自由分发）`);

/* ---------------------------------------------- 解码 */
const voices = [];
for (let i = 0; i < 32; i++) {
  voices.push(DX7.decodeVoice(packed.slice(i * 128, i * 128 + 128)));
}

/* ---------------------------------------------- ② 载波电平 */
console.log('\n② 载波电平');
// DX7 的算法里载波数从 1 个到 6 个不等，多数音色只会用到其中一部分：
// 剩下的载波电平为 0 是正常做法，出厂音色同样如此。所以这里只硬性要求
// "至少有一个载波在发声"，同时把空载波数量报出来，便于核对算法选得对不对。
const silentAll = [];
let emptyTotal = 0;
voices.forEach((d, i) => {
  const info = DX7.describe(d, FM);
  const live = info.carriers.filter(n => d.ops[6 - n].outputLevel > 0);
  emptyTotal += info.carriers.length - live.length;
  if (live.length === 0) silentAll.push(`槽 ${i} ${d.name}：${info.carriers.length} 个载波电平全为 0`);
});
check(silentAll.length === 0, '每个音色至少有一个载波在发声', silentAll.join('\n        '));
console.log(`  NOTE  32 个音色合计 ${emptyTotal} 个载波电平为 0。DX7 算法的载波数 1–6 不等，`
  + `\n        只用其中一部分是正常做法（出厂音色同样如此），不影响听感。`);

/* ---------------------------------------------- ③ 真的渲染一遍 */
console.log('\n③ 真的渲染一遍（note C3、时长 3.5s、gate 1.8s）');
const rows = [];
let nonfinite = 0;
for (let i = 0; i < 32; i++) {
  const d = voices[i];
  const buf = FM.render(d, { sampleRate: SR, duration: 3.5, gate: 1.8, note: 48, normalize: false });
  let bad = 0, peak = 0, peakAt = 0;
  for (let k = 0; k < buf.length; k++) {
    const x = buf[k];
    if (!Number.isFinite(x)) bad++;
    else if (Math.abs(x) > peak) { peak = Math.abs(x); peakAt = k; }
  }
  nonfinite += bad;
  if (bad) console.log(`  FAIL  槽 ${i} ${d.name} 有 ${bad} 个非有限采样`);
  // 频谱重心必须从"声音还在"的位置取。若固定从 0.3s 开始，对 0.07s 就结束的
  // 打击类音色等于在分析一段静音，重心会算成 0 Hz —— 那是测量错，不是音色错。
  const start = Math.max(0, Math.min(Math.round(0.3 * SR), peakAt));
  rows.push({ i, name: d.name, peak, cen: centroidOf(buf, SR, start), decay: decaySeconds(buf) });
}
check(nonfinite === 0, '全部渲染输出均为有限值');

const quiet = rows.filter(r => r.peak < 0.01);
check(quiet.length === 0, '没有音色渲染成近乎静音（阈值 0.01）',
  quiet.map(r => `${r.i}:${r.name} peak=${r.peak.toExponential(2)}`).join(', '));

/** 最后一个超过峰值 1%（−40 dB）的位置，用作"声音什么时候结束"的粗略度量。 */
function decaySeconds(buf) {
  const win = Math.round(SR * 0.01);
  const n = Math.floor(buf.length / win);
  const rms = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < win; j++) { const x = buf[i * win + j]; s += x * x; }
    rms[i] = Math.sqrt(s / win);
    if (rms[i] > peak) peak = rms[i];
  }
  if (peak < 1e-9) return 0;
  for (let i = n - 1; i >= 0; i--) if (rms[i] >= peak * 0.01) return i * win / SR;
  return 0;
}

/* ---------------------------------------------- ④ 参数区间 */
console.log('\n④ 参数区间（越界即说明打包时发生了位溢出或截断）');
const stats = {};
for (const k in DX7.SPEC) stats[k] = { min: 999, max: -999, over: 0, bad: 0 };
const bump = (k, val) => {
  const st = stats[k];
  if (!st) return;
  if (val < st.min) st.min = val;
  if (val > st.max) st.max = val;
  const spec = DX7.SPEC[k];
  if (val > spec[1]) st.bad++; else if (val > spec[0]) st.over++;
};
for (const d of voices) {
  bump('算法', d.algorithm); bump('反馈', d.feedback); bump('振荡器同步', d.oscKeySync);
  bump('移调', d.transpose); bump('LFO 波形', d.lfoWave); bump('LFO 同步', d.lfoSync);
  bump('LFO 音高调制灵敏度', d.lfoPitchModSens);
  d.pitchEgR.concat(d.pitchEgL).forEach(x => bump('音高包络 rate / level', x));
  for (const o of d.ops) {
    o.egR.concat(o.egL).forEach(x => bump('算子·包络 R / L', x));
    bump('算子·断点', o.breakPoint);
    bump('算子·左右深度', o.leftDepth); bump('算子·左右深度', o.rightDepth);
    bump('算子·左右曲线', o.leftCurve); bump('算子·左右曲线', o.rightCurve);
    bump('算子·失谐', o.detune); bump('算子·速率缩放', o.rateScale);
    bump('算子·力度灵敏度', o.keyVelSens); bump('算子·振幅调制灵敏度', o.ampModSens);
    bump('算子·输出电平', o.outputLevel); bump('算子·振荡模式', o.oscMode);
    bump('算子·粗调', o.freqCoarse); bump('算子·微调', o.freqFine);
  }
}
let totalBad = 0, totalOver = 0;
for (const k in stats) {
  const st = stats[k];
  totalBad += st.bad; totalOver += st.over;
  console.log(`  ${st.bad ? 'FAIL' : (st.over ? 'NOTE' : 'PASS')}  ${k.padEnd(20, '　')} ` +
    `实测 ${String(st.min).padStart(3)}–${String(st.max).padStart(3)}   超格式 ${st.bad}   超面板 ${st.over}`);
}
check(totalBad === 0, `超出 packed 字节容量的取值：${totalBad} 个`);
if (totalOver) {
  console.log(`  （${totalOver} 个取值超出面板可见上限但仍在字节容量内，多数是失谐 +8 级，属正常）`);
}

/* ---------------------------------------------- 实测表 */
console.log('\n⑤ 实测表（用来核对每个音色的设计说明是否真的做到了）');
console.log('  槽  音色名      算法   峰值    频谱重心    声音结束');
console.log('  ────────────────────────────────────────────────────────────────');
for (const r of rows) {
  console.log(`  ${String(r.i).padStart(2)}  ${r.name.padEnd(10)}  ${String(voices[r.i].algorithm + 1).padStart(2)}  ` +
    `${r.peak.toFixed(3).padStart(6)}  ${String(Math.round(r.cen)).padStart(7)} Hz  ${r.decay.toFixed(2)} s`);
}

/* ---------------------------------------------- 引擎尚未实现的设计点 */
console.log('\n⑥ 用了引擎尚未实现特性的音色（说明里已标注，此处自动核对）');
const pitchEgUsers = rows.filter(r => {
  const d = voices[r.i];
  return d.pitchEgL.some(x => x !== 50) || d.pitchEgR.some(x => x !== 99);
}).map(r => `${r.i}:${r.name}`);
console.log(`  音高包络（engine/fm.js 未实现）：${pitchEgUsers.length ? pitchEgUsers.join(', ') : '无'}`);

console.log('\n' + (fails === 0 ? '全部通过。' : `${fails} 项失败。`));
process.exit(fails === 0 ? 0 : 1);
