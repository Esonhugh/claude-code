# 变更日志

本文档记录基于 Claude Code `2.1.88` 恢复源码之后的本地变更。

记录规则：

- 最新变更写在最上方。
- 如果没有实际发布版本号，不虚构版本号，只使用变更提交日期。
- 日期以对应变更 commit 的提交时间为准；同一天多个相关提交合并为一个条目。
- 每个日期条目写明关联 commit 和变更内容。
- `2.1.88 base` 固定放在最底部，作为所有本地变更的起点。

## 2026-06-17 - v2.1.168 - Workflow 状态生命周期与详情展示修复

### 版本状态

- 发布版本：`v2.1.168`。
- 本次发布覆盖 `378740d` 本身及其后的提交：`378740d`、`9985705`、`58c1592`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 GitHub Actions/tag 流程注入。

### 关联提交

- `378740d` — 2026-06-16 21:16:13 +08:00 — `update: fix workflow status changes and lifetime cycle`
- `9985705` — 2026-06-17 00:47:24 +08:00 — `fix: correct workflow detail terminal state display`
- `58c1592` — 2026-06-17 01:54:41 +08:00 — `update: model status changes`

### 变更内容

- 修复 workflow status 与生命周期状态传播，补齐 paused、killed、completed 等终态在 `LocalWorkflowTask`、`WorkflowTool` 和 `/workflows` 页面中的一致性处理。
- 调整 workflow 运行流程的异步持久化与 session 生命周期处理，确保 agent 完成、workflow 终止和 terminal 状态能被详情视图稳定读取。
- 移除 workflow 列表与任务弹窗中的重复状态展示，避免同一 workflow 状态在不同 UI 层级中出现冲突或冗余。
- 修正 workflow detail terminal state 渲染，确保 killed workflow 在详情对话框和 snapshot 中以一致状态显示。
- 更新 workflow detail model/snapshot 的状态派生逻辑，补齐 completed agent、outcome 可见性和 model status 展示边界场景。

### 测试覆盖

- 新增或更新 `LocalWorkflowTask`、`WorkflowTool`、`/workflows` 页面、`WorkflowDetailDialog`、`workflowDetailModel` 和 `workflowDetailSnapshot` 相关回归测试。
- 本次 changelog/tag 准备未额外运行测试或构建；相关提交已包含对应测试变更。

## 2026-06-16 - Dynamic Workflows 运行时、恢复缓存与 UI 状态对齐

### 版本状态

- `package.json` 仍为 `0.0.0-dev`，本分支未引入正式发布版本号。
- 新增 `Makefile` 本地测试入口，当前 `VERSION := 2.1.666-test`，用于通过 `bun package:binary` 生成 `built-claude` 测试二进制。
- 本分支主要围绕 Claude Code `2.1.165` Dynamic Workflows 行为做兼容性和可观测性补齐；InteractiveTerminal 仍按独立功能验收，不并入官方 workflow parity 范围。

### 关联提交

- `2f15490` — 2026-06-14 21:32:42 +08:00 — `update: Workflow JS runtime detection, error process, resume cache persistence and runArgs injections`
- `4cc7c79` — 2026-06-15 17:27:24 +08:00 — `fix: align workflow runtime phase handling and child script resolution`
- `45949fa` — 2026-06-15 19:26:03 +08:00 — `update: fix outcome oversize`
- `81cf564` — 2026-06-15 20:27:40 +08:00 — `fix: Outcomes fix`
- `06a478a` — 2026-06-16 11:10:50 +08:00 — `update: build tool for test`
- `65f3bb3` — 2026-06-16 14:49:45 +08:00 — `fix: deep research with inputs`

### 变更内容

- 增强 `Workflow` facade 和 `WorkflowTool` 输入处理，补齐 inline script、`scriptPath`、saved workflow、`runArgs` 注入、child script 解析、workflow name 解析和 deep-research 输入传递路径。
- 扩展 JavaScript workflow runtime：增加脚本识别、错误处理、resume cache 持久化、phase 调度、DSL/spec 校验、runtime globals 和 structured workflow 相关测试覆盖。
- 对齐 workflow phase 与 agent orchestration 行为，新增 `workflowPhaseScheduler`，完善 fanout/concurrency、phase dependencies、root prompt、built-in workflow metadata 和 bundled workflow 定义。
- 重构 `/workflows` 详情展示：抽出 `workflowDetailModel`，调整 snapshot 渲染、agent/outcome 状态、oversize outcome 展示、空结果处理和 coordinator agent rows。
- 新增 task 状态与保留策略工具，补齐 `taskStatus`、`retention` 及对应测试，减少 UI 和持久化状态判断分散实现。
- 新增 `Makefile` 和 `.gitignore` 调整，提供本地 `built-claude` 构建/运行快捷入口，并更新 official parity agent 说明。

### 测试覆盖

- 新增或更新 `WorkflowFacadeTool`、`WorkflowTool`、`workflowDsl`、`workflowPhaseScheduler`、`workflowRuntimeGlobals`、`workflowSpec`、`workflowCommand`、`workflowDiscovery` 相关测试。
- 新增或更新 `/workflows` 页面模型、详情 snapshot、coordinator agent status、task retention 相关测试。
- 本次 changelog 更新未额外运行测试或构建命令。

### 代码审查后续关注

- workflow code-review 已确认若干后续 correctness 风险，主要集中在并行 agent 生命周期清理、pause/kill 状态传播、run session 异步持久化顺序、schema structured output 解析、saved workflow resume cache、zero-agent workflow 持久化和 `phase()` 依赖标签一致性。
- 这些风险尚未在本条目中修复，后续应优先补最小失败测试后再做 targeted fix。

## 2026-06-14 - Bun 迁移、InteractiveTerminal PTY 替换与 binary-only npm 发布准备

### 关联提交

- 待提交 — Bun 包管理迁移、Bun PTY driver、release workflow 与 npm launcher 发布准备。

### 变更内容

- 将工作区包管理和构建入口迁移到 Bun：新增 `bun.lock`，移除 `pnpm-lock.yaml` / `pnpm-workspace.yaml`，并将构建、打包、验证文档同步为 `bun run ...` / `bunx ...` 命令。
- 用 Bun 自带 `Bun.spawn(..., { terminal })` PTY/terminal API 替换 InteractiveTerminal 的 `node-pty` 后端，删除 `node-pty` 依赖、旧 driver、旧集成测试和 node-pty native prebuild 复制逻辑，解决 standalone binary 启动时找不到 `pty.node` 的问题。
- 清理 `scripts/` 目录，保留构建/打包/缺失导入审计/本地 CLI runner 和 build shims，删除 workflow probe、compatibility、deobfuscator 和临时测试用途脚本。
- 更新 GitHub Actions release workflow：使用 Bun 1.3.14 安装、类型检查、lint、audit、build、package，并在上传 release artifacts 前验证 packaged binary 的 `--version` / `--help`。
- 准备 npm binary-only 发布流程：主包 `@esonhugh/claude-code` 是非官方 Claude Code launcher；平台/架构 binary 拆分到 optional dependency 子包（如 `@esonhugh/claude-code-darwin-arm64`），npm 包不发布本仓库源码。
- 优化 README，明确本项目不是 Anthropic 官方 Claude Code 程序或官方源码分发，而是非官方启动器/恢复开发工作区。

### 验证

- `bunx tsc --noEmit --pretty false`
- `bun run audit:missing`
- `bun run build`
- `bun run start --version` / `bun run start --help`
- `CLAUDE_CODE_VERSION=2.1.165-dev bun run package:binary`
- `./dist/release/claude-code-v2.1.165-dev-darwin-arm64 --version` / `--help`
- `bun test src/utils/pty/bunPtyDriver.integration.test.ts`
- `bun test src/utils/pty/PtySessionManager.test.ts`
- `bun pm pack --dry-run` for the current platform binary subpackage and main npm launcher package.

## 2026-06-04 - 恢复源码整理、功能扩展与文档索引

### 关联提交

- `12c8153` — `update: add sourcemap and Ink debug workflow`
- `46da60f` — 2026-06-04 12:21:46 +08:00 — `update: add autonomous goal and marketplace controls`
- `40b54bc` — 2026-06-04 12:44:34 +08:00 — `upgrade: add extra dependency`
- `01ae965` — 2026-06-04 15:51:29 +08:00 — `chore: update, eslint updating and type guards`
- `d2b5348` — 2026-06-04 15:56:02 +08:00 — `update: fix linters`

### 变更内容

- 从 Claude Code `2.1.88` 分发产物的 source map 中恢复大量 `ts` / `tsx` 可读源码，并清理残留的内联 source map payload。
- 新增本地功能扩展：`/goal` 自主目标命令、Esonhugh Marketplace 默认高优先级源、插件 favorite scope、marketplace `autoUpdate` 控制，以及 Anthropic-bound telemetry 默认关闭策略。
- 新增 ESLint flat config、`lint` / `lint:fix` 脚本，并补齐 TypeScript ESLint、React ESLint、React Hooks ESLint、React/Bun/Node 类型依赖。
- 拆分恢复声明到 `types/` 下的聚焦声明文件，减少全局 stub，并使用真实包导出的类型替代可恢复的本地伪声明。
- 修复恢复源码中的 TypeScript 类型问题，重点收紧消息、工具、任务、插件、MCP、远程日志和 SDK/recovered 边界类型。
- 将早期 CLI fast-path 分发逻辑拆出到 `src/entrypoints/fastPathDispatch.ts`，并保持 `src/entrypoints/cli.tsx` 聚焦启动初始化与主入口加载。
- 修复 Commander debug-to-stderr 选项的无效短参数注册问题，确保 CLI `--help` 正常启动。
- 重整项目文档结构：将根 `README.md` 定位为项目目的与使用指南，新增 `docs/README.md` 作为阅读索引，重写构建与二次开发手册，并将 `docs/upgrade-plan.md` 调整为历史工作说明。
- 新增 `docs/claude-code-internals-index.md`，作为 Claude Code 启动流程、REPL 查询循环、工具体系、Agent / Subagent 生命周期和 Team / Swarm 协作模型的中文索引文档。
- 新增 source map 运行与调试脚本、VS Code Node 调试配置，以及 `CLAUDE_CODE_ALLOW_INSPECTOR` 显式本地调试开关，方便定位到恢复后的 TypeScript/TSX 源码。
- 在构建手册中补充 Ink/React 调试工作流，说明 integrated terminal、`patchConsole` 行为和现有 debug 日志通道的推荐用法。

## 2026-03-31 - 恢复工程初始化与安全策略限制处理

### 关联提交

- `4178dd7` — 2026-03-31 22:39:10 +08:00 — `Delete CYBER_RISK_INSTRUCTION`
- `554fb1f` — 2026-03-31 22:42:01 +08:00 — `更新说明`

### 变更内容

- 初始化 recovered Claude Code 工程结构，加入构建脚本、缺失依赖审计脚本、运行脚本、shim 模块和恢复后的源码文件。
- 删除或调整恢复源码中的 `CYBER_RISK_INSTRUCTION` 相关限制说明，并同步处理安全审查、策略限制、托管设置安全检查、Bash / PowerShell 安全处理、插件策略和 MCP instruction delta 等相关模块。
- 新增早期恢复工程说明文档，并整理 README 入口说明。

## 2.1.88 base

### 基线说明

- 基础版本：Claude Code `2.1.88`。
- 本仓库所有本地变更均以该版本的恢复源码为起点。
- 本条目固定保留在变更日志底部，不作为新增功能或日期记录。
