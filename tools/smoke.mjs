// 把 index.html 里那份真实的内联脚本，连同 engine/*.js，一起塞进一个最小 DOM 桩里
// 跑起来 —— 然后真的去点它、搜它、选它、播它。
//
// 跑两个场景：
//   A  本地已经跑过 tools/build_assets.py，data/factory.js 在（128 个出厂音色）
//   B  全新 clone，只有随仓库分发的 data/starter.js（32 个原创音色）
//
// 场景 B 才是"点开就能用"的判据：没有任何构建步骤、没有任何本地数据的情况下，
// 双击 index.html 必须立刻是一个能搜索、能试听、能导出的可用工具。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INLINE = (() => {
  const m = HTML.match(/<script>\n([\s\S]*?)<\/script>/);
  if (!m) throw new Error('没有找到内联脚本');
  return m[1];
})();

let fail = 0;
const check = (cond, msg, extra) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ← ' + extra : ''}`);
  if (!cond) fail++;
};
const skip = (msg) => console.log(`  SKIP  ${msg}`);

/* 引擎走 UMD：在 Node 里 module 未定义 → 挂到 globalThis。只需挂一次。
   顺序要紧：midi.js 依赖 DX7，intent.js 依赖 DX7 与 FM_ENGINE，
   params.js 是技法面板（第 5 层）的参数表。 */
for (const f of ['engine/dx7.js', 'engine/fm.js', 'engine/midi.js', 'engine/intent.js',
  'engine/llm.js', 'engine/params.js']) {
  new Function(readFileSync(path.join(ROOT, f), 'utf8'))();
}

/* 每个场景的意外联网记录都收到这里，最后一次性断言。 */
const netCallsAll = [];

/* ------------------------------------------------------------ 单场景执行 */
function runScenario({ withFactory, midi, fetchImpl }) {
  /* --- DOM 桩 --- */
  const byId = new Map();
  const allEls = [];

  function makeEl(tag) {
    const el = {
      tagName: tag, id: '', className: '', _html: '', textContent: '', value: '',
      checked: true, disabled: false, files: [], children: [], dataset: {}, style: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      },
      appendChild(c) { this.children.push(c); return c; },
      scrollIntoView() {}, click() {}, focus() {},
    };
    // 真实 DOM 里 innerHTML 一赋值，子节点就没了 —— 桩必须照做，
    // 否则每次重渲染都会往 children 里越堆越多，计数全错。
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._html; },
      set(v) { el._html = v; el.children.length = 0; },
    });
    allEls.push(el);
    return el;
  }
  const $ = (id) => {
    if (!byId.has(id)) { const e = makeEl('div'); e.id = id; byId.set(id, e); }
    return byId.get(id);
  };

  const document = {
    getElementById: $,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: (sel) => {
      const cls = sel.replace(/^\./, '');
      return allEls.filter(e => String(e.className || '').split(/\s+/).includes(cls));
    },
  };

  /* --- Web Audio 桩 --- */
  const played = [];
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.sampleRate = 44100; this.destination = { name: 'out' }; }
    createBuffer(ch, len, sr) {
      return { numberOfChannels: ch, length: len, sampleRate: sr, _d: new Float32Array(len),
        copyToChannel(a) { this._d.set(a); } };
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() { played.push(this.buffer); } };
    }
    resume() {}
  }

  const alerts = [];
  // 引擎挂在 globalThis 上，这里一并挂到桩 window 上，保证页面两条路径都能取到。
  const window = { AudioContext: FakeAudioContext, DX7: globalThis.DX7, FM_ENGINE: globalThis.FM_ENGINE,
    FM1_LLM: globalThis.FM1_LLM, DX7_PARAMS: globalThis.DX7_PARAMS };
  const sandbox = {
    window, document,
    atob: globalThis.atob, Blob: globalThis.Blob,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    FileReader: class { readAsArrayBuffer() {} },
    alert: (m) => { alerts.push(m); },
    console,
  };

  /* 守门：默认的 fetch 一被调用就记下来并抛错。这样任何一个本来不该联网的
     的场景如果真的去联网了，会被末尾那条断言当场抓住 —— 而不是悄悄退回
     本地词典，把问题藏起来（那正是这个项目最容易犯的错）。 */
  const netCalls = [];
  netCallsAll.push(netCalls);
  sandbox.fetch = fetchImpl || ((url) => {
    netCalls.push(url);
    throw new Error('这个场景不该发网络请求');
  });

  /* 只有场景 C 注入 navigator。不注入时，页面里的 navigator 会落到 Node 全局的
     那一个（存在、但没有 requestMIDIAccess）—— 正好用来测"浏览器不支持"的降级。 */
  if (midi && midi.navigator) sandbox.navigator = midi.navigator;

  /* --- 数据：starter 永远在；factory 按场景 --- */
  new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(window);
  if (withFactory) {
    new Function('window', readFileSync(path.join(ROOT, 'data', 'factory.js'), 'utf8'))(window);
  }

  /* --- 执行页面内联脚本 --- */
  new Function(...Object.keys(sandbox), INLINE)(...Object.values(sandbox));

  return { $, played, alerts, window, netCalls };
}

const cards = (el) => el.children.length;
const matchCount = (text) => Number((text.match(/匹配 (\d+)/) || [])[1]);

/* ==========================================================================
   场景 A：本地已建好出厂音色数据
   ========================================================================== */
const hasFactory = existsSync(path.join(ROOT, 'data', 'factory.js'));
if (hasFactory) {
  console.log('\n═══ 场景 A：data/factory.js 存在（出厂音色可用）═══');
  const A = runScenario({ withFactory: true });
  const $ = A.$;

  console.log('\n① 页面初始化');
  const auditLog = $('log').textContent;
  check(!/FAIL/.test(auditLog), '页面自检无 FAIL',
    auditLog.split('\n').filter(l => /FAIL/.test(l)).join(' | '));
  check(/结论：全部通过/.test(auditLog), '自检结论为"全部通过"');
  check(auditLog.includes('④'), '自检含第 ④ 节（试听引擎跑一遍）');
  check(auditLog.includes('FM-1 出厂音色'), '自检识别出数据来源是出厂音色');
  check($('factory-row').innerHTML.includes('data-bank="all"'), '出厂音色按钮已生成');
  check($('note').innerHTML.split('<option').length - 1 === 61, '音符下拉有 61 个选项（C1–C6）',
    String($('note').innerHTML.split('<option').length - 1));
  const provRows = ($('prov').innerHTML.match(/<tr>/g) || []).length - 1;
  check(provRows === 128, '来源台账 128 行', String(provRows));

  console.log('\n② 载入出厂音色 + 检索');
  // 随附音色库不会被顶掉：出厂音色是"追加"进来的，所以是 32 + 128 = 160。
  // 保留而不是替换，是因为它带一条出厂音色没有的东西 —— 每个音色的设计说明。
  $('factory-row').onclick({ target: { dataset: { bank: 'all' } } });
  check($('count').textContent.includes('160'), '检索计数显示 160 个（随附 32 + 出厂 128）', $('count').textContent);
  check(cards($('voices')) === 160, '网格渲染出 160 张音色卡', String(cards($('voices'))));
  check(($('bank-chips').innerHTML.match(/tag b/g) || []).length === 5,
    '音色库标签显示 5 个（随附 1 + 出厂 4）');
  check($('f-bank').innerHTML.includes('出厂 Bank D'), '来源筛选已列出 4 个出厂 bank');
  check($('f-algo').innerHTML.includes('算法 32'), '算法筛选已列出实际出现的算法');

  $('q').value = 'piano'; $('q').oninput();
  const nPiano = matchCount($('count').textContent);
  check(nPiano > 0 && nPiano < 160, '搜索 "piano" 缩小了结果集', `匹配 ${nPiano}`);
  check(cards($('voices')) === nPiano, '网格卡片数跟着搜索结果走');

  $('q').value = 'ROM1B'; $('q').oninput();
  check(matchCount($('count').textContent) > 0, '可以按 Yamaha 卡带编号搜索');

  $('q').value = 'zzzz-not-a-patch'; $('q').oninput();
  check($('count').textContent.includes('没有匹配'), '无结果时提示正确', $('count').textContent);
  check(cards($('voices')) === 0, '无结果时网格为空');

  $('q').value = ''; $('q').oninput();
  $('f-algo').value = '4'; $('f-algo').onchange();
  const nAlgo5 = matchCount($('count').textContent);
  check(nAlgo5 > 0 && nAlgo5 < 160, '按算法筛选生效（面板算法 5）', `匹配 ${nAlgo5}`);
  check(cards($('voices')) === nAlgo5, '网格卡片数跟着算法筛选走');
  $('f-algo').value = '-1'; $('f-algo').onchange();

  console.log('\n③ 选中音色 → 详情 + 算法图 + 播放');
  $('q').value = 'PIANO 1'; $('q').oninput();
  const card = $('voices').children[0];
  check(!!card, '搜索结果里至少有卡片');
  card.onclick();
  const algo = $('algo').innerHTML;
  check(algo.includes('<svg'), '算法结构图渲染出 SVG');
  check(algo.includes('算法 5'), 'PIANO 1 显示为算法 5（面板编号）');
  check((algo.match(/<rect /g) || []).length === 6, '算法图里 6 个算子框');
  check((algo.match(/<line /g) || []).length === 3, '算法 5 有 3 条调制连线（6→5、4→3、2→1）');
  check($('detail-title').textContent.includes('PIANO 1'), '详情标题正确');
  check($('detail-ops').innerHTML.includes('载波'), '参数表标出了载波角色');
  check($('detail-global').innerHTML.includes('ROM1A'), '详情带出了 Yamaha 卡带溯源');
  check(A.played.length === 1, '点选即触发一次播放（试听生效）', String(A.played.length));
  check(A.played[0] && A.played[0].length === Math.round(1.6 * 44100),
    '播放缓冲区长度 = 时长 × 采样率', A.played[0] ? String(A.played[0].length) : 'null');
  let finite = true;
  if (A.played[0]) for (const x of A.played[0]._d) if (!Number.isFinite(x)) { finite = false; break; }
  check(finite, '播放缓冲区里没有非法采样值');

  console.log('\n④ 换音符重播 / 改名往返');
  $('note').value = '72'; $('note').onchange();
  check(A.played.length === 2, '换音符后自动重播', String(A.played.length));
  $('rename').value = 'TESTNAME';
  $('btn-rename').onclick();
  check($('detail-title').textContent.includes('TESTNAME'), '改名后标题更新');
  $('q').value = 'TESTNAME'; $('q').oninput();
  check(matchCount($('count').textContent) === 1, '改名后能按新名字搜到');
  $('q').value = ''; $('q').oninput();

  console.log('\n⑤ 台账搜索');
  $('prov-q').value = 'zzz'; $('prov-q').oninput();
  check(($('prov').innerHTML.match(/<tr>/g) || []).length === 1, '台账搜索无结果时只剩表头');
  $('prov-q').value = 'ROM1B'; $('prov-q').oninput();
  check(($('prov').innerHTML.match(/<tr>/g) || []).length > 1, '台账可以按卡带编号搜索');

  console.log('\n⑥ 没有 Web MIDI 时，写入区必须给出路，不能装死');
  check(!/btn-midi-connect/.test($('midi-body').innerHTML), '不出现连接按钮');
  check(/Web MIDI/.test($('midi-body').innerHTML), '说明原因是缺少 Web MIDI');
  check(/Chrome|serve/.test($('midi-body').innerHTML), '给出出路：换浏览器，或起本机服务器');
  check(/检索、试听、导出都照常/.test($('midi-body').innerHTML),
    '说明没有设备不影响页面其余部分');

  check(A.alerts.length === 0, '场景 A 全程没有触发 alert', A.alerts.join(' | '));
} else {
  skip('data/factory.js 不存在，跳过场景 A（在本地跑 tools/build_assets.py 后可测）');
}

/* ==========================================================================
   场景 B：全新 clone —— 只有随仓库分发的数据
   ========================================================================== */
console.log('\n═══ 场景 B：全新 clone，只有 data/starter.js ═══');
/* 场景 B 要试「上游能不能拉到」。给它一个可切换的假 fetch ——
   而不是去改 globalThis.fetch：页面现在从注入的参数里取 fetch，
   改全局已经不起作用了。顺带也不再污染全局。 */
let Bmode = 'offline';
let Bbuf = null;
const Bseen = [];
const Bfetch = (url) => {
  Bseen.push({ url: url, mode: Bmode });
  if (Bmode === 'offline') return Promise.reject(new Error('模拟断网'));
  return Promise.resolve({
    ok: true, status: 200,
    arrayBuffer: async () => Bbuf.buffer.slice(Bbuf.byteOffset, Bbuf.byteOffset + Bbuf.byteLength),
  });
};
const B = runScenario({ withFactory: false, fetchImpl: Bfetch });
const $b = B.$;

console.log('\n① 打开即有东西可用（这一步不需要网络、不需要构建）');
check(($b('count').textContent.match(/\d+/) || [''])[0] === '32',
  '页面打开即有 32 个音色', $b('count').textContent);
check(cards($b('voices')) === 32, '网格渲染出 32 张音色卡', String(cards($b('voices'))));
check($b('bank-chips').innerHTML.includes('随附音色'), '音色库标签显示"随附音色"');
check($b('f-bank').innerHTML.includes('随附音色'), '来源筛选列出了随附音色库');
check($b('empty').style.display === 'none', '不再显示"音色库为空"');

console.log('\n② 出厂音色的入口还在，只是换了一种取法');
check($b('factory-row').innerHTML.includes('btn-upstream'), '提供了"取出 FM-1 出厂音色"按钮');
check(!/data-bank=/.test($b('factory-row').innerHTML), '没有本地数据时不显示 bank 按钮');
check(/不分发/.test($b('factory-row').innerHTML), '按钮旁说明了数据不经过本仓库分发');

console.log('\n③ 随附音色可以正常检索、播放、读出设计说明');
$b('q').value = 'bell'; $b('q').oninput();
const nBell = matchCount($b('count').textContent);
check(nBell === 3, '搜索 "bell" 命中 3 个（BELL FM / BELL LONG / TUB BELL）', `匹配 ${nBell}`);
check(cards($b('voices')) === 3, '网格卡片数跟着搜索结果走');

$b('q').value = 'INIT SINE'; $b('q').oninput();
const bcard = $b('voices').children[0];
check(!!bcard, '找到 INIT SINE');
bcard.onclick();
check(B.played.length === 1, '点选即播放', String(B.played.length));
check($b('detail-title').textContent.includes('INIT SINE'), '详情标题正确');
const bdetail = $b('detail-global').innerHTML;
check(bdetail.includes('设计说明'), '详情面板给出该音色的设计说明');
check(/纯正弦/.test(bdetail), '设计说明内容是这条音色自己的（提到了纯正弦）');
$b('q').value = ''; $b('q').oninput();

console.log('\n④ 自检与台账在缺数据时不能装作正常');
const baudit = $b('log').textContent;
check(!/FAIL/.test(baudit), '自检无 FAIL',
  baudit.split('\n').filter(l => /FAIL/.test(l)).join(' | '));
check(/结论：全部通过/.test(baudit), '自检结论为"全部通过"');
check(baudit.includes('随附原创音色库'), '自检如实说明数据来源是随附音色库');
check(baudit.includes('32'), '自检覆盖了 32 个音色而不是 128 个');
check(/还没有出厂音色的来源台账/.test($b('prov').innerHTML), '台账给出正确的空态说明并指出出路');

console.log('\n⑤ 取上游数据失败时必须给出出路（模拟断网）');
Bmode = 'offline';
await $b('factory-row').onclick({
  target: { id: 'btn-upstream', textContent: '取出 FM-1 出厂音色（128 个）', disabled: false },
});
await new Promise(r => setTimeout(r, 20));
check(B.alerts.length === 1, '取不到数据时弹出提示', B.alerts[0] ? B.alerts[0].slice(0, 34) + '…' : '无');
check(!!B.alerts[0] && B.alerts[0].includes('fetch_ref.sh'), '提示里给出了本地重建的办法');
check(!!B.alerts[0] && B.alerts[0].includes('随附的 32 个原创音色不受影响'),
  '提示里说明了随附音色仍然可用');

console.log('\n⑥ 上游可用时能直接把出厂音色拉进来（用真实字节模拟）');
const refBin = path.join(ROOT, 'ref', 'packed128.bin');
if (existsSync(refBin)) {
  Bbuf = readFileSync(refBin);
  Bmode = 'online';
  await $b('factory-row').onclick({
    target: { id: 'btn-upstream', textContent: '取出 FM-1 出厂音色（128 个）', disabled: false },
  });
  await new Promise(r => setTimeout(r, 20));
  check($b('count').textContent.includes('160'),
    '载入后共 32 + 128 = 160 个音色', $b('count').textContent);
  check($b('f-bank').innerHTML.includes('出厂 Bank D'), '4 个出厂 bank 都进了筛选');
  $b('q').value = 'PIANO 1'; $b('q').oninput();
  check(matchCount($b('count').textContent) === 1, '拉进来的音色可以检索', '匹配 1');
} else {
  skip('ref/packed128.bin 不存在（它不随仓库分发），跳过上游成功路径');
}

check(B.alerts.length === 1, '除了那一次断网提示，没有别的弹窗', B.alerts.join(' | '));
/* 全新 clone 上没有 ref/packed128.bin，成功那条路会被跳过，
   所以这里按「数据在不在」给出应有的次数，而不是写死 2。 */
const upstreamWant = existsSync(path.join(ROOT, 'ref', 'packed128.bin')) ? 2 : 1;
check(Bseen.length === upstreamWant,
  `场景 B 按设计只发了 ${upstreamWant} 次上游请求`,
  Bseen.map(x => x.mode).join(' → '));
check(Bseen.every(x => /^https:\/\/raw\.githubusercontent\.com\//.test(x.url)),
  '这两次都打在随仓库约定的上游链接上', Bseen[0] && Bseen[0].url);

/* ==========================================================================
   场景 C：第 1 层 —— 连接设备并写入
   --------------------------------------------------------------------------
   这是没有真机时能做到的最强验证：把一个 mock 端口塞进 navigator，
   让页面走完真实的连接/确认/写入路径，然后把**页面实际发出去的字节**
   截下来，交给"设备侧"解开。这样验的不是"我以为我发了什么"，
   而是"它真的发了什么"。
   ========================================================================== */
console.log('\n═══ 场景 C：连接设备 → 写入（mock 端口，截真字节）═══');

const MIDI = globalThis.FM1MIDI;
const DX7 = globalThis.DX7;

/* 注意：engine/midi.js 是在全局作用域里执行的，它内部引用的 navigator
   绑定到 Node 全局那一个，而不是 DOM 桩里的那个。所以 mock 必须挂到
   globalThis 上才生效 —— 只塞进桩里会静默走到「浏览器不支持」分支，
   而那个分支看起来也很正常，很容易误判成测试写错了。 */
const savedNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const setNav = (v) => Object.defineProperty(globalThis, 'navigator',
  { value: v, configurable: true, writable: true });
const restoreNav = () => {
  if (savedNavDesc) Object.defineProperty(globalThis, 'navigator', savedNavDesc);
  else delete globalThis.navigator;
};

const port = new MIDI.FakeFm1();
const access = MIDI.fakeAccess([port]);
setNav({ requestMIDIAccess: () => Promise.resolve(access) });

const C = runScenario({
  withFactory: false,
  midi: { navigator: { requestMIDIAccess: () => Promise.resolve(access) } },
});
const $c = C.$;
const body = () => $c('midi-body').innerHTML;
const writeEnabled = () => !/id="btn-midi-write" disabled/.test(body());
const tick = () => new Promise(r => setTimeout(r, 20));

console.log('\n① 未连接时');
check(/btn-midi-connect/.test(body()), '提供连接按钮');
check(!/btn-midi-write/.test(body()), '还没有写入按钮');
check(/SysEx/.test(body()), '说明了 SysEx 那一次授权必须点允许');

console.log('\n② 连接之后');
$c('btn-midi-connect').onclick();
await tick();
check(/btn-midi-write/.test(body()), '出现写入按钮');
check(/M-VAVE FM-1/.test(body()), '名字像 FM-1 的端口被自动选中');
check(/覆盖/.test(body()), '写入区给出覆盖警告');
check(/读不出来/.test(body()), '说明设备里的音色读不出来（写入不可逆）');
check(/不能告诉你设备/.test(body()), '说明「发出去了」不等于「写进去了」');
check(!writeEnabled(), '没勾选确认时写入按钮是禁用的');

console.log('\n③ 强制确认');
$c('midi-confirm').checked = true;
$c('midi-confirm').onchange();
check(writeEnabled(), '勾选后写入按钮可用');
check(/将要写入/.test(body()), '列出了将要写入的内容');

console.log('\n④ 写入，并把页面实际发出的字节截下来');
check(port.received.length === 0, '写入前设备什么都没收到');
$c('btn-midi-write').onclick();
check(port.received.length === 1, '设备收到 1 条消息');
const sent = Uint8Array.from(port.received[0]);
check(sent.length === DX7.SYSEX_BYTES, `发出 ${DX7.SYSEX_BYTES} 字节`, String(sent.length));
check(DX7.hex(sent.slice(0, 6)) === 'f0 43 00 09 20 00', '包头是标准 DX7 bank dump',
  DX7.hex(sent.slice(0, 6)));
check(sent[4103] === 0xF7, '包尾是 F7');
check(sent.length === 0 || DX7.checksum(sent.slice(6, 6 + DX7.BANK_BYTES)) === sent[4102],
  '校验和自洽');
/* 日志写在 midi-log 里，不在 midi-body —— 桩的 innerHTML 只是个字符串，
   不会把子元素真正嵌进去，所以这里要按 id 取。 */
const log = () => $c('midi-log').innerHTML;
check(/已发出 4104 字节/.test(log()), '页面报告了发出的字节数', log().slice(0, 70));
check(/不是「设备已经收下」/.test(log()), '页面明确区分「发出」与「写入成功」');

console.log('\n⑤ 发出去的 32 个，就是页面上的那 32 个');
const sw = {};
new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(sw);
const starterBank = DX7.parseBank(DX7.b64ToBytes(sw.FM1_STARTER.banks[0]));
/* sent 是 4104 字节的完整 SysEx，音色名要按 4096 的裸数据算 ——
   直接对 SysEx 取 118 偏移会差 6 个字节，读出来是一串错位的字符。 */
const sentData = DX7.parseBank(sent);
const want = [], got = [];
for (let i = 0; i < DX7.VOICES_PER_BANK; i++) {
  want.push(MIDI.voiceNameAt(starterBank, i));
  got.push(MIDI.voiceNameAt(sentData, i));
}
check(JSON.stringify(got) === JSON.stringify(want),
  '设备解出的 32 个音色名 = 随附音色库的 32 个', got.slice(0, 3).join(' / ') + ' …');
check(got.every(n => n && n.length > 0), '32 个槽都有名字（没有空音色落到设备上）');

console.log('\n⑥ 端口出问题时的表现');
port.failNext = true;
$c('btn-midi-write').onclick();
check(/写入失败/.test(log()), '发送失败时页面报错而不是假装成功', log().slice(0, 70));
check(port.received.length === 1, '失败时设备没有多收到东西');

console.log('\n⑦ 兜底与边界');
check(/btn-midi-export/.test(body()), '提供「先导出为 .syx 存档」');
check(port.received.every(m => m.length === DX7.SYSEX_BYTES),
  '页面从头到尾只发过标准 bank dump，没有别的消息');
check(C.alerts.length === 0, '场景 C 没有弹窗', C.alerts.join(' | '));

/* 检索结果不足 32 个时必须拦住 —— 写不满会把设备里其余的槽变成空音色 */
const access2 = MIDI.fakeAccess([new MIDI.FakeFm1()]);
setNav({ requestMIDIAccess: () => Promise.resolve(access2) });
const C2 = runScenario({
  withFactory: false,
  midi: { navigator: { requestMIDIAccess: () => Promise.resolve(access2) } },
});
const $c2 = C2.$;
$c2('btn-midi-connect').onclick();
await tick();
$c2('q').value = 'bell'; $c2('q').oninput();
$c2('midi-confirm').checked = true; $c2('midi-confirm').onchange();
check(/不够 32 个/.test($c2('midi-body').innerHTML),
  '结果不足 32 个时明确拒绝写入并说明原因');
check(/id="btn-midi-write" disabled/.test($c2('midi-body').innerHTML),
  '结果不足 32 个时写入按钮是禁用的');

restoreNav();
check(MIDI.isSupported() === false, '还原后 Node 侧的判定回到「不支持」');

/* ==========================================================================
   场景 D：第 3 层 —— 说一句人话改音色
   --------------------------------------------------------------------------
   在全新 clone 上跑（只有随仓库分发的数据）。验四件事：
   听得懂 / 听不懂时说清楚 / 改动能留下 / 留下能撤销。
   特意不联网：这一层的解析是本地词典，断网也必须照常可用。
   ========================================================================== */
console.log('\n═══ 场景 D：一句人话 → 参数改动 → 留下（无网络、无真机）═══');
const D = runScenario({ withFactory: false });
const $d = D.$;
const nl = () => $d('nl-body').innerHTML;

console.log('\n① 还没选中音色时');
check(/③ 检索/.test(nl()), '提示先去检索里点一个音色');
check(/锚点/.test(nl()), '解释了"以现有音色为锚点"这件事');
check(!/btn-nl-parse/.test(nl()), '没有锚点时不出现解析按钮');

console.log('\n② 选中一个音色当锚点');
$d('q').value = 'INIT SINE'; $d('q').oninput();
$d('voices').children[0].onclick();
check(/锚点/.test(nl()) && /INIT SINE/.test(nl()), '面板显示出当前锚点');
check(/btn-nl-parse/.test(nl()), '出现解析按钮');
check(!!$d('nl-ex-0').onclick, '给了可以直接点的示例说法');

console.log('\n③ 说一句听得懂的');
$d('nl-ex-0').onclick();                        // 第一条例句是「亮一点」
check(/亮度/.test(nl()) && /↑/.test(nl()), '解析成"亮度 ↑"');
check(/弱/.test(nl()), '「一点」被识别成弱改');
check(/输出电平/.test(nl()), '列出了将要动的参数');
check(/btn-nl-keep/.test(nl()) && /btn-nl-a/.test(nl()), '给出试听和「留下」');

console.log('\n④ 听不懂时必须说清楚，不能装死');
$d('btn-nl-again').onclick();
$d('nl-text').value = '今天天气不错';
$d('btn-nl-parse').onclick();
check(/没听懂/.test(nl()), '明确说没听懂');
check(/没有认出可以调整的词/.test(nl()), '给出了没听懂的原因');
check(/亮一点/.test(nl()), '同时列出能用的说法');

console.log('\n⑤ 说反了也能懂');
$d('btn-nl-again').onclick();
$d('nl-text').value = '不要太亮';
$d('btn-nl-parse').onclick();
check(/亮度/.test(nl()) && /↓/.test(nl()), '「不要太亮」被理解成变暗');

console.log('\n⑥ A/B 试听：原音色和改后的都要能听');
const nPlayed = D.played.length;
$d('btn-nl-sample').onclick();
$d('btn-nl-a').onclick();
check(D.played.length === nPlayed + 2, '两个试听按钮各播一次',
  `${nPlayed} → ${D.played.length}`);
check(D.played[D.played.length - 1].length === Math.round(1.6 * 44100),
  '改后的播放缓冲区长度正常');

console.log('\n⑦ 留下改动：真的写进音色库，而且能撤销');
const beforeOps = $d('detail-ops').innerHTML;
$d('btn-nl-again').onclick();
$d('nl-text').value = '亮一点';
$d('btn-nl-parse').onclick();
const to = (nl().match(/→\s*(\d+)</) || [])[1];
check(!!to, '改动清单里给出了新值', String(to));
$d('btn-nl-keep').onclick();
const afterOps = $d('detail-ops').innerHTML;
check(afterOps !== beforeOps, '留下之后，音色库里的参数真的变了');
check(afterOps.includes('<b>' + to + '</b>'), `详情表里出现了新值 ${to}`);
check(/撤销上一次改动/.test(nl()), '留下之后提供了这一步的撤销');
check($d('count').textContent.includes('32'), '音色总数没变（是改，不是加）',
  $d('count').textContent);
$d('btn-nl-undo').onclick();
check($d('detail-ops').innerHTML === beforeOps, '撤销之后逐字段回到原样');
check(!/撤销上一次改动/.test(nl()), '撤销后不再显示撤销按钮');

check(D.alerts.length === 0, '场景 D 没有弹窗', D.alerts.join(' | '));

/* ==========================================================================
   场景 E：第 3 层换引擎 —— 接大模型（假 fetch，全程不联网）
   --------------------------------------------------------------------------
   要验的是"可替换"这件事真的成立：把中间那层从本地词典换成大模型之后，
   上面那套（解析 → 应用 → 渲染 → 留下 → 撤销）一行都没改，行为照样对。
   顺带把"模型不听话时怎么办"走一遍：答非所问、说做不到、鉴权失败。
   ========================================================================== */
console.log('\n═══ 场景 E：接大模型（假 fetch，全程不联网）═══');

const Eseen = [];
let Ereplies = [];
const EfakeFetch = (url, init) => {
  Eseen.push({ url, init });
  const r = Ereplies.shift();
  if (!r) return Promise.reject(new Error('测试没准备好应答'));
  if (r.throw) return Promise.reject(r.throw);
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300, status: r.status,
    text: () => Promise.resolve(JSON.stringify(r.body)),
  });
};
const Esay = (content) => [{ status: 200, body: { choices: [{ message: { content: content } }] } }];

const E = runScenario({ withFactory: false, fetchImpl: EfakeFetch });
const $e = E.$;
const nlE = () => $e('nl-body').innerHTML;
const setE = () => $e('nl-settings').innerHTML;

console.log('\n① 默认还是本地词典 —— 什么都不动，功能一样完整');
check(/解析方式/.test(setE()), '接入开关就摆在面板上，不用去改代码');
check(/只用本地词典/.test(setE()), '默认写的是「只用本地词典」');

console.log('\n② 选中锚点，把开关切到接大模型');
$e('q').value = 'INIT SINE'; $e('q').oninput();
$e('voices').children[0].onclick();
$e('nl-source').value = 'llm';
$e('nl-source').onchange();
check(/接大模型/.test(setE()), '开关切到「接大模型」');
check(/DeepSeek/i.test(setE()), '默认服务商是 DeepSeek');
check(/API Key/.test(setE()), '给了填 Key 的地方');
check(/localStorage/.test(setE()), '如实说明 Key 存在哪里、会不会上传');
check(/只有大模型能认的说法/.test(nlE()), '示例里多出一排「只有大模型能认的说法」');

console.log('\n③ 一句本地词典绝对认不出来的话，模型答上了');
$e('nl-key').value = 'sk-test-abc1234';
$e('nl-text').value = '像老式电钢那样，但更清脆一点';
Ereplies = Esay('{"ok":true,"axes":{"bright":0.45},'
  + '"reason":"提一点调制深度让它更清脆，整体保持电钢那种干净的底子。","confidence":0.85}');
$e('btn-nl-parse').onclick();
await tick();
check(Eseen.length === 1, '确实发了 1 次请求', String(Eseen.length));
check(Eseen[0].url === 'https://api.deepseek.com/v1/chat/completions',
  '发到了正确的地址', Eseen[0].url);
check(Eseen[0].init.headers['Authorization'] === 'Bearer sk-test-abc1234', '带上了 Key');
const Ebody = JSON.parse(Eseen[0].init.body);
check(Ebody.messages[1].content.includes('像老式电钢那样'), '用户那句话原样进了提示词');
check(Ebody.messages[1].content.includes('可调的轴'),
  '并且告诉了模型：这台音色哪些轴真的可调');
check(/大模型/.test(nlE()), '结果里标出了这次是大模型答的');
check(/电钢/.test(nlE()), '把模型的说明原样显示出来');
check(/亮度/.test(nlE()) && /↑/.test(nlE()), '轴显示成「亮度 ↑」');
check(/输出电平/.test(nlE()), '改动清单照样列得出具体参数');
check(/btn-nl-keep/.test(nlE()), '「留下」按钮照样在 —— 上层一行都没改');
check(!nlE().includes('sk-test'), '**渲染出来的内容里不含 Key 全文**');
check(/末尾 1234/.test(setE()), '设置区只显示 Key 的末尾四位');

console.log('\n④ 模型说做不到时要尊重它，不能拿本地词典硬凑');
$e('btn-nl-again').onclick();
$e('nl-text').value = '把音高升高一个八度';
Ereplies = Esay('{"ok":false,"axes":{},"reason":"这五个轴里没有音高，'
  + '改音高要动移调参数，不在可调范围内。","confidence":0.9}');
$e('btn-nl-parse').onclick();
await tick();
check(/模型说做不到/.test(nlE()), '明确写成「模型说做不到」，不是含糊的「没听懂」');
check(/音高/.test(nlE()), '把模型给的理由显示出来');
check(!/btn-nl-keep/.test(nlE()), '不给出「留下」按钮 —— 本来就没有改动可留');

console.log('\n⑤ 模型答非所问时，退回本地词典兜住');
$e('btn-nl-again').onclick();
$e('nl-text').value = '亮一点';
Ereplies = Esay('这个音色已经很亮啦！');
$e('btn-nl-parse').onclick();
await tick();
check(/本地词典/.test(nlE()), '退回本地词典，来源如实标出来');
check(/没用上模型/.test(nlE()), '说明为什么没用上模型');
check(/亮度/.test(nlE()) && /↑/.test(nlE()), '本地词典把这句话答对了');
check(/btn-nl-keep/.test(nlE()), '照样能留下改动');

console.log('\n⑥ 鉴权失败时，退回本地并说清是 Key 的问题');
$e('btn-nl-again').onclick();
$e('nl-text').value = '亮一点';
Ereplies = [{ status: 401, body: { error: { message: 'Invalid API key' } } }];
$e('btn-nl-parse').onclick();
await tick();
check(/API Key/.test(nlE()), '说清了是 Key 不对');
check(/亮度/.test(nlE()), '同时本地词典仍然把这句话答上来了');
check(!nlE().includes('sk-test'), '出错信息里也不含 Key 全文');

console.log('\n⑦ 「测试连接」按钮：通没通都要说清楚');
$e('btn-nl-again').onclick();
$e('nl-key').value = 'sk-test-abc1234';
Ereplies = Esay('{"ok":true,"axes":{"bright":0.3}}');
$e('btn-nl-test').onclick();
await tick();
check(/通了/.test(setE()), '连接成功时明确说「通了」');
check(/亮度/.test(setE()), '并把模型针对「亮一点」回的内容显示出来');
$e('btn-nl-clearkey').onclick();
check(/未填/.test(setE()), '清除按钮把记住的 Key 抹掉了');

console.log('\n⑧ 全程没有意外联网');
const totalNet = netCallsAll.reduce((n, a) => n + a.length, 0);
check(totalNet === 0, `五个场景合计发出的"意外"网络请求为 0（实际 ${totalNet}）`,
  netCallsAll.reduce((a, b) => a.concat(b), []).join(' | '));
check(Eseen.length === 5, '场景 E 自己发的 5 次请求全打在假 fetch 上', String(Eseen.length));
check(E.alerts.length === 0, '场景 E 没有弹窗', E.alerts.join(' | '));

/* ==========================================================================
   场景 F：第 5 层 —— 技法面板（实时单参数写入）
   --------------------------------------------------------------------------
   engine/params.js 的现场验证：选一个音色 → 试算闷音宏 → 勾确认 → 发送，
   把页面实际发出的字节截下来，与测试侧独立算出的预期逐条对齐。
   这条路径真机未验证 —— 所以断言的重心是「发的字节正是参数表说该发的」，
   而不是「设备会怎么响」。
   ========================================================================== */
console.log('\n═══ 场景 F：技法面板 → 实时单参数消息（mock 端口，截真字节）═══');

const FXP = globalThis.DX7_PARAMS;

const portF = new MIDI.FakeFm1();
const accessF = MIDI.fakeAccess([portF]);
setNav({ requestMIDIAccess: () => Promise.resolve(accessF) });

const F = runScenario({
  withFactory: false,
  midi: { navigator: { requestMIDIAccess: () => Promise.resolve(accessF) } },
});
const $f = F.$;
const tech = () => $f('tech-body').innerHTML;
await tick();

console.log('\n① 面板常驻，未选音色时说清楚');
check(tech().length > 0, '启动后技法面板已渲染');
check(/真机未验证/.test(tech()), '面板带着「真机未验证」标注 —— 不能让未验证路径看起来是验过的');
check(/未连接设备/.test(tech()) || /⑥ 区连接/.test(tech()), '说明了发送要先进 ⑥ 区连接');
check(/选一个音色/.test(tech()), '未选音色时给出指引而不是空白');
check(!/btn-tech-send/.test(tech().match(/btn-tech-send[^>]*/)?.[0] || '') ||
  /disabled/.test((tech().match(/<button id="btn-tech-send"[^>]*>/) || [''])[0]),
  '没有音色时发送按钮不可用');

console.log('\n② 连接设备，选中音色，面板自动试算');
$f('btn-midi-connect').onclick();
await tick();
$f('q').value = 'INIT SINE'; $f('q').oninput();
$f('voices').children[0].onclick();
await tick();
check(/pp\/qq/.test(tech()), '宏试算表列出了参数的 pp/qq 编址');
check(/条实时消息/.test(tech()), '给出消息条数');
check(/试算不改音色库/.test(tech()), '说明试算不动本地音色');
check(portF.received.length === 0, '试算阶段设备什么都没收到');

const sel = F.S || null;   // 页面内部状态不直接可取时，走 DOM 断言
console.log('\n③ 独立复算预期宏，与页面显示对齐');
/* 测试侧不读页面状态，自己算一遍：INIT SINE 的 packed 字节从随附音色库取。 */
const swF = {};
new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(swF);
const starterPacked = DX7.parseBank(DX7.b64ToBytes(swF.FM1_STARTER.banks[0]));
const expected = FXP.palmMute(starterPacked.slice(0, 128)).changes;
check(expected.length > 0, '测试侧独立算出的闷音宏非空（INIT SINE 有可改项）',
  String(expected.length));
/* 页面上「发送 N 条」的 N 必须与测试侧独立算出的一致 ——
   两边各算各的，相等才说明页面真的在用 params.js 算这个音色。 */
const nOnPage = Number((tech().match(/发送 (\d+) 条实时消息/) || [])[1]);
check(nOnPage === expected.length,
  `页面显示的条数 ${nOnPage} = 测试侧独立算出的 ${expected.length}`);

console.log('\n④ 确认闸门');
check(/disabled/.test((tech().match(/<button id="btn-tech-send"[^>]*>/) || [''])[0]),
  '没勾确认时发送按钮禁用');
$f('tech-confirm').checked = true; $f('tech-confirm').onchange();
await tick();
check(!/disabled/.test((tech().match(/<button id="btn-tech-send"[^>]*>/) || [''])[0]),
  '勾选确认后发送按钮可用');

console.log('\n⑤ 发送，截字节，与参数表逐条对齐');
$f('btn-tech-send').onclick();
await tick();
check(portF.received.length === expected.length,
  `设备收到 ${expected.length} 条消息`, String(portF.received.length));
const expectedBytes = FXP.changesToSysex(expected);
let allMatch = true, firstDiff = '';
for (let i = 0; i < expectedBytes.length; i++) {
  const got = Uint8Array.from(portF.received[i]);
  if (DX7.hex(got) !== DX7.hex(expectedBytes[i])) { allMatch = false; firstDiff = `#${i}: ` +
    `页面 ${DX7.hex(got)} vs 预期 ${DX7.hex(expectedBytes[i])}`; break; }
}
check(allMatch, '每一条消息的 7 个字节都 = params.js 按该音色算出的预期', firstDiff);
check(portF.received.every(m => m.length === 7), '全部是 7 字节短消息（不是 bank dump）');
check(portF.received.every(m => m[0] === 0xF0 && m[m.length - 1] === 0xF7),
  '每条都以 F0 开头、F7 结尾');
check(portF.received.every(m => (m[1] & 0xF0) === 0x40), '每条都带 Yamaha 厂商 ID（43）');
const logF = $f('tech-log').innerHTML;
check(/已发出 \d+ 条实时消息/.test(logF), '页面报告了发出的条数', logF.slice(0, 70));
check(/真机未验证/.test(logF), '发送成功也标着「真机未验证」—— 已发出不等于已执行');

console.log('\n⑥ 单参数发送器：越界报错，合法值逐字节对');
const idxAlg = 134;   // 算法号：pp=01 qq=08（真机锚点所在参数）
$f('tech-param').value = String(idxAlg);
$f('tech-param').onchange();
$f('tech-value').value = '200';
$f('btn-tech-one').onclick();
await tick();
check(/合法区间/.test($f('tech-log').innerHTML) || /区间/.test($f('tech-log').innerHTML),
  '越界值被拒绝并说明合法区间', $f('tech-log').innerHTML.slice(0, 70));
check(portF.received.length === expected.length, '越界时设备没有多收到任何消息');
$f('tech-value').value = '31';
$f('btn-tech-one').onclick();
await tick();
const one = Uint8Array.from(portF.received[portF.received.length - 1]);
check(one.length === 7 && DX7.hex(one) === DX7.hex(FXP.paramChange(idxAlg, 31)),
  '单参数消息 = paramChange(134, 31) 的预期字节', DX7.hex(one));
check(DX7.hex(one.slice(3, 6)) === '01 08 1f',
  '编址就是真机锚点那组（pp 01 / qq 08 / 值 1F）', DX7.hex(one.slice(3, 6)));

console.log('\n⑦ 兜底');
check(F.alerts.length === 0, '场景 F 没有弹窗', F.alerts.join(' | '));

console.log(`\n${'─'.repeat(56)}`);
console.log(fail === 0 ? '结论：六个场景端到端执行全部通过。' : `结论：${fail} 项失败。`);
process.exit(fail === 0 ? 0 : 1);
