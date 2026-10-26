#!/usr/bin/env node
/**
 * AI Radar — 每日信息采集器（零依赖，Node >= 20）
 *
 * 只做「确定性」工作：抓取 + 归一化 + 和昨天比增量 + 生成紧凑 brief。
 * 不做摘要、不做判断 —— 那是 agent 那一层的事。
 *
 * 输出：
 *   data/YYYY-MM-DD.json   完整结构化数据
 *   inbox/YYYY-MM-DD.md    给 agent 读的紧凑简报（~2k tokens）
 *   inbox/latest.md        最新一份的副本
 *   state/stars.json       星标基线（算 24h 增速）
 *   state/seen.json        去重：项目首次出现日期
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickSkills, groupSkills } from './skills.mjs';
import { searchMany } from './websearch.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = {
  data: path.join(ROOT, 'data'),
  inbox: path.join(ROOT, 'inbox'),
  state: path.join(ROOT, 'state'),
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const TODAY = new Date();
const TAH = TODAY.getTime();
const DATE = process.env.RADAR_DATE || isoDate(TODAY); // 允许回填某一天
const status = {};

/* ---------------------------------------------------------------- utils */

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysAgo(n) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return isoDate(d);
}
function daysBetween(a, b) {
  return Math.max(0, (new Date(b) - new Date(a)) / 86400000);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { timeout = 25000, headers = {}, tries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, ...headers },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      if (!res.ok) {
        // 403/429 多数是限流：隔 65 秒再试一次，别把一整类数据丢成 0 条
        const err = new Error(`HTTP ${res.status}`);
        err.limited = res.status === 403 || res.status === 429;
        throw err;
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(e.limited ? 65000 : 1200);
    }
  }
  throw lastErr;
}
async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}
// 系统代理：应用从 Windows 设置读出来用 RADAR_PROXY 传进来，命令行跑时认 HTTPS_PROXY。
// 只有直连常被墙的源（Civitai、Hugging Face）走它，其他源照旧直连。
const PROXY = process.env.RADAR_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';

/** 经 HTTP 代理的 CONNECT 隧道取一个 https 地址（零依赖；跟随重定向） */
function proxyText(url, { timeout = 30000, headers = {}, hops = 3 } = {}) {
  const u = new URL(url);
  const p = new URL(PROXY);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${u.hostname}:443`, timeout });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理 CONNECT ${res.statusCode}`)); return; }
      const get = https.get({
        host: u.hostname, path: u.pathname + u.search, socket, servername: u.hostname, agent: false, timeout,
        headers: { 'user-agent': UA, ...headers },
      }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops > 0) {
          r.resume();
          resolve(proxyText(new URL(r.headers.location, url).href, { timeout, headers, hops: hops - 1 }));
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
/** 有代理先走代理、失败再直连；没代理就直连 */
async function fetchJsonWall(url, opts = {}) {
  if (PROXY) {
    try { return JSON.parse(await proxyText(url, opts)); } catch { /* 再直连试一次 */ }
  }
  return fetchJson(url, opts);
}

async function trySource(name, fn) {
  try {
    const v = await fn();
    status[name] = 'ok';
    return v;
  } catch (e) {
    status[name] = `fail: ${String(e.message || e).slice(0, 90)}`;
    return null;
  }
}

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
function stripTags(s = '') {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function clip(s = '', n = 220) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 极简 RSS/Atom 解析：够用即可，不引依赖 */
function parseFeed(xml, { limit = 30 } = {}) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1] : '';
    };
    let link = stripTags(pick('link'));
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const title = stripTags(pick('title'));
    const desc = stripTags(pick('description') || pick('summary') || pick('content'));
    const raw = stripTags(pick('pubDate') || pick('published') || pick('updated'));
    const ts = raw ? Date.parse(raw) : NaN;
    if (!title) continue;
    out.push({
      title: clip(decodeEntities(title), 160),
      link: link.trim(),
      date: Number.isFinite(ts) ? isoDate(new Date(ts)) : '',
      summary: clip(desc, 240),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------ collection */

const AI_WORDS = [
  'llm', 'gpt', 'claude', 'gemini', 'llama', 'qwen', 'deepseek', 'kimi', 'minimax',
  'agent', 'agentic', 'rag', 'transformer', 'diffusion', 'vision', 'multimodal',
  'openai', 'anthropic', 'mistral', 'inference', 'fine-tune', 'finetune', 'embedding',
  'mcp', 'reasoning', 'prompt', 'neural', 'text-to', 'speech', 'tts', 'asr', 'model',
];
const AI_RE = new RegExp(`\\b(${AI_WORDS.join('|')})\\b`, 'i');

function ghHeaders() {
  const h = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (GH_TOKEN) h.authorization = `Bearer ${GH_TOKEN}`;
  return h;
}

async function githubSearch(q, { sort = 'stars', perPage = 25 } = {}) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${perPage}`;
  const j = await fetchJson(url, { headers: ghHeaders() });
  return (j.items || []).map(normalizeRepo);
}

function normalizeRepo(r) {
  const createdDays = Math.max(1, daysBetween(r.created_at, isoDate(TODAY)));
  const pushedDays = Math.max(0, daysBetween(r.pushed_at, isoDate(TODAY)));
  return {
    full_name: r.full_name,
    url: r.html_url,
    desc: clip(r.description || '', 180),
    stars: r.stargazers_count,
    forks: r.forks_count,
    lang: r.language || '',
    topics: (r.topics || []).slice(0, 6),
    created: (r.created_at || '').slice(0, 10),
    pushed: (r.pushed_at || '').slice(0, 10),
    stars_per_day_since_birth: +(r.stargazers_count / createdDays).toFixed(1),
    created_days_ago: Math.round(createdDays),
    pushed_days_ago: Math.round(pushedDays),
  };
}

async function collectGitHub() {
  const out = { new_repos: [], active: [], ai_new: [], skills_raw: [] };
  out.new_repos = await githubSearch(`created:>${daysAgo(7)} stars:>60`);
  await sleep(2500);
  out.active = await githubSearch(`pushed:>${daysAgo(2)} stars:>4000`);
  await sleep(2500);
  out.ai_new = await githubSearch(`created:>${daysAgo(30)} ai OR agent OR llm in:name,description stars:>25`);
  await sleep(2500);
  // 技能：名字/描述里带 skill 的项目，再按作用对象归类（skills.mjs 与主进程共用规则）
  out.skills_raw = await githubSearch(`skills in:name,description,topics stars:>40 pushed:>${daysAgo(45)}`);
  return out;
}

/** 用基线算 24h 星标增量 —— 这是最真实的「正在火」信号 */
async function computeVelocity(repos) {
  const file = path.join(DIR.state, 'stars.json');
  let prev = {};
  if (existsSync(file)) {
    try { prev = JSON.parse(await readFile(file, 'utf8')); } catch { prev = {}; }
  }
  const next = { ...prev };
  const velocity = [];
  for (const r of repos) {
    const key = r.full_name;
    const before = prev[key];
    if (before && typeof before.stars === 'number') {
      const gain = r.stars - before.stars;
      const hours = Math.max(1, (TAH - Date.parse(before.ts)) / 3600000);
      // 基线太新（<6h）时按 24h 外推会失真，宁可不报
      if (hours >= 6) {
        velocity.push({
          full_name: r.full_name,
          url: r.url,
          stars: r.stars,
          gain_24h: Math.round((gain / hours) * 24),
          gain_raw: gain,
          lang: r.lang,
          desc: r.desc,
        });
      }
    }
    next[key] = { stars: r.stars, ts: new Date(TAH).toISOString() };
  }
  const keep = new Set(repos.map((r) => r.full_name));
  for (const k of Object.keys(next)) {
    if (!keep.has(k) && !(prev[k] && Date.parse(prev[k].ts) > TAH - 14 * 86400000)) delete next[k];
  }
  velocity.sort((a, b) => b.gain_24h - a.gain_24h);
  return { velocity, next };
}

/* --------------------------------------------------------- skills.sh
 * skills.sh 是跨 agent 的技能市场（安装量是它自己的信号，GitHub 星星看不出来）。
 * 页面是 Next.js，榜单直接嵌在 RSC payload 的 initialSkills 数组里：
 *   {source:"owner/repo", skillId, name, installs, weeklyInstalls[8], isOfficial}
 * 这里只取首页那 600 条（一次请求约 900KB），再和上一份快照比 24h 安装增量。
 */

/** 从 "self.__next_f.push([1,\"...\"])" 分块里拼出 RSC 文本 */
function rscPayload(html) {
  const marker = 'self.__next_f.push([1,';
  let i = 0;
  let out = '';
  while ((i = html.indexOf(marker, i)) !== -1) {
    i += marker.length;
    const end = html.indexOf('])', i);
    if (end === -1) break;
    try { out += JSON.parse(html.slice(i, end)); } catch { /* 跳过坏块 */ }
    i = end + 2;
  }
  return out;
}

/** 从 start（指向 '['）扫到匹配的 ']'，跳过字符串内部 */
function matchBracket(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
}

async function collectSkillsSh() {
  const html = await fetchText('https://www.skills.sh/', { timeout: 40000 });
  const payload = rscPayload(html);
  const raw = [];
  let idx = 0;
  while ((idx = payload.indexOf('"initialSkills":', idx)) !== -1) {
    const start = payload.indexOf('[', idx);
    const txt = matchBracket(payload, start);
    if (txt) {
      try { raw.push(...JSON.parse(txt)); } catch { /* 单块坏了不影响其它 */ }
    }
    idx = start + 1;
  }
  if (!raw.length) throw new Error('页面里没找到 initialSkills（结构可能变了）');

  // 同一个技能可能在多个榜单里重复出现，按 source/skillId 去重
  const uniq = new Map();
  for (const s of raw) {
    if (!s || !s.source || !s.skillId) continue;
    uniq.set(`${s.source}/${s.skillId}`, s);
  }

  // 上一份快照，用来算 24h 安装增量（和 stars.json 一个思路；不足 6h 不外推）
  const snapFile = path.join(DIR.state, 'skills_sh.json');
  let prev = {};
  if (existsSync(snapFile)) {
    try { prev = JSON.parse(await readFile(snapFile, 'utf8')); } catch { prev = {}; }
  }
  const prevMap = prev.items || {};
  const hours = prev.ts ? Math.max(1, (TAH - Date.parse(prev.ts)) / 3600000) : 0;
  const usable = hours >= 6;

  const items = [];
  for (const s of uniq.values()) {
    const w = Array.isArray(s.weeklyInstalls) ? s.weeklyInstalls.slice(-8) : [];
    const key = `${s.source}/${s.skillId}`;
    const before = prevMap[key];
    const gain = usable && typeof before === 'number' ? s.installs - before : null;
    items.push({
      key,
      name: s.name || s.skillId,
      source: s.source,
      skill_id: s.skillId,
      installs: s.installs || 0,
      weekly: w,
      week_delta: w.length >= 2 ? w[w.length - 1] - w[w.length - 2] : null,
      install_24h: gain === null ? null : Math.round((gain / hours) * 24),
      official: !!s.isOfficial,
      url: `https://www.skills.sh/${s.source}/${s.skillId}`,
      cmd: `npx skills add ${s.source} --skill ${s.skillId}`,
    });
  }

  items.sort((a, b) => b.installs - a.installs);
  const next = { ts: new Date(TAH).toISOString(), items: {} };
  for (const it of items) next.items[it.key] = it.installs;
  await writeFile(snapFile, JSON.stringify(next), 'utf8');

  // 每日快照只留前 150 名、去掉每周明细（weekly 只用来算 week_delta），
  // 否则 600 条 × 8 周会把 data/*.json 撑到 470KB，天天存一份太浪费。
  const trimmed = items.slice(0, 150).map(({ weekly, ...rest }) => rest);

  return {
    source_url: 'https://www.skills.sh/',
    total: items.length,
    official: items.filter((i) => i.official).length,
    sources: new Set(items.map((i) => i.source)).size,
    total_installs: items.reduce((n, i) => n + i.installs, 0),
    has_baseline: usable,
    items: trimmed,
  };
}

async function collectModels() {
  const out = { openrouter_new: [], ollama_new: [] };

  out.openrouter_new = (await trySource('openrouter', async () => {
    const j = await fetchJson('https://openrouter.ai/api/v1/models', { timeout: 30000 });
    const cutoff = TAH / 1000 - 21 * 86400;
    return (j.data || [])
      .filter((m) => (m.created || 0) > cutoff)
      .sort((a, b) => b.created - a.created)
      .slice(0, 40)
      .map((m) => ({
        id: m.id,
        name: m.name,
        created: isoDate(new Date(m.created * 1000)),
        context: m.context_length,
        prompt_price: m.pricing?.prompt ? +(Number(m.pricing.prompt) * 1e6).toFixed(2) : null,
        completion_price: m.pricing?.completion ? +(Number(m.pricing.completion) * 1e6).toFixed(2) : null,
        modality: m.architecture?.modality || '',
      }));
  })) || [];

  out.ollama_new = (await trySource('ollama', async () => {
    const html = await fetchText('https://ollama.com/library?sort=newest', { timeout: 30000 });
    const seen = new Set();
    const rows = [];
    // 每个模型一个 <li>，内含名称、简介、能力标签
    const blocks = html.match(/<li[^>]*class="flex items-baseline[^"]*"[\s\S]*?<\/li>/gi) || [];
    for (const seg of blocks) {
      const nm = seg.match(/href="\/library\/([^"?]+)"/i);
      if (!nm) continue;
      const name = nm[1];
      if (seen.has(name)) continue;
      const descM = seg.match(/<p[^>]*class="[^"]*text-neutral-800[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
        || seg.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const desc = stripTags(descM ? descM[1] : '');
      if (!desc || /^(github|download)/i.test(desc)) continue;
      const updated = seg.match(/(\d+\s+(?:second|minute|hour|day|week|month)s?\s+ago)/i);
      const caps = [...seg.matchAll(/bg-indigo-50[^>]*>\s*([a-z][a-z0-9-]*)\s*</gi)].map((x) => x[1].toLowerCase());
      seen.add(name);
      rows.push({ name, desc: clip(desc, 120), updated: updated ? updated[1] : '', caps: [...new Set(caps)] });
      if (rows.length >= 25) break;
    }
    return rows;
  })) || [];

  return out;
}

async function collectNews() {
  const feeds = [
    ['OpenAI', 'https://openai.com/news/rss.xml'],
    ['Anthropic', 'https://www.anthropic.com/news'],
    ['量子位', 'https://www.qbitai.com/feed'],
    ['机器之心', 'https://www.jiqizhixin.com/rss'],
    ['Simon Willison', 'https://simonwillison.net/atom/everything/'],
    ['GitHub Blog', 'https://github.blog/feed/'],
    ['LMSYS', 'https://lmsys.org/blog/'],
  ];
  const items = [];
  for (const [source, url] of feeds) {
    const got = await trySource(`feed:${source}`, async () => {
      const body = await fetchText(url, { timeout: 30000 });
      if (/<rss|<feed/i.test(body)) return parseFeed(body, { limit: 12 });
      // Anthropic /news 是 Next.js 页面：标题与链接通常在同一个 <a> 片段内
      const out = [];
      for (const seg of body.split(/<a\s/i)) {
        const l = seg.match(/^[^>]*href="(\/news\/[a-z0-9-]{6,})"/i);
        if (!l) continue;
        const t = seg.match(/data-component="Headline"[^>]*>([^<]{8,140})</i)
          || seg.match(/<h[23][^>]*>([^<]{8,140})</i);
        if (!t) continue;
        out.push({
          title: clip(decodeEntities(t[1]).trim(), 140),
          link: 'https://www.anthropic.com' + l[1],
          date: '',
          summary: '',
        });
        if (out.length >= 24) break;
      }
      const seenLinks = new Set();
      return out.filter((x) => {
        if (seenLinks.has(x.link)) return false;
        seenLinks.add(x.link);
        return true;
      }).slice(0, 12);
    });
    if (got) for (const it of got) items.push({ source, ...it });
  }
  const cutoff = daysAgo(10);
  return items.filter((it) => !it.date || it.date >= cutoff).slice(0, 70);
}

async function collectPapers() {
  return (await trySource('arxiv', async () => {
    const q = 'cat:cs.CL+OR+cat:cs.AI+OR+cat:cs.LG';
    const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=60`;
    const xml = await fetchText(url, { timeout: 40000 });
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
    const out = [];
    for (const e of entries) {
      const g = (t) => stripTags((e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1] || '');
      const title = g('title');
      const summary = g('summary');
      if (!AI_RE.test(title + ' ' + summary)) continue;
      out.push({
        title: clip(title, 160),
        link: g('id'),
        date: (g('published') || '').slice(0, 10),
        summary: clip(summary, 300),
      });
      if (out.length >= 14) break;
    }
    return out;
  })) || [];
}

async function collectHN() {
  return (await trySource('hn', async () => {
    const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json', { timeout: 20000 });
    const head = ids.slice(0, 120);
    const items = [];
    const queue = [...head];
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        try {
          const it = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 15000 });
          if (!it || !it.title || it.dead || it.deleted) continue;
          const blob = `${it.title} ${it.url || ''}`;
          if (!AI_RE.test(blob) && !/show hn/i.test(it.title)) continue;
          items.push({
            title: clip(it.title, 150),
            url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
            hn: `https://news.ycombinator.com/item?id=${it.id}`,
            points: it.score || 0,
            comments: it.descendants || 0,
          });
        } catch { /* 单条失败忽略 */ }
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker));
    return items.sort((a, b) => b.points - a.points).slice(0, 12);
  })) || [];
}

/* --------------------------------------------------------------- writers */

async function loadSeen() {
  const f = path.join(DIR.state, 'seen.json');
  if (!existsSync(f)) return {};
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return {}; }
}

/** 上一份采集数据（用于源挂掉时沿用，避免把昨天的条目清空）。 */
async function loadPrevPack() {
  try {
    const files = (await (await import('node:fs/promises')).readdir(DIR.data))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace('.json', ''))
      .filter((d) => d < DATE)
      .sort()
      .reverse();
    if (!files.length) return null;
    return JSON.parse(await readFile(path.join(DIR.data, `${files[0]}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/* ---- B站 / 知乎：普通人在看什么、在吵什么 ---- */

// 紧关键词：宁可少抓，也别把「科技」「程序员」这种宽词算成 AI
const AI_TIGHT =
  /(人工智能|大模型|LLM|AIGC|\bAI\b|GPT|ChatGPT|Claude|DeepSeek|Kimi|Qwen|通义|文心|豆包|智谱|GLM|Gemini|Llama|Sora|Midjourney|Stable Diffusion|ComfyUI|扩散模型|多模态|智能体|Agent|MCP|RAG|LoRA|微调|量化|推理模型|提示词|Prompt|Copilot|Cursor|Ollama|数字人|具身智能|算力|英伟达|NVIDIA|昇腾|显存)/i;

const BILI_HEAD = { referer: 'https://www.bilibili.com/', 'accept-language': 'zh-CN,zh;q=0.9' };
const WBI_MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];
/** 免登录拿 buvid（B站用它做匿名设备标识），热门/分区榜/搜索都要带上，否则容易吃风控 */
async function biliCookie() {
  const j = await fetchJson('https://api.bilibili.com/x/frontend/finger/spi', { headers: BILI_HEAD });
  if (!j?.data?.b_3) throw new Error('spi 没给 buvid');
  return `buvid3=${j.data.b_3}; buvid4=${j.data.b_4 || ''};`;
}

// 关键词池每天轮换 3 个：同一个词天天搜，回来的还是同一批视频
const BILI_KEYWORD_POOL = [
  '本地部署大模型', 'ComfyUI 工作流', 'Qwen 本地部署', 'Stable Diffusion 教程',
  'Ollama 教程', 'AI 编程 教程', 'LoRA 微调 教程', '像素画 AI 生成',
];
const BILI_KEYWORDS = (() => {
  const seed = Number(DATE.replace(/-/g, '').slice(-6)) || 1;
  const start = seed % BILI_KEYWORD_POOL.length;
  return [0, 1, 2].map((i) => BILI_KEYWORD_POOL[(start + i) % BILI_KEYWORD_POOL.length]);
})();
// 分区榜里混着「AI MV 大赛」「鬼畜」这类创作赛作品，对判断技术没用
const BILI_NOISE = /(鬼畜|MV ?大赛|全民制作人|AI ?特效)/i;

function biliSign(params, key) {
  const p = new URLSearchParams(params);
  p.set('wts', String(Math.floor(Date.now() / 1000)));
  const s = [...p.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${s}&w_rid=${crypto.createHash('md5').update(s + key).digest('hex')}`;
}

async function collectBilibili() {
  return await trySource('bilibili', async () => {
    const cookie = await biliCookie();
    const found = new Map();
    const lookedAt = new Set();
    const add = (v, why) => {
      if (!v?.bvid || found.has(v.bvid)) return;
      const title = clip(stripTags(v.title || ''), 130);
      if (BILI_NOISE.test(title)) return;
      // 分区榜/热门里混着几年前的老片（B站的「排行」会长期挂着高播放的旧视频），只留三个月内的
      const ageDays = v.pubdate ? (TAH - v.pubdate * 1000) / 86400000 : 999;
      if (ageDays > 90) return;
      found.set(v.bvid, {
        kind: 'video',
        title,
        author: v.author || v.owner?.name || '',
        url: `https://www.bilibili.com/video/${v.bvid}`,
        play: Number(v.play ?? v.stat?.view ?? 0),
        like: Number(v.like ?? v.stat?.like ?? 0),
        danmaku: Number(v.danmaku ?? v.stat?.danmaku ?? 0),
        tname: v.tname || '',
        why,
        date: v.pubdate ? isoDate(new Date(v.pubdate * 1000)) : '',
      });
    };

    // 1) 全站热门：B站自己筛过一遍，这里只挑和 AI 沾边的
    try {
      const pop = await fetchJson('https://api.bilibili.com/x/web-interface/popular?ps=50', {
        headers: { ...BILI_HEAD, cookie },
      });
      for (const v of pop?.data?.list || []) {
        lookedAt.add(v.bvid);
        if (AI_TIGHT.test(String(v.title || ''))) add(v, '全站热门');
      }
    } catch { /* 热门挂了还有分区榜和搜索 */ }
    await sleep(1500);

    // 2) 科技分区榜（rid=188）：按播放排的「这一周科技区被看最多的」，需要 WBI 签名
    try {
      const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav', {
        headers: { ...BILI_HEAD, cookie },
      });
      const img = nav?.data?.wbi_img;
      if (img) {
        const raw = img.img_url.split('/').pop().split('.')[0] + img.sub_url.split('/').pop().split('.')[0];
        const wbiKey = WBI_MIXIN.map((i) => raw[i] || '').join('').slice(0, 32);
        const rank = await fetchJson(
          `https://api.bilibili.com/x/web-interface/ranking/v2?${biliSign({ rid: '188', type: 'all' }, wbiKey)}`,
          { headers: { ...BILI_HEAD, cookie, referer: 'https://www.bilibili.com/v/popular/rank/all' } },
        );
        for (const v of rank?.data?.list || []) {
          lookedAt.add(v.bvid);
          if (AI_TIGHT.test(String(v.title || ''))) add(v, '科技分区榜');
        }
      }
    } catch { /* 同上 */ }

    // 3) 关键词搜索（老接口不要签名，新接口会返回 v_voucher 让人过验证）：
    //    只留 30 天内、播放过 3000 的 —— 这部分最容易出「能跟着做的教程」
    for (const kw of BILI_KEYWORDS) {
      await sleep(1800);
      let rows = [];
      try {
        const j = await fetchJson(
          `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=${encodeURIComponent(kw)}`,
          { headers: { ...BILI_HEAD, cookie, referer: 'https://search.bilibili.com/' } },
        );
        rows = j?.data?.result || [];
      } catch { continue; }
      for (const v of rows) {
        const days = v.pubdate ? (TAH - v.pubdate * 1000) / 86400000 : 999;
        if (days > 30) continue;
        if (Number(v.play) < 3000) continue;
        if (!AI_TIGHT.test(String(v.title || ''))) continue;
        lookedAt.add(v.bvid);
        add(v, `搜「${kw}」`);
      }
    }

    const items = [...found.values()].sort((x, y) => y.play - x.play).slice(0, 20);
    return { source_url: 'https://www.bilibili.com', scanned: lookedAt.size, total: found.size, items };
  });
}

/* ---- 联网搜索：补 RSS 覆盖不到的中文实测与二手转述 ---- */

// 查询词从「当天新上架的模型名」来：实测泛词只返回官网首页，
// 而「<模型名> 实测」能拿到 36kr / 爱范儿 / 网易 / B站 这类真正的评测文章。
function webQueryName(raw = '') {
  return String(raw)
    .split(':')
    .pop()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function webQueries(models) {
  const cands = (models?.openrouter_new || []).slice(0, 8).map((m) => webQueryName(m.name));
  const seen = new Set();
  const out = [];
  for (const n of cands) {
    if (!n || n.length < 5 || n.length > 40) continue;
    // 「MiniMax MiniMax M3.1 Flash」这种厂商名重复的只留后半
    const half = n.split(' ').filter((w, i, a) => a.indexOf(w) === i).join(' ');
    if (seen.has(half.toLowerCase())) continue;
    seen.add(half.toLowerCase());
    out.push(half + ' 实测');
    if (out.length >= 2) break;
  }
  return out.length ? out : ['大模型 发布 实测'];
}

async function collectWeb(models) {
  return await trySource('web', async () => {
    const queries = webQueries(models);
    let items = await searchMany(queries, { perQuery: 5, timeout: 20000 });
    // 结果太少时补一次「评测」，模型名的召回率会好一些
    if (items.length < 3) {
      const alt = await searchMany(queries.map((q) => q.replace('实测', '评测')), { perQuery: 5, timeout: 20000 });
      const seen = new Set(items.map((x) => x.url));
      for (const a of alt) if (!seen.has(a.url)) items.push(a);
    }
    const drop =
      /^https?:\/\/(\w+\.)?(baike\.baidu\.com|huggingface\.co\/?$|github\.com\/?$|gitee\.com\/?$|zhihu\.com\/?$|juejin\.cn\/?$)/i;
    const kept = items
      .filter((r) => !drop.test(r.url))
      .filter((r) => String(r.desc || '').length >= 24 || /\d{4}-\d{2}-\d{2}|\d+月\d+日/.test(String(r.title)))
      .slice(0, 14);
    return {
      engine: 'bing-rss',
      source_url: 'https://cn.bing.com/',
      queries,
      total: kept.length,
      items: kept,
    };
  });
}

// ───────────── 前沿动态：AI 又能做什么了 ─────────────
// 状态分五档，从「只有论文」到「现在就能用」。新手最需要知道的是「到哪一步了」。
const FRONTIER_STATUS = {
  paper: { key: 'paper', label: '论文提出', note: '只有论文，别人还没复现' },
  demo: { key: 'demo', label: '已有演示', note: '有演示页或视频，能看到效果' },
  code: { key: 'code', label: '有开源实现', note: '代码能跑，但要自己配环境' },
  beta: { key: 'beta', label: '开放测试', note: '能申请或试用，还没正式发布' },
  ga: { key: 'ga', label: '正式可用', note: '模型已上架 / 有正式版本' },
};

function frontierStatus(it, gaNames) {
  const hay = it.title + ' ' + (it.summary || '');
  if (gaNames.some((n) => n && it.title.toLowerCase().includes(n.toLowerCase()))) return 'ga';
  if (/\b(beta|preview|waitlist|early access|申请|内测|公测)\b/i.test(hay)) return 'beta';
  if (it.repo) return 'code';
  if (it.project || it.video) return 'demo';
  return 'paper';
}

/** 一句话说清「到哪一步了」：不是状态名，是能做什么 */
function frontierCanDo(it) {
  if (it.status === 'ga') return '现在就能用：模型或工具已经上架。';
  if (it.status === 'beta') return '能试用，但接口和价格还可能变。';
  if (it.status === 'code') return '能自己跑：仓库已开源' + (it.stars ? '（' + it.stars + ' 星）' : '') + '。';
  if (it.status === 'demo') return '能看效果，还拿不到成品。';
  return '只有论文结论，离能用还有距离。';
}

async function collectFrontier(models) {
  const gaNames = [
    ...(models?.openrouter_new || []).map((m) => m.name || m.id),
    ...(models?.ollama_new || []).map((m) => m.name),
  ]
    .filter(Boolean)
    .slice(0, 60);

  const raw = await trySource('hf_papers', async () => {
    // huggingface.co 本机不可达（000），hf-mirror.com 是同一个 Daily Papers API 的镜像
    const j = await fetchJson('https://hf-mirror.com/api/daily_papers?limit=30', { timeout: 25000 });
    return (Array.isArray(j) ? j : [])
      .map((x) => {
        const p = x.paper || {};
        const id = String(p.id || '');
        return {
          id,
          title: stripTags(p.title || ''),
          summary: clip(stripTags(p.summary || ''), 320),
          ai_summary: clip(stripTags(p.ai_summary || ''), 320),
          keywords: (p.ai_keywords || []).slice(0, 6),
          upvotes: Number(p.upvotes || 0),
          published: String(p.publishedAt || '').slice(0, 10),
          arxiv: id ? 'https://arxiv.org/abs/' + id : '',
          hf: id ? 'https://huggingface.co/papers/' + id : '',
          repo: p.githubRepo || '',
          stars: Number(p.githubStars || 0) || 0,
          project: p.projectPage || '',
          video: (p.mediaUrls || []).some((u) => /\.(mp4|webm|gif)$/i.test(String(u))),
        };
      })
      .filter((x) => x.title && x.id);
  });

  const papers = (raw || []).map((it) => {
    const status = frontierStatus(it, gaNames);
    return {
      ...it,
      kind: 'paper',
      status,
      status_label: FRONTIER_STATUS[status].label,
      // 热度只是「多少人点了收藏」，不等于效果；排序时和「有没有代码 / 演示」一起看
      signal: (it.upvotes || 0) + (it.repo ? 12 : 0) + (it.project ? 6 : 0) + (it.stars >= 100 ? 8 : 0),
    };
  });

  // 模型侧「相比之前变了什么」：降价、上下文变长、本地能跑了
  const changes = [];
  const snapPath = path.join(DIR.state, 'models.json');
  let prevSnap = {};
  try {
    prevSnap = JSON.parse(await readFile(snapPath, 'utf8')) || {};
  } catch {
    prevSnap = {};
  }
  const curSnap = { ...prevSnap };
  const money = (v) => (v == null ? '?' : '$' + v);
  for (const m of models?.openrouter_new || []) {
    const before = prevSnap[m.id];
    curSnap[m.id] = { prompt: m.prompt_price, completion: m.completion_price, context: m.context, name: m.name };
    if (!before) continue;
    if (before.prompt != null && m.prompt_price != null && m.prompt_price < before.prompt - 1e-9) {
      changes.push({
        kind: 'model',
        what: '降价',
        title: m.name || m.id,
        detail: '输入价从 ' + money(before.prompt) + ' 降到 ' + money(m.prompt_price) + ' 每百万 token',
        url: 'https://openrouter.ai/' + m.id,
        date: DATE,
      });
    }
    if (before.context && m.context && m.context > before.context * 1.5) {
      changes.push({
        kind: 'model',
        what: '上下文变长',
        title: m.name || m.id,
        detail: '上下文从 ' + Math.round(before.context / 1000) + 'K 提到 ' + Math.round(m.context / 1000) + 'K',
        url: 'https://openrouter.ai/' + m.id,
        date: DATE,
      });
    }
  }
  for (const m of (models?.ollama_new || []).slice(0, 3)) {
    changes.push({
      kind: 'local',
      what: '本地能跑了',
      title: m.name,
      detail: '已上 Ollama 库' + (m.caps && m.caps.length ? '（' + m.caps.join('/') + '）' : '') + '，有显卡就能离线跑',
      url: 'https://ollama.com/library/' + m.name,
      date: DATE,
    });
  }
  await writeFile(snapPath, JSON.stringify(curSnap), 'utf8');

  const all = papers.sort((a, b) => b.signal - a.signal).map((it) => ({ ...it, can_do: frontierCanDo(it) }));
  const fresh = all.filter((x) => x.published >= daysAgo(3));
  const today = (fresh.length >= 3 ? fresh : all).slice(0, 5);

  return {
    source_url: 'https://huggingface.co/papers',
    api: 'https://hf-mirror.com/api/daily_papers',
    scanned: all.length,
    total: all.length,
    today,
    week: changes.slice(0, 10),
    items: all.slice(0, 24),
    status_counts: all.reduce((acc, x) => {
      acc[x.status] = (acc[x.status] || 0) + 1;
      return acc;
    }, {}),
  };
}

async function collectZhihu() {
  return await trySource('zhihu', async () => {
    // 知乎热榜没有公开接口：直连 /api/v3/feed/topstory/hot-lists 是 401「身份未经过验证」，
    // /billboard、/hot 是 403 反爬，RSSHub 公共实例也都不通。这里用 tophub.today 的镜像节点。
    const html = await fetchText('https://tophub.today/n/mproPpoq6O', {
      headers: { 'accept-language': 'zh-CN,zh;q=0.9', referer: 'https://tophub.today/' },
      tries: 2,
    });
    const all = [];
    const re =
      /<a href="(https:\/\/www\.zhihu\.com\/question\/\d+)"[^>]*>([^<]{4,200})<\/a>\s*<\/div>\s*<div class="item-desc">([^<]*)<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
      const title = stripTags(m[2]);
      if (!title) continue;
      all.push({
        kind: 'zhihu',
        title: clip(title, 140),
        url: m[1],
        heat: clip(stripTags(m[3] || ''), 20),
        why: '热榜',
      });
    }
    // 热榜是全网红黑榜，只留跟 AI 沾边的
    const ai = all.filter((x) => AI_TIGHT.test(x.title));
    return { source_url: 'https://tophub.today/n/mproPpoq6O', scanned: all.length, total: ai.length, items: ai.slice(0, 12) };
  });
}

/* ---------------------------------------- 追踪名单（需求雷达「持续帮我关注」） */

/* ---- AI 生图与工作流：新模型、能出图的 API、工作流、社区模型、开源项目与 ComfyUI 节点、中文教程 ---- */

const IMG_HF_TASKS = [['text-to-image', '文生图'], ['image-to-image', '图生图 / 编辑']];
// 这一栏会随分享版发出去：Civitai 只留 PG / PG-13（nsfwLevel ≤ 3）、不是真人肖像的条目，HF 去掉标了成人内容的
const IMG_ADULT = /(uncensor|nsfw|nude|naked|hentai|porn|lewd|erotic|sexy|18+|无删减|擦边)/i;
const civitaiSafe = (m) => !m.nsfw && !m.poi && !m.minor && (Number(m.nsfwLevel) || 0) <= 3 &&
  !IMG_ADULT.test(`${m.name} ${(m.tags || []).join(' ')}`);
const IMG_STRONG = /(ComfyUI|Stable ?Diffusion|SDXL|\bSD ?(1\.5|3(\.5)?|XL)\b|Flux|LoRA|ControlNet|Midjourney|即梦|可图|通义万相|Qwen-?Image|Seedream|Nano ?Banana|GPT-?Image|文生图|图生图|AI ?(绘画|绘图|画图|生图|出图|作画))/i;
const IMG_WEAK = /(绘画|绘图|出图|生图|海报|工作流|修图|扩图|抠图|换装|商品图|模特图|头像|插画|插图)/;
const IMG_BILI_POOL = [
  'ComfyUI 工作流', 'AI绘画 教程', 'Flux 教程', 'LoRA 训练 教程',
  'Qwen-Image 教程', '即梦 AI 教程', 'Stable Diffusion 教程', 'AI 生图 工作流',
];

function civitaiRow(m) {
  const v = (m.modelVersions || [])[0] || {};
  const cu = m.allowCommercialUse;
  const uses = Array.isArray(cu) ? cu : String(cu || '').replace(/[{}]/g, '').split(',');
  return {
    name: clip(m.name || '', 120),
    url: `https://civitai.com/models/${m.id}`,
    type: m.type || '',
    base: v.baseModel || '',
    downloads: Number(m.stats?.downloadCount) || 0,
    likes: Number(m.stats?.thumbsUpCount) || 0,
    published: (v.publishedAt || '').slice(0, 10),
    creator: m.creator?.username || '',
    tags: (m.tags || []).slice(0, 5),
    commercial: uses.some((u) => /image|sell/i.test(u)),
  };
}

async function collectImageGen() {
  const out = { models: [], api_models: [], workflows: [], community: [], projects: [], videos: [], scanned: {} };

  // 1) Hugging Face 热度榜：huggingface.co 时通时不通，连不上就走 hf-mirror
  out.models = (await trySource('img:hf', async () => {
    const seen = new Map();
    for (const [task, label] of IMG_HF_TASKS) {
      let rows = null;
      for (const host of ['https://huggingface.co', 'https://hf-mirror.com']) {
        try {
          rows = await fetchJsonWall(`${host}/api/models?pipeline_tag=${task}&sort=trendingScore&limit=20`, { timeout: 20000, tries: 1 });
          break;
        } catch { /* 换下一个 */ }
      }
      if (!rows) throw new Error('HF 与 hf-mirror 都没连上');
      for (const m of rows) {
        const tags = m.tags || [];
        if (seen.has(m.id) || tags.includes('not-for-all-audiences') || IMG_ADULT.test(m.id)) continue;
        const base = tags.find((t) => /^base_model:[^:]+\/[^:]+$/.test(t));
        seen.set(m.id, {
          name: m.id,
          url: `https://huggingface.co/${m.id}`,
          task: label,
          likes: m.likes || 0,
          downloads: m.downloads || 0,
          trending: m.trendingScore || 0,
          created: (m.createdAt || '').slice(0, 10),
          license: (tags.find((t) => t.startsWith('license:')) || '').slice(8),
          base: base ? base.slice(11) : '',
          lib: m.library_name || '',
        });
      }
    }
    return [...seen.values()].sort((a, b) => b.trending - a.trending).slice(0, 20);
  })) || [];

  // 2) API 就能出图的模型（OpenRouter 输出带 image 的），按上架时间倒序
  out.api_models = (await trySource('img:openrouter', async () => {
    const j = await fetchJson('https://openrouter.ai/api/v1/models?output_modalities=image', { timeout: 30000 });
    return (j.data || [])
      .filter((m) => /->.*image/.test(m.architecture?.modality || ''))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, 14)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        url: `https://openrouter.ai/${m.id}`,
        created: m.created ? isoDate(new Date(m.created * 1000)) : '',
        modality: m.architecture?.modality || '',
        image_price: m.pricing?.image_output ? +(Number(m.pricing.image_output) * 1e6).toFixed(2) : null,
      }));
  })) || [];

  // 3) Civitai：本周下载最多的工作流，和 Checkpoint / LoRA
  const civitai = async (types, limit) => {
    const q = types.map((t) => `types=${t}`).join('&');
    const j = await fetchJsonWall(`https://civitai.com/api/v1/models?limit=${limit}&sort=Most%20Downloaded&period=Week&nsfw=false&${q}`, { timeout: 40000 });
    const items = j.items || [];
    return { scanned: items.length, rows: items.filter(civitaiSafe).slice(0, 12).map(civitaiRow) };
  };
  const wf = await trySource('img:civitai-workflows', () => civitai(['Workflows'], 60));
  if (wf) { out.workflows = wf.rows; out.scanned.workflows = wf.scanned; }
  const cm = await trySource('img:civitai-models', () => civitai(['Checkpoint', 'LORA'], 100));
  if (cm) { out.community = cm.rows; out.scanned.community = cm.scanned; }

  // 4) GitHub：近 30 天的生图项目 + 最近一周还在更新的 ComfyUI 节点（和主采集错开，别撞搜索限流）
  out.projects = (await trySource('img:github', async () => {
    await sleep(12000);
    const fresh = await githubSearch(
      `comfyui OR text-to-image OR "image generation" OR "stable diffusion" OR "image editing" in:name,description,topics created:>${daysAgo(30)} stars:>20`,
      { perPage: 20 },
    );
    await sleep(2500);
    const nodes = await githubSearch(`comfyui in:name,topics pushed:>${daysAgo(7)} created:>${daysAgo(90)} stars:>15`, { perPage: 20 });
    const byName = new Map();
    for (const r of nodes) byName.set(r.full_name, { ...r, group: 'ComfyUI 节点' });
    for (const r of fresh) if (!byName.has(r.full_name)) byName.set(r.full_name, { ...r, group: /comfy/i.test(r.full_name) ? 'ComfyUI 节点' : '生图项目' });
    return [...byName.values()].sort((a, b) => b.stars_per_day_since_birth - a.stars_per_day_since_birth).slice(0, 18);
  })) || [];

  // 5) B站中文教程：每天换三个词，各搜「综合」和「最新」两页（综合排序多是老片），
  //    只留 30 天内、播放过 800、确实在讲生图的
  out.videos = (await trySource('img:bilibili', async () => {
    await sleep(14000);
    const cookie = await biliCookie();
    const seed = Number(DATE.replace(/-/g, '').slice(-6)) || 1;
    const kws = [0, 1, 2].map((i) => IMG_BILI_POOL[(seed + i * 3) % IMG_BILI_POOL.length]);
    const found = new Map();
    for (const kw of kws) for (const order of ['', '&order=pubdate']) {
      await sleep(1800);
      let rows = [];
      try {
        const j = await fetchJson(
          `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1${order}&keyword=${encodeURIComponent(kw)}`,
          { headers: { ...BILI_HEAD, cookie, referer: 'https://search.bilibili.com/' } },
        );
        rows = j?.data?.result || [];
      } catch { continue; }
      for (const v of rows) {
        const title = clip(stripTags(String(v.title || '').replace(/<\/?em[^>]*>/g, '')), 130);
        const days = v.pubdate ? (TAH - v.pubdate * 1000) / 86400000 : 999;
        if (!v.bvid || found.has(v.bvid) || days > 30 || Number(v.play) < 800) continue;
        if (BILI_NOISE.test(title) || IMG_ADULT.test(title)) continue;
        if (!IMG_STRONG.test(title) && !(IMG_WEAK.test(title) && AI_TIGHT.test(title))) continue;
        found.set(v.bvid, {
          title,
          author: v.author || '',
          url: `https://www.bilibili.com/video/${v.bvid}`,
          play: Number(v.play) || 0,
          date: v.pubdate ? isoDate(new Date(v.pubdate * 1000)) : '',
          why: `搜「${kw}」`,
        });
      }
    }
    return [...found.values()].sort((a, b) => b.play - a.play).slice(0, 14);
  })) || [];

  const total = Object.entries(out).filter(([k]) => k !== 'scanned').reduce((n, [, v]) => n + v.length, 0);
  return { ...out, total };
}

const TRACK_WORDS =/(windows|win32|win64|\.exe|installer|winget|portable|plugin|插件|batch|批量|gui|\bexe\b|api|sdk|支持|新增)/i;

async function ghJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json', ...(GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.limited = res.status === 403 || res.status === 429;
    throw e;
  }
  return res.json();
}

// 只读 state/tracker.json（由应用写入），每天顺手查一次；变化和昨天的 pack.tracked 比。
async function collectTracked(prev) {
  const f = path.join(DIR.state, 'tracker.json');
  if (!existsSync(f)) return null;
  let t = null;
  try { t = JSON.parse(await readFile(f, 'utf8')); } catch { return null; }
  const list = Array.isArray(t && t.items) ? t.items : [];
  if (!list.length) return null;

  const prevItems = (prev && prev.tracked && Array.isArray(prev.tracked.items)) ? prev.tracked.items : [];
  const items = [];
  const changes = {};
  let checked = 0;

  for (const it of list.slice(0, 30)) {
    const url = String(it.url || '');
    const m = url.match(/github\.com\/([^/#?]+\/[^/#?]+)/i);
    const repo = it.repo || (m ? m[1].replace(/\.git$/, '') : '');
    if (!repo) continue;
    let info = null;
    try {
      info = await ghJson(`https://api.github.com/repos/${repo}`);
    } catch (e) {
      items.push({ name: it.name || repo, url: url || `https://github.com/${repo}`, snap: null, error: String(e.message || e) });
      await sleep(900);
      continue;
    }
    checked++;
    let tag = '';
    let published = '';
    try {
      const rel = await ghJson(`https://api.github.com/repos/${repo}/releases/latest`);
      tag = rel.tag_name || '';
      published = String(rel.published_at || '').slice(0, 10);
    } catch {
      tag = '';
    }
    const snap = {
      tag,
      published,
      archived: !!info.archived,
      stars: info.stargazers_count || 0,
      pushed: String(info.pushed_at || '').slice(0, 10),
      checkedAt: DATE,
    };
    items.push({ name: it.name || info.full_name || repo, url: url || info.html_url, snap });

    const old = prevItems.find((x) => (x.url && x.url === url) || (x.snap && x.name === it.name));
    const oldSnap = (old && old.snap) || (it.snap && it.snap.checkedAt ? it.snap : null);
    const list2 = [];
    if (oldSnap) {
      if (snap.tag && oldSnap.tag !== snap.tag) list2.push(`出了新版本 ${oldSnap.tag || '（无）'} → ${snap.tag}`);
      if (snap.archived && !oldSnap.archived) list2.push('已归档：作者不再维护了');
      if (!snap.archived && oldSnap.archived) list2.push('恢复维护了');
      const gained = (snap.stars || 0) - (oldSnap.stars || 0);
      if (gained >= 50 || (gained >= 20 && gained / Math.max(1, oldSnap.stars) >= 0.1)) list2.push(`星标 +${gained}`);
      const oldDesc = String(oldSnap.desc || '');
      const newDesc = String(info.description || '');
      if (newDesc && newDesc !== oldDesc && TRACK_WORDS.test(newDesc) && !TRACK_WORDS.test(oldDesc)) list2.push('简介里新增了可能相关的关键词（平台/插件/批量之类）');
    }
    if (!oldSnap && tag) list2.push(`当前最新版本 ${tag}`);
    changes[url || `https://github.com/${repo}`] = { tag, published, changes: list2, checkedAt: DATE };
    snap.desc = String(info.description || '').slice(0, 300);
    await sleep(900);
  }

  status.tracked = 'ok';
  return { checkedAt: DATE, checked, items, changes, source_url: 'https://github.com' };
}

function fmtCount(n) {
  const v = Number(n) || 0;
  return v >= 1e8 ? (v / 1e8).toFixed(1) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : String(v);
}

function renderBrief(pack) {
  const L = [];
  const P = (...xs) => L.push(...xs);

  P(`# 采集简报 ${pack.date}`, '');
  P(`生成时间 ${pack.generated_at}`);
  P(`源状态：${Object.entries(pack.status).map(([k, v]) => `${k}=${v}`).join('，')}`, '');

  P('## A. GitHub 近 7 天新项目（按总星排序，含日均星速）', '');
  pack.github.new_repos.forEach((r, i) => {
    P(`${i + 1}. ${r.full_name} ⭐${r.stars} (+${r.stars_per_day_since_birth}/天, ${r.created_days_ago}天前建) [${r.lang || '-'}] ${r.topics.slice(0, 4).join(',')}`);
    P(`   ${r.desc}`);
    P(`   ${r.url}`);
  });
  P('');

  if (pack.github.velocity?.length) {
    P('## B. 24h 星标增速榜（与昨日基线对比，最强「此刻正在火」信号）', '');
    pack.github.velocity.slice(0, 15).forEach((r, i) =>
      P(`${i + 1}. ${r.full_name} ⭐${r.stars} → 24h 约 +${r.gain_24h}｜${r.desc}`));
    P('');
  } else {
    P('## B. 24h 星标增速榜', '', '（首日无基线，明日开始有增量；今日先看 A/D 的日均星速）', '');
  }

  P('## C. 高星活跃项目（2 天内仍在提交，stars>4000）', '');
  pack.github.active.slice(0, 15).forEach((r, i) =>
    P(`${i + 1}. ${r.full_name} ⭐${r.stars} 更新${r.pushed_days_ago === 0 ? '今天' : r.pushed_days_ago + '天前'}｜${clip(r.desc, 110)}`));
  P('');

  P('## D. 近 30 天 AI 方向新项目（stars>25，题材相关）', '');
  (pack.github.ai_new || []).slice(0, 18).forEach((r, i) =>
    P(`${i + 1}. ${r.full_name} ⭐${r.stars}（${r.created_days_ago}天）｜${clip(r.desc, 120)}`));
  P('');

  P('## E. 模型侧：OpenRouter 近 21 天新上架模型（按上架时间倒序）', '');
  pack.models.openrouter_new.slice(0, 30).forEach((m) =>
    P(`- ${m.created} ${m.id}｜ctx ${m.context || '?'}｜prompt $${m.prompt_price ?? '?'} / completion $${m.completion_price ?? '?'} per Mtok`));
  P('');

  if (pack.models.ollama_new.length) {
    P('## F. Ollama 新版本地模型', '');
    pack.models.ollama_new.slice(0, 20).forEach((m) =>
      P(`- ${m.name}${m.updated ? '（' + m.updated + '更新）' : ''}${m.caps.length ? '｜' + m.caps.join(',') : ''}\n  ${m.desc || ''}`));
    P('');
  }

  P('## G. 新闻/博客（近 10 天）', '');
  pack.news.forEach((n) => P(`- [${n.source}] ${n.date ? n.date + ' ' : ''}${n.title}\n  ${n.link}`));
  P('');

  P('## H. arXiv 最新（关键词命中，取 14 条）', '');
  pack.papers.forEach((p) => P(`- ${p.date} ${p.title}\n  ${p.link}\n  ${clip(p.summary, 200)}`));
  P('');

  P('## I. Hacker News 前排（AI 相关）', '');
  pack.hn.forEach((h) => P(`- ${h.points}pts/${h.comments}c ${h.title}\n  ${h.url}`));
  P('');

  P('## J. 去重状态：本次首次出现的项目', '');
  P((pack.first_seen || []).slice(0, 25).join(', ') || '（无）');
  P('');

  const sk = pack.github.skills || [];
  if (sk.length) {
    P('## K. 技能（skill），按作用的 agent 分组', '');
    for (const g of groupSkills(sk)) {
      P(`### ${g.label}（${g.items.length} 个）— ${g.note}`, '');
      g.items.slice(0, 8).forEach((r) =>
        P(`- ${r.full_name} ⭐${r.stars}｜${clip(r.desc, 110)}`));
      P('');
    }
  }

  const sh = pack.skills_sh || {};
  const shItems = sh.items || [];
  if (shItems.length) {
    const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
    P('## L. skills.sh 技能市场（跨 agent，按安装量；这里是最能反映"真的有人在用"的信号）', '');
    P(`共 ${sh.total} 个技能 / ${sh.sources} 个来源 / 官方 ${sh.official} 个` +
      (sh.carried_over ? `（沿用 ${pack.date} 之前的数据）` : '') +
      (sh.has_baseline ? '' : '（今日首次建基线，明日才有 24h 安装增量）'), '');

    // 24h 增量优先，没有基线就按周增
    const byDay = shItems.filter((s) => typeof s.install_24h === 'number')
      .sort((a, b) => b.install_24h - a.install_24h).slice(0, 12);
    if (byDay.length) {
      P('### 24h 安装增量最快（新基线，和昨日快照比）', '');
      byDay.forEach((s, i) => P(
        `${i + 1}. ${s.name}（${s.source}）24h +${fmt(s.install_24h)}｜总 ${fmt(s.installs)}｜周增 ${fmt(s.week_delta || 0)}` +
        `${s.official ? '｜官方' : ''}\n   ${s.cmd}\n   ${s.url}`));
      P('');
    }

    // 同一个来源的技能常常成套安装（一个 bundle 占满榜单前几名，数字几乎一样），
    // 所以每个来源最多留 2 条，让榜单反映"不同的东西"而不是"同一拨人刷的量"。
    const spread = (arr, n) => {
      const seen = new Map();
      const out = [];
      for (const s of arr) {
        const k = s.source;
        const c = seen.get(k) || 0;
        if (c >= 2) continue;
        seen.set(k, c + 1);
        out.push(s);
        if (out.length >= n) break;
      }
      return out;
    };

    const byWeek = spread(shItems.filter((s) => (s.week_delta || 0) > 0)
      .sort((a, b) => (b.week_delta || 0) - (a.week_delta || 0)), 12);
    P('### 本周安装增量 Top（每个来源最多 2 条）', '');
    byWeek.forEach((s, i) => P(
      `${i + 1}. ${s.name}（${s.source}）周 +${fmt(s.week_delta || 0)}｜总 ${fmt(s.installs)}${s.official ? '｜官方' : ''}\n   ${s.url}`));
    P('');

    const byTotal = spread(shItems, 8);
    P('### 累计安装最多（稳态热门，适合先抄作业）', '');
    byTotal.forEach((s, i) => P(
      `${i + 1}. ${s.name}（${s.source}）${fmt(s.installs)}${s.official ? '｜官方' : ''}\n   ${s.cmd}`));
    P('');
  }

  const bi = pack.bilibili || {};
  const biItems = bi.items || [];
  P('## M. B站（普通人在看什么 AI 视频）', '');
  if (biItems.length) {
    P(`扫了 ${bi.scanned || 0} 条，AI 相关 ${biItems.length} 条` + (bi.carried_over ? `（沿用之前的）` : '') +
      '｜播放量是"路人也点进来看了"的信号，和 GitHub 星星不是一回事', '');
    biItems.forEach((v, i) => P(
      `${i + 1}. ${v.title}\n   ${v.author}｜${fmtCount(v.play)}播放｜${v.date || ''}｜${v.why}\n   ${v.url}`));
  } else {
    P(bi.carried_over ? `（今天 B站 没抓到，沿用 ${pack.date} 之前的）` : '（今天 B站 热门与搜索里没有命中 AI 紧关键词的条目）', '');
  }
  P('');

  const zh = pack.zhihu || {};
  const zhItems = zh.items || [];
  P('## N. 知乎热榜（在吵什么）', '');
  if (zhItems.length) {
    P(`热榜 ${zh.scanned || 0} 条里 AI 相关 ${zhItems.length} 条` +
      '｜这类多是"普通人怎么想 AI"，不是技术事实，适合当情绪与需求信号', '');
    zhItems.forEach((z, i) => P(`${i + 1}. ${z.title}\n   ${z.heat || ''}\n   ${z.url}`));
  } else {
    P(zh.carried_over ? `（今天知乎没抓到，沿用 ${pack.date} 之前的）` : '（今天知乎热榜里没有 AI 相关的）', '');
  }
  P('');

  const wb = pack.web || {};
  const wbItems = wb.items || [];
  P('## O. 联网搜索（RSS 覆盖不到的那部分：中文实测、二手转述、镜像站）', '');
  if (wbItems.length) {
    P(
      `搜了「${(wb.queries || []).join('」「')}」，留 ${wbItems.length} 条（Bing RSS，按相关度不按时间）` +
        '｜这是"别人怎么看"，不是官方口径，引用必须带链接',
      '',
    );
    wbItems.forEach((w, i) =>
      P(`${i + 1}. ${w.title}\n   ${clip(w.desc || '', 180)}\n   ${w.url}`),
    );
  } else {
    P(wb.carried_over ? '（今天联网搜索没抓到，沿用前一天的）' : '（今天联网搜索没抓到可用结果）', '');
  }
  P('');

  const fr = pack.frontier || {};
  const frItems = fr.items || [];
  if (frItems.length) {
    P('## P. 前沿动态（AI 又能做什么了；状态＝到哪一步了）', '');
    P(
      `源 HF Daily Papers（经 hf-mirror 镜像）｜扫了 ${fr.scanned || frItems.length} 条` +
        '｜热度是"多少人点了收藏"，不等于效果；有代码/演示的才加权',
      '',
    );
    P('### P1. 今天值得知道（最多 5 条）', '');
    (fr.today || []).forEach((x, i) =>
      P(
        `${i + 1}. [${x.status_label}] ${x.title}\n` +
          `   能做什么：${x.can_do}\n` +
          `   ${clip(x.ai_summary || x.summary || '', 220)}\n` +
          `   ${x.arxiv || x.hf}${x.repo ? '\n   代码 ' + x.repo : ''}${x.project ? '\n   演示 ' + x.project : ''}`,
      ),
    );
    P('');
    const wk = fr.week || [];
    P('### P2. 本周能力变化（更便宜了 / 更长了 / 本地能跑了）', '');
    if (wk.length) {
      wk.forEach((c, i) => P(`${i + 1}. [${c.what}] ${c.title}：${c.detail}\n   ${c.url}`));
    } else {
      P('（今天没比出变化；要有两天以上的模型快照才能看出降价与上下文变化）');
    }
    P('');
    P('### P3. 深入了解（论文 / 代码 / 演示 / 评测，按"能做到哪一步"排）', '');
    frItems.slice(0, 20).forEach((x, i) =>
      P(
        `${i + 1}. [${x.status_label}｜${x.upvotes || 0} 赞${x.stars ? '｜' + x.stars + ' 星' : ''}] ${x.title}\n` +
          `   ${clip(x.summary || '', 200)}\n` +
          `   ${x.hf || x.arxiv}`,
      ),
    );
    P('');
  }

  const ig = pack.imagegen || {};
  if (ig.total || (ig.models || []).length) {
    P('## R. AI 生图与工作流（模型 / 能出图的 API / 工作流 / 社区模型 / 开源项目 / 中文教程）', '');
    P('Civitai 只收 PG / PG-13 且不是真人肖像的条目；HF 热度是"多少人在点"，不等于出图质量', '');
    if ((ig.models || []).length) {
      P('### R1. 新模型（Hugging Face 热度榜）', '');
      ig.models.slice(0, 12).forEach((m, i) => P(
        `${i + 1}. ${m.name}｜${m.task}｜${m.likes} 赞 · ${fmtCount(m.downloads)} 下载｜${m.created} 建${m.license ? '｜' + m.license : ''}${m.base ? '｜基于 ' + m.base : ''}\n   ${m.url}`));
      P('');
    }
    if ((ig.api_models || []).length) {
      P('### R2. API 能直接出图的模型（OpenRouter，按上架时间）', '');
      ig.api_models.slice(0, 10).forEach((m) => P(
        `- ${m.created} ${m.id}｜${m.modality}${m.image_price != null ? '｜出图 $' + m.image_price + ' / M 图像 token' : ''}`));
      P('');
    }
    if ((ig.workflows || []).length) {
      P('### R3. 工作流（Civitai 本周下载最多；数字是累计）', '');
      ig.workflows.forEach((w, i) => P(
        `${i + 1}. ${w.name}｜${w.base || '?'}｜${fmtCount(w.downloads)} 下载 · ${w.likes} 赞｜${w.published}${w.commercial ? '｜可商用' : ''}\n   ${w.url}`));
      P('');
    }
    if ((ig.community || []).length) {
      P('### R4. 社区模型 / LoRA（Civitai 本周下载最多）', '');
      ig.community.forEach((w, i) => P(
        `${i + 1}. [${w.type}] ${w.name}｜${w.base || '?'}｜${fmtCount(w.downloads)} 下载｜${w.published}\n   ${w.url}`));
      P('');
    }
    if ((ig.projects || []).length) {
      P('### R5. 开源项目与 ComfyUI 节点（GitHub）', '');
      ig.projects.forEach((r, i) => P(
        `${i + 1}. [${r.group}] ${r.full_name} ⭐${r.stars}（${r.created_days_ago}天）｜${clip(r.desc, 110)}\n   ${r.url}`));
      P('');
    }
    if ((ig.videos || []).length) {
      P('### R6. 中文教程（B站，30 天内、播放过 800）', '');
      ig.videos.forEach((v, i) => P(`${i + 1}. ${v.title}\n   ${v.author}｜${fmtCount(v.play)}播放｜${v.date}\n   ${v.url}`));
      P('');
    }
  }

  const tr = pack.tracked;
  if (tr && (tr.items || []).length) {
    const ch = tr.changes || {};
    const moved = Object.entries(ch).filter(([, v]) => (v.changes || []).length);
    P('## Q. 追踪变化（你点名要盯的东西）', '');
    P(
      `已查 ${tr.checked || (tr.items || []).length} 个｜核实 ${tr.checkedAt || pack.date}` +
        `｜只列有意义的变化：出了能用的版本、加了平台/功能、归档、恢复维护、星标跳涨`,
      '',
    );
    if (!moved.length) P('今天这些都没有变化。没有变化就不该占用你的注意力。', '');
    moved.forEach(([url, v]) => {
      const it = (tr.items || []).find((x) => x.url === url) || {};
      P(`- ${it.name || url}（${v.tag || '无版本'}${v.published ? '｜' + v.published : ''}）\n   ${v.changes.join('；')}\n   ${url}`);
    });
    P('');
  }

  return L.join('\n');
}

async function main() {
  await mkdir(DIR.data, { recursive: true });
  await mkdir(DIR.inbox, { recursive: true });
  await mkdir(DIR.state, { recursive: true });

  console.log(`[radar] collecting ${DATE} ...`);

  // 进度：每完成一步打一行「[radar] step 已完成/总数 名称」，应用里的进度条按它走
  const STEPS = 13;
  let stepsDone = 0;
  const step = (label, p) => Promise.resolve(p).then((v) => {
    stepsDone += 1;
    console.log(`[radar] step ${stepsDone}/${STEPS} ${label}`);
    return v;
  });

  const [ghSrc, models, news, papers, hn, skillsSh, bilibili, zhihu, imagegen] = await Promise.all([
    step('GitHub', trySource('github', collectGitHub).then((v) => v || { new_repos: [], active: [], ai_new: [], skills_raw: [] })),
    step('模型', collectModels()),
    step('新闻', collectNews()),
    step('论文', collectPapers()),
    step('Hacker News', collectHN()),
    step('skills.sh', trySource('skills.sh', collectSkillsSh)),
    step('B站', collectBilibili()),
    step('知乎', collectZhihu()),
    step('AI 生图', collectImageGen()),
  ]);
  // 联网搜索要用当天的模型名当查询词，所以放在模型结果之后串行跑（约 4 秒）
  const web = await step('联网搜索', collectWeb(models));
  // 前沿动态：HF 论文 + 模型价格/上下文变化（要和模型结果对齐，也放串行）
  const frontier = await step('前沿动态', collectFrontier(models));
  let gh = ghSrc;

  // 某个源今天挂了，不要把昨天的条目一起清空：沿用上一份数据，并在 status 里留痕。
  const prev = await loadPrevPack();
  if (!papers.length && prev?.papers?.length) {
    papers.push(...prev.papers.map((p) => ({ ...p, carried_over: true })));
    status.papers = `${status.papers || 'empty'}（沿用 ${prev.date} 的 ${papers.length} 条）`;
  }
  if (!news.length && prev?.news?.length) {
    news.push(...prev.news.map((n) => ({ ...n, carried_over: true })));
    status.news = `${status.news || 'empty'}（沿用 ${prev.date} 的 ${news.length} 条）`;
  }
  if (!hn.length && prev?.hn?.length) {
    hn.push(...prev.hn.map((h) => ({ ...h, carried_over: true })));
    status.hn = `${status.hn || 'empty'}（沿用 ${prev.date} 的 ${hn.length} 条）`;
  }
  // GitHub 搜索被限流（403）时整类会变空：沿用上一份，别让雷达整天空着
  if (!(gh.new_repos || []).length && prev?.github?.new_repos?.length) {
    gh = {
      ...gh,
      new_repos: prev.github.new_repos.map((r) => ({ ...r, carried_over: true })),
      active: prev.github.active || [],
      ai_new: prev.github.ai_new || [],
      skills_raw: prev.github.skills_raw || [],
    };
    status.github = `${status.github || 'empty'}（沿用 ${prev.date} 的 ${gh.new_repos.length} 条）`;
  }

  // B站 / 知乎：源挂了也别让「社区」那块整个空掉
  const biliSrc = bilibili || (prev?.bilibili ? { ...prev.bilibili, carried_over: true } : { total: 0, items: [] });
  const zhihuSrc = zhihu || (prev?.zhihu ? { ...prev.zhihu, carried_over: true } : { total: 0, items: [] });
  const webSrc = web || (prev?.web ? { ...prev.web, carried_over: true } : { total: 0, items: [], queries: [] });
  // 生图：哪一类今天没抓到，就沿用上一份的那一类
  const imageSrc = { ...imagegen };
  for (const k of ['models', 'api_models', 'workflows', 'community', 'projects', 'videos']) {
    if (!(imageSrc[k] || []).length && prev?.imagegen?.[k]?.length) {
      imageSrc[k] = prev.imagegen[k].map((x) => ({ ...x, carried_over: true }));
      imageSrc.carried_over = [...(imageSrc.carried_over || []), k];
    }
  }
  const frontierSrc = frontier || (prev?.frontier ? { ...prev.frontier, carried_over: true } : { total: 0, today: [], week: [], items: [] });

  const tracked = await step('追踪名单', collectTracked(prev));
  const trackedSrc = tracked || (prev?.tracked ? { ...prev.tracked, carried_over: true } : null);

  const pool = [...(gh.new_repos || []), ...(gh.active || []), ...(gh.ai_new || [])];
  const { velocity, next } = await step('星标增速', computeVelocity(pool));

  // 技能：从今天抓到的全部仓库里识别，再按作用对象归类
  const skills = pickSkills([...pool, ...(gh.skills_raw || [])]);

  const seen = await loadSeen();
  const firstSeen = [];
  for (const r of pool) {
    if (!seen[r.full_name]) { seen[r.full_name] = DATE; firstSeen.push(r.full_name); }
  }
  const cutoff = daysAgo(60);
  for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];

  const pack = {
    date: DATE,
    generated_at: new Date().toISOString(),
    status,
    github: { new_repos: gh.new_repos || [], active: gh.active || [], ai_new: gh.ai_new || [], velocity, skills },
    skills_sh: skillsSh || (prev?.skills_sh ? { ...prev.skills_sh, carried_over: true } : { total: 0, items: [] }),
    models,
    news,
    papers,
    hn,
    bilibili: biliSrc,
    zhihu: zhihuSrc,
    web: webSrc,
    frontier: frontierSrc,
    imagegen: imageSrc,
    first_seen: firstSeen,
    tracked: trackedSrc,
  };

  const jsonPath = path.join(DIR.data, `${DATE}.json`);
  await writeFile(jsonPath, JSON.stringify(pack), 'utf8');
  await writeFile(path.join(DIR.state, 'stars.json'), JSON.stringify(next), 'utf8');
  await writeFile(path.join(DIR.state, 'seen.json'), JSON.stringify(seen), 'utf8');

  const brief = renderBrief(pack);
  await writeFile(path.join(DIR.inbox, `${DATE}.md`), brief, 'utf8');
  await writeFile(path.join(DIR.inbox, 'latest.md'), brief, 'utf8');

  const counts = {
    new_repos: pack.github.new_repos.length,
    active: pack.github.active.length,
    ai_new: pack.github.ai_new.length,
    skills: skills.length,
    skills_sh: (pack.skills_sh.items || []).length,
    velocity: velocity.length,
    openrouter: pack.models.openrouter_new.length,
    ollama: pack.models.ollama_new.length,
    news: pack.news.length,
    papers: pack.papers.length,
    hn: pack.hn.length,
    bilibili: (biliSrc.items || []).length,
    zhihu: (zhihuSrc.items || []).length,
    web: (webSrc.items || []).length,
    frontier: (frontierSrc.items || []).length,
    imagegen: ['models', 'api_models', 'workflows', 'community', 'projects', 'videos'].reduce((n, k) => n + (imageSrc[k] || []).length, 0),
    tracked: trackedSrc ? (trackedSrc.items || []).length : 0,
  };
  console.log('[radar] done →', jsonPath);
  console.log('[radar] counts', JSON.stringify(counts));
  const fails = Object.entries(status).filter(([, v]) => v !== 'ok');
  if (fails.length) console.log('[radar] failed sources:', fails.map(([k, v]) => `${k}(${v})`).join(' '));
}

main().catch((e) => {
  console.error('[radar] fatal:', e);
  process.exit(1);
});
