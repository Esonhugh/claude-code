# 项目网站

发布到 GitHub Pages（`https://esonhugh.github.io/claude-code/`）的静态站点，中英双语，深浅色跟随系统或手动切换。

| 页面 | 来源 |
| --- | --- |
| 首页 `index.html` | `src/home.html` |
| 功能文档 `docs/*.html` | `docs/features/*.md` 直接渲染（与 Wiki 同源），侧栏分组取自 `docs/features/README.md` 的「领域」列 |
| 基准测试 `benchmark/` | `src/benchmark.html`；交互散点图 `benchmark/scatter.html` 由 `src/benchmark/scatter-*.html` + `scatter-data.json` 拼成 |
| 动画演示 | `src/demos/`：Remotion 合成，用 `@remotion/player` 在页面里实时播放，不产出视频文件；界面文字直接取自 `web/src/locales`，终端完成动词取自 `src/constants/turnCompletionVerbs.ts` |

## 构建与预览

```bash
cd site
bun install
bun run check          # demos 类型检查
bun build.ts           # 输出到 site/dist
bun build.ts --serve   # 构建并在 http://localhost:4173 预览
```

## 发布

`.github/workflows/pages.yml` 在 `dev` 上 `site/`、`docs/features/`、`web/src/locales/` 有改动时构建并部署。首次使用需要在仓库 Settings → Pages 把 Source 设为 GitHub Actions，并在 Settings → Environments → `github-pages` 的部署分支里加入 `dev`。

基准数据更新时同步改 `src/home.html`、`src/benchmark.html` 里的数字和 `src/benchmark/scatter-data.json`（由 `bun bench/cli.ts chart` 生成）。
