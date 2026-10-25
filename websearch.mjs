#!/usr/bin/env node
/**
 * 联网搜索（零依赖）
 *
 * 采集器和桌面应用共用这一份：
 *  - collect.mjs 每天补两三条「RSS 覆盖不到」的搜索结果；
 *  - app/main.js 在对话时按需搜一次，把结果当材料喂给模型。
 *
 * 为什么是 Bing RSS：DuckDuckGo、Brave、Google 在本机都连不上；
 * cn.bing.com 的 `&format=rss` 给的是标准 RSS（10 条，带 title/link/description/pubDate），
 * 不用解析 HTML，也不会因为页面改版整块失效。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function decode(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
function strip(s = '') {
  return decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function clip(s = '', n = 240) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Bing 的 RSS 里混着它自己的搜索页和跳转链接，这些都不是内容 */
function isNoise(url = '') {
  return /(^https?:\/\/(www\.)?bing\.com\/|go\.microsoft\.com|\/search\?q=)/i.test(url);
}

function cleanUrl(url = '') {
  try {
    const u = new URL(url);
    // 去掉 utm_* 之类的跟踪参数，链接短一点、去重也更准
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** 已知会出「文章」的站点：有它们通常意味着有内容，而不是个产品首页 */
const ARTICLE_HOST =
  /(csdn\.net|cnblogs\.com|juejin\.cn|segmentfault\.com|sohu\.com|36kr\.com|ifanr\.com|qbitai\.com|jiqizhixin\.com|sspai\.com|huxiu\.com|infoq\.cn|leiphone\.com|pingwest\.com|techcrunch\.com|theverge\.com|arstechnica\.com|venturebeat\.com|marktechpost\.com|simonwillison\.net|towardsdatascience\.com|medium\.com|substack\.com|huggingface\.co\/blog|github\.blog|openai\.com\/index|news\.)/i;
const ARTICLE_PATH = /(\/article|\/p\/|\/a\/|\/news|\/blog|\/post|\/stories|\/archives|\.html?$|\.shtml$)/i;
const JUNK_PATH = /(\/(signin|login|download|pricing|account|dashboard|console)\b)/i;

/**
 * Bing 的 RSS 顺序基本是「官网优先」，直接当新闻用会全是产品首页。
 * 这里按「像不像一篇文章」重排，再丢掉肯定没有信息的条目。
 */
export function rankResults(rows) {
  const scored = rows.map((r, i) => {
    let score = 0;
    let path = '';
    let host = '';
    try {
      const u = new URL(r.url);
      host = u.hostname.replace(/^www\./, '');
      path = u.pathname;
    } catch {
      /* 解析不了就按低分处理 */
    }
    if (ARTICLE_HOST.test(r.url)) score += 3;
    if (ARTICLE_PATH.test(path)) score += 2;
    if (JUNK_PATH.test(path)) score -= 5;
    if (/^\/(index|zh)?\/*$/i.test(path)) score -= 4;
    if (/\/(docs?|support|platform)\b/i.test(path)) score -= 2;
    if (/(发布|上线|更新|开源|实测|上手|解读|评测|release[sd]?)/i.test(r.title)) score += 2;
    return { ...r, host, score, i };
  });
  return scored
    .filter((r) => r.score >= 1)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ score, i, ...r }) => r);
}

export function parseRss(xml) {
  const out = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1] : '';
    };
    const title = strip(pick('title'));
    const url = cleanUrl(strip(pick('link')));
    if (!title || !url || isNoise(url)) continue;
    out.push({
      title: clip(title, 160),
      url,
      desc: clip(strip(pick('description')), 260),
      date: strip(pick('pubDate')),
    });
  }
  const seen = new Set();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

/**
 * 搜一次，返回 [{title,url,desc,date,query}]
 * @param {string} query
 * @param {{count?:number, timeout?:number, market?:string}} opts
 */
export async function searchWeb(query, { count = 8, timeout = 20000, market = 'zh-CN' } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=${Math.max(3, count)}&mkt=${market}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return rankResults(parseRss(xml))
    .slice(0, count)
    .map((r) => ({ ...r, query: q }));
}

/** 按顺序搜多个词，任何一个失败都不影响其他（返回成功的那部分） */
export async function searchMany(queries, { perQuery = 6, timeout = 20000 } = {}) {
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const rows = await searchWeb(q, { count: perQuery, timeout });
      for (const r of rows) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
      }
    } catch {
      /* 单个词失败就跳过，别让整块空掉 */
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  return out;
}
