// 把随附原创音色库渲染成一段串烧，作为"这个音色库听起来是这样"的试听样本。
//
// 数据来源是 CC0 的 starter bank，所以渲染结果也是干净的，可以随仓库分发。
// 出厂音色不做这件事 —— 那是派生数据，见 LICENSE-AUDIT.md。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const DX7 = require(path.join(ROOT, 'engine', 'dx7.js'));
const FM = require(path.join(ROOT, 'engine', 'fm.js'));

const sandbox = {};
new Function('window', readFileSync(path.join(ROOT, 'data', 'starter.js'), 'utf8'))(sandbox);
const S = sandbox.FM1_STARTER;
const packed = DX7.parseBank(new Uint8Array(Buffer.from(S.banks[0], 'base64')));

const SR = 44100;
const SEG = 0.85;          // 每个音色的时长
const GAP = 0.06;          // 段间静音，避免糊在一起

/* 给每个音色挑一个能听出特点的音符：低音类往下走，金属/吹管类往上走。 */
function pickNote(name) {
  if (/BASS|KICK|GROWL/i.test(name)) return 36;                  // C2
  if (/BELL|TUB|VIBES|FLUTE|GLASS|SPACE/i.test(name)) return 72;  // C5
  return 48;                                                      // C3
}

const parts = [];
const rows = [];
for (let i = 0; i < 32; i++) {
  const d = DX7.decodeVoice(packed.slice(i * 128, i * 128 + 128));
  const name = S.names[i];
  const note = pickNote(name);
  // render 内部已经做了峰值归一化与首尾淡化，这里直接拼接是安全的。
  const buf = FM.render(d, { sampleRate: SR, duration: SEG, gate: SEG * 0.55, note });
  parts.push(buf);
  parts.push(new Float32Array(Math.round(SR * GAP)));

  let peak = 0;
  for (const x of buf) { const a = Math.abs(x); if (a > peak) peak = a; }
  rows.push(`  ${String(i).padStart(2)}  ${name.padEnd(10)} note ${String(note).padStart(2)}  峰值 ${peak.toFixed(3)}`);
}

const total = parts.reduce((n, b) => n + b.length, 0);
const medley = new Float32Array(total);
let at = 0;
for (const b of parts) { medley.set(b, at); at += b.length; }

const outDir = path.join(ROOT, 'starter', 'preview');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, '_starter_medley.wav');
writeFileSync(file, FM.encodeWav(medley, SR));

console.log(`✓ starter/preview/_starter_medley.wav`);
console.log(`  ${(total / SR).toFixed(1)} 秒 · ${(total * 2 + 44) / 1024 / 1024} MB`);
console.log('');
console.log(rows.join('\n'));
