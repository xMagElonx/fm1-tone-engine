// 字节布局**表**的一致性校验 —— 拿真实字节去判一张表对不对。
//
// tools/layout.mjs 回答的是「我的字节符不符合我的表」。
// 这个工具回答的是另一个问题，也是这个圈子里更常遇到的问题：
//
//     **我参照的那张表，到底对不对？**
//
// 一张布局表最容易出的错，不是某个数字算错，而是**整块偏移错位之后，
// 同一批字节被两个字段各读了一遍**：解码时两个字段拿到同一个值，看起来都正常；
// 编码时后写的把先写的覆盖掉，原字节就回不来了。
// 这种错**不会**在"格式合法、校验和对"的任何检查里露头。
//
// 所以这里不用权威压人，只用能从数据本身量出来的几把尺子：
//
//   ① 音色名窗口 —— 名字必须是可打印 ASCII。整批语料里唯一那个长度为 N 的
//      全可打印窗口，就是名字字段的位置。这把尺子不需要任何人告诉我们答案。
//   ② 算子区的周期 —— 窄字节（max ≤ 15）会以"算子块大小"为步长等距出现。
//      步长量出来了，就知道某个字节属于算子区还是全局区。
//   ③ 位的活性 —— 一个"从来没有为 1 过"的位，要么格式里真没用，
//      要么读数的人站错了位。数据上长得一样，后果完全不同。
//   ④ 声明之间的重叠 —— 同一批位被两条声明占用，就是整块错位的指纹。
//   ⑤ 区间 —— 每个字段有已知的合法范围。**但这把尺子最弱**：
//      出厂 ROM 里本来就躺着几个越界值（见下面的探针），少数越界说明不了问题，
//      大面积越界才是。
//
// 用法：
//   node tools/tablecheck.mjs                    用随附的 32 个音色 + ref/packed128.bin（有就用）
//   node tools/tablecheck.mjs <bank.syx|*.bin>   换成你自己的字节（这才是重点）
//   node tools/tablecheck.mjs --tables           只打印内置的几张候选表
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));

const VB = DX7.VOICE_BYTES;                        // 128
const BANK = DX7.BANK_BYTES;                       // 4096
const SYX = DX7.SYSEX_BYTES;                       // 4104
const OPBLK = DX7.LAYOUT.OP_BLOCK;                 // 17
const NAME_LO = DX7.LAYOUT.NAME_OFFSET;            // 118
const NAME_BYTES = DX7.LAYOUT.NAME_BYTES;          // 10
const LAST = VB - 1;                               // 127

/* 常量守卫。写 tools/layout.mjs 时我把 SYSEX_BYTES 拼成了 SYX_BYTES，
   undefined 进到取模里变成 NaN，条件静默走偏，一路错到"认不出这是什么"。
   一个拼错的名字不会报错，只会变成一个值然后装成正常。 */
{
  const consts = { VB, BANK, SYX, OPBLK, NAME_LO, NAME_BYTES, LAST };
  const bad = Object.entries(consts).filter(([, v]) => !Number.isInteger(v) || v < 0);
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
function h2(t) { console.log(`\n${t}\n${'-'.repeat(72)}`); }
/* 打印一列整数，太长就收尾 —— 免得一屏全是数字 */
function brief(xs, n = 12) {
  const s = xs.slice(0, n).join(', ');
  return xs.length > n ? `${s} …（共 ${xs.length} 个）` : s;
}

/* ================================================================ 候选表 */

/* 字段声明的写法：
     { name, bytes: [a, b] }                  跨字节字段：只参与覆盖/重叠统计
     { name, byte, min, max }                 整字节字段：取值应落在 [min, max]
     { name, byte, bits: [lo, hi], min, max } 位字段：先取出该字节的 lo..hi 位，
                                              再要求落在 [min, max]
   关键：**位窗口**和**取值范围**是两件事。把"反馈占 byte111 的 bit0-2（取值 0-7）"
   写成"整字节 0-7"，会让同一个字节的 bit3（同步位）失去归属 —— 我这把尺子
   第一版就是这么错的，工具自己把它报了出来。 */
const TABLE_PACKED = {
  id: 'packed-128 —— 本项目 / Phosphor DSP / midiwire / DX7 Service Manual 一致的那张',
  ok: true,
  fields: [
    { name: '算子块 ×6（每块 17 字节）', bytes: [0, OPBLK * 6 - 1] },   // 0..101
    { name: '音高包络（4 个 rate + 4 个 level）', bytes: [102, 109] },
    { name: '算法', byte: 110, bits: [0, 4], min: 0, max: 31 },
    { name: '反馈', byte: 111, bits: [0, 2], min: 0, max: 7 },
    { name: '振荡器同步', byte: 111, bits: [3, 3], min: 0, max: 1 },
    { name: 'LFO 速度', byte: 112, min: 0, max: 99 },
    { name: 'LFO 延迟', byte: 113, min: 0, max: 99 },
    { name: 'LFO 音高调制深度', byte: 114, min: 0, max: 99 },
    { name: 'LFO 幅度调制深度', byte: 115, min: 0, max: 99 },
    { name: 'LFO 键同步', byte: 116, bits: [0, 0], min: 0, max: 1 },
    { name: 'LFO 波形', byte: 116, bits: [1, 3], min: 0, max: 5 },
    { name: '音高调制灵敏度', byte: 116, bits: [4, 6], min: 0, max: 7 },
    { name: '移调', byte: 117, min: 0, max: 48 },
    { name: '音色名', bytes: [NAME_LO, NAME_LO + NAME_BYTES - 1] },
  ],
};

/* 反面样本 A：ftrain/pydxseven（2024-11）的 README 与其 dx7_voice_codec.py。
   README 开头写着文档与代码是由 ChatGPT 4o 按提示词生成的。
   它的算子块也是 17 字节（这点对），但全局区整体前移了 14 字节：
   音高包络放在 88、算法放在 96、名字放在 108 —— 而 17 × 6 已经占到 101。
   于是 byte 88..97 被算子 6 与全局区各读了一遍。 */
const TABLE_PYDXSEVEN = {
  id: 'pydxseven 2024（README + dx7_voice_codec.py，README 自述由 ChatGPT 4o 生成）',
  ok: false,
  fields: [
    { name: '算子 1..6', bytes: [0, 97] },
    { name: '音高包络（rate+level）', bytes: [88, 95], min: 0, max: 99 },
    { name: '算法', byte: 96, min: 0, max: 31 },
    { name: '反馈量', byte: 97, min: 0, max: 7 },
    { name: '振荡器同步', byte: 98, min: 0, max: 1 },
    { name: 'LFO 速度', byte: 99, min: 0, max: 99 },
    { name: 'LFO 延迟', byte: 100, min: 0, max: 99 },
    { name: 'LFO 音高调制深度', byte: 101, min: 0, max: 99 },
    { name: 'LFO 幅度调制深度', byte: 102, min: 0, max: 99 },
    { name: 'LFO 同步', byte: 103, min: 0, max: 1 },
    { name: 'LFO 波形', byte: 104, min: 0, max: 5 },
    { name: '音高调制灵敏度', byte: 105, min: 0, max: 7 },
    { name: '幅度调制灵敏度', byte: 106, min: 0, max: 3 },
    { name: '移调', byte: 107, min: 0, max: 48 },
    { name: '音色名（12 字节）', bytes: [108, 119] },
    { name: '频率 coarse/fine/detune', bytes: [120, 127] },
  ],
};

/* 反面样本 B：把振荡器同步读在 byte 111 的 bit4。
   这是本项目自己犯过的错 —— bit4 在整批出厂音色里从来没为 1 过，
   于是这个参数对全部音色都读成「关」，界面也一直显示「关」。 */
const TABLE_BIT4 = {
  id: 'bit4 变体（振荡器同步读在 byte 111 的 bit4）',
  ok: false,
  fields: [
    { name: '振荡器同步', byte: 111, bits: [4, 4], min: 0, max: 1 },
    { name: '反馈', byte: 111, bits: [0, 2], min: 0, max: 7 },
  ],
};

const TABLES = [TABLE_PACKED, TABLE_PYDXSEVEN, TABLE_BIT4];

/* ================================================================ 语料 */

function loadVoices(label, bytes) {
  if (bytes.length && bytes.length % SYX === 0 && bytes[0] === 0xF0) {
    const n = bytes.length / SYX;
    const all = [];
    for (let i = 0; i < n; i++) {
      const bank = DX7.parseBank(bytes.slice(i * SYX, (i + 1) * SYX));   // 头/校验和/F7 不对会抛
      for (let s = 0; s < BANK / VB; s++) all.push(bank.slice(s * VB, (s + 1) * VB));
    }
    return { label, kind: `标准 DX7 SysEx ×${n}`, voices: all };
  }
  if (bytes.length && bytes.length % VB === 0) {
    const n = bytes.length / VB;
    const all = [];
    for (let i = 0; i < n; i++) all.push(bytes.slice(i * VB, (i + 1) * VB));
    return { label, kind: `裸 packed voice ×${n}`, voices: all };
  }
  throw new Error(`${label}：长度 ${bytes.length} 既不是 ${SYX} 的整数倍，`
    + `也不是 ${VB} 的整数倍 —— 认不出这是什么。`);
}

function readStarter() {
  const file = path.join(ROOT, 'data', 'starter.js');
  if (!existsSync(file)) return null;
  const sandbox = {};
  new Function('window', readFileSync(file, 'utf8'))(sandbox);
  const S = sandbox.FM1_STARTER;
  if (!S || !S.banks || !S.banks.length) return null;
  return loadVoices('随附音色库 data/starter.js', new Uint8Array(Buffer.from(S.banks[0], 'base64')));
}

function voiceName(v) {
  let s = '';
  for (let i = NAME_LO; i < NAME_LO + NAME_BYTES; i++) s += String.fromCharCode(v[i]);
  return s.replace(/[^\x20-\x7e]/g, ' ').trim() || '(无名)';
}

/* ================================================================ 尺子 */

/* ① 在整批语料里全部为可打印 ASCII、长度为 len 的窗口有哪些 */
function printableWindows(voices, len) {
  const hits = [];
  for (let s = 0; s + len <= VB; s++) {
    let all = true;
    for (const v of voices) {
      for (let k = 0; k < len; k++) {
        const b = v[s + k];
        if (b < 0x20 || b > 0x7E) { all = false; break; }
      }
      if (!all) break;
    }
    if (all) hits.push(s);
  }
  return hits;
}

/* ② 窄字节的等间距：max ≤ limit 的字节里，最长的等差数列（≥4 项） */
function periodicNarrow(maxByByte, limit) {
  const narrow = [];
  for (let b = 0; b <= LAST; b++) if (maxByByte[b] <= limit) narrow.push(b);
  let best = { step: 0, members: [] };
  for (let step = 2; step <= 64; step++) {
    for (const start of narrow) {
      const run = [];
      for (let x = start; x <= LAST && maxByByte[x] <= limit; x += step) run.push(x);
      if (run.length >= 4 && run.length > best.members.length) best = { step, members: run };
    }
  }
  return { narrow, ...best };
}

/* ③④⑤ 拿一批字节审一张表 */
function auditTable(table, voices) {
  const bitLo = f => (f.bits ? f.bits[0] : 0);
  const bitHi = f => (f.bits ? f.bits[1] : 6);
  const extract = (v, f) => (v[f.byte] >> bitLo(f)) & ((1 << (bitHi(f) - bitLo(f) + 1)) - 1);

  const rangeFails = [], deadBits = [], liveBits = [];
  for (const f of table.fields) {
    if (f.byte === undefined || f.min === undefined) continue;
    let over = 0, ones = 0, lo = Infinity, hi = -Infinity;
    for (const v of voices) {
      const x = extract(v, f);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      if (x < f.min || x > f.max) over++;
      if (x) ones++;
    }
    if (over) rangeFails.push({ f, over, lo, hi });
    /* 单个位的"死/活"不能用区间判：0 和 1 都在合法范围内，over 恒为 0，
       所以活位和死位会被倒进同一堆（我第一版就是这么写的，工具自己报了 FAIL）。
       判据只能是"这一位在语料里到底有没有为 1 过"。 */
    if (f.bits && f.bits[0] === f.bits[1]) (ones ? liveBits : deadBits).push({ f, ones });
  }

  /* 覆盖按**位**统计：同一字节的不同位被不同字段占用是合法的 */
  const claims = Array.from({ length: VB }, () => Array.from({ length: 7 }, () => []));
  for (const f of table.fields) {
    if (f.bytes) {
      for (let b = f.bytes[0]; b <= f.bytes[1]; b++) for (let k = 0; k < 7; k++) claims[b][k].push(f.name);
    } else {
      for (let k = bitLo(f); k <= bitHi(f); k++) claims[f.byte][k].push(f.name);
    }
  }
  const overlapped = [];
  const unclaimed = [];
  for (let b = 0; b <= LAST; b++) {
    for (let k = 0; k < 7; k++) {
      if (!claims[b][k].length) unclaimed.push(`${b}.${k}`);
      else if (claims[b][k].length > 1) overlapped.push({ ref: `${b}.${k}`, by: claims[b][k] });
    }
  }
  return { rangeFails, deadBits, liveBits, overlapped, unclaimed };
}

/* ================================================================ 主流程 */

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const files = args.filter(a => !a.startsWith('--'));

if (flags.has('--tables')) {
  for (const t of TABLES) {
    console.log(`\n${t.ok ? '[正例]' : '[反面样本]'} ${t.id}`);
    for (const f of t.fields) {
      const where = f.bytes ? `byte ${f.bytes[0]}..${f.bytes[1]}`
        : `byte ${f.byte}` + (f.bits ? ` bit ${f.bits[0]}-${f.bits[1]}` : '')
          + (f.min !== undefined ? ` (取值 ${f.min}..${f.max})` : '');
      console.log(`    ${where.padEnd(26)} ${f.name}`);
    }
  }
  process.exit(0);
}

console.log('字节布局表的一致性校验 —— 用真实字节判一张表对不对');
console.log('='.repeat(72));

h2('① 语料');
{
  const consts = { VB, BANK, SYX, OPBLK, NAME_LO, NAME_BYTES };
  check(Object.values(consts).every(v => Number.isInteger(v) && v > 0),
    'engine/dx7.js 的常量都读到了（工具的前提成立）',
    Object.entries(consts).map(([k, v]) => `${k}=${v}`).join('  '));
}

const corpora = [];
if (files.length) {
  for (const p of files) corpora.push(loadVoices(p, new Uint8Array(readFileSync(p))));
} else {
  const st = readStarter();
  if (st) corpora.push(st);
  const ref = path.join(ROOT, 'ref', 'packed128.bin');
  if (existsSync(ref)) corpora.push(loadVoices('ref/packed128.bin', new Uint8Array(readFileSync(ref))));
}

if (!corpora.length) {
  skip('没有可用的语料，本工具给不出结论',
    '随附音色库缺失时先跑 python tools/make_starter.py，'
    + '或直接指向你自己的文件：node tools/tablecheck.mjs your-bank.syx');
  console.log(`\n${'-'.repeat(72)}\nPASS ${pass}   FAIL ${fails}   SKIP ${skips}`);
  process.exit(fails ? 1 : 0);
}
for (const c of corpora) console.log(`  · ${c.label}（${c.kind}，${c.voices.length} 个音色）`);
check(corpora.some(c => c.voices.length >= 32), '至少有一份够用的语料（≥32 个音色）');

const main = corpora.slice().sort((a, b) => b.voices.length - a.voices.length)[0];
const V = main.voices;
console.log(`\n  主语料：${main.label}，${V.length} 个音色`);

h2('② 尺子一：音色名窗口（不需要任何人告诉我们名字在哪）');
{
  const win = printableWindows(V, NAME_BYTES);
  check(win.length > 0, `存在长度为 ${NAME_BYTES} 的全可打印 ASCII 窗口`);
  check(win.length === 1 && win[0] === NAME_LO,
    `这样的窗口唯一，起点是 ${NAME_LO} —— 与 DX7.LAYOUT.NAME_OFFSET 一致`,
    `实测起点集合 [${win.join(', ')}]；DX7.LAYOUT 声明 ${NAME_LO}`);
  const w12 = printableWindows(V, 12);
  check(!w12.includes(108),
    '起点 108 的 12 字节窗口不是全可打印 —— 反面样本 A 把名字放在那里，被数据直接否掉',
    `12 字节全可打印的窗口起点：${w12.length ? w12.join(', ') : '（一个都没有）'}`);
}

h2('③ 尺子二：算子区的周期（窄字节的等间距）');
const maxByByte = Array.from({ length: VB }, (_, b) => V.reduce((m, v) => Math.max(m, v[b]), 0));
const per15 = periodicNarrow(maxByByte, 15);
const per31 = periodicNarrow(maxByByte, 31);
{
  check(per15.step === OPBLK,
    `max ≤ 15 的字节以步长 ${per15.step} 等距出现，正好等于算子块大小 ${OPBLK}`,
    `成员：${per15.members.join(', ')}`);
  check(per15.members.includes(96),
    'byte 96 落在这个周期序列里 → 它属于算子块内部，不是全局区',
    '反面样本 A 把算法号放在 byte 96；它出现在这里，说明那个位置属于算子 6');
  check(maxByByte[110] <= 31 && per31.narrow.includes(110),
    `byte 110 的 max = ${maxByByte[110]} ≤ 31，是 5 位容器，且不在任何 step-17 序列里 → 与"算法在全局区"相容`);
  check(maxByByte[96] <= 15,
    `byte 96 的 max = ${maxByByte[96]}，是 4 位容器（左右曲线各 2 位）—— 装得下算法，但形状不对`);
}

h2('④ 尺子三：位的活性');
let bit3 = 0, bit4 = 0;
for (const v of V) { if ((v[111] >> 3) & 1) bit3++; if ((v[111] >> 4) & 1) bit4++; }
{
  check(maxByByte[111] <= 15,
    `byte 111 的 max = ${maxByByte[111]} ≤ 15 —— 它是一个 4 位容器（3 位反馈 + 1 位同步）`);
  check(bit3 > 0, `byte 111 的 bit3 在 ${bit3} / ${V.length} 个音色里为 1 —— 这个位是活的`);
  check(bit4 === 0, `byte 111 的 bit4 在 ${bit4} / ${V.length} 个音色里为 1 —— 这批数据里它是死的`,
    '所以"把振荡器同步读在 bit4"会对整批音色报同一个值，而真实数据里是有开的');
}

h2('⑤ 尺子四（重叠）与尺子五（区间）：逐张表判定');
const results = new Map();
for (const t of TABLES) {
  const r = auditTable(t, V);
  results.set(t.id, r);
  console.log(`\n  ── ${t.ok ? '[正例]' : '[反面样本]'} ${t.id}`);
  console.log(r.overlapped.length
    ? `     重叠  ${r.overlapped.length} 个位被两条以上声明占用：`
      + brief(r.overlapped.map(o => `${o.ref}(${o.by.join(' + ')})`), 4)
    : '     重叠  没有');
  console.log(r.rangeFails.length
    ? r.rangeFails.map(({ f, over, lo, hi }) =>
      `     区间  「${f.name}」声称 ${f.min}..${f.max}，实测 ${lo}..${hi}，越界 ${over}/${V.length}`).join('\n')
    : '     区间  没有被违反的声明');
  console.log(r.deadBits.length
    ? r.deadBits.map(({ f, ones }) =>
      `     死位  「${f.name}」在 byte ${f.byte} bit ${f.bits[0]} —— ${ones}/${V.length} 个音色为 1`).join('\n')
    : `     位活性  ${r.liveBits.length} 个单位字段全部是活的（`
      + r.liveBits.map(x => `${x.f.byte}.${x.f.bits[0]}=${x.ones}`).join(' ') + '）');
  console.log(`     空位  ${r.unclaimed.length} 个位没有任何声明` + (r.unclaimed.length ? `（${brief(r.unclaimed, 8)}）` : ''));
}

{
  const good = results.get(TABLE_PACKED.id);
  check(good.overlapped.length === 0,
    '[正例] 本项目的表：没有任何一个位被两条声明占用 —— 尺子没有乱开枪',
    good.overlapped.length ? brief(good.overlapped.map(o => o.ref + '(' + o.by.join(' + ') + ')')) : '');
  check(good.deadBits.length === 0,
    '[正例] 本项目的表：声明的位字段全部是活的，没有"声明了却没人读"的位');
  const goodWorst = Math.max(0, ...good.rangeFails.map(x => x.over));
  check(goodWorst <= Math.ceil(V.length * 0.05),
    `[正例] 本项目的表的区间越界只发生在极少数音色（最多 ${goodWorst}/${V.length}）`
    + '—— 那是出厂 ROM 里本来就躺着的越界值，不是表错了',
    good.rangeFails.map(x => `${x.f.name} ${x.over}/${V.length}`).join('；') || '（无越界）');
  if (good.rangeFails.length) {
    const names = [];
    for (const { f } of good.rangeFails) {
      const bad = V.filter(v => {
        const x = (v[f.byte] >> (f.bits ? f.bits[0] : 0)) & ((1 << ((f.bits ? f.bits[1] : 6) - (f.bits ? f.bits[0] : 0) + 1)) - 1);
        return x < f.min || x > f.max;
      });
      for (const v of bad) names.push(`${voiceName(v)}(${f.name})`);
    }
    console.log(`        这些音色是：${brief(names, 8)}`);
  }

  const bad = results.get(TABLE_PYDXSEVEN.id);
  check(bad.overlapped.length >= 8,
    `[反面样本 A] 它让 ${bad.overlapped.length} 个位被两条声明各读一遍 —— 整块偏移错位的指纹`,
    brief(bad.overlapped.map(o => `${o.ref}: ${o.by.join(' + ')}`), 6));
  const big = bad.rangeFails.filter(x => x.over > V.length * 0.2);
  check(big.length >= 4,
    `[反面样本 A] 其中 ${big.length} 处是**大面积**越界（>20% 的音色）—— 这才是能判死一张表的量`,
    big.map(x => `「${x.f.name}」声称 ${x.f.min}..${x.f.max}，实测到 ${x.hi}`).join('；'));
  check(!good.overlapped.length && bad.overlapped.length,
    '同一把尺子：正例零重叠、反面样本多处重叠 —— 它能区分这两者');

  const b4 = results.get(TABLE_BIT4.id);
  check(b4.deadBits.length >= 1,
    '[反面样本 B] 把振荡器同步读在 bit4 的写法，被判为死位 —— 尺子认得这个历史 bug');
}

/* ================================================================ 结论 */
console.log(`\n${'='.repeat(72)}`);
console.log(`PASS ${pass}   FAIL ${fails}   SKIP ${skips}`);
if (fails === 0) {
  console.log('结论：内置的每张候选表都得到了可复现的判定。');
  console.log('      正例通过全部尺子，两张反面样本被点到具体的字节与位。');
  console.log('      要用它判你自己的表：照着上面的 fields 写法把你的表声明一遍即可。');
} else {
  console.log(`${fails} 项失败 —— 先查尺子本身，再看被测的表。`);
}
process.exit(fails ? 1 : 0);
