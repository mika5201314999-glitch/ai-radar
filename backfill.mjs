#!/usr/bin/env node
/**
 * AI Radar — 历史回填（零依赖，Node >= 20）
 *
 * 每日采集器只看「最近 7 / 30 天」，所以雷达的「近三个月」「有史以来」里
 * 只有你装完应用之后那几天的快照。这个脚本补一份**档案**：
 * 把最近 N 个自然月（默认 3）里创建的仓库、上架的模型一次性抓下来，
 * 存进 data/archive.json，让时间范围筛选真的能往回看。
 *
 * 它不是每日任务：一周跑一次足够（新仓库的 stars 会慢慢涨，
 * 但「哪个月创建」这个事实不会变）。想手动更新就点应用里的「更新档案」，
 * 或者命令行 node backfill.mjs。
 *
 * 输出：data/archive.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = { data: path.join(ROOT, 'data') };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const MONTHS = Number(process.env.RADAR_ARCHIVE_MONTHS || 3);
const NOW = new Date();
const status = {};

/* ---------------------------------------------------------------- utils */

const isoDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function monthsBack(n) {
  const d = new Date(NOW.getTime());
  d.setMonth(d.getMonth() - n);
  return d;
}

async function getJSON(url, headers = {}, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
      if (res.status === 403 || res.status === 429) {
        const left = res.headers.get('x-ratelimit-remaining');
        throw new Error(`rate limited (remaining ${left})`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(4000);
    }
  }
}

/* ------------------------------------------------------------- 归一化 */

function normRepo(r, today) {
  const created = new Date(r.created_at);
  const pushed = new Date(r.pushed_at || r.created_at);
  const ageDays = Math.max(daysBetween(created, today), 1);
  return {
    full_name: r.full_name,
    url: r.html_url,
    desc: r.description || '',
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    lang: r.language || '',
    topics: r.topics || [],
    created: isoDate(created),
    pushed: isoDate(pushed),
    stars_per_day_since_birth: Math.round(((r.stargazers_count || 0) / ageDays) * 10) / 10,
    created_days_ago: daysBetween(created, today),
    pushed_days_ago: daysBetween(pushed, today),
  };
}

/* ---------------------------------------------------------------- 抓取 */

async function githubSearch(q, pages, tag) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}`
      + `&sort=stars&order=desc&per_page=100&page=${page}`;
    try {
      const j = await getJSON(url, GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {});
      const items = j.items || [];
      out.push(...items);
      if (items.length < 100) break;
    } catch (e) {
      status[tag] = `fail(${e.message})`;
      break;
    }
    await sleep(2600);
  }
  if (!status[tag]) status[tag] = 'ok';
  return out;
}

async function openrouter() {
  try {
    const j = await getJSON('https://openrouter.ai/api/v1/models');
    const since = monthsBack(MONTHS);
    status.openrouter = 'ok';
    return (j.data || [])
      .map((m) => ({
        id: m.id,
        name: m.name,
        created: m.created ? isoDate(new Date(m.created * 1000)) : '',
        created_ts: m.created || 0,
        context: m.context_length || 0,
        prompt_price: Number(m.pricing?.prompt ?? 0) * 1e6,
        completion_price: Number(m.pricing?.completion ?? 0) * 1e6,
        modality: m.architecture?.modality || '',
      }))
      .filter((m) => m.created_ts && new Date(m.created_ts * 1000) >= since)
      .sort((a, b) => b.created_ts - a.created_ts);
  } catch (e) {
    status.openrouter = `fail(${e.message})`;
    return [];
  }
}

/* ------------------------------------------------------------------ 主 */

async function main() {
  const since = monthsBack(MONTHS);
  const sinceStr = isoDate(since);
  const today = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  console.log(`[archive] ${MONTHS} 个月：>= ${sinceStr}，到今天结束`);

  const plain = await githubSearch(`created:>=${sinceStr} stars:>60`, 4, 'github_general');
  const ai = await githubSearch(`created:>=${sinceStr} stars:>15 ai OR agent OR llm in:name,description`, 3, 'github_ai');
  const models = await openrouter();

  const seen = new Map();
  for (const r of plain) seen.set(r.full_name, normRepo(r, today));
  const repos = [...seen.values()].sort((a, b) => b.stars - a.stars);

  const seenAI = new Map();
  for (const r of ai) if (!seen.has(r.full_name)) seenAI.set(r.full_name, normRepo(r, today));
  const aiNew = [...seenAI.values()].sort((a, b) => b.stars - a.stars);

  const out = {
    generated_at: new Date().toISOString(),
    months: MONTHS,
    since: sinceStr,
    until: isoDate(today),
    counts: { repos: repos.length, ai: aiNew.length, models: models.length },
    status,
    github: { repos, ai: aiNew },
    models: { openrouter_new: models },
  };

  await mkdir(DIR.data, { recursive: true });
  const file = path.join(DIR.data, 'archive.json');
  // 合并旧档案里更早创建的条目，避免每次重跑把历史越跑越少
  try {
    const old = JSON.parse(await readFile(file, 'utf8'));
    const merge = (cur, prev) => {
      const m = new Map((prev || []).map((x) => [x.full_name || x.id, x]));
      for (const x of cur) m.set(x.full_name || x.id, x);
      return [...m.values()];
    };
    out.github.repos = merge(repos, old.github?.repos).sort((a, b) => b.stars - a.stars);
    out.github.ai = merge(aiNew, old.github?.ai).sort((a, b) => b.stars - a.stars);
    const mm = new Map((old.models?.openrouter_new || []).map((x) => [x.id, x]));
    for (const x of models) mm.set(x.id, x);
    out.models.openrouter_new = [...mm.values()].sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));
    out.counts = { repos: out.github.repos.length, ai: out.github.ai.length, models: out.models.openrouter_new.length };
    out.merged_prev = true;
  } catch { out.merged_prev = false; }

  await writeFile(file, JSON.stringify(out, null, 0), 'utf8');
  console.log(`[archive] 仓库 ${out.counts.repos} / AI 仓库 ${out.counts.ai} / 模型 ${out.counts.models}`);
  console.log(`[archive] 源状态 ${JSON.stringify(status)}`);
  console.log(`[archive] → ${file}`);
}

main().catch((e) => {
  console.error('[archive] 失败：', e.message);
  process.exit(1);
});
