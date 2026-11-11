# 项目网站

发布到 GitHub Pages（`https://esonhugh.github.io/claude-code/`）的静态站点，简体 / 繁體 / English 三语切换（`data-lang` = `hans` / `zh` / `en`，对应 CSS 类 `.hans` / `.hant` / `.en`），深浅色跟随系统或手动切换。

| 页面 | 来源 |
| --- | --- |
| 首页 `index.html` | `src/home.html` |
| 功能文档 `docs/*.html` | `docs/features/*.md` 直接渲染（与 Wiki 同源），侧栏分组取自 `docs/features/README.md` 的「领域」列。正文是简体；介绍部分以 `<!-- lang: zh-Hans -->` 开头，后接 `<details lang="en">` 和 `<details lang="zh-Hant">` 两段译文（Wiki 上折叠显示，网站按语言只显示一段）；英文 / 繁体的标题和分组名取自 README 译文里的功能表，行序须与简体表一致 |
| 基准测试 `benchmark/` | `src/benchmark.html`；交互散点图 `benchmark/scatter.html` 由 `src/benchmark/scatter-*.html` + `scatter-data.json` 拼成 |
| 动画演示 | `src/demos/`：纯 DOM 渲染的终端和网页动画，由 `src/demos/clock.tsx` 的帧时钟（requestAnimationFrame）驱动，离开视口时暂停；界面文字直接取自 `web/src/locales`，终端完成动词取自 `src/constants/turnCompletionVerbs.ts` |
| 真实终端录像 | `src/demos/recordings/*.json`：`bun record/record.ts`（先 `make build`）在 tmux 里跑真实的 `built-claude`，`record/goal-api.ts` 按脚本扮演模型、工具在临时项目里真实执行，`capture-pane -e` 的画面经 `record/convert.ts` 转成样式表 + 行表 + 帧表，由 `src/demos/ReplayTerminal.tsx` 按帧播放；目前用于导览的 goal 场景（简/繁/EN 各录一份） |
| 网页介面试玩 | `web-demo/`：用 `web/vite.demo.config.ts` 构建真实的 `web/` 前端，入口 `web/demo.html` 先载入 `web/src/demo/mock.ts`，由它接管 `fetch(/api/*)` 和会话 WebSocket，按脚本回应；需要仓库根目录先 `bun install` |

## 构建与预览

```bash
cd site
bun install
bun run check          # demos 类型检查
bun build.ts           # 输出到 site/dist
bun build.ts --serve   # 构建并在 http://localhost:4173 预览
```

## 发布

`.github/workflows/pages.yml` 在 `dev` 上 `site/`、`docs/features/`、`web/` 有改动时构建并部署。首次使用需要在仓库 Settings → Pages 把 Source 设为 GitHub Actions，并在 Settings → Environments → `github-pages` 的部署分支里加入 `dev`。

基准数据更新时同步改 `src/home.html`、`src/benchmark.html` 里的数字和 `src/benchmark/scatter-data.json`（由 `bun bench/cli.ts chart` 生成）。
