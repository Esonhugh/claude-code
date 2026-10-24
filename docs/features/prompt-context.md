# Prompt context 与 Tool search

> 英文名：`prompt-context` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 作用与效果

System prompt 按稳定核心、能力和任务动态层组织 cache boundary；Agent listing 使用增量 attachment；大型 deferred MCP 工具列表按 namespace 汇总。非 Anthropic 的 `ANTHROPIC_BASE_URL` 且未设 `ENABLE_TOOL_SEARCH` 时，tool search 仍开启但不发 beta header 与 `defer_loading`，`tool_reference` 以 `Tool available: <name>` 文本发送。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `ENABLE_TOOL_SEARCH` | 环境变量 | 设置任意值 | 走原 beta 路径 |

## 效果

该项只改变请求结构，没有终端画面；token 对比见 [`docs/research/prompt-context-optimization.md`](../research/prompt-context-optimization.md)。
