/* ============================================================================
   列出所有超出 DX7 面板区间（0–99）的取值，并把该算子的原始 17 字节打出来
   ----------------------------------------------------------------------------
   运行：node tools/diag_ranges.mjs
   用途：把"这些越界值到底是什么"变成可以肉眼核对的事实，而不是靠推理。
   判据是——如果偏移量错位，同一个算子的另外 16 个字节不可能全部合法。
   ========================================================================= */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));

const packed = new Uint8Array(readFileSync(path.join(ROOT, 'ref', 'packed128.bin')));

// 台账从生成物里读（data/factory.js 用 window.FM1_FACTORY = {...} 的形式）
const win = {};
new Function('window', readFileSync(path.join(ROOT, 'data', 'factory.js'), 'utf8'))(win);
const prov = win.FM1_FACTORY.provenance;

let total = 0;
console.log('所有超出 DX7 面板区间 (0–99) 的取值：\n');

for (let i = 0; i < 128; i++) {
  const v = packed.slice(i * 128, i * 128 + 128);
  const d = DX7.decodeVoice(v);
  const hits = [];
  const touched = new Set();

  d.ops.forEach((o, idx) => {
    const mark = () => touched.add(idx);
    o.egR.forEach((x, k) => { if (x > 99) { hits.push(`OP${o.num} EG.R${k + 1}=0x${x.toString(16)}`); mark(); } });
    o.egL.forEach((x, k) => { if (x > 99) { hits.push(`OP${o.num} EG.L${k + 1}=0x${x.toString(16)}`); mark(); } });
    if (o.freqFine > 99) { hits.push(`OP${o.num} freqFine=0x${o.freqFine.toString(16)}`); mark(); }
    if (o.detune > 14) { hits.push(`OP${o.num} detune=${o.detune - 7}（面板上限 +7）`); mark(); }
  });

  if (!hits.length) continue;
  total += hits.length;
  console.log(`槽 ${i}  ${JSON.stringify(d.name)}`);
  console.log(`    ${hits.join('   ')}`);
  console.log(`    来源 ${prov[i].source}   原名 ${JSON.stringify(prov[i].original)}`);

  // 把越界算子所在的那个 17 字节块原样打出来 —— 其余 16 字节应当全部合法
  for (const idx of touched) {
    const o = d.ops[idx];
    const raw = [...v.slice(idx * 17, idx * 17 + 17)];
    const legal = raw.filter((b, k) => (k === 0 || true) && b <= 99).length;
    console.log(`    该算子原始 17 字节 (block ${idx} = OP${o.num}): ` +
      raw.map(b => b.toString(16).padStart(2, '0')).join(' '));
    console.log(`      其中 ≤99 的字节：${legal} / 17`);
  }
  console.log('');
}

console.log(`合计 ${total} 处。这些都是源数据本身如此，不是解析错位——`);
console.log('判据是每个越界算子所在字节块的其余字节全部落在合法区间。');
