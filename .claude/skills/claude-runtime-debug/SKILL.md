---
name: claude-runtime-debug
description: This skill should be used when the user asks to diagnose Claude Code CLI/runtime behavior, including “运行时调试”, “命令输出不一致”, “退出码”, “debug log”, or “InteractiveTerminal 快速复现”. It covers --print, stdout/stderr, exit codes, --debug/--debug-file, non-network settings parity, output formats, hooks, and focused single-process PTY/TUI smoke checks. Use claude-network-debug for proxy/OAuth/network/MITM, claude-source-binary-analysis for static extraction, and claude-agent-workflow-validation for strict Agent/Workflow lifecycle or pane evidence.
version: 0.2.0
---

# Claude Code 运行时诊断

规划并执行可复现的 Claude Code CLI/runtime 诊断。优先采用真实 CLI 执行和本地产物作为证据，不根据源码存在或命令未立即报错推断功能已通过。

## 证据层边界

- Assistant-side 工具用于构建、启动 PTY、输入按键、捕获输出和检查文件。
- Slash command、bundled skill、hook、statusline 和子进程工具只存在于运行中的 binary-side；必须输入 binary stdin 并观察该进程输出。
- Assistant-side `Agent`、`Workflow`、`Skill`、Task/Run ID 不能证明 binary-side 同名能力。
- 报告中区分 `assistant-side action` 与 `binary-side observation`。

## 任务路由

| 任务 | 使用 |
|---|---|
| `--print`、stdout/stderr、exit code、JSON/stream-json、debug flags/log | 本 skill |
| prompt、permission、statusline、按键、resize、取消恢复、简单 slash command smoke diagnosis | 本 skill 的 InteractiveTerminal reference |
| proxy、OAuth、`HTTP_PROXY`/`HTTPS_PROXY`、SSE/WebSocket、CONNECT、MITM/CCH wire summary | `claude-network-debug` |
| Agent/Workflow fan-out、`/deep-research`、`/code-review`、task lifecycle、notification、scheduling、foreground/background、official/local stable pane parity | `claude-agent-workflow-validation` |
| 源码/二进制静态分析、Bun extraction、反混淆、离线 CCH | `claude-source-binary-analysis` |

简单 slash command 在本 skill 中仅用于快速定位输入、解析或渲染问题，不构成正式回归验收。需要稳定 pane/debug 证据、完整生命周期或 official parity 时立即升级到 `claude-agent-workflow-validation`。

## 核心流程

1. 明确目标 binary：`official-claude`、`built-claude` 或聚焦脚本。
2. 比较 binary 时保持 `HOME`、`CLAUDE_CONFIG_DIR`、非网络 settings、auth state、model env、prompt 和 terminal dimensions 等价，只改变目标 binary。若差异涉及 proxy、OAuth transport、base URL 或 wire request，转交 `claude-network-debug`。
3. 从真实用户入口触发，记录 command/input、cwd、非敏感 env、stdout/stderr、exit code、snapshot/debug artifact 和完成判据。
4. 同时覆盖正向路径与最小失败/取消路径；局部检查不能报告为整体通过。
5. 默认不读取或打印 token、cookie、API key、private prompt 或 request body。只有用户明确授权且任务必要时处理最小范围，并始终脱敏。

## References

按任务只读取需要的文件：

- [`references/interactive-debugging.md`](references/interactive-debugging.md) — 单进程 InteractiveTerminal 快速 PTY/TUI 诊断及升级条件。
- [`references/non-interactive-debugging.md`](references/non-interactive-debugging.md) — print mode、JSON、stdout/stderr 和 exit code。
- [`references/debug-options.md`](references/debug-options.md) — `--debug`、`--debug-file` 和 artifact hygiene。
- [`references/feature-testing.md`](references/feature-testing.md) — runtime 功能的正反路径、参数矩阵和完成判据；严格 tmux 验收不在此复制。

## 报告格式

```markdown
## 范围
- Target:
- Mode: interactive-smoke | non-interactive
- Binaries/config compared:

## 证据
- Commands / input sequence:
- Exit code / binary-side state:
- Artifacts:
- Redactions:

## 发现
1. ...

## 覆盖与限制
- Covered:
- Not covered:
- Escalated / should escalate to:
```
