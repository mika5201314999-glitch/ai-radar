// 混音并合进成片：背景音乐取 2:38.5–3:25（曲子自己的结尾正好落在片尾），压在音效下面，
// 两遍 loudnorm 把整体响度定到 -14 LUFS、真峰值 -1.5 dBTP（视频网站常用标准）。
// 用法：node mix.mjs <ffmpeg.exe> <无声视频.mp4> <音效.wav> <音乐.mp3> <输出.mp4>
import { spawnSync } from 'node:child_process';

const [ff, video, sfx, music, out] = process.argv.slice(2);
const MUSIC_START = 158.5;   // 秒
const DUR = 46.5;
const MUSIC_GAIN = -8;       // dB，相对原曲；让音效和画面节奏在上面
const TARGET = { I: -14, TP: -1.5, LRA: 11 };

const graph = (tail) => [
  `[2:a]atrim=start=${MUSIC_START}:duration=${DUR},asetpts=PTS-STARTPTS,aresample=48000,`
    + `afade=t=in:st=0:d=0.35,afade=t=out:st=${DUR - 1.2}:d=1.2,volume=${MUSIC_GAIN}dB[m]`,
  `[1:a]aresample=48000[s]`,
  `[m][s]amix=inputs=2:normalize=0:duration=first[mix]`,
  `[mix]${tail}[a]`,
].join(';');

const run = (args) => {
  const r = spawnSync(ff, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { console.error(r.stderr.slice(-3000)); process.exit(1); }
  return r.stderr;
};

// 第一遍：只测量
const measureLog = run(['-hide_banner', '-nostats', '-i', video, '-i', sfx, '-i', music,
  '-filter_complex', graph(`loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}:print_format=json`),
  '-map', '[a]', '-f', 'null', '-']);
const m = JSON.parse(measureLog.slice(measureLog.lastIndexOf('{'), measureLog.lastIndexOf('}') + 1));
console.log('measured', m.input_i, 'LUFS', m.input_tp, 'dBTP');

// 第二遍：按测量值线性归一，视频流原样复制
const ln = `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
  + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
run(['-hide_banner', '-nostats', '-y', '-i', video, '-i', sfx, '-i', music,
  '-filter_complex', graph(ln), '-map', '0:v', '-map', '[a]',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-shortest', '-movflags', '+faststart',
  '-metadata', 'title=AI 情报台', '-metadata', 'comment=Music: "Getting it Done" Kevin MacLeod (incompetech.com), CC BY 4.0',
  out]);
console.log('wrote', out);
