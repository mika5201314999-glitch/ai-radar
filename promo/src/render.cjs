// 逐帧渲染宣传短片：Electron 离屏打开 compose.html，按 30fps 截每一帧，直接喂给 FFmpeg 出 MP4。
// 用法（用情报台自带的 Electron 跑）：
//   electron render.cjs --footage=<素材目录> --out=<输出.mp4> --ffmpeg=<ffmpeg.exe>
//   electron render.cjs --footage=<素材目录> --stills=<目录> --at=1.2,5,10   只出几张预览图
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const arg = (k, d = '') => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || d;
const FPS = 30;

app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const footage = pathToFileURL(path.resolve(arg('footage'))).href;
  const win = new BrowserWindow({
    width: 1920, height: 1080, useContentSize: true, show: false,
    webPreferences: { offscreen: true, webSecurity: false, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(30);
  await win.loadURL(`${pathToFileURL(path.join(__dirname, 'compose.html')).href}?footage=${encodeURIComponent(footage)}`);
  // 用 DevTools 的截图命令：每次都按当前状态重新合成，不会拿到上一帧
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 200; i++) {
    if (await win.webContents.executeJavaScript('!!window.ready')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const duration = await win.webContents.executeJavaScript('window.DURATION');
  const shot = async (t, format = 'jpeg') => {
    await win.webContents.executeJavaScript(`renderAt(${t})`);
    const res = await dbg.sendCommand('Page.captureScreenshot', { format, quality: 95, fromSurface: true });
    return Buffer.from(res.data, 'base64');
  };

  const stills = arg('stills');
  if (stills) {
    fs.mkdirSync(stills, { recursive: true });
    for (const t of arg('at', '1').split(',').map(Number)) {
      const img = await shot(t, 'png');
      fs.writeFileSync(path.join(stills, `t${String(t).replace('.', '_')}.png`), img);
      console.log('still', t, await win.webContents.executeJavaScript("JSON.stringify(['s-open','s-mark'].map(i=>i+':'+getComputedStyle(document.getElementById(i)).display+'/'+document.getElementById(i).style.clipPath))"));
    }
    app.quit();
    return;
  }

  const out = path.resolve(arg('out', 'promo.mp4'));
  const ff = spawn(arg('ffmpeg', 'ffmpeg'), [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    // 截图是全范围（0–255）的 JPEG，转成播放器和视频网站都按标准处理的有限范围 yuv420p
    '-vf', 'scale=in_range=full:out_range=limited,format=yuv420p', '-color_range', 'tv',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
    '-r', String(FPS), '-movflags', '+faststart',
    '-metadata', 'title=AI 情报台', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const total = Math.round(duration * FPS);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const buf = await shot(i / FPS);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 90 === 0) console.log(`frame ${i}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('done', out, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  app.quit();
});
