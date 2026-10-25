'use strict';

const $ = (sel) => document.querySelector(sel);
const api = window.radar;

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

const S = {
  state: null,
  view: 'today',
  date: '',
  data: null,
  digest: null,
  index: {},
  radarTab: 'new',
  filter: 'all',
  range: 'today',
  agg: null,
  aggKey: '',
  aggBusy: false,
  collecting: false,
  generating: false,
  aux: { bookmarks: {}, read: {} },
  spot: { open: false, q: '', items: [], total: 0, days: 0, sel: 0, webRows: [], webBusy: false, webError: '' },
  ext: { cat: null, env: null, use: 'all', host: 'all', busy: false, probed: {}, err: '' },
  sdoc: { open: false, busy: false, data: null, err: '', env: null, envBusy: false },
  tr: { to: 'zh', busy: false, out: '', ms: 0, err: '', cached: false },
  uc: { open: false, busy: false, data: null, item: null, err: '', followed: false },
  digestEn: {},
  drawer: null,
  concepts: undefined,
  packs: undefined,
  dict: { q: '', mode: 'list', id: '', packId: '', hist: [], expand: false, gen: { open: false, name: '', busy: false, err: '' } },
  cur: -1,
  chat: { msgs: [], busy: false, profile: null, hasKey: false, model: '', date: '', stream: '', loaded: false },
  match: { range: 'd7', items: null, busy: false, needs: 0 },
  usage: null,
  trans: {},
  summary: {},
  onboard: null,
  weekly: null,
  tasks: null,
  task: null,
  tplLib: null,
  tpl: null,
  needs: { payload: null, scan: null, busy: false, form: null, tracking: null, daily: {}, trackBusy: false, err: '' },
};
window.__S = S;

const shortTime = (iso) => {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || '').slice(0, 40); }
};
const shortNum = (n) => {
  if (typeof n !== 'number') return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString('en-US');
};
const ctxText = (n) => (!n ? '—' : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const priceText = (a, b) => (a == null && b == null ? '—' : `$${a ?? '?'} / $${b ?? '?'}`);
const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ------------------------------------------------------- 收藏 / 已读 / 高亮 */

const isRead = (u) => !!(u && S.aux.read[u]);
const isSaved = (u) => !!(u && S.aux.bookmarks[u]);
const rtClass = (u) => (isRead(u) ? ' is-read' : '');

function saveBtn(it) {
  const on = isSaved(it.url);
  return `<button class="save${on ? ' on' : ''}" type="button" data-act="save"`
    + ` data-url="${esc(it.url)}" data-title="${esc(it.title)}" data-kind="${esc(it.kind || '')}" data-date="${esc(it.date || '')}"`
    + ` title="${on ? '取消收藏' : '收藏'}" aria-label="${on ? '取消收藏' : '收藏'}">★</button>`;
}

/** 「有什么用」按钮：打开右侧用途卡（四问 + 试试看 / 关注后续） */
function ucBtn(it, kind) {
  if (!it || !it.url) return '';
  return `<button class="ucbtn" type="button" data-act="uc"`
    + ` data-url="${esc(it.url)}" data-kind="${esc(kind || '')}" title="这对我有什么用">有什么用</button>`;
}

const tokensOf = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);

function hl(text, tokens) {
  const s = String(text == null ? '' : text);
  if (!tokens || !tokens.length) return esc(s);
  const re = new RegExp('(' + tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return esc(s).replace(re, '<mark>$1</mark>');
}

/* ------------------------------------------------------------------ toast */

window.__errs = [];
window.addEventListener('error', (e) => {
  window.__errs.push(String(e.message || e));
  toast('出错了：' + (e.message || '未知错误'), true);
});
window.addEventListener('unhandledrejection', (e) => {
  window.__errs.push(String(e.reason && e.reason.message ? e.reason.message : e.reason));
  toast('出错了：' + (e.reason && e.reason.message ? e.reason.message : e.reason), true);
});

let toastTimer = null;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.toggle('bad', !!bad);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
}

/* ------------------------------------------------------------------ rail */

function renderRail() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  $('#dayNum').textContent = p2(d.getDate());
  $('#dayMonth').textContent = `${d.getFullYear()}.${p2(d.getMonth() + 1)}`;
  $('#dayWeek').textContent = `${MONTH[d.getMonth()]} ${WEEK[d.getDay()]}`;

  const st = S.state;
  const box = $('#status');
  const last = st.collectedAt ? new Date(st.collectedAt) : null;
  const lastTime = last ? `${p2(last.getHours())}:${p2(last.getMinutes())}` : '—';
  const src = st.sources || { ok: 0, total: 0, failed: [] };
  const c = st.counts;

  if (!st.hasBrief) {
    box.innerHTML = `<div class="status-empty"><b>今天还没有数据</b>最后一次采集 <span class="fig">${esc(lastTime)}</span>，点下面的按钮开始。</div>`;
  } else {
    const total = src.total || 12;
    box.innerHTML = `<ul class="ledger">
      <li><span>最后采集</span><b>${esc(lastTime)}</b></li>
      <li class="${src.ok < total ? 'warn' : ''}"><span>数据源正常</span><b>${src.ok} / ${total}</b></li>
      ${c ? `<li><span>项目</span><b>${num(c.repos)}</b></li><li><span>新闻</span><b>${num(c.news)}</b></li>` : ''}
      ${src.failed.length ? `<li class="fail"><span>没抓到</span><span>${esc(src.failed.join(' / '))}</span></li>` : ''}
    </ul>`;
  }

  $('#railFoot').innerHTML = `<span class="ef-state${st.hasDigest ? '' : ' is-draft'}">${st.hasDigest ? '简报已生成' : '简报未生成'}</span><span class="fig">${esc(st.today.replace(/-/g, '.'))}</span>`;

  $('#btnCollect').textContent = S.collecting ? '采集中…' : (st.hasBrief ? '重新采集' : '开始采集');
  $('#btnCollect').disabled = S.collecting;

  const counts = {
    history: (st.dates || []).length,
    saved: Object.keys(S.aux.bookmarks || {}).length,
    radar: c ? (c.repos || 0) + (c.news || 0) : 0,
  };
  for (const el of document.querySelectorAll('.nav-item [data-count]')) {
    const n = counts[el.dataset.count];
    el.textContent = n ? num(n) : '';
  }
  renderWhere();
}

/* 每个页面的英文眉标（中文页名的直译），命令栏和页头共用 */
const VIEW_EN = {
  today: 'Daily Brief', weekly: 'Weekly', history: 'History', saved: 'Saved',
  needs: 'Needs', radar: 'Raw Radar', ext: 'Plugins', chat: 'Chat', tasks: 'Templates',
  concepts: 'Glossary', agents: 'Agents', settings: 'Settings', trans: 'Translate',
};

function renderWhere() {
  const box = $('#cmdWhere');
  const nav = document.querySelector(`.nav-item[data-view="${S.view}"]`);
  if (!box) return;
  const no = nav ? nav.querySelector('.no').textContent : '';
  const zh = nav ? nav.querySelector('.zh').textContent : (S.view === 'trans' ? '翻译长文' : '');
  box.innerHTML = `<span class="here">${no ? `<span class="fig">${esc(no)}</span>` : ''}${esc(zh)}</span><span class="en">${esc(VIEW_EN[S.view] || '')}</span>`;
}

/* 过渡动画：设置里可选 开 / 跟随系统 / 关，默认开；记在这台电脑的本地存储里。
   theme.js 在开窗前已经按同样的规则写好 <html data-motion>。 */
function motionPref() {
  try {
    const v = localStorage.getItem('radar.motion');
    if (v === 'on' || v === 'off' || v === 'system') return v;
  } catch {}
  return 'on';
}

function applyMotion() {
  const pref = motionPref();
  const off = pref === 'off' || (pref === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  document.documentElement.dataset.motion = off ? 'off' : 'on';
}

function setMotion(v) {
  try { localStorage.setItem('radar.motion', v); } catch {}
  applyMotion();
  if (S.view === 'settings') {
    for (const b of document.querySelectorAll('[data-act="motion"]')) {
      const on = b.dataset.motion === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
}

/* 换页过渡：旧页向右退出，新页从左擦入。过渡动画关掉时直接换。 */
const reducedMotion = () => document.documentElement.dataset.motion === 'off';
const canTransition = () => typeof document.startViewTransition === 'function' && !reducedMotion() && !document.hidden;

/** 起一次过渡。连点时上一次会被打断，那不是错误，不弹「出错了」 */
function runTransition(update) {
  const t = document.startViewTransition(update);
  for (const p of [t.updateCallbackDone, t.ready, t.finished]) p.catch(() => {});
  return t;
}

function setView(view) {
  const same = S.view === view;
  S.view = view;
  for (const b of document.querySelectorAll('.nav-item')) {
    const on = b.dataset.view === view;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const swap = async () => {
    renderWhere();
    // 等新页画出来再拍快照；读网络的页面最多等 260ms，不让界面卡住
    await Promise.race([Promise.resolve(renderViewInner()), new Promise((r) => setTimeout(r, 260))]);
    applyCompact();
    attachSkillDocButtons(document.getElementById('view'));
    $('#main').scrollTop = 0;
  };
  if (same || !canTransition()) { void swap(); return; }
  runTransition(swap);
}

/** 同一页里换一组内容（雷达换标签页）时，新内容从左擦入 */
function enterBody(sel) {
  if (reducedMotion()) return;
  const el = document.querySelector(sel);
  if (!el) return;
  el.classList.remove('is-entering');
  void el.offsetWidth;
  el.classList.add('is-entering');
}

/* 深浅色：没选过就跟随系统；选过就记住 */
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function paintThemeBtn() {
  const b = $('#btnTheme');
  if (!b) return;
  const dark = currentTheme() === 'dark';
  b.textContent = dark ? '浅色' : '深色';
  b.setAttribute('aria-pressed', String(dark));
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('radar.theme', next); } catch {}
    paintThemeBtn();
  };
  if (!canTransition()) { apply(); return; }
  // 新主题从按钮处以圆形揭开
  const r = $('#btnTheme').getBoundingClientRect();
  const root = document.documentElement;
  root.style.setProperty('--rx', `${Math.round(r.left + r.width / 2)}px`);
  root.style.setProperty('--ry', `${Math.round(r.top + r.height / 2)}px`);
  root.classList.add('theme-flip');
  runTransition(apply).finished.catch(() => {}).then(() => root.classList.remove('theme-flip'));
}

/* --------------------------------------------------------------- 简洁模式 */
// 默认收起：灰字说明、代码/命令块、模型自带的思考过程。设置里一个开关就能全部摊开。
function isCompact() {
  return !S.state || !S.state.config || S.state.config.compact !== false;
}

function applyCompact() {
  document.body.classList.toggle('compact', isCompact());
  if (!isCompact()) return;
  const sel = 'pre:not([data-cc]):not(.log), code.cmd-code:not([data-cc]), a.cmd-code:not([data-cc])';
  for (const el of document.querySelectorAll(sel)) {
    el.dataset.cc = '1';
    el.classList.add('cc-hidden');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'codebtn';
    btn.dataset.act = 'code';
    btn.dataset.kind = el.tagName === 'PRE' ? '代码' : '命令';
    btn.textContent = btn.dataset.kind;
    el.parentNode.insertBefore(btn, el);
  }
}

function toggleCode(btn) {
  const el = btn.nextElementSibling;
  if (!el) return;
  const nowHidden = el.classList.toggle('cc-hidden');
  btn.classList.toggle('is-on', !nowHidden);
  btn.textContent = nowHidden ? (btn.dataset.kind || '代码') : '收起';
}

// 模型偶尔会把「思考过程」写进正文。切成两段，思考那段默认折叠。
function splitThink(text) {
  const src = String(text || '');
  const m = src.match(/^[\s>]*\*{0,2}\s*(思考过程|思考|thinking\s*process|thinking|reasoning)\s*\*{0,2}\s*[:：]?\s*\n/i);
  if (!m) return { think: '', body: src };
  const rest = src.slice(m[0].length);
  const cut = rest.search(/\n#{1,6}\s|\n-{3,}\s*\n/);
  if (cut < 0) return { think: '', body: src };
  return { think: rest.slice(0, cut).trim(), body: rest.slice(cut).replace(/^\n+/, '') };
}

/* ------------------------------------------------------------------ views */


/** 技能标签页里的 GitHub 仓库也给一个「说明书」入口（这些行没有 source/skill_id 字段） */
function attachSkillDocButtons(root) {
  if (!root || S.view !== 'radar' || S.radarTab !== 'skills') return;
  root.querySelectorAll('.repo[data-nav="repo"]').forEach((el) => {
    if (el.querySelector('.skilldoc-btn')) return;
    const name = el.dataset.name || '';
    if (!name.includes('/')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini skilldoc-btn';
    btn.textContent = '说明书';
    btn.dataset.act = 'skill-doc';
    btn.dataset.source = name;
    btn.dataset.id = name.split('/').pop();
    const host = el.querySelector('.repo-tag') || el;
    host.appendChild(btn);
  });
}

function renderView() {
  renderViewInner();
  applyCompact();
  attachSkillDocButtons(document.getElementById('view'));
}

function renderViewInner() {
  const host = $('#view');
  if (!S.state) { host.innerHTML = ''; return; }
  if (S.view === 'today') return renderToday(host);
  if (S.view === 'radar') return renderRadar(host);
  if (S.view === 'history') return renderHistory(host);
  if (S.view === 'weekly') return renderWeekly(host);
  if (S.view === 'trans') return renderTrans(host);
  if (S.view === 'saved') return renderSaved(host);
  if (S.view === 'agents') return renderAgents(host);
  if (S.view === 'concepts') return renderConcepts(host);
  if (S.view === 'needs') return renderNeeds(host);
  if (S.view === 'ext') return renderExt(host);
  if (S.view === 'chat') return renderChat(host);
  if (S.view === 'tasks') return renderTasks(host);
  if (S.view === 'settings') return renderSettings(host);
}

function stampLine() {
  const st = S.state;
  const src = st.sources || { ok: 0, total: 0 };
  const total = src.total || 12;
  return `<div class="stamp">
    <span class="ttl">${esc(VIEW_EN[S.view] || '')}</span>
    <span class="f">${esc(String(S.date || '').replace(/-/g, '.'))}</span>
    ${st.collectedAt
      ? `<span class="f ok">${src.ok} / ${total} 源正常</span>${src.ok < total ? '<span class="f warn">有源没抓到</span>' : ''}`
      : '<span class="f">今天还没采集</span>'}
  </div>`;
}

async function renderToday(host) {
  const date = S.date;
  if (S.generating) {
    host.innerHTML = `${stampLine()}
      <div class="empty"><h1>正在生成简报</h1>
      <p>模型在读今天的原件，并对照前一天的简报去重。通常 20–60 秒。</p>
      <p class="hint" id="genTimer">刚刚开始…</p></div>`;
    return;
  }

  const md = await api.digest(date);
  if (md) {
    S.digest = md;
    const body = md.replace(/^\s*#[^#\n]*\n/, '').trimStart();
    const m = body.match(/^##\s*一句话\s*\n+([\s\S]*?)(?=\n##\s|$)/);
    const standfirst = m ? m[1].replace(/\n+/g, ' ').trim() : '';
    const rest = m ? body.replace(m[0], '') : body;
    const isToday = date === todayStr();
    host.innerHTML = `
      ${stampLine()}
      ${isToday ? '' : `<div class="date-nav"><button class="back" data-act="today">← 回到今天</button><span class="hint">在看 ${esc(date)} 的简报</span></div>`}
      ${standfirst ? `<p class="standfirst">${esc(standfirst)}</p>` : ''}
      ${tplStrip()}
      <div class="prose digest-body">${window.renderMarkdown(rest)}</div>
      ${digestEnBlock()}
      ${matchShell()}
      <div class="actions"><button class="btn quiet" data-act="digest-en">译成英文</button><button class="btn quiet" data-act="regen">重新生成</button><button class="btn quiet" data-act="open-digests">打开简报文件夹</button></div>`;
    linkTerms($('.digest-body'));
    if (S.state.config.matchEnabled !== false) void paintMatch();
    return;
  }

  const brief = await loadData(date);
  if (!brief) {
    const prev = (S.state.dates || []).find((d) => d.digest);
    host.innerHTML = `<div class="empty">
      <h1>今天还没有数据</h1>
      <p>采集器会抓 GitHub 新项目与增速、OpenRouter / Ollama 新模型、新闻、arXiv、Hacker News，大约 40 秒，不花 token。</p>
      <div class="actions">
        <button class="btn primary" data-act="collect">开始采集</button>
        ${prev ? `<button class="btn quiet" data-act="open-date" data-date="${esc(prev.date)}">看 ${esc(prev.date)} 的简报</button>` : ''}
      </div>
      <p class="hint">采集完可以在设置里填一个 API key，让这里直接生成简报；也可以让 DSH 里的 agent 读 inbox 原件来写——那条路能联网核实，写得更准。</p>
    </div>`;
    return;
  }

  const total = (brief.news?.length || 0) + (brief.papers?.length || 0) + (brief.hn?.length || 0);
  const hasKey = S.state.config.hasKey;
  host.innerHTML = `${stampLine()}
    <div class="empty">
      <h1>原件已就绪，简报还没生成</h1>
      <p>今天采集到 ${num(total)} 条原始信息，${num((brief.github?.new_repos?.length || 0) + (brief.github?.ai_new?.length || 0))} 个项目等待判断。</p>
      <div class="actions">
        ${hasKey
          ? '<button class="btn primary" data-act="generate">生成简报</button>'
          : '<button class="btn primary" data-act="copy-prompt">复制指令给 DSH</button>'}
        <button class="btn quiet" data-act="radar">先看原始雷达</button>
      </div>
      <p class="hint">${hasKey
        ? '会用设置里的模型生成，写完存进 digests/。'
        : '还没有 API key。点上面那个按钮，把一段指令粘到 DSH 对话框里，让 agent 读 inbox 原件并联网核实来写——这条路的判断质量比本地模型高。想去掉这个手工步骤，就到「设置」填一个兼容 OpenAI 的 key。'}</p>
    </div>
    ${tplStrip()}
    ${matchShell()}`;
  if (S.state.config.matchEnabled !== false) void paintMatch();
}

/** 首页顶部的一条入口：给不知道从哪开始的人一个「直接能用」的动作 */
function tplStrip() {
  const lib = S.tplLib;
  if (!lib || !(lib.templates || []).length) return '';
  const picks = lib.templates.slice(0, 6);
  return `<div class="tstrip">
    <div class="tstrip-head"><span class="tstrip-title">想直接做点事？</span>
      <span class="tstrip-note">填三格就出成品，每个模板都带示例材料</span></div>
    <div class="tstrip-btns">
      ${picks.map((t) => `<button type="button" class="tbt" data-act="tpl-open" data-id="${esc(t.id)}">${esc(t.title)}</button>`).join('')}
      <button type="button" class="tbt more" data-act="tmpl-all">全部模板</button>
    </div>
  </div>`;
}

/** 数据目录下的一个路径；数据目录由主进程按实际安装位置给出，不写死 */
function rootPath(...parts) {
  const root = String((S.state && S.state.root) || '').replace(/[\\/]+$/, '');
  return [root, ...parts].filter(Boolean).join('\\');
}

function dshCommand(date) {
  return [
    `请读 ${rootPath('inbox', date + '.md')}（这是采集器原件），`,
    `按 ${rootPath('prompts', 'daily.md')} 的要求写今天的简报：`,
    `需要时用 web_search 交叉核实，链接必须来自材料或你实际查到的页面，不要编数字。`,
    `写好后存进 ${rootPath('digests', date + '.md')}，并把这一天追加到 digests\\INDEX.md。`,
  ].join('');
}

const passFilter = (u) => (S.filter === 'all' ? true : S.filter === 'unread' ? !isRead(u) : isSaved(u));

function repoRow(r) {
  const vel = r.gain_24h;
  const speed = typeof vel === 'number' && vel > 0 ? vel : null;
  const tr = transOf(r.url);
  return `<div class="repo${rtClass(r.url)}" data-nav="repo" data-name="${esc(r.full_name)}" data-url="${esc(r.url)}">
    <button class="repo-name aslink" type="button" data-act="detail" data-name="${esc(r.full_name)}" data-url="${esc(r.url)}">${esc(r.full_name)}</button>
    <div class="num">${shortNum(r.stars)}<span>stars</span></div>
    <div class="num${speed ? ' hot' : ''}">${speed ? '+' + shortNum(Math.round(speed)) : (r.stars_per_day_since_birth ? shortNum(Math.round(r.stars_per_day_since_birth)) : '—')}<span>${speed ? '24h' : '⭐/天'}</span></div>
    ${saveBtn({ url: r.url, title: r.full_name, kind: 'repo', date: r.last_seen || S.date })}
    ${r.desc ? `<p class="repo-desc">${esc(r.desc)}</p>` : '<p class="repo-desc"></p>'}
    ${tr && tr.show ? `<p class="repo-desc zh">${esc(tr.zh)}</p>` : ''}
    <div class="repo-uc">${ucBtn({ url: r.url, title: r.full_name, desc: r.desc }, 'repo')}</div>
    <div class="repo-tag">${r.lang ? `<span>${esc(r.lang)}</span>` : ''}<span>${r.created_days_ago != null ? esc(r.created_days_ago) + ' 天前建' : ''}</span><span>${r.pushed_days_ago === 0 ? '今天有提交' : ''}</span>${r._arch ? '<span>历史档案</span>' : ''}${S.range !== 'today' && r.last_seen && !r._arch ? `<span>最近 ${esc(String(r.last_seen).slice(5))} 出现${r.seen_days > 1 ? ' · ' + r.seen_days + ' 天' : ''}</span>` : ''}${r.desc ? transBtn(r.url, r.desc) : ''}</div>
  </div>`;
}

function group(title, rows, note, cap = 200, rowFn = repoRow) {
  const list = (rows || []).filter((r) => passFilter(r.url));
  if (!rows || !rows.length) return '';
  if (!list.length) return `<h2 class="src-head">${esc(title)}</h2><p class="hint" style="margin-top:12px">这一类里的 ${rows.length} 条都被筛掉了（当前筛选：${S.filter === 'unread' ? '未读' : '已收藏'}）。</p>`;
  const shown = list.length > cap ? list.slice(0, cap) : list;
  return `<h2 class="grp-head">${esc(title)}
    <span class="hint">${esc(note || list.length + ' 条')}</span></h2>
    ${shown.map(rowFn).join('')}
    ${list.length > cap ? `<p class="hint" style="margin-top:14px">共 ${list.length} 条，这里只按顺序显示前 ${cap} 条。想找更早的用 <kbd>Ctrl K</kbd> 搜，或点上面的时间范围收窄。</p>` : ''}`;
}

/** skills.sh 榜单的一行：名次看安装量，右列是本周增量，下面直接给装法 */
function regRow(s) {
  const url = s.url || `https://www.skills.sh/${s.source}/${s.skill_id}`;
  const wk = s.week_delta;
  return `<div class="repo${rtClass(url)}" data-nav="skill" data-url="${esc(url)}">
    <a class="repo-name" href="${esc(url)}" data-ext="1" data-url="${esc(url)}">${esc(s.name)}</a>
    <div class="num">${shortNum(s.installs)}<span>安装</span></div>
    <div class="num${wk > 0 ? ' hot' : ''}">${typeof wk === 'number' ? (wk > 0 ? '+' : '') + shortNum(wk) : '—'}<span>周增</span></div>
    ${saveBtn({ url, title: s.name, kind: 'skill', date: S.date })}
    <p class="repo-desc">${esc(s.source)}${s.official ? ' · 官方' : ''}${typeof s.install_24h === 'number' ? ` · 24h ${s.install_24h > 0 ? '+' : ''}${shortNum(s.install_24h)}` : ''}</p>
    <div class="repo-tag"><code class="cmd-code">${esc(s.cmd)}</code><button class="mini" type="button" data-act="copy-cmd" data-cmd="${esc(s.cmd)}">复制装法</button><button class="mini skilldoc-btn" type="button" data-act="skill-doc" data-source="${esc(s.source)}" data-id="${esc(s.skill_id || s.name)}">说明书</button></div>
  </div>`;
}

/* ------------------------------------------------- 原始雷达的时间范围 */

const RANGES = [
  ['today', '今日'],
  ['d7', '近一周'],
  ['m1', '近一个月'],
  ['m3', '近三个月'],
  ['all', '有史以来'],
];

/** 时间范围不是「今日」时，雷达换成跨天合并后的数据。 */
const dataFor = () => (S.range === 'today' ? S.data : S.agg);

function rangeNote(d) {
  if (S.range === 'today') return `${S.date} 的采集快照`;
  if (S.aggBusy) return '正在合并…';
  if (!d || !d.__days) return '这段时间没有记录';
  const arch = d.__arch || 0;
  const tail = arch ? ` · 档案 ${arch} 条 + 采集 ${d.__days} 天` : ` · 合并 ${d.__days} 天`;
  return `${d.__from} → ${d.__to}${tail}`;
}

const aggId = (k) => k;

async function loadAgg(k) {
  S.aggBusy = true;
  S.agg = null;
  renderView();
  try {
    const r = await api.radarRange({ range: k });
    const empty = { github: {}, models: {}, news: [], papers: [], hn: [] };
    S.agg = {
      ...(r?.data || empty),
      __days: r?.days || 0,
      __from: r?.from || '',
      __to: r?.to || '',
      __arch: (r?.archive?.repos || 0) + (r?.archive?.models || 0),
    };
    S.aggKey = aggId(k);
  } catch (e) {
    S.agg = null;
    S.aggKey = '';
    toast('合并历史数据失败：' + e.message, true);
  }
  S.aggBusy = false;
  renderView();
}

async function setRange(k) {
  if (S.range === k && S.aggKey === aggId(k)) return;
  S.range = k;
  if (k === 'today') { S.agg = null; renderView(); return; }
  if (S.aggKey !== aggId(k)) await loadAgg(k);
  renderView();
}

function renderRadar(host) {
  const d = dataFor();
  if (S.range !== 'today' && S.aggKey !== aggId(S.range) && !S.aggBusy) loadAgg(S.range);
  if (!d) {
    if (S.range !== 'today') {
      host.innerHTML = S.aggBusy
        ? `<div class="empty"><h1>正在合并历史数据…</h1></div>`
        : `<div class="empty"><h1>这段时间没有数据</h1><p>采集过几天之后才有可合并的内容。</p></div>`;
      return;
    }
    host.innerHTML = `<div class="empty"><h1>没有 ${esc(S.date)} 的数据</h1><p>先采集一次。</p></div>`;
    return;
  }
  const tabs = [
    ['frontier', '前沿', (d.frontier?.today?.length || 0)],
    ['new', '新星', d.github?.new_repos?.length || 0],
    ['active', '高星活跃', d.github?.active?.length || 0],
    ['ai', 'AI 项目', d.github?.ai_new?.length || 0],
    ['skills', '技能', d.skills?.total || 0],
    ['models', '模型', (d.models?.openrouter_new?.length || 0) + (d.models?.ollama_new?.length || 0)],
    ['news', '新闻', d.news?.length || 0],
    ['papers', '论文', d.papers?.length || 0],
    ['hn', 'HN', d.hn?.length || 0],
    ['soc', '社区', (d.bilibili?.items?.length || 0) + (d.zhihu?.items?.length || 0)],
  ];
  let body = '';

  if (S.radarTab === 'frontier') {
    body = renderFrontierBody(d);
  } else if (S.radarTab === 'new') {
    body = group(S.range === 'today' ? '本周新建，按出道以来日均 ★ 排' : '窗口内新建，按出道以来日均 ★ 排', d.github?.new_repos) || emptyNote();
  } else if (S.radarTab === 'active') {
    body = group('高星且有提交', d.github?.active, '长期热门，看趋势不看热闹') || emptyNote();
  } else if (S.radarTab === 'ai') {
    body = group(S.range === 'today' ? '近 30 天的 AI / agent / LLM 项目' : '窗口内的 AI / agent / LLM 项目', d.github?.ai_new) || emptyNote();
  } else if (S.radarTab === 'skills') {
    const sk = d.skills || { total: 0, groups: [] };
    const sh = d.skills_sh || {};
    const lead = `<p class="hint" style="margin-top:18px;max-width:60ch">给 agent 用的可复用能力包（SKILL.md、rules、prompt pack 一类），
      按它作用的 agent 分组——同一个技能写成 Claude Code 的 SKILL.md 还是 Cursor 的 rules，装法完全不同。
      共 ${num(sk.total || 0)} 个${sh.total ? `，其中 ${num(sh.total)} 个来自 <a href="https://www.skills.sh/" data-ext="1" data-url="https://www.skills.sh/">skills.sh</a> 的安装榜` : ''}。
      这些 agent 本身怎么装，看 <button class="mini" type="button" data-act="goto-agents">安装 agent</button>。</p>`;
    body = sk.groups.length
      ? sk.groups.map((g) => (g.key === 'skills.sh'
        ? group(g.label, g.items, `— ${g.note} · ${g.items.length} 个`, 200, regRow)
        : group(g.label, g.items, `— ${g.note} · ${g.items.length} 个`))).join('')
      : '';
    body = lead + envStrip() + (body || emptyNote());
    void (async () => { const had = !!S.sdoc.env; await ensureSkillEnv(); if (!had && S.sdoc.env) renderView(); })();
  } else if (S.radarTab === 'models') {
    const or = (d.models?.openrouter_new || [])
      .map((m) => ({ m, url: `https://openrouter.ai/${m.id}` }))
      .filter(({ m, url }) => passFilter(url));
    const ol = (d.models?.ollama_new || [])
      .map((m) => ({ m, url: `https://ollama.com/library/${m.name}` }))
      .filter(({ url }) => passFilter(url));
    body = (or.length ? `<h2 class="grp-head">OpenRouter 新上架</h2>
      ${or.map(({ m, url }) => `<div class="repo${rtClass(url)}" data-nav="link" data-url="${esc(url)}" data-title="${esc(m.name || m.id)}">
        <a class="repo-name" href="${esc(url)}" data-ext="1" data-url="${esc(url)}">${esc(m.name || m.id)}</a>
        <div class="num">${ctxText(m.context)}<span>上下文</span></div>
        <div class="num">${esc(priceText(m.prompt_price, m.completion_price))}<span>$/Mtok</span></div>
        ${ucBtn({ url, title: m.name || m.id, desc: m.id }, 'model')}${saveBtn({ url, title: m.name || m.id, kind: 'model', date: m.last_seen || S.date })}
        <p class="repo-desc">${esc(m.id)}</p>
        <div class="repo-tag">${m.modality ? `<span>${esc(m.modality)}</span>` : ''}<span>${esc(m.created || '')}</span>${S.range !== 'today' && m.last_seen ? `<span>最近 ${esc(String(m.last_seen).slice(5))} 出现</span>` : ''}</div>
      </div>`).join('')}` : '');
    body += (ol.length ? `<h2 class="grp-head">Ollama 新模型</h2>
      ${ol.map(({ m, url }) => `<div class="repo${rtClass(url)}" data-nav="link" data-url="${esc(url)}" data-title="${esc(m.name)}">
        <a class="repo-name" href="${esc(url)}" data-ext="1" data-url="${esc(url)}">${esc(m.name)}</a>
        <div class="num">${esc((m.caps || []).join(' '))}<span>能力</span></div>
        ${ucBtn({ url, title: m.name, desc: m.desc }, 'model')}${saveBtn({ url, title: m.name, kind: 'model', date: m.last_seen || S.date })}
        <p class="repo-desc">${esc(m.desc || '')}</p>
      </div>`).join('')}` : '');
    if (!body) body = emptyNote();
  } else if (S.radarTab === 'news') {
    const news = (d.news || []).filter((n) => passFilter(n.link));
    const bySrc = new Map();
    for (const n of news) {
      const k = n.source || '其他';
      if (!bySrc.has(k)) bySrc.set(k, []);
      bySrc.get(k).push(n);
    }
    const groups = [...bySrc.entries()].sort((a, b) => b[1].length - a[1].length);
    body = groups.map(([src, items]) => `<h2 class="src-head">${esc(src)}</h2>
      ${items.map((n) => `<div class="row${rtClass(n.link)}" data-nav="link" data-url="${esc(n.link)}" data-title="${esc(n.title)}">
        ${n.date ? `<div class="row-src">${esc(n.date)}</div>` : ''}
        <h3 class="row-title"><a href="${esc(n.link)}" data-ext="1" data-url="${esc(n.link)}">${esc(n.title)}</a>${transBtn(n.link, n.title)}</h3>
        ${n.summary ? `<p class="row-sum">${esc(n.summary)}</p>` : ''}
        ${transOf(n.link) && transOf(n.link).show ? `<p class="row-sum zh">${esc(transOf(n.link).zh)}</p>` : ''}
        ${ucBtn({ url: n.link, title: n.title, desc: n.summary, source: n.src }, 'news')}${saveBtn({ url: n.link, title: n.title, kind: 'news', date: n.last_seen || S.date })}
      </div>`).join('')}`).join('') || emptyNote();
  } else if (S.radarTab === 'papers') {
    body = (d.papers || []).filter((p) => passFilter(p.link)).map((p) => `<div class="row${rtClass(p.link)}" data-nav="link" data-url="${esc(p.link)}" data-title="${esc(p.title)}">
      <div class="row-src">arXiv${p.date ? ' · ' + esc(p.date) : ''}</div>
      <h3 class="row-title"><a href="${esc(p.link)}" data-ext="1" data-url="${esc(p.link)}">${esc(p.title)}</a>${transBtn(p.link, p.title)}</h3>
      ${p.summary ? `<p class="row-sum">${esc(p.summary)}</p>` : ''}
      ${transOf(p.link) && transOf(p.link).show ? `<p class="row-sum zh">${esc(transOf(p.link).zh)}</p>` : ''}
      ${ucBtn({ url: p.link, title: p.title, desc: p.summary }, 'paper')}${saveBtn({ url: p.link, title: p.title, kind: 'paper', date: p.last_seen || S.date })}
    </div>`).join('') || emptyNote();
  } else if (S.radarTab === 'hn') {
    body = (d.hn || []).filter((h) => passFilter(h.url || h.hn)).map((h) => `<div class="row${rtClass(h.url || h.hn)}" data-nav="link" data-url="${esc(h.url || h.hn)}" data-title="${esc(h.title)}">
      <div class="row-src">Hacker News</div>
      <h3 class="row-title"><a href="${esc(h.url || h.hn)}" data-ext="1" data-url="${esc(h.url || h.hn)}">${esc(h.title)}</a>${transBtn(h.url || h.hn, h.title)}</h3>
      ${transOf(h.url || h.hn) && transOf(h.url || h.hn).show ? `<p class="row-sum zh">${esc(transOf(h.url || h.hn).zh)}</p>` : ''}
      <div class="row-meta">${num(h.points)} pts · ${num(h.comments)} 条评论 · <a href="${esc(h.hn)}" data-ext="1">讨论</a></div>
      ${ucBtn({ url: h.url || h.hn, title: h.title, desc: h.title }, 'hn')}${saveBtn({ url: h.url || h.hn, title: h.title, kind: 'hn', date: h.last_seen || S.date })}
    </div>`).join('') || emptyNote();
  } else if (S.radarTab === 'soc') {
    const bi = (d.bilibili?.items || []).filter((v) => passFilter(v.url));
    const zh = (d.zhihu?.items || []).filter((z) => passFilter(z.url));
    const lead = '<p class="hint keep" style="margin-top:18px;max-width:64ch">这两个源不是技术事实，是「普通人怎么用、怎么想」。' +
      'B站按播放量挑（说明路人也点进来看了，中文教程讲到了哪一步最直观）；' +
      '知乎取热榜里跟 AI 沾边的（多是疑问和情绪，能看出大家在怕什么、想要什么）。</p>';
    const head = (t, note) =>
      `<h2 class="src-head">${esc(t)}<span class="hint" style="margin-left:10px;font-weight:400">${esc(note)}</span></h2>`;
    const biRows = bi.map((v) => `<div class="row${rtClass(v.url)}" data-nav="link" data-url="${esc(v.url)}" data-title="${esc(v.title)}">
      <div class="row-src">B站 · ${esc(v.why || '')}${v.date ? ' · ' + esc(v.date) : ''}</div>
      <h3 class="row-title"><a href="${esc(v.url)}" data-ext="1" data-url="${esc(v.url)}">${esc(v.title)}</a></h3>
      <div class="row-meta">${esc(v.author || '')}${v.play ? ' · ' + shortNum(v.play) + ' 播放' : ''}${v.danmaku ? ' · ' + shortNum(v.danmaku) + ' 弹幕' : ''}${v.tname ? ' · ' + esc(v.tname) : ''}</div>
      ${ucBtn({ url: v.url, title: v.title, desc: v.why, source: v.author }, 'video')}${saveBtn({ url: v.url, title: v.title, kind: 'video', date: v.date || v.last_seen || S.date })}
    </div>`).join('');
    const zhRows = zh.map((z) => `<div class="row${rtClass(z.url)}" data-nav="link" data-url="${esc(z.url)}" data-title="${esc(z.title)}">
      <div class="row-src">知乎热榜${z.heat ? ' · ' + esc(z.heat) : ''}${z.last_seen ? ' · ' + esc(String(z.last_seen).slice(5)) : ''}</div>
      <h3 class="row-title"><a href="${esc(z.url)}" data-ext="1" data-url="${esc(z.url)}">${esc(z.title)}</a></h3>
      ${ucBtn({ url: z.url, title: z.title, desc: z.heat }, 'zhihu')}${saveBtn({ url: z.url, title: z.title, kind: 'zhihu', date: z.last_seen || S.date })}
    </div>`).join('');
    body = lead +
      (bi.length ? head('B站', `${bi.length} 条`) + biRows : '') +
      (zh.length ? head('知乎', `${zh.length} 条`) + zhRows : '') ||
      emptyNote();
    if (!bi.length && !zh.length) body = lead + emptyNote();
  }

  host.innerHTML = `
    ${stampLine()}
    <div class="radar-head" style="margin-top:22px"><h1>原始雷达</h1><span class="count">采集器原样输出，没有任何判断</span></div>
    <div class="tabs">${tabs.map(([k, label, n]) =>
      `<button class="tab${S.radarTab === k ? ' is-on' : ''}" data-tab="${k}">${label} ${n ? `<span class="hint" style="margin-left:4px">${n}</span>` : ''}</button>`
    ).join('')}</div>
    <div class="chips rangebar">
      <span class="rlabel">时间</span>
      ${RANGES.map(([k, label]) =>
        `<button class="chip${S.range === k ? ' is-on' : ''}" data-range="${k}">${label}</button>`).join('')}
      <span class="hint chips-note">${esc(rangeNote(d))}</span>
    </div>
    <div class="chips">
      ${[['all', '全部'], ['unread', '未读'], ['saved', '已收藏']].map(([k, label]) =>
        `<button class="chip${S.filter === k ? ' is-on' : ''}" data-filter="${k}">${label}</button>`).join('')}
      <button class="chip${S.tr.busy ? ' is-on' : ''}" data-act="trans-all" title="把这一栏里的英文标题翻成中文；翻过的会记住，不重复花钱">${S.tr.busy ? '译中…' : '译这一栏'}</button>
      <span class="hint chips-note">${num(Object.keys(S.aux.read).length)} 条已读 · ${num(Object.keys(S.aux.bookmarks).length)} 条收藏</span>
    </div>
    ${summaryBlock()}
    <div class="radar-body">${body}</div>`;
}

/* ------------------------------------------------------- 前沿动态：AI 又能做什么了 */

const FR_STATUS = {
  ga: { label: '正式可用', note: '模型或工具已上架，现在就能用' },
  beta: { label: '开放测试', note: '能申请或试用，接口和价格还可能变' },
  code: { label: '有开源实现', note: '代码能跑，但要自己配环境' },
  demo: { label: '已有演示', note: '能看到效果，还拿不到成品' },
  paper: { label: '论文提出', note: '只有论文结论，别人还没复现' },
};

function frChip(x) {
  const st = FR_STATUS[x.status] || FR_STATUS.paper;
  return `<span class="frst ${esc(x.status || 'paper')}" title="${esc(st.note)}">${esc(x.status_label || st.label)}</span>`;
}

function frLinks(x) {
  const out = [];
  if (x.arxiv) out.push(`<a href="${esc(x.arxiv)}" data-ext="1" data-url="${esc(x.arxiv)}">论文</a>`);
  if (x.repo) out.push(`<a href="${esc(x.repo)}" data-ext="1" data-url="${esc(x.repo)}">代码</a>`);
  if (x.project) out.push(`<a href="${esc(x.project)}" data-ext="1" data-url="${esc(x.project)}">演示</a>`);
  if (!out.length && x.hf) out.push(`<a href="${esc(x.hf)}" data-ext="1" data-url="${esc(x.hf)}">HF 页面</a>`);
  return out.join('<span class="sep">·</span>');
}

function frItem(x) {
  const text = x.ai_summary || x.summary || '';
  const url = x.hf || x.arxiv || '';
  const tr = transOf(url);
  const meta = [];
  if (x.upvotes) meta.push(`${num(x.upvotes)} 赞`);
  if (x.stars) meta.push(`${num(x.stars)} 星`);
  if (x.published) meta.push(esc(x.published));
  return `<div class="fritem${rtClass(url)}" data-nav="link" data-url="${esc(url)}" data-title="${esc(x.title)}">
    <div class="fri-head">${frChip(x)}<h3 class="row-title">${x.hf
      ? `<a href="${esc(x.hf)}" data-ext="1" data-url="${esc(x.hf)}">${esc(x.title)}</a>`
      : esc(x.title)}${transBtn(url, text || x.title)}</h3></div>
    <p class="fri-cando">${esc(x.can_do || '')}</p>
    ${text ? `<p class="row-sum">${esc(text)}</p>` : ''}
    ${tr && tr.show ? `<p class="row-sum zh">${esc(tr.zh)}</p>` : ''}
    ${(x.keywords || []).length
      ? `<div class="frkw">${x.keywords.slice(0, 5).map((k) => `<span>${esc(k)}</span>`).join('')}</div>`
      : ''}
    <div class="fri-foot"><span class="frmeta">${meta.join(' · ')}</span>${frLinks(x)}
      ${ucBtn({ url, title: x.title, desc: text }, 'paper')}${saveBtn({ url, title: x.title, kind: 'frontier', date: x.published || S.date })}</div>
  </div>`;
}

function frWeekRow(c) {
  return `<div class="frweek${rtClass(c.url)}" data-nav="link" data-url="${esc(c.url)}" data-title="${esc(c.title)}">
    <span class="frw-what">${esc(c.what || '')}</span>
    <div class="frw-body">
      <h3 class="row-title"><a href="${esc(c.url)}" data-ext="1" data-url="${esc(c.url)}">${esc(c.title)}</a></h3>
      <p class="row-sum">${esc(c.detail || '')}</p>
    </div>
  </div>`;
}

/** 用户记下的需求的全部关键词（小写），用来判断「这条跟我有没有关系」 */
function profileWords() {
  const p = (S.chat && S.chat.profile) || null;
  const out = [];
  for (const n of (p && p.needs) || []) {
    for (const k of n.keywords || []) if (k) out.push(String(k).toLowerCase());
  }
  const sum = p && p.project && p.project.summary;
  if (sum) out.push(String(sum).toLowerCase());
  return out;
}

function frOffInterest(items) {
  const words = profileWords();
  if (!words.length) return [];
  return items
    .filter((x) => {
      const hay = `${x.title} ${x.summary || ''} ${(x.keywords || []).join(' ')}`.toLowerCase();
      return !words.some((w) => w && hay.includes(w));
    })
    .slice(0, 4);
}

function renderFrontierBody(d) {
  const f = d.frontier || { today: [], week: [], items: [] };
  const lead = `<p class="hint keep" style="margin-top:18px;max-width:66ch">
    这一栏只回答一件事：<b>AI 又能做什么了</b>。每条都标了「到哪一步了」——只有论文 / 有演示 / 有代码 / 开放测试 / 正式可用，
    以及和之前比变了什么。HF 的点赞数只说明多少人收藏了，不代表效果好；有代码或演示的排在前面。
    来源 <a href="https://huggingface.co/papers" data-ext="1" data-url="https://huggingface.co/papers">HF Daily Papers</a>（经镜像抓取，本机直连不到）。</p>`;
  const today = (f.today || []).filter((x) => passFilter(x.hf || x.arxiv));
  const week = (f.week || []).slice(0, 8);
  const all = (f.items || []).filter((x) => passFilter(x.hf || x.arxiv));
  const off = frOffInterest((f.items || []).slice(0, 40));
  // 没记下需求时没法判断「无关」：退一步给今天热度最高、但没进「今天值得知道」的几条
  const hasProfile = profileWords().length > 0;
  const offList = hasProfile
    ? off
    : (f.items || []).filter((x) => !today.some((t) => (t.id || t.title) === (x.id || x.title))).slice(0, 3);

  let body = lead;
  body += `<h2 class="fr-h">今天值得知道<small>${today.length} 条 · 少而重要，一句话说清发生了什么</small></h2>`;
  body += today.length ? today.map(frItem).join('') : emptyNote();

  body += `<h2 class="fr-h">本周能力变化<small>${week.length} 条 · 更便宜了、更长了、或者本地能跑了</small></h2>`;
  body += week.length
    ? week.map(frWeekRow).join('')
    : '<p class="hint keep">还没有对比基线：要两天以上的模型快照才看得出降价和上下文变化，明天再来。</p>';

  if (offList.length) {
    body += `<h2 class="fr-h">和你现在做的事无关，但值得知道<small>${offList.length} 条</small></h2>
      <p class="hint keep">${hasProfile
        ? '这些和你的需求对不上——正因为对不上，才可能给你新用途。'
        : '还没记下你的项目与需求，所以这里是今天热度最高、但没进「今天值得知道」的几条。去「对话」说一句你在做什么，这块就能按你的需求筛。'}</p>`;
    body += offList.map(frItem).join('');
  }

  const shown = new Set([...today, ...offList].map((x) => x.id || x.title));
  const rest = all.filter((x) => !shown.has(x.id || x.title));
  body += `<h2 class="fr-h">深入了解<small>${rest.length} 条 · 论文 / 代码 / 演示 / 评测，按「能做到哪一步」排</small></h2>`;
  let deep = '';
  for (const st of ['ga', 'beta', 'code', 'demo', 'paper']) {
    const items = rest.filter((x) => x.status === st);
    if (!items.length) continue;
    const meta = FR_STATUS[st] || { label: st, note: '' };
    deep += `<h3 class="src-head">${esc(meta.label)}<span class="hint" style="margin-left:10px;font-weight:400">${esc(meta.note)} · ${items.length} 条</span></h3>`;
    deep += items.slice(0, 8).map(frItem).join('');
  }
  body += deep || '<p class="hint keep">今天的论文还没抓到，或都已列在上面。</p>';
  return body;
}

/** 把当前栏里还没翻的英文条目按顺序翻掉（最多 8 条，翻译会缓存，不重复花钱） */
async function transAll() {
  if (S.tr.busy) return;
  const rows = [...document.querySelectorAll('#view .row-title a[href], #view .fritem, #view [data-nav]')];
  const todo = [];
  for (const el of rows) {
    const holder = el.closest('[data-url]') || el;
    const url = holder.getAttribute('data-url') || el.getAttribute('href') || '';
    if (!url || S.trans[url]) continue;
    const t = (el.textContent || '').trim();
    if (!t || !/[A-Za-z]{12,}/.test(t)) continue;
    todo.push({ url, text: t.slice(0, 400) });
    if (todo.length >= 8) break;
  }
  if (!todo.length) { toast('这一栏没有需要翻译的英文了。'); return; }
  S.tr.busy = true;
  try {
    for (const t of todo) {
      const r = await api.transOne(t.text);
      if (r.ok && r.zh) S.trans[t.url] = { zh: r.zh, show: true };
      else if (r.needKey) { toast('先在设置里填 API key，才能让它翻译。', true); break; }
    }
  } catch (e) {
    toast('翻译失败：' + (e.message || e), true);
  } finally {
    S.tr.busy = false;
    renderView();
  }
}

const emptyNote = () => (S.range === 'today'
  ? '<p class="hint keep" style="margin-top:26px">这一类今天没抓到东西，可能该源失败。</p>'
  : '<p class="hint keep" style="margin-top:26px">这一类在所选时间范围里没抓到东西。</p>');

function renderHistory(host) {
  const rows = S.state.dates || [];
  const idx = S.index || {};
  host.innerHTML = `${stampLine()}
    <div class="radar-head" style="margin-top:22px"><h1>历史</h1><span class="count">${rows.length} 天</span></div>
    <div style="margin-top:22px">${rows.map((r) => `<button class="hrow" data-date="${esc(r.date)}">
      <span class="hdate">${esc(r.date)}</span>
      <span class="hdesc">${esc(idx[r.date] || (r.digest ? '—' : '只有原始数据'))}</span>
      <span class="hmark">${r.digest ? '<span class="on">简报</span>' : '原始'}</span>
    </button>`).join('') || '<p class="hint keep">还没有任何记录。先采集一次。</p>'}</div>`;
}

function archiveLine() {
  const a = S.state.archive || {};
  if (!a.exists) return '还没有档案，点右边抓一次';
  const d = new Date(a.generatedAt);
  const when = isNaN(d) ? String(a.generatedAt || '').slice(0, 10) : d.toLocaleDateString('sv-SE');
  return `${num(a.repos)} 个仓库 · ${num(a.models)} 个模型 · ${when} 生成`;
}

const SKILL_LABEL = {
  claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot',
  gemini: 'Gemini', deepseek: 'DSH', editor: '其它编辑器', generic: '通用格式',
};

async function ensureConcepts() {
  if (S.concepts !== undefined) return S.concepts;
  try { S.concepts = await api.concepts(); } catch (e) { S.concepts = null; }
  return S.concepts;
}

function scrollToConcept(id) {
  const el = document.getElementById('c-' + id);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.add('is-hit');
  setTimeout(() => el.classList.remove('is-hit'), 1400);
}

function scrollToGroup(gid) {
  const el = document.getElementById('g-' + gid);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.add('is-hit');
  setTimeout(() => el.classList.remove('is-hit'), 1400);
}


/* ───────────── 翻译（中英双向） ───────────── */

const TR_LANG = { zh: '简体中文', en: 'English' };

function renderTrans(host) {
  const dir = S.tr.to === 'zh' ? '英 → 中' : '中 → 英';
  host.innerHTML = `
    <div class="stamp">${esc(S.date)} · 双向翻译</div>
    <h1 class="h-title">翻译<small>中英互译，翻过的会记住，不重复花钱</small></h1>
    <p class="hint keep">粘一段英文（项目简介、论文摘要、官方公告）或一段中文（给外国人看的说明、要发出去的邮件），
      翻完直接复制。Markdown、代码和链接会原样保留；专有名词不硬翻。</p>
    <div class="trbar">
      <div class="seg" role="group">
        <button class="segbtn${S.tr.to === 'zh' ? ' on' : ''}" type="button" data-act="tr-dir" data-to="zh">英 → 中</button>
        <button class="segbtn${S.tr.to === 'en' ? ' on' : ''}" type="button" data-act="tr-dir" data-to="en">中 → 英</button>
      </div>
      <span class="trhint">${dir} · 一次最多 12000 字符</span>
    </div>
    <textarea class="trin" id="trIn" placeholder="${S.tr.to === 'zh' ? 'Paste English here…' : '把中文粘在这里…'}" spellcheck="false"></textarea>
    <div class="tractions">
      <button class="btn dark" type="button" data-act="tr-run">${S.tr.busy ? '翻…' : '开始翻译'}</button>
      <button class="btn" type="button" data-act="tr-clear">清空</button>
      <span class="trhint" id="trMeta">${trMeta()}</span>
    </div>
    ${S.tr.err ? `<p class="sdoc-err">${esc(S.tr.err)}</p>` : ''}
    ${S.tr.out ? `
      <div class="trout">
        <div class="trout-head">
          <span class="tlabel">译文 · ${TR_LANG[S.tr.to]}</span>
          <button class="mini" type="button" data-act="tr-copy">复制译文</button>
        </div>
        <div class="prose" id="trOut">${renderMarkdown(S.tr.out)}</div>
      </div>` : ''}
  `;
  const ta = host.querySelector('#trIn');
  if (ta && S.tr.input) ta.value = S.tr.input;
}

function trMeta() {
  const n = (S.tr.input || '').length;
  if (!n) return '还没输入';
  if (S.tr.busy) return `${n} 字符 · 正在翻…`;
  if (S.tr.cached && S.tr.out) return `${n} 字符 · 命中缓存，没花钱`;
  if (S.tr.out) return `${n} 字符 · 用时 ${(S.tr.ms / 1000).toFixed(1)} 秒`;
  return `${n} 字符`;
}

async function runTrans() {
  const text = String(S.tr.input || '').trim();
  if (!text) { toast('先粘一段要翻的文字。'); return; }
  S.tr.busy = true;
  S.tr.out = '';
  S.tr.err = '';
  renderView();
  const t0 = Date.now();
  const r = await api.transText({ text, to: S.tr.to, from: S.tr.to === 'zh' ? 'en' : 'zh', id: 'tr' });
  S.tr.busy = false;
  S.tr.ms = Date.now() - t0;
  if (!r.ok) {
    S.tr.err = r.needKey ? '还没填 API key：去「设置」填一个就能翻。' : r.error || '翻译失败';
    if (r.needKey) { toast('先去设置填 API key。'); }
    renderView();
    return;
  }
  S.tr.out = r.text;
  S.tr.cached = !!r.cached;
  renderView();
  if (r.cached) toast('这段之前翻过，直接用缓存，没花钱。');
}

/* ───────────── 这对我有什么用 ───────────── */

function findItem(url, kind) {
  const pools = [];
  const d = S.data || {};
  if (d.github) pools.push(d.github.new_repos, d.github.active, d.github.ai_new, d.github.velocity);
  if (d.models) pools.push(d.models.openrouter_new, d.models.ollama_new);
  pools.push(d.news, d.papers, d.hn, d.bilibili && d.bilibili.items, d.zhihu && d.zhihu.items);
  if (S.agg && S.agg.data) {
    const a = S.agg.data;
    if (a.github) pools.push(a.github.new_repos, a.github.active, a.github.ai_new);
    if (a.models) pools.push(a.models.openrouter_new, a.models.ollama_new);
    pools.push(a.news, a.papers, a.hn, a.bilibili && a.bilibili.items, a.zhihu && a.zhihu.items);
  }
  for (const p of pools) {
    for (const it of p || []) {
      if (!it) continue;
      const u = it.url || it.html_url || it.link || it.hn || '';
      if (u && u === url) return decorate(it, kind);
    }
  }
  return null;
}

/** 把采集字段的不同命名统一成用途卡要的形状（news 用 link/summary，video 用 author/play…） */
function decorate(it, kind) {
  const out = { ...it, kind: kind || it.kind || 'news' };
  out.url = it.url || it.html_url || it.link || it.hn || '';
  out.title = it.title || it.full_name || it.name || it.id || out.url;
  out.desc = it.desc || it.summary || it.why || '';
  out.published = it.published || it.date || it.created || '';
  out.source = it.source || it.src || it.author || it.owner || '';
  if (item_url_like_model(out)) out.kind = out.kind || 'model';
  return out;
}

function item_url_like_model(it) {
  const u = String(it.url || '');
  return u.includes('openrouter.ai') || u.includes('/library/') || it.prompt_price != null;
}

async function openUsecase(url, kind) {
  const item = findItem(url, kind) || { url, title: url, kind: kind || 'news' };
  S.uc.open = true;
  S.uc.busy = true;
  S.uc.item = item;
  S.uc.data = null;
  S.uc.err = '';
  S.uc.followed = false;
  S.uc.kindLabel = ({ repo: '项目', model: '模型', news: '新闻', paper: '论文', hn: 'HN', video: 'B站', zhihu: '知乎' }[item.kind]) || '资讯';
  renderUsecase();
  try {
    const r = await api.usecase(item);
    S.uc.data = r;
  } catch (e) {
    S.uc.err = String(e.message || e);
  }
  S.uc.busy = false;
  renderUsecase();
}

function closeUsecase() {
  S.uc.open = false;
  const el = document.getElementById('ucard');
  if (el) {
    el.classList.remove('is-open');
    setTimeout(() => { if (!S.uc.open) el.hidden = true; }, 180);
  }
}

function renderUsecase() {
  const el = document.getElementById('ucard');
  if (!el) return;
  const box = el.querySelector('.sdoc-box');
  const d = S.uc.data;
  const it = S.uc.item || {};
  if (!S.uc.open) return;
  el.hidden = false;
  const ev = (d && d.evidence) || { label: '', note: '', type: '' };
  const src = (d && d.source) || {};
  const cu = (d && d.canUse) || {};
  const chip = (label, v, ok) => `<span class="ucchip${ok === true ? ' on' : ok === false ? ' off' : ''}">${esc(label)}：${esc(v || '未标注')}</span>`;
  box.innerHTML = `
    <div class="sdoc-head">
      <div>
        <h2 class="sdoc-title">${esc(it.title || '')}</h2>
        <div class="sdoc-src">
          ${esc(S.uc.kindLabel || '')}
          ${src.host ? ` · <a href="#" data-ext="1" data-url="${esc(src.url)}">${esc(src.host)}</a>` : ''}
          ${src.published ? ` · 发布 ${esc(src.published)}` : ''}
          · 核实 ${esc(src.verified || S.date)}
        </div>
      </div>
      <button class="sdoc-x" type="button" data-act="uc-close" aria-label="关闭">×</button>
    </div>
    <div class="ucev ucev-${esc(ev.type || 'report')}">
      <strong>${esc(ev.label || '来源')}</strong><span>${esc(ev.note || '')}</span>
    </div>
    ${S.uc.busy ? '<p class="sdoc-note">正在读这条…</p>' : ''}
    ${S.uc.err ? `<p class="sdoc-err">${esc(S.uc.err)}</p>` : ''}
    ${d ? `
      <section class="sdoc-sec"><h3><span class="sdoc-no">1</span>发生了什么</h3>
        <p class="sdoc-lead">${esc(d.what || it.desc || '')}</p>
      </section>
      <section class="sdoc-sec"><h3><span class="sdoc-no">2</span>对哪些人有用</h3>
        <p class="sdoc-lead">${esc(d.audience || '还没法判断：材料里没说清用途。')}</p>
      </section>
      <section class="sdoc-sec"><h3><span class="sdoc-no">3</span>我现在能否使用</h3>
        <div class="ucchips">
          ${chip('费用', cu.cost, d.local && d.local.cost && d.local.cost.ok)}
          ${chip('门槛', cu.barrier, null)}
          ${chip('中文', cu.chinese, d.local && d.local.chinese && d.local.chinese.ok)}
          ${chip('条件', cu.condition, null)}
        </div>
        <p class="sdoc-note">这四项取自采集到的字段（价格、上下文、语言、播放量…）；没有的写「未标注」，不猜。</p>
      </section>
      <section class="sdoc-sec"><h3><span class="sdoc-no">4</span>从哪里开始</h3>
        <p class="sdoc-lead">${esc(d.start || '先看原文，别急着用。')}</p>
      </section>
    ` : ''}
    <div class="sdoc-actions">
      ${d && d.templateId
        ? `<button class="btn dark" type="button" data-act="uc-try" data-tpl="${esc(d.templateId)}">试试看</button>
           <span class="sdoc-note">用「${esc(tplTitle(d.templateId))}」这个模板，填两格就能开工。</span>`
        : `<button class="btn" type="button" data-act="uc-follow" ${S.uc.followed ? 'disabled' : ''}>${S.uc.followed ? '已关注' : '关注后续'}</button>
           <span class="sdoc-note">这条暂时没有能直接上手的模板；关注后，等它有可用形态时我会在周报里提。</span>`}
      ${it.url ? `<button class="btn" type="button" data-act="uc-open" data-url="${esc(it.url)}">打开原文</button>` : ''}
    </div>
    ${d && !d.generated ? '<p class="sdoc-note">没填 API key：上面四段是按采集字段拼的，没做模型总结。</p>' : ''}
  `;
  requestAnimationFrame(() => el.classList.add('is-open'));
}

function tplTitle(id) {
  const lib = S.tplLib;
  const t = lib && (lib.templates || []).find((x) => x.id === id);
  return t ? t.title : id;
}

/* ───────────── 简报：译成英文 ───────────── */

async function digestToEn() {
  const raw = S.digest;
  const text = typeof raw === 'string' ? raw : (raw && raw.body) || '';
  if (!text.trim()) return;
  if (S.digestEn[S.date]) { toast('这一天的英文版已经有了，往下翻。'); return; }
  const r = await withJob('digest-en', '正在把简报翻成英文', { en: 'Translate', expect: 30, step: '长文要一会儿' },
    () => api.transText({ text, to: 'en', from: 'zh', id: 'digest-en' }));
  if (!r.ok) {
    toast(r.needKey ? '先去设置填 API key。' : (r.error || '翻译失败'), true);
    return;
  }
  S.digestEn[S.date] = r.text;
  renderView();
  toast('译好了，在简报下面。');
}

function digestEnBlock() {
  const en = S.digestEn[S.date];
  if (!en) return '';
  return `<details class="digest-en" open>
    <summary>English version</summary>
    <div class="prose">${renderMarkdown(en)}</div>
  </details>`;
}

/* ------------------------------------------- 概念词典（查词 / 领域包 / 返回） */

function dictTerms() {
  const out = [];
  const cj = S.concepts;
  const gl = {};
  ((cj && cj.groups) || []).forEach((g) => { gl[g.id] = g.label; });
  for (const c of (cj && cj.concepts) || []) {
    out.push({ ...c, group: gl[c.g] || '未分组', packId: '', packLabel: '' });
  }
  for (const p of (S.packs && S.packs.packs) || []) {
    for (const c of p.concepts || []) {
      out.push({ ...c, g: `pack:${p.id}`, group: p.label, packId: p.id, packLabel: p.label });
    }
  }
  return out;
}

function dictFind(id) {
  return dictTerms().find((t) => t.id === id) || null;
}

function dictPack(id) {
  return ((S.packs && S.packs.packs) || []).find((p) => p.id === id) || null;
}

/** 搜词：词条名 > 英文 > 通俗 > 专业 > 案例；AND 语义，多词都中才算 */
function dictSearch(q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = dictTerms();
  if (!words.length) return all;
  const scored = [];
  for (const t of all) {
    const term = String(t.term || '').toLowerCase();
    const en = String(t.en || '').toLowerCase();
    const plain = String(t.plain || '').toLowerCase();
    const pro = String(t.pro || '').toLowerCase();
    const cs = String(t.case || '').toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      let s = 0;
      if (term.startsWith(w)) s = 8;
      else if (term.includes(w)) s = 6;
      else if (en.includes(w)) s = 5;
      else if (plain.includes(w)) s = 3;
      else if (pro.includes(w)) s = 1;
      else if (cs.includes(w)) s = 1;
      if (!s) { ok = false; break; }
      score += s;
    }
    if (ok) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.t.term).localeCompare(String(b.t.term)));
  return scored.map((x) => x.t);
}

async function ensurePacks() {
  if (S.packs !== undefined) return S.packs;
  try { S.packs = await api.domains(); } catch { S.packs = null; }
  return S.packs;
}

function dictPush(entry) {
  S.dict.hist.push(entry);
  if (S.dict.hist.length > 40) S.dict.hist.shift();
}

function openDict(id, from) {
  dictPush({ mode: S.dict.mode, id: S.dict.id, packId: S.dict.packId, q: S.dict.q });
  S.dict.mode = 'entry';
  S.dict.id = id;
  renderView();
  const v = $('#view');
  if (v) v.scrollTop = 0;
}

function openPack(id) {
  dictPush({ mode: S.dict.mode, id: S.dict.id, packId: S.dict.packId, q: S.dict.q });
  S.dict.mode = 'pack';
  S.dict.packId = id;
  renderView();
  const v = $('#view');
  if (v) v.scrollTop = 0;
}

function dictBack() {
  const prev = S.dict.hist.pop();
  if (!prev) { S.dict.mode = 'list'; S.dict.id = ''; S.dict.packId = ''; renderView(); return; }
  S.dict.mode = prev.mode || 'list';
  S.dict.id = prev.id || '';
  S.dict.packId = prev.packId || '';
  S.dict.q = prev.q || '';
  renderView();
}

function dictEntryBody(t) {
  const rows = [
    ['专业解释', t.pro, 'pro'],
    ['通俗解释', t.plain, 'plain'],
    ['具体案例', t.case, ''],
    ['容易搞错', t.mistake, ''],
  ].filter(([, v]) => v);
  const same = dictTerms().filter((x) => x.id !== t.id && x.group === t.group).slice(0, 6);
  return `${stampLine()}
    <div class="dict-backrow">
      <button class="mini" data-act="dict-back">← 返回</button>
      <span class="dict-crumb">${esc(t.group)}${t.packLabel ? ' · 领域包' : ''}</span>
      ${t.packId ? `<button class="mini" data-act="pack-open" data-pack="${esc(t.packId)}">回到「${esc(t.packLabel)}」</button>` : ''}
    </div>
    <section class="concept is-single" id="c-${esc(t.id)}">
      <div class="concept-head">
        <span class="concept-no">${esc(String(t.term || '·').slice(0, 1))}</span>
        <h2 class="concept-term">${esc(t.term)}<span class="term-en">${esc(t.en)}</span></h2>
      </div>
      ${rows.map(([label, v, cls]) => `<div class="cfield">
        <span class="cfield-label">${label}</span>
        <p class="cfield-text ${cls || ''}">${esc(v)}</p>
      </div>`).join('')}
    </section>
    ${same.length ? `<div class="dict-rel"><span class="cfield-label">同一类里的其它词</span>
      <div class="termchips">${same.map((x) => `<button class="termchip" data-act="dict-open" data-id="${esc(x.id)}">${esc(x.term)}</button>`).join('')}</div>
    </div>` : ''}
    <p class="hint" style="margin-top:18px">快捷键：<b>Esc</b> 返回上一页，<b>/</b> 直接搜下一个词。</p>`;
}

function dictPackBody(p) {
  const terms = dictTerms().filter((t) => t.packId === p.id);
  const toolRows = (p.tools || []).map((t) => `<tr>
      <td><a href="${esc(t.url)}" data-ext="1" data-url="${esc(t.url)}">${esc(t.name)}</a></td>
      <td>${esc(t.what || '')}</td>
      <td class="dict-free">${esc(t.free || '未标注')}${t.ok === false
        ? '<span class="dict-ck bad">链接打不开，别当它还在</span>'
        : t.checkedAt ? `<span class="dict-ck">核实 ${esc(t.checkedAt)}</span>` : ''}</td>
    </tr>`).join('');
  const siteRows = (p.sites || []).map((s) => `<li><a href="${esc(s.url)}" data-ext="1" data-url="${esc(s.url)}">${esc(s.name)}</a> — ${esc(s.what || '')}${s.ok === false ? '<span class="dict-ck bad">（这天打不开）</span>' : ''}</li>`).join('');
  return `${stampLine()}
    <div class="dict-backrow">
      <button class="mini" data-act="dict-back">← 返回</button>
      <span class="dict-crumb">领域包${p.generated ? ' · 用模型现写的' : ''}</span>
    </div>
    <div class="radar-head"><h1>${esc(p.label)}</h1><span class="count">${terms.length} 个词 · ${(p.tools || []).length} 个工具</span></div>
    <p class="dict-what">${esc(p.what || '')}</p>
    ${p.why ? `<div class="cfield"><span class="cfield-label">为什么值得学</span><p class="cfield-text">${esc(p.why)}</p></div>` : ''}
    ${p.level ? `<p class="hint">从这开始：${esc(p.level.begin || '')}；学到这儿算够用：${esc(p.level.useful || '')}</p>` : ''}

    <h2 class="cgroup-h">学习路径<span class="cgroup-note">按顺序走，每一步都有能动手的东西</span></h2>
    <div class="dict-path">${(p.path || []).map((s, i) => `<div class="dict-step">
      <span class="dict-stepno">${i + 1}</span>
      <div><b>${esc(s.title || '')}</b><p>${esc(s.detail || '')}</p>${s.do ? `<p class="dict-todo">动手：${esc(s.do)}</p>` : ''}</div>
    </div>`).join('')}</div>

    <h2 class="cgroup-h">这个领域最该先懂的词<span class="cgroup-note">点开看四层解释</span></h2>
    <div class="dict-rows">${terms.map((t) => `<button class="dict-row" data-act="dict-open" data-id="${esc(t.id)}">
      <span class="dict-row-term">${esc(t.term)}<em>${esc(t.en || '')}</em></span>
      <span class="dict-row-plain">${esc(t.plain || t.pro || '')}</span>
    </button>`).join('')}</div>

    ${toolRows ? `<h2 class="cgroup-h">工具<span class="cgroup-note">链接在 ${esc((S.packs && S.packs.checkedAt) || '')} 检查过</span></h2>
      <table class="dict-table"><thead><tr><th>名字</th><th>干什么</th><th>收费</th></tr></thead><tbody>${toolRows}</tbody></table>` : ''}
    ${siteRows ? `<h2 class="cgroup-h">网站与社区<span class="cgroup-note">看别人怎么做、去哪儿找素材</span></h2>
      <ul class="dict-sites">${siteRows}</ul>` : ''}
    ${(p.next || []).length ? `<h2 class="cgroup-h">再往前走<span class="cgroup-note">有基础之后的方向</span></h2>
      <ul class="dict-sites">${p.next.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
}

function dictInnerBody() {
  const cj = S.concepts || {};
  const q = S.dict.q;
  const packs = (S.packs && S.packs.packs) || [];
  const terms = dictTerms();
  const res = q ? dictSearch(q) : terms;

  const packStrip = `<div class="dict-packs">
    <span class="cfield-label">领域包</span>
    <div class="dict-packchips">
      ${packs.map((p) => `<button class="dict-pack" data-act="pack-open" data-pack="${esc(p.id)}">
        <b>${esc(p.label)}</b><span>${(p.concepts || []).length} 词 · ${(p.tools || []).length} 工具</span>
      </button>`).join('')}
      <button class="dict-pack dict-pack-add" data-act="dict-gen-open"><b>＋ 我要学一个领域</b><span>用模型现写一份</span></button>
    </div>
  </div>`;

  const gen = S.dict.gen || {};
  const genBox = gen.open ? `<div class="dict-gen">
    <div class="dict-gen-row">
      <input id="dictGenName" class="ninp" placeholder="例如：影像调色 / 电子音乐混音 / 做播客 / 3D 角色绑定" value="${esc(gen.name || '')}" />
      <button class="mini" data-act="dict-gen" ${gen.busy ? 'disabled' : ''}>${gen.busy ? '在写…' : '生成领域包'}</button>
      <button class="mini" data-act="dict-gen-close">取消</button>
    </div>
    <p class="hint keep">${gen.busy
      ? '模型正在写词条、工具与路径，通常 20–40 秒。'
      : gen.err
        ? esc(gen.err)
        : '会现写 6–8 个词条、4–6 个工具、3–4 个网站和一条学习路径。工具链接会逐个检查能不能打开；打不开的会标出来，不会假装有效。需要先在设置里填 API key。'}</p>
  </div>` : '';

  if (q) {
    return `<div class="dict-reshead">搜「${esc(q)}」：${res.length} 条</div>
      <div class="dict-rows">${res.slice(0, 80).map((t) => `<button class="dict-row" data-act="dict-open" data-id="${esc(t.id)}">
        <span class="dict-row-term">${esc(t.term)}<em>${esc(t.en || '')}</em></span>
        <span class="dict-row-plain">${esc(t.plain || t.pro || '')}</span>
        <span class="dict-row-group">${esc(t.group)}</span>
      </button>`).join('') || '<p class="hint keep">没搜到。试试更短的词，比如「混音」「token」「法线」。</p>'}</div>`;
  }

  const gs = Array.isArray(cj.groups) && cj.groups.length ? cj.groups : [];
  const expand = S.dict.expand;
  const groups = gs.map((g) => {
    const items = terms.filter((t) => t.g === g.id);
    if (!items.length) return '';
    return `<h2 class="cgroup-h" id="g-${esc(g.id)}">${esc(g.label)}<span class="cgroup-note">${esc(g.note || '')} · ${items.length} 个</span></h2>
      <div class="dict-rows">${items.map((t) => `<button class="dict-row" data-act="dict-open" data-id="${esc(t.id)}">
        <span class="dict-row-term">${esc(t.term)}<em>${esc(t.en || '')}</em></span>
        <span class="dict-row-plain">${esc(t.plain || t.pro || '')}</span>
      </button>`).join('')}</div>
      ${expand ? items.map((t) => dictEntryBody(t)).join('') : ''}`;
  }).join('');

  return `${packStrip}${genBox}
    <div class="dict-packs">
      <span class="cfield-label">词条</span>
      <div class="termchips">${gs.map((g) => {
        const items = terms.filter((t) => t.g === g.id);
        return items.length ? `<button class="termchip" data-act="jump-group" data-g="${esc(g.id)}">${esc(g.label)} <b>${items.length}</b></button>` : '';
      }).join('')}</div>
    </div>
    <div class="dict-tools">
      <button class="mini" data-act="dict-expand">${expand ? '收起正文，只留词条列表' : '展开全部正文（当书读）'}</button>
      <span class="hint keep">${terms.length} 个词，包含领域包里的词条；按 <b>/</b> 或上面的搜索框直接查。</span>
    </div>
    ${groups}`;
}

function dictListBody() {
  const q = S.dict.q;
  const packs = (S.packs && S.packs.packs) || [];
  return `${stampLine()}
    <div class="radar-head"><h1>概念词典</h1><span class="count">${dictTerms().length} 个词 · ${packs.length} 个领域包</span></div>
    <p class="hint keep dict-lead">查词的地方：一个词四层（专业解释 / 通俗解释 / 具体案例 / 容易搞错），点开是单独一页，<b>Esc</b> 或「返回」回到刚才的位置。
      想学新领域就看领域包——按「先懂词、再动手、最后进阶」排好；目录里没有的领域，点「＋ 我要学一个领域」让模型现写一份。</p>
    <div class="dict-search">
      <input id="dictQ" class="ninp" placeholder="搜词条：混音 / token / 法线 / lufs / join" value="${esc(q)}" />
      <button class="mini" data-act="dict-clear" ${q ? '' : 'style="display:none"'}>清空</button>
      <span class="dict-searchhint">Enter 打开第一条 · Esc 返回</span>
    </div>
    <div id="dictRes">${dictInnerBody()}</div>`;
}

/** 打字时只换结果区，不重建整页——否则输入框失焦，输入法也会被打断 */
function dictRepaint() {
  const box = document.getElementById('dictRes');
  if (!box) return;
  box.innerHTML = dictInnerBody();
  const clear = document.querySelector('[data-act="dict-clear"]');
  if (clear) clear.style.display = S.dict.q ? '' : 'none';
}

function renderDictPage() { if (S.view === 'concepts') renderView(); }
let dictTimer = 0;

async function renderConcepts(host) {
  if (S.concepts === undefined) {
    host.innerHTML = `${stampLine()}<div class="empty"><h1>正在读 concepts.json…</h1></div>`;
    ensureConcepts().then(() => { if (S.view === 'concepts') renderView(); });
    return;
  }
  if (!S.concepts || !S.concepts.concepts) {
    host.innerHTML = `${stampLine()}<div class="empty"><h1>没读到 concepts.json</h1>
      <p>文件在 <code>${esc(rootPath('concepts.json'))}</code>，是个普通 JSON，可以自己改词条。</p></div>`;
    return;
  }
  if (S.packs === undefined) {
    host.innerHTML = `${stampLine()}<div class="empty"><h1>正在读领域包…</h1></div>`;
    await ensurePacks();
    if (S.view === 'concepts') renderView();
    return;
  }
  if (S.dict.mode === 'entry') {
    const t = dictFind(S.dict.id);
    if (t) { host.innerHTML = dictEntryBody(t); return; }
    S.dict.mode = 'list';
  }
  if (S.dict.mode === 'pack') {
    const p = dictPack(S.dict.packId);
    if (p) { host.innerHTML = dictPackBody(p); return; }
    S.dict.mode = 'list';
  }
  host.innerHTML = dictListBody();
}

async function dictGenerate() {
  const name = String((S.dict.gen && S.dict.gen.name) || '').trim();
  if (!name) { toast('先写一个领域名，比如「电子音乐混音」。', true); return; }
  S.dict.gen.busy = true;
  S.dict.gen.err = '';
  renderView();
  const r = await withJob('domain', `正在写「${name}」领域包`, { en: 'Glossary', expect: 45, step: '模型在整理先懂的词、动手的工具和进阶路线' }, () => api.domainGen(name));
  S.dict.gen.busy = false;
  if (!r || !r.ok) {
    S.dict.gen.err = (r && r.needKey)
      ? '没填 API key：先在「设置」里填一个，它才能现写领域包。'
      : `没写成：${(r && r.error) || '未知错误'}`;
    renderView();
    toast(S.dict.gen.err, true);
    return;
  }
  S.packs = await api.domains();
  S.dict.gen = { name: '', busy: false, err: '', open: false };
  openPack(r.pack.id);
  toast(`「${r.pack.label}」写好了：${r.pack.concepts.length} 个词、${(r.pack.tools || []).length} 个工具。`);
}

async function ensureAgents() {
  if (S.agents !== undefined) return S.agents;
  try { S.agents = await api.agents(); } catch (e) { S.agents = null; }
  return S.agents;
}

function cmdRow(c) {
  const isUrl = /^https?:\/\//i.test(String(c.cmd || ''));
  const right = isUrl
    ? `<a class="mini" href="${esc(c.cmd)}" data-ext="1" data-url="${esc(c.cmd)}">打开</a>`
    : `<button class="mini" type="button" data-act="copy-cmd" data-cmd="${esc(c.cmd)}">复制</button>`;
  return `<div class="cmdline">
    <span class="cmd-label">${esc(c.label || '')}</span>
    ${isUrl ? `<a class="cmd-code aslink" href="${esc(c.cmd)}" data-ext="1" data-url="${esc(c.cmd)}">${esc(c.cmd)}</a>`
            : `<code class="cmd-code">${esc(c.cmd)}</code>`}
    ${right}
  </div>`;
}

function renderAgents(host) {
  if (S.agents === undefined) {
    host.innerHTML = `${stampLine()}<div class="empty"><h1>正在读 agents.json…</h1></div>`;
    ensureAgents().then(() => { if (S.view === 'agents') renderView(); });
    return;
  }
  const reg = S.agents;
  if (!reg || !reg.agents) {
    host.innerHTML = `${stampLine()}<div class="empty"><h1>没读到 agents.json</h1>
      <p>文件在 <code>${esc(rootPath('agents.json'))}</code>。它是个普通 JSON，可以自己加条目；
      改完重开应用。</p></div>`;
    return;
  }
  const byGroup = new Map();
  for (const a of reg.agents) {
    const k = a.group || 'cli';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(a);
  }
  const sections = (reg.groups || []).filter((g) => byGroup.has(g.key)).map((g) => {
    const items = byGroup.get(g.key).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return `<h2 class="grp-head">
        ${esc(g.label)}<span class="hint" style="margin-left:8px;font-weight:400">— ${esc(g.note || '')} · ${items.length} 个</span></h2>
      ${items.map((a) => `<div class="agent">
        <div class="agent-head">
          <h3 class="row-title">${esc(a.name)}</h3>
          <span class="agent-vendor">${esc(a.vendor || '')}</span>
          ${SKILL_LABEL[a.skill_group] ? `<span class="agent-skill">技能栏 · ${esc(SKILL_LABEL[a.skill_group])}</span>` : ''}
        </div>
        <p class="row-sum">${esc(a.what || '')}</p>
        <div class="agent-need">需要：${esc(a.need || '未知')}</div>
        <div class="agent-cmds">${(a.installs || []).map(cmdRow).join('')}</div>
        <div class="repo-tag">
          <span><a href="${esc(a.home)}" data-ext="1" data-url="${esc(a.home)}">${esc(a.home)}</a></span>
          <span>${esc(a.verified || '')}</span>
        </div>
      </div>`).join('')}`;
  }).join('');

  host.innerHTML = `
    ${stampLine()}
    <div class="radar-head" style="margin-top:22px"><h1>安装 agent</h1>
      <span class="count">${reg.agents.length} 个，按形态分组</span></div>
    <p class="hint" style="margin-top:16px;max-width:62ch">这些就是「技能」栏里分组的那批 agent——先装一个，
      再去技能栏挑包。命令在 ${esc(reg.checked_at || '')} 用 npm registry / PyPI / 官网核过，版本号是当时的最新；
      标「未核实」的以官网为准。表是活文件：改 <code>agents.json</code> 就行。</p>
    ${sections}`;
}

/* ------------------------------------------------------- 需求雷达 */

/* ------------------------------------------- 扩展能力（插件 / 技能 / MCP） */

const EXT_USES = [
  ['all', '全部'],
  ['general', '通用能力'],
  ['work', '工作专用'],
  ['hobby', '兴趣专用'],
  ['connect', '连接现有工具'],
];

const EXT_VERIFY = {
  directory: { label: '目录收录', note: '能在官方目录/市场里检索到' },
  author: { label: '作者宣称', note: '只有作者自己的说明，没有独立核实' },
  tested: { label: '实测过', note: '在这台机器上真的取到了包或页面' },
};

function extNeedList(card, hosts) {
  const map = {};
  (hosts || []).forEach((h) => { map[h.key] = h; });
  return (card.needs || []).map((k) => {
    const h = map[k];
    const ok = h ? h.present : null;
    const label = h ? h.label : k;
    return `${label}${ok === true ? '' : ok === false ? '（还没装）' : '（不知道装没装）'}`;
  }).join(' · ');
}

function extHostOk(card, hosts) {
  const map = {};
  (hosts || []).forEach((h) => { map[h.key] = h.present; });
  return (card.needs || []).every((k) => map[k] === true);
}

function extCard(card, hosts) {
  const v = EXT_VERIFY[(card.verified && card.verified.level) || 'author'] || EXT_VERIFY.author;
  const probe = (S.ext.probed || {})[card.id];
  const usable = extHostOk(card, hosts);
  const badge = probe && probe.ok ? EXT_VERIFY.tested : v;
  return `<article class="extcard" id="ext-${esc(card.id)}">
    <div class="exth">
      <div class="exttitle">
        <a data-ext href="${esc(card.url)}">${esc(card.name)}</a>
        <span class="extkind">${esc(card.kind || '')}</span>
      </div>
      <div class="extuse">${esc(extUseLabel(card.use))}${usable ? '' : ' · 先装宿主'}</div>
    </div>
    <p class="extdesc">${esc(card.desc || '（作者没写简介）')}</p>
    <div class="extrows">
      <div class="extrow"><span class="extk">在哪用</span><span>${esc(extNeedList(card, hosts))}</span></div>
      <div class="extrow"><span class="extk">收费</span><span>${esc(card.cost || '未标注')}</span></div>
      <div class="extrow"><span class="extk">权限</span><span>${esc(card.perms || '未标注')}</span></div>
      <div class="extrow"><span class="extk">怎么开始</span><span><code class="cmd-code" data-cc="1">${esc(card.start || '')}</code><button class="mini ext-copy" data-act="ext-copy" data-start="${esc(card.start || '')}">复制</button></span></div>
      <div class="extrow"><span class="extk">核实</span><span>${esc((card.verified && card.verified.at) || '未标注')} · ${esc((card.verified && card.verified.via) || '来源未标注')}</span></div>
    </div>
    <div class="extfoot">
      <span class="extverified ${esc(badge === EXT_VERIFY.tested ? 'tested' : card.verified && card.verified.level === 'directory' ? 'dir' : 'author')}" title="${esc(badge.note)}">${esc(badge.label)}</span>
      ${probe ? `<span class="extprobe ${probe.ok ? 'ok' : 'no'}">${esc(probe.detail)}</span>` : ''}
      <button class="mini ext-probe-btn" data-act="ext-probe" data-id="${esc(card.id)}">实测一下</button>
      ${card.kind === 'MCP' ? '<span class="extmcpnote">让 AI 连接其他工具的接口，需要一个兼容客户端</span>' : ''}
    </div>
  </article>`;
}

function extUseLabel(use) {
  const row = EXT_USES.find((r) => r[0] === use);
  return row ? row[1] : use || '通用能力';
}

function extHostStrip(env) {
  const hosts = (env && env.apps) || [];
  if (!hosts.length) return '<p class="hint keep">正在检测这台机器上装了哪些宿主…</p>';
  const on = hosts.filter((h) => h.present).length;
  return `<div class="exthosts">
    <div class="exthosts-head">这台机器上有：<b>${on}</b> / ${hosts.length}</div>
    <div class="envchips">
      ${hosts.map((h) => `<span class="envchip ${h.present ? 'on' : 'off'}" title="${esc(h.hint || '')}">${esc(h.label)}${h.version ? ` ${esc(String(h.version).slice(0, 14))}` : ''}</span>`).join('')}
    </div>
    <p class="hint keep">没装的宿主，下面对应的卡片会标「还没装」——不是不能用，是得先把软件装上。</p>
  </div>`;
}

function extFilters(cat) {
  const byUse = (cat && cat.byUse) || {};
  const chips = EXT_USES.map(([k, label]) => {
    const n = k === 'all' ? (cat && cat.rows ? cat.rows.length : 0) : byUse[k] || 0;
    return `<button class="chip ${S.ext.use === k ? 'on' : ''}" data-act="ext-use" data-use="${k}">${label} <span class="chipn">${n}</span></button>`;
  }).join('');
  return `<div class="chips extchips">
    ${chips}
    <button class="chip ${S.ext.host === 'usable' ? 'on' : ''}" data-act="ext-host" data-host="${S.ext.host === 'usable' ? 'all' : 'usable'}">${S.ext.host === 'usable' ? '只看本机能用 ✓' : '只看本机能用'}</button>
    <span class="chips-note">${esc((cat && cat.at ? shortTime(cat.at) : '还没取过'))} 取回 · 缓存 12 小时</span>
    <button class="mini" data-act="ext-refresh">刷新目录</button>
  </div>`;
}

function extSourcesLine(cat) {
  const s = (cat && cat.sources) || {};
  const parts = Object.entries(s).map(([k, v]) => `${v.label || k} ${v.ok ? v.count : '失败'}`);
  return `<p class="hint keep">来源：${esc(parts.join(' · ') || '还没取过')}</p>`;
}

async function ensureExt(force) {
  if (S.ext.busy) return;
  if (!force && S.ext.cat) return;
  S.ext.busy = true;
  S.ext.err = '';
  try {
    // 冷启动要问五个目录（约 20 秒），但绝不能让页面无期限挂着
    const work = Promise.all([api.extEnv(), api.extList({ force: !!force })]).then(([env, cat]) => {
      S.ext.env = env;
      if (cat && cat.ok) S.ext.cat = cat;
      else S.ext.err = (cat && cat.error) || '取目录失败';
    });
    await Promise.race([work, new Promise((r) => setTimeout(r, 60000))]);
    if (!S.ext.cat && !S.ext.err) S.ext.err = '取目录超时了（网络慢或被挡）。点「刷新目录」再试一次。';
  } catch (e) {
    S.ext.err = String((e && e.message) || e);
  }
  S.ext.busy = false;
}

async function renderExt(host) {
  if (!S.ext.cat && !S.ext.busy) {
    host.innerHTML = '<p class="hint keep">正在问几个官方目录（Obsidian / VS Code / Godot / Blender / MCP Registry），第一次要十几秒…</p>';
    await ensureExt(false);
  }
  const cat = S.ext.cat;
  const env = S.ext.env;
  if (!cat) {
    host.innerHTML = `${stampLine()}<div class="radarhead"><div class="h-title">扩展能力<small>插件 · 技能 · MCP 放在同一张表里</small></div></div>
      <p class="hint keep">${esc(S.ext.err || '正在问几个官方目录（Obsidian / VS Code / Godot / Blender / MCP Registry），第一次要十几秒…')}</p>
      ${S.ext.err ? '<p><button class="mini" data-act="ext-refresh">刷新目录</button></p>' : ''}`;
    return;
  }
  const all = (cat && cat.rows) || [];
  const hosts = (env && env.apps) || [];
  const shown = all.filter((c) => {
    if (S.ext.use !== 'all' && c.use !== S.ext.use) return false;
    if (S.ext.host === 'usable' && !extHostOk(c, hosts)) return false;
    return true;
  });

  const head = `${stampLine()}<div class="radarhead">
    <div class="h-title">扩展能力<small>插件 · 技能 · MCP 放在同一张表里，按用途挑，按你机器上有什么筛</small></div>
  </div>
  <p class="hint keep">三档标记是分开的：<b>目录收录</b>只说明能在官方市场检索到；<b>实测过</b>只说明这台机器上真取到了包或页面——都不等于「功能一定好用」。权限大多数目录不给清单，所以「权限」一栏是按形态写的通用事实，作者没声明的都标「未标注」。</p>
  ${extHostStrip(env)}
  ${cat ? extFilters(cat) : ''}
  ${cat ? extSourcesLine(cat) : ''}`;

  const cards = shown.map((c) => extCard(c, hosts)).join('');
  host.innerHTML = `${head}
    <div class="extgrid">${cards || '<p class="hint keep">这一类现在没有卡片，换个用途看看。</p>'}</div>`;
}

function extProbeRefresh(id) {
  renderView();
  requestAnimationFrame(() => {
    const el = document.getElementById(`ext-${id}`);
    if (el) el.scrollIntoView({ block: 'center' });
  });
}

const VERDICT_LIST = [
  ['useful', '有效'],
  ['complex', '太复杂'],
  ['pricey', '太贵'],
  ['irrelevant', '不相关'],
  ['solved', '已经解决'],
];

function needCondChips(cond) {
  if (!cond) return '';
  const out = [];
  const one = (label, v) => {
    if (!v) return;
    const cls = v.ok === true ? 'on' : v.ok === false ? 'off' : '';
    out.push(`<span class="condchip ${cls}">${esc(label)}：${esc(v.text || '未标注')}</span>`);
  };
  one('费用', cond.free);
  one('平台', cond.win);
  one('难度', cond.easy);
  one('额外依赖', cond.py);
  return out.join('');
}

function recRow(it, needId) {
  const v = it.verdict || '';
  const fb = VERDICT_LIST.map(([k, label]) => `<button type="button"
      class="fbbtn${v === k ? ' on' : ''}" data-act="need-fb" data-id="${esc(needId)}"
      data-url="${esc(it.url)}" data-verdict="${k}" data-title="${esc(it.title)}">${label}</button>`).join('');
  const known = S.needs.tracking && S.needs.tracking.some((t) => t.url === it.url);
  return `<div class="recrow">
    <div class="recrow-head">
      <span class="reckind">${esc(it.kindLabel || it.kind || '项目')}</span>
      <a class="rectitle" href="${esc(it.url)}" data-ext="1" data-url="${esc(it.url)}">${esc(it.title)}</a>
      ${it.stars ? `<span class="recstars">${num(it.stars)} ★</span>` : ''}
      ${it.early ? '<span class="earlytag">早期发现</span>' : ''}
    </div>
    <div class="recmeta">${needCondChips(it.cond)}</div>
    <p class="recwhy">${esc(it.reason || '')}</p>
    <div class="fbrow">${fb}
      <button type="button" class="mini" data-act="track-add-url" data-url="${esc(it.url)}" data-title="${esc(it.title)}" data-id="${esc(needId)}"${known ? ' disabled' : ''}>${known ? '已追踪' : '追踪'}</button>
    </div>
  </div>`;
}

function needCard(n, scan) {
  const meta = [];
  const add = (k, v) => { if (v) meta.push(`<div class="needmeta-row"><span class="needmeta-k">${k}</span><span class="needmeta-v">${esc(v)}</span></div>`); };
  add('目标', n.goal || n.detail);
  add('常用软件', (n.software || []).join('、'));
  add('预算', n.budget);
  add('设备', n.device);
  add('难度', n.difficulty);
  add('试过', (n.tried || []).join('；'));
  const fb = (scan && scan.feedback) || {};
  const fbLine = VERDICT_LIST.map(([k, label]) => `${label} ${fb[k] || 0}`).join(' · ');
  const items = (scan && scan.items) || [];
  const body = items.length
    ? items.map((it) => recRow(it, n.id)).join('')
    : `<p class="needmeta-note">还没有扫描结果。点「现在帮我找」从已有材料里挑，或者去原始雷达的时间范围里放宽窗口。</p>`;
  return `<article class="needcard" id="n-${esc(n.id)}">
    <div class="needcard-head">
      <h2 class="needcard-title">${esc(n.topic)}${n.status === 'solved' ? '<span class="solvedtag">已解决</span>' : ''}</h2>
      <div class="needcard-tools">
        <button type="button" class="mini" data-act="need-find" data-id="${esc(n.id)}">现在帮我找</button>
        <button type="button" class="mini" data-act="need-edit" data-id="${esc(n.id)}">编辑</button>
        <button type="button" class="mini" data-act="need-del" data-id="${esc(n.id)}">删</button>
      </div>
    </div>
    ${meta.length ? `<div class="needmeta">${meta.join('')}</div>` : ''}
    <div class="needfb">你给的反馈：${fbLine}</div>
    ${body}
    <div class="needfound" id="found-${esc(n.id)}"></div>
  </article>`;
}

function needFormInner() {
  const f = S.needs.form || {};
  const v = f.values || {};
  const row = (key, label, hint, ph, area) => `<label class="nfield">
    <span class="nlabel">${label}<small>${hint}</small></span>
    ${area
      ? `<textarea class="narea" data-nf="${key}" rows="2" placeholder="${esc(ph)}">${esc(v[key] || '')}</textarea>`
      : `<input class="ninp" data-nf="${key}" value="${esc(v[key] || '')}" placeholder="${esc(ph)}">`}
  </label>`;
  return `<section class="needform" id="needForm">
    <div class="needform-head">
      <h2>${f.id ? '改这条需求' : '加一条需求'}</h2>
      <button type="button" class="mini" data-act="need-cancel">收起</button>
    </div>
    <p class="hint keep">填得越具体，筛出来的越准。只有「目标」是必填。</p>
    ${row('topic', '你想要的', '一句话说清目标', '比如：提高像素游戏素材制作效率')}
    ${row('goal', '具体一点', '做哪一步、要多快', '比如：把概念图批量转成可用的精灵图和法线贴图', true)}
    ${row('software', '常用软件', '顿号或逗号分开', '比如：Godot、Aseprite、Photoshop')}
    ${row('budget', '预算', '免费 / 多少钱以内', '比如：尽量免费，最多 30 美元')}
    ${row('device', '设备条件', '显存、系统、有没有 Python', '比如：Windows 11、RTX 4060 8GB、没装 Python')}
    ${row('difficulty', '能接受的操作难度', '一句话', '比如：能接受装软件，不想碰命令行', true)}
    ${row('tried', '试过但不满意的', '分号分开', '比如：某工具要付费；某网站不能批量', true)}
    <div class="needform-actions">
      <button type="button" class="btn" data-act="need-save">保存</button>
      <span class="hint keep" id="needFormHint"></span>
    </div>
  </section>`;
}

function trackRow(t, daily) {
  const d = (daily && daily[t.url]) || null;
  const ch = (d && d.changes) || (t.changes || []);
  const chHtml = ch.length
    ? `<ul class="track-changes">${ch.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
    : '<span class="track-quiet">没有变化</span>';
  return `<div class="trackrow">
    <div class="trackrow-head">
      <a class="trackname" href="${esc(t.url)}" data-ext="1" data-url="${esc(t.url)}">${esc(t.name)}</a>
      <span class="trackver">${esc((d && d.tag) || (t.snap && t.snap.tag) || ((t.snap && t.snap.stars) ? '⭐ ' + num(t.snap.stars) : '还没有版本信息'))}</span>
      <button type="button" class="mini" data-act="track-del" data-id="${esc(t.id)}">不追了</button>
    </div>
    <div class="trackmeta">核实 ${esc(t.checked_at || '—')} · 最近推送 ${esc((t.snap && t.snap.pushed) || '—')}${(d && d.published) || (t.snap && t.snap.published) ? ' · 最近发布 ' + esc((d && d.published) || t.snap.published) : ''}</div>
    ${chHtml}
  </div>`;
}

async function ensureNeeds(force) {
  if (S.needs.payload && !force) return S.needs.payload;
  try {
    S.needs.payload = await api.needsLoad();
    S.needs.err = '';
  } catch (e) {
    S.needs.err = e.message || String(e);
    S.needs.payload = S.needs.payload || { needs: [], dataDate: '', stale: true };
  }
  return S.needs.payload;
}

async function ensureTracker(force) {
  if (S.needs.tracking && !force) return S.needs.tracking;
  try {
    const r = await api.trackList();
    S.needs.tracking = r.items || [];
    S.needs.daily = r.dailyChanges || {};
    S.needs.trackingDate = r.dataDate || '';
  } catch {
    S.needs.tracking = S.needs.tracking || [];
  }
  return S.needs.tracking;
}

async function renderNeeds(host) {
  const p = await ensureNeeds();
  await ensureTracker();
  const needs = (p.needs || []).filter((n) => n.status !== 'solved');
  const track = S.needs.tracking || [];
  const scan = S.needs.scan;
  const byNeed = {};
  if (scan) (scan.needs || []).forEach((g) => { byNeed[g.need.id] = g; });
  const stale = p.stale && p.dataDate;

  const toolbar = `<div class="needbar">
    <button type="button" class="btn primary" data-act="needs-scan"${S.needs.busy ? ' disabled' : ''}>${S.needs.busy ? '正在扫…' : '现在帮我找'}</button>
    <button type="button" class="mini" data-act="need-new">加一条需求</button>
    <button type="button" class="mini" data-act="track-check"${S.needs.trackBusy ? ' disabled' : ''}>${S.needs.trackBusy ? '碰一下…' : '持续帮我关注'}</button>
    ${scan ? `<span class="hint keep">刚扫过 ${num(scan.scanned)} 条材料，生成于 ${esc(shortTime(scan.generatedAt))}</span>` : ''}
  </div>`;

  const staleHtml = stale
    ? `<div class="stalebar">采集没跑成功，材料停留在 <b>${esc(p.dataDate)}</b>。下面的推荐基于那天的数据，点「现在帮我找」会去 GitHub 现搜。</div>`
    : '';

  const formHtml = S.needs.form ? needFormInner() : '';

  const needsHtml = needs.length
    ? needs.map((n) => needCard(n, byNeed[n.id])).join('')
    : `<div class="empty-soft"><p>还没有需求。可以让对话自己记（去「对话」说说你在做什么），也可以手动加一条——手动加的字段最全，筛得最准。</p>
        <div class="need-actions"><button class="btn quiet" data-act="need-new">加一条需求</button></div></div>`;

  const earlyItems = (scan && scan.early) || [];
  const earlyHtml = earlyItems.length
    ? `<section class="earlysec">
        <h2 class="sec-h">早期发现 <span class="hint keep">刚冒头、方向对得上、还没被验证</span></h2>
        ${earlyItems.map((it) => `<div class="earlyrow">
          <div class="earlyrow-head">
            <a class="rectitle" href="${esc(it.url)}" data-ext="1" data-url="${esc(it.url)}">${esc(it.title)}</a>
            ${it.stars ? `<span class="recstars">${num(it.stars)} ★</span>` : ''}
            ${it.createdDays !== undefined ? `<span class="earlyage">${num(it.createdDays)} 天前建</span>` : ''}
          </div>
          <p class="recwhy">${esc(it.reason || '')}</p>
          <div class="fbrow">
            <button type="button" class="mini" data-act="track-add-url" data-url="${esc(it.url)}" data-title="${esc(it.title)}">追踪</button>
          </div>
        </div>`).join('')}
      </section>`
    : '';

  const trackHtml = `<section class="tracksec">
    <h2 class="sec-h">持续帮我关注 <span class="hint keep">${track.length ? track.length + ' 个东西' : '还没加东西'}</span></h2>
    <p class="hint keep">只看有意义的变化：出了能直接安装的版本、加了你要的功能或平台、开放下载或降价、停止维护或出现替代品。每天采集时顺手查一次。
    <div class="trackadd">
      <input class="ninp" id="trackUrl" placeholder="粘贴 GitHub 仓库地址，或 owner/repo">
      <button type="button" class="mini" data-act="track-add">加进来</button>
    </div>
    ${track.length ? track.map((t) => trackRow(t, S.needs.daily)).join('') : '<p class="needmeta-note">还没加任何东西。上面每条推荐右边都有「追踪」，点了就会进这里。</p>'}
  </section>`;

  const errHtml = S.needs.err ? `<p class="hint bad">${esc(S.needs.err)}</p>` : '';

  host.innerHTML = `${stampLine()}
    <div class="h-title">需求雷达<small>${needs.length} 条需求 · ${track.length} 个追踪 · 数据 ${esc(p.dataDate || '—')}</small></div>
    <p class="hint keep">先记下你的条件和底线，再判断一个项目到底能解决哪一步。没对上的地方会直接写出来，不会只说「很适合你」。</p>
    ${staleHtml}
    ${toolbar}
    ${errHtml}
    ${formHtml}
    ${needsHtml}
    ${earlyHtml}
    ${trackHtml}`;
}

function readNeedForm() {
  const out = {};
  document.querySelectorAll('#needForm [data-nf]').forEach((el) => {
    out[el.dataset.nf] = el.value.trim();
  });
  return out;
}

async function saveNeedForm() {
  const v = readNeedForm();
  const hint = document.getElementById('needFormHint');
  if (!v.topic) {
    if (hint) hint.textContent = '「你想要的」填一下，其余可以空。';
    return;
  }
  const f = S.needs.form || {};
  const payload = {
    ...v,
    software: v.software ? v.software.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean) : [],
    tried: v.tried ? v.tried.split(/[;；\n]/).map((s) => s.trim()).filter(Boolean) : [],
    keywords: (f.values && f.values.keywords) || undefined,
  };
  try {
    if (f.id) await api.needUpdate({ ...payload, id: f.id });
    else {
      const topic = v.topic;
      const kw = [v.topic, v.goal, v.software].filter(Boolean).join(' ');
      await api.needAdd({ ...payload, topic, keywords: kw.split(/[\s、,，;；]+/).filter((k) => k.length >= 2).slice(0, 12) });
    }
    S.needs.form = null;
    await ensureNeeds(true);
    renderView();
    toast(f.id ? '改好了。' : '记下了。点「现在帮我找」试试。');
  } catch (e) {
    if (hint) hint.textContent = e.message || String(e);
  }
}

async function runNeedsScan(onlyId) {
  if (S.needs.busy) return;
  S.needs.busy = true;
  renderView();
  try {
    const r = await withJob('needs-scan', '正在按需求筛项目', { en: 'Needs', expect: 8, step: '对照每条需求的条件和底线' },
      () => api.needsScan({ range: 'd7', id: onlyId || '' }));
    S.needs.scan = r;
    toast(`扫了 ${num(r.scanned)} 条材料，给出 ${num((r.needs || []).reduce((a, g) => a + g.items.length, 0))} 条推荐。`);
  } catch (e) {
    toast('扫描出错了：' + (e.message || e), true);
  } finally {
    S.needs.busy = false;
    renderView();
  }
}

async function runNeedFind(id) {
  const box = document.getElementById('found-' + id);
  if (box) box.innerHTML = '<p class="hint keep">正在 GitHub 现搜…（两次查询，约 3 秒）</p>';
  try {
    const r = await withJob('needs-find', '正在 GitHub 现搜', { en: 'Search', expect: 5, step: '两次查询，再按需求过一遍条件' }, () => api.needsFind(id));
    if (!box) return;
    const errs = (r.errors || []).length ? `<p class="hint bad">${esc(r.errors.join('；'))}</p>` : '';
    const body = (r.items || []).length
      ? r.items.map((it) => recRow(it, id)).join('')
      : '<p class="needmeta-note">这次没搜到新东西。可以换个说法改改需求的关键词，或者过几天再看。</p>';
    box.innerHTML = `<div class="foundbox"><div class="foundhead">现搜结果 <span class="hint keep">${esc((r.queries || []).join(' / '))}</span></div>${errs}${body}</div>`;
  } catch (e) {
    if (box) box.innerHTML = `<p class="hint bad">搜的时候出错了：${esc(e.message || e)}</p>`;
  }
}

async function giveFeedback(id, url, verdict, title) {
  try {
    await api.needsFeedback({ needId: id, url, verdict, title });
    if (S.needs.scan) {
      (S.needs.scan.needs || []).forEach((g) => {
        g.items.forEach((it) => { if (it.url === url) it.verdict = verdict; });
      });
    }
    toast(`记下了：${(VERDICT_LIST.find(([k]) => k === verdict) || [])[1] || verdict}。之后的推荐会按这个调。`);
    renderView();
  } catch (e) {
    toast('反馈没存上：' + (e.message || e), true);
  }
}

async function addTrack(url, title, needId) {
  try {
    const r = await api.trackAdd({ url, name: title, needs: needId ? [needId] : [] });
    if (!r.ok) { toast(r.error || '加不进去。', true); return; }
    S.needs.tracking = r.items || [];
    toast('加进「持续帮我关注」了，以后有变化会显示在这里。');
    renderView();
  } catch (e) {
    toast('加不进去：' + (e.message || e), true);
  }
}

async function checkTracker() {
  if (S.needs.trackBusy) return;
  if (!(S.needs.tracking || []).length) { toast('先加几个想追的东西。'); return; }
  S.needs.trackBusy = true;
  renderView();
  try {
    const r = await withJob('track', '正在检查追踪名单', { en: 'Tracking', expect: 15, step: '逐个查仓库信息和最新版本' }, () => api.trackCheck());
    S.needs.tracking = r.items || [];
    toast(r.changed ? `查到 ${num(r.changed)} 处变化。` : '都查了，没有变化。');
  } catch (e) {
    toast('检查出错了：' + (e.message || e), true);
  } finally {
    S.needs.trackBusy = false;
    renderView();
  }
}

/* ------------------------------------------------------- 对话 / 猜你需要 */

function matchShell() {
  if (S.state.config.matchEnabled === false) return '';
  return '<section class="match" id="match"></section>';
}

async function ensureProfile() {
  if (!S.chat.loaded) {
    try {
      const r = await api.chatLoad();
      S.chat.profile = r.profile;
      S.chat.hasKey = !!r.hasKey;
      S.chat.model = r.model || '';
      S.chat.msgs = r.messages || [];
      S.chat.date = r.date || '';
      S.chat.loaded = true;
    } catch {
      S.chat.profile = { project: {}, needs: [] };
      S.chat.loaded = true;
    }
  }
  return S.chat.profile;
}

function matchRow(it) {
  return `<div class="mrow">
    <div class="mrow-head">
      <span class="mrow-kind">${esc(it.kind)}</span>
      <a class="mrow-title" href="${esc(it.url)}" data-ext="1" data-url="${esc(it.url)}">${esc(it.title)}</a>
      ${it.stars ? `<span class="mrow-stars">${num(it.stars)} ★</span>` : ''}
    </div>
    ${it.sub ? `<div class="mrow-sub">${esc(it.sub)}</div>` : ''}
    <div class="mrow-reason">${esc(it.reason)}</div>
  </div>`;
}

async function paintMatch() {
  const host = document.getElementById('match');
  if (!host || S.match.busy) return;
  if (S.state.config.matchEnabled === false) { host.innerHTML = ''; return; }
  const prof = await ensureProfile();
  const needs = (prof && prof.needs) || [];
  const head = (extra) => `<div class="match-head">
      <h2>猜你需要</h2>
      <div class="match-tools">
        ${needs.length ? `<span class="mranges">
          <button type="button" class="mrange${S.match.range === 'today' ? ' on' : ''}" data-mrange="today">今日</button>
          <button type="button" class="mrange${S.match.range === 'd7' ? ' on' : ''}" data-mrange="d7">近一周</button>
        </span>` : ''}
        <button type="button" class="mini" data-act="goto-needs">需求雷达</button>
        <button type="button" class="mini" data-act="goto-chat">需求与对话</button>
        <button type="button" class="mini" data-act="match-off">关闭这块</button>
      </div>
    </div>${extra || ''}`;

  if (!needs.length) {
    host.innerHTML = head(`<p class="match-note">还没有记下你的需求。去「对话」说两句你在做什么、卡在哪，我会记下来，这里就会从每天的材料里按需求筛东西给你。</p>
      <div class="match-actions"><button class="btn quiet" data-act="goto-chat">去对话说说我的项目</button></div>`);
    return;
  }

  host.innerHTML = head('<p class="match-note">正在按你记下的需求筛材料……</p>');
  S.match.busy = true;
  try {
    const r = await api.matchRun(S.match.range);
    S.match.items = r.items || [];
    S.match.needs = r.needs || 0;
    if (!host.isConnected || S.view !== 'today' || !document.body.contains(host)) return;
    const span = S.match.range === 'today' ? '今天' : '近一周';
    if (!r.items.length) {
      host.innerHTML = head(`<p class="match-note">按你记下的 ${num(r.needs)} 条需求，${span}的材料里没有对得上的。要么材料确实无关，要么需求的关键词太窄——去「对话」里补两句更具体的话。</p>`);
      return;
    }
    host.innerHTML = head(`<p class="match-note">按你记下的 ${num(r.needs)} 条需求，从${span}的材料里挑出 ${r.items.length} 条（扫了 ${num(r.scanned)} 条）。</p>
      <div class="mlist">${r.items.map(matchRow).join('')}</div>`);
  } catch (e) {
    host.innerHTML = head(`<p class="match-note bad">筛的时候出错了：${esc(e.message || e)}</p>`);
  } finally {
    S.match.busy = false;
  }
}

const CHAT_GROUPS = [
  {
    key: 'teach',
    label: '教我',
    items: [
      '用一句话解释 MCP，再打个比方',
      'Kimi K3.1 Pro 和 Claude Haiku 5.5，哪个更适合每天写简报？',
    ],
  },
  {
    key: 'look',
    label: '帮我看',
    items: [
      '这周材料里，哪三个最值得我花时间？为什么？',
      '我在做的项目，这周的新闻里有什么会影响我？',
    ],
  },
  {
    key: 'think',
    label: '帮我想',
    items: [
      '我在做一个 Godot 像素游戏，这个方向能用 AI 省掉哪些重复劳动？',
      '如果我只有两小时，今晚做哪一件事收益最大？',
    ],
  },
  {
    key: 'do',
    label: '帮我做',
    items: [
      '帮我写一段采集材料的提示词：只输出中文要点，不许编数字。',
      '把「本周该看什么」写成一个每天都能套用的检查清单。',
    ],
  },
];

function needsPanel(prof) {
  const p = (prof && prof.project) || {};
  const needs = (prof && prof.needs) || [];
  return `<section class="needs">
    <div class="needs-head">
      <h2>AI 记住的你的项目与需求</h2>
      <span class="hint">存在 state/profile.json，可随时删</span>
    </div>
    ${p.summary
      ? `<div class="proj"><b>项目</b>${esc(p.summary)}${p.stack ? `<span class="sep">·</span>${esc(p.stack)}` : ''}${p.goals ? `<span class="sep">·</span>目标：${esc(p.goals)}` : ''}</div>`
      : '<p class="hint">还没记下项目。跟它说「我在做一个 X，用 Y，想做到 Z」，它就会记下来。</p>'}
    ${needs.length
      ? `<ul class="need-list">${needs.map((n) => `<li class="need">
        <span class="need-topic">${esc(n.topic)}</span>
        ${n.detail ? `<span class="need-detail">${esc(n.detail)}</span>` : ''}
        <span class="need-kw">${(n.keywords || []).slice(0, 6).map((k) => `<em>${esc(k)}</em>`).join('')}</span>
        <button type="button" class="mini" data-act="need-del" data-id="${esc(n.id)}">删</button>
      </li>`).join('')}</ul>`
      : ''}
    <div class="need-add">
      <input id="needInput" type="text" placeholder="也可以直接写一条：比如「想找能把精灵图批量转法线贴图的工具」" spellcheck="false" />
      <button type="button" class="btn quiet" data-act="need-add">记下</button>
    </div>
  </section>`;
}

function msgHTML(m, i, total, busy) {
  if (m.role === 'user') return `<div class="msg user">${esc(m.content)}</div>`;
  const streaming = busy && i === total - 1 && !m.content;
  if (streaming) return `<div class="msg ai"><div class="stream" id="streamBox">${esc(S.chat.stream)}</div><i class="caret"></i></div>`;
  const parts = splitThink(m.content);
  const think = parts.think
    ? `<details class="think"><summary>思考过程</summary><div class="think-body">${esc(parts.think)}</div></details>`
    : '';
  const src = Array.isArray(m.web) && m.web.length
    ? `<div class="msrc"><span class="msrc-label">联网搜到</span>${m.web.slice(0, 4).map((w) =>
        `<a class="msrc-item" data-ext="1" href="${esc(w.url)}" title="${esc(w.title || '')}">${esc(w.host || hostOf(w.url))}</a>`).join('')}</div>`
    : '';
  return `<div class="msg ai"><div class="prose">${think}${window.renderMarkdown(parts.body)}</div>${src}</div>`;
}

async function renderChat(host) {
  const prof = await ensureProfile();
  S.chat.hasKey = !!(S.state && S.state.config && S.state.config.hasKey);
  if (S.state && S.state.config) S.chat.model = S.state.config.model || S.chat.model;
  const msgs = S.chat.msgs || [];
  const busy = S.chat.busy;
  host.innerHTML = `${stampLine()}
    <div class="chat-head">
      <h1>对话</h1>
      <span class="hint">模型 ${esc(S.chat.model || S.state.config.model)} · 材料来自本机采集，${S.state.config.webSearch !== false ? '联网搜索开' : '不联网'}</span>
    </div>
    ${S.chat.hasKey ? '' : '<div class="notice">还没填 API key。填了就能在这里问，回答会参考今天的采集材料。<button type="button" class="mini" data-act="goto-settings">去设置</button></div>'}
    ${needsPanel(prof)}
    <section class="thread" id="thread">
      ${msgs.length ? msgs.map((m, i) => msgHTML(m, i, msgs.length, busy)).join('') : '<p class="hint thread-empty">还没有对话。可以从下面挑一个问题，或者直接说你在做什么项目。</p>'}
    </section>
    <div class="composer">
      <textarea id="chatInput" rows="3" placeholder="问点什么，或者说说你在做的项目、卡在哪……（Enter 发送，Shift+Enter 换行）" spellcheck="false"></textarea>
      <div class="composer-foot">
        <button type="button" class="btn primary" data-act="chat-send"${busy || !S.chat.hasKey ? ' disabled' : ''}>${busy ? '回答中…' : '发送'}</button>
        <button type="button" class="btn quiet" data-act="chat-clear">清空今天的对话</button>
        <button type="button" class="btn quiet webtog${S.state.config.webSearch !== false ? ' on' : ''}" data-act="web-toggle">${S.state.config.webSearch !== false ? '🔎 联网 · 开' : '🔎 联网 · 关'}</button>
      </div>
      <div class="qgroups">${CHAT_GROUPS.map((g) => `<div class="qgroup">
        <div class="qglabel">${esc(g.label)}</div>
        ${g.items.map((q) => `<button type="button" class="qchip" data-act="ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}
      </div>`).join('')}</div>
      <p class="hint tpl" id="tplHint" hidden></p>
      <p class="hint">你描述的项目与需求会自动记进 state/profile.json，简报页尾的「猜你需要」就按它来筛。不想看那块，点它的「关闭这块」。</p>
    </div>`;
  const th = document.getElementById('thread');
  if (th) {
    th.scrollTop = th.scrollHeight;
    th.querySelectorAll('.msg.ai').forEach((el) => { enhanceAnswer(el); linkTerms(el); });
    if (busy) { const box = $('#streamBox'); if (box) box.textContent = S.chat.stream; }
  }
  updateTplHint();
}

/** 输入太短时给两条能直接套的模板，点一下就填进输入框 */
function updateTplHint() {
  const input = $('#chatInput');
  const hint = $('#tplHint');
  if (!input || !hint) return;
  const v = input.value.trim();
  if (v.length >= 8) { hint.hidden = true; return; }
  const tpl = [
    v ? `「${v}」我不懂，用一句话解释，再打个比方。` : '我在做 __，用的是 __，卡在 __。',
    v ? `帮我就「${v}」给三个能今晚动手的做法。` : '这周的材料里，哪三个最值得我花时间？',
  ];
  hint.hidden = false;
  hint.innerHTML = `话可以再具体点。比如：${tpl.map((t) => `<button type="button" class="mini" data-act="fill" data-q="${esc(t)}">${esc(t)}</button>`).join('')}`;
}

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t || S.chat.busy) return;
  if (!S.chat.hasKey) { toast('先去「设置」填一个 API key。'); setView('settings'); return; }
  S.chat.busy = true;
  S.chat.stream = '';
  S.chat.msgs.push({ role: 'user', content: t });
  S.chat.msgs.push({ role: 'assistant', content: '' });
  renderView();
  jobStart('chat', '正在回答', { en: 'Chat', live: true, stallAfter: 40, step: S.state.config.webSearch !== false ? '先联网搜一下，再交给模型' : '等模型开口' });
  let res;
  try {
    res = await api.chatSend(t);
  } catch (e) {
    res = { ok: false, error: e.message || String(e) };
  }
  jobEnd('chat', !!(res && res.ok), res && res.ok ? '回答完了' : (res?.error || '发送失败'));
  S.chat.busy = false;
  if (res && res.ok) {
    S.chat.msgs[S.chat.msgs.length - 1].content = res.reply || S.chat.stream;
    if (Array.isArray(res.web)) S.chat.msgs[S.chat.msgs.length - 1].web = res.web;
  } else {
    S.chat.msgs.splice(-2, 2);
    toast(res?.error || '发送失败', true);
  }
  renderView();
  const th = document.getElementById('thread');
  if (th) th.scrollTop = th.scrollHeight;
}

async function reloadProfile(profile) {
  S.chat.profile = profile || (await api.profileLoad());
  S.chat.loaded = true;
  if (S.view === 'chat') renderView();
}

/** 设置页里那行「今天用了多少、大约多少钱」 */
function usageLine() {
  const u = S.usage;
  if (!u) return '还没有调用记录。每次调用模型都会自动记下 token 数。';
  const t = u.today || { prompt: 0, completion: 0, calls: 0 };
  const a = u.total || { prompt: 0, completion: 0, calls: 0 };
  const tk = (x) => num(Math.round((x.prompt || 0) + (x.completion || 0)));
  const head = `今天 ${tk(t)} tokens / ${num(t.calls)} 次调用，累计 ${tk(a)} tokens / ${num(a.calls)} 次。`;
  if (!u.priced) return head + '填上单价就能算出实际花了多少钱。';
  const money = (x) => (x < 0.01 ? '$' + x.toFixed(4) : '$' + x.toFixed(2));
  return head + `按你填的单价估：今天约 ${money(t.cost)}，累计约 ${money(a.cost)}。`;
}

async function doKeyTest() {
  const box = $('#keyResult');
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  if (box) { box.hidden = false; box.className = 'key-result'; box.textContent = '正在测，最多等 30 秒…'; }
  let r;
  try {
    r = await api.keyTest({ baseUrl: val('s-base'), model: val('s-model'), apiKey: val('s-key') });
  } catch (e) {
    r = { ok: false, reason: '发不出去', hint: String(e.message || e) };
  }
  if (!box) return;
  if (r && r.ok) {
    box.className = 'key-result ok';
    box.textContent = r.hint || `通了（${r.ms} ms）。`;
    if (S.usage === null) S.usage = await api.usage();
  } else {
    box.className = 'key-result bad';
    box.innerHTML = `<b>${esc((r && r.reason) || '失败')}</b>${r && r.hint ? '：' + esc(r.hint) : ''}`
      + (r && r.raw ? `<div class="raw">${esc(String(r.raw).slice(0, 300))}</div>` : '');
  }
}

function renderSettings(host) {
  const c = S.state.config;
  host.innerHTML = `
    ${stampLine()}
    <div class="radar-head"><h1>设置</h1><span class="count">接口、定时采集、提醒与本机数据</span></div>
    <div class="field">
      <label for="s-base">API 服务地址</label>
      <div class="control">
        <input id="s-base" type="text" value="${esc(c.baseUrl)}" spellcheck="false" />
        <div class="hint">任何兼容 OpenAI 的接口都行，例如 https://api.deepseek.com 。</div>
      </div>
    </div>
    <div class="field">
      <label for="s-model">模型</label>
      <div class="control">
        <input id="s-model" type="text" value="${esc(c.model)}" spellcheck="false" />
        <div class="hint">写简报用。你常用的那个就行——这是写文章，不是做推理难题。</div>
      </div>
    </div>
    <div class="field">
      <label for="s-key">API key</label>
      <div class="control">
        <div class="inline">
          <input id="s-key" type="password" placeholder="${c.hasKey ? '已保存 ' + esc(c.keyHint) + '，要换就输入新的' : '还没填'}" spellcheck="false" style="max-width:260px" />
          <button class="btn quiet" data-act="test-key">测一下</button>
          <button class="btn quiet" data-act="no-key">我没有 key</button>
          ${c.hasKey ? '<button class="btn quiet" data-act="clear-key">清除</button>' : ''}
        </div>
        <div id="keyResult" class="key-result" hidden></div>
        <div id="keyhelp" class="keyhelp" hidden>
          ${KEY_STEPS.map(([t, d], i) => `<p><b>${i + 1}. ${esc(t)}</b>${esc(d)}</p>`).join('')}
          <p class="hint">填完先点上面的「测一下」，通了再点下面「保存设置」。</p>
        </div>
        <div class="hint">只存在本机 app/config.json，不上传。不填也能用——在 DSH 里让 agent 写，那条路还能联网核实。</div>
      </div>
    </div>
    <div class="field">
      <label>每天自动采集</label>
      <div class="control">
        <div class="inline">
          <label class="check"><input id="s-sched" type="checkbox" ${c.scheduleEnabled ? 'checked' : ''} /> 开着（窗口最小化也生效）</label>
          <input id="s-time" type="time" value="${esc(c.scheduleTime)}" style="max-width:120px" />
        </div>
        <div class="hint">只做采集，不花 token。生成简报仍然由你点。系统计划任务 AI-Radar-Collect 也还在跑，两套不冲突。</div>
      </div>
    </div>
    <div class="field">
      <label>猜你需要</label>
      <div class="control">
        <div class="inline">
          <label class="check"><input id="s-match" type="checkbox" ${c.matchEnabled !== false ? 'checked' : ''} /> 在简报页尾按你记下的需求筛材料</label>
          <button type="button" class="btn quiet" data-act="goto-chat">编辑需求</button>
        </div>
        <div class="hint">需求来自「对话」里你描述的项目与问题，也存在 state/profile.json。关掉之后简报页尾不再出现这一块；随时可以打开。</div>
      </div>
    </div>
    <div class="field">
      <label>推送提醒</label>
      <div class="control">
        <div class="inline">
          <label class="check"><input id="s-push" type="checkbox" ${c.pushDaily !== false ? 'checked' : ''} /> 每天早上第一次打开时，弹一条「今天的简报好了」</label>
        </div>
        <div class="hint">一天只弹一次，8 点之后才弹；没有简报就只报采集条数。系统通知本身可以在 Windows 里静音，不影响这里。</div>
      </div>
    </div>
    <div class="field">
      <label>AI 摘要</label>
      <div class="control">
        <div class="inline">
          <label class="check"><input id="s-sum" type="checkbox" ${c.summaryAll ? 'checked' : ''} /> 在「原始雷达」每一栏顶上显示「摘一遍」按钮</label>
        </div>
        <div class="hint">默认关着：摘要会花钱，而且大多数时候你只要看排序就够了。打开后是手动点，不会自动烧。</div>
      </div>
    </div>
    <div class="field">
      <label>界面</label>
      <div class="control">
        <div class="inline">
          <label class="check"><input id="s-compact" type="checkbox" ${c.compact !== false ? 'checked' : ''} /> 简洁模式：收起灰字说明、代码与思考过程</label>
        </div>
        <div class="hint">关掉就是把那些说明、安装命令和模型自带的思考过程重新摊开。</div>
      </div>
    </div>
    <div class="field">
      <label>过渡动画</label>
      <div class="control">
        <div class="seg" role="radiogroup" aria-label="过渡动画">
          ${[['on', '开'], ['system', '跟随系统'], ['off', '关']].map(([k, label]) =>
            `<button class="segbtn${motionPref() === k ? ' on' : ''}" type="button" role="radio" aria-checked="${motionPref() === k}" data-act="motion" data-motion="${k}">${label}</button>`).join('')}
        </div>
        <div class="hint keep">换页、换标签页、切换深浅色时的过渡。「跟随系统」在 Windows 关掉「动画效果」时也会关掉这里。点一下立即生效，只记在这台电脑上。</div>
      </div>
    </div>
    <div class="field">
      <label>联网搜索</label>
      <div class="control">
        <div class="inline">
          <label class="check"><input id="s-web" type="checkbox" ${c.webSearch !== false ? 'checked' : ''} /> 对话时先联网搜一次，把结果当材料</label>
        </div>
        <div class="hint">走 Bing 的 RSS，不用另外的 key。搜的是你这句话本身，结果会标在回答下面（点得开）。关掉就只用本机采集的材料——更快、更便宜，但新发布的东西它不知道。</div>
      </div>
    </div>
    <div class="field">
      <label>花费估算</label>
      <div class="control">
        <div class="inline">
          <input id="s-pin" type="number" step="0.01" min="0" value="${esc(c.priceIn || 0)}" max-width="90" style="max-width:100px" />
          <span class="hint" style="margin:0">输入价 $/M tokens</span>
          <input id="s-pout" type="number" step="0.01" min="0" value="${esc(c.priceOut || 0)}" style="max-width:100px" />
          <span class="hint" style="margin:0">输出价 $/M tokens</span>
        </div>
        <div class="hint usage-line">${usageLine()}</div>
      </div>
    </div>
    <div class="actions" style="margin-top:26px">
      <button class="btn primary" data-act="save">保存设置</button>
      <button class="btn quiet" data-act="open-root">打开数据文件夹</button>
      <button class="btn quiet" data-act="replay-onboard">重新看一遍引导</button>
      <button class="btn quiet" data-act="goto-trans">翻译长文</button>
    </div>
    <div class="field" style="margin-top:34px">
      <label>阅读记录</label>
      <div class="control">
        <div class="inline">
          <span class="hint" style="margin:0">${num(Object.keys(S.aux.read).length)} 条已读 · ${num(Object.keys(S.aux.bookmarks).length)} 条收藏</span>
          <button class="btn quiet" data-act="clear-read">清空已读标记</button>
        </div>
        <div class="hint">点过链接就自动记“已读”，列表里会变灰；「原始雷达」可以只看未读。收藏存在 state/bookmarks.json。</div>
      </div>
    </div>
    <div class="field" style="margin-top:34px">
      <label>历史档案</label>
      <div class="control">
        <div class="inline">
          <span class="hint" style="margin:0">${archiveLine()}</span>
          <button class="btn quiet" data-act="run-archive">更新档案</button>
        </div>
        <div class="hint">最近 3 个月里创建的仓库和上架的模型，一次抓下来存成 data/archive.json，
          让雷达的「近三个月」真的有东西可看。一周跑一次足够，约 30 秒，不花 token。</div>
      </div>
    </div>
    <div class="field" style="margin-top:34px">
      <label>关于</label>
      <div class="control">
        <div class="hint">AI 情报台 v${esc(S.state.appVersion)} · 数据在 ${esc(S.state.root)}</div>
      </div>
    </div>`;
}

function renderSaved(host) {
  if (S.follows === undefined) {
    api.usecaseFollows().then((r) => { S.follows = (r && r.items) || []; if (S.view === 'saved') renderView(); });
    S.follows = [];
  }
  const rows = Object.values(S.aux.bookmarks).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const label = (k) => ({ repo: '项目', model: '模型', news: '新闻', paper: '论文', hn: 'HN', skill: '技能', video: 'B站', zhihu: '知乎' }[k] || '链接');
  host.innerHTML = `${stampLine()}
    <div class="radar-head" style="margin-top:22px"><h1>收藏</h1><span class="count">${rows.length} 条 · ${(S.follows || []).length} 条关注后续</span></div>
    ${(S.follows && S.follows.length) ? `<div style="margin-top:26px">
      <h2 class="src-head">关注后续<span class="hint" style="margin-left:10px;font-weight:400">${S.follows.length} 条记录</span></h2>
      <p class="hint keep" style="margin-top:8px">这些当时没有能直接上手的模板。等它们出现可用形态（有教程、有开源实现、能本地跑）时，会在周报里提一句。</p>
      ${S.follows.map((f) => `<div class="row" data-nav="link" data-url="${esc(f.url)}" data-title="${esc(f.title)}">
        <div class="row-src">${esc(f.kind ? ({ repo: '项目', model: '模型', news: '新闻', paper: '论文', hn: 'HN', video: 'B站', zhihu: '知乎' }[f.kind] || '链接') : '链接')}${f.at ? ' · ' + esc(String(f.at).slice(0, 10)) + ' 记下' : ''}</div>
        <h3 class="row-title"><a href="${esc(f.url)}" data-ext="1" data-url="${esc(f.url)}">${esc(f.title || f.url)}</a></h3>
      </div>`).join('')}
    </div>` : ''}
    <div style="margin-top:18px">${rows.length ? rows.map((b) => `<div class="row${rtClass(b.url)}" data-nav="link" data-url="${esc(b.url)}" data-title="${esc(b.title)}">
      <div class="row-src">${esc(label(b.kind))}${b.date ? ' · ' + esc(b.date) : ''}</div>
      <h3 class="row-title"><a href="${esc(b.url)}" data-ext="1" data-url="${esc(b.url)}">${esc(b.title)}</a></h3>
      <div class="row-meta"><button class="mini" type="button" data-act="save" data-url="${esc(b.url)}" data-title="${esc(b.title)}" data-kind="${esc(b.kind)}" data-date="${esc(b.date)}">取消收藏</button></div>
    </div>`).join('') : '<p class="empty-soft">还没有收藏。在「原始雷达」里点任意一条右边的 ★，它就会按收藏时间排在这里。</p>'}</div>`;
}

/* ------------------------------------------------------------------ drawer */

function findRepo(name) {
  const d = dataFor();
  if (!d) return null;
  for (const list of [d.github?.new_repos, d.github?.active, d.github?.ai_new]) {
    for (const r of list || []) if (r.full_name === name) return r;
  }
  return null;
}

function sparkline(series) {
  const W = 460, H = 118, P = 10;
  const vals = series.map((s) => s[1]);
  const rawMin = Math.min(...vals), rawMax = Math.max(...vals);
  // 别把 +2 star 画成陡峭上升：范围太小时按最大值的 0.4% 上下留白，曲线就接近水平
  const span = rawMax - rawMin;
  const padUp = Math.max(span * 0.35, rawMax * 0.004);
  const min = rawMin - padUp, max = rawMax + padUp;
  const n = series.length;
  const px = (i) => P + (n === 1 ? (W - 2 * P) / 2 : (i / (n - 1)) * (W - 2 * P));
  const py = (v) => H - P - (max === min ? 0.5 : (v - min) / (max - min)) * (H - 2 * P);
  const pts = series.map((s, i) => `${px(i).toFixed(1)},${py(s[1]).toFixed(1)}`);
  const line = `M ${pts.join(' L ')}`;
  const area = `${line} L ${px(n - 1).toFixed(1)},${H - P} L ${px(0).toFixed(1)},${H - P} Z`;
  const last = pts[pts.length - 1].split(',');
  return `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="星标历史">
    <path class="spark-area" d="${area}" />
    <path class="spark-line" d="${line}" />
    <circle class="spark-dot" cx="${last[0]}" cy="${last[1]}" r="3.4" />
    <line class="spark-base" x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" />
  </svg>`;
}

function renderDrawer() {
  const el = $('#drawer');
  const d = S.drawer;
  if (!d) { el.hidden = true; el.classList.remove('is-open'); return; }
  const r = d.info || {};
  const series = d.series || [];
  const first = series[0], last = series[series.length - 1];
  const deltas = [];
  for (let i = 1; i < series.length; i++) deltas.push([series[i][0], series[i][1] - series[i - 1][1]]);
  const item = { url: d.url, title: d.name, kind: 'repo', date: r.last_seen || S.date };
  el.innerHTML = `
    <div class="drawer-head">
      <button class="drawer-x" type="button" data-act="close-drawer" aria-label="关闭">×</button>
      <h2 class="drawer-title">${esc(d.name)}</h2>
      <div class="drawer-sub">${r.stars != null ? num(r.stars) + ' stars' : ''}${r.forks != null ? ' · ' + num(r.forks) + ' forks' : ''}${r.lang ? ' · ' + esc(r.lang) : ''}</div>
    </div>
    <div class="drawer-body">
      ${series.length ? `<div class="spark">${sparkline(series)}</div>
        <div class="spark-legend"><span>${esc(first[0])} · ${num(first[1])}</span><span>${esc(last[0])} · ${num(last[1])}</span></div>`
        : '<p class="hint">还没有星标历史。</p>'}
      ${deltas.length
        ? `<div class="delta">${deltas.slice(-8).map(([dt, v]) => `<div><span>${esc(dt)}</span><b class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${num(v)}</b></div>`).join('')}</div>`
        : `<p class="hint" style="margin-top:14px">曲线要攒几天。现在只有 ${series.length} 个数据点——每天采集会自动加一个，明天这里就有斜率了。</p>`}
      ${r.desc ? `<p class="drawer-desc">${esc(r.desc)}</p>` : ''}
      ${(r.topics || []).length ? `<div class="drawer-topics">${r.topics.slice(0, 8).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="drawer-meta">${r.created ? '建立 ' + esc(String(r.created).slice(0, 10)) : ''}${r.created_days_ago != null ? ' · ' + esc(r.created_days_ago) + ' 天前' : ''}${r.pushed_days_ago === 0 ? ' · 今天有提交' : ''}</div>
      <div class="actions">
        ${d.url ? `<button class="btn primary" type="button" data-act="open-ext" data-url="${esc(d.url)}">在 GitHub 打开</button>` : ''}
        <button class="btn quiet" type="button" data-act="save" data-url="${esc(item.url)}" data-title="${esc(item.title)}" data-kind="repo" data-date="${esc(S.date)}">${isSaved(item.url) ? '取消收藏 ★' : '收藏 ★'}</button>
      </div>
      <button class="btn quiet wide" type="button" data-act="dig-deep" data-name="${esc(d.name)}" data-url="${esc(d.url)}">复制「深挖这个项目」指令</button>
      <p class="hint" style="margin-top:12px">粘到 DSH 对话框里，让它读 README、看 issue 和近期提交，回答“它到底解决什么问题、跟我做的像素游戏有什么关系”。</p>
    </div>`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-open'));
}

async function openDetail(name, url) {
  const info = findRepo(name);
  S.drawer = { name, url: (info && info.url) || url, info, series: [] };
  renderDrawer();
  const series = await api.repoHistory(name);
  if (S.drawer && S.drawer.name === name) { S.drawer.series = series; renderDrawer(); }
}

function closeDrawer() {
  const el = $('#drawer');
  el.classList.remove('is-open');
  S.drawer = null;
  setTimeout(() => { if (!S.drawer) el.hidden = true; }, 180);
}

/* ------------------------------------------------------------------ spotlight */

let spotTimer = null;

function openSpot() {
  S.spot = { open: true, q: '', items: [], total: 0, days: 0, sel: 0, webRows: [], webBusy: false, webError: '' };
  $('#spot').hidden = false;
  $('#spotInput').value = '';
  paintSpot();
  setTimeout(() => $('#spotInput').focus(), 10);
}

function closeSpot() {
  S.spot.open = false;
  $('#spot').hidden = true;
}

let spotSeq = 0;

async function runSearch(q) {
  S.spot.q = q;
  if (!q.trim()) { S.spot.items = []; S.spot.total = 0; paintSpot(); return; }
  const my = ++spotSeq;
  const res = await api.search(q);
  if (my !== spotSeq) return; // 上一次的响应晚到了，丢掉，别覆盖当前结果
  S.spot.items = res.items || [];
  S.spot.total = res.total || 0;
  S.spot.days = res.days || 0;
  S.spot.relaxed = !!res.relaxed;
  S.spot.sel = 0;
  paintSpot();
}

function paintSpot() {
  const tokens = tokensOf(S.spot.q);
  const meta = $('#spotMeta');
  const list = $('#spotList');
  if (!S.spot.q.trim()) {
    meta.textContent = S.spot.days ? `已索引 ${S.spot.days} 天` : '输入关键词开始搜。空格分隔＝同时满足。';
    list.innerHTML = '<p class="spot-empty">可以搜：仓库名、项目描述里的词、模型 id、新闻标题、论文摘要、以及你写过简报的正文。</p>';
    return;
  }
  meta.innerHTML = `命中 ${num(S.spot.total)} 条${S.spot.total > S.spot.items.length ? `（显示前 ${S.spot.items.length} 条）` : ''}`
    + (S.spot.relaxed ? ' · 没有全部词都命中的结果，已放宽成任一词' : '')
    + (S.spot.days ? ` · 索引 ${S.spot.days} 天` : '')
    + ' · ↑↓ 选、Enter 打开、Esc 关';
  if (!S.spot.items.length) {
    list.innerHTML = `<p class="spot-empty">没有命中。试试少一个词、或者只用名字的一半，比如 “kimi”。</p>`;
    return;
  }
  list.innerHTML = S.spot.items.map((it, i) => `<button class="spot-row${i === S.spot.sel ? ' is-cur' : ''}" type="button" data-i="${i}">
    <span class="sk">${esc(it.kindLabel)}</span>
    <span class="st">${hl(it.title, tokens)}<em>${hl(it.sub, tokens)}</em></span>
    <span class="sd">${esc(it.date)}</span>
  </button>`).join('');
  const isWebSel = S.spot.sel === S.spot.items.length;
  list.innerHTML += `<button class="spot-row spot-web${isWebSel ? ' is-cur' : ''}" type="button" data-web="1">
      <span class="sk">网络</span>
      <span class="st">在网络上搜「${esc(S.spot.q)}」<em>Bing RSS，只读不写</em></span>
      <span class="sd">${S.spot.webBusy ? '搜…' : 'Enter'}</span>
    </button>`;
  if (S.spot.webRows && S.spot.webRows.length) {
    list.innerHTML += S.spot.webRows.map((w) => `<button class="spot-row" type="button" data-ext="1" data-url="${esc(w.url)}">
      <span class="sk">网页</span>
      <span class="st">${hl(w.title, tokens)}<em>${hl((w.host || '') + ' · ' + (w.desc || ''), tokens)}</em></span>
      <span class="sd"></span>
    </button>`).join('');
  }
  if (S.spot.webError) list.innerHTML += `<p class="spot-empty">${esc(S.spot.webError)}</p>`;
}

async function runWebSearch(q) {
  const query = String(q || '').trim();
  if (!query) return;
  S.spot.webBusy = true;
  S.spot.webRows = [];
  S.spot.webError = '';
  paintSpot();
  try {
    const r = await api.webSearch({ q: query, count: 8 });
    if (r && r.ok) S.spot.webRows = r.rows || [];
    else S.spot.webError = (r && r.error) || '搜索失败';
  } catch (e) {
    S.spot.webError = String(e.message || e);
  }
  S.spot.webBusy = false;
  paintSpot();
}

function openSpotItem(i) {
  const it = S.spot.items[i];
  if (!it) return;
  markRead(it.url);
  if (it.kind === 'concept' && it.conceptId) {
    S.spot.items = [];
    closeSpot();
    setView('concepts');
    setTimeout(() => scrollToConcept(it.conceptId), 260);
    return;
  }
  if (it.kind === 'ext' && it.extId) {
    S.spot.items = [];
    closeSpot();
    S.ext.use = 'all';
    S.ext.host = 'all';
    setView('ext');
    setTimeout(() => {
      const el = document.getElementById(`ext-${it.extId}`);
      if (el) el.scrollIntoView({ block: 'center' });
    }, 320);
    return;
  }
  if (it.url) api.openUrl(it.url);
  S.spot.items = [];
  closeSpot();
}

function markRead(url) {
  if (!url || S.aux.read[url]) return;
  S.aux.read[url] = Date.now();
  api.markRead(url);
}

async function toggleSave(ds) {
  const r = await api.toggleBookmark({ url: ds.url, title: ds.title, kind: ds.kind, date: ds.date });
  if (!r.ok) { toast(r.error || '收藏失败', true); return; }
  S.aux.bookmarks = r.bookmarks || {};
  toast(r.saved ? '已收藏' : '已取消收藏');
  renderView();
}



/* ---------------------------------------- 技能说明书 + 适配助手 */

async function ensureSkillEnv(force = false) {
  if (!force && S.sdoc.env) return S.sdoc.env;
  S.sdoc.envBusy = true;
  try {
    S.sdoc.env = await api.skillEnv(force);
  } catch (e) {
    S.sdoc.env = null;
    toast('读不到本机环境：' + (e.message || e), true);
  }
  S.sdoc.envBusy = false;
  return S.sdoc.env;
}

function yn(v) {
  return v ? '<b class="ok">有</b>' : '<b class="bad">没有</b>';
}

/** 技能标签页顶上的「我的环境」：这决定排行榜里哪些技能现在就能用 */
function envStrip() {
  const e = S.sdoc.env;
  if (!e) {
    return `<section class="envstrip"><div class="env-head"><h2>我的环境</h2>
      <button type="button" class="mini" data-act="env-refresh">${S.sdoc.envBusy ? '检测中…' : '检测一下'}</button></div>
      <p class="hint keep">先检测本机有什么，才知道排行榜里哪些技能装完就能用。</p></section>`;
  }
  const chip = (label, ok, extra) =>
    `<span class="envchip${ok ? ' on' : ' off'}">${esc(label)}${extra ? `<em>${esc(extra)}</em>` : ''}</span>`;
  const roots = (e.roots || []).filter((r) => r.exists);
  const rootText = roots.length
    ? roots.map((r) => `${esc(r.label)} <b>${r.count}</b> 个`).join(' · ')
    : '还没检测到技能目录';
  return `<section class="envstrip">
    <div class="env-head">
      <h2>我的环境</h2>
      <span class="hint">${esc(e.os)}${e.checkedAt ? ' · ' + esc(new Date(e.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })) : ''}</span>
      <button type="button" class="mini" data-act="env-refresh">${S.sdoc.envBusy ? '检测中…' : '重新检测'}</button>
    </div>
    <div class="envchips">
      ${chip('Node ' + (e.node.version || ''), e.node.present)}
      ${chip('Python ' + (e.python.present ? e.python.version : ''), e.python.present)}
      ${chip('git ' + (e.git.version || ''), e.git.present)}
      ${chip('Docker', e.docker.present)}
      ${chip('bash', e.bash.present)}
      ${(e.agents || []).map((a) => chip(a.label, a.present)).join('')}
    </div>
    <p class="hint keep">${e.python.present ? '' : '没有 Python：带 .py 脚本的技能（anthropics 的 pdf / xlsx 那类）现在装了也跑不动。'}技能装在这几处：${rootText}。</p>
  </section>`;
}

function sdocError(d) {
  const cands = (d.candidates || [])
    .map((p) => `<li><button type="button" class="mini" data-act="skill-doc-path" data-source="${esc(d.source)}" data-path="${esc(p)}">${esc(p)}</button></li>`)
    .join('');
  const repo = d.source
    ? `<a data-ext="1" href="https://github.com/${esc(d.source)}">github.com/${esc(d.source)}</a>`
    : '';
  return `<div class="sdoc-err">${esc(d.error || '读不到这个技能。')}
    ${cands ? `<p class="hint keep">这个仓库里有这些 SKILL.md，点一个看：</p><ul class="sdoc-cands">${cands}</ul>` : ''}
    ${repo ? `<p class="hint keep">也可以直接翻仓库：${repo}</p>` : ''}</div>`;
}

function renderSkillDoc() {
  const box = $('#sdocBox');
  if (!box) return;
  const d = S.sdoc.data;
  if (S.sdoc.busy && !d) {
    box.innerHTML = '<div class="sdoc-head"><h2>正在读这个技能…</h2><button type="button" class="sdoc-x" data-act="sdoc-close">×</button></div><p class="hint keep">第一次读要拉文件清单和 SKILL.md，通常 1–2 秒；改过目录结构的仓库会慢一些。</p>';
    return;
  }
  if (!d) { box.innerHTML = ''; return; }
  if (!d.ok) {
    box.innerHTML = `<div class="sdoc-head"><h2>${esc(S.sdoc.source || '')}</h2><button type="button" class="sdoc-x" data-act="sdoc-close">×</button></div>${sdocError(d)}`;
    return;
  }

  const fit = d.fit || {};
  const needRows = (fit.needs || []).map((n) => `<li class="${n.present ? 'ok' : 'miss'}">
      <span class="need-label">${esc(n.label)}</span>
      <span class="need-state">${n.present === true ? '本机有' : n.present === false ? '本机没有' : '无法判断'}</span>
      <span class="need-why">${esc(n.why)}</span>
      ${n.present === false ? `<span class="need-fix">${esc(n.fix)}</span>` : ''}
    </li>`).join('');

  const shape = (d.shapeLines || []).map((x) => `<div class="trow"><span class="tlabel">${esc(x.k)}</span><span class="ttext">${esc(x.v)}</span></div>`).join('');

  const steps = (d.steps || []).map((st, i) => `<div class="sstep ${st.tone || ''}">
      <span class="sstep-k">${i + 1} · ${esc(st.k)}</span>
      <pre class="sstep-v">${esc(st.v)}</pre>
      ${st.tone === 'code' ? `<button type="button" class="mini" data-act="copy-text" data-text="${esc(String(st.v).split('\n')[0])}">复制</button>` : ''}
    </div>`).join('');

  const installed = (d.installed || []).length
    ? d.installed.map((x) => `<li><b class="ok">已装</b> ${esc(x.rootLabel)}<br /><code class="cmd-code">${esc(x.dir)}</code>
        <button type="button" class="mini" data-act="skill-open-dir" data-dir="${esc(x.dir)}">打开文件夹</button></li>`).join('')
    : '<li class="miss"><b class="bad">没检测到</b> 上面那些技能目录里都没有它。装完点「重新检查」。</li>';

  const firstDir = (d.installed && d.installed[0] && d.installed[0].dir) || '';

  box.innerHTML = `
    <div class="sdoc-head">
      <div>
        <h2>${esc(d.id)}</h2>
        <p class="sdoc-src">${esc(d.source)} · <a data-ext="1" href="${esc(d.repoUrl)}">仓库</a> · 说明文件 <code>${esc(d.path || '')}</code></p>
      </div>
      <button type="button" class="sdoc-x" data-act="sdoc-close">×</button>
    </div>
    <div class="sdoc-body">
      <section class="sdoc-sec">
        <h3><span>1</span>能帮我做什么</h3>
        <p class="sdoc-lead">${esc(d.description || d.what || '作者没写描述。')}</p>
        ${d.what && d.what !== d.description ? `<div class="sdoc-note">${esc(d.what)}</div>` : ''}
        ${d.example
          ? `<div class="sdoc-example"><span class="ex-label">作者给的示例</span><pre>${esc(d.example)}</pre></div>`
          : '<p class="hint keep">作者没给成品示例 —— 这本身就是个信号：只能靠描述判断它值不值得装。</p>'}
      </section>

      <section class="sdoc-sec">
        <h3><span>2</span>我能不能用</h3>
        <p class="sdoc-verdict ${esc(fit.verdict || '')}">${esc(fit.summary || '')}</p>
        ${needRows ? `<ul class="needlist">${needRows}</ul>` : '<p class="hint keep">没识别出额外依赖。</p>'}
        ${shape ? `<div class="sdoc-shape">${shape}</div>` : ''}
        <p class="hint keep">${d.copyOnly
          ? '这个技能只有说明文件，把 SKILL.md 放进技能目录就够。'
          : '这个技能是「说明 + 脚本 + 资源」三件套：<b>只把说明复制进聊天框用不了</b>，脚本和资源要一起落到技能目录里。'}</p>
      </section>

      <section class="sdoc-sec">
        <h3><span>3</span>怎么开始</h3>
        ${steps}
      </section>

      <section class="sdoc-sec">
        <h3><span>4</span>装好了吗</h3>
        <ul class="instlist">${installed}</ul>
        <div class="sdoc-verify">
          <span class="ex-label">用一句话验证它真的接上了</span>
          <pre>${esc(d.verifyPrompt)}</pre>
          <button type="button" class="mini" data-act="copy-text" data-text="${esc(d.verifyPrompt)}">复制这句</button>
        </div>
        <div class="sdoc-actions">
          <button type="button" class="btn quiet" data-act="skill-recheck" data-source="${esc(d.source)}" data-id="${esc(d.id)}">重新检查</button>
          <button type="button" class="btn quiet" data-act="skill-open-dir" data-dir="${esc(firstDir)}">打开安装目录</button>
        </div>
      </section>

      <section class="sdoc-sec">
        <h3><span>5</span>不想用了</h3>
        <p class="hint keep">先禁用（改名，随时能开回来）；真不要了再卸载 —— 卸载是移到回收站，不是删除。</p>
        <div class="sdoc-actions">
          <button type="button" class="btn quiet" data-act="skill-act" data-action="disable" data-dir="${esc(firstDir)}">禁用</button>
          <button type="button" class="btn quiet" data-act="skill-act" data-action="enable" data-dir="${esc(firstDir)}">重新启用</button>
          <button type="button" class="btn quiet" data-act="skill-act" data-action="uninstall" data-dir="${esc(firstDir)}">卸载到回收站</button>
        </div>
        <p class="hint keep">想回到作者版本：重新跑一遍安装命令就会覆盖（<code>${esc(d.installCmd)}</code>）。</p>
      </section>
    </div>`;
}

async function openSkillDoc(source, id, path) {
  S.sdoc.open = true;
  S.sdoc.busy = true;
  S.sdoc.data = null;
  S.sdoc.err = '';
  S.sdoc.source = source;
  const el = $('#sdoc');
  if (el) { el.hidden = false; el.classList.add('is-open'); }
  renderSkillDoc();
  await ensureSkillEnv();
  try {
    S.sdoc.data = await api.skillDoc({ source, id, path });
  } catch (e) {
    S.sdoc.data = { ok: false, error: String(e.message || e), source };
  }
  S.sdoc.busy = false;
  renderSkillDoc();
}

function closeSkillDoc() {
  S.sdoc.open = false;
  const el = $('#sdoc');
  if (!el) return;
  el.classList.remove('is-open');
  setTimeout(() => { el.hidden = true; }, 160);
}

/* ------------------------------------------------------------------ actions */

async function loadState() {
  S.state = await api.state();
  if (!S.date) S.date = S.state.today;
  renderRail();
}

async function loadData(date) {
  if (S.dataDate === date && S.data) return S.data;
  S.data = await api.data(date);
  S.dataDate = date;
  return S.data;
}

async function refresh() {
  await loadState();
  S.dataDate = '';
  await loadData(S.date);
  S.aggKey = '';
  if (S.range !== 'today') await loadAgg(S.range);
  renderRail();
  renderView();
}

async function doCollect() {
  if (S.collecting) return;
  const r = await api.collect();
  if (!r.ok) { toast(r.error || '启动失败', true); return; }
  S.collecting = true;
  const log = $('#log');
  log.hidden = false;
  log.textContent = '';
  startCollectJob('启动采集器…');
  renderRail();
}

/* 采集的进度卡片：采集器每抓完一个源打一行「[radar] step k/12 名称」 */
function startCollectJob(step) {
  jobStart('collect', '正在采集今天的资讯', { en: 'Collect', total: 12, live: true, stallAfter: 30, step });
}

function collectProgress(line) {
  if (!jobRunning('collect')) startCollectJob('');
  const m = /\[radar\] step (\d+)\/(\d+) (.+)/.exec(line);
  if (m) { jobBeat('collect', `${m[3]} 抓完了`, Number(m[1])); return; }
  const t = String(line).replace(/^\[radar\]\s*/, '');
  if (/^collecting/.test(t)) jobBeat('collect', '开始抓取各个数据源…');
  else if (/^done/.test(t)) jobBeat('collect', '写入今天的数据文件');
  else if (/^counts/.test(t)) jobBeat('collect', '统计条目数');
  else if (/^failed sources/.test(t)) jobBeat('collect', '有源没抓到：' + t.replace(/^failed sources:\s*/, ''));
  else jobBeat('collect', t.slice(0, 80));
}

function appendLog(line, kind) {
  const log = $('#log');
  log.hidden = false;
  const span = document.createElement('div');
  span.textContent = line;
  if (kind) span.className = kind;
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

async function doGenerate() {
  if (S.generating) return;
  if (!S.state.config.hasKey) { toast('先去「设置」填一个 API key。', true); setView('settings'); return; }
  S.generating = true;
  renderView();
  const res = await withJob('generate', '正在生成今天的简报', { en: 'Brief', expect: 40, step: '模型在读今天的原件，一般 20–60 秒' },
    () => api.generate(S.date));
  S.generating = false;
  if (res.ok) {
    toast(`简报写好了，${res.seconds} 秒。`);
    await refresh();
    S.digest = res.markdown;
  } else {
    toast(res.error || '生成失败', true);
    renderView();
  }
}

/* ------------------------------------------ 术语卡 / 译中 / 回答增强 */

const TERM_SKIP = new Set(['A', 'CODE', 'PRE', 'BUTTON', 'KBD', 'SCRIPT', 'STYLE']);

async function ensureTerms() {
  if (S.concepts) return S.concepts;
  const c = await api.concepts();
  S.concepts = c || null;
  return S.concepts;
}

/** 概念词表：中文名 + 英文名，长的先匹配（避免「Agent」先吃掉「Agent Skill」） */
function termAliases() {
  const list = (S.concepts && S.concepts.concepts) || [];
  const out = [];
  const CJK = /[\u4e00-\u9fa5]/;
  // 两个字的中文词（工具/参数/温度/路径/本地）在正文里太常见，铺满下划线反而吵；
  // 只留「一词一义」的短词，其余靠 Ctrl+K 与概念页查。
  const SHORT_OK = new Set(['mcp', 'llm', 'token', 'agent', 'skill', 'prompt', 'json', 'gui', 'cli']);
  for (const c of list) {
    for (const n of [c.term, c.en]) {
      if (!n) continue;
      const t = String(n);
      if (t.length < 2) continue;
      if (CJK.test(t) && t.length < 3 && !SHORT_OK.has(c.id)) continue;
      out.push({ id: c.id, text: t });
    }
  }
  out.sort((a, b) => b.text.length - a.text.length);
  return out;
}

/** 把已知概念词包成可点的按钮：简报正文、模型回答都用同一套 */
function linkTerms(root) {
  if (!root) return;
  const aliases = termAliases();
  if (!aliases.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || TERM_SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest('.term, .msg.user, code, pre, a, .cmd-code')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue || '';
    if (text.length < 2) continue;
    let html = '';
    let i = 0;
    let hit = false;
    while (i < text.length) {
      let matched = null;
      for (const a of aliases) {
        const seg = text.slice(i, i + a.text.length);
        if (seg.toLowerCase() === a.text.toLowerCase()) { matched = a; break; }
      }
      if (matched) {
        html += `<button type="button" class="term" data-act="term" data-id="${esc(matched.id)}">${esc(text.slice(i, i + matched.text.length))}</button>`;
        i += matched.text.length;
        hit = true;
      } else {
        html += esc(text[i]);
        i += 1;
      }
    }
    if (hit) {
      const span = document.createElement('span');
      span.innerHTML = html;
      node.parentNode.replaceChild(span, node);
    }
  }
}

async function showTerm(id, anchor) {
  await ensureTerms();
  const c = ((S.concepts && S.concepts.concepts) || []).find((x) => x.id === id);
  const card = $('#termcard');
  if (!c || !card) return;
  card.innerHTML = `<div class="tc-head">
      <b>${esc(c.term)}</b><span class="term-en">${esc(c.en || '')}</span>
      <button class="tc-x" type="button" data-act="term-close" aria-label="关闭">×</button>
    </div>
    <p class="tc-one">${esc(c.plain || c.pro || '')}</p>
    <p class="tc-line"><i>专业</i>${esc(c.pro || '')}</p>
    <p class="tc-line"><i>案例</i>${esc(c.case || '')}</p>
    <button class="mini" type="button" data-act="term-more" data-id="${esc(c.id)}">看整页概念</button>`;
  card.hidden = false;
  // 出现在被点的词附近：优先下方，放不下就翻到上方
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  let left = r ? r.left - 24 : (window.innerWidth - w) / 2;
  left = Math.max(16, Math.min(left, window.innerWidth - w - 16));
  let top = r ? r.bottom + 10 : 110;
  if (top + h > window.innerHeight - 16) top = Math.max(48, (r ? r.top : 200) - h - 10);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

const closeTerm = () => { const c = $('#termcard'); if (c) c.hidden = true; };

/** 模型回答里：代码块给「复制」，外链标域名 */
function enhanceAnswer(root) {
  if (!root) return;
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code')) return;
    const code = pre.querySelector('code');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini copy-code';
    btn.textContent = '复制';
    btn.dataset.act = 'copy-code';
    btn.dataset.text = String((code ? code.textContent : pre.textContent) || '').slice(0, 4000);
    pre.appendChild(btn);
  });
  root.querySelectorAll('a[href]').forEach((a) => {
    if (a.closest('.msrc')) return; // 来源行本来就只显示域名
    try {
      const u = new URL(a.getAttribute('href'));
      if (!/^https?:$/.test(u.protocol)) return;
      if ((a.textContent || '').includes(u.host)) return;
      const span = document.createElement('span');
      span.className = 'dom';
      span.textContent = u.host.replace(/^www\./, '');
      a.after(span);
    } catch {}
  });
}

const transOf = (url) => S.trans[url] || null;

/** 一条英文描述点「中」→ 让模型翻一句，翻过的会缓存，再点切回原文 */
async function doTrans(el) {
  const text = el.dataset.text || '';
  const url = el.dataset.url || text;
  if (!text) return;
  const have = S.trans[url];
  if (have) { have.show = !have.show; renderView(); return; }
  el.textContent = '译中…';
  el.disabled = true;
  try {
    const r = await api.transOne(text);
    if (r.ok && r.zh) { S.trans[url] = { zh: r.zh, show: true }; renderView(); }
    else {
      toast(r.needKey ? '先在设置里填 API key，才能让它翻译。' : (r.error || '翻译失败'), true);
      renderView();
    }
  } catch (e) {
    toast('翻译失败：' + (e.message || e), true);
    renderView();
  }
}

function transBtn(url, text) {
  const have = transOf(url);
  return `<button class="mini trans" type="button" data-act="trans" data-url="${esc(url)}" data-text="${esc(String(text || '').slice(0, 600))}"
    title="${have ? (have.show ? '看英文原文' : '看中文译文') : '翻成中文（要 API key，翻过的会记住）'}">${have ? (have.show ? '原' : '中') : '中'}</button>`;
}

/* ------------------------------------------------------- AI 摘要（可开关） */

function summaryBlock() {
  if (!S.state || S.state.config.summaryAll !== true) return '';
  const key = `${S.date}|${S.radarTab}`;
  const text = S.summary[key];
  return `<section class="ai-sum">
    <div class="as-head">
      <b>AI 摘要</b>
      <span class="hint">把这一栏压成 5 条判断；点一次花一点钱，结果会存下来</span>
      <button class="mini" type="button" data-act="summarize">${text ? '重新摘一遍' : '摘一遍'}</button>
    </div>
    ${text ? `<div class="prose">${window.renderMarkdown(text)}</div>` : ''}
  </section>`;
}

async function doSummarize() {
  const key = `${S.date}|${S.radarTab}`;
  const r = await withJob('summary', '正在摘要这一栏', { en: 'Summary', expect: 20, step: '模型在读这一栏，一般 10–30 秒' },
    () => api.summaryTab({ date: S.date, tab: S.radarTab }));
  if (r.ok) { S.summary[key] = r.text; renderView(); }
  else toast(r.needKey ? '要先在设置里填 API key。' : (r.error || '摘要失败'), true);
}

/* ------------------------------------------------------------------ 周报 */

async function renderWeekly(host) {
  if (!S.weekly) S.weekly = await api.weeklyRead();
  const md = S.weekly && S.weekly.md;
  const body = md ? md.replace(/^#\s*周报[^\n]*\n+/, '').trim() : '';
  host.innerHTML = `${stampLine()}
    <div class="radar-head" style="margin-top:22px"><h1>周报</h1><span class="count">${esc((S.weekly && S.weekly.key) || '')} · 只读本机最近 7 天</span></div>
    ${body
      ? `<div class="prose digest-body" style="margin-top:20px">${window.renderMarkdown(body)}</div>`
      : `<p class="hint" style="margin-top:22px">这周还没生成。它会把最近 7 天的采集数据拼成一份「真正变了什么 + 今晚能做的一件事」，不联网、不编数。</p>`}
    <div class="actions" style="margin-top:26px">
      <button class="btn ${body ? 'quiet' : 'primary'}" data-act="weekly-build">${body ? '重新生成这周的周报' : '生成本周周报'}</button>
    </div>`;
  linkTerms(host);
}

async function doWeekly() {
  const r = await withJob('weekly', '正在写周报', { en: 'Weekly', expect: 30, step: '汇总最近 7 天，一般 20–40 秒' }, () => api.weeklyBuild());
  if (r && r.ok) { S.weekly = { key: r.key, md: r.md }; toast('周报写好了'); renderView(); }
  else toast((r && r.error) || '生成失败', true);
}

/* --------------------------------------------------------------- 模板库 */

async function ensureTplLib(force) {
  if (S.tplLib && !force) return S.tplLib;
  try {
    const j = await api.tmplList();
    S.tplLib = {
      rules: (j && j.rules) || '',
      templates: (j && j.templates) || [],
      log: (j && j.log) || {},
      mine: (j && j.mine) || {},
    };
  } catch (e) {
    S.tplLib = { rules: '', templates: [], log: {}, mine: {}, error: String(e.message || e) };
  }
  return S.tplLib;
}

const tplById = (id) => ((S.tplLib && S.tplLib.templates) || []).find((t) => t.id === id) || null;

function tplOpen(id) {
  const t = tplById(id);
  if (!t) return;
  const values = {};
  for (const f of t.fields || []) {
    const def = f.type === 'choice' ? (f.default || (f.options && f.options[0]) || '') : '';
    values[f.key] = def;
  }
  S.tpl = { id, values, out: '', busy: false, seconds: 0, prompt: '', err: '', stream: '' };
  setView('tasks');
}

/** 从 DOM 读回输入框的值（避免每次输入都整页重渲染、失焦点） */
function readTplForm() {
  if (!S.tpl) return;
  const root = document.getElementById('view');
  if (!root) return;
  for (const el of root.querySelectorAll('[data-tplfield]')) {
    S.tpl.values[el.dataset.tplfield] = el.value;
  }
}

let tplPreviewSeq = 0;
let tplPreviewTimer = 0;
function schedulePreview() {
  clearTimeout(tplPreviewTimer);
  tplPreviewTimer = setTimeout(() => { void refreshPreview(); }, 250);
}

async function refreshPreview() {
  if (!S.tpl) return;
  readTplForm();
  const my = ++tplPreviewSeq;
  try {
    const r = await api.tmplCompose({ id: S.tpl.id, values: S.tpl.values });
    if (my !== tplPreviewSeq || !S.tpl) return;
    S.tpl.prompt = (r && r.prompt) || '';
    const pre = document.getElementById('tprompt');
    if (pre) pre.textContent = S.tpl.prompt;
  } catch {}
}

function tplFieldHtml(t, f, v) {
  const val = v === undefined ? '' : v;
  const label = `<span class="flabel">${esc(f.label)}${f.required ? '<i class="req">必填</i>' : ''}</span>`;
  if (f.type === 'choice') {
    const opts = f.options || [];
    return `<div class="tfield">
      ${label}
      <div class="tchoice" data-choice="${esc(f.key)}">
        ${opts.map((o) => `<button type="button" class="tchip${o === val ? ' is-on' : ''}"
           data-act="tpl-choice" data-field="${esc(f.key)}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}
      </div>
      ${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}
    </div>`;
  }
  const isUrl = f.type === 'url';
  const rows = isUrl ? 4 : f.rows || 6;
  return `<div class="tfield">
    ${label}
    <textarea class="tarea" rows="${rows}" data-tplfield="${esc(f.key)}"
      placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>
    <span class="frow">
      ${f.sample ? `<button type="button" class="mini" data-act="tpl-sample" data-field="${esc(f.key)}">用示例填一下</button>` : ''}
      ${isUrl ? `<button type="button" class="mini" data-act="tpl-fetch" data-field="${esc(f.key)}">抓取正文</button>` : ''}
      ${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}
    </span>
  </div>`;
}

async function renderTasks(host) {
  const lib = await ensureTplLib();
  if (!lib.templates.length) {
    host.innerHTML = `${stampLine()}<div class="empty"><h1>没读到模板</h1>
      <p>文件应该在 <code>${esc(rootPath('templates.json'))}</code>。</p>
      <p class="hint keep">${esc(lib.error || '')}</p></div>`;
    return;
  }
  if (S.tpl && tplById(S.tpl.id)) return renderTplDetail(host, tplById(S.tpl.id));
  return renderTplList(host, lib);
}

function renderTplList(host, lib) {
  const mineKeys = Object.keys(lib.mine).sort((a, b) => String(lib.mine[b].at || '').localeCompare(String(lib.mine[a].at || '')));
  const mineHtml = mineKeys.length
    ? `<h2 class="tsec">我的版本<span class="tsec-note">存在 state/mytemplates.json，改过模板也能留着</span></h2>
      <div class="tgrid">
        ${mineKeys.map((k) => {
          const m = lib.mine[k];
          return `<div class="tcard mine">
            <div class="tcard-top"><h3>${esc(m.title || '我的模板')}</h3><span class="tcard-tag">存于 ${esc(String(m.at || '').slice(0, 10))}</span></div>
            <p class="tcard-problem">${esc(String(m.prompt || '').slice(0, 110))}…</p>
            <div class="tcard-foot">
              <button type="button" class="mini" data-act="tpl-mine-copy" data-key="${esc(k)}">复制提示词</button>
              <button type="button" class="mini" data-act="tpl-mine-del" data-key="${esc(k)}">删除</button>
            </div>
          </div>`;
        }).join('')}
      </div>`
    : '';

  host.innerHTML = `${stampLine()}
    <div class="radar-head" style="margin-top:22px"><h1>模板库</h1>
      <span class="count">${lib.templates.length} 个模板</span></div>
    <p class="hint keep" style="margin-top:16px;max-width:64ch">挑一个模板，填三格，它就拼成一段能直接用的提示词。
      每页都写了：解决什么问题、需要什么材料、效果示例、作者来源，还有一个「为什么这样问」的展开——
      看完大概能学会自己写。没有材料也没关系，每个模板都有「用示例填一下」。</p>
    ${mineHtml}
    <h2 class="tsec">全部模板<span class="tsec-note">点开填，或者直接复制到别的 AI</span></h2>
    <div class="tgrid">
      ${lib.templates.map((t) => `<button type="button" class="tcard" data-act="tpl-open" data-id="${esc(t.id)}">
        <div class="tcard-top"><h3>${esc(t.title)}</h3><span class="tcard-tag">${esc(t.tag || '')}</span></div>
        <p class="tcard-problem">${esc(t.problem || '')}</p>
        <div class="tcard-foot">
          <span class="tcard-need">${(t.fields || []).length} 格 · ${esc(t.time || '十几秒')}</span>
          <span class="tcard-go">填写</span>
        </div>
      </button>`).join('')}
    </div>`;
}

function renderTplDetail(host, t) {
  const v = S.tpl.values;
  const out = S.tpl.out || '';
  const busy = S.tpl.busy;
  const log = (S.tplLib && S.tplLib.log && S.tplLib.log[t.id]) || null;
  const why = (t.why || []).map((w) => `<div class="whyrow"><span class="whyrow-k">${esc(w.k)}</span><p>${esc(w.v)}</p></div>`).join('');

  host.innerHTML = `${stampLine()}
    <div class="date-nav"><button class="back" data-act="tpl-back">← 全部模板</button>
      <span class="hint">${esc(t.tag || '')}</span></div>
    <div class="radar-head"><h1>${esc(t.title)}</h1><span class="count">${(t.fields || []).length} 格 · ${esc(t.time || '十几秒')}</span></div>
    <div class="tmeta">
      <div class="trow"><span class="tlabel">解决什么问题</span><p>${esc(t.problem || '')}</p></div>
      <div class="trow"><span class="tlabel">需要哪些材料</span><p>${esc(t.materials || '')}</p></div>
      <div class="trow"><span class="tlabel">适用工具</span><p>${esc(t.tools || '')}</p></div>
      <div class="trow"><span class="tlabel">作者来源</span><p>${esc(t.source || '')}</p></div>
    </div>
    <details class="fold" ${log ? 'open' : ''}>
      <summary>效果示例（用出来大概长这样）</summary>
      <pre class="tpre">${esc(t.example || '')}</pre>
    </details>
    <div class="tform">
      ${(t.fields || []).map((f) => tplFieldHtml(t, f, v[f.key])).join('')}
    </div>
    <details class="fold">
      <summary>看拼好的提示词</summary>
      <pre class="tpre" id="tprompt">${esc(S.tpl.prompt || '')}</pre>
      <span class="fhint">改上面的输入框，这里会跟着变。这段文字就是真正要发给模型的东西。</span>
    </details>
    <div class="actions">
      <button class="btn primary" data-act="tpl-use" ${busy ? 'disabled' : ''}>${busy ? '正在写…' : '直接使用（在这里生成）'}</button>
      <button class="btn quiet" data-act="tpl-copy">复制到其他 AI</button>
      <button class="btn quiet" data-act="tpl-save">保存我的版本</button>
    </div>
    <p class="hint" style="margin-top:10px">这里生成要花自己填的 API，一篇大概几十秒。不想花钱就点「复制到其他 AI」，粘到 DeepSeek / ChatGPT 里一样用。</p>
    ${(busy || out || S.tpl.err) ? `<div class="tout">
      <div class="tout-head">
        <span>生成结果</span>
        <span class="tout-meta">${busy ? '正在写，边写边显' : (S.tpl.seconds ? S.tpl.seconds + ' 秒' : '')}</span>
      </div>
      ${S.tpl.err ? `<p class="key-result bad">${esc(S.tpl.err)}</p>` : ''}
      <div class="prose tout-body" id="toutBody">${busy ? esc(S.tpl.stream || '') : window.renderMarkdown(out)}</div>
      ${out ? `<div class="refines">${(t.refines || []).map((r) => `<button type="button" class="rchip" data-act="tpl-refine" data-v="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
      ${out ? `<div class="actions"><button class="btn quiet" data-act="tpl-copy-out">复制结果</button>
        <button class="btn quiet" data-act="tpl-reset">清空重来</button></div>` : ''}
    </div>` : ''}
    <details class="fold twhy">
      <summary>为什么这样问</summary>
      ${why}
      <p class="fhint">角色、背景、要求、输出格式——四段齐全，模型才知道「以什么身份、根据什么、做到什么、怎么给你」。少哪一段，就会缺哪一块。</p>
    </details>`;
  linkTerms($('.tmeta'));
  void refreshPreview();
}

async function tplUse() {
  if (!S.tpl) return;
  readTplForm();
  S.tpl.stream = '';
  S.tpl.err = '';
  S.tpl.busy = true;
  renderView();
  jobStart('tmpl', '正在按模板生成', { en: 'Template', live: true, stallAfter: 40, step: '等模型开口' });
  try {
    const r = await api.tmplRun({ id: S.tpl.id, values: S.tpl.values });
    jobEnd('tmpl', !!(r && r.ok), r && r.ok ? '写好了' : ((r && r.error) || '生成失败'));
    S.tpl.busy = false;
    if (r && r.ok) {
      S.tpl.out = r.out;
      S.tpl.seconds = r.seconds || 0;
      toast(`写好了，${r.seconds || 0} 秒。`);
    } else {
      S.tpl.err = (r && r.error) || '生成失败。';
      toast(S.tpl.err, true);
    }
  } catch (e) {
    jobEnd('tmpl', false, String(e.message || e));
    S.tpl.busy = false;
    S.tpl.err = String(e.message || e);
    toast(S.tpl.err, true);
  }
  renderView();
}

async function tplRefine(text) {
  if (!S.tpl || !S.tpl.out) return;
  readTplForm();
  S.tpl.busy = true;
  S.tpl.err = '';
  S.tpl.stream = '';
  renderView();
  try {
    const r = await api.tmplRun({ id: S.tpl.id, values: S.tpl.values, refine: text, prev: S.tpl.out });
    S.tpl.busy = false;
    if (r && r.ok) { S.tpl.out = r.out; S.tpl.seconds = r.seconds || 0; toast('改好了。'); }
    else { S.tpl.err = (r && r.error) || '改失败了。'; toast(S.tpl.err, true); }
  } catch (e) {
    S.tpl.busy = false;
    S.tpl.err = String(e.message || e);
    toast(S.tpl.err, true);
  }
  renderView();
}

async function tplCopyPrompt() {
  if (!S.tpl) return;
  readTplForm();
  const r = await api.tmplCompose({ id: S.tpl.id, values: S.tpl.values });
  const text = (r && r.prompt) || S.tpl.prompt || '';
  if (!text) return toast('提示词还没拼好，等一下再点。', true);
  await api.copy(text);
  toast('提示词已复制，粘到 DeepSeek / ChatGPT 里就能用。');
}

async function tplSaveMine() {
  if (!S.tpl) return;
  readTplForm();
  const name = window.prompt('给这个版本起个名字（方便以后找）：', tplById(S.tpl.id)?.title || '我的模板');
  if (!name) return;
  const r = await api.tmplSave({ id: S.tpl.id, name, values: S.tpl.values });
  if (r && r.ok) {
    S.tplLib.mine = r.mine || S.tplLib.mine;
    toast('已存到「我的版本」，在模板库顶部。');
    renderView();
  } else toast((r && r.error) || '保存失败', true);
}

/* --------------------------------------------------------------- 首次引导 */

function onboardNeeded() {
  return !!(S.state && S.state.config && S.state.config.onboarded !== true);
}

function startOnboard() {
  S.onboard = { step: 0, busy: false, result: null };
  const el = $('#onboard');
  if (el) el.hidden = false;
  renderOnboard();
}

function endOnboard() {
  const el = $('#onboard');
  if (el) el.hidden = true;
}

const KEY_STEPS = [
  ['去服务商开个账号', '推荐 DeepSeek（api.deepseek.com）：注册 → 控制台 → 充值 10 块就够了，能用很久。'],
  ['建一个 API key', '控制台里点「API keys」→ 新建 → 复制那串以 sk- 开头的东西。它相当于密码，别发群里。'],
  ['粘回来，点「测一下」', '地址填 https://api.deepseek.com/v1 ，模型填 deepseek-chat。测通了就能对话、也能让它写简报。'],
];

function renderOnboard() {
  const el = $('#onboard');
  if (!el) return;
  if (el.hidden) return;
  const o = S.onboard || { step: 0 };
  const step = o.step || 0;
  const dots = [0, 1, 2, 3].map((i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
  let body = '';

  if (step === 0) {
    body = `<h1>这是一个「每天替你读 AI 圈」的东西</h1>
      <p class="ob-lead">它每天自动去 GitHub、模型市场、几家媒体和论文站抓一遍，攒成一份材料；再让一个模型把材料写成三件值得看的事。不用你刷信息流。</p>
      <p class="ob-lead">接下来三步：给它一个模型账号（能对话、能写简报），说一句你在做的东西，然后看今天的三条。</p>
      <div class="ob-actions"><button class="btn primary" type="button" data-act="ob-next">开始</button>
      <button class="btn quiet" type="button" data-act="ob-skip">我都懂，先跳过</button></div>`;
  } else if (step === 1) {
    body = `<h1>第一步：给它一个模型账号</h1>
      <p class="ob-lead">这一步只是为了对话和写简报。不填也能用：采集、雷达、搜索、概念、安装 agent 都照样能看，只是没法让它替你写判断。</p>
      <div class="ob-form">
        <label>API 服务地址<input id="ob-base" type="text" value="${esc((S.state && S.state.config.baseUrl) || 'https://api.deepseek.com')}" spellcheck="false" /></label>
        <label>模型<input id="ob-model" type="text" value="${esc((S.state && S.state.config.model) || 'deepseek-chat')}" spellcheck="false" /></label>
        <label>API key<input id="ob-key" type="password" placeholder="sk-…（粘贴进来，只存在这台电脑）" spellcheck="false" /></label>
      </div>
      <p class="ob-note">没有 key？<button class="mini" type="button" data-act="ob-help">看看怎么弄</button></p>
      <div id="obHelp" class="ob-help" hidden>${KEY_STEPS.map(([t, d], i) => `<p><b>${i + 1}. ${esc(t)}</b>${esc(d)}</p>`).join('')}</div>
      <div id="obResult" class="ob-result" hidden></div>
      <div class="ob-actions">
        <button class="btn primary" type="button" data-act="ob-test">${o.busy ? '正在测…' : '测一下连通性'}</button>
        <button class="btn quiet" type="button" data-act="ob-next">下一步</button>
        <button class="btn quiet" type="button" data-act="ob-skip">先不填</button>
      </div>`;
  } else if (step === 2) {
    body = `<h1>第二步：你在做什么？卡在哪？</h1>
      <p class="ob-lead">随便写一句。它会记住，之后每天的简报里多出一块「猜你需要」，只挑跟这件事有关的项目、技能和模型推给你。</p>
      <textarea id="obProject" rows="4" placeholder="例如：我在做一个 Godot 4.7 的像素风中世纪游戏，负责 UI 和光照，卡在让 2D 画面有可信的光。">${esc(o.projectText || '')}</textarea>
      <p class="ob-note">不想写也行，以后在「对话」里说一样会被记住。</p>
      <div class="ob-actions">
        <button class="btn primary" type="button" data-act="ob-next">记下来，继续</button>
        <button class="btn quiet" type="button" data-act="ob-skip">跳过</button>
      </div>`;
  } else {
    const picks = topThreeToday();
    body = `<h1>第三步：今天先看这三条</h1>
      <p class="ob-lead">以后每天打开就是这个位置。上面那段大字是「今天真正重要的事」，下面三件是值得点开的。</p>
      ${picks.length
        ? `<ul class="ob-picks">${picks.map((p) => `<li><b>${esc(p.title)}</b><span>${esc(p.sub || '')}</span></li>`).join('')}</ul>`
        : '<p class="ob-note">今天还没有采集数据。进主界面后点左边「开始采集」，等 40 秒就有一份材料。</p>'}
      <div class="ob-actions"><button class="btn primary" type="button" data-act="ob-finish">进情报台</button></div>`;
  }

  el.innerHTML = `<div class="ob-box">
    <div class="ob-top"><span class="ob-brand">AI 情报台</span><span class="ob-dots">${dots}</span></div>
    ${body}
  </div>`;
}

function topThreeToday() {
  const d = S.data;
  if (!d) return [];
  const repos = [...(d.github?.new_repos || []), ...(d.github?.ai_new || [])]
    .filter((r) => r.stars_per_day_since_birth)
    .sort((a, b) => b.stars_per_day_since_birth - a.stars_per_day_since_birth)
    .slice(0, 3)
    .map((r) => ({ title: r.full_name, sub: `${num(r.stars)} stars · 日均 +${Math.round(r.stars_per_day_since_birth)} · ${String(r.desc || '').slice(0, 80)}` }));
  return repos;
}

async function onboardTest() {
  const box = $('#obResult');
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  if (box) { box.hidden = false; box.className = 'ob-result'; box.textContent = '正在测，最多等 30 秒…'; }
  let r;
  try {
    r = await api.keyTest({ baseUrl: val('ob-base'), model: val('ob-model'), apiKey: val('ob-key') });
  } catch (e) {
    r = { ok: false, reason: '发不出去', hint: String(e.message || e) };
  }
  if (!box) return;
  if (r && r.ok) {
    box.className = 'ob-result ok';
    box.textContent = '通了。' + (r.ms ? `（${r.ms} 毫秒）` : '');
    // 测通就把这三项存下来，后面步骤不用再点保存
    const patch = { baseUrl: val('ob-base'), model: val('ob-model') };
    if (val('ob-key')) patch.apiKey = val('ob-key');
    await api.saveSettings(patch);
    await refresh();
  } else {
    box.className = 'ob-result bad';
    box.innerHTML = `<b>${esc((r && r.reason) || '失败')}</b>${r && r.hint ? '：' + esc(r.hint) : ''}`;
  }
}

async function onboardNext() {
  const o = S.onboard;
  if (!o) return;
  if (o.step === 1) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const patch = { baseUrl: val('ob-base') || 'https://api.deepseek.com', model: val('ob-model') || 'deepseek-chat' };
    if (val('ob-key')) patch.apiKey = val('ob-key');
    await api.saveSettings(patch);
    await refresh();
    o.step = 2;
  } else if (o.step === 2) {
    const ta = $('#obProject');
    o.projectText = ta ? ta.value.trim() : '';
    o.step = 3;
  } else {
    o.step = Math.min(3, (o.step || 0) + 1);
  }
  renderOnboard();
}

async function onboardSkip() {
  const o = S.onboard;
  if (!o) { endOnboard(); return; }
  if (o.step === 0) { await onboardFinish(); return; }
  if (o.step === 1) { o.step = 2; renderOnboard(); return; }
  if (o.step === 2) { o.step = 3; renderOnboard(); return; }
  await onboardFinish();
}

async function onboardFinish() {
  const o = S.onboard || {};
  try {
    if ((o.projectText || '').trim()) await api.onboardDone({ projectText: o.projectText.trim() });
    else await api.saveSettings({ onboarded: true });
  } catch (e) {
    toast('记不进去：' + (e.message || e), true);
  }
  S.onboard = null;
  endOnboard();
  await refresh();
  setView('today');
  toast('就这样，明天早上它自己会跑。');
}

/* ------------------------------------------------------------------ events */

document.addEventListener('click', async (ev) => {
  const ext = ev.target.closest('a[data-ext]');
  if (ext) {
    ev.preventDefault();
    const u = ext.dataset.url || ext.getAttribute('href');
    markRead(u);
    api.openUrl(u);
    return;
  }

  const webSel = ev.target.closest('[data-web]');
  if (webSel) { void runWebSearch(S.spot.q); return; }

  const spotRow = ev.target.closest('.spot-row');
  if (spotRow) { openSpotItem(Number(spotRow.dataset.i)); return; }
  if (ev.target.id === 'spot' || ev.target.classList.contains('spot')) { closeSpot(); return; }

  const act = ev.target.closest('[data-act]');
  if (act) {
    ev.preventDefault();
    const a = act.dataset.act;
    if (a === 'collect') { $('#main').scrollTop = 0; doCollect(); }
    else if (a === 'generate') doGenerate();
    else if (a === 'save') { await toggleSave(act.dataset); }
    else if (a === 'uc') { await openUsecase(act.dataset.url, act.dataset.kind); }
    else if (a === 'uc-close') closeUsecase();
    else if (a === 'uc-open') { if (act.dataset.url) { markRead(act.dataset.url); api.openUrl(act.dataset.url); } }
    else if (a === 'uc-try') {
      const id = act.dataset.tpl || act.dataset.id || '';
      closeUsecase();
      if (id) tplOpen(id); else setView('tasks');
    }
    else if (a === 'uc-follow') {
      const it = S.uc.item || {};
      const r = await api.usecaseFollow({
        url: act.dataset.url || it.url || '',
        title: act.dataset.title || it.title || '',
        kind: it.kind || act.dataset.kind || '',
      });
      S.uc.followed = !!(r && r.ok);
      if (S.uc.open) renderUsecase();
      toast(r && r.ok ? '已加入「关注后续」，有新进展时在收藏页能看到' : '没能记住，稍后再试');
    }
    else if (a === 'tr-dir') {
      S.tr.to = act.dataset.to === 'en' ? 'en' : 'zh';
      S.tr.out = ''; S.tr.err = ''; S.tr.cached = false;
      renderView();
    }
    else if (a === 'tr-run') { await runTrans(); }
    else if (a === 'tr-clear') { S.tr.input = ''; S.tr.out = ''; S.tr.err = ''; S.tr.cached = false; renderView(); }
    else if (a === 'tr-copy') { await api.copy(S.tr.out || ''); toast('译文已复制'); }
    else if (a === 'digest-en') { await digestToEn(); }
    else if (a === 'detail') { await openDetail(act.dataset.name, act.dataset.url); }
    else if (a === 'close-drawer') closeDrawer();
    else if (a === 'open-ext') { markRead(act.dataset.url); api.openUrl(act.dataset.url); }
    else if (a === 'dig-deep') {
      await api.copy(`深挖这个项目：${act.dataset.name}（${act.dataset.url}）。读 README 和最近提交，回答三件事：它到底解决什么问题；跟我的项目（Godot 4.7 像素中世纪游戏，2D、GDScript、素材与 UI 为主）有什么可借的；值不值得我花一个晚上试。不要复述 README。`);
      toast('「深挖」指令已复制，粘到 DSH 里');
    }
    else if (a === 'copy-cmd') {
      await api.copy(act.dataset.cmd || '');
      toast('命令已复制');
    }
    else if (a === 'jump') { scrollToConcept(act.dataset.id); }
    else if (a === 'jump-group') { scrollToGroup(act.dataset.g); }
    else if (a === 'today') { setView('today'); }
    else if (a === 'goto-agents') { setView('agents'); }
    else if (a === 'copy-prompt') {
      await api.copy(dshCommand(S.date));
      toast('指令已复制，粘到 DSH 对话框里就行');
    }
    else if (a === 'regen') { if (confirm('重新生成会覆盖今天的简报，确定吗？')) doGenerate(); }
    else if (a === 'radar') setView('radar');
    else if (a === 'open-date') {
      S.date = act.dataset.date;
      await loadData(S.date);
      renderView();
    }
    else if (a === 'today') { S.date = todayStr(); await loadData(S.date); renderView(); }
    else if (a === 'open-inbox') api.openFolder('inbox');
    else if (a === 'open-digests') api.openFolder('digests');
    else if (a === 'open-root') api.openFolder('root');
    else if (a === 'clear-key') { await api.saveSettings({ clearKey: true }); toast('已清除本地 key'); await refresh(); }
    else if (a === 'clear-read') {
      if (confirm('把所有“已读”标记清空？收藏不受影响。')) {
        await api.clearRead();
        S.aux.read = {};
        toast('已清空阅读记录');
        renderView();
      }
    }
    else if (a === 'run-archive') {
      const r = await withJob('archive', '正在更新历史档案', { en: 'Archive', live: true, stallAfter: 45, step: '抓最近 3 个月的仓库和模型，约 30 秒' },
        () => api.archiveRun());
      if (r.ok) { toast(`档案更新完成，用了 ${r.seconds} 秒。`); S.aggKey = ''; S.agg = null; await refresh(); }
      else toast('档案更新失败：' + (r.error || '未知错误'), true);
    }
    else if (a === 'ask') { const q = act.dataset.q || ''; setView('chat'); setTimeout(() => sendChat(q), 60); }
    else if (a === 'chat-send') { const el = $('#chatInput'); sendChat(el ? el.value : ''); }
    else if (a === 'skill-doc') {
      openSkillDoc(act.dataset.source || '', act.dataset.id || '');
      return;
    }
    else if (a === 'skill-doc-path') {
      openSkillDoc(act.dataset.source || '', '', act.dataset.path || '');
      return;
    }
    else if (a === 'sdoc-close') { closeSkillDoc(); return; }
    else if (a === 'env-refresh') {
      await ensureSkillEnv(true);
      toast('环境已重新检测。');
      renderView();
      return;
    }
    else if (a === 'copy-text') {
      api.copy(act.dataset.text || '');
      toast('已复制');
      return;
    }
    else if (a === 'skill-open-dir') {
      const r = await api.skillOpen(act.dataset.dir || '');
      if (r && !r.ok) toast(r.error || '打不开这个目录', true);
      return;
    }
    else if (a === 'skill-recheck') {
      const r = await api.skillCheck({ source: act.dataset.source || '', id: act.dataset.id || '' });
      const n = ((r && r.installed) || []).length;
      if (S.sdoc.data && S.sdoc.data.ok) {
        S.sdoc.data.installed = (r && r.installed) || [];
        renderSkillDoc();
      }
      toast(n ? `检测到 ${n} 处安装。` : '还是没检测到。装完要新开一个 agent 会话才会生效。');
      return;
    }
    else if (a === 'skill-act') {
      const action = act.dataset.action || '';
      const dir = act.dataset.dir || '';
      if (!dir) { toast('先让「重新检查」找到安装目录，才能在这里动它。', true); return; }
      if (action === 'uninstall' && !confirm('卸载：把整个技能目录移到 state/skills_trash，可以恢复。继续？')) return;
      const r = await api.skillAct({ action, dir });
      toast((r && r.message) || (r && r.error) || '完成了', !(r && r.ok));
      if (r && r.ok) {
        const chk = await api.skillCheck({ source: (S.sdoc.data && S.sdoc.data.source) || '', id: (S.sdoc.data && S.sdoc.data.id) || '' });
        if (S.sdoc.data && S.sdoc.data.ok) { S.sdoc.data.installed = (chk && chk.installed) || []; renderSkillDoc(); }
      }
      return;
    }
    else if (a === 'web-toggle') {
      const on = S.state.config.webSearch === false;
      await api.saveSettings({ webSearch: on });
      await loadState();
      toast(on ? '联网搜索已打开：每次提问会先搜一次。' : '联网搜索已关闭：只用本机材料。');
      renderView();
      return;
    }
    else if (a === 'web-run') {
      await runWebSearch(S.spot.q);
      return;
    }
    else if (a === 'chat-clear') {
      if (confirm('清空今天的对话？需求记忆不受影响。')) {
        await api.chatClear();
        S.chat.msgs = [];
        toast('已清空今天的对话');
        renderView();
      }
    }
    else if (a === 'need-add') {
      const el = $('#needInput');
      const v = el ? el.value.trim() : '';
      if (!v) { toast('先写一句你在意什么。', true); return; }
      const prof = await api.needAdd({ topic: v.slice(0, 60), detail: v, keywords: v.split(/[\s,，、]+/).filter((k) => k.length >= 2) });
      if (el) el.value = '';
      toast('记下了，简报页尾会按它筛。');
      await reloadProfile(prof);
    }
    else if (a === 'need-del') {
      const prof = await api.needDel(act.dataset.id);
      toast('已删除');
      await reloadProfile(prof);
    }
    else if (a === 'dict-open') { openDict(act.dataset.id); }
    else if (a === 'dict-back') { dictBack(); }
    else if (a === 'pack-open') { openPack(act.dataset.pack); }
    else if (a === 'dict-clear') { S.dict.q = ''; renderDictPage(); }
    else if (a === 'dict-expand') { S.dict.expand = !S.dict.expand; renderView(); }
    else if (a === 'dict-gen-open') { S.dict.gen.open = true; S.dict.gen.err = ''; renderDictPage(); }
    else if (a === 'dict-gen-close') { S.dict.gen = { open: false, name: '', busy: false, err: '' }; renderDictPage(); }
    else if (a === 'dict-gen') { await dictGenerate(); return; }
    else if (a === 'goto-chat') setView('chat');
    else if (a === 'goto-needs') setView('needs');
    else if (a === 'goto-ext') setView('ext');
    else if (a === 'ext-use') { S.ext.use = act.dataset.use || 'all'; renderView(); }
    else if (a === 'ext-host') { S.ext.host = act.dataset.host === 'usable' ? 'usable' : 'all'; renderView(); }
    else if (a === 'ext-refresh') {
      S.ext.cat = null;
      toast('重新问一遍五个目录…');
      await ensureExt(true);
      renderView();
      return;
    }
    else if (a === 'ext-copy') { await api.copy(act.dataset.start || ''); toast('已复制'); }
    else if (a === 'ext-probe') {
      const id = act.dataset.id || '';
      const card = ((S.ext.cat && S.ext.cat.rows) || []).find((c) => c.id === id);
      if (!card) return;
      act.disabled = true;
      act.textContent = '测…';
      const r = await api.extProbe(card);
      S.ext.probed[id] = r;
      renderView();
      toast(r.ok ? `实测通过：${r.detail}` : `没测通：${r.detail}`, !r.ok);
      return;
    }
    else if (a === 'needs-scan') runNeedsScan('');
    else if (a === 'motion') setMotion(act.dataset.motion);
    else if (a === 'needs-seed') {
      api.needsSeed(false).then(() => { S.needs.payload = null; renderView(); toast('从追踪名单里挑了几条初始需求，可以点「编辑」改。'); }).catch((e) => toast(e.message || String(e), true));
    }
    else if (a === 'need-find') runNeedFind(act.dataset.id);
    else if (a === 'need-fb') giveFeedback(act.dataset.id, act.dataset.url, act.dataset.verdict, act.dataset.title || '');
    else if (a === 'need-new') { S.needs.form = { id: '', values: {} }; renderView(); }
    else if (a === 'need-edit') {
      const n = ((S.needs.payload && S.needs.payload.needs) || []).find((x) => x.id === act.dataset.id);
      if (!n) return;
      S.needs.form = { id: n.id, values: { topic: n.topic, goal: n.goal, software: (n.software || []).join('、'), budget: n.budget, device: n.device, difficulty: n.difficulty, tried: (n.tried || []).join('；') } };
      renderView();
    }
    else if (a === 'need-cancel') { S.needs.form = null; renderView(); }
    else if (a === 'need-save') { await saveNeedForm(); return; }
    else if (a === 'need-del') {
      if (!confirm('删掉这条需求？已经给的反馈也会一起没用。')) return;
      await api.needDel(act.dataset.id);
      S.needs.form = null;
      await ensureNeeds(true);
      renderView();
      toast('删掉了。');
    }
    else if (a === 'track-add-url') addTrack(act.dataset.url, act.dataset.title || '', act.dataset.id || '');
    else if (a === 'track-add') {
      const el = document.getElementById('trackUrl');
      const v = el ? el.value.trim() : '';
      if (!v) { toast('先粘贴一个仓库地址。'); return; }
      await addTrack(v, '', '');
    }
    else if (a === 'track-del') {
      await api.trackDel(act.dataset.id);
      await ensureTracker(true);
      renderView();
    }
    else if (a === 'track-check') checkTracker();
    else if (a === 'goto-settings') setView('settings');
    else if (a === 'match-off') {
      if (confirm('关掉「猜你需要」？之后可以在设置里重新打开。')) {
        await api.saveSettings({ matchEnabled: false });
        if (S.state && S.state.config) S.state.config.matchEnabled = false;
        toast('已关闭，设置里可以重新打开');
        renderView();
      }
    }
    else if (a === 'match-on') {
      await api.saveSettings({ matchEnabled: true });
      if (S.state && S.state.config) S.state.config.matchEnabled = true;
      toast('已开启');
      renderView();
    }
    else if (a === 'save') {
      const patch = {
        baseUrl: $('#s-base').value.trim(),
        model: $('#s-model').value.trim(),
        scheduleEnabled: $('#s-sched').checked,
        scheduleTime: $('#s-time').value || '08:00',
        matchEnabled: $('#s-match') ? $('#s-match').checked : undefined,
        pushDaily: $('#s-push') ? $('#s-push').checked : undefined,
        summaryAll: $('#s-sum') ? $('#s-sum').checked : undefined,
        compact: $('#s-compact') ? $('#s-compact').checked : undefined,
        webSearch: $('#s-web') ? $('#s-web').checked : undefined,
        priceIn: $('#s-pin') ? $('#s-pin').value : undefined,
        priceOut: $('#s-pout') ? $('#s-pout').value : undefined,
      };
      const key = $('#s-key').value.trim();
      if (key) patch.apiKey = key;
      const r = await api.saveSettings(patch);
      if (r.ok) { toast('已保存'); await refresh(); if (S.usage) S.usage = await api.usage(); }
    }
    else if (a === 'code') { toggleCode(act); return; }
    else if (a === 'test-key') { await doKeyTest(); return; }
    else if (a === 'no-key') {
      const h = $('#keyhelp');
      if (h) h.hidden = !h.hidden;
      return;
    }
    else if (a === 'replay-onboard') { startOnboard(); return; }
    else if (a === 'goto-trans') { setView('trans'); return; }
    else if (a === 'term') { await showTerm(act.dataset.id, act); return; }
    else if (a === 'term-close') { closeTerm(); return; }
    else if (a === 'term-more') {
      closeTerm();
      setView('concepts');
      setTimeout(() => scrollToConcept(act.dataset.id), 260);
      return;
    }
    else if (a === 'trans') { await doTrans(act); return; }
    else if (a === 'trans-all') { await transAll(); return; }
    else if (a === 'copy-code') { await api.copy(act.dataset.text || ''); toast('代码已复制'); return; }
    else if (a === 'summarize') { await doSummarize(); return; }
    else if (a === 'weekly-build') { await doWeekly(); return; }
    else if (a === 'fill') {
      const inp = $('#chatInput');
      if (inp) { inp.value = act.dataset.q || ''; inp.focus(); updateTplHint(); }
      return;
    }
    else if (a === 'ob-next') { await onboardNext(); return; }
    else if (a === 'ob-skip') { await onboardSkip(); return; }
    else if (a === 'ob-help') {
      const h = $('#obHelp');
      if (h) h.hidden = !h.hidden;
      return;
    }
    else if (a === 'ob-test') { await onboardTest(); return; }
    else if (a === 'ob-finish') { await onboardFinish(); return; }
    else if (a === 'tpl-open') { tplOpen(act.dataset.id); return; }
    else if (a === 'tmpl-all') { setView('tasks'); return; }
    else if (a === 'tpl-back') { S.tpl = null; renderView(); return; }
    else if (a === 'tpl-choice') {
      const field = act.dataset.field;
      const box = act.closest('.tchoice');
      if (box) for (const b of box.querySelectorAll('.tchip')) b.classList.toggle('is-on', b === act);
      if (S.tpl) S.tpl.values[field] = act.dataset.val;
      schedulePreview();
      return;
    }
    else if (a === 'tpl-sample') {
      const t = tplById(S.tpl && S.tpl.id);
      const f = t && (t.fields || []).find((x) => x.key === act.dataset.field);
      const area = document.querySelector(`[data-tplfield="${act.dataset.field}"]`);
      if (f && area && f.sample) {
        area.value = f.sample;
        if (S.tpl) S.tpl.values[f.key] = f.sample;
        schedulePreview();
        toast('示例已填进去，可以直接改。');
      }
      return;
    }
    else if (a === 'tpl-fetch') {
      const area = document.querySelector(`[data-tplfield="${act.dataset.field}"]`);
      const url = area ? area.value.trim() : '';
      if (!/^https?:\/\//i.test(url)) return toast('这个框要填文章链接（http 开头），或者直接粘正文。', true);
      toast('在抓正文，最多 20 秒…');
      const r = await api.articleFetch(url);
      if (r && r.ok) {
        if (area) area.value = r.text;
        if (S.tpl) S.tpl.values[act.dataset.field] = r.text;
        schedulePreview();
        toast(`抓到了 ${r.chars} 字。`);
      } else toast((r && r.error) || '抓取失败', true);
      return;
    }
    else if (a === 'tpl-use') { await tplUse(); return; }
    else if (a === 'tpl-refine') { await tplRefine(act.dataset.v || ''); return; }
    else if (a === 'tpl-copy') { await tplCopyPrompt(); return; }
    else if (a === 'tpl-copy-out') { await api.copy(S.tpl?.out || ''); toast('结果已复制。'); return; }
    else if (a === 'tpl-reset') { S.tpl.out = ''; S.tpl.err = ''; S.tpl.seconds = 0; renderView(); return; }
    else if (a === 'tpl-save') { await tplSaveMine(); return; }
    else if (a === 'tpl-mine-copy') {
      const m = S.tplLib?.mine?.[act.dataset.key];
      if (m) { await api.copy(m.prompt || ''); toast('已复制你的版本。'); }
      return;
    }
    else if (a === 'tpl-mine-del') {
      if (!window.confirm('删掉这个保存的版本？提示词本身还能重新拼。')) return;
      const r = await api.tmplDelMine(act.dataset.key);
      if (r && r.ok) { S.tplLib.mine = r.mine || {}; renderView(); }
      return;
    }
    return;
  }

  const tab = ev.target.closest('[data-tab]');
  if (tab) { S.radarTab = tab.dataset.tab; renderView(); enterBody('.radar-body'); return; }

  const chip = ev.target.closest('[data-filter]');
  if (chip) { S.filter = chip.dataset.filter; renderView(); return; }

  const mr = ev.target.closest('[data-mrange]');
  if (mr) { S.match.range = mr.dataset.mrange; S.match.items = null; renderView(); return; }

  const rng = ev.target.closest('[data-range]');
  if (rng) { setRange(rng.dataset.range); return; }

  const row = ev.target.closest('[data-date]');
  if (row) {
    S.date = row.dataset.date;
    await loadData(S.date);
    setView('today');
  }
});

$('#btnSearch').addEventListener('click', openSpot);
$('#btnTheme').addEventListener('click', toggleTheme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeBtn);
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyMotion);
paintThemeBtn();
applyMotion();
$('#spotInput').addEventListener('input', (e) => {
  const q = e.target.value;
  clearTimeout(spotTimer);
  spotTimer = setTimeout(() => runSearch(q), 110);
});

/* ------------------------------------------------------------------ keyboard */

const inField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    if ($('#spot').hidden) openSpot(); else closeSpot();
    return;
  }
  if (e.key === 'Escape') {
    if (S.view === 'concepts') {
      if (S.dict.mode !== 'list') { dictBack(); e.preventDefault(); return; }
      if (S.dict.q) { S.dict.q = ''; const q = $('#dictQ'); if (q) q.value = ''; dictRepaint(); e.preventDefault(); return; }
    }
    if (S.sdoc.open) { closeSkillDoc(); e.preventDefault(); return; }
    if (!$('#termcard').hidden) { closeTerm(); e.preventDefault(); return; }
    if (!$('#spot').hidden) { closeSpot(); e.preventDefault(); return; }
    if (S.drawer) { closeDrawer(); e.preventDefault(); return; }
    return;
  }
  if (!$('#spot').hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); S.spot.sel = Math.min(S.spot.sel + 1, S.spot.items.length - 1); paintSpot(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.spot.sel = Math.max(0, S.spot.sel - 1); paintSpot(); }
    else if (e.key === 'Enter') { e.preventDefault(); openSpotItem(S.spot.sel); }
    return;
  }
  if (inField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    if (S.view === 'concepts') { const q = $('#dictQ'); if (q) { q.focus(); q.select(); return; } }
    openSpot();
    return;
  }
  if (!['j', 'k', 'o', 's'].includes(e.key)) return;
  const rows = [...document.querySelectorAll('#view [data-nav]')];
  if (!rows.length) return;
  e.preventDefault();
  const apply = () => {
    rows.forEach((r, i) => r.classList.toggle('is-cur', i === S.cur));
    rows[S.cur]?.scrollIntoView({ block: 'center' });
  };
  if (e.key === 'j') { S.cur = Math.min(S.cur + 1, rows.length - 1); apply(); return; }
  if (e.key === 'k') { S.cur = Math.max(S.cur - 1, 0); apply(); return; }
  const cur = rows[S.cur];
  if (!cur) return;
  if (e.key === 'o') {
    if (cur.dataset.name) openDetail(cur.dataset.name, cur.dataset.url);
    else { markRead(cur.dataset.url); api.openUrl(cur.dataset.url); }
  } else if (e.key === 's') {
    const sv = cur.querySelector('[data-act="save"]');
    toggleSave({ url: cur.dataset.url, title: cur.dataset.title || cur.dataset.name || cur.dataset.url, kind: cur.dataset.name ? 'repo' : 'link', date: (sv && sv.dataset.date) || S.date });
  }
});

document.addEventListener('click', (ev) => {
  // 点术语卡外面就收起来
  const card = $('#termcard');
  if (card && !card.hidden && !ev.target.closest('#termcard') && !ev.target.closest('.term')) closeTerm();
  const nav = ev.target.closest('.nav-item');
  if (nav) { S.cur = -1; setView(nav.dataset.view); }
});

$('#main').addEventListener('scroll', () => {
  const m = $('#main');
  const max = m.scrollHeight - m.clientHeight;
  const pct = max > 0 ? (m.scrollTop / max) * 100 : 0;
  $('#prog').style.height = pct + '%';
});

api.onCollectLog(({ line, kind }) => { appendLog(line, kind); collectProgress(line); });
api.onArchiveLog(({ line, kind }) => {
  if (jobRunning('archive')) jobBeat('archive', String(line).slice(0, 80));
  const log = $('#log');
  if (log.hidden) { log.hidden = false; log.textContent = ''; }
  appendLog('[档案] ' + line, kind);
});
api.onCollectDone(async ({ ok, error, seconds }) => {
  S.collecting = false;
  jobEnd('collect', ok, ok ? `采集完成，用了 ${Math.round(seconds)} 秒` : error);
  appendLog(ok ? `完成，用了 ${seconds} 秒。` : `失败：${error}`, ok ? 'head' : 'err');
  if (ok) { toast(`采集完成，${seconds} 秒。`); await refresh(); }
  else { toast(error, true); renderRail(); }
});
api.onGenerateTick(({ seconds }) => {
  const t = document.getElementById('genTimer');
  if (t) t.textContent = `已经 ${seconds} 秒…`;
});

api.onChatDelta(({ text }) => {
  S.chat.stream += text;
  jobBeat('chat', `已收到 ${S.chat.stream.length} 个字`);
  const box = document.getElementById('streamBox');
  if (box) box.textContent = S.chat.stream;
});
api.onChatProfile(({ profile }) => {
  if (!profile) return;
  S.chat.profile = profile;
  S.chat.loaded = true;
  if (S.view === 'chat') renderView();
});

document.addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'dictQ' && e.key === 'Enter') {
    e.preventDefault();
    const first = document.querySelector('#dictRes [data-act="dict-open"]');
    if (first && first.dataset.id) openDict(first.dataset.id);
    return;
  }
  if (e.target && e.target.id === 'chatInput' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat(e.target.value);
  }
});

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'chatInput') updateTplHint();
  if (e.target && e.target.id === 'dictQ') {
    S.dict.q = e.target.value;
    clearTimeout(dictTimer);
    dictTimer = setTimeout(dictRepaint, 90);
    return;
  }
  if (e.target && e.target.id === 'dictGenName') {
    S.dict.gen.name = e.target.value;
    return;
  }
  if (e.target && e.target.dataset && e.target.dataset.tplfield) {
    if (S.tpl) S.tpl.values[e.target.dataset.tplfield] = e.target.value;
    schedulePreview();
  }
});

api.onTmplDelta(({ id, text }) => {
  if (!S.tpl || S.tpl.id !== id) return;
  S.tpl.stream = (S.tpl.stream || '') + text;
  jobBeat('tmpl', `已收到 ${S.tpl.stream.length} 个字`);
  const box = document.getElementById('toutBody');
  if (box) box.textContent = S.tpl.stream;
});

api.onNav(({ view }) => setView(view));

(async function boot() {
  try {
    await loadState();
    S.index = (await api.index()) || {};
    const aux = await api.aux();
    S.aux = { bookmarks: aux.bookmarks || {}, read: aux.read || {} };
    try { S.chat.profile = await api.profileLoad(); } catch {}
    try { S.usage = await api.usage(); } catch {}
    await ensureTplLib();
    await ensureTerms();
  } catch (e) {
    toast('读取数据失败：' + e.message, true);
  }
  await loadData(S.date);
  renderRail();
  renderView();
  if (S.state?.collecting) { S.collecting = true; startCollectJob('采集已经在进行（应用是中途打开的）'); renderRail(); }
  if (onboardNeeded()) setTimeout(() => startOnboard(), 250);
})();
