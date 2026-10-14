/* ============================================================================
   MIDI 层审计：发送守门 + 与真实世界的字节对齐 + 设备往返
   ----------------------------------------------------------------------------
   运行：node tools/midi_test.mjs

   这份脚本要回答三个问题，按重要性排序：
     ① 我们发出去的字节，跟真实世界里的那份 bank 是不是一回事？
        —— 拿 data/factory.js 里那批从真机抓包重建的字节，重新打包一遍，
           要求与原字节逐字节相同。这是"我能写对"的最强证据，
           因为它不依赖任何模拟，直接对齐真实世界。
     ② 我们有没有可能发出不该发的字节？
        —— 发送守门是白名单：只放行标准 32 音色 bank dump，其余一律本地拦下。
     ③ 发出去的包，一个忠实实现协议的设备能不能解回来？
        —— 交给 FakeFm1，解出的 32 个音色必须与源数据一致。
   ========================================================================= */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const MIDI = require(path.join(ROOT, 'engine', 'midi.js'));

let pass = 0, fail = 0;
function check(cond, msg, extra) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}${extra ? '  ← ' + extra : ''}`); }
  return cond;
}
const skip = (msg) => console.log(`  SKIP  ${msg}`);
function section(t) { console.log(`\n${t}`); }
const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; };

/* ------------------------------------------------------------------ 取数据 */
const hasFactory = existsSync(path.join(ROOT, 'data', 'factory.js'));
let FACTORY = null, BANKS = [];
if (hasFactory) {
  const win = {};
  new Function('window', readFileSync(path.join(ROOT, 'data', 'factory.js'), 'utf8'))(win);
  FACTORY = win.FM1_FACTORY;
  BANKS = FACTORY.banks.map(b => DX7.b64ToBytes(b));   // 每个 4104 字节的完整 SysEx
}

/* ==========================================================================
   ① 与真实世界的字节对齐
   ========================================================================== */
section('① 重新打包后，字节与真实世界是否一致');

if (!hasFactory) {
  skip('data/factory.js 不在 —— 先跑 tools/fetch_ref.sh + tools/build_assets.py');
} else {
  check(BANKS.length === 4, '出厂数据是 4 个 bank');
  check(BANKS.every(b => b.length === DX7.SYSEX_BYTES),
    `每个 bank 都是 ${DX7.SYSEX_BYTES} 字节`,
    BANKS.map(b => b.length).join('/'));

  /* 拿 bank 里的裸数据重新打一遍包，必须与原始 SysEx 逐字节相同。
     这就是"页面按发送路径重打包后发出去的字节 = 真实世界那份字节"。 */
  let allSame = true, detail = '';
  for (let i = 0; i < BANKS.length; i++) {
    const raw = DX7.parseBank(BANKS[i]);
    const rebuilt = DX7.buildBank(raw);
    if (!bytesEq(BANKS[i], rebuilt)) {
      allSame = false;
      detail = `bank${i + 1} 首个不同字节 @${firstDiff(BANKS[i], rebuilt)}`;
      break;
    }
  }
  check(allSame, '4 个 bank 重新打包后与原字节逐字节相同', detail);

  /* 逐字节也顺手确认头与校验和的写法，别让"相同"掩盖了两边一起错 */
  const raw0 = DX7.parseBank(BANKS[0]);
  const sy0 = DX7.buildBank(raw0);
  check(DX7.hex(sy0.slice(0, 6)) === 'f0 43 00 09 20 00', '包头是 F0 43 00 09 20 00',
    DX7.hex(sy0.slice(0, 6)));
  check(sy0[4103] === 0xF7, '包尾是 F7');
  check(sy0[4102] === DX7.checksum(raw0), '校验和位置（第 4103 字节）= 数据校验和');
  check(raw0.length === DX7.BANK_BYTES, `裸数据 ${DX7.BANK_BYTES} 字节`);

  /* 名字必须落在 118 偏移上 —— 这是"打包没把顺序搞错"的旁证 */
  check(MIDI.voiceNameAt(raw0, 0) === 'PIANO 1', '第 1 槽解出 PIANO 1', MIDI.voiceNameAt(raw0, 0));
  check(MIDI.voiceNameAt(raw0, 31) === 'SYN PAD 8', '第 32 槽解出 SYN PAD 8', MIDI.voiceNameAt(raw0, 31));
}

if (existsSync(path.join(ROOT, 'ref', 'bank1.syx'))) {
  const ref = new Uint8Array(readFileSync(path.join(ROOT, 'ref', 'bank1.syx')));
  check(ref.length === DX7.SYSEX_BYTES, 'ref/bank1.syx 是 4104 字节', String(ref.length));
  if (hasFactory) {
    check(bytesEq(ref, BANKS[0]), 'data/factory.js 的 bank 1 与 ref/bank1.syx 逐字节相同',
      `首个不同 @${firstDiff(ref, BANKS[0])}`);
  }
} else {
  skip('ref/bank1.syx 不在 —— 跳过与地面真值的比对');
}

/* ==========================================================================
   ② 发送守门：白名单
   ========================================================================== */
section('② 发送守门（只放行标准 32 音色 bank dump）');

/* 样本 bank：优先用出厂数据；全新 clone 上没有它，就退回随附音色库。
   原先的写法是"没有就用 4104 个 0 顶替" —— 那串字节没有合法包头，
   parseBank 当场抛错，于是整份测试在全新 clone 上直接崩掉。
   测试包本身也必须能在全新 clone 上跑完。 */
const goodSrc = (() => {
  if (BANKS.length) return BANKS[0];
  const sw = {};
  new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(sw);
  return DX7.b64ToBytes(sw.FM1_STARTER.banks[0]);
})();
const good = DX7.buildBank(DX7.parseBank(goodSrc));
function rejects(bytes, label) {
  let threw = null;
  try { MIDI.assertWritableSysex(bytes); } catch (e) { threw = e; }
  check(!!threw, `拦下：${label}`, threw ? '' : '竟然放行了');
  return threw;
}

if (hasFactory) {
  check(MIDI.assertWritableSysex(good) === true, '放行：标准 bank dump');
  rejects(BANKS[0].slice(0, 100), '长度只有 100 的残包');

  const wrongHead = Uint8Array.from(BANKS[0]); wrongHead[1] = 0x00;
  wrongHead[2] = 0x32;                                  // 改成 M-VAVE 私有协议的制造商 ID
  rejects(wrongHead, '头是 00 32 私有协议前缀的包');

  const noF7 = Uint8Array.from(BANKS[0]); noF7[4103] = 0x00;
  rejects(noF7, '结尾不是 F7 的包');

  /* 损坏一个数据字节 → 校验和必然不符 → 必须在本地就被拦下，
     而不是发出去了让设备去发现。 */
  const badSum = Uint8Array.from(BANKS[0]); badSum[500] = (badSum[500] + 1) & 0x7F;
  rejects(badSum, '数据被改动、校验和已失效的包');
}

/* 上游文档提到的危险消息：正常升级命令是 F0 22 24 35 7F F7，
   把最后一个数据字节换成 7D 会把设备打进芯片下载模式。它只有 6 字节，
   长度检查就会拦下 —— 但值得单独说一句，因为这是"差一个字节"的那类错误。 */
const dangerous = Uint8Array.from([0xF0, 0x22, 0x24, 0x35, 0x7D, 0xF7]);
rejects(dangerous, '能把设备打进下载模式的 F0 22 24 35 7D F7');
rejects(new Uint8Array(0), '空包');
rejects(null, 'null');
rejects(undefined, 'undefined');

/* ==========================================================================
   ③ 发送 → 设备 → 解回的往返
   ========================================================================== */
section('③ 发送 → 设备模拟 → 解回');

const fm1 = new MIDI.FakeFm1();
const report = MIDI.sendBank(fm1, DX7.parseBank(BANKS.length ? BANKS[0] : good));

check(fm1.received.length === 1, '设备收到 1 条消息', String(fm1.received.length));
check(fm1.received[0].length === DX7.SYSEX_BYTES, `收到 ${DX7.SYSEX_BYTES} 字节`,
  String(fm1.received[0].length));
check(report.bytes === DX7.SYSEX_BYTES, '发送报告：字节数正确');
check(report.header === 'f0 43 00 09 20 00', '发送报告：包头正确', report.header);
check(report.voices === 32, '发送报告：32 个音色');
check(report.names.length === 32, '发送报告：带回 32 个音色名');
check(report.acknowledged === false, '发送报告明确写着「没有应答」');

if (hasFactory) {
  const want = [];
  const raw0 = DX7.parseBank(BANKS[0]);
  for (let i = 0; i < 32; i++) want.push(MIDI.voiceNameAt(raw0, i));
  check(JSON.stringify(fm1.voiceNames(0)) === JSON.stringify(want),
    '设备解出的 32 个音色名与源数据完全一致',
    (fm1.voiceNames(0) || []).slice(0, 3).join(','));
  check(bytesEq(fm1.banks[0], raw0), '设备存下的 4096 字节与源数据逐字节相同');
  check(fm1.voiceNames(0)[0] === 'PIANO 1' && fm1.voiceNames(0)[31] === 'SYN PAD 8',
    '往返后首尾音色名都对');
}

/* 目标 bank：真实设备写到哪，上游文档没记录。这里显式表达我们的假设。 */
fm1.selectedBank = 2;
MIDI.sendBank(fm1, DX7.parseBank(good));
check(fm1.banks[2] !== null && fm1.voiceNames(2) !== null, '设备按「当前选中的 bank」落盘（假设）');
check(fm1.banks[0] !== null, '之前写过的 bank 不受影响');

section('④ 设备模拟的失败分支');
const f2 = new MIDI.FakeFm1();
f2.failNext = true;
let threw = null;
try { MIDI.sendBank(f2, DX7.parseBank(good)); } catch (e) { threw = e; }
check(!!threw, '端口抛错时，sendBank 会把异常传出去', threw ? threw.message : '');
f2.state = 'disconnected';
threw = null;
try { MIDI.sendBank(f2, DX7.parseBank(good)); } catch (e) { threw = e; }
check(!!threw, '端口未连接时发送会失败');

/* 没有端口 */
threw = null;
try { MIDI.sendBank(null, DX7.parseBank(good)); } catch (e) { threw = e; }
check(!!threw && /输出端口/.test(threw.message), '没有选端口时给出明确错误',
  threw ? threw.message : '');

/* bank 数据长度不对 */
threw = null;
try { MIDI.sendBank(new MIDI.FakeFm1(), new Uint8Array(100)); } catch (e) { threw = e; }
check(!!threw && /4096/.test(threw.message), 'bank 数据长度不对时给出明确错误',
  threw ? threw.message : '');

/* ==========================================================================
   ⑤ 端口识别
   ========================================================================== */
section('⑤ 端口识别');

check(MIDI.looksLikeFm1({ name: 'FM-1' }), '认得 "FM-1"');
check(MIDI.looksLikeFm1({ name: 'M-VAVE FM-1 MIDI OUT' }), '认得长名字里的 FM-1');
check(MIDI.looksLikeFm1({ name: 'MVAVE' }), '认得 "MVAVE"');
check(MIDI.looksLikeFm1({ name: 'USB MIDI', manufacturer: 'M-VAVE' }), '靠厂商名也能认出来');
check(!MIDI.looksLikeFm1({ name: 'Microsoft GS Wavetable Synth' }),
  '不会把系统波表合成器误认成 FM-1');
check(!MIDI.looksLikeFm1({ name: 'loopMIDI Port' }), '不会把 loopMIDI 误认成 FM-1');

const pA = new MIDI.FakeFm1({ id: 'a' });
const pB = new MIDI.FakeFm1({ id: 'b', name: 'Microsoft GS Wavetable Synth', manufacturer: 'Microsoft' });
check(MIDI.pickOutput([pB, pA]) === pA, '多个端口时优先挑名字像 FM-1 的那个');
check(MIDI.pickOutput([pB]) === pB, '只有一个端口时就用它');
const pC = new MIDI.FakeFm1({ id: 'c', name: 'Port C', manufacturer: 'X' });
check(MIDI.pickOutput([pB, pC]) === null, '多个端口都不像 FM-1 时不猜，交给人选');
check(MIDI.pickOutput([]) === null, '没有端口时返回 null');
check(MIDI.portLabel(pA) === 'M-VAVE FM-1 · M-VAVE', '端口标签带上厂商名', MIDI.portLabel(pA));

section('⑥ 环境检测、权限与错误文案');

/* Node 22 自带一个只读的 navigator（没有 requestMIDIAccess）。
   直接赋值会抛 TypeError，要改描述符 —— 改完记得还原。 */
const savedNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const setNav = (v) => Object.defineProperty(globalThis, 'navigator',
  { value: v, configurable: true, writable: true });
const restoreNav = () => {
  if (savedNavDesc) Object.defineProperty(globalThis, 'navigator', savedNavDesc);
  else delete globalThis.navigator;
};

setNav({});
check(MIDI.isSupported() === false, '有 navigator 但没有 requestMIDIAccess → 判定为不支持');
check(/浏览器/.test(MIDI.unsupportedReason()), '不支持的原因指向浏览器一侧',
  MIDI.unsupportedReason());

setNav({ requestMIDIAccess: () => Promise.resolve({ sysexEnabled: true, outputs: new Map() }) });
check(MIDI.isSupported() === true, '有 requestMIDIAccess → 判定为支持');

const access = MIDI.fakeAccess([pA]);
check(MIDI.listOutputs(access).length === 1, 'fakeAccess 能列出端口');
check(MIDI.listOutputs(null).length === 0, '没有 access 时列出 0 个端口');

check(/安全上下文|https/.test(MIDI.describeError({ name: 'SecurityError', message: 'x' })),
  'SecurityError 被翻译成「要用 https 或本机地址」');
check(/不支持/.test(MIDI.describeError({ name: 'NotSupportedError' })),
  'NotSupportedError 被翻译成人话');

/* 最能坑人的一条：用户点了允许 MIDI，但拒绝了 SysEx 那一层。
   这时 API 照样 resolve，发送却会被静默丢弃 —— 表现为「点了没反应」。
   必须在这里就报出来。 */
setNav({ requestMIDIAccess: () => Promise.resolve({ sysexEnabled: false, outputs: new Map() }) });
let sysexErr = null;
await MIDI.requestAccess().then(() => {}, (e) => { sysexErr = e; });
check(!!sysexErr && /SysEx/.test(sysexErr.message),
  'sysExEnabled=false 时报错，而不是静默放行', sysexErr ? sysexErr.message : '竟然放行了');

setNav({ requestMIDIAccess: () => Promise.reject(
  Object.assign(new Error('permission denied'), { name: 'SecurityError' })) });
let accErr = null;
await MIDI.requestAccess().then(() => {}, (e) => { accErr = e; });
check(!!accErr && /https|安全上下文/.test(accErr.message),
  '权限被拒时给出可操作的说明', accErr ? accErr.message : '没有报错');

restoreNav();
check(MIDI.isSupported() === false, '还原后 Node 侧的判定回到「不支持」');

/* ------------------------------------------------------------------ 结论 */
console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log(`结论：全部通过（${pass} 项断言）。`);
} else {
  console.log(`结论：${fail} 项失败，${pass} 项通过。`);
  process.exitCode = 1;
}
