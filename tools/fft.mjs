/* ============================================================================
   频谱分析工具（只给工具的，不给页面）
   ----------------------------------------------------------------------------
   为什么要单独一个文件：这段 FFT 本来在 engine_test / render_demo / diag_spectrum
   里各抄了一份，结果两份漏了位反转置换（只留蝶形运算），输出的频谱是乱的——
   表现为"所有音色的频谱重心都在 8–12 kHz"，看起来像引擎把音色渲染成了噪声。
   实际上引擎是对的，错的是量它的尺子。
   → 教训：**同一段代码抄第二遍就开始漂移；量东西的工具也必须被验证。**
   ========================================================================= */

/* 原地 radix-2 FFT。位反转置换 + 蝶形，两步缺一不可。 */
export function fft(re, im) {
  const n = re.length;
  if (n !== (n & -n)) throw new Error('长度必须是 2 的幂，实际 ' + n);

  // ① 位反转置换 —— 缺了这一步，输出就是把频率顺序打乱的乱码
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // ② 蝶形运算
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const w = k * ang, c = Math.cos(w), s = Math.sin(w);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
        const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/* 取 buf 的一段做加窗幅度谱，返回前 N/2 个 bin 的幅度 */
export function spectrum(buf, start, N = 4096) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));   // Hann
    re[i] = (buf[start + i] || 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/* 频谱重心（Hz）——越低越暗、越高越亮 */
export function centroid(mag, sampleRate, N = mag.length * 2) {
  let num = 0, den = 0;
  for (let i = 1; i < mag.length; i++) { num += i * mag[i]; den += mag[i]; }
  return den > 0 ? (num / den) * sampleRate / N : 0;
}

export function peakBin(mag) {
  let bi = 1, bv = -1;
  for (let i = 1; i < mag.length; i++) if (mag[i] > bv) { bv = mag[i]; bi = i; }
  return bi;
}

/* 基频附近 (±2 bin) 占总能量的比例 —— 用来判断"这是不是一条纯正弦" */
export function toneConcentration(mag, bi, half = 2) {
  let near = 0, all = 0;
  for (let i = 1; i < mag.length; i++) {
    all += mag[i] * mag[i];
    if (Math.abs(i - bi) <= half) near += mag[i] * mag[i];
  }
  return all > 0 ? near / all : 0;
}

/* 便利组合：直接给一段缓冲区算出重心（Hz） */
export function centroidOf(buf, sampleRate, start = Math.round(0.3 * sampleRate)) {
  const N = 4096;
  if (start + N > buf.length) return 0;
  return centroid(spectrum(buf, start, N), sampleRate, N);
}
