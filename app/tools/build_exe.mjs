// 把 Electron 运行时 + 应用代码打成一个文件夹自带的 exe：
//   node tools/build_exe.mjs
// 产出：<ai-radar 目录>\bin\AI 情报台.exe（同级 resources\app 是应用代码）
// 数据仍然留在 ai-radar 根目录，不复制、不迁移。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');
const DIST = path.join(APP_DIR, 'node_modules', 'electron', 'dist');
const BIN = path.join(ROOT_DIR, 'bin');
const EXE_NAME = 'AI 情报台.exe';

if (!fs.existsSync(path.join(DIST, 'electron.exe'))) {
  console.error('找不到 Electron 运行时：', DIST);
  console.error('先在 app\\ 里跑一次 node node_modules/electron/install.js（带 ELECTRON_MIRROR）。');
  process.exit(1);
}

console.log('1/5 复制 Electron 运行时 →', BIN);
try {
  fs.rmSync(BIN, { recursive: true, force: true });
} catch {
  console.error('删不掉旧的 bin\\ —— 应用大概率还在运行（托盘里也算）。退出它再打包。');
  process.exit(1);
}
fs.mkdirSync(BIN, { recursive: true });
fs.cpSync(DIST, BIN, { recursive: true });

console.log('2/5 换上应用代码');
const appRes = path.join(BIN, 'resources', 'app');
fs.rmSync(path.join(BIN, 'resources', 'default_app.asar'), { force: true });
fs.mkdirSync(appRes, { recursive: true });
for (const f of ['main.js', 'preload.js', 'updater.js', 'events.js', 'package.json', 'icon.ico', 'icon-32.png', 'icon-256.png']) {
  fs.copyFileSync(path.join(APP_DIR, f), path.join(appRes, f));
}
fs.cpSync(path.join(APP_DIR, 'renderer'), path.join(appRes, 'renderer'), { recursive: true });

// package.json 里去掉开发期依赖声明，避免打包后误解
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
delete pkg.dependencies;
delete pkg.scripts;
delete pkg.devDependencies;
fs.writeFileSync(path.join(appRes, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

console.log('3/5 重命名可执行文件');
const exePath = path.join(BIN, EXE_NAME);
fs.renameSync(path.join(BIN, 'electron.exe'), exePath);

console.log('4/5 换图标与版本信息');
try {
  const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const icoBuf = fs.readFileSync(path.join(APP_DIR, 'icon.ico'));
  const iconFile = Data.IconFile.from(icoBuf);
  const icons = iconFile.icons.map((i) => i.data);
  for (const lang of [1033, 2052]) {
    try {
      Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, lang, icons);
    } catch { /* 该语言没有图标组就算了 */ }
  }

  const strings = {
    ProductName: 'AI 情报台',
    FileDescription: 'AI 情报台 — 每日 AI / GitHub 情报',
    InternalName: 'ai-radar',
    OriginalFilename: EXE_NAME,
    LegalCopyright: '',
  };
  const vinfo = Resource.VersionInfo.fromEntries(res.entries)[0] || Resource.VersionInfo.createEmpty();
  vinfo.setFileVersion(1, 0, 0, 0);
  vinfo.setProductVersion(1, 0, 0, 0);
  for (const lang of [[1033, 1200], [2052, 1200]]) {
    vinfo.setStringValues({ lang: lang[0], codepage: lang[1] }, strings);
  }
  vinfo.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
} catch (err) {
  console.log('   （图标/版本信息没写进去，不影响启动）', err.message);
}

const size = fs.statSync(exePath).size;
console.log('5/5 完成：', exePath);
console.log('     体积', (size / 1024 / 1024).toFixed(1), 'MB（整个 bin 目录约',
  (fs.readdirSync(BIN).length), '个顶层条目）');
