/* ============================================================================
   FM-1 音色台 · 大模型接入层
   ----------------------------------------------------------------------------
   把"一句人话"变成意图对象 —— 和 engine/intent.js 里的本地词典产出的是
   **同一个格式**。所以上层（index.html）不需要知道这次是谁干的。

   这个文件里最重要的一条设计边界：

       大模型碰不到任何字节。

   它只能说「亮度 +0.7」这种话；至于该动哪个算子的哪个参数、动多少、
   会不会越界，全部由 engine/intent.js 里那份确定性映射算 —— 那份映射
   被 tools/intent_test.mjs 的实测断言盯着（说"更亮"之后频谱重心必须真的
   往上走）。所以模型就算胡说八道，最坏的结果也只是"没改动"或"方向不对"，
   它没有能力写出一个坏掉的音色。

   为什么要在浏览器里直连、不经服务器：
     - 这个项目"零依赖、零构建、双击就能跑"。加一个后端等于把这三条全废掉。
     - 实测（2026-10-15）DeepSeek、智谱的接口会回显请求的 Origin，
       连 Origin: null（也就是双击打开的 file:// 页面）都放行，
       预检 OPTIONS 也认 content-type + authorization。所以能直连。
     - Key 只存在用户自己这台机器的 localStorage 里，只发给用户自己填的那个地址。

   浏览器（<script src> → window.FM1_LLM）与 Node 共用同一份。
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./intent.js'), require('./dx7.js'), require('./fm.js'));
  } else {
    root.FM1_LLM = factory(root.FM1_INTENT, root.DX7, root.FM_ENGINE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (INTENT, DX7, FM) {
  'use strict';

  /* ============================================================
     一、可选的服务商
     ------------------------------------------------------------
     "url" 一律是 OpenAI 兼容接口的**基地址**（不带 /chat/completions）。
     换一家只要改这一个字段 + 模型名，别的代码不用动。
     实测结论写在 note 里，来源是 2026-10-15 用 curl 打 CORS 头。
     ============================================================ */
  var PROVIDERS = [
    {
      id: 'deepseek', label: 'DeepSeek（深度求索）',
      url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
      keyUrl: 'https://platform.deepseek.com/api_keys', needsKey: true,
      note: '国内直连。实测会用 Origin: null 应答，所以双击打开的页面也能直接调。',
    },
    {
      id: 'zhipu', label: '智谱 GLM',
      url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
      keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', needsKey: true,
      note: '国内直连。实测预检放行 content-type / authorization，Origin: null 可用。',
    },
    {
      id: 'moonshot', label: 'Kimi（月之暗面）',
      url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
      keyUrl: 'https://platform.moonshot.cn/console/api-keys', needsKey: true,
      note: '国内直连。实测会回 Access-Control-Allow-Origin: null。',
    },
    {
      id: 'openrouter', label: 'OpenRouter（聚合，可选各种模型）',
      url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini',
      keyUrl: 'https://openrouter.ai/keys', needsKey: true,
      note: '实测返回 Access-Control-Allow-Origin: *，从哪都能调。',
    },
    {
      id: 'ollama', label: '本机 Ollama（完全免费，不联网）',
      url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b',
      keyUrl: 'https://ollama.com/download', needsKey: false, jsonMode: false,
      note: '要先装 Ollama 并 pull 一个模型。若被来源检查挡住，'
        + '把环境变量 OLLAMA_ORIGINS 设成 * 再重启 Ollama。'
        + '（用 tools/serve.cmd 起本机地址时通常不用设。）',
    },
    {
      id: 'custom', label: '自定义（任何 OpenAI 兼容接口）',
      url: '', model: '', keyUrl: '', needsKey: true,
      note: '填基地址，例如 https://某地址/v1。会请求 <基地址>/chat/completions。',
    },
  ];

  function providerById(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return PROVIDERS[0];
  }

  /* ============================================================
     二、系统提示词
     ------------------------------------------------------------
     三条硬规则是这个提示词的骨架：
       ① 说的是**相对变化**，不是绝对值；
       ② 只在该音色**真的可调**的轴上给建议（可调性是本地实测算出来的，
          不是让模型猜 —— 模型不懂 FM，让它猜会给你一个改不动的建议）；
       ③ 表达不了就老实说做不到，**不要硬凑**。
     ============================================================ */
  var SYSTEM_PROMPT = [
    '你是一台 FM 合成器（Yamaha DX7 架构，M-VAVE FM-1 用的引擎）的音色参谋。',
    '用户会给你【当前音色的结构】和【一句想要的效果】，你要把那句话翻译成',
    '对若干"音色轴"的微调建议。',
    '',
    '── 可以调的轴（只有这五个，不要发明新的）──',
    'bright   亮度：正 = 更亮、更清脆、更金属、谐波更多；负 = 更暗、更闷、更柔和、更温暖',
    'sustain  延音：正 = 尾巴更长、余音更久、更绵长；负 = 更短促、更干脆、颗粒感、点状',
    'attack   起音：正 = 起音更慢、渐入、更软；负 = 起音更快、更硬、更瞬间',
    'width    厚度：正 = 更厚、更宽、更饱满（靠失谐做出合唱/合奏感）；负 = 更薄、更紧、更单薄',
    'feedback 尖锐度：正 = 更沙哑、更粗糙、带啸叫；负 = 更干净、更平滑',
    '',
    '── 强度取值范围 -1.0 到 +1.0 ──',
    '0.3 约等于「一点点」「稍微」「稍」',
    '0.5 约等于用户没说程度',
    '0.9 约等于「非常」「特别」「极其」',
    '只写你要动的轴，不用写取 0 的轴。',
    '',
    '── 三条硬规则 ──',
    '1. 用户说的是**相对当前音色的变化**，不是绝对值。所以「亮一点」应该是 bright: 0.3，',
    '   而不是 bright: 1。这是最容易搞错的一点。',
    '2. 用户会告诉你这台音色上哪些轴**真的可调**。只在可调的轴里给建议。',
    '   给一个调不动的轴等于白说一句。如果用户想要的正好落在一个调不动的轴上，',
    '   要么改用最接近的可调轴（并在 reason 里说明你换成了什么），要么 ok 设成 false。',
    '3. 如果用户要的东西这五个轴根本表达不了（例如换一件乐器、改音高、加混响或延迟、',
    '   改律动、单纯要求变响或变轻、要求具体的波形或具体数值），**不要硬凑**：',
    '   把 ok 设成 false，在 reason 里用一句中文说清为什么做不到，并指出这五个轴里',
    '   最接近的能做什么。',
    '',
    '── 输出格式 ──',
    '只输出一个 JSON 对象。不要解释文字，不要 markdown 代码块，不要注释。',
    '{"ok":true,"axes":{"bright":0.4},"reason":"用一句中文说你改了什么","confidence":0.8}',
    '做不到时：{"ok":false,"axes":{},"reason":"一句中文说明为什么","confidence":0.6}',
  ].join('\n');

  /* 轴的中文名，给提示词与界面共用 */
  function axisLabel(key) {
    var a = INTENT.AXES;
    for (var i = 0; i < a.length; i++) if (a[i].key === key) return a[i].label;
    return key;
  }

  /* ============================================================
     三、这台音色上哪些轴真的能动
     ------------------------------------------------------------
     不让模型猜。做法是拿一个探针意图（该轴 +1.0）跑一遍**已经过测试的**
     applyIntent，看它有没有产出任何改动。这样算出来的"可调性"和真正
     应用时的行为必然一致 —— 两处用同一份代码，不会漂移。
     ============================================================ */
  function adjustable(voice) {
    var out = {};
    if (!voice || !voice.ops) return out;
    INTENT.AXES.forEach(function (a) {
      var probe = {};
      probe[a.key] = 1;
      var r;
      try { r = INTENT.applyIntent(voice, { ok: true, axes: probe }); }
      catch (e) { out[a.key] = false; return; }
      out[a.key] = r.changes.some(function (c) { return c.axis === a.key; });
    });
    return out;
  }

  /* ============================================================
     四、拼提示词
     ============================================================ */
  function buildMessages(text, voice) {
    var lines = [];
    lines.push('【当前音色】' + (voice && voice.name ? voice.name : '（未命名）'));

    if (voice && voice.ops && DX7 && FM) {
      var d = DX7.describe(voice, FM);
      lines.push('算法编号：' + d.algorithmPanel + '（共 32 种）');
      lines.push('结构：载波 ' + d.carrierCount + ' 个 / 调制器 ' + d.modulatorCount + ' 个');
      if (d.modulatorCount === 0)
        lines.push('注意：这个算法没有调制器，亮度在这台音色上无从调起。');

      var can = adjustable(voice), yes = [], no = [];
      INTENT.AXES.forEach(function (a) {
        (can[a.key] ? yes : no).push(a.label + '（' + a.key + '）');
      });
      lines.push('');
      lines.push('【这台音色上可调的轴】' + (yes.length ? yes.join('、') : '（一个都没有）'));
      lines.push('【这台音色上调不动的轴】' + (no.length ? no.join('、') : '（无）'));
    }

    lines.push('');
    lines.push('【用户想要】' + String(text == null ? '' : text));

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ];
  }

  /* ============================================================
     五、拼请求
     ============================================================ */
  function joinUrl(base, tail) {
    var b = String(base || '').replace(/\/+$/, '');
    if (!b) return '';
    return b + tail;
  }

  function buildRequest(o) {
    var p = o.provider;
    var body = {
      model: o.model || p.model,
      messages: buildMessages(o.text, o.voice),
      temperature: 0.2,          /* 要的是可复现，不是创意 */
      max_tokens: 400,
      stream: false,
    };
    if (p.jsonMode !== false) body.response_format = { type: 'json_object' };

    var headers = { 'Content-Type': 'application/json' };
    if (o.apiKey) headers['Authorization'] = 'Bearer ' + o.apiKey;

    return {
      url: joinUrl(p.url, '/chat/completions'),
      init: { method: 'POST', headers: headers, body: JSON.stringify(body) },
      body: body,
    };
  }

  /* ============================================================
     六、把模型的回答变成意图
     ------------------------------------------------------------
     模型不听话是常态，所以这里是"宽进严出"：
     接受代码块、接受多说的客套话、接受 axes 嵌套或平铺、接受数组、
     接受字符串数字、接受 0–100 的百分比刻度。
     但对**出口**很严：只允许五个已知的轴、只允许 -1..1，
     越界多少、丢掉了什么，全部记进 notes 如实报出来 —— 不静默截断。
     ============================================================ */
  var ALIAS = {
    bright: 'bright', brightness: 'bright', tone: 'bright', timbre: 'bright',
    harmonic: 'bright', harmonics: 'bright', brightness_level: 'bright', 亮度: 'bright',
    sustain: 'sustain', decay: 'sustain', release: 'sustain', tail: 'sustain',
    length: 'sustain', 延音: 'sustain', 余音: 'sustain',
    attack: 'attack', rise: 'attack', onset: 'attack', 起音: 'attack', 起音时间: 'attack',
    width: 'width', thickness: 'width', detune: 'width', chorus: 'width',
    spread: 'width', 厚度: 'width', 宽度: 'width',
    feedback: 'feedback', sharpness: 'feedback', harshness: 'feedback',
    noise: 'feedback', grit: 'feedback', 尖锐度: 'feedback', 反馈: 'feedback',
  };

  /* 轴名归一。模型给的名字五花八门，所以这里层层放宽：
     ① 完全一致  ② 忽略下划线/大小写  ③ 按下划线拆段找
     ④ 最后才在整串里找有没有一个够长的已知名字。
     放宽到这个程度是可以的 —— 因为认错了轴的代价只是"改的地方不对"，
     而认不出轴的代价是"整句话白说"，后者更贵。 */
  function canonicalAxis(name) {
    if (name == null) return null;
    var k = String(name).trim().toLowerCase().replace(/[\s_\-]+/g, '_');
    if (!k) return null;
    if (ALIAS[k]) return ALIAS[k];

    var bare = k.replace(/_/g, ''), key;
    for (key in ALIAS)
      if (Object.prototype.hasOwnProperty.call(ALIAS, key) && key.replace(/_/g, '') === bare)
        return ALIAS[key];

    var seg = k.split('_');
    for (var i = 0; i < seg.length; i++) if (ALIAS[seg[i]]) return ALIAS[seg[i]];

    var best = null, bestLen = 4;
    for (key in ALIAS) {
      if (!Object.prototype.hasOwnProperty.call(ALIAS, key)) continue;
      if (key.length > bestLen && k.indexOf(key) >= 0) { best = ALIAS[key]; bestLen = key.length; }
    }
    return best;
  }

  /* 从一段可能夹着废话的文本里找出所有的 JSON 对象片段。
     做法是拿每个 { 当起点向前配对 —— 而不是只从头找一次。
     为什么要这么麻烦：模型经常先举一个例子再给答案，比如
     「举个例子 {不是 JSON} 我的建议是 {"axes":…}」。只找第一个配平的
     括号会取到那个例子。从每个 { 都试一遍，就能把真正的答案也捞出来。

     字符串里的花括号要跳过，否则 {"reason":"用 {括号} 说明"} 会被切错。 */
  function jsonCandidates(s) {
    var out = [];
    var limit = Math.min(s.length, 8000);
    for (var i = 0; i < limit && out.length < 100; i++) {
      if (s.charAt(i) !== '{') continue;
      var depth = 0, inStr = false, esc = false;
      for (var j = i; j < limit; j++) {
        var c = s.charAt(j);
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { out.push(s.slice(i, j + 1)); break; }
        }
      }
    }
    return out;
  }

  /* 这一段像不像我们想要的那种回答：要么有 axes，要么带一个认得的轴名。
     拿它当"优先选哪个片段"的依据 —— 免得选中模型随手举的例子。 */
  function looksLikeIntent(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (v.axes !== undefined) return true;
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && canonicalAxis(k)) return true;
    return false;
  }

  function extractJson(text) {
    var s = String(text == null ? '' : text);

    /* 去掉 ```json … ``` 围栏。有围栏时以围栏里的内容为准 ——
       那是模型明确标记的"这是代码"，比围栏外的解释可信。 */
    var fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1];

    var cands = jsonCandidates(s);
    var firstObject = null;
    for (var i = 0; i < cands.length; i++) {
      var v;
      try { v = JSON.parse(cands[i]); } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      if (!firstObject) firstObject = cands[i];
      if (looksLikeIntent(v)) return cands[i];
    }
    return firstObject;
  }

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      var m = v.replace(/[＋+]/g, '+').replace(/[－—–]/g, '-').match(/-?\d+(\.\d+)?/);
      if (!m) return null;
      var n = parseFloat(m[0]);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  /* 把各种形态的"轴 → 值"收集成一张平表 */
  function collectPairs(obj, out) {
    out = out || [];
    if (!obj || typeof obj !== 'object') return out;

    if (Array.isArray(obj)) {
      obj.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var name = item.axis != null ? item.axis : (item.key != null ? item.key
          : (item.name != null ? item.name : item.轴));
        var val = item.value != null ? item.value : (item.amount != null ? item.amount
          : (item.strength != null ? item.strength : (item.delta != null ? item.delta : item.值)));
        if (name != null && val != null) out.push([name, val]);
      });
      return out;
    }

    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        /* {"axes":{…}} / {"调整":{…}} 这类包一层的情况，但要小心别把
           {"bright":{"value":0.5}} 也当成包一层 */
        var inner = collectPairs(v, []);
        if (inner.length) { out = out.concat(inner); continue; }
      }
      out.push([k, v]);
    }
    return out;
  }

  var MAX_ABS = 1;

  function parseModelOutput(raw) {
    /* malformed 这个词很要紧：它区分了两种完全不同的失败 ——
       "我没看懂模型的回答"（可以退回本地词典兜住，用户不该受影响）
       和 "模型看懂了但说做不到"（那是它的答案，必须尊重，不能拿本地词典去硬凑）。 */
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return {
      ok: false, axes: {}, malformed: true,
      reason: '模型返回了空内容', notes: ['返回为空'],
    };

    var jsonText = extractJson(text);
    if (!jsonText) {
      return {
        ok: false, axes: {}, malformed: true,
        reason: '模型的回答里没有找到 JSON',
        notes: ['原始返回（截断 200 字）：' + text.slice(0, 200)],
      };
    }

    var obj;
    try { obj = JSON.parse(jsonText); }
    catch (e) {
      return {
        ok: false, axes: {}, malformed: true,
        reason: '模型的回答不是合法 JSON',
        notes: ['解析失败：' + e.message, '原始片段：' + jsonText.slice(0, 200)],
      };
    }

    var notes = [];
    var src = (obj && typeof obj === 'object' && obj.axes && typeof obj.axes === 'object')
      ? obj.axes : obj;
    var pairs = collectPairs(src, []);

    /* 刻度识别。我们让模型给 -1..1，但模型很爱自作主张：
       要么按 0–100 的百分比给，要么按 1–10 打评分。
       这里**逐个值**判断而不是按整批的最大值统一换算 —— 统一换算会出事：
       {"bright":0.5,"sustain":80} 的最大值是 80，一刀切成百分制之后
       那个本来正确的 0.5 会被压成 0.005 然后被丢掉。
       判断过了就记一笔，不静默改数。 */
    var rescaled = 0;
    var nums = [];
    pairs.forEach(function (p) {
      var n = toNumber(p[1]);
      if (n === null) return;
      var a = Math.abs(n), s = 1;
      if (a > 1 && a <= 10) { s = 1 / 10; rescaled++; }
      else if (a > 10) { s = 1 / 100; rescaled++; }
      nums.push([p[0], n * s]);
    });
    if (rescaled)
      notes.push('有 ' + rescaled + ' 个值不在 -1..1 里，按"1–10 评分 / 0–100 百分比"'
        + '换算过（请核对改动幅度是否是你想要的）');

    var axes = {}, unknown = [], dropped = 0;
    nums.forEach(function (p) {
      var key = canonicalAxis(p[0]);
      if (!key) { if (unknown.indexOf(String(p[0])) < 0) unknown.push(String(p[0])); return; }
      var v = p[1];   /* 刻度已经在上一步逐值换算过了 */
      if (v > MAX_ABS) { v = MAX_ABS; dropped++; }
      if (v < -MAX_ABS) { v = -MAX_ABS; dropped++; }
      if (Math.abs(v) < 0.01) return;
      /* 同一个轴给了两次：后面的覆盖前面，但要说一声 */
      if (axes[key] != null && axes[key] !== v)
        notes.push('模型对「' + axisLabel(key) + '」给了不止一个值，取了后一个');
      axes[key] = Math.round(v * 100) / 100;
    });

    if (dropped) notes.push('有 ' + dropped + ' 个值超出 -1..1，已经夹到边界');
    if (unknown.length) notes.push('丢掉了不认识的轴：' + unknown.join('、'));

    var matched = [];
    INTENT.AXES.forEach(function (a) {
      if (axes[a.key] == null) return;
      matched.push({ axis: a.key, dir: axes[a.key] > 0 ? 1 : -1, words: '大模型' });
    });

    var reason = (obj && typeof obj.reason === 'string') ? obj.reason
      : (obj && typeof obj.说明 === 'string' ? obj.说明 : '');

    /* 模型明确说自己做不到 */
    if (obj && obj.ok === false) {
      return {
        ok: false, axes: {}, reason: reason || '模型认为这句话用这五个轴表达不了',
        notes: notes, servedBy: 'llm',
      };
    }

    if (!matched.length) {
      /* 两种情况的处理完全不同：
         - 我们丢了东西（轴名不认识、值被夹掉）→ 是解析器没接住，可以退回本地词典；
         - 模型自己给的就是空 → 那是它的答案，尊重它，不要拿本地词典去硬凑。 */
      var weLost = unknown.length > 0 || dropped > 0;
      return {
        ok: false, axes: {}, malformed: weLost,
        reason: reason || (weLost ? '模型给的轴名一个都不认识'
          + (unknown.length ? '（' + unknown.join('、') + '）' : '')
          : '模型没有给出可用的轴'),
        notes: notes, servedBy: 'llm',
      };
    }

    return {
      ok: true, axes: axes, matched: matched,
      reason: reason, notes: notes,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
      servedBy: 'llm',
    };
  }

  /* ============================================================
     七、取模型返回的正文
     ------------------------------------------------------------
     OpenAI 兼容接口的正常形态是 choices[0].message.content。
     但兼容归兼容，细节各家不一样（有的 content 是数组、有的报错塞在
     别的地方），所以这里做一层宽容的提取，取不到就把原文带出来。
     ============================================================ */
  function pickContent(json) {
    if (!json || typeof json !== 'object') return null;
    if (typeof json.error === 'string') return null;
    var ch = json.choices;
    if (Array.isArray(ch) && ch.length) {
      var m = ch[0] && (ch[0].message || ch[0].delta);
      if (m) {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          var buf = '';
          m.content.forEach(function (part) {
            if (typeof part === 'string') buf += part;
            else if (part && typeof part.text === 'string') buf += part.text;
          });
          return buf;
        }
        if (typeof m.reasoning_content === 'string' && m.reasoning_content) return m.reasoning_content;
      }
      if (typeof ch[0].text === 'string') return ch[0].text;
    }
    if (typeof json.response === 'string') return json.response;   /* Ollama 原生形态 */
    if (json.message && typeof json.message.content === 'string') return json.message.content;
    return null;
  }

  function errorText(json) {
    if (!json) return '';
    if (typeof json.error === 'string') return json.error;
    if (json.error && json.error.message) return json.error.message;
    if (json.message) return String(json.message);
    return '';
  }

  /* ============================================================
     八、把各种失败翻译成人话
     ------------------------------------------------------------
     每种失败都必须给一条出路，不能只报"失败了"。这条规矩从第 ① 层
     一直贯到这一层。
     ============================================================ */
  function describeError(err) {
    if (!err) return { text: '未知错误', hint: '' };
    var name = err.name || '', msg = String(err.message || err);

    if (name === 'AbortError') return {
      text: '请求超时', hint: '网络太慢或模型没响应。可以重试，或换成更小的模型。',
    };
    if (/Failed to fetch|NetworkError|Load failed|fetch failed|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH/i.test(msg))
      return {
        text: '连不上这个地址',
        hint: '检查基地址是否写对、这台机器有没有网；'
          + '如果是本机 Ollama，确认它已经启动。跨域被挡时浏览器控制台会有 CORS 字样。',
      };
    if (/401|Unauthorized|invalid_api_key|Invalid API key|authentication/i.test(msg))
      return { text: 'API Key 不对或没填', hint: '检查 Key 有没有抄漏字符、是不是这一家的。' };
    if (/402|Insufficient Balance|余额|quota|Quota|insufficient/i.test(msg))
      return { text: '账户余额不足或额度用完', hint: '去服务商那边充值/查看额度。' };
    if (/403|Forbidden|permission/i.test(msg))
      return { text: '这个 Key 没权限调这个模型', hint: '换一个模型名，或检查 Key 的权限范围。' };
    if (/404|Not Found|model_not_found/i.test(msg))
      return { text: '地址或模型名不对', hint: '基地址通常以 /v1 结尾；模型名要与服务商文档一致。' };
    if (/429|rate limit|too many/i.test(msg))
      return { text: '请求太频繁被限流', hint: '等几秒再试。' };
    if (/400|Bad Request/i.test(msg))
      return { text: '请求被拒绝（400）', hint: '常见原因是这家接口不认 response_format，重试时会自动去掉它。' };
    if (/5\d\d|server error/i.test(msg))
      return { text: '服务商那边出错了', hint: '这不是你这边的问题，过一会儿再试。' };
    return { text: msg.slice(0, 160), hint: '' };
  }

  /* ============================================================
     九、调用
     ------------------------------------------------------------
     返回一个**永远可用**的意图对象：模型答不上来就退回本地词典。
     永远不会抛异常、永远不会返回 null —— 上层不用写 if。
     但"这次是谁答的"会如实写在 source 里，界面要显示出来。
     ============================================================ */
  function localFallback(text, why) {
    var it = INTENT.parseLocal(text);
    it.source = 'local';
    if (why) it.fallbackReason = why;
    return it;
  }

  function call(o) {
    o = o || {};
    var text = o.text;
    var p = o.provider;
    var fetcher = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    if (!p || !p.url) return Promise.resolve(localFallback(text, '没有配置模型接口'));
    if (!fetcher) return Promise.resolve(localFallback(text, '这个环境不能发网络请求'));

    var req = buildRequest({ provider: p, model: o.model, apiKey: o.apiKey, text: text, voice: o.voice });
    var timeoutMs = o.timeoutMs || 30000;
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    if (ctl) req.init.signal = ctl.signal;
    var timer = null;

    function once(init) {
      return Promise.resolve().then(function () { return fetcher(req.url, init); });
    }

    function readBody(res) {
      return Promise.resolve()
        .then(function () { return res.text(); })
        .then(function (t) {
          var json = null;
          try { json = JSON.parse(t); } catch (e) { /* 非 JSON，留给下面报错 */ }
          return { res: res, json: json, raw: t };
        });
    }

    return new Promise(function (resolve) {
      if (ctl) timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
      function done(v) { if (timer) { clearTimeout(timer); timer = null; } resolve(v); }

      once(req.init)
        .then(function (res) {
          /* 有的接口不认 response_format，会回 400。去掉它再试一次，
             而不是直接把这个细节丢给用户看。 */
          if (res.status === 400 && req.body.response_format) {
            var retry = JSON.parse(JSON.stringify(req.body));
            delete retry.response_format;
            var init2 = JSON.parse(JSON.stringify(req.init));
            init2.body = JSON.stringify(retry);
            if (ctl) init2.signal = ctl.signal;
            return once(init2).then(function (r2) {
              return readBody(r2).then(function (b) {
                b.retriedWithoutJsonMode = true;
                return b;
              });
            });
          }
          return readBody(res);
        })
        .then(function (b) {
          if (!b.res.ok) {
            var et = errorText(b.json) || ('HTTP ' + b.res.status);
            var d = describeError({ message: et });
            return done(localFallback(text, d.text + '（HTTP ' + b.res.status + '）'
              + (d.hint ? '　' + d.hint : '')));
          }
          var content = pickContent(b.json);
          if (content == null) {
            return done(localFallback(text, '模型的返回里没有正文'
              + (errorText(b.json) ? '：' + errorText(b.json) : '')));
          }

          var parsed = parseModelOutput(content);
          var it;
          if (parsed.ok) {
            it = {
              ok: true, text: String(text == null ? '' : text),
              axes: parsed.axes, matched: parsed.matched,
              hits: ['大模型'], strength: 0.5,
              reason: parsed.reason || '', notes: parsed.notes || [],
              confidence: parsed.confidence,
              raw: content,
            };
          } else if (parsed.malformed) {
            /* 是"我没看懂它的回答"，不是"它说做不到"。
               用户的这句话本地词典很可能答得上来，那就别让用户白跑一趟 ——
               但要如实说明这次是谁答的。 */
            var back = localFallback(text, '模型这次没给出能用的回答（'
              + parsed.reason + '），已经改用本地词典');
            back.notes = (parsed.notes || []).concat(back.notes || []);
            back.raw = content;
            return done(back);
          } else {
            /* 模型听懂了但说做不到 —— 这是它的答案，不是错误。 */
            it = {
              ok: false, text: String(text == null ? '' : text), axes: {},
              matched: [], hits: [], strength: 0.5,
              reason: parsed.reason, notes: parsed.notes || [],
              raw: content,
            };
          }
          it.source = 'llm';
          if (b.retriedWithoutJsonMode) {
            it.notes = (it.notes || []).concat(
              ['这家接口不认 response_format，已经去掉它重试并成功']);
          }
          done(it);
        })
        .catch(function (err) {
          var d = describeError(err);
          done(localFallback(text, d.text + (d.hint ? '　' + d.hint : '')));
        });
    });
  }

  /* ============================================================
     十、Key 的存放
     ------------------------------------------------------------
     只写进这台机器这个浏览器的 localStorage，不上传、不写进仓库。
     用 file:// 打开时某些浏览器会禁用 localStorage，那时降级成"本次有效"，
     并让界面如实说出来 —— 不假装存上了。
     ============================================================ */
  var KEY_NAME = 'fm1.llm.key';
  var CFG_NAME = 'fm1.llm.cfg';

  function store() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return null;
      localStorage.setItem('fm1.probe', '1');
      localStorage.removeItem('fm1.probe');
      return localStorage;
    } catch (e) { return null; }
  }

  function loadKey() {
    var s = store();
    if (!s) return '';
    try { return s.getItem(KEY_NAME) || ''; } catch (e) { return ''; }
  }
  function saveKey(k) {
    var s = store();
    if (!s) return false;
    try { if (k) s.setItem(KEY_NAME, k); else s.removeItem(KEY_NAME); return true; }
    catch (e) { return false; }
  }
  function loadConfig() {
    var s = store();
    if (!s) return null;
    try { var t = s.getItem(CFG_NAME); return t ? JSON.parse(t) : null; }
    catch (e) { return null; }
  }
  function saveConfig(c) {
    var s = store();
    if (!s) return false;
    try { s.setItem(CFG_NAME, JSON.stringify(c)); return true; }
    catch (e) { return false; }
  }

  return {
    PROVIDERS: PROVIDERS, providerById: providerById,
    SYSTEM_PROMPT: SYSTEM_PROMPT, axisLabel: axisLabel,
    adjustable: adjustable,
    buildMessages: buildMessages, buildRequest: buildRequest, joinUrl: joinUrl,
    extractJson: extractJson, canonicalAxis: canonicalAxis,
    parseModelOutput: parseModelOutput, pickContent: pickContent,
    describeError: describeError,
    call: call, localFallback: localFallback,
    loadKey: loadKey, saveKey: saveKey, loadConfig: loadConfig, saveConfig: saveConfig,
    storageAvailable: function () { return !!store(); },
  };
});
