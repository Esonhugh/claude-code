# /diff 视图

> 英文名：`diff-view` · 领域：界面与交互 · [返回功能索引](README.md)

## 作用与效果

`/diff` 查看未提交变更。启动时校验并加载内嵌的官方 `cc-plugin-diff` 2.1.295 Worker 接管该命令；未接管时用原生视图（终端 ≥ 110 列且没有可见 Mods dock 时用右侧 sidebar，否则 dialog）。新增代码保留语法颜色与词级差异背景。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `enabledPlugins["cc-plugin-diff@builtin"]` | settings | `false` | 停用官方 diff Mod（旧键 `diff@builtin` 仍可用） |
| `syntaxHighlightingDisabled` / `CLAUDE_CODE_SYNTAX_HIGHLIGHT` | settings / 环境变量 | `true` / `0` | 关闭语法高亮 |

## 效果

```text
 ▐▛███▜▌     EsonClaw v2.1.292
▝▜█████▛▘    Opus 5.5 · API Usage Billing
  ▘▘ ▝▝      ~/work
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ Uncommitted changes (git diff HEAD)                                                                                                                │
│                                                                                                                                                    │
│ 4 files changed +1                                                                                                                                 │
│                                                                                                                                                    │
│ ❯ .claude/scheduled_tasks.lock                                                                                                           untracked │
│   .claude/skills/deploy-notes/SKILL.md                                                                                                   untracked │
│   .claude/skills/lint-fixer/SKILL.md                                                                                                     untracked │
│   app.js                                                                                                                                        +1 │
│                                                                                                                                                    │
│ ↑/↓ to select · Enter to view · Esc to close                                                                                                       │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Diff 的语法颜色

构建后在 Git 仓库中运行 `/diff` 查看变更。默认语法高亮保留新增代码的关键词、字符串和数字颜色，同时显示新增/删除行和词级差异背景；删除代码保持普通前景色。设置 `syntaxHighlightingDisabled: true` 或 `CLAUDE_CODE_SYNTAX_HIGHLIGHT=0` 可关闭语法高亮。

可用 `bun test ./src/native-ts/color-diff/index.test.ts` 检查实际安装的高亮依赖、代码文本、行号和颜色。2026-10-06 对照[官方 2.1.291](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)，已验证样例在真实 `/diff`、resize、ask/取消和重开后的代码前景色；上下文与容器背景、退出日志及完整 diff/API/UI 对齐仍有独立待办，不能将此修复理解为完整兼容已完成。

### Diff 面板的背景

运行 `/diff` 即可使用继承面板背景的代码预览，无需额外设置。未修改代码、行号、空白区域和边框继承容器背景；新增/删除行及词级差异仍保留各自的背景颜色。切换背景或恢复默认背景时，旧颜色不应残留。

运行 `bun test ./src/ink/rawBackground.test.ts` 检查背景、样式重置、行号、差异颜色和缓存更新。2026-10-06 已在真实终端对照官方2.1.291样例；面板底部高度及退出诊断仍有差异，完整兼容进度见 mods-test。

### 验证带颜色的 diff 文本

运行 `bun test ./src/components/diff/DiffView.test.tsx` 验证文件选择、来源切换、滚动、Ask 和面板布局。文本断言读取已去除 ANSI 样式码的 Raw ANSI 文本；颜色与真实屏幕单元格仍分别验证，高亮无需关闭。

### 官方 diff 2.1.295 的离线归档与构建

`scripts/package-official-diff.mjs` 从已核验的官方完整模块生成 `assets/builtin-diff-2.1.295.zip`。它在写入前校验完整模块、身份模块、原始注册闭包和 compiled scan；输出使用固定 ZIP 时间，只创建新文件，拒绝覆盖或接受损坏输入。提取出的官方 JavaScript 不会由打包脚本执行。

```bash
bun scripts/package-official-diff.mjs /path/to/verified-2.1.295-modules /tmp/new-official-diff-295.zip
bun test ./scripts/shipped-diff-production.test.mjs ./scripts/build.test.mjs ./scripts/build-isolated.test.mjs
make build CLAUDE_CODE_BUILD_DIR=/tmp/new-claude-build
```

构建会把该归档同时复制到 `dist/assets` 并嵌入 standalone 二进制，保留已有 `builtin-mods-2.1.277.zip`。归档、构建和运行时接管分别验收；完整 diff UI 对齐仍按 `mods-test.md` 的范围记录。官方版本参考 [Anthropic changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。

### 官方 Mods 接管 diff

生产启动从内嵌的 `builtin-diff-2.1.295.zip` 校验并加载原始 `cc-plugin-diff` Worker。在全屏 Git 工作区输入 `/diff` 打开或关闭面板。原生 diff 的已保存打开偏好只迁移一次；用户明确关闭后清除请求状态。活跃官方插件接管时，原生 diff 面板与后台刷新暂停；禁用、拒绝或卸载后恢复原生命令。

可以在 settings 中禁用官方插件：

```json
{ "enabledPlugins": { "cc-plugin-diff@builtin": false } }
```

旧键 `diff@builtin` 仍作为兼容别名；同时配置时以 `cc-plugin-diff@builtin` 为准。`--debug --debug-file /tmp/claude-diff-debug.log` 会记录 `[ModsBuiltin]` 的版本、来源哈希及加载失败原因，以及 `[Mods:diff]` 接管状态。缺失或损坏归档不会退回旧官方模块，而由原生 diff 保持可用。

```bash
bun test ./src/plugins/bundled/shippedDiffStartup.test.ts ./src/services/mods/diffTakeover.test.ts ./src/services/mods/diffBackground.test.ts ./src/services/diff/controller.test.ts
```

接管测试直接使用仓库内的真实官方归档，无须外部 diff fixture。原始 scan 的 hooks、calls、环境名称和静态命令名称逐项核对；保留 `runCommands` 元数据不代表 `$.command.run` 已完成实现。这里完成的是加载和接管链路，完整官方API及UI兼容范围仍见 `mods-test.md`。官方背景资料见 [Anthropic plugins文档](https://code.claude.com/docs/en/plugins) 和 [官方变更日志](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。

### 官方 diff 2.1.295 的当前固定来源

当前生产归档为 `assets/builtin-diff-2.1.295.zip`，包含官方完整模块、身份模块、编译扫描元数据及原始注册闭包。加载和离线打包均核对固定字节范围与 SHA-256；过期或损坏归档会记录 `[ModsBuiltin]` 错误并保留原生 diff。旧归档仅用于历史来源核对。

```bash
bun scripts/package-official-diff.mjs /path/to/verified-2.1.295-modules /tmp/new-official-diff-295.zip
bun test ./scripts/shipped-diff-production.test.mjs ./src/plugins/bundled/shippedDiffStartup.test.ts ./src/services/mods/diffTakeover.test.ts
make build CLAUDE_CODE_BUILD_DIR=/tmp/new-claude-build
```

在全屏 Git 工作区输入 `/diff` 打开或关闭官方模块的面板；settings 的 `cc-plugin-diff@builtin` 开关及 `diff@builtin` 别名沿用原契约。使用 `--debug --debug-file /tmp/claude-diff-debug.log` 可核对加载版本、来源哈希与接管状态。

`Ctrl+X B` 切换比较 base，`Ctrl+↑/↓` 滚动文件列表。Pane 的 action 在绘制提交阶段登记，重绘后使用当前 drawing；`[ModsPaneAction]` 调试日志记录动作、绘制代次及准入状态，不记录输入正文。提交时序回归可运行 `bun test ./src/components/ModsPane.actionCommit.test.tsx`。

官方最新来源核对见 [Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，使用背景见 [Anthropic plugins 文档](https://code.claude.com/docs/en/plugins)。此升级原样加载官方 2.1.295 diff 注册闭包，使用最新 dock 行数与滚动计算，移除旧版顶部留白。公开声明基线及完整 API/UI 对齐仍须独立验收，详见 `mods-test.md` 和 [diff 2.1.295 来源与边界](../../docs/research/mods-shipped-diff-295-20261010.md)。
