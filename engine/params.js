/* ============================================================================
   FM-1 音色台 · 单参数实时写入层（VCED 参数表）
   ----------------------------------------------------------------------------
   回答一个问题：不刷固件、不打整包 bank，能不能把**正在响的音色**实时改一个参数？
   FM-1 官方 V15 固件宣布支持（Gearspace 帖转述官方更新说明），圈内实测样本来自
   Elektronauts 的 sezare56：F0 43 10 01 08 1F F7 → 算法切到 32，真机有效。

   消息格式（无校验和 —— 这是 DX7 参数变更与 bulk dump 的一个区别）：
     F0 43 1n pp qq vv F7
       43    Yamaha 厂商 ID
       1n    子状态 1（参数变更）| n = MIDI 通道（10 = 通道 1）
       pp    参数组：00 = 算子区（6 算子 × 21 参数 = 126 个）
                     01 = 全局区（29 个：音高包络/算法/反馈/LFO/移调/名字）
       qq    组内偏移
       vv    新值（0-127，必须在**该参数自己的合法区间**内）
       F7

   pp qq 怎么来 —— 两个来源交叉，且与我们的 packed 布局互洽：
     1. sezare56 的 FM-1 实测表：算子块 21 参数、OP6 起始（OP6 基址 0、步长 21、
        OP1 基址 105）、全局区 pp=01，其中 qq=08=算法号 有真机实测背书。
        ⚠ 他的表自带勘误（「全局参数偏移了 2」且未发更正），LFO 波形/速度的先后
        也与主流实现相反 —— 这两处以主流为准，见下。
     2. DX7 VCED 公认结构（Dexed / dexed-py / midiwire 三个独立实现一致）：
        全局区顺序 = 音高包络 R1-4、L1-4、算法 134、反馈 135、同步 136、
        LFO 速度/延迟/音高调制深度/振幅调制深度/键同步/波形/灵敏度 137-143、
        移调 144、名字 145-154。总数 155（0-154），与官方「0–155」说法吻合。
     3. 数据裁判：tools/param_test.mjs 拿 128 个出厂音色逐参数验区间 ——
        名字位若映射错位，ASCII 断言当场炸；LFO 波形若放错，0-5 区间断言当场炸。

   与 packed 字节的关系：VCED 索引 ≠ packed 偏移。packed 一个算子块只有 17 字节
   （曲线 2 合 1、失谐/速率缩放合 1、力度/振幅调制灵敏度合 1、模式/粗调合 1），
   所以表里每个参数都显式声明自己在 packed 里的位置和位域，读写都走这张表。
   整字节字段声明 byte（块内相对偏移），共享字节的位域声明 get/set 闭包。
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DX7_PARAMS = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PARAM_COUNT = 155;
  var OP_PARAM_COUNT = 21, GLOBAL_BASE = 126;   // 6×21 = 126
  var PP_OP = 0, PP_GLOBAL = 1;

  function opBase(op) {            // op: 算子号 1-6 → VCED 组内绝对索引
    if (op !== Math.floor(op) || op < 1 || op > 6)
      throw new Error('算子号必须是 1-6 的整数，实际 ' + op);
    return 21 * (6 - op);          // VCED：OP6 基址 0，步长 21
  }
  function packedOpBase(op) {      // packed 侧：block 0 = OP6，块长 17
    return 17 * (6 - op);
  }

  /* 每算子 21 个 VCED 参数。整字节字段用 byte（packed 块内相对偏移），
     共享字节的位域用 get(o,d) / set(o,v,d)（o = packed 块基址）。 */
  var OP_FIELDS = [
    { off: 0,  name: 'egR1',        zh: '包络 R1',              max: 99, byte: 0 },
    { off: 1,  name: 'egR2',        zh: '包络 R2',              max: 99, byte: 1 },
    { off: 2,  name: 'egR3',        zh: '包络 R3',              max: 99, byte: 2 },
    { off: 3,  name: 'egR4',        zh: '包络 R4',              max: 99, byte: 3 },
    { off: 4,  name: 'egL1',        zh: '包络 L1',              max: 99, byte: 4 },
    { off: 5,  name: 'egL2',        zh: '包络 L2',              max: 99, byte: 5 },
    { off: 6,  name: 'egL3',        zh: '包络 L3',              max: 99, byte: 6 },
    { off: 7,  name: 'egL4',        zh: '包络 L4',              max: 99, byte: 7 },
    { off: 8,  name: 'breakPoint',  zh: '键盘缩放断点',         max: 99, byte: 8 },
    { off: 9,  name: 'lsLeftDepth', zh: '键盘电平缩放·左深度',  max: 99, byte: 9 },
    { off: 10, name: 'lsRightDepth',zh: '键盘电平缩放·右深度',  max: 99, byte: 10 },
    { off: 11, name: 'leftCurve',   zh: '左曲线',               max: 3,
      get: function (o, d) { return d[o + 11] & 3; },
      set: function (o, v, d) { d[o + 11] = (d[o + 11] & 0xFC) | v; } },
    { off: 12, name: 'rightCurve',  zh: '右曲线',               max: 3,
      get: function (o, d) { return (d[o + 11] >> 2) & 3; },
      set: function (o, v, d) { d[o + 11] = (d[o + 11] & 0x3F) | (v << 2); } },
    { off: 13, name: 'rateScale',   zh: '速率缩放',             max: 7,
      get: function (o, d) { return d[o + 12] & 7; },
      set: function (o, v, d) { d[o + 12] = (d[o + 12] & 0xF8) | v; } },
    { off: 14, name: 'ampModSens',  zh: '振幅调制灵敏度',       max: 3,
      get: function (o, d) { return d[o + 13] & 3; },
      set: function (o, v, d) { d[o + 13] = (d[o + 13] & 0xFC) | v; } },
    { off: 15, name: 'keyVelSens',  zh: '力度灵敏度',           max: 7,
      get: function (o, d) { return (d[o + 13] >> 2) & 7; },
      set: function (o, v, d) { d[o + 13] = (d[o + 13] & 0xE3) | (v << 2); } },
    { off: 16, name: 'outputLevel', zh: '输出电平',             max: 99, byte: 14 },
    { off: 17, name: 'oscMode',     zh: '振荡模式',             max: 1,
      get: function (o, d) { return d[o + 15] & 1; },
      set: function (o, v, d) { d[o + 15] = (d[o + 15] & 0xFE) | v; } },
    { off: 18, name: 'freqCoarse',  zh: '频率粗调',             max: 31,
      get: function (o, d) { return (d[o + 15] >> 1) & 31; },
      set: function (o, v, d) { d[o + 15] = (d[o + 15] & 0xC1) | (v << 1); } },
    { off: 19, name: 'freqFine',    zh: '频率微调',             max: 99, byte: 16 },
    { off: 20, name: 'detune',      zh: '失谐（7 居中）',       max: 14,
      get: function (o, d) { return (d[o + 12] >> 3) & 15; },
      set: function (o, v, d) { d[o + 12] = (d[o + 12] & 0x87) | (v << 3); } },
  ];

  /* 全局区 29 个参数。byte = packed 绝对字节号；位域同上（d 直接是 128 字节）。 */
  var GLOBAL_FIELDS = [
    { off: 0,  name: 'pegR1', zh: '音高包络 R1',              max: 99, byte: 102 },
    { off: 1,  name: 'pegR2', zh: '音高包络 R2',              max: 99, byte: 103 },
    { off: 2,  name: 'pegR3', zh: '音高包络 R3',              max: 99, byte: 104 },
    { off: 3,  name: 'pegR4', zh: '音高包络 R4',              max: 99, byte: 105 },
    { off: 4,  name: 'pegL1', zh: '音高包络 L1（50 居中）',   max: 99, byte: 106 },
    { off: 5,  name: 'pegL2', zh: '音高包络 L2（50 居中）',   max: 99, byte: 107 },
    { off: 6,  name: 'pegL3', zh: '音高包络 L3（50 居中）',   max: 99, byte: 108 },
    { off: 7,  name: 'pegL4', zh: '音高包络 L4（50 居中）',   max: 99, byte: 109 },
    { off: 8,  name: 'algorithm', zh: '算法（面板 1-32）',    max: 31,
      get: function (d) { return d[110] & 31; },
      set: function (v, d) { d[110] = (d[110] & 0xE0) | v; } },
    { off: 9,  name: 'feedback', zh: '反馈',                  max: 7,
      get: function (d) { return d[111] & 7; },
      set: function (v, d) { d[111] = (d[111] & 0xF8) | v; } },
    { off: 10, name: 'oscKeySync', zh: '振荡器同步',          max: 1,
      get: function (d) { return (d[111] >> 3) & 1; },
      set: function (v, d) { d[111] = (d[111] & 0xF7) | (v << 3); } },
    { off: 11, name: 'lfoSpeed', zh: 'LFO 速度',              max: 99, byte: 112 },
    { off: 12, name: 'lfoDelay', zh: 'LFO 延迟',              max: 99, byte: 113 },
    { off: 13, name: 'lfoPitchModDepth', zh: 'LFO 音高调制深度', max: 99, byte: 114 },
    { off: 14, name: 'lfoAmpModDepth', zh: 'LFO 振幅调制深度', max: 99, byte: 115 },
    { off: 15, name: 'lfoSync', zh: 'LFO 键同步',             max: 1,
      get: function (d) { return d[116] & 1; },
      set: function (v, d) { d[116] = (d[116] & 0xFE) | v; } },
    { off: 16, name: 'lfoWave', zh: 'LFO 波形',               max: 5,
      get: function (d) { return (d[116] >> 1) & 7; },
      set: function (v, d) { d[116] = (d[116] & 0xF1) | (v << 1); } },
    { off: 17, name: 'lfoPitchModSens', zh: 'LFO 音高调制灵敏度', max: 7,
      get: function (d) { return (d[116] >> 4) & 7; },
      set: function (v, d) { d[116] = (d[116] & 0x8F) | (v << 4); } },
    { off: 18, name: 'transpose', zh: '移调（24 居中）',      max: 48, byte: 117 },
    // off 19-28：音色名 10 个 ASCII 字符（packed 118-127）
  ];
  var NAME_GLOBAL_OFF = 19;        // 名字在全局区组内的起始偏移（= 绝对索引 145）

  function checkIndex(index) {
    if (index !== Math.floor(index) || index < 0 || index >= PARAM_COUNT)
      throw new Error('参数索引必须是 0-' + (PARAM_COUNT - 1) + ' 的整数，实际 ' + index);
  }

  /* 绝对索引 → 位置描述。pp/qq 是发给 FM-1 的组号与组内偏移。 */
  function locate(index) {
    checkIndex(index);
    if (index < GLOBAL_BASE) {
      var op = 6 - Math.floor(index / OP_PARAM_COUNT);   // 索引 0-20 → OP6 … 105-125 → OP1
      var f = OP_FIELDS[index % OP_PARAM_COUNT];
      return { isOp: true, op: op, field: f, pp: PP_OP, qq: index };
    }
    var g = index - GLOBAL_BASE;
    if (g >= NAME_GLOBAL_OFF) {
      return { isOp: false, field: { name: 'nameChar' + (g - NAME_GLOBAL_OFF + 1),
                 zh: '音色名第 ' + (g - NAME_GLOBAL_OFF + 1) + ' 字符', max: 127, min: 32 },
               pp: PP_GLOBAL, qq: g, isName: true, namePos: 118 + (g - NAME_GLOBAL_OFF) };
    }
    var gf = GLOBAL_FIELDS[g];
    if (!gf) throw new Error('全局参数表缺项：组内偏移 ' + g);
    return { isOp: false, field: gf, pp: PP_GLOBAL, qq: g };
  }

  function checkData(data) {
    if (!data || data.length !== 128)
      throw new Error('需要 128 字节的 packed voice，实际 ' + (data ? data.length : 'null'));
  }
  function checkValue(field, v, who) {
    var min = field.min == null ? 0 : field.min;
    if (v !== Math.floor(v) || v < min || v > field.max)
      throw new Error(who + ' 必须是 ' + min + '-' + field.max + ' 的整数，实际 ' + v);
  }

  /* ---- 读：packed 128 字节 → 参数值（不抛区间错 —— 读到什么是什么，
          非法值交给测试去当布局裁判，读操作本身必须安静） ---- */
  function getParam(data, index) {
    checkData(data);
    var loc = locate(index), f = loc.field;
    if (loc.isName) return data[loc.namePos];
    if (loc.isOp) {
      var pbase = packedOpBase(loc.op);
      if (f.byte != null) return data[pbase + f.byte];
      return f.get(pbase, data);
    }
    if (f.byte != null) return data[f.byte];
    return f.get(data);
  }

  /* ---- 写：越界**报错**，绝不掩码截断（本项目两次栽跟头换来的规矩） ---- */
  function setParam(data, index, value) {
    checkData(data);
    var loc = locate(index), f = loc.field;
    checkValue(f, value, f.zh + '（参数 ' + index + '）');
    if (loc.isName) { data[loc.namePos] = value; return data; }
    if (loc.isOp) {
      var pbase = packedOpBase(loc.op);
      if (f.byte != null) { data[pbase + f.byte] = value; return data; }
      f.set(pbase, value, data); return data;
    }
    if (f.byte != null) { data[f.byte] = value; return data; }
    f.set(value, data); return data;
  }

  /* ---- SysEx 构造：F0 43 1n pp qq vv F7（无校验和，通道 n = 0-15） ---- */
  function paramChange(index, value, channel) {
    if (channel == null) channel = 0;
    if (channel !== Math.floor(channel) || channel < 0 || channel > 15)
      throw new Error('MIDI 通道必须是 0-15 的整数，实际 ' + channel);
    var loc = locate(index);
    checkValue(loc.field, value, loc.field.zh + '（参数 ' + index + '）');
    var out = new Uint8Array(7);
    out[0] = 0xF0; out[1] = 0x43; out[2] = 0x10 | channel;
    out[3] = loc.pp; out[4] = loc.qq; out[5] = value & 0x7F; out[6] = 0xF7;
    return out;
  }

  function paramInfo(index) {
    var loc = locate(index);
    return { index: index, pp: loc.pp, qq: loc.qq, isOp: loc.isOp, op: loc.op,
             name: loc.field.name, zh: loc.field.zh,
             min: loc.field.min == null ? 0 : loc.field.min, max: loc.field.max };
  }

  /* 每个 (pp,qq) 预解析一遍，宏里引用不重复定位 */
  var PP_QQ = (function () {
    var m = [];
    for (var i = 0; i < PARAM_COUNT; i++) {
      var loc = locate(i);
      m.push({ pp: loc.pp, qq: loc.qq });
    }
    return m;
  })();

  function chg(index, from, to, label) {
    return { index: index, pp: PP_QQ[index].pp, qq: PP_QQ[index].qq,
             name: label, from: from, to: to, delta: to - from };
  }

  /* ==========================================================================
     技法宏 · 闷音（palm mute）
     ----------------------------------------------------------------------------
     目标声音：掌缘压弦的电吉他 —— 音头还在、衰减被一刀切短、音色发"噪"。
     FM 上的三件事：
       1. 衰减变快：对"听得见"的算子（输出电平达标者，多为载波）把 R2/R3 抬到
          不低于 80/75（DX7 速率 99 最快），把 L2/L3 压到不超过 25/20 ——
          音头（R1/L1）和尾音（R4/L4）不动，只剪中段。
       2. 反馈 +2（封顶 7）：算子自反馈加深，音色向锯齿/颗粒方向塌，像弦被压住。
       3. 不碰输出电平、不碰音高 —— 闷音不改音量与音准，那是别的宏的事。
     纯函数：同样的输入字节永远得到同样的变更清单。不改数据，只出计划。
     ========================================================================== */
  function palmMute(data, opts) {
    checkData(data);
    opts = opts || {};
    var levelThreshold = opts.levelThreshold == null ? 60 : opts.levelThreshold;
    if (levelThreshold !== Math.floor(levelThreshold) || levelThreshold < 0 || levelThreshold > 99)
      throw new Error('levelThreshold 必须是 0-99 的整数，实际 ' + levelThreshold);

    var changes = [];
    var fb = getParam(data, GLOBAL_BASE + 9);                  // feedback，绝对索引 135
    var fbTo = Math.min(7, fb + (opts.feedbackBoost == null ? 2 : opts.feedbackBoost));
    if (fbTo !== fb) changes.push(chg(GLOBAL_BASE + 9, fb, fbTo, 'feedback'));

    for (var op = 1; op <= 6; op++) {
      var b = opBase(op);
      var lvl = getParam(data, b + 16);
      if (lvl < levelThreshold) continue;                      // 听不见的算子不白改
      var spec = [
        { f: 1, who: 'min', to: 80, name: 'egR2' },            // 衰减加快
        { f: 5, who: 'max', to: 25, name: 'egL2' },            // 衰减后电平压低
        { f: 2, who: 'min', to: 75, name: 'egR3' },
        { f: 6, who: 'max', to: 20, name: 'egL3' },
      ];
      for (var s = 0; s < spec.length; s++) {
        var sp = spec[s], idx = b + sp.f, cur = getParam(data, idx);
        var to = sp.who === 'min' ? Math.min(Math.max(cur, sp.to), 99)
                                  : Math.min(cur, sp.to);
        if (to !== cur) changes.push(chg(idx, cur, to, 'OP' + op + ' ' + sp.name));
      }
    }
    return { name: 'palmMute', zh: '闷音', changes: changes };
  }

  /* 变更清单 → SysEx 消息数组（可选：跳过不变项已在宏里做掉） */
  function changesToSysex(changes, channel) {
    var out = [];
    for (var i = 0; i < changes.length; i++)
      out.push(paramChange(changes[i].index, changes[i].to, channel));
    return out;
  }

  /* 把整张表摊平成可打印的清单（文档/调试用） */
  function listParams() {
    var rows = [];
    for (var i = 0; i < PARAM_COUNT; i++) {
      var inf = paramInfo(i);
      rows.push(inf.index + '\t' + inf.pp + ' ' + inf.qq +
        '\t' + (inf.isOp ? 'OP' + inf.op + ' ' : '') + inf.name + '\t' + inf.zh +
        '\t' + inf.min + '-' + inf.max);
    }
    return rows.join('\n');
  }

  return {
    PARAM_COUNT: PARAM_COUNT, OP_PARAM_COUNT: OP_PARAM_COUNT,
    GLOBAL_BASE: GLOBAL_BASE, PP_OP: PP_OP, PP_GLOBAL: PP_GLOBAL,
    OP_FIELDS: OP_FIELDS, GLOBAL_FIELDS: GLOBAL_FIELDS, NAME_GLOBAL_OFF: NAME_GLOBAL_OFF,
    opBase: opBase, packedOpBase: packedOpBase,
    getParam: getParam, setParam: setParam,
    paramChange: paramChange, paramInfo: paramInfo, listParams: listParams,
    palmMute: palmMute, changesToSysex: changesToSysex,
  };
});
