// 验证意图层：一句人话 → 参数改动 → 声音真的变了。
//
// 这一层的立身之本是"方向正确"，而方向对不对**不能靠读代码判断**。
// 所以核心那几节全是实测：说「更亮」就渲染一遍，量频谱，要求它真的往亮的方向走；
// 说「尾巴更长」就量包络，要求它真的变长。量不出来就算失败。
//
// ① decodeVoice / encodeVoice 严格互逆（真实字节逐字节）
// ② 本地方言解析：方向、程度词、长词优先、否定
// ③ applyIntent 不碰原对象；空意图等于恒等
// ④ 方向正确性（实测）：更亮 → 频谱上移，更长 → 包络拖后，更慢 → 能量后移
// ⑤ 幅度单调：说「一点」的改动必须小于说「非常」
// ⑥ 边界与诚实：极端值不越界；改不动时必须给警告而不是假装改了
// ⑦ 改动清单与实际改动一致，且每条都有可比的幅度数值
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spectrum } from './fft.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const FM = require(path.join(ROOT, 'engine', 'fm.js'));
const INTENT = require(path.join(ROOT, 'engine', 'intent.js'));

const SR = 44100;
const NFFT = 4096;
let fails = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `\n        ${extra}` : ''}`);
  if (!cond) fails++;
  return cond;
};

/* ---------------------------------------------------------------- 数据 */
function loadBanks() {
  const out = [];
  const push = (label, b64) => out.push({ label, blob: DX7.b64ToBytes(b64) });
  const sw = {};
  new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(sw);
  sw.FM1_STARTER.banks.forEach((b, i) => push('starter#' + i, b));
  for (const f of ['data/factory.js']) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) continue;
    const fw = {};
    new Function('window', readFileSync(p, 'utf8'))(fw);
    const key = Object.keys(fw)[0];
    fw[key].banks.forEach((b, i) => push('factory#' + i, b));
  }
  const refP = path.join(ROOT, 'ref', 'bank1.syx');
  if (existsSync(refP)) out.push({ label: 'ref/bank1.syx', blob: new Uint8Array(readFileSync(refP)) });
  return out;
}
const banks = loadBanks();

const allVoices = [];
for (const { label, blob } of banks) {
  const data = DX7.parseBank(blob);
  for (let i = 0; i < DX7.VOICES_PER_BANK; i++)
    allVoices.push({ label: label + ' 槽' + i, raw: data.slice(i * 128, i * 128 + 128) });
}
console.log(`数据源 ${banks.length} 个 bank，共 ${allVoices.length} 个音色`);
allVoices.forEach(v => { v.d = DX7.decodeVoice(v.raw); });

/* 下面几节需要"随便挑一个音色当样本"。出厂音色不随仓库分发，
   所以全新 clone 上挑不到 —— 那就用随附的。挑不到就崩，等于这套测试
   在全新 clone 上根本跑不了，而它恰恰是最需要能独立跑的那一部分。 */
const someVoice = allVoices.find(x => !x.label.startsWith('starter')) || allVoices[0];
const isFactorySample = !someVoice.label.startsWith('starter');
if (!isFactorySample) console.log('（没有出厂音色数据，样本改用随附音色库）');

/* ============================================================ 声学测量
   两条独立的实测路径 —— 因为这两类问题会被不同的东西污染。

   亮度轴 → 量**频谱**，用全量渲染。
   起音 / 延音轴 → 量**包络的时间形状**，只渲染载波（把调制器静音）。
     为什么必须这么分：调制指数一变，载波波形的峰值位置和拍频也跟着变，
     会把"包络时间形状"这个被测量本身搅乱。实测踩到过 —— VOICE 5 把两个
     载波的 R1 都放慢（手工按引擎公式推进，800 ms 处包络电平从 96.9 掉到 51.9，
     明明更慢），但全局峰值时间反而从 944 ms 提前到 492 ms：因为另一个载波的
     波形峰值先出现了。量错了对象，结论就会反向。

   另外渲染时关掉峰值归一化。归一化是给试听用的，它会把"改慢起音导致整体变安静"
   这件事又按比例抬回来，前后两次渲染就不是同一把尺子了。
   （频谱重心、能量占比这类比值量和增益无关，关不关都一样。）

   还有一条实测教训：包络段时长按"电平跨度"计，BRASS 1 的起音段长达 0.45 秒 ——
   固定从 0.1 秒开始量，会以为它对"更亮"没反应。所以包络类度量一律按整段能量加权，
   不取任何固定时刻。 */
const RAW = { normalize: false };

function carrierOnly(v, carriers) {
  const o = { ...v, ops: v.ops.map(x => ({ ...x })) };
  o.ops.forEach(x => { if (carriers.indexOf(x.num) < 0) x.outputLevel = 0; });
  return o;
}
const render = (v, dur) => FM.render(v, { sampleRate: SR, duration: dur, gate: 1.0, note: 48, normalize: false });

/* 频谱：按窗口按能量累加，得到增益无关的两个量 */
function tone(buf) {
  const binHz = SR / NFFT;
  let num = 0, den = 0, hi = 0, lo = 0;
  for (let s = 0; s + NFFT <= buf.length; s += NFFT) {
    const m = spectrum(buf, s, NFFT);
    for (let i = 1; i < m.length; i++) {
      const e = m[i] * m[i];
      num += i * binHz * e; den += e;
      if (i * binHz >= 1500) hi += e; else lo += e;
    }
  }
  return { cen: den > 0 ? num / den : 0, r15: hi / (hi + lo || 1) };
}
/* 能量包络，1 ms 一格 */
function energy(buf) {
  const hop = Math.round(SR / 1000);
  const n = Math.floor(buf.length / hop);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < hop; k++) { const x = buf[i * hop + k]; s += x * x; } e[i] = s; }
  return e;
}
const eSum = (a, i, j) => { let s = 0; for (let k = i; k < j && k < a.length; k++) s += a[k]; return s; };
const eCentroid = (a, i, j) => { let num = 0, den = 0; for (let k = i; k < Math.min(j, a.length); k++) { num += k * a[k]; den += a[k]; } return den > 0 ? num / den : 0; };
const eLastAbove = (a, rel) => { const pk = Math.max(...a); for (let i = a.length - 1; i >= 0; i--) if (a[i] >= pk * rel) return i; return 0; };

/* 三个指标的含义与方向。
   dir = +1 表示"值变大 = 音色朝这个轴的正方向走"。
   经验值：单一指标各有失灵的时候（重心会被摊薄、占比会被混叠），
   所以取两个以上互补指标：任一走对就算对，全部走反才算反。
   阈值 2% 是"量得出来"的下限，不是"听得出来"的下限 ——
   小于它的算"没变"，单独计数并打印，不藏起来。 */
const METRIC = {
  cen:      { dir: +1, kind: 'spec' },
  r15:      { dir: +1, kind: 'spec' },
  headFrac: { dir: -1, kind: 'env' },   // 前 100 ms 能量占前 1 s 的比例：起音越慢越小
  oneSecE:  { dir: -1, kind: 'env' },   // 前 1 s 的总能量：起音越慢越小
  oneSecT:  { dir: +1, kind: 'env' },   // 前 1 s 的时间重心：起音越慢越大
  totalE:   { dir: +1, kind: 'env' },   // 全段总能量：尾巴越长越大
  totalT:   { dir: +1, kind: 'env' },   // 全段时间重心：尾巴越长越大
  tailFrac: { dir: +1, kind: 'env' },   // 后半段能量占比：尾巴越长越大
  t40:      { dir: +1, kind: 'env' },   // 跌到峰值 −40 dB 的时刻：尾巴越长越大
};
const V = {
  cen: m => m.cen,
  r15: m => m.r15,
  headFrac: e => eSum(e, 0, 100) / (eSum(e, 0, 1000) || 1),
  oneSecE: e => eSum(e, 0, 1000),
  oneSecT: e => eCentroid(e, 0, 1000),
  totalE: e => eSum(e, 0, e.length),
  totalT: e => eCentroid(e, 0, e.length),
  tailFrac: e => eSum(e, Math.floor(e.length / 2), e.length) / (eSum(e, 0, e.length) || 1),
  t40: e => eLastAbove(e, 1e-4),
};
const THR = 0.02;

/* ============================================================ ① 往返 */
console.log('\n① decodeVoice / encodeVoice 严格互逆');
{
  let bytes = 0, bad = 0;
  const badWhere = new Map();
  for (const v of allVoices) {
    const back = DX7.encodeVoice(v.d);
    for (let k = 0; k < 128; k++) {
      bytes++;
      if (back[k] !== v.raw[k]) { bad++; badWhere.set(k, (badWhere.get(k) || 0) + 1); }
    }
  }
  check(bad === 0, `${bytes} 个字节逐字节一致（${allVoices.length} 个音色 × 128）`,
    bad ? '不一致的字节位：' + [...badWhere.entries()].map(([k, n]) => `${k}(${n}次)`).join(' ') : '');
  const b = DX7.buildBank(DX7.encodeVoice(allVoices[0].d));
  check(DX7.hex(b) === DX7.hex(DX7.buildBank(allVoices[0].raw)),
    '整块 bank 重新打包后也与原始 4104 字节一致（含校验和）');
}

/* ======================================================= ② 词典解析 */
console.log('\n② 本地方言解析');
{
  const cases = [
    ['亮一点', 'bright', +1, 0.3],
    ['亮一些吧', 'bright', +1, 0.3],
    ['非常亮', 'bright', +1, 0.9],
    ['暗一点', 'bright', -1, 0.3],
    ['柔和一些', 'bright', -1, 0.3],
    ['尾巴长一点', 'sustain', +1, 0.3],
    ['干脆一点', 'sustain', -1, 0.3],
    ['起音慢一点', 'attack', +1, 0.3],
    ['厚一点', 'width', +1, 0.3],
    ['干净一点', 'feedback', -1, 0.3],
  ];
  let ok = 0;
  for (const [text, axis, dir, strength] of cases) {
    const r = INTENT.parseLocal(text);
    const got = r.axes[axis];
    const good = r.ok && got !== undefined && Math.sign(got) === dir && Math.abs(Math.abs(got) - strength) < 1e-6;
    if (good) ok++;
    else console.log(`        ✗ 「${text}」期望 ${axis} ${dir > 0 ? '+' : '-'}${strength}，实际 ${JSON.stringify(r.axes)}`);
  }
  check(ok === cases.length, `${cases.length} 条常用说法全部解析正确`, ok === cases.length ? '' : `${ok} 条正确`);
}

/* ------------------------------------------ 长词优先 / 否定 / 多轴 */
console.log('\n③ 长词优先、否定、一句话多个轴');
{
  const r1 = INTENT.parseLocal('柔和起音');
  check(r1.axes.attack > 0 && !r1.axes.bright,
    '「柔和起音」判成"起音更慢"而不是"更暗"（长词优先，没被「柔和」抢走）',
    JSON.stringify(r1.axes) + ' 命中 ' + r1.hits.join('/'));

  const r2 = INTENT.parseLocal('不要太亮');
  check(r2.axes.bright < 0, '「不要太亮」方向翻转为变暗而不是变亮', JSON.stringify(r2.axes));

  const r3 = INTENT.parseLocal('亮一点，尾巴拖长些');
  check(r3.axes.bright > 0 && r3.axes.sustain > 0,
    '一句话里的两个轴被分别识别', JSON.stringify(r3.axes) + ' 命中 ' + r3.hits.join('/'));

  const r4 = INTENT.parseLocal('今天天气不错');
  check(!r4.ok && /没有认出/.test(r4.reason), '认不出任何轴时明确说明原因，不瞎猜',
    r4.reason || '（没有 reason）');

  const r5 = INTENT.parseLocal('亮一点再暗一点');
  check(!r5.ok && /抵消/.test(r5.reason), '同一轴出现相反说法时承认冲突，不随机倒向一边', r5.reason || '（没有 reason）');
}

/* ================================================= ④ 纯函数与恒等 */
console.log('\n④ applyIntent 是纯函数');
{
  const v = someVoice;
  const before = JSON.stringify(v.d.ops.map(o => [o.outputLevel, o.egR, o.detune]));
  const r = INTENT.applyIntent(v.d, INTENT.parseLocal('亮一点，尾巴长些'));
  const after = JSON.stringify(v.d.ops.map(o => [o.outputLevel, o.egR, o.detune]));
  check(before === after, '原音色对象一个字段都没被动过（撤销就是丢弃结果，不用反向推算）');
  check(r.voice !== v.d && DX7.hex(r.voice.raw) !== DX7.hex(v.d.raw), '返回的是一个新音色');

  const same = INTENT.applyIntent(v.d, { axes: {} });
  check(DX7.hex(same.voice.raw) === DX7.hex(v.d.raw), '空意图 == 恒等变换（逐字节相同）');
  check(same.warnings.length === 1 && /没有产生任何改动/.test(same.warnings[0]),
    '空意图会明确说"没有产生任何改动"而不是假装做了什么');
}

/* ============================================ ⑤ 方向正确性（实测） */
console.log('\n⑤ 方向正确性 —— 渲染出来量一遍，不是看代码');
/* metrics 用来判**方向**（任一走对即算对、全反才算反）；
   primary 单独用来判**幅度**（这次改动够不够大）。

   为什么要分成两个：方向判断可以容忍某个指标失灵 —— 另一个会把它救回来。
   而「典型幅度」只能有一个数，那个数就必须是**跨音色集稳定**的。
   实测（2026-10-15，同一批代码、同一把尺子，只换音色集）：

     说法        指标        随附 32 个   全部 160 个
     暗一点      cen             10.0%        9.2%   稳，可当 primary
     起音更慢    oneSecT         10.9%       10.9%   稳，可当 primary
     起音更慢    headFrac         1.9%        7.0%   **漂**，一开始误当成了主指标
     起音更慢    oneSecE          3.7%        2.1%   漂，而且基本是噪声
     尾巴更长    totalE         160.4%       31.1%   漂，但两边都远超阈值，可用

   为什么 headFrac 会漂：它是「前 100 ms 能量 ÷ 前 1 s 能量」，一个**有界的比例**。
   分母本来就集中在 100 ms 里的音色，相对变化被压在 3% 以内；分母几乎为 0 的，
   相对变化可以随便上百。**同一把尺子量不同的音色，读数根本不可比。**
   而 oneSecT 是时间重心（毫秒），是同量纲上的位移，跨音色集才稳得住。

   这和前面三次踩的坑是同一类：**量错了东西，看起来像功能坏了。**
   完整经过与数字在 NATURAL-LANGUAGE.md 里也留了一份。 */
const probes = [
  { text: '更亮', axis: 'bright', want: +1, kind: 'spec',
    metrics: ['cen', 'r15'], primary: 'cen', render: 1.6,
    name: '亮度（频谱重心 / 1.5 kHz 以上能量占比）' },
  { text: '暗一点', axis: 'bright', want: -1, kind: 'spec',
    metrics: ['cen', 'r15'], primary: 'cen', render: 1.6,
    name: '变暗（频谱重心 / 1.5 kHz 以上能量占比）' },
  { text: '起音更慢', axis: 'attack', want: +1, kind: 'env',
    metrics: ['headFrac', 'oneSecE', 'oneSecT'], primary: 'oneSecT', render: 1.6,
    name: '起音（能量后移）' },
  { text: '尾巴更长', axis: 'sustain', want: +1, kind: 'env',
    metrics: ['totalE', 'totalT', 'tailFrac', 't40'], primary: 'totalE', render: 5.0,
    name: '延音（包络拖后）' },
];
const report = {};
for (const p of probes) {
  let tested = 0, ok = 0, flat = 0, reversed = 0, skipped = 0;
  const bad = [], flatEx = [], samples = [], rels = [], prims = [];
  for (const v of allVoices) {
    const r = INTENT.applyIntent(v.d, INTENT.parseLocal(p.text));
    if (!r.changes.some(c => c.axis === p.axis)) { skipped++; continue; }
    tested++;
    const car = DX7.describe(v.d, FM).carriers;
    const src = p.kind === 'env' ? carrierOnly(v.d, car) : v.d;
    const dst = p.kind === 'env' ? carrierOnly(r.voice, car) : r.voice;
    const bufA = render(src, p.render), bufB = render(dst, p.render);
    const mA = p.kind === 'spec' ? tone(bufA) : energy(bufA);
    const mB = p.kind === 'spec' ? tone(bufB) : energy(bufB);

    let anyGood = false, allBad = true, best = -Infinity, prim = 0;
    const detail = [];
    for (const key of p.metrics) {
      const v0 = V[key](mA), v1 = V[key](mB);
      const rel = (v0 > 1e-12 ? (v1 - v0) / v0 : 0) * METRIC[key].dir * p.want;
      if (rel > best) best = rel;
      if (rel > THR) anyGood = true;
      if (rel >= -THR) allBad = false;
      if (key === p.primary) prim = rel;   // 幅度只看这一个，不看「最好的那个」
      detail.push(`${key} ${v0.toFixed(2)}→${v1.toFixed(2)}`);
    }
    rels.push(best);
    prims.push(prim);
    if (anyGood) {
      ok++;
      if (samples.length < 3) samples.push(`${v.d.name} ${detail[0]}`);
    } else if (allBad) {
      reversed++;
      bad.push(`${v.label}:${v.d.name}  ${detail.join('  ')}`);
    } else {
      flat++;
      if (flatEx.length < 4) flatEx.push(`${v.label}:${v.d.name}`);
    }
  }
  rels.sort((a, b) => a - b);
  prims.sort((a, b) => a - b);
  const median = prims.length ? prims[Math.floor(prims.length / 2)] : 0;
  const worst = rels.length ? rels[0] : 0;
  report[p.axis + (p.want < 0 ? '-' : '+')] = { tested, ok, flat, reversed, skipped, samples, median, worst };
  const pct = tested ? (ok / tested * 100).toFixed(1) : '0';
  const f1 = (x) => (x * 100).toFixed(1) + '%';
  console.log(`\n  ${p.name}`);
  console.log(`    说「${p.text}」→ 被改 ${tested} 个（${skipped} 个因算法无此轴·已达边界而跳过）`);
  console.log(`    方向正确 ${ok}（${pct}%）　没量出变化 ${flat}　反向 ${reversed}`);
  console.log(`    主指标「${p.primary}」的典型变化（中位数）${f1(median)}`
    + `　最不利的一个 ${f1(worst)}　判定阈值 ±${f1(THR)}`);
  if (samples.length) console.log(`    例：${samples.join('，')}`);
  if (flatEx.length) console.log(`    没量出变化的例：${flatEx.join('，')}${flat > flatEx.length ? ' …' : ''}`);
  if (bad.length) console.log(`    反向：${bad.slice(0, 5).join(' | ')}`);
  if (bad.length > 5) console.log(`    （共 ${bad.length} 个反向）`);

  check(reversed === 0, `${p.name}：没有任何一个音色朝反方向变化超过阈值（${tested} 个实测）`,
    bad.length ? bad.slice(0, 5).join(' | ') : `最不利的一个也只有 ${f1(worst)}`);
  check(tested > 0 && ok / tested >= 0.75,
    `${p.name}：至少 75% 的音色量得出正确方向的变化（实测 ${pct}%）`);
  /* 要求中位数达到阈值的两倍。四个 primary 实测分别从 60% / 10% / 11% / 31% 起，
     离 4% 都还有很大余量 —— 这一条是防「刚好过线也算过」的假达标。 */
  check(median > THR * 2,
    `${p.name}：典型幅度（主指标 ${p.primary} 中位数 ${f1(median)}）明显超过阈值的两倍`);
}

/* ================================================== ⑥ 幅度单调性 */
console.log('\n⑥ 幅度单调：程度词必须真的改变改动量');
{
  const sumOf = (voice, text) => {
    const r = INTENT.applyIntent(voice.d, INTENT.parseLocal(text));
    return r.changes.reduce((s, c) => s + c.delta, 0);
  };
  let mono = 0, tested = 0;
  const badEx = [];
  for (const v of allVoices) {
    const a = sumOf(v, '亮一点'), b = sumOf(v, '亮'), c = sumOf(v, '非常亮');
    if (a === 0) continue;              // 这个音色调不了亮度，不参与
    tested++;
    if (a <= b && b <= c && a < c) mono++;
    else if (badEx.length < 3) badEx.push(`${v.label}:${v.d.name} ${a} / ${b} / ${c}`);
  }
  check(tested > 0 && mono / tested >= 0.95,
    `「亮一点」≤「亮」≤「非常亮」在 ${mono}/${tested} 个音色上成立（改动幅度随程度词单调）`,
    badEx.join(' | '));

  const v = someVoice;
  const r = INTENT.applyIntent(v.d, INTENT.parseLocal('亮一点，尾巴长些'));
  check(r.changes.length > 0 && r.changes.every(c => Number.isFinite(c.delta) && c.delta >= 0),
    `每条改动都有一个有限数当幅度（不会出现 NaN —— from/to 有时是给人看的字符串）`,
    r.changes.filter(c => !Number.isFinite(c.delta)).map(c => c.text).join(' | '));
}

/* ================================================ ⑦ 边界与诚实 */
console.log('\n⑦ 边界与诚实');
{
  const extremes = ['非常非常亮', '极其暗', '特别厚'];
  let okCount = 0, err = '';
  const v = someVoice;
  for (const t of extremes) {
    const r = INTENT.applyIntent(v.d, INTENT.parseLocal(t));
    const all = r.voice.ops.flatMap(o => [...o.egR, ...o.egL, o.outputLevel, o.freqFine, o.detune, o.rateScale]);
    const inRange = all.every(x => x >= 0 && x <= 127) && r.voice.feedback >= 0 && r.voice.feedback <= 7;
    if (!inRange) { err = t + ' 产生了越界值'; break; }
    if (DX7.encodeVoice(r.voice)) okCount++;      // 不抛错就算过
  }
  check(okCount === extremes.length, '极端说法产生的参数全部在合法区间（越界会抛错，不会静默写出错字节）', err);

  /* 把调制器的输出电平和包络一起顶死，再说「更亮」——必须说清是为什么改不动 */
  const hx = DX7.decodeVoice(v.raw);
  const carriers = DX7.describe(hx, FM).carriers;
  hx.ops.forEach(o => {
    if (carriers.indexOf(o.num) < 0) { o.outputLevel = 99; o.egL = [99, 99, 99, o.egL[3]]; }
  });
  const sat = INTENT.applyIntent(hx, INTENT.parseLocal('更亮'));
  check(sat.changes.filter(c => c.axis === 'bright').length === 0 && /没法再亮/.test(sat.warnings.join(' ')),
    '调制器电平与包络都已顶到 99 时说「更亮」，会明确说"没法再亮了"而不是假装改了',
    sat.warnings.join(' | ') || '（没有任何警告）');

  /* 只把输出电平顶死、包络还低 —— 这时应该继续抬包络，并说明为什么 */
  const half = DX7.decodeVoice(v.raw);
  half.ops.forEach(o => {
    if (carriers.indexOf(o.num) < 0) { o.outputLevel = 99; o.egL = [40, 40, 40, o.egL[3]]; }
  });
  const hs = INTENT.applyIntent(half, INTENT.parseLocal('更亮'));
  check(hs.changes.some(c => c.axis === 'bright' && /包络/.test(c.what)) && /包络压得很低/.test(hs.warnings.join(' ')),
    '输出电平已顶死但包络还低时，会继续抬包络并说明"明暗变化会比原来平缓"',
    hs.warnings.join(' | ') || '（没有任何警告）');

  /* 算法 32：6 个载波、没有调制器 */
  const pure = allVoices.find(x => (x.d.algorithm & 31) === 31);
  if (pure) {
    const r = INTENT.applyIntent(pure.d, INTENT.parseLocal('更亮'));
    check(r.changes.filter(c => c.axis === 'bright').length === 0 && /调不了亮度/.test(r.warnings.join(' ')),
      '纯载波算法（32）没有调制器可调，界面会说明原因', r.warnings.join(' | '));
  }

  /* 调到边界外时必须报错，不能静默截断 */
  let threw = false;
  try { DX7.encodeVoice({ ...v.d, feedback: 99 }); } catch (e) { threw = true; }
  check(threw, '参数越界时 encodeVoice 直接抛错，不会用掩码静默截断');
}

/* ======================================= ⑧ 改动清单与实际一致 */
console.log('\n⑧ 改动清单 == 实际改动');
{
  const v = someVoice;
  const r = INTENT.applyIntent(v.d, INTENT.parseLocal('亮一点，尾巴长些'));
  let consistent = true, detail = '';
  for (const c of r.changes) {
    if (/输出电平/.test(c.what)) {
      const num = +c.what.match(/OP(\d)/)[1];
      const o = r.voice.ops.find(x => x.num === num);
      if (o.outputLevel !== c.to) { consistent = false; detail = c.what + ' 清单说改到 ' + c.to + '，实际 ' + o.outputLevel; }
    }
    if (/包络电平/.test(c.what)) {
      const num = +c.what.match(/OP(\d)/)[1];
      const o = r.voice.ops.find(x => x.num === num);
      const want = String(c.to).split('/').map(Number);
      if (o.egL.slice(0, 3).join('/') !== want.join('/')) { consistent = false; detail = c.what + ' 与实际不符'; }
    }
  }
  check(consistent, `清单里的 ${r.changes.length} 条改动与实际对象一致（界面显示的 = 设备里写的）`, detail);
  check(r.changes.every(c => c.text && c.text.includes('→')), '每条改动都有人能看懂的文字说明');
  console.log('  改动清单示例：');
  r.changes.slice(0, 6).forEach(c => console.log('    · ' + c.text + '　（幅度 ' + c.delta + '）'));
}

/* ---------------------------------------------------------------- 汇总 */
console.log('\n' + '─'.repeat(58));
for (const p of probes) {
  const k = p.axis + (p.want < 0 ? '-' : '+');
  const r = report[k];
  console.log(`${p.name}：${r.ok}/${r.tested} 个朝正确方向变化（${r.flat} 个量不出、${r.reversed} 个反向）`);
}
console.log(fails === 0 ? '\n结论：意图层全部通过。' : `\n结论：${fails} 项失败。`);
process.exit(fails === 0 ? 0 : 1);
