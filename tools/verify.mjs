// 直接审计 engine/dx7.js —— 页面加载的就是这一份，不再从 index.html 里抽代码。
// 如果解码器里任何一个偏移量写错了，真实的出厂数据必然落到 DX7 合法区间之外。
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const C = require(path.join(ROOT, 'engine', 'dx7.js'));

/* 这一套审计的立身之本是"拿真实世界的字节来验解码器" —— 所以它必须有那批
   不随仓库分发的数据（出厂音色 + 地面真值）。全新 clone 上它无从下手，
   那就**大声跳过**：既不崩，也不悄悄给个通过。
   为什么不退而求其次改用随附音色库来跑：那批字节是本仓库自己的编码器生成的，
   拿它验解码器属于自证，等于没验 —— 这正是本项目最忌讳的那种"看起来全绿"。 */
const NEEDED = {
  'data/factory.js': path.join(ROOT, 'data', 'factory.js'),
  'ref/bank1.syx': path.join(ROOT, 'ref', 'bank1.syx'),
  'ref/packed128.bin': path.join(ROOT, 'ref', 'packed128.bin'),
};
const missing = Object.keys(NEEDED).filter(k => !existsSync(NEEDED[k]));
if (missing.length) {
  console.log('SKIP  这一套需要那批"不随仓库分发"的数据，先在本地生成再重跑。');
  console.log('      缺：' + missing.join('、'));
  console.log('      做法：bash tools/fetch_ref.sh && python tools/build_assets.py');
  console.log('      这是**跳过**而不是通过 —— 本次一项断言都没有跑。');
  process.exit(0);
}

const factory = JSON.parse(
  readFileSync(NEEDED['data/factory.js'], 'utf8')
    .replace(/^\/\/[^\n]*\n/, '').replace(/^window\.FM1_FACTORY = /, '').replace(/;\s*$/, ''));

// [ panelMax, storageMax ] - storageMax is the packed byte's capacity
const SPEC = {
  'algorithm': [31, 31], 'feedback': [7, 7], 'oscKeySync': [1, 1], 'transpose': [48, 127],
  'lfoWave': [5, 7], 'lfoSync': [1, 1], 'lfoPitchModSens': [7, 7],
  'pitchEG': [99, 127],
  'op.egR/egL': [99, 127], 'op.breakPoint': [99, 127], 'op.depth': [99, 127],
  'op.curve': [3, 3], 'op.detune': [14, 15], 'op.rateScale': [7, 7],
  'op.keyVelSens': [7, 7], 'op.ampModSens': [3, 3], 'op.outputLevel': [99, 127],
  'op.oscMode': [1, 1], 'op.freqCoarse': [31, 31], 'op.freqFine': [99, 127],
};
const stats = Object.fromEntries(Object.keys(SPEC).map(k => [k, { min: 999, max: -999, over: 0, bad: 0 }]));
function bump(k, val) {
  const s = stats[k];
  if (val < s.min) s.min = val;
  if (val > s.max) s.max = val;
  const [panel, storage] = SPEC[k];
  if (val > storage) s.bad++; else if (val > panel) s.over++;
}

let fails = 0;
const check = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`); if (!cond) fails++; };

// --- ground truth: the published reference bank the user can download
const refBank = new Uint8Array(readFileSync(path.join(ROOT, 'ref', 'bank1.syx')));
const refPacked = new Uint8Array(readFileSync(path.join(ROOT, 'ref', 'packed128.bin')));

console.log('① 与已知参考逐字节比对');
check(C.parseBank(refBank).length === 4096, 'parseBank 校验头/checksum/结尾全部通过');
const rebuilt = C.buildBank(refPacked.slice(0, 4096));
let same = true;
for (let i = 0; i < 4104; i++) if (rebuilt[i] !== refBank[i]) { same = false; console.log('    首个差异 @', i); break; }
check(same, 'buildBank(packed[0..4096]) 与参考 bank1.syx 逐字节一致');

console.log('\n② 解码全部 128 个出厂音色，审计参数区间');
const names = [];
for (let i = 0; i < 128; i++) {
  const d = C.decodeVoice(refPacked.slice(i * 128, i * 128 + 128));
  names.push(d.name);
  bump('algorithm', d.algorithm); bump('feedback', d.feedback); bump('oscKeySync', d.oscKeySync);
  bump('transpose', d.transpose); bump('lfoWave', d.lfoWave); bump('lfoSync', d.lfoSync);
  bump('lfoPitchModSens', d.lfoPitchModSens);
  [...d.pitchEgR, ...d.pitchEgL].forEach(x => bump('pitchEG', x));
  for (const o of d.ops) {
    [...o.egR, ...o.egL].forEach(x => bump('op.egR/egL', x));
    bump('op.breakPoint', o.breakPoint);
    bump('op.depth', o.leftDepth); bump('op.depth', o.rightDepth);
    bump('op.curve', o.leftCurve); bump('op.curve', o.rightCurve);
    bump('op.detune', o.detune); bump('op.rateScale', o.rateScale);
    bump('op.keyVelSens', o.keyVelSens); bump('op.ampModSens', o.ampModSens);
    bump('op.outputLevel', o.outputLevel); bump('op.oscMode', o.oscMode);
    bump('op.freqCoarse', o.freqCoarse); bump('op.freqFine', o.freqFine);
  }
}
let bad = 0, over = 0;
for (const k of Object.keys(stats)) {
  const s = stats[k]; bad += s.bad; over += s.over;
  console.log(`  ${s.bad ? 'FAIL' : (s.over ? 'NOTE' : 'PASS')}  ${k.padEnd(20)} ` +
    `实测 ${String(s.min).padStart(3)}-${String(s.max).padStart(3)}  超格式 ${s.bad}  超文档 ${s.over}`);
}
check(bad === 0, `超出 packed 格式字节范围的取值：${bad} 个`);
console.log(`  NOTE  ${over} 个取值超出 DX7 面板区间（0-99）但仍在字节容量内，见下`);
for (let i = 0; i < 128; i++) {
  const d = C.decodeVoice(refPacked.slice(i * 128, i * 128 + 128));
  const hits = [];
  d.ops.forEach(o => {
    [...o.egR, ...o.egL].forEach((x, k) => { if (x > 99) hits.push(`OP${o.num} EG.${k < 4 ? 'R' : 'L'}${k % 4 + 1}=0x${x.toString(16)}`); });
    if (o.freqFine > 99) hits.push(`OP${o.num} freqFine=0x${o.freqFine.toString(16)}`);
    if (o.detune > 14) hits.push(`OP${o.num} detune=${o.detune - 7}`);
  });
  if (hits.length) console.log(`        槽 ${i} ${JSON.stringify(d.name)}: ${hits.join(', ')}`);
}

console.log('\n③ 已知音色交叉验证');
const v0 = C.decodeVoice(refPacked.slice(0, 128));
check(v0.name === 'PIANO 1', `名字字段 @118 → ${JSON.stringify(v0.name)}`);
check(names[127] === 'WHAT IF', `末槽 → ${JSON.stringify(names[127])}`);
check(v0.algorithm === 4, `PIANO 1 算法 = ${v0.algorithm}（DX7 E.PIANO 1 为算法 5，此处 0 基）`);
check(v0.feedback === 6, `PIANO 1 反馈 = ${v0.feedback}（DX7 E.PIANO 1 为 6）`);
const ops = v0.ops.map(o => `OP${o.num}:ol=${o.outputLevel},c=${o.freqCoarse}`);
console.log('       ' + ops.join('  '));
check(v0.ops[5].num === 1 && v0.ops[0].num === 6, '算子块顺序为 OP6→OP1（块 0 = OP6）');

console.log('\n④ 改名往返');
const copy = refPacked.slice(0, 128);
for (let i = 0; i < 10; i++) copy[118 + i] = 'XIN YIN   '.charCodeAt(i);
check(C.decodeVoice(copy).name.trim() === 'XIN YIN', '在 118 偏移写入 10 字节后名字正确解出');

console.log('\n' + (fails === 0 ? '全部通过。' : `${fails} 项失败。`));
process.exit(fails === 0 ? 0 : 1);
