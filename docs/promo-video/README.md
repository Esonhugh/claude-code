# README 宣传视频

[`promo.mp4`](promo.mp4)（1920×1080，30fps，约 32 秒）由本目录的 Remotion 项目生成，嵌入在仓库根目录 README 中。`poster.png` 是视频第 3 秒的截图。

场景：`src/scenes/Intro.tsx`（项目名与版本）、`Features.tsx`（核心功能）、`Diff.tsx`（与官方的差异）、`Outro.tsx`（安装与仓库地址）。功能或版本变化时改对应场景里的文案，再重新渲染。

字体是 `public/fonts/` 里的本地子集（Noto Sans SC 只含视频用到的汉字），渲染不需要联网。新增汉字后要重新生成子集，否则会回退到系统字体。

```bash
bun install
bunx remotion studio        # 预览
bunx remotion render PromoVideo out/promo.mp4 --crf=28
cp out/promo.mp4 promo.mp4
ffmpeg -y -ss 3 -i promo.mp4 -frames:v 1 -vf scale=1280:-1 poster.png
```

本机没有 Remotion 自带的 Chrome Headless Shell 时，加 `--browser-executable=<chrome-headless-shell 路径>`。
