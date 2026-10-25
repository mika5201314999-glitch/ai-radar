// 本地假接口，只用来验证对话/画像流程，不参与正式运行。
import http from 'node:http';

const REPLY = [
  '先说结论：这套东西你现在就能用，不用等新模型。',
  '',
  '1. **把精灵图转法线贴图**：材料里的 `Hugo-Dz/spritefusion-sprite-normals` 就是干这个的，MIT，657 星。',
  '2. **本地看截图**：`nemotron-3.5-bolt` 可以当 UI 截图审查器，8G 显存应该够。',
  '',
  '→ 对我：先拿火把和月亮试一张法线图，看光能不能把地面顶起来。',
].join('\n');

const PATCH = {
  project: { summary: 'Godot 像素中世纪游戏，负责 UI、美术、光照', stack: 'Godot 4.7.2 / GDScript', goals: '让像素画面有可信的光' },
  needs: [
    { topic: '像素素材与光照', detail: '需要批量生成法线贴图，让 2D 光照像样', keywords: ['sprite', 'normal', 'godot', 'shader'], weight: 3 },
    { topic: '本地小模型跑 UI 审查', detail: '想在 8G 显存的显卡上跑视觉模型看截图', keywords: ['local', 'vision', 'ollama'], weight: 2 },
  ],
};

const sse = (res, text) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const parts = text.match(/[\s\S]{1,18}/g) || [''];
  let i = 0;
  const timer = setInterval(() => {
    if (i >= parts.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      clearInterval(timer);
      return;
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n');
  }, 15);
};

http
  .createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end('no');
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const sys = (payload.messages && payload.messages[0] && payload.messages[0].content) || '';
      if (sys.includes('只输出 JSON')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(PATCH) } }] }));
        return;
      }
      if (payload.stream) { sse(res, REPLY); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: REPLY } }] }));
    });
  })
  .listen(8799, '127.0.0.1', () => console.log('[mock] listening 8799'));
