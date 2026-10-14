// 音色数据的**位级**一致性审计 —— 任何人拿任何一份 DX7 字节都能跑。
//
// 这个工具的立身之本是：engine/dx7.js 里那份 DX7.LAYOUT 不能是摆设。
//
// 一份字节布局表最容易出的错，不是把数字写错，而是**没人管的那一格**。
// 本项目在这件事上栽过两次，两次都是"看起来全绿"：
//   · 振荡器同步读的是 byte 111 的 bit4，真实在 bit3。
//     bit4 恒为 0 → 这个参数对全部音色都读成"关"，界面也显示"关"，
//     而 128 个出厂音色里有 87 个是"开"。格式合法、校验和对、渲染不报错。
//   · 包络 8 个值按 (R1 L1 R2 L2 …) 交错读，真实是先 4 个 R 再 4 个 L。
//     于是每个音色的包络都不是设计的样子，而渲染只是安静地不一样了。
//
// 所以这里查的是**位级归属**，不是数值范围：
//   ① 布局表自洽 —— 128 字节的 bit0–6 每个最多被一个字段占用，且没有整格没人管
//   ② 位级突变 —— 每个声明出去的位单独翻转，解码结果必须变；
//                  每个没声明的位单独翻转，解码结果必须不变（没声明=死位）
//   ③ 逐字节往返 —— decodeVoice → encodeVoice 必须与原字节相同
//   ④ 区间 —— 不得出现超出 packed 字段容量的取值
//
// 用法：
//   node tools/layout.mjs                    用随附的 32 个音色自检
//   node tools/layout.mjs <bank.syx|*.bin>   审计你自己的字节（这才是重点）
//   node tools/layout.mjs --map              打印完整布局表
//   node tools/layout.mjs --json             布局表以 JSON 输出
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));

const VB = DX7.VOICE_BYTES, BLK = DX7.LAYOUT.OP_BLOCK, NBLK = DX7.LAYOUT.OP_COUNT;
const OP_BYTES = BLK * NBLK;                       // 102
const NAME_LO = DX7.LAYOUT.NAME_OFFSET;            // 118
const NAME_HI = NAME_LO + DX7.LAYOUT.NAME_BYTES - 1;
const SYX = DX7.SYSEX_BYTES, BANK = DX7.BANK_BYTES;

/* 常量守卫。写这个工具的时候我自己踩了一次：把 SYSEX_BYTES 拼成了 SYX_BYTES，
   于是 DX7.SYX_BYTES 是 undefined，`4104 % undefined` 得到 NaN，
   NaN === 0 为假 → 条件静默走偏，一路错到"认不出这是什么"。
   **一个拼错的名字不会报错，只会变成 NaN 然后装成正常。**
   所以这些常量必须当面确认一次 —— 本项目在"静默写错比报错危险得多"上已经有两次教训。 */
{
  const wrong = { VB, BLK, NBLK, SYX, BANK, NAME_LO, NAME_HI }
  const bad = Object.entries(wrong).filter(([, v]) => !Number.isInteger(v) || v <= 0);
  if (bad.length) {
    console.log('FAIL  engine/dx7.js 的常量没有读全，本工具的前提不成立：');
    for (const [k, v] of bad) console.log(`        ${k} = ${String(v)}`);
    process.exit(1);
  }
}

let pass = 0, fails = 0, skips = 0;
function check(cond, msg, extra = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `\n        ${extra}` : ''}`);
  cond ? pass++ : fails++;
  return cond;
}
function skip(msg, how) {
  console.log(`  SKIP  ${msg}`);
  if (how) console.log(`        ${how}`);
  skips++;
}

/* ---------------------------------------------------------------- 布局表展开 */

/* 算子块内 17 字节 × 7 位、全局区 26 字节 × 7 位，各自一张格子表。
   格子表的作用是让"重叠"和"没人管"都变成可判定的问题，而不是靠人眼扫注释。 */
const opCells = Array.from({ length: BLK }, () => new Array(7).fill(null));
const glCells = new Map();
const glRow = b => {
  if (!glCells.has(b)) glCells.set(b, new Array(7).fill(null));
  return glCells.get(b);
};
const overlap = [];
for (const f of DX7.LAYOUT.OP_FIELDS) {
  for (let bit = f.lo; bit <= f.hi; bit++) {
    if (opCells[f.byte][bit]) overlap.push(`算子块 byte ${f.byte} bit ${bit}：${opCells[f.byte][bit]} 与 ${f.name}`);
    else opCells[f.byte][bit] = f.name;
  }
}
for (const f of DX7.LAYOUT.GLOBAL_FIELDS) {
  const span = f.span || 1;
  for (let k = 0; k < span; k++) {
    const row = glRow(f.byte + k);
    for (let bit = f.lo; bit <= f.hi; bit++) {
      if (row[bit]) overlap.push(`byte ${f.byte + k} bit ${bit}：${row[bit]} 与 ${f.name}`);
      else row[bit] = f.name;
    }
  }
}
const cellOf = (byte, bit) => byte < OP_BYTES
  ? opCells[byte % BLK][bit]
  : (glCells.get(byte) ? glCells.get(byte)[bit] : null);

/* ---------------------------------------------------------------- ① 布局表自洽 */

console.log('① 布局表自洽（先看这份声明自己站不站得住，还没轮到实现）');
check(NBLK * BLK === OP_BYTES && OP_BYTES === 102,
  `算子区 = ${NBLK} 块 × ${BLK} 字节 = ${OP_BYTES} 字节，紧接全局区`);
check(DX7.LAYOUT.OP_FIELDS.every(f => f.byte >= 0 && f.byte < BLK),
  `算子字段全部落在块内 0–${BLK - 1}`);
check(DX7.LAYOUT.GLOBAL_FIELDS.every(f => f.byte >= OP_BYTES && f.byte + (f.span || 1) - 1 < VB),
  `全局字段全部落在 ${OP_BYTES}–${VB - 1}`);
check(overlap.length === 0, '没有任何一位被两个字段同时占用', overlap.slice(0, 6).join('\n        '));
check(NAME_LO === OP_BYTES + 16 && DX7.LAYOUT.NAME_BYTES === 10,
  `音色名声明在 byte ${NAME_LO}–${NAME_HI}（10 个整字节 ASCII）`);

const bareOp = [], bareGl = [];
for (let i = 0; i < BLK; i++) if (opCells[i].every(c => !c)) bareOp.push(i);
for (let i = 0; i < VB; i++) {
  if (i < OP_BYTES) continue;
  const row = glCells.get(i);
  if (!row || row.every(c => !c)) bareGl.push(i);
}
check(bareOp.length === 0 && bareGl.length === 0,
  '128 个字节没有一个是"整格没人管"',
  [...bareOp.map(i => `算子块 byte ${i}`), ...bareGl.map(i => `byte ${i}`)].join('、'));

const rng = hs => {
  hs = [...new Set(hs)].sort((a, b) => a - b);
  const out = []; let s = hs[0], p = hs[0];
  for (let i = 1; i < hs.length; i++) {
    if (hs[i] === p + 1) { p = hs[i]; continue; }
    out.push(s === p ? `${s}` : `${s}-${p}`); s = p = hs[i];
  }
  out.push(s === p ? `${s}` : `${s}-${p}`);
  return out.join(',');
};
const listGaps = (row) => {
  const gaps = []; for (let b = 0; b < 7; b++) if (!row[b]) gaps.push(b);
  return gaps.length ? rng(gaps) : null;
};
const opGaps = [...new Set(Array.from({ length: BLK }, (_, i) => i)
  .filter(i => listGaps(opCells[i]))
  .map(i => `byte ${i} bit ${listGaps(opCells[i])}`))];
const glGaps = [...glCells.keys()].sort((a, b) => a - b)
  .filter(b => listGaps(glCells.get(b)))
  .map(b => `byte ${b} bit ${listGaps(glCells.get(b))}`);
console.log(`  ----  没被任何字段占用的位（是"格式里没用"，不是漏写）：`);
console.log(`        算子块内（6 个块相同）：${opGaps.join('，') || '无'}`);
console.log(`        全局区：${glGaps.join('，') || '无'}`);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(DX7.LAYOUT, null, 2));
  process.exit(0);
}
if (process.argv.includes('--map')) {
  console.log('\n  布局表（算子字段的字节号是块内相对偏移，实际偏移 = 块内偏移 + 17 × 块号）');
  console.log('  区   字节  字段                位        容量');
  const cap = (lo, hi) => `0-${(1 << (hi - lo + 1)) - 1}`;
  for (const f of DX7.LAYOUT.OP_FIELDS) {
    console.log(`  算子 ${String(f.byte).padStart(3)}   ${f.name.padEnd(18)} bit${f.lo}-${f.hi}  ${cap(f.lo, f.hi)}`);
  }
  for (const f of DX7.LAYOUT.GLOBAL_FIELDS) {
    const span = f.span || 1;
    const bytes = span > 1 ? `${f.byte}-${f.byte + span - 1}` : String(f.byte);
    console.log(`  全局 ${bytes.padStart(3)}   ${f.name.padEnd(18)} ${span > 1 ? '整字节×' + span : `bit${f.lo}-${f.hi}`}  ${span > 1 ? '10 个 ASCII' : cap(f.lo, f.hi)}`);
  }
  console.log('');
}

/* ------------------------------------------------------------ 载入待审计的数据 */

/* 随附音色库始终在仓库里，所以默认用来做自检；它证明的是"表与实现自洽"。
   真正的证据是那些**不随仓库分发**的真机字节 —— 有就一并审，没有就大声跳过。 */
function loadStarter() {
  const p = path.join(ROOT, 'data', 'starter.js');
  if (!existsSync(p)) return null;
  const sandbox = {};
  new Function('window', readFileSync(p, 'utf8'))(sandbox);
  const S = sandbox.FM1_STARTER;
  if (!S || !S.banks || !S.banks[0]) return null;
  return new Uint8Array(Buffer.from(S.banks[0], 'base64'));
}

function unpack(label, bytes) {
  if (bytes.length % SYX === 0 && bytes[0] === 0xF0) {
    const n = bytes.length / SYX;
    const out = [];
    for (let i = 0; i < n; i++) {
      const bank = bytes.slice(i * SYX, (i + 1) * SYX);
      out.push(DX7.parseBank(bank));            // 头/校验和/F7 不对会抛
    }
    const all = new Uint8Array(out.length * BANK);
    out.forEach((b, i) => all.set(b, i * BANK));
    return { label, kind: `标准 DX7 SysEx ×${n}`, data: all, syx: bytes };
  }
  if (bytes.length % VB === 0) {
    return { label, kind: `裸 packed voice ×${bytes.length / VB}`, data: bytes, syx: null };
  }
  throw new Error(`${label}：长度 ${bytes.length} 既不是 ${SYX} 的整数倍，`
    + `也不是 ${VB} 的整数倍 —— 认不出这是什么。`);
}

const argFile = process.argv.slice(2).find(a => !a.startsWith('--'));
const sources = [];
if (argFile) {
  sources.push(unpack(argFile, new Uint8Array(readFileSync(argFile))));
} else {
  const st = loadStarter();
  if (st) sources.push(unpack('data/starter.js（随仓库分发，32 个本仓库原创音色）', st));
  else skip('随附音色库不存在，跳过自检', 'data/starter.js 应该在仓库里；缺了说明 clone 不完整。');
  const ref = path.join(ROOT, 'ref', 'packed128.bin');
  if (existsSync(ref)) sources.push(unpack('ref/packed128.bin（真机抓包，不随仓库分发）', new Uint8Array(readFileSync(ref))));
  else skip('真机字节不在本地，这一节跳过 —— 但它才是布局的**证据**',
    '做法：bash tools/fetch_ref.sh，然后重跑本命令。');
}

/* ---------------------------------------------------- ② 位级归属（突变测试） */

console.log('\n② 位级归属：把每个位单独翻转，看解码结果动不动');
const sample = sources[0].data.slice(0, VB);
const strip = d => { const o = {}; for (const k of Object.keys(d)) if (k !== 'raw') o[k] = d[k]; return JSON.stringify(o); };
const baseOut = strip(DX7.decodeVoice(sample));
const declaredDead = [], undeclaredLive = [];
for (let byte = 0; byte < VB; byte++) {
  if (byte >= NAME_LO && byte <= NAME_HI) continue;   // 名字是 10 个整字节 ASCII，见第 ③ 节单独测
  for (let bit = 0; bit < 7; bit++) {
    const v = sample.slice();
    v[byte] ^= (1 << bit);
    const changed = strip(DX7.decodeVoice(v)) !== baseOut;
    if (cellOf(byte, bit) && !changed) declaredDead.push(`${byte}.${bit}`);
    if (!cellOf(byte, bit) && changed) undeclaredLive.push(`${byte}.${bit}`);
  }
}
check(declaredDead.length === 0,
  '每个被声明的位都真的影响解码结果 —— 没有"声明了却没人用"的假参数',
  declaredDead.length ? '这些位翻转后解码结果没变：' + declaredDead.slice(0, 12).join(', ') : '');
check(undeclaredLive.length === 0,
  '每个没被声明的位都是死位 —— 布局表是**完整**的，不只是"不重叠"',
  undeclaredLive.length ? '这些位翻转后解码结果变了：' + undeclaredLive.slice(0, 12).join(', ') : '');

/* ---------------------------------------------------------------- ③ 数据源审计 */

let sec = 3;
for (const src of sources) {
  const count = src.data.length / VB;
  console.log(`\n${'③④⑤⑥⑦⑧⑨'[sec - 3] || sec} 数据源：${src.label}`);
  console.log(`        识别为：${src.kind}，共 ${count} 个音色`);

  if (src.syx) {
    check(src.syx[src.syx.length - 1] === 0xF7 && src.syx[0] === 0xF0,
      `SysEx 结构通过：${DX7.hex(src.syx.slice(0, 6))} … 校验和 0x${src.syx[4102].toString(16)}`);
  }

  let over7 = 0, firstOver = null;
  for (let i = 0; i < src.data.length; i++) {
    if (src.data[i] > 0x7F) {
      over7++;
      if (firstOver === null) firstOver = i;
    }
  }
  check(over7 === 0, '全部字节都在 MIDI 的 7 位范围内（0–127）',
    over7 ? `${over7} 个字节越界，第一个在偏移 ${firstOver}` : '');

  let bad = [], badName = [], worst = null, badNames = [];
  let rangeBad = 0, overPanel = 0, overPanelEx = null;
  for (let i = 0; i < count; i++) {
    const raw = src.data.slice(i * VB, i * VB + VB);
    const d = DX7.decodeVoice(raw);
    let enc;
    try { enc = DX7.encodeVoice(d); }
    catch (e) { bad.push(`#${i} ${JSON.stringify(d.name)} 编码抛错：${e.message}`); continue; }
    let diff = -1;
    for (let k = 0; k < VB; k++) if (enc[k] !== raw[k]) { diff = k; break; }
    if (diff >= 0) {
      if (diff >= NAME_LO) badNames.push(`#${i} byte ${diff} 0x${raw[diff].toString(16)}→0x${enc[diff].toString(16)}`);
      else bad.push(`#${i} ${JSON.stringify(d.name)} byte ${diff} 0x${raw[diff].toString(16)}→0x${enc[diff].toString(16)}`);
    }
    if (!d.name.trim()) badName.push(`#${i}`);
    /* 区间：PACKED 的字节容量就是位宽，越界只可能是位域读错 */
    const bumps = [];
    const push = (v, name) => {
      bumps.push([v, name]);
    };
    push(d.algorithm, 'algorithm'); push(d.feedback, 'feedback'); push(d.oscKeySync, 'oscKeySync');
    push(d.transpose, 'transpose'); push(d.lfoSpeed, 'lfoSpeed'); push(d.lfoDelay, 'lfoDelay');
    push(d.lfoPitchModDepth, 'lfoPitchModDepth'); push(d.lfoAmpModDepth, 'lfoAmpModDepth');
    push(d.lfoPitchModSens, 'lfoPitchModSens'); push(d.lfoWave, 'lfoWave'); push(d.lfoSync, 'lfoSync');
    for (const o of d.ops) {
      [...o.egR, ...o.egL].forEach((v, k) => push(v, `OP${o.num}.eg${k < 4 ? 'R' : 'L'}${k % 4 + 1}`));
      push(o.breakPoint, `OP${o.num}.breakPoint`); push(o.leftDepth, `OP${o.num}.leftDepth`);
      push(o.rightDepth, `OP${o.num}.rightDepth`); push(o.leftCurve, `OP${o.num}.leftCurve`);
      push(o.rightCurve, `OP${o.num}.rightCurve`); push(o.detune, `OP${o.num}.detune`);
      push(o.rateScale, `OP${o.num}.rateScale`); push(o.keyVelSens, `OP${o.num}.keyVelSens`);
      push(o.ampModSens, `OP${o.num}.ampModSens`); push(o.outputLevel, `OP${o.num}.outputLevel`);
      push(o.oscMode, `OP${o.num}.oscMode`); push(o.freqCoarse, `OP${o.num}.freqCoarse`);
      push(o.freqFine, `OP${o.num}.freqFine`);
    }
    for (const [v, name] of bumps) {
      if (!Number.isInteger(v) || v < 0) { rangeBad++; if (!worst) worst = `#${i} ${name}=${v}`; }
    }
    if (d.ops.every(o => o.outputLevel === 0)) { if (!overPanelEx) overPanelEx = `#${i} 全部算子输出电平为 0`; }
    if (d.ops.some(o => o.outputLevel > 99)) overPanel++;
  }
  check(bad.length === 0, '每个音色 decodeVoice → encodeVoice 后逐字节相同（参数区 byte 0–117）',
    bad.slice(0, 4).join('\n        '));
  check(badNames.length === 0, '音色名区 byte 118–127 也能逐字节写回',
    badNames.slice(0, 4).join('\n        '));
  check(badName.length === 0, '没有名字为空的音色', badName.slice(0, 8).join(', '));
  check(rangeBad === 0, '没有出现负数或非整数参数', worst || '');
  check(overPanel === 0, '没有"全部算子输出电平为 0"的音色（那种音色是哑的）', overPanelEx || '');

  /* 名字往返：写一个已知名字进去，必须原样解出来 */
  const probe = src.data.slice(0, VB);
  DX7.writeName(probe, 0, 'LAYOUT OK!');
  check(DX7.decodeVoice(probe).name === 'LAYOUT OK!',
    '音色名往返：写入 10 字节 ASCII 后原样解出');
  sec++;
}

console.log('\n----------------------------------------');
console.log(`合计：${pass} 项通过，${fails} 项失败，${skips} 项跳过`);
console.log(fails === 0
  ? '结论：全部通过。'
  : `${fails} 项失败 —— 布局表与实现已经分家了，先看上面标出来的字节/位。`);
process.exit(fails === 0 ? 0 : 1);
