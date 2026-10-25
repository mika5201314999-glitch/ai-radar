// 生成应用图标：纸色圆角方块 + 墨色同心环 + 钴蓝中心点（与托盘图标同一套语言）
// 纯 Node 手写 PNG/ICO 编码，不依赖图形库：node tools/make_icon.mjs [输出目录]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const PAPER = [236, 238, 230];
const INK = [22, 26, 22];
const SIGNAL = [30, 69, 196];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// 一个采样点返回 [r,g,b,a]
function shade(size, px, py) {
  const u = px - size / 2 + 0.5;
  const v = py - size / 2 + 0.5;
  const d = Math.hypot(u, v);
  const radius = 0.19 * size;
  const qx = Math.max(Math.abs(u) - (size / 2 - radius), 0);
  const qy = Math.max(Math.abs(v) - (size / 2 - radius), 0);
  const outside = Math.hypot(qx, qy) > radius;

  const small = size <= 32;
  const dotR = (small ? 0.155 : 0.13) * size;
  const ringIn = (small ? 0.26 : 0.25) * size;
  const ringOut = (small ? 0.42 : 0.4) * size;

  let col = PAPER;
  if (d <= dotR) col = SIGNAL;
  else if (d >= ringIn && d <= ringOut) col = INK;
  return [col[0], col[1], col[2], outside ? 0 : 255];
}

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = shade(size, x + (sx + 0.5) / SS - 0.5, y + (sy + 0.5) / SS - 0.5);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const i = (y * size + x) * 4;
      if (a === 0) { out[i + 3] = 0; continue; }
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, data: encodePng(s, render(s)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);

let offset = 6 + 16 * pngs.length;
const entries = [];
for (const p of pngs) {
  const e = Buffer.alloc(16);
  e[0] = p.size === 256 ? 0 : p.size;
  e[1] = p.size === 256 ? 0 : p.size;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(p.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += p.data.length;
  entries.push(e);
}

const dir = path.resolve(process.argv[2] || '.');
writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
writeFileSync(path.join(dir, 'icon-256.png'), pngs[pngs.length - 1].data);
writeFileSync(path.join(dir, 'icon-32.png'), pngs[2].data);
console.log('已生成 icon.ico / icon-256.png / icon-32.png →', dir);
