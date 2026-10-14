/* ============================================================================
   引擎审计：算法表结构 + 渲染结果
   ----------------------------------------------------------------------------
   运行：node tools/engine_test.mjs
   这份脚本只做一件事——把 FM_ENGINE 的每一个可验证断言跑一遍。
   凡是能反查出错的，都不要靠"看起来对"。
   ========================================================================= */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FM = require(path.join(__dirname, '..', 'engine', 'fm.js'));

let pass = 0, fail = 0;
function check(cond, msg, extra) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}${extra ? '  ← ' + extra : ''}`); }
  return cond;
}
function section(t) { console.log(`\n${t}`); }

/* ------------------------------------------------------------------ 一 */
section('① 算法表结构审计（32 个算法）');

let allOk = true;
for (let a = 0; a < 32; a++) {
  const plan = FM.compileAlgo(a);
  const panel = a + 1;

  // 每个算子恰好出现一次
  const ops = plan.nodes.map(n => n.op).sort((x, y) => x - y);
  const expect = [1, 2, 3, 4, 5, 6];
  if (JSON.stringify(ops) !== JSON.stringify(expect)) {
    allOk = false;
    console.log(`  FAIL  算法 ${panel}: 算子集合 = [${ops}]，应为 [1,2,3,4,5,6]`);
  }
  // 后序保证：任何节点的调制源下标必须小于它自己
  for (let i = 0; i < plan.nodes.length; i++) {
    for (const s of plan.nodes[i].srcs) {
      if (s >= i) { allOk = false; console.log(`  FAIL  算法 ${panel}: 节点 ${i} 的调制源 ${s} 未先行计算`); }
    }
  }
  // 反馈端点有效
  if (plan.fbSrc < 0 || plan.fbDst < 0) { allOk = false; console.log(`  FAIL  算法 ${panel}: 反馈端点缺失`); }
}
check(allOk, '32 个算法：算子各出现一次 + 后序依赖成立 + 反馈端点有效');

// 与 Yamaha 官方手册的四条独立事实比对
function carriersOf(panel) {
  return FM.compileAlgo(panel - 1).carriers.map(i => FM.compileAlgo(panel - 1).nodes[i].op).sort((x, y) => x - y);
}
check(JSON.stringify(carriersOf(1)) === '[1,3]', '官方手册：算法 1 的载波是 OP1 与 OP3', JSON.stringify(carriersOf(1)));
check(carriersOf(5).length === 3, '官方手册：算法 5 = 3 载波 + 3 调制器', `实测 ${carriersOf(5).length} 载波`);
check(carriersOf(16).length === 1 && FM.compileAlgo(15).nodes.length === 6,
  '官方手册：算法 16 = 1 载波 + 5 调制器', `${carriersOf(16).length} 载波`);
check(carriersOf(32).length === 6, '官方手册：算法 32 = 6 载波、无调制器', `${carriersOf(32).length} 载波`);

// 全局不变量：OP1 恒为载波
const noOp1 = [];
for (let p = 1; p <= 32; p++) if (!carriersOf(p).includes(1)) noOp1.push(p);
check(noOp1.length === 0, '全部 32 个算法中 OP1 都是载波', noOp1.length ? `反例：算法 ${noOp1.join(',')}` : '');

// 反馈例外只有算法 4 与 6
const crossFb = [];
for (let a = 0; a < 32; a++) {
  const plan = FM.compileAlgo(a);
  const srcOp = plan.nodes[plan.fbSrc].op, dstOp = plan.nodes[plan.fbDst].op;
  if (srcOp !== dstOp) crossFb.push(a + 1);
}
check(JSON.stringify(crossFb) === '[4,6]', '跨算子反馈只出现在算法 4 与算法 6', JSON.stringify(crossFb));

/* ------------------------------------------------------------------ 二 */
section('② 渲染：基础正确性');

const SR = 44100;

function makeVoice({ algorithm, ops }) {
  // ops: { [opNum]: { level, coarse, fine, oscMode, egR, egL } }
  const list = [];
  for (let n = 6; n >= 1; n--) {
    const o = ops[n] || {};
    list.push({
      num: n,
      egR: o.egR || [99, 99, 99, 99],
      egL: o.egL || [99, 99, 99, 0],
      breakPoint: 39, leftDepth: 0, rightDepth: 0, leftCurve: 0, rightCurve: 0,
      detune: 7, rateScale: 0, keyVelSens: 0, ampModSens: 0,
      outputLevel: o.level == null ? 0 : o.level,
      oscMode: o.oscMode || 0,
      freqCoarse: o.coarse == null ? 1 : o.coarse,
      freqFine: o.fine || 0,
    });
  }
  return { algorithm, feedback: ops.feedback || 0, ops: list };
}

// 2.1 全静音
{
  const v = makeVoice({ algorithm: 4, ops: {} });
  const buf = FM.render(v, { sampleRate: SR, duration: 0.4, gate: 0.3, note: 48 });
  let peak = 0;
  for (const x of buf) peak = Math.max(peak, Math.abs(x));
  check(peak === 0, '所有算子输出电平为 0 时，渲染结果全零', `峰值 ${peak}`);
}

// 2.2 数值健全
{
  const v = makeVoice({ algorithm: 31, ops: { 1: { level: 99 }, feedback: 7 } });
  const buf = FM.render(v, { sampleRate: SR, duration: 1.0, gate: 0.6, note: 48 });
  let bad = 0, peak = 0;
  for (const x of buf) { if (!Number.isFinite(x)) bad++; peak = Math.max(peak, Math.abs(x)); }
  check(bad === 0, '输出不含 NaN / Infinity', `${bad} 个`);
  check(peak <= 1.0001, '输出幅度落在 [−1, 1]', `峰值 ${peak.toFixed(4)}`);
  check(peak > 0.5, '归一化后峰值被抬到有效听感区间', `峰值 ${peak.toFixed(4)}`);
}

/* ---------------- 频谱分析：统一走 tools/fft.mjs ---------------- */
import * as FFTLIB from './fft.mjs';
const spectrum = FFTLIB.spectrum;
const peakBin = FFTLIB.peakBin;
const centroid = (mag) => FFTLIB.centroid(mag, SR, mag.length * 2);

/* 先验尺子，再量东西。
   这条断言是后补的：这段 FFT 原来在三个脚本里各抄了一份，其中两份漏掉了位反转
   置换，只剩蝶形运算 —— 输出是打乱顺序的频谱。症状很唬人：所有音色的"频谱重心"
   都落在 8–12 kHz，看起来像引擎把音色渲染成了白噪声。实际引擎没错，是尺子错了。 */
{
  const N = 4096, f0 = 1000, sig = new Float64Array(N);
  for (let i = 0; i < N; i++) sig[i] = Math.sin(2 * Math.PI * f0 * i / SR);
  const mag = spectrum(sig, 0, N);
  const hz = peakBin(mag) * SR / N;
  check(Math.abs(hz - f0) <= SR / N * 2, 'FFT 自身正确：1000 Hz 正弦的峰落在 1000 Hz', `实测 ${hz.toFixed(1)} Hz`);
}

// 2.3 算法 32 + 只点亮 OP1（比率 1）→ 应为纯正弦
{
  const v = makeVoice({ algorithm: 31, ops: { 1: { level: 99, coarse: 1 } } });
  const buf = FM.render(v, { sampleRate: SR, duration: 1.0, gate: 0.9, note: 48, normalize: false });
  const N = 4096, mag = spectrum(buf, Math.round(0.2 * SR), N);
  const bi = peakBin(mag);
  const hz = bi * SR / N;
  const f0 = FM.midiToHz(48);
  check(Math.abs(hz - f0) < SR / N, '基频落在正确的频率上（MIDI 48 ≈ 130.8 Hz）', `实测 ${hz.toFixed(1)} Hz / 期望 ${f0.toFixed(1)} Hz`);

  // 能量集中度：基频 3 个 bin 内占多少
  let near = 0, all = 0;
  for (let i = 1; i < mag.length; i++) { all += mag[i] * mag[i]; if (Math.abs(i - bi) <= 2) near += mag[i] * mag[i]; }
  check(near / all > 0.95, '纯正弦：>95% 能量集中在基频', `${(near / all * 100).toFixed(1)}%`);
}

// 2.4 音高随音符改变
{
  const W = 4096;
  const rows = [45, 48, 51, 55].map(note => {
    const v = makeVoice({ algorithm: 31, ops: { 1: { level: 99, coarse: 1 } } });
    const buf = FM.render(v, { sampleRate: SR, duration: 1.0, gate: 0.9, note, normalize: false });
    const mag = spectrum(buf, Math.round(0.2 * SR), W);
    return { note, hz: peakBin(mag) * SR / W, want: FM.midiToHz(note) };
  });
  const ok = rows.every(r => Math.abs(r.hz - r.want) < SR / W);
  check(ok, '音高与 MIDI 音符一一对应', rows.map(r => `${r.note}:${r.hz.toFixed(0)}/${r.want.toFixed(0)}`).join(' '));
}

// 2.5 调制器电平升高 → 频谱重心单调升高
{
  const levels = [0, 20, 40, 60, 80, 99];
  const cs = levels.map(L => {
    const v = makeVoice({ algorithm: 4, ops: { 1: { level: 99, coarse: 1 }, 2: { level: L, coarse: 1 } } });
    const buf = FM.render(v, { sampleRate: SR, duration: 1.0, gate: 0.9, note: 48, normalize: false });
    return centroid(spectrum(buf, Math.round(0.2 * SR), 4096));
  });
  let mono = true;
  for (let i = 1; i < cs.length; i++) if (cs[i] < cs[i - 1] - 1e-6) mono = false;
  check(mono, '调制器输出电平越高，频谱重心越高（单调）',
    levels.map((L, i) => `${L}→${cs[i].toFixed(1)}`).join(' '));
  check(cs[cs.length - 1] > cs[0] * 3, '最亮与最暗的差异显著', `${cs[0].toFixed(1)} → ${cs[cs.length - 1].toFixed(1)}`);
}

// 2.6 反馈增强亮度
// 用算法 32：OP6 本身既是载波、又带自反馈，其余算子全部静音。
// 这样反馈是唯一变量，而且反馈 0 时它必须是纯正弦 —— 一开始错写成"算法 5 +
// OP1"，那条路上反馈算子 OP4 被设成静音，反馈根本传不到输出，等于没测。
{
  const mk = (fb) => {
    const v = makeVoice({ algorithm: 31, ops: { 6: { level: 99, coarse: 1 }, feedback: fb } });
    const buf = FM.render(v, { sampleRate: SR, duration: 1.0, gate: 0.9, note: 48, normalize: false });
    return { c: centroid(spectrum(buf, Math.round(0.2 * SR), 4096)), buf };
  };
  const z = mk(0), s = mk(7);
  check(s.c > z.c * 1.5, '反馈 7 比反馈 0 明显更亮', `0→${z.c.toFixed(1)}  7→${s.c.toFixed(1)}`);

  // 反馈 0：纯正弦；反馈 7：谐波大幅增加
  const N = 4096;
  const magZ = spectrum(z.buf, Math.round(0.2 * SR), N);
  const bi = peakBin(magZ);
  let nearZ = 0, allZ = 0;
  for (let i = 1; i < magZ.length; i++) { allZ += magZ[i] ** 2; if (Math.abs(i - bi) <= 2) nearZ += magZ[i] ** 2; }
  check(nearZ / allZ > 0.95, '反馈 0 时 OP6 是纯正弦（>95% 能量在基频）', `${(nearZ / allZ * 100).toFixed(1)}%`);

  const magS = spectrum(s.buf, Math.round(0.2 * SR), N);
  let nearS = 0, allS = 0;
  for (let i = 1; i < magS.length; i++) { allS += magS[i] ** 2; if (Math.abs(i - bi) <= 2) nearS += magS[i] ** 2; }
  check(nearS / allS < 0.7, '反馈 7 时基频不再占绝对主导（谐波被撑开）', `${(nearS / allS * 100).toFixed(1)}%`);
}

// 2.7 算法结构影响音色：同一组算子按不同算法得到不同结果
{
  const a31 = FM.render(makeVoice({ algorithm: 31, ops: { 1: { level: 99 }, 2: { level: 80 } } }),
    { sampleRate: SR, duration: 0.8, gate: 0.7, note: 48, normalize: false });
  const a4 = FM.render(makeVoice({ algorithm: 4, ops: { 1: { level: 99 }, 2: { level: 80 } } }),
    { sampleRate: SR, duration: 0.8, gate: 0.7, note: 48, normalize: false });
  const c31 = centroid(spectrum(a31, Math.round(0.2 * SR), 4096));
  const c4 = centroid(spectrum(a4, Math.round(0.2 * SR), 4096));
  // 算法 32 里 OP2 是载波（加法），算法 5 里 OP2 是 OP1 的调制器
  check(Math.abs(c31 - c4) > 1, '算法不同 → 结果不同（OP2 载波 vs 调制器）', `32→${c31.toFixed(1)}  5→${c4.toFixed(1)}`);
}

/* ------------------------------------------------------------------ 三 */
section('③ 渲染：包络');

// 3.1 起音从 0 开始、经历上升
{
  const v = makeVoice({ algorithm: 31, ops: { 1: { level: 99, egR: [40, 99, 99, 60], egL: [99, 99, 99, 0] } } });
  const buf = FM.render(v, { sampleRate: SR, duration: 1.2, gate: 0.8, note: 48, normalize: false });
  const win = Math.round(0.01 * SR);
  const head = Math.max(...Array.from(buf.slice(0, win), Math.abs));
  const mid = Math.max(...Array.from(buf.slice(Math.round(0.4 * SR), Math.round(0.5 * SR)), Math.abs));
  check(head < mid * 0.5, '起音段由小变大（不是瞬间到顶）', `首 10ms 峰值 ${head.toFixed(4)} / 中段 ${mid.toFixed(4)}`);
}

// 3.2 key-off 后衰减到静音
{
  const v = makeVoice({ algorithm: 31, ops: { 1: { level: 99, egR: [99, 99, 99, 55], egL: [99, 99, 99, 0] } } });
  const buf = FM.render(v, { sampleRate: SR, duration: 1.4, gate: 0.5, note: 48, normalize: false });
  const during = Math.max(...Array.from(buf.slice(Math.round(0.3 * SR), Math.round(0.4 * SR)), Math.abs));
  const after = Math.max(...Array.from(buf.slice(Math.round(1.3 * SR), Math.round(1.39 * SR)), Math.abs));
  check(during > 0.01 && after < during * 0.05, 'key-off 后按 R4 衰减到接近静音',
    `按下 ${during.toFixed(4)} → 结束 ${after.toFixed(6)}`);
}

/* ------------------------------------------------------------------ 四 */
section('④ WAV 导出');

{
  const v = makeVoice({ algorithm: 4, ops: { 1: { level: 99 }, 2: { level: 70 } } });
  const buf = FM.render(v, { sampleRate: SR, duration: 0.5, gate: 0.4, note: 48 });
  const wav = FM.encodeWav(buf, SR);
  const head = String.fromCharCode(wav[0], wav[1], wav[2], wav[3]);
  const fmt = String.fromCharCode(wav[8], wav[9], wav[10], wav[11]);
  const view = new DataView(wav.buffer);
  check(head === 'RIFF' && fmt === 'WAVE', 'WAV 容器头正确', `${head}/${fmt}`);
  check(wav.length === 44 + buf.length * 2, 'WAV 长度 = 44 + 采样数 × 2', `${wav.length}`);
  check(view.getUint32(4, true) === 36 + buf.length * 2, 'RIFF 长度字段正确');
  check(view.getUint32(24, true) === SR, '采样率字段正确', `${view.getUint32(24, true)}`);
  check(view.getUint16(22, true) === 1 && view.getUint16(34, true) === 16, '单声道 / 16 bit');
}

/* ------------------------------------------------------------------ 汇总 */
console.log(`\n${'─'.repeat(56)}`);
console.log(fail === 0 ? `结论：全部通过（${pass} 项断言）。` : `结论：${fail} 项失败 / ${pass} 项通过。`);
process.exit(fail === 0 ? 0 : 1);
