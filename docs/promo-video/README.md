# README 宣传视频

[`promo.mp4`](promo.mp4)（1920×1080，30fps，约 54 秒，带音乐和音效）由本目录的 Remotion 项目生成，嵌入在仓库根目录 README 中。`poster.png` 是视频封面。

## 结构

先抛痛点、再给答案。所有段落长度都是 15 帧的倍数，硬切落在 120 BPM 节拍上（标题重击在第 6 秒，与节拍进入同一拍）。

| 段落 | 文件 | 内容 |
| --- | --- | --- |
| 痛点 | `src/scenes/Hook.tsx` | 三个问题逐个砸出并被划掉，接「那就换一个。」 |
| 标题 | `src/scenes/Intro.tsx` | 标题重击与 UNOFFICIAL 印章 |
| 四个章节 | `src/scenes/Chapter.tsx` | 问题 + 答案卡，之后是截图镜头（从全貌推近 `focus` 区域，高亮框、压暗、大字标注）或终端交互动画；章节内容和每张截图的 `focus` 坐标（原图像素）在 `src/PromoVideo.tsx` |
| 终端动画 | `src/TerminalSim.tsx` | 按脚本重放一段 Claude Code 交互；配色取自 `src/utils/theme.ts` 暗色主题，spinner 字符取自 `src/components/Spinner/utils.ts`，完成动词直接 import `src/constants/turnCompletionVerbs.ts` |
| 对照 | `src/scenes/Diff.tsx` | 6 项差异逐条快闪，文案取自 `docs/features` |
| Wiki | `src/scenes/WikiWall.tsx` | 截图墙 + Wiki 地址 |
| 结尾 | `src/scenes/Outro.tsx` | 安装命令、仓库地址、非官方声明 |

`public/shots` 是指向 `docs/features/images` 的符号链接。换截图时同时更新它的 `width`/`height`/`focus`。

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
ffmpeg -y -ss 8 -i promo.mp4 -frames:v 1 -vf scale=1280:-1 poster.png
```

本机没有 Remotion 自带的 Chrome Headless Shell 时，加 `--browser-executable=<chrome-headless-shell 路径>`。
