/**
 * 事件追踪与事件图景
 *
 * 追踪：在新闻或简报条目旁点「追踪」，模型给这件事打上标签（核心专名 + 关键词 + 搜索词），
 *       之后每次采集完、每天第一次打开，都拿标签去对本机采集到的条目、再联网搜一次，新进展记进事件链。
 *       简报生成时把事件的新进展放在最前；也能单独生成一份「事件链报告」。
 * 图景：在条目旁点「图景」，现搜一圈（多组查询 + 本机历史 + 读几篇原文），
 *       写成一篇起因、经过、发展、各方、现状和不确定处都在的背景稿，每句都标来源编号。
 *
 * 只依赖主进程传进来的函数，不直接碰界面。
 */
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const TAG_SYS = [
  '你给一条新闻/事件打追踪标签，之后程序会每天拿这些标签去匹配新出现的报道。',
  '只输出 JSON：{"title":"事件短名（12 字内，像档案标签）","core":["核心专名 1-3 个：公司、产品、人名、法案名，原文大小写"],"keywords":["其他关键词 3-8 个，中英都给"],"query":"中文搜索词","query_en":"English search query"}',
  'core 要足够独特：只出现在这件事的报道里，不要「AI」「模型」「发布」这类泛词。',
].join('\n');

const REPORT_SYS = [
  '你根据一条事件链上收集到的全部报道，写一份「事件链报告」。只根据材料，不编造；每个事实后面用 [n] 标出处编号。',
  '输出 Markdown，固定小节：',
  '## 一句话现状',
  '## 时间线（按日期从早到晚，每行「日期 · 发生了什么 [n]」）',
  '## 起因 → 经过 → 发展（三段，把因果串起来）',
  '## 各方说法（谁说了什么、立场是什么）',
  '## 对我意味着什么（结合用户画像；没有画像就写对普通开发者/创作者）',
  '## 接下来盯什么（2-4 个具体信号）',
  '## 还不确定的',
  '中文，密度优先，总长 900 字以内。来源列表不用你写，程序会附在文末。',
].join('\n');

const PQ_SYS = [
  '用户想了解一件事的全貌。你给出搜索计划，程序会去搜。',
  '只输出 JSON：{"core":"这件事的核心专名","queries":["中文查询 1","中文查询 2（偏背景/起因）","中文查询 3（偏最新进展/各方反应）"],"query_en":"English query"}',
  '查询词要短（2-6 个词），不要整句。',
].join('\n');

const PANO_SYS = [
  '你是资深编辑。根据下面搜到的资料，写一篇让完全没跟进过的人也能看懂这件事全貌的「事件图景」。',
  '只用资料里的事实，不编造；每个事实后面用 [n] 标出处编号；资料互相矛盾时把两种说法都写出来并标出处。',
  '输出 Markdown，固定小节：',
  '## 一句话',
  '## 起因（背景、前情、为什么会发生）',
  '## 经过（时间线，「日期 · 事件 [n]」，从早到晚）',
  '## 现在到哪一步了',
  '## 牵涉到谁（各方、利益和立场）',
  '## 为什么重要（对行业、对普通用户）',
  '## 还不确定的 / 有争议的',
  '## 接下来看什么',
  '中文，总长 1200 字以内。来源列表不用你写，程序会附在文末。资料不够撑起某一节时，就写「资料里没有」。',
].join('\n');

function createEvents(deps) {
  const { DIR, readJSON, chatCall, webSearch, send, clipText, parseJSONLoose, todayStr, hasKey, poolItems, searchLocal, profileText, getProxy } = deps;
  const FILE = path.join(DIR.state, 'events.json');
  const PANO_DIR = path.join(DIR.state, 'panoramas');

  /** 经 HTTP 代理的 CONNECT 隧道取一个 https 地址（零依赖；跟随重定向） */
  function proxyText(url, proxy, { timeout = 20000, hops = 3 } = {}) {
    const u = new URL(url);
    const p = new URL(proxy);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${u.hostname}:443`, timeout });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理 CONNECT ${res.statusCode}`)); return; }
        const get = https.get({
          host: u.hostname, path: u.pathname + u.search, socket, servername: u.hostname, agent: false, timeout,
          headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
        }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops > 0) {
            r.resume();
            resolve(proxyText(new URL(r.headers.location, url).href, proxy, { timeout, hops: hops - 1 }));
            return;
          }
          if (r.statusCode !== 200) { r.resume(); reject(new Error(`HTTP ${r.statusCode}`)); return; }
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          r.on('error', reject);
        });
        get.on('error', reject);
        get.on('timeout', () => get.destroy(new Error('timeout')));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('代理超时')));
      req.end();
    });
  }

  const unxml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

  /**
   * 新闻搜索：Bing 新闻的 RSS 带发布时间和来源，最适合事件追踪。
   * 它只在国际版 bing.com 上给 RSS，直连会被转到 cn.bing.com（那边只回网页），所以要走系统代理；没代理就返回空，由普通搜索兜底。
   */
  async function newsSearch(q) {
    const proxy = getProxy ? await getProxy() : '';
    if (!proxy) return [];
    const xml = await proxyText(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`, proxy);
    const out = [];
    for (const it of xml.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
      const pick = (tag) => { const m = it.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')); return m ? unxml(m[1]) : ''; };
      let url = pick('link');
      const real = url.match(/[?&]url=([^&]+)/);
      if (real) { try { url = decodeURIComponent(real[1]); } catch { /* 用原链接 */ } }
      const ts = Date.parse(pick('pubDate'));
      const d = Number.isFinite(ts) ? new Date(ts) : null;
      const pad = (n) => String(n).padStart(2, '0');
      out.push({
        title: pick('title'),
        url,
        desc: pick('description'),
        host: pick('News:Source') || hostOf(url),
        date: d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '',
      });
    }
    return out.filter((r) => r.title && /^https?:/.test(r.url));
  }

  const hash = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
  const normUrl = (u) => String(u || '').trim().replace(/#.*$/, '').replace(/\/+$/, '').replace(/^http:/, 'https:');
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const cleanQuery = (q) => String(q || '').replace(/[？?！!。，,、；;：:"'“”‘’（）()【】《》|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

  async function load() {
    const db = (await readJSON(FILE, null)) || {};
    return { ...db, events: Array.isArray(db.events) ? db.events : [] };
  }
  async function save(db) {
    await fsp.mkdir(path.dirname(FILE), { recursive: true });
    await fsp.writeFile(FILE, JSON.stringify(db, null, 2), 'utf8');
  }

  /* ---------------------------------------------------------- 打标签 */

  function heuristicTags(seed) {
    const title = String(seed.title || '').trim();
    const named = (title.match(/[A-Za-z][A-Za-z0-9.+\-_/]{2,}/g) || []).filter((w) => !/^(https?|www|the|and|for|with|from|new|ai|llm)$/i.test(w));
    const core = [...new Set(named)].slice(0, 3);
    const zh = (title.match(/[一-龥]{2,8}/g) || []).slice(0, 5);
    return {
      title: clipText(title, 16),
      core: core.length ? core : [clipText(title.replace(/[，,：:。].*$/, ''), 10)],
      keywords: zh,
      query: clipText(title, 30),
      query_en: core.join(' '),
      tagged_by: 'rule',
    };
  }

  async function tagSeed(seed) {
    if (!hasKey()) return heuristicTags(seed);
    try {
      const raw = await chatCall(
        [
          { role: 'system', content: TAG_SYS },
          { role: 'user', content: `标题：${seed.title}\n摘要：${clipText(seed.summary || '', 600)}\n来源：${seed.source || ''} ${seed.url || ''}` },
        ],
        { temperature: 0, maxTokens: 500 },
      );
      const j = parseJSONLoose(stripThink(raw));
      if (!j || !Array.isArray(j.core) || !j.core.length) return heuristicTags(seed);
      const clean = (a, n) => (Array.isArray(a) ? a : []).map((x) => String(x || '').trim()).filter((x) => x.length >= 2).slice(0, n);
      return {
        title: clipText(String(j.title || seed.title), 16),
        core: clean(j.core, 3),
        keywords: clean(j.keywords, 8),
        query: clipText(String(j.query || seed.title), 40),
        query_en: clipText(String(j.query_en || ''), 60),
        tagged_by: 'model',
      };
    } catch {
      return heuristicTags(seed);
    }
  }

  /* ---------------------------------------------------------- 匹配 */

  function hits(ev, text) {
    const hay = String(text || '').toLowerCase();
    const core = (ev.core || []).filter((k) => hay.includes(k.toLowerCase()));
    const kw = (ev.keywords || []).filter((k) => hay.includes(k.toLowerCase()));
    return { core: core.length, kw: kw.length };
  }
  /** 本机条目：要中一个核心专名，再加至少一个关键词（核心专名只有一个字母数字词时更严） */
  const matchLocal = (ev, text) => { const h = hits(ev, text); return h.core >= 1 && (h.kw >= 1 || h.core >= 2); };
  /** 联网 / 新闻结果和本机条目同一个标准：一个核心专名只是同一家公司，不一定是同一件事 */
  const matchWeb = matchLocal;

  function addItems(ev, rows) {
    const seen = new Set((ev.items || []).map((x) => normUrl(x.url)));
    let added = 0;
    for (const r of rows) {
      const u = normUrl(r.url);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      ev.items.push({
        url: r.url,
        title: clipText(r.title || '', 160),
        summary: clipText(r.summary || '', 300),
        source: r.source || hostOf(r.url),
        date: String(r.date || '').slice(0, 10),
        via: r.via || 'local',
        foundAt: new Date().toISOString(),
      });
      added += 1;
    }
    if (ev.items.length > 300) ev.items = ev.items.slice(-300);
    return added;
  }

  async function refreshOne(ev, { web = true } = {}) {
    let added = 0;
    const pool = await poolItems(10);
    added += addItems(ev, pool.filter((it) => matchLocal(ev, `${it.title} ${it.summary}`)).map((it) => ({ ...it, via: 'local' })));
    if (web) {
      // Bing 的 RSS 对单个词、带问号的整句经常一条都不给：去掉标点，再补两组「专名 + 关键词」
      const core = ev.core || [];
      const kw = ev.keywords || [];
      const queries = [...new Set([ev.query, ev.query_en, `${core[0] || ''} ${kw[0] || ''}`, `${core[0] || ''} ${kw[1] || ''}`]
        .map(cleanQuery).filter((q) => (q.length >= 4 && q.includes(' ')) || /[一-龥]{4,}/.test(q)))].slice(0, 4);
      const keep = (rows, via) => rows
        .filter((r) => matchWeb(ev, `${r.title} ${r.desc || ''}`))
        .map((r) => ({ url: r.url, title: r.title, summary: r.desc || '', source: r.host || hostOf(r.url), date: r.date || '', via }));
      // 先搜新闻（带日期和来源），再用普通搜索补
      for (const q of queries) {
        try { added += addItems(ev, keep(await newsSearch(q), 'news')); } catch (err) { console.error('[radar] news search', q, err.message); }
      }
      for (const q of queries) {
        await pause(900); // 连着搜太快会被 Bing 限流，返回空结果
        try { added += addItems(ev, keep(await webSearch(q, 8), 'web')); } catch { /* 联网失败不影响本机匹配 */ }
      }
    }
    ev.lastCheck = new Date().toISOString();
    return added;
  }

  async function refreshAll({ web = true } = {}) {
    const db = await load();
    let added = 0;
    for (const ev of db.events) {
      if (ev.status !== 'tracking') continue;
      try { added += await refreshOne(ev, { web }); } catch (e) { console.error('[radar] event refresh', e); }
    }
    db.lastRun = new Date().toISOString();
    await save(db);
    send('events:updated', { added });
    return { ok: true, added };
  }

  /* ---------------------------------------------------------- 增删改 */

  async function create(seed) {
    const s = {
      title: clipText(String(seed.title || '').trim(), 200),
      summary: clipText(String(seed.summary || '').trim(), 800),
      url: String(seed.url || '').trim(),
      source: String(seed.source || '').trim(),
      date: String(seed.date || todayStr()).slice(0, 10),
    };
    if (!s.title) return { ok: false, error: '没有标题，追踪不了。' };
    const db = await load();
    const dup = db.events.find((e) => (s.url && normUrl(e.seed?.url) === normUrl(s.url)) || e.seed?.title === s.title);
    if (dup) {
      if (dup.status !== 'tracking') { dup.status = 'tracking'; await save(db); send('events:updated', {}); }
      return { ok: true, event: dup, existed: true };
    }
    const tags = await tagSeed(s);
    const ev = {
      id: hash(`${s.url}|${s.title}|${Date.now()}`),
      ...tags,
      seed: s,
      status: 'tracking',
      createdAt: new Date().toISOString(),
      seenAt: new Date().toISOString(),
      lastCheck: '',
      items: [],
      report: null,
      panoKey: seed.panoKey || '',
    };
    addItems(ev, s.url ? [{ url: s.url, title: s.title, summary: s.summary, source: s.source, date: s.date, via: 'seed' }] : []);
    db.events.unshift(ev);
    await save(db);
    send('events:updated', {});
    // 第一次查放后台：搜一圈要十几秒，不让按钮卡着
    void (async () => {
      const d2 = await load();
      const e2 = d2.events.find((x) => x.id === ev.id);
      if (!e2) return;
      const added = await refreshOne(e2, { web: true });
      await save(d2);
      send('events:updated', { id: ev.id, added });
    })().catch((e) => console.error('[radar] event first refresh', e));
    return { ok: true, event: ev };
  }

  async function update(id, patch) {
    const db = await load();
    const ev = db.events.find((e) => e.id === id);
    if (!ev) return { ok: false, error: '找不到这个事件。' };
    if (typeof patch.title === 'string' && patch.title.trim()) ev.title = clipText(patch.title.trim(), 24);
    const list = (v) => String(v || '').split(/[,，、\n]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
    if (patch.core !== undefined) ev.core = list(patch.core).slice(0, 5);
    if (patch.keywords !== undefined) ev.keywords = list(patch.keywords).slice(0, 12);
    if (typeof patch.query === 'string') ev.query = clipText(patch.query.trim(), 40);
    if (['tracking', 'paused', 'closed'].includes(patch.status)) ev.status = patch.status;
    if (patch.seen) ev.seenAt = new Date().toISOString();
    if (patch.dropUrl) ev.items = ev.items.filter((x) => normUrl(x.url) !== normUrl(patch.dropUrl));
    await save(db);
    send('events:updated', { id });
    return { ok: true, event: ev };
  }

  async function remove(id) {
    const db = await load();
    const n = db.events.length;
    db.events = db.events.filter((e) => e.id !== id);
    await save(db);
    send('events:updated', {});
    return { ok: n !== db.events.length };
  }

  async function refreshNow(id) {
    const db = await load();
    const ev = db.events.find((e) => e.id === id);
    if (!ev) return { ok: false, error: '找不到这个事件。' };
    const added = await refreshOne(ev, { web: true });
    await save(db);
    send('events:updated', { id, added });
    return { ok: true, added, event: ev };
  }

  /* ---------------------------------------------------------- 事件链报告 */

  const sourceList = (rows) => rows.map((r, i) => `[${i + 1}] ${r.title}｜${r.source || hostOf(r.url)}${r.date ? '｜' + r.date : ''}｜${r.url}`).join('\n');

  async function report(id) {
    if (!hasKey()) return { ok: false, error: '要先在「设置」里填 API key 才能写报告。' };
    const db = await load();
    const ev = db.events.find((e) => e.id === id);
    if (!ev) return { ok: false, error: '找不到这个事件。' };
    const rows = [...ev.items].sort((a, b) => String(a.date || a.foundAt).localeCompare(String(b.date || b.foundAt))).slice(-60);
    if (!rows.length) return { ok: false, error: '这条事件链上还没有任何报道。先点「现在查一次」。' };
    let pano = '';
    if (ev.panoKey) {
      const p = await readJSON(path.join(PANO_DIR, `${ev.panoKey}.json`), null);
      if (p && p.text) pano = `\n\n<已有的事件图景，可参考背景>\n${clipText(p.text, 3000)}\n</已有的事件图景>`;
    }
    const material = rows.map((r, i) => `[${i + 1}] ${r.date || String(r.foundAt).slice(0, 10)}｜${r.source}｜${r.title}\n    ${r.summary || ''}`).join('\n');
    const raw = await chatCall(
      [
        { role: 'system', content: REPORT_SYS },
        { role: 'user', content: `事件：${ev.title}（核心词 ${ev.core.join('、')}）\n\n<用户画像>\n${await profileText()}\n</用户画像>\n\n<报道，按时间>\n${material}\n</报道>${pano}` },
      ],
      { temperature: 0.3, maxTokens: 2400, onDelta: (t) => send('events:delta', { key: `rep:${id}`, text: t }) },
    );
    const text = `${stripThink(raw)}\n\n## 来源\n\n${sourceList(rows).split('\n').map((l) => `- ${l}`).join('\n')}`;
    const fresh = await load();
    const e2 = fresh.events.find((e) => e.id === id);
    if (e2) { e2.report = { text, at: new Date().toISOString(), count: rows.length }; await save(fresh); }
    send('events:updated', { id });
    return { ok: true, text, at: e2 && e2.report.at, count: rows.length };
  }

  /** 给简报生成用：追踪中的事件最近 3 天的新进展 */
  async function digestBlock() {
    const db = await load();
    const since = Date.now() - 3 * 86400e3;
    const out = [];
    for (const ev of db.events.filter((e) => e.status === 'tracking')) {
      const fresh = ev.items.filter((x) => Date.parse(x.foundAt) > since && x.via !== 'seed').slice(-8);
      out.push(`### ${ev.title}（核心词 ${ev.core.join('、')}）\n` + (fresh.length
        ? fresh.map((x) => `- ${x.date || ''} ${x.title}｜${x.source}｜${x.url}`).join('\n')
        : '- 最近 3 天没有新报道'));
    }
    return out.join('\n\n');
  }

  /* ---------------------------------------------------------- 事件图景 */

  async function pageText(url) {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/html|text/.test(res.headers.get('content-type') || '')) throw new Error('不是网页');
    let html = (await res.text()).slice(0, 800_000);
    html = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
    const art = html.match(/<article\b[\s\S]*?<\/article>/i);
    const body = art ? art[0] : (html.match(/<body\b[\s\S]*<\/body>/i) || [html])[0];
    const text = body
      .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 18)
      .join('\n');
    return text.slice(0, 2600);
  }

  async function panorama(seed, { force = false } = {}) {
    const key = hash(normUrl(seed.url) || seed.title);
    const file = path.join(PANO_DIR, `${key}.json`);
    const cached = await readJSON(file, null);
    if (cached && cached.text && !force) return { ok: true, cached: true, ...cached };
    if (!hasKey()) return { ok: false, key, error: '事件图景要用模型来写，先在「设置」里填 API key。' };
    const step = (n, detail) => send('pano:progress', { key, step: n, detail });
    const title = String(seed.title || '').trim();
    try {
      step(1, '想该搜什么');
      let plan = null;
      try {
        plan = parseJSONLoose(stripThink(await chatCall(
          [{ role: 'system', content: PQ_SYS }, { role: 'user', content: `标题：${title}\n摘要：${clipText(seed.summary || '', 500)}` }],
          { temperature: 0, maxTokens: 400 },
        )));
      } catch { /* 用标题兜底 */ }
      const queries = [...new Set([...(Array.isArray(plan?.queries) ? plan.queries : []), plan?.query_en, title.slice(0, 30)]
        .map(cleanQuery).filter((q) => q.length >= 4))].slice(0, 5);
      const core = String(plan?.core || '').trim();

      step(2, `联网搜 ${queries.length} 组：${queries.join(' / ')}`);
      const found = new Map();
      if (seed.url) found.set(normUrl(seed.url), { title, url: seed.url, host: hostOf(seed.url), desc: seed.summary || '', date: seed.date || '', via: '起点' });
      for (const q of queries.slice(0, 3)) {
        try {
          // 新闻最多留 12 条，给普通搜索（背景、百科、原始公告）留位置
          for (const r of await newsSearch(q)) {
            const u = normUrl(r.url);
            if (u && !found.has(u) && found.size < 13) found.set(u, { ...r, via: '新闻' });
          }
        } catch { /* 没代理就只用普通搜索 */ }
      }
      for (const q of queries) {
        await pause(900);
        try {
          for (const r of await webSearch(q, 8)) {
            const u = normUrl(r.url);
            if (u && !found.has(u)) found.set(u, { title: r.title, url: r.url, host: r.host || hostOf(r.url), desc: r.desc || '', date: r.date || '', via: '联网' });
          }
        } catch { /* 单组失败跳过 */ }
      }
      const local = await searchLocal([core, ...queries].filter(Boolean)[0] || title, 12);
      for (const r of local) {
        const u = normUrl(r.url);
        if (u && !found.has(u)) found.set(u, { title: r.title, url: r.url, host: hostOf(r.url), desc: r.sub || '', date: r.date || '', via: '本机记录' });
      }
      let sources = [...found.values()].slice(0, 22);

      // 读几篇原文：每个网站最多一篇，优先起点和搜索靠前的
      const hostsRead = new Set();
      const toRead = sources.filter((s) => /^https?:/.test(s.url) && !/bilibili\.com\/video|zhihu\.com\/question/.test(s.url))
        .filter((s) => { if (hostsRead.has(s.host)) return false; hostsRead.add(s.host); return true; })
        .slice(0, 5);
      step(3, `读原文 ${toRead.length} 篇`);
      await Promise.all(toRead.map(async (s) => {
        try { s.excerpt = await pageText(s.url); } catch { /* 读不到就只用摘要 */ }
      }));
      if (sources.length < 2) return { ok: false, key, error: '搜不到足够的资料，换个条目或稍后再试。' };

      step(4, '写图景');
      const material = sources.map((s, i) => `[${i + 1}] ${s.title}｜${s.host}${s.date ? '｜' + s.date : ''}｜${s.via}\n${clipText(s.excerpt || s.desc || '', s.excerpt ? 2600 : 300)}`).join('\n\n');
      const raw = await chatCall(
        [
          { role: 'system', content: PANO_SYS },
          { role: 'user', content: `要讲清楚的事：${title}\n${seed.summary ? '起点摘要：' + clipText(seed.summary, 400) + '\n' : ''}今天是 ${todayStr()}。\n\n<资料>\n${material}\n</资料>` },
        ],
        { temperature: 0.3, maxTokens: 3200, onDelta: (t) => send('pano:delta', { key, text: t }) },
      );
      const list = sources.map((s, i) => ({ n: i + 1, title: s.title, url: s.url, host: s.host, date: s.date, via: s.via, read: !!s.excerpt }));
      const text = `${stripThink(raw)}\n\n## 来源\n\n${list.map((s) => `- [${s.n}] [${s.title}](${s.url})｜${s.host}${s.date ? '｜' + s.date : ''}${s.read ? '｜读了原文' : ''}`).join('\n')}`;
      const out = { key, seed: { ...seed, title }, text, sources: list, queries, at: new Date().toISOString() };
      await fsp.mkdir(PANO_DIR, { recursive: true });
      await fsp.writeFile(file, JSON.stringify(out, null, 2), 'utf8');
      step(5, '完成');
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, key, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  return { load, create, update, remove, refreshNow, refreshAll, report, digestBlock, panorama, newsSearch, panoKeyOf: (seed) => hash(normUrl(seed.url) || seed.title) };
}

module.exports = { createEvents };
