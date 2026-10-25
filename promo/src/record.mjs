// 录制情报台的真实操作画面（1920×1080），每段存成一串带时间戳的 jpg。
// 用法：node record.mjs <调试端口> <输出目录>
// 应用要用演示数据目录启动：electron . --root=<演示目录> --remote-debugging-port=<端口>
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const [port = '9340', outRoot = 'footage'] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

let id = 0;
const pending = new Map();
const listeners = new Set();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  for (const fn of listeners) fn(m);
});
const send = (method, params = {}) => new Promise((res) => { const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Page.bringToFront');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1.2, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

/** 录一段：开始截帧 → 执行动作 → 停止。帧按到达时间存，合成时再按 30fps 取样。 */
async function take(name, action) {
  const dir = path.join(outRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const t0 = Date.now();
  const onFrame = async (m) => {
    if (m.method !== 'Page.screencastFrame') return;
    const { data, sessionId } = m.params;
    const t = Date.now() - t0;
    const file = `${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(path.join(dir, file), Buffer.from(data, 'base64'));
    frames.push({ t, file });
    send('Page.screencastFrameAck', { sessionId });
  };
  listeners.add(onFrame);
  await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await sleep(300);
  await action();
  await send('Page.stopScreencast');
  listeners.delete(onFrame);
  const dur = Date.now() - t0;
  writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ dur, frames }, null, 1));
  console.log(name, frames.length, 'frames', dur, 'ms');
}

/** 主区平滑滚到 y（rAF 驱动，和真人滚动一样有缓动） */
const scrollMain = (y, ms) => js(`
  const m = document.getElementById('main'); const from = m.scrollTop; const to = ${y};
  const t0 = performance.now(); const ease = (t) => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
  await new Promise((done) => { const step = (now) => { const k = Math.min(1, (now - t0) / ${ms}); m.scrollTop = from + (to - from) * ease(k); k < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); });
  return 1;`);

// 统一起点：浅色、过渡开、在今日简报顶部
await js(`localStorage.setItem('radar.theme','light'); localStorage.setItem('radar.motion','on'); document.documentElement.dataset.theme='light'; applyMotion(); paintThemeBtn(); closeSpot(); if (S.drawer) closeDrawer(); document.getElementById('log').hidden = true; setView('today'); return 1`);
await sleep(1500);

await take('today', async () => {
  await sleep(900);
  await scrollMain(520, 2600);
  await sleep(500);
  await scrollMain(1150, 2200);
  await sleep(700);
});

await js(`document.getElementById('main').scrollTop = 0; return 1`);
await take('radar', async () => {
  await js(`setView('radar'); return 1`);
  await sleep(1300);
  for (const tab of ['frontier', 'models', 'news']) {
    await js(`document.querySelector('[data-tab=${tab}]').click(); return 1`);
    await sleep(1250);
  }
  await scrollMain(380, 1400);
  await sleep(500);
});

await take('needs', async () => {
  await js(`S.radarTab = 'new'; setView('needs'); return 1`);
  await sleep(1300);
  await scrollMain(560, 2400);
  await sleep(600);
  await scrollMain(980, 1800);
  await sleep(700);
});

await js(`setView('radar'); return 1`);
await sleep(1200);
await take('search', async () => {
  await js(`openSpot(); return 1`);
  await sleep(450);
  const q = 'vision';
  for (let i = 1; i <= q.length; i++) {
    await js(`const el = document.getElementById('spotInput'); el.value = ${JSON.stringify(q.slice(0, i))}; await runSearch(el.value); return 1`);
    await sleep(150);
  }
  await sleep(700);
  for (let i = 0; i < 3; i++) { await js(`S.spot.sel = Math.min(S.spot.sel + 1, S.spot.items.length - 1); paintSpot(); return 1`); await sleep(380); }
  await sleep(700);
});
await js(`closeSpot(); return 1`);

await js(`setView('today'); return 1`);
await sleep(1300);
await take('theme', async () => {
  await sleep(500);
  await js(`document.getElementById('btnTheme').click(); return 1`);
  await sleep(1300);
  await js(`setView('radar'); return 1`);
  await sleep(1400);
});
// 回到浅色，给下面的静帧用
await js(`localStorage.setItem('radar.theme','light'); document.documentElement.dataset.theme='light'; paintThemeBtn(); return 1`);

// 静帧：模板库、概念词典、扩展能力、对话、用途卡
const still = async (name, expr, wait = 1600) => {
  await js(expr);
  await sleep(wait);
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  mkdirSync(path.join(outRoot, 'stills'), { recursive: true });
  writeFileSync(path.join(outRoot, 'stills', `${name}.jpg`), Buffer.from(s.result.data, 'base64'));
  console.log('still', name);
};
await still('tasks', `setView('tasks'); return 1`);
await still('concepts', `setView('concepts'); return 1`);
await still('ext', `setView('ext'); return 1`, 2600);
await still('chat', `setView('chat'); return 1`);
await still('usecase', `setView('radar'); await new Promise(r=>setTimeout(r,1200)); document.querySelector('[data-tab=new]').click(); await new Promise(r=>setTimeout(r,600)); document.querySelector('[data-act=uc]').click(); return 1`, 2600);
await js(`closeUsecase(); setView('today'); return 1`);

await send('Emulation.clearDeviceMetricsOverride');
console.log('errs', await js(`return JSON.stringify(window.__errs)`));
ws.close();
