/* ============================================================================
   FM-1 音色台 · 意图层
   ----------------------------------------------------------------------------
   把"一句人话"变成"一组具体的参数改动"。它自己不合成声音、不认识字节，
   只做一件事：语言 ←→ 参数 之间的映射。

   为什么单独一层：这一层可以被替换。现在是本地词典（离线、不花钱），
   接大模型时产出的仍然是同一个格式 —— 上层代码一行都不用改。
   判断"改得对不对"也不靠读代码，靠 tools/intent_test.mjs 里的实测断言：
   说了「更亮」之后，渲染出来的频谱重心必须真的往上走。

   浏览器（<script src> → window.FM1_INTENT）与 Node 共用同一份。
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dx7.js'), require('./fm.js'));
  } else {
    root.FM1_INTENT = factory(root.DX7, root.FM_ENGINE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DX7, FM) {
  'use strict';

  /* ============================================================
     一、可以调的轴
     ------------------------------------------------------------
     每个轴都是"相对当前音色往哪边挪"，不是绝对值 —— 因为这一层的
     设计前提是"以现有音色为锚点"。锚点让改动小、可解释、可撤销。
     ============================================================ */
  var AXES = [
    { key: 'bright',   label: '亮度',   up: '更亮',     down: '更暗' },
    { key: 'sustain',  label: '延音',   up: '尾巴更长', down: '尾巴更短' },
    { key: 'attack',   label: '起音',   up: '起音更慢', down: '起音更快' },
    { key: 'width',    label: '厚度',   up: '更厚更宽', down: '更薄更紧' },
    { key: 'feedback', label: '尖锐度', up: '更尖锐',   down: '更干净' },
  ];

  /* 强度 1.0 时各轴的改动量。这些数字不是拍脑袋来的 ——
     它们是 intent_test.mjs 里"方向正确 + 幅度可感知 + 不炸"三条断言
     一起约束出来的。改这里之前先去看那几条断言。 */
  var TUNE = {
    bright:   { gainPerUnit: 2.2 },   // 强度 1.0 → 调制深度 ×2^2.2 ≈ 4.6 倍
    sustain:  { scale: 24 },
    attack:   { scale: 18 },
    width:    { scale: 3 },
    feedback: { scale: 2 },
  };

  /* ============================================================
     二、本地方言词典
     ------------------------------------------------------------
     长词优先匹配、且匹配过的字不再被短词重复吃掉 —— 否则「明亮」会被
     「亮」先占掉、「柔和起音」会被「柔和」占掉，方向和强度都会错。
     同一个词只放在一个轴里；造成歧义的词（如「尖锐」既像亮度又像啸叫）
     按它在这台引擎里更主要的听感归位。
     ============================================================ */
  var LEX = [
    /* 亮度 ↑：提高调制器电平 → 调制指数变大 → 谐波变多 */
    { axis: 'bright', dir: +1, w: ['明亮', '清亮', '清脆', '通透', '清澈', '透亮',
        '明快', '锐利', '尖锐', '金属', '亮', 'brighter', 'bright', 'crisp'] },
    { axis: 'bright', dir: -1, w: ['低沉', '浑厚', '温润', '温和', '柔和', '圆润',
        '温暖', '暗淡', '发闷', '闷', '暗', '糊', 'darker', 'dark', 'mellow', 'warm'] },
    /* 延音 ↑：放慢载波包络的衰减与释放 */
    { axis: 'sustain', dir: +1, w: ['尾巴长', '尾巴更长', '余音', '残响', '延音',
        '拖长', '拖尾', '悠长', '绵长', '回荡', '长一点', '长些', '持续',
        'longer', 'sustain'] },
    { axis: 'sustain', dir: -1, w: ['尾巴短', '尾巴更短', '干脆', '颗粒', '点状',
        '短促', '急促', '利落', '短一点', '短些', '断音', 'shorter', 'staccato', 'pluck'] },
    /* 起音 ↑：放慢起音段 */
    { axis: 'attack', dir: +1, w: ['起音慢', '起音更慢', '渐入', '淡入', '慢慢起',
        '缓起', '软起音', '柔和起音', 'slower attack', 'soft attack'] },
    { axis: 'attack', dir: -1, w: ['起音快', '起音更快', '硬起音', '立即', '瞬间',
        'faster attack', 'hard attack'] },
    /* 厚度 ↑：把调制器之间的失谐拉开 */
    { axis: 'width', dir: +1, w: ['厚一点', '更厚', '饱满', '丰富', '宽', '厚', '肥',
        '合唱', '合奏', '失谐', 'wide', 'thick', 'chorus'] },
    { axis: 'width', dir: -1, w: ['更薄', '薄一点', '单薄', '薄', '窄', '细', '紧',
        'thin', 'narrow', 'tight'] },
    /* 尖锐度 ↑：全局反馈 */
    { axis: 'feedback', dir: +1, w: ['啸叫', '嘶', '沙哑', '粗糙', '狂躁',
        'noisy', 'harsh'] },
    { axis: 'feedback', dir: -1, w: ['干净', '纯净', '平滑', '圆滑', 'smooth', 'clean'] },
  ];

  var DEGREE_LOW = /稍稍|稍微|略微|略|一点点|一点|一些|些许|有些|有点|a bit|slightly/;
  var DEGREE_HIGH = /非常|特别|极其|极|超级|十分|相当|太|很|much|very|extremely/;
  var NEGATION = /不|别|没/;

  /* 程度词决定强度。默认 0.5 —— 不说程度的时候，改动应该是"听得出来但不夸张"。 */
  function degreeOf(text) {
    if (DEGREE_LOW.test(text)) return 0.3;
    if (DEGREE_HIGH.test(text)) return 0.9;
    return 0.5;
  }

  /* ============================================================
     三、把一句话解析成意图
     ============================================================ */
  function parseLocal(text) {
    var raw = String(text == null ? '' : text);
    var t = raw.toLowerCase();

    var flat = [];
    for (var i = 0; i < LEX.length; i++)
      for (var j = 0; j < LEX[i].w.length; j++)
        flat.push({ axis: LEX[i].axis, dir: LEX[i].dir, word: LEX[i].w[j] });
    flat.sort(function (a, b) { return b.word.length - a.word.length; });

    var taken = new Uint8Array(t.length);
    var hits = [];
    for (var f = 0; f < flat.length; f++) {
      var word = flat[f].word, from = 0, at;
      while ((at = t.indexOf(word, from)) >= 0) {
        var free = true;
        for (var k = at; k < at + word.length; k++) if (taken[k]) { free = false; break; }
        if (free) {
          for (var k2 = at; k2 < at + word.length; k2++) taken[k2] = 1;
          var pre = t.slice(Math.max(0, at - 3), at);
          var neg = NEGATION.test(pre);
          hits.push({
            axis: flat[f].axis, word: word, at: at, negated: neg,
            dir: neg ? -flat[f].dir : flat[f].dir,
          });
        }
        from = at + 1;
      }
    }

    /* 同一个轴被多个词命中时按票数决方向；正负打平就当没说，
       不要让它随机倒向一边。 */
    var acc = {}, order = [];
    hits.forEach(function (h) {
      if (!acc[h.axis]) { acc[h.axis] = { score: 0, words: [], neg: false }; order.push(h.axis); }
      acc[h.axis].score += h.dir;
      acc[h.axis].words.push(h.word);
      if (h.negated) acc[h.axis].neg = true;
    });

    var base = degreeOf(t);
    var axes = {}, matched = [];
    order.forEach(function (key) {
      var a = acc[key];
      if (a.score === 0) return;
      var dir = a.score > 0 ? 1 : -1;
      axes[key] = dir * (a.neg ? 0.4 : base);
      matched.push({ axis: key, dir: dir, words: a.words.join('+') });
    });

    var reason = '';
    if (!hits.length) reason = '没有认出可以调整的词';
    else if (!matched.length) reason = '认出的词方向互相抵消，不确定你想往哪边调';

    return {
      ok: matched.length > 0,
      text: raw,
      axes: axes,
      hits: hits.map(function (h) { return h.word; }),
      matched: matched,
      strength: base,
      reason: reason,
    };
  }

  /* 把意图压成一行，给界面显示 */
  function describeIntent(intent) {
    if (!intent || !intent.axes) return '';
    var parts = [];
    AXES.forEach(function (a) {
      var v = intent.axes[a.key];
      if (!v) return;
      parts.push((v > 0 ? a.up : a.down) + '（' + Math.abs(v).toFixed(1) + '）');
    });
    return parts.join(' · ');
  }

  /* ============================================================
     四、把意图落到具体参数
     ============================================================ */
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /* 电平和振幅的互转。
     FM 引擎里 levelToAmp 是**指数**映射（约 0.75 dB/级），所以"提高 N 级"
     在不同电平上的实际响度差得很远：电平 0→18 几乎等于没变（振幅 0 → 0.0004），
     而 60→78 是振幅翻了两倍多。按级数线性加法是错的 —— 这是实测发现的：
     INIT SINE 的调制器电平本来是 0，加 18 级之后频谱重心一动不动。
     所以要按振幅算，再折算回电平。 */
  function ampOf(level) { return FM.levelToAmp(level); }
  function levelOf(amp) {
    if (!(amp > 0)) return 0;
    if (amp >= 1) return 99;
    return Math.round(clamp(99 + 20 * Math.log(amp) / (Math.LN10 * 0.75), 0, 99));
  }

  /* 调制深度低于这个量级基本听不出来。"更亮"至少要跨过它，
     否则用户说完"亮一点"听不出区别，这个功能就废了。 */
  var MIN_DEPTH = 0.12;

  function opByNum(v, n) {
    for (var i = 0; i < v.ops.length; i++) if (v.ops[i].num === n) return v.ops[i];
    return null;
  }

  function deepClone(v) {
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = v[k];
    o.ops = v.ops.map(function (x) {
      var y = {};
      for (var k2 in x) if (Object.prototype.hasOwnProperty.call(x, k2)) y[k2] = x[k2];
      y.egR = x.egR.slice();
      y.egL = x.egL.slice();
      return y;
    });
    o.pitchEgR = v.pitchEgR.slice();
    o.pitchEgL = v.pitchEgL.slice();
    return o;
  }

  /* 返回 { voice, changes, warnings }。
     voice 是**新对象**，原音色一个字节都不动 —— 这样"撤销"就是丢弃结果，
     不需要反向推算。changes 是给人看的改动清单，它必须和实际改动一致：
     UI 上显示改了什么、设备里就该是什么，两处对不上就是骗人。 */
  function applyIntent(voice, intent) {
    if (!voice || !voice.ops) throw new Error('applyIntent 需要一个已解码的音色对象');
    var axes = (intent && intent.axes) || {};
    var out = deepClone(voice);
    var changes = [], warnings = [];
    var carriers = DX7.describe(voice, FM).carriers;
    var isMod = function (o) { return carriers.indexOf(o.num) < 0; };

    /* delta 是这条改动的"幅度"，一个纯数字。
       为什么要它：from/to 有时是给人看的字符串（包络是三段一起改，
       写成 "62/96/92"），拿去做数值比较会得到 NaN —— 实测踩过。
       有了 delta，界面、测试、以后要做的"改动强度"排序都读同一个数。 */
    function push(axis, what, from, to, delta) {
      if (delta == null)
        delta = (typeof from === 'number' && typeof to === 'number') ? Math.abs(to - from) : 0;
      if (!(delta >= 0)) throw new Error('改动幅度必须是有限数，收到 ' + delta);
      changes.push({
        axis: axis, what: what, from: from, to: to, delta: delta,
        text: what + '　' + from + ' → ' + to,
      });
    }

    /* 亮度 —— 目标是提高"有效调制深度"。
       调制深度 = 输出电平的振幅 × 包络在该段的振幅。两者是同一个指数映射，
       所以能互相补偿。只提高输出电平并不够用：BRASS 1 的调制器包络电平只有 48，
       输出电平从 84 提到 99，实际调制深度只从 0.005 涨到 0.012，
       频谱重心稳稳停在 271 Hz 一动不动。所以输出电平撞到 99 之后，
       还要继续抬调制器的包络段（L1–L3）—— 否则改动会被包络乘没了。
       L4 不动：那是释放电平，动它会改掉音色的收尾。 */
    if (axes.bright) {
      var sgn = axes.bright > 0 ? 1 : -1;
      var gain = Math.pow(2, Math.abs(axes.bright) * TUNE.bright.gainPerUnit);
      var moved = 0, stuck = 0, egTouched = [];
      out.ops.forEach(function (o) {
        if (!isMod(o)) return;
        var peakEg = Math.max(ampOf(o.egL[0]), ampOf(o.egL[1]), ampOf(o.egL[2]));
        if (!(peakEg > 0)) { stuck++; return; }
        var eff = ampOf(o.outputLevel) * peakEg;
        var goal = sgn > 0 ? Math.max(eff * gain, MIN_DEPTH * axes.bright) : eff / gain;
        var need = goal / peakEg;

        if (need <= 1) {
          var lv = levelOf(need);
          if (lv === o.outputLevel) { stuck++; return; }
          push('bright', 'OP' + o.num + ' 输出电平（调制器）', o.outputLevel, lv);
          o.outputLevel = lv;
          moved++;
          return;
        }
        /* 电平撞顶也不够 → 必须抬包络，否则再怎么加电平都听不出来 */
        var want = levelOf(goal);
        var egFrom = o.egL.slice(0, 3).join('/');
        var egDelta = 0, changed = false;
        for (var i = 0; i < 3; i++) if (o.egL[i] < want) { egDelta += want - o.egL[i]; o.egL[i] = want; changed = true; }
        if (o.outputLevel < 99) {
          push('bright', 'OP' + o.num + ' 输出电平（调制器）', o.outputLevel, 99);
          o.outputLevel = 99;
          moved++;
        }
        if (changed) {
          push('bright', 'OP' + o.num + ' 包络电平 L1–L3（调制器）', egFrom, o.egL.slice(0, 3).join('/'), egDelta);
          egTouched.push('OP' + o.num);
          moved++;
        } else if (o.outputLevel >= 99) {
          /* 电平和包络都已经顶到 99 —— 这个算子再也亮不上去了。
             必须记一笔，否则整块改完 moved=0 却不知道为什么。 */
          stuck++;
        }
      });
      if (egTouched.length)
        warnings.push(egTouched.join('、') + ' 的调制被包络压得很低，为了让它真的听得出"更亮"，'
          + '同时抬高了调制器的包络电平 —— 这个音色的明暗变化会比原来平缓一些');
      if (!moved && stuck)
        warnings.push('这个音色的调制器输出电平和包络都已经' + (sgn > 0 ? '顶到 99' : '降到 0')
          + '（或本来就静音），没法再' + (sgn > 0 ? '亮' : '暗') + '了');
      if (carriers.length === 6)
        warnings.push('这个算法是 6 个载波、没有调制器，调不了亮度');
    }

    /* 延音 —— 载波包络的 R2（衰减）与 R4（释放）。rate 越小越慢、尾巴越长。 */
    if (axes.sustain) {
      var ds = Math.round(axes.sustain * TUNE.sustain.scale);
      carriers.forEach(function (num) {
        var o = opByNum(out, num);
        [1, 3].forEach(function (k) {
          var to = clamp(o.egR[k] - ds, 0, 99);
          if (to === o.egR[k]) return;
          push('sustain', 'OP' + num + ' 包络 R' + (k + 1) + (k === 1 ? '（衰减）' : '（释放）'), o.egR[k], to);
          o.egR[k] = to;
        });
      });
    }

    /* 起音 —— 载波包络的 R1 */
    if (axes.attack) {
      var da = Math.round(axes.attack * TUNE.attack.scale);
      carriers.forEach(function (num) {
        var o = opByNum(out, num);
        var to = clamp(o.egR[0] - da, 0, 99);
        if (to === o.egR[0]) return;
        push('attack', 'OP' + num + ' 包络 R1（起音）', o.egR[0], to);
        o.egR[0] = to;
      });
    }

    /* 厚度 —— 把调制器之间的失谐朝相反方向拉开（一个偏高、一个偏低）。
       只动调制器：动载波失谐会跑调。detune 存的是 0–15，面板显示减 7。 */
    if (axes.width) {
      var dw = Math.round(axes.width * TUNE.width.scale);
      var mods = out.ops.filter(isMod);
      mods.forEach(function (o, i) {
        var sign = (i % 2 === 0) ? 1 : -1;
        var to = clamp(o.detune + sign * dw, 0, 15);
        if (to === o.detune) return;
        push('width', 'OP' + o.num + ' 失谐（调制器）', o.detune - 7, to - 7);
        o.detune = to;
      });
      if (mods.length < 2)
        warnings.push('这个算法只有 ' + mods.length + ' 个调制器，拉开失谐的效果有限');
    }

    /* 尖锐度 —— 全局反馈 */
    if (axes.feedback) {
      var df = Math.round(axes.feedback * TUNE.feedback.scale);
      var tof = clamp(out.feedback + df, 0, 7);
      if (tof === out.feedback)
        warnings.push('全局反馈已经' + (df > 0 ? '到 7（最大）' : '到 0（最小）') + '了');
      else { push('feedback', '全局反馈', out.feedback, tof); out.feedback = tof; }
    }

    /* 改完顺手把字节重算一遍：raw 和字段从此永远一致，
       不存在"字段改了、raw 还是旧的"这种半更新状态。
       越界会在这里被 encodeVoice 直接抛错，不会静默写出错字节。 */
    out.raw = DX7.encodeVoice(out);

    if (!changes.length && !warnings.length) warnings.push('这句话没有产生任何改动');

    return { voice: out, changes: changes, warnings: warnings };
  }

  return {
    AXES: AXES, LEX: LEX, TUNE: TUNE,
    degreeOf: degreeOf,
    parseLocal: parseLocal,
    describeIntent: describeIntent,
    applyIntent: applyIntent,
  };
});
