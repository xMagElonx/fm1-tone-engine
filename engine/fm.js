/* ============================================================================
   FM-1 音色台 · 6 算子 FM 试听引擎
   ----------------------------------------------------------------------------
   用途：把一段 DX7 音色参数渲染成音频，用于浏览器试听与导出 WAV。
   它**不是** DX7 的逐周期复刻，是一台"能听出音色特征"的近似引擎；
   已实现 / 未实现的清单写在 README.md 与 LICENSE-AUDIT.md，不在这里含糊。

   同时可在浏览器（<script src> → window.FM_ENGINE）与 Node（require）下运行，
   这样同一份逻辑既能被页面使用，也能被 tools/ 下的测试脚本直接审计。
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FM_ENGINE = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  /* ============================================================
     一、32 个算法的算子连接表
     ------------------------------------------------------------
     表示法逐字取自一份公开的文本化描述（LAU 邮件列表，Sean Bolton 提供，
     摘自 hexter 源码）。原文用 car()/mod()/car_sfb()/mod_sfb() 的嵌套
     表达式描述每个算法；这里保持同样的嵌套结构，只把 C 的 `+` 换成数组
     逗号 —— 结构不重排，就不会在转写成邻接表时发生漂移。

     原文编号是 DX7 面板编号 1–32；packed voice 里的算法字节是 0–31
     （字节 = 面板号 − 1），因此 ALGOS[i] 对应面板算法 i+1。

     交叉验证：下列 4 条全部来自 Yamaha DX7 官方操作手册，且全部吻合——
       · 算法 1 的两个载波是 OP1 与 OP3
       · 算法 5  = 3 载波 + 3 调制器
       · 算法 16 = 1 载波 + 5 调制器
       · 算法 32 = 6 载波、无调制器
     另有两条全局不变量（已断言，见 tools/engine_test.mjs）：
       · OP1 在全部 32 个算法里都是载波
       · 每个算法的 6 个算子各出现且仅出现一次、反馈路径恰有一条

     sfb:true 标记"反馈的来源算子"。默认反馈回它自己；仅算法 4 与算法 6
     例外（反馈回到所在堆栈最上方的调制器 OP6），由 FB_OVERRIDE 给出。
     ============================================================ */
  function modsOf(m) {
    if (m === 0 || m === null || m === undefined) return [];
    return Array.isArray(m) ? m : [m];
  }
  function car(op, m)    { return { op: op, mods: modsOf(m), sfb: false }; }
  function carSfb(op, m) { return { op: op, mods: modsOf(m), sfb: true }; }
  function mod(op, m)    { return { op: op, mods: modsOf(m), sfb: false }; }
  function modSfb(op, m) { return { op: op, mods: modsOf(m), sfb: true }; }

  /* 算法 19–25 在原文里用一个临时变量 i 让**同一个调制器**同时喂多个载波
     （"i = mod_sfb(OP_6); ... car(OP_5, i) + car(OP_4, i)"）。
     这里必须把共享显式写出来：若把表达式抄两遍，OP6 会被当成两个独立算子分别
     计算——数值上等价（同参数同相位，结果必然相同），但结构上就不对了，
     而且会让下面那条"每个算子各出现一次"的结构审计失效。
     这正是审计的价值：转写时丢掉的一层共享，靠断言抓了回来。 */
  var sh6fb = modSfb(6, 0);   // 带自反馈的 OP6，供算法 19/22/23/24/25 共用
  var sh6   = mod(6, 0);      // 不带反馈的 OP6，供算法 21 使用
  var sh3fb = modSfb(3, 0);   // 带自反馈的 OP3，供算法 20/21 共用

  var ALGOS = [
    /*  1 */ [car(3, mod(4, mod(5, modSfb(6, 0)))), car(1, mod(2, 0))],
    /*  2 */ [car(3, mod(4, mod(5, mod(6, 0)))), car(1, modSfb(2, 0))],
    /*  3 */ [car(4, mod(5, modSfb(6, 0))), car(1, mod(2, mod(3, 0)))],
    /*  4 */ [carSfb(4, mod(5, mod(6, 0))), car(1, mod(2, mod(3, 0)))],
    /*  5 */ [car(5, modSfb(6, 0)), car(3, mod(4, 0)), car(1, mod(2, 0))],
    /*  6 */ [carSfb(5, mod(6, 0)), car(3, mod(4, 0)), car(1, mod(2, 0))],
    /*  7 */ [car(3, [mod(5, modSfb(6, 0)), mod(4, 0)]), car(1, mod(2, 0))],
    /*  8 */ [car(3, [mod(5, mod(6, 0)), modSfb(4, 0)]), car(1, mod(2, 0))],
    /*  9 */ [car(3, [mod(5, mod(6, 0)), mod(4, 0)]), car(1, modSfb(2, 0))],
    /* 10 */ [car(4, [mod(6, 0), mod(5, 0)]), car(1, mod(2, modSfb(3, 0)))],
    /* 11 */ [car(4, [modSfb(6, 0), mod(5, 0)]), car(1, mod(2, mod(3, 0)))],
    /* 12 */ [car(3, [mod(6, 0), mod(5, 0), mod(4, 0)]), car(1, modSfb(2, 0))],
    /* 13 */ [car(3, [modSfb(6, 0), mod(5, 0), mod(4, 0)]), car(1, mod(2, 0))],
    /* 14 */ [car(3, mod(4, [modSfb(6, 0), mod(5, 0)])), car(1, mod(2, 0))],
    /* 15 */ [car(3, mod(4, [mod(6, 0), mod(5, 0)])), car(1, modSfb(2, 0))],
    /* 16 */ [car(1, [mod(5, modSfb(6, 0)), mod(3, mod(4, 0)), mod(2, 0)])],
    /* 17 */ [car(1, [mod(5, mod(6, 0)), mod(3, mod(4, 0)), modSfb(2, 0)])],
    /* 18 */ [car(1, [mod(4, mod(5, mod(6, 0))), modSfb(3, 0), mod(2, 0)])],
    /* 19 */ [car(5, sh6fb), car(4, sh6fb), car(1, mod(2, mod(3, 0)))],
    /* 20 */ [car(4, [mod(6, 0), mod(5, 0)]), car(2, sh3fb), car(1, sh3fb)],
    /* 21 */ [car(5, sh6), car(4, sh6), car(2, sh3fb), car(1, sh3fb)],
    /* 22 */ [car(5, sh6fb), car(4, sh6fb), car(3, sh6fb), car(1, mod(2, 0))],
    /* 23 */ [car(5, sh6fb), car(4, sh6fb), car(2, mod(3, 0)), car(1, 0)],
    /* 24 */ [car(5, sh6fb), car(4, sh6fb), car(3, sh6fb), car(2, 0), car(1, 0)],
    /* 25 */ [car(5, sh6fb), car(4, sh6fb), car(3, 0), car(2, 0), car(1, 0)],
    /* 26 */ [car(4, [modSfb(6, 0), mod(5, 0)]), car(2, mod(3, 0)), car(1, 0)],
    /* 27 */ [car(4, [mod(6, 0), mod(5, 0)]), car(2, modSfb(3, 0)), car(1, 0)],
    /* 28 */ [car(6, 0), car(3, mod(4, modSfb(5, 0))), car(1, mod(2, 0))],
    /* 29 */ [car(5, modSfb(6, 0)), car(3, mod(4, 0)), car(2, 0), car(1, 0)],
    /* 30 */ [car(6, 0), car(3, mod(4, modSfb(5, 0))), car(2, 0), car(1, 0)],
    /* 31 */ [car(5, modSfb(6, 0)), car(4, 0), car(3, 0), car(2, 0), car(1, 0)],
    /* 32 */ [carSfb(6, 0), car(5, 0), car(4, 0), car(3, 0), car(2, 0), car(1, 0)],
  ];

  /* 反馈的"来源算子 → 目标算子"。只有算法 4 / 6 的目标不是来源自己。
     键是 ALGOS 下标（= 面板号 − 1）。 */
  var FB_OVERRIDE = {
    3: { src: 4, dst: 6 },   // 面板算法 4：OP4 的输出回馈给 OP6
    5: { src: 5, dst: 6 },   // 面板算法 6：OP5 的输出回馈给 OP6
  };

  /* ============================================================
     二、把算子树编译成可逐样本执行的线性序列
     ============================================================ */
  function compileAlgo(algoIndex) {
    var trees = ALGOS[algoIndex];
    var nodes = [];          // 后序：任何节点的调制源都排在它前面
    var seen = new Map();    // 同一算子对象被多个载波共用时只计算一次
    var carriers = [];
    var sfbIdx = -1;

    function visit(n) {
      var hit = seen.get(n);
      if (hit !== undefined) return hit;
      var srcs = [];
      for (var i = 0; i < n.mods.length; i++) srcs.push(visit(n.mods[i]));
      var idx = nodes.length;
      nodes.push({ op: n.op, srcs: srcs });
      seen.set(n, idx);
      if (n.sfb) sfbIdx = idx;
      return idx;
    }
    for (var t = 0; t < trees.length; t++) carriers.push(visit(trees[t]));

    var ov = FB_OVERRIDE[algoIndex];
    var srcOp, dstOp;
    if (ov) { srcOp = ov.src; dstOp = ov.dst; }
    else { srcOp = nodes[sfbIdx].op; dstOp = srcOp; }

    var fbSrc = -1, fbDst = -1;
    for (var k = 0; k < nodes.length; k++) {
      if (nodes[k].op === srcOp) fbSrc = k;
      if (nodes[k].op === dstOp) fbDst = k;
    }
    return { nodes: nodes, carriers: carriers, fbSrc: fbSrc, fbDst: fbDst };
  }

  var COMPILED = new Array(32);
  function compiled(i) {
    if (!COMPILED[i]) COMPILED[i] = compileAlgo(i);
    return COMPILED[i];
  }

  /* ============================================================
     三、参数 → 物理量
     ============================================================ */

  /* 电平（0–99）→ 线性振幅。
     0 直接归零：DX7 载波包络 L4=0 就是"没有声音"，若让它走指数映射，
     会在 -74 dB 处留一条收不干净的尾巴。其余按 0.75 dB/级 —— 与 DX7
     输出电平刻度的量级一致。 */
  function levelToAmp(l) {
    if (l <= 0) return 0;
    if (l >= 99) return 1;
    return Math.pow(10, -((99 - l) * 0.75) / 20);
  }

  /* 包络速率（0–99）→ 走完整个电平跨度所需秒数。
     校准点：rate 99 ≈ 5 ms、rate 50 ≈ 0.35 s、rate 0 ≈ 27 s。 */
  function rateFullScaleSeconds(rate) {
    if (rate < 0) rate = 0;
    if (rate > 99) rate = 99;
    return 0.005 * Math.pow(2, (99 - rate) / 8);
  }

  /* 单个包络段的实际时长。DX7 的包络按"电平变化量"计时而非固定时长，
     所以跨度为 0 的段几乎瞬时完成。 */
  function segSeconds(rate, fromLevel, toLevel) {
    var frac = Math.abs(toLevel - fromLevel) / 99;
    return Math.max(0.0015, rateFullScaleSeconds(rate) * frac);
  }

  /* 算子频率比。oscMode 0 = 比率模式；1 = 固定频率模式（1/10/100/1000 Hz）。 */
  function opRatio(o, baseHz) {
    if (o.oscMode) {
      var table = [1, 10, 100, 1000];
      return table[o.freqCoarse & 3] / baseHz;
    }
    var c = o.freqCoarse;
    var ratio = (c === 0 ? 0.5 : c) * (1 + o.freqFine / 100);
    var cents = (o.detune - 7) * 4;                 // 失谐：面板 −7…+7，约 ±4 音分/级
    return ratio * Math.pow(2, cents / 1200);
  }

  function midiToHz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  /* voice.ops 是 packed 顺序：ops[0] = OP6 … ops[5] = OP1 */
  function opByNum(voice, n) { return voice.ops[6 - n]; }

  /* ============================================================
     四、渲染
     ============================================================ */
  var MOD_SCALE = 1.0;   // 满电平调制器造成的相位偏移，单位"圈"
  var HOLD = 9;          // 包络在 L3 上的保持态
  var DEF = { sampleRate: 44100, duration: 1.8, note: 48, gate: 1.1, normalize: true };

  function render(voice, opts) {
    opts = opts || {};
    var sr = opts.sampleRate || DEF.sampleRate;
    var dur = opts.duration || DEF.duration;
    var gate = (opts.gate == null ? DEF.gate : opts.gate);
    var note = (opts.note == null ? DEF.note : opts.note);
    if (gate > dur) gate = dur * 0.95;

    var total = Math.round(sr * dur);
    var out = new Float32Array(total);
    var dt = 1 / sr;

    var plan = compiled(voice.algorithm & 31);
    var nodes = plan.nodes;
    var NN = nodes.length;

    var isCarrier = new Uint8Array(NN);
    for (var c = 0; c < plan.carriers.length; c++) isCarrier[plan.carriers[c]] = 1;

    var baseHz = midiToHz(note);
    var freq = new Float64Array(NN);
    var amp = new Float64Array(NN);
    var phase = new Float64Array(NN);
    var egR = new Array(NN);
    var egL = new Array(NN);

    for (var i = 0; i < NN; i++) {
      var o = opByNum(voice, nodes[i].op);
      freq[i] = baseHz * opRatio(o, baseHz);
      amp[i] = levelToAmp(o.outputLevel);
      egR[i] = o.egR;
      egL[i] = o.egL;
    }

    // —— 包络状态机
    var stage = new Int8Array(NN);
    var level = new Float64Array(NN);      // 当前电平 0–99
    var elapsed = new Float64Array(NN);
    var segFrom = new Float64Array(NN);
    var segTo = new Float64Array(NN);
    var segLen = new Float64Array(NN);

    function enter(q, st) {
      stage[q] = st;
      elapsed[q] = 0;
      segFrom[q] = level[q];
      var idx = st === 3 ? 3 : st;
      segTo[q] = egL[q][idx];
      segLen[q] = segSeconds(egR[q][idx], segFrom[q], segTo[q]);
    }
    for (var q0 = 0; q0 < NN; q0++) { level[q0] = 0; enter(q0, 0); }

    var fbgain = voice.feedback === 0 ? 0 : Math.pow(voice.feedback / 7, 2);
    var prevOut = new Float64Array(NN);
    var curOut = new Float64Array(NN);
    var gateSamples = Math.round(gate * sr);

    for (var k = 0; k < total; k++) {
      var keyOn = k < gateSamples;
      var sum = 0;

      for (var q = 0; q < NN; q++) {
        /* --- 包络 --- */
        if (!keyOn && stage[q] !== 3 && stage[q] !== HOLD + 3) enter(q, 3);
        if (stage[q] !== HOLD && !(stage[q] === 3 && elapsed[q] >= segLen[q])) {
          elapsed[q] += dt;
          if (elapsed[q] >= segLen[q]) {
            level[q] = segTo[q];
            if (stage[q] < 2) enter(q, stage[q] + 1);
            else if (stage[q] === 2) { stage[q] = HOLD; elapsed[q] = 0; }
            // stage 3 走完即停在 L4，不再推进
          } else {
            level[q] = segFrom[q] + (segTo[q] - segFrom[q]) * (elapsed[q] / segLen[q]);
          }
        }

        /* --- 相位与输出 --- */
        var modPhase = 0;
        var srcs = nodes[q].srcs;
        for (var s = 0; s < srcs.length; s++) modPhase += curOut[srcs[s]];
        if (q === plan.fbDst && fbgain > 0) modPhase += fbgain * prevOut[plan.fbSrc];

        phase[q] += freq[q] * dt;
        if (phase[q] >= 1) phase[q] -= Math.floor(phase[q]);
        else if (phase[q] < 0) phase[q] -= Math.floor(phase[q]);

        var v = Math.sin(TAU * (phase[q] + modPhase * MOD_SCALE)) * amp[q] * levelToAmp(level[q]);
        curOut[q] = v;
        if (isCarrier[q]) sum += v;
      }

      for (var r = 0; r < NN; r++) prevOut[r] = curOut[r];
      out[k] = sum;
    }

    if (opts.normalize !== false) normalize(out, 0.85, 20, sr);
    return out;
  }

  /* 峰值归一化 + 首尾短淡入淡出（避免点击声）。
     增益封顶：极安静的包络不该被抬成噪声。 */
  function normalize(buf, target, maxGain, sr) {
    var peak = 0;
    for (var i = 0; i < buf.length; i++) { var a = Math.abs(buf[i]); if (a > peak) peak = a; }
    if (peak <= 1e-9) return buf;
    var g = Math.min(target / peak, maxGain);
    for (var j = 0; j < buf.length; j++) buf[j] *= g;
    var f = Math.min(Math.round(sr * 0.003), Math.floor(buf.length / 4));
    for (var k = 0; k < f; k++) {
      buf[k] *= k / f;
      buf[buf.length - 1 - k] *= k / f;
    }
    return buf;
  }

  /* ============================================================
     五、WAV 导出（16 bit 单声道 PCM）
     ============================================================ */
  function encodeWav(buf, sampleRate) {
    var n = buf.length;
    var bytes = new Uint8Array(44 + n * 2);
    var view = new DataView(bytes.buffer);
    function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, buf[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return bytes;
  }

  return {
    TAU: TAU,
    ALGOS: ALGOS,
    FB_OVERRIDE: FB_OVERRIDE,
    compileAlgo: compileAlgo,
    compiled: compiled,
    levelToAmp: levelToAmp,
    rateFullScaleSeconds: rateFullScaleSeconds,
    segSeconds: segSeconds,
    opRatio: opRatio,
    midiToHz: midiToHz,
    render: render,
    normalize: normalize,
    encodeWav: encodeWav,
  };
});
