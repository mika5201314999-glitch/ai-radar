// 把一段纯色/渐变背景的动画去底成透明，输出带透明通道的动态 WebP。
// 用法：node cutout_gif.mjs <ffmpeg.exe> <输入.gif> <输出.webp> [输出宽度=220] [帧率=15] [预览目录]
//   给了预览目录时，另外把几帧分别垫在深色和棋盘格上存成 PNG，方便检查边缘。
// 做法：
//   1. 用左右两边各几列像素（所有帧的中位数）估出每一行的背景色——原图背景是上蓝下白的竖向渐变；
//   2. 每一帧从四条边开始泛洪，颜色和该行背景足够接近的像素算背景（人物有深色描边，泛洪会停在描边外）；
//   3. 上半部分（背景偏蓝）里被手臂、头发围住的背景小块也一并去掉；下半部分背景接近白色，
//      和白围裙分不开，所以不做这一步，避免把围裙挖空；
//   4. 边缘按「离背景有多远」给半透明，并把背景色从边缘像素里减掉，去掉蓝白色的毛边。
import { spawnSync } from 'node:child_process';

const [ff, input, output, outW = '220', fps = '15', previewDir = ''] = process.argv.slice(2);
const W = 342, H = 337;

const raw = spawnSync(ff, ['-v', 'error', '-i', input, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
if (raw.status !== 0) { console.error(String(raw.stderr)); process.exit(1); }
const buf = raw.stdout;
const FRAME = W * H * 4;
const nFrames = Math.floor(buf.length / FRAME);
console.log('frames', nFrames);

/* ---------- 1. 每行背景色 ---------- */
const EDGE = 4;
const bg = [];
for (let y = 0; y < H; y++) {
  const rs = [], gs = [], bs = [];
  for (let f = 0; f < nFrames; f += 3) {
    const base = f * FRAME + y * W * 4;
    for (const x of [...Array(EDGE).keys(), ...Array.from({ length: EDGE }, (_, i) => W - 1 - i)]) {
      const i = base + x * 4;
      rs.push(buf[i]); gs.push(buf[i + 1]); bs.push(buf[i + 2]);
    }
  }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  bg.push([med(rs), med(gs), med(bs)]);
}
// 背景是平滑渐变：沿竖向做一次平滑，压掉个别被人物挡住的行
const bgS = bg.map((_, y) => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let k = -6; k <= 6; k++) { const v = bg[Math.min(H - 1, Math.max(0, y + k))]; r += v[0]; g += v[1]; b += v[2]; n++; }
  return [r / n, g / n, b / n];
});
const satOf = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
const bluish = bgS.map((c) => satOf(c) >= 40);
console.log('bg top', bgS[2].map(Math.round), 'mid', bgS[H >> 1].map(Math.round), 'bottom', bgS[H - 3].map(Math.round));

/* ---------- 2–4. 每帧去底 ---------- */
const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];
const T_HARD = 26;   // 小于这个距离：一定是背景
const T_SOFT = 60;   // 介于两者之间：边缘，半透明
const T_FLOOR = 36;  // 背景接近白色的行（地面一带）：浅灰的地面阴影也算背景
const tHard = bluish.map((b) => (b ? T_HARD : T_FLOOR));
const out = Buffer.alloc(nFrames * FRAME);
const dist = (i, y, px) => {
  const c = bgS[y];
  const dr = px[i] - c[0], dg = px[i + 1] - c[1], db = px[i + 2] - c[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

for (let f = 0; f < nFrames; f++) {
  const px = buf.subarray(f * FRAME, (f + 1) * FRAME);
  const isBg = new Uint8Array(W * H);
  const stack = [];
  const seed = (x, y) => { const p = y * W + x; if (!isBg[p] && dist(p * 4, y, px) < tHard[y]) { isBg[p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1); }
  for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y); }
  while (stack.length) {
    const p = stack.pop(), x = p % W, y = (p / W) | 0;
    if (x > 0) seed(x - 1, y);
    if (x < W - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < H - 1) seed(x, y + 1);
  }
  // 上半部分被围住的背景小块：背景偏蓝的行里，和背景很接近的连通块也去掉
  const seen = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    if (!bluish[y]) continue;
    for (let x = 0; x < W; x++) {
      const p0 = y * W + x;
      if (isBg[p0] || seen[p0] || dist(p0 * 4, y, px) >= T_HARD * 0.8) continue;
      const comp = [p0]; seen[p0] = 1;
      for (let k = 0; k < comp.length; k++) {
        const p = comp[k], cx = p % W, cy = (p / W) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d], ny = cy + DY[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (seen[q] || isBg[q] || !bluish[ny] || dist(q * 4, ny, px) >= T_HARD * 0.8) continue;
          seen[q] = 1; comp.push(q);
        }
      }
      if (comp.length >= 25) for (const p of comp) isBg[p] = 1;
    }
  }
  // 不和人物相连的小块（少于 400 个像素）都当背景：去掉近白背景上的压缩噪点
  {
    const lab = new Int32Array(W * H).fill(-1);
    const sizes = [];
    for (let p0 = 0; p0 < W * H; p0++) {
      if (isBg[p0] || lab[p0] >= 0) continue;
      const id = sizes.length, comp = [p0]; lab[p0] = id;
      for (let k = 0; k < comp.length; k++) {
        const p = comp[k], cx = p % W, cy = (p / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (!isBg[q] && lab[q] < 0) { lab[q] = id; comp.push(q); }
        }
      }
      sizes.push(comp.length);
    }
    for (let p = 0; p < W * H; p++) if (!isBg[p] && sizes[lab[p]] < 400) isBg[p] = 1;
  }
  // 输出：背景全透明；挨着背景的一圈按距离给半透明并去掉背景色
  const o = out.subarray(f * FRAME, (f + 1) * FRAME);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      if (isBg[p]) { o[i] = o[i + 1] = o[i + 2] = o[i + 3] = 0; continue; }
      const edge = (x > 0 && isBg[p - 1]) || (x < W - 1 && isBg[p + 1]) || (y > 0 && isBg[p - W]) || (y < H - 1 && isBg[p + W]);
      let a = 1;
      if (edge) a = Math.min(1, Math.max(0.15, (dist(i, y, px) - T_HARD * 0.6) / (T_SOFT - T_HARD * 0.6)));
      const c = bgS[y];
      for (let k = 0; k < 3; k++) o[i + k] = Math.max(0, Math.min(255, Math.round((px[i + k] - (1 - a) * c[k]) / a)));
      o[i + 3] = Math.round(a * 255);
    }
  }
}

/* ---------- 预览：垫在深色和棋盘格上 ---------- */
if (previewDir) {
  for (const f of [0, Math.floor(nFrames / 3), Math.floor(nFrames * 2 / 3)]) {
    for (const [name, filter] of [['dark', `color=c=0x191919:s=${W}x${H}[b];[b][0:v]overlay`],
      ['checker', `nullsrc=s=${W}x${H},geq=lum='if(mod(floor(X/12)+floor(Y/12),2),200,255)':cb=128:cr=128[b];[b][0:v]overlay`]]) {
      const r = spawnSync(ff, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', '-',
        '-filter_complex', filter, '-frames:v', '1', `${previewDir}/cut_f${f}_${name}.png`], { input: out.subarray(f * FRAME, (f + 1) * FRAME) });
      if (r.status !== 0) console.error(String(r.stderr));
    }
  }
  console.log('previews in', previewDir);
}

/* ---------- 编码成带透明的动态 WebP ---------- */
const enc = spawnSync(ff, [
  '-v', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', '100/3', '-i', '-',
  '-vf', `fps=${fps},scale=${outW}:-1:flags=lanczos`,
  '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '78', '-compression_level', '6', '-loop', '0', '-an',
  output,
], { input: out, maxBuffer: 1 << 30 });
if (enc.status !== 0) { console.error(String(enc.stderr)); process.exit(1); }
console.log('wrote', output);
