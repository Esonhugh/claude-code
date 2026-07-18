# Claude Code Feature Validation 路由

本 reference 帮助 `claude-code-feature-validation` 按改动 surface 选择最小充分证据。主 `SKILL.md` 定义 verdict 和报告要求；涉及真实交互时，`claude-agent-workflow-validation` 定义严格 binary-side 证据边界。

## 1. 从 diff 建立验证地图

| Surface | 常见变化 | 主要风险 |
|---|---|---|
| pure logic | parser、formatter、state reducer、utility | 边界错误、回归、异常状态 |
| component | React Ink render、dialog、preview | stale state、布局、控制字符、交互回归 |
| registration | command、tool、skill、schema、export | 不可达、错误 schema、遗漏入口 |
| CLI non-interactive | `--print`、flags、stdout/stderr | exit code、输出格式、env/settings |
| CLI interactive | slash command、prompt、key handling | stdin dispatch、prompt 恢复、TTY 状态 |
| task/runtime | Agent、Workflow、background task | ownership、通知、竞态、错误终态 |
| packaging | binary、bundle、release scripts | 未包含代码、版本/路径错误、构建失败 |
| compatibility | official/local parity | 环境不等价、只验证一侧 |

一个改动可能属于多个 surface。验证层级取所有 surface 要求的并集。

## 2. 常见路由

### 文档或文本改动

通常只执行 L0，并检查文档中的 path、command、flag、version 与当前源码或 `Makefile` 一致。若文档描述的实际 CLI 行为同时被修改，按对应 behavior surface 升级。

### 纯逻辑、state 或 formatter

执行 L0 + L1，覆盖 changed contract 主路径、导致修复的最小回归场景，以及与改动直接相关的边界。跨模块类型变化再加 L2。不要用完整 CLI 运行替代可重复单测。

### React Ink component 或 terminal preview

先用组件/state 测试证明确定性 render 和状态转换。`.test.tsx` 是聚焦测试输入，不是 L5 触发条件；可直接与 `.test.ts` 一起运行：

```bash
bun test path/to/state.test.ts path/to/Component.test.tsx
```

只有 assertion 依赖真实 terminal、按键、resize、ANSI/CRLF/control chars、AppState freshness、dialog lifecycle 或 CLI prompt 时，再加 L3 + L5，并通过 `Skill` 工具调用 `claude-agent-workflow-validation`。

Pane 证明真实渲染观察；纯文本 normalization、reducer 等仍由自动化测试覆盖。

### Command、Tool、Skill 或 schema 注册

至少执行：

1. L0 检查实现、export、registry 和 schema 引用；
2. L1 运行相关 registration/schema/behavior tests；
3. L2 检查跨模块类型；
4. L3 构建，证明代码进入当前制品。

交互式入口再加 L5；非交互 flag 使用 L4。

### Bug fix

1. 确认最小测试可复现目标 bug；若无法安全回退当前工作区，说明 red-state 证据限制；
2. 运行最小回归测试；
3. 运行直接相邻测试；
4. 按 surface 决定 build/runtime/tmux；
5. 分开报告“自动化测试覆盖的 fault path”和“真实 CLI 覆盖的 happy path”。

不要为了证明 red state 破坏用户当前工作区。

### Agent、Workflow、task lifecycle

自动化测试用于可控故障、竞态、ownership 和状态机；L5 用于真实 binary 的入口、进度、通知和 prompt 恢复。两类证据不可互相替代。

- foreground → background 不重启 stream：behavior test + 同次运行 debug marker；
- summarizer ownership：state/behavior test + debug marker；
- completion notification：terminal pane + 同次运行 notification event；
- retry race：受控自动化测试；普通 CLI 无法稳定触发时，真实交互标 `not covered`。

### Packaging 或 release path

读取 `Makefile` 和 `package.json` 后执行现有 release/type/lint/build 检查。记录产物 path、version、mtime、hash。不要发布或上传制品，除非用户明确授权。

## 3. 命令选择

- 使用仓库已有命令，不猜测新 script。
- 本项目只使用 `bun` / `bunx` / `make`，不使用 `npm`。
- 优先聚焦测试，再扩大到相邻 suite 或仓库级检查。
- 运行前判断命令是否修改文件、下载依赖、访问网络或影响共享状态。
- 依赖变更不属于 validation；未经确认不要新增、升级或降级包。

## 4. Assertion 示例

### 注册与构建

```text
A1 subject: tool registration
predicate: tools registry exports a reachable schema and current built-claude includes it
required_evidence: source registry references + focused registration test + successful current-worktree build metadata
```

### TUI 行为

```text
A2 subject: dialog preview
predicate: recent terminal output renders without ANSI/control-character layout corruption and updates from current state
required_evidence: normalization/state tests + same-run submitted/running/terminal pane evidence
```

### Agent lifecycle

```text
A3 subject: foreground-to-background continuation
predicate: conversion preserves the existing Agent stream and emits one terminal notification
required_evidence: focused behavior test + binary-side Agent ID + same-run debug markers + terminal pane
```

不要把实现文件存在、测试名包含关键词或 pane 中单个 glyph 当成完整 assertion 证据。

## 5. 覆盖停止条件

当以下条件都满足时停止扩大验证：

1. 每条用户可见 contract 都有 assertion；
2. 每条 assertion 必要证据已满足或明确标记 `not covered`；
3. 直接相邻高风险 regression 已验证；
4. 进入 binary 的改动已由本轮 build 证明；
5. 真实交互行为已由 L5 证明；
6. validation 前后没有非预期 Git 可见副作用。

不要为了“更全面”无界运行全量测试、Agent fan-out 或重复 parity。

## 6. 常见错误判定

| 错误做法 | 正确判定 |
|---|---|
| 单测通过，所以 CLI feature passed | 只将测试覆盖的 assertions 标为 passed |
| `make build` 成功，所以注册入口可用 | build passed；入口仍需 L4/L5 |
| parent Agent 返回成功 | 对 binary-side assertion 是 invalid evidence |
| pane 显示 done | runtime `done`；证据齐全后 verdict 才是 `passed` |
| timeout 但进程仍活跃 | `running`，不是 `failed` |
| debug log 无目标 marker | 内部流程 `not covered` |
| official 正常、本地失败 | 本地 `failed`；official 仅作对照 |
| Git status 无变化 | 只证明无 Git 可见副作用 |
