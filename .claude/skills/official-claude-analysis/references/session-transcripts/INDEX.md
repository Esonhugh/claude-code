# Session transcript copies

这些文件是从 `.claude/projects` 复制到 skill reference 目录内的 Claude CCH 相关历史 session。复制时已做基础脱敏：Bearer、token、api_key、cookie 等常见敏感字段会替换为 `REDACTED`，本地用户名和绝对 home 路径已替换为占位符；与本 skill 范围无关的非 Claude-provider 研究内容已移除。

| File | Source | Copied |
| --- | --- | --- |
| `claude-cch-main-74647e53.jsonl` | `CLAUDE_PROJECTS_ROOT/PROJECT_SESSION/74647e53-5d09-4171-b350-fc882e9503a2.jsonl` | yes |
| `claude-cch-compact-agent-c26d2a53.jsonl` | `CLAUDE_PROJECTS_ROOT/PROJECT_SESSION/74647e53-5d09-4171-b350-fc882e9503a2/subagents/agent-acompact-c26d2a5310f1dbb3.jsonl` | yes |

## 用途

- `claude-cch-main-74647e53.jsonl`：Claude CCH / `package/claude` 主分析 session。
- `claude-cch-compact-agent-c26d2a53.jsonl`：CCH 主分析 compact/subagent 摘要。

## 注意

这些 transcript 用于 Claude CCH 证据回溯和方法复用，不包含无关 provider 或无关 native hooks 分析内容。
