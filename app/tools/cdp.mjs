// 调试用：通过 CDP 在渲染进程里执行一段 JS 并打印结果（Node 22+ 自带 WebSocket）
const port = process.argv[2] || '9222';
const expr = process.argv[3] || 'document.title';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html')) || targets.find((t) => t.type === 'page');
if (!page) { console.log('NO_PAGE', JSON.stringify(targets.map((t) => [t.type, t.url]))); process.exit(1); }

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

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
else console.log(typeof r.result?.result?.value === 'string' ? r.result.result.value : JSON.stringify(r.result?.result?.value, null, 2));
ws.close();
