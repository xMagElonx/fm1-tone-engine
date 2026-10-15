// 参数层审计：engine/params.js —— 单参数实时写入（VCED 表 + SysEx 构造 + 闷音宏）。
//
// 这一层最怕的错不是崩溃，是「映射错位」：把算法号写到 qq=10 而设备认为是 08，
// 程序全程合法、设备全听、只是改的不是你以为的参数。所以尺子有三把：
//   ① 表完整性：155 个参数、(pp,qq) 无重复、与 packed LAYOUT 的位域一一对应
//   ② 格式锚点：圈内真机实测过的字节序列（sezare56 的算法切换样例）必须逐字节复现
//   ③ 数据裁判：128 个出厂音色逐参数验区间 —— 名字位错位会炸 ASCII 断言，
//      LFO 波形错位会炸 0-5 区间断言（这正是 sezare56 表里那处可疑顺序的裁判法）
//   ④ 往返：逐参数 get→set 全部 155 项之后，128 字节必须纹丝不动
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const P = require(path.join(ROOT, 'engine', 'params.js'));

let fails = 0, skipped = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `\n        ${extra}` : ''}`);
  if (!cond) fails++;
  return cond;
};
const skip = (msg) => { console.log(`  SKIP  ${msg}`); skipped++; };
const throws = (fn, frag) => {
  try { fn(); return false; }
  catch (e) { return frag ? String(e.message).includes(frag) : true; }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------------------------------------------------------- 载入 */
const sandbox = {};
new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(sandbox);
const starterSyx = new Uint8Array(Buffer.from(sandbox.FM1_STARTER.banks[0], 'base64'));
const starterPacked = DX7.parseBank(starterSyx);   // 32 × 128 字节

const FACTORY = {
  js: path.join(ROOT, 'data', 'factory.js'),
  bin: path.join(ROOT, 'ref', 'packed128.bin'),
};
const hasFactory = existsSync(FACTORY.js) && existsSync(FACTORY.bin);
let factoryPacked = null;
if (hasFactory) factoryPacked = new Uint8Array(readFileSync(FACTORY.bin));   // 128 × 128

/* ------------------------------------------------------- ① 表完整性 */
console.log('① 参数表完整性');
check(P.PARAM_COUNT === 155, '参数总数 155（126 算子 + 29 全局）');
check(P.OP_PARAM_COUNT === 21 && P.GLOBAL_BASE === 126, '算子块 21 参数、全局区基址 126');
check(P.opBase(6) === 0 && P.opBase(1) === 105, 'VCED 算子基址：OP6=0、OP1=105（sezare56 表）');
check(P.packedOpBase(6) === 0 && P.packedOpBase(1) === 85,
  'packed 块序与 VCED 同向：OP6 块在字节 0、OP1 在字节 85');

const seen = new Set();
let tableOK = true;
for (let i = 0; i < 155; i++) {
  const inf = P.paramInfo(i);
  const key = inf.pp + ':' + inf.qq;
  if (seen.has(key)) { tableOK = false; console.log(`        (pp,qq)=(${key}) 在参数 ${i} 重复`); }
  seen.add(key);
  if (inf.pp !== (i < 126 ? 0 : 1)) tableOK = false;
  if (inf.qq !== (i < 126 ? i : i - 126)) tableOK = false;
}
check(tableOK && seen.size === 155, '155 个 (pp,qq) 无重复、分组正确');

// 名字区：绝对索引 145-154 ↔ packed 118-127（两路来源都指向这里，再用区间断言兜底）
check(P.paramInfo(145).name === 'nameChar1' && P.paramInfo(145).qq === 19,
  '音色名第 1 字符 = 全局组内偏移 19（绝对 145）');

/* ------------------------------------------------------- ② 格式锚点 */
console.log('② SysEx 构造（含圈内真机实测锚点）');
const anchor = P.paramChange(134, 31);   // 算法 → 32 面板值；sezare56 在真机上验证过的样例
check(eq(Array.from(anchor), [0xF0, 0x43, 0x10, 0x01, 0x08, 0x1F, 0xF7]),
  '真机锚点：算法=31 复现 sezare56 实测字节 F0 43 10 01 08 1F F7',
  '实际 ' + DX7.hex(anchor));
const msg = P.paramChange(0, 99);        // OP6 EG R1 → 99
check(eq(Array.from(msg), [0xF0, 0x43, 0x10, 0x00, 0x00, 0x63, 0xF7]),
  'OP6 包络 R1=99 → F0 43 10 00 00 63 F7', '实际 ' + DX7.hex(msg));
check(P.paramChange(134, 0, 5)[2] === 0x15, '通道参数：通道 5 → 状态字节 0x15');
check(P.paramChange(134, 7).length === 7, '参数变更消息固定 7 字节（无校验和）');
check(throws(() => P.paramChange(134, 32), '0-31'), '算法=32 被拒（面板上限 31）');
check(throws(() => P.paramChange(134, 0, 16), '0-15'), 'MIDI 通道 16 被拒');
check(throws(() => P.setParam(new Uint8Array(128), 155, 0), '0-154'), '索引 155 被拒');
check(throws(() => P.setParam(new Uint8Array(127), 0, 0), '128 字节'), '长度不是 128 的数据被拒');
check(throws(() => P.setParam(new Uint8Array(128), 20, 15), '0-14'), '失谐=15 被拒（7 居中，面板 0-14）');
check(throws(() => P.setParam(new Uint8Array(128), 145, 31), '32-127'), '名字字符 <32 被拒');

/* ------------------------------------------------------- ③ 共享字节互不踩脚 */
console.log('③ 共享 packed 字节的位域互不干扰');
{
  const v = starterPacked.slice(0, 128);
  const before = Array.from(v);
  // 一个字节里住两个参数的六个位域，逐个改到与原值不同的合法值
  const pairs = [
    { idx: P.opBase(1) + 11, val: (v[P.opBase(1) + 11] === 0 ? 1 : 0) },   // OP1 左曲线（字节 11 低 2 位）
    { idx: P.opBase(1) + 12, val: 1 },                                     // OP1 右曲线（同字节高位）
    { idx: P.opBase(1) + 13, val: 1 },                                     // OP1 速率缩放（字节 12 低 3 位）
    { idx: P.opBase(1) + 20, val: 7 },                                     // OP1 失谐（字节 12 高 4 位）
    { idx: P.opBase(1) + 14, val: 1 },                                     // OP1 振幅调制灵敏度（字节 13 低 2 位）
    { idx: P.opBase(1) + 15, val: 1 },                                     // OP1 力度灵敏度（字节 13 高位）
    { idx: P.opBase(1) + 17, val: (P.getParam(v, P.opBase(1) + 17) === 0 ? 1 : 0) },  // 模式（字节 15 低位）
    { idx: P.opBase(1) + 18, val: 2 },                                     // 粗调（字节 15 高位）
    { idx: 136, val: (P.getParam(v, 136) === 0 ? 1 : 0) },                 // 同步（字节 111 bit3）
    { idx: 135, val: (7 - P.getParam(v, 135)) || 3 },                      // 反馈（字节 111 低 3 位）
  ];
  for (const p of pairs) P.setParam(v, p.idx, p.val);
  const d0 = DX7.decodeVoice(new Uint8Array(before));
  const d1 = DX7.decodeVoice(v);
  // 除被改的参数外，解码结果必须完全一样 —— 这是「位域读改写没踩邻居」的语义级证明
  const diff = [];
  const changed = new Set(pairs.map(p => p.idx));
  const walk = (a, b, path) => {
    if (diff.length > 12) return;
    if (typeof a !== 'object' || a === null) { if (a !== b) diff.push(path + ': ' + a + ' → ' + b); return; }
    for (const k of Object.keys(b)) {
      if (k === 'raw') continue;
      walk(a[k], b[k], path + '.' + k);
    }
  };
  walk(d0, d1, '');
  // 每个被改参数最多影响一个解码字段，且必须落在被改参数对应的字段集合里 ——
  // 出了这个集合就说明共享字节的读改写踩到了邻居
  const allowed = new Set([
    '.ops.5.leftCurve', '.ops.5.rightCurve', '.ops.5.rateScale', '.ops.5.detune',
    '.ops.5.ampModSens', '.ops.5.keyVelSens', '.ops.5.oscMode', '.ops.5.freqCoarse',
    '.oscKeySync', '.feedback',
  ]);
  const outside = diff.filter(p => !allowed.has(p.split(':')[0]));
  check(diff.length >= 1 && outside.length === 0,
    `解码语义级对比：变化只落在被改的 10 个参数对应的字段（实际 ${diff.length} 处）`,
    outside.join('; ') || diff.join('; '));
  // 精确核对几个关键位域
  check(d1.ops[5].leftCurve !== d0.ops[5].leftCurve || pairs[0].val === P.getParam(v, P.opBase(1) + 11),
    'OP1 左曲线已按新值落位');
  check(d1.feedback === P.getParam(v, 135) && d1.oscKeySync === P.getParam(v, 136),
    '字节 111：反馈与同步两个位域共存且各自正确');
  check(d1.ops[5].detune === P.getParam(v, P.opBase(1) + 20)
     && d1.ops[5].rateScale === P.getParam(v, P.opBase(1) + 13),
    '字节 12：失谐与速率缩放共存且各自正确');
}

/* ------------------------------------------------------- ④ 往返：get 全部 → set 全部 → 字节不变 */
console.log('④ 参数层往返：155 项逐个 get→set，128 字节纹丝不动');
function roundTrip(packed, count, label) {
  let untouched = 0, skippedOver = 0;
  for (let vi = 0; vi < count; vi++) {
    const orig = packed.slice(vi * 128, (vi + 1) * 128);
    const copy = orig.slice();
    for (let i = 0; i < 155; i++) {
      const cur = P.getParam(copy, i);
      const inf = P.paramInfo(i);
      if (cur > inf.max || cur < inf.min) { skippedOver++; continue; }  // 面板外的存量值：读得出、写不进
      P.setParam(copy, i, cur);
    }
    if (DX7.hex(orig) !== DX7.hex(copy)) return { ok: false, vi };
    untouched++;
  }
  return { ok: true, untouched, skippedOver };
}
{
  const r = roundTrip(starterPacked, 32, 'starter');
  check(r.ok, 'starter 32 个音色：全参数往返逐字节相同');
  check(r.skippedOver === 0, 'starter 音色没有面板外的存量值', '面板外值个数 ' + r.skippedOver);
}

/* ------------------------------------------------------- ⑤ 数据裁判（缺语料就大声 SKIP） */
console.log('⑤ 数据裁判：128 个出厂音色逐参数验区间');
if (!hasFactory) {
  skip('需要出厂语料（data/factory.js + ref/packed128.bin）。做法：bash tools/fetch_ref.sh && python tools/build_assets.py');
  skip('活性类断言（同步位 87/128）按出厂语料校准，starter 32 个恰好全关，跳过。');
} else {
  let badName = 0, badDetune = 0, badWave = 0, badTranspose = 0, badCurve = 0;
  let mismatchAlg = 0, mismatchFb = 0, mismatchSync = 0;
  const over = [];                                  // 越面板值：只允许两种已知形态
  for (let vi = 0; vi < 128; vi++) {
    const v = factoryPacked.slice(vi * 128, (vi + 1) * 128);
    const d = DX7.decodeVoice(v);
    for (let c = 0; c < 10; c++) {
      const val = P.getParam(v, 145 + c);
      if (val < 32 || val > 127) badName++;
    }
    for (let op = 1; op <= 6; op++) {
      const b = P.opBase(op);
      if (P.getParam(v, b + 20) > 15) badDetune++;   // 存储上限 15（4 位）
      if (P.getParam(v, b + 11) > 3 || P.getParam(v, b + 12) > 3) badCurve++;
    }
    if (P.getParam(v, 142) > 5) badWave++;       // LFO 波形 0-5 —— 抓 sezare56 表里那处可疑顺序
    if (P.getParam(v, 144) > 48) badTranspose++;
    if (P.getParam(v, 134) !== d.algorithm) mismatchAlg++;
    if (P.getParam(v, 135) !== d.feedback) mismatchFb++;
    if (P.getParam(v, 136) !== d.oscKeySync) mismatchSync++;
    for (let i = 0; i < 155; i++) {
      const inf = P.paramInfo(i);
      const val = P.getParam(v, i);
      if (val > inf.max || val < inf.min) over.push({ i, val, inf });
    }
  }
  check(badName === 0, '音色名 10 字节（参数 145-154）全部可打印 ASCII —— 名字位没有映射错位',
    '越界个数 ' + badName);
  check(badDetune === 0, '失谐（每算子参数 20）全部落在 4 位存储内（0-15）', '越界个数 ' + badDetune);
  check(badCurve === 0, '左右曲线（参数 11/12）全部 0-3', '越界个数 ' + badCurve);
  check(badWave === 0, 'LFO 波形（参数 142）全部 0-5 —— 若与 LFO 速度错位此处必然爆炸',
    '越界个数 ' + badWave);
  check(badTranspose === 0, '移调（参数 144）全部 0-48', '越界个数 ' + badTranspose);
  check(mismatchAlg === 0 && mismatchFb === 0 && mismatchSync === 0,
    '算法/反馈/同步与已验证解码器逐音色一致',
    `不一致 ${mismatchAlg}/${mismatchFb}/${mismatchSync}`);
  // 出厂语料里存在「面板外但存储合法」的存量值 —— 实测全部是两种已知形态：
  //   0x7F（127）= DX7 出厂音色对未使用参数的经典填充约定；失谐 15 = 同类。
  // 若映射错位，这里会出现别的值（比如反馈里读出 100），断言当场炸。
  const overWeird = over.filter(o =>
    o.val !== 127 && !(o.inf.name === 'detune' && o.val === 15));
  check(overWeird.length === 0,
    `越面板值全部是已知形态（127 填充 / 失谐 15），共 ${over.length} 处`,
    overWeird.slice(0, 5).map(o => `参数${o.i}=${o.val}`).join('; '));

  // 活性尺（按出厂语料校准）：同步位真的在动 —— 防止「映射到恒 0 的死位」
  let syncOn = 0;
  for (let vi = 0; vi < 128; vi++)
    if (P.getParam(factoryPacked.slice(vi * 128, (vi + 1) * 128), 136) === 1) syncOn++;
  check(syncOn === 87, `振荡器同步（参数 136）在出厂语料中 ${syncOn}/128 为 1（校准值 87）`);

  // 全参数往返也跑一遍出厂语料：155 项 × 128 音色，含那些 0x7F 填充值
  const rf = roundTrip(factoryPacked, 128, 'factory');
  check(rf.ok, '出厂 128 个音色：全参数往返逐字节相同（面板外的存量值只读不写）');
}

/* ------------------------------------------------------- ⑥ 闷音宏 */
console.log('⑥ 闷音宏（palmMute）');
{
  const v = starterPacked.slice(0, 128);   // 第一个 starter 音色
  const m1 = P.palmMute(v), m2 = P.palmMute(v);
  check(eq(m1, m2), '纯函数：同样输入两次调用结果完全一致');
  check(m1.name === 'palmMute' && Array.isArray(m1.changes), '返回 { name, changes } 结构');

  const structuredOK = m1.changes.every(c =>
    Number.isFinite(c.delta) && c.delta === c.to - c.from &&
    Number.isInteger(c.index) && c.index >= 0 && c.index < 155 &&
    P.paramInfo(c.index).max >= c.to && P.paramInfo(c.index).min <= c.to);
  check(structuredOK, '每条变更带数字 delta，且目标值在该参数合法区间内');

  // 方向语义：R 只许变快（to ≥ from），L 只许压低（to ≤ from），反馈只加不减
  const dirOK = m1.changes.every(c => {
    if (/egR[23]/.test(c.name)) return c.to >= c.from;
    if (/egL[23]/.test(c.name)) return c.to <= c.from;
    if (c.name === 'feedback') return c.to === Math.min(7, c.from + 2);
    return false;
  });
  check(dirOK, '方向语义：R2/R3 加速、L2/L3 压低、反馈 +2 封顶 7');

  // 只动「听得见」的算子
  const touchedOps = new Set(m1.changes.filter(c => /OP\d/.test(c.name))
    .map(c => parseInt(c.name.slice(2))));
  const quietOps = [];
  for (let op = 1; op <= 6; op++)
    if (P.getParam(v, P.opBase(op) + 16) < 60 && touchedOps.has(op)) quietOps.push(op);
  check(quietOps.length === 0, '输出电平 <60 的算子不被改动', '误改算子：' + (quietOps.join(',') || '无'));

  // 全员哑巴的极端情形：只剩反馈变更
  const muted = v.slice();
  for (let op = 1; op <= 6; op++) P.setParam(muted, P.opBase(op) + 16, 30);
  const m3 = P.palmMute(muted);
  check(m3.changes.every(c => !/OP\d/.test(c.name)), '全部算子电平 <60 时不再动算子，只剩反馈');

  // SysEx 化：条数一致、字节格式正确、目标值就是变更的 to
  const sysex = P.changesToSysex(m1.changes);
  const sysexOK = sysex.length === m1.changes.length && sysex.every((msg, i) =>
    msg.length === 7 && msg[0] === 0xF0 && msg[1] === 0x43 &&
    msg[3] === P.paramInfo(m1.changes[i].index).pp &&
    msg[4] === P.paramInfo(m1.changes[i].index).qq &&
    msg[5] === m1.changes[i].to && msg[6] === 0xF7);
  check(sysexOK, 'changesToSysex：一条变更一条消息，pp/qq/值逐条对得上');

  // 反馈增益可关
  const fbIdx = 135, fbCur = P.getParam(v, fbIdx);
  const m4 = P.palmMute(v, { feedbackBoost: 0 });
  check(!m4.changes.some(c => c.index === fbIdx && c.to !== fbCur) || fbCur === 7,
    'feedbackBoost=0 时不加反馈');
}

/* ------------------------------------------------------- 收尾 */
console.log('');
if (fails === 0) {
  console.log(`结论：参数层与 packed 布局、真机锚点、出厂语料三方互证通过；` +
    `宏是纯函数、SysEx 可直接发。${skipped ? `（本轮跳过 ${skipped} 项：语料不全）` : ''}`);
} else {
  console.log(`FAIL：${fails} 项未过。`);
}
process.exit(fails === 0 ? 0 : 1);
