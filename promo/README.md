# AI 情报台 宣传短片

成片：`AI情报台-宣传短片.mp4`（1920×1080，30fps，H.264，46.5 秒，AAC 立体声，响度 -14 LUFS）。
`AI情报台-宣传短片-仅音效.mp4` 是只有音效、没有配乐的版本；`build/video-silent.mp4` 是无声画面。

## 声音

- **音效**（`audio/sfx.wav`）：全部由 `src/sfx.mjs` 用代码合成，没有采样素材，没有版权问题。
  跟着画面走：擦入是带通噪声的「嘶」，换场快门是低频推送加一记咔哒，界面点击和打字对齐录屏里真实操作的时刻，
  结尾按钮变黄是两声提示音。
- **背景音乐**：Kevin MacLeod《Getting it Done》，CC BY 4.0，可商用但**必须署名**。
  片尾画面底部已经带了署名；发到 B站、抖音等平台时，简介里也贴上这三行：

  ```
  "Getting it Done" Kevin MacLeod (incompetech.com)
  Licensed under Creative Commons: By Attribution 4.0 License
  http://creativecommons.org/licenses/by/4.0/
  ```

  原文件和来源说明在 `audio/music/`。片中取 2:38.5–3:25，曲子自带的结尾正好落在片尾。
- 混音：`src/mix.mjs`（音乐 -8 dB 压在音效下面，两遍 loudnorm 到 -14 LUFS、真峰值约 -1.5 dBTP）。

## 内容

| 时间 | 段落 | 画面 |
| --- | --- | --- |
| 0:00 | 开场 | 深色底大字：不用再刷信息流 / 每天 5 分钟 |
| 0:04 | 字标 | AI RADAR / 情报台，一句定位和三项事实 |
| 0:07 | 01 今日简报 | 真实界面：简报滚动 |
| 0:15 | 02 原始雷达 | 真实界面：切换前沿 / 模型 / 新闻栏目 |
| 0:22 | 03 需求雷达 | 真实界面：需求条件和匹配理由 |
| 0:29 | Ctrl K 搜索 | 真实界面：输入关键词、上下选择 |
| 0:33 | 浅色 / 深色 | 真实界面：圆形揭开切换主题 |
| 0:37 | 还有 | 模板库、概念词典、扩展能力、对话四张截图 |
| 0:41 | 结尾 | 三条卖点和「打开 AI 情报台」 |

## 画面来源

- 界面画面是情报台本身录下来的，用的是分享版（`ai-radar-share`）在临时目录里的一份**演示数据**：
  2026-10-25 现采的一轮公开资讯；当天简报按应用自带的简报格式根据这些材料写成；
  两条需求（会议录音转文字、图片批量识别）是演示用的，和任何真实用户无关。不包含个人数据。
- 片中的数字（17 个数据源、25 个新项目、52 个新模型、42 条新闻、14 篇论文、10 个栏目）都来自这一轮采集。
- 字体 Saira（SIL OFL 1.1，许可证在 `app/renderer/assets/fonts/Saira-OFL.txt`）；中文用系统的 Noto Sans SC。
- 除上面的背景音乐外，没有使用任何第三方音乐、图片或素材。

## 重新生成

需要 FFmpeg（已用 winget 装了 Gyan.FFmpeg）。都用情报台自带的 Electron 运行：

1. 用演示数据目录启动情报台并打开调试端口：
   `app\node_modules\electron\dist\electron.exe app --root=<演示目录> --remote-debugging-port=9340`
2. 录界面：`node promo\src\record.mjs 9340 <素材目录>`（每段一串带时间戳的 jpg，另有几张静帧）
3. 出预览图：`electron promo\src\render.cjs --footage=<素材目录> --stills=<目录> --at=6,18,44`
4. 出无声画面：`electron promo\src\render.cjs --footage=<素材目录> --out=promo\build\video-silent.mp4 --ffmpeg=<ffmpeg.exe>`
5. 生成音效：`node promo\src\sfx.mjs promo\audio\sfx.wav`
6. 混音合成：`node promo\src\mix.mjs <ffmpeg.exe> promo\build\video-silent.mp4 promo\audio\sfx.wav "promo\audio\music\Getting it Done.mp3" promo\AI情报台-宣传短片.mp4`

文案、时长、场次都在 `src/compose.html`（文字和版式）和 `src/compose.js`（时间轴，`SCENES`）里改。
