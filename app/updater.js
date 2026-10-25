'use strict';
/**
 * 应用内更新：只换程序代码和随应用发布的数据文件，不动 Electron 运行环境，也不碰用户的东西。
 *
 * 发布方（tools/release.mjs）在 GitHub Releases 上放两个文件：
 *   latest.json                       { version, date, notes, bundle, size, sha256, electron }
 *   ai-radar-update-<版本>.json.gz     { format, version, files: [{ path, mode, sha256, data }], known }
 *     path  'app/…' 写到程序目录（打包后是 bin/resources/app），'root/…' 写到数据根目录
 *     mode  'code' 一律覆盖；'data'（提示词、模板、词典……）用户改过就不覆盖，新版另存成 *.new
 *     known 每个 data 文件历次发布过的 sha256，用来判断「用户有没有改过」
 *
 * 流程：check() 读 latest.json 比版本 → download() 下载、校验整包和每个文件、解到暂存目录
 *       → apply() 备份旧文件、逐个替换，调用方随后重启应用。
 * 不更新的情况：开发运行（没打包）、目录里有 .git（这是开发目录，用 git 管理）。
 */
const { app, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const DEFAULT_FEEDS = ['https://github.com/mika5201314999-glitch/ai-radar/releases/latest/download'];
const FORMAT = 1;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 1.10.0 > 1.9.3；不认识的段按 0 算 */
function newer(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    // net.fetch 走系统代理设置，国内网络下比 Node 自带的 fetch 更容易连上
    return await net.fetch(url, { signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

function createUpdater({ ROOT, APP_DIR, getConfig, send, isBusy }) {
  const stageRoot = path.join(app.getPath('userData'), 'update');
  const status = {
    state: 'idle', current: app.getVersion(), latest: null, error: '', reason: '',
    checkedAt: '', progress: null, conflicts: [], feed: '',
  };
  let staged = null;  // { version, dir, manifest }

  // 刚更新完重启：把这次更新的记录（哪些文件用户改过、新版另存成 .new）交给界面提示一次
  try {
    const logPath = path.join(ROOT, 'state', 'update-log.json');
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    if (log[0] && log[0].to === status.current && !log[0].seen) {
      status.justUpdated = { from: log[0].from, to: log[0].to, conflicts: log[0].conflicts || [] };
      log[0].seen = true;
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    }
  } catch {}

  const emit = () => send('update:status', { ...status });
  const set = (patch) => { Object.assign(status, patch); emit(); };

  function disabledReason() {
    if (!app.isPackaged) return '开发运行（没打包），不自动更新';
    if (fs.existsSync(path.join(ROOT, '.git'))) return '这是开发目录（有 .git），用 git 管理，不自动更新';
    return '';
  }

  const feeds = () => {
    const c = getConfig();
    const extra = Array.isArray(c.updateFeeds) ? c.updateFeeds.filter((u) => /^https?:\/\//i.test(u)) : [];
    return [...extra, ...DEFAULT_FEEDS].map((u) => u.replace(/\/+$/, ''));
  };

  async function check({ quiet = false } = {}) {
    const reason = disabledReason();
    if (reason) { set({ state: 'disabled', reason }); return { ...status }; }
    if (status.state === 'downloading' || status.state === 'applying') return { ...status };
    set({ state: 'checking', error: '' });
    let lastErr = '';
    for (const base of feeds()) {
      try {
        const res = await fetchWithTimeout(`${base}/latest.json`, 12_000);
        if (!res.ok) { lastErr = `${base} 返回 ${res.status}`; continue; }
        const j = await res.json();
        if (!j || !j.version || !j.bundle || !j.sha256) { lastErr = `${base} 的 latest.json 不完整`; continue; }
        const latest = { version: j.version, date: j.date || '', notes: j.notes || '', size: j.size || 0, bundle: j.bundle, sha256: j.sha256, electron: j.electron || '' };
        const checkedAt = new Date().toISOString();
        if (!newer(latest.version, status.current)) {
          set({ state: staged ? 'ready' : 'none', latest, checkedAt, feed: base });
          return { ...status };
        }
        // 新版本要求更新的 Electron 运行环境：程序代码换不了，只能整包重新下载
        const needMajor = parseInt(latest.electron, 10) || 0;
        const haveMajor = parseInt(process.versions.electron, 10) || 0;
        if (needMajor && needMajor > haveMajor) {
          set({ state: 'manual', latest, checkedAt, feed: base, reason: `新版本需要 Electron ${needMajor}，这台机器上是 ${haveMajor}，要重新下载完整版` });
          return { ...status };
        }
        set({ state: staged && staged.version === latest.version ? 'ready' : 'available', latest, checkedAt, feed: base });
        return { ...status };
      } catch (e) {
        lastErr = `${base}：${e.name === 'AbortError' ? '超时' : (e.message || e)}`;
      }
    }
    set({ state: quiet ? 'idle' : 'error', error: lastErr || '连不上更新源', checkedAt: new Date().toISOString() });
    return { ...status };
  }

  async function download() {
    const reason = disabledReason();
    if (reason) return { ok: false, error: reason };
    if (!status.latest || status.state !== 'available') {
      const r = await check();
      if (r.state !== 'available') return { ok: false, error: r.state === 'none' ? '已经是最新版本' : (r.error || r.reason || '没有可用的更新') };
    }
    const L = status.latest;
    set({ state: 'downloading', progress: { received: 0, total: L.size || 0 }, error: '' });
    try {
      const res = await fetchWithTimeout(`${status.feed}/${encodeURIComponent(L.bundle)}`, 10 * 60_000);
      if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || L.size || 0;
      const chunks = [];
      let received = 0;
      let lastSent = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;
        if (Date.now() - lastSent > 150) {
          lastSent = Date.now();
          status.progress = { received, total };
          send('update:progress', status.progress);
        }
      }
      const buf = Buffer.concat(chunks);
      send('update:progress', { received: buf.length, total: buf.length });
      if (sha256(buf) !== L.sha256) throw new Error('更新包校验不对（SHA-256 不一致），已丢弃。可能是下载不完整，稍后再试。');

      const bundle = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
      if (bundle.format !== FORMAT) throw new Error(`更新包格式 ${bundle.format} 这个版本不认识，请下载完整版`);
      if (bundle.version !== L.version) throw new Error('更新包里的版本号和 latest.json 对不上');

      const dir = path.join(stageRoot, L.version);
      await fsp.rm(dir, { recursive: true, force: true });
      const files = [];
      for (const f of bundle.files || []) {
        if (!/^(app|root)\/[^]+$/.test(f.path) || f.path.includes('..')) throw new Error(`更新包里有不合法的路径：${f.path}`);
        const data = Buffer.from(f.data, 'base64');
        if (sha256(data) !== f.sha256) throw new Error(`文件校验不对：${f.path}`);
        const out = path.join(dir, 'files', ...f.path.split('/'));
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.writeFile(out, data);
        files.push({ path: f.path, mode: f.mode === 'data' ? 'data' : 'code', sha256: f.sha256 });
      }
      const manifest = { version: L.version, notes: L.notes, files, known: bundle.known || {} };
      await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      staged = { version: L.version, dir, manifest };
      set({ state: 'ready', progress: null });
      return { ok: true, version: L.version, files: files.length };
    } catch (e) {
      set({ state: 'error', error: e.message || String(e), progress: null });
      return { ok: false, error: e.message || String(e) };
    }
  }

  /** 把暂存的新版本换上去。成功后由调用方重启应用。 */
  async function apply() {
    if (!staged) return { ok: false, error: '还没有下载好的更新' };
    if (isBusy()) return { ok: false, error: '正在采集或生成，等它结束再更新' };
    set({ state: 'applying' });
    const { manifest, dir } = staged;
    const backup = path.join(stageRoot, `backup-${status.current}-${Date.now()}`);
    const conflicts = [];
    const targetOf = (p) => {
      const [scope, ...rest] = p.split('/');
      const base = scope === 'app' ? APP_DIR : ROOT;
      const t = path.resolve(base, ...rest);
      if (!t.startsWith(path.resolve(base) + path.sep)) throw new Error(`路径越界：${p}`);
      return t;
    };
    try {
      for (const f of manifest.files) {
        const target = targetOf(f.path);
        const src = path.join(dir, 'files', ...f.path.split('/'));
        let current = null;
        try { current = await fsp.readFile(target); } catch {}
        if (current && sha256(current) === f.sha256) continue;              // 已经是新版
        if (f.mode === 'data' && current) {
          const known = manifest.known[f.path] || [];
          if (!known.includes(sha256(current))) {                            // 用户改过：不覆盖
            await fsp.copyFile(src, `${target}.new`);
            conflicts.push(f.path.replace(/^root\//, ''));
            continue;
          }
        }
        if (current) {
          const b = path.join(backup, ...f.path.split('/'));
          await fsp.mkdir(path.dirname(b), { recursive: true });
          await fsp.writeFile(b, current);
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.updating`;
        await fsp.copyFile(src, tmp);
        await fsp.rename(tmp, target);
      }
      const logPath = path.join(ROOT, 'state', 'update-log.json');
      let log = [];
      try { log = JSON.parse(await fsp.readFile(logPath, 'utf8')); } catch {}
      log.unshift({ at: new Date().toISOString(), from: status.current, to: manifest.version, conflicts, backup });
      await fsp.mkdir(path.dirname(logPath), { recursive: true });
      await fsp.writeFile(logPath, JSON.stringify(log.slice(0, 20), null, 2));
      await fsp.rm(dir, { recursive: true, force: true });
      staged = null;
      set({ state: 'applied', conflicts });
      return { ok: true, version: manifest.version, conflicts };
    } catch (e) {
      set({ state: 'error', error: `换文件时出错：${e.message || e}。旧文件备份在 ${backup}` });
      return { ok: false, error: status.error };
    }
  }

  return { check, download, apply, status: () => ({ ...status }), newer };
}

module.exports = { createUpdater, newer, FORMAT };
