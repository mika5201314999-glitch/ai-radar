// 用 CDP 直接截渲染画面（不受窗口遮挡影响）：node tools/shot2.mjs 9222 out.png
import { writeFileSync } from 'node:fs';

const port = process.argv[2] || '9222';
const out = process.argv[3] || 'shot.png';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html')) || targets.find((t) => t.type === 'page');
if (!page) { console.log('NO_PAGE'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

let nextId = 0;
const send = (method, params) =>
  new Promise((res) => {
    const id = ++nextId;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', onMsg); res(msg); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (!r.result?.data) { console.log('FAIL', JSON.stringify(r)); process.exit(1); }
writeFileSync(out, Buffer.from(r.result.data, 'base64'));
console.log('SAVED', out);
ws.close();
