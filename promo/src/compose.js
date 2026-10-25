// 宣传短片的时间轴：renderAt(t) 把画面摆到第 t 秒的样子（纯函数，逐帧渲染用）。
// 画面素材由 render.cjs 通过 ?footage=<目录 URL> 传进来：每段一个子目录，frames.json 记着每帧的时间。
'use strict';

const qs = new URLSearchParams(location.search);
const FOOT = (qs.get('footage') || '').replace(/\/$/, '');

/* ---------- 缓动：和应用里一样的两条曲线 ---------- */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const d = sx(t) - x; if (Math.abs(d) < 1e-5) break; const s = dx(t); if (Math.abs(s) < 1e-6) break; t -= d / s; }
    return sy(t);
  };
}
const mech = bezier(0.7, 0, 0.2, 1);
const snap = bezier(0.16, 1, 0.3, 1);
const clamp = (v) => Math.max(0, Math.min(1, v));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const $ = (id) => document.getElementById(id);

/* ---------- 场次（秒） ---------- */
const SCENES = [
  ['s-open', 0, 3.8],
  ['s-mark', 3.8, 7.4],
  ['s-today', 7.4, 14.6],
  ['s-radar', 14.6, 21.8],
  ['s-needs', 21.8, 28.9],
  ['s-search', 28.9, 33.1],
  ['s-theme', 33.1, 36.6],
  ['s-more', 36.6, 41.0],
  ['s-end', 41.0, 46.5],
];
const DURATION = 46.5;

/* ---------- 真实画面：按时间取帧 ---------- */
const footage = {};
async function loadFootage() {
  for (const seg of ['today', 'radar', 'needs', 'search', 'theme']) {
    const j = await (await fetch(`${FOOT}/${seg}/frames.json`)).json();
    footage[seg] = j.frames;
  }
}
function frameAt(seg, sec, lead = 0.3) {
  const fr = footage[seg];
  const ms = (sec + lead) * 1000;
  let lo = 0, hi = fr.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (fr[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return `${FOOT}/${seg}/${fr[ans].file}`;
}

const pendingImgs = [];
function setImg(el, src) {
  if (el.dataset.src === src) return;
  el.dataset.src = src;
  el.src = src;
  pendingImgs.push(el.decode().catch(() => {}));
}

/* ---------- 小工具：擦入 / 淡入上移 ---------- */
// 从左擦入（clip-path），k: 0..1
const wipe = (el, k) => { el.style.clipPath = `inset(-20px ${(1 - k) * 100}% -20px -20px)`; };
const rise = (el, k, dy = 24) => { el.style.opacity = k; el.style.transform = `translateY(${(1 - k) * dy}px)`; };
const out = (el, k) => { el.style.opacity = 1 - k; };

/* ---------- 各场 ---------- */
function sceneOpen(t) {
  $('openTri').style.transform = `scaleX(${mech(prog(t, 0.1, 0.8))})`;
  $('openTri').style.transformOrigin = 'left';
  rise($('openEb'), snap(prog(t, 0.2, 0.6)), 12);
  wipe($('openL1'), mech(prog(t, 0.45, 0.95)));
  wipe($('openL2'), mech(prog(t, 1.15, 1.65)));
  rise($('openL3'), snap(prog(t, 1.9, 2.5)), 30);
}

function sceneMark(t) {
  rise($('markSeal'), snap(prog(t, 0.15, 0.5)), 18);
  wipe($('markWm'), mech(prog(t, 0.3, 0.85)));
  wipe($('markWm2'), mech(prog(t, 0.6, 1.1)));
  const m = $('markMarker');
  m.style.backgroundSize = `${mech(prog(t, 1.15, 1.55)) * 100}% 100%`;
  m.style.background = `linear-gradient(var(--signal), var(--signal)) left / ${mech(prog(t, 1.15, 1.55)) * 100}% 100% no-repeat`;
  m.style.color = prog(t, 1.15, 1.55) > 0.05 ? 'var(--ink)' : 'transparent';
  rise($('markFacts'), snap(prog(t, 1.6, 2.1)), 16);
}

function sceneFeature(t, key, len) {
  const sc = $(`s-${key}`);
  wipe($(`${key}Fill`), mech(prog(t, 0.25, 0.85)));
  const parts = sc.querySelectorAll('.cap > :not(.no)');
  parts.forEach((p, i) => rise(p, snap(prog(t, 0.2 + i * 0.1, 0.65 + i * 0.1)), 22));
  rise(sc.querySelector('.cap .no'), snap(prog(t, 0.05, 0.4)), 16);
  const shot = $(`${key}Shot`);
  const k = mech(prog(t, 0.1, 0.65));
  shot.style.clipPath = `inset(-30px ${(1 - k) * 100}% -90px -30px)`;
  const push = 1 + 0.025 * prog(t, 0, len);
  shot.style.transform = `scale(${push})`;
  shot.style.transformOrigin = '50% 50%';
  const img = $(`${key}Img`);
  img.style.transform = 'scale(0.75)';
  setImg(img, frameAt(key, t));
  rise(shot.querySelector('.plate'), snap(prog(t, 1.2, 1.7)), 14);
}

function sceneFull(t, key, len, zoom) {
  const img = $(`${key}Img`);
  setImg(img, frameAt(key, t));
  const z = zoom(t / len);
  img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
  const bar = $(`${key}Bar`);
  const k = mech(prog(t, 0.35, 0.85));
  bar.style.clipPath = `inset(0 ${(1 - k) * 100}% 0 0)`;
}

function sceneMore(t) {
  rise($('moreHead'), snap(prog(t, 0.05, 0.5)), 20);
  ['t1', 't2', 't3', 't4'].forEach((id, i) => {
    const el = $(id);
    const k = mech(prog(t, 0.2 + i * 0.12, 0.65 + i * 0.12));
    el.style.clipPath = `inset(-70px ${(1 - k) * 100}% -10px -10px)`;
  });
}

function sceneEnd(t) {
  wipe($('endName'), mech(prog(t, 0.15, 0.7)));
  wipe($('endZh'), mech(prog(t, 0.4, 0.9)));
  $('endList').querySelectorAll('li').forEach((li, i) => rise(li, snap(prog(t, 0.9 + i * 0.15, 1.4 + i * 0.15)), 20));
  rise($('endCta'), snap(prog(t, 1.7, 2.2)), 20);
  rise($('endCredit'), snap(prog(t, 2.0, 2.5)), 8);
  $('endBtn').classList.toggle('on', t > 2.7);
}

/* ---------- 换场快门：一块墨色从右往左扫过，前缘一道黄 ---------- */
function shutter(t) {
  const sh = $('shutter');
  let shown = false;
  for (let i = 1; i < SCENES.length; i++) {
    const b = SCENES[i][1];
    if (i === 1) continue; // 开场本来就是深色，直接揭开
    const k = prog(t, b - 0.28, b + 0.28);
    if (k > 0 && k < 1) {
      const x = 100 - mech(k) * 200; // 100% → -100%
      sh.style.display = 'block';
      sh.style.transform = `translateX(${x}%)`;
      shown = true;
    }
  }
  if (!shown) sh.style.display = 'none';
}

/* 开场到字标：纸面从左擦开 */
function openToMark(t) {
  const k = mech(prog(t, 3.55, 4.05));
  $('s-mark').style.clipPath = `inset(0 ${(1 - k) * 100}% 0 0)`;
}

async function renderAt(t) {
  pendingImgs.length = 0;
  for (const [id, a, b] of SCENES) {
    const vis = id === 's-open' ? t < 4.1 : id === 's-mark' ? t >= 3.5 && t < b : t >= a && t < b;
    $(id).style.display = vis ? 'block' : 'none';
    $(id).style.zIndex = id === 's-mark' ? 2 : 1;
  }
  const local = (id) => t - SCENES.find((s) => s[0] === id)[1];
  if (t < 4.1) sceneOpen(t);
  if (t >= 3.5 && t < 7.4) { sceneMark(Math.max(0, local('s-mark'))); openToMark(t); }
  if (t >= 7.4 && t < 14.6) sceneFeature(local('s-today'), 'today', 7.2);
  if (t >= 14.6 && t < 21.8) sceneFeature(local('s-radar'), 'radar', 7.2);
  if (t >= 21.8 && t < 28.9) sceneFeature(local('s-needs'), 'needs', 7.1);
  if (t >= 28.9 && t < 33.1) sceneFull(local('s-search'), 'search', 4.2, (p) => {
    // 先整屏，再推近到搜索框（框的中心约在 800, 420）
    const s = 1.2 + 0.22 * snap(clamp((p - 0.15) / 0.6));
    return { s, x: 960 - 800 * s, y: 540 - 418 * s };
  });
  if (t >= 33.1 && t < 36.6) sceneFull(local('s-theme'), 'theme', 3.5, () => ({ s: 1.2, x: 0, y: 0 }));
  if (t >= 36.6 && t < 41.0) sceneMore(local('s-more'));
  if (t >= 41.0) sceneEnd(local('s-end'));
  shutter(t);
  await Promise.all(pendingImgs);
  await new Promise((r) => setTimeout(r, 0));
  return true;
}

async function init() {
  await document.fonts.ready;
  await loadFootage();
  for (const n of ['tasks', 'concepts', 'ext', 'chat']) {
    const el = $(`img-${n}`);
    el.src = `${FOOT}/stills/${n}.jpg`;
    await el.decode().catch(() => {});
  }
  window.DURATION = DURATION;
  window.renderAt = renderAt;
  window.ready = true;
}
init();
