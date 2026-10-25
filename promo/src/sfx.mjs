// 宣传片音效：全部用代码合成（没有采样素材，无版权问题），对齐 compose.js 的时间轴和录屏里的真实操作。
// 用法：node sfx.mjs <输出.wav>    → 48kHz 立体声 16-bit，长度和成片一样
// 声音的性格跟画面一致：短、硬、机械。擦入 = 带通噪声的「嘶」，换场快门 = 低频推送 + 一记咔哒，
// 界面点击 = 很短的高频「嗒」，结尾按钮变黄 = 两声干净的提示音。
import { writeFileSync } from 'node:fs';

const SR = 48000;
const DUR = 46.5;
const N = Math.round(SR * DUR);
const L = new Float32Array(N);
const R = new Float32Array(N);

/* ---------- 随机数固定种子，每次生成都一样 ---------- */
let seed = 20261025;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };

/* ---------- 写入：pan -1 左 … 1 右 ---------- */
function put(i, v, pan = 0) {
  if (i < 0 || i >= N) return;
  const a = (pan + 1) * Math.PI / 4;
  L[i] += v * Math.cos(a);
  R[i] += v * Math.sin(a);
}

/* 二阶带通（RBJ），频率可以逐样本变化 */
function bandpass() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x, f, q) => {
    const w = 2 * Math.PI * Math.min(f, SR * 0.45) / SR;
    const al = Math.sin(w) / (2 * q);
    const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
    const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/* 嘶：带通噪声，中心频率从 f0 扫到 f1，包络先快后慢 */
function swish(t, len, { f0 = 800, f1 = 5000, q = 1.2, gain = 0.35, pan = 0, panTo = pan, attack = 0.25 } = {}) {
  const bp = bandpass();
  const n = Math.round(len * SR), s0 = Math.round(t * SR);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const env = k < attack ? Math.pow(k / attack, 2) : Math.pow(1 - (k - attack) / (1 - attack), 1.6);
    const f = f0 * Math.pow(f1 / f0, k);
    put(s0 + i, bp(rnd(), f, q) * env * gain * 3, pan + (panTo - pan) * k);
  }
}

/* 嗒：界面点击。高频正弦快速衰减 + 一丁点噪声起音 */
function tick(t, { f = 3200, gain = 0.22, len = 0.035, pan = 0 } = {}) {
  const n = Math.round(len * SR), s0 = Math.round(t * SR);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const env = Math.exp(-tt * 140);
    const v = Math.sin(2 * Math.PI * f * tt) * env + rnd() * Math.exp(-tt * 900) * 0.6;
    put(s0 + i, v * gain, pan);
  }
}

/* 键盘：更短更闷的嗒，每次音高略有不同 */
function key(t, i, pan = 0.15) {
  tick(t, { f: 1700 + (i % 3) * 260, gain: 0.16, len: 0.03, pan });
}

/* 咚：低频下滑正弦，换场和大字落定时用 */
function thud(t, { f0 = 140, f1 = 48, len = 0.32, gain = 0.55, pan = 0 } = {}) {
  const n = Math.round(len * SR), s0 = Math.round(t * SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const f = f0 * Math.pow(f1 / f0, Math.min(1, k * 1.6));
    ph += 2 * Math.PI * f / SR;
    const env = Math.min(1, i / (0.004 * SR)) * Math.pow(1 - k, 2.2);
    put(s0 + i, Math.sin(ph) * env * gain, pan);
  }
}

/* 换场快门：低频推送 + 一阵从右往左的嘶 + 合拢时一记咔哒（画面上墨块从右往左扫） */
function shutter(b) {
  swish(b - 0.3, 0.58, { f0: 300, f1: 2600, q: 0.9, gain: 0.3, pan: 0.6, panTo: -0.6, attack: 0.5 });
  thud(b - 0.02, { f0: 110, f1: 45, len: 0.28, gain: 0.42 });
  tick(b + 0.0, { f: 2400, gain: 0.2, len: 0.05 });
}

/* 提示音：两声干净的正弦（结尾按钮变黄） */
function chime(t, notes = [1318.5, 1975.5], gap = 0.09, gain = 0.16) {
  notes.forEach((f, j) => {
    const n = Math.round(0.9 * SR), s0 = Math.round((t + j * gap) * SR);
    for (let i = 0; i < n; i++) {
      const tt = i / SR;
      const env = Math.min(1, tt / 0.004) * Math.exp(-tt * 5.5);
      const v = Math.sin(2 * Math.PI * f * tt) + 0.25 * Math.sin(2 * Math.PI * f * 2.01 * tt) * Math.exp(-tt * 9);
      put(s0 + i, v * env * gain, j ? 0.2 : -0.2);
    }
  });
}

/* 马克笔划过：中频带通噪声，左到右 */
function marker(t, len = 0.42) {
  swish(t, len, { f0: 1400, f1: 2600, q: 2.2, gain: 0.22, pan: -0.5, panTo: 0.5, attack: 0.15 });
}

/* ================= 时间轴（和 compose.js 的 SCENES 对应） ================= */

// 开场（深色）
swish(0.05, 0.8, { f0: 400, f1: 7000, q: 0.8, gain: 0.22, pan: -0.8, panTo: 0.8, attack: 0.6 }); // 三色条从左画到右
tick(0.25, { f: 2600, gain: 0.12 });                                                              // 眉标
swish(0.42, 0.45, { f0: 900, f1: 3500, gain: 0.25, pan: -0.4, panTo: 0.3 }); thud(0.82, { gain: 0.38 }); // 「不用再刷信息流」擦入、落定
swish(1.12, 0.45, { f0: 900, f1: 3500, gain: 0.25, pan: -0.4, panTo: 0.3 }); thud(1.52, { f0: 160, gain: 0.5 }); // 「每天 5 分钟」
tick(1.95, { f: 2000, gain: 0.12 });                                                              // 副标题

// 开场 → 字标：纸面从左擦开
swish(3.5, 0.6, { f0: 250, f1: 4000, q: 0.8, gain: 0.3, pan: -0.7, panTo: 0.7, attack: 0.55 });
tick(3.98, { f: 3000, gain: 0.18 });                                // R 徽记
swish(4.05, 0.55, { f0: 600, f1: 3000, gain: 0.25, pan: -0.5, panTo: 0.5 }); thud(4.62, { f0: 120, f1: 40, len: 0.45, gain: 0.6 }); // 大字标落定
swish(4.38, 0.48, { f0: 800, f1: 3200, gain: 0.18, pan: -0.4, panTo: 0.4 });
marker(4.92);                                                       // 黄色马克笔
[5.42, 5.5, 5.58].forEach((t, i) => tick(t, { f: 2200 + i * 300, gain: 0.08, pan: -0.3 + i * 0.3 }));

// 各功能段：换场快门 + 编号灌满 + 画面擦入 + 铭牌
const FEATS = [[7.4, -0.3, 0.5], [14.6, 0.4, -0.4], [21.8, -0.3, 0.5]];
for (const [b, capPan, shotPan] of FEATS) {
  shutter(b);
  swish(b + 0.25, 0.6, { f0: 500, f1: 2200, q: 1.5, gain: 0.13, pan: capPan });       // 编号灌满
  swish(b + 0.1, 0.55, { f0: 700, f1: 4200, gain: 0.16, pan: shotPan - 0.3, panTo: shotPan + 0.3 }); // 画面擦入
  tick(b + 1.25, { f: 2400, gain: 0.12, pan: shotPan });                                // 铭牌
}

// 原始雷达：录屏里真实点了三次标签页
[1.36, 2.64, 3.91].forEach((dt) => tick(14.6 + dt, { f: 3400, gain: 0.2, pan: -0.25 }));

// 搜索：打开、六次按键、三次上下选择
shutter(28.9);
tick(28.9 + 0.06, { f: 1500, gain: 0.18 });
swish(28.9 + 0.04, 0.25, { f0: 2000, f1: 6000, gain: 0.08 });
[0.48, 0.66, 0.81, 0.98, 1.15, 1.31].forEach((dt, i) => key(28.9 + dt, i));
[2.18, 2.56, 2.91].forEach((dt) => tick(28.9 + dt, { f: 2800, gain: 0.13, len: 0.025 }));
swish(28.9 + 0.35, 0.5, { f0: 300, f1: 1800, gain: 0.12, pan: -0.8, panTo: -0.2 });   // 字幕条擦入

// 深浅切换：点按钮 → 圆形揭开（上扬的嘶）
shutter(33.1);
tick(33.1 + 0.58, { f: 3000, gain: 0.2, pan: 0.5 });
swish(33.1 + 0.6, 0.5, { f0: 300, f1: 6000, q: 0.7, gain: 0.26, pan: 0.6, panTo: -0.4, attack: 0.35 });
swish(33.1 + 0.35, 0.5, { f0: 300, f1: 1800, gain: 0.12, pan: -0.8, panTo: -0.2 });
tick(33.1 + 1.9, { f: 2600, gain: 0.12 });                                              // 又换了一页

// 还有：四张截图依次擦入
shutter(36.6);
[0, 1, 2, 3].forEach((i) => {
  swish(36.6 + 0.2 + i * 0.12, 0.4, { f0: 900, f1: 4000, gain: 0.12, pan: (i % 2 ? 0.5 : -0.1), panTo: (i % 2 ? 0.8 : 0.3) });
  tick(36.6 + 0.62 + i * 0.12, { f: 2600 + i * 200, gain: 0.1, pan: (i % 2 ? 0.6 : 0) });
});

// 结尾
shutter(41.0);
swish(41.15, 0.55, { f0: 600, f1: 3000, gain: 0.22, pan: -0.5, panTo: 0.3 }); thud(41.7, { f0: 120, f1: 40, len: 0.5, gain: 0.55 });
swish(41.4, 0.5, { f0: 800, f1: 3200, gain: 0.15, pan: -0.5, panTo: 0.3 });
[0, 1, 2].forEach((i) => tick(41.0 + 1.05 + i * 0.15, { f: 2000 + i * 250, gain: 0.11, pan: -0.4 }));
swish(41.0 + 1.7, 0.45, { f0: 500, f1: 2500, gain: 0.12, pan: 0.6, panTo: 0.8 });
chime(41.0 + 2.7);                                                  // 「打开 AI 情报台」变黄

/* ---------- 限幅、淡出、写 WAV ---------- */
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0 ? 0.5 / peak : 1;                       // 峰值约 -6 dBFS，给背景音乐留空间
const soft = (x) => Math.tanh(x * 1.2) / Math.tanh(1.2);
const fadeFrom = Math.round((DUR - 0.8) * SR);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const f = i > fadeFrom ? 1 - (i - fadeFrom) / (N - fadeFrom) : 1;
  buf.writeInt16LE(Math.round(soft(L[i] * norm) * f * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(soft(R[i] * norm) * f * 32767), 46 + i * 4);
}
const out = process.argv[2] || 'sfx.wav';
writeFileSync(out, buf);
console.log('wrote', out, `${DUR}s`, 'peak before norm', peak.toFixed(3));
