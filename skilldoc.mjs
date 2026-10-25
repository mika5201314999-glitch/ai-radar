#!/usr/bin/env node
/**
 * 技能说明书：把「一个 skill」变成新人能看懂的五件事
 *   1 能帮我做什么（description + 例子）
 *   2 我能不能用（依赖 vs 本机环境）
 *   3 怎么开始（当前环境对应的步骤）
 *   4 装好了吗（真实路径检查 + 一句验证任务）
 *   5 不想用了（禁用 / 卸载 / 还原）
 *
 * 技能的形态是「说明 + 脚本 + 资源」三件套（Anthropic 的 SKILL.md 规范也是这样）：
 * 光把说明复制进聊天框，脚本和资源没落地，多数技能是跑不起来的。
 * 所以这里只给两条真路径：用命令行装到 agent 的技能目录，或者手动把整个目录放进去。
 *
 * 零依赖。文件清单走 jsDelivr 的 data API（不限流），
 * 正文走 jsDelivr CDN（cdn.jsdelivr.net 在本机已不可达，testingcf 可用），
 * 兜底走 GitHub contents API（未登录 60 次/小时，所以结果要缓存）。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const H = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' };
const CDN_HOSTS = ['testingcf.jsdelivr.net', 'gcore.jsdelivr.net', 'fastly.jsdelivr.net'];
const REFS = ['main', 'master'];

async function httpText(url, { timeout = 25000 } = {}) {
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.text();
}
async function httpJson(url, opts) {
  return JSON.parse(await httpText(url, opts));
}

/* --------------------------------------------------------------- 仓库文件 */

function flatten(node, prefix = '', out = []) {
  for (const f of node.files || []) {
    const p = prefix + '/' + f.name;
    if (f.type === 'directory') flatten(f, p, out);
    else out.push({ path: p, size: f.size || 0 });
  }
  return out;
}

/** 列出一个仓库的全部文件（含分支探测）。结果里的 ref 后面取正文还要用。 */
export async function listRepoFiles(source) {
  let lastErr = '';
  for (const ref of REFS) {
    try {
      const j = await httpJson(`https://data.jsdelivr.com/v1/packages/gh/${source}@${ref}`);
      const files = flatten(j);
      if (files.length) return { ok: true, source, ref, files };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastErr || 'jsDelivr 没有这个仓库的文件清单' };
}

/** 读仓库里的一个文件；先 CDN（main/master 都试），再 GitHub contents API */
export async function readRepoFile(source, filePath, ref = 'main') {
  const p = String(filePath || '').replace(/^\//, '');
  const refs = [...new Set([ref, 'main', 'master'].filter(Boolean))];
  for (const r of refs) {
    for (const host of CDN_HOSTS) {
      try {
        const txt = await httpText(`https://${host}/gh/${source}@${r}/${p}`);
        if (txt && txt.trim()) return { ok: true, text: txt, via: host, ref: r };
      } catch {
        /* 换下一个 */
      }
    }
  }
  try {
    const j = await httpJson(`https://api.github.com/repos/${source}/contents/${p}?ref=${ref}`);
    if (j && j.content) {
      const text = Buffer.from(j.content, j.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      if (text.trim()) return { ok: true, text, via: 'github-api' };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: false, error: '读不到这个文件' };
}

/* ------------------------------------------------------------ 解析与分析 */

export function parseFrontmatter(md = '') {
  const text = String(md);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    v = v.replace(/^["']|["']$/g, '').replace(/\\"/g, '"');
    if (/^\[.*\]$/.test(v)) v = v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh|ps1|rb|go|rs|java|kt)$/i;
const ASSET_EXT = /\.(png|jpg|jpeg|gif|webp|svg|ico|ttf|otf|woff2?|mp4|mp3|wav|pdf|xlsx|docx|pptx|csv|json|yaml|yml)$/i;

/** 技能的形态统计：说明、脚本、资源各有多少 —— 这决定「能不能只复制说明」 */
export function describeShape(files = [], skillDir = '') {
  const under = skillDir ? files.filter((f) => f.path.startsWith(skillDir + '/') || f.path === skillDir) : files;
  const scripts = under.filter((f) => SCRIPT_EXT.test(f.path));
  const assets = under.filter((f) => ASSET_EXT.test(f.path));
  const docs = under.filter((f) => /\.md$/i.test(f.path));
  const bytes = under.reduce((n, f) => n + (f.size || 0), 0);
  const langs = new Set();
  for (const s of scripts) {
    const ext = s.path.split('.').pop().toLowerCase();
    langs.add({ py: 'python', js: 'node', mjs: 'node', cjs: 'node', ts: 'node', sh: 'bash', ps1: 'powershell', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin' }[ext] || ext);
  }
  return {
    total: under.length,
    docs: docs.length,
    scripts: scripts.length,
    assets: assets.length,
    bytes,
    runtimes: [...langs],
    // 只有「一个说明文件」的技能，才谈得上复制粘贴就能用
    copyOnly: scripts.length === 0 && assets.length <= 1 && under.length <= 3,
  };
}

/** 从 SKILL.md 正文里找「例子 / 用法」段落，取一小段做效果示例 */
export function pickExample(mdBody = '') {
  const text = String(mdBody).replace(/\r/g, '');
  // ① 代码块最好：多半是一段输入或一段命令
  const fence = text.match(/\`\`\`[a-zA-Z]*\n([\s\S]{20,400}?)\n\`\`\`/);
  if (fence) return fence[1].trim().slice(0, 320);
  // ② 「输入 → 输出」「例如 e.g.」这类对照行
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const pairs = lines.filter((l) => /→|->|=>|例如|比如|^e\.g\.|input:|output:/i.test(l) && l.length > 8 && l.length < 260);
  if (pairs.length) return pairs.slice(0, 3).join('\n').slice(0, 320);
  // ③ 「示例 / Example」小节里的前几行
  const sec = text.split(/\n(?=#{2,3}\s)/).find((x) => /(示例|例子|example|用法示例)/i.test(x.slice(0, 60)));
  if (sec) {
    const body = sec
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-|]{3,}$/.test(l))
      .slice(0, 4)
      .join(' ');
    if (body) return body.slice(0, 320);
  }
  return ''; // 作者没给示例，UI 上就明说，不编
}

const NEED_RULES = [
  {
    key: 'python',
    label: 'Python 3',
    why: '这个技能带 .py 脚本（或说明里要你跑 python）',
    test: (ctx) => /\.py\b|(^|\s)python3?\b|\bpip3?\b|pandas|pptx|openpyxl|matplotlib/i.test(ctx),
    fix: 'winget install -e --id Python.Python.3.12（装完重开终端，`python --version` 要能看到 Python 3.x）',
  },
  {
    key: 'node',
    label: 'Node.js 18+',
    why: '这个技能带 .js/.mjs 脚本（或说明里要 npx / npm）',
    test: (ctx) => /\.m?js\b|(^|\s)npx?\b|\bnpm\b|\bnode\b/i.test(ctx),
    fix: '本机已有 Node；若换机器就装 Node 22+',
  },
  {
    key: 'bash',
    label: 'bash / Git Bash',
    why: '说明里有 shell 命令（chmod、.sh 脚本）',
    test: (ctx) => /\.sh\b|(^|\s)bash\b|chmod \+x|\$\{?[A-Z_]+/i.test(ctx),
    fix: 'Windows 上装 Git for Windows，用它的 Git Bash 跑这些命令',
  },
  {
    key: 'docker',
    label: 'Docker',
    why: '说明里要起容器',
    test: (ctx) => /\bdocker\s+(run|build|pull|compose)\b|docker-compose\.ya?ml/i.test(ctx),
    fix: '装 Docker Desktop；如果只是跑 agent 技能，多数情况不需要',
  },
  {
    key: 'key',
    label: 'API key',
    why: '说明里要填 key（第三方服务）',
    test: (ctx) => /(API[_-]?KEY|ACCESS[_-]?TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|SECRET[_-]?KEY|密钥)/i.test(ctx),
    fix: '按技能说明里的链接申请，然后写进环境变量（不要写进仓库）',
  },
  {
    key: 'network',
    label: '外网访问',
    why: '技能运行时要访问外部网站',
    test: (ctx) => /curl\s+https?:|fetch\(|https:\/\/api\./i.test(ctx),
    fix: '本机可直连 api.github.com / cn.bing.com；被墙的服务要自己准备代理',
  },
];

/**
 * 适配结论：需要什么、本机有没有、能不能直接用
 * @param {{text:string, shape:object}} doc
 * @param {object} env probeEnv() 的结果
 */
export function analyzeFit(doc, env = {}) {
  const ctx = String(doc.text || '');
  const needs = NEED_RULES.filter((r) => r.test(ctx)).map((r) => {
    const present = env[r.key] === undefined ? null : !!env[r.key];
    return { key: r.key, label: r.label, why: r.why, present, fix: r.fix };
  });
  const missing = needs.filter((n) => n.present === false);
  const hard = missing.filter((n) => n.key === 'python' || n.key === 'docker');
  const verdict = hard.length ? 'no' : missing.length ? 'partial' : 'ok';
  const agents = (env.agents || []).filter((a) => a.present).map((a) => a.label);
  return {
    needs,
    missing,
    verdict,
    summary:
      verdict === 'ok'
        ? `本机条件够了${agents.length ? `（已检测到 ${agents.join(' / ')}）` : ''}，直接装就能用。`
        : verdict === 'partial'
          ? `能用，但差 ${missing.map((m) => m.label).join('、')}。`
          : `本机跑不了：缺 ${hard.map((m) => m.label).join('、')}。先按下面的步骤补，再回来装。`,
  };
}

/** 给定仓库文件清单和技能 id，找出这个技能的目录与 SKILL.md */
/**
 * 找出技能的 SKILL.md。
 * 注意：jsDelivr 的文件清单来自它自己的缓存，可能落后于仓库现状
 * （实测 mattpocock/skills 的清单里是 /grill-me/SKILL.md，真实路径是 /skills/grill-me/SKILL.md），
 * 所以这里只排优先级，真正用哪个由 resolveSkill() 逐个试出来。
 */
export function locateSkill(files = [], skillId = '', source = '') {
  const id = String(skillId || '').toLowerCase();
  const md = files.filter((f) => /SKILL\.md$/i.test(f.path));
  const dirOf = (f) => f.path.replace(/\/SKILL\.md$/i, '');
  const last = (f) => (dirOf(f).split('/').filter(Boolean).pop() || '').toLowerCase();
  // 只认「目录名正好等于技能 id」：模糊包含会把 pdf 这种 id 匹配到报告模板目录
  const exact = md.filter((f) => id && last(f) === id);
  const ranked = exact.slice().sort((a, b) => {
    const da = dirOf(a).toLowerCase();
    const db = dirOf(b).toLowerCase();
    const inSkills = (d) => (/(^|\/)skills?\//.test(d) ? 1 : 0);
    return inSkills(db) - inSkills(da) || dirOf(a).split('/').length - dirOf(b).split('/').length;
  });
  if (!ranked.length) {
    return { ok: false, candidates: md.slice(0, 14).map((f) => f.path) };
  }
  const chosen = ranked[0];
  const dir = dirOf(chosen);
  return {
    ok: true,
    path: chosen.path,
    dir,
    name: dir.split('/').filter(Boolean).pop() || id,
    candidates: ranked.slice(1).map((f) => f.path),
  };
}

/** 正文里最适合当「能帮我做什么」的那一段：先找「什么时候用 / Overview」，否则取开头 */
export function summarizeBody(mdBody = '') {
  const text = String(mdBody).replace(/\r/g, '');
  const parts = text.split(/\n(?=#{2,3}\s)/);
  const want = parts.find((p) =>
    /(什么时候用|何时使用|适用场景|overview|what it does|概述|简介|when to use)/i.test(p.slice(0, 60)),
  );
  const body = (want || parts[1] || parts[0] || text)
    .replace(/^#{1,6}[^\n]*\n/, '')
    .replace(/^\s*[-*]\s*/gm, '· ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return body.slice(0, 520);
}

/** 目录里的文件压成「说明 / 脚本 / 资源」几行，让人一眼看出这是个什么形态的技能 */
export function shapeLines(files = [], dir = '') {
  const under = dir ? files.filter((f) => f.path.startsWith(dir + '/')) : files;
  const pick = (re) => under.filter((f) => re.test(f.path));
  const rest = (f) => (dir && f.path.startsWith(dir + '/') ? f.path.slice(dir.length + 1) : f.path.replace(/^\//, ''));
  const fmt = (arr, n = 6) => {
    const names = arr.slice(0, n).map(rest).join('、');
    return arr.length > n ? names + ' 等 ' + arr.length + ' 个' : names;
  };
  const docs = pick(/\.md$/i);
  const scripts = pick(SCRIPT_EXT);
  const assets = pick(ASSET_EXT);
  const other = under.filter((f) => !/\.md$/i.test(f.path) && !SCRIPT_EXT.test(f.path) && !ASSET_EXT.test(f.path));
  return [
    docs.length ? { k: '说明', v: fmt(docs) } : null,
    scripts.length ? { k: '脚本', v: fmt(scripts) } : null,
    assets.length ? { k: '资源', v: fmt(assets) } : null,
    other.length ? { k: '其它', v: fmt(other, 4) } : null,
  ].filter(Boolean);
}

/**
 * 拿到一个技能的可验证材料：文件清单 + SKILL.md 正文。
 * jsDelivr 的清单可能是旧缓存，所以候选路径要逐个真去取，取到才算数。
 */
const TREE_CACHE = new Map(); // source -> {at, paths}
const TREE_TTL = 6 * 60 * 60 * 1000;

/** 仓库目录改版时用一个 tree 请求把「<id>/SKILL.md」找出来（GitHub 60/h，所以缓存住） */
async function findByTree(source, skillId) {
  const id = String(skillId || '').toLowerCase();
  const hit = TREE_CACHE.get(source);
  let paths = hit && Date.now() - hit.at < TREE_TTL ? hit.paths : null;
  if (!paths) {
    paths = [];
    for (const ref of REFS) {
      try {
        const j = await httpJson(
          `https://api.github.com/repos/${source}/git/trees/${ref}?recursive=1`,
          { timeout: 15000 },
        );
        if (Array.isArray(j.tree)) {
          paths = j.tree.filter((x) => x.type === 'blob').map((x) => '/' + x.path);
          break;
        }
      } catch {
        /* 换个 ref 或放弃 */
      }
    }
    TREE_CACHE.set(source, { at: Date.now(), paths });
  }
  const md = (paths || []).filter((p) => /\/SKILL\.md$/i.test(p));
  const exact = md.filter((p) => p.replace(/\/SKILL\.md$/i, '').split('/').pop().toLowerCase() === id);
  return { exact, paths: paths || [] };
}

export async function resolveSkill(source, skillId) {
  const listed = await listRepoFiles(source);
  if (!listed.ok) return { ok: false, error: '列不出仓库文件：' + listed.error };
  const loc = locateSkill(listed.files, skillId, source);
  // 注意：loc.ok 为 false 时 loc.candidates 是「仓库里所有 SKILL.md」，只给 UI 列候选，不能拿来试读
  const tryList = loc.ok ? [loc.path, ...(loc.candidates || []).slice(0, 2)] : [];
  const paths = [];
  for (const p of [...tryList, '/' + skillId + '/SKILL.md', '/skills/' + skillId + '/SKILL.md']) {
    const path = String(p).replace(/\/{2,}/g, '/');
    if (!paths.includes(path)) paths.push(path);
  }
  for (const path of paths) {
    const got = await readRepoFile(source, path, listed.ref);
    if (got.ok) {
      return {
        ok: true,
        source,
        path,
        dir: path.replace(/\/SKILL\.md$/i, ''),
        ref: got.ref || listed.ref,
        text: got.text,
        via: got.via,
        files: listed.files,
      };
    }
  }
  // 常见位置都不对，就去翻一遍仓库树（改过目录结构的仓库只能这样找）
  try {
    const tree = await findByTree(source, skillId);
    for (const path of (tree.exact || []).slice(0, 3)) {
      const got = await readRepoFile(source, path, listed.ref);
      if (got.ok) {
        return {
          ok: true,
          source,
          path,
          dir: path.replace(/\/SKILL\.md$/i, ''),
          ref: got.ref || listed.ref,
          text: got.text,
          via: got.via,
          // 树里的路径才是当前真实结构，jsDelivr 的清单可能是旧的
          files: tree.paths.map((p) => ({ path: p, size: 0 })),
          byTree: true,
        };
      }
    }
  } catch {
    /* 树也失败就认输 */
  }
  return {
    ok: false,
    error: '读不到这个技能的 SKILL.md（仓库里没找到同名目录）',
    candidates: (loc.candidates && loc.candidates.length ? loc.candidates : paths).slice(0, 14),
  };
}
