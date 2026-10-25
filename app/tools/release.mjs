// 发布更新包：从 git 里已经提交的内容打包，产出要传到 GitHub Releases 的文件。
//
//   node app/tools/release.mjs                 打更新包（版本号取 app/package.json）
//   node app/tools/release.mjs --dist <目录>    另外导出一份给新用户的完整目录（含打包好的 bin\）
//   node app/tools/release.mjs --dist <目录> --zip   再把这个目录压成 zip，一起传到 Release
//   node app/tools/release.mjs --seed <目录>    把某份已经发出去的副本里的数据文件也记成「发布过的版本」
//                                               （用来认出老用户手里没改过的模板、提示词）
//
// 产出在 release/out/<版本>/：
//   ai-radar-update-<版本>.json.gz   更新包：程序代码 + 随附的数据文件，每个文件带 sha256
//   latest.json                     版本号、说明、更新包的大小和 sha256
//   发布步骤.txt                     在 GitHub 上建 Release 要做的事
// 同时更新 release/history.json（每个数据文件历次发布过的 sha256），这个文件要提交进 git。
//
// 发布前检查：
//   - 版本号必须比 history 里记过的都新；
//   - 要打包的文件在工作区里不能有没提交的改动（发出去的东西必须和某个提交一致）；
//   - local/release-forbid.txt（不进仓库）里列的词，一个都不能出现在要发布的文本文件里。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(APP_DIR, '..');
const OUT_BASE = path.join(ROOT, 'release', 'out');
const HISTORY = path.join(ROOT, 'release', 'history.json');
const FORMAT = 1;

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || '') : ''; };
const has = (k) => args.includes(k);

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'buffer', maxBuffer: 1 << 30 });
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const die = (msg) => { console.error('✗ ' + msg); process.exit(1); };

/* ---------- 发哪些文件 ---------- */
// 程序代码：每次都覆盖
const APP_FILES = ['main.js', 'preload.js', 'updater.js', 'package.json', 'icon.ico', 'icon-32.png', 'icon-256.png'];
const ROOT_CODE = ['collect.mjs', 'backfill.mjs', 'exthub.mjs', 'skilldoc.mjs', 'skills.mjs', 'websearch.mjs', 'run_daily.cmd', 'README.md'];
// 数据文件：用户可能改过，改过的不覆盖
const ROOT_DATA = ['agents.json', 'concepts.json', 'domains.json', 'tasks.json', 'templates.json', 'watchlist.md'];

const tracked = new Set(git('ls-files').toString('utf8').split('\n').filter(Boolean));
const fromHead = (rel) => {
  if (!tracked.has(rel)) die(`${rel} 没有被 git 跟踪，先提交它`);
  return git('show', `HEAD:${rel}`);
};

// 工作区里要发布的文件不能有没提交的改动
const dirty = git('status', '--porcelain').toString('utf8').split('\n').filter(Boolean)
  .map((l) => l.slice(3).replace(/^"|"$/g, ''))
  .filter((p) => p.startsWith('app/') || p.startsWith('prompts/') || ROOT_CODE.includes(p) || ROOT_DATA.includes(p));
if (dirty.length && !has('--allow-dirty')) die(`这些文件有没提交的改动，先提交再发布：\n  ${dirty.join('\n  ')}`);

const pkg = JSON.parse(fromHead('app/package.json').toString('utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`app/package.json 的版本号「${version}」不是 x.y.z`);

const history = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY, 'utf8')) : { versions: [], files: {} };
const newer = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i]; return false; };
for (const v of history.versions) if (!newer(version, v) && !has('--allow-same')) die(`版本 ${version} 不比已发布的 ${v} 新，先改 app/package.json 的 version`);

const files = [];
const add = (bundlePath, repoPath, mode) => files.push({ path: bundlePath, mode, buf: fromHead(repoPath) });

for (const f of APP_FILES) {
  if (f === 'package.json') {
    // 和 build_exe 一样去掉开发期依赖声明
    const p = { ...pkg }; delete p.dependencies; delete p.devDependencies; delete p.scripts;
    files.push({ path: 'app/package.json', mode: 'code', buf: Buffer.from(JSON.stringify(p, null, 2)) });
  } else add(`app/${f}`, `app/${f}`, 'code');
}
for (const p of tracked) if (p.startsWith('app/renderer/')) add(`app/${p.slice(4)}`, p, 'code');
for (const f of ROOT_CODE) add(`root/${f}`, f, 'code');
for (const f of ROOT_DATA) add(`root/${f}`, f, 'data');
for (const p of tracked) if (/^prompts\/[^/]+\.md$/.test(p)) add(`root/${p}`, p, 'data');

/* ---------- 个人内容检查 ---------- */
const forbidFile = path.join(ROOT, 'local', 'release-forbid.txt');
if (fs.existsSync(forbidFile)) {
  const words = fs.readFileSync(forbidFile, 'utf8').split(/\r?\n/).map((w) => w.trim()).filter((w) => w && !w.startsWith('#'));
  const hits = [];
  for (const f of files) {
    if (/\.(png|ico|webp|ttf)$/i.test(f.path)) continue;
    const text = f.buf.toString('utf8');
    for (const w of words) if (text.includes(w)) hits.push(`${f.path} 里有「${w}」`);
  }
  if (hits.length) die(`要发布的文件里有不该公开的内容：\n  ${hits.join('\n  ')}`);
  console.log(`✓ 个人内容检查：${words.length} 个词，都没出现`);
} else {
  console.log('（没有 local/release-forbid.txt，跳过个人内容检查）');
}

/* ---------- 记下发布过的数据文件版本 ---------- */
const remember = (p, h) => { const a = (history.files[p] ||= []); if (!a.includes(h)) a.push(h); };
for (const f of files) if (f.mode === 'data') remember(f.path, sha256(f.buf));
const seed = opt('--seed');
if (seed) {
  for (const f of files) {
    if (f.mode !== 'data') continue;
    const p = path.join(seed, ...f.path.replace(/^root\//, '').split('/'));
    if (fs.existsSync(p)) remember(f.path, sha256(fs.readFileSync(p)));
  }
  console.log(`✓ 已把 ${seed} 里的数据文件记成发布过的版本`);
}

/* ---------- 更新包 ---------- */
const electronMajor = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8')).version).split('.')[0]; }
  catch { return ''; }
})();
const notesFile = path.join(ROOT, 'release', 'notes', `${version}.md`);
const notes = opt('--notes') || (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '');
const known = {};
for (const f of files) if (f.mode === 'data') known[f.path] = history.files[f.path] || [];

const bundle = {
  format: FORMAT,
  version,
  commit: git('rev-parse', 'HEAD').toString('utf8').trim(),
  files: files.map((f) => ({ path: f.path, mode: f.mode, sha256: sha256(f.buf), data: f.buf.toString('base64') })),
  known,
};
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
const outDir = path.join(OUT_BASE, version);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const bundleName = `ai-radar-update-${version}.json.gz`;
fs.writeFileSync(path.join(outDir, bundleName), gz);
const latest = {
  version,
  date: new Date().toISOString().slice(0, 10),
  notes,
  bundle: bundleName,
  size: gz.length,
  sha256: sha256(gz),
  electron: electronMajor,
  commit: bundle.commit,
};
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, 2));

if (!history.versions.includes(version)) history.versions.push(version);
fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2) + '\n');

console.log(`✓ 更新包 ${bundleName}：${files.length} 个文件，${(gz.length / 1048576).toFixed(2)} MB`);
console.log(`  sha256 ${latest.sha256}`);

/* ---------- 给新用户的完整目录 ---------- */
const dist = opt('--dist');
let zipName = '';
if (dist) {
  const target = path.resolve(dist);
  if (fs.existsSync(target) && fs.readdirSync(target).length) die(`${target} 不是空目录，换一个或先清空`);
  if (!fs.existsSync(path.join(ROOT, 'bin', 'AI 情报台.exe'))) die('没找到 bin\\AI 情报台.exe，先运行 node app/tools/build_exe.mjs');
  fs.mkdirSync(target, { recursive: true });
  // 已提交的全部文件，去掉宣传片和发布记录
  const skip = (p) => p.startsWith('promo/') || p.startsWith('release/');
  for (const p of tracked) {
    if (skip(p)) continue;
    const out = path.join(target, ...p.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, fromHead(p));
  }
  fs.cpSync(path.join(ROOT, 'bin'), path.join(target, 'bin'), { recursive: true });
  // 打包版里的程序代码换成这次提交的版本（bin 可能是之前打的）
  for (const f of files) {
    if (!f.path.startsWith('app/')) continue;
    const out = path.join(target, 'bin', 'resources', 'app', ...f.path.slice(4).split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.buf);
  }
  for (const d of ['data', 'digests', 'inbox', 'state', 'chats', 'logs']) fs.mkdirSync(path.join(target, d), { recursive: true });
  console.log(`✓ 完整目录：${target}`);
  if (has('--zip')) {
    zipName = `AI情报台-${version}-windows.zip`;
    const zipPath = path.join(outDir, zipName);
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${target.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`], { stdio: 'inherit' });
    if (r.status !== 0) die('压缩失败');
    console.log(`✓ 完整包 ${zipName}：${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB`);
  }
}

fs.writeFileSync(path.join(outDir, '发布步骤.txt'), [
  `AI 情报台 v${version} 发布步骤`,
  '',
  '1. 把 release/history.json 的改动提交并推送（git add release/history.json && git commit && git push）。',
  `2. 在 GitHub 仓库的 Releases 里新建一个 Release：标签写 v${version}，标题写 AI 情报台 v${version}。`,
  '3. 说明里贴上 latest.json 里的 notes。',
  `4. 把这个目录里的 latest.json 和 ${bundleName}${zipName ? `、${zipName}` : ''} 作为附件传上去，发布（不要勾 pre-release）。`,
  '',
  '用户那边的应用会读 releases/latest/download/latest.json，比版本号，有新版就提示。',
  '加国内镜像：把同样的文件放到一个能直接下载的地址，在用户的 app/config.json 里加 "updateFeeds": ["https://镜像地址/目录"]。',
].join('\n'));
console.log(`✓ 发布文件在 ${outDir}`);
