/* ============================================================================
   FM-1 音色台 · DX7 / FM-1 音色数据层
   ----------------------------------------------------------------------------
   只做格式：SysEx bank 的解析与重建、packed voice 的解码、参数区间表。
   不做界面、不做声音。浏览器（<script src> → window.DX7）与 Node 共用同一份。

   packed voice 格式来源（两路交叉验证）：
     1. Yamaha DX7 MIDI Data Format Sheet，F 节「Bulk Dump Packed Format」
     2. 从 FM-1 出厂音色的真实字节反推（ref/packed128.bin）
   一个 packed voice = 128 字节：
       0..101   6 个算子，每算子 17 字节（block 0 = OP6 … block 5 = OP1）
       102..109 音高包络 4 rate + 4 level
       110      算法 0-31
       111      bit3 = 振荡器同步 | bit2-0 = 反馈 0-7
       112..115 LFO speed / delay / 音高调制深度 / 振幅调制深度
       116      bit6-4 = 音高调制灵敏度 | bit3-1 = 波形 0-5 | bit0 = LFO 同步
       117      移调 0-48
       118..127 音色名 10 个 ASCII 字符
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DX7 = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SYSEX_HEADER = [0xF0, 0x43, 0x00, 0x09, 0x20, 0x00];
  var BANK_BYTES = 4096, SYSEX_BYTES = 4104, VOICE_BYTES = 128, VOICES_PER_BANK = 32, OP_BLOCK = 17;

  var CURVE = ['-LIN', '-EXP', '+EXP', '+LIN'];
  var LFO_WAVE = ['三角', '锯齿降', '锯齿升', '方波', '正弦', '采样保持'];
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* [ 面板可见上限, 位域存储上限 ]
     后者：该字段在 packed 格式里占满一个字节，MIDI 层面合法取值可达 127，
     而 DX7 面板只暴露到 99。第三方音色库里确实存在 0x7F。 */
  var SPEC = {
    '算法': [31, 31], '反馈': [7, 7], '振荡器同步': [1, 1], '移调': [48, 127],
    'LFO 波形': [5, 7], 'LFO 同步': [1, 1], 'LFO 音高调制灵敏度': [7, 7],
    '音高包络 rate / level': [99, 127],
    '算子·包络 R / L': [99, 127], '算子·断点': [99, 127], '算子·左右深度': [99, 127],
    '算子·左右曲线': [3, 3], '算子·失谐': [14, 15], '算子·速率缩放': [7, 7],
    '算子·力度灵敏度': [7, 7], '算子·振幅调制灵敏度': [3, 3],
    '算子·输出电平': [99, 127], '算子·振荡模式': [1, 1],
    '算子·粗调': [31, 31], '算子·微调': [99, 127],
  };

  function checksum(data) {
    var s = 0;
    for (var i = 0; i < data.length; i++) s += data[i];
    return (128 - (s & 0x7F)) & 0x7F;
  }

  function parseBank(blob) {
    if (blob.length !== SYSEX_BYTES)
      throw new Error('长度应为 ' + SYSEX_BYTES + ' 字节，实际 ' + blob.length);
    for (var i = 0; i < 6; i++)
      if (blob[i] !== SYSEX_HEADER[i])
        throw new Error('DX7 bulk 头不对：' + hex(blob.slice(0, 6)));
    if (blob[4103] !== 0xF7) throw new Error('结尾缺少 F7');
    var data = blob.slice(6, 6 + BANK_BYTES);
    var want = checksum(data), got = blob[4102];
    if (want !== got)
      throw new Error('校验和不符：文件 0x' + got.toString(16) + '，应为 0x' + want.toString(16));
    return data;
  }

  function buildBank(data) {
    var out = new Uint8Array(SYSEX_BYTES);
    out.set(SYSEX_HEADER, 0);
    out.set(data, 6);
    out[4102] = checksum(data);
    out[4103] = 0xF7;
    return out;
  }

  function decodeVoice(v) {
    var ops = [];
    for (var b = 0; b < 6; b++) {
      var o = b * OP_BLOCK;
      ops.push({
        num: 6 - b,
        egR: [v[o], v[o + 1], v[o + 2], v[o + 3]],
        egL: [v[o + 4], v[o + 5], v[o + 6], v[o + 7]],
        breakPoint: v[o + 8],
        leftDepth: v[o + 9],
        rightDepth: v[o + 10],
        leftCurve: v[o + 11] & 3,
        rightCurve: (v[o + 11] >> 2) & 3,
        detune: (v[o + 12] >> 3) & 15,
        rateScale: v[o + 12] & 7,
        keyVelSens: (v[o + 13] >> 2) & 7,
        ampModSens: v[o + 13] & 3,
        outputLevel: v[o + 14],
        oscMode: v[o + 15] & 1,
        freqCoarse: (v[o + 15] >> 1) & 31,
        freqFine: v[o + 16],
      });
    }
    var name = '';
    for (var i = 118; i < 128; i++) name += String.fromCharCode(v[i]);
    return {
      ops: ops,
      pitchEgR: [v[102], v[103], v[104], v[105]],
      pitchEgL: [v[106], v[107], v[108], v[109]],
      algorithm: v[110] & 31,
      /* 同步位在 bit3，不在 bit4。原先写成 bit4：真实数据里 byte111 全部 ≤ 15，
         bit4 恒为 0 → 这个参数对全部音色都读成「关」，详情面板显示的也是「关」，
         而真正的 sync 位（bit3）被当成未使用位、解码时直接丢掉。
         是两个独立实现把它揪出来的 —— phosphor-dsp 的 dx7.rs 与 jbatistareis/wmo，
         都写作「bit 3 oscillator key sync, bits 2-0 feedback」。 */
      oscKeySync: (v[111] >> 3) & 1,
      feedback: v[111] & 7,
      lfoSpeed: v[112], lfoDelay: v[113],
      lfoPitchModDepth: v[114], lfoAmpModDepth: v[115],
      lfoPitchModSens: (v[116] >> 4) & 7,
      lfoWave: (v[116] >> 1) & 7,
      lfoSync: v[116] & 1,
      transpose: v[117],
      name: name.replace(/[\x00-\x1f\x7f]/g, ' ').trimEnd(),
      raw: v,
    };
  }

  /* 把一个音色的名字写回 10 字节 ASCII（超范围字符替换为空格） */
  function writeName(data, slot, raw) {
    var bytes = new Uint8Array(10).fill(0x20);
    for (var i = 0; i < Math.min(10, raw.length); i++) {
      var c = raw.charCodeAt(i);
      bytes[i] = (c >= 32 && c < 127) ? c : 0x20;
    }
    data.set(bytes, slot * VOICE_BYTES + 118);
    return data;
  }

  /* 区间检查。decodeVoice 只产出合法值，但"改音色"会算出新值 ——
   越界的值必须在这里被拦下，而不是被 & 掩码静默丢弃高位。
   这个项目已经栽过两次同类跟头：detune=9 被 & 15 变成 -7；
   EG 字节顺序错位时格式全合法、只是音色不是设计的样子。
   静默写错比报错危险得多，所以这里选择报错。 */
function byte(v, name) {
  if (v !== Math.floor(v) || v < 0 || v > 127)
    throw new Error(name + ' 必须是 0–127 的整数，实际 ' + v);
  return v;
}
function bits(v, max, name) {
  if (v !== Math.floor(v) || v < 0 || v > max)
    throw new Error(name + ' 必须是 0–' + max + ' 的整数，实际 ' + v);
  return v;
}

/* decodeVoice 的严格逆运算：把结构化对象写回 128 字节。
   ----------------------------------------------------------------------------
   没有它，参数就只能读、不能写 —— 也就意味着"用一句话改音色"改完写不回去。
   每一处位域都是 decodeVoice 里那条取值的逆运算，逐条对应、顺序不重排。
   往返一致性由 tools/intent_test.mjs 用真实字节逐字节断言，不靠肉眼核对。 */
function encodeVoice(d) {
  var out = new Uint8Array(VOICE_BYTES);
  for (var b = 0; b < 6; b++) {
    var o = b * OP_BLOCK, s = d.ops[b], who = 'OP' + (6 - b);
    if (!s) throw new Error('第 ' + (b + 1) + ' 个算子块缺失（应为 ' + who + '）');
    for (var k = 0; k < 4; k++) {
      out[o + k] = byte(s.egR[k], who + ' 包络 R' + (k + 1));
      out[o + 4 + k] = byte(s.egL[k], who + ' 包络 L' + (k + 1));
    }
    out[o + 8] = byte(s.breakPoint, who + ' 断点');
    out[o + 9] = byte(s.leftDepth, who + ' 左深度');
    out[o + 10] = byte(s.rightDepth, who + ' 右深度');
    out[o + 11] = bits(s.leftCurve, 3, who + ' 左曲线') | (bits(s.rightCurve, 3, who + ' 右曲线') << 2);
    out[o + 12] = (bits(s.detune, 15, who + ' 失谐') << 3) | bits(s.rateScale, 7, who + ' 速率缩放');
    out[o + 13] = (bits(s.keyVelSens, 7, who + ' 力度灵敏度') << 2) | bits(s.ampModSens, 3, who + ' 振幅调制灵敏度');
    out[o + 14] = byte(s.outputLevel, who + ' 输出电平');
    out[o + 15] = bits(s.oscMode, 1, who + ' 振荡模式') | (bits(s.freqCoarse, 31, who + ' 粗调') << 1);
    out[o + 16] = byte(s.freqFine, who + ' 微调');
  }
  for (var i = 0; i < 4; i++) {
    out[102 + i] = byte(d.pitchEgR[i], '音高包络 R' + (i + 1));
    out[106 + i] = byte(d.pitchEgL[i], '音高包络 L' + (i + 1));
  }
  out[110] = bits(d.algorithm, 31, '算法');
  out[111] = (bits(d.oscKeySync, 1, '振荡器同步') << 3) | bits(d.feedback, 7, '反馈');
  out[112] = byte(d.lfoSpeed, 'LFO 速度');
  out[113] = byte(d.lfoDelay, 'LFO 延迟');
  out[114] = byte(d.lfoPitchModDepth, 'LFO 音高调制深度');
  out[115] = byte(d.lfoAmpModDepth, 'LFO 振幅调制深度');
  out[116] = (bits(d.lfoPitchModSens, 7, 'LFO 音高调制灵敏度') << 4)
    | (bits(d.lfoWave, 7, 'LFO 波形') << 1) | bits(d.lfoSync, 1, 'LFO 同步');
  out[117] = byte(d.transpose, '移调');
  writeName(out, 0, d.name || '');
  return out;
}

/* 把 128 字节的音色摘要成便于检索/展示的几个派生量 */
  function describe(d, engine) {
    var carriers = [];
    if (engine) {
      var plan = engine.compiled(d.algorithm & 31);
      carriers = plan.carriers.map(function (i) { return plan.nodes[i].op; }).sort(function (a, b) { return b - a; });
    }
    var modEnergy = 0, carEnergy = 0, opLevels = {};
    for (var i = 0; i < 6; i++) {
      var o = d.ops[i];
      opLevels[o.num] = o.outputLevel;
      if (carriers.indexOf(o.num) >= 0) carEnergy += o.outputLevel; else modEnergy += o.outputLevel;
    }
    return {
      algorithmPanel: (d.algorithm & 31) + 1,
      carriers: carriers,
      carrierCount: carriers.length,
      modulatorCount: 6 - carriers.length,
      brightness: modEnergy / 6,
      opLevels: opLevels,
      isPercussive: d.ops.some(function (o) { return o.egR[0] >= 90 && o.egL[0] >= 90 && o.egL[3] <= 10; }),
    };
  }

  function transposeName(t) { return NOTE_NAMES[t % 12] + (Math.floor(t / 12) - 1); }

  function hex(bytes, sep) {
    sep = sep === undefined ? ' ' : sep;
    var out = [];
    for (var i = 0; i < bytes.length; i++) out.push(bytes[i].toString(16).padStart(2, '0'));
    return out.join(sep);
  }

  function b64ToBytes(b64) {
    var bin = (typeof atob === 'function')
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  return {
    SYSEX_HEADER: SYSEX_HEADER,
    BANK_BYTES: BANK_BYTES, SYSEX_BYTES: SYSEX_BYTES,
    VOICE_BYTES: VOICE_BYTES, VOICES_PER_BANK: VOICES_PER_BANK, OP_BLOCK: OP_BLOCK,
    CURVE: CURVE, LFO_WAVE: LFO_WAVE, NOTE_NAMES: NOTE_NAMES, SPEC: SPEC,
    checksum: checksum, parseBank: parseBank, buildBank: buildBank,
    decodeVoice: decodeVoice, encodeVoice: encodeVoice, writeName: writeName, describe: describe,
    transposeName: transposeName, hex: hex, b64ToBytes: b64ToBytes,
  };
});
