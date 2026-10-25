# README 宣传视频

[`promo.mp4`](promo.mp4)（1920×1080，30fps，约 55 秒，带音乐和音效）由本目录的 Remotion 项目生成，嵌入在仓库根目录 README 中。`poster.png` 是视频封面。

## 结构

| 场景 | 文件 | 内容 |
| --- | --- | --- |
| 开场 | `src/scenes/Intro.tsx` | 蓄力后重击出现标题与 UNOFFICIAL 印章 |
| 数据 | `src/scenes/Stats.tsx` | 功能 Wiki 页数、截图数、平台数计数 |
| 功能展示 | `src/scenes/Showcase.tsx` | 9 个功能，每个配一张 `docs/features/images` 实测截图和对应 Wiki 页名；列表在 `src/PromoVideo.tsx` |
| Wiki 墙 | `src/scenes/WikiWall.tsx` | 截图墙 + Wiki 地址 |
| 官方对照 | `src/scenes/Diff.tsx` | 与官方的 6 项差异，文案取自 `docs/features` |
| 结尾 | `src/scenes/Outro.tsx` | 安装命令、仓库地址、非官方声明 |

`public/shots` 是指向 `docs/features/images` 的符号链接，截图更新后重新渲染即可。

## 素材

- 音频由 `scripts/make-audio.sh` 用 ffmpeg 合成（音乐、whoosh、impact、tick、ding、riser），不含第三方采样；生成到 `public/audio/`（不入库）。
- 字体由 `scripts/make-fonts.sh` 按 `src/` 里实际用到的字符从 Google Fonts 下载子集到 `public/fonts/`，渲染不需要联网。改了中文文案后要重新运行。

## 渲染

```bash
bun install
./scripts/make-audio.sh
./scripts/make-fonts.sh       # 文案有新字符时
bunx remotion studio          # 预览
bunx remotion render PromoVideo out/promo.mp4 --crf=26 --audio-bitrate=160k
ffmpeg -y -i out/promo.mp4 -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart -c:a copy promo.mp4
ffmpeg -y -ss 4.2 -i promo.mp4 -frames:v 1 -vf scale=1280:-1 poster.png
```

本机没有 Remotion 自带的 Chrome Headless Shell 时，加 `--browser-executable=<chrome-headless-shell 路径>`。
