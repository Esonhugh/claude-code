---
name: claude-source-binary-analysis
description: This skill should be used when the user asks to statically analyze authorized Claude Code source or official-claude/built-claude binaries, extract Bun .bun or __BUN,__bun sections and cli.original.js, improve extracted JavaScript readability with webcrack/restringer, inspect symbols or sections with objdump/nm/otool, perform read-only local Frida observation, compare source and binary behavior, or reproduce the offline CCH checksum for an authorized fixture. Use claude-runtime-debug for CLI/runtime diagnosis, claude-network-debug for proxy/OAuth/network/MITM wire inspection, and claude-agent-workflow-validation for strict binary-side Agent/Workflow/TUI validation.
version: 0.2.0
---

# Claude Code 源码与二进制分析

## 目的

用于在明确授权边界内分析官方 `claude-code` 源码仓库，以及 `official-claude` / `built-claude` 二进制。分析时应保持证据来源清晰、假设最少、边界明确。

此 skill 适用于仓库所有者有权测试、调试、提取和检查程序行为的合法分析场景。工作范围应聚焦于理解运行时逻辑、构建产物、兼容性和 checksum 行为。

## 必要流程

1. 确认目标位于 `{PROJECT_ROOT}` 内，或属于官方 Claude Code 源码产物，或是仓库所有者明确授权分析的二进制。
2. 使用二进制或反混淆工具前，先说明分析目标：提取、符号检查、运行时观察、checksum 复现或源码/二进制一致性分析。
3. 优先使用源码证据。只有源码不足以回答问题时，再使用二进制工具补充证据。
4. 提取产物仅保留在本地。不要把私有代码、日志、二进制、请求体或提取出的 JavaScript 上传到第三方服务。
5. 记录结论时标注证据类型：
   - `Source-confirmed`
   - `Binary-observed`
   - `Runtime-observed`
   - `Inference / needs verification`
6. 除非用户明确要求本地授权实验，否则不要修改二进制行为。不得提供绕过、持久化、凭证窃取、数据外传或隐蔽规避指导。

## Reference map

按任务只读取需要的 reference：

- [`references/source-analysis.md`](references/source-analysis.md) — 源码入口、调用链、配置/状态来源、测试证据和动态验证升级条件。
- [`references/js-extraction.md`](references/js-extraction.md) — `webcrack`、`restringer`、[`scripts/native-extra.mjs`](scripts/native-extra.mjs) 和 Bun standalone JS 提取。
- [`references/binary-debugging.md`](references/binary-debugging.md) — `objdump`、`nm`、`otool`，以及对 `official-claude` 二进制的安全本地 Frida 观察。
- [`references/cch-checksum.md`](references/cch-checksum.md) — [`scripts/claude_cch.py`](scripts/claude_cch.py)、`xxh64`、请求规范化和 5 位 hex `cch` 计算。

运行时 CLI、非交互 `--print`、`--debug-file` 和单进程 PTY 诊断由 `claude-runtime-debug` 负责；HTTP proxy、OAuth、SSE、WebSocket 和 MITM/request body 调试由 `claude-network-debug` 负责；严格 binary-side Agent/Workflow/TUI tmux 验收由 `claude-agent-workflow-validation` 负责。本 skill 只保留源码、二进制、反混淆、只读运行观察和离线 checksum 算法分析边界。

## 常见任务路由

| 用户意图 | 使用 |
|---|---|
| “源码在哪里实现”, “调用链”, “setting/state 从哪里来” | `references/source-analysis.md` |
| “extract official-claude js”, “Bun section”, “cli.original.js” | `references/js-extraction.md` |
| “webcrack/restringer this extracted cli” | `references/js-extraction.md` |
| “inspect symbols”, “otool/objdump/nm”, “Mach-O/ELF/PE section” | `references/binary-debugging.md` |
| “hook official-claude locally with Frida” | `references/binary-debugging.md` |
| “what is cch”, “compute cch”, “reproduce cch for an authorized request fixture” | `references/cch-checksum.md` |
| “interactive debug”, “use InteractiveTerminal”, “--print”, “--debug-file” | 使用 `claude-runtime-debug` skill |
| “HTTP_PROXY”, “OAuth 网络问题”, “SSE/WebSocket”, “MITM request body” | 使用 `claude-network-debug` skill |
| “binary-side Agent/Workflow”, “/deep-research 或 /code-review 验收”, “scripted tmux”, “task lifecycle parity” | 使用 `claude-agent-workflow-validation` skill |

## 操作前安全检查

- 验证目标路径和所有权/授权上下文。
- 默认不读取或打印 secrets；只有任务确实需要、用户明确授权且能限制到最小必要范围时才处理，并在报告中脱敏。
- 优先使用本地确定性工具。
- 不要对外发布提取代码或二进制派生材料。

## 分析报告格式

使用以下紧凑结构：

```markdown
## Scope
- Target:
- Authorization boundary:
- Question:

## Evidence
- Source-confirmed:
- Binary-observed:
- Runtime-observed:
- Inference / needs verification:

## Findings
1. ...

## Commands / artifacts
- Local commands used:
- Local outputs created:

## Risks / limits
- ...
```
