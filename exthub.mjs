/**
 * 扩展能力目录：把「插件 / 技能 / MCP」放在同一套卡片里，按用途分组、按使用环境筛选。
 *
 * 数据只来自机器可读的官方目录：
 *   - Obsidian 社区插件清单（jsDelivr 镜像的 community-plugins.json）
 *   - VS Code 市场 extensionquery 接口
 *   - Godot Asset Library API
 *   - Blender 官方扩展站 API
 *   - 官方 MCP Registry
 *
 * 三档可信度（不互相冒充）：
 *   directory  出现在官方目录的机器可读列表里（能被市场检索到）
 *   author     只有作者自己的仓库/README 这么说，没有独立验证
 *   tested     这台机器上真的取到了包、或真的跑起来了（带日期与命令）
 *
 * 这里不编「权限」：目录接口基本不给权限信息，所以卡片只写由形态决定的通用事实，
 * 并明确标「未标注」，让人知道这不是作者声明。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const SOURCE_TTL_MS = 12 * 3600 * 1000;

export const USE_GROUPS = [
  { id: 'general', label: '通用能力', note: '网页阅读、搜索、PDF、表格、翻译、笔记整理、文件处理' },
  { id: 'work', label: '工作专用', note: '写作、研究、设计、编程、数据分析、办公自动化' },
  { id: 'hobby', label: '兴趣专用', note: '游戏开发、像素素材、3D、摄影、音乐制作' },
  { id: 'connect', label: '连接现有工具', note: '让 AI 用你的笔记、文件库、日历或其他服务里的内容' },
];

const USE_RULES = [
  { id: 'connect', re: /(mcp|连接|接入|bridge|sync|calendar|日历|notion|jira|slack|gmail|google drive|dropbox|文件库|database|数据库|api)/i },
  { id: 'hobby', re: /(godot|unity|unreal|blender|3d|sprite|像素|pixel art|tilemap|shader|纹理|texture|游戏|game|摄影|photo|music|音乐|midi|audio|音频|动画|animation|法线|normal map|素材|asset)/i },
  { id: 'work', re: /(code|编程|python|typescript|javascript|git|review|test|测试|table|表格|excel|csv|pdf|数据|analysis|分析|写作|writing|研究|research|design|设计|figma|会议|meeting|简历|resume)/i },
  { id: 'general', re: /(search|搜索|reader|阅读|translate|翻译|note|笔记|markdown|file|文件|download|web|browser|浏览器|剪藏|clip|整理|organize)/i },
];

export function useOf(entry) {
  const text = `${entry.name || ''} ${entry.desc || ''} ${(entry.tags || []).join(' ')}`;
  for (const r of USE_RULES) if (r.re.test(text)) return r.id;
  return 'general';
}

async function fetchJson(url, { timeout = 25000, init } = {}) {
  const res = await fetch(url, {
    ...(init || {}),
    headers: { 'user-agent': UA, accept: 'application/json', ...((init && init.headers) || {}) },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const clean = (s, n = 220) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/* ------------------------------------------------------------ Obsidian */

const OBS_URL = 'https://testingcf.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugins.json';
const OBS_PICK = /(git|table|pdf|excalidraw|dataview|tasks|templater|calendar|canvas|export|import|image|ocr|translate|ai|llm|copilot|smart|search|outline|file|attachment|backlink|daily|kanban)/i;

export async function fetchObsidian({ limit = 24 } = {}) {
  const all = await fetchJson(OBS_URL);
  if (!Array.isArray(all)) throw new Error('清单格式变了');
  const rows = all
    .filter((p) => p && p.id && p.name)
    .filter((p) => OBS_PICK.test(`${p.name} ${p.description || ''}`))
    .slice(0, limit)
    .map((p) => ({
      id: `obs:${p.id}`,
      source: 'obsidian',
      kind: '插件',
      name: p.name,
      desc: clean(p.description, 160),
      url: `https://obsidian.md/plugins?id=${p.id}`,
      repo: p.repo ? `https://github.com/${p.repo}` : '',
      author: p.author || '',
      needs: ['obsidian'],
      cost: '免费（社区插件本体免费；作者可能另有付费服务）',
      perms: '能读写你的 vault（笔记库）文件——装之前看清楚它要不要联网',
      start: `Obsidian → 设置 → 第三方插件 → 浏览 → 搜「${p.name}」→ 安装并启用`,
      verified: { level: 'directory', via: 'Obsidian 社区插件清单', at: '' },
      tags: ['obsidian', 'notes'],
    }));
  return { rows, total: all.length };
}

/* ------------------------------------------------------------- VS Code */

const VSCODE_QUERIES = ['godot', 'blender', 'tilemap', 'sprite sheet', 'markdown pdf', 'excel table', 'translate', 'mcp'];

export async function fetchVscode({ perQuery = 3 } = {}) {
  const rows = [];
  let total = 0;
  for (const q of VSCODE_QUERIES) {
    const body = {
      filters: [{ criteria: [{ filterType: 8, value: 'Microsoft.VisualStudio.Code' }, { filterType: 10, value: q }], pageNumber: 1, pageSize: perQuery, sortBy: 4, sortOrder: 0 }],
      flags: 914,
    };
    let data;
    try {
      data = await fetchJson('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
        init: { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json;api-version=7.2-preview.1' }, body: JSON.stringify(body) },
      });
    } catch {
      continue;
    }
    const list = (data && data.results && data.results[0] && data.results[0].extensions) || [];
    total += (data && data.results && data.results[0] && data.results[0].resultMetadata) ? 0 : 0;
    for (const e of list) {
      const installs = ((e.statistics || []).find((s) => s.statisticName === 'install') || {}).value || 0;
      if (installs < 5000) continue;
      rows.push({
        id: `vsc:${e.publisher.publisherName}.${e.extensionName}`,
        source: 'vscode',
        kind: '插件',
        name: e.displayName || e.extensionName,
        desc: clean(e.shortDescription || (e.versions && e.versions[0] && e.versions[0].description) || '', 160),
        url: `https://marketplace.visualstudio.com/items?itemName=${e.publisher.publisherName}.${e.extensionName}`,
        author: e.publisher.displayName || e.publisher.publisherName,
        installs,
        needs: ['vscode'],
        cost: '免费（扩展本体免费）',
        perms: '能读写你打开的工作区文件；部分扩展会联网，具体看作者说明（市场不提供权限清单）',
        start: `code --install-extension ${e.publisher.publisherName}.${e.extensionName}`,
        verified: { level: 'directory', via: 'VS Code 市场接口', at: String(e.lastUpdated || '').slice(0, 10) },
        tags: ['vscode', q],
        query: q,
      });
    }
  }
  return { rows, total: rows.length };
}

/* --------------------------------------------------------------- Godot */

const GODOT_QUERIES = ['pixel', 'sprite', 'tile', 'shader', 'light', 'palette', 'animation', 'level'];

export async function fetchGodot({ perQuery = 3 } = {}) {
  const rows = [];
  const seen = new Set();
  for (const q of GODOT_QUERIES) {
    let data;
    try {
      data = await fetchJson(`https://godotengine.org/asset-library/api/asset?filter=${encodeURIComponent(q)}&godot_version=4&max_results=${perQuery}&sort=last_modified`);
    } catch {
      continue;
    }
    for (const a of (data && data.result) || []) {
      if (!a || !a.asset_id || seen.has(a.asset_id)) continue;
      seen.add(a.asset_id);
      rows.push({
        id: `gd:${a.asset_id}`,
        source: 'godot',
        kind: '插件',
        name: String(a.title || '').slice(0, 80),
        desc: clean(`${a.category || '插件'}｜Godot ${a.godot_version || ''}｜支持等级 ${a.support_level || '未标注'}`, 160),
        url: `https://godotengine.org/asset-library/asset/${a.asset_id}`,
        repo: a.browse_url || '',
        author: a.author || '',
        needs: ['godot'],
        cost: /MIT|Apache|BSD|GPL|CC0/i.test(String(a.cost || '')) ? `免费（${a.cost}）` : `许可证 ${a.cost || '未标注'}`,
        perms: '装进项目里，能改你的工程文件（addons/ 下的脚本与资源）',
        start: `下载后在 项目 → 资源库 里搜「${a.title}」，或把 addons 目录拷进项目`,
        verified: { level: 'directory', via: 'Godot Asset Library', at: String(a.modify_date || '').slice(0, 10) },
        tags: ['godot', a.category || ''],
        query: q,
      });
    }
  }
  return { rows, total: rows.length };
}

/* ------------------------------------------------------------- Blender */

const BLENDER_PICK = /(pixel|texture|uv|rig|anim|render|compos|node|mesh|sculpt|camera|light|export|import|image)/i;

export async function fetchBlender({ limit = 600 } = {}) {
  const data = await fetchJson(`https://extensions.blender.org/api/v1/extensions/?page_size=${limit}`);
  const all = (data && data.data) || [];
  const rows = all
    .filter((e) => BLENDER_PICK.test(`${e.name} ${e.tagline || ''}`))
    .slice(0, 18)
    .map((e) => ({
      id: `bl:${e.id}`,
      source: 'blender',
      kind: '扩展',
      name: e.name || e.id,
      desc: clean(e.tagline, 160),
      url: `https://extensions.blender.org/add-ons/${e.id}/`,
      author: (e.maintainers && e.maintainers[0] && e.maintainers[0].name) || '',
      needs: ['blender'],
      cost: '免费（Blender 官方扩展站）',
      perms: '能读写你打开的 .blend 场景文件',
      start: `Blender → 编辑 → 偏好设置 → 获取扩展 → 搜「${e.name}」`,
      verified: { level: 'directory', via: 'Blender 扩展站 API', at: '' },
      tags: ['blender', '3d'],
    }));
  return { rows, total: all.length };
}

/* ----------------------------------------------------------------- MCP */

export async function fetchMcp({ pages = 2, limit = 60, keep = 42 } = {}) {
  const rows = [];
  const seen = new Set();
  let cursor = '';
  for (let i = 0; i < pages; i++) {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch {
      break;
    }
    for (const item of (data && data.servers) || []) {
      const s = item.server || item;
      if (!s || !s.name || seen.has(s.name)) continue;
      seen.add(s.name);
      const pkgs = Array.isArray(s.packages) ? s.packages : [];
      const remotes = Array.isArray(s.remotes) ? s.remotes : [];
      const envKeys = [];
      pkgs.forEach((p) => (p.environmentVariables || []).forEach((v) => { if (v && v.name) envKeys.push(v.name); }));
      const npmPkg = (pkgs.find((p) => p.registryType === 'npm') || {}).identifier || '';
      rows.push({
        id: `mcp:${s.name}`,
        source: 'mcp',
        kind: 'MCP',
        name: s.title || s.name,
        desc: clean(s.description, 180),
        url: s.websiteUrl || (s.repository && s.repository.url) || `https://registry.modelcontextprotocol.io/?q=${encodeURIComponent(s.name)}`,
        author: String(s.name).split('/')[0] || '',
        needs: ['mcpclient'],
        cost: '未标注（多数免费，官方 registry 不标价格）',
        perms: envKeys.length
          ? `需要这些凭据：${envKeys.slice(0, 6).join('、')}${envKeys.length > 6 ? ' 等' : ''}——它拿到的就是你给出的权限`
          : '权限未标注：装上后它能访问的东西，取决于你给的目录、token 与服务账号',
        start: remotes.length
          ? `接一个地址就行：${remotes[0].url}`
          : npmPkg
            ? `npx -y ${npmPkg}（在你的 MCP 客户端里加一条 server 配置）`
            : '按 registry 页面的安装说明接到你的 MCP 客户端',
        verified: { level: 'directory', via: '官方 MCP Registry', at: String(((item._meta || {})['io.modelcontextprotocol.registry/official'] || {}).publishedAt || '').slice(0, 10) },
        tags: ['mcp', ...(remotes.length ? ['remote'] : ['local'])],
      });
    }
    cursor = (data && data.metadata && data.metadata.nextCursor) || '';
    if (!cursor) break;
  }
  rows.sort((a, b) => {
    const ra = /remote/.test(a.tags.join(' ')) ? 1 : 0;
    const rb = /remote/.test(b.tags.join(' ')) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (b.desc || '').length - (a.desc || '').length;
  });
  return { rows: rows.slice(0, keep), total: rows.length };
}

/* -------------------------------------------------------------- 聚合 */

const SOURCES = [
  { id: 'obsidian', label: 'Obsidian 社区插件', run: (o) => fetchObsidian(o) },
  { id: 'vscode', label: 'VS Code 市场', run: (o) => fetchVscode(o) },
  { id: 'godot', label: 'Godot 资源库', run: (o) => fetchGodot(o) },
  { id: 'blender', label: 'Blender 扩展站', run: (o) => fetchBlender(o) },
  { id: 'mcp', label: '官方 MCP Registry', run: (o) => fetchMcp(o) },
];

export async function buildCatalog({ prev, force } = {}) {
  const fresh = prev && prev.at && !force && Date.now() - Date.parse(prev.at) < SOURCE_TTL_MS;
  if (fresh) return { ...prev, cached: true };

  const sources = {};
  const rows = [];
  const now = new Date().toISOString();

  for (const src of SOURCES) {
    try {
      const r = await src.run({});
      (r.rows || []).forEach((x) => rows.push({ ...x, use: useOf(x) }));
      sources[src.id] = { ok: true, label: src.label, count: (r.rows || []).length, at: now };
    } catch (e) {
      sources[src.id] = { ok: false, label: src.label, count: 0, error: String((e && e.message) || e), at: now };
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  rows.forEach((x) => { if (!x.verified.at) x.verified.at = now.slice(0, 10); });

  return { at: now, cached: false, rows, sources };
}

export function summarize(catalog) {
  const groups = {};
  USE_GROUPS.forEach((g) => { groups[g.id] = 0; });
  (catalog.rows || []).forEach((r) => { groups[r.use] = (groups[r.use] || 0) + 1; });
  const bySource = {};
  Object.entries(catalog.sources || {}).forEach(([k, v]) => { bySource[k] = v.count || 0; });
  return { total: (catalog.rows || []).length, groups, bySource };
}

export const USE_LABEL = Object.fromEntries(USE_GROUPS.map((g) => [g.id, g.label]));
