// 验证大模型接入层。
//
// 这一层特殊的地方在于：**它对接的东西会不听话**。所以这里的断言大半不是在
// 验"顺利的时候对不对"，而是在验"模型胡说的时候会不会出事"：
// 给乱码、给错轴名、给 0–100 的刻度、给超出范围的值、干脆不答、网络断掉……
// 每一条都必须落到一个明确的、说得出原因的结果上，而且不能抛异常。
//
// ① 服务商预设可用
// ② 拼出来的请求正确（地址、鉴权头、JSON 模式）
// ③ 锚点可调性算得对，且不碰原音色
// ④ 从一堆废话里能抠出 JSON（含字符串里的花括号）
// ⑤ 轴名归一
// ⑥ 模型输出 → 意图：各种畸形输入都不能炸、不能静默截断
// ⑦ 取正文、错误翻译
// ⑧ call() 端到端（假 fetch）：成功 / 鉴权失败 / 断网 / 超时 / 400 重试 / 乱码
// ⑨ Key 不泄漏；存不了的时候要降级而不是抛错
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const FM = require(path.join(ROOT, 'engine', 'fm.js'));
const INTENT = require(path.join(ROOT, 'engine', 'intent.js'));
const LLM = require(path.join(ROOT, 'engine', 'llm.js'));

let fails = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `\n        ${extra}` : ''}`);
  if (!cond) fails++;
  return cond;
};
const section = (t) => console.log(`\n${t}`);

/* ---------------------------------------------------------------- 数据 */
const banks = [];
const sw = {};
new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(sw);
sw.FM1_STARTER.banks.forEach((b, i) => banks.push({ label: 'starter#' + i, b64: b }));
for (const f of ['data/factory.js']) {
  const p = path.join(ROOT, f);
  if (!existsSync(p)) continue;
  const fw = {};
  new Function('window', readFileSync(p, 'utf8'))(fw);
  const key = Object.keys(fw)[0];
  fw[key].banks.forEach((b, i) => banks.push({ label: 'factory#' + i, b64: b }));
}

const voices = [];
for (const { label, b64 } of banks) {
  const data = DX7.parseBank(DX7.b64ToBytes(b64));
  for (let i = 0; i < DX7.VOICES_PER_BANK; i++) {
    const d = DX7.decodeVoice(data.slice(i * 128, i * 128 + 128));
    voices.push({ label: label + ' 槽' + i, d });
  }
}
console.log(`数据源 ${banks.length} 个 bank，共 ${voices.length} 个音色`);

/* 找两个互补的样本：有调制器的（亮度可调）和没有调制器的（亮度不可调） */
const withMod = voices.find(v => DX7.describe(v.d, FM).modulatorCount > 0);
const noMod = voices.find(v => DX7.describe(v.d, FM).modulatorCount === 0);
const sample = withMod || voices[0];

/* ============================================================ ① 预设 */
section('① 服务商预设');
check(LLM.PROVIDERS.length >= 5, `内置 ${LLM.PROVIDERS.length} 个服务商`);
check(LLM.PROVIDERS.every(p => p.id && typeof p.url === 'string' && typeof p.label === 'string'),
  '每个预设都有 id / label / url');
check(LLM.PROVIDERS.every(p => !/\/$/.test(p.url)), '基地址都没带结尾斜杠（免得拼出双斜杠）');
check(LLM.providerById('deepseek').url === 'https://api.deepseek.com/v1',
  '按 id 取得到预设');
check(LLM.providerById('根本不存在的id').id === LLM.PROVIDERS[0].id,
  '取不到的 id 退回第一个，不返回 undefined');
check(typeof LLM.providerById('custom').model === 'string'
  && LLM.providerById('custom').keyUrl === '',
  '自定义那一条留着空地址给用户填');

/* ============================================================ ② 请求 */
section('② 拼出来的请求');
{
  const p = LLM.providerById('deepseek');
  const r = LLM.buildRequest({ provider: p, text: '亮一点', voice: sample.d, apiKey: 'sk-abc' });
  check(r.url === 'https://api.deepseek.com/v1/chat/completions',
    '地址 = 基地址 + /chat/completions', r.url);
  check(r.init.headers['Authorization'] === 'Bearer sk-abc', '带上 Bearer 鉴权头');
  check(r.init.headers['Content-Type'] === 'application/json', '声明 JSON');
  const body = JSON.parse(r.init.body);
  check(body.model === p.model, '模型名进了 body');
  check(body.messages.length === 2 && body.messages[0].role === 'system',
    'system + user 两条消息');
  check(body.messages[1].content.includes('亮一点'), '用户那句话原样进了提示词');
  check(body.messages[1].content.includes(sample.d.name), '锚点音色名进了提示词');
  check(body.response_format && body.response_format.type === 'json_object',
    '默认要求 JSON 模式');
  check(body.temperature <= 0.3, '温度压得很低（要可复现，不要创意）', 'temperature=' + body.temperature);

  const noKey = LLM.buildRequest({ provider: p, text: 'x', voice: sample.d });
  check(!('Authorization' in JSON.parse(JSON.stringify(noKey.init.headers))),
    '没填 Key 时不发 Authorization 头');

  const ol = LLM.providerById('ollama');
  const ro = LLM.buildRequest({ provider: ol, text: 'x', voice: sample.d });
  check(!JSON.parse(ro.init.body).response_format,
    'Ollama 预设不要求 JSON 模式（它不一定认）');
  check(ro.url === 'http://127.0.0.1:11434/v1/chat/completions', '本机地址拼得对', ro.url);

  const trailing = LLM.buildRequest({
    provider: { id: 'x', url: 'https://a.example/v1/', model: 'm' }, text: 'x', voice: sample.d,
  });
  check(trailing.url === 'https://a.example/v1/chat/completions',
    '基地址带结尾斜杠也不会拼出双斜杠', trailing.url);
}

/* ================================================= ③ 锚点的可调性 */
section('③ 这台音色上哪些轴真的能动（实测，不是让模型猜）');
{
  const can = LLM.adjustable(sample.d);
  check(INTENT.AXES.every(a => typeof can[a.key] === 'boolean'),
    '五个轴都有明确的 true/false', JSON.stringify(can));
  check(can.bright === true, `有调制器的音色「亮度」可调（${sample.d.name}）`, JSON.stringify(can));

  if (noMod) {
    const c2 = LLM.adjustable(noMod.d);
    check(c2.bright === false,
      `没有调制器的音色「亮度」标成不可调（${noMod.d.name} · 算法 `
      + (noMod.d.algorithm & 31) + 1 + '）', JSON.stringify(c2));
  } else {
    console.log('  SKIP  没找到"没有调制器"的音色（6 载波算法），跳过这条');
  }

  /* 探针不能把原音色改坏 —— 它是拿真音色跑了一遍 applyIntent 的 */
  const before = Array.from(sample.d.raw);
  LLM.adjustable(sample.d);
  const after = Array.from(LLM.adjustable(sample.d) ? sample.d.raw : []);
  check(JSON.stringify(before) === JSON.stringify(after),
    '算可调性不会动到原音色（字节完全没变）');

  /* 提示词里的措辞要跟算出来的结果一致，不能两套说法 */
  const msg = LLM.buildMessages('随便说点什么', sample.d)[1].content;
  check(/【这台音色上可调的轴】[\s\S]*亮度/.test(msg),
    '提示词把「亮度」列在可调的轴里');
  if (noMod) {
    const msg2 = LLM.buildMessages('随便说点什么', noMod.d)[1].content;
    const line = msg2.split('\n').find(l => l.startsWith('【这台音色上调不动的轴】')) || '';
    check(/亮度/.test(line), '没有调制器时，「亮度」被列进"调不动的轴"', line);
    check(/没有调制器/.test(msg2), '并且额外点明了原因');
  }
}

/* ============================================================ ④ 抠 JSON */
section('④ 从一堆废话里抠出 JSON');
{
  const cases = [
    ['光秃秃的', '{"axes":{"bright":0.5}}', true],
    ['带 json 围栏', '```json\n{"axes":{"bright":0.5}}\n```', true],
    ['围栏不带语言', '```\n{"axes":{"bright":0.5}}\n```', true],
    ['前后有客套话', '好的，我来分析一下：\n{"axes":{"bright":0.5}}\n希望有帮助！', true],
    ['字符串里有花括号', '{"axes":{"bright":0.5},"reason":"用 {大括号} 说明"}', true],
    ['有两层嵌套', '{"axes":{"bright":0.5},"meta":{"n":1}}', true],
    ['前面先出现一个花括号', '提示：{不是 JSON} 真正的答案在下面\n{"axes":{"bright":0.5}}', true],
    ['举了个例子的花括号', '举例 {"foo":"bar"}；我的建议是 {"axes":{"bright":0.4}}', true],
    ['外层被截断', '{"axes":{"bright":0.5}', true],
    ['根本没 JSON', '我觉得这个音色挺好的，不用改。', false],
    ['只有个开头', '{"axes": ', false],
  ];
  for (const [name, raw, expect] of cases) {
    const got = LLM.extractJson(raw);
    check((got !== null) === expect, name + (expect ? ' → 抠出来了' : ' → 判定为没有'),
      got === null ? '' : got.slice(0, 60));
  }

  /* 关键的一条：**别选中模型随手举的例子** */
  const decoy = LLM.extractJson('举例 {"foo":"bar"}；我的建议是 {"axes":{"bright":0.4}}');
  check(decoy !== null && decoy.includes('axes'),
    '有两个都能解析的片段时，选中带 axes 的那个而不是先出现的例子', decoy);

  const deep = LLM.extractJson('{"axes":{"bright":0.5,"extra":{"a":{"b":1}}}}');
  check(deep === '{"axes":{"bright":0.5,"extra":{"a":{"b":1}}}}',
    '多层嵌套能完整配对到最外层的右括号');
}

/* ======================================================== ⑤ 轴名归一 */
section('⑤ 轴名归一（模型爱换名字）');
{
  const hit = [['bright', 'bright'], ['Brightness', 'bright'], [' 亮度 ', 'bright'],
    ['TONE', 'bright'], ['tail', 'sustain'], ['延音', 'sustain'], ['decay', 'sustain'],
    ['起音', 'attack'], ['thickness', 'width'], ['detune', 'width'],
    ['harshness', 'feedback'], ['反馈', 'feedback']];
  let ok = 0;
  for (const [input, want] of hit) if (LLM.canonicalAxis(input) === want) ok++;
  check(ok === hit.length, `${hit.length} 个别名/中文名/大小写变体全部认出来（对了 ${ok} 个）`);
  check(LLM.canonicalAxis('reverb') === null, '不认识的轴返回 null（不瞎猜）');
  check(LLM.canonicalAxis(null) === null && LLM.canonicalAxis('') === null,
    'null 和空串也返回 null');
  check(LLM.canonicalAxis('sustain_level') === 'sustain', '下划线拆开的写法也认');
}

/* ================================================= ⑥ 模型输出 → 意图 */
section('⑥ 模型输出 → 意图（畸形输入一个都不能炸）');
{
  const ideal = LLM.parseModelOutput('{"ok":true,"axes":{"bright":0.4,"sustain":-0.3},"reason":"说明","confidence":0.8}');
  check(ideal.ok === true, '标准输出解析成功');
  check(ideal.axes.bright === 0.4 && ideal.axes.sustain === -0.3, '数值原样保留');
  check(ideal.reason === '说明', '把模型的中文说明带出来了');
  check(ideal.confidence === 0.8, '置信度带出来了');
  check(ideal.matched.length === 2 && ideal.matched.every(m => m.words === '大模型'),
    'matched 标了来源是"大模型"');

  const flat = LLM.parseModelOutput('{"bright":0.5,"sustain":0.2}');
  check(flat.ok === true && flat.axes.bright === 0.5,
    '没有 axes 那一层、直接平铺也认');

  const arr = LLM.parseModelOutput('{"axes":[{"axis":"bright","value":0.6},{"name":"tail","strength":-0.4}]}');
  check(arr.ok === true && arr.axes.bright === 0.6 && arr.axes.sustain === -0.4,
    '给成数组也给认出来', JSON.stringify(arr.axes));

  const str = LLM.parseModelOutput('{"axes":{"bright":"+0.5"}}');
  check(str.ok === true && str.axes.bright === 0.5, '数字写成字符串也认（含 + 号）');

  const pct = LLM.parseModelOutput('{"axes":{"bright":80}}');
  check(pct.ok === true && Math.abs(pct.axes.bright - 0.8) < 1e-9,
    '0–100 百分比换算成 0.8', JSON.stringify(pct.axes));
  check(pct.notes.some(n => /换算/.test(n)), '并且如实说明做了一次换算');

  const ten = LLM.parseModelOutput('{"axes":{"bright":8}}');
  check(ten.ok === true && Math.abs(ten.axes.bright - 0.8) < 1e-9,
    '1–10 评分制也换算成 0.8', JSON.stringify(ten.axes));

  const mixed = LLM.parseModelOutput('{"axes":{"bright":0.5,"sustain":80}}');
  check(Math.abs(mixed.axes.bright - 0.5) < 1e-9 && Math.abs(mixed.axes.sustain - 0.8) < 1e-9,
    '**同一个回答里两种刻度混着来**也不互相带坏（逐值判断的意义）',
    JSON.stringify(mixed.axes));

  const over = LLM.parseModelOutput('{"axes":{"bright":9999}}');
  check(over.ok === true && over.axes.bright === 1, '离谱的超范围值夹到 1');
  check(over.notes.some(n => /超出/.test(n)), '而且明说夹过一次（不静默截断）');

  const junk = LLM.parseModelOutput('{"axes":{"reverb":0.5,"delay":0.3}}');
  check(junk.ok === false && junk.malformed === true,
    '轴名一个都不认识 → 标成"我没接住"（可以退回本地词典）');
  check(/reverb/.test(junk.reason), '并且把不认识的轴名列出来方便排查', junk.reason);

  const declined = LLM.parseModelOutput('{"ok":false,"axes":{},"reason":"这台引擎没有混响"}');
  check(declined.ok === false && declined.malformed === undefined,
    '模型说做不到 → 不算解析失败，要尊重它');
  check(declined.reason === '这台引擎没有混响', '它给的理由原样带出来');

  const empty = LLM.parseModelOutput('{"axes":{}}');
  check(empty.ok === false && !empty.malformed,
    '模型给了合法的空对象 → 当成"没有可用的轴"，不当成乱码');

  const gibberish = LLM.parseModelOutput('抱歉，我不能帮你做这个。');
  check(gibberish.ok === false && gibberish.malformed === true,
    '通篇不是 JSON → 标成乱码，可退回本地词典');
  check((gibberish.notes || []).some(n => /截断|原始/.test(n)),
    '留了原始返回方便排查（截断到 200 字）');

  const broken = LLM.parseModelOutput('{"axes":{"bright":0.5,}}');
  check(broken.ok === false && broken.malformed === true, 'JSON 语法错也不炸');

  const weird = LLM.parseModelOutput('{"axes":null}');
  check(weird.ok === false, 'axes 明着给 null 也不炸', JSON.stringify(weird.axes));

  const notObj = LLM.parseModelOutput('[1,2,3]');
  check(notObj.ok === false && notObj.malformed === true, '给个数组也不炸');

  const tiny = LLM.parseModelOutput('{"axes":{"bright":0.001}}');
  check(tiny.ok === false, '小到 0.001 的值当成"没改"，不产生一次没意义的改动');

  const french = LLM.parseModelOutput('```json\n{"axes":{"bright":0.3}}\n```');
  check(french.ok === true && french.axes.bright === 0.3, '带围栏的真实场景');
}

/* ================================================= ⑦ 取正文 / 错误翻译 */
section('⑦ 取正文与把错误翻成人话');
{
  check(LLM.pickContent({ choices: [{ message: { content: 'hi' } }] }) === 'hi',
    '标准形态：choices[0].message.content');
  check(LLM.pickContent({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } }] }) === 'ab',
    'content 给成数组也能拼起来');
  check(LLM.pickContent({ response: 'hi' }) === 'hi', 'Ollama 原生形态 response');
  check(LLM.pickContent({ error: { message: 'x' } }) === null, '错误体不当作正文');
  check(LLM.pickContent({ choices: [] }) === null, '空的 choices 返回 null');
  check(LLM.pickContent(null) === null, 'null 也不炸');

  const cats = [
    [{ name: 'AbortError', message: 'aborted' }, /超时/],
    [{ message: 'Failed to fetch' }, /连不上/],
    [{ message: 'HTTP 401 Unauthorized' }, /Key/],
    [{ message: '402 Insufficient Balance' }, /余额|额度/],
    [{ message: '404 Not Found' }, /地址|模型名/],
    [{ message: '429 rate limit' }, /频繁|限流/],
    [{ message: '500 server error' }, /服务商/],
  ];
  let ok = 0;
  for (const [err, re] of cats) { const d = LLM.describeError(err); if (re.test(d.text)) ok++; }
  check(ok === cats.length, `${cats.length} 类失败都翻成了人话（对了 ${ok} 类）`);
  check(cats.every(([err]) => LLM.describeError(err).hint !== undefined),
    '每一类都带一个"接下来怎么办"的提示');
  check(LLM.describeError(null).text.length > 0, 'describeError(null) 也给得出话，不炸');
}

/* ============================================ ⑧ call() 端到端（假 fetch） */
section('⑧ call() 端到端 —— 假 fetch，把失败路径都走一遍');
{
  const P = LLM.providerById('deepseek');
  const key = 'sk-SECRET-不要泄漏-12345';

  const mkRes = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const okBody = (content) => ({ choices: [{ message: { content } }] });

  /* —— 顺利 —— */
  let seen = null;
  const good = await LLM.call({
    text: '亮一点', voice: sample.d, provider: P, apiKey: key,
    fetchImpl: (url, init) => { seen = { url, init }; return Promise.resolve(mkRes(200, okBody('{"ok":true,"axes":{"bright":0.3},"reason":"提了亮度"}'))); },
  });
  check(good.source === 'llm' && good.ok === true, '顺利时 source=llm、ok=true', good.source);
  check(good.axes.bright === 0.3, '拿到的轴对');
  check(seen.url === 'https://api.deepseek.com/v1/chat/completions', '打到了正确的地址', seen.url);
  check(JSON.parse(seen.init.body).messages[1].content.includes('亮一点'),
    '发出去的确实是那句话');
  check(!JSON.stringify(good).includes(key), '**返回对象里不含 API Key**');

  /* 拿到的意图必须能直接喂给 applyIntent 且不抛 */
  const applied = INTENT.applyIntent(sample.d, good);
  check(applied.changes.length > 0, '模型给的意图能直接应用，且真的产生了改动',
    applied.changes.map(c => c.text).join(' | '));

  /* —— 鉴权失败 → 退回本地 —— */
  const bad = await LLM.call({
    text: '亮一点', voice: sample.d, provider: P, apiKey: key,
    fetchImpl: () => Promise.resolve(mkRes(401, { error: { message: 'Invalid API key' } })),
  });
  check(bad.source === 'local', '401 时退回本地词典', bad.source);
  check(bad.ok === true && bad.axes.bright > 0,
    '退回之后仍然答对了这句（"亮一点"本地也认）', JSON.stringify(bad.axes));
  check(/Key/.test(bad.fallbackReason || ''), '并且说明为什么退了', bad.fallbackReason);
  check(!JSON.stringify(bad).includes(key), '**退回时的说明里也没有 Key**');

  /* —— 断网 —— */
  const offline = await LLM.call({
    text: '亮一点', voice: sample.d, provider: P, apiKey: key,
    fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
  });
  check(offline.source === 'local' && offline.ok === true, '断网时退回本地词典');
  check(/连不上/.test(offline.fallbackReason || ''), '说明是连不上', offline.fallbackReason);

  /* —— 超时 —— */
  const timed = await LLM.call({
    text: '亮一点', voice: sample.d, provider: P, apiKey: key, timeoutMs: 40,
    fetchImpl: (url, init) => new Promise((_, rej) => {
      if (init && init.signal) init.signal.addEventListener('abort',
        () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  check(timed.source === 'local', '超时也退回本地词典，不是无限挂着', timed.source);
  check(/超时/.test(timed.fallbackReason || ''), '说明是超时', timed.fallbackReason);

  /* —— 400：接口不认 response_format → 自动去掉重试 —— */
  const tries = [];
  const retried = await LLM.call({
    text: '亮一点', voice: sample.d, provider: P, apiKey: key,
    fetchImpl: (url, init) => {
      const b = JSON.parse(init.body);
      tries.push(b);
      if (b.response_format) return Promise.resolve(mkRes(400, { error: { message: 'Bad Request' } }));
      return Promise.resolve(mkRes(200, okBody('{"ok":true,"axes":{"bright":0.3}}')));
    },
  });
  check(tries.length === 2, '400 之后会自动重试一次（共发了 ' + tries.length + ' 次）');
  check(tries[0].response_format && !tries[1].response_format,
    '第一次带 response_format、第二次不带');
  check(retried.source === 'llm' && retried.ok === true, '重试之后拿到了模型的答案');
  check((retried.notes || []).some(n => /response_format/.test(n)),
    '并且把"去掉它才成功"这件事告诉用户', (retried.notes || []).join(' | '));

  /* —— 模型返回乱码 → 退回本地（不是当它说做不到） —— */
  const garbage = await LLM.call({
    text: '亮一点', voice: sample.d, provider: P, apiKey: key,
    fetchImpl: () => Promise.resolve(mkRes(200, okBody('这个音色很亮啦，不用改了。'))),
  });
  check(garbage.source === 'local', '模型答非所问（没有 JSON）→ 退回本地词典兜住', garbage.source);
  check(/没给出能用的回答/.test(garbage.fallbackReason || ''), '说明是模型没答好', garbage.fallbackReason);
  check(garbage.raw !== undefined, '把模型的原文留着方便排查');

  /* —— 模型明确说做不到 → 尊重它，**不要**退回本地硬凑 —— */
  const refuses = await LLM.call({
    text: '给它加个混响', voice: sample.d, provider: P, apiKey: key,
    fetchImpl: () => Promise.resolve(mkRes(200, okBody('{"ok":false,"axes":{},"reason":"FM 引擎没有混响效果器"}'))),
  });
  check(refuses.source === 'llm', '模型明确说做不到时，source 仍是 llm');
  check(refuses.ok === false, '结果是"做不到"，不是硬凑一个改动出来', JSON.stringify(refuses.axes));
  check(/混响/.test(refuses.reason), '把模型给的理由带给用户', refuses.reason);

  /* —— 没配地址就不该发请求 —— */
  let called = false;
  const unfilled = await LLM.call({
    text: '亮一点', voice: sample.d, provider: LLM.providerById('custom'), apiKey: key,
    fetchImpl: () => { called = true; return Promise.resolve(mkRes(200, okBody('{}'))); },
  });
  check(called === false, '地址没填时一次请求都不发');
  check(unfilled.source === 'local' && /没有配置/.test(unfilled.fallbackReason || ''),
    '而是直接说明"没有配置模型接口"', unfilled.fallbackReason);

  /* —— 永远不抛异常 —— */
  let threw = false;
  try {
    for (const bad2 of [
      { text: 'x', voice: sample.d, provider: P, fetchImpl: () => { throw new Error('sync boom'); } },
      { text: 'x', voice: sample.d, provider: P, fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: () => { throw new Error('text boom'); } }) },
      { text: 'x', voice: sample.d, provider: P, fetchImpl: () => Promise.resolve(mkRes(200, '不是 JSON 的响应体')) },
      { text: null, voice: null, provider: P, fetchImpl: () => Promise.resolve(mkRes(200, okBody('{"axes":{"bright":0.2}}'))) },
    ]) { const r = await LLM.call(bad2); if (!r || typeof r.ok !== 'boolean') threw = true; }
  } catch (e) { threw = true; console.log('        抛出：' + e.message); }
  check(threw === false, '四种异常输入（同步抛、text() 抛、响应体非 JSON、text/voice 为 null）都返回了可用的对象，一个都没抛出来');
}

/* ================================================== ⑨ Key 的存放与降级 */
section('⑨ Key 的存放：存不了就降级，不抛错');
{
  check(LLM.storageAvailable() === false,
    'Node 里没有 localStorage → 如实报"存不了"');
  check(LLM.loadKey() === '', '存不了时 loadKey 返回空串而不是崩');
  check(LLM.saveKey('x') === false, '存不了时 saveKey 返回 false 而不是崩');
  check(LLM.loadConfig() === null && LLM.saveConfig({}) === false,
    '读配置、存配置同样安全降级');
}

console.log(`\n${'─'.repeat(56)}`);
console.log(fails === 0 ? '结论：大模型接入层全部通过。' : `结论：${fails} 项失败。`);
process.exit(fails === 0 ? 0 : 1);
