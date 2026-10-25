'use strict';
/**
 * AI 情报台 — 主进程
 *
 * 职责：开窗口 / 托盘 / 每日定时采集 / 调采集器 / 调模型生成简报 / 读写数据。
 * 数据全在父目录（ai-radar/），App 只做壳，不复制数据。
 */
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, clipboard, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// 技能归类规则与采集器共用一份（ai-radar/skills.mjs），避免两边漂移。
let SKILLS_LIB = null;
async function skillsLib() {
  if (!SKILLS_LIB) SKILLS_LIB = await import(pathToFileURL(path.join(ROOT, 'skills.mjs')).href);
  return SKILLS_LIB;
}

/** 从一堆仓库里挑技能并按 agent 分组；规则在 skills.mjs。
 *  registry = skills.sh 的安装榜（跨 agent，按安装量），单独成组放在最前面。 */
async function buildSkillPack(pool, registry) {
  try {
    const lib = await skillsLib();
    const picked = lib.pickSkills(pool);
    const groups = lib.groupSkills(picked);
    const reg = Array.isArray(registry) ? registry : registry?.items || [];
    if (reg.length) {
      groups.unshift({
        key: 'skills.sh',
        label: 'skills.sh 安装榜',
        note: '跨 agent 的技能市场，按安装量排（不是 GitHub 星星）',
        items: reg.slice(0, 80).map((s) => ({ ...s, _registry: true })),
      });
    }
    return {
      total: picked.length + reg.length,
      github: picked.length,
      registry: reg.length,
      groups,
    };
  } catch (err) {
    return { total: 0, github: 0, registry: 0, groups: [], error: err.message || String(err) };
  }
}

// 数据目录（ai-radar 根）解析顺序：--root= 参数 → RADAR_ROOT 环境变量 →
// 打包后（bin\AI 情报台.exe）取 exe 的上一级 → 开发运行取 app 的上一级。
const ROOT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--root='));
  if (arg) return path.resolve(arg.slice('--root='.length));
  if (process.env.RADAR_ROOT) return path.resolve(process.env.RADAR_ROOT);
  return app.isPackaged
    ? path.resolve(path.dirname(app.getPath('exe')), '..')
    : path.resolve(__dirname, '..');
})();
const DIR = {
  data: path.join(ROOT, 'data'),
  inbox: path.join(ROOT, 'inbox'),
  digests: path.join(ROOT, 'digests'),
  prompts: path.join(ROOT, 'prompts'),
  state: path.join(ROOT, 'state'),
  chats: path.join(ROOT, 'chats'),
  config: path.join(ROOT, 'app', 'config.json'),
};

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  scheduleEnabled: true,
  scheduleTime: '08:00',
  matchEnabled: true,
  lastAutoCollect: '',
  onboarded: false,   // 首次引导是否走完
  pushDaily: true,    // 每天第一次打开时托盘/通知提醒一次
  summaryAll: false,  // AI 摘要（按栏批量摘要）默认关
  compact: true,      // 简洁模式：收起灰字说明、代码块与思考过程
  webSearch: true,    // 对话时先联网搜一次（Bing RSS），把结果当材料喂给模型
  priceIn: 0,         // $/百万 token 输入价，填了才估算花费
  priceOut: 0,
  lastNotice: '',
};

let win = null;
let tray = null;
let config = { ...DEFAULT_CONFIG };
let collectChild = null;
let isCollecting = false;
let isGenerating = false;

/* ------------------------------------------------------------------ utils */

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hhmm = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readText = async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } };
const readJSON = async (p, fb) => { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fb; } };
const send = (channel, payload) => { try { win?.webContents.send(channel, payload); } catch {} };

async function loadConfig() {
  config = { ...DEFAULT_CONFIG, ...(await readJSON(DIR.config, {})) };
  return config;
}
async function saveConfig(patch) {
  config = { ...config, ...patch };
  await fsp.mkdir(path.dirname(DIR.config), { recursive: true });
  await fsp.writeFile(DIR.config, JSON.stringify(config, null, 2), 'utf8');
  return config;
}
function publicConfig() {
  const key = config.apiKey || '';
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    scheduleEnabled: config.scheduleEnabled,
    scheduleTime: config.scheduleTime,
    matchEnabled: config.matchEnabled !== false,
    onboarded: config.onboarded === true,
    pushDaily: config.pushDaily !== false,
    summaryAll: config.summaryAll === true,
    compact: config.compact !== false,
    webSearch: config.webSearch !== false,
    priceIn: Number(config.priceIn) || 0,
    priceOut: Number(config.priceOut) || 0,
    hasKey: !!key,
    keyHint: key ? `${key.slice(0, 5)}…${key.slice(-4)}` : '',
  };
}
async function listDates() {
  const out = new Map();
  const add = (dir, kind) => {
    let items = [];
    try { items = fs.readdirSync(dir); } catch { return; }
    for (const f of items) {
      if (!f.endsWith('.md') && !f.endsWith('.json')) continue;
      const d = path.basename(f).replace(/\.(md|json)$/, '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const rec = out.get(d) || { date: d, data: false, digest: false };
      rec[kind] = true;
      out.set(d, rec);
    }
  };
  add(DIR.data, 'data');
  add(DIR.digests, 'digest');
  return [...out.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/* ------------------------------------------------------------------ icons */

/** 用原始 BGRA 位图手绘托盘图标：墨色同心环 + 蓝色中心点。 */
function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const ink = [22, 26, 22];
  const blue = [30, 69, 196];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c);
      let color = null;
      if (r <= size * 0.17) color = blue;
      else if (r >= size * 0.36 && r <= size * 0.45) color = ink;
      else if (r >= size * 0.47 && r <= size * 0.5) color = ink;
      const i = (y * size + x) * 4;
      if (color) {
        const a = r > size * 0.44 && r < size * 0.47 ? 90 : 255;
        buf[i] = color[2]; buf[i + 1] = color[1]; buf[i + 2] = color[0]; buf[i + 3] = a;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/* ------------------------------------------------------------------ collect */

function runCollect() {
  if (isCollecting) return { ok: false, error: '采集已经在跑了，等它结束。' };
  const script = path.join(ROOT, 'collect.mjs');
  if (!exists(script)) return { ok: false, error: `找不到采集器：${script}` };

  isCollecting = true;
  const started = Date.now();
  send('collect:log', { line: `开始采集 ${todayStr()} …`, kind: 'head' });

  collectChild = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });

  let killedByTimeout = false;
  const timer = setTimeout(() => {
    killedByTimeout = true;
    try { collectChild.kill(); } catch {}
  }, 240_000);

  const pump = (stream) => {
    let rest = '';
    stream.on('data', (chunk) => {
      rest += chunk.toString('utf8');
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() || '';
      for (const line of lines) if (line.trim()) send('collect:log', { line: line.trim(), kind: 'out' });
    });
  };
  pump(collectChild.stdout);
  pump(collectChild.stderr);

  collectChild.on('error', (err) => {
    clearTimeout(timer);
    isCollecting = false;
    collectChild = null;
    send('collect:done', { ok: false, error: err.message, seconds: (Date.now() - started) / 1000 });
  });

  collectChild.on('close', (code) => {
    clearTimeout(timer);
    isCollecting = false;
    collectChild = null;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (killedByTimeout) {
      send('collect:done', { ok: false, error: '超过 4 分钟没结束，已中止（多半是某个源卡住了）。', seconds });
      return;
    }
    if (code === 0) send('collect:done', { ok: true, seconds, date: todayStr() });
    else send('collect:done', { ok: false, error: `采集器退出码 ${code}，看上面的日志。`, seconds });
  });

  return { ok: true };
}

/* ------------------------------------------------------------- 历史档案 */

let isArchiving = false;

/** 跑 backfill.mjs：抓最近 N 个月创建的仓库与上架的模型，写 data/archive.json。 */
function runArchive() {
  if (isArchiving) return Promise.resolve({ ok: false, error: '档案已经在更新了，等它结束。' });
  const script = path.join(ROOT, 'backfill.mjs');
  if (!exists(script)) return Promise.resolve({ ok: false, error: `找不到档案脚本：${script}` });

  isArchiving = true;
  const started = Date.now();
  send('archive:log', { line: '开始更新历史档案（最近 3 个月）…', kind: 'head' });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch {} }, 300_000);
    let tail = '';
    const pump = (stream) => {
      let rest = '';
      stream.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        tail = (tail + s).slice(-600);
        rest += s;
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() || '';
        for (const line of lines) if (line.trim()) send('archive:log', { line: line.trim(), kind: 'out' });
      });
    };
    pump(child.stdout);
    pump(child.stderr);
    child.on('error', (err) => {
      clearTimeout(timer);
      isArchiving = false;
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      isArchiving = false;
      const seconds = Math.round((Date.now() - started) / 1000);
      resolve(killed
        ? { ok: false, error: '超过 5 分钟没结束，已中止。', seconds }
        : { ok: code === 0, error: code === 0 ? '' : `退出码 ${code}`, seconds, tail });
    });
  });
}

/* ------------------------------------------------------------------ generate */

async function recentDigests(date, n = 3) {
  let files = [];
  try { files = fs.readdirSync(DIR.digests).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse(); } catch { return ''; }
  const older = files.filter((f) => f.slice(0, 10) < date).slice(0, n);
  const parts = [];
  for (const f of older) {
    const t = await readText(path.join(DIR.digests, f));
    if (t) parts.push(`<前一份 ${f.slice(0, 10)}>\n${t.slice(0, 6000)}\n</前一份>`);
  }
  return parts.join('\n\n');
}

function oneLiner(md) {
  const m = md.match(/##\s*一句话\s*\n+([\s\S]*?)(?=\n##\s|$)/);
  const text = (m ? m[1] : md).replace(/\s+/g, ' ').replace(/[*`#>]/g, '').trim();
  const first = text.split(/(?<=[。！？])/)[0] || text;
  return first.slice(0, 46);
}

async function updateIndex(date, md) {
  const p = path.join(DIR.digests, 'INDEX.md');
  const cur = (await readText(p)) || '# 简报索引\n\n';
  const line = `- ${date} · ${oneLiner(md)}`;
  const lines = cur.split(/\r?\n/).filter((l) => l.trim().length);
  const idx = lines.findIndex((l) => l.startsWith(`- ${date}`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  const head = lines.filter((l) => !l.startsWith('- '));
  const rows = lines.filter((l) => l.startsWith('- ')).sort().reverse();
  await fsp.writeFile(p, [...head, '', ...rows].join('\n') + '\n', 'utf8');
}

async function generateDigest(date) {
  if (isGenerating) throw new Error('已经在生成了。');
  if (!config.apiKey) throw new Error('还没填 API key。去「设置」填一个，就能在这里直接生成。');
  const briefPath = path.join(DIR.inbox, `${date}.md`);
  const brief = await readText(briefPath);
  if (!brief) throw new Error(`没有 ${date} 的采集原件。先点左边的「开始采集」。`);
  const sys = (await readText(path.join(DIR.prompts, 'app_digest.md'))) || '把原始信息整理成中文情报简报。';
  const prev = await recentDigests(date);

  const userMsg = [
    `今天是 ${date}。`,
    '',
    '<原始采集>',
    brief.slice(0, 120_000),
    '</原始采集>',
    prev ? `\n${prev}` : '',
    '',
    '按系统提示里的格式，直接输出 Markdown 正文。',
  ].join('\n');

  const base = (config.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
  isGenerating = true;
  const started = Date.now();
  const ticker = setInterval(() => {
    send('digest:tick', { seconds: Math.round((Date.now() - started) / 1000) });
  }, 1000);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.3,
        max_tokens: 4000,
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`接口返回 ${res.status}：${body.slice(0, 300)}`);
    }
    const json = await res.json();
    let md = (json?.choices?.[0]?.message?.content || '').trim();
    if (!md) throw new Error('接口返回了空内容，检查模型名是否正确。');
    if (!md.startsWith('#')) md = `# AI 情报 ${date}\n\n${md}`;
    await fsp.mkdir(DIR.digests, { recursive: true });
    await fsp.writeFile(path.join(DIR.digests, `${date}.md`), md + '\n', 'utf8');
    await updateIndex(date, md);
    return { ok: true, markdown: md, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    clearInterval(ticker);
    isGenerating = false;
  }
}

/* ------------------------------------------------------------------ index */

/** 跨天索引：搜索用 + 项目星标历史用。数据文件变了才重建。 */
let IDX = { key: '', items: [], hist: new Map(), dates: [] };

function dataKey() {
  let files = [];
  try { files = fs.readdirSync(DIR.data).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch { return ''; }
  const parts = files.sort().map((f) => {
    try { const s = fs.statSync(path.join(DIR.data, f)); return `${f}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return f; }
  });
  try {
    const s = fs.statSync(path.join(DIR.data, 'archive.json'));
    parts.push(`archive:${s.size}:${Math.round(s.mtimeMs)}`);
  } catch {}
  try {
    const s = fs.statSync(path.join(ROOT, 'agents.json'));
    parts.push(`agents:${s.size}:${Math.round(s.mtimeMs)}`);
  } catch {}
  try {
    const s = fs.statSync(path.join(ROOT, 'concepts.json'));
    parts.push(`concepts:${s.size}:${Math.round(s.mtimeMs)}`);
  } catch {}
  try {
    const s = fs.statSync(path.join(DIR.state, 'exthub.json'));
    parts.push(`exthub:${s.size}:${Math.round(s.mtimeMs)}`);
  } catch {}
  return parts.join('|');
}

async function buildIndex() {
  const key = dataKey();
  if (IDX.key === key && IDX.items.length) return IDX;

  const items = [];
  const hist = new Map();
  const dates = [];
  let files = [];
  try {
    files = fs.readdirSync(DIR.data).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  } catch { files = []; }

  for (const f of files) {
    const date = f.slice(0, 10);
    dates.push(date);
    const d = await readJSON(path.join(DIR.data, f), null);
    if (!d) continue;
    const push = (kind, title, sub, url, extra) => {
      if (!title) return;
      items.push({ kind, date, title: String(title), sub: String(sub == null ? '' : sub).slice(0, 300), url: String(url || ''), ...(extra || {}) });
    };
    for (const list of [d.github?.new_repos, d.github?.active, d.github?.ai_new]) {
      for (const r of Array.isArray(list) ? list : []) {
        push('repo', r.full_name, [r.desc, Array.isArray(r.topics) ? r.topics.join(' ') : ''].filter(Boolean).join(' · '), r.url, { stars: r.stars, lang: r.lang });
        if (r.full_name && typeof r.stars === 'number') {
          const s = hist.get(r.full_name) || [];
          if (!s.some((p) => p[0] === date)) s.push([date, r.stars]);
          hist.set(r.full_name, s);
        }
      }
    }
    for (const m of Array.isArray(d.models?.openrouter_new) ? d.models.openrouter_new : []) {
      push('model', m.name || m.id, `${m.id} · ${m.context ? Math.round(m.context / 1000) + 'K' : '?'} 上下文 · $${m.prompt_price}/${m.completion_price} · ${m.modality || ''}`, `https://openrouter.ai/${m.id}`);
    }
    for (const m of Array.isArray(d.models?.ollama_new) ? d.models.ollama_new : []) {
      push('model', m.name, [m.desc, (m.caps || []).join(' ')].filter(Boolean).join(' · '), `https://ollama.com/library/${m.name}`);
    }
    for (const n of Array.isArray(d.news) ? d.news : []) push('news', n.title, `${n.source || ''} ${n.summary || ''}`, n.link);
    for (const p of Array.isArray(d.papers) ? d.papers : []) push('paper', p.title, p.summary, p.link);
    for (const h of Array.isArray(d.hn) ? d.hn : []) push('hn', h.title, `${h.points || 0} pts · ${h.comments || 0} 评论`, h.url || h.hn);
    for (const v of Array.isArray(d.bilibili?.items) ? d.bilibili.items : []) {
      push('video', v.title, `${v.author || ''} · ${v.play || 0} 播放 · ${v.why || ''} · B站`, v.url, { play: v.play });
    }
    for (const z of Array.isArray(d.zhihu?.items) ? d.zhihu.items : []) {
      push('zhihu', z.title, `${z.heat || ''} · 知乎热榜`, z.url);
    }
    // 前沿动态：搜标题能查到「到哪一步了」（论文/有代码/有演示/正式可用）
    if (f === files[0]) {
      for (const x of Array.isArray(d.frontier?.items) ? d.frontier.items : []) {
        push('frontier', x.title, `${x.status_label || ''} · ${x.can_do || ''} · ${(x.keywords || []).join(' ')} · ${x.ai_summary || x.summary || ''}`.slice(0, 400), x.hf || x.arxiv, {
          status: x.status,
        });
      }
    }
    // skills.sh 榜单：搜技能名就能找到安装命令（榜单每天是同一份快照，只索引最新那天）
    if (f === files[0]) {
      for (const s of Array.isArray(d.skills_sh?.items) ? d.skills_sh.items : []) {
        push('skill', s.name, `${s.source} · 安装 ${s.installs} · ${s.cmd}`, s.url, { skillsSh: true });
      }
    }
  }

  // 历史档案（backfill.mjs 抓的三个月仓库与模型）也进索引，Ctrl+K 能往回搜
  const arch = await readJSON(path.join(DIR.data, 'archive.json'), null);
  if (arch) {
    const add = (kind, title, sub, url, date, extra) => {
      if (!title) return;
      items.push({ kind, date: String(date || '').slice(0, 10), title: String(title), sub: String(sub == null ? '' : sub).slice(0, 300), url: String(url || ''), ...(extra || {}) });
    };
    for (const r of arch.github?.repos || []) {
      add('repo', r.full_name, [r.desc, (r.topics || []).join(' ')].filter(Boolean).join(' · '), r.url, r.created, { stars: r.stars, lang: r.lang });
      if (r.full_name && typeof r.stars === 'number') {
        const s = hist.get(r.full_name) || [];
        if (!s.some((p) => p[0] === r.created)) s.push([r.created, r.stars]);
        hist.set(r.full_name, s);
      }
    }
    for (const r of arch.github?.ai || []) {
      add('repo', r.full_name, [r.desc, (r.topics || []).join(' ')].filter(Boolean).join(' · '), r.url, r.created, { stars: r.stars, lang: r.lang });
    }
    for (const m of arch.models?.openrouter_new || []) {
      add('model', m.name || m.id, `${m.id} · ${m.context ? Math.round(m.context / 1000) + 'K' : '?'} 上下文 · $${m.prompt_price}/${m.completion_price} · ${m.modality || ''}`, `https://openrouter.ai/${m.id}`, m.created);
    }
  }

  // 每天一份简报也进索引：搜关键词能搜到"我当时怎么判断的"
  try {
    const ds = fs.readdirSync(DIR.digests).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
    for (const f of ds) {
      const text = (await readText(path.join(DIR.digests, f))) || '';
      if (!text) continue;
      const flat = text.replace(/[#*`>\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      items.push({ kind: 'digest', date: f.slice(0, 10), title: `${f.slice(0, 10)} 的简报`, sub: flat.slice(0, 1600), url: '' });
    }
  } catch {}

  // agent 安装表也进索引：搜 "claude code" 能直接找到装法和官网
  try {
    const reg = await readJSON(path.join(ROOT, 'agents.json'), null);
    for (const a of (reg && reg.agents) || []) {
      const cmds = (a.installs || []).map((c) => `${c.label || ''} ${c.cmd || ''}`).join(' · ');
      items.push({
        kind: 'agent',
        date: String(reg.checked_at || '').slice(0, 10),
        title: a.name,
        sub: [a.vendor, a.what, a.need ? `需要 ${a.need}` : '', cmds].filter(Boolean).join(' · ').slice(0, 300),
        url: a.home || '',
        agentId: a.id,
      });
    }
  } catch {}

  // 概念页也进索引：搜 "token" 能顺手看到定义
  try {
    const cj = await readJSON(path.join(ROOT, 'concepts.json'), null);
    for (const c of (cj && cj.concepts) || []) {
      items.push({
        kind: 'concept',
        date: '',
        title: `${c.term}（${c.en}）`,
        sub: [c.plain, c.pro, c.case].filter(Boolean).join(' · ').slice(0, 400),
        url: '',
        conceptId: c.id,
      });
    }
  } catch {}

  // 扩展能力目录也进索引：搜 "obsidian git" 能直接找到那张卡片
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(DIR.state, 'exthub.json'), 'utf8'));
    for (const c of (cat && cat.rows) || []) {
      items.push({
        kind: 'ext',
        date: String((c.verified && c.verified.at) || '').slice(0, 10),
        title: c.name,
        sub: [c.kind, c.use, c.desc, c.cost, c.start].filter(Boolean).join(' · ').slice(0, 320),
        url: c.url,
        extId: c.id,
      });
    }
  } catch {}

  for (const [, s] of hist) s.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  IDX = { key, items, hist, dates };
  return IDX;
}

const KIND_LABEL = { repo: '项目', model: '模型', news: '新闻', paper: '论文', hn: 'HN', digest: '简报', agent: 'agent', concept: '概念', skill: '技能', video: 'B站', zhihu: '知乎', frontier: '前沿', ext: '扩展' };

function scoreItem(it, tokens) {
  const t = it.title.toLowerCase();
  const s = (it.sub || '').toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    const inTitle = t.includes(tok);
    const inSub = s.includes(tok);
    if (!inTitle && !inSub) return -1;
    score += inTitle ? (t.startsWith(tok) ? 6 : 4) : 1;
  }
  if (it.kind === 'repo') score += 1;
  return score;
}

/** 放宽：任意一个词命中就算，命中越多分越高。 */
function scoreItemAny(it, tokens) {
  const t = it.title.toLowerCase();
  const s = (it.sub || '').toLowerCase();
  let score = 0, hits = 0;
  for (const tok of tokens) {
    const inTitle = t.includes(tok);
    const inSub = s.includes(tok);
    if (inTitle) { score += 4; hits++; } else if (inSub) { score += 1; hits++; }
  }
  if (!hits) return -1;
  return score + (it.kind === 'repo' ? 1 : 0);
}

/* ------------------------------------------------------------------ aux（收藏 / 已读） */

const AUX = { bookmarks: {}, read: {} };
let readTimer = null;

async function loadAux() {
  AUX.bookmarks = (await readJSON(path.join(DIR.state, 'bookmarks.json'), {})) || {};
  const read = (await readJSON(path.join(DIR.state, 'read.json'), {})) || {};
  // 只留 90 天内的已读记录，避免文件无限长
  const cut = Date.now() - 90 * 86400_000;
  for (const [k, v] of Object.entries(read)) if (typeof v === 'number' && v > cut) AUX.read[k] = v;
}
function writeJSONFile(p, data) {
  return fsp.mkdir(path.dirname(p), { recursive: true })
    .then(() => fsp.writeFile(p, JSON.stringify(data, null, 2), 'utf8'))
    .catch(() => {});
}
function flushReadSoon() {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => { writeJSONFile(path.join(DIR.state, 'read.json'), AUX.read); }, 800);
}

/* ------------------------------------------------------------------ scheduler */

function scheduleTick() {
  if (!config.scheduleEnabled) return;
  if (hhmm() !== config.scheduleTime) return;
  const t = todayStr();
  if (config.lastAutoCollect === t) return;
  saveConfig({ lastAutoCollect: t });
  if (!isCollecting) runCollect();
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 960,
    minHeight: 660,
    backgroundColor: '#161616',
    title: 'AI 情报台',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    // 命令栏两套主题下都是深色，窗口按钮跟它一致
    titleBarOverlay: { color: '#161616', symbolColor: '#ededed', height: 40 },
    icon: path.join(__dirname, 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', () => { win = null; });
}

function createTray() {
  const trayIcon = exists(path.join(__dirname, 'icon-32.png'))
    ? nativeImage.createFromPath(path.join(__dirname, 'icon-32.png'))
    : makeIcon(32);
  tray = new Tray(trayIcon);
  tray.setToolTip('AI 情报台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开情报台', click: () => { if (!win) createWindow(); else { win.show(); win.focus(); } } },
    { label: '立即采集', click: () => { if (!win) createWindow(); runCollect(); } },
    { type: 'separator' },
    { label: '打开数据文件夹', click: () => shell.openPath(ROOT) },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (!win) createWindow(); else { win.show(); win.focus(); } });
}

/* ------------------------------------------------------------------ IPC */

ipcMain.handle('state:load', async () => {
  const dates = await listDates();
  const today = todayStr();
  const latest = await readJSON(path.join(DIR.data, `${today}.json`), null);
  const sources = latest?.status ? Object.entries(latest.status) : [];
  return {
    today,
    root: ROOT,
    appVersion: app.getVersion(),
    dates,
    hasBrief: exists(path.join(DIR.inbox, `${today}.md`)),
    hasDigest: exists(path.join(DIR.digests, `${today}.md`)),
    collecting: isCollecting,
    archiving: isArchiving,
    archive: await (async () => {
      const a = await readJSON(path.join(DIR.data, 'archive.json'), null);
      if (!a) return { exists: false };
      return {
        exists: true,
        generatedAt: a.generated_at || '',
        months: a.months || 3,
        since: a.since || '',
        repos: (a.github?.repos?.length || 0) + (a.github?.ai?.length || 0),
        models: a.models?.openrouter_new?.length || 0,
      };
    })(),
    generating: isGenerating,
    sources: {
      ok: sources.filter(([, v]) => v === 'ok').length,
      total: sources.length,
      failed: sources.filter(([, v]) => v !== 'ok').map(([k, v]) => `${k.replace(/^feed:/, '')}(${v})`),
    },
    collectedAt: latest?.generated_at || '',
    counts: latest ? {
      repos: (latest.github?.new_repos?.length || 0) + (latest.github?.active?.length || 0) + (latest.github?.ai_new?.length || 0),
      models: (latest.models?.openrouter_new?.length || 0) + (latest.models?.ollama_new?.length || 0),
      news: latest.news?.length || 0,
      papers: latest.papers?.length || 0,
      hn: latest.hn?.length || 0,
    } : null,
    config: publicConfig(),
  };
});

ipcMain.handle('data:load', async (_e, date) => {
  const d = await readJSON(path.join(DIR.data, `${date}.json`), null);
  if (!d) return null;
  if (!d.skills) {
    d.skills = await buildSkillPack(
      [
        ...(d.github?.new_repos || []),
        ...(d.github?.active || []),
        ...(d.github?.ai_new || []),
        ...(d.github?.skills || []),
      ],
      d.skills_sh,
    );
  }
  return d;
});

const shiftDate = (back, from) => {
  const base = from ? new Date(`${from}T00:00:00`) : new Date();
  base.setDate(base.getDate() - back);
  const p = (n) => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
};

const monthsBack = (n, from) => {
  const d = new Date(`${from}T00:00:00`);
  d.setMonth(d.getMonth() - n);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 「原始雷达」的时间范围：窗口从**今天**往前推，合并
 *   ① 窗口内每天的采集快照（data/*.json）
 *   ② data/archive.json 里的历史档案（backfill.mjs 抓的最近 3 个月仓库与模型）
 *  同一对象只留一条，快照的统计值覆盖档案的。
 *  条目额外带 last_seen（最近一次出现在哪天的采集里）和 seen_days（出现过几天）。 */
async function rangePayload(range) {
  const today = shiftDate(0);
  const cutoff = range === 'all' ? ''
    : range === 'd7' ? shiftDate(6)
    : range === 'm1' ? monthsBack(1, today)
    : range === 'm3' ? monthsBack(3, today)
    : today;
  const all = (await listDates()).filter((r) => r.data).map((r) => r.date).filter((d) => d <= today);
  const use = cutoff ? all.filter((d) => d >= cutoff) : all;
  const maps = {
    new_repos: new Map(), active: new Map(), ai_new: new Map(), skills: new Map(),
    orx: new Map(), ollama: new Map(), news: new Map(), papers: new Map(), hn: new Map(),
    bili: new Map(), zhihu: new Map(), frontier: new Map(),
  };
  const put = (map, key, item) => {
    if (!key) return;
    const prev = map.get(key);
    if (!prev) map.set(key, { ...item, last_seen: item.__d, seen_days: 1 });
    else { Object.assign(prev, item); prev.last_seen = item.__d; prev.seen_days = (prev.seen_days || 1) + 1; }
  };
  let archRepos = 0, archModels = 0, archSince = '';
  let latestSh = null;
  let latestFrontier = null;
  if (range !== 'today') {
    const arch = await readJSON(path.join(DIR.data, 'archive.json'), null);
    archSince = (arch && arch.since) || '';
    const fresh = (d) => !cutoff || String(d || '') >= cutoff;
    for (const r of arch?.github?.repos || []) {
      if (!fresh(r.created)) continue;
      put(maps.new_repos, r.full_name, { ...r, __d: r.created, _arch: true });
      archRepos++;
    }
    for (const r of arch?.github?.ai || []) {
      if (!fresh(r.created)) continue;
      put(maps.ai_new, r.full_name, { ...r, __d: r.created, _arch: true });
    }
    for (const m of arch?.models?.openrouter_new || []) {
      if (!fresh(m.created)) continue;
      put(maps.orx, m.id, { ...m, __d: m.created, _arch: true });
      archModels++;
    }
  }
  for (const date of use.slice().reverse()) {
    const d = await readJSON(path.join(DIR.data, `${date}.json`), null);
    if (!d) continue;
    if (d.skills_sh?.items?.length) latestSh = d.skills_sh;
    if (d.frontier?.items?.length) latestFrontier = d.frontier;
    for (const r of d.github?.new_repos || []) put(maps.new_repos, r.full_name, { ...r, __d: date });
    for (const r of d.github?.active || []) put(maps.active, r.full_name, { ...r, __d: date });
    for (const r of d.github?.ai_new || []) put(maps.ai_new, r.full_name, { ...r, __d: date });
    for (const r of d.github?.skills || []) put(maps.skills, r.full_name, { ...r, __d: date });
    for (const m of d.models?.openrouter_new || []) put(maps.orx, m.id, { ...m, __d: date });
    for (const m of d.models?.ollama_new || []) put(maps.ollama, m.name, { ...m, __d: date });
    for (const n of d.news || []) put(maps.news, n.link, { ...n, __d: date });
    for (const p of d.papers || []) put(maps.papers, p.link, { ...p, __d: date });
    for (const h of d.hn || []) put(maps.hn, h.hn || h.url, { ...h, __d: date });
    for (const v of d.bilibili?.items || []) put(maps.bili, v.url, { ...v, __d: date });
    for (const z of d.zhihu?.items || []) put(maps.zhihu, z.url, { ...z, __d: date });
    for (const x of d.frontier?.items || []) put(maps.frontier, x.id || x.arxiv || x.title, { ...x, __d: date });
  }
  const list = (m, fn) => [...m.values()]
    .map(({ __d, ...rest }) => rest)
    .sort(fn);
  const byNum = (k) => (a, b) => (b[k] ?? -1) - (a[k] ?? -1);
  const byStr = (k) => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));
  const data = {
    github: {
      new_repos: list(maps.new_repos, byNum('stars_per_day_since_birth')),
      active: list(maps.active, byNum('stars')),
      ai_new: list(maps.ai_new, byNum('stars_per_day_since_birth')),
      velocity: [],
    },
    models: {
      openrouter_new: list(maps.orx, byStr('created')),
      ollama_new: list(maps.ollama, byStr('last_seen')),
    },
    news: list(maps.news, (a, b) => String(b.last_seen || '').localeCompare(String(a.last_seen || ''))),
    papers: list(maps.papers, byStr('date')),
    hn: list(maps.hn, byNum('points')),
    bilibili: { source_url: 'https://www.bilibili.com', items: list(maps.bili, byNum('play')), total: maps.bili.size, scanned: 0 },
    zhihu: { source_url: 'https://www.zhihu.com', items: list(maps.zhihu, (a, b) => String(b.last_seen || '').localeCompare(String(a.last_seen || ''))), total: maps.zhihu.size, scanned: 0 },
  };
  const skillPool = [...maps.new_repos.values(), ...maps.ai_new.values(), ...maps.active.values(), ...maps.skills.values()]
    .map(({ __d, ...rest }) => rest);
  data.skills_sh = latestSh;
  data.frontier = {
    source_url: (latestFrontier && latestFrontier.source_url) || 'https://huggingface.co/papers',
    today: (latestFrontier && latestFrontier.today) || [],
    week: (latestFrontier && latestFrontier.week) || [],
    items: list(maps.frontier, byNum('signal')),
    total: maps.frontier.size,
    scanned: (latestFrontier && latestFrontier.scanned) || 0,
    status_counts: (latestFrontier && latestFrontier.status_counts) || {},
  };
  data.skills = await buildSkillPack(skillPool, latestSh);
  return {
    range,
    cutoff,
    days: use.length,
    from: cutoff || archSince || (use[use.length - 1] || ''),
    to: use[0] || today,
    archive: { repos: archRepos, models: archModels },
    data,
  };
}
ipcMain.handle('radar:range', async (_e, arg) => rangePayload((arg && arg.range) || 'today'));
ipcMain.handle('index:read', async () => {
  const text = (await readText(path.join(DIR.digests, 'INDEX.md'))) || '';
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^-\s*(\d{4}-\d{2}-\d{2})\s*·\s*(.+)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
});
ipcMain.handle('digest:read', async (_e, date) => readText(path.join(DIR.digests, `${date}.md`)));
ipcMain.handle('collect:run', () => runCollect());
ipcMain.handle('archive:run', () => runArchive());
ipcMain.handle('agents:load', async () => readJSON(path.join(ROOT, 'agents.json'), null));
ipcMain.handle('concepts:load', async () => readJSON(path.join(ROOT, 'concepts.json'), null));
/* ------------------------------------------ 对话 / 用户画像 / 猜你需要 */

const EMPTY_PROFILE = () => ({
  updated_at: '',
  project: { summary: '', stack: '', goals: '' },
  needs: [],
});
const newNeedId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function normalizeProfile(p) {
  const base = EMPTY_PROFILE();
  if (!p || typeof p !== 'object') return base;
  const proj = p.project && typeof p.project === 'object' ? p.project : {};
  return {
    updated_at: typeof p.updated_at === 'string' ? p.updated_at : '',
    project: {
      summary: String(proj.summary || '').slice(0, 400),
      stack: String(proj.stack || '').slice(0, 200),
      goals: String(proj.goals || '').slice(0, 400),
    },
    needs: (Array.isArray(p.needs) ? p.needs : [])
      .filter((n) => n && (n.topic || n.detail))
      .slice(-24)
      .map((n) => ({
        id: n.id || newNeedId(),
        topic: (String(n.topic || '') || String(n.detail || '')).slice(0, 60),
        detail: String(n.detail || '').slice(0, 300),
        keywords: (Array.isArray(n.keywords) ? n.keywords : [])
          .map((k) => String(k).trim())
          .filter((k) => k.length >= 2)
          .slice(0, 12),
        weight: Math.min(3, Math.max(1, Math.round(Number(n.weight) || 2))),
        created: String(n.created || todayStr()).slice(0, 10),
        source: String(n.source || 'chat').slice(0, 20),
        goal: String(n.goal || n.detail || '').slice(0, 300),
        software: (Array.isArray(n.software) ? n.software : []).map((x) => String(x).slice(0, 40)).slice(0, 8),
        budget: String(n.budget || '').slice(0, 80),
        device: String(n.device || '').slice(0, 120),
        difficulty: String(n.difficulty || '').slice(0, 120),
        tried: (Array.isArray(n.tried) ? n.tried : []).map((x) => String(x).slice(0, 120)).slice(0, 8),
        status: n.status === 'solved' ? 'solved' : 'open',
        solved_at: String(n.solved_at || '').slice(0, 10),
      })),
  };
}

async function loadProfile() {
  return normalizeProfile(await readJSON(path.join(DIR.state, 'profile.json'), null));
}

async function saveProfile(p) {
  const prof = normalizeProfile(p);
  prof.updated_at = new Date().toISOString();
  try {
    await fsp.mkdir(DIR.state, { recursive: true });
    await fsp.writeFile(path.join(DIR.state, 'profile.json'), JSON.stringify(prof, null, 2), 'utf8');
  } catch (e) {
    console.error('[radar] saveProfile', e);
  }
  return prof;
}

function profileSummary(p) {
  if (!p) return '（还没有记录）';
  const L = [];
  if (p.project.summary) L.push(`项目：${p.project.summary}`);
  if (p.project.stack) L.push(`技术栈：${p.project.stack}`);
  if (p.project.goals) L.push(`目标：${p.project.goals}`);
  if (p.needs.length) {
    L.push('需求：');
    p.needs.forEach((n) => {
      const bits = [`- ${n.topic}`];
      bits.push(`（关键词：${n.keywords.join('、') || '无'}；权重 ${n.weight}${n.status === 'solved' ? '；已解决' : ''}）`);
      if (n.goal) bits.push(`目标：${n.goal}`);
      if (n.software.length) bits.push(`常用软件：${n.software.join('、')}`);
      if (n.budget) bits.push(`预算：${n.budget}`);
      if (n.device) bits.push(`设备：${n.device}`);
      if (n.difficulty) bits.push(`能接受的操作难度：${n.difficulty}`);
      if (n.tried.length) bits.push(`试过但不满意：${n.tried.join('；')}`);
      L.push(bits.join(' '));
    });
  }
  return L.join('\n') || '（还没有记录）';
}

function chatPath(date) {
  return path.join(DIR.chats, `${date}.json`);
}

async function loadChat(date) {
  const t = await readJSON(chatPath(date), null);
  const msgs = (Array.isArray(t && t.messages) ? t.messages : []).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()
  );
  return { date, messages: msgs.slice(-40) };
}

async function saveChat(date, messages) {
  try {
    await fsp.mkdir(DIR.chats, { recursive: true });
    await fsp.writeFile(chatPath(date), JSON.stringify({ date, messages }, null, 2), 'utf8');
  } catch (e) {
    console.error('[radar] saveChat', e);
  }
}

function clipText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function latestPack() {
  let files = [];
  try {
    files = (await fsp.readdir(DIR.data)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  } catch {}
  for (const f of files.slice(0, 3)) {
    const d = await readJSON(path.join(DIR.data, f), null);
    if (d && d.github) return { date: f.slice(0, 10), pack: d };
  }
  return null;
}

async function materialsText() {
  const got = await latestPack();
  if (!got) return '（本机还没有采集数据）';
  const { date, pack: d } = got;
  const L = [`采集日期 ${date}。下面所有数字都来自本机采集器，不要改写也不要推测。`];
  const gh = d.github || {};
  const sk = (d.skills && Array.isArray(d.skills.groups) ? d.skills.groups : []);
  L.push('', '## GitHub 新项目');
  (gh.new_repos || []).slice(0, 10).forEach((r) => L.push(`- ${r.full_name} ⭐${r.stars}｜${r.stars_per_day_since_birth ?? '?'}/天｜${r.lang || '-'}｜${clipText(r.desc, 120)}｜${r.url}`));
  L.push('', '## AI / agent 项目');
  (gh.ai_new || []).slice(0, 8).forEach((r) => L.push(`- ${r.full_name} ⭐${r.stars}｜${clipText(r.desc, 110)}｜${r.url}`));
  L.push('', '## 高星活跃');
  (gh.active || []).slice(0, 6).forEach((r) => L.push(`- ${r.full_name} ⭐${r.stars}｜${clipText(r.desc, 100)}｜${r.url}`));
  if (sk.length) {
    L.push('', '## 技能包（按作用对象分组）');
    sk.forEach((g) => {
      L.push(`### ${g.label}`);
      (g.items || []).slice(0, 6).forEach((r) => L.push(`- ${r.full_name} ⭐${r.stars}｜${clipText(r.desc, 100)}｜${r.url}`));
    });
  }
  const models = d.models || {};
  const sh = d.skills_sh || {};
  if (Array.isArray(sh.items) && sh.items.length) {
    L.push('', `## skills.sh 技能市场（跨 agent，按安装量；共 ${sh.total} 个）`);
    sh.items.slice(0, 12).forEach((s) => L.push(
      `- ${s.name}（${s.source}）安装 ${s.installs}${s.week_delta != null ? '｜周增 ' + s.week_delta : ''}${s.official ? '｜官方' : ''}｜装法：${s.cmd}｜${s.url}`));
  }
  L.push('', '## 模型（OpenRouter 近三周上架）');
  (models.openrouter_new || []).slice(0, 12).forEach((m) => L.push(`- ${m.id}｜上下文 ${m.context}｜输入 $${m.prompt_price} / 输出 $${m.completion_price} 每 M token｜${m.created}`));
  L.push('', '## 本地模型（Ollama 新上架）');
  (models.ollama_new || []).slice(0, 8).forEach((m) => L.push(`- ${m.name}${m.caps && m.caps.length ? '｜' + m.caps.join('/') : ''}｜${clipText(m.desc, 90)}`));
  L.push('', '## 新闻');
  (d.news || []).slice(0, 12).forEach((n) => L.push(`- ${clipText(n.title, 110)}｜${n.source || ''}｜${n.link || ''}`));
  L.push('', '## 论文');
  (d.papers || []).slice(0, 6).forEach((p) => L.push(`- ${clipText(p.title, 120)}｜${p.link || ''}`));
  const bi = d.bilibili || {};
  if (Array.isArray(bi.items) && bi.items.length) {
    L.push('', '## B站（中文教程与「普通人在看什么」；播放量是路人也点进来的信号）');
    bi.items.slice(0, 10).forEach((v) => L.push(
      `- ${clipText(v.title, 100)}｜${v.author || ''}｜${v.play || 0} 播放｜${v.date || ''}｜${v.why || ''}｜${v.url}`));
  }
  const zh = d.zhihu || {};
  if (Array.isArray(zh.items) && zh.items.length) {
    L.push('', '## 知乎热榜（普通人在吵什么；是情绪与需求信号，不是技术事实）');
    zh.items.slice(0, 8).forEach((z) => L.push(`- ${clipText(z.title, 100)}｜${z.heat || ''}｜${z.url}`));
  }
  const wb = d.web || {};
  if (Array.isArray(wb.items) && wb.items.length) {
    L.push('', '## 联网搜索（中文实测与二手转述；不是官方口径，引用要给链接）');
    wb.items.slice(0, 10).forEach((w) => L.push(
      `- ${clipText(w.title, 100)}｜${w.host || ''}｜${clipText(w.desc, 120)}｜${w.url}`));
  }
  L.push('', '## Hacker News');
  (d.hn || []).slice(0, 8).forEach((h) => L.push(`- ${clipText(h.title, 110)}｜${h.points || '?'} pts`));
  return L.join('\n');
}

async function referenceText() {
  const c = await readJSON(path.join(ROOT, 'concepts.json'), null);
  const a = await readJSON(path.join(ROOT, 'agents.json'), null);
  const L = [];
  if (c && Array.isArray(c.concepts)) {
    L.push('', '## 本机「核心概念」页的词条（用户问基础概念时按这个口径讲）');
    c.concepts.forEach((x) => L.push(`- ${x.term}（${x.en}）：${clipText(x.plain || x.pro, 90)}`));
  }
  if (a && Array.isArray(a.agents)) {
    L.push('', '## 本机「安装 agent」页收录（用户问怎么装时给对应命令）');
    a.agents.forEach((x) => L.push(`- ${x.name}（${x.vendor}）：${(x.installs || []).map((i) => i.cmd).join(' ； ')}`));
  }
  return L.join('\n');
}

const CHAT_SYS = [
  '你是「AI 情报台」里的助手，跑在用户自己的电脑上，用的是用户自己填的 API。',
  '',
  '回答要求：',
  '- 中文，短句，先给结论再解释，不要客套开场。',
  '- 用户问概念（LLM、token、上下文、prompt、agent、MCP、skill 等）：用「一句话」「打个比方」「放到你的情况里」三段讲，术语第一次出现时给英文。',
  '- 用户问「最近 / 最新 / 有什么新东西」：只能用下面 <材料> 里的内容，禁止编造模型名、价格、上下文长度、榜单名次；材料里没有就直说「今天的材料里没有」。',
  '- 用户描述自己的项目或需求：先用一两句复述你理解到的，再给 1 到 3 条具体、今天就能动手的建议，不要空泛鼓励。',
  '- 给链接时用材料里的原始链接，不要自己拼。',
  '- 不确定就说不确定。',
].join('\n');

const EXTRACT_SYS = [
  '你在维护一份用户画像。只输出 JSON，不要解释，不要代码块围栏。',
  '从用户这句话里提取两样东西：',
  '1) project：他在做什么（summary）、用什么技术（stack）、想达到什么（goals）。',
  '2) needs：他想解决的问题、想要的资料 / 工具 / 技能。每条要有 topic（不超过 12 字）、detail（具体描述）、keywords（3 到 6 个检索关键词，中文或英文，要能命中 GitHub 项目描述或模型名）、weight（1 到 3）。',
  '规则：只写用户明确说过的，不推测；没提到就留空字符串或空数组；已经在画像里的不要重复输出。',
  '输出形状：{"project":{"summary":"","stack":"","goals":""},"needs":[{"topic":"","detail":"","keywords":[],"weight":2}]}',
].join('\n');

function apiEndpoint() {
  const base = (config.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

function apiHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` };
}

async function chatCall(messages, opts = {}) {
  if (!config.apiKey) throw new Error('还没填 API key。去「设置」里填一个就能对话。');
  const { temperature = 0.6, maxTokens = 1600, onDelta = null } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  const body = { model: config.model, messages, temperature, max_tokens: maxTokens, stream: !!onDelta };
  // 想要用量统计；个别兼容层不认这个字段会回 400，那就去掉再发一次。
  if (onDelta) body.stream_options = { include_usage: true };
  const post = () => fetch(apiEndpoint(), {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
    signal: ac.signal,
  });
  try {
    let res = await post();
    if (res.status === 400 && body.stream_options) {
      delete body.stream_options;
      res = await post();
    }
    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`接口返回 ${res.status}：${raw.slice(0, 300)}`);
    }
    if (!onDelta) {
      const j = await res.json();
      if (j && j.usage) void addUsage(j.usage);
      const c = j && j.choices && j.choices[0] && (j.choices[0].message || {}).content;
      return String(c || '');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (j && j.usage) void addUsage(j.usage);
          const delta = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {}
      }
    }
    return full;
  } finally {
    clearTimeout(timer);
  }
}

function parseJSONLoose(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

function mergeProfilePatch(prof, patch) {
  const next = normalizeProfile(prof);
  if (patch && patch.project) {
    for (const k of ['summary', 'stack', 'goals']) {
      const v = String(patch.project[k] || '').trim();
      if (v) next.project[k] = v.slice(0, 400);
    }
  }
  const incoming = Array.isArray(patch && patch.needs) ? patch.needs : [];
  for (const raw of incoming) {
    const topic = String((raw && (raw.topic || raw.detail)) || '').trim();
    if (!topic) continue;
    const kws = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k) => String(k).trim())
      .filter((k) => k.length >= 2)
      .slice(0, 12);
    const hit = next.needs.find((n) => n.topic === topic.slice(0, 60) || (kws.length > 0 && n.keywords.some((k) => kws.includes(k))));
    if (hit) {
      if (raw.detail) hit.detail = String(raw.detail).slice(0, 300);
      hit.keywords = [...new Set([...hit.keywords, ...kws])].slice(0, 14);
      hit.weight = Math.min(3, Math.max(hit.weight, Number(raw.weight) || hit.weight));
    } else {
      next.needs.push({
        id: newNeedId(),
        topic: topic.slice(0, 60),
        detail: String(raw.detail || '').slice(0, 300),
        keywords: kws,
        weight: Math.min(3, Math.max(1, Math.round(Number(raw.weight) || 2))),
        created: todayStr(),
        source: 'chat',
      });
    }
  }
  next.needs = next.needs.slice(-24);
  return next;
}

async function extractProfileFrom(userText, prof) {
  if (!config.apiKey) return null;
  const out = await chatCall(
    [
      { role: 'system', content: `${EXTRACT_SYS}\n\n已有画像：\n${profileSummary(prof)}` },
      { role: 'user', content: userText.slice(0, 2000) },
    ],
    { temperature: 0, maxTokens: 700 }
  );
  const patch = parseJSONLoose(out);
  if (!patch) return null;
  const merged = mergeProfilePatch(prof, patch);
  if (JSON.stringify(merged) === JSON.stringify(prof)) return null;
  return saveProfile(merged);
}

const MATCH_STOP = new Set(['的', '了', '和', '是', '在', '我', '也', '就', '不', '有', '这', '那', 'the', 'and', 'for', 'with', 'this', 'that', '一个', '我们', '可以', '什么', '怎么', '如何', '想要', '需要', '问题']);

function needWords(need) {
  const set = new Set();
  const push = (w) => {
    const t = String(w || '').toLowerCase().replace(/^[^a-z0-9\u4e00-\u9fa5+#]+|[^a-z0-9\u4e00-\u9fa5+#]+$/g, '');
    if (t.length >= 2 && !MATCH_STOP.has(t)) set.add(t);
  };
  (need.keywords || []).forEach(push);
  const text = `${need.topic || ''} ${need.detail || ''}`.toLowerCase();
  text.split(/[^a-z0-9\u4e00-\u9fa5+#.]+/).forEach(push);
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
  }
  return [...set].slice(0, 40);
}

function matchCandidates(rangeData) {
  const d = (rangeData && rangeData.data) || {};
  const out = [];
  const addRepos = (list, kind, label) => {
    (list || []).forEach((r) => {
      if (!r || !r.full_name) return;
      out.push({
        kind,
        label,
        title: r.full_name,
        sub: clipText(r.desc, 140),
        hay: `${r.full_name} ${r.desc || ''} ${(r.topics || []).join(' ')} ${r.lang || ''}`.toLowerCase(),
        url: r.url,
        stars: r.stars || 0,
        date: r.last_seen || r.__d || r.created || '',
        topics: r.topics || [],
        lang: r.lang || '',
        createdDays: Number(r.created_days_ago),
      });
    });
  };
  addRepos(d.github && d.github.new_repos, '项目', '新星');
  addRepos(d.github && d.github.ai_new, '项目', 'AI 项目');
  addRepos(d.github && d.github.active, '项目', '高星活跃');
  ((d.skills && d.skills.groups) || []).forEach((g) => addRepos(g.items, '技能', g.label));
  const models = d.models || {};
  (models.openrouter_new || []).forEach((m) => {
    out.push({
      kind: '模型',
      label: '云端模型',
      title: m.id,
      sub: `${m.context} 上下文 · $${m.prompt_price}/$${m.completion_price} 每 M token`,
      hay: `${m.id} ${m.name || ''} ${m.modality || ''}`.toLowerCase(),
      url: `https://openrouter.ai/${m.id}`,
      date: m.created || '',
      price: { prompt: Number(m.prompt_price) || 0, completion: Number(m.completion_price) || 0 },
    });
  });
  (models.ollama_new || []).forEach((m) => {
    out.push({
      kind: '模型',
      label: '本地模型',
      title: m.name,
      sub: clipText(m.desc, 120),
      hay: `${m.name} ${m.desc || ''} ${(m.caps || []).join(' ')}`.toLowerCase(),
      topics: m.caps || [],
      url: `https://ollama.com/library/${m.name}`,
      date: m.updated || '',
    });
  });
  (d.news || []).forEach((n) => {
    out.push({
      kind: '新闻',
      label: n.source || '新闻',
      title: n.title,
      sub: clipText(n.summary, 120),
      hay: `${n.title || ''} ${n.summary || ''}`.toLowerCase(),
      url: n.link,
      date: n.date || '',
    });
  });
  (d.papers || []).forEach((p) => {
    out.push({
      kind: '论文',
      label: 'arXiv',
      title: p.title,
      sub: clipText(p.summary, 120),
      hay: `${p.title || ''} ${p.summary || ''}`.toLowerCase(),
      url: p.link,
      date: p.date || '',
    });
  });
  (d.hn || []).forEach((h) => {
    out.push({
      kind: 'HN',
      label: 'HN',
      title: h.title,
      sub: `${h.points || '?'} pts`,
      hay: String(h.title || '').toLowerCase(),
      url: h.url || h.hn,
      date: '',
    });
  });
  return out;
}

/* ------------------------------------------------ 联网搜索（Bing RSS） */

// websearch.mjs 是 ESM，主进程是 CJS，这里按需动态 import。
// 单独缓存库实例与结果：同一个问题在两三分钟内重复问不该再打一次网络。
let WEB_LIB = null;
const WEB_CACHE = new Map(); // query -> {at, rows}
const WEB_TTL = 10 * 60 * 1000;

async function webLib() {
  if (WEB_LIB) return WEB_LIB;
  WEB_LIB = await import(pathToFileURL(path.join(ROOT, 'websearch.mjs')).href);
  return WEB_LIB;
}

function webErrText(e) {
  const msg = String((e && e.message) || e);
  if (/timeout|aborted/i.test(msg)) return '联网搜索超时（20 秒）。换个说法再试，或者关掉「联网」只用本机材料。';
  if (/HTTP 4\d\d/.test(msg)) return `联网搜索被搜索引擎挡了（${msg}）。过一会儿再试。`;
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) return '连不上搜索引擎，检查一下网络。';
  return '联网搜索失败：' + msg;
}

async function webSearch(query, count = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const hit = WEB_CACHE.get(q);
  if (hit && Date.now() - hit.at < WEB_TTL) return hit.rows.slice(0, count);
  const lib = await webLib();
  const rows = await lib.searchWeb(q, { count: Math.max(count, 6) });
  WEB_CACHE.set(q, { at: Date.now(), rows });
  if (WEB_CACHE.size > 120) WEB_CACHE.delete(WEB_CACHE.keys().next().value);
  return rows.slice(0, count);
}

/** 把一句人话压成「能搜到东西」的查询词：整句当 query 时搜索引擎经常一条都返回不了 */
function webQueriesFromText(text) {
  const raw = String(text || '').replace(/[？?！!。，,、；;：:"'“”‘’（）()【】《》]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleaned = raw
    .replace(/^(请问|请|帮我|能不能|可不可以|可以|我想|想问|麻烦|告诉我)\s*/, '')
    .replace(/(吗|呢|吧|啊|呀|么)$/g, '')
    .trim();
  const out = [];
  // 先试整句去掉疑问词；不行再只留「像名字」的那些词（带数字/英文的那几个）
  if (cleaned.length >= 4) out.push(cleaned.slice(0, 40));
  const named = cleaned.split(' ').filter((w) => /[A-Za-z0-9]/.test(w) && w.length >= 2).slice(0, 4).join(' ');
  if (named && named !== cleaned && named.length >= 4) out.push(named.slice(0, 40));
  if (!out.length && cleaned) out.push(cleaned.slice(0, 20));
  return out;
}

/** 对话里用的：先搜用户这句话，搜不到就换更短的查询词再试一次 */
async function chatWebHits(text) {
  if (config.webSearch === false) return [];
  const queries = webQueriesFromText(text);
  for (const q of queries) {
    try {
      const rows = await webSearch(q, 5);
      if (rows.length) return rows;
    } catch (e) {
      console.error('[radar] chat web search', e);
      return [];
    }
  }
  return [];
}

ipcMain.handle('web:search', async (_e, arg) => {
  const q = String((arg && arg.q) || '').trim();
  const n = Math.min(20, Math.max(3, Number((arg && arg.count) || 8)));
  if (!q) return { ok: false, error: '先写要搜什么。', rows: [] };
  try {
    const rows = await webSearch(q, n);
    return { ok: true, query: q, rows, engine: 'bing-rss' };
  } catch (e) {
    return { ok: false, error: webErrText(e), rows: [] };
  }
});

/* ----------------------------------------- 技能说明书 + 适配助手 */

// skilldoc.mjs 也是 ESM，和 websearch.mjs 一样按需 import
let DOC_LIB = null;
async function docLib() {
  if (DOC_LIB) return DOC_LIB;
  DOC_LIB = await import(pathToFileURL(path.join(ROOT, 'skilldoc.mjs')).href);
  return DOC_LIB;
}

const SKILL_ROOTS = [
  { key: 'claude-user', label: 'Claude Code（用户级）', p: path.join(app.getPath('home'), '.claude', 'skills') },
  { key: 'claude-proj', label: '当前项目 .claude/skills', p: path.join(ROOT, '.claude', 'skills') },
  { key: 'codex-user', label: 'Codex（用户级）', p: path.join(app.getPath('home'), '.codex', 'skills') },
  { key: 'agents-user', label: '通用 ~/.agents/skills', p: path.join(app.getPath('home'), '.agents', 'skills') },
];

function runCmd(cmd, args, timeout = 8000) {
  const { spawnSync } = require('node:child_process');
  try {
    const r = spawnSync(cmd, args, {
      timeout,
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    if (r.error) return { ok: false, out: '', err: String(r.error.message || r.error) };
    const out = String(r.stdout || '').trim();
    return { ok: r.status === 0 || (!!out && r.status !== null), out, err: String(r.stderr || '').trim(), code: r.status };
  } catch (e) {
    return { ok: false, out: '', err: String((e && e.message) || e) };
  }
}

/** Python 要真跑一下：Windows 上 python 常是商店占位符，存在但不打印版本 */
function detectPython() {
  for (const cmd of ['python', 'py', 'python3']) {
    const r = runCmd(cmd, ['--version'], 6000);
    const m = (r.out + ' ' + r.err).match(/Python\s+(\d+)\.(\d+)/);
    if (m) return { present: true, version: `${m[1]}.${m[2]}`, cmd };
  }
  return { present: false, version: '' };
}

function detectAgent(name) {
  const r = runCmd(name, ['--version'], 6000);
  const out = (r.out + ' ' + r.err).trim();
  return { present: r.ok && !!out, version: (out.split(/\n/)[0] || '').slice(0, 60) };
}

let ENV_CACHE = { at: 0, data: null };
async function probeEnv(force = false) {
  if (!force && ENV_CACHE.data && Date.now() - ENV_CACHE.at < 60000) return ENV_CACHE.data;
  const py = detectPython();
  const nodeVer = process.versions.node;
  const git = runCmd('git', ['--version']);
  const docker = runCmd('docker', ['--version']);
  const npm = runCmd('npm', ['--version']);
  const bash = runCmd('bash', ['--version']);
  const agents = [
    { key: 'claude', label: 'Claude Code', ...detectAgent('claude') },
    { key: 'codex', label: 'Codex', ...detectAgent('codex') },
    { key: 'gemini', label: 'Gemini CLI', ...detectAgent('gemini') },
    { key: 'opencode', label: 'OpenCode', ...detectAgent('opencode') },
    { key: 'cursor', label: 'Cursor agent', ...detectAgent('cursor-agent') },
  ];
  const roots = SKILL_ROOTS.map((r) => {
    let installed = [];
    try {
      installed = fs
        .readdirSync(r.p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      /* 目录不存在就是没装 */
    }
    return { ...r, exists: exists(r.p), count: installed.length, installed };
  });
  const data = {
    os: `${process.platform === 'win32' ? 'Windows' : process.platform} ${os.release ? os.release() : ''}`.trim(),
    node: { present: true, version: nodeVer },
    python: py,
    git: { present: git.ok && /git version/i.test(git.out + git.err), version: (git.out || git.err).replace(/^git version\s*/, '').slice(0, 20) },
    docker: { present: docker.ok, version: (docker.out || '').slice(0, 30) },
    npm: { present: npm.ok, version: (npm.out || '').slice(0, 16) },
    bash: { present: bash.ok },
    agents,
    roots,
    checkedAt: new Date().toISOString(),
  };
  ENV_CACHE = { at: Date.now(), data };
  return data;
}

/** 装好的技能目录名：可能是 id，也可能 frontmatter 里的 name */
function installedSkill(source, id, roots) {
  const want = new Set([String(id).toLowerCase()]);
  const hit = [];
  for (const r of roots || []) {
    for (const name of r.installed || []) {
      if (want.has(String(name).toLowerCase())) hit.push({ root: r.p, rootLabel: r.label, dir: path.join(r.p, name), name });
    }
  }
  return hit;
}

function skillSteps(doc, env, installed) {
  const root = (env.roots || []).find((r) => r.key === 'claude-user');
  const dest = root ? path.join(root.p, doc.id) : '';
  const steps = [];
  const hard = (doc.fit.needs || []).filter((n) => n.present === false && (n.key === 'python' || n.key === 'docker'));
  if (hard.length) {
    steps.push({
      k: '先补条件',
      v: hard.map((h) => `${h.label}：${h.fix}`).join('\n'),
      tone: 'warn',
    });
  }
  steps.push({
    k: '一行装',
    v: `npx skills add ${doc.source} --skill ${doc.id}`,
    tone: 'code',
  });
  steps.push({
    k: '或手动放进去',
    v: dest
      ? `把仓库里的 ${doc.dir.replace(/^\//, '')} 整个目录放到\n${dest}\n（SKILL.md 要和 scripts/、assets/ 在一起，光复制说明不够）`
      : '把 SKILL.md 所在的整个目录放到你的技能根目录下',
    tone: 'code',
  });
  steps.push({
    k: '让 agent 认出来',
    v: '新开一个该 agent 的会话（技能是启动时读的，已经开着的会话不会自己发现新技能）',
  });
  steps.push({
    k: '一句话验证',
    v: doc.verifyPrompt,
    tone: 'quote',
  });
  if (installed.length) {
    steps.unshift({ k: '已经装过了', v: `在 ${installed[0].dir}`, tone: 'ok' });
  }
  return steps;
}

ipcMain.handle('skill:env', async (_e, arg) => {
  const env = await probeEnv(!!(arg && arg.force));
  return env;
});

ipcMain.handle('skill:doc', async (_e, arg) => {
  const source = String((arg && arg.source) || '').trim();
  const id = String((arg && arg.id) || '').trim();
  const wantPath = String((arg && arg.path) || '').trim();
  if (!source) return { ok: false, error: '缺少仓库名。' };
  if (!/^[\w.-]+\/[\w.-]+$/.test(source)) return { ok: false, error: '仓库名要是 owner/repo 的形式。' };
  try {
    const lib = await docLib();
    const env = await probeEnv();
    let res;
    if (wantPath) {
      const listed = await lib.listRepoFiles(source);
      const got = await lib.readRepoFile(source, wantPath, listed.ref || 'main');
      if (!got.ok) return { ok: false, error: got.error || '读不到这个文件' };
      res = {
        ok: true,
        source,
        path: wantPath,
        dir: wantPath.replace(/\/SKILL\.md$/i, ''),
        text: got.text,
        files: listed.files || [],
        via: got.via,
      };
    } else {
      res = await lib.resolveSkill(source, id);
    }
    if (!res.ok) {
      // 没找到就退一步：把仓库里所有 SKILL.md 列出来，让用户自己点
      let cands = res.candidates || [];
      if (!cands.length) {
        const listed = await lib.listRepoFiles(source);
        cands = (listed.files || []).filter((f) => /SKILL\.md$/i.test(f.path)).map((f) => f.path).slice(0, 12);
      }
      return { ok: false, error: res.error || '读不到这个技能', candidates: cands, source };
    }
    const fm = lib.parseFrontmatter(res.text);
    const docId = (fm.data.name && String(fm.data.name)) || res.dir.split('/').pop() || id;
    const shape = lib.describeShape(res.files, res.dir);
    const fit = lib.analyzeFit({ text: res.text, shape }, {
      python: env.python.present,
      node: env.node.present,
      bash: env.bash.present,
      docker: env.docker.present,
      agents: env.agents,
    });
    const installed = installedSkill(source, docId, env.roots);
    const what = lib.summarizeBody(fm.body);
    const example = lib.pickExample(fm.body);
    const doc = {
      ok: true,
      source,
      id: docId,
      dir: res.dir,
      path: res.path,
      ref: res.ref,
      via: res.via,
      description: String(fm.data.description || ''),
      license: String(fm.data.license || ''),
      what,
      example,
      shape,
      shapeLines: lib.shapeLines(res.files, res.dir),
      fit,
      installed,
      copyOnly: shape.copyOnly,
      candidates: (res.candidates || []).slice(0, 8),
      installCmd: `npx skills add ${source} --skill ${docId}`,
      repoUrl: `https://github.com/${source}`,
    };
    doc.verifyPrompt = buildVerifyPrompt(doc);
    doc.steps = skillSteps(doc, env, installed);
    return doc;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** 一句「拿它干件小事」的验证任务：从描述里挑一个能立刻试的动作 */
function buildVerifyPrompt(doc) {
  const d = String(doc.description || doc.what || '').replace(/\s+/g, ' ');
  const topic = (doc.id || '').replace(/-/g, ' ');
  if (/(pdf)/i.test(doc.id)) return '用这个技能把一份 PDF 的第 1 页转成图片，告诉我尺寸。';
  if (/(xlsx|excel|spreadsheet)/i.test(doc.id)) return '用这个技能把这两列数字做成一张带公式的表格。';
  if (/(skill)/i.test(doc.id)) return `${topic}：帮我找一个能做「把截图转成可编辑文字」的技能，并给出安装命令。`;
  if (/(review|grill|interview|plan|architect)/i.test(doc.id)) return `用 ${doc.id} 把我这个想法过一遍：我想给像素游戏加昼夜循环，帮我挑毛病。`;
  return `用 ${doc.id} 帮我做一件小事：${d.slice(0, 40) || topic}（看它会不会主动接管这件事）。`;
}

ipcMain.handle('skill:check', async (_e, arg) => {
  const source = String((arg && arg.source) || '');
  const id = String((arg && arg.id) || '');
  const env = await probeEnv(true);
  const installed = installedSkill(source, id, env.roots);
  return { ok: true, installed, roots: env.roots };
});

ipcMain.handle('skill:act', async (_e, arg) => {
  const action = String((arg && arg.action) || '');
  const dir = String((arg && arg.dir) || '');
  // 只允许动「家目录」和「应用目录」里的东西；trash-list / restore 不需要 dir。
  // 注意要用 path.resolve 归一化：渲染层传来的可能是正斜杠，和 home 的反斜杠比不了。
  const inScope = (p) => {
    if (!p) return false;
    const abs = path.resolve(p);
    for (const root of [app.getPath('home'), ROOT]) {
      const rel = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
    return false;
  };
  if (!['trash-list', 'restore'].includes(action) && !inScope(dir)) {
    return { ok: false, error: '只会动技能目录里的文件。' };
  }
  try {
    const md = path.join(dir, 'SKILL.md');
    const off = path.join(dir, 'SKILL.md.disabled');
    if (action === 'disable') {
      if (!exists(md)) return { ok: false, error: '这个目录里没有 SKILL.md。' };
      fs.renameSync(md, off);
      return { ok: true, message: '已禁用：把 SKILL.md 改名成 SKILL.md.disabled，agent 就看不见它了。' };
    }
    if (action === 'enable') {
      if (!exists(off)) return { ok: false, error: '没有找到被禁用的 SKILL.md.disabled。' };
      fs.renameSync(off, md);
      return { ok: true, message: '已恢复启用。' };
    }
    if (action === 'uninstall') {
      const trash = path.join(DIR.state, 'skills_trash');
      fs.mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(trash, `${stamp}__${path.basename(dir)}`);
      fs.renameSync(dir, dest);
      return { ok: true, message: '已移到回收站，可在「最近卸载」里恢复。', dest, trash };
    }
    if (action === 'trash-list') {
      const trash = path.join(DIR.state, 'skills_trash');
      let items = [];
      try {
        items = fs.readdirSync(trash, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, p: path.join(trash, d.name) }));
      } catch {
        /* 没有回收站 */
      }
      return { ok: true, items };
    }
    if (action === 'restore') {
      const name = String((arg && arg.name) || '');
      const trash = path.join(DIR.state, 'skills_trash');
      const src = path.join(trash, name);
      if (!exists(src)) return { ok: false, error: '回收站里没有这一项。' };
      const real = name.split('__').slice(1).join('__');
      const target = path.join(app.getPath('home'), '.claude', 'skills', real);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(src, target);
      return { ok: true, message: `已恢复到 ${target}`, dest: target };
    }
    return { ok: false, error: '不认识的动作。' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('skill:open', async (_e, arg) => {
  const p = String((arg && arg.dir) || '');
  if (!p || !exists(p)) return { ok: false, error: '目录不存在。' };
  shell.openPath(p);
  return { ok: true };
});

/* ----------------------------------------- 扩展能力（插件 / 技能 / MCP） */

// exthub.mjs 也是 ESM：和 websearch / skilldoc 一样按需 import
let EXT_LIB = null;
async function extLib() {
  if (EXT_LIB) return EXT_LIB;
  EXT_LIB = await import(pathToFileURL(path.join(ROOT, 'exthub.mjs')).href);
  return EXT_LIB;
}

const EXT_CACHE_PATH = path.join(DIR.state, 'exthub.json');

function loadExtCache() {
  try {
    return JSON.parse(fs.readFileSync(EXT_CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveExtCache(cat) {
  try {
    fs.mkdirSync(DIR.state, { recursive: true });
    fs.writeFileSync(EXT_CACHE_PATH, JSON.stringify(cat));
  } catch {
    /* 缓存写不进去不影响显示 */
  }
}

/**
 * 本机装了哪些「宿主软件」——这是「能不能用」的第一道门。
 * 插件装得再多，宿主没装也是白搭，所以这张表要摆在最上面。
 */
const EXT_HOSTS = [
  {
    key: 'vscode',
    label: 'VS Code / Cursor 这类编辑器',
    hint: 'VS Code 市场里的扩展装在这里',
    probe: () => {
      // 只查目录，不去跑 `code --version`：那类命令在 shell 里可能挂住，把整个页面拖死
      const dirs = [
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Code') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Cursor') : '',
      ].filter(Boolean);
      const hit = dirs.find((d) => exists(d));
      return { present: !!hit, version: hit ? '已装（按目录判断）' : '' };
    },
  },
  {
    key: 'obsidian',
    label: 'Obsidian',
    hint: '社区插件装在这里',
    probe: () => {
      const dirs = [
        process.env.APPDATA ? path.join(process.env.APPDATA, 'obsidian') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Obsidian') : '',
      ].filter(Boolean);
      const hit = dirs.find((d) => exists(d));
      return { present: !!hit, version: hit ? '已装（按配置目录判断）' : '' };
    },
  },
  {
    key: 'blender',
    label: 'Blender 4.2+',
    hint: '官方扩展站的东西只在这个版本之后能用',
    probe: () => {
      const roots = ['C:\\Program Files\\Blender Foundation\\Blender', 'C:\\Program Files (x86)\\Blender Foundation\\Blender'];
      for (const r of roots) {
        try {
          const vs = fs.readdirSync(r).filter((d) => /^\d+\.\d+/.test(d)).sort();
          if (vs.length) return { present: true, version: vs[vs.length - 1] };
        } catch {
          /* 没这个目录 */
        }
      }
      return { present: false, version: '' };
    },
  },
  {
    key: 'godot',
    label: 'Godot 4.x',
    hint: '资源库里的插件要放进项目',
    probe: () => {
      // 同样只查目录：`where godot` 会起子进程，冷启动时又慢又容易卡
      const tries = [
        'E:\\Godot_v4.7.2-stable_win64.exe',
        'C:\\Program Files\\Godot',
        'C:\\Program Files (x86)\\Godot',
        path.join(app.getPath('home'), 'Desktop', 'Godot_v4.7.2-stable_win64.exe'),
      ];
      const hit = tries.find((p) => exists(p));
      return { present: !!hit, version: hit ? '已装（按目录判断）' : '' };
    },
  },
  {
    key: 'mcpclient',
    label: 'MCP 兼容客户端（Claude Code / Codex 等）',
    hint: 'MCP 不是插件，得有客户端才连得上',
    probe: () => {
      // 不跑 --version：改成看安装痕迹，避免子进程卡住
      const marks = [
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'claude.cmd') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
        path.join(app.getPath('home'), '.codex'),
        path.join(app.getPath('home'), '.claude'),
      ].filter(Boolean);
      const n = marks.filter((p) => exists(p)).length;
      return { present: n > 0, version: n > 0 ? '检测到客户端痕迹' : '' };
    },
  },
];

function probeHosts() {
  return EXT_HOSTS.map((h) => {
    let r = { present: false, version: '' };
    try {
      r = h.probe() || r;
    } catch {
      /* 探测失败就当没装 */
    }
    return { key: h.key, label: h.label, hint: h.hint, present: !!r.present, version: r.version || '' };
  });
}

async function extEnv(force = false) {
  const env = await probeEnv(force);
  const apps = probeHosts();
  return { ...env, apps, hosts: apps };
}

async function extCatalog(force = false) {
  const lib = await extLib();
  const prev = loadExtCache();
  const cat = await lib.buildCatalog({ prev, force });
  if (!cat.cached) saveExtCache(cat);
  const byUse = {};
  (cat.rows || []).forEach((r) => {
    byUse[r.use] = (byUse[r.use] || 0) + 1;
  });
  return { ...cat, groups: lib.USE_GROUPS, useLabel: lib.USE_LABEL, byUse };
}

/**
 * 「实测一下」只做一件安全的事：证明这个包/页面现在真能取到。
 * 拿不到结果就明说拿不到，绝不写成「功能可用」——那只测了能不能下载，没测能不能干活。
 */
async function extProbe(card) {
  const at = new Date().toISOString();
  const src = String((card && card.source) || '');
  const out = { ok: false, at, detail: '', command: '', level: '' };
  try {
    if (src === 'vscode') {
      const id = String(card.id || '').replace(/^vsc:/, '');
      const body = { filters: [{ criteria: [{ filterType: 7, value: id }], pageNumber: 1, pageSize: 1 }], flags: 914 };
      const res = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json;api-version=7.2-preview.1', 'user-agent': 'ai-radar' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      const ext = (data.results && data.results[0] && data.results[0].extensions) || [];
      if (!ext.length) return { ...out, detail: '市场里查不到这个扩展 id。' };
      const installs = ((ext[0].statistics || []).find((s) => s.statisticName === 'install') || {}).value || 0;
      return { ...out, ok: true, level: 'tested', command: `code --install-extension ${id}`, detail: `市场接口确认存在，装机量 ${installs}` };
    }
    if (src === 'obsidian') {
      const repo = String(card.repo || '').replace(/^https?:\/\/github\.com\//, '');
      if (!repo) return { ...out, detail: '这张卡片没有仓库地址，没法验证清单文件。' };
      const res = await fetch(`https://testingcf.jsdelivr.net/gh/${repo}@main/manifest.json`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return { ...out, detail: `清单文件返回 HTTP ${res.status}（仓库可能改名或删了）。` };
      const m = await res.json();
      if (!m || !m.id) return { ...out, detail: '清单文件不是有效的 manifest.json。' };
      return { ...out, ok: true, level: 'tested', command: `装到 vault/.obsidian/plugins/${m.id}`, detail: `manifest.json 取到了：id=${m.id}，最低版本 ${m.minAppVersion || '未标注'}` };
    }
    if (src === 'godot' || src === 'blender') {
      const res = await fetch(card.url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'ai-radar' } });
      return { ...out, ok: res.ok, level: res.ok ? 'tested' : '', detail: res.ok ? `资源页现在能打开（HTTP ${res.status}）` : `资源页返回 HTTP ${res.status}` };
    }
    if (src === 'mcp') {
      const name = String(card.id || '').replace(/^mcp:/, '');
      const res = await fetch(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(name)}&limit=5`, { signal: AbortSignal.timeout(20000) });
      const data = await res.json();
      const hit = ((data && data.servers) || []).some((s) => ((s.server && s.server.name) || '') === name);
      return { ...out, ok: hit, level: hit ? 'tested' : '', detail: hit ? '官方 Registry 里现在还有这一条（HTTP 200）' : '官方 Registry 搜不到这个名字了。' };
    }
    return { ...out, detail: '这个来源没有可自动验证的探针。' };
  } catch (e) {
    return { ...out, detail: `探针失败：${String((e && e.message) || e).slice(0, 120)}` };
  }
}

ipcMain.handle('ext:list', async (_e, arg) => {
  try {
    const cat = await extCatalog(!!(arg && arg.force));
    return { ok: true, ...cat };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), rows: [], groups: [], sources: {} };
  }
});

ipcMain.handle('ext:env', async (_e, arg) => {
  try {
    return { ok: true, ...(await extEnv(!!(arg && arg.force))) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), apps: [] };
  }
});

ipcMain.handle('ext:probe', async (_e, card) => extProbe(card || {}));

ipcMain.handle('chat:load', async () => {
  const date = todayStr();
  const [thread, profile] = await Promise.all([loadChat(date), loadProfile()]);
  return { date, messages: thread.messages, profile, model: config.model, hasKey: !!config.apiKey };
});

ipcMain.handle('chat:send', async (_e, arg) => {
  const text = String((arg && arg.text) || '').trim();
  if (!text) return { ok: false, error: '空消息。' };
  if (!config.apiKey) return { ok: false, error: '还没填 API key。去「设置」里填一个就能对话。' };
  const date = todayStr();
  try {
    const [thread, prof, materials, refs] = await Promise.all([loadChat(date), loadProfile(), materialsText(), referenceText()]);
    // 联网：只在开关打开时搜，且失败不影响回答
    const webHits = await chatWebHits(text);
    const webBlock = webHits.length
      ? '\n\n<联网搜索 刚搜的，可能过期，引用要给链接>\n' +
        webHits.map((h, i) => `${i + 1}. ${h.title}｜${h.host || ''}\n   ${clipText(h.desc, 180)}\n   ${h.url}`).join('\n') +
        '\n</联网搜索>'
      : '';
    const messages = [
      { role: 'system', content: `${CHAT_SYS}\n\n<材料>\n${materials}\n${refs}${webBlock}\n</材料>\n\n<用户画像>\n${profileSummary(prof)}\n</用户画像>` },
      ...thread.messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];
    const started = Date.now();
    const reply = await chatCall(messages, {
      temperature: 0.6,
      maxTokens: 1800,
      onDelta: (d) => send('chat:delta', { text: d }),
    });
    const at = new Date().toISOString();
    thread.messages.push({ role: 'user', content: text, at });
    thread.messages.push({
      role: 'assistant',
      content: reply,
      at,
      web: webHits.map((h) => ({ title: h.title, url: h.url, host: h.host || '' })),
    });
    await saveChat(date, thread.messages);
    const seconds = Math.round((Date.now() - started) / 1000);
    send('chat:done', { ok: true, seconds, web: webHits.length });
    extractProfileFrom(text, prof)
      .then((next) => {
        if (next) send('chat:profile', { profile: next });
      })
      .catch((e) => console.error('[radar] extractProfile', e));
    return { ok: true, reply, seconds, web: webHits.map((h) => ({ title: h.title, url: h.url, host: h.host || '' })) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    send('chat:done', { ok: false, error: msg });
    return { ok: false, error: msg };
  }
});

ipcMain.handle('chat:clear', async () => {
  await saveChat(todayStr(), []);
  return { ok: true };
});
/* ------------------------------------------ 模板库：提示词模板 + 填空题 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TMPL_FILE = path.join(ROOT, 'templates.json');
const TMPL_LOG = path.join(DIR.state, 'tmpllog.json');
const MINE_FILE = path.join(DIR.state, 'mytemplates.json');
let TMPL_CACHE = null;
let tmplRunning = false;

async function loadTemplates() {
  if (TMPL_CACHE) return TMPL_CACHE;
  const j = await readJSON(TMPL_FILE, null);
  if (!j || !Array.isArray(j.templates)) {
    throw new Error('没读到 templates.json。文件应该在 ' + TMPL_FILE);
  }
  TMPL_CACHE = j;
  return TMPL_CACHE;
}

function fillTemplate(tpl, values) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_m, k) => {
    const v = values && values[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** 填空后拼成的可复制提示词：角色与规则在前，材料在后，结尾一句「直接输出成品」 */
function composePrompt(tmpl, values, rules) {
  const system = [String(tmpl.system || '').trim(), String(rules || '').trim()].filter(Boolean).join('\n\n');
  const user = fillTemplate(tmpl.user, values);
  return `${system}\n\n---\n\n${user}\n\n（请直接输出成品，不要解释你在做什么。）`;
}

async function loadJsonMap(file) {
  const j = await readJSON(file, null);
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

async function saveJsonMap(file, obj, limit) {
  const keys = Object.keys(obj).sort((a, b) => String(obj[b].at || '').localeCompare(String(obj[a].at || '')));
  const trimmed = {};
  for (const k of keys.slice(0, limit || 30)) trimmed[k] = obj[k];
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

// 抓一篇文章的正文：只认 http(s)，去标签，留 8000 字
async function fetchArticle(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('只支持 http 或 https 开头的链接。');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(u, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`这个链接打不开（HTTP ${res.status}）。可能要登录，或被对方拦了自动访问。可以把正文直接粘进来。`);
    const type = String(res.headers.get('content-type') || '');
    const raw = await res.text();
    let text = raw;
    if (type.includes('html') || /^\s*<(?:!doctype|html)/i.test(raw.slice(0, 200))) text = htmlToText(raw);
    text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 200) {
      throw new Error('抓到的东西太短，大概是登录墙或拦截页。把正文粘进上面的框更省事。');
    }
    return { ok: true, chars: text.length, text: text.slice(0, 8000), url: u };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/abort|timeout/i.test(msg)) throw new Error('等了 20 秒没抓到，可能网络不通。可以手动把正文粘进来。');
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|header|footer|nav|form)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '· ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
  return s;
}

ipcMain.handle('tmpl:list', async () => {
  const j = await loadTemplates();
  const [log, mine] = await Promise.all([loadJsonMap(TMPL_LOG), loadJsonMap(MINE_FILE)]);
  return { rules: j.rules || '', templates: j.templates, log, mine };
});

ipcMain.handle('tmpl:compose', async (_e, arg) => {
  const j = await loadTemplates();
  const t = j.templates.find((x) => x.id === String((arg && arg.id) || ''));
  if (!t) return { ok: false, error: '没找到这个模板。' };
  return { ok: true, prompt: composePrompt(t, (arg && arg.values) || {}, j.rules) };
});

ipcMain.handle('article:fetch', (_e, arg) => fetchArticle(arg && arg.url));

ipcMain.handle('tmpl:save', async (_e, arg) => {
  const j = await loadTemplates();
  const t = j.templates.find((x) => x.id === String((arg && arg.id) || ''));
  if (!t) return { ok: false, error: '没找到这个模板。' };
  const values = (arg && arg.values) || {};
  const mine = await loadJsonMap(MINE_FILE);
  const key = 'm-' + Date.now().toString(36);
  mine[key] = {
    at: new Date().toISOString(),
    base: t.id,
    title: String((arg && arg.name) || t.title).slice(0, 40),
    prompt: composePrompt(t, values, j.rules),
    values,
  };
  const saved = await saveJsonMap(MINE_FILE, mine, 50);
  return { ok: true, key, mine: saved };
});

ipcMain.handle('tmpl:del-mine', async (_e, key) => {
  const mine = await loadJsonMap(MINE_FILE);
  delete mine[String(key || '')];
  return { ok: true, mine: await saveJsonMap(MINE_FILE, mine, 50) };
});

ipcMain.handle('tmpl:forget', async (_e, id) => {
  const log = await loadJsonMap(TMPL_LOG);
  delete log[String(id || '')];
  return { ok: true, log: await saveJsonMap(TMPL_LOG, log, 30) };
});

ipcMain.handle('tmpl:run', async (_e, arg) => {
  const id = String((arg && arg.id) || '');
  const values = (arg && arg.values) || {};
  const refine = String((arg && arg.refine) || '').trim();
  const prev = String((arg && arg.prev) || '');
  const j = await loadTemplates();
  const t = j.templates.find((x) => x.id === id);
  if (!t) return { ok: false, error: '没找到这个模板，可能 templates.json 被改过。' };
  if (!config.apiKey) return { ok: false, error: '还没填 API key。去「设置」里填一个，才能在这里直接生成。' };
  const missing = (t.fields || []).filter((f) => f.required && !String(values[f.key] || '').trim());
  if (missing.length) return { ok: false, error: `还差「${missing.map((f) => f.label).join('、')}」，填一下。` };
  if (tmplRunning) return { ok: false, error: '上一个还在写，等它写完。' };
  tmplRunning = true;
  try {
    const userMsg = fillTemplate(t.user, values);
    const system = [String(t.system || '').trim(), String(j.rules || '').trim()].filter(Boolean).join('\n\n');
    const messages = [{ role: 'system', content: system }];
    if (refine && prev) {
      messages.push({ role: 'user', content: userMsg });
      messages.push({ role: 'assistant', content: prev });
      messages.push({ role: 'user', content: `在上面基础上修改：${refine}。只输出修改后的完整成品，不要解释改了什么。` });
    } else {
      messages.push({ role: 'user', content: userMsg });
    }
    const started = Date.now();
    const out = await chatCall(messages, {
      temperature: refine ? 0.4 : 0.6,
      maxTokens: 1600,
      onDelta: (d) => send('tmpl:delta', { id, text: d }),
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    const log = await loadJsonMap(TMPL_LOG);
    log[id] = { at: new Date().toISOString(), values, out, title: t.title };
    await saveJsonMap(TMPL_LOG, log, 30);
    send('tmpl:done', { id, ok: true, seconds });
    return { ok: true, out, seconds };
  } catch (e) {
    const msg = String((e && e.message) || e);
    send('tmpl:done', { id, ok: false, error: msg });
    return { ok: false, error: msg };
  } finally {
    tmplRunning = false;
  }
});
ipcMain.handle('profile:load', () => loadProfile());
ipcMain.handle('profile:save', async (_e, p) => saveProfile(p));

function needFields(src) {
  const o = src || {};
  const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;；\n]/)).map((x) => String(x).trim()).filter(Boolean);
  return {
    goal: String(o.goal || '').slice(0, 300),
    software: arr(o.software).map((x) => x.slice(0, 40)).slice(0, 8),
    budget: String(o.budget || '').slice(0, 80),
    device: String(o.device || '').slice(0, 120),
    difficulty: String(o.difficulty || '').slice(0, 120),
    tried: arr(o.tried).map((x) => x.slice(0, 120)).slice(0, 8),
  };
}
ipcMain.handle('need:add', async (_e, need) => {
  const prof = await loadProfile();
  const topic = String((need && need.topic) || '').trim();
  if (!topic) throw new Error('先写一句你在意什么。');
  prof.needs.push({
    id: newNeedId(),
    topic: topic.slice(0, 60),
    detail: String((need && need.detail) || '').slice(0, 300),
    keywords: (Array.isArray(need && need.keywords) ? need.keywords : topic.split(/[\s,，、]+/))
      .map((k) => String(k).trim())
      .filter((k) => k.length >= 2)
      .slice(0, 12),
    weight: Math.min(3, Math.max(1, Math.round(Number(need && need.weight) || 2))),
    created: todayStr(),
    source: 'manual',
    ...needFields(need),
  });
  return saveProfile(prof);
});

ipcMain.handle('need:del', async (_e, id) => {
  const prof = await loadProfile();
  prof.needs = prof.needs.filter((n) => n.id !== id);
  return saveProfile(prof);
});
ipcMain.handle('need:update', async (_e, arg) => {
  const prof = await loadProfile();
  const n = prof.needs.find((x) => x.id === (arg && arg.id));
  if (!n) throw new Error('找不到这条需求。');
  if (arg && arg.topic !== undefined) {
    const topic = String(arg.topic || '').trim();
    if (!topic) throw new Error('需求的名字不能空着。');
    n.topic = topic.slice(0, 60);
  }
  if (arg && typeof arg.detail === 'string') n.detail = arg.detail.slice(0, 300);
  if (arg && Array.isArray(arg.keywords)) {
    n.keywords = arg.keywords.map((k) => String(k).trim()).filter((k) => k.length >= 2).slice(0, 12);
  }
  if (arg && arg.weight) n.weight = Math.min(3, Math.max(1, Math.round(Number(arg.weight) || 2)));
  if (arg && typeof arg.status === 'string') n.status = arg.status === 'solved' ? 'solved' : 'open';
  // 只改传进来的字段，没传的保持原样（否则一次改标题会把软件、设备清空）
  Object.assign(n, needFields({
    goal: arg && arg.goal !== undefined ? arg.goal : n.goal,
    software: arg && arg.software !== undefined ? arg.software : n.software,
    budget: arg && arg.budget !== undefined ? arg.budget : n.budget,
    device: arg && arg.device !== undefined ? arg.device : n.device,
    difficulty: arg && arg.difficulty !== undefined ? arg.difficulty : n.difficulty,
    tried: arg && arg.tried !== undefined ? arg.tried : n.tried,
  }));
  return saveProfile(prof);
});

ipcMain.handle('match:run', async (_e, arg) => {
  const range = (arg && arg.range) || 'd7';
  const prof = await loadProfile();
  if (!prof.needs.length) return { needs: 0, range, items: [], scanned: 0 };
  const rp = await rangePayload(range);
  const cands = matchCandidates(rp);
  const needles = prof.needs.map((n) => ({ need: n, words: needWords(n) })).filter((x) => x.words.length > 0);
  const scored = [];
  for (const c of cands) {
    if (!c.hay) continue;
    let best = null;
    for (const { need, words } of needles) {
      const hits = words.filter((w) => c.hay.includes(w));
      if (!hits.length) continue;
      const score = need.weight * hits.reduce((s, w) => s + Math.min(3, w.length / 2), 0);
      if (!best || score > best.score) best = { score, need, hits };
    }
    if (!best || best.score < 2) continue;
    // 单个短词命中（light 命中 highlight / ohmyzsh）通常是噪音：要么命中够长，要么命中两个以上
    const strong = best.hits.some((h) => h.length >= 6);
    if (!strong && best.hits.length < 2) continue;
    scored.push({ c, best });
  }
  scored.sort((a, b) => b.best.score - a.best.score || (b.c.stars || 0) - (a.c.stars || 0));
  const seen = new Set();
  const items = [];
  for (const { c, best } of scored) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    items.push({
      kind: c.kind,
      label: c.label,
      title: c.title,
      sub: c.sub,
      url: c.url,
      stars: c.stars || 0,
      date: c.date || '',
      need: best.need.topic,
      reason: `你提过「${best.need.topic}」${best.hits.length ? '（命中 ' + best.hits.slice(0, 3).join('、') + '）' : ''}`,
    });
    if (items.length >= 14) break;
  }
  return { needs: prof.needs.length, range, items, scanned: cands.length };
});

/* ----------------------------------------------- 需求雷达：长期需求 + 追踪 */

const FEEDBACK_PATH = path.join(DIR.state, 'feedback.json');
const TRACKER_PATH = path.join(DIR.state, 'tracker.json');
const SEED_FLAG = path.join(DIR.state, 'needs_seed.json');

const VERDICTS = {
  useful: '有效',
  complex: '太复杂',
  pricey: '太贵',
  irrelevant: '不相关',
  solved: '已经解决',
};

const FREE_HINT = /(free|freeware|open[- ]?source|\boss\b|mit\b|apache|gpl)/i;
const PAID_HINT = /(paid|commercial|subscription|需要付费|收费|licen[cs]e required|pricing)/i;
const WIN_HINT = /(windows|win32|win64|\.exe\b|installer|winget|portable)/i;
const MAC_ONLY = /(macos only|mac only|for macos|apple silicon|osx only)/i;
const LINUX_ONLY = /(linux only)/i;
const GUI_HINT = /(\bgui\b|desktop app|图形界面|一键|拖拽|drag[- ]and[- ]drop|installer|双击)/i;
const CLI_HINT = /(\bcli\b|command[- ]line|terminal|命令行|npm i -g|pip install|brew install|winget install|npx )/i;
const PY_HINT = /(\.py\b|\bpython3?\b|pip install|requirements\.txt)/i;

async function loadFeedback() {
  const f = await readJSON(FEEDBACK_PATH, null);
  return f && typeof f === 'object' ? f : {};
}

async function saveFeedback(f) {
  try {
    await fsp.mkdir(DIR.state, { recursive: true });
    await fsp.writeFile(FEEDBACK_PATH, JSON.stringify(f, null, 2), 'utf8');
  } catch (e) {
    console.error('[radar] saveFeedback', e);
  }
  return f;
}

const fbKey = (needId, url) => `${needId}|${url}`;

async function feedbackSet(needId, url, verdict, meta) {
  if (!VERDICTS[verdict]) throw new Error('未知的反馈类型。');
  const f = await loadFeedback();
  const k = fbKey(needId, url);
  if (verdict === 'solved') {
    // 「已经解决」既记反馈，也把这条需求标成已解决（不再推荐）
    const prof = await loadProfile();
    const n = prof.needs.find((x) => x.id === needId);
    if (n) {
      n.status = 'solved';
      n.solved_at = todayStr();
      await saveProfile(prof);
    }
  }
  f[k] = {
    needId,
    url: String(url || ''),
    title: String((meta && meta.title) || ''),
    verdict,
    at: new Date().toISOString(),
  };
  await saveFeedback(f);
  return needsPayload();
}

// 把逐条反馈汇总成「这条需求的偏好」：哪些词该压、什么坑要避
function needPrefs(needId, fb) {
  const rows = Object.values(fb).filter((r) => r && r.needId === needId);
  const prefs = { avoidPaid: 0, avoidComplex: 0, boostUrl: new Set(), dropUrl: new Set(), counts: {} };
  for (const r of rows) {
    prefs.counts[r.verdict] = (prefs.counts[r.verdict] || 0) + 1;
    if (r.verdict === 'useful') prefs.boostUrl.add(r.url);
    if (r.verdict === 'irrelevant') prefs.dropUrl.add(r.url);
    if (r.verdict === 'pricey') prefs.avoidPaid++;
    if (r.verdict === 'complex') prefs.avoidComplex++;
    if (r.verdict === 'solved') prefs.dropUrl.add(r.url);
  }
  return prefs;
}

function itemText(it) {
  return `${it.title || ''} ${it.sub || ''} ${it.label || ''} ${(it.topics || []).join(' ')} ${it.lang || ''}`;
}

// 条件检查：只回答「有证据的」，没证据写「未标注」，不猜
function condOf(it) {
  const text = itemText(it);
  const c = {};
  if (it.kind === '模型' && it.price && typeof it.price.prompt === 'number') {
    const free = it.price.prompt === 0 && it.price.completion === 0;
    c.free = { ok: free, text: free ? '免费' : `$${it.price.prompt}/$${it.price.completion} 每 M token` };
  } else if (PAID_HINT.test(text) && !FREE_HINT.test(text)) {
    c.free = { ok: false, text: '看起来收费' };
  } else if (FREE_HINT.test(text) || it.kind === '项目' || it.kind === '技能') {
    c.free = { ok: true, text: '免费（开源）' };
  } else {
    c.free = { ok: null, text: '费用未标注' };
  }
  if (WIN_HINT.test(text)) c.win = { ok: true, text: '支持 Windows' };
  else if (MAC_ONLY.test(text)) c.win = { ok: false, text: '仅 macOS' };
  else if (LINUX_ONLY.test(text)) c.win = { ok: false, text: '仅 Linux' };
  else c.win = { ok: null, text: '没说支持什么系统' };
  if (it.release) c.win.text += '（有发布版）';
  const easy = GUI_HINT.test(text) && !CLI_HINT.test(text) && !PY_HINT.test(text);
  const hard = CLI_HINT.test(text) || PY_HINT.test(text);
  c.easy = easy ? { ok: true, text: '有现成界面/安装包' } : hard ? { ok: false, text: '要命令行或装环境' } : { ok: null, text: '没写怎么用' };
  if (PY_HINT.test(text)) c.py = { ok: false, text: '需要 Python' };
  return c;
}

// 参数量 → 显存粗估（q4 约 0.55GB/B + 1.5GB 余量）
function vramNeed(it) {
  const m = String(`${it.title} ${it.sub}`).match(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/);
  if (!m) return null;
  const params = Number(m[1]);
  if (!params || params > 400) return null;
  return Math.round((params * 0.55 + 1.5) * 10) / 10;
}

async function envFacts() {
  try {
    const env = await probeEnv(false);
    return {
      python: !!(env && env.python && env.python.present),
      node: !!(env && env.node),
      vram: 8,
    };
  } catch (e) {
    return { python: false, node: true, vram: 8 };
  }
}

// 需求里写的硬条件（预算/难度/设备）用来判「这条合不合」
function needConstraints(need) {
  const blob = `${need.budget || ''} ${need.difficulty || ''} ${need.device || ''} ${need.goal || ''} ${need.detail || ''}`;
  return {
    wantFree: /(免费|不要钱|白嫖|0 元|开源|free)/i.test(blob),
    wantEasy: /(简单|小白|不用写代码|一键|零基础|易用)/.test(blob),
    vram: (() => {
      const m = blob.match(/(\d+)\s*G[Bb]/);
      return m ? Number(m[1]) : 8;
    })(),
    win: /(windows|win)/i.test(blob) || true,
  };
}

// 一句话推荐理由：能对上哪一步 + 有证据的条件 + 但哪里不满足
function reasonFor(it, need, cond, hits, env) {
  const cons = needConstraints(need);
  const parts = [];
  const what = hits.slice(0, 3).join('、');
  parts.push(what ? `能对上你说的「${what}」` : '和你的需求沾边');
  const capability = [];
  const extra = itemText(it);
  if (/(sprite|atlas|normal|tile|pixel|像素|素材|贴图)/i.test(`${need.goal || ''} ${need.topic || ''}`) &&
      /(sprite|atlas|normal|tilemap|batch|批量)/i.test(extra)) {
    capability.push('能批量处理你需要的素材格式');
  }
  const pos = [];
  if (cond.free && cond.free.ok === true) pos.push(cond.free.text);
  if (cond.win && cond.win.ok === true) pos.push(cond.win.text);
  if (cond.easy && cond.easy.ok === true) pos.push(cond.easy.text);
  if (capability.length) pos.unshift(capability[0]);
  const neg = [];
  if (cons.wantFree && cond.free && cond.free.ok === false) neg.push('它要付费，而你要求尽量免费');
  if (cons.wantEasy && cond.easy && cond.easy.ok === false) neg.push(`它${cond.easy.text}，比你想要的「操作简单」重`);
  if (cond.py && env && !env.python) neg.push('它依赖 Python，这台机器还没装');
  if (cons.wantEasy && cond.easy && cond.easy.ok === null) neg.push('说明里没写怎么用，装之前先看 README 判断要不要碰命令行');
  if (cond.win && cond.win.ok === null) neg.push('它没标明支持什么系统，先确认 Windows 上能装再用');
  const vram = vramNeed(it);
  if (vram && vram > (cons.vram || 8)) neg.push(`它大概要 ${vram}GB 显存，你的卡是 ${cons.vram || 8}GB`);
  if (cond.win && cond.win.ok === false) neg.push(`它是${cond.win.text}`);
  let s = parts[0];
  if (pos.length) s += `，${pos.join('、')}`;
  s += neg.length ? `；但${neg.join('，')}。` : '。';
  return s;
}

function isEarly(it) {
  const days = Number(it.createdDays);
  if (!Number.isFinite(days)) return false;
  return days <= 45 && (it.stars || 0) >= 8 && (it.stars || 0) < 600;
}

async function needsScan(range, onlyId) {
  const fb = await loadFeedback();
  const env = await envFacts();
  const prof = await loadProfile();
  const rp = await rangePayload(range || 'd7');
  const cands = matchCandidates(rp);
  const dataDate = latestDataDate();
  const needs = prof.needs.filter((n) => n.status !== 'solved' && (!onlyId || n.id === onlyId));
  const out = [];
  let scanned = cands.length;
  for (const need of needs) {
    const words = needWords(need);
    if (!words.length) continue;
    const prefs = needPrefs(need.id, fb);
    const rows = [];
    for (const c of cands) {
      if (!c.hay) continue;
      if (prefs.dropUrl.has(c.url)) continue;
      const hits = words.filter((w) => c.hay.includes(w));
      if (!hits.length) continue;
      const score = need.weight * hits.reduce((s, w) => s + Math.min(3, w.length / 2), 0);
      if (score < 2) continue;
      const strong = hits.some((h) => h.length >= 6);
      if (!strong && hits.length < 2) continue;
      const cond = condOf(c);
      if (prefs.avoidPaid >= 1 && cond.free && cond.free.ok === false) continue;
      if (prefs.avoidComplex >= 1 && cond.easy && cond.easy.ok === false) continue;
      const boost = prefs.boostUrl.has(c.url) ? 6 : 0;
      rows.push({
        kind: c.kind,
        label: c.label,
        title: c.title,
        sub: c.sub,
        url: c.url,
        stars: c.stars || 0,
        date: c.date || '',
        hits,
        score: score + boost,
        early: isEarly(c),
        cond: {
          free: cond.free,
          win: cond.win,
          easy: cond.easy,
          py: cond.py || null,
          vram: vramNeed(c),
        },
        reason: reasonFor(c, need, cond, hits, env),
        verified: todayStr(),
        verdict: (fb[fbKey(need.id, c.url)] || {}).verdict || '',
      });
    }
    rows.sort((a, b) => b.score - a.score || (b.stars || 0) - (a.stars || 0));
    const seen = new Set();
    const items = [];
    for (const r of rows) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      items.push(r);
      if (items.length >= 10) break;
    }
    out.push({
      need: {
        id: need.id,
        topic: need.topic,
        goal: need.goal || '',
        software: need.software || [],
        budget: need.budget || '',
        device: need.device || '',
        difficulty: need.difficulty || '',
        tried: need.tried || [],
        weight: need.weight,
      },
      items,
      feedback: prefs.counts,
      count: items.length,
    });
  }
  // 早期发现：专门放宽一步——近一个月、星标不高但方向对得上的，单独列出来
  let wide = cands;
  if (range === 'today' || range === 'd7' || !range) {
    try {
      wide = matchCandidates(await rangePayload('m1'));
    } catch {
      wide = cands;
    }
  }
  const early = [];
  const seenE = new Set();
  for (const need of needs) {
    const words = needWords(need);
    if (!words.length) continue;
    for (const c of wide) {
      if (!c.hay || seenE.has(c.url)) continue;
      const cd = Number(c.createdDays);
      const st = Number(c.stars) || 0;
      const fresh = Number.isFinite(cd) ? cd <= 45 : false;
      if (!fresh || st < 5 || st > 1500) continue;
      const hits = words.filter((w) => c.hay.includes(w));
      if (!hits.length) continue;
      // 早期发现宁可少列：至少两个词对上、且有一个是有辨识度的长词
      if (hits.length < 2 || !hits.some((h) => h.length >= 5)) continue;
      const cond = condOf(c);
      seenE.add(c.url);
      early.push({
        kind: c.kind,
        kindLabel: KIND_LABEL[c.kind] || '项目',
        label: c.label,
        title: c.title,
        sub: c.sub,
        url: c.url,
        stars: st,
        createdDays: Number.isFinite(cd) ? cd : undefined,
        hits,
        early: true,
        cond: { free: cond.free, win: cond.win, easy: cond.easy, py: cond.py || null, vram: vramNeed(c) },
        reason: reasonFor(c, need, cond, hits, env),
        verified: todayStr(),
        needTopic: need.topic,
        verdict: '',
      });
      if (early.length >= 40) break;
    }
  }
  early.sort((x, y) => (y.hits.length - x.hits.length) || (y.stars || 0) - (x.stars || 0));
  return {
    generatedAt: new Date().toISOString(),
    dataDate,
    stale: dataDate !== todayStr(),
    range: range || 'd7',
    scanned,
    needs: out,
    early: early.slice(0, 8),
    feedbackCount: Object.keys(fb).length,
  };
}

function latestDataDate() {
  try {
    const files = fs.readdirSync(DIR.data).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    return files.length ? files[files.length - 1].replace('.json', '') : '';
  } catch (e) {
    return '';
  }
}

async function needsPayload() {
  const prof = await loadProfile();
  const fb = await loadFeedback();
  return {
    project: prof.project,
    needs: prof.needs.map((n) => ({
      ...n,
      feedback: needPrefs(n.id, fb).counts,
    })),
    feedbackCount: Object.keys(fb).length,
    dataDate: latestDataDate(),
    stale: latestDataDate() !== todayStr(),
  };
}

/* ---------- 现在帮我找：live GitHub 搜索（不局限于已采集的星标门槛） ---------- */

const GH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function ghHeaders() {
  const h = { 'User-Agent': GH_UA, Accept: 'application/vnd.github+json' };
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

async function ghSearch(q, timeout = 20000) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`;
  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`GitHub 搜索返回 ${res.status}`);
  const j = await res.json();
  return Array.isArray(j.items) ? j.items : [];
}

function ghItemToRow(r) {
  const createdDays = Math.max(0, Math.round((Date.now() - Date.parse(r.created_at)) / 86400000));
  return {
    kind: '项目',
    label: 'GitHub 搜索',
    title: r.full_name,
    sub: clipText(r.description, 140),
    url: r.html_url,
    stars: r.stargazers_count || 0,
    date: String(r.pushed_at || '').slice(0, 10),
    topics: r.topics || [],
    lang: r.language || '',
    createdDays,
    release: null,
    hay: `${r.full_name} ${r.description || ''} ${(r.topics || []).join(' ')} ${r.language || ''}`.toLowerCase(),
  };
}

async function needsFind(needId) {
  const prof = await loadProfile();
  const need = prof.needs.find((n) => n.id === needId);
  if (!need) throw new Error('找不到这条需求。');
  const words = needWords(need).filter((w) => /[a-z0-9]/.test(w)).slice(0, 6);
  const zh = needWords(need).filter((w) => /[\u4e00-\u9fa5]/.test(w)).slice(0, 4);
  const queries = [];
  if (words.length >= 2) queries.push(`${words.slice(0, 3).join(' ')} stars:>3`);
  if (words.length >= 1) queries.push(`${words.slice(0, 2).join(' ')} in:readme stars:>10`);
  if (zh.length && !queries.length) queries.push(`${zh.join(' ')} stars:>3`);
  if (!queries.length) throw new Error('这条需求的关键词太少，先在「编辑」里补两三个具体词（比如 normal map、ollama、tilemap）。');
  const fb = await loadFeedback();
  const prefs = needPrefs(need.id, fb);
  const env = await envFacts();
  const rows = [];
  const seen = new Set();
  for (const q of queries.slice(0, 2)) {
    let list = [];
    try {
      list = await ghSearch(q);
    } catch (e) {
      rows.push({ error: String((e && e.message) || e), query: q });
      continue;
    }
    for (const r of list) {
      if (!r || !r.full_name || seen.has(r.html_url)) continue;
      seen.add(r.html_url);
      const c = ghItemToRow(r);
      const hits = needWords(need).filter((w) => c.hay.includes(w));
      if (!hits.length) continue;
      const cond = condOf(c);
      if (prefs.avoidPaid >= 1 && cond.free && cond.free.ok === false) continue;
      if (prefs.avoidComplex >= 1 && cond.easy && cond.easy.ok === false) continue;
      rows.push({
        kind: c.kind,
        label: 'GitHub 搜索',
        title: c.title,
        sub: c.sub,
        url: c.url,
        stars: c.stars,
        date: c.date,
        hits,
        score: need.weight * hits.reduce((s, w) => s + Math.min(3, w.length / 2), 0) + (c.stars ? 1 : 0),
        early: isEarly(c),
        cond: { free: cond.free, win: cond.win, easy: cond.easy, py: cond.py || null, vram: vramNeed(c) },
        reason: reasonFor(c, need, cond, hits, env),
        verified: todayStr(),
        verdict: (fb[fbKey(need.id, c.url)] || {}).verdict || '',
        fresh: true,
      });
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  const errs = rows.filter((r) => r.error);
  const items = rows
    .filter((r) => !r.error)
    .sort((a, b) => b.score - a.score || b.stars - a.stars)
    .slice(0, 12);
  return {
    ok: true,
    need: { id: need.id, topic: need.topic },
    queries,
    items,
    errors: errs,
    dataDate: latestDataDate(),
  };
}

/* ---------- 持续关注：追踪项目的变化 ---------- */

async function loadTracker() {
  const t = await readJSON(TRACKER_PATH, null);
  const items = Array.isArray(t && t.items) ? t.items : [];
  return { items };
}

async function saveTracker(t) {
  t.updated_at = new Date().toISOString();
  try {
    await fsp.mkdir(DIR.state, { recursive: true });
    await fsp.writeFile(TRACKER_PATH, JSON.stringify(t, null, 2), 'utf8');
  } catch (e) {
    console.error('[radar] saveTracker', e);
  }
  return t;
}

async function trackerAdd(arg) {
  const url = String((arg && arg.url) || '').trim();
  const name = String((arg && arg.name) || '').trim();
  if (!url) throw new Error('这条没有可追踪的链接。');
  const t = await loadTracker();
  if (t.items.some((x) => x.url === url)) return { ok: true, already: true, items: t.items };
  const repo = (url.match(/github\.com\/([\w.-]+\/[\w.-]+)/) || [])[1] || '';
  t.items.push({
    id: 't' + Date.now().toString(36),
    url,
    name: name || repo || url,
    repo,
    needs: Array.isArray(arg && arg.needs) ? arg.needs : [],
    since: todayStr(),
    snap: null,
    history: [{ at: new Date().toISOString(), kind: 'add', text: `开始追踪${repo ? '：' + repo : ''}` }],
  });
  await saveTracker(t);
  return { ok: true, items: t.items };
}

async function trackerDel(id) {
  const t = await loadTracker();
  t.items = t.items.filter((x) => x.id !== id);
  await saveTracker(t);
  return { ok: true, items: t.items };
}

async function ghRepoInfo(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`仓库信息返回 ${res.status}`);
  return res.json();
}

async function ghLatestRelease(repo) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const j = await res.json();
    return { tag: j.tag_name || '', at: String(j.published_at || '').slice(0, 10) };
  } catch (e) {
    return null;
  }
}

const TRACK_FEATURE_WORDS = /(windows|plugin|addon|gui|batch|export|import|支持|新增|add|support)/i;

async function trackerCheck() {
  const t = await loadTracker();
  const checked = [];
  const changes = [];
  for (const it of t.items) {
    if (!it.repo) continue;
    let info;
    try {
      info = await ghRepoInfo(it.repo);
    } catch (e) {
      checked.push({ id: it.id, ok: false, error: String((e && e.message) || e) });
      continue;
    }
    const rel = await ghLatestRelease(it.repo);
    const snap = {
      checkedAt: new Date().toISOString(),
      stars: info.stargazers_count || 0,
      pushed: String(info.pushed_at || '').slice(0, 10),
      archived: !!info.archived,
      description: String(info.description || ''),
      license: (info.license && info.license.spdx_id) || '',
      release: rel ? rel.tag : '',
      releaseAt: rel ? rel.at : '',
      tag: rel ? rel.tag : '',
      published: rel ? rel.at : '',
    };
    const prev = it.snap;
    const add = (kind, text) => {
      const row = { at: new Date().toISOString(), kind, text };
      it.history.push(row);
      changes.push({ id: it.id, name: it.name, url: it.url, ...row });
    };
    if (prev) {
      if (rel && rel.tag && rel.tag !== prev.release) {
        add('release', `发布新版本 ${rel.tag}${rel.at ? '（' + rel.at + '）' : ''}`);
      }
      if (!prev.archived && snap.archived) add('archived', '仓库已归档，作者停止维护');
      if (prev.archived && !snap.archived) add('revive', '取消归档，恢复维护');
      if (prev.description && snap.description && prev.description !== snap.description) {
        const fresh = snap.description.replace(prev.description, '');
        if (TRACK_FEATURE_WORDS.test(fresh)) add('feature', `简介有更新：${clipText(snap.description, 120)}`);
      }
      if (prev.stars && snap.stars) {
        const gain = snap.stars - prev.stars;
        const ratio = gain / Math.max(prev.stars, 1);
        if (gain >= 50 || ratio >= 0.05) add('stars', `星标 ${prev.stars} → ${snap.stars}（+${gain}）`);
      }
    }
    it.snap = snap;
    it.history = it.history.slice(-40);
    checked.push({ id: it.id, ok: true, snap });
    await new Promise((r) => setTimeout(r, 900));
  }
  await saveTracker(t);
  return { ok: true, checked, changes, items: t.items };
}

async function trackerPayload() {
  const t = await loadTracker();
  const date = latestDataDate();
  const pack = await readJSON(path.join(DIR.data, `${date}.json`), null);
  const daily = (pack && pack.tracked) || null;
  const dailyItems = (daily && Array.isArray(daily.items)) ? daily.items : [];
  const chMap = (daily && daily.changes && typeof daily.changes === 'object' && !Array.isArray(daily.changes)) ? daily.changes : {};
  const changesView = {};
  t.items.forEach((it) => {
    const fromDaily = dailyItems.find((x) => x.url === it.url || x.name === it.name);
    const c = chMap[it.url] || null;
    const changes = (c && c.changes) || it.changes || [];
    changesView[it.url] = {
      tag: (c && c.tag) || (fromDaily && fromDaily.snap && fromDaily.snap.tag) || (it.snap && it.snap.tag) || '',
      published: (c && c.published) || (fromDaily && fromDaily.snap && fromDaily.snap.published) || (it.snap && it.snap.published) || '',
      changes,
      checkedAt: (c && c.checkedAt) || (daily && daily.checkedAt) || (it.snap && it.snap.checkedAt) || '',
    };
  });
  return {
    items: t.items.map((it) => {
      const fromDaily = dailyItems.find((x) => x.url === it.url || x.name === it.name);
      const snap = it.snap || (fromDaily ? fromDaily.snap : null);
      return {
        id: it.id,
        name: it.name,
        url: it.url,
        repo: it.repo,
        since: it.since,
        snap,
        changes: changesView[it.url].changes,
        history: (it.history || []).slice(-12).reverse(),
        checkedAt: changesView[it.url].checkedAt || '',
        checked_at: changesView[it.url].checkedAt || '',
      };
    }),
    dailyChanges: changesView,
    dataDate: date,
    stale: date !== todayStr(),
  };
}

// 不预置任何人的需求：需求雷达从空开始，用户自己点「加一条需求」。
const SEED_NEEDS = [];

async function needsSeed(force) {
  const flag = await readJSON(SEED_FLAG, null);
  const prof = await loadProfile();
  if (!force && (flag || prof.needs.length)) return needsPayload();
  const have = new Set(prof.needs.map((n) => n.topic));
  for (const s of SEED_NEEDS) {
    if (have.has(s.topic)) continue;
    prof.needs.push({
      id: newNeedId(),
      topic: s.topic,
      detail: s.goal,
      goal: s.goal,
      software: s.software,
      budget: s.budget,
      device: s.device,
      difficulty: s.difficulty,
      tried: s.tried,
      keywords: s.keywords,
      weight: 2,
      created: todayStr(),
      source: 'seed',
      status: 'open',
    });
  }
  await saveProfile(prof);
  try {
    await fsp.mkdir(DIR.state, { recursive: true });
    await fsp.writeFile(SEED_FLAG, JSON.stringify({ at: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    /* 写不了标记也不影响使用 */
  }
  return needsPayload();
}

ipcMain.handle('needs:load', () => needsPayload());
ipcMain.handle('needs:seed', (_e, force) => needsSeed(!!force));
ipcMain.handle('needs:scan', (_e, arg) => needsScan((arg && arg.range) || 'd7', (arg && arg.needId) || ''));
ipcMain.handle('needs:find', (_e, id) => needsFind(String(id || '')));
ipcMain.handle('needs:feedback', (_e, arg) => feedbackSet(arg.needId, arg.url, arg.verdict, arg));
ipcMain.handle('track:list', () => trackerPayload());
ipcMain.handle('track:add', (_e, arg) => trackerAdd(arg));
ipcMain.handle('track:del', (_e, id) => trackerDel(String(id || '')));
ipcMain.handle('track:check', () => trackerCheck());


/* ------------------------------------------------- 用量、翻译、摘要、周报 */

const usagePath = path.join(DIR.state, 'usage.json');
const transPath = path.join(DIR.state, 'trans.json');
const sumPath = path.join(DIR.state, 'summaries.json');

async function loadUsage() {
  const u = await readJSON(usagePath, null);
  return { total: { prompt: 0, completion: 0, calls: 0 }, days: {}, ...(u || {}) };
}

// 模型接口返回的 usage 累计下来，变成「今天花了多少」——不猜价，只在填了单价时才算钱。
async function addUsage(raw) {
  try {
    const p = Number(raw && raw.prompt_tokens) || 0;
    const c = Number(raw && raw.completion_tokens) || 0;
    const u = await loadUsage();
    u.total.prompt += p;
    u.total.completion += c;
    u.total.calls += 1;
    const d = todayStr();
    const day = u.days[d] || { prompt: 0, completion: 0, calls: 0 };
    day.prompt += p;
    day.completion += c;
    day.calls += 1;
    u.days[d] = day;
    const keep = Object.keys(u.days).sort().slice(-60);
    u.days = Object.fromEntries(keep.map((k) => [k, u.days[k]]));
    await writeJSONFile(usagePath, u);
  } catch {}
}

function usageView(u) {
  const pin = Number(config.priceIn) || 0;
  const pout = Number(config.priceOut) || 0;
  const priced = !!(pin || pout);
  const cost = (x) => (priced ? (x.prompt / 1e6) * pin + (x.completion / 1e6) * pout : null);
  const today = u.days[todayStr()] || { prompt: 0, completion: 0, calls: 0 };
  return { today: { ...today, cost: cost(today) }, total: { ...u.total, cost: cost(u.total) }, priced, priceIn: pin, priceOut: pout };
}

function explainKeyError(status, raw) {
  const txt = String(raw || '');
  if (status === 401) {
    return { reason: 'key 不对', hint: '多半是没复制全，或者复制了前后空格。重新复制一次「sk-」开头的那一整串。' };
  }
  if (status === 402) return { reason: '余额不够', hint: '去服务商控制台充点钱（十块就能用很久），再点一次测试。' };
  if (status === 403) return { reason: 'key 没权限', hint: '这个 key 被禁用或没开通这个模型，换一个 key 或换模型试试。' };
  if (status === 404) return { reason: '地址或模型名不对', hint: '服务地址要填到「/v1」这一层，比如 https://api.deepseek.com/v1；模型名要和账单页上的一致。' };
  if (status === 429) return { reason: '请求太频繁或被限流', hint: '等一分钟再试；如果是免费的 key，通常会限得比较死。' };
  if (/invalid.*model|model.*not.*found/i.test(txt)) return { reason: '没有这个模型', hint: '模型名写错，或者你账号没开通它。' };
  return { reason: `接口返回 ${status}`, hint: '把下面这段原文发给我，我看得出来是哪一步不对。' };
}

ipcMain.handle('key:test', async (_e, arg) => {
  const key = String((arg && arg.apiKey) || config.apiKey || '').trim();
  const base = String((arg && arg.baseUrl) || config.baseUrl || '').replace(/\/+$/, '');
  const model = String((arg && arg.model) || config.model || 'deepseek-chat');
  if (!key) return { ok: false, reason: '还没填 key', hint: '把「sk-」开头的那串粘进上面的框，再点测试。' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '说「收到」两个字。' }], max_tokens: 8 }),
      signal: ac.signal,
    });
    const raw = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, ms, raw: raw.slice(0, 300), ...explainKeyError(res.status, raw) };
    return { ok: true, ms, model, hint: `通了，${ms} 毫秒。现在可以对话、也能让它写简报。` };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const ms = Date.now() - t0;
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
      return { ok: false, ms, reason: '域名解析不了', hint: '服务地址拼错了，或者这台机器连不上外网。检查 https://api.deepseek.com/v1 有没有写错。' };
    }
    if (/abort|timeout|ETIMEDOUT/i.test(msg)) {
      return { ok: false, ms, reason: '连接超时', hint: '网络慢或服务地址不通。换个网络再试，或换一个服务商。' };
    }
    return { ok: false, ms, reason: '连不上', hint: '地址可能写错了，也可能是本机网络挡了。原文：' + msg.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('usage:load', async () => usageView(await loadUsage()));

// 一条英文描述 → 中文，翻过的按文本哈希缓存，重复看不再花钱
ipcMain.handle('trans:one', async (_e, arg) => {
  const text = String((arg && arg.text) || '').trim();
  if (!text) return { ok: false, error: '没有要翻的文本。' };
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
  const cache = (await readJSON(transPath, {})) || {};
  if (cache[hash]) return { ok: true, zh: cache[hash], cached: true };
  if (!config.apiKey) return { ok: false, needKey: true, error: '还没填 API key，没法翻。' };
  try {
    const zh = await chatCall([
      {
        role: 'system',
        content: '你是技术翻译。把用户给的英文（多半是开源项目简介）翻成一句自然的中文，只输出译文：不要解释、不要引号、不要重复原文。产品名、项目名、技术名词保留英文。',
      },
      { role: 'user', content: text },
    ], { temperature: 0.2, maxTokens: 400 });
    const clean = String(zh || '').trim().replace(/^["「『]/, '').replace(/["」』]$/, '');
    if (clean) {
      cache[hash] = clean;
      const keys = Object.keys(cache);
      if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete cache[k];
      await writeJSONFile(transPath, cache);
    }
    return { ok: true, zh: clean, cached: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

  // ── 翻译（中英双向） + 「这对我有什么用」 ─────────────────────────────────
  // 一条英文描述 → 中文，翻过的按文本哈希缓存，重复看不再花钱
  ipcMain.handle('trans:text', async (event, arg) => {
    const id = String((arg && arg.id) || '');
    const text = String((arg && arg.text) || '').trim();
    if (!text) return { ok: false, error: '先粘一段文字进来。' };
    if (text.length > 12000) return { ok: false, error: '一次最多翻 12000 个字符，分两次粘。' };
    const to = (arg && arg.to) === 'en' ? 'en' : 'zh';
    const from = (arg && arg.from) || (to === 'zh' ? 'en' : 'zh');
    const sys =
      to === 'zh'
        ? '你是技术翻译。把用户给的内容翻成简体中文，保留 Markdown 结构、代码、命令、链接、专有名词（产品名、模型名、项目名保持英文）。只输出译文，不要解释、不要加引号、不要重复原文。'
        : 'You are a technical translator. Translate the user content into natural English. Keep Markdown structure, code, commands, URLs and proper names unchanged. Output the translation only — no explanations, no quotes.';
    const clean = (s) => String(s || '').trim().replace(/^["「『]/, '').replace(/["」』]$/, '');
    const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
    const cache = (await readJSON(transPath, {})) || {};
    const chunks = [];
    let buf = '';
    for (const para of text.split(/\n{2,}/)) {
      if ((buf + '\n\n' + para).length > 1500 && buf) { chunks.push(buf); buf = para; }
      else buf = buf ? buf + '\n\n' + para : para;
    }
    if (buf) chunks.push(buf);
    let cachedAll = true;
    for (let i = 0; i < chunks.length; i++) {
      const key = `${to}:${hashOf(chunks[i].replace(/\s+/g, ' ').trim())}`;
      if (cache[key]) continue;
      if (!config.apiKey) return { ok: false, needKey: true, error: '还没填 API key，没法翻译。' };
      cachedAll = false;
      try {
        const out = await chatCall(
          [{ role: 'system', content: sys }, { role: 'user', content: chunks[i] }],
          {
            temperature: 0.2,
            maxTokens: Math.min(3000, 200 + chunks[i].length),
            onDelta: (d) => event.sender.send('trans:delta', { id, text: d }),
          },
        );
        const t = clean(out);
        if (!t) return { ok: false, error: '模型返回空内容，再试一次。' };
        cache[key] = t;
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }
    const keys = Object.keys(cache);
    if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete cache[k];
    await writeJSONFile(transPath, cache);
    const full = chunks
      .map((c) => cache[`${to}:${hashOf(c.replace(/\s+/g, ' ').trim())}`] || '')
      .join('\n\n')
      .trim();
    return { ok: true, text: full, cached: cachedAll, to, from, chunks: chunks.length };
  });

  const VENDOR_HOST = /(^|\.)(anthropic|openai|deepmind|deepseek|moonshot|qwen|aliyun|alibaba|google|meta|microsoft|nvidia|amd|github|huggingface|mistral|cohere|x|ai)\.[a-z.]+$/i;
  const HANDS_ON = /实测|上手|评测|体验|试用|跑通|benchmark|评测|test(ed|ing)?|review|hands-on|try/i;

  function evidenceOf(item) {
    const kind = item.kind || '';
    const host = item.host || hostOfUrl(item.url);
    if (kind === 'repo') return { type: 'repo', label: '代码自己跑', note: '仓库公开，能不能用得看你机器和动手能力' };
    if (kind === 'model') return { type: 'official', label: '官方上架信息', note: '价格和上下文取自模型市场的上架字段' };
    if (kind === 'zhihu' || kind === 'hn') return { type: 'community', label: '社区讨论', note: '是别人的观点与提问，不是事实核实' };
    if (kind === 'video') return { type: 'community', label: '体验分享', note: '视频作者自己的实践，效果因人而异' };
    if (kind === 'paper') return { type: 'paper', label: '论文原文', note: '作者自己的实验结论，还没变成产品' };
    if (VENDOR_HOST.test(host)) {
      return HANDS_ON.test(item.title || '')
        ? { type: 'hands', label: '官方实测', note: '厂商自己发布的体验/评测内容' }
        : { type: 'official', label: '官方宣布', note: '厂商自己的说法，还没经过第三方验证' };
    }
    if (HANDS_ON.test(item.title || '') || HANDS_ON.test(item.desc || '')) {
      return { type: 'hands', label: '第三方实测', note: '媒体或作者真的用过，但仍是别人的结论' };
    }
    return { type: 'report', label: '第三方报道', note: '转述消息，细节可能有出入' };
  }

  function hostOfUrl(url) {
    try {
      return new URL(String(url || '')).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  const CN_FRIENDLY = /qwen|deepseek|kimi|moonshot|glm|chatglm|zhipu|minimax|ernie|hunyuan|baichuan|yi-|step-|doubao|internlm|baai|01-ai|sensetime|tencent|alibaba|baidu/i;

  // 没有 key 也能给出「费用 / 门槛 / 中文 / 条件」：全部取自采集到的字段，不猜
  function localCard(item) {
    const kind = item.kind || 'news';
    const ev = evidenceOf(item);
    const cost = { v: '文中未说明', ok: null };
    const barrier = { v: '未说明', ok: null };
    const cn = { v: '未标注', ok: null };
    const cond = { v: '', ok: null };
    if (kind === 'repo') {
      cost.v = '免费（公开仓库）';
      cost.ok = true;
      barrier.v = item.lang ? `要会 ${item.lang}` : '要会看代码';
      cn.v = item.desc && /[\u4e00-\u9fa5]/.test(item.desc) ? '描述是中文写的' : '文档多半是英文';
      cond.v = `⭐${item.stars || 0} · ${item.pushed_days_ago != null ? item.pushed_days_ago + ' 天前还在更新' : ''}`.trim();
    } else if (kind === 'model') {
      if (item.prompt_price != null) {
        cost.v = `${item.prompt_price}/${item.completion_price} 每百万 token`;
        cost.ok = Number(item.prompt_price) === 0;
      }
      barrier.v = item.local ? '要本地显卡（显存）' : '走云端 API，不用显卡';
      cn.v = CN_FRIENDLY.test(item.title || item.id || '') ? '中文模型，中文可用' : '未标注';
      cn.ok = CN_FRIENDLY.test(item.title || item.id || '') ? true : null;
      if (item.context) cond.v = `${Math.round(item.context / 1000)}K 上下文`;
    } else if (kind === 'paper') {
      cost.v = '免费（arXiv）';
      cost.ok = true;
      barrier.v = '要读英文论文';
      cn.v = '只有英文原文';
      cn.ok = false;
      cond.v = item.id || '';
    } else if (kind === 'video') {
      cost.v = '免费';
      cost.ok = true;
      barrier.v = '跟着视频做，要自己装环境';
      cn.v = '中文讲解';
      cn.ok = true;
      cond.v = `${item.author || ''} · ${item.play || 0} 播放`;
    } else if (kind === 'zhihu') {
      cost.v = '免费';
      cost.ok = true;
      barrier.v = '只是讨论，不是教程';
      cn.v = '中文';
      cn.ok = true;
      cond.v = item.heat || '';
    } else if (kind === 'news') {
      cost.v = '免费（网页）';
      cost.ok = true;
      barrier.v = '要自己判断可信度';
      cn.v = /[一-龥]/.test(String(item.title || '')) ? '中文来源' : '英文来源';
      cn.ok = null;
      cond.v = item.src || item.source || '';
    } else if (kind === 'hn') {
      cost.v = '免费';
      cost.ok = true;
      barrier.v = '英文讨论区';
      cn.v = '英文';
      cn.ok = false;
      cond.v = item.points ? `${item.points} pts` : '';
    }
    return { kind, evidence: ev, cost, barrier, chinese: cn, condition: cond };
  }

  /** 没有 key 时也得给出能用的判断：按类别和来源说「谁该看」 */
  function guessAudience(item, ev) {
    const kind = item.kind || 'news';
    if (kind === 'repo') {
      return '想找现成轮子的人；不写代码、或者只做美术的可以直接跳过。'
        + (item.lang ? ` 它是 ${item.lang} 写的。` : '');
    }
    if (kind === 'model') {
      return '要换模型、或者想把成本压下来的人；只做纯对话、不接 API 的可以先观望。';
    }
    if (kind === 'paper') {
      return '做研究、想提前半年看到能力边界的人；只想拿工具干活的可以跳过。';
    }
    if (kind === 'video') {
      return '想跟着做一遍的人——中文、有画面，比读文档直观；赶时间的可以只看前 5 分钟。';
    }
    if (kind === 'zhihu') {
      return '想知道「普通人卡在哪」的人。这里没有答案，别当教程用。';
    }
    if (kind === 'hn') {
      return '想看工程师真实反应的人；讨论常跑题，价值在前几条评论。';
    }
    if (ev && ev.type === 'official') return '关心这家公司路线的人；只看热闹的可以直接跳过。';
    if (ev && ev.type === 'hands') return '想知道实际用起来怎么样的人；结论要看它测了什么。';
    return '想知道这条会不会影响自己手上事的人。';
  }

  /** 无从下手时，给一个真的能做的第一步 */
  function guessStart(item) {
    const kind = item.kind || 'news';
    if (kind === 'repo') return '先看 README 的第一屏和最近一次提交时间，再决定要不要 clone 下来试。';
    if (kind === 'model') return '先拿它试一条你自己的真实问题，别只看榜单和价格表。';
    if (kind === 'paper') return '先读摘要和结论，中间的实验设置等真要用时再看。';
    if (kind === 'video') return '先看简介和前两分钟，确认它讲的版本和你要装的一致。';
    if (kind === 'hn') return '先看最高赞那条评论，通常就是争议核心。';
    if (kind === 'zhihu') return '先看高赞回答里的具体经历，别只读标题。';
    return '先打开原文看结论段，再回来决定要不要花时间深读。';
  }

  const TPL_MATCH = [
    [/周报|汇报|复盘|weekly|日报/i, 'weekly'],
    [/论文|文章|长文|解读|读一读|读懂|paper|research/i, 'article'],
    [/简历|面试|求职|招聘|resume|interview/i, 'resume'],
    [/会议|纪要|记录|meeting/i, 'meeting'],
    [/教程|入门|学习|路线|课程|tutorial|guide|learn/i, 'plan'],
    [/报错|错误|异常|崩溃|bug|error|traceback/i, 'error'],
    [/解释|科普|讲给|通俗|explain/i, 'explain'],
    [/整理|汇总|清单|资料|summary|汇总/i, 'summary'],
    [/写作|文案|宣传|推广|写作技巧|copywriting/i, 'weekly'],
    [/邮件|email|mail/i, 'email'],
  ];

  function templateFor(item) {
    const hay = `${item.title || ''} ${item.desc || ''}`;
    for (const [re, id] of TPL_MATCH) if (re.test(hay)) return id;
    return '';
  }

  ipcMain.handle('usecase:one', async (_e, arg) => {
    const item = (arg && arg.item) || {};
    const base = localCard(item);
    const ev = base.evidence;
    const src = {
      title: item.title || '',
      url: item.url || '',
      host: hostOfUrl(item.url),
      published: item.published || item.date || item.__d || '',
      verified: item.verified || todayStr(),
      source: item.source || item.author || '',
    };
    const tplId = templateFor(item);
    const out = {
      ok: true,
      source: src,
      evidence: ev,
      templateId: tplId,
      local: base,
      what: '',
      audience: '',
      canUse: {
        cost: base.cost.v || '未标注',
        barrier: base.barrier.v || '未标注',
        chinese: base.chinese.v || '未标注',
        condition: base.condition.v || '未标注',
      },
      start: '',
      generated: false,
    };
    if (!config.apiKey) {
      out.what = String(item.desc || item.summary || item.title || '').trim();
      out.audience = guessAudience(item, ev);
      out.start = guessStart(item);
      return out;
    }
    const facts = [
      `标题：${item.title || ''}`,
      item.desc ? `描述：${item.desc}` : '',
      src.source ? `来源：${src.source}（${src.host}）` : `来源：${src.host}`,
      src.published ? `发布日期：${src.published}` : '',
      `material kind：${item.kind}`,
      `证据类型：${ev.label} —— ${ev.note}`,
      `费用：${base.cost.v}｜门槛：${base.barrier.v}｜中文：${base.chinese.v}｜条件：${base.condition.v}`,
      item.stars ? `⭐${item.stars}` : '',
      item.play ? `${item.play} 播放` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const sys =
      '你在给一个正在用 AI 做个人项目的人解释今天的一条资讯。只输出 JSON，不要 Markdown 代码块。' +
      '字段：what（发生了什么，1-2 句，只写材料里有的事实，不编数字）、' +
      'audience（对哪些人有用，具体到岗位或场景，不要写「所有人」）、' +
      'start（从哪里开始，给一个今天就能做的动作或命令；做不到就说「先看原文，别急着用」）。' +
      'JSON 形状：{"what":"...","audience":"...","start":"..."}';
    try {
      const raw = await chatCall(
        [
          { role: 'system', content: sys },
          { role: 'user', content: facts },
        ],
        { temperature: 0.3, maxTokens: 500 },
      );
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      out.what = String(j.what || '').trim() || String(item.desc || item.summary || item.title || '').trim();
      out.audience = String(j.audience || '').trim() || guessAudience(item, ev);
      out.start = String(j.start || '').trim() || guessStart(item);
      // 模型没按 JSON 回答时也算「没生成」：字段是本地兜底，不能标成模型总结
      out.generated = !!(j.what && j.audience);
      return out;
    } catch (e) {
      out.error = String((e && e.message) || e);
      out.what = String(item.desc || item.summary || item.title || '').trim();
      out.audience = guessAudience(item, ev);
      out.start = guessStart(item);
      return out;
    }
  });

  // 「关注后续」：没有对应模板的条目，记下来，等它有可用形态时在周报里提
  const followPath = path.join(ROOT, 'state', 'followups.json');
  ipcMain.handle('usecase:follow', async (_e, arg) => {
    const item = (arg && arg.item) || {};
    if (!item.url) return { ok: false, error: '这条没有链接，存不了。' };
    const db = (await readJSON(followPath, {})) || {};
    const key = crypto.createHash('sha1').update(item.url).digest('hex').slice(0, 16);
    db[key] = { title: item.title || '', url: item.url, kind: item.kind || '', at: new Date().toISOString() };
    await writeJSONFile(followPath, db);
    return { ok: true, count: Object.keys(db).length };
  });

  ipcMain.handle('usecase:follow-list', async () => {
    const db = (await readJSON(followPath, {})) || {};
    return { ok: true, items: Object.values(db).reverse() };
  });

/* ------------------------------------------- 概念词典：领域包（domains.json + 自定义） */

const DOMAINS_PATH = path.join(ROOT, 'domains.json');
const DOMAINS_CUSTOM = path.join(DIR.state, 'domains_custom.json');

async function loadDomains() {
  const base = (await readJSON(DOMAINS_PATH, null)) || { packs: [] };
  const custom = (await readJSON(DOMAINS_CUSTOM, null)) || { packs: [] };
  const seen = new Set();
  const packs = [];
  for (const p of [...(custom.packs || []), ...(base.packs || [])]) {
    if (!p || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    packs.push({ ...p, custom: (custom.packs || []).some((c) => c && c.id === p.id) });
  }
  return { checkedAt: base.checked_at || '', note: base.note || '', packs };
}

const DOMAIN_SYS = [
  '你在为一个人写「某个领域的入门包」。他不知道这个领域的术语，但动手能力强、也会用 AI。',
  '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。结构：',
  '{"label":"中文领域名","en":"英文名","what":"这个领域在干什么，一段话","why":"为什么值得学，一段话",',
  ' "level":{"begin":"刚入门该会什么","useful":"学到什么程度算够用"},',
  ' "path":[{"title":"第一步学什么","detail":"为什么先学这个","do":"一件今天能动手做的事"}],',
  ' "concepts":[{"term":"中文术语","en":"English","pro":"专业解释","plain":"一句话说人话","case":"一个具体例子","mistake":"最常见误解"}],',
  ' "tools":[{"name":"工具名","what":"干什么","free":"免费 / 付费 / 有免费版 / 未标注","url":"官网"}],',
  ' "sites":[{"name":"网站名","what":"去那儿能做什么","url":"官网"}],',
  ' "next":["进阶方向一","进阶方向二"]}',
  '要求：concepts 6–8 条、path 4 步、tools 4–6 个、sites 3–4 个、next 2–3 条；',
  '全部中文（英文名保留原文）；不要编数字、不要写价格数字（价格只写「免费 / 付费 / 有免费版」）；',
  'url 必须是真实官网首页，不确定就给空字符串——编一个打不开的链接是最坏的情况。',
].join('\n');

function slugId(s) {
  const a = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18);
  return a || Date.now().toString(36);
}

const clip2 = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

async function linkOk(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      });
      if (res.status < 400 || [403, 405, 429].includes(res.status)) return true;
    } catch {}
  }
  return false;
}

function normalizePack(raw, name) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const id = 'p-' + slugId(o.en || name);
  const at = new Date().toISOString().slice(0, 10);
  const concepts = (Array.isArray(o.concepts) ? o.concepts : []).slice(0, 10).map((c, i) => ({
    id: id + '-' + (i + 1) + '-' + (slugId(c && c.en) || 'term'),
    term: clip2(c && c.term, 30),
    en: clip2(c && c.en, 40),
    pro: clip2(c && c.pro, 420),
    plain: clip2(c && c.plain, 200),
    case: clip2(c && c.case, 320),
    mistake: clip2(c && c.mistake, 240),
  })).filter((c) => c.term && (c.plain || c.pro));
  const path = (Array.isArray(o.path) ? o.path : []).slice(0, 6).map((s) => ({
    title: clip2(s && s.title, 60), detail: clip2(s && s.detail, 240), do: clip2(s && s.do, 200),
  })).filter((s) => s.title);
  const tools = (Array.isArray(o.tools) ? o.tools : []).slice(0, 6).map((t) => ({
    name: clip2(t && t.name, 40), what: clip2(t && t.what, 160), free: clip2(t && t.free, 20) || '未标注', url: clip2(t && t.url, 300),
  })).filter((t) => t.name);
  const sites = (Array.isArray(o.sites) ? o.sites : []).slice(0, 5).map((t) => ({
    name: clip2(t && t.name, 40), what: clip2(t && t.what, 160), url: clip2(t && t.url, 300),
  })).filter((t) => t.name);
  return {
    id,
    label: clip2(o.label, 24) || name,
    en: clip2(o.en, 40),
    what: clip2(o.what, 400),
    why: clip2(o.why, 400),
    level: { begin: clip2(o.level && o.level.begin, 160), useful: clip2(o.level && o.level.useful, 160) },
    path,
    concepts,
    tools,
    sites,
    next: (Array.isArray(o.next) ? o.next : []).slice(0, 4).map((x) => clip2(x, 160)).filter(Boolean),
    generated: true,
    at,
  };
}

async function domainGen(name) {
  await loadConfig();
  if (!config.apiKey) return { ok: false, needKey: true, error: '没填 API key' };
  let raw;
  try {
    raw = await chatCall([
      { role: 'system', content: DOMAIN_SYS },
      { role: 'user', content: '我要学的领域是：' + name },
    ], { temperature: 0.4, maxTokens: 2600 });
  } catch (e) {
    return { ok: false, error: '接口出错：' + ((e && e.message) || e) };
  }
  const json = parseJSONLoose(raw);
  if (!json) return { ok: false, error: '模型没给出可解析的 JSON，再试一次' };
  const pack = normalizePack(json, name);
  if (!pack.concepts.length) return { ok: false, error: '这次没写出词条，换个说法再试一次' };

  // 逐个检查工具与网站链接：打不开也保留，但标出来，不假装有效
  const at = new Date().toISOString().slice(0, 10);
  for (const t of [...pack.tools, ...pack.sites]) {
    if (!/^https?:\/\//i.test(t.url || '')) { t.ok = null; continue; }
    t.ok = await linkOk(t.url);
    t.checkedAt = at;
  }

  const store = (await readJSON(DOMAINS_CUSTOM, null)) || { packs: [] };
  store.packs = [pack, ...(store.packs || []).filter((p) => p && p.id !== pack.id)].slice(0, 40);
  await writeJSONFile(DOMAINS_CUSTOM, store);
  return { ok: true, pack };
}

ipcMain.handle('domains:load', async () => {
  try { return { ok: true, ...(await loadDomains()) }; } catch (e) { return { ok: false, error: String((e && e.message) || e), packs: [] }; }
});

ipcMain.handle('domain:gen', async (_e, arg) => {
  const name = String((arg && arg.name) || '').trim();
  if (!name) return { ok: false, error: '先写一个领域名' };
  return domainGen(name.slice(0, 40));
});

ipcMain.handle('domain:del', async (_e, arg) => {
  const id = String((arg && arg.id) || '');
  if (!id) return { ok: false, error: '缺 id' };
  const store = (await readJSON(DOMAINS_CUSTOM, null)) || { packs: [] };
  const before = (store.packs || []).length;
  store.packs = (store.packs || []).filter((p) => p && p.id !== id);
  await writeJSONFile(DOMAINS_CUSTOM, store);
  return { ok: true, removed: before - store.packs.length };
});

function tabRows(pack, tab) {
  if (!pack) return [];
  const g = pack.github || {};
  if (tab === 'new') return g.new_repos || [];
  if (tab === 'active') return g.active || [];
  if (tab === 'ai') return g.ai_new || [];
  if (tab === 'velocity') return g.velocity || [];
  if (tab === 'models') {
    const or = (pack.models && pack.models.openrouter_new) || [];
    const ol = (pack.models && pack.models.ollama_new) || [];
    return [
      ...or.map((m) => ({ title: m.id, desc: `${m.context ? Math.round(m.context / 1000) + 'K 上下文 · ' : ''}$${m.prompt_price}/$${m.completion_price}`, url: m.url })),
      ...ol.map((m) => ({ title: m.name, desc: m.desc, url: m.url })),
    ];
  }
  if (tab === 'news') return pack.news || [];
  if (tab === 'papers') return pack.papers || [];
  if (tab === 'hn') return pack.hn || [];
  return [];
}

ipcMain.handle('summary:tab', async (_e, arg) => {
  const date = (arg && arg.date) || todayStr();
  const tab = (arg && arg.tab) || 'news';
  const cache = (await readJSON(sumPath, {})) || {};
  const key = `${date}|${tab}`;
  if (cache[key]) return { ok: true, text: cache[key], cached: true };
  if (!config.apiKey) return { ok: false, needKey: true, error: '这是按需功能，要先在设置里填 API key。' };
  const pack = await readJSON(path.join(DIR.data, `${date}.json`), null);
  const rows = tabRows(pack, tab).slice(0, 40);
  if (!rows.length) return { ok: false, error: '这一栏今天没有条目。' };
  const lines = rows.map((r, i) => `${i + 1}. ${r.title || r.full_name || ''}${r.desc || r.sub ? ' — ' + String(r.desc || r.sub || '').slice(0, 110) : ''}`).join('\n');
  try {
    const text = await chatCall([
      {
        role: 'system',
        content: '你在帮一个非技术读者快速判断材料。只用给定条目里的事实，不要补充、不要编数字。输出 5 条要点，每条一行、以「- 」开头、不超过 30 个汉字，只写「能帮我做决定」的东西（谁在变强、哪里有坑、跟我有没有关系）。最后单独一行写「先看：<序号> — <一句理由>」。不要写开场白和总结。',
      },
      { role: 'user', content: lines },
    ], { temperature: 0.3, maxTokens: 700 });
    const clean = String(text || '').trim();
    if (clean) {
      cache[key] = clean;
      await writeJSONFile(sumPath, cache);
    }
    return { ok: true, text: clean, cached: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* --------------------------------------------------------------- 首次引导 */

ipcMain.handle('onboard:done', async (_e, arg) => {
  const projectText = String((arg && arg.projectText) || '').trim();
  if (projectText) {
    const prof = await loadProfile();
    prof.project = { ...(prof.project || {}), summary: projectText.slice(0, 200) };
    // 中文不用切词：matchCandidates 会对 topic/detail 自动做 bigram；
    // 这里只挑英文技术词，避免把「我在做一」「的像素中」这种碎片当关键词
    const words = projectText.match(/[A-Za-z][A-Za-z0-9+#.]{2,}/g) || [];
    prof.needs.push({
      id: newNeedId(),
      topic: projectText.slice(0, 60),
      detail: projectText.slice(0, 300),
      keywords: [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 10),
      weight: 2,
      created: todayStr(),
      source: 'onboard',
    });
    await saveProfile(prof);
  }
  await saveConfig({ onboarded: true });
  return { ok: true, config: publicConfig() };
});

/* ------------------------------------------------------------------- 周报 */

function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${pad(week)}`;
}

async function weeklyStats(days = 7) {
  const files = (fs.readdirSync(DIR.data) || []).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, days);
  const repos = new Map();
  const models = new Map();
  const skills = new Map();
  let newCount = 0;
  let digests = 0;
  for (const f of files) {
    const pack = await readJSON(path.join(DIR.data, f), null);
    if (!pack) continue;
    const date = f.slice(0, 10);
    if (exists(path.join(DIR.digests, `${date}.md`))) digests++;
    for (const r of (pack.github?.new_repos || [])) {
      newCount++;
      if (!repos.has(r.full_name)) repos.set(r.full_name, { name: r.full_name, url: r.url, stars: r.stars, perDay: r.stars_per_day_since_birth, date });
    }
    for (const m of (pack.models?.openrouter_new || [])) {
      if (!models.has(m.id)) models.set(m.id, { ...m, date });
    }
    for (const s of (pack.skills_sh?.items || [])) {
      if (!skills.has(s.key)) skills.set(s.key, { ...s, date });
    }
  }
  const topRepos = [...repos.values()].sort((a, b) => (b.perDay || 0) - (a.perDay || 0)).slice(0, 6);
  const topSkills = [...skills.values()].filter((s) => (s.week_delta || 0) > 0).sort((a, b) => b.week_delta - a.week_delta).slice(0, 4);
  return { days: files.length, from: files.length ? files[files.length - 1].slice(0, 10) : '', to: files.length ? files[0].slice(0, 10) : '', newCount, digests, topRepos, models: [...models.values()].slice(0, 8), topSkills };
}

async function buildWeekly() {
  const st = await weeklyStats(7);
  const key = weekKey();
  const file = path.join(DIR.digests, `weekly-${key}.md`);
  const facts = [
    `本周（${st.from} → ${st.to}，${st.days} 天数据，${st.digests} 天出了简报）新项目合计 ${st.newCount} 个。`,
    st.topRepos.length ? '日均涨星靠前：' + st.topRepos.map((r) => `${r.name}（${r.stars}⭐，日均 +${Math.round(r.perDay || 0)}）`).join('；') : '没有可比较的涨星数据。',
    st.models.length ? '本周上架/新出现的模型：' + st.models.map((m) => m.id).join('、') : '模型层没有新上架。',
    st.topSkills.length ? '技能安装榜前列：' + st.topSkills.map((s) => `${s.name}（周 +${s.week_delta}）`).join('；') : '',
    '同一个梗重复出现的项目要忽略；只看这周和上周不一样的。',
  ].filter(Boolean).join('\n');

  let body = '';
  if (config.apiKey) {
    try {
      body = await chatCall([
        {
          role: 'system',
          content: '你在给一个做独立游戏（Godot 像素风）的人写一周情报小结。只用给定事实，不许编数字。输出三段，用「## 」标题：\n## 这周真正变了什么（3-4 条，每条一行，≤40 字，只写和上周不同的）\n## 今晚可以动手的一件事（1 条，必须具体到能立刻做，若这周确实没有值得动手的，就写「这周没有，别硬找」）\n## 下周盯什么（2 条）\n不要开场白，不要总结，总长 ≤350 字。',
        },
        { role: 'user', content: facts },
      ], { temperature: 0.4, maxTokens: 900 });
    } catch (e) {
      body = '';
    }
  }
  if (!body) {
    body = `## 这周的数据\n${facts}\n\n## 说明\n没填 API key，这里是原样统计；填了之后点「生成周报」会多出判断与建议。`;
  }
  const md = `# 周报 ${key}\n\n${body.trim()}\n`;
  await fsp.mkdir(DIR.digests, { recursive: true });
  await fsp.writeFile(file, md, 'utf8');
  return { ok: true, key, file: `digests/weekly-${key}.md`, md, stats: { ...st, topRepos: st.topRepos.map((r) => r.name) } };
}

ipcMain.handle('weekly:build', async () => {
  try { return await buildWeekly(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('weekly:read', async () => {
  const key = weekKey();
  const md = await readText(path.join(DIR.digests, `weekly-${key}.md`));
  return { key, md };
});

/* --------------------------------------------------------- 每日一次提醒 */

async function maybeNotify() {
  if (config.pushDaily === false) return;
  const t = todayStr();
  if (config.lastNotice === t) return;
  if (new Date().getHours() < 8) return;
  const digest = await readText(path.join(DIR.digests, `${t}.md`));
  const pack = await readJSON(path.join(DIR.data, `${t}.json`), null);
  if (!digest && !pack) return;
  const body = digest
    ? oneLiner(digest)
    : `今天采到 ${((pack.github?.new_repos) || []).length} 个新项目，简报还没生成。`;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '今天的 AI 情报好了',
        body: String(body || '点开看看').slice(0, 120),
        icon: path.join(__dirname, exists(path.join(__dirname, 'icon-256.png')) ? 'icon-256.png' : 'icon.ico'),
      });
      n.on('click', () => {
        if (!win) createWindow();
        else { win.show(); win.focus(); }
        send('nav:view', { view: 'today' });
      });
      n.show();
    }
  } catch (e) {
    console.error('[radar] notify', e);
  }
  await saveConfig({ lastNotice: t });
}

ipcMain.handle('digest:generate', async (_e, date) => {
  try { return await generateDigest(date || todayStr()); }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});
ipcMain.handle('settings:save', async (_e, patch) => {
  const next = {};
  for (const k of ['baseUrl', 'model', 'scheduleEnabled', 'scheduleTime', 'matchEnabled', 'pushDaily', 'summaryAll', 'onboarded', 'compact', 'webSearch']) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  for (const k of ['priceIn', 'priceOut']) {
    if (patch[k] !== undefined) next[k] = Math.max(0, Number(patch[k]) || 0);
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim) {
    const k = patch.apiKey.trim();
    if (k) next.apiKey = k;
  }
  if (patch.clearKey) next.apiKey = '';
  await saveConfig(next);
  return { ok: true, config: publicConfig() };
});
ipcMain.handle('shell:open', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  return true;
});
ipcMain.handle('folder:open', async (_e, which) => {
  const map = { root: ROOT, inbox: DIR.inbox, digests: DIR.digests, data: DIR.data, prompts: DIR.prompts };
  await shell.openPath(map[which] || ROOT);
  return true;
});
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });

ipcMain.handle('search:run', async (_e, q) => {
  const query = String(q || '').trim();
  if (!query) return { total: 0, items: [], days: 0, relaxed: false };
  const idx = await buildIndex();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const collect = (fn) => {
    const best = new Map();
    for (const it of idx.items) {
      const score = fn(it, tokens);
      if (score < 0) continue;
      const key = it.url || `${it.kind}:${it.title}:${it.date}`;
      const prev = best.get(key);
      if (!prev || score > prev.score || (score === prev.score && it.date > prev.date)) best.set(key, { ...it, score });
    }
    return [...best.values()].sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  };

  let relaxed = false;
  let rows = collect(scoreItem);
  // 多词全中才返回 0 条时，放宽成"任一词命中"，并告诉用户放宽了
  if (!rows.length && tokens.length > 1) { rows = collect(scoreItemAny); relaxed = rows.length > 0; }

  return {
    total: rows.length,
    relaxed,
    days: idx.dates.length,
    items: rows.slice(0, 60).map((r) => ({
      kind: r.kind, kindLabel: KIND_LABEL[r.kind] || r.kind, date: r.date,
      title: r.title, sub: r.sub, url: r.url, stars: r.stars ?? null, score: r.score,
      conceptId: r.conceptId || '', agentId: r.agentId || '', extId: r.extId || '',
    })),
  };
});

ipcMain.handle('repo:history', async (_e, name) => {
  const idx = await buildIndex();
  return idx.hist.get(String(name || '')) || [];
});

ipcMain.handle('aux:load', () => ({
  bookmarks: AUX.bookmarks,
  read: AUX.read,
  readCount: Object.keys(AUX.read).length,
}));

ipcMain.handle('bookmark:toggle', async (_e, item) => {
  const url = String(item?.url || '');
  if (!url) return { ok: false, error: '这个条目没有可收藏的链接。' };
  if (AUX.bookmarks[url]) delete AUX.bookmarks[url];
  else {
    AUX.bookmarks[url] = {
      url,
      title: String(item.title || url),
      kind: String(item.kind || ''),
      date: String(item.date || ''),
      savedAt: Date.now(),
    };
  }
  await writeJSONFile(path.join(DIR.state, 'bookmarks.json'), AUX.bookmarks);
  return { ok: true, saved: !!AUX.bookmarks[url], bookmarks: AUX.bookmarks };
});

ipcMain.handle('read:mark', (_e, url) => {
  const u = String(url || '');
  if (u && !AUX.read[u]) { AUX.read[u] = Date.now(); flushReadSoon(); }
  return { ok: true, count: Object.keys(AUX.read).length };
});

ipcMain.handle('read:clear', async () => {
  AUX.read = {};
  await writeJSONFile(path.join(DIR.state, 'read.json'), AUX.read);
  return { ok: true };
});

/* ------------------------------------------------------------------ boot */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.airadar.desktop');
    await loadConfig();
    await loadAux();
    createWindow();
    createTray();
    setInterval(scheduleTick, 20_000);
    setTimeout(scheduleTick, 3_000);
    setTimeout(() => { void maybeNotify(); }, 6_000);
    setInterval(() => { void maybeNotify(); }, 15 * 60_000);
  });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('before-quit', () => { try { collectChild?.kill(); } catch {} });
}
