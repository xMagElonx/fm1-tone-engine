/* ============================================================================
   FM-1 音色台 · MIDI 传输层
   ----------------------------------------------------------------------------
   一、把 DX7.buildBank() 产出的 4104 字节 SysEx 通过 Web MIDI 发出去。
   二、设备侧的最小模拟（FakeFm1）—— 它是「FM-1 怎么收」的可执行规范，
       让「发出去的字节能不能被解回来」这件事在没有真机时也能验证。

   ── 为什么写入用标准 DX7 bank dump，而不是 M-VAVE 的私有恢复协议 ──
   上游那份抓包文档（ref/protocol.md）写得很清楚：恢复工具走的是私有协议，
   制造商 ID 是 00 32 而不是 Yamaha 的 43，每条 1190 字节，负载是 7-bit
   位流压缩 —— 而且原文写着 "How CK is calculated is not known"。
   校验和算法至今未知，意味着那条路根本没法自己实现。
   但同一份文档给出了出路：这批音色本来就是标准 DX7 packed 格式，
   直接包成标准 bank dump 就能被 FM-1 收下：
       F0 43 00 09 20 00 <4096 字节> <校验和> F7
   而它的头与校验和规则 (128 - (sum & 0x7F)) & 0x7F，与读取路径完全一致
   —— 也就是 engine/dx7.js 里已经在用的那一套。写入不需要新的格式知识。

   ── 三件必须让用户知道的事（都来自上游实录，不是推测）──
   1. 「The FM-1 receives SysEx but never sends it.」
      设备不主动吐音色数据 →「读出设备里的音色」做不到 → 写入不可逆。
   2. 音色一旦被覆盖，机身自带的恢复没用：
      「the factory reset ... restores whatever was last imported
        rather than the original set」。
   3. 标准 bank dump 不带「目标 bank」字段，也没有任何应答。
      所以「发送完成」不等于「写入成功」，页面不能假装知道结果。

   packed voice / bank 的结构定义见 engine/dx7.js 顶部。
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dx7.js'));
  } else {
    root.FM1MIDI = factory(root.DX7);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DX7) {
  'use strict';

  /* 设备端口名的常见形态。Windows 会把 USB-MIDI 端口改名，社区为此专门做了
     fm-static —— 所以自动识别只能当提示，最终必须由用户确认。 */
  var FM1_PORT_RE = /(fm[\s\-_]?1|mvave|m[\s\-_]?vave)/i;

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  /* ---------------------------------------------------------------- 守门 */
  /* 只允许发这一种包。是白名单，不是黑名单 ——
     上游文档提到 F0 22 24 35 7D F7 会把设备打进芯片下载模式，而正常升级
     命令只差最后一个数据字节。与其列黑名单，不如把「可发的东西」锁死成
     唯一一种：标准 32 音色 bank dump。任何别的字节序列，本地就拦下来。 */
  function assertWritableSysex(bytes) {
    if (!bytes || typeof bytes.length !== 'number')
      throw new Error('要发送的不是字节数组');
    if (bytes.length !== DX7.SYSEX_BYTES)
      throw new Error('只允许发送 ' + DX7.SYSEX_BYTES + ' 字节的标准 bank dump，' +
                      '实际 ' + bytes.length + ' 字节');
    for (var i = 0; i < DX7.SYSEX_HEADER.length; i++) {
      if (bytes[i] !== DX7.SYSEX_HEADER[i])
        throw new Error('不是 DX7 bank dump（头不对）：' + DX7.hex(bytes.slice(0, 6)));
    }
    if (bytes[bytes.length - 1] !== 0xF7)
      throw new Error('结尾不是 F7');
    DX7.parseBank(bytes);           /* 校验和与结构自检 —— 宁可本地报错，也不写坏设备 */
    return true;
  }

  /* ------------------------------------------------------------ 浏览器侧 */
  function isSupported() {
    return typeof navigator !== 'undefined' &&
           typeof navigator.requestMIDIAccess === 'function';
  }

  function unsupportedReason() {
    if (typeof navigator === 'undefined')
      return '当前环境里没有 navigator，这应该是在 Node 里跑的 —— 浏览器里才有 Web MIDI。';
    return '这个浏览器没有 Web MIDI（navigator.requestMIDIAccess 不存在）。' +
           'Chrome、Edge、Opera 都自带这个能力；Safari 不支持。';
  }

  function describeError(e) {
    var n = e && e.name, m = e && e.message;
    var tail = m ? '（' + m + '）' : '';
    if (n === 'SecurityError')
      return '浏览器拒绝了 MIDI 访问。最常见的原因是页面不在安全上下文里 —— ' +
             '要用 https、或者本机地址打开。也可能你之前拒绝过这个权限。' + tail;
    if (n === 'NotSupportedError')
      return '这个系统不支持 Web MIDI。' + tail;
    if (n === 'AbortError')
      return '请求被中断了。' + tail;
    return 'MIDI 访问失败：' + (m || n || String(e));
  }

  /* sysex: true 是必须的。不传这个标志，浏览器不会给 SysEx 权限 ——
     而发送会在不报错的情况下被丢弃，表现为「点了没反应」。
     这就是社区说的那个坑，必须显式声明并检查结果。 */
  function requestAccess() {
    if (!isSupported()) return Promise.reject(new Error(unsupportedReason()));
    return navigator.requestMIDIAccess({ sysex: true }).then(function (access) {
      if (access.sysexEnabled === false)
        throw new Error('拿到了 MIDI 权限，但 SysEx 权限被拒绝了。' +
          '浏览器会为了 SysEx 单独弹一次授权（因为它可以改写设备），' +
          '必须点允许 —— 否则消息会被静默丢弃，看起来「发了但没反应」。');
      return access;
    }, function (e) {
      throw new Error(describeError(e));
    });
  }

  function listOutputs(access) {
    var out = [];
    if (access && access.outputs) access.outputs.forEach(function (p) { out.push(p); });
    return out;
  }

  function portLabel(p) {
    if (!p) return '(未选择)';
    return (p.name || '(无名端口)') + (p.manufacturer ? ' · ' + p.manufacturer : '');
  }

  function looksLikeFm1(p) {
    return FM1_PORT_RE.test((p && p.name || '') + ' ' + (p && p.manufacturer || ''));
  }

  /* 自动挑一个端口：名字像 FM-1 的优先；否则如果系统上只有一个输出端口，
     那就是它。多个又都不像，就不猜 —— 让用户自己选。 */
  function pickOutput(outputs) {
    var hits = outputs.filter(looksLikeFm1);
    if (hits.length) return hits[0];
    if (outputs.length === 1) return outputs[0];
    return null;
  }

  function voiceNameAt(data, slot) {
    var off = slot * DX7.VOICE_BYTES;
    return DX7.decodeVoice(data.slice(off, off + DX7.VOICE_BYTES)).name;
  }

  /* 发送一个 bank = 32 个音色。
     bankData 必须是 4096 字节的裸数据（不是 4104 的 SysEx）——
     打包交给这里做，调用方就没机会传错格式。
     返回一份发送报告，供页面显示，也供测试断言。 */
  function sendBank(output, bankData, opts) {
    opts = opts || {};
    if (!output) throw new Error('还没有选择输出端口。');
    if (!bankData || bankData.length !== DX7.BANK_BYTES)
      throw new Error('bank 数据必须是 ' + DX7.BANK_BYTES + ' 字节，实际 ' +
                      (bankData ? bankData.length : 'null') + ' 字节。');

    var sysex = DX7.buildBank(bankData);
    assertWritableSysex(sysex);

    var t0 = now();
    output.send(sysex);
    var ms = now() - t0;

    var names = [];
    for (var i = 0; i < DX7.VOICES_PER_BANK; i++) names.push(voiceNameAt(bankData, i));

    return {
      label: opts.label || '',
      bytes: sysex.length,
      header: DX7.hex(sysex.slice(0, DX7.SYSEX_HEADER.length)),
      checksum: sysex[4102],
      voices: DX7.VOICES_PER_BANK,
      names: names,
      port: portLabel(output),
      ms: ms,
      /* 标准 bank dump 没有任何应答，所以这里只能报「已发出」，
         不能报「已写入」。这个区分必须一路带到界面上。 */
      acknowledged: false,
    };
  }

  /* ============================================================================
     设备侧模拟：FM-1 的接收行为（验证用）
     ----------------------------------------------------------------------------
     它是协议另一半的可执行规范，所以跟发送方放在同一个文件里 ——
     改一边不会漏掉另一边。

     它忠实于上游记录的这几条：
       · 收标准 DX7 32 音色 bank dump，不做任何应答（标准 bank dump 没有 ACK）
       · 从不主动发送数据
       · 收到的包必须能解出 32 个合法音色，否则说明发送方有 bug（parseBank 抛错）
     它**不**模拟 M-VAVE 私有协议（00 32 ...），因为写入路径不走那条。

     一个必须标出来的假设：真实设备把收到的 bank 写到哪个位置，上游文档
     没有记录（私有协议里是靠一条 setup 消息指定 slot 的，标准 bank dump
     没有这个字段）。这里假设「写到设备当前选中的 bank」，用 selectedBank
     表示。拿到真机后第一个要验的就是这件事。详见 MIDI-WRITE.md。
     ========================================================================= */
  function FakeFm1(opts) {
    opts = opts || {};
    this.name = opts.name || 'M-VAVE FM-1';
    this.manufacturer = opts.manufacturer || 'M-VAVE';
    this.id = opts.id || 'fake-fm1-out-0';
    this.type = 'output';
    this.state = 'connected';
    this.connection = 'open';
    this.selectedBank = opts.selectedBank || 0;
    this.banks = [null, null, null, null];
    this.received = [];
    this.failNext = false;
  }

  FakeFm1.prototype.send = function (bytes) {
    if (this.failNext) { this.failNext = false; throw new Error('端口已断开'); }
    if (this.state !== 'connected') throw new Error('端口未连接');
    this.received.push(Array.from(bytes));
    /* 坏包在这里抛错。这正是要验的那件事：页面发出的字节，
       必须能被一个忠实实现协议的设备解开。 */
    var data = DX7.parseBank(bytes);
    this.banks[this.selectedBank] = data;
    return true;
  };

  FakeFm1.prototype.voiceNames = function (b) {
    b = (b === undefined) ? this.selectedBank : b;
    if (!this.banks[b]) return null;
    var out = [];
    for (var i = 0; i < DX7.VOICES_PER_BANK; i++) out.push(voiceNameAt(this.banks[b], i));
    return out;
  };

  /* 一个能塞进 MIDIAccess.outputs 的最小实现（是个 Map） */
  function fakeAccess(outputs) {
    var m = new Map();
    (outputs || []).forEach(function (p) { m.set(p.id, p); });
    return { outputs: m, inputs: new Map(), sysexEnabled: true, onstatechange: null };
  }

  return {
    FM1_PORT_RE: FM1_PORT_RE,
    assertWritableSysex: assertWritableSysex,
    isSupported: isSupported, unsupportedReason: unsupportedReason,
    describeError: describeError, requestAccess: requestAccess,
    listOutputs: listOutputs, portLabel: portLabel,
    looksLikeFm1: looksLikeFm1, pickOutput: pickOutput,
    voiceNameAt: voiceNameAt, sendBank: sendBank,
    FakeFm1: FakeFm1, fakeAccess: fakeAccess,
  };
});
